// Picks the transport for this build:
//   • real firebaseConfig  → Firebase Anonymous Auth + Realtime Database
//   • YOUR_* placeholders  → Local Demo (same browser, two windows)
// The backend interface is intentionally tiny:
//   uid, kind, now, getRoom, createRoom, deleteRoom, transaction, watchRoom.
import { firebaseConfig, isPlaceholderConfig } from '../../firebase-config.js';

export const isFirebaseConfigured = !isPlaceholderConfig;

let backendPromise = null;

export function getBackend() {
  if (!backendPromise) {
    const promise = (async () => {
      const mod = isPlaceholderConfig
        ? await import('./local.js')
        : await import('./firebase.js');
      return mod.createBackend(firebaseConfig);
    })();
    promise.then(() => {}, () => {
      if (backendPromise === promise) backendPromise = null;
    });
    backendPromise = promise;
  }
  return backendPromise;
}

export async function getLocalBackend() {
  const mod = await import('./local.js');
  return mod.createBackend();
}
