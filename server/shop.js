// The shop: what is for sale, and the orders that come out of it. Prices, stock and totals are
// always the server's own; the browser only says which product, which size and how many.
import { HttpError } from './http.js';
import { esc, euro, newId, oneLine, orderRef, slugify, text, toCents } from './util.js';

const MAX_PRODUCTS = 40;
const MAX_PHOTOS = 8;
const MAX_VARIANTS = 12;
const MAX_LINES = 10;
const MAX_QTY = 10;
const MAX_PRICE_CENTS = 500000; // 5000 euro, a guard against a slipped comma
const MAX_DISCOUNTS = 60;
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,23}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@<>()"',;:]{1,64}@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/;

/** where we ship, and what it costs; the owner can change all of this in the dashboard */
export const DEFAULT_SHOP = Object.freeze({
  open: true,
  vatNote: 'All prices include 21% VAT.',
  leadTime: 'Orders are sent within 3 working days.',
  freeFrom: 0, // in cents; 0 means no free shipping
  zones: [
    { key: 'nl', label: 'Netherlands', countries: ['NL'], cents: 495 },
    { key: 'be', label: 'Belgium, Germany, Luxembourg', countries: ['BE', 'DE', 'LU'], cents: 795 },
    { key: 'eu', label: 'Rest of Europe', countries: ['AT', 'BG', 'CY', 'CZ', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LV', 'MT', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'CH'], cents: 1495 },
  ],
  pickup: { enabled: false, label: 'Pick up in person', cents: 0 },
});

const COUNTRY_NAMES = {
  NL: 'Netherlands', BE: 'Belgium', DE: 'Germany', LU: 'Luxembourg', AT: 'Austria', BG: 'Bulgaria', CY: 'Cyprus',
  CZ: 'Czechia', DK: 'Denmark', EE: 'Estonia', ES: 'Spain', FI: 'Finland', FR: 'France', GB: 'United Kingdom',
  GR: 'Greece', HR: 'Croatia', HU: 'Hungary', IE: 'Ireland', IT: 'Italy', LT: 'Lithuania', LV: 'Latvia',
  MT: 'Malta', NO: 'Norway', PL: 'Poland', PT: 'Portugal', RO: 'Romania', SE: 'Sweden', SI: 'Slovenia',
  SK: 'Slovakia', CH: 'Switzerland', SR: 'Suriname', US: 'United States',
};

const parseJson = (v, fallback) => {
  try {
    const out = JSON.parse(v);
    return Array.isArray(out) ? out : fallback;
  } catch {
    return fallback;
  }
};
/** a number is already in cents (that is how the database hands it back), a string is money as written */
const cents = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : toCents(v));

const parseProduct = (row) => ({ ...row, variants: parseJson(row.variants, []), images: parseJson(row.images, []) });
const parseOrder = (row) => ({ ...row, items: parseJson(row.items, []) });

export function createShop({ db, media, payments, onOrderPaid = () => {} }) {
  const now = () => new Date().toISOString();

  /* ------------------------------------------------------------ settings */

  const getRow = db.prepare('SELECT value FROM site WHERE key = ?');
  const putRow = db.prepare(
    'INSERT INTO site (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  function settings() {
    const row = getRow.get('shop');
    if (!row) return { ...DEFAULT_SHOP };
    try {
      return { ...DEFAULT_SHOP, ...JSON.parse(row.value) };
    } catch {
      return { ...DEFAULT_SHOP };
    }
  }
  function saveSettings(body) {
    const current = settings();
    const zones = Array.isArray(body.zones)
      ? body.zones.slice(0, 8).map((z) => ({
          key: slugify(z.key || z.label, 'zone'),
          label: oneLine(z.label, 60) || 'Shipping',
          // a code is taken or dropped whole: a typo like "oops" must not become the country "OO"
          countries: (Array.isArray(z.countries) ? z.countries : []).map((c) => oneLine(c, 8).toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, 60),
          cents: Math.max(0, Math.min(50000, cents(z.cents ?? z.price) ?? 0)),
        }))
      : current.zones;
    const next = {
      open: body.open !== false,
      vatNote: oneLine(body.vatNote, 200) || DEFAULT_SHOP.vatNote,
      leadTime: oneLine(body.leadTime, 200) || DEFAULT_SHOP.leadTime,
      freeFrom: Math.max(0, Math.min(MAX_PRICE_CENTS, cents(body.freeFrom) ?? 0)),
      zones: zones.filter((z) => z.countries.length),
      pickup: {
        enabled: Boolean(body.pickup?.enabled),
        label: oneLine(body.pickup?.label, 60) || DEFAULT_SHOP.pickup.label,
        cents: Math.max(0, Math.min(50000, cents(body.pickup?.cents) ?? 0)),
      },
    };
    if (!next.zones.length) throw new HttpError(400, 'Keep at least one shipping zone with a country in it.');
    putRow.run('shop', JSON.stringify(next), now());
    return next;
  }

  /** what shipping costs for this country, or null when we do not ship there */
  function shippingFor(country, subtotal, pickup = false) {
    const s = settings();
    if (pickup) {
      if (!s.pickup.enabled) return null;
      return { cents: s.pickup.cents, label: s.pickup.label };
    }
    const zone = s.zones.find((z) => z.countries.includes(String(country).toUpperCase()));
    if (!zone) return null;
    if (s.freeFrom && subtotal >= s.freeFrom) return { cents: 0, label: `${zone.label} (free over ${euro(s.freeFrom)})` };
    return { cents: zone.cents, label: zone.label };
  }

  const countries = () => {
    const s = settings();
    const codes = [...new Set(s.zones.flatMap((z) => z.countries))];
    return codes.map((c) => ({ code: c, name: COUNTRY_NAMES[c] || c })).sort((a, b) => a.name.localeCompare(b.name));
  };

  /* ------------------------------------------------------------ products */

  const products = () => db.prepare('SELECT * FROM products ORDER BY position, id').all().map(parseProduct);
  const liveProducts = () => products().filter((p) => p.status !== 'draft' && p.images.length > 0);
  const productById = (id) => {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
    if (!row) throw new HttpError(404, 'Product not found.');
    return parseProduct(row);
  };

  function freeSlug(name, id = 0) {
    const base = slugify(name, 'piece');
    for (let i = 0; i < 50; i++) {
      const slug = i ? `${base}-${i + 1}` : base;
      if (!db.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').get(slug, id)) return slug;
    }
    return `${base}-${newId()}`;
  }

  /** sizes: every product keeps at least one, so an order line always points at something */
  function cleanVariants(list) {
    const out = (Array.isArray(list) ? list : []).slice(0, MAX_VARIANTS).map((v) => ({
      key: slugify(v.key || v.label, 'one-size'),
      label: oneLine(v.label, 30) || 'One size',
      stock: Math.max(0, Math.min(9999, Math.trunc(Number(v.stock)) || 0)),
    }));
    const seen = new Set();
    const unique = out.filter((v) => (seen.has(v.key) ? false : seen.add(v.key)));
    return unique.length ? unique : [{ key: 'one-size', label: 'One size', stock: 0 }];
  }

  /** `current` keeps a field that was left out as it is, so a partial save cannot pull a piece offline */
  function productFields(body, current = null) {
    const name = oneLine(body.name, 120);
    if (!name) throw new HttpError(400, 'A product needs a name.');
    const price = cents(body.price_cents ?? body.price);
    if (price === null || price < 0 || price > MAX_PRICE_CENTS) throw new HttpError(400, 'Give a price like 49,95.');
    const status = ['draft', 'live', 'soldout'].includes(body.status) ? body.status : current ? current.status : 'draft';
    const variants = Array.isArray(body.variants) || !current ? cleanVariants(body.variants) : current.variants;
    return { name, price, status, tagline: oneLine(body.tagline, 160), body: text(body.body, 4000), variants };
  }

  function createProduct(body) {
    if (products().length >= MAX_PRODUCTS) throw new HttpError(409, `There is room for ${MAX_PRODUCTS} products.`);
    const f = productFields(body);
    const stamp = now();
    const r = db
      .prepare(
        "INSERT INTO products (slug, name, tagline, body, price_cents, status, variants, images, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)",
      )
      .run(freeSlug(f.name), f.name, f.tagline, f.body, f.price, f.status, JSON.stringify(f.variants), products().length, stamp, stamp);
    return productById(Number(r.lastInsertRowid));
  }

  function updateProduct(id, body) {
    const current = productById(id);
    const f = productFields(body, current);
    db.prepare('UPDATE products SET slug = ?, name = ?, tagline = ?, body = ?, price_cents = ?, status = ?, variants = ?, updated_at = ? WHERE id = ?').run(
      freeSlug(f.name, current.id),
      f.name,
      f.tagline,
      f.body,
      f.price,
      f.status,
      JSON.stringify(f.variants),
      now(),
      current.id,
    );
    return productById(current.id);
  }

  async function removeProduct(id) {
    const product = productById(id);
    db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
    await Promise.all(product.images.map((img) => media.remove(img)));
    return { ok: true };
  }

  const saveImages = (id, images) =>
    db.prepare('UPDATE products SET images = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(images), now(), id);

  async function addPhoto(id, body) {
    const product = productById(id);
    if (product.images.length >= MAX_PHOTOS) throw new HttpError(409, `A product holds ${MAX_PHOTOS} photos.`);
    const photoId = `s${product.id}-${newId()}`;
    const big = await media.saveJpeg(body.image, `${photoId}.jpg`, 'The photo');
    const image = { id: photoId, src: `/media/${photoId}.jpg`, thumb: null, w: big.w, h: big.h, tw: null, alt: oneLine(body.alt) };
    if (body.thumb) {
      const small = await media.saveJpeg(body.thumb, `${photoId}-sm.jpg`, 'The small version');
      if (small.w < big.w) {
        image.thumb = `/media/${photoId}-sm.jpg`;
        image.tw = small.w;
      } else {
        await media.remove({ thumb: `/media/${photoId}-sm.jpg` });
      }
    }
    const fresh = productById(product.id);
    if (fresh.images.length >= MAX_PHOTOS) {
      await media.remove(image);
      throw new HttpError(409, `A product holds ${MAX_PHOTOS} photos.`);
    }
    fresh.images.push(image);
    saveImages(fresh.id, fresh.images);
    return productById(fresh.id);
  }

  /** the description a screen reader reads out; the photos themselves never change */
  function photoAlt(id, photoId, body) {
    const product = productById(id);
    const image = product.images.find((img) => img.id === photoId);
    if (!image) throw new HttpError(404, 'Photo not found.');
    image.alt = oneLine(body.alt, 200);
    saveImages(product.id, product.images);
    return productById(product.id);
  }

  async function removePhoto(id, photoId) {
    const product = productById(id);
    const i = product.images.findIndex((img) => img.id === photoId);
    if (i < 0) throw new HttpError(404, 'Photo not found.');
    const [gone] = product.images.splice(i, 1);
    saveImages(product.id, product.images);
    await media.remove(gone);
    return productById(product.id);
  }

  function orderPhotos(id, body) {
    const product = productById(id);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const known = new Map(product.images.map((img) => [img.id, img]));
    if (ids.length !== product.images.length || new Set(ids).size !== ids.length || !ids.every((x) => known.has(x))) {
      throw new HttpError(400, 'Send every photo exactly once.');
    }
    saveImages(product.id, ids.map((x) => known.get(x)));
    return productById(product.id);
  }

  function orderProducts(body) {
    const list = products();
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
    const known = new Map(list.map((p) => [p.id, p]));
    if (ids.length !== list.length || new Set(ids).size !== ids.length || !ids.every((x) => known.has(x))) {
      throw new HttpError(400, 'Send every product exactly once.');
    }
    const stamp = now();
    const set = db.prepare('UPDATE products SET position = ?, updated_at = ? WHERE id = ?');
    ids.forEach((x, i) => set.run(i, stamp, x));
    return products();
  }

  /* ------------------------------------------------------------ orders */

  const orders = (limit = 200) => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(500, limit))).map(parseOrder);
  const orderById = (id) => {
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
    if (!row) throw new HttpError(404, 'Order not found.');
    return parseOrder(row);
  };
  const orderByToken = (token) => {
    const row = db.prepare('SELECT * FROM orders WHERE token = ?').get(String(token ?? ''));
    return row ? parseOrder(row) : null;
  };
  const unreadOrders = () => db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid', 'shipped') AND read_at IS NULL").get().n;

  function soldOut(product) {
    return product.status === 'soldout' || product.variants.every((v) => v.stock <= 0);
  }

  /* ----------------------------------------------------------- discounts */

  const parseDiscount = (row) => ({ ...row });
  const discounts = () => db.prepare('SELECT * FROM discounts ORDER BY status, code').all().map(parseDiscount);
  const discountById = (id) => {
    const row = db.prepare('SELECT * FROM discounts WHERE id = ?').get(Number(id));
    if (!row) throw new HttpError(404, 'Code not found.');
    return parseDiscount(row);
  };
  const discountByCode = (code) => {
    const row = db.prepare('SELECT * FROM discounts WHERE code = ? COLLATE NOCASE').get(String(code ?? '').trim());
    return row ? parseDiscount(row) : null;
  };

  /** a day in Amsterdam, so a code that runs "until the 31st" works all of the 31st here */
  const today = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  function discountFields(body) {
    // read it long enough to see what was meant: a typed space is tidied away, but a code that is
    // really too long is handed back rather than quietly cut in half
    const code = oneLine(body.code, 80).toUpperCase().replace(/\s+/g, '');
    if (!CODE_RE.test(code)) throw new HttpError(400, 'A code is 3 to 24 letters, numbers or dashes, like LENTE10.');
    const kind = ['percent', 'amount', 'shipping'].includes(body.kind) ? body.kind : 'percent';
    let value = 0;
    if (kind === 'percent') {
      value = Math.trunc(Number(body.value) || 0);
      if (value < 1 || value > 95) throw new HttpError(400, 'A percentage runs from 1 to 95.');
    } else if (kind === 'amount') {
      value = cents(body.value) ?? 0;
      if (value < 1 || value > MAX_PRICE_CENTS) throw new HttpError(400, 'Give an amount like 5,00.');
    }
    for (const [key, day] of [['starts_on', body.starts_on], ['ends_on', body.ends_on]]) {
      const v = oneLine(day, 10);
      if (v && !DAY_RE.test(v)) throw new HttpError(400, 'Use a date like 2026-12-31.');
    }
    const starts = oneLine(body.starts_on, 10) || null;
    const ends = oneLine(body.ends_on, 10) || null;
    if (starts && ends && ends < starts) throw new HttpError(400, 'The last day cannot be before the first day.');
    return {
      code,
      kind,
      value,
      status: body.status === 'off' ? 'off' : 'live',
      min_cents: Math.max(0, Math.min(MAX_PRICE_CENTS, cents(body.min_cents ?? body.min) ?? 0)),
      starts_on: starts,
      ends_on: ends,
      max_uses: Math.max(0, Math.min(100000, Math.trunc(Number(body.max_uses) || 0))),
      note: oneLine(body.note, 200),
    };
  }

  function createDiscount(body) {
    if (discounts().length >= MAX_DISCOUNTS) throw new HttpError(409, `There is room for ${MAX_DISCOUNTS} codes.`);
    const f = discountFields(body);
    if (discountByCode(f.code)) throw new HttpError(409, 'That code already exists.');
    const stamp = now();
    const r = db
      .prepare(
        `INSERT INTO discounts (code, kind, value, status, min_cents, starts_on, ends_on, max_uses, used, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(f.code, f.kind, f.value, f.status, f.min_cents, f.starts_on, f.ends_on, f.max_uses, f.note, stamp, stamp);
    return discountById(Number(r.lastInsertRowid));
  }

  function updateDiscount(id, body) {
    const current = discountById(id);
    const f = discountFields({ ...current, ...body });
    const clash = discountByCode(f.code);
    if (clash && clash.id !== current.id) throw new HttpError(409, 'Another code already uses that name.');
    db.prepare(
      `UPDATE discounts SET code = ?, kind = ?, value = ?, status = ?, min_cents = ?, starts_on = ?, ends_on = ?,
         max_uses = ?, note = ?, updated_at = ? WHERE id = ?`,
    ).run(f.code, f.kind, f.value, f.status, f.min_cents, f.starts_on, f.ends_on, f.max_uses, f.note, now(), current.id);
    return discountById(current.id);
  }

  function removeDiscount(id) {
    const d = discountById(id);
    db.prepare('DELETE FROM discounts WHERE id = ?').run(d.id);
    return { ok: true };
  }

  /**
   * What a code is worth for this bag, right now. Everything a browser says is ignored: the
   * subtotal is the one we worked out ourselves and the rules come from our own row.
   */
  function priceWithDiscount(code, subtotal, shipping) {
    const empty = { code: null, kind: null, cents: 0, freeShipping: false, label: '' };
    const wanted = String(code ?? '').trim();
    if (!wanted) return empty;
    const d = discountByCode(wanted);
    if (!d || d.status !== 'live') throw new HttpError(404, 'We do not know that code.');
    const day = today();
    if (d.starts_on && day < d.starts_on) throw new HttpError(409, 'That code cannot be used yet.');
    if (d.ends_on && day > d.ends_on) throw new HttpError(409, 'That code has expired.');
    if (d.max_uses && d.used >= d.max_uses) throw new HttpError(409, 'That code has been used up.');
    if (subtotal < d.min_cents) throw new HttpError(409, `That code starts at ${euro(d.min_cents)}.`);
    if (d.kind === 'shipping') {
      return { code: d.code, kind: d.kind, cents: 0, freeShipping: true, label: 'Free shipping' };
    }
    const off = d.kind === 'percent' ? Math.round((subtotal * d.value) / 100) : d.value;
    const cut = Math.max(0, Math.min(subtotal, off));
    if (subtotal - cut + (shipping ? shipping.cents : 0) <= 0) {
      throw new HttpError(409, 'That code covers the whole order; write to us and we sort it out by hand.');
    }
    return {
      code: d.code,
      kind: d.kind,
      cents: cut,
      freeShipping: false,
      label: d.kind === 'percent' ? `${d.value}% off` : `${euro(d.value)} off`,
    };
  }

  /** what the bag page asks before anyone pays, so the total on screen is the real one */
  function quoteDiscount(body) {
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_LINES) : [];
    let subtotal = 0;
    for (const line of items) {
      const product = productById(line.product_id);
      const variant = product.variants.find((v) => v.key === oneLine(line.variant, 40));
      if (!variant) continue;
      const qty = Math.max(1, Math.min(MAX_QTY, Math.trunc(Number(line.qty)) || 1));
      subtotal += product.price_cents * qty;
    }
    const s = settings();
    const pickup = Boolean(body.pickup) && s.pickup.enabled;
    const country = pickup ? '' : oneLine(body.country, 2).toUpperCase();
    const shipping = shippingFor(country, subtotal, pickup);
    const cut = priceWithDiscount(body.code, subtotal, shipping);
    const shippingCents = shipping ? (cut.freeShipping ? 0 : shipping.cents) : 0;
    return {
      ok: true,
      code: cut.code,
      label: cut.label,
      discount_cents: cut.cents,
      free_shipping: cut.freeShipping,
      subtotal_cents: subtotal,
      shipping_cents: shippingCents,
      total_cents: Math.max(0, subtotal - cut.cents + shippingCents),
    };
  }

  /** everything a buyer sends is checked here, and the total is worked out from our own rows */
  async function placeOrder(body) {
    const s = settings();
    if (!s.open) throw new HttpError(503, 'The shop is closed right now.');
    if (payments.mode === 'off') throw new HttpError(503, 'The shop cannot take payments yet.');
    const name = oneLine(body.name, 120);
    const email = oneLine(body.email, 254).toLowerCase();
    if (!name) throw new HttpError(400, 'Tell us your name.');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'That email address does not look right.');
    const pickup = Boolean(body.pickup) && s.pickup.enabled;
    const country = pickup ? '' : oneLine(body.country, 2).toUpperCase();
    const address = {
      street: oneLine(body.street, 120),
      postcode: oneLine(body.postcode, 20),
      city: oneLine(body.city, 80),
      country,
    };
    if (!pickup && (!address.street || !address.postcode || !address.city || !/^[A-Z]{2}$/.test(country))) {
      throw new HttpError(400, 'Fill in your full address.');
    }

    const lines = Array.isArray(body.items) ? body.items.slice(0, MAX_LINES) : [];
    if (!lines.length) throw new HttpError(400, 'Your bag is empty.');
    const items = [];
    let subtotal = 0;
    for (const line of lines) {
      const product = productById(line.product_id);
      if (product.status !== 'live') throw new HttpError(409, `${product.name} is not for sale right now.`);
      const variant = product.variants.find((v) => v.key === oneLine(line.variant, 40));
      if (!variant) throw new HttpError(400, `Pick a size for ${product.name}.`);
      const qty = Math.max(1, Math.min(MAX_QTY, Math.trunc(Number(line.qty)) || 1));
      if (variant.stock < qty) {
        throw new HttpError(409, variant.stock ? `Only ${variant.stock} left of ${product.name} (${variant.label}).` : `${product.name} (${variant.label}) is sold out.`);
      }
      items.push({ product_id: product.id, name: product.name, variant: variant.label, variant_key: variant.key, qty, price_cents: product.price_cents });
      subtotal += product.price_cents * qty;
    }

    const shipping = shippingFor(country, subtotal, pickup);
    if (!shipping) throw new HttpError(400, 'We do not ship to that country yet.');
    // the code is worth what our own rows say it is, whatever the browser sent along
    const cut = priceWithDiscount(body.discount ?? body.code, subtotal, shipping);
    const shippingCents = cut.freeShipping ? 0 : shipping.cents;
    const total = subtotal - cut.cents + shippingCents;
    if (total <= 0) throw new HttpError(400, 'That order adds up to nothing.');

    const ref = orderRef();
    const token = newId() + newId();
    const stamp = now();
    const r = db
      .prepare(
        `INSERT INTO orders (ref, token, status, name, email, phone, street, postcode, city, country, note, items,
          subtotal_cents, shipping_cents, total_cents, discount_code, discount_cents, created_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ref,
        token,
        name,
        email,
        oneLine(body.phone, 40) || null,
        address.street,
        address.postcode,
        address.city,
        pickup ? 'PICKUP' : country,
        text(body.note, 500) || null,
        JSON.stringify(items),
        subtotal,
        shippingCents,
        total,
        cut.code,
        cut.cents,
        stamp,
      );
    const order = orderById(Number(r.lastInsertRowid));

    let payment;
    try {
      payment = await payments.create(order);
    } catch (err) {
      db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(order.id);
      throw err;
    }
    db.prepare('UPDATE orders SET payment_id = ? WHERE id = ?').run(payment.id, order.id);
    return { ok: true, ref, token, checkoutUrl: payment.checkoutUrl, total_cents: total, shipping: shipping.label };
  }

  /** stock only moves when the money is in, and so does a code's counter */
  function takeStock(order) {
    if (order.discount_code) {
      db.prepare('UPDATE discounts SET used = used + 1, updated_at = ? WHERE code = ? COLLATE NOCASE').run(now(), order.discount_code);
    }
    for (const line of order.items) {
      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(line.product_id);
      if (!row) continue;
      const product = parseProduct(row);
      const variant = product.variants.find((v) => v.key === line.variant_key);
      if (!variant) continue;
      variant.stock = Math.max(0, variant.stock - line.qty);
      const sold = product.variants.every((v) => v.stock <= 0);
      db.prepare('UPDATE products SET variants = ?, status = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(product.variants),
        sold && product.status === 'live' ? 'soldout' : product.status,
        now(),
        product.id,
      );
    }
  }

  const MOLLIE_TO_US = { paid: 'paid', failed: 'failed', canceled: 'canceled', expired: 'expired' };

  /** Mollie's webhook sends an id and nothing else, so the state is always read back from Mollie */
  async function syncPayment(paymentId) {
    const row = db.prepare('SELECT * FROM orders WHERE payment_id = ?').get(String(paymentId ?? ''));
    if (!row) return { ok: true, known: false };
    const order = parseOrder(row);
    const payment = await payments.get(paymentId);
    const next = MOLLIE_TO_US[payment.status];
    if (!next || next === order.status || order.status === 'shipped') return { ok: true, status: order.status };
    // Mollie's webhook and the buyer landing on the thank-you page can arrive in the same breath,
    // and both of them waited on the call above. Only the one that actually moves the row off
    // 'open' may take the stock and send the mail; the other finds nothing left to change.
    if (next === 'paid') {
      const moved = db
        .prepare("UPDATE orders SET status = 'paid', paid_at = ?, payment_method = ? WHERE id = ? AND status = 'open'")
        .run(payment.paidAt || now(), payment.method || null, order.id);
      if (!moved.changes) return { ok: true, status: orderById(order.id).status };
      takeStock(order);
      const paid = orderById(order.id);
      try {
        await onOrderPaid(paid);
      } catch (err) {
        console.error('[shop] after payment:', err.message);
      }
      return { ok: true, status: 'paid' };
    }
    const moved = db.prepare("UPDATE orders SET status = ? WHERE id = ? AND status = 'open'").run(next, order.id);
    return { ok: true, status: moved.changes ? next : orderById(order.id).status };
  }

  /** the thank-you page: an order is only ever shown through its secret token */
  async function statusByToken(token) {
    const order = orderByToken(token);
    if (!order) return null;
    if (order.status === 'open' && order.payment_id && payments.mode !== 'off') {
      await syncPayment(order.payment_id).catch(() => {});
      return orderByToken(token);
    }
    return order;
  }

  function markShipped(id, body) {
    const order = orderById(id);
    if (order.status !== 'paid' && order.status !== 'shipped') throw new HttpError(409, 'Only a paid order can be sent.');
    const shipped = body.shipped !== false;
    db.prepare('UPDATE orders SET status = ?, shipped_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ?').run(
      shipped ? 'shipped' : 'paid',
      shipped ? now() : null,
      now(),
      order.id,
    );
    return orderById(order.id);
  }

  function markRead(id, body) {
    const order = orderById(id);
    db.prepare('UPDATE orders SET read_at = ? WHERE id = ?').run(body.read === false ? null : now(), order.id);
    return orderById(order.id);
  }

  function removeOrder(id) {
    const order = orderById(id);
    if (order.status === 'paid' || order.status === 'shipped') throw new HttpError(409, 'A paid order stays in the books.');
    db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
    return { ok: true };
  }

  /* ------------------------------------------------------------ the page */

  /** what the page needs to show a product panel, as plain data */
  const publicProduct = (p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    body: p.body,
    price: p.price_cents,
    priceText: euro(p.price_cents),
    soldout: soldOut(p),
    images: p.images.map((img) => ({ src: img.src, thumb: img.thumb, w: img.w, h: img.h, tw: img.tw, alt: img.alt })),
    variants: p.variants.map((v) => ({ key: v.key, label: v.label, stock: v.stock })),
  });

  function state() {
    const s = settings();
    return {
      open: s.open && payments.mode !== 'off',
      payments: payments.mode,
      vatNote: s.vatNote,
      leadTime: s.leadTime,
      freeFrom: s.freeFrom,
      pickup: s.pickup,
      countries: countries(),
      zones: s.zones,
      products: liveProducts().map(publicProduct),
    };
  }

  function markup() {
    const list = liveProducts();
    if (!list.length) return '';
    const s = settings();
    const cards = list
      .map((p, i) => {
        const img = p.images[0];
        const w = Math.trunc(Number(img.w)) || 1;
        const h = Math.trunc(Number(img.h)) || 1;
        const src = img.thumb || img.src;
        const srcset = img.thumb ? ` srcset="${esc(img.thumb)} ${Math.trunc(Number(img.tw)) || 800}w, ${esc(img.src)} ${w}w" sizes="(max-aspect-ratio: 1/1) 46vw, 320px"` : '';
        const sold = soldOut(p);
        return `      <li class="piece${sold ? ' is-sold' : ''}" data-r="text" style="--d:${Math.min(i, 8) * 70}ms">
        <button class="piece__open" type="button" data-piece="${p.id}"${sold ? ' aria-disabled="true"' : ''}>
          <span class="piece__shot"><img src="${esc(src)}"${srcset} width="${w}" height="${h}" alt="${esc(img.alt || p.name)}" loading="lazy" decoding="async"></span>
          <span class="piece__line"><span class="piece__name">${esc(p.name)}</span><span class="piece__price">${sold ? 'Sold out' : esc(euro(p.price_cents))}</span></span>
          ${p.tagline ? `<span class="piece__tag">${esc(p.tagline)}</span>` : ''}
        </button>
      </li>`;
      })
      .join('\n');
    const data = JSON.stringify(state()).replace(/</g, '\\u003c');
    return `<section class="shop" id="shop" aria-labelledby="shop-h">
    <div class="wrap">
      <h2 id="shop-h" data-r="up">Shop</h2>
      <p class="shop__lead" data-r="text" style="--d:80ms">${esc(s.vatNote)} ${esc(s.leadTime)}</p>
      <ul class="shop__grid" role="list">
${cards}
      </ul>
    </div>
    <script type="application/json" id="shop-data">${data}</script>
  </section>`;
  }

  return {
    settings,
    saveSettings,
    countries,
    shippingFor,
    products,
    liveProducts,
    productById,
    createProduct,
    updateProduct,
    removeProduct,
    addPhoto,
    photoAlt,
    removePhoto,
    orderPhotos,
    orderProducts,
    discounts,
    createDiscount,
    updateDiscount,
    removeDiscount,
    quoteDiscount,
    orders,
    orderById,
    orderByToken,
    unreadOrders,
    placeOrder,
    syncPayment,
    statusByToken,
    markShipped,
    markRead,
    removeOrder,
    state,
    markup,
    limits: { products: MAX_PRODUCTS, photos: MAX_PHOTOS, variants: MAX_VARIANTS, qty: MAX_QTY, discounts: MAX_DISCOUNTS },
    mediaNames: () => products().flatMap((p) => p.images.flatMap((img) => media.names(img))),
  };
}
