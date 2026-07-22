// editionLinks.js — Lite's standing outbound links to the Demo and Pro editions.
//
// The editions plan (§"In-Lite links to Demo and Pro") makes Lite the hub that
// links straight out to the other two editions — no email step, just plain
// cross-origin anchors:
//   • "See the full app ↗"  → the Demo origin (a working, seeded showcase).
//   • "Upgrade to Pro →"     → the export-first bridge (§"Converting Lite → Pro"):
//     trigger the JSON backup export, THEN head to checkout (which redirects into
//     Pro post-purchase to import it). This is the SAME action the cap upgrade
//     nudge runs, so both go through runUpgradeBridge() below (one source of truth
//     for the export-first sequence).
//
// These render in two spots (decided): the nav "More" menu (every page) and a
// footer on Today. Both are driven entirely by demoUrl / upgradeUrl from
// editionConfig, which are null in Pro/Demo — so hasEditionLinks() is false there
// and nothing renders. This keeps the module edition-agnostic like the rest of
// shared/, with the Lite-only URLs living in Lite's editionConfig overlay.
import { esc } from './ui.js';
import { demoUrl, upgradeUrl } from '../data/editionConfig.js';

// True only when this edition exposes at least one outbound link (i.e. Lite).
// Pro/Demo leave both URLs null, so their nav/footer render nothing.
export function hasEditionLinks() {
  return Boolean(demoUrl || upgradeUrl);
}

// Run the Lite→Pro bridge: export the owner's backup to Downloads first, THEN go
// to checkout. downloadBackup is lazy-imported so this module — pulled into the
// nav on every page — doesn't eagerly load the import/export machinery until the
// button is actually clicked. Throws if the export fails (caller surfaces it);
// on success either navigates away (upgradeUrl set → returns 'redirecting' as the
// page unloads) or returns 'exported' so the caller can show a "backup saved,
// continue in Pro" fallback when no checkout URL is configured yet.
export async function runUpgradeBridge() {
  const { downloadBackup } = await import('../data/importExport.js');
  await downloadBackup();
  if (upgradeUrl) {
    window.location.assign(upgradeUrl);
    return 'redirecting';
  }
  return 'exported';
}

// HTML for the two links. `variant` only changes presentation:
//   'nav'    — items styled as entries inside the nav "More" dropdown.
//   'footer' — a labelled block (native .btn styling) for the foot of Today.
// The Upgrade CTA is always a <button> (it must run JS before navigating); the
// Demo link is a plain external anchor (new tab, so Lite isn't lost). A hidden
// note paragraph carries any error / "backup saved" fallback message.
export function editionLinksHtml({ variant = 'nav' } = {}) {
  const note = `<p class="edition-links-note" role="status" hidden></p>`;

  if (variant === 'footer') {
    const demo = demoUrl
      ? `<a class="btn edition-link edition-link-demo" href="${esc(demoUrl)}" target="_blank" rel="noopener">See the full app ↗</a>`
      : '';
    const upgrade = upgradeUrl
      ? `<button type="button" class="btn btn-primary edition-link edition-link-upgrade">Upgrade to Pro →</button>`
      : '';
    return `<div class="edition-links edition-links-footer">
        <p class="edition-links-lead">Want the full app — unlimited dogs and litters, plus every Pro feature?</p>
        <div class="edition-links-row">${demo}${upgrade}</div>
        ${note}
      </div>`;
  }

  // nav: menu items inside the More dropdown (reuse .nav-link for the menu look).
  const demo = demoUrl
    ? `<a class="nav-link edition-link edition-link-demo" href="${esc(demoUrl)}" target="_blank" rel="noopener">See the full app ↗</a>`
    : '';
  const upgrade = upgradeUrl
    ? `<button type="button" class="nav-link edition-link edition-link-upgrade">Upgrade to Pro →</button>`
    : '';
  return `<div class="edition-links edition-links-nav">${demo}${upgrade}${note}</div>`;
}

// Wire the Upgrade button(s) within `scope` to the bridge. Idempotent per element
// (guards against double-wiring when a container is re-rendered). A no-op when
// there's no button (Pro/Demo, or a Demo-only future variant).
export function wireEditionLinks(scope) {
  if (!scope) return;
  scope.querySelectorAll('.edition-link-upgrade').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => onUpgradeClick(btn));
  });
}

async function onUpgradeClick(btn) {
  const note = btn.closest('.edition-links')?.querySelector('.edition-links-note');
  const original = btn.textContent;
  const setNote = (msg) => { if (note) { note.hidden = false; note.textContent = msg; } };
  btn.disabled = true;
  btn.textContent = 'Exporting your backup…';
  if (note) { note.hidden = true; note.textContent = ''; }
  try {
    const result = await runUpgradeBridge();
    // 'redirecting' → the page is navigating to checkout; leave the button as-is.
    if (result === 'exported') {
      btn.textContent = 'Backup exported ✓';
      setNote('Backup saved. Continue to Pro and import this file to finish upgrading.');
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    setNote(`Couldn't export your backup (${e.message || e}). Try again before upgrading.`);
  }
}
