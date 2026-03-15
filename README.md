# lastGreen

Playwright failure diff & triage tool. Upload a failing report, optionally compare it against a passing run, and find the first meaningful divergence — with AI-powered diagnosis.

## What it does

1. **Ingest** Playwright reports (`.json`, `.html`, or `.zip` with traces)
2. **Normalize** test results into a common format
3. **Match** failing tests to their passing counterparts by file path + title + project
4. **Compare** step-by-step: find the first divergence, timing spikes, missing/extra steps, error mismatches
5. **Diff network requests** between pass and fail — deterministic filtering strips telemetry, fonts, assets, and flags requests that also failed in the passing run as red herrings
6. **Triage** with heuristics (app regression, flaky/timing, environment, test bug, unknown)
7. **AI diagnosis** (optional) — feeds the structured comparison summary to Claude, not raw evidence. Returns structured JSON with category, confidence, evidence, counter-evidence, and suggested next step. Supports conversational follow-ups.

## Project structure

```
lastGreen/
  apps/web/          Next.js app (frontend + API routes)
  packages/core/     Shared library — ingestion, normalization, matching, comparison, triage
  fixtures/          Sample Playwright reports for testing
```

Monorepo with npm workspaces. No Turbo needed.

## Getting started

**Requirements:** Node >= 20

```bash
git clone git@github.com:johan-mayo/lastGreen.git
cd lastGreen
npm install
npm run build:core   # compile the core library first
npm run dev          # starts Next.js on http://localhost:3000
```

That's it. Open `http://localhost:3000`, upload a failing Playwright report, and optionally a passing one.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the web app (Turbopack) |
| `npm run dev:core` | Watch-build the core library |
| `npm run build` | Build everything |
| `npm run build:core` | Build just the core library |
| `npm run build:web` | Build just the web app |
| `npm run lint` | Lint all workspaces |

## AI diagnosis

The AI diagnosis is optional and requires an Anthropic API key (entered in the UI, stored in localStorage).

The pipeline is **deterministic comparison first, LLM summarization second**:

1. Step diffs, request diffs, console diffs, and red herrings are computed client-side
2. Only the structured `ComparisonSummary` is sent to Claude — not raw request lists or freeform evidence
3. The model is constrained to return structured JSON with an explicit `unknown` category
4. Requests that also failed in the passing run are flagged as red herrings in the prompt
5. After the initial diagnosis, you can send follow-up messages to refine the analysis

## Tech stack

- **Next.js 16** + React 19 + Tailwind CSS 4
- **TypeScript 5** across the board
- **JSZip** for parsing Playwright trace ZIPs and extracting network requests
- **Anthropic SDK** for AI diagnosis (Claude Opus 4.6)

## How the core library works

```
Playwright Report (.json / .html / .zip)
  -> ingestReportAuto()    parse into raw report shape
  -> normalizeReport()     normalize into NormalizedRun
  -> matchTests()          match failing tests to passing counterparts
  -> compareTestPair()     step-by-step diff, find first divergence
  -> triageTest()          heuristic categorization
```

All exported from `@last-green/core`.

## Data storage

Uploaded reports and extracted artifacts are stored locally in `.lastgreen-data/` (gitignored). No database required.
