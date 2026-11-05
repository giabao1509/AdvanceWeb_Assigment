import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {chromium} from 'playwright';
import {refundFailureDemo} from './demo-refund-failure.js';
import {restartOrderDemo} from './demo-restart-order.js';
import type {PhaseObserver} from './compensation-capture.js';

const output=resolve('evidence',`v3-${new Date().toISOString().replace(/[:.]/g,'-')}`);
mkdirSync(output,{recursive:true});let browser;
const errors:string[]=[];
const files=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);
const sha=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
try{
 try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'msedge'});}
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 const observe:PhaseObserver=async(lab,id,scenario,phase)=>{
  await page.goto(lab.url());await page.locator('#tab-backend').click();
  await page.waitForFunction(({id,done})=>document.querySelector<HTMLSelectElement>('#trace-order')?.value===id && !!document.querySelector('#snapshots')?.textContent?.includes(done?'CANCELLED':'COMPENSATING'),{id,done:phase==='03-converged'});
  await page.waitForFunction(({refunded})=>!!document.querySelector('#ledger')?.textContent?.includes(refunded?'REFUND':'CHARGE'),{refunded:scenario==='F6' || phase==='03-converged'});
  await page.screenshot({path:join(output,`${scenario.toLowerCase()}-${phase}.png`),fullPage:true});
  if(phase==='03-converged'){
   await page.locator('#tab-inventory').click();await page.locator('[data-movement="RELEASE"]').waitFor();
   await page.screenshot({path:join(output,`${scenario.toLowerCase()}-released-inventory.png`),fullPage:true});
  }
 };
 await refundFailureDemo(output,observe);await restartOrderDemo(output,observe);assert.deepEqual(errors,[]);
 const sources=['package.json',...files(resolve('src')),...files(resolve('scripts')),...files(resolve('tests')),...files(resolve('public')).filter(p=>!p.endsWith('.js'))];
 const artifacts=files(output).map(p=>({file:relative(output,p).replaceAll('\\','/'),sha256:sha(p)}));
 const manifest={passed:true,scope:'V3 F5/F6 compensation and restart',capturedAt:new Date().toISOString(),freshFixtures:true,checkpointMethod:'IPC pause after reading durable recovery state, before enabling worker; default app startup is not paused',cases:['F5','F6'],phases:['before-stop','after-restart','converged'],artifacts,sources:sources.map(p=>({file:relative(resolve('.'),resolve(p)).replaceAll('\\','/'),sha256:sha(p)})),browserErrors:errors};
 writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
 writeFileSync(join(output,'README.md'),`# Evidence V3 — F5 và F6\n\nMỗi case có ba JSON và ba ảnh Backend: trước dừng, ngay sau restart, sau hội tụ. Ảnh released-inventory cho thấy nhả hàng trong tab Kho hàng.\n\nF5 giữ COMPENSATING và pending refund → release → cancel sau hết budget; script restart rồi gỡ lỗi và tiếp tục. Fixture dùng 1 retry để chụp gọn.\n\nF6 dừng Order sau refund commit, trước khi lưu kết quả. Sau restart, query refund ID cũ rồi release/cancel. Có đúng một refund và một release.\n\nCheckpoint sau restart được giữ bằng IPC chỉ trong script kiểm thử; app chạy bình thường tự bật worker. Dữ liệu/port là fixture riêng. manifest.json ghi SHA-256 của artifacts và source hiện tại. Đây là evidence V3 có phạm vi riêng, không thay bộ matrix/video tổng thể cũ.\n`);
 writeFileSync(resolve('evidence/latest-v3.json'),JSON.stringify({directory:relative(resolve('.'),output).replaceAll('\\','/'),passed:true,capturedAt:manifest.capturedAt,scope:manifest.scope},null,2));
 console.log(`V3 evidence PASS: ${output}`);
}catch(error){writeFileSync(join(output,'failure.json'),JSON.stringify({passed:false,error:String(error)},null,2));throw error;}
finally{await browser?.close();}
