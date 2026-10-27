import { beforeEach, describe, expect, it } from 'vitest';
import { POLICY } from '../src/config.js';
import { runMaintenance } from '../src/domain/maintenance.js';
import { Client, type Env, setup } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await setup();
});

describe('retention', () => {
  it('clears emergency location, callback number and details 72 hours after closure, then deletes the record', async () => {
    const guest = new Client(env);
    const res = await guest.post('/emergency', { needs: 'call_911', location_text: '12 Oak St, Durham NC', callback_phone: '919-555-0100', details: 'Fell down the stairs', lat: '35.99', lng: '-78.9', accuracy: '12' });
    const id = String(res.headers.location).split('/').pop()!;
    await guest.post(`/emergency/${id}/update`, { body: 'He is awake now' });
    await guest.post(`/emergency/${id}/close`, { reason: 'help_arrived' });
    env.clock.advance(POLICY.retention.emergencySensitiveAfterCloseMs - 60_000);
    runMaintenance(env.ctx);
    expect(env.db.prepare('SELECT address_text FROM requests WHERE id = ?').pluck().get(id)).toBe('12 Oak St, Durham NC');
    env.clock.advance(120_000);
    runMaintenance(env.ctx);
    const row = env.db.prepare('SELECT address_text, callback_phone, incident_details, exact_lat, exact_lng, ip_hash, sensitive_purged_at FROM requests WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ address_text: null, callback_phone: null, incident_details: null, exact_lat: null, exact_lng: null, ip_hash: null });
    expect(row.sensitive_purged_at).not.toBeNull();
    expect(env.db.prepare('SELECT count(*) FROM messages WHERE request_id = ?').pluck().get(id)).toBe(0);
    // Milestone times remain until the record itself is deleted.
    expect(env.db.prepare('SELECT count(*) FROM request_events WHERE request_id = ?').pluck().get(id)).toBeGreaterThan(0);
    env.clock.advance(POLICY.retention.emergencyRecordAfterCloseMs);
    runMaintenance(env.ctx);
    expect(env.db.prepare('SELECT count(*) FROM requests WHERE id = ?').pluck().get(id)).toBe(0);
  });

  it('never purges an open emergency, however old', async () => {
    const guest = new Client(env);
    const res = await guest.post('/emergency', { needs: 'call_911', location_text: '12 Oak St, Durham NC' });
    const id = String(res.headers.location).split('/').pop()!;
    env.clock.advance(400 * 24 * 3600_000);
    runMaintenance(env.ctx);
    expect(env.db.prepare('SELECT status, address_text FROM requests WHERE id = ?').get(id)).toEqual({ status: 'open', address_text: '12 Oak St, Durham NC' });
  });

  it('keeps records that are under an open report', async () => {
    const owner = new Client(env);
    await owner.signUp('Owner');
    const res = await owner.post('/help', { category: 'food', summary: 'A meal please', zip: '27701', address_text: '3 Pine' });
    const id = String(res.headers.location).split('/').pop()!;
    const reporter = new Client(env, '203.0.113.77');
    await reporter.signUp('Rep');
    await reporter.post('/report', { target_kind: 'request', target_id: id, reason: 'spam', next: '/' });
    await owner.post(`/requests/${id}/cancel`);
    env.clock.advance(POLICY.retention.helpRecordAfterCloseMs + 1000);
    runMaintenance(env.ctx);
    expect(env.db.prepare('SELECT count(*) FROM requests WHERE id = ?').pluck().get(id)).toBe(1);
    // Sensitive fields are still cleared on schedule.
    expect(env.db.prepare('SELECT address_text FROM requests WHERE id = ?').pluck().get(id)).toBeNull();
  });

  it('stores volunteer service areas only coarsely', async () => {
    const v = new Client(env);
    await v.signUp('Vee');
    await v.post('/volunteer/profile', { available: 'yes', lat: '35.994123', lng: '-78.898765', radius_miles: '5' });
    const p = env.db.prepare('SELECT area_lat, area_lng FROM volunteer_profiles').get() as { area_lat: number; area_lng: number };
    expect(p).toEqual({ area_lat: 35.995, area_lng: -78.895 });
  });
});
