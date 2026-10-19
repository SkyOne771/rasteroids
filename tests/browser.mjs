// Optional browser regression: install Playwright, then node tests/browser.mjs.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'rasteroids-browser-'));
  const server = spawn(process.env.PYTHON || 'python3', [
    fileURLToPath(new URL('../server.py', import.meta.url)), '--port', '0', '--database', join(temporary, 'scores.sqlite3'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not start in time.')), 10000);
      server.stdout.on('data', data => {
        const match = String(data).match(/http:\/\/[^\s]+/);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
      server.on('error', error => { clearTimeout(timeout); reject(error); });
      server.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
      headless: true,
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByText('Uncharted territory.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'CREATE YOUR PILOT' }).click();
    await page.getByLabel('PILOT NAME', { exact: true }).fill('RetryPilot');
    await page.getByLabel('PASSWORD', { exact: true }).fill('browser test password');
    assert.equal(await page.evaluate(() => state), 'ready');
    await page.getByRole('button', { name: 'CREATE ACCOUNT', exact: false }).click();
    await page.locator('#pilot-name').filter({ hasText: 'RetryPilot' }).waitFor();
    await page.locator('#scoreboard').getByText('NO FLIGHTS YET', { exact: true }).waitFor();
    assert.match(await page.locator('#scoreboard').innerText(), /RetryPilot/);
    assert.equal(await page.locator('.score-row strong').innerText(), '—');
    await page.getByRole('button', { name: 'LAUNCH GAME' }).click();
    await page.waitForFunction(() => state === 'playing');
    if (process.env.NATURAL_GAME === '1') {
      // Exercise the complete simulation using only player input: no score/life edits.
      await page.keyboard.down('ArrowUp');
      console.log('Playing a full game; waiting for all three ships to be lost.');
      const progress = setInterval(async () => {
        console.log('Gameplay:', await page.evaluate(() => ({ state, score, lives, sector })));
      }, 15000);
      try {
        await page.waitForFunction(() => state === 'over', null, { timeout: 180000 });
      } finally { clearInterval(progress); }
      await page.keyboard.up('ArrowUp');
      const finalScore = await page.locator('#score').innerText();
      await page.locator('#save-status').filter({ hasText: 'Flight logged' }).waitFor();
      await page.waitForFunction(() => document.getElementById('flight-count').textContent === '1');
      assert.equal(await page.locator('#personal-best').innerText(), finalScore);
      assert.equal(await page.locator('.score-row strong').innerText(), finalScore);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('flight-count').textContent === '1');
      assert.equal(await page.locator('#personal-best').innerText(), finalScore);
      assert.deepEqual(errors, []);
      console.log(`PASS: full game saved ${finalScore} points; profile and scoreboard persisted after reload.`);
      return;
    }
    await page.evaluate(() => {
      score = 240; sector = 2; lives = 1; ship.invincible = 0;
      asteroids = [makeAsteroid(ship.x, ship.y, 3)]; update(.001);
    });
    await page.locator('#save-status').filter({ hasText: 'Flight logged' }).waitFor();
    await page.waitForFunction(() => document.getElementById('personal-best').textContent === '000240');
    assert.equal(await page.locator('#flight-count').innerText(), '1');
    assert.match(await page.locator('#scoreboard').innerText(), /RetryPilot/);
    await page.getByRole('button', { name: 'MY FLIGHTS', exact: true }).click();
    await page.locator('.score-row').waitFor();
    assert.match(await page.locator('#scoreboard').innerText(), /000240/);
    await page.reload();
    await page.locator('#pilot-name').filter({ hasText: 'RetryPilot' }).waitFor();
    await page.waitForFunction(() => document.getElementById('personal-best').textContent === '000240');
    await page.screenshot({ path: join(temporary, 'desktop.png'), fullPage: true });
    await page.getByRole('button', { name: 'SIGN OUT', exact: true }).click();
    await page.locator('#pilot-name').filter({ hasText: 'GUEST PILOT' }).waitFor();
    await page.getByRole('button', { name: 'LAUNCH GAME' }).click();
    await page.getByRole('button', { name: 'SIGN IN / JOIN' }).click();
    assert.equal(await page.evaluate(() => state), 'paused');
    await page.getByLabel('PILOT NAME', { exact: true }).fill('RetryPilot');
    await page.getByLabel('PASSWORD', { exact: true }).fill('wrong password here');
    await page.getByRole('button', { name: 'SIGN IN →', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor();
    await page.getByLabel('PASSWORD', { exact: true }).fill('browser test password');
    await page.getByRole('button', { name: 'SIGN IN →', exact: true }).click();
    await page.locator('#pilot-name').filter({ hasText: 'RetryPilot' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(temporary, 'mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.locator('#pilot-name').filter({ hasText: 'RetryPilot' }).waitFor();
    await page.waitForFunction(() => document.getElementById('best').textContent === '000240');
    // A delayed saved-session lookup must not silently start a guest flight.
    let releaseSession;
    const sessionBlocked = new Promise(resolve => { releaseSession = resolve; });
    await page.route('**/api/me', async route => { await sessionBlocked; await route.continue(); });
    await page.reload();
    await page.getByRole('button', { name: 'LAUNCH GAME' }).click();
    assert.equal(await page.evaluate(() => state), 'ready');
    assert.equal(await page.locator('#status').innerText(), 'CHECKING PILOT');
    // Repeated keyboard launches during the lookup should still create just one flight.
    await page.keyboard.press('Enter');
    releaseSession();
    await page.waitForFunction(() => state === 'playing');
    await page.evaluate(() => {
      score = 250; lives = 1; ship.invincible = 0;
      asteroids = [makeAsteroid(ship.x, ship.y, 3)]; update(.001);
    });
    await page.waitForFunction(() => document.getElementById('flight-count').textContent === '2');
    assert.equal(await page.locator('#personal-best').innerText(), '000250');
    await page.unroute('**/api/me');
    let offline = true;
    await page.route('**/api/scores', route => route.request().method() === 'POST' && offline ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: 'TRY AGAIN' }).click();
    await page.evaluate(() => {
      score = 300; lives = 1; ship.invincible = 0;
      asteroids = [makeAsteroid(ship.x, ship.y, 3)]; update(.001);
    });
    await page.locator('#retry-save:visible').waitFor();
    assert.match(await page.locator('#save-status').innerText(), /not saved/);
    await page.getByRole('button', { name: 'TRY AGAIN' }).click();
    await page.evaluate(() => {
      score = 400; lives = 1; ship.invincible = 0;
      asteroids = [makeAsteroid(ship.x, ship.y, 3)]; update(.001);
    });
    await page.locator('#retry-save:visible').waitFor();
    offline = false;
    await page.getByRole('button', { name: 'RETRY SAVE' }).click();
    await page.waitForFunction(() => document.getElementById('flight-count').textContent === '4');
    assert.equal(await page.locator('#personal-best').innerText(), '000400');
    assert.equal(await page.locator('#retry-save').isVisible(), false);
    await page.route('**/api/runs', route => route.abort('failed'));
    await page.getByRole('button', { name: 'TRY AGAIN' }).click();
    await page.evaluate(() => {
      lives = 1; ship.invincible = 0;
      asteroids = [makeAsteroid(ship.x, ship.y, 3)]; update(.001);
    });
    await page.locator('#save-status').filter({ hasText: 'not registered at launch' }).waitFor();
    assert.equal(await page.locator('#retry-save').isVisible(), false);
    assert.equal(await page.locator('#flight-count').innerText(), '4');
    assert.deepEqual(errors, []);
    console.log('PASS: account creation, keyboard-safe form, game-over save, leaderboard, history, reload persistence, logout, automatic pause, failed/successful login, mobile overflow, delayed-session launch saves correctly, queued saves recover after network failure, persisted HUD best, no page errors.');
  } finally {
    await browser?.close();
    server.kill();
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
    await rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
