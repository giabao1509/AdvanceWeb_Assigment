import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type FlowId = 'baseline-e2e' | 'secure-e2e';
type EndToEndCaseId = 'baseline-order-success' | 'baseline-stock-low' | 'secure-order-success' | 'secure-no-jwt' | 'secure-invalid-jwt' | 'secure-stock-low' | 'secure-refresh';

interface EvidenceExchange {
  sequence: number;
  label: string;
  note?: string;
  actors: {
    request: { from: string; to: string };
    response: { from: string; to: string };
  };
  request: { method: string; url: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; body: unknown };
  expectedStatus: number;
  pass: boolean;
  children?: EvidenceExchange[];
}

interface ScenarioDefinition {
  id: EndToEndCaseId;
  code: string;
  flow: FlowId;
  label: string;
  objective: string;
  requestFrom: string;
  requestTo: string;
  expected: number;
}

interface EndToEndResult {
  runId: string;
  flowId: FlowId;
  caseId: EndToEndCaseId;
  label: string;
  objective: string;
  signing: { algorithm: string; kid: string } | null;
  expected: number;
  actual: number;
  pass: boolean;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  before: unknown;
  after: unknown;
  exchanges: EvidenceExchange[];
}

interface RotationCheck {
  phase: string;
  algorithm: string;
  kid: string;
  actual: number | number[];
  pass: boolean;
  exchange?: EvidenceExchange;
}

interface ProcessStatus {
  name: string;
  pid: number | null;
  port: number;
  health: Record<string, unknown>;
  state?: Record<string, unknown>;
}

interface LogEntry { at: string; process: string; stream: string; line: string }

interface ActiveRun {
  kind: 'case' | 'rotation';
  caseId?: EndToEndCaseId;
  label: string;
  startedAt: number;
}

const flows: Record<FlowId, {
  eyebrow: string;
  title: string;
  description: string;
  nodes: Array<{ label: string; meta: string; tone: string }>;
}> = {
  'baseline-e2e': {
    eyebrow: 'SECURITY OFF',
    title: 'Baseline End-to-End',
    description: 'Client → Order v1 → Inventory v1. Chạy nghiệp vụ không JWT và không chữ ký service.',
    nodes: [
      { label: 'Client', meta: 'Không cần đăng nhập', tone: 'neutral' },
      { label: 'Order v1', meta: ':3001 · không kiểm JWT', tone: 'warning' },
      { label: 'Inventory v1', meta: ':5001 · không kiểm chữ ký', tone: 'danger' },
    ],
  },
  'secure-e2e': {
    eyebrow: 'SECURITY ON',
    title: 'Full Security End-to-End',
    description: 'Đăng nhập → access JWT → Order v2 → HMAC/Ed25519 → Inventory v2.',
    nodes: [
      { label: 'Browser / Client', meta: 'Đăng nhập · JWT', tone: 'neutral' },
      { label: 'Order v2', meta: ':3002 · xác minh JWT', tone: 'primary' },
      { label: 'Inventory v2', meta: ':5002 · xác minh HMAC/Ed25519', tone: 'secure' },
    ],
  },
};

const scenarios: ScenarioDefinition[] = [
  { id: 'baseline-order-success', code: 'B-E2E-01', flow: 'baseline-e2e', label: 'Đặt hàng thành công', objective: 'Không đăng nhập vẫn tạo được đơn và reservation.', requestFrom: 'Client', requestTo: 'Order v1', expected: 201 },
  { id: 'baseline-stock-low', code: 'B-E2E-02', flow: 'baseline-e2e', label: 'Kho không đủ hàng', objective: 'Gửi đơn hàng có số lượng vượt quá tồn kho.', requestFrom: 'Client', requestTo: 'Order v1', expected: 409 },
  { id: 'secure-order-success', code: 'S-E2E-01', flow: 'secure-e2e', label: 'Đăng nhập và đặt hàng', objective: 'JWT hợp lệ và chữ ký nội bộ cho phép tạo reservation.', requestFrom: 'Client', requestTo: 'Order v2', expected: 201 },
  { id: 'secure-no-jwt', code: 'S-E2E-02', flow: 'secure-e2e', label: 'Thiếu access token', objective: 'Order v2 từ chối request và không gọi Inventory.', requestFrom: 'Client', requestTo: 'Order v2', expected: 401 },
  { id: 'secure-invalid-jwt', code: 'S-E2E-03', flow: 'secure-e2e', label: 'Access token giả', objective: 'JWT không hợp lệ bị từ chối trước khi gọi Inventory.', requestFrom: 'Client', requestTo: 'Order v2', expected: 401 },
  { id: 'secure-stock-low', code: 'S-E2E-04', flow: 'secure-e2e', label: 'JWT hợp lệ nhưng kho thiếu hàng', objective: 'Đặt số lượng vượt tồn kho với JWT và chữ ký hợp lệ.', requestFrom: 'Client', requestTo: 'Order v2', expected: 409 },
  { id: 'secure-refresh', code: 'S-E2E-05', flow: 'secure-e2e', label: 'Đổi refresh token A → B', objective: 'Login và refresh hiển thị thành hai cặp request/response.', requestFrom: 'Trình duyệt', requestTo: 'Order v2 /auth/refresh', expected: 200 },
];

const post = async (path: string, body: unknown = {}) => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((result as { code?: string }).code ?? `HTTP ${response.status}`);
  return result;
};

const mergeResults = (current: EndToEndResult[], incoming: EndToEndResult[]) => {
  const merged = new Map(current.map((result) => [result.runId, result]));
  for (const result of incoming) merged.set(result.runId, result);
  return [...merged.values()];
};

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
    server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M15 6.5h3M15 17.5h3" /></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" /></>,
    refresh: <><path d="M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5M4 17a8 8 0 0 0 14 2l3-3m0 5v-5h-5" /></>,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
    key: <><circle cx="8" cy="8" r="5" /><path d="m12 12 9 9m-5-5 3-3m-6 0 3-3" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.layers}</svg>;
}

function App() {
  const [selectedFlow, setSelectedFlow] = useState<FlowId>('secure-e2e');
  const [selectedCaseId, setSelectedCaseId] = useState<EndToEndCaseId>('secure-order-success');
  const [processes, setProcesses] = useState<ProcessStatus[]>([]);
  const [results, setResults] = useState<EndToEndResult[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [rotationChecks, setRotationChecks] = useState<RotationCheck[]>([]);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const busy = activeRun !== null;
  const [modeUpdating, setModeUpdating] = useState(false);
  const [notice, setNotice] = useState('Hệ thống sẵn sàng');
  const [logProcess, setLogProcess] = useState('all');

  const refreshProcesses = async () => {
    const response = await fetch('/api/processes');
    const data = await response.json();
    setProcesses(data.workers ?? []);
  };

  useEffect(() => {
    void refreshProcesses();
    void fetch('/api/end-to-end/evidence').then((response) => response.json()).then((data) => setResults(data.results ?? []));
    const processTimer = window.setInterval(() => void refreshProcesses(), 300_000);
    const stream = new EventSource('/api/logs/stream');
    stream.onmessage = (event) => setLogs((current) => [...current.slice(-399), JSON.parse(event.data)]);
    return () => {
      window.clearInterval(processTimer);
      stream.close();
    };
  }, []);

  const visibleScenarios = useMemo(
    () => scenarios.filter((scenario) => scenario.flow === selectedFlow),
    [selectedFlow],
  );

  const selectedScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === selectedCaseId) ?? null,
    [selectedCaseId],
  );

  const selectedResult = useMemo(
    () => [...results].reverse().find((result) => result.caseId === selectedCaseId && result.flowId === selectedFlow) ?? null,
    [results, selectedCaseId, selectedFlow],
  );

  const filteredLogs = useMemo(
    () => logs.filter((entry) => logProcess === 'all' || entry.process === logProcess).slice(-100).reverse(),
    [logs, logProcess],
  );

  const flow = flows[selectedFlow];
  const secureOrderState = processes.find((item) => item.name === 'secure-order')?.state;
  const secureInventoryState = processes.find((item) => item.name === 'secure-inventory')?.state;
  const activeAlgorithm = secureOrderState?.activeAlgorithm;
  const activeSigningKid = secureOrderState?.activeSigningKid;
  const trustedKids = Array.isArray(secureInventoryState?.trustedKids) ? secureInventoryState.trustedKids as string[] : [];
  const preferredEdKid = activeSigningKid === 'ed-2' || (!trustedKids.includes('ed-1') && trustedKids.includes('ed-2')) ? 'ed-2' : 'ed-1';

  const runFlowCase = async (caseId: EndToEndCaseId) => {
    const scenario = scenarios.find((item) => item.id === caseId);
    setActiveRun({ kind: 'case', caseId, label: scenario?.label ?? caseId, startedAt: Date.now() });
    setNotice(`Đang chạy: ${scenario?.label ?? caseId}...`);
    try {
      const result = await post('/api/flows/run', { flowId: selectedFlow, caseId }) as EndToEndResult;
      setResults((current) => mergeResults(current, [result]));
      setNotice(`Đã nhận response · HTTP ${result.actual}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setActiveRun(null);
      void refreshProcesses();
    }
  };

  const action = async (label: string, path: string, body?: unknown) => {
    try {
      const result = await post(path, body);
      setNotice(`${label}: thành công`);
      setTimeout(() => void refreshProcesses(), 250);
      return result;
    } catch (error) {
      setNotice(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const changeSigningMode = async (algorithm: 'hmac-sha256' | 'ed25519', kid?: 'ed-1' | 'ed-2') => {
    setModeUpdating(true);
    try {
      await action(algorithm === 'hmac-sha256' ? 'Đã chuyển sang HMAC' : `Đã chuyển sang Ed25519 / ${kid}`, '/api/demo/signing-mode', { algorithm, kid });
    } finally {
      setModeUpdating(false);
    }
  };

  const runRotationFlow = async () => {
    const waitForIpc = () => new Promise((resolvePromise) => window.setTimeout(resolvePromise, 300));
    const checks: RotationCheck[] = [];
    const runSecureOrder = async () => {
      const result = await post('/api/flows/run', { flowId: 'secure-e2e', caseId: 'secure-order-success' }) as EndToEndResult;
      setResults((current) => mergeResults(current, [result]));
      return result;
    };
    const addRunCheck = (phase: string, result: EndToEndResult) => {
      const check: RotationCheck = {
        phase,
        algorithm: result.signing?.algorithm ?? 'không có',
        kid: result.signing?.kid ?? 'không có',
        actual: result.actual,
        pass: result.pass,
      };
      checks.push(check);
      setRotationChecks([...checks]);
    };
    setActiveRun({ kind: 'rotation', label: 'Đổi key ed-1 → ed-2', startedAt: Date.now() });
    setRotationChecks([]);
    try {
      setNotice('Đổi key 1/9 · Khởi tạo ed-1');
      await post('/api/demo/rotation/initial');
      await waitForIpc();

      setNotice('Đổi key 2/9 · Chạy Full Security bằng ed-1');
      const before = await runSecureOrder();
      addRunCheck('Ban đầu · ed-1', before);

      setNotice('Đổi key 3/9 · Nạp public key ed-2');
      await post('/api/demo/rotation/prepare');
      await waitForIpc();
      setNotice('Đổi key 4/9 · Kiểm tra tiếp bằng ed-1');
      const prepared = await runSecureOrder();
      addRunCheck('Sau khi nạp ed-2 · vẫn dùng ed-1', prepared);

      setNotice('Đổi key 5/9 · Chuyển signer sang ed-2');
      await post('/api/demo/rotation/switch');
      await waitForIpc();
      setNotice('Đổi key 6/9 · Chạy Full Security bằng ed-2');
      const switched = await runSecureOrder();
      addRunCheck('Sau khi chuyển signer · ed-2', switched);

      setNotice('Đổi key 7/9 · Gỡ ed-1');
      await post('/api/demo/rotation/retire', { confirmNoInflight: true });
      await waitForIpc();

      setNotice('Đổi key 8/9 · Xác minh ed-1 bị từ chối');
      const retired = await post('/api/demo/rotation/check-retired') as EvidenceExchange;
      checks.push({ phase: 'Sau khi gỡ · ed-1 bị từ chối', algorithm: 'ed25519', kid: 'ed-1', actual: retired.response.status, pass: retired.pass, exchange: retired });
      setRotationChecks([...checks]);
      setNotice('Đổi key 9/9 · Chạy lại Full Security bằng ed-2');
      const after = await runSecureOrder();
      addRunCheck('Sau khi gỡ ed-1 · Full Security dùng ed-2', after);
      setNotice('Đã hoàn tất luồng đổi key ed-1 → ed-2');
    } catch (error) {
      setNotice(`Đổi key thất bại: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setActiveRun(null);
      void refreshProcesses();
    }
  };

  return <div className="shell">
    <header className="topbar">
      <a className="brand" href="#dashboard" aria-label="Trang dashboard">
        <span className="brand-mark"><Icon name="layers" /></span>
        <div><strong>Security Lab<span className="brand-divider"> / </span><span className="brand-subtitle">Dashboard</span></strong><small>Khám phá luồng xác thực giữa các service</small></div>
      </a>
      <button className="button secondary reset-button" disabled={busy || modeUpdating} onClick={() => void action('Đặt lại dữ liệu', '/api/demo/reset')}><Icon name="refresh" />Đặt lại dữ liệu</button>
    </header>

    <main className="content" id="dashboard">
      <section className="page-intro">
        <div><span className="eyebrow">KHÔNG GIAN THỬ NGHIỆM</span><h1>Theo dõi từng chặng request.</h1><p>Chọn luồng, chọn tình huống và xem các service trao đổi dữ liệu.</p></div>
        <div className={`system-state ${busy || modeUpdating ? 'running' : ''}`} role="status" aria-live="polite"><i />{modeUpdating ? 'Đang cập nhật thuật toán…' : notice}</div>
      </section>

      <nav className="flow-tabs" aria-label="Chọn luồng end-to-end">
        {(Object.keys(flows) as FlowId[]).map((id) => <button key={id} disabled={busy || modeUpdating} aria-pressed={selectedFlow === id} className={`flow-tab ${selectedFlow === id ? 'active' : ''}`} onClick={() => {
          setSelectedFlow(id);
          setSelectedCaseId(scenarios.find((scenario) => scenario.flow === id)!.id);
        }}>
          <span className={`tab-icon ${id === 'secure-e2e' ? 'secure' : ''}`}><Icon name={id === 'secure-e2e' ? 'shield' : 'layers'} /></span>
          <span><strong>{id === 'secure-e2e' ? 'Có bảo mật đầy đủ' : 'Baseline · Không bảo mật'}</strong><small>{id === 'secure-e2e' ? 'JWT + chữ ký service' : 'Gọi trực tiếp các service'}</small></span>
          <span className="tab-selection">{selectedFlow === id ? 'Đang chọn' : 'Chọn luồng →'}</span>
        </button>)}
      </nav>

      <section className={`architecture ${selectedFlow === 'secure-e2e' ? 'is-secure' : ''}`} aria-label="Sơ đồ trao đổi giữa các service">
        <div className="architecture-heading"><div><span className="eyebrow">SƠ ĐỒ LUỒNG</span><h2>{flow.title}</h2></div><span className="security-tag"><Icon name={selectedFlow === 'secure-e2e' ? 'shield' : 'layers'} />{selectedFlow === 'secure-e2e' ? 'Bật bảo mật' : 'Không xác thực'}</span></div>
        <div className="flow-map">
          {flow.nodes.map((node, index) => <div className="flow-segment" key={node.label}>
            <article className={`flow-node node-${index}`}>
              <div className="node-top"><span className="node-icon"><Icon name={index === 0 ? 'monitor' : index === 1 ? 'server' : 'database'} /></span><span className="node-role">{index === 0 ? 'NGƯỜI GỬI' : index === 1 ? 'XỬ LÝ ĐƠN' : 'QUẢN LÝ KHO'}</span></div>
              <strong>{node.label}</strong><small>{node.meta}</small>
              <span className="node-caption">{index === 0 ? 'Bắt đầu và nhận kết quả' : index === 1 ? 'Nhận yêu cầu · gọi Inventory' : 'Giữ hàng · trả reservation'}</span>
            </article>
            {index < flow.nodes.length - 1 && <div className="connector">
              <span className="connection-auth">{selectedFlow === 'secure-e2e' ? index === 0 ? 'Access JWT' : String(activeAlgorithm ?? 'Chữ ký service') : 'Không xác thực'}</span>
              <span className="request-arrow"><span>Request</span><i /></span>
              <span className="response-arrow"><i /><span>Response</span></span>
            </div>}
          </div>)}
        </div>
        <p className="diagram-caption"><Icon name="info" />{selectedFlow === 'secure-e2e' ? 'Đăng nhập tại Order để nhận JWT trước khi đặt hàng. Chữ ký service bảo vệ chặng Order → Inventory.' : 'Client gửi đơn trực tiếp. Các chặng không yêu cầu JWT hoặc chữ ký service.'}</p>
      </section>

      <div className="workspace">
        <section className="case-panel">
          <div className="panel-heading"><span className="step-number">01</span><div><h2>Chọn tình huống</h2><p>Mỗi case là một lần chạy riêng.</p></div></div>
          {selectedFlow === 'secure-e2e' && <div className="signing-control">
            <label>Chữ ký Order → Inventory</label>
            <div className="mode-toggle" role="group" aria-label="Thuật toán chữ ký">
              <button disabled={busy || modeUpdating} aria-pressed={activeAlgorithm === 'hmac-sha256'} className={activeAlgorithm === 'hmac-sha256' ? 'selected-mode' : ''} onClick={() => void changeSigningMode('hmac-sha256')}>HMAC-SHA256<small>Đối xứng</small></button>
              <button disabled={busy || modeUpdating} aria-pressed={activeAlgorithm === 'ed25519'} className={activeAlgorithm === 'ed25519' ? 'selected-mode' : ''} onClick={() => void changeSigningMode('ed25519', preferredEdKid)}>Ed25519<small>Bất đối xứng</small></button>
            </div>
            <small>{modeUpdating ? 'Đang đổi thuật toán…' : `Key hiện tại: ${String(activeSigningKid ?? 'đang tải…')}`}</small>
          </div>}
          <div className="scenario-grid" role="group" aria-label="Các case mẫu">
            {visibleScenarios.map((scenario) => <button key={scenario.id} disabled={busy || modeUpdating} aria-pressed={selectedCaseId === scenario.id} aria-busy={activeRun?.caseId === scenario.id} className={`scenario-card ${selectedCaseId === scenario.id ? 'selected' : ''} ${activeRun?.caseId === scenario.id ? 'case-running' : ''}`} onClick={() => setSelectedCaseId(scenario.id)}>
              {activeRun?.caseId === scenario.id ? <span className="run-spinner" aria-hidden="true" /> : <span className="case-radio">{selectedCaseId === scenario.id && <i />}</span>}
              <span className="scenario-copy"><strong>{scenario.label}</strong>{activeRun?.caseId === scenario.id && <span className="case-running-label">ĐANG CHẠY</span>}<small>{scenario.objective}</small></span>
            </button>)}
          </div>
          <div className="run-controls">
            <button className={`button primary run-flow-button ${busy ? 'is-running' : ''}`} disabled={busy || modeUpdating || !selectedScenario} onClick={() => selectedScenario && void runFlowCase(selectedScenario.id)}>{busy ? <span className="run-spinner" aria-hidden="true" /> : <Icon name="play" />}{activeRun?.kind === 'rotation' ? 'Đang chạy đổi key…' : busy ? 'Đang chạy case…' : 'Chạy case đã chọn'}</button>
            <small>{selectedScenario?.requestFrom} → {selectedScenario?.requestTo}</small>
          </div>
        </section>

        <section className={`inspector ${busy ? 'inspector-running' : ''}`} aria-busy={busy}>
          <div className="panel-heading"><span className="step-number">02</span><div><h2>Request & response</h2><p>{selectedScenario?.label ?? 'Chọn một tình huống để bắt đầu'}</p></div>{selectedResult && <span className="duration">{selectedResult.durationMs} ms</span>}</div>
          {activeRun && <div className="running-banner" role="status"><span className="run-spinner" aria-hidden="true" /><div><strong>Đang chạy: {activeRun.label}</strong><small>{selectedResult ? 'Bên dưới là kết quả lần trước. Response mới sẽ xuất hiện khi hoàn tất.' : 'Đang gửi request và chờ service phản hồi…'}</small></div></div>}
          {selectedResult ? <>
            <div className="result-meta"><span><i />Lần chạy gần nhất · {new Date(selectedResult.completedAt).toLocaleTimeString('vi-VN')}{selectedResult.signing ? ` · ${selectedResult.signing.algorithm} / ${selectedResult.signing.kid}` : ''}</span><span className="http-status">HTTP {selectedResult.actual}</span></div>
            <ExchangeTimeline exchanges={selectedResult.exchanges} />
            {(selectedResult.before !== undefined || selectedResult.after !== undefined) && <details className="data-details"><summary>Trạng thái dữ liệu trước và sau khi chạy</summary><div className="state-grid">
              <JsonPanel label="Trước khi chạy" value={selectedResult.before} tone="state" />
              <JsonPanel label="Sau khi chạy" value={selectedResult.after} tone="state" />
            </div></details>}
          </> : <div className="inspector-empty">
            <div className="empty-illustration"><span><Icon name="server" /></span><i>⇄</i><span><Icon name="database" /></span></div>
            <h3>{busy ? 'Đang chờ phản hồi từ service' : 'Sẵn sàng nhận request đầu tiên'}</h3><p>Chọn một tình huống bên trái, rồi bấm<br /><strong>“Chạy case đã chọn”</strong> để xem dữ liệu trao đổi.</p>
            <div className="empty-legend"><span><i className="blue-dot" />Request gửi đi</span><span><i className="teal-dot" />Response nhận về</span></div>
          </div>}
        </section>
      </div>

      {selectedFlow === 'secure-e2e' && <details className="extra-section rotation-disclosure">
        <summary><span className="summary-icon"><Icon name="key" /></span><span><strong>Thử nghiệm đổi key</strong><small>Rotation ed-1 → ed-2 · chạy và xem response ở từng giai đoạn</small></span><span className="disclosure-action">Mở chi tiết <span>⌄</span></span></summary>
        <RotationPanel processes={processes} action={action} runFlow={runRotationFlow} busy={busy || modeUpdating} running={activeRun?.kind === 'rotation'} checks={rotationChecks} />
      </details>}

      <details className="extra-section log-panel">
        <summary><span className="summary-icon"><Icon name="terminal" /></span><span><strong>Nhật ký service</strong><small>Theo dõi sự kiện backend theo thời gian thực</small></span><span className="disclosure-action">Mở nhật ký <span>⌄</span></span></summary>
        <div className="log-toolbar"><label htmlFor="log-service">Lọc service</label><select id="log-service" value={logProcess} onChange={(event) => setLogProcess(event.target.value)}><option value="all">Tất cả service</option>{[...new Set(logs.map((entry) => entry.process))].map((name) => <option key={name}>{name}</option>)}</select></div>
        <div className="log-list">{filteredLogs.length ? filteredLogs.map((entry, index) => <LogRow key={`${entry.at}-${index}`} entry={entry} />) : <div className="empty-state">Chưa có log trong phiên này.</div>}</div>
      </details>
      <footer className="page-footer"><span>Security Lab · Block 04</span><span>Client → Order → Inventory</span></footer>
    </main>
    {activeRun && <RunIndicator run={activeRun} message={notice} />}
  </div>;
}

function RunIndicator({ run, message }: { run: ActiveRun; message: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((Date.now() - run.startedAt) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [run.startedAt]);
  return <aside className="run-indicator" role="status" aria-live="polite"><span className="run-spinner" aria-hidden="true" /><div><strong>Đang chạy · {run.label}</strong><small>{message}</small></div><span className="run-elapsed" aria-hidden="true">{elapsed.toFixed(1)}s</span><span className="run-indeterminate" aria-hidden="true" /></aside>;
}

function ExchangeTimeline({ exchanges }: { exchanges: EvidenceExchange[] }) {
  const countExchanges = (items: EvidenceExchange[]): number => items.reduce((count, item) => count + 1 + (item.children ? countExchanges(item.children) : 0), 0);
  return <div className="exchange-list">
    <div className="exchange-summary"><strong>Luồng có {countExchanges(exchanges)} request/response</strong><span>Mỗi lần bên dưới có request và response tương ứng theo đúng thứ tự chạy.</span></div>
    {exchanges.map((exchange) => <ExchangeCard exchange={exchange} key={exchange.sequence} />)}
  </div>;
}

function ExchangeCard({ exchange, nested = false }: { exchange: EvidenceExchange; nested?: boolean }) {
  const request = <JsonPanel label="Request body · Nội dung gửi" badge={exchange.request.method} value={exchange.request.body} tone="request" requestMeta={exchange.request} />;
  const response = <JsonPanel label="Response body · Nội dung nhận" badge={`HTTP ${exchange.response.status}`} value={exchange.response.body} tone="response" />;
  return <section className={`exchange-step ${exchange.children?.length ? 'has-children' : ''}`}>
    <header className="exchange-heading">
      <div><span>{nested ? 'CHẶNG NỘI BỘ' : `BƯỚC ${exchange.sequence}`}</span><strong>{exchange.label}</strong>{exchange.note && <small>{exchange.note}</small>}</div>
      <span className={`http-status http-${Math.floor(exchange.response.status / 100)}xx`}>HTTP {exchange.response.status}</span>
    </header>
    <div className="actor-route">
      <div><span>↗ REQUEST · GỬI ĐI</span><strong>{exchange.actors.request.from} <b>→</b> {exchange.actors.request.to}</strong><small>Bên gửi: <em>{exchange.actors.request.from}</em> · Bên nhận: <em>{exchange.actors.request.to}</em></small></div>
      <div><span>↙ RESPONSE · NHẬN VỀ</span><strong>{exchange.actors.response.from} <b>→</b> {exchange.actors.response.to}</strong><small>Bên trả lời: <em>{exchange.actors.response.from}</em> · Bên nhận: <em>{exchange.actors.response.to}</em></small></div>
    </div>
    {exchange.children?.length ? <>
      <div className="io-grid single-exchange-panel">{request}</div>
      <div className="nested-exchanges"><strong>Trong lúc chờ response này, Order gọi tiếp:</strong><div className="nested-exchange-list">{exchange.children.map((child) => <ExchangeCard exchange={child} nested key={child.sequence} />)}</div></div>
      <div className="io-grid single-exchange-panel">{response}</div>
    </> : <div className="io-grid">{request}{response}</div>}
  </section>;
}

const fieldDescriptions: Record<string, string> = {
  username: 'Tên tài khoản đăng nhập.',
  password: 'Mật khẩu đăng nhập; giá trị nhạy cảm được che.',
  accessToken: 'JWT dùng để xác thực các request tiếp theo.',
  access_token: 'JWT dùng để xác thực các request tiếp theo.',
  expiresIn: 'Thời gian token còn hiệu lực, tính bằng giây.',
  tokenType: 'Loại token dùng trong header Authorization.',
  refreshToken: 'Token dùng để lấy access token mới; giá trị được che.',
  code: 'Mã kết quả hoặc mã lỗi do service trả về.',
  message: 'Thông báo giải thích kết quả xử lý.',
  orderId: 'Mã định danh của đơn hàng.',
  reservationId: 'Mã xác nhận giữ hàng do Inventory tạo.',
  sku: 'Mã sản phẩm trong kho.',
  quantity: 'Số lượng sản phẩm yêu cầu.',
  qty: 'Số lượng sản phẩm yêu cầu.',
  items: 'Danh sách sản phẩm của yêu cầu.',
  status: 'Trạng thái xử lý do service trả về.',
};

function highlightJson(line: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /"(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let offset = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index!;
    if (index > offset) tokens.push(line.slice(offset, index));
    const token = match[0];
    const kind = token.startsWith('"') ? token.endsWith(':') ? 'key' : 'string' : token === 'null' ? 'null' : /true|false/.test(token) ? 'boolean' : 'number';
    const key = kind === 'key' ? JSON.parse(token.slice(0, token.lastIndexOf(':')).trim()) as string : '';
    tokens.push(<span className={`json-${kind}`} title={fieldDescriptions[key]} key={index}>{token}</span>);
    offset = index + token.length;
  }
  if (offset < line.length) tokens.push(line.slice(offset));
  return tokens;
}

function JsonPanel({ label, badge, value, tone, requestMeta }: {
  label: string; badge?: string; value: unknown; tone: string; requestMeta?: EvidenceExchange['request'];
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const json = JSON.stringify(value, null, 2);
  const fields = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter((key) => fieldDescriptions[key]) : [];
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(json ?? ''); setCopyState('copied'); }
    catch { setCopyState('error'); }
  };
  return <article className={`json-panel ${tone}`}>
    <header><strong>{label}</strong>{badge && <span>{badge}</span>}</header>
    {requestMeta && <div className="request-metadata">
      <div className="request-url"><span>ENDPOINT</span><code>{requestMeta.url}</code></div>
      {requestMeta.headers && Object.keys(requestMeta.headers).length > 0 && <details className="headers-details"><summary>Headers · Thông tin xác thực & định dạng</summary><dl>{Object.entries(requestMeta.headers).map(([key, val]) => <div key={key}><dt>{key}</dt><dd>{val}</dd></div>)}</dl></details>}
    </div>}
    {json !== undefined ? <>
      <div className="json-toolbar"><span>{tone === 'state' ? 'DỮ LIỆU' : 'BODY'} <b>JSON</b></span><button type="button" onClick={() => void copy()} aria-label={`Sao chép ${label}`}>{copyState === 'copied' ? 'Đã sao chép ✓' : copyState === 'error' ? 'Không sao chép được' : 'Sao chép'}</button></div>
      <pre className="json-code" tabIndex={0} aria-label={label}><code>{json.split('\n').map((line, index) => <span className="json-line" key={index}><span className="line-number" aria-hidden="true">{index + 1}</span><span className="line-content">{highlightJson(line)}</span></span>)}</code></pre>
      {tone !== 'state' && fields.length > 0 && <details className="field-notes" open><summary><Icon name="info" />Chú thích các trường</summary><dl>{fields.map((key) => <div key={key}><dt>{key}</dt><dd>{fieldDescriptions[key]}</dd></div>)}</dl></details>}
    </> : <div className="no-body">Request này không gửi body.</div>}
  </article>;
}

function LogRow({ entry }: { entry: LogEntry }) {
  let message = entry.line;
  let event = entry.stream;
  try {
    const parsed = JSON.parse(entry.line) as { event?: string; msg?: string; reason?: string; req?: { method?: string; url?: string }; res?: { statusCode?: number } };
    event = parsed.event ?? (parsed.req ? `${parsed.req.method} ${parsed.req.url}` : parsed.res ? `HTTP ${parsed.res.statusCode}` : entry.stream);
    message = parsed.reason ?? parsed.msg ?? entry.line;
  } catch { /* keep raw worker line */ }
  return <div className="log-row"><time>{new Date(entry.at).toLocaleTimeString('vi-VN')}</time><span className="process-chip">{entry.process}</span><strong>{event}</strong><code>{message}</code></div>;
}

function RotationPanel({ processes, action, runFlow, busy, running, checks }: {
  processes: ProcessStatus[];
  action: (label: string, path: string, body?: unknown) => Promise<unknown>;
  runFlow: () => Promise<void>;
  busy: boolean;
  running: boolean;
  checks: RotationCheck[];
}) {
  const secureState = processes.filter((item) => item.name.startsWith('secure')).map((item) => ({ name: item.name, ...item.state }));
  const steps = [
    { id: '01', title: 'Khởi tạo ed-1', copy: 'Order ký ed-1, Inventory tin cậy ed-1', path: '/api/demo/rotation/initial', body: {} },
    { id: '02', title: 'Nạp ed-2', copy: 'Nạp public key mới, signer vẫn dùng ed-1', path: '/api/demo/rotation/prepare', body: {} },
    { id: '03', title: 'Chuyển sang ed-2', copy: 'Order đổi signer, Inventory tin cậy cả hai key', path: '/api/demo/rotation/switch', body: {} },
    { id: '04', title: 'Gỡ ed-1', copy: 'Gỡ key cũ sau khi hết request đang xử lý', path: '/api/demo/rotation/retire', body: { confirmNoInflight: true } },
  ];
  return <div className="rotation-workspace">
    <section className="rotation-runner">
      <div><span>CASE ROTATION TRONG FULL SECURITY</span><h2>Đổi ed-1 → ed-2 và chạy lại request</h2><p>Chạy request trước đổi key, nạp ed-2, chuyển signer, gỡ ed-1 rồi chạy lại bằng ed-2.</p></div>
      <button className={`button primary ${running ? 'is-running' : ''}`} disabled={busy} onClick={() => void runFlow()}>{running && <span className="run-spinner" aria-hidden="true" />}{running ? 'Đang chạy luồng đổi key...' : checks.length ? '↻ Chạy lại luồng đổi key' : '▶ Chạy luồng đổi key'}</button>
      <div className="rotation-checks">
        {checks.length ? checks.map((check) => <article key={check.phase}>
          <span>{check.phase}</span><strong>{check.algorithm} · {check.kid}</strong><small>HTTP {JSON.stringify(check.actual)}</small>
        </article>) : <div className="rotation-empty">Chưa chạy. Kết quả trước và sau khi đổi key sẽ hiển thị tại đây.</div>}
      </div>
      {checks.some((check) => check.exchange) && <div className="rotation-evidence"><h3>Request/response kiểm tra key cũ</h3><ExchangeTimeline exchanges={checks.flatMap((check) => check.exchange ? [check.exchange] : [])} /></div>}
    </section>
    <details className="data-details"><summary>Thao tác đổi key thủ công và trạng thái service</summary><section className="rotation-panel">
      <div className="rotation-steps">{steps.map((step) => <button disabled={busy} key={step.id} onClick={() => void action(step.title, step.path, step.body)}><span>{step.id}</span><div><strong>{step.title}</strong><small>{step.copy}</small></div><b>Chạy →</b></button>)}</div>
      <JsonPanel label="Trạng thái service bảo mật" badge="LIVE" value={secureState} tone="state" />
    </section></details>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
