import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { isUniqueViolation, migrate, openDatabase } from '../src/db/index.js';
import type { Ctx } from '../src/domain/core.js';
import { claimHelp, createHelpRequest, insertClaim } from '../src/domain/requests.js';
import { signUp } from '../src/domain/users.js';
import { ManualClock } from '../src/lib/clock.js';
import { Client, setup } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('simultaneous claims', () => {
  it('lets exactly one of ten concurrent volunteers take a single slot', async () => {
    const env = await setup();
    const requester = new Client(env, '198.51.100.1');
    await requester.signUp('Requester');
    const res = await requester.post('/help', { category: 'transportation', summary: 'Ride to the clinic', zip: '27701', helpers: '1' });
    const id = String(res.headers.location).split('/').pop()!;
    const volunteers = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const c = new Client(env, `198.51.100.${10 + i}`);
      await c.signUp(`Volunteer ${i}`);
      await c.volunteer();
      return c;
    }));
    const results = await Promise.all(volunteers.map((v) => v.post(`/requests/${id}/claim`, { role: 'driver' })));
    expect(results.every((r) => r.statusCode === 303)).toBe(true);
    const active = env.db.prepare("SELECT count(*) FROM claims WHERE request_id = ? AND status IN ('active', 'done')").pluck().get(id);
    expect(active).toBe(1);
    const events = env.db.prepare("SELECT count(*) FROM request_events WHERE request_id = ? AND type = 'claimed'").pluck().get(id);
    expect(events).toBe(1);
  });

  it('is enforced by the database even when two processes race past the application check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agape-race-'));
    dirs.push(dir);
    const path = join(dir, 'race.db');
    const config = loadConfig({ NODE_ENV: 'test', AGAPE_SECRET: 'x'.repeat(40) });
    const clock = new ManualClock();
    const a: Ctx = { db: openDatabase(path), clock, config };
    migrate(a.db);
    const b: Ctx = { db: openDatabase(path), clock, config };

    const { user: req } = await signUp(a, { email: 'r@example.org', password: 'long enough pw', displayName: 'R', adult: 'yes', guidelines: 'yes' });
    const { user: v1 } = await signUp(a, { email: 'v1@example.org', password: 'long enough pw', displayName: 'V1', adult: 'yes', guidelines: 'yes' });
    const { user: v2 } = await signUp(a, { email: 'v2@example.org', password: 'long enough pw', displayName: 'V2', adult: 'yes', guidelines: 'yes' });
    const r = createHelpRequest(a, req, { category: 'food', summary: 'A meal', zip: '27701' });
    const slot = a.db.prepare('SELECT id FROM request_slots WHERE request_id = ?').pluck().get(r.id) as string;

    // Both connections saw the slot as open; both try to insert directly.
    a.db.prepare("INSERT INTO claims (id, slot_id, request_id, role, volunteer_id, status, created_at) VALUES ('c1', ?, ?, 'helper', ?, 'active', 0)").run(slot, r.id, v1.id);
    let err: unknown = null;
    try {
      b.db.prepare("INSERT INTO claims (id, slot_id, request_id, role, volunteer_id, status, created_at) VALUES ('c2', ?, ?, 'helper', ?, 'active', 0)").run(slot, r.id, v2.id);
    } catch (e) {
      err = e;
    }
    expect(isUniqueViolation(err)).toBe(true);

    // Through the domain function, the loser gets a clear conflict and nothing changes.
    expect(() => claimHelp(b, v2, r.id)).toThrow(/already taken|just taken/);
    expect(() => insertClaim(b, r.id, 'helper', v2.id)).toThrow(/already taken|just taken/);
    expect(b.db.prepare("SELECT volunteer_id FROM claims WHERE status = 'active'").pluck().all()).toEqual([v1.id]);
    a.db.close();
    b.db.close();
  });
});
