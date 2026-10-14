// guidedShareUI.js — the guided "Record a new litter" flow's last step: "Want to
// tell people about the new pups?", shown only AFTER she has approved and saved
// the litter (assets/guidedLitterUI.js). Two ways, each reusing what the app
// already sends, so nothing new goes out:
//   - Tell my waitlist: the litter page's own "It's almost your turn" / "a
//     litter you match was born" notice (waitlistPicksPanel.openLitterWaitlistNotice).
//     It drafts; she reviews and sends.
//   - Share the available pups: the Companion "prospective family" link
//     (assets/companionLink.js — the console's own builder, which shows only
//     Available pups and their prices), one family at a time. Each Email / Text
//     is a real anchor she taps herself, as the console requires.
// It never opens picks: offers stay hers to make on the litter page.
//
// Pro-only (PRO_ONLY_STANDALONE): guidedLitterUI imports it only when this
// edition has the waitlist or Companion.
import { contactRepo } from '../data/contactRepo.js';
import { editionFlags } from '../data/editionConfig.js';
import { esc } from './ui.js';

// Families who get the "prospective" Companion page: the console's own rule.
const isProspective = (c) => !c.is_archived && c.waitlist_status === 'active';

// onDone(reply): `reply` is her answer to leave in the chat (null: none).
export async function renderShareStep({ mount, foot, litter, pups, onDone }) {
  const available = pups.filter((p) => p.disposition === 'available');
  const families = editionFlags.companion ? (await contactRepo.getAll({ includeArchived: false })).filter(isProspective) : [];
  const canTell = Boolean(editionFlags.waitlist);
  const canShare = Boolean(editionFlags.companion) && families.length > 0;
  if (!canTell && !canShare) { onDone(null); return; }

  const menu = () => {
    mount.innerHTML = `<p class="gl-lead">${available.length} ${available.length === 1 ? 'puppy is' : 'puppies are'} marked Available. Nothing is sent until you tap send yourself.</p>
      <div class="gl-tiles">
        ${canTell ? `<button type="button" class="gl-tile" data-share="tell"><span class="gl-tile-label">📣 Tell my waitlist they were born</span><span class="gl-tile-sub">Opens the message for the families on your list, to read over and send</span></button>` : ''}
        ${canShare ? `<button type="button" class="gl-tile" data-share="share"><span class="gl-tile-label">📱 Share the available pups</span><span class="gl-tile-sub">Send ${families.length} ${families.length === 1 ? 'family' : 'families'} a page with the pups and prices, one at a time</span></button>` : ''}
        <button type="button" class="gl-tile" data-share="later"><span class="gl-tile-label">Not now</span><span class="gl-tile-sub">You can do both later from the litter's page and Sharing</span></button>
      </div>`;
    foot.innerHTML = '';
    mount.querySelector('[data-share="tell"]')?.addEventListener('click', async () => {
      const { openLitterWaitlistNotice } = await import('./waitlistPicksPanel.js');
      await openLitterWaitlistNotice(litter);
      foot.innerHTML = '<span></span><button type="button" class="btn btn-primary gl-next" data-act="finish">I\'m done →</button>';
      foot.querySelector('[data-act="finish"]').addEventListener('click', () => onDone('I\'m done'));
    });
    mount.querySelector('[data-share="share"]')?.addEventListener('click', () => shareOneByOne(0));
    mount.querySelector('[data-share="later"]').addEventListener('click', () => onDone('Not now'));
  };

  // One family per screen: Email / Text / Skip.
  const shareOneByOne = async (i) => {
    if (i >= families.length) {
      mount.innerHTML = `<p class="gl-lead">That's everyone on your list.</p>`;
      foot.innerHTML = '<button type="button" class="btn gl-back" data-act="menu">← Back</button><button type="button" class="btn btn-primary gl-next" data-act="finish">Finish →</button>';
      foot.querySelector('[data-act="menu"]').addEventListener('click', menu);
      foot.querySelector('[data-act="finish"]').addEventListener('click', () => onDone('Finished sharing'));
      return;
    }
    const contact = families[i];
    mount.innerHTML = '<p class="muted">Getting the page ready…</p>';
    let anchors = '';
    try {
      const { buildLinkArtifacts, sendHrefs } = await import('./companionLink.js');
      const artifacts = await buildLinkArtifacts('prospective', contact);
      const h = sendHrefs(artifacts, contact);
      anchors = [
        !h.overEmail && contact.email ? `<a class="btn btn-primary gl-big" href="${esc(h.mailto)}" data-sent="1">✉️ Email ${esc(contact.name)}</a>` : '',
        !h.overSms && contact.phone ? `<a class="btn gl-big" href="${esc(h.sms)}" data-sent="1">💬 Text ${esc(contact.name)}</a>` : ''
      ].filter(Boolean).join('');
      if (anchors && h.overSms && contact.phone) anchors += '<p class="field-hint" style="flex-basis:100%;margin:0;">This page is too long for a text message, so it goes by email.</p>';
      if (!anchors) anchors = `<p class="muted">${contact.email || contact.phone ? 'This page is too big to send by text. ' : ''}No ${contact.email ? 'phone' : 'email or phone'} on file for ${esc(contact.name)}. Add one on their contact page to send it.</p>`;
    } catch (e) {
      anchors = `<div class="inline-error">Couldn't build the page: ${esc(e.message || String(e))}</div>`;
    }
    mount.innerHTML = `<p class="gl-progress-inline">Family ${i + 1} of ${families.length}</p>
      <h3 class="gl-family">${esc(contact.name)}</h3>
      <p class="faint">${esc([contact.email, contact.phone].filter(Boolean).join(' · '))}</p>
      <div class="pill-row gl-send-row">${anchors}</div>
      <p class="field-hint">Your email or messages app opens with the message ready. Send it there, then come back.</p>`;
    foot.innerHTML = '<button type="button" class="btn gl-back" data-act="menu">← Back</button><button type="button" class="btn gl-next" data-act="skip">Next family →</button>';
    mount.querySelectorAll('[data-sent]').forEach((a) => a.addEventListener('click', () => {
      const skip = foot.querySelector('[data-act="skip"]');
      skip.classList.add('btn-primary');
    }));
    foot.querySelector('[data-act="menu"]').addEventListener('click', menu);
    foot.querySelector('[data-act="skip"]').addEventListener('click', () => shareOneByOne(i + 1));
  };

  menu();
}
