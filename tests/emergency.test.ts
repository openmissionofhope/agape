import { beforeEach, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/domain/maintenance.js';
import { processDeliveries } from '../src/domain/notifications.js';
import { Client, type Env, flashOf, location, setup, text } from './helpers.js';

let env: Env;

const BANNED_WORDING = [/help is on the way/i, /ambulance (is )?dispatched/i, /help has been dispatched/i, /units? (are|is) on (the|their) way/i, /911 (has been|was) (called|contacted)(?! \(by me)/i];

function assertHonestWording(body: string) {
  const t = text(body);
  for (const re of BANNED_WORDING) {
    // The requester's own button label "911 has been called (by me or someone here)" is the only allowed form.
    const cleaned = t.replace(/911 has been called \(by me or someone here\)/g, '').replace(/The requester reports that 911 has been called\./g, '')
      .replace(/not confirmation that 911 was called/g, '');
    expect(cleaned, `page must not say ${re}`).not.toMatch(re);
  }
}

async function responder(name: string, roles: string[], fields: Record<string, string | string[]> = {}, ip?: string) {
  const c = new Client(env, ip ?? `192.0.2.${Math.floor(Math.random() * 200) + 20}`);
  await c.signUp(name);
  await c.volunteer({ emergency_opt_in: 'yes', emergency_roles: roles, ...fields });
  return c;
}

async function sendEmergency(c: Client, fields: Record<string, string | string[]> = {}, headers: Record<string, string> = {}) {
  return c.post('/emergency', {
    needs: ['call_911'], at_incident: 'yes', location_text: '400 W Main St, Durham NC — in front of the library', zip: '27701',
    incident_type: 'collapsed', details: 'Older man collapsed, breathing unclear', callback_phone: '(919) 555-0142', idempotency_key: `key${Math.random().toString(36).slice(2)}0000000000`,
    ...fields,
  }, { headers });
}

function idFrom(res: { headers: Record<string, unknown> }): string {
  return String(res.headers.location).split('/').pop()!;
}

beforeEach(async () => {
  env = await setup();
});

describe('emergency availability', () => {
  it('keeps the direct call visible but refuses submissions when emergency mode is off', async () => {
    env = await setup({ AGAPE_EMERGENCY_MODE: 'off' });
    const guest = new Client(env);
    const page = await guest.get('/emergency');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('href="tel:911"');
    expect(text(page.body)).toContain('Emergency volunteer requests are not available right now');
    const formPage = await guest.get('/emergency/new?need=cpr');
    expect(formPage.statusCode).toBe(503);
    expect(formPage.body).not.toContain('data-emergency-form');
    expect(formPage.body).toContain('href="tel:911"');
    const res = await sendEmergency(guest);
    expect(res.statusCode).toBe(503);
    expect(env.db.prepare("SELECT count(*) FROM requests WHERE kind = 'emergency'").pluck().get()).toBe(0);
  });

  it('shows pilot limitations plainly, including that nobody may respond', async () => {
    const page = await new Client(env).get('/emergency/new?need=call_911');
    const t = text(page.body);
    expect(t).toContain('Pilot service — no guarantee anyone will respond');
    expect(t).toContain('No emergency volunteers are registered yet');
    expect(t).toContain('Agape is not an emergency service');
    expect(t).toContain('United States only');
    expect(t).toContain('Sending this does not contact 911');
  });

  it('does not infer the emergency number from browser language', async () => {
    const page = await new Client(env).get('/emergency', { 'accept-language': 'fr-FR,fr;q=0.9' });
    expect(page.body).toContain('tel:911');
    expect(text(page.body)).toContain('United States only');
    const outside = await new Client(env).get('/emergency/outside-us');
    expect(text(outside.body)).toContain('does not yet have verified emergency information');
    expect(outside.body).not.toMatch(/tel:(112|999|000)/);
  });

  it('can be paused by a moderator without hiding the call action', async () => {
    const mod = new Client(env);
    const { email } = await mod.signUp('Mona');
    env.db.prepare("UPDATE users SET role = 'moderator' WHERE email = ?").run(email);
    expect((await mod.post('/mod/emergency/pause', { reason: 'alert delivery under repair' })).statusCode).toBe(303);
    const guest = new Client(env);
    const page = await guest.get('/emergency');
    expect(text(page.body)).toContain('paused by moderators: alert delivery under repair');
    expect(page.body).toContain('tel:911');
    expect((await sendEmergency(guest)).statusCode).toBe(503);
  });
});

describe('guest emergency request', () => {
  it('needs no account and confirms only server receipt', async () => {
    const guest = new Client(env);
    const res = await sendEmergency(guest);
    expect(res.statusCode).toBe(303);
    const id = idFrom(res);
    const page = await guest.get(`/emergency/${id}`);
    expect(page.statusCode).toBe(200);
    const t = text(page.body);
    expect(t).toContain('Received by Agape');
    expect(t).toContain('No one has reported contacting 911 yet');
    expect(t).toContain('No volunteer has accepted this yet');
    expect(t).toContain('No volunteers were alerted');
    expect(page.body).toContain('tel:911');
    expect(t).toContain('This page does not refresh by itself');
    expect(page.body).not.toMatch(/http-equiv="refresh"/i);
    assertHonestWording(page.body);
    // The recovery link is shown to the requester, and the URL itself carries no details.
    expect(page.body).toMatch(/\/r\/[A-Za-z0-9_-]{40,}/);
    expect(location(res)).not.toMatch(/Main|919|collapsed/);
  });

  it('works when the browser refused the CSRF cookie, if the request is same-origin', async () => {
    const guest = new Client(env);
    const res = await guest.app.inject({
      method: 'POST', url: '/emergency', remoteAddress: '192.0.2.250',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:8080' },
      payload: new URLSearchParams({ needs: 'call_911', location_text: 'Corner of 5th and Elm, Durham NC' }).toString(),
    });
    expect(res.statusCode).toBe(303);
    // But not from another site.
    const evil = await guest.app.inject({
      method: 'POST', url: '/emergency', remoteAddress: '192.0.2.251',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      payload: new URLSearchParams({ needs: 'call_911', location_text: 'Corner of 5th and Elm, Durham NC' }).toString(),
    });
    expect(evil.statusCode).toBe(403);
  });

  it('returns JSON with explicit outcome for the enhanced form', async () => {
    const guest = new Client(env);
    const ok = await sendEmergency(guest, {}, { accept: 'application/json' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, url: expect.stringMatching(/^\/emergency\//) });
    const bad = await sendEmergency(new Client(env, '192.0.2.99'), { location_text: '', zip: '' }, { accept: 'application/json' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ ok: false, message: expect.stringContaining('where the emergency is') });
  });

  it('requires a location, and keeps what was typed when it is missing', async () => {
    const res = await sendEmergency(new Client(env), { location_text: '', zip: '', details: 'Please hurry' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Tell us where the emergency is');
    expect(res.body).toContain('Please hurry');
  });
});

describe('geolocation', () => {
  it('accepts a manual address when geolocation is denied (no coordinates)', async () => {
    const res = await sendEmergency(new Client(env), { zip: '' });
    expect(res.statusCode).toBe(303);
    const row = env.db.prepare('SELECT exact_lat, approx_lat, approx_source, address_text FROM requests WHERE id = ?').get(idFrom(res)) as Record<string, unknown>;
    expect(row).toMatchObject({ exact_lat: null, approx_lat: null, approx_source: 'none' });
    expect(row.address_text).toContain('400 W Main St');
  });

  it('stores timestamp and accuracy, and flags imprecise readings to helpers', async () => {
    const helper = await responder('Cal', ['call_911']);
    const captured = env.clock.now() - 30_000;
    const res = await sendEmergency(new Client(env), { lat: '35.99412', lng: '-78.89862', accuracy: '3200', captured_at: String(captured) });
    const id = idFrom(res);
    const row = env.db.prepare('SELECT exact_lat, exact_accuracy_m, exact_captured_at, approx_source FROM requests WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ exact_lat: 35.99412, exact_accuracy_m: 3200, exact_captured_at: captured, approx_source: 'device' });
    await helper.post(`/emergency/${id}/claim`, { role: 'call_911' });
    const page = text((await helper.get(`/emergency/${id}`)).body);
    expect(page).toContain('accurate to about 3200 m');
    expect(page).toContain('(imprecise)');
    expect(page).toContain('400 W Main St'); // the typed address is shown first
  });

  it('ignores invalid coordinates and never uses a device location when the requester is elsewhere', async () => {
    const bad = await sendEmergency(new Client(env, '192.0.2.31'), { lat: '999', lng: '-78.9', zip: '' });
    expect(env.db.prepare('SELECT exact_lat FROM requests WHERE id = ?').pluck().get(idFrom(bad))).toBeNull();
    const away = await sendEmergency(new Client(env, '192.0.2.32'), { at_incident: 'no', lat: '40.7128', lng: '-74.0060', zip: '27701' });
    const row = env.db.prepare('SELECT exact_lat, approx_source, incident_at_requester FROM requests WHERE id = ?').get(idFrom(away)) as Record<string, unknown>;
    expect(row).toMatchObject({ exact_lat: null, approx_source: 'zip', incident_at_requester: 0 });
  });

  it('lets the requester correct the location afterwards', async () => {
    const guest = new Client(env);
    const helper = await responder('Cal', ['call_911']);
    const id = idFrom(await sendEmergency(guest));
    await helper.post(`/emergency/${id}/claim`, { role: 'call_911' });
    expect((await guest.post(`/emergency/${id}/location`, { location_text: '410 W Main St, Durham NC (side door)' })).statusCode).toBe(303);
    const page = text((await helper.get(`/emergency/${id}`)).body);
    expect(page).toContain('410 W Main St, Durham NC (side door)');
    expect(page).toContain('The requester corrected the incident location');
    expect(text((await helper.get('/inbox')).body)).toContain('corrected the location');
  });
});

describe('independent emergency roles and milestones', () => {
  it('lets call, CPR and AED be claimed independently by different volunteers', async () => {
    const caller = await responder('Cal', ['call_911']);
    const cpr = await responder('Pat', ['cpr']);
    const aed = await responder('Ada', ['aed']);
    const guest = new Client(env);
    const id = idFrom(await sendEmergency(guest, { needs: ['call_911', 'cpr', 'aed'] }));

    expect((await caller.post(`/emergency/${id}/claim`, { role: 'call_911' })).statusCode).toBe(303);
    // Claiming the call task does not suppress the other roles.
    const cprView = await cpr.get(`/emergency/${id}`);
    expect(text(cprView.body)).toContain('Accept: Go to the location to help with CPR');
    expect((await cpr.post(`/emergency/${id}/claim`, { role: 'cpr' })).statusCode).toBe(303);
    expect((await aed.post(`/emergency/${id}/claim`, { role: 'aed' })).statusCode).toBe(303);
    const roles = env.db.prepare("SELECT role FROM claims WHERE request_id = ? AND status = 'active' ORDER BY role").pluck().all(id);
    expect(roles).toEqual(['aed', 'call_911', 'cpr']);
    // A second CPR helper can join (two CPR slots).
    const cpr2 = await responder('Quinn', ['cpr']);
    expect((await cpr2.post(`/emergency/${id}/claim`, { role: 'cpr' })).statusCode).toBe(303);
    expect(env.db.prepare("SELECT count(*) FROM claims WHERE request_id = ? AND role = 'cpr' AND status = 'active'").pluck().get(id)).toBe(2);
    // Volunteers cannot take roles they did not offer.
    await aed.post(`/emergency/${id}/claim`, { role: 'call_911' });
    expect(flashOf(aed)).toContain('have not offered');

    // CPR and AED helpers see attributed, scoped guidance with sources, not improvised instructions.
    const cprPage = text((await cpr.get(`/emergency/${id}`)).body);
    expect(cprPage).toContain('Hands-Only CPR (no breaths) for bystanders who see a teen or adult suddenly collapse');
    expect(cprPage).toContain('infants and children');
    expect(cprPage).toContain('Source: American Heart Association');
    const aedPage = text((await aed.get(`/emergency/${id}`)).body);
    expect(aedPage).toContain('turn it on and follow its voice prompts');
    expect(aedPage).toContain('aged 8 or older who weigh more than 55 pounds');
  });

  it('tracks accepted, contacted, relayed and dispatcher instructions separately with attribution', async () => {
    const caller = await responder('Cal', ['call_911']);
    const guest = new Client(env);
    const id = idFrom(await sendEmergency(guest));
    await caller.post(`/emergency/${id}/claim`, { role: 'call_911' });

    let page = text((await guest.get(`/emergency/${id}`)).body);
    expect(page).toContain('Accepted by Cal');
    expect(page).toContain('Accepting the task is not confirmation that 911 was called');
    expect(page).toContain('No one has reported contacting 911 yet');
    assertHonestWording((await guest.get(`/emergency/${id}`)).body);

    const claimId = env.db.prepare("SELECT id FROM claims WHERE request_id = ? AND status = 'active'").pluck().get(id) as string;
    env.clock.advance(40_000);
    await caller.post(`/emergency/claims/${claimId}/milestone`, { type: 'ems_contacted' });
    env.clock.advance(20_000);
    await caller.post(`/emergency/claims/${claimId}/milestone`, { type: 'location_relayed' });
    env.clock.advance(20_000);
    await caller.post(`/emergency/claims/${claimId}/milestone`, { type: 'dispatcher_instructions', body: 'Lay him flat and start chest compressions' });
    await caller.post(`/emergency/claims/${claimId}/milestone`, { type: 'dispatch_info', body: 'Dispatcher said a unit has been assigned' });
    // Instructions without text are refused.
    await caller.post(`/emergency/claims/${claimId}/milestone`, { type: 'dispatcher_instructions', body: '' });
    expect(flashOf(caller)).toContain('Write what the dispatcher said');

    const types = env.db.prepare('SELECT type, actor_label, created_at FROM request_events WHERE request_id = ? ORDER BY id').all(id) as { type: string; actor_label: string; created_at: number }[];
    expect(types.map((t) => t.type)).toEqual(['received', 'role_accepted', 'ems_contacted', 'location_relayed', 'dispatcher_instructions', 'dispatch_info']);
    expect(new Set(types.map((t) => t.created_at)).size).toBeGreaterThanOrEqual(4);
    expect(types.filter((t) => t.type !== 'received').every((t) => t.actor_label === 'Cal')).toBe(true);

    page = text((await guest.get(`/emergency/${id}`)).body);
    expect(page).toContain('Volunteer reports contacting 911');
    expect(page).toContain('reported by Cal');
    expect(page).toContain('Lay him flat and start chest compressions');
    expect(page).toContain('Dispatcher instructions relayed by the volunteer');
    expect(page).toContain('(as reported by the volunteer; not confirmed by Agape or 911)');
    expect(page).toContain('A volunteer reports contacting 911');
    expect(page).toContain('Agape cannot confirm this');
    assertHonestWording((await guest.get(`/emergency/${id}`)).body);
  });
});

describe('volunteer cancellation, disappearance and reassignment', () => {
  it('surfaces an unconfirmed call task, re-alerts others and allows a takeover; never auto-closes', async () => {
    const first = await responder('Cal', ['call_911']);
    const second = await responder('Dee', ['call_911']);
    const guest = new Client(env);
    const id = idFrom(await sendEmergency(guest));
    await first.post(`/emergency/${id}/claim`, { role: 'call_911' });

    // Before the confirmation window, nobody else can take it.
    await second.post(`/emergency/${id}/claim`, { role: 'call_911' });
    expect(flashOf(second)).toContain('already taken');

    env.clock.advance(4 * 60_000);
    const page = text((await guest.get(`/emergency/${id}`)).body);
    expect(page).toContain('Not confirmed');
    expect(page).toContain('has not reported contacting 911');
    expect(page).toContain('If you can, call 911 yourself');

    const out = runMaintenance(env.ctx);
    expect(out.unconfirmed).toBe(1);
    expect(runMaintenance(env.ctx).unconfirmed).toBe(0); // recorded once
    expect(env.db.prepare("SELECT count(*) FROM notifications WHERE request_id = ? AND type = 'emergency_reassign'").pluck().get(id)).toBe(1);

    const secondView = text((await second.get(`/emergency/${id}`)).body);
    expect(secondView).toContain('Take over');
    expect((await second.post(`/emergency/${id}/claim`, { role: 'call_911' })).statusCode).toBe(303);
    const claims = env.db.prepare('SELECT status, end_reason FROM claims WHERE request_id = ? ORDER BY created_at').all(id) as { status: string; end_reason: string | null }[];
    expect(claims.map((c) => c.status)).toEqual(['lapsed', 'active']);
    expect(text((await first.get('/inbox')).body)).toContain('Another volunteer has taken over');

    // Days pass; the requester never comes back. The emergency is not closed.
    env.clock.advance(3 * 24 * 3600_000);
    runMaintenance(env.ctx);
    expect(env.db.prepare('SELECT status FROM requests WHERE id = ?').pluck().get(id)).toBe('open');
    const mod = new Client(env);
    const { email } = await mod.signUp('Mona');
    env.db.prepare("UPDATE users SET role = 'moderator' WHERE email = ?").run(email);
    expect(text((await mod.get('/mod/emergencies')).body)).toContain('stale: no activity for over 2 hours');
  });

  it('lets the requester ask for another volunteer at any time', async () => {
    const first = await responder('Cal', ['call_911']);
    const second = await responder('Dee', ['call_911']);
    const guest = new Client(env);
    const id = idFrom(await sendEmergency(guest));
    await first.post(`/emergency/${id}/claim`, { role: 'call_911' });
    expect((await guest.post(`/emergency/${id}/reassign`, { role: 'call_911' })).statusCode).toBe(303);
    expect(env.db.prepare("SELECT status FROM claims WHERE request_id = ?").pluck().get(id)).toBe('lapsed');
    expect((await second.post(`/emergency/${id}/claim`, { role: 'call_911' })).statusCode).toBe(303);
    expect(text((await second.get('/inbox')).body)).toContain('Emergency assistance requested');
  });

  it('reopens and re-alerts when a volunteer releases a task', async () => {
    const first = await responder('Ada', ['aed']);
    const second = await responder('Abe', ['aed']);
    const guest = new Client(env);
    const id = idFrom(await sendEmergency(guest, { needs: ['aed'] }));
    await first.post(`/emergency/${id}/claim`, { role: 'aed' });
    const claimId = env.db.prepare("SELECT id FROM claims WHERE request_id = ? AND status = 'active'").pluck().get(id) as string;
    await first.post(`/emergency/claims/${claimId}/milestone`, { type: 'aed_unavailable', body: 'Gym was locked' });
    expect(env.db.prepare('SELECT status FROM claims WHERE id = ?').pluck().get(claimId)).toBe('released');
    expect(env.db.prepare("SELECT count(*) FROM notifications WHERE request_id = ? AND type = 'emergency_reassign' AND user_id = (SELECT id FROM users WHERE display_name = 'Abe')").pluck().get(id)).toBe(1);
    expect((await second.post(`/emergency/${id}/claim`, { role: 'aed' })).statusCode).toBe(303);
  });

  it('closes only when the requester or a moderator closes it, and tells helpers', async () => {
    const caller = await responder('Cal', ['call_911']);
    const guest = new Client(env);
    const id = idFrom(await sendEmergency(guest));
    await caller.post(`/emergency/${id}/claim`, { role: 'call_911' });
    expect((await guest.post(`/emergency/${id}/close`, { reason: 'help_arrived' })).statusCode).toBe(303);
    const r = env.db.prepare('SELECT status, close_reason, closed_by_kind FROM requests WHERE id = ?').get(id);
    expect(r).toEqual({ status: 'closed', close_reason: 'Help has arrived', closed_by_kind: 'requester' });
    expect(text((await caller.get('/inbox')).body)).toContain('closed (by the requester): Help has arrived');
  });
});

describe('connectivity, battery and duplicates', () => {
  it('a retry after a lost response returns the same request instead of a duplicate', async () => {
    const guest = new Client(env);
    const key = 'retrykey-0123456789abcdef';
    const first = await sendEmergency(guest, { idempotency_key: key });
    // The response was lost: the browser never got the cookie. It sends again.
    const sameDeviceNoCookie = new Client(env);
    const retry = await sendEmergency(sameDeviceNoCookie, { idempotency_key: key });
    expect(idFrom(retry)).toBe(idFrom(first));
    expect(env.db.prepare("SELECT count(*) FROM requests WHERE kind = 'emergency'").pluck().get()).toBe(1);
    // The retry restores access to the request.
    expect((await sameDeviceNoCookie.get(`/emergency/${idFrom(first)}`)).statusCode).toBe(200);
  });

  it('keeps working for helpers after the requester disconnects (dead battery)', async () => {
    const caller = await responder('Cal', ['call_911']);
    const guest = new Client(env);
    const id = idFrom(await sendEmergency(guest, { callback_phone: '' , details: 'My phone is at 2%, someone collapsed next to me' }));
    // The requester never loads the page again.
    await caller.post(`/emergency/${id}/claim`, { role: 'call_911' });
    env.clock.advance(30 * 60_000);
    const page = text((await caller.get(`/emergency/${id}`)).body);
    expect(page).toContain('400 W Main St');
    expect(page).toContain('My phone is at 2%');
    expect(page).toContain('None given');
    runMaintenance(env.ctx);
    expect(env.db.prepare('SELECT status FROM requests WHERE id = ?').pluck().get(id)).toBe('open');
  });

  it('flags possible duplicates and rate-limits repeated submissions from one connection', async () => {
    const guest = new Client(env, '192.0.2.77');
    const a = idFrom(await sendEmergency(guest));
    const b = idFrom(await sendEmergency(guest));
    expect(env.db.prepare('SELECT possible_duplicate_of FROM requests WHERE id = ?').pluck().get(b)).toBe(a);
    await sendEmergency(guest);
    const fourth = await sendEmergency(guest);
    expect(fourth.statusCode).toBe(429);
    expect(text(fourth.body)).toContain('If this is a real emergency, call 911 now');
    expect(fourth.body).toContain('tel:911');
    // A different connection is not affected.
    expect((await sendEmergency(new Client(env, '192.0.2.78'))).statusCode).toBe(303);
  });

  it('flags a nearby report from another connection as a possible duplicate', async () => {
    const a = idFrom(await sendEmergency(new Client(env, '192.0.2.81'), { lat: '35.99412', lng: '-78.89862', accuracy: '10' }));
    const b = idFrom(await sendEmergency(new Client(env, '192.0.2.82'), { lat: '35.99430', lng: '-78.89850', accuracy: '10' }));
    expect(env.db.prepare('SELECT possible_duplicate_of FROM requests WHERE id = ?').pluck().get(b)).toBe(a);
  });

  it('silently refuses bot submissions that fill the hidden field', async () => {
    const res = await sendEmergency(new Client(env), { website: 'http://spam.example' });
    expect(res.statusCode).toBe(400);
    expect(env.db.prepare("SELECT count(*) FROM requests WHERE kind = 'emergency'").pluck().get()).toBe(0);
  });
});

describe('remote caller in another jurisdiction', () => {
  it('explains that 911 reaches the caller’s own area and gives the exact incident address', async () => {
    // Volunteer lives in San Francisco; the emergency is in Durham, NC.
    const remote = await responder('Remy', ['call_911'], { zip: '94103', remote_call_ok: 'yes' });
    const guest = new Client(env);
    const id = idFrom(await sendEmergency(guest));
    const list = text((await remote.get('/discover')).body);
    expect(list).toContain('Outside your area (call task only)');
    await remote.post(`/emergency/${id}/claim`, { role: 'call_911' });
    const page = text((await remote.get(`/emergency/${id}`)).body);
    expect(page).toContain('You are probably in a different 911 area');
    expect(page).toContain('connects you to the 911 center for where you are, not where the emergency is');
    expect(page).toContain('10-digit emergency number for law enforcement in the community where help is needed');
    expect(page).toContain('Agape cannot route, connect or transfer your call');
    expect(page).toContain('The emergency is at another location: 400 W Main St, Durham NC — in front of the library');
    expect(page).toContain('callback number (919) 555-0142');
    // The helper's own area is never presented as the incident location.
    expect(page).not.toContain('94103');
    expect(page).toContain('Source: National 911 Program');
  });

  it('does not alert remote volunteers for on-scene roles', async () => {
    const remoteCpr = await responder('Remy', ['cpr', 'call_911'], { zip: '94103', remote_call_ok: 'yes' });
    const id = idFrom(await sendEmergency(new Client(env), { needs: ['cpr'] }));
    expect(env.db.prepare('SELECT count(*) FROM notifications WHERE request_id = ?').pluck().get(id)).toBe(0);
    expect(text((await remoteCpr.get('/discover')).body)).not.toContain('Someone collapsed');
  });
});

describe('access to emergency details', () => {
  it('restricts address, details and callback number to the requester, task holders and moderators', async () => {
    const caller = await responder('Cal', ['call_911']);
    const bystander = await responder('Ben', ['cpr']);
    const plain = new Client(env, '192.0.2.150');
    await plain.signUp('Nora');
    const guest = new Client(env);
    const id = idFrom(await sendEmergency(guest, { needs: ['call_911', 'cpr'] }));

    expect((await new Client(env, '192.0.2.151').get(`/emergency/${id}`)).statusCode).toBe(404);
    expect((await plain.get(`/emergency/${id}`)).statusCode).toBe(404);
    expect((await new Client(env).get('/r/not-a-real-token')).statusCode).toBe(404);
    expect((await new Client(env, '192.0.2.152').post(`/emergency/${id}/close`, { reason: 'mistake' })).statusCode).toBe(404);

    // An emergency volunteer who has not accepted sees approximate information only.
    const preview = await bystander.get(`/emergency/${id}`);
    expect(preview.statusCode).toBe(200);
    expect(preview.body).not.toContain('400 W Main St');
    expect(preview.body).not.toContain('555-0142');
    expect(preview.body).not.toContain('breathing unclear');

    await caller.post(`/emergency/${id}/claim`, { role: 'call_911' });
    const full = await caller.get(`/emergency/${id}`);
    expect(full.body).toContain('400 W Main St');
    expect(full.body).toContain('555-0142');
    expect(env.db.prepare("SELECT count(*) FROM access_log WHERE request_id = ? AND reason = 'emergency task'").pluck().get(id)).toBe(1);

    // The recovery link opens the request on another device.
    const link = /\/r\/([A-Za-z0-9_-]+)/.exec((await guest.get(`/emergency/${id}`)).body)![1]!;
    const otherDevice = new Client(env, '192.0.2.160');
    const r = await otherDevice.get(`/r/${link}`);
    expect(location(r)).toBe(`/emergency/${id}`);
    expect(text((await otherDevice.get(`/emergency/${id}`)).body)).toContain('Your emergency request');
  });

  it('requires accounts to be old enough before taking emergency tasks', async () => {
    env = await setup({ AGAPE_EMERGENCY_RESPONDER_MIN_ACCOUNT_AGE_HOURS: '24' });
    const fresh = await responder('Newt', ['call_911']);
    const id = idFrom(await sendEmergency(new Client(env)));
    await fresh.post(`/emergency/${id}/claim`, { role: 'call_911' });
    expect(flashOf(fresh)).toContain('New accounts can take emergency tasks after 24 hours');
    env.clock.advance(25 * 3600_000);
    expect((await fresh.post(`/emergency/${id}/claim`, { role: 'call_911' })).statusCode).toBe(303);
    expect(env.db.prepare("SELECT count(*) FROM claims WHERE request_id = ? AND status = 'active'").pluck().get(id)).toBe(1);
  });
});

describe('alerts and abuse', () => {
  it('alerts matching volunteers with push previews that contain no details', async () => {
    const caller = await responder('Cal', ['call_911']);
    await caller.postJson('/push/subscribe', { endpoint: 'https://push.example.org/abc', keys: { p256dh: 'p'.repeat(60), auth: 'a'.repeat(20) } });
    const guest = new Client(env);
    const id = idFrom(await sendEmergency(guest));
    await processDeliveries(env.ctx, env.senders);
    expect(env.push.sent).toHaveLength(1);
    const payload = env.push.sent[0]!.payload;
    expect(env.push.sent[0]!.urgent).toBe(true);
    for (const secret of ['400 W Main', '555-0142', 'collapsed', 'breathing', 'Durham', id]) expect(payload).not.toContain(secret);
    const page = text((await guest.get(`/emergency/${id}`)).body);
    expect(page).toContain('1 volunteer was alerted');
    expect(page).toContain('1 alert was accepted by a push or email service');
    expect(page).toContain('do not mean anyone has seen them');
  });

  it('lets volunteers report a malicious emergency and moderators remove it', async () => {
    const caller = await responder('Cal', ['call_911']);
    const mod = new Client(env, '192.0.2.200');
    const { email } = await mod.signUp('Mona');
    env.db.prepare("UPDATE users SET role = 'moderator' WHERE email = ?").run(email);
    const guest = new Client(env, '192.0.2.201');
    const id = idFrom(await sendEmergency(guest));
    await caller.post(`/emergency/${id}/claim`, { role: 'call_911' });
    expect((await caller.post('/report', { target_kind: 'request', target_id: id, reason: 'malicious_emergency', details: 'Nobody there', next: '/discover' })).statusCode).toBe(303);
    expect(text((await mod.get('/mod/reports')).body)).toContain('Fake or malicious emergency');
    expect(text((await mod.get('/inbox')).body)).toContain('New report to review: Fake or malicious emergency');
    expect((await mod.post(`/mod/emergencies/${id}/malicious`, { note: 'Prank; caller confirmed nobody at the address' })).statusCode).toBe(303);
    expect(env.db.prepare('SELECT status FROM requests WHERE id = ?').pluck().get(id)).toBe('removed');
    expect(text((await caller.get('/inbox')).body)).toContain('removed by a moderator');
    // The requester's link no longer works and the connection is blocked from new emergency requests today.
    expect((await guest.get(`/emergency/${id}`)).statusCode).toBe(404);
    expect((await sendEmergency(guest)).statusCode).toBe(429);
    const auditRow = env.db.prepare("SELECT action FROM audit_log WHERE target_id = ?").pluck().get(id);
    expect(auditRow).toBe('emergency.mark_malicious');
  });
});
