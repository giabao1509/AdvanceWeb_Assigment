// Đối chiếu dữ liệu cho cả hai loại client (decisions.md mục 8). Ghi results/verify.json.
// Chạy: npm run verify
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR, ROOT } from '../shared/config.js';
import { launchBrowser, loadScreen } from './browser.js';
import { Stack, ensureClient, setFault } from './stack.js';

const USERS = ['u_small', 'u_large'];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = `logs/verify-${stamp}`;
const checks = [];

// ---------- Ground truth đọc thẳng từ 3 DB ----------
const open = (f) => new Database(path.join(DATA_DIR, f), { readonly: true, fileMustExist: true });
const userDb = open('user.db');
const orderDb = open('order.db');
const productDb = open('product.db');
const productRows = new Map(
  productDb.prepare('SELECT id, name, price, thumbnail_url AS thumbnailUrl FROM products').all().map((p) => [p.id, p]),
);

function expectedWeb(userId) {
  const user = userDb.prepare('SELECT id, name, email, avatar_url AS avatarUrl FROM users WHERE id = ?').get(userId);
  const orders = orderDb
    .prepare(
      `SELECT id, status, total_amount AS totalAmount, shipping_address AS shippingAddress, note, created_at AS createdAt
         FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId);
  const itemsOf = orderDb.prepare('SELECT line_no AS lineNo, product_id AS productId, quantity FROM order_items WHERE order_id = ? ORDER BY line_no');
  return {
    user,
    orders: orders.map((o) => ({
      ...o,
      items: itemsOf.all(o.id).map((it) => ({ lineNo: it.lineNo, quantity: it.quantity, product: { ...productRows.get(it.productId) } })),
    })),
  };
}

// Phép chiếu web -> các trường mobile cần.
const projectMobile = (web) => ({
  orders: web.orders.map((o) => ({
    id: o.id,
    status: o.status,
    items: o.items.map((it) => ({ product: it.product && { name: it.product.name, thumbnailUrl: it.product.thumbnailUrl } })),
  })),
});

// ---------- So sánh ----------
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

function firstDiff(a, b, p = '$') {
  if (same(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${p}.${k}`);
      if (d) return d;
    }
  }
  return { path: p, actual: JSON.stringify(a)?.slice(0, 200), expected: JSON.stringify(b)?.slice(0, 200) };
}

function check(id, description, pass, details = {}) {
  checks.push({ id, description, pass, ...details });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${description}`);
  if (!pass) console.log('      ', JSON.stringify(details).slice(0, 400));
}

// Whitelist khoá chính xác cho response mobile (mục 8.2).
function mobileKeyViolations(orders) {
  const out = [];
  const exact = (obj, keys, where) => {
    const got = Object.keys(obj).sort().join(',');
    if (got !== [...keys].sort().join(',')) out.push(`${where}: {${got}}`);
  };
  orders.forEach((o, i) => {
    exact(o, ['id', 'status', 'items'], `orders[${i}]`);
    o.items.forEach((it, j) => {
      exact(it, ['product'], `orders[${i}].items[${j}]`);
      if (it.product) exact(it.product, ['name', 'thumbnailUrl'], `orders[${i}].items[${j}].product`);
    });
  });
  return out;
}

// Mục 8.4: mọi product hoặc đúng bằng bản ghi DB ở cùng vị trí, hoặc null kèm lỗi có path tương ứng (và ngược lại).
// expectedModel: ground truth cùng shape với model (web hoặc phép chiếu mobile).
function noFakeValues(model, errors, expectedModel) {
  const problems = [];
  const errorPaths = new Set(errors.map((e) => JSON.stringify(e.path)));
  let nulls = 0;
  model.orders.forEach((o, i) =>
    o.items.forEach((it, j) => {
      const p = JSON.stringify(['orders', i, 'items', j, 'product']);
      if (it.product === null) {
        nulls++;
        if (!errorPaths.has(p)) problems.push(`${p}: null nhưng không có lỗi`);
        errorPaths.delete(p);
      } else if (!same(it.product, expectedModel.orders[i]?.items[j]?.product)) {
        problems.push(`${p}: giá trị khác product.db`);
      }
    }),
  );
  for (const p of errorPaths) problems.push(`${p}: có lỗi nhưng product không null`);
  return { problems, nulls };
}

const stripProducts = (web) => ({
  user: web.user,
  orders: web.orders.map((o) => ({ ...o, items: o.items.map(({ lineNo, quantity }) => ({ lineNo, quantity })) })),
});
const errorKey = (errors) => errors.map((e) => `${JSON.stringify(e.path)}:${e.extensions?.code}`).sort();

// ---------- Chạy ----------
const client = await ensureClient({ logDir: LOG_DIR });
const stack = new Stack({ productLoader: 'batched', enableFault: true, logDir: LOG_DIR });
const { browser, name: browserName } = await launchBrowser();
const screen = (page, variant, user) => loadScreen(browser, { page, variant, user, rid: crypto.randomUUID() }).then((r) => r.screen);

try {
  await stack.start();

  for (const user of USERS) {
    const expected = expectedWeb(user);
    // 8.1 Web: baseline, BFF, GraphQL batched đều bằng ground truth.
    for (const variant of ['baseline', 'bff', 'graphql']) {
      const s = await screen('web', variant, user);
      check(`web.${variant}.${user}`, `Web ${variant} (${user}) bằng dữ liệu đọc thẳng từ DB`, s.status === 'ok' && same(s.model, expected), {
        status: s.status,
        diff: firstDiff(s.model, expected),
      });
    }

    // 8.2 + 8.3 Mobile: whitelist khoá, BFF = GraphQL, mobile = phép chiếu của web.
    const mob = {};
    for (const variant of ['bff', 'graphql']) {
      const s = await screen('mobile', variant, user);
      const body = s.raw[0]?.body;
      const topKeys = variant === 'bff' ? Object.keys(body ?? {}) : Object.keys(body?.data ?? {});
      const orders = variant === 'bff' ? body?.orders : body?.data?.ordersByUser;
      const violations = orders ? mobileKeyViolations(orders) : ['không có orders'];
      const topOk = variant === 'bff' ? same(topKeys, ['orders']) : same(topKeys, ['ordersByUser']) && !body.errors;
      check(`mobile.${variant}.${user}.fields`, `Mobile ${variant} (${user}) chỉ chứa {id,status,items[{product{name,thumbnailUrl}}]}`, s.status === 'ok' && topOk && violations.length === 0, {
        topKeys,
        violations: violations.slice(0, 5),
        violationCount: violations.length,
      });
      mob[variant] = s.model;
    }
    check(`mobile.bff=graphql.${user}`, `Mobile BFF và GraphQL (${user}) trả cùng dữ liệu`, same(mob.bff, mob.graphql), { diff: firstDiff(mob.bff, mob.graphql) });
    check(`mobile⊂web.${user}`, `Mobile (${user}) bằng phép chiếu của web lên trường mobile`, same(mob.bff, projectMobile(expected)), {
      diff: firstDiff(mob.bff, projectMobile(expected)),
    });
  }

  // Thất bại toàn bộ khi user không tồn tại: BFF và GraphQL cùng USER_NOT_FOUND.
  for (const variant of ['bff', 'graphql']) {
    const s = await screen('web', variant, 'u_missing');
    const code = s.errors?.[0]?.extensions?.code;
    check(`web.${variant}.u_missing`, `Web ${variant}: user không tồn tại thì màn hình lỗi USER_NOT_FOUND`, s.status === 'error' && code === 'USER_NOT_FOUND', { status: s.status, code });
  }

  // GraphQL naive phải trả cùng dữ liệu với bản batched (chỉ khác số call).
  await stack.restart({ productLoader: 'naive' });
  for (const user of USERS) {
    const expected = expectedWeb(user);
    const w = await screen('web', 'graphql', user);
    check(`web.graphql-naive.${user}`, `Web GraphQL naive (${user}) bằng dữ liệu từ DB`, w.status === 'ok' && same(w.model, expected), { status: w.status, diff: firstDiff(w.model, expected) });
    const m = await screen('mobile', 'graphql', user);
    check(`mobile.graphql-naive.${user}`, `Mobile GraphQL naive (${user}) bằng phép chiếu của web`, m.status === 'ok' && same(m.model, projectMobile(expected)), {
      status: m.status,
      diff: firstDiff(m.model, projectMobile(expected)),
    });
  }

  // 8.4 Product chậm/lỗi: policy P2, không có giá trị giả, BFF và GraphQL đánh dấu lỗi giống nhau.
  await stack.restart({ productLoader: 'batched' });
  const user = 'u_small';
  const expected = expectedWeb(user);
  const scenarios = [
    { id: 'delay300', mode: 'delay', delayMs: 300, expectStatus: 'ok' },
    { id: 'delay3000', mode: 'delay', delayMs: 3000, expectStatus: 'partial', code: 'PRODUCT_TIMEOUT' },
    { id: 'error500', mode: 'error', expectStatus: 'partial', code: 'PRODUCT_UNAVAILABLE' },
    { id: 'hang', mode: 'hang', expectStatus: 'partial', code: 'PRODUCT_TIMEOUT' },
  ];
  for (const sc of scenarios) {
    await setFault(sc.mode, sc.delayMs ?? 0);
    for (const page of ['web', 'mobile']) {
      const got = {};
      for (const variant of ['bff', 'graphql']) {
        const s = await screen(page, variant, user);
        got[variant] = s;
        const truth = page === 'web' ? expected : projectMobile(expected);
        const { problems, nulls } = noFakeValues(s.model ?? { orders: [] }, s.errors ?? [], truth);
        const codes = [...new Set((s.errors ?? []).map((e) => e.extensions?.code))];
        const codeOk = sc.code ? same(codes, [sc.code]) : codes.length === 0;
        // Phần không phụ thuộc Product (user, đơn, số dòng) phải còn nguyên.
        const shapeOf = (m) => m.orders.map((o) => [o.id, o.status, o.items.length]);
        const restOk =
          s.model !== null &&
          (page === 'web' ? same(stripProducts(s.model), stripProducts(expected)) : same(shapeOf(s.model), shapeOf(expected)));
        check(
          `fault.${sc.id}.${page}.${variant}`,
          `${sc.id}: ${page} ${variant} status=${sc.expectStatus}, user/đơn vẫn đủ, không có tên/giá giả`,
          s.status === sc.expectStatus && codeOk && problems.length === 0 && restOk,
          { status: s.status, codes, nullProducts: nulls, problems: problems.slice(0, 5), restOk },
        );
      }
      check(
        `fault.${sc.id}.${page}.bff=graphql`,
        `${sc.id}: ${page} BFF và GraphQL đánh dấu lỗi cùng path và mã`,
        same(errorKey(got.bff.errors ?? []), errorKey(got.graphql.errors ?? [])) && same(got.bff.model, got.graphql.model),
        { bffErrors: (got.bff.errors ?? []).length, graphqlErrors: (got.graphql.errors ?? []).length },
      );
    }
  }
  await setFault('none');
} finally {
  await browser.close();
  await stack.stop();
  await client?.stop();
}

const passed = checks.filter((c) => c.pass).length;
const report = { generatedAt: new Date().toISOString(), browser: browserName, logDir: LOG_DIR, passed, failed: checks.length - passed, checks };
fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'verify.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${passed}/${checks.length} kiểm tra đạt. Chi tiết: results/verify.json`);
process.exit(passed === checks.length ? 0 : 1);
