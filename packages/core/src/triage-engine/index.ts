import type {
  TriageSummary,
  TriageCategory,
  ConfidenceLevel,
  EvidenceItem,
  NormalizedTestCase,
  Divergence,
} from "../types/index.js";
import type { CompareResult } from "../compare-engine/index.js";

/**
 * Generate a triage summary for a compared test pair.
 * Uses deterministic heuristics (no LLM) to categorize and explain failures.
 */
export function triageTest(compareResult: CompareResult): TriageSummary {
  const { match, firstDivergence, errorComparison, timingDelta, stepDiffs } =
    compareResult;
  const failingTest = match.failingTest;
  const hasPassingRun = match.passingTest !== null;

  const evidence: EvidenceItem[] = [];
  let category: TriageCategory = "unknown";
  let confidence: ConfidenceLevel = "low";
  let suggestedNextStep = "Review the test failure details and error message.";

  // Collect evidence from error
  if (errorComparison) {
    evidence.push({
      type: "error_message",
      description: errorComparison.failingError,
    });
  }

  // Collect evidence from artifacts
  const lastResult = failingTest.results[failingTest.results.length - 1];
  if (lastResult) {
    for (const artifact of lastResult.artifacts) {
      if (artifact.type === "screenshot") {
        evidence.push({
          type: "screenshot_diff",
          description: `Screenshot captured: ${artifact.name}`,
          artifactRef: artifact.path,
        });
      }
      if (artifact.type === "trace") {
        evidence.push({
          type: "trace_step",
          description: `Trace file available: ${artifact.name}`,
          artifactRef: artifact.path,
        });
      }
    }

    // Console errors
    const stderrErrors = lastResult.stderr.filter(
      (s) => s.toLowerCase().includes("error") || s.toLowerCase().includes("fail")
    );
    for (const err of stderrErrors) {
      evidence.push({
        type: "console_error",
        description: err,
      });
    }
  }

  // Divergence-based evidence
  if (firstDivergence) {
    evidence.push({
      type: "trace_step",
      description: firstDivergence.description,
      stepRef: `step[${firstDivergence.stepIndex}]`,
    });
  }

  // --- Categorization heuristics ---

  const errorMsg = errorComparison?.failingError?.toLowerCase() ?? "";

  // Timing/flaky signals
  if (
    failingTest.status === "timedOut" ||
    errorMsg.includes("timeout") ||
    errorMsg.includes("timed out")
  ) {
    if (firstDivergence?.type === "timing_spike") {
      category = "flaky_timing";
      confidence = "medium";
      suggestedNextStep =
        "Check if the test timeout is too aggressive or if the app is under load. Look at the timing delta.";
    } else {
      category = "flaky_timing";
      confidence = "low";
      suggestedNextStep =
        "This looks like a timeout. Check network conditions, app performance, or increase the test timeout.";
    }
  }
  // Environment signals
  else if (
    errorMsg.includes("econnrefused") ||
    errorMsg.includes("enotfound") ||
    errorMsg.includes("net::err") ||
    errorMsg.includes("econnreset") ||
    errorMsg.includes("dns") ||
    errorMsg.includes("certificate") ||
    errorMsg.includes("ssl")
  ) {
    category = "environment_issue";
    confidence = "medium";
    suggestedNextStep =
      "This looks like a network or environment issue. Check that the test environment is running and accessible.";
  }
  // Assertion failure with divergence = likely app regression
  else if (
    (errorMsg.includes("expect(") || errorMsg.includes("toequal") || errorMsg.includes("tobe") || errorMsg.includes("tohave")) &&
    hasPassingRun &&
    firstDivergence
  ) {
    category = "app_regression";
    confidence = "medium";
    suggestedNextStep = `Assertion failed at step ${firstDivergence.stepIndex}. Compare the failing and passing screenshots/traces to see what changed in the app.`;
  }
  // Locator/selector errors = possibly test bug
  else if (
    errorMsg.includes("locator") ||
    errorMsg.includes("selector") ||
    errorMsg.includes("no element") ||
    errorMsg.includes("strict mode violation")
  ) {
    if (hasPassingRun && firstDivergence) {
      category = "app_regression";
      confidence = "low";
      suggestedNextStep =
        "An element is missing or changed. Check if the app changed the DOM structure, or if the test selector needs updating.";
    } else {
      category = "test_bug";
      confidence = "low";
      suggestedNextStep =
        "The test cannot find an element. Check if selectors are correct and the page is fully loaded.";
    }
  }
  // Has divergence but no strong signal
  else if (firstDivergence && hasPassingRun) {
    category = "app_regression";
    confidence = "low";
    suggestedNextStep = `First divergence at step ${firstDivergence.stepIndex}: "${firstDivergence.description}". Compare artifacts at this step.`;
  }

  // Boost confidence if we have a passing run and a clear divergence
  if (
    hasPassingRun &&
    firstDivergence?.significance === "high" &&
    confidence === "low"
  ) {
    confidence = "medium";
  }

  const summary = buildSummaryText(
    failingTest,
    category,
    confidence,
    firstDivergence,
    hasPassingRun
  );

  return {
    testCase: failingTest,
    category,
    confidence,
    firstDivergence,
    evidence,
    suggestedNextStep,
    summary,
  };
}

function buildSummaryText(
  test: NormalizedTestCase,
  category: TriageCategory,
  confidence: ConfidenceLevel,
  divergence: Divergence | null,
  hasPassingRun: boolean
): string {
  const categoryLabel: Record<TriageCategory, string> = {
    app_regression: "App Regression",
    flaky_timing: "Flaky / Timing Issue",
    environment_issue: "Environment Issue",
    test_bug: "Test Bug",
    unknown: "Unknown",
  };

  let text = `Test "${test.fullTitle}" failed.`;
  text += ` Triage: ${categoryLabel[category]} (${confidence} confidence).`;

  if (divergence) {
    text += ` First divergence: ${divergence.description}.`;
  } else if (hasPassingRun) {
    text += " No clear step-level divergence found between passing and failing runs.";
  } else {
    text += " No passing run available for comparison.";
  }

  return text;
}
