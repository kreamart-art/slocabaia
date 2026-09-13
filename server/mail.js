// Mail delivery. With RESEND_API_KEY set, mail goes out through Resend. Without it the
// server runs in test mode: every message is written to data/outbox as an .html file and
// nothing leaves the machine. The dashboard shows which mode is active.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createMailer({ apiKey, from, replyTo, outboxDir, log = console.log }) {
  const mode = apiKey ? 'resend' : 'log';

  async function resend(path, body) {
    const res = await fetch(`https://api.resend.com${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.message || `Resend answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const payload = (m) => ({
    from,
    to: [m.to],
    reply_to: m.replyTo || replyTo || undefined,
    subject: m.subject,
    html: m.html,
    text: m.text,
    headers: m.headers,
  });

  function toOutbox(m) {
    mkdirSync(outboxDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(outboxDir, `${stamp}_${m.to.replace(/[^a-z0-9@._-]/gi, '_')}.html`);
    const note = `To: ${m.to}\nSubject: ${m.subject}`.replace(/--/g, '- -');
    writeFileSync(file, `<!--\n${note}\n-->\n${m.html}`);
    log(`[mail:test-mode] "${m.subject}" -> ${m.to}  (${file})`);
  }

  return {
    mode,
    from,
    /** one message */
    async send(m) {
      if (mode === 'log') {
        toOutbox(m);
        return { id: null, logged: true };
      }
      const d = await resend('/emails', payload(m));
      return { id: d.id || null };
    },
    /** up to 100 messages in one request; results line up with the input */
    async sendBatch(list) {
      if (mode === 'log') {
        list.forEach(toOutbox);
        return list.map(() => ({ id: null, logged: true }));
      }
      const d = await resend('/emails/batch', list.map(payload));
      const ids = Array.isArray(d?.data) ? d.data : [];
      return list.map((_, i) => ({ id: ids[i]?.id || null }));
    },
  };
}
