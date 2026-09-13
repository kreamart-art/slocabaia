// What the dashboard can change on the page: the hero (a film or a photo) and the row of photos
// near the bottom. The choices live in the `site` table, uploaded files in DATA_DIR/media, and
// renderIndex() writes them into index.html between the hero and gallery markers.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './http.js';

const MAX_VIDEO_MB = 1024;
const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024;
const MAX_SECONDS = 90;
const MAX_PHOTOS = 16;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE = 6000;
const MAX_PIXELS = 3840 * 2160; // 4K; a larger claimed picture is refused before it is decoded
const VIDEO_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'prores', 'mpeg4']);
const MEDIA_RE = /^[a-z0-9][a-z0-9-]{0,80}\.(?:jpg|mp4)$/;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** the original film, used until the dashboard picks something else */
const DEFAULT_HERO = Object.freeze({
  type: 'video',
  custom: false,
  poster: '/img/hero-poster.jpg',
  v720: '/img/hero-720.mp4',
  v1080: '/img/hero-1080.mp4',
  still: 5.07,
  duration: 27.2,
});

/** the photos that shipped with the site (img/look-N.jpg), in order */
const DEFAULT_LOOKS = [
  ['look-2', 'Model in a brown oversized Slocabaia hoodie and wide sweatpants'],
  ['look-1', 'Model in a light grey Slocabaia sweatshirt and joggers, pulling the collar up over her face'],
  ['look-3', 'Model pulling a white Slocabaia T-shirt up over her head'],
];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cleanAlt = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
const newId = () => randomBytes(6).toString('hex');

/** width and height from a JPEG's SOF marker, or null when the bytes are not a readable JPEG */
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2; // markers without a length
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** The dashboard resizes every photo to a JPEG in the browser; the server accepts nothing else. */
function jpegFromDataUrl(value, what) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value ?? ''));
  if (!m) throw new HttpError(400, `${what}: send a JPEG.`);
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, `${what} is too large.`);
  const size = jpegSize(buf);
  const end = jpegEnd(buf);
  if (!size || end < 0 || size.w < 16 || size.h < 16 || size.w > MAX_IMAGE_SIDE || size.h > MAX_IMAGE_SIDE) {
    throw new HttpError(400, `${what} is not a readable JPEG.`);
  }
  // anything glued on after the end-of-image marker is dropped, never stored or served
  return { buf: buf.subarray(0, end), ...size };
}

/** the offset just past the EOI marker that closes the image data, or -1 without a scan and EOI */
function jpegEnd(buf) {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return -1;
    const m = buf[i + 1];
    if (m === 0xff) {
      i += 1;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return -1;
    if (m === 0xda) {
      // entropy-coded data can hold 0xFF only as FF00 or a restart marker, so the first FFD9
      // after the first scan is the real end of the image
      const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), i + 2 + len);
      return eoi < 0 ? -1 : eoi + 2;
    }
    i += 2 + len;
  }
  return -1;
}

/** 'mov' for MP4/MOV (QuickTime atoms), 'matroska' for WebM/MKV, null for anything else */
function sniffVideo(file) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(12);
    if (readSync(fd, b, 0, 12, 0) < 12) return null;
    if (b.readUInt32BE(0) === 0x1a45dfa3) return 'matroska';
    return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(b.toString('latin1', 4, 8)) ? 'mov' : null;
  } finally {
    closeSync(fd);
  }
}

function works(bin) {
  try {
    return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 10e3 }).status === 0;
  } catch {
    return false;
  }
}

/** runs ffmpeg/ffprobe without a shell; resolves with stdout, or reports -progress seconds */
function run(bin, args, { timeout = 60e3, onProgress } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => {
      if (onProgress) {
        for (const m of String(d).matchAll(/out_time_us=(\d+)/g)) onProgress(Number(m[1]) / 1e6);
      } else if (out.length < 5e6) out += d;
    });
    p.stderr.on('data', (d) => {
      if (err.length < 20000) err += d;
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) ok(out);
      else fail(new Error(`${bin} stopped (${code ?? signal}): ${err.trim().slice(-400)}`));
    });
  });
}

export function createSite({ db, root, dataDir }) {
  const mediaDir = join(dataDir, 'media');
  const tmpDir = join(dataDir, 'tmp');
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const canVideo = works(FFMPEG) && works(FFPROBE);
  const filters = canVideo ? String(spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10e3 }).stdout || '') : '';
  // iPhones film in HDR; without zscale the colours come out a little flat, but the film still works
  const canTonemap = /\szscale\s/.test(filters) && /\stonemap\s/.test(filters);

  const getRow = db.prepare('SELECT value FROM site WHERE key = ?');
  const putRow = db.prepare(
    'INSERT INTO site (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  const delRow = db.prepare('DELETE FROM site WHERE key = ?');
  const load = (key) => {
    const r = getRow.get(key);
    if (!r) return undefined;
    try {
      return JSON.parse(r.value);
    } catch {
      return undefined;
    }
  };
  const save = (key, value) => putRow.run(key, JSON.stringify(value), new Date().toISOString());

  const defaultLooks = DEFAULT_LOOKS.flatMap(([id, alt]) => {
    try {
      const size = jpegSize(readFileSync(join(root, 'img', `${id}.jpg`)));
      return size ? [{ id, src: `/img/${id}.jpg`, thumb: null, w: size.w, h: size.h, tw: null, alt }] : [];
    } catch {
      return [];
    }
  });

  const hero = () => load('hero') || { ...DEFAULT_HERO };
  const gallery = () => {
    const g = load('gallery');
    return Array.isArray(g) ? g : defaultLooks.map((p) => ({ ...p }));
  };

  /** only files this module wrote (under /media/) are ever deleted; the originals in img/ stay */
  const ownedFiles = (o) =>
    ['poster', 'v720', 'v1080', 'src', 'thumb']
      .map((k) => o?.[k])
      .filter((u) => typeof u === 'string' && u.startsWith('/media/'))
      .map((u) => u.slice(7))
      .filter((n) => MEDIA_RE.test(n));
  const removeFiles = (o) => Promise.all(ownedFiles(o).map((n) => rm(join(mediaDir, n), { force: true })));

  // On boot: half-finished uploads, and media nothing points to any more (a crash mid-processing)
  for (const f of readdirSync(tmpDir)) rm(join(tmpDir, f), { force: true, recursive: true }).catch(() => {});
  const keep = new Set([...ownedFiles(hero()), ...gallery().flatMap(ownedFiles)]);
  for (const f of readdirSync(mediaDir)) {
    if (!keep.has(f)) rm(join(mediaDir, f), { force: true, recursive: true }).catch(() => {});
  }

  /* ------------------------------------------------------------ hero film */

  let job = null; // { id, state: 'uploading' | 'processing' | 'done' | 'failed', progress 0..1, error }
  const busy = () => Boolean(job && (job.state === 'uploading' || job.state === 'processing'));
  const publicJob = () => (job ? { state: job.state, progress: Math.round(job.progress * 100), error: job.error } : null);

  async function uploadVideo(req) {
    if (!canVideo) throw new HttpError(501, 'This server cannot process video: ffmpeg is not installed.');
    if (busy()) throw new HttpError(409, 'A video is already being uploaded or processed.');
    const declared = Number(req.headers['content-length']);
    if (!(declared > 0)) throw new HttpError(411, 'The upload needs a Content-Length.');
    if (declared > MAX_VIDEO_BYTES) throw new HttpError(413, 'The video is larger than 1 GB.');

    const id = newId();
    const tmp = join(tmpDir, `${id}.upload`);
    job = { id, state: 'uploading', progress: 0, error: null };
    let size = 0;
    let recent = 0;
    const cap = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        recent += chunk.length;
        cb(size > declared ? new HttpError(413, 'The upload is larger than announced.') : null, chunk);
      },
    });
    // An upload that trickles (under 32 KB in a minute) is cut, so it cannot hold the one
    // upload slot for the full 30-minute request limit.
    const stall = setInterval(() => {
      if (recent < 32 * 1024) req.destroy(new HttpError(408, 'The upload stalled.'));
      recent = 0;
    }, 60e3);
    try {
      await pipeline(req, cap, createWriteStream(tmp));
      if (size !== declared) throw new HttpError(400, 'The upload was incomplete.');
    } catch (err) {
      job = null;
      await rm(tmp, { force: true });
      throw err instanceof HttpError ? err : new HttpError(400, 'The upload was interrupted.');
    } finally {
      clearInterval(stall);
    }
    const kind = sniffVideo(tmp);
    if (!kind) {
      job = null;
      await rm(tmp, { force: true });
      throw new HttpError(415, 'Upload an MP4, MOV or WebM video.');
    }
    job.state = 'processing';
    processVideo(id, tmp, kind).catch((err) => console.error('[hero]', err));
    return { ok: true, job: publicJob() };
  }

  async function processVideo(id, tmp, kind) {
    const base = `hero-${id}`;
    const files = { v1080: `${base}-1080.mp4`, v720: `${base}-720.mp4`, poster: `${base}-poster.jpg` };
    const at = (n) => join(mediaDir, n);
    // A forced demuxer and local files only: a crafted upload (an HLS playlist, a concat list)
    // cannot make ffmpeg open other files on the server or reach the network.
    // -max_pixels stops a tiny file that claims a 16000x16000 picture from eating gigabytes
    const px = ['-max_pixels', String(MAX_PIXELS)];
    const input = ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', ...px, '-f', kind, '-i', tmp];
    try {
      const info = JSON.parse(
        await run(FFPROBE, ['-v', 'error', '-protocol_whitelist', 'file', ...px, '-f', kind, '-print_format', 'json', '-show_streams', '-show_format', tmp]),
      );
      const vs = (info.streams || []).find((s) => s.codec_type === 'video');
      if (!vs) throw new HttpError(422, 'That file has no video track.');
      const w0 = Number(vs.width) || 0;
      const h0 = Number(vs.height) || 0;
      if (!w0 || !h0 || w0 * h0 > MAX_PIXELS) throw new HttpError(422, 'That video is larger than 4K. Export it at 4K or smaller.');
      if (!VIDEO_CODECS.has(vs.codec_name)) throw new HttpError(422, 'That video format is not supported. Export it as an MP4 (H.264 or HEVC).');
      const [fn, fd] = String(vs.avg_frame_rate || vs.r_frame_rate || '0/1').split('/').map(Number);
      if (fd > 0 && fn / fd > 120) throw new HttpError(422, 'That video has more than 120 frames per second.');
      const duration = Number(info.format?.duration) || Number(vs.duration) || 0;
      if (duration < 1) throw new HttpError(422, 'That video is shorter than a second.');
      const len = Math.min(duration, MAX_SECONDS);
      const hdr = ['arib-std-b67', 'smpte2084'].includes(vs.color_transfer);
      const toSdr = hdr && canTonemap;
      // The box follows the orientation, so a portrait phone film keeps 1080 (or 720) on its
      // short side instead of being squeezed into a landscape box.
      const box = (long, short) =>
        `scale=w='if(gte(iw,ih),min(${long},iw),min(${short},iw))':h='if(gte(iw,ih),min(${short},ih),min(${long},ih))'` +
        ':force_original_aspect_ratio=decrease:flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2';
      // shrink first and tonemap after, so the float stage only ever sees 1080p at 30 fps
      const tonemap = toSdr
        ? ',zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv'
        : '';
      // one decode feeds both rungs of the ladder: 1080p for large screens, 720p for phones
      const graph = `[0:v:0]${box(1920, 1080)},fps=30${tonemap},format=yuv420p,split=2[hi][mid];[mid]${box(1280, 720)}[lo]`;
      const output = (label, crf, file) => [
        '-map', label, '-t', len.toFixed(2),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-profile:v', 'high', '-threads', '2',
        ...(toSdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
        '-movflags', '+faststart', '-tag:v', 'avc1', at(file),
      ];
      await run(
        FFMPEG,
        [
          ...input,
          '-filter_complex', graph, '-filter_complex_threads', '2',
          '-progress', 'pipe:1', '-nostats', '-y',
          ...output('[hi]', 28, files.v1080),
          ...output('[lo]', 29, files.v720),
        ],
        {
          timeout: 20 * 60e3,
          onProgress: (sec) => {
            if (job?.id === id) job.progress = 0.97 * Math.min(1, sec / len);
          },
        },
      );
      await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-i', at(files.v1080), '-frames:v', '1', '-q:v', '3', at(files.poster)]);
      const probe = JSON.parse(
        await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-print_format', 'json', at(files.v1080)]),
      );
      const { width = 0, height = 0 } = probe.streams?.[0] || {};
      const prev = hero();
      save('hero', {
        type: 'video',
        custom: true,
        id,
        poster: `/media/${files.poster}`,
        v720: `/media/${files.v720}`,
        v1080: `/media/${files.v1080}`,
        still: 0,
        duration: Math.round(len * 100) / 100,
        width,
        height,
      });
      await removeFiles(prev);
      job = { id, state: 'done', progress: 1, error: null };
    } catch (err) {
      console.error('[hero] video processing failed:', err.message);
      job = {
        id,
        state: 'failed',
        progress: 0,
        error: err instanceof HttpError ? err.message : 'The video could not be processed. Try an MP4 or MOV straight from a phone or camera.',
      };
      await Promise.all(Object.values(files).map((n) => rm(at(n), { force: true })));
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async function setHeroImage(body) {
    if (busy()) throw new HttpError(409, 'Wait until the video has been processed.');
    const img = jpegFromDataUrl(body.image, 'The photo');
    const id = newId();
    const name = `hero-${id}.jpg`;
    await writeFile(join(mediaDir, name), img.buf);
    const prev = hero();
    save('hero', { type: 'image', custom: true, id, poster: `/media/${name}`, width: img.w, height: img.h });
    await removeFiles(prev);
    return { ok: true, hero: hero() };
  }

  function setStill(body) {
    const h = hero();
    if (h.type !== 'video') throw new HttpError(409, 'The hero is a photo, so it has no still.');
    const t = body.still;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > (Number(h.duration) || MAX_SECONDS)) {
      throw new HttpError(400, 'Pick a moment inside the video.');
    }
    const next = { ...h, still: Math.round(t * 100) / 100 };
    save('hero', next);
    return { ok: true, hero: next };
  }

  async function resetHero() {
    if (busy()) throw new HttpError(409, 'Wait until the video has been processed.');
    const prev = hero();
    delRow.run('hero');
    await removeFiles(prev);
    return { ok: true, hero: hero() };
  }

  /* ------------------------------------------------------------ photo row */

  async function addPhoto(body) {
    if (gallery().length >= MAX_PHOTOS) throw new HttpError(409, `There is room for ${MAX_PHOTOS} photos.`);
    const img = jpegFromDataUrl(body.image, 'The photo');
    const th = body.thumb ? jpegFromDataUrl(body.thumb, 'The small version') : null;
    const id = `p-${newId()}`;
    const item = { id, src: `/media/${id}.jpg`, thumb: null, w: img.w, h: img.h, tw: null, alt: cleanAlt(body.alt) };
    await writeFile(join(mediaDir, `${id}.jpg`), img.buf);
    if (th && th.w < img.w) {
      await writeFile(join(mediaDir, `${id}-sm.jpg`), th.buf);
      item.thumb = `/media/${id}-sm.jpg`;
      item.tw = th.w;
    }
    // read again after the awaits, so two uploads at once cannot drop each other
    const list = gallery();
    if (list.length >= MAX_PHOTOS) {
      await removeFiles(item);
      throw new HttpError(409, `There is room for ${MAX_PHOTOS} photos.`);
    }
    list.push(item);
    save('gallery', list);
    return { ok: true, item, gallery: list };
  }

  function updatePhoto(id, body) {
    const list = gallery();
    const p = list.find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'Photo not found.');
    p.alt = cleanAlt(body.alt);
    save('gallery', list);
    return { ok: true, gallery: list };
  }

  function orderPhotos(body) {
    const list = gallery();
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const byId = new Map(list.map((p) => [p.id, p]));
    if (ids.length !== list.length || new Set(ids).size !== ids.length || !ids.every((i) => byId.has(i))) {
      throw new HttpError(400, 'Send every photo exactly once.');
    }
    const next = ids.map((i) => byId.get(i));
    save('gallery', next);
    return { ok: true, gallery: next };
  }

  async function deletePhoto(id) {
    const list = gallery();
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) throw new HttpError(404, 'Photo not found.');
    const [gone] = list.splice(i, 1);
    save('gallery', list);
    await removeFiles(gone);
    return { ok: true, gallery: list };
  }

  /* ------------------------------------------------------------ the page */

  function heroMarkup(h) {
    const poster = esc(h.poster);
    const img = `<img src="${poster}" alt="" fetchpriority="high" decoding="async">`;
    if (h.type !== 'video') return img;
    return `${img}
      <video id="herovid" autoplay muted loop playsinline preload="auto" poster="${poster}" data-still="${Number(h.still) || 0}">
        <source src="${esc(h.v720)}" type="video/mp4" media="(max-width: 900px)">
        <source src="${esc(h.v1080)}" type="video/mp4">
      </video>`;
  }

  function galleryMarkup(items) {
    if (!items.length) return '';
    const li = items
      .map((p, i) => {
        const w = Math.trunc(Number(p.w)) || 1;
        const h = Math.trunc(Number(p.h)) || 1;
        const srcset = p.thumb
          ? ` srcset="${esc(p.thumb)} ${Math.trunc(Number(p.tw)) || 800}w, ${esc(p.src)} ${w}w" sizes="(max-aspect-ratio: 1/1) 80vw, 480px"`
          : '';
        return (
          `      <li class="looks__item" style="--ar:${w}/${h};--d:${Math.min(i, 8) * 90}ms" data-r="text">` +
          `<img src="${esc(p.src)}"${srcset} width="${w}" height="${h}" alt="${esc(p.alt)}" loading="lazy" decoding="async"></li>`
        );
      })
      .join('\n');
    return `<section class="looks" id="looks" aria-label="Photos">
    <ul class="wrap looks__row" role="list" tabindex="0" aria-label="Photos, scroll sideways for more">
${li}
    </ul>
  </section>`;
  }

  let cache = { mtime: 0, raw: '' };
  async function renderIndex() {
    const file = join(root, 'index.html');
    const st = await stat(file);
    if (st.mtimeMs !== cache.mtime) cache = { mtime: st.mtimeMs, raw: await readFile(file, 'utf8') };
    return cache.raw
      .replace(/<!-- hero:start -->[\s\S]*?<!-- hero:end -->/, () => `<!-- hero:start -->\n      ${heroMarkup(hero())}\n      <!-- hero:end -->`)
      .replace(/<!-- gallery:start -->[\s\S]*?<!-- gallery:end -->/, () => `<!-- gallery:start -->\n  ${galleryMarkup(gallery())}\n  <!-- gallery:end -->`);
  }

  return {
    canVideo,
    renderIndex,
    mediaFile: (name) => (MEDIA_RE.test(name) ? join(mediaDir, name) : null),
    state: () => ({
      hero: hero(),
      gallery: gallery(),
      job: publicJob(),
      canVideo,
      limits: { videoMB: MAX_VIDEO_MB, seconds: MAX_SECONDS, photos: MAX_PHOTOS },
    }),
    uploadVideo,
    setHeroImage,
    setStill,
    resetHero,
    addPhoto,
    updatePhoto,
    orderPhotos,
    deletePhoto,
  };
}
