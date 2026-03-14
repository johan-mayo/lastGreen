// ---- Raw Playwright JSON report shapes ----

export interface PlaywrightJsonReport {
  config: PlaywrightConfig;
  suites: PlaywrightSuite[];
  errors: unknown[];
  stats: PlaywrightStats;
}

export interface PlaywrightConfig {
  configFile?: string;
  rootDir?: string;
  metadata?: Record<string, unknown>;
  projects: PlaywrightProject[];
}

export interface PlaywrightProject {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface PlaywrightStats {
  startTime: string;
  duration: number;
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
}

export interface PlaywrightSuite {
  title: string;
  file: string;
  line: number;
  column: number;
  specs: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

export interface PlaywrightSpec {
  title: string;
  ok: boolean;
  tags: string[];
  tests: PlaywrightTest[];
  id: string;
  file: string;
  line: number;
  column: number;
}

export interface PlaywrightTest {
  timeout: number;
  annotations: unknown[];
  expectedStatus: string;
  projectId: string;
  projectName: string;
  results: PlaywrightTestResult[];
  status: "expected" | "unexpected" | "flaky" | "skipped";
}

export interface PlaywrightTestResult {
  workerIndex: number;
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  errors: PlaywrightError[];
  stdout: string[];
  stderr: string[];
  retry: number;
  startTime: string;
  attachments: PlaywrightAttachment[];
  steps: PlaywrightStep[];
}

export interface PlaywrightError {
  message: string;
  value?: string;
  stack?: string;
  location?: { file: string; line: number; column: number };
  snippet?: string;
}

export interface PlaywrightAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: string;
}

export interface PlaywrightStep {
  title: string;
  category: string;
  startTime: string;
  duration: number;
  error?: PlaywrightError;
  steps?: PlaywrightStep[];
}

// ---- Normalized internal models ----

export interface NormalizedRun {
  id: string;
  sourceFile: string;
  commitSha?: string;
  branch?: string;
  environment?: string;
  browser?: string;
  projectName?: string;
  startTime: string;
  duration: number;
  stats: {
    total: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
  };
  testCases: NormalizedTestCase[];
}

export interface NormalizedTestCase {
  id: string;
  filePath: string;
  titlePath: string[];
  fullTitle: string;
  projectName: string;
  browser: string;
  status: "passed" | "failed" | "flaky" | "skipped" | "timedOut";
  duration: number;
  retries: number;
  results: NormalizedTestResult[];
  tags: string[];
}

export interface NormalizedTestResult {
  attempt: number;
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  startTime: string;
  error?: NormalizedError;
  steps: NormalizedStep[];
  artifacts: Artifact[];
  stdout: string[];
  stderr: string[];
}

export interface NormalizedError {
  message: string;
  stack?: string;
  snippet?: string;
  location?: {
    file: string;
    line: number;
    column: number;
  };
}

export interface NormalizedStep {
  title: string;
  category: string;
  startTime: string;
  duration: number;
  error?: NormalizedError;
  children: NormalizedStep[];
}

export interface Artifact {
  type: "screenshot" | "trace" | "video" | "other";
  name: string;
  contentType: string;
  path: string;
}

export interface NetworkRequest {
  url: string;
  method: string;
  status: number;
  statusText: string;
  duration: number;
  resourceType?: string;
  failed: boolean;
  requestHeaders?: { name: string; value: string }[];
  requestBody?: string;
  requestContentType?: string;
  responseHeaders?: { name: string; value: string }[];
  responseBody?: string;
  responseContentType?: string;
}

// ---- Comparison models ----

export interface TestMatch {
  failingTest: NormalizedTestCase;
  passingTest: NormalizedTestCase | null;
  matchConfidence: "exact" | "none";
}

export interface Comparison {
  matchedTests: TestMatch[];
  unmatchedFailing: NormalizedTestCase[];
  unmatchedPassing: NormalizedTestCase[];
  failingRun: NormalizedRun;
  passingRun: NormalizedRun | null;
}

export interface StepDiff {
  failingStep: NormalizedStep | null;
  passingStep: NormalizedStep | null;
  type: "added" | "removed" | "changed" | "timing" | "error";
  description: string;
}

export interface Divergence {
  stepIndex: number;
  failingStep: NormalizedStep | null;
  passingStep: NormalizedStep | null;
  type: "step_missing" | "step_added" | "step_error" | "step_order" | "timing_spike" | "error_introduced";
  description: string;
  significance: "high" | "medium" | "low";
}

// ---- Triage models ----

export type TriageCategory =
  | "app_regression"
  | "flaky_timing"
  | "environment_issue"
  | "test_bug"
  | "unknown";

export type ConfidenceLevel = "low" | "medium" | "high";

export interface EvidenceItem {
  type: "screenshot_diff" | "trace_step" | "console_error" | "request_failure" | "assertion_mismatch" | "timing_anomaly" | "error_message";
  description: string;
  artifactRef?: string;
  stepRef?: string;
}

export interface TriageSummary {
  testCase: NormalizedTestCase;
  category: TriageCategory;
  confidence: ConfidenceLevel;
  firstDivergence: Divergence | null;
  evidence: EvidenceItem[];
  suggestedNextStep: string;
  summary: string;
}
