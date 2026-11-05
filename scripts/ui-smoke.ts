import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedLab, type Snapshot } from './lab.js';

async function launchBrowser(): Promise<Browser> {
  try { return await chromium.launch({ headless: true }); }
  catch { return chromium.launch({ headless: true, channel: 'msedge' }); }
}

export async function uiSmoke(output = resolve('evidence/latest')) {
  const browser = await launchBrowser();
  const results: Record<string, unknown>[] = [];
  mkdirSync(join(output, 'videos'), { recursive: true });
  try {
    for (const scenario of ['H','F1','F2','F3','F4','F5','F6'] as const) {
      const lab = await isolatedLab(`ui-saga-${scenario}`, { AUTO_KILL_MARKERS: 'true', HTTP_TIMEOUT_MS: '1000', RECOVERY_INTERVAL_MS: '1000' });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: join(output, 'videos'), size: { width: 1280, height: 900 } } });
      const page = await context.newPage();
      const video = page.video()!;
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await lab.startAll();
        await page.goto(lab.url());
        await page.locator('.product').first().waitFor();
        await page.locator('[data-flow="automatic"]').click();
        assert.equal(await page.locator('[data-mode]').count(), 2);
        await page.locator('[data-mode="saga"]').click();
        await page.locator('#tab-backend').click();
        await page.waitForFunction(({ scenario }) => {
          const option = document.querySelector<HTMLOptionElement>(`#scenario option[value="${scenario}"]`);
          return !document.querySelector<HTMLSelectElement>('#scenario')?.disabled && !!option && !option.disabled;
        }, { scenario });
        await page.locator('#scenario').selectOption(scenario);
        await page.locator('#tab-shop').click();
        if (scenario === 'H') await page.screenshot({ path: join(output, 'storefront-desktop.png'), fullPage: true });
        await page.locator('#place-order').click();
        await page.locator('#tab-backend').click();
        if (scenario === 'F4') {
          await page.waitForFunction(() => document.querySelector('#services [data-service="payment"]')?.getAttribute('data-available') === 'false' && !!document.querySelector('#snapshots')?.textContent?.includes('RECOVERING'));
          assert((await page.locator('#snapshots').textContent())?.includes('UNAVAILABLE'));
          await page.screenshot({ path: join(output, `saga-${scenario}-pending.png`), fullPage: true });
          await page.waitForFunction(()=>!!document.querySelector('#snapshots')?.textContent?.includes('CONFIRMED'));
        }
        if (scenario === 'F5') {
          await page.waitForFunction(() => !!document.querySelector('#snapshots')?.textContent?.includes('COMPENSATING') && !!document.querySelector('#saga-info')?.textContent?.includes('refund → release → cancel'));
          assert((await page.locator('#ledger').textContent())?.includes('CHARGE'));
          assert(!(await page.locator('#ledger').textContent())?.includes('REFUND'));
          await page.locator('#tab-inventory').click();
          await page.locator('[data-movement="RESERVE"]').waitFor();
          assert.equal(await page.locator('[data-movement="RELEASE"]').count(),0);
          await page.locator('#tab-backend').click();
          await page.screenshot({ path: join(output, `saga-${scenario}-pending.png`), fullPage: true });
          await page.locator('#restore-refund').click();
        }
        if (scenario === 'F6') {
          await page.waitForFunction(() => document.querySelector('#services [data-service="order"]')?.getAttribute('data-available') === 'false' && !!document.querySelector('#ledger')?.textContent?.includes('REFUND') && !!document.querySelector('#snapshots')?.textContent?.includes('UNAVAILABLE') && !!document.querySelector('#snapshots')?.textContent?.includes('HELD') && !!document.querySelector('#process-events')?.textContent?.includes('COORDINATOR_BEFORE_REFUND_OUTCOME'));
          assert((await page.locator('#snapshots').textContent())?.includes('UNAVAILABLE'));
          assert((await page.locator('#snapshots').textContent())?.includes('HELD'));
          assert((await page.locator('#process-events').textContent())?.includes('COORDINATOR_BEFORE_REFUND_OUTCOME'));
          await page.reload();
          await page.locator('#tab-backend').click();
          await page.waitForFunction(() => !!document.querySelector('#ledger')?.textContent?.includes('CHARGE'));
          await page.screenshot({ path: join(output, `saga-${scenario}-pending.png`), fullPage: true });
          await page.locator('#services [data-service="order"] [data-control="start"]').click();
        }
        const expected = ['F1','F2','F3','F5','F6'].includes(scenario) ? 'CANCELLED' : 'CONFIRMED';
        await page.waitForFunction(expected => !!document.querySelector('#snapshots')?.textContent?.includes(expected), expected);
        const orders = (await lab.request<{ id: string }[]>('saga', '/orders')).body;
        assert.equal(orders.length, 1);
        const final = await lab.settled('saga', orders[0].id);
        assert.equal(final.order.status, expected);
        if (['F3','F5','F6'].includes(scenario)) {
          await page.waitForFunction(() => !!document.querySelector('#ledger')?.textContent?.includes('REFUND'));
          await page.locator('#tab-inventory').click();
          await page.locator('[data-movement="RELEASE"]').waitFor();
          await page.locator('#tab-backend').click();
          assert.equal(final.payment.data!.ledger.length, 2);
        }
        await page.screenshot({ path: join(output, `saga-${scenario}-final.png`), fullPage: true });
        if (scenario === 'F3') {
          await page.locator('[data-mode="baseline"]').click();
          assert.equal(await page.locator('[data-order]').count(),1);
          await page.locator('[data-mode="saga"]').click();
          await page.waitForFunction(() => !!document.querySelector('#snapshots')?.textContent?.includes('CANCELLED'));
          await page.setViewportSize({ width: 390, height: 844 });
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({ path: join(output, 'backend-mobile.png'), fullPage: true });
          await page.locator('#tab-shop').click();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({ path: join(output, 'storefront-mobile.png'), fullPage: true });
          await page.reload();
          await page.waitForFunction(() => document.querySelector('[data-testid="order-status"]')?.textContent === 'Đã hủy');
        }
        assert.deepEqual(errors, []);
        results.push({ mode: 'saga', scenario: scenario === 'H' ? 'H0' : scenario, passed: true, final, processEvents: lab.events, errors });
        console.log(`UI saga ${scenario}: PASS (fresh fixture, real APIs, video)`);
      } catch (error) {
        console.error(await page.evaluate(() => ({ caption: document.querySelector('#mode-caption')?.textContent, buttons: [...document.querySelectorAll('[data-mode]')].map(b => ({ mode: b.getAttribute('data-mode'), selected: b.getAttribute('aria-pressed') })), options: [...document.querySelectorAll<HTMLOptionElement>('#scenario option')].map(o => ({ value: o.value, disabled: o.disabled })) })));
        await page.screenshot({ path: join(output, 'ui-failure.png'), fullPage: true });
        throw error;
      } finally {
        await context.close();
        const videoPath = await video.path();
        renameSync(videoPath, join(output, 'videos', `saga-${scenario}.webm`));
        await lab.close();
      }
    }
    const result = { passed: true, capturedAt: new Date().toISOString(), browser: browser.version(), cases: results, videos: results.length, desktop: true, mobileWidth: 390, errors: [] };
    writeFileSync(join(output, 'ui-smoke.json'), JSON.stringify(result, null, 2));
    return result;
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await uiSmoke();
