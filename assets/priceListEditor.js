// priceListEditor.js — the Kennel page's Extra charges price list (guide §21.2;
// Family Requests plan §3, §3.1): her extras in groups ("Photo packages",
// "Training"), each a name and a price with optional details (a line families
// see, whether families can ask for it, the pup's age window, boarding days, a
// payment plan), and each group's defaults that its extras follow unless they set
// their own. The group an extra is in is the section it sits in, so renaming a
// group renames it for all of its extras.
//
// priceListHtml(kennel, { familyRequests }) → the card's inner HTML;
// wirePriceList(root) wires adding, removing and moving; readPriceListForm(root)
// → { rows, groups } for extraCharges.readPriceList / readChargeGroups.
import { kennelChargeList, kennelChargeGroups, groupedChargeList, PLAN_DUE, planText, chargeRules } from '../data/extraCharges.js';
import { esc } from './ui.js';

const UNGROUPED = '';

function numInput(cls, value, label, unit) {
  return `<label class="xc-num">${esc(label)}
    <span style="display:inline-flex; align-items:center; gap:4px;"><input class="${cls}" type="number" min="0" step="1" inputmode="numeric" value="${esc(value ?? '')}" style="width:5em;"> ${esc(unit)}</span></label>`;
}

function windowFields(src, hint) {
  return `<div class="xc-windows" style="display:flex; flex-wrap:wrap; gap:10px 16px; margin:6px 0;">
      ${numInput('xc-from', src.request_from_weeks, 'Families can ask from', 'weeks old')}
      ${numInput('xc-until', src.request_until_weeks, 'until', 'weeks old')}
      ${numInput('xc-cancel', src.cancel_until_weeks, 'and cancel until', 'weeks old')}
    </div>
    <span class="field-hint">${hint}</span>`;
}

function planStep(st = { percent: '', due: 'at_weeks', n: '' }) {
  return `<div class="xc-step" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:6px;">
      <span style="display:inline-flex; align-items:center; gap:4px;"><input class="xc-pct" type="number" min="0" max="100" step="1" inputmode="decimal" value="${esc(st.percent)}" aria-label="Percent" style="width:4.5em;">%</span>
      <select class="xc-due" aria-label="Due" style="width:auto; flex:0 1 auto; min-width:0;">${PLAN_DUE.map((d) => `<option value="${d.value}"${d.value === st.due ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}</select>
      <span class="xc-n-wrap" style="display:inline-flex; align-items:center; gap:4px;"><input class="xc-n" type="number" min="0" step="1" inputmode="numeric" value="${esc(st.n ?? '')}" aria-label="How many" style="width:4.5em;"> <span class="xc-unit"></span></span>
      <button type="button" class="btn btn-sm" data-xc="remove-step" aria-label="Remove this payment">✕</button>
    </div>`;
}

function planFields(plan, hint) {
  return `<div class="xc-plan">
      <div class="xc-steps">${(plan || []).map(planStep).join('')}</div>
      <button type="button" class="btn btn-sm" data-xc="add-step">+ Add a payment</button>
      <span class="field-hint" style="display:block;">${hint}</span>
    </div>`;
}

function rowHtml(x, { familyRequests, groups }) {
  const r = { id: '', label: '', amount: '', ...x };
  const inherited = chargeRules({ group: r.group }, groups);
  const groupPlan = planText(inherited.payment_plan);
  return `<div class="xc-row" data-xc-id="${esc(r.id)}" style="border-top:1px solid var(--border); padding:8px 0;">
      <div style="display:flex; gap:8px; align-items:center;">
        <input class="xc-label" type="text" value="${esc(r.label)}" placeholder="e.g. Gold photo package" aria-label="Name" style="flex:2; min-width:0;">
        <input class="xc-amount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(r.amount)}" placeholder="$" aria-label="Price" style="flex:1; min-width:0;">
        <button type="button" class="btn btn-sm" data-xc="remove-row" aria-label="Remove">✕</button>
      </div>
      <details class="xc-details" style="margin-top:6px;">
        <summary class="faint">Details${r.family_can_request ? ' · families can ask' : ''}${r.payment_plan ? ` · ${esc(planText(r.payment_plan))}` : ''}</summary>
        <div class="field"><label>Group</label><select class="xc-move"></select></div>
        <div class="field"><label>What families see under the name (optional)</label>
          <input class="xc-desc" type="text" maxlength="300" value="${esc(r.description || '')}" placeholder="e.g. Two weeks of crate and potty training"></div>
        ${familyRequests ? `<label class="check-inline" style="display:block; margin:6px 0;"><input class="xc-can" type="checkbox"${r.family_can_request ? ' checked' : ''}> Families can ask for this on their status page</label>
        ${windowFields(r, 'Blank uses the group\'s ages, or no limit.')}` : ''}
        <div class="field" style="margin-top:8px;">${numInput('xc-board', r.boarding_days, 'The pup stays with you for', 'days')}
          <span class="field-hint">For a package like training: offers to log the boarding stay when you approve it.</span></div>
        <div class="field"><label>When it's paid</label>${planFields(r.payment_plan, r.group ? `Blank: the group's plan${groups.length ? ` (${esc(groupPlan.toLowerCase())})` : ''}.` : 'Blank: all with the balance.')}</div>
      </details>
    </div>`;
}

function groupHtml(group, items, { familyRequests, groups }, named = group !== UNGROUPED) {
  const rules = groups.find((g) => g.name === group) || {};
  return `<div class="xc-group" data-named="${named ? '1' : ''}" style="margin:12px 0 4px;">
      ${named
        ? `<div class="field" style="margin-bottom:4px;"><label>Group</label><input class="xcg-name" type="text" value="${esc(group)}" placeholder="e.g. Training" style="font-weight:600;"></div>
           <details class="xcg-rules" style="margin-bottom:4px;"><summary class="faint">Rules for every extra in this group</summary>
             ${familyRequests ? windowFields(rules, 'Ages families can ask for these and cancel them. An extra with its own ages uses those instead.') : ''}
             <div class="field" style="margin-top:8px;"><label>When they're paid</label>${planFields(rules.payment_plan, 'Blank: all with the balance. An extra with its own plan uses that instead.')}</div>
           </details>`
        : '<h3 class="xcg-title" style="margin:0 0 4px; font-size:1em;">Not in a group</h3>'}
      <div class="xcg-rows">${items.map((x) => rowHtml(x, { familyRequests, groups })).join('')}</div>
      <button type="button" class="btn btn-sm" data-xc="add-row">+ Add one${named ? ' to this group' : ''}</button>
    </div>`;
}

export function priceListHtml(kennel, { familyRequests = false } = {}) {
  const list = kennelChargeList(kennel);
  const groups = kennelChargeGroups(kennel);
  const sections = groupedChargeList(list);
  // Group defaults with no extras in them yet still show.
  for (const g of groups) if (!sections.some((s) => s.group === g.name)) sections.splice(sections.length - (sections.at(-1)?.group === UNGROUPED ? 1 : 0), 0, { group: g.name, items: [] });
  if (!sections.some((s) => s.group === UNGROUPED)) sections.push({ group: UNGROUPED, items: [] });
  return `<div id="xc-groups">${sections.map((s) => groupHtml(s.group, s.items, { familyRequests, groups })).join('')}</div>
    <button type="button" class="btn btn-sm" data-xc="add-group">+ New group</button>`;
}

// --- Wiring --------------------------------------------------------------------------

function syncUnits(scope) {
  scope.querySelectorAll('.xc-step').forEach((st) => {
    const due = PLAN_DUE.find((d) => d.value === st.querySelector('.xc-due').value);
    st.querySelector('.xc-n-wrap').style.display = due.unit ? 'inline-flex' : 'none';
    st.querySelector('.xc-unit').textContent = due.unit;
  });
}

function groupName(section) {
  return section.dataset.named ? section.querySelector('.xcg-name').value.trim() : UNGROUPED;
}

// Each row's Group select lists the sections as they're named right now.
function syncMoves(root) {
  const sections = [...root.querySelectorAll('.xc-group')];
  sections.forEach((sec, i) => { sec.dataset.idx = String(i); });
  root.querySelectorAll('.xc-row').forEach((row) => {
    const mine = row.closest('.xc-group').dataset.idx;
    row.querySelector('.xc-move').innerHTML = sections.map((sec) => {
      const name = groupName(sec);
      return `<option value="${sec.dataset.idx}"${sec.dataset.idx === mine ? ' selected' : ''}>${esc(sec.dataset.named ? (name || 'New group') : 'Not in a group')}</option>`;
    }).join('');
  });
}

export function wirePriceList(root, { familyRequests = false } = {}) {
  const box = root.querySelector('#xc-groups');
  if (!box) return;
  syncUnits(root);
  syncMoves(root);
  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-xc]');
    if (!btn || !root.contains(btn)) return;
    const act = btn.dataset.xc;
    if (act === 'remove-row') btn.closest('.xc-row').remove();
    if (act === 'add-row') {
      const rows = btn.closest('.xc-group').querySelector('.xcg-rows');
      rows.insertAdjacentHTML('beforeend', rowHtml({ group: groupName(btn.closest('.xc-group')) }, { familyRequests, groups: [] }));
      syncUnits(rows.lastElementChild);
      rows.lastElementChild.querySelector('.xc-label').focus();
    }
    if (act === 'add-group') {
      const ungrouped = [...box.querySelectorAll('.xc-group')].find((s) => !s.dataset.named);
      ungrouped.insertAdjacentHTML('beforebegin', groupHtml('', [{}], { familyRequests, groups: [] }, true));
      const sec = ungrouped.previousElementSibling;
      sec.querySelector('.xcg-name').value = '';
      syncUnits(sec);
      sec.querySelector('.xcg-name').focus();
    }
    if (act === 'add-step') {
      const steps = btn.closest('.xc-plan').querySelector('.xc-steps');
      const taken = [...steps.querySelectorAll('.xc-pct')].reduce((t, el) => t + (Number(el.value) || 0), 0);
      steps.insertAdjacentHTML('beforeend', planStep({ percent: taken < 100 ? 100 - taken : '', due: taken ? 'with_balance' : 'at_weeks', n: '' }));
      syncUnits(steps.lastElementChild.parentElement);
    }
    if (act === 'remove-step') btn.closest('.xc-step').remove();
    syncMoves(root);
  });
  root.addEventListener('change', (ev) => {
    if (ev.target.matches('.xc-due')) syncUnits(ev.target.closest('.xc-plan'));
    if (ev.target.matches('.xc-move')) {
      const target = box.querySelector(`.xc-group[data-idx="${ev.target.value}"] .xcg-rows`);
      if (target) target.appendChild(ev.target.closest('.xc-row'));
      syncMoves(root);
    }
  });
  root.addEventListener('input', (ev) => { if (ev.target.matches('.xcg-name')) syncMoves(root); });
}

// --- Reading -------------------------------------------------------------------------

function readWindows(scope) {
  const v = (cls) => scope.querySelector(`.xc-windows .${cls}`)?.value ?? '';
  return { request_from_weeks: v('xc-from'), request_until_weeks: v('xc-until'), cancel_until_weeks: v('xc-cancel') };
}

function readPlan(scope) {
  return [...scope.querySelectorAll('.xc-plan .xc-step')].map((st) => ({
    percent: st.querySelector('.xc-pct').value,
    due: st.querySelector('.xc-due').value,
    n: st.querySelector('.xc-n').value
  }));
}

// → { rows, groups, error }: a named group with extras but no name is an error.
export function readPriceListForm(root, { familyRequests = false } = {}) {
  const rows = [];
  const groups = [];
  for (const sec of root.querySelectorAll('#xc-groups .xc-group')) {
    const name = groupName(sec);
    const secRows = [...sec.querySelectorAll('.xcg-rows .xc-row')];
    const filled = secRows.filter((el) => el.querySelector('.xc-label').value.trim() || el.querySelector('.xc-amount').value.trim());
    if (sec.dataset.named && !name && filled.length) return { rows: [], groups: [], error: 'Give each group a name, or move its extras to "Not in a group".' };
    if (sec.dataset.named && name) {
      const rules = sec.querySelector('.xcg-rules');
      groups.push({ name, ...(familyRequests ? readWindows(rules) : {}), payment_plan: readPlan(rules) });
    }
    for (const el of secRows) {
      const d = el.querySelector('.xc-details');
      const row = {
        id: el.dataset.xcId || null,
        label: el.querySelector('.xc-label').value,
        amount: el.querySelector('.xc-amount').value,
        group: name,
        description: d.querySelector('.xc-desc').value,
        boarding_days: d.querySelector('.xc-board').value,
        payment_plan: readPlan(d)
      };
      if (familyRequests) Object.assign(row, { family_can_request: d.querySelector('.xc-can').checked }, readWindows(d));
      rows.push(row);
    }
  }
  return { rows, groups, error: '' };
}
