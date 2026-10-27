import { beforeEach, describe, expect, it } from 'vitest';
import { POLICY } from '../src/config.js';
import { Client, type Env, location, setup, text } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await setup();
});

async function helpRequest(c: Client) {
  const res = await c.post('/help', { category: 'shelter', summary: 'Somewhere safe tonight', zip: '27701', address_text: '9 Hidden Court', private_details: 'Leaving an abusive home' });
  return String(res.headers.location).split('/').pop()!;
}

describe('authorization', () => {
  it('sends anonymous visitors to sign in instead of showing requests', async () => {
    const owner = new Client(env);
    await owner.signUp('Owner');
    const id = await helpRequest(owner);
    const anon = new Client(env, '203.0.113.99');
    for (const path of ['/discover', `/requests/${id}`, '/discover/map', '/inbox', '/requests/mine', '/tasks']) {
      const res = await anon.get(path);
      expect(res.statusCode, path).toBe(303);
      expect(location(res)).toMatch(/^\/login/);
    }
    const json = await anon.get('/discover/map.json');
    expect(json.statusCode).toBe(401);
  });

  it('hides private details and messages from signed-in people who are not helping', async () => {
    const owner = new Client(env);
    await owner.signUp('Owner');
    const id = await helpRequest(owner);
    await owner.post(`/requests/${id}/messages`, { body: 'Door code is 4711' });
    const stranger = new Client(env, '203.0.113.50');
    await stranger.signUp('Stranger');
    await stranger.volunteer();
    const page = await stranger.get(`/requests/${id}`);
    expect(page.statusCode).toBe(200);
    for (const secret of ['Hidden Court', 'abusive', '4711']) expect(page.body).not.toContain(secret);
    // Cannot act as the requester or post into the conversation.
    await stranger.post(`/requests/${id}/cancel`);
    expect(env.db.prepare('SELECT status FROM requests WHERE id = ?').pluck().get(id)).toBe('open');
    await stranger.post(`/requests/${id}/messages`, { body: 'hello' });
    expect(env.db.prepare('SELECT count(*) FROM messages WHERE request_id = ?').pluck().get(id)).toBe(1);
  });

  it('keeps moderation pages away from members', async () => {
    const member = new Client(env);
    await member.signUp('Member');
    for (const path of ['/mod', '/mod/reports', '/mod/users', '/mod/audit', '/mod/emergencies', '/mod/deliveries']) {
      expect((await member.get(path)).statusCode, path).toBe(403);
    }
    const target = new Client(env, '203.0.113.60');
    const t = await target.signUp('Target');
    expect((await member.post(`/mod/users/${t.id}/suspend`, { hours: '24', reason: 'x' })).statusCode).toBe(403);
    expect(env.db.prepare('SELECT status FROM users WHERE id = ?').pluck().get(t.id)).toBe('active');
  });

  it('only lets administrators change roles', async () => {
    const mod = new Client(env);
    const m = await mod.signUp('Mod');
    env.db.prepare("UPDATE users SET role = 'moderator' WHERE id = ?").run(m.id);
    const other = new Client(env, '203.0.113.61');
    const o = await other.signUp('Other');
    await mod.post(`/mod/users/${o.id}/role`, { role: 'admin' });
    expect(env.db.prepare('SELECT role FROM users WHERE id = ?').pluck().get(o.id)).toBe('member');
  });

  it('accepts adults only', async () => {
    const c = new Client(env);
    const res = await c.post('/signup', { display_name: 'Kid', email: 'kid@example.org', password: 'long enough password', guidelines: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(text(res.body)).toContain('Agape accounts are for adults');
    expect(env.db.prepare('SELECT count(*) FROM users').pluck().get()).toBe(0);
  });
});

describe('request forgery and headers', () => {
  it('rejects posts without the CSRF token or from another origin', async () => {
    const c = new Client(env);
    await c.signUp('Casey');
    const noToken = await c.post('/help', { category: 'food', summary: 'A meal please', zip: '27701' }, { csrf: false });
    expect(noToken.statusCode).toBe(403);
    const crossSite = await c.post('/help', { category: 'food', summary: 'A meal please', zip: '27701' }, { origin: 'https://evil.example' });
    expect(crossSite.statusCode).toBe(403);
    const fetchMeta = await c.post('/help', { category: 'food', summary: 'A meal please', zip: '27701' }, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(fetchMeta.statusCode).toBe(403);
    expect(env.db.prepare('SELECT count(*) FROM requests').pluck().get()).toBe(0);
    expect(text(noToken.body)).toContain('If this is an emergency, call 911 now');
  });

  it('sends security headers, no-store and noindex on private pages', async () => {
    const c = new Client(env);
    await c.signUp('Casey');
    const res = await c.get('/account');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    const robots = await c.get('/robots.txt');
    expect(robots.body).toContain('Disallow: /');
    expect(robots.body).not.toContain('Allow: /requests');
    const home = await c.get('/');
    expect(home.headers['x-robots-tag']).toBeUndefined();
  });

  it('sets session cookies HttpOnly and SameSite', async () => {
    const c = new Client(env);
    const res = await c.post('/signup', { display_name: 'Cookie', email: 'cookie@example.org', password: 'long enough password', adult: 'yes', guidelines: 'yes' });
    const session = res.cookies.find((x) => x.name === 'agape_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  });

  it('only redirects to local paths after sign-in', async () => {
    const c = new Client(env);
    await c.signUp('Nina', 'nina@example.org');
    await c.post('/logout');
    const res = await c.post('/login', { email: 'nina@example.org', password: 'correct horse battery', next: 'https://evil.example/' });
    expect(location(res)).toBe('/');
    const res2 = await c.post('/login', { email: 'nina@example.org', password: 'correct horse battery', next: '//evil.example' });
    expect(location(res2)).toBe('/');
  });

  it('escapes user-written text', async () => {
    const owner = new Client(env);
    await owner.signUp('<img src=x onerror=alert(1)>');
    const res = await owner.post('/help', { category: 'food', summary: '<script>alert(1)</script> dinner', zip: '27701' });
    const page = await owner.get(location(res));
    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; dinner');
    expect(page.body).not.toContain('<img src=x');
  });
});

describe('abuse controls', () => {
  it('rate-limits discovery per account so the list cannot be scraped', async () => {
    const c = new Client(env);
    await c.signUp('Scraper');
    await c.volunteer();
    const key = env.db.prepare("SELECT id FROM users WHERE display_name = 'Scraper'").pluck().get() as string;
    const now = env.clock.now();
    const insert = env.db.prepare('INSERT INTO rate_events (key, created_at) VALUES (?, ?)');
    for (let i = 0; i < POLICY.limits.discoveryPerUserHour.count; i++) insert.run(`discover:${key}`, now);
    const res = await c.get('/discover');
    expect(res.statusCode).toBe(429);
    env.clock.advance(3600_000 + 1);
    expect((await c.get('/discover')).statusCode).toBe(200);
  });

  it('limits sign-in attempts', async () => {
    const c = new Client(env);
    await c.signUp('Lim', 'lim@example.org');
    await c.post('/logout');
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await c.post('/login', { email: 'lim@example.org', password: 'wrong password!' })).statusCode;
    expect(last).toBe(429);
  });

  it('limits how many open requests one account can hold', async () => {
    const c = new Client(env);
    await c.signUp('Many');
    for (let i = 0; i < 5; i++) expect((await c.post('/help', { category: 'food', summary: `Meal ${i} please`, zip: '27701' })).statusCode).toBe(303);
    const res = await c.post('/help', { category: 'food', summary: 'One more meal', zip: '27701' });
    expect(res.statusCode).toBe(429);
  });

  it('treats a repeated form submission as one request', async () => {
    const c = new Client(env);
    await c.signUp('Dup');
    const form = { category: 'food', summary: 'Same dinner', zip: '27701', idempotency_key: 'same-key-123456789' };
    const a = await c.post('/help', form);
    const b = await c.post('/help', form);
    expect(location(a)).toBe(location(b));
    expect(env.db.prepare('SELECT count(*) FROM requests').pluck().get()).toBe(1);
  });

  it('resets a password only with the recovery code, then rotates it', async () => {
    const c = new Client(env);
    const { email, recoveryCode } = await c.signUp('Rae', 'rae@example.org');
    const bad = await c.post('/reset', { email, code: 'AAAA-BBBB-CCCC-DDDD', password: 'brand new password' });
    expect(bad.statusCode).toBe(401);
    const ok = await c.post('/reset', { email, code: recoveryCode.toLowerCase(), password: 'brand new password' });
    expect(ok.statusCode).toBe(200);
    const again = await c.post('/reset', { email, code: recoveryCode, password: 'another password!' });
    expect(again.statusCode).toBe(401);
    expect(location(await c.post('/login', { email, password: 'brand new password' }))).toBe('/');
  });
});

describe('account deletion', () => {
  it('requires the password, cancels open requests and releases help', async () => {
    const owner = new Client(env);
    const o = await owner.signUp('Owner');
    const id = await helpRequest(owner);
    const helper = new Client(env, '203.0.113.88');
    await helper.signUp('Helper');
    await helper.volunteer();
    await helper.post(`/requests/${id}/claim`, { role: 'helper' });
    await owner.post('/account/delete', { password: 'wrong' });
    expect(env.db.prepare('SELECT count(*) FROM users WHERE id = ?').pluck().get(o.id)).toBe(1);
    expect((await owner.post('/account/delete', { password: 'correct horse battery' })).statusCode).toBe(303);
    expect(env.db.prepare('SELECT count(*) FROM users WHERE id = ?').pluck().get(o.id)).toBe(0);
    expect(env.db.prepare('SELECT status, requester_user_id FROM requests WHERE id = ?').get(id)).toEqual({ status: 'cancelled', requester_user_id: null });
    expect(env.db.prepare("SELECT action FROM audit_log WHERE action = 'user.delete_self'").pluck().get()).toBe('user.delete_self');
  });
});

describe('rate limiting', () => {
  it('counts each client separately', async () => {
    const a = new Client(env, '198.51.100.201');
    const b = new Client(env, '198.51.100.202');
    let last = 0;
    for (let i = 0; i < 301; i++) last = (await a.get('/about')).statusCode;
    expect(last).toBe(429);
    expect((await b.get('/about')).statusCode).toBe(200);
    // Static assets are not counted.
    expect((await a.get('/static/styles.css')).statusCode).toBe(200);
  });
});

