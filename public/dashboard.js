'use strict';
const $ = id => document.getElementById(id);
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => new Intl.NumberFormat('vi-VN').format(value);
let state, busy = false, casesRendered = false, eventKey = '', offline = false, messages = [], retryJob = '', selectedArrow = null;
function toast(message, error = false) { $('toast').hidden = false; $('toast').className = 'toast' + (error ? ' error' : ''); $('toast').textContent = message; }
function showResult(data, label = '') {
  closePayload();
  const steps = data.steps || [];
  const failed = data.error || data.status === 'failed';
  const booking = data.booking;
  if (booking && data.job) retryJob = data.job;
  const duplicate = data.result?.duplicate;
  const banner = failed ? (data.error ? errorMessage(data.error) : 'Thanh toán chưa thành công. Vé chưa được xác nhận; xem phản hồi Wallet bên dưới.') :
    booking ? ['pending', 'running'].includes(data.status) ? 'Đã tạo vé. Thanh toán đang chờ xử lý; vé chưa được xác nhận.' : duplicate ? 'Vé đã được đặt trước đó. Gửi lại thành công và không trừ thêm tiền.' : 'Đặt vé thành công! Chuyến đi đã được xác nhận và thanh toán.' :
    caseMessage(data) || data.conclusion || data.explanation || label;
  const details = booking ? `<dl class="ticket-summary"><div><dt>Mã vé</dt><dd>${h(booking.ticket_id)}</dd></div><div><dt>Chuyến đi</dt><dd>${h(booking.from)} → ${h(booking.to)}</dd></div><div><dt>Hành khách</dt><dd>${h(booking.passenger)}</dd></div><div><dt>Giá vé</dt><dd>${money(booking.amount)} đ</dd></div><div><dt>Mã chuyến</dt><dd>${h(booking.trip_id)}</dd></div></dl>` : '';
  const diagram = (data.trace || steps).length ? sequenceDiagram(data.trace || steps) : '<p class="muted">Thao tác này chưa có trace để hiển thị.</p>';
  $('result').innerHTML = `<div class="result-tabs" role="tablist" aria-label="Cách xem kết quả"><button id="message-tab" role="tab" data-result-tab="message" aria-selected="true" aria-controls="message-panel">Thông báo</button><button id="sequence-tab" role="tab" data-result-tab="sequence" aria-selected="false" aria-controls="sequence-panel" tabindex="-1">Sequence diagram</button></div><section id="message-panel" role="tabpanel" aria-labelledby="message-tab"><div class="result-banner ${failed || data.protected === false ? 'warning' : 'success'}" role="status"><h3>${h(banner)}</h3>${details}${!booking && steps.length ? `<p>${h(steps.at(-1).explanation)}</p>` : ''}${data.due_at ? `<p>Thanh toán dự kiến lúc ${new Date(data.due_at * 1000).toLocaleTimeString('vi-VN')}. Bạn có thể đăng xuất Taxi.</p>` : ''}</div></section><section id="sequence-panel" role="tabpanel" aria-labelledby="sequence-tab" hidden>${diagram}</section><aside id="payload-detail" class="payload-popover" popover="manual" role="dialog" aria-labelledby="payload-title" tabindex="-1"></aside>`;
  $('responses').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function caseMessage(data) {
  if (typeof data.protected !== 'boolean') return '';
  const outcomes = {
    redirect: ['Đã chặn callback lạ. AS không gửi mã ủy quyền đến địa chỉ chưa đăng ký.', 'AS đã gửi mã ủy quyền đến callback chưa đăng ký. Mã có thể lọt vào tay bên khác.'],
    pkce: ['Đã từ chối yêu cầu thiếu PKCE. Client phải có challenge hợp lệ để bắt đầu liên kết.', 'AS chấp nhận yêu cầu thiếu PKCE và vẫn cấp mã ủy quyền.'],
    code_replay: ['Đã chặn việc dùng lại mã ủy quyền và thu hồi quyền của token cấp trước đó.', 'Mã ủy quyền đã được dùng lại nhưng luồng chưa chặn và thu hồi quyền đầy đủ.'],
    refresh_replay: ['Đã phát hiện token refresh cũ bị dùng lại. Cả nhóm token liên quan đã bị vô hiệu hóa.', 'AS chấp nhận token refresh cũ hoặc chưa vô hiệu hóa cả nhóm token sau khi bị dùng lại.'],
    wrong_secret: ['Đã chặn client dùng secret sai. Client này không nhận được token.', 'AS chấp nhận client dùng secret sai và vẫn cấp token.'],
    m2m: ['Ứng dụng đọc được bảng giá, nhưng bị chặn khi trừ tiền ví và xin thêm quyền thanh toán.', 'Quyền ứng dụng chưa được giới hạn đầy đủ. Xem các bước xin quyền và thử trừ tiền bên dưới.']
  };
  return outcomes[data.id]?.[data.protected ? 0 : 1] || '';
}
function sequenceDiagram(steps) {
  messages = [];
  function pair(step, from = step.from === 'Người dùng' ? 0 : 1, to = step.service === 'Wallet AS' ? 2 : step.service === 'Wallet API' ? 3 : 1) {
    if (from === to) {
      messages.push({ from, to, label: step.endpoint.startsWith('Tạo vé và chuyến') ? 'Đã tạo vé và chuyến' : step.endpoint,
        kind: 'Xử lý nội bộ', payload: { input: step.request, result: step.response }, explanation: step.explanation, status: step.status });
      return;
    }
    messages.push({ from, to, label: step.endpoint, kind: 'Request', payload: step.request, explanation: step.explanation });
    (step.children || []).forEach(child => pair(child));
    messages.push({ from: to, to: from, label: `${step.status} · ${step.endpoint}`, kind: 'Response', payload: step.response, explanation: step.explanation, status: step.status });
  }
  steps.forEach(step => pair(step));
  const height = 95 + messages.length * 64, x = [85, 285, 485, 685];
  return `<p class="muted small">Trình tự từ trên xuống. Mũi tên liền là request, nét đứt là response; mũi tên quay về cùng server là một bước xử lý nội bộ. Bấm để xem dữ liệu. Sơ đồ chỉ hiển thị các bước đã ghi nhận.</p><div class="sequence-scroll"><svg class="sequence" viewBox="0 0 770 ${height}" role="group" aria-label="Sequence diagram request và response"><defs><marker id="seq-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8" fill="currentColor"/></marker></defs>${['Người dùng', 'Taxi server', 'Wallet AS', 'Wallet API'].map((name, i) => `<rect class="participant" x="${x[i] - 70}" y="8" width="140" height="36" rx="8"/><text x="${x[i]}" y="31" text-anchor="middle">${name}</text><line class="lifeline" x1="${x[i]}" x2="${x[i]}" y1="44" y2="${height - 10}"/>`).join('')}${messages.map((m, i) => {
    const y = 85 + i * 64, start = x[m.from], end = x[m.to], self = start === end;
    return `<g class="sequence-message ${m.kind === 'Response' ? 'response' : ''} ${m.status >= 400 ? 'rejected' : ''}" data-message="${i}" role="button" tabindex="0" aria-label="${h(`${i + 1}. ${m.kind}: ${m.label}`)}" aria-pressed="false"><rect class="message-hit" x="${self ? start - 5 : Math.min(start, end)}" y="${y - 24}" width="${self ? 170 : Math.abs(end - start)}" height="52" rx="5"/><text x="${self ? start + 80 : (start + end) / 2}" y="${y - 8}" text-anchor="middle">${i + 1}. ${h(m.label)}</text><path class="message-line" d="${self ? `M${start} ${y} h150 v14 h-150` : `M${start} ${y} H${end}`}" marker-end="url(#seq-arrow)"/></g>`;
  }).join('')}</svg></div>`;
}
function selectMessage(index) {
  const m = messages[index]; if (!m) return;
  const arrow = document.querySelector(`[data-message="${index}"]`), popup = $('payload-detail');
  if (selectedArrow === arrow && popup.matches(':popover-open')) { closePayload(true); return; }
  selectedArrow = arrow;
  document.querySelectorAll('[data-message]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.message === String(index))));
  popup.innerHTML = `<header class="payload-heading"><div><span class="section-kicker">${h(m.kind)}</span><h3 id="payload-title">${h(m.label)}</h3></div><button type="button" data-close-payload aria-label="Đóng payload">×</button></header><div class="payload-body"><p>${h(m.explanation)}</p><pre>${h(m.payload === undefined ? 'Không có payload được ghi nhận cho bước này.' : JSON.stringify(m.payload, null, 2))}</pre></div>`;
  const bounds = arrow.getBoundingClientRect();
  if (bounds.top < 12 || bounds.bottom > innerHeight - 12) arrow.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
  popup.showPopover();
  positionPayload();
  popup.focus({ preventScroll: true });
}
function positionPayload() {
  const popup = $('payload-detail');
  if (!selectedArrow || !popup?.matches(':popover-open')) return;
  popup.style.maxHeight = 'min(500px, calc(100dvh - 24px))';
  const rect = selectedArrow.getBoundingClientRect(), width = popup.offsetWidth, gap = 12;
  if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) { closePayload(); return; }
  // Prefer beside the selected arrow; keep the popup inside the viewport on narrow screens.
  let left = rect.right + gap;
  if (left + width > innerWidth - gap) left = rect.left - width - gap;
  let top;
  if (left < gap) {
    left = Math.min(Math.max(gap, rect.left), innerWidth - width - gap);
    const below = innerHeight - rect.bottom - gap * 2, above = rect.top - gap * 2, placeBelow = below >= above;
    popup.style.maxHeight = `${Math.max(100, Math.min(500, placeBelow ? below : above))}px`;
    top = placeBelow ? rect.bottom + gap : rect.top - popup.offsetHeight - gap;
  } else top = rect.top;
  top = Math.min(Math.max(gap, top), innerHeight - popup.offsetHeight - gap);
  popup.style.left = `${left}px`; popup.style.top = `${top}px`;
}
function closePayload(restoreFocus = false) {
  const popup = $('payload-detail'), arrow = selectedArrow;
  if (popup?.matches(':popover-open')) popup.hidePopover();
  document.querySelectorAll('[data-message][aria-pressed="true"]').forEach(node => node.setAttribute('aria-pressed', 'false'));
  selectedArrow = null;
  if (restoreFocus && arrow?.isConnected) arrow.focus({ preventScroll: true });
}
function switchResultTab(name, focus = false) {
  closePayload();
  for (const tab of document.querySelectorAll('[data-result-tab]')) {
    const active = tab.dataset.resultTab === name;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !active;
    if (active && focus) tab.focus();
  }
}
function errorMessage(code) {
  const bookingErrors = { authentication_required: 'Hãy đăng nhập tài khoản Taxi trước khi tiếp tục.', consent_required: 'Bạn cần đồng ý cấp quyền tại Wallet AS trước khi tạo vé.', access_denied: 'Bạn đã từ chối cấp quyền. Taxi không tạo vé và không trừ tiền.', booking_not_found: 'Không tìm thấy vé thuộc tài khoản Taxi của bạn.', booking_in_progress: 'Vé đang được xử lý. Hãy chờ hoàn tất rồi gửi lại.', trip_not_found: 'Chuyến đi không tồn tại. Hãy chọn lại chuyến.', oauth_callback_failed: 'Không hoàn tất được cấp quyền. Taxi chưa tạo vé; hãy bắt đầu lại.' };
  if (bookingErrors[code]) return bookingErrors[code];
  return ({ wallet_unlinked: 'Ví chưa liên kết hoặc quyền refresh đã bị thu hồi. Hãy liên kết lại qua AS.', login_or_csrf_required: 'Hãy đăng nhập Taxi mẫu rồi thử lại.', csrf_failed: 'Phiên đã thay đổi. Hãy tải lại trang.', invalid_grant: 'AS đã từ chối grant. Taxi chuyển về chưa liên kết; hãy liên kết lại.', no_completed_job_to_retry: 'Cần có một job đã hoàn tất hoặc thất bại để gửi lại.', case_running: 'Một case đang chạy. Chờ hoàn tất rồi thử lại.', offline_access_missing: 'Liên kết này không có quyền offline_access.', refresh_failed_relink_required: 'Kết quả refresh không xác định. Taxi yêu cầu liên kết lại để tránh replay token cũ.' })[code] || `Không thực hiện được (${code}). Kiểm tra nhật ký và trạng thái server.`;
}
async function action(name, id) {
  if (busy || !state) return;
  busy = true; updateButtons();
  try {
    if (name === 'login') { location.assign('/login'); return; }
    if (['book', 'schedule'].includes(name) && !state.user) { sessionStorage.setItem('selected-trip', $('trip-choice').value); location.assign('/login?next=booking'); return; }
    if (name === 'retry') id = retryJob || state.jobs[0]?.id;
    const routes = { link: '/oauth/start', book: '/api/booking-intents', schedule: '/api/booking-intents', complete: '/api/bookings', balance: '/api/wallet/balance', refresh: '/api/wallet/refresh', logout: '/session/logout' };
    const route = name === 'case' ? `/testing/cases/${encodeURIComponent(id)}/runs` : name === 'retry' ? `/api/bookings/${encodeURIComponent(id)}/retry` : routes[name];
    const body = { csrf: state.csrf, ...(['book', 'schedule'].includes(name) ? { trip_id: $('trip-choice').value, payment_mode: name === 'schedule' ? 'offline' : 'immediate' } : {}), ...(name === 'complete' ? { intent_id: id } : {}) };
    const r = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const data = await r.json();
    if (data.redirect) { location.assign(data.redirect); return; }
    if (data.error && !data.steps?.length) { toast(errorMessage(data.error), true); showResult(data); }
    else if (name === 'logout') toast('Đã đăng xuất Taxi. Job đã được cấp quyền vẫn tiếp tục chạy phía server.');
    else showResult(data, name === 'charge' ? 'Taxi đã gửi thanh toán tới Wallet API.' : name === 'retry' ? 'Gửi lại cùng chuyến đi: kiểm duplicate và counter để xác nhận idempotency.' : name === 'balance' ? 'Taxi gọi API bằng token đang giữ phía server.' : name === 'refresh' ? 'Taxi yêu cầu AS refresh ngay.' : 'Kết quả thực thi');
    await load();
  } catch { toast('Không kết nối được server. Kiểm tra terminal chạy lab và thử lại.', true); }
  finally { busy = false; updateButtons(); }
}
function updateButtons() {
  document.querySelectorAll('[data-action]').forEach(button => {
    const action = button.dataset.action, linked = state?.link?.status === 'linked';
    button.disabled = busy || !state || (action !== 'book' && !state.user) || (['balance','refresh','retry'].includes(action) && !linked) || (action === 'retry' && !state.jobs.some(job => job.id === (retryJob || state.jobs[0]?.id) && ['completed', 'failed'].includes(job.status)));
  });
  $('session-button').disabled = busy || !state;
}
async function load() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' }); if (!r.ok) throw new Error(); state = await r.json();
    if (offline) { toast('Đã kết nối lại dashboard.'); offline = false; }
    const secure = state.mode === 'secure'; document.title = `${secure ? 'Full security' : 'Baseline'} · Wallet Lab`;
    $('baseline-tab').href = secure ? state.other : '/'; $('secure-tab').href = secure ? '/' : state.other;
    $('baseline-tab').classList.toggle('selected', !secure); $('secure-tab').classList.toggle('selected', secure);
    $('mode-notice').className = 'mode-notice' + (secure ? ' secure' : '');
    $('mode-notice').innerHTML = secure ? '<strong>◈ Full security</strong> AS kiểm client, callback, PKCE, code và refresh family. Các case cho thấy request bị chặn ở đâu.' : '<strong>△ Baseline</strong> AS cố ý thiếu kiểm tra OAuth để so sánh. Wallet API vẫn kiểm JWT và quyền; chỉ dùng dữ liệu giả.';
    $('session-label').textContent = state.user ? `● Taxi session: ${state.user}` : '○ Chưa đăng nhập Taxi';
    $('session-button').textContent = state.user ? 'Đăng xuất Taxi' : 'Đăng nhập Taxi';
    for (const service of ['as', 'api', 'taxi']) { const link = $(service + '-url'); link.href = state.services[service] + '/health'; link.textContent = state.services[service].replace('http://', ''); $(service + '-health').textContent = state.health[service] ? 'Đang chạy' : 'Mất kết nối'; $(service + '-health').className = 'health' + (state.health[service] ? '' : ' down'); }
    $('account-link').href = state.services.as + '/account';
    const linked = state.link?.status === 'linked'; $('link-status').textContent = linked ? `Đã liên kết · ${state.link.wallet_sub}` : 'Chưa liên kết'; $('link-status').className = 'pill' + (linked ? ' linked' : '');
    const walletUser = state.link?.wallet_sub || 'alice'; $('wallet-name').textContent = `Số dư ví ${walletUser} · VND`;
    $('balance').textContent = state.wallet ? money(state.wallet.wallets.find(w => w.user_id === walletUser)?.balance ?? 0) + ' đ' : '—';
    $('charge-count').textContent = state.wallet?.charge_count ?? '—';
    $('token-ttl').textContent = linked ? Math.max(0, state.link.token_exp - state.now) + ' giây' : '—';
    if (!$('trip-choice').options.length) {
      $('trip-choice').innerHTML = state.trips.map(trip => `<option value="${h(trip.id)}">${h(trip.origin)} → ${h(trip.destination)} · ${money(trip.fare)} đ</option>`).join('');
      const choice = sessionStorage.getItem('selected-trip');
      if (state.trips.some(trip => trip.id === choice)) $('trip-choice').value = choice;
    }
    if (!casesRendered) { $('case-grid').innerHTML = state.cases.map((item, i) => `<article class="case-card"><div class="case-index"><span>CASE ${String(i + 1).padStart(2, '0')}</span><span>↗</span></div><h3>${h(item.title)}</h3><p>${h(item.description)}</p><div class="target">${h(item.target)}</div><button data-action="case" data-id="${h(item.id)}">Chạy case <span>→</span></button></article>`).join(''); casesRendered = true; }
    $('job-list').innerHTML = state.jobs.length ? `<table><thead><tr><th>CHUYẾN ĐI</th><th>TRẠNG THÁI</th><th>THỜI ĐIỂM / CÒN LẠI</th><th>SỐ LẦN GỬI</th><th></th></tr></thead><tbody>${state.jobs.map(job => `<tr><td>${h(job.trip_id)}</td><td><span class="job-status ${h(job.status)}">${h(({pending:'Đang chờ',running:'Đang chạy',completed:'Hoàn tất',failed:'Thất bại'})[job.status] || job.status)}</span></td><td>${job.status === 'pending' ? Math.max(0, job.due_at - state.now) + ' giây nữa' : new Date(job.due_at * 1000).toLocaleTimeString('vi-VN')}</td><td>${job.attempts}</td><td><button class="job-detail" data-job="${h(job.id)}">Xem phản hồi ↗</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Chưa có job. Liên kết ví rồi thanh toán ngay hoặc đặt job chờ token hết hạn.</p>';
    const key = JSON.stringify(state.events); if (key !== eventKey) { eventKey = key; $('event-list').innerHTML = state.events.length ? state.events.map(event => `<details class="event"><summary><time>${new Date(event.at).toLocaleTimeString('vi-VN')}</time><span class="event-service">${h(event.service)}</span><span>${h(event.action)}</span><span class="status ${event.status >= 400 ? 'error' : ''}">${event.status}</span></summary><pre>${h(JSON.stringify(event.detail, null, 2))}</pre></details>`).join('') : '<p class="muted small">Chưa có hoạt động. Bắt đầu bằng liên kết ví hoặc chạy case.</p>'; }
    updateButtons();
  } catch { offline = true; toast('Dashboard chưa kết nối được. Kiểm tra cả ba server trong terminal.', true); }
}
document.addEventListener('click', event => {
  const tab = event.target.closest('[data-result-tab]'); if (tab) switchResultTab(tab.dataset.resultTab);
  if (event.target.closest('[data-close-payload]')) closePayload(true);
  else if (!event.target.closest('[data-message], #payload-detail')) closePayload();
  const message = event.target.closest('[data-message]'); if (message) selectMessage(Number(message.dataset.message));
  const button = event.target.closest('[data-action]'); if (button && !button.disabled) void action(button.dataset.action, button.dataset.id);
  const jobButton = event.target.closest('[data-job]'); if (jobButton) { const job = state.jobs.find(j => j.id === jobButton.dataset.job); if (job) showResult({ ...job.detail, job: job.id, status: job.status, due_at: job.status === 'pending' ? job.due_at : undefined, explanation: `Job ${job.status}; session Taxi khi chạy: ${job.detail.active_taxi_sessions ?? 'chưa chạy'}. Mỗi lần gửi giữ nguyên trip/idempotency key.` }); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closePayload(true);
  const tab = event.target.closest('[data-result-tab]');
  if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); switchResultTab(event.key === 'Home' ? 'message' : event.key === 'End' ? 'sequence' : tab.dataset.resultTab === 'message' ? 'sequence' : 'message', true);
  }
  const message = event.target.closest('[data-message]'); if (message && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectMessage(Number(message.dataset.message)); }
});
window.addEventListener('resize', () => closePayload());
window.addEventListener('scroll', event => { if (!$('payload-detail')?.contains(event.target)) positionPayload(); }, true);
$('session-button').addEventListener('click', () => action(state?.user ? 'logout' : 'login'));
$('trip-choice').addEventListener('change', () => sessionStorage.setItem('selected-trip', $('trip-choice').value));
const notice = new URLSearchParams(location.search).get('notice');
const callbackIntent = new URLSearchParams(location.search).get('intent');
if (notice) {
  const messages = { taxi_logged_in: 'Đã đăng nhập Taxi. Tiếp theo hãy đồng ý cấp quyền tại Wallet AS.', booking_authorized: 'Đã đồng ý cấp quyền. Taxi đang tiếp tục tạo vé và thanh toán.', linked: 'Đã liên kết ví sau khi cấp quyền tại Wallet AS.', callback_rejected: 'Callback không khớp state/session hoặc đã dùng. Hãy bắt đầu liên kết lại.', link_failed: 'Chưa được cấp quyền. Taxi không tạo vé hoặc trừ tiền.' };
  toast(messages[notice] || 'Luồng OAuth đã kết thúc.', ['callback_rejected', 'link_failed'].includes(notice));
  history.replaceState(null, '', '/');
}
void load().then(() => {
  if (notice === 'taxi_logged_in') void action('book');
  else if (notice === 'booking_authorized' && callbackIntent) void action('complete', callbackIntent);
  else if (['link_failed', 'linked'].includes(notice) && state?.oauth_result) showResult({ ...state.oauth_result, explanation: notice === 'linked' ? 'Đã liên kết ví sau khi đồng ý cấp quyền tại Wallet AS.' : 'Chưa được cấp quyền. Không có vé hoặc khoản thanh toán nào được tạo.' });
}); setInterval(load, 3000);
