"use client";

import { useEffect, useState } from "react";
import type { AnalysisResult } from "../../api/upload/route";
import type {
  TriageSummary,
  NormalizedTestCase,
  Divergence,
  EvidenceItem,
} from "@last-green/core";
import type { CompareResult } from "@last-green/core";

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
          <div className="flex flex-col gap-6">
            <TriageCard triage={selected} />
            <DivergenceCard divergence={selected.firstDivergence} />
            <EvidenceCard evidence={selected.evidence} />
            <StepComparison compare={selectedCompare} />
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

function TriageCard({ triage }: { triage: TriageSummary }) {
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
        {triage.suggestedNextStep}
      </div>
    </section>
  );
}

function DivergenceCard({
  divergence,
}: {
  divergence: Divergence | null;
}) {
  if (!divergence) {
    return (
      <section className="rounded-lg border border-zinc-800 p-6 text-zinc-500">
        No step-level divergence detected.
      </section>
    );
  }

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

function EvidenceCard({ evidence }: { evidence: EvidenceItem[] }) {
  if (evidence.length === 0) return null;

  return (
    <section className="rounded-lg bg-zinc-900 p-6">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
        Evidence
      </h4>
      <ul className="mt-3 flex flex-col gap-2">
        {evidence.map((e, i) => (
          <li key={i} className="flex items-start gap-3 text-sm">
            <EvidenceIcon type={e.type} />
            <span className="text-zinc-300">{e.description}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StepComparison({ compare }: { compare: CompareResult }) {
  const failSteps =
    compare.match.failingTest.results[
      compare.match.failingTest.results.length - 1
    ]?.steps ?? [];
  const passSteps =
    compare.match.passingTest?.results[
      compare.match.passingTest.results.length - 1
    ]?.steps ?? [];

  if (failSteps.length === 0 && passSteps.length === 0) return null;

  const maxLen = Math.max(failSteps.length, passSteps.length);

  return (
    <section className="rounded-lg bg-zinc-900 p-6">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
        Step-by-step comparison
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
              const fs = failSteps[i];
              const ps = passSteps[i];
              const isDivergent =
                (fs && ps && fs.title !== ps.title) ||
                (fs && !ps) ||
                (!fs && ps) ||
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
                    {fs?.error && (
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
