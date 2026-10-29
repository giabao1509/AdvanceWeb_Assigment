const $ = id => document.getElementById(id);
let version = 'starter';
let busy = false;
const policies = {
  starter: ['AUTHENTICATION ONLY', 'Mọi endpoint chỉ kiểm tra token, chưa kiểm tra quyền trên tài nguyên. Có thể đọc/sửa/xóa và quản lý members ngoài project của mình.'],
  v1: ['OBJECT-LEVEL AUTHORIZATION', 'Mọi thao tác cần membership trong project chứa tài nguyên; chưa phân quyền theo role. Viewer vẫn sửa/xóa được trong project, từ V2 mới bị chặn.'],
  v2: ['PROJECT RBAC', 'Kế thừa V1 + Viewer đọc, Member đọc/sửa, Owner thêm quyền xóa project và quản lý members.'],
  v3: ['RBAC + ReBAC + ABAC', 'Kế thừa V2 + Member chỉ sửa task được assign cho mình và còn Open. Owner vẫn sửa được task Closed.'],
  v4: ['TENANT BOUNDARY', 'Kế thừa V3 + kiểm tra tenant trước project policy. Tenant admin có quyền Owner chỉ trong tenant của mình.'],
};
const presets = [
  ['IDOR · Alice đọc B1', 'alice','read','B1'],
  ['Hợp lệ · Alice đọc A1', 'alice','read','A1'],
  ['Hợp lệ · Charlie đọc B1', 'charlie','read','B1'],
  ['Anonymous đọc A1', '', 'read','A1'],
  ['Viewer thử sửa A1', 'vera','edit','A1'],
  ['Bob sửa A1 · assigned + Open', 'bob','edit','A1'],
  ['Bob sửa A2 · Closed', 'bob','edit','A2'],
  ['Bob sửa A3 · chưa assign', 'bob','edit','A3'],
  ['Bob sửa A4 · assign Alice', 'bob','edit','A4'],
  ['Owner sửa A2 · Closed', 'alice','edit','A2'],
  ['Bob thử xóa Project Alpha', 'bob','delete','alpha'],
  ['Alice quản lý members Alpha', 'alice','list','alpha'],
  ['Giả mạo role=Admin · Bob xóa Alpha', 'bob','delete','alpha',true],
  ['Admin Alpha đọc A1 · cùng tenant', 'admin-alpha','read','A1'],
  ['Admin Alpha đọc B1 · khác tenant', 'admin-alpha','read','B1'],
];
function setUser(id) { $('user').value = id; $('token').value = id ? `demo-${id}` : ''; }
function requestSpec() {
  const action = $('action').value;
  const id = encodeURIComponent($('resource').value.trim());
  const member = encodeURIComponent($('member').value.trim());
  const specs = {
    read: ['GET',`tasks/${id}`], edit: ['PATCH',`tasks/${id}`], delete: ['DELETE',`projects/${id}`],
    list: ['GET',`projects/${id}/members`], add: ['POST',`projects/${id}/members`],
    role: ['PATCH',`projects/${id}/members/${member}`], remove: ['DELETE',`projects/${id}/members/${member}`],
  };
  return specs[action];
}
function updateForm(resetPayload = false) {
  const action = $('action').value;
  $('resource-label').textContent = ['read','edit'].includes(action) ? 'Task ID' : 'Project ID';
  $('member-field').hidden = !['role','remove'].includes(action);
  $('payload-field').hidden = !['edit','add','role'].includes(action);
  if (resetPayload) $('payload').value = JSON.stringify(action === 'add' ? {userId:'admin-alpha',role:'Viewer'} : action === 'role' ? {role:'Member'} : {title:'Updated from lab'}, null, 2);
  const [method, path] = requestSpec();
  $('url').textContent = `${method} /api/${version}/${path}${$('query').value ? `?${$('query').value}` : ''}`;
  $('compare').disabled = busy || action !== 'read';
}
function setVersion(value) {
  version = value;
  for (const button of $('versions').children) { button.classList.toggle('active', button.dataset.version === value); button.setAttribute('aria-pressed', String(button.dataset.version === value)); }
  $('policy-label').textContent = policies[value][0]; $('policy-text').textContent = policies[value][1]; updateForm();
}
function addTrace(checks, label) {
  if (label) { const title = document.createElement('p'); title.className = 'response-title'; title.textContent = label; $('trace').append(title); }
  for (const check of checks) {
    const row = document.createElement('div'); row.className = 'trace-row';
    const result = document.createElement('span'); result.className = `trace-result ${check.result}`; result.textContent = check.result;
    const detail = document.createElement('span'); detail.className = 'trace-detail'; detail.textContent = check.name;
    const reason = document.createElement('small'); reason.textContent = check.reason; detail.append(reason); row.append(result, detail); $('trace').append(row);
  }
}
async function runRequest(target) {
  const [method, path] = requestSpec();
  const extra = JSON.parse($('headers').value || '{}');
  if (!extra || Array.isArray(extra) || typeof extra !== 'object' || Object.values(extra).some(v => typeof v !== 'string')) throw new Error('Headers phải là JSON object có giá trị chuỗi.');
  const headers = new Headers(extra); headers.delete('authorization');
  if ($('token').value.trim()) headers.set('Authorization', `Bearer ${$('token').value.trim()}`);
  const options = { method, headers };
  if (['POST','PATCH'].includes(method)) {
    JSON.parse($('payload').value); headers.set('Content-Type','application/json'); options.body = $('payload').value;
  }
  const url = `/api/${target}/${path}${$('query').value ? `?${$('query').value}` : ''}`;
  const start = performance.now(); const response = await fetch(url, options); const json = await response.json();
  return { version: target, status: response.status, ms: Math.round(performance.now() - start), json, url };
}
async function submit(compare = false) {
  busy = true; $('send').disabled = true;
  for (const control of document.querySelectorAll('select,input,textarea,nav button,#reset')) control.disabled = true;
  updateForm(); $('responses').replaceChildren(); $('trace').replaceChildren();
  $('message').textContent = 'Đang gửi request…';
  try {
    const results = compare ? [await runRequest('starter'), await runRequest('v1')] : [await runRequest(version)];
    $('status').textContent = results.map(r => r.status).join(' → ');
    $('status').className = `tag ${results.at(-1).status < 300 ? 'good' : 'bad'}`;
    $('message').textContent = compare ? 'Cùng danh tính và task ID, hai policy khác nhau.' : `${results[0].url} · ${results[0].ms} ms`;
    for (const r of results) {
      const title = document.createElement('div'); title.className = 'response-title'; title.textContent = `${r.version.toUpperCase()} · HTTP ${r.status} · ${r.ms} ms`;
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify({ data:r.json.data, error:r.json.error, requestId:r.json.requestId }, null, 2);
      $('responses').append(title, pre); addTrace(r.json.trace, compare ? r.version.toUpperCase() : '');
    }
  } catch (error) { $('message').textContent = error.message; $('status').textContent = 'LỖI GỬI REQUEST'; $('status').className = 'tag bad'; }
  finally {
    busy = false; $('send').disabled = false;
    for (const control of document.querySelectorAll('select,input,textarea,nav button,#reset')) control.disabled = false;
    updateForm();
  }
}
async function init() {
  const response = await fetch('/lab/config'); if (!response.ok) throw new Error('Không tải được cấu hình lab.');
  const { data } = await response.json();
  for (const v of data.versions) { const button = document.createElement('button'); button.textContent = v === 'starter' ? 'Starter' : v.toUpperCase(); button.dataset.version = v; button.onclick = () => setVersion(v); $('versions').append(button); }
  $('user').add(new Option('Anonymous', ''));
  for (const u of data.users) $('user').add(new Option(u.id, u.id));
  for (const [i, preset] of presets.entries()) $('preset').add(new Option(preset[0], String(i)));
  setUser('alice'); setVersion('starter');
  $('user').onchange = () => setUser($('user').value);
  $('action').onchange = () => { $('resource').value = ['read','edit'].includes($('action').value) ? 'A1' : 'alpha'; updateForm(true); };
  for (const id of ['resource','member','query']) $(id).oninput = () => updateForm();
  $('preset').onchange = () => {
    if (!$('preset').value) return;
    const [,user,action,id,spoof] = presets[Number($('preset').value)];
    setUser(user); $('action').value = action; $('resource').value = id;
    $('query').value = spoof ? 'role=Admin&tenantId=alpha' : ''; $('headers').value = spoof ? '{"X-Role":"Admin","X-Tenant-Id":"alpha"}' : '{}'; updateForm(true);
  };
  $('send').onclick = () => submit(); $('compare').onclick = () => submit(true);
  $('reset').onclick = async () => {
    $('reset').disabled = true;
    try { const r = await fetch('/lab/reset', {method:'POST'}); if (!r.ok) throw new Error('Reset thất bại.'); $('message').textContent = 'Đã reset SQLite về dữ liệu mẫu. Các response cũ đã được xóa.'; $('responses').replaceChildren(); $('trace').replaceChildren(); $('status').textContent = 'ĐÃ RESET'; $('status').className = 'tag'; }
    catch (error) { $('message').textContent = error.message; }
    finally { $('reset').disabled = false; }
  };
}
init().catch(error => { $('message').textContent = error.message; });
