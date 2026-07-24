// googleDrive.js — Google Cloud credential for KennelOS's future "Publish to
// Furever" flow (see docs/KennelOS_Content_Package_Fetch_Mechanism.md § 5).
// CLIENT_ID below is the OAuth 2.0 Web application client id for the
// "KennelOS" Google Cloud project, registered once at
// https://console.cloud.google.com with:
//   - OAuth consent screen scoped to https://www.googleapis.com/auth/drive.file
//     only (non-sensitive — no Google verification review), published to
//     Production;
//   - Authorized JavaScript origins covering the KennelOS Pro/Demo origins
//     plus http://localhost:8000 for dev;
//   - No redirect URIs (the token-client flow needs none) and no client
//     secret (none is issued for this credential type).
// Like dropbox.js's APP_KEY, this is a public identifier, not a secret — it
// only tells Google which app is asking; the drive.file scope (this app can
// only ever see files it created) is what actually limits access, and every
// user still has to grant consent through their own Google sign-in.
//
// The connect/publish/fetch flow itself (GIS token client, folder creation,
// upload, manifest write) is not built yet — this file exists so the
// credential has one canonical home per docs/…Fetch_Mechanism.md § 5.2.
export const CLIENT_ID = '566763436944-k7rk72avivr1qg5nd7sn1fhbbg0343r2.apps.googleusercontent.com';
