// Native Chromium touch input; run with the same Playwright setup as browser.mjs.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const temporary = await mkdtemp(join(tmpdir(), 'rasteroids-mobile-'));
const server = spawn(process.env.PYTHON || 'python3', [
  fileURLToPath(new URL('../server.py', import.meta.url)), '--port', '0', '--database', join(temporary, 'scores.sqlite3'),
], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start.')), 10000);
    server.stdout.on('data', data => {
      const match = String(data).match(/http:\/\/[^\s]+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    server.on('error', error => { clearTimeout(timeout); reject(error); });
    server.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-features=SyntheticPointerActions'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  // Use Chromium's direct WebTouch injector to release individual contacts.
  let contacts = new Map();
  const touch = async (type, points) => {
    const next = new Map(points.map(point => [point.id, point]));
    if (!points.length) {
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [] });
    } else {
      const released = [...contacts.values()].filter(point => !next.has(point.id));
      const added = points.filter(point => !contacts.has(point.id));
      const moved = points.filter(point => contacts.has(point.id) && (contacts.get(point.id).x !== point.x || contacts.get(point.id).y !== point.y));
      if (released.length) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: released });
      if (added.length) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: added });
      if (moved.length) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: moved });
    }
    contacts = next;
  };
  const point = async (id, selector) => {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `Missing touch target ${selector}`);
    return { id, x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 5, radiusY: 5, force: 1 };
  };
  const active = id => page.locator(`#touch-${id}`).getAttribute('aria-pressed');
  const noTouches = () => page.waitForFunction(() => touchPointers.size === 0);
  await page.goto(url);
  await page.getByRole('button', { name: 'CREATE YOUR PILOT' }).tap();
  const username = `mobile_${randomBytes(3).toString('hex')}`;
  await page.getByLabel('PILOT NAME', { exact: true }).fill(username);
  await page.getByLabel('PASSWORD', { exact: true }).fill('mobile integration test password');
  await page.getByRole('button', { name: 'CREATE ACCOUNT', exact: false }).tap();
  await page.locator('#pilot-name').filter({ hasText: username }).waitFor();
  await page.getByRole('button', { name: 'LAUNCH GAME' }).tap();
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(() => { ship.invincible = 60; });
  const left = await point(1, '#touch-left'), thrust = await point(2, '#touch-thrust'), fire = await point(3, '#touch-fire');
  const angle = await page.evaluate(() => ship.angle);
  await touch('touchStart', [left, thrust, fire]);
  await page.waitForTimeout(250);
  const movement = await page.evaluate(() => ({ angle: ship.angle, speed: Math.hypot(ship.vx, ship.vy), bullets: bullets.length, touches: touchPointers.size }));
  assert.ok(movement.angle < angle); assert.ok(movement.speed > 0); assert.ok(movement.bullets > 0); assert.equal(movement.touches, 3);
  assert.equal(await active('left'), 'true'); assert.equal(await active('thrust'), 'true'); assert.equal(await active('fire'), 'true');
  await touch('touchEnd', [thrust, fire]);
  await page.waitForFunction(() => document.getElementById('touch-left').getAttribute('aria-pressed') === 'false');
  assert.equal(await active('left'), 'false'); assert.equal(await active('thrust'), 'true'); assert.equal(await active('fire'), 'true');
  await touch('touchMove', [{ ...thrust, x: 5, y: 5 }, fire]);
  assert.equal(await active('thrust'), 'true');
  assert.equal(await page.evaluate(() => scrollY), 0);
  await touch('touchEnd', []); await noTouches();
  assert.equal(await active('thrust'), 'false'); assert.equal(await active('fire'), 'false');
  console.log('PASS: native three-finger steering/thrust/fire, independent release, drag outside, no gamepad scrolling.');

  const right = await point(4, '#touch-right');
  const heading = await page.evaluate(() => ship.angle);
  await touch('touchStart', [right]); await page.waitForTimeout(100); await touch('touchEnd', []);
  assert.ok(await page.evaluate(() => ship.angle) > heading);
  await touch('touchStart', [await point(5, '#touch-fire')]);
  await touch('touchCancel', []); await noTouches(); assert.equal(await active('fire'), 'false');
  await page.evaluate(() => { window.captureReady = false; document.getElementById('touch-fire').addEventListener('gotpointercapture', () => { window.captureReady = true; }, { once: true }); });
  const capturePoint = await point(6, '#touch-fire');
  await touch('touchStart', [capturePoint]);
  // Capture becomes active on the next pointer event, before it can be lost.
  await touch('touchMove', [{ ...capturePoint, x: capturePoint.x + 12 }]);
  await page.waitForFunction(() => window.captureReady);
  await page.evaluate(() => { for (const [id, {button}] of touchPointers) button.releasePointerCapture(id); });
  await touch('touchMove', [{ ...capturePoint, x: capturePoint.x + 15 }]);
  await noTouches(); await touch('touchEnd', []);

  await touch('touchStart', [await point(7, '#touch-thrust'), await point(8, '#touch-fire')]);
  const pause = await point(9, '#pause');
  await touch('touchStart', [await point(7, '#touch-thrust'), await point(8, '#touch-fire'), pause]);
  await touch('touchEnd', [await point(7, '#touch-thrust'), await point(8, '#touch-fire')]);
  await page.waitForFunction(() => state === 'paused'); await noTouches();
  assert.equal(await page.locator('#touch-fire').isDisabled(), true);
  await touch('touchEnd', []);
  await page.getByRole('button', { name: 'RESUME FLIGHT' }).tap();
  await page.waitForFunction(() => state === 'playing');
  assert.equal(await active('fire'), 'false');
  await touch('touchStart', [await point(10, '#touch-fire')]);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  await page.waitForFunction(() => state === 'paused'); await noTouches(); await touch('touchEnd', []);
  await page.getByRole('button', { name: 'RESUME FLIGHT' }).tap();
  await page.waitForFunction(() => state === 'playing');
  console.log('PASS: right rotation, touch cancellation, lost capture, pause with fingers held, background interruption, clean resume.');

  await touch('touchStart', [await point(11, '#touch-thrust')]);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
  await page.waitForFunction(() => state === 'paused'); await noTouches(); await touch('touchEnd', []);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  for (const [width, height] of [[844,390], [667,375], [568,320], [320,568], [375,667], [390,844], [412,915], [768,1024]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => scrollTo(0,0));
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, height: innerHeight, visualWidth: visualViewport.width, content: document.documentElement.scrollWidth }));
    assert.equal(dimensions.viewport, width); assert.equal(dimensions.height, height);
    assert.ok(dimensions.content <= dimensions.viewport, `Horizontal overflow at ${width}×${height}: ${JSON.stringify(dimensions)}`);
    if (width === 844) await page.screenshot({ path: '/tmp/rasteroids-mobile-landscape.png' });
    for (const selector of ['#touch-left','#touch-right','#touch-thrust','#touch-fire']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `Small target ${selector} at ${width}×${height}`);
      if (height <= 400 || width <= 412) assert.ok(box.y >= 0 && box.y + box.height <= height, `Control below fold ${selector} at ${width}×${height}: ${JSON.stringify(box)}`);
    }
  }
  console.log('PASS: rotation pauses play; eight portrait/landscape phone and tablet sizes, 44px targets, controls within phone viewport, no horizontal overflow.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'RESUME FLIGHT' }).tap();
  await page.evaluate(() => {
    window.mobileStarts = 0;
    const begin = window.rasteroidsAccount.beginRun;
    window.rasteroidsAccount.beginRun = () => { window.mobileStarts++; begin(); };
  });
  await touch('touchStart', [await point(12, '#restart')]);
  await page.waitForTimeout(1100);
  await touch('touchEnd', []);
  assert.equal(await page.evaluate(() => window.mobileStarts), 1);
  await page.waitForFunction(() => state === 'playing' && score === 0 && lives === 3);
  await page.evaluate(() => {
    ship.invincible = 60;
    const rock = makeAsteroid(ship.x, ship.y - 20, 1); rock.vx = 0; rock.vy = 0; asteroids = [rock];
  });
  await touch('touchStart', [await point(13, '#touch-fire')]);
  await page.waitForFunction(() => score === 100);
  await touch('touchEnd', []);
  // Set up the final collision; the normal animation loop ends and saves the flight.
  await page.evaluate(() => { lives = 1; ship.invincible = 0; asteroids = [makeAsteroid(ship.x, ship.y, 3)]; });
  await page.waitForFunction(() => state === 'over');
  await page.locator('#save-status').filter({ hasText: 'Flight logged' }).waitFor();
  await page.waitForFunction(() => document.getElementById('flight-count').textContent === '1');
  assert.equal(await page.locator('#personal-best').innerText(), '000100');
  await page.waitForFunction(() => document.querySelector('.score-row.mine strong')?.textContent === '000100');
  assert.equal(await page.locator('#touch-fire').isDisabled(), true);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('flight-count').textContent === '1');
  assert.equal(await page.locator('#personal-best').innerText(), '000100');
  console.log('PASS: touch-fired bullet earns real points; game-over save, leaderboard/profile, and persistence after reload.');
  await page.screenshot({ path: '/tmp/rasteroids-mobile-controls.png', fullPage: true });
  await touch('touchStart', [{ id: 20, x: 190, y: 720, radiusX: 5, radiusY: 5, force: 1 }]);
  for (const y of [680, 620, 560, 500, 440]) {
    await touch('touchMove', [{ id: 20, x: 190, y, radiusX: 5, radiusY: 5, force: 1 }]);
    await page.waitForTimeout(40);
  }
  await touch('touchEnd', []);
  await page.waitForFunction(() => scrollY > 0);
  await page.evaluate(() => scrollTo(0,0));
  console.log('PASS: normal touch scrolling still works outside the gamepad.');
  await page.screenshot({ path: '/tmp/rasteroids-mobile-controls.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: no browser JavaScript errors.');
} finally {
  await browser?.close(); server.kill();
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  await rm(temporary, { recursive: true, force: true });
}
