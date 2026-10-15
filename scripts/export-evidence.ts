import { runEvidenceSuite, writeEvidence } from '../src/testing/evidence.js';

try {
  const evidence = await runEvidenceSuite();
  writeEvidence(evidence);
  const passed = evidence.results.filter((result) => result.pass).length;
  console.log(JSON.stringify({ passed, total: evidence.results.length, results: evidence.results }, null, 2));
  if (passed !== evidence.results.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
