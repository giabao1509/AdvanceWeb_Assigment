// GraphQL (decisions.md mục 4.6): một endpoint, hai query cố định.
import { ScreenError, URLS, fetchJson, withRid } from './http.js';

export const WEB_DASHBOARD = /* GraphQL */ `
  query WebDashboard($id: ID!) {
    user(id: $id) {
      id
      name
      email
      avatarUrl
      orders {
        id
        status
        totalAmount
        shippingAddress
        note
        createdAt
        items {
          lineNo
          quantity
          product { id name price thumbnailUrl }
        }
      }
    }
  }
`;

export const MOBILE_ORDERS = /* GraphQL */ `
  query MobileOrders($id: ID!) {
    ordersByUser(userId: $id) {
      id
      status
      items {
        product { name thumbnailUrl }
      }
    }
  }
`;

async function post(rid, query, operationName, variables, raw) {
  return fetchJson(withRid(`${URLS.graphql}/graphql`, rid), raw, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, operationName, variables }),
  });
}

// Bỏ tiền tố root khỏi path để so được với BFF: ["user","orders",3,...] -> ["orders",3,...].
const normalizeErrors = (errors, mapPath) =>
  (errors ?? []).map(({ message, path, extensions }) => ({ message, path: mapPath(path ?? []), extensions }));

function fatal(json) {
  const first = json.errors?.[0];
  return new ScreenError(first?.extensions?.code || 'GRAPHQL_ERROR', first?.message);
}

export async function loadWeb(userId, rid) {
  const raw = [];
  const json = await post(rid, WEB_DASHBOARD, 'WebDashboard', { id: userId }, raw);
  const user = json.data?.user;
  if (!user) throw fatal(json);
  const { orders, ...profile } = user;
  return { model: { user: profile, orders }, errors: normalizeErrors(json.errors, (p) => p.slice(1)), raw };
}

export async function loadMobile(userId, rid) {
  const raw = [];
  const json = await post(rid, MOBILE_ORDERS, 'MobileOrders', { id: userId }, raw);
  const orders = json.data?.ordersByUser;
  if (!orders) throw fatal(json);
  return { model: { orders }, errors: normalizeErrors(json.errors, (p) => ['orders', ...p.slice(1)]), raw };
}
