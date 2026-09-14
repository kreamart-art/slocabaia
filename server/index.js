// Slocabaia server: the one-pager, the member list and the newsletter dashboard.
// No dependencies: node:http, node:sqlite and node:crypto (Node 22.13 or newer).
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { verifyPassword, hashPassword, newToken, sha256, limiter } from './auth.js';
import { createMailer } from './mail.js';
import { HttpError, send, json, readBody, readJson } from './http.js';
import { createSite } from './site.js';
import { renderNewsletter, renderConfirmEmail, renderUnsubscribePage, renderContactAlert } from './render.js';
import { createPush } from './push.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* no .env file: use the real environment */
}

const env = process.env;
const argPort = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(argPort ? argPort.slice(7) : env.PORT || 3000);
const DATA_DIR = resolve(ROOT, env.DATA_DIR || 'data');
const SITE_URL = (env.SITE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ADMIN_EMAIL = String(env.ADMIN_EMAIL || 'slocabaia@gmail.com').trim().toLowerCase();
// A hash in the environment wins; otherwise the owner chooses a password with a one-time
// setup link (npm run admin-link) and its hash is kept in the database.
const ENV_HASH = env.ADMIN_PASSWORD_HASH || '';
const PROD = env.NODE_ENV === 'production';
const TRUST_PROXY = env.TRUST_PROXY === '1';
const COOKIE = 'sloca_admin';
const SESSION_DAYS = 7;
const BATCH = 100; //          Resend's batch limit
const BATCH_GAP_MS = 600; //   stays under Resend's default of 2 requests per second

const db = openDb(DATA_DIR);
const mailer = createMailer({
  apiKey: env.RESEND_API_KEY || '',
  from: env.MAIL_FROM || 'Slocabaia <news@slocabaia.com>',
  replyTo: env.MAIL_REPLY_TO || 'slocabaia@gmail.com',
  outboxDir: join(DATA_DIR, 'outbox'),
});

const site = createSite({ db, root: ROOT, dataDir: DATA_DIR });

// small settings in the site table (JSON values)
const getSetting = (key) => {
  const r = db.prepare('SELECT value FROM site WHERE key = ?').get(key);
  try {
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
};
const putSetting = (key, value) =>
  db
    .prepare(
      'INSERT INTO site (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
const delSetting = (key) => db.prepare('DELETE FROM site WHERE key = ?').run(key);
const passwordHash = () => ENV_HASH || getSetting('admin_password')?.hash || '';
const push = createPush({
  db,
  subject: `mailto:${ADMIN_EMAIL}`,
  keys: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
});

// slocabaia.nl, .store, .online and every www all land on the one real address
const CANONICAL_HOST = String(env.CANONICAL_HOST || '').trim().toLowerCase();
const ALIAS_HOSTS = new Set(
  [...String(env.ALIAS_HOSTS || '').split(','), CANONICAL_HOST ? `www.${CANONICAL_HOST}` : '']
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h && h !== CANONICAL_HOST),
);

const loginLimit = limiter({ max: 8, windowMs: 15 * 60e3 });
const subscribeLimit = limiter({ max: 6, windowMs: 10 * 60e3 });
const contactLimit = limiter({ max: 5, windowMs: 10 * 60e3 });
const confirmMailLimit = limiter({ max: 3, windowMs: 24 * 3600e3 });
const confirmMailCap = limiter({ max: 300, windowMs: 3600e3 }); // all confirmation mail together

/** name+tag@ and (at Gmail) n.a.m.e@ reach one inbox, so they share one confirmation-mail budget */
function mailboxKey(email) {
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at).replace(/\+.*$/, '');
  let domain = email.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

const EMAIL_RE = /^[^\s@<>()"',;:]{1,64}@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|headless|lighthouse/i;
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
const iso = () => new Date().toISOString();
const dayKey = (t) => DAY_FMT.format(new Date(t));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
// Only these folders (plus index.html) are ever served. server/, data/, .env and the rest are not.
const PUBLIC_DIRS = ['img', 'admin'].map((d) => join(ROOT, d) + sep);
const ADMIN_DIR = join(ROOT, 'admin') + sep;
const ADMIN_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' about:; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

/* ---------------------------------------------------------------- helpers */

const page = (res, status, markup) =>
  send(res, status, markup, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}
const notFound = (res) => page(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found.</p>');

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

async function readForm(req) {
  if (String(req.headers['content-type'] || '').includes('application/json')) return readJson(req);
  return Object.fromEntries(new URLSearchParams(await readBody(req)));
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* a malformed cookie is simply ignored */
    }
  }
  return out;
}
function clientIp(req) {
  if (TRUST_PROXY) {
    const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}
const isHttps = (req) => PROD || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
function sessionCookie(req, value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

/* ---------------------------------------------------------------- static */

function resolvePublic(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  if (p === '/' || p === '/index.html') return join(ROOT, 'index.html');
  if (p === '/admin/' || p === '/admin/index.html') return join(ROOT, 'admin', 'index.html');
  const abs = resolve(ROOT, `.${p}`);
  return PUBLIC_DIRS.some((d) => abs.startsWith(d)) ? abs : null;
}

async function serveFile(req, res, file, cache) {
  let st;
  try {
    st = await stat(file);
  } catch {
    return notFound(res);
  }
  if (!st.isFile()) return notFound(res);
  const ext = extname(file).toLowerCase();
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': cache || (ext === '.html' ? 'no-cache' : 'public, max-age=86400'),
  };
  if (file.startsWith(ADMIN_DIR)) Object.assign(headers, ADMIN_HEADERS);

  // Range support: Safari will not play a <video> from a server without it.
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    let start = NaN;
    let end = NaN;
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        start = Math.max(0, st.size - Number(m[2]));
        end = st.size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return stream(createReadStream(file, { start, end }), res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  stream(createReadStream(file), res);
}
// pipeline, not pipe: when the browser drops the request (video seeking does this all the time)
// the file handle is closed instead of left open.
const stream = (src, res) => pipeline(src, res, () => {});

/** the one-pager, with the hero and photo row chosen in the dashboard written in */
async function serveIndex(req, res) {
  const html = await site.renderIndex();
  const etag = `"${sha256(html).slice(0, 32)}"`;
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(html) });
  res.end(req.method === 'HEAD' ? undefined : html);
}

/** a bare daily counter for the home page: no cookie, no IP, no id */
function countView(req) {
  if (req.method !== 'GET') return;
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT_RE.test(ua)) return;
  if (!String(req.headers.accept || '').includes('text/html')) return;
  if (String(req.headers['sec-purpose'] || req.headers.purpose || '').includes('prefetch')) return;
  db.prepare(
    'INSERT INTO pageviews (day, path, count) VALUES (?, ?, 1) ON CONFLICT(day, path) DO UPDATE SET count = count + 1',
  ).run(dayKey(Date.now()), '/');
}

/* ---------------------------------------------------------------- members */

async function subscribe(req, res) {
  if (!subscribeLimit.take(clientIp(req))) {
    return json(res, 429, { ok: false, error: 'Too many attempts. Try again in a few minutes.' });
  }
  const body = await readForm(req);
  if (body.company) return json(res, 200, { ok: true }); // honeypot filled in: a bot, pretend it worked
  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return json(res, 400, { ok: false, error: 'That email address does not look right.' });
  }

  const now = iso();
  let sub = db.prepare('SELECT id, status, token FROM subscribers WHERE email = ?').get(email);
  // An active member gets the same answer as everyone else, so the form reveals nothing.
  if (sub && sub.status === 'active') return json(res, 200, { ok: true });
  // A few confirmation mails per inbox per day at most, so nobody can flood a stranger's inbox.
  if (!confirmMailLimit.take(mailboxKey(email)) || !confirmMailCap.take('all')) return json(res, 200, { ok: true });

  const token = newToken();
  if (!sub) {
    const r = db
      .prepare("INSERT INTO subscribers (email, status, token, source, created_at) VALUES (?, 'pending', ?, 'site', ?)")
      .run(email, token, now);
    sub = { id: Number(r.lastInsertRowid) };
  } else {
    // a fresh token, so an older confirmation link cannot be replayed
    db.prepare("UPDATE subscribers SET status = 'pending', token = ?, unsubscribed_at = NULL WHERE id = ?").run(token, sub.id);
  }
  // Answer first, mail after: every valid address gets the same reply at the same speed, so
  // neither the timing nor the status code tells whether an address is already a member.
  json(res, 200, { ok: true });
  mailer
    .send(renderConfirmEmail({ to: email, url: `${SITE_URL}/api/confirm?t=${token}` }))
    .catch((err) => console.error('[subscribe] confirmation mail failed:', err.message));
}

function confirm(req, res, url) {
  const t = url.searchParams.get('t') || '';
  const sub = TOKEN_RE.test(t) ? db.prepare('SELECT id, status FROM subscribers WHERE token = ?').get(t) : null;
  if (sub && sub.status === 'pending') {
    db.prepare("UPDATE subscribers SET status = 'active', confirmed_at = ? WHERE id = ?").run(iso(), sub.id);
  }
  redirect(res, sub && sub.status !== 'unsubscribed' ? '/?member=confirmed#member' : '/?member=invalid#member');
}

function unsubscribePage(req, res, url) {
  const t = url.searchParams.get('t') || '';
  const sub = TOKEN_RE.test(t) ? db.prepare('SELECT status FROM subscribers WHERE token = ?').get(t) : null;
  const state = !sub ? 'invalid' : sub.status === 'unsubscribed' ? 'done' : 'ask';
  page(res, sub ? 200 : 404, renderUnsubscribePage({ state, token: t }));
}

// Also the target of RFC 8058 one-click unsubscribes that mail providers POST on a person's behalf.
async function unsubscribe(req, res, url) {
  await readBody(req, 4096).catch(() => '');
  const t = url.searchParams.get('t') || '';
  const sub = TOKEN_RE.test(t) ? db.prepare('SELECT id, status FROM subscribers WHERE token = ?').get(t) : null;
  if (sub && sub.status !== 'unsubscribed') {
    db.prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ?").run(iso(), sub.id);
  }
  page(res, sub ? 200 : 404, renderUnsubscribePage({ state: sub ? 'done' : 'invalid', token: t }));
}

/* ---------------------------------------------------------------- contact form */

const unreadCount = () => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL AND spam = 0').get().n;

async function contact(req, res) {
  if (!contactLimit.take(clientIp(req))) {
    return json(res, 429, { ok: false, error: 'Too many messages. Try again in a few minutes.' });
  }
  const b = await readForm(req);
  const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const email = String(b.email ?? '').trim().toLowerCase();
  const body = String(b.message ?? '').replace(/\r\n?/g, '\n').trim();
  if (!name) return json(res, 400, { ok: false, error: 'Tell us your name.' });
  if (email.length > 254 || !EMAIL_RE.test(email)) return json(res, 400, { ok: false, error: 'That email address does not look right.' });
  if (body.length < 2) return json(res, 400, { ok: false, error: 'Write a message first.' });
  if (body.length > 5000) return json(res, 400, { ok: false, error: 'Keep the message under 5000 characters.' });
  // A filled-in honeypot is kept but marked, so a real message caught by it can still be found.
  const spam = b.website ? 1 : 0;
  const r = db
    .prepare('INSERT INTO messages (name, email, body, created_at, spam) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, body, iso(), spam);
  const id = Number(r.lastInsertRowid);
  console.log(`[contact] saved #${id}${spam ? ' as possible spam' : ''}`);
  json(res, 200, { ok: true });
  if (spam) return;
  const url = `/admin/#messages/${id}`;
  push.notify({ title: `Nieuw bericht van ${name}`, body: body.replace(/\s+/g, ' ').slice(0, 180), url, tag: `msg-${id}` });
  mailer
    .send(renderContactAlert({ to: ADMIN_EMAIL, name, email, body, url: `${SITE_URL}${url}` }))
    .catch((err) => console.error('[contact] alert mail failed:', err.message));
}

function listMessages(req, res, url) {
  const limit = clampInt(url.searchParams.get('limit'), 1, 500, 200);
  json(res, 200, {
    rows: db.prepare('SELECT id, name, email, body, created_at, read_at, spam FROM messages ORDER BY id DESC LIMIT ?').all(limit),
    unread: unreadCount(),
    total: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
  });
}

async function markMessage(req, res, url, m) {
  const { read } = await readJson(req);
  const r = db.prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(read === false ? null : iso(), Number(m[1]));
  if (!r.changes) throw new HttpError(404, 'Message not found');
  json(res, 200, { ok: true, unread: unreadCount() });
}

function deleteMessage(req, res, url, m) {
  const r = db.prepare('DELETE FROM messages WHERE id = ?').run(Number(m[1]));
  if (!r.changes) throw new HttpError(404, 'Message not found');
  json(res, 200, { ok: true, unread: unreadCount() });
}

/* ---------------------------------------------------------------- notifications (web push) */

async function pushSubscribe(req, res) {
  const b = await readJson(req);
  if (!push.subscribe(b.subscription, b.label)) throw new HttpError(400, 'That is not a valid push subscription.');
  json(res, 200, { ok: true, devices: push.count() });
}

async function pushUnsubscribe(req, res) {
  const b = await readJson(req);
  push.unsubscribe(b.endpoint);
  json(res, 200, { ok: true, devices: push.count() });
}

async function pushTest(req, res) {
  const sent = await push.notify({
    title: 'Slocabaia',
    body: 'Meldingen staan aan. Zo komt een nieuw bericht van de site binnen.',
    url: '/admin/#messages',
    tag: 'test',
  });
  json(res, 200, { ok: true, sent });
}

/* ---------------------------------------------------------------- admin auth */

function hasSession(req) {
  const tok = parseCookies(req)[COOKIE];
  if (!tok || tok.length > 100) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha256(tok));
  return Boolean(row && row.expires_at > iso());
}

// State-changing admin calls need a custom header (a cross-site form cannot send one without a
// CORS preflight, which this server never answers) and, when present, a matching Origin.
function checkCsrf(req) {
  if (req.headers['x-sloca-admin'] !== '1') throw new HttpError(403, 'Refused');
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      /* unparseable origin is refused below */
    }
    if (host !== req.headers.host) throw new HttpError(403, 'Refused');
  }
}

const admin = (fn) => (req, res, url, m) => {
  if (!hasSession(req)) throw new HttpError(401, 'Not signed in');
  if (req.method !== 'GET' && req.method !== 'HEAD') checkCsrf(req);
  return fn(req, res, url, m);
};

async function login(req, res) {
  const ip = clientIp(req);
  if (!loginLimit.take(ip)) return json(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
  checkCsrf(req);
  const { email = '', password = '' } = await readJson(req);
  const hash = passwordHash();
  if (!hash) return json(res, 503, { error: 'No dashboard password set yet. Open the setup link (npm run admin-link).' });
  const okPassword = verifyPassword(password, hash); // always computed, so timing does not reveal the email check
  if (String(email).trim().toLowerCase() !== ADMIN_EMAIL || !okPassword) {
    return json(res, 401, { error: 'Email or password is wrong.' });
  }
  loginLimit.reset(ip);
  startSession(req, res);
  json(res, 200, { ok: true, email: ADMIN_EMAIL });
}

function startSession(req, res) {
  const token = newToken();
  const now = new Date();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    now.toISOString(),
    new Date(now.getTime() + SESSION_DAYS * 864e5).toISOString(),
  );
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_DAYS * 86400));
}

/** lets the login screen say so when no password exists yet */
function adminStatus(req, res) {
  json(res, 200, { passwordSet: Boolean(passwordHash()) });
}

/** A one-time setup link (made with npm run admin-link, valid 48 hours) lets the owner choose
    or reset the password. Without a valid link nobody can set one. */
async function setup(req, res) {
  const ip = clientIp(req);
  if (!loginLimit.take(ip)) return json(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
  checkCsrf(req);
  const { token = '', password = '' } = await readJson(req);
  if (ENV_HASH) return json(res, 409, { error: 'The password is managed on the server (ADMIN_PASSWORD_HASH).' });
  const s = getSetting('admin_setup');
  const valid = s && typeof token === 'string' && TOKEN_RE.test(token) && s.hash === sha256(token) && s.expires > iso();
  if (!valid) return json(res, 410, { error: 'This link has expired or was already used.' });
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
    return json(res, 400, { error: 'Choose a password of at least 12 characters.' });
  }
  putSetting('admin_password', { hash: hashPassword(password), set_at: iso() });
  delSetting('admin_setup');
  db.prepare('DELETE FROM sessions').run(); // a new password signs every other device out
  loginLimit.reset(ip);
  startSession(req, res);
  json(res, 200, { ok: true, email: ADMIN_EMAIL });
}

function logout(req, res) {
  const tok = parseCookies(req)[COOKIE];
  if (tok) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(tok));
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  json(res, 200, { ok: true });
}

/* ---------------------------------------------------------------- admin data */

function me(req, res) {
  json(res, 200, {
    email: ADMIN_EMAIL,
    mail: { mode: mailer.mode, from: mailer.from },
    siteUrl: SITE_URL,
    push: { key: push.publicKey, devices: push.count() },
    unread: unreadCount(),
  });
}

function stats(req, res, url) {
  const days = clampInt(url.searchParams.get('days'), 7, 365, 30);
  // step calendar days, not 24-hour blocks, so a daylight-saving change never skips a day
  const [y, mo, d] = dayKey(Date.now()).split('-').map(Number);
  const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(new Date(Date.UTC(y, mo - 1, d - i)).toISOString().slice(0, 10));
  const since = new Date(Date.now() - (days + 1) * 864e5).toISOString();
  const bucket = (rows) => {
    const m = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const { t } of rows) {
      const k = dayKey(t);
      if (k in m) m[k] += 1;
    }
    return keys.map((k) => m[k]);
  };
  const count = (s) => db.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE status = ?').get(s).n;
  const pv = Object.fromEntries(
    db.prepare('SELECT day, SUM(count) AS n FROM pageviews WHERE day >= ? GROUP BY day').all(keys[0]).map((r) => [r.day, r.n]),
  );
  const camp = db
    .prepare(
      "SELECT COUNT(*) AS n, MAX(sent_at) AS last, COALESCE(SUM(sent), 0) AS emails, COALESCE(SUM(failed), 0) AS failed FROM campaigns WHERE status IN ('sending', 'sent', 'failed')",
    )
    .get();
  json(res, 200, {
    days: keys,
    members: { active: count('active'), pending: count('pending'), unsubscribed: count('unsubscribed') },
    joined: bucket(db.prepare('SELECT confirmed_at AS t FROM subscribers WHERE confirmed_at >= ?').all(since)),
    left: bucket(db.prepare('SELECT unsubscribed_at AS t FROM subscribers WHERE unsubscribed_at >= ?').all(since)),
    pageviews: keys.map((k) => pv[k] || 0),
    pageviewsAllTime: db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM pageviews').get().n,
    campaigns: { sent: camp.n, last: camp.last, emails: camp.emails, failed: camp.failed },
    mail: { mode: mailer.mode },
  });
}

function listSubscribers(req, res, url) {
  const status = url.searchParams.get('status');
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
  const offset = clampInt(url.searchParams.get('offset'), 0, 1e9, 0);
  const where = [];
  const args = [];
  if (['active', 'pending', 'unsubscribed'].includes(status)) {
    where.push('status = ?');
    args.push(status);
  }
  if (q) {
    where.push("email LIKE ? ESCAPE '\\'");
    args.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM subscribers ${w}`).get(...args).n;
  const rows = db
    .prepare(
      `SELECT id, email, status, created_at, confirmed_at, unsubscribed_at FROM subscribers ${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);
  json(res, 200, { total, rows });
}

function exportCsv(req, res) {
  const rows = db.prepare("SELECT email, confirmed_at FROM subscribers WHERE status = 'active' ORDER BY confirmed_at").all();
  // a leading = + - @ would make a spreadsheet run it as a formula
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const body = `email,confirmed_at\r\n${rows.map((r) => [r.email, r.confirmed_at].map(cell).join(',')).join('\r\n')}\r\n`;
  send(res, 200, body, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="slocabaia-members-${dayKey(Date.now())}.csv"`,
    'Cache-Control': 'no-store',
  });
}

function deleteSubscriber(req, res, url, m) {
  const r = db.prepare('DELETE FROM subscribers WHERE id = ?').run(Number(m[1]));
  if (!r.changes) throw new HttpError(404, 'Member not found');
  json(res, 200, { ok: true });
}

/* ---------------------------------------------------------------- newsletters */

function campaignInput(body) {
  const subject = String(body.subject ?? '').trim();
  const preheader = String(body.preheader ?? '').trim();
  const content = String(body.body ?? '');
  if (!subject || subject.length > 200) throw new HttpError(400, 'A subject is required (max 200 characters).');
  if (preheader.length > 200) throw new HttpError(400, 'The preview text is max 200 characters.');
  if (content.length > 50000) throw new HttpError(400, 'The message is too long.');
  return { subject, preheader, body: content };
}
function campaignRow(id) {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'Newsletter not found');
  return c;
}

function listCampaigns(req, res) {
  json(res, 200, {
    rows: db
      .prepare('SELECT id, subject, status, recipients, sent, failed, created_at, updated_at, sent_at FROM campaigns ORDER BY id DESC')
      .all(),
  });
}
async function createCampaign(req, res) {
  const c = campaignInput(await readJson(req));
  const now = iso();
  const r = db
    .prepare('INSERT INTO campaigns (subject, preheader, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(c.subject, c.preheader, c.body, now, now);
  json(res, 201, campaignRow(Number(r.lastInsertRowid)));
}
function getCampaign(req, res, url, m) {
  json(res, 200, campaignRow(Number(m[1])));
}
async function updateCampaign(req, res, url, m) {
  const current = campaignRow(Number(m[1]));
  if (current.status !== 'draft') throw new HttpError(409, 'This newsletter has already been sent.');
  const c = campaignInput(await readJson(req));
  db.prepare('UPDATE campaigns SET subject = ?, preheader = ?, body = ?, updated_at = ? WHERE id = ?').run(
    c.subject,
    c.preheader,
    c.body,
    iso(),
    current.id,
  );
  json(res, 200, campaignRow(current.id));
}
function deleteCampaign(req, res, url, m) {
  const c = campaignRow(Number(m[1]));
  if (c.status !== 'draft') throw new HttpError(409, 'Sent newsletters stay in the history.');
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(c.id);
  json(res, 200, { ok: true });
}
async function preview(req, res) {
  const b = await readJson(req);
  const { html } = renderNewsletter({
    subject: String(b.subject || 'Subject'),
    preheader: String(b.preheader || ''),
    body: String(b.body || ''),
    unsubscribeUrl: `${SITE_URL}/u`,
  });
  json(res, 200, { html });
}
async function testCampaign(req, res, url, m) {
  const c = campaignRow(Number(m[1]));
  const mail = renderNewsletter({ subject: c.subject, preheader: c.preheader, body: c.body, unsubscribeUrl: `${SITE_URL}/u` });
  const r = await mailer.send({ to: ADMIN_EMAIL, subject: `[Test] ${c.subject}`, html: mail.html, text: mail.text });
  json(res, 200, { ok: true, to: ADMIN_EMAIL, mode: mailer.mode, id: r.id });
}
async function sendCampaign(req, res, url, m) {
  const c = campaignRow(Number(m[1]));
  if (c.status !== 'draft') throw new HttpError(409, 'This newsletter has already been sent.');
  const { confirm: typed } = await readJson(req);
  const n = db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active'").get().n;
  if (n === 0) throw new HttpError(409, 'There are no active members yet.');
  // the admin types the number of recipients, so a wrong click cannot mail everyone.
  // Only a real number counts: Number(true) is 1, which would wave through a list of one.
  const typedN =
    typeof typed === 'number' ? typed : typeof typed === 'string' && /^\s*\d+\s*$/.test(typed) ? Number(typed) : NaN;
  if (typedN !== n) throw new HttpError(409, `Type the number of members (${n}) to confirm.`);
  const upd = db
    .prepare("UPDATE campaigns SET status = 'sending', recipients = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
    .run(n, iso(), c.id);
  if (upd.changes !== 1) throw new HttpError(409, 'This newsletter is already being sent.');
  json(res, 202, { ok: true, recipients: n, mode: mailer.mode });
  runSend(c.id).catch((err) => console.error('[send]', c.id, err));
}

function updateCounts(id) {
  const r = db
    .prepare(
      "SELECT COALESCE(SUM(status IN ('sent', 'logged')), 0) AS sent, COALESCE(SUM(status = 'failed'), 0) AS failed FROM deliveries WHERE campaign_id = ?",
    )
    .get(id);
  db.prepare('UPDATE campaigns SET sent = ?, failed = ? WHERE id = ?').run(r.sent, r.failed, id);
  return r;
}

// Sends to every active member without a delivery row for this newsletter yet, so a restart
// mid-send simply resumes where it stopped, and nobody gets it twice.
const running = new Set();
async function runSend(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const c = campaignRow(id);
    const pick = db.prepare(
      `SELECT s.id, s.email, s.token FROM subscribers s
       WHERE s.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.campaign_id = ? AND d.subscriber_id = s.id)
       ORDER BY s.id LIMIT ?`,
    );
    const record = db.prepare(
      'INSERT INTO deliveries (campaign_id, subscriber_id, status, provider_id, error, at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    let throttled = 0;
    for (;;) {
      const batch = pick.all(id, BATCH);
      if (!batch.length) break;
      const mails = batch.map((s) => {
        const unsub = `${SITE_URL}/u?t=${s.token}`;
        const r = renderNewsletter({ subject: c.subject, preheader: c.preheader, body: c.body, unsubscribeUrl: unsub });
        return {
          to: s.email,
          subject: c.subject,
          html: r.html,
          text: r.text,
          headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        };
      });
      let results = null;
      let error = null;
      try {
        results = await mailer.sendBatch(mails);
      } catch (err) {
        error = err;
      }
      if (error && error.status === 429 && throttled < 6) {
        throttled += 1;
        await sleep(2000 * throttled); // rate limited: wait and retry the same batch
        continue;
      }
      throttled = 0;
      const now = iso();
      db.exec('BEGIN');
      try {
        batch.forEach((s, i) => {
          if (error) record.run(id, s.id, 'failed', null, String(error.message).slice(0, 300), now);
          else record.run(id, s.id, results[i]?.logged ? 'logged' : 'sent', results[i]?.id ?? null, null, now);
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      updateCounts(id);
      if (mailer.mode !== 'log') await sleep(BATCH_GAP_MS);
    }
    const { sent, failed } = updateCounts(id);
    db.prepare('UPDATE campaigns SET status = ?, sent_at = ?, updated_at = ? WHERE id = ?').run(
      sent === 0 && failed > 0 ? 'failed' : 'sent',
      iso(),
      iso(),
      id,
    );
  } finally {
    running.delete(id);
  }
}

/* ---------------------------------------------------------------- routes */

const routes = [];
const on = (method, pattern, fn) => routes.push({ method, pattern, fn });

on('GET', /^\/healthz$/, (req, res) => send(res, 200, 'ok', { 'Content-Type': 'text/plain' }));
on('POST', /^\/api\/subscribe$/, subscribe);
on('POST', /^\/api\/contact$/, contact);
on('GET', /^\/api\/confirm$/, confirm);
on('GET', /^\/u$/, unsubscribePage);
on('POST', /^\/u$/, unsubscribe);
on('POST', /^\/api\/admin\/login$/, login);
on('GET', /^\/api\/admin\/status$/, adminStatus);
on('POST', /^\/api\/admin\/setup$/, setup);
on('POST', /^\/api\/admin\/logout$/, logout);
on('GET', /^\/api\/admin\/me$/, admin(me));
on('GET', /^\/api\/admin\/stats$/, admin(stats));
on('GET', /^\/api\/admin\/subscribers$/, admin(listSubscribers));
on('GET', /^\/api\/admin\/subscribers\.csv$/, admin(exportCsv));
on('DELETE', /^\/api\/admin\/subscribers\/(\d+)$/, admin(deleteSubscriber));
on('GET', /^\/api\/admin\/campaigns$/, admin(listCampaigns));
on('POST', /^\/api\/admin\/campaigns$/, admin(createCampaign));
on('GET', /^\/api\/admin\/campaigns\/(\d+)$/, admin(getCampaign));
on('PUT', /^\/api\/admin\/campaigns\/(\d+)$/, admin(updateCampaign));
on('DELETE', /^\/api\/admin\/campaigns\/(\d+)$/, admin(deleteCampaign));
on('POST', /^\/api\/admin\/campaigns\/(\d+)\/test$/, admin(testCampaign));
on('POST', /^\/api\/admin\/campaigns\/(\d+)\/send$/, admin(sendCampaign));
on('POST', /^\/api\/admin\/preview$/, admin(preview));

// contact messages and notifications
on('GET', /^\/api\/admin\/messages$/, admin(listMessages));
on('PUT', /^\/api\/admin\/messages\/(\d+)$/, admin(markMessage));
on('DELETE', /^\/api\/admin\/messages\/(\d+)$/, admin(deleteMessage));
on('POST', /^\/api\/admin\/push\/subscribe$/, admin(pushSubscribe));
on('POST', /^\/api\/admin\/push\/unsubscribe$/, admin(pushUnsubscribe));
on('POST', /^\/api\/admin\/push\/test$/, admin(pushTest));

// the hero and the photo row (server/site.js)
const MB = 1024 * 1024;
on('GET', /^\/api\/admin\/site$/, admin((req, res) => json(res, 200, site.state())));
on('POST', /^\/api\/admin\/hero\/video$/, admin(async (req, res) => json(res, 202, await site.uploadVideo(req))));
on('POST', /^\/api\/admin\/hero\/image$/, admin(async (req, res) => json(res, 200, await site.setHeroImage(await readJson(req, 12 * MB)))));
on('PUT', /^\/api\/admin\/hero$/, admin(async (req, res) => json(res, 200, site.setStill(await readJson(req)))));
on('DELETE', /^\/api\/admin\/hero$/, admin(async (req, res) => json(res, 200, await site.resetHero())));
on('POST', /^\/api\/admin\/gallery$/, admin(async (req, res) => json(res, 201, await site.addPhoto(await readJson(req, 16 * MB)))));
on('POST', /^\/api\/admin\/gallery\/order$/, admin(async (req, res) => json(res, 200, site.orderPhotos(await readJson(req)))));
on('PUT', /^\/api\/admin\/gallery\/([a-z0-9-]{1,40})$/, admin(async (req, res, url, m) => json(res, 200, site.updatePhoto(m[1], await readJson(req)))));
on('DELETE', /^\/api\/admin\/gallery\/([a-z0-9-]{1,40})$/, admin(async (req, res, url, m) => json(res, 200, await site.deletePhoto(m[1]))));

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'Bad request');
  }
  const path = url.pathname;
  // slocabaia.nl, .store, .online and www: a permanent redirect to the same page on the .com
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (CANONICAL_HOST && host !== CANONICAL_HOST && ALIAS_HOSTS.has(host)) {
    res.writeHead(301, { Location: `https://${CANONICAL_HOST}${path}${url.search}`, 'Cache-Control': 'public, max-age=3600' });
    return res.end();
  }
  if (PROD && CANONICAL_HOST && host === CANONICAL_HOST) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = r.pattern.exec(path);
      if (m) return await r.fn(req, res, url, m);
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    if (path === '/admin') return redirect(res, '/admin/', 301);
    if (path === '/' || path === '/index.html') {
      countView(req);
      return await serveIndex(req, res);
    }
    // uploaded hero films and photos: unique names, so they can be cached for good
    if (path.startsWith('/media/')) {
      const media = site.mediaFile(path.slice(7));
      return media ? await serveFile(req, res, media, 'public, max-age=31536000, immutable') : notFound(res);
    }
    const file = resolvePublic(path);
    if (!file) return notFound(res);
    return await serveFile(req, res, file);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[error]', req.method, path, err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
    else res.end();
  }
});

// A phone video can take many minutes to upload, longer than Node's 5-minute default for a
// whole request; a connection that goes quiet is still cut after two idle minutes.
server.requestTimeout = 30 * 60e3;
server.timeout = 2 * 60e3;

// newsletters that were mid-send when the server stopped carry on
for (const { id } of db.prepare("SELECT id FROM campaigns WHERE status = 'sending'").all()) {
  runSend(id).catch((err) => console.error('[resume]', id, err));
}

server.listen(PORT, env.HOST || '0.0.0.0', () => {
  const warn = passwordHash() ? '' : '  |  no dashboard password yet: run npm run admin-link';
  console.log(`Slocabaia on ${SITE_URL}  |  mail: ${mailer.mode === 'log' ? 'test mode (data/outbox)' : 'Resend'}${warn}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
