// messageComposer.js — a note to one person that she sends herself: an editable
// subject and message, then Email (a real mailto: link), Text (a real sms: link)
// or Copy. Nothing is sent by the app and nothing goes to a server (Integrations
// plan §3, D7: her own email first). Used by the follow-up nudge on Today and
// "Send a thank-you" on a Contact. The Email / Text links are anchors she taps, so
// her tap opens the mail or messages app (iOS needs the tap itself; same pattern
// as the Companion console).
import { esc } from './ui.js';

// → Promise<boolean>: true once she used Email, Text or Copy, false if she just closed it.
export function openComposer({ title = 'Write a note', name = '', email = '', phone = '', subject = '', body = '', hint = '' } = {}) {
  return new Promise((resolve) => {
    let used = false;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:620px;">
      <h2 style="margin-top:0;">${esc(title)}</h2>
      <p class="field-hint" style="margin-top:0;">To ${esc(name || 'them')}${email ? ` · ${esc(email)}` : ''}${phone ? ` · ${esc(phone)}` : ''}${!email && !phone ? ' (no email or phone on their contact: use Copy)' : ''}</p>
      ${hint ? `<p class="field-hint">${esc(hint)}</p>` : ''}
      <div class="field"><label for="mc-subject">Subject</label><input id="mc-subject" type="text" value="${esc(subject)}"></div>
      <div class="field"><label for="mc-body">Message</label><textarea id="mc-body" rows="14" style="width:100%;font-family:inherit;">${esc(body)}</textarea></div>
      <div class="form-actions">
        ${email ? '<a class="btn btn-primary" id="mc-email" href="#">Email</a>' : ''}
        ${phone ? `<a class="btn${email ? '' : ' btn-primary'}" id="mc-text" href="#">Text</a>` : ''}
        <button class="btn" id="mc-copy">Copy</button>
        <button class="btn" id="mc-close">Close</button>
        <span class="field-hint" id="mc-note" role="status"></span>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const $ = (sel) => overlay.querySelector(sel);
    const links = () => {
      const s = encodeURIComponent($('#mc-subject').value);
      const b = encodeURIComponent($('#mc-body').value);
      if ($('#mc-email')) $('#mc-email').href = `mailto:${encodeURIComponent(email)}?subject=${s}&body=${b}`;
      if ($('#mc-text')) $('#mc-text').href = `sms:${encodeURIComponent(phone)}?body=${b}`;
    };
    links();
    $('#mc-subject').addEventListener('input', links);
    $('#mc-body').addEventListener('input', links);
    $('#mc-email')?.addEventListener('click', () => { used = true; });
    $('#mc-text')?.addEventListener('click', () => { used = true; });
    $('#mc-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('#mc-body').value);
        $('#mc-note').textContent = 'Copied. Paste it into your message.';
        used = true;
      } catch {
        $('#mc-body').select();
        $('#mc-note').textContent = 'Select the message and copy it.';
      }
    });
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(used);
    };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    $('#mc-close').addEventListener('click', close);
    $('#mc-body').focus();
  });
}
