/**
 * Đóng băng client cũ / server cũ: bundle source đã chụp ở frozen/v1 (proto v1) thành 1 file .cjs.
 * Chạy MỘT lần trước khi thêm field. Sau đó KHÔNG chạy lại — dashboard so hash lúc chạy với build-info.json.
 *
 *   tsx src/scripts/build-v1.ts
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const frozen = join(root, "frozen/v1");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

async function main() {
  if (existsSync(join(root, "builds/build-info.json")) && !process.argv.includes("--force")) {
    console.error("builds/build-info.json đã tồn tại: client cũ đã được build, không build lại.");
    process.exit(1);
  }
  const protoSha256 = sha(join(frozen, "proto/inventory.proto"));
  const builtAt = new Date().toISOString();
  const targets = [
    { name: "order-api-v1", entry: "src/order-api/main.ts" },
    { name: "inventory-v1", entry: "src/inventory/main.ts" },
  ];
  const out: Record<string, unknown> = { builtAt, proto: "frozen/v1/proto/inventory.proto", protoSha256, bundles: {} };
  for (const t of targets) {
    const outfile = join(root, "builds", `${t.name}.cjs`);
    await build({
      entryPoints: [join(frozen, t.entry)],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      outfile,
      define: { __BUILD_INFO__: JSON.stringify({ builtAt, protoSha256 }) },
      logLevel: "info",
    });
    (out.bundles as any)[t.name] = { file: `builds/${t.name}.cjs`, sha256: sha(outfile), bytes: readFileSync(outfile).length };
  }
  writeFileSync(join(root, "builds/build-info.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main();
