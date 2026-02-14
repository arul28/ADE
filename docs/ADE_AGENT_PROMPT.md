# ADE Phase 8 Stabilization — Agent Execution Prompt

> **Objective:** Fix five critical product issues in ADE (Agentic Development Environment) so that Hosted AI, terminal summaries, lane UX, and packs all work end-to-end. You must verify every fix with real execution. No hand-waving.

---

## 0. Orientation

ADE is an **Electron 40 desktop app** for orchestrating parallel AI coding agents. It manages git worktrees ("lanes"), terminal sessions, packs (context bundles), and integrates with a serverless AWS backend for hosted LLM calls.

| Layer | Root path | Tech |
|-------|-----------|------|
| Desktop app | `/Users/arul/ADE/apps/desktop/` | Electron + React 18 + TypeScript 5.7 + Vite + Zustand + xterm.js + node-pty |
| Cloud backend | `/Users/arul/ADE/infra/` | SST 3.17 (TypeScript IaC) → API Gateway + Lambda + SQS + DynamoDB + S3 + Secrets Manager |
| Docs | `/Users/arul/ADE/docs/` | PRD, Implementation Plan, 11 feature specs, 10 architecture docs |

**Working directory for all commands:** `/Users/arul/ADE/apps/desktop/`
**Infra directory:** `/Users/arul/ADE/infra/`

---

## 1. Required Reading (do this first)

Read these files in full before writing any code. They define the product intent, architecture, and current implementation status:

| Priority | File | Why |
|----------|------|-----|
| 1 | `/Users/arul/ADE/docs/PRD.md` (37KB) | Product vision, core concepts (lanes, stacks, packs, sessions), system architecture, 8-tab layout, success metrics |
| 2 | `/Users/arul/ADE/docs/IMPLEMENTATION_PLAN.md` (76KB) | Phased roadmap (Phases -1 through 9), task breakdowns, risk register. Phases 0-8 are marked complete. Phase 9 not started. |
| 3 | `/Users/arul/ADE/docs/features/PACKS.md` | Pack types, versioning, narratives, checkpoints, events |
| 4 | `/Users/arul/ADE/docs/features/TERMINALS_AND_SESSIONS.md` | PTY service, session tracking, transcript capture |
| 5 | `/Users/arul/ADE/docs/features/LANES.md` | Lane operations, 3-pane layout, stacks, profiles |
| 6 | `/Users/arul/ADE/docs/architecture/HOSTED_AGENT.md` | Cloud mirror, narrative generation, conflict proposals |
| 7 | `/Users/arul/ADE/docs/architecture/CLOUD_BACKEND.md` | AWS stack spec (Clerk, API Gateway, Lambda, SQS, S3, DynamoDB) |
| 8 | `/Users/arul/ADE/docs/architecture/JOB_ENGINE.md` | Event-driven queue, coalescing, refresh pipeline |

**UX inspiration** (skim for philosophy, don't implement their features):
- Entire.io: Separate signal from noise. Optimize for *review*, not generation. Make context a first-class artifact.
- OneContext: Treat agent trajectory as shareable between humans and machines. Low-friction integration into existing workflows.
- Key principle: **The bottleneck has shifted from writing code to understanding AI output.** Every UX decision should make AI output *reviewable*, not just *visible*.

---

## 2. Architecture Quick Reference

### Process Model
- **Main process** (`src/main/main.ts`, 616 lines): Electron window, PTY, git, SQLite, job engine, all services
- **Renderer** (`src/renderer/`): React 18 + Zustand, zero Node access, all system calls via typed IPC
- **Preload bridge** (`src/preload/preload.ts`, 520 lines): `window.ade.*` namespace, IPC allowlist

### Critical Service Files

| Service | File | Size | Purpose |
|---------|------|------|---------|
| **hostedAgentService** | `src/main/services/hosted/hostedAgentService.ts` | ~1,814 lines | Clerk OAuth, mirror sync, job submission, LLM polling |
| **packService** | `src/main/services/packs/packService.ts` | ~2,350 lines | Pack generation, versioning, narrative caching, checkpoints |
| **jobEngine** | `src/main/services/jobs/jobEngine.ts` | ~167 lines | Event-driven async job scheduler with coalescing |
| **sessionService** | `src/main/services/sessions/sessionService.ts` | Session tracking, transcript storage, delta computation |
| **byokLlmService** | `src/main/services/byok/byokLlmService.ts` | ~400 lines | BYOK LLM provider (local API calls) |
| **ptyService** | `src/main/services/pty/ptyService.ts` | ~10K | Terminal/PTY management via node-pty |

### Critical UI Component Files

| Component | File | Key Patterns |
|-----------|------|--------------|
| **LanesPage** | `src/renderer/components/lanes/LanesPage.tsx` (1,507 lines) | Lane list, filtering, conflict indicators, restack suggestions |
| **LaneDetail** | `src/renderer/components/lanes/LaneDetail.tsx` (926 lines) | Git operations, status bar at bottom |
| **LaneInspector** | `src/renderer/components/lanes/LaneInspector.tsx` (233 lines) | 5 tabs: terminals, packs, stack, conflicts, pr |
| **LaneTerminalsPanel** | `src/renderer/components/lanes/LaneTerminalsPanel.tsx` (634 lines) | Session list, status dots, tab/grid views, ended session cards |
| **PackViewer** | `src/renderer/components/packs/PackViewer.tsx` (579 lines) | AI status hints, event activity, error display |
| **SettingsPage** | `src/renderer/components/app/SettingsPage.tsx` (1,476 lines) | Provider config, auth status, bootstrap UI |
| **AppShell** | `src/renderer/components/app/AppShell.tsx` (229 lines) | Top banner alerts (guest mode, hosted errors), PR toasts |

### Shared Types & IPC
- **Types:** `src/shared/types.ts` (1,788 lines) — `LaneSummary`, `SessionDelta`, `PackType`, `ProviderMode`, `JobItem`, etc.
- **IPC channels:** `src/shared/ipc.ts` — 100+ typed channels
- **ProviderMode:** `"guest" | "hosted" | "byok" | "cli"`

### Cloud Infrastructure

| AWS Resource | SST Config Location | Purpose |
|--------------|-------------------|---------|
| Jobs DynamoDB table | `sst.config.ts:213-235` | `projectId/jobId` + `statusIndex` (status/submittedAt) |
| Artifacts DynamoDB table | `sst.config.ts:237-252` | `projectId/artifactId` + 30-day TTL |
| SQS Queue | `sst.config.ts:328-339` | 15-min visibility timeout, DLQ with 3 retries |
| Lambda Worker | `sst.config.ts:484-537` | `packages/functions/src/workers/jobWorker.ts`, 15-min timeout, 2GB RAM, batch size 1 |
| API Gateway | `sst.config.ts` routes | `POST /projects/{id}/jobs`, `GET /projects/{id}/jobs/{jid}`, `GET /projects/{id}/artifacts/{aid}` |
| Secrets Manager | `sst.config.ts` | `ade-{stage}-llm-provider` secret with `geminiApiKey`, `defaultProvider`, `defaultModel` |

### Cloud Handler Files

| Handler | File | Purpose |
|---------|------|---------|
| API handlers | `infra/packages/functions/src/api/handlers.ts` | `submitJob` (360-424), `getJob` (426-473), `getArtifact` (475-523) |
| Job worker | `infra/packages/functions/src/workers/jobWorker.ts` (257 lines) | SQS consumer: queued → processing → LLM call → S3 artifact → completed |
| LLM gateway | `infra/packages/core/src/llmGateway.ts` (245 lines) | Multi-provider routing: OpenAI, Anthropic, Gemini, Mock |
| Prompt templates | `infra/packages/core/src/prompts.ts` | `buildPromptTemplate()` for NarrativeGeneration, DraftPrDescription, etc. |

---

## 3. The Five Bugs — Evidence, Root Cause Locations, and Fix Specifications

### Bug A: Hosted AI Jobs Stuck on "queued"

**Symptom:** User clicks "Update pack details with AI" → job submitted → polls → job stays `queued` → after 90 seconds, throws:
```
Error invoking remote method 'ade.packs.generateNarrative':
Error: Hosted job 801fe0a0-8274-4851-9067-cd050895c67a is stuck on status 'queued' for too long.
```

**The stuck detection is at:** `hostedAgentService.ts` line ~1209:
```typescript
if (Date.now() - statusStreakStart > POLL_STALL_TIMEOUT_MS) {  // 90 seconds
  throw new Error(`Hosted job ${jobId} is stuck on status '${normalizedStatus}' for too long.`);
}
```

**Complete request flow to trace:**
1. User clicks AI button → `PackViewer.tsx` line ~385 calls `updateWithAi()`
2. → IPC to `ade.packs.generateNarrative(laneId)`
3. → `packService.generateNarrative()` checks providerMode
4. → If `hosted`: calls `hostedAgentService.requestLaneNarrative({ laneId, packBody })`
5. → `submitJob()` (line ~1412): `POST /projects/{remoteProjectId}/jobs` with Clerk JWT
6. → API handler `submitJob` (handlers.ts:360-424): writes to DynamoDB (`status: "queued"`), enqueues to SQS
7. → SQS should trigger Lambda worker (`jobWorker.handler`)
8. → Worker should: update status to `processing`, call LLM, store artifact in S3, update status to `completed`
9. → Desktop polls via `pollJob()` (line ~1170): `GET /projects/{id}/jobs/{jid}` every 700ms-4s
10. → If status never leaves `queued` for 90s → "stuck" error

**Diagnosis checklist (you must execute each step):**

- [ ] **Is the API actually being hit?** Check `hostedAgentService.ts` around `apiRequest()` — verify the base URL, auth token, and project ID are correct. Look at the bootstrap config at `.ade/hosted/bootstrap.json`.
- [ ] **Is the job written to DynamoDB?** The `submitJob` handler writes with `PutCommand`. If it returns 202, the job is in DynamoDB.
- [ ] **Is the SQS message sent?** After DynamoDB write, `enqueueJob(jobsQueueUrl, payload)` sends to SQS. Check if `jobsQueueUrl` env var matches the actual queue ARN/URL.
- [ ] **Is the Lambda worker subscribed to the queue?** In `sst.config.ts:484-537`, `jobsQueue.subscribe()` creates the event source mapping. Verify this mapping exists and is enabled. Check if the Lambda function itself exists and has no deploy errors.
- [ ] **Is the Lambda receiving events?** Check CloudWatch logs for the worker Lambda. If no logs exist, the event source mapping is broken.
- [ ] **Is the Lambda crashing on startup?** Missing env vars, missing secrets ARN, wrong region, module import errors — any of these would cause the Lambda to crash before processing.
- [ ] **Are secrets accessible?** The worker calls `getLlmSecrets()` which reads from Secrets Manager. If the secret doesn't exist or the Lambda lacks `secretsmanager:GetSecretValue` permission, it crashes.
- [ ] **Is the LLM call failing?** If provider is `"gemini"` but `geminiApiKey` is missing/invalid in the secret, the call fails. Check `llmGateway.ts:132-192` for the Gemini integration — it uses the API key as a query param.
- [ ] **Is the DLQ accumulating?** If jobs fail 3 times, they go to the DLQ. Check `ApproximateNumberOfMessagesVisible` on the DLQ.

**What to fix:**

1. **Root cause:** Identify which step in the chain above is broken and fix it. Common causes:
   - Lambda event source mapping not enabled (SST deploy issue)
   - Missing/wrong `JOBS_QUEUE_URL` env var on API handler
   - Missing LLM secret in Secrets Manager
   - Lambda IAM permissions missing for SQS, DynamoDB, S3, or Secrets Manager
   - Gemini API key expired or not set

2. **UI diagnostics (must implement):**
   - In `PackViewer.tsx`, when providerMode=`hosted`, show a **health status card** with:
     - Consent granted: yes/no
     - Bootstrap applied: yes/no
     - Signed in: yes/no (with user email)
     - Remote project ID: `{id}` or "not configured"
     - Last job status: queued/processing/completed/failed
     - If stuck: "Job {jobId} has been queued for {N}s. Check: worker Lambda logs, SQS queue depth, LLM secret."
   - The existing `hostedReadiness()` function at `PackViewer.tsx:72-79` already does basic checks — **extend it** to include job-level diagnostics.
   - When `generateNarrative` fails, the error is caught and stored in `aiError` state (PackViewer.tsx line ~433). **Enhance** this to show the jobId, last known status, and actionable next steps.

3. **Existing UI patterns to follow:**
   - Error cards: `className="rounded border border-red-900 bg-red-950/20 p-2 text-xs text-red-300"`
   - Warning hints: `className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-200"`
   - Success: `className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"`
   - The `AppShell.tsx:137-152` already shows hosted status banners at the top of the app — leverage this pattern.

---

### Bug B: Terminal Summaries Are Raw ANSI Garbage

**Symptom:** "Terminal summary" output contains raw control sequences, prompt noise, ANSI escapes — not human-readable summaries.

**Root cause:** There is **NO ANSI stripping anywhere** in the codebase. Transcripts are captured raw from PTY (including all escape codes) and displayed as-is.

**Specific code locations:**

1. **Transcript capture:** `ptyService.ts` writes raw PTY output to `.ade/transcripts/{sessionId}.log` — this includes ALL ANSI escape codes (colors, cursor movement, line clearing, etc.)

2. **Transcript reading:** `sessionService.readTranscriptTail(transcriptPath, maxBytes)` reads the last N bytes as raw UTF-8 — **no stripping**.

3. **Failure line extraction:** `packService.computeSessionDelta()` extracts error lines via regex:
   ```typescript
   const failureLines = transcript
     .split("\n")
     .map((line) => line.trim())
     .filter((line) => line.length > 0)
     .filter((line) => /(error|failed|exception|fatal|traceback)/i.test(line))
     .slice(-8);
   ```
   These lines **may contain ANSI codes** — they are not sanitized.

4. **UI display:** `SessionDeltaCard.tsx` renders failure lines in a red box — raw ANSI codes included. `LaneTerminalsPanel.tsx` lines 472-492 show transcript tail in a `<pre>` tag — raw ANSI codes included.

5. **Pack body:** When pack markdown is generated by `packService.buildLanePackBody()`, the "Potential errors" section includes failure lines as-is.

**What to fix:**

1. **Create an ANSI stripping utility** (new file: `src/main/utils/ansiStrip.ts` or add to existing utils):
   ```typescript
   // Strip ANSI escape sequences: ESC[...m (SGR), ESC[...H (cursor), ESC[...J (erase), etc.
   // Also strip: carriage returns, backspace sequences, OSC sequences (ESC]...\x07)
   const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\(B|\r|\x08/g;
   export function stripAnsi(text: string): string {
     return text.replace(ANSI_REGEX, '');
   }
   ```

2. **Apply stripping in these locations:**
   - `sessionService.readTranscriptTail()` — strip before returning
   - `packService.computeSessionDelta()` — strip failure lines before storing
   - Any place transcript text is surfaced to the user or sent to LLM

3. **Implement deterministic summary generation** (critical — must work even without AI):
   - After a session ends, generate a one-line human-readable summary from the transcript
   - Parse the transcript for: command run, exit code, test results, error count
   - Example outputs:
     - `"Ran npm test (PASS, 2 tests, 72ms)"`
     - `"Ran git push origin main (OK, 3 commits pushed)"`
     - `"Ran npm install (FAIL, exit code 1, EACCES permission denied)"`
   - Store this as `session.summary` in the sessions table (add column if needed)
   - Display this summary in the `SessionDeltaCard` and `LaneTerminalsPanel` instead of raw transcript

4. **If AI is available, enhance the summary** — but never block usability on AI. The deterministic summary is the floor.

5. **In packs:** Replace raw failure lines with stripped, collapsed versions. One line per error, no repeated prompts, no ANSI.

---

### Bug C: Lanes Tab Cluttered with Ended Terminal Sessions

**Symptom:** In the Lanes tab inspector → Terminals sub-tab, ended/closed sessions dominate the view. Running terminals are hard to find.

**Specific code:** `LaneTerminalsPanel.tsx` (634 lines)

**Current behavior:**
- Sessions are displayed as tabs (lines 405-496)
- Status dots distinguish running (`bg-accent`) vs ended (`bg-border`) vs failed (`bg-red-700`) vs disposed (`bg-muted-fg`) — see line 21-26
- Both running and ended sessions are shown in the same tab list
- Ended sessions show a card with status, tool type, exit code, `SessionDeltaCard`, and transcript tail in `<pre>` — lines 472-492
- Grid mode (line 498-511) already filters to running sessions only: `sessions.filter((s) => s.status === "running" && Boolean(s.ptyId))`

**What to fix:**

1. **Default view: running terminals only.** Add a filter toggle that defaults to showing only `status === "running"` sessions in the tab list.

2. **Ended sessions:** Show a collapsed count ("3 ended sessions") with an expand toggle. When expanded, show minimal info (one line per session: tool, exit code, summary). NOT the full transcript tail by default.

3. **"Open in Terminals tab" link:** Add a button/link that navigates to the Terminals tab (`/terminals`) with the lane filter pre-applied. Use React Router's `useNavigate()` — the app uses `react-router` v7.13.

4. **Keep it simple:** The grid mode (`TilingLayout`) already does the right thing. Extend the same filtering to the tab view.

5. **Do NOT remove ended session data** — just hide it behind a toggle. Users need it for debugging.

---

### Bug D: Packs Are Template Dumps, Not Useful Context

**Symptom:** Lane packs contain template markers, placeholder text, raw IDs, and diff stats — but no actionable information about what was done, why, what's next, or what broke.

**Current pack structure** (from `packService.buildLanePackBody()`):
```markdown
# Lane Pack: lane-request-id
Deterministic updated: {timestamp}
## Lane snapshot (branch, HEAD, dirty/clean, ahead/behind)
## Intent <!-- ADE_INTENT_START --> {placeholder} <!-- ADE_INTENT_END -->
## Recent work (session IDs, timing, exit codes, delta stats)
## Touched Modules (file paths)
## Files touched (file paths)
## Potential errors (raw failure lines — may contain ANSI)
## Sessions (timestamp, tool, intent, outcome, delta)
## Latest Tests (suite key, status, duration)
## Decisions And Todos <!-- ADE_TODOS_START --> {placeholder} <!-- ADE_TODOS_END -->
## Narrative (AI-generated or template)
```

**Problems:**
- "Intent" section contains marker comments and placeholder text — not inferred intent
- "Recent work" shows raw session metadata (IDs, timestamps) — not what was actually done
- "Potential errors" may contain ANSI garbage (see Bug B)
- "Decisions And Todos" is always empty placeholder markers
- No plain-language description of what changed or why
- No validation status (did tests pass? which command?)
- No next steps or open questions
- No links between pack events and operations

**What to fix:**

1. **Redesign the pack markdown template** in `packService.buildLanePackBody()`. New structure:

```markdown
# Lane: {lane.name}
> Branch: `{branch}` | Base: `{base}` | HEAD: `{shortSha}` | {dirty/clean}

## What Changed
{Plain-language summary of recent commits and file changes. Group by module/area.}
{Example: "Modified authentication middleware (src/auth/). Added rate limiting to API routes (src/api/routes/)."}

## Why
{Intent inferred from: commit messages, session goals, user-provided intent}
{If user hasn't set intent: "Intent not set — click to add" with editable marker preserved}

## Validation
- Tests: {PASS/FAIL/NOT RUN} ({N} suites, {M} tests, {duration})
  - Command: `{test command}`
  - {If failed: "Failures: {list of failed test names}"}
- Lint: {PASS/FAIL/NOT RUN}

## Key Files ({N} files touched)
| File | Change |
|------|--------|
| `src/auth/middleware.ts` | +45/-12 |
| `src/api/routes/users.ts` | +23/-0 (new) |
{Top 10, sorted by magnitude of change}

## Errors & Issues
{Sanitized, one per line, no ANSI, no repeated prompts}
{Example: "TypeError: Cannot read properties of undefined (reading 'id') at src/api/routes/users.ts:42"}
{If none: "No errors detected."}

## Sessions ({N} total, {M} running)
| When | Tool | Goal | Result | Delta |
|------|------|------|--------|-------|
| 14:32 | Claude Code | "Add rate limiting" | exit 0 | +45/-12 |
{Most recent first, max 5}

## Open Questions / Next Steps
{Deterministic: derived from test failures, uncommitted changes, merge conflicts}
{AI-enhanced if available: inferred from context}
{Example: "- 2 tests failing in auth suite — investigate before merge"}
{Example: "- 3 uncommitted files — consider committing before switching lanes"}

## Narrative
{AI-generated narrative — or "AI narrative not yet generated. Click 'Update with AI' to generate."}

---
*Updated: {timestamp} | Provider: {providerMode} | [View history →](ade://packs/versions/{packKey})*
```

2. **Commit message parsing:** Extract intent from `git log --oneline` for the lane's commits since divergence from base. Group by theme.

3. **Test result integration:** `packService` already has access to test results. Surface them prominently with pass/fail/command.

4. **Error sanitization:** Apply ANSI stripping (from Bug B fix) and collapse duplicate errors.

5. **Project pack:** Keep it compact. Include: docs index, lane summary table (name, branch, status, last activity), git history seed (last 10 commits across all lanes), and repo file tree (top 2 levels). Do NOT dump full lane packs into the project pack.

---

### Bug E: Silent UI Dead Ends

**Symptom:** When AI buttons are clicked and nothing happens, the UI fails silently — errors only appear in the Electron dev console.

**Current error handling in PackViewer** (lines 298-341, 418-434):
- `aiError` state shows errors in a red card — **but only after the promise rejects**
- `aiHint` and `aiMetaHint` show warnings about provider status — but these are **advisory only**, not linked to specific job failures
- The AI button shows "Updating…" with a pulse animation while busy — but if the promise rejects, it just stops pulsing with no explanation

**What to fix:**

1. **Immediate feedback on click:** When "Update pack details with AI" is clicked:
   - Show "Submitting job…" → "Job {shortId} queued" → "Processing…" → "Complete" or "Failed: {reason}"
   - Surface the jobId in the UI so users can reference it
   - If the job is stuck, show elapsed time: "Queued for 45s (expected: <10s)"

2. **Pack events must be readable:** The `formatPackEvent()` function at `PackViewer.tsx:29-70` already formats events with tones (good/warn/bad). Enhance:
   - `narrative_failed` events should include the error message, not just "narrative update failed"
   - `narrative_requested` should show the jobId
   - Add timestamps to event display

3. **AppShell banner enhancement:** The `AppShell.tsx:137-152` hosted status banner already shows basic readiness. Add:
   - If there's a recent failed job: "Last AI job failed: {reason}. [Retry] [Details]"
   - If mock provider detected: "LLM provider is 'mock' — AI will return placeholder content."

4. **Never swallow errors:** Search for `.catch(() => {})` patterns (there's one at PackViewer.tsx line ~385) and replace with proper error handling that surfaces the message to the user.

---

## 4. Execution Order

**Phase 1: Diagnose and fix hosted AI (Bug A) — do this FIRST**

This is the critical path. Until hosted AI works, Bugs D and E cannot be fully validated.

1. Read the full `hostedAgentService.ts` to understand the submission and polling flow
2. Reproduce the "stuck on queued" error by clicking "Update pack details with AI" in the UI (or by calling the IPC directly)
3. Trace the request: Is the API hit? Is the job in DynamoDB? Is SQS receiving the message? Is the Lambda invoked?
4. Check CloudWatch logs for the worker Lambda
5. Check Secrets Manager for the LLM secret
6. Fix the root cause
7. Verify: job transitions from `queued` → `processing` → `completed`
8. Verify: narrative text is returned and applied to the pack

**Phase 2: Fix terminal summaries (Bug B)**

1. Create ANSI stripping utility
2. Add stripping to transcript reading and failure line extraction
3. Implement deterministic summary generation for ended sessions
4. Verify: no ANSI codes appear in any user-facing text

**Phase 3: Clean up Lanes tab terminals (Bug C)**

1. Add filter toggle defaulting to running sessions
2. Collapse ended sessions behind a toggle
3. Add "Open in Terminals tab" link
4. Verify: running terminals are prominent, ended sessions are accessible but not cluttering

**Phase 4: Overhaul pack content (Bug D)**

1. Redesign `buildLanePackBody()` template
2. Add commit message parsing for intent
3. Integrate test results prominently
4. Apply error sanitization
5. Verify: pack reads like a useful handoff document

**Phase 5: Eliminate silent dead ends (Bug E)**

1. Add job status feedback to AI button flow
2. Enhance pack events with error details
3. Fix error swallowing patterns
4. Verify: every click produces visible feedback

---

## 5. Testing & Validation

### Commands to Run

```bash
# From /Users/arul/ADE/apps/desktop/
npm test                    # Vitest — 6 test files in src/main/services/
npm run typecheck           # tsc --noEmit
npm run build               # tsup + vite build (optional but recommended)
```

**Test framework:** Vitest 0.34.6, config at `vitest.config.ts` (env: node, include: `src/**/*.test.ts`, 20s timeout)

**Existing test files:**
- `src/main/services/automations/automationPlannerService.test.ts`
- `src/main/services/automations/automationService.test.ts`
- `src/main/services/ci/ciParsing.test.ts`
- `src/main/services/ci/ciService.test.ts`
- `src/main/services/git/gitConflictState.test.ts`
- `src/main/services/onboarding/onboardingService.test.ts`

**TypeScript config:** `tsconfig.json` — target ES2022, module ESNext, strict mode, JSX react-jsx

### Write Tests For Your Changes

Add tests for:
- ANSI stripping utility (pure function, easy to test)
- Deterministic summary generation (given transcript → expected summary)
- Pack markdown structure validation (sections present, no ANSI, no placeholder-only content)

### Manual Verification Checklist

- [ ] Click "Update pack details with AI" → see completed job with provider/model metadata (Gemini Flash) OR see clear UI error with jobId, status, and what to do
- [ ] Jobs do not sit "queued" indefinitely. If they do, UI shows worker/queue diagnostics
- [ ] Terminal summaries contain zero ANSI escape sequences. They read like: "Ran npm test (PASS, 2 tests, 72ms)"
- [ ] Lanes tab: running terminals visible first; ended sessions collapsed behind toggle
- [ ] Pack markdown is human-readable: contains what changed, why, test status, errors (sanitized), next steps
- [ ] No `.catch(() => {})` error swallowing — every AI action shows result or error

---

## 6. Documentation Updates

After all fixes, update these files:

1. `/Users/arul/ADE/docs/IMPLEMENTATION_PLAN.md` — Update Phase 8 task statuses to reflect these fixes
2. `/Users/arul/ADE/docs/features/PACKS.md` — Update pack markdown structure documentation
3. `/Users/arul/ADE/docs/features/TERMINALS_AND_SESSIONS.md` — Document ANSI stripping and deterministic summaries
4. `/Users/arul/ADE/docs/features/LANES.md` — Document terminal filtering in lanes tab

---

## 7. Engineering Constraints

- **Keep existing architecture.** Do not restructure the service layer, change the IPC contract shape, or replace the build system.
- **Minimize new dependencies.** ANSI stripping can be done with regex — do not add `strip-ansi` or similar packages unless truly necessary.
- **No heavy UI additions.** Status cards and diagnostics should use existing CSS patterns (see the class names in Bug A fix section). No new UI frameworks, no new design systems.
- **Do not break existing tests.** All 6 existing test files must continue to pass.
- **Respect the trust boundary.** All system access (filesystem, git, network) stays in the main process. Renderer only uses `window.ade.*` IPC calls.
- **Follow existing code style.** The codebase uses: functional components, hooks, Zustand for state, Tailwind for styling, `cn()` for class merging, `async/await` for promises. Match this.

---

## 8. Final Deliverable

When done, provide a concise checklist:

```
## Changes Summary

### Bug A: Hosted AI Fix
- [ ] Root cause: {what was broken}
- [ ] Fix: {what you changed}
- [ ] Files: {list}

### Bug B: Terminal Summary Fix
- [ ] ANSI stripping: {file}
- [ ] Deterministic summaries: {file}
- [ ] Files: {list}

### Bug C: Lanes Tab Cleanup
- [ ] Filter toggle: {file}
- [ ] Collapsed ended sessions: {file}
- [ ] Files: {list}

### Bug D: Pack Overhaul
- [ ] New template: {file}
- [ ] Commit parsing: {file}
- [ ] Files: {list}

### Bug E: Silent Dead Ends Fix
- [ ] Job status feedback: {file}
- [ ] Error handling: {file}
- [ ] Files: {list}

### Tests
- [ ] npm test: PASS ({N} tests)
- [ ] npm run typecheck: PASS
- [ ] npm run build: PASS/SKIP
- [ ] New tests added: {list}

### Docs Updated
- [ ] IMPLEMENTATION_PLAN.md
- [ ] features/PACKS.md
- [ ] features/TERMINALS_AND_SESSIONS.md
- [ ] features/LANES.md
```
