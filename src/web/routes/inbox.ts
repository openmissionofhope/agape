import type { FastifyInstance } from 'fastify';
import { DomainError } from '../../domain/core.js';
import { addPushSubscription, inbox, markAllRead, notify, openNotification, removePushSubscription, retryFailedDeliveries } from '../../domain/notifications.js';
import { getRequest } from '../../domain/requests.js';
import { html } from '../../lib/html.js';
import { type RouteDeps, requireUser } from '../app.js';
import { flash, postButton, render, when } from '../ui.js';

const CHANNEL: Record<string, string> = { webpush: 'Push', email: 'Email' };
const STATUS: Record<string, string> = {
  pending: 'sending', sent: 'accepted by the delivery service', failed: 'failed', gave_up: 'could not be delivered',
};

export async function inboxRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { ctx } = deps;

  app.get('/inbox', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const items = inbox(ctx, user);
    const now = ctx.clock.now();
    const failed = items.filter((i) => i.deliveries.some((d) => d.status === 'failed' || d.status === 'gave_up')).length;
    return render(req, reply, {
      title: 'Inbox',
      body: html`<h1>Inbox</h1>
<p class="hint">Every notification is kept here, even when a push or email could not be delivered. Push and email messages never contain details; open Agape to see them.</p>
${failed ? html`<div class="card card-warn" role="alert"><p><b>${failed} notification${failed === 1 ? '' : 's'} could not be delivered to your devices.</b> Check your <a href="/account">notification settings</a>.</p>
${postButton(req, '/inbox/retry', 'Try delivering again', { cls: 'btn btn-small' })}</div>` : ''}
${items.length ? html`${postButton(req, '/inbox/read-all', 'Mark all as read', { cls: 'btn btn-small' })}
<ul class="list">${items.map((i) => html`<li class="${i.read_at ? '' : 'unread'}${i.urgent ? ' urgent' : ''}"><a href="/inbox/${i.id}">${i.text}</a><br>
<span class="muted">${when(req, i.created_at, now)}${i.deliveries.length ? html` · ${i.deliveries.map((d) => `${CHANNEL[d.channel]}: ${STATUS[d.status]}${d.status !== 'sent' && d.last_error ? ` (${d.last_error})` : ''}`).join('; ')}` : ' · in Agape only'}</span></li>`)}</ul>`
    : html`<p>No notifications yet.</p>`}`,
    });
  });

  app.get<{ Params: { id: string } }>('/inbox/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    try {
      const n = openNotification(ctx, user, req.params.id);
      const r = n.request_id ? getRequest(ctx, n.request_id) : null;
      if (!r) return reply.redirect('/inbox', 303);
      return reply.redirect(r.kind === 'emergency' ? `/emergency/${r.id}` : `/requests/${r.id}`, 303);
    } catch (err) {
      if (err instanceof DomainError) return reply.redirect('/inbox', 303);
      throw err;
    }
  });

  app.post('/inbox/read-all', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    markAllRead(ctx, user);
    return reply.redirect('/inbox', 303);
  });

  app.post('/inbox/retry', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const n = retryFailedDeliveries(ctx, user.id);
    flash(reply, 'ok', n ? `Trying ${n} deliveries again. Urgent alerts are not resent, because they would arrive too late to help.` : 'Nothing to resend. Urgent alerts are not resent, because they would arrive too late to help.');
    return reply.redirect('/inbox', 303);
  });

  app.post('/push/subscribe', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false, message: 'Sign in first.' });
    if (!ctx.config.push) return reply.code(503).send({ ok: false, message: 'Push notifications are not configured on this server.' });
    try {
      addPushSubscription(ctx, req.user, req.body as Parameters<typeof addPushSubscription>[2]);
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof DomainError) return reply.code(err.status).send({ ok: false, message: err.message });
      throw err;
    }
  });

  app.post('/push/test', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false, message: 'Sign in first.' });
    notify(ctx, [req.user.id], { type: 'test', text: 'This is a test notification you asked for. If you saw it as a push notification, push works on that device.' });
    return reply.send({ ok: true, message: 'A test notification is on its way. Check this device, and see its delivery status in your inbox.' });
  });

  app.post<{ Params: { id: string } }>('/push/:id/remove', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    removePushSubscription(ctx, user, req.params.id);
    flash(reply, 'ok', 'Device removed.');
    return reply.redirect('/account', 303);
  });
}
