import { type Transporter, createTransport } from 'nodemailer';
import webpush from 'web-push';
import type { Config } from './config.js';
import type { SendResult, Senders } from './domain/notifications.js';

/** Real delivery channels. Each is null when not configured, and the UI says so. */
export function createSenders(config: Config): Senders {
  const push: Senders['push'] = config.push
    ? async (target, payload, opts) => {
      try {
        await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
          vapidDetails: { subject: config.push!.subject, publicKey: config.push!.publicKey, privateKey: config.push!.privateKey },
          TTL: opts.ttlSeconds,
          urgency: opts.urgent ? 'high' : 'normal',
          timeout: 10_000,
        });
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410: the subscription is gone. 400/401/403/413: it will never succeed as sent.
        const permanent = status !== undefined && [400, 401, 403, 404, 410, 413].includes(status);
        return { ok: false, permanent, error: status ? `push service answered HTTP ${status}` : (err as Error).message } satisfies SendResult;
      }
    }
    : null;

  let transport: Transporter | null = null;
  const email: Senders['email'] = config.email
    ? async (to, subject, text) => {
      transport ??= createTransport(config.email!.url);
      try {
        await transport.sendMail({ from: config.email!.from, to, subject, text });
        return { ok: true };
      } catch (err) {
        const code = (err as { responseCode?: number }).responseCode;
        return { ok: false, permanent: code !== undefined && code >= 500 && code < 600 && code !== 552, error: code ? `mail server answered ${code}` : (err as Error).message };
      }
    }
    : null;

  return { push, email };
}
