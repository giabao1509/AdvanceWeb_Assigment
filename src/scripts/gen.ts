/**
 * Sinh code TypeScript từ proto bằng protoc (npm grpc-tools) + plugin ts-proto.
 * Ghi lại lệnh, output và hash file sinh ra vào evidence/codegen/<label>.txt.
 *
 *   tsx src/scripts/gen.ts <label> [protoFile] [outDir]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(__dirname, "../..");
const [label = "manual", protoFile = "proto/inventory.proto", outDir = "src/gen"] = process.argv.slice(2);

// Đường dẫn tương đối + gọi thẳng protoc (không qua shell): thư mục dự án có dấu cách và ký tự Unicode.
const win = process.platform === "win32";
const protoc = join(root, "node_modules/grpc-tools/bin", win ? "protoc.exe" : "protoc");
// protoc chạy plugin .cmd qua cmd.exe → bắt buộc dùng backslash.
const plugin = win ? String.raw`node_modules\.bin\protoc-gen-ts_proto.cmd` : "node_modules/.bin/protoc-gen-ts_proto";
const args = [
  `--plugin=protoc-gen-ts_proto=${plugin}`,
  `--ts_proto_out=${outDir}`,
  "--ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,useDate=true,env=node",
  `-I`,
  dirname(protoFile),
  // Well-known types (google/protobuf/timestamp.proto) đi kèm grpc-tools, protoc không tự tìm thấy.
  `-I`,
  "node_modules/grpc-tools/bin",
  protoFile,
];

rmSync(join(root, outDir), { recursive: true, force: true });
mkdirSync(join(root, outDir), { recursive: true });

const cmd = `node_modules/grpc-tools/bin/protoc ${args.join(" ")}`;
const t0 = performance.now();
const r = spawnSync(protoc, args, { cwd: root, encoding: "utf8" });
const elapsed = Math.round(performance.now() - t0);

const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(join(root, outDir));

const report = [
  `# codegen ${label}`,
  `at: ${new Date().toISOString()}`,
  `proto: ${protoFile}  sha256=${sha(join(root, protoFile))}`,
  `$ ${cmd}`,
  `exit: ${r.status}  (${elapsed} ms)`,
  `stdout: ${r.stdout?.trim() || "(empty)"}`,
  `stderr: ${r.stderr?.trim() || "(empty)"}`,
  `generated:`,
  ...files.map((f) => `  ${relative(root, f).replaceAll("\\", "/")}  ${statSync(f).size} B  sha256=${sha(f).slice(0, 16)}`),
].join("\n");

mkdirSync(join(root, "evidence/codegen"), { recursive: true });
writeFileSync(join(root, `evidence/codegen/${label}.txt`), report + "\n");
console.log(report);
process.exitCode = r.status ?? 1;

function sha(p: string) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
