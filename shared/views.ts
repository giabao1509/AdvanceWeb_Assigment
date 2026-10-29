import { escape } from './http.js';
export function page(title: string, mode: string, body: string) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Wallet Lab</title><link rel="stylesheet" href="/style.css"></head><body class="auth-page"><main class="auth-shell"><a class="wordmark" href="/">◈ WALLET LAB <span>${mode === 'secure' ? 'FULL SECURITY' : 'BASELINE'}</span></a>${body}<p class="muted small">Wallet AS xác thực người dùng và xin quyền. Mật khẩu ví không được gửi cho Taxi.</p></main></body></html>`;
}
export function hidden(name: string, value: string) { return `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`; }
