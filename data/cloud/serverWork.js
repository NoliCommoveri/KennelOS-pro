// serverWork.js — which of her devices does the program's server work: taking in
// waitlist applications, applying what families and connected vendors did,
// publishing the list and sending her emails (cloudWaitlist.js,
// cloudIntegrations.js). One device at a time, so nothing is taken in or applied
// twice.
//   A program that doesn't sync: the BACKING device (Phase 1 §3.4), as before.
//   A syncing program (Cloud Phase 2 plan §7): whichever device holds the
//     two-minute LEASE (POST /waitlist/lease, renewed by every waitlist write).
//     Only a device that syncs may take it, or what it applied would stay on that
//     device alone; and only while it's in front of her: one in a background tab
//     lets it lapse (inBackground), and a closing page lets go (releaseServerWork).
// Network only through cloudApi.
import * as api from './cloudApi.js';
import { getCloudSyncState } from '../settings.js';

export class ServerWorkError extends Error {
  // code: 'not_backing_device' | 'lease_held' (holder: { label, until }) | 'not_syncing_here'
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ServerWorkError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// A syncing device whose page is hidden: it leaves the work to the one in front.
export const inBackground = (doc = globalThis.document) =>
  getCloudSyncState().enabled && doc?.visibilityState === 'hidden';

// This device may do the work now, or a ServerWorkError says who does.
// → { mode: 'backing' } | { mode: 'lease', until }.
export async function claimServerWork(token) {
  let lease;
  try {
    lease = await api.takeWaitlistLease(token);
  } catch (err) {
    if (err?.code === 'lease_held') throw new ServerWorkError('lease_held', 'Another of your devices is handling this now.', { holder: err.holder || null });
    throw err;
  }
  if (lease.mode === 'lease') {
    if (!getCloudSyncState().enabled) throw new ServerWorkError('not_syncing_here', 'Your devices keep in step, and this one doesn\'t yet.');
    return { mode: 'lease', until: lease.until };
  }
  const program = await api.getProgram(token);
  if (!program.backingDevice || program.backingDevice.id !== program.thisDeviceId) {
    throw new ServerWorkError('not_backing_device', 'Only the backing device does this.');
  }
  return { mode: 'backing' };
}

// The page is closing: let another device take over at once (best effort).
export function releaseServerWork(token) {
  if (!token || !getCloudSyncState().enabled) return Promise.resolve();
  return api.releaseWaitlistLease(token).catch(() => {});
}
