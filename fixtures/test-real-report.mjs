/**
 * Quick smoke test: ingest the real Playwright report zip.
 * Run: node fixtures/test-real-report.mjs <path-to-zip>
 */
import { readFile } from "node:fs/promises";
import { ingestReportAuto, normalizeReport, matchTests, compareTestPair, triageTest } from "@last-green/core";

const zipPath = process.argv[2];
if (!zipPath) {
  console.error("Usage: node fixtures/test-real-report.mjs <path-to-zip>");
  process.exit(1);
}

const buffer = await readFile(zipPath);
console.log(`Read ${Math.round(buffer.length / 1024)}KB from ${zipPath}`);

const ingest = await ingestReportAuto(buffer, zipPath, "/tmp/lastgreen-test");
console.log(`Ingested: ${ingest.sourcePath}`);

const run = normalizeReport(ingest);
console.log(`\nRun: ${run.id}`);
console.log(`  Tests: ${run.stats.total}`);
console.log(`  Passed: ${run.stats.passed}`);
console.log(`  Failed: ${run.stats.failed}`);
console.log(`  Flaky: ${run.stats.flaky}`);
console.log(`  Skipped: ${run.stats.skipped}`);
console.log(`  Duration: ${Math.round(run.duration / 1000)}s`);
if (run.commitSha) console.log(`  Commit: ${run.commitSha}`);
if (run.branch) console.log(`  Branch: ${run.branch}`);

// Compare against itself (no passing run)
const comparison = matchTests(run, null);
console.log(`\nMatched failing tests: ${comparison.matchedTests.length}`);

// Triage each
for (const match of comparison.matchedTests.slice(0, 5)) {
  const cr = compareTestPair(match);
  const triage = triageTest(cr);
  console.log(`\n  ${triage.testCase.fullTitle}`);
  console.log(`    Category: ${triage.category} (${triage.confidence})`);
  console.log(`    ${triage.summary.slice(0, 120)}`);
  if (triage.firstDivergence) {
    console.log(`    Divergence: ${triage.firstDivergence.description.slice(0, 100)}`);
  }
}

console.log("\nDone.");
