// referralShare.js — her referral links and codes, shared with families, and the
// thank-you notes that go with them (Integrations plan §3; End-State guide §32).
//
// No program reports WHICH buyer used a link or code (Amazon's terms even forbid
// tagging one per person), so nothing here detects a use. Instead:
//   - the accounts she marks "Share with families" (Account.share_with_families)
//     show to her families: on their Companion page and their waitlist status page;
//   - a week after a pup goes home, Today suggests a follow-up note to the buyer
//     (with those recommendations), which she sends herself (email, text or copy);
//   - a Contact has "Send a thank-you" for when a family tells her they used one.
// Pure: no db, no DOM. The callers read the records.

export const FOLLOW_UP_DAYS = 7; // a week after going home
// A sale that went home longer ago than this never gets a follow-up nudge (so
// turning this on doesn't flood Today with every past placement).
export const FOLLOW_UP_WINDOW_DAYS = 60;

const text = (v) => String(v ?? '').trim();

// Only a web address is shown as a link to a family; anything else isn't shown.
export function safeLink(raw) {
  const t = text(raw);
  return /^https?:\/\/[^\s"'<>]+$/i.test(t) ? t : '';
}

// The accounts to show families: switched on, not archived, carrying a link or a
// code. → [{ name, link, code, instructions }], by name. Copied field by field.
export function sharedReferrals(accounts) {
  return (accounts || [])
    .filter((a) => a && a.share_with_families === true && !a.is_archived && (safeLink(a.referral_link) || text(a.referral_code)))
    .map((a) => ({
      name: text(a.name),
      link: safeLink(a.referral_link),
      code: text(a.referral_code),
      instructions: text(a.referral_instructions)
    }))
    .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
}

// When a sold pup went home: the latest placement event on or before today, else
// the date the balance was paid. null when neither is known.
export function goHomeDate(sale, placementDates = [], today) {
  const past = placementDates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d <= today).sort();
  if (past.length) return past[past.length - 1];
  return /^\d{4}-\d{2}-\d{2}$/.test(sale?.balance_paid_date || '') && sale.balance_paid_date <= today ? sale.balance_paid_date : null;
}

// Whole days from one YYYY-MM-DD to another (negative when `to` is earlier).
export function daysBetween(from, to) {
  const ms = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return Math.round((ms(to) - ms(from)) / 86400000);
}

const firstName = (name) => text(name).split(/\s+/)[0] || 'there';

function recommendationLines(referrals, pup) {
  if (!referrals.length) return [];
  const lines = ['', `A few things we recommend for ${pup}:`];
  for (const r of referrals) {
    const bits = [r.link, r.code ? `code ${r.code}` : ''].filter(Boolean).join(', ');
    lines.push(`- ${r.name}${bits ? `: ${bits}` : ''}`);
    if (r.instructions) lines.push(`  ${r.instructions}`);
  }
  lines.push('If you use them, thank you: it helps support our program.');
  return lines;
}

// The week-after follow-up. → { subject, body }.
export function followUpMessage({ buyerName, pupName, kennelName, days, referrals = [] }) {
  const pup = text(pupName) || 'your puppy';
  const kennel = text(kennelName);
  const since = days >= 14 ? `${Math.round(days / 7)} weeks` : days >= 7 ? 'a week' : `${days} day${days === 1 ? '' : 's'}`;
  const body = [
    `Hi ${firstName(buyerName)},`,
    '',
    `It's been ${since} since ${pup} went home with you. We hope ${pup} is settling in well! Thank you again for choosing ${kennel || 'us'}.`,
    ...recommendationLines(referrals, pup),
    '',
    'We\'d love a photo when you have a moment, and we\'re here if you have any questions.',
    '',
    kennel
  ].join('\n').trimEnd();
  return { subject: `How is ${pup} settling in?`, body };
}

// "Thank you for using our Chewy link". `referral` is one of sharedReferrals, or
// null for a general thank-you for a referral. → { subject, body }.
export function referralThanksMessage({ buyerName, kennelName, referral = null }) {
  const kennel = text(kennelName);
  const what = referral ? `our ${referral.name} ${referral.code && !referral.link ? 'code' : 'link'}` : 'us to others';
  const body = [
    `Hi ${firstName(buyerName)},`,
    '',
    referral
      ? `Thank you for using ${what}! It really helps support ${kennel || 'our program'}, and we appreciate it.`
      : `Thank you for recommending ${what}! It really helps ${kennel || 'our program'}, and we appreciate it.`,
    '',
    kennel
  ].join('\n').trimEnd();
  return { subject: 'Thank you!', body };
}
