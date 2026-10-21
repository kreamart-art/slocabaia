// Payments through Mollie (iDEAL and whatever else the account has switched on), no library.
// Without MOLLIE_API_KEY the shop runs in "off" mode: the page says so and takes no orders.
import { HttpError } from './http.js';

const PAYMENT_ID = /^tr_[A-Za-z0-9]+$/;

export function createPayments({ apiKey = '', siteUrl = '', apiBase = '' } = {}) {
  const base = (apiBase || 'https://api.mollie.com/v2').replace(/\/+$/, '');
  const site = String(siteUrl).replace(/\/+$/, '');
  const mode = !apiKey ? 'off' : apiKey.startsWith('live_') ? 'live' : 'test';

  async function call(path, init = {}) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(20e3),
      });
    } catch (err) {
      throw new HttpError(502, `Mollie could not be reached: ${err.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.detail || data?.title || `Mollie answered ${res.status}`;
      const e = new HttpError(res.status === 422 ? 422 : 502, detail);
      e.mollie = data;
      throw e;
    }
    return data;
  }

  return {
    mode,
    /** the checkout link the buyer is sent to */
    async create(order) {
      if (mode === 'off') throw new HttpError(503, 'Payments are not set up yet.');
      const d = await call('/payments', {
        method: 'POST',
        body: JSON.stringify({
          amount: { currency: 'EUR', value: (order.total_cents / 100).toFixed(2) },
          description: `Slocabaia order ${order.ref}`,
          redirectUrl: `${site}/shop/thanks?t=${order.token}`,
          cancelUrl: `${site}/shop/thanks?t=${order.token}`,
          webhookUrl: `${site}/api/shop/webhook`,
          metadata: { ref: order.ref },
          locale: 'nl_NL',
        }),
      });
      const checkoutUrl = d?._links?.checkout?.href || null;
      if (!checkoutUrl) throw new HttpError(502, 'Mollie gave no checkout link.');
      return { id: String(d.id || ''), checkoutUrl };
    },
    /**
     * Is the key any good, and what can people pay with? The dashboard asks this; nothing here
     * changes anything at Mollie, it only reads the profile and the methods that are switched on.
     */
    async check() {
      if (mode === 'off') return { ok: false, mode, reason: 'no-key' };
      try {
        const [profile, methods] = await Promise.all([call('/profiles/me'), call('/methods?locale=nl_NL')]);
        return {
          ok: true,
          mode,
          profile: { name: profile?.name || '', website: profile?.website || '', status: profile?.status || '' },
          methods: (methods?._embedded?.methods || []).map((m) => ({ id: String(m.id || ''), name: String(m.description || m.id || '') })),
        };
      } catch (err) {
        // 401 means the key itself is wrong; everything else is Mollie or the network talking
        const reason = err.mollie?.status === 401 || /unauthorized|authentication/i.test(err.message) ? 'bad-key' : 'error';
        return { ok: false, mode, reason, error: err.message };
      }
    },
    /** Mollie only sends an id in its webhook; the real state is always read back from here */
    async get(id) {
      if (mode === 'off') throw new HttpError(503, 'Payments are not set up yet.');
      if (!PAYMENT_ID.test(String(id || ''))) throw new HttpError(400, 'That is not a payment id.');
      const d = await call(`/payments/${id}`);
      return { id: String(d.id || ''), status: String(d.status || ''), method: d.method || null, paidAt: d.paidAt || null, amount: d.amount || null };
    },
  };
}
