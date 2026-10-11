// accounts.js — the Accounts page (Pro-only): one card per business account
// (AKC, Good Dog, Chewy…) with her own login details and the referral
// link/code she shares, each with a Copy button. The password stays masked
// until "Show". Each card also totals the expenses paid through the account
// (expenses.account_id) and links to them in Financials, and shows the fee it
// keeps when it's a sales channel (fee_percent + fee_fixed, Integrations plan §5;
// the Sale form suggests a sale's processing fee from it). Add/Edit is a modal;
// archive/delete like any entity — delete is blocked while an expense names the
// account (ACCOUNT_REFERENCES), so archive it then. Her contract forms (Jotform,
// Integrations plan §2.1a) live on a Form service account (that type only): a type, her label and the
// form's link per row, which the Contract page's "Send for signature" offers.
// Reads/writes only through accountRepo / expenseRepo.
import { accountRepo } from '../data/accountRepo.js';
import { expenseRepo } from '../data/expenseRepo.js';
import { ACCOUNT_TYPE, CONTRACT_FORM_TYPE } from '../data/vocab.js';
import { cleanForms, formLink, PREFILL_FIELDS } from '../data/contractForms.js';
import { feeRate, rateLabel } from '../data/processingFees.js';
import { sharedReferrals } from '../data/referralShare.js';
import { esc, badge, fmtMoney, confirmModal, alertModal } from '../assets/ui.js';

const els = {
  msg: document.getElementById('page-msg'),
  list: document.getElementById('list'),
  search: document.getElementById('search'),
  typeFilter: document.getElementById('type-filter'),
  showArchived: document.getElementById('show-archived'),
  add: document.getElementById('btn-add')
};

let accounts = [];
let spendByAccount = new Map(); // account id -> { total, count } over active expenses
const revealed = new Set(); // account ids whose password is showing

function showError(msg) { els.msg.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }
function clearError() { els.msg.innerHTML = ''; }

// A website typed without a scheme ("chewy.com") still opens as a link.
function hrefFor(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
}
const isWebLink = (href) => /^https?:/i.test(href);

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = was; }, 1500);
  } catch {
    showError('Couldn\'t copy — select the text and copy it by hand.');
  }
}

// --- List --------------------------------------------------------------

function matches(a, q) {
  if (!q) return true;
  return [a.name, a.website, a.username, a.customer_id, a.referral_code, a.referral_link, a.notes]
    .some((v) => String(v || '').toLowerCase().includes(q));
}

function copyRow(label, value, { field, secret = false, id } = {}) {
  if (!value) return '';
  const masked = secret && !revealed.has(id);
  return `<div class="acct-row">
    <span class="acct-k">${esc(label)}</span>
    <span class="acct-v${secret ? ' acct-secret' : ''}${masked ? ' acct-masked' : ''}">${esc(masked ? '••••••' : value)}</span>
    ${secret ? `<button class="btn btn-sm" data-act="reveal" data-id="${esc(id)}">${revealed.has(id) ? 'Hide' : 'Show'}</button>` : ''}
    <button class="btn btn-sm" data-act="copy" data-id="${esc(id)}" data-field="${esc(field)}">Copy</button>
  </div>`;
}

function cardHtml(a) {
  const site = hrefFor(a.website);
  const login = [
    copyRow('Username', a.username, { field: 'username', id: a.id }),
    copyRow('Password', a.password, { field: 'password', secret: true, id: a.id }),
    copyRow('Customer ID', a.customer_id, { field: 'customer_id', id: a.id })
  ].join('');
  const referral = [
    copyRow('Link', a.referral_link, { field: 'referral_link', id: a.id }),
    copyRow('Code', a.referral_code, { field: 'referral_code', id: a.id })
  ].join('');
  return `<article class="card acct-card${a.is_archived ? ' row-archived' : ''}">
    <div class="acct-head">
      <div>
        <h2>${esc(a.name)}${a.is_archived ? ' <span class="badge badge-gray">Archived</span>' : ''}</h2>
        ${site ? (isWebLink(site)
          ? `<a class="acct-site" href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(a.website)}</a>`
          : `<span class="acct-site muted">${esc(a.website)}</span>`) : ''}
      </div>
      ${a.account_type ? badge(ACCOUNT_TYPE, a.account_type) : ''}
    </div>
    ${login ? `<div class="acct-section"><div class="acct-section-title">Your login</div>${login}</div>` : ''}
    ${referral || a.referral_instructions ? `<div class="acct-section"><div class="acct-section-title">Referral — to share${sharedReferrals([a]).length ? ' <span class="badge badge-green">Shown to families</span>' : ''}</div>${referral}
      ${a.referral_instructions ? `<div class="acct-instructions">${esc(a.referral_instructions)}</div>` : ''}</div>` : ''}
    ${a.notes ? `<div class="acct-section"><div class="acct-instructions">${esc(a.notes)}</div></div>` : ''}
    ${formsHtml(a)}
    ${feeHtml(a)}
    ${spendHtml(a)}
    <div class="pill-row acct-actions">
      <button class="btn btn-sm" data-act="edit" data-id="${esc(a.id)}">Edit</button>
      <button class="btn btn-sm" data-act="${a.is_archived ? 'unarchive' : 'archive'}" data-id="${esc(a.id)}">${a.is_archived ? 'Unarchive' : 'Archive'}</button>
      <button class="btn btn-danger btn-sm" data-act="delete" data-id="${esc(a.id)}">Delete</button>
    </div>
  </article>`;
}

// Her contract forms on this account: type, label, and a link to open the form.
function formsHtml(a) {
  if (a.account_type !== 'form_service') return '';
  const forms = cleanForms(a.contract_forms);
  if (!forms.length) return '';
  return `<div class="acct-section"><div class="acct-section-title">Contract forms</div>
    ${forms.map((f) => `<div class="acct-row">
      <span class="acct-k acct-k-wide">${badge(CONTRACT_FORM_TYPE, f.form_type)}</span>
      <span class="acct-v">${esc(f.label)}</span>
      <a class="btn btn-sm" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">Open</a>
    </div>`).join('')}
  </div>`;
}

// The field names a contract form can use, per group, each with Copy (§2.1a).
function fieldNamesHtml() {
  const group = (title, rows) => `<div style="margin-top:8px;"><strong>${esc(title)}</strong>
    ${rows.map(([k, what]) => `<div class="acct-row"><code class="acct-k acct-k-code">${esc(k)}</code><span class="acct-v muted">${esc(what)}</span><button type="button" class="btn btn-sm" data-copy-name="${esc(k)}">Copy</button></div>`).join('')}</div>`;
  return `<details class="field-wide" style="margin-top:6px;"><summary>Field names KennelOS fills in</summary>
    <p class="field-hint">In Jotform, open each field's settings and set its <strong>Unique Name</strong> (under Advanced) to one of these. KennelOS fills those fields when you send the form; fields with other names are left for the signer. Make prefilled fields read-only in Jotform so they can't be changed, and make the reference fields hidden.</p>
    ${group('Every contract', PREFILL_FIELDS.every)}
    ${group('Sale contracts (pet home, breeding rights, deposit, co-own sale)', PREFILL_FIELDS.sale)}
    ${group('Stud service contracts', PREFILL_FIELDS.stud_service)}
    ${group('Co-own, lease, foster and other contracts', PREFILL_FIELDS.dog)}
  </details>`;
}

function formRowHtml(f = {}) {
  const typeOptions = CONTRACT_FORM_TYPE
    .map((t) => `<option value="${esc(t.value)}"${t.value === f.form_type ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  return `<div class="cf-row" data-id="${esc(f.id || '')}">
    <select class="cf-type" aria-label="Contract form type"><option value="">Type…</option>${typeOptions}</select>
    <input class="cf-label" type="text" aria-label="Label" value="${esc(f.label || '')}" placeholder="Label, e.g. Pet home – in state">
    <input class="cf-url" type="url" aria-label="Form link" value="${esc(f.url || '')}" placeholder="https://form.jotform.com/…">
    <button type="button" class="btn btn-sm" data-cf-remove aria-label="Remove this form">✕</button>
  </div>`;
}

// A sales channel's fee (Good Dog, Stripe…): the rate, whether she usually passes
// it on, and her note on it.
function feeHtml(a) {
  const rate = feeRate(a);
  if (!rate && !a.fee_note) return '';
  return `<div class="acct-section"><div class="acct-section-title">Processing fee</div>
    ${rate ? `<div class="acct-row"><span class="acct-v"><strong>${esc(rateLabel(rate))}</strong> <span class="muted">per sale${a.fee_passed_to_buyer_default ? ' · usually passed to the buyer' : ''}</span></span></div>` : ''}
    ${a.fee_note ? `<div class="acct-instructions">${esc(a.fee_note)}</div>` : ''}
  </div>`;
}

function spendHtml(a) {
  const s = spendByAccount.get(a.id);
  if (!s) return '';
  return `<div class="acct-section acct-row">
    <span class="acct-v"><strong>${esc(fmtMoney(s.total))}</strong> <span class="muted">spent · ${s.count} expense${s.count === 1 ? '' : 's'}</span></span>
    <a class="btn btn-sm" href="financials.html?view=expenses&account=${encodeURIComponent(a.id)}">View expenses →</a>
  </div>`;
}

function render() {
  const q = els.search.value.trim().toLowerCase();
  const type = els.typeFilter.value;
  const visible = accounts.filter((a) => (els.showArchived.checked || !a.is_archived)
    && (!type || a.account_type === type) && matches(a, q));
  if (!accounts.length) {
    els.list.innerHTML = `<div class="card empty-state">No accounts yet. Add the registries, vendors and services you use — AKC, Good Dog, Chewy — to keep your logins and referral codes in one place.</div>`;
    return;
  }
  els.list.innerHTML = visible.length
    ? `<div class="acct-grid">${visible.map(cardHtml).join('')}</div>`
    : `<div class="card empty-state">No accounts match.</div>`;
}

async function load() {
  const [rows, expenses] = await Promise.all([
    accountRepo.getAll({ includeArchived: true }),
    expenseRepo.getAll()
  ]);
  accounts = rows;
  spendByAccount = new Map();
  for (const x of expenses) {
    if (!x.account_id) continue;
    const s = spendByAccount.get(x.account_id) || { total: 0, count: 0 };
    s.total += Number(x.amount) || 0;
    s.count += 1;
    spendByAccount.set(x.account_id, s);
  }
  render();
}

els.list.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const a = accounts.find((x) => x.id === btn.dataset.id);
  if (!a) return;
  clearError();
  try {
    switch (btn.dataset.act) {
      case 'copy': await copy(a[btn.dataset.field] || '', btn); return;
      case 'reveal':
        if (revealed.has(a.id)) revealed.delete(a.id); else revealed.add(a.id);
        render();
        return;
      case 'edit': openForm(a); return;
      case 'archive': await accountRepo.archive(a.id); break;
      case 'unarchive': await accountRepo.unarchive(a.id); break;
      case 'delete': {
        const blockers = await accountRepo.getDeleteBlockers(a.id);
        if (blockers.length) {
          await alertModal({
            title: `${a.name} can't be deleted`,
            message: `It's still in use (${blockers.map((b) => `${b.label} × ${b.count}`).join(', ')}). Archive it instead — it keeps the expense history and drops out of the expense form's list.`
          });
          return;
        }
        const ok = await confirmModal({
          title: `Delete ${a.name}?`,
          message: 'This removes the account and everything saved on it. Archive it instead to keep it out of the way.',
          confirmLabel: 'Delete', danger: true
        });
        if (!ok) return;
        await accountRepo.hardDelete(a.id);
        break;
      }
      default: return;
    }
    await load();
  } catch (err) {
    showError(err.message || String(err));
  }
});

// --- Add / edit modal ---------------------------------------------------

function field(label, inner, { wide = false, hint = '', required = false } = {}) {
  return `<div class="field${wide ? ' field-wide' : ''}"><label>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>${inner}${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}</div>`;
}

const numberOrNull = (v) => (String(v).trim() === '' ? null : Number(v));

function openForm(existing = null) {
  const a = existing || {};
  const typeOptions = `<option value="">— none —</option>` + ACCOUNT_TYPE
    .map((t) => `<option value="${esc(t.value)}"${t.value === a.account_type ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <h2 style="margin-top:0;">${existing ? 'Edit account' : 'New account'}</h2>
    <div class="form-grid">
      ${field('Name', `<input id="af-name" type="text" value="${esc(a.name)}" placeholder="e.g. Chewy">`, { required: true })}
      ${field('Type', `<select id="af-type">${typeOptions}</select>`)}
      ${field('Website', `<input id="af-website" type="text" value="${esc(a.website)}" placeholder="e.g. chewy.com">`, { wide: true })}
    </div>
    <div id="af-forms-section"${a.account_type === 'form_service' ? '' : ' hidden'}>
    <h3 style="font-size:15px; margin:14px 0 4px;">Contract forms</h3>
    <p class="field-hint" style="margin-top:0;">Your own signable forms on this service: pick what kind of contract each one is, give it a label, and paste its link. A contract's <strong>Send for signature</strong> offers the matching ones, with the details filled in.</p>
    <div id="af-forms">${cleanForms(a.contract_forms).map(formRowHtml).join('')}</div>
    <button type="button" class="btn btn-sm" id="af-form-add">+ Add ${cleanForms(a.contract_forms).length ? 'another ' : 'a '}contract form</button>
    ${fieldNamesHtml()}
    </div>
    <h3 style="font-size:15px; margin:14px 0 4px;">Your login</h3>
    <p class="field-hint" style="margin-top:0;">Just for you. These never go to cloud backup unencrypted — only inside your private vault, if you've turned it on.</p>
    <div class="form-grid">
      ${field('Username / login email', `<input id="af-username" type="text" autocomplete="off" value="${esc(a.username)}">`)}
      ${field('Password', `<div style="display:flex; gap:6px;"><input id="af-password" type="password" autocomplete="new-password" value="${esc(a.password)}" style="flex:1;"><button type="button" class="btn btn-sm" id="af-pw-toggle">Show</button></div>`)}
      ${field('Customer / member ID', `<input id="af-customer" type="text" value="${esc(a.customer_id)}">`)}
    </div>
    <h3 style="font-size:15px; margin:14px 0 4px;">Referral — to share</h3>
    <div class="form-grid">
      ${field('Referral link', `<input id="af-ref-link" type="text" value="${esc(a.referral_link)}" placeholder="https://…">`, { wide: true })}
      ${field('Referral code', `<input id="af-ref-code" type="text" value="${esc(a.referral_code)}">`)}
      ${field('Instructions for whoever uses it', `<textarea id="af-ref-instructions" placeholder="e.g. Use code at checkout for 30% off your first Autoship order.">${esc(a.referral_instructions)}</textarea>`, { wide: true, hint: 'Written for the families you\'ll share this with.' })}
      <div class="field field-wide"><label class="check-inline"><input id="af-ref-share" type="checkbox"${a.share_with_families ? ' checked' : ''}> Share with families</label>
        <span class="field-hint">Shows the link, code and instructions as "Recommended for your puppy" on a family's Companion page and their waitlist status page, and in the follow-up note a week after a pup goes home.</span></div>
    </div>
    <h3 style="font-size:15px; margin:14px 0 4px;">Processing fee — if you sell or take payments through it</h3>
    <p class="field-hint" style="margin-top:0;">What it keeps of each sale: a percentage, a fixed amount, or both (e.g. 6.25% + $5). A sale sold through this account suggests its fee from this.</p>
    <div class="form-grid">
      ${field('Fee percentage', `<input id="af-fee-percent" type="number" min="0" max="99.99" step="0.01" value="${esc(a.fee_percent)}" placeholder="e.g. 6.25">`, { hint: 'Percent of the sale price.' })}
      ${field('Fixed fee ($)', `<input id="af-fee-fixed" type="number" min="0" step="0.01" value="${esc(a.fee_fixed)}" placeholder="e.g. 5.00">`, { hint: 'Added on top, per sale.' })}
      <div class="field field-wide"><label class="check-inline"><input id="af-fee-passed" type="checkbox"${a.fee_passed_to_buyer_default ? ' checked' : ''}> I usually pass this fee on to the buyer in a higher price</label></div>
      ${field('About the fee', `<input id="af-fee-note" type="text" value="${esc(a.fee_note)}" placeholder="e.g. card payments only; bank transfer is free">`, { wide: true, hint: 'Private — just for you.' })}
    </div>
    <div class="form-grid" style="margin-top:14px;">
      ${field('Notes', `<textarea id="af-notes">${esc(a.notes)}</textarea>`, { wide: true, hint: 'Private — just for you.' })}
    </div>
    <div id="af-error"></div>
    <div class="form-actions">
      <button class="btn btn-primary" id="af-save">Save</button>
      <button class="btn" id="af-cancel">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const $ = (sel) => overlay.querySelector(sel);
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  $('#af-cancel').addEventListener('click', close);
  $('#af-pw-toggle').addEventListener('click', (e) => {
    const pw = $('#af-password');
    pw.type = pw.type === 'password' ? 'text' : 'password';
    e.currentTarget.textContent = pw.type === 'password' ? 'Show' : 'Hide';
  });
  const formsBox = $('#af-forms');
  // Contract forms belong to a Form service account only (Jotform…).
  const isFormService = () => $('#af-type').value === 'form_service';
  $('#af-type').addEventListener('change', () => { $('#af-forms-section').hidden = !isFormService(); });
  $('#af-form-add').addEventListener('click', (e) => {
    formsBox.insertAdjacentHTML('beforeend', formRowHtml());
    e.currentTarget.textContent = '+ Add another contract form';
    formsBox.lastElementChild.querySelector('.cf-type').focus();
  });
  overlay.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-cf-remove]');
    if (rm) { rm.closest('.cf-row').remove(); return; }
    const cp = e.target.closest('[data-copy-name]');
    if (cp) await copy(cp.dataset.copyName, cp);
  });
  // The rows as typed; a row left wholly blank is dropped, a half-filled one is an error.
  function readForms() {
    const out = []; const problems = [];
    formsBox.querySelectorAll('.cf-row').forEach((row, i) => {
      const f = {
        id: row.dataset.id || crypto.randomUUID(),
        form_type: row.querySelector('.cf-type').value,
        label: row.querySelector('.cf-label').value.trim(),
        url: row.querySelector('.cf-url').value.trim()
      };
      if (!f.form_type && !f.label && !f.url) return;
      if (!f.form_type) problems.push(`Contract form ${i + 1}: pick its type.`);
      if (!formLink(f.url)) problems.push(`Contract form ${i + 1}: paste the form's link (starting https://).`);
      out.push(f);
    });
    return { forms: problems.length ? null : cleanForms(out), problems };
  }
  $('#af-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const val = (sel) => $(sel).value.trim();
    const data = {
      name: val('#af-name'),
      account_type: $('#af-type').value || null,
      website: val('#af-website'),
      username: val('#af-username'),
      password: $('#af-password').value, // kept exactly as typed — spaces can be part of a password
      customer_id: val('#af-customer'),
      referral_link: val('#af-ref-link'),
      referral_code: val('#af-ref-code'),
      referral_instructions: $('#af-ref-instructions').value.trim(),
      share_with_families: $('#af-ref-share').checked,
      notes: $('#af-notes').value.trim(),
      fee_percent: numberOrNull($('#af-fee-percent').value),
      fee_fixed: numberOrNull($('#af-fee-fixed').value),
      fee_passed_to_buyer_default: $('#af-fee-passed').checked,
      fee_note: val('#af-fee-note')
    };
    if (!data.name) {
      $('#af-error').innerHTML = `<div class="inline-error">Name is required.</div>`;
      return;
    }
    // Another type leaves any saved forms as they are (hidden, never offered), so
    // switching the type back brings them back.
    if (isFormService()) {
      const { forms, problems } = readForms();
      if (problems.length) {
        $('#af-error').innerHTML = `<div class="inline-error">${problems.map(esc).join('<br>')}</div>`;
        return;
      }
      data.contract_forms = forms;
    }
    btn.disabled = true;
    try {
      if (existing) await accountRepo.update(existing.id, data);
      else await accountRepo.create(data);
      close();
      await load();
    } catch (err) {
      $('#af-error').innerHTML = `<div class="inline-error">${esc(err.message || String(err))}</div>`;
      btn.disabled = false;
    }
  });
  $('#af-name').focus();
}

els.add.addEventListener('click', () => openForm());
els.search.addEventListener('input', render);
els.typeFilter.addEventListener('change', render);
els.showArchived.addEventListener('change', render);
els.typeFilter.innerHTML = `<option value="">All types</option>` + ACCOUNT_TYPE
  .map((t) => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('');

load().catch((err) => showError(err.message || String(err)));
