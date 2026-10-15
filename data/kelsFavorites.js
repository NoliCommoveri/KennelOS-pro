// kelsFavorites.js — how her tasks move up Kels's "Doing Something" menu (Kels
// roadmap §4 "Her favorites first", End-State guide §33). Pure: the stars, the
// start dates and the "don't move this up" list come from settings.js (device-
// local, never in a backup or synced); this only says what they mean.
//
// Order: unfinished work (a resumable draft, `unfinished`) → starred → used
// often → the menu's own state-based priority. Within a group, that priority.
import { addDaysToYMD } from './dateUtils.js';

export const FREQUENT_WINDOW_DAYS = 60;
export const FREQUENT_MIN_STARTS = 4; // "more than 3 starts in the last 60 days"

// Starts still inside the window, oldest dropped. `dates`: YYYY-MM-DD strings.
export function recentStarts(dates = [], today) {
  const since = addDaysToYMD(today, -FREQUENT_WINDOW_DAYS);
  return dates.filter((d) => typeof d === 'string' && d > since && d <= today);
}

export const isFrequent = (dates, today) => recentStarts(dates, today).length >= FREQUENT_MIN_STARTS;

// The use log after one more start of `id` (only the window is kept).
export function withStart(uses = {}, id, today) {
  return { ...uses, [id]: [...recentStarts(uses[id], today), today] };
}

// Starring a task clears "don't move this up" for it; unstarring leaves it.
export function withStar({ starred = [], noPromote = [] } = {}, id, on) {
  return {
    starred: on ? [...new Set([...starred, id])] : starred.filter((x) => x !== id),
    noPromote: on ? noPromote.filter((x) => x !== id) : noPromote
  };
}

// Her tasks in menu order. tasks: [{ id, priority, unfinished? }];
// prefs: { starred: [ids], uses: { id: [dates] }, noPromote: [ids] }.
// Returns [{ task, starred, frequent }]. A task that isn't offered never comes in here.
export function orderTasks(tasks, { starred = [], uses = {}, noPromote = [] } = {}, today) {
  const stars = new Set(starred);
  const quiet = new Set(noPromote);
  const rows = tasks.map((task) => {
    const star = stars.has(task.id);
    const frequent = !star && !task.unfinished && !quiet.has(task.id) && isFrequent(uses[task.id], today);
    const group = task.unfinished ? 0 : star ? 1 : frequent ? 2 : 3;
    return { task, starred: star, frequent, group };
  });
  return rows.sort((a, b) => a.group - b.group || b.task.priority - a.task.priority)
    .map(({ task, starred: s, frequent }) => ({ task, starred: s, frequent }));
}
