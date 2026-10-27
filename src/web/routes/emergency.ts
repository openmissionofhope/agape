import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_JURISDICTION, EMERGENCY_ROLES, EMERGENCY_ROLE_KEYS, type EmergencyRole, INCIDENT_LABEL, INCIDENT_TYPES, JURISDICTIONS, NOT_A_SERVICE, RESPONDER_GUIDANCE, SOURCES,
} from '../../content/emergency.js';
import { DomainError, hashIp } from '../../domain/core.js';
import {
  CLOSE_REASONS, type EmergencyAvailability, type EmergencyStatus, MILESTONES, type RoleStatus, claimEmergencyRole, closeEmergency, correctLocation, createEmergency,
  emergencyAvailability, emergencyStatus, likelyRemote, recordMilestone, releaseEmergencyRole, requestIdForToken, requestReassignment, requesterReportsEmsContacted,
  requesterUpdate, touchRequester,
} from '../../domain/emergencies.js';
import { fileReport } from '../../domain/reports.js';
import { type RequestRow, getRequest, logAccess, postMessage, relationTo } from '../../domain/requests.js';
import { emergencyEligibility, getProfile } from '../../domain/volunteers.js';
import { newToken } from '../../lib/crypto.js';
import { distanceBand, distanceMeters } from '../../lib/geo.js';
import { type SafeHtml, html } from '../../lib/html.js';
import type { RouteDeps } from '../app.js';
import { cite, csrfField, errorBox, flash, pageNotFound, postButton, render, sourceLinks, when } from '../ui.js';
import { reportForm } from './help.js';

type Body = Record<string, string | string[] | undefined>;
const J = JURISDICTIONS[DEFAULT_JURISDICTION]!;
const TOKEN_COOKIE = 'agape_em';
const LITE_SCRIPTS = ['/static/js/geo.js', '/static/js/emergency.js'];

function callBlock(): SafeHtml {
  return html`<div class="call-first">
<a class="btn btn-call" href="${J.dialHref}">Call ${J.emergencyNumber} now</a>
<p><b>${J.callFirst}</b></p>
</div>`;
}

function availabilityBox(a: EmergencyAvailability): SafeHtml {
  return html`<div class="card ${a.submissionsOpen ? 'card-warn' : 'card-off'}" role="note">
<p><b>${a.submissionsOpen ? 'Pilot service — no guarantee anyone will respond.' : 'Emergency volunteer requests are not available right now.'}</b></p>
${a.reasons.length ? html`<ul>${a.reasons.map((r) => html`<li>${r}</li>`)}</ul>` : ''}
<p>${NOT_A_SERVICE} Coverage: ${J.name} only. <a href="/emergency/outside-us">Not in the ${J.name}?</a></p>
</div>`;
}

function locationHelper(): SafeHtml {
  return html`<section class="card" data-geo-read hidden>
<h2>Find your location to tell the dispatcher</h2>
<p>This reads your location once and shows it here. Nothing is sent to Agape.</p>
<button type="button" class="btn" data-geo-read-button>Show my location</button>
<p data-geo-read-status role="status" aria-live="polite"></p>
</section>`;
}

function dispatcherAsks(): SafeHtml {
  return html`<section><h2>What the 911 call-taker may ask</h2><ul>${J.dispatcherAsks.map((a) => html`<li>${a}</li>`)}</ul>
<p>Follow their instructions and do not hang up until they tell you to. ${cite('calling911')}</p>
<p>${J.textGuidance} ${cite('faq911')}</p></section>`;
}

export async function emergencyRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { ctx } = deps;

  const tokenFor = (req: FastifyRequest, id: string): string | null => {
    const t = req.cookies[TOKEN_COOKIE];
    return t && requestIdForToken(ctx, t) === id ? t : null;
  };
  const setToken = (reply: FastifyReply, id: string, token: string) => reply.setCookie(TOKEN_COOKIE, token, {
    path: `/emergency/${id}`, httpOnly: true, sameSite: 'lax', secure: ctx.config.secureCookies, maxAge: 30 * 24 * 3600,
  });

  app.get('/emergency', async (req, reply) => {
    const a = emergencyAvailability(ctx);
    return render(req, reply, {
      title: 'Emergency assistance',
      lite: true,
      scripts: LITE_SCRIPTS,
      indexable: true,
      body: html`<h1>Emergency assistance</h1>
${callBlock()}
${availabilityBox(a)}
<h2>If you cannot make the call yourself</h2>
<nav class="choices" aria-label="Emergency requests">
${EMERGENCY_ROLE_KEYS.map((r) => html`<a class="choice choice-emergency${a.submissionsOpen ? '' : ' choice-off'}" href="/emergency/new?need=${r}"><span class="choice-title">${EMERGENCY_ROLES[r].need}</span></a>`)}
</nav>
<p>No account, email or payment is needed. Each request takes one short form.</p>
${locationHelper()}
${dispatcherAsks()}
<p><a href="/emergency/guidance">Emergency guidance and its sources</a></p>`,
    });
  });

  const form = (req: FastifyRequest, reply: FastifyReply, values: Body, error: string | null = null, status = 200) => {
    const a = emergencyAvailability(ctx);
    const v = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : '');
    const needs = [values.needs ?? values.need].flat().filter(Boolean) as string[];
    const primary = (EMERGENCY_ROLE_KEYS as string[]).includes(needs[0] ?? '') ? (needs[0] as EmergencyRole) : 'call_911';
    if (!a.submissionsOpen) {
      return render(req, reply, {
        title: EMERGENCY_ROLES[primary].need, lite: true, scripts: LITE_SCRIPTS,
        body: html`<h1>${EMERGENCY_ROLES[primary].need}</h1>${callBlock()}${availabilityBox(a)}
<p>Because no volunteers would be reliably alerted, Agape is not accepting emergency requests here yet. Please call ${J.emergencyNumber}, or ask anyone near you to call.</p>
${locationHelper()}${dispatcherAsks()}`,
      }, status === 200 ? 503 : status);
    }
    return render(req, reply, {
      title: EMERGENCY_ROLES[primary].need,
      lite: true,
      scripts: LITE_SCRIPTS,
      body: html`<h1>${EMERGENCY_ROLES[primary].need}</h1>
${callBlock()}
${availabilityBox(a)}
${errorBox(error)}
<form method="post" action="/emergency" class="stack" data-emergency-form novalidate>
${csrfField(req)}
<input type="hidden" name="idempotency_key" value="${v('idempotency_key') || newToken()}">
<label class="hp" aria-hidden="true">Leave empty<input name="website" tabindex="-1" autocomplete="off"></label>
<fieldset><legend>What do you need?</legend>
${EMERGENCY_ROLE_KEYS.map((r) => html`<label class="check big"><input type="checkbox" name="needs" value="${r}"${needs.includes(r) || (needs.length === 0 && r === primary) ? ' checked' : ''}> ${EMERGENCY_ROLES[r].need}</label>`)}
</fieldset>
<fieldset class="stack"><legend>Where is the emergency?</legend>
<label class="check"><input type="radio" name="at_incident" value="yes"${v('at_incident') !== 'no' ? ' checked' : ''}> I am at the emergency</label>
<label class="check"><input type="radio" name="at_incident" value="no"${v('at_incident') === 'no' ? ' checked' : ''}> The emergency is somewhere else</label>
<div class="geo-device" data-geo hidden>
  <button type="button" class="btn" data-geo-button>Share my current location</button>
  <p class="hint" data-geo-status role="status" aria-live="polite">Your browser will ask first. Use this only if you are at the emergency.</p>
  <input type="hidden" name="lat" value="${v('lat')}"><input type="hidden" name="lng" value="${v('lng')}"><input type="hidden" name="accuracy" value="${v('accuracy')}"><input type="hidden" name="captured_at" value="${v('captured_at')}">
</div>
<label>Address or landmark, with city and state
<textarea name="location_text" rows="2" maxlength="300" autocomplete="street-address" placeholder="123 Main St, Apt 4, Durham NC — or: parking lot behind the Food Lion on Roxboro St, Durham NC">${v('location_text')}</textarea></label>
<label>ZIP code (optional, helps nearby volunteers find it)<input name="zip" inputmode="numeric" maxlength="5" value="${v('zip')}"></label>
</fieldset>
<label>What is happening?<select name="incident_type">${INCIDENT_TYPES.map((t) => html`<option value="${t.key}"${v('incident_type') === t.key ? ' selected' : ''}>${t.label}</option>`)}</select></label>
<label>Anything responders should know (optional)<textarea name="details" rows="3" maxlength="1000" placeholder="How many people, what happened, gate code, how to find you">${v('details')}</textarea></label>
<label>Callback number (optional)<input name="callback_phone" type="tel" maxlength="40" autocomplete="tel" value="${v('callback_phone')}"></label>
<p class="hint">Volunteers who accept a task will see this and may give it to the dispatcher. If your phone may die, add someone else’s number or leave it empty.</p>
<p class="hint"><b>Sending this does not contact 911.</b> It asks Agape volunteers to help. Your location and number are shared only with volunteers who accept a task, and moderators.</p>
<button class="btn btn-emergency" type="submit">Send emergency request</button>
<div class="send-status" data-send-status role="alert" aria-live="assertive" hidden></div>
</form>`,
    }, status);
  };

  app.get('/emergency/new', async (req, reply) => form(req, reply, { need: (req.query as Body).need }));

  app.post('/emergency', async (req, reply) => {
    const b = req.body as Body;
    const wantsJson = (req.headers.accept ?? '').includes('application/json');
    try {
      const { request, token } = createEmergency(ctx, b, { user: req.user, ipHash: hashIp(ctx, req.clientIp) });
      setToken(reply, request.id, token);
      if (wantsJson) return reply.send({ ok: true, url: `/emergency/${request.id}` });
      return reply.redirect(`/emergency/${request.id}`, 303);
    } catch (err) {
      if (err instanceof DomainError) {
        if (wantsJson) return reply.code(err.status).send({ ok: false, message: err.message });
        return form(req, reply, b, err.message, err.status);
      }
      throw err;
    }
  });

  app.get<{ Params: { token: string } }>('/r/:token', async (req, reply) => {
    const id = requestIdForToken(ctx, req.params.token);
    if (!id) {
      return render(req, reply, {
        title: 'Link not valid', lite: true,
        body: html`<h1>This link is not valid</h1><p>It may have been mistyped, or the request was removed.</p>${callBlock()}`,
      }, 404);
    }
    setToken(reply, id, req.params.token);
    return reply.redirect(`/emergency/${id}`, 303);
  });

  app.get<{ Params: { id: string } }>('/emergency/:id', async (req, reply) => {
    const r = getRequest(ctx, req.params.id);
    if (!r || r.kind !== 'emergency') return pageNotFound(req, reply, 'That emergency request');
    const token = tokenFor(req, r.id);
    const rel = relationTo(ctx, r, req.user, { requesterToken: !!token });
    const profile = req.user ? getProfile(ctx, req.user.id) : null;
    const isResponder = !!profile?.emergency_opt_in;
    if (!rel.isRequester && !rel.restricted && !isResponder) return pageNotFound(req, reply, 'That emergency request');
    if (r.status === 'removed' && !rel.isModerator) return pageNotFound(req, reply, 'That emergency request');
    if (rel.isRequester) touchRequester(ctx, r.id);
    if (rel.restricted && !rel.isRequester && req.user) logAccess(ctx, r, req.user, rel.isModerator && !rel.claim ? 'moderator view' : 'emergency task');
    const status = emergencyStatus(ctx, getRequest(ctx, r.id)!);
    if (rel.isRequester) return requesterView(req, reply, status, token);
    return volunteerView(req, reply, status, rel.restricted, rel.isModerator);
  });

  // ------------------------------------------------------------------ requester

  function requesterView(req: FastifyRequest, reply: FastifyReply, s: EmergencyStatus, token: string | null) {
    const r = s.request;
    const now = ctx.clock.now();
    const open = r.status === 'open';
    const link = token ? `${ctx.config.publicUrl}/r/${token}` : null;
    const anyCallRole = s.roles.find((x) => x.role === 'call_911');
    const contacted = anyCallRole?.holders.some((h) => h.milestones.some((m) => m.type === 'ems_contacted')) ?? false;
    const noMatch = r.approx_lat === null && s.roles.some((x) => x.role !== 'call_911');
    const alerts = s.alerts;
    return render(req, reply, {
      title: 'Your emergency request',
      lite: true,
      scripts: LITE_SCRIPTS,
      body: html`<h1>Your emergency request</h1>
${open ? callBlock() : ''}
<div class="status-box" role="status" aria-live="polite">
<p class="milestone milestone-done">✓ <b>Received by Agape</b> at ${when(req, r.created_at, now)}.</p>
${open ? html`<p>${!anyCallRole ? '' : contacted ? html`A volunteer <b>reports</b> contacting 911 (details below). Agape cannot confirm this.` : html`<b>No one has reported contacting 911 yet.</b> If you can call 911, do it now.`}</p>` : html`<p><b>Closed</b> ${when(req, r.closed_at!, now)}: ${r.close_reason}${r.closed_by_kind === 'moderator' ? ' (closed by a moderator)' : ''}.</p>`}
</div>
${open ? html`<p class="hint">${alerts.people === 0
    ? html`<b>No volunteers were alerted.</b> ${s.request.approx_lat === null ? 'Without a map location or ZIP code we could not match nearby volunteers, and no' : 'No'} emergency volunteers registered for this area were available. Someone may still see it in Agape, but please do not rely on it.`
    : alerts.sent + alerts.pending + alerts.failed === 0
      ? html`${alerts.people} volunteer${alerts.people === 1 ? ' was' : 's were'} notified inside Agape only; they will see it when they next open Agape. No push or email alert could be sent.`
      : html`${alerts.people} volunteer${alerts.people === 1 ? ' was' : 's were'} alerted. ${alerts.sent} alert${alerts.sent === 1 ? ' was' : 's were'} accepted by a push or email service${alerts.failed ? html`, <b>${alerts.failed} failed</b>` : ''}${alerts.pending ? `, ${alerts.pending} still being sent` : ''}. Alerts and their delivery do not mean anyone has seen them.`}</p>
${noMatch ? html`<p class="hint">CPR and AED helpers need to be nearby. Add a ZIP code or share your location when you send a request so nearby volunteers can be matched.</p>` : ''}` : ''}
${s.roles.map((rs) => roleCard(req, rs, now, { requester: true, open }))}
${s.requesterReports.length ? html`<h2>Your updates</h2><ul>${s.requesterReports.map((u) => html`<li>${when(req, u.at, now)} — ${u.body}</li>`)}</ul>` : ''}
${s.messages.length ? html`<h2>Notes</h2>${s.messages.map((m) => html`<div class="msg msg-${m.sender_kind}"><p class="msg-meta"><b>${m.sender_label}</b> · ${when(req, m.created_at, now)}</p><p class="pre">${m.hidden_at ? 'Hidden by a moderator.' : m.body}</p></div>`)}` : ''}
${open ? html`<section class="stack"><h2>Tell volunteers</h2>
${postButton(req, `/emergency/${r.id}/ems-contacted`, '911 has been called (by me or someone here)', { cls: 'btn' })}
<form method="post" action="/emergency/${r.id}/update" class="stack" data-offline-guard>${csrfField(req)}
<label>Update<textarea name="body" rows="2" maxlength="1000" required></textarea></label><button class="btn" type="submit">Send update</button>
<p class="hint" data-offline-message hidden role="alert">Not sent: you are offline.</p></form>
<details><summary>Correct the location</summary><form method="post" action="/emergency/${r.id}/location" class="stack">${csrfField(req)}
<label>Corrected address or landmark, with city and state<textarea name="location_text" rows="2" maxlength="300" required></textarea></label><button class="btn" type="submit">Save corrected location</button></form></details>
<details><summary>Close this request</summary><form method="post" action="/emergency/${r.id}/close" class="stack">${csrfField(req)}
${Object.entries(CLOSE_REASONS).map(([k, label]) => html`<label class="check"><input type="radio" name="reason" value="${k}" required> ${label}</label>`)}
<button class="btn" type="submit">Close request</button></form></details>
</section>` : ''}
${link ? html`<section class="card"><h2>Keep this page</h2>
<p>This private link opens your request from any device. Anyone with it can see and update the request, so share it only with someone you trust.</p>
<p class="code small" data-copy>${link}</p>
<p><button type="button" class="btn btn-small" data-share="${link}" hidden>Share link</button></p></section>` : ''}
<p><a class="btn" href="/emergency/${r.id}">Refresh status</a> <span class="hint">This page does not refresh by itself, to save battery and data.</span></p>
${open ? html`<p class="small"><a href="/emergency/${r.id}/report">Report a volunteer</a></p>` : ''}`,
    });
  }

  function roleCard(req: FastifyRequest, rs: RoleStatus, now: number, o: { requester: boolean; open: boolean; mine?: string }) {
    const def = EMERGENCY_ROLES[rs.role];
    const title = rs.role === 'call_911' ? 'Calling 911 for you' : rs.role === 'cpr' ? 'CPR help nearby' : 'Bringing an AED';
    return html`<section class="role-card" aria-labelledby="role-${rs.role}">
<h2 id="role-${rs.role}">${o.requester ? title : def.short}</h2>
${rs.holders.length === 0 ? html`<p class="milestone milestone-open">○ No volunteer has accepted this yet.</p>` : ''}
${rs.holders.map((h) => html`<div class="holder">
<p class="milestone">● <b>Accepted by ${h.claim.volunteer_name}</b> at ${when(req, h.claim.created_at, now)}${h.claim.status === 'done' ? ' · task finished' : ''}.</p>
${rs.role === 'call_911' && !h.milestones.some((m) => m.type === 'ems_contacted') ? html`<p class="note">Accepting the task is not confirmation that 911 was called.</p>` : ''}
${h.milestones.length ? html`<ul class="milestones">${h.milestones.map((m) => html`<li><b>${m.label}</b> — ${when(req, m.at, now)}, reported by ${m.by ?? 'the volunteer'}${m.body ? html`:<br><q class="pre">${m.body}</q>` : ''}${m.type === 'dispatch_info' ? html` <span class="muted">(as reported by the volunteer; not confirmed by Agape or 911)</span>` : ''}</li>`)}</ul>` : ''}
${h.unconfirmed && o.open ? html`<p class="warn" role="alert"><b>Not confirmed.</b> ${h.claim.volunteer_name} accepted ${Math.round((now - h.claim.created_at) / 60_000)} minutes ago and has not reported ${rs.role === 'call_911' ? 'contacting 911' : 'being on the way'}.${o.requester ? (rs.role === 'call_911' ? ' If you can, call 911 yourself.' : '') : ' You can take over this task.'}</p>` : ''}
</div>`)}
${rs.open > 0 && rs.holders.length > 0 ? html`<p class="muted">${rs.open} more volunteer${rs.open === 1 ? '' : 's'} can join this task.</p>` : ''}
${o.requester && o.open && rs.holders.some((h) => h.claim.status === 'active') ? postButton(req, `/emergency/${(req.params as { id: string }).id}/reassign`, 'Ask for another volunteer', { cls: 'btn btn-small', fields: { role: rs.role }, confirm: 'Ask for another volunteer? The current volunteer will be told someone else is taking over.' }) : ''}
</section>`;
  }

  // ------------------------------------------------------------------ volunteer

  function volunteerView(req: FastifyRequest, reply: FastifyReply, s: EmergencyStatus, restricted: boolean, isModerator: boolean) {
    const r = s.request;
    const user = req.user!;
    const now = ctx.clock.now();
    const open = r.status === 'open';
    const mine = s.roles.flatMap((rs) => rs.holders.filter((h) => h.claim.volunteer_id === user.id && h.claim.status === 'active').map((h) => ({ rs, h })));
    const profile = getProfile(ctx, user.id);
    const distance = profile?.area_lat != null && profile.area_lng != null && r.approx_lat !== null && r.approx_lng !== null
      ? distanceMeters({ lat: profile.area_lat, lng: profile.area_lng }, { lat: r.approx_lat, lng: r.approx_lng }) : null;
    const remote = likelyRemote(ctx, user, r);

    const offers = open ? s.roles.map((rs) => {
      if (rs.holders.some((h) => h.claim.volunteer_id === user.id)) return html``;
      const elig = emergencyEligibility(ctx, user, rs.role);
      const takeover = rs.open === 0 && rs.holders.some((h) => h.unconfirmed);
      if (rs.open === 0 && !takeover) return html``;
      const label = `${takeover ? 'Take over' : 'Accept'}: ${EMERGENCY_ROLES[rs.role].volunteerTask}`;
      return elig.ok ? postButton(req, `/emergency/${r.id}/claim`, label, { cls: 'btn btn-emergency', fields: { role: rs.role } }) : html`<p class="muted">${EMERGENCY_ROLES[rs.role].short}: ${elig.reason}</p>`;
    }) : [];

    const details = restricted ? html`<section class="card card-private"><h2>Incident details</h2>
<p class="hint">Share these only with emergency services. Viewing is logged.</p>
<dl class="facts">
<dt>Location given by the requester</dt><dd class="big">${r.address_text ?? html`<i>No address typed.</i>`}</dd>
${r.exact_lat !== null ? html`<dt>Requester’s device location</dt><dd>${r.exact_lat.toFixed(5)}, ${r.exact_lng!.toFixed(5)}${r.exact_accuracy_m !== null ? ` — accurate to about ${r.exact_accuracy_m} m` : ' — accuracy unknown'}${r.exact_accuracy_m !== null && r.exact_accuracy_m > 500 ? html` <b>(imprecise)</b>` : ''}, recorded ${when(req, r.exact_captured_at ?? r.created_at, now)}.
<a href="https://www.openstreetmap.org/?mlat=${r.exact_lat}&amp;mlon=${r.exact_lng}#map=18/${r.exact_lat}/${r.exact_lng}" rel="noopener noreferrer">Open map</a></dd>` : ''}
<dt>Requester is</dt><dd>${r.incident_at_requester ? 'at the emergency' : 'somewhere else (not at the emergency)'}</dd>
<dt>What is happening</dt><dd>${INCIDENT_LABEL.get(r.incident_type ?? '') ?? r.summary}</dd>
${r.incident_details ? html`<dt>Details</dt><dd class="pre">${r.incident_details}</dd>` : ''}
<dt>Callback number</dt><dd>${r.callback_phone ? html`<a href="tel:${r.callback_phone.replace(/[^0-9+]/g, '')}">${r.callback_phone}</a>` : 'None given'}</dd>
${r.sensitive_purged_at ? html`<dt>Note</dt><dd>Details were deleted under the retention policy.</dd>` : ''}
</dl>
${s.requesterReports.map((u) => html`<p class="note">${when(req, u.at, now)} — ${u.body}</p>`)}
</section>` : html`<p class="hint">The address, details and callback number are shown only to volunteers who accept a task.</p>`;

    const tasks = mine.map(({ rs, h }) => html`<section class="card card-task"><h2>Your task: ${EMERGENCY_ROLES[rs.role].volunteerTask}</h2>
${rs.role === 'call_911' ? callScript(r, remote) : rs.role === 'cpr' ? guidanceList('cpr') : guidanceList('aed')}
<div class="stack">
${(Object.entries(MILESTONES) as [keyof typeof MILESTONES, (typeof MILESTONES)[keyof typeof MILESTONES]][]).filter(([, d]) => d.roles.includes(rs.role)).map(([type, d]) => html`<form method="post" action="/emergency/claims/${h.claim.id}/milestone" class="milestone-form">${csrfField(req)}
<input type="hidden" name="type" value="${type}">
${d.bodyLabel ? html`<label>${d.bodyLabel}<textarea name="body" rows="2" maxlength="1000"${d.needsBody ? ' required' : ''}></textarea></label>` : ''}
<button class="btn" type="submit">${milestoneButton(type)}</button></form>`)}
${postButton(req, `/emergency/claims/${h.claim.id}/release`, 'I can’t continue — release this task', { cls: 'btn btn-quiet', confirm: 'Release this task? Other volunteers will be alerted to take it.' })}
</div></section>`);

    return render(req, reply, {
      title: 'Emergency request',
      lite: true,
      scripts: LITE_SCRIPTS,
      body: html`<h1>${INCIDENT_LABEL.get(r.incident_type ?? '') ?? 'Emergency request'}</h1>
<p class="status-line">Received ${when(req, r.created_at, now)}. ${open ? '' : html`<b>Closed</b>: ${r.close_reason ?? ''}.`}
${distance !== null ? html` Approximate area: ${r.area_label ?? ''}, ${distanceBand(distance)} from your service area.` : r.approx_lat === null ? ' No map location: the requester typed an address.' : ''}</p>
${r.possible_duplicate_of ? html`<p class="note">This may be the same incident as another open report.</p>` : ''}
<p class="hint">${NOT_A_SERVICE} You are helping as a private person. Follow emergency services’ instructions.</p>
${offers.length ? html`<div class="actions">${offers}</div>` : ''}
${details}
${tasks}
${s.roles.map((rs) => roleCard(req, rs, now, { requester: false, open }))}
${restricted ? html`<section><h2>Notes</h2>${s.messages.map((m) => html`<div class="msg msg-${m.sender_kind}"><p class="msg-meta"><b>${m.sender_label}</b> · ${when(req, m.created_at, now)}</p><p class="pre">${m.hidden_at ? 'Hidden by a moderator.' : m.body}</p></div>`)}
${open && mine.length ? html`<form method="post" action="/emergency/${r.id}/note" class="stack">${csrfField(req)}<label>Note to the requester and other volunteers<textarea name="body" rows="2" maxlength="1000" required></textarea></label><button class="btn" type="submit">Send note</button></form>` : ''}</section>` : ''}
${isModerator ? html`<section class="card"><h2>Moderator</h2><p><a href="/mod/emergencies">Emergency review list</a></p>
${open ? html`<form method="post" action="/mod/emergencies/${r.id}/close" class="stack">${csrfField(req)}<label>Close with reason (shown to helpers; outcome is not assumed)<input name="reason" required maxlength="300" placeholder="Requester unreachable for 6 hours; outcome unknown"></label><button class="btn" type="submit">Close</button></form>` : ''}
<form method="post" action="/mod/emergencies/${r.id}/malicious" class="stack" data-confirm="Remove this as malicious? Helpers will be told to stop.">${csrfField(req)}<label>Mark as fake or malicious<input name="note" required maxlength="300"></label><button class="btn btn-quiet" type="submit">Remove as malicious</button></form></section>` : ''}
<p><a class="btn" href="/emergency/${r.id}">Refresh</a> <a href="/discover">Back to requests</a> · <a href="/report?target_kind=request&amp;target_id=${r.id}&amp;next=/discover">Report as fake or abusive</a></p>`,
    });
  }

  function milestoneButton(type: string): string {
    return ({
      ems_contacted: 'I reached 911', location_relayed: 'I gave them the location and details', dispatcher_instructions: 'Relay the dispatcher’s instructions',
      dispatch_info: 'Record what the dispatcher said', could_not_reach: 'I could not get through', call_ended: 'The call has ended',
      en_route: 'I am on my way', on_scene: 'I have arrived', aed_unavailable: 'I could not get an AED',
    } as Record<string, string>)[type] ?? type;
  }

  function callScript(r: RequestRow, remote: boolean | null): SafeHtml {
    const where = r.address_text ?? (r.exact_lat !== null ? `coordinates ${r.exact_lat.toFixed(5)}, ${r.exact_lng!.toFixed(5)}` : 'the location above');
    return html`<div class="${remote === false ? '' : 'card card-warn'}">
<h3>${remote === true ? 'You are probably in a different 911 area' : remote === false ? 'Calling from another location' : 'You may be in a different 911 area'}</h3>
<ul>${J.remoteCaller.map((t) => html`<li>${t}</li>`)}</ul>
<p class="small">${cite('faq911')}</p>
</div>
<ol class="script">
<li>Call <a class="btn btn-call btn-small" href="${J.dialHref}">${J.emergencyNumber}</a> — or, if the emergency is in another city, county or state, the 10-digit emergency number for law enforcement there.</li>
<li>Say first: <q><b>I am calling for someone else. The emergency is at another location: ${where}.</b></q></li>
<li>Say what is happening: <q>${INCIDENT_LABEL.get(r.incident_type ?? '') ?? r.summary}</q>${r.callback_phone ? html`, and give the callback number <b>${r.callback_phone}</b>` : ''}.</li>
<li>Give your own number too, answer the call-taker’s questions, and follow their instructions. Don’t hang up until they tell you to.</li>
<li>Report each step below as it actually happens. Relay any instructions the dispatcher gives for the person or bystanders.</li>
</ol>`;
  }

  function guidanceList(kind: 'cpr' | 'aed'): SafeHtml {
    return html`<ul class="guidance">${RESPONDER_GUIDANCE[kind].map((g) => html`<li>${g.text} ${cite(g.source)}</li>`)}</ul>
<p class="small">Full instructions: ${kind === 'cpr' ? html`<a href="${SOURCES.ahaHandsOnly!.url}" rel="noopener">AHA Hands-Only CPR</a> · <a href="${SOURCES.redCrossChildCpr!.url}" rel="noopener">Red Cross child &amp; baby CPR</a>` : html`<a href="${SOURCES.redCrossAed!.url}" rel="noopener">Red Cross AED steps</a>`}. Agape does not give medical instructions of its own.</p>`;
  }

  // ------------------------------------------------------------------ actions

  const isRequester = (req: FastifyRequest, id: string): boolean => {
    if (tokenFor(req, id)) return true;
    const r = req.user ? getRequest(ctx, id) : null;
    return !!r && r.kind === 'emergency' && r.requester_user_id === req.user!.id;
  };

  const requesterAction = (path: string, fn: (id: string, b: Body) => string) => {
    app.post<{ Params: { id: string } }>(path, async (req, reply) => {
      const id = req.params.id;
      if (!isRequester(req, id)) return pageNotFound(req, reply, 'That emergency request');
      touchRequester(ctx, id);
      try {
        flash(reply, 'ok', fn(id, (req.body ?? {}) as Body));
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        flash(reply, 'error', err.message);
      }
      return reply.redirect(`/emergency/${id}`, 303);
    });
  };

  requesterAction('/emergency/:id/ems-contacted', (id) => {
    requesterReportsEmsContacted(ctx, id, null);
    return 'Recorded. Volunteers will see that 911 has been called.';
  });
  requesterAction('/emergency/:id/update', (id, b) => {
    requesterUpdate(ctx, id, b.body);
    return 'Update sent to the volunteers on this request.';
  });
  requesterAction('/emergency/:id/location', (id, b) => {
    correctLocation(ctx, id, { location_text: b.location_text });
    return 'Location corrected. Volunteers on this request have been told.';
  });
  requesterAction('/emergency/:id/close', (id, b) => {
    closeEmergency(ctx, id, { kind: 'requester' }, b.reason);
    return 'Your request is closed. Thank you for letting volunteers know.';
  });
  requesterAction('/emergency/:id/reassign', (id, b) => {
    requestReassignment(ctx, id, String(b.role));
    return 'Other volunteers are being asked to take over. If you can, call 911 yourself.';
  });

  app.get<{ Params: { id: string } }>('/emergency/:id/report', async (req, reply) => {
    if (!isRequester(req, req.params.id)) return pageNotFound(req, reply, 'That emergency request');
    return reportForm(req, reply, { kind: 'request', id: req.params.id, next: `/emergency/${req.params.id}`, action: `/emergency/${req.params.id}/report` });
  });
  app.post<{ Params: { id: string } }>('/emergency/:id/report', async (req, reply) => {
    if (!isRequester(req, req.params.id)) return pageNotFound(req, reply, 'That emergency request');
    fileReport(ctx, { user: null, guestRequestId: req.params.id }, { ...(req.body as Body), target_kind: 'request', target_id: req.params.id });
    flash(reply, 'ok', 'Thank you. A moderator will review your report.');
    return reply.redirect(`/emergency/${req.params.id}`, 303);
  });

  const volunteerAction = (path: string, fn: (req: FastifyRequest<{ Params: { id: string } }>, b: Body) => { id: string; ok: string }) => {
    app.post<{ Params: { id: string } }>(path, async (req, reply) => {
      if (!req.user) return reply.redirect(`/login?next=${encodeURIComponent('/discover')}`, 303);
      let target = '/discover';
      try {
        const res = fn(req, (req.body ?? {}) as Body);
        target = `/emergency/${res.id}`;
        flash(reply, 'ok', res.ok);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        const rid = (ctx.db.prepare('SELECT request_id FROM claims WHERE id = ?').pluck().get(req.params.id) as string | undefined) ?? req.params.id;
        target = getRequest(ctx, rid) ? `/emergency/${rid}` : '/discover';
        flash(reply, 'error', err.message);
      }
      return reply.redirect(target, 303);
    });
  };
  const claimRequest = (claimId: string) => (ctx.db.prepare('SELECT request_id FROM claims WHERE id = ?').pluck().get(claimId) as string | undefined) ?? '';

  volunteerAction('/emergency/:id/claim', (req, b) => {
    const { tookOverFrom } = claimEmergencyRole(ctx, req.user!, req.params.id, String(b.role));
    return { id: req.params.id, ok: tookOverFrom ? 'You have taken over this task. The previous volunteer has been told.' : 'You accepted this task. Report each step as it actually happens.' };
  });
  volunteerAction('/emergency/claims/:id/milestone', (req, b) => {
    recordMilestone(ctx, req.user!, req.params.id, String(b.type), b.body);
    return { id: claimRequest(req.params.id), ok: 'Recorded. The requester and other volunteers can see it.' };
  });
  volunteerAction('/emergency/claims/:id/release', (req, b) => {
    const id = claimRequest(req.params.id);
    releaseEmergencyRole(ctx, req.user!, req.params.id, b.reason);
    return { id, ok: 'Task released. Other volunteers are being alerted.' };
  });
  volunteerAction('/emergency/:id/note', (req, b) => {
    const r = getRequest(ctx, req.params.id);
    if (!r || r.kind !== 'emergency') throw new DomainError('not_found', 'No such request.');
    postMessage(ctx, relationTo(ctx, r, req.user), r, b.body);
    return { id: r.id, ok: 'Note sent.' };
  });

  app.get('/emergency/guidance', async (req, reply) => render(req, reply, {
    title: 'Emergency guidance and sources',
    indexable: true,
    lite: true,
    body: html`<h1>Emergency guidance and sources</h1>
${callBlock()}
<p>${NOT_A_SERVICE}</p>
<p>Agape does not write its own medical instructions and does not use AI to decide who gets help. What follows is taken from the sources listed, with their scope.</p>
${dispatcherAsks()}
<h2>Calling for someone in another place</h2><ul>${J.remoteCaller.map((t) => html`<li>${t}</li>`)}</ul><p>${cite('faq911')}</p>
<p>911.gov also notes that apps must not be assumed to have authority to contact 911 for you. Agape never contacts 911; volunteers call as private people. ${cite('faq911')}</p>
<h2>CPR</h2><ul>${RESPONDER_GUIDANCE.cpr.map((g) => html`<li>${g.text} ${cite(g.source)}</li>`)}</ul>
<h2>AED</h2><ul>${RESPONDER_GUIDANCE.aed.map((g) => html`<li>${g.text} ${cite(g.source)}</li>`)}</ul>
<p>Agape has not verified any AED location, and volunteers’ training is self-reported unless marked as checked.</p>
<h2>Sources and review dates</h2>
${sourceLinks(Object.keys(SOURCES))}
<h2>Coverage</h2><p>Emergency information on Agape covers the ${J.name} only. The emergency number is not chosen from your browser’s language. <a href="/emergency/outside-us">Outside the ${J.name}</a>.</p>`,
  }));

  app.get('/emergency/outside-us', async (req, reply) => render(req, reply, {
    title: 'Outside the United States',
    lite: true,
    body: html`<h1>Outside the ${J.name}</h1>
<p class="lead">Agape does not yet have verified emergency information for other countries. Call your local emergency number now.</p>
<p>We do not list numbers for other countries until they have been checked against official sources, because a wrong number in an emergency costs time.</p>
<p><a href="/emergency">Back to emergency assistance (${J.name})</a></p>`,
  }));
}
