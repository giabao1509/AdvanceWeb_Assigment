import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Khi chạy từ bundle đóng băng (builds/*.cjs), esbuild thay __BUILD_INFO__ bằng thông tin lúc build.
 * Khi chạy từ source, giá trị là undefined.
 */
declare const __BUILD_INFO__: { builtAt: string; protoSha256: string } | undefined;

export function runtimeBuildInfo() {
  const frozen = typeof __BUILD_INFO__ !== "undefined" ? __BUILD_INFO__ : undefined;
  const file = isBundleFile() ? __filename : process.argv[1];
  const isBundle = isBundleFile();
  const sha256 = isBundle ? createHash("sha256").update(readFileSync(file)).digest("hex") : undefined;
  return { file, isBundle, sha256, builtAt: frozen?.builtAt, protoSha256: frozen?.protoSha256 };
}
const isBundleFile = () => __filename.endsWith(".cjs");
