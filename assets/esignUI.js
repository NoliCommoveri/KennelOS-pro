// esignUI.js — e-sign through Firma, the screens (Integrations plan §2.3a, step 8;
// D25–D26, D30–D31). Pro-only (proPages.PRO_ONLY_STANDALONE).
//
//   openContractTemplates()  Contracts → Contract templates: set up e-signing once,
//                            upload her contract PDFs, say what kind of contract
//                            each is, and open Firma's editor (its own tab) to
//                            place the signature and detail fields.
//   sendWithFirma(...)       a contract's Send for signature with one of those
//                            templates: who signs, this month's count, send.
//   openCountersign(ref)     her own signing link, on a template she countersigns
//                            (D32), opened in a new tab.
//
// She has no Firma login: KennelOS holds the account and her kennel gets its own
// workspace. Everything goes through data/cloud/cloudEsign.js.
import {
  esignSignedIn, esignStatus, setUpEsign, templates as listTemplates, uploadTemplate, editorLink,
  sendForEsign, signedCopyLink, countersignLink, countersignerFor, esignProblem, TEMPLATE_MAX_BYTES
} from '../data/cloud/cloudEsign.js';
import { mergeTemplates, setTemplateType } from '../data/esignTemplates.js';
import { accountRepo } from '../data/accountRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { prefillValues } from '../data/contractForms.js';
import { CONTRACT_FORM_TYPE } from '../data/vocab.js';
import { esc, fmtDate, confirmModal } from './ui.js';

function overlayOf(html, { wide = false } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:${wide ? 720 : 560}px;">${html}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

const usageLine = (u) => (u
  ? `${u.used} of ${u.limit} e-sign contract${u.limit === 1 ? '' : 's'} sent this month${u.resetsOn ? ` (resets ${esc(fmtDate(u.resetsOn))})` : ''}.`
  : '');

const typeOptions = (current) => `<option value="">Not offered yet: pick a type…</option>${CONTRACT_FORM_TYPE
  .map((t) => `<option value="${esc(t.value)}"${t.value === current ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}`;

// Open a link in a new tab that can't reach back into this one. The tab is opened
// first, while the tap still counts as one (a browser blocks a tab opened after
// an await), then sent where it goes. → false when the browser blocked it.
export async function openInNewTab(linkPromise) {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const url = await linkPromise;
    if (tab) { tab.location.href = url; return true; }
    window.open(url, '_blank', 'noopener');
    return false;
  } catch (err) {
    tab?.close();
    throw err;
  }
}

// --- Contract templates ---------------------------------------------------------------

export function openContractTemplates() {
  const overlay = overlayOf('<h2 style="margin-top:0;">Contract templates</h2><p class="muted">Loading…</p>', { wide: true });
  const box = overlay.querySelector('.modal');
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  let busy = false;

  const frame = (body, actions = '') => {
    box.innerHTML = `<h2 style="margin-top:0;">Contract templates</h2>
      ${body}
      <div id="ct-msg" role="status"></div>
      <div class="form-actions">${actions}<button class="btn" id="ct-close">Close</button></div>`;
    box.querySelector('#ct-close').addEventListener('click', close);
  };
  const say = (html) => { const m = box.querySelector('#ct-msg'); if (m) m.innerHTML = html; };
  const problem = (err) => say(`<div class="inline-error">${esc(esignProblem(err).message)}</div>`);

  async function draw() {
    if (!esignSignedIn()) {
      frame(`<p>E-signing runs through your KennelOS cloud account. Sign in to cloud backup first (<a href="settings.html">Settings</a> → Cloud backup), then come back here.</p>`);
      return;
    }
    let status;
    try { status = await esignStatus(); } catch (err) { frame(''); problem(err); return; }
    if (!status.available) {
      frame('<p>E-signing isn\'t available right now. Your own contract forms\' links (on the Accounts page) still work.</p>');
      return;
    }
    if (!status.connected) { await drawSetUp(); return; }
    await drawList(status);
  }

  async function drawSetUp() {
    const kennels = await kennelRepo.getAll();
    const name = kennels.find((k) => k.kennel_name)?.kennel_name || '';
    frame(`<p style="margin-top:0;">Send your own contracts to be signed online: the buyer gets an email, signs on their phone or computer, and the contract comes back <strong>Signed</strong> by itself, with the signed PDF.</p>
      <ul class="field-hint" style="padding-left:18px;">
        <li>It runs on <strong>Firma</strong>, an e-signature service hosted in the EU, through KennelOS's own Firma account. You don't need one, and there's nothing to pay per contract.</li>
        <li>What goes to Firma: your kennel's name, the contract PDFs you upload, and for each contract you send, the signer's name and email and the contract's details (names, the pup, the price). Nothing else.</li>
        <li>Your plan includes a number of e-sign contracts a month. Your own contract forms' links stay free beside it.</li>
      </ul>
      <div class="field"><label for="ct-kennel">Your kennel's name, as signers see it</label>
        <input id="ct-kennel" type="text" maxlength="100" value="${esc(name)}"></div>`,
    '<button class="btn btn-primary" id="ct-setup">Set up e-signing</button>');
    box.querySelector('#ct-setup').addEventListener('click', async (e) => {
      if (busy) return;
      busy = true; e.currentTarget.disabled = true;
      say('<p class="field-hint">Setting up your kennel\'s e-signing…</p>');
      try {
        const kennelName = box.querySelector('#ct-kennel').value.trim();
        const status = await setUpEsign(kennelName || name);
        busy = false;
        await drawList(status);
      } catch (err) { busy = false; e.currentTarget.disabled = false; problem(err); }
    });
  }

  async function drawList(status) {
    let rows;
    try { rows = mergeTemplates(await listTemplates(), await accountRepo.getAll()); } catch (err) { frame(''); problem(err); return; }
    const row = (t) => `<div class="acct-row" data-tid="${esc(t.id)}" style="flex-wrap:wrap; gap:8px; padding:6px 0; border-top:1px solid var(--border,#e2e6ec);">
        <span class="acct-v" style="min-width:160px;"><strong>${esc(t.name)}</strong>${t.pageCount ? ` <span class="muted">· ${esc(t.pageCount)} page${t.pageCount === 1 ? '' : 's'}</span>` : ''}</span>
        <select class="ct-type" aria-label="What kind of contract ${esc(t.name)} is">${typeOptions(t.form_type)}</select>
        <label class="check-inline" style="display:flex; gap:6px; align-items:center;" title="You sign it too, after the buyer">
          <input type="checkbox" class="ct-flag" data-flag="countersign"${t.countersign ? ' checked' : ''}${t.form_type ? '' : ' disabled'}> I countersign</label>
        <label class="check-inline" style="display:flex; gap:6px; align-items:center;" title="KennelOS keeps the signed PDF and emails the buyer a link to it">
          <input type="checkbox" class="ct-flag" data-flag="keepCopy"${t.keepCopy ? ' checked' : ''}${t.form_type ? '' : ' disabled'}> Email the buyer the signed copy</label>
        <button type="button" class="btn btn-sm" data-edit="${esc(t.id)}">Place fields</button>
      </div>`;
    frame(`<p class="field-hint" style="margin-top:0;">${usageLine(status.usage)} A contract's <strong>Send for signature</strong> offers the templates of its kind, beside your own contract forms.</p>
      ${rows.length ? rows.map(row).join('') : '<p class="muted">No templates yet. Upload your first contract below.</p>'}
      <h3 style="font-size:15px; margin:16px 0 4px;">Add a template</h3>
      <p class="field-hint" style="margin-top:0;">Upload your contract as a PDF (up to ${Math.round(TEMPLATE_MAX_BYTES / 100_000) / 10} MB). Then <strong>Place fields</strong> opens Firma's editor in a new tab, where you put the buyer's signature, and the details KennelOS fills in (buyer, pup, price…), where they go on the page.</p>
      <p class="field-hint">If you sign your contracts too, tick <strong>I countersign</strong>, and in Firma's editor add a second signer with your signature field. The buyer signs first, then you sign from the contract's <strong>Countersign</strong> button. It's still one e-sign contract.</p>
      <p class="field-hint">Tick <strong>Email the buyer the signed copy</strong> and, once everyone has signed, KennelOS saves the signed PDF and emails the buyer a link to it. The contract's <strong>Signed copy</strong> opens the same copy.</p>
      <div class="form-grid">
        <div class="field"><label for="ct-file">Contract PDF</label><input id="ct-file" type="file" accept="application/pdf,.pdf"></div>
        <div class="field"><label for="ct-name">Name</label><input id="ct-name" type="text" maxlength="200" placeholder="e.g. Pet home contract"></div>
        <div class="field"><label for="ct-newtype">Kind of contract</label><select id="ct-newtype">${typeOptions('')}</select></div>
      </div>
      <button type="button" class="btn btn-sm btn-primary" id="ct-upload" style="margin-top:8px;">Upload</button>`);
    box.querySelector('#ct-file').addEventListener('change', (e) => {
      const n = box.querySelector('#ct-name');
      if (!n.value.trim() && e.target.files?.[0]) n.value = e.target.files[0].name.replace(/\.pdf$/i, '');
    });
    box.querySelectorAll('.ct-type').forEach((sel) => sel.addEventListener('change', async () => {
      const tid = sel.closest('[data-tid]').dataset.tid;
      const t = rows.find((r) => r.id === tid);
      try {
        await setTemplateType({ templateId: tid, name: t?.name, formType: sel.value });
        sel.closest('[data-tid]').querySelectorAll('.ct-flag').forEach((tick) => { tick.disabled = !sel.value; });
        say(`<p class="field-hint">${sel.value ? `Saved: ${esc(t?.name || 'the template')} is offered for ${esc(CONTRACT_FORM_TYPE.find((x) => x.value === sel.value)?.label.toLowerCase() || 'that kind of contract')}s.` : `${esc(t?.name || 'The template')} isn't offered any more.`}</p>`);
      } catch (err) { problem(err); }
    }));
    const flagSaved = {
      countersign: (on, name) => (on
        ? `Saved: you countersign ${name}. In Firma's editor, give the second signer your signature field.`
        : `Saved: only the buyer signs ${name}.`),
      keepCopy: (on, name) => (on
        ? `Saved: once ${name} is signed, KennelOS keeps the signed PDF and emails the buyer a link to it.`
        : `Saved: KennelOS won't keep or email ${name}'s signed copy. Signed copy still opens Firma's.`)
    };
    box.querySelectorAll('.ct-flag').forEach((tick) => tick.addEventListener('change', async () => {
      const el = tick.closest('[data-tid]');
      const t = rows.find((r) => r.id === el.dataset.tid);
      const formType = el.querySelector('.ct-type').value;
      const flag = tick.dataset.flag;
      if (!formType) { tick.checked = false; return; }
      try {
        await setTemplateType({ templateId: el.dataset.tid, name: t?.name, formType, [flag]: tick.checked });
        say(`<p class="field-hint">${flagSaved[flag](tick.checked, esc(t?.name || 'this template'))}</p>`);
      } catch (err) { tick.checked = !tick.checked; problem(err); }
    }));
    box.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', async () => {
      say('<p class="field-hint">Opening Firma\'s editor in a new tab…</p>');
      try {
        const opened = await openInNewTab(editorLink(btn.dataset.edit));
        say(`<p class="field-hint">${opened ? 'Firma\'s editor is open in a new tab. Place the fields, save, then close that tab.' : 'Your browser blocked the new tab. Allow pop-ups for KennelOS, then tap Place fields again.'} Each detail field you add there is named for what KennelOS fills in (buyerName, puppyName, price…).</p>`);
      } catch (err) { problem(err); }
    }));
    box.querySelector('#ct-upload').addEventListener('click', async (e) => {
      if (busy) return;
      const file = box.querySelector('#ct-file').files?.[0];
      const formType = box.querySelector('#ct-newtype').value;
      if (!file) { say('<div class="inline-error">Choose your contract\'s PDF first.</div>'); return; }
      if (!formType) { say('<div class="inline-error">Pick what kind of contract it is.</div>'); return; }
      busy = true; e.currentTarget.disabled = true;
      say('<p class="field-hint">Uploading…</p>');
      try {
        const t = await uploadTemplate({ name: box.querySelector('#ct-name').value, file });
        await setTemplateType({ templateId: t.id, name: t.name, formType });
        busy = false;
        await drawList(await esignStatus());
        say(`<p class="field-hint">Uploaded ${esc(t.name)}. Next: <strong>Place fields</strong> on it, so the buyer has somewhere to sign.</p>`);
      } catch (err) { busy = false; e.currentTarget.disabled = false; problem(err); }
    });
  }

  draw().catch((err) => { frame(''); problem(err); });
}

// --- Send with Firma ------------------------------------------------------------------

// One contract out through one of her Firma templates. `signer` is the contact
// who signs (buyer or other party). With emailChoice off (Pick to send) the
// signing link goes in her own message instead of Firma's email.
// → Promise<{ contract, signingLink, emailed } | null>
export function sendWithFirma({ contract, form, facts, signer, emailChoice = true }) {
  return new Promise((resolve) => {
    const overlay = overlayOf('<h2 style="margin-top:0;">Send for e-signature</h2><p class="muted">Loading…</p>');
    const box = overlay.querySelector('.modal');
    let busy = false;
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay && !busy) done(null); });
    const filled = prefillValues(form.form_type, facts).length;
    const counter = countersignerFor(form, facts);

    async function draw() {
      let usage = null;
      try { usage = (await esignStatus()).usage; } catch { usage = null; }
      const full = usage && usage.used >= usage.limit;
      box.innerHTML = `<h2 style="margin-top:0;">Send ${esc(form.label)}</h2>
        <p class="field-hint" style="margin-top:0;">Through Firma, with ${filled} detail${filled === 1 ? '' : 's'} of this contract filled in where you placed them on the template. ${usage ? usageLine(usage) : ''}</p>
        <div class="form-grid">
          <div class="field"><label for="fs-name">Who signs</label><input id="fs-name" type="text" value="${esc(signer?.name || '')}"></div>
          <div class="field"><label for="fs-email">Their email</label><input id="fs-email" type="email" value="${esc(signer?.email || '')}"></div>
        </div>
        ${emailChoice ? `<label class="check-inline" style="display:flex; gap:8px; align-items:center; margin-top:6px;">
          <input id="fs-emailme" type="checkbox" checked> Firma emails them the signing link</label>
          <p class="field-hint">Untick to send the link in your own message instead. It counts the same.</p>`
        : '<p class="field-hint">The signing link goes into your message. Firma doesn\'t email them.</p>'}
        ${form.countersign ? (counter
          ? `<p class="field-hint">You countersign this one, as ${esc(counter.email)}: once they've signed, tap <strong>Countersign</strong> on the contract. It's marked Signed when you both have.</p>`
          : '<div class="inline-error">You countersign this template, so KennelOS needs your cloud account\'s email. Sign in again in Settings → Cloud backup.</div>') : ''}
        ${form.keep_copy ? '<p class="field-hint">Once everyone has signed, KennelOS saves the signed PDF and emails them a link to it.</p>' : ''}
        ${contract.esign_provider === 'firma' && contract.esign_ref ? '<p class="field-hint">This contract already went out through Firma. Sending again makes a new signing request and counts again.</p>' : ''}
        ${full ? `<div class="inline-warn">You've sent this month's ${esc(usage.limit)} e-sign contracts. It resets on ${esc(fmtDate(usage.resetsOn))}. Until then, send one of your own contract forms' links instead.</div>` : ''}
        <div id="fs-msg" role="status"></div>
        <div class="form-actions">
          <button class="btn btn-primary" id="fs-send"${full || (form.countersign && !counter) ? ' disabled' : ''}>Send</button>
          <button class="btn" id="fs-cancel">Cancel</button>
        </div>`;
      const $ = (s) => box.querySelector(s);
      $('#fs-cancel').addEventListener('click', () => { if (!busy) done(null); });
      $('#fs-send').addEventListener('click', () => go(false));
    }

    async function go(resend) {
      if (busy) return;
      const $ = (s) => box.querySelector(s);
      const name = $('#fs-name').value.trim();
      const email = $('#fs-email').value.trim();
      const emailed = emailChoice ? $('#fs-emailme').checked : false;
      if (!name) { $('#fs-msg').innerHTML = '<div class="inline-error">Who signs? Add their name.</div>'; return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $('#fs-msg').innerHTML = '<div class="inline-error">Add their email address.</div>'; return; }
      busy = true; $('#fs-send').disabled = true; $('#fs-cancel').disabled = true;
      $('#fs-msg').innerHTML = '<p class="field-hint">Sending…</p>';
      try {
        const res = await sendForEsign({ contract, form, facts, signer: { name, email }, emailSigner: emailed, resend });
        busy = false;
        done({ ...res, emailed });
      } catch (err) {
        busy = false;
        const p = esignProblem(err);
        if (p.kind === 'already_sent' && !resend) {
          const again = await confirmModal({
            title: 'Send it again?',
            message: 'This contract is already out for signature through Firma. Sending again makes a fresh signing request with today\'s details, and counts as another of this month\'s e-sign contracts. The first link stays open until it expires.',
            confirmLabel: 'Send again'
          });
          if (again) { await go(true); return; }
        }
        if (!box.isConnected) return;
        $('#fs-msg').innerHTML = `<div class="inline-${p.kind === 'unknown' ? 'warn' : 'error'}">${esc(p.message)}</div>`;
        $('#fs-cancel').disabled = false;
        $('#fs-send').disabled = p.kind === 'limit' || p.kind === 'unknown';
      }
    }

    draw();
  });
}

// Her own signing page (D32), in a new tab. → false when the browser blocked it.
export async function openCountersign(ref) {
  return openInNewTab(countersignLink(ref).then((r) => r.url));
}

// The signed PDF (or the copy so far), opened in a new tab.
export async function openSignedCopy(ref) {
  return openInNewTab(signedCopyLink(ref).then((r) => r.url));
}
