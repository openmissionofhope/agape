// Schema migrations, applied in order inside a transaction. Never edit a
// migration that has shipped; add a new one. All times are Unix milliseconds (UTC).

export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  suspended_until INTEGER,
  suspension_reason TEXT,
  adult_attested_at INTEGER NOT NULL,
  email_verified_at INTEGER,
  email_notifications INTEGER NOT NULL DEFAULT 0 CHECK (email_notifications IN (0, 1)),
  recovery_code_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Volunteer locations are stored coarsely (about 1 km) and never precisely.
CREATE TABLE volunteer_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  availability_note TEXT CHECK (availability_note IS NULL OR length(availability_note) <= 200),
  area_lat REAL CHECK (area_lat IS NULL OR area_lat BETWEEN -90 AND 90),
  area_lng REAL CHECK (area_lng IS NULL OR area_lng BETWEEN -180 AND 180),
  area_label TEXT CHECK (area_label IS NULL OR length(area_label) <= 80),
  radius_m INTEGER NOT NULL DEFAULT 16093 CHECK (radius_m BETWEEN 1000 AND 161000),
  categories TEXT NOT NULL DEFAULT '[]',
  notify_new_requests INTEGER NOT NULL DEFAULT 1 CHECK (notify_new_requests IN (0, 1)),
  emergency_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (emergency_opt_in IN (0, 1)),
  emergency_roles TEXT NOT NULL DEFAULT '[]',
  remote_call_ok INTEGER NOT NULL DEFAULT 0 CHECK (remote_call_ok IN (0, 1)),
  bio TEXT CHECK (bio IS NULL OR length(bio) <= 500),
  updated_at INTEGER NOT NULL
);

-- Skills are self-reported unless verified_at is set by a moderator.
CREATE TABLE volunteer_skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 120),
  verified_at INTEGER,
  verified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  verification_note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, skill)
);

-- Ordinary help requests (kind = 'help') and emergency assistance requests (kind = 'emergency').
-- approx_* is shown in discovery; exact_*, address_text, private_details, practical,
-- callback_phone and incident_details are restricted to the requester, active helpers
-- and moderators, and are cleared by the retention job.
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('help', 'emergency')),
  jurisdiction TEXT NOT NULL DEFAULT 'US',
  requester_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 3 AND 140),
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled', 'expired', 'removed', 'closed')),
  approx_lat REAL CHECK (approx_lat IS NULL OR approx_lat BETWEEN -90 AND 90),
  approx_lng REAL CHECK (approx_lng IS NULL OR approx_lng BETWEEN -180 AND 180),
  approx_source TEXT CHECK (approx_source IN ('device', 'zip', 'none')),
  area_label TEXT CHECK (area_label IS NULL OR length(area_label) <= 80),
  exact_lat REAL CHECK (exact_lat IS NULL OR exact_lat BETWEEN -90 AND 90),
  exact_lng REAL CHECK (exact_lng IS NULL OR exact_lng BETWEEN -180 AND 180),
  exact_accuracy_m REAL,
  exact_captured_at INTEGER,
  address_text TEXT CHECK (address_text IS NULL OR length(address_text) <= 300),
  private_details TEXT CHECK (private_details IS NULL OR length(private_details) <= 2000),
  practical TEXT NOT NULL DEFAULT '{}',
  timing TEXT,
  needed_by INTEGER,
  callback_phone TEXT CHECK (callback_phone IS NULL OR length(callback_phone) <= 40),
  incident_type TEXT,
  incident_details TEXT CHECK (incident_details IS NULL OR length(incident_details) <= 1000),
  incident_at_requester INTEGER,
  idempotency_key TEXT UNIQUE,
  ip_hash TEXT,
  possible_duplicate_of TEXT REFERENCES requests(id) ON DELETE SET NULL,
  flagged_at INTEGER,
  flag_reason TEXT,
  alerted_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT,
  closed_by_kind TEXT,
  requester_last_seen_at INTEGER,
  expires_at INTEGER,
  sensitive_purged_at INTEGER,
  CHECK ((kind = 'emergency') = (category = 'emergency'))
);
CREATE INDEX requests_discovery ON requests(kind, status, approx_lat, approx_lng);
CREATE INDEX requests_requester ON requests(requester_user_id, status);
CREATE INDEX requests_ip ON requests(ip_hash, created_at);

-- Emergency capability tokens (guest access). Only a hash is stored.
CREATE TABLE request_access_tokens (
  token_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX request_access_tokens_request ON request_access_tokens(request_id);

-- One row per helper position. Emergency roles (call_911, cpr, aed) are separate slots,
-- so claiming one never affects the others.
CREATE TABLE request_slots (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE (request_id, role, position)
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES request_slots(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  volunteer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'done', 'released', 'removed', 'lapsed')),
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT
);
-- The database itself guarantees that two volunteers can never hold the same slot.
CREATE UNIQUE INDEX claims_one_holder_per_slot ON claims(slot_id) WHERE status IN ('active', 'done');
CREATE UNIQUE INDEX claims_one_role_per_volunteer ON claims(request_id, role, volunteer_id) WHERE status IN ('active', 'done');
CREATE INDEX claims_volunteer ON claims(volunteer_id, status);
CREATE INDEX claims_request ON claims(request_id, status);

-- Timeline: emergency milestones and help-request history, with attribution.
CREATE TABLE request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  role TEXT,
  claim_id TEXT REFERENCES claims(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'requester', 'volunteer', 'moderator')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT,
  body TEXT CHECK (body IS NULL OR length(body) <= 1000),
  created_at INTEGER NOT NULL
);
CREATE INDEX request_events_request ON request_events(request_id, id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('requester', 'volunteer', 'moderator')),
  sender_label TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  hidden_at INTEGER,
  hidden_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_request ON messages(request_id, created_at);

-- Who viewed restricted details, shown to the requester and to moderators.
CREATE TABLE access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_label TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX access_log_request ON access_log(request_id, created_at);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reporter_kind TEXT NOT NULL CHECK (reporter_kind IN ('user', 'requester_guest')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('request', 'user', 'message')),
  target_id TEXT NOT NULL,
  request_id TEXT REFERENCES requests(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (reason IN ('fraud', 'harassment', 'unsafe', 'malicious_emergency', 'spam', 'privacy', 'other')),
  details TEXT CHECK (details IS NULL OR length(details) <= 1000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at INTEGER NOT NULL,
  handled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  handled_at INTEGER,
  resolution TEXT
);
CREATE INDEX reports_status ON reports(status, created_at);
CREATE UNIQUE INDEX reports_one_open_per_reporter ON reports(reporter_user_id, target_kind, target_id)
  WHERE status = 'open' AND reporter_user_id IS NOT NULL;

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- Moderation and security audit trail. Append-only and never holds sensitive details.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT REFERENCES requests(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  disabled_reason TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- 'sent' means the push service or mail server accepted the message, not that a person saw it.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('webpush', 'email')),
  target_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'gave_up')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  next_attempt_at INTEGER,
  expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
CREATE INDEX deliveries_notification ON deliveries(notification_id);

CREATE TABLE rate_events (
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX rate_events_key ON rate_events(key, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE heartbeats (
  name TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  detail TEXT
);
`,
  },
];
