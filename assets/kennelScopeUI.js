// kennelScopeUI.js — every piece of ACTIVE-KENNEL user interface, in one place
// (Multi-Kennel Scope Spec §7/§8). Three widgets, all reading the one scope
// service (data/kennelScope.js) and none of them reading the setting directly:
//
//   • renderKennelSwitcher(host) — the nav's active-kennel indicator + switcher.
//   • mountScopeChip(el)         — the "🏠 <kennel> only" chip a scoped list or
//                                  report shows in its toolbar, so a short list
//                                  always says WHY it is short.
//   • renderScopeNotice(host, r) — the out-of-scope banner on a detail page
//                                  reached by id. Detail pages are deliberately
//                                  never scope-filtered (§7): a direct link must
//                                  always resolve, so an out-of-scope record
//                                  renders in full with this affordance above it,
//                                  never a 404 and never a silent redirect.
//
// Edition posture (spec §12): all three are inert unless editionFlags.multiKennel
// is on. Lite is single-kennel — isScoped() is permanently false there, so the
// chip and the notice never fire, and the switcher returns before rendering.
import { editionFlags } from '../data/editionConfig.js';
import {
  getActiveKennel, setActiveKennel, ownKennels, isScoped, inScope, isOwnedByUser
} from '../data/kennelScope.js';
import { esc } from './ui.js';

// True in the editions that have a scope at all. Callers that build markup up
// front (rather than awaiting a render) branch on this to skip the host element.
export function hasKennelScopeUI() {
  return !!editionFlags.multiKennel;
}

// Switching scope re-runs every derived read on the page, and pages compute
// their view models once at load — so a switch is a reload, not a re-render.
// Same posture as the archived-toggle: one lever, one repaint of the truth.
function applyScope(id) {
  setActiveKennel(id);
  location.reload();
}

// --- The nav switcher (§8) -------------------------------------------------

// Rendered into the nav's scope slot on every page. Silent until an own kennel
// exists (pre-setup, and all of Lite), so a first-run user never sees a switcher
// over an empty app.
export async function renderKennelSwitcher(host) {
  if (!host || !hasKennelScopeUI()) return;
  // getActiveKennel() doubles as the stale-scope guard (§5): an archived or
  // deleted active kennel is cleared here, on every page load, rather than
  // rendering an empty app with no explanation.
  const [kennels, active] = await Promise.all([ownKennels(), getActiveKennel()]);
  if (!kennels.length) return;

  const activeId = active?.id || '';
  const options = [`<option value=""${activeId ? '' : ' selected'}>All kennels</option>`]
    .concat(kennels
      .slice()
      .sort((a, b) => (a.kennel_name || '').localeCompare(b.kennel_name || ''))
      .map((k) => `<option value="${esc(k.id)}"${k.id === activeId ? ' selected' : ''}>${esc(k.kennel_name)}</option>`))
    .join('');

  host.innerHTML = `<select class="kennel-switcher${activeId ? ' scoped' : ''}"
      aria-label="Active kennel"
      title="Which kennel the lists, hubs, and reports are showing">${options}</select>`;
  host.querySelector('select').addEventListener('change', (e) => applyScope(e.target.value || null));
}

// --- The "scoped to one kennel" chip (§7) ----------------------------------

// Filled in asynchronously (it needs the kennel's name) into an element the
// caller has already placed in its toolbar. A no-op under "All kennels" and in
// Lite, so an unscoped toolbar renders exactly as it always did.
export async function mountScopeChip(el) {
  if (!el || !isScoped()) return;
  const kennel = await getActiveKennel();
  if (!kennel) return; // stale id, already cleared by getActiveKennel()
  el.innerHTML = `<span class="scope-chip" title="This view is filtered to one kennel">
      🏠 ${esc(kennel.kennel_name)} only
      <button type="button" class="scope-chip-clear" data-act="scope-all">Show all</button>
    </span>`;
  el.querySelector('[data-act="scope-all"]').addEventListener('click', () => applyScope(null));
}

// --- The out-of-scope notice on a detail page (§7) -------------------------

// `record` is the thing being viewed. `kind` is the human noun for the banner
// ('dog', 'litter', 'sale', …). `transparent` marks a record that belongs to no
// kennel of yours — an external/leased dog — which is in scope everywhere and so
// never gets a notice.
//
// Renders nothing at all in the common case; the host stays empty.
export async function renderScopeNotice(host, record, { kind = 'record', transparent = false } = {}) {
  if (!host) return;
  host.innerHTML = '';
  if (!record || !isScoped()) return;
  if (inScope(record, { transparent })) return;

  const [kennels, active] = await Promise.all([ownKennels(), getActiveKennel()]);
  const owner = kennels.find((k) => k.id === record.kennel_id) || null;
  const where = owner
    ? `belongs to <strong>${esc(owner.kennel_name)}</strong>`
    : 'belongs to another kennel';
  const viewing = active ? ` You are viewing <strong>${esc(active.kennel_name)}</strong>.` : '';
  host.innerHTML = `<div class="scope-notice">
      <div>This ${esc(kind)} ${where}.${viewing}</div>
      <div class="pill-row" style="margin-top:8px;">
        ${owner ? `<button type="button" class="btn btn-sm" data-act="scope-to">Switch to ${esc(owner.kennel_name)}</button>` : ''}
        <button type="button" class="btn btn-sm" data-act="scope-all">Show all kennels</button>
      </div>
    </div>`;
  const to = host.querySelector('[data-act="scope-to"]');
  if (to) to.addEventListener('click', () => applyScope(owner.id));
  host.querySelector('[data-act="scope-all"]').addEventListener('click', () => applyScope(null));
}

// The dog flavor of the notice: a dog you don't own is scope-transparent, so it
// is in scope under every kennel and must never carry a "belongs elsewhere"
// banner (spec §3.1a).
export function renderDogScopeNotice(host, dog) {
  return renderScopeNotice(host, dog, { kind: 'dog', transparent: !isOwnedByUser(dog) });
}
