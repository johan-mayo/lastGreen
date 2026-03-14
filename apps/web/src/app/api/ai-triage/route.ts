import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, context } = body as {
      apiKey: string;
      context: {
        testName: string;
        filePath: string;
        category: string;
        errorHeadline: string | null;
        errorStack: string | null;
        divergence: {
          stepIndex: number;
          failingStepTitle: string | null;
          passingStepTitle: string | null;
          type: string;
          description: string;
        } | null;
        evidence: { type: string; description: string }[];
        suggestedNextStep: string;
        attemptStatus: string;
        passingRun: {
          status: string;
          duration: number;
          stepsAroundDivergence: { index: number; title: string; duration: number; error: string | null }[];
          totalSteps: number;
        } | null;
        failingRequests: { title: string; duration: number; error: string }[];
      };
    };

    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 400 }
      );
    }

    const client = new Anthropic({ apiKey });

    // Build a concise prompt from the failure context
    const parts: string[] = [
      `Test: ${context.testName}`,
      `File: ${context.filePath}`,
      `Category: ${context.category}`,
      `Status: ${context.attemptStatus}`,
    ];

    if (context.errorHeadline) {
      parts.push(`Error: ${context.errorHeadline}`);
    }
    if (context.errorStack) {
      // Truncate stack to keep prompt small
      parts.push(
        `Stack:\n${context.errorStack.slice(0, 1500)}`
      );
    }
    if (context.divergence) {
      const d = context.divergence;
      parts.push(
        `First divergence (step ${d.stepIndex}): ${d.description}`,
        `  Failing step: ${d.failingStepTitle ?? "—"}`,
        `  Passing step: ${d.passingStepTitle ?? "—"}`,
        `  Type: ${d.type}`
      );
    }
    if (context.passingRun) {
      const pr = context.passingRun;
      parts.push(
        `\nPassing run: status=${pr.status}, duration=${pr.duration}ms, ${pr.totalSteps} total steps`,
        `Passing steps around divergence point:`,
        ...pr.stepsAroundDivergence.map(
          (s) => `  [${s.index}] "${s.title}" ${s.duration}ms${s.error ? ` ERROR: ${s.error}` : ""}`
        )
      );
    } else {
      parts.push(`\nNo passing run provided (single-report mode).`);
    }
    if (context.failingRequests.length > 0) {
      parts.push(
        `\nFailing network/API requests (${context.failingRequests.length}):`,
        ...context.failingRequests.map(
          (r) => `  "${r.title}" ${r.duration}ms — ${r.error}`
        )
      );
    }
    if (context.evidence.length > 0) {
      parts.push(
        `Evidence:\n${context.evidence.map((e) => `  [${e.type}] ${e.description}`).join("\n")}`
      );
    }
    parts.push(`Current suggestion: ${context.suggestedNextStep}`);

    const message = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: `You are a Playwright test failure expert. These are e2e tests that cover UI, API, and SDK surfaces. A failure may be a genuine bug, but it can also be caused by an intentional change to a service (updated API response, redesigned UI element, new SDK behavior) that the test hasn't been updated to reflect yet. Keep both possibilities in mind when diagnosing.\n\nA single attempt of a CI test failed. The data below is for this one attempt only — diagnose this specific failure compared to the passing run (if provided). Do not mix in information from other retry attempts.\n\n${parts.join("\n")}\n\nGive a brief, actionable diagnosis: what likely caused this specific attempt's failure and what the engineer should do to fix it. Be specific to the error and step shown. 3-5 sentences max.`,
        },
      ],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";

    return NextResponse.json({ suggestion: text });
  } catch (e) {
    const message = e instanceof Error ? e.message : "AI triage failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
