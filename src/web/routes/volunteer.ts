import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CATEGORIES, CATEGORY_BY_KEY, SKILLS, TIMING_LABEL } from '../../content/categories.js';
import { EMERGENCY_ROLES, EMERGENCY_ROLE_KEYS, INCIDENT_LABEL } from '../../content/emergency.js';
import { DomainError } from '../../domain/core.js';
import { type DiscoveryItem, discover, myTasks } from '../../domain/requests.js';
import { type VolunteerProfile, getProfile, listSkills, saveProfile } from '../../domain/volunteers.js';
import { distanceBand, metersToMiles } from '../../lib/geo.js';
import { type SafeHtml, html } from '../../lib/html.js';
import { type RouteDeps, requireUser } from '../app.js';
import { categoryLabel, csrfField, errorBox, flash, render, when } from '../ui.js';
import { locationFields } from './help.js';
import { coverageBand, volunteerCount } from './public.js';

type Body = Record<string, string | string[] | undefined>;

export async function volunteerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { ctx } = deps;

  app.get('/volunteer', async (req, reply) => {
    const profile = req.user ? getProfile(ctx, req.user.id) : null;
    return render(req, reply, {
      title: 'I can help',
      body: html`<h1>I can help</h1>
<p class="lead">Thank you. Volunteering on Agape is unpaid and voluntary: you choose what, when and whether to help, and you can step back at any time.</p>
<ol class="steps">
<li>${req.user ? html`<b>Account</b> — done.` : html`<a href="/signup?next=/volunteer/profile">Create an account</a> (adults only) or <a href="/login?next=/volunteer/profile">sign in</a>.`}</li>
<li>${profile ? html`<b>Volunteer profile</b> — <a href="/volunteer/profile">edit</a>.` : html`<a href="/volunteer/profile">Set your service area, availability and what you can help with</a>.`}</li>
<li><a href="/discover">See requests near you</a>.</li>
</ol>
<p>Volunteers on Agape right now: <b>${coverageBand(volunteerCount(deps))}</b> nationwide. Every new volunteer matters.</p>
<div class="card"><h2>Emergency tasks</h2>
<p>You can also offer to take emergency tasks: calling 911 for someone who can’t, helping with CPR nearby, or bringing an AED. These are optional, and Agape never assumes you are available. ${ctx.config.responderMinAccountAgeMs > 0 ? `Accounts can take emergency tasks ${Math.round(ctx.config.responderMinAccountAgeMs / 3_600_000)} hours after they are created.` : ''}</p></div>`,
    });
  });

  const profileForm = (req: FastifyRequest, reply: FastifyReply, p: VolunteerProfile | null, values: Body | null, error: string | null = null, status = 200) => {
    const v = (k: string) => (values && typeof values[k] === 'string' ? (values[k] as string) : '');
    const has = (k: string, x: string, current: string[] | undefined) => (values ? ([values[k]].flat().includes(x)) : !!current?.includes(x));
    const checked = (k: string, current: boolean) => (values ? values[k] === 'yes' : current) ? ' checked' : '';
    const skills = listSkills(ctx, req.user!.id);
    return render(req, reply, {
      title: 'Volunteer profile',
      body: html`<h1>Volunteer profile</h1>
${errorBox(error)}
<form method="post" action="/volunteer/profile" class="stack" data-offline-guard>
${csrfField(req)}
<label class="check"><input type="checkbox" name="available" value="yes"${checked('available', p ? p.available === 1 : true)}> I am available to help at the moment</label>
<label>When are you usually available? (optional)<input name="availability_note" maxlength="200" placeholder="Weekday evenings, Saturday mornings" value="${values ? v('availability_note') : p?.availability_note ?? ''}"></label>
${locationFields({ zip: v('zip'), areaLabel: values ? v('area_label') : p?.area_label ?? '', purpose: p?.area_lat != null ? `Your service area is set${p.area_label ? ` (${p.area_label})` : ''}. Enter a ZIP code or use your device to change it. It is stored only to about 1 km and never shown to anyone.` : 'Where should we look for requests? Your service area is stored only to about 1 km and never shown to anyone.' })}
<label>How far will you go? (miles)<input name="radius_miles" type="number" min="1" max="100" value="${values ? v('radius_miles') : p ? metersToMiles(p.radius_m) : 10}"></label>
<fieldset><legend>What can you help with? (none checked = everything)</legend>
${CATEGORIES.map((c) => html`<label class="check"><input type="checkbox" name="categories" value="${c.key}"${has('categories', c.key, p?.categories) ? ' checked' : ''}> ${c.label}</label>`)}</fieldset>
<label class="check"><input type="checkbox" name="notify_new_requests" value="yes"${checked('notify_new_requests', p ? p.notify_new_requests === 1 : true)}> Notify me about new requests in my area</label>
<fieldset><legend>Skills and resources <span class="tag tag-self">self-reported</span></legend>
<p class="hint">Others will see these as self-reported. A moderator can mark a skill as checked after seeing evidence.</p>
${SKILLS.map((s) => {
    const found = skills.find((x) => x.skill === s.key);
    return html`<div class="skill"><label class="check"><input type="checkbox" name="skills" value="${s.key}"${(values ? has('skills', s.key, undefined) : !!found) ? ' checked' : ''}${found?.verified_at ? ' disabled' : ''}> ${s.label}</label>
${found?.verified_at ? html`<span class="tag tag-verified">checked by a moderator: ${found.verification_note}</span><input type="hidden" name="skills" value="${s.key}">` : html`<input name="skill_detail_${s.key}" maxlength="120" placeholder="Details (optional)" aria-label="${s.label}: details" value="${values ? v(`skill_detail_${s.key}`) : found?.detail ?? ''}">`}</div>`;
  })}</fieldset>
<fieldset class="stack"><legend>Emergency tasks (optional)</legend>
<p class="hint">Only turn this on if you are willing to be alerted at short notice. Accepting a task is a promise to report what you actually do.</p>
<label class="check"><input type="checkbox" name="emergency_opt_in" value="yes"${checked('emergency_opt_in', p ? p.emergency_opt_in === 1 : false)}> Alert me about emergency assistance requests</label>
${EMERGENCY_ROLE_KEYS.map((r) => html`<label class="check"><input type="checkbox" name="emergency_roles" value="${r}"${has('emergency_roles', r, p?.emergency_roles) ? ' checked' : ''}> ${EMERGENCY_ROLES[r].volunteerTask}</label>`)}
<label class="check"><input type="checkbox" name="remote_call_ok" value="yes"${checked('remote_call_ok', p ? p.remote_call_ok === 1 : false)}> I can make call-backup calls for emergencies outside my area (I understand 911 from my phone reaches my local 911 center, not theirs)</label>
</fieldset>
<label>A sentence about you (optional, shown to people you help)<textarea name="bio" maxlength="500" rows="3">${values ? v('bio') : p?.bio ?? ''}</textarea></label>
<button class="btn btn-primary" type="submit">Save profile</button>
<p class="hint" data-offline-message hidden role="alert">You are offline. Your profile has not been saved.</p>
</form>`,
      scripts: ['/static/js/geo.js'],
    }, status);
  };

  app.get('/volunteer/profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    return profileForm(req, reply, getProfile(ctx, user.id), null);
  });

  app.post('/volunteer/profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const b = req.body as Body;
    try {
      saveProfile(ctx, user, b);
      flash(reply, 'ok', 'Profile saved.');
      return reply.redirect('/discover', 303);
    } catch (err) {
      if (err instanceof DomainError) return profileForm(req, reply, getProfile(ctx, user.id), b, err.message, err.status);
      throw err;
    }
  });

  app.get('/discover', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const p = getProfile(ctx, user.id);
    if (!p || p.area_lat === null || p.area_lng === null) {
      flash(reply, 'ok', 'First, set the area where you can help.');
      return reply.redirect('/volunteer/profile', 303);
    }
    const q = req.query as Body;
    const category = typeof q.category === 'string' && CATEGORY_BY_KEY.has(q.category) ? q.category : null;
    const { help, emergency } = discover(ctx, user, { center: { lat: p.area_lat, lng: p.area_lng! }, radiusM: p.radius_m, category });
    const now = ctx.clock.now();
    return render(req, reply, {
      title: 'Requests near you',
      body: html`<h1>Requests near you</h1>
<p>Within ${metersToMiles(p.radius_m)} miles of ${p.area_label ?? 'your service area'}. <a href="/volunteer/profile">Change</a> · <a href="/discover/map">Map</a> · <a href="/tasks">My tasks</a></p>
${p.emergency_opt_in ? html`<section aria-labelledby="em-h"><h2 id="em-h">Emergency requests</h2>
${emergency.length ? html`<ul class="list">${emergency.map((i) => emergencyItem(req, i, now))}</ul>` : html`<p>None open that match the tasks you offered.</p>`}</section>` : ''}
<section aria-labelledby="help-h"><h2 id="help-h">Help requests</h2>
<form method="get" action="/discover" class="inline-form"><label>Kind of help <select name="category"><option value="">All</option>${CATEGORIES.map((c) => html`<option value="${c.key}"${category === c.key ? ' selected' : ''}>${c.label}</option>`)}</select></label> <button class="btn btn-small" type="submit">Filter</button></form>
${help.length ? html`<ul class="list">${help.map((i) => helpItem(req, i, now))}</ul>` : html`<p>No open requests near you right now. Agape is new, so this is common. Thank you for being ready.</p>`}
</section>`,
    });
  });

  app.get('/discover/map', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const p = getProfile(ctx, user.id);
    if (!p || p.area_lat === null) return reply.redirect('/volunteer/profile', 303);
    return render(req, reply, {
      title: 'Map of requests',
      styles: ['/static/vendor/leaflet/leaflet.css'],
      scripts: ['/static/vendor/leaflet/leaflet.js', '/static/js/map.js'],
      body: html`<h1>Map of requests</h1>
<p>Circles show approximate areas (about 1 km), never exact locations. The <a href="/discover">list</a> has the same requests and works without the map.</p>
<div id="map" class="map" data-src="/discover/map.json" role="region" aria-label="Map of approximate request areas"><noscript>The map needs JavaScript. Use the <a href="/discover">list</a>.</noscript></div>
<p class="small muted">Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>. Map tiles are loaded from OpenStreetMap, which sees the approximate area you are viewing.</p>`,
    });
  });

  app.get('/discover/map.json', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'sign in required' });
    const p = getProfile(ctx, req.user.id);
    if (!p || p.area_lat === null || p.area_lng === null) return reply.code(400).send({ error: 'set your service area first' });
    const { help, emergency } = discover(ctx, req.user, { center: { lat: p.area_lat, lng: p.area_lng }, radiusM: p.radius_m });
    const points = [...emergency, ...help].map((i) => {
      const r = ctx.db.prepare('SELECT approx_lat, approx_lng FROM requests WHERE id = ?').get(i.id) as { approx_lat: number | null; approx_lng: number | null };
      return r.approx_lat === null ? null : { id: i.id, kind: i.kind, lat: r.approx_lat, lng: r.approx_lng, label: i.kind === 'emergency' ? 'Emergency assistance' : `${categoryLabel(i.category)}: ${i.summary}`, url: i.kind === 'emergency' ? `/emergency/${i.id}` : `/requests/${i.id}` };
    }).filter(Boolean);
    return reply.send({ center: { lat: p.area_lat, lng: p.area_lng }, radiusM: p.radius_m, points });
  });

  app.get('/tasks', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const tasks = myTasks(ctx, user);
    const now = ctx.clock.now();
    const statusText: Record<string, string> = { active: 'You are helping', done: 'You reported helping', released: 'You stepped back', removed: 'No longer needed', lapsed: 'Reassigned' };
    return render(req, reply, {
      title: 'My tasks',
      body: html`<h1>Tasks I’m helping with</h1>
${tasks.length ? html`<ul class="list">${tasks.map((t) => html`<li><a href="${t.kind === 'emergency' ? `/emergency/${t.request_id}` : `/requests/${t.request_id}`}"><b>${t.summary}</b></a><br>
<span class="muted">${t.kind === 'emergency' ? `Emergency · ${EMERGENCY_ROLES[t.role as keyof typeof EMERGENCY_ROLES]?.short ?? t.role}` : 'Help request'} · ${statusText[t.status] ?? t.status} · ${t.request_status === 'open' ? 'request open' : `request ${t.request_status}`} · ${when(req, t.created_at, now)}</span></li>`)}</ul>`
    : html`<p>You are not helping with anything yet. <a href="/discover">See requests near you</a>.</p>`}`,
    });
  });
}

function helpItem(req: FastifyRequest, i: DiscoveryItem, now: number): SafeHtml {
  const open = Object.values(i.openRoles).reduce((a, b) => a + b, 0);
  return html`<li class="item"><a href="/requests/${i.id}"><b>${i.summary}</b></a><br>
<span class="tag">${categoryLabel(i.category)}</span> <span class="muted">${i.areaLabel ?? 'Approximate area'} · ${i.distance !== null ? distanceBand(i.distance) : ''} · ${TIMING_LABEL.get(i.timing ?? '') ?? 'Flexible'} · ${open} helper${open === 1 ? '' : 's'} needed · ${when(req, i.createdAt, now)}</span></li>`;
}

function emergencyItem(req: FastifyRequest, i: DiscoveryItem, now: number): SafeHtml {
  const open = Object.entries(i.openRoles).filter(([, n]) => n > 0).map(([r]) => EMERGENCY_ROLES[r as keyof typeof EMERGENCY_ROLES]?.short ?? r);
  return html`<li class="item item-emergency"><a href="/emergency/${i.id}"><b>${INCIDENT_LABEL.get(i.incidentType ?? '') ?? 'Emergency'}</b></a><br>
<span class="muted">${i.remoteOnly ? 'Outside your area (call task only)' : html`${i.areaLabel ?? 'Location given as an address'}${i.distance !== null ? ` · ${distanceBand(i.distance)}` : ''}`} · received ${when(req, i.createdAt, now)}</span><br>
${open.length ? html`Needs: ${open.map((o) => html`<span class="tag tag-emergency">${o}</span> `)}` : html`<span class="muted">All tasks taken; check whether progress has been reported.</span>`}
${i.possibleDuplicate ? html`<br><span class="tag">possibly the same incident as another report</span>` : ''}</li>`;
}

