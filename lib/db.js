'use strict';

const { Pool } = require('pg');

/**
 * TLS modes for PGSSL:
 *   true | verify  -> encrypted AND the server certificate is verified (recommended)
 *   no-verify      -> encrypted but certificate NOT verified (only if your provider needs it)
 *   anything else  -> no TLS (local development)
 * Optional PGSSL_CA: PEM text of a custom CA certificate.
 * NOTE: an sslmode=... parameter inside DATABASE_URL overrides this setting (node-postgres behaviour).
 */
function sslConfig(env = process.env) {
  const mode = String(env.PGSSL || '').toLowerCase();
  if (mode === 'true' || mode === 'verify') {
    return { rejectUnauthorized: true, ...(env.PGSSL_CA ? { ca: env.PGSSL_CA } : {}) };
  }
  if (mode === 'no-verify') {
    if (env.NODE_ENV === 'production') {
      console.warn('PGSSL=no-verify: traffic is encrypted but the database certificate is not verified.');
    }
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function createPool(env = process.env) {
  return new Pool({
    connectionString: env.DATABASE_URL,
    ssl: sslConfig(env),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}

// Append-only list. Never edit an applied migration; add a new one instead.
const MIGRATIONS = [
  {
    id: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(254) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        description TEXT NOT NULL,
        venue VARCHAR(180) NOT NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        registration_deadline TIMESTAMPTZ NOT NULL,
        capacity INTEGER NOT NULL CHECK (capacity > 0),
        created_by BIGINT REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS registrations (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        ticket_token VARCHAR(80) NOT NULL UNIQUE,
        attended_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events(starts_at);
      CREATE INDEX IF NOT EXISTS idx_registrations_event_id ON registrations(event_id);
      CREATE INDEX IF NOT EXISTS idx_registrations_user_id ON registrations(user_id);
    `
  },
  {
    id: 2,
    name: 'registration_cancellation',
    // Soft delete + partial unique index: one ACTIVE registration per user/event,
    // while cancelled rows stay for auditing and allow re-registration.
    sql: `
      ALTER TABLE registrations ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
      ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_user_id_event_id_key;
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_registration
        ON registrations(user_id, event_id) WHERE cancelled_at IS NULL;
    `
  },
  {
    id: 3,
    name: 'user_status_and_password_tracking',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
    `
  },
  {
    id: 4,
    name: 'email_outbox',
    sql: `
      CREATE TABLE IF NOT EXISTS email_outbox (
        id BIGSERIAL PRIMARY KEY,
        to_email VARCHAR(254) NOT NULL,
        subject VARCHAR(250) NOT NULL,
        body_text TEXT NOT NULL,
        qr_token VARCHAR(80),
        status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        send_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_pending ON email_outbox(send_after) WHERE status = 'pending';
    `
  }
];

const MIGRATION_LOCK_ID = 727001;

async function migrate(pool) {
  const client = await pool.connect();
  try {
    // Serialises concurrent cold starts (several Cloud Run instances booting at once).
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    const { rows } = await client.query('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map(r => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations(id, name) VALUES ($1, $2)', [m.id, m.name]);
        await client.query('COMMIT');
        console.log(`Applied migration ${m.id}: ${m.name}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { createPool, migrate, sslConfig, MIGRATIONS };
