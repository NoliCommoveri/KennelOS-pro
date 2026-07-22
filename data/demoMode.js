// demoMode.js — the Demo edition's read-only guard (editions plan §"The Demo
// edition"). Demo ships the full Pro app, seeded, but every write is a friendly
// no-op — "this is a demo, changes aren't saved". The plan's whole point is that
// this is ONE lever, not a hundred disabled buttons: every record write funnels
// through the repo layer (repoBase's create/update/hardDelete, plus fileRepo),
// so those call assertWritable() and it throws here in demo.
//
// The wrinkle: the demo SEEDS through that same repo layer (sampleData.js creates
// its records via the repos, on purpose, so the sample data passes the same
// validation real data does). So the guard can't be a blanket "demo ⇒ block" —
// it must let the seed through. withSeedAllowed() opens a short window the seed
// runs inside; user-initiated writes (outside that window) still throw.
//
// Edition-agnostic like the rest of shared/: the demoMode flag lives in
// editionConfig.editionFlags (true only in demo/editionConfig.js), so isDemo() is
// false in Lite/Pro and assertWritable() never throws there.
import { editionFlags } from './editionConfig.js';

// Thrown by the repo write methods when a user write is attempted in the Demo
// edition. The message is the user-facing notice — pages already surface caught
// errors (the same path CapExceededError / ReferenceBlockedError use), so a
// blocked write reads as this friendly line rather than a raw failure. Pro/Lite
// never construct it (isDemo() false), so no demo wording ships in those builds.
export class DemoModeError extends Error {
  constructor() {
    super("This is a demo — changes aren't saved.");
    this.name = 'DemoModeError';
  }
}

// True only in the Demo edition (its editionConfig sets editionFlags.demoMode).
export const isDemo = () => Boolean(editionFlags.demoMode);

// Re-entrant seed window. While open, assertWritable() permits writes so the
// sample-data seed (which goes through the repos) can run. Nested/overlapping
// opens are handled by save/restore so a finally never closes a window an outer
// caller still needs.
let seedDepth = 0;

// Run `fn` with writes permitted even in demo (used only by the demo seed
// bootstrap). Always restores the previous depth, so a throw inside the seed
// can't leave the window stuck open.
export async function withSeedAllowed(fn) {
  seedDepth++;
  try {
    return await fn();
  } finally {
    seedDepth--;
  }
}

// Called at the top of every repo write. A no-op everywhere except an
// unguarded user write in the Demo edition, where it throws DemoModeError.
export function assertWritable() {
  if (isDemo() && seedDepth === 0) throw new DemoModeError();
}
