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

/**
 * Compare a failing test to its matched passing test.
 * Identifies step diffs and the first meaningful divergence.
 */
export function compareTestPair(match: TestMatch): CompareResult {
  const { failingTest, passingTest } = match;

  // Use last result (final attempt after retries) for comparison
  const failResult = getLastResult(failingTest);
  const passResult = passingTest ? getLastPassingResult(passingTest) : null;

  const stepDiffs = diffSteps(
    failResult?.steps ?? [],
    passResult?.steps ?? []
  );

  const firstDivergence = findFirstDivergence(
    failResult?.steps ?? [],
    passResult?.steps ?? []
  );

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
      if (fail.title !== pass.title) {
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

function findFirstDivergence(
  failSteps: NormalizedStep[],
  passSteps: NormalizedStep[]
): Divergence | null {
  const maxLen = Math.max(failSteps.length, passSteps.length);

  for (let i = 0; i < maxLen; i++) {
    const fail = failSteps[i];
    const pass = passSteps[i];

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
      if (fail.title !== pass.title) {
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
