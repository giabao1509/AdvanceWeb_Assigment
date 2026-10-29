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
  const preset = async index => evaluate(`document.getElementById('preset').value='${index}'; document.getElementById('preset').dispatchEvent(new Event('change'));`);
  const version = async v => evaluate(`document.querySelector('[data-version="${v}"]').click()`);
  const send = async status => {
    await evaluate(`document.getElementById('send').click()`);
    await waitFor(`!document.getElementById('send').disabled`);
    assert.equal(await evaluate(`document.getElementById('status').textContent`),String(status));
  };
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
  await waitFor(`document.querySelectorAll('#versions button').length === 5`);
  await preset(0); await evaluate(`document.getElementById('compare').click()`);
  await waitFor(`!document.getElementById('send').disabled`);
  assert.equal(await evaluate(`document.getElementById('status').textContent`),'200 → 403');
  assert.match(await evaluate(`document.getElementById('trace').textContent`),/SKIPPED/);
  await version('v1'); await preset(1); await send(200);
  await preset(3); await send(401);
  await version('v2'); await preset(6); await send(200);
  await version('v3'); await send(403);
  await preset(5); await send(200);
  await preset(7); await send(403);
  await preset(12); await send(403);
  await version('v4'); await preset(13); await send(200);
  await preset(14); await send(403);
  await evaluate(`document.getElementById('reset').click()`);
  await waitFor(`!document.getElementById('reset').disabled`);
  assert.equal(await evaluate(`document.getElementById('status').textContent`),'ĐÃ RESET');
  // Browser-visible malformed JSON should report an error without making a request.
  await version('v3'); await preset(5);
  await evaluate(`document.getElementById('payload').value = '{broken'`);
  await evaluate(`document.getElementById('send').click()`);
  await waitFor(`!document.getElementById('send').disabled`);
  assert.equal(await evaluate(`document.getElementById('status').textContent`),'LỖI GỬI REQUEST');
  await preset(0); await version('v1');
  await evaluate(`document.getElementById('compare').click()`); await waitFor(`!document.getElementById('send').disabled`);
  await call('Emulation.setDeviceMetricsOverride',{width:1360,height:1100,deviceScaleFactor:1,mobile:false});
  mkdirSync('.local-check',{recursive:true});
  const shot = await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  writeFileSync('.local-check/ui.png',Buffer.from(shot.data,'base64'));
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true,'Mobile layout overflows');
  assert.deepEqual(errors,[],'Browser JS errors');
  console.log('UI smoke PASS: compare, V1–V4, anonymous, edit/deny, spoofing, reset, invalid JSON, mobile layout; no browser JS errors.');
} finally {
  socket?.close(); browser.kill();
  await new Promise(resolve => server.close(resolve)); db.close();
  await delay(400);
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
