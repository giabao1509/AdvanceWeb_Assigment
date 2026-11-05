import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { isolatedLab } from './lab.js';
const lab=await isolatedLab('manual-browser');let browser;
try{
 await lab.startAll();try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'msedge'});}
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(lab.url());await page.locator('.product').first().waitFor();
 assert.equal(await page.locator('[data-flow="manual"]').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('[data-mode]').count(),2);
 assert.equal(await page.locator('#run-settings [data-flow]').count(),2);assert.equal(await page.locator('#scenario').count(),1);
 assert.equal(await page.locator('#panel-shop [data-flow],#panel-backend #scenario').count(),0);
 assert(await page.locator('#lab-scenario-field').isHidden());
 await page.locator('#tab-inventory').click();await page.locator('[data-flow="automatic"]').click();await page.locator('#scenario').selectOption('F3');
 assert(await page.locator('#run-settings').isVisible());await page.locator('#tab-shop').click();assert((await page.locator('#place-order').textContent())?.includes('Chạy lab F3'));
 await page.locator('[data-flow="manual"]').click();assert(await page.locator('#lab-scenario-field').isHidden());
 async function next(){if(await page.locator('#new-order').isVisible())await page.locator('#new-order').click();await page.locator('#place-order').click();await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Chờ thanh toán');}
 await next();
 await page.screenshot({path:'.local/manual-checkout.png',fullPage:true});
 const first=(await lab.request<{id:string}[]>('saga','/orders')).body[0];
 const noCharge=await lab.request<{payment:unknown}>('saga',`/orders/${first.id}/state`,{},'payment');assert.equal(noCharge.body.payment,null);
 await page.reload();await page.locator('#pay-order').waitFor();
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'.local/manual-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});
 await page.locator('#pay-order').click();await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Đã xác nhận');
 await page.waitForFunction(()=>!!document.querySelector('.payment-receipt')?.textContent?.includes('9.550.000'));
 await next();await page.locator('#payment-wallet').selectOption('limited');await page.locator('#pay-order').click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Đã hủy');assert((await page.locator('.status-message').textContent())?.includes('không đủ số dư'));
 await next();await page.locator('#cancel-order').click();await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Đã hủy');
 assert((await page.locator('.status-message').textContent())?.includes('trước thanh toán'));
 await page.locator('[data-mode="baseline"]').click();await next();await page.locator('#payment-wallet').selectOption('limited');await page.locator('#pay-order').click();await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Chưa hoàn tất');
 await page.locator('#tab-backend').click();await page.waitForFunction(()=>!!document.querySelector('#snapshots')?.textContent?.includes('HELD'));
 await page.locator('[data-mode="saga"]').click();await page.locator('#tab-shop').click();await page.locator('[data-flow="automatic"]').click();
 await nextAutomatic();
 async function nextAutomatic(){if(await page.locator('#new-order').isVisible())await page.locator('#new-order').click();await page.locator('#place-order').click();await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Đã xác nhận');}
 await page.locator('#new-order').click();await page.locator('#tab-backend').click();await page.locator('#scenario').selectOption('F5');await page.locator('#tab-shop').click();await page.locator('#place-order').click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Đang bù');
 await page.locator('#tab-backend').click();await page.waitForFunction(()=>!!document.querySelector('[data-testid="retry-state"]')?.textContent?.includes('3 / 3'));
 assert((await page.locator('[data-testid="retry-state"]').textContent())?.includes('Đang bù · hết lượt thử, chờ khắc phục'));
 assert(await page.locator('#resume-saga').isVisible());assert((await page.locator('#ledger').textContent())?.includes('CHARGE'));assert(!(await page.locator('#ledger').textContent())?.includes('REFUND'));
 await page.waitForFunction(()=>!!document.querySelector('#traces')?.textContent?.includes('Worker nền đang thử lại hoàn tiền'));
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'.local/retry-limit-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});
 await page.locator('#restore-refund').click();await page.waitForFunction(()=>!!document.querySelector('#snapshots')?.textContent?.includes('CANCELLED') && !!document.querySelector('#ledger')?.textContent?.includes('REFUND'));
 await page.locator('#trace-order').selectOption(first.id);await page.locator('[data-log-action="charge"]').click();
 assert((await page.locator('#payload').textContent())?.includes(first.id));
 assert.deepEqual(errors,[]);console.log('Manual UI PASS: two modes, await payment, reload, wallet debit, insufficient balance, cancel, automatic compatibility, retry cap, restore, order log switch, mobile.');
}finally{await browser?.close();await lab.close();}
