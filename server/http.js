// Small HTTP helpers shared by the routes in index.js and site.js.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

export const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

// A body has to arrive in time: the server allows 30 minutes per request (for video uploads),
// so a client that trickles a small form one byte at a time is cut off here instead.
export function readBody(req, limit = 200 * 1024, timeoutMs = limit > 1024 * 1024 ? 180e3 : 20e3) {
  return new Promise((ok, fail) => {
    let size = 0;
    let over = false;
    const chunks = [];
    const timer = setTimeout(() => {
      fail(new HttpError(408, 'The request took too long.'));
      req.destroy();
    }, timeoutMs);
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        fail(new HttpError(413, 'Too large'));
      } else chunks.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (!over) ok(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('close', () => clearTimeout(timer));
    req.on('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
  });
}

export async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
