// dropboxConnectUI.js — the ONE Dropbox connect/disconnect control, rendered
// into a host element by any page that needs the connection.
//
// WHY THIS EXISTS: the Dropbox link is a single account-level connection with
// more than one consumer — Import/Export uses it as a backup destination, and
// the KennelAssistant console uses it to push the helper's feed and pull their
// outbox. Both need to show status and offer Connect, and neither owns the
// connection. Hand-rolling the same three states on each page is how they drift,
// so the control lives here and the pages just say where to put it.
//
// It also owns the OAuth-completion boilerplate: `beginDropboxAuth()` redirects
// out to dropbox.com and lands back on the SAME page (dropbox.js derives the
// redirect URI from `location.pathname`), so every host page must call
// `completeDropboxAuth()` on load or the round-trip silently does nothing.
// `mountDropboxConnect()` does that for you — which also means **every page that
// mounts this control needs its URL registered as a redirect URI on the Dropbox
// app** (a one-time developer step; see the End-State guide §26).
import { esc, confirmModal } from './ui.js';
import {
  isDropboxConnected, beginDropboxAuth, completeDropboxAuth, disconnectDropbox
} from '../data/dropbox.js';

// Mount the control into `host` and finish any in-flight OAuth redirect.
//
//   onChange(connected) — called after the connection state actually changes
//                         (connected, disconnected, or an OAuth round-trip that
//                         just completed), so the host page can re-render
//                         whatever depends on it.
//   onError(message)    — surfaced failures (auth exchange, network). The
//                         control renders its own state either way.
//
// Returns the render function so a host can force a redraw if it needs to.
export async function mountDropboxConnect(host, { onChange, onError } = {}) {
  if (!host) return () => {};

  const render = () => {
    if (isDropboxConnected()) {
      host.innerHTML = `
        <div class="dbx-strip">
          <span class="dbx-status"><span class="dbx-dot dbx-dot-on"></span> Dropbox connected</span>
          <button class="btn btn-sm" type="button" id="dbx-disconnect">Disconnect</button>
        </div>`;
      host.querySelector('#dbx-disconnect').addEventListener('click', async () => {
        if (!(await confirmModal({
          title: 'Disconnect Dropbox?',
          message: 'This forgets the connection on this device only — nothing in Dropbox is deleted.',
          confirmLabel: 'Disconnect'
        }))) return;
        disconnectDropbox();
        render();
        onChange?.(false);
      });
      return;
    }
    host.innerHTML = `
      <div class="dbx-strip">
        <span class="dbx-status"><span class="dbx-dot"></span> Dropbox not connected</span>
        <button class="btn btn-sm" type="button" id="dbx-connect">Connect Dropbox</button>
      </div>`;
    host.querySelector('#dbx-connect').addEventListener('click', async () => {
      try {
        await beginDropboxAuth(); // navigates away
      } catch (e) {
        onError?.(e.message || String(e));
      }
    });
  };

  // Finish the redirect BEFORE the first paint of the control, so a page landing
  // back from dropbox.com renders "connected" once rather than flipping.
  let justConnected = false;
  try {
    justConnected = await completeDropboxAuth();
  } catch (e) {
    onError?.(e.message || String(e));
  }
  render();
  if (justConnected) onChange?.(true);
  return render;
}

// Convenience for hosts that gate an action on the connection: a standard
// inline notice pointing at wherever the control was mounted.
export function dropboxRequiredNotice(where) {
  return `<div class="inline-warn">Requires a Dropbox connection — connect ${esc(where)}.</div>`;
}
