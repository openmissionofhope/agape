import { POLICY } from '../config.js';
import { tx } from '../db/index.js';
import { hashPassword, newId, newRecoveryCode, newToken, normalizeRecoveryCode, sha256, verifyPassword } from '../lib/crypto.js';
import { type Actor, type Ctx, addEvent, audit, cleanText, fail } from './core.js';

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: 'member' | 'moderator' | 'admin';
  status: 'active' | 'suspended';
  suspended_until: number | null;
  suspension_reason: string | null;
  email_verified_at: number | null;
  email_notifications: number;
  created_at: number;
  last_seen_at: number | null;
}

const USER_COLUMNS = 'id, email, display_name, role, status, suspended_until, suspension_reason, email_verified_at, email_notifications, created_at, last_seen_at';

export const isModerator = (u: User | null | undefined): boolean => !!u && (u.role === 'moderator' || u.role === 'admin');
export const actorOf = (u: User): Actor => ({ userId: u.id, label: u.display_name });

export function getUser(ctx: Ctx, id: string): User | null {
  return (ctx.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as User | undefined) ?? null;
}

export function getUserByEmail(ctx: Ctx, email: string): User | null {
  return (ctx.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(email.trim()) as User | undefined) ?? null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePassword(pw: string): void {
  if (pw.length < 10) fail('invalid', 'Use a password of at least 10 characters.');
  if (pw.length > 200) fail('invalid', 'That password is too long.');
}

export async function signUp(ctx: Ctx, input: { email: unknown; password: unknown; displayName: unknown; adult: unknown; guidelines: unknown }) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const displayName = cleanText(input.displayName, 60);
  if (!EMAIL_RE.test(email) || email.length > 254) fail('invalid', 'Enter a valid email address.');
  if (!displayName) fail('invalid', 'Enter the name you would like helpers and requesters to see.');
  validatePassword(password);
  if (input.adult !== 'yes') fail('invalid', 'Agape accounts are for adults. Confirm that you are 18 or older.');
  if (input.guidelines !== 'yes') fail('invalid', 'Please agree to the community guidelines.');
  if (getUserByEmail(ctx, email)) fail('conflict', 'An account with that email already exists. Sign in instead.');

  const recoveryCode = newRecoveryCode();
  const [passwordHash, codeHash] = await Promise.all([hashPassword(password), hashPassword(normalizeRecoveryCode(recoveryCode))]);
  const id = newId();
  const now = ctx.clock.now();
  ctx.db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, adult_attested_at, recovery_code_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, email, passwordHash, displayName, now, codeHash, now);
  return { user: getUser(ctx, id)!, recoveryCode };
}

export async function authenticate(ctx: Ctx, emailInput: unknown, passwordInput: unknown): Promise<User> {
  const email = typeof emailInput === 'string' ? emailInput.trim() : '';
  const password = typeof passwordInput === 'string' ? passwordInput : '';
  const row = ctx.db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email) as { id: string; password_hash: string } | undefined;
  // Verify against a dummy hash when the account does not exist, so timing does not reveal it.
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) fail('unauthenticated', 'That email and password do not match an account.');
  const user = refreshSuspension(ctx, getUser(ctx, row!.id)!);
  if (user.status === 'suspended') fail('forbidden', suspensionMessage(user));
  return user;
}

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function suspensionMessage(u: User): string {
  const until = u.suspended_until ? ` until ${new Date(u.suspended_until).toUTCString()}` : '';
  return `This account is suspended${until}.${u.suspension_reason ? ` Reason: ${u.suspension_reason}` : ''} You can still call 911 and view public pages.`;
}

/** Lifts a suspension whose end time has passed. */
export function refreshSuspension(ctx: Ctx, u: User): User {
  if (u.status === 'suspended' && u.suspended_until !== null && u.suspended_until <= ctx.clock.now()) {
    ctx.db.prepare("UPDATE users SET status = 'active', suspended_until = NULL, suspension_reason = NULL WHERE id = ?").run(u.id);
    audit(ctx, { userId: null, label: 'system' }, 'user.suspension_expired', { kind: 'user', id: u.id });
    return getUser(ctx, u.id)!;
  }
  return u;
}

export function createSession(ctx: Ctx, userId: string): string {
  const token = newToken();
  const now = ctx.clock.now();
  ctx.db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now, now + POLICY.sessionTtlMs);
  return token;
}

export function sessionUser(ctx: Ctx, token: string | undefined): { user: User; sessionHash: string } | null {
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const row = ctx.db.prepare('SELECT user_id, expires_at FROM sessions WHERE id_hash = ?').get(hash) as { user_id: string; expires_at: number } | undefined;
  if (!row || row.expires_at <= ctx.clock.now()) return null;
  const user = getUser(ctx, row.user_id);
  if (!user) return null;
  const now = ctx.clock.now();
  if (!user.last_seen_at || now - user.last_seen_at > 5 * 60_000) {
    ctx.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, user.id);
  }
  return { user: refreshSuspension(ctx, user), sessionHash: hash };
}

export function deleteSession(ctx: Ctx, sessionHash: string): void {
  ctx.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sessionHash);
}

export async function resetPassword(ctx: Ctx, emailInput: unknown, codeInput: unknown, newPasswordInput: unknown): Promise<string> {
  const email = typeof emailInput === 'string' ? emailInput.trim() : '';
  const code = typeof codeInput === 'string' ? normalizeRecoveryCode(codeInput) : '';
  const password = typeof newPasswordInput === 'string' ? newPasswordInput : '';
  validatePassword(password);
  const row = ctx.db.prepare('SELECT id, recovery_code_hash FROM users WHERE email = ?').get(email) as { id: string; recovery_code_hash: string | null } | undefined;
  const ok = await verifyPassword(code, row?.recovery_code_hash ?? DUMMY_HASH);
  if (!row || !row.recovery_code_hash || !ok) fail('unauthenticated', 'That email and recovery code do not match.');
  const recoveryCode = newRecoveryCode();
  const [passwordHash, codeHash] = await Promise.all([hashPassword(password), hashPassword(normalizeRecoveryCode(recoveryCode))]);
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE users SET password_hash = ?, recovery_code_hash = ? WHERE id = ?').run(passwordHash, codeHash, row!.id);
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row!.id);
    audit(ctx, { userId: row!.id, label: 'account owner' }, 'user.password_reset_with_recovery_code', { kind: 'user', id: row!.id });
  });
  return recoveryCode;
}

export function setEmailNotifications(ctx: Ctx, user: User, enabled: boolean): void {
  ctx.db.prepare('UPDATE users SET email_notifications = ? WHERE id = ?').run(enabled ? 1 : 0, user.id);
}

/**
 * Suspends an account: signs it out everywhere, releases its active helper claims
 * (so requests reopen for others) and records everything in the audit log.
 */
export function suspendUser(ctx: Ctx, moderator: User, userId: string, durationHours: number | null, reasonInput: unknown): void {
  const target = getUser(ctx, userId) ?? fail('not_found', 'No such account.');
  if (target.id === moderator.id) fail('invalid', 'You cannot suspend your own account.');
  if (target.role === 'admin' && moderator.role !== 'admin') fail('forbidden', 'Only an administrator can suspend an administrator.');
  const reason = cleanText(reasonInput, 300) ?? fail('invalid', 'Give a reason; the account holder will see it.');
  const now = ctx.clock.now();
  const until = durationHours ? now + durationHours * 3600_000 : null;
  tx(ctx.db, () => {
    ctx.db.prepare("UPDATE users SET status = 'suspended', suspended_until = ?, suspension_reason = ? WHERE id = ?").run(until, reason, target.id);
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    const claims = ctx.db.prepare("SELECT id, request_id, role FROM claims WHERE volunteer_id = ? AND status = 'active'").all(target.id) as { id: string; request_id: string; role: string }[];
    for (const c of claims) {
      ctx.db.prepare("UPDATE claims SET status = 'removed', ended_at = ?, end_reason = 'helper account suspended' WHERE id = ?").run(now, c.id);
      addEvent(ctx, { requestId: c.request_id, type: 'helper_removed', role: c.role, claimId: c.id, actorKind: 'moderator', actorUserId: moderator.id, actorLabel: 'A moderator', body: 'The helper’s account was suspended. This task is open again.' });
    }
    audit(ctx, actorOf(moderator), 'user.suspend', { kind: 'user', id: target.id }, { durationHours, reason, releasedClaims: claims.length });
  });
}

export function unsuspendUser(ctx: Ctx, moderator: User, userId: string): void {
  const target = getUser(ctx, userId) ?? fail('not_found', 'No such account.');
  ctx.db.prepare("UPDATE users SET status = 'active', suspended_until = NULL, suspension_reason = NULL WHERE id = ?").run(target.id);
  audit(ctx, actorOf(moderator), 'user.unsuspend', { kind: 'user', id: target.id });
}

export function setRole(ctx: Ctx, admin: User | null, userId: string, role: User['role']): void {
  if (admin && admin.role !== 'admin') fail('forbidden', 'Only an administrator can change roles.');
  const target = getUser(ctx, userId) ?? fail('not_found', 'No such account.');
  if (!['member', 'moderator', 'admin'].includes(role)) fail('invalid', 'Unknown role.');
  ctx.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
  audit(ctx, admin ? actorOf(admin) : { userId: null, label: 'command line' }, 'user.set_role', { kind: 'user', id: target.id }, { role });
}

export function isBlockedEitherWay(ctx: Ctx, a: string, b: string): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').get(a, b, b, a);
}

export function block(ctx: Ctx, user: User, otherId: string): void {
  if (otherId === user.id) fail('invalid', 'You cannot block yourself.');
  if (!getUser(ctx, otherId)) fail('not_found', 'No such account.');
  const now = ctx.clock.now();
  tx(ctx.db, () => {
    ctx.db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(user.id, otherId, now);
    // A blocked helper is removed from the blocker's open requests, and vice versa.
    const claims = ctx.db.prepare(
      `SELECT c.id, c.request_id, c.role, c.volunteer_id FROM claims c JOIN requests r ON r.id = c.request_id
       WHERE c.status = 'active' AND ((r.requester_user_id = ? AND c.volunteer_id = ?) OR (r.requester_user_id = ? AND c.volunteer_id = ?))`,
    ).all(user.id, otherId, otherId, user.id) as { id: string; request_id: string; role: string; volunteer_id: string }[];
    for (const c of claims) {
      ctx.db.prepare("UPDATE claims SET status = 'removed', ended_at = ?, end_reason = 'blocked' WHERE id = ?").run(now, c.id);
      addEvent(ctx, { requestId: c.request_id, type: 'helper_removed', role: c.role, claimId: c.id, actorKind: 'system', body: 'This helper is no longer assigned. The task is open again.' });
    }
    audit(ctx, actorOf(user), 'user.block', { kind: 'user', id: otherId });
  });
}

export function unblock(ctx: Ctx, user: User, otherId: string): void {
  ctx.db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(user.id, otherId);
}

export function listBlocked(ctx: Ctx, user: User) {
  return ctx.db.prepare('SELECT u.id, u.display_name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC').all(user.id) as { id: string; display_name: string }[];
}

/**
 * Deletes the account after confirming the password. Open requests are cancelled
 * and active help is released first, so nobody is left waiting on a deleted account.
 */
export async function deleteAccount(ctx: Ctx, user: User, passwordInput: unknown): Promise<void> {
  const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string } | undefined;
  if (!row || !(await verifyPassword(typeof passwordInput === 'string' ? passwordInput : '', row.password_hash))) fail('unauthenticated', 'That password is not correct.');
  const now = ctx.clock.now();
  tx(ctx.db, () => {
    const open = ctx.db.prepare("SELECT id FROM requests WHERE requester_user_id = ? AND kind = 'help' AND status = 'open'").pluck().all(user.id) as string[];
    for (const id of open) {
      ctx.db.prepare("UPDATE requests SET status = 'cancelled', closed_at = ?, close_reason = 'requester deleted their account', closed_by_kind = 'requester', updated_at = ? WHERE id = ?").run(now, now, id);
      ctx.db.prepare("UPDATE claims SET status = 'released', ended_at = ?, end_reason = 'request cancelled' WHERE request_id = ? AND status = 'active'").run(now, id);
      addEvent(ctx, { requestId: id, type: 'cancelled', actorKind: 'requester', actorLabel: 'Requester (account deleted)' });
    }
    const claims = ctx.db.prepare("SELECT id, request_id, role FROM claims WHERE volunteer_id = ? AND status = 'active'").all(user.id) as { id: string; request_id: string; role: string }[];
    for (const c of claims) {
      addEvent(ctx, { requestId: c.request_id, type: 'released', role: c.role, actorKind: 'system', actorLabel: 'Agape', body: 'The helper deleted their account. This task is open again.' });
    }
    audit(ctx, { userId: null, label: 'account owner' }, 'user.delete_self', { kind: 'user', id: user.id }, { cancelledRequests: open.length, releasedClaims: claims.length });
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  });
}

export function moderatorIds(ctx: Ctx): string[] {
  return ctx.db.prepare("SELECT id FROM users WHERE role IN ('moderator', 'admin') AND status = 'active'").pluck().all() as string[];
}

