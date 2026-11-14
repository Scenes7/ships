// Browser smoke test: two real players through the UI.
// SITE=https://tanks.dreamteamhub.ca/ node test/browser.js   (needs `playwright` installed)
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const SITE = process.env.SITE || 'https://tanks.dreamteamhub.ca/';
const step = (s) => console.log('✓', s);

const browser = await chromium.launch();
const errors = [];
const mk = async (name) => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(SITE);
  await page.fill('#name', name);
  return page;
};
const A = await mk('Alice'), B = await mk('Bob');

await A.click('#play');
await A.waitForSelector('#queue:not(.hidden)', { timeout: 10000 });
step('Alice is in the queue');
await B.click('#play');
await Promise.all([A, B].map((p) => p.waitForSelector('#game:not(.hidden)', { timeout: 10000 })));
const board = await A.locator('#scoreboard').innerText();
assert.match(board, /Alice/);
assert.match(board, /Bob/);
step(`Both in a match: "${board.replace(/\s+/g, ' ').trim()}"`);

// Wait out the intro countdown, then drive Alice forward and fire.
await A.waitForTimeout(6000);
const shot1 = await A.locator('#canvas').screenshot();
await A.keyboard.down('KeyW');
await A.waitForTimeout(800);
await A.keyboard.up('KeyW');
await A.keyboard.press('Space');
await A.waitForTimeout(300);
const shot2 = await A.locator('#canvas').screenshot();
assert.ok(!shot1.equals(shot2), 'canvas changed after moving');
await A.screenshot({ path: process.env.SHOT || 'test/screenshot.png' });
step('Alice drove and fired; canvas updated');

await B.close();
await A.waitForFunction(() => /win|forfeit|left/i.test(document.body.innerText), null, { timeout: 10000 });
step('Bob closed the tab: Alice gets the forfeit result');

assert.deepEqual(errors, []);
await browser.close();
console.log('Browser E2E passed');
