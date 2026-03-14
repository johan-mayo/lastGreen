import JSZip from "jszip";
import type { PlaywrightJsonReport, PlaywrightSuite, PlaywrightSpec, PlaywrightTest, PlaywrightTestResult, PlaywrightStep, PlaywrightAttachment, PlaywrightError } from "../types/index.js";
import type { IngestResult } from "./index.js";

// ---- HTML report embedded data types ----

interface HtmlReportJson {
  metadata?: Record<string, unknown>;
  startTime: number | string;
  duration: number;
  files: HtmlReportFile[];
  projectNames: string[];
  stats: {
    total: number;
    expected: number;
    unexpected: number;
    flaky: number;
    skipped: number;
    ok: boolean;
  };
  errors: unknown[];
  options?: Record<string, unknown>;
}

interface HtmlReportFile {
  fileId: string;
  fileName: string;
  tests: HtmlReportTestSummary[];
  stats?: Record<string, unknown>;
}

interface HtmlReportTestSummary {
  testId: string;
  title: string;
  projectName: string;
  location: { file: string; line: number; column: number };
  duration: number;
  annotations: unknown[];
  tags: string[];
  outcome: "expected" | "unexpected" | "flaky" | "skipped";
  path: string[];
  ok: boolean;
  results?: HtmlReportResult[];
}

interface HtmlReportDetailFile {
  fileId: string;
  fileName: string;
  tests: HtmlReportTestDetail[];
}

interface HtmlReportTestDetail {
  testId: string;
  title: string;
  projectName: string;
  location: { file: string; line: number; column: number };
  duration: number;
  annotations: unknown[];
  tags: string[];
  outcome: "expected" | "unexpected" | "flaky" | "skipped";
  path: string[];
  results: HtmlReportResult[];
  ok: boolean;
}

interface HtmlReportResult {
  duration: number;
  startTime: string;
  retry: number;
  steps: HtmlReportStep[];
  errors: HtmlReportError[];
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  annotations: unknown[];
  attachments: HtmlReportAttachment[];
}

interface HtmlReportStep {
  title: string;
  startTime: string;
  duration: number;
  steps: HtmlReportStep[];
  attachments: HtmlReportAttachment[];
  count: number;
  skipped: boolean;
  error?: HtmlReportError;
}

interface HtmlReportError {
  message: string;
  stack?: string;
  value?: string;
  snippet?: string;
  location?: { file: string; line: number; column: number };
}

interface HtmlReportAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: string;
}

// ---- Extraction patterns ----

// Real Playwright: <script id="playwrightReportBase64" type="application/zip">data:application/zip;base64,...</script>
const SCRIPT_TAG_PATTERN = /<script[^>]*id=["']playwrightReportBase64["'][^>]*>([\s\S]*?)<\/script>/;
// Fixture/older format: window.playwrightReportBase64 = "..."
const JS_VAR_PATTERN = /playwrightReportBase64\s*=\s*["']([A-Za-z0-9+/=]+)["']/;

/**
 * Ingest a Playwright HTML report file.
 */
export async function ingestHtmlReport(
  html: string,
  artifactDir: string
): Promise<IngestResult> {
  const base64 = extractBase64(html);
  if (!base64) {
    throw new Error(
      "Could not find embedded report data in HTML file. " +
        "Make sure this is a Playwright HTML report (index.html from playwright-report/)."
    );
  }

  const zipBuffer = Buffer.from(base64, "base64");
  const report = await extractReportFromZip(zipBuffer);

  return {
    report,
    artifactDir,
    sourcePath: "<html-upload>",
  };
}

/**
 * Ingest a zipped playwright-report/ directory.
 */
export async function ingestZipReport(
  zipData: Buffer,
  artifactDir: string
): Promise<IngestResult> {
  const outerZip = await JSZip.loadAsync(zipData);

  // Check for a direct report.json (standard JSON reporter output, zipped)
  const reportJson = findFile(outerZip, "report.json");
  if (reportJson) {
    const json = await reportJson.async("string");
    try {
      const parsed = JSON.parse(json);
      if (isStandardReport(parsed)) {
        return {
          report: parsed,
          artifactDir,
          sourcePath: "<zip-upload:report.json>",
        };
      }
    } catch { /* fall through */ }
  }

  // Look for index.html (the HTML report)
  const indexHtml = findFile(outerZip, "index.html");
  if (indexHtml) {
    const html = await indexHtml.async("string");
    const base64 = extractBase64(html);
    if (base64) {
      const innerZipBuffer = Buffer.from(base64, "base64");
      const report = await extractReportFromZip(innerZipBuffer);
      return {
        report,
        artifactDir,
        sourcePath: "<zip-upload:index.html>",
      };
    }
  }

  throw new Error(
    "Could not find Playwright report data in the uploaded zip. " +
      "Expected either a report.json or an index.html with embedded report data."
  );
}

/**
 * Extract base64 from HTML content. Handles both real Playwright format
 * (script tag with data URI) and simpler formats (JS variable assignment).
 */
function extractBase64(html: string): string | null {
  // Try the real Playwright format: <script id="playwrightReportBase64" ...>data:...;base64,XXX</script>
  const scriptMatch = html.match(SCRIPT_TAG_PATTERN);
  if (scriptMatch) {
    const content = scriptMatch[1].trim();
    // Strip data URI prefix if present
    const commaIdx = content.indexOf(",");
    if (commaIdx !== -1) {
      return content.slice(commaIdx + 1);
    }
    return content;
  }

  // Try JS variable assignment: playwrightReportBase64 = "XXX"
  const varMatch = html.match(JS_VAR_PATTERN);
  if (varMatch) {
    return varMatch[1];
  }

  return null;
}

/**
 * Extract Playwright report from the inner ZIP.
 * Handles both formats:
 * - Standard JSON reporter (has `suites` array)
 * - HTML reporter (has `files` array + separate detail JSON files)
 */
async function extractReportFromZip(
  zipBuffer: Buffer
): Promise<PlaywrightJsonReport> {
  const zip = await JSZip.loadAsync(zipBuffer);

  // Try report.json first
  const reportFile = zip.file("report.json");
  if (reportFile) {
    const content = await reportFile.async("string");
    const parsed = JSON.parse(content);

    // Standard JSON reporter format — return directly
    if (isStandardReport(parsed)) {
      return parsed;
    }

    // HTML reporter format — convert to standard format
    if (isHtmlReport(parsed)) {
      return await convertHtmlReport(parsed, zip);
    }
  }

  // Try index.json
  const indexFile = zip.file("index.json");
  if (indexFile) {
    const content = await indexFile.async("string");
    const parsed = JSON.parse(content);
    if (isStandardReport(parsed)) return parsed;
    if (isHtmlReport(parsed)) return await convertHtmlReport(parsed, zip);
  }

  // Try all JSON files
  const jsonFiles = Object.keys(zip.files).filter(
    (f) => f.endsWith(".json") && !zip.files[f].dir
  );

  for (const name of jsonFiles) {
    try {
      const content = await zip.files[name].async("string");
      const parsed = JSON.parse(content);
      if (isStandardReport(parsed)) return parsed;
      if (isHtmlReport(parsed)) return await convertHtmlReport(parsed, zip);
    } catch { /* skip */ }
  }

  throw new Error(
    "Could not parse Playwright report data from the embedded zip. " +
      `Found ${jsonFiles.length} JSON files but none matched expected formats.`
  );
}

/**
 * Convert HTML reporter format to standard PlaywrightJsonReport format.
 * Loads detail data from per-file JSON entries in the zip.
 */
async function convertHtmlReport(
  htmlReport: HtmlReportJson,
  zip: JSZip
): Promise<PlaywrightJsonReport> {
  // Build a map of fileId -> detail data from the zip
  const detailMap = new Map<string, HtmlReportTestDetail[]>();

  for (const file of htmlReport.files) {
    const detailFileName = `${file.fileId}.json`;
    const detailEntry = zip.file(detailFileName);
    if (detailEntry) {
      try {
        const content = await detailEntry.async("string");
        const detail = JSON.parse(content) as HtmlReportDetailFile;
        detailMap.set(file.fileId, detail.tests);
      } catch { /* skip */ }
    }
  }

  // Convert each file to a suite
  const suites: PlaywrightSuite[] = htmlReport.files.map((file) =>
    convertFileToSuite(file, detailMap.get(file.fileId))
  );

  const startTime =
    typeof htmlReport.startTime === "number"
      ? new Date(htmlReport.startTime).toISOString()
      : htmlReport.startTime;

  return {
    config: {
      configFile: (htmlReport.metadata?.["configFile"] as string) ?? undefined,
      rootDir: (htmlReport.metadata?.["rootDir"] as string) ?? undefined,
      metadata: htmlReport.metadata,
      projects: htmlReport.projectNames.map((name) => ({
        id: name,
        name,
      })),
    },
    suites,
    errors: htmlReport.errors,
    stats: {
      startTime,
      duration: htmlReport.duration,
      expected: htmlReport.stats.expected,
      unexpected: htmlReport.stats.unexpected,
      flaky: htmlReport.stats.flaky,
      skipped: htmlReport.stats.skipped,
    },
  };
}

function convertFileToSuite(
  file: HtmlReportFile,
  details: HtmlReportTestDetail[] | undefined
): PlaywrightSuite {
  // Build a detail lookup by testId
  const detailById = new Map<string, HtmlReportTestDetail>();
  if (details) {
    for (const d of details) {
      detailById.set(d.testId, d);
    }
  }

  const specs: PlaywrightSpec[] = file.tests.map((testSummary) => {
    const detail = detailById.get(testSummary.testId);
    return convertTestToSpec(testSummary, detail);
  });

  return {
    title: file.fileName,
    file: file.fileName,
    line: 0,
    column: 0,
    specs,
    suites: [],
  };
}

function convertTestToSpec(
  summary: HtmlReportTestSummary,
  detail: HtmlReportTestDetail | undefined
): PlaywrightSpec {
  const results: PlaywrightTestResult[] = (detail?.results ?? summary.results ?? []).map(
    (r, i) => convertResult(r, i)
  );

  const status = mapOutcome(summary.outcome);

  const test: PlaywrightTest = {
    timeout: 0,
    annotations: summary.annotations,
    expectedStatus: "passed",
    projectId: summary.projectName,
    projectName: summary.projectName,
    status,
    results,
  };

  return {
    title: summary.title,
    ok: summary.ok,
    tags: summary.tags,
    tests: [test],
    id: summary.testId,
    file: summary.location.file,
    line: summary.location.line,
    column: summary.location.column,
  };
}

function convertResult(result: HtmlReportResult, index: number): PlaywrightTestResult {
  return {
    workerIndex: 0,
    status: result.status,
    duration: result.duration,
    retry: result.retry ?? index,
    startTime: result.startTime,
    errors: result.errors.map(convertError),
    stdout: [],
    stderr: [],
    attachments: result.attachments.map(convertAttachment),
    steps: result.steps.map(convertStep),
  };
}

function convertStep(step: HtmlReportStep): PlaywrightStep {
  return {
    title: step.title,
    category: "pw:api",
    startTime: step.startTime,
    duration: step.duration,
    error: step.error ? normalizeError(step.error) : undefined,
    steps: step.steps?.map(convertStep),
  };
}

/**
 * Normalize an error that can be a string, an object with `message`, or other shapes.
 * Playwright HTML reports store step errors as raw strings.
 */
function normalizeError(error: unknown): PlaywrightError {
  if (typeof error === "string") {
    // Extract first line as the summary message
    const firstLine = error.split("\n")[0].replace(/\[2m/g, "").replace(/\[22m/g, "").trim();
    return {
      message: firstLine,
      stack: error,
    };
  }
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    return {
      message: (e.message as string) ?? String(error),
      stack: e.stack as string | undefined,
      value: e.value as string | undefined,
      snippet: e.snippet as string | undefined,
      location: e.location as PlaywrightError["location"],
    };
  }
  return { message: String(error) };
}

function convertError(error: HtmlReportError): PlaywrightError {
  return normalizeError(error);
}

function convertAttachment(att: HtmlReportAttachment): PlaywrightAttachment {
  return {
    name: att.name,
    contentType: att.contentType,
    path: att.path,
    body: att.body,
  };
}

function mapOutcome(
  outcome: "expected" | "unexpected" | "flaky" | "skipped"
): PlaywrightTest["status"] {
  switch (outcome) {
    case "expected": return "expected";
    case "unexpected": return "unexpected";
    case "flaky": return "flaky";
    case "skipped": return "skipped";
  }
}

// ---- Type guards ----

function isStandardReport(obj: unknown): obj is PlaywrightJsonReport {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return "suites" in r && Array.isArray(r.suites);
}

function isHtmlReport(obj: unknown): obj is HtmlReportJson {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return "files" in r && Array.isArray(r.files) && "stats" in r;
}

/**
 * Find a file in a zip by name, checking root and one directory deep.
 */
function findFile(zip: JSZip, filename: string): JSZip.JSZipObject | null {
  const direct = zip.file(filename);
  if (direct) return direct;

  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir && path.endsWith(`/${filename}`)) {
      if (path.split("/").length <= 2) return entry;
    }
  }

  return null;
}
