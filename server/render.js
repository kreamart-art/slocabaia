// Email and small-page rendering.
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

export function renderConfirmEmail({ to, url }) {
  const u = esc(url);
  const html = shell({
    title: 'Confirm your membership',
    preheader: 'One tap and you are in.',
    inner:
      `<h1 style="margin:0 0 18px;font-family:${FONT};font-size:28px;line-height:1.1;font-weight:900;text-transform:uppercase;color:${INK}">Almost in</h1>` +
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
