from pathlib import Path
import re, html, hashlib

root = Path(__file__).resolve().parent.parent
md = (root / 'report.md').read_text(encoding='utf-8')

def box(x,y,w,h,title,lines=(),accent=False):
    fill = '#e6f3ef' if accent else '#f4f7fa'
    s=f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="#b4cbc8"/>'
    s+=f'<text x="{x+w/2}" y="{y+25}" text-anchor="middle" font-weight="700">{html.escape(title)}</text>'
    for i,line in enumerate(lines):
        s+=f'<text x="{x+w/2}" y="{y+47+i*19}" text-anchor="middle" class="sub">{html.escape(line)}</text>'
    return s

def arrow(path,label='',x=0,y=0,dashed=False):
    return f'<path d="{path}" fill="none" stroke="#507572" stroke-width="1.8" marker-end="url(#arrow)" {"stroke-dasharray=\"5 4\"" if dashed else ""}/>'+(f'<text x="{x}" y="{y}" text-anchor="middle" class="edge">{html.escape(label)}</text>' if label else '')

def svg(n, diagram_source=''):
    if n==1:
        height=330
        s=box(15,90,195,86,'Trình duyệt',['Starter → V4','Forms và trace'])
        s+=box(280,90,230,86,'Express / PEP',['Snapshot và Check','Enforce trước read/write'],True)
        s+=box(585,6,200,72,'OpenFGA',['Model và tuples'],True)
        s+=box(585,126,200,72,'SQLite ứng dụng',['Nghiệp vụ và outbox'])
        s+=box(585,246,200,72,'SQLite OpenFGA',['Store · model · tuples'])
        s+=arrow('M210 118 H280','HTTP',245,108)
        s+=arrow('M280 158 H210','JSON',245,188)
        s+=arrow('M510 108 L585 45','Check',537,65)
        s+=arrow('M510 153 H585')
        s+=arrow('M675 126 V78','Sync',705,108,True)
        s+=arrow('M785 42 H795 V282 H785')
        caption='Hình 1. Express đọc SQLite và hỏi OpenFGA; outbox đồng bộ quan hệ. OpenFGA lưu model/tuples trong database SQLite riêng trên volume.'
        title='Kiến trúc tích hợp OpenFGA, Express và hai database SQLite riêng'
    elif n==2:
        height=300
        s=box(15,90,150,72,'user')
        s+=box(620,8,160,72,'tenant')
        s+=box(350,90,200,72,'project',[],True)
        s+=box(350,218,200,72,'task')
        s+=arrow('M90 90 V44 H620','member / admin',350,32)
        s+=arrow('M165 126 H350','owner / member / viewer',260,113)
        s+=arrow('M550 110 L620 65','tenant',591,94)
        s+=arrow('M450 218 V162','project',482,193)
        s+=arrow('M90 162 V254 H350','assignee + condition Open',207,242,True)
        caption='Hình 2. Quan hệ được lưu thành tuple; quyền đọc task được suy ra qua project. Assignee không thay thế membership.'
        title='Quan hệ OpenFGA giữa user, tenant, project và task'
    elif '%% mechanism-openfga' in diagram_source:
        height=350
        s=box(12,5,235,90,'1 · Model đã pin',['can_edit_v3','Owner or assigned_member'],True)
        s+=box(282,5,235,90,'2 · Stored tuples',['Bob member Alpha','A1 → Alpha; assignee Bob'])
        s+=box(552,5,235,90,'3 · Check + context',['Bob · can_edit_v3 · A1','current_status = Open'])
        s+=box(230,140,340,78,'OpenFGA đánh giá model',['Member + assignee + Open → true'],True)
        s+=box(230,270,340,70,'Kết quả: allowed = true',['Backend revalidate rồi mới ghi'],True)
        s+=box(12,270,180,70,'DENY → 403',['Lỗi engine → 503'])
        s+=arrow('M130 95 L300 140')+arrow('M400 95 V140')+arrow('M670 95 L500 140')
        s+=arrow('M400 218 V270','true',430,246)
        s+=arrow('M230 179 H100 V270','false / lỗi',146,239)
        caption=f'Hình {n}. Ví dụ Bob sửa A1 ở V3. Engine kết hợp model, tuple đã lưu và context từ server; backend thực thi kết quả sau khi xác nhận snapshot.'
        title='Cơ chế OpenFGA: model, quan hệ đã lưu và context tạo quyết định Check, backend enforce'
    else:
        height=300
        s=box(10,8,230,67,'1 · Snapshot',['Dữ liệu và revision'])
        s+=box(285,8,225,67,'2 · Await Check',['Transaction đã đóng'],True)
        s+=box(555,8,235,67,'3 · Revalidate',['Transaction ngắn'])
        s+=box(285,112,225,67,'4 · Quyết định',['Revision phải khớp','ALLOW hoặc DENY'],True)
        s+=box(555,222,235,67,'5 · Validation + ghi',['Hợp lệ → UPDATE → COMMIT'])
        s+=box(10,222,230,67,'Dừng và hoàn tác',['403 / 409 → không ghi'])
        s+=arrow('M240 41 H285')+arrow('M510 41 H555')
        s+=arrow('M672 75 V145 H510')
        s+=arrow('M347 179 L230 222','Deny / lỗi',258,191)
        s+=arrow('M450 179 L565 222','Allow',535,191)
        s+=arrow('M555 262 H240','Lỗi validation hoặc ghi',398,252)
        caption=f'Hình {n}. Không giữ transaction khi chờ OpenFGA. Thay đổi revision làm quyết định cũ mất hiệu lực; mutation quan hệ còn có bước sync sau commit.'
        title='Snapshot, OpenFGA Check và kiểm tra lại revision trước khi thực thi'
    s=s.replace('url(#arrow)', f'url(#arrow{n})')
    return f'<figure><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {height}" role="img" aria-labelledby="diagram-{n}"><title id="diagram-{n}">{title}</title><defs><marker id="arrow{n}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="#507572"/></marker></defs>{s}</svg><figcaption>{caption}</figcaption></figure>'

def inline(s):
    s=html.escape(s)
    # Protect code spans before formatting links and emphasis.
    saved=[]
    def code(m):
        saved.append('<code>'+m[1]+'</code>'); return f'\x00{len(saved)-1}\x00'
    s=re.sub(r'`([^`]+)`',code,s)
    s=re.sub(r'\[([^\]]+)\]\(([^)]+)\)',r'<a href="\2">\1</a>',s)
    s=re.sub(r'\*\*([^*]+)\*\*',r'<strong>\1</strong>',s)
    return re.sub(r'\x00(\d+)\x00',lambda m:saved[int(m[1])],s)

lines=md.splitlines(); parts=[]; pages=[]; toc=[]; i=0; diagram=0
intro=[]
while i<len(lines):
    line=lines[i]
    if not line.strip(): i+=1; continue
    if line.startswith('## '):
        if pages: pages[-1]['body']='\n'.join(parts); parts=[]
        title=line[3:]; number=len(pages)+1
        pages.append({'title':title,'id':f'p{number}'})
        toc.append(f'<a href="#p{number}">{inline(title)}</a>')
        parts.append(f'<h2>{inline(title)}</h2>'); i+=1; continue
    if line.startswith('# '):
        intro.append('<h1>'+inline(line[2:])+'</h1>'); i+=1; continue
    if not pages:
        intro.append('<p class="subtitle">'+inline(line)+'</p>'); i+=1; continue
    if line.startswith('### '): parts.append('<h3>'+inline(line[4:])+'</h3>'); i+=1; continue
    if line.startswith('```'):
        language=line[3:]; body=[]; i+=1
        while i<len(lines) and not lines[i].startswith('```'): body.append(lines[i]); i+=1
        if language=='mermaid': diagram+=1; parts.append(svg(diagram, '\n'.join(body)))
        else: parts.append('<pre><code>'+html.escape('\n'.join(body))+'</code></pre>')
        i+=1; continue
    if line.startswith('|'):
        rows=[]
        while i<len(lines) and lines[i].startswith('|'):
            cells=[s.strip() for s in lines[i].strip('|').split('|')]
            if not all(re.fullmatch(r':?-+:?',s) for s in cells): rows.append(cells)
            i+=1
        table='<div class="table-wrap"><table><thead><tr>'+''.join('<th scope="col">'+inline(c)+'</th>' for c in rows[0])+'</tr></thead><tbody>'
        table+=''.join('<tr>'+''.join('<td>'+inline(c)+'</td>' for c in r)+'</tr>' for r in rows[1:])+'</tbody></table></div>'
        parts.append(table); continue
    if line.startswith('- '):
        items=[]
        while i<len(lines) and lines[i].startswith('- '): items.append('<li>'+inline(lines[i][2:])+'</li>'); i+=1
        parts.append('<ul>'+''.join(items)+'</ul>'); continue
    para=[]
    while i<len(lines) and lines[i].strip() and not lines[i].startswith(('#','```','|','- ')):
        para.append(lines[i]); i+=1
    parts.append('<p>'+inline(' '.join(para))+'</p>')
pages[-1]['body']='\n'.join(parts)

css='''
:root{--ink:#203331;--muted:#59716c;--accent:#126d59;--line:#d7e3df;--tint:#eff6f3;color-scheme:light}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}
body{margin:0;background:#e9efed;color:var(--ink);font:15px/1.62 "Segoe UI",Arial,sans-serif}
a{color:var(--accent);text-underline-offset:3px}a:focus-visible,button:focus-visible{outline:3px solid #c68227;outline-offset:3px}
.toolbar{max-width:1120px;margin:26px auto 18px;padding:0 22px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}.toolbar strong{font-size:14px}.toolbar span{color:var(--muted);font-size:13px}
button{margin-left:auto;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:10px 16px;font:inherit;cursor:pointer}
.layout{max-width:1120px;margin:auto;display:grid;grid-template-columns:220px minmax(0,1fr);gap:22px;padding:0 22px 40px}
nav{position:sticky;top:22px;align-self:start;font-size:13px;padding:8px 0}nav p{font-size:11px;letter-spacing:.12em;font-weight:700;color:var(--muted)}nav a{display:block;text-decoration:none;padding:9px 10px;border-left:2px solid #c5d7d0;line-height:1.45}nav a:hover{background:#dae8e2;border-color:var(--accent)}
main{min-width:0}.sheet{background:#fff;padding:36px 40px 22px;margin-bottom:22px;box-shadow:0 4px 20px #173c2c0a;border:1px solid #d6e1db;scroll-margin-top:20px}
.kicker{font-size:10px;font-weight:750;letter-spacing:.12em;color:var(--accent);text-transform:uppercase;margin-bottom:12px}
h1{font-size:32px;line-height:1.18;letter-spacing:-.9px;margin:0 0 10px}h2{font-size:24px;line-height:1.28;letter-spacing:-.45px;margin:0 0 18px;padding-bottom:12px;border-bottom:2px solid var(--accent)}h3{font-size:16px;line-height:1.4;margin:20px 0 8px;color:var(--accent)}
p{margin:0 0 12px}header{margin-bottom:22px}.subtitle{color:var(--muted);font-size:12px}strong{font-weight:650}code{font: .88em Consolas,monospace;overflow-wrap:anywhere;background:#eff4f1;border-radius:3px;padding:1px 3px}
table{width:100%;border-collapse:collapse;font-size:13px;line-height:1.5;margin:4px 0 16px}th{text-align:left;background:var(--tint);font-weight:650}td,th{border:1px solid var(--line);padding:8px 10px;vertical-align:top}td:first-child{width:30%}table code{font-size:.9em}.table-wrap{max-width:100%}
ul{margin:8px 0 15px;padding-left:21px}li{margin:5px 0}figure{margin:18px 0}svg{display:block;width:100%;height:auto;font:15px "Segoe UI",Arial,sans-serif}svg .sub{font-size:13px;fill:#47635c}svg .edge{font-size:12px;fill:#45695e}figcaption{font-size:11px;line-height:1.45;color:var(--muted);margin-top:8px}
.page-footer{border-top:1px solid var(--line);margin-top:22px;padding-top:10px;display:flex;justify-content:space-between;font-size:10px;color:var(--muted)}.sheet>p:last-of-type{overflow-wrap:anywhere}
@media(max-width:850px){.layout{display:block;max-width:820px}nav{position:static;display:flex;gap:4px;flex-wrap:wrap;margin-bottom:18px}nav p{width:100%;margin-bottom:4px}nav a{border:1px solid #c5d7d0;border-radius:4px;padding:7px;max-width:100%}.sheet{padding:28px 24px}h1{font-size:28px}}
@media(max-width:520px){body{font-size:14px}.toolbar{padding:0 14px}.toolbar span{width:100%}button{margin-left:0}.layout{padding:0 10px 20px}.sheet{padding:24px 18px}.table-wrap{overflow-x:auto}table{font-size:12px}td,th{padding:7px}h2{font-size:21px}svg{min-width:560px}figure{overflow-x:auto}figcaption{min-width:0}nav a{font-size:12px}}
@media print{
@page{size:A4;margin:13mm 14mm}html{scroll-behavior:auto}body{background:white;font-size:10pt;line-height:1.48;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.toolbar,nav{display:none}.layout{display:block;max-width:none;margin:0;padding:0}.sheet{border:0;box-shadow:none;padding:0;margin:0;break-after:page;min-height:268mm;position:relative;padding-bottom:13mm}.sheet:last-child{break-after:auto}
.kicker{font-size:8pt;margin-bottom:10px}h1{font-size:26pt}header{margin-bottom:16px}.subtitle{font-size:9pt}h2{font-size:19pt;margin-bottom:13px;padding-bottom:9px}h3{font-size:12pt;margin:14px 0 7px}p{margin-bottom:9px}
table{font-size:9pt;line-height:1.42;margin-bottom:12px}td,th{padding:6px 8px}figure{margin:12px 0}svg{min-width:0;font-size:15px}figcaption{font-size:8pt}a{color:inherit;text-decoration:none}h2,h3{break-after:avoid}tr,figure{break-inside:avoid}li{margin:4px 0}.table-wrap,figure{overflow:visible}.page-footer{position:absolute;bottom:0;left:0;right:0;font-size:8pt;margin-top:12px;padding-top:8px}
}
'''
body=''
for n,page in enumerate(pages,1):
    body+=f'<section class="sheet" id="{page["id"]}" aria-label="{html.escape(page["title"])}"><div class="kicker">AdvanceWeb · Block 6 / Báo cáo triển khai</div>'
    if n==1: body+='<header>'+''.join(intro)+'</header>'
    body+=page['body']+f'<footer class="page-footer"><span>OpenFGA Minilab · 02/11/2026</span><span>{n:02d} / {len(pages):02d}</span></footer></section>'
digest=hashlib.sha256(md.encode()).hexdigest()
out=f'''<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Báo cáo triển khai Task Authorization Minilab: kiến trúc, policy Starter–V4, transaction, quyết định kỹ thuật và kiểm chứng local."><title>Báo cáo triển khai · Task Authorization Minilab</title><style>{css}</style></head>
<body><!-- Generated from report.md; SHA-256: {digest} -->
<div class="toolbar"><strong>Báo cáo triển khai</strong><span>{len(pages)} phần · Sơ đồ nhúng sẵn · Đọc offline</span><button type="button" onclick="window.print()">In / Lưu PDF</button></div>
<div class="layout"><nav aria-label="Mục lục"><p>NỘI DUNG</p>{''.join(toc)}</nav><main>{body}</main></div></body></html>'''
(root/'report.html').write_text(out,encoding='utf-8')
print(f'Generated report.html: {len(pages)} sections, {diagram} SVG diagrams, source SHA-256 {digest}')
