// waitlistOnlineUI.js — the "Online list" card on the waitlist's Publish list page
// (Waitlist W2 Plan §9; it lived on the Kennel page until 2026-10-08). Imported
// dynamically by pages/waitlist-publish.js, only where the waitlist online is
// offered (Pro, cloud available, its release switch or staging). Saving goes
// through kennelRepo; publishing through data/cloud/cloudWaitlist.js.
import { esc, confirmModal, alertModal, todayYMD } from './ui.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { waitlistConfig } from '../data/waitlistRules.js';
import { syncWaitlistOnline, waitlistOnlineStatus, rotateFormKey, WAITLIST_ONLINE_EVENT } from '../data/cloud/cloudWaitlist.js';
import { publicListLink, applyFormLink } from '../data/cloud/cloudConfig.js';
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
      ${waitingFor(st) ? `<p class="field-hint" style="margin-top:6px;">${esc(waitingFor(st))}</p>` : ''}`;
    root.querySelector('[data-wlo="save"]').addEventListener('click', save);
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
    // The day the list (last) went online: "Ready now?" covers holds ending from then (§16.7).
    const config = { ...before, online, online_form: onlineForm, ...(online && before.online !== true ? { online_since: todayYMD() } : {}) };
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
