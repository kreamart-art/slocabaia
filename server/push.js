// Web push without dependencies: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291),
// both on node:crypto. Every device that turned notifications on in the dashboard has a row in
// push_subscriptions; notify() reaches all of them.
import { createECDH, createPrivateKey, sign, randomBytes, hkdfSync, createCipheriv } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s ?? ''), 'base64url');

// Only real push services, so a subscription can never make this server POST somewhere else.
const PUSH_HOST_RE = /(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com)$/;
const MAX_PAYLOAD = 3000; // stays well inside one 4096-byte record

export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function signingKey({ publicKey, privateKey }) {
  const pub = unb64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be an uncompressed P-256 point');
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** the Authorization header for one push service: a short-lived ES256 JWT plus our public key */
export function vapidAuthorization(endpoint, keys, subject, key = signingKey(keys)) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const data = `${head}.${claims}`;
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** RFC 8291: encrypt one payload for one subscription (a single aes128gcm record) */
export function encryptPayload(payload, { p256dh, auth }, { salt = randomBytes(16), ecdh } = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length < 16) throw new Error('Invalid subscription keys');
  const server = ecdh || createECDH('prime256v1');
  if (!ecdh) server.generateKeys();
  const asPublic = server.getPublicKey();
  const shared = server.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** a subscription as the browser's PushSubscription.toJSON() gives it, checked */
export function parseSubscription(sub) {
  const endpoint = String(sub?.endpoint ?? '');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !PUSH_HOST_RE.test(url.hostname) || endpoint.length > 1000) return null;
  const p256dh = String(sub?.keys?.p256dh ?? '');
  const auth = String(sub?.keys?.auth ?? '');
  if (unb64u(p256dh).length !== 65 || unb64u(auth).length < 16) return null;
  return { endpoint, p256dh, auth };
}

export function createPush({ db, subject, keys: fromEnv }) {
  // keys from the environment win; otherwise made once and kept in the database, so devices
  // stay subscribed across redeploys
  let keys = fromEnv?.publicKey && fromEnv?.privateKey ? fromEnv : null;
  if (!keys) {
    const row = db.prepare("SELECT value FROM site WHERE key = 'vapid'").get();
    try {
      keys = row ? JSON.parse(row.value) : null;
    } catch {
      keys = null;
    }
  }
  if (!keys?.publicKey || !keys?.privateKey) {
    keys = generateVapidKeys();
    db.prepare("INSERT INTO site (key, value, updated_at) VALUES ('vapid', ?, ?)").run(JSON.stringify(keys), new Date().toISOString());
  }
  const key = signingKey(keys);

  const all = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions');
  const drop = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const ok = db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?');

  async function sendOne(sub, payload) {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400',
        Urgency: 'high',
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        Authorization: vapidAuthorization(sub.endpoint, keys, subject, key),
      },
      body: encryptPayload(payload, sub),
      signal: AbortSignal.timeout(10e3),
    });
    return res.status;
  }

  return {
    publicKey: keys.publicKey,
    count: () => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n,
    subscribe(sub, label = '') {
      const s = parseSubscription(sub);
      if (!s) return false;
      db.prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
      ).run(s.endpoint, s.p256dh, s.auth, String(label).slice(0, 120), new Date().toISOString());
      return true;
    },
    unsubscribe: (endpoint) => drop.run(String(endpoint ?? '')).changes > 0,
    /** never throws: a notification that fails must not break the request that caused it */
    async notify({ title, body = '', url = '/admin/', tag }) {
      try {
        const subs = all.all();
        if (!subs.length) return 0;
        let payload = JSON.stringify({ title, body, url, tag });
        if (Buffer.byteLength(payload) > MAX_PAYLOAD) payload = JSON.stringify({ title, body: body.slice(0, 600), url, tag });
        const results = await Promise.allSettled(subs.map((s) => sendOne(s, payload)));
        let sent = 0;
        results.forEach((r, i) => {
          const status = r.status === 'fulfilled' ? r.value : 0;
          if (status >= 200 && status < 300) {
            sent += 1;
            ok.run(new Date().toISOString(), subs[i].endpoint);
          } else if (status === 404 || status === 410) {
            drop.run(subs[i].endpoint); // the browser dropped it: app removed or permission revoked
          } else {
            console.error('[push]', status || r.reason?.message || r.reason);
          }
        });
        return sent;
      } catch (err) {
        console.error('[push]', err);
        return 0;
      }
    },
  };
}
