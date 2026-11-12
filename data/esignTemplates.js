// esignTemplates.js — her Firma templates as KennelOS keeps them (Integrations plan
// §2.3a, D30). The templates themselves (the PDF and the fields placed on it) live
// in her Firma workspace; KennelOS keeps only what kind of contract each one is,
// as a row in a Form service Account's `contract_forms`:
//   { id, form_type, label, provider: 'firma', template_id, countersign?,
//     countersign_first?, keep_copy?,
//     extra_list_id? (an Extra agreement: the price-list extra it's for) }
// (contractForms.cleanForms). `countersign: true` = she signs it too, after the
// buyer, from the contract's Countersign button (Integrations D32); with
// `countersign_first: true` she signs before the buyer instead. Contract
// templates shows the two as one choice, `signs` ('none' | 'last' | 'first'); a
// new template starts with the one she picked last (the account's
// esign_signs_default). `keep_copy:
// true` = KennelOS keeps the signed PDF and emails the buyer a link (D33). That
// account, "E-sign (Firma)", is made the first time she sets a template's type, so
// her templates show on the Accounts page and
// a contract's Send for signature offers them beside her pasted forms. She has no
// Firma login: Contracts → Contract templates is where she manages them.
// Reads and writes only through accountRepo.
import { accountRepo } from './accountRepo.js';
import { cleanForms, isFirmaForm } from './contractForms.js';
import { CONTRACT_FORM_TYPE, descriptor } from './vocab.js';

export const FIRMA_ACCOUNT = Object.freeze({
  name: 'E-sign (Firma)',
  account_type: 'form_service',
  website: 'firma.dev',
  notes: 'Your contract templates for e-signing, kept in KennelOS\'s Firma account under your kennel\'s name. Manage them on Contracts → Contract templates.'
});

// The account that holds her Firma templates: a live Form service account with a
// Firma row, else the one made for them (website firma.dev). → account | null.
export function firmaAccountOf(accounts) {
  const live = (accounts || []).filter((a) => a && !a.is_archived && a.account_type === 'form_service');
  return live.find((a) => cleanForms(a.contract_forms).some(isFirmaForm))
    || live.find((a) => String(a.website || '').trim().toLowerCase() === FIRMA_ACCOUNT.website) || null;
}

// The kennel whose name signers see (Set up e-signing): the one she's working in,
// else her "My kennel", else any own kennel. Never an outside kennel (a linked
// or co-owner's kennel is on record too). Pure. → kennel | null.
export function signingKennel(kennels, { activeId = null, myId = null } = {}) {
  const own = (kennels || []).filter((k) => k && k.is_own_kennel && !k.is_archived && String(k.kennel_name || '').trim());
  return own.find((k) => k.id === activeId) || own.find((k) => k.id === myId) || own[0] || null;
}

// Whether she signs a template: 'none' (buyer only), 'last' (after the buyer) or
// 'first' (before the buyer). A row's two flags as one choice. Pure.
export const SIGNS = Object.freeze(['none', 'first', 'last']);
export const signsOf = (row) => (row?.countersign === true ? (row.countersign_first === true ? 'first' : 'last') : 'none');

// What a new template starts with: what she picked last on any template (on the
// E-sign (Firma) account), else 'none'. Pure.
export const signsDefault = (account) => (SIGNS.includes(account?.esign_signs_default) ? account.esign_signs_default : 'none');

// Firma's list with the type she gave each one (pure). Templates she hasn't
// typed yet have form_type ''. In Firma's order (by name).
//   templates: [{ id, name, pageCount }] from the Worker
//   accounts:  her accounts (any)
export function mergeTemplates(templates, accounts) {
  const rows = new Map();
  for (const a of accounts || []) {
    if (!a || a.is_archived || a.account_type !== 'form_service') continue;
    for (const f of cleanForms(a.contract_forms)) if (isFirmaForm(f) && !rows.has(f.template_id)) rows.set(f.template_id, f);
  }
  return (templates || []).map((t) => {
    const row = rows.get(t.id);
    return {
      id: t.id, name: t.name || '(untitled)', pageCount: t.pageCount ?? null,
      form_type: row?.form_type || '', label: row?.label || '',
      countersign: row?.countersign === true, signs: signsOf(row), keepCopy: row?.keep_copy === true,
      extraListId: row?.extra_list_id || ''
    };
  });
}

// The account's forms with this template's row set (a known type), or removed
// (type ''). `signs` ('none' | 'last' | 'first'), or the older `countersign`
// yes/no, and `keepCopy` left out keep what the row had. Pure.
// → the new contract_forms list.
export function withTemplateRow(forms, { templateId, name, formType, signs, countersign, keepCopy, extraListId }) {
  const list = cleanForms(forms);
  const i = list.findIndex((f) => isFirmaForm(f) && f.template_id === templateId);
  if (!formType || !CONTRACT_FORM_TYPE.some((t) => t.value === formType)) return i < 0 ? list : list.filter((_, j) => j !== i);
  const label = String(name || '').trim() || descriptor(CONTRACT_FORM_TYPE, formType).label;
  const row = { id: i < 0 ? crypto.randomUUID() : list[i].id, form_type: formType, label, provider: 'firma', template_id: templateId };
  const had = signsOf(list[i]);
  const sign = SIGNS.includes(signs) ? signs
    : countersign === undefined ? had : (countersign === true ? (had === 'none' ? 'last' : had) : 'none');
  if (sign !== 'none') row.countersign = true;
  if (sign === 'first') row.countersign_first = true;
  if (keepCopy === undefined ? list[i]?.keep_copy === true : keepCopy === true) row.keep_copy = true;
  // An Extra agreement: the extra it's for (left out = unchanged).
  const extra = String((extraListId === undefined ? list[i]?.extra_list_id : extraListId) || '').trim();
  if (formType === 'extra' && extra) row.extra_list_id = extra;
  return i < 0 ? [...list, row] : list.map((f, j) => (j === i ? row : f));
}

// Set what kind of contract a template is ('' = not offered), whether she
// signs it (`signs`, or `countersign`), and whether KennelOS keeps and emails the
// signed copy (each left out = unchanged). A `signs` she picks is remembered for
// her next new template (esign_signs_default). Makes the E-sign (Firma) account
// the first time. → the account.
export async function setTemplateType({ templateId, name, formType, signs, countersign, keepCopy, extraListId }) {
  let account = firmaAccountOf(await accountRepo.getAll());
  if (!account) {
    if (!formType) return null;
    account = await accountRepo.create({ ...FIRMA_ACCOUNT, contract_forms: [] });
  }
  const remember = formType && SIGNS.includes(signs) ? { esign_signs_default: signs } : {};
  return accountRepo.update(account.id, { ...remember, contract_forms: withTemplateRow(account.contract_forms, { templateId, name, formType, signs, countersign, keepCopy, extraListId }) });
}

// The forms without her Firma templates that aren't in `liveIds` any more (a
// Set of the ids Firma has: deleted in Firma's editor). Other forms untouched.
// Pure. → the new contract_forms list.
export function withoutMissingTemplates(forms, liveIds) {
  return cleanForms(forms).filter((f) => !isFirmaForm(f) || liveIds.has(f.template_id));
}

// Stop offering the templates Firma no longer has, on every account that holds
// one. `liveIds` must be the COMPLETE set (cloudEsign.liveTemplateIds). → the
// number of templates dropped.
export async function forgetMissingTemplates(liveIds) {
  if (!(liveIds instanceof Set)) return 0;
  let dropped = 0;
  for (const a of await accountRepo.getAll()) {
    if (a.is_archived || a.account_type !== 'form_service') continue;
    const before = cleanForms(a.contract_forms);
    const after = withoutMissingTemplates(before, liveIds);
    if (after.length === before.length) continue;
    dropped += before.length - after.length;
    await accountRepo.update(a.id, { contract_forms: after });
  }
  return dropped;
}

// Stop offering one template (Firma said it's gone at send). → the account | null.
export function forgetTemplate(templateId) {
  return setTemplateType({ templateId, formType: '' });
}

// The name she countersigns with for a kennel (Integrations D32): the kennel's
// own setting (Kennel.esign_signer_name), else her name from the contact linked
// to the kennel (`breeder`, contractSend.breederFor), else the kennel's name. Pure.
export function kennelSignerName(kennel, breeder = null) {
  const t = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  return t(kennel?.esign_signer_name) || t(breeder?.name) || t(kennel?.kennel_name);
}
