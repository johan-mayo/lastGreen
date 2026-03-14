import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import JSZip from "jszip";
import {
  ingestReportAuto,
  normalizeReport,
  matchTests,
  compareTestPair,
  triageTest,
} from "@last-green/core";
import type { NormalizedRun, Comparison, TriageSummary, NetworkRequest } from "@last-green/core";
import type { CompareResult } from "@last-green/core";

const UPLOAD_DIR = join(process.cwd(), ".lastgreen-data");

export interface AnalysisResult {
  id: string;
  failingRun: NormalizedRun;
  passingRun: NormalizedRun | null;
  comparison: Comparison;
  triageSummaries: TriageSummary[];
  compareResults: CompareResult[];
  /** Per-test, per-attempt network requests parsed from trace files. Keyed by `testId:attempt`. */
  networkRequests?: Record<string, NetworkRequest[]>;
  /** Passing run network requests. Keyed by `testId:attempt`. */
  passingNetworkRequests?: Record<string, NetworkRequest[]>;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const failingFile = formData.get("failing") as File | null;

    if (!failingFile) {
      return NextResponse.json(
        { error: "Missing required failing report file" },
        { status: 400 }
      );
    }

    const id = randomUUID();
    const sessionDir = join(UPLOAD_DIR, id);
    await mkdir(sessionDir, { recursive: true });

    // Read and ingest failing report (supports .json, .html, .zip)
    const failingBuffer = Buffer.from(await failingFile.arrayBuffer());
    await extractArtifactsFromZip(failingBuffer, sessionDir);
    const failingIngest = await ingestReportAuto(failingBuffer, failingFile.name, sessionDir);
    const failingRun = normalizeReport(failingIngest);

    // Optionally read and ingest passing report
    let passingRun: NormalizedRun | null = null;
    const passingFile = formData.get("passing") as File | null;
    if (passingFile) {
      const passingBuffer = Buffer.from(await passingFile.arrayBuffer());
      await extractArtifactsFromZip(passingBuffer, sessionDir);
      const passingIngest = await ingestReportAuto(passingBuffer, passingFile.name, sessionDir);
      passingRun = normalizeReport(passingIngest);
    }

    // Match and compare
    const comparison = matchTests(failingRun, passingRun);

    // Compare each matched pair and triage
    const compareResults: CompareResult[] = comparison.matchedTests.map(
      (match) => compareTestPair(match)
    );
    const triageSummaries: TriageSummary[] = compareResults.map((cr) =>
      triageTest(cr)
    );

    // Extract network requests from trace files
    const networkRequests = await extractNetworkRequests(failingRun, sessionDir);
    const passingNetworkRequests = passingRun
      ? await extractNetworkRequests(passingRun, sessionDir)
      : undefined;

    // Persist result
    const result: AnalysisResult = {
      id,
      failingRun,
      passingRun,
      comparison,
      triageSummaries,
      compareResults,
      networkRequests,
      passingNetworkRequests,
    };

    await writeFile(
      join(sessionDir, "result.json"),
      JSON.stringify(result, null, 2)
    );

    return NextResponse.json({ id });
  } catch (e) {
    console.error("Upload processing failed:", e);
    const message = e instanceof Error ? e.message : "Processing failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const ARTIFACT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4", ".zip"]);

/** Extract image/video artifacts from a zip into the session directory */
async function extractArtifactsFromZip(
  buffer: Buffer,
  sessionDir: string
): Promise<void> {
  // Check if it's actually a zip
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return;

  try {
    const zip = await JSZip.loadAsync(buffer);

    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const lower = path.toLowerCase();
      if (!ARTIFACT_EXTENSIONS.has(lower.slice(lower.lastIndexOf(".")))) continue;

      const data = await entry.async("nodebuffer");
      const destPath = join(sessionDir, path);
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, data);
    }
  } catch {
    // Not a valid zip or extraction failed — non-fatal
  }
}

/**
 * Walk all test results in a run, find trace artifacts,
 * and parse their network request data from the trace ZIP.
 * Returns a map keyed by "testId:attempt".
 */
async function extractNetworkRequests(
  run: NormalizedRun,
  sessionDir: string
): Promise<Record<string, NetworkRequest[]>> {
  const result: Record<string, NetworkRequest[]> = {};

  for (const test of run.testCases) {
    for (const attempt of test.results) {
      const traceArtifacts = attempt.artifacts.filter((a) => a.type === "trace");
      if (traceArtifacts.length === 0) continue;

      const key = `${test.id}:${attempt.attempt}`;
      const requests: NetworkRequest[] = [];

      for (const trace of traceArtifacts) {
        const tracePath = join(sessionDir, trace.path);
        try {
          const parsed = await parseTraceNetwork(tracePath);
          requests.push(...parsed);
        } catch {
          // Trace file missing or unparseable — skip
        }
      }

      if (requests.length > 0) {
        result[key] = requests;
      }
    }
  }

  return result;
}

/**
 * Parse a Playwright trace ZIP and extract network requests
 * from *.network files (newline-delimited JSON in HAR-like format).
 *
 * Playwright trace network format:
 *   {"type": "resource-snapshot", "snapshot": { "request": {...}, "response": {...}, "time": ms, ... }}
 */
async function parseTraceNetwork(tracePath: string): Promise<NetworkRequest[]> {
  const data = await readFile(tracePath);
  const zip = await JSZip.loadAsync(data);
  const requests: NetworkRequest[] = [];

  /** Resolve a SHA1 resource reference from the trace ZIP */
  async function resolveBody(
    obj: Record<string, unknown> | undefined
  ): Promise<string | undefined> {
    if (!obj) return undefined;
    // Direct text content
    if (typeof obj.text === "string" && obj.text) return obj.text;
    // SHA1 reference to resources/ folder
    const sha1 =
      (obj._sha1 as string) ?? (obj.sha1 as string);
    if (sha1) {
      const entry = zip.file(`resources/${sha1}`);
      if (entry) {
        try {
          return await entry.async("string");
        } catch { /* binary resource, skip */ }
      }
    }
    return undefined;
  }

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!name.endsWith(".network")) continue;

    const content = await entry.async("string");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);

        // Playwright uses HAR-like format nested under "snapshot"
        const snapshot = evt.snapshot ?? evt;
        const req = snapshot.request ?? evt.request;
        if (!req?.url) continue;

        const resp = snapshot.response ?? evt.response ?? {};
        const status: number = resp.status ?? 0;
        const duration = Math.round(snapshot.time ?? 0);
        const failed = status < 200 || status >= 400;

        const postData = req.postData as Record<string, unknown> | undefined;
        const respContent = resp.content as Record<string, unknown> | undefined;

        // Only resolve bodies for non-2xx requests to keep result.json small
        let requestBody: string | undefined;
        let responseBody: string | undefined;
        if (failed) {
          requestBody = await resolveBody(postData);
          responseBody = await resolveBody(respContent);
        }

        requests.push({
          url: req.url,
          method: req.method ?? "GET",
          status,
          statusText: resp.statusText ?? (status <= 0 ? "Failed" : ""),
          duration: duration > 0 ? duration : 0,
          resourceType: snapshot.resourceType ?? evt.resourceType,
          failed,
          requestHeaders: failed ? req.headers : undefined,
          requestBody,
          requestContentType: postData?.mimeType as string | undefined,
          responseHeaders: failed ? resp.headers : undefined,
          responseBody: responseBody?.slice(0, 5000), // cap large bodies
          responseContentType: respContent?.mimeType as string | undefined,
        });
      } catch {
        // Skip malformed lines
      }
    }
  }

  return requests;
}
