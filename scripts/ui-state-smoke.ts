import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { isolatedLab } from './lab.js';

const lab=await isolatedLab('ui-state');
let browser;
try {
  await lab.startAll();
  try { browser=await chromium.launch({headless:true}); }
  catch { browser=await chromium.launch({headless:true,channel:'msedge'}); }
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(lab.url());
  await page.locator('.product').first().waitFor();
  await page.locator('#place-order').click();
  await page.locator('#pay-order').waitFor();
  assert.match(await page.locator('[data-testid="stock-stage"]').innerText(),/giữ tạm/);
  await page.locator('#tab-inventory').click();
  await page.locator('[data-movement="RESERVE"]').waitFor();
  assert.equal(await page.locator('#stock-history th').count(),4);
  assert.equal(await page.locator('[data-stock-sku="LAMP-01"] [data-available]').innerText(),'19');
  await page.locator('#tab-shop').click();
  await page.locator('#pay-order').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Đã xác nhận');
  assert.match(await page.locator('[data-testid="stock-stage"]').innerText(),/Hàng đã chốt/);
  await page.locator('#tab-inventory').click();
  await page.locator('[data-stock-sku="LAMP-01"]').waitFor();
  // Confirm consumes the existing reservation, without a second stock deduction.
  assert.equal(await page.locator('[data-stock-sku="LAMP-01"] [data-available]').innerText(),'19');
  assert.equal(await page.locator('[data-movement]').count(),1);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:'.local/ui-state-inventory.png',fullPage:true});
  await page.locator('#tab-backend').click();
  await page.locator('#services [data-service="payment"] [data-control="stop"]').click();
  await page.locator('#services [data-service="payment"] [data-control="start"]').waitFor();
  assert.match(await page.locator('#services .snapshot-card[data-service="payment"]').innerText(),/Không truy cập được/);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:'.local/ui-state-services.png',fullPage:true});
  await page.locator('#services [data-service="payment"] [data-control="start"]').click();
  await page.locator('#services [data-service="payment"] [data-control="stop"]').waitFor();
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:'.local/ui-state-mobile.png',fullPage:true});
  await page.locator('#tab-shop').click();
  await page.locator('#new-order').click();
  await page.locator('#place-order').click();
  await page.locator('#cancel-order').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Đã hủy');
  await page.locator('#tab-inventory').click();
  await page.locator('[data-movement="RELEASE"]').waitFor();
  assert.equal(await page.locator('[data-stock-sku="LAMP-01"] [data-available]').innerText(),'19');
  assert.deepEqual(errors,[]);
  console.log('UI state PASS: temporary hold, confirmed without double deduction, release, service stop/restore, mobile, no browser errors.');
} finally { await browser?.close(); await lab.close(); }
