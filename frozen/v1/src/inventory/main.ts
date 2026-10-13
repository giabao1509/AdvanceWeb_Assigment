import { env } from "../shared/config";
import { runtimeBuildInfo } from "../shared/build-info";
import { createLogger } from "../shared/log";
import { startGrpcServer } from "./grpc-server";
import { startRestServer } from "./rest-server";
import { Store } from "./store";

const SERVER_VERSION = "inventory/1.0.0";
const PROTO_REV = "v1";
const instance = env("INSTANCE", "inventory");
const build = runtimeBuildInfo();
const log = createLogger({ svc: "inventory", inst: instance, server: `${SERVER_VERSION};proto=${PROTO_REV}` });
const store = new Store();

const info = () => ({ instance, serverVersion: SERVER_VERSION, protoRev: PROTO_REV, build });
startRestServer({ port: Number(env("REST_PORT", "5001")), store, log, info });
startGrpcServer({ port: Number(env("GRPC_PORT", "50051")), store, log });
log("started", { pid: process.pid, build });
