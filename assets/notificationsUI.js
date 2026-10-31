// notificationsUI.js — the Settings page's Notifications card
// (docs/KennelOS_Notifications_Plan.md): app alerts on this device, and the email
// digest, each its own opt-in. Pro-only (proPages.js); settings.js imports it only
// with a server and editionFlags.waitlist. All network goes through
// data/cloud/cloudNotify.js.
import {
  NOTIFY_KIND_LABELS, pushSupport, getSettings, saveSettings, enableAlertsHere, disableAlertsHere,
  sendTestAlert, startDigest, verifyDigest, stopDigest
} from '../data/cloud/cloudNotify.js';
import { currentAccount } from '../data/cloud/cloudAuth.js';
import { esc, confirmModal } from './ui.js';

const SUPPORT_TEXT = {
  install: 'On iPhone and iPad, alerts work only from KennelOS added to your Home Screen (iOS 16.4 or later): in Safari, tap Share, then Add to Home Screen, and open KennelOS from there.',
  unsupported: 'This browser can\'t show alerts. On Android use Chrome; on iPhone, KennelOS added to your Home Screen.',
  denied: 'Notifications are blocked for KennelOS in this browser. Allow them in the browser\'s (or phone\'s) settings, then come back.'
};

const errText = (e) => (e && e.code === 'pro_required' ? 'Alerts and the digest come with KennelOS Pro.'
  : e && e.code === 'bad_email' ? 'That isn\'t an email address.'
    : e && (e.code === 'invalid_code' || e.code === 'too_many_attempts') ? 'That code didn\'t work. Ask for a new one.'
      : e && e.code === 'email_unavailable' ? 'Email isn\'t available right now.'
        : (e && e.message) || String(e));

const kindBoxes = (name, chosen) => NOTIFY_KIND_LABELS.map((k) =>
  `<label class="check-inline"><input type="checkbox" data-${name}="${esc(k.value)}"${chosen.includes(k.value) ? ' checked' : ''}> ${esc(k.label)}</label>`).join('');

export function mountNotificationsCard(el) {
  if (!el) return;
  el.hidden = false;
  let state = null;
  let note = '';
  let pendingCode = false;

  const say = (text) => { note = text; render(); };
  const run = async (fn) => {
    try { await fn(); } catch (e) { note = errText(e); }
    render();
  };

  function render() {
    const account = currentAccount();
    if (!account?.signedIn) {
      el.innerHTML = `<h2 style="margin-top:0;">Notifications</h2>
        <p class="muted">Turn on cloud backup and sign in (Import / Export) to get alerts on your phone and an email digest when families act on your waitlist.</p>`;
      return;
    }
    if (!state) {
      el.innerHTML = `<h2 style="margin-top:0;">Notifications</h2><p class="muted">${esc(note || 'Loading…')}</p>`;
      return;
    }
    const { push, digest } = state;
    const support = pushSupport();
    const pushBody = !push.available
      ? '<p class="muted">Alerts aren\'t available yet.</p>'
      : push.thisDevice
        ? `<p>Alerts are <strong>on</strong> for this device.${push.devices > 1 ? ` <span class="faint">(${push.devices} devices in all)</span>` : ''}</p>
           <div class="form-actions"><button class="btn btn-sm" data-act="test">Send a test</button><button class="btn btn-sm" data-act="push-off">Turn off on this device</button></div>`
        : support !== 'ok'
          ? `<p class="field-hint">${esc(SUPPORT_TEXT[support])}</p>`
          : `${push.devices ? `<p class="faint">${push.devices} other device${push.devices === 1 ? ' has' : 's have'} alerts on.</p>` : ''}
             <div class="form-actions"><button class="btn btn-primary btn-sm" data-act="push-on">Turn on alerts on this device</button></div>`;

    const digestBody = !digest.available
      ? '<p class="muted">The email digest isn\'t available right now.</p>'
      : digest.email
        ? `<p>Sent to <strong>${esc(digest.email)}</strong>, ${esc(digest.frequency === 'weekly' ? 'weekly (Mondays)' : 'daily')}, after 8 am, only when something happened.</p>
           <div class="form-actions"><button class="btn btn-sm" data-act="digest-off">Turn off and delete my address</button></div>`
        : `<div class="field"><label for="nt-email">Send it to</label><input id="nt-email" type="email" autocomplete="email" value="${esc(digest.pendingEmail || account.email || '')}"></div>
           <p class="field-hint">To email you, KennelOS keeps this address on its server. It's used only for your digest, never shared, and deleted when you turn the digest off. Another address than your sign-in one gets a code first.</p>
           ${pendingCode || digest.pendingEmail ? `<div class="field"><label for="nt-code">Code sent to ${esc(digest.pendingEmail || '')}</label><input id="nt-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>
             <div class="form-actions"><button class="btn btn-primary btn-sm" data-act="digest-verify">Confirm</button></div>`
             : '<div class="form-actions"><button class="btn btn-primary btn-sm" data-act="digest-on">Turn on the digest</button></div>'}`;

    el.innerHTML = `
      <h2 style="margin-top:0;">Notifications</h2>
      <p class="field-hint">Two ways to hear that a family did something on your waitlist. Today still lists everything; these only say "go look". Neither ever includes what a family wrote.</p>
      <h3 style="margin-bottom:4px;">App alerts</h3>
      ${pushBody}
      ${push.available ? `<div class="field field-wide"><label>Alert me when…</label>${kindBoxes('push-kind', push.kinds)}
        <label class="check-inline" style="margin-top:6px;"><input type="checkbox" id="nt-hide"${push.hideNames ? ' checked' : ''}> Hide family names on my lock screen</label></div>` : ''}
      <h3 style="margin-bottom:4px;">Email digest</h3>
      ${digestBody}
      ${digest.available ? `<div class="field"><label for="nt-freq">How often</label><select id="nt-freq">
          <option value="daily"${digest.frequency !== 'weekly' ? ' selected' : ''}>Daily</option>
          <option value="weekly"${digest.frequency === 'weekly' ? ' selected' : ''}>Weekly (Mondays)</option></select></div>
        <div class="field field-wide"><label>Include…</label>${kindBoxes('digest-kind', digest.kinds)}</div>` : ''}
      <div class="form-actions"><button class="btn btn-sm" data-act="save">Save choices</button><span class="field-hint" role="status">${esc(note)}</span></div>`;
    wire();
  }

  const picked = (name) => [...el.querySelectorAll(`[data-${name}]`)].filter((b) => b.checked).map((b) => b.getAttribute(`data-${name}`));
  const choices = () => ({
    pushKinds: el.querySelector('[data-push-kind]') ? picked('push-kind') : undefined,
    hideNames: el.querySelector('#nt-hide') ? el.querySelector('#nt-hide').checked : undefined,
    digestKinds: el.querySelector('[data-digest-kind]') ? picked('digest-kind') : undefined,
    digestFrequency: el.querySelector('#nt-freq')?.value
  });

  function wire() {
    const on = (act, fn) => el.querySelector(`[data-act="${act}"]`)?.addEventListener('click', () => run(fn));
    on('save', async () => { state = await saveSettings(choices()); note = 'Saved.'; });
    on('push-on', async () => {
      say('Turning on…');
      await saveSettings(choices());
      state = await enableAlertsHere(state.push.publicKey);
      note = 'Alerts are on. Send a test to check.';
    });
    on('push-off', async () => { state = await disableAlertsHere(); note = 'Alerts are off for this device.'; });
    on('test', async () => {
      const r = await sendTestAlert();
      note = r.ok ? 'Sent. It should appear in a few seconds.' : 'The push service didn\'t take it. Turn alerts off and on again.';
    });
    on('digest-on', async () => {
      const email = el.querySelector('#nt-email').value.trim();
      const c = choices();
      const r = await startDigest({ email, frequency: c.digestFrequency, kinds: c.digestKinds });
      state = r;
      pendingCode = Boolean(r.pending);
      note = r.pending ? `We emailed a code to ${email}. Type it below.` : 'The digest is on.';
    });
    on('digest-verify', async () => {
      state = await verifyDigest(el.querySelector('#nt-code').value.trim());
      pendingCode = false;
      note = 'Confirmed. The digest is on.';
    });
    on('digest-off', async () => {
      if (!(await confirmModal({ title: 'Turn off the email digest?', message: 'Your address is deleted from the KennelOS server. App alerts aren\'t affected.', confirmLabel: 'Turn off' }))) return;
      state = await stopDigest();
      note = 'The digest is off and your address was deleted.';
    });
  }

  render();
  if (currentAccount()?.signedIn) getSettings().then((s) => { state = s; render(); }, (e) => say(errText(e)));
}
