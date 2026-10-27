# OMH Agape

**Help freely asked. Help freely given.**

Agape is an [Open Mission of Hope](https://openmissionofhope.org) service for universal,
voluntary, person-to-person assistance: someone asks for help, another person freely offers it.
Food, groceries, a ride, temporary shelter, roadside help, practical help, donated items, and
financial help arranged directly between people — with no payments, bidding, repayment or
rankings. It also supplements 911 for three bystander tasks: calling 911 for someone who can't,
CPR nearby, and bringing an AED.

Agape is offered out of Christian love and is for everyone, of any faith or none; nobody is asked
to take part in anything religious to give or receive help.

Live at **https://agape.openmissionofhope.org** (also `https://omh-agape.fly.dev`).

## Status (2026-10-27)

| Part | State |
|---|---|
| Ordinary help (request → discover → volunteer → coordinate → fulfil → confirm) | Implemented and tested |
| Volunteer profiles, service radius, self-reported / moderator-checked skills | Implemented and tested |
| Atomic claims, multiple helpers per request, release / remove / reopen / complete | Implemented and tested (database-enforced) |
| Private coordination, reporting, blocking, rate limits, suspensions, audit history | Implemented and tested |
| Notifications: in-app inbox (always), Web Push, email | In-app and Web Push live (VAPID configured); push delivery not yet checked on real devices; email not configured (no SMTP account) |
| Emergency requests (call 911 for me / CPR / AED) | Implemented and tested; **switched off by default** (`AGAPE_EMERGENCY_MODE=off`) until staffing and alert delivery are confirmed — see [docs/OPERATIONS.md §5](docs/OPERATIONS.md#5-turning-on-emergency-requests) |
| Emergency coverage | United States only, labelled as such |
| Deployment | **Live** on Fly.io (`omh-agape`, one machine in `iad`), HTTPS with a Let's Encrypt certificate; `/healthz` ok, pages and form submission verified on the live domain |
| Not yet done | First administrator account; external uptime monitor on `/healthz`; push check on phones; emergency pilot checklist |

## Run it

Requires Node.js 22.

```bash
npm ci
npm run dev                                  # http://localhost:8080 (SQLite in var/)
AGAPE_EMERGENCY_MODE=pilot npm run dev       # with emergency submissions enabled locally
npm test                                     # 78 tests; browser tests use an installed Google Chrome
npm run build && npm start                   # production build
node dist/cli.js set-role you@example.org admin
```

Configuration is by environment variable; see [.env.example](.env.example) and
[docs/OPERATIONS.md §2](docs/OPERATIONS.md#2-configuration).

## Architecture in one paragraph

One Node.js 22 process (Fastify, TypeScript) serves server-rendered HTML that works without
JavaScript, runs the notification worker and the retention job, and stores everything in one SQLite
database (WAL) on a Fly.io volume. Small scripts add geolocation with consent, explicit emergency
send states, push subscription and an optional Leaflet map. Claims are made atomic by partial unique
indexes; the audit log is append-only by trigger; restricted details are separate columns rendered
only for authorized viewers, and their views are logged. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

* [Architecture and security model](docs/ARCHITECTURE.md)
* [Emergency assistance: design, sources, limits](docs/EMERGENCY.md)
* [Privacy and retention](docs/PRIVACY.md)
* [Operations: deploy, DNS, configuration, monitoring, backups, moderation, incidents](docs/OPERATIONS.md)
* [Security reports](SECURITY.md)

## What the tests cover

Simultaneous claims (ten volunteers at once, and two database connections racing past the
application check); denied, imprecise and invalid geolocation; nearly dead battery and requester
disconnection; offline and lost-connection sends in a real browser, with safe retries; notification
failure, backoff, give-up, dead devices and retry; volunteer cancellation, disappearance, takeover
and reassignment; remote callers in another jurisdiction; independent call/CPR/AED roles on one
incident; unauthorized access to sensitive details; CSRF and headers; duplicate and abusive
submissions; moderation, suspension and malicious-emergency removal; retention. Emergency
scenarios are simulated only: no real 911 calls and no real volunteers.

## License

Copyright 2026 Open Mission of Hope. Licensed under the [Apache License 2.0](LICENSE).
Third-party notices: [NOTICE](NOTICE).
