import { readFileSync, writeFileSync } from 'node:fs';
import { transformer } from '@openfga/syntax-transformer';
const source = readFileSync(new URL('../openfga/model.fga', import.meta.url), 'utf8');
const model = transformer.transformDSLToJSONObject(source);
const target = new URL('../openfga/model.json', import.meta.url);
const output = JSON.stringify(model, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('model.json is stale; run npm.cmd run fga:build');
  console.log('OpenFGA DSL/JSON match.');
} else {
  writeFileSync(target, output);
  console.log('Built openfga/model.json');
}
