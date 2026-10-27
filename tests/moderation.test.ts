import { beforeEach, describe, expect, it } from 'vitest';
import { Client, type Env, flashOf, setup, text } from './helpers.js';

let env: Env;
let mod: Client;
let modId: string;

beforeEach(async () => {
  env = await setup();
  mod = new Client(env, '198.18.0.1');
  modId = (await mod.signUp('Mona')).id;
  env.db.prepare("UPDATE users SET role = 'moderator' WHERE id = ?").run(modId);
});

describe('moderation', () => {
  it('handles a fraud report: remove the request, suspend the account, resolve, all audited', async () => {
    const scammer = new Client(env, '198.18.0.2');
    const s = await scammer.signUp('Scam');
    const res = await scammer.post('/help', { category: 'financial', summary: 'Send gift cards now', zip: '27701' });
    const id = String(res.headers.location).split('/').pop()!;
    const reporter = new Client(env, '198.18.0.3');
    await reporter.signUp('Rory');
    await reporter.volunteer();
    expect((await reporter.post('/report', { target_kind: 'request', target_id: id, reason: 'fraud', details: 'Asked for gift cards', next: '/discover' })).statusCode).toBe(303);
    // Duplicate reports by the same person are refused politely.
    await reporter.post('/report', { target_kind: 'request', target_id: id, reason: 'fraud', next: '/discover' });

    const queue = text((await mod.get('/mod/reports')).body);
    expect(queue).toContain('Scam or fraud');
    expect(queue).toContain('Asked for gift cards');

    await mod.post(`/mod/requests/${id}/remove`, { reason: 'Gift-card scam', back: '/mod/reports' });
    await mod.post(`/mod/users/${s.id}/suspend`, { hours: '720', reason: 'Fraudulent request' });
    const reportId = env.db.prepare('SELECT id FROM reports').pluck().get() as string;
    await mod.post(`/mod/reports/${reportId}/resolve`, { outcome: 'actioned', resolution: 'Removed and suspended' });

    expect(env.db.prepare('SELECT status FROM requests WHERE id = ?').pluck().get(id)).toBe('removed');
    expect(env.db.prepare('SELECT status FROM users WHERE id = ?').pluck().get(s.id)).toBe('suspended');
    expect(env.db.prepare('SELECT status FROM reports WHERE id = ?').pluck().get(reportId)).toBe('actioned');
    // The suspended account was signed out and cannot sign back in.
    const after = await scammer.get('/requests/mine');
    expect(after.statusCode).toBe(303);
    const login = await scammer.post('/login', { email: 'scam@example.org', password: 'correct horse battery' });
    expect(text(login.body)).toContain('This account is suspended');
    expect(text(login.body)).toContain('Fraudulent request');

    const actions = env.db.prepare('SELECT action FROM audit_log ORDER BY id').pluck().all();
    expect(actions).toEqual(expect.arrayContaining(['request.remove', 'user.suspend', 'report.actioned']));
    expect(text((await mod.get('/mod/audit')).body)).toContain('user.suspend');
  });

  it('suspending a helper releases their tasks so requests reopen', async () => {
    const requester = new Client(env, '198.18.0.4');
    await requester.signUp('Req');
    const helper = new Client(env, '198.18.0.5');
    const h = await helper.signUp('Helper');
    await helper.volunteer();
    const res = await requester.post('/help', { category: 'food', summary: 'Dinner please', zip: '27701' });
    const id = String(res.headers.location).split('/').pop()!;
    await helper.post(`/requests/${id}/claim`, { role: 'helper' });
    await mod.post(`/mod/users/${h.id}/suspend`, { hours: '24', reason: 'Harassment' });
    expect(env.db.prepare("SELECT status FROM claims WHERE request_id = ?").pluck().get(id)).toBe('removed');
    // Suspension lifts on schedule.
    env.clock.advance(25 * 3600_000);
    const login = await helper.post('/login', { email: 'helper@example.org', password: 'correct horse battery' });
    expect(login.statusCode).toBe(303);
  });

  it('keeps the audit log append-only at the database level', () => {
    env.db.prepare("INSERT INTO audit_log (actor_label, action, created_at) VALUES ('x', 'test', 0)").run();
    expect(() => env.db.prepare("UPDATE audit_log SET action = 'changed'").run()).toThrow(/append-only/);
    expect(() => env.db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('hides abusive messages and records moderator views of private details', async () => {
    const requester = new Client(env, '198.18.0.6');
    await requester.signUp('Req');
    const helper = new Client(env, '198.18.0.7');
    await helper.signUp('Helper');
    await helper.volunteer();
    const res = await requester.post('/help', { category: 'food', summary: 'Dinner please', zip: '27701', address_text: '1 Elm St' });
    const id = String(res.headers.location).split('/').pop()!;
    await helper.post(`/requests/${id}/claim`, { role: 'helper' });
    await helper.post(`/requests/${id}/messages`, { body: 'abusive words here' });
    const msgId = env.db.prepare('SELECT id FROM messages').pluck().get() as string;
    await requester.post('/report', { target_kind: 'message', target_id: msgId, reason: 'harassment', next: `/requests/${id}` });
    await mod.post(`/mod/messages/${msgId}/hide`, { back: '/mod/reports' });
    const page = await requester.get(`/requests/${id}`);
    expect(page.body).not.toContain('abusive words here');
    expect(text(page.body)).toContain('Hidden by a moderator');
    const modView = await mod.get(`/requests/${id}`);
    expect(modView.body).toContain('1 Elm St');
    expect(env.db.prepare("SELECT count(*) FROM access_log WHERE request_id = ? AND reason = 'moderator view'").pluck().get(id)).toBe(1);
    expect(text((await requester.get(`/requests/${id}`)).body)).toContain('Mona (moderator view)');
  });

  it('records skill verification with what was checked; everything else stays self-reported', async () => {
    const helper = new Client(env, '198.18.0.8');
    const h = await helper.signUp('Helper');
    await helper.volunteer({ skills: ['cpr', 'vehicle'], skill_detail_cpr: 'Red Cross 2025' });
    const skillId = env.db.prepare("SELECT id FROM volunteer_skills WHERE skill = 'cpr'").pluck().get() as string;
    await mod.post(`/mod/skills/${skillId}/verify`, { note: 'Saw current Red Cross card, expires 2027-05', back: `/mod/users/${h.id}` });
    const requester = new Client(env, '198.18.0.9');
    await requester.signUp('Req');
    const res = await requester.post('/help', { category: 'roadside', summary: 'Flat tire on Main', zip: '27701' });
    const id = String(res.headers.location).split('/').pop()!;
    await helper.post(`/requests/${id}/claim`, { role: 'helper' });
    const page = text((await requester.get(`/requests/${id}`)).body);
    expect(page).toMatch(/CPR training\s+checked by a moderator/);
    expect(page).toMatch(/Has a car\s+self-reported/);
    // Re-saving the profile keeps the moderator's check.
    await helper.volunteer({ skills: ['vehicle'] });
    expect(env.db.prepare('SELECT verified_at IS NOT NULL FROM volunteer_skills WHERE id = ?').pluck().get(skillId)).toBe(1);
    expect(flashOf(helper)).toContain('Profile saved');
  });
});
