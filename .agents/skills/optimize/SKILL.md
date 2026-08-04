---
name: optimize
description: Profile a large ADE feature end-to-end, add temporary or permanent telemetry, run the Electron app, find real CPU/memory/IPC/render hot paths, fix them, and verify with stress tests.
---

# /optimize — Performance Steward

You are the performance steward for ADE. Use this after a large feature lands, when the app works but might be too heavy for normal laptops.

**Argument:** `$ARGUMENTS` — optional feature or surface hint, for example `/optimize Work and Lanes`, `/optimize iOS simulator drawer`, or `/optimize graph route`.

Your job is not to make the app feel stripped down. Preserve the product's intent and interaction quality while removing waste, polling, avoidable rendering, memory spikes, runaway logs, redundant IPC, and expensive cold-start behavior.

---

## Operating mode

Run autonomously. Do not stop at a plan. Read, instrument, run, measure, fix, and verify. Ask the user only if a required action would spend money, use an expensive model, destroy data, or cannot be inferred from repo context.

Be concrete. Every optimization should be backed by at least one of:

- A live log finding.
- Process CPU/RSS/GPU evidence.
- A renderer/DOM/animation finding.
- A repeated IPC or polling pattern.
- A testable code path that clearly does unnecessary work.

Do not make speculative cleanup the main result. If you cannot reproduce a suspected issue, leave a short note and move to the next measurable surface.

**Every optimization must hold on Windows too.** Parity is a default requirement for all new code, and perf work is where it quietly breaks: caching a path as a raw string then comparing it with `===`, replacing a process-tree kill with a cheaper `child.kill()`, dropping a `windowsHide: true` spawn option, removing a file-lock retry loop as "dead code", or reusing a PID as identity. Check any such change against `../quality/references/windows-quirks.md` first. A measurement taken only on macOS does not establish that the Windows path is unaffected — say which host produced each number. If a win is achievable on one platform only, keep the other platform's correct path rather than regressing it, and say so in the final report.

---

## Phase 0: Understand the surface

1. Read the relevant docs before editing:
   - `AGENTS.md` or the prompt-provided project instructions.
   - `docs/ARCHITECTURE.md` if the change crosses app/service boundaries.
   - Feature docs under `docs/features/**` that match `$ARGUMENTS`.
   - Existing playbooks if the surface involves PRs, lanes, computer use, sync, or release.

2. Inspect the changed surface:
   - `git status --short`
   - `git diff --stat`
   - `git diff -- <relevant files>`
   - `rg` for the feature's IPC channels, services, hooks, intervals, observers, animations, and route components.

3. Identify the likely hot paths:
   - Renderer route mount and tab switches.
   - Work/Lanes session lists and terminal panes.
   - IPC polling and fan-out calls.
   - Main-process services doing filesystem, git, SQLite, model discovery, sync, or embedding work.
   - Hidden drawers or panes that still run effects while closed.
   - Infinite CSS animations, WebGL/canvas surfaces, resize loops, observers, and timers.
   - Startup, project switch, and route navigation cold paths.

Keep a working list of surfaces to test. Prefer a small number of realistic flows over broad shallow poking.

---

## Phase 1: Establish observability

Before making performance edits, make sure the app can tell you what is happening.

1. Look for existing instrumentation:
   - IPC begin/done/summary logs.
   - Route change logs.
   - Service phase summaries.
   - PTY/session output summaries.
   - Renderer debug logs.
   - Cache hit/miss or model discovery summaries.

2. If logs are missing, add narrow instrumentation first:
   - For IPC handlers: log channel, duration, slow count, failure count, and top callers when available.
   - For expensive service methods: log phase timings, input size/counts, cache hits, and result counts.
   - For terminal/session output: log chunks, batches, bytes/chars, listener count, active session count.
   - For renderer effects: log route mount/unmount or ready state only when the structural signature changes, not every render.

3. Instrumentation rules:
   - Summaries beat per-item spam.
   - Redact user prompts, secrets, command input, tokens, and file contents.
   - Add logs behind existing logger/debug patterns.
   - Avoid permanent noisy logs. If a log is only useful during this run, remove it before finishing or gate it behind an existing dev/debug flag.

---

## Phase 2: Run the app and attach to the real Electron surface

Use the local desktop app as the source of truth.

1. Start the dev app from `apps/desktop`:

```bash
npm run dev
```

2. Keep the dev terminal visible. Watch for:
   - `dev launcher using http://localhost:5173`
   - `DevTools listening on ws://127.0.0.1:9222`
   - `window.loading_url`
   - `renderer.route_change`
   - `ipc.invoke.summary`
   - Feature-specific summary logs.

3. Attach to Electron, not Safari:
   - Prefer the `Electron` app entry when using computer-use.
   - Confirm the window URL contains `localhost:5173`.
   - If DevTools is the focused target, switch to the ADE page before evaluating DOM or interacting.

4. If using CDP/agent-browser, target the ADE tab:

```bash
agent-browser --cdp 9222 tab
agent-browser --cdp 9222 tab <ADE-tab-index>
```

5. Collect baseline process data:

```bash
pgrep -fl "Electron . --remote-debugging-port=9222|Electron Helper|vite --port 5173|tsup --watch|esbuild --service"
ps -axo pid,ppid,%cpu,%mem,rss,comm,args
```

Use process names carefully:
   - Main Electron process: app services, SQLite, IPC handlers.
   - Renderer helper: React route work, DOM rendering, terminal rendering.
   - GPU helper: WebGL/canvas/compositing/animation pressure.
   - Network utility: fetch/WebSocket behavior.

Close extra DevTools targets before trusting memory numbers. DevTools can inflate RSS and CPU.

---

## Phase 3: Navigate and profile the feature

Run realistic flows with logs open.

1. Sweep relevant tabs/routes:
   - Work
   - Lanes
   - Files
   - Run
   - Graph
   - PRs
   - Review
   - History
   - Automations
   - CTO
   - Settings

If `$ARGUMENTS` names a surface, spend most time there but still check adjacent routes that stay mounted or subscribe to the same data.

2. For each route, record:
   - Cold navigation IPC summary.
   - Idle IPC summary after 10-20 seconds.
   - Main/renderer/GPU CPU and RSS.
   - `document.getAnimations({ subtree: true })`.
   - Number of canvases/WebGL/xterm instances if relevant.
   - Obvious repeated logs, repeated effects, or repeated identical IPC calls.

Useful renderer probes:

```js
JSON.stringify({
  href: location.href,
  hidden: document.hidden,
  visibility: document.visibilityState,
  animations: document.getAnimations({ subtree: true }).map((a) => ({
    state: a.playState,
    tag: a.effect?.target?.tagName,
    cls: String(a.effect?.target?.className).slice(0, 160),
    text: a.effect?.target?.textContent?.slice(0, 80),
  })),
  xterms: document.querySelectorAll(".xterm").length,
  xtermCanvases: document.querySelectorAll(".xterm canvas").length,
  canvases: document.querySelectorAll("canvas").length,
})
```

3. Watch for these patterns:
   - Same IPC call every second or every render.
   - Multiple identical IPC calls during mount.
   - A route refreshing full decorated snapshots when it only needs counts.
   - Hidden panels polling, probing devices, or reading files.
   - Model discovery or provider probing blocking composer open.
   - Large transcript reads on route mount.
   - Fit/resize loops in terminals.
   - Infinite status animations keeping GPU/compositor awake.
   - WebGL/canvas rendering where DOM/static rendering is enough.
   - Cache misses for data that changes rarely, like project icons, auth status, model inventories, or GitHub status.

---

## Phase 4: Stress the real workflow

For ADE, always stress Work and Lanes unless the feature is completely unrelated. Most users live there.

1. Work tab stress:
   - Open or reuse a lane.
   - Create a shell session and run a bounded output stream.
   - Keep the terminal visible so renderer cost is real.

Example shell stress:

```bash
node -e 'let i=0; const t=setInterval(()=>{process.stdout.write("ade-stress "+(++i)+" abcdefghijklmnopqrstuvwxyz0123456789\n"); if(i>=3000){clearInterval(t); process.exit(0)}},2)'
```

2. Lanes tab stress:
   - Navigate to Lanes while a session is running or immediately after heavy terminal output.
   - Observe whether Lanes does full status snapshots, rebase suggestions, git/diff reads, or presence updates repeatedly.
   - Confirm idle logs calm down.

3. Chat stress:
   - Prefer a cheap model only: Haiku, a mini Codex/OpenAI model, or the cheapest available local/dev model.
   - Do not use expensive models for performance testing.
   - If cheap model availability cannot be confirmed, use shell/session stress instead and note why.
   - Start multiple chats only when the user explicitly asked for multi-agent load or the feature depends on parallel chats.

4. Computer-use/iOS/simulator stress:
   - Only stress if the feature touches those panels.
   - Closed drawers should not probe devices, fetch previews, or run screenshot loops.
   - Open drawer, measure, close drawer, measure again.

5. Memory checks:
   - Use `ps`/Activity Monitor-style process sampling repeatedly.
   - On macOS, `vmmap <pid> -summary` can help explain big RSS spikes.
   - Distinguish DevTools memory from actual app memory by closing DevTools targets and rechecking.

6. Cleanup after stress:
   - Stop or dispose test PTYs/sessions you created.
   - Do not kill user-created sessions unless they are clearly from the test.
   - Stop the dev server before finishing unless the user asked to keep it running.

---

## Phase 5: Fix the highest-impact causes

Prefer fixes in this order:

1. Remove runaway work:
   - Stop polling when hidden, closed, or unfocused.
   - Deduplicate identical in-flight calls.
   - Debounce or throttle high-frequency refresh.
   - Narrow full refreshes to runtime-only or count-only queries when possible.

2. Reduce IPC and main-process load:
   - Cache cold data with clear invalidation.
   - Coalesce event streams, especially PTY data.
   - Avoid repeated resize/write/status no-ops.
   - Add service-level phase summaries so future regressions are visible.

3. Reduce renderer and GPU load:
   - Remove infinite decorative/status animations in persistent chrome.
   - Make expensive renderers opt-in when the default can be cheaper.
   - Do not mount hidden heavy panels if they can lazy-mount.
   - Avoid re-render logs/effects that depend on unstable object identities.
   - Virtualize large lists or cap expensive previews when needed.

4. Reduce memory pressure:
   - Lazy-load embedding/model/device work.
   - Bound caches and transcripts.
   - Avoid retaining full snapshots or logs in renderer state when summaries are enough.
   - Reuse cached project/model/provider metadata with invalidation.

5. Preserve UX:
   - Keep controls responsive.
   - Keep clear status feedback, but use static state where animation is not essential.
   - Do not remove core functionality to make numbers look better.
   - If an expensive feature is valuable, make it lazy, cached, or opt-in.

---

## Phase 6: Verify

Run the smallest meaningful checks first, then broaden.

Desktop checks to choose from:

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test -- <targeted test files>
npm --prefix apps/desktop run test
npm --prefix apps/desktop run build
npm --prefix apps/desktop run lint
```

For IPC/preload/type changes, verify all synced surfaces:
   - main handler
   - shared IPC/type
   - preload exposure
   - renderer caller
   - tests/mocks

For renderer performance changes:
   - Re-run the route sweep.
   - Re-run Work/Lanes stress if touched.
   - Confirm `document.getAnimations()` does not show persistent unnecessary animations.
   - Confirm process CPU returns near idle after stress.
   - Confirm logs do not show repeated full refreshes or identical calls.

For terminal changes:
   - Verify output is not lost on fast exit.
   - Verify output streams while visible.
   - Verify resize still works.
   - Verify cleanup/dispose flushes pending data.

For cache changes:
   - Verify cold call and warm call behavior.
   - Verify invalidation when the underlying file/config/state changes.
   - Keep cache bounded.

---

## Final report

End with a concise report:

1. Surfaces tested.
2. Hot paths found, with concrete measurements or log evidence.
3. Fixes made.
4. Before/after observations.
5. Validation commands and results.
6. Residual risks or future optimization targets.
7. Cleanup performed, including whether the dev server is stopped.

If you found a suspected issue but did not fix it, say exactly why: not reproducible, too risky, needs product decision, or requires credentials/model spend.
