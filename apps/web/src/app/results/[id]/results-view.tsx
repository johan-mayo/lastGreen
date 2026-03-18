"use client";

import { useEffect, useState, useMemo } from "react";
import type { AnalysisResult } from "../../api/upload/route";
import type {
  TriageSummary,
  NormalizedTestCase,
  NormalizedTestResult,
  NormalizedStep,
  Divergence,
  NetworkRequest,
  ComparisonSummary,
  RequestDiff,
} from "@last-green/core";
import type { CompareResult } from "@last-green/core";
import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Grid,
  Group,
  Paper,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { PassingPanel } from "./passing-panel";
import { NetworkRequestsPanel } from "../../components/network-requests-panel";
import { AccordionCard } from "./accordion-card";
import { TriageCard, CategoryBadge, ConfidenceBadge } from "./triage-card";
import { ErrorBlock } from "./error-card";
import { EvidenceCard, hasEvidenceContent } from "./evidence-card";
import { AiDiagnosisCard } from "./ai-diagnosis-card";
import { TestStepsCard } from "./test-steps-card";

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
        /* -- Split mode: narrow sidebar + 50/50 failing/passing -- */
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
        /* -- Normal mode: full sidebar + single detail panel -- */
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

  return (
    <Stack gap="md">
      <AccordionCard title="Triage Summary">
        <TriageCard triage={triage} suggestedNextStep={attemptSummary.suggestedNextStep} />
      </AccordionCard>

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

      {/* Test steps + divergence */}
      <AccordionCard title="Test Steps">
        <TestStepsCard
          divergence={currentAttempt?.status !== "passed" ? attemptDivergence : null}
          attempt={currentAttempt}
          compare={compare}
          hasPassingRun={hasPassingRun}
        />
      </AccordionCard>

      {/* Per-attempt error + AI diagnosis */}
      {currentAttempt?.error && (
        <AccordionCard title="Error">
          <Stack gap="md">
            <ErrorBlock message={currentAttempt.error.message ?? ""} stack={currentAttempt.error.stack} />
            <AiDiagnosisCard
              comparisonSummary={comparisonSummary}
              attemptIdx={attemptIdx}
              sessionId={sessionId}
              testCaseId={testCase.id}
            />
          </Stack>
        </AccordionCard>
      )}

      {/* Non-2xx network requests for this attempt */}
      {failingRequests.length > 0 && (
        <AccordionCard title={`Network Requests (${failingRequests.length})`}>
          <NetworkRequestsPanel
            requests={failingRequests}
            attemptLabel={attempts.length > 1 ? attemptIdx + 1 : undefined}
          />
        </AccordionCard>
      )}

      {hasEvidenceContent(triage.evidence, currentAttempt?.artifacts ?? []) && (
        <AccordionCard title="Evidence">
          <EvidenceCard
            evidence={triage.evidence}
            artifacts={currentAttempt?.artifacts ?? []}
            sessionId={sessionId}
          />
        </AccordionCard>
      )}

    </Stack>
  );
}
