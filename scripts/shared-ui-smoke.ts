import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {isolatedLab} from './lab.js';
import type {Order,Wallet} from '../src/shared/types.js';
const lab=await isolatedLab('shared-ui');let browser;
try{
 await lab.startAll();try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'msedge'});}
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(lab.url());await page.locator('.product').first().waitFor();
 await page.locator('[data-mode="baseline"]').click();await page.locator('#place-order').click();
 await page.locator('#pay-order').waitFor();
 const order=(await lab.request<Order[]>('saga','/orders')).body[0];assert.equal(order.mode,'baseline');
 await page.locator('[data-mode="saga"]').click();
 assert.equal(await page.locator('[data-order]').count(),1);assert.equal(await page.locator('[data-testid="order-mode"]').textContent(),'Baseline');
 assert((await page.locator('#payment-wallet').textContent())?.includes('10.000.000'));
 await page.locator('#pay-order').click();await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Đã xác nhận');
 assert.equal((await lab.request<{order:Order}>('saga',`/orders/${order.id}`)).body.order.mode,'baseline');
 assert.equal((await lab.request<Wallet[]>('saga','/wallets',{},'payment')).body[0].balance,9550000);
 await page.locator('#place-order').click();await page.locator('#pay-order').waitFor();
 assert.equal(await page.locator('[data-testid="order-mode"]').textContent(),'Saga');
 await page.locator('[data-mode="baseline"]').click();await page.locator('#payment-wallet').selectOption('limited');await page.locator('#pay-order').click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Đã hủy');
 assert.equal(await page.locator('[data-order-mode="baseline"]').count(),1);assert.equal(await page.locator('[data-order-mode="saga"]').count(),1);
 await page.locator('#tab-inventory').click();await page.waitForFunction(()=>document.querySelector('[data-stock-sku="LAMP-01"] [data-available]')?.textContent==='19');
 assert.equal(await page.locator('[data-movement]').count(),3);
 await page.locator('[data-mode="saga"]').click();assert.equal(await page.locator('[data-movement]').count(),3);
 await page.locator('#tab-backend').click();await page.waitForFunction(()=>document.querySelectorAll('[data-ledger-id]').length===1);
 await page.locator('#trace-order').selectOption(order.id);await page.waitForFunction(()=>!!document.querySelector('#saga-info')?.textContent?.includes('Baseline'));
 await page.locator('[data-mode="baseline"]').click();assert.equal(await page.locator('[data-ledger-id]').count(),1);
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'.local/shared-ui-mobile.png',fullPage:true});await page.reload();
 await page.locator('.product').first().waitFor();assert.equal(await page.locator('[data-order]').count(),2);
 assert.deepEqual(errors,[]);console.log('Shared UI PASS: switching policy preserves orders/stock/wallet/history, existing orders keep their policy, reload and mobile.');
}finally{await browser?.close();await lab.close();}
