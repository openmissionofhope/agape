import { POLICY } from '../config.js';
import { isUniqueViolation, tx } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { type Ctx, audit, cleanText, fail, requireQuota } from './core.js';
import { getRequest } from './requests.js';
import { notify } from './notifications.js';
import { type User, actorOf, getUser, moderatorIds } from './users.js';

export const REPORT_REASONS = {
  fraud: 'Scam or fraud',
  harassment: 'Harassment or threats',
  unsafe: 'Unsafe behavior',
  malicious_emergency: 'Fake or malicious emergency',
  spam: 'Spam',
  privacy: 'Shares someone’s private information',
  other: 'Something else',
} as const;

export interface Report {
  id: string;
  reporter_user_id: string | null;
  reporter_kind: string;
  target_kind: 'request' | 'user' | 'message';
  target_id: string;
  request_id: string | null;
  reason: keyof typeof REPORT_REASONS;
  details: string | null;
  status: 'open' | 'actioned' | 'dismissed';
  created_at: number;
  handled_by: string | null;
  handled_at: number | null;
  resolution: string | null;
}

export function fileReport(ctx: Ctx, reporter: { user: User | null; guestRequestId?: string }, input: { target_kind?: unknown; target_id?: unknown; reason?: unknown; details?: unknown }): void {
  const targetKind = String(input.target_kind);
  const targetId = typeof input.target_id === 'string' ? input.target_id.slice(0, 40) : '';
  const reason = String(input.reason);
  if (!['request', 'user', 'message'].includes(targetKind) || !targetId) fail('invalid', 'Nothing to report.');
  if (!(reason in REPORT_REASONS)) fail('invalid', 'Choose a reason for the report.');
  let requestId: string | null = null;
  if (targetKind === 'request') {
    if (!getRequest(ctx, targetId)) fail('not_found', 'That request does not exist.');
    requestId = targetId;
  } else if (targetKind === 'user') {
    if (!getUser(ctx, targetId)) fail('not_found', 'That account does not exist.');
  } else {
    const m = ctx.db.prepare('SELECT request_id FROM messages WHERE id = ?').pluck().get(targetId) as string | undefined;
    if (!m) fail('not_found', 'That message does not exist.');
    requestId = m!;
  }
  if (reporter.guestRequestId && requestId !== reporter.guestRequestId && targetKind !== 'user') fail('forbidden', 'You can only report things on your own request.');
  const key = reporter.user ? `report:${reporter.user.id}` : `report_guest:${reporter.guestRequestId}`;
  requireQuota(ctx, key, POLICY.limits.reportsPerUserDay, 'You have filed many reports today. Moderators will review them.');
  try {
    ctx.db.prepare(
      `INSERT INTO reports (id, reporter_user_id, reporter_kind, target_kind, target_id, request_id, reason, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), reporter.user?.id ?? null, reporter.user ? 'user' : 'requester_guest', targetKind, targetId, requestId, reason, cleanText(input.details, 1000), ctx.clock.now());
  } catch (err) {
    if (isUniqueViolation(err)) fail('conflict', 'You have already reported this. Moderators will review it.');
    throw err;
  }
  const mods = moderatorIds(ctx).filter((id) => id !== reporter.user?.id);
  if (mods.length) {
    notify(ctx, mods, {
      type: reason === 'malicious_emergency' ? 'emergency_report' : 'report_new',
      text: `New report to review: ${REPORT_REASONS[reason as keyof typeof REPORT_REASONS]}.`, urgent: reason === 'malicious_emergency',
    });
  }
}

export function openReports(ctx: Ctx): Report[] {
  return ctx.db.prepare("SELECT * FROM reports WHERE status = 'open' ORDER BY (reason = 'malicious_emergency') DESC, created_at").all() as Report[];
}

export function reportsAbout(ctx: Ctx, userId: string): Report[] {
  return ctx.db.prepare(
    `SELECT * FROM reports WHERE (target_kind = 'user' AND target_id = ?)
       OR (target_kind = 'request' AND target_id IN (SELECT id FROM requests WHERE requester_user_id = ?))
       OR (target_kind = 'message' AND target_id IN (SELECT id FROM messages WHERE sender_user_id = ?))
     ORDER BY created_at DESC LIMIT 100`,
  ).all(userId, userId, userId) as Report[];
}

export function resolveReport(ctx: Ctx, moderator: User, reportId: string, outcome: 'actioned' | 'dismissed', resolutionInput: unknown): void {
  const resolution = cleanText(resolutionInput, 300) ?? fail('invalid', 'Write a short note about what you decided.');
  tx(ctx.db, () => {
    const r = ctx.db.prepare("UPDATE reports SET status = ?, handled_by = ?, handled_at = ?, resolution = ? WHERE id = ? AND status = 'open'").run(outcome, moderator.id, ctx.clock.now(), resolution, reportId);
    if (r.changes === 0) fail('conflict', 'That report has already been handled.');
    audit(ctx, actorOf(moderator), `report.${outcome}`, { kind: 'report', id: reportId }, { resolution });
  });
}

/** The account that a report is ultimately about, if any. */
export function reportSubjectUserId(ctx: Ctx, r: Report): string | null {
  if (r.target_kind === 'user') return r.target_id;
  if (r.target_kind === 'request') return (ctx.db.prepare('SELECT requester_user_id FROM requests WHERE id = ?').pluck().get(r.target_id) as string | null) ?? null;
  return (ctx.db.prepare('SELECT sender_user_id FROM messages WHERE id = ?').pluck().get(r.target_id) as string | null) ?? null;
}
