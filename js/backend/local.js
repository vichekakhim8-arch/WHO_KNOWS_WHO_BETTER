// Local Demo backend — no account, no network.
// Rooms live in localStorage and sync between tabs/windows of the same
// browser through BroadcastChannel (plus the `storage` event as fallback).
// Player identity is per window/tab (window.name), so host and guest differ.

const DB_KEY = 'wkhwb-local-db-v2';

function readDB() {
  try { return JSON.parse(localStorage.getItem(DB_KEY) || '{}'); } catch { return {}; }
}
function writeDB(db) {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { console.error(e); }
}

const channel = (() => {
  try { return new BroadcastChannel('wkhwb-local-sync-v2'); } catch { return null; }
})();

const watchers = new Set();
const emit = (code) => {
  for (const w of [...watchers]) if (w.code === code) w.notify();
};
const announce = (code) => {
  if (channel) channel.postMessage({ type: 'rooms', code });
  emit(code);
};

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const randomId = () => Math.random().toString(36).slice(2, 12);

function tabUid() {
  try {
    if (window.name && window.name.startsWith('wkhwb-uid:')) return window.name.slice(10);
    const uid = 'local_' + randomId() + Date.now().toString(36);
    window.name = 'wkhwb-uid:' + uid;
    return uid;
  } catch {
    return 'local_' + randomId() + Date.now().toString(36);
  }
}

/** @returns {import('./index.js').Backend} */
export function createBackend() {
  const uid = tabUid();
  return {
    kind: 'local',
    uid,
    now: () => Date.now(),
    async getRoom(code) {
      const db = readDB();
      return db[code] ? clone(db[code]) : null;
    },
    async createRoom(code, data) {
      const db = readDB();
      db[code] = clone(data);
      writeDB(db);
      announce(code);
    },
    async deleteRoom(code) {
      const db = readDB();
      delete db[code];
      writeDB(db);
      announce(code);
    },
    async transaction(code, updater) {
      const db = readDB();
      const next = updater(db[code] ? clone(db[code]) : null);
      if (next === undefined) return { committed: false };
      db[code] = clone(next);
      writeDB(db);
      announce(code);
      return { committed: true };
    },
    watchRoom(code, onRoom) {
      const watcher = { code, notify: () => onRoom(readDB()[code] ? clone(readDB()[code]) : null) };
      watchers.add(watcher);
      const onChannel = (ev) => {
        const msg = ev && ev.data;
        if (msg && msg.type === 'rooms' && msg.code === code) watcher.notify();
      };
      const onStorage = () => watcher.notify();
      if (channel) channel.addEventListener('message', onChannel);
      window.addEventListener('storage', onStorage);
      watcher.notify();
      return () => {
        watchers.delete(watcher);
        if (channel) channel.removeEventListener('message', onChannel);
        window.removeEventListener('storage', onStorage);
      };
    },
  };
}
