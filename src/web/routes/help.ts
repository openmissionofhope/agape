import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CATEGORIES, CATEGORY_BY_KEY, SKILL_LABEL, TIMING_LABEL, TIMING_OPTIONS } from '../../content/categories.js';
import { DomainError } from '../../domain/core.js';
import { REPORT_REASONS, fileReport } from '../../domain/reports.js';
import {
  type RequestRow, accessLog, cancelRequest, claimHelp, completeRequest, createHelpRequest, events, getRequest, getSlots, holdingClaims,
  listMessages, logAccess, myRequests, postMessage, relationTo, releaseClaim, removeHelper, reopenRequest, reportDone,
} from '../../domain/requests.js';
import { getUser } from '../../domain/users.js';
import { getProfile, listSkills } from '../../domain/volunteers.js';
import { newToken } from '../../lib/crypto.js';
import { distanceBand, distanceMeters } from '../../lib/geo.js';
import { type SafeHtml, html } from '../../lib/html.js';
import { type RouteDeps, requireUser } from '../app.js';
import { categoryLabel, csrfField, day, errorBox, flash, pageNotFound, postButton, render, selfReported, when } from '../ui.js';
import { safeNext } from './account.js';

type Body = Record<string, string | string[] | undefined>;

const STATUS_LABEL: Record<string, string> = {
  open: 'Open', completed: 'Completed — help received', cancelled: 'Cancelled', expired: 'Expired', removed: 'Removed by a moderator', closed: 'Closed',
};

export function locationFields(opts: { zip?: string; areaLabel?: string; purpose: string }): SafeHtml {
  return html`<fieldset class="stack" data-geo>
<legend>Approximate area</legend>
<p class="hint">${opts.purpose}</p>
<label>ZIP code<input name="zip" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" autocomplete="postal-code" value="${opts.zip ?? ''}"></label>
<div class="geo-device" hidden>
  <button type="button" class="btn" data-geo-button>Use my device location instead</button>
  <p class="hint" data-geo-status role="status" aria-live="polite"></p>
  <input type="hidden" name="lat"><input type="hidden" name="lng"><input type="hidden" name="accuracy"><input type="hidden" name="captured_at">
</div>
<label>Area name shown to volunteers (optional)<input name="area_label" maxlength="80" placeholder="For example: East Durham, near the library" value="${opts.areaLabel ?? ''}"></label>
</fieldset>`;
}

export async function helpRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { ctx } = deps;

  app.get('/help', async (req, reply) => render(req, reply, {
    title: 'I need help',
    body: html`<h1>What do you need?</h1>
<div class="card card-emergency"><p><b>In danger, hurt, or someone isn’t breathing?</b> Call 911 now. <a href="/emergency">Emergency assistance</a> needs no account.</p></div>
<p>For everything else, choose a kind of help. ${req.user ? '' : html`You will need a free account, which protects people asking for help from fraud and data harvesting.`}</p>
<ul class="grid">${CATEGORIES.map((c) => html`<li><a class="tile" href="/help/new?category=${c.key}"><b>${c.label}</b><span>${c.description}</span></a></li>`)}</ul>`,
  }));

  const newForm = (req: FastifyRequest, reply: FastifyReply, values: Body, error: string | null = null, status = 200) => {
    const category = CATEGORY_BY_KEY.get(String(values.category ?? ''));
    if (!category) return reply.redirect('/help', 303);
    const v = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : '');
    return render(req, reply, {
      title: `Ask for help: ${category.label}`,
      body: html`<h1>Ask for help: ${category.label}</h1>
${category.caution ? html`<div class="card card-warn"><p>${category.caution}</p></div>` : ''}
${errorBox(error)}
<form method="post" action="/help" class="stack" data-offline-guard>
${csrfField(req)}
<input type="hidden" name="category" value="${category.key}">
<input type="hidden" name="idempotency_key" value="${v('idempotency_key') || newToken()}">
<label>What do you need, in a few words?
<input name="summary" required minlength="3" maxlength="140" value="${v('summary')}" aria-describedby="summary-hint"></label>
<p class="hint" id="summary-hint">Nearby volunteers see this. Do not include your name, address or phone number.</p>
${locationFields({ zip: v('zip'), areaLabel: v('area_label'), purpose: 'Volunteers see only an approximate area (about 1 km), never your exact location.' })}
<label>When?<select name="timing">${TIMING_OPTIONS.map((t) => html`<option value="${t.key}"${v('timing') === t.key ? ' selected' : ''}>${t.label}</option>`)}</select></label>
<label>How many ${category.roles[0]!.label.toLowerCase()}s do you need?<input name="helpers" type="number" min="1" max="5" value="${v('helpers') || '1'}"></label>
<fieldset class="stack"><legend>Private details</legend>
<p class="hint">Only people who offer to help (and moderators handling a report) see these. You can remove a helper at any time.</p>
${category.fields.map((f) => f.type === 'yesno'
    ? html`<label>${f.label}<select name="p_${f.key}"><option value="">—</option><option value="yes"${v(`p_${f.key}`) === 'yes' ? ' selected' : ''}>Yes</option><option value="no"${v(`p_${f.key}`) === 'no' ? ' selected' : ''}>No</option></select></label>`
    : html`<label>${f.label}${f.hint ? html`<span class="hint">${f.hint}</span>` : ''}<input name="p_${f.key}" ${f.type === 'number' ? html`type="number" min="0" max="${f.max ?? ''}"` : html`maxlength="${f.max ?? 200}"`} value="${v(`p_${f.key}`)}"></label>`)}
<label>Exact address or meeting place (optional)<input name="address_text" maxlength="300" value="${v('address_text')}" autocomplete="off"></label>
<label>Anything else your helper should know (optional)<textarea name="private_details" maxlength="2000" rows="4">${v('private_details')}</textarea></label>
</fieldset>
<button class="btn btn-primary" type="submit">Post my request</button>
<p class="hint" data-offline-message hidden role="alert">You are offline. Your request has not been sent.</p>
</form>`,
      scripts: ['/static/js/geo.js'],
    }, status);
  };

  app.get('/help/new', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    return newForm(req, reply, { category: (req.query as Body).category });
  });

  app.post('/help', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const b = req.body as Body;
    try {
      const r = createHelpRequest(ctx, user, b);
      flash(reply, 'ok', 'Your request is posted. Nearby volunteers can now see it.');
      return reply.redirect(`/requests/${r.id}`, 303);
    } catch (err) {
      if (err instanceof DomainError) return newForm(req, reply, b, err.message, err.status);
      throw err;
    }
  });

  app.get('/requests/mine', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const rows = myRequests(ctx, user);
    const now = ctx.clock.now();
    return render(req, reply, {
      title: 'My requests',
      body: html`<h1>My requests</h1>
<p><a class="btn btn-primary" href="/help">Ask for help</a></p>
${rows.length ? html`<ul class="list">${rows.map((r) => {
    const held = holdingClaims(ctx, r.id).length;
    return html`<li><a href="${r.kind === 'emergency' ? `/emergency/${r.id}` : `/requests/${r.id}`}"><b>${r.summary}</b></a><br>
<span class="muted">${categoryLabel(r.category)} · ${STATUS_LABEL[r.status]} · ${held} helper${held === 1 ? '' : 's'} · posted ${when(req, r.created_at, now)}</span></li>`;
  })}</ul>` : html`<p>You have not asked for help yet.</p>`}`,
    });
  });

  app.get<{ Params: { id: string } }>('/requests/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const r = getRequest(ctx, req.params.id);
    if (!r || (r.status === 'removed' && user.role === 'member')) return pageNotFound(req, reply, 'That request');
    if (r.kind === 'emergency') return reply.redirect(`/emergency/${r.id}`, 303);
    return requestPage(req, reply, r);
  });

  function requestPage(req: FastifyRequest, reply: FastifyReply, r: RequestRow) {
    const user = req.user!;
    const rel = relationTo(ctx, r, user);
    const now = ctx.clock.now();
    const category = CATEGORY_BY_KEY.get(r.category);
    const slots = getSlots(ctx, r.id);
    const held = holdingClaims(ctx, r.id);
    const openCount = slots.length - held.length;
    const profile = getProfile(ctx, user.id);
    const distance = profile?.area_lat != null && profile.area_lng != null && r.approx_lat !== null && r.approx_lng !== null
      ? distanceBand(distanceMeters({ lat: profile.area_lat, lng: profile.area_lng }, { lat: r.approx_lat, lng: r.approx_lng })) : null;
    if (rel.restricted && !rel.isRequester) logAccess(ctx, r, user, rel.isModerator && !rel.claim ? 'moderator view' : 'helper view');
    const requester = r.requester_user_id ? getUser(ctx, r.requester_user_id) : null;
    const practical = JSON.parse(r.practical) as Record<string, string>;

    const restricted = rel.restricted ? html`<section class="card card-private" aria-labelledby="private-h">
<h2 id="private-h">Private details</h2>
<p class="hint">Visible to the requester, current helpers and moderators.${rel.isRequester ? ' Each time someone else views them, it is logged below.' : ' Do not share them with anyone else.'}</p>
<dl class="facts">
${requester ? html`<dt>Requester</dt><dd>${requester.display_name}, member since ${day(req, requester.created_at)}</dd>` : ''}
${r.address_text ? html`<dt>Address or meeting place</dt><dd>${r.address_text}</dd>` : ''}
${r.exact_lat !== null ? html`<dt>Device location</dt><dd>${r.exact_lat.toFixed(5)}, ${r.exact_lng!.toFixed(5)}${r.exact_accuracy_m !== null ? ` (±${r.exact_accuracy_m} m)` : ''}, recorded ${when(req, r.exact_captured_at ?? r.created_at, now)}
<a href="https://www.openstreetmap.org/?mlat=${r.exact_lat}&amp;mlon=${r.exact_lng}#map=17/${r.exact_lat}/${r.exact_lng}" rel="noopener noreferrer">open map</a></dd>` : ''}
${category?.fields.filter((f) => practical[f.key]).map((f) => html`<dt>${f.label}</dt><dd>${f.type === 'yesno' ? (practical[f.key] === 'yes' ? 'Yes' : 'No') : practical[f.key]}</dd>`)}
${r.private_details ? html`<dt>Other details</dt><dd class="pre">${r.private_details}</dd>` : ''}
${r.sensitive_purged_at ? html`<dt>Details</dt><dd>Deleted under the retention policy.</dd>` : ''}
</dl></section>` : html`<p class="hint">The exact location and private details are shared once you offer to help.</p>`;

    const helpers = held.length ? html`<section><h2>Helpers</h2><ul class="list">${held.map((c) => {
      const skills = listSkills(ctx, c.volunteer_id);
      const vp = getProfile(ctx, c.volunteer_id);
      return html`<li><b>${c.volunteer_name}</b> — offered ${when(req, c.created_at, now)}${c.status === 'done' ? html` · <span class="tag">says they have helped</span>` : ''}
${rel.isRequester || rel.isModerator ? html`<br>${vp?.availability_note ? html`<span class="muted">Availability: ${vp.availability_note}</span><br>` : ''}
${skills.length ? html`<span class="muted">Skills: </span>${skills.map((s) => html`<span class="tag">${SKILL_LABEL.get(s.skill) ?? s.skill}</span>${s.verified_at ? html`<span class="tag tag-verified">checked by a moderator on ${day(req, s.verified_at)}</span>` : selfReported()} `)}` : ''}
${rel.isRequester && r.status === 'open' ? html`<div class="actions">${postButton(req, `/claims/${c.id}/remove`, 'Remove this helper', { cls: 'btn btn-small', confirm: 'Remove this helper? They will be told they are no longer needed.' })}
${postButton(req, `/block/${c.volunteer_id}`, 'Block', { cls: 'btn btn-small', confirm: 'Block this person? They will be removed and cannot help you again.', fields: { next: `/requests/${r.id}` } })}
<a class="btn btn-small" href="/report?target_kind=user&amp;target_id=${c.volunteer_id}&amp;next=/requests/${r.id}">Report</a></div>` : ''}` : ''}</li>`;
    })}</ul></section>` : '';

    const myClaim = rel.claim;
    const actions: SafeHtml[] = [];
    if (r.status === 'open' && !rel.isRequester && !myClaim && openCount > 0) {
      const roles = [...new Set(slots.map((s) => s.role))];
      for (const role of roles) actions.push(postButton(req, `/requests/${r.id}/claim`, `Offer to help${roles.length > 1 ? ` as ${role}` : ''}`, { cls: 'btn btn-primary', fields: { role } }));
    }
    if (myClaim && r.status === 'open') {
      if (myClaim.status === 'active') actions.push(postButton(req, `/claims/${myClaim.id}/done`, 'I have helped', { cls: 'btn btn-primary' }));
      actions.push(postButton(req, `/claims/${myClaim.id}/release`, 'I can no longer help', { cls: 'btn', confirm: 'Step back from this request? It will reopen for someone else and the requester will be told.' }));
    }
    if (rel.isRequester) {
      if (r.status === 'open') {
        actions.push(postButton(req, `/requests/${r.id}/complete`, 'I received help — close request', { cls: 'btn btn-primary', confirm: 'Confirm that you received help? The request will close.' }));
        actions.push(postButton(req, `/requests/${r.id}/cancel`, 'Cancel request', { cls: 'btn', confirm: 'Cancel this request? Helpers will be told.' }));
      } else if (['cancelled', 'expired', 'completed'].includes(r.status) && !r.sensitive_purged_at) {
        actions.push(postButton(req, `/requests/${r.id}/reopen`, 'Reopen request', { cls: 'btn' }));
      }
    }

    const messages = rel.restricted ? html`<section aria-labelledby="msg-h"><h2 id="msg-h">Private conversation</h2>
${listMessages(ctx, r.id).map((m) => html`<div class="msg msg-${m.sender_kind}"><p class="msg-meta"><b>${m.sender_label}</b> · ${when(req, m.created_at, now)}
${m.sender_user_id && m.sender_user_id !== user.id && !m.hidden_at ? html` · <a href="/report?target_kind=message&amp;target_id=${m.id}&amp;next=/requests/${r.id}">report</a>` : ''}</p>
<p class="pre">${m.hidden_at ? html`<i>Hidden by a moderator.</i>` : m.body}</p></div>`)}
${r.status === 'open' && (rel.isRequester || myClaim || rel.isModerator) ? html`<form method="post" action="/requests/${r.id}/messages" class="stack" data-offline-guard>${csrfField(req)}
<label>Message<textarea name="body" required maxlength="2000" rows="3"></textarea></label><button class="btn" type="submit">Send</button>
<p class="hint" data-offline-message hidden role="alert">You are offline. The message has not been sent.</p></form>` : ''}</section>` : '';

    const timeline = rel.restricted ? html`<details><summary>History</summary><ol class="timeline">${events(ctx, r.id).map((e) => html`<li>${when(req, e.created_at, now)} — ${eventLabel(e.type)}${e.actor_label ? ` (${e.actor_label})` : ''}${e.body ? html`: <span class="pre">${e.body}</span>` : ''}</li>`)}</ol></details>` : '';
    const access = rel.isRequester || rel.isModerator ? html`<details><summary>Who has seen the private details</summary>${(() => {
      const log = accessLog(ctx, r.id);
      return log.length ? html`<ul>${log.map((a) => html`<li>${a.user_label} (${a.reason}) ${when(req, a.created_at, now)}</li>`)}</ul>` : html`<p>Nobody else yet.</p>`;
    })()}</details>` : '';

    return render(req, reply, {
      title: r.summary,
      body: html`<p class="crumbs"><a href="${rel.isRequester ? '/requests/mine' : '/discover'}">← ${rel.isRequester ? 'My requests' : 'Requests near me'}</a></p>
<h1>${r.summary}</h1>
<p class="status-line"><span class="tag">${categoryLabel(r.category)}</span> <span class="tag tag-status-${r.status}">${STATUS_LABEL[r.status]}</span></p>
<dl class="facts">
<dt>Area</dt><dd>${r.area_label ?? 'Approximate area'}${distance && !rel.isRequester ? ` — ${distance}` : ''} <span class="muted">(approximate)</span></dd>
<dt>When</dt><dd>${TIMING_LABEL.get(r.timing ?? '') ?? 'Flexible'}</dd>
<dt>Helpers</dt><dd>${held.length} of ${slots.length} ${openCount > 0 && r.status === 'open' ? html`(${openCount} still needed)` : ''}</dd>
<dt>Posted</dt><dd>${when(req, r.created_at, now)}</dd>
</dl>
${category?.caution ? html`<p class="hint">${category.caution}</p>` : ''}
${restricted}
${actions.length ? html`<div class="actions">${actions}</div>` : ''}
${helpers}
${messages}
${timeline}
${access}
${!rel.isRequester ? html`<p class="small"><a href="/report?target_kind=request&amp;target_id=${r.id}&amp;next=/requests/${r.id}">Report this request</a>
${r.requester_user_id ? html` · ${postButton(req, `/block/${r.requester_user_id}`, 'Block the requester', { cls: 'link', confirm: 'Block this person? You will no longer see each other’s requests.', fields: { next: '/discover' } })}` : ''}</p>` : ''}`,
    });
  }

  const action = (path: string, fn: (req: FastifyRequest<{ Params: { id: string } }>, b: Body) => { redirect: string; ok: string }) => {
    app.post<{ Params: { id: string } }>(path, async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return reply;
      const b = (req.body ?? {}) as Body;
      try {
        const res = fn(req, b);
        flash(reply, 'ok', res.ok);
        return reply.redirect(res.redirect, 303);
      } catch (err) {
        if (err instanceof DomainError && err.status !== 404) {
          flash(reply, 'error', err.message);
          return reply.redirect(req.headers.referer && safeReferer(req.headers.referer) ? safeReferer(req.headers.referer)! : '/', 303);
        }
        throw err;
      }
    });
  };

  const claimRequestId = (claimId: string) => (ctx.db.prepare('SELECT request_id FROM claims WHERE id = ?').pluck().get(claimId) as string | undefined) ?? '';
  const backTo = (requestId: string) => {
    const r = getRequest(ctx, requestId);
    return r?.kind === 'emergency' ? `/emergency/${requestId}` : `/requests/${requestId}`;
  };

  action('/requests/:id/claim', (req, b) => {
    claimHelp(ctx, req.user!, req.params.id, typeof b.role === 'string' ? b.role : undefined);
    return { redirect: `/requests/${req.params.id}`, ok: 'Thank you. You are now helping. The requester has been told, and you can see the details and message them below.' };
  });
  action('/claims/:id/release', (req, b) => {
    const rid = claimRequestId(req.params.id);
    releaseClaim(ctx, req.user!, req.params.id, b.reason);
    return { redirect: backTo(rid), ok: 'You have stepped back. The request is open for someone else.' };
  });
  action('/claims/:id/done', (req) => {
    const rid = claimRequestId(req.params.id);
    reportDone(ctx, req.user!, req.params.id);
    return { redirect: backTo(rid), ok: 'Thank you. The requester has been asked to confirm.' };
  });
  action('/claims/:id/remove', (req) => {
    const rid = claimRequestId(req.params.id);
    removeHelper(ctx, req.user!, req.params.id);
    return { redirect: backTo(rid), ok: 'The helper has been removed and told they are no longer needed. The request is open again.' };
  });
  action('/requests/:id/complete', (req) => {
    completeRequest(ctx, req.user!, req.params.id);
    return { redirect: `/requests/${req.params.id}`, ok: 'Closed. We are glad you received help.' };
  });
  action('/requests/:id/cancel', (req, b) => {
    cancelRequest(ctx, req.user!, req.params.id, b.reason);
    return { redirect: `/requests/${req.params.id}`, ok: 'Your request is cancelled. You can reopen it later.' };
  });
  action('/requests/:id/reopen', (req) => {
    reopenRequest(ctx, req.user!, req.params.id);
    return { redirect: `/requests/${req.params.id}`, ok: 'Your request is open again.' };
  });
  action('/requests/:id/messages', (req, b) => {
    const r = getRequest(ctx, req.params.id);
    if (!r || r.kind !== 'help') throw new DomainError('not_found', 'That request does not exist.');
    postMessage(ctx, relationTo(ctx, r, req.user), r, b.body);
    return { redirect: `/requests/${r.id}#msg-h`, ok: 'Message sent.' };
  });

  app.get('/report', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const q = req.query as Body;
    return reportForm(req, reply, { kind: String(q.target_kind ?? ''), id: String(q.target_id ?? ''), next: safeNext(q.next), action: '/report' });
  });

  app.post('/report', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const b = req.body as Body;
    fileReport(ctx, { user }, b);
    flash(reply, 'ok', 'Thank you. A moderator will review your report. You can also block the person.');
    return reply.redirect(safeNext(b.next), 303);
  });
}

export function reportForm(req: FastifyRequest, reply: FastifyReply, t: { kind: string; id: string; next: string; action: string }) {
  return render(req, reply, {
    title: 'Report a problem',
    body: html`<h1>Report a problem</h1>
<p>Reports go to Agape moderators. The person you report is not told who reported them.</p>
<form method="post" action="${t.action}" class="stack">${csrfField(req)}
<input type="hidden" name="target_kind" value="${t.kind}"><input type="hidden" name="target_id" value="${t.id}"><input type="hidden" name="next" value="${t.next}">
<fieldset><legend>What is wrong?</legend>${Object.entries(REPORT_REASONS).map(([k, label]) => html`<label class="check"><input type="radio" name="reason" value="${k}" required> ${label}</label>`)}</fieldset>
<label>Details (optional)<textarea name="details" maxlength="1000" rows="4"></textarea></label>
<button class="btn btn-primary" type="submit">Send report</button></form>
<p><b>If someone is in danger, call 911.</b></p>`,
  });
}

function safeReferer(ref: string): string | null {
  try {
    const u = new URL(ref);
    return safeNext(u.pathname) === u.pathname ? u.pathname : null;
  } catch {
    return null;
  }
}

export function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    created: 'Request posted', claimed: 'Helper offered to help', released: 'Helper stepped back', helper_removed: 'Helper removed', helper_done: 'Helper says they have helped',
    completed: 'Requester confirmed help received', cancelled: 'Cancelled', reopened: 'Reopened', expired: 'Expired', removed: 'Removed by a moderator',
    received: 'Received by Agape', role_accepted: 'Volunteer accepted a task', lapsed: 'Task released for reassignment', reassignment_requested: 'Requester asked for another volunteer',
    unconfirmed: 'No progress reported in time', requester_ems_contacted: 'Requester reports 911 has been called', location_corrected: 'Location corrected by requester', closed: 'Closed',
    ems_contacted: 'Volunteer reports contacting 911', location_relayed: 'Volunteer reports relaying the location and details', dispatcher_instructions: 'Dispatcher instructions relayed by volunteer',
    dispatch_info: 'Volunteer reports what the dispatcher said', could_not_reach: 'Volunteer reports they could not get through', call_ended: 'Volunteer reports the call ended',
    en_route: 'Volunteer reports being on the way', on_scene: 'Volunteer reports arriving', aed_unavailable: 'Volunteer reports they could not get an AED',
  };
  return labels[type] ?? type;
}
