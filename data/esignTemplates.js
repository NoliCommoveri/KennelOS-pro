// esignTemplates.js — her Firma templates as KennelOS keeps them (Integrations plan
// §2.3a, D30). The templates themselves (the PDF and the fields placed on it) live
// in her Firma workspace; KennelOS keeps only what kind of contract each one is,
// as a row in a Form service Account's `contract_forms`:
//   { id, form_type, label, provider: 'firma', template_id }
// (contractForms.cleanForms). That account, "E-sign (Firma)", is made the first
// time she sets a template's type, so her templates show on the Accounts page and
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
    return { id: t.id, name: t.name || '(untitled)', pageCount: t.pageCount ?? null, form_type: row?.form_type || '', label: row?.label || '' };
  });
}

// The account's forms with this template's row set (a known type), or removed
// (type ''). Pure. → the new contract_forms list.
export function withTemplateRow(forms, { templateId, name, formType }) {
  const list = cleanForms(forms);
  const i = list.findIndex((f) => isFirmaForm(f) && f.template_id === templateId);
  if (!formType || !CONTRACT_FORM_TYPE.some((t) => t.value === formType)) return i < 0 ? list : list.filter((_, j) => j !== i);
  const label = String(name || '').trim() || descriptor(CONTRACT_FORM_TYPE, formType).label;
  const row = { id: i < 0 ? crypto.randomUUID() : list[i].id, form_type: formType, label, provider: 'firma', template_id: templateId };
  return i < 0 ? [...list, row] : list.map((f, j) => (j === i ? row : f));
}

// Set what kind of contract a template is ('' = not offered). Makes the
// E-sign (Firma) account the first time. → the account.
export async function setTemplateType({ templateId, name, formType }) {
  let account = firmaAccountOf(await accountRepo.getAll());
  if (!account) {
    if (!formType) return null;
    account = await accountRepo.create({ ...FIRMA_ACCOUNT, contract_forms: [] });
  }
  return accountRepo.update(account.id, { contract_forms: withTemplateRow(account.contract_forms, { templateId, name, formType }) });
}
