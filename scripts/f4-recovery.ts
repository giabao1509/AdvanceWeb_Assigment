import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import type {Lab,LabEvent,Service} from './lab.js';
import type {Mode} from '../src/shared/types.js';

export interface F4Outage {
  id:string;orderId:string;mode:Mode;downtimeMs:number;restoreAt:number;
  status:'stopping'|'waiting'|'starting'|'failed';error?:string;
}
export class F4Recovery {
  state:F4Outage|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private restoring:Promise<unknown>|null=null;
  private closing=false;
  private file:string;
  constructor(private lab:Lab,private control:(service:Service,action:'start'|'stop')=>Promise<unknown>){
    this.file=join(lab.env.DATA_DIR!,'f4-recovery.json');
    if(existsSync(this.file)){
      try{
        const saved=JSON.parse(readFileSync(this.file,'utf8')) as F4Outage;
        if(typeof saved.id==='string' && typeof saved.orderId==='string' && ['baseline','saga'].includes(saved.mode) && Number.isFinite(saved.restoreAt) && ['stopping','waiting','starting','failed'].includes(saved.status))this.state=saved;
      }catch{}
    }
  }
  private save(){if(this.state)writeFileSync(this.file,JSON.stringify(this.state));else rmSync(this.file,{force:true});}
  private publish(event:string,extra:Record<string,unknown>={}){
    this.lab.publish({time:new Date().toISOString(),service:'payment',event,orderId:this.state?.orderId,mode:this.state?.mode,...extra});
  }
  private clearTimer(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
  async interrupt(entry:LabEvent){
    if(this.closing || this.state)return; // Payment is shared: concurrent markers must not schedule overlapping restarts.
    if(typeof entry.orderId!=='string' || !['baseline','saga'].includes(String(entry.mode)))return;
    const duration=Number(entry.downtimeMs ?? this.lab.env.F4_DOWNTIME_MS ?? 4000);
    if(!Number.isSafeInteger(duration) || duration<0 || duration>60000)throw new Error('Invalid F4 downtime');
    this.state={id:randomUUID(),orderId:entry.orderId,mode:entry.mode as Mode,downtimeMs:duration,restoreAt:0,status:'stopping'};this.save();
    try{
      await this.control('payment','stop');
      if(this.closing || !this.state || this.state.status!=='stopping')return;
      this.state.status='waiting';this.state.restoreAt=Date.now()+duration;this.save();
      this.publish('F4_OUTAGE_STARTED',{downtimeMs:duration,restoreAt:this.state.restoreAt});
      this.timer=setTimeout(()=>{void this.restore('timer').catch(()=>{});},duration);
    }catch(error){if(this.state){this.state.status='failed';this.state.error=String(error);this.save();this.publish('F4_RESTORE_FAILED',{message:String(error)});}throw error;}
  }
  restore(reason:'timer'|'manual'|'launcher-restart'):Promise<unknown>{
    if(this.restoring)return this.restoring;
    if(this.closing)return Promise.resolve();
    if(!this.state)return this.control('payment','start');
    this.clearTimer();
    const outage=this.state;outage.status='starting';delete outage.error;this.save();this.publish('F4_RESTORE_STARTED',{reason});
    this.restoring=(async()=>{
      try{
        await this.control('payment','start'); // Resolves only when the actual child passes health/readiness.
        if(this.state?.id===outage.id){this.clearTimer();this.publish('F4_RESTORE_COMPLETED',{reason});this.state=null;this.save();}
      }catch(error){
        if(this.state?.id===outage.id){outage.status='failed';outage.error=String(error);this.save();this.publish('F4_RESTORE_FAILED',{message:String(error)});}
        throw error;
      }finally{this.restoring=null;}
    })();
    return this.restoring;
  }
  cancel(){
    this.clearTimer();if(this.state)this.publish('F4_RESTORE_CANCELLED');this.state=null;this.save();
  }
  async recoverOnStartup(){if(this.state)await this.restore('launcher-restart').catch(()=>{});}
  async close(){this.closing=true;this.clearTimer();await this.restoring?.catch(()=>{});}
}
