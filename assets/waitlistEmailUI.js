// waitlistEmailUI.js — "Email the family?" after something she did (W2 Plan §8,
// step 6). Pro only, like every waitlist module.
//
// Each action that a family should hear about calls offerEmails with who and
// what; this drafts the emails from her templates (data/waitlistOutbox.js) and
// shows them, ticked, for her to edit or untick. Sending queues them on each
// family's entry and starts a sync, which publishes and then sends. Nothing is
// shown where the family can't be emailed (list not online, no address), so the
// actions behave exactly as before there.
import { esc } from './ui.js';
import { formModal } from './waitlistUI.js';
import { draftsFor, queueEmail } from '../data/waitlistOutbox.js';
import { emailProblem } from '../data/waitlistEmails.js';

// Publish, then send what's queued. Loaded only here, where the list is online.
export function syncSoon() {
  import('../data/cloud/cloudWaitlist.js').then((m) => m.syncWaitlistOnline()).catch(() => {});
}

// specs: [{ entryId, kind, extra? }] (see waitlistOutbox.draftFor). → how many queued.
export async function offerEmails(specs, { title = null, intro = '' } = {}) {
  let drafts;
  try {
    drafts = await draftsFor(specs);
  } catch {
    return 0;
  }
  if (!drafts.length) return 0;
  return reviewEmails(drafts, { title, intro });
}

// The review dialog for ready drafts ({ entryId, name, email, kind, subject, body }).
export async function reviewEmails(drafts, { title = null, intro = '', confirmLabel = null } = {}) {
  if (!drafts.length) return 0;
  const one = drafts.length === 1;
  const block = (d, i) => `
    <div class="card" style="margin:8px 0;padding:10px;" data-em="${i}">
      <label class="check-inline" style="display:block;"><input type="checkbox" data-em-on checked>
        <strong>${esc(d.name)}</strong> <span class="faint">${esc(d.email)}</span></label>
      <div class="field" style="margin-top:6px;"><label>Subject</label><input type="text" data-em-subject maxlength="200" value="${esc(d.subject)}"></div>
      <div class="field"><label>Message</label><textarea data-em-body style="width:100%;min-height:${one ? 190 : 130}px;font-family:inherit;">${esc(d.body)}</textarea></div>
    </div>`;
  let queued = 0;
  const ok = await formModal({
    title: title || (one ? `Email ${drafts[0].name}?` : `Email ${drafts.length} families?`),
    confirmLabel: confirmLabel || (one ? 'Send' : 'Send ticked'),
    cancelLabel: 'Don\'t send',
    bodyHtml: `${intro ? `<p class="field-hint" style="margin-top:0;">${esc(intro)}</p>` : ''}
      ${drafts.map(block).join('')}
      <p class="field-hint">Sent from your kennel's name. It ends with a link to their status page, and says replies to the email aren't read: families answer there. Edit the standing wording in Waitlist settings.</p>`,
    onConfirm: async (o) => {
      const picked = [...o.querySelectorAll('[data-em]')].filter((el) => el.querySelector('[data-em-on]').checked).map((el) => ({
        draft: drafts[Number(el.dataset.em)],
        subject: el.querySelector('[data-em-subject]').value,
        body: el.querySelector('[data-em-body]').value
      }));
      for (const p of picked) {
        const problem = emailProblem(p);
        if (problem) throw new Error(`${p.draft.name}: ${problem}`);
      }
      for (const p of picked) {
        await queueEmail(p.draft.entryId, { kind: p.draft.kind, subject: p.subject, body: p.body });
        queued++;
      }
    }
  });
  if (ok && queued) syncSoon();
  return ok ? queued : 0;
}
