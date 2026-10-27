import type { FastifyReply, FastifyRequest } from 'fastify';
import { CATEGORY_BY_KEY } from '../content/categories.js';
import { DEFAULT_JURISDICTION, JURISDICTIONS, SOURCES } from '../content/emergency.js';
import type { User } from '../domain/users.js';
import { type SafeHtml, html, raw } from '../lib/html.js';

export const SITE = {
  name: 'OMH Agape',
  tagline: 'Help freely asked. Help freely given.',
  repo: 'https://github.com/openmissionofhope/agape',
};

export interface PageOptions {
  title: string;
  body: SafeHtml;
  /** Public pages may be indexed; everything else is noindex. */
  indexable?: boolean;
  /** Minimal page for emergencies: no navigation chrome, no extra assets. */
  lite?: boolean;
  scripts?: string[];
  styles?: string[];
  description?: string;
}

export function render(req: FastifyRequest, reply: FastifyReply, opts: PageOptions, status = 200): FastifyReply {
  const flash = req.cookies.agape_flash;
  if (flash) reply.clearCookie('agape_flash', { path: '/' });
  if (!opts.indexable) reply.header('X-Robots-Tag', 'noindex, nofollow');
  const page = layout(req, opts, flash ? decodeFlash(flash) : null);
  return reply.code(status).type('text/html; charset=utf-8').send(page.value);
}

function decodeFlash(v: string): { kind: 'ok' | 'error'; text: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as { k: string; t: string };
    return { kind: parsed.k === 'error' ? 'error' : 'ok', text: String(parsed.t).slice(0, 400) };
  } catch {
    return null;
  }
}

export function flash(reply: FastifyReply, kind: 'ok' | 'error', text: string): void {
  reply.setCookie('agape_flash', Buffer.from(JSON.stringify({ k: kind, t: text })).toString('base64url'), { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 });
}

function layout(req: FastifyRequest, o: PageOptions, f: { kind: 'ok' | 'error'; text: string } | null): SafeHtml {
  const user = req.user;
  const j = JURISDICTIONS[DEFAULT_JURISDICTION]!;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} · ${SITE.name}</title>
<meta name="description" content="${o.description ?? `${SITE.name}: voluntary, person-to-person help from Open Mission of Hope. ${SITE.tagline}`}">
${o.indexable ? '' : raw('<meta name="robots" content="noindex, nofollow">')}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#184f95">
<link rel="icon" href="/static/img/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/static/styles.css">
${(o.styles ?? []).map((s) => html`<link rel="stylesheet" href="${s}">`)}
<script src="/static/js/common.js" defer></script>
${o.lite ? '' : raw('<script src="/static/js/app.js" defer></script>')}
${(o.scripts ?? []).map((s) => html`<script src="${s}" defer></script>`)}
</head>
<body class="${o.lite ? 'lite' : ''}">
<a class="skip" href="#main">Skip to content</a>
<div class="callbar" role="region" aria-label="Emergency call">
  <span>Emergency? Don’t wait for a volunteer.</span>
  <a class="callbar-btn" href="${j.dialHref}">Call ${j.emergencyNumber}</a>
</div>
${o.lite ? '' : html`<header class="site">
  <a class="brand" href="/"><img class="brand-mark" src="/static/img/favicon.svg" alt="" width="36" height="36"><span><b>Agape</b><small>Open Mission of Hope</small></span></a>
  <nav aria-label="Main">
    <a href="/help">I need help</a>
    <a href="/volunteer">I can help</a>
    <a href="/emergency" class="nav-emergency">Emergency</a>
    ${user ? html`<a href="/inbox">Inbox${req.unread ? html` <span class="badge" aria-label="${req.unread} unread">${req.unread}</span>` : ''}</a>
    <a href="/account">Account</a>` : html`<a href="/login">Sign in</a>`}
    ${user && (user.role === 'moderator' || user.role === 'admin') ? html`<a href="/mod">Moderation</a>` : ''}
  </nav>
</header>`}
<main id="main" tabindex="-1">
${f ? html`<div class="flash flash-${f.kind}" role="${f.kind === 'error' ? 'alert' : 'status'}">${f.text}</div>` : ''}
${o.body}
</main>
${o.lite ? html`<footer class="site lite-footer"><a href="/">Agape home</a> · <a href="/emergency/guidance">Emergency guidance and sources</a></footer>` : html`<footer class="site">
  <p class="tagline">${SITE.tagline}</p>
  <p>Agape is a service of <a href="https://openmissionofhope.org">Open Mission of Hope</a>. Help here is voluntary and unpaid; no one owes anyone anything.</p>
  <p><a href="/about">About</a> · <a href="/safety">Safety</a> · <a href="/privacy">Privacy</a> · <a href="/status">Service status</a> · <a href="/emergency/guidance">Emergency sources</a> · <a href="${SITE.repo}">Source code</a></p>
</footer>`}
</body>
</html>`;
}

export function csrfField(req: FastifyRequest): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${req.csrf}">`;
}

export function postButton(req: FastifyRequest, action: string, label: string, opts: { cls?: string; confirm?: string; fields?: Record<string, string> } = {}): SafeHtml {
  return html`<form method="post" action="${action}" class="inline"${opts.confirm ? html` data-confirm="${opts.confirm}"` : ''}>
${csrfField(req)}${Object.entries(opts.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<button type="submit" class="${opts.cls ?? 'btn'}">${label}</button></form>`;
}

export function errorBox(message: string | null | undefined): SafeHtml {
  return message ? html`<div class="flash flash-error" role="alert">${message}</div>` : html``;
}

const TZ_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string, withDate: boolean): Intl.DateTimeFormat {
  const key = `${tz}|${withDate}`;
  let f = TZ_CACHE.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
      ...(withDate ? { month: 'short', day: 'numeric' } : {}),
    });
    TZ_CACHE.set(key, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Absolute time in the viewer's time zone (UTC until the browser tells us), with relative time. */
export function when(req: FastifyRequest, ms: number, now: number, opts: { date?: boolean } = {}): SafeHtml {
  const d = new Date(ms);
  const withDate = opts.date ?? now - ms > 20 * 3600_000;
  return html`<time datetime="${d.toISOString()}">${formatter(req.tz, withDate).format(d)}</time> <span class="muted">(${ago(ms, now)})</span>`;
}

const DAY = new Map<string, Intl.DateTimeFormat>();

/** A calendar date in the viewer's time zone, e.g. "Oct 26, 2026". */
export function day(req: FastifyRequest, ms: number): string {
  let f = DAY.get(req.tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: req.tz, year: 'numeric', month: 'short', day: 'numeric' });
    DAY.set(req.tz, f);
  }
  return f.format(new Date(ms));
}

export function categoryLabel(key: string): string {
  if (key === 'emergency') return 'Emergency assistance';
  return CATEGORY_BY_KEY.get(key)?.label ?? key;
}

export function sourceLinks(ids: readonly string[]): SafeHtml {
  return html`<ul class="sources">${ids.map((id) => {
    const s = SOURCES[id];
    return s ? html`<li><a href="${s.url}" rel="noopener">${s.title}</a> — ${s.publisher}. Reviewed ${s.reviewedAt}.${s.note ? html` <span class="muted">${s.note}</span>` : ''}</li>` : '';
  })}</ul>`;
}

export function cite(id: string): SafeHtml {
  const s = SOURCES[id];
  return s ? html`<span class="cite">Source: <a href="${s.url}" rel="noopener">${s.publisher}</a></span>` : html``;
}

export function selfReported(): SafeHtml {
  return html`<span class="tag tag-self">self-reported</span>`;
}

export function userIsModerator(u: User | null): boolean {
  return !!u && (u.role === 'moderator' || u.role === 'admin');
}

export function pageNotFound(req: FastifyRequest, reply: FastifyReply, what = 'That page'): FastifyReply {
  return render(req, reply, {
    title: 'Not found',
    body: html`<h1>Not found</h1><p>${what} does not exist, or you do not have access to it.</p><p><a href="/">Go to the Agape home page</a></p>`,
  }, 404);
}
