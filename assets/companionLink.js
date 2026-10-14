// companionLink.js — turning a Companion bundle into the link a recipient opens
// and the sms:/mailto: anchors that send it. Shared by the Companion console
// (pages/companion.js) and the guided litter flow's "Share the available pups"
// step (assets/guidedShareUI.js), so both send byte-for-byte the same thing.
// Pro-only (PRO_ONLY_STANDALONE), like the console.
//
// The bundle rides the URL fragment (End-State guide §20, "Transport & the
// shell"): built by the allow-list builder, compressed with lz-string, appended
// to companion-view.html. The user's tap on a real anchor is the activating
// gesture: never a post-async window.location assignment (brief §5.2).
import { buildBundle } from '../data/companionExport.js';
import { compressToEncodedURIComponent } from '../vendor/lz-string.min.mjs';

// Payload ceilings for the data-in-hash transport (brief §6.1). SMS is the weak
// link — long URLs get truncated/split by some gateways; mail clients tolerate
// far longer. Conservative starting values; tune on real devices.
export const MAX_SMS_HASH_LEN = 1800;
export const MAX_EMAIL_HASH_LEN = 12000;

// The recipient-facing shell lives at the app root and is maintained by the
// owner (same static host). Absolute so it survives being pasted into SMS/email.
// This module sits one level down (assets/), exactly like pages/.
export const SHELL_URL = new URL('../companion-view.html', import.meta.url).href;

export function channelBody(kennelName, url) {
  const opener = kennelName ? `Here's your update from ${kennelName}:` : `Here's your update:`;
  return `${opener}\n\n${url}`;
}

// A fresh point-in-time bundle of `type` for `contact`, and what sending it needs.
export async function buildLinkArtifacts(type, contact) {
  const bundle = await buildBundle(type, contact);
  const hash = compressToEncodedURIComponent(JSON.stringify(bundle));
  const url = `${SHELL_URL}#${hash}`;
  const bodyText = channelBody(bundle.kennelName, url);
  return { bundle, hash, url, bodyText };
}

// The two send anchors' hrefs, and whether each channel can carry this payload.
export function sendHrefs({ bundle, hash, bodyText }, contact) {
  const subject = encodeURIComponent(bundle.kennelName ? `Update from ${bundle.kennelName}` : 'Your update');
  const body = encodeURIComponent(bodyText);
  return {
    mailto: `mailto:${encodeURIComponent(contact.email || '')}?subject=${subject}&body=${body}`,
    sms: `sms:${encodeURIComponent(contact.phone || '')}?body=${body}`,
    overSms: hash.length > MAX_SMS_HASH_LEN,
    overEmail: hash.length > MAX_EMAIL_HASH_LEN
  };
}
