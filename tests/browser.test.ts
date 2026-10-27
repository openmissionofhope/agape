/// <reference lib="dom" />
// Real-browser checks of the emergency form's client-side behaviour. Uses an
// installed Chrome (set AGAPE_E2E_CHROME=0 to skip, or PLAYWRIGHT_CHANNEL).
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Env, setup } from './helpers.js';

const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'chrome';
const available = process.env.AGAPE_E2E_CHROME !== '0' && (channel !== 'chrome' || existsSync('/usr/bin/google-chrome') || existsSync('/Applications/Google Chrome.app'));

describe.skipIf(!available)('emergency form in a real browser', () => {
  let env: Env;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ channel });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    env = await setup();
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as AddressInfo).port;
    base = `http://localhost:${port}`;
    // The test server runs on a random port; allow it as an origin.
    env.ctx.config.allowedOrigins.add(base);
    return async () => {
      await env.app.close();
    };
  });

  const count = () => env.db.prepare("SELECT count(*) FROM requests WHERE kind = 'emergency'").pluck().get() as number;

  async function page(opts: Parameters<Browser['newContext']>[0] = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...opts });
    const p = await context.newPage();
    await p.goto(`${base}/emergency/new?need=call_911`);
    return { context, p };
  }

  it('never shows an offline request as sent', async () => {
    const { context, p } = await page();
    await p.fill('textarea[name="location_text"]', '400 W Main St, Durham NC');
    await context.setOffline(true);
    await p.click('button:has-text("Send emergency request")');
    await expect.poll(() => p.textContent('[data-send-status]')).toContain('NOT SENT');
    expect(await p.textContent('[data-send-status]')).toContain('offline');
    expect(count()).toBe(0);
    // Back online, the same form sends once.
    await context.setOffline(false);
    await p.click('button:has-text("Send emergency request")');
    await p.waitForURL(/\/emergency\/[A-Za-z0-9_-]+$/);
    expect(await p.textContent('.status-box')).toContain('Received by Agape');
    expect(count()).toBe(1);
    await context.close();
  });

  it('says "not confirmed" when the connection fails mid-send, and a retry does not duplicate', async () => {
    const { context, p } = await page();
    await p.fill('textarea[name="location_text"]', '400 W Main St, Durham NC');
    // Let the server receive the request but drop the response, like a connection lost after submission.
    let dropped = false;
    await p.route('**/emergency', async (route) => {
      if (!dropped && route.request().method() === 'POST') {
        dropped = true;
        await route.fetch();
        await route.abort('connectionfailed');
        return;
      }
      await route.continue();
    });
    await p.click('button:has-text("Send emergency request")');
    await expect.poll(() => p.textContent('[data-send-status]')).toContain('NOT CONFIRMED');
    expect(count()).toBe(1);
    await p.click('button:has-text("Send emergency request")');
    await p.waitForURL(/\/emergency\/[A-Za-z0-9_-]+$/);
    expect(count()).toBe(1);
    expect(await p.textContent('.status-box')).toContain('Received by Agape');
    await context.close();
  });

  it('shows the server’s reason when a request is refused', async () => {
    const { context, p } = await page();
    await p.click('button:has-text("Send emergency request")');
    await expect.poll(() => p.textContent('[data-send-status]')).toContain('Tell us where the emergency is');
    expect(count()).toBe(0);
    await context.close();
  });

  it('reads location once with consent, shows accuracy and time, and lets the person remove it', async () => {
    const { context, p } = await page({ geolocation: { latitude: 35.99412, longitude: -78.89862, accuracy: 25 }, permissions: ['geolocation'] });
    await p.click('button:has-text("Share my current location")');
    await expect.poll(() => p.textContent('[data-geo-status]')).toContain('accurate to about 25 m');
    expect(await p.textContent('[data-geo-status]')).toMatch(/read at/);
    expect(await p.inputValue('input[name="lat"]')).toBe('35.99412');
    // Choosing "somewhere else" removes the device location.
    await p.check('input[name="at_incident"][value="no"]');
    expect(await p.inputValue('input[name="lat"]')).toBe('');
    expect(await p.textContent('[data-geo-status]')).toContain('not at the emergency');
    await p.check('input[name="at_incident"][value="yes"]');
    await p.click('button:has-text("Share my current location")');
    await expect.poll(() => p.inputValue('input[name="lat"]')).toBe('35.99412');
    await p.click('button:has-text("Send emergency request")');
    await p.waitForURL(/\/emergency\/[A-Za-z0-9_-]+$/);
    const row = env.db.prepare("SELECT exact_lat, exact_accuracy_m FROM requests WHERE kind = 'emergency'").get();
    expect(row).toEqual({ exact_lat: 35.99412, exact_accuracy_m: 25 });
    await context.close();
  });

  it('explains a denied location permission and still accepts a typed address', async () => {
    const { context, p } = await page({ permissions: [] });
    await p.click('button:has-text("Share my current location")');
    await expect.poll(() => p.textContent('[data-geo-status]'), { timeout: 20_000 }).toMatch(/not given|could not be found|too long/);
    await p.fill('textarea[name="location_text"]', 'Bus stop at 5th and Elm, Durham NC');
    await p.click('button:has-text("Send emergency request")');
    await p.waitForURL(/\/emergency\/[A-Za-z0-9_-]+$/);
    expect(count()).toBe(1);
    await context.close();
  });

  it('works without JavaScript', async () => {
    const { context, p } = await page({ javaScriptEnabled: false });
    await p.fill('textarea[name="location_text"]', '400 W Main St, Durham NC');
    await p.click('button:has-text("Send emergency request")');
    await p.waitForURL(/\/emergency\/[A-Za-z0-9_-]+$/);
    expect(await p.textContent('.status-box')).toContain('Received by Agape');
    await context.close();
  });

  it('fits a phone screen without horizontal scrolling', async () => {
    const { context, p } = await page();
    for (const path of ['/', '/emergency', '/emergency/new?need=cpr', '/help', '/status', '/emergency/guidance']) {
      await p.goto(base + path);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    await context.close();
  });
});
