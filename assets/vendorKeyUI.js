// vendorKeyUI.js — a Stripe key, connected (or replaced) right in Kels's
// chat: account health's "Help me replace it", and the waitlist setup's Stripe
// for the application fee. The steps to make one (in a new tab, signed in with
// the login saved on that account, shown here when she has one), then the key
// pasted in the chat, checked with the vendor and kept on this device
// (stripeLinks.connectStripe, as the Accounts page connects). Jotform's key flow
// went with Connect Jotform (Integrations plan D27).
// `account`: { id, name, username?, password?, website?, currency? }.
import { esc } from './ui.js';

// Her account's website as typed ("stripe.com"), made a full address as the
// Accounts page does; only a web link is offered.
function webHref(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  const href = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
  return /^https?:/i.test(href) ? href : '';
}

// `site`: the vendor's own key page, always; `own`: her saved website, offered
// beside it when it's somewhere else (K12-10).
const KEY_STEPS = {
  stripe: (a, perms, replacing) => ({
    site: 'https://dashboard.stripe.com/apikeys',
    own: webHref(a.website),
    steps: [
      `Open a new browser tab and sign in to your Stripe Dashboard${a.username ? ' (your login is below)' : ''}.`,
      'Go to <strong>Developers → API keys</strong> and choose <strong>Create restricted key</strong>. Name it KennelOS.',
      `Give it only these permissions: ${perms.map(([what, level]) => `${esc(what)} <em>${esc(level)}</em>`).join(', ')}. Leave the rest as None (the names may differ a little).`,
      'Create it, then copy the key. It starts <code>rk_</code>. Never your full secret key (<code>sk_</code>).',
      `Come back to this tab and paste it below.${replacing ? ' You can delete the old key in Stripe once this one works.' : ''}`
    ]
  })
};

// → true once a working key is saved; false when she leaves it for later.
// `resumeTask`: the menu task she picks to come back to it.
export async function vendorKeyFlow(chat, a, vendorKey, { replacing = false, resumeTask = '' } = {}) {
  if (!KEY_STEPS[vendorKey]) return false;
  const vendor = 'Stripe';
  const stripeMod = await import('../data/stripeLinks.js');
  const { site, own, steps } = KEY_STEPS[vendorKey](a, stripeMod.STRIPE_KEY_PERMISSIONS || [], replacing);
  const sameSite = own && own.replace(/\/+$/, '') === site;
  await chat.say(`Happy to help! Here's how to get ${replacing ? 'a new' : 'your'} ${vendor} key:<ol class="kels-steps">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>`
    + `<a class="btn btn-sm" href="${esc(site)}" target="_blank" rel="noopener">Open ${esc(vendor)}'s API keys in a new tab</a>`
    + (own && !sameSite ? ` <a class="btn btn-sm" href="${esc(own)}" target="_blank" rel="noopener">Open your saved website</a>` : ''), { typing: 900 });

  const login = a.username || a.password ? `<div class="kels-login">
      <p class="gl-q">Your login for ${esc(a.name)}, from your Accounts</p>
      ${a.username ? `<div class="kels-login-row"><span class="faint">Username</span><code>${esc(a.username)}</code><button type="button" class="gl-more" data-copy="u">Copy</button></div>` : ''}
      ${a.password ? `<div class="kels-login-row"><span class="faint">Password</span><code data-pw>••••••••</code><button type="button" class="gl-more" data-show>Show</button><button type="button" class="gl-more" data-copy="p">Copy</button></div>` : ''}
    </div>` : '';
  const options = stripeMod.STRIPE_CURRENCIES.map((c) => `<option value="${esc(c.value)}"${c.value === a.currency ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  const res = await chat.form({
    title: '<strong>Paste the new key when you have it.</strong><span class="kels-lead">Take your time. I\'ll be right here.</span>',
    html: `${login}
      <div class="field gl-field"><label for="kh-key">New restricted key</label>
        <input id="kh-key" type="password" autocomplete="off" spellcheck="false" placeholder="rk_live_…"></div>
      <div class="field gl-field"><label for="kh-opt">Currency</label><select id="kh-opt">${options}</select></div>`,
    wire: (root) => {
      const copy = async (btn, text) => { try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied!'; } catch { btn.textContent = 'Couldn\'t copy'; } setTimeout(() => { btn.textContent = 'Copy'; }, 1500); };
      root.querySelector('[data-copy="u"]')?.addEventListener('click', (e) => copy(e.currentTarget, a.username));
      root.querySelector('[data-copy="p"]')?.addEventListener('click', (e) => copy(e.currentTarget, a.password));
      root.querySelector('[data-show]')?.addEventListener('click', (e) => {
        const pw = root.querySelector('[data-pw]');
        const shown = e.currentTarget.textContent === 'Hide';
        pw.textContent = shown ? '••••••••' : a.password;
        e.currentTarget.textContent = shown ? 'Show' : 'Hide';
      });
    },
    submitLabel: 'Check and save',
    cancelLabel: 'I\'ll do it later',
    submit: async (root) => {
      const key = root.querySelector('#kh-key').value.trim();
      if (!key) return `Paste the new ${vendor} key first.`;
      const opt = root.querySelector('#kh-opt').value;
      await stripeMod.connectStripe(a.id, key, opt);
      return true;
    },
    reply: () => `Here's the new ${vendor} key`
  });
  if (!res.done) {
    await chat.say(`No problem. When you have it, tap me and pick <strong>${esc(resumeTask || 'this task')}</strong>, and we'll pick up from there.`);
    return false;
  }
  return true;
}
