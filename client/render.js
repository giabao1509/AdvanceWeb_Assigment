// Render và mốc đo dùng chung cho mọi biến thể. Biến thể chỉ khác adapter lấy dữ liệu.
import * as baseline from './adapters/baseline.js';
import * as bff from './adapters/bff.js';
import * as graphql from './adapters/graphql.js';

const ADAPTERS = {
  baseline,
  bff,
  'graphql-naive': { loadWeb: graphql.loadWebNaive, loadMobile: graphql.loadMobileNaive },
  'graphql-batched': { loadWeb: graphql.loadWebBatched, loadMobile: graphql.loadMobileBatched },
};

const STATUS_LABEL = {
  PENDING: 'Chờ xử lý',
  PAID: 'Đã thanh toán',
  SHIPPED: 'Đang giao',
  DELIVERED: 'Đã giao',
  CANCELLED: 'Đã huỷ',
};
const PRODUCT_ERROR_TEXT = 'Không tải được thông tin sản phẩm';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const vnd = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' });

const statusBadge = (s) => `<span class="badge s-${esc(s)}">${esc(STATUS_LABEL[s] ?? s)}</span>`;

const partialBanner = (errors) =>
  errors.length
    ? `<div class="banner" role="status" data-partial>Một số thông tin sản phẩm chưa tải được (${errors.length} dòng hàng).</div>`
    : '';

const missingProduct = `<span class="thumb thumb-missing" aria-hidden="true">!</span>
  <span class="pname err" data-error="product">${PRODUCT_ERROR_TEXT}</span>`;

// ---------- Web ----------
function webItem(it) {
  const p = it.product;
  const body = p
    ? `<img class="thumb" src="${esc(p.thumbnailUrl)}" width="40" height="40" alt="">
       <span class="pname">${esc(p.name)}</span>
       <span class="price">${vnd.format(p.price)}</span>`
    : `${missingProduct}<span class="price err">—</span>`;
  return `<li class="item${p ? '' : ' item-error'}" data-item-row>${body}<span class="qty">× ${esc(it.quantity)}</span></li>`;
}

export function renderWeb(root, { model, errors }) {
  const { user, orders } = model;
  root.innerHTML = `
    <header class="profile" data-user>
      <img class="avatar" src="${esc(user.avatarUrl)}" width="56" height="56" alt="">
      <div><h1>${esc(user.name)}</h1><p class="muted">${esc(user.email)} · ${esc(user.id)}</p></div>
      <div class="summary"><strong>${orders.length}</strong> đơn</div>
    </header>
    ${partialBanner(errors)}
    <section class="orders">
      ${orders
        .map(
          (o) => `
        <article class="order" data-order-row data-order-id="${esc(o.id)}">
          <div class="order-head">
            <span class="oid">${esc(o.id)}</span>
            ${statusBadge(o.status)}
            <time datetime="${esc(o.createdAt)}">${dateFmt.format(new Date(o.createdAt))}</time>
            <strong class="total">${vnd.format(o.totalAmount)}</strong>
          </div>
          <div class="order-meta muted">${esc(o.shippingAddress)}${o.note ? ` · Ghi chú: ${esc(o.note)}` : ''}</div>
          <ul class="items">${o.items.map(webItem).join('')}</ul>
        </article>`,
        )
        .join('')}
    </section>`;
}

// ---------- Mobile ----------
function mobileItem(it) {
  const p = it.product;
  const body = p
    ? `<img class="thumb" src="${esc(p.thumbnailUrl)}" width="36" height="36" alt=""><span class="pname">${esc(p.name)}</span>`
    : missingProduct;
  return `<li class="item${p ? '' : ' item-error'}" data-item-row>${body}</li>`;
}

export function renderMobile(root, { model, errors }) {
  root.innerHTML = `
    <header class="m-head"><h1>Đơn hàng của tôi</h1><span class="muted">${model.orders.length} đơn</span></header>
    ${partialBanner(errors)}
    <ul class="m-orders">
      ${model.orders
        .map(
          (o) => `
        <li class="m-order" data-order-row data-order-id="${esc(o.id)}">
          <div class="m-order-head"><span class="oid">${esc(o.id)}</span>${statusBadge(o.status)}</div>
          <ul class="items">${o.items.map(mobileItem).join('')}</ul>
        </li>`,
        )
        .join('')}
    </ul>`;
}

function renderScreenError(root, err) {
  root.innerHTML = `
    <div class="screen-error" role="alert" data-screen-error>
      <h1>Không tải được màn hình</h1>
      <p>Mã lỗi: <code>${esc(err.code ?? 'CLIENT_ERROR')}</code>${err.httpStatus ? ` (HTTP ${esc(err.httpStatus)})` : ''}</p>
      <p class="muted">${esc(err.message)}</p>
      <button type="button" onclick="location.reload()">Thử lại</button>
    </div>`;
}

// ---------- Metrics của lượt demo ----------
function metricCard(label, value, note) {
  return `<div class="metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`;
}

function renderMetrics(root, { counts, browserRequests, tDataMs }) {
  const serviceCalls = counts.user_calls + counts.order_calls + counts.product_calls;
  root.innerHTML = `
    <div class="metrics-head">
      <div><span class="metrics-kicker">Metrics của lần tải này</span><h2>Request, DB query và response time</h2></div>
      <code>rid ${esc(counts.rid.slice(0, 8))}</code>
    </div>
    <div class="metrics-grid">
      ${metricCard('Response time', `${tDataMs.toFixed(1)} ms`, 'data-start → screen-complete')}
      ${metricCard('Browser request', browserRequests, 'request dữ liệu từ client')}
      ${metricCard('Service call', serviceCalls, `User ${counts.user_calls} · Order ${counts.order_calls} · Product ${counts.product_calls}`)}
      ${metricCard('User DB', counts.user_db, `${counts.user_calls} service call`)}
      ${metricCard('Order DB', counts.order_db, `${counts.order_calls} service call`)}
      ${metricCard('Product DB', counts.product_db, `${counts.product_calls} service call`)}
    </div>
    <div class="metrics-foot">
      <span>Preflight <b>${esc(counts.preflight)}</b></span>
      <span>DataLoader cache-hit <b>${esc(counts.cache_hits)}</b></span>
      <span>Timeout <b>${esc(counts.timed_out)}</b></span>
      <span>Đối chiếu call <b class="${counts.count_check === 'ok' ? 'metric-ok' : 'metric-warn'}">${esc(counts.count_check)}</b></span>
    </div>`;
  root.hidden = false;
}

function renderMetricsError(root, message) {
  root.innerHTML = `<div class="metrics-error"><b>Chưa đọc được metrics.</b> ${esc(message)}</div>`;
  root.hidden = false;
}

async function loadDemoMetrics(rid, result) {
  const root = document.getElementById('metrics');
  if (!root) return;
  root.hidden = false;
  root.innerHTML = '<p class="metrics-loading">Đang tổng hợp request và DB query…</p>';
  try {
    const response = await fetch(`/__metrics/${encodeURIComponent(rid)}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    const dataStart = performance.getEntriesByName('data-start', 'mark')[0];
    const screenComplete = performance.getEntriesByName('screen-complete', 'mark')[0];
    renderMetrics(root, {
      counts: body,
      browserRequests: result.raw.length,
      tDataMs: screenComplete.startTime - dataStart.startTime,
    });
  } catch (err) {
    renderMetricsError(root, err.message);
  }
}

// ---------- Mốc đo ----------
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function waitImages(root, timeoutMs) {
  const pending = [...root.querySelectorAll('img')].filter((img) => !img.complete);
  const settled = (img) =>
    new Promise((r) => {
      img.addEventListener('load', r, { once: true });
      img.addEventListener('error', r, { once: true });
    });
  const all = Promise.all(pending.map(settled));
  return Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
}

export async function runScreen(kind) {
  const params = new URLSearchParams(location.search);
  const interactiveDemo = !params.has('rid');
  const variant = params.get('variant') || 'bff';
  const userId = params.get('user') || 'u_small';
  const rid = params.get('rid') || crypto.randomUUID();
  const root = document.getElementById('app');

  window.__rid = rid;
  document.title = `${kind} · ${variant} · ${userId}`;
  document.querySelectorAll('[data-variant-label]').forEach((el) => (el.textContent = `${variant} · ${userId} · rid ${rid.slice(0, 8)}`));

  const adapter = ADAPTERS[variant];
  const load = kind === 'web' ? adapter?.loadWeb : adapter?.loadMobile;

  performance.mark('data-start');
  let result;
  let status;
  try {
    if (!load) throw Object.assign(new Error(`Biến thể ${variant} không có client ${kind}`), { code: 'UNKNOWN_VARIANT' });
    result = await load(userId, rid);
    status = result.errors.length ? 'partial' : 'ok';
    (kind === 'web' ? renderWeb : renderMobile)(root, result);
  } catch (err) {
    status = 'error';
    result = { model: null, errors: [{ message: err.message, path: [], extensions: { code: err.code ?? 'CLIENT_ERROR' } }], raw: [] };
    renderScreenError(root, err);
  }
  await nextFrame();
  await nextFrame();

  const rows = root.querySelectorAll('[data-order-row]').length;
  const items = root.querySelectorAll('[data-item-row]').length;
  performance.mark('screen-complete', { detail: { status, rows, items } });

  window.__screenStatus = status;
  window.__screenData = result.model;
  window.__screenErrors = result.errors;
  window.__raw = result.raw;

  // Chỉ hiện ở demo thủ công. Các lượt Playwright luôn truyền rid nên request
  // metrics không làm thay đổi static_requests hay timing của phép đo.
  if (interactiveDemo) await loadDemoMetrics(rid, result);

  await waitImages(root, 10_000);
  performance.mark('images-complete');
  window.__done = true;
}
