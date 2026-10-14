'use strict';
/**
 * Integration tests. They start the real server against the database in DATABASE_URL
 * and only create uniquely named data, but use a throwaway database anyway.
 *   DATABASE_URL=postgresql://... npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const PORT = 18080 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = Date.now();
const ADMIN = { email: `admin.${RUN}@test.example`, password: 'AdminPassword#2026' };
const PASS = 'StudentPass#2026';

let server;
let pool;

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.getSetCookie?.() || [];
    const session = set.find(c => c.startsWith('session='));
    if (session) this.cookie = session.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  get(u) { return this.call('GET', u); }
  post(u, b = {}) { return this.call('POST', u, b); }
  patch(u, b) { return this.call('PATCH', u, b); }
}

async function newStudent(tag) {
  const c = new Client();
  const email = `${tag}.${RUN}@test.example`;
  const r = await c.post('/api/auth/register', { name: `Student ${tag}`, email, password: PASS });
  assert.equal(r.status, 201);
  return { c, email, id: r.data.user.id };
}
async function adminClient() {
  const c = new Client();
  const r = await c.post('/api/auth/login', ADMIN);
  assert.equal(r.status, 200);
  return c;
}
const hours = h => new Date(Date.now() + h * 3600 * 1000).toISOString();
async function makeEvent(admin, over = {}) {
  const r = await admin.post('/api/events', {
    title: `Event ${Math.random().toString(36).slice(2, 7)}`, description: 'Test event', venue: 'Hall A',
    startsAt: hours(48), deadline: hours(24), capacity: 5, ...over
  });
  assert.equal(r.status, 201);
  return r.data.event;
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  server = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, PORT: String(PORT), NODE_ENV: 'test',
      JWT_SECRET: 'x'.repeat(48), ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      AUTH_RATE_LIMIT: '1000', API_RATE_LIMIT: '10000', SMTP_HOST: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
});
after(async () => { server?.kill('SIGTERM'); await pool?.end(); });

test('health reports the database as connected', async () => {
  const r = await new Client().get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.database, 'connected');
});

test('students cannot reach admin endpoints; anonymous users get 401', async () => {
  const { c } = await newStudent('rbac');
  assert.equal((await c.post('/api/events', {})).status, 403);
  assert.equal((await c.get('/api/admin/users')).status, 403);
  assert.equal((await new Client().get('/api/my/registrations')).status, 401);
});

test('register -> duplicate rejected -> capacity enforced', async () => {
  const admin = await adminClient();
  const ev = await makeEvent(admin, { capacity: 1 });
  const a = await newStudent('cap-a');
  const b = await newStudent('cap-b');
  assert.equal((await a.c.post(`/api/events/${ev.id}/register`)).status, 201);
  assert.equal((await a.c.post(`/api/events/${ev.id}/register`)).status, 409);
  const full = await b.c.post(`/api/events/${ev.id}/register`);
  assert.equal(full.status, 409);
  assert.match(full.data.error, /full/i);
});

test('concurrent registrations never oversell the last seat', async () => {
  const admin = await adminClient();
  const ev = await makeEvent(admin, { capacity: 2 });
  const students = await Promise.all([1, 2, 3, 4, 5, 6].map(i => newStudent(`race${i}`)));
  const results = await Promise.all(students.map(s => s.c.post(`/api/events/${ev.id}/register`)));
  assert.equal(results.filter(r => r.status === 201).length, 2);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM registrations WHERE event_id=$1 AND cancelled_at IS NULL', [ev.id]);
  assert.equal(rows[0].n, 2);
});

test('cancel frees the seat, invalidates the ticket, and allows re-registering', async () => {
  const admin = await adminClient();
  const ev = await makeEvent(admin, { capacity: 1 });
  const a = await newStudent('cancel-a');
  const b = await newStudent('cancel-b');
  const reg = (await a.c.post(`/api/events/${ev.id}/register`)).data.registration;

  assert.equal((await b.c.post(`/api/my/registrations/${reg.id}/cancel`)).status, 404, "other users' registrations look missing");
  assert.equal((await a.c.post(`/api/my/registrations/${reg.id}/cancel`)).status, 200);
  assert.equal((await a.c.post(`/api/my/registrations/${reg.id}/cancel`)).status, 409, 'double cancel');

  const mine = (await a.c.get('/api/my/registrations')).data.registrations[0];
  assert.ok(mine.cancelled_at);
  assert.equal(mine.ticket_token, undefined, 'cancelled tickets expose no token');

  const checkin = await admin.post('/api/admin/checkin', { ticketToken: reg.ticket_token });
  assert.equal(checkin.status, 409);
  assert.match(checkin.data.error, /cancelled/i);

  assert.equal((await b.c.post(`/api/events/${ev.id}/register`)).status, 201, 'freed seat is reusable');
  assert.equal((await a.c.post(`/api/events/${ev.id}/register`)).status, 409, 'now full again');
});

test('a student can re-register after cancelling', async () => {
  const admin = await adminClient();
  const ev = await makeEvent(admin);
  const a = await newStudent('rereg');
  const first = (await a.c.post(`/api/events/${ev.id}/register`)).data.registration;
  await a.c.post(`/api/my/registrations/${first.id}/cancel`);
  const second = await a.c.post(`/api/events/${ev.id}/register`);
  assert.equal(second.status, 201);
  assert.notEqual(second.data.registration.ticket_token, first.ticket_token);
});

test('check-in: success, replay, unknown token, wrong event, checked-in tickets cannot be cancelled', async () => {
  const admin = await adminClient();
  const ev = await makeEvent(admin);
  const other = await makeEvent(admin);
  const a = await newStudent('door');
  const reg = (await a.c.post(`/api/events/${ev.id}/register`)).data.registration;

  const wrong = await admin.post('/api/admin/checkin', { ticketToken: reg.ticket_token, eventId: other.id });
  assert.equal(wrong.status, 409);
  assert.match(wrong.data.error, /wrong event/i);

  const ok = await admin.post('/api/admin/checkin', { ticketToken: reg.ticket_token, eventId: ev.id });
  assert.equal(ok.status, 200);
  assert.match(ok.data.message, /Student door/);

  assert.equal((await admin.post('/api/admin/checkin', { ticketToken: reg.ticket_token })).status, 409);
  assert.equal((await admin.post('/api/admin/checkin', { ticketToken: 'a'.repeat(64) })).status, 404);
  assert.equal((await admin.post('/api/admin/checkin', { ticketToken: 'nope' })).status, 400);
  assert.equal((await a.c.post(`/api/my/registrations/${reg.id}/cancel`)).status, 409);
});

test('cancellation is refused once the event has started', async () => {
  const admin = await adminClient();
  const ev = await makeEvent(admin);
  const a = await newStudent('late');
  const reg = (await a.c.post(`/api/events/${ev.id}/register`)).data.registration;
  await pool.query("UPDATE events SET starts_at = NOW() - INTERVAL '1 hour', registration_deadline = NOW() - INTERVAL '2 hours' WHERE id=$1", [ev.id]);
  assert.equal((await a.c.post(`/api/my/registrations/${reg.id}/cancel`)).status, 400);
});

test('emails are queued transactionally and the worker drains the outbox', async () => {
  const admin = await adminClient();
  const ev = await makeEvent(admin);
  const a = await newStudent('mail');
  const reg = (await a.c.post(`/api/events/${ev.id}/register`)).data.registration;
  await a.c.post(`/api/my/registrations/${reg.id}/cancel`);

  const queued = await pool.query('SELECT subject, qr_token, status FROM email_outbox WHERE to_email=$1 ORDER BY id', [a.email]);
  assert.equal(queued.rowCount, 2);
  assert.match(queued.rows[0].subject, /registered/i);
  assert.equal(queued.rows[0].qr_token, reg.ticket_token);
  assert.equal(queued.rows[1].qr_token, null, 'cancellation mail carries no QR');

  for (let i = 0; i < 40; i++) {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM email_outbox WHERE to_email=$1 AND status='sent'", [a.email]);
    if (rows[0].n === 2) return;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.fail('outbox was not drained');
});

test('admin user management: promote, safeguards, immediate deactivation', async () => {
  const admin = await adminClient();
  const { c, email, id } = await newStudent('managed');

  const list = await admin.get(`/api/admin/users?q=${encodeURIComponent(email)}`);
  assert.equal(list.data.total, 1);
  assert.equal((await admin.get('/api/admin/users?q=%25')).status, 200, 'LIKE wildcards are escaped');

  assert.equal((await admin.patch(`/api/admin/users/${id}`, { role: 'superuser' })).status, 400);
  assert.equal((await admin.patch(`/api/admin/users/${id}`, {})).status, 400);

  assert.equal((await admin.patch(`/api/admin/users/${id}`, { role: 'admin' })).status, 200);
  assert.equal((await c.get('/api/admin/users')).status, 200, 'promotion applies without re-login');

  const me = (await admin.get('/api/me')).data.user;
  const self = await admin.patch(`/api/admin/users/${me.id}`, { role: 'student' });
  assert.equal(self.status, 400, 'cannot demote yourself');
  assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { isActive: false })).status, 400);

  assert.equal((await admin.patch(`/api/admin/users/${id}`, { role: 'student' })).status, 200);
  assert.equal((await c.get('/api/admin/users')).status, 403, 'demotion applies immediately');

  assert.equal((await admin.patch(`/api/admin/users/${id}`, { isActive: false })).status, 200);
  assert.equal((await c.get('/api/me')).status, 401, 'existing session is dead immediately');
  const login = await new Client().post('/api/auth/login', { email, password: PASS });
  assert.equal(login.status, 403);

  assert.equal((await admin.patch(`/api/admin/users/${id}`, { isActive: true })).status, 200);
  assert.equal((await new Client().post('/api/auth/login', { email, password: PASS })).status, 200);
  assert.equal((await admin.patch('/api/admin/users/99999999', { role: 'admin' })).status, 404);
});

test('change password: wrong current rejected, other sessions revoked, new password works', async () => {
  const { c, email } = await newStudent('pw');
  const other = new Client();
  await other.post('/api/auth/login', { email, password: PASS });

  assert.equal((await c.post('/api/me/password', { currentPassword: 'wrong-password-1', newPassword: 'BrandNewPass#99' })).status, 401);
  assert.equal((await c.post('/api/me/password', { currentPassword: PASS, newPassword: 'short' })).status, 400);

  await new Promise(r => setTimeout(r, 1100)); // JWT iat has 1-second resolution
  assert.equal((await c.post('/api/me/password', { currentPassword: PASS, newPassword: 'BrandNewPass#99' })).status, 200);

  assert.equal((await c.get('/api/me')).status, 200, 'this browser stays signed in');
  assert.equal((await other.get('/api/me')).status, 401, 'other devices are signed out');
  assert.equal((await new Client().post('/api/auth/login', { email, password: PASS })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { email, password: 'BrandNewPass#99' })).status, 200);
});

test('camera permission is allowed for this origin only', async () => {
  const res = await fetch(`${BASE}/`);
  assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.ok((await fetch(`${BASE}/vendor/jsQR.js`)).ok);
});
