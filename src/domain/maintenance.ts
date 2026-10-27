import { POLICY } from '../config.js';
import { tx } from '../db/index.js';
import { type Ctx, addEvent, heartbeat } from './core.js';
import { checkUnconfirmed } from './emergencies.js';
import { notify } from './notifications.js';

/**
 * Periodic housekeeping: expiry of ordinary requests, confirmation checks for
 * emergency tasks, and the retention rules in docs/PRIVACY.md.
 * Emergencies are never closed here.
 */
export function runMaintenance(ctx: Ctx): Record<string, number> {
  const now = ctx.clock.now();
  const r = POLICY.retention;
  const out: Record<string, number> = {};

  const expiring = ctx.db.prepare("SELECT id, summary FROM requests WHERE kind = 'help' AND status = 'open' AND expires_at <= ?").all(now) as { id: string; summary: string }[];
  for (const req of expiring) {
    const helpers = ctx.db.prepare("SELECT volunteer_id FROM claims WHERE request_id = ? AND status = 'active'").pluck().all(req.id) as string[];
    tx(ctx.db, () => {
      ctx.db.prepare("UPDATE requests SET status = 'expired', closed_at = ?, closed_by_kind = 'system', updated_at = ? WHERE id = ? AND status = 'open'").run(now, now, req.id);
      ctx.db.prepare("UPDATE claims SET status = 'released', ended_at = ?, end_reason = 'request expired' WHERE request_id = ? AND status = 'active'").run(now, req.id);
      addEvent(ctx, { requestId: req.id, type: 'expired', actorKind: 'system', actorLabel: 'Agape' });
    });
    if (helpers.length) notify(ctx, helpers, { type: 'help_expired', text: `The request “${req.summary}” expired.`, requestId: req.id });
  }
  out.expired = expiring.length;

  out.unconfirmed = checkUnconfirmed(ctx);

  // Clear precise location, address, callback number and sensitive text after closure.
  out.emergencySensitivePurged = ctx.db.prepare(
    `UPDATE requests SET exact_lat = NULL, exact_lng = NULL, exact_accuracy_m = NULL, address_text = NULL, callback_phone = NULL,
       incident_details = NULL, private_details = NULL, practical = '{}', ip_hash = NULL, sensitive_purged_at = ?
     WHERE kind = 'emergency' AND status <> 'open' AND sensitive_purged_at IS NULL AND closed_at <= ?`,
  ).run(now, now - r.emergencySensitiveAfterCloseMs).changes;
  out.helpSensitivePurged = ctx.db.prepare(
    `UPDATE requests SET exact_lat = NULL, exact_lng = NULL, exact_accuracy_m = NULL, address_text = NULL, private_details = NULL,
       practical = '{}', ip_hash = NULL, sensitive_purged_at = ?
     WHERE kind = 'help' AND status <> 'open' AND sensitive_purged_at IS NULL AND closed_at <= ?`,
  ).run(now, now - r.helpSensitiveAfterCloseMs).changes;
  // Messages and free-text timeline entries (dispatcher instructions, reasons) go with the sensitive fields.
  ctx.db.prepare('DELETE FROM messages WHERE request_id IN (SELECT id FROM requests WHERE sensitive_purged_at IS NOT NULL)').run();
  ctx.db.prepare('UPDATE request_events SET body = NULL WHERE body IS NOT NULL AND request_id IN (SELECT id FROM requests WHERE sensitive_purged_at IS NOT NULL)').run();

  out.emergencyDeleted = ctx.db.prepare("DELETE FROM requests WHERE kind = 'emergency' AND status <> 'open' AND closed_at <= ? AND id NOT IN (SELECT request_id FROM reports WHERE status = 'open' AND request_id IS NOT NULL)")
    .run(now - r.emergencyRecordAfterCloseMs).changes;
  out.helpDeleted = ctx.db.prepare("DELETE FROM requests WHERE kind = 'help' AND status <> 'open' AND closed_at <= ? AND id NOT IN (SELECT request_id FROM reports WHERE status = 'open' AND request_id IS NOT NULL)")
    .run(now - r.helpRecordAfterCloseMs).changes;

  ctx.db.prepare('UPDATE requests SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at <= ?').run(now - r.ipHashMs);
  ctx.db.prepare('DELETE FROM access_log WHERE created_at <= ?').run(now - r.accessLogMs);
  ctx.db.prepare('DELETE FROM notifications WHERE created_at <= ?').run(now - r.notificationsMs);
  ctx.db.prepare('DELETE FROM rate_events WHERE created_at <= ?').run(now - 2 * 24 * 3600_000);
  ctx.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  heartbeat(ctx, 'maintenance', JSON.stringify(out));
  return out;
}
