// Mở trình duyệt cho Playwright và chạy một lần tải màn hình.
import { chromium } from 'playwright';
import { PORTS } from '../shared/config.js';

// Ưu tiên Chromium của Playwright. Nếu chưa tải (npx playwright install chromium) thì dùng Edge/Chrome có sẵn.
export async function launchBrowser() {
  const channels = process.env.BROWSER_CHANNEL ? [process.env.BROWSER_CHANNEL] : [undefined, 'msedge', 'chrome'];
  let lastErr;
  for (const channel of channels) {
    try {
      const browser = await chromium.launch(channel ? { channel } : {});
      return { browser, name: `${channel ?? 'chromium'} ${browser.version()}` };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const CLIENT = `http://localhost:${PORTS.client}`;
const DATA_PORTS = new Set([PORTS.user, PORTS.order, PORTS.product, PORTS.bff, PORTS.graphql].map(String));

// Một lần tải màn hình trong context mới. Trả về số liệu phía client.
export async function loadScreen(browser, { page: pageName, variant, user, rid, throttleMs = 0, screenshot = null }) {
  const isMobile = pageName === 'mobile';
  const context = await browser.newContext({
    viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    if (throttleMs > 0) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: throttleMs,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    }

    const finished = [];
    const failed = [];
    page.on('requestfinished', (r) => finished.push(r));
    page.on('requestfailed', (r) => failed.push(r));

    const url = `${CLIENT}/${pageName}.html?variant=${variant}&user=${user}&rid=${rid}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__done === true, null, { timeout: 60_000 });

    const screen = await page.evaluate(() => {
      const mark = (n) => performance.getEntriesByName(n, 'mark')[0];
      const sc = mark('screen-complete');
      return {
        timeOrigin: performance.timeOrigin,
        dataStart: mark('data-start').startTime,
        screenComplete: sc.startTime,
        imagesComplete: mark('images-complete')?.startTime ?? null,
        detail: sc.detail,
        status: window.__screenStatus,
        model: window.__screenData,
        errors: window.__screenErrors,
        raw: window.__raw,
        resources: performance.getEntriesByType('resource').map((r) => ({
          name: r.name,
          initiatorType: r.initiatorType,
          startTime: r.startTime,
          responseEnd: r.responseEnd,
          encodedBodySize: r.encodedBodySize,
        })),
      };
    });

    const dataRequests = [];
    let staticRequests = 0;
    for (const req of finished) {
      const u = new URL(req.url());
      if (!DATA_PORTS.has(u.port)) {
        staticRequests++;
        continue;
      }
      const res = await req.response();
      const body = res ? await res.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
      dataRequests.push({ method: req.method(), url: req.url(), status: res?.status() ?? null, body });
    }
    for (const req of failed) {
      if (DATA_PORTS.has(new URL(req.url()).port)) dataRequests.push({ method: req.method(), url: req.url(), status: null, body: Buffer.alloc(0), failure: req.failure()?.errorText });
    }

    if (screenshot) await page.screenshot({ path: screenshot, fullPage: false });
    return { screen, dataRequests, staticRequests };
  } finally {
    await context.close();
  }
}
