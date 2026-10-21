// End-to-end tests for server/shop.js, server/events.js and server/mollie.js: what the dashboard can
// put up for sale, what an order does to stock and to the page, and the photo sets of past events.
//
// Zero dependencies: node:test, node:assert, node:http, node:net, plus ffmpeg to make real JPEGs.
// Mollie is replaced by a stand-in server in this file, so no test ever reaches the real API: it
// hands out tr_... ids, remembers the orders and lets a test flip one to paid, failed or expired.
//
// Same harness as the other suites: every group starts its own server as a child process on a free
// high port with a fresh temporary DATA_DIR, a throwaway dashboard password and RESEND_API_KEY
// forced empty, so mail only ever lands in DATA_DIR/outbox. A group refuses to run if the server
// does not report test mode.
//
// Run: node --test test/shop.test.mjs
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../server/auth.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PASSWORD = `throwaway-${randomBytes(12).toString('base64url')}`;
const PASSWORD_HASH = hashPassword(PASSWORD);
const ADMIN_EMAIL = 'slocabaia@gmail.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function rawRequest(port, method, path, { headers = {}, body, timeout = 15000 } = {}) {
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
    r.setTimeout(timeout, () => r.destroy(new Error(`timeout: ${method} ${path}`)));
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

/** a stand-in for Mollie: POST /payments hands out an id, GET reads it back, tests set the state */
async function startMollie() {
  const port = await freePort();
  const payments = new Map();
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const auth = req.headers.authorization || '';
      res.setHeader('content-type', 'application/json');
      if (!auth.startsWith('Bearer ')) {
        res.writeHead(401);
        return res.end('{"detail":"no key"}');
      }
      if (req.method === 'POST' && req.url === '/payments') {
        let sent;
        try {
          sent = JSON.parse(body);
        } catch {
          res.writeHead(422);
          return res.end('{"detail":"not json"}');
        }
        n += 1;
        const id = `tr_test${n}`;
        const p = { id, status: 'open', amount: sent.amount, metadata: sent.metadata, webhookUrl: sent.webhookUrl, redirectUrl: sent.redirectUrl, method: null, paidAt: null };
        payments.set(id, p);
        res.writeHead(201);
        return res.end(JSON.stringify({ id, status: 'open', _links: { checkout: { href: `https://pay.test/checkout/${id}` } } }));
      }
      if (req.method === 'GET' && req.url === '/profiles/me') {
        res.writeHead(200);
        return res.end(JSON.stringify({ id: 'pfl_test', name: 'Slocabaia', website: 'https://slocabaia.test', status: 'verified' }));
      }
      if (req.method === 'GET' && (req.url || '').startsWith('/methods')) {
        res.writeHead(200);
        return res.end(JSON.stringify({ _embedded: { methods: [{ id: 'ideal', description: 'iDEAL' }, { id: 'creditcard', description: 'Card' }] } }));
      }
      const m = /^\/payments\/(tr_[A-Za-z0-9]+)$/.exec(req.url || '');
      if (req.method === 'GET' && m && payments.has(m[1])) {
        const p = payments.get(m[1]);
        res.writeHead(200);
        return res.end(JSON.stringify({ id: p.id, status: p.status, method: p.method, paidAt: p.paidAt, amount: p.amount, metadata: p.metadata }));
      }
      res.writeHead(404);
      res.end('{"detail":"not found"}');
    });
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return {
    base: `http://127.0.0.1:${port}`,
    payments,
    last: () => [...payments.values()].at(-1),
    /** pretend the buyer finished (or did not) and tell the server, exactly as Mollie would */
    async settle(S, id, status, method = 'ideal') {
      const p = payments.get(id);
      assert.ok(p, `unknown payment ${id}`);
      p.status = status;
      p.method = status === 'paid' ? method : null;
      p.paidAt = status === 'paid' ? new Date().toISOString() : null;
      const r = await S.req('POST', '/api/shop/webhook', {
        body: `id=${encodeURIComponent(id)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      assert.equal(r.status, 200, r.text);
      return r;
    },
    close: () => new Promise((ok) => server.close(ok)),
  };
}

let ipCounter = 0;
/** a fresh client address per order (only honoured when the server runs with TRUST_PROXY=1) */
const nextIp = () => {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

async function startServer({ mollieBase, apiKey = 'test_throwaway', trustProxy = false } = {}) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'sloca-shop-test-'));
  const siteUrl = `http://localhost:${port}`;
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
  if (mollieBase) {
    env.MOLLIE_API_KEY = apiKey;
    env.MOLLIE_API_BASE = mollieBase;
  }
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
    get log() {
      return log;
    },
    req: (method, path, opts) => rawRequest(port, method, path, opts),
    async stop() {
      if (!exited) {
        child.kill('SIGTERM');
        const t = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exit;
        clearTimeout(t);
      }
      rmSync(dir, { recursive: true, force: true });
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
    if (!log.includes('mail: test mode')) throw new Error(`server is not in mail test mode, refusing to test:\n${log}`);
  } catch (err) {
    await S.stop();
    throw err;
  }
  return S;
}

function cookieOf(res) {
  const sc = [].concat(res.headers['set-cookie'] || []);
  const c = sc.find((s) => s.startsWith('sloca_admin='));
  return c ? c.split(';')[0] : null;
}
const adminClient = (S, cookie) => (method, path, body, headers = {}) =>
  S.req(method, path, { body, headers: { cookie, 'x-sloca-admin': '1', ...headers } });

async function signIn(S) {
  const r = await S.req('POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: PASSWORD }, headers: { 'x-sloca-admin': '1' } });
  assert.equal(r.status, 200, `login: ${r.text}`);
  const cookie = cookieOf(r);
  assert.ok(cookie, 'login sets the session cookie');
  return { cookie, api: adminClient(S, cookie) };
}

/* ------------------------------------------------------------------ page helpers */

const hasBlock = (html, name) => new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`).test(html);
function block(html, name) {
  const m = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`).exec(html);
  assert.ok(m, `the page has a ${name} block`);
  return m[1];
}
async function page(S) {
  const r = await S.req('GET', '/');
  assert.equal(r.status, 200);
  return r.text;
}
/** what the page hands the browser about the shop */
function shopData(html) {
  const m = /<script type="application\/json" id="shop-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  return JSON.parse(m[1].replace(/\\u003c/g, '<'));
}
const outbox = (S) => {
  const dir = join(S.dataDir, 'outbox');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(dir, file), 'utf8');
      return { file, to: /^To: (.*)$/m.exec(raw)?.[1], subject: /^Subject: (.*)$/m.exec(raw)?.[1], html: raw };
    });
};
const mailsTo = (S, email) => outbox(S).filter((m) => m.to === email);

/* ------------------------------------------------------------------ test media */

const tryRun = (bin) => {
  try {
    return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 10e3 }).status === 0;
  } catch {
    return false;
  }
};
const HAS_FFMPEG = tryRun('ffmpeg');
const MEDIA_TMP = mkdtempSync(join(tmpdir(), 'sloca-shop-media-'));
process.on('exit', () => rmSync(MEDIA_TMP, { recursive: true, force: true }));
after(() => rmSync(MEDIA_TMP, { recursive: true, force: true }));

function makeJpeg(name, w, h, source = 'testsrc2') {
  const out = join(MEDIA_TMP, name);
  const spec = `${source}${source.includes('=') ? ':' : '='}size=${w}x${h}:rate=1`;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', spec, '-frames:v', '1', '-q:v', '4', out], { encoding: 'utf8', timeout: 60e3 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return readFileSync(out);
}
const dataUrl = (buf, type = 'image/jpeg') => `data:${type};base64,${buf.toString('base64')}`;
const J = {};
if (HAS_FFMPEG) {
  J.big = makeJpeg('piece-900x1200.jpg', 900, 1200);
  J.small = makeJpeg('piece-300x400.jpg', 300, 400);
  J.other = makeJpeg('piece-640x480.jpg', 640, 480);
  J.event = makeJpeg('event-800x600.jpg', 800, 600);
}
const needFfmpeg = HAS_FFMPEG ? {} : { skip: 'ffmpeg not installed' };

/** a product that is ready to sell: live, with a photo and stock */
async function sellable(api, { name = 'Hand painted denim', price = '49,95', sizes = [{ label: 'M', stock: 2 }], photo = true } = {}) {
  const r = await api('POST', '/api/admin/products', { name, price, status: 'live', variants: sizes });
  assert.equal(r.status, 201, r.text);
  let product = r.json;
  if (photo) {
    const up = await api('POST', `/api/admin/products/${product.id}/photos`, { image: dataUrl(J.big), thumb: dataUrl(J.small), alt: 'front' });
    assert.equal(up.status, 201, up.text);
    product = up.json;
  }
  return product;
}

/* ================================================================== access control */

describe('shop and events admin API: access control', needFfmpeg, () => {
  let S;
  let M;
  let cookie;
  before(async () => {
    M = await startMollie();
    S = await startServer({ mollieBase: M.base });
    ({ cookie } = await signIn(S));
  });
  after(async () => {
    await S?.stop();
    await M?.close();
  });

  const endpoints = () => [
    ['GET', '/api/admin/shop', undefined],
    ['GET', '/api/admin/shop/mollie', undefined],
    ['PUT', '/api/admin/shop', { open: true }],
    ['POST', '/api/admin/products', { name: 'x', price: '1,00' }],
    ['POST', '/api/admin/products/order', { ids: [] }],
    ['PUT', '/api/admin/products/1', { name: 'x', price: '1,00' }],
    ['DELETE', '/api/admin/products/1', undefined],
    ['POST', '/api/admin/products/1/photos', { image: dataUrl(J.small) }],
    ['PUT', '/api/admin/products/1/photos/abc', { alt: 'x' }],
    ['DELETE', '/api/admin/products/1/photos/abc', undefined],
    ['PUT', '/api/admin/orders/1', { shipped: true }],
    ['DELETE', '/api/admin/orders/1', undefined],
    ['GET', '/api/admin/events', undefined],
    ['POST', '/api/admin/events', { title: 'x' }],
    ['POST', '/api/admin/events/order', { ids: [] }],
    ['PUT', '/api/admin/events/1', { title: 'x' }],
    ['DELETE', '/api/admin/events/1', undefined],
    ['POST', '/api/admin/events/1/photos', { image: dataUrl(J.small) }],
    ['PUT', '/api/admin/events/1/photos/abc', { alt: 'x' }],
    ['DELETE', '/api/admin/events/1/photos/abc', undefined],
  ];

  test('without a session every endpoint answers 401 and changes nothing', async () => {
    for (const [method, path, body] of endpoints()) {
      const r = await S.req(method, path, { body, headers: { 'x-sloca-admin': '1' } });
      assert.equal(r.status, 401, `${method} ${path}: ${r.text}`);
    }
  });

  test('with a session but without the admin header the writes are refused', async () => {
    for (const [method, path, body] of endpoints()) {
      if (method === 'GET') continue;
      const r = await S.req(method, path, { body, headers: { cookie } });
      assert.equal(r.status, 403, `${method} ${path}: ${r.text}`);
    }
  });

  test('a cross-site origin is refused even with the header and the cookie', async () => {
    const r = await S.req('POST', '/api/admin/products', {
      body: { name: 'x', price: '1,00' },
      headers: { cookie, 'x-sloca-admin': '1', origin: 'https://evil.example' },
    });
    assert.equal(r.status, 403);
  });
});

/* ================================================================== products */

describe('products: what is for sale and what the page shows', needFfmpeg, () => {
  let S;
  let M;
  let api;
  before(async () => {
    M = await startMollie();
    S = await startServer({ mollieBase: M.base });
    ({ api } = await signIn(S));
  });
  after(async () => {
    await S?.stop();
    await M?.close();
  });

  test('with nothing for sale the page has no shop section at all', async () => {
    const html = await page(S);
    assert.ok(hasBlock(html, 'shop'), 'the markers are in index.html');
    assert.equal(block(html, 'shop').trim(), '');
    assert.equal(shopData(html), null);
  });

  test('a price is read the way it is written, and a silly one is refused', async () => {
    const ok = await api('POST', '/api/admin/products', { name: 'Comma', price: '49,95', variants: [{ label: 'M', stock: 1 }] });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.price_cents, 4995);
    const dot = await api('PUT', `/api/admin/products/${ok.json.id}`, { name: 'Dot', price: '49.95' });
    assert.equal(dot.json.price_cents, 4995);
    const euro = await api('PUT', `/api/admin/products/${ok.json.id}`, { name: 'Euro', price: '€ 1.299,00' });
    assert.equal(euro.json.price_cents, 129900);
    for (const bad of ['', 'free', '-5', '9999999,00']) {
      const r = await api('PUT', `/api/admin/products/${ok.json.id}`, { name: 'Bad', price: bad });
      assert.equal(r.status, 400, `price ${JSON.stringify(bad)}: ${r.text}`);
    }
    const nameless = await api('POST', '/api/admin/products', { name: '   ', price: '1,00' });
    assert.equal(nameless.status, 400);
    await api('DELETE', `/api/admin/products/${ok.json.id}`);
  });

  test('a draft stays off the page, and so does a live product without a photo', async () => {
    const draft = await api('POST', '/api/admin/products', { name: 'Draft piece', price: '10,00', status: 'draft' });
    const live = await api('POST', '/api/admin/products', { name: 'No photo yet', price: '10,00', status: 'live' });
    assert.equal(block(await page(S), 'shop').trim(), '');
    const up = await api('POST', `/api/admin/products/${live.json.id}/photos`, { image: dataUrl(J.big), thumb: dataUrl(J.small), alt: 'front' });
    assert.equal(up.status, 201, up.text);
    const html = await page(S);
    const sec = block(html, 'shop');
    assert.match(sec, /class="shop"/);
    assert.match(sec, /No photo yet/);
    assert.ok(!sec.includes('Draft piece'), 'a draft is never written into the page');
    const data = shopData(html);
    assert.equal(data.products.length, 1);
    assert.equal(data.products[0].priceText.replace(/ /g, ' '), '€ 10,00');
    await api('DELETE', `/api/admin/products/${draft.json.id}`);
    await api('DELETE', `/api/admin/products/${live.json.id}`);
  });

  test('photos: two sizes are stored, reordered and removed, and the files go with them', async () => {
    const p = await sellable(api, { name: 'Two shots' });
    const second = await api('POST', `/api/admin/products/${p.id}/photos`, { image: dataUrl(J.other), alt: 'back' });
    assert.equal(second.status, 201, second.text);
    const images = second.json.images;
    assert.equal(images.length, 2);
    assert.ok(images[0].thumb, 'the first photo kept its small version');
    assert.equal(images[1].thumb, null, 'without a thumb there is no thumb');
    const files = readdirSync(join(S.dataDir, 'media'));
    for (const img of images) assert.ok(files.includes(img.src.replace('/media/', '')), `${img.src} is on disk`);

    const flipped = await api('POST', `/api/admin/products/${p.id}/photos/order`, { ids: [images[1].id, images[0].id] });
    assert.deepEqual(flipped.json.images.map((i) => i.id), [images[1].id, images[0].id]);
    const bad = await api('POST', `/api/admin/products/${p.id}/photos/order`, { ids: [images[0].id] });
    assert.equal(bad.status, 400, 'every photo exactly once');

    const alt = await api('PUT', `/api/admin/products/${p.id}/photos/${images[0].id}`, { alt: '  a long  look  ' });
    assert.equal(alt.json.images.find((i) => i.id === images[0].id).alt, 'a long look');

    const gone = await api('DELETE', `/api/admin/products/${p.id}/photos/${images[0].id}`);
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.json.images.length, 1);
    await waitFor(() => !readdirSync(join(S.dataDir, 'media')).includes(images[0].src.replace('/media/', '')), { what: 'the photo file to be removed' });
    await api('DELETE', `/api/admin/products/${p.id}`);
  });

  test('deleting a product takes its photos off the disk too', async () => {
    const p = await sellable(api, { name: 'Short lived' });
    const names = p.images.map((i) => i.src.replace('/media/', ''));
    assert.ok(names.length);
    await api('DELETE', `/api/admin/products/${p.id}`);
    await waitFor(() => names.every((n) => !readdirSync(join(S.dataDir, 'media')).includes(n)), { what: 'the files to be removed' });
  });

  test('sizes: empty ones fall away, duplicates are merged and one always remains', async () => {
    const r = await api('POST', '/api/admin/products', {
      name: 'Sizes',
      price: '20,00',
      variants: [{ label: 'S', stock: 3 }, { label: 'S', stock: 9 }, { label: '   ', stock: 5 }, { label: 'L', stock: -2 }],
    });
    assert.equal(r.status, 201, r.text);
    const keys = r.json.variants.map((v) => v.key);
    assert.equal(new Set(keys).size, keys.length, 'no two sizes share a key');
    assert.ok(r.json.variants.length >= 1);
    assert.ok(r.json.variants.every((v) => v.stock >= 0), 'stock never goes below zero');
    const none = await api('PUT', `/api/admin/products/${r.json.id}`, { name: 'Sizes', price: '20,00', variants: [] });
    assert.equal(none.json.variants.length, 1, 'a product always keeps one size');
    await api('DELETE', `/api/admin/products/${r.json.id}`);
  });

  test('the order of the products is the order on the page', async () => {
    const a = await sellable(api, { name: 'First piece' });
    const b = await sellable(api, { name: 'Second piece' });
    const html = await page(S);
    assert.ok(html.indexOf('First piece') < html.indexOf('Second piece'));
    const flipped = await api('POST', '/api/admin/products/order', { ids: [b.id, a.id] });
    assert.equal(flipped.status, 200, flipped.text);
    const html2 = await page(S);
    assert.ok(html2.indexOf('Second piece') < html2.indexOf('First piece'));
    await api('DELETE', `/api/admin/products/${a.id}`);
    await api('DELETE', `/api/admin/products/${b.id}`);
  });

  test('a name and a description are escaped, not run, in the page and in the JSON island', async () => {
    const p = await sellable(api, { name: '</script><img src=x onerror=alert(1)>' });
    await api('PUT', `/api/admin/products/${p.id}`, { name: p.name, price: '49,95', body: '</script>"\'<b>' });
    const html = await page(S);
    const sec = block(html, 'shop');
    assert.ok(!sec.includes('<img src=x'), 'the tag is escaped in the markup');
    assert.ok(!/<\/script>\s*<img/.test(html), 'nothing closes the JSON island early');
    const data = shopData(html);
    assert.ok(data.products[0].name.includes('<img src=x'), 'the raw text is still in the data');
    await api('DELETE', `/api/admin/products/${p.id}`);
  });
});

/* ================================================================== ordering */

describe('ordering: money, stock and mail', needFfmpeg, () => {
  let S;
  let M;
  let api;
  let piece;
  before(async () => {
    M = await startMollie();
    S = await startServer({ mollieBase: M.base, trustProxy: true });
    ({ api } = await signIn(S));
    piece = await sellable(api, { name: 'Order piece', price: '49,95', sizes: [{ label: 'M', stock: 2 }, { label: 'L', stock: 0 }] });
  });
  after(async () => {
    await S?.stop();
    await M?.close();
  });

  const buyer = {
    name: 'Nina Vega',
    email: 'nina@example.com',
    phone: '+31 6 12 34 56 78',
    street: 'Keizersgracht 1',
    postcode: '1015 CJ',
    city: 'Amsterdam',
    country: 'NL',
  };
  const order = (body, ip = nextIp()) => S.req('POST', '/api/shop/order', { body, headers: { 'x-forwarded-for': ip } });
  const sizeKey = (label) => piece.variants.find((v) => v.label === label).key;

  test('the total is the server\'s own: subtotal plus the zone, not what the browser says', async () => {
    const r = await order({ ...buyer, items: [{ product_id: piece.id, variant: sizeKey('M'), qty: 2, price_cents: 1 }] });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.ref, /^SB-[0-9A-Z]{6}$/);
    assert.equal(r.json.total_cents, 4995 * 2 + 495);
    assert.match(r.json.checkoutUrl, /^https:\/\/pay\.test\/checkout\/tr_/);
    const sent = M.last();
    assert.equal(sent.amount.value, ((4995 * 2 + 495) / 100).toFixed(2));
    assert.equal(sent.amount.currency, 'EUR');
    assert.equal(sent.metadata.ref, r.json.ref);
    assert.equal(sent.webhookUrl, `${S.siteUrl}/api/shop/webhook`);
    assert.match(sent.redirectUrl, new RegExp(`^${S.siteUrl}/shop/thanks\\?t=`));
  });

  test('nothing is taken off the stock before the money is in', async () => {
    const r = await api('GET', '/api/admin/shop');
    const p = r.json.products.find((x) => x.id === piece.id);
    assert.equal(p.variants.find((v) => v.label === 'M').stock, 2, 'still two in stock');
    const o = r.json.orders[0];
    assert.equal(o.status, 'open');
    assert.equal(o.total_cents, 4995 * 2 + 495);
  });

  test('a half-filled form is refused, line by line', async () => {
    const cases = [
      [{ ...buyer, name: '  ' }, 'name'],
      [{ ...buyer, email: 'not-an-address' }, 'email'],
      [{ ...buyer, street: '' }, 'street'],
      [{ ...buyer, postcode: '' }, 'postcode'],
      [{ ...buyer, city: '' }, 'city'],
      [{ ...buyer, country: 'XX' }, 'country we do not ship to'],
      [{ ...buyer, items: [] }, 'empty bag'],
    ];
    for (const [body, what] of cases) {
      const r = await order({ ...body, items: body.items || [{ product_id: piece.id, variant: sizeKey('M'), qty: 1 }] });
      assert.ok(r.status === 400 || r.status === 409, `${what}: got ${r.status} ${r.text}`);
      assert.ok(r.json.error, `${what} says why`);
    }
  });

  test('a size that is sold out, or more than there is, is refused', async () => {
    const out = await order({ ...buyer, items: [{ product_id: piece.id, variant: sizeKey('L'), qty: 1 }] });
    assert.equal(out.status, 409, out.text);
    assert.match(out.json.error, /sold out/i);
    const greedy = await order({ ...buyer, items: [{ product_id: piece.id, variant: sizeKey('M'), qty: 9 }] });
    assert.equal(greedy.status, 409, greedy.text);
    assert.match(greedy.json.error, /Only 2 left/i);
    const nonsense = await order({ ...buyer, items: [{ product_id: piece.id, variant: 'xxl-made-up', qty: 1 }] });
    assert.equal(nonsense.status, 400);
  });

  test('paying takes the stock, mails both sides and shows the thank-you page', async () => {
    const r = await order({ ...buyer, items: [{ product_id: piece.id, variant: sizeKey('M'), qty: 2 }], note: 'Door on the left' });
    assert.equal(r.status, 200, r.text);
    const paymentId = M.last().id;
    await M.settle(S, paymentId, 'paid');

    const shop = await waitFor(async () => {
      const d = await api('GET', '/api/admin/shop');
      const o = d.json.orders.find((x) => x.ref === r.json.ref);
      return o && o.status === 'paid' ? d.json : null;
    }, { what: 'the order to turn paid' });
    const o = shop.orders.find((x) => x.ref === r.json.ref);
    assert.equal(o.payment_method, 'ideal');
    assert.ok(o.paid_at);
    assert.equal(o.note, 'Door on the left');
    assert.deepEqual(o.items.map((i) => [i.name, i.variant, i.qty, i.price_cents]), [['Order piece', 'M', 2, 4995]]);
    const p = shop.products.find((x) => x.id === piece.id);
    assert.equal(p.variants.find((v) => v.label === 'M').stock, 0, 'both pieces are gone');
    assert.equal(p.status, 'soldout', 'with every size at zero the product sells out by itself');

    const receipt = mailsTo(S, buyer.email).at(-1);
    assert.ok(receipt, 'the buyer gets a receipt');
    assert.ok(receipt.html.includes(r.json.ref));
    assert.ok(receipt.subject.includes(r.json.ref));
    const alert_ = mailsTo(S, ADMIN_EMAIL).at(-1);
    assert.ok(alert_, 'the owner gets an alert');
    assert.ok(alert_.html.includes(buyer.name));

    const thanks = await S.req('GET', `/shop/thanks?t=${r.json.token}`);
    assert.equal(thanks.status, 200);
    assert.ok(thanks.text.includes(r.json.ref));
    assert.match(thanks.headers['cache-control'], /no-store/);
    const nonsense = await S.req('GET', '/shop/thanks?t=nope');
    assert.equal(nonsense.status, 404);
  });

  test('a second webhook for the same payment changes nothing', async () => {
    const before_ = await api('GET', '/api/admin/shop');
    const paid = before_.json.orders.find((x) => x.status === 'paid');
    await M.settle(S, paid.payment_id, 'paid');
    await sleep(120);
    const after_ = await api('GET', '/api/admin/shop');
    const same = after_.json.orders.find((x) => x.ref === paid.ref);
    assert.equal(same.paid_at, paid.paid_at);
    const p = after_.json.products.find((x) => x.id === piece.id);
    assert.equal(p.variants.find((v) => v.label === 'M').stock, 0, 'the stock is not taken twice');
  });

  test('a webhook for an unknown payment is answered without a fuss', async () => {
    const r = await S.req('POST', '/api/shop/webhook', {
      body: 'id=tr_doesnotexist',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(r.status, 200);
  });

  test('a failed payment leaves the stock alone and says so on the thank-you page', async () => {
    const fresh = await sellable(api, { name: 'Failing piece', price: '10,00', sizes: [{ label: 'One size', stock: 1 }] });
    const key = fresh.variants[0].key;
    const r = await order({ ...buyer, items: [{ product_id: fresh.id, variant: key, qty: 1 }] });
    assert.equal(r.status, 200, r.text);
    await M.settle(S, M.last().id, 'failed');
    const shop = await waitFor(async () => {
      const d = await api('GET', '/api/admin/shop');
      const o = d.json.orders.find((x) => x.ref === r.json.ref);
      return o && o.status === 'failed' ? d.json : null;
    }, { what: 'the order to turn failed' });
    const p = shop.products.find((x) => x.id === fresh.id);
    assert.equal(p.variants[0].stock, 1, 'nothing was taken');
    const thanks = await S.req('GET', `/shop/thanks?t=${r.json.token}`);
    assert.equal(thanks.status, 200);
    assert.match(thanks.text, /did not go through|niet gelukt|failed/i);
    await api('DELETE', `/api/admin/products/${fresh.id}`);
  });

  test('marking an order shipped and reading it are separate, and both show up', async () => {
    const d = await api('GET', '/api/admin/shop');
    const paid = d.json.orders.find((x) => x.status === 'paid');
    assert.ok(paid, 'there is a paid order');
    assert.ok(d.json.unread >= 1, 'a new order counts as unread');
    const read = await api('PUT', `/api/admin/orders/${paid.id}`, { read: true });
    assert.equal(read.status, 200, read.text);
    const shipped = await api('PUT', `/api/admin/orders/${paid.id}`, { shipped: true });
    assert.equal(shipped.status, 200, shipped.text);
    const after_ = await api('GET', '/api/admin/shop');
    const o = after_.json.orders.find((x) => x.id === paid.id);
    assert.equal(o.status, 'shipped');
    assert.ok(o.shipped_at && o.read_at);
    assert.equal(after_.json.unread, 0);
    const back = await api('PUT', `/api/admin/orders/${paid.id}`, { shipped: false });
    assert.equal(back.json.status || 'paid', 'paid');
  });

  test('a closed shop and a shop without a key take no orders', async () => {
    const closed = await api('PUT', '/api/admin/shop', { open: false, zones: (await api('GET', '/api/admin/shop')).json.settings.zones });
    assert.equal(closed.status, 200, closed.text);
    const r = await order({ ...buyer, items: [{ product_id: piece.id, variant: sizeKey('M'), qty: 1 }] });
    assert.equal(r.status, 503, r.text);
    const html = await page(S);
    const data = shopData(html);
    assert.equal(data.open, false, 'the page says the shop is shut');
    await api('PUT', '/api/admin/shop', { open: true, zones: data.zones });
  });

  test('many quick attempts from one address are rate limited', async () => {
    const ip = '203.0.113.9';
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const r = await order({ ...buyer, items: [{ product_id: piece.id, variant: sizeKey('M'), qty: 1 }] }, ip);
      if (r.status === 429) limited += 1;
    }
    assert.ok(limited > 0, 'the tap closes after a while');
    // another address is not caught by it
    const other = await order({ ...buyer, items: [{ product_id: piece.id, variant: sizeKey('M'), qty: 1 }] });
    assert.notEqual(other.status, 429);
  });
});

/* ================================================================== shipping zones */

describe('shipping: zones, free over, pickup', needFfmpeg, () => {
  let S;
  let M;
  let api;
  let piece;
  before(async () => {
    M = await startMollie();
    S = await startServer({ mollieBase: M.base, trustProxy: true });
    ({ api } = await signIn(S));
    piece = await sellable(api, { name: 'Zone piece', price: '100,00', sizes: [{ label: 'One size', stock: 50 }] });
  });
  after(async () => {
    await S?.stop();
    await M?.close();
  });

  const buy = (country, qty = 1, extra = {}) =>
    S.req('POST', '/api/shop/order', {
      headers: { 'x-forwarded-for': nextIp() },
      body: {
        name: 'Zone Buyer',
        email: 'zone@example.com',
        street: 'Street 1',
        postcode: '1000 AA',
        city: 'Town',
        country,
        items: [{ product_id: piece.id, variant: piece.variants[0].key, qty }],
        ...extra,
      },
    });

  test('every zone has its own price, and an unlisted country cannot order', async () => {
    const nl = await buy('NL');
    assert.equal(nl.json.total_cents, 10000 + 495);
    const de = await buy('DE');
    assert.equal(de.json.total_cents, 10000 + 795);
    const se = await buy('SE');
    assert.equal(se.json.total_cents, 10000 + 1495);
    const sr = await buy('SR');
    assert.equal(sr.status, 400, sr.text);
  });

  test('free over an amount is free, below it is not', async () => {
    const s = (await api('GET', '/api/admin/shop')).json.settings;
    const saved = await api('PUT', '/api/admin/shop', { ...s, freeFrom: '150,00' });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.freeFrom, 15000);
    const under = await buy('NL', 1);
    assert.equal(under.json.total_cents, 10000 + 495);
    const over = await buy('NL', 2);
    assert.equal(over.json.total_cents, 20000, 'no shipping above the threshold');
    await api('PUT', '/api/admin/shop', { ...s, freeFrom: 0 });
  });

  test('pickup skips the address, and is refused while it is switched off', async () => {
    const s = (await api('GET', '/api/admin/shop')).json.settings;
    const off = await buy('NL', 1, { pickup: true, street: '', postcode: '', city: '' });
    assert.equal(off.status, 400, 'with pickup off the address is still needed');
    const saved = await api('PUT', '/api/admin/shop', { ...s, pickup: { enabled: true, label: 'Ophalen in Amsterdam', cents: '0,00' } });
    assert.equal(saved.status, 200, saved.text);
    const on = await buy('NL', 1, { pickup: true, street: '', postcode: '', city: '', country: '' });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.total_cents, 10000);
    const d = await api('GET', '/api/admin/shop');
    const o = d.json.orders.find((x) => x.ref === on.json.ref);
    assert.equal(o.country, 'PICKUP');
    assert.equal(shopData(await page(S)).pickup.label, 'Ophalen in Amsterdam');
    await api('PUT', '/api/admin/shop', { ...s, pickup: { enabled: false } });
  });

  test('a zone without a country is dropped, and the last zone cannot be removed', async () => {
    const s = (await api('GET', '/api/admin/shop')).json.settings;
    const kept = await api('PUT', '/api/admin/shop', { ...s, zones: [{ label: 'Only NL', countries: ['nl', 'oops', ''], cents: '7,50' }] });
    assert.equal(kept.status, 200, kept.text);
    assert.deepEqual(kept.json.zones.map((z) => z.countries), [['NL']]);
    assert.equal(kept.json.zones[0].cents, 750);
    const empty = await api('PUT', '/api/admin/shop', { ...s, zones: [{ label: 'Nowhere', countries: [], cents: '1,00' }] });
    assert.equal(empty.status, 400, empty.text);
    const restored = await api('PUT', '/api/admin/shop', s);
    assert.equal(restored.status, 200);
  });
});

/* ================================================================== the Mollie check */

describe('the dashboard check on the Mollie connection', needFfmpeg, () => {
  let S;
  let M;
  let api;
  before(async () => {
    M = await startMollie();
    S = await startServer({ mollieBase: M.base });
    ({ api } = await signIn(S));
  });
  after(async () => {
    await S?.stop();
    await M?.close();
  });

  test('a working key reports the profile and the methods that are on', async () => {
    const r = await api('GET', '/api/admin/shop/mollie');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mode, 'test');
    assert.equal(r.json.profile.website, 'https://slocabaia.test');
    assert.deepEqual(r.json.methods.map((m) => m.name), ['iDEAL', 'Card']);
    // reading the check never creates anything at Mollie
    assert.equal(M.payments.size, 0);
  });

  test('a key Mollie refuses is reported as a bad key, not as a crash', async () => {
    const bad = await startServer({ mollieBase: M.base, apiKey: '' });
    try {
      const { api: a } = await signIn(bad);
      const r = await a('GET', '/api/admin/shop/mollie');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.mode, 'off');
      assert.equal(r.json.reason, 'no-key');
    } finally {
      await bad.stop();
    }
  });

  test('a Mollie that cannot be reached is reported, and the shop keeps working', async () => {
    const port = await freePort();
    const dead = await startServer({ mollieBase: `http://127.0.0.1:${port}` });
    try {
      const { api: a } = await signIn(dead);
      const r = await a('GET', '/api/admin/shop/mollie');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.reason, 'error');
      assert.ok(r.json.error, 'says what went wrong');
      // the rest of the dashboard is untouched by a dead payment provider
      assert.equal((await a('GET', '/api/admin/shop')).status, 200);
    } finally {
      await dead.stop();
    }
  });
});

/* ================================================================== without Mollie */

describe('a shop without a payment key', needFfmpeg, () => {
  let S;
  let api;
  before(async () => {
    S = await startServer({ mollieBase: null });
    ({ api } = await signIn(S));
  });
  after(() => S?.stop());

  test('the page says payments are off and an order is refused', async () => {
    const piece = await sellable(api, { name: 'Unbuyable', price: '10,00' });
    const data = shopData(await page(S));
    assert.equal(data.payments, 'off');
    assert.equal(data.open, false);
    assert.ok(data.products.length, 'the piece is still shown');
    const r = await S.req('POST', '/api/shop/order', {
      body: { name: 'A', email: 'a@example.com', street: 'S 1', postcode: '1000 AA', city: 'T', country: 'NL', items: [{ product_id: piece.id, variant: piece.variants[0].key, qty: 1 }] },
    });
    assert.equal(r.status, 503, r.text);
    assert.equal((await api('GET', '/api/admin/shop')).json.orders.length, 0, 'nothing was written');
  });
});

/* ================================================================== events */

describe('events: photo sets of nights that happened', needFfmpeg, () => {
  let S;
  let api;
  before(async () => {
    S = await startServer();
    ({ api } = await signIn(S));
  });
  after(() => S?.stop());

  const withPhoto = async (body = {}) => {
    const r = await api('POST', '/api/admin/events', { title: 'Slocabaia Night', held_on: '2026-09-13', place: 'Amsterdam', status: 'live', ...body });
    assert.equal(r.status, 201, r.text);
    const up = await api('POST', `/api/admin/events/${r.json.id}/photos`, { image: dataUrl(J.event), thumb: dataUrl(J.small), alt: 'the floor' });
    assert.equal(up.status, 201, up.text);
    return up.json;
  };

  test('with no live event there is no events section', async () => {
    const html = await page(S);
    assert.ok(hasBlock(html, 'events'));
    assert.equal(block(html, 'events').trim(), '');
  });

  test('a title is required and a date has to be a date', async () => {
    const nameless = await api('POST', '/api/admin/events', { title: '  ' });
    assert.equal(nameless.status, 400);
    const bad = await api('POST', '/api/admin/events', { title: 'Bad date', held_on: '13-09-2026' });
    assert.equal(bad.status, 400, bad.text);
    const ok = await api('POST', '/api/admin/events', { title: 'No date needed' });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.held_on, null);
    assert.equal(ok.json.status, 'draft', 'an event starts as a draft');
    await api('DELETE', `/api/admin/events/${ok.json.id}`);
  });

  test('a live event with photos lands on the page, with a download link per photo', async () => {
    const ev = await withPhoto();
    const sec = block(await page(S), 'events');
    assert.match(sec, /class="events"/);
    assert.match(sec, /Slocabaia Night/);
    assert.match(sec, /13 September 2026/, 'the date is written out');
    assert.match(sec, /Amsterdam/);
    const link = /href="(\/media\/[^"]+\?download=[^"]+)"[^>]*download/.exec(sec);
    assert.ok(link, `a download link per photo: ${sec}`);
    const r = await S.req('GET', link[1].replace(/&amp;/g, '&'));
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.match(r.headers['content-disposition'], /^attachment; filename="slocabaia-slocabaia-night-01\.jpg"$/);
    assert.ok(r.buf.length > 1000, 'the full size file comes back');
    await api('DELETE', `/api/admin/events/${ev.id}`);
  });

  test('a draft event, and a live one without photos, stay off the page', async () => {
    const draft = await api('POST', '/api/admin/events', { title: 'Hidden night', status: 'draft' });
    await api('POST', `/api/admin/events/${draft.json.id}/photos`, { image: dataUrl(J.event) });
    const bare = await api('POST', '/api/admin/events', { title: 'Empty night', status: 'live' });
    const sec = block(await page(S), 'events');
    assert.ok(!sec.includes('Hidden night'));
    assert.ok(!sec.includes('Empty night'));
    await api('DELETE', `/api/admin/events/${draft.json.id}`);
    await api('DELETE', `/api/admin/events/${bare.json.id}`);
  });

  test('photos are reordered, described and removed, and the files follow', async () => {
    const ev = await withPhoto({ title: 'Reorder night' });
    const second = await api('POST', `/api/admin/events/${ev.id}/photos`, { image: dataUrl(J.other) });
    const photos = second.json.photos;
    assert.equal(photos.length, 2);
    const flipped = await api('POST', `/api/admin/events/${ev.id}/photos/order`, { ids: [photos[1].id, photos[0].id] });
    assert.deepEqual(flipped.json.photos.map((p) => p.id), [photos[1].id, photos[0].id]);
    const alt = await api('PUT', `/api/admin/events/${ev.id}/photos/${photos[0].id}`, { alt: 'dancefloor' });
    assert.equal(alt.json.photos.find((p) => p.id === photos[0].id).alt, 'dancefloor');
    assert.match(block(await page(S), 'events'), /alt="dancefloor"/);
    const gone = await api('DELETE', `/api/admin/events/${ev.id}/photos/${photos[0].id}`);
    assert.equal(gone.json.photos.length, 1);
    await waitFor(() => !readdirSync(join(S.dataDir, 'media')).includes(photos[0].full.replace('/media/', '')), { what: 'the file to go' });
    const missing = await api('DELETE', `/api/admin/events/${ev.id}/photos/${photos[0].id}`);
    assert.equal(missing.status, 404);
    await api('DELETE', `/api/admin/events/${ev.id}`);
  });

  test('the order of the events is the order on the page', async () => {
    const a = await withPhoto({ title: 'Night one' });
    const b = await withPhoto({ title: 'Night two' });
    const html = await page(S);
    assert.ok(html.indexOf('Night one') < html.indexOf('Night two'));
    const flipped = await api('POST', '/api/admin/events/order', { ids: [b.id, a.id] });
    assert.equal(flipped.status, 200, flipped.text);
    assert.ok((await page(S)).indexOf('Night two') < (await page(S)).indexOf('Night one'));
    const bad = await api('POST', '/api/admin/events/order', { ids: [a.id] });
    assert.equal(bad.status, 400);
    await api('DELETE', `/api/admin/events/${a.id}`);
    await api('DELETE', `/api/admin/events/${b.id}`);
  });

  test('deleting an event wipes its photos from the disk', async () => {
    const ev = await withPhoto({ title: 'Gone night' });
    const names = ev.photos.flatMap((p) => [p.full, p.thumb].filter(Boolean)).map((u) => u.replace('/media/', ''));
    assert.ok(names.length >= 1);
    await api('DELETE', `/api/admin/events/${ev.id}`);
    await waitFor(() => names.every((n) => !readdirSync(join(S.dataDir, 'media')).includes(n)), { what: 'the files to go' });
  });

  test('a title and a text are escaped on the page', async () => {
    const ev = await withPhoto({ title: '<script>alert(1)</script>', body: 'line one\nline two' });
    const sec = block(await page(S), 'events');
    assert.ok(!sec.includes('<script>alert(1)'), 'the tag is escaped');
    assert.match(sec, /line one<br>line two/, 'a line break becomes a break');
    await api('DELETE', `/api/admin/events/${ev.id}`);
  });
});
