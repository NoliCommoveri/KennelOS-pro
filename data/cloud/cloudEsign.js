// cloudEsign.js — e-sign through Firma on her device (Integrations plan §2.3a,
// step 8, D25–D26, D30–D31). KennelOS holds the Firma account; the Worker makes
// her a workspace, keeps its key, and counts her sends against the monthly limit.
// Her device only ever sees ids, links and counts: never a Firma key.
//
//   esignOffered()          Pro with a cloud server (never `cloudUrl: null`, never the Demo)
//   esignStatus()           connected? and this month's { used, limit, resetsOn }
//   setUpEsign(kennelName)  her workspace (once), then the facts her templates can fill
//   templates()             her Firma templates
//   liveTemplateIds()       their ids, when the list is known complete (else null)
//   uploadTemplate(...)     a new template from her PDF
//   editorLink(templateId)  Firma's editor in its own tab (the Worker's sandboxed page)
//   sendForEsign(...)       send a contract; the contract is marked Sent
//   previewLink(...)        a free draft of that send, read-only in Firma's editor
//   signedCopyLink(ref)     a short-lived link to the signed PDF
//   countersignLink(ref)    her own signing link, on a contract she countersigns (D32)
//
// Every entry point checks isCloudAvailable() and the session first, so
// `cloudUrl: null` makes no request. Network only through cloudApi.
import * as api from './cloudApi.js';
import { isCloudAvailable, cloudBaseUrl } from './cloudConfig.js';
import { sessionToken, currentAccount } from './cloudAuth.js';
import { refreshConnections } from './cloudIntegrations.js';
import { editionFlags } from '../editionConfig.js';
import { isDemo } from '../demoMode.js';
import { contractRepo } from '../contractRepo.js';
import { PREFILL_FIELDS, prefillValues, splitName } from '../contractForms.js';
import { todayYMD } from '../dateUtils.js';
import { kennelSignerName } from '../esignTemplates.js';

// Firma refuses a request body over about 6 MB; a PDF grows by a third as base64.
export const TEMPLATE_MAX_BYTES = 4_500_000;
const FIELDS_PER_CALL = 40;

export const esignOffered = () => isCloudAvailable() && Boolean(editionFlags.accounts) && !isDemo();
export const esignSignedIn = () => esignOffered() && Boolean(sessionToken());

function requireSession() {
  if (!esignOffered()) throw new api.CloudUnavailableError();
  const token = sessionToken();
  if (!token) throw new api.CloudAuthError({ status: 401, code: 'unauthorized' });
  return token;
}

// → { available, connected, connectedAt, usage: { used, limit, own, resetsOn } }
export async function esignStatus() {
  return api.getFirmaStatus(requireSession());
}

// Every fact name a template can fill, once each, with what it holds.
export function factFields() {
  const seen = new Map();
  for (const rows of Object.values(PREFILL_FIELDS)) for (const [name, label] of rows) if (!seen.has(name)) seen.set(name, label);
  return [...seen].map(([name, label]) => ({ name, label: label.slice(0, 100) }));
}

// Make the facts her workspace's custom fields, so Firma's editor offers them.
// Safe to repeat: the Worker adds only the missing ones.
export async function syncFactFields() {
  const token = requireSession();
  const all = factFields();
  let added = 0;
  for (let i = 0; i < all.length; i += FIELDS_PER_CALL) added += (await api.syncFirmaFields(token, all.slice(i, i + FIELDS_PER_CALL))).added || 0;
  return added;
}

// Her workspace, named for her kennel, then its fields. → the status.
export async function setUpEsign(kennelName) {
  const token = requireSession();
  await api.connectFirma(token, String(kennelName || '').trim());
  // The account now has a connection: her devices start reading its events.
  await refreshConnections().catch(() => {});
  await syncFactFields();
  return esignStatus();
}

export async function templates() {
  return (await templateList()).templates;
}

// → { templates, complete }: complete = every template she has (not a first
// page), so one missing from it is gone from Firma.
export async function templateList() {
  const r = await api.listFirmaTemplates(requireSession());
  return { templates: r.templates || [], complete: r.complete === true };
}

// The ids of every template in her Firma workspace, or null when that isn't
// known for sure (offline, not set up, an older Worker, a partial list). A
// template missing from a known set was deleted (in Firma's editor).
export async function liveTemplateIds() {
  try {
    const { templates: list, complete } = await templateList();
    return complete ? new Set(list.map((t) => t.id)) : null;
  } catch { return null; }
}

// Base64 of a file's bytes, in chunks (a large PDF overflows one apply()).
export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// A new template from her PDF. → { id, name, pageCount }
export async function uploadTemplate({ name, file }) {
  const token = requireSession();
  if (!file) throw new Error('Choose your contract\'s PDF.');
  if (!/pdf$/i.test(file.type || '') && !/\.pdf$/i.test(file.name || '')) throw new Error('Upload your contract as a PDF.');
  if (file.size > TEMPLATE_MAX_BYTES) throw new Error('That PDF is over 4.5 MB. Save a smaller copy (fewer pictures, or "reduce file size") and try again.');
  return api.createFirmaTemplate(token, { name: String(name || '').trim() || String(file.name || 'Contract').replace(/\.pdf$/i, ''), document: await fileToBase64(file) });
}

// The address of Firma's editor for one template: the Worker's sandboxed page,
// with the 24-hour token in the fragment (never sent to a server). The facts are
// made fields first, so the editor offers them.
export async function editorLink(templateId) {
  const token = requireSession();
  await syncFactFields();
  const { token: jwt } = await api.firmaTemplateToken(token, templateId);
  return `${cloudBaseUrl()}/esign/editor#${new URLSearchParams({ t: jwt, id: templateId })}`;
}

// Who countersigns a template marked so (D32): her, as her cloud account's
// email, under her kennel's signature name (esignTemplates.kennelSignerName),
// with `first: true` when she signs before the buyer (countersign_first).
// → { name, email, first? } | null (not her template, or no account email on this device).
export function countersignerFor(form, facts, account = currentAccount()) {
  if (form?.countersign !== true) return null;
  const email = String(account?.email || '').trim();
  if (!email) return null;
  return { name: kennelSignerName(facts?.kennel, facts?.breeder) || email, email, ...(form.countersign_first === true ? { first: true } : {}) };
}

// What goes to Firma for one send: the signer, and the contract's facts as the
// signer's custom fields (the same allow-list a pasted form's link carries). On a
// template she countersigns, her too, as a second signer, after the buyer or
// before (D32). On one whose
// signed copy KennelOS keeps (D33), keepCopy and her kennel's name (the email's
// wording).
export function sendBody({ contract, form, facts, signer, emailSigner = true, resend = false, account = currentAccount() }) {
  const [firstName, lastName] = splitName(signer?.name || '');
  const subject = facts?.puppy?.call_name || facts?.dog?.call_name || '';
  const countersigner = countersignerFor(form, facts, account);
  if (form?.countersign === true && !countersigner) {
    throw Object.assign(new Error('countersigner_email_required'), { code: 'countersigner_email_required' });
  }
  return {
    contractId: contract.id,
    templateId: form.template_id,
    title: [form.label, subject].filter(Boolean).join(': ').slice(0, 200) || contract.title || 'Contract',
    signer: { firstName, lastName, email: String(signer?.email || '').trim() },
    facts: Object.fromEntries(prefillValues(form, facts)),
    ...(countersigner ? { countersigner } : {}),
    ...(form?.keep_copy === true ? { keepCopy: true, kennelName: String(facts?.kennel?.kennel_name || '').trim() } : {}),
    emailSigner: emailSigner !== false,
    resend: resend === true
  };
}

// Send it. Firma charges KennelOS for it, so it counts (D26). The contract is
// marked Sent with Firma's reference and the signer's link, and whether she
// countersigns it (esign_countersign, D32) and whether first (esign_countersign_first).
// → { contract, signingLink, countersign, countersignFirst, keepCopy, usage }. Throws the Worker's refusals (esignProblem).
export async function sendForEsign({ contract, form, facts, signer, emailSigner = true, resend = false }) {
  const token = requireSession();
  const res = await api.sendForEsign(token, sendBody({ contract, form, facts, signer, emailSigner, resend }));
  const saved = await contractRepo.update(contract.id, {
    status: contract.status === 'draft' || contract.status === 'declined' ? 'sent' : contract.status,
    esign_provider: 'firma',
    esign_ref: res.signingRequestId,
    esign_url: res.signingLink || null,
    esign_sent_date: todayYMD(),
    esign_form_label: form.label,
    esign_countersign: res.countersign === true,
    esign_countersign_first: res.countersign === true && res.countersignFirst === true
  });
  return { contract: saved, signingLink: res.signingLink || null, countersign: res.countersign === true, countersignFirst: res.countersign === true && res.countersignFirst === true, keepCopy: res.keepCopy === true, usage: res.usage || null };
}

// A preview of this send: her real template with the contract's values, as a
// Firma draft (free, never counted) opened read-only on the Worker's editor page.
// → { url, previewId }. Discard it with discardPreview once she's done.
export async function previewLink({ contract, form, facts, signer }) {
  const token = requireSession();
  const res = await api.esignPreview(token, sendBody({ contract, form, facts, signer, emailSigner: false }));
  return { url: `${cloudBaseUrl()}/esign/editor#${new URLSearchParams({ t: res.token, sr: res.previewId })}`, previewId: res.previewId };
}

// Throw a preview's draft away (best effort: a draft left behind costs nothing).
export async function discardPreview(previewId) {
  if (!previewId) return false;
  try { return (await api.discardEsignPreview(requireSession(), previewId)).discarded === true; } catch { return false; }
}

// → { url, partial, status }
export async function signedCopyLink(ref) {
  return api.esignDocument(requireSession(), ref);
}

// → { url }: her own signing link (after the buyer, or before when she signs
// first). Firma's page waits for whoever signs before her.
export async function countersignLink(ref) {
  return api.esignCountersign(requireSession(), ref);
}

const resetText = (usage) => (usage?.resetsOn ? ` It resets on ${usage.resetsOn}.` : '');

// What to tell her about a refusal. → { kind, message } where kind is
// 'already_sent' | 'limit' | 'unknown' | 'template_missing' | 'signed_out' | 'offline' | 'other'.
export function esignProblem(err) {
  const code = err?.code;
  if (err instanceof api.CloudAuthError) return { kind: 'signed_out', message: 'Your cloud sign-in has expired. Sign in again in Settings → Cloud backup, then try again.' };
  if (code === 'already_sent') return { kind: 'already_sent', message: 'This contract is already out for signature through Firma.' };
  if (code === 'esign_limit_reached') {
    const n = Number.isInteger(err.usage?.limit) ? `${err.usage.limit} ` : '';
    return { kind: 'limit', message: `You've sent this month's ${n}e-sign contracts.${resetText(err.usage)} Until then you can send one of your own contract forms' links.` };
  }
  if (code === 'esign_unknown') return { kind: 'unknown', message: 'Firma didn\'t answer, so this contract may have gone out. Don\'t send it again yet: if the buyer got it, it comes back Signed by itself. Check again in a few minutes.' };
  if (code === 'esign_not_connected') return { kind: 'other', message: 'E-signing isn\'t set up yet: open Contracts → Contract templates.' };
  if (code === 'pro_required') return { kind: 'other', message: 'E-signing comes with KennelOS Pro on your cloud account.' };
  if (code === 'esign_not_configured') return { kind: 'other', message: 'E-signing isn\'t available right now. Try again later.' };
  if (code === 'esign_busy' || code === 'rate_limited') return { kind: 'other', message: 'Firma is busy right now. Wait a minute and try again.' };
  if (code === 'esign_refused') {
    // Firma's reason, when it gave one (e.g. VALIDATION_ERROR), for her and for support.
    const why = /^[A-Z0-9_]{1,60}$/.test(err.providerCode || '') ? ` (Firma said ${err.providerCode})` : '';
    if (err.providerCode === 'RECIPIENT_EMAIL_SUPPRESSED') return { kind: 'other', message: `Firma won't email that address: it bounced or was reported before${why}. Use another email for the signer.` };
    return { kind: 'other', message: `Firma refused this${why}. Check the signer's email, and that the template has a signature field for each signer (for you too, on one you countersign), then try again.` };
  }
  if (code === 'signer_email_required') return { kind: 'other', message: 'The signer needs an email address.' };
  if (code === 'signer_name_required') return { kind: 'other', message: 'The signer needs a name.' };
  if (code === 'countersigner_email_required' || code === 'countersigner_name_required') return { kind: 'other', message: 'You countersign this template, so KennelOS needs your cloud account\'s email. Sign in again in Settings → Cloud backup, then try again.' };
  if (code === 'countersigner_is_signer') return { kind: 'other', message: 'The signer\'s email is your own. You countersign this template, so the buyer needs their own email.' };
  if (code === 'esign_not_open') return { kind: 'other', message: 'This contract isn\'t out for signature any more, so there\'s nothing to countersign.' };
  if (code === 'no_countersigner') return { kind: 'other', message: 'This contract was sent without you as a signer, so there\'s nothing to countersign. To sign it too, mark its template "I countersign" and send it again.' };
  if (code === 'template_missing') return { kind: 'template_missing', message: 'This template isn\'t in Firma any more (it was deleted), so KennelOS has stopped offering it. Nothing was sent or counted. Pick another, or upload it again on Contracts → Contract templates.' };
  if (code === 'too_large') return { kind: 'other', message: 'That PDF is too large for Firma. Save a smaller copy and try again.' };
  if (err instanceof api.CloudOfflineError || code === 'esign_unavailable' || code === 'esign_setup_failed') return { kind: 'offline', message: 'Couldn\'t reach Firma right now. Check your connection and try again.' };
  return { kind: 'other', message: err?.message || String(err) };
}
