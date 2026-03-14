import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlaywrightJsonReport } from "../types/index.js";
import { ingestHtmlReport, ingestZipReport } from "./html-report.js";

export interface IngestResult {
  report: PlaywrightJsonReport;
  artifactDir: string;
  sourcePath: string;
}

/**
 * Ingest a Playwright JSON report from a file path.
 * Expects a directory containing a `report.json` and any artifact files.
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

/**
 * Auto-detect file type and ingest accordingly.
 * Supports: .json, .html, .zip
 */
export async function ingestReportAuto(
  fileBuffer: Buffer,
  fileName: string,
  artifactDir: string
): Promise<IngestResult> {
  const lower = fileName.toLowerCase();

  // ZIP file — either a zipped playwright-report/ or a zipped JSON report
  if (lower.endsWith(".zip") || isZipBuffer(fileBuffer)) {
    return ingestZipReport(fileBuffer, artifactDir);
  }

  const text = fileBuffer.toString("utf-8");

  // HTML file — Playwright HTML report
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return ingestHtmlReport(text, artifactDir);
  }

  // JSON file — standard JSON report
  if (lower.endsWith(".json")) {
    return ingestReportFromJson(text, artifactDir);
  }

  // Unknown extension — try to detect content
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return ingestReportFromJson(text, artifactDir);
  }
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html")) {
    return ingestHtmlReport(text, artifactDir);
  }

  throw new Error(
    `Unsupported file type: ${fileName}. Upload a Playwright JSON report (.json), HTML report (.html), or a zipped report directory (.zip).`
  );
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

/** Check for ZIP magic bytes (PK\x03\x04) */
function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

export { ingestHtmlReport, ingestZipReport } from "./html-report.js";
