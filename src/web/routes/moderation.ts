import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SKILL_LABEL } from '../../content/categories.js';
import { EMERGENCY_ROLES, INCIDENT_LABEL } from '../../content/emergency.js';
import { DomainError, audit } from '../../domain/core.js';
import { closeEmergency, emergencyAvailability, markMalicious, openEmergenciesForModerators, pauseEmergencies, resumeEmergencies } from '../../domain/emergencies.js';
import { deliveryStats, retryFailedDeliveries } from '../../domain/notifications.js';
import { REPORT_REASONS, openReports, reportSubjectUserId, reportsAbout, resolveReport } from '../../domain/reports.js';
import { type RequestRow, getRequest, hideMessage, removeRequest } from '../../domain/requests.js';
import { type User, actorOf, getUser, isModerator, setRole, suspendUser, unsuspendUser } from '../../domain/users.js';
import { listSkills, unverifySkill, verifySkill } from '../../domain/volunteers.js';
import { html } from '../../lib/html.js';
import type { RouteDeps } from '../app.js';
import { categoryLabel, csrfField, day, flash, postButton, render, when } from '../ui.js';

type Body = Record<string, string | undefined>;

export async function moderationRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { ctx } = deps;

  const requireMod = (req: FastifyRequest, reply: FastifyReply): User | null => {
    if (!req.user) {
      reply.redirect('/login?next=/mod', 303);
      return null;
    }
    if (!isModerator(req.user)) {
      render(req, reply, { title: 'Not allowed', body: html`<h1>Not allowed</h1><p>This area is for Agape moderators.</p>` }, 403);
      return null;
    }
    return req.user;
  };

  const modAction = (path: string, fn: (mod: User, req: FastifyRequest<{ Params: { id: string } }>, b: Body) => { redirect: string; ok: string }) => {
    app.post<{ Params: { id: string } }>(path, async (req, reply) => {
      const mod = requireMod(req, reply);
      if (!mod) return reply;
      const b = (req.body ?? {}) as Body;
      try {
        const res = fn(mod, req, b);
        flash(reply, 'ok', res.ok);
        return reply.redirect(res.redirect, 303);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        flash(reply, 'error', err.message);
        return reply.redirect(typeof b.back === 'string' && b.back.startsWith('/mod') ? b.back : '/mod', 303);
      }
    });
  };

  app.get('/mod', async (req, reply) => {
    const mod = requireMod(req, reply);
    if (!mod) return reply;
    const now = ctx.clock.now();
    const reports = openReports(ctx).length;
    const emergencies = openEmergenciesForModerators(ctx);
    const unconfirmed = emergencies.filter((e) => e.roles.some((r) => r.holders.some((h) => h.unconfirmed))).length;
    const stale = emergencies.filter((e) => e.stale).length;
    const failed = ctx.db.prepare("SELECT count(*) FROM deliveries WHERE status IN ('failed', 'gave_up') AND created_at > ?").pluck().get(now - 86_400_000) as number;
    const suspended = ctx.db.prepare("SELECT count(*) FROM users WHERE status = 'suspended'").pluck().get() as number;
    const a = emergencyAvailability(ctx);
    return render(req, reply, {
      title: 'Moderation',
      body: html`<h1>Moderation</h1>
<ul class="grid">
<li><a class="tile" href="/mod/reports"><b>${reports}</b><span>open reports</span></a></li>
<li><a class="tile" href="/mod/emergencies"><b>${emergencies.length}</b><span>open emergencies (${unconfirmed} unconfirmed, ${stale} stale)</span></a></li>
<li><a class="tile" href="/mod/deliveries"><b>${failed}</b><span>failed notifications (24 h)</span></a></li>
<li><a class="tile" href="/mod/users"><b>${suspended}</b><span>suspended accounts</span></a></li>
<li><a class="tile" href="/mod/audit"><b>Audit</b><span>history of moderator actions</span></a></li>
</ul>
<h2>Emergency requests</h2>
<p>Mode: <b>${a.mode}</b>${a.paused ? html` — <b>paused</b>: ${a.paused}` : ''}. Submissions ${a.submissionsOpen ? 'open' : 'closed'}.</p>
${a.paused ? postButton(req, '/mod/emergency/resume', 'Resume emergency requests', { cls: 'btn' }) : html`<form method="post" action="/mod/emergency/pause" class="stack">${csrfField(req)}
<label>Pause emergency requests now (public reason)<input name="reason" required maxlength="200" placeholder="Alert delivery is being repaired"></label><button class="btn btn-quiet" type="submit">Pause</button></form>`}`,
    });
  });

  modAction('/mod/emergency/pause', (mod, _req, b) => {
    pauseEmergencies(ctx, mod, b.reason);
    return { redirect: '/mod', ok: 'Emergency requests are paused. The direct 911 call remains visible.' };
  });
  modAction('/mod/emergency/resume', (mod) => {
    resumeEmergencies(ctx, mod);
    return { redirect: '/mod', ok: 'Emergency requests resumed (subject to the server’s emergency mode).' };
  });

  const describe = (kind: string, id: string) => {
    if (kind === 'request') {
      const r = getRequest(ctx, id);
      return r ? html`<a href="${r.kind === 'emergency' ? `/emergency/${r.id}` : `/requests/${r.id}`}">${categoryLabel(r.category)}: ${r.summary}</a> (${r.status})` : html`<i>deleted request</i>`;
    }
    if (kind === 'user') {
      const u = getUser(ctx, id);
      return u ? html`account <a href="/mod/users/${u.id}">${u.display_name}</a>` : html`<i>deleted account</i>`;
    }
    const m = ctx.db.prepare('SELECT body, request_id, hidden_at FROM messages WHERE id = ?').get(id) as { body: string; request_id: string; hidden_at: number | null } | undefined;
    return m ? html`message${m.hidden_at ? ' (hidden)' : ''} on <a href="/requests/${m.request_id}">a request</a>: <q>${m.body.slice(0, 200)}</q>` : html`<i>deleted message</i>`;
  };

  app.get('/mod/reports', async (req, reply) => {
    const mod = requireMod(req, reply);
    if (!mod) return reply;
    const now = ctx.clock.now();
    const reports = openReports(ctx);
    return render(req, reply, {
      title: 'Reports',
      body: html`<h1>Open reports</h1>
${reports.length ? html`<ul class="list">${reports.map((r) => {
    const subject = reportSubjectUserId(ctx, r);
    return html`<li class="${r.reason === 'malicious_emergency' ? 'urgent' : ''}"><b>${REPORT_REASONS[r.reason]}</b> — ${describe(r.target_kind, r.target_id)}<br>
<span class="muted">${when(req, r.created_at, now)} · by ${r.reporter_user_id ? html`<a href="/mod/users/${r.reporter_user_id}">${getUser(ctx, r.reporter_user_id)?.display_name ?? 'deleted account'}</a>` : 'an emergency requester'}</span>
${r.details ? html`<p class="pre">${r.details}</p>` : ''}
<div class="actions">
${r.target_kind === 'request' ? postButton(req, `/mod/requests/${r.target_id}/remove`, 'Remove request', { cls: 'btn btn-small', fields: { reason: `Report: ${REPORT_REASONS[r.reason]}`, back: '/mod/reports' }, confirm: 'Remove this request?' }) : ''}
${r.target_kind === 'message' ? postButton(req, `/mod/messages/${r.target_id}/hide`, 'Hide message', { cls: 'btn btn-small', fields: { back: '/mod/reports' } }) : ''}
${subject ? html`<a class="btn btn-small" href="/mod/users/${subject}">Review account</a>` : ''}
</div>
<form method="post" action="/mod/reports/${r.id}/resolve" class="inline-form">${csrfField(req)}
<input name="resolution" required maxlength="300" placeholder="What you decided and why" aria-label="Resolution note">
<button class="btn btn-small" name="outcome" value="actioned" type="submit">Actioned</button>
<button class="btn btn-small" name="outcome" value="dismissed" type="submit">Dismiss</button></form></li>`;
  })}</ul>` : html`<p>No open reports.</p>`}`,
    });
  });

  modAction('/mod/reports/:id/resolve', (mod, req, b) => {
    resolveReport(ctx, mod, req.params.id, b.outcome === 'actioned' ? 'actioned' : 'dismissed', b.resolution);
    return { redirect: '/mod/reports', ok: 'Report resolved.' };
  });
  modAction('/mod/requests/:id/remove', (mod, req, b) => {
    removeRequest(ctx, mod, req.params.id, b.reason);
    return { redirect: b.back?.startsWith('/mod') ? b.back : '/mod', ok: 'Request removed. Helpers were told.' };
  });
  modAction('/mod/messages/:id/hide', (mod, req, b) => {
    hideMessage(ctx, mod, req.params.id);
    return { redirect: b.back?.startsWith('/mod') ? b.back : '/mod', ok: 'Message hidden.' };
  });

  app.get('/mod/users', async (req, reply) => {
    const mod = requireMod(req, reply);
    if (!mod) return reply;
    const q = String((req.query as Body).q ?? '').trim();
    const rows = (q
      ? ctx.db.prepare("SELECT id, display_name, email, status, role, created_at FROM users WHERE email LIKE ? OR display_name LIKE ? ORDER BY created_at DESC LIMIT 50").all(`%${q}%`, `%${q}%`)
      : ctx.db.prepare("SELECT id, display_name, email, status, role, created_at FROM users WHERE status = 'suspended' ORDER BY created_at DESC LIMIT 50").all()) as { id: string; display_name: string; email: string; status: string; role: string; created_at: number }[];
    const now = ctx.clock.now();
    return render(req, reply, {
      title: 'Accounts',
      body: html`<h1>Accounts</h1>
<form method="get" action="/mod/users" class="inline-form"><label>Search name or email <input name="q" value="${q}"></label> <button class="btn btn-small" type="submit">Search</button></form>
<p class="muted">${q ? `Results for “${q}”` : 'Suspended accounts'}</p>
<ul class="list">${rows.map((u) => html`<li><a href="/mod/users/${u.id}">${u.display_name}</a> — ${u.email} · ${u.role} · ${u.status} · joined ${day(req, u.created_at)}</li>`)}</ul>`,
    });
  });

  app.get<{ Params: { id: string } }>('/mod/users/:id', async (req, reply) => {
    const mod = requireMod(req, reply);
    if (!mod) return reply;
    const u = getUser(ctx, req.params.id);
    if (!u) return reply.redirect('/mod/users', 303);
    audit(ctx, actorOf(mod), 'user.view', { kind: 'user', id: u.id });
    const now = ctx.clock.now();
    const reports = reportsAbout(ctx, u.id);
    const requests = ctx.db.prepare('SELECT * FROM requests WHERE requester_user_id = ? ORDER BY created_at DESC LIMIT 50').all(u.id) as RequestRow[];
    const claims = ctx.db.prepare('SELECT c.id, c.role, c.status, c.created_at, r.id AS request_id, r.kind, r.summary FROM claims c JOIN requests r ON r.id = c.request_id WHERE c.volunteer_id = ? ORDER BY c.created_at DESC LIMIT 50').all(u.id) as { id: string; role: string; status: string; created_at: number; request_id: string; kind: string; summary: string }[];
    const skills = listSkills(ctx, u.id);
    return render(req, reply, {
      title: u.display_name,
      body: html`<p class="crumbs"><a href="/mod/users">← Accounts</a></p>
<h1>${u.display_name}</h1>
<dl class="facts"><dt>Email</dt><dd>${u.email}</dd><dt>Role</dt><dd>${u.role}</dd><dt>Status</dt><dd>${u.status}${u.status === 'suspended' ? html` until ${u.suspended_until ? when(req, u.suspended_until, now, { date: true }) : 'further notice'} — ${u.suspension_reason}` : ''}</dd>
<dt>Joined</dt><dd>${day(req, u.created_at)}</dd><dt>Last seen</dt><dd>${u.last_seen_at ? when(req, u.last_seen_at, now) : 'never'}</dd></dl>
${u.status === 'suspended' ? postButton(req, `/mod/users/${u.id}/unsuspend`, 'Lift suspension', { cls: 'btn' }) : html`<form method="post" action="/mod/users/${u.id}/suspend" class="stack">${csrfField(req)}
<label>Suspend for <select name="hours"><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option><option value="">Until lifted</option></select></label>
<label>Reason (the account holder will see it)<input name="reason" required maxlength="300"></label>
<button class="btn btn-quiet" type="submit">Suspend</button></form>`}
${mod.role === 'admin' && mod.id !== u.id ? html`<form method="post" action="/mod/users/${u.id}/role" class="inline-form">${csrfField(req)}<label>Role <select name="role">${['member', 'moderator', 'admin'].map((r) => html`<option${r === u.role ? ' selected' : ''}>${r}</option>`)}</select></label> <button class="btn btn-small" type="submit">Change role</button></form>` : ''}
<h2>Skills</h2>
${skills.length ? html`<ul class="list">${skills.map((s) => html`<li>${SKILL_LABEL.get(s.skill) ?? s.skill}${s.detail ? ` — ${s.detail}` : ''} · ${s.verified_at ? html`<b>checked</b> ${day(req, s.verified_at)}: ${s.verification_note} ${postButton(req, `/mod/skills/${s.id}/unverify`, 'Remove check', { cls: 'btn btn-small', fields: { back: `/mod/users/${u.id}` } })}` : html`self-reported
<form method="post" action="/mod/skills/${s.id}/verify" class="inline-form">${csrfField(req)}<input type="hidden" name="back" value="/mod/users/${u.id}"><input name="note" required maxlength="200" placeholder="What you checked" aria-label="What you checked"> <button class="btn btn-small" type="submit">Mark as checked</button></form>`}</li>`)}</ul>` : html`<p>None.</p>`}
<h2>Reports involving this account</h2>
${reports.length ? html`<ul class="list">${reports.map((r) => html`<li>${REPORT_REASONS[r.reason]} (${r.status}) ${when(req, r.created_at, now)}${r.resolution ? ` — ${r.resolution}` : ''}</li>`)}</ul>` : html`<p>None.</p>`}
<h2>Requests</h2>
${requests.length ? html`<ul class="list">${requests.map((r) => html`<li><a href="${r.kind === 'emergency' ? `/emergency/${r.id}` : `/requests/${r.id}`}">${r.summary}</a> · ${r.status} · ${when(req, r.created_at, now)}</li>`)}</ul>` : html`<p>None.</p>`}
<h2>Helping</h2>
${claims.length ? html`<ul class="list">${claims.map((c) => html`<li><a href="${c.kind === 'emergency' ? `/emergency/${c.request_id}` : `/requests/${c.request_id}`}">${c.summary}</a> · ${c.kind === 'emergency' ? EMERGENCY_ROLES[c.role as keyof typeof EMERGENCY_ROLES]?.short : c.role} · ${c.status} · ${when(req, c.created_at, now)}</li>`)}</ul>` : html`<p>None.</p>`}`,
    });
  });

  modAction('/mod/users/:id/suspend', (mod, req, b) => {
    suspendUser(ctx, mod, req.params.id, b.hours ? Number(b.hours) : null, b.reason);
    return { redirect: `/mod/users/${req.params.id}`, ok: 'Account suspended, signed out, and removed from tasks it was helping with.' };
  });
  modAction('/mod/users/:id/unsuspend', (mod, req) => {
    unsuspendUser(ctx, mod, req.params.id);
    return { redirect: `/mod/users/${req.params.id}`, ok: 'Suspension lifted.' };
  });
  modAction('/mod/users/:id/role', (mod, req, b) => {
    setRole(ctx, mod, req.params.id, b.role as User['role']);
    return { redirect: `/mod/users/${req.params.id}`, ok: 'Role changed.' };
  });
  modAction('/mod/skills/:id/verify', (mod, req, b) => {
    verifySkill(ctx, mod, req.params.id, b.note);
    return { redirect: b.back?.startsWith('/mod') ? b.back : '/mod', ok: 'Skill marked as checked.' };
  });
  modAction('/mod/skills/:id/unverify', (mod, req, b) => {
    unverifySkill(ctx, mod, req.params.id);
    return { redirect: b.back?.startsWith('/mod') ? b.back : '/mod', ok: 'Check removed; the skill is self-reported again.' };
  });

  app.get('/mod/emergencies', async (req, reply) => {
    const mod = requireMod(req, reply);
    if (!mod) return reply;
    const now = ctx.clock.now();
    const list = openEmergenciesForModerators(ctx);
    return render(req, reply, {
      title: 'Open emergencies',
      body: html`<h1>Open emergency requests</h1>
<p class="hint">Emergencies are never closed automatically. Close one only when the requester cannot be reached and there is nothing more volunteers can do; say so in the reason. Viewing one is logged.</p>
${list.length ? html`<ul class="list">${list.map((s) => {
    const r = s.request;
    const flags = [
      ...s.roles.filter((rs) => rs.holders.some((h) => h.unconfirmed)).map((rs) => `${EMERGENCY_ROLES[rs.role].short}: unconfirmed`),
      ...s.roles.filter((rs) => rs.holders.length === 0).map((rs) => `${EMERGENCY_ROLES[rs.role].short}: nobody yet`),
      ...(s.stale ? ['stale: no activity for over 2 hours'] : []),
      ...(r.possible_duplicate_of ? ['possible duplicate'] : []),
    ];
    return html`<li class="${flags.length ? 'urgent' : ''}"><a href="/emergency/${r.id}">${INCIDENT_LABEL.get(r.incident_type ?? '') ?? r.summary}</a> · received ${when(req, r.created_at, now)} · requester last seen ${r.requester_last_seen_at ? when(req, r.requester_last_seen_at, now) : 'never'} · alerted ${r.alerted_count}
${flags.length ? html`<br>${flags.map((f) => html`<span class="tag tag-emergency">${f}</span> `)}` : ''}</li>`;
  })}</ul>` : html`<p>None open.</p>`}`,
    });
  });

  modAction('/mod/emergencies/:id/close', (mod, req, b) => {
    closeEmergency(ctx, req.params.id, { kind: 'moderator', user: mod }, b.reason);
    return { redirect: `/emergency/${req.params.id}`, ok: 'Closed. The reason is shown to helpers and the requester.' };
  });
  modAction('/mod/emergencies/:id/malicious', (mod, req, b) => {
    markMalicious(ctx, mod, req.params.id, b.note);
    return { redirect: '/mod/emergencies', ok: 'Removed as malicious. Helpers were told; the connection is blocked from emergency requests for a day.' };
  });

  app.get('/mod/audit', async (req, reply) => {
    const mod = requireMod(req, reply);
    if (!mod) return reply;
    const before = Number((req.query as Body).before) || Number.MAX_SAFE_INTEGER;
    const rows = ctx.db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT 100').all(before) as { id: number; actor_label: string; action: string; target_kind: string | null; target_id: string | null; detail: string | null; created_at: number }[];
    const now = ctx.clock.now();
    return render(req, reply, {
      title: 'Audit history',
      body: html`<h1>Audit history</h1><p class="hint">Append-only. Entries cannot be edited or deleted.</p>
<table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td>${when(req, r.created_at, now, { date: true })}</td><td>${r.actor_label}</td><td>${r.action}</td><td>${r.target_kind ? `${r.target_kind} ${r.target_id}` : ''}</td><td class="pre small">${r.detail ?? ''}</td></tr>`)}
</tbody></table>
${rows.length === 100 ? html`<p><a href="/mod/audit?before=${rows[rows.length - 1]!.id}">Older</a></p>` : ''}`,
    });
  });

  app.get('/mod/deliveries', async (req, reply) => {
    const mod = requireMod(req, reply);
    if (!mod) return reply;
    const now = ctx.clock.now();
    const stats = deliveryStats(ctx, now - 7 * 86_400_000);
    const failed = ctx.db.prepare(
      `SELECT d.channel, d.status, d.attempts, d.last_error, d.created_at, n.type FROM deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE d.status IN ('failed', 'gave_up') ORDER BY d.created_at DESC LIMIT 100`,
    ).all() as { channel: string; status: string; attempts: number; last_error: string | null; created_at: number; type: string }[];
    return render(req, reply, {
      title: 'Notification delivery',
      body: html`<h1>Notification delivery</h1>
<p>Push: ${ctx.config.push ? 'configured' : 'not configured'} · Email: ${ctx.config.email ? 'configured' : 'not configured'}</p>
<h2>Last 7 days</h2><table class="table"><thead><tr><th>Channel</th><th>Status</th><th>Count</th></tr></thead><tbody>${stats.map((s) => html`<tr><td>${s.channel}</td><td>${s.status}</td><td>${s.n}</td></tr>`)}</tbody></table>
${postButton(req, '/mod/deliveries/retry', 'Retry all failed non-urgent deliveries', { cls: 'btn' })}
<h2>Recent failures</h2>
<ul class="list">${failed.map((f) => html`<li>${when(req, f.created_at, now)} · ${f.type} · ${f.channel} · ${f.status} after ${f.attempts} attempt(s) · ${f.last_error ?? ''}</li>`)}</ul>`,
    });
  });

  modAction('/mod/deliveries/retry', (mod) => {
    const n = retryFailedDeliveries(ctx, null);
    audit(ctx, actorOf(mod), 'deliveries.retry', undefined, { count: n });
    return { redirect: '/mod/deliveries', ok: `${n} deliveries queued again.` };
  });
}
