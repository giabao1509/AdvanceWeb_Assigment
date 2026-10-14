/**
 * Supervisor: chạy toàn bộ topology (PLAN §7), gom log, phục vụ dashboard và API điều khiển.
 *   npm start  →  http://localhost:4000
 */
import express from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const root = join(__dirname, "../..");
const PORT = Number(process.env.PORT ?? 4000);
const tsx = ["--import", "tsx"];

interface Instance {
  name: string;
  kind: "inventory" | "order";
  title: string;
  code: "source" | "bundle";
  args: string[];
  env: Record<string, string>;
  health: string;
  ports: string;
  child?: ChildProcess;
  status: "stopped" | "starting" | "running";
  pid?: number;
  info?: any;
  stoppedByUser?: boolean;
}

const I = (x: Omit<Instance, "status">): Instance => ({ ...x, status: "stopped" });
const instances: Instance[] = [
  I({
    name: "inventory-v2",
    kind: "inventory",
    title: "Inventory · server mới (proto v2)",
    code: "source",
    args: [...tsx, "src/inventory/main.ts"],
    env: { INSTANCE: "inventory-v2", REST_PORT: "5001", GRPC_PORT: "50051" },
    health: "http://127.0.0.1:5001/admin/state",
    ports: "REST :5001 · gRPC :50051",
  }),
  I({
    name: "inventory-v1",
    kind: "inventory",
    title: "Inventory · server cũ (proto v1, bundle)",
    code: "bundle",
    args: ["builds/inventory-v1.cjs"],
    env: { INSTANCE: "inventory-v1", REST_PORT: "5002", GRPC_PORT: "50052" },
    health: "http://127.0.0.1:5002/admin/state",
    ports: "REST :5002 · gRPC :50052",
  }),
  I({
    name: "order-rest",
    kind: "order",
    title: "Order API · REST baseline",
    code: "source",
    args: [...tsx, "src/order-api/main.ts"],
    env: { INSTANCE: "order-rest", TRANSPORT: "rest", PORT: "3001", INVENTORY_REST_URL: "http://127.0.0.1:5001" },
    health: "http://127.0.0.1:3001/health",
    ports: ":3001 → REST :5001",
  }),
  I({
    name: "order-grpc-v1",
    kind: "order",
    title: "Order API · gRPC client cũ (proto v1, bundle)",
    code: "bundle",
    args: ["builds/order-api-v1.cjs"],
    env: { INSTANCE: "order-grpc-v1", TRANSPORT: "grpc", PORT: "3002", INVENTORY_GRPC_TARGET: "127.0.0.1:50051" },
    health: "http://127.0.0.1:3002/health",
    ports: ":3002 → gRPC :50051",
  }),
  I({
    name: "order-grpc-v2",
    kind: "order",
    title: "Order API · gRPC client mới (proto v2)",
    code: "source",
    args: [...tsx, "src/order-api/main.ts"],
    env: { INSTANCE: "order-grpc-v2", TRANSPORT: "grpc", PORT: "3003", INVENTORY_GRPC_TARGET: "127.0.0.1:50051" },
    health: "http://127.0.0.1:3003/health",
    ports: ":3003 → gRPC :50051",
  }),
  I({
    name: "order-grpc-v2-oldsrv",
    kind: "order",
    title: "Order API · client mới → server cũ",
    code: "source",
    args: [...tsx, "src/order-api/main.ts"],
    env: { INSTANCE: "order-grpc-v2-oldsrv", TRANSPORT: "grpc", PORT: "3004", INVENTORY_GRPC_TARGET: "127.0.0.1:50052" },
    health: "http://127.0.0.1:3004/health",
    ports: ":3004 → gRPC :50052",
  }),
];
const byName = (n: string) => instances.find((i) => i.name === n);

// ---------- log bus ----------
const LOG_DIR = join(root, "logs");
mkdirSync(LOG_DIR, { recursive: true });
const ring: any[] = [];
const sseClients = new Set<express.Response>();
let seq = 0;

function emit(type: string, data: any) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(msg);
}
function pushLog(inst: string, line: string, stream: "stdout" | "stderr" | "supervisor") {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    entry = { ts: new Date().toISOString(), inst, event: stream === "stderr" ? "stderr" : "text", text: line };
  }
  entry.inst ??= inst;
  entry._seq = ++seq;
  entry._src = inst;
  ring.push(entry);
  if (ring.length > 3000) ring.shift();
  appendFileSync(join(LOG_DIR, `${inst}.log`), JSON.stringify(entry) + "\n");
  emit("log", entry);
}

// ---------- process control ----------
function start(inst: Instance) {
  if (inst.child) return;
  inst.stoppedByUser = false;
  const child = spawn(process.execPath, inst.args, { cwd: root, env: { ...process.env, ...inst.env }, windowsHide: true });
  inst.child = child;
  inst.pid = child.pid;
  inst.status = "starting";
  pushLog(inst.name, JSON.stringify({ ts: new Date().toISOString(), svc: "supervisor", inst: inst.name, event: "process.spawn", pid: child.pid, cmd: `node ${inst.args.join(" ")}` }), "supervisor");
  createInterface({ input: child.stdout! }).on("line", (l) => pushLog(inst.name, l, "stdout"));
  createInterface({ input: child.stderr! }).on("line", (l) => pushLog(inst.name, l, "stderr"));
  child.on("exit", (code, signal) => {
    inst.child = undefined;
    inst.pid = undefined;
    inst.status = "stopped";
    inst.info = undefined;
    pushLog(inst.name, JSON.stringify({ ts: new Date().toISOString(), svc: "supervisor", inst: inst.name, event: "process.exit", code, signal, byUser: inst.stoppedByUser }), "supervisor");
    emitState();
  });
  emitState();
}
function stop(inst: Instance) {
  if (!inst.child) return;
  inst.stoppedByUser = true;
  pushLog(inst.name, JSON.stringify({ ts: new Date().toISOString(), svc: "supervisor", inst: inst.name, event: "process.kill", pid: inst.pid }), "supervisor");
  inst.child.kill();
}

async function poll() {
  await Promise.all(
    instances.map(async (inst) => {
      if (!inst.child) return;
      try {
        const r = await fetch(inst.health, { signal: AbortSignal.timeout(800) });
        inst.info = await r.json();
        inst.status = "running";
      } catch {
        if (inst.child) inst.status = "starting";
      }
    }),
  );
  emitState();
}

function publicState() {
  return {
    instances: instances.map(({ child, ...rest }) => rest),
    frozen: frozenCheck(),
  };
}
let lastStateJson = "";
function emitState() {
  const s = JSON.stringify(publicState());
  if (s === lastStateJson) return;
  lastStateJson = s;
  emit("state", JSON.parse(s));
}

function sha(p: string) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
/** So hash bundle hiện tại với hash ghi lúc build (client cũ chưa build lại). */
function frozenCheck() {
  const infoPath = join(root, "builds/build-info.json");
  if (!existsSync(infoPath)) return null;
  const info = JSON.parse(readFileSync(infoPath, "utf8"));
  const bundles = Object.fromEntries(
    Object.entries<any>(info.bundles).map(([name, b]) => {
      const now = existsSync(join(root, b.file)) ? sha(join(root, b.file)) : null;
      const instName = name === "order-api-v1" ? "order-grpc-v1" : name;
      const running = byName(instName)?.info?.build?.sha256;
      return [name, { ...b, currentSha256: now, unchanged: now === b.sha256, runningSha256: running ?? null }];
    }),
  );
  return { ...info, bundles };
}

// ---------- scripts ----------
const running = new Map<string, ChildProcess>();
const SCRIPTS: Record<string, string> = {
  snapshot: "src/scripts/snapshot-all.ts",
  scenarios: "src/scripts/scenarios.ts",
  measure: "src/scripts/measure.ts",
};

function runScript(name: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...tsx, SCRIPTS[name]], { cwd: root, windowsHide: true });
    running.set(name, child);
    emit("script", { name, status: "running" });
    const on = (l: string) => {
      pushLog(`script:${name}`, JSON.stringify({ ts: new Date().toISOString(), svc: "script", inst: `script:${name}`, event: "output", text: l }), "supervisor");
    };
    createInterface({ input: child.stdout }).on("line", on);
    createInterface({ input: child.stderr }).on("line", on);
    child.on("exit", (code) => {
      running.delete(name);
      emit("script", { name, status: "done", code });
      resolve(code ?? 1);
    });
  });
}

// ---------- evidence ----------
function readEvidence() {
  const ev = (p: string) => join(root, "evidence", p);
  const json = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
  const text = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const lines = (p: string) =>
    existsSync(p)
      ? readFileSync(p, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return { text: l };
            }
          })
      : [];
  const snapDir = ev("snapshots");
  const snapshots = Object.fromEntries(
    (existsSync(snapDir) ? readdirSync(snapDir) : []).filter((f) => f.endsWith(".json")).map((f) => [f.replace(/\.json$/, ""), json(join(snapDir, f))]),
  );
  const codegenDir = ev("codegen");
  const codegen = Object.fromEntries(
    (existsSync(codegenDir) ? readdirSync(codegenDir) : []).map((f) => [f, text(join(codegenDir, f))]),
  );
  return {
    snapshots,
    logs: {
      baselineOrder: lines(ev("logs/baseline-order-api.log")),
      baselineInventory: lines(ev("logs/baseline-inventory.log")),
      grpcOrder: lines(ev("logs/grpc-order-api.log")),
      grpcInventory: lines(ev("logs/grpc-inventory.log")),
    },
    codegen,
    protoV1: text(join(root, "proto/history/inventory.v1.proto")),
    protoV2: text(join(root, "proto/inventory.proto")),
    frozen: frozenCheck(),
    matrix: json(ev("matrix.json")),
    scenarios: json(ev("scenarios.json")),
    payload: json(ev("payload.json")),
    dx: text(ev("dx-notes.md")),
  };
}

// ---------- http ----------
const app = express();
app.use(express.json());
// Keep explanations in the report while the dashboard focuses on running flows.
for (const file of ["REPORT.html", "REPORT.md", "README.md", "PLAN.md", "builds/build-info.json"]) {
  app.get(`/${file}`, (_req, res) => res.sendFile(join(root, file)));
}
app.use("/evidence", express.static(join(root, "evidence")));
app.use(express.static(join(root, "dashboard")));

app.get("/api/state", (_req, res) => {
  res.json(publicState());
});
app.get("/api/logs", (req, res) => {
  const inst = req.query.inst as string | undefined;
  const last = Number(req.query.last ?? 200);
  const rows = inst ? ring.filter((e) => e._src === inst) : ring;
  res.json(rows.slice(-last));
});
app.get("/api/events", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  res.write(`event: backlog\ndata: ${JSON.stringify(ring.slice(-400))}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});
app.post("/api/instances/:name/:action", (req, res) => {
  const inst = byName(req.params.name);
  if (!inst) return void res.status(404).json({ error: "unknown instance" });
  if (req.params.action === "stop") stop(inst);
  else if (req.params.action === "start") start(inst);
  else return void res.status(400).json({ error: "unknown action" });
  res.json({ ok: true });
});
app.post("/api/inventory/:name/slow", async (req, res) => {
  const inst = byName(req.params.name);
  if (!inst || inst.kind !== "inventory") return void res.status(404).end();
  try {
    const r = await fetch(inst.health.replace("/admin/state", "/admin/slow"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: Boolean(req.body?.on) }),
    });
    res.json(await r.json());
  } catch {
    res.status(503).json({ error: "inventory not reachable" });
  }
  poll();
});
app.post("/api/reset", async (_req, res) => {
  const out: Record<string, unknown> = {};
  for (const inst of instances.filter((i) => i.kind === "inventory")) {
    try {
      const r = await fetch(inst.health.replace("/admin/state", "/admin/reset"), { method: "POST" });
      out[inst.name] = await r.json();
    } catch {
      out[inst.name] = "unreachable";
    }
  }
  res.json(out);
  poll();
});
app.post("/api/run/:script", async (req, res) => {
  const name = req.params.script;
  if (!SCRIPTS[name]) return void res.status(404).end();
  if (running.has(name)) return void res.status(409).json({ error: "already running" });
  const code = await runScript(name);
  res.json({ code });
});
app.get("/api/evidence", (_req, res) => {
  res.json(readEvidence());
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  for (const inst of instances) start(inst);
  setInterval(poll, 1000);
});

const shutdown = () => {
  for (const inst of instances) inst.child?.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
