import type {
  NormalizedTestCase,
  NormalizedTestResult,
  NormalizedStep,
  TestMatch,
  StepDiff,
  Divergence,
} from "../types/index.js";

export interface CompareResult {
  match: TestMatch;
  stepDiffs: StepDiff[];
  firstDivergence: Divergence | null;
  timingDelta: number | null;
  errorComparison: ErrorComparison | null;
}

export interface ErrorComparison {
  failingError: string;
  passingError: string | null;
  isSameError: boolean;
}

const TIMING_SPIKE_FACTOR = 3;

// Patterns to normalize in step titles before comparison
// UUIDs, hex hashes, timestamps, numeric IDs
const DYNAMIC_PATTERNS = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // UUID
  /[0-9a-f]{16,}/gi,  // long hex strings
  /\b\d{10,}\b/g,     // timestamps / long numeric IDs
];

/** Normalize a step title for comparison by stripping dynamic values */
function normalizeStepTitle(title: string): string {
  let normalized = title;
  for (const pattern of DYNAMIC_PATTERNS) {
    normalized = normalized.replace(pattern, "<dynamic>");
  }
  return normalized;
}

/** Compare two step titles, ignoring dynamic values like UUIDs */
function stepTitlesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeStepTitle(a) === normalizeStepTitle(b);
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

/**
 * Compare a failing test to its matched passing test.
 * Identifies step diffs and the first meaningful divergence.
 */
export function compareTestPair(match: TestMatch): CompareResult {
  const { failingTest, passingTest } = match;

  // Use last result (final attempt after retries) for comparison
  const failResult = getLastResult(failingTest);
  const passResult = passingTest ? getLastPassingResult(passingTest) : null;

  let stepDiffs: StepDiff[];
  let firstDivergence: Divergence | null;

  if (passResult) {
    // Two-run comparison: diff steps between passing and failing
    stepDiffs = diffSteps(failResult?.steps ?? [], passResult.steps);
    firstDivergence = findFirstDivergence(
      failResult?.steps ?? [],
      passResult.steps
    );
  } else {
    // Single-run: find the first step that actually failed
    stepDiffs = [];
    firstDivergence = findFailingStep(failResult?.steps ?? []);
  }

  const timingDelta =
    failResult && passResult
      ? failResult.duration - passResult.duration
      : null;

  const errorComparison = buildErrorComparison(failResult, passResult);

  return {
    match,
    stepDiffs,
    firstDivergence,
    timingDelta,
    errorComparison,
  };
}

function getLastResult(test: NormalizedTestCase): NormalizedTestResult | undefined {
  return test.results[test.results.length - 1];
}

function getLastPassingResult(test: NormalizedTestCase): NormalizedTestResult | undefined {
  const passing = test.results.find((r) => r.status === "passed");
  return passing ?? test.results[test.results.length - 1];
}

function diffSteps(
  failSteps: NormalizedStep[],
  passSteps: NormalizedStep[]
): StepDiff[] {
  const diffs: StepDiff[] = [];
  const maxLen = Math.max(failSteps.length, passSteps.length);

  for (let i = 0; i < maxLen; i++) {
    const fail = failSteps[i] ?? null;
    const pass = passSteps[i] ?? null;

    if (!fail && pass) {
      diffs.push({
        failingStep: null,
        passingStep: pass,
        type: "removed",
        description: `Step "${pass.title}" present in passing run but missing in failing run`,
      });
    } else if (fail && !pass) {
      diffs.push({
        failingStep: fail,
        passingStep: null,
        type: "added",
        description: `Step "${fail.title}" present in failing run but not in passing run`,
      });
    } else if (fail && pass) {
      if (!stepTitlesMatch(fail.title, pass.title)) {
        diffs.push({
          failingStep: fail,
          passingStep: pass,
          type: "changed",
          description: `Step changed from "${pass.title}" to "${fail.title}"`,
        });
      } else if (fail.error && !pass.error) {
        diffs.push({
          failingStep: fail,
          passingStep: pass,
          type: "error",
          description: `Step "${fail.title}" errored in failing run: ${fail.error.message}`,
        });
      } else if (
        pass.duration > 0 &&
        fail.duration > pass.duration * TIMING_SPIKE_FACTOR
      ) {
        diffs.push({
          failingStep: fail,
          passingStep: pass,
          type: "timing",
          description: `Step "${fail.title}" took ${fail.duration}ms vs ${pass.duration}ms (${Math.round(fail.duration / pass.duration)}x slower)`,
        });
      }
    }
  }

  return diffs;
}

/**
 * Single-run mode: find the first step that actually errored.
 * Skips Playwright lifecycle steps (Before/After Hooks, Worker Cleanup).
 */
function findFailingStep(steps: NormalizedStep[]): Divergence | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (step.error && !LIFECYCLE_STEPS.has(step.title)) {
      return {
        stepIndex: i,
        failingStep: step,
        passingStep: null,
        type: "error_introduced",
        description: `Step "${step.title}" failed: ${step.error.message?.slice(0, 150) ?? "unknown error"}`,
        significance: "high",
      };
    }

    // Recurse into children
    if (step.children.length > 0) {
      const child = findFailingStep(step.children);
      if (child) return child;
    }
  }

  return null;
}

/**
 * Two-run mode: find first meaningful divergence between passing and failing steps.
 * Skips lifecycle steps that are just Playwright infrastructure noise.
 */
function findFirstDivergence(
  failSteps: NormalizedStep[],
  passSteps: NormalizedStep[]
): Divergence | null {
  // Filter out lifecycle steps for comparison purposes
  const filteredFail = failSteps.filter((s) => !LIFECYCLE_STEPS.has(s.title));
  const filteredPass = passSteps.filter((s) => !LIFECYCLE_STEPS.has(s.title));
  const maxLen = Math.max(filteredFail.length, filteredPass.length);

  for (let i = 0; i < maxLen; i++) {
    const fail = filteredFail[i];
    const pass = filteredPass[i];

    // Step exists in fail but not pass
    if (fail && !pass) {
      return {
        stepIndex: i,
        failingStep: fail,
        passingStep: null,
        type: "step_added",
        description: `Failing run has extra step "${fail.title}" at position ${i}`,
        significance: fail.error ? "high" : "medium",
      };
    }

    // Step exists in pass but not fail
    if (!fail && pass) {
      return {
        stepIndex: i,
        failingStep: null,
        passingStep: pass,
        type: "step_missing",
        description: `Step "${pass.title}" at position ${i} is missing in the failing run`,
        significance: "high",
      };
    }

    if (fail && pass) {
      // Step name changed = likely different flow path
      if (!stepTitlesMatch(fail.title, pass.title)) {
        return {
          stepIndex: i,
          failingStep: fail,
          passingStep: pass,
          type: "step_order",
          description: `Step ${i} diverges: failing has "${fail.title}", passing has "${pass.title}"`,
          significance: "high",
        };
      }

      // Error introduced at this step
      if (fail.error && !pass.error) {
        return {
          stepIndex: i,
          failingStep: fail,
          passingStep: pass,
          type: "error_introduced",
          description: `Step "${fail.title}" errored in failing run: ${fail.error.message}`,
          significance: "high",
        };
      }

      // Timing spike
      if (
        pass.duration > 0 &&
        fail.duration > pass.duration * TIMING_SPIKE_FACTOR
      ) {
        return {
          stepIndex: i,
          failingStep: fail,
          passingStep: pass,
          type: "timing_spike",
          description: `Step "${fail.title}" took ${fail.duration}ms vs ${pass.duration}ms`,
          significance: "medium",
        };
      }

      // Recurse into child steps
      if (fail.children.length > 0 || pass.children.length > 0) {
        const childDivergence = findFirstDivergence(fail.children, pass.children);
        if (childDivergence) return childDivergence;
      }
    }
  }

  return null;
}

function buildErrorComparison(
  failResult: NormalizedTestResult | undefined | null,
  passResult: NormalizedTestResult | undefined | null
): ErrorComparison | null {
  if (!failResult?.error) return null;

  return {
    failingError: failResult.error.message,
    passingError: passResult?.error?.message ?? null,
    isSameError:
      passResult?.error?.message !== undefined &&
      failResult.error.message === passResult.error.message,
  };
}
