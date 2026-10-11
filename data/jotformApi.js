// jotformApi.js — Connect Jotform (Integrations plan §2.1b): the only module that
// calls Jotform's API. Straight from her browser to Jotform with the key kept on
// this device (jotformKeyStore.js); nothing goes through KennelOS's server.
//
// The key goes as the `apiKey` query parameter, not a header, so each call is a
// plain GET with no CORS preflight: the best chance of Jotform answering a
// browser (D16's open question, tested in a real flow). Calls send no cookies
// and no referrer. Only reads: who the key belongs to, her forms, a form's fields.
// *Unverified from the build environment, which can't reach jotform.com:* the
// paths, the `{ responseCode, message, content }` envelope and the EU / HIPAA
// hosts are from Jotform's API docs; check them against a real account.
//
// The connection-level helpers pages use (connect, forms, match a form) are in
// jotformConnect.js.

export const JOTFORM_REGIONS = [
  { value: 'us', label: 'Standard (jotform.com)', base: 'https://api.jotform.com' },
  { value: 'eu', label: 'EU (eu.jotform.com)', base: 'https://eu-api.jotform.com' },
  { value: 'hipaa', label: 'HIPAA (hipaa.jotform.com)', base: 'https://hipaa-api.jotform.com' }
];

export class JotformError extends Error {
  // kind: 'network' (no answer: offline, or the browser blocked it), 'auth'
  // (key refused), 'other'.
  constructor(kind, message) {
    super(message);
    this.name = 'JotformError';
    this.kind = kind;
  }
}

const baseFor = (region) => (JOTFORM_REGIONS.find((r) => r.value === region) || JOTFORM_REGIONS[0]).base;

async function call(conn, path, params = {}) {
  const u = new URL(baseFor(conn.region) + path);
  u.searchParams.set('apiKey', conn.api_key);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(u.href, { method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    throw new JotformError('network', 'Couldn\'t reach Jotform from this browser. If you\'re online, Jotform may not accept calls from an app like KennelOS: keep pasting your form links, and let us know.');
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  const code = Number(body?.responseCode) || res.status;
  if (code === 401 || code === 403) throw new JotformError('auth', 'Jotform didn\'t accept that API key. Check it, and that the region matches your Jotform account.');
  if (!res.ok || code !== 200 || !body) throw new JotformError('other', `Jotform said: ${String(body?.message || res.statusText || res.status).slice(0, 200)}`);
  return body.content;
}

// Who the key belongs to. → { username }.
export async function jotformUser(conn) {
  const c = await call(conn, '/user');
  return { username: String(c?.username || '') };
}

// Her forms, newest first, deleted ones left out. → [{ id, title, url, status }].
export async function jotformForms(conn) {
  const c = await call(conn, '/user/forms', { limit: '1000', orderby: 'created_at' });
  return (Array.isArray(c) ? c : [])
    .filter((f) => f && f.id && f.status !== 'DELETED')
    .map((f) => ({ id: String(f.id), title: String(f.title || 'Untitled form'), url: String(f.url || ''), status: String(f.status || '') }));
}

// One form's fields, as the API gives them (jotformMatch.formFields reads them).
export async function jotformQuestions(conn, formId) {
  return call(conn, `/form/${encodeURIComponent(formId)}/questions`);
}
