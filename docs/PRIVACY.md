# Privacy and data retention

The retention periods below are enforced by `runMaintenance` (`src/domain/maintenance.ts`, every
minute) and defined in `POLICY.retention` (`src/config.ts`). The public summary is at `/privacy`.

## What is stored

| Data | Where | Who can see it |
|---|---|---|
| Email, display name, scrypt password hash, hashed recovery code, adult attestation time | `users` | The person; moderators (not hashes) |
| Volunteer service area, **rounded to a 0.01° grid (~1 km)**; never precise | `volunteer_profiles` | Nobody else; used for matching |
| Skills (self-reported; moderator check with note) | `volunteer_skills` | People the volunteer helps; moderators |
| Request summary, category, approximate area (~1 km grid), timing | `requests` | Signed-in volunteers nearby (rate-limited) |
| Exact address/device location, private details, practical fields, messages | `requests`, `messages` | Requester, current helpers, moderators — each non-requester view logged in `access_log` |
| Emergency address, device location with accuracy and time, callback number, details | `requests` | Requester (token), volunteers who accepted a task on it, moderators |
| Keyed hash of the connection's IP address (never the address) | `requests.ip_hash`, `rate_events` keys | Nobody; used for rate limits, duplicates and abuse blocks |
| Notifications and delivery outcomes | `notifications`, `deliveries` | The person; moderators see aggregate failures |
| Push subscription endpoint and keys | `push_subscriptions` | Nobody else |
| Moderation actions | `audit_log` (append-only, no sensitive details) | Moderators |

Nothing sensitive goes into URLs (ids only), logs (method, route, status; no query strings, IPs,
cookies or `/r/` tokens), analytics (there are none), search engines (`noindex` plus `robots.txt`),
or notification previews (generic text only). Web Push payloads are end-to-end encrypted to the
browser and still contain no details.

## Retention

| Data | Rule |
|---|---|
| Emergency exact location, address, callback number, details, messages, free-text timeline entries, IP hash | Cleared **72 hours after the emergency is closed** |
| Emergency record (timestamps of milestones, roles) | Deleted 90 days after closure |
| Open emergencies | Never purged or closed automatically; moderators review stale ones |
| Help request exact location, address, private details, practical fields, messages, IP hash | Cleared 30 days after the request closes (completed, cancelled, expired, removed) |
| Help request record | Deleted 180 days after closure |
| Records with an open report | Not deleted until the report is handled (sensitive fields are still cleared on schedule) |
| Access log | 90 days |
| IP hashes on any request | 30 days after creation |
| Notifications (and their delivery rows) | 60 days |
| Rate-limit events | 2 days |
| Sessions | 30 days after sign-in |
| Accounts | Until the person deletes theirs (`/account`) |
| Audit log | Kept; contains no addresses or incident details |

**Backups.** Fly.io volume snapshots are taken daily and kept for 5 days, so purged data can survive
in a snapshot for up to 5 days. Manual backups (`node dist/cli.js backup`) must be deleted within
7 days, and must never be copied to personal devices.

## Location handling

* Browsers are asked for location only when the person presses a button, once, with
  `enableHighAccuracy`, and the reading (with accuracy and timestamp) is shown so it can be corrected.
* Public coordinates are snapped to the centre of a 0.01° cell, so every point in a cell publishes
  the same value. Distances are shown in coarse bands.
* ZIP-based locations use Census ZCTA internal points bundled with the app; no address is sent to a
  third-party geocoder. The optional map loads OpenStreetMap tiles, which reveals the approximate
  area being viewed to OpenStreetMap (stated on the page).
