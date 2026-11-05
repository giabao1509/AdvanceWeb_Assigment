import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { isolatedLab } from './lab.js';
const lab=await isolatedLab('stock-browser');let browser;
try{
 await lab.startAll();try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'msedge'});}
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(lab.url());await page.locator('.product').first().waitFor();await page.locator('#place-order').click();await page.locator('#cancel-order').waitFor();
 await page.locator('#tab-inventory').click();await page.waitForFunction(()=>document.querySelector('[data-stock-sku="LAMP-01"] [data-available]')?.textContent==='19');
 assert.equal(await page.locator('[data-held]').count(),0);assert.equal(await page.locator('[data-stock-sku="CUP-01"] [data-available]').textContent(),'30');
 await page.locator('#tab-shop').click();await page.locator('#cancel-order').click();await page.waitForFunction(()=>document.querySelector('[data-testid="order-status"]')?.textContent==='Đã hủy');
 await page.locator('#tab-inventory').click();await page.waitForFunction(()=>document.querySelector('[data-stock-sku="LAMP-01"] [data-available]')?.textContent==='20' && document.querySelectorAll('[data-movement]').length===2);
 const order=(await lab.request<{id:string}[]>('saga','/orders')).body[0];
 await page.screenshot({path:'.local/stock-desktop.png',fullPage:true});
 await page.locator('#stock-kind').selectOption('RELEASE');await page.waitForFunction(()=>document.querySelectorAll('[data-movement]').length===1);
 assert.equal(await page.locator('[data-movement]').getAttribute('data-movement'),'RELEASE');
 await page.locator('#stock-sku').selectOption('CUP-01');await page.waitForFunction(()=>!!document.querySelector('#stock-history')?.textContent?.includes('Chưa có hoạt động'));
 await page.locator('#stock-sku').selectOption('');await page.locator('#stock-kind').selectOption('');
 await page.locator('[data-mode="baseline"]').click();assert.equal(await page.locator('[data-movement]').count(),2);
 await page.locator('[data-mode="saga"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-movement]').length===2);
 await lab.stop('order');await page.locator('#refresh-inventory').click();assert.equal(await page.locator('[data-stock-sku="LAMP-01"] [data-available]').textContent(),'20');
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'.local/stock-mobile.png',fullPage:true});
 await lab.stop('inventory');await page.locator('#refresh-inventory').click();await page.waitForFunction(()=>!!document.querySelector('#inventory-note')?.textContent?.includes('lần đọc trước'));
 assert.equal(await page.locator('[data-stock-sku="LAMP-01"] [data-available]').textContent(),'20');
 assert.deepEqual(errors,[]);console.log('Stock UI PASS: live counts, shared reserve/release history, filters, policy switching, details, Order independent, stale-state message, mobile.');
}finally{await browser?.close();await lab.close();}
