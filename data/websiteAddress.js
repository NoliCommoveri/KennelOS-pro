// websiteAddress.js — is an address a page on her KennelPort website? Pure, so
// both the website link (kennelportLink.js) and the waitlist projection use it.
//
// A page on her website is any kennelport.com address, or one on her site's own
// address (her custom domain). `sites`: the site facts the device has had (now
// and before), or anything with a `website` field, like her kennel.

export const originOf = (url) => {
  try { return new URL(String(url)).origin; } catch { return null; }
};
const KENNELPORT_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*kennelport\.com$/;

export function isWebsiteAddress(url, sites = []) {
  const o = originOf(url);
  if (!o) return false;
  if (KENNELPORT_ORIGIN.test(o)) return true;
  return sites.some((s) => s?.website && originOf(s.website) === o);
}
