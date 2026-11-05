import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../src/shared/config.js';

const args=process.argv.slice(2);
const exporting=args.includes('--export');
const filters=args.filter(arg=>arg!=='--export');
const mode=['baseline','saga'].includes(filters[0])?filters.shift():null;
const [requestedId]=filters;
const paths=Object.fromEntries(['order','inventory','payment'].map(service=>[service,join(config.dataDir,`${service}.sqlite`)]));
for(const path of Object.values(paths))if(!existsSync(path))throw new Error(`Chưa có DB: ${path}. Khởi động app trước.`);
const databases=Object.fromEntries(Object.entries(paths).map(([service,path])=>[service,new DatabaseSync(path,{readOnly:true})]));
const has=(service:string,table:string)=>!!databases[service].prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
try {
  if(exporting){
    const dir=resolve('.local','db-snapshots',`${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID().slice(0,6)}`,'shared');
    mkdirSync(dir,{recursive:true});
    for(const [service,db] of Object.entries(databases)){
      const file=join(dir,`${service}.sqlite`);await backup(db,file);
      const copy=new DatabaseSync(file);copy.exec('PRAGMA journal_mode=DELETE');copy.close();
      console.log(file);
    }
    console.log('Snapshot độc lập, đã gồm dữ liệu WAL. Mở các file trên trong viewer; đây không phải DB live.');
  }else{
    const order=requestedId?databases.order.prepare('SELECT * FROM orders WHERE id=?').get(requestedId):mode?databases.order.prepare('SELECT * FROM orders WHERE mode=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(mode):databases.order.prepare('SELECT * FROM orders ORDER BY created_at DESC,rowid DESC LIMIT 1').get();
    if(!order){console.log(JSON.stringify({mode,files:paths,order:null,message:'Không có đơn phù hợp.'},null,2));}
    else{
      const id=String(order.id);
      const rows=(service:string,table:string,column='order_id')=>has(service,table)?databases[service].prepare(`SELECT * FROM ${table} WHERE ${column}=? ORDER BY rowid`).all(id):[];
      console.log(JSON.stringify({mode,files:paths,order,
        saga:rows('order','sagas'),sagaHistory:rows('order','saga_events'),localOperations:rows('order','order_operations'),
        stock:databases.inventory.prepare('SELECT * FROM stock').all(),reservations:rows('inventory','reservations'),movements:rows('inventory','movements'),
        wallets:has('payment','wallets')?databases.payment.prepare('SELECT * FROM wallets').all():[],payments:rows('payment','payments'),
        ledger:databases.payment.prepare('SELECT l.*,p.order_id FROM ledger_entries l JOIN payments p ON p.id=l.payment_id WHERE p.order_id=? ORDER BY l.rowid').all(id),
        paymentOperations:rows('payment','operations')},null,2));
    }
  }
}finally{for(const db of Object.values(databases))db.close();}
