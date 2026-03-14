import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import JSZip from "jszip";
import {
  ingestReportAuto,
  normalizeReport,
  matchTests,
  compareTestPair,
  triageTest,
} from "@last-green/core";
import type { NormalizedRun, Comparison, TriageSummary } from "@last-green/core";
import type { CompareResult } from "@last-green/core";

const UPLOAD_DIR = join(process.cwd(), ".lastgreen-data");

export interface AnalysisResult {
  id: string;
  failingRun: NormalizedRun;
  passingRun: NormalizedRun | null;
  comparison: Comparison;
  triageSummaries: TriageSummary[];
  compareResults: CompareResult[];
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

    // Persist result
    const result: AnalysisResult = {
      id,
      failingRun,
      passingRun,
      comparison,
      triageSummaries,
      compareResults,
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

const ARTIFACT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4"]);

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
