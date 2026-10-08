// Mã lỗi và message dùng chung cho BFF và GraphQL.

export const MESSAGES = {
  PRODUCT_TIMEOUT: 'Product Service không phản hồi trong thời gian cho phép',
  PRODUCT_UNAVAILABLE: 'Product Service lỗi hoặc không truy cập được',
  PRODUCT_NOT_FOUND: 'Không tìm thấy product',
  USER_NOT_FOUND: 'Không tìm thấy user',
  UPSTREAM_USER_TIMEOUT: 'User Service không phản hồi trong thời gian cho phép',
  UPSTREAM_USER_FAILED: 'User Service lỗi hoặc không truy cập được',
  UPSTREAM_ORDER_TIMEOUT: 'Order Service không phản hồi trong thời gian cho phép',
  UPSTREAM_ORDER_FAILED: 'Order Service lỗi hoặc không truy cập được',
};

export class UpstreamError extends Error {
  // kind: 'timeout' | 'unavailable' | 'http'
  constructor(target, kind, status = null, detail = '') {
    super(`${target} ${kind}${status ? ` ${status}` : ''}${detail ? `: ${detail}` : ''}`);
    this.target = target;
    this.kind = kind;
    this.status = status;
  }
}

// Lỗi khi gọi Product: chỉ làm hỏng field product (policy P2).
export function productErrorCode(err) {
  return err instanceof UpstreamError && err.kind === 'timeout' ? 'PRODUCT_TIMEOUT' : 'PRODUCT_UNAVAILABLE';
}

// Lỗi khi gọi User/Order: thất bại toàn bộ. Trả về { httpStatus, code }.
export function fatalUpstream(target, err) {
  const T = target.toUpperCase();
  if (err instanceof UpstreamError && err.kind === 'timeout') return { httpStatus: 504, code: `UPSTREAM_${T}_TIMEOUT` };
  return { httpStatus: 502, code: `UPSTREAM_${T}_FAILED` };
}
