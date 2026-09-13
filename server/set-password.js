// Sets the dashboard password without it ever being written down in plain text.
//
//   npm run set-password            asks twice (typing is hidden), stores only an scrypt hash in .env
//   npm run set-password -- --print prints the hash instead, to paste into the hosting panel
//                                   as ADMIN_PASSWORD_HASH
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_FILE = join(ROOT, '.env');
const PRINT = process.argv.includes('--print');

function askHidden(prompt) {
  return new Promise((done, fail) => {
    const input = process.stdin;
    if (!input.isTTY) {
      fail(new Error('Run this in a terminal: the password is typed interactively and never passed as an argument.'));
      return;
    }
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const stop = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stop();
          process.stdout.write('\n');
          done(value);
          return;
        }
        if (ch === '') {
          stop();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    }
    input.on('data', onData);
  });
}

function upsertEnv(text, key, value) {
  const line = `${key}='${value}'`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
}

try {
  const first = await askHidden('New dashboard password (min. 12 characters): ');
  if (first.length < 12) throw new Error('Too short. Use at least 12 characters.');
  const second = await askHidden('Type it again: ');
  if (first !== second) throw new Error('The two passwords are not the same. Nothing was changed.');
  const hash = hashPassword(first);

  if (PRINT) {
    console.log('\nSet this as ADMIN_PASSWORD_HASH in your hosting panel:\n');
    console.log(hash);
  } else {
    let env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
    env = upsertEnv(env, 'ADMIN_PASSWORD_HASH', hash);
    if (!/^ADMIN_EMAIL=/m.test(env)) env = upsertEnv(env, 'ADMIN_EMAIL', 'slocabaia@gmail.com');
    writeFileSync(ENV_FILE, env);
    chmodSync(ENV_FILE, 0o600);
    console.log(`\nDone. Only a hash was written to ${ENV_FILE}. Restart the server to use it.`);
  }
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
