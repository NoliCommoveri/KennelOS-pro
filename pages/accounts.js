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
// Any account can hold her own payment link and/or payment instructions
// (Integrations plan §4, Level 0), which "Send payment link" on a Sale or Invoice
// sends, starting from the sale's Sold / paid through account.
// Connect Jotform (plan §2.1b): on a saved Form service account, her Jotform API
// key is kept on this device only (jotformConnect / jotformKeyStore), and she
// adds forms by picking them from her Jotform account, each with the field
// matches she confirms (field_map) instead of renaming her fields.
// Reads/writes only through accountRepo / expenseRepo.
import { accountRepo } from '../data/accountRepo.js';
import { expenseRepo } from '../data/expenseRepo.js';
import { ACCOUNT_TYPE, CONTRACT_FORM_TYPE } from '../data/vocab.js';
import { cleanForms, formLink, PREFILL_FIELDS } from '../data/contractForms.js';
import { feeRate, rateLabel } from '../data/processingFees.js';
import { sharedReferrals } from '../data/referralShare.js';
import { paymentLink } from '../data/paymentLinks.js';
import { JOTFORM_REGIONS, jotformConnection, connectJotform, disconnectJotform, listJotformForms, matchJotformForm } from '../data/jotformConnect.js';
import { factsFor, guessFormType, matchWarnings } from '../data/jotformMatch.js';
import { isDemo } from '../data/demoMode.js';
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
  return [a.name, a.website, a.username, a.customer_id, a.referral_code, a.referral_link, a.payment_link, a.notes]
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
    ${payHtml(a)}
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

// Her payment link / instructions on this account (plan §4), to send buyers.
function payHtml(a) {
  if (!a.payment_link && !a.payment_instructions) return '';
  return `<div class="acct-section"><div class="acct-section-title">Payment link — to send buyers</div>
    ${copyRow('Link', a.payment_link, { field: 'payment_link', id: a.id })}
    ${a.payment_instructions ? `<div class="acct-instructions">${esc(a.payment_instructions)}</div>` : ''}
  </div>`;
}

// Her contract forms on this account: type, label, and a link to open the form.
function formsHtml(a) {
  if (a.account_type !== 'form_service') return '';
  const forms = cleanForms(a.contract_forms);
  if (!forms.length) return '';
  return `<div class="acct-section"><div class="acct-section-title">Contract forms</div>
    ${forms.map((f) => `<div class="acct-row">
      <span class="acct-k acct-k-wide">${badge(CONTRACT_FORM_TYPE, f.form_type)}</span>
      <span class="acct-v">${esc(f.label)}${f.field_map ? ` <span class="muted">· ${Object.keys(f.field_map).length} fields matched</span>` : ''}</span>
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

// What a form picked from Jotform shows under its row.
const matchedNote = (map) => `Picked from Jotform · ${Object.keys(map || {}).length} fields matched`;

function formRowHtml(f = {}) {
  const typeOptions = CONTRACT_FORM_TYPE
    .map((t) => `<option value="${esc(t.value)}"${t.value === f.form_type ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  const jf = f.form_id
    ? ` data-form-id="${esc(f.form_id)}" data-field-map="${esc(JSON.stringify(f.field_map || {}))}"` : '';
  const meta = f.form_id
    ? `<div class="cf-meta field-hint"><span class="cf-meta-text">${esc(matchedNote(f.field_map))}</span> <button type="button" class="btn btn-sm" data-cf-fields>Fields…</button></div>` : '';
  return `<div class="cf-row" data-id="${esc(f.id || '')}"${jf}>
    <select class="cf-type" aria-label="Contract form type"><option value="">Type…</option>${typeOptions}</select>
    <input class="cf-label" type="text" aria-label="Label" value="${esc(f.label || '')}" placeholder="Label, e.g. Pet home – in state">
    <input class="cf-url" type="url" aria-label="Form link" value="${esc(f.url || '')}" placeholder="https://form.jotform.com/…">
    <button type="button" class="btn btn-sm" data-cf-remove aria-label="Remove this form">✕</button>
    ${meta}
  </div>`;
}

// --- Connect Jotform (plan §2.1b) ------------------------------------------

// A modal stacked on the account form; Escape closes only the top one.
function stackedModal(html, maxWidth = 640) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:${maxWidth}px;">${html}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}
const isTopModal = (overlay) => [...document.querySelectorAll('.modal-overlay')].pop() === overlay;

// Her field for each fact this form type fills, starting from `fieldMap`.
// → Promise<field_map | null> (null = cancelled).
function fieldMapModal({ title, formType, fields, fieldMap, questions }) {
  return new Promise((resolve) => {
    const facts = factsFor(formType);
    const known = new Set(fields.map((f) => f.param));
    const options = (fact) => {
      const cur = fieldMap[fact] || '';
      const gone = cur && !known.has(cur) ? `<option value="${esc(cur)}" selected>${esc(cur)} (not on the form now)</option>` : '';
      return `<option value="">— leave out —</option>${gone}${fields.map((f) => `<option value="${esc(f.param)}"${f.param === cur ? ' selected' : ''}>${esc(f.label)}</option>`).join('')}`;
    };
    const overlay = stackedModal(`<h2 style="margin-top:0;">Match fields: ${esc(title)}</h2>
      <p class="field-hint" style="margin-top:0;">Which of your form's fields each detail fills. These are suggestions from your field labels: check them, and change any that are wrong. Details left out aren't put in the link.</p>
      <div id="fm-warn"></div>
      <div class="fm-grid">${facts.map(([k, what]) => `<label for="fm-${esc(k)}">${esc(what)}</label><select id="fm-${esc(k)}" data-fact="${esc(k)}">${options(k)}</select>`).join('')}</div>
      <div class="form-actions"><button class="btn btn-primary" id="fm-save">Use these matches</button><button class="btn" id="fm-cancel">Cancel</button></div>`, 680);
    const read = () => {
      const map = {};
      overlay.querySelectorAll('select[data-fact]').forEach((sel) => { if (sel.value) map[sel.dataset.fact] = sel.value; });
      return map;
    };
    const warn = () => {
      const w = matchWarnings(formType, questions, read());
      overlay.querySelector('#fm-warn').innerHTML = w.length ? `<div class="inline-warn">${w.map(esc).join('<br>')}</div>` : '';
    };
    warn();
    overlay.addEventListener('change', warn);
    const done = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    function onKey(e) { if (e.key === 'Escape' && isTopModal(overlay)) done(null); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    overlay.querySelector('#fm-cancel').addEventListener('click', () => done(null));
    overlay.querySelector('#fm-save').addEventListener('click', () => done(read()));
  });
}

// Pick one of her Jotform forms and its type. → Promise<{ form, form_type } | null>.
function pickJotformModal(accountId, takenIds) {
  return new Promise((resolve) => {
    const overlay = stackedModal(`<h2 style="margin-top:0;">Add a form from Jotform</h2>
      <div id="pj-body"><p class="muted">Loading your forms…</p></div>
      <div id="pj-error"></div>
      <div class="form-actions"><button class="btn" id="pj-cancel">Cancel</button></div>`);
    const done = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    function onKey(e) { if (e.key === 'Escape' && isTopModal(overlay)) done(null); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    overlay.querySelector('#pj-cancel').addEventListener('click', () => done(null));
    const typeSelect = (id, guess) => `<select data-pj-type="${esc(id)}" aria-label="Contract form type"><option value="">Type…</option>${CONTRACT_FORM_TYPE
      .map((t) => `<option value="${esc(t.value)}"${t.value === guess ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`;
    listJotformForms(accountId).then((forms) => {
      overlay.querySelector('#pj-body').innerHTML = forms.length
        ? `<p class="field-hint" style="margin-top:0;">Pick what kind of contract each form is, then <strong>Add</strong>. Next you'll check which field each detail fills.</p>
           ${forms.map((f) => `<div class="pj-row"><span class="pj-title">${esc(f.title)}${f.status && f.status !== 'ENABLED' ? ` <span class="badge badge-gray">${esc(f.status.toLowerCase())}</span>` : ''}${takenIds.has(f.id) ? ' <span class="badge badge-green">added</span>' : ''}</span>
             ${typeSelect(f.id, guessFormType(f.title))}
             <button type="button" class="btn btn-sm" data-pj-add="${esc(f.id)}">Add</button></div>`).join('')}`
        : '<p class="muted">No forms on this Jotform account yet.</p>';
      overlay.querySelectorAll('[data-pj-add]').forEach((btn) => btn.addEventListener('click', () => {
        const id = btn.dataset.pjAdd;
        const type = overlay.querySelector(`[data-pj-type="${CSS.escape(id)}"]`).value;
        if (!type) { overlay.querySelector('#pj-error').innerHTML = '<div class="inline-error">Pick what kind of contract it is first.</div>'; return; }
        done({ form: forms.find((f) => f.id === id), form_type: type });
      }));
    }).catch((err) => {
      overlay.querySelector('#pj-body').innerHTML = '';
      overlay.querySelector('#pj-error').innerHTML = `<div class="inline-error">${esc(err.message || String(err))}</div>`;
    });
  });
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
        await disconnectJotform(a.id); // its Jotform key on this device, if any
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
    <div id="af-jf"></div>
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
    <h3 style="font-size:15px; margin:14px 0 4px;">Payment link — if buyers pay you through it</h3>
    <p class="field-hint" style="margin-top:0;">Your own payment link (a Stripe or Square payment link, PayPal.me, Venmo…), instructions (Zelle, check…), or both. <strong>Send payment link</strong> on a sale sends them with the amount owed, starting from the account the sale is sold / paid through.</p>
    <div class="form-grid">
      ${field('Payment link', `<input id="af-pay-link" type="url" value="${esc(a.payment_link)}" placeholder="https://buy.stripe.com/…">`, { wide: true })}
      ${field('Payment instructions', `<textarea id="af-pay-instructions" placeholder="e.g. Zelle to payments@yourkennel.com, with your puppy's name in the memo.">${esc(a.payment_instructions)}</textarea>`, { wide: true, hint: 'Written for the buyer: they go in the message.' })}
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
  function onKey(e) { if (e.key === 'Escape' && isTopModal(overlay)) close(); }
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
  // Connect Jotform: only on a saved account (the key is kept by its id), never in the Demo.
  const accountId = existing?.id || null;
  const jfBox = $('#af-jf');
  const jfError = (err) => { const m = $('#af-jf-msg'); if (m) m.innerHTML = `<span class="inline-error">${esc(err.message || String(err))}</span>`; };
  async function drawJotform() {
    if (isDemo()) { jfBox.innerHTML = ''; return; }
    if (!accountId) {
      jfBox.innerHTML = '<p class="field-hint">On Jotform? Save this account, then Edit it to <strong>Connect Jotform</strong>: pick your forms from your Jotform account and match their fields, instead of pasting links and renaming fields.</p>';
      return;
    }
    const jf = await jotformConnection(accountId);
    jfBox.innerHTML = jf
      ? `<div class="jf-box"><span>Jotform is connected on this device${jf.username ? ` as <strong>${esc(jf.username)}</strong>` : ''}.</span>
          <button type="button" class="btn btn-sm btn-primary" id="af-jf-add">+ Add from Jotform</button>
          <button type="button" class="btn btn-sm" id="af-jf-off">Disconnect</button>
          <div id="af-jf-msg" class="field-hint" role="status"></div></div>`
      : `<details class="jf-box"><summary><strong>Connect Jotform</strong> (optional): pick your forms and match their fields for you</summary>
          <p class="field-hint">In Jotform, open <strong>Settings → API</strong>, create a new key with <strong>Read Access</strong>, and paste it here (the menus may differ a little). The key stays <strong>on this device only</strong>: never in a backup, a sync or KennelOS's cloud, so connect each device you use. Any Jotform key can read all your form submissions, so keep this device locked.</p>
          <div class="form-grid">
            ${field('API key', '<input id="af-jf-key" type="password" autocomplete="off" spellcheck="false">')}
            ${field('Your Jotform account', `<select id="af-jf-region">${JOTFORM_REGIONS.map((r) => `<option value="${esc(r.value)}">${esc(r.label)}</option>`).join('')}</select>`)}
          </div>
          <button type="button" class="btn btn-sm btn-primary" id="af-jf-connect">Connect</button>
          <div id="af-jf-msg" class="field-hint" role="status"></div></details>`;
  }
  drawJotform().catch(() => { jfBox.innerHTML = ''; });
  const rowMeta = (row, map) => {
    row.dataset.fieldMap = JSON.stringify(map);
    row.querySelector('.cf-meta-text').textContent = matchedNote(map);
  };
  overlay.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-cf-remove]');
    if (rm) { rm.closest('.cf-row').remove(); return; }
    const cp = e.target.closest('[data-copy-name]');
    if (cp) { await copy(cp.dataset.copyName, cp); return; }
    const btn = e.target.closest('#af-jf-connect, #af-jf-off, #af-jf-add, [data-cf-fields]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      if (btn.id === 'af-jf-connect') {
        $('#af-jf-msg').textContent = 'Checking the key with Jotform…';
        await connectJotform(accountId, $('#af-jf-key').value, $('#af-jf-region').value);
        await drawJotform();
      } else if (btn.id === 'af-jf-off') {
        const ok = await confirmModal({ title: 'Disconnect Jotform on this device?', message: 'KennelOS forgets the API key on this device. Your contract forms and their field matches stay, and sending them keeps working.', confirmLabel: 'Disconnect' });
        if (ok) { await disconnectJotform(accountId); await drawJotform(); }
      } else if (btn.id === 'af-jf-add') {
        const taken = new Set([...formsBox.querySelectorAll('.cf-row[data-form-id]')].map((r) => r.dataset.formId));
        const picked = await pickJotformModal(accountId, taken);
        if (!picked) return;
        const m = await matchJotformForm(accountId, picked.form.id, picked.form_type);
        const map = await fieldMapModal({ title: picked.form.title, formType: picked.form_type, fields: m.fields, fieldMap: m.field_map, questions: m.questions });
        if (!map) return;
        formsBox.insertAdjacentHTML('beforeend', formRowHtml({ form_type: picked.form_type, label: picked.form.title, url: picked.form.url, form_id: picked.form.id, field_map: map }));
        $('#af-form-add').textContent = '+ Add another contract form';
      } else {
        const row = btn.closest('.cf-row');
        const type = row.querySelector('.cf-type').value;
        if (!type) throw new Error('Pick the form\'s type first.');
        if (!await jotformConnection(accountId)) throw new Error('Connect Jotform on this device to match this form\'s fields.');
        let current = null;
        try { current = JSON.parse(row.dataset.fieldMap || 'null'); } catch { current = null; }
        const m = await matchJotformForm(accountId, row.dataset.formId, type, current && Object.keys(current).length ? current : null);
        const map = await fieldMapModal({ title: row.querySelector('.cf-label').value || 'Contract form', formType: type, fields: m.fields, fieldMap: m.field_map, questions: m.questions });
        if (map) rowMeta(row, map);
      }
    } catch (err) {
      if ($('#af-jf-msg')) jfError(err); else $('#af-error').innerHTML = `<div class="inline-error">${esc(err.message || String(err))}</div>`;
    } finally { btn.disabled = false; }
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
      // Picked from Jotform: its form id and her confirmed field matches.
      if (row.dataset.formId) {
        f.form_id = row.dataset.formId;
        try { f.field_map = JSON.parse(row.dataset.fieldMap || '{}'); } catch { f.field_map = {}; }
      }
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
      fee_note: val('#af-fee-note'),
      payment_link: val('#af-pay-link'),
      payment_instructions: $('#af-pay-instructions').value.trim()
    };
    if (!data.name) {
      $('#af-error').innerHTML = `<div class="inline-error">Name is required.</div>`;
      return;
    }
    if (data.payment_link && !paymentLink(data.payment_link)) {
      $('#af-error').innerHTML = `<div class="inline-error">Paste the payment link as a web address, starting https://.</div>`;
      return;
    }
    if (data.payment_link) data.payment_link = paymentLink(data.payment_link);
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
