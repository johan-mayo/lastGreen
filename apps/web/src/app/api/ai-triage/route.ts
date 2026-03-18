import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { ComparisonSummary, AiTriageResult } from "@last-green/core";

/** Extract AiTriageResult JSON from model output, handling markdown fences, surrounding text, and truncation */
function extractTriageResult(text: string): AiTriageResult {
  const fallback: AiTriageResult = {
    category: "unknown",
    confidence: "low",
    diagnosis: text,
    primaryEvidence: [],
    counterEvidence: [],
    suggestedNextStep: "Review the test failure details manually.",
  };

  function normalize(v: Record<string, unknown>): AiTriageResult {
    return {
      category: (v.category as string) ?? "unknown",
      confidence: (v.confidence as string) ?? "low",
      diagnosis: (v.diagnosis as string) ?? text,
      primaryEvidence: Array.isArray(v.primaryEvidence) ? v.primaryEvidence : [],
      counterEvidence: Array.isArray(v.counterEvidence) ? v.counterEvidence : [],
      suggestedNextStep: (v.suggestedNextStep as string) ?? "Review the test failure details manually.",
    } as AiTriageResult;
  }

  function tryParse(json: string): AiTriageResult | null {
    try {
      const p = JSON.parse(json);
      if (p && typeof p === "object" && p.category && p.diagnosis) return normalize(p);
    } catch { /* not valid */ }
    return null;
  }

  /** Attempt to repair truncated JSON by closing open strings, arrays, and braces */
  function tryRepairAndParse(json: string): AiTriageResult | null {
    let repaired = json.trim().replace(/,\s*$/, "");
    const quotes = (repaired.match(/(?<!\\)"/g) ?? []).length;
    if (quotes % 2 !== 0) repaired += '"';
    const opens = { "[": 0, "{": 0 };
    const closes: Record<string, keyof typeof opens> = { "]": "[", "}": "{" };
    for (const ch of repaired) {
      if (ch in opens) opens[ch as keyof typeof opens]++;
      if (ch in closes) opens[closes[ch]]--;
    }
    for (let i = 0; i < opens["["]; i++) repaired += "]";
    for (let i = 0; i < opens["{"]; i++) repaired += "}";
    return tryParse(repaired);
  }

  // Strategy 1: extract JSON from inside markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    const r = tryParse(fenceMatch[1]) ?? tryRepairAndParse(fenceMatch[1]);
    if (r) return r;
  }

  // Strategy 2: find first { to last } and parse
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const r = tryParse(text.slice(firstBrace, lastBrace + 1));
    if (r) return r;
  }

  // Strategy 3: truncated — first { to end, attempt repair
  if (firstBrace !== -1) {
    const r = tryRepairAndParse(text.slice(firstBrace));
    if (r) return r;
  }

  // Strategy 4: try raw text
  return tryParse(text) ?? fallback;
}

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

      // Replay conversation history, appending JSON instruction to the last user message
      for (let i = 0; i < conversationHistory.length; i++) {
        const msg = conversationHistory[i];
        const isLastUser = msg.role === "user" && i === conversationHistory.length - 1;
        messages.push({
          role: msg.role,
          content: isLastUser
            ? `${msg.content}\n\nIncorporate my feedback and return an updated diagnosis as ONLY strict JSON (no markdown fences) with the same shape: { "category", "confidence", "primaryEvidence", "counterEvidence", "diagnosis", "suggestedNextStep" }`
            : msg.content,
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
      max_tokens: isFollowUp ? 1024 : 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Parse structured response (both initial and follow-up)
    const result = extractTriageResult(text);

    return NextResponse.json({ result, rawResponse: text });
  } catch (e) {
    const message = e instanceof Error ? e.message : "AI triage failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
