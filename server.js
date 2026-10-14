'use strict';

require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { createPool, migrate } = require('./lib/db');
const { enqueueEmail, registrationEmail, cancellationEmail, createOutboxWorker } = require('./lib/mailer');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const isProduction = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long');
}

const JWT_OPTS = { issuer: 'college-event-cloud', audience: 'college-event-users' };
// Used so a login attempt for an unknown email costs the same as a real one (no timing oracle).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
// The check-in scanner needs the camera; nothing else on the page may use sensors.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '30kb' }));
app.use(cookieParser());

const pool = createPool();
const worker = createOutboxWorker(pool);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT || 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT || 15),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});
app.use('/api', apiLimiter);

/* ---------- helpers ---------- */
function cleanString(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}
function safeUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}
function makeToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn: '8h', ...JWT_OPTS });
}
function cookieOptions() {
  return { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' };
}
function setSessionCookie(res, token) {
  res.cookie('session', token, { ...cookieOptions(), maxAge: 8 * 60 * 60 * 1000 });
}
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 1 ? id : null;
}
function escapeLike(value) {
  return value.replace(/[\\%_]/g, c => `\\${c}`);
}

/**
 * Authentication hits the database on every request (one indexed primary-key lookup).
 * That makes deactivation, demotion and password changes effective immediately,
 * instead of after the 8-hour JWT expiry, and keeps `role` from going stale.
 */
const requireAuth = asyncRoute(async (req, res, next) => {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ error: 'Please log in first.' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, JWT_OPTS);
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
  const { rows } = await pool.query(
    'SELECT id, name, email, role, is_active, password_changed_at FROM users WHERE id = $1', [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.is_active) return res.status(401).json({ error: 'This account is no longer available.' });
  if (user.password_changed_at && payload.iat < Math.floor(user.password_changed_at.getTime() / 1000)) {
    return res.status(401).json({ error: 'Your password changed. Please log in again.' });
  }
  req.user = { sub: String(user.id), role: user.role, email: user.email, name: user.name };
  next();
});
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}
// Only a UI hint (e.g. "you are registered"); never use this for authorisation.
function optionalUserId(req) {
  const token = req.cookies.session;
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET, JWT_OPTS).sub; } catch { return null; }
}

/* ---------- startup tasks ---------- */
async function bootstrapAdmin() {
  const email = cleanString(process.env.ADMIN_EMAIL, 254).toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return;
  if (!validEmail(email)) throw new Error('ADMIN_EMAIL is not valid');
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rowCount === 0) {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO users(name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      ['Event Administrator', email, hash, 'admin']
    );
    console.log('Bootstrap administrator created.');
  }
}

/* ---------- health ---------- */
app.get('/api/health', asyncRoute(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({
    status: 'ok',
    database: 'connected',
    instance: process.env.K_REVISION || process.env.HOSTNAME || 'local',
    time: new Date().toISOString()
  });
}));

// Demonstration endpoint: identifies which container handled this request.
// Keep this endpoint free of secrets and personal data.
app.get('/api/instance', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    instance: process.env.HOSTNAME || process.env.K_REVISION || 'local',
    revision: process.env.K_REVISION || 'local',
    note: 'Cloud Run manages request routing and instance scaling.'
  });
});

/* ---------- auth ---------- */
app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const name = cleanString(req.body.name, 100);
  const email = cleanString(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (name.length < 2) return res.status(400).json({ error: 'Name must contain at least 2 characters.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 10 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be 10–72 characters long.' });
  }

  const hash = await bcrypt.hash(password, 12);
  try {
    const result = await pool.query(
      'INSERT INTO users(name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, hash, 'student']
    );
    const user = safeUser(result.rows[0]);
    setSessionCookie(res, makeToken(user));
    res.status(201).json({ user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    throw err;
  }
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const email = cleanString(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const userRow = result.rows[0];
  const passwordOk = await bcrypt.compare(password, userRow ? userRow.password_hash : DUMMY_HASH);
  if (!userRow || !passwordOk) return res.status(401).json({ error: 'Invalid email or password.' });
  if (!userRow.is_active) return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
  const user = safeUser(userRow);
  setSessionCookie(res, makeToken(user));
  res.json({ user });
}));

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session', cookieOptions());
  res.json({ message: 'Logged out.' });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role } });
});

app.post('/api/me/password', authLimiter, requireAuth, asyncRoute(async (req, res) => {
  const current = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
  const next = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
  if (next.length < 10 || next.length > 72) {
    return res.status(400).json({ error: 'New password must be 10–72 characters long.' });
  }
  if (next === current) return res.status(400).json({ error: 'Choose a password different from the current one.' });

  const { rows } = await pool.query('SELECT id, name, email, role, password_hash FROM users WHERE id = $1', [req.user.sub]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  await pool.query(
    'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2',
    [await bcrypt.hash(next, 12), req.user.sub]
  );
  // Every older session is now rejected by requireAuth; keep this browser signed in with a fresh token.
  setSessionCookie(res, makeToken(rows[0]));
  res.json({ message: 'Password updated. Other devices have been signed out.' });
}));

/* ---------- events ---------- */
app.get('/api/events', asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT e.*,
      (SELECT COUNT(*)::int FROM registrations r WHERE r.event_id = e.id AND r.cancelled_at IS NULL) AS registered_count,
      (SELECT r.id FROM registrations r WHERE r.event_id = e.id AND r.user_id = $1 AND r.cancelled_at IS NULL) AS my_registration_id
    FROM events e
    ORDER BY e.starts_at ASC
  `, [optionalUserId(req)]);
  res.json({ events: result.rows });
}));

app.post('/api/events', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const title = cleanString(req.body.title, 150);
  const description = cleanString(req.body.description, 3000);
  const venue = cleanString(req.body.venue, 180);
  const startsAt = new Date(req.body.startsAt);
  const deadline = new Date(req.body.deadline);
  const capacity = Number(req.body.capacity);

  if (title.length < 3 || description.length < 5 || venue.length < 2) {
    return res.status(400).json({ error: 'Provide a title, description and venue.' });
  }
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(deadline.getTime())) {
    return res.status(400).json({ error: 'Enter valid event and deadline dates.' });
  }
  if (deadline >= startsAt) return res.status(400).json({ error: 'Registration deadline must be before the event starts.' });
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) {
    return res.status(400).json({ error: 'Capacity must be a positive whole number.' });
  }

  const result = await pool.query(
    `INSERT INTO events(title, description, venue, starts_at, registration_deadline, capacity, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [title, description, venue, startsAt.toISOString(), deadline.toISOString(), capacity, req.user.sub]
  );
  res.status(201).json({ event: result.rows[0] });
}));

/* ---------- registration & cancellation ---------- */
app.post('/api/events/:id/register', requireAuth, asyncRoute(async (req, res) => {
  const eventId = parseId(req.params.id);
  if (!eventId) return res.status(400).json({ error: 'Invalid event ID.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Row lock on the event serialises concurrent registrations, so capacity can never be oversold.
    const eventResult = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    const event = eventResult.rows[0];
    if (!event) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found.' });
    }
    if (new Date(event.registration_deadline) <= new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Registration deadline has passed.' });
    }
    const existing = await client.query(
      'SELECT id FROM registrations WHERE user_id = $1 AND event_id = $2 AND cancelled_at IS NULL',
      [req.user.sub, eventId]
    );
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You are already registered for this event.' });
    }
    const countResult = await client.query(
      'SELECT COUNT(*)::int AS count FROM registrations WHERE event_id = $1 AND cancelled_at IS NULL',
      [eventId]
    );
    if (countResult.rows[0].count >= event.capacity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This event is full.' });
    }
    const ticketToken = crypto.randomBytes(32).toString('hex');
    const inserted = await client.query(
      `INSERT INTO registrations(user_id, event_id, ticket_token)
       VALUES ($1, $2, $3) RETURNING id, event_id, ticket_token, created_at`,
      [req.user.sub, eventId, ticketToken]
    );
    const mail = registrationEmail({ name: req.user.name, event });
    await enqueueEmail(client, { to: req.user.email, subject: mail.subject, text: mail.text, qrToken: ticketToken });
    await client.query('COMMIT');
    worker.kick();

    const ticket = inserted.rows[0];
    const qrDataUrl = await QRCode.toDataURL(ticket.ticket_token, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
    res.status(201).json({ registration: { ...ticket, qrDataUrl } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'You are already registered for this event.' });
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/api/my/registrations/:id/cancel', requireAuth, asyncRoute(async (req, res) => {
  const registrationId = parseId(req.params.id);
  if (!registrationId) return res.status(400).json({ error: 'Invalid registration ID.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Scoped to the caller: someone else's registration looks exactly like a missing one.
    const found = await client.query(`
      SELECT r.id, r.attended_at, r.cancelled_at, e.title, e.venue, e.starts_at
      FROM registrations r JOIN events e ON e.id = r.event_id
      WHERE r.id = $1 AND r.user_id = $2
      FOR UPDATE OF r`, [registrationId, req.user.sub]);
    const reg = found.rows[0];
    if (!reg) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Registration not found.' }); }
    if (reg.cancelled_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This registration is already cancelled.' }); }
    if (reg.attended_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'You have already checked in, so this cannot be cancelled.' }); }
    if (new Date(reg.starts_at) <= new Date()) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This event has already started.' }); }

    await client.query('UPDATE registrations SET cancelled_at = NOW() WHERE id = $1', [registrationId]);
    const mail = cancellationEmail({ name: req.user.name, event: reg });
    await enqueueEmail(client, { to: req.user.email, subject: mail.subject, text: mail.text });
    await client.query('COMMIT');
    worker.kick();
    res.json({ message: 'Registration cancelled. Your seat is available to others.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

app.get('/api/my/registrations', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT r.id AS registration_id, r.ticket_token, r.attended_at, r.cancelled_at, r.created_at AS registered_at,
           e.id AS event_id, e.title, e.venue, e.starts_at, e.registration_deadline,
           (r.cancelled_at IS NULL AND r.attended_at IS NULL AND e.starts_at > NOW()) AS can_cancel
    FROM registrations r JOIN events e ON e.id = r.event_id
    WHERE r.user_id = $1 ORDER BY e.starts_at ASC, r.id ASC
  `, [req.user.sub]);

  const registrations = await Promise.all(result.rows.map(async ({ ticket_token, ...row }) => {
    if (row.cancelled_at) return row; // a cancelled ticket must not be displayable
    return {
      ...row,
      ticket_token,
      qrDataUrl: await QRCode.toDataURL(ticket_token, { errorCorrectionLevel: 'M', margin: 2, width: 200 })
    };
  }));
  res.json({ registrations });
}));

/* ---------- admin: reports & check-in ---------- */
app.get('/api/admin/registrations', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const eventId = parseId(req.query.eventId);
  if (!eventId) return res.status(400).json({ error: 'A valid eventId is required.' });
  const result = await pool.query(`
    SELECT r.id, r.attended_at, r.cancelled_at, r.created_at AS registered_at,
           u.name, u.email, e.title
    FROM registrations r
    JOIN users u ON u.id = r.user_id
    JOIN events e ON e.id = r.event_id
    WHERE r.event_id = $1
    ORDER BY r.created_at ASC
  `, [eventId]);
  res.json({ registrations: result.rows });
}));

app.post('/api/admin/checkin', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const ticketToken = cleanString(req.body.ticketToken, 80);
  if (!/^[a-f0-9]{64}$/.test(ticketToken)) return res.status(400).json({ error: 'Enter a valid ticket token.' });
  // Optional: the scanner can pin the session to one event so a ticket for another event is refused.
  const eventId = req.body.eventId === undefined || req.body.eventId === null || req.body.eventId === ''
    ? null : parseId(req.body.eventId);
  if (req.body.eventId && !eventId) return res.status(400).json({ error: 'Invalid event ID.' });

  const marked = await pool.query(`
    UPDATE registrations r SET attended_at = NOW()
    FROM users u, events e
    WHERE r.ticket_token = $1 AND r.attended_at IS NULL AND r.cancelled_at IS NULL
      AND u.id = r.user_id AND e.id = r.event_id
      AND ($2::bigint IS NULL OR r.event_id = $2)
    RETURNING r.id, r.event_id, r.attended_at, u.name AS attendee_name, e.title AS event_title
  `, [ticketToken, eventId]);
  if (marked.rowCount) {
    const row = marked.rows[0];
    return res.json({
      message: `Checked in: ${row.attendee_name} — ${row.event_title}`,
      registration: row
    });
  }

  // The atomic UPDATE refused it; work out why so the door volunteer gets a precise answer.
  const why = await pool.query(`
    SELECT r.event_id, r.attended_at, r.cancelled_at, u.name AS attendee_name, e.title AS event_title
    FROM registrations r JOIN users u ON u.id = r.user_id JOIN events e ON e.id = r.event_id
    WHERE r.ticket_token = $1`, [ticketToken]);
  const row = why.rows[0];
  if (!row) return res.status(404).json({ error: 'Ticket not found.' });
  if (row.cancelled_at) return res.status(409).json({ error: `Ticket cancelled (${row.attendee_name}). Do not admit.` });
  if (eventId && String(row.event_id) !== String(eventId)) {
    return res.status(409).json({ error: `Wrong event: this ticket is for "${row.event_title}".` });
  }
  return res.status(409).json({ error: `Already checked in: ${row.attendee_name}.` });
}));

/* ---------- admin: user management ---------- */
app.get('/api/admin/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const q = cleanString(typeof req.query.q === 'string' ? req.query.q : '', 100);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const pattern = q ? `%${escapeLike(q)}%` : null;

  const [list, total] = await Promise.all([
    pool.query(`
      SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
        (SELECT COUNT(*)::int FROM registrations r WHERE r.user_id = u.id AND r.cancelled_at IS NULL) AS active_registrations
      FROM users u
      WHERE ($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1)
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT $2 OFFSET $3`, [pattern, limit, offset]),
    pool.query('SELECT COUNT(*)::int AS count FROM users u WHERE ($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1)', [pattern])
  ]);
  res.json({ users: list.rows, total: total.rows[0].count, limit, offset });
}));

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const targetId = parseId(req.params.id);
  if (!targetId) return res.status(400).json({ error: 'Invalid user ID.' });
  const { role, isActive } = req.body;
  if (role === undefined && isActive === undefined) return res.status(400).json({ error: 'Nothing to update.' });
  if (role !== undefined && !['student', 'admin'].includes(role)) return res.status(400).json({ error: 'Role must be student or admin.' });
  if (isActive !== undefined && typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive must be true or false.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the whole set of active admins first (always in id order). Concurrent admin edits
    // are serialised, so two admins cannot demote each other at once and leave zero admins.
    const admins = (await client.query(
      "SELECT id FROM users WHERE role = 'admin' AND is_active ORDER BY id FOR UPDATE"
    )).rows;
    if (!admins.some(a => String(a.id) === req.user.sub)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Administrator access required.' });
    }
    const target = (await client.query(
      'SELECT id, name, email, role, is_active FROM users WHERE id = $1 FOR UPDATE', [targetId]
    )).rows[0];
    if (!target) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found.' }); }

    const newRole = role ?? target.role;
    const newActive = isActive ?? target.is_active;
    if (String(target.id) === req.user.sub && (newRole !== 'admin' || !newActive)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot demote or deactivate your own account.' });
    }
    const wasActiveAdmin = target.role === 'admin' && target.is_active;
    const willBeActiveAdmin = newRole === 'admin' && newActive;
    if (wasActiveAdmin && !willBeActiveAdmin && admins.length <= 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'At least one active administrator is required.' });
    }

    const updated = await client.query(
      'UPDATE users SET role = $2, is_active = $3 WHERE id = $1 RETURNING id, name, email, role, is_active, created_at',
      [targetId, newRole, newActive]
    );
    await client.query('COMMIT');
    console.log(`[audit] admin ${req.user.sub} set user ${targetId}: role=${newRole} active=${newActive}`);
    res.json({ user: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/* ---------- static files & errors ---------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '1h' : 0 }));

app.use((err, req, res, next) => {
  console.error('Request failed:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

async function start() {
  await migrate(pool);
  await bootstrapAdmin();
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`College Event Cloud listening on ${PORT}`));
  worker.start();

  // Cloud Run sends SIGTERM before stopping an instance: finish in-flight requests, then exit.
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down.');
    worker.stop();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 9000).unref();
  });
}
start().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
