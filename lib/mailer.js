'use strict';

const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

const MAX_ATTEMPTS = 5;
const LEASE_MINUTES = 2;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function maskEmail(email) {
  const [local = '', domain = ''] = String(email).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
function formatWhen(value) {
  return new Intl.DateTimeFormat('en-IN', {
    // dateStyle/timeStyle cannot be combined with timeZoneName, so spell the fields out.
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: process.env.EVENT_TIMEZONE || 'Asia/Kolkata',
    timeZoneName: 'short'
  }).format(new Date(value));
}

function createTransport(env = process.env) {
  if (env.SMTP_HOST) {
    const port = Number(env.SMTP_PORT || 587);
    return {
      kind: 'smtp',
      transport: nodemailer.createTransport({
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000
      })
    };
  }
  // No SMTP configured: build the message but do not deliver it (development / classroom demo).
  return { kind: 'log', transport: nodemailer.createTransport({ jsonTransport: true }) };
}

/** Call inside the SAME transaction as the business change so the two commit or roll back together. */
function enqueueEmail(client, { to, subject, text, qrToken = null }) {
  return client.query(
    'INSERT INTO email_outbox(to_email, subject, body_text, qr_token) VALUES ($1, $2, $3, $4)',
    [to, String(subject).slice(0, 250), text, qrToken]
  );
}

function registrationEmail({ name, event }) {
  return {
    subject: `You're registered: ${event.title}`,
    text: [
      `Hi ${name},`, '',
      `You're registered for "${event.title}".`,
      `When: ${formatWhen(event.starts_at)}`,
      `Where: ${event.venue}`, '',
      'Show the QR code below at the door. It is also available under "My tickets" in CampusConnect.',
      'If your plans change, please cancel your registration so someone else can take your place.'
    ].join('\n')
  };
}
function cancellationEmail({ name, event }) {
  return {
    subject: `Registration cancelled: ${event.title}`,
    text: [
      `Hi ${name},`, '',
      `Your registration for "${event.title}" (${formatWhen(event.starts_at)}) has been cancelled and the ticket is no longer valid.`,
      'You can register again from CampusConnect if seats are still available and the deadline has not passed.'
    ].join('\n')
  };
}

async function buildMessage(row) {
  const message = {
    from: process.env.MAIL_FROM || 'CampusConnect <no-reply@campusconnect.local>',
    to: row.to_email,
    subject: row.subject,
    text: row.body_text,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#142033"><p>${escapeHtml(row.body_text).replace(/\n/g, '<br>')}</p>${row.qr_token ? '<p><img src="cid:ticketqr" width="220" height="220" alt="Your QR ticket"></p>' : ''}</div>`
  };
  if (row.qr_token) {
    message.attachments = [{
      filename: 'ticket-qr.png',
      content: await QRCode.toBuffer(row.qr_token, { errorCorrectionLevel: 'M', margin: 2, width: 440 }),
      cid: 'ticketqr'
    }];
  }
  return message;
}

/**
 * Outbox worker. Rows are "leased" by pushing send_after into the future inside a single
 * atomic UPDATE ... FOR UPDATE SKIP LOCKED, so several instances never send the same email,
 * and a crashed instance's rows simply become visible again when the lease expires.
 */
function createOutboxWorker(pool, { intervalMs = 15000, batchSize = 10 } = {}) {
  const { kind, transport } = createTransport();
  let timer = null;
  let running = false;
  let lastCleanup = 0;

  async function claim() {
    const { rows } = await pool.query(`
      UPDATE email_outbox SET attempts = attempts + 1, send_after = NOW() + make_interval(mins => $2)
      WHERE id IN (
        SELECT id FROM email_outbox
        WHERE status = 'pending' AND send_after <= NOW()
        ORDER BY id LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, to_email, subject, body_text, qr_token, attempts`, [batchSize, LEASE_MINUTES]);
    return rows;
  }

  async function runOnce() {
    if (running) return 0;
    running = true;
    let processed = 0;
    try {
      for (const row of await claim()) {
        try {
          const info = await transport.sendMail(await buildMessage(row));
          if (kind === 'log') console.log(`[mail:not-delivered] "${row.subject}" to ${maskEmail(row.to_email)} (set SMTP_HOST to deliver)`);
          else console.log(`[mail] sent #${row.id} ${info.messageId || ''}`);
          await pool.query("UPDATE email_outbox SET status = 'sent', sent_at = NOW(), last_error = NULL WHERE id = $1", [row.id]);
        } catch (err) {
          const finalFailure = row.attempts >= MAX_ATTEMPTS;
          console.error(`[mail] attempt ${row.attempts} failed for #${row.id}: ${err.message}`);
          await pool.query(
            `UPDATE email_outbox SET status = $2, last_error = $3,
               send_after = NOW() + make_interval(mins => $4) WHERE id = $1`,
            [row.id, finalFailure ? 'failed' : 'pending', String(err.message).slice(0, 500), row.attempts * row.attempts]
          );
        }
        processed += 1;
      }
      if (Date.now() - lastCleanup > 60 * 60 * 1000) {
        lastCleanup = Date.now();
        await pool.query("DELETE FROM email_outbox WHERE status <> 'pending' AND created_at < NOW() - INTERVAL '30 days'");
      }
    } catch (err) {
      console.error('[mail] worker error:', err.message);
    } finally {
      running = false;
    }
    return processed;
  }

  return {
    kind,
    runOnce,
    start() {
      if (kind === 'log' && process.env.NODE_ENV === 'production') {
        console.warn('SMTP_HOST is not set: emails are queued but never delivered.');
      }
      timer = setInterval(runOnce, intervalMs);
      timer.unref();
      setImmediate(runOnce);
    },
    kick() { setImmediate(runOnce); },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}

module.exports = { enqueueEmail, registrationEmail, cancellationEmail, createOutboxWorker, createTransport };
