import type { Mode, Order, Reservation, Payment, LedgerEntry, Movement, Wallet } from '../src/shared/types.js';
import { buildLogEntries, type Trace, type WorkflowEvent, type ProcessEvent, type LogEntry } from './log-format.js';

interface Product { sku: string; name: string; price: number; category: string; art: string; color: string; available: number | null }
interface Snapshot { order: Order; inventory: { available: boolean; data: { reservation: Reservation | null } | null }; payment: { available: boolean; data: { payment: Payment | null; ledger: LedgerEntry[] } | null } }
interface Draft { key: string; sku: string; quantity: number; scenario: string; mode?:Mode; f4DowntimeMs?:number;checkoutMode?:'manual'|'automatic' }
interface SagaView { saga_id: string; retry_count:number; retry_limit:number; retry_exhausted:number; resume_blocked:number; charge_uncertain:number;phase: string; intent: { action: string; operationId: string } | null; pending: string[]; history: WorkflowEvent[] }
interface F4RecoveryView {status:'stopping'|'waiting'|'starting'|'failed';restoreAt:number;orderId:string;error?:string}
interface Health { service: 'order' | 'inventory' | 'payment'; available: boolean; pid: number | null }
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const money = (value: number) => `${new Intl.NumberFormat('vi-VN').format(value)} ₫`;
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const art = (product: Product, cssClass = '') => `<div class="${cssClass}" style="background:${escape(product.color)}"><svg aria-hidden="true" viewBox="0 0 300 220"><use href="/products.svg#${escape(product.art)}"></use></svg></div>`;
let mode: Mode = localStorage.getItem('checkout.mode') === 'baseline' ? 'baseline' : 'saga';
// Preserve pending create keys from the previously selected legacy context.
if (!localStorage.getItem('checkout.two-modes')) {
  const legacy = `checkout.saga.${localStorage.getItem('checkout.version') || 'v3'}`;
  for (const suffix of ['order','draft']) {
    const value = localStorage.getItem(`${legacy}.${suffix}`);
    if (value && !localStorage.getItem(`checkout.saga.${suffix}`)) localStorage.setItem(`checkout.saga.${suffix}`,value);
  }
  localStorage.setItem('checkout.two-modes','true');
}
const contextKey = () => 'checkout.shared';
if(!localStorage.getItem('checkout.shared-data')){
  for(const suffix of ['order','draft']){
    const value=localStorage.getItem(`checkout.${mode}.${suffix}`);
    if(value && !localStorage.getItem(`${contextKey()}.${suffix}`))localStorage.setItem(`${contextKey()}.${suffix}`,value);
  }
  localStorage.setItem('checkout.shared-data','true');
}
let version = 0;
let products: Product[] = [];
let checkoutMode: 'manual'|'automatic' = localStorage.getItem('checkout.flow')==='automatic'?'automatic':'manual';
let wallets: Wallet[]=[];
let selectedWallet='main';
let paymentBusy=false;
let detailSignature='';
let orders: Order[] = [];
let selectedSku = 'LAMP-01';
let activeId = localStorage.getItem(`${contextKey()}.order`) || '';
let tab: 'shop' | 'inventory' | 'backend' = 'shop';
let selectedTrace = '';
let traces: Trace[] = [];
let workflowHistory:WorkflowEvent[]=[];
let processEvents:ProcessEvent[]=[];
let followLogs=true;
let logEntries:LogEntry[]=[];
const logPageSize=40;
let logLimit=logPageSize;
let logListSignature='';
let ledgerEntries:LedgerEntry[]=[];
let ledgerError='';
let ledgerSignature='';
let ledgerRequest=0;
let lastDetailId='';
let traceReadFailed=false;
let inventoryItems:(Product & {held:number})[]=[];
let inventoryMovements:Movement[]=[];
let inventoryError='';
let inventorySignature='';
let inventoryRequest=0;
let submitting = false;
let placed = false;
let draft: Draft | null = null;
let traceVersion = 0;
let faultEnabled = false;
let controlsEnabled = false;
let automaticCrashMarkers = false;
let f4Recovery:F4RecoveryView|null=null;
let durationConfigured=false;
let health: Health[] = [];
const controlling = new Set<string>();

const statuses: Record<string, { label: string; color: string; message: string }> = {
  PROCESSING: { label: 'Đang xử lý', color: 'info', message: 'Hệ thống đang giữ hàng và xử lý thanh toán cho đơn của bạn.' },
  AWAITING_PAYMENT: { label:'Chờ thanh toán', color:'warning', message:'Hàng đã được giữ cho đơn này. Chọn ví rồi thanh toán; bạn cũng có thể hủy trước khi bắt đầu thanh toán.' },
  RECOVERING: { label: 'Đang kiểm tra', color: 'warning', message: 'Chưa nhận được kết quả cuối cùng. Hệ thống đang kiểm tra lại; bạn không cần đặt thêm đơn.' },
  COMPENSATING: { label: 'Đang bù', color: 'compensation', message: 'Đơn không thể xác nhận. Còn các bước hoàn tiền hoặc trả hàng cần hoàn tất trước khi hủy xong; xem tiến trình để biết bước đang chờ.' },
  CONFIRMED: { label: 'Đã xác nhận', color: 'success', message: 'Đặt hàng thành công. Tiền đã thu, hàng đã chốt cho đơn này. Kho đã trừ khả dụng lúc giữ chỗ, không trừ lần thứ hai khi xác nhận.' },
  CANCELLED: { label: 'Đã hủy', color: 'neutral', message: 'Đơn đã được hủy hoàn tất. Không còn hàng bị giữ và mọi khoản đã thu đều được hoàn lại.' },
  FAILED: { label: 'Chưa hoàn tất', color: 'error', message: 'Đặt hàng chưa hoàn tất. Trong chế độ Baseline, hàng hoặc khoản thanh toán đã ghi nhận có thể vẫn còn; cần kiểm tra trước khi đặt đơn mới.' },
  REQUIRES_REVIEW: { label: 'Cần kiểm tra', color: 'warning', message: 'Kết quả thanh toán chưa rõ và chế độ Baseline không tự phục hồi. Không nên đặt thêm đơn khi chưa đối soát.' },
};
const descriptions: Record<string, string> = {
  H: 'Các bước đều hoạt động bình thường. Đơn được xác nhận với một reservation và một charge.',
  F1: 'Inventory từ chối giữ hàng. Không được tạo charge; Saga kết thúc bằng đơn đã hủy.',
  F2: 'Payment từ chối sau khi hàng đã được giữ. So sánh reservation còn lại ở Baseline và release ở Saga.',
  F3: 'Thanh toán đã thành công nhưng bước xác nhận bị từ chối. Saga phải refund và release, giữ nguyên lịch sử charge.',
  F4: 'Payment đã thu tiền rồi bị dừng trước response. Sau thời gian đã chọn, launcher tự khởi động lại Payment. Saga giữ RECOVERING, query ID cũ rồi tự xác nhận; Baseline vẫn chờ kiểm tra.',
  F5: 'Refund bị giữ lỗi cho tới khi bạn bấm Gỡ lỗi refund và tiếp tục. Đơn phải còn COMPENSATING, chưa release hoặc báo đã hủy.',
  F6: 'Order bị kill sau khi refund commit, trước khi lưu kết quả hoàn tiền. Khôi phục Order để query refund ID cũ, rồi release và hủy đơn đúng một lần.',
};

async function api<T>(path: string, options: RequestInit = {}, targetMode = mode): Promise<T> {
  const response = await fetch(`/api/${targetMode}${path}`, { ...options, headers: { 'content-type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(8000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}
function stateTone(state:string){
  return statuses[state]?.color || ({HELD:'warning',RELEASED:'success',CHARGED:'success',REFUNDED:'info',UNAVAILABLE:'error'} as Record<string,string>)[state] || 'neutral';
}
function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
function quantity() { return Math.max(1, Math.min(99, Number($<HTMLInputElement>('#quantity').value) || 1)); }
function saveDraft() { if (draft) localStorage.setItem(`${contextKey()}.draft`, JSON.stringify(draft)); else localStorage.removeItem(`${contextKey()}.draft`); }
function loadDraft() {
  try { draft = JSON.parse(localStorage.getItem(`${contextKey()}.draft`) || 'null') as Draft | null; } catch { draft = null; }
  if (draft) { selectedSku = draft.sku; $<HTMLInputElement>('#quantity').value = String(draft.quantity); }
  if (draft) checkoutMode=draft.checkoutMode || 'automatic';
  if(draft?.mode)mode=draft.mode;
  if(draft && checkoutMode==='automatic')$<HTMLSelectElement>('#scenario').value=draft.scenario;
  if(draft?.f4DowntimeMs!==undefined){$<HTMLInputElement>('#f4-duration').value=String(draft.f4DowntimeMs/1000);durationConfigured=true;}
}
function modeUI() {
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  $('#mode-caption').textContent = mode === 'baseline' ? 'Đơn mới: Baseline · Không tự bù' : 'Đơn mới: Saga · Tự bù và phục hồi có giới hạn retry';
  document.querySelectorAll<HTMLButtonElement>('[data-flow]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.flow===checkoutMode)));
  $('#checkout-flow-note').textContent=checkoutMode==='manual'?'Bạn tự tạo đơn, chọn ví và thanh toán. Có thể hủy trước khi thanh toán.':'Chọn tình huống ở đây, sau đó bấm Chạy lab trong phần Đặt hàng. Hệ thống tự xử lý tới bước xác nhận.';
  syncRunSettings();
}
function syncRunSettings(){
  const locked=submitting || paymentBusy || !!draft;
  document.querySelectorAll<HTMLButtonElement>('[data-flow],[data-mode]').forEach(button=>{button.disabled=locked;});
  $('#run-settings-lock').hidden=!locked;
  $('#run-settings-lock').textContent=submitting?'Đang gửi yêu cầu, tạm giữ nguyên thiết lập.':paymentBusy?'Đang gửi thao tác thanh toán / hủy, tạm giữ nguyên thiết lập.':draft?'Yêu cầu trước chưa được xác nhận. Gửi lại cùng yêu cầu hoặc chọn Tạo đơn mới để đổi thiết lập.':'';
  updateFault();
}
function updateFault() {
  const select = $<HTMLSelectElement>('#scenario');
  $('#run-settings').dataset.checkoutMode=checkoutMode;
  $('#lab-scenario-field').hidden=checkoutMode==='manual';
  $('#scenario-description').hidden=checkoutMode==='manual';
  select.disabled=!faultEnabled || checkoutMode==='manual' || submitting || paymentBusy || !!draft;
  if(checkoutMode==='manual')select.value='H';
  const allowed = ['H','F1','F2','F3','F4','F5','F6'];
  for (const option of Array.from(select.options)) option.disabled = !allowed.includes(option.value) || (['F4','F6'].includes(option.value) && !automaticCrashMarkers);
  if (select.selectedOptions[0]?.disabled && !draft) select.value = 'H';
  const scenario = $<HTMLSelectElement>('#scenario').value;
  $('#run-settings').dataset.scenario=checkoutMode==='automatic'?scenario:'H';
  $('#f4-duration-field').hidden=checkoutMode!=='automatic' || scenario!=='F4';
  $<HTMLInputElement>('#f4-duration').disabled=select.disabled;
  $('#scenario-description').textContent = faultEnabled ? descriptions[scenario] : 'Các tình huống gây lỗi đang tắt. Lab chỉ chạy luồng thành công H0.';
  $('#fault-badge').hidden = scenario === 'H';
  $('#fault-badge').textContent = `Đơn mới: tình huống ${scenario}`;
}
function renderProducts() {
  $('#products').innerHTML = products.map(p => `<button class="product" data-sku="${escape(p.sku)}" aria-pressed="${p.sku === selectedSku}" ${draft || placed || submitting ? 'disabled' : ''} aria-label="Chọn ${escape(p.name)}"><div class="product-art" style="background:${escape(p.color)}"><svg aria-hidden="true" viewBox="0 0 300 220"><use href="/products.svg#${escape(p.art)}"></use></svg><span class="product-check">✓</span></div><div class="product-info"><div class="product-category">${escape(p.category)}</div><h3 class="product-name">${escape(p.name)}</h3><div class="product-price">${money(p.price)}</div><span class="stock-label">${p.available === null ? 'Chưa đọc được tồn kho' : `${p.available} sản phẩm khả dụng`}</span></div></button>`).join('');
  renderCheckout();
}
function renderCheckout() {
  syncRunSettings();
  const p = products.find(p => p.sku === selectedSku);
  $('#selected-product').innerHTML = p ? `${art(p, 'selected-art')}<div><h3>${escape(p.name)}</h3><p>${escape(p.sku)} · ${money(p.price)}</p></div>` : '<p>Đang đọc sản phẩm…</p>';
  $('#subtotal').textContent = p ? money(p.price * quantity()) : '—';
  $('#total').textContent = p ? money(p.price * quantity()) : '—';
  $('#checkout-count').textContent = `${String(quantity()).padStart(2, '0')} sản phẩm`;
  const locked = submitting || placed || !!draft;
  for (const selector of ['#quantity', '#quantity-minus', '#quantity-plus']) $(selector).toggleAttribute('disabled', locked);
  const button = $<HTMLButtonElement>('#place-order');
  button.disabled = !p || submitting || placed;
  button.innerHTML = submitting ? 'Đang gửi yêu cầu…' : placed ? 'Đã tiếp nhận đơn <span>✓</span>' : draft ? 'Gửi lại cùng yêu cầu <span>↗</span>' : checkoutMode==='manual'?'Tạo đơn hàng <span>↗</span>':`Chạy lab ${$<HTMLSelectElement>('#scenario').value==='H'?'H0':$<HTMLSelectElement>('#scenario').value} <span>↗</span>`;
  $('#new-order').hidden = !placed && !draft;
}
function setActive(id: string) {
  activeId = id;
  selectedTrace = '';traces=[];workflowHistory=[];processEvents=[];followLogs=true;traceReadFailed=false;
  logLimit=logPageSize;logListSignature='';$('#traces').scrollTop=0;
  traceVersion++;
  localStorage.setItem(`${contextKey()}.order`, id);
  renderOrders(); renderDetail();renderTraces();
  $('#snapshots').innerHTML='';$('#saga-info').textContent='Đang đọc tiến trình của đơn được chọn…';$('#saga-history').innerHTML='';
  if (tab === 'backend') void refreshTraces();
}
function renderOrders() {
  $('#orders').innerHTML = orders.length ? orders.map(order => {
    const s = statuses[order.status];
    return `<button class="order-row ${order.id === activeId ? 'active' : ''}" data-order="${escape(order.id)}" data-order-mode="${order.mode}"><span class="order-name"><strong>${escape(order.product_name)} <span>× ${order.quantity}</span></strong><small><span class="order-mode">${order.mode==='saga'?'Saga':'Baseline'}</span> · #${escape(order.id.slice(0, 8))} · ${order.checkout_mode==='manual'?'Thủ công':'Tự động'} · ${new Date(order.created_at).toLocaleString('vi-VN')}</small></span><span class="order-amount">${money(order.total)}</span><span class="badge ${s.color}">${s.label}</span></button>`;
  }).join('') : `<div class="empty">${health.some(h=>h.service==='order' && !h.available) ? 'Order không truy cập được; chưa đọc được danh sách đơn.' : 'Chưa có đơn hàng. Hãy chọn món đồ đầu tiên của bạn.'}</div>`;
  const select = $<HTMLSelectElement>('#trace-order');
  select.innerHTML = orders.length ? orders.map(order => `<option value="${escape(order.id)}">${order.mode==='saga'?'Saga':'Baseline'} · #${escape(order.id.slice(0, 8))} · ${escape(order.product_name)} · ${statuses[order.status].label}</option>`).join('') : activeId ? `<option value="${escape(activeId)}">#${escape(activeId.slice(0,8))} · Order không truy cập được</option>` : '<option value="">Chưa có đơn hàng</option>';
  select.value = activeId;
}
function renderDetail() {
  syncRunSettings();
  const order = orders.find(o => o.id === activeId);
  $('#order-detail').hidden = !order;
  if (!order) {detailSignature='';return;}
  const orderDown = health.some(h => h.service === 'order' && !h.available);
  const status = orderDown ? { label: 'Order không truy cập được', color: 'warning', message: 'Order đang dừng. Dữ liệu đơn dưới đây là lần đọc gần nhất; xem tab backend để kiểm tra kho/thanh toán và khôi phục Order.' } : statuses[order.status];
  const done = [true, !!order.reservation_id, !!order.payment_id, order.status === 'CONFIRMED'];
  const reason=order.failure_reason || order.last_error;
  const message=orderDown?status.message:order.status==='REQUIRES_REVIEW' && order.mode==='saga'?'Đã dừng tự động vì hết lượt thử lại. Tiền và hàng vẫn giữ theo trạng thái đã ghi nhận; xem tab backend để khắc phục lỗi và tiếp tục cùng đơn.':order.status==='CANCELLED' && reason==='USER_CANCELLED'?'Bạn đã hủy đơn trước thanh toán. Hàng đã được trả lại và ví không bị trừ tiền.':reason==='INSUFFICIENT_FUNDS'?`Ví không đủ số dư để thanh toán. ${order.status==='CANCELLED'?'Đơn đã hủy và hàng đã được trả lại.':order.status==='FAILED'?'Baseline chưa trả lại hàng đã giữ; xem trạng thái kho ở tab backend.':status.message}`:reason==='OUT_OF_STOCK'?'Không đủ hàng để tiếp nhận đơn. Chưa phát sinh thanh toán.':status.message;
  const signature=JSON.stringify([order,orderDown,wallets,selectedWallet,paymentBusy]);
  if(signature===detailSignature)return;
  detailSignature=signature;
  const paymentPanel=order.step==='AWAIT_PAYMENT'?`<div class="payment-panel"><div><h3>Thanh toán đơn hàng</h3><p>Số tiền do server xác nhận: <strong>${money(order.total)}</strong></p></div><label for="payment-wallet">Chọn ví thanh toán</label><select id="payment-wallet" ${paymentBusy||!wallets.length?'disabled':''}>${wallets.length?wallets.map(w=>`<option value="${escape(w.id)}" ${w.id===selectedWallet?'selected':''}>${escape(w.name)} · Số dư ${money(w.balance)}</option>`).join(''):'<option>Chưa đọc được số dư ví</option>'}</select><div class="payment-actions"><button id="pay-order" class="primary" ${paymentBusy||orderDown||!wallets.length?'disabled':''}>${paymentBusy?'Đang gửi yêu cầu…':`Thanh toán ${money(order.total)}`} <span>↗</span></button><button id="cancel-order" class="secondary" ${paymentBusy||orderDown?'disabled':''}>Hủy đơn</button></div><small>Số dư được kiểm tra và trừ tại Payment Service; thanh toán mô phỏng trong lab.</small></div>`:'';
  const wallet=wallets.find(w=>w.id===order.wallet_id);
  const receipt=order.status==='CONFIRMED' && wallet?`<p class="payment-receipt">Đã thanh toán bằng ${escape(wallet.name)} · Số dư hiện tại: <strong>${money(wallet.balance)}</strong></p>`:'';
  $('#order-detail').innerHTML = `<div class="order-detail-head"><div><h2>Đơn hàng #${escape(order.id.slice(0, 8))}</h2><p>${escape(order.product_name)} × ${order.quantity} · ${money(order.total)} · <strong data-testid="order-mode">${order.mode==='saga'?'Saga':'Baseline'}</strong></p><button class="text-button" data-copy-order>Sao chép mã đơn</button></div><span class="badge ${status.color}" data-testid="order-status">${status.label}</span></div><div class="status-message">${message}</div><div class="inventory-explainer" data-testid="stock-stage"><strong>${orderDown?"Kho: chưa đối soát được đơn":order.status==='CONFIRMED'?"Hàng đã chốt cho đơn":order.status==='CANCELLED'?"Không còn giữ hàng":order.status==='AWAITING_PAYMENT'?"Hàng đang giữ tạm":"Hàng: đang xử lý / cần đối soát"}</strong><span>${orderDown?"Order đang dừng. Đây là dữ liệu lần đọc trước; xem trạng thái thực từ Inventory và Payment ở tab backend.":order.status==='CONFIRMED'?"Đã thu tiền. Số khả dụng giảm từ bước giữ chỗ; xác nhận không trừ kho thêm.":order.status==='CANCELLED'?"Hàng đã giữ được nhả lại vào số khả dụng; nếu giữ chỗ bị từ chối thì kho không đổi.":order.status==='AWAITING_PAYMENT'?"Đã giảm số khả dụng để dành hàng cho bạn. Ví chưa bị trừ; hủy đơn sẽ nhả lại hàng.":"Không suy từ timeout ra kết quả kho hoặc tiền. Xem trạng thái Inventory và Payment trong tab backend."}</span></div><div class="progress">${['Tiếp nhận', 'Giữ hàng', 'Thanh toán', 'Xác nhận'].map((label, i) => `<div class="progress-step ${done[i] ? 'done' : ''}">${label}</div>`).join('')}</div>${paymentPanel}${receipt}<button class="text-button detail-link" data-view-backend>Xem phản hồi backend ↗</button>`;
}
function switchTab(next: typeof tab) {
  tab = next;
  for (const name of ['shop', 'inventory', 'backend'] as const) {
    $(`#tab-${name}`).setAttribute('aria-selected', String(name === tab));
    $(`#panel-${name}`).hidden = name !== tab;
  }
  if (next === 'backend') void refreshTraces();
  if (next === 'inventory') void refreshInventory();
}

async function refresh() {
  const epoch = version;
  const currentMode = mode;
  await refreshHealth();
  const [productResponse, list, walletResult] = await Promise.allSettled([api<{ products: Product[] }>('/products', {}, currentMode), api<Order[]>('/orders', {}, currentMode),api<Wallet[]>('/payments/wallets',{},currentMode)]);
  if (epoch !== version) return;
  if (productResponse.status === 'fulfilled') products = productResponse.value.products;
  wallets=walletResult.status==='fulfilled'?walletResult.value:[];
  if (list.status === 'fulfilled') {
    orders = list.value;
    if (!activeId || !orders.some(o => o.id === activeId)) activeId = orders[0]?.id || '';
  }
  renderProducts(); renderOrders(); renderDetail();
  if (tab === 'backend') await refreshTraces();
  if (tab === 'inventory') await refreshInventory();
}

async function refreshInventory(){
  const epoch=version;const request=++inventoryRequest;const currentMode=mode;
  const query=new URLSearchParams();
  const sku=$<HTMLSelectElement>('#stock-sku').value;const kind=$<HTMLSelectElement>('#stock-kind').value;
  if(sku)query.set('sku',sku);if(kind)query.set('kind',kind);
  const [items,movements]=await Promise.allSettled([
    api<(Product & {held:number})[]>('/inventory/items',{},currentMode),
    api<Movement[]>(`/inventory/movements?${query}`,{},currentMode),
  ]);
  if(epoch!==version || request!==inventoryRequest)return;
  if(items.status==='fulfilled')inventoryItems=items.value;
  if(movements.status==='fulfilled')inventoryMovements=movements.value;
  inventoryError=items.status==='rejected' || movements.status==='rejected'?'Chưa đọc được đầy đủ dữ liệu Inventory. Nếu đã có dữ liệu bên dưới, đó là lần đọc trước.':'';
  renderInventory();
}
function renderInventory(){
  const signature=JSON.stringify([inventoryItems,inventoryMovements,inventoryError]);
  if(signature===inventorySignature)return;inventorySignature=signature;
  $('#inventory-note').textContent=inventoryError || 'Kho dùng chung cho Baseline và Saga · vẫn xem được khi Order đang dừng.';
  $('#stock-cards').innerHTML=inventoryItems.length?inventoryItems.map(p=>`<article class="stock-card" data-stock-sku="${escape(p.sku)}"><div class="stock-product">${art(p,'stock-art')}<div><h2>${escape(p.name)}</h2><small>${escape(p.sku)}</small></div></div><div class="stock-counts"><div><strong data-available>${p.available}</strong><span>Tồn kho</span></div></div></article>`).join(''):'<div class="empty">Chưa đọc được tồn kho.</div>';
  const select=$<HTMLSelectElement>('#stock-sku');const selected=select.value;
  select.innerHTML='<option value="">Tất cả sản phẩm</option>'+inventoryItems.map(p=>`<option value="${escape(p.sku)}">${escape(p.name)}</option>`).join('');select.value=selected;
  $('#stock-history-count').textContent=`${inventoryMovements.length} bản ghi · toàn bộ lịch sử theo bộ lọc · mới nhất ở trên`;
  const history=$('#stock-history');const scroll=history.scrollTop;
  const openIds=Array.from(history.querySelectorAll<HTMLDetailsElement>('details[open]')).map(d=>d.closest<HTMLElement>('[data-movement-id]')?.dataset.movementId);
  $('#stock-history').className=inventoryMovements.length?'data-table-wrap stock-history':'empty';
  $('#stock-history').innerHTML=inventoryMovements.length?`<table class="data-table stock-table"><thead><tr><th>Thời gian</th><th>Sản phẩm</th><th>Hoạt động</th><th>Khả dụng sau đó</th></tr></thead><tbody>${inventoryMovements.map(m=>{
    const name=inventoryItems.find(p=>p.sku===m.sku)?.name || m.sku || 'Sản phẩm';
    return `<tr data-movement="${escape(m.kind)}" data-movement-id="${escape(m.id)}"><td>${escape(new Date(m.created_at).toLocaleString('vi-VN'))}</td><td>${escape(name)}<small>${escape(m.sku)} · ${m.mode==='baseline'?'Baseline':'Saga'}</small></td><td><span class="movement-label ${m.kind==='RELEASE'?'released':'reserved'}">${m.kind==='RELEASE'?'Trả lại':'Giữ chỗ'} ${m.quantity} sản phẩm</span><small>${m.delta>0?'+':''}${m.delta} khả dụng</small></td><td>${m.available_after===null?'Không có số liệu cũ':m.available_after}${m.source.startsWith('LEGACY_')?'<small>Trước khi gộp dữ liệu</small>':''}</td></tr>`;
  }).join('')}</tbody></table>`:'Chưa có hoạt động giữ / trả hàng phù hợp.';
  history.querySelectorAll<HTMLDetailsElement>('details').forEach(d=>{d.open=openIds.includes(d.closest<HTMLElement>('[data-movement-id]')?.dataset.movementId);});
  history.scrollTop=scroll;
}

async function refreshLedger(){
  const epoch=version;const request=++ledgerRequest;const currentMode=mode;
  try{
    const entries=await api<LedgerEntry[]>('/payments/ledger',{},currentMode);
    if(epoch!==version || request!==ledgerRequest)return;
    ledgerEntries=entries;ledgerError='';
  }catch{
    if(epoch!==version || request!==ledgerRequest)return;
    ledgerError='Chưa đọc được Payment. Dữ liệu đã hiển thị là lần đọc trước; chưa biết kết quả mới.';
  }
  renderLedger();
}
function renderLedger(){
  const signature=JSON.stringify([ledgerEntries,ledgerError]);
  if(signature===ledgerSignature)return;ledgerSignature=signature;
  $('#ledger-count').textContent=`${ledgerEntries.length} bản ghi · tất cả đơn`;
  $('#ledger-note').textContent=ledgerError || 'Toàn bộ khoản thu và hoàn tiền của cả Baseline và Saga, mới nhất ở trên. Kho và ví được dùng chung; đổi cơ chế không đổi lịch sử.';
  const target=$('#ledger');const scroll=target.scrollTop;
  const openIds=Array.from(target.querySelectorAll<HTMLDetailsElement>('details[open]')).map(d=>d.closest<HTMLElement>('[data-ledger-id]')?.dataset.ledgerId);
  target.className=ledgerEntries.length?'data-table-wrap ledger-history':'empty';
  target.innerHTML=ledgerEntries.length?`<table class="data-table stock-table"><thead><tr><th>Thời gian</th><th>Hoạt động</th><th>Số tiền</th><th>Ví</th><th>Đơn hàng / chi tiết</th></tr></thead><tbody>${ledgerEntries.map(e=>`<tr data-ledger-id="${escape(e.id)}" data-ledger-kind="${e.kind}"><td>${escape(new Date(e.created_at).toLocaleString('vi-VN'))}</td><td><span class="movement-label ${e.kind==='REFUND'?'released':'reserved'}">${e.kind==='REFUND'?'Hoàn tiền':'Thu tiền'}</span><small>${e.kind} · ${e.mode==='baseline'?'Baseline':'Saga'}</small></td><td>${e.kind==='REFUND'?'+':'−'}${money(e.amount)}</td><td>${e.wallet_id==='main'?'Ví chính':e.wallet_id==='limited'?'Ví phụ':escape(e.wallet_id || 'Dữ liệu cũ')}</td><td><details><summary>Đơn #${escape(e.order_id?.slice(0,8) || '—')} · xem mã đầy đủ</summary><p>Đơn hàng <code>${escape(e.order_id || '—')}</code></p><p>Payment <code>${escape(e.payment_id)}</code></p><p>Operation <code>${escape(e.operation_id)}</code></p></details></td></tr>`).join('')}</tbody></table>`:ledgerError?'Chưa có dữ liệu để hiển thị. Cần kết nối lại Payment để đọc lịch sử.':'Chưa có khoản thu hoặc hoàn tiền trong hệ thống.';
  target.querySelectorAll<HTMLDetailsElement>('details').forEach(d=>{d.open=openIds.includes(d.closest<HTMLElement>('[data-ledger-id]')?.dataset.ledgerId);});
  target.scrollTop=scroll;
}

function paymentRecoveryMessage(){
  if(!f4Recovery)return '';
  const message=f4Recovery.status==='waiting'?`Tự khởi động lại sau ${Math.max(0,Math.ceil((f4Recovery.restoreAt-Date.now())/1000))} giây · F4`:f4Recovery.status==='stopping'?'Đang dừng Payment theo kịch bản F4':f4Recovery.status==='starting'?'Đang tự khởi động lại Payment':'Chưa khởi động lại được Payment. Có thể dùng nút Khôi phục service.';
  return `<p class="f4-recovery-note" data-testid="f4-recovery">${escape(message)}</p>`;
}
async function refreshHealth() {
  try {
    const response = await fetch('/lab/health', { signal: AbortSignal.timeout(2500) });
    const body = await response.json() as { services: Health[]; controlsEnabled: boolean; automaticCrashMarkers: boolean; f4Recovery:F4RecoveryView|null };
    health = body.services; controlsEnabled = body.controlsEnabled; automaticCrashMarkers = body.automaticCrashMarkers;f4Recovery=body.f4Recovery;
    $('#services').innerHTML = health.map(h => `<div class="snapshot-card" data-service="${h.service}" data-available="${h.available}"><h3>${h.service}</h3><div class="snapshot-status badge ${h.available?'success':'error'}">${h.available ? 'Đang chạy' : 'Không truy cập được'}</div><p>${h.pid ? `PID ${h.pid}` : 'Chưa thể đọc dữ liệu mới từ service này.'}</p>${h.service==='payment'?paymentRecoveryMessage():''}<button class="service-control ${h.available?'service-stop':'service-start'}" data-control="${h.available ? 'stop' : 'start'}" data-service="${h.service}" ${!controlsEnabled || controlling.has(h.service) ? 'disabled' : ''}>${controlling.has(h.service)?'Đang xử lý…':h.available ? '⏸ Dừng service' : '↻ Khôi phục service'}</button></div>`).join('');
    updateFault();
  } catch { $('#services').innerHTML = '<div class="empty">Không truy cập được UI launcher.</div>'; }
}

function dataTable(selector: string, headings: string[], rows: unknown[][], empty = 'Chưa có bản ghi cho đơn này.') {
  const target = $(selector);
  target.className = rows.length ? 'data-table-wrap' : 'empty';
  target.innerHTML = rows.length ? `<table class="data-table"><thead><tr>${headings.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : escape(empty);
}
const clock = (time: string) => new Date(time).toLocaleTimeString('vi-VN');

async function refreshTraces() {
  await refreshLedger();
  const epoch = version;
  const generation = ++traceVersion;
  const id = activeId;
  const currentMode = orders.find(o=>o.id===id)?.mode || mode;
  if (!id) {
    traces=[];workflowHistory=[];processEvents=[];selectedTrace='';renderTraces();
    $('#snapshots').innerHTML = ''; $('#traces').innerHTML = '<div class="empty">Chưa có đơn để quan sát. Hãy tạo một đơn ở tab Đặt hàng.</div>'; $('#payload').innerHTML = '';
    $('#saga-info').textContent = 'Chọn đơn Saga để xem tiến trình.'; $('#saga-history').innerHTML = '';
    $('#restore-refund').hidden = true; $('#resume-saga').hidden = true;
    return;
  }
  try {
    const [traceResult, detailResult, sagaResult, inventoryResult, paymentResult, eventsResult] = await Promise.allSettled([
      api<Trace[]>(`/orders/${id}/traces`, {}, currentMode),
      api<{ order: Order }>(`/orders/${id}`, {}, currentMode),
      api<SagaView>(`/orders/${id}/saga`, {}, currentMode),
      api<{ reservation: Reservation | null }>(`/inventory/orders/${id}/state`, {}, currentMode),
      api<{ payment: Payment | null }>(`/payments/orders/${id}/state`, {}, currentMode),
      fetch(`/lab/events?orderId=${encodeURIComponent(id)}${orders.find(o=>o.id===id)?.created_at?'&since='+encodeURIComponent(orders.find(o=>o.id===id)!.created_at):''}`).then(r => {if(!r.ok)throw new Error('EVENTS_UNAVAILABLE');return r.json() as Promise<ProcessEvent[]>;}),
    ]);
    if (epoch !== version || id !== activeId || generation !== traceVersion) return;
    if (traceResult.status === 'fulfilled') traces = traceResult.value;
    traceReadFailed=traceResult.status==='rejected';
    if(sagaResult.status==='fulfilled')workflowHistory=sagaResult.value.history;
    if(eventsResult.status==='fulfilled')processEvents=eventsResult.value;
    const order = detailResult.status === 'fulfilled' ? detailResult.value.order : orders.find(o => o.id === id);
    if(detailResult.status==='fulfilled'){
      orders=orders.map(o=>o.id===id?detailResult.value.order:o);renderOrders();renderDetail();
    }
    const reservation = inventoryResult.status === 'fulfilled' ? inventoryResult.value.reservation : null;
    const payment = paymentResult.status === 'fulfilled' ? paymentResult.value.payment : null;
    const ledger = ledgerEntries.filter(e=>e.order_id===id);
    $('#snapshots').innerHTML = [
      { name: 'Order', state: detailResult.status === 'rejected' || health.some(h => h.service === 'order' && !h.available) ? 'UNAVAILABLE' : order?.status || 'Không có đơn', detail: order ? `${order.step} · ${money(order.total)}${detailResult.status === 'rejected' ? ' · lần đọc trước' : ''}` : 'Chưa đọc được trạng thái.' },
      { name: 'Inventory', state: inventoryResult.status === 'rejected' ? 'UNAVAILABLE' : reservation?.status || 'Không có reservation', detail: inventoryResult.status === 'rejected' ? 'Không đọc được trạng thái; không suy đoán kết quả.' : reservation ? `${reservation.sku} × ${reservation.quantity} · ${reservation.status==='RELEASED'?'Đã nhả, cộng lại khả dụng':detailResult.status==='fulfilled' && order?.status==='CONFIRMED'?'Đã chốt cho đơn; không trừ kho thêm lần nữa':detailResult.status==='fulfilled' && order?.status==='AWAITING_PAYMENT'?'Giữ tạm, đã giảm khả dụng; chưa thu tiền':'Hàng còn giữ; chưa xác nhận bán, cần theo dõi kết quả'}` : 'Không có hàng được giữ cho đơn này.' },
      { name: 'Payment', state: paymentResult.status === 'rejected' ? 'UNAVAILABLE' : payment?.status || 'Không có charge', detail: paymentResult.status === 'rejected' ? 'Không đọc được trạng thái; không suy đoán kết quả.' : `${ledger.filter(e => e.kind === 'CHARGE').length} charge · ${ledger.filter(e => e.kind === 'REFUND').length} refund` },
    ].map(card => `<div class="snapshot-card"><h3>${card.name}</h3><div class="snapshot-status badge ${stateTone(card.state)}">${escape(card.state)}</div><p>${escape(card.detail)}</p></div>`).join('');
    if (sagaResult.status === 'fulfilled') {
      const saga = sagaResult.value;
      $('#saga-info').className = 'saga-kv';
      $('#saga-info').innerHTML = `<div><small>Saga ID</small><code>${escape(saga.saga_id)}</code></div><div><small>Phase</small><strong>${escape(saga.phase)}</strong></div><div><small>Intent đã lưu</small><code>${escape(saga.intent?.operationId || 'Không còn intent')}</code></div><div><small>Việc còn chờ</small><strong>${escape(saga.pending.join(' → ') || (saga.charge_uncertain && saga.retry_exhausted?'Chờ Payment phục hồi để đối soát':saga.phase==='awaiting_payment'?'Chờ khách thanh toán':order?.step === 'DONE' ? 'Đã hoàn tất' : 'Bước tiến đang chạy'))}</strong></div>`;
      $('#saga-info').insertAdjacentHTML('beforeend', `<div data-testid="retry-state"><small>Thử lại bước hiện tại</small><strong>${saga.retry_count} / ${saga.retry_limit} lần</strong><p>${saga.retry_exhausted?saga.charge_uncertain?'Chờ Payment phục hồi · tự đối soát bằng ID cũ':saga.phase==='compensate'?'Đang bù · hết lượt thử, chờ khắc phục':'Đã hết lượt · chờ xử lý thủ công':order?.step==='DONE'?'Đã hoàn tất':saga.phase==='awaiting_payment'?'Chờ khách thanh toán':'1 lần gọi đầu + tối đa '+saga.retry_limit+' lần thử lại'}</p></div>`);
      dataTable('#saga-history', ['Thời gian', 'Sự kiện', 'Trạng thái / bước', 'Lỗi cuối'], saga.history.map(h => [clock(h.created_at), h.event, `${h.status} / ${h.step}`, h.error || '—']));
    } else {
      $('#saga-info').className = 'empty';
      $('#saga-info').textContent = order?.mode === 'baseline' ? 'Baseline không có Saga record hoặc tự bù.' : 'Order không truy cập được; intent vẫn được giữ trong DB. Inventory và Payment bên dưới được đọc độc lập.';
      const checkpoint=processEvents.find(e=>e.event==='COORDINATOR_BEFORE_REFUND_OUTCOME' && e.orderId===id);
      if(checkpoint){
        $('#saga-info').className='saga-kv';
        $('#saga-info').innerHTML=`<div><small>Đã lưu trước khi Order dừng</small><strong>${escape(checkpoint.orderStatus)} / ${escape(checkpoint.step)}</strong></div><div><small>Refund ID đã lưu</small><code>${escape(checkpoint.operationId)}</code></div><div><small>Các bước còn chờ theo checkpoint</small><strong>${escape(Array.isArray(checkpoint.pending)?checkpoint.pending.join(' → '):'')}</strong></div><div><small>Đọc trạng thái hiện tại</small><strong>Cần khôi phục Order; Payment và Inventory vẫn được đọc độc lập.</strong></div>`;
      }
    }
    if (eventsResult.status === 'fulfilled') dataTable('#process-events', ['Thời gian', 'Service', 'Marker / sự kiện', 'PID / Operation ID'], eventsResult.value.filter(e => e.orderId === id || ['READY', 'PROCESS_KILLED', 'PROCESS_EXITED'].includes(e.event)).slice(-20).reverse().map(e => [clock(e.time), e.service, e.event, e.operationId || e.pid || '—']));
    $('#restore-refund').hidden = !(order?.mode === 'saga' && order?.scenario === 'F5' && order.step !== 'DONE');
    $('#resume-saga').hidden = !(order?.mode === 'saga' && sagaResult.status==='fulfilled' && !(order.scenario==='F4' && sagaResult.value.charge_uncertain) && !!sagaResult.value.resume_blocked && order && !['DONE','AWAIT_PAYMENT'].includes(order.step));
    const waitingAction = sagaResult.status==='fulfilled' ? sagaResult.value.intent?.action || '' : '';
    const waitingService = ['charge','refund'].includes(waitingAction) ? 'payment' : ['reserve','release'].includes(waitingAction) ? 'inventory' : 'order';
    $<HTMLButtonElement>('#resume-saga').disabled = detailResult.status === 'rejected' || controlling.size>0 || health.some(h=>h.service===waitingService && !h.available);
    $<HTMLButtonElement>('#restore-refund').disabled = controlling.size>0 || health.some(h=>h.service==='payment' && !h.available);
    renderTraces();
  } catch (error) { if (epoch === version) notice(`Chưa đọc được phản hồi backend: ${error instanceof Error ? error.message : ''}`); }
}
function renderTraces() {
  logEntries=buildLogEntries(traces,workflowHistory,processEvents);
  const filter=$<HTMLSelectElement>('#log-filter').value;
  const matching=logEntries.filter(entry=>filter==='all' || entry.kind===filter);
  if(!followLogs){
    const oldest=Array.from($('#traces').querySelectorAll<HTMLElement>('[data-trace]')).at(-1)?.dataset.trace;
    const oldIndex=matching.findIndex(e=>e.id===oldest);
    if(oldIndex>=0)logLimit=Math.max(logLimit,oldIndex+1);
  }
  const visible=matching.slice(0,logLimit);
  if(selectedTrace && !logEntries.some(entry=>entry.id===selectedTrace))selectedTrace='';
  $('#trace-count').textContent=`${logEntries.filter(e=>e.kind==='http').length} lượt HTTP · ${logEntries.filter(e=>e.kind!=='http').length} sự kiện${traceReadFailed?' · HTTP Order là dữ liệu lần trước':''}`;
  $('#follow-logs').setAttribute('aria-pressed',String(followLogs));
  updateLogFollowButton();
  const list=$('#traces');const scroll=list.scrollTop;const top=list.getBoundingClientRect().top;
  const anchor=Array.from(list.querySelectorAll<HTMLElement>('[data-trace]')).find(row=>row.getBoundingClientRect().bottom>top+1);
  const anchorId=anchor?.dataset.trace;const anchorOffset=anchor?anchor.getBoundingClientRect().top-top:0;
  const html=visible.length?visible.map(entry=>`<button class="trace-row ${entry.id===selectedTrace?'active':''}" data-trace="${escape(entry.id)}" data-log-kind="${entry.kind}" data-log-action="${escape(entry.trace?.action || '')}" data-log-time="${escape(entry.time)}" aria-pressed="${entry.id===selectedTrace}"><span class="trace-dot ${entry.tone}"></span><span class="trace-row-info"><strong>${escape(entry.title)}</strong><span class="log-message">${escape(entry.message)}</span><small>${clock(entry.time)} · ${escape(entry.source)}</small></span><span class="log-kind">${entry.kind==='http'?'HTTP':entry.kind==='workflow'?'Nội bộ':'Service'}</span></button>`).join('')+`<div class="log-page-note">Đang hiển thị ${visible.length} / ${matching.length} hoạt động${visible.length<matching.length?' · cuộn xuống để xem cũ hơn':' · đã hết lịch sử'}</div>${visible.length<matching.length?'<button class="log-load-more" data-load-older>Xem log cũ hơn ↓</button>':''}`:'<div class="empty">Chưa có hoạt động phù hợp. Dữ liệu mới sẽ được cập nhật tại đây.</div>';
  if(html!==logListSignature){list.innerHTML=html;logListSignature=html;}
  if(followLogs)list.scrollTop=0;
  else{
    const restored=Array.from(list.querySelectorAll<HTMLElement>('[data-trace]')).find(row=>row.dataset.trace===anchorId);
    list.scrollTop=restored?list.scrollTop+restored.getBoundingClientRect().top-list.getBoundingClientRect().top-anchorOffset:scroll;
  }
  const entry=logEntries.find(e=>e.id===selectedTrace);
  $('#log-detail').hidden=!entry;
  $('#log-layout').classList.toggle('has-selection',!!entry);
  if(!entry){$('#payload').innerHTML='';$('#trace-meta').textContent='';lastDetailId='';return;}
  const pretty=(value:unknown)=>escape(typeof value==='string'?value:JSON.stringify(value,null,2));
  const parse=(value:string|null)=>{if(!value)return 'Không có body';try{return JSON.parse(value);}catch{return value;}};
  $('#trace-meta').textContent=entry.trace?.duration_ms!==null && entry.trace?.duration_ms!==undefined?`${entry.trace.duration_ms} ms`:entry.client?.durationMs!==undefined?`${entry.client.durationMs} ms`:'';
  let detail=`<p class="log-summary"><strong>${escape(entry.title)}</strong><br>${escape(entry.message)}</p>`;
  if(entry.trace){
    const t=entry.trace;
    detail+=`<div class="path">${t.method} ${escape(t.path)}<br>Operation ID: ${escape(t.operation_id || '—')}</div><h3>Request</h3><pre>${pretty(parse(t.request_body))}</pre><h3>Response · ${escape(t.transport_error || t.http_status || 'chưa lưu phản hồi')}</h3><pre>${t.transport_error?escape('Không nhận được HTTP response: '+t.transport_error):!t.complete?'Không có response được lưu cho lượt gọi gốc. Đây không phải trạng thái PENDING của operation.':pretty(parse(t.response_body))}</pre>`;
    if(entry.reconciledBy)detail+=`<p class="reconciled-note">Đã đối soát bằng lượt query sau đó. Response gốc được giữ nguyên.</p><button class="secondary" data-related-trace="${escape(entry.reconciledBy.id)}">Xem lượt đối soát →</button>`;
  }else if(entry.client){
    const e=entry.client;
    detail+=`<div class="path">${escape(e.method)} ${escape(e.path)}</div><h3>Request</h3><pre>${pretty(e.request ?? 'Không có body')}</pre><h3>Response · ${escape(e.status)}</h3><pre>${pretty(e.response)}</pre>`;
  }else{
    detail+=`<h3>${entry.kind==='workflow'?'Sự kiện nội bộ — không phải lượt gọi HTTP':'Sự kiện từ launcher'}</h3><pre>${pretty(entry.raw)}</pre>`;
  }
  const payload=$('#payload');const payloadScroll=payload.scrollTop;
  if(payload.innerHTML!==detail)payload.innerHTML=detail;
  payload.scrollTop=lastDetailId!==entry.id?0:payloadScroll;lastDetailId=entry.id;
}
function updateLogFollowButton(){
  $('#follow-logs').setAttribute('aria-pressed',String(followLogs));
  $('#follow-logs').textContent=followLogs?'Đang xem mới nhất ↑':'Về mới nhất ↑';
}
function loadOlderLogs(){
  const filter=$<HTMLSelectElement>('#log-filter').value;
  const count=logEntries.filter(e=>filter==='all' || e.kind===filter).length;
  if(logLimit>=count)return;
  followLogs=false;logLimit+=logPageSize;renderTraces();
}

document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (submitting || paymentBusy || draft) return;
  const next = button.dataset.mode as Mode;
  if (next === mode) return;
  mode = next; placed=false;
  localStorage.setItem('checkout.mode', mode);notice();modeUI();renderProducts();renderOrders();renderDetail();void configure();
}));
$('#tab-shop').addEventListener('click', () => switchTab('shop'));
$('#tab-backend').addEventListener('click', () => switchTab('backend'));
$('#tab-inventory').addEventListener('click', () => switchTab('inventory'));
$('#refresh-inventory').addEventListener('click',()=>{void refreshInventory();});
for(const selector of ['#stock-sku','#stock-kind'])$(selector).addEventListener('change',()=>{void refreshInventory();});
document.querySelectorAll<HTMLButtonElement>('[data-flow]').forEach(button=>button.addEventListener('click',()=>{
  if(submitting || paymentBusy || draft)return;
  checkoutMode=button.dataset.flow as 'manual'|'automatic';localStorage.setItem('checkout.flow',checkoutMode);modeUI();renderCheckout();
}));
$('#products').addEventListener('click', event => {
  if (draft || placed || submitting) return;
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-sku]');
  if (button) { selectedSku = button.dataset.sku!; renderProducts(); }
});
$('#quantity-minus').addEventListener('click', () => { $<HTMLInputElement>('#quantity').value = String(Math.max(1, quantity() - 1)); renderCheckout(); });
$('#quantity-plus').addEventListener('click', () => { $<HTMLInputElement>('#quantity').value = String(Math.min(99, quantity() + 1)); renderCheckout(); });
$('#quantity').addEventListener('change', () => { $<HTMLInputElement>('#quantity').value = String(quantity()); renderCheckout(); });
$('#place-order').addEventListener('click', async () => {
  if (submitting || placed) return;
  if(!draft && checkoutMode==='automatic' && $<HTMLSelectElement>('#scenario').value==='F4'){
    const input=$<HTMLInputElement>('#f4-duration');const ms=Number(input.value)*1000;
    if(!input.value || !Number.isSafeInteger(ms) || ms<0 || ms>60000){notice('Thời gian dừng Payment cần từ 0 đến 60 giây, tối đa 3 chữ số thập phân.');input.focus();return;}
  }
  submitting = true;
  draft ||= { key: crypto.randomUUID(), sku: selectedSku, quantity: quantity(), scenario: checkoutMode==='manual'?'H':$<HTMLSelectElement>('#scenario').value, mode,checkoutMode,f4DowntimeMs:Math.round(Number($<HTMLInputElement>('#f4-duration').value)*1000) };
  saveDraft(); renderProducts(); notice();
  const epoch = version;
  try {
    const result = await api<{ order: Order }>('/orders', { method: 'POST', headers: { 'Idempotency-Key': draft.key }, body: JSON.stringify({ sku: draft.sku, quantity: draft.quantity, scenario: draft.scenario, checkout_mode:draft.checkoutMode || 'automatic',...(draft.scenario==='F4'?{f4_downtime_ms:draft.f4DowntimeMs}:{}) }) });
    if (epoch !== version) return;
    placed = true; draft = null; saveDraft(); activeId = result.order.id; orders = [result.order, ...orders.filter(o => o.id !== activeId)]; localStorage.setItem(`${contextKey()}.order`, activeId);
    traces=[];workflowHistory=[];processEvents=[];selectedTrace='';followLogs=true;traceVersion++;
    await refresh();
  } catch (error) { if (epoch === version) notice(`Chưa xác nhận được yêu cầu: ${error instanceof Error ? error.message : ''}. Gửi lại sẽ dùng cùng mã yêu cầu, không tạo thêm đơn.`); }
  finally { submitting = false; renderProducts(); }
});
$('#new-order').addEventListener('click', () => { if(paymentBusy)return;placed = false; draft = null; saveDraft(); notice(); renderProducts(); });
$('#orders').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-order]'); if (button) setActive(button.dataset.order!); });
$('#order-detail').addEventListener('change',event=>{if((event.target as HTMLElement).id==='payment-wallet')selectedWallet=(event.target as HTMLSelectElement).value;});
$('#order-detail').addEventListener('click', async event => {
  if((event.target as HTMLElement).closest('[data-copy-order]')){try{await navigator.clipboard.writeText(activeId);notice('Đã sao chép mã đơn đầy đủ.');}catch{notice(`Mã đơn: ${activeId}`);}return;}
  if ((event.target as HTMLElement).closest('[data-view-backend]')) {switchTab('backend');return;}
  const action=(event.target as HTMLElement).closest<HTMLButtonElement>('#pay-order,#cancel-order');
  if(!action || action.disabled || paymentBusy)return;
  const id=activeId;const epoch=version;const currentMode=orders.find(o=>o.id===id)?.mode || mode;const walletId=$<HTMLSelectElement>('#payment-wallet').value;
  paymentBusy=true;renderDetail();notice();
  try {
    const result=await api<{order:Order}>(`/orders/${id}/${action.id==='pay-order'?'pay':'cancel'}`,{method:'POST',body:JSON.stringify({walletId})},currentMode);
    if(epoch!==version)return;
    orders=orders.map(o=>o.id===id?result.order:o);await refresh();
  }catch(error){if(epoch===version)notice(`Chưa xác nhận được thao tác: ${String(error)}. Nếu thanh toán chưa rõ kết quả, kiểm tra lại đơn này trước khi tạo đơn mới.`);}
  finally{paymentBusy=false;renderDetail();}
});
$('#trace-order').addEventListener('change', event => setActive((event.target as HTMLSelectElement).value));
$('#traces').addEventListener('click', event => {
  if((event.target as HTMLElement).closest('[data-load-older]')){loadOlderLogs();return;}
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-trace]'); if (button) { selectedTrace = button.dataset.trace!;followLogs=false;renderTraces(); }
});
$('#traces').addEventListener('scroll',()=>{
  const list=$('#traces');
  if(list.scrollTop>8 && followLogs){followLogs=false;updateLogFollowButton();}
  if(!followLogs && list.scrollTop>0 && list.scrollHeight-list.clientHeight-list.scrollTop<120)loadOlderLogs();
},{passive:true});
$('#follow-logs').addEventListener('click',()=>{followLogs=true;selectedTrace='';logLimit=logPageSize;renderTraces();});
$('#close-log').addEventListener('click',()=>{selectedTrace='';renderTraces();});
$('#log-filter').addEventListener('change',()=>{selectedTrace='';followLogs=true;logLimit=logPageSize;renderTraces();});
$('#payload').addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-related-trace]');if(button){selectedTrace=button.dataset.relatedTrace!;followLogs=false;renderTraces();}});
$('#refresh-orders').addEventListener('click', () => { void refresh(); });
$('#refresh-traces').addEventListener('click', () => { void refreshTraces(); });
$('#scenario').addEventListener('change',()=>{updateFault();renderCheckout();});
$('#f4-duration').addEventListener('input',()=>{durationConfigured=true;});
$('#services').addEventListener('click', async event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-control]');
  if (!button || button.disabled) return;
  const service = button.dataset.service!;
  controlling.add(service); button.disabled = true;
  $<HTMLButtonElement>('#resume-saga').disabled=true;
  $<HTMLButtonElement>('#restore-refund').disabled=true;
  try {
    const response = await fetch(`/lab/services/${service}/${button.dataset.control}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({orderId:activeId,mode:orders.find(o=>o.id===activeId)?.mode || mode}) });
    if (!response.ok) throw new Error((await response.json()).error);
    notice();
  } catch (error) { notice(`Chưa điều khiển được service: ${String(error)}`); }
  finally { controlling.delete(service); await refresh(); }
});
$('#resume-saga').addEventListener('click', async () => {
  try { await api(`/sagas/${activeId}/resume`, { method: 'POST', body: '{}' },orders.find(o=>o.id===activeId)?.mode || mode); notice(); await refreshTraces(); }
  catch (error) { notice(`Chưa tiếp tục được Saga: ${String(error)}`); }
});
$('#restore-refund').addEventListener('click', async () => {
  try {
    await api(`/payments/faults/${activeId}/restore`, { method: 'POST', body: '{}' },orders.find(o=>o.id===activeId)?.mode || mode);
    await api(`/sagas/${activeId}/resume`, { method: 'POST', body: '{}' },orders.find(o=>o.id===activeId)?.mode || mode);
    notice(); await refreshTraces();
  } catch (error) { notice(`Chưa khôi phục được refund: ${String(error)}`); }
});
async function configure() {
  const epoch = version;
  try { const c = await api<{ faultsEnabled: boolean;f4DowntimeMs:number }>('/config'); if (epoch !== version) return; faultEnabled = c.faultsEnabled;if(!durationConfigured){$<HTMLInputElement>('#f4-duration').value=String(c.f4DowntimeMs/1000);durationConfigured=true;} $<HTMLSelectElement>('#scenario').disabled = !faultEnabled; if (!faultEnabled) $<HTMLSelectElement>('#scenario').value = 'H'; updateFault(); } catch {}
}
loadDraft(); modeUI(); void configure();
async function poll() { await refresh(); setTimeout(() => { void poll(); }, 1000); }
void poll();
