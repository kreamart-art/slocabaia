// Events that already happened, each with a set of photos. The dashboard adds an event and
// uploads photos; the page shows them and every photo can be downloaded in full size.
import { HttpError } from './http.js';
import { esc, newId, oneLine, slugify, text } from './util.js';

const MAX_PHOTOS = 60;
const MAX_EVENTS = 60;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-09-13" -> "13 September 2026"; anything else stays empty */
export function longDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return '';
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : '';
}

const parse = (row) => {
  let photos = [];
  try {
    photos = JSON.parse(row.photos);
  } catch {
    photos = [];
  }
  return { ...row, photos: Array.isArray(photos) ? photos : [] };
};

export function createEvents({ db, media }) {
  const all = () => db.prepare('SELECT * FROM events ORDER BY position, held_on DESC, id DESC').all().map(parse);
  const live = () => all().filter((e) => e.status === 'live' && e.photos.length > 0);
  const byId = (id) => {
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(id));
    if (!row) throw new HttpError(404, 'Event not found.');
    return parse(row);
  };
  const now = () => new Date().toISOString();

  const savePhotos = (id, photos) =>
    db.prepare('UPDATE events SET photos = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(photos), now(), id);

  /** a slug nobody else uses yet */
  function freeSlug(title, id = 0) {
    const base = slugify(title, 'event');
    for (let i = 0; i < 50; i++) {
      const slug = i ? `${base}-${i + 1}` : base;
      const taken = db.prepare('SELECT id FROM events WHERE slug = ? AND id != ?').get(slug, id);
      if (!taken) return slug;
    }
    return `${base}-${newId()}`;
  }

  /** `current` keeps a field that was left out as it is, so a partial save cannot pull an event offline */
  function fields(body, current = null) {
    const title = oneLine(body.title, 120);
    if (!title) throw new HttpError(400, 'An event needs a title.');
    const held = oneLine(body.held_on, 10);
    if (held && !/^\d{4}-\d{2}-\d{2}$/.test(held)) throw new HttpError(400, 'Use a date like 2026-09-13.');
    const status = body.status === 'live' || body.status === 'draft' ? body.status : current ? current.status : 'draft';
    return { title, held_on: held || null, place: oneLine(body.place, 120), body: text(body.body, 4000), status };
  }

  function create(body) {
    if (all().length >= MAX_EVENTS) throw new HttpError(409, `There is room for ${MAX_EVENTS} events.`);
    const f = fields(body);
    const stamp = now();
    const r = db
      .prepare(
        'INSERT INTO events (slug, title, held_on, place, body, status, photos, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, \'[]\', ?, ?, ?)',
      )
      .run(freeSlug(f.title), f.title, f.held_on, f.place, f.body, f.status, all().length, stamp, stamp);
    return byId(Number(r.lastInsertRowid));
  }

  function update(id, body) {
    const current = byId(id);
    const f = fields(body, current);
    db.prepare('UPDATE events SET slug = ?, title = ?, held_on = ?, place = ?, body = ?, status = ?, updated_at = ? WHERE id = ?').run(
      freeSlug(f.title, current.id),
      f.title,
      f.held_on,
      f.place,
      f.body,
      f.status,
      now(),
      current.id,
    );
    return byId(current.id);
  }

  async function remove(id) {
    const event = byId(id);
    db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
    await Promise.all(event.photos.map((p) => media.remove(p)));
    return { ok: true };
  }

  /** photos arrive as two JPEGs made in the browser: one to download, one for the grid */
  async function addPhoto(id, body) {
    const event = byId(id);
    if (event.photos.length >= MAX_PHOTOS) throw new HttpError(409, `An event holds ${MAX_PHOTOS} photos.`);
    const photoId = `e${event.id}-${newId()}`;
    const full = await media.saveJpeg(body.image, `${photoId}.jpg`, 'The photo');
    const photo = { id: photoId, full: `/media/${photoId}.jpg`, thumb: null, w: full.w, h: full.h, tw: null, alt: oneLine(body.alt) };
    if (body.thumb) {
      const small = await media.saveJpeg(body.thumb, `${photoId}-sm.jpg`, 'The small version');
      if (small.w < full.w) {
        photo.thumb = `/media/${photoId}-sm.jpg`;
        photo.tw = small.w;
      } else {
        await media.remove({ thumb: `/media/${photoId}-sm.jpg` });
      }
    }
    const fresh = byId(event.id); // read again after the awaits, so two uploads cannot drop each other
    if (fresh.photos.length >= MAX_PHOTOS) {
      await media.remove(photo);
      throw new HttpError(409, `An event holds ${MAX_PHOTOS} photos.`);
    }
    fresh.photos.push(photo);
    savePhotos(fresh.id, fresh.photos);
    return byId(fresh.id);
  }

  /** the description a screen reader reads out; the photo itself never changes */
  function photoAlt(id, photoId, body) {
    const event = byId(id);
    const photo = event.photos.find((x) => x.id === photoId);
    if (!photo) throw new HttpError(404, 'Photo not found.');
    photo.alt = oneLine(body.alt, 200);
    savePhotos(event.id, event.photos);
    return byId(event.id);
  }

  async function removePhoto(id, photoId) {
    const event = byId(id);
    const i = event.photos.findIndex((p) => p.id === photoId);
    if (i < 0) throw new HttpError(404, 'Photo not found.');
    const [gone] = event.photos.splice(i, 1);
    savePhotos(event.id, event.photos);
    await media.remove(gone);
    return byId(event.id);
  }

  function orderPhotos(id, body) {
    const event = byId(id);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const byPhotoId = new Map(event.photos.map((p) => [p.id, p]));
    if (ids.length !== event.photos.length || new Set(ids).size !== ids.length || !ids.every((x) => byPhotoId.has(x))) {
      throw new HttpError(400, 'Send every photo exactly once.');
    }
    savePhotos(event.id, ids.map((x) => byPhotoId.get(x)));
    return byId(event.id);
  }

  function orderEvents(body) {
    const list = all();
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
    const known = new Map(list.map((e) => [e.id, e]));
    if (ids.length !== list.length || new Set(ids).size !== ids.length || !ids.every((x) => known.has(x))) {
      throw new HttpError(400, 'Send every event exactly once.');
    }
    const stamp = now();
    const set = db.prepare('UPDATE events SET position = ?, updated_at = ? WHERE id = ?');
    ids.forEach((x, i) => set.run(i, stamp, x));
    return all();
  }

  /* ------------------------------------------------------------ the page */

  const photoName = (event, i) => `slocabaia-${event.slug}-${String(i + 1).padStart(2, '0')}.jpg`;

  function markup() {
    const events = live();
    if (!events.length) return '';
    const blocks = events
      .map((event) => {
        const when = [longDate(event.held_on), event.place].filter(Boolean).join(' · ');
        const photos = event.photos
          .map((p, i) => {
            const w = Math.trunc(Number(p.w)) || 1;
            const h = Math.trunc(Number(p.h)) || 1;
            const src = p.thumb || p.full;
            const srcset = p.thumb ? ` srcset="${esc(p.thumb)} ${Math.trunc(Number(p.tw)) || 800}w, ${esc(p.full)} ${w}w" sizes="(max-aspect-ratio: 1/1) 46vw, 300px"` : '';
            const alt = esc(p.alt || `${event.title}, photo ${i + 1}`);
            return `        <li class="shots__item">
          <a class="shots__open" href="${esc(p.full)}" target="_blank" rel="noopener">
            <img src="${esc(src)}"${srcset} width="${w}" height="${h}" alt="${alt}" loading="lazy" decoding="async">
          </a>
          <a class="shots__get" href="${esc(p.full)}?download=${encodeURIComponent(photoName(event, i))}" download aria-label="Download photo ${i + 1} of ${esc(event.title)}">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5M5 7l3 3 3-3M3 13h10"/></svg>
            <span>Download</span>
          </a>
        </li>`;
          })
          .join('\n');
        return `    <article class="shots" id="event-${esc(event.slug)}" data-r="text">
      <header class="shots__head">
        <h3>${esc(event.title)}</h3>
        ${when ? `<p class="shots__when">${esc(when)}</p>` : ''}
      </header>
      ${event.body ? `<p class="shots__text">${esc(event.body).replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>')}</p>` : ''}
      <ul class="shots__grid" role="list">
${photos}
      </ul>
    </article>`;
      })
      .join('\n');
    return `<section class="events" id="events" aria-labelledby="events-h">
    <div class="wrap">
      <h2 id="events-h" data-r="up">Events</h2>
      <p class="events__lead" data-r="text" style="--d:80ms">Photos from nights we hosted. Take what you are in: every photo downloads in full size.</p>
${blocks}
    </div>
  </section>`;
  }

  return {
    all,
    live,
    byId,
    create,
    update,
    remove,
    addPhoto,
    photoAlt,
    removePhoto,
    orderPhotos,
    orderEvents,
    markup,
    limits: { photos: MAX_PHOTOS, events: MAX_EVENTS },
    mediaNames: () => all().flatMap((e) => e.photos.flatMap((p) => media.names(p))),
  };
}
