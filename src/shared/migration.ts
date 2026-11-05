import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const quoted=(name:string)=>`"${name.replaceAll('"','""')}"`;
type Column={name:string};

// The old files remain untouched. Merge into a new, staged database before publishing it.
export function importLegacy(db:DatabaseSync,dataDir:string,service:string){
  const sources:Record<string,unknown>[]=[];
  const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as {name:string}[]).map(r=>r.name);
  for(const mode of ['baseline','saga'] as const){
    const file=join(dataDir,mode,`${service}.sqlite`);
    if(!existsSync(file))continue;
    const old=new DatabaseSync(file,{readOnly:true});
    try{
      const counts:Record<string,number>={};
      for(const table of tables){
        if(!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
        const targetColumns=(db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as Column[]).map(c=>c.name);
        const oldColumns=(old.prepare(`PRAGMA table_info(${quoted(table)})`).all() as Column[]).map(c=>c.name);
        const columns=targetColumns.filter(c=>oldColumns.includes(c) || c==='mode');
        const rows=old.prepare(`SELECT * FROM ${quoted(table)} ORDER BY rowid`).all();
        let suffix='';
        if(table==='stock')suffix=' ON CONFLICT(sku) DO UPDATE SET available=stock.available+excluded.available';
        if(table==='wallets')suffix=' ON CONFLICT(id) DO UPDATE SET balance=wallets.balance+excluded.balance';
        const insert=db.prepare(`INSERT INTO ${quoted(table)} (${columns.map(quoted).join(',')}) VALUES (${columns.map(()=>'?').join(',')})${suffix}`);
        for(const row of rows){
          const values=columns.map(c=>c==='mode'?mode:table==='movements' && c==='source' && row.source==='LIVE'?`LEGACY_${mode.toUpperCase()}`:row[c]) as SQLInputValue[];
          try{insert.run(...values);}catch(error){throw new Error(`Cannot merge ${mode}/${service}.${table}; original files are unchanged: ${String(error)}`);}
        }
        counts[table]=rows.length;
      }
      sources.push({mode,file,counts});
    }finally{old.close();}
  }
  return sources;
}
