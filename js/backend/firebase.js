// Firebase backend — Anonymous Auth + Realtime Database.
// This file is only loaded when firebase-config.js holds a real config.
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import { getDatabase, ref, get, set, onValue, runTransaction, remove, connectDatabaseEmulator } from 'firebase/database';

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const TRANSACTION_RETRY = Object.freeze({ __wkhwbTransactionRetry: true });

/** @returns {Promise<import('./index.js').Backend>} */
export async function createBackend(config) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getDatabase(app);
  if (config.useEmulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectDatabaseEmulator(db, '127.0.0.1', 9000);
  }
  const cred = await signInAnonymously(auth);
  const uid = cred.user.uid;
  const roomPath = (code) => `rooms/${code}`;

  // Verify the Realtime Database transport itself, rather than only Auth.
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error('Realtime Database connection timed out'));
    }, 12000);
    const unsubscribe = onValue(
      ref(db, '.info/connected'),
      (snap) => {
        if (snap.val() === true) {
          window.clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      },
      (error) => {
        window.clearTimeout(timeout);
        unsubscribe();
        reject(error);
      },
    );
  });

  // Keep gameplay timers on Firebase server time so both players share a clock.
  let serverTimeOffset = 0;
  onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
    serverTimeOffset = Number(snap.val()) || 0;
  }, () => { /* offset unavailable: fall back to local clock */ });

  return {
    kind: 'online',
    uid,
    now: () => Date.now() + serverTimeOffset,
    async getRoom(code) {
      const snap = await get(ref(db, roomPath(code)));
      return snap.exists() ? snap.val() : null;
    },
    async createRoom(code, data) {
      await set(ref(db, roomPath(code)), data);
    },
    async deleteRoom(code) {
      await remove(ref(db, roomPath(code)));
    },
    async transaction(code, updater) {
      try {
        const result = await runTransaction(ref(db, roomPath(code)), (current) => {
          const next = updater(current ? clone(current) : null);
          if (next === undefined && !current) return TRANSACTION_RETRY;
          return next === undefined ? undefined : next;
        });
        return { committed: result.committed };
      } catch (err) {
        console.warn('transaction:', err?.message || err);
        return { committed: false, error: err };
      }
    },
    watchRoom(code, onRoom, onError) {
      const unsubscribe = onValue(
        ref(db, roomPath(code)),
        (snap) => onRoom(snap.exists() ? snap.val() : null),
        (err) => { if (onError) onError(err); else console.warn('watchRoom:', err?.message || err); },
      );
      return unsubscribe;
    },
  };
}
