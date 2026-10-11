// Small helpers shared by the site, the shop and the events pages.
import { randomBytes } from 'node:crypto';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** one tidy line of plain text, cut to length: names, alt texts, short fields */
export const oneLine = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** free text that keeps its paragraphs: product and event descriptions */
export const text = (v, max = 5000) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

export const newId = () => randomBytes(6).toString('hex');

/** a web address part made from a title: "Winter Drop 2026" -> "winter-drop-2026" */
export const slugify = (s, fallback = 'item') =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || fallback;

/** a short order reference people can read out loud: no 0/O/1/I to confuse */
export const orderRef = () => {
  const A = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789';
  return `SB-${[...randomBytes(6)].map((b) => A[b % A.length]).join('')}`;
};

/** 1250 -> "€ 12,50" */
export const euro = (c) => `€ ${(Math.round(Number(c) || 0) / 100).toFixed(2).replace('.', ',')}`;

/** "12,50", "12.50", " € 12,50 " -> 1250 cents; anything unreadable -> null */
export function toCents(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100);
  let s = String(v ?? '').replace(/[^\d,.-]/g, '');
  if (!s) return null;
  const negative = s.includes('-');
  s = s.replace(/-/g, '');
  // "49,95", "49.95", "1.299,00" and "1,299.00" are all money people write; the last separator with
  // one or two digits behind it is the decimal mark, every other dot or comma groups thousands.
  const cut = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  let whole = s;
  let frac = '';
  if (cut >= 0 && /^\d{1,2}$/.test(s.slice(cut + 1))) {
    whole = s.slice(0, cut);
    frac = s.slice(cut + 1).padEnd(2, '0');
  }
  whole = whole.replace(/[,.]/g, '');
  if (!/^\d+$/.test(whole)) return null;
  const total = Number(whole) * 100 + Number(frac || 0);
  if (!Number.isSafeInteger(total)) return null;
  return negative ? -total : total;
}
