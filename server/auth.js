// Password hashing, tokens and a small in-memory rate limiter.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** scrypt$N$r$p$salt$key, all binary parts base64. The plain password is never stored. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  if (!expected.length) return false;
  let actual;
  try {
    actual = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/** Sliding-window limiter: take(key) is true while the key has budget left. */
export function limiter({ max, windowMs }) {
  const hits = new Map();
  let prunedAt = 0;
  // a full sweep at most once a minute, so a flood of new keys cannot make every request O(n)
  const prune = (now) => {
    if (hits.size < 5000 || now - prunedAt < 60e3) return;
    prunedAt = now;
    for (const [k, times] of hits) if (!times.some((t) => now - t < windowMs)) hits.delete(k);
  };
  return {
    take(key) {
      const now = Date.now();
      prune(now);
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      const ok = recent.length < max;
      if (ok) recent.push(now);
      hits.set(key, recent);
      return ok;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
