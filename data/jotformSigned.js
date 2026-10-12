// jotformSigned.js — a contract sent through a Jotform form comes back signed
// (Integrations plan §6 step 7, revised 2026-10-11: her device checks first).
// When she opens KennelOS (at most every CHECK_EVERY_MS), or taps "Check for
// signature" on a contract, her device reads the recent submissions of each form
// a Sent contract went out on, with the Jotform key of that form's account kept
// on this device (Connect Jotform, jotformKeyStore.js), and finds the one whose
// contract-reference field holds the contract's id. That submission is applied
// like any vendor event (integrationApply.js): a Sent contract becomes Signed on
// the submission's date; one she already changed gets a review on Today instead.
// No KennelOS server is involved, and nothing from the submission is kept but
// its date and id: the buyer's answers stay in Jotform.
//
// A contract is found only when its form has a field for the reference (the
// `contractRef` fixed name on a pasted form, or the field it was matched to
// through Connect Jotform) and the form's account is connected on this device.
import { contractRepo } from './contractRepo.js';
import { accountRepo } from './accountRepo.js';
import { allForms } from './contractForms.js';
import { getJotformKey } from './jotformKeyStore.js';
import { jotformSubmissions } from './jotformApi.js';
import { applyIntegrationEvent } from './integrationApply.js';
import { getIntegrationsState, updateIntegrationsState } from './settings.js';
import { editionFlags } from './editionConfig.js';

export const CHECK_EVERY_MS = 15 * 60 * 1000;

const text = (v) => String(v ?? '').trim();
// A link without its query: what a prefilled link and the saved form share.
const bare = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`.replace(/\/+$/, '').toLowerCase(); } catch { return ''; } };

// A Jotform form's id: the one Connect Jotform kept, else the number its link
// ends in (form.jotform.com/241234567890, jotform.com/form/241234567890).
export function jotformFormId(form) {
  if (/^\d{1,30}$/.test(text(form?.form_id))) return text(form.form_id);
  try {
    const m = new URL(form.url).pathname.match(/(\d{8,30})\/?$/);
    return m ? m[1] : '';
  } catch { return ''; }
}

// The parameter her form takes the reference in, without a part ("name[x]" → "name").
export const refParam = (form) => text(form?.field_map ? form.field_map.contractRef : 'contractRef').replace(/\[.*$/, '');

// The form a contract went out on: the saved form whose link its sent link
// starts from. → the form (with account_id) or null.
export function formForContract(contract, forms) {
  const sent = bare(contract?.esign_url);
  return sent ? (forms || []).find((f) => bare(f.url) === sent) || null : null;
}

// The contract reference a submission carries in the field named `param`. Jotform
// keys answers by question id, each { name, answer }.
export function submissionRef(submission, param) {
  if (!param) return '';
  const answers = submission?.answers;
  for (const a of Array.isArray(answers) ? answers : Object.values(answers || {})) {
    if (a && text(a.name) === param) return text(typeof a.answer === 'string' ? a.answer : a.prettyFormat);
  }
  return '';
}

// The contracts still waiting on a Jotform signature, grouped by the form they
// went out on. → [{ form, contracts, since }] (since = the earliest sent date).
export function pendingByForm(contracts, forms) {
  const groups = new Map();
  for (const c of contracts || []) {
    if (!c || c.is_archived || c.status !== 'sent' || c.esign_provider !== 'jotform') continue;
    const form = formForContract(c, forms);
    if (!form || !jotformFormId(form) || !refParam(form)) continue;
    const g = groups.get(form.id) || { form, contracts: [], since: '' };
    g.contracts.push(c);
    const sent = text(c.esign_sent_date);
    if (sent && (!g.since || sent < g.since)) g.since = sent;
    groups.set(form.id, g);
  }
  return [...groups.values()];
}

// The vendor event for a contract's submission, as integrationEvents reads it.
export function signedEvent(contract, submission) {
  const date = text(submission.created_at).slice(0, 10);
  return {
    id: `jotform-${text(submission.id)}`, provider: 'jotform', kind: 'contract.signed',
    recordType: 'contract', recordId: contract.id,
    payload: { date, submissionId: text(submission.id) }, createdAt: new Date().toISOString()
  };
}

// Look for signed submissions of every Sent Jotform contract (or just
// `contractIds`) whose form's account is connected on this device.
// → { signed, review, skipped, checked, notConnected } or null (not due yet).
export async function checkJotformSignatures({ force = false, contractIds = null } = {}) {
  if (!editionFlags.accounts) return null;
  const last = Date.parse(getIntegrationsState().jotformCheckedAt || '') || 0;
  if (!force && Date.now() - last < CHECK_EVERY_MS) return null;
  if (!contractIds) updateIntegrationsState({ jotformCheckedAt: new Date().toISOString() });
  const counts = { signed: 0, review: 0, skipped: 0, checked: 0, notConnected: 0 };
  const contracts = (await contractRepo.getAll()).filter((c) => !contractIds || contractIds.includes(c.id));
  const forms = allForms(await accountRepo.getAll());
  for (const { form, contracts: waiting, since } of pendingByForm(contracts, forms)) {
    const conn = await getJotformKey(form.account_id);
    if (!conn) { counts.notConnected += waiting.length; continue; }
    counts.checked += waiting.length;
    // A day early, in case Jotform's clock is a time zone behind hers.
    const from = since ? new Date(Date.parse(`${since}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : '';
    const submissions = await jotformSubmissions(conn, jotformFormId(form), from);
    const param = refParam(form);
    for (const c of waiting) {
      // The oldest submission for it: when it was first signed.
      const mine = submissions.filter((s) => submissionRef(s, param) === c.id)
        .sort((a, b) => text(a.created_at).localeCompare(text(b.created_at)));
      if (!mine.length) continue;
      const outcome = await applyIntegrationEvent(signedEvent(c, mine[0]));
      counts[outcome === 'applied' ? 'signed' : outcome]++;
    }
  }
  return counts;
}

// On page load (app.js): a check, when one is due. Never blocks a page.
export function bootJotformCheck() {
  if (!editionFlags.accounts) return;
  setTimeout(() => { checkJotformSignatures().catch(() => {}); }, 2500);
}
