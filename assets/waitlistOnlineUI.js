// waitlistOnlineUI.js — the "Online list" card on the waitlist's Publish list page
// (Waitlist W2 Plan §9; it lived on the Kennel page until 2026-10-08). Imported
// dynamically by pages/waitlist-publish.js, only where the waitlist online is
// offered (Pro, cloud available, its release switch or staging). Saving goes
// through kennelRepo; publishing through data/cloud/cloudWaitlist.js.
import { esc, confirmModal, alertModal, todayYMD } from './ui.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { waitlistConfig, embedOrigin, embedOrigins, EMBED_ORIGINS_MAX } from '../data/waitlistRules.js';
import { syncWaitlistOnline, waitlistOnlineStatus, rotateFormKey, WAITLIST_ONLINE_EVENT } from '../data/cloud/cloudWaitlist.js';
import { publicListLink, applyFormLink, embedSnippet, applyButtonSnippet } from '../data/cloud/cloudConfig.js';
import { copyLink } from './waitlistUI.js';

// Every IANA zone the browser knows, with the device's own and any saved one.
export function timeZoneOptions(saved) {
  const device = deviceTimeZone();
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browser */ }
  return [...new Set([saved, device, ...zones].filter(Boolean))].sort();
}

export function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

function ago(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const PROBLEM = {
  'signed-out': 'Sign in to cloud backup on this device (Import / Export) to publish it.',
  'backup-off': 'Turn on cloud backup on this device (Import / Export) to publish it.',
  'not-backing': 'Your other device that backs up publishes the list. Open the app there, or make this the backup device in Import / Export.',
  'pro-required': 'Your cloud account isn\'t linked to a Pro purchase yet. Use "Link a Pro purchase email…" in the cloud backup card (Import / Export).',
  'kennel-taken': 'Another account has already published this kennel. Contact support.',
  offline: 'Couldn\'t reach the server. It will try again.',
  failed: 'Publishing didn\'t work. It will try again.'
};

function statusLine(st) {
  if (!st.online) return 'Not online.';
  if (st.lastError && PROBLEM[st.lastError.code]) return `<span class="badge badge-amber">Not published</span> ${esc(PROBLEM[st.lastError.code])}`;
  if (st.published) return `<span class="badge badge-green">Online</span> Last published ${esc(ago(st.published.publishedAt))}.`;
  return 'Publishing…';
}

// Every button is always shown (decided 2026-10-08: she couldn't find them when
// they only appeared once usable); one that can't work yet is greyed out, and
// waitingFor says what it's waiting on.
function button(key, label, enabled, title) {
  return `<button class="btn btn-sm" data-wlo="${key}"${enabled ? '' : ' disabled'}${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
}

function waitingFor(st) {
  if (!st.online) return 'To publish, tick "Put … waitlist online" above and Save. The copy-link buttons work once the list has been published.';
  if (!st.published) return 'The copy-link buttons work once the list has been published (see the line above for anything stopping it).';
  if (!st.formOpen) return 'To copy an application form link, tick "Take applications online" and Save.';
  return '';
}

// "On your website" (Integrations plan §1): the switch that lets her own site show
// the form and list in a frame, the sites allowed, and what to paste. The snippets
// show once the list is published; the button works without the switch (it's a link).
function websiteHtml(kennel, st) {
  const config = waitlistConfig(kennel);
  const origins = embedOrigins(config).join('\n');
  const snippet = (key, title, code, hint) => `<div class="field field-wide">
      <label for="wlo-snip-${key}">${esc(title)}</label>
      <textarea id="wlo-snip-${key}" readonly rows="${code.includes('\n') ? 4 : 3}" style="width:100%;font-family:monospace;font-size:12px;">${esc(code)}</textarea>
      <div class="form-actions" style="margin-top:4px;"><button class="btn btn-sm" data-wlo-copy="${key}">Copy</button><span class="field-hint">${esc(hint)}</span></div>
    </div>`;
  const ready = st.online && st.published;
  const snippets = [];
  if (ready && config.embed && st.formOpen) snippets.push(snippet('form', 'Your application form', embedSnippet(kennel.public_id, 'apply'), 'Paste where the form should appear.'));
  if (ready && config.embed) snippets.push(snippet('list', 'Your public list', embedSnippet(kennel.public_id, 'list'), 'Paste where the list should appear.'));
  if (ready && st.formOpen) snippets.push(snippet('button', 'Or just a button', applyButtonSnippet(kennel.public_id), 'Opens your form in a new tab. Works anywhere you can paste HTML, with or without the switch above.'));
  return `
      <h3 style="font-size:15px; margin:18px 0 4px;">On your website</h3>
      <div class="form-grid">
        <div class="field field-wide">
          <label class="check-inline"><input id="wlo-embed" type="checkbox"${config.embed ? ' checked' : ''}> Let my own website show my application form and list</label>
          <span class="field-hint">They appear on your page in a frame. Everything families type stays on our page, locked to your key, never seen by your website.</span>
        </div>
        <div class="field field-wide">
          <label for="wlo-embed-origins">Your website's address <span class="field-hint">(optional, one per line)</span></label>
          <textarea id="wlo-embed-origins" rows="2" placeholder="e.g. thornfieldkennels.com" style="width:100%;">${esc(origins)}</textarea>
          <span class="field-hint">Only these sites may show them (up to ${EMBED_ORIGINS_MAX}). Leave it blank to allow any site. <strong>On Wix, leave it blank</strong>: Wix shows pasted code from its own address, not yours.</span>
          <div class="form-actions" style="margin-top:6px;"><button class="btn btn-primary btn-sm" data-wlo="save-site">Save</button></div>
        </div>
        ${snippets.join('')}
      </div>
      ${snippets.length ? `<details class="field-hint" style="margin-top:4px;"><summary>Where to paste it</summary>
        <p><strong>WordPress:</strong> add a <em>Custom HTML</em> block. <strong>Wix:</strong> Add → Embed code → Embed HTML, then paste and stretch the box to the page width. <strong>Squarespace:</strong> add a <em>Code</em> block (some plans don't allow scripts; if the form doesn't appear, use the button). <strong>GoDaddy / Weebly:</strong> an HTML or Embed section. <strong>Facebook, Linktree, email:</strong> scripts aren't allowed, so use the button or the plain link.</p>
        <p>After you change the switch or the addresses here, allow about five minutes for your website to show the change.</p>
      </details>` : (config.embed && !ready ? '<p class="field-hint">The code to paste appears here once the list is published.</p>' : '')}`;
}

export function mountWaitlistOnline(root, kennel, { onSaved } = {}) {
  const render = () => {
    const st = waitlistOnlineStatus(kennel);
    const zone = kennel.time_zone || deviceTimeZone() || '';
    const zones = timeZoneOptions(kennel.time_zone).map((z) => `<option value="${esc(z)}"${z === zone ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('');
    root.innerHTML = `
      <div class="row-between"><h2 style="margin:0;">Online list</h2><span class="badge badge-purple" title="Only on the test server until it's released">Preview</span></div>
      <p class="field-hint">Publishes ${esc(kennel.kennel_name)}'s waitlist to the server: the public list (position, first name and last initial, sex preference, date added) and each family's own status page (their name and email, their place and offers, the fee while it's unpaid, and whether it was received), plus any pairings and litters you chose to show before picks open (Waitlist settings). Their other answers, phone, address, programs, notes and payment details stay on your devices. Updated by itself after each change.</p>
      <div class="form-grid">
        <div class="field field-wide">
          <label class="check-inline"><input id="wlo-online" type="checkbox"${waitlistConfig(kennel).online ? ' checked' : ''}> Put ${esc(kennel.kennel_name)}'s waitlist online</label>
        </div>
        <div class="field field-wide">
          <label class="check-inline"><input id="wlo-form" type="checkbox"${waitlistConfig(kennel).online_form ? ' checked' : ''}> Take applications online</label>
          <span class="field-hint">Families fill in your <a href="waitlist-form.html?kennel=${encodeURIComponent(kennel.id)}">application form</a> on a web page. Their answers are locked in their browser with a key only your devices hold; the server reads only their name and email. An application reaches you once they've typed the code we email them. It arrives here as a new application for you to review.${st.inboxUnopened ? ` <strong>${esc(st.inboxUnopened)} application${st.inboxUnopened === 1 ? '' : 's'} couldn't be opened on this device: it doesn't have that form key. Turn on private backup on the device that made it, or open the app there.</strong>` : ''}</span>
        </div>
        <div class="field"><label for="wlo-tz">Time zone</label><select id="wlo-tz">${zones}</select>
          <span class="field-hint">Offer deadlines end at 11:59 pm here.</span></div>
      </div>
      <p class="field-hint" id="wlo-status">${statusLine(st)}</p>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" data-wlo="save">Save</button>
        ${button('now', 'Publish now', st.online, '')}
        ${button('list', 'Copy public list link', st.online && st.published, 'The public list, for Facebook or your website')}
        ${button('form', 'Copy application form link', st.formOpen && st.published, 'Your application form, for Facebook or your website')}
        ${st.formOpen && st.published ? '<button class="btn btn-sm" data-wlo="rotate" title="Make a new form key (if a device holding it was lost)">Rotate form key…</button>' : ''}
      </div>
      ${waitingFor(st) ? `<p class="field-hint" style="margin-top:6px;">${esc(waitingFor(st))}</p>` : ''}
      ${websiteHtml(kennel, st)}`;
    for (const btn of root.querySelectorAll('[data-wlo-copy]')) {
      btn.addEventListener('click', (ev) => copyLink(root.querySelector(`#wlo-snip-${btn.dataset.wloCopy}`).value, ev.currentTarget, { title: 'Copy this code' }));
    }
    root.querySelector('[data-wlo="save"]').addEventListener('click', save);
    root.querySelector('[data-wlo="save-site"]').addEventListener('click', save);
    root.querySelector('[data-wlo="now"]')?.addEventListener('click', publishNow);
    root.querySelector('[data-wlo="list"]')?.addEventListener('click', (ev) => copyLink(publicListLink(kennel.public_id), ev.currentTarget, { title: 'Your public list' }));
    root.querySelector('[data-wlo="form"]')?.addEventListener('click', (ev) => copyLink(applyFormLink(kennel.public_id), ev.currentTarget, { title: 'Your application form' }));
    root.querySelector('[data-wlo="rotate"]')?.addEventListener('click', rotate);
  };

  const publishNow = async () => {
    root.querySelector('#wlo-status').textContent = 'Publishing…';
    await syncWaitlistOnline({ force: true }).catch(() => {});
    render();
  };

  const rotate = async () => {
    if (!(await confirmModal({
      title: 'Rotate the form key?',
      message: 'New applications will be locked with a new key. Applications you already have, and any waiting to arrive, still open with the old one, which is kept. Do this if a device that held your waitlist was lost or sold. Anyone filling in the form right now will be asked to reload it.',
      confirmLabel: 'Rotate key'
    }))) return;
    kennel = await rotateFormKey(kennel.id);
    await alertModal({ title: 'Form key rotated', message: 'New applications now use the new key.' });
    render();
  };

  const save = async () => {
    const online = root.querySelector('#wlo-online').checked;
    const onlineForm = online && root.querySelector('#wlo-form').checked;
    const timeZone = root.querySelector('#wlo-tz').value || null;
    const before = kennel.waitlist_config || {};
    // Her website (Integrations plan §1): each line cleaned to a site address.
    const typed = root.querySelector('#wlo-embed-origins').value.split(/[\n,]+/).map((t) => t.trim()).filter(Boolean);
    const embedOriginsList = typed.map(embedOrigin).filter(Boolean);
    const unreadable = typed.filter((t) => !embedOrigin(t));
    if (unreadable.length) {
      await alertModal({ title: 'Check your website address', message: `This doesn't look like a website address: ${unreadable.join(', ')}. Type it like thornfieldkennels.com.` });
      return;
    }
    if (embedOriginsList.length > EMBED_ORIGINS_MAX) {
      await alertModal({ title: 'Too many addresses', message: `List up to ${EMBED_ORIGINS_MAX} website addresses, or leave the box blank to allow any site.` });
      return;
    }
    const embedSettings = { embed: root.querySelector('#wlo-embed').checked, embed_origins: [...new Set(embedOriginsList)] };
    // The day the list (last) went online: "Ready now?" covers holds ending from then (§16.7).
    const config = { ...before, online, online_form: onlineForm, ...embedSettings, ...(online && before.online !== true ? { online_since: todayYMD() } : {}) };
    kennel = await kennelRepo.update(kennel.id, { waitlist_config: config, time_zone: timeZone });
    if (online && !kennel.public_id) {
      await kennelRepo.ensurePublicId(kennel.id);
      kennel = await kennelRepo.getById(kennel.id);
    }
    await syncWaitlistOnline().catch(() => {});
    if (onSaved) await onSaved(); else render();
  };

  globalThis.addEventListener?.(WAITLIST_ONLINE_EVENT, () => { if (root.isConnected) render(); });
  render();
}
