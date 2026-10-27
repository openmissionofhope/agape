import { POLICY } from '../config.js';
import { tx } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { type Ctx, cleanText, fail, heartbeat } from './core.js';
import type { User } from './users.js';

export type SendResult = { ok: true } | { ok: false; permanent: boolean; error: string };

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface Senders {
  push: ((target: PushTarget, payload: string, opts: { ttlSeconds: number; urgent: boolean }) => Promise<SendResult>) | null;
  email: ((to: string, subject: string, text: string) => Promise<SendResult>) | null;
}

export interface NotificationInput {
  type: string;
  /** Shown in the signed-in inbox. Must not contain addresses, phone numbers or incident details. */
  text: string;
  requestId?: string | null;
  urgent?: boolean;
}

/**
 * Preview text for push and email. Deliberately generic: lock screens and mail
 * previews are visible to other people, so no details are ever included.
 */
export function previewText(type: string): string {
  if (type.startsWith('emergency')) return 'Emergency assistance has been requested near you. Open Agape to see whether you can help.';
  return 'There is new activity on Agape for you. Open Agape to see it.';
}

/** Creates in-app notifications (always) and queues push/email deliveries where available. */
export function notify(ctx: Ctx, userIds: Iterable<string>, n: NotificationInput): string[] {
  const now = ctx.clock.now();
  const ids: string[] = [];
  const urgent = !!n.urgent;
  const retries = urgent ? POLICY.notify.emergencyRetryDelaysMs : POLICY.notify.retryDelaysMs;
  const expiresAt = urgent ? now + 10 * 60_000 : now + 24 * 3600_000;
  tx(ctx.db, () => {
    for (const userId of new Set(userIds)) {
      const id = newId();
      ids.push(id);
      ctx.db.prepare('INSERT INTO notifications (id, user_id, request_id, type, text, urgent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, userId, n.requestId ?? null, n.type, n.text, urgent ? 1 : 0, now);
      const subs = ctx.db.prepare('SELECT id FROM push_subscriptions WHERE user_id = ? AND disabled_at IS NULL').pluck().all(userId) as string[];
      for (const sub of subs) {
        ctx.db.prepare(
          `INSERT INTO deliveries (id, notification_id, user_id, channel, target_id, status, max_attempts, next_attempt_at, expires_at, created_at)
           VALUES (?, ?, ?, 'webpush', ?, 'pending', ?, ?, ?, ?)`,
        ).run(newId(), id, userId, sub, retries.length + 1, now, expiresAt, now);
      }
      if (ctx.config.email) {
        const wantsEmail = ctx.db.prepare('SELECT email_notifications FROM users WHERE id = ?').pluck().get(userId) as number | undefined;
        if (wantsEmail) {
          ctx.db.prepare(
            `INSERT INTO deliveries (id, notification_id, user_id, channel, status, max_attempts, next_attempt_at, expires_at, created_at)
             VALUES (?, ?, ?, 'email', 'pending', ?, ?, ?, ?)`,
          ).run(newId(), id, userId, retries.length + 1, now, expiresAt, now);
        }
      }
    }
  });
  return ids;
}

interface DueDelivery {
  id: string;
  notification_id: string;
  user_id: string;
  channel: 'webpush' | 'email';
  target_id: string | null;
  attempts: number;
  max_attempts: number;
  expires_at: number | null;
  type: string;
  urgent: number;
}

let running = false;

/** Sends due deliveries once. Safe to call repeatedly; never runs two passes at once. */
export async function processDeliveries(ctx: Ctx, senders: Senders, limit = 50): Promise<{ sent: number; failed: number }> {
  if (running) return { sent: 0, failed: 0 };
  running = true;
  let sent = 0;
  let failed = 0;
  try {
    const due = ctx.db.prepare(
      `SELECT d.id, d.notification_id, d.user_id, d.channel, d.target_id, d.attempts, d.max_attempts, d.expires_at, n.type, n.urgent
       FROM deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY n.urgent DESC, d.next_attempt_at LIMIT ?`,
    ).all(ctx.clock.now(), limit) as DueDelivery[];
    for (const d of due) {
      const now = ctx.clock.now();
      if (d.expires_at && d.expires_at <= now) {
        ctx.db.prepare("UPDATE deliveries SET status = 'gave_up', last_error = 'expired before it could be delivered' WHERE id = ?").run(d.id);
        failed++;
        continue;
      }
      const result = await attempt(ctx, senders, d);
      const later = ctx.clock.now();
      if (result.ok) {
        ctx.db.prepare("UPDATE deliveries SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?").run(later, d.id);
        if (d.channel === 'webpush' && d.target_id) {
          ctx.db.prepare('UPDATE push_subscriptions SET last_success_at = ?, consecutive_failures = 0 WHERE id = ?').run(later, d.target_id);
        }
        sent++;
        continue;
      }
      failed++;
      const attempts = d.attempts + 1;
      const delays = d.urgent ? POLICY.notify.emergencyRetryDelaysMs : POLICY.notify.retryDelaysMs;
      if (result.permanent || attempts >= d.max_attempts) {
        ctx.db.prepare('UPDATE deliveries SET status = ?, attempts = ?, last_error = ? WHERE id = ?')
          .run(result.permanent ? 'failed' : 'gave_up', attempts, result.error.slice(0, 300), d.id);
      } else {
        ctx.db.prepare('UPDATE deliveries SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?')
          .run(attempts, result.error.slice(0, 300), later + (delays[attempts - 1] ?? delays[delays.length - 1]!), d.id);
      }
      if (d.channel === 'webpush' && d.target_id) {
        ctx.db.prepare('UPDATE push_subscriptions SET consecutive_failures = consecutive_failures + 1 WHERE id = ?').run(d.target_id);
        if (result.permanent) {
          ctx.db.prepare('UPDATE push_subscriptions SET disabled_at = ?, disabled_reason = ? WHERE id = ? AND disabled_at IS NULL')
            .run(later, `The push service rejected this device: ${result.error.slice(0, 120)}`, d.target_id);
        }
      }
    }
  } finally {
    running = false;
    heartbeat(ctx, 'deliveries', `sent=${sent} failed=${failed}`);
  }
  return { sent, failed };
}

async function attempt(ctx: Ctx, senders: Senders, d: DueDelivery): Promise<SendResult> {
  try {
    if (d.channel === 'webpush') {
      if (!senders.push) return { ok: false, permanent: true, error: 'push notifications are not configured on this server' };
      const sub = ctx.db.prepare('SELECT endpoint, p256dh, auth, disabled_at FROM push_subscriptions WHERE id = ?').get(d.target_id) as (PushTarget & { disabled_at: number | null }) | undefined;
      if (!sub || sub.disabled_at) return { ok: false, permanent: true, error: 'this device was removed' };
      const payload = JSON.stringify({ title: 'Agape', body: previewText(d.type), url: `/inbox/${d.notification_id}`, urgent: !!d.urgent });
      return await senders.push(sub, payload, { ttlSeconds: d.urgent ? 600 : 86_400, urgent: !!d.urgent });
    }
    if (!senders.email) return { ok: false, permanent: true, error: 'email is not configured on this server' };
    const to = ctx.db.prepare('SELECT email FROM users WHERE id = ?').pluck().get(d.user_id) as string | undefined;
    if (!to) return { ok: false, permanent: true, error: 'account no longer exists' };
    return await senders.email(to, 'Agape: you have a new notification',
      `${previewText(d.type)}\n\n${ctx.config.publicUrl}/inbox/${d.notification_id}\n\nYou can turn email notifications off in your Agape settings.`);
  } catch (err) {
    return { ok: false, permanent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function addPushSubscription(ctx: Ctx, user: User, input: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; label?: unknown }): void {
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint : '';
  const p256dh = typeof input.keys?.p256dh === 'string' ? input.keys.p256dh : '';
  const auth = typeof input.keys?.auth === 'string' ? input.keys.auth : '';
  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    fail('invalid', 'The browser sent an invalid push subscription.');
  }
  const now = ctx.clock.now();
  ctx.db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       label = excluded.label, disabled_at = NULL, disabled_reason = NULL, consecutive_failures = 0`,
  ).run(newId(), user.id, endpoint, p256dh, auth, cleanText(input.label, 60) ?? 'This device', now);
}

export function removePushSubscription(ctx: Ctx, user: User, id: string): void {
  ctx.db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, user.id);
}

export function listPushSubscriptions(ctx: Ctx, user: User) {
  return ctx.db.prepare('SELECT id, label, created_at, last_success_at, consecutive_failures, disabled_at, disabled_reason FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC').all(user.id) as {
    id: string; label: string | null; created_at: number; last_success_at: number | null; consecutive_failures: number; disabled_at: number | null; disabled_reason: string | null;
  }[];
}

export interface InboxItem {
  id: string;
  type: string;
  text: string;
  request_id: string | null;
  urgent: number;
  created_at: number;
  read_at: number | null;
  deliveries: { channel: string; status: string; attempts: number; last_error: string | null }[];
}

export function inbox(ctx: Ctx, user: User, limit = 50): InboxItem[] {
  const items = ctx.db.prepare('SELECT id, type, text, request_id, urgent, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(user.id, limit) as Omit<InboxItem, 'deliveries'>[];
  const q = ctx.db.prepare('SELECT channel, status, attempts, last_error FROM deliveries WHERE notification_id = ?');
  return items.map((i) => ({ ...i, deliveries: q.all(i.id) as InboxItem['deliveries'] }));
}

export function unreadCount(ctx: Ctx, userId: string): number {
  return ctx.db.prepare('SELECT count(*) FROM notifications WHERE user_id = ? AND read_at IS NULL').pluck().get(userId) as number;
}

export function openNotification(ctx: Ctx, user: User, id: string): { request_id: string | null; type: string } {
  const n = ctx.db.prepare('SELECT request_id, type FROM notifications WHERE id = ? AND user_id = ?').get(id, user.id) as { request_id: string | null; type: string } | undefined;
  if (!n) fail('not_found', 'That notification does not exist or is not yours.');
  ctx.db.prepare('UPDATE notifications SET read_at = coalesce(read_at, ?) WHERE id = ?').run(ctx.clock.now(), id);
  return n!;
}

export function markAllRead(ctx: Ctx, user: User): void {
  ctx.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(ctx.clock.now(), user.id);
}

/** Puts failed or abandoned deliveries back in the queue (for the owner, or for everyone when userId is null). */
export function retryFailedDeliveries(ctx: Ctx, userId: string | null): number {
  const now = ctx.clock.now();
  const r = ctx.db.prepare(
    `UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, expires_at = max(coalesce(expires_at, 0), ?)
     WHERE status IN ('gave_up', 'failed') AND (? IS NULL OR user_id = ?)
       AND (channel = 'email' OR target_id IN (SELECT id FROM push_subscriptions WHERE disabled_at IS NULL))
       AND notification_id IN (SELECT id FROM notifications WHERE urgent = 0)`,
  ).run(now, now + 3600_000, userId, userId);
  return r.changes;
}

export function deliveryStats(ctx: Ctx, sinceMs: number) {
  return ctx.db.prepare('SELECT channel, status, count(*) AS n FROM deliveries WHERE created_at > ? GROUP BY channel, status').all(sinceMs) as { channel: string; status: string; n: number }[];
}

/** Delivery outcome of the alerts sent for one request, for the requester's status page. */
export function alertSummary(ctx: Ctx, requestId: string, type: string) {
  const people = ctx.db.prepare('SELECT count(*) FROM notifications WHERE request_id = ? AND type = ?').pluck().get(requestId, type) as number;
  const rows = ctx.db.prepare(
    `SELECT d.status, count(*) AS n FROM deliveries d JOIN notifications n ON n.id = d.notification_id
     WHERE n.request_id = ? AND n.type = ? GROUP BY d.status`,
  ).all(requestId, type) as { status: string; n: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  return { people, sent: by.sent ?? 0, pending: by.pending ?? 0, failed: (by.failed ?? 0) + (by.gave_up ?? 0) };
}
