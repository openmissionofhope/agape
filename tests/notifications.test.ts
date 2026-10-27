import { beforeEach, describe, expect, it } from 'vitest';
import { notify, processDeliveries, retryFailedDeliveries } from '../src/domain/notifications.js';
import { Client, type Env, setup, text } from './helpers.js';

let env: Env;
let user: Client;
let userId: string;

beforeEach(async () => {
  env = await setup();
  user = new Client(env);
  userId = (await user.signUp('Una')).id;
  const res = await user.postJson('/push/subscribe', { endpoint: 'https://push.example.org/device-1', keys: { p256dh: 'k'.repeat(65), auth: 'a'.repeat(16) }, label: 'Phone' });
  expect(res.statusCode).toBe(200);
});

const deliveries = () => env.db.prepare('SELECT status, attempts, last_error, next_attempt_at FROM deliveries').all() as { status: string; attempts: number; last_error: string | null; next_attempt_at: number }[];

describe('notification delivery', () => {
  it('keeps the in-app notification and retries transient failures with backoff', async () => {
    notify(env.ctx, [userId], { type: 'help_message', text: 'New message about “Groceries”.' });
    env.push.failures.push({ ok: false, permanent: false, error: 'push service answered HTTP 503' });
    await processDeliveries(env.ctx, env.senders);
    expect(deliveries()[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'push service answered HTTP 503' });
    // Not retried before the backoff delay.
    await processDeliveries(env.ctx, env.senders);
    expect(env.push.sent).toHaveLength(0);
    env.clock.advance(31_000);
    await processDeliveries(env.ctx, env.senders);
    expect(deliveries()[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect(env.push.sent).toHaveLength(1);
    expect(text((await user.get('/inbox')).body)).toContain('Push: accepted by the delivery service');
  });

  it('gives up after the maximum attempts, says so in the inbox, and lets the person retry', async () => {
    notify(env.ctx, [userId], { type: 'help_claimed', text: 'Hal offered to help.' });
    for (let i = 0; i < 5; i++) env.push.failures.push({ ok: false, permanent: false, error: 'timeout' });
    for (let i = 0; i < 6; i++) {
      await processDeliveries(env.ctx, env.senders);
      env.clock.advance(2 * 3600_000);
    }
    // Five attempts; the notification expired after a day at the latest.
    const d = deliveries()[0]!;
    expect(d.status).toBe('gave_up');
    const inbox = text((await user.get('/inbox')).body);
    expect(inbox).toContain('Hal offered to help.');
    expect(inbox).toContain('could not be delivered');
    expect(inbox).toContain('Try delivering again');
    expect(retryFailedDeliveries(env.ctx, userId)).toBe(1);
    await processDeliveries(env.ctx, env.senders);
    expect(deliveries()[0]!.status).toBe('sent');
  });

  it('disables a device the push service reports as gone, and tells the person', async () => {
    notify(env.ctx, [userId], { type: 'help_claimed', text: 'Someone offered to help.' });
    env.push.failures.push({ ok: false, permanent: true, error: 'push service answered HTTP 410' });
    await processDeliveries(env.ctx, env.senders);
    expect(deliveries()[0]!.status).toBe('failed');
    const sub = env.db.prepare('SELECT disabled_at, disabled_reason FROM push_subscriptions').get() as { disabled_at: number | null; disabled_reason: string };
    expect(sub.disabled_at).not.toBeNull();
    expect(text((await user.get('/account')).body)).toContain('stopped working');
    // New notifications are not queued for a dead device, but still reach the inbox.
    notify(env.ctx, [userId], { type: 'help_claimed', text: 'Another offer.' });
    expect(deliveries()).toHaveLength(1);
    expect(text((await user.get('/inbox')).body)).toContain('Another offer.');
  });

  it('does not resend urgent alerts late, and expires undelivered ones', async () => {
    notify(env.ctx, [userId], { type: 'emergency_new', text: 'Emergency assistance requested.', urgent: true });
    env.push.failures.push({ ok: false, permanent: false, error: 'timeout' }, { ok: false, permanent: false, error: 'timeout' }, { ok: false, permanent: false, error: 'timeout' });
    await processDeliveries(env.ctx, env.senders);
    env.clock.advance(20_000);
    await processDeliveries(env.ctx, env.senders);
    env.clock.advance(50_000);
    await processDeliveries(env.ctx, env.senders);
    expect(deliveries()[0]!.status).toBe('gave_up');
    expect(retryFailedDeliveries(env.ctx, userId)).toBe(0);
  });

  it('reports channels as not configured instead of pretending to send', async () => {
    const bare = await setup({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '' });
    const c = new Client(bare);
    await c.signUp('Bo');
    const status = text((await c.get('/status')).body);
    expect(status).toContain('Push notifications Not configured on this server.');
    expect(status).toContain('Email notifications Not configured on this server.');
    expect(status).toContain('Text-message (SMS) alerts Not offered.');
    const res = await c.postJson('/push/subscribe', { endpoint: 'https://push.example.org/x', keys: { p256dh: 'x', auth: 'y' } });
    expect(res.statusCode).toBe(503);
  });

  it('rejects malformed push subscriptions', async () => {
    const res = await user.postJson('/push/subscribe', { endpoint: 'http://insecure.example', keys: { p256dh: 'x', auth: 'y' } });
    expect(res.statusCode).toBe(400);
  });
});
