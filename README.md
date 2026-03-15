# lastGreen

Playwright failure diff and triage tool.

Upload a failing report, optionally compare it against a known-good run, and find the first meaningful divergence. If you want, it can also use AI to help explain what likely went wrong.

## Why this exists

I built this because I got tired of doing the same annoying debugging loop over and over.

As I started shipping more code with AI, I leaned even harder on tests. Unit tests and e2e tests became the best way to give AI tight, relevant context about what code was supposed to do. That part was great. The problem was everything that came after.

As the codebase grew and more people contributed, I lost the ability to instantly understand every failing test. If it was a test I wrote, I could usually look at the failure and guess what changed. If it was a test someone else wrote, that got a lot slower.

One of the codebases I work in keeps Playwright reports from multiple runs every day. So when a test failed, I’d usually open the failing report, open a passing one in another tab, and start comparing them step by step until I found the point where things diverged. That worked, but it was tedious and slow. It was pretty normal to burn 10 to 15 minutes on a single failure just figuring out what was actually different.

After doing that enough times, the pattern became obvious: most failures are not unique snowflakes. Usually it’s one of a few things.

- The app changed and the test expectations are now wrong
- A service drifted or went down
- The test is flaky or too timing-sensitive
- The environment is unstable
- Or it’s some combination of those

The useful signal was already in the report data. I just didn’t have a good way to pull it out.

I started by pasting raw report data into an AI chatbot and asking targeted questions. That worked sometimes, but it fell apart on bigger tests and anything that needed historical context. Raw logs are noisy. What actually matters is the difference between a passing run and a failing one, especially the first place where they meaningfully stop behaving the same.

That was the idea behind lastGreen.

Instead of throwing a pile of logs at a model and hoping for the best, lastGreen does the structured comparison work first. It lines up the failing test with a passing counterpart, compares steps, network activity, console output, and errors, and tries to isolate the first meaningful divergence. Once you have that, both humans and AI are much better at answering the real question: is this a product bug, a flaky test, an environment issue, or something else?

That’s the whole point of the project. Make Playwright failures faster to understand.

## What it does

1. **Ingests** Playwright reports (`.json`, `.html`, or `.zip` with traces)
2. **Normalizes** test results into a common format
3. **Matches** failing tests to passing counterparts by file path, title, and project
4. **Compares** runs step by step to find:
   - the first meaningful divergence
   - timing spikes
   - missing or extra steps
   - mismatched errors
5. **Diffs network requests** between pass and fail, while filtering obvious noise like telemetry, fonts, and static assets
6. **Flags red herrings**, including requests that also failed in the passing run
7. **Triages failures** with heuristics:
   - app regression
   - flaky or timing issue
   - environment issue
   - test bug
   - unknown
8. **Optionally diagnoses with AI** using the structured comparison summary instead of raw logs

## Project structure

```text
lastGreen/
  apps/web/          Next.js app (frontend + API routes)
  packages/core/     Shared library for ingestion, normalization,
                     matching, comparison, and triage
  fixtures/          Sample Playwright reports for testing
```

This is a monorepo using npm workspaces. No Turborepo.

## Getting started

**Requirements:** Node >= 20

```bash
git clone git@github.com:johan-mayo/lastGreen.git
cd lastGreen
npm install
npm run build:core
npm run dev
```

Then open `http://localhost:3000`, upload a failing Playwright report, and optionally add a passing run for comparison.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the web app with Turbopack |
| `npm run dev:core` | Watch and rebuild the core library |
| `npm run build` | Build all workspaces |
| `npm run build:core` | Build the core library only |
| `npm run build:web` | Build the web app only |
| `npm run lint` | Lint all workspaces |

## AI diagnosis

AI diagnosis is optional and requires an Anthropic API key. The key is entered in the UI and stored in `localStorage`.

The pipeline is intentionally deterministic first, LLM second:

1. Step diffs, request diffs, console diffs, and red-herring detection are computed locally
2. Only the structured `ComparisonSummary` is sent to Claude
3. Raw request lists and unstructured logs are not sent to the model
4. The model is constrained to return structured JSON with an explicit `unknown` category
5. After the initial diagnosis, you can ask follow-up questions to refine the analysis

The idea is simple: do the reliable comparison work in code, then use the model for interpretation.

## Tech stack

- **Next.js 16** + React 19 + Tailwind CSS 4
- **TypeScript 5**
- **JSZip** for parsing Playwright trace ZIPs and extracting network requests
- **Anthropic SDK** for AI diagnosis

## How the core library works

```text
Playwright Report (.json / .html / .zip)
  -> ingestReportAuto()    parse into raw report shape
  -> normalizeReport()     normalize into NormalizedRun
  -> matchTests()          match failing tests to passing counterparts
  -> compareTestPair()     compute diffs and first divergence
  -> triageTest()          assign heuristic category
```

Everything is exported from `@last-green/core`.

## Data storage

Uploaded reports and extracted artifacts are stored locally in `.lastgreen-data/` and are gitignored.

No database required.
