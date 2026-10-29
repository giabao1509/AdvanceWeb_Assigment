const $ = id => document.getElementById(id);
const versions = ['starter', 'v1', 'v2', 'v3', 'v4'];
const names = { alice:'Alice', bob:'Bob', vera:'Vera', charlie:'Charlie', 'admin-alpha':'Admin Alpha', 'admin-beta':'Admin Beta' };
const policies = {
  starter:'Chỉ xác thực tài khoản. Mọi thao tác chưa kiểm tra quyền trên tài nguyên.',
  v1:'Kiểm tra thành viên trong project. Chưa phân quyền theo vai trò.',
  v2:'Phân quyền project: Viewer đọc, Member đọc/sửa, Owner quản lý thành viên và xóa project.',
  v3:'Thêm điều kiện: Member chỉ sửa task được giao cho mình và đang Mở. Owner vẫn sửa được task đã đóng.',
  v4:'Kiểm tra tenant trước tiên. Tenant admin có quyền Owner trong tenant của mình.'
};
const errors = {
  NOT_PROJECT_MEMBER:'Bạn không phải thành viên của dự án này.', TENANT_MISMATCH:'Bạn không có quyền truy cập tài nguyên thuộc tenant khác.',
  ROLE_DENIED:'Vai trò của bạn không có quyền thực hiện thao tác này.', TASK_CLOSED:'Task đã đóng. Thành viên không thể sửa hoặc tự mở lại task này.',
  NOT_ASSIGNEE:'Bạn chỉ được sửa task được giao cho mình.', UNAUTHENTICATED:'Chưa xác thực hợp lệ. Hãy chọn lại tài khoản hoặc kiểm tra token demo.',
  OWNER_IS_FIXED:'Không thể đổi vai trò hoặc xóa Owner của dự án.', MEMBERSHIP_EXISTS:'Người dùng đã là thành viên của dự án.',
  TARGET_TENANT_MISMATCH:'Không thể thêm người dùng thuộc tenant khác.', USER_NOT_FOUND:'Không tìm thấy người dùng.', MEMBERSHIP_NOT_FOUND:'Không tìm thấy thành viên trong dự án.',
  TASK_NOT_FOUND:'Task không còn tồn tại.', PROJECT_NOT_FOUND:'Dự án không còn tồn tại.', INVALID_TEXT:'Tiêu đề không được trống, tối đa 200 ký tự; mô tả tối đa 2000 ký tự.',
  INVALID_FIELDS:'Dữ liệu chứa trường không hợp lệ hoặc còn thiếu.', INVALID_MEMBER:'User ID hoặc vai trò thành viên không hợp lệ.', INVALID_ROLE:'Chỉ chấp nhận vai trò Viewer hoặc Member.',
  INVALID_STATUS:'Trạng thái phải là Open hoặc Closed.', INVALID_ID:'ID không hợp lệ.', INVALID_JSON:'JSON không hợp lệ.'
};
let user = '', version = 'starter', projectId = null, tab = 'tasks', generation = 0, history = [];
class Stale extends Error {}
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const message = r => errors[r.json.error?.code] || `Không thực hiện được thao tác (HTTP ${r.status}).`;
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; $('notice').hidden = !text; }
function writeSuccess(text) {
  notice(text);
  $('success-description').textContent=text;
  if(!$('success-popup').open) $('success-popup').showModal();
}
function safe(fn) { return async event => { try { await fn(event); } catch (error) { if (!(error instanceof Stale)) { const text=error.message || 'Không kết nối được server. Hãy thử lại.'; const feedback=$('modal').open && $('modal-content').querySelector('[role="status"]'); if(feedback) feedback.textContent=text; else notice(text,true); } } }; }
function button(text, action, cls = 'secondary small') { const b = el('button', text, cls); b.type = 'button'; b.onclick = safe(action); return b; }
function stateStart() { generation++; $('success-popup').close(); $('success-description').textContent=''; $('permission-popup').close(); $('permission-title').textContent=''; $('permission-description').textContent=''; $('permission-help').textContent=''; $('modal').close(); $('modal-content').replaceChildren(); $('modal-title').textContent=''; notice(''); $('page').replaceChildren(el('p','Đang tải dữ liệu…','muted')); }
function permissionPopup(result) {
  const explanations = {
    NOT_PROJECT_MEMBER:['Bạn chưa tham gia dự án này','Bạn cần là thành viên của dự án để xem nội dung hoặc thực hiện thao tác này.','Hãy liên hệ người quản lý dự án để được thêm vào nhóm.'],
    ROLE_DENIED:['Bạn chưa có quyền thực hiện thao tác này','Vai trò hiện tại của bạn không cho phép thực hiện thao tác vừa chọn.','Hãy nhờ người quản lý dự án thực hiện hoặc cấp vai trò phù hợp cho bạn.'],
    TENANT_MISMATCH:['Dự án thuộc tổ chức khác','Tài khoản của bạn không được phép truy cập dữ liệu của tổ chức này.','Hãy chọn dự án thuộc tổ chức của bạn hoặc sử dụng tài khoản phù hợp.'],
    NOT_ASSIGNEE:['Công việc này chưa được giao cho bạn','Bạn chỉ có thể chỉnh sửa công việc được giao cho mình.','Hãy liên hệ người quản lý dự án nếu bạn cần cập nhật công việc này.'],
    TASK_CLOSED:['Công việc đã đóng','Bạn không thể chỉnh sửa hoặc tự mở lại công việc đã đóng.','Hãy nhờ người quản lý dự án mở lại công việc trước khi tiếp tục.'],
    TARGET_TENANT_MISMATCH:['Không thể thêm thành viên này','Người dùng bạn chọn thuộc một tổ chức khác với dự án.','Hãy chọn người dùng thuộc cùng tổ chức với dự án.']
  };
  Object.assign(explanations, {
    OWNER_IS_FIXED:['Không thể thay đổi chủ dự án','Bạn không thể đổi vai trò hoặc xóa chủ dự án khỏi nhóm.','Hãy chọn một thành viên khác để tiếp tục.'],
    MEMBERSHIP_EXISTS:['Thành viên đã có trong dự án','Người dùng này đã là thành viên của dự án.','Bạn có thể đổi vai trò của họ hoặc chọn người dùng khác để thêm.'],
    MEMBERSHIP_NOT_FOUND:['Không tìm thấy thành viên','Thành viên này không còn trong dự án hoặc User ID chưa đúng.','Hãy kiểm tra User ID hoặc tải lại danh sách thành viên.'],
    USER_NOT_FOUND:['Không tìm thấy người dùng','User ID bạn nhập không khớp với người dùng nào.','Hãy kiểm tra lại User ID rồi thử thêm thành viên.'],
    UNAUTHENTICATED:['Bạn cần đăng nhập lại','Tài khoản chưa được xác thực để thực hiện thao tác này.','Hãy chọn lại tài khoản hoặc kiểm tra token demo.']
  });
  const fallback=result.status===403 ? ['Chưa thể thực hiện thao tác','Tài khoản của bạn chưa được phép thực hiện thao tác này.','Hãy liên hệ người quản lý dự án để được hỗ trợ.'] : ['Chưa thể hoàn tất thao tác',errors[result.json.error?.code] || 'Thao tác chưa được thực hiện.','Hãy kiểm tra lại thông tin và thử lại.'];
  const [title,description,help]=explanations[result.json.error?.code] || fallback;
  $('permission-title').textContent=title;
  $('permission-description').textContent=description;
  $('permission-help').textContent=help + (result.method==='GET' ? '' : ' Thao tác chưa được thực hiện; dữ liệu đã lưu vẫn giữ nguyên.');
  if(!$('permission-popup').open) $('permission-popup').showModal();
}
function contextClear() {
  stateStart(); history = []; $('history').replaceChildren(); $('technical-content').replaceChildren(el('p','Thực hiện một thao tác để xem kết quả server.','muted')); $('technical').open = false;
  $('raw-token').value = user ? `demo-${user}` : ''; $('raw-query').value = ''; $('raw-headers').value = '{}'; $('raw-body').value = '{"title":"Updated from lab"}'; $('preset').value = ''; $('demo-tools').open=false;
}
function chrome() {
  $('account-name').textContent = names[user] || user;
  $('policy-text').textContent = policies[version];
  for (const b of $('versions').children) { b.classList.toggle('active', b.dataset.version === version); b.setAttribute('aria-pressed', String(b.dataset.version === version)); }
}
function record(result, background=false) {
  const previous=Number($('history').value || 0), preserve=background && history.length>0;
  history.unshift(result); history = history.slice(0, 30);
  $('history').replaceChildren(...history.map((r,i) => new Option(`${r.label} · ${r.method} · ${r.status} · ${r.version.toUpperCase()}`, String(i))));
  const selected=preserve ? Math.min(previous+1,history.length-1) : 0;
  $('history').value=String(selected); showTechnical(selected);
}
function showTechnical(index) {
  const r = history[index]; if (!r) return;
  const heading = el('p',`${r.method} ${r.url} · HTTP ${r.status} · ${r.ms} ms`,'response-title');
  const pre = el('pre',JSON.stringify(r.json,null,2));
  const trace = el('div'); trace.append(el('h3','Trace xử lý request'));
  trace.append(el('p','Authorization decision chỉ là kết quả kiểm tra quyền. Request outcome là kết quả cuối cùng sau kiểm tra dữ liệu và quy tắc nghiệp vụ.','muted'));
  for (const check of r.json.trace || []) { const row = el('div',undefined,`trace-item ${['FAIL','DENY','REJECTED','ERROR'].includes(check.result) ? 'fail' : ''}`); const detail = el('span',check.name); detail.append(el('small',check.reason)); row.append(el('span',check.result), detail); trace.append(row); }
  $('technical-content').replaceChildren(heading, pre, trace);
}
async function api(method, path, body, options = {}) {
  const stamp = generation, target = options.version || version;
  const headers = new Headers(options.headers || {}); headers.delete('authorization');
  const token = options.token !== undefined ? options.token : `demo-${user}`;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const args = {method, headers}; if (body !== undefined) { headers.set('Content-Type','application/json'); args.body = JSON.stringify(body); }
  const url = `/api/${target}/${path}`, start = performance.now();
  let response, json;
  try { response = await fetch(url, args); json = await response.json(); } catch (error) { if (stamp !== generation) throw new Stale(); throw error; }
  if (stamp !== generation) throw new Stale();
  const result = {method,url,status:response.status,json,ms:Math.round(performance.now()-start),version:target,label:options.label || path};
  record(result,options.background);
  result.errorShown = result.status===403 || (method!=='GET' && result.status>=400 && !(result.status===400 && options.form));
  if(result.errorShown) { notice(''); permissionPopup(result); }
  return result;
}
function denied(result, title = 'Không thể mở nội dung') {
  const box = el('div',undefined,'empty error'); box.append(el('h2',title)); if(!result.errorShown) box.append(el('p',message(result))); box.append(button('Về danh sách dự án',()=>navigate())); return box;
}
function pageHeading(kicker,title,description) { const box=el('div',undefined,'page-heading'), text=el('div'); text.append(el('span',kicker,'eyebrow'),el('h1',title)); if(description) text.append(el('p',description,'muted')); box.append(text); return box; }
async function navigate(id = null, nextTab = 'tasks', preserveTechnical=false) {
  projectId = id; tab = nextTab; stateStart();
  if (!id) return loadProjects(preserveTechnical);
  return loadProject(preserveTechnical);
}
async function loadProjects(background=false) {
  const result = await api('GET','projects',undefined,{label:'Danh sách dự án',background});
  if (result.status !== 200) { $('page').replaceChildren(denied(result)); return; }
  const heading = pageHeading('DỰ ÁN / TẤT CẢ','Không gian dự án','Chọn dự án để xem công việc và cộng tác cùng nhóm.');
  const grid = el('div',undefined,'project-grid');
  for(const p of result.json.data) {
    const card = el('article',undefined,'project-card'); card.dataset.project = p.id;
    card.append(el('div',p.name.replace('Project ','').slice(0,1),'project-icon'),el('h2',p.name),el('p',`Mã dự án: ${p.id}`,'muted'));
    const actions = el('div',undefined,'actions'); actions.append(el('span','PROJECT','badge'),button('Mở project →',()=>navigate(p.id),'open-project')); card.append(actions); grid.append(card);
  }
  if (!result.json.data.length) grid.append(el('p','Chưa có dự án. Khôi phục dữ liệu mẫu để tiếp tục.','empty'));
  $('page').replaceChildren(heading,el('p','Danh mục demo hiển thị mọi dự án. Quyền đọc nội dung được kiểm tra khi bạn mở dự án.','muted'),grid);
}
async function loadProject(background=false) {
  const id = projectId, result = await api('GET',`projects/${encodeURIComponent(id)}`,undefined,{label:'Mở dự án',background});
  if(result.status !== 200) { $('page').replaceChildren(denied(result,'Không thể mở dự án')); return; }
  const heading = pageHeading(`DỰ ÁN / ${id.toUpperCase()}`,result.json.data.name,`Tenant: ${result.json.data.tenantId}`);
  heading.append(button('Xóa project',()=>confirmDelete(id),'danger small'));
  const tabs = el('div',undefined,'tabs');
  tabs.append(button('Công việc',()=>navigate(id,'tasks'),tab==='tasks'?'active':'secondary'),button('Thành viên',()=>navigate(id,'members'),tab==='members'?'active':'secondary'));
  const content = el('div'); content.id = 'project-content';
  $('page').replaceChildren(button('← Tất cả dự án',()=>navigate()),heading,tabs,content);
  if(tab === 'tasks') await loadTasks(id, content); else await loadMembers(id, content,background);
}
async function loadTasks(id, content) {
  const r = await api('GET',`projects/${encodeURIComponent(id)}/tasks`,undefined,{label:'Danh sách công việc',background:true});
  if(r.status !== 200) { content.replaceChildren(denied(r)); return; }
  content.replaceChildren(el('p',`${r.json.data.length} công việc · Chọn Xem để đọc đầy đủ hoặc Sửa để cập nhật.`,'muted'));
  if(!r.json.data.length) { content.append(el('p','Dự án chưa có công việc.','empty')); return; }
  const {wrap,body} = table(['Công việc','Người được giao','Trạng thái','Thao tác']);
  for(const task of r.json.data) {
    const row = el('tr'); row.dataset.task = task.id;
    const title = el('td'); title.append(el('small',task.id,'muted'),el('div',task.title,'task-title'));
    const status = el('td'); status.append(el('span',task.status === 'Open' ? 'Đang mở' : 'Đã đóng',`status ${task.status==='Closed'?'closed':''}`));
    const actions = el('td'), group = el('div',undefined,'actions'); group.append(button('Xem',()=>openTask(task.id,false)),button('Sửa',()=>openTask(task.id,true))); actions.append(group);
    row.append(title,el('td',task.assigneeId ? names[task.assigneeId] || task.assigneeId : 'Chưa giao'),status,actions);
    [...row.children].forEach((cell,i)=>{cell.dataset.label=['Công việc','Người được giao','Trạng thái','Thao tác'][i];}); body.append(row);
  }
  content.append(wrap);
}
function table(headings) { const wrap=el('div',undefined,'table-wrap'), t=el('table'), head=el('thead'), row=el('tr'), body=el('tbody'); for(const h of headings) row.append(el('th',h)); head.append(row); t.append(head,body); wrap.append(t); return {wrap,body}; }
function modal(title,content) { $('modal-title').textContent=title; $('modal-content').replaceChildren(content); if(!$('modal').open) $('modal').showModal(); }
function field(form,label,id,value,tag='input') { const l=el('label',label); l.htmlFor=id; const input=el(tag); input.id=id; input.name=id; input.value=value; form.append(l,input); return input; }
function formFeedback(form) { const p=el('p','','error-text'); p.setAttribute('role','status'); form.append(p); return p; }
function clearFormErrors(form) {
  for(const error of form.querySelectorAll('.field-error')) error.remove();
  for(const control of form.querySelectorAll('[aria-invalid]')) { control.removeAttribute('aria-invalid'); control.removeAttribute('aria-describedby'); }
  const feedback=form.querySelector('[role="status"]'); if(feedback) feedback.textContent='';
}
function formError(result,feedback) {
  if(result.errorShown) { feedback.textContent=''; return; }
  const form=feedback.closest('form');
  const code=result.json.error?.code;
  const selector={INVALID_TEXT:'#task-title',INVALID_STATUS:'#task-status',INVALID_ROLE:'#role-value, #member-role',INVALID_MEMBER:'#member-user',INVALID_ID:'#member-user, #raw-path',INVALID_FIELDS:'#raw-body',INVALID_JSON:'#raw-body'}[code];
  let control=selector && form?.querySelector(selector);
  if(code==='INVALID_TEXT' && form?.querySelector('#task-title')?.value.trim() && form.querySelector('#task-title').value.length<=200 && form.querySelector('#task-description')?.value.length>2000) control=form.querySelector('#task-description');
  if(!control) { feedback.textContent=message(result); return; }
  const error=el('small',message(result),'error-text field-error'); error.id=`${control.id}-error`; error.setAttribute('role','alert');
  control.after(error); control.setAttribute('aria-invalid','true'); control.setAttribute('aria-describedby',error.id); control.focus();
  const clear=()=>{error.remove();control.removeAttribute('aria-invalid');control.removeAttribute('aria-describedby');control.removeEventListener('input',clear);control.removeEventListener('change',clear);};
  control.addEventListener('input',clear);control.addEventListener('change',clear);
}
async function openTask(id, edit) {
  const r = await api('GET',`tasks/${encodeURIComponent(id)}`,undefined,{label:edit?'Mở form sửa task':'Xem task'});
  if(r.status !== 200) { if(!r.errorShown) notice(message(r),true); return; }
  const task=r.json.data, box=el('div'); box.append(el('p',`${id} · ${names[task.assigneeId] || task.assigneeId || 'Chưa giao'} · ${task.status==='Open'?'Đang mở':'Đã đóng'}`,'meta'));
  if(!edit) { box.append(el('h3',task.title),el('p',task.description || 'Chưa có mô tả.','description'),button('Sửa công việc',()=>openTask(id,true))); modal('Chi tiết công việc',box); return; }
  const form=el('form'); form.id='task-form';
  const title=field(form,'Tiêu đề','task-title',task.title); title.required=true; title.maxLength=200;
  const description=field(form,'Mô tả','task-description',task.description,'textarea'); description.rows=5; description.maxLength=2000;
  const status=field(form,'Trạng thái','task-status','','select'); status.add(new Option('Đang mở','Open')); status.add(new Option('Đã đóng','Closed')); status.value=task.status;
  const feedback=formFeedback(form), actions=el('div',undefined,'actions'), save=el('button','Lưu thay đổi'); save.type='submit'; actions.append(save,button('Hủy',()=>$('modal').close())); form.append(actions); box.append(form);
  form.onsubmit=safe(async e=>{
    e.preventDefault(); save.disabled=true; clearFormErrors(form);
    try {
      const result=await api('PATCH',`tasks/${encodeURIComponent(id)}`,{title:title.value,description:description.value,status:status.value},{label:'Lưu task',form});
      if(result.status!==200) { formError(result,feedback); return; }
      $('modal').close(); await navigate(projectId,'tasks',true); writeSuccess('Đã lưu thay đổi công việc.');
    } finally { save.disabled=false; }
  });
  modal('Sửa công việc',box);
}
async function loadMembers(id,content,background=false) {
  const r=await api('GET',`projects/${encodeURIComponent(id)}/members`,undefined,{label:'Xem thành viên',background});
  const layout=el('div',undefined,'member-layout'), list=el('section'), tools=el('section',undefined,'surface');
  if(r.status!==200) { const deniedBox=el('div',undefined,'empty error'); deniedBox.append(el('h3','Không thể xem danh sách thành viên')); if(!r.errorShown) deniedBox.append(el('p',message(r))); deniedBox.append(el('p','Bạn vẫn có thể thử thao tác theo User ID ở form bên cạnh.','muted')); list.append(deniedBox); }
  else {
    const {wrap,body}=table(['Thành viên','Vai trò','Thao tác']);
    for(const member of r.json.data) {
      const row=el('tr'), actions=el('td'), group=el('div',undefined,'actions'); row.dataset.member=member.userId;
      group.append(button('Đổi role',()=>editMemberRole(id,member)),button('Xóa',()=>confirmMember(id,member.userId),'danger small'));
      actions.append(group); row.append(el('td',`${names[member.userId]||member.userId} (${member.userId})`),el('td',member.role),actions);
      [...row.children].forEach((cell,i)=>{cell.dataset.label=['Thành viên','Vai trò','Thao tác'][i];}); body.append(row);
    }
    list.append(wrap);
  }
  tools.append(el('h3','Quản lý thành viên'),el('p','Thử thao tác bằng tài khoản hiện tại. Owner của dự án được giữ cố định.','muted'));
  const form=el('form'); form.id='member-form'; const operation=field(form,'Thao tác','member-operation','','select'); operation.add(new Option('Thêm thành viên','add')); operation.add(new Option('Đổi vai trò','role')); operation.add(new Option('Xóa thành viên','remove'));
  const member=field(form,'User ID','member-user','admin-alpha'); member.required=true; member.pattern='[a-zA-Z0-9-]{1,64}';
  const role=field(form,'Vai trò','member-role','','select'); role.add(new Option('Viewer','Viewer')); role.add(new Option('Member','Member'));
  const feedback=formFeedback(form), submit=el('button','Thực hiện'); submit.type='submit'; submit.className='form-footer'; form.append(submit);
  operation.onchange=()=>{role.disabled=operation.value==='remove';};
  form.onsubmit=safe(async e=>{
    e.preventDefault(); clearFormErrors(form); if(operation.value==='remove') { await confirmMember(id,member.value); return; }
    submit.disabled=true;
    try {
      const add=operation.value==='add', path=`projects/${encodeURIComponent(id)}/members${add?'':`/${encodeURIComponent(member.value)}`}`;
      const result=await api(add?'POST':'PATCH',path,add?{userId:member.value,role:role.value}:{role:role.value},{label:add?'Thêm thành viên':'Đổi vai trò',form});
      if(result.status>=300) {formError(result,feedback); return;}
      await navigate(id,'members',true); writeSuccess(add?'Đã thêm thành viên vào dự án.':'Đã cập nhật vai trò thành viên.');
    } finally {submit.disabled=false;}
  });
  tools.append(form); layout.append(list,tools); content.replaceChildren(layout);
}
function editMemberRole(id,member) {
  const form=el('form'); form.id='role-form';
  form.append(el('p',`Thành viên: ${names[member.userId] || member.userId} (${member.userId})`));
  const role=field(form,'Vai trò mới','role-value','','select');
  role.add(new Option('Viewer · Chỉ đọc','Viewer')); role.add(new Option('Member · Thành viên','Member'));
  role.value=member.role==='Viewer'?'Viewer':'Member';
  const feedback=formFeedback(form), actions=el('div',undefined,'actions'), save=el('button','Lưu vai trò'); save.type='submit';
  actions.append(button('Hủy',()=>$('modal').close()),save); form.append(actions);
  form.onsubmit=safe(async event=>{
    event.preventDefault(); save.disabled=true; clearFormErrors(form);
    try {
      const r=await api('PATCH',`projects/${encodeURIComponent(id)}/members/${encodeURIComponent(member.userId)}`,{role:role.value},{label:'Đổi vai trò thành viên',form});
      if(r.status>=300){formError(r,feedback);return;}
      $('modal').close(); await navigate(id,'members',true); writeSuccess(`Đã cập nhật vai trò của ${names[member.userId] || member.userId} thành ${role.value}.`);
    } finally {save.disabled=false;}
  });
  modal('Đổi vai trò thành viên',form);
}
function confirmation(title,text,action) {
  const box=el('div'), feedback=formFeedback(box), confirm=button('Xác nhận',async()=>{
    confirm.disabled=true; feedback.textContent='';
    try { await action(feedback); } finally {confirm.disabled=false;}
  },'danger');
  const actions=el('div',undefined,'actions'); actions.append(button('Hủy',()=>$('modal').close()),confirm); box.prepend(el('p',text)); box.append(actions); modal(title,box);
}
function confirmDelete(id) { confirmation('Xóa dự án?',`Dự án ${id}, toàn bộ task và membership liên quan sẽ bị xóa.`,async feedback=>{
  const r=await api('DELETE',`projects/${encodeURIComponent(id)}`,undefined,{label:'Xóa dự án'});
  if(r.status!==200){formError(r,feedback);return;}
  $('modal').close(); await navigate(null,'tasks',true); writeSuccess('Đã xóa dự án cùng các công việc và thành viên liên quan.');
}); }
function confirmMember(id,member) { confirmation('Xóa thành viên?',`Thu hồi membership của ${member} trong dự án ${id}.`,async feedback=>{
  const r=await api('DELETE',`projects/${encodeURIComponent(id)}/members/${encodeURIComponent(member)}`,undefined,{label:'Xóa thành viên'});
  if(r.status!==200){formError(r,feedback);return;}
  $('modal').close(); await navigate(id,'members',true); writeSuccess('Đã xóa thành viên khỏi dự án.');
}); }
async function enter(id, keepProject=null, nextVersion=version) {
  user=id; version=nextVersion; projectId=keepProject; tab='tasks'; contextClear(); chrome();
  $('login').hidden=true; $('workspace').hidden=false;
  await navigate(keepProject);
}
function rawOptions() {
  const method=$('raw-method').value, path=$('raw-path').value.trim();
  if(!/^(tasks|projects)(?:\/[a-zA-Z0-9-]+)*$/.test(path)) throw new Error('Nhập đường dẫn tasks/ID hoặc projects/ID[/members/USER], không gồm query.');
  const headers=JSON.parse($('raw-headers').value || '{}');
  if(!headers || Array.isArray(headers) || typeof headers!=='object' || Object.values(headers).some(v=>typeof v!=='string')) throw new Error('Headers phải là JSON object có giá trị chuỗi.');
  return {method,path:path+($('raw-query').value?`?${$('raw-query').value}`:''),body:['PATCH','POST'].includes(method)?JSON.parse($('raw-body').value):undefined,options:{token:$('raw-token').value.trim(),headers,label:'Request tùy chỉnh'}};
}
async function runRaw(compare=false) {
  const spec=rawOptions(); if(compare && spec.method!=='GET') throw new Error('Chỉ so sánh GET để tránh mutation lặp lại.');
  const stamp=generation, results=[];
  for(const v of compare?['starter','v1']:[version]) results.push(await api(spec.method,spec.path,spec.body,{...spec.options,version:v}));
  if(stamp!==generation) throw new Stale();
  if(compare || !results.some(r=>r.errorShown)) notice(compare?`Cùng GET: Starter ${results[0].status} → V1 ${results[1].status}`:results[0].status<300?'Request thành công. Mở Chi tiết kỹ thuật để xem kết quả.':message(results[0]),results.some(r=>r.status>=300));
  $('technical').open=true;
  // Arbitrary mutations can invalidate every cached resource; clear before reloading.
  if(spec.method!=='GET' && results[0].status<300) {await navigate(projectId,tab,true); writeSuccess('Đã thực hiện thao tác ghi dữ liệu. Bạn có thể xem kết quả trong Chi tiết kỹ thuật.');}
}
for(const v of versions) { const b=button(v==='starter'?'Starter':v.toUpperCase(),()=>enter(user,projectId,v),''); b.dataset.version=v; $('versions').append(b); }
$('login-form').onsubmit=safe(async e=>{e.preventDefault(); await enter($('login-user').value);});
$('switch-user').onclick=()=>{user=''; projectId=null; contextClear(); $('workspace').hidden=true; $('login').hidden=false; $('login-user').focus();};
$('home').onclick=safe(()=>navigate()); $('brand').onclick=safe(e=>{e.preventDefault();return navigate();});
$('close-modal').onclick=()=>$('modal').close();
$('permission-dismiss').onclick=()=>$('permission-popup').close();
$('success-dismiss').onclick=()=>$('success-popup').close();
$('history').onchange=()=>showTechnical(Number($('history').value));
$('raw-form').onsubmit=safe(async e=>{e.preventDefault();const b=e.submitter || $('raw-form').querySelector('button');b.disabled=true;try{await runRaw();}finally{b.disabled=false;}});
$('compare').onclick=safe(async()=>{ $('compare').disabled=true;try{await runRaw(true);}finally{$('compare').disabled=false;} });
$('preset').onchange=safe(async()=>{
  const presets={idor:['alice','beta'],viewer:['vera','alpha','A1'],closed:['bob','alpha','A2'],assigned:['bob','alpha','A1'],admin:['admin-alpha','alpha'],cross:['admin-alpha','beta']};
  const p=presets[$('preset').value]; if(!p)return; await enter(p[0],p[1]); if(p[2])await openTask(p[2],true);
});
$('reset').onclick=()=>confirmation('Khôi phục dữ liệu mẫu?','Mọi thay đổi trong SQLite sẽ được thay bằng dữ liệu seed. Tất cả phiên bản dùng chung dữ liệu.',async feedback=>{
  const stamp=generation; let r;
  try{r=await fetch('/lab/reset',{method:'POST'});}catch(error){if(stamp!==generation)throw new Stale();throw error;}
  if(stamp!==generation)throw new Stale();
  if(!r.ok){feedback.textContent='Không thể khôi phục dữ liệu.';return;}
  contextClear(); await navigate(); writeSuccess('Đã khôi phục dữ liệu mẫu.');
});
