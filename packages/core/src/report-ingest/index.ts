import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import type { PlaywrightJsonReport } from "../types/index.js";

export interface IngestResult {
  report: PlaywrightJsonReport;
  artifactDir: string;
  sourcePath: string;
}

/**
 * Ingest a Playwright JSON report from a file path.
 * For v1, expects a directory containing a `report.json` and any artifact files.
 */
export async function ingestReport(reportDir: string): Promise<IngestResult> {
  const reportPath = join(reportDir, "report.json");
  const raw = await readFile(reportPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in report file: ${reportPath}`);
  }

  if (!isPlaywrightReport(parsed)) {
    throw new Error(
      `File does not appear to be a Playwright JSON report: ${reportPath}`
    );
  }

  return {
    report: parsed,
    artifactDir: reportDir,
    sourcePath: reportPath,
  };
}

/**
 * Ingest a raw JSON report string (for upload via API).
 */
export async function ingestReportFromJson(
  json: string,
  artifactDir: string
): Promise<IngestResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid JSON in uploaded report");
  }

  if (!isPlaywrightReport(parsed)) {
    throw new Error("Uploaded file does not appear to be a Playwright JSON report");
  }

  return {
    report: parsed,
    artifactDir,
    sourcePath: "<upload>",
  };
}

function isPlaywrightReport(obj: unknown): obj is PlaywrightJsonReport {
  if (typeof obj !== "object" || obj === null) return false;
  const record = obj as Record<string, unknown>;
  return (
    "config" in record &&
    "suites" in record &&
    Array.isArray(record.suites)
  );
}
