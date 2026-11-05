"""Render this report's Markdown subset locally; diagrams are embedded SVG, no CDN."""
from pathlib import Path
import hashlib
import html
import re

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "report.md"
OUTPUT = ROOT / "report.html"

CSS = """
:root{color-scheme:light;--ink:#263b40;--muted:#687b7d;--line:#dce7e4;--green:#22685f;--paper:#f4f7f5;--amber:#94631d}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:26px}body{margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.8}a{color:var(--green);text-underline-offset:3px}a:focus-visible{outline:3px solid #8cc7b7;outline-offset:4px}.topbar{padding:18px max(28px,calc((100vw - 1240px)/2));border-bottom:1px solid var(--line);background:#fff;display:flex;justify-content:space-between;gap:18px;align-items:center;font-size:11px;color:var(--muted);letter-spacing:.7px}.topbar strong{color:var(--green);letter-spacing:1.5px}.topbar span:last-child{letter-spacing:0}.layout{display:grid;grid-template-columns:205px minmax(0,1fr);gap:36px;max-width:1240px;margin:40px auto 0;padding:0 28px}.toc{position:sticky;top:28px;align-self:start;padding:14px 0;font-size:12px}.toc-title{font-size:10px;letter-spacing:1.7px;color:var(--muted);margin:0 0 18px 12px}.toc a{display:flex;gap:12px;padding:10px 12px;margin:3px 0;color:var(--muted);text-decoration:none;border-radius:6px;line-height:1.6}.toc a:hover{background:#e8f0ec;color:var(--green)}.toc-num{color:#9aaca4;font:11px/1.9 Consolas,monospace}.toc-note{font-size:10px;color:var(--muted);border-top:1px solid var(--line);margin:22px 12px 0;padding-top:16px;line-height:1.7}.document{min-width:0;background:#fff;border:1px solid var(--line);border-radius:14px;padding:46px 48px 24px;box-shadow:0 4px 20px #294d3b03}.hero{padding-bottom:26px;border-bottom:1px solid var(--line)}h1{font-size:40px;line-height:1.2;letter-spacing:-1.5px;color:#21463e;margin:0 0 16px;font-weight:650}.hero .kicker{font-size:11px;font-weight:600;letter-spacing:.8px;color:var(--green);margin:18px 0}.hero>p:last-child{font-size:16px;line-height:1.85;color:#586d6b;margin-bottom:0}section{padding-top:30px;margin-top:15px;border-top:1px solid var(--line)}.hero+section{border-top:0;margin-top:0}h2{font-size:23px;letter-spacing:-.6px;line-height:1.45;margin:0 0 18px;color:#234e46;font-weight:650}h3{font-size:16px;margin:27px 0 12px;line-height:1.5;font-weight:650}p{margin:0 0 16px}strong{font-weight:650;color:#254c43}code{font-family:Consolas,'Courier New',monospace;font-size:.84em;background:#edf4ef;color:#295b50;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}pre{background:#f3f6f4;border:1px solid var(--line);border-radius:9px;padding:18px 20px;margin:18px 0 22px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:avoid}pre code{padding:0;background:none;border-radius:0;color:#375d52;font-size:11px;line-height:1.7}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:9px;margin:20px 0 24px}table{border-collapse:collapse;width:100%;font-size:12px;line-height:1.65;table-layout:auto}thead{background:#edf4ef;color:#395e51}th,td{text-align:left;vertical-align:top;padding:12px 13px;border-bottom:1px solid #e5ece7;overflow-wrap:anywhere}th{font-size:11px;font-weight:650}tbody tr:last-child td{border-bottom:0}tbody tr:nth-child(even){background:#fbfcfa}td:first-child{font-weight:550}td code{font-size:10px;padding:2px 3px}figure{margin:23px 0 26px;border:1px solid var(--line);border-radius:11px;background:#fafcf9;overflow:hidden}.diagram-scroll{overflow-x:auto;padding:16px 12px}.diagram-scroll svg{display:block;width:100%;height:auto;min-width:660px}.diagram-scroll text{font-family:system-ui,'Segoe UI',Arial,sans-serif;fill:#37574d;font-size:13px}.diagram-scroll .title{font-size:17px;font-weight:650;fill:#234e46}.diagram-scroll .small{font-size:12px;fill:#6c8075}.diagram-scroll .state{font-family:Consolas,'Courier New',monospace;font-size:15px;font-weight:600}.diagram-scroll .edge{font-size:11px;fill:#64776a}.diagram-scroll .wire{fill:none;stroke:#789d8b;stroke-width:1.8}.diagram-scroll .warn-wire{fill:none;stroke:#b19a70;stroke-width:1.8}figcaption{font-size:10px;line-height:1.6;border-top:1px solid var(--line);padding:12px 18px;color:var(--muted);background:#fff}.document-footer{font-size:10px;color:var(--muted);border-top:1px solid var(--line);margin-top:30px;padding:20px 0 0;display:flex;justify-content:space-between;gap:14px}.page-footer{max-width:1240px;padding:26px 28px 35px;margin:auto;text-align:right;font-size:10px;color:var(--muted)}ul,ol{padding-left:22px}li{margin:7px 0}::selection{background:#d8eadf}
@media(max-width:1050px){.layout{grid-template-columns:170px minmax(0,1fr);gap:22px}.document{padding:34px 30px}h1{font-size:34px}.toc{font-size:11px}.diagram-scroll{padding:12px 8px}}
@media(max-width:780px){.topbar{padding:15px 20px;font-size:10px;align-items:flex-start}.layout{display:block;margin:20px auto 0;padding:0 16px}.toc{position:static;padding:0 0 18px}.toc-title,.toc-note{display:none}.toc-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 10px}.toc a{padding:7px 5px;font-size:10px;margin:0}.toc-num{font-size:10px}.document{padding:28px 22px 20px;border-radius:10px}body{font-size:14px;line-height:1.85}h1{font-size:32px;letter-spacing:-1px}h2{font-size:21px}.hero>p:last-child{font-size:14px}.hero .kicker{font-size:10px}section{padding-top:24px}th,td{padding:10px;font-size:11px}th{font-size:10px}.table-wrap{margin:17px 0 22px}td code{font-size:9px}.document-footer{flex-direction:column;gap:4px}.page-footer{padding:22px 18px}pre{padding:14px}pre code{font-size:10px}}
@media(max-width:780px){.log-table{table-layout:fixed}.log-table th:first-child{width:94px}.log-table th:nth-child(2){width:46px}.log-table td:first-child code,.log-table td:nth-child(2) code,.log-table th:nth-child(2){white-space:nowrap;overflow-wrap:normal}}
@page{size:A4;margin:15mm 16mm 17mm}
@media print{html{scroll-behavior:auto}body{background:#fff;font-size:10.3pt;line-height:1.55;color:#233a35}.topbar,.toc,.page-footer{display:none}.layout{display:block;max-width:none;margin:0;padding:0}.document{border:0;border-radius:0;box-shadow:none;padding:0}.hero{padding-bottom:16px}h1{font-size:27pt}h2{font-size:17pt;margin-bottom:11px;break-after:avoid}h3{font-size:11pt;break-after:avoid;margin-top:18px}p{margin-bottom:11px;orphans:3;widows:3}section{padding-top:19px;margin-top:8px}table{font-size:8pt;line-height:1.45}th,td{padding:8px 9px}th{font-size:8pt}thead{display:table-header-group}tr{break-inside:avoid}.table-wrap{overflow:visible;border-radius:5px;margin:12px 0 16px}td code{font-size:7pt}pre code{font-size:8pt}pre{padding:12px 14px;margin:12px 0}figure{break-inside:avoid;margin:16px 0}.diagram-scroll{overflow:visible;padding:10px}.diagram-scroll svg{min-width:0;width:100%}figcaption{font-size:7.5pt;padding:8px 12px}.document-footer{font-size:7.5pt}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}a{color:inherit;text-decoration:none}}
"""

CSS += """
.api-table{table-layout:fixed}.api-table th:first-child{width:78px}.api-table th:nth-child(2){width:210px}.api-table td:nth-child(2) code{white-space:nowrap;overflow-wrap:normal}
@media screen and (max-width:780px){.api-table{min-width:640px}}
@media print{.api-table th:first-child{width:58px}.api-table th:nth-child(2){width:190px}}
"""

ARCH = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 490" role="img" aria-labelledby="arch-title arch-desc">
<title id="arch-title">UI độc lập và ba service sở hữu ba DB dùng chung cho hai cơ chế</title><desc id="arch-desc">UI và launcher ở port 3000 tiếp tục hoạt động khi Order dừng. UI đọc API riêng của ba service. Order ở port 3003 điều phối Inventory và Payment. Mỗi service sở hữu một SQLite dùng chung cho Baseline và Saga.</desc>
<defs><marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#789d8b"/></marker></defs>
<g class="wire" marker-end="url(#arch-arrow)"><path d="M205 197H285"/><path d="M570 155H645V80H725"/><path d="M570 230H645V320H725"/><path d="M427 270V350"/><path d="M847 130V165"/><path d="M847 370V405"/></g>
<g fill="none" stroke="#a5b8b1" stroke-width="1.5" stroke-dasharray="5 5" marker-end="url(#arch-arrow)"><path d="M115 140V10H847V30"/><path d="M115 255V480H990V320H970"/></g><text x="430" y="30" text-anchor="middle" class="edge">UI đọc API kho khi Order dừng</text><text x="430" y="468" text-anchor="middle" class="edge">UI đọc API ledger khi Order dừng</text>
<rect x="25" y="140" width="180" height="115" rx="13" fill="#fff" stroke="#d5e2d9"/><text x="115" y="178" text-anchor="middle" class="title">UI · :3000</text><text x="115" y="205" text-anchor="middle">Đặt hàng + quan sát</text><text x="115" y="228" text-anchor="middle" class="small">Launcher kill / restore</text>
<rect x="285" y="115" width="285" height="155" rx="13" fill="#e8f2eb" stroke="#8eb6a0"/><text x="427" y="155" text-anchor="middle" class="title">Order · :3003</text><text x="427" y="185" text-anchor="middle">Public API + Saga record</text><text x="427" y="211" text-anchor="middle">Baseline / Saga</text><text x="427" y="242" text-anchor="middle" class="small">Lưu intent · history · resume</text>
<rect x="725" y="30" width="245" height="100" rx="13" fill="#fff" stroke="#c8dbcd"/><text x="847" y="69" text-anchor="middle" class="title">Inventory · :3001</text><text x="847" y="101" text-anchor="middle" class="small">Tồn kho + reservation</text>
<rect x="725" y="270" width="245" height="100" rx="13" fill="#fff" stroke="#c8dbcd"/><text x="847" y="309" text-anchor="middle" class="title">Payment · :3002</text><text x="847" y="341" text-anchor="middle" class="small">Charge + refund ledger</text>
<text x="245" y="180" text-anchor="middle" class="edge">HTTP</text><text x="706" y="57" text-anchor="end" class="edge">Reserve / Release / Query</text><text x="706" y="297" text-anchor="end" class="edge">Charge / Refund / Query</text>
<rect x="315" y="350" width="225" height="70" rx="9" fill="#f0f4ee" stroke="#d0ddcc"/><text x="427" y="379" text-anchor="middle">Order SQLite</text><text x="427" y="402" text-anchor="middle" class="small">Dùng chung Baseline / Saga</text>
<rect x="748" y="165" width="200" height="60" rx="9" fill="#f0f4ee" stroke="#d0ddcc"/><text x="848" y="190" text-anchor="middle">Inventory SQLite</text><text x="848" y="213" text-anchor="middle" class="small">Dùng chung Baseline / Saga</text>
<rect x="748" y="405" width="200" height="60" rx="9" fill="#f0f4ee" stroke="#d0ddcc"/><text x="848" y="430" text-anchor="middle">Payment SQLite</text><text x="848" y="453" text-anchor="middle" class="small">Dùng chung Baseline / Saga</text>
</svg>"""

STATES = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 455" role="img" aria-labelledby="state-title state-desc">
<title id="state-title">Trạng thái Saga khi thành công, chưa rõ kết quả hoặc cần bù</title><desc id="state-desc">Processing đi tới Confirmed khi thành công, Recovering khi chưa rõ kết quả, Compensating khi cần bù, hoặc Cancelled khi reserve bị từ chối. Recovering đối soát để tiếp tục hoặc bù. Compensating chỉ chuyển Cancelled khi bù xong.</desc>
<defs><marker id="state-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#789d8b"/></marker><marker id="warn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#b19a70"/></marker></defs>
<g class="wire" marker-end="url(#state-arrow)"><path d="M270 174H315V72H690"/><path d="M270 193H380"/><path d="M600 190H640V127H160V160"/><path d="M600 342H690"/><path d="M160 225V412H800V375"/></g>
<g class="warn-wire" marker-end="url(#warn-arrow)"><path d="M270 211C321 211 307 342 380 342"/><path d="M490 225V310"/></g>
<rect x="50" y="160" width="220" height="65" rx="11" fill="#e8f2eb" stroke="#8eb6a0"/><text x="160" y="198" text-anchor="middle" class="state">PROCESSING</text>
<rect x="690" y="40" width="220" height="65" rx="11" fill="#dfeee2" stroke="#9abc9d"/><text x="800" y="79" text-anchor="middle" class="state">CONFIRMED</text>
<rect x="380" y="160" width="220" height="65" rx="11" fill="#fff4df" stroke="#dbc6a3"/><text x="490" y="199" text-anchor="middle" class="state">RECOVERING</text>
<rect x="380" y="310" width="220" height="65" rx="11" fill="#fff4df" stroke="#dbc6a3"/><text x="490" y="349" text-anchor="middle" class="state">COMPENSATING</text>
<rect x="690" y="310" width="220" height="65" rx="11" fill="#edf1ec" stroke="#c4d2c5"/><text x="800" y="349" text-anchor="middle" class="state">CANCELLED</text>
<text x="490" y="58" text-anchor="middle" class="edge">Các bước thành công</text><text x="325" y="181" text-anchor="middle" class="edge">Chưa rõ</text><text x="433" y="116" text-anchor="middle" class="edge">Đối soát, tiếp tục với cùng operation ID</text><text x="231" y="292" class="edge">Lỗi sau reserve / charge</text><text x="504" y="270" class="edge">Đã rõ, cần bù</text><text x="645" y="328" text-anchor="middle" class="edge">Bù xong</text><text x="480" y="437" text-anchor="middle" class="edge">Reserve bị từ chối: không có side effect cần bù</text>
</svg>"""


def inline(text):
    tokens = []
    def hold(value):
        tokens.append(value)
        return f"\x00{len(tokens)-1}\x00"
    text = re.sub(r"`([^`]+)`", lambda m: hold("<code>" + html.escape(m[1]) + "</code>"), text)
    text = html.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", lambda m: '<a href="' + m[2] + '">' + m[1] + '</a>', text)
    for n, token in enumerate(tokens):
        text = text.replace(f"\x00{n}\x00", token)
    return text


def render(source):
    lines = source.splitlines()
    output = ['<header class="hero">']
    headings = []
    section_open = False
    diagram_count = 0
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith('```'):
            lang = line[3:]
            code = []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                code.append(lines[i])
                i += 1
            if lang == 'mermaid':
                diagram = ARCH if diagram_count == 0 else STATES
                expected = 'UI đặt hàng' if diagram_count == 0 else 'PROCESSING'
                if expected not in '\n'.join(code) or diagram_count > 1:
                    raise ValueError('Diagram source changed; update its SVG together with Markdown.')
                caption = 'Ba process nghiệp vụ, mỗi service có một SQLite dùng chung cho hai cơ chế. UI/launcher độc lập, chỉ đọc nghiệp vụ qua HTTP.' if diagram_count == 0 else 'Pending còn việc phải làm: chỉ kết thúc khi xác nhận thành công hoặc bù đầy đủ.'
                output.append('<figure><div class="diagram-scroll">' + diagram + '</div><figcaption>' + caption + '</figcaption></figure>')
                diagram_count += 1
            else:
                output.append('<pre><code class="language-' + html.escape(lang) + '">' + html.escape('\n'.join(code)) + '</code></pre>')
            i += 1
            continue
        if line.startswith('# '):
            output.append('<h1>' + inline(line[2:]) + '</h1>')
        elif line.startswith('## '):
            if section_open:
                output.append('</section>')
            else:
                output.append('</header>')
            title = line[3:]
            anchor = f'section-{len(headings)+1}'
            headings.append((anchor, title))
            output.append(f'<section id="{anchor}"><h2>{inline(title)}</h2>')
            section_open = True
        elif line.startswith('### '):
            output.append('<h3>' + inline(line[4:]) + '</h3>')
        elif re.match(r'^\d+\.\s+', line):
            output.append('<ol>')
            while i < len(lines) and re.match(r'^\d+\.\s+', lines[i].strip()):
                item = re.sub(r'^\d+\.\s+', '', lines[i].strip())
                output.append('<li>' + inline(item) + '</li>')
                i += 1
            output.append('</ol>')
            continue
        elif line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-{3,}:?', c) for c in cells):
                    rows.append(cells)
                i += 1
            table_class = ' class="log-table"' if rows[0][:2] == ['Lượt gọi', 'HTTP'] else ''
            if rows[0][0] == 'Phương thức':
                table_class = ' class="api-table"'
            output.append('<div class="table-wrap"><table' + table_class + '><thead><tr>' + ''.join('<th scope="col">' + inline(c) + '</th>' for c in rows[0]) + '</tr></thead><tbody>')
            for row in rows[1:]:
                output.append('<tr>' + ''.join('<td>' + inline(c) + '</td>' for c in row) + '</tr>')
            output.append('</tbody></table></div>')
            continue
        else:
            parts = [line]
            while i + 1 < len(lines) and lines[i+1].strip() and not re.match(r'^(#|\||```)', lines[i+1]):
                i += 1
                parts.append(lines[i].strip())
            attr = ' class="kicker"' if line.startswith('Block 7 ·') else ''
            output.append('<p' + attr + '>' + inline(' '.join(parts)) + '</p>')
        i += 1
    output.append('</section>' if section_open else '</header>')
    if diagram_count != 2:
        raise ValueError('Expected two diagrams.')
    return '\n'.join(output), headings


def main():
    source = SOURCE.read_text(encoding='utf-8')
    content, headings = render(source)
    source_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    toc = ''.join(f'<a href="#{anchor}"><span class="toc-num">{n:02d}</span><span>{html.escape(re.sub(r"^\d+\.\s*", "", title))}</span></a>' for n, (anchor, title) in enumerate(headings, 1))
    document = f'''<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="report-source-sha256" content="{source_hash}"><title>Block 7 — Checkout với Baseline và Saga</title><style>{CSS}</style></head>
<body><div class="topbar"><strong>ADVANCED WEB / BLOCK 7</strong><span>Báo cáo hệ thống · 05.11.2026</span></div>
<div class="layout"><nav class="toc" aria-label="Mục lục"><div class="toc-title">NỘI DUNG</div><div class="toc-links">{toc}</div><div class="toc-note">Baseline · Saga<br>TypeScript / Express / SQLite<br><br>Tài liệu mở được offline.<br>Ctrl+P để in hoặc lưu PDF.</div></nav>
<main class="document" id="content">{content}<footer class="document-footer"><span>Block 7 · Baseline &amp; Saga orchestration</span><span>Kiểm chứng local · 05/11/2026</span></footer></main></div>
<div class="page-footer">Mỗi kết luận về đơn hàng cần được đối chiếu ở cả ba service.</div></body></html>'''
    OUTPUT.write_text(document, encoding='utf-8', newline='\n')
    print(f'Rendered {OUTPUT.name}: {len(headings)} sections, 2 embedded SVG diagrams.')


if __name__ == '__main__':
    main()
