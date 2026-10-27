import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { POLICY } from '../../config.js';
import { DomainError, consume, hashIp } from '../../domain/core.js';
import { listPushSubscriptions } from '../../domain/notifications.js';
import { authenticate, block, createSession, deleteAccount, deleteSession, listBlocked, resetPassword, setEmailNotifications, signUp, unblock } from '../../domain/users.js';
import { html } from '../../lib/html.js';
import { type RouteDeps, requireUser } from '../app.js';
import { csrfField, day, errorBox, flash, postButton, render, when } from '../ui.js';

type Body = Record<string, string | undefined>;

/** Only same-site relative paths are accepted as a post-login destination. */
export function safeNext(v: unknown): string {
  return typeof v === 'string' && /^\/[a-zA-Z0-9/_-]*$/.test(v) && !v.startsWith('//') ? v : '/';
}

export async function accountRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { ctx } = deps;

  const setSession = (reply: FastifyReply, token: string) => reply.setCookie(deps.sessionCookie, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.config.secureCookies, maxAge: POLICY.sessionTtlMs / 1000,
  });

  const signupForm = (req: FastifyRequest, reply: FastifyReply, values: Body = {}, error: string | null = null, status = 200) => render(req, reply, {
    title: 'Create an account',
    body: html`<h1>Create an account</h1>
<p>You need an account to ask for ordinary help or to volunteer. <strong>You do not need one for emergencies</strong>: <a href="/emergency">go to emergency assistance</a> or call 911.</p>
${errorBox(error)}
<form method="post" action="/signup" class="stack">
${csrfField(req)}<input type="hidden" name="next" value="${safeNext(values.next)}">
<label>Name others will see<input name="display_name" required maxlength="60" autocomplete="nickname" value="${values.display_name ?? ''}"></label>
<label>Email<input name="email" type="email" required autocomplete="email" value="${values.email ?? ''}"></label>
<label>Password (at least 10 characters)<input name="password" type="password" required minlength="10" autocomplete="new-password"></label>
<label class="check"><input type="checkbox" name="adult" value="yes" required> I am 18 or older.</label>
<label class="check"><input type="checkbox" name="guidelines" value="yes" required> I agree to the <a href="/safety">community guidelines</a>, and I understand that skills and claims on Agape are self-reported unless marked as checked.</label>
<button class="btn btn-primary" type="submit">Create account</button>
</form>
<p>Already have an account? <a href="/login">Sign in</a>.</p>`,
  }, status);

  app.get('/signup', async (req, reply) => signupForm(req, reply, { next: (req.query as Body).next }));

  app.post('/signup', async (req, reply) => {
    const b = req.body as Body;
    try {
      if (!consume(ctx, `signup:${hashIp(ctx, req.clientIp)}`, POLICY.limits.signupPerConnection)) {
        throw new DomainError('rate_limited', 'Too many accounts have been created from this connection. Please try again later.');
      }
      const { user, recoveryCode } = await signUp(ctx, { email: b.email, password: b.password, displayName: b.display_name, adult: b.adult, guidelines: b.guidelines });
      setSession(reply, createSession(ctx, user.id));
      req.user = user;
      return render(req, reply, {
        title: 'Save your recovery code',
        body: html`<h1>Welcome, ${user.display_name}</h1>
<div class="card card-warn"><h2>Save your recovery code</h2>
<p>If you forget your password, this code is the only way to get back into your account. Write it down or save it somewhere private. It is shown only once.</p>
<p class="code" aria-label="Recovery code">${recoveryCode}</p></div>
<p><a class="btn btn-primary" href="${safeNext(b.next)}">I saved it — continue</a></p>`,
      });
    } catch (err) {
      if (err instanceof DomainError) return signupForm(req, reply, b, err.message, err.status);
      throw err;
    }
  });

  const loginForm = (req: FastifyRequest, reply: FastifyReply, values: Body = {}, error: string | null = null, status = 200) => render(req, reply, {
    title: 'Sign in',
    body: html`<h1>Sign in</h1>
<p>In an emergency you do not need to sign in: <a href="/emergency">emergency assistance</a>.</p>
${errorBox(error)}
<form method="post" action="/login" class="stack">
${csrfField(req)}<input type="hidden" name="next" value="${safeNext(values.next)}">
<label>Email<input name="email" type="email" required autocomplete="email" value="${values.email ?? ''}"></label>
<label>Password<input name="password" type="password" required autocomplete="current-password"></label>
<button class="btn btn-primary" type="submit">Sign in</button>
</form>
<p><a href="/signup">Create an account</a> · <a href="/reset">Forgot your password?</a></p>`,
  }, status);

  app.get('/login', async (req, reply) => {
    if (req.user) return reply.redirect(safeNext((req.query as Body).next), 303);
    return loginForm(req, reply, { next: (req.query as Body).next });
  });

  app.post('/login', async (req, reply) => {
    const b = req.body as Body;
    try {
      const email = (b.email ?? '').trim().toLowerCase();
      if (!consume(ctx, `login:${hashIp(ctx, req.clientIp)}`, POLICY.limits.loginPerConnection) || !consume(ctx, `login_email:${email}`, POLICY.limits.loginPerEmail)) {
        throw new DomainError('rate_limited', 'Too many sign-in attempts. Wait 15 minutes and try again.');
      }
      const user = await authenticate(ctx, b.email, b.password);
      setSession(reply, createSession(ctx, user.id));
      return reply.redirect(safeNext(b.next), 303);
    } catch (err) {
      if (err instanceof DomainError) return loginForm(req, reply, { email: b.email, next: b.next }, err.message, err.status);
      throw err;
    }
  });

  app.post('/logout', async (req, reply) => {
    if (req.sessionHash) deleteSession(ctx, req.sessionHash);
    reply.clearCookie(deps.sessionCookie, { path: '/' });
    return reply.redirect('/', 303);
  });

  const resetForm = (req: FastifyRequest, reply: FastifyReply, values: Body = {}, error: string | null = null, status = 200) => render(req, reply, {
    title: 'Reset your password',
    body: html`<h1>Reset your password</h1>
<p>Use the recovery code you saved when you created your account.</p>
${errorBox(error)}
<form method="post" action="/reset" class="stack">
${csrfField(req)}
<label>Email<input name="email" type="email" required autocomplete="email" value="${values.email ?? ''}"></label>
<label>Recovery code<input name="code" required autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX"></label>
<label>New password (at least 10 characters)<input name="password" type="password" required minlength="10" autocomplete="new-password"></label>
<button class="btn btn-primary" type="submit">Reset password</button>
</form>
<p>Lost your recovery code too? Moderators cannot see your password, but they can help: create a new account and report the problem from it.</p>`,
  }, status);

  app.get('/reset', async (req, reply) => resetForm(req, reply));

  app.post('/reset', async (req, reply) => {
    const b = req.body as Body;
    try {
      if (!consume(ctx, `login:${hashIp(ctx, req.clientIp)}`, POLICY.limits.loginPerConnection)) throw new DomainError('rate_limited', 'Too many attempts. Wait 15 minutes and try again.');
      const code = await resetPassword(ctx, b.email, b.code, b.password);
      return render(req, reply, {
        title: 'Password changed',
        body: html`<h1>Password changed</h1><p>You have been signed out everywhere. Here is your <b>new</b> recovery code; the old one no longer works.</p>
<p class="code">${code}</p><p><a class="btn btn-primary" href="/login">Sign in</a></p>`,
      });
    } catch (err) {
      if (err instanceof DomainError) return resetForm(req, reply, b, err.message, err.status);
      throw err;
    }
  });

  app.get('/account', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const devices = listPushSubscriptions(ctx, user);
    const blocked = listBlocked(ctx, user);
    const now = ctx.clock.now();
    return render(req, reply, {
      title: 'Your account',
      body: html`<h1>Your account</h1>
<p>Signed in as <b>${user.display_name}</b> (${user.email}). Member since ${day(req, user.created_at)}.</p>
<p><a class="btn" href="/requests/mine">My requests</a> <a class="btn" href="/tasks">Tasks I’m helping with</a> <a class="btn" href="/volunteer/profile">Volunteer profile</a></p>
<h2>Notifications</h2>
<p>Agape always keeps notifications in your <a href="/inbox">inbox</a>. Optional channels:</p>
<h3>Push notifications on this device</h3>
${ctx.config.push ? html`<div data-push data-key="${ctx.config.push.publicKey}" data-csrf="${req.csrf}">
<p class="muted" data-push-status>Push needs JavaScript and a browser that supports it. On iPhone, add Agape to your home screen first.</p>
<button type="button" class="btn" data-push-enable hidden>Turn on push notifications here</button>
<button type="button" class="btn" data-push-test hidden>Check this device</button>
</div>` : html`<p>Push notifications are not configured on this server.</p>`}
${devices.length ? html`<ul class="list">${devices.map((d) => html`<li>${d.label ?? 'Device'} — added ${day(req, d.created_at)};
${d.disabled_at ? html` <b>stopped working</b>: ${d.disabled_reason}` : d.last_success_at ? html` last accepted by the push service ${when(req, d.last_success_at, now)}` : ' nothing delivered yet'}
${d.consecutive_failures && !d.disabled_at ? html` (${d.consecutive_failures} recent failures)` : ''}
${postButton(req, `/push/${d.id}/remove`, 'Remove', { cls: 'btn btn-small' })}</li>`)}</ul>` : ''}
<h3>Email</h3>
${ctx.config.email ? html`<form method="post" action="/account/email" class="inline">${csrfField(req)}
<input type="hidden" name="enabled" value="${user.email_notifications ? 'no' : 'yes'}">
<p>Email notifications are <b>${user.email_notifications ? 'on' : 'off'}</b>. Emails never include addresses or details. <button class="btn btn-small" type="submit">Turn ${user.email_notifications ? 'off' : 'on'}</button></p></form>`
    : html`<p>Email notifications are not configured on this server.</p>`}
<h2>Blocked people</h2>
${blocked.length ? html`<ul class="list">${blocked.map((b) => html`<li>${b.display_name} ${postButton(req, `/block/${b.id}/remove`, 'Unblock', { cls: 'btn btn-small' })}</li>`)}</ul>` : html`<p>You have not blocked anyone.</p>`}
<h2>Sign out</h2>
${postButton(req, '/logout', 'Sign out')}
<h2>Delete your account</h2>
<details><summary>Delete my account and data</summary>
<p>Your open requests will be cancelled and any help you offered will be released, so nobody is left waiting. Your profile, skills, notifications and devices are deleted. Moderation records about your account are kept without your details.</p>
<form method="post" action="/account/delete" class="stack" data-confirm="Delete your account permanently?">${csrfField(req)}
<label>Your password<input name="password" type="password" required autocomplete="current-password"></label>
<button class="btn btn-quiet" type="submit">Delete my account</button></form></details>`,
    });
  });

  app.post('/account/delete', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    try {
      await deleteAccount(ctx, user, (req.body as Body).password);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      flash(reply, 'error', err.message);
      return reply.redirect('/account', 303);
    }
    reply.clearCookie(deps.sessionCookie, { path: '/' });
    flash(reply, 'ok', 'Your account has been deleted.');
    return reply.redirect('/', 303);
  });

  app.post('/account/email', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    setEmailNotifications(ctx, user, (req.body as Body).enabled === 'yes');
    flash(reply, 'ok', 'Email setting saved.');
    return reply.redirect('/account', 303);
  });

  app.post<{ Params: { id: string } }>('/block/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    block(ctx, user, req.params.id);
    flash(reply, 'ok', 'Blocked. You will not see each other’s requests, and any help between you has been stopped.');
    return reply.redirect(safeNext((req.body as Body).next ?? '/account'), 303);
  });

  app.post<{ Params: { id: string } }>('/block/:id/remove', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    unblock(ctx, user, req.params.id);
    flash(reply, 'ok', 'Unblocked.');
    return reply.redirect('/account', 303);
  });
}
