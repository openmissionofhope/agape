import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { hmac } from '../lib/crypto.js';

export interface Ctx {
  db: DB;
  clock: Clock;
  config: Config;
}

export type ErrorCode = 'invalid' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'unavailable';

const STATUS: Record<ErrorCode, number> = {
  invalid: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409, rate_limited: 429, unavailable: 503,
};

/** An expected failure with a message that is safe and useful to show to the person. */
export class DomainError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}

export const fail = (code: ErrorCode, message: string): never => {
  throw new DomainError(code, message);
};

export interface Actor {
  userId: string | null;
  label: string;
}

export function audit(ctx: Ctx, actor: Actor, action: string, target?: { kind: string; id: string }, detail?: Record<string, unknown>): void {
  ctx.db.prepare(
    'INSERT INTO audit_log (actor_user_id, actor_label, action, target_kind, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(actor.userId, actor.label, action, target?.kind ?? null, target?.id ?? null, detail ? JSON.stringify(detail) : null, ctx.clock.now());
}

/**
 * Persistent sliding-window limiter. Returns false (and records nothing) when the
 * key has already been used `limit.count` times within the window.
 */
export function consume(ctx: Ctx, key: string, limit: { count: number; windowMs: number }): boolean {
  const now = ctx.clock.now();
  const used = ctx.db.prepare('SELECT count(*) FROM rate_events WHERE key = ? AND created_at > ?').pluck().get(key, now - limit.windowMs) as number;
  if (used >= limit.count) return false;
  ctx.db.prepare('INSERT INTO rate_events (key, created_at) VALUES (?, ?)').run(key, now);
  return true;
}

export function requireQuota(ctx: Ctx, key: string, limit: { count: number; windowMs: number }, message: string): void {
  if (!consume(ctx, key, limit)) fail('rate_limited', message);
}

/** Keyed hash of an IP address: lets us rate-limit and spot abuse without storing the address. */
export function hashIp(ctx: Ctx, ip: string): string {
  return hmac(ctx.config.secret, 'ip', ip).slice(0, 24);
}

export function getSetting(ctx: Ctx, key: string): string | null {
  return (ctx.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
}

export function setSetting(ctx: Ctx, key: string, value: string, by: string | null): void {
  ctx.db.prepare(
    'INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
  ).run(key, value, by, ctx.clock.now());
}

export interface EventInput {
  requestId: string;
  type: string;
  role?: string | null;
  claimId?: string | null;
  actorKind: 'system' | 'requester' | 'volunteer' | 'moderator';
  actorUserId?: string | null;
  actorLabel?: string | null;
  body?: string | null;
}

export function addEvent(ctx: Ctx, e: EventInput): number {
  const r = ctx.db.prepare(
    `INSERT INTO request_events (request_id, type, role, claim_id, actor_kind, actor_user_id, actor_label, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.requestId, e.type, e.role ?? null, e.claimId ?? null, e.actorKind, e.actorUserId ?? null, e.actorLabel ?? null, e.body ?? null, ctx.clock.now());
  return Number(r.lastInsertRowid);
}

export function heartbeat(ctx: Ctx, name: string, detail?: string): void {
  ctx.db.prepare('INSERT INTO heartbeats (name, at, detail) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at, detail = excluded.detail')
    .run(name, ctx.clock.now(), detail ?? null);
}

/** Trims, collapses whitespace runs inside a line, and returns null for empty input. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n/g, '\n').replace(/[^\S\n]+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, max);
}
