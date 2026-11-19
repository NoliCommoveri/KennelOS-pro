// appShell.js — two watchers app.js starts on every page (Review Remainder plan §H).
//
// 1. A new version of KennelOS reaching a page that's already open (review K13-10,
//    decision R5).
//
// sw.js installs a new version with skipWaiting() + clients.claim(), so it takes
// over open pages at once, and their next lazy import() can load a module from the
// new version that doesn't fit the old page. So when the controlling worker
// changes:
//   - the page reloads by itself when nothing is open or typed in (no modal, no
//     input since the page loaded): every page loads fresh, so a reload is the cure;
//   - otherwise a strip says "KennelOS was updated." with Reload, and nothing is
//     reloaded over unsaved work.
// A lazy import() that fails (moduleFailed) shows the same strip, instead of the
// panel it would have drawn silently not appearing. app.js loads this module
// lazily, after first paint (Load Performance plan budgets).
//
// The first install claiming a page that had no worker is the same version, not
// an update, and is ignored.

const NOTICE_ID = 'app-update-notice';

let typed = false;
let started = false;

// Something on this page may hold unsaved work: an open modal, or any typing.
export function pageIsBusy(doc = globalThis.document) {
  return typed || Boolean(doc?.querySelector?.('.modal-overlay'));
}

export function showUpdateStrip(doc = globalThis.document, win = globalThis) {
  if (!doc?.body || doc.getElementById(NOTICE_ID)) return;
  const bar = doc.createElement('div');
  bar.id = NOTICE_ID;
  bar.className = 'cloud-notice cloud-notice-info';
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<strong>KennelOS was updated.</strong> Save anything you’re working on, then <button type="button" class="btn btn-sm" style="margin-left:6px;">Reload</button>';
  bar.querySelector('button').addEventListener('click', () => win.location.reload());
  doc.body.insertBefore(bar, doc.body.firstChild);
}

// → 'reload' | 'notice' | 'ignore': what a controllerchange does on this page.
export function updateReaction({ hadController, busy }) {
  if (!hadController) return 'ignore';
  return busy ? 'notice' : 'reload';
}

// Wired once per page, from app.js's registerServiceWorker().
export function watchForUpdates(win = globalThis) {
  const sw = win.navigator?.serviceWorker;
  if (started || !sw?.addEventListener) return;
  started = true;
  let hadController = Boolean(sw.controller);
  win.document?.addEventListener?.('input', () => { typed = true; }, true);
  sw.addEventListener('controllerchange', () => {
    const what = updateReaction({ hadController, busy: pageIsBusy(win.document) });
    hadController = true;
    if (what === 'reload') win.location.reload();
    else if (what === 'notice') showUpdateStrip(win.document, win);
  });
}

// For a lazy `import()` whose caller swallows errors: a module that wouldn't load
// (a SyntaxError for a missing export, or a failed module fetch) shows the strip.
// Any other error, and any error while offline, when a reload can't help, shows
// nothing.
//   import('./x.js').then((m) => m.start()).catch((e) => shell().then((m) => m.moduleFailed(e)))
export function isModuleError(e) {
  return e instanceof SyntaxError || /dynamically imported module|module script|importing a module/i.test(String(e?.message || ''));
}

export function moduleFailed(e, win = globalThis) {
  if (isModuleError(e) && win.navigator?.onLine !== false) showUpdateStrip(win.document, win);
}

// 2. Durable storage, asked for once when there's something to keep (review
//    K13-13): at once when this load already holds records (a restore or a sync
//    join on an earlier load), else on the first data change (markDataChanged's
//    event). Asked on a first visit instead, a browser usually refuses a brand-new
//    site, or prompts over the welcome card. Kels's account health asks again while
//    the browser still says no.
//      asked()       settings.wasPersistRequested
//      markAsked()   settings.markPersistRequested
//      request()     db.requestPersistentStorage
//      hasRecords()  → true when this device holds any of her records (may throw:
//                    the database isn't open, and the next load asks)
export async function askPersistenceWhenKept({ asked, markAsked, request, hasRecords, eventName, win = globalThis }) {
  if (asked()) return;
  const ask = () => {
    if (asked()) return;
    markAsked();
    request();
  };
  try {
    if (await hasRecords()) { ask(); return; }
  } catch { return; }
  win.addEventListener(eventName, ask, { once: true });
}

// Tests only.
export function _resetAppShell() { typed = false; started = false; }
