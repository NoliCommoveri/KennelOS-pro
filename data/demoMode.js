// demoMode.js — the read-only guard (editions plan §"The Demo edition", and the
// guided tour: Load Performance plan D1). Two things make the app read-only:
//
//  • the Demo edition, always: it ships the full Pro app, seeded, but every write
//    is a friendly no-op — "this is a demo, changes aren't saved";
//  • the guided tour, in every edition: while the tour's sample data is loaded
//    (settings.hasSampleData), nothing can be saved, so a real record can never
//    end up pointing at a sample one, and the seed can always be cleared.
//
// The plan's whole point is that this is ONE lever, not a hundred disabled
// buttons: every record write funnels through the repo layer (repoBase's
// create/update/hardDelete, plus fileRepo and the direct writers that call
// assertWritable), so those call assertWritable() and it throws here.
//
// The wrinkle: the seed (and the Demo's) runs through that same repo layer
// (sampleData.js creates its records via the repos, on purpose, so the sample
// data passes the same validation real data does). So the guard must let the
// seed through. withSeedAllowed() opens a short window the seed runs inside, as
// do clearing the seed and the kennel setup that waits on it (sampleDataUI.js);
// user-initiated writes (outside that window) still throw.
//
// Edition-agnostic like the rest of shared/: the demoMode flag lives in
// editionConfig.editionFlags (true only in demo/editionConfig.js).
import { editionFlags } from './editionConfig.js';
import { hasSampleData } from './settings.js';

// Thrown by the repo write methods when a user write is attempted in the Demo
// edition. The message is the user-facing notice — pages already surface caught
// errors (the same path CapExceededError / ReferenceBlockedError use), so a
// blocked write reads as this friendly line rather than a raw failure.
export class DemoModeError extends Error {
  constructor(message = "This is a demo — changes aren't saved.") {
    super(message);
    this.name = 'DemoModeError';
  }
}

// Thrown instead while the tour's sample data is loaded (outside the Demo). A
// DemoModeError, so every place that already reads a blocked demo write as
// "nothing was saved" (instanceof DemoModeError) reads this one the same way.
export class TourModeError extends DemoModeError {
  constructor() {
    super("This is the tour's sample kennel. Changes aren't saved. Finish or skip the tour to start your own.");
    this.name = 'TourModeError';
  }
}

// True only in the Demo edition (its editionConfig sets editionFlags.demoMode).
export const isDemo = () => Boolean(editionFlags.demoMode);

// True while the guided tour's sample data is loaded, outside the Demo (which is
// read-only anyway, and keeps its seed).
export const isTourMode = () => !isDemo() && hasSampleData();

// Read-only for either reason. Pages that skip a write or an outside action
// (a share link, e-sign, Stripe, Google Drive) instead of letting it throw check
// this, and say why with readOnlyWhy().
export const isReadOnly = () => isDemo() || isTourMode();
export const readOnlyWhy = () => (isDemo() ? 'This is a demo' : 'This is the tour’s sample kennel');

// Re-entrant seed window. While open, assertWritable() permits writes so the
// sample-data seed (which goes through the repos) can run. Nested/overlapping
// opens are handled by save/restore so a finally never closes a window an outer
// caller still needs.
let seedDepth = 0;

// Run `fn` with writes permitted (the seeds, clearing the tour's seed, and the
// kennel setup an old seed's cleanup waits for). Always restores the previous
// depth, so a throw inside can't leave the window stuck open.
export async function withSeedAllowed(fn) {
  seedDepth++;
  try {
    return await fn();
  } finally {
    seedDepth--;
  }
}

// Called at the top of every repo write. A no-op except for an unguarded user
// write in the Demo edition (DemoModeError) or during the tour (TourModeError).
export function assertWritable() {
  if (seedDepth > 0) return;
  if (isDemo()) throw new DemoModeError();
  if (hasSampleData()) throw new TourModeError();
}
