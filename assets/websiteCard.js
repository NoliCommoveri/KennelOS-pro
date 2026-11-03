// websiteCard.js — Settings' "Your website" card (KennelPort plan 5.2, 5.5;
// End-State guide §35): Connect website with the code from KennelPort Site
// Manager, Update website, what was sent last, and Disconnect this device. One
// link per own kennel; with several, she picks which (the active one first).
// Settings loads this only when websiteLinkOffered() (Pro with a KennelPort
// address), so Lite and Demo never see it.
import { esc, fmtDate, confirmModal } from './ui.js';
import { ownKennels, getActiveKennelId } from '../data/kennelScope.js';
import { kennelRepo } from '../data/kennelRepo.js';
import {
  connectWebsite, disconnectWebsite, updateWebsite, getWebsiteLink, websiteSummary, KennelportError, LicenseLapsedError,
  pendingWebsiteOffer, useSiteAsKennelWebsite, keepKennelWebsite
} from '../data/kennelportLink.js';
import { SiteExportError } from '../data/siteExport.js';

// A name for this device, to tell it apart in KennelPort ("Her phone — last
// update 3 November"). She can change it before connecting.
export function guessDeviceLabel(ua = globalThis.navigator?.userAgent || '') {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows computer';
  return 'This browser';
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const errorText = (err) => (err instanceof KennelportError || err instanceof LicenseLapsedError || err instanceof SiteExportError ? err.message : `Something went wrong: ${err?.message || err}`);

// Update website as a step anyone can call (the card, Kels): sends, then says
// what happened in a line. → { ok, text }.
export async function pressUpdateWebsite(kennel) {
  try {
    const out = await updateWebsite(kennel);
    const filled = out.filled ? ` ${plural(out.filled, 'photos link')} filled in from your website.` : '';
    return { ok: true, text: `${out.summary?.text || 'Sent to your website.'}${filled}` };
  } catch (err) {
    return { ok: false, text: errorText(err), notLinked: err instanceof KennelportError && err.kind === 'not_linked' };
  }
}

export async function mountWebsiteCard(el) {
  if (!el) return;
  el.hidden = false;
  const kennels = (await ownKennels()).sort((a, b) => String(a.kennel_name || '').localeCompare(String(b.kennel_name || '')));
  if (!kennels.length) { el.remove(); return; }
  let kennelId = kennels.find((k) => k.id === getActiveKennelId())?.id || kennels[0].id;
  let note = null; // { ok, text } after a press

  async function render() {
    const kennel = await kennelRepo.getById(kennelId);
    const link = await getWebsiteLink(kennelId);
    const picker = kennels.length > 1
      ? `<div class="field" style="max-width:320px;margin-bottom:12px;"><label for="web-kennel">Kennel</label><select id="web-kennel">${kennels.map((k) => `<option value="${esc(k.id)}"${k.id === kennelId ? ' selected' : ''}>${esc(k.kennel_name || 'Kennel')}</option>`).join('')}</select></div>`
      : '';
    const shown = note ? `<div class="${note.ok ? 'inline-warn' : 'inline-error'}" style="${note.ok ? 'color:var(--accent-dark);background:var(--accent-soft);border-color:#bfe0cd;' : ''}">${esc(note.text)}</div>` : '';
    let body;
    if (!link) {
      body = `
        <p class="muted">Your KennelPort website can show the dogs, litters and puppies you mark <strong>Show on website</strong> here, so you type them only once. Nothing is sent until you press <strong>Update website</strong>.</p>
        <p class="muted">In KennelPort Site Manager, open <strong>Link KennelOS</strong> for a code, then type it here. Each device connects once.</p>
        <div class="form-grid" style="margin-bottom:12px;">
          <div class="field"><label for="web-code">Code</label><input id="web-code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-2345" maxlength="9"></div>
          <div class="field"><label for="web-device">This device</label><input id="web-device" maxlength="60" value="${esc(guessDeviceLabel())}"><span class="field-hint">How KennelPort lists it, so you can tell your devices apart.</span></div>
        </div>
        <button class="btn btn-primary" id="web-connect">Connect website</button>`;
    } else {
      const counts = await websiteSummary(kennel);
      const marked = [
        plural(counts.dogs, 'dog'), plural(counts.litters, 'litter'), plural(counts.pairings, 'pairing'), plural(counts.heats, 'planned heat'), plural(counts.products, 'recommended product')
      ].join(', ');
      const site = link.site || {};
      // Her kennel record still names her own website (an older homepage, say):
      // ask once per site address whether this one takes its place.
      const offer = await pendingWebsiteOffer(kennelId);
      const ask = offer ? `
        <div class="inline-warn" id="web-offer" style="margin-bottom:12px;">
          <p style="margin:0 0 8px;">Your kennel record's website is <a href="${esc(offer.current)}" target="_blank" rel="noopener noreferrer">${esc(offer.current)}</a>. Use your KennelPort website, <strong>${esc(offer.next)}</strong>, instead? It's the address your invoices, receipts and contract forms print.</p>
          <div class="pill-row">
            <button class="btn btn-primary" id="web-offer-use">Use ${esc(offer.next)}</button>
            <button class="btn" id="web-offer-keep">Keep mine</button>
          </div>
        </div>` : '';
      const last = link.last_sent_at ? `Last update ${fmtDate(link.last_sent_at.slice(0, 10))}: ${esc(link.last_summary?.text || 'sent')}` : 'Not updated from this device yet.';
      body = `
        ${ask}
        <p>Connected to <a href="${esc(site.website || '#')}" target="_blank" rel="noopener noreferrer">${esc(site.name || site.website || 'your website')}</a> on this device${link.device_label ? ` (“${esc(link.device_label)}”)` : ''}.</p>
        <p class="muted">Marked Show on website: ${esc(marked)}. ${site.kennelos_prices ? 'Your litter and extras prices go too (Use my KennelOS prices is on in KennelPort).' : 'Your prices stay here: Use my KennelOS prices is off in KennelPort.'}</p>
        <p class="muted">${last}</p>
        <p class="muted">What you send lands in your website's draft: check it in KennelPort Site Manager, then press Publish there.</p>
        <div class="pill-row">
          <button class="btn btn-primary" id="web-update">Update website</button>
          <button class="btn" id="web-disconnect">Disconnect this device…</button>
        </div>`;
    }
    el.innerHTML = `<h2 style="margin-top:0;">Your website</h2>${picker}${shown}${body}`;
    wire(kennel);
  }

  function wire(kennel) {
    el.querySelector('#web-kennel')?.addEventListener('change', (ev) => { kennelId = ev.target.value; note = null; render(); });
    el.querySelector('#web-connect')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      ev.target.textContent = 'Connecting…';
      try {
        const site = await connectWebsite(kennel, el.querySelector('#web-code').value, el.querySelector('#web-device').value.trim());
        note = { ok: true, text: `Connected to ${site.website}. Mark what goes with Show on website on each dog, pairing and litter, then press Update website.` };
      } catch (err) { note = { ok: false, text: errorText(err) }; }
      render();
    });
    el.querySelector('#web-update')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      ev.target.textContent = 'Sending…';
      note = await pressUpdateWebsite(kennel);
      render();
    });
    el.querySelector('#web-offer-use')?.addEventListener('click', async () => {
      try {
        await useSiteAsKennelWebsite(kennelId);
        note = { ok: true, text: 'Your kennel record now has your KennelPort website.' };
      } catch (err) { note = { ok: false, text: errorText(err) }; }
      render();
    });
    el.querySelector('#web-offer-keep')?.addEventListener('click', async () => {
      await keepKennelWebsite(kennelId);
      note = { ok: true, text: 'Kept your own website on the kennel record. You can change it any time on the Kennels page.' };
      render();
    });
    el.querySelector('#web-disconnect')?.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Disconnect this device?',
        message: 'This device stops sending to your website. Your website keeps what it has, and your other devices stay connected. To edit everything in KennelPort, use Unlink KennelOS in KennelPort Site Manager.',
        confirmLabel: 'Disconnect'
      });
      if (!ok) return;
      const out = await disconnectWebsite(kennelId);
      note = { ok: true, text: out?.reached === false ? 'Disconnected here. KennelPort couldn\'t be reached, so stop this device there too, under Link KennelOS.' : 'Disconnected this device.' };
      render();
    });
  }

  await render();
}
