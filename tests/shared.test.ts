import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {isolatedLab,waitFor,type Lab} from '../scripts/lab.js';
import type {Order,Wallet,Movement,LedgerEntry,Mode} from '../src/shared/types.js';
let lab:Lab;
beforeEach(async()=>{lab=await isolatedLab('shared',{SAGA_MAX_RETRIES:'0'});await lab.startAll();});
afterEach(async()=>{await lab.close();});

test('both policies share orders, stock, wallets and history; reads do not change the recorded policy',async()=>{
 const first=(await lab.create('baseline','F3','same-create-key')).body.order.id;
 const baseline=await lab.settled('baseline',first);assert.equal(baseline.order.status,'FAILED');
 const second=(await lab.create('saga','H','same-create-key')).body.order.id;
 await lab.settled('saga',second);
 const lists=await Promise.all((['baseline','saga'] as Mode[]).map(m=>lab.request<Order[]>(m,'/orders').then(r=>r.body)));
 assert.deepEqual(lists[0],lists[1]);assert.equal(lists[0].length,2);
 assert.equal(lists[0].find(o=>o.id===first)!.mode,'baseline');assert.equal(lists[0].find(o=>o.id===second)!.mode,'saga');
 for(const mode of ['baseline','saga'] as const){
  assert.equal((await lab.request<Wallet[]>(mode,'/wallets',{},'payment')).body[0].balance,9100000);
  assert.equal((await lab.request<{available:number}[]>(mode,'/stock',{},'inventory')).body[0].available,18);
  assert.equal((await lab.request<LedgerEntry[]>(mode,'/ledger',{},'payment')).body.length,2);
  assert.equal((await lab.request<Movement[]>(mode,'/movements',{},'inventory')).body.length,2);
 }
 const replay=await lab.create('baseline','F3','same-create-key');assert.equal(replay.body.order.id,first);assert.equal(replay.body.replayed,true);
 await lab.stop('order');await lab.start('order');
 assert.equal((await lab.request<{order:Order}>('saga',`/orders/${first}`)).body.order.mode,'baseline');
 assert.equal((await lab.request<{order:Order}>('baseline',`/orders/${second}`)).body.order.status,'CONFIRMED');
 assert(!existsSync(join(lab.env.DATA_DIR!,'baseline')));assert(!existsSync(join(lab.env.DATA_DIR!,'saga')));
});

test('pay through the opposite URL still uses the immutable policy of the original order',async()=>{
 for(const mode of ['baseline','saga'] as const){
  const other=mode==='baseline'?'saga':'baseline';
  const r=await lab.request<{order:Order}>(mode,'/orders',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({sku:'LAMP-01',quantity:1,checkout_mode:'manual'})});
  const id=r.body.order.id;await waitFor(async()=> (await lab.request<{order:Order}>(other,`/orders/${id}`)).body.order.status==='AWAITING_PAYMENT');
  await lab.request(other,`/orders/${id}/pay`,{method:'POST',body:JSON.stringify({walletId:'limited'})});
  const result=await lab.settled(other,id);assert.equal(result.order.mode,mode);
  assert.equal(result.order.status,mode==='saga'?'CANCELLED':'FAILED');
  assert.equal(result.inventory.data!.reservation!.status,mode==='saga'?'RELEASED':'HELD');
 }
});

test('merge both old stores once, preserving IDs, scoped create keys, balances, traces and originals',async()=>{
 const first=(await lab.create('baseline','F3','overlapping-key')).body.order.id;await lab.settled('baseline',first);await lab.close();
 const baselineDir=lab.env.DATA_DIR!;
 lab=await isolatedLab('migration-saga-source');await lab.startAll();
 const second=(await lab.create('saga','H','overlapping-key')).body.order.id;await lab.settled('saga',second);await lab.close();
 const sagaDir=lab.env.DATA_DIR!;
 lab=await isolatedLab('merge-destination');
 for(const [mode,source] of [['baseline',baselineDir],['saga',sagaDir]]){
  const destination=join(lab.env.DATA_DIR!,mode);mkdirSync(destination,{recursive:true});
  for(const service of ['order','inventory','payment']){
   const db=new DatabaseSync(join(source,`${service}.sqlite`),{readOnly:true});try{await backup(db,join(destination,`${service}.sqlite`));}finally{db.close();}
  }
 }
 await lab.startAll();
 assert.equal((await lab.request<Order[]>('saga','/orders')).body.length,2);
 assert.equal((await lab.request<Wallet[]>('baseline','/wallets',{},'payment')).body[0].balance,19100000);
 assert.equal((await lab.request<{available:number}[]>('saga','/stock',{},'inventory')).body[0].available,38);
 assert.equal((await lab.request<LedgerEntry[]>('baseline','/ledger',{},'payment')).body.length,2);
 const movements=(await lab.request<Movement[]>('saga','/movements',{},'inventory')).body;
 assert(movements.some(m=>m.source==='LEGACY_BASELINE'));assert(movements.some(m=>m.source==='LEGACY_SAGA'));
 const replay=(await lab.create('baseline','F3','overlapping-key')).body;assert.equal(replay.order.id,first);assert(replay.replayed);
 assert.equal((await lab.create('saga','H','overlapping-key')).body.order.id,second);
 assert.equal((await lab.request<unknown[]>('saga',`/orders/${first}/traces`)).body.length,2);
 for(const service of ['order','inventory','payment']){
  const receipt=JSON.parse(readFileSync(join(lab.env.DATA_DIR!,`migration-${service}.json`),'utf8'));assert.equal(receipt.sources.length,2);
 }
 await lab.stop('order');await lab.stop('inventory');await lab.stop('payment');
 for(const mode of ['baseline','saga']){
  const old=new DatabaseSync(join(lab.env.DATA_DIR!,mode,'order.sqlite'),{readOnly:true});assert.equal(old.prepare('SELECT COUNT(*) AS n FROM orders').get()!.n,1);old.close();
 }
 await lab.start('inventory');await lab.start('payment');await lab.start('order');
 assert.equal((await lab.request<Wallet[]>('saga','/wallets',{},'payment')).body[0].balance,19100000);
 assert.equal((await lab.request<Order[]>('baseline','/orders')).body.length,2);
 await lab.close();
 const reset=spawn(process.execPath,['--import','tsx','scripts/reset.ts'],{cwd:process.cwd(),env:lab.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='';reset.stdout.on('data',c=>output+=c);reset.stderr.on('data',c=>output+=c);
 const code=await new Promise<number|null>((resolve,reject)=>{reset.once('error',reject);reset.once('exit',resolve);});assert.equal(code,0,output);
 assert(!existsSync(join(lab.env.DATA_DIR!,'order.sqlite')));assert(!existsSync(join(lab.env.DATA_DIR!,'baseline')));
 await lab.startAll();assert.equal((await lab.request<Order[]>('saga','/orders')).body.length,0);
 assert.equal((await lab.request<Wallet[]>('baseline','/wallets',{},'payment')).body[0].balance,10000000);
});
