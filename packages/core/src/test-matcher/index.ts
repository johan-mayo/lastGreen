import type {
  NormalizedRun,
  NormalizedTestCase,
  TestMatch,
  Comparison,
} from "../types/index.js";

/**
 * Match test cases between a failing run and a passing run.
 * V1: exact match only by filePath + fullTitle + projectName.
 */
export function matchTests(
  failingRun: NormalizedRun,
  passingRun: NormalizedRun | null
): Comparison {
  if (!passingRun) {
    return {
      matchedTests: failingRun.testCases
        .filter((t) => t.status === "failed" || t.status === "timedOut")
        .map((t) => ({
          failingTest: t,
          passingTest: null,
          matchConfidence: "none" as const,
        })),
      unmatchedFailing: [],
      unmatchedPassing: [],
      failingRun,
      passingRun: null,
    };
  }

  const passingIndex = buildIndex(passingRun.testCases);
  const matchedTests: TestMatch[] = [];
  const unmatchedFailing: NormalizedTestCase[] = [];
  const matchedPassingKeys = new Set<string>();

  const failedTests = failingRun.testCases.filter(
    (t) => t.status === "failed" || t.status === "timedOut" || t.status === "flaky"
  );

  for (const failingTest of failedTests) {
    const key = makeKey(failingTest);
    const passingTest = passingIndex.get(key);

    if (passingTest) {
      matchedTests.push({
        failingTest,
        passingTest,
        matchConfidence: "exact",
      });
      matchedPassingKeys.add(key);
    } else {
      matchedTests.push({
        failingTest,
        passingTest: null,
        matchConfidence: "none",
      });
      unmatchedFailing.push(failingTest);
    }
  }

  const unmatchedPassing = passingRun.testCases.filter(
    (t) => !matchedPassingKeys.has(makeKey(t))
  );

  return {
    matchedTests,
    unmatchedFailing,
    unmatchedPassing,
    failingRun,
    passingRun,
  };
}

function makeKey(test: NormalizedTestCase): string {
  return `${test.filePath}::${test.fullTitle}::${test.projectName}`;
}

function buildIndex(
  tests: NormalizedTestCase[]
): Map<string, NormalizedTestCase> {
  const map = new Map<string, NormalizedTestCase>();
  for (const test of tests) {
    map.set(makeKey(test), test);
  }
  return map;
}
