// Capture the real application with an empty temporary database; no live user data.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temporary = await mkdtemp(join(tmpdir(), 'rasteroids-docs-'));
const server = spawn(process.env.PYTHON || 'python3', [fileURLToPath(new URL('../server.py', import.meta.url)), '--port', '0', '--database', join(temporary, 'empty.sqlite3')], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start.')), 10000);
    server.stdout.on('data', data => { const match = String(data).match(/http:\/\/[^\s]+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
    server.on('error', error => { clearTimeout(timeout); reject(error); });
    server.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  const directory = fileURLToPath(new URL('../docs/images/', import.meta.url));
  await mkdir(directory, { recursive: true });
  for (const [name, viewport, touch] of [['desktop', { width: 1440, height: 1000 }, false], ['mobile', { width: 390, height: 844 }, true]]) {
    const context = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('#board-message').filter({ hasText: 'Uncharted territory.' }).waitFor();
    await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
    await context.close();
    console.log(`Captured docs/images/${name}.png`);
  }
} finally {
  await browser?.close(); server.kill();
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  await rm(temporary, { recursive: true, force: true });
}
