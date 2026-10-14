/* Dashboard chạy các luồng: REST → gRPC giữa Order API và Inventory. JS thuần, không build. */
"use strict";

// ---------------------------------------------------------------- constants
const HOST = "127.0.0.1";
const ORDERS = [
  { name: "order-rest", short: "REST baseline", url: `http://${HOST}:3001`, server: "inventory-v2", wire: "rest", label: "REST/JSON", proto: null },
  { name: "order-grpc-v1", short: "gRPC · client cũ", url: `http://${HOST}:3002`, server: "inventory-v2", wire: "grpc v1", label: "gRPC · v1", proto: "v1" },
  { name: "order-grpc-v2", short: "gRPC · client mới", url: `http://${HOST}:3003`, server: "inventory-v2", wire: "grpc", label: "gRPC · v2", proto: "v2" },
  { name: "order-grpc-v2-oldsrv", short: "Client mới → server cũ", url: `http://${HOST}:3004`, server: "inventory-v1", wire: "grpc", label: "gRPC · v2→v1", proto: "v2" },
];
const INVS = [
  { name: "inventory-v2", short: "Server mới", proto: "v2", ports: "REST :5001 · gRPC :50051" },
  { name: "inventory-v1", short: "Server cũ", proto: "v1", ports: "REST :5002 · gRPC :50052" },
];
const STATUS_TEXT = {
  201: "Created", 400: "Bad Request", 404: "Not Found", 409: "Conflict",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};
const ICONS = {
  arrows: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ""}</svg>`;

// ---------------------------------------------------------------- state
const S = {
  instances: {},
  frozen: null,
  logs: [],
  lastSeq: 0,
  target: "order-grpc-v1",
  history: [],
  ctx: null,
  hidden: new Set(),
};

// ---------------------------------------------------------------- utils
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hhmmss = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("vi-VN", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0"); };
const statusClass = (s) => (s >= 500 ? "s5" : s >= 400 ? "s4" : s >= 200 ? "s2" : "");
const tagFor = (s) => (s >= 500 ? "err" : s >= 400 ? "warn" : "ok");
async function api(path, opts = {}) {
  const r = await fetch(path, { method: opts.method || "GET", headers: { "content-type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return r.json().catch(() => ({}));
}
function hydrateIcons(root = document) {
  $$("[data-icon]", root).forEach((el) => { el.innerHTML = icon(el.dataset.icon); el.removeAttribute("data-icon"); el.style.display = "inline-flex"; });
}

function jsonHtml(obj, { newKeys = ["reservationExpiresAt"], dynKeys = ["orderId", "createdAt"] } = {}) {
  if (obj === undefined) return "";
  const text = JSON.stringify(obj, null, 2);
  return text.split("\n").map((line) => {
    let html = esc(line).replace(/(&quot;(?:\\.|[^\\&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, str, colon, bool) => {
      if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
      if (bool) return `<span class="j-bool">${m}</span>`;
      if (m === "null") return `<span class="j-null">${m}</span>`;
      return `<span class="j-num">${m}</span>`;
    });
    if (newKeys.some((k) => line.includes(`"${k}":`))) html = `<span class="j-new">${html}</span>  <span class="j-null">← field mới (tag 4)</span>`;
    else if (dynKeys.some((k) => line.includes(`"${k}":`))) html = `<span class="j-dyn">${html}</span>`;
    return html;
  }).join("\n");
}

setInterval(() => { $("#clock").textContent = new Date().toLocaleTimeString("vi-VN", { hour12: false }); }, 250);

// ---------------------------------------------------------------- topology
function buildTopology() {
  const colO = $("#col-order");
  for (const o of ORDERS) {
    const el = document.createElement("div");
    el.className = "node order";
    el.id = `node-${o.name}`;
    el.innerHTML = `
      <div class="node-top"><span class="dot"></span><span class="node-title">${esc(o.short)}</span><span class="grow"></span><span class="mono small muted">:${o.url.split(":").pop()}</span></div>
      <div class="node-sub" data-f="ver">…</div>
      <div class="node-tags" data-f="tags"></div>`;
    el.addEventListener("click", () => selectTarget(o.name));
    colO.appendChild(el);
  }
  const colI = $("#col-inv");
  for (const i of INVS) {
    const el = document.createElement("div");
    el.className = "node inventory";
    el.id = `node-${i.name}`;
    el.innerHTML = `
      <div class="node-top"><span class="dot"></span><span class="node-title">${esc(i.short)}</span>
        <span class="tag ${i.proto}">proto ${i.proto}</span><span class="tag warn slow-badge">CHẬM 5 s</span></div>
      <div class="node-sub" data-f="ver">${esc(i.ports)}</div>
      <div class="inv-stock"><span class="sku">SKU-001</span><span class="qty" data-f="qty">–</span><span class="small muted">tồn kho</span></div>
      <div class="inv-actions">
        <button class="btn" data-act="slow"><span data-icon="clock"></span><span>Chậm 5 s</span></button>
        <button class="btn danger" data-act="power"><span data-icon="power"></span><span>Tắt</span></button>
      </div>`;
    const slowBtn = el.querySelector('[data-act="slow"]');
    slowBtn.addEventListener("click", async () => {
      slowBtn.disabled = true;
      const on = !S.instances[i.name]?.info?.slow;
      await api(`/api/inventory/${i.name}/slow`, { method: "POST", body: { on } });
      slowBtn.disabled = false;
    });
    el.querySelector('[data-act="power"]').addEventListener("click", async () => {
      const running = S.instances[i.name]?.status !== "stopped";
      await api(`/api/instances/${i.name}/${running ? "stop" : "start"}`, { method: "POST" });
    });
    colI.appendChild(el);
  }
  hydrateIcons($("#topo"));
  new ResizeObserver(drawWires).observe($("#topo"));
  $("#btnReset").addEventListener("click", async () => { await api("/api/reset", { method: "POST" }); });
}

function updateTopology() {
  for (const o of ORDERS) {
    const el = $(`#node-${o.name}`);
    const inst = S.instances[o.name];
    const st = inst?.status ?? "stopped";
    el.classList.toggle("down", st === "stopped");
    el.classList.toggle("selected", S.target === o.name);
    el.querySelector(".dot").className = `dot ${st === "running" ? "ok" : st === "starting" ? "warn" : "err"}`;
    el.querySelector('[data-f="ver"]').textContent = inst?.info?.clientVersion ?? (st === "stopped" ? "process đã dừng" : "đang khởi động…");
    const tags = [];
    tags.push(o.wire === "rest" ? `<span class="tag rest">REST</span>` : `<span class="tag grpc">gRPC</span>`);
    if (inst?.info?.protoRev && o.wire !== "rest") tags.push(`<span class="tag ${inst.info.protoRev}">proto ${inst.info.protoRev}</span>`);
    if (inst?.code === "bundle") {
      const b = S.frozen?.bundles?.["order-api-v1"];
      const ok = b && b.unchanged && b.runningSha256 === b.sha256;
      tags.push(`<span class="tag ${ok ? "ok" : "err"}" title="sha256 lúc build so với lúc chạy">bundle ${ok ? "✓" : "✗"} ${esc((b?.sha256 || "").slice(0, 8))}</span>`);
    } else tags.push(`<span class="tag">source</span>`);
    el.querySelector('[data-f="tags"]').innerHTML = tags.join("");
  }
  for (const i of INVS) {
    const el = $(`#node-${i.name}`);
    const inst = S.instances[i.name];
    const st = inst?.status ?? "stopped";
    el.classList.toggle("down", st === "stopped");
    el.classList.toggle("slow", !!inst?.info?.slow && st === "running");
    el.querySelector(".dot").className = `dot ${st === "running" ? (inst?.info?.slow ? "warn" : "ok") : st === "starting" ? "warn" : "err"}`;
    el.querySelector('[data-f="ver"]').textContent = `${inst?.info?.serverVersion ?? (st === "stopped" ? "process đã dừng" : "…")} · ${i.ports}`;
    const q = el.querySelector('[data-f="qty"]');
    const val = inst?.info?.stock?.["SKU-001"];
    const txt = val ?? "–";
    if (q.textContent !== String(txt)) {
      q.textContent = txt;
      q.classList.add("flash");
      setTimeout(() => q.classList.remove("flash"), 600);
    }
    const slowBtn = el.querySelector('[data-act="slow"]');
    slowBtn.classList.toggle("on-warn", !!inst?.info?.slow);
    slowBtn.lastElementChild.textContent = inst?.info?.slow ? "Đang chậm · tắt" : "Chậm 5 s";
    slowBtn.disabled = st !== "running";
    const pw = el.querySelector('[data-act="power"]');
    pw.className = st === "stopped" ? "btn on-ok" : "btn danger";
    pw.lastElementChild.textContent = st === "stopped" ? "Bật lại" : "Tắt process";
  }
  const all = Object.values(S.instances);
  const up = all.filter((x) => x.status === "running").length;
  $("#sysPill").innerHTML = `<span class="dot ${up === all.length ? "ok" : up ? "warn" : "err"}"></span>${up}/${all.length} process đang chạy`;
  renderTargetBox();
  drawWires();
}

function anchor(el, side) {
  const r = el.getBoundingClientRect();
  const p = $("#topo").getBoundingClientRect();
  return { x: (side === "r" ? r.right : r.left) - p.left, y: r.top + r.height / 2 - p.top };
}
const curve = (a, b) => { const dx = (b.x - a.x) / 2; return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`; };
function pointAt(a, b, t) {
  const dx = (b.x - a.x) / 2;
  const p = [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
  const mt = 1 - t;
  return {
    x: mt ** 3 * p[0].x + 3 * mt * mt * t * p[1].x + 3 * mt * t * t * p[2].x + t ** 3 * p[3].x,
    y: mt ** 3 * p[0].y + 3 * mt * mt * t * p[1].y + 3 * mt * t * t * p[2].y + t ** 3 * p[3].y,
  };
}
function drawWires() {
  const topo = $("#topo");
  if (!topo || !topo.offsetParent) return;
  const svg = $("#wires");
  $$(".wire-label", topo).forEach((n) => n.remove());
  const browser = anchor($("#node-browser"), "r");
  let html = "";
  const fx = S.wireFx || {};
  for (const o of ORDERS) {
    const on = $(`#node-${o.name}`);
    const inv = $(`#node-${o.server}`);
    const a = anchor(on, "l");
    const b = anchor(on, "r");
    const c = anchor(inv, "l");
    const sel = S.target === o.name;
    const outerCls = `wire rest ${sel ? "hot" : "dim"} ${fx.outer && sel ? fx.outer : ""}`;
    const innerCls = `wire ${o.wire} ${sel ? "hot" : "dim"} ${fx.inner && sel ? fx.inner : ""}`;
    html += `<path id="w-out-${o.name}" class="${outerCls}" d="${curve(browser, a)}"/>`;
    html += `<path id="w-in-${o.name}" class="${innerCls}" d="${curve(b, c)}"/>`;
    const m = pointAt(b, c, 0.5);
    const lab = document.createElement("div");
    lab.className = `wire-label ${o.wire} ${sel ? "" : "dim"}`;
    lab.style.left = `${m.x}px`;
    lab.style.top = `${m.y}px`;
    lab.textContent = o.label;
    topo.appendChild(lab);
    if (sel) {
      const mo = pointAt(browser, a, 0.5);
      const l2 = document.createElement("div");
      l2.className = "wire-label rest";
      l2.style.left = `${mo.x}px`;
      l2.style.top = `${mo.y}px`;
      l2.textContent = "REST/JSON";
      topo.appendChild(l2);
      if (S.ctx?.pending) {
        const path = `${curve(browser, a)} L ${b.x} ${b.y} ${curve(b, c).replace(/^M [^C]+/, "")}`;
        html += `<circle class="packet" r="6" fill="${o.wire.startsWith("grpc") ? (o.wire.includes("v1") ? "#6d28d9" : "#0f766e") : "#c2410c"}"><animateMotion dur="1.1s" repeatCount="indefinite" path="${path}"/></circle>`;
      }
    }
  }
  svg.innerHTML = html;
}

function selectTarget(name) {
  S.target = name;
  try { localStorage.setItem("target", name); } catch {}
  updateTopology();
}
function renderTargetBox() {
  const o = ORDERS.find((x) => x.name === S.target);
  const inst = S.instances[o.name];
  $("#targetBox").innerHTML = `
    <div class="small muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.04em">Đích</div>
    <div class="t1">${esc(o.short)} <span class="tag ${o.wire === "rest" ? "rest" : "grpc"}">${o.wire === "rest" ? "REST" : "gRPC"}</span></div>
    <div class="t2">POST ${esc(o.url)}/orders</div>
    <div class="t2">${esc(inst?.info?.clientVersion ?? "")}</div>`;
}

// ---------------------------------------------------------------- request
$$("#presets .chip").forEach((c) => c.addEventListener("click", () => {
  $$("#presets .chip").forEach((x) => x.classList.toggle("active", x === c));
  $("#inSku").value = c.dataset.sku;
  $("#inQty").value = c.dataset.qty;
}));
function readBody() {
  const raw = $("#inQty").value.trim();
  const quantity = raw !== "" && !isNaN(Number(raw)) ? Number(raw) : raw;
  return { sku: $("#inSku").value, quantity };
}

async function doOrder(o, body) {
  const t0 = performance.now();
  try {
    const r = await fetch(`${o.url}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { status: 0, body: { networkError: String(e) }, ms: Math.round(performance.now() - t0) };
  }
}

$("#btnSend").addEventListener("click", async () => {
  const btn = $("#btnSend");
  btn.disabled = true;
  $(".demo-grid").classList.remove("compare");
  const o = ORDERS.find((x) => x.name === S.target);
  const body = readBody();
  if ($("#autoReset").checked) await api("/api/reset", { method: "POST" });
  S.ctx = { o, body, startSeq: S.lastSeq, sentAt: new Date(), pending: true };
  S.wireFx = {};
  drawWires();
  renderPending(o, body);
  renderInternal();
  const res = await doOrder(o, body);
  S.ctx.pending = false;
  S.ctx.res = res;
  S.ctx.doneAt = new Date();
  const fx = res.status >= 500 || res.status === 0 ? "res-err" : res.status >= 400 ? "res-warn" : "res-ok";
  const innerFx = res.status === 400 ? "" : res.status === 503 ? "res-err broken" : fx;
  S.wireFx = { outer: fx, inner: innerFx };
  drawWires();
  clearTimeout(S.fxTimer);
  S.fxTimer = setTimeout(() => { S.wireFx = {}; drawWires(); }, 3500);
  renderResponse(o, body, res);
  addHistory(o, body, res);
  setTimeout(renderInternal, 120);
  btn.disabled = false;
});

$("#btnSendAll").addEventListener("click", async () => {
  const btn = $("#btnSendAll");
  btn.disabled = true;
  $(".demo-grid").classList.add("compare");
  const body = readBody();
  const rows = [];
  S.ctx = null;
  $("#respSrc").textContent = "4 client · reset trước mỗi lần";
  $("#respBox").innerHTML = `<div class="waiting"><span class="spinner"></span>Đang gửi lần lượt…</div>`;
  for (const o of ORDERS) {
    await api("/api/reset", { method: "POST" });
    S.target = o.name;
    S.ctx = { o, body, startSeq: S.lastSeq, sentAt: new Date(), pending: true };
    updateTopology();
    const res = await doOrder(o, body);
    S.ctx.pending = false;
    rows.push({ o, res });
    addHistory(o, body, res);
  }
  await api("/api/reset", { method: "POST" });
  S.ctx = null;
  drawWires();
  renderCompareAll(body, rows);
  btn.disabled = false;
});

function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ["orderId", "createdAt", "reservationExpiresAt"].includes(k) ? `<${k}>` : normalize(x)]));
  return v;
}
function renderCompareAll(body, rows) {
  const base = rows[0];
  const baseN = JSON.stringify(normalize(base.res.body));
  const tr = rows.map(({ o, res }) => {
    const n = normalize(res.body);
    const keysBase = Object.keys(base.res.body || {});
    const added = Object.keys(res.body || {}).filter((k) => !keysBase.includes(k));
    const without = JSON.stringify(Object.fromEntries(Object.entries(n).filter(([k]) => !added.includes(k))));
    let verdict;
    if (o === base.o) verdict = `<span class="tag">mốc</span>`;
    else if (res.status === base.res.status && JSON.stringify(n) === baseN) verdict = `<span class="tag ok">giống hệt</span>`;
    else if (res.status === base.res.status && without === baseN) verdict = `<span class="tag new">+${added.join(", ")}</span>`;
    else verdict = `<span class="tag err">khác</span>`;
    return `<tr><td><b>${esc(o.short)}</b><div class="small muted mono">${esc(S.instances[o.name]?.info?.clientVersion ?? "")}</div></td>
      <td class="num"><span class="tag ${tagFor(res.status)}">${res.status}</span><div class="small muted">${res.ms} ms</div></td>
      <td><pre class="json">${jsonHtml(res.body)}</pre></td><td>${verdict}${internalSummary(o, res)}</td></tr>`;
  }).join("");
  $("#respBox").innerHTML = `
    <div class="small muted" style="margin-bottom:8px">Request <code>${esc(JSON.stringify(body))}</code> · so với REST baseline (bỏ qua orderId/createdAt)</div>
    <table class="compare-table"><thead><tr><th>Client</th><th class="num">Status</th><th>Body</th><th>So với REST</th></tr></thead><tbody>${tr}</tbody></table>`;
}

/** Tóm tắt lời gọi nội bộ của một client trong chế độ so sánh (lấy từ log đã nhận). */
function internalSummary(o) {
  const l = [...S.logs].reverse().find((e) => e._src === o.name && e.event === "inventory.call");
  if (!l) return "";
  const g = l.transport === "grpc";
  return `<div class="small mono muted" style="margin-top:8px">${g ? "gRPC" : "REST"} → ${esc(g ? l.grpcCode : l.httpStatus)}${l.resMsgBytes != null ? ` · ${l.resMsgBytes} B` : ""}${l.unknownFieldBytes > 0 ? ` · bỏ qua ${l.unknownFieldBytes} B` : ""}</div>`;
}

function renderPending(o, body) {
  $("#respSrc").textContent = `${o.url}/orders`;
  $("#respBox").innerHTML = `
    <div class="status-hero"><div class="status-code">…</div>
      <div class="status-meta"><div class="waiting"><span class="spinner"></span>Đang chờ Order API · deadline nội bộ 2000 ms</div>
      <div class="small muted mono">${esc(JSON.stringify(body))}</div></div></div>`;
}
function renderResponse(o, body, res) {
  $("#respSrc").textContent = `${o.url}/orders`;
  if (res.status === 0) {
    $("#respBox").innerHTML = `<div class="status-hero"><div class="status-code s5">✗</div><div class="status-meta"><div class="status-text">Không kết nối được Order API</div><div class="small muted">${res.ms} ms</div></div></div><pre class="json">${jsonHtml(res.body)}</pre>`;
    return;
  }
  $("#respBox").innerHTML = `
    <div class="status-hero">
      <div class="status-code ${statusClass(res.status)}">${res.status}</div>
      <div class="status-meta">
        <div class="status-text">${esc(STATUS_TEXT[res.status] ?? "")} ${res.body?.error?.code ? `· <span class="mono">${esc(res.body.error.code)}</span>` : ""}</div>
        <div class="small muted">browser chờ <b>${res.ms} ms</b> · gửi ${hhmmss(S.ctx.sentAt)} · nhận ${hhmmss(S.ctx.doneAt)}</div>
      </div>
    </div>
    <div class="small muted" style="margin-bottom:6px">Request <code>${esc(JSON.stringify(body))}</code></div>
    <pre class="json">${jsonHtml(res.body)}</pre>`;
}

function addHistory(o, body, res) {
  S.history.unshift({ at: new Date(), o, body, res });
  $("#history").innerHTML = S.history.slice(0, 40).map((h) => `
    <tr title="${esc(h.res.body?.error?.code ?? h.res.body?.status ?? "")}"><td class="mono muted">${hhmmss(h.at).slice(0, 8)}</td><td class="h-client">${esc(h.o.short)}</td><td class="mono">×${esc(h.body.quantity)}</td>
    <td><span class="tag ${tagFor(h.res.status)}">${h.res.status || "ERR"}</span></td><td class="num mono">${h.res.ms} ms</td></tr>`).join("");
}

// internal hop panel, cập nhật mỗi khi log mới tới
function renderInternal() {
  const ctx = S.ctx;
  if (!ctx) return;
  const after = S.logs.filter((l) => l._seq > ctx.startSeq);
  const oLog = after.find((l) => l._src === ctx.o.name && l.event === "inventory.call");
  const oResp = after.find((l) => l._src === ctx.o.name && l.event === "order.response");
  const iLog = after.find((l) => l._src === ctx.o.server && /Reserve$/.test(l.event));
  $("#internalSrc").textContent = `${ctx.o.name} → ${ctx.o.server}`;

  let hop1;
  if (oLog) {
    const isGrpc = oLog.transport === "grpc";
    const rows = [
      ["transport", `<span class="tag ${isGrpc ? "grpc" : "rest"}">${isGrpc ? "gRPC" : "REST"}</span>`],
      ["method", esc(oLog.method)],
      ["target", esc(oLog.target)],
      ["deadline", `${oLog.deadlineMs} ms`],
      ["kết quả", isGrpc ? `<span class="tag ${oLog.grpcCode === "OK" ? "ok" : "warn"}">${esc(oLog.grpcCode)}</span>${oLog.grpcDetails ? ` <span class="muted">${esc(oLog.grpcDetails)}</span>` : ""}` : oLog.httpStatus ? `<span class="tag ${tagFor(oLog.httpStatus)}">HTTP ${oLog.httpStatus}</span>` : `<span class="tag err">${esc(oLog.error)}</span> <span class="muted">${esc(oLog.cause)}</span>`],
      ["→ ngoài", oResp ? `<span class="tag ${tagFor(oResp.status)}">${oResp.status}</span> ${esc(oResp.code ?? "")}` : "…"],
      ["thời gian", `${oLog.durationMs} ms`],
    ];
    if (isGrpc && oLog.reqMsgBytes != null) rows.push(["message", `req ${oLog.reqMsgBytes} B${oLog.resMsgBytes != null ? ` · res ${oLog.resMsgBytes} B` : ""} <span class="muted">(protobuf)</span>`]);
    if (!isGrpc && oLog.reqBodyBytes != null) rows.push(["body", `req ${oLog.reqBodyBytes} B · res ${oLog.resBodyBytes} B <span class="muted">(JSON)</span>`]);
    if (oLog.trailer?.["x-available-stock"]) rows.push(["trailer", `x-available-stock: ${esc(oLog.trailer["x-available-stock"])}`]);
    if (oLog.unknownFieldBytes > 0) rows.push(["field lạ", `<span class="tag new">${oLog.unknownFieldBytes} B bị bỏ qua</span> <span class="muted">client v1 không biết tag 4</span>`]);
    if (oLog.reservationExpiresAt) rows.push(["tag 4", oLog.reservationExpiresAt.startsWith("absent") ? `<span class="tag warn">vắng</span> <span class="muted">server không gửi → bỏ key</span>` : `<span class="tag new">${esc(oLog.reservationExpiresAt)}</span>`]);
    rows.push(["clientVersion", esc(oLog.clientVersion)]);
    hop1 = `<div class="hop"><div class="hop-h">① Order API gọi Inventory <span class="muted small">(log client)</span></div><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>`;
  } else if (oResp && oResp.inventoryCalled === false) {
    hop1 = `<div class="hop"><div class="hop-h">① Order API</div><div>Validate thất bại → trả <span class="tag warn">400</span>, <b>không gọi Inventory</b>.</div></div>`;
  } else {
    hop1 = `<div class="hop"><div class="hop-h">① Order API gọi Inventory</div><div class="waiting"><span class="spinner"></span>đang chờ log…</div></div>`;
  }

  let hop2 = "";
  if (!(oResp && oResp.inventoryCalled === false)) {
    if (iLog) {
      const rows = [
        ["event", `<span class="tag ${iLog.event.startsWith("grpc") ? "grpc" : "rest"}">${esc(iLog.event)}</span>`],
        ["server", esc(iLog.server)],
        ["gọi bởi", `<b>${esc(iLog.clientVersion)}</b> <span class="muted">(${iLog.event.startsWith("grpc") ? "metadata" : "header"} x-client-version)</span>`],
      ];
      if (iLog.deadline) rows.push(["deadline nhận", `${esc(iLog.deadline)} <span class="muted">(grpc-timeout)</span>`]);
      rows.push(["kết quả", `<span class="tag ${iLog.result === "RESERVED" ? "ok" : iLog.result?.startsWith("SKIPPED") ? "err" : "warn"}">${esc(iLog.result)}</span>${iLog.note ? ` <span class="muted">${esc(iLog.note)}</span>` : ""}`]);
      if (iLog.reservationExpiresAt) rows.push(["gửi tag 4", esc(iLog.reservationExpiresAt)]);
      if (iLog.stockLeft != null) rows.push(["tồn còn", iLog.stockLeft]);
      if (iLog.available != null) rows.push(["available", iLog.available]);
      rows.push(["xử lý", `${iLog.durationMs} ms`]);
      hop2 = `<div class="hop"><div class="hop-h">② Inventory nhận <span class="muted small">(log server)</span></div><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>`;
    } else if (S.instances[ctx.o.server]?.status === "stopped") {
      hop2 = `<div class="hop"><div class="hop-h">② Inventory</div><div><span class="tag err">process đã tắt</span> Không có log phía server, request không tới được.</div></div>`;
    } else if (!ctx.pending && Date.now() - (ctx.doneAt?.getTime() ?? 0) < 6000) {
      hop2 = `<div class="hop"><div class="hop-h">② Inventory</div><div class="waiting"><span class="spinner"></span>Inventory vẫn đang xử lý (chế độ chậm 5 s) dù client đã bỏ đi…</div></div>`;
    } else if (ctx.pending) {
      hop2 = `<div class="hop"><div class="hop-h">② Inventory</div><div class="waiting"><span class="spinner"></span>đang xử lý…</div></div>`;
    }
  }
  $("#internalBox").innerHTML = hop1 + hop2;
}

// ---------------------------------------------------------------- logs
function fmtLog(e) {
  const t = e.event;
  let cls = "";
  let m;
  if (t === "order.request") m = `→ POST /orders ${esc(JSON.stringify({ sku: e.sku, quantity: e.quantity }))}`;
  else if (t === "order.response") { m = `← <b>${e.status}</b> ${esc(e.code ?? "CONFIRMED")}${e.reservationExpiresAt && !String(e.reservationExpiresAt).startsWith("omitted") ? ` · reservationExpiresAt ✓` : ""} · ${e.durationMs} ms`; cls = e.status >= 500 ? "err" : e.status >= 400 ? "warn" : "okk"; }
  else if (t === "inventory.call") {
    const g = e.transport === "grpc";
    m = `<span class="tag ${g ? "grpc" : "rest"}">${g ? "gRPC" : "REST"}</span> ${esc(g ? "Reserve" : e.method)} → <b>${esc(g ? e.grpcCode : e.httpStatus ?? e.error)}</b> ${e.durationMs} ms` +
      (g && e.resMsgBytes != null ? ` · ${e.reqMsgBytes}B/${e.resMsgBytes}B` : "") +
      (e.unknownFieldBytes > 0 ? ` · <span class="tag new">bỏ qua ${e.unknownFieldBytes}B</span>` : "") +
      (e.reservationExpiresAt ? (String(e.reservationExpiresAt).startsWith("absent") ? ` · tag4 <b>vắng</b>` : ` · tag4 ✓`) : "");
    cls = e.outcome === "RESERVED" ? "okk" : ["TIMEOUT", "UNAVAILABLE", "INTERNAL"].includes(e.outcome) ? "err" : "warn";
  } else if (/Reserve$/.test(t)) {
    const g = t.startsWith("grpc");
    m = `<span class="tag ${g ? "grpc" : "rest"}">${g ? "gRPC" : "REST"}</span> Reserve ×${e.quantity} từ <b>${esc(e.clientVersion)}</b> → <b>${esc(e.result)}</b>${e.stockLeft != null ? ` · tồn ${e.stockLeft}` : ""}${e.note ? ` · ${esc(e.note)}` : ""}`;
    cls = e.result === "RESERVED" ? "okk" : e.result?.startsWith("SKIPPED") ? "err" : "warn";
  } else if (t === "process.kill" || t === "process.exit") { m = `■ ${esc(t)} ${e.pid ?? ""}${e.code != null ? ` code=${e.code}` : ""}`; cls = "err"; }
  else if (t === "process.spawn") m = `▶ ${esc(e.cmd)}`;
  else if (t === "admin.slow") { m = `⏱ chế độ chậm = <b>${e.slow}</b>`; cls = "warn"; }
  else if (t === "admin.reset") m = `↺ reset fixture ${esc(JSON.stringify(e.stock))}`;
  else if (t === "started") m = `started ${esc(e.transport ? `${e.transport} → ${e.target}` : "")} ${e.build?.isBundle ? `· bundle sha ${esc(e.build.sha256.slice(0, 12))}` : ""}`;
  else if (t === "stderr" || t === "text") { m = esc(e.text); cls = t === "stderr" ? "err" : ""; }
  else {
    const { ts, svc, inst, event, _seq, _src, clientVersion, server, ...rest } = e;
    m = `${esc(event)} ${esc(JSON.stringify(rest))}`;
  }
  return { m, cls };
}
function logPane(e) {
  if (e._src?.startsWith("order")) return "#logOrder";
  if (e._src?.startsWith("inventory")) return "#logInv";
  return null;
}
function appendLog(e, fresh = true) {
  const sel = logPane(e);
  if (!sel) return;
  const box = $(sel);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const { m, cls } = fmtLog(e);
  const div = document.createElement("div");
  div.className = `log-line ${cls} ${fresh ? "fresh" : ""}`;
  div.dataset.inst = e._src;
  if (S.hidden.has(e._src)) div.style.display = "none";
  div.innerHTML = `<span class="t">${hhmmss(e.ts)}</span><span class="i inst-${esc(e._src)}">${esc(e._src)}</span><span class="m">${m}</span>`;
  div.addEventListener("click", () => {
    const raw = div.querySelector(".log-raw");
    if (raw) raw.remove();
    else {
      const { _seq, _src, ...clean } = e;
      div.insertAdjacentHTML("beforeend", `<pre class="json log-raw">${jsonHtml(clean)}</pre>`);
    }
  });
  box.appendChild(div);
  while (box.children.length > 500) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function buildFilters() {
  const mk = (sel, names) => {
    $(sel).innerHTML = names.map((n) => `<button class="chip active" data-inst="${n}"><span class="inst-${n}">●</span> ${n.replace("order-", "").replace("inventory-", "")}</button>`).join("");
    $$(`${sel} .chip`).forEach((c) => c.addEventListener("click", () => {
      const n = c.dataset.inst;
      if (S.hidden.has(n)) S.hidden.delete(n); else S.hidden.add(n);
      c.classList.toggle("active", !S.hidden.has(n));
      $$(`.log-line[data-inst="${n}"]`).forEach((l) => (l.style.display = S.hidden.has(n) ? "none" : ""));
    }));
  };
  mk("#filterOrder", ORDERS.map((o) => o.name));
  mk("#filterInv", INVS.map((i) => i.name));
}

// ---------------------------------------------------------------- SSE
function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (ev) => {
    const s = JSON.parse(ev.data);
    S.instances = Object.fromEntries(s.instances.map((i) => [i.name, i]));
    S.frozen = s.frozen;
    updateTopology();
    if (S.ctx) renderInternal();
  });
  es.addEventListener("backlog", (ev) => {
    const rows = JSON.parse(ev.data);
    $("#logOrder").innerHTML = "";
    $("#logInv").innerHTML = "";
    S.logs = rows;
    for (const r of rows) { appendLog(r, false); S.lastSeq = Math.max(S.lastSeq, r._seq); }
    $("#logOrder").scrollTop = 1e9;
    $("#logInv").scrollTop = 1e9;
  });
  es.addEventListener("log", (ev) => {
    const e = JSON.parse(ev.data);
    S.logs.push(e);
    if (S.logs.length > 3000) S.logs.shift();
    S.lastSeq = Math.max(S.lastSeq, e._seq);
    appendLog(e);
    if (S.ctx) renderInternal();
  });
  es.onerror = () => { $("#sysPill").innerHTML = `<span class="dot err"></span>mất kết nối supervisor`; };
}

// ---------------------------------------------------------------- boot
hydrateIcons();
buildTopology();
buildFilters();
try {
  const savedTarget = localStorage.getItem("target");
  if (ORDERS.some((order) => order.name === savedTarget)) S.target = savedTarget;
} catch {}
// Old bookmarks and stored tabs now open the single demo screen.
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
updateTopology();
connect();
