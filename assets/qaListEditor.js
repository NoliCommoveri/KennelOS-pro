// qaListEditor.js — an ordered list of heading + text rows she edits in place: her
// application FAQ (Application form page) and her waitlist policies (Kennel › Waitlist
// settings › Policies). Rows move up and down, delete, and add; each row may carry a
// grey note under it (`note(item, i)`, already-escaped HTML or '').
//
//   html = qaListHtml(items, opts)            the rows (no surrounding card)
//   wireQaList(root, items, opts, { onChange, rerender, newItem })
//
// opts: { name (unique per page, e.g. 'faq'), a, b (the two field keys, e.g.
// 'question', 'answer'), aPlaceholder, aLabel, bLabel, noun ('FAQ', 'policy'), empty,
// note? }. `items` is edited in place; onChange() after each edit, rerender() after a
// move, delete or add.
import { esc } from './ui.js';

export function qaListHtml(items, o) {
  if (!items.length) return `<p class="faint" style="margin:8px 0 0;">${esc(o.empty)}</p>`;
  return items.map((x, i) => `
    <div class="qa-row" data-qa="${esc(o.name)}" data-i="${i}">
      <div class="qa-head"><span class="qa-num">${i + 1}</span>
        <input class="qa-a" data-qf="${esc(o.a)}" type="text" value="${esc(x[o.a] ?? '')}" placeholder="${esc(o.aPlaceholder)}" aria-label="${esc(o.aLabel)}">
        <div class="qa-move">
          <button type="button" class="btn btn-sm" data-qa-up title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="btn btn-sm" data-qa-down title="Move down"${i === items.length - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" class="btn btn-sm btn-danger" data-qa-del title="Delete this ${esc(o.noun)}">✕</button>
        </div></div>
      <div class="field" style="margin-top:8px;"><label>${esc(o.bLabel)}</label><textarea data-qf="${esc(o.b)}">${esc(x[o.b] ?? '')}</textarea></div>
      ${o.note ? o.note(x, i) : ''}
    </div>`).join('');
}

export function wireQaList(root, items, o, { onChange, rerender, newItem }) {
  root.querySelectorAll(`[data-qa="${o.name}"]`).forEach((row) => {
    const i = Number(row.dataset.i);
    const x = items[i];
    row.querySelectorAll('[data-qf]').forEach((input) => input.addEventListener('input', () => { x[input.dataset.qf] = input.value; onChange(); }));
    const move = (j) => { [items[i], items[j]] = [items[j], items[i]]; onChange(); rerender(); };
    row.querySelector('[data-qa-up]').addEventListener('click', () => move(i - 1));
    row.querySelector('[data-qa-down]').addEventListener('click', () => move(i + 1));
    row.querySelector('[data-qa-del]').addEventListener('click', () => { items.splice(i, 1); onChange(); rerender(); });
  });
  const add = root.querySelector(`[data-qa-add="${o.name}"]`);
  if (add) {
    add.addEventListener('click', () => {
      items.push(newItem());
      onChange();
      rerender();
      root.querySelector(`[data-qa="${o.name}"][data-i="${items.length - 1}"] input`)?.focus();
    });
  }
}
