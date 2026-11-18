import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

function loadLocalEnv() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

const localEnv = loadLocalEnv();
const env = { ...localEnv, ...process.env };
const keys = [
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
];
const complete = keys.every((key) => env[key] && !String(env[key]).includes('YOUR_'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const file of ['index.html', 'style.css', 'script.js', 'firebase-config.js']) {
  copyFileSync(join(root, file), join(dist, file));
}
cpSync(join(root, 'js'), join(dist, 'js'), { recursive: true });

if (complete) {
  const config = {
    apiKey: env.FIREBASE_API_KEY,
    authDomain: env.FIREBASE_AUTH_DOMAIN,
    databaseURL: env.FIREBASE_DATABASE_URL,
    projectId: env.FIREBASE_PROJECT_ID,
    storageBucket: env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID,
    appId: env.FIREBASE_APP_ID,
    useEmulators: ['1', 'true', 'yes'].includes(String(env.FIREBASE_USE_EMULATORS || 'false').toLowerCase()),
  };
  const source = `// Generated at build time from environment variables. Do not commit this file.
export const firebaseConfig = ${JSON.stringify(config, null, 2)};
export const isPlaceholderConfig = false;
`;
  writeFileSync(join(dist, 'firebase-config.js'), source, 'utf8');
  console.log('Built dist/ with Firebase configuration from environment variables.');
} else {
  console.log('Firebase environment variables are missing or incomplete; built Local Demo fallback.');
}
