# CampusConnect — College Event Registration & Attendance Management System

A CA3 mini-project prototype featuring student accounts, event publishing, event registration and cancellation, QR tickets, camera-based admin check-in, email notifications, user management, registration reports, PostgreSQL persistence, and cloud deployment.

## Architecture

- **Web UI:** HTML, CSS and browser JavaScript served by Express
- **API:** Node.js + Express
- **Database:** PostgreSQL
- **Cloud target:** Google Cloud Run
- **Database hosting:** Neon PostgreSQL or another managed PostgreSQL provider
- **Load balancing:** Cloud Run managed ingress and request routing across container instances
- **Version control:** GitHub

> This uses Cloud Run's managed traffic routing. It does not create a separate, dedicated Google Cloud external Application Load Balancer resource.

## Features

- Student registration and login, plus **change password** (revokes all other sessions)
- Admin bootstrap from environment variables
- Event creation and event listing
- Capacity/deadline checks and duplicate-registration protection (row-locked, so seats cannot be oversold)
- **Cancellation:** students cancel until the event starts; the seat is freed, the QR ticket is invalidated, and they can re-register
- QR ticket generation with cryptographically random ticket tokens
- **Camera check-in:** admins scan tickets with the phone/laptop camera (manual token entry remains as a fallback); an optional event filter rejects tickets for other events and the screen shows who was admitted
- **Email notifications:** registration confirmation (with the QR code attached) and cancellation notice, sent through a transactional outbox
- **User management:** search users, promote/demote administrators, deactivate/reactivate accounts (takes effect immediately)
- Registration reports (active, checked in, cancelled)
- Versioned database migrations that upgrade older databases automatically
- Health and instance diagnostic endpoints
- Rate limiting, Helmet security headers, parameterized SQL, password hashing, HttpOnly session cookie and role checks
- Automated integration tests (`npm test`)

## Requirements

- Node.js 20+
- PostgreSQL database
- Git
- For cloud deployment: Google Cloud project with billing enabled, Cloud Run and Cloud Build permissions, and a managed PostgreSQL database URL

## Local setup

1. Create a PostgreSQL database called `college_events`.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `PGSSL` for your environment.
4. Install dependencies and start the app:

```bash
npm install
npm start
```

5. Open `http://localhost:8080`.
6. Sign in to the administrator account using `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
7. Create an event, register a student account, reserve a spot, and test the QR ticket/check-in flow.

The database tables are created automatically at startup. The bootstrap administrator is created only if the configured email does not already exist. If you change the admin password environment variable after the user already exists, the database password is not automatically changed.

## Important environment variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port; Cloud Run supplies this |
| `NODE_ENV` | Set to `production` in cloud |
| `DATABASE_URL` | PostgreSQL connection string |
| `PGSSL` | `true` = TLS **with certificate verification** (recommended for Neon and other managed providers); `no-verify` = encrypted but unverified; unset/`false` = no TLS (local only). Optional `PGSSL_CA` holds a custom CA certificate in PEM form. An `sslmode=` inside `DATABASE_URL` overrides this setting. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | SMTP server for notification emails (port 465 uses implicit TLS, otherwise STARTTLS is used when offered). If `SMTP_HOST` is unset, emails are queued but not delivered and a masked log line is printed. |
| `MAIL_FROM` | Sender, e.g. `CampusConnect <no-reply@yourdomain>` |
| `EVENT_TIMEZONE` | Time zone used to format dates inside emails (default `Asia/Kolkata`) |
| `AUTH_RATE_LIMIT`, `API_RATE_LIMIT` | Optional overrides for the rate limits (defaults 15 and 300 per 15 minutes per IP) |
| `JWT_SECRET` | Long random signing secret, at least 32 characters |
| `ADMIN_EMAIL` | Initial admin account email |
| `ADMIN_PASSWORD` | Initial admin account password; at least 12 characters |

Never commit `.env` or real credentials. Configure secrets in the hosting platform's secret manager/environment configuration.

## Cloud deployment overview

1. Create a managed PostgreSQL database (for example, Neon). Keep its connection string private.
2. Create a Google Cloud project and enable billing.
3. Install and authenticate the Google Cloud CLI.
4. From the project folder, deploy the source to Cloud Run:

```bash
gcloud run deploy campusconnect \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --concurrency 10 \
  --max 5 \
  --no-cpu-throttling
```

`--no-cpu-throttling` keeps CPU allocated between requests. The email outbox worker runs in the background, so without it emails can be delayed until the next request wakes the instance. They are never lost: unsent rows stay in `email_outbox` and are retried (up to 5 times with backoff). Several instances can run the worker at once because each email is leased with `FOR UPDATE SKIP LOCKED`. Check current Cloud Run pricing for instance-based billing.

5. In Cloud Run service configuration, add the environment variables. Use Secret Manager-backed secrets for `DATABASE_URL`, `JWT_SECRET`, and `ADMIN_PASSWORD`; set `NODE_ENV=production` and `PGSSL=true` if required by your database provider.
6. Grant the Cloud Run service account only the permissions it needs. Do not place database passwords or service-account keys in source code.
7. Open the service URL and test registration, login, event creation, registration and check-in.

Cloud Run can scale container instances based on traffic and routes requests to healthy instances. `--max 5` is an upper bound, not a guarantee that five instances will run. Scale-out depends on incoming traffic and platform decisions. Check current Google Cloud pricing and quotas before deployment.

## Load-balancing demonstration

- Open `/api/health` to check service and database health.
- Open `/api/instance` to see the container/revision diagnostic identifier.
- Use a concurrency/load-testing tool to send parallel requests to `/api/instance`.
- In Cloud Run metrics/logs, inspect instance scaling and request handling.
- If permitted, temporarily use a low maximum concurrency and increase concurrent traffic to encourage scaling. Do not run an uncontrolled load test.
- Explain that repeated requests may still hit the same warm instance; a single browser refresh is not proof of load balancing.
- Do not claim that an instance-failure test passed unless you actually perform and record it.

For a separately managed load balancer resource, configure a Google Cloud external Application Load Balancer with a serverless NEG backend pointing to Cloud Run. That is an additional configuration step and may incur additional costs; it is not created by the command above.

## Security checklist

- [ ] `JWT_SECRET` is long, random, and not committed
- [ ] Database credentials are stored as secrets
- [ ] PostgreSQL requires TLS in production and `PGSSL=true` verifies the certificate
- [ ] Database accepts connections only as broadly as needed
- [ ] Admin account uses a strong password
- [ ] Admin endpoints reject student accounts
- [ ] Duplicate registrations are rejected
- [ ] A cancelled or deactivated user's access stops immediately
- [ ] Cancelled tickets are refused at check-in
- [ ] SMTP credentials are stored as secrets
- [ ] Ticket tokens are unguessable and only accepted once
- [ ] HTTPS is used for the deployed service
- [ ] Rate limits and security headers are enabled
- [ ] Logs and screenshots contain no passwords, cookies, tokens or personal data
- [ ] Load test is controlled and uses only your own service

## API summary

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/health` | Public | App + DB health |
| GET | `/api/instance` | Public | Instance diagnostic |
| POST | `/api/auth/register` | Public | Create student account |
| POST | `/api/auth/login` | Public | Sign in |
| POST | `/api/auth/logout` | Signed-in cookie | Sign out |
| GET | `/api/me` | Signed in | Current profile |
| POST | `/api/me/password` | Signed in | Change password (`currentPassword`, `newPassword`) |
| GET | `/api/events` | Public | List events (adds `my_registration_id` when signed in) |
| POST | `/api/events` | Admin | Create event |
| POST | `/api/events/:id/register` | Signed in | Register for event |
| GET | `/api/my/registrations` | Signed in | My tickets (including cancelled) |
| POST | `/api/my/registrations/:id/cancel` | Signed in (owner) | Cancel a registration |
| GET | `/api/admin/registrations?eventId=1` | Admin | Registration report |
| POST | `/api/admin/checkin` | Admin | Validate ticket and mark attendance (`ticketToken`, optional `eventId`) |
| GET | `/api/admin/users?q=&limit=&offset=` | Admin | Search/list users |
| PATCH | `/api/admin/users/:id` | Admin | Change `role` and/or `isActive` |

## Camera scanner notes

- Browsers only allow camera access on **HTTPS** (Cloud Run provides this) or `http://localhost`.
- Decoding uses the bundled [jsQR](https://github.com/cozmo/jsQR) library (Apache-2.0, see `public/vendor/jsQR.LICENSE`), served from the app itself so the strict Content-Security-Policy needs no external script hosts.
- The camera is released when you stop scanning, switch tabs, or leave the page.

## Testing

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/college_events_test npm test
```

The suite starts the real server and checks: role-based access, duplicate and capacity rules, **concurrent registration without overselling**, cancellation and re-registration, check-in outcomes (success, replay, wrong event, cancelled, unknown), outbox queueing/delivery, user-management safeguards, immediate effect of deactivation/demotion, and password-change session revocation. Use a throwaway database; the tests only create uniquely named data but do write to it.

## Upgrading an existing database

Nothing manual is needed. On startup the app applies pending migrations (tracked in `schema_migrations`) under a database advisory lock, so several instances can boot at once. Databases created by the first starter version keep their data. Migration 2 replaces the `UNIQUE (user_id, event_id)` constraint with a partial unique index so cancelled registrations do not block re-registering.

## Known prototype limitations

- Changing `ADMIN_PASSWORD` after the first boot still does not modify the existing admin; use **Account → Change password** while signed in.
- If every administrator forgets their password there is no in-app recovery; fix it directly in the database (or delete the admin row and restart so the bootstrap runs again).
- Emails are plain notifications only: no reminders before the event, no waitlist, no password-reset email.
- The scanner relies on the browser's camera support; very small or glossy QR codes may need a steadier hand or manual entry.
- For a production system, add structured audit logging (the admin role-change audit line is only a console log), CSRF review, monitoring/alerts, backups, dependency scanning, and a documented data-retention policy. Sent/failed outbox rows older than 30 days are deleted automatically.
- Do not use real sensitive student data for classroom testing.
