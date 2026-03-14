import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, testName, errorHeadline, requests } = body as {
      apiKey: string;
      testName: string;
      errorHeadline: string | null;
      requests: {
        url: string;
        method: string;
        status: number;
        statusText: string;
        duration: number;
        resourceType?: string;
      }[];
    };

    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 400 },
      );
    }

    if (requests.length === 0) {
      return NextResponse.json({ relevantIndices: [] });
    }

    // If 5 or fewer requests, all are relevant — skip the AI call
    if (requests.length <= 5) {
      return NextResponse.json({
        relevantIndices: requests.map((_, i) => i),
      });
    }

    const client = new Anthropic({ apiKey });

    const requestList = requests
      .map(
        (r, i) =>
          `[${i}] ${r.method} ${r.url} → ${r.status <= 0 ? "ERR" : r.status} ${r.statusText} (${r.duration}ms)${r.resourceType ? ` [${r.resourceType}]` : ""}`,
      )
      .join("\n");

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `You are filtering network request failures for relevance to a Playwright e2e test failure.

Test: ${testName}
Error: ${errorHeadline ?? "unknown"}

These are the non-2xx HTTP requests captured during this test attempt:
${requestList}

Which of these requests are most likely relevant to diagnosing the test failure? Consider:
- API calls related to the test's functionality (not static assets, analytics, telemetry)
- Requests whose failure could cause the observed error
- Ignore favicon, font, tracking pixel, and other irrelevant asset failures

Return ONLY a JSON array of the relevant indices, e.g. [0, 3, 7]. Return at most 8 indices. No explanation.`,
        },
      ],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "[]";

    // Parse the JSON array from the response
    const match = text.match(/\[[\d,\s]*\]/);
    const indices: number[] = match ? JSON.parse(match[0]) : [];

    // Validate indices are in range
    const valid = indices.filter(
      (i) => Number.isInteger(i) && i >= 0 && i < requests.length,
    );

    return NextResponse.json({ relevantIndices: valid });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Filter failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
