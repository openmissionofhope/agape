import { POLICY } from '../config.js';
import { CATEGORY_BY_KEY, TIMING_LABEL } from '../content/categories.js';
import { isUniqueViolation, tx } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { boundingBox, coarsen, distanceMeters, isValidLatLng, type LatLng } from '../lib/geo.js';
import { zipToPoint } from '../lib/zip.js';
import { type Ctx, addEvent, audit, cleanText, fail, requireQuota } from './core.js';
import { notify } from './notifications.js';
import { type User, actorOf, isBlockedEitherWay, isModerator } from './users.js';
import { getProfile } from './volunteers.js';

export interface RequestRow {
  id: string;
  kind: 'help' | 'emergency';
  jurisdiction: string;
  requester_user_id: string | null;
  category: string;
  summary: string;
  status: 'open' | 'completed' | 'cancelled' | 'expired' | 'removed' | 'closed';
  approx_lat: number | null;
  approx_lng: number | null;
  approx_source: 'device' | 'zip' | 'none' | null;
  area_label: string | null;
  exact_lat: number | null;
  exact_lng: number | null;
  exact_accuracy_m: number | null;
  exact_captured_at: number | null;
  address_text: string | null;
  private_details: string | null;
  practical: string;
  timing: string | null;
  needed_by: number | null;
  callback_phone: string | null;
  incident_type: string | null;
  incident_details: string | null;
  incident_at_requester: number | null;
  idempotency_key: string | null;
  ip_hash: string | null;
  possible_duplicate_of: string | null;
  flagged_at: number | null;
  flag_reason: string | null;
  alerted_count: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  close_reason: string | null;
  closed_by_kind: string | null;
  requester_last_seen_at: number | null;
  expires_at: number | null;
  sensitive_purged_at: number | null;
}

export interface Slot {
  id: string;
  role: string;
  position: number;
}

export interface Claim {
  id: string;
  slot_id: string;
  request_id: string;
  role: string;
  volunteer_id: string;
  status: 'active' | 'done' | 'released' | 'removed' | 'lapsed';
  created_at: number;
  done_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  volunteer_name?: string;
}

export const HOLDING = "('active', 'done')";

export function getRequest(ctx: Ctx, id: string): RequestRow | null {
  return (ctx.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined) ?? null;
}

export function getSlots(ctx: Ctx, requestId: string): Slot[] {
  return ctx.db.prepare('SELECT id, role, position FROM request_slots WHERE request_id = ? ORDER BY role, position').all(requestId) as Slot[];
}

export function getClaims(ctx: Ctx, requestId: string): Claim[] {
  return ctx.db.prepare(
    'SELECT c.*, u.display_name AS volunteer_name FROM claims c JOIN users u ON u.id = c.volunteer_id WHERE c.request_id = ? ORDER BY c.created_at',
  ).all(requestId) as Claim[];
}

export function holdingClaims(ctx: Ctx, requestId: string): Claim[] {
  return getClaims(ctx, requestId).filter((c) => c.status === 'active' || c.status === 'done');
}

export interface Relation {
  user: User | null;
  isRequester: boolean;
  claim: Claim | null;
  claims: Claim[];
  isModerator: boolean;
  /** May see exact location, private details, callback number and messages. */
  restricted: boolean;
}

export function relationTo(ctx: Ctx, req: RequestRow, user: User | null, opts: { requesterToken?: boolean } = {}): Relation {
  const isRequester = !!opts.requesterToken || (!!user && req.requester_user_id === user.id);
  const claims = user ? holdingClaims(ctx, req.id).filter((c) => c.volunteer_id === user.id) : [];
  const mod = isModerator(user);
  return { user, isRequester, claim: claims[0] ?? null, claims, isModerator: mod, restricted: isRequester || claims.length > 0 || mod };
}

/** Records that someone other than the requester saw restricted details (at most once an hour per person). */
export function logAccess(ctx: Ctx, req: RequestRow, user: User, reason: string): void {
  const now = ctx.clock.now();
  const recent = ctx.db.prepare('SELECT 1 FROM access_log WHERE request_id = ? AND user_id = ? AND reason = ? AND created_at > ?').get(req.id, user.id, reason, now - 3600_000);
  if (!recent) {
    ctx.db.prepare('INSERT INTO access_log (request_id, user_id, user_label, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(req.id, user.id, user.display_name, reason, now);
  }
}

export function accessLog(ctx: Ctx, requestId: string) {
  return ctx.db.prepare('SELECT user_label, reason, created_at FROM access_log WHERE request_id = ? ORDER BY created_at DESC LIMIT 100').all(requestId) as { user_label: string; reason: string; created_at: number }[];
}

export interface DeviceLocation {
  lat: number;
  lng: number;
  accuracy: number | null;
  capturedAt: number;
}

/** Reads a browser geolocation reading from a form. Invalid or missing readings return null. */
export function parseDeviceLocation(ctx: Ctx, input: { lat?: unknown; lng?: unknown; accuracy?: unknown; captured_at?: unknown }): DeviceLocation | null {
  if (input.lat === undefined || input.lat === '' || input.lng === undefined || input.lng === '') return null;
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!isValidLatLng(lat, lng)) return null;
  const accuracy = Number(input.accuracy);
  const now = ctx.clock.now();
  let capturedAt = Number(input.captured_at);
  if (!Number.isFinite(capturedAt) || capturedAt > now + 5 * 60_000 || capturedAt < now - 24 * 3600_000) capturedAt = now;
  return { lat, lng, accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null, capturedAt };
}

export interface HelpRequestInput {
  category?: unknown;
  summary?: unknown;
  area_label?: unknown;
  zip?: unknown;
  lat?: unknown;
  lng?: unknown;
  accuracy?: unknown;
  captured_at?: unknown;
  address_text?: unknown;
  private_details?: unknown;
  timing?: unknown;
  helpers?: unknown;
  idempotency_key?: unknown;
  [key: string]: unknown;
}

export function createHelpRequest(ctx: Ctx, user: User, input: HelpRequestInput): RequestRow {
  if (user.status !== 'active') fail('forbidden', 'Your account is suspended.');
  const idem = typeof input.idempotency_key === 'string' && input.idempotency_key ? input.idempotency_key.slice(0, 64) : null;
  if (idem) {
    const existing = ctx.db.prepare('SELECT id, requester_user_id FROM requests WHERE idempotency_key = ?').get(idem) as { id: string; requester_user_id: string | null } | undefined;
    if (existing && existing.requester_user_id === user.id) return getRequest(ctx, existing.id)!;
  }
  const category = CATEGORY_BY_KEY.get(String(input.category ?? '')) ?? fail('invalid', 'Choose what kind of help you need.');
  const summary = cleanText(input.summary, 140);
  if (!summary || summary.length < 3) fail('invalid', 'Describe what you need in a few words.');
  const device = parseDeviceLocation(ctx, input);
  const zip = cleanText(input.zip, 10);
  let approx: LatLng;
  let approxSource: 'device' | 'zip';
  let areaLabel = cleanText(input.area_label, 80);
  if (zip) {
    approx = coarsen(zipToPoint(zip) ?? fail('invalid', 'We could not find that ZIP code.'));
    approxSource = 'zip';
    areaLabel ??= `ZIP ${zip.slice(0, 5)}`;
  } else if (device) {
    approx = coarsen(device);
    approxSource = 'device';
    areaLabel ??= 'Near the requester’s location';
  } else {
    fail('invalid', 'Add a ZIP code or use your device location so nearby helpers can find your request.');
  }
  const timing = TIMING_LABEL.has(String(input.timing)) ? String(input.timing) : 'flexible';
  const helpers = Math.min(5, Math.max(1, Math.trunc(Number(input.helpers) || 1)));
  const practical: Record<string, string> = {};
  for (const f of category.fields) {
    const v = cleanText(input[`p_${f.key}`], f.max ?? 200);
    if (v === null) continue;
    if (f.type === 'number' && (!Number.isFinite(Number(v)) || Number(v) < 0 || (f.max && Number(v) > f.max))) fail('invalid', `“${f.label}” should be a number.`);
    if (f.type === 'yesno' && v !== 'yes' && v !== 'no') continue;
    practical[f.key] = v;
  }

  const open = ctx.db.prepare("SELECT count(*) FROM requests WHERE requester_user_id = ? AND kind = 'help' AND status = 'open'").pluck().get(user.id) as number;
  if (open >= POLICY.limits.openHelpRequestsPerUser) fail('rate_limited', `You already have ${open} open requests. Close or cancel one before adding another.`);
  requireQuota(ctx, `help_create:${user.id}`, POLICY.limits.helpRequestsPerUserDay, 'You have created several requests today. Please wait before adding more.');

  const id = newId();
  const now = ctx.clock.now();
  tx(ctx.db, () => {
    ctx.db.prepare(
      `INSERT INTO requests (id, kind, requester_user_id, category, summary, status, approx_lat, approx_lng, approx_source, area_label,
         exact_lat, exact_lng, exact_accuracy_m, exact_captured_at, address_text, private_details, practical, timing,
         idempotency_key, created_at, updated_at, expires_at, requester_last_seen_at)
       VALUES (?, 'help', ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, user.id, category.key, summary, approx.lat, approx.lng, approxSource, areaLabel,
      device?.lat ?? null, device?.lng ?? null, device?.accuracy ?? null, device?.capturedAt ?? null,
      cleanText(input.address_text, 300), cleanText(input.private_details, 2000), JSON.stringify(practical), timing,
      idem, now, now, now + POLICY.helpRequestDefaultTtlMs, now);
    const role = category.roles[0]!.key;
    for (let i = 1; i <= helpers; i++) {
      ctx.db.prepare('INSERT INTO request_slots (id, request_id, role, position) VALUES (?, ?, ?, ?)').run(newId(), id, role, i);
    }
    addEvent(ctx, { requestId: id, type: 'created', actorKind: 'requester', actorUserId: user.id, actorLabel: user.display_name });
  });
  const req = getRequest(ctx, id)!;
  notifyNearbyVolunteers(ctx, req);
  return req;
}

function notifyNearbyVolunteers(ctx: Ctx, req: RequestRow): void {
  if (req.approx_lat === null || req.approx_lng === null) return;
  const point = { lat: req.approx_lat, lng: req.approx_lng };
  const rows = ctx.db.prepare(
    `SELECT p.user_id, p.area_lat, p.area_lng, p.radius_m, p.categories FROM volunteer_profiles p JOIN users u ON u.id = p.user_id
     WHERE p.available = 1 AND p.notify_new_requests = 1 AND u.status = 'active' AND p.area_lat IS NOT NULL AND u.id <> ?`,
  ).all(req.requester_user_id ?? '') as { user_id: string; area_lat: number; area_lng: number; radius_m: number; categories: string }[];
  const matches = rows
    .map((r) => ({ ...r, d: distanceMeters(point, { lat: r.area_lat, lng: r.area_lng }) }))
    .filter((r) => r.d <= r.radius_m)
    .filter((r) => {
      const cats = JSON.parse(r.categories) as string[];
      return cats.length === 0 || cats.includes(req.category);
    })
    .filter((r) => !req.requester_user_id || !isBlockedEitherWay(ctx, r.user_id, req.requester_user_id))
    .sort((a, b) => a.d - b.d)
    .slice(0, POLICY.notify.maxVolunteersPerHelpRequest);
  if (matches.length === 0) return;
  const label = CATEGORY_BY_KEY.get(req.category)?.label ?? 'Help';
  notify(ctx, matches.map((m) => m.user_id), { type: 'help_new', text: `New request near you: ${label}.`, requestId: req.id });
}

export interface DiscoveryItem {
  id: string;
  kind: 'help' | 'emergency';
  category: string;
  summary: string;
  areaLabel: string | null;
  distance: number | null;
  timing: string | null;
  incidentType: string | null;
  openRoles: Record<string, number>;
  heldRoles: Record<string, number>;
  createdAt: number;
  possibleDuplicate: boolean;
  remoteOnly: boolean;
}

export interface DiscoveryQuery {
  center: LatLng;
  radiusM: number;
  category?: string | null;
}

/**
 * Nearby open requests with approximate information only. Requires a signed-in,
 * active account; rate-limited per account so the list cannot be scraped.
 */
export function discover(ctx: Ctx, user: User, q: DiscoveryQuery): { help: DiscoveryItem[]; emergency: DiscoveryItem[] } {
  if (user.status !== 'active') fail('forbidden', 'Your account is suspended.');
  requireQuota(ctx, `discover:${user.id}`, POLICY.limits.discoveryPerUserHour, 'You have searched many times in the last hour. Please wait a little.');
  const box = boundingBox(q.center, q.radiusM);
  const rows = ctx.db.prepare(
    `SELECT r.* FROM requests r LEFT JOIN users u ON u.id = r.requester_user_id
     WHERE r.kind = 'help' AND r.status = 'open' AND r.approx_lat BETWEEN ? AND ? AND r.approx_lng BETWEEN ? AND ?
       AND (r.requester_user_id IS NULL OR (r.requester_user_id <> ? AND u.status = 'active'))
       AND (? IS NULL OR r.category = ?)
     ORDER BY r.created_at DESC LIMIT 500`,
  ).all(box.minLat, box.maxLat, box.minLng, box.maxLng, user.id, q.category ?? null, q.category ?? null) as RequestRow[];
  const help = rows
    .filter((r) => !r.requester_user_id || !isBlockedEitherWay(ctx, user.id, r.requester_user_id))
    .map((r) => toItem(ctx, r, q.center))
    .filter((i) => i.distance !== null && i.distance <= q.radiusM && Object.values(i.openRoles).some((n) => n > 0))
    .sort((a, b) => a.distance! - b.distance! || b.createdAt - a.createdAt)
    .slice(0, 100);
  return { help, emergency: discoverEmergencies(ctx, user, q) };
}

function discoverEmergencies(ctx: Ctx, user: User, q: DiscoveryQuery): DiscoveryItem[] {
  const profile = getProfile(ctx, user.id);
  if (!profile?.emergency_opt_in) return [];
  const rows = ctx.db.prepare("SELECT * FROM requests WHERE kind = 'emergency' AND status = 'open' AND requester_user_id IS NOT ? ORDER BY created_at DESC LIMIT 200").all(user.id) as RequestRow[];
  const items: DiscoveryItem[] = [];
  for (const r of rows) {
    const item = toItem(ctx, r, q.center);
    const near = item.distance !== null && item.distance <= q.radiusM;
    // On-scene roles only for nearby volunteers; the call task can be done from anywhere by those who offered.
    const requested = new Set([...Object.keys(item.openRoles), ...Object.keys(item.heldRoles)]);
    const visibleRoles = profile.emergency_roles.filter((role) => requested.has(role) && (role === 'call_911' ? near || profile.remote_call_ok === 1 : near));
    if (visibleRoles.length === 0) continue;
    for (const role of Object.keys(item.openRoles)) if (!visibleRoles.includes(role as never)) delete item.openRoles[role];
    item.remoteOnly = !near;
    items.push(item);
  }
  return items;
}

function toItem(ctx: Ctx, r: RequestRow, center: LatLng): DiscoveryItem {
  const slots = getSlots(ctx, r.id);
  const held = new Set((ctx.db.prepare(`SELECT slot_id FROM claims WHERE request_id = ? AND status IN ${HOLDING}`).pluck().all(r.id) as string[]));
  const openRoles: Record<string, number> = {};
  const heldRoles: Record<string, number> = {};
  for (const s of slots) {
    if (held.has(s.id)) heldRoles[s.role] = (heldRoles[s.role] ?? 0) + 1;
    else openRoles[s.role] = (openRoles[s.role] ?? 0) + 1;
  }
  const distance = r.approx_lat !== null && r.approx_lng !== null ? distanceMeters(center, { lat: r.approx_lat, lng: r.approx_lng }) : null;
  return {
    id: r.id, kind: r.kind, category: r.category, summary: r.summary, areaLabel: r.area_label, distance, timing: r.timing,
    incidentType: r.incident_type, openRoles, heldRoles, createdAt: r.created_at, possibleDuplicate: !!r.possible_duplicate_of, remoteOnly: false,
  };
}

export function openSlotCount(ctx: Ctx, requestId: string, role?: string): number {
  return ctx.db.prepare(
    `SELECT count(*) FROM request_slots s WHERE s.request_id = ? AND (? IS NULL OR s.role = ?)
     AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.slot_id = s.id AND c.status IN ${HOLDING})`,
  ).pluck().get(requestId, role ?? null, role ?? null) as number;
}

/**
 * Atomically takes an open slot. The partial unique index on claims makes a
 * double claim impossible even if two processes race; the loser gets a conflict
 * and nothing changes.
 */
export function insertClaim(ctx: Ctx, requestId: string, role: string, volunteerId: string): Claim {
  const slot = ctx.db.prepare(
    `SELECT s.id FROM request_slots s WHERE s.request_id = ? AND s.role = ?
     AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.slot_id = s.id AND c.status IN ${HOLDING})
     ORDER BY s.position LIMIT 1`,
  ).pluck().get(requestId, role) as string | undefined;
  if (!slot) fail('conflict', 'Someone else has already taken this. Nothing was changed.');
  const id = newId();
  try {
    ctx.db.prepare("INSERT INTO claims (id, slot_id, request_id, role, volunteer_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)")
      .run(id, slot, requestId, role, volunteerId, ctx.clock.now());
  } catch (err) {
    if (isUniqueViolation(err)) {
      const mine = ctx.db.prepare(`SELECT 1 FROM claims WHERE request_id = ? AND role = ? AND volunteer_id = ? AND status IN ${HOLDING}`).get(requestId, role, volunteerId);
      fail('conflict', mine ? 'You have already taken this task.' : 'Someone else has just taken this. Nothing was changed.');
    }
    throw err;
  }
  return ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as Claim;
}

export function claimHelp(ctx: Ctx, user: User, requestId: string, roleInput?: string): Claim {
  if (user.status !== 'active') fail('forbidden', 'Your account is suspended.');
  requireQuota(ctx, `claim:${user.id}`, POLICY.limits.claimsPerUserDay, 'You have offered help many times today. Please wait before taking on more.');
  const claim = tx(ctx.db, () => {
    const req = getRequest(ctx, requestId);
    if (!req || req.kind !== 'help') fail('not_found', 'That request does not exist.');
    if (req!.status !== 'open') fail('conflict', 'This request is no longer open.');
    if (req!.requester_user_id === user.id) fail('invalid', 'You cannot take your own request.');
    if (req!.requester_user_id && isBlockedEitherWay(ctx, user.id, req!.requester_user_id)) fail('forbidden', 'You cannot help with this request.');
    const role = roleInput ?? getSlots(ctx, requestId)[0]?.role ?? 'helper';
    const c = insertClaim(ctx, requestId, role, user.id);
    addEvent(ctx, { requestId, type: 'claimed', role, claimId: c.id, actorKind: 'volunteer', actorUserId: user.id, actorLabel: user.display_name });
    return c;
  });
  const req = getRequest(ctx, requestId)!;
  if (req.requester_user_id) {
    notify(ctx, [req.requester_user_id], { type: 'help_claimed', text: `${user.display_name} offered to help with your request “${req.summary}”.`, requestId });
  }
  return claim;
}

function getClaim(ctx: Ctx, claimId: string): Claim {
  return (ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId) as Claim | undefined) ?? fail('not_found', 'That task does not exist.');
}

/** The volunteer steps back. The slot reopens for someone else. */
export function releaseClaim(ctx: Ctx, user: User, claimId: string, reasonInput?: unknown): void {
  const reason = cleanText(reasonInput, 300);
  const c = getClaim(ctx, claimId);
  if (c.volunteer_id !== user.id) fail('forbidden', 'This is not your task.');
  const req = getRequest(ctx, c.request_id)!;
  tx(ctx.db, () => {
    const r = ctx.db.prepare(`UPDATE claims SET status = 'released', ended_at = ?, end_reason = ? WHERE id = ? AND status IN ${HOLDING}`).run(ctx.clock.now(), reason ?? 'volunteer stepped back', c.id);
    if (r.changes === 0) fail('conflict', 'This task is no longer yours.');
    addEvent(ctx, { requestId: c.request_id, type: 'released', role: c.role, claimId: c.id, actorKind: 'volunteer', actorUserId: user.id, actorLabel: user.display_name, body: reason });
  });
  if (req.requester_user_id) {
    notify(ctx, [req.requester_user_id], {
      type: req.kind === 'emergency' ? 'emergency_released' : 'help_released',
      text: `${user.display_name} can no longer help with “${req.summary}”. The request is open for someone else.`, requestId: req.id,
    });
  }
}

/** The requester asks a helper to step aside (for example, if they feel unsafe). */
export function removeHelper(ctx: Ctx, user: User, claimId: string): void {
  const c = getClaim(ctx, claimId);
  const req = getRequest(ctx, c.request_id)!;
  if (req.requester_user_id !== user.id) fail('forbidden', 'Only the requester can do this.');
  tx(ctx.db, () => {
    const r = ctx.db.prepare(`UPDATE claims SET status = 'removed', ended_at = ?, end_reason = 'removed by requester' WHERE id = ? AND status IN ${HOLDING}`).run(ctx.clock.now(), c.id);
    if (r.changes === 0) fail('conflict', 'That helper is no longer assigned.');
    addEvent(ctx, { requestId: req.id, type: 'helper_removed', role: c.role, claimId: c.id, actorKind: 'requester', actorUserId: user.id, actorLabel: user.display_name });
  });
  notify(ctx, [c.volunteer_id], { type: 'help_removed', text: `The requester of “${req.summary}” no longer needs you for this request. Thank you for offering.`, requestId: req.id });
}

export function reportDone(ctx: Ctx, user: User, claimId: string): void {
  const c = getClaim(ctx, claimId);
  if (c.volunteer_id !== user.id) fail('forbidden', 'This is not your task.');
  const req = getRequest(ctx, c.request_id)!;
  if (req.kind !== 'help') fail('invalid', 'Use the emergency task page.');
  tx(ctx.db, () => {
    const r = ctx.db.prepare("UPDATE claims SET status = 'done', done_at = ? WHERE id = ? AND status = 'active'").run(ctx.clock.now(), c.id);
    if (r.changes === 0) fail('conflict', 'This task is not active.');
    addEvent(ctx, { requestId: req.id, type: 'helper_done', role: c.role, claimId: c.id, actorKind: 'volunteer', actorUserId: user.id, actorLabel: user.display_name });
  });
  if (req.requester_user_id) {
    notify(ctx, [req.requester_user_id], { type: 'help_done', text: `${user.display_name} says they have helped with “${req.summary}”. Please confirm when you have received help.`, requestId: req.id });
  }
}

function requireRequester(ctx: Ctx, user: User, requestId: string): RequestRow {
  const req = getRequest(ctx, requestId);
  if (!req || req.kind !== 'help') fail('not_found', 'That request does not exist.');
  if (req!.requester_user_id !== user.id) fail('forbidden', 'Only the requester can do this.');
  return req!;
}

function helperIds(ctx: Ctx, requestId: string): string[] {
  return holdingClaims(ctx, requestId).map((c) => c.volunteer_id);
}

/** The requester confirms they received help. */
export function completeRequest(ctx: Ctx, user: User, requestId: string): void {
  const req = requireRequester(ctx, user, requestId);
  const helpers = helperIds(ctx, requestId);
  tx(ctx.db, () => {
    const r = ctx.db.prepare("UPDATE requests SET status = 'completed', closed_at = ?, closed_by_kind = 'requester', updated_at = ? WHERE id = ? AND status = 'open'").run(ctx.clock.now(), ctx.clock.now(), req.id);
    if (r.changes === 0) fail('conflict', 'This request is not open.');
    ctx.db.prepare("UPDATE claims SET status = 'done', done_at = coalesce(done_at, ?) WHERE request_id = ? AND status = 'active'").run(ctx.clock.now(), req.id);
    addEvent(ctx, { requestId: req.id, type: 'completed', actorKind: 'requester', actorUserId: user.id, actorLabel: user.display_name });
  });
  if (helpers.length) notify(ctx, helpers, { type: 'help_completed', text: `The requester confirmed they received help with “${req.summary}”. Thank you.`, requestId: req.id });
}

export function cancelRequest(ctx: Ctx, user: User, requestId: string, reasonInput?: unknown): void {
  const req = requireRequester(ctx, user, requestId);
  const helpers = helperIds(ctx, requestId);
  const now = ctx.clock.now();
  tx(ctx.db, () => {
    const r = ctx.db.prepare("UPDATE requests SET status = 'cancelled', closed_at = ?, close_reason = ?, closed_by_kind = 'requester', updated_at = ? WHERE id = ? AND status = 'open'")
      .run(now, cleanText(reasonInput, 300), now, req.id);
    if (r.changes === 0) fail('conflict', 'This request is not open.');
    ctx.db.prepare(`UPDATE claims SET status = 'released', ended_at = ?, end_reason = 'request cancelled' WHERE request_id = ? AND status = 'active'`).run(now, req.id);
    addEvent(ctx, { requestId: req.id, type: 'cancelled', actorKind: 'requester', actorUserId: user.id, actorLabel: user.display_name });
  });
  if (helpers.length) notify(ctx, helpers, { type: 'help_cancelled', text: `The request “${req.summary}” was cancelled by the requester.`, requestId: req.id });
}

export function reopenRequest(ctx: Ctx, user: User, requestId: string): void {
  const req = requireRequester(ctx, user, requestId);
  if (req.sensitive_purged_at) fail('conflict', 'This request is too old to reopen. Please create a new one.');
  const now = ctx.clock.now();
  tx(ctx.db, () => {
    const r = ctx.db.prepare(
      "UPDATE requests SET status = 'open', closed_at = NULL, close_reason = NULL, closed_by_kind = NULL, expires_at = ?, updated_at = ? WHERE id = ? AND status IN ('cancelled', 'expired', 'completed')",
    ).run(now + POLICY.helpRequestDefaultTtlMs, now, req.id);
    if (r.changes === 0) fail('conflict', 'Only cancelled, expired or completed requests can be reopened.');
    ctx.db.prepare("UPDATE claims SET status = 'released', ended_at = ?, end_reason = 'request reopened' WHERE request_id = ? AND status IN ('active', 'done')").run(now, req.id);
    addEvent(ctx, { requestId: req.id, type: 'reopened', actorKind: 'requester', actorUserId: user.id, actorLabel: user.display_name });
  });
}

export interface Message {
  id: string;
  sender_user_id: string | null;
  sender_kind: string;
  sender_label: string;
  body: string;
  hidden_at: number | null;
  created_at: number;
}

export function listMessages(ctx: Ctx, requestId: string): Message[] {
  return ctx.db.prepare('SELECT id, sender_user_id, sender_kind, sender_label, body, hidden_at, created_at FROM messages WHERE request_id = ? ORDER BY created_at').all(requestId) as Message[];
}

/** Private coordination between the requester and the people currently helping. */
export function postMessage(ctx: Ctx, rel: Relation, req: RequestRow, bodyInput: unknown): void {
  const body = cleanText(bodyInput, 2000) ?? fail('invalid', 'Write a message first.');
  if (!rel.isRequester && !rel.claim && !rel.isModerator) fail('forbidden', 'Only the requester and current helpers can message here.');
  if (req.status !== 'open') fail('conflict', 'This request is closed, so messages are off.');
  const user = rel.user;
  if (user) requireQuota(ctx, `message:${user.id}`, POLICY.limits.messagesPerUserHour, 'You have sent many messages in the last hour. Please wait a little.');
  const kind = rel.isRequester ? 'requester' : rel.claim ? 'volunteer' : 'moderator';
  const label = kind === 'requester' ? (user?.display_name ?? 'Requester') : kind === 'moderator' ? 'Agape moderator' : user!.display_name;
  ctx.db.prepare('INSERT INTO messages (id, request_id, sender_user_id, sender_kind, sender_label, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(newId(), req.id, user?.id ?? null, kind, label, body, ctx.clock.now());
  const recipients = new Set(holdingClaims(ctx, req.id).map((c) => c.volunteer_id));
  if (req.requester_user_id) recipients.add(req.requester_user_id);
  if (user) recipients.delete(user.id);
  if (recipients.size) {
    notify(ctx, recipients, { type: req.kind === 'emergency' ? 'emergency_message' : 'help_message', text: `New message about “${req.summary}”.`, requestId: req.id, urgent: req.kind === 'emergency' });
  }
}

export function myRequests(ctx: Ctx, user: User): RequestRow[] {
  return ctx.db.prepare("SELECT * FROM requests WHERE requester_user_id = ? AND status <> 'removed' ORDER BY (status = 'open') DESC, created_at DESC LIMIT 100").all(user.id) as RequestRow[];
}

export function myTasks(ctx: Ctx, user: User): (Claim & { summary: string; kind: string; request_status: string })[] {
  return ctx.db.prepare(
    `SELECT c.*, r.summary, r.kind, r.status AS request_status FROM claims c JOIN requests r ON r.id = c.request_id
     WHERE c.volunteer_id = ? ORDER BY (c.status IN ('active', 'done') AND r.status = 'open') DESC, c.created_at DESC LIMIT 100`,
  ).all(user.id) as (Claim & { summary: string; kind: string; request_status: string })[];
}

export function events(ctx: Ctx, requestId: string) {
  return ctx.db.prepare('SELECT id, type, role, claim_id, actor_kind, actor_user_id, actor_label, body, created_at FROM request_events WHERE request_id = ? ORDER BY id').all(requestId) as {
    id: number; type: string; role: string | null; claim_id: string | null; actor_kind: string; actor_user_id: string | null; actor_label: string | null; body: string | null; created_at: number;
  }[];
}

/** Moderator removal (fraud, abuse). Helpers are released and told. */
export function removeRequest(ctx: Ctx, moderator: User, requestId: string, reasonInput: unknown): void {
  const reason = cleanText(reasonInput, 300) ?? fail('invalid', 'Give a reason.');
  const req = getRequest(ctx, requestId) ?? fail('not_found', 'No such request.');
  const helpers = helperIds(ctx, requestId);
  const now = ctx.clock.now();
  tx(ctx.db, () => {
    ctx.db.prepare("UPDATE requests SET status = 'removed', closed_at = ?, close_reason = ?, closed_by_kind = 'moderator', updated_at = ? WHERE id = ?").run(now, reason, now, req.id);
    ctx.db.prepare(`UPDATE claims SET status = 'removed', ended_at = ?, end_reason = 'request removed by a moderator' WHERE request_id = ? AND status IN ${HOLDING}`).run(now, req.id);
    addEvent(ctx, { requestId: req.id, type: 'removed', actorKind: 'moderator', actorUserId: moderator.id, actorLabel: 'A moderator', body: reason });
    audit(ctx, actorOf(moderator), 'request.remove', { kind: 'request', id: req.id }, { reason, kind: req.kind });
  });
  if (helpers.length) notify(ctx, helpers, { type: 'help_removed', text: `A request you were helping with (“${req.summary}”) was removed by a moderator. You do not need to continue.`, requestId: req.id });
}

export function hideMessage(ctx: Ctx, moderator: User, messageId: string): void {
  const m = ctx.db.prepare('SELECT id, request_id FROM messages WHERE id = ?').get(messageId) as { id: string; request_id: string } | undefined;
  if (!m) fail('not_found', 'No such message.');
  ctx.db.prepare('UPDATE messages SET hidden_at = ?, hidden_by = ? WHERE id = ?').run(ctx.clock.now(), moderator.id, messageId);
  audit(ctx, actorOf(moderator), 'message.hide', { kind: 'message', id: messageId }, { request: m!.request_id });
}

