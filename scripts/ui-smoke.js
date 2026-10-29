// Optional browser smoke check using installed Chrome/Edge, no extra npm packages.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

const executable = process.env.LAB_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!executable) throw new Error('Set LAB_BROWSER to your Chrome/Edge executable.');
const dir = mkdtempSync(join(tmpdir(), 'task-lab-ui-'));
const db = openDatabase(join(dir, 'test.sqlite'));
const app = createApp({db}); const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening',resolve));
const browser = spawn(executable, ['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${join(dir,'profile')}`,'about:blank'], { windowsHide:true, stdio:'ignore' });
let socket;
try {
  let port;
  for (let i=0; i<100; i++) {
    const active = join(dir,'profile','DevToolsActivePort');
    if (existsSync(active)) { port = readFileSync(active,'utf8').split('\n')[0]; break; }
    await delay(100);
  }
  assert.ok(port,'Chrome debugging did not start');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve,reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map(); const errors = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.id) {
      const entry = pending.get(message.id); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    }
  };
  const call = (method,params = {}) => new Promise((resolve,reject) => {
    const nextId = ++id;
    const timer = setTimeout(() => { pending.delete(nextId); reject(new Error(`CDP timeout: ${method}`)); },10000);
    pending.set(nextId,{resolve,reject,timer}); socket.send(JSON.stringify({id:nextId,method,params}));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let i=0; i<100; i++) { if (await evaluate(expression)) return; await delay(50); }
    throw new Error(`UI wait failed: ${expression}`);
  };
  const dismissPermission = async () => {
    if(await evaluate(`document.getElementById('permission-popup').open`)) await evaluate(`document.getElementById('permission-dismiss').click()`);
    if(await evaluate(`document.getElementById('success-popup').open`)) await evaluate(`document.getElementById('success-dismiss').click()`);
  };
  const click = async selector => { if(selector!=='#permission-dismiss') await dismissPermission(); return evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); };
  const fill = async (selector,value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`);
  const submit = async selector => { await dismissPermission(); return evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`); };
  const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const login = async user => {
    if(await evaluate(`!document.getElementById('workspace').hidden`)) await click('#switch-user');
    await fill('#login-user',user); await submit('#login-form');
    await waitFor(`document.querySelectorAll('.project-card').length===2`);
  };
  const version = async v => { await click(`[data-version="${v}"]`); };
  const project = async id => click(`[data-project="${id}"] .open-project`);
  const task = async (id,action='Sửa') => {
    await evaluate(`[...document.querySelector('[data-task="${id}"]').querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(action)}).click()`);
    await waitFor(`document.getElementById('modal').open`);
  };
  const action = async (selector,label) => evaluate(`[...document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
  const save = async () => { await submit('#task-form'); await waitFor(`!document.querySelector('#task-form button[type="submit"]') || !document.querySelector('#task-form button[type="submit"]').disabled`); };
  const reset = async () => { await click('#reset'); await action('#modal','Xác nhận'); await waitFor(`document.getElementById('notice').textContent.includes('Đã khôi phục')`); assert.equal(await evaluate(`document.getElementById('success-popup').open`),true); };
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
  await waitFor(`!!document.getElementById('login-form')`);
  mkdirSync('.local-check',{recursive:true});
  await call('Emulation.setDeviceMetricsOverride',{width:1360,height:1000,deviceScaleFactor:1,mobile:false});
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  writeFileSync('.local-check/login.png',Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true})).data,'base64'));
  await login('alice'); await project('beta');
  await waitFor(`!!document.querySelector('[data-task="B1"]')`);
  await task('B1','Xem'); assert.match(await text('#modal-content'),/Private Beta/); await click('#close-modal');
  assert.equal(await evaluate(`document.getElementById('success-popup').open`),false,'Read operations do not show a success popup');
  for(const v of ['v1','v2','v3','v4']) {
    await version(v); await waitFor(`document.querySelector('#page .empty.error')!==null`);
    assert.equal(await evaluate(`document.getElementById('permission-popup').open`),true);
    assert.match(await text('#permission-popup'),v==='v4' ? /tổ chức khác/ : /chưa tham gia dự án/);
    assert.doesNotMatch(await text('#page'),/Bạn cần là thành viên|Bạn không phải thành viên|thuộc tenant khác/);
    assert.doesNotMatch(await text('#page'),/Private Beta|roadmap|B1/);
  }
  await version('v2'); await click('#home'); await waitFor(`document.querySelectorAll('.project-card').length===2`);
  await project('alpha'); await waitFor(`!!document.querySelector('[data-task="A1"]')`);
  await task('A1'); await fill('#task-title','   '); await save();
  assert.equal(await evaluate(`document.getElementById('permission-popup').open`),false,'Input validation stays beside the field');
  assert.equal(await evaluate(`document.getElementById('task-title').getAttribute('aria-invalid')`),'true');
  assert.match(await text('#task-title-error'),/Tiêu đề không được trống/);
  await fill('#task-title','UI persisted title'); await save();
  await waitFor(`document.getElementById('page').textContent.includes('UI persisted title')`);
  await waitFor(`document.getElementById('success-popup').open`);
  assert.match(await text('#success-popup'),/Đã lưu thay đổi công việc/);
  writeFileSync('.local-check/success-popup.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  assert.match(await text('#technical-content'),/PATCH \/api\/v2\/tasks\/A1/,'Mutation result survives background refresh');
  await action('#page','Thành viên'); await waitFor(`!!document.getElementById('member-form')`);
  await submit('#member-form'); await waitFor(`!!document.querySelector('[data-member="admin-alpha"]')`);
  assert.equal(await evaluate(`document.getElementById('success-popup').open`),true);
  assert.match(await text('#success-popup'),/Đã thêm thành viên/);
  await dismissPermission();
  await action('[data-member="admin-alpha"]','Đổi role');
  await waitFor(`document.getElementById('modal').open && !!document.getElementById('role-form')`);
  await fill('#role-value','Member'); await submit('#role-form');
  await waitFor(`document.querySelector('[data-member="admin-alpha"]').textContent.includes('Member')`);
  assert.match(await text('#success-popup'),/Đã cập nhật vai trò/); await dismissPermission();
  await evaluate(`document.querySelector('[data-member="admin-alpha"] .danger').click()`); await action('#modal','Xác nhận');
  await waitFor(`!document.getElementById('modal').open && !document.querySelector('[data-member="admin-alpha"]')`);
  assert.match(await text('#success-popup'),/Đã xóa thành viên/); await dismissPermission();
  await evaluate(`document.querySelector('[data-member="alice"] .danger').click()`); await action('#modal','Xác nhận');
  await waitFor(`document.getElementById('permission-popup').open`);
  assert.match(await text('#permission-popup'),/Không thể thay đổi chủ dự án/);
  assert.equal(await text('#modal-content [role="status"]'),'','Owner deletion error is not repeated in confirmation');
  await click('#permission-dismiss'); await click('#close-modal');
  await action('[data-member="alice"]','Đổi role'); await submit('#role-form');
  await waitFor(`document.getElementById('permission-popup').open`);
  assert.match(await text('#permission-popup'),/Không thể thay đổi chủ dự án/);
  assert.equal(await text('#role-form [role="status"]'),'','Owner role error is not repeated in form');
  assert.equal(await evaluate(`document.getElementById('success-popup').open`),false);
  await click('#permission-dismiss'); await click('#close-modal');
  // Every failed membership write shows a result popup, including 404 and 409.
  await fill('#member-operation','role'); await fill('#member-user','missing'); await submit('#member-form');
  await waitFor(`document.getElementById('permission-popup').open`);
  assert.match(await text('#permission-popup'),/Không tìm thấy thành viên/);
  await click('#permission-dismiss');
  await fill('#member-operation','add'); await fill('#member-user','bob'); await submit('#member-form');
  await waitFor(`document.getElementById('permission-popup').open`);
  assert.match(await text('#permission-popup'),/Thành viên đã có trong dự án/);
  await click('#permission-dismiss');
  // Viewer can read tasks but cannot edit, list or mutate memberships in V2.
  await login('vera'); await project('alpha'); await waitFor(`!!document.querySelector('[data-task="A1"]')`);
  await task('A1'); await fill('#task-title','Forbidden draft'); await save();
  await waitFor(`document.getElementById('permission-popup').open`);
  assert.equal(await evaluate(`document.getElementById('success-popup').open`),false,'Denied write never reports success');
  assert.match(await text('#permission-popup'),/chưa có quyền/);
  assert.match(await text('#permission-help'),/dữ liệu đã lưu vẫn giữ nguyên/);
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
  writeFileSync('.local-check/permission-popup.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await click('#permission-dismiss');
  assert.equal(await evaluate(`document.getElementById('modal').open`),true,'Permission dismissal preserves edit dialog');
  await call('Emulation.setDeviceMetricsOverride',{width:1360,height:1000,deviceScaleFactor:1,mobile:false});
  assert.equal(await text('#task-form [role="status"]'),''); assert.equal(await evaluate(`document.getElementById('task-title').value`),'Forbidden draft');
  assert.equal(db.prepare('SELECT title FROM tasks WHERE id = ?').get('A1').title,'UI persisted title'); await click('#close-modal');
  await action('#page','Thành viên'); await waitFor(`!!document.getElementById('member-form')`);
  assert.match(await text('#project-content'),/Không thể xem danh sách/); await submit('#member-form');
  await waitFor(`document.getElementById('permission-popup').open`);
  assert.equal(await text('#member-form [role="status"]'),'');
  // V1 Viewer editing succeeds; V2 introduces role checks.
  await version('v1'); await waitFor(`!!document.querySelector('[data-task="A1"]')`);
  await task('A1'); await fill('#task-title','Viewer V1 allowed'); await save(); await waitFor(`document.getElementById('page').textContent.includes('Viewer V1 allowed')`);
  await login('bob'); await version('v2'); await waitFor(`document.querySelectorAll('.project-card').length===2`); await project('alpha'); await waitFor(`!!document.querySelector('[data-task="A2"]')`);
  await task('A2'); await fill('#task-title','Closed V2 allowed'); await save(); await waitFor(`document.getElementById('page').textContent.includes('Closed V2 allowed')`);
  await version('v3'); await waitFor(`!!document.querySelector('[data-task="A2"]')`); await task('A2'); await save(); assert.match(await text('#permission-popup'),/Công việc đã đóng/); assert.equal(await text('#task-form [role="status"]'),''); await click('#close-modal');
  await task('A3'); await save(); assert.match(await text('#permission-popup'),/chưa được giao cho bạn/); await click('#close-modal');
  await task('A1'); await fill('#task-status','Closed'); await save(); await waitFor(`!document.getElementById('modal').open`);
  await task('A1'); await fill('#task-status','Open'); await save(); assert.match(await text('#permission-popup'),/Công việc đã đóng/); await click('#close-modal');
  await action('#page','Xóa project'); await action('#modal','Xác nhận'); await waitFor(`document.getElementById('permission-popup').open`); assert.equal(await text('#modal-content [role="status"]'),''); await click('#close-modal');
  await reset(); await login('admin-alpha'); await version('v4'); await waitFor(`document.querySelectorAll('.project-card').length===2`); await project('alpha'); await waitFor(`!!document.querySelector('[data-task="A1"]')`);
  await click('#home'); await waitFor(`document.querySelectorAll('.project-card').length===2`); await project('beta'); await waitFor(`!!document.querySelector('#page .empty.error')`);
  // Public UI entry points also exercise anonymous, spoofing and GET comparison.
  await evaluate(`document.getElementById('demo-tools').open=true`); await fill('#raw-token',''); await fill('#raw-path','tasks/A1'); await submit('#raw-form');
  await waitFor(`document.getElementById('notice').textContent.includes('Chưa xác thực')`);
  await fill('#raw-token','demo-admin-alpha'); await fill('#raw-path','tasks/B1'); await fill('#raw-query','tenantId=beta&role=Admin'); await fill('#raw-headers','{"X-Role":"Admin"}'); await submit('#raw-form');
  await waitFor(`document.getElementById('permission-popup').open`);
  assert.equal(await evaluate(`document.getElementById('notice').hidden`),true,'Popup error is not repeated in page banner');
  await fill('#raw-token','demo-alice'); await fill('#raw-query',''); await click('#compare'); await waitFor(`!document.getElementById('compare').disabled`);
  assert.match(await text('#notice'),/Starter 200 → V1 403/);
  await fill('#history','1'); await evaluate(`document.getElementById('history').dispatchEvent(new Event('change'))`); assert.match(await text('#technical-content'),/SKIPPED/);
  await click('#home'); await waitFor(`document.querySelectorAll('.project-card').length===2`);
  await fill('#raw-method','PATCH'); await fill('#raw-path','tasks/A1'); await fill('#raw-body',JSON.stringify({title:'Alpha · Build API'})); await submit('#raw-form');
  await waitFor(`document.getElementById('success-popup').open`);
  assert.match(await text('#success-popup'),/Đã thực hiện thao tác ghi/);
  await fill('#raw-method','PATCH'); await fill('#raw-path','tasks/A1'); await fill('#raw-body','{broken'); await submit('#raw-form');
  await waitFor(`!document.querySelector('#raw-form button').disabled`);
  assert.equal(db.prepare('SELECT title FROM tasks WHERE id = ?').get('A1').title,'Alpha · Build API');
  await fill('#raw-method','GET'); await fill('#raw-path','tasks/missing'); await submit('#raw-form');
  await waitFor(`document.getElementById('notice').textContent.includes('không còn tồn tại')`);
  // Hold a real response until after a version switch, deterministically.
  await login('alice'); await version('starter'); await waitFor(`document.querySelectorAll('.project-card').length===2`);
  await evaluate(`window.originalFetch=window.fetch; window.held=false; window.released=false; window.fetch=async (...args)=>{const response=await window.originalFetch(...args);if(String(args[0])==='/api/starter/projects/beta/tasks'){window.held=true;await new Promise(resolve=>window.releaseHeld=resolve);window.released=true;}return response;};`);
  await project('beta'); await waitFor('window.held'); await version('v1'); await waitFor(`!!document.querySelector('#page .empty.error')`);
  await evaluate('window.releaseHeld()'); await waitFor('window.released'); await evaluate('window.fetch=window.originalFetch');
  assert.doesNotMatch(await text('#page'),/Private Beta|roadmap|B1/);
  assert.doesNotMatch(await text('#technical-content'),/Private Beta|roadmap/);
  // The same guard must discard a response after changing accounts.
  await version('starter'); await waitFor(`!!document.querySelector('[data-task="B1"]')`);
  await evaluate(`window.held=false; window.released=false; window.fetch=async (...args)=>{const response=await window.originalFetch(...args);if(String(args[0])==='/api/starter/tasks/B1'){window.held=true;await new Promise(resolve=>window.releaseHeld=resolve);window.released=true;}return response;};`);
  await evaluate(`document.querySelector('[data-task="B1"] button').click()`); await waitFor('window.held');
  await login('vera'); await evaluate('window.releaseHeld()'); await waitFor('window.released'); await evaluate('window.fetch=window.originalFetch');
  assert.equal(await evaluate(`document.getElementById('modal').open`),false);
  assert.doesNotMatch(await text('#technical-content'),/Private Beta|roadmap/);
  await login('alice');
  // Successful delete removes project; reset restores it.
  await version('v2'); await click('#home'); await waitFor(`document.querySelectorAll('.project-card').length===2`); await project('alpha'); await waitFor(`!!document.querySelector('[data-task="A1"]')`);
  await action('#page','Xóa project'); await action('#modal','Xác nhận'); await waitFor(`document.querySelectorAll('.project-card').length===1`);
  assert.equal(await evaluate(`document.getElementById('success-popup').open`),true);
  assert.match(await text('#success-popup'),/Đã xóa dự án/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks WHERE projectId = ?').get('alpha').n,0);
  await reset(); await project('alpha'); await waitFor(`!!document.querySelector('[data-task="A1"]')`);
  await call('Emulation.setDeviceMetricsOverride',{width:1360,height:1100,deviceScaleFactor:1,mobile:false});
  mkdirSync('.local-check',{recursive:true});
  const shot = await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  writeFileSync('.local-check/ui.png',Buffer.from(shot.data,'base64'));
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true,'Mobile layout overflows');
  writeFileSync('.local-check/mobile.png',Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true})).data,'base64'));
  await task('A1');
  writeFileSync('.local-check/task-form-mobile.png',Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true})).data,'base64'));
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await waitFor(`!document.getElementById('modal').open`);
  assert.deepEqual(errors,[],'Browser JS errors');
  console.log('UI smoke PASS: app navigation, V1–V4, task forms, members, delete/reset, anonymous/spoofing/compare, stale response, mobile; no browser JS errors.');
} finally {
  socket?.close(); browser.kill();
  await new Promise(resolve => server.close(resolve)); db.close();
  await delay(400);
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
