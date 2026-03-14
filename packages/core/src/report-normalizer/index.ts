import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IngestResult } from "../report-ingest/index.js";
import type {
  PlaywrightSuite,
  PlaywrightSpec,
  PlaywrightTest,
  PlaywrightTestResult,
  PlaywrightStep,
  PlaywrightAttachment,
  NormalizedRun,
  NormalizedTestCase,
  NormalizedTestResult,
  NormalizedStep,
  NormalizedError,
  Artifact,
} from "../types/index.js";

export function normalizeReport(ingestResult: IngestResult): NormalizedRun {
  const { report, artifactDir, sourcePath } = ingestResult;
  const testCases: NormalizedTestCase[] = [];

  for (const suite of report.suites) {
    collectTestCases(suite, [], artifactDir, testCases);
  }

  const stats = {
    total: testCases.length,
    passed: testCases.filter((t) => t.status === "passed").length,
    failed: testCases.filter((t) => t.status === "failed").length,
    flaky: testCases.filter((t) => t.status === "flaky").length,
    skipped: testCases.filter((t) => t.status === "skipped").length,
  };

  const metadata = report.config.metadata as Record<string, string> | undefined;

  return {
    id: randomUUID(),
    sourceFile: sourcePath,
    commitSha: metadata?.["commitSha"] ?? metadata?.["revision.id"],
    branch: metadata?.["branch"] ?? metadata?.["revision.branch"],
    environment: metadata?.["environment"],
    browser: undefined,
    projectName: undefined,
    startTime: report.stats.startTime,
    duration: report.stats.duration,
    stats,
    testCases,
  };
}

function collectTestCases(
  suite: PlaywrightSuite,
  parentTitles: string[],
  artifactDir: string,
  out: NormalizedTestCase[]
): void {
  const titlePath = suite.title ? [...parentTitles, suite.title] : parentTitles;

  for (const spec of suite.specs) {
    for (const test of spec.tests) {
      const fullTitlePath = [...titlePath, spec.title];
      out.push(normalizeTestCase(spec, test, fullTitlePath, artifactDir));
    }
  }

  if (suite.suites) {
    for (const child of suite.suites) {
      collectTestCases(child, titlePath, artifactDir, out);
    }
  }
}

function normalizeTestCase(
  spec: PlaywrightSpec,
  test: PlaywrightTest,
  titlePath: string[],
  artifactDir: string
): NormalizedTestCase {
  const status = mapStatus(test.status, test.results);
  const results = test.results.map((r, i) =>
    normalizeResult(r, i, artifactDir)
  );

  return {
    id: spec.id,
    filePath: spec.file,
    titlePath,
    fullTitle: titlePath.join(" > "),
    projectName: test.projectName,
    browser: test.projectName, // Playwright uses project name for browser config
    status,
    duration: results.reduce((sum, r) => sum + r.duration, 0),
    retries: test.results.length - 1,
    results,
    tags: spec.tags,
  };
}

function mapStatus(
  testStatus: PlaywrightTest["status"],
  results: PlaywrightTestResult[]
): NormalizedTestCase["status"] {
  switch (testStatus) {
    case "expected":
      return "passed";
    case "unexpected":
      // Check if last result was timeout
      const lastResult = results[results.length - 1];
      if (lastResult?.status === "timedOut") return "timedOut";
      return "failed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "skipped";
    default:
      return "failed";
  }
}

function normalizeResult(
  result: PlaywrightTestResult,
  attempt: number,
  artifactDir: string
): NormalizedTestResult {
  return {
    attempt,
    status: result.status,
    duration: result.duration,
    startTime: result.startTime,
    error: result.errors.length > 0 ? normalizeError(result.errors[0]) : undefined,
    steps: result.steps.map(normalizeStep),
    artifacts: result.attachments.map((a) => normalizeAttachment(a, artifactDir)),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function normalizeError(err: { message: string; stack?: string; snippet?: string; location?: { file: string; line: number; column: number } }): NormalizedError {
  return {
    message: err.message,
    stack: err.stack,
    snippet: err.snippet,
    location: err.location,
  };
}

function normalizeStep(step: PlaywrightStep): NormalizedStep {
  return {
    title: step.title,
    category: step.category,
    startTime: step.startTime,
    duration: step.duration,
    error: step.error ? normalizeError(step.error) : undefined,
    children: step.steps ? step.steps.map(normalizeStep) : [],
  };
}

function normalizeAttachment(
  attachment: PlaywrightAttachment,
  artifactDir: string
): Artifact {
  const type = inferArtifactType(attachment);
  return {
    type,
    name: attachment.name,
    contentType: attachment.contentType,
    path: attachment.path
      ? attachment.path
      : join(artifactDir, attachment.name),
  };
}

function inferArtifactType(attachment: PlaywrightAttachment): Artifact["type"] {
  if (attachment.contentType.startsWith("image/")) return "screenshot";
  if (attachment.contentType === "application/zip" && attachment.name.includes("trace"))
    return "trace";
  if (attachment.contentType.startsWith("video/")) return "video";
  return "other";
}
