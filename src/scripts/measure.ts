/**
 * Đo payload chặng nội bộ Order API → Inventory, dùng CHÍNH client mà Order API dùng.
 *   Bảng 1 – message đã serialize: REST = byte UTF-8 của HTTP body JSON; gRPC = byte protobuf của message.
 *   Bảng 2 – wire bytes: TCP proxy đếm byte ứng dụng trên socket mỗi chiều (không gồm TCP/IP header).
 *   Bảng 3 – thời gian phản hồi: nội bộ và end-to-end, N lần sau warm-up, median + min–max.
 * Cần inventory-v2 (5001/50051), order-rest (3001), order-grpc-v2 (3003) đang chạy.
 *
 *   tsx src/scripts/measure.ts
 */
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { createGrpcClient } from "../order-api/clients/grpc";
import { createRestClient } from "../order-api/clients/rest";
import type { InventoryClient } from "../order-api/clients/types";
import { createGrpcClient as createGrpcClientV1 } from "../../frozen/v1/src/order-api/clients/grpc";

const N = 7;
const ADMIN = "http://127.0.0.1:5001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reset = () => fetch(`${ADMIN}/admin/reset`, { method: "POST" });

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { n: s.length, median: round(median), min: round(s[0]), max: round(s[s.length - 1]) };
}
const round = (x: number) => Math.round(x * 100) / 100;

/** TCP proxy đếm byte. up = Order API → Inventory, down = Inventory → Order API. */
function startProxy(targetPort: number): Promise<{ port: number; c: { up: number; down: number; conns: number }; close: () => void }> {
  const c = { up: 0, down: 0, conns: 0 };
  const server = net.createServer((client) => {
    c.conns++;
    const upstream = net.connect(targetPort, "127.0.0.1");
    client.on("data", (d) => {
      c.up += d.length;
      upstream.write(d);
    });
    upstream.on("data", (d) => {
      c.down += d.length;
      client.write(d);
    });
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("close", end).on("error", end);
    upstream.on("close", end).on("error", end);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, c, close: () => server.close() })),
  );
}

type Captured = Record<string, any>;
function capturingLog() {
  const box: { last?: Captured } = {};
  return { box, log: (event: string, f: Record<string, unknown> = {}) => event === "inventory.call" && (box.last = f) };
}

async function callOnce(client: InventoryClient, quantity: number) {
  try {
    await client.reserve("SKU-001", quantity);
  } catch {
    /* lỗi nghiệp vụ là kết quả mong đợi ở case thiếu hàng */
  }
}

async function wireAndMessage(name: string, make: (target: string, log: any) => InventoryClient, targetPort: number, restStyle: boolean) {
  const px = await startProxy(targetPort);
  const { box, log } = capturingLog();
  const client = make(restStyle ? `http://127.0.0.1:${px.port}` : `127.0.0.1:${px.port}`, log);
  const result: Record<string, any> = {};
  for (const [caseName, qty] of [["du-hang", 2], ["thieu-hang", 10]] as const) {
    const calls = [];
    for (let i = 0; i < N + 1; i++) {
      await reset();
      const before = { ...px.c };
      await callOnce(client, qty);
      await sleep(60); // gom các frame đến trễ (WINDOW_UPDATE, SETTINGS ACK…)
      const f = box.last!;
      calls.push({
        up: px.c.up - before.up,
        down: px.c.down - before.down,
        reqMsg: restStyle ? f.reqBodyBytes : f.reqMsgBytes,
        resMsg: restStyle ? f.resBodyBytes : f.outcome === "RESERVED" ? f.resMsgBytes : 0,
        unknownFieldBytes: f.unknownFieldBytes,
        outcome: f.outcome,
      });
    }
    // Lời gọi đầu tiên của case đầu tiên mở kết nối mới (cold).
    const warm = calls.slice(1);
    result[caseName] = {
      outcome: calls[1].outcome,
      message: { request: stats(warm.map((x) => x.reqMsg)), response: stats(warm.map((x) => x.resMsg)), unknownFieldBytes: restStyle ? null : stats(warm.map((x) => x.unknownFieldBytes ?? 0)) },
      wire: {
        cold: caseName === "du-hang" ? { up: calls[0].up, down: calls[0].down, total: calls[0].up + calls[0].down } : null,
        warmUp: stats(warm.map((x) => x.up)),
        warmDown: stats(warm.map((x) => x.down)),
        warmTotal: stats(warm.map((x) => x.up + x.down)),
      },
    };
  }
  result.connections = px.c.conns;
  px.close();
  console.log(`${name}: ${JSON.stringify(result)}`);
  return result;
}

async function latencyInternal(client: InventoryClient, box: { last?: Captured }) {
  for (let i = 0; i < 2; i++) {
    await reset();
    await callOnce(client, 2);
  }
  const xs: number[] = [];
  for (let i = 0; i < N; i++) {
    await reset();
    await callOnce(client, 2);
    xs.push(box.last!.durationMs);
  }
  return stats(xs);
}

async function latencyE2E(url: string) {
  const one = async () => {
    await reset();
    const t0 = performance.now();
    const r = await fetch(`${url}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sku: "SKU-001", quantity: 2 }) });
    await r.text();
    return performance.now() - t0;
  };
  await one();
  await one();
  const xs = [];
  for (let i = 0; i < N; i++) xs.push(await one());
  return stats(xs);
}

async function main() {
  const v = "measure/1.0.0";
  const rest = await wireAndMessage("REST", (t, log) => createRestClient(t, v, log), 5001, true);
  const grpcV2 = await wireAndMessage("gRPC v2", (t, log) => createGrpcClient(t, v, log), 50051, false);
  const grpcV1 = await wireAndMessage("gRPC v1 client", (t, log) => createGrpcClientV1(t, v, log), 50051, false);

  const r = capturingLog();
  const g = capturingLog();
  const latency = {
    internal: {
      rest: await latencyInternal(createRestClient("http://127.0.0.1:5001", v, r.log), r.box),
      grpc: await latencyInternal(createGrpcClient("127.0.0.1:50051", v, g.log), g.box),
    },
    endToEnd: {
      rest: await latencyE2E("http://127.0.0.1:3001"),
      grpc: await latencyE2E("http://127.0.0.1:3003"),
    },
  };
  await reset();

  const out = {
    takenAt: new Date().toISOString(),
    runsPerCase: N,
    environment: { node: process.version, platform: `${process.platform} ${process.arch}`, host: "127.0.0.1 (loopback, cùng máy)" },
    method: {
      message: "REST: Buffer.byteLength của HTTP request/response body JSON. gRPC: độ dài Buffer trong requestSerialize/responseDeserialize (protobuf message, không gồm 5 byte length-prefix, frame HTTP/2, header).",
      wire: "TCP proxy (node:net) chen giữa client và Inventory, cộng byte đọc được trên socket mỗi chiều cho từng lời gọi. Gồm header HTTP/1.1 hoặc frame HTTP/2 + HPACK + trailers; không gồm TCP/IP header, không gồm bắt tay TCP. Cold = lời gọi đầu trên kết nối mới.",
      latency: "Loopback cùng máy. Nội bộ = durationMs client tự đo quanh lời gọi Inventory. End-to-end = fetch POST /orders tới Order API. 2 lần warm-up bỏ đi, sau đó N lần; reset fixture trước mỗi lần (không tính giờ).",
    },
    rest,
    grpcV2,
    grpcV1,
    latency,
  };
  writeFileSync(join(__dirname, "../../evidence/payload.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(latency));
  console.log("→ evidence/payload.json");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
