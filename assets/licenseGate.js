// licenseGate.js — the Pro license gate's UI (editions plan §Licensing). Pairs
// with the logic in data/license.js the way app.js's demo banner pairs with
// demoMode.js. Renders three states over the app:
//   • activation wall — first run, no key yet: enter the Lemon Squeezy key.
//   • renewal wall — subscription lapsed past its grace window: renew / re-enter.
//   • grace banner — validated but past the printed expiry (or offline within
//     grace): a dismissible strip; the app stays usable.
//
// The walls are a full-screen, non-dismissible overlay reusing the .modal look.
// This is a GATE, not a vault (see the honest caveat in license.js) — a blocking
// overlay is the right weight: it keeps honest buyers honest without pretending to
// be uncrackable. ensureLicensed() returns false once a wall is painted, so
// app.js's boot() stops before rendering the app.
import { esc } from './ui.js';
import { licenseConfig } from '../data/editionConfig.js';
import { activate, validate, resetLicense, evaluateLicense } from '../data/license.js';
import { getProLicense } from '../data/settings.js';

export { isLicenseGated } from '../data/license.js';

// A buy/renew link, only when a checkout URL is configured (it's a placeholder
// until launch — see pro/editionConfig.js). Returns '' when unset so the walls
// degrade to just the key field rather than a dead link.
function checkoutLinkHtml(label) {
  const url = licenseConfig?.checkoutUrl;
  if (!url) return '';
  return `<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
}

function portalLinkHtml(label) {
  const url = licenseConfig?.portalUrl;
  if (!url) return '';
  return `<a class="license-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
}

// Mount a full-screen, non-dismissible overlay hosting `innerHtml` in a card, and
// return the card element so the caller can wire its controls. Replaces any prior
// wall so re-renders (e.g. "use a different key") don't stack.
function mountWall(innerHtml) {
  document.getElementById('license-wall')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'license-wall';
  overlay.className = 'license-wall-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `<div class="license-wall modal">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  return overlay.querySelector('.license-wall');
}

// --- Activation wall (first run) -------------------------------------------
function renderActivationWall() {
  const card = mountWall(`
    <h2 class="license-title">Activate KennelOS&nbsp;Pro</h2>
    <p class="license-lead">Enter the license key from your purchase confirmation to unlock Pro on this device.</p>
    <form id="license-form" novalidate>
      <label class="license-label" for="license-key-input">License key</label>
      <input id="license-key-input" class="license-input" type="text" autocomplete="off"
             spellcheck="false" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" />
      <div class="license-error" id="license-error" role="alert"></div>
      <div class="license-actions">
        <button type="submit" class="btn btn-primary" id="license-activate">Activate</button>
        ${checkoutLinkHtml('Buy Pro →')}
      </div>
    </form>
    <p class="license-note">Just upgrading from Lite? After activating, use <strong>Import</strong> to bring in the backup you exported.</p>
  `);
  wireActivationForm(card);
}

function wireActivationForm(card) {
  const form = card.querySelector('#license-form');
  const input = card.querySelector('#license-key-input');
  const errorSlot = card.querySelector('#license-error');
  const button = card.querySelector('#license-activate');
  input.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorSlot.textContent = '';
    button.disabled = true;
    button.textContent = 'Activating…';
    try {
      await activate(input.value);
      // Re-evaluate from scratch on a fresh load so the app boots licensed.
      location.reload();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Activate';
      errorSlot.textContent = err?.message || 'Activation failed. Try again.';
    }
  });
}

// --- Renewal wall (lapsed past grace) --------------------------------------
function renderRenewalWall() {
  const card = mountWall(`
    <h2 class="license-title">Your Pro subscription needs attention</h2>
    <p class="license-lead">We couldn't confirm an active subscription for this device. Renew to continue, or activate a different key.</p>
    <div class="license-error" id="license-error" role="alert"></div>
    <div class="license-actions">
      <button type="button" class="btn btn-primary" id="license-recheck">Check again</button>
      ${checkoutLinkHtml('Renew Pro →')}
    </div>
    <div class="license-secondary">
      ${portalLinkHtml('Manage subscription')}
      <button type="button" class="license-link" id="license-reset">Use a different key</button>
    </div>
  `);
  wireRenewalWall(card);
}

function wireRenewalWall(card) {
  const errorSlot = card.querySelector('#license-error');
  const recheck = card.querySelector('#license-recheck');
  recheck.addEventListener('click', async () => {
    errorSlot.textContent = '';
    recheck.disabled = true;
    recheck.textContent = 'Checking…';
    const refreshed = await validate(getProLicense());
    if (refreshed && refreshed.status === 'active') {
      location.reload();
      return;
    }
    recheck.disabled = false;
    recheck.textContent = 'Check again';
    errorSlot.textContent = refreshed
      ? 'That subscription is still not active. Renew to continue.'
      : "Couldn't reach the licensing server. Check your connection and try again.";
  });
  card.querySelector('#license-reset').addEventListener('click', () => {
    resetLicense();
    renderActivationWall();
  });
}

// --- Grace banner (validated, but past expiry / offline within grace) ------
function renderGraceBanner() {
  if (document.getElementById('license-grace-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'license-grace-banner';
  bar.className = 'license-grace-banner';
  bar.setAttribute('role', 'status');
  const renew = licenseConfig?.checkoutUrl
    ? ` <a href="${esc(licenseConfig.checkoutUrl)}" target="_blank" rel="noopener">Renew now →</a>`
    : '';
  bar.innerHTML = `⚠️ <strong>Pro grace period</strong> — we couldn't confirm your subscription. Reconnect to verify, or renew to avoid losing access.${renew}`;
  document.body.insertBefore(bar, document.body.firstChild);
}

// The gate entry point, called from app.js boot() in the Pro edition. Returns
// true when the app may render, false when a blocking wall has been painted (boot
// then stops). In the 'grace' state it returns true but drops a dismissible-looking
// banner so the owner knows to reconnect/renew.
export async function ensureLicensed() {
  const { state } = await evaluateLicense();
  if (state === 'valid') return true;
  if (state === 'grace') { renderGraceBanner(); return true; }
  if (state === 'unactivated') { renderActivationWall(); return false; }
  renderRenewalWall(); // 'wall'
  return false;
}
