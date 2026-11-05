import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { isolatedLab, waitFor } from './lab.js';
import type { Saga } from '../src/shared/types.js';

const lab=await isolatedLab('history-browser',{SAGA_MAX_RETRIES:'100',RECOVERY_INTERVAL_MS:'200'});let browser;
try{
 await lab.startAll();
 const first=(await lab.create('saga','F3')).body.order.id;await lab.settled('saga',first);
 const second=(await lab.create('saga','H')).body.order.id;await lab.settled('saga',second);
 const running=(await lab.create('saga','F5')).body.order.id;
 try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'msedge'});}
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(lab.url());await page.locator('.product').first().waitFor();
 await page.locator('#tab-inventory').click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-movement]').length===4);
 assert.equal(await page.locator('#panel-backend #movements').count(),0);
 assert((await page.locator('#stock-history').textContent())?.includes(first));
 assert((await page.locator('#stock-history').textContent())?.includes(second));
 await page.locator('#tab-backend').click();await page.locator('#trace-order').selectOption(running);
 await page.waitForFunction(()=>document.querySelectorAll('[data-ledger-id]').length===4 && document.querySelectorAll('[data-trace]').length===40);
 const ledgerIds=await page.locator('[data-ledger-id]').evaluateAll(rows=>rows.map(r=>r.getAttribute('data-ledger-id')));
 await page.locator('#trace-order').selectOption(first);await page.locator('#snapshots').getByText('CANCELLED',{exact:true}).waitFor();
 assert.deepEqual(await page.locator('[data-ledger-id]').evaluateAll(rows=>rows.map(r=>r.getAttribute('data-ledger-id'))),ledgerIds);
 await page.locator('#ledger details').first().locator('summary').click();
 await page.locator('#refresh-traces').click();assert.equal(await page.locator('#ledger details[open]').count(),1);
 await page.locator('#trace-order').selectOption(running);
 await page.waitForFunction(()=>document.querySelectorAll('[data-trace]').length===40);
 assert.equal(await page.locator('#traces').evaluate(e=>e.scrollTop),0);
 const times=await page.locator('[data-log-time]').evaluateAll(rows=>rows.map(r=>r.getAttribute('data-log-time')!));
 assert.deepEqual(times,[...times].sort().reverse());
 await page.locator('#traces').evaluate(e=>e.scrollTop=480);
 await page.waitForFunction(()=>document.querySelector('#follow-logs')?.getAttribute('aria-pressed')==='false');
 const anchor=await page.locator('#traces').evaluate(e=>{
  const top=e.getBoundingClientRect().top;const row=Array.from(e.querySelectorAll<HTMLElement>('[data-trace]')).find(r=>r.getBoundingClientRect().bottom>top+1)!;
  return {id:row.dataset.trace,offset:row.getBoundingClientRect().top-top};
 });
 const state=(await lab.request<Saga>('saga',`/sagas/${running}`)).body;
 await waitFor(async()=> (await lab.request<Saga>('saga',`/sagas/${running}`)).body.retry_count>=state.retry_count+3);
 // Force two real refreshes while new backend logs arrive; keep the same visible row and offset.
 for(let i=0;i<2;i++){
  const response=page.waitForResponse(r=>r.url().endsWith(`/orders/${running}/traces`));
  await page.locator('#refresh-traces').click();await response;
  await page.waitForFunction(({id,offset})=>{
   const list=document.querySelector('#traces')!;const row=Array.from(list.querySelectorAll<HTMLElement>('[data-trace]')).find(r=>r.dataset.trace===id);
   return !!row && Math.abs(row.getBoundingClientRect().top-list.getBoundingClientRect().top-offset)<3;
  },anchor);
 }
 assert(await page.locator('#traces').evaluate(e=>e.scrollTop>0));
 const before=await page.locator('[data-trace]').count();
 await page.locator('#traces').evaluate(e=>e.scrollTop=e.scrollHeight);
 await page.waitForFunction(before=>document.querySelectorAll('[data-trace]').length>before,before);
 await page.locator('#traces [data-trace]').last().click();assert(await page.locator('#log-detail').isVisible());
 await page.locator('#close-log').click();await page.locator('#follow-logs').click();
 assert.equal(await page.locator('#traces').evaluate(e=>e.scrollTop),0);
 assert.equal(await page.locator('[data-trace]').count(),40);
 await page.screenshot({path:'.local/history-desktop.png',fullPage:true});
 await lab.stop('order');await page.locator('#refresh-traces').click();
 assert.equal(await page.locator('[data-ledger-id]').count(),4);
 await page.locator('[data-mode="baseline"]').click();assert.equal(await page.locator('[data-ledger-id]').count(),4);
 await page.locator('[data-mode="saga"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-ledger-id]').length===4);
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'.local/history-mobile.png',fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),JSON.stringify(await page.evaluate(()=>Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(e=>e.getBoundingClientRect().right>innerWidth+2).map(e=>({tag:e.tagName,id:e.id,cls:e.className,width:e.getBoundingClientRect().width})).slice(0,15))));
 await page.locator('#tab-inventory').click();await page.screenshot({path:'.local/history-stock-mobile.png',fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),JSON.stringify(await page.evaluate(()=>Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(e=>e.getBoundingClientRect().right>innerWidth+2).map(e=>({tag:e.tagName,id:e.id,cls:e.className,width:e.getBoundingClientRect().width})).slice(0,15))));
 assert.deepEqual(errors,[]);console.log('History UI PASS: all orders, shared ledger, stock tab, stable scroll during live retries, older-log loading, newest first, policy switching, Order independent, mobile.');
}finally{await browser?.close();await lab.close();}
