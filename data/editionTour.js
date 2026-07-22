// editionTour.js — the per-edition GUIDED-TOUR package (sample seed + step
// catalog), a second injection point alongside editionConfig.js.
//
// WHY THIS FILE EXISTS: the guided tour and its sample data are one system — the
// step catalog hard-names anchor records ("Juniper", "the Autumn litter") and
// resolves them against the ids the seed writes into the manifest's `named` map.
// They must therefore vary together per edition: Pro/Demo walk the full app over
// the full Thornfield packet; Lite walks only Lite's pages over a smaller packet
// that fits Lite's 6-dog / 2-litter cap and pitches Pro along the way. Shared code
// (wizardState.js, wizardUI.js, onboardingUI.js, app.js) imports the tour package
// from HERE so it stays edition-agnostic; the edition supplies the content.
//
// THIS COPY is the default shipped in /shared: the **full Pro/Demo tour** — it
// re-exports the complete WIZARD_STEPS catalog and the full Thornfield seed. Pro
// and Demo use it as-is. Lite overlays its own editionTour.js (build/assemble.mjs)
// at this fixed shared path, exactly like editionConfig.js.
//
// clearSampleData / hasSampleData / shouldOfferFirstRunPrompt stay in
// sampleData.js — they're manifest-driven and generic, so one copy clears whatever
// packet was seeded (full or Lite).

export { WIZARD_STEPS } from './wizardSteps.js';
export { seedSampleData } from './sampleData.js';
