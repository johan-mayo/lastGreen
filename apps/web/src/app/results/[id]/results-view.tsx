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
    // Check children but return the parent step with the parent's index
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

  // Generate context-specific next step suggestion per attempt
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
  // Only consider 4xx, 5xx, and connection errors
  const diagnosticFail = failRequests.filter(
    (r) => (r.status >= 400 || r.status <= 0) && !isIrrelevantRequest(r)
  );

  // Index passing requests by method+pathname for lookup
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

    // Check if same endpoint also failed in passing run
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

  // Sort: changed-between-runs first, also-failed-in-pass last
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

  // Step diffs around divergence
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

  // Request diffs
  const requestDiffs = buildRequestDiffs(failRequests, passRequests);

  // Console diffs — stderr lines only in failing attempt
  const failStderr = currentAttempt?.stderr ?? [];
  const passStderr = passResult?.stderr ?? [];
  const passStderrSet = new Set(passStderr);
  const consoleDiffs = failStderr.filter(
    (s) => !passStderrSet.has(s) && (s.toLowerCase().includes("error") || s.toLowerCase().includes("fail"))
  );

  // Red herrings
  const likelyRedHerrings: string[] = [];
  for (const rd of requestDiffs) {
    if (rd.alsoFailedInPass) {
      likelyRedHerrings.push(`${rd.method} ${rd.url} (${rd.failStatus <= 0 ? "ERR" : rd.failStatus}) — also failed in passing run`);
    }
  }

  // Build divergence info from the compare engine's result for this attempt
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
    return (
      <div className="rounded-lg bg-red-900/20 p-6 text-red-400">{error}</div>
    );
  }
  if (!result) {
    return <div className="text-zinc-500">Loading analysis...</div>;
  }

  const { failingRun, passingRun, triageSummaries, compareResults } = result;
  const selected = triageSummaries[selectedIdx];
  const selectedCompare = compareResults[selectedIdx];

  return (
    <div className="flex flex-col gap-8">
      {/* Run metadata */}
      <section className="flex flex-wrap gap-6 rounded-lg bg-zinc-900 p-6">
        <RunMeta label="Failing run" run={failingRun} />
        {passingRun && <RunMeta label="Passing run" run={passingRun} />}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
        {/* Test list sidebar */}
        <aside className="flex flex-col gap-1">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Failed tests ({triageSummaries.length})
          </h2>
          {triageSummaries.map((ts, i) => (
            <button
              key={i}
              onClick={() => setSelectedIdx(i)}
              className={`rounded-md px-3 py-2 text-left text-sm transition-colors ${
                i === selectedIdx
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
              }`}
            >
              <div className="truncate font-medium">
                {ts.testCase.fullTitle}
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <CategoryBadge category={ts.category} />
                <ConfidenceBadge confidence={ts.confidence} />
              </div>
            </button>
          ))}
        </aside>

        {/* Detail panel */}
        {selected && selectedCompare && (
          <div className="min-w-0">
          <DetailPanel
            triage={selected}
            compare={selectedCompare}
            hasPassingRun={!!result.passingRun}
            sessionId={id}
            networkRequests={result.networkRequests ?? {}}
            passingNetworkRequests={result.passingNetworkRequests ?? {}}
          />
          </div>
        )}
      </div>
    </div>
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
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {run.commitSha && (
        <span className="font-mono text-sm text-zinc-300">
          {run.commitSha.slice(0, 8)}
        </span>
      )}
      {run.branch && (
        <span className="text-sm text-zinc-400">{run.branch}</span>
      )}
      <span className="text-sm text-zinc-500">
        {run.stats.total} tests | {run.stats.passed} passed | {run.stats.failed}{" "}
        failed | {Math.round(run.duration / 1000)}s
      </span>
    </div>
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

  // Failing network requests for current attempt
  const failingRequests = useMemo(() => {
    const key = `${testCase.id}:${currentAttempt?.attempt ?? 0}`;
    const all = networkRequestsMap[key] ?? [];
    return all.filter((r) => r.failed);
  }, [testCase.id, currentAttempt, networkRequestsMap]);

  // Passing network requests for comparison
  const passingRequests = useMemo(() => {
    const passingTest = compare.match.passingTest;
    if (!passingTest) return [];
    const passResult = passingTest.results.find((r) => r.status === "passed")
      ?? passingTest.results[passingTest.results.length - 1];
    if (!passResult) return [];
    const key = `${passingTest.id}:${passResult.attempt}`;
    return passingNetworkRequestsMap[key] ?? [];
  }, [compare.match.passingTest, passingNetworkRequestsMap]);

  // Compute per-attempt analysis
  const attemptSummary = useMemo(
    () => getAttemptSummary(currentAttempt),
    [currentAttempt]
  );

  // Build a per-attempt divergence from the failing step
  const attemptDivergence: Divergence | null = useMemo(() => {
    if (!attemptSummary.failingStep) return null;
    const { step, index } = attemptSummary.failingStep;
    const errorMsg = step.error?.message?.replace(/\[\d+m/g, "").split("\n")[0] ?? "unknown error";

    // Look up the corresponding passing step if we have a passing run
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
      // Build deterministic comparison summary — all filtering happens here, not in the LLM
      const allFailRequests = networkRequestsMap[`${testCase.id}:${currentAttempt?.attempt ?? 0}`] ?? [];
      const comparison = buildComparisonSummary(
        testCase,
        currentAttempt,
        compare,
        allFailRequests,
        passingRequests,
        attemptSummary,
      );

      const res = await fetch("/api/ai-triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, comparison }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setAiResults((prev) => ({ ...prev, [idx]: data.result }));
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI triage failed");
    } finally {
      setAiLoading(false);
    }
  }, [apiKey, attemptIdx, testCase, currentAttempt, compare, passingRequests, attemptSummary, networkRequestsMap]);

  return (
    <div className="flex flex-col gap-6">
      <TriageCard triage={triage} suggestedNextStep={attemptSummary.suggestedNextStep} />

      {/* Attempt toggle */}
      {attempts.length > 1 && (
        <section className="flex items-center gap-3 rounded-lg bg-zinc-900 px-6 py-4">
          <span className="text-sm font-medium text-zinc-400">Attempt:</span>
          <div className="flex gap-1">
            {attempts.map((attempt, i) => (
              <button
                key={i}
                onClick={() => setAttemptIdx(i)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  i === attemptIdx
                    ? attempt.status === "passed"
                      ? "bg-emerald-900/50 text-emerald-300"
                      : "bg-red-900/50 text-red-300"
                    : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {i + 1}
                <span className="ml-1.5 text-xs">
                  {attempt.status === "passed" ? "pass" : "fail"}
                </span>
              </button>
            ))}
          </div>
          <span className="text-xs text-zinc-600">
            {currentAttempt?.duration ? `${Math.round(currentAttempt.duration / 1000)}s` : ""}
          </span>
        </section>
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
        <section className="rounded-lg bg-zinc-900 p-6">
          <h4 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Error{attempts.length > 1 ? ` — attempt ${attemptIdx + 1}` : ""}
          </h4>
          <ErrorBlock message={currentAttempt.error.message ?? ""} stack={currentAttempt.error.stack} />
        </section>
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
      <section className="rounded-lg bg-zinc-900 p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h4 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            AI Diagnosis
          </h4>
          <div className="flex items-center gap-2 flex-wrap">
            {showKeyInput && (
              <input
                type="password"
                placeholder="Anthropic API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && apiKey.trim()) {
                    setShowKeyInput(false);
                    requestAiTriage();
                  }
                }}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none w-64"
              />
            )}
            <button
              onClick={() => {
                if (!apiKey.trim()) {
                  setShowKeyInput(true);
                } else {
                  requestAiTriage();
                }
              }}
              disabled={aiLoading}
              className="rounded-md bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {aiLoading
                ? "Analyzing..."
                : aiResults[attemptIdx]
                  ? "Re-analyze"
                  : "Diagnose with AI"}
            </button>
            {apiKey && (
              <button
                onClick={() => setShowKeyInput(!showKeyInput)}
                className="text-xs text-zinc-600 hover:text-zinc-400"
                title="Toggle API key input"
              >
                key
              </button>
            )}
          </div>
        </div>
        {aiError && (
          <div className="mt-3 rounded-md bg-red-950/30 px-4 py-2 text-sm text-red-400">
            {aiError}
          </div>
        )}
        {aiResults[attemptIdx] && (
          <AiTriageResultCard result={aiResults[attemptIdx]} />
        )}
      </section>

      <AttemptSteps attempt={currentAttempt} attemptIdx={attemptIdx} compare={compare} hasPassingRun={hasPassingRun} />
    </div>
  );
}

function TriageCard({ triage, suggestedNextStep }: { triage: TriageSummary; suggestedNextStep?: string }) {
  return (
    <section className="rounded-lg bg-zinc-900 p-6">
      <h3 className="text-lg font-semibold">{triage.testCase.fullTitle}</h3>
      <p className="mt-2 text-sm text-zinc-300">{triage.summary}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <CategoryBadge category={triage.category} />
        <ConfidenceBadge confidence={triage.confidence} />
      </div>
      <div className="mt-4 rounded-md bg-zinc-800 px-4 py-3 text-sm text-zinc-300">
        <span className="font-medium text-zinc-100">Next step: </span>
        {suggestedNextStep ?? triage.suggestedNextStep}
      </div>
    </section>
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
      <section className="rounded-lg border border-zinc-800 p-6 text-zinc-500">
        {hasPassingRun
          ? "No step-level divergence detected."
          : "No failing step identified."}
      </section>
    );
  }

  // Single-run mode: show the failing step, not a "divergence"
  if (!hasPassingRun) {
    return (
      <section className="rounded-lg border border-red-700/40 bg-red-950/20 p-6">
        <h4 className="text-sm font-semibold uppercase tracking-wider text-red-400">
          Failing step — step {divergence.stepIndex}
        </h4>
        <p className="mt-2 font-mono text-sm text-zinc-200">
          {divergence.failingStep?.title ?? "Unknown step"}
        </p>
        <p className="mt-2 text-sm text-zinc-400">
          {divergence.description}
        </p>
        <div className="mt-3 flex gap-3 text-xs">
          <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400">
            Significance: {divergence.significance}
          </span>
        </div>
      </section>
    );
  }

  // Two-run mode: show side-by-side divergence
  return (
    <section className="rounded-lg border border-amber-700/40 bg-amber-950/20 p-6">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-amber-400">
        First divergence — step {divergence.stepIndex}
      </h4>
      <p className="mt-2 text-sm text-zinc-200">{divergence.description}</p>
      <div className="mt-3 flex gap-3 text-xs">
        <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400">
          Type: {divergence.type.replace(/_/g, " ")}
        </span>
        <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400">
          Significance: {divergence.significance}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 text-sm overflow-hidden">
        <div className="min-w-0">
          <span className="text-xs font-semibold uppercase text-red-400">
            Failing step
          </span>
          <p className="mt-1 font-mono text-xs text-zinc-300 truncate">
            {divergence.failingStep?.title ?? "—"}
          </p>
        </div>
        <div className="min-w-0">
          <span className="text-xs font-semibold uppercase text-emerald-400">
            Passing step
          </span>
          <p className="mt-1 font-mono text-xs text-zinc-300 truncate">
            {divergence.passingStep?.title ?? "—"}
          </p>
        </div>
      </div>
    </section>
  );
}

function EvidenceCard({
  evidence,
  artifacts,
  sessionId,
}: {
  evidence: EvidenceItem[];
  artifacts: Artifact[];
  sessionId: string;
}) {
  // Filter out error_message items — shown separately in per-attempt error block
  const items = evidence.filter((e) => e.type !== "error_message");
  const screenshots = artifacts.filter(
    (a) => a.type === "screenshot" && a.contentType.startsWith("image/")
  );
  const videos = artifacts.filter(
    (a) => a.type === "video" && a.contentType.startsWith("video/")
  );

  if (items.length === 0 && screenshots.length === 0 && videos.length === 0) return null;

  return (
    <section className="rounded-lg bg-zinc-900 p-6">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
        Evidence
      </h4>
      {items.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((e, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              <EvidenceIcon type={e.type} />
              <span className="text-zinc-300">{e.description}</span>
            </li>
          ))}
        </ul>
      )}
      {screenshots.length > 0 && (
        <div className="mt-4">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
            Screenshots
          </h5>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {screenshots.map((s, i) => (
              <div key={i} className="overflow-hidden rounded-md border border-zinc-800">
                <img
                  src={`/api/artifacts/${sessionId}?path=${encodeURIComponent(s.path)}`}
                  alt={s.name}
                  className="w-full cursor-pointer hover:opacity-90 transition-opacity"
                  loading="lazy"
                  onClick={() => window.open(`/api/artifacts/${sessionId}?path=${encodeURIComponent(s.path)}`, "_blank")}
                />
                <div className="bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 truncate">
                  {s.name}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {videos.length > 0 && (
        <div className="mt-4">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
            Videos
          </h5>
          <div className="flex flex-col gap-4">
            {videos.map((v, i) => (
              <div key={i} className="overflow-hidden rounded-md border border-zinc-800">
                <video
                  src={`/api/artifacts/${sessionId}?path=${encodeURIComponent(v.path)}`}
                  controls
                  className="w-full"
                />
                <div className="bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 truncate">
                  {v.name}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ErrorBlock({ message, stack }: { message: string; stack?: string }) {
  // Strip ANSI escape codes
  const clean = message.replace(/\[\d+m/g, "");
  const cleanStack = stack?.replace(/\[\d+m/g, "") ?? "";

  // Split message into headline and detail
  const lines = clean.split("\n");
  const headline = lines[0] ?? "";
  const messageDetail = lines.slice(1).join("\n").trim();

  // Use stack if available and different from message, otherwise fall back to message detail
  const detail = cleanStack && cleanStack !== clean ? cleanStack : messageDetail;

  return (
    <div className="mt-3">
      <div className="rounded-t-md bg-red-950/40 px-4 py-2 text-sm font-medium text-red-300 break-words">
        {headline}
      </div>
      {detail && (
        <pre className="max-h-64 overflow-auto rounded-b-md bg-zinc-950 px-4 py-3 font-mono text-xs leading-relaxed text-zinc-400 whitespace-pre-wrap">
          {detail}
        </pre>
      )}
    </div>
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

  // Single report: show steps with pass/fail status
  if (!hasPassingRun || passSteps.length === 0) {
    return (
      <section className="rounded-lg bg-zinc-900 p-6">
        <h4 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Test steps{compare.match.failingTest.results.length > 1 ? ` — attempt ${attemptIdx + 1}` : ""}
        </h4>
        <div className="mt-4 overflow-hidden">
          <table className="w-full table-fixed text-left text-xs">
            <colgroup>
              <col className="w-8" />
              <col className="w-16" />
              <col />
              <col className="w-16" />
            </colgroup>
            <thead>
              <tr className="border-b border-zinc-800 text-xs uppercase text-zinc-500">
                <th className="px-2 py-2">#</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Step</th>
                <th className="px-2 py-2">Duration</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step, i) => {
                const hasError = !!step.error;
                return (
                  <tr
                    key={i}
                    className={`border-b border-zinc-800/50 ${
                      hasError ? "bg-red-950/20" : ""
                    }`}
                  >
                    <td className="px-2 py-1.5 text-zinc-600">{i}</td>
                    <td className="px-2 py-1.5">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          hasError
                            ? "bg-red-900/40 text-red-300"
                            : "bg-emerald-900/40 text-emerald-300"
                        }`}
                      >
                        {hasError ? "fail" : "pass"}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-zinc-300 truncate">
                      {step.title}
                      {step.error?.message && (
                        <div className="mt-1 text-xs text-red-400 truncate">
                          {step.error.message.slice(0, 80)}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-zinc-500">
                      {step.duration}ms
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  // Two reports: side-by-side comparison
  const maxLen = Math.max(steps.length, passSteps.length);

  return (
    <section className="rounded-lg bg-zinc-900 p-6">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
        Step-by-step comparison{compare.match.failingTest.results.length > 1 ? ` — attempt ${attemptIdx + 1}` : ""}
      </h4>
      <div className="mt-4 overflow-hidden">
        <table className="w-full table-fixed text-left text-xs">
          <colgroup>
            <col className="w-8" />
            <col />
            <col className="w-14" />
            <col />
            <col className="w-14" />
          </colgroup>
          <thead>
            <tr className="border-b border-zinc-800 text-xs uppercase text-zinc-500">
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2 text-red-400">Failing</th>
              <th className="px-2 py-2 text-red-400">ms</th>
              <th className="px-2 py-2 text-emerald-400">Passing</th>
              <th className="px-2 py-2 text-emerald-400">ms</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: maxLen }, (_, i) => {
              const fs = steps[i];
              const ps = passSteps[i];
              const isDivergent =
                (fs && ps && !stepTitlesMatch(fs.title, ps.title)) ||
                (fs && !ps && i < passSteps.length) ||
                (!fs && ps && i < steps.length) ||
                (fs?.error && !ps?.error);

              return (
                <tr
                  key={i}
                  className={`border-b border-zinc-800/50 ${
                    isDivergent ? "bg-amber-950/20" : ""
                  }`}
                >
                  <td className="px-2 py-1.5 text-zinc-600">{i}</td>
                  <td className="px-2 py-1.5 text-zinc-300 truncate">
                    {fs?.title ?? "—"}
                    {fs?.error?.message && (
                      <span className="ml-1 text-red-400">
                        {fs.error.message.slice(0, 40)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-zinc-500">
                    {fs?.duration ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 text-zinc-300 truncate">
                    {ps?.title ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 text-zinc-500">
                    {ps?.duration ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- Network Requests Panel ----

const STATUS_FILTERS = [
  { label: "All", value: "all" },
  { label: "4xx", value: "4xx" },
  { label: "5xx", value: "5xx" },
  { label: "3xx", value: "3xx" },
  { label: "ERR", value: "err" },
] as const;

function NetworkRequestsPanel({
  requests,
  attemptLabel,
}: {
  requests: NetworkRequest[];
  attemptLabel?: number;
}) {
  const [urlFilter, setUrlFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const filtered = useMemo(() => {
    return requests.filter((r) => {
      if (urlFilter && !r.url.toLowerCase().includes(urlFilter.toLowerCase())) return false;
      if (statusFilter === "4xx" && (r.status < 400 || r.status >= 500)) return false;
      if (statusFilter === "5xx" && r.status < 500) return false;
      if (statusFilter === "3xx" && (r.status < 300 || r.status >= 400)) return false;
      if (statusFilter === "err" && r.status > 0) return false;
      return true;
    });
  }, [requests, urlFilter, statusFilter]);

  return (
    <section className="rounded-lg border border-orange-800/30 bg-orange-950/10 p-6">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-orange-400">
        Non-2xx network requests{attemptLabel ? ` — attempt ${attemptLabel}` : ""} ({filtered.length}/{requests.length})
      </h4>

      {/* Filters */}
      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Filter by URL..."
          value={urlFilter}
          onChange={(e) => setUrlFilter(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-orange-500 focus:outline-none flex-1 min-w-[150px] max-w-[300px]"
        />
        <div className="flex gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(statusFilter === f.value ? "all" : f.value)}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                statusFilter === f.value
                  ? "bg-orange-700 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Request list */}
      <div className="mt-3 flex flex-col gap-1">
        {filtered.map((r, i) => (
          <div key={i} className="rounded-md bg-zinc-900 overflow-hidden">
            <button
              onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
              className="w-full px-4 py-2.5 text-left hover:bg-zinc-800/50 transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-400">
                    {r.method}
                  </span>
                  <span className="font-mono text-xs text-zinc-200 truncate">{r.url}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <StatusBadge status={r.status} />
                  <span className="text-xs text-zinc-500 w-12 text-right">{r.duration}ms</span>
                  <span className="text-zinc-600 text-xs">{expandedIdx === i ? "▲" : "▼"}</span>
                </div>
              </div>
            </button>

            {expandedIdx === i && (
              <div className="border-t border-zinc-800 px-4 py-3 text-xs">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Request side */}
                  <div className="min-w-0">
                    <h5 className="font-semibold text-zinc-400 uppercase tracking-wider mb-2">Request</h5>
                    {r.requestContentType && (
                      <div className="text-zinc-500 mb-1">Content-Type: {r.requestContentType}</div>
                    )}
                    {r.requestHeaders && r.requestHeaders.length > 0 && (
                      <details className="mb-2">
                        <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
                          Headers ({r.requestHeaders.length})
                        </summary>
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-950 p-2 text-zinc-400 whitespace-pre-wrap break-all">
                          {r.requestHeaders.map((h) => `${h.name}: ${h.value}`).join("\n")}
                        </pre>
                      </details>
                    )}
                    {r.requestBody ? (
                      <div>
                        <div className="text-zinc-500 mb-1">Body:</div>
                        <pre className="max-h-48 overflow-auto rounded bg-zinc-950 p-2 text-zinc-300 whitespace-pre-wrap break-all">
                          {formatBody(r.requestBody, r.requestContentType)}
                        </pre>
                      </div>
                    ) : (
                      <div className="text-zinc-600 italic">No request body</div>
                    )}
                  </div>

                  {/* Response side */}
                  <div className="min-w-0">
                    <h5 className="font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                      Response — {r.status <= 0 ? "Failed" : r.status} {r.statusText}
                    </h5>
                    {r.responseContentType && (
                      <div className="text-zinc-500 mb-1">Content-Type: {r.responseContentType}</div>
                    )}
                    {r.responseHeaders && r.responseHeaders.length > 0 && (
                      <details className="mb-2">
                        <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
                          Headers ({r.responseHeaders.length})
                        </summary>
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-950 p-2 text-zinc-400 whitespace-pre-wrap break-all">
                          {r.responseHeaders.map((h) => `${h.name}: ${h.value}`).join("\n")}
                        </pre>
                      </details>
                    )}
                    {r.responseBody ? (
                      <div>
                        <div className="text-zinc-500 mb-1">Body:</div>
                        <pre className="max-h-48 overflow-auto rounded bg-zinc-950 p-2 text-zinc-300 whitespace-pre-wrap break-all">
                          {formatBody(r.responseBody, r.responseContentType)}
                        </pre>
                      </div>
                    ) : (
                      <div className="text-zinc-600 italic">No response body</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-zinc-600 text-xs py-2">No requests match filters.</div>
        )}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: number }) {
  const cls =
    status >= 500 ? "bg-red-900/50 text-red-300" :
    status >= 400 ? "bg-orange-900/50 text-orange-300" :
    status >= 300 ? "bg-yellow-900/50 text-yellow-300" :
    status <= 0 ? "bg-red-900/50 text-red-300" :
    "bg-zinc-800 text-zinc-400";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${cls}`}>
      {status <= 0 ? "ERR" : status}
    </span>
  );
}

function formatBody(body: string, contentType?: string): string {
  if (contentType?.includes("json") || body.startsWith("{") || body.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch { /* not valid JSON */ }
  }
  return body;
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
  app_regression: "bg-red-900/40 text-red-300",
  ui_change_or_outdated_test: "bg-amber-900/40 text-amber-300",
  timing_or_flake: "bg-yellow-900/40 text-yellow-300",
  environment_issue: "bg-blue-900/40 text-blue-300",
  unknown: "bg-zinc-800 text-zinc-400",
};

function AiTriageResultCard({ result }: { result: AiTriageResult }) {
  return (
    <div className="mt-4 rounded-md bg-violet-950/20 border border-violet-800/30 px-4 py-4 text-sm">
      {/* Category + confidence */}
      <div className="flex items-center gap-3 mb-3">
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${AI_CATEGORY_COLORS[result.category] ?? AI_CATEGORY_COLORS.unknown}`}>
          {AI_CATEGORY_LABELS[result.category] ?? result.category}
        </span>
        <span className={`text-xs ${
          result.confidence === "high" ? "text-emerald-400" :
          result.confidence === "medium" ? "text-yellow-400" :
          "text-zinc-500"
        }`}>
          {result.confidence} confidence
        </span>
      </div>

      {/* Diagnosis */}
      <p className="leading-relaxed text-zinc-300">{result.diagnosis}</p>

      {/* Evidence */}
      {result.primaryEvidence.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">Evidence</h5>
          <ul className="flex flex-col gap-1">
            {result.primaryEvidence.map((e: string, i: number) => (
              <li key={i} className="text-xs text-zinc-400 flex items-start gap-2">
                <span className="text-emerald-600 mt-0.5 shrink-0">+</span>
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Counter-evidence */}
      {result.counterEvidence.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">Counter-evidence</h5>
          <ul className="flex flex-col gap-1">
            {result.counterEvidence.map((e: string, i: number) => (
              <li key={i} className="text-xs text-zinc-500 flex items-start gap-2">
                <span className="text-zinc-600 mt-0.5 shrink-0">-</span>
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Suggested next step */}
      <div className="mt-3 rounded bg-zinc-800/50 px-3 py-2 text-xs text-zinc-300">
        <span className="font-medium text-zinc-100">Next step: </span>
        {result.suggestedNextStep}
      </div>
    </div>
  );
}

// ---- Small UI components ----

function CategoryBadge({
  category,
}: {
  category: string;
}) {
  const colors: Record<string, string> = {
    app_regression: "bg-red-900/40 text-red-300",
    flaky_timing: "bg-yellow-900/40 text-yellow-300",
    environment_issue: "bg-blue-900/40 text-blue-300",
    test_bug: "bg-purple-900/40 text-purple-300",
    unknown: "bg-zinc-800 text-zinc-400",
  };

  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[category] ?? colors.unknown}`}
    >
      {category.replace(/_/g, " ")}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const colors: Record<string, string> = {
    high: "text-emerald-400",
    medium: "text-yellow-400",
    low: "text-zinc-500",
  };

  return (
    <span className={`text-xs ${colors[confidence] ?? "text-zinc-500"}`}>
      {confidence} confidence
    </span>
  );
}

function EvidenceIcon({ type }: { type: string }) {
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
    <span className="flex h-6 w-8 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] font-bold uppercase text-zinc-500">
      {icons[type] ?? "?"}
    </span>
  );
}
