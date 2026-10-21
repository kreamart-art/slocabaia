// Email and small-page rendering.
// (The shop emails and the thank-you page are at the bottom.)
// Newsletters are written in a tiny, safe markdown subset. Everything typed is HTML-escaped
// first; only these become markup: blank-line paragraphs, "# " and "## " headings,
// "- " lists, **bold** and [label](https://...) links (http, https and mailto only).

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>"'`]+$/i;
const INK = '#f2efe8';
const BODY = '#cfcabf';
const ASH = '#8c877e';
const EMBER = '#ff5e14';
const PANEL = '#121212';
const VOID = '#050505';
const FONT = 'Arial, Helvetica, sans-serif';
const LEGAL = `Slocabaia &middot; KvK 80563236 &middot; <a href="mailto:slocabaia@gmail.com" style="color:${ASH}">slocabaia@gmail.com</a>`;

/** inline markup on text that is already escaped */
function inline(escaped) {
  return escaped
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const raw = url.replace(/&amp;/g, '&');
      return SAFE_URL.test(raw)
        ? `<a href="${esc(raw)}" style="color:${EMBER};text-decoration:underline">${label}</a>`
        : m;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, `<strong style="color:${INK}">$1</strong>`);
}

function parse(md) {
  return String(md ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const h = /^(#{1,2})\s+([^\n]+)$/.exec(b);
      if (h) return { type: h[1].length === 1 ? 'h1' : 'h2', text: h[2] };
      const lines = b.split('\n');
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return { type: 'list', items: lines.map((l) => l.replace(/^\s*[-*]\s+/, '')) };
      }
      return { type: 'p', lines };
    });
}

function blocksHtml(blocks) {
  return blocks
    .map((b) => {
      if (b.type === 'h1') {
        return `<h1 style="margin:0 0 18px;font-family:${FONT};font-size:28px;line-height:1.1;font-weight:900;letter-spacing:.5px;text-transform:uppercase;color:${INK}">${inline(esc(b.text))}</h1>`;
      }
      if (b.type === 'h2') {
        return `<h2 style="margin:26px 0 10px;font-family:${FONT};font-size:13px;line-height:1.3;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:${EMBER}">${inline(esc(b.text))}</h2>`;
      }
      if (b.type === 'list') {
        return `<ul style="margin:0 0 18px;padding-left:20px;color:${BODY}">${b.items
          .map((i) => `<li style="margin:0 0 6px">${inline(esc(i))}</li>`)
          .join('')}</ul>`;
      }
      return `<p style="margin:0 0 18px;color:${BODY}">${b.lines.map((l) => inline(esc(l))).join('<br>')}</p>`;
    })
    .join('\n');
}

function toText(md) {
  return String(md ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^#{1,2}\s+(.+)$/gm, (m, t) => t.toUpperCase())
    .trim();
}

function shell({ title, preheader, inner, footer }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${VOID};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0">${esc(preheader)}&#8203;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${VOID}"><tr><td align="center" style="padding:32px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
<tr><td style="padding:0 6px 22px;font-family:${FONT};font-size:13px;font-weight:900;letter-spacing:4px;text-transform:uppercase;color:${INK}">Slocabaia</td></tr>
<tr><td style="background:${PANEL};border:1px solid #262626;border-radius:18px;padding:34px 30px;font-family:${FONT};font-size:16px;line-height:1.65;color:${BODY}">${inner}</td></tr>
<tr><td style="padding:22px 6px 0;font-family:${FONT};font-size:12px;line-height:1.7;color:${ASH}">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

export function renderNewsletter({ subject, preheader = '', body = '', unsubscribeUrl }) {
  const u = esc(unsubscribeUrl);
  const html = shell({
    title: subject,
    preheader,
    inner: blocksHtml(parse(body)) || `<p style="margin:0;color:${ASH}">(empty)</p>`,
    footer: `You get this because you became a member of The House of Slocabaia. <a href="${u}" style="color:${ASH};text-decoration:underline">Unsubscribe</a><br>${LEGAL}`,
  });
  const text =
    `${toText(body)}\n\n--\nYou get this because you became a member of The House of Slocabaia.\n` +
    `Unsubscribe: ${unsubscribeUrl}\nSlocabaia, KvK 80563236, slocabaia@gmail.com\n`;
  return { html, text };
}

export function renderConfirmEmail({ to, url, name = '' }) {
  const u = esc(url);
  const html = shell({
    title: 'Confirm your membership',
    preheader: 'One tap and you are in.',
    inner:
      `<h1 style="margin:0 0 18px;font-family:${FONT};font-size:28px;line-height:1.1;font-weight:900;text-transform:uppercase;color:${INK}">Almost in</h1>` +
      (name ? `<p style="margin:0 0 18px;color:${BODY}">Hi ${esc(name)},</p>` : '') +
      `<p style="margin:0 0 18px;color:${BODY}">Tap the button to confirm that <strong style="color:${INK}">${esc(to)}</strong> may receive drops, events, collaborations and creative opportunities from The House of Slocabaia.</p>` +
      `<p style="margin:26px 0 22px"><a href="${u}" style="display:inline-block;background:${EMBER};color:${VOID};font-family:${FONT};font-size:14px;font-weight:700;text-decoration:none;padding:13px 24px;border-radius:999px">Confirm membership</a></p>` +
      `<p style="margin:0;font-size:13px;color:${ASH}">Did not sign up? Ignore this email and nothing happens.</p>`,
    footer: LEGAL,
  });
  const text =
    `Almost in.\n\nConfirm that ${to} may receive drops, events, collaborations and creative opportunities from The House of Slocabaia:\n${url}\n\n` +
    `Did not sign up? Ignore this email and nothing happens.\n\nSlocabaia, KvK 80563236, slocabaia@gmail.com\n`;
  return { to, subject: 'Confirm your Slocabaia membership', html, text };
}

/** A copy of a contact message for the Slocabaia inbox (Dutch: it is for the team). Its
    Reply-To is the visitor, so answering it in Gmail answers them. */
export function renderContactAlert({ to, name, email, body, url }) {
  const html = shell({
    title: `Nieuw bericht van ${name}`,
    preheader: String(body).replace(/\s+/g, ' ').slice(0, 120),
    inner:
      `<p style="margin:0 0 8px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:${EMBER}">Contactformulier</p>` +
      `<h1 style="margin:0 0 6px;font-family:${FONT};font-size:24px;line-height:1.2;font-weight:900;color:${INK}">${esc(name)}</h1>` +
      `<p style="margin:0 0 20px"><a href="mailto:${esc(email)}" style="color:${EMBER}">${esc(email)}</a></p>` +
      `<p style="margin:0 0 24px;color:${INK}">${esc(body).replace(/\n/g, '<br>')}</p>` +
      `<p style="margin:0;font-size:13px;color:${ASH}">Beantwoord deze mail om ${esc(name)} direct te antwoorden. <a href="${esc(url)}" style="color:${ASH}">Open in het dashboard</a></p>`,
    footer: LEGAL,
  });
  const text = `Nieuw bericht via slocabaia.com\n\nVan: ${name} <${email}>\n\n${body}\n\nBeantwoord deze mail om direct te antwoorden.\nDashboard: ${url}\n`;
  return { to, replyTo: email, subject: `Bericht van ${name} via slocabaia.com`, html, text };
}

/** the page behind the unsubscribe link: ask, done, or invalid */
export function renderUnsubscribePage({ state, token }) {
  const t = encodeURIComponent(String(token ?? ''));
  const msg =
    state === 'done'
      ? '<h1>You are out</h1><p>You will not get our emails any more. Changed your mind? Sign up again on the site.</p>'
      : state === 'ask'
        ? `<h1>Leave the list?</h1><p>You will stop getting drops, events and collaborations by email.</p><form method="post" action="/u?t=${t}"><button type="submit">Unsubscribe</button></form>`
        : '<h1>Link not valid</h1><p>This link is old or incomplete. Reply to any of our emails and we take you off by hand.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Slocabaia</title><style>
body{margin:0;min-height:100svh;display:grid;place-items:center;background:#050505;color:#f2efe8;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;box-sizing:border-box}
main{max-width:440px}.k{letter-spacing:.3em;font-size:11px;text-transform:uppercase;color:#8c877e;margin:0 0 18px}
h1{font-size:28px;line-height:1.1;text-transform:uppercase;letter-spacing:.02em;margin:0 0 12px}p{color:#cfcabf;margin:0 0 20px}
button{font:700 14px system-ui,sans-serif;background:#ff5e14;color:#050505;border:0;border-radius:999px;padding:12px 22px;cursor:pointer}
button:focus-visible,a:focus-visible{outline:2px solid #ff5e14;outline-offset:3px}a{color:#8c877e}</style></head>
<body><main><p class="k">Slocabaia</p>${msg}<p><a href="/">Back to the site</a></p></main></body></html>`;
}

/* ------------------------------------------------------------------ shop */

const money = (c) => `&euro; ${(Math.round(Number(c) || 0) / 100).toFixed(2).replace('.', ',')}`;

function orderLines(order) {
  const rows = order.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0;color:${BODY}">${esc(i.qty)}x ${esc(i.name)}${i.variant ? ` <span style="color:${ASH}">(${esc(i.variant)})</span>` : ''}</td>` +
        `<td align="right" style="padding:6px 0;color:${INK};white-space:nowrap">${money(i.price_cents * i.qty)}</td></tr>`,
    )
    .join('');
  const cut = Number(order.discount_cents) || 0;
  const code = order.discount_code
    ? `<tr><td style="padding:10px 0 0;border-top:1px solid #2a2a2a;color:${BODY}">Discount <span style="color:${ASH}">${esc(order.discount_code)}</span></td>` +
      `<td align="right" style="padding:10px 0 0;border-top:1px solid #2a2a2a;color:${INK}">${cut ? `-${money(cut)}` : 'free shipping'}</td></tr>`
    : '';
  const line = code ? 'padding:6px 0 0' : 'padding:10px 0 0;border-top:1px solid #2a2a2a';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;font-size:15px">
    ${rows}
    ${code}
    <tr><td style="${line};color:${BODY}">Shipping</td><td align="right" style="${line};color:${INK}">${order.shipping_cents ? money(order.shipping_cents) : 'free'}</td></tr>
    <tr><td style="padding:6px 0 0;color:${INK};font-weight:bold">Total</td><td align="right" style="padding:6px 0 0;color:${INK};font-weight:bold">${money(order.total_cents)}</td></tr>
  </table>`;
}

const addressBlock = (order) =>
  order.country === 'PICKUP'
    ? 'Pick up in person'
    : [order.name, order.street, `${order.postcode} ${order.city}`.trim(), order.country].filter(Boolean).map(esc).join('<br>');

/** the receipt the buyer gets as soon as the payment comes through */
export function renderOrderEmail({ order, siteUrl }) {
  const html = shell({
    title: `Your Slocabaia order ${order.ref}`,
    preheader: `We got your order ${order.ref}.`,
    inner:
      `<p style="margin:0 0 8px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:${EMBER}">Order ${esc(order.ref)}</p>` +
      `<h1 style="margin:0 0 18px;font-family:${FONT};font-size:26px;line-height:1.15;font-weight:900;text-transform:uppercase;color:${INK}">Thank you, ${esc(String(order.name).split(' ')[0])}</h1>` +
      `<p style="margin:0 0 18px;color:${BODY}">Your payment came through and your order is with us.</p>` +
      orderLines(order) +
      `<p style="margin:0 0 6px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${EMBER}">Going to</p>` +
      `<p style="margin:0 0 22px;color:${BODY}">${addressBlock(order)}</p>` +
      `<p style="margin:0;font-size:13px;color:${ASH}">Questions about this order? Reply to this email and keep ${esc(order.ref)} in it.</p>`,
    footer: LEGAL,
  });
  const lines = order.items.map((i) => `${i.qty}x ${i.name}${i.variant ? ` (${i.variant})` : ''}`).join('\n');
  const text =
    `Thank you, ${order.name}.\n\nOrder ${order.ref}\n\n${lines}\n\n` +
    (order.discount_code ? `Discount ${order.discount_code}: -${((Number(order.discount_cents) || 0) / 100).toFixed(2)}\n` : '') +
    `Shipping: ${(order.shipping_cents / 100).toFixed(2)}\n` +
    `Total: ${(order.total_cents / 100).toFixed(2)}\n\nQuestions? Reply to this email.\n${siteUrl}\n`;
  return { to: order.email, subject: `Your Slocabaia order ${order.ref}`, html, text };
}

/** the copy that lands in the Slocabaia inbox, in Dutch, with the buyer as Reply-To */
export function renderOrderAlert({ to, order, url }) {
  const html = shell({
    title: `Nieuwe bestelling ${order.ref}`,
    preheader: `${order.name} bestelde voor ${(order.total_cents / 100).toFixed(2)} euro.`,
    inner:
      `<p style="margin:0 0 8px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:${EMBER}">Bestelling ${esc(order.ref)}</p>` +
      `<h1 style="margin:0 0 6px;font-family:${FONT};font-size:24px;line-height:1.2;font-weight:900;color:${INK}">${esc(order.name)}</h1>` +
      `<p style="margin:0 0 18px"><a href="mailto:${esc(order.email)}" style="color:${EMBER}">${esc(order.email)}</a>${order.phone ? ` &middot; ${esc(order.phone)}` : ''}</p>` +
      orderLines(order) +
      `<p style="margin:0 0 6px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${EMBER}">Verzenden naar</p>` +
      `<p style="margin:0 0 18px;color:${BODY}">${addressBlock(order)}</p>` +
      (order.note ? `<p style="margin:0 0 18px;color:${BODY}"><strong style="color:${INK}">Notitie:</strong> ${esc(order.note)}</p>` : '') +
      `<p style="margin:0;font-size:13px;color:${ASH}">Beantwoord deze mail om de klant te antwoorden. <a href="${esc(url)}" style="color:${ASH}">Open in het dashboard</a></p>`,
    footer: LEGAL,
  });
  const lines = order.items.map((i) => `${i.qty}x ${i.name}${i.variant ? ` (${i.variant})` : ''}`).join('\n');
  const text = `Nieuwe bestelling ${order.ref}\n\n${order.name} <${order.email}>\n\n${lines}\n\nTotaal: ${(order.total_cents / 100).toFixed(2)}\nDashboard: ${url}\n`;
  return { to, replyTo: order.email, subject: `Bestelling ${order.ref} van ${order.name}`, html, text };
}

/** the page people land on when they come back from Mollie */
export function renderOrderPage({ order, siteUrl }) {
  const head = !order
    ? { title: 'Order not found', body: '<p>This link is old or incomplete. Check the email we sent, or write to us and we look it up.</p>' }
    : order.status === 'paid' || order.status === 'shipped'
      ? {
          title: 'Thank you',
          body:
            `<p>Your payment came through. Order <b>${esc(order.ref)}</b> is with us and a receipt is on its way to ${esc(order.email)}.</p>` +
            `<p class="sum">${order.items.map((i) => `${esc(i.qty)}x ${esc(i.name)}${i.variant ? ` (${esc(i.variant)})` : ''}`).join('<br>')}` +
            `${order.discount_code ? `<br>Discount ${esc(order.discount_code)}${Number(order.discount_cents) ? ` &minus;${money(order.discount_cents)}` : ''}` : ''}` +
            `<br><b>Total ${money(order.total_cents)}</b></p>`,
        }
      : order.status === 'open'
        ? { title: 'Waiting for the bank', body: `<p>Order <b>${esc(order.ref)}</b> is in, but the payment has not come through yet. Refresh this page in a minute. You also get an email as soon as it lands.</p>` }
        : { title: 'Payment did not go through', body: `<p>Order <b>${esc(order.ref)}</b> was not paid, so nothing was charged and nothing was sent. You can order again whenever you want.</p>` };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Slocabaia</title><style>
body{margin:0;min-height:100svh;display:grid;place-items:center;background:#050505;color:#f2efe8;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;box-sizing:border-box}
main{max-width:460px}.k{letter-spacing:.3em;font-size:11px;text-transform:uppercase;color:#8c877e;margin:0 0 18px}
h1{font-size:28px;line-height:1.1;text-transform:uppercase;letter-spacing:.02em;margin:0 0 12px}p{color:#cfcabf;margin:0 0 20px}
.sum{padding:14px 16px;border:1px solid rgb(242 239 232 / .14);border-radius:14px;color:#f2efe8}
a{color:#ff5e14}a.btn{display:inline-block;background:#ff5e14;color:#050505;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:999px}
</style></head><body><main><p class="k">Slocabaia</p><h1>${esc(head.title)}</h1>${head.body}
<p><a class="btn" href="${esc(siteUrl)}/#shop">Back to the shop</a></p></main></body></html>`;
}
