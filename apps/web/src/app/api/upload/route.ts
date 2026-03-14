import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ingestReportFromJson,
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

    // Read and ingest failing report
    const failingJson = await failingFile.text();
    const failingIngest = await ingestReportFromJson(failingJson, sessionDir);
    const failingRun = normalizeReport(failingIngest);

    // Optionally read and ingest passing report
    let passingRun: NormalizedRun | null = null;
    const passingFile = formData.get("passing") as File | null;
    if (passingFile) {
      const passingJson = await passingFile.text();
      const passingIngest = await ingestReportFromJson(passingJson, sessionDir);
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
