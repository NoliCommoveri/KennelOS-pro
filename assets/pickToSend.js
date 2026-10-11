// pickToSend.js — "Review sale & send" on a waitlist family's page (Integrations
// plan §2.6): once a family has picked a pup (its Sale is waiting for the
// deposit), one modal takes her through
//   1. Sale: registration, price, deposit, transport, sold through (Good Dog…)
//      with its processing fee (plan §5), balance due date, notes;
//   2. Contract: one of her contract forms (§2.1a), its link prefilled;
//   3. Send: one message with the deposit, how to pay, the contract link and the
//      invoice PDF, which she sends herself: the share sheet (PDF attached, where
//      the device can share files), her email app, or copy + download.
// Using any of those marks the contract sent, stamps the offer's
// deposit_request_sent_date and logs the message on the family's entry. Nothing
// goes to a server: the PDF and the link are made on her device.
// Pro-only (proPages.PRO_ONLY_STANDALONE): only the waitlist family page opens it.
import { saleRepo } from '../data/saleRepo.js';
import { accountRepo } from '../data/accountRepo.js';
import { feeRate, rateLabel, processingFee, priceToNet, netOf } from '../data/processingFees.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { contractRepo } from '../data/contractRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { expectedPricing } from '../data/saleDefaults.js';
import { rankForms, splitName } from '../data/contractForms.js';
import { loadContractForms, openContractForSale, gatherContractFacts, buildSignatureLink, markContractSent, balanceDueOn } from '../data/contractSend.js';
import { depositRequestMessage } from '../data/depositRequest.js';
import { logOwnMessage } from '../data/waitlistOutbox.js';
import { todayYMD } from '../data/dateUtils.js';
import { esc, badge, fmtDate, fmtMoney } from './ui.js';
import { REGISTRATION_TYPE, CONTRACT_FORM_TYPE, descriptor } from '../data/vocab.js';

const numOrNull = (v) => (String(v ?? '').trim() === '' ? null : Number(v));

// Whether this device can hand a PDF to the share sheet (Web Share level 2).
function canShareFile(file) {
  try { return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }); } catch { return false; }
}

// → Promise<boolean>: true when something was saved or sent (the page reloads).
//   offer: the turn row with the pick (sale_id, respond_by_date)
//   entry, contact: the family; litterLabel: the litter's label
//   paymentText: her payment instructions (the waitlist's, plan D21); kennelName signs it
export async function openPickToSend({ offer, entry, contact, litterLabel = '', paymentText = '', kennelName = '' }) {
  let sale = await saleRepo.getById(offer.sale_id);
  if (!sale) throw new Error('This pick has no sale any more.');
  const dog = await dogRepo.getById(sale.dog_id);
  const litter = dog?.litter_id ? await litterRepo.getById(dog.litter_id) : null;
  const forms = await loadContractForms();
  const accounts = await accountRepo.getAll({ includeArchived: true });
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const pupName = dog?.call_name || 'their pup';
  const who = contact ? splitName(contact.name)[0] : '';

  return new Promise((resolve) => {
    let changed = false;
    let step = 1;
    let contract = null;     // the contract being sent (made at step 2)
    let chosen = null;       // { form, url, values } or null for no contract
    let pickedFormId = null; // step 2's radio
    let showAll = false;
    let recorded = false;    // the send was recorded (once per modal)
    let message = null;      // step 3's { subject, body }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
    const done = () => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(changed); };
    function onKey(e) { if (e.key === 'Escape') done(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
    const $ = (sel) => overlay.querySelector(sel);
    const fail = (err) => { const box = $('#ps-error'); if (box) box.innerHTML = `<div class="inline-error">${esc(err.message || String(err))}</div>`; };

    const steps = () => `<div class="pill-row" style="margin:-4px 0 12px; font-size:13px;">
      ${['Sale', 'Contract', 'Send'].map((t, i) => `<span class="badge ${i + 1 === step ? 'badge-blue' : i + 1 < step ? 'badge-green' : 'badge-gray'}">${i + 1}. ${t}</span>`).join('')}
    </div>`;
    const shell = (body, actions) => {
      overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:640px;">
        <h2 style="margin-top:0;">${esc(pupName)} for ${esc(contact?.name || 'this family')}</h2>
        ${steps()}${body}
        <div id="ps-error"></div>
        <div class="form-actions">${actions}</div>
      </div>`;
      $('#ps-cancel')?.addEventListener('click', done);
    };
    const field = (label, inner, hint = '') => `<div class="field"><label>${esc(label)}</label>${inner}${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}</div>`;

    // --- 1. Sale ---------------------------------------------------------------
    // The channel's rate only SUGGESTS the fee (the Sale page's rule): it fills an
    // empty fee, or one still at the amount suggested last, and follows the price.
    let suggestedFee = null;
    let resuggest = false; // a channel change: suggest its fee once the step redraws
    const rateOf = (id) => feeRate(accountsById.get(id));
    function drawSale() {
      const s = sale;
      const channelOptions = '<option value="">— sold directly —</option>' + accounts
        .filter((a) => !a.is_archived || a.id === s.sales_channel_account_id)
        .map((a) => { const r = feeRate(a); return `<option value="${esc(a.id)}"${a.id === s.sales_channel_account_id ? ' selected' : ''}>${esc(a.name)}${r ? ` (${esc(rateLabel(r))})` : ''}${a.is_archived ? ' (archived)' : ''}</option>`; }).join('');
      const rate = rateOf(s.sales_channel_account_id);
      shell(`<div class="form-grid">
          ${field('Registration', `<select id="ps-reg">${REGISTRATION_TYPE.map((r) => `<option value="${esc(r.value)}"${r.value === s.registration_type ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select>`, 'Full adds the litter\'s Full-registration surcharge to a price still at its suggested amount.')}
          ${field('Price', `<input id="ps-price" type="number" min="0" step="0.01" value="${esc(s.price ?? '')}">`)}
          ${field('Deposit', `<input id="ps-deposit" type="number" min="0" step="0.01" value="${esc(s.deposit_amount ?? '')}">`, offer.respond_by_date ? `Due by ${fmtDate(offer.respond_by_date)}, the end of their turn.` : '')}
          ${field('Transport fee', `<input id="ps-transport" type="number" min="0" step="0.01" value="${esc(s.transport_fee ?? '')}">`)}
          ${field('Sold / paid through', `<select id="ps-channel">${channelOptions}</select>`, 'A marketplace or payment service that keeps a fee (Good Dog, Stripe…). Set its fee on the Accounts page.')}
          ${field('Processing fee', `<input id="ps-fee" type="number" min="0" step="0.01" value="${esc(s.processing_fee_amount ?? '')}">`, rate ? `Suggested from ${rateLabel(rate)} of the price. Change it to what was actually charged.` : 'What the marketplace or payment service keeps of this sale.')}
          <div class="field field-wide">
            <label class="check-inline"><input id="ps-passed" type="checkbox"${s.fee_passed_to_buyer ? ' checked' : ''}> The fee is passed to the buyer in the price</label>
            <span class="field-hint" id="ps-net"></span>
            ${rate ? `<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:6px;">
              <span class="faint">Price that nets you $</span>
              <input id="ps-net-want" type="number" min="0" step="0.01" placeholder="e.g. 3000" style="flex:1; min-width:90px; max-width:160px;">
              <button type="button" class="btn btn-sm" id="ps-net-apply">Set price</button>
            </div>` : ''}
          </div>
          ${field('Balance due date', `<input id="ps-balance-due" type="date" value="${esc(s.balance_due_date || '')}">`)}
          <div class="field field-wide"><label>Notes</label><textarea id="ps-notes">${esc(s.notes || '')}</textarea><span class="field-hint">Private: never in the message or the contract.</span></div>
        </div>
        <p class="field-hint"><a href="sale.html?id=${encodeURIComponent(s.id)}">Open the full sale</a> for anything else (boarding, payment details…).</p>`,
      `<button class="btn btn-primary" id="ps-next">Save &amp; continue</button><button class="btn" id="ps-cancel">Cancel</button>`);
      const priceEl = $('#ps-price'); const feeEl = $('#ps-fee');
      const netLine = () => {
        $('#ps-net').textContent = priceEl.value !== '' && feeEl.value !== '' && Number(feeEl.value) > 0
          ? `You net ${fmtMoney(netOf(priceEl.value, feeEl.value))} of the ${fmtMoney(priceEl.value)} price.` : '';
      };
      const suggest = () => {
        const r = rateOf($('#ps-channel').value);
        if (feeEl.value !== '' && Number(feeEl.value) !== suggestedFee) return;
        const next = r ? processingFee(priceEl.value, r) : null;
        feeEl.value = next ?? '';
        suggestedFee = next;
      };
      // What's on screen, kept when the step redraws (a channel change).
      const snapshot = () => ({
        ...sale,
        registration_type: $('#ps-reg').value,
        price: numOrNull(priceEl.value),
        deposit_amount: numOrNull($('#ps-deposit').value),
        transport_fee: numOrNull($('#ps-transport').value),
        sales_channel_account_id: $('#ps-channel').value || null,
        processing_fee_amount: numOrNull(feeEl.value),
        fee_passed_to_buyer: $('#ps-passed').checked,
        balance_due_date: $('#ps-balance-due').value || null,
        notes: $('#ps-notes').value
      });
      // A registration change moves a price still at its suggested amount (saleDefaults rule).
      $('#ps-reg').addEventListener('change', (e) => {
        if (!litter) return;
        const before = expectedPricing(dog, litter, sale.registration_type).price;
        const after = expectedPricing(dog, litter, e.target.value).price;
        if (before != null && Number(priceEl.value) === Number(before) && after != null) { priceEl.value = after; suggest(); netLine(); }
      });
      priceEl.addEventListener('input', () => { suggest(); netLine(); });
      feeEl.addEventListener('input', netLine);
      $('#ps-channel').addEventListener('change', (e) => {
        const account = accountsById.get(e.target.value);
        sale = snapshot();
        if (account) sale.fee_passed_to_buyer = !!account.fee_passed_to_buyer_default;
        resuggest = true;
        drawSale();
      });
      $('#ps-net-apply')?.addEventListener('click', () => {
        const r = rateOf($('#ps-channel').value);
        const price = r ? priceToNet($('#ps-net-want').value, r) : null;
        if (price == null) return;
        priceEl.value = price;
        feeEl.value = processingFee(price, r);
        suggestedFee = Number(feeEl.value);
        $('#ps-passed').checked = true;
        netLine();
      });
      if (resuggest) { resuggest = false; suggest(); }
      netLine();
      $('#ps-next').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try {
          const d = snapshot();
          sale = await saleRepo.update(sale.id, {
            registration_type: d.registration_type, price: d.price, deposit_amount: d.deposit_amount,
            transport_fee: d.transport_fee, sales_channel_account_id: d.sales_channel_account_id,
            processing_fee_amount: d.processing_fee_amount, fee_passed_to_buyer: d.fee_passed_to_buyer,
            balance_due_date: d.balance_due_date, notes: d.notes
          });
          changed = true;
          contract = await openContractForSale(sale.id);
          step = 2;
          drawContract();
        } catch (err) { fail(err); e.currentTarget.disabled = false; }
      });
    }

    // --- 2. Contract -------------------------------------------------------------
    function drawContract() {
      const ranked = rankForms(forms, { contract_type: 'sale' }, sale);
      const all = [...ranked.matching, ...ranked.others];
      if (pickedFormId === null) pickedFormId = all.length ? (ranked.matching[0] || all[0]).id : '';
      const option = (f) => `<label class="check-inline" style="display:flex; gap:8px; align-items:center; padding:4px 0;">
          <input type="radio" name="ps-form" value="${esc(f.id)}"${f.id === pickedFormId ? ' checked' : ''}>
          <span>${esc(f.label)} ${badge(CONTRACT_FORM_TYPE, f.form_type)}</span></label>`;
      const sent = contract?.esign_url
        ? `<p class="field-hint">This sale's ${esc(contract.esign_form_label || 'contract')} went out ${contract.esign_sent_date ? esc(fmtDate(contract.esign_sent_date)) : 'before'}. Sending again makes a fresh link with today's details.</p>` : '';
      shell(`${forms.length
          ? `${ranked.matching.map(option).join('')}
             ${ranked.others.length && ranked.matching.length ? `<button type="button" class="btn btn-sm" id="ps-all" style="margin:4px 0;">${showAll ? 'Hide other forms' : `Show all forms (${ranked.others.length} more)`}</button>` : ''}
             ${showAll || !ranked.matching.length ? ranked.others.map(option).join('') : ''}`
          : '<p class="muted">You have no contract forms yet. Add your form service (for example Jotform) on the Accounts page as a <strong>Form service</strong> account with your contract forms, and they\'ll show here.</p>'}
        <label class="check-inline" style="display:flex; gap:8px; align-items:center; padding:4px 0;">
          <input type="radio" name="ps-form" value=""${pickedFormId === '' ? ' checked' : ''}> <span>No contract in this message</span></label>
        ${sent}`,
      `<button class="btn btn-primary" id="ps-next">Continue</button><button class="btn" id="ps-back">Back</button><button class="btn" id="ps-cancel">Cancel</button>`);
      overlay.querySelectorAll('input[name="ps-form"]').forEach((r) => r.addEventListener('change', () => { pickedFormId = r.value; }));
      $('#ps-all')?.addEventListener('click', () => { showAll = !showAll; drawContract(); });
      $('#ps-back').addEventListener('click', () => { step = 1; drawSale(); });
      $('#ps-next').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try {
          const form = all.find((f) => f.id === pickedFormId) || null;
          chosen = null;
          if (form) {
            contract = contract || await contractRepo.create({
              contract_type: 'sale', related_sale_id: sale.id, kennel_id: sale.kennel_id, status: 'draft',
              title: `${form.label}: ${pupName}`
            });
            changed = true;
            chosen = { form, ...buildSignatureLink(form, await gatherContractFacts(contract)) };
          }
          message = null;
          step = 3;
          await drawSend();
        } catch (err) { fail(err); e.currentTarget.disabled = false; }
      });
    }

    // --- 3. Send --------------------------------------------------------------------
    let pdfFile = null;
    async function invoiceFile() {
      if (!pdfFile) {
        const { invoicePdfFile } = await import('./invoicePdf.js');
        pdfFile = await invoicePdfFile({ source: 'sale', id: sale.id, doc: 'invoice' });
      }
      return pdfFile;
    }

    async function drawSend() {
      if (!message) {
        const balance = await balanceDueOn(sale);
        const rest = Math.max(0, balance - (Number(sale.deposit_amount) || 0));
        message = depositRequestMessage({
          who, pupName: dog?.call_name || '', litterLabel,
          deposit: sale.deposit_amount != null ? fmtMoney(sale.deposit_amount) : '',
          depositDue: offer.respond_by_date ? fmtDate(offer.respond_by_date) : '',
          paymentText,
          contractLabel: chosen ? descriptor(CONTRACT_FORM_TYPE, chosen.form.form_type).label.toLowerCase() : '', contractLink: chosen?.url || '',
          invoice: true,
          balance: rest > 0 ? fmtMoney(rest) : '', balanceDue: sale.balance_due_date ? fmtDate(sale.balance_due_date) : '',
          kennelName
        });
      }
      let share = false;
      try { share = canShareFile(await invoiceFile()); } catch { share = false; }
      const email = contact?.email || '';
      const sentLine = offer.deposit_request_sent_date ? `<p class="field-hint">You sent them a deposit request on ${esc(fmtDate(offer.deposit_request_sent_date))}.</p>` : '';
      shell(`<p class="field-hint" style="margin-top:0;">To ${esc(contact?.name || 'them')}${email ? ` · ${esc(email)}` : ' (no email on their contact)'}. Edit anything before it goes.</p>
        ${sentLine}
        <div class="field"><label for="ps-subject">Subject</label><input id="ps-subject" type="text" value="${esc(message.subject)}"></div>
        <div class="field"><label for="ps-body">Message</label><textarea id="ps-body" rows="14" style="width:100%; font-family:inherit;">${esc(message.body)}</textarea></div>
        <p class="field-hint">${share
          ? '<strong>Share</strong> opens your Mail, Gmail or Messages with the invoice PDF attached and this message filled in.'
          : 'This browser can\'t attach files to a message. Use <strong>Email</strong> (or Copy), then attach the invoice you <strong>Download</strong>.'}</p>`,
      `${share ? '<button class="btn btn-primary" id="ps-share">Share with invoice</button>' : ''}
       ${email ? `<a class="btn${share ? '' : ' btn-primary'}" id="ps-email" href="#">Email</a>` : ''}
       <button class="btn" id="ps-download">Download invoice</button>
       <button class="btn" id="ps-copy">Copy message</button>
       <button class="btn" id="ps-back">Back</button>
       <button class="btn" id="ps-cancel">${recorded ? 'Done' : 'Close'}</button>
       <span class="field-hint" id="ps-note" role="status"></span>`);
      const read = () => ({ subject: $('#ps-subject').value, body: $('#ps-body').value });
      const links = () => {
        message = read();
        if ($('#ps-email')) $('#ps-email').href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.body)}`;
      };
      links();
      $('#ps-subject').addEventListener('input', links);
      $('#ps-body').addEventListener('input', links);
      const note = (t) => { $('#ps-note').textContent = t; };
      $('#ps-back').addEventListener('click', () => { message = read(); step = 2; drawContract(); });
      $('#ps-share')?.addEventListener('click', async () => {
        message = read();
        try {
          await navigator.share({ files: [await invoiceFile()], title: message.subject, text: message.body });
          await record();
        } catch (err) { if (err?.name !== 'AbortError') note('Sharing didn\'t work here. Use Email or Copy, and attach the downloaded invoice.'); }
      });
      $('#ps-email')?.addEventListener('click', () => { record(); });
      $('#ps-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText($('#ps-body').value); note('Copied. Paste it into your message and attach the invoice.'); await record(); }
        catch { $('#ps-body').select(); note('Select the message and copy it.'); }
      });
      $('#ps-download').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try {
          const file = await invoiceFile();
          const url = URL.createObjectURL(file);
          const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (err) { fail(err); } finally { e.currentTarget.disabled = false; }
      });
    }

    // She sent it (or copied it to send): mark it, once.
    async function record() {
      if (recorded) return;
      recorded = true;
      changed = true;
      try {
        const msg = message || { subject: '', body: '' };
        if (chosen && contract) contract = await markContractSent(contract, chosen.form, chosen.url);
        offer = await waitlistOfferRepo.update(offer.id, { deposit_request_sent_date: todayYMD() });
        await logOwnMessage(entry.id, { kind: 'deposit_request', subject: msg.subject, body: msg.body });
        const close = $('#ps-cancel');
        if (close) close.textContent = 'Done';
        $('#ps-note').textContent = `Recorded as sent${chosen ? `, and the contract (${chosen.form.label}) is marked Sent` : ''}.`;
      } catch (err) { fail(err); }
    }

    drawSale();
  });
}
