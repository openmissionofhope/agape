# Operations

## 1. Deployment (Fly.io)

Agape runs as the Fly app `omh-agape` in `iad`: one always-on `shared-cpu-1x` machine with 256 MB
and one 1 GB volume, `agape_data`, mounted at `/data`. This follows the convention of other
single-machine SQLite services on the same Fly account. `fly.toml`, `Dockerfile` and
`deploy/fly/entrypoint.sh` define it. **Never scale past one machine** (SQLite, in-process worker).

### First deployment

```bash
fly apps create omh-agape --org personal
fly volumes create agape_data --app omh-agape --region iad --size 1 --yes

# Secrets (write-only in Fly). Generated locally, never printed or committed.
npm ci && npm run build
{
  echo "AGAPE_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
  node dist/cli.js generate-vapid-keys
  echo "VAPID_SUBJECT=https://agape.openmissionofhope.org"
} | fly secrets import --app omh-agape --stage

fly deploy --app omh-agape --remote-only
curl -fsS https://omh-agape.fly.dev/healthz        # expect "ok":true within a minute
```

Then create the first administrator: sign up at the site, and

```bash
fly ssh console --app omh-agape -C "node dist/cli.js set-role you@example.org admin"
```

### Custom domain: agape.openmissionofhope.org

DNS for `openmissionofhope.org` is hosted by Wix (`ns0/ns1.wixdns.net`).

```bash
fly certs add agape.openmissionofhope.org --app omh-agape
```

In Wix → Domains → openmissionofhope.org → DNS records, add:

| Type | Host | Value |
|---|---|---|
| CNAME | `agape` | `omh-agape.fly.dev` |

(Fly may also ask for an `_acme-challenge.agape` CNAME; `fly certs setup
agape.openmissionofhope.org --app omh-agape` prints the exact records.) Then:

```bash
fly certs check agape.openmissionofhope.org --app omh-agape   # wait for "Issued"
curl -fsS https://agape.openmissionofhope.org/healthz
```

`AGAPE_PUBLIC_URL` in `fly.toml` is already `https://agape.openmissionofhope.org`;
`https://omh-agape.fly.dev` stays allowed through `AGAPE_EXTRA_ORIGINS`.

### Routine deploys

```bash
npm ci && npm run typecheck && npm test
fly deploy --app omh-agape --remote-only
fly status --app omh-agape && fly logs --app omh-agape
```

Migrations run automatically at start (`migrate()` in `src/server.ts`; applied ids are in
`schema_migrations`). Add migrations only as new entries in `src/db/migrations.ts`; never edit one
that has shipped. To run them by hand: `fly ssh console -C "node dist/cli.js migrate"`.

## 2. Configuration

| Variable | Where | Purpose |
|---|---|---|
| `AGAPE_SECRET` | secret, **required** | ≥32 random chars. Signs CSRF tokens, derives emergency access tokens, keys IP hashes. Rotating it invalidates open forms and emergency recovery links. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | secrets | Web Push. Without them push is reported as "not configured". Rotating the key pair silently breaks existing subscriptions; people must turn push on again. |
| `SMTP_URL`, `SMTP_FROM` | secrets, optional | Email notifications through any SMTP provider. Not configured today. |
| `AGAPE_PUBLIC_URL` | fly.toml | Canonical HTTPS origin (links in recovery URLs and emails). |
| `AGAPE_EXTRA_ORIGINS` | fly.toml | Other origins allowed to submit forms. |
| `AGAPE_TRUST_PROXY` | fly.toml | `true` on Fly: client address from `Fly-Client-IP`. |
| `AGAPE_EMERGENCY_MODE` | fly.toml | `off` (default) or `pilot`. See §5. |
| `AGAPE_EMERGENCY_RESPONDER_MIN_ACCOUNT_AGE_HOURS` | fly.toml | Minimum account age before taking emergency tasks (24). |
| `AGAPE_DATABASE_PATH`, `PORT`, `LOG_LEVEL` | fly.toml | Defaults `/data/agape.db`, `8080`, `info`. |

Production refuses to start without `AGAPE_SECRET` or with a non-HTTPS public URL.

## 3. Monitoring

* Fly's health check uses `/livez` (process alive) only.
* Point an external uptime monitor (any free HTTP monitor) at **`/healthz`**: it returns 503 when
  the database is unavailable, the notification worker or maintenance job has not run recently, or
  notifications are overdue by more than 5 minutes. A 503 needs a person, not a restart.
* `/status` (public) shows what is configured and when the workers last ran.
* `/mod/deliveries` shows delivery outcomes and failures; `/mod` shows open reports, open and
  unconfirmed emergencies, failed notifications and suspended accounts.
* Logs (`fly logs`) contain method, route, status and timing only.

## 4. Backups and restore

* Fly snapshots the volume daily and keeps snapshots 5 days: `fly volumes snapshots list agape_data --app omh-agape`.
* Manual consistent copy: `fly ssh console --app omh-agape -C "node dist/cli.js backup /data/backup.db"`,
  then `fly ssh sftp get /data/backup.db --app omh-agape`, then delete `/data/backup.db`. Keep
  manual backups no longer than 7 days (they contain data that the retention job would delete).
* Restore: stop traffic (`fly scale count 0`), copy the file to `/data/agape.db` (remove `-wal`/`-shm`),
  `fly scale count 1`, check `/healthz`.

## 5. Turning on emergency requests

Emergency requests stay **off** until every item below is true. Then set
`AGAPE_EMERGENCY_MODE = "pilot"` in `fly.toml` and deploy.

1. Push notifications are configured and a test push (Account → "Check this device") arrives on
   Android Chrome, desktop Chrome/Firefox, and an iPhone with Agape on the home screen.
2. There are enough emergency volunteers, each over the minimum account age, who understand the
   call-task workflow (report each step as it actually happens; remote-caller guidance).
3. A moderator rota exists to watch `/mod/emergencies` and reports during the pilot hours.
4. Someone has re-checked every source on `/emergency/guidance` against the live pages within the
   last 6 months, and updated `reviewedAt` in `src/content/emergency.ts`.
5. `/healthz` is monitored and alerts a person.
6. Run a **simulated** end-to-end drill with test accounts only. Never place a real 911 call or alert
   real volunteers as part of testing; tests use fake senders.

To stop immediately without a deploy: `/mod` → "Pause emergency requests" (public reason). The
direct call action is always shown.

## 6. Moderation procedures

* **Reports** (`/mod/reports`): malicious-emergency reports are listed first and alert moderators
  urgently. Resolve each with a note; remove the request, hide the message, or suspend the account.
* **Suspension** signs the account out, releases its active help (requests reopen for others) and
  shows the reason to the account holder. Durations: 24 h, 7 days, 30 days, or until lifted.
* **Malicious emergency**: "Remove as malicious" on the emergency page. Helpers are told to stop,
  the requester link is revoked, and the connection is blocked from emergency requests for a day.
* **Stale emergencies** (no activity by a person for 2 hours): try the notes thread first. Close
  only with a factual reason ("requester unreachable for 6 hours; outcome unknown"). Never record an
  outcome nobody reported.
* **Skill checks**: mark a skill as checked only after seeing evidence; describe what you saw.
* Every moderator action and every moderator view of an account is in `/mod/audit`.

## 7. Incidents

| Symptom | Action |
|---|---|
| `/healthz` reports the notification worker stalled | `fly logs`; `fly machine restart`; check `/mod/deliveries` |
| Push failures across all devices | Pause emergency requests; check VAPID secrets; retry from `/mod/deliveries` once fixed |
| Abuse wave (fake requests) | Pause emergency requests; suspend accounts; lower limits in `POLICY.limits` and deploy |
| Data exposure suspected | Pause emergency requests, rotate `AGAPE_SECRET` (signs everyone out of forms, revokes recovery links), review `/mod/audit` and `access_log` |

## 8. Scheduled reviews

* Every 6 months: emergency sources and wording (`src/content/emergency.ts`), retention periods, limits.
* Every year: ZIP data (`npm run build:zcta` with the newest Census Gazetteer file).
