import JSZip from "jszip";
import type { PlaywrightJsonReport } from "../types/index.js";
import type { IngestResult } from "./index.js";

const BASE64_PATTERN = /playwrightReportBase64\s*=\s*"([^"]+)"/;
const BASE64_PATTERN_SINGLE = /playwrightReportBase64\s*=\s*'([^']+)'/;

/**
 * Ingest a Playwright HTML report file.
 * The HTML report embeds test data as a base64-encoded ZIP
 * stored in a `playwrightReportBase64` JS variable.
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
 * Looks for index.html inside the zip, then extracts the embedded data.
 */
export async function ingestZipReport(
  zipData: Buffer,
  artifactDir: string
): Promise<IngestResult> {
  const outerZip = await JSZip.loadAsync(zipData);

  // First, check if there's a report.json directly in the zip (JSON report zipped up)
  const reportJson = findFile(outerZip, "report.json");
  if (reportJson) {
    const json = await reportJson.async("string");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("Found report.json in zip but it contains invalid JSON");
    }
    if (isPlaywrightReport(parsed)) {
      return {
        report: parsed,
        artifactDir,
        sourcePath: "<zip-upload:report.json>",
      };
    }
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
 * Extract the base64-encoded report data from the HTML content.
 */
function extractBase64(html: string): string | null {
  const match = html.match(BASE64_PATTERN) ?? html.match(BASE64_PATTERN_SINGLE);
  return match?.[1] ?? null;
}

/**
 * Extract and parse the Playwright report JSON from an inner zip buffer.
 * The zip contains JSON entries — we look for the main report data.
 */
async function extractReportFromZip(
  zipBuffer: Buffer
): Promise<PlaywrightJsonReport> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const entries = Object.keys(zip.files);

  // The embedded zip typically contains JSON files that together form the report.
  // Look for common patterns: "report.json", "index.json", or numbered JSON files.

  // Try direct report/index JSON first
  for (const name of ["report.json", "index.json"]) {
    const file = zip.file(name);
    if (file) {
      const content = await file.async("string");
      const parsed = JSON.parse(content);
      if (isPlaywrightReport(parsed)) return parsed;
    }
  }

  // Playwright HTML reports split data across numbered JSON files.
  // Collect all JSON entries and try to assemble.
  const jsonEntries: { name: string; content: string }[] = [];
  for (const entry of entries) {
    if (entry.endsWith(".json") && !zip.files[entry].dir) {
      const content = await zip.files[entry].async("string");
      jsonEntries.push({ name: entry, content });
    }
  }

  if (jsonEntries.length === 0) {
    throw new Error("No JSON data found in the embedded report zip");
  }

  // If there's only one JSON entry, try parsing it directly
  if (jsonEntries.length === 1) {
    const parsed = JSON.parse(jsonEntries[0].content);
    if (isPlaywrightReport(parsed)) return parsed;
  }

  // Multiple JSON entries — Playwright HTML reports use this format:
  // The entries contain partial report data that needs assembly.
  // Try each entry to find the main report structure.
  for (const entry of jsonEntries) {
    try {
      const parsed = JSON.parse(entry.content);
      if (isPlaywrightReport(parsed)) return parsed;
    } catch {
      // skip malformed entries
    }
  }

  // Last resort: try to assemble from the JSON entries
  // Playwright stores report data as an array of test file entries
  // Try merging them into a synthetic report
  const assembled = tryAssembleReport(jsonEntries);
  if (assembled) return assembled;

  throw new Error(
    "Found JSON data in report zip but could not parse it as a Playwright report. " +
      `Entries found: ${entries.join(", ")}`
  );
}

/**
 * Try to assemble a PlaywrightJsonReport from multiple JSON entries.
 * Playwright HTML reports may store data as separate file-level entries.
 */
function tryAssembleReport(
  entries: { name: string; content: string }[]
): PlaywrightJsonReport | null {
  // Each entry might be a test file's data. Try to find one that looks like
  // it has the full report structure or has suites we can merge.
  const suites: unknown[] = [];
  let config: unknown = null;
  let stats: unknown = null;

  for (const entry of entries) {
    try {
      const parsed = JSON.parse(entry.content);

      // If this entry has the full report shape, return it
      if (isPlaywrightReport(parsed)) return parsed;

      // If it's an object with suites, collect them
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (Array.isArray(record.suites)) {
          suites.push(...record.suites);
          if (record.config) config = record.config;
          if (record.stats) stats = record.stats;
        }
        // If the entry itself looks like a suite
        if (record.title !== undefined && Array.isArray(record.specs)) {
          suites.push(record);
        }
      }

      // If it's an array, each element might be a suite
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object" && "specs" in item) {
            suites.push(item);
          }
        }
      }
    } catch {
      // skip
    }
  }

  if (suites.length === 0) return null;

  return {
    config: (config as PlaywrightJsonReport["config"]) ?? {
      projects: [],
    },
    suites: suites as PlaywrightJsonReport["suites"],
    errors: [],
    stats: (stats as PlaywrightJsonReport["stats"]) ?? {
      startTime: new Date().toISOString(),
      duration: 0,
      expected: 0,
      unexpected: 0,
      flaky: 0,
      skipped: 0,
    },
  } as PlaywrightJsonReport;
}

function isPlaywrightReport(obj: unknown): obj is PlaywrightJsonReport {
  if (typeof obj !== "object" || obj === null) return false;
  const record = obj as Record<string, unknown>;
  return "suites" in record && Array.isArray(record.suites);
}

/**
 * Find a file in a zip by name, checking both at root and nested one level.
 */
function findFile(zip: JSZip, filename: string): JSZip.JSZipObject | null {
  // Check root
  const direct = zip.file(filename);
  if (direct) return direct;

  // Check one directory deep (e.g. playwright-report/index.html)
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir && path.endsWith(`/${filename}`)) {
      const depth = path.split("/").length;
      if (depth <= 2) return entry;
    }
  }

  return null;
}
