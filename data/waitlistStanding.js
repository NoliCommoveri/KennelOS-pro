// waitlistStanding.js — where a family stands on the picks open now (owner,
// 2026-11-22), shown in place of what they want on the public list, its copied text
// and her Waitlist: their turn on an open-picks litter closed (Passed / No response /
// No deposit - expired: a closed row keeps the sale its pick made) or no available
// pup there matches them (No matches). null while they hold a turn or a pick, are
// paused or buying through a side sale, when no litter's picks are open, or when
// they're still in line for a pup. Its own module so the app shell doesn't load it.
// Labels: waitlistRules.PICKS_STANDING_LABEL. Pure.
import { WAITLIST_CONFIG_DEFAULTS, isPicksOpen, isOnList, heldPickOf, sideSaleOf, isPaused, turnLittersFor } from './waitlistRules.js';

// `pups`: the kennel's dogs (array or Map). → 'passed' | 'no_response' | 'no_deposit' | 'no_match' | null
export function picksStanding(entry, { offers = [], litters = [], pups = [], sales = [], today, config = WAITLIST_CONFIG_DEFAULTS } = {}) {
  const open = (litters || []).filter((l) => isPicksOpen(l) && l.kennel_id === entry.kennel_id);
  if (!open.length || !isOnList(entry)) return null;
  const ids = new Set(open.map((l) => l.id));
  const mine = (offers || []).filter((o) => !o.is_archived && o.entry_id === entry.id && ids.has(o.litter_id));
  if (mine.some((o) => o.outcome === 'open') || heldPickOf(offers, entry.id) || sideSaleOf(entry, sales) || isPaused(entry, today, config)) return null;
  const [last] = mine.filter((o) => o.outcome === 'passed' || o.outcome === 'no_response')
    .sort((a, b) => String(b.outcome_date || '').localeCompare(String(a.outcome_date || '')) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  if (last) return last.outcome === 'passed' ? 'passed' : last.sale_id ? 'no_deposit' : 'no_response';
  const dogList = pups instanceof Map ? [...pups.values()] : (pups || []);
  return turnLittersFor(entry, offers, open, dogList, sales, { today, config }).length ? null : 'no_match';
}

