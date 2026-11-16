// safeHref.js — the one href check for a URL from outside (K14-17). Pure.
// A URL from outside (a Dog Card, an import, a typed field) for an href: http(s)
// and mailto only, else '#' (K14-17). esc() stops HTML injection, not a
// javascript: scheme. One typed with no scheme ("www.…") gets https://. Use as
// href="${esc(safeHref(url))}".
export function safeHref(u) {
  const v = String(u ?? '').trim();
  if (!v) return '#';
  if (/^(https?:|mailto:)/i.test(v)) return v;
  return /^[a-z][a-z0-9+.-]*:/i.test(v) ? '#' : `https://${v.replace(/^\/+/, '')}`;
}
