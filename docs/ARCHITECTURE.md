# Architecture

Agape is deliberately small: one Node.js process and one SQLite database.

```
 Browser (server-rendered HTML; JavaScript only enhances)
    │  HTTPS (Fly.io edge terminates TLS)
    ▼
 Node.js 22 · Fastify ─ web routes (src/web)
    │                 ─ notification worker, every 5 s (src/domain/notifications.ts)
    │                 ─ maintenance job, every 60 s (src/domain/maintenance.ts)
    ▼
 SQLite (WAL) on a Fly volume ── /data/agape.db
    │
    └─ outbound: Web Push services (VAPID), optional SMTP. Nothing else.
```

Why this shape: the load is small, the operators are volunteers, and the
riskiest failure is a confusing or half-working emergency flow. One process
with one file database has the fewest moving parts to monitor, back up and
explain. It runs on exactly one machine; to scale out, move to PostgreSQL first
(the SQL is portable and every write already runs in an explicit transaction).

## Layout

| Path | What |
|---|---|
| `src/config.ts` | Environment parsing, production safety checks, limits and retention periods (`POLICY`) |
| `src/db/` | Connection (WAL, foreign keys, busy timeout) and append-only migrations |
| `src/domain/` | All rules: users, volunteers, help requests, emergencies, notifications, reports, maintenance |
| `src/content/` | Categories, skills, emergency text with sources and review dates, jurisdictions |
| `src/web/` | Fastify app, security hooks, HTML views (escaped-by-default template tag in `src/lib/html.ts`) |
| `public/` | CSS, small progressive-enhancement scripts, push service worker |
| `data/us-zcta.csv` | US Census ZCTA internal points (public domain) for ZIP-based approximate location |
| `tests/` | Integration tests (Fastify inject, in-memory SQLite, controllable clock) and real-browser tests |

## Data model

* `users`, `sessions` (hashed tokens), `volunteer_profiles` (service area to ~1 km), `volunteer_skills` (self-reported unless `verified_at`).
* `requests` holds both ordinary help (`kind = 'help'`) and emergencies (`kind = 'emergency'`).
  Public fields (`approx_*`, `area_label`, `summary`) are separate columns from restricted ones
  (`exact_*`, `address_text`, `private_details`, `practical`, `callback_phone`, `incident_details`).
* `request_slots`: one row per helper position. Emergencies get separate slots per role
  (`call_911` ×1, `cpr` ×2, `aed` ×1), so roles are independent.
* `claims`: who holds which slot. **Partial unique indexes** make double claims impossible
  at the database level, even across processes:
  `UNIQUE(slot_id) WHERE status IN ('active','done')` and
  `UNIQUE(request_id, role, volunteer_id) WHERE status IN ('active','done')`.
  Claims run in `BEGIN IMMEDIATE` transactions; a loser gets a clear conflict and nothing changes.
* `request_events`: attributed, timestamped timeline. Emergency milestones are separate event
  types (`received`, `role_accepted`, `ems_contacted`, `location_relayed`,
  `dispatcher_instructions`, `dispatch_info`, …) — accepting is never merged with contacting 911.
* `request_access_tokens`: hashed guest capability tokens for emergency requesters.
* `messages`, `reports`, `blocks`, `access_log` (who viewed restricted details).
* `audit_log`: moderator and security actions; **append-only** (triggers reject UPDATE/DELETE).
* `notifications` (in-app, always), `deliveries` (push/email attempts with status, attempts,
  backoff, expiry), `push_subscriptions`.
* `rate_events` (persistent sliding-window limits), `settings` (moderator kill switch), `heartbeats`.

## Request lifecycle

Ordinary help: `open` → (helpers claim slots; may release, be removed, report done) →
`completed` by the requester, or `cancelled` / `expired` (after 14 days) / `removed` by a
moderator. Cancelled, expired and completed requests can be reopened until their sensitive
fields are purged.

Emergency: `open` until the requester or a moderator closes it (`closed`) or a moderator
removes it as malicious (`removed`). Nothing closes an emergency automatically. A call task
with no `ems_contacted` report 3 minutes after acceptance (10 minutes without "on my way" for
CPR/AED) is shown as unconfirmed, recorded once on the timeline, re-alerted to other
volunteers, and can be taken over; the requester can ask for another volunteer at any time.

## Security model

* Sessions: random 256-bit tokens, only SHA-256 hashes stored; HttpOnly, SameSite=Lax, Secure in production.
* CSRF: every POST must be same-origin (`Origin`/`Sec-Fetch-Site`) **and** carry an HMAC token bound
  to a per-browser cookie. The emergency form alone also accepts a same-origin POST without the cookie,
  so a browser that blocks cookies can still send it.
* Emergency guests: a capability token derived from the form's one-time key (HMAC), so a retried
  submission returns the same request and token. Stored hashed; delivered as a path-scoped cookie and
  as a private `/r/<token>` link (redirects immediately; never logged).
* Strict CSP (`script-src 'self'`, no inline script), `frame-ancestors 'none'`, `no-store` on every
  HTML page, `X-Robots-Tag: noindex` on everything except public information pages.
* Restricted details render only for the requester, current slot holders and moderators; every
  non-requester view is written to `access_log` and shown to the requester.
* Abuse: per-connection (keyed IP hash) and per-account persistent limits, honeypot field,
  duplicate detection, minimum account age for emergency responders, reports, blocks, suspensions,
  moderator kill switch for emergency submissions.
* Passwords: scrypt (N=16384, r=8, p=1). One-time recovery code (hashed) instead of email resets.

## Notifications

`notify()` always writes an in-app notification, then queues one delivery per active push
subscription (and email if configured and enabled). The worker sends due deliveries, retries
transient failures with backoff (30 s, 2 min, 10 min, 30 min; urgent: 15 s, 45 s), marks
`gave_up` after the last attempt or when an alert expires (urgent alerts after 10 minutes),
and disables push subscriptions the push service reports as gone. "Sent" means accepted by the
push service or mail server — never "seen". Payloads are generic text; details are only in Agape.

## Emergency coverage architecture

`src/content/emergency.ts` holds a `JURISDICTIONS` table. Only `status: 'verified'` entries are
used; today only `US` exists. The jurisdiction is never inferred from browser language. Adding a
country means adding a verified entry with sources and review dates, plus localized guidance.
