"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import type { AnalysisResult } from "../../api/upload/route";
import type {
  TriageSummary,
  NormalizedTestCase,
  NormalizedTestResult,
  NormalizedStep,
  Divergence,
  EvidenceItem,
  Artifact,
  NetworkRequest,
  ComparisonSummary,
  RequestDiff,
  AiTriageResult,
} from "@last-green/core";
import type { CompareResult } from "@last-green/core";
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Collapse,
  Grid,
  Group,
  Image,
  List,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { CodeHighlight } from "@mantine/code-highlight";
import { PassingPanel } from "./passing-panel";
import { NetworkRequestsPanel } from "../../components/network-requests-panel";

/** Try to parse a string as AiTriageResult JSON (handles markdown fences) */
function tryParseTriageResult(text: string): AiTriageResult | null {
  try {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      const parsed = JSON.parse(fenceMatch[1]);
      if (parsed.category && parsed.diagnosis) return parsed;
    }
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      if (parsed.category && parsed.diagnosis) return parsed;
    }
    const parsed = JSON.parse(text);
    if (parsed.category && parsed.diagnosis) return parsed;
  } catch { /* not valid JSON */ }
  return null;
}

/** Normalize step titles by replacing UUIDs/hashes with placeholders for comparison */
function normalizeStepTitle(title: string): string {
  return title
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/[0-9a-f]{16,}/gi, "<id>")
    .replace(/\b\d{10,}\b/g, "<id>");
}

function stepTitlesMatch(a: string, b: string): boolean {
  return a === b || normalizeStepTitle(a) === normalizeStepTitle(b);
}

const LIFECYCLE_STEPS = new Set([
  "Before Hooks",
  "After Hooks",
  "Worker Cleanup",
  "Worker Setup",
  "beforeAll hook",
  "afterAll hook",
  "beforeEach hook",
  "afterEach hook",
]);

/** Find the first non-lifecycle top-level step that errored in an attempt */
function findFailingStepInAttempt(
  steps: NormalizedStep[]
): { step: NormalizedStep; index: number } | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (LIFECYCLE_STEPS.has(step.title)) continue;
    if (step.error) {
      return { step, index: i };
    }
    if (step.children && step.children.length > 0) {
      const childFail = findFailingStepInChildren(step.children);
      if (childFail) return { step: childFail, index: i };
    }
  }
  return null;
}

function findFailingStepInChildren(steps: NormalizedStep[]): NormalizedStep | null {
  for (const step of steps) {
    if (step.error) return step;
    if (step.children && step.children.length > 0) {
      const child = findFailingStepInChildren(step.children);
      if (child) return child;
    }
  }
  return null;
}

/** Build a per-attempt summary from an attempt's error and steps */
function getAttemptSummary(attempt: NormalizedTestResult | undefined): {
  failingStep: { step: NormalizedStep; index: number } | null;
  errorHeadline: string | null;
  suggestedNextStep: string;
} {
  if (!attempt) return { failingStep: null, errorHeadline: null, suggestedNextStep: "Review the test failure details." };

  const failingStep = findFailingStepInAttempt(attempt.steps);
  const rawError = attempt.error?.message ?? failingStep?.step.error?.message ?? "";
  const cleanError = rawError.replace(/\[\d+m/g, "");
  const errorHeadline = cleanError.split("\n")[0] || null;
  const errorLower = cleanError.toLowerCase();

  let suggestedNextStep: string;

  if (errorLower.includes("intercepts pointer events") || errorLower.includes("subtree intercepts pointer")) {
    const stepName = failingStep?.step.title ?? "a click action";
    suggestedNextStep = `Step "${stepName}" timed out because an overlay element intercepts pointer events. Check for unexpected modals, tooltips, or loading overlays blocking the click target.`;
  } else if (errorLower.includes("timeout") || errorLower.includes("timed out")) {
    const stepName = failingStep?.step.title ?? "a step";
    suggestedNextStep = `Step "${stepName}" timed out. Check if the app is slow to respond or if the element never appears. Review the trace for network/rendering delays.`;
  } else if (errorLower.includes("expect(") || errorLower.includes("toequal") || errorLower.includes("tobe") || errorLower.includes("tohave") || errorLower.includes("tobegreaterthan")) {
    const stepName = failingStep?.step.title ?? "an assertion step";
    suggestedNextStep = `Assertion failed at step "${stepName}". The app returned unexpected data. Compare the expected vs received values and check if the app state is correct at this point.`;
  } else if (errorLower.includes("locator") || errorLower.includes("selector") || errorLower.includes("no element")) {
    const stepName = failingStep?.step.title ?? "a step";
    suggestedNextStep = `Step "${stepName}" could not find an element. Check if the selector is correct, if the page finished loading, or if the DOM structure changed.`;
  } else if (errorLower.includes("econnrefused") || errorLower.includes("net::err") || errorLower.includes("enotfound")) {
    suggestedNextStep = "Network error — the test environment may be down or unreachable. Check if the app server is running.";
  } else if (failingStep) {
    suggestedNextStep = `Step "${failingStep.step.title}" failed. Review the error details and trace to understand what went wrong.`;
  } else {
    suggestedNextStep = "Review the test failure details and error message.";
  }

  return { failingStep, errorHeadline, suggestedNextStep };
}

// ---- Deterministic request filtering ----

const IRRELEVANT_RESOURCE_TYPES = new Set([
  "image", "font", "media", "stylesheet",
]);

const IRRELEVANT_URL_PATTERNS = [
  /favicon/i, /analytics/i, /segment/i, /sentry/i,
  /telemetry/i, /hotjar/i, /intercom/i, /datadog/i,
  /google-analytics/i, /googletagmanager/i, /mixpanel/i,
  /amplitude/i, /fullstory/i, /logrocket/i, /newrelic/i,
  /\.woff2?$/i, /\.ttf$/i, /\.eot$/i,
];

function isIrrelevantRequest(r: NetworkRequest): boolean {
  if (r.resourceType && IRRELEVANT_RESOURCE_TYPES.has(r.resourceType)) return true;
  return IRRELEVANT_URL_PATTERNS.some((p) => p.test(r.url));
}

/** Build request diffs by comparing fail vs pass network requests for the same endpoint */
function buildRequestDiffs(
  failRequests: NetworkRequest[],
  passRequests: NetworkRequest[],
): RequestDiff[] {
  const diagnosticFail = failRequests.filter(
    (r) => (r.status >= 400 || r.status <= 0) && !isIrrelevantRequest(r)
  );

  const passIndex = new Map<string, NetworkRequest[]>();
  for (const r of passRequests) {
    let pathname: string;
    try { pathname = new URL(r.url).pathname; } catch { pathname = r.url; }
    const key = `${r.method}::${pathname}`;
    const list = passIndex.get(key) ?? [];
    list.push(r);
    passIndex.set(key, list);
  }

  const diffs: RequestDiff[] = [];
  for (const fr of diagnosticFail) {
    let pathname: string;
    try { pathname = new URL(fr.url).pathname; } catch { pathname = fr.url; }
    const key = `${fr.method}::${pathname}`;
    const passMatches = passIndex.get(key) ?? [];

    const alsoFailedInPass = passMatches.some(
      (pr) => pr.status >= 400 || pr.status <= 0
    );
    const passStatus = passMatches.length > 0
      ? passMatches[passMatches.length - 1].status
      : null;
    const changedBetweenRuns = passStatus !== null && passStatus !== fr.status;

    let reason: string;
    if (alsoFailedInPass) {
      reason = "Also failed in passing run — unlikely to be the cause";
    } else if (changedBetweenRuns) {
      reason = `Status changed from ${passStatus} (pass) to ${fr.status <= 0 ? "ERR" : fr.status} (fail)`;
    } else if (passStatus === null) {
      reason = "No matching request in passing run";
    } else {
      reason = "Request failed";
    }

    diffs.push({
      method: fr.method,
      url: fr.url,
      failStatus: fr.status,
      passStatus,
      changedBetweenRuns,
      alsoFailedInPass,
      reason,
      responseBody: fr.responseBody,
      requestBody: fr.requestBody,
    });
  }

  diffs.sort((a, b) => {
    if (a.changedBetweenRuns && !b.changedBetweenRuns) return -1;
    if (!a.changedBetweenRuns && b.changedBetweenRuns) return 1;
    if (a.alsoFailedInPass && !b.alsoFailedInPass) return 1;
    if (!a.alsoFailedInPass && b.alsoFailedInPass) return -1;
    return 0;
  });

  return diffs;
}

/** Build the full comparison summary for AI consumption */
function buildComparisonSummary(
  testCase: NormalizedTestCase,
  currentAttempt: NormalizedTestResult | undefined,
  compare: CompareResult,
  failRequests: NetworkRequest[],
  passRequests: NetworkRequest[],
  attemptSummary: ReturnType<typeof getAttemptSummary>,
): ComparisonSummary {
  const passResult = compare.match.passingTest?.results.find(
    (r) => r.status === "passed"
  ) ?? compare.match.passingTest?.results[
    compare.match.passingTest.results.length - 1
  ];

  const failSteps = currentAttempt?.steps ?? [];
  const passSteps = passResult?.steps ?? [];
  const divIdx = attemptSummary.failingStep?.index ?? 0;
  const start = Math.max(0, divIdx - 3);
  const end = Math.min(Math.max(failSteps.length, passSteps.length), divIdx + 4);

  const stepDiffs: ComparisonSummary["stepDiffs"] = [];
  for (let i = start; i < end; i++) {
    const fs = failSteps[i];
    const ps = passSteps[i];
    let kind: ComparisonSummary["stepDiffs"][number]["kind"] = "same";
    let note: string | undefined;

    if (fs && !ps) {
      kind = "extra_in_fail";
    } else if (!fs && ps) {
      kind = "missing_in_fail";
    } else if (fs && ps) {
      if (!stepTitlesMatch(fs.title, ps.title)) {
        kind = "renamed";
        note = `"${ps.title}" → "${fs.title}"`;
      } else if (fs.error && !ps.error) {
        kind = "error_mismatch";
        note = fs.error.message?.replace(/\[\d+m/g, "").split("\n")[0];
      } else if (ps.duration > 0 && fs.duration > ps.duration * 3) {
        kind = "timing_shift";
        note = `${ps.duration}ms → ${fs.duration}ms`;
      }
    }

    if (kind !== "same") {
      stepDiffs.push({
        stepIndex: i,
        passTitle: ps?.title ?? null,
        failTitle: fs?.title ?? null,
        kind,
        note,
      });
    }
  }

  const requestDiffs = buildRequestDiffs(failRequests, passRequests);

  const failStderr = currentAttempt?.stderr ?? [];
  const passStderr = passResult?.stderr ?? [];
  const passStderrSet = new Set(passStderr);
  const consoleDiffs = failStderr.filter(
    (s) => !passStderrSet.has(s) && (s.toLowerCase().includes("error") || s.toLowerCase().includes("fail"))
  );

  const likelyRedHerrings: string[] = [];
  for (const rd of requestDiffs) {
    if (rd.alsoFailedInPass) {
      likelyRedHerrings.push(`${rd.method} ${rd.url} (${rd.failStatus <= 0 ? "ERR" : rd.failStatus}) — also failed in passing run`);
    }
  }

  const firstDivergence = attemptSummary.failingStep
    ? {
        stepIndex: attemptSummary.failingStep.index,
        kind: compare.firstDivergence?.type ?? "error_introduced",
        description: compare.firstDivergence?.description
          ?? `Step "${attemptSummary.failingStep.step.title}" failed`,
      }
    : compare.firstDivergence
      ? {
          stepIndex: compare.firstDivergence.stepIndex,
          kind: compare.firstDivergence.type,
          description: compare.firstDivergence.description,
        }
      : null;

  return {
    testName: testCase.fullTitle,
    filePath: testCase.filePath,
    attemptStatus: currentAttempt?.status ?? "unknown",
    errorHeadline: attemptSummary.errorHeadline,
    errorStack: currentAttempt?.error?.stack ?? currentAttempt?.error?.message ?? null,
    firstDivergence,
    stepDiffs,
    requestDiffs: requestDiffs.filter((r) => !r.alsoFailedInPass).slice(0, 8),
    consoleDiffs: consoleDiffs.slice(0, 5),
    likelyRedHerrings: likelyRedHerrings.slice(0, 5),
  };
}

export function ResultsView({ id }: { id: string }) {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [splitMode, setSplitMode] = useState(false);

  useEffect(() => {
    fetch(`/api/results/${id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load results");
        return res.json();
      })
      .then(setResult)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) {
    return <Alert color="red" variant="light">{error}</Alert>;
  }
  if (!result) {
    return <Text c="dimmed">Loading analysis...</Text>;
  }

  const { failingRun, passingRun, triageSummaries, compareResults } = result;
  const selected = triageSummaries[selectedIdx];
  const selectedCompare = compareResults[selectedIdx];

  return (
    <Stack gap="lg">
      {/* Run metadata */}
      <Paper p="lg" radius="md" bg="dark.6">
        <Group gap="xl" wrap="wrap" justify="space-between">
          <Group gap="xl" wrap="wrap">
            <RunMeta label="Failing run" run={failingRun} />
            {passingRun && <RunMeta label="Passing run" run={passingRun} />}
          </Group>
          {passingRun && (
            <Button
              onClick={() => setSplitMode((v) => !v)}
              size="sm"
              variant={splitMode ? "filled" : "outline"}
              color="blue"
            >
              {splitMode ? "Exit Compare" : "Compare"}
            </Button>
          )}
        </Group>
      </Paper>

      {splitMode ? (
        /* ── Split mode: narrow sidebar + 50/50 failing/passing ── */
        <Box style={{ display: "flex", gap: 16 }}>
          {/* Collapsed sidebar */}
          <Box style={{ width: 64, flexShrink: 0 }}>
            <Stack gap={4}>
              <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="xs">
                Tests
              </Text>
              {triageSummaries.map((ts, i) => (
                <Tooltip key={i} label={ts.testCase.fullTitle} position="right" withArrow>
                  <UnstyledButton
                    onClick={() => setSelectedIdx(i)}
                    p={6}
                    w="100%"
                    style={(theme) => ({
                      borderRadius: theme.radius.sm,
                      backgroundColor: i === selectedIdx ? "var(--mantine-color-dark-5)" : undefined,
                      textAlign: "center",
                    })}
                  >
                    <Badge
                      size="sm"
                      variant={i === selectedIdx ? "filled" : "light"}
                      color={ts.category === "app_regression" ? "red" : ts.category === "flaky_timing" ? "yellow" : "gray"}
                      w="100%"
                    >
                      {i + 1}
                    </Badge>
                  </UnstyledButton>
                </Tooltip>
              ))}
            </Stack>
          </Box>

          {/* Split panes */}
          <Box style={{ flex: 1, display: "flex", gap: 16, minWidth: 0 }}>
            {/* Left: Failing */}
            <Box style={{ width: "50%", overflowY: "auto", maxHeight: "calc(100vh - 160px)" }}>
              {selected && selectedCompare && (
                <DetailPanel
                  triage={selected}
                  compare={selectedCompare}
                  hasPassingRun={!!passingRun}
                  sessionId={id}
                  networkRequests={result.networkRequests ?? {}}
                  passingNetworkRequests={result.passingNetworkRequests ?? {}}
                />
              )}
            </Box>
            {/* Right: Passing */}
            <Box style={{ width: "50%", overflowY: "auto", maxHeight: "calc(100vh - 160px)" }}>
              {selectedCompare && (
                <PassingPanel
                  passingTest={selectedCompare.match.passingTest}
                  passingNetworkRequests={result.passingNetworkRequests ?? {}}
                  sessionId={id}
                />
              )}
            </Box>
          </Box>
        </Box>
      ) : (
        /* ── Normal mode: full sidebar + single detail panel ── */
        <Grid>
          {/* Test list sidebar */}
          <Grid.Col span={{ base: 12, lg: 3 }}>
            <Stack gap={4}>
              <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="xs">
                Failed tests ({triageSummaries.length})
              </Text>
              {triageSummaries.map((ts, i) => (
                <UnstyledButton
                  key={i}
                  onClick={() => setSelectedIdx(i)}
                  p="xs"
                  style={(theme) => ({
                    borderRadius: theme.radius.sm,
                    backgroundColor: i === selectedIdx ? "var(--mantine-color-dark-5)" : undefined,
                    "&:hover": { backgroundColor: "var(--mantine-color-dark-5)" },
                  })}
                >
                  <Text size="sm" fw={500} truncate="end">
                    {ts.testCase.fullTitle}
                  </Text>
                  <Group gap="xs" mt={4}>
                    <CategoryBadge category={ts.category} />
                    <ConfidenceBadge confidence={ts.confidence} />
                  </Group>
                </UnstyledButton>
              ))}
            </Stack>
          </Grid.Col>

          {/* Detail panel */}
          <Grid.Col span={{ base: 12, lg: 9 }}>
            {selected && selectedCompare && (
              <DetailPanel
                triage={selected}
                compare={selectedCompare}
                hasPassingRun={!!result.passingRun}
                sessionId={id}
                networkRequests={result.networkRequests ?? {}}
                passingNetworkRequests={result.passingNetworkRequests ?? {}}
              />
            )}
          </Grid.Col>
        </Grid>
      )}
    </Stack>
  );
}

function RunMeta({
  label,
  run,
}: {
  label: string;
  run: { commitSha?: string; branch?: string; stats: { total: number; passed: number; failed: number; flaky: number; skipped: number }; duration: number };
}) {
  return (
    <Stack gap={4}>
      <Text size="xs" fw={600} tt="uppercase" c="dimmed">
        {label}
      </Text>
      {run.commitSha && (
        <Code>{run.commitSha.slice(0, 8)}</Code>
      )}
      {run.branch && (
        <Text size="sm" c="dimmed">{run.branch}</Text>
      )}
      <Text size="sm" c="dimmed">
        {run.stats.total} tests | {run.stats.passed} passed | {run.stats.failed}{" "}
        failed | {Math.round(run.duration / 1000)}s
      </Text>
    </Stack>
  );
}

function DetailPanel({
  triage,
  compare,
  hasPassingRun,
  sessionId,
  networkRequests: networkRequestsMap,
  passingNetworkRequests: passingNetworkRequestsMap,
}: {
  triage: TriageSummary;
  compare: CompareResult;
  hasPassingRun: boolean;
  sessionId: string;
  networkRequests: Record<string, NetworkRequest[]>;
  passingNetworkRequests: Record<string, NetworkRequest[]>;
}) {
  const testCase = triage.testCase;
  const attempts = testCase.results;
  const [attemptIdx, setAttemptIdx] = useState(attempts.length - 1);
  const currentAttempt = attempts[attemptIdx];

  // AI triage state
  const [apiKey, setApiKey] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("lg-api-key") ?? "" : ""
  );
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [aiResults, setAiResults] = useState<Record<number, AiTriageResult>>({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  type ConvoMessage = { role: "user" | "assistant"; content: string };
  const storageKey = `lg-convo-${sessionId}-${testCase.id}`;

  const [conversations, setConversations] = useState<Record<number, ConvoMessage[]>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = sessionStorage.getItem(storageKey);
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });
  const [followUpInput, setFollowUpInput] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(storageKey, JSON.stringify(conversations));
  }, [conversations, storageKey]);

  const failingRequests = useMemo(() => {
    const key = `${testCase.id}:${currentAttempt?.attempt ?? 0}`;
    const all = networkRequestsMap[key] ?? [];
    return all.filter((r) => r.failed);
  }, [testCase.id, currentAttempt, networkRequestsMap]);

  const passingRequests = useMemo(() => {
    const passingTest = compare.match.passingTest;
    if (!passingTest) return [];
    const passResult = passingTest.results.find((r) => r.status === "passed")
      ?? passingTest.results[passingTest.results.length - 1];
    if (!passResult) return [];
    const key = `${passingTest.id}:${passResult.attempt}`;
    return passingNetworkRequestsMap[key] ?? [];
  }, [compare.match.passingTest, passingNetworkRequestsMap]);

  const attemptSummary = useMemo(
    () => getAttemptSummary(currentAttempt),
    [currentAttempt]
  );

  const attemptDivergence: Divergence | null = useMemo(() => {
    if (!attemptSummary.failingStep) return null;
    const { step, index } = attemptSummary.failingStep;
    const errorMsg = step.error?.message?.replace(/\[\d+m/g, "").split("\n")[0] ?? "unknown error";

    const passSteps = compare.match.passingTest?.results[
      compare.match.passingTest.results.length - 1
    ]?.steps;
    const passingStep = passSteps?.[index] ?? null;

    return {
      stepIndex: index,
      failingStep: step,
      passingStep,
      type: "error_introduced" as const,
      description: `Step "${step.title}" failed: ${errorMsg}`,
      significance: "high" as const,
    };
  }, [attemptSummary, compare]);

  const comparisonSummary = useMemo(() => {
    const allFailRequests = networkRequestsMap[`${testCase.id}:${currentAttempt?.attempt ?? 0}`] ?? [];
    return buildComparisonSummary(
      testCase, currentAttempt, compare, allFailRequests, passingRequests, attemptSummary,
    );
  }, [testCase, currentAttempt, compare, passingRequests, attemptSummary, networkRequestsMap]);

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
        [idx]: [{ role: "assistant" as const, content: data.rawResponse }],
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
    const updatedHistory = [...history, { role: "user" as const, content: text }];

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
        [idx]: [...updatedHistory, { role: "assistant" as const, content: data.rawResponse }],
      }));
      if (data.result) {
        setAiResults((prev) => ({ ...prev, [idx]: data.result }));
      }
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Follow-up failed");
    } finally {
      setAiLoading(false);
    }
  }, [apiKey, attemptIdx, followUpInput, conversations, comparisonSummary]);

  return (
    <Stack gap="md">
      <TriageCard triage={triage} suggestedNextStep={attemptSummary.suggestedNextStep} />

      {/* Attempt toggle */}
      {attempts.length > 1 && (
        <Paper p="md" radius="md" bg="dark.6">
          <Group gap="sm">
            <Text size="sm" fw={500} c="dimmed">Attempt:</Text>
            <Group gap={4}>
              {attempts.map((attempt, i) => (
                <Button
                  key={i}
                  onClick={() => setAttemptIdx(i)}
                  size="xs"
                  variant={i === attemptIdx ? "filled" : "subtle"}
                  color={i === attemptIdx
                    ? (attempt.status === "passed" ? "green" : "red")
                    : "gray"
                  }
                >
                  {i + 1}{" "}
                  <Text span size="xs" ml={4}>
                    {attempt.status === "passed" ? "pass" : "fail"}
                  </Text>
                </Button>
              ))}
            </Group>
            <Text size="xs" c="dimmed">
              {currentAttempt?.duration ? `${Math.round(currentAttempt.duration / 1000)}s` : ""}
            </Text>
          </Group>
        </Paper>
      )}

      {/* Per-attempt failing step */}
      {currentAttempt?.status !== "passed" && (
        <DivergenceCard
          divergence={attemptDivergence}
          hasPassingRun={hasPassingRun}
        />
      )}

      {/* Per-attempt error */}
      {currentAttempt?.error && (
        <Paper p="lg" radius="md" bg="dark.6">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed">
            Error{attempts.length > 1 ? ` — attempt ${attemptIdx + 1}` : ""}
          </Text>
          <ErrorBlock message={currentAttempt.error.message ?? ""} stack={currentAttempt.error.stack} />
        </Paper>
      )}

      {/* Non-2xx network requests for this attempt */}
      {failingRequests.length > 0 && (
        <NetworkRequestsPanel
          requests={failingRequests}
          attemptLabel={attempts.length > 1 ? attemptIdx + 1 : undefined}
        />
      )}

      <EvidenceCard
        evidence={triage.evidence}
        artifacts={currentAttempt?.artifacts ?? []}
        sessionId={sessionId}
      />

      {/* AI Triage */}
      <Paper p="lg" radius="md" bg="dark.6">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed">
            AI Diagnosis
          </Text>
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
        {conversations[attemptIdx] && conversations[attemptIdx].length > 1 && (
          <Stack gap="sm" mt="md">
            {conversations[attemptIdx].slice(1).map((msg, i) => {
              if (msg.role === "user") {
                return (
                  <Paper key={i} p="sm" radius="sm" bg="dark.5" ml="xl">
                    <Text size="xs" fw={500} tt="uppercase" c="dimmed" mb={4}>You</Text>
                    <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{msg.content}</Text>
                  </Paper>
                );
              }
              const parsed = tryParseTriageResult(msg.content);
              if (parsed) {
                return <AiTriageResultCard key={i} result={parsed} />;
              }
              return (
                <Paper key={i} p="sm" radius="sm" mr="xl" withBorder style={{ borderColor: "var(--mantine-color-violet-9)" }}>
                  <Text size="xs" fw={500} tt="uppercase" c="dimmed" mb={4}>AI</Text>
                  <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{msg.content}</Text>
                </Paper>
              );
            })}
            {aiLoading && (
              <Paper p="sm" radius="sm" mr="xl" withBorder style={{ borderColor: "var(--mantine-color-violet-9)" }}>
                <Text size="sm" c="dimmed">Thinking...</Text>
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
                if (e.key === "Enter" && !e.shiftKey && followUpInput.trim()) {
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
      </Paper>

      <AttemptSteps attempt={currentAttempt} attemptIdx={attemptIdx} compare={compare} hasPassingRun={hasPassingRun} />
    </Stack>
  );
}

function TriageCard({ triage, suggestedNextStep }: { triage: TriageSummary; suggestedNextStep?: string }) {
  return (
    <Paper p="lg" radius="md" bg="dark.6">
      <Title order={3}>{triage.testCase.fullTitle}</Title>
      <Text size="sm" mt="xs">{triage.summary}</Text>
      <Group gap="sm" mt="md">
        <CategoryBadge category={triage.category} />
        <ConfidenceBadge confidence={triage.confidence} />
      </Group>
      <Paper p="sm" radius="sm" mt="md" bg="dark.5">
        <Text size="sm">
          <Text span fw={500}>Next step: </Text>
          {suggestedNextStep ?? triage.suggestedNextStep}
        </Text>
      </Paper>
    </Paper>
  );
}

function DivergenceCard({
  divergence,
  hasPassingRun,
}: {
  divergence: Divergence | null;
  hasPassingRun: boolean;
}) {
  if (!divergence) {
    return (
      <Paper p="lg" radius="md" withBorder>
        <Text c="dimmed">
          {hasPassingRun
            ? "No step-level divergence detected."
            : "No failing step identified."}
        </Text>
      </Paper>
    );
  }

  if (!hasPassingRun) {
    return (
      <Alert variant="light" color="red" title={`Failing step — step ${divergence.stepIndex}`} radius="md">
        <Code block>{divergence.failingStep?.title ?? "Unknown step"}</Code>
        <Text size="sm" c="dimmed" mt="xs">
          {divergence.description}
        </Text>
        <Group gap="xs" mt="sm">
          <Badge size="sm" variant="outline" color="gray">
            Significance: {divergence.significance}
          </Badge>
        </Group>
      </Alert>
    );
  }

  return (
    <Alert variant="light" color="yellow" title={`First divergence — step ${divergence.stepIndex}`} radius="md">
      <Text size="sm">{divergence.description}</Text>
      <Group gap="xs" mt="sm">
        <Badge size="sm" variant="outline" color="gray">
          Type: {divergence.type.replace(/_/g, " ")}
        </Badge>
        <Badge size="sm" variant="outline" color="gray">
          Significance: {divergence.significance}
        </Badge>
      </Group>
      <SimpleGrid cols={2} mt="md" spacing="md">
        <Box>
          <Text size="xs" fw={600} tt="uppercase" c="red">
            Failing step
          </Text>
          <Code block style={{ fontSize: "var(--mantine-font-size-xs)" }}>
            {divergence.failingStep?.title ?? "—"}
          </Code>
        </Box>
        <Box>
          <Text size="xs" fw={600} tt="uppercase" c="green">
            Passing step
          </Text>
          <Code block style={{ fontSize: "var(--mantine-font-size-xs)" }}>
            {divergence.passingStep?.title ?? "—"}
          </Code>
        </Box>
      </SimpleGrid>
    </Alert>
  );
}

export function EvidenceCard({
  evidence,
  artifacts,
  sessionId,
}: {
  evidence: EvidenceItem[];
  artifacts: Artifact[];
  sessionId: string;
}) {
  const items = evidence.filter((e) => e.type !== "error_message");
  const screenshots = artifacts.filter(
    (a) => a.type === "screenshot" && a.contentType.startsWith("image/")
  );
  const videos = artifacts.filter(
    (a) => a.type === "video" && a.contentType.startsWith("video/")
  );

  if (items.length === 0 && screenshots.length === 0 && videos.length === 0) return null;

  return (
    <Paper p="lg" radius="md" bg="dark.6">
      <Text size="xs" fw={600} tt="uppercase" c="dimmed">
        Evidence
      </Text>
      {items.length > 0 && (
        <List spacing="xs" mt="sm" size="sm">
          {items.map((e, i) => (
            <List.Item
              key={i}
              icon={<EvidenceIcon type={e.type} />}
            >
              {e.description}
            </List.Item>
          ))}
        </List>
      )}
      {screenshots.length > 0 && (
        <Box mt="md">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="sm">
            Screenshots
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            {screenshots.map((s, i) => (
              <Card key={i} padding={0} radius="sm" withBorder>
                <Card.Section>
                  <Image
                    src={`/api/artifacts/${sessionId}?path=${encodeURIComponent(s.path)}`}
                    alt={s.name}
                    style={{ cursor: "pointer" }}
                    onClick={() => window.open(`/api/artifacts/${sessionId}?path=${encodeURIComponent(s.path)}`, "_blank")}
                  />
                </Card.Section>
                <Text size="xs" c="dimmed" p="xs" truncate="end">
                  {s.name}
                </Text>
              </Card>
            ))}
          </SimpleGrid>
        </Box>
      )}
      {videos.length > 0 && (
        <Box mt="md">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="sm">
            Videos
          </Text>
          <Stack gap="md">
            {videos.map((v, i) => (
              <Card key={i} padding={0} radius="sm" withBorder>
                <Card.Section>
                  <video
                    src={`/api/artifacts/${sessionId}?path=${encodeURIComponent(v.path)}`}
                    controls
                    style={{ width: "100%", display: "block" }}
                  />
                </Card.Section>
                <Text size="xs" c="dimmed" p="xs" truncate="end">
                  {v.name}
                </Text>
              </Card>
            ))}
          </Stack>
        </Box>
      )}
    </Paper>
  );
}

function ErrorBlock({ message, stack }: { message: string; stack?: string }) {
  const clean = message.replace(/\[\d+m/g, "");
  const cleanStack = stack?.replace(/\[\d+m/g, "") ?? "";

  const lines = clean.split("\n");
  const headline = lines[0] ?? "";
  const messageDetail = lines.slice(1).join("\n").trim();

  const detail = cleanStack && cleanStack !== clean ? cleanStack : messageDetail;

  return (
    <Box mt="sm">
      <Paper p="sm" radius="sm" bg="red.9" style={{ borderBottomLeftRadius: detail ? 0 : undefined, borderBottomRightRadius: detail ? 0 : undefined }}>
        <Text size="sm" fw={500} c="red.2" style={{ wordBreak: "break-word" }}>
          {headline}
        </Text>
      </Paper>
      {detail && (
        <CodeHighlight
          code={detail}
          language="javascript"
          withCopyButton={false}
          styles={{
            codeHighlight: { borderTopLeftRadius: 0, borderTopRightRadius: 0, maxHeight: 256, overflow: "auto", fontSize: "var(--mantine-font-size-xs)" },
          }}
        />
      )}
    </Box>
  );
}

function AttemptSteps({
  attempt,
  attemptIdx,
  compare,
  hasPassingRun,
}: {
  attempt: { steps: { title: string; duration: number; error?: { message?: string } }[] } | undefined;
  attemptIdx: number;
  compare: CompareResult;
  hasPassingRun: boolean;
}) {
  const steps = attempt?.steps ?? [];
  const passSteps =
    compare.match.passingTest?.results[
      compare.match.passingTest.results.length - 1
    ]?.steps ?? [];

  if (steps.length === 0 && passSteps.length === 0) return null;

  if (!hasPassingRun || passSteps.length === 0) {
    return (
      <Paper p="lg" radius="md" bg="dark.6">
        <Text size="xs" fw={600} tt="uppercase" c="dimmed">
          Test steps{compare.match.failingTest.results.length > 1 ? ` — attempt ${attemptIdx + 1}` : ""}
        </Text>
        <Table mt="md" fz="xs" horizontalSpacing="xs" verticalSpacing={6}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={40}>#</Table.Th>
              <Table.Th w={64}>Status</Table.Th>
              <Table.Th>Step</Table.Th>
              <Table.Th w={72}>Duration</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {steps.map((step, i) => {
              const hasError = !!step.error;
              return (
                <Table.Tr
                  key={i}
                  bg={hasError ? "rgba(220, 38, 38, 0.1)" : undefined}
                >
                  <Table.Td c="dimmed">{i}</Table.Td>
                  <Table.Td>
                    <Badge size="xs" color={hasError ? "red" : "green"} variant="light">
                      {hasError ? "fail" : "pass"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" truncate="end">{step.title}</Text>
                    {step.error?.message && (
                      <Text size="xs" c="red" truncate="end" mt={2}>
                        {step.error.message.slice(0, 80)}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td c="dimmed">{step.duration}ms</Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Paper>
    );
  }

  const maxLen = Math.max(steps.length, passSteps.length);

  return (
    <Paper p="lg" radius="md" bg="dark.6">
      <Text size="xs" fw={600} tt="uppercase" c="dimmed">
        Step-by-step comparison{compare.match.failingTest.results.length > 1 ? ` — attempt ${attemptIdx + 1}` : ""}
      </Text>
      <Box mt="md" style={{ overflow: "auto" }}>
        <Table fz="xs" horizontalSpacing="xs" verticalSpacing={6}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={40}>#</Table.Th>
              <Table.Th c="red">Failing</Table.Th>
              <Table.Th w={56} c="red">ms</Table.Th>
              <Table.Th c="green">Passing</Table.Th>
              <Table.Th w={56} c="green">ms</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {Array.from({ length: maxLen }, (_, i) => {
              const fs = steps[i];
              const ps = passSteps[i];
              const isDivergent =
                (fs && ps && !stepTitlesMatch(fs.title, ps.title)) ||
                (fs && !ps && i < passSteps.length) ||
                (!fs && ps && i < steps.length) ||
                (fs?.error && !ps?.error);

              return (
                <Table.Tr
                  key={i}
                  bg={isDivergent ? "rgba(217, 119, 6, 0.1)" : undefined}
                >
                  <Table.Td c="dimmed">{i}</Table.Td>
                  <Table.Td>
                    <Text size="xs" truncate="end">
                      {fs?.title ?? "—"}
                      {fs?.error?.message && (
                        <Text span size="xs" c="red" ml={4}>
                          {fs.error.message.slice(0, 40)}
                        </Text>
                      )}
                    </Text>
                  </Table.Td>
                  <Table.Td c="dimmed">
                    {fs?.duration ?? "—"}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" truncate="end">{ps?.title ?? "—"}</Text>
                  </Table.Td>
                  <Table.Td c="dimmed">
                    {ps?.duration ?? "—"}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Box>
    </Paper>
  );
}


// ---- AI Triage Result ----

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
    <Paper p="md" radius="sm" mt="md" withBorder style={{ borderColor: "var(--mantine-color-violet-9)" }}>
      {/* Category + confidence */}
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
            result.confidence === "high" ? "green" :
            result.confidence === "medium" ? "yellow" :
            "dimmed"
          }
        >
          {result.confidence} confidence
        </Text>
      </Group>

      {/* Diagnosis */}
      <Text size="sm">{result.diagnosis}</Text>

      {/* Evidence */}
      {result.primaryEvidence.length > 0 && (
        <Box mt="sm">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={4}>Evidence</Text>
          <List spacing={4} size="xs">
            {result.primaryEvidence.map((e: string, i: number) => (
              <List.Item key={i} icon={<Text size="xs" c="green" fw={700}>+</Text>}>
                <Text size="xs" c="dimmed">{e}</Text>
              </List.Item>
            ))}
          </List>
        </Box>
      )}

      {/* Counter-evidence */}
      {result.counterEvidence.length > 0 && (
        <Box mt="sm">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={4}>Counter-evidence</Text>
          <List spacing={4} size="xs">
            {result.counterEvidence.map((e: string, i: number) => (
              <List.Item key={i} icon={<Text size="xs" c="dimmed" fw={700}>-</Text>}>
                <Text size="xs" c="dimmed">{e}</Text>
              </List.Item>
            ))}
          </List>
        </Box>
      )}

      {/* Suggested next step */}
      <Paper p="xs" radius="sm" mt="sm" bg="dark.5">
        <Text size="xs">
          <Text span fw={500}>Next step: </Text>
          {result.suggestedNextStep}
        </Text>
      </Paper>
    </Paper>
  );
}

// ---- Small UI components ----

function CategoryBadge({ category }: { category: string }) {
  const colors: Record<string, string> = {
    app_regression: "red",
    flaky_timing: "yellow",
    environment_issue: "blue",
    test_bug: "violet",
    unknown: "gray",
  };

  return (
    <Badge size="sm" variant="light" color={colors[category] ?? "gray"}>
      {category.replace(/_/g, " ")}
    </Badge>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const color =
    confidence === "high" ? "green" :
    confidence === "medium" ? "yellow" :
    "gray";

  return (
    <Text size="xs" c={color}>
      {confidence} confidence
    </Text>
  );
}

export function EvidenceIcon({ type }: { type: string }) {
  const icons: Record<string, string> = {
    screenshot_diff: "img",
    trace_step: "trc",
    console_error: "err",
    request_failure: "req",
    assertion_mismatch: "ast",
    timing_anomaly: "clk",
    error_message: "msg",
  };

  return (
    <Badge size="sm" variant="filled" color="dark.5" fw={700} tt="uppercase" style={{ fontSize: 10 }}>
      {icons[type] ?? "?"}
    </Badge>
  );
}
