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

const NETWORK_STEP_PATTERNS = [
  /^apiRequestContext\./i,
  /^page\.goto/i,
  /^page\.request\./i,
  /^request\./i,
  /^page\.route/i,
  /^browserContext\.route/i,
];

/** Extract failing network/API steps from an attempt (flat + recursive) */
function getFailingNetworkSteps(
  steps: NormalizedStep[]
): { title: string; duration: number; error: string }[] {
  const results: { title: string; duration: number; error: string }[] = [];

  function walk(stepList: NormalizedStep[]) {
    for (const step of stepList) {
      if (step.error) {
        const isNetwork =
          NETWORK_STEP_PATTERNS.some((p) => p.test(step.title)) ||
          step.category === "pw:api" && (
            step.title.toLowerCase().includes("request") ||
            step.title.toLowerCase().includes("goto") ||
            step.title.toLowerCase().includes("fetch") ||
            step.title.toLowerCase().includes("route")
          );
        const errorLower = step.error.message?.toLowerCase() ?? "";
        const isNetworkError =
          errorLower.includes("econnrefused") ||
          errorLower.includes("enotfound") ||
          errorLower.includes("net::err") ||
          errorLower.includes("econnreset") ||
          errorLower.includes("fetch") ||
          errorLower.includes("404") ||
          errorLower.includes("500") ||
          errorLower.includes("502") ||
          errorLower.includes("503") ||
          errorLower.includes("api") ||
          errorLower.includes("network");

        if (isNetwork || isNetworkError) {
          const cleanMsg = (step.error.message ?? "unknown error").replace(/\[\d+m/g, "").split("\n")[0];
          results.push({
            title: step.title,
            duration: step.duration,
            error: cleanMsg,
          });
        }
      }
      if (step.children?.length) walk(step.children);
    }
  }

  walk(steps);
  return results;
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

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[300px_1fr]">
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
          <DetailPanel
            triage={selected}
            compare={selectedCompare}
            hasPassingRun={!!result.passingRun}
            sessionId={id}
          />
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
}: {
  triage: TriageSummary;
  compare: CompareResult;
  hasPassingRun: boolean;
  sessionId: string;
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
  const [aiSuggestions, setAiSuggestions] = useState<Record<number, string>>({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Failing network requests for current attempt
  const failingRequests = useMemo(
    () => getFailingNetworkSteps(currentAttempt?.steps ?? []),
    [currentAttempt]
  );

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
      const res = await fetch("/api/ai-triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          context: {
            testName: testCase.fullTitle,
            filePath: testCase.filePath,
            category: triage.category,
            errorHeadline: attemptSummary.errorHeadline,
            errorStack: currentAttempt?.error?.stack ?? currentAttempt?.error?.message ?? null,
            divergence: attemptDivergence
              ? {
                  stepIndex: attemptDivergence.stepIndex,
                  failingStepTitle: attemptDivergence.failingStep?.title ?? null,
                  passingStepTitle: attemptDivergence.passingStep?.title ?? null,
                  type: attemptDivergence.type,
                  description: attemptDivergence.description,
                }
              : null,
            evidence: triage.evidence.map((e) => ({
              type: e.type,
              description: e.description,
            })),
            suggestedNextStep: attemptSummary.suggestedNextStep,
            attemptStatus: currentAttempt?.status ?? "unknown",
            passingRun: (() => {
              const passResult = compare.match.passingTest?.results.find(
                (r) => r.status === "passed"
              ) ?? compare.match.passingTest?.results[compare.match.passingTest.results.length - 1];
              if (!passResult) return null;
              const divIdx = attemptDivergence?.stepIndex ?? 0;
              const start = Math.max(0, divIdx - 2);
              const end = Math.min(passResult.steps.length, divIdx + 3);
              return {
                status: passResult.status,
                duration: passResult.duration,
                stepsAroundDivergence: passResult.steps.slice(start, end).map((s, i) => ({
                  index: start + i,
                  title: s.title,
                  duration: s.duration,
                  error: s.error?.message ?? null,
                })),
                totalSteps: passResult.steps.length,
              };
            })(),
            failingRequests,
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setAiSuggestions((prev) => ({ ...prev, [idx]: data.suggestion }));
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI triage failed");
    } finally {
      setAiLoading(false);
    }
  }, [apiKey, attemptIdx, testCase, triage, attemptSummary, attemptDivergence, currentAttempt, failingRequests]);

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

      {/* Failing network requests for this attempt */}
      {failingRequests.length > 0 && (
        <section className="rounded-lg border border-orange-800/30 bg-orange-950/10 p-6">
          <h4 className="text-sm font-semibold uppercase tracking-wider text-orange-400">
            Failing network requests{attempts.length > 1 ? ` — attempt ${attemptIdx + 1}` : ""} ({failingRequests.length})
          </h4>
          <div className="mt-3 flex flex-col gap-2">
            {failingRequests.map((r, i) => (
              <div key={i} className="rounded-md bg-zinc-900 px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-zinc-200">{r.title}</span>
                  <span className="text-xs text-zinc-500">{r.duration}ms</span>
                </div>
                <div className="mt-1 text-sm text-orange-300/80">{r.error}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <EvidenceCard
        evidence={triage.evidence}
        artifacts={currentAttempt?.artifacts ?? []}
        sessionId={sessionId}
      />

      {/* AI Triage */}
      <section className="rounded-lg bg-zinc-900 p-6">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            AI Diagnosis
          </h4>
          <div className="flex items-center gap-2">
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
              {aiLoading ? "Analyzing..." : aiSuggestions[attemptIdx] ? "Re-analyze" : "Diagnose with AI"}
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
        {aiSuggestions[attemptIdx] && (
          <div className="mt-4 rounded-md bg-violet-950/20 border border-violet-800/30 px-4 py-3 text-sm leading-relaxed text-zinc-300">
            {aiSuggestions[attemptIdx]}
          </div>
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
      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-xs font-semibold uppercase text-red-400">
            Failing step
          </span>
          <p className="mt-1 font-mono text-zinc-300">
            {divergence.failingStep?.title ?? "—"}
          </p>
        </div>
        <div>
          <span className="text-xs font-semibold uppercase text-emerald-400">
            Passing step
          </span>
          <p className="mt-1 font-mono text-zinc-300">
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
      <div className="rounded-t-md bg-red-950/40 px-4 py-2 text-sm font-medium text-red-300">
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
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
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
                    <td className="px-2 py-1.5 font-mono text-zinc-600">{i}</td>
                    <td className="px-2 py-1.5">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          hasError
                            ? "bg-red-900/40 text-red-300"
                            : "bg-emerald-900/40 text-emerald-300"
                        }`}
                      >
                        {hasError ? "failed" : "passed"}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-zinc-300">
                      {step.title}
                      {step.error?.message && (
                        <div className="mt-1 text-xs text-red-400">
                          {step.error.message.slice(0, 120)}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-zinc-500">
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
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
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
                  <td className="px-2 py-1.5 font-mono text-zinc-600">{i}</td>
                  <td className="px-2 py-1.5 font-mono text-zinc-300">
                    {fs?.title ?? "—"}
                    {fs?.error?.message && (
                      <span className="ml-2 text-red-400">
                        {fs.error.message.slice(0, 60)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-zinc-500">
                    {fs?.duration ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-zinc-300">
                    {ps?.title ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-zinc-500">
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
