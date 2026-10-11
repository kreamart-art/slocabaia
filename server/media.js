// Shared storage for everything the dashboard uploads: the hero film and photo, the photo row,
// product photos and event photos. Files live in DATA_DIR/media and are served from /media.
// Only JPEG (made in the browser) and the mp4 files ffmpeg writes ever land here.
import { mkdirSync, readdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.js';

export const MEDIA_RE = /^[a-z0-9][a-z0-9-]{0,80}\.(?:jpg|mp4)$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE = 6000;
/** the fields that can hold a /media/ address, in every kind of record we store */
const URL_FIELDS = ['poster', 'v720', 'v1080', 'src', 'thumb', 'full'];

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

/** the offset just past the EOI marker that closes the image data, or -1 without a scan and EOI */
export function jpegEnd(buf) {
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

/** The dashboard resizes every photo to a JPEG in the browser; the server accepts nothing else. */
export function jpegFromDataUrl(value, what) {
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

export function createMedia({ dataDir }) {
  const dir = join(dataDir, 'media');
  const tmpDir = join(dataDir, 'tmp');
  mkdirSync(dir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const nameOf = (u) => (typeof u === 'string' && u.startsWith('/media/') ? u.slice(7) : '');
  /** every /media/ file one record points at; files in img/ are originals and stay */
  const names = (o) => URL_FIELDS.map((k) => nameOf(o?.[k])).filter((n) => MEDIA_RE.test(n));

  return {
    dir,
    tmpDir,
    names,
    file: (name) => (MEDIA_RE.test(name) ? join(dir, name) : null),
    /** store one browser-made JPEG under a name of our own */
    async saveJpeg(dataUrl, name, what = 'The photo') {
      const img = jpegFromDataUrl(dataUrl, what);
      await writeFile(join(dir, name), img.buf);
      return { w: img.w, h: img.h, bytes: img.buf.length };
    },
    remove: (o) => Promise.all(names(o).map((n) => rm(join(dir, n), { force: true }))),
    /** on boot: throw away half-finished uploads and media nothing points at any more */
    sweep(keep) {
      const set = new Set(keep);
      for (const f of readdirSync(tmpDir)) rm(join(tmpDir, f), { force: true, recursive: true }).catch(() => {});
      for (const f of readdirSync(dir)) {
        if (!set.has(f)) rm(join(dir, f), { force: true, recursive: true }).catch(() => {});
      }
    },
  };
}
