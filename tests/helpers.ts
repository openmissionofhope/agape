import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/index.js';
import type { Ctx } from '../src/domain/core.js';
import type { PushTarget, SendResult, Senders } from '../src/domain/notifications.js';
import { ManualClock } from '../src/lib/clock.js';
import { hmac } from '../src/lib/crypto.js';
import { buildApp } from '../src/web/app.js';

export const ORIGIN = 'http://localhost:8080';

export interface FakePush {
  sent: { target: PushTarget; payload: string; urgent: boolean }[];
  /** Return a failure for the next calls (in order); then succeed. */
  failures: SendResult[];
}

export async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    AGAPE_SECRET: 'test-secret-test-secret-test-secret-1234',
    AGAPE_PUBLIC_URL: ORIGIN,
    AGAPE_EMERGENCY_MODE: 'pilot',
    AGAPE_EMERGENCY_RESPONDER_MIN_ACCOUNT_AGE_HOURS: '0',
    VAPID_PUBLIC_KEY: 'test-public',
    VAPID_PRIVATE_KEY: 'test-private',
    VAPID_SUBJECT: 'mailto:test@example.org',
    ...env,
  });
  const db = openDatabase(':memory:');
  migrate(db);
  const clock = new ManualClock();
  const ctx: Ctx = { db, clock, config };
  const push: FakePush = { sent: [], failures: [] };
  const senders: Senders = {
    push: config.push ? async (target, payload, opts) => {
      const f = push.failures.shift();
      if (f) return f;
      push.sent.push({ target, payload, urgent: opts.urgent });
      return { ok: true };
    } : null,
    email: null,
  };
  const app = await buildApp({ ctx, senders });
  return { app, ctx, clock, push, senders, db };
}

export type Env = Awaited<ReturnType<typeof setup>>;

interface Cookie { name: string; value: string; path: string }

/** A browser-like client: keeps cookies (respecting Path), sends Origin and the CSRF token. */
export class Client {
  cookies: Cookie[] = [];
  constructor(readonly env: Env, readonly ip = '203.0.113.10') {}

  private cookieHeader(url: string): string {
    const path = url.split('?')[0]!;
    return this.cookies.filter((c) => path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`) || c.path === '/')
      .map((c) => `${c.name}=${c.value}`).join('; ');
  }

  private store(res: LightMyRequestResponse) {
    for (const c of res.cookies as { name: string; value: string; path?: string; maxAge?: number; expires?: Date }[]) {
      const path = c.path ?? '/';
      this.cookies = this.cookies.filter((x) => !(x.name === c.name && x.path === path));
      const expired = c.maxAge === 0 || (c.expires && c.expires.getTime() < Date.now()) || c.value === '';
      if (!expired) this.cookies.push({ name: c.name, value: c.value, path });
    }
  }

  get app(): FastifyInstance {
    return this.env.app;
  }

  async get(url: string, headers: Record<string, string> = {}) {
    const res = await this.app.inject({ method: 'GET', url, remoteAddress: this.ip, headers: { cookie: this.cookieHeader(url), ...headers } });
    this.store(res);
    return res;
  }

  csrf(): string {
    const c = this.cookies.find((x) => x.name === 'agape_csrf');
    return c ? hmac(this.env.ctx.config.secret, 'csrf', c.value) : '';
  }

  async post(url: string, form: Record<string, string | string[] | undefined> = {}, opts: { csrf?: boolean; origin?: string | null; headers?: Record<string, string> } = {}) {
    if (!this.cookies.some((c) => c.name === 'agape_csrf')) await this.get('/');
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (v === undefined) continue;
      for (const item of [v].flat()) body.append(k, item);
    }
    if (opts.csrf !== false) body.append('_csrf', this.csrf());
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', cookie: this.cookieHeader(url), ...(opts.headers ?? {}) };
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    const res = await this.app.inject({ method: 'POST', url, remoteAddress: this.ip, headers, payload: body.toString() });
    this.store(res);
    return res;
  }

  async postJson(url: string, json: unknown) {
    if (!this.cookies.some((c) => c.name === 'agape_csrf')) await this.get('/');
    const res = await this.app.inject({
      method: 'POST', url, remoteAddress: this.ip,
      headers: { 'content-type': 'application/json', cookie: this.cookieHeader(url), origin: ORIGIN, 'x-csrf-token': this.csrf() },
      payload: JSON.stringify(json),
    });
    this.store(res);
    return res;
  }

  async signUp(name: string, email = `${name.toLowerCase().replace(/\W+/g, '')}@example.org`) {
    const res = await this.post('/signup', { display_name: name, email, password: 'correct horse battery', adult: 'yes', guidelines: 'yes' });
    if (res.statusCode !== 200 || !res.body.includes('recovery code')) throw new Error(`signup failed: ${res.statusCode} ${res.body.slice(0, 500)}`);
    const code = /class="code"[^>]*>([A-Z0-9-]+)</.exec(res.body)?.[1];
    const user = this.env.db.prepare('SELECT id FROM users WHERE email = ?').pluck().get(email) as string;
    return { id: user, email, recoveryCode: code! };
  }

  async volunteer(fields: Record<string, string | string[]> = {}) {
    const res = await this.post('/volunteer/profile', { available: 'yes', zip: '27701', radius_miles: '10', notify_new_requests: 'yes', ...fields });
    if (res.statusCode !== 303) throw new Error(`profile failed: ${res.statusCode} ${res.body.slice(0, 800)}`);
    return res;
  }
}

export function location(res: LightMyRequestResponse): string {
  return String(res.headers.location ?? '');
}

/** Visible text of an HTML page, for assertions about wording. */
export function text(htmlBody: string): string {
  return htmlBody.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#39;|&rsquo;/g, '’').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
}

export function flashOf(c: Client): string {
  const f = c.cookies.find((x) => x.name === 'agape_flash');
  if (!f) return '';
  try {
    return (JSON.parse(Buffer.from(f.value, 'base64url').toString('utf8')) as { t: string }).t;
  } catch {
    return '';
  }
}
