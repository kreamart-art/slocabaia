// End-to-end tests for server/index.js. Zero dependencies: node:test, node:assert, node:http, node:sqlite.
//
// Every group starts its own server as a child process on a free high port with a fresh temporary
// DATA_DIR, a throwaway dashboard password (hashed with server/auth.js) and RESEND_API_KEY forced
// to an empty string, so the mailer runs in test mode and writes to DATA_DIR/outbox only. A group
// refuses to run if the server does not report test mode. Every server is killed afterwards.
//
// Run: node --test test/
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../server/auth.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PASSWORD = `throwaway-${randomBytes(12).toString('base64url')}`;
const PASSWORD_HASH = hashPassword(PASSWORD);
const ADMIN_EMAIL = 'slocabaia@gmail.com'; // the server default; test mode only ever writes it to a file
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
const today = () => DAY_FMT.format(new Date());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
};

/* ------------------------------------------------------------------ harness */

const children = new Set();
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

function freePort() {
  return new Promise((ok, fail) => {
    const s = net.createServer();
    s.unref();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

function rawRequest(port, method, path, { headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const h = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k.toLowerCase()] = v;
    let payload = body;
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body);
      h['content-type'] ??= 'application/json';
    }
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', fail);
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        ok({ status: res.statusCode, headers: res.headers, buf, text, json });
      });
    });
    r.on('error', fail);
    r.setTimeout(15000, () => r.destroy(new Error(`timeout: ${method} ${path}`)));
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

async function waitFor(fn, { timeout = 10000, every = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
    await sleep(every);
  }
}

async function startServer({ trustProxy = false, dataDir } = {}) {
  const port = await freePort();
  const dir = dataDir || mkdtempSync(join(tmpdir(), 'sloca-test-'));
  const siteUrl = `http://localhost:${port}`;
  // A minimal, explicit environment: nothing from the caller's shell (such as a real
  // RESEND_API_KEY) leaks in, and an empty RESEND_API_KEY also beats any value in a .env file.
  const env = {
    PATH: process.env.PATH,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    SITE_URL: siteUrl,
    ADMIN_EMAIL: '',
    ADMIN_PASSWORD_HASH: PASSWORD_HASH,
    RESEND_API_KEY: '',
    MAIL_FROM: 'Slocabaia Test <test@slocabaia.invalid>',
    MAIL_REPLY_TO: '',
    TRUST_PROXY: trustProxy ? '1' : '0',
    NODE_ENV: 'test',
  };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  let exited = null;
  const exit = new Promise((r) =>
    child.on('exit', (code, sig) => {
      exited = { code, sig };
      children.delete(child);
      r();
    }),
  );

  const S = {
    port,
    dataDir: dir,
    siteUrl,
    child,
    get log() {
      return log;
    },
    req: (method, path, opts) => rawRequest(port, method, path, opts),
    /** read-only SQL against the server's database file */
    q(sql, ...args) {
      const db = new DatabaseSync(join(dir, 'slocabaia.db'), { readOnly: true });
      try {
        return db.prepare(sql).all(...args);
      } finally {
        db.close();
      }
    },
    async stop({ keepData = false } = {}) {
      if (!exited) {
        child.kill('SIGTERM');
        const t = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exit;
        clearTimeout(t);
      }
      if (!keepData) rmSync(dir, { recursive: true, force: true });
    },
  };

  try {
    await waitFor(
      async () => {
        if (exited) throw new Error(`server exited early (${JSON.stringify(exited)}):\n${log}`);
        const r = await S.req('GET', '/healthz');
        return r.status === 200 && r.text === 'ok' && log.includes('Slocabaia on');
      },
      { timeout: 15000, what: 'GET /healthz' },
    );
    // Safety net: never run a single test against a server that could send real mail.
    if (!log.includes('mail: test mode')) throw new Error(`server is not in mail test mode, refusing to test:\n${log}`);
  } catch (err) {
    await S.stop({ keepData: Boolean(dataDir) });
    throw err;
  }
  return S;
}

/* ------------------------------------------------------------------ app helpers */

let ipCounter = 0;
/** a fresh client address per call (only honoured when the server runs with TRUST_PROXY=1) */
const nextIp = () => {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

async function subscribe(S, body, { ip = nextIp(), headers = {} } = {}) {
  const r = await S.req('POST', '/api/subscribe', { body, headers: { 'x-forwarded-for': ip, ...headers } });
  await outboxSettled(S);
  return r;
}

/** the confirmation mail goes out after the reply, so wait until the outbox stops changing */
async function outboxSettled(S) {
  let last = -1;
  let steady = 0;
  for (let i = 0; i < 80 && steady < 2; i++) {
    await sleep(20);
    const n = outbox(S).length;
    steady = n === last ? steady + 1 : 0;
    last = n;
  }
}

/** every mail in the outbox, oldest first, with the To/Subject note the test mailer writes on top */
function outbox(S) {
  const dir = join(S.dataDir, 'outbox');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(dir, file), 'utf8');
      return { file, to: /^To: (.*)$/m.exec(raw)?.[1], subject: /^Subject: (.*)$/m.exec(raw)?.[1], html: raw };
    });
}
const mailsTo = (S, email) => outbox(S).filter((m) => m.to === email);
function confirmLinkOf(mail) {
  const m = /href="([^"]*\/api\/confirm\?t=[^"]+)"/.exec(mail?.html || '');
  return m ? m[1].replace(/&amp;/g, '&') : null;
}
const subRow = (S, email) => S.q('SELECT * FROM subscribers WHERE email = ?', email)[0];
const pathOf = (link) => {
  const u = new URL(link);
  return u.pathname + u.search;
};

/** subscribe and confirm through the real flow: form, outbox mail, link */
async function join_(S, email) {
  const r = await subscribe(S, { email });
  assert.equal(r.status, 200, `subscribe ${email}: ${r.text}`);
  const link = confirmLinkOf(mailsTo(S, email).at(-1));
  assert.ok(link, `no confirmation mail for ${email}`);
  const c = await S.req('GET', pathOf(link));
  assert.equal(c.status, 303);
  const row = subRow(S, email);
  assert.equal(row.status, 'active');
  await sleep(2); // outbox file names carry a millisecond stamp
  return row;
}

async function login(S, email = ADMIN_EMAIL, password = PASSWORD, extra = {}) {
  return S.req('POST', '/api/admin/login', { body: { email, password }, headers: { 'x-sloca-admin': '1', ...extra } });
}
function cookieOf(res) {
  const sc = [].concat(res.headers['set-cookie'] || []);
  const c = sc.find((s) => s.startsWith('sloca_admin='));
  return c ? c.split(';')[0] : null;
}
/** an admin client bound to a session cookie; sends the CSRF header unless told otherwise */
const adminClient =
  (S, cookie) =>
  (method, path, body, headers = {}) =>
    S.req(method, path, { body, headers: { cookie, 'x-sloca-admin': '1', ...headers } });

/* ================================================================== static files */

describe('static files', () => {
  let S;
  const VIDEO = join(ROOT, 'img', 'hero-720.mp4');
  before(async () => {
    S = await startServer();
  });
  after(() => S?.stop());

  test('GET / serves the page with the hero and photos written in, and a nosniff header', async () => {
    const r = await S.req('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(Number(r.headers['content-length']), r.buf.length);
    assert.match(r.text, /<!-- hero:start -->[\s\S]*id="herovid"[\s\S]*<!-- hero:end -->/);
    assert.match(r.text, /<!-- gallery:start -->[\s\S]*class="looks__item"[\s\S]*<!-- gallery:end -->/);
    assert.ok(r.headers.etag, 'the page carries an ETag');
    assert.equal(r.headers['set-cookie'], undefined, 'the home page sets no cookie');
  });

  test('GET /index.html and HEAD / work', async () => {
    const a = await S.req('GET', '/index.html');
    assert.equal(a.status, 200);
    const h = await S.req('HEAD', '/');
    assert.equal(h.status, 200);
    assert.equal(h.buf.length, 0);
    assert.equal(Number(h.headers['content-length']), a.buf.length);
  });

  test('GET /img/* serves files with the right type', async () => {
    const r = await S.req('GET', '/img/favicon.svg');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/svg+xml');
    assert.deepEqual(r.buf, readFileSync(join(ROOT, 'img', 'favicon.svg')));
    const j = await S.req('HEAD', '/img/og.jpg');
    assert.equal(j.status, 200);
    assert.equal(j.headers['content-type'], 'image/jpeg');
    const missing = await S.req('GET', '/img/does-not-exist.png');
    assert.equal(missing.status, 404);
  });

  test('GET /healthz', async () => {
    const r = await S.req('GET', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'ok');
  });

  test('/admin redirects to /admin/, which is served with dashboard headers when it exists', async () => {
    const r = await S.req('GET', '/admin');
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, '/admin/');
    const d = await S.req('GET', '/admin/');
    if (existsSync(join(ROOT, 'admin', 'index.html'))) {
      assert.equal(d.status, 200);
      assert.equal(d.headers['x-frame-options'], 'DENY');
      assert.equal(d.headers['cache-control'], 'no-store');
      assert.match(d.headers['x-robots-tag'], /noindex/);
      assert.match(d.headers['content-security-policy'], /frame-ancestors 'none'/);
    } else {
      assert.equal(d.status, 404);
    }
  });

  test('unknown API paths are JSON 404, non-GET on pages is 405', async () => {
    const a = await S.req('GET', '/api/nope');
    assert.equal(a.status, 404);
    assert.deepEqual(a.json, { error: 'Not found' });
    const b = await S.req('POST', '/', { body: 'x=1' });
    assert.equal(b.status, 405);
  });

  const LEAK = /createServer|ADMIN_PASSWORD_HASH|scrypt|"name": "slocabaia"|root:|RESEND_API_KEY|CREATE TABLE|SQLite format/;
  const forbidden = [
    '/server/index.js',
    '/server/auth.js',
    '/server/',
    '/server',
    '/data/slocabaia.db',
    '/data/',
    '/data/outbox/',
    '/.env',
    '/.env.example',
    '/package.json',
    '/Dockerfile',
    '/.gitignore',
    '/.dockerignore',
    '/test/server.test.mjs',
    '/img',
    '/img/',
    '/IMG/favicon.svg',
    '/Server/index.js',
    '/INDEX.HTML',
  ];
  for (const p of forbidden) {
    test(`404 for ${p}`, async () => {
      const r = await S.req('GET', p);
      assert.equal(r.status, 404, `${p} answered ${r.status}`);
      assert.doesNotMatch(r.text, LEAK);
    });
  }

  const traversal = [
    '/img/../server/index.js',
    '/img/../../../../etc/passwd',
    '/admin/../.env',
    '/img/%2e%2e/server/index.js',
    '/img/%2E%2E/%2E%2E/%2E%2E/etc/passwd',
    '/%2e%2e/package.json',
    '/img/..%2fserver%2findex.js',
    '/img/..%2f..%2f..%2f..%2fetc%2fpasswd',
    '/img%2f..%2fserver%2findex.js',
    '/img%2F..%2F.env',
    '/admin/..%2f.env',
    '/admin/%2e%2e%2fpackage.json',
    '/..%2fpackage.json',
    '/img/%252e%252e/server/index.js',
    '/img/..%5c..%5cserver%5cindex.js',
    '/img/..\\server\\index.js',
    '/img/favicon.svg%00.js',
    '/img/%00',
    '/img/%E0%A4%A',
    '//etc/passwd',
    '/./server/index.js',
    '/img/./../package.json',
  ];
  for (const p of traversal) {
    test(`traversal refused: ${p}`, async () => {
      const r = await S.req('GET', p);
      assert.equal(r.status, 404, `${p} answered ${r.status}`);
      assert.doesNotMatch(r.text, LEAK);
    });
  }

  test('Range: HEAD without a range advertises byte ranges', async () => {
    const size = statSync(VIDEO).size;
    const r = await S.req('HEAD', '/img/hero-720.mp4');
    assert.equal(r.status, 200);
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers['content-type'], 'video/mp4');
    assert.equal(Number(r.headers['content-length']), size);
  });

  test('Range: 206 with the exact bytes for start-end, open-ended and suffix ranges', async () => {
    const file = readFileSync(VIDEO);
    const size = file.length;
    const cases = [
      ['bytes=0-99', 0, 99],
      ['bytes=1000-1999', 1000, 1999],
      [`bytes=${size - 10}-`, size - 10, size - 1],
      ['bytes=-16', size - 16, size - 1],
      [`bytes=${size - 5}-${size + 1000}`, size - 5, size - 1],
    ];
    for (const [range, start, end] of cases) {
      const r = await S.req('GET', '/img/hero-720.mp4', { headers: { range } });
      assert.equal(r.status, 206, range);
      assert.equal(r.headers['content-range'], `bytes ${start}-${end}/${size}`, range);
      assert.equal(Number(r.headers['content-length']), end - start + 1, range);
      assert.equal(r.headers['content-type'], 'video/mp4');
      assert.deepEqual(r.buf, file.subarray(start, end + 1), range);
    }
    const h = await S.req('HEAD', '/img/hero-720.mp4', { headers: { range: 'bytes=0-9' } });
    assert.equal(h.status, 206);
    assert.equal(h.buf.length, 0);
    assert.equal(h.headers['content-range'], `bytes 0-9/${size}`);
  });

  test('Range: 416 for unsatisfiable ranges', async () => {
    const size = statSync(VIDEO).size;
    for (const range of [`bytes=${size}-`, `bytes=${size + 10}-${size + 20}`, 'bytes=500-100', 'bytes=-0', 'bytes=-']) {
      const r = await S.req('GET', '/img/hero-720.mp4', { headers: { range } });
      assert.equal(r.status, 416, range);
      assert.equal(r.headers['content-range'], `bytes */${size}`, range);
    }
  });
});

/* ================================================================== page views */

describe('page views', () => {
  let S;
  const views = () => S.q('SELECT COALESCE(SUM(count), 0) AS n FROM pageviews')[0].n;
  before(async () => {
    S = await startServer();
  });
  after(() => S?.stop());

  test('non-document, bot, prefetch and HEAD requests are not counted', async () => {
    assert.equal(views(), 0);
    const nope = [
      ['GET', '/', { ...BROWSER, 'user-agent': 'curl/8.7.1' }],
      ['GET', '/', { ...BROWSER, 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }],
      ['GET', '/', { ...BROWSER, 'user-agent': 'facebookexternalhit/1.1' }],
      ['GET', '/', { ...BROWSER, 'user-agent': 'Mozilla/5.0 HeadlessChrome/126.0' }],
      ['GET', '/', { ...BROWSER, 'user-agent': undefined }],
      ['GET', '/', { ...BROWSER, accept: '*/*' }],
      ['GET', '/', { ...BROWSER, accept: undefined }],
      ['GET', '/', { ...BROWSER, accept: 'application/json' }],
      ['GET', '/', { ...BROWSER, 'sec-purpose': 'prefetch' }],
      ['GET', '/', { ...BROWSER, 'sec-purpose': 'prefetch;prerender' }],
      ['GET', '/', { ...BROWSER, purpose: 'prefetch' }],
      ['HEAD', '/', BROWSER],
      ['GET', '/img/favicon.svg', BROWSER],
      ['GET', '/healthz', BROWSER],
      ['GET', '/u?t=x', BROWSER],
      ['GET', '/does-not-exist', BROWSER],
    ];
    for (const [method, path, headers] of nope) {
      const r = await S.req(method, path, { headers });
      assert.ok(r.status < 500, `${method} ${path}`);
    }
    assert.equal(views(), 0);
  });

  test('a browser-like GET / with Accept text/html counts once per request, cookie-free', async () => {
    const a = await S.req('GET', '/', { headers: BROWSER });
    assert.equal(a.status, 200);
    assert.equal(a.headers['set-cookie'], undefined);
    assert.equal(views(), 1);
    await S.req('GET', '/?member=confirmed', { headers: BROWSER });
    await S.req('GET', '/index.html', { headers: { ...BROWSER, accept: 'text/html' } });
    assert.equal(views(), 3);
    const rows = S.q('SELECT day, path, count FROM pageviews');
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ day: today(), path: '/', count: 3 }]);
    // the table has no room for anything identifying
    const cols = S.q('PRAGMA table_info(pageviews)').map((c) => c.name);
    assert.deepEqual(cols.sort(), ['count', 'day', 'path']);
  });
});

/* ================================================================== members */

describe('members: subscribe, confirm, unsubscribe', () => {
  let S;
  before(async () => {
    S = await startServer({ trustProxy: true });
  });
  after(() => S?.stop());

  test('invalid addresses get 400 and nothing is stored', async () => {
    const bad = ['', 'nope', 'a@b', 'a b@example.com', '<x>@example.com', 'x@exa mple.com', 'a@@example.com', 'a@example.c', `${'a'.repeat(250)}@example.com`, 'a"b@example.com'];
    for (const email of bad) {
      const r = await subscribe(S, { email });
      assert.equal(r.status, 400, JSON.stringify(email));
      assert.equal(r.json.ok, false);
      assert.ok(r.json.error);
    }
    const missing = await subscribe(S, {});
    assert.equal(missing.status, 400);
    const badJson = await S.req('POST', '/api/subscribe', { body: '{oops', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() } });
    assert.equal(badJson.status, 400);
    assert.equal(S.q('SELECT COUNT(*) AS n FROM subscribers')[0].n, 0);
    assert.equal(outbox(S).length, 0);
  });

  test('honeypot: a filled-in company field looks like success but stores and sends nothing', async () => {
    const r = await subscribe(S, { email: 'bot@example.com', company: 'Acme BV' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(subRow(S, 'bot@example.com'), undefined);
    assert.equal(mailsTo(S, 'bot@example.com').length, 0);
  });

  test('valid address: {ok:true}, a pending row and a confirmation email with a working link', async () => {
    const r = await subscribe(S, { email: 'ada@example.com', company: '' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(r.headers['cache-control'], 'no-store');
    const row = subRow(S, 'ada@example.com');
    assert.equal(row.status, 'pending');
    assert.equal(row.source, 'site');
    assert.equal(row.confirmed_at, null);
    assert.match(row.token, /^[A-Za-z0-9_-]{40,}$/);

    const mails = mailsTo(S, 'ada@example.com');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].subject, 'Confirm your Slocabaia membership');
    const link = confirmLinkOf(mails[0]);
    assert.equal(link, `${S.siteUrl}/api/confirm?t=${row.token}`);
    assert.ok(mails[0].html.includes('ada@example.com'));
  });

  test('confirm link: 303 to /?member=confirmed#member and the member becomes active', async () => {
    const link = confirmLinkOf(mailsTo(S, 'ada@example.com').at(-1));
    const r = await S.req('GET', pathOf(link));
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/?member=confirmed#member');
    assert.equal(r.headers['cache-control'], 'no-store');
    const row = subRow(S, 'ada@example.com');
    assert.equal(row.status, 'active');
    assert.ok(row.confirmed_at && !Number.isNaN(Date.parse(row.confirmed_at)));

    // clicking twice is harmless and keeps the first confirmation time
    const again = await S.req('GET', pathOf(link));
    assert.equal(again.headers.location, '/?member=confirmed#member');
    assert.equal(subRow(S, 'ada@example.com').confirmed_at, row.confirmed_at);
  });

  test('confirm with a missing, malformed or unknown token redirects to member=invalid', async () => {
    for (const p of ['/api/confirm', '/api/confirm?t=', '/api/confirm?t=short', '/api/confirm?t=' + 'x'.repeat(43), "/api/confirm?t=' OR 1=1 --"].map((p) => p.replace(/ /g, '%20'))) {
      const r = await S.req('GET', p);
      assert.equal(r.status, 303, p);
      assert.equal(r.headers.location, '/?member=invalid#member', p);
    }
  });

  test('an active member subscribing again gets the identical answer and no new mail', async () => {
    const before_ = subRow(S, 'ada@example.com');
    const mailCount = outbox(S).length;
    for (const email of ['ada@example.com', '  ADA@Example.COM ']) {
      const r = await subscribe(S, { email });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
    }
    assert.equal(outbox(S).length, mailCount);
    const after_ = subRow(S, 'ada@example.com');
    assert.equal(after_.status, 'active');
    assert.equal(after_.token, before_.token);
  });

  test('uppercase and whitespace are normalised to one lowercase address', async () => {
    const r = await subscribe(S, { email: '  Mixed.Case@Example.COM  ' });
    assert.equal(r.status, 200);
    assert.equal(S.q("SELECT COUNT(*) AS n FROM subscribers WHERE email LIKE 'mixed.case@example.com'")[0].n, 1);
    const row = S.q("SELECT email FROM subscribers WHERE lower(email) = 'mixed.case@example.com'")[0];
    assert.equal(row.email, 'mixed.case@example.com');
    assert.equal(mailsTo(S, 'mixed.case@example.com').length, 1);
    await sleep(3);
    await subscribe(S, { email: 'MIXED.CASE@EXAMPLE.COM' });
    assert.equal(S.q("SELECT COUNT(*) AS n FROM subscribers WHERE lower(email) = 'mixed.case@example.com'")[0].n, 1);
  });

  test('a form-encoded POST works too (no-JS fallback)', async () => {
    const r = await S.req('POST', '/api/subscribe', {
      body: 'email=form%40example.com&company=',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': nextIp() },
    });
    assert.equal(r.status, 200);
    assert.equal(subRow(S, 'form@example.com').status, 'pending');
  });

  test('re-subscribing while pending rotates the token (old link dies), capped at 3 mails per address', async () => {
    const email = 'pending@example.com';
    await subscribe(S, { email });
    const first = subRow(S, email).token;
    const firstLink = confirmLinkOf(mailsTo(S, email).at(-1));
    await sleep(3);
    await subscribe(S, { email });
    const second = subRow(S, email).token;
    assert.notEqual(second, first);
    const old = await S.req('GET', pathOf(firstLink));
    assert.equal(old.headers.location, '/?member=invalid#member');
    assert.equal(subRow(S, email).status, 'pending');
    await sleep(3);
    await subscribe(S, { email }); // third mail today
    const third = subRow(S, email).token;
    assert.equal(mailsTo(S, email).length, 3);
    await sleep(3);
    const fourth = await subscribe(S, { email }); // over the per-address cap: same answer, nothing sent
    assert.deepEqual(fourth.json, { ok: true });
    assert.equal(subRow(S, email).token, third);
    assert.equal(mailsTo(S, email).length, 3);
    const link = confirmLinkOf(mailsTo(S, email).at(-1));
    assert.ok(link.endsWith(third));
    const ok = await S.req('GET', pathOf(link));
    assert.equal(ok.headers.location, '/?member=confirmed#member');
    assert.equal(subRow(S, email).status, 'active');
  });

  test('GET /u shows the ask page and does not unsubscribe by itself', async () => {
    const { token } = subRow(S, 'ada@example.com');
    const r = await S.req('GET', `/u?t=${token}`, { headers: BROWSER });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.text, /Leave the list\?/);
    assert.ok(r.text.includes(`<form method="post" action="/u?t=${token}">`));
    assert.equal(subRow(S, 'ada@example.com').status, 'active');
  });

  test('GET /u with a bad or missing token is a 404 "link not valid" page', async () => {
    for (const p of ['/u', '/u?t=', '/u?t=nope', `/u?t=${'y'.repeat(43)}`, '/u?t=%3Cscript%3Ealert(1)%3C%2Fscript%3E']) {
      const r = await S.req('GET', p);
      assert.equal(r.status, 404, p);
      assert.match(r.text, /Link not valid/);
      assert.doesNotMatch(r.text, /<script>alert/);
    }
  });

  test('POST /u unsubscribes, is idempotent, and kills the confirm link', async () => {
    const { token } = subRow(S, 'ada@example.com');
    const r = await S.req('POST', `/u?t=${token}`, { body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 200);
    assert.match(r.text, /You are out/);
    const row = subRow(S, 'ada@example.com');
    assert.equal(row.status, 'unsubscribed');
    assert.ok(row.unsubscribed_at);

    const again = await S.req('POST', `/u?t=${token}`);
    assert.equal(again.status, 200);
    assert.equal(subRow(S, 'ada@example.com').unsubscribed_at, row.unsubscribed_at);

    const page = await S.req('GET', `/u?t=${token}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /You are out/);
    assert.doesNotMatch(page.text, /<form/);

    const c = await S.req('GET', `/api/confirm?t=${token}`);
    assert.equal(c.headers.location, '/?member=invalid#member');
    assert.equal(subRow(S, 'ada@example.com').status, 'unsubscribed');

    const bad = await S.req('POST', '/u?t=nope');
    assert.equal(bad.status, 404);
  });

  test('RFC 8058 one-click POST unsubscribes', async () => {
    const row = await join_(S, 'oneclick@example.com');
    const r = await S.req('POST', `/u?t=${row.token}`, {
      body: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mail provider' },
    });
    assert.equal(r.status, 200);
    assert.equal(subRow(S, 'oneclick@example.com').status, 'unsubscribed');
  });

  test('an unsubscribed member can join again: pending with a fresh token, then active', async () => {
    const old = subRow(S, 'ada@example.com');
    await sleep(3);
    const r = await subscribe(S, { email: 'ada@example.com' });
    assert.deepEqual(r.json, { ok: true });
    const row = subRow(S, 'ada@example.com');
    assert.equal(row.status, 'pending');
    assert.notEqual(row.token, old.token);
    assert.equal(row.unsubscribed_at, null);
    const link = confirmLinkOf(mailsTo(S, 'ada@example.com').at(-1));
    assert.ok(link.endsWith(row.token));
    await S.req('GET', pathOf(link));
    assert.equal(subRow(S, 'ada@example.com').status, 'active');
  });
});

/* ================================================================== rate limits */

describe('rate limits (TRUST_PROXY off)', () => {
  let S;
  before(async () => {
    S = await startServer({ trustProxy: false });
  });
  after(() => S?.stop());

  test('subscribe: 429 after 6 attempts per IP, and a spoofed X-Forwarded-For does not help', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await subscribe(S, { email: 'not-an-address' }, { ip: `203.0.113.${i + 1}` });
      assert.equal(r.status, 400, `attempt ${i + 1}`);
    }
    const r = await subscribe(S, { email: 'late@example.com' }, { ip: '198.51.100.77' });
    assert.equal(r.status, 429);
    assert.equal(r.json.ok, false);
    assert.ok(r.json.error);
    assert.equal(subRow(S, 'late@example.com'), undefined);
    assert.equal(mailsTo(S, 'late@example.com').length, 0);
  });

  test('login: 429 after 8 failed attempts, even with the right password', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await login(S, ADMIN_EMAIL, `wrong-${i}`, { 'x-forwarded-for': `203.0.113.${i + 50}` });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
    }
    const r = await login(S);
    assert.equal(r.status, 429);
    assert.equal(cookieOf(r), null);
  });
});

/* ================================================================== admin */

describe('admin dashboard API', () => {
  let S;
  let cookie;
  let A; // admin client with session and CSRF header
  let draftId;
  const ids = {};
  before(async () => {
    S = await startServer({ trustProxy: true });
  });
  after(() => S?.stop());

  /* ---------------------------------------------------------- login */

  test('login without X-Sloca-Admin is 403', async () => {
    const r = await S.req('POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: PASSWORD } });
    assert.equal(r.status, 403);
    assert.equal(cookieOf(r), null);
  });

  test('login from a foreign Origin is 403', async () => {
    const r = await login(S, ADMIN_EMAIL, PASSWORD, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal(cookieOf(r), null);
  });

  test('wrong password or wrong email is 401 with no cookie', async () => {
    const a = await login(S, ADMIN_EMAIL, 'definitely-not-it');
    assert.equal(a.status, 401);
    assert.equal(cookieOf(a), null);
    const b = await login(S, 'someone@else.example', PASSWORD);
    assert.equal(b.status, 401);
    assert.equal(a.json.error, b.json.error, 'the answer does not reveal which half was wrong');
    const c = await login(S, ADMIN_EMAIL, '');
    assert.equal(c.status, 401);
    const d = await S.req('POST', '/api/admin/login', { body: '{bad', headers: { 'x-sloca-admin': '1', 'content-type': 'application/json' } });
    assert.equal(d.status, 400);
  });

  test('right password sets an HttpOnly SameSite=Strict session cookie; only its hash is stored', async () => {
    const r = await login(S, `  ${ADMIN_EMAIL.toUpperCase()} `, PASSWORD, { origin: `http://127.0.0.1:${S.port}` });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true, email: ADMIN_EMAIL });
    const sc = [].concat(r.headers['set-cookie'])[0];
    assert.match(sc, /^sloca_admin=[A-Za-z0-9_-]{40,};/);
    const attrs = sc.split(';').map((s) => s.trim().toLowerCase());
    assert.ok(attrs.includes('httponly'), sc);
    assert.ok(attrs.includes('samesite=strict'), sc);
    assert.ok(attrs.includes('path=/'), sc);
    assert.ok(attrs.includes(`max-age=${7 * 86400}`), sc);
    assert.ok(!attrs.includes('secure'), 'no Secure flag on plain http outside production');
    cookie = cookieOf(r);
    A = adminClient(S, cookie);
    const token = cookie.split('=')[1];
    const sessions = S.q('SELECT token_hash FROM sessions');
    assert.equal(sessions.length, 1);
    assert.notEqual(sessions[0].token_hash, token);
    assert.match(sessions[0].token_hash, /^[0-9a-f]{64}$/);
  });

  const ADMIN_ENDPOINTS = [
    ['GET', '/api/admin/me'],
    ['GET', '/api/admin/stats'],
    ['GET', '/api/admin/stats?days=7'],
    ['GET', '/api/admin/subscribers'],
    ['GET', '/api/admin/subscribers?status=active&q=a'],
    ['GET', '/api/admin/subscribers.csv'],
    ['HEAD', '/api/admin/subscribers.csv'],
    ['DELETE', '/api/admin/subscribers/1'],
    ['GET', '/api/admin/campaigns'],
    ['POST', '/api/admin/campaigns'],
    ['GET', '/api/admin/campaigns/1'],
    ['PUT', '/api/admin/campaigns/1'],
    ['DELETE', '/api/admin/campaigns/1'],
    ['POST', '/api/admin/campaigns/1/test'],
    ['POST', '/api/admin/campaigns/1/send'],
    ['POST', '/api/admin/preview'],
  ];

  test('every admin endpoint is 401 without a (valid) session cookie', async () => {
    for (const badCookie of [undefined, 'sloca_admin=forged-token-value', `sloca_admin=${'a'.repeat(150)}`, 'sloca_admin=', 'other=1']) {
      for (const [method, path] of ADMIN_ENDPOINTS) {
        const body = ['POST', 'PUT'].includes(method) ? { subject: 'x', confirm: 1 } : undefined;
        const r = await S.req(method, path, { body, headers: { 'x-sloca-admin': '1', cookie: badCookie } });
        assert.equal(r.status, 401, `${method} ${path} with cookie ${badCookie}`);
      }
    }
    assert.equal(S.q('SELECT COUNT(*) AS n FROM campaigns')[0].n, 0);
  });

  test('GET me reports the admin, test-mode mail and the site URL', async () => {
    const r = await A('GET', '/api/admin/me');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.json.email, ADMIN_EMAIL);
    assert.deepEqual(r.json.mail, { mode: 'log', from: 'Slocabaia Test <test@slocabaia.invalid>' });
    assert.equal(r.json.siteUrl, S.siteUrl);
    assert.match(r.json.push.key, /^[A-Za-z0-9_-]{87}$/, 'the VAPID public key, base64url of a 65-byte point');
    assert.equal(typeof r.json.push.devices, 'number');
    assert.equal(typeof r.json.unread, 'number');
  });

  test('non-GET admin calls are 403 without X-Sloca-Admin, or with a foreign Origin', async () => {
    const writes = ADMIN_ENDPOINTS.filter(([m]) => m !== 'GET' && m !== 'HEAD');
    const variants = [
      { cookie },
      { cookie, 'x-sloca-admin': '0' },
      { cookie, 'x-sloca-admin': 'true' },
      { cookie, 'x-sloca-admin': '1', origin: 'https://evil.example' },
      { cookie, 'x-sloca-admin': '1', origin: `http://evil.example:${S.port}` },
      { cookie, 'x-sloca-admin': '1', origin: `http://127.0.0.1:${S.port + 1}` },
      { cookie, 'x-sloca-admin': '1', origin: 'null' },
      { cookie, 'x-sloca-admin': '1', origin: 'not a url' },
    ];
    for (const headers of variants) {
      for (const [method, path] of writes) {
        const body = ['POST', 'PUT'].includes(method) ? { subject: 'CSRF', body: 'x', confirm: 0 } : undefined;
        const r = await S.req(method, path, { body, headers });
        assert.equal(r.status, 403, `${method} ${path} with ${JSON.stringify({ ...headers, cookie: '...' })}`);
      }
    }
    assert.equal(S.q('SELECT COUNT(*) AS n FROM campaigns')[0].n, 0, 'nothing was created by a refused call');
    // a same-host Origin is fine
    const ok = await A('POST', '/api/admin/preview', { subject: 'x' }, { origin: `http://127.0.0.1:${S.port}` });
    assert.equal(ok.status, 200);
    // reads do not need the header
    const read = await S.req('GET', '/api/admin/campaigns', { headers: { cookie } });
    assert.equal(read.status, 200);
  });

  /* ---------------------------------------------------------- campaigns (drafts) */

  test('campaigns: empty list, then validation errors on create', async () => {
    const list = await A('GET', '/api/admin/campaigns');
    assert.deepEqual(list.json, { rows: [] });
    const bad = [
      {},
      { subject: '' },
      { subject: '    ' },
      { subject: 'x'.repeat(201) },
      { subject: 'ok', preheader: 'p'.repeat(201) },
      { subject: 'ok', body: 'b'.repeat(50001) },
    ];
    for (const body of bad) {
      const r = await A('POST', '/api/admin/campaigns', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.ok(r.json.error);
    }
    const badJson = await S.req('POST', '/api/admin/campaigns', { body: '{nope', headers: { cookie, 'x-sloca-admin': '1', 'content-type': 'application/json' } });
    assert.equal(badJson.status, 400);
    assert.equal(S.q('SELECT COUNT(*) AS n FROM campaigns')[0].n, 0);
  });

  test('campaigns: create, get, list and update a draft', async () => {
    const c = await A('POST', '/api/admin/campaigns', { subject: '  Drop 07  ', preheader: 'Soon', body: 'Hello **members**' });
    assert.equal(c.status, 201);
    assert.equal(c.json.subject, 'Drop 07');
    assert.equal(c.json.preheader, 'Soon');
    assert.equal(c.json.body, 'Hello **members**');
    assert.equal(c.json.status, 'draft');
    assert.equal(c.json.recipients, 0);
    assert.equal(c.json.sent, 0);
    assert.equal(c.json.failed, 0);
    assert.equal(c.json.sent_at, null);
    draftId = c.json.id;

    const g = await A('GET', `/api/admin/campaigns/${draftId}`);
    assert.equal(g.status, 200);
    assert.deepEqual(g.json, c.json);

    const l = await A('GET', '/api/admin/campaigns');
    assert.equal(l.json.rows.length, 1);
    assert.equal(l.json.rows[0].id, draftId);
    assert.equal(l.json.rows[0].body, undefined, 'the list does not carry the full body');

    await sleep(5);
    const u = await A('PUT', `/api/admin/campaigns/${draftId}`, { subject: 'Drop 07: the house', preheader: 'Doors at nine', body: '# Hi\n\nSee you **there**.' });
    assert.equal(u.status, 200);
    assert.equal(u.json.subject, 'Drop 07: the house');
    assert.equal(u.json.preheader, 'Doors at nine');
    assert.equal(u.json.status, 'draft');
    assert.ok(u.json.updated_at > c.json.updated_at);
    assert.equal(u.json.created_at, c.json.created_at);

    const invalid = await A('PUT', `/api/admin/campaigns/${draftId}`, { subject: '' });
    assert.equal(invalid.status, 400);
    assert.equal((await A('GET', `/api/admin/campaigns/${draftId}`)).json.subject, 'Drop 07: the house');

    for (const [m, p, b] of [
      ['GET', '/api/admin/campaigns/99999'],
      ['PUT', '/api/admin/campaigns/99999', { subject: 'x' }],
      ['DELETE', '/api/admin/campaigns/99999'],
      ['POST', '/api/admin/campaigns/99999/test'],
      ['POST', '/api/admin/campaigns/99999/send', { confirm: 1 }],
    ]) {
      const r = await A(m, p, b);
      assert.equal(r.status, 404, `${m} ${p}`);
    }
  });

  test('preview renders the markdown subset and escapes everything else', async () => {
    const body = [
      '# Drop 07 <script>alert(1)</script>',
      '## Where',
      '- **Amsterdam** [tickets](https://slocabaia.com/drop?a=1&b=2)\n- [bad](javascript:alert(1))\n- <img src=x onerror=alert(1)>',
      'Line one\nLine two',
    ].join('\n\n');
    const r = await A('POST', '/api/admin/preview', { subject: '<b>Hi</b>', preheader: '"quoted" & <tag>', body });
    assert.equal(r.status, 200);
    const { html } = r.json;
    assert.match(html, /<h1[^>]*>Drop 07 &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
    assert.match(html, /<h2[^>]*>Where<\/h2>/);
    assert.match(html, /<ul[^>]*><li[^>]*><strong[^>]*>Amsterdam<\/strong> <a href="https:\/\/slocabaia\.com\/drop\?a=1&amp;b=2"/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /Line one<br>Line two/);
    assert.match(html, /<title>&lt;b&gt;Hi&lt;\/b&gt;<\/title>/);
    assert.ok(html.includes('&quot;quoted&quot; &amp; &lt;tag&gt;'));
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /href="javascript:/i);
    assert.doesNotMatch(html, /<img/i);
    assert.ok(html.includes(`href="${S.siteUrl}/u"`), 'footer has an unsubscribe link');
    const empty = await A('POST', '/api/admin/preview', {});
    assert.equal(empty.status, 200);
    assert.match(empty.json.html, /\(empty\)/);
  });

  test('test send goes to ADMIN_EMAIL only (outbox in test mode) and leaves the draft alone', async () => {
    const before_ = outbox(S).length;
    const r = await A('POST', `/api/admin/campaigns/${draftId}/test`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, to: ADMIN_EMAIL, mode: 'log', id: null });
    const mails = outbox(S);
    assert.equal(mails.length, before_ + 1);
    assert.equal(mails.at(-1).to, ADMIN_EMAIL);
    assert.equal(mails.at(-1).subject, '[Test] Drop 07: the house');
    assert.match(mails.at(-1).html, /See you <strong[^>]*>there<\/strong>/);
    const c = (await A('GET', `/api/admin/campaigns/${draftId}`)).json;
    assert.equal(c.status, 'draft');
    assert.equal(c.sent, 0);
    assert.equal(S.q('SELECT COUNT(*) AS n FROM deliveries')[0].n, 0);
  });

  test('delete a draft', async () => {
    const c = await A('POST', '/api/admin/campaigns', { subject: 'Throwaway draft' });
    const d = await A('DELETE', `/api/admin/campaigns/${c.json.id}`);
    assert.equal(d.status, 200);
    assert.deepEqual(d.json, { ok: true });
    assert.equal((await A('GET', `/api/admin/campaigns/${c.json.id}`)).status, 404);
    assert.equal((await A('DELETE', `/api/admin/campaigns/${c.json.id}`)).status, 404);
  });

  test('send is refused while there are no active members', async () => {
    const r = await A('POST', `/api/admin/campaigns/${draftId}/send`, { confirm: 0 });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /no active members/i);
    assert.equal((await A('GET', `/api/admin/campaigns/${draftId}`)).json.status, 'draft');
  });

  /* ---------------------------------------------------------- members in the dashboard */

  test('setup: members joined through the real flow', async () => {
    for (const email of ['alice@example.com', 'bob@example.com', '=1+2@evil.example', '+cmd@evil.example', '-sum@evil.example', 'under_score@example.com', 'percent%sign@example.com', 'gone@example.com', 'dave@example.com']) {
      ids[email] = (await join_(S, email)).id;
    }
    await subscribe(S, { email: 'carol@example.com' }); // stays pending
    ids['carol@example.com'] = subRow(S, 'carol@example.com').id;
    const dave = subRow(S, 'dave@example.com');
    const u = await S.req('POST', `/u?t=${dave.token}`);
    assert.equal(u.status, 200);
    assert.equal(subRow(S, 'dave@example.com').status, 'unsubscribed');
  });

  test('subscribers: list shape, order and status filter', async () => {
    const r = await A('GET', '/api/admin/subscribers');
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 10);
    assert.equal(r.json.rows.length, 10);
    for (const row of r.json.rows) {
      assert.deepEqual(Object.keys(row).sort(), ['confirmed_at', 'created_at', 'email', 'id', 'status', 'unsubscribed_at']);
    }
    const created = r.json.rows.map((x) => x.created_at);
    assert.deepEqual(created, [...created].sort().reverse(), 'newest first');
    assert.equal(r.json.rows[0].email, 'carol@example.com');

    const active = await A('GET', '/api/admin/subscribers?status=active');
    assert.equal(active.json.total, 8);
    assert.ok(active.json.rows.every((x) => x.status === 'active'));
    const pending = await A('GET', '/api/admin/subscribers?status=pending');
    assert.deepEqual(pending.json.rows.map((x) => x.email), ['carol@example.com']);
    const unsub = await A('GET', '/api/admin/subscribers?status=unsubscribed');
    assert.deepEqual(unsub.json.rows.map((x) => x.email), ['dave@example.com']);
    const bogus = await A('GET', "/api/admin/subscribers?status=x'%20OR%201=1");
    assert.equal(bogus.json.total, 10, 'an unknown status is ignored');
  });

  test('subscribers: search is case-insensitive and treats % and _ literally', async () => {
    const q = async (s, extra = '') => (await A('GET', `/api/admin/subscribers?q=${encodeURIComponent(s)}${extra}`)).json;
    assert.deepEqual((await q('ALICE')).rows.map((x) => x.email), ['alice@example.com']);
    assert.deepEqual((await q('_')).rows.map((x) => x.email), ['under_score@example.com']);
    assert.deepEqual((await q('%')).rows.map((x) => x.email), ['percent%sign@example.com']);
    assert.equal((await q('evil.example')).total, 3);
    assert.equal((await q('evil.example', '&status=active')).total, 3);
    assert.equal((await q('nobody-here')).total, 0);
    assert.equal((await q('\\')).total, 0);
    assert.equal((await q("' OR '1'='1")).total, 0);
    assert.equal((await q('   ')).total, 10, 'a blank query is no filter');
  });

  test('subscribers: limit and offset page through the list', async () => {
    const p1 = (await A('GET', '/api/admin/subscribers?limit=4&offset=0')).json;
    const p2 = (await A('GET', '/api/admin/subscribers?limit=4&offset=4')).json;
    const p3 = (await A('GET', '/api/admin/subscribers?limit=4&offset=8')).json;
    assert.equal(p1.total, 10);
    assert.deepEqual([p1.rows.length, p2.rows.length, p3.rows.length], [4, 4, 2]);
    const all = [...p1.rows, ...p2.rows, ...p3.rows].map((x) => x.id);
    assert.equal(new Set(all).size, 10);
    assert.equal((await A('GET', '/api/admin/subscribers?limit=0')).json.rows.length, 1, 'limit is clamped to at least 1');
    assert.equal((await A('GET', '/api/admin/subscribers?limit=abc')).json.rows.length, 10);
    assert.equal((await A('GET', '/api/admin/subscribers?offset=-5')).json.rows.length, 10);
  });

  test('subscribers.csv: active members only, with formula-injection escaping', async () => {
    const r = await A('GET', '/api/admin/subscribers.csv');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/csv; charset=utf-8');
    assert.equal(r.headers['content-disposition'], `attachment; filename="slocabaia-members-${today()}.csv"`);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(r.text.startsWith('email,confirmed_at\r\n'));
    assert.ok(r.text.endsWith('\r\n'));
    const lines = r.text.trimEnd().split('\r\n').slice(1);
    assert.equal(lines.length, 8);
    const emails = lines.map((l) => /^"([^"]*)","[^"]*"$/.exec(l)?.[1]);
    assert.ok(emails.every(Boolean), r.text);
    assert.ok(emails.includes("'=1+2@evil.example"));
    assert.ok(emails.includes("'+cmd@evil.example"));
    assert.ok(emails.includes("'-sum@evil.example"));
    assert.ok(emails.includes('alice@example.com'));
    assert.ok(!emails.some((e) => /^[=+\-@]/.test(e)), 'no cell starts with a formula character');
    assert.ok(!r.text.includes('carol@example.com'), 'pending members are not exported');
    assert.ok(!r.text.includes('dave@example.com'), 'unsubscribed members are not exported');
    for (const l of lines) assert.match(l, /,"\d{4}-\d{2}-\d{2}T[\d:.]+Z"$/);
  });

  test('delete a member: CSRF-refused call changes nothing, a real one erases the row', async () => {
    const id = ids['gone@example.com'];
    const refused = await S.req('DELETE', `/api/admin/subscribers/${id}`, { headers: { cookie } });
    assert.equal(refused.status, 403);
    assert.ok(subRow(S, 'gone@example.com'));
    const r = await A('DELETE', `/api/admin/subscribers/${id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(subRow(S, 'gone@example.com'), undefined);
    assert.equal((await A('DELETE', `/api/admin/subscribers/${id}`)).status, 404);
    assert.equal((await A('DELETE', '/api/admin/subscribers/abc')).status, 404);
    assert.equal((await A('GET', '/api/admin/subscribers')).json.total, 9);
  });

  test('stats: shape, day window and member counts', async () => {
    const r = await A('GET', '/api/admin/stats');
    assert.equal(r.status, 200);
    const s = r.json;
    assert.deepEqual(Object.keys(s).sort(), ['campaigns', 'days', 'joined', 'left', 'mail', 'members', 'pageviews', 'pageviewsAllTime']);
    assert.equal(s.days.length, 30);
    assert.ok(s.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
    assert.deepEqual(s.days, [...new Set(s.days)].sort(), 'ascending, no duplicates');
    assert.equal(s.days.at(-1), today());
    for (const k of ['joined', 'left', 'pageviews']) {
      assert.equal(s[k].length, 30, k);
      assert.ok(s[k].every((n) => Number.isInteger(n) && n >= 0), k);
    }
    assert.deepEqual(s.members, { active: 7, pending: 1, unsubscribed: 1 });
    assert.equal(s.joined.at(-1), 8, 'seven active plus dave confirmed today (the deleted member is gone)');
    assert.equal(s.left.at(-1), 1);
    assert.equal(s.joined.slice(0, -1).reduce((a, b) => a + b, 0), 0);
    assert.equal(typeof s.pageviewsAllTime, 'number');
    assert.deepEqual(s.campaigns, { sent: 0, last: null, emails: 0, failed: 0 });
    assert.deepEqual(s.mail, { mode: 'log' });

    for (const [q, n] of [['7', 7], ['1', 7], ['90', 90], ['9999', 365], ['abc', 30], ['-3', 7]]) {
      const x = (await A('GET', `/api/admin/stats?days=${q}`)).json;
      assert.equal(x.days.length, n, `days=${q}`);
      assert.equal(x.joined.length, n);
      assert.equal(x.pageviews.length, n);
    }
  });

  test('stats counts today\'s page views', async () => {
    const before_ = (await A('GET', '/api/admin/stats')).json;
    await S.req('GET', '/', { headers: BROWSER });
    await S.req('GET', '/', { headers: BROWSER });
    const after_ = (await A('GET', '/api/admin/stats')).json;
    assert.equal(after_.pageviews.at(-1), before_.pageviews.at(-1) + 2);
    assert.equal(after_.pageviewsAllTime, before_.pageviewsAllTime + 2);
  });

  /* ---------------------------------------------------------- sending */

  test('send is refused without the exact number of active members', async () => {
    const n = 7;
    for (const body of [undefined, {}, { confirm: null }, { confirm: n - 1 }, { confirm: n + 1 }, { confirm: 'seven' }, { confirm: 0 }, { confirm: -7 }]) {
      const r = await A('POST', `/api/admin/campaigns/${draftId}/send`, body);
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.match(r.json.error, /\(7\)/);
    }
    const c = (await A('GET', `/api/admin/campaigns/${draftId}`)).json;
    assert.equal(c.status, 'draft');
    assert.equal(S.q('SELECT COUNT(*) AS n FROM deliveries')[0].n, 0);
  });

  test('send with the right number: 202, background batches, one delivery per active member, then sent', async () => {
    const active = S.q("SELECT id, email, token FROM subscribers WHERE status = 'active' ORDER BY id");
    assert.equal(active.length, 7);
    const mailsBefore = outbox(S).length;
    const r = await A('POST', `/api/admin/campaigns/${draftId}/send`, { confirm: 7 });
    assert.equal(r.status, 202);
    assert.deepEqual(r.json, { ok: true, recipients: 7, mode: 'log' });

    const c = await waitFor(
      async () => {
        const g = (await A('GET', `/api/admin/campaigns/${draftId}`)).json;
        return g.status !== 'sending' && g.status !== 'draft' ? g : null;
      },
      { timeout: 15000, what: 'campaign to finish sending' },
    );
    assert.equal(c.status, 'sent');
    assert.equal(c.recipients, 7);
    assert.equal(c.sent, 7);
    assert.equal(c.failed, 0);
    assert.ok(c.sent_at);

    const deliveries = S.q('SELECT subscriber_id, status, error FROM deliveries WHERE campaign_id = ? ORDER BY subscriber_id', draftId);
    assert.equal(deliveries.length, 7);
    assert.deepEqual(deliveries.map((d) => d.subscriber_id), active.map((a) => a.id));
    assert.ok(deliveries.every((d) => d.status === 'logged' && d.error === null));
    const cols = S.q('PRAGMA table_info(deliveries)').map((x) => x.name);
    assert.ok(!cols.includes('email'), 'no address copied into deliveries');

    const newsletters = outbox(S).slice(mailsBefore).filter((m) => m.subject === 'Drop 07: the house');
    assert.equal(newsletters.length, 7);
    for (const a of active) {
      const mine = newsletters.filter((m) => m.to === a.email);
      assert.equal(mine.length, 1, a.email);
      assert.ok(mine[0].html.includes(`href="${S.siteUrl}/u?t=${a.token}"`), `personal unsubscribe link for ${a.email}`);
    }
    for (const email of ['carol@example.com', 'dave@example.com', 'gone@example.com']) {
      assert.equal(newsletters.filter((m) => m.to === email).length, 0, `${email} gets nothing`);
    }
  });

  test('a sent newsletter is locked: no edit, no delete, no second send', async () => {
    const put = await A('PUT', `/api/admin/campaigns/${draftId}`, { subject: 'Changed after sending' });
    assert.equal(put.status, 409);
    const del = await A('DELETE', `/api/admin/campaigns/${draftId}`);
    assert.equal(del.status, 409);
    const again = await A('POST', `/api/admin/campaigns/${draftId}/send`, { confirm: 7 });
    assert.equal(again.status, 409);
    const c = (await A('GET', `/api/admin/campaigns/${draftId}`)).json;
    assert.equal(c.subject, 'Drop 07: the house');
    assert.equal(c.status, 'sent');
    assert.equal(S.q('SELECT COUNT(*) AS n FROM deliveries WHERE campaign_id = ?', draftId)[0].n, 7);
    const list = (await A('GET', '/api/admin/campaigns')).json.rows;
    assert.equal(list.find((x) => x.id === draftId).status, 'sent');
  });

  test('stats reflect the sent newsletter', async () => {
    const s = (await A('GET', '/api/admin/stats')).json;
    assert.equal(s.campaigns.sent, 1);
    assert.equal(s.campaigns.emails, 7);
    assert.equal(s.campaigns.failed, 0);
    assert.ok(s.campaigns.last);
  });

  test('the unsubscribe link inside the newsletter works', async () => {
    const mail = outbox(S).filter((m) => m.subject === 'Drop 07: the house' && m.to === 'bob@example.com')[0];
    const href = /href="([^"]*\/u\?t=[^"]+)"/.exec(mail.html)[1];
    const r = await S.req('POST', pathOf(href), { body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 200);
    assert.equal(subRow(S, 'bob@example.com').status, 'unsubscribed');
  });

  test('logout ends the session for good', async () => {
    const r = await A('POST', '/api/admin/logout');
    assert.equal(r.status, 200);
    const sc = [].concat(r.headers['set-cookie'])[0];
    assert.match(sc, /^sloca_admin=;/);
    assert.match(sc, /Max-Age=0/);
    assert.equal(S.q('SELECT COUNT(*) AS n FROM sessions')[0].n, 0);
    const me = await A('GET', '/api/admin/me');
    assert.equal(me.status, 401);
  });
});

/* ================================================================== send strictness and resume */

describe('newsletter sending: strict confirm and resume after a restart', () => {
  let S;
  let dataDir;
  let cookie;
  let resumeId;
  const m = {};
  before(async () => {
    S = await startServer({ trustProxy: true });
    dataDir = S.dataDir;
    const r = await login(S);
    cookie = cookieOf(r);
  });
  after(async () => {
    await S?.stop({ keepData: true });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('with one active member, confirm: true is not accepted as the typed number 1', async () => {
    const A = adminClient(S, cookie);
    m.one = await join_(S, 'one@example.com');
    const c = await A('POST', '/api/admin/campaigns', { subject: 'Strict confirm' });
    const r = await A('POST', `/api/admin/campaigns/${c.json.id}/send`, { confirm: true });
    assert.equal(r.status, 409, `confirm:true answered ${r.status} ${r.text}`);
  });

  test('a send interrupted by a restart resumes without duplicates', async () => {
    let A = adminClient(S, cookie);
    m.two = await join_(S, 'two@example.com');
    m.three = await join_(S, 'three@example.com');
    const c = await A('POST', '/api/admin/campaigns', { subject: 'Resume me' });
    resumeId = c.json.id;
    await S.stop({ keepData: true });

    // simulate a crash after the first member's delivery was recorded
    const db = new DatabaseSync(join(dataDir, 'slocabaia.db'));
    try {
      db.prepare("UPDATE campaigns SET status = 'sending', recipients = 3 WHERE id = ?").run(resumeId);
      db.prepare("INSERT INTO deliveries (campaign_id, subscriber_id, status, at) VALUES (?, ?, 'logged', ?)").run(resumeId, m.one.id, new Date().toISOString());
    } finally {
      db.close();
    }

    S = await startServer({ trustProxy: true, dataDir });
    A = adminClient(S, cookie);
    const me = await A('GET', '/api/admin/me');
    assert.equal(me.status, 200, 'the session survives a restart');

    const done = await waitFor(
      async () => {
        const g = (await A('GET', `/api/admin/campaigns/${resumeId}`)).json;
        return g.status === 'sent' ? g : null;
      },
      { timeout: 15000, what: 'resumed campaign to finish' },
    );
    assert.equal(done.sent, 3);
    assert.equal(done.recipients, 3);
    const d = S.q('SELECT subscriber_id FROM deliveries WHERE campaign_id = ? ORDER BY subscriber_id', resumeId).map((x) => x.subscriber_id);
    assert.deepEqual(d, [m.one.id, m.two.id, m.three.id]);
    const mails = outbox(S).filter((x) => x.subject === 'Resume me');
    assert.deepEqual(mails.map((x) => x.to).sort(), ['three@example.com', 'two@example.com']);
  });
});
