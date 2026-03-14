import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { ComparisonSummary, AiTriageResult } from "@last-green/core";

const SYSTEM_PROMPT = `You are doing evidence-based triage for a failing Playwright e2e test. These tests cover UI, API, and SDK surfaces. A failure may be a genuine bug, or it may be caused by an intentional change to a service that the test hasn't been updated to reflect yet.

Rules:
- The first meaningful divergence is the primary signal.
- A network request is only considered causal if it differs from the passing run and occurs at or before the divergence.
- Requests marked [ALSO FAILED IN PASS] are NOT the cause — they existed in the passing run too.
- Requests listed as likely red herrings should not be used as primary evidence.
- If step sequence, navigation, locator behavior, or assertion output changed without a strong network difference, prefer "ui_change_or_outdated_test" or "unknown".
- Do not infer hidden backend failures without direct evidence.
- If evidence is weak or mixed, return "unknown" with low confidence.`;

function buildComparisonContext(comparison: ComparisonSummary): string {
  const parts: string[] = [
    `Test: ${comparison.testName}`,
    `File: ${comparison.filePath}`,
    `Status: ${comparison.attemptStatus}`,
  ];

  if (comparison.errorHeadline) {
    parts.push(`Error: ${comparison.errorHeadline}`);
  }
  if (comparison.errorStack) {
    parts.push(`Stack:\n${comparison.errorStack.slice(0, 1500)}`);
  }

  if (comparison.firstDivergence) {
    const d = comparison.firstDivergence;
    parts.push(
      `\nFirst divergence (step ${d.stepIndex}, ${d.kind}): ${d.description}`,
    );
  }

  if (comparison.stepDiffs.length > 0) {
    parts.push(`\nStep diffs around divergence:`);
    for (const sd of comparison.stepDiffs) {
      const pass = sd.passTitle ?? "—";
      const fail = sd.failTitle ?? "—";
      parts.push(`  [${sd.stepIndex}] ${sd.kind}: fail="${fail}" pass="${pass}"${sd.note ? ` (${sd.note})` : ""}`);
    }
  }

  if (comparison.requestDiffs.length > 0) {
    parts.push(`\nNetwork request diffs (deterministically filtered for relevance):`);
    for (const rd of comparison.requestDiffs) {
      const passLabel = rd.passStatus !== null ? String(rd.passStatus) : "N/A";
      const failLabel = rd.failStatus <= 0 ? "ERR" : String(rd.failStatus);
      let line = `  ${rd.method} ${rd.url} → fail:${failLabel} pass:${passLabel}`;
      if (rd.alsoFailedInPass) line += " [ALSO FAILED IN PASS]";
      if (rd.changedBetweenRuns) line += " [STATUS CHANGED]";
      line += ` — ${rd.reason}`;
      parts.push(line);
      if (rd.responseBody) {
        parts.push(`    Response: ${rd.responseBody.slice(0, 300)}`);
      }
    }
  }

  if (comparison.consoleDiffs.length > 0) {
    parts.push(
      `\nConsole errors only in failing run:`,
      ...comparison.consoleDiffs.map((c: string) => `  ${c}`),
    );
  }

  if (comparison.likelyRedHerrings.length > 0) {
    parts.push(
      `\nLikely red herrings (do not use as primary evidence):`,
      ...comparison.likelyRedHerrings.map((r: string) => `  - ${r}`),
    );
  }

  return parts.join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, comparison, conversationHistory } = body as {
      apiKey: string;
      comparison: ComparisonSummary;
      conversationHistory?: { role: "user" | "assistant"; content: string }[];
    };

    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 400 },
      );
    }

    const client = new Anthropic({ apiKey });
    const context = buildComparisonContext(comparison);
    const isFollowUp = conversationHistory && conversationHistory.length > 0;

    const messages: Anthropic.MessageParam[] = [];

    if (isFollowUp) {
      // First message: the original analysis context + initial prompt
      messages.push({
        role: "user",
        content: `${context}\n\nAnalyze this test failure. Return ONLY strict JSON (no markdown fences) with this shape:
{
  "category": "app_regression" | "ui_change_or_outdated_test" | "timing_or_flake" | "environment_issue" | "unknown",
  "confidence": "low" | "medium" | "high",
  "primaryEvidence": ["evidence item 1", ...],
  "counterEvidence": ["counter-evidence item 1", ...],
  "diagnosis": "2-4 sentence diagnosis",
  "suggestedNextStep": "what the engineer should do"
}`,
      });

      // Replay conversation history
      for (const msg of conversationHistory) {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    } else {
      // Initial diagnosis — single message
      messages.push({
        role: "user",
        content: `${context}\n\nReturn ONLY strict JSON (no markdown fences) with this shape:
{
  "category": "app_regression" | "ui_change_or_outdated_test" | "timing_or_flake" | "environment_issue" | "unknown",
  "confidence": "low" | "medium" | "high",
  "primaryEvidence": ["evidence item 1", ...],
  "counterEvidence": ["counter-evidence item 1", ...],
  "diagnosis": "2-4 sentence diagnosis",
  "suggestedNextStep": "what the engineer should do"
}`,
      });
    }

    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: isFollowUp ? 400 : 600,
      system: SYSTEM_PROMPT,
      messages,
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    if (isFollowUp) {
      // Follow-up: return plain text response
      return NextResponse.json({ reply: text });
    }

    // Initial: parse structured response
    let result: AiTriageResult;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "");
      result = JSON.parse(cleaned);
    } catch {
      result = {
        category: "unknown",
        confidence: "low",
        diagnosis: text,
        primaryEvidence: [],
        counterEvidence: [],
        suggestedNextStep: "Review the test failure details manually.",
      };
    }

    return NextResponse.json({ result, rawResponse: text });
  } catch (e) {
    const message = e instanceof Error ? e.message : "AI triage failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
