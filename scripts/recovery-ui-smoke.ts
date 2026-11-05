import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { isolatedLab } from './lab.js';
let browser;
try {
 try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'msedge'});}
 for(const scenario of ['F4','F5','F6']){
  const lab=await isolatedLab(`two-modes-${scenario}`,{AUTO_KILL_MARKERS:'true',SAGA_MAX_RETRIES:'0',RECOVERY_INTERVAL_MS:'80'});
  const page=await browser.newPage();
  try{
   await lab.startAll();await page.goto(lab.url());await page.locator('.product').first().waitFor();
   await page.locator('[data-flow="automatic"]').click();await page.locator('#scenario').selectOption(scenario);
   if(scenario==='F4')await page.locator('#f4-duration').fill('5');
   await page.locator('#place-order').click();await page.locator('#tab-backend').click();
   if(scenario==='F4'){
    await page.waitForFunction(()=>!!document.querySelector('#snapshots')?.textContent?.includes('RECOVERING') && !!document.querySelector('[data-testid="f4-recovery"]')?.textContent?.includes('Tự khởi động lại'));
    assert(await page.locator('#resume-saga').isHidden());
    await page.screenshot({path:'.local/f4-waiting-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:'.local/f4-waiting-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});
    await page.reload();await page.locator('#tab-backend').click();
   }else if(scenario==='F5'){
    await page.waitForFunction(()=>!!document.querySelector('#snapshots')?.textContent?.includes('COMPENSATING') && !!document.querySelector('[data-testid="retry-state"]')?.textContent?.includes('chờ khắc phục'));
    await page.locator('#restore-refund').click();
   }else{
    await page.waitForFunction(()=>document.querySelector('#services [data-service="order"]')?.getAttribute('data-available')==='false' && !!document.querySelector('#ledger')?.textContent?.includes('REFUND') && !!document.querySelector('#saga-info')?.textContent?.includes('REFUND_PENDING'));
    await page.locator('#services [data-service="order"] [data-control="start"]').click();
   }
   const expected=scenario==='F4'?'CONFIRMED':'CANCELLED';
   await page.waitForFunction(expected=>!!document.querySelector('#snapshots')?.textContent?.includes(expected),expected);
   const orders=(await lab.request<{id:string}[]>('saga','/orders')).body;const s=await lab.settled('saga',orders[0].id);
   assert.equal(s.payment.data!.ledger.length,scenario==='F4'?1:2);
   if(scenario==='F4'){
    assert.equal(s.order.f4_downtime_ms,5000);
    assert(!lab.events.some(e=>e.event==='CLIENT_HTTP' && String(e.path).endsWith('/resume')));
    assert(lab.events.some(e=>e.event==='F4_RESTORE_COMPLETED'));
   }
   if(scenario==='F5'){
    await page.waitForFunction(()=>!!document.querySelector('#traces')?.textContent?.includes('Đã tiếp nhận yêu cầu gỡ lỗi hoàn tiền') && !!document.querySelector('#traces')?.textContent?.includes('Đã hoàn tiền'));
   }else{
    await page.waitForFunction(scenario=>!!document.querySelector('#traces')?.textContent?.includes(scenario==='F6'?'Đã tìm thấy kết quả hoàn tiền trước đó':'Đã tìm thấy khoản thu trước đó'),scenario);
    assert(await page.locator('#log-detail').isHidden());
    await page.locator(`[data-log-action="${scenario==='F6'?'refund':'charge'}"]`).click();
    await page.locator('[data-related-trace]').waitFor();await page.locator('[data-related-trace]').click();
    assert((await page.locator('#payload').textContent())?.includes('SUCCEEDED'));
    assert((await page.locator('#payload').textContent())?.includes('GET /operations/'));
    await page.locator('#close-log').click();await page.locator('#follow-logs').click();
    if(scenario==='F6')assert((await page.locator('#traces').textContent())?.includes('Order đã khởi động lại, bắt đầu phục hồi đơn'));
   }
   await page.screenshot({path:`.local/recovery-log-${scenario}.png`,fullPage:true});
   console.log(`${scenario} browser recovery and readable logs PASS`);
  }finally{await page.close();await lab.close();}
 }
}finally{await browser?.close();}
