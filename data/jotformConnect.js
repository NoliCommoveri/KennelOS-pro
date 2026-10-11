// jotformConnect.js — Connect Jotform for a Form service account (Integrations
// plan §2.1b): connect a key on this device (checked with Jotform first), list
// her forms to pick from, and read a form's fields with a suggested field_map.
// What pages call; the key store (jotformKeyStore.js) and the network
// (jotformApi.js) stay behind it.
import { getJotformKey, setJotformKey, clearJotformKey } from './jotformKeyStore.js';
import { jotformUser, jotformForms, jotformQuestions, JotformError } from './jotformApi.js';
import { formFields, suggestFieldMap, matchWarnings } from './jotformMatch.js';
import { formLink } from './contractForms.js';

export { JOTFORM_REGIONS, JotformError } from './jotformApi.js';

// This device's connection for the account, or null. → { region, username, connected_at }
// (the key itself stays in here).
export async function jotformConnection(accountId) {
  const k = await getJotformKey(accountId);
  return k ? { region: k.region, username: k.username, connected_at: k.connected_at } : null;
}

// Check the key with Jotform, then keep it on this device. → { username }.
export async function connectJotform(accountId, apiKey, region = 'us') {
  const api_key = String(apiKey || '').trim();
  if (!accountId) throw new Error('Save the account first.');
  if (!/^[A-Za-z0-9]{16,64}$/.test(api_key)) throw new JotformError('auth', 'That doesn\'t look like a Jotform API key: copy it from Jotform\'s API settings.');
  const { username } = await jotformUser({ api_key, region });
  await setJotformKey(accountId, { api_key, region, username });
  return { username };
}

export const disconnectJotform = (accountId) => clearJotformKey(accountId);

async function conn(accountId) {
  const k = await getJotformKey(accountId);
  if (!k) throw new JotformError('auth', 'Jotform isn\'t connected on this device.');
  return k;
}

// Her forms with a usable link. → [{ id, title, url, status }].
export async function listJotformForms(accountId) {
  return (await jotformForms(await conn(accountId))).filter((f) => formLink(f.url));
}

// One form's fields, and a field_map: `current` when she already matched this
// form (kept as it is), else the suggestion. → { fields, field_map, warnings, questions }.
export async function matchJotformForm(accountId, formId, formType, current = null) {
  const questions = await jotformQuestions(await conn(accountId), formId);
  const fields = formFields(questions);
  const field_map = current || suggestFieldMap(formType, questions).field_map;
  return { fields, field_map, warnings: matchWarnings(formType, questions, field_map), questions };
}
