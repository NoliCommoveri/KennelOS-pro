// waitlist-publish.js — publishing one kennel's waitlist (Waitlist Spec §15.3; W2
// Plan §9; End-State guide §29), reached from the Waitlist page's Manage menu.
// Two ways, one page: the Online list (the waitlist online, only where it's
// offered: its card is waitlistOnlineUI.js, which used to live on the Kennel page)
// and, under it, the list as text to copy (allow-listed fields only, paused
// families and families between turns left out). Pro-only page (proPages.js).
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { waitlistConfig, entryName, publicList, publicListText, placeHidden, PUBLIC_INTRO_DEFAULT, PUBLIC_INTRO_MAX } from '../data/waitlistRules.js';
import { editionFlags } from '../data/editionConfig.js';
import { isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import { esc, fmtDate, param, todayYMD } from '../assets/ui.js';
import { resolveWaitlistKennel, mountKennelPicker } from '../assets/waitlistUI.js';

const els = {
  title: document.getElementById('pub-title'),
  back: document.getElementById('back-link'),
  picker: document.getElementById('pub-kennel-picker'),
  online: document.getElementById('pub-online'),
  intro: document.getElementById('pub-intro'),
  text: document.getElementById('pub-text'),
  error: document.getElementById('page-error')
};
const showError = (msg) => { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; };

// The waitlist online: only where it's offered (Pro, cloud available, its release
// switch or staging); its UI is imported only then.
function mountOnline(kennel) {
  if (!editionFlags.waitlist || !isWaitlistOnlineOffered()) return;
  els.online.hidden = false;
  import('../assets/waitlistOnlineUI.js')
    .then((m) => m.mountWaitlistOnline(els.online, kennel, {
      onSaved: async () => { mountOnline(await kennelRepo.getById(kennel.id)); await renderText(kennel); }
    }))
    .catch((err) => { els.online.innerHTML = `<p class="field-hint">The online list couldn't load: ${esc(err.message || String(err))}</p>`; });
}

// The message under the heading of her public list page (waitlistRules
// publicIntroText): her own words, or the default. [Kennel Name] is filled in when
// it's shown. Saved on the kennel's waitlist_config, so it publishes with the list.
function mountIntro(kennel) {
  if (!editionFlags.waitlist || !isWaitlistOnlineOffered()) return;
  const saved = waitlistConfig(kennel).public_intro_text || '';
  els.intro.hidden = false;
  els.intro.innerHTML = `
    <h2 style="margin-top:0;">Message on your public list</h2>
    <p class="field-hint">Shown under the heading of your online list page. Write [Kennel Name] where you want your kennel's name.</p>
    <textarea id="pub-intro-text" maxlength="${PUBLIC_INTRO_MAX}" style="width:100%;min-height:150px;font-family:inherit;">${esc(saved || PUBLIC_INTRO_DEFAULT)}</textarea>
    <div class="form-actions">
      <button class="btn btn-primary btn-sm" id="pub-intro-save">Save</button>
      <button class="btn btn-sm" id="pub-intro-reset">Use the default</button>
      <span class="field-hint" id="pub-intro-note" role="status"></span>
    </div>`;
  const note = (t) => { els.intro.querySelector('#pub-intro-note').textContent = t; };
  const save = async (text) => {
    const fresh = await kennelRepo.getById(kennel.id);
    // The default is stored as blank, so a later change to the default reaches her.
    const value = text.trim() === PUBLIC_INTRO_DEFAULT ? '' : text.trim();
    await kennelRepo.update(kennel.id, { waitlist_config: { ...(fresh.waitlist_config || {}), public_intro_text: value } });
    note('Saved. Your online list updates by itself shortly.');
  };
  els.intro.querySelector('#pub-intro-save').addEventListener('click', () => save(els.intro.querySelector('#pub-intro-text').value).catch((e) => showError(e.message || String(e))));
  els.intro.querySelector('#pub-intro-reset').addEventListener('click', () => {
    els.intro.querySelector('#pub-intro-text').value = PUBLIC_INTRO_DEFAULT;
    save(PUBLIC_INTRO_DEFAULT).catch((e) => showError(e.message || String(e)));
  });
}

// The public list as text (Spec §15.3), the same families and fields as online.
async function renderText(kennel) {
  const [entries, offers, programs, contacts, litters, dogs, sales] = await Promise.all([
    waitlistEntryRepo.getByKennel(kennel.id),
    waitlistOfferRepo.getByKennel(kennel.id),
    waitlistProgramRepo.getMapForKennel(kennel.id),
    contactRepo.getAll({ includeArchived: true }),
    litterRepo.getAll(),
    dogRepo.getAll({ includeArchived: true }),
    saleRepo.getAll({ includeArchived: true })
  ]);
  const today = todayYMD();
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const rows = publicList(entries, kennel.id, programs, {
    today, config: waitlistConfig(kennel), nameOf: (e) => entryName(e, contactsById.get(e.contact_id)),
    // Same as online: a family in their turn, or after passing until those litters close.
    hidden: (e) => Boolean(placeHidden(e, offers, litters, dogs, sales))
  });
  const text = publicListText(rows, { kennelName: kennel.kennel_name, today, fmtDate });
  els.text.innerHTML = `
    <div class="row-between" style="gap:8px;flex-wrap:wrap;">
      <h2 style="margin:0;">Copy the list as text</h2>
      <span class="pill-row"><span class="field-hint" id="pub-copied"></span><button class="btn btn-primary btn-sm" id="pub-copy">Copy</button></span>
    </div>
    <p class="field-hint">Paste this on Facebook or your website. It shows first names with a last initial, sex preference and the date each family was added. Contact details and programs are left out, and so are paused families and families between turns (holding a turn, or after passing until that litter closes). It's a snapshot: copy it again after the list changes.</p>
    <textarea id="pub-text-body" readonly style="width:100%;min-height:220px;font-family:inherit;">${esc(text)}</textarea>`;
  els.text.querySelector('#pub-copy').addEventListener('click', async () => {
    const ta = els.text.querySelector('#pub-text-body');
    const note = els.text.querySelector('#pub-copied');
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = 'Copied.';
    } catch {
      ta.select();
      note.textContent = document.execCommand('copy') ? 'Copied.' : 'Copying isn\'t allowed here. Select the text and copy it yourself.';
    }
  });
}

async function main() {
  const { kennel, own } = await resolveWaitlistKennel(param('kennel'));
  if (!kennel) {
    els.text.innerHTML = '<div class="empty-state">Set up your kennel first — each of your kennels keeps its own waitlist.</div>';
    return;
  }
  mountKennelPicker(els.picker, { kennel, own });
  els.back.href = `waitlist.html?kennel=${encodeURIComponent(kennel.id)}`;
  if (own.length > 1) els.title.textContent = `Publish ${kennel.kennel_name}'s list`;
  mountOnline(kennel);
  mountIntro(kennel);
  await renderText(kennel);
}

main().catch((e) => showError(e.message || String(e)));
