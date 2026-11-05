import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Lab,Snapshot} from './lab.js';
import type {Saga,Movement,LedgerEntry,Wallet} from '../src/shared/types.js';
import type {Trace} from '../public/log-format.js';

export type CompensationPhase='01-before-stop'|'02-after-restart'|'03-converged';
export type PhaseObserver=(lab:Lab,id:string,scenario:'F5'|'F6',phase:CompensationPhase)=>Promise<void>;
export async function captureCompensation(lab:Lab,id:string,scenario:'F5'|'F6',phase:CompensationPhase,output:string,observe?:PhaseObserver){
  const capturedAt=new Date().toISOString();
  const [snapshot,saga,traces,movements,ledger,wallets]=await Promise.all([
    lab.request<Snapshot>('saga',`/orders/${id}/snapshot`).then(r=>r.body),
    lab.request<Saga & {operations:Record<string,string>;pending:string[];intent:{action:string;operationId:string}|null}>('saga',`/sagas/${id}`).then(r=>r.body),
    lab.request<Trace[]>('saga',`/orders/${id}/traces`).then(r=>r.body),
    lab.request<Movement[]>('saga',`/movements?orderId=${id}`,{},'inventory').then(r=>r.body),
    lab.request<LedgerEntry[]>('saga',`/ledger?orderId=${id}`,{},'payment').then(r=>r.body),
    lab.request<Wallet[]>('saga','/wallets',{},'payment').then(r=>r.body),
  ]);
  const record={scenario,phase,capturedAt,completedAt:new Date().toISOString(),pids:Object.fromEntries([...lab.children].map(([s,p])=>[s,p.pid])),snapshot,saga,traces,movements,ledger,wallets};
  mkdirSync(output,{recursive:true});writeFileSync(join(output,`${scenario.toLowerCase()}-${phase}.json`),JSON.stringify(record,null,2));
  await observe?.(lab,id,scenario,phase);
  return record;
}
