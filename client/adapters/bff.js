// BFF (decisions.md mục 4.5): mỗi loại client một endpoint, 1 request.
import { URLS, fetchJson, withRid } from './http.js';

const enc = encodeURIComponent;

export async function loadWeb(userId, rid) {
  const raw = [];
  const body = await fetchJson(withRid(`${URLS.bff}/bff/web/dashboard/${enc(userId)}`, rid), raw);
  return { model: { user: body.user, orders: body.orders }, errors: body.errors ?? [], raw };
}

export async function loadMobile(userId, rid) {
  const raw = [];
  const body = await fetchJson(withRid(`${URLS.bff}/bff/mobile/orders/${enc(userId)}`, rid), raw);
  return { model: { orders: body.orders }, errors: body.errors ?? [], raw };
}
