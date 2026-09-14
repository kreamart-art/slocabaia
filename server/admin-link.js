// Prints a one-time link the owner opens to choose (or reset) the dashboard password.
// Locally: npm run admin-link. In the container: node server/admin-link.js
// The link works once and for 48 hours; making a new one cancels the previous one.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { newToken, sha256 } from './auth.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* no .env file: use the real environment */
}

const env = process.env;
const HOURS = 48;
const DATA_DIR = resolve(ROOT, env.DATA_DIR || 'data');
const SITE_URL = (env.SITE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');

if (env.ADMIN_PASSWORD_HASH) {
  console.error('ADMIN_PASSWORD_HASH is set in the environment, so the password is managed there and a setup link would not work.');
  process.exit(1);
}

const db = openDb(DATA_DIR);
const token = newToken();
const now = new Date();
db.prepare(
  'INSERT INTO site (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
).run('admin_setup', JSON.stringify({ hash: sha256(token), expires: new Date(now.getTime() + HOURS * 3600e3).toISOString() }), now.toISOString());
db.close();

console.log(`${SITE_URL}/admin/#setup=${token}`);
console.log(`Valid once, for ${HOURS} hours. Whoever opens it chooses the dashboard password.`);
