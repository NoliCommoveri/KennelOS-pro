// waitlistOutbox.js — emails to families, on her device (W2 Plan §8, step 6).
//
// An email she sends (from a preview she can edit, or skip) is QUEUED on the
// family's entry, in `messages` beside their status-page activity:
//   { id, at, from: 'breeder', kind: 'email', email_kind, subject, body,
//     status: 'queued' | 'sent' | 'failed', sent_at, error, read: true }
// cloudWaitlist.sendQueuedEmails sends them after the next publish (so the
// status page already shows what the email talks about), and records the
// result. Offline, they wait. A failed one gets Retry on the family's page.
//
// Emails are offered only where the family can have a status page: the kennel's
// list is online (and offered in this edition) and the family has an email.
// Writes go through the entry repo, so they ride backup like any edit.
import { kennelRepo } from './kennelRepo.js';
import { contactRepo } from './contactRepo.js';
import { waitlistEntryRepo } from './waitlistEntryRepo.js';
import { waitlistProgramRepo } from './waitlistProgramRepo.js';
import { litterRepo } from './litterRepo.js';
import { dogRepo } from './dogRepo.js';
import { waitlistConfig, entryName, overallPositions } from './waitlistRules.js';
import { entryEmail } from './waitlistProjection.js';
import { draftEmail, requestPhrase, emailProblem, EMAIL_KINDS, EMAIL_SUBJECT_MAX, EMAIL_BODY_MAX } from './waitlistEmails.js';
import { MESSAGES_KEPT } from './waitlistActions.js';
import { isWaitlistOnlineOffered } from './cloud/cloudConfig.js';
import { editionFlags } from './editionConfig.js';

const nowISO = () => new Date().toISOString();

// Can her list email this kennel's families at all?
export function kennelEmailsOn(kennel) {
  return Boolean(isWaitlistOnlineOffered() && editionFlags.waitlist && kennel && kennel.is_own_kennel && !kennel.is_archived
    && kennel.public_id && waitlistConfig(kennel).online);
}

// The family's address (the one their status page is published with), or ''.
export function familyEmail(entry, contact) {
  return String(entryEmail(entry, contact) || '').trim();
}

const litterLabel = (l, dogsById) => l.nickname || `${dogsById.get(l.dam_id)?.call_name || 'Dam'} × ${dogsById.get(l.sire_id)?.call_name || 'Sire'}`;

// A draft for one family, from her records: { entryId, name, email, kind, subject,
// body }, or null when this family can't be emailed. `extra`:
//   litterIds    the litter(s) it's about (an offer, a closed turn, a new litter)
//   respondBy    YYYY-MM-DD (an offer; a closed turn)
//   request      { field, request } (a decision on their request)
export async function draftFor(entryId, kind, extra = {}) {
  if (!EMAIL_KINDS.includes(kind)) throw new Error(`Unknown email "${kind}".`);
  const entry = await waitlistEntryRepo.getById(entryId);
  if (!entry) return null;
  const kennel = await kennelRepo.getById(entry.kennel_id);
  if (!kennelEmailsOn(kennel)) return null;
  const contact = entry.contact_id ? await contactRepo.getById(entry.contact_id) : null;
  const email = familyEmail(entry, contact);
  if (!email) return null;
  const config = waitlistConfig(kennel);
  const facts = { kennelName: kennel.kennel_name || '', family: entryName(entry, contact), payBy: entry.fee_due_date || null };
  if (extra.litterIds?.length) {
    const dogsById = new Map((await dogRepo.getAll({ includeArchived: true })).map((d) => [d.id, d]));
    const litters = await Promise.all(extra.litterIds.map((id) => litterRepo.getById(id)));
    facts.litters = litters.filter(Boolean).map((l) => litterLabel(l, dogsById));
  }
  if (extra.respondBy) facts.respondBy = extra.respondBy;
  if (extra.request) facts.request = requestPhrase(extra.request.field, extra.request.request);
  if (entry.status === 'active') {
    const [entries, programs] = await Promise.all([waitlistEntryRepo.getByKennel(kennel.id), waitlistProgramRepo.getMapForKennel(kennel.id)]);
    facts.position = overallPositions(entries, kennel.id, programs).get(entry.id) || null;
  }
  return { entryId, name: facts.family, email, ...draftEmail(kind, facts, config) };
}

// Drafts for several families at once (nulls dropped), e.g. a turn that moved on.
export async function draftsFor(specs) {
  const out = [];
  for (const s of specs || []) {
    const d = await draftFor(s.entryId, s.kind, s.extra || {});
    if (d) out.push(d);
  }
  return out;
}

// The emails a turn change calls for: an offer to every family a turn went to
// ({ next, offered } as waitlistActions returns them).
export function offerSpecs(res) {
  return [res?.next, ...(res?.offered || [])].filter(Boolean).map((t) => ({
    entryId: t.entry_id, kind: 'offer', extra: { litterIds: t.litter_ids || [t.litter_id], respondBy: t.respond_by_date }
  }));
}

// Is this family mid-turn (an open offer anywhere)? They aren't sent "a litter you
// match was born" on top (like "almost your turn", Spec §15.5).
export const midTurn = (offers, entryId) => offers.some((o) => o.entry_id === entryId && o.outcome === 'open' && !o.is_archived);

// Queue an email she approved. → the message as stored.
export async function queueEmail(entryId, { kind, subject, body }) {
  const problem = emailProblem({ subject, body });
  if (problem) throw new Error(problem);
  if (!EMAIL_KINDS.includes(kind)) throw new Error(`Unknown email "${kind}".`);
  const entry = await waitlistEntryRepo.getById(entryId);
  if (!entry) throw new Error('That waitlist entry no longer exists.');
  const message = {
    id: `em-${crypto.randomUUID()}`, at: nowISO(), from: 'breeder', kind: 'email', email_kind: kind,
    subject: subject.replace(/\s+/g, ' ').trim(), body: body.trim(), status: 'queued', sent_at: null, error: null, read: true
  };
  await waitlistEntryRepo.update(entryId, { messages: [...(entry.messages || []), message].slice(-MESSAGES_KEPT) });
  return message;
}

// A message she sent the family herself (share sheet, her own email, or copied),
// logged beside the emails KennelOS sent so the family page shows it. Already
// sent, so sendQueuedEmails never picks it up: `via: 'own'`.
export async function logOwnMessage(entryId, { kind, subject = '', body = '' }) {
  const entry = await waitlistEntryRepo.getById(entryId);
  if (!entry) throw new Error('That waitlist entry no longer exists.');
  const at = nowISO();
  const message = {
    id: `em-${crypto.randomUUID()}`, at, from: 'breeder', kind: 'email', email_kind: kind, via: 'own',
    subject: String(subject).replace(/\s+/g, ' ').trim().slice(0, EMAIL_SUBJECT_MAX), body: String(body).trim().slice(0, EMAIL_BODY_MAX),
    status: 'sent', sent_at: at, error: null, read: true
  };
  await waitlistEntryRepo.update(entryId, { messages: [...(entry.messages || []), message].slice(-MESSAGES_KEPT) });
  return message;
}

// Record what happened to one queued email.
export async function setEmailStatus(entryId, messageId, patch) {
  const entry = await waitlistEntryRepo.getById(entryId);
  if (!entry || !(entry.messages || []).some((m) => m.id === messageId)) return null;
  return waitlistEntryRepo.update(entryId, {
    messages: entry.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m))
  });
}

// Retry: back in the queue (same id, so it can never arrive twice).
export const retryEmail = (entryId, messageId) => setEmailStatus(entryId, messageId, { status: 'queued', error: null });

// Every queued email of these entries, oldest first: [{ entry, message }].
export function queuedEmails(entries) {
  const out = [];
  for (const entry of entries) {
    for (const m of entry.messages || []) if (m.from === 'breeder' && m.kind === 'email' && m.status === 'queued') out.push({ entry, message: m });
  }
  return out.sort((a, b) => String(a.message.at).localeCompare(String(b.message.at)));
}

// Plain words for why an email couldn't go, from the server's answer.
export function emailErrorText(code) {
  return {
    not_published: 'This family isn\'t on your online list yet. It goes once the list is published again.',
    no_email: 'There\'s no email address for this family.',
    bad_message: 'The email couldn\'t be sent as written.',
    email_unavailable: 'Email isn\'t working on the server right now.',
    failed: 'The email service didn\'t take it.'
  }[code] || 'It couldn\'t be sent.';
}
