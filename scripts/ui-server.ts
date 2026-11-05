import express, { type ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Lab, LabEvent, Service } from './lab.js';
import type { Mode } from '../src/shared/types.js';
import { F4Recovery } from './f4-recovery.js';

export async function startUI(lab: Lab): Promise<() => Promise<void>> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  const enabled = lab.env.ENABLE_FAULTS === 'true' && lab.env.MANAGE_SERVICES !== 'false';
  const services: Service[] = ['order', 'inventory', 'payment'];
  const controls = new Map<Service, {action:'start'|'stop';work:Promise<unknown>}>();
  async function control(service: Service, action: 'start' | 'stop') {
    const current=controls.get(service);
    if(current){if(current.action===action)return current.work;await current.work.catch(()=>{});return control(service,action);}
    const work = (action === 'start' ? lab.start(service) : lab.stop(service)).finally(() => controls.delete(service));
    controls.set(service, {action,work});
    return work;
  }
  const f4=new F4Recovery(lab,control);
  const observe = (entry: LabEvent) => {
    const dir = lab.env.LOG_DIR!;
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'supervisor.jsonl'), `${JSON.stringify(entry)}\n`);
    if (enabled && lab.env.AUTO_KILL_MARKERS === 'true') {
      if(entry.event==='PAYMENT_CHARGE_COMMITTED_BEFORE_RESPONSE'){void f4.interrupt(entry).catch(error=>lab.publish({time:new Date().toISOString(),service:'ui',event:'CONTROL_ERROR',message:String(error)}));return;}
      const service = ['COORDINATOR_BEFORE_CHARGE_OUTCOME','COORDINATOR_BEFORE_REFUND_OUTCOME'].includes(entry.event) ? 'order' : null;
      if (service) void control(service, 'stop').catch(error => lab.publish({ time: new Date().toISOString(), service: 'ui', event: 'CONTROL_ERROR', message: String(error) }));
    }
  };
  const supervisorFile=join(lab.env.LOG_DIR!,'supervisor.jsonl');
  const startupEvents=[...lab.events];
  if(existsSync(supervisorFile)){
    const history:LabEvent[]=[];
    for(const line of readFileSync(supervisorFile,'utf8').split('\n')){
      try{const entry=JSON.parse(line) as LabEvent;if(typeof entry.time==='string' && typeof entry.event==='string')history.push(entry);}catch{}
    }
    lab.events.unshift(...history);
  }
  lab.listeners.add(observe);
  for(const entry of startupEvents)observe(entry);
  app.get('/health', (req, res) => res.json({ service: 'ui', status: 'ok', pid: process.pid }));
  app.get('/api/:mode/config', (req, res) => {
    if (!['baseline','saga'].includes(req.params.mode)) return res.status(400).json({ error:'INVALID_MODE' });
    res.json({ mode:req.params.mode, faultsEnabled:lab.env.ENABLE_FAULTS === 'true', maxRetries:Number(lab.env.SAGA_MAX_RETRIES ?? 3), recoveryIntervalMs:Number(lab.env.RECOVERY_INTERVAL_MS),f4DowntimeMs:Number(lab.env.F4_DOWNTIME_MS ?? 4000) });
  });
  app.get('/lab/health', async (req, res) => {
    const results = await Promise.all(services.map(async service => {
      try {
        const response = await fetch(`${lab.url(service)}/health`, { signal: AbortSignal.timeout(600) });
        const health = await response.json() as { pid: number };
        return { service, available: response.ok, pid: health.pid, url: lab.url(service) };
      } catch { return { service, available: false, pid: null, url: lab.url(service) }; }
    }));
    res.json({ services: results, controlsEnabled: enabled, automaticCrashMarkers: lab.env.AUTO_KILL_MARKERS === 'true',f4Recovery:f4.state });
  });
  app.get('/lab/events', (req, res) => {
    const orderId=typeof req.query.orderId==='string'?req.query.orderId:null;
    const mode=typeof req.query.mode==='string'?req.query.mode:null;
    const since=typeof req.query.since==='string'?req.query.since:null;
    const lifecycle=['READY','PROCESS_KILLED','PROCESS_STOPPED','PROCESS_EXITED','SERVICE_CONTROL_REQUESTED','SERVICE_CONTROL_SUCCEEDED','SERVICE_CONTROL_FAILED'];
    res.json(lab.events.filter(e=>(!mode || !e.mode || e.mode===mode) && (!since || e.time>=since) && (!orderId || e.orderId===orderId || (!e.orderId && lifecycle.includes(e.event)))));
  });
  app.post('/lab/services/:service/:action', async (req, res) => {
    if (!enabled) return res.status(403).json({ error: 'FAULTS_DISABLED' });
    const service = req.params.service as Service;
    const action = req.params.action;
    if (!services.includes(service) || !['start', 'stop'].includes(action)) return res.status(400).json({ error: 'INVALID_SERVICE_ACTION' });
    // Only child processes owned by this launcher are controlled, never arbitrary system PIDs.
    const context={...(typeof req.body?.orderId==='string'?{orderId:req.body.orderId}:{}),...(['baseline','saga'].includes(req.body?.mode)?{mode:req.body.mode}:{}),action};
    lab.publish({time:new Date().toISOString(),service,event:'SERVICE_CONTROL_REQUESTED',...context,method:'POST',path:req.originalUrl});
    try{
      if(service==='payment' && action==='start' && f4.state)await f4.restore('manual');
      else{if(service==='payment' && action==='stop')f4.cancel();await control(service, action as 'start' | 'stop');}
      lab.publish({time:new Date().toISOString(),service,event:'SERVICE_CONTROL_SUCCEEDED',...context,method:'POST',path:req.originalUrl,status:200,response:{service,action,accepted:true}});
      res.json({ service, action, accepted: true });
    }catch(error){
      lab.publish({time:new Date().toISOString(),service,event:'SERVICE_CONTROL_FAILED',...context,method:'POST',path:req.originalUrl,status:500,message:String(error)});
      throw error;
    }
  });
  app.use('/api/:mode', async (req, res) => {
    if (!['baseline', 'saga'].includes(req.params.mode)) return res.status(400).json({ error: 'INVALID_MODE' });
    let service: Service = 'order';
    let path = req.url;
    if (path.startsWith('/inventory/')) { service = 'inventory'; path = path.slice('/inventory'.length); }
    if (path.startsWith('/payments/')) { service = 'payment'; path = path.slice('/payments'.length); }
    const started=Date.now();
    const record=(status:number,body:unknown,transportError?:string)=>{
      if(req.method==='GET' || req.method==='HEAD')return;
      const result=body as {order_id?:string;order?:{id?:string};payment?:{order_id?:string};reservation?:{order_id?:string}} | null;
      const orderId=result?.order_id || result?.order?.id || result?.payment?.order_id || result?.reservation?.order_id || path.match(/^\/(?:orders|sagas|faults)\/([^/?]+)/)?.[1] || (typeof req.body?.orderId==='string'?req.body.orderId:undefined);
      lab.publish({time:new Date().toISOString(),service,event:'CLIENT_HTTP',mode:req.params.mode as Mode,...(orderId?{orderId}:{}),method:req.method,path:req.originalUrl,status,request:req.body,response:body,durationMs:Date.now()-started,...(transportError?{transportError}:{})});
    };
    try {
      const response = await fetch(`${lab.url(service)}/api/${req.params.mode}${path}`, {
        method: req.method, headers: { 'content-type': 'application/json', ...(req.get('Idempotency-Key') ? { 'Idempotency-Key': req.get('Idempotency-Key')! } : {}) },
        ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: JSON.stringify(req.body ?? {}) } : {}), signal: AbortSignal.timeout(5000),
      });
      const body = await response.text();
      let parsed:unknown=body;try{parsed=JSON.parse(body);}catch{}
      record(response.status,parsed);
      res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(body);
    } catch { const body={error:'SERVICE_UNAVAILABLE',service};record(503,body,'NETWORK_ERROR');res.status(503).json(body); }
  });
  const errors: ErrorRequestHandler = (error, req, res, next) => res.status(500).json({ error: 'UI_CONTROL_ERROR', message: String(error) });
  app.use(errors);
  const runtimeDir = join(lab.env.DATA_DIR!, '.runtime');
  const runtimeFile = join(runtimeDir, 'ui.json');
  const server = app.listen(lab.ports.ui, '127.0.0.1');
  await new Promise<void>((resolveReady, reject) => { server.once('listening', resolveReady); server.once('error', reject); });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(runtimeFile, JSON.stringify({ service: 'ui', pid: process.pid, port: lab.ports.ui }));
  if(enabled)await f4.recoverOnStartup();
  return async () => {
    await f4.close();
    lab.listeners.delete(observe);
    await Promise.allSettled([...controls.values()].map(c=>c.work));
    await new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections(); });
    rmSync(runtimeFile, { force: true });
  };
}
