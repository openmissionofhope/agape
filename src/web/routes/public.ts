import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { POLICY } from '../../config.js';
import { CATEGORIES } from '../../content/categories.js';
import { emergencyAvailability } from '../../domain/emergencies.js';
import { html } from '../../lib/html.js';
import type { RouteDeps } from '../app.js';
import { SITE, render, when } from '../ui.js';

const SW = readFileSync(new URL('../../../public/js/sw.js', import.meta.url), 'utf8');

export function coverageBand(n: number): string {
  if (n === 0) return 'none yet';
  if (n < 10) return 'fewer than 10';
  return `about ${Math.round(n / 10) * 10}`;
}

export function volunteerCount(deps: RouteDeps): number {
  return deps.ctx.db.prepare("SELECT count(*) FROM volunteer_profiles p JOIN users u ON u.id = p.user_id WHERE p.available = 1 AND u.status = 'active'").pluck().get() as number;
}

export async function publicRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { ctx } = deps;

  app.get('/', async (req, reply) => {
    const volunteers = volunteerCount(deps);
    return render(req, reply, {
      title: 'Help freely asked. Help freely given.',
      indexable: true,
      body: html`
<section class="hero">
  <h1>Help freely asked.<br>Help freely given.</h1>
  <p class="lead">Agape connects someone who needs practical help with a person who volunteers to give it: a meal, a ride, a jump start, a place to stay tonight. Nobody pays, bids or owes anything.</p>
</section>
<nav class="choices" aria-label="What would you like to do?">
  <a class="choice" href="/help"><span class="choice-title">I need help</span><span>Ask for food, groceries, a ride, shelter, roadside help and more.</span></a>
  <a class="choice" href="/volunteer"><span class="choice-title">I can help</span><span>Offer your time to people near you, when you are able.</span></a>
  <a class="choice choice-emergency" href="/emergency"><span class="choice-title">Emergency assistance</span><span>Call 911 first. Ask someone to call for you, or for CPR or an AED nearby.</span></a>
</nav>
<section class="card">
  <h2>Honest about coverage</h2>
  <p>Agape is new. Volunteers currently available on Agape: <strong>${coverageBand(volunteers)}</strong>, across the whole United States. There may be nobody near you yet, so keep other options open: <a href="https://www.211.org/">211</a> connects you to local services.</p>
</section>
<section>
  <h2>How it works</h2>
  <ol class="steps">
    <li><b>Ask.</b> Say what you need, roughly where, and when. Your exact address stays private.</li>
    <li><b>Discover.</b> Signed-in volunteers nearby see an approximate location and a short description.</li>
    <li><b>Volunteer.</b> Someone offers to help. Only one person can take each spot.</li>
    <li><b>Coordinate.</b> You talk privately in Agape. Only now does your helper see the details you chose to share.</li>
    <li><b>Help.</b> The help happens in person, freely given.</li>
    <li><b>Confirm.</b> You confirm you were helped, and the request closes.</li>
  </ol>
</section>
<section class="card">
  <h2>Why we do this</h2>
  <p>Agape is offered by Open Mission of Hope, a Christian mission. <i>Agapē</i> is the Greek word for self-giving love. We serve because we believe every person bears God’s image and deserves dignity.</p>
  <p>Everyone is welcome, of any faith or none. No one is ever asked to pray, attend anything, listen to a message or share beliefs in order to give or receive help.</p>
</section>`,
    });
  });

  app.get('/about', async (req, reply) => render(req, reply, {
    title: 'About',
    indexable: true,
    body: html`<h1>About Agape</h1>
<p class="lead">Agape is universal, voluntary, person-to-person assistance. Someone asks for help; another person freely offers it.</p>
<h2>What Agape is</h2>
<ul>
  <li>A way to ask neighbors for practical help: ${CATEGORIES.map((c) => c.label.toLowerCase()).join(', ')}.</li>
  <li>A way to volunteer, when and where you are able.</li>
  <li>A supplement to emergency services for three bystander tasks: calling 911 for someone, CPR, and bringing an AED.</li>
</ul>
<h2>What Agape is not</h2>
<ul>
  <li>Not a job board or gig platform. There are no payments, tips, bids or ratings.</li>
  <li>Not a charity that holds money. Agape never receives, holds or transfers funds; financial help is arranged directly between people, ideally by paying a business directly.</li>
  <li>Not an emergency service, dispatch center or monitored line. If you can call 911, call 911.</li>
  <li>Not a leaderboard. We do not rank people who help or people who are helped.</li>
</ul>
<h2>Who runs it</h2>
<p>Agape is a project of <a href="https://openmissionofhope.org">Open Mission of Hope</a>. The <a href="${SITE.repo}">source code</a> is open under the Apache License 2.0.</p>
<p>Accounts are for adults (18+). Agape does not match children with strangers.</p>`,
  }));

  app.get('/safety', async (req, reply) => render(req, reply, {
    title: 'Safety and community guidelines',
    indexable: true,
    body: html`<h1>Safety and community guidelines</h1>
<h2>For everyone</h2>
<ul>
  <li>Be kind and honest. Help is a gift; nobody owes anybody anything, before or after.</li>
  <li>Meet in public places when you can, and tell someone you trust where you are going.</li>
  <li>Share your exact address only in the private conversation, and only when you are ready.</li>
  <li>You can remove a helper, block a person, or cancel a request at any time, without giving a reason.</li>
  <li>Report anything that feels wrong. Moderators review every report.</li>
</ul>
<h2>Money</h2>
<ul>
  <li>Agape never holds or moves money. Anyone asking you to pay Agape is a scammer.</li>
  <li>The safest financial help is paying a business directly (a utility, a pharmacy, a landlord with a receipt).</li>
  <li>Never share bank passwords, card PINs or one-time codes. Never send gift cards.</li>
</ul>
<h2>Skills and training</h2>
<p>Skills on a volunteer’s profile, including CPR training, are <b>self-reported</b> unless they are marked as checked by an Agape moderator, with the date and what was checked. Agape has not verified anyone’s background, driving record or qualifications unless it says so.</p>
<h2>Not allowed</h2>
<ul>
  <li>Requests or offers involving payment for services, sex, drugs, weapons or anything illegal.</li>
  <li>Harassment, threats, discrimination, or pressuring anyone about religion or anything else.</li>
  <li>Fake requests, and fake or malicious emergency reports. These are removed, and the accounts and connections involved are blocked.</li>
  <li>Collecting or publishing other people’s information.</li>
  <li>Accounts for anyone under 18.</li>
</ul>`,
  }));

  app.get('/privacy', async (req, reply) => {
    const r = POLICY.retention;
    const days = (ms: number) => `${Math.round(ms / 86_400_000)} days`;
    return render(req, reply, {
      title: 'Privacy',
      indexable: true,
      body: html`<h1>Privacy</h1>
<p class="lead">We collect as little as we can, show approximate locations in public lists, and delete sensitive details on a short schedule.</p>
<h2>Who sees what</h2>
<table class="table">
<thead><tr><th>Information</th><th>Who can see it</th></tr></thead>
<tbody>
<tr><td>Request category, short description, approximate area (about 1 km), timing</td><td>Signed-in adult volunteers near the area</td></tr>
<tr><td>Exact address or device location, private details, messages</td><td>You, the people currently helping you, and moderators handling a report. Each view by someone else is logged and shown to you.</td></tr>
<tr><td>Emergency location, callback number and details</td><td>The requester (with their private link), volunteers who accept a task on that emergency, and moderators. Never shown in public lists.</td></tr>
<tr><td>Volunteer service area</td><td>Stored only to about 1 km; never shown to others.</td></tr>
<tr><td>Your email</td><td>Only you and moderators.</td></tr>
</tbody></table>
<h2>Location</h2>
<p>Agape asks your browser for your location only when you press a button, and reads it once. It never tracks you in the background. A helper’s location is never used as the location of an incident.</p>
<h2>Notifications</h2>
<p>Push and email notifications never contain addresses, phone numbers or incident details, because lock screens and inbox previews can be seen by others.</p>
<h2>How long we keep things</h2>
<table class="table"><tbody>
<tr><td>Emergency precise location, address, callback number, details and messages</td><td>Deleted ${Math.round(r.emergencySensitiveAfterCloseMs / 3_600_000)} hours after the emergency is closed. The rest of the record (times of milestones) is deleted after ${days(r.emergencyRecordAfterCloseMs)}.</td></tr>
<tr><td>Ordinary request exact location, private details and messages</td><td>Deleted ${days(r.helpSensitiveAfterCloseMs)} after the request closes. The rest of the record is deleted after ${days(r.helpRecordAfterCloseMs)}.</td></tr>
<tr><td>Who-viewed-what log</td><td>${days(r.accessLogMs)}</td></tr>
<tr><td>Keyed hash of your connection’s IP address (used against abuse; the address itself is not stored)</td><td>${days(r.ipHashMs)}</td></tr>
<tr><td>Notifications</td><td>${days(r.notificationsMs)}</td></tr>
<tr><td>Moderation audit trail (contains no addresses or incident details)</td><td>Kept for accountability</td></tr>
</tbody></table>
<p>Records under an open report are kept until moderators finish reviewing it.</p>
<h2>What we never do</h2>
<ul><li>No advertising, analytics or tracking scripts.</li><li>No selling or sharing of data.</li><li>No search-engine indexing of requests or profiles.</li></ul>
<p>You can delete your account and its data at any time from your account page.</p>`,
    });
  });

  app.get('/status', async (req, reply) => {
    const a = emergencyAvailability(ctx);
    const beats = ctx.db.prepare('SELECT name, at FROM heartbeats').all() as { name: string; at: number }[];
    const now = ctx.clock.now();
    const beat = (n: string) => beats.find((b) => b.name === n);
    const volunteers = volunteerCount(deps);
    return render(req, reply, {
      title: 'Service status',
      indexable: true,
      body: html`<h1>Service status</h1>
<p class="lead">What works right now, stated plainly.</p>
<table class="table"><tbody>
<tr><th scope="row">Ordinary help requests</th><td>Available</td></tr>
<tr><th scope="row">Emergency volunteer requests</th><td>${a.submissionsOpen ? html`<b>Pilot</b>: open, but volunteer response is not guaranteed and not staffed around the clock.` : html`<b>Not available</b>`}
${a.reasons.length ? html`<ul>${a.reasons.map((r) => html`<li>${r}</li>`)}</ul>` : ''}</td></tr>
<tr><th scope="row">Emergency coverage area</th><td>United States only</td></tr>
<tr><th scope="row">Direct call to 911</th><td>Always shown. It uses your phone, not Agape.</td></tr>
<tr><th scope="row">In-app notifications</th><td>Available. They appear in your Agape inbox when you open Agape.</td></tr>
<tr><th scope="row">Push notifications</th><td>${a.pushConfigured ? 'Configured. Delivery depends on your browser’s push service and settings; “sent” means the push service accepted it, not that you saw it. iPhones need Agape added to the home screen.' : 'Not configured on this server.'}</td></tr>
<tr><th scope="row">Email notifications</th><td>${a.emailConfigured ? 'Configured, for people who turn them on.' : 'Not configured on this server.'}</td></tr>
<tr><th scope="row">Text-message (SMS) alerts</th><td>Not offered.</td></tr>
<tr><th scope="row">Volunteers available</th><td>${coverageBand(volunteers)} (whole US); emergency volunteers: ${coverageBand(a.responders)}</td></tr>
<tr><th scope="row">Notification worker</th><td>${beat('deliveries') ? html`last ran ${when(req, beat('deliveries')!.at, now)}` : 'has not run yet'}</td></tr>
<tr><th scope="row">Maintenance and retention</th><td>${beat('maintenance') ? html`last ran ${when(req, beat('maintenance')!.at, now)}` : 'has not run yet'}</td></tr>
</tbody></table>`,
    });
  });

  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').header('Cache-Control', 'public, max-age=3600')
    .send('User-agent: *\nAllow: /$\nAllow: /about\nAllow: /safety\nAllow: /privacy\nAllow: /status\nAllow: /emergency/guidance\nDisallow: /\n'));

  app.get('/sw.js', async (_req, reply) => reply.type('application/javascript').header('Cache-Control', 'no-cache').send(SW));

  app.get('/manifest.webmanifest', async (_req, reply) => reply.type('application/manifest+json').header('Cache-Control', 'public, max-age=3600').send({
    name: 'OMH Agape', short_name: 'Agape', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#184f95',
    description: SITE.tagline, icons: [{ src: '/static/img/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  }));

  app.get('/livez', { config: { rateLimit: false } }, async (_req, reply) => reply.type('text/plain').send('ok'));

  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      ctx.db.prepare('SELECT 1').get();
      return reply.type('text/plain').send('ready');
    } catch {
      return reply.code(503).type('text/plain').send('database unavailable');
    }
  });

  // Operational health: alert a person on 503, do not restart the machine for it.
  app.get('/healthz', { config: { rateLimit: false } }, async (_req, reply) => {
    const now = ctx.clock.now();
    const problems: string[] = [];
    let db = true;
    try {
      ctx.db.prepare('SELECT 1').get();
    } catch {
      db = false;
      problems.push('database unavailable');
    }
    const beats = db ? (ctx.db.prepare('SELECT name, at FROM heartbeats').all() as { name: string; at: number }[]) : [];
    const age = (n: string) => {
      const b = beats.find((x) => x.name === n);
      return b ? Math.round((now - b.at) / 1000) : null;
    };
    const workers = { deliveries: age('deliveries'), maintenance: age('maintenance') };
    if (ctx.config.workers) {
      if (workers.deliveries === null || workers.deliveries > 120) problems.push('notification worker is not running');
      if (workers.maintenance === null || workers.maintenance > 600) problems.push('maintenance worker is not running');
    }
    const backlog = db ? (ctx.db.prepare("SELECT count(*) FROM deliveries WHERE status = 'pending' AND next_attempt_at < ?").pluck().get(now - 300_000) as number) : 0;
    if (backlog > 0) problems.push(`${backlog} notifications overdue by more than 5 minutes`);
    const a = db ? emergencyAvailability(ctx) : null;
    return reply.code(problems.length ? 503 : 200).send({
      ok: problems.length === 0, problems, workerAgeSeconds: workers, overdueDeliveries: backlog,
      emergency: a ? { mode: a.mode, paused: !!a.paused, submissionsOpen: a.submissionsOpen } : null,
      channels: { push: !!ctx.config.push, email: !!ctx.config.email },
    });
  });
}
