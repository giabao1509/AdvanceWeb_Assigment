import { env } from "../shared/config";
import { runtimeBuildInfo } from "../shared/build-info";
import { createLogger } from "../shared/log";
import { createApp } from "./app";
import { createGrpcClient } from "./clients/grpc";
import { createRestClient } from "./clients/rest";
import type { InventoryClient } from "./clients/types";

const CLIENT_VERSION = "order-api/2.0.0";
/** Revision proto mà code sinh ra (src/gen) được build từ. */
const PROTO_REV = "v2";
const instance = env("INSTANCE", "order-api");
const transport = env("TRANSPORT", "rest");
const port = Number(env("PORT", "3001"));
const build = runtimeBuildInfo();
const clientVersion = `${CLIENT_VERSION};proto=${PROTO_REV}` + (build.sha256 ? `;bundle=${build.sha256.slice(0, 12)}` : ";source");
const log = createLogger({ svc: "order-api", inst: instance, clientVersion });

let inventory: InventoryClient;
if (transport === "rest") {
  inventory = createRestClient(env("INVENTORY_REST_URL", "http://127.0.0.1:5001"), clientVersion, log);
} else if (transport === "grpc") {
  inventory = createGrpcClient(env("INVENTORY_GRPC_TARGET", "127.0.0.1:50051"), clientVersion, log);
} else {
  throw new Error(`Unknown TRANSPORT=${transport}`);
}

const info = () => ({ instance, clientVersion, protoRev: PROTO_REV, transport: inventory.transport, target: inventory.target, build });
createApp({ inventory, log, info }).listen(port, "127.0.0.1", () => {
  log("started", { pid: process.pid, port, transport: inventory.transport, target: inventory.target, build });
});
