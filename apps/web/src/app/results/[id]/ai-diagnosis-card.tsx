"use client";

import { useState, useCallback, useEffect } from "react";
import type { AiTriageResult, ComparisonSummary } from "@last-green/core";
import {
  Alert,
  Box,
  Badge,
  Button,
  Group,
  List,
  Paper,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";

/** Try to parse a valid AiTriageResult from raw AI text, handling fences and truncation */
function tryParseTriageResult(text: string): AiTriageResult | null {
  function validate(v: unknown): AiTriageResult | null {
    if (
      v &&
      typeof v === "object" &&
      "category" in v &&
      "diagnosis" in v
    ) {
      const r = v as AiTriageResult;
      // Ensure arrays exist even if truncated before them
      return {
        category: r.category,
        confidence: r.confidence ?? "low",
        diagnosis: r.diagnosis,
        primaryEvidence: Array.isArray(r.primaryEvidence)
          ? r.primaryEvidence
          : [],
        counterEvidence: Array.isArray(r.counterEvidence)
          ? r.counterEvidence
          : [],
        suggestedNextStep:
          r.suggestedNextStep ?? "Review the test failure details.",
      };
    }
    return null;
  }

  function tryParse(json: string): AiTriageResult | null {
    try {
      return validate(JSON.parse(json));
    } catch {
      return null;
    }
  }

  /** Attempt to repair truncated JSON by closing open strings, arrays, and braces */
  function tryRepairAndParse(json: string): AiTriageResult | null {
    let repaired = json.trim();
    // Remove trailing comma
    repaired = repaired.replace(/,\s*$/, "");
    // Close any open string (odd number of unescaped quotes)
    const quotes = (repaired.match(/(?<!\\)"/g) ?? []).length;
    if (quotes % 2 !== 0) repaired += '"';
    // Close open arrays and objects
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

  // Strategy 1: JSON inside markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    const r = tryParse(fenceMatch[1]) ?? tryRepairAndParse(fenceMatch[1]);
    if (r) return r;
  }

  // Strategy 2: first { to last }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const r = tryParse(text.slice(firstBrace, lastBrace + 1));
    if (r) return r;
  }

  // Strategy 3: first { to end (truncated — no closing brace)
  if (firstBrace !== -1) {
    const r = tryRepairAndParse(text.slice(firstBrace));
    if (r) return r;
  }

  // Strategy 4: raw text
  return tryParse(text);
}

const AI_CATEGORY_LABELS: Record<string, string> = {
  app_regression: "App Regression",
  ui_change_or_outdated_test: "UI/API Change",
  timing_or_flake: "Timing / Flake",
  environment_issue: "Environment Issue",
  unknown: "Unknown",
};

const AI_CATEGORY_COLORS: Record<string, string> = {
  app_regression: "red",
  ui_change_or_outdated_test: "yellow",
  timing_or_flake: "orange",
  environment_issue: "blue",
  unknown: "gray",
};

function AiTriageResultCard({ result }: { result: AiTriageResult }) {
  return (
    <Paper
      p="md"
      radius="sm"
      mt="md"
      withBorder
      style={{ borderColor: "var(--mantine-color-violet-9)" }}
    >
      <Group gap="sm" mb="sm">
        <Badge
          size="sm"
          variant="light"
          color={AI_CATEGORY_COLORS[result.category] ?? "gray"}
        >
          {AI_CATEGORY_LABELS[result.category] ?? result.category}
        </Badge>
        <Text
          size="xs"
          c={
            result.confidence === "high"
              ? "green"
              : result.confidence === "medium"
                ? "yellow"
                : "dimmed"
          }
        >
          {result.confidence} confidence
        </Text>
      </Group>

      <Text size="sm">{result.diagnosis}</Text>

      {result.primaryEvidence.length > 0 && (
        <Box mt="sm">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={4}>
            Evidence
          </Text>
          <List spacing={4} size="xs">
            {result.primaryEvidence.map((e: string, i: number) => (
              <List.Item
                key={i}
                icon={
                  <Text size="xs" c="green" fw={700}>
                    +
                  </Text>
                }
              >
                <Text size="xs" c="dimmed">
                  {e}
                </Text>
              </List.Item>
            ))}
          </List>
        </Box>
      )}

      {result.counterEvidence.length > 0 && (
        <Box mt="sm">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={4}>
            Counter-evidence
          </Text>
          <List spacing={4} size="xs">
            {result.counterEvidence.map((e: string, i: number) => (
              <List.Item
                key={i}
                icon={
                  <Text size="xs" c="dimmed" fw={700}>
                    -
                  </Text>
                }
              >
                <Text size="xs" c="dimmed">
                  {e}
                </Text>
              </List.Item>
            ))}
          </List>
        </Box>
      )}

      <Paper p="xs" radius="sm" mt="sm" bg="dark.5">
        <Text size="xs">
          <Text span fw={500}>
            Next step:{" "}
          </Text>
          {result.suggestedNextStep}
        </Text>
      </Paper>
    </Paper>
  );
}

export function AiDiagnosisCard({
  comparisonSummary,
  attemptIdx,
  sessionId,
  testCaseId,
}: {
  comparisonSummary: ComparisonSummary;
  attemptIdx: number;
  sessionId: string;
  testCaseId: string;
}) {
  const [apiKey, setApiKey] = useState(() =>
    typeof window !== "undefined"
      ? (localStorage.getItem("lg-api-key") ?? "")
      : "",
  );
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  type ConvoMessage = { role: "user" | "assistant"; content: string };
  const convoKey = `lg-convo-${sessionId}-${testCaseId}`;
  const resultsKey = `lg-ai-results-${sessionId}-${testCaseId}`;

  const [aiResults, setAiResults] = useState<Record<number, AiTriageResult>>(
    () => {
      if (typeof window === "undefined") return {};
      try {
        const stored = sessionStorage.getItem(resultsKey);
        return stored ? JSON.parse(stored) : {};
      } catch {
        return {};
      }
    },
  );

  const [conversations, setConversations] = useState<
    Record<number, ConvoMessage[]>
  >(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = sessionStorage.getItem(convoKey);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const [followUpInput, setFollowUpInput] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(convoKey, JSON.stringify(conversations));
  }, [conversations, convoKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(resultsKey, JSON.stringify(aiResults));
  }, [aiResults, resultsKey]);

  const requestAiTriage = useCallback(async () => {
    if (!apiKey.trim()) {
      setShowKeyInput(true);
      return;
    }
    localStorage.setItem("lg-api-key", apiKey);
    setAiLoading(true);
    setAiError(null);

    const idx = attemptIdx;
    try {
      const res = await fetch("/api/ai-triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, comparison: comparisonSummary }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setAiResults((prev) => ({ ...prev, [idx]: data.result }));
      setConversations((prev) => ({
        ...prev,
        [idx]: [
          { role: "assistant" as const, content: data.rawResponse },
        ],
      }));
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI triage failed");
    } finally {
      setAiLoading(false);
    }
  }, [apiKey, attemptIdx, comparisonSummary]);

  const sendFollowUp = useCallback(async () => {
    const text = followUpInput.trim();
    if (!text || !apiKey.trim()) return;

    const idx = attemptIdx;
    const history = conversations[idx] ?? [];
    const updatedHistory = [
      ...history,
      { role: "user" as const, content: text },
    ];

    setConversations((prev) => ({ ...prev, [idx]: updatedHistory }));
    setFollowUpInput("");
    setAiLoading(true);
    setAiError(null);

    try {
      const res = await fetch("/api/ai-triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          comparison: comparisonSummary,
          conversationHistory: updatedHistory,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setConversations((prev) => ({
        ...prev,
        [idx]: [
          ...updatedHistory,
          { role: "assistant" as const, content: data.rawResponse },
        ],
      }));
      // Don't overwrite the initial diagnosis — follow-up results
      // are already shown inline in the conversation thread.
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Follow-up failed");
    } finally {
      setAiLoading(false);
    }
  }, [apiKey, attemptIdx, followUpInput, conversations, comparisonSummary]);

  return (
    <>
      <Group justify="flex-end" wrap="wrap" gap="sm">
        <Group gap="xs" wrap="wrap">
          {showKeyInput && (
            <TextInput
              type="password"
              placeholder="Anthropic API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && apiKey.trim()) {
                  setShowKeyInput(false);
                  requestAiTriage();
                }
              }}
              size="xs"
              w={256}
            />
          )}
          <Button
            onClick={() => {
              if (!apiKey.trim()) {
                setShowKeyInput(true);
              } else {
                requestAiTriage();
              }
            }}
            loading={aiLoading && !aiResults[attemptIdx]}
            disabled={aiLoading}
            size="xs"
            color="violet"
          >
            {aiResults[attemptIdx] ? "Re-analyze" : "Diagnose with AI"}
          </Button>
          {apiKey && (
            <Button
              onClick={() => setShowKeyInput(!showKeyInput)}
              size="xs"
              variant="subtle"
              color="gray"
            >
              key
            </Button>
          )}
        </Group>
      </Group>

      {aiError && (
        <Alert color="red" variant="light" mt="sm">
          {aiError}
        </Alert>
      )}

      {aiResults[attemptIdx] && (
        <AiTriageResultCard result={aiResults[attemptIdx]} />
      )}

      {/* Conversation thread */}
      {conversations[attemptIdx] &&
        conversations[attemptIdx].length > 1 && (
          <Stack gap="sm" mt="md">
            {conversations[attemptIdx].slice(1).map((msg, i) => {
              if (msg.role === "user") {
                return (
                  <Paper key={i} p="sm" radius="sm" bg="dark.5" ml="xl">
                    <Text size="xs" fw={500} tt="uppercase" c="dimmed" mb={4}>
                      You
                    </Text>
                    <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                      {msg.content}
                    </Text>
                  </Paper>
                );
              }
              const parsed = tryParseTriageResult(msg.content);
              if (parsed) {
                return <AiTriageResultCard key={i} result={parsed} />;
              }
              return (
                <Paper
                  key={i}
                  p="sm"
                  radius="sm"
                  mr="xl"
                  withBorder
                  style={{
                    borderColor: "var(--mantine-color-violet-9)",
                  }}
                >
                  <Text size="xs" fw={500} tt="uppercase" c="dimmed" mb={4}>
                    AI
                  </Text>
                  <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                    {msg.content}
                  </Text>
                </Paper>
              );
            })}
            {aiLoading && (
              <Paper
                p="sm"
                radius="sm"
                mr="xl"
                withBorder
                style={{
                  borderColor: "var(--mantine-color-violet-9)",
                }}
              >
                <Text size="sm" c="dimmed">
                  Thinking...
                </Text>
              </Paper>
            )}
          </Stack>
        )}

      {/* Follow-up input */}
      {aiResults[attemptIdx] && (
        <Group mt="sm" gap="xs">
          <TextInput
            placeholder="Ask a follow-up question..."
            value={followUpInput}
            onChange={(e) => setFollowUpInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                followUpInput.trim()
              ) {
                e.preventDefault();
                sendFollowUp();
              }
            }}
            disabled={aiLoading}
            size="sm"
            style={{ flex: 1 }}
          />
          <Button
            onClick={sendFollowUp}
            disabled={aiLoading || !followUpInput.trim()}
            size="sm"
            color="violet"
          >
            Send
          </Button>
        </Group>
      )}
    </>
  );
}
