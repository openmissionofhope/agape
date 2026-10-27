import { CATEGORY_BY_KEY, SKILL_LABEL } from '../content/categories.js';
import { EMERGENCY_ROLE_KEYS, type EmergencyRole } from '../content/emergency.js';
import { tx } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { coarsen, isValidLatLng, milesToMeters } from '../lib/geo.js';
import { zipToPoint } from '../lib/zip.js';
import { type Ctx, audit, cleanText, fail } from './core.js';
import { type User, actorOf, getUser } from './users.js';

export interface VolunteerProfile {
  user_id: string;
  available: number;
  availability_note: string | null;
  area_lat: number | null;
  area_lng: number | null;
  area_label: string | null;
  radius_m: number;
  categories: string[];
  notify_new_requests: number;
  emergency_opt_in: number;
  emergency_roles: EmergencyRole[];
  remote_call_ok: number;
  bio: string | null;
  updated_at: number;
}

export interface Skill {
  id: string;
  skill: string;
  detail: string | null;
  verified_at: number | null;
  verification_note: string | null;
}

export function getProfile(ctx: Ctx, userId: string): VolunteerProfile | null {
  const row = ctx.db.prepare('SELECT * FROM volunteer_profiles WHERE user_id = ?').get(userId) as (Omit<VolunteerProfile, 'categories' | 'emergency_roles'> & { categories: string; emergency_roles: string }) | undefined;
  if (!row) return null;
  return { ...row, categories: JSON.parse(row.categories), emergency_roles: JSON.parse(row.emergency_roles) };
}

export function listSkills(ctx: Ctx, userId: string): Skill[] {
  return ctx.db.prepare('SELECT id, skill, detail, verified_at, verification_note FROM volunteer_skills WHERE user_id = ? ORDER BY skill').all(userId) as Skill[];
}

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).filter((x): x is string => typeof x === 'string');

export interface ProfileInput {
  available?: unknown;
  availability_note?: unknown;
  zip?: unknown;
  lat?: unknown;
  lng?: unknown;
  area_label?: unknown;
  radius_miles?: unknown;
  categories?: unknown;
  notify_new_requests?: unknown;
  emergency_opt_in?: unknown;
  emergency_roles?: unknown;
  remote_call_ok?: unknown;
  bio?: unknown;
  skills?: unknown;
  [key: string]: unknown;
}

/**
 * Saves a volunteer profile. The service-area centre comes from the device (with
 * consent) or a ZIP code, and is stored only to about 1 km.
 */
export function saveProfile(ctx: Ctx, user: User, input: ProfileInput): VolunteerProfile {
  const existing = getProfile(ctx, user.id);
  let area: { lat: number; lng: number } | null = existing?.area_lat != null && existing.area_lng != null ? { lat: existing.area_lat, lng: existing.area_lng } : null;
  let areaLabel = cleanText(input.area_label, 80) ?? existing?.area_label ?? null;
  const zip = cleanText(input.zip, 10);
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (zip) {
    const p = zipToPoint(zip) ?? fail('invalid', 'We could not find that ZIP code. Check it, or use your device location.');
    area = coarsen(p);
    areaLabel = cleanText(input.area_label, 80) ?? `ZIP ${zip.slice(0, 5)}`;
  } else if (input.lat !== undefined && input.lat !== '' && isValidLatLng(lat, lng)) {
    area = coarsen({ lat, lng });
    areaLabel = cleanText(input.area_label, 80) ?? areaLabel ?? 'Near my device location';
  }
  if (!area) fail('invalid', 'Set your service area with a ZIP code or your device location, so we can show requests near you.');

  const radiusMiles = Number(input.radius_miles ?? 10);
  if (!Number.isFinite(radiusMiles) || radiusMiles < 1 || radiusMiles > 100) fail('invalid', 'Choose a service radius between 1 and 100 miles.');
  const categories = asArray(input.categories).filter((c) => CATEGORY_BY_KEY.has(c));
  const emergencyOptIn = input.emergency_opt_in === 'yes';
  const emergencyRoles = emergencyOptIn ? asArray(input.emergency_roles).filter((r): r is EmergencyRole => (EMERGENCY_ROLE_KEYS as string[]).includes(r)) : [];
  if (emergencyOptIn && emergencyRoles.length === 0) fail('invalid', 'Choose at least one emergency task you are willing to take, or turn emergency alerts off.');
  const skills = asArray(input.skills).filter((s) => SKILL_LABEL.has(s));
  const now = ctx.clock.now();

  tx(ctx.db, () => {
    ctx.db.prepare(
      `INSERT INTO volunteer_profiles (user_id, available, availability_note, area_lat, area_lng, area_label, radius_m, categories,
         notify_new_requests, emergency_opt_in, emergency_roles, remote_call_ok, bio, updated_at)
       VALUES (@user_id, @available, @availability_note, @area_lat, @area_lng, @area_label, @radius_m, @categories,
         @notify_new_requests, @emergency_opt_in, @emergency_roles, @remote_call_ok, @bio, @updated_at)
       ON CONFLICT(user_id) DO UPDATE SET available = excluded.available, availability_note = excluded.availability_note,
         area_lat = excluded.area_lat, area_lng = excluded.area_lng, area_label = excluded.area_label, radius_m = excluded.radius_m,
         categories = excluded.categories, notify_new_requests = excluded.notify_new_requests, emergency_opt_in = excluded.emergency_opt_in,
         emergency_roles = excluded.emergency_roles, remote_call_ok = excluded.remote_call_ok, bio = excluded.bio, updated_at = excluded.updated_at`,
    ).run({
      user_id: user.id,
      available: input.available === 'yes' ? 1 : 0,
      availability_note: cleanText(input.availability_note, 200),
      area_lat: area!.lat,
      area_lng: area!.lng,
      area_label: areaLabel,
      radius_m: milesToMeters(radiusMiles),
      categories: JSON.stringify(categories),
      notify_new_requests: input.notify_new_requests === 'yes' ? 1 : 0,
      emergency_opt_in: emergencyOptIn ? 1 : 0,
      emergency_roles: JSON.stringify(emergencyRoles),
      remote_call_ok: emergencyOptIn && input.remote_call_ok === 'yes' ? 1 : 0,
      bio: cleanText(input.bio, 500),
      updated_at: now,
    });
    // Keep verified skills; replace self-reported ones with the submitted set.
    const current = listSkills(ctx, user.id);
    for (const s of current) {
      if (!skills.includes(s.skill) && !s.verified_at) ctx.db.prepare('DELETE FROM volunteer_skills WHERE id = ?').run(s.id);
    }
    for (const key of skills) {
      const detail = cleanText(input[`skill_detail_${key}`], 120);
      const found = current.find((s) => s.skill === key);
      if (found) {
        if (!found.verified_at) ctx.db.prepare('UPDATE volunteer_skills SET detail = ? WHERE id = ?').run(detail, found.id);
      } else {
        ctx.db.prepare('INSERT INTO volunteer_skills (id, user_id, skill, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(newId(), user.id, key, detail, now);
      }
    }
  });
  return getProfile(ctx, user.id)!;
}

/** A moderator records that they checked evidence for a skill (for example, saw a current CPR card). */
export function verifySkill(ctx: Ctx, moderator: User, skillId: string, noteInput: unknown): void {
  const note = cleanText(noteInput, 200) ?? fail('invalid', 'Describe what you checked, for example “Saw a current Red Cross CPR card, expires 2027-03”.');
  const skill = ctx.db.prepare('SELECT id, user_id, skill FROM volunteer_skills WHERE id = ?').get(skillId) as { id: string; user_id: string; skill: string } | undefined;
  if (!skill) fail('not_found', 'No such skill.');
  ctx.db.prepare('UPDATE volunteer_skills SET verified_at = ?, verified_by = ?, verification_note = ? WHERE id = ?').run(ctx.clock.now(), moderator.id, note, skillId);
  audit(ctx, actorOf(moderator), 'skill.verify', { kind: 'user', id: skill!.user_id }, { skill: skill!.skill, note });
}

export function unverifySkill(ctx: Ctx, moderator: User, skillId: string): void {
  const skill = ctx.db.prepare('SELECT id, user_id, skill FROM volunteer_skills WHERE id = ?').get(skillId) as { id: string; user_id: string; skill: string } | undefined;
  if (!skill) fail('not_found', 'No such skill.');
  ctx.db.prepare('UPDATE volunteer_skills SET verified_at = NULL, verified_by = NULL, verification_note = NULL WHERE id = ?').run(skillId);
  audit(ctx, actorOf(moderator), 'skill.unverify', { kind: 'user', id: skill!.user_id }, { skill: skill!.skill });
}

/** Volunteers eligible for emergency tasks: opted in, active, and with an account old enough. */
export function emergencyEligibility(ctx: Ctx, user: User, role: EmergencyRole): { ok: true } | { ok: false; reason: string } {
  const profile = getProfile(ctx, user.id);
  if (user.status !== 'active') return { ok: false, reason: 'Your account is suspended.' };
  if (!profile?.emergency_opt_in) return { ok: false, reason: 'Turn on emergency tasks in your volunteer profile first.' };
  if (!profile.emergency_roles.includes(role)) return { ok: false, reason: 'You have not offered to take this kind of emergency task. You can add it in your volunteer profile.' };
  const age = ctx.clock.now() - user.created_at;
  if (age < ctx.config.responderMinAccountAgeMs) {
    const hours = Math.ceil((ctx.config.responderMinAccountAgeMs - age) / 3600_000);
    return { ok: false, reason: `New accounts can take emergency tasks after ${Math.round(ctx.config.responderMinAccountAgeMs / 3600_000)} hours (about ${hours} more). This protects people in distress from anonymous lookups.` };
  }
  return { ok: true };
}

export function displayUser(ctx: Ctx, id: string): { name: string; memberSince: number } | null {
  const u = getUser(ctx, id);
  return u ? { name: u.display_name, memberSince: u.created_at } : null;
}
