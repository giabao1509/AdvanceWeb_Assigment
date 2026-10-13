/* Dashboard trình bày: REST → gRPC giữa Order API và Inventory. JS thuần, không build. */
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
  evidence: null,
  hidden: new Set(),
  scripts: {},
};

// ---------------------------------------------------------------- utils
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hhmmss = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("vi-VN", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0"); };
const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const statusClass = (s) => (s >= 500 ? "s5" : s >= 400 ? "s4" : s >= 200 ? "s2" : "");
const tagFor = (s) => (s >= 500 ? "err" : s >= 400 ? "warn" : "ok");
const range = (st, unit = "") => !st ? "–" : st.min === st.max ? `${st.median}${unit}` : `${st.median}${unit} <span class="muted">(${st.min}–${st.max})</span>`;
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

// ---------------------------------------------------------------- tabs
function setTab(name) {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  try { localStorage.setItem("tab", name); } catch {}
  history.replaceState(null, "", `#${name}`);
  if (name === "demo") requestAnimationFrame(drawWires);
  if (name === "evidence" || name === "tradeoff") loadEvidence();
}
$$(".tab-btn").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  const map = { 1: "problem", 2: "solution", 3: "demo", 4: "evidence", 5: "tradeoff" };
  if (map[e.key]) setTab(map[e.key]);
});

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
    if (e._src?.startsWith("script:")) appendScriptLine(e);
    if (S.ctx) renderInternal();
  });
  es.addEventListener("script", (ev) => {
    const s = JSON.parse(ev.data);
    S.scripts[s.name] = s;
  });
  es.onerror = () => { $("#sysPill").innerHTML = `<span class="dot err"></span>mất kết nối supervisor`; };
}

// ---------------------------------------------------------------- evidence
async function loadEvidence(force = false) {
  if (S.evidence && !force) { renderEvidence(); return; }
  S.evidence = await api("/api/evidence");
  renderEvidence();
}

function appendScriptLine(e) {
  const box = $(`#out-${e._src.split(":")[1]}`);
  if (!box) return;
  box.style.display = "block";
  box.textContent += e.text + "\n";
  box.scrollTop = box.scrollHeight;
}
async function runScript(name, btn) {
  btn.disabled = true;
  const label = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span> đang chạy…`;
  const out = $(`#out-${name}`);
  if (out) { out.textContent = ""; out.style.display = "block"; }
  const r = await api(`/api/run/${name}`, { method: "POST" });
  btn.innerHTML = label;
  btn.disabled = false;
  await loadEvidence(true);
  const o2 = $(`#out-${name}`);
  if (o2 && out) { o2.textContent = out.textContent + `\n[exit ${r.code}]`; o2.style.display = "block"; }
}
const runBtn = (name, text) => `<button class="btn" data-run="${name}"><span data-icon="play"></span>${text}</button>`;
const outBox = (name) => `<pre class="code script-out" id="out-${name}" style="display:none"></pre>`;
const section = (id, num, title, right, body) => `
  <div class="card ev-section" id="${id}">
    <div class="card-h"><h3><span class="muted mono" style="margin-right:8px">${num}</span>${title}</h3><div class="row">${right || ""}</div></div>
    <div class="card-b">${body}</div>
  </div>`;
const verdict = (ok, yes, no, warn) => `<span class="verdict ${ok ? "ok" : warn ? "warn" : "err"}">${ok ? "✓" : warn ? "≈" : "✗"} ${ok ? yes : no}</span>`;

function renderEvidence() {
  const ev = S.evidence;
  if (!ev) return;
  const html = [evSnap(ev), evLogs(ev), evProto(ev), evOld(ev), evErr(ev), evPayload(ev), evDx(ev)].join("");
  $("#evidence").innerHTML = html;
  hydrateIcons($("#evidence"));
  $$("#evidence [data-run]").forEach((b) => b.addEventListener("click", () => runScript(b.dataset.run, b)));
  $$("#evidence .log-line").forEach((d) => d.addEventListener("click", () => {
    const raw = d.querySelector(".log-raw");
    if (raw) raw.remove(); else d.insertAdjacentHTML("beforeend", `<pre class="json log-raw">${jsonHtml(JSON.parse(d.dataset.raw))}</pre>`);
  }));
  fillTradeoff();
}

function evSnap(ev) {
  const cmp = ev.snapshots["compare.baseline-rest__grpc-v1"];
  const A = ev.snapshots["baseline-rest"];
  const B = ev.snapshots["grpc-v1"];
  let body = "";
  if (cmp && A && B) {
    body += `<div class="row" style="margin-bottom:12px">${verdict(cmp.identical, "Status + body giống hệt nhau ở mọi case", "Có khác biệt")}
      <span class="src">evidence/snapshots/baseline-rest.json (${hhmmss(A.takenAt)}) ↔ grpc-v1.json (${hhmmss(B.takenAt)}) · đã thay orderId, createdAt</span></div>
      <table><thead><tr><th style="width:160px">Case</th><th>Trước · REST baseline</th><th>Sau · gRPC</th><th style="width:90px">Kết quả</th></tr></thead><tbody>` +
      cmp.rows.map((r) => `<tr><td><b>${esc(r.title)}</b></td>
        <td><span class="tag ${tagFor(r.a.status)}">${r.a.status}</span><pre class="json" style="margin-top:6px">${jsonHtml(r.a.body)}</pre></td>
        <td><span class="tag ${tagFor(r.b.status)}">${r.b.status}</span><pre class="json" style="margin-top:6px">${jsonHtml(r.b.body)}</pre></td>
        <td>${r.identical ? `<span class="tag ok">giống</span>` : `<span class="tag err">khác</span>`}</td></tr>`).join("") + `</tbody></table>`;
  }
  const live = Object.entries(ev.snapshots).filter(([k]) => k.startsWith("compare.baseline-rest__live-"));
  if (live.length) {
    body += `<div class="sub-h">Chạy lại trên các instance đang chạy (so với baseline REST)</div><table><thead><tr><th>Instance</th><th>Chụp lúc</th><th>Kết quả</th></tr></thead><tbody>` +
      live.map(([, c]) => `<tr><td class="mono inst-${esc(c.b.replace("live-", ""))}">${esc(c.b.replace("live-", ""))}</td><td class="mono small">${hhmmss(c.comparedAt)}</td>
        <td>${c.identical ? `<span class="tag ok">giống hệt</span>` : c.onlyAdditive ? `<span class="tag new">chỉ thêm key: ${esc([...new Set(c.rows.flatMap((r) => r.addedKeys))].join(", "))}</span> <span class="small muted">(Order API v2, thay đổi additive đã chốt)</span>` : `<span class="tag err">khác</span>`}</td></tr>`).join("") + `</tbody></table>`;
  }
  return section("ev-snap", "E1", "Snapshot status &amp; body API ngoài · trước / sau", runBtn("snapshot", "Chạy lại snapshot"), body + outBox("snapshot"));
}

function logList(rows) {
  return `<div class="log-box" style="height:auto;max-height:300px;border:1px solid var(--line);border-radius:10px">` + rows.map((e) => {
    const { m, cls } = fmtLog(e);
    const src = e.inst || e._src || "";
    return `<div class="log-line ${cls}" data-raw="${esc(JSON.stringify(e))}"><span class="t">${hhmmss(e.ts)}</span><span class="i inst-${esc(src)}">${esc(src)}</span><span class="m">${m}</span></div>`;
  }).join("") + `</div>`;
}
function evLogs(ev) {
  const pick = (rows) => rows.filter((e) => ["order.request", "inventory.call", "order.response", "rest.Reserve", "grpc.Reserve"].includes(e.event));
  const merge = (a, b) => pick([...a, ...b]).sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  const before = merge(ev.logs.baselineOrder, ev.logs.baselineInventory);
  const after = merge(ev.logs.grpcOrder, ev.logs.grpcInventory);
  const body = `<div class="two">
    <div><div class="row" style="margin-bottom:6px"><span class="tag rest">TRƯỚC · REST</span><span class="src">evidence/logs/baseline-*.log</span></div>${logList(before)}</div>
    <div><div class="row" style="margin-bottom:6px"><span class="tag grpc">SAU · gRPC</span><span class="src">evidence/logs/grpc-*.log</span></div>${logList(after)}</div>
  </div><p class="small muted" style="margin:10px 0 0">Bấm một dòng để xem JSON gốc. Dòng <code>inventory.call</code> của Order API ghi <code>"transport":"rest"</code> / <code>"POST /reservations"</code> trước, và <code>"transport":"grpc"</code> / <code>/inventory.InventoryService/Reserve</code> sau.</p>`;
  return section("ev-logs", "E2", "Log Order API &amp; Inventory: lời gọi nội bộ trước (REST) và sau (gRPC)", "", body);
}

function diffHtml(text) {
  return `<div class="diff">` + (text || "").split(/\r?\n/).map((l) => {
    const c = l.startsWith("+++") || l.startsWith("---") ? "meta" : l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
    return `<div class="${c}">${esc(l) || " "}</div>`;
  }).join("") + `</div>`;
}
function evProto(ev) {
  const diff = ev.codegen["proto-v1-v2.diff"];
  const removed = (diff || "").split(/\r?\n/).filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  const block = (file, title) => ev.codegen[file] ? `<details ${file === "v2.txt" ? "open" : ""}><summary class="sub-h" style="cursor:pointer">${title} <span class="src">evidence/codegen/${file}</span></summary><pre class="code">${esc(ev.codegen[file])}</pre></details>` : "";
  const body = `<div class="row" style="margin-bottom:10px">${verdict(removed === 0, "Chỉ thêm dòng: không đổi tag, kiểu hay nghĩa của field 1–3", `${removed} dòng bị xoá/sửa`)}<span class="src">diff -u proto/history/inventory.v1.proto proto/inventory.proto</span></div>
    ${diffHtml(diff)}
    ${block("v1.txt", "Sinh code v1")}
    ${block("v2-attempt1-failed.txt", "Sinh code v2: lần 1 lỗi (thiếu well-known types)")}
    ${block("v2.txt", "Sinh code v2: thành công")}
    ${block("v2-tsc-before-fix.txt", "tsc ngay sau khi sinh lại, trước khi sửa server")}`;
  return section("ev-proto", "E3", "Diff proto trước / sau khi thêm field &amp; output sinh code", "", body);
}

function evOld(ev) {
  const f = ev.frozen;
  let body = "";
  if (f) {
    const b = f.bundles["order-api-v1"];
    const ok = b.unchanged && b.runningSha256 === b.sha256;
    body += `<div class="row" style="margin-bottom:10px">${verdict(ok, "Bundle client cũ chưa build lại: hash lúc chạy = hash lúc build", "Hash không khớp")}</div>
      <div class="two"><dl class="kv">
        <dt>Build lúc</dt><dd>${esc(f.builtAt)}</dd>
        <dt>Từ proto</dt><dd>${esc(f.proto)}</dd>
        <dt>proto sha256</dt><dd>${esc(f.protoSha256)}</dd>
        <dt>Cách build</dt><dd>esbuild bundle frozen/v1/src/order-api/main.ts → builds/order-api-v1.cjs (src/scripts/build-v1.ts, từ chối build lại)</dd>
      </dl><dl class="kv">
        <dt>sha256 lúc build</dt><dd>${esc(b.sha256)}</dd>
        <dt>sha256 file hiện tại</dt><dd>${esc(b.currentSha256)} ${b.unchanged ? "✓" : "✗"}</dd>
        <dt>sha256 process đang chạy</dt><dd>${esc(b.runningSha256 ?? "(không chạy)")} ${b.runningSha256 === b.sha256 ? "✓" : "✗"}</dd>
        <dt>Kích thước</dt><dd>${(b.bytes / 1024).toFixed(0)} KiB</dd>
      </dl></div>`;
  }
  const m = ev.matrix;
  if (m) {
    body += `<div class="sub-h">Ma trận client × server <span class="src">evidence/matrix.json · ${hhmmss(m.takenAt)}</span></div>
      <table><thead><tr><th>Client</th><th>Server</th><th class="num">Status</th><th>reservationExpiresAt (body ngoài)</th><th class="num">Message nhận</th><th class="num">Byte bị bỏ qua</th><th>Inventory log: gọi bởi</th></tr></thead><tbody>` +
      m.matrix.map((r) => `<tr>
        <td><b>${esc(r.client)}</b><div class="mono small muted">${esc(r.clientVersion)}</div></td>
        <td>${esc(r.server)}</td>
        <td class="num"><span class="tag ${tagFor(r.status)}">${r.status}</span></td>
        <td>${r.hasReservationExpiresAt ? `<span class="tag new">${esc(r.body.reservationExpiresAt)}</span>` : `<span class="tag">vắng → bỏ key</span>`}</td>
        <td class="num mono">${r.orderLog?.resMsgBytes != null ? `${r.orderLog.resMsgBytes} B` : r.orderLog?.resBodyBytes != null ? `${r.orderLog.resBodyBytes} B JSON` : "–"}</td>
        <td class="num mono">${r.orderLog?.unknownFieldBytes > 0 ? `<span class="tag new">${r.orderLog.unknownFieldBytes} B</span>` : r.orderLog?.unknownFieldBytes ?? "–"}</td>
        <td class="mono small">${esc(r.inventoryLog?.clientVersion ?? "–")}<div class="muted">${esc(r.inventoryLog?.event ?? "")} → ${esc(r.inventoryLog?.result ?? "")}</div></td></tr>`).join("") +
      `</tbody></table><p class="small muted" style="margin:10px 0 0">Client cũ nhận nhiều byte hơn những gì nó hiểu được. Phần chênh là field 4, được decoder bỏ qua, và flow vẫn hoàn tất với 201. Client mới gọi server cũ thì không nhận được tag 4, nên Order API v2 bỏ key thay vì trả <code>1970-01-01</code>.</p>`;
  }
  return section("ev-old", "E4", "Client cũ (build từ proto v1, chưa build lại) với server mới", runBtn("snapshot", "Chạy lại ma trận"), body);
}

function evErr(ev) {
  const s = ev.scenarios;
  if (!s) return section("ev-err", "E5", "Thiếu hàng · Inventory chậm · Inventory tắt", runBtn("scenarios", "Chạy kịch bản lỗi (~10 s)"), `<div class="empty">Chưa có dữ liệu.</div>${outBox("scenarios")}`);
  const name = { "thieu-hang": "Thiếu hàng", cham: "Inventory chậm 5 s", tat: "Inventory tắt" };
  const slowOk = s.rows.filter((r) => r.scenario === "cham").every((r) => r.status === 504 && r.elapsedMs < 2600);
  const downOk = s.rows.filter((r) => r.scenario === "tat").every((r) => r.status === 503);
  const oosOk = s.rows.filter((r) => r.scenario === "thieu-hang").every((r) => r.status === 409);
  const body = `<div class="row" style="margin-bottom:10px">
      ${verdict(oosOk, "Thiếu hàng → 409, không phải 500", "Sai mapping")}
      ${verdict(slowOk, `Chậm → 504 sau ~${s.deadlineMs} ms`, "Không đúng deadline")}
      ${verdict(downOk, "Tắt → 503 ngay", "Sai mapping")}
      ${verdict(s.notes?.slow?.stockAfter === 5, `Không giữ hàng ma (tồn sau = ${s.notes?.slow?.stockAfter})`, `Tồn sau = ${s.notes?.slow?.stockAfter}`)}
      <span class="src">evidence/scenarios.json · ${hhmmss(s.takenAt)}</span></div>
    <table><thead><tr><th>Kịch bản</th><th>Client</th><th>Gửi</th><th>Nhận</th><th class="num">Thời gian</th><th class="num">Status</th><th>Response ngoài</th><th>Nội bộ</th></tr></thead><tbody>` +
    s.rows.map((r) => `<tr><td><b>${name[r.scenario] ?? r.scenario}</b></td><td class="small">${esc(r.transport)}</td>
      <td class="mono small">${hhmmss(r.sentAt)}</td><td class="mono small">${hhmmss(r.receivedAt)}</td>
      <td class="num mono">${r.elapsedMs} ms</td><td class="num"><span class="tag ${tagFor(r.status)}">${r.status}</span></td>
      <td class="mono small">${esc(r.body?.error?.code)}<div class="muted">${esc(r.body?.error?.message)}</div></td>
      <td class="mono small">${esc(r.internal?.grpcCode ?? (r.internal?.httpStatus ? "HTTP " + r.internal.httpStatus : r.internal?.cause ?? ""))}<div class="muted">${esc((r.internal?.grpcDetails ?? r.internal?.error ?? "").slice(0, 80))}</div></td></tr>`).join("") +
    `</tbody></table>
    <div class="sub-h">Phía Inventory sau khi ngủ 5 s</div>
    <table><thead><tr><th>Event</th><th>Gọi bởi</th><th>Kết quả</th><th class="num">Xử lý</th></tr></thead><tbody>` +
    (s.notes?.slow?.inventoryOutcomes ?? []).map((o) => `<tr><td class="mono">${esc(o.event)}</td><td class="mono small">${esc(o.clientVersion)}</td><td><span class="tag err">${esc(o.result)}</span> <span class="small muted">${esc(o.note)}</span></td><td class="num mono">${o.durationMs} ms</td></tr>`).join("") +
    `</tbody></table>${outBox("scenarios")}`;
  return section("ev-err", "E5", "Thiếu hàng · Inventory chậm · Inventory tắt", runBtn("scenarios", "Chạy lại (~10 s)"), body);
}

function bars(title, items, unit = "B") {
  const max = Math.max(...items.map((i) => i.v || 0), 1);
  return `<div class="bar-group"><h4>${title}</h4>` + items.map((i) => `
    <div class="bar-row"><span>${i.label}</span><div class="bar-track"><div class="bar-fill ${i.cls}" style="width:${((i.v || 0) / max) * 100}%"></div></div><span class="bar-val">${i.v} ${unit}</span></div>`).join("") + `</div>`;
}
function evPayload(ev) {
  const p = ev.payload;
  if (!p) return section("ev-payload", "E6", "Payload chặng nội bộ &amp; thời gian phản hồi", runBtn("measure", "Đo"), `<div class="empty">Chưa đo.</div>${outBox("measure")}`);
  const R = p.rest, G = p.grpcV2, G1 = p.grpcV1;
  const msgRow = (label, r, g, g1, note = "") => `<tr><td>${label}</td><td class="num mono">${range(r)}</td><td class="num mono">${range(g)}</td><td class="num mono">${range(g1)}</td><td class="small muted">${note}</td></tr>`;
  const wireRow = (label, r, g) => `<tr><td>${label}</td><td class="num mono">${r}</td><td class="num mono">${g}</td></tr>`;
  const body = `
    <div class="sub-h" style="margin-top:0">Bảng 1 · Message đã serialize (đơn vị: byte)</div>
    <p class="small muted" style="margin:0 0 8px">${esc(p.method.message)}</p>
    <table><thead><tr><th>Lời gọi</th><th class="num">REST · JSON body</th><th class="num">gRPC v2 · protobuf</th><th class="num">gRPC client v1 nhận</th><th>Ghi chú</th></tr></thead><tbody>
      ${msgRow("Đủ hàng · request", R["du-hang"].message.request, G["du-hang"].message.request, G1["du-hang"].message.request)}
      ${msgRow("Đủ hàng · response", R["du-hang"].message.response, G["du-hang"].message.response, G1["du-hang"].message.response, `gRPC có thêm Timestamp (tag 4). Client v1 bỏ qua ${range(G1["du-hang"].message.unknownFieldBytes)} B.`)}
      ${msgRow("Thiếu hàng · request", R["thieu-hang"].message.request, G["thieu-hang"].message.request, G1["thieu-hang"].message.request)}
      ${msgRow("Thiếu hàng · response", R["thieu-hang"].message.response, G["thieu-hang"].message.response, G1["thieu-hang"].message.response, "gRPC: lỗi nằm trong status + trailer, không có message")}
    </tbody></table>

    <div class="sub-h">Bảng 2 · Wire bytes trên socket (đơn vị: byte, ↑ Order→Inventory, ↓ ngược lại)</div>
    <p class="small muted" style="margin:0 0 8px">${esc(p.method.wire)}</p>
    <div class="two"><table><thead><tr><th>Lời gọi</th><th class="num">REST · HTTP/1.1</th><th class="num">gRPC · HTTP/2</th></tr></thead><tbody>
      ${wireRow("Đủ hàng · cold (kết nối mới) ↑+↓", R["du-hang"].wire.cold.total, G["du-hang"].wire.cold.total)}
      ${wireRow("Đủ hàng · ấm ↑", range(R["du-hang"].wire.warmUp), range(G["du-hang"].wire.warmUp))}
      ${wireRow("Đủ hàng · ấm ↓", range(R["du-hang"].wire.warmDown), range(G["du-hang"].wire.warmDown))}
      ${wireRow("<b>Đủ hàng · ấm ↑+↓</b>", range(R["du-hang"].wire.warmTotal), range(G["du-hang"].wire.warmTotal))}
      ${wireRow("Thiếu hàng · ấm ↑", range(R["thieu-hang"].wire.warmUp), range(G["thieu-hang"].wire.warmUp))}
      ${wireRow("Thiếu hàng · ấm ↓", range(R["thieu-hang"].wire.warmDown), range(G["thieu-hang"].wire.warmDown))}
      ${wireRow("<b>Thiếu hàng · ấm ↑+↓</b>", range(R["thieu-hang"].wire.warmTotal), range(G["thieu-hang"].wire.warmTotal))}
    </tbody></table>
    <div class="bars">
      ${bars("Message: response đủ hàng", [{ label: "REST", v: R["du-hang"].message.response.median, cls: "rest" }, { label: "gRPC", v: G["du-hang"].message.response.median, cls: "grpc" }])}
      ${bars("Wire: đủ hàng, ấm, ↑+↓ (median)", [{ label: "REST", v: R["du-hang"].wire.warmTotal.median, cls: "rest" }, { label: "gRPC", v: G["du-hang"].wire.warmTotal.median, cls: "grpc" }])}
      ${bars("Wire: kết nối mới, ↑+↓", [{ label: "REST", v: R["du-hang"].wire.cold.total, cls: "rest" }, { label: "gRPC", v: G["du-hang"].wire.cold.total, cls: "grpc" }])}
    </div></div>

    <div class="sub-h">Bảng 3 · Thời gian phản hồi (ms, median và min–max, N = ${p.runsPerCase})</div>
    <p class="small muted" style="margin:0 0 8px">${esc(p.method.latency)}</p>
    <table><thead><tr><th>Đại lượng</th><th class="num">REST</th><th class="num">gRPC</th></tr></thead><tbody>
      <tr><td>Nội bộ: Order API → Inventory → Order API</td><td class="num mono">${range(p.latency.internal.rest, " ms")}</td><td class="num mono">${range(p.latency.internal.grpc, " ms")}</td></tr>
      <tr><td>End-to-end: browser POST /orders</td><td class="num mono">${range(p.latency.endToEnd.rest, " ms")}</td><td class="num mono">${range(p.latency.endToEnd.grpc, " ms")}</td></tr>
    </tbody></table>
    <p class="src" style="margin-top:8px">evidence/payload.json · ${esc(p.takenAt)} · ${esc(p.environment.node)} · ${esc(p.environment.platform)} · ${esc(p.environment.host)}</p>
    ${outBox("measure")}`;
  return section("ev-payload", "E6", "Payload chặng nội bộ &amp; thời gian phản hồi", runBtn("measure", "Đo lại"), body);
}

function md(text) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  let out = "", inList = false;
  for (const line of (text || "").split(/\r?\n/)) {
    if (/^- /.test(line)) { if (!inList) { out += "<ul>"; inList = true; } out += `<li>${inline(line.slice(2))}</li>`; continue; }
    if (inList) { out += "</ul>"; inList = false; }
    if (/^## /.test(line)) out += `<h2>${inline(line.slice(3))}</h2>`;
    else if (/^# /.test(line)) out += `<h1>${inline(line.slice(2))}</h1>`;
    else if (line.trim()) out += `<p>${inline(line)}</p>`;
  }
  if (inList) out += "</ul>";
  return out;
}
function evDx(ev) {
  return section("ev-dx", "E7", "Developer experience · quan sát thật", `<span class="src">evidence/dx-notes.md</span>`, `<div class="md">${md(ev.dx)}</div>`);
}

// ---------------------------------------------------------------- trade-off numbers + criteria
function fillTradeoff() {
  const ev = S.evidence;
  $$("[data-ev]").forEach((el) => {
    const v = get(ev, el.dataset.ev);
    el.textContent = v == null ? "–" : el.dataset.ev.endsWith("takenAt") ? new Date(v).toLocaleString("vi-VN") : v;
  });
  const cmp = ev.snapshots?.["compare.baseline-rest__grpc-v1"];
  const grpcLog = ev.logs?.grpcOrder?.some((l) => l.event === "inventory.call" && l.transport === "grpc");
  const diff = ev.codegen?.["proto-v1-v2.diff"] || "";
  const removed = diff.split(/\r?\n/).filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  const addedTag4 = /\+\s*google\.protobuf\.Timestamp reservation_expires_at = 4;/.test(diff);
  const b = ev.frozen?.bundles?.["order-api-v1"];
  const oldRow = ev.matrix?.matrix?.find((r) => r.instance === "order-grpc-v1");
  const newRow = ev.matrix?.matrix?.find((r) => r.instance === "order-grpc-v2");
  const sc = ev.scenarios?.rows || [];
  const finite = sc.length && sc.filter((r) => r.scenario !== "thieu-hang").every((r) => r.elapsedMs < 3000 && [503, 504].includes(r.status));
  const items = [
    [cmp?.identical, "Status và body của API ngoài giống nhau trước và sau khi đổi, ở cả đường đủ hàng lẫn thiếu hàng", "E1"],
    [grpcLog, "Log của Order API cho thấy lời gọi nội bộ là gRPC (/inventory.InventoryService/Reserve)", "E2"],
    [removed === 0 && addedTag4, "Field mới dùng tag mới (4), các field cũ giữ nguyên", "E3"],
    [b?.unchanged && b?.runningSha256 === b?.sha256 && oldRow?.status === 201, "Client build từ proto cũ, chưa build lại, hoàn tất flow với server mới", "E4"],
    [newRow?.hasReservationExpiresAt, "Client mới với server mới đọc đúng field mới", "E4"],
    [finite, "Khi Inventory chậm hoặc tắt, request kết thúc trong thời gian hữu hạn (504 / 503)", "E5"],
    [!!ev.payload, "Số liệu nộp là kết quả chạy thật (evidence/*.json kèm timestamp)", "E6"],
  ];
  $("#criteria").innerHTML = items.map(([ok, t, ref]) => `<li><span class="ck ${ok ? "ok" : ok === false ? "err" : "wait"}">${ok ? "✓" : ok === false ? "✗" : "…"}</span><div>${t} <span class="tag">${ref}</span></div></li>`).join("");
}

// ---------------------------------------------------------------- boot
hydrateIcons();
buildTopology();
buildFilters();
try { S.target = localStorage.getItem("target") || S.target; } catch {}
let initial = location.hash.slice(1);
try { initial = initial || localStorage.getItem("tab"); } catch {}
setTab(["problem", "solution", "demo", "evidence", "tradeoff"].includes(initial) ? initial : "problem");
connect();
