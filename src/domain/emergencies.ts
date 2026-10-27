import { POLICY } from '../config.js';
import { DEFAULT_JURISDICTION, EMERGENCY_ROLE_KEYS, EMERGENCY_ROLES, type EmergencyRole, INCIDENT_LABEL } from '../content/emergency.js';
import { tx } from '../db/index.js';
import { hmac, newId, newToken, sha256 } from '../lib/crypto.js';
import { coarsen, distanceMeters, type LatLng } from '../lib/geo.js';
import { zipToPoint } from '../lib/zip.js';
import { type Ctx, addEvent, audit, cleanText, consume, fail, getSetting, setSetting } from './core.js';
import { alertSummary, notify } from './notifications.js';
import { type Claim, HOLDING, type RequestRow, events, getRequest, getSlots, holdingClaims, insertClaim, listMessages, parseDeviceLocation } from './requests.js';
import { type User, actorOf } from './users.js';
import { emergencyEligibility, getProfile } from './volunteers.js';

export interface EmergencyAvailability {
  mode: 'off' | 'pilot';
  paused: string | null;
  submissionsOpen: boolean;
  pushConfigured: boolean;
  emailConfigured: boolean;
  responders: number;
  reasons: string[];
}

/** What actually works right now. Shown plainly on every emergency page. */
export function emergencyAvailability(ctx: Ctx): EmergencyAvailability {
  const paused = getSetting(ctx, 'emergency_paused');
  const mode = ctx.config.emergencyMode;
  const cutoff = ctx.clock.now() - ctx.config.responderMinAccountAgeMs;
  const responders = ctx.db.prepare(
    "SELECT count(*) FROM volunteer_profiles p JOIN users u ON u.id = p.user_id WHERE p.emergency_opt_in = 1 AND p.available = 1 AND u.status = 'active' AND u.created_at <= ?",
  ).pluck().get(cutoff) as number;
  const reasons: string[] = [];
  if (mode === 'off') reasons.push('Emergency volunteer requests are not switched on yet. The organizers have not confirmed volunteer staffing or tested alert delivery for this site.');
  if (paused) reasons.push(`Emergency volunteer requests are paused by moderators: ${paused}`);
  if (mode === 'pilot' && !ctx.config.push && !ctx.config.email) reasons.push('Volunteers are not alerted automatically. They see a request only if they happen to open Agape.');
  if (mode === 'pilot' && responders === 0) reasons.push('No emergency volunteers are registered yet, so nobody may see a request.');
  return {
    mode, paused, submissionsOpen: mode === 'pilot' && !paused, pushConfigured: !!ctx.config.push, emailConfigured: !!ctx.config.email, responders, reasons,
  };
}

export function pauseEmergencies(ctx: Ctx, moderator: User, reasonInput: unknown): void {
  const reason = cleanText(reasonInput, 200) ?? fail('invalid', 'Give a short public reason, for example “alert delivery is being repaired”.');
  setSetting(ctx, 'emergency_paused', reason, moderator.id);
  audit(ctx, actorOf(moderator), 'emergency.pause', undefined, { reason });
}

export function resumeEmergencies(ctx: Ctx, moderator: User): void {
  ctx.db.prepare("DELETE FROM settings WHERE key = 'emergency_paused'").run();
  audit(ctx, actorOf(moderator), 'emergency.resume');
}

/** The guest access token is derived from the form's one-time key, so a retried submission gets the same token back. */
function accessTokenFor(ctx: Ctx, key: string): string {
  return hmac(ctx.config.secret, 'emergency-access', key);
}

export function requestIdForToken(ctx: Ctx, token: string | undefined): string | null {
  if (!token || token.length > 100) return null;
  const row = ctx.db.prepare('SELECT request_id FROM request_access_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token)) as { request_id: string } | undefined;
  if (!row) return null;
  ctx.db.prepare('UPDATE request_access_tokens SET last_used_at = ? WHERE token_hash = ?').run(ctx.clock.now(), sha256(token));
  return row.request_id;
}

export interface EmergencyInput {
  needs?: unknown;
  at_incident?: unknown;
  location_text?: unknown;
  zip?: unknown;
  lat?: unknown;
  lng?: unknown;
  accuracy?: unknown;
  captured_at?: unknown;
  incident_type?: unknown;
  details?: unknown;
  callback_phone?: unknown;
  idempotency_key?: unknown;
  website?: unknown;
}

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is string => typeof x === 'string');

export function normalizePhone(v: unknown): string | null {
  const s = cleanText(v, 40);
  if (!s) return null;
  const cleaned = s.replace(/[^0-9+()\-. ]/g, '').trim();
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) fail('invalid', 'The callback number does not look like a phone number. Fix it or leave it empty.');
  return cleaned;
}

export function createEmergency(ctx: Ctx, input: EmergencyInput, who: { user: User | null; ipHash: string }): { request: RequestRow; token: string; existing: boolean } {
  const availability = emergencyAvailability(ctx);
  if (!availability.submissionsOpen) fail('unavailable', 'Emergency volunteer requests are not available right now. Call 911.');
  if (typeof input.website === 'string' && input.website.trim() !== '') fail('invalid', 'The request could not be accepted. Call 911.');
  const key = typeof input.idempotency_key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(input.idempotency_key) ? input.idempotency_key : newToken();

  const existing = ctx.db.prepare("SELECT id, created_at, status FROM requests WHERE idempotency_key = ? AND kind = 'emergency'").get(key) as { id: string; created_at: number; status: string } | undefined;
  if (existing) {
    // A retry of the same form (for example after a lost response) gets the same request back, for a limited time.
    if (existing.status === 'removed' || ctx.clock.now() - existing.created_at > 2 * 3600_000) {
      fail('conflict', 'This form was already sent. Open your request with its private link, or reload the page to start a new request.');
    }
    return { request: getRequest(ctx, existing.id)!, token: accessTokenFor(ctx, key), existing: true };
  }

  const needs = asArray(input.needs).filter((n): n is EmergencyRole => (EMERGENCY_ROLE_KEYS as string[]).includes(n));
  if (needs.length === 0) fail('invalid', 'Choose what you need: someone to call 911, CPR help, or an AED.');
  const atIncident = input.at_incident !== 'no';
  // A device reading only describes the incident when the requester is there.
  const device = atIncident ? parseDeviceLocation(ctx, input) : null;
  const locationText = cleanText(input.location_text, 300);
  const zip = cleanText(input.zip, 10);
  const zipPoint = zip ? zipToPoint(zip) : null;
  if (zip && !zipPoint) fail('invalid', 'We could not find that ZIP code. Fix it or leave it empty.');
  if (!device && !locationText && !zipPoint) fail('invalid', 'Tell us where the emergency is: type the address or a landmark, or share your location.');
  if (!locationText && !device) fail('invalid', 'A ZIP code alone is not enough for responders. Add a street address or landmark.');
  const incidentType = INCIDENT_LABEL.has(String(input.incident_type)) ? String(input.incident_type) : 'other';
  const details = cleanText(input.details, 1000);
  const phone = normalizePhone(input.callback_phone);

  if (!consume(ctx, `emergency:${who.ipHash}`, POLICY.limits.emergencyPerConnection) ||
      !consume(ctx, `emergency_day:${who.ipHash}`, POLICY.limits.emergencyPerConnectionDay)) {
    fail('rate_limited', 'Too many emergency requests have come from this connection. If this is a real emergency, call 911 now.');
  }

  let approx: LatLng | null = null;
  let approxSource: 'device' | 'zip' | 'none' = 'none';
  let areaLabel: string | null = null;
  if (device) {
    approx = coarsen(device);
    approxSource = 'device';
    areaLabel = 'Near the location shared by the requester’s device';
  } else if (zipPoint) {
    approx = coarsen(zipPoint);
    approxSource = 'zip';
    areaLabel = `ZIP ${zip!.slice(0, 5)}`;
  }

  const now = ctx.clock.now();
  const duplicate = findPossibleDuplicate(ctx, who.ipHash, device ?? approx);
  const id = newId();
  const token = accessTokenFor(ctx, key);
  tx(ctx.db, () => {
    ctx.db.prepare(
      `INSERT INTO requests (id, kind, jurisdiction, requester_user_id, category, summary, status, approx_lat, approx_lng, approx_source, area_label,
         exact_lat, exact_lng, exact_accuracy_m, exact_captured_at, address_text, callback_phone, incident_type, incident_details,
         incident_at_requester, idempotency_key, ip_hash, possible_duplicate_of, created_at, updated_at, requester_last_seen_at)
       VALUES (?, 'emergency', ?, ?, 'emergency', ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, DEFAULT_JURISDICTION, who.user?.id ?? null, INCIDENT_LABEL.get(incidentType)!, approx?.lat ?? null, approx?.lng ?? null, approxSource, areaLabel,
      device?.lat ?? null, device?.lng ?? null, device?.accuracy ?? null, device?.capturedAt ?? null, locationText, phone, incidentType, details,
      atIncident ? 1 : 0, key, who.ipHash, duplicate, now, now, now);
    for (const role of needs) {
      for (let i = 1; i <= EMERGENCY_ROLES[role].slots; i++) {
        ctx.db.prepare('INSERT INTO request_slots (id, request_id, role, position) VALUES (?, ?, ?, ?)').run(newId(), id, role, i);
      }
    }
    ctx.db.prepare('INSERT INTO request_access_tokens (token_hash, request_id, created_at) VALUES (?, ?, ?)').run(sha256(token), id, now);
    addEvent(ctx, { requestId: id, type: 'received', actorKind: 'system', actorLabel: 'Agape' });
  });
  const alerted = alertResponders(ctx, getRequest(ctx, id)!, needs, 'emergency_new');
  ctx.db.prepare('UPDATE requests SET alerted_count = ? WHERE id = ?').run(alerted, id);
  return { request: getRequest(ctx, id)!, token, existing: false };
}

function findPossibleDuplicate(ctx: Ctx, ipHash: string, point: LatLng | null): string | null {
  const since = ctx.clock.now() - 30 * 60_000;
  const rows = ctx.db.prepare("SELECT id, ip_hash, exact_lat, exact_lng, approx_lat, approx_lng FROM requests WHERE kind = 'emergency' AND status = 'open' AND created_at > ? ORDER BY created_at DESC")
    .all(since) as { id: string; ip_hash: string; exact_lat: number | null; exact_lng: number | null; approx_lat: number | null; approx_lng: number | null }[];
  for (const r of rows) {
    if (r.ip_hash === ipHash) return r.id;
    const other = r.exact_lat !== null && r.exact_lng !== null ? { lat: r.exact_lat, lng: r.exact_lng } : null;
    if (point && other && distanceMeters(point, other) < 300) return r.id;
  }
  return null;
}

/** Alerts eligible emergency volunteers. Returns how many people were alerted. */
function alertResponders(ctx: Ctx, req: RequestRow, roles: EmergencyRole[], type: string, exclude: string[] = []): number {
  const cutoff = ctx.clock.now() - ctx.config.responderMinAccountAgeMs;
  const rows = ctx.db.prepare(
    `SELECT p.user_id, p.area_lat, p.area_lng, p.radius_m, p.emergency_roles, p.remote_call_ok FROM volunteer_profiles p JOIN users u ON u.id = p.user_id
     WHERE p.emergency_opt_in = 1 AND p.available = 1 AND u.status = 'active' AND u.created_at <= ?`,
  ).all(cutoff) as { user_id: string; area_lat: number | null; area_lng: number | null; radius_m: number; emergency_roles: string; remote_call_ok: number }[];
  const point = req.approx_lat !== null && req.approx_lng !== null ? { lat: req.approx_lat, lng: req.approx_lng } : null;
  const skip = new Set([...exclude, req.requester_user_id ?? '']);
  const near: { id: string; d: number }[] = [];
  const remote: string[] = [];
  for (const r of rows) {
    if (skip.has(r.user_id)) continue;
    const offered = JSON.parse(r.emergency_roles) as string[];
    const d = point && r.area_lat !== null && r.area_lng !== null ? distanceMeters(point, { lat: r.area_lat, lng: r.area_lng }) : Infinity;
    const isNear = d <= r.radius_m;
    const relevant = roles.some((role) => offered.includes(role) && (isNear || (role === 'call_911' && r.remote_call_ok === 1)));
    if (!relevant) continue;
    if (isNear) near.push({ id: r.user_id, d });
    else remote.push(r.user_id);
  }
  near.sort((a, b) => a.d - b.d);
  const chosen = [...near.map((n) => n.id), ...remote].slice(0, POLICY.notify.maxVolunteersPerEmergency);
  if (chosen.length === 0) return 0;
  const needs = roles.map((r) => EMERGENCY_ROLES[r].short).join(', ');
  notify(ctx, chosen, { type, text: `Emergency assistance requested (${needs}). Open it to see if you can help.`, requestId: req.id, urgent: true });
  return chosen.length;
}

// ---------------------------------------------------------------------------
// Status: milestones are kept separate and attributed. Accepting a call task is
// never shown as proof that 911 was contacted.

export type Milestone = 'ems_contacted' | 'location_relayed' | 'dispatcher_instructions' | 'dispatch_info' | 'could_not_reach' | 'call_ended' | 'en_route' | 'on_scene' | 'aed_unavailable';

export const MILESTONES: Record<Milestone, { roles: EmergencyRole[]; label: string; needsBody?: boolean; bodyLabel?: string }> = {
  ems_contacted: { roles: ['call_911'], label: 'Volunteer reports contacting 911', bodyLabel: 'Number called, if not 911 (optional)' },
  location_relayed: { roles: ['call_911'], label: 'Volunteer reports giving the incident location and details to the dispatcher' },
  dispatcher_instructions: { roles: ['call_911'], label: 'Dispatcher instructions relayed by the volunteer', needsBody: true, bodyLabel: 'What the dispatcher asked the person or bystanders to do' },
  dispatch_info: { roles: ['call_911'], label: 'Volunteer reports what the dispatcher said about a response', needsBody: true, bodyLabel: 'Exactly what the dispatcher said (for example “units have been assigned”)' },
  could_not_reach: { roles: ['call_911'], label: 'Volunteer reports they could not get through', bodyLabel: 'What happened (optional)' },
  call_ended: { roles: ['call_911'], label: 'Volunteer reports the call with the dispatcher has ended' },
  en_route: { roles: ['cpr', 'aed'], label: 'Volunteer reports they are on their way' },
  on_scene: { roles: ['cpr', 'aed'], label: 'Volunteer reports arriving at the location' },
  aed_unavailable: { roles: ['aed'], label: 'Volunteer reports they could not get an AED', bodyLabel: 'Details (optional)' },
};

export interface RoleStatus {
  role: EmergencyRole;
  slots: number;
  holders: { claim: Claim; milestones: { type: string; at: number; label: string; body: string | null; by: string | null }[]; unconfirmed: boolean; confirmed: boolean }[];
  open: number;
}

export interface EmergencyStatus {
  request: RequestRow;
  roles: RoleStatus[];
  requesterReports: { type: string; at: number; body: string | null }[];
  timeline: ReturnType<typeof events>;
  messages: ReturnType<typeof listMessages>;
  alerts: ReturnType<typeof alertSummary>;
  lastActivityAt: number;
  stale: boolean;
}

function confirmationWindow(role: string): number {
  return role === 'call_911' ? POLICY.callConfirmationMs : POLICY.onSceneConfirmationMs;
}

function confirmingTypes(role: string): string[] {
  return role === 'call_911' ? ['ems_contacted'] : ['en_route', 'on_scene'];
}

export function emergencyStatus(ctx: Ctx, req: RequestRow): EmergencyStatus {
  const now = ctx.clock.now();
  const timeline = events(ctx, req.id);
  const claims = ctx.db.prepare(`SELECT c.*, u.display_name AS volunteer_name FROM claims c JOIN users u ON u.id = c.volunteer_id WHERE c.request_id = ? AND c.status IN ${HOLDING}`).all(req.id) as Claim[];
  const slots = getSlots(ctx, req.id);
  const roles: RoleStatus[] = [];
  for (const role of EMERGENCY_ROLE_KEYS) {
    const n = slots.filter((s) => s.role === role).length;
    if (n === 0) continue;
    const holders = claims.filter((c) => c.role === role).map((claim) => {
      const ms = timeline.filter((e) => e.claim_id === claim.id && e.type in MILESTONES)
        .map((e) => ({ type: e.type, at: e.created_at, label: MILESTONES[e.type as Milestone].label, body: e.body, by: e.actor_label }));
      const confirmed = ms.some((m) => confirmingTypes(role).includes(m.type));
      const unconfirmed = claim.status === 'active' && !confirmed && now - claim.created_at >= confirmationWindow(role);
      return { claim, milestones: ms, unconfirmed, confirmed };
    });
    roles.push({ role, slots: n, holders, open: n - holders.length });
  }
  // Automatic entries (such as "unconfirmed") are not activity by a person.
  const lastActivityAt = Math.max(req.created_at, req.requester_last_seen_at ?? 0, ...timeline.filter((e) => e.actor_kind !== 'system').map((e) => e.created_at));
  return {
    request: req,
    roles,
    requesterReports: timeline.filter((e) => e.type === 'requester_ems_contacted' || e.type === 'location_corrected').map((e) => ({ type: e.type, at: e.created_at, body: e.body })),
    timeline,
    messages: listMessages(ctx, req.id),
    alerts: alertSummary(ctx, req.id, 'emergency_new'),
    lastActivityAt,
    stale: req.status === 'open' && now - lastActivityAt > POLICY.emergencyStaleMs,
  };
}

function requireOpenEmergency(ctx: Ctx, requestId: string): RequestRow {
  const req = getRequest(ctx, requestId);
  if (!req || req.kind !== 'emergency') fail('not_found', 'That emergency request does not exist.');
  if (req!.status !== 'open') fail('conflict', 'This emergency request has been closed.');
  return req!;
}

/**
 * Takes an emergency task. Roles are independent: taking the call task never
 * affects CPR or AED. If every slot for the role is held by someone who has not
 * confirmed progress in time, the unconfirmed claim lapses and this volunteer
 * takes over.
 */
export function claimEmergencyRole(ctx: Ctx, user: User, requestId: string, roleInput: string): { claim: Claim; tookOverFrom: string | null } {
  if (!(EMERGENCY_ROLE_KEYS as string[]).includes(roleInput)) fail('invalid', 'Unknown emergency task.');
  const role = roleInput as EmergencyRole;
  const eligible = emergencyEligibility(ctx, user, role);
  if (!eligible.ok) fail('forbidden', eligible.reason);
  if (!consume(ctx, `emergency_claim:${user.id}`, POLICY.limits.emergencyClaimsPerUserHour)) fail('rate_limited', 'You have taken many emergency tasks in the last hour. Please let others help.');
  let tookOverFrom: string | null = null;
  const claim = tx(ctx.db, () => {
    const req = requireOpenEmergency(ctx, requestId);
    if (req.requester_user_id === user.id) fail('invalid', 'You cannot take a task on your own request.');
    const status = emergencyStatus(ctx, req);
    const rs = status.roles.find((r) => r.role === role) ?? fail('invalid', 'This request did not ask for that kind of help.');
    if (rs.holders.some((h) => h.claim.volunteer_id === user.id)) fail('conflict', 'You have already taken this task.');
    if (rs.open === 0) {
      const stale = rs.holders.find((h) => h.unconfirmed);
      if (!stale) fail('conflict', 'Someone has already taken this task and is reporting progress. Nothing was changed.');
      const r = ctx.db.prepare("UPDATE claims SET status = 'lapsed', ended_at = ?, end_reason = 'no progress reported in time; taken over by another volunteer' WHERE id = ? AND status = 'active'")
        .run(ctx.clock.now(), stale!.claim.id);
      if (r.changes === 0) fail('conflict', 'This task changed just now. Refresh and try again.');
      addEvent(ctx, { requestId, type: 'lapsed', role, claimId: stale!.claim.id, actorKind: 'system', actorLabel: 'Agape', body: `${stale!.claim.volunteer_name} had not reported progress; another volunteer is taking over.` });
      tookOverFrom = stale!.claim.volunteer_id;
    }
    const c = insertClaim(ctx, requestId, role, user.id);
    addEvent(ctx, { requestId, type: 'role_accepted', role, claimId: c.id, actorKind: 'volunteer', actorUserId: user.id, actorLabel: user.display_name });
    return c;
  });
  if (tookOverFrom) {
    notify(ctx, [tookOverFrom], { type: 'emergency_lapsed', text: 'Another volunteer has taken over an emergency task you accepted, because no progress was reported. You do not need to continue it.', requestId, urgent: true });
  }
  const req = getRequest(ctx, requestId)!;
  if (req.requester_user_id) notify(ctx, [req.requester_user_id], { type: 'emergency_accepted', text: 'A volunteer accepted a task on your emergency request. Open it to see what has been reported.', requestId, urgent: true });
  return { claim, tookOverFrom };
}

export function recordMilestone(ctx: Ctx, user: User, claimId: string, typeInput: string, bodyInput: unknown): void {
  const type = typeInput as Milestone;
  const def = MILESTONES[type] ?? fail('invalid', 'Unknown update.');
  const claim = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId) as Claim | undefined;
  if (!claim || claim.volunteer_id !== user.id) fail('forbidden', 'This is not your task.');
  if (claim!.status !== 'active') fail('conflict', 'This task is no longer assigned to you.');
  if (!def.roles.includes(claim!.role as EmergencyRole)) fail('invalid', 'That update does not apply to this task.');
  const body = cleanText(bodyInput, 1000);
  if (def.needsBody && !body) fail('invalid', 'Write what the dispatcher said, as exactly as you can.');
  requireOpenEmergency(ctx, claim!.request_id);
  addEvent(ctx, { requestId: claim!.request_id, type, role: claim!.role, claimId: claim!.id, actorKind: 'volunteer', actorUserId: user.id, actorLabel: user.display_name, body });
  ctx.db.prepare('UPDATE requests SET updated_at = ? WHERE id = ?').run(ctx.clock.now(), claim!.request_id);
  const others = holdingClaims(ctx, claim!.request_id).map((c) => c.volunteer_id).filter((id) => id !== user.id);
  const req = getRequest(ctx, claim!.request_id)!;
  const recipients = [...others, ...(req.requester_user_id ? [req.requester_user_id] : [])];
  if (recipients.length) notify(ctx, recipients, { type: 'emergency_update', text: `Update on an emergency request: ${def.label}.`, requestId: req.id, urgent: true });
  if (type === 'aed_unavailable') {
    releaseInTx(ctx, user, claim!, 'could not get an AED');
  }
}

function releaseInTx(ctx: Ctx, user: User, claim: Claim, reason: string): void {
  tx(ctx.db, () => {
    const r = ctx.db.prepare("UPDATE claims SET status = 'released', ended_at = ?, end_reason = ? WHERE id = ? AND status = 'active'").run(ctx.clock.now(), reason, claim.id);
    if (r.changes === 0) fail('conflict', 'This task is no longer assigned to you.');
    addEvent(ctx, { requestId: claim.request_id, type: 'released', role: claim.role, claimId: claim.id, actorKind: 'volunteer', actorUserId: user.id, actorLabel: user.display_name, body: reason });
  });
  const req = getRequest(ctx, claim.request_id)!;
  alertResponders(ctx, req, [claim.role as EmergencyRole], 'emergency_reassign', [user.id]);
}

/** The volunteer cannot continue. The task reopens and other volunteers are alerted. */
export function releaseEmergencyRole(ctx: Ctx, user: User, claimId: string, reasonInput: unknown): void {
  const claim = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId) as Claim | undefined;
  if (!claim || claim.volunteer_id !== user.id) fail('forbidden', 'This is not your task.');
  releaseInTx(ctx, user, claim!, cleanText(reasonInput, 300) ?? 'volunteer could not continue');
}

/** The requester asks for someone else to take a task (for example, the volunteer stopped responding). */
export function requestReassignment(ctx: Ctx, requestId: string, roleInput: string): void {
  const req = requireOpenEmergency(ctx, requestId);
  const role = roleInput as EmergencyRole;
  const rs = emergencyStatus(ctx, req).roles.find((r) => r.role === role) ?? fail('invalid', 'This request did not ask for that kind of help.');
  const lapsedIds: string[] = [];
  tx(ctx.db, () => {
    for (const h of rs.holders) {
      if (h.claim.status !== 'active') continue;
      ctx.db.prepare("UPDATE claims SET status = 'lapsed', ended_at = ?, end_reason = 'requester asked for another volunteer' WHERE id = ? AND status = 'active'").run(ctx.clock.now(), h.claim.id);
      addEvent(ctx, { requestId, type: 'lapsed', role, claimId: h.claim.id, actorKind: 'requester', actorLabel: 'Requester', body: 'The requester asked for another volunteer.' });
      lapsedIds.push(h.claim.volunteer_id);
    }
    addEvent(ctx, { requestId, type: 'reassignment_requested', role, actorKind: 'requester', actorLabel: 'Requester' });
  });
  if (lapsedIds.length) notify(ctx, lapsedIds, { type: 'emergency_lapsed', text: 'The requester asked for another volunteer for a task you accepted. You do not need to continue it.', requestId, urgent: true });
  alertResponders(ctx, getRequest(ctx, requestId)!, [role], 'emergency_reassign', lapsedIds);
}

export function touchRequester(ctx: Ctx, requestId: string): void {
  ctx.db.prepare('UPDATE requests SET requester_last_seen_at = ? WHERE id = ?').run(ctx.clock.now(), requestId);
}

export function requesterReportsEmsContacted(ctx: Ctx, requestId: string, bodyInput: unknown): void {
  requireOpenEmergency(ctx, requestId);
  addEvent(ctx, { requestId, type: 'requester_ems_contacted', actorKind: 'requester', actorLabel: 'Requester', body: cleanText(bodyInput, 300) ?? 'The requester reports that 911 has been called.' });
  notifyHelpers(ctx, requestId, 'The requester reports that 911 has been called.');
}

export function requesterUpdate(ctx: Ctx, requestId: string, bodyInput: unknown): void {
  const req = requireOpenEmergency(ctx, requestId);
  const body = cleanText(bodyInput, 1000) ?? fail('invalid', 'Write an update first.');
  ctx.db.prepare("INSERT INTO messages (id, request_id, sender_kind, sender_label, body, created_at) VALUES (?, ?, 'requester', 'Requester', ?, ?)").run(newId(), req.id, body, ctx.clock.now());
  notifyHelpers(ctx, requestId, 'The requester posted an update on an emergency request.');
}

export function correctLocation(ctx: Ctx, requestId: string, input: { location_text?: unknown }): void {
  const req = requireOpenEmergency(ctx, requestId);
  const text = cleanText(input.location_text, 300) ?? fail('invalid', 'Type the corrected address or landmark.');
  ctx.db.prepare('UPDATE requests SET address_text = ?, updated_at = ? WHERE id = ?').run(text, ctx.clock.now(), req.id);
  addEvent(ctx, { requestId, type: 'location_corrected', actorKind: 'requester', actorLabel: 'Requester', body: 'The requester corrected the incident location. Use the new address.' });
  notifyHelpers(ctx, requestId, 'The requester corrected the location of an emergency request.');
}

function notifyHelpers(ctx: Ctx, requestId: string, text: string): void {
  const ids = holdingClaims(ctx, requestId).map((c) => c.volunteer_id);
  if (ids.length) notify(ctx, ids, { type: 'emergency_update', text, requestId, urgent: true });
}

export const CLOSE_REASONS = {
  help_arrived: 'Help has arrived',
  not_needed: 'Help is no longer needed',
  mistake: 'Sent by mistake',
} as const;

/** Only the requester or a moderator closes an emergency. Nothing closes one automatically. */
export function closeEmergency(ctx: Ctx, requestId: string, by: { kind: 'requester' } | { kind: 'moderator'; user: User }, reasonInput: unknown): void {
  const req = requireOpenEmergency(ctx, requestId);
  let reason: string;
  if (by.kind === 'requester') {
    reason = CLOSE_REASONS[String(reasonInput) as keyof typeof CLOSE_REASONS] ?? fail('invalid', 'Choose why you are closing the request.');
  } else {
    reason = cleanText(reasonInput, 300) ?? fail('invalid', 'Give a reason, for example “requester unreachable for 6 hours; outcome unknown”.');
  }
  const helpers = holdingClaims(ctx, requestId).map((c) => c.volunteer_id);
  const now = ctx.clock.now();
  tx(ctx.db, () => {
    ctx.db.prepare("UPDATE requests SET status = 'closed', closed_at = ?, close_reason = ?, closed_by_kind = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(now, reason, by.kind, now, req.id);
    ctx.db.prepare("UPDATE claims SET status = 'done', done_at = ? WHERE request_id = ? AND status = 'active'").run(now, req.id);
    addEvent(ctx, {
      requestId, type: 'closed', actorKind: by.kind, actorUserId: by.kind === 'moderator' ? by.user.id : null,
      actorLabel: by.kind === 'moderator' ? 'A moderator' : 'Requester', body: reason,
    });
    if (by.kind === 'moderator') audit(ctx, actorOf(by.user), 'emergency.close', { kind: 'request', id: req.id }, { reason });
  });
  if (helpers.length) notify(ctx, helpers, { type: 'emergency_closed', text: `An emergency request you were helping with was closed (${by.kind === 'requester' ? 'by the requester' : 'by a moderator'}): ${reason}.`, requestId, urgent: true });
}

/** Moderator action for fake or abusive emergency reports. */
export function markMalicious(ctx: Ctx, moderator: User, requestId: string, noteInput: unknown): void {
  const req = getRequest(ctx, requestId);
  if (!req || req.kind !== 'emergency') fail('not_found', 'No such emergency request.');
  const note = cleanText(noteInput, 300) ?? fail('invalid', 'Describe why this report is malicious.');
  const helpers = holdingClaims(ctx, requestId).map((c) => c.volunteer_id);
  const now = ctx.clock.now();
  tx(ctx.db, () => {
    ctx.db.prepare("UPDATE requests SET status = 'removed', flagged_at = ?, flag_reason = ?, closed_at = ?, close_reason = 'removed as malicious', closed_by_kind = 'moderator', updated_at = ? WHERE id = ?").run(now, note, now, now, requestId);
    ctx.db.prepare(`UPDATE claims SET status = 'removed', ended_at = ?, end_reason = 'request removed by a moderator' WHERE request_id = ? AND status IN ${HOLDING}`).run(now, requestId);
    ctx.db.prepare('UPDATE request_access_tokens SET revoked_at = ? WHERE request_id = ?').run(now, requestId);
    // Block further emergency submissions from the same connection for a day.
    if (req!.ip_hash) {
      for (let i = 0; i < POLICY.limits.emergencyPerConnectionDay.count; i++) ctx.db.prepare('INSERT INTO rate_events (key, created_at) VALUES (?, ?)').run(`emergency_day:${req!.ip_hash}`, now);
    }
    addEvent(ctx, { requestId, type: 'removed', actorKind: 'moderator', actorUserId: moderator.id, actorLabel: 'A moderator', body: 'Removed by a moderator.' });
    audit(ctx, actorOf(moderator), 'emergency.mark_malicious', { kind: 'request', id: requestId }, { note });
  });
  if (helpers.length) notify(ctx, helpers, { type: 'emergency_closed', text: 'An emergency request you accepted was removed by a moderator. You do not need to continue.', requestId, urgent: true });
}

/**
 * Surfaces lack of confirmation: once per unconfirmed claim, records it on the
 * timeline and alerts other volunteers so the task can be reassigned.
 */
export function checkUnconfirmed(ctx: Ctx): number {
  const open = ctx.db.prepare("SELECT * FROM requests WHERE kind = 'emergency' AND status = 'open'").all() as RequestRow[];
  let flagged = 0;
  for (const req of open) {
    const status = emergencyStatus(ctx, req);
    for (const rs of status.roles) {
      for (const h of rs.holders) {
        if (!h.unconfirmed) continue;
        if (status.timeline.some((e) => e.type === 'unconfirmed' && e.claim_id === h.claim.id)) continue;
        const minutes = Math.round(confirmationWindow(rs.role) / 60_000);
        addEvent(ctx, {
          requestId: req.id, type: 'unconfirmed', role: rs.role, claimId: h.claim.id, actorKind: 'system', actorLabel: 'Agape',
          body: rs.role === 'call_911'
            ? `No contact with 911 has been reported ${minutes} minutes after the volunteer accepted. Another volunteer can take over.`
            : `No progress has been reported ${minutes} minutes after the volunteer accepted. Another volunteer can take over.`,
        });
        alertResponders(ctx, req, [rs.role], 'emergency_reassign', [h.claim.volunteer_id]);
        flagged++;
      }
    }
  }
  return flagged;
}

export function openEmergenciesForModerators(ctx: Ctx) {
  const rows = ctx.db.prepare("SELECT * FROM requests WHERE kind = 'emergency' AND status = 'open' ORDER BY created_at").all() as RequestRow[];
  return rows.map((r) => emergencyStatus(ctx, r));
}

/** For the volunteer's call workflow: is the volunteer probably in a different 911 area? */
export function likelyRemote(ctx: Ctx, user: User, req: RequestRow): boolean | null {
  const p = getProfile(ctx, user.id);
  if (!p || p.area_lat === null || p.area_lng === null) return null;
  if (req.approx_lat === null || req.approx_lng === null) return null;
  return distanceMeters({ lat: p.area_lat, lng: p.area_lng }, { lat: req.approx_lat, lng: req.approx_lng }) > 15_000;
}

