// app.js — shared shell bootstrap imported by every page. Injects the nav and,
// on first run, asks the browser to keep this origin's data durable.
//
// Imports here resolve relative to THIS module's URL (the app root), so they are
// correct no matter which page (root or /pages/) pulls app.js in.
import { renderNav } from './nav.js';
import {
  db, requestPersistentStorage, isDbUpgradeBlocked,
  DB_BLOCKED_EVENT, DB_READY_EVENT, DB_VERSIONCHANGE_EVENT
} from './data/db.js';
import { wasPersistRequested, markPersistRequested, getGuidedLitterDraft, getGuidedDogsDraft, getGuidedPeopleDraft, getGuidedFormDraft, getCloudSession, getWebsiteStripCache, getWebsiteLaterFor, getCachedCloudNotices, CLOUD_DATA_CHANGED_EVENT } from './data/settings.js';
import { renderAssistButton } from './assets/kelsChat.js';
import { expenseRepo } from './data/expenseRepo.js';
import { studServiceRepo } from './data/studServiceRepo.js';
import { renderSampleBanner, autoClearTourSeed, showTourCleanupNotice } from './assets/sampleDataUI.js';
import { maybeShowKennelSetupPrompt, renderKennelBanner } from './assets/kennelSetupUI.js';
import { renderWizardMenuEntry, runWizardStep } from './assets/wizardUI.js';
import { runFirstRunOnboarding, maybeMeetKels } from './assets/onboardingUI.js';
import { isDemo, isReadOnly, withSeedAllowed } from './data/demoMode.js';
import { seedSampleData } from './data/editionTour.js';
import { isLicenseGated, ensureLicensed } from './assets/licenseGate.js';
import { isCloudAvailable, isUsingTestServer } from './data/cloud/cloudConfig.js';
import { editionFlags } from './data/editionConfig.js';

// Kels's floating "Ask Kels" button (assets/kelsChat.js), with a dot while a
// guided task is waiting to be finished.
function renderKelsButton() {
  const pending = [getGuidedLitterDraft(), getGuidedDogsDraft(), editionFlags.contactsSection ? getGuidedPeopleDraft() : null,
    editionFlags.waitlist ? getGuidedFormDraft() : null].some((d) => d && !d.done);
  renderAssistButton({ pending });
}

// The shell's watchers (assets/appShell.js), loaded lazily.
const appShell = () => import('./assets/appShell.js');
const moduleFailed = (e) => { appShell().then((m) => m.moduleFailed(e)).catch(() => {}); };

// Durable storage, once there's something to keep; not in the Demo or the tour.
function firstRunPersistence() {
  if (isReadOnly()) return;
  appShell().then((m) => m.askPersistenceWhenKept({
    asked: wasPersistRequested, markAsked: markPersistRequested, request: requestPersistentStorage,
    hasRecords: async () => (await db.kennels.count()) > 0 || (await db.dogs.count()) > 0,
    eventName: CLOUD_DATA_CHANGED_EVENT
  })).catch(() => {});
}

// Registered against this module's own URL (not the page's) so it resolves to
// the same sw.js/scope from both index.html and /pages/*.html. A service
// worker with a fetch handler is required by Chrome/Android before it will
// offer to install the app, and it's what makes offline-after-first-load work.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const swUrl = new URL('./sw.js', import.meta.url);
  navigator.serviceWorker.register(swUrl, { scope: new URL('./', import.meta.url) });
  appShell().then((m) => m.watchForUpdates()).catch(() => {});
}

// First run shows the onboarding Welcome card (Start my kennel → New Kennel, Take
// the tour, or I already use KennelOS → sign in and restore). On a non-fresh load it does nothing and returns false, so
// we fall through to the MANDATORY kennel-setup gate, which fires on every load
// until an own kennel exists (shouldRequireKennelSetup gates it — Multi-Kennel
// Scope Spec §3.2). That fall-through is what makes the gate inescapable: a user
// who reloads to dismiss the modal lands right back here.
async function firstRunFlow() {
  const handled = await runFirstRunOnboarding();
  if (handled) return;
  await maybeShowKennelSetupPrompt();
  // An old tour seed was just cleared: what changed in her own records, once.
  await showTourCleanupNotice();
  // Just past the first-run kennel setup: introduce Kels, once.
  await maybeMeetKels();
}

// --- Demo edition (editions plan §"The Demo edition") ----------------------
// Auto-seed on load: the demo is a seeded, read-only showcase. Seed only when the
// DB is empty — every write is blocked in demo (demoMode.js), so once seeded it
// stays pristine across visits without re-wiping. On a genuinely empty load we
// seed (through the same repo layer real data uses, via the seed window) and then
// reload so the page scripts render against the seeded DB instead of an empty
// first paint. A sessionStorage guard caps this at one seed+reload per session,
// so a persistence hiccup can never spin a reload loop. Returns true if a reload
// is in flight (boot then skips rendering this doomed paint).
async function ensureDemoSeed() {
  const KEY = 'kennelos-demo-seed-attempted';
  if (sessionStorage.getItem(KEY)) return false;
  if ((await db.dogs.count()) > 0) return false; // already seeded from a prior visit
  sessionStorage.setItem(KEY, '1');
  await withSeedAllowed(() => seedSampleData());
  location.reload();
  return true;
}

// A persistent "this is a read-only demo" strip at the top of every page, so a
// blocked write is expected, not a surprise. Rendered only in the demo build.
function renderDemoBanner() {
  const bar = document.createElement('div');
  bar.className = 'demo-banner';
  bar.setAttribute('role', 'status');
  bar.innerHTML = "🔒 <strong>Demo</strong> — a read-only tour with sample data. Changes aren't saved.";
  document.body.insertBefore(bar, document.body.firstChild);
}

// While this browser backs up to the staging server from a real origin (the
// ?cloud=staging switch in data/cloud/cloudConfig.js), every page says so, so a
// test sign-in is never mistaken for the real service. Rendered here rather
// than in cloudBackupUI so it shows even while a first-run modal is open.
function renderCloudTestBanner() {
  if (!isUsingTestServer()) return;
  const bar = document.createElement('div');
  bar.className = 'cloud-notice cloud-notice-warning';
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<strong>Cloud backup: TEST SERVER.</strong> Backups from this browser go to the staging server and may be wiped. <a href="?cloud=off">Turn off</a>';
  document.body.insertBefore(bar, document.body.firstChild);
}

// Her KennelPort website's changes not sent yet (assets/websiteBanner.js, Pro):
// the strip under the nav is drawn here from the last compare, so it is in the
// first paint instead of arriving 1.5 s later and pushing the page down (Load
// Performance plan D7). websiteBanner.js (Pro-only, loaded right after) adopts
// this box, wires its buttons and compares again only when records changed.
const isTodayPage = () => /\/today\.html$|\/pages\/$/.test(globalThis.location?.pathname || '');

function drawCachedWebsiteStrip() {
  const cache = getWebsiteStripCache();
  if (!cache?.html || !cache.waiting?.length || getWebsiteLaterFor() === cache.signature) return;
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  const box = document.createElement('div');
  box.className = 'website-banner website-banner-strip inline-notice';
  box.setAttribute('role', 'status');
  box.innerHTML = cache.html; // built by websiteBanner.waitingHtml, every value escaped there
  nav.insertAdjacentElement('afterend', box);
}

// Cloud service notices this session already fetched, drawn at boot (cloudBackupUI's
// bootCloud skips any already on the page). The first page of a session still
// waits for its check-in.
function drawCachedCloudNotices() {
  if (!isCloudAvailable() || !getCloudSession()) return;
  const notices = getCachedCloudNotices();
  if (!notices?.length) return;
  const seen = new Set();
  for (const n of notices) {
    if (!n || n.id == null || seen.has(n.id)) continue;
    seen.add(n.id);
    const bar = document.createElement('div');
    bar.className = `cloud-notice cloud-notice-${['info', 'warning', 'shutdown'].includes(n.level) ? n.level : 'info'}`;
    bar.dataset.noticeId = String(n.id);
    bar.setAttribute('role', 'status');
    const strong = document.createElement('strong');
    strong.textContent = n.level === 'shutdown' ? 'Cloud backup is ending.' : 'KennelOS cloud:';
    bar.append(strong, ` ${n.message || ''}`);
    document.body.insertBefore(bar, document.body.firstChild);
  }
}

// Database upgrade hand-off (data/db.js): while another open copy of KennelOS
// holds the older database, this page's records can't load, so say why and what
// to do instead of leaving "Loading…". It clears itself once the upgrade goes
// through. And a copy closed by another's upgrade asks for a reload. Wired at
// module load, not in boot(), so the license gate's wait can't hide it.
function renderDbNotice(id, html) {
  if (document.getElementById(id)) return;
  const bar = document.createElement('div');
  bar.id = id;
  bar.className = 'cloud-notice cloud-notice-warning';
  bar.setAttribute('role', 'alert');
  bar.innerHTML = html;
  document.body.insertBefore(bar, document.body.firstChild);
}

function showDbBlockedNotice() {
  renderDbNotice('db-blocked-notice', '<strong>KennelOS is updating its storage.</strong> Close every other KennelOS tab or window on this device, including the installed app in your recent apps; this page carries on by itself once they are closed.');
}

window.addEventListener(DB_BLOCKED_EVENT, showDbBlockedNotice);
if (isDbUpgradeBlocked()) showDbBlockedNotice();
window.addEventListener(DB_READY_EVENT, () => document.getElementById('db-blocked-notice')?.remove());
window.addEventListener(DB_VERSIONCHANGE_EVENT, () => {
  renderDbNotice('db-closed-notice', '<strong>KennelOS was updated in another tab.</strong> <a href="">Reload this page</a> to keep working; anything not yet saved on this page can no longer be saved.');
});

// Support's helper device (docs/KennelOS_Assisted_Setup_Plan.md): signed in to a
// user's account through an assist link. It runs on her Pro, not a license here.
const isHelperDevice = () => getCloudSession()?.role === 'helper';
const assistUI = () => import('./assets/cloudAssistUI.js');

// The license gate skips only for a helper the server confirmed (review K05-11);
// anything else fails closed to the ordinary gate.
async function helperSkipsGate() {
  if (!isCloudAvailable() || !isHelperDevice()) return false;
  try {
    return await (await import('./data/cloud/cloudAssist.js')).helperSkipsLicenseGate();
  } catch (e) {
    console.warn('KennelOS: helper check', e);
    return false;
  }
}

async function boot() {
  // The nav first, in every edition and before any wait (Load Performance plan
  // Phase 1): its space is reserved in app.css, so drawing it moves nothing, and
  // a license wall is an overlay over it. The kennel name and switcher come from
  // their stored copies (kennelSetupUI / kennelScopeUI) and are corrected after
  // their reads.
  renderNav();
  if (!isDemo()) {
    renderKennelBanner();
    if (editionFlags.websiteLink && !isTodayPage()) drawCachedWebsiteStrip();
    drawCachedCloudNotices();
  }

  // An assist link (?assist=…) opened on support's device: sign in as her helper
  // before anything else, since it decides the license gate and first run below.
  if (isCloudAvailable() && new URLSearchParams(globalThis.location?.search || '').has('assist')) {
    try { await (await assistUI()).openAssistLink(); } catch (e) { console.warn('KennelOS: assist link', e); }
  }
  // Lost device (Cloud Phase 1 plan §2.5): a signed-in device checks in so an
  // erase its owner sent from another device reaches it. First, and not
  // awaited: a Pro device whose license was already released walls below, and
  // must still hear the erase. Only with a server; nothing loads otherwise.
  if (isCloudAvailable()) {
    import('./data/cloud/cloudDevices.js').then((m) => m.bootDeviceCheck()).catch((e) => console.warn('KennelOS: device check', e));
  }

  // Pro license gate (editions plan §Licensing): make sure this device has an
  // active subscription. The stored verdict decides at once and the store is
  // asked in the background, at most once a session and every 6 hours (D6 of the
  // Load Performance plan; assets/licenseGate.js). A painted wall (no key yet, or
  // lapsed past the grace window) returns false and boot stops. Active only in
  // the Pro edition (isLicenseGated) — Lite is free and Demo is a public
  // showcase, so this is a no-op there.
  if (isLicenseGated() && !(await helperSkipsGate())) {
    let licensed = false;
    try {
      licensed = await ensureLicensed();
    } catch (e) {
      // A gate failure must not silently unlock Pro — but it also shouldn't brick
      // the app on an unexpected error. Log and fall through to render; the next
      // online load re-evaluates. (The gate is a soft check by design.)
      console.warn('KennelOS: license gate error', e);
      licensed = true;
    }
    if (!licensed) return;
  }

  // Demo: seed-then-(maybe)-reload, then show the full app read-only. It
  // deliberately skips the first-run / kennel-setup / sample-data UI — the demo
  // is always seeded and never prompts the visitor to set up.
  if (isDemo()) {
    let reloading = false;
    try { reloading = await ensureDemoSeed(); } catch (e) { console.warn('KennelOS: demo seed failed', e); }
    if (reloading) return;
    registerServiceWorker();
    renderDemoBanner();
    renderKelsButton();
    return;
  }

  registerServiceWorker();
  // The guided tour's sample data lives only while the tour is active, in the
  // browsing session that seeded it (Load Performance plan D2): any other load
  // clears it and reloads, before the rest of the app starts on it. Like the
  // Demo seed above. Support's helper device never has a tour.
  if (!isHelperDevice()) {
    let clearing = false;
    try { clearing = await autoClearTourSeed(); } catch (e) { console.warn('KennelOS: tour seed', e); }
    if (clearing) return;
  }
  renderCloudTestBanner();
  // Support's device: the "Helping …" bar, and its one-time setup (the vault and
  // sync) before first run, so a help visit opens on her records, not a welcome.
  if (isCloudAvailable() && isHelperDevice()) {
    try {
      const ui = await assistUI();
      ui.renderHelperBar();
      await ui.bootstrapHelper();
    } catch (e) { console.warn('KennelOS: assist', e); }
  }
  renderKelsButton();
  firstRunPersistence();
  // One-time fold of legacy Event.cost values into the Financials ledger. Guarded
  // by a settings flag inside the repo, so it's a cheap no-op after the first run.
  expenseRepo.migrateEventCosts().catch(() => { /* non-fatal */ });
  // Stud trips → boarding events, and pre-"who travels" directions (studServiceRepo).
  studServiceRepo.migrateStudTrips().catch(() => { /* non-fatal */ });
  renderSampleBanner();
  renderWizardMenuEntry();
  runWizardStep();
  // Cloud backup (Cloud Phase 1 plan §2): the background scheduler, service
  // notices, and the one-time post-setup offer. After the first-run flow, so the
  // offer never lands on top of it. Only with a server, and only then is any
  // cloud UI loaded (an edition with cloudUrl null never imports it).
  // Her own Stripe links (Integrations plan §4): her device asks Stripe whether an
  // open one-use link was paid, at most every 15 minutes. Pro (Accounts) only.
  if (editionFlags.accounts) {
    import('./data/stripeLinks.js').then((m) => m.bootStripeCheck()).catch(moduleFailed);
    // Connect Jotform is retired (Integrations plan D27): any Jotform API key this
    // device still holds is deleted.
    import('./data/jotformKeyStore.js').then((m) => m.forgetJotformKeys()).catch(moduleFailed);
  }
  // Her puppy portal on KennelPort (End-State guide §35.1): the family feed goes by
  // itself from a device linked to a website whose portal is on. Nothing loads
  // a request without a link.
  if (editionFlags.websiteLink && !isReadOnly()) {
    import('./data/portalFeedSync.js').then((m) => m.startPortalFeed()).catch(moduleFailed);
    // Changes her website shows, not sent yet: a strip under the nav with Send now
    // (Today shows it as a card of its own, today.js). Drawn above from the last
    // compare; loaded now so its buttons work, and it compares again only when
    // records changed (D7).
    if (!isTodayPage()) {
      import('./assets/websiteBanner.js').then((m) => m.startWebsiteBanner()).catch(moduleFailed);
    }
  }
  // Her waitlist closed dates more than 7 days past drop off by themselves. And a
  // family's turn left with no pup in it (she kept the pup, it went on Health hold,
  // died or was sold) ends shortly after the change, never as a pass; the page
  // tells her whose and who's next (waitlistActions.watchEmptiedTurns).
  // Not while the app is read-only (the Demo, the tour): both write.
  if (editionFlags.waitlist && !isReadOnly()) {
    import('./data/waitlistActions.js').then((m) => {
      m.tidyClosedDates().catch(() => {});
      m.watchEmptiedTurns({
        busy: () => Boolean(document.querySelector('.modal-overlay')),
        onEnded: (r) => import('./assets/waitlistUI.js').then((ui) => ui.reportEmptiedTurns(r))
      });
    }).catch(moduleFailed);
  }
  firstRunFlow().finally(() => {
    if (!isCloudAvailable()) return;
    import('./assets/cloudBackupUI.js').then((m) => m.bootCloud()).catch((e) => console.warn('KennelOS: cloud backup', e));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
