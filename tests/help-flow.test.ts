import { beforeEach, describe, expect, it } from 'vitest';
import { Client, type Env, flashOf, location, setup, text } from './helpers.js';

let env: Env;
let requester: Client;
let helper: Client;

async function postRequest(c: Client, fields: Record<string, string> = {}) {
  const res = await c.post('/help', {
    category: 'groceries', summary: 'Groceries for my family this week', zip: '27701', area_label: 'East Durham', timing: 'this_week',
    helpers: '1', p_items: 'Milk, bread, rice', address_text: '12 Secret Lane, Apt 3', private_details: 'Ring twice; I use a wheelchair', ...fields,
  });
  expect(res.statusCode, res.body.slice(0, 400)).toBe(303);
  return location(res).split('/').pop()!;
}

beforeEach(async () => {
  env = await setup();
  requester = new Client(env, '203.0.113.1');
  helper = new Client(env, '203.0.113.2');
  await requester.signUp('Rita');
  await helper.signUp('Hal');
  await helper.volunteer();
});

describe('ordinary help: request → discover → volunteer → coordinate → fulfill → confirm', () => {
  it('runs the whole workflow with private details revealed only after claiming', async () => {
    const id = await postRequest(requester);

    // Discover: approximate information only.
    const list = await helper.get('/discover');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('Groceries for my family this week');
    expect(list.body).toContain('East Durham');
    expect(list.body).not.toContain('Secret Lane');

    const before = await helper.get(`/requests/${id}`);
    expect(before.body).not.toContain('Secret Lane');
    expect(before.body).not.toContain('wheelchair');
    expect(before.body).not.toContain('Milk, bread');

    // Volunteer.
    const claim = await helper.post(`/requests/${id}/claim`, { role: 'helper' });
    expect(claim.statusCode).toBe(303);
    const after = await helper.get(`/requests/${id}`);
    expect(after.body).toContain('12 Secret Lane, Apt 3');
    expect(after.body).toContain('Ring twice; I use a wheelchair');
    expect(after.body).toContain('Milk, bread, rice');

    // Requester was notified and sees the helper with self-reported labels.
    const inbox = await requester.get('/inbox');
    expect(inbox.body).toContain('Hal offered to help');
    const mine = await requester.get(`/requests/${id}`);
    expect(mine.body).toContain('Hal');

    // Coordinate privately.
    expect((await helper.post(`/requests/${id}/messages`, { body: 'I can come at 5pm' })).statusCode).toBe(303);
    expect((await requester.post(`/requests/${id}/messages`, { body: '5pm works, thank you' })).statusCode).toBe(303);
    const thread = await helper.get(`/requests/${id}`);
    expect(thread.body).toContain('I can come at 5pm');
    expect(thread.body).toContain('5pm works, thank you');

    // Fulfill and confirm.
    const claimId = env.db.prepare("SELECT id FROM claims WHERE request_id = ? AND status = 'active'").pluck().get(id) as string;
    expect((await helper.post(`/claims/${claimId}/done`)).statusCode).toBe(303);
    expect(text((await requester.get('/inbox')).body)).toContain('says they have helped');
    expect((await requester.post(`/requests/${id}/complete`)).statusCode).toBe(303);
    const done = env.db.prepare('SELECT status, closed_by_kind FROM requests WHERE id = ?').get(id) as { status: string; closed_by_kind: string };
    expect(done).toEqual({ status: 'completed', closed_by_kind: 'requester' });

    // Access to private details was logged and shown to the requester.
    const page = await requester.get(`/requests/${id}`);
    expect(page.body).toContain('Who has seen the private details');
    expect(page.body).toMatch(/Hal \(helper view\)/);

    // A closed request no longer accepts messages.
    await helper.post(`/requests/${id}/messages`, { body: 'late message' });
    expect(flashOf(helper)).toContain('closed');
  });

  it('volunteer cancellation reopens the slot and tells the requester', async () => {
    const id = await postRequest(requester);
    await helper.post(`/requests/${id}/claim`, { role: 'helper' });
    const claimId = env.db.prepare("SELECT id FROM claims WHERE request_id = ? AND status = 'active'").pluck().get(id) as string;
    expect((await helper.post(`/claims/${claimId}/release`, { reason: 'car broke down' })).statusCode).toBe(303);
    expect(text((await requester.get('/inbox')).body)).toContain('can no longer help');
    // Released helper loses access to private details.
    expect((await helper.get(`/requests/${id}`)).body).not.toContain('Secret Lane');
    // Another volunteer can take it.
    const other = new Client(env, '203.0.113.3');
    await other.signUp('Olu');
    await other.volunteer();
    expect((await other.post(`/requests/${id}/claim`, { role: 'helper' })).statusCode).toBe(303);
    expect(env.db.prepare("SELECT count(*) FROM claims WHERE request_id = ? AND status = 'active'").pluck().get(id)).toBe(1);
  });

  it('requester can remove a helper, cancel, and reopen', async () => {
    const id = await postRequest(requester);
    await helper.post(`/requests/${id}/claim`, { role: 'helper' });
    const claimId = env.db.prepare("SELECT id FROM claims WHERE request_id = ? AND status = 'active'").pluck().get(id) as string;
    expect((await requester.post(`/claims/${claimId}/remove`)).statusCode).toBe(303);
    expect(text((await helper.get('/inbox')).body)).toContain('no longer needs you');

    expect((await requester.post(`/requests/${id}/cancel`)).statusCode).toBe(303);
    expect(env.db.prepare('SELECT status FROM requests WHERE id = ?').pluck().get(id)).toBe('cancelled');
    expect((await helper.get('/discover')).body).not.toContain('Groceries for my family');

    expect((await requester.post(`/requests/${id}/reopen`)).statusCode).toBe(303);
    expect(env.db.prepare('SELECT status FROM requests WHERE id = ?').pluck().get(id)).toBe('open');
    expect((await helper.get('/discover')).body).toContain('Groceries for my family');
  });

  it('supports several helpers on one request, each taking a distinct slot', async () => {
    const id = await postRequest(requester, { category: 'practical', summary: 'Move a sofa upstairs', helpers: '2' });
    const third = new Client(env, '203.0.113.4');
    await third.signUp('Tess');
    await third.volunteer();
    const fourth = new Client(env, '203.0.113.5');
    await fourth.signUp('Fay');
    await fourth.volunteer();
    expect((await helper.post(`/requests/${id}/claim`, { role: 'helper' })).statusCode).toBe(303);
    expect((await third.post(`/requests/${id}/claim`, { role: 'helper' })).statusCode).toBe(303);
    await fourth.post(`/requests/${id}/claim`, { role: 'helper' });
    expect(flashOf(fourth)).toMatch(/already taken/);
    expect(env.db.prepare("SELECT count(DISTINCT slot_id) FROM claims WHERE request_id = ? AND status = 'active'").pluck().get(id)).toBe(2);
    // The same volunteer cannot take two slots.
    await helper.post(`/requests/${id}/claim`, { role: 'helper' });
    expect(env.db.prepare("SELECT count(*) FROM claims WHERE request_id = ? AND volunteer_id = (SELECT id FROM users WHERE display_name = 'Hal')").pluck().get(id)).toBe(1);
  });

  it('expires stale requests and never shows the requester their own request in discovery', async () => {
    const id = await postRequest(requester);
    await requester.volunteer();
    expect((await requester.get('/discover')).body).not.toContain('Groceries for my family');
    env.clock.advance(15 * 24 * 3600_000);
    const { runMaintenance } = await import('../src/domain/maintenance.js');
    runMaintenance(env.ctx);
    expect(env.db.prepare('SELECT status FROM requests WHERE id = ?').pluck().get(id)).toBe('expired');
  });

  it('keeps form input and explains the problem when validation fails', async () => {
    const res = await requester.post('/help', { category: 'food', summary: 'Dinner tonight', zip: '00000' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('We could not find that ZIP code');
    expect(res.body).toContain('value="Dinner tonight"');
  });

  it('labels financial help as never held by Agape', async () => {
    const res = await requester.get('/help/new?category=financial');
    expect(text(res.body)).toContain('Agape does not hold, transfer or guarantee money');
  });

  it('blocking removes the helper and hides requests both ways', async () => {
    const id = await postRequest(requester);
    await helper.post(`/requests/${id}/claim`, { role: 'helper' });
    const helperId = env.db.prepare("SELECT id FROM users WHERE display_name = 'Hal'").pluck().get() as string;
    expect((await requester.post(`/block/${helperId}`, { next: `/requests/${id}` })).statusCode).toBe(303);
    expect(env.db.prepare("SELECT count(*) FROM claims WHERE request_id = ? AND status = 'active'").pluck().get(id)).toBe(0);
    expect((await helper.get('/discover')).body).not.toContain('Groceries for my family');
    await helper.post(`/requests/${id}/claim`, { role: 'helper' });
    expect(flashOf(helper)).toContain('cannot help');
  });
});
