/**
 * So hai snapshot: status, content-type và body đã chuẩn hoá phải giống hệt nhau.
 *   tsx src/scripts/compare.ts <labelA> <labelB>
 */
import { isDeepStrictEqual } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../evidence/snapshots");

export function compareSnapshots(a: string, b: string) {
  const A = JSON.parse(readFileSync(join(dir, `${a}.json`), "utf8"));
  const B = JSON.parse(readFileSync(join(dir, `${b}.json`), "utf8"));
  const rows = A.cases.map((ca: any) => {
    const cb = B.cases.find((x: any) => x.case === ca.case);
    const sameStatus = ca.status === cb?.status;
    const sameType = ca.contentType === cb?.contentType;
    const sameBody = isDeepStrictEqual(ca.normalized, cb?.normalized);
    // Khác biệt dạng additive: B có thêm key top-level, phần còn lại giống A.
    const ka = Object.keys(ca.normalized ?? {});
    const kb = Object.keys(cb?.normalized ?? {});
    const addedKeys = kb.filter((k) => !ka.includes(k));
    const removedKeys = ka.filter((k) => !kb.includes(k));
    const withoutAdded = Object.fromEntries(Object.entries(cb?.normalized ?? {}).filter(([k]) => !addedKeys.includes(k)));
    const sameIgnoringAdded = removedKeys.length === 0 && isDeepStrictEqual(ca.normalized, withoutAdded);
    return {
      case: ca.case,
      title: ca.title,
      a: { status: ca.status, body: ca.normalized },
      b: { status: cb?.status, body: cb?.normalized },
      sameStatus,
      sameContentType: sameType,
      sameBody,
      addedKeys,
      removedKeys,
      onlyAdditive: !sameBody && sameStatus && sameIgnoringAdded,
      identical: sameStatus && sameType && sameBody,
    };
  });
  const identical = rows.every((r: any) => r.identical);
  const onlyAdditive = !identical && rows.every((r: any) => r.identical || r.onlyAdditive);
  const result = { a, b, comparedAt: new Date().toISOString(), identical, onlyAdditive, rows };
  writeFileSync(join(dir, `compare.${a}__${b}.json`), JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  const [a, b] = process.argv.slice(2);
  const r = compareSnapshots(a, b);
  for (const row of r.rows) {
    console.log(`${row.case.padEnd(12)} status ${row.a.status}→${row.b.status}  body ${row.sameBody ? "giống" : "KHÁC"}  ${row.identical ? "OK" : "FAIL"}`);
  }
  console.log(r.identical ? "IDENTICAL" : "DIFFERENT");
  process.exitCode = r.identical ? 0 : 1;
}
