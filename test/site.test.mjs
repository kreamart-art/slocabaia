// End-to-end tests for server/site.js: what the dashboard can change on the page (the hero film or
// photo, its still, and the row of photos), how index.html is rendered with it, and /media serving.
// Zero dependencies: node:test, node:assert, node:http, node:net, plus the ffmpeg/ffprobe binaries
// that the server itself needs for video (used here to make test media and to inspect the output).
//
// Same harness as test/server.test.mjs: every group starts its own server as a child process on a
// free high port with a fresh temporary DATA_DIR, a throwaway dashboard password (hashed with
// server/auth.js) and RESEND_API_KEY forced to an empty string, so the mailer runs in test mode. A
// group refuses to run if the server does not report test mode. Servers are killed and every temp
// directory (data and generated media) is removed afterwards.
//
// Run: node --test test/site.test.mjs
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../server/auth.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PASSWORD = `throwaway-${randomBytes(12).toString('base64url')}`;
const PASSWORD_HASH = hashPassword(PASSWORD);
const ADMIN_EMAIL = 'slocabaia@gmail.com'; // the server default; test mode only ever writes it to a file
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IMMUTABLE = 'public, max-age=31536000, immutable';
const DEFAULT_HERO = {
  type: 'video',
  custom: false,
  poster: '/img/hero-poster.jpg',
  v720: '/img/hero-720.mp4',
  v1080: '/img/hero-1080.mp4',
  still: 5.07,
  duration: 27.2,
};

/* ------------------------------------------------------------------ harness (from server.test.mjs) */

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

async function startServer({ dataDir } = {}) {
  const port = await freePort();
  const dir = dataDir || mkdtempSync(join(tmpdir(), 'sloca-site-test-'));
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
    TRUST_PROXY: '0',
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

async function login(S) {
  return S.req('POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: PASSWORD }, headers: { 'x-sloca-admin': '1' } });
}
function cookieOf(res) {
  const sc = [].concat(res.headers['set-cookie'] || []);
  const c = sc.find((s) => s.startsWith('sloca_admin='));
  return c ? c.split(';')[0] : null;
}
/** an admin client bound to a session cookie; sends the CSRF header unless told otherwise */
const adminClient =
  (S, cookie) =>
  (method, path, body, headers = {}, opts = {}) =>
    S.req(method, path, { body, headers: { cookie, 'x-sloca-admin': '1', ...headers }, ...opts });

async function signIn(S) {
  const r = await login(S);
  assert.equal(r.status, 200, `login: ${r.text}`);
  const cookie = cookieOf(r);
  assert.ok(cookie, 'login sets the session cookie');
  return { cookie, api: adminClient(S, cookie) };
}

/** a raw HTTP/1.1 request over a socket, for what http.request will not do (lying Content-Length, aborting mid-body) */
function openRaw(port, lines, body) {
  const socket = net.connect(port, '127.0.0.1');
  let data = '';
  const statusOf = () => Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1]) || 0;
  const response = new Promise((ok) => {
    socket.on('data', (d) => {
      data += d;
      if (statusOf() && data.includes('\r\n\r\n')) ok({ status: statusOf(), text: data });
    });
    socket.on('close', () => ok({ status: statusOf(), text: data }));
    socket.on('error', () => {});
  });
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  if (body) socket.write(body);
  return { socket, response };
}

/* ------------------------------------------------------------------ page and file helpers */

function block(html, name) {
  const m = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`).exec(html);
  assert.ok(m, `the page has a ${name} block`);
  return m[1];
}
const imgTags = (html) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
async function page(S) {
  const r = await S.req('GET', '/');
  assert.equal(r.status, 200);
  return r.text;
}
const galleryImgs = async (S) => imgTags(block(await page(S), 'gallery'));
const heroBlock = async (S) => block(await page(S), 'hero');
const mediaDir = (S) => join(S.dataDir, 'media');
const mediaFiles = (S) => readdirSync(mediaDir(S)).sort();
const tmpFiles = (S) => readdirSync(join(S.dataDir, 'tmp'));
const nameOf = (url) => url.replace(/^\/media\//, '');
const siteState = async (api) => {
  const r = await api('GET', '/api/admin/site');
  assert.equal(r.status, 200, r.text);
  return r.json;
};

/* ------------------------------------------------------------------ test media (made with ffmpeg) */

const tryRun = (bin) => {
  try {
    return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 10e3 }).status === 0;
  } catch {
    return false;
  }
};
const HAS_FFMPEG = tryRun('ffmpeg') && tryRun('ffprobe');
const MEDIA_TMP = mkdtempSync(join(tmpdir(), 'sloca-site-media-'));
process.on('exit', () => rmSync(MEDIA_TMP, { recursive: true, force: true }));
after(() => rmSync(MEDIA_TMP, { recursive: true, force: true }));

function ffmpeg(args, timeout = 180e3) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr}`);
}
/** a real JPEG of w x h (a test pattern, so every photo has different bytes) */
function makeJpeg(name, w, h, source = 'testsrc2') {
  const out = join(MEDIA_TMP, name);
  const spec = `${source}${source.includes('=') ? ':' : '='}size=${w}x${h}:rate=1`;
  ffmpeg(['-f', 'lavfi', '-i', spec, '-frames:v', '1', '-q:v', '4', out]);
  return readFileSync(out);
}
function makePng(name, w, h) {
  const out = join(MEDIA_TMP, name);
  ffmpeg(['-f', 'lavfi', '-i', `color=c=red:size=${w}x${h}:rate=1`, '-frames:v', '1', out]);
  return readFileSync(out);
}
/** an H.264 clip with an AAC sound track (so "no audio in the output" means something) */
function makeClip(name, w, h, fps, seconds) {
  const out = join(MEDIA_TMP, name);
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
  ]);
  return out;
}
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffprobe ${file}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
/** decodes every frame; any decoder complaint counts as "does not play" */
function decodesCleanly(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', timeout: 180e3 });
  return { ok: r.status === 0 && !r.stderr.trim(), stderr: r.stderr };
}
const dataUrl = (buf, type = 'image/jpeg') => `data:${type};base64,${buf.toString('base64')}`;

const J = {};
if (HAS_FFMPEG) {
  J.photo = makeJpeg('photo-640x480.jpg', 640, 480);
  J.thumb = makeJpeg('thumb-160x120.jpg', 160, 120);
  J.photo2 = makeJpeg('photo-800x600.jpg', 800, 600);
  J.small = makeJpeg('small-64x48.jpg', 64, 48);
  J.tiny = makeJpeg('tiny-8x8.jpg', 8, 8, 'color=c=blue');
  J.heroA = makeJpeg('hero-a-800x600.jpg', 800, 600);
  J.heroB = makeJpeg('hero-b-1024x768.jpg', 1024, 768);
  J.png = makePng('red-32x32.png', 32, 32);
}
const needFfmpeg = HAS_FFMPEG ? {} : { skip: 'ffmpeg/ffprobe not installed' };

/* ================================================================== access control */

describe('site admin API: access control, and the default page', needFfmpeg, () => {
  let S;
  let cookie;
  before(async () => {
    S = await startServer();
    ({ cookie } = await signIn(S));
  });
  after(() => S?.stop());

  const endpoints = () => [
    ['POST', '/api/admin/hero/video', Buffer.from('not really a video, but never read')],
    ['POST', '/api/admin/hero/image', { image: dataUrl(J.heroA) }],
    ['PUT', '/api/admin/hero', { still: 1 }],
    ['DELETE', '/api/admin/hero', undefined],
    ['POST', '/api/admin/gallery', { image: dataUrl(J.photo), alt: 'x' }],
    ['POST', '/api/admin/gallery/order', { ids: ['look-3', 'look-1', 'look-2'] }],
    ['PUT', '/api/admin/gallery/look-1', { alt: 'changed' }],
    ['DELETE', '/api/admin/gallery/look-1', undefined],
  ];

  test('GET / by default: the original film in the hero block, the three default photos in the gallery block', async () => {
    const html = await page(S);
    const hero = block(html, 'hero');
    assert.match(hero, /<video id="herovid"[^>]* data-still="5\.07"/);
    assert.match(hero, /poster="\/img\/hero-poster\.jpg"/);
    assert.match(hero, /<source src="\/img\/hero-720\.mp4" type="video\/mp4" media="\(max-width: 900px\)">/);
    assert.match(hero, /<source src="\/img\/hero-1080\.mp4" type="video\/mp4">/);
    assert.match(hero, /<img src="\/img\/hero-poster\.jpg" alt=""/);

    const imgs = imgTags(block(html, 'gallery'));
    assert.deepEqual(
      imgs.map((t) => attr(t, 'src')),
      ['/img/look-2.jpg', '/img/look-1.jpg', '/img/look-3.jpg'],
      'the shipped photos, in the order of DEFAULT_LOOKS',
    );
    for (const t of imgs) {
      assert.equal(attr(t, 'srcset'), null, 'no srcset without a thumb');
      assert.ok(Number(attr(t, 'width')) > 0 && Number(attr(t, 'height')) > 0, `width/height on ${t}`);
      assert.ok(attr(t, 'alt').length > 10, 'the default photos carry alt text');
      assert.equal(attr(t, 'loading'), 'lazy');
    }
    assert.match(html, /<section class="looks" id="looks" aria-label="Photos">/);
  });

  test('GET / carries an ETag; a matching If-None-Match gives 304 without a body, a stale one 200', async () => {
    const a = await S.req('GET', '/');
    assert.equal(a.status, 200);
    const etag = a.headers.etag;
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    assert.equal(a.headers['cache-control'], 'no-cache');
    const b = await S.req('GET', '/', { headers: { 'if-none-match': etag } });
    assert.equal(b.status, 304);
    assert.equal(b.buf.length, 0);
    assert.equal(b.headers.etag, etag);
    const c = await S.req('GET', '/', { headers: { 'if-none-match': '"0000000000000000000000000000dead"' } });
    assert.equal(c.status, 200);
    assert.equal(c.text, a.text);
  });

  test('GET /api/admin/site: 401 without a session, the full state with one', async () => {
    const r = await S.req('GET', '/api/admin/site');
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'Not signed in' });
    const h = await S.req('HEAD', '/api/admin/site');
    assert.equal(h.status, 401);
    const bogus = await S.req('GET', '/api/admin/site', { headers: { cookie: 'sloca_admin=not-a-real-session-token-at-all' } });
    assert.equal(bogus.status, 401);

    const ok = await S.req('GET', '/api/admin/site', { headers: { cookie } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(ok.json).sort(), ['canVideo', 'gallery', 'hero', 'job', 'limits']);
    assert.deepEqual(ok.json.hero, DEFAULT_HERO);
    assert.equal(ok.json.job, null);
    assert.equal(ok.json.canVideo, true);
    assert.deepEqual(ok.json.limits, { videoMB: 1024, seconds: 90, photos: 16 });
    assert.deepEqual(
      ok.json.gallery.map((p) => [p.id, p.src, p.thumb]),
      [
        ['look-2', '/img/look-2.jpg', null],
        ['look-1', '/img/look-1.jpg', null],
        ['look-3', '/img/look-3.jpg', null],
      ],
    );
  });

  test('every state-changing endpoint is 401 without a session', async () => {
    for (const [method, path, body] of endpoints()) {
      const r = await S.req(method, path, { body, headers: { 'x-sloca-admin': '1' } });
      assert.equal(r.status, 401, `${method} ${path}: ${r.text}`);
    }
  });

  test('every state-changing endpoint is 403 without X-Sloca-Admin, with a wrong value, or with a foreign Origin', async () => {
    const variants = [
      ['no header', {}],
      ['header "true"', { 'x-sloca-admin': 'true' }],
      ['foreign Origin', { 'x-sloca-admin': '1', origin: 'https://evil.example' }],
      ['unparseable Origin', { 'x-sloca-admin': '1', origin: 'null' }],
      ['look-alike Origin', { 'x-sloca-admin': '1', origin: `http://127.0.0.1:${S.port}.evil.example` }],
    ];
    for (const [label, headers] of variants) {
      for (const [method, path, body] of endpoints()) {
        const r = await S.req(method, path, { body, headers: { cookie, ...headers } });
        assert.equal(r.status, 403, `${label}: ${method} ${path}: ${r.text}`);
      }
    }
  });

  test('the refused calls changed nothing: default hero, default photos, no files written', async () => {
    const st = await siteState(adminClient(S, cookie));
    assert.deepEqual(st.hero, DEFAULT_HERO);
    assert.deepEqual(st.gallery.map((p) => p.id), ['look-2', 'look-1', 'look-3']);
    assert.equal(st.gallery.find((p) => p.id === 'look-1').alt.includes('changed'), false);
    assert.equal(st.job, null);
    assert.deepEqual(mediaFiles(S), []);
    assert.deepEqual(tmpFiles(S), []);
  });

  test('a same-host Origin is accepted', async () => {
    const api = adminClient(S, cookie);
    const r = await api('PUT', '/api/admin/hero', { still: 5.07 }, { origin: `http://127.0.0.1:${S.port}` });
    assert.equal(r.status, 200, r.text);
  });

  test('the dashboard CSP allows blob: previews for images and video', async () => {
    const d = await S.req('GET', '/admin/');
    assert.equal(d.status, 200);
    const csp = d.headers['content-security-policy'];
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /media-src 'self' blob:/);
  });
});

/* ================================================================== photo row */

describe('photo row', needFfmpeg, () => {
  let S;
  let api;
  const added = {};
  before(async () => {
    S = await startServer();
    ({ api } = await signIn(S));
  });
  after(() => S?.stop());

  test('a JPEG with a smaller thumb is stored, listed, written into the page with a srcset and served from /media', async () => {
    const r = await api('POST', '/api/admin/gallery', { image: dataUrl(J.photo), thumb: dataUrl(J.thumb), alt: '  Test \n  photo  ' });
    assert.equal(r.status, 201, r.text);
    const item = r.json.item;
    added.withThumb = item;
    assert.match(item.id, /^p-[0-9a-f]{12}$/);
    assert.deepEqual(item, {
      id: item.id,
      src: `/media/${item.id}.jpg`,
      thumb: `/media/${item.id}-sm.jpg`,
      w: 640,
      h: 480,
      tw: 160,
      alt: 'Test photo',
    });

    const st = await siteState(api);
    assert.equal(st.gallery.length, 4);
    assert.deepEqual(st.gallery.at(-1), item);

    assert.deepEqual(mediaFiles(S), [`${item.id}-sm.jpg`, `${item.id}.jpg`]);
    assert.deepEqual(readFileSync(join(mediaDir(S), `${item.id}.jpg`)), J.photo);
    assert.deepEqual(readFileSync(join(mediaDir(S), `${item.id}-sm.jpg`)), J.thumb);

    const tag = (await galleryImgs(S)).find((t) => attr(t, 'src') === item.src);
    assert.ok(tag, 'the photo is in the gallery block');
    assert.equal(attr(tag, 'srcset'), `${item.thumb} 160w, ${item.src} 640w`);
    assert.ok(attr(tag, 'sizes'));
    assert.equal(attr(tag, 'width'), '640');
    assert.equal(attr(tag, 'height'), '480');
    assert.equal(attr(tag, 'alt'), 'Test photo');

    for (const [url, bytes] of [
      [item.src, J.photo],
      [item.thumb, J.thumb],
    ]) {
      const f = await S.req('GET', url);
      assert.equal(f.status, 200, url);
      assert.equal(f.headers['content-type'], 'image/jpeg');
      assert.equal(f.headers['cache-control'], IMMUTABLE);
      assert.equal(f.headers['x-content-type-options'], 'nosniff');
      assert.deepEqual(f.buf, bytes);
      const h = await S.req('HEAD', url);
      assert.equal(h.status, 200);
      assert.equal(Number(h.headers['content-length']), bytes.length);
    }
  });

  test('a JPEG without a thumb (or with a thumb that is not smaller) gets no srcset and no -sm file', async () => {
    const a = await api('POST', '/api/admin/gallery', { image: dataUrl(J.photo2), alt: 'no thumb' });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.json.item.thumb, null);
    assert.equal(a.json.item.tw, null);
    assert.equal(a.json.item.w, 800);
    assert.equal(a.json.item.h, 600);
    added.noThumb = a.json.item;

    const b = await api('POST', '/api/admin/gallery', { image: dataUrl(J.small), thumb: dataUrl(J.small), alt: 'same size thumb' });
    assert.equal(b.status, 201, b.text);
    assert.equal(b.json.item.thumb, null, 'a thumb as wide as the photo is dropped');
    added.sameThumb = b.json.item;
    assert.equal(existsSync(join(mediaDir(S), `${b.json.item.id}-sm.jpg`)), false);

    const imgs = await galleryImgs(S);
    for (const it of [a.json.item, b.json.item]) {
      const tag = imgs.find((t) => attr(t, 'src') === it.src);
      assert.ok(tag, `${it.src} is in the page`);
      assert.equal(attr(tag, 'srcset'), null, `no srcset on ${tag}`);
      assert.equal(attr(tag, 'sizes'), null);
    }
    // exactly one img in the row has a srcset: the one with a thumb
    assert.equal(imgs.filter((t) => attr(t, 'srcset') !== null).length, 1);
  });

  test('alt text is stored trimmed and written HTML-escaped into the page', async () => {
    const evil = '"><script>alert(1)</script>';
    const r = await api('POST', '/api/admin/gallery', { image: dataUrl(J.small), alt: `   ${evil}   ` });
    assert.equal(r.status, 201, r.text);
    const item = r.json.item;
    added.evil = item;
    assert.equal(item.alt, evil, 'trimmed, otherwise unchanged in the stored data');
    assert.equal((await siteState(api)).gallery.find((p) => p.id === item.id).alt, evil);

    const html = await page(S);
    const gallery = block(html, 'gallery');
    assert.ok(gallery.includes('alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'), 'escaped in the attribute');
    assert.equal(gallery.includes('<script>alert(1)'), false, 'never raw in the page');
    assert.equal(html.includes('<script>alert(1)'), false);

    // edits: whitespace collapsed, quotes and apostrophes escaped, capped at 200 characters
    const u = await api('PUT', `/api/admin/gallery/${item.id}`, { alt: "  it's a \n\t \"test\" <b>  " });
    assert.equal(u.status, 200, u.text);
    const saved = u.json.gallery.find((p) => p.id === item.id).alt;
    assert.equal(saved, 'it\'s a "test" <b>');
    const tag = (await galleryImgs(S)).find((t) => attr(t, 'src') === item.src);
    assert.equal(attr(tag, 'alt'), 'it&#39;s a &quot;test&quot; &lt;b&gt;');

    const long = await api('PUT', `/api/admin/gallery/${item.id}`, { alt: 'x'.repeat(300) });
    assert.equal(long.status, 200);
    assert.equal(long.json.gallery.find((p) => p.id === item.id).alt.length, 200);

    const missing = await api('PUT', '/api/admin/gallery/p-000000000000', { alt: 'x' });
    assert.equal(missing.status, 404);
    const badId = await api('PUT', '/api/admin/gallery/NOT_AN_ID', { alt: 'x' });
    assert.equal(badId.status, 404);
  });

  test('the ETag changes with the photo row', async () => {
    const a = await S.req('GET', '/');
    const r = await api('PUT', `/api/admin/gallery/${added.noThumb.id}`, { alt: 'new words' });
    assert.equal(r.status, 200);
    const b = await S.req('GET', '/', { headers: { 'if-none-match': a.headers.etag } });
    assert.equal(b.status, 200, 'a stale ETag gets the new page');
    assert.notEqual(b.headers.etag, a.headers.etag);
    assert.ok(b.text.includes('alt="new words"'));
  });

  test('reorder: a full permutation is saved and shown; a bad id list is refused and changes nothing', async () => {
    const before_ = (await siteState(api)).gallery;
    const ids = before_.map((p) => p.id);
    const reversed = [...ids].reverse();
    const r = await api('POST', '/api/admin/gallery/order', { ids: reversed });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.gallery.map((p) => p.id), reversed);
    assert.deepEqual((await siteState(api)).gallery.map((p) => p.id), reversed);
    const bySrc = Object.fromEntries(before_.map((p) => [p.id, p.src]));
    assert.deepEqual((await galleryImgs(S)).map((t) => attr(t, 'src')), reversed.map((i) => bySrc[i]));

    const bad = [
      ['one missing', { ids: reversed.slice(1) }],
      ['one too many', { ids: [...reversed, 'p-000000000000'] }],
      ['a duplicate', { ids: [...reversed.slice(0, -1), reversed[0]] }],
      ['an unknown id', { ids: [...reversed.slice(0, -1), 'p-000000000000'] }],
      ['not an array', { ids: reversed.join(',') }],
      ['no ids', {}],
      ['objects', { ids: reversed.map((id) => ({ id })) }],
    ];
    for (const [label, body] of bad) {
      const b = await api('POST', '/api/admin/gallery/order', body);
      assert.equal(b.status, 400, `${label}: ${b.text}`);
      assert.deepEqual(b.json, { error: 'Send every photo exactly once.' });
    }
    assert.deepEqual((await siteState(api)).gallery.map((p) => p.id), reversed, 'order unchanged after the refusals');
  });

  test('delete removes the photo from the list, the page and /media (photo and thumb)', async () => {
    const it = added.withThumb;
    const r = await api('DELETE', `/api/admin/gallery/${it.id}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.gallery.some((p) => p.id === it.id), false);
    assert.equal(existsSync(join(mediaDir(S), `${it.id}.jpg`)), false);
    assert.equal(existsSync(join(mediaDir(S), `${it.id}-sm.jpg`)), false);
    assert.equal((await S.req('GET', it.src)).status, 404);
    assert.equal((await S.req('GET', it.thumb)).status, 404);
    const html = await page(S);
    assert.equal(html.includes(it.src), false);
    assert.equal(html.includes(it.thumb), false);
    const again = await api('DELETE', `/api/admin/gallery/${it.id}`);
    assert.equal(again.status, 404);
  });

  test('deleting a default photo drops it from the row but never touches img/', async () => {
    const file = join(ROOT, 'img', 'look-1.jpg');
    const st0 = statSync(file);
    const img0 = readdirSync(join(ROOT, 'img')).sort();
    const r = await api('DELETE', '/api/admin/gallery/look-1');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.gallery.some((p) => p.id === 'look-1'), false);
    const st1 = statSync(file);
    assert.equal(st1.size, st0.size);
    assert.equal(st1.mtimeMs, st0.mtimeMs);
    assert.deepEqual(readdirSync(join(ROOT, 'img')).sort(), img0);
    const f = await S.req('GET', '/img/look-1.jpg');
    assert.equal(f.status, 200, 'the original is still served');
    assert.equal(block(await page(S), 'gallery').includes('/img/look-1.jpg'), false);
    assert.ok(block(await page(S), 'gallery').includes('/img/look-2.jpg'), 'the other defaults stay');
  });

  test('non-JPEG data is refused with 400 and writes nothing', async () => {
    const files0 = mediaFiles(S);
    const count0 = (await siteState(api)).gallery.length;
    const cases = [
      ['a PNG data URL', { image: dataUrl(J.png, 'image/png') }],
      ['PNG bytes labelled as JPEG', { image: dataUrl(J.png) }],
      ['garbage base64', { image: 'data:image/jpeg;base64,!!!not*base64!!!' }],
      ['valid base64 that is not a JPEG', { image: dataUrl(Buffer.from('hello, this is not a jpeg at all')) }],
      ['a truncated JPEG', { image: dataUrl(J.photo.subarray(0, 20)) }],
      ['a JPEG under 16 px', { image: dataUrl(J.tiny) }],
      ['a URL instead of data', { image: 'https://example.com/photo.jpg' }],
      ['a data URL with parameters', { image: `data:image/jpeg;charset=utf-8;base64,${J.small.toString('base64')}` }],
      ['no image', { alt: 'nothing' }],
      ['a number', { image: 12345 }],
      ['two photos in an array', { image: [dataUrl(J.small), dataUrl(J.small)] }],
      ['a good photo with a PNG thumb', { image: dataUrl(J.photo), thumb: dataUrl(J.png, 'image/png') }],
      ['a good photo with a garbage thumb', { image: dataUrl(J.photo), thumb: 'data:image/jpeg;base64,AAAA' }],
    ];
    for (const [label, body] of cases) {
      const r = await api('POST', '/api/admin/gallery', body);
      assert.equal(r.status, 400, `${label}: ${r.status} ${r.text}`);
      assert.ok(r.json?.error, `${label}: an error message`);
    }
    const bad = await api('POST', '/api/admin/gallery', '{"image": ', { 'content-type': 'application/json' });
    assert.equal(bad.status, 400, 'invalid JSON');
    assert.deepEqual(mediaFiles(S), files0, 'no files written');
    assert.equal((await siteState(api)).gallery.length, count0, 'no photo added');
  });

  test('there is room for 16 photos; the 17th is refused with 409 and writes nothing', async () => {
    let n = (await siteState(api)).gallery.length;
    assert.ok(n < 16);
    while (n < 16) {
      const r = await api('POST', '/api/admin/gallery', { image: dataUrl(J.small), alt: `fill ${n}` });
      assert.equal(r.status, 201, `photo ${n + 1}: ${r.text}`);
      n = r.json.gallery.length;
    }
    const files0 = mediaFiles(S);
    const over = await api('POST', '/api/admin/gallery', { image: dataUrl(J.photo), thumb: dataUrl(J.thumb), alt: 'one too many' });
    assert.equal(over.status, 409, over.text);
    assert.deepEqual(over.json, { error: 'There is room for 16 photos.' });
    assert.deepEqual(mediaFiles(S), files0);
    const st = await siteState(api);
    assert.equal(st.gallery.length, 16);
    assert.equal((await galleryImgs(S)).length, 16);
    // every /media photo in the list has its file, and there is no file the list does not know
    const known = st.gallery.flatMap((p) => [p.src, p.thumb]).filter((u) => u?.startsWith('/media/')).map(nameOf).sort();
    assert.deepEqual(mediaFiles(S), known);
  });

  test('on restart, orphaned media and half-finished uploads are cleaned up; referenced files stay', async () => {
    const st0 = await siteState(api);
    const dir = S.dataDir;
    await S.stop({ keepData: true });
    writeFileSync(join(dir, 'media', 'orphan-photo.jpg'), J.small);
    writeFileSync(join(dir, 'tmp', 'abc.upload'), 'half an upload');
    S = await startServer({ dataDir: dir });
    ({ api } = await signIn(S));
    await waitFor(() => !existsSync(join(dir, 'media', 'orphan-photo.jpg')) && tmpFiles(S).length === 0, { what: 'boot cleanup' });
    const st1 = await siteState(api);
    assert.deepEqual(st1.gallery, st0.gallery);
    for (const p of st1.gallery.filter((x) => x.src.startsWith('/media/'))) {
      const f = await S.req('HEAD', p.src);
      assert.equal(f.status, 200, p.src);
    }
  });
});

/* ================================================================== hero still */

describe('hero still', needFfmpeg, () => {
  let S;
  let api;
  before(async () => {
    S = await startServer();
    ({ api } = await signIn(S));
  });
  after(() => S?.stop());

  test('PUT /api/admin/hero accepts a number inside the film, rounded to 1/100 s, and the page follows', async () => {
    for (const [sent, stored] of [
      [0, 0],
      [12.345, 12.35],
      [27.2, 27.2],
      [3, 3],
    ]) {
      const r = await api('PUT', '/api/admin/hero', { still: sent });
      assert.equal(r.status, 200, `${sent}: ${r.text}`);
      assert.equal(r.json.hero.still, stored);
      assert.equal((await siteState(api)).hero.still, stored);
      assert.match(await heroBlock(S), new RegExp(`data-still="${stored}"`));
    }
  });

  test('refuses strings, negatives, NaN, Infinity, null and values past the duration', async () => {
    const cases = [
      ['a numeric string', { still: '10' }],
      ['a string', { still: 'abc' }],
      ['a negative', { still: -0.01 }],
      ['minus one', { still: -1 }],
      ['null (what JSON.stringify makes of NaN)', { still: NaN }],
      ['true', { still: true }],
      ['an array', { still: [1] }],
      ['an object', { still: { t: 1 } }],
      ['missing', {}],
      ['just past the duration', { still: 27.21 }],
      ['far past the duration', { still: 1000 }],
    ];
    for (const [label, body] of cases) {
      const r = await api('PUT', '/api/admin/hero', body);
      assert.equal(r.status, 400, `${label}: ${r.status} ${r.text}`);
      assert.deepEqual(r.json, { error: 'Pick a moment inside the video.' });
    }
    // raw bodies JSON.stringify cannot produce
    const inf = await api('PUT', '/api/admin/hero', '{"still": 1e999}', { 'content-type': 'application/json' });
    assert.equal(inf.status, 400, `Infinity: ${inf.text}`);
    const nan = await api('PUT', '/api/admin/hero', '{"still": NaN}', { 'content-type': 'application/json' });
    assert.equal(nan.status, 400, `a literal NaN: ${nan.text}`);
    assert.equal((await siteState(api)).hero.still, 3, 'unchanged after the refusals');
    assert.match(await heroBlock(S), /data-still="3"/);
  });

  test('reset brings the still back to 5.07', async () => {
    const r = await api('DELETE', '/api/admin/hero');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.hero, DEFAULT_HERO);
    assert.match(await heroBlock(S), /data-still="5\.07"/);
  });
});

/* ================================================================== hero photo */

describe('hero photo', needFfmpeg, () => {
  let S;
  let api;
  let first;
  before(async () => {
    S = await startServer();
    ({ api } = await signIn(S));
  });
  after(() => S?.stop());

  test('a JPEG becomes the hero: the page shows only an <img>, no film', async () => {
    const r = await api('POST', '/api/admin/hero/image', { image: dataUrl(J.heroA) });
    assert.equal(r.status, 200, r.text);
    const h = r.json.hero;
    first = h;
    assert.equal(h.type, 'image');
    assert.equal(h.custom, true);
    assert.match(h.poster, /^\/media\/hero-[0-9a-f]{12}\.jpg$/);
    assert.equal(h.width, 800);
    assert.equal(h.height, 600);
    assert.deepEqual((await siteState(api)).hero, h);
    assert.deepEqual(mediaFiles(S), [nameOf(h.poster)]);

    const f = await S.req('GET', h.poster);
    assert.equal(f.status, 200);
    assert.equal(f.headers['content-type'], 'image/jpeg');
    assert.equal(f.headers['cache-control'], IMMUTABLE);
    assert.deepEqual(f.buf, J.heroA);

    const html = await page(S);
    const hero = block(html, 'hero');
    const imgs = imgTags(hero);
    assert.equal(imgs.length, 1);
    assert.equal(attr(imgs[0], 'src'), h.poster);
    assert.equal(hero.includes('herovid'), false);
    assert.equal(hero.includes('<video'), false);
    assert.equal(hero.includes('<source'), false);
    assert.equal(html.includes('id="herovid"'), false, 'no film anywhere on the page');
    assert.match(html, /<button class="hero__pause" id="heropause"[^>]*\bhidden\b/, 'the pause button stays hidden');
  });

  test('a photo hero has no still to pick (409)', async () => {
    const r = await api('PUT', '/api/admin/hero', { still: 1 });
    assert.equal(r.status, 409, r.text);
  });

  test('non-JPEG data is refused with 400 and the hero stays', async () => {
    for (const image of [dataUrl(J.png, 'image/png'), dataUrl(J.png), 'data:image/jpeg;base64,@@@', dataUrl(J.tiny), undefined]) {
      const r = await api('POST', '/api/admin/hero/image', { image });
      assert.equal(r.status, 400, `${String(image).slice(0, 30)}: ${r.text}`);
    }
    assert.deepEqual((await siteState(api)).hero, first);
    assert.deepEqual(mediaFiles(S), [nameOf(first.poster)]);
  });

  test('replacing the photo deletes the previous /media file', async () => {
    const r = await api('POST', '/api/admin/hero/image', { image: dataUrl(J.heroB) });
    assert.equal(r.status, 200, r.text);
    const h = r.json.hero;
    assert.notEqual(h.poster, first.poster);
    assert.equal(h.width, 1024);
    assert.equal(h.height, 768);
    assert.deepEqual(mediaFiles(S), [nameOf(h.poster)], 'only the new photo is left');
    assert.equal((await S.req('GET', first.poster)).status, 404);
    assert.equal(attr(imgTags(await heroBlock(S))[0], 'src'), h.poster);
    first = h;
  });

  test('reset brings back the original film and deletes the photo', async () => {
    const r = await api('DELETE', '/api/admin/hero');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.hero, DEFAULT_HERO);
    assert.deepEqual(mediaFiles(S), []);
    assert.equal((await S.req('GET', first.poster)).status, 404);
    const hero = await heroBlock(S);
    assert.match(hero, /<video id="herovid"[^>]* data-still="5\.07"/);
    assert.match(hero, /\/img\/hero-1080\.mp4/);
    for (const f of ['hero-poster.jpg', 'hero-720.mp4', 'hero-1080.mp4']) {
      assert.ok(existsSync(join(ROOT, 'img', f)), `img/${f} is untouched`);
    }
    const again = await api('DELETE', '/api/admin/hero');
    assert.equal(again.status, 200, 'resetting the default is harmless');
    assert.deepEqual(again.json.hero, DEFAULT_HERO);
  });
});

/* ================================================================== hero film */

describe('hero film (ffmpeg)', needFfmpeg, () => {
  let S;
  let api;
  let cookie;
  const clips = {};
  let landscape;
  before(async () => {
    S = await startServer();
    ({ api, cookie } = await signIn(S));
    clips.land = makeClip('land-1920x1080-25fps-3s.mp4', 1920, 1080, 25, 3);
    clips.port = makeClip('port-1080x1920-60fps-3s.mp4', 1080, 1920, 60, 3);
    clips.long = makeClip('long-320x240-10fps-95s.mp4', 320, 240, 10, 95);
    clips.short = makeClip('short-320x240-0.5s.mp4', 320, 240, 25, 0.5);
  });
  after(() => S?.stop());

  const upload = (buf, headers = {}) =>
    api('POST', '/api/admin/hero/video', buf, { 'content-type': 'video/mp4', ...headers }, { timeout: 120e3 });
  const waitJob = (what) =>
    waitFor(
      async () => {
        const st = await siteState(api);
        return st.job && (st.job.state === 'done' || st.job.state === 'failed') ? st : null;
      },
      { timeout: 5 * 60e3, every: 250, what },
    );
  const rawHead = (extra) => [
    'POST /api/admin/hero/video HTTP/1.1',
    `Host: 127.0.0.1:${S.port}`,
    `Cookie: ${cookie}`,
    'X-Sloca-Admin: 1',
    'Content-Type: video/mp4',
    ...extra,
  ];

  /** the film's files: in the hero, on disk, h264 without sound at 30 fps, even sizes, playable */
  async function checkFilm(h, { box, seconds }) {
    assert.equal(h.type, 'video');
    assert.equal(h.custom, true);
    assert.match(h.v1080, /^\/media\/hero-[0-9a-f]{12}-1080\.mp4$/);
    assert.match(h.v720, /^\/media\/hero-[0-9a-f]{12}-720\.mp4$/);
    assert.match(h.poster, /^\/media\/hero-[0-9a-f]{12}-poster\.jpg$/);
    assert.equal(h.still, 0);
    assert.ok(Math.abs(h.duration - seconds) < 0.25, `duration ${h.duration} ~ ${seconds}`);
    assert.deepEqual(mediaFiles(S), [h.v1080, h.v720, h.poster].map(nameOf).sort(), 'exactly the three new files');

    const out = {};
    for (const [key, [maxW, maxH]] of [
      ['v1080', box[1080]],
      ['v720', box[720]],
    ]) {
      const file = join(mediaDir(S), nameOf(h[key]));
      const info = probe(file);
      assert.equal(info.streams.length, 1, `${key}: one stream only (no audio, no subtitles)`);
      assert.equal(info.streams.filter((s) => s.codec_type === 'audio').length, 0, `${key}: no audio`);
      const v = info.streams[0];
      assert.equal(v.codec_type, 'video');
      assert.equal(v.codec_name, 'h264');
      assert.equal(v.pix_fmt, 'yuv420p');
      assert.equal(v.profile, 'High');
      assert.equal(v.codec_tag_string, 'avc1');
      assert.ok(v.width <= maxW && v.height <= maxH, `${key}: ${v.width}x${v.height} fits ${maxW}x${maxH}`);
      assert.equal(v.width % 2, 0, `${key}: even width ${v.width}`);
      assert.equal(v.height % 2, 0, `${key}: even height ${v.height}`);
      assert.equal(v.r_frame_rate, '30/1', `${key}: 30 fps`);
      assert.equal(v.avg_frame_rate, '30/1', `${key}: 30 fps average`);
      assert.ok(Math.abs(Number(info.format.duration) - seconds) < 0.25, `${key}: ${info.format.duration}s ~ ${seconds}s`);
      const bytes = readFileSync(file);
      assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'), `${key}: faststart (moov before mdat)`);
      const d = decodesCleanly(file);
      assert.ok(d.ok, `${key} decodes cleanly: ${d.stderr}`);
      out[key] = { w: v.width, h: v.height, size: bytes.length, bytes };
    }
    const poster = probe(join(mediaDir(S), nameOf(h.poster))).streams[0];
    assert.equal(poster.codec_name, 'mjpeg');
    assert.equal(poster.width, out.v1080.w);
    assert.equal(poster.height, out.v1080.h);
    assert.equal(h.width, out.v1080.w);
    assert.equal(h.height, out.v1080.h);

    // served from /media with ranges, the right type and an immutable cache
    for (const key of ['v1080', 'v720']) {
      const { size, bytes } = out[key];
      const full = await S.req('HEAD', h[key]);
      assert.equal(full.status, 200);
      assert.equal(full.headers['content-type'], 'video/mp4');
      assert.equal(full.headers['accept-ranges'], 'bytes');
      assert.equal(Number(full.headers['content-length']), size);
      const r = await S.req('GET', h[key], { headers: { range: 'bytes=0-99' } });
      assert.equal(r.status, 206, `${key} range`);
      assert.equal(r.headers['content-range'], `bytes 0-99/${size}`);
      assert.equal(r.headers['content-type'], 'video/mp4');
      assert.equal(r.headers['cache-control'], IMMUTABLE);
      assert.deepEqual(r.buf, bytes.subarray(0, 100));
      const tail = await S.req('GET', h[key], { headers: { range: 'bytes=-50' } });
      assert.equal(tail.status, 206);
      assert.deepEqual(tail.buf, bytes.subarray(size - 50));
      const open = await S.req('GET', h[key], { headers: { range: `bytes=${size - 10}-` } });
      assert.equal(open.status, 206);
      assert.equal(open.buf.length, 10);
      const past = await S.req('GET', h[key], { headers: { range: `bytes=${size}-` } });
      assert.equal(past.status, 416);
    }
    const p = await S.req('GET', h.poster);
    assert.equal(p.status, 200);
    assert.equal(p.headers['content-type'], 'image/jpeg');

    // and the page plays them
    const hero = await heroBlock(S);
    assert.match(hero, new RegExp(`<img src="${h.poster}"`));
    assert.match(hero, new RegExp(`<video id="herovid"[^>]* poster="${h.poster}" data-still="0"`));
    assert.match(hero, new RegExp(`<source src="${h.v720}" type="video/mp4" media="\\(max-width: 900px\\)">`));
    assert.match(hero, new RegExp(`<source src="${h.v1080}" type="video/mp4">`));
    assert.equal(hero.includes('/img/hero-'), false, 'the original film is gone from the page');
    return out;
  }

  test('uploads that are not a video are refused with 415 and leave nothing in tmp', async () => {
    const cases = [
      ['a text file', Buffer.from('hello, this is just a text file and not a film at all\n')],
      ['an HLS playlist', Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nhttp://127.0.0.1:1/evil.ts\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n')],
      ['a concat list', Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\nfile '../slocabaia.db'\n")],
      ['under 12 bytes', Buffer.from('tiny')],
      ['a PNG', J.png],
      ['a JPEG', J.photo],
    ];
    for (const [label, buf] of cases) {
      const r = await upload(buf);
      assert.equal(r.status, 415, `${label}: ${r.status} ${r.text}`);
      assert.deepEqual(r.json, { error: 'Upload an MP4, MOV or WebM video.' });
      assert.deepEqual(tmpFiles(S), [], `${label}: tmp is empty`);
      assert.deepEqual(mediaFiles(S), [], `${label}: media is empty`);
    }
    const st = await siteState(api);
    assert.equal(st.job, null, 'a refused upload leaves no job behind');
    assert.deepEqual(st.hero, DEFAULT_HERO);
  });

  test('without a Content-Length the upload is 411; announcing more than 1 GB is 413', async () => {
    const chunked = openRaw(S.port, rawHead(['Transfer-Encoding: chunked']), '5\r\nhello\r\n0\r\n\r\n');
    const a = await chunked.response;
    chunked.socket.destroy();
    assert.equal(a.status, 411, a.text);

    const huge = openRaw(S.port, rawHead([`Content-Length: ${2 * 1024 * 1024 * 1024}`]));
    const b = await huge.response;
    huge.socket.destroy();
    assert.equal(b.status, 413, b.text);

    const zero = await upload(Buffer.alloc(0));
    assert.equal(zero.status, 411, zero.text);

    await sleep(100);
    assert.deepEqual(tmpFiles(S), []);
    assert.equal((await siteState(api)).job, null);
  });

  test('while an upload is still coming in, a second one gets 409 (so do a hero photo and a reset); aborting frees the slot', async () => {
    const head = readFileSync(clips.land).subarray(0, 4096);
    const slow = openRaw(S.port, rawHead(['Content-Length: 1000000']), head);
    try {
      await waitFor(async () => (await siteState(api)).job?.state === 'uploading', { what: 'job uploading' });
      // a small body: the 409 is decided before the body is read (see the early-refusal test below)
      const second = await upload(head);
      assert.equal(second.status, 409, second.text);
      assert.deepEqual(second.json, { error: 'A video is already being uploaded or processed.' });
      const photo = await api('POST', '/api/admin/hero/image', { image: dataUrl(J.heroA) });
      assert.equal(photo.status, 409, photo.text);
      const reset = await api('DELETE', '/api/admin/hero');
      assert.equal(reset.status, 409, reset.text);
    } finally {
      slow.socket.destroy();
    }
    await waitFor(async () => (await siteState(api)).job === null && tmpFiles(S).length === 0, {
      timeout: 15000,
      what: 'the aborted upload to be cleared (job null, tmp empty)',
    });
    assert.deepEqual(mediaFiles(S), []);
    assert.deepEqual((await siteState(api)).hero, DEFAULT_HERO);
  });

  test('a landscape film becomes 1080p and 720p H.264 without sound, plus a poster; a second upload meanwhile gets 409', { timeout: 6 * 60e3 }, async () => {
    const buf = readFileSync(clips.land);
    const r = await upload(buf);
    assert.equal(r.status, 202, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.job.state, 'processing');
    const again = await upload(buf.subarray(0, 4096));
    assert.equal(again.status, 409, `second upload while processing: ${again.text}`);
    const photo = await api('POST', '/api/admin/hero/image', { image: dataUrl(J.heroA) });
    assert.equal(photo.status, 409, 'no hero photo while processing');

    const st = await waitJob('the landscape film');
    assert.equal(st.job.state, 'done', `job: ${JSON.stringify(st.job)}\n${S.log.slice(-2000)}`);
    assert.equal(st.job.progress, 100);
    assert.deepEqual(tmpFiles(S), [], 'the raw upload is removed');
    const out = await checkFilm(st.hero, { box: { 1080: [1920, 1080], 720: [1280, 720] }, seconds: 3 });
    assert.deepEqual([out.v1080.w, out.v1080.h], [1920, 1080]);
    assert.deepEqual([out.v720.w, out.v720.h], [1280, 720]);
    landscape = st.hero;
  });

  test('the still of an uploaded film must lie inside its duration', async () => {
    const ok = await api('PUT', '/api/admin/hero', { still: 1.5 });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.hero.still, 1.5);
    assert.match(await heroBlock(S), /data-still="1\.5"/);
    const past = await api('PUT', '/api/admin/hero', { still: 3.5 });
    assert.equal(past.status, 400, 'past the 3 s film');
    const oldDefault = await api('PUT', '/api/admin/hero', { still: 5.07 });
    assert.equal(oldDefault.status, 400, 'the default film\'s still does not fit a 3 s film');
    const end = await api('PUT', '/api/admin/hero', { still: landscape.duration });
    assert.equal(end.status, 200);
  });

  test('a portrait film keeps its shape inside the box, and replacing the film deletes the old files', { timeout: 6 * 60e3 }, async () => {
    const old = [landscape.v1080, landscape.v720, landscape.poster];
    const r = await upload(readFileSync(clips.port));
    assert.equal(r.status, 202, r.text);
    const st = await waitJob('the portrait film');
    assert.equal(st.job.state, 'done', `job: ${JSON.stringify(st.job)}\n${S.log.slice(-2000)}`);
    // the box follows the orientation: a portrait film keeps 1080 (and 720) on its short side
    const out = await checkFilm(st.hero, { box: { 1080: [1080, 1920], 720: [720, 1280] }, seconds: 3 });
    for (const key of ['v1080', 'v720']) {
      const ratio = out[key].w / out[key].h;
      assert.ok(Math.abs(ratio - 1080 / 1920) < 0.01, `${key}: ${out[key].w}x${out[key].h} keeps 9:16`);
    }
    assert.deepEqual([out.v1080.w, out.v1080.h], [1080, 1920]);
    assert.deepEqual([out.v720.w, out.v720.h], [720, 1280]);
    for (const u of old) {
      assert.equal(existsSync(join(mediaDir(S), nameOf(u))), false, `${u} is deleted`);
      assert.equal((await S.req('GET', u)).status, 404, `${u} is no longer served`);
    }
    assert.equal(st.hero.still, 0, 'a new film starts with still 0');
  });

  test('a film longer than 90 s is cut to 90 s, and a small film is not scaled up', { timeout: 6 * 60e3 }, async () => {
    const r = await upload(readFileSync(clips.long));
    assert.equal(r.status, 202, r.text);
    const st = await waitJob('the long film');
    assert.equal(st.job.state, 'done', `job: ${JSON.stringify(st.job)}\n${S.log.slice(-2000)}`);
    assert.equal(st.hero.duration, 90);
    const out = await checkFilm(st.hero, { box: { 1080: [1920, 1080], 720: [1280, 720] }, seconds: 90 });
    assert.deepEqual([out.v1080.w, out.v1080.h], [320, 240]);
    assert.deepEqual([out.v720.w, out.v720.h], [320, 240]);
    const ok = await api('PUT', '/api/admin/hero', { still: 89.5 });
    assert.equal(ok.status, 200);
    const past = await api('PUT', '/api/admin/hero', { still: 90.5 });
    assert.equal(past.status, 400);
  });

  test('a clip under a second, or a fake MP4, ends as a failed job and leaves the current film and no files behind', { timeout: 6 * 60e3 }, async () => {
    const current = (await siteState(api)).hero;
    const files0 = mediaFiles(S);

    const r = await upload(readFileSync(clips.short));
    assert.equal(r.status, 202, r.text);
    const st = await waitJob('the short clip');
    assert.equal(st.job.state, 'failed');
    assert.equal(st.job.error, 'That video is shorter than a second.');
    assert.deepEqual(st.hero, current);
    assert.deepEqual(mediaFiles(S), files0);
    assert.deepEqual(tmpFiles(S), []);

    // passes the sniffer (an ftyp box) but is an HLS playlist underneath; the forced demuxer must fail
    const fake = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypisom\0\0\0\0isomavc1'),
      Buffer.from('#EXTM3U\n#EXTINF:10,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n'),
    ]);
    const f = await upload(fake);
    assert.equal(f.status, 202, f.text);
    const st2 = await waitJob('the fake MP4');
    assert.equal(st2.job.state, 'failed');
    assert.ok(st2.job.error, 'an error message for the dashboard');
    assert.equal(st2.job.error.includes('/'), false, 'no ffmpeg paths or output in the message');
    assert.deepEqual(st2.hero, current);
    assert.deepEqual(mediaFiles(S), files0);
    assert.deepEqual(tmpFiles(S), []);

    // a failed job does not block the next upload
    const next = await upload(Buffer.from('still not a video'));
    assert.equal(next.status, 415);
  });

  test('reset brings back the original film and deletes the uploaded files', async () => {
    const prev = (await siteState(api)).hero;
    const r = await api('DELETE', '/api/admin/hero');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.hero, DEFAULT_HERO);
    assert.deepEqual(mediaFiles(S), []);
    for (const u of [prev.v1080, prev.v720, prev.poster]) assert.equal((await S.req('GET', u)).status, 404);
    assert.match(await heroBlock(S), /<video id="herovid"[^>]* data-still="5\.07"/);
  });
});

/* ================================================================== /media */

describe('/media serving', needFfmpeg, () => {
  let S;
  let api;
  let item;
  before(async () => {
    S = await startServer();
    ({ api } = await signIn(S));
    const r = await api('POST', '/api/admin/gallery', { image: dataUrl(J.photo), thumb: dataUrl(J.thumb), alt: 'a' });
    assert.equal(r.status, 201, r.text);
    item = r.json.item;
  });
  after(() => S?.stop());

  test('a real upload is served', async () => {
    const r = await S.req('GET', item.src);
    assert.equal(r.status, 200);
    assert.deepEqual(r.buf, J.photo);
  });

  test('names outside the pattern and traversal attempts are 404', async () => {
    // a file next to the media folder, and one with a valid name that is a directory
    writeFileSync(join(S.dataDir, 'secret.jpg'), 'SECRET-OUTSIDE-MEDIA');
    mkdirSync(join(mediaDir(S), 'folder.jpg'));
    const paths = [
      '/media/',
      '/media',
      '/media/../server/index.js',
      '/media/..%2fserver%2findex.js',
      '/media/%2e%2e%2fserver%2findex.js',
      '/media/%2e%2e/slocabaia.db',
      '/media/..%2fslocabaia.db',
      '/media/..%2fsecret.jpg',
      '/media/%2e%2e%2fsecret.jpg',
      '/media/..%5csecret.jpg',
      '/media/..\\secret.jpg',
      '/media/%2Fetc%2Fpasswd',
      '/media//etc/passwd',
      '/media/slocabaia.db',
      '/media/Hero.jpg',
      `/media/${item.id.toUpperCase()}.jpg`,
      '/media/-dash.jpg',
      '/media/.jpg',
      '/media/a.jpeg',
      '/media/a.png',
      '/media/a.JPG',
      '/media/a.mp4.txt',
      `/media/${item.id}.jpg/`,
      `/media/sub/${item.id}.jpg`,
      `/media/${item.id}.jpg%00`,
      `/media/${item.id}%00.jpg`,
      `/media/a${'b'.repeat(81)}.jpg`,
      '/media/nothere.jpg',
      '/media/folder.jpg',
    ];
    for (const p of paths) {
      const r = await S.req('GET', p);
      assert.equal(r.status, 404, `${p}: ${r.status}`);
      assert.equal(r.text.includes('SECRET-OUTSIDE-MEDIA'), false, `${p} leaked a file`);
      assert.equal(r.text.includes('createServer'), false, `${p} leaked server source`);
      assert.equal(r.headers['cache-control'] === IMMUTABLE, false, `${p}: a 404 is never cached for good`);
    }
  });
});
