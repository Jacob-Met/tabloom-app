// voice intake: browser walk-through using the upload input. Usage: node test/voice-flow.e2e.mjs http://127.0.0.1:5601 [outdir]
import { chromium } from '/Users/me/Downloads/hamon-research-handoff/paypal-demos/tools/node_modules/playwright/index.mjs';
const base = process.argv[2] || 'http://127.0.0.1:5601', out = process.argv[3] || '.';
const RECEIPT = 'Lamb tagine 26.00\nGrilled sea bass 29.00\nMezze platter 18.00\nSaffron rice 7.00\nMint tea pot 8.00\nBirthday cake 9.00\nTax 8.00\nTip 19.40\nTotal 124.40';
const browser = await chromium.launch();
for (const [tag, vp] of [['desktop', { width: 1280, height: 720 }], ['phone', { width: 390, height: 844 }]]) {
  const page = await (await browser.newContext({ viewport: vp, deviceScaleFactor: tag === 'phone' ? 2 : 1 })).newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(base + '/tabloom/', { waitUntil: 'networkidle' });
  await page.click('#new-table'); await page.fill('#new-table-title', 'Noor’s birthday dinner'); await page.fill('#new-table-guests', 'Noor\nIdris\nCamille\nTomas');
  await page.click('#create-table'); await page.waitForURL(/table=/);
  await page.click('#paste-receipt'); await page.fill('#receipt-text', RECEIPT); await page.click('#preview-receipt'); await page.waitForTimeout(1500); await page.click('#use-receipt'); await page.waitForTimeout(800);
  await page.locator('#voice-intake > summary').click();
  await page.screenshot({ path: `${out}/tabloom-voice-${tag}-1-open.png` });
  await page.setInputFiles('#voice-file', 'tabloom/sample/table-talk.wav');
  await page.locator('.voice-speaker').first().waitFor({ timeout: 120000 });
  console.log(tag, 'speakers', await page.locator('.voice-speaker').count());
  const sels = page.locator('[data-who]'); const n = await sels.count();
  for (let i = 0; i < n; i++) console.log(' speaker', i + 1, '->', JSON.stringify(await sels.nth(i).inputValue()), '|', (await page.locator('.voice-said').nth(i).innerText()).replace(/\s+/g, ' ').slice(0, 90));
  for (let i = 0; i < n; i++) if (!(await sels.nth(i).inputValue())) await sels.nth(i).selectOption('Tomas');
  await page.locator('#voice-intake').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/tabloom-voice-${tag}-2-speakers.png` });
  await page.locator('.voice-play').first().click(); await page.waitForTimeout(300); await page.locator('.voice-play').first().click();
  await page.click('#voice-suggest');
  console.log(' note:', JSON.stringify(await page.inputValue('#bill-note')));
  await page.locator('fieldset.suggestion').first().waitFor({ timeout: 240000 });
  const F = page.locator('fieldset.suggestion'); const c = await F.count();
  for (let i = 0; i < c; i++) { const f = F.nth(i); console.log(' AI', (await f.locator('legend').innerText()).replace(/\s+/g, ' '), JSON.stringify(await f.locator('[data-review-guest]').evaluateAll(b => b.map(x => x.checked ? 1 : 0))), '|', (await f.innerText()).replace(/\s+/g, ' ').slice(-140)); }
  await F.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/tabloom-voice-${tag}-3-ai.png` });
  for (let i = 0; i < c; i++) { // the model sometimes leaves an item empty ("the three of us"); the payer then ticks the guests
    const conf = F.nth(i).locator('[data-review-confirm]');
    if (await conf.isDisabled()) for (const g of [1, 2, 3]) await F.nth(i).locator('[data-review-guest]').nth(g).check();
    await conf.click(); }
  await page.click('#apply-ai'); await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/tabloom-voice-${tag}-4-applied.png` });
  console.log(tag, 'done; dues:', (await page.locator('#dues').innerText()).replace(/\s+/g, ' ').slice(0, 200));
}
await browser.close();
