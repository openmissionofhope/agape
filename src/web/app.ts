import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { fileURLToPath } from 'node:url';
import { type Ctx, DomainError } from '../domain/core.js';
import type { Senders } from '../domain/notifications.js';
import { unreadCount } from '../domain/notifications.js';
import { type User, sessionUser } from '../domain/users.js';
import { hmac, newToken, safeEqual } from '../lib/crypto.js';
import { html } from '../lib/html.js';
import { accountRoutes } from './routes/account.js';
import { emergencyRoutes } from './routes/emergency.js';
import { helpRoutes } from './routes/help.js';
import { inboxRoutes } from './routes/inbox.js';
import { moderationRoutes } from './routes/moderation.js';
import { publicRoutes } from './routes/public.js';
import { volunteerRoutes } from './routes/volunteer.js';
import { isValidTimeZone, render } from './ui.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    sessionHash: string | null;
    csrf: string;
    tz: string;
    unread: number;
    clientIp: string;
  }
}

export interface AppDeps {
  ctx: Ctx;
  senders: Senders;
}

const SESSION_COOKIE = 'agape_session';
const CSRF_COOKIE = 'agape_csrf';

/** Paths whose URLs carry a secret and must never be logged. */
const redactUrl = (url: string): string => url.replace(/^\/r\/[^/?#]+/, '/r/[redacted]').replace(/\?.*$/, '');

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { ctx } = deps;
  const app = Fastify({
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 64 * 1024,
    logger: ctx.config.env === 'test' ? false : {
      level: ctx.config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      serializers: {
        // No query strings, no IP addresses, no tokens.
        req: (req: { method: string; url: string; routeOptions?: { url?: string } }) => ({ method: req.method, url: redactUrl(req.url), route: req.routeOptions?.url }),
      },
    },
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.org'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: ctx.config.production ? [] : null,
      },
    },
    // Same-origin only: other sites never learn which page linked to them, and our own
    // form posts still carry an Origin header.
    referrerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: ctx.config.production ? { maxAge: 31536000, includeSubDomains: false } : false,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Runs before our own onRequest hook, so it derives the address itself.
    keyGenerator: (req) => clientIpOf(req, ctx.config.trustProxy),
    allowList: (req) => req.url.startsWith('/static/'),
    errorResponseBuilder: () => ({ statusCode: 429, error: 'Too Many Requests', message: 'Too many requests. If this is an emergency, call 911.' }),
  });
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../../public/', import.meta.url)),
    prefix: '/static/',
    maxAge: ctx.config.production ? '1d' : 0,
    index: false,
  });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionHash', null);
  app.decorateRequest('csrf', '');
  app.decorateRequest('tz', 'UTC');
  app.decorateRequest('unread', 0);
  app.decorateRequest('clientIp', '');

  app.addHook('onRequest', async (req, reply) => {
    req.clientIp = clientIpOf(req, ctx.config.trustProxy);
    if (req.url.startsWith('/static/')) return;
    const s = sessionUser(ctx, req.cookies[SESSION_COOKIE]);
    if (s && s.user.status === 'active') {
      req.user = s.user;
      req.sessionHash = s.sessionHash;
      req.unread = unreadCount(ctx, s.user.id);
    } else if (s) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    }
    let csrfCookie = req.cookies[CSRF_COOKIE];
    if (!csrfCookie || csrfCookie.length < 20 || csrfCookie.length > 100) {
      csrfCookie = newToken();
      reply.setCookie(CSRF_COOKIE, csrfCookie, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.config.secureCookies, maxAge: 365 * 24 * 3600 });
      req.cookies[CSRF_COOKIE] = '';
    }
    req.csrf = hmac(ctx.config.secret, 'csrf', csrfCookie);
    const tz = req.cookies.tz;
    if (tz && isValidTimeZone(tz)) req.tz = tz;
    reply.header('Cache-Control', 'no-store');
    reply.header('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  });

  // Cross-site request forgery: same-origin check on every state-changing request,
  // plus a token bound to a per-browser cookie.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    // Browsers send "Origin: null" in some privacy modes; treat it as absent and rely on the token.
    const origin = req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : undefined;
    const site = req.headers['sec-fetch-site'];
    const originOk = typeof origin === 'string' && ctx.config.allowedOrigins.has(origin);
    if ((typeof origin === 'string' && !originOk) || site === 'cross-site' || site === 'same-site') return forbidden(req, reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sent = typeof body._csrf === 'string' ? body._csrf : typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '';
    const cookieOk = !!req.cookies[CSRF_COOKIE] && safeEqual(sent, req.csrf);
    // The emergency form must work even when the browser refused our cookie.
    const emergencyCreate = req.routeOptions.url === '/emergency' && (originOk || (site === 'same-origin' && origin === undefined));
    if (!cookieOk && !emergencyCreate) return forbidden(req, reply);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      return render(req, reply, { title: 'Something needs attention', body: errorBody(err.message, req) }, err.status);
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err: { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined } }, 'unhandled error');
    const message = status === 429 ? 'Too many requests. Please wait a minute.' : status === 413 ? 'That was too large to send.' : status < 500 ? 'The request could not be understood.' : 'Something went wrong on our side. It has been logged.';
    return render(req, reply, { title: 'Error', body: errorBody(message, req) }, status);
  });

  app.setNotFoundHandler((req, reply) => render(req, reply, {
    title: 'Not found', body: html`<h1>Not found</h1><p>That page does not exist.</p><p><a href="/">Go to the Agape home page</a></p>`,
  }, 404));

  const routeDeps = { ctx, senders: deps.senders, sessionCookie: SESSION_COOKIE };
  await app.register(async (s) => publicRoutes(s, routeDeps));
  await app.register(async (s) => accountRoutes(s, routeDeps));
  await app.register(async (s) => helpRoutes(s, routeDeps));
  await app.register(async (s) => volunteerRoutes(s, routeDeps));
  await app.register(async (s) => emergencyRoutes(s, routeDeps));
  await app.register(async (s) => inboxRoutes(s, routeDeps));
  await app.register(async (s) => moderationRoutes(s, routeDeps));
  return app;
}

/** Fly.io's edge sets Fly-Client-IP; elsewhere we use the socket (or X-Forwarded-For when trusted). */
function clientIpOf(req: FastifyRequest, trustProxy: boolean): string {
  const fly = req.headers['fly-client-ip'];
  return (trustProxy && typeof fly === 'string' && fly ? fly : req.ip) || 'unknown';
}

export type RouteDeps = { ctx: Ctx; senders: Senders; sessionCookie: string };

function errorBody(message: string, req: FastifyRequest) {
  const back = req.method === 'POST' ? html`<p>Use your browser’s Back button to return to the form. <a href="/">Home</a></p>` : html`<p><a href="/">Home</a></p>`;
  return html`<h1>Something needs attention</h1><p class="lead">${message}</p>${back}`;
}

function forbidden(req: FastifyRequest, reply: FastifyReply) {
  return render(req, reply, {
    title: 'Please try again',
    body: html`<h1>Please try again</h1><p class="lead">This form expired or came from another site, so nothing was sent. Reload the page and submit it again.</p>
<p><strong>If this is an emergency, call 911 now.</strong></p><p><a href="/">Home</a></p>`,
  }, 403);
}

/** Requires a signed-in, active account; otherwise sends the person to sign in. */
export function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
  if (req.user) return req.user;
  const next = req.method === 'GET' ? req.url.replace(/\?.*$/, '') : '/';
  reply.redirect(`/login?next=${encodeURIComponent(next)}`, 303);
  return null;
}
