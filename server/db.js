// SQLite store for members, newsletters, deliveries, page views and admin sessions.
// node:sqlite ships with Node, so there is nothing to install.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'slocabaia.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;

    -- one row per email address; the token confirms the membership and later unsubscribes it
    CREATE TABLE IF NOT EXISTS subscribers (
      id              INTEGER PRIMARY KEY,
      email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
      status          TEXT NOT NULL CHECK (status IN ('pending', 'active', 'unsubscribed')),
      token           TEXT NOT NULL UNIQUE,
      source          TEXT,
      created_at      TEXT NOT NULL,
      confirmed_at    TEXT,
      unsubscribed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id         INTEGER PRIMARY KEY,
      subject    TEXT NOT NULL,
      preheader  TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed')),
      recipients INTEGER NOT NULL DEFAULT 0,
      sent       INTEGER NOT NULL DEFAULT 0,
      failed     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at    TEXT
    );

    -- no email address is copied here, so erasing a member erases them everywhere
    CREATE TABLE IF NOT EXISTS deliveries (
      id            INTEGER PRIMARY KEY,
      campaign_id   INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL,
      status        TEXT NOT NULL CHECK (status IN ('sent', 'logged', 'failed')),
      provider_id   TEXT,
      error         TEXT,
      at            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deliveries_campaign ON deliveries (campaign_id, subscriber_id);

    -- a bare counter per day: no IP, no cookie, no visitor id
    CREATE TABLE IF NOT EXISTS pageviews (
      day   TEXT NOT NULL,
      path  TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, path)
    );

    -- what the dashboard can change on the site: the hero and the photo row (JSON values)
    CREATE TABLE IF NOT EXISTS site (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- messages sent with the contact form on the site; spam = the honeypot was filled in
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at    TEXT,
      spam       INTEGER NOT NULL DEFAULT 0
    );

    -- devices that turned notifications on in the dashboard (web push)
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      label      TEXT,
      created_at TEXT NOT NULL,
      last_ok_at TEXT
    );

    -- what the shop sells; photos and sizes live in the JSON columns
    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      tagline     TEXT NOT NULL DEFAULT '',
      body        TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'soldout')),
      variants    TEXT NOT NULL DEFAULT '[]',   -- [{ key, label, stock }]
      images      TEXT NOT NULL DEFAULT '[]',   -- [{ id, src, thumb, w, h, tw, alt }]
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    -- one row per order; the price is always the one the server worked out
    CREATE TABLE IF NOT EXISTS orders (
      id             INTEGER PRIMARY KEY,
      ref            TEXT NOT NULL UNIQUE,   -- SB-XXXXXX, the reference people see
      token          TEXT NOT NULL UNIQUE,   -- the secret in the thank-you link
      status         TEXT NOT NULL CHECK (status IN ('open', 'paid', 'failed', 'canceled', 'expired', 'shipped')),
      name           TEXT NOT NULL,
      email          TEXT NOT NULL,
      phone          TEXT,
      street         TEXT NOT NULL DEFAULT '',
      postcode       TEXT NOT NULL DEFAULT '',
      city           TEXT NOT NULL DEFAULT '',
      country        TEXT NOT NULL DEFAULT '',
      note           TEXT,
      items          TEXT NOT NULL,          -- [{ product_id, name, variant, qty, price_cents }]
      subtotal_cents INTEGER NOT NULL,
      shipping_cents INTEGER NOT NULL,
      total_cents    INTEGER NOT NULL,
      payment_id     TEXT,
      payment_method TEXT,
      created_at     TEXT NOT NULL,
      paid_at        TEXT,
      shipped_at     TEXT,
      read_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS orders_created ON orders (created_at DESC);

    -- events that happened, with their photo sets; visitors can download each photo
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY,
      slug       TEXT NOT NULL UNIQUE,
      title      TEXT NOT NULL,
      held_on    TEXT,                      -- YYYY-MM-DD
      place      TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live')),
      photos     TEXT NOT NULL DEFAULT '[]', -- [{ id, full, thumb, w, h, tw, alt }]
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- only a hash of the session token is stored
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  // Members gave only an email at first; these came later and are added to older databases here.
  const columns = db.prepare('PRAGMA table_info(subscribers)').all().map((c) => c.name);
  for (const [name, type] of [['name', 'TEXT'], ['phone', 'TEXT'], ['city', 'TEXT'], ['country', 'TEXT'], ['birthday', 'TEXT']]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE subscribers ADD COLUMN ${name} ${type}`);
  }
  return db;
}
