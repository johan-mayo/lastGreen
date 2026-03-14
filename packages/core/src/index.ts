export * from "./types/index.js";
export { ingestReport, ingestReportFromJson, ingestReportAuto, ingestHtmlReport, ingestZipReport } from "./report-ingest/index.js";
export type { IngestResult } from "./report-ingest/index.js";
export { normalizeReport } from "./report-normalizer/index.js";
export { matchTests } from "./test-matcher/index.js";
export { compareTestPair } from "./compare-engine/index.js";
export type { CompareResult, ErrorComparison } from "./compare-engine/index.js";
export { triageTest } from "./triage-engine/index.js";
