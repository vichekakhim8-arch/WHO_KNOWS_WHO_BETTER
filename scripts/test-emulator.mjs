import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'firebase-config.js');
const backup = readFileSync(configPath, 'utf8');
const emulatorConfig = `export const firebaseConfig = {
  apiKey: "demo-api-key",
  authDomain: "demo-who-knows-who-better.firebaseapp.com",
  databaseURL: "https://demo-who-knows-who-better-default-rtdb.firebaseio.com",
  projectId: "demo-who-knows-who-better",
  storageBucket: "demo-who-knows-who-better.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:demo",
  useEmulators: true,
};
export const isPlaceholderConfig = false;
`;
try {
  writeFileSync(configPath, emulatorConfig, 'utf8');
  const testScript = process.env.WKHWB_TEST_SCRIPT || 'python .test/test_game.py';
  const command = `npx --yes firebase-tools emulators:exec --project demo-who-knows-who-better --only auth,database "${testScript}"`;
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, WKHWB_EXPECT_LOCAL: '0' } });
  process.exitCode = result.status ?? 1;
} finally {
  writeFileSync(configPath, backup, 'utf8');
}
