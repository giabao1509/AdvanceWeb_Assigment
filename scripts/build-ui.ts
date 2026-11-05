import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildUI() {
  for(const name of ['app','log-format']){
    const source = new URL(`../public/${name}.ts`, import.meta.url);
    const result = ts.transpileModule(readFileSync(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
    writeFileSync(new URL(`../public/${name}.js`, import.meta.url), result.outputText);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildUI();
