# Performance baseline (macOS, measured)

The numbers ADE has to stay inside. They were measured on one Mac after the
performance pass in PR #1560, and every change that can move them is
measured against this table during the work (see **Performance budget** in
`AGENTS.md` and `CLAUDE.md`).

## Machine and conditions

| | |
|---|---|
| Machine | MacBook Pro (Mac15,6), Apple M3 Pro, 12 cores, 18 GB |
| OS | macOS 27.0 (26A428) |
| Node | 22.13.1 |
| Build | dev build, `npm run dev:desktop` with its own runtime socket, sync OFF |
| Project | the ADE repository, 35 registered projects, about 10 lanes open |
| Background | 2 agent chats streaming in other lanes during idle measurements |
| Measured | 2026-10-09, main at `330996202` |

These are **macOS dev-build numbers**. The installed app with sync on also
carries remote-machine traffic, and a Windows or Linux host is not
comparable. Compare like with like: measure the same scenario, before and
after your change, on your own machine, and use this table for the
magnitudes and the ceilings. A Windows or Linux baseline goes in its own
file, not in these columns.

Numbers vary from run to run. Run a measurement twice and treat a difference
under about 20% as noise.

## The table

**Ceiling** is the line to stay under. Crossing it, or making a row more
than 25% worse than its baseline, means optimizing before the work is done
(see the rules below).

### Moving between tabs (renderer)

Measured with `route-sweep.mjs` on the second, warm visit. On a fresh dev
app the first visit also compiles the tab's modules.

| Metric | Before #1560 | Baseline | Ceiling |
|---|---|---|---|
| Longest freeze after switching tabs (sum of long tasks, 4 s) | Lanes 1,152 ms | 0–83 ms on every tab except Files (see open items) | 100 ms |
| Lanes: page elements | 22.8k | 2.1–2.9k | 5k |
| Other tabs: page elements | 1.1–1.7k | 0.9–1.9k | 3k |
| Lanes: IPC on open (perf run) | 58 calls, 9.2 s total | 39–62 calls, 2.2–7.6 s total (GitHub PR calls take 1–1.5 s each) | 70 calls; no call repeated once per row |
| Branch-diff reads per lane open | 2 | 1 | 1 |
| Commit-message reads per lane open | 20 | 0–7 (only commits without a `Co-authored-by` trailer) | one per commit without a trailer |
| Renderer JS heap, any tab | 97–133 MB | 136–165 MB | 220 MB |

### Idle (renderer, nothing typed)

Measured with `route-sweep.mjs` (idle phase), `gpu-trace.mjs`, and
`render-count.mjs`, with perf runs off.

| Metric | Before #1560 | Baseline | Ceiling |
|---|---|---|---|
| Static tabs (Lanes, CTO, History, Settings, Automations, Chats): main-thread work | 3–18 ms/s | 3–26 ms/s | 30 ms/s |
| Work with a chat streaming: main-thread work | — | 39–43 ms/s, 36–40 style recalcs/s | 60 ms/s |
| Work, idle Claude chat with mod UI on screen (dock with the band of three mods, 116 elements): main-thread work | — | 11–17 ms/s; 10–15 ms/s with the setting off, which is the default (Mac Studio M4 Max, 2026-10-12, not the baseline machine) | 30 ms/s |
| Settings, nothing animating: frames drawn | — | 0/s | 0/s |
| Settings › Overview, Project › Lanes, Location, Computer › ADE service, idle after load: main-thread work | — | 0.2–0.4 ms/s (Overview 6.8–9.2 ms/s in the first 26 s while its lazy reads land, then 0.3 ms/s); 1.2–1.6k page elements (Mac Studio M4 Max dev build, 2026-10-18, on top of `13d6f10c2`, not the baseline machine) | 30 ms/s |
| PRs with running checks (3 spinners): frames drawn | 63/s | 30/s | 40/s |
| PRs with running checks: GPU swap time | 118 ms/s | 57 ms/s | 80 ms/s |
| Chat list cards: re-renders | ~15/s | 0 | 0 |
| Top bar: re-renders | 28 per 15 s | 1–4 per 15 s | 5 per 15 s |
| Work area: re-renders | 30 per 12 s | 2 per 12 s | 5 per 12 s |
| React commits on Work while a chat streams | — | 5.3/s | 10/s |

### Processes (CPU and memory)

Measured with `process-cpu.sh` over 15 s on Work, idle, with 2 chats
streaming in the background, perf runs off.

| Process | Baseline CPU | Baseline RSS | Ceiling |
|---|---|---|---|
| Electron main | 10.5% | 120 MB | 15%, 200 MB |
| GPU | 3.4% | 64 MB | 10%, 150 MB |
| Renderer | 17.4% | 131 MB | 25%, 300 MB |
| Brain (`cli.cjs serve`) | 4.5% | 55 MB | 10%, 250 MB |

### Idle, no chats, 5 min (background work)

The dev app on Work with no chat running, one window, DevTools closed, 150 s
after launch, then a 5-minute window. Child processes are counted with
`spawn-trace.cjs` loaded into the app and its brain, and summarized with
`spawn-report.mjs`; a process sampler (`process-cpu.sh`) misses them because
each lives for tens of milliseconds. Their CPU is the count times the measured
cost of one run (`gh auth token` 54 ms, `ps -axo` 17 ms, `git status` 66 ms,
most other git 9–12 ms). Measured 2026-10-20 on `2f8c10383` against its parent,
back to back, on a Mac15,6-class machine with five other dev apps and agents
running, the ADE repository open, and its lanes changing under other agents.

| Metric | Before (`45458b44e`) | Baseline | Ceiling |
|---|---|---|---|
| Child processes started (app + brain) | 762 per 5 min (152/min) | 293 per 5 min (59/min) | 400 per 5 min |
| `gh auth token` runs (brain, one per GitHub credential read before) | 207 | 5 | 12 (one per 30 s TTL) |
| Machine-wide `ps` runs (Electron main, top bar load indicator) | 152 (every 2 s) | 30 (every 10 s while calm) | 40 |
| CPU in those child processes | ~6.4% of a core | ~1.2% of a core | 2% |
| Electron main / brain process CPU (`process-cpu.sh`) | 1.7% / 4.3% | 1.3% / 4.4% | 15% / 10% (the Processes table) |

What is left is mostly git run by the brain as lanes change (`git remote
get-url`, `worktree list`, `rev-parse` from the lane list and the search
index's lane re-index) and a `launchctl print` service probe every 15 s
(5 ms each). On a repository nobody else is changing, the git share should
be far smaller; it was not measured that way.

### Chat and typing

| Metric | How | Before #1560 | Baseline | Ceiling |
|---|---|---|---|---|
| Switching to a chat: time until settled | `chat-switch.mjs` | 247 ms | 56–172 ms | 250 ms |
| Switching to a chat: longest task | `chat-switch.mjs` | — | 77–100 ms | 120 ms |
| Renderer work per keystroke (dev) | `keystroke-trace.mjs` | — | ~4.5 ms (style 2.3, script 1.6) | 8 ms |
| Input to next frame, 10k plain draft with ultrathink (dev) | CDP input-to-next-rAF, 120 keys/run, 3 runs; 2026-10-16 at `d36087c5b` | — | p50 3.4 ms; p90 4.1–4.2 ms (1327×800, throwaway project, no model messages) | 8 ms |
| Keystrokes slower than 16 ms (dev) | `typing.mjs` | — | 8 of 80 events | 16 of 80 |
| Renderer busy per keystroke (production build, headless) | `scripts/perf-chat-stream.mjs` harness | 12–15 ms | 12–15 ms | 16 ms |
| Streaming: cost per event (production build) | `scripts/perf-chat-stream.mjs` | 8.1 ms | 7.7 ms | 10 ms |

### Composer pickers

`SCREENCAST=1 interaction.mjs pickers 8`, warm rounds, two runs, on the Work
composer of a new chat (dev build, 2026-10-14, on `e3bf1ff82` plus the picker
redesign). "Before" is the same app session with the pre-redesign pickers.
`SCREENCAST=1` keeps a covered dev window drawing; without it a hidden window
draws no frames and every row waits out its cap.

| Metric | How | Before | Baseline | Ceiling |
|---|---|---|---|---|
| Model picker: open to first frame | `interaction.mjs pickers` | 83–88 ms | 80–82 ms | 110 ms |
| Model picker: long frames while opening | same | 57–67 ms | 65–66 ms | 85 ms |
| Model picker: switch provider rail (Cursor, 5 sub-tabs) | same | 59–63 ms | 42 ms | 80 ms |
| Model picker: switch provider rail (Anthropic) | same | 22–24 ms | 22 ms | 40 ms |
| Effort picker: open to first frame | same | 25–26 ms | 23 ms | 40 ms |
| Permission picker: open to first frame | same | 12–15 ms | 13 ms | 30 ms |

Opening the model picker is mostly React mounting the panel in the dev build
and Radix placing it (two forced layouts). Its rows are a fixed 50 px so the
virtual list never measures them; rendered rows are kept to one screen plus
four. A popover's open/close animation applies to the popper wrapper's child
only: a descendant selector made every nested Radix part with `data-state`
(each row's context-menu trigger) fade out and back on each open.

### Brain and services

Run without the app (`scripts/perf/service/`).

| Metric | Bench | Before #1560 | Baseline | Ceiling |
|---|---|---|---|---|
| Files quick-open index build (this repo) | `file-index.bench.mts` | 17.5 s, ~540 git processes | 120–183 ms, 1 git process | 500 ms |
| Quick-open lookup | `file-index.bench.mts` | — | 2–13 ms | 50 ms |
| Project registry: one read per project (35) | `registry-read.bench.mts` | 360 ms | 0.3 ms | 5 ms |
| Recent-project summary: one pass over the recents, each opening its project database (10 real recents, 6 with an `ade.db`) | one-off in-process `vitest` loop over `inspectRecentProject` (no bench file yet) | — | 0.5 ms (25.3 ms before the memo, PR #1661) | 5 ms |
| Machine roster, warm (11 projects, 23 chats) | `roster.bench.mts` | 43 ms | 2.5–4.2 ms | 10 ms |
| Machine roster, cold | `roster.bench.mts` | — | 70 ms | 150 ms |
| Reading a 10 MB request, Content-Length framed | `rpc-read.bench.mts` | 240 ms | 10.8 ms | 30 ms |
| Reading a 10 MB request, JSONL | `rpc-read.bench.mts` | 99 ms | 8.7 ms | 30 ms |
| CLI PATH lookup once its cache has expired | `shell-path.bench.mts` | 1,265 ms | 2–11 ms | 20 ms |
| Brain cold start, spawn of `cli.cjs serve` to `ADE brain listening` (throwaway home, `--no-sync`): no compile cache → the service's compile cache; median of 9 pairs, two sessions | `brain-start.bench.mts` | — | 2,725 → 2,498 ms and 2,737 → 2,525 ms (perf/brain-compile-cache) | not set yet; needs approval |
| Settings › MCP servers: scan of the provider CLI configs (169 KB `~/.claude.json`, 17 KB Codex `config.toml`; runs in Electron main, twice per page open) | one-off `tsx` loop over `scanProviderMcpConfigs`, 20 runs (no bench file yet) | — | 4–6 ms, 18 ms cold | 25 ms |
| MCP App: file one app with the chat (218 KB page, its record, and the prune of a 40-app chat; `mcpAppStore.write`, runs in the brain once per tool call that has a page) | one-off `tsx` loop, 60 runs (no bench file yet) | — | 0.9–1.7 ms; reading one back 0.1 ms | 10 ms |
| MCP App: tool result to transcript card (list lookup, `resources/read` through the live session, file, emit), 6 KB page | timestamps of the `tool_result` and `ade_card` events in a dev-brain transcript, Claude ×4 and Codex ×2 | — | 2–10 ms (Claude, first call of a session reads the tool list); 2 ms (Codex) | 100 ms |
| Chat search across 37 registered projects (2,000 chat docs each, every doc a hit) | `search-fanout.bench.mts` | not from #1560: until 2026-10-13 the search loaded every project and blocked the brain past its 30 s watchdog | 325–341 ms, longest event-loop block 10 ms | 800 ms, block 50 ms |
| `sessions.list` handler, 617 chat metadata files (synthetic, sized like a real project: 8.1 MB, p50 4.4 KB, p90 34 KB, max 152 KB). Chat-scoped (a chat pane's shells, per chat switch) / lane (`limit 200`) / unscoped (`limit 500`); median of 7 runs in each of 3 processes | `session-list.bench.mts` | — | chat-scoped 226 → 13 ms; lane 102 → 78 ms; unscoped 235 → 191 ms (main → head, with the orphan repair; medians of 3 interleaved processes). Chat metadata reads per call 500 → 0, 222 → 137, 500 → 351 | proposed, needs approval: chat-scoped 25 ms, lane 120 ms, unscoped 250 ms |

On 2026-10-19, a focused Node 22 harness compared the existing 5-second
desktop poll with the brain poll after this change. Both used the same activity
summary over 35 registered projects (12 booted), with no active work, for 15 s:
the old desktop loop used 0.711% process CPU for 3 summary reads; the brain loop
used 0.082% for 4 reads. This is a service-only sample, not a full ADE process
benchmark. The default remains `never`, so the brain adds no poll in the normal
idle baseline above; the enabled path moves the existing poll to the brain and
keeps its 5-second cadence.

### Desktop start-up (main process)

Unpackaged build (`apps/desktop/electron.cjs` → `dist/main/main.cjs`), Electron
41.5.0 on Node 24.15.0, medians of 18 launches (two blocks of 9). Spread is the
standard deviation of the 18 values. Command: `scripts/perf/desktop-main-start.mjs`.

| Metric | Bench | Before | Baseline | Ceiling |
|---|---|---|---|---|
| Process start to bundle evaluated, no compile cache (`--mode off`; sd 14 ms) | `desktop-main-start.mjs --mode off` | — | 734 ms | not set, needs your OK |
| Process start to first window, no compile cache (sd 17–33 ms) | `desktop-main-start.mjs --mode off` | — | 1023 ms | not set, needs your OK |
| Process start to first window, warm compile cache (sd 40 ms) | `desktop-main-start.mjs --mode warm` | 1027 ms | 881 ms | not set, needs your OK |
| Process start to first window, first launch after an update (`--mode cold`) | `desktop-main-start.mjs --mode cold` | — | 1114 ms | not set, needs your OK |
| Cursor sign-in snapshot on the launch status path (`buildProviderConnections` → `getCursorSdkAuthSnapshot`): reads `~/.cursor/sdk/auth.json` instead of importing `@cursor/sdk` on the main thread. Windows 11 bench, not the macOS machine above; Electron main not measured | one-off `node` loop, 3 cold processes, Node 22.13.1 (`import()` of the SDK, then the file read) | 411–815 ms (cold SDK import) | 0.2–0.3 ms (file read) | not set, needs your OK |

### Open items (measured, over budget or unbudgeted)

- **Files tab switch:** 0–295 ms. The profile shows the kept-alive Work tab
  re-rendering (TerminalsPage, the chat composer) and the chat list's
  virtualizer forcing layout (`getBoundingClientRect`) when you switch to
  Files.
- **First Work open after launch:** a long chat backfills its older history
  in idle slots: 114–171 pages over 8–14 s, at about 350 ms/s of main-thread
  work, once per chat per session. A page is 256 KB of raw JSONL
  (`CHAT_HISTORY_PAGE_MAX_BYTES`), and the batch reader stops at the first page
  that holds a `user_message`, which a full page almost always does — so one
  idle slot is one page, and the count is the older transcript's bytes over
  256 KB. Each page re-collapsed the whole resident transcript, with a scan of
  every row per `tool_result` on top of it (quadratic over a backfill); the
  scan is gone in `334ea36ad`. Measured with `chat-backfill.bench.mts` (new; a
  54,000-event chat over 63 pages, this machine, Node 22.13.1), before → after:
  row pipeline per backfill 2,478 ms → 1,063 ms, last page 93.3 ms → 31.4 ms,
  first page 3.7 ms → 3.5 ms, with identical pages, resident events and
  resident rows. What is left is one linear collapse pass plus the list's
  commit per page. The app-level numbers above were not re-measured.
- **Remote browser host, not measured:** a desktop that has shown a chat
  from another machine keeps one runtime event subscription for that machine
  after the chat leaves the front, so it can run that chat's browser commands
  (`remoteBrowserCallHost.ts`, the four most recently shown machines). While
  the chat is in front the subscription is one the pane already holds. The
  idle cost with the chat in the background needs two machines to measure and
  was not measured when this was added (2026-10-13).
- **GitHub calls:** `pr.getChecks` and `pr.getStatus` take 1–1.5 s each
  (network) and dominate the Lanes and PRs IPC totals.
- **Prewarmed Claude processes:** 150–420 MB each until they are reaped
  after 5 minutes.
- **Typing:** each keystroke still re-renders the whole chat pane (about 150
  component renders and 3 ms of script per key in the dev build). The pane's
  header, composer and closed dialogs render with it; the same chrome renders
  once per streamed event.
- **A chat at its resident cap** (60,000 events or 32 MB) used to drop one
  event from the front on every flush, so every flush was a new list and the
  live merge and the row builder took the full path on every streamed event.
  It now gives up a step of the budget at a time (2026-10-16, `perf/resident-cap`;
  the two resident-cap rows in the table above). What is left on that path: a
  trim still rebuilds the rows from scratch (about 2.6 s at 32 MB for the
  file-change-heavy transcript the bench tiles), and the view-cache write walks
  the whole window to size it on every flush
  (`estimateAgentChatSessionViewBytes`, `AgentChatPane.tsx`). No real transcript
  reaches the cap — the largest is at about half the byte cap — so both are
  bench-only numbers.
- **PRs tab:** the only tab with a long task on a warm visit (54-61 ms on the
  Mac Studio): the PR body's markdown parse and the mount of about 2,300
  elements.

## How to measure

### Start the dev app for measuring

Use the normal detached launch (`AGENTS.md`, "Running the dev app") with the
debug flags that keep a covered window running at full speed:

```bash
export ADE_APP_CONTROL_DEBUG_FLAGS="--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling"
# Only for IPC timings. Leave it unset for idle, GPU, typing and memory.
export ADE_PERF_RUN_ID=<run-id>
node scripts/dev-detached.mjs /tmp/ade-dev-<lane>.log \
  npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock
```

The UI scripts talk to the renderer over CDP port 9222 and pick the first
`//localhost:` page, or the packaged app's `index.html` page when no dev page
is open. Set `CDP_TARGET_URL=localhost:<port>` to the port on the log's
`dev launcher using` line when more than one window is open.

### Gotchas that wreck numbers

- **A perf run inflates idle numbers.** With `ADE_PERF_RUN_ID` set, the
  stream sampler (`renderer/perf/streamSmoothness.ts`) runs a
  `requestAnimationFrame` loop while any chat streams. That made an idle
  Settings tab draw 136 frames/s and the GPU sit at 39%. Take IPC timings
  in a perf run, and everything else without one.
- **Close extra windows.** A DevTools window or a stale restored window is
  a second renderer that draws. List the pages with
  `curl -s http://127.0.0.1:9222/json/list` and close extras with
  `curl -s http://127.0.0.1:9222/json/close/<id>`.
- **The first visit to a tab is not representative.** In dev, Vite compiles
  the tab's modules on first use. Sweep twice and keep the second pass.
- **Say what was running.** Streaming chats, running PR checks and spinners
  change idle numbers. Record them next to your numbers.

### Scripts

UI, against a running dev app (`scripts/perf/ui/`). The packaged app works too: the scripts that navigate use hash routes (`#/work`) automatically on its `file:` page, or with `--hash` / `CDP_HASH_ROUTES=1`, and `CDP_HASH_ROUTES=0` forces path routes:

| Script | Measures |
|---|---|
| `route-sweep.mjs <runId> <route>,... [idleSecs]` | Per tab: long tasks after switching, IPC calls and time (perf run only), then idle task time, style recalcs, heap, page elements and running animations |
| `process-cpu.sh <secs> <runtime-socket>` | CPU % and RSS for the main, GPU, renderer and brain processes |
| `spawn-trace.cjs` (load with `NODE_OPTIONS="--require <abs path>"`) and `spawn-report.mjs <dir> <fromMs> <toMs>` | Every child process the app and its brain start, with the call site that started it, grouped over a time window. For the Idle background-work rows |
| `gpu-trace.mjs <secs>` | Frames drawn, GPU swap time and rendering phases, for the whole browser |
| `render-count.mjs <secs> reload` | React commits and which components re-render, and why (changed props or hooks) |
| `chat-switch.mjs [rounds]` | Clicks through the chat list; time until each transcript settles, and long tasks |
| `interaction.mjs tabs\|chats\|projects\|pickers [rounds]` | Per tab, chat or project switch, or composer picker open (`pickers`; `SCREENCAST=1` for a covered window): time to the first frame that shows a change, time until the page stops changing (`settled`, every DOM change), and long frames in between. `content settled` ignores decoration and tickers (`data-perf-ignore`, `aria-hidden` inside `<main>`), and `content ready` is when the page's `<main>` first has new text. The rules are in `scripts/perf/ui/settle.mjs`. Finer than long tasks, which miss every frame under 50 ms |
| `press-to-paint.mjs chats\|tabs\|projects [rounds]` | The same switches from the hand: real mouse input (move, press, a held button, release) and the time from the press to the first frame that shows the new chat, page or project. `interaction.mjs` starts its clock in the click handler and cannot see the time the button is held |
| `press-to-paint.mjs rapid [runs]` | Presses several chat rows a fixed interval apart: time from the last press to the last chat's content, which earlier chats painted on the way, and the main-thread work of the whole burst |
| `typing.mjs <keys>` | Types into the composer; keystroke events slower than 16 ms |
| `keystroke-trace.mjs <keys>` | Renderer work per keystroke, split into style, layout, paint and script |
| `cdp.mjs eval\|metrics\|profile\|shot\|anim` | One-off probes: evaluate, metrics delta, CPU profile with top functions, screenshot, running animations |
| `music-host.sh <secs>` | CPU %, RSS and physical footprint of the macOS Apple Music host and the WebKit processes it started |
| `music.mjs first-play cold\|warm`, `music.mjs pushes <secs>` | Time from Play to the first playing state, with the host stopped or running; Music state pushes a window receives |
| `music-library.mjs detail\|grid\|scroll\|memory` | Apple Music library: time to a playlist's first rows and full list, Playlists grid open and scroll (long tasks, IPC and Apple requests through the main process's inspector, artwork requests), renderer heap after opening playlists |

Brain and services, no app needed (`scripts/perf/service/`, run from
`apps/ade-cli` with `npx tsx ../../scripts/perf/service/<name>.bench.mts`):
`file-index`, `registry-read`, `roster`, `rpc-read`, `shell-path`,
`search-fanout`, `chat-transcript`, `chat-backfill`, `tree-watcher` (plus `tree-watcher-parity.mts`, a
comparison and not a timing). They read temp copies of state and never write
to `~/.ade`.
`chat-transcript` is the chat renderer's own pipeline (live merge, display
filter, row builder) run on real transcripts: one full pass as a chat opens,
then 500 events one at a time as a turn streams.
`chat-backfill` is the same pipeline as a chat's older history pages in: the
pager's byte window and turn anchoring, the capped merge, and the row build per
landed page, reported per page (`--synthetic N` builds a transcript instead of
reading one).

Production-build chat streaming and typing:
`scripts/perf-chat-stream.mjs` (headless Chromium against `vite preview`).
To profile the brain, start its inspector with `process._debugProcess(<pid>)`
and record with the `cdp.mjs profile` command, pointing `CDP_WS` at the
inspector's WebSocket URL.

## Updating this table

- **New surface or path:** add a row with the metric, the script that
  measures it, its baseline and a ceiling.
- **A number changes:** update the baseline and note the commit in the
  "Measured" line or next to the row. If you measured on a different
  machine, say so; a different machine is a new column, not a new value.
- **Ceilings:** do not raise a ceiling to make your change pass. Raising one
  needs the user's approval and a recorded reason.


## Hosted web client

Browser measurements from PR #1561, on the same MacBook Pro (Mac15,6, M3 Pro,
18 GB, macOS 27.0, Node 22.13.1) under heavy concurrent agent and build load.
These are different scenarios and load conditions from the desktop baseline
above.
Cold signed-out runs used the same localhost production build and headless
60 Hz display, with before/after load averages about 8.8–9.6. The source cold-load
capture compares `c68bbf0b1` with `5ffa4f3be`; later poller and interleaved
streaming measurements include the branch's follow-up fixes. They are recorded
in the branch review evidence (`before-after.md` and the interleaved
`after.json` capture), not a fresh idle or GPU measurement. Streaming numbers are
interleaved A/B on this same machine under load; compare like conditions.

| Scenario / metric | Before | Baseline after | Ceiling | How |
| --- | ---: | ---: | ---: | --- |
| Cold signed-out requests | 123 | 47 | 60 | `npm run bench:webclient` in `apps/desktop` |
| Cold signed-out transfer (KB) | 9,703 | 1,552 | 2,000 | `npm run bench:webclient` in `apps/desktop` |
| Cold signed-out JS (KB) | 8,455 | 736 | 950 | `npm run bench:webclient` in `apps/desktop` |
| Cold signed-out images (KB) | 376 | 79 | 100 | `npm run bench:webclient` in `apps/desktop` |
| Cold signed-out heap after GC (MB) | 14.9 | 2.7 | 3.5 | `npm run bench:webclient` in `apps/desktop` |
| Cold signed-out gate visible (ms) | 305 | 149 | 190 | `npm run bench:webclient` in `apps/desktop` |
| Cold signed-out long-task total (ms) | 53 | 0 | 10 | `npm run bench:webclient` in `apps/desktop` |
| Fleet polls / visible minute | 30 | 7 | 9 | `npm run bench:webclient` in `apps/desktop` |
| Fleet polls / hidden minute | 30 | 0 | 0 | `npm run bench:webclient` in `apps/desktop` |
| App Control polls / visible minute | 20 | 7 | 9 | `npm run bench:webclient` in `apps/desktop` |
| App Control polls / hidden minute | 20 | 0 | 0 | `npm run bench:webclient` in `apps/desktop` |
| OAuth reads / five minutes | 300 | 108 | 140 | `npm run bench:webclient` in `apps/desktop` |
| Streaming script ms / event | 12.8 | 11.7 | 15.0 | `scripts/perf-chat-stream.mjs` |

The zero-baseline long-task row has a small absolute ceiling rather than a
percentage margin; hidden-tab reads have a strict zero ceiling. These rows do
not change any desktop ceiling.

## Mac Studio (M4 Max), ADE-175 pass

A second machine, so a second set of columns and not new values for the tables
above. Every "before" and "after" here was measured on this machine, one after
the other, on main at `36aab9e76` and on the ADE-175 branch.

| | |
|---|---|
| Machine | Mac Studio (Mac16,9), Apple M4 Max, 14 cores, 36 GB, 5120x1440 display at 240 Hz |
| OS | macOS 27.0 (26A428) |
| Node | 22.22.2 |
| Build | dev build, `npm run dev:desktop` with its own runtime socket, sync OFF; headless Chrome 153 for the web client and the stream bench |
| Project | the ADE repository, three chats in the Work list |
| Background | other agents and test runs on the machine; 1-minute load average 4-9 during the timed runs |
| Measured | 2026-10-10 |

### Chat streaming and the transcript pipeline

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Streaming: script per event (9,741-event chat, 400 events at 30/s) | `npm run bench:webclient`, interleaved A/B, 3 runs | 8.0 ms | 5.7 ms | 7.5 ms |
| Streaming: main-thread task time per event | same | 10.7 ms | 8.3 ms | 10 ms |
| Streaming: renderer CPU | same | 38.4% | 30.7% | 38% |
| Streaming: React commits per event | same | 2.8 | 2.3 | 2.8 |
| Streaming: transcript row renders per event | `scripts/perf-chat-stream.mjs --render-hook` | 24 | 0.12 | 1 |
| Streaming: chat pane renders per event | same | 1.73 | 1.0 | 1.1 |
| Streaming: component renders per event | same | 452 | 154 | 200 |
| Streaming: renderer busy time for 400 events (CPU profile) | `scripts/perf-chat-stream.mjs --profile` | 3,890 ms | 2,200 ms | 2,800 ms |
| Transcript rows: cost per streamed event (five largest chats) | `chat-transcript.bench.mts` | 2.95 ms | 0.08 ms | 0.3 ms |
| Live merge: cost per streamed event | same | 0.94 ms | 0.04 ms | 0.15 ms |
| Streamed events that cost more than one 240 Hz frame (4 ms), of 2,500 | same | 340 | 4-5 | 15 |
| Transcript rows: full pass as a chat opens (7,000-13,000 events) | same | 22.0 ms | 12.1 ms | 18 ms |
| Transcript at the resident cap (32 MB, 33k events): cost per streamed event, between trims | `chat-transcript.bench.mts`, `RESIDENT_STREAM_EVENTS=300` | 1,362 ms | 0.62 ms | 2 ms |
| Transcript at the resident cap (32 MB, 33k events): cost per streamed event over 2,400 events, trims included | same, `RESIDENT_STREAM_EVENTS=2400` | 1,362 ms | 2.8 ms | 4 ms |
| Open a long chat to its first rows (fresh Chrome profile) | `npm run bench:webclient` | 287 ms | 285 ms | 360 ms |
| Composer keystroke to paint, idle, p50 (headless, 60 Hz) | same | 28.0 ms | 28.5 ms | 35 ms |

The row and merge numbers are a production-style Node run; the streaming
numbers are the dev build, where React's own work is two to three times what a
packaged build pays.

The two resident-cap rows are the same bench on a window that has filled its
budget, which no real transcript reaches: it tiles the largest real transcript
until the window is at 32 MB, each copy a later stretch of the same chat. There
a trim hands on a new list, and the live merge, the display filter and the row
builder all fall back to a full pass — so the "before" column is one whole
transcript per streamed event, 1,362 ms of it for this (file-change-heavy)
transcript, flat over the stream, and `fullRebuildMs` is what one trim costs at
that size. Trimming a step at a time (a sixteenth of the budget) makes that cost
one flush in about 2,000 rather than every flush, which is the amortized row:
2.8 ms per event against about 0.6 ms between trims. Measured 2026-10-16, branch
`perf/resident-cap`; a window at the 60,000-event cap reads the same way
(4,304 ms → 15 ms per event over 300 events).

### Find in a chat and in a diff (⌘F)

Measured 2026-10-12 on the dev build in an App Control session: the 5,031-event
"Mac Desktop Tool Planning" chat and the 1,100-event "Quit Dialog Redesign"
chat, query `the`. The A/B streaming rows are `npm run bench:webclient
--skip-build --skip-load`, before = the tree without find, 3 interleaved runs,
1-minute load average 9-11 (other agents running), so treat ±0.2 ms as noise.

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Streaming: script per event, find closed | `bench:webclient` A/B | 5.8 ms | 5.9 ms | 7.5 ms |
| Streaming: main-thread task per event, find closed | same | 8.7 ms | 8.8 ms | 10 ms |
| Streaming: React commits per event, find closed | same | 2.3 | 2.3 | 2.8 |
| Open a long chat to its first rows | same | 340 ms | 350 ms | 360 ms |
| Find: first count after typing, 5,031-event chat, cold index | in-page timer | — | 114 ms | 200 ms |
| Find: final count, same chat, cold index (3 ms slices + 300 ms recount) | same | — | 492 ms | 800 ms |
| Find: next match to painted highlight, p50 / max of 20 | same | — | 4 / 7 ms | 8 / 33 ms |

Closed, find does no work: its layer is memoized on stable props and
subscribes to rows only while open. Indexing parses markdown in 3 ms slices, so
it never holds a 240 Hz frame.

### Desktop dev app

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Renderer JS heap after GC, fresh launch, with a 60 MB browser-mock snapshot in the checkout | CDP `HeapProfiler.collectGarbage` + `Performance.getMetrics` | 477 MB | 129 MB | 220 MB |
| Renderer JS heap while sweeping the tabs | `route-sweep.mjs` | 481-505 MB | 159-177 MB | 220 MB |
| Launch: longest event-loop stall logged by the renderer watchdog | dev log, `renderer.event_loop_stall` | 6,077 ms | none | 1,500 ms |
| Tab switch: long tasks, warm | `route-sweep.mjs` | 0 ms; PRs 58 ms | 0 ms; PRs 54-61 ms | 100 ms |
| Tab switch: first changed frame, warm | `interaction.mjs tabs` | 24-44 ms; PRs 80 ms | 24-45 ms; PRs 77-86 ms | 60 ms; PRs 110 ms |
| Tab switch: page settled, warm | `interaction.mjs tabs` | 35-205 ms | 33-195 ms | 250 ms |
| Chat switch: first changed frame, warm | `interaction.mjs chats` | 37-41 ms | 38-58 ms | 60 ms |
| Chat switch: time until settled, warm rounds | `chat-switch.mjs` | 15-122 ms | 16-63 ms | 250 ms |
| Renderer script per keystroke (same app session, alternating A/B, 360 keys each) | CDP `Performance.getMetrics` around typed keys | 3.05 ms | 3.18 ms | 4 ms |
| Frames drawn at idle, any tab, DevTools window closed | `gpu-trace.mjs` | 0-2/s | 0-2/s | 5/s |

Tab switches, chat switches and typing did not move: they are bound by React
mounting the tab, not by anything this pass changed. The heap rows need the
snapshot file to show a difference; without it both columns read about 130 MB.
A DevTools window draws 240 frames a second on this display by itself, so
close it before any idle or GPU number (see the gotchas above).

### Apple Music (the macOS player host and the Music tab)

Measured 2026-10-13 on this Mac Studio, dev build in an App Control session,
DevTools window closed, baseline at `2b449846f`. Signed out, so playback is a
30-second catalog preview (the host, MusicKit and the UI do the same work for a
full track; the FairPlay decode happens in WebKit's GPU process, which is in
the host rows). The host is new on macOS, so its rows have no before. The tab
rows are an interleaved A/B in one session, with the old progress-line
transition put back by an injected style for "before". Other agents were
running on the machine.

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Player host and its WebKit processes, playing: CPU | `music-host.sh 10` | — | 0.5-0.8% | 3% |
| Same, playing: physical footprint | same | — | 75-81 MB | 120 MB |
| Same, paused (until the 5-minute unload): CPU / footprint | same | — | 0.0-0.2% / 73-75 MB | 1% / 120 MB |
| Electron GPU process, playing, Work tab in front | `process-cpu.sh 8` | 21-28% | 1.9-2.5% | 5% |
| Renderer, playing, Work tab in front | same | 11.3-14.5% | 5.4-7.1% | 10% |
| Compositor draws, playing, Work tab in front | `gpu-trace.mjs 4` | 240/s | 2/s | 5/s |
| Electron GPU process, playing, Music tab in front | `process-cpu.sh 8` | 26% | 12% | 15% |
| Renderer, playing, Music tab in front | same | 10.4% | 4.9-5.0% | 8% |
| Music state pushes to each window, steady playback | `music.mjs pushes 12` | 0.75/s | 0/s | 0.2/s |
| First playing push after Play, host not running | `music.mjs first-play cold` | — | 0.76-1.15 s | 2 s |
| Same, host running | `music.mjs first-play warm` | — | 0.16-0.39 s | 0.6 s |
| Switching to the Music tab: long tasks / idle main thread | `route-sweep.mjs` | — | 0 ms / 0.9-2.3 ms/s | 100 ms / 30 ms/s |

**Library: playlists (paged loading and four-song covers).** Arul's real
library, 61 playlists, 37 of them with no artwork from Apple; the largest has
1,804 songs (19 pages). Same app session, signed in, DevTools closed, nothing
playing; "before" is the tree at `3e0e350fe` (grid rows: the old tile code put
back by hot reload, interleaved with the new, 3 rounds each). Cold = the main
process's 60 s Apple cache expired.

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Largest playlist, cold: first song rows on screen | `music-library.mjs detail` | 9,483 ms | 516-1,077 ms | 1,500 ms |
| Largest playlist, cold: full list | same | 9,483 ms | 2,882-3,829 ms | 9,500 ms |
| Largest playlist: Apple requests / IPC calls | same | 19 / 1 | 19 / 19 | 19 / 20 |
| Largest playlist: long tasks while it loads | same | 0 ms | 0 ms | 50 ms |
| Playlists grid, first open: long tasks | `music-library.mjs grid` | 0 ms | 0 ms | 50 ms |
| Playlists grid, first open: renderer CPU (6 s) | `process-cpu.sh 6`, mean of the runs | 6.2% (5.3-6.8) | 5.3% (3.5-6.2) | 8% |
| Playlists grid, second open: renderer CPU (6 s) | same | 3.9% (2.8-5.3) | 2.6% (0.2-5.0) | 5% |
| Playlists grid, first open: IPC calls / Apple requests | `music-library.mjs grid` | 1 / 1 | 17 / 17 (`76dff3d31`; 10 / 10 at `a123eee6a`) | 1 + one per cover tile on screen (17 / 17 in this library) |
| Playlists grid, second open: IPC calls / Apple requests | same | 1 / 0 | 1 / 0 | 1 / 0 |
| Playlists grid, first open: artwork requests / KB | same | 39 / 289 | 27-29 / 213-494 (`76dff3d31`) | 60 / 500 |
| Playlists grid, second open: artwork requests | same | 34-36 | 0-2 (`76dff3d31`) | 5 |
| Playlists grid, scroll to the end and back: long tasks | `music-library.mjs scroll` | 0 ms | 0 ms | 50 ms |
| Same scroll, first time: cover reads (limit 4) | same | 0 | 22-38 (`76dff3d31`; 25-28 at `a123eee6a`) | one per cover tile, no repeats (54 in this library) |
| Renderer JS heap after GC, five largest playlists opened | `music-library.mjs memory` | 102.6 MB | 101.3-102.3 MB | 125 MB |
| Renderer RSS, same | `ps` | 295 MB | 265-280 MB | 360 MB |

- **Full list:** the old main-process loop read the 19 pages one after
  another and returned them together. Reading them from the view one at a
  time measured 14.7-15.0 s (a page waited for the view to update before the
  next request), so the view reads the first page, then the rest four at a
  time (Apple reports the total) and appends them in order.
- **Covers** cost one `tracks` read with limit 4 per cover tile that comes on
  screen, at most four at a time, never while the window is hidden (verified:
  0 reads while hidden, 9 once visible), then nothing: a bounded LRU (300)
  serves later opens. Each cell requests Apple's artwork at its own pixel size
  (96 px here). Since `76dff3d31` a cover tile is any playlist whose artwork
  the renderer cannot load: 54 of the 61 here, 37 with none from Apple and 17
  with an uploaded cover on `*.blobstore.apple.com`, which the CSP blocks. A
  first open reads the 16 on screen and a scroll reads the rest (22-38 across
  runs, depending on how much the first open reached; every read was a
  different playlist, checked by playlist id). The blocked cover requests are
  gone: 34 per open at `a123eee6a`, 0 now.
- **`76dff3d31` re-bench** (2026-10-13, interleaved with `a123eee6a`, 3 rounds,
  main cache cold before each): long tasks 0 on open and scroll for both.
  Renderer CPU over 6 s, first open 8.0% (6.2-9.0) at `a123eee6a` vs 7.0%
  (2.7-11.5) now; second open 6.6% (4.2-8.0) vs 7.0% (4.8-10.5): no difference
  within the noise. The whole session ran hotter than the baseline run (the
  old tiles measured 6.6% on second open, against the recorded 3.9%), so the
  CPU rows above keep their baselines.
- **Ceilings raised, approved by Arul on 2026-10-13:** the first-open
  IPC/Apple row (was 14 / 14) and the scroll cover-read row (was 37) were set
  from the `a123eee6a` numbers, before uploaded-cover playlists got covers.
  `76dff3d31` reads one more page per newly covered tile (17 on first open, up
  to 38 on scroll in this library), and removes the 34 blocked artwork
  requests per open, so total requests fall and CPU is unchanged. The ceilings
  are now per tile: 1 + one read per cover tile on screen, and one read per
  cover tile over a full scroll, never repeated.
- **Not done:** a playlist's own uploaded cover (`*.blobstore.apple.com`) is
  still not shown. Allowing it would load each as a fixed 1200x1200 JPEG with
  no size parameter, under a signature that changes on every library read
  (after the 60 s cache).

The scripts default to CDP port 9222; an App Control launch picks its own, so
pass `CDP_PORT=<port>` (and edit the port in `process-cpu.sh`,
`gpu-trace.mjs` and `route-sweep.mjs`, which pin 9222).

- **The tab's progress line** restarted a 1 s linear transition on every
  position tick, so Chromium drew the whole window at display rate for as
  long as a song played, on every tab. It now steps once a second.
- **State pushes:** the host ticks the position once a second, and the main
  process forwarded each tick to every window. Renderers interpolate the
  position, so a tick that agrees with that within 1.25 s is now dropped
  (MusicKit reports whole seconds), as is a broadcast equal to the last one.
- **The host** is a WKWebView with no window on screen, which WebKit throttles
  like a background tab; 73-81 MB across the host, its WebContent, Networking
  and GPU processes. The Windows host (WebView2) measured 141 MB private.
- **The Windows Spotify host** (same `ade-music-host.exe`, `--page page-spotify`,
  Spotify's Web Playback SDK instead of MusicKit) measured on 2026-10-15 at
  `be5b0670b` on Arul's Windows 11 PC, dev build, playing a full track to ADE's
  own Connect device: 3.5% CPU and 237.7 MB private across the host and its 9
  WebView2 children; 0.2% and 237.2 MB paused. The memory is 1.7x the Apple
  Music host's 141 MB because the SDK runs its player in an `sdk.scdn.co`
  iframe and Widevine decodes in its own process, so the tree has more
  renderers; `--renderer-process-limit=1` does not cover either. Ceiling:
  6% CPU playing, 320 MB private.
- **Open item:** while the playing song's row is on screen, its three
  equalizer bars (a CSS `steps()` animation) make Chromium update style and
  draw every frame (243 style updates/s on this 240 Hz display). Driving the
  same steps from Web Animations or from a timer cut style updates to 53-62/s
  but did not lower renderer or GPU process CPU in an A/B, so the CSS stays.

### Hosted web client

Cold signed-out load of the production build, interleaved A/B, 5 runs each
(`npm run bench:webclient -- --root <before> --compare <after>`).

| Metric | Before | Baseline | Ceiling |
|---|---:|---:|---:|
| Entry stylesheet (KB, raw) | 656.7 | 57.1 | 75 |
| Cold signed-out transfer (KB) | 1,555.8 | 736.0 | 900 |
| Cold signed-out CSS (KB) | 666.0 | 66.6 | 85 |
| Cold signed-out JS (KB) | 739.0 | 518.4 | 650 |
| Cold signed-out requests | 47 | 46 | 60 |
| Cold signed-out heap after GC (MB) | 2.7 | 2.3 | 3.0 |
| First contentful paint (ms) | 72 | 44 | 60 |
| React mounted (ms) | 51.1 | 37.8 | 48 |
| Sign-in card visible (ms) | 99.1 | 86.1 | 100 |
| DOMContentLoaded (ms) | 34.7 | 21.6 | 28 |

The sign-in screen is checked for sameness with computed styles, not by eye:
every standard property of every element (and `::before`/`::after`), old build
against new, with no difference in either set:

- 548,550 properties in ten interaction states (dark and light; default,
  hover, focus-visible, active, and a real pointer over the card);
- 403,542 properties in twelve stored-appearance states (default, light,
  follow-system in both OS modes, the legacy theme key, a retired theme id, a
  library theme, system fonts with Reduce motion, an image scene, a gradient
  scene with dots, and two flair themes).

`appStore` is out of the signed-out graph: the appearance values live in
`state/appearanceStore.ts`, which `appStore` registers with when it loads.
Not measured: the signed-in client over ADE Relay. The bench cannot sign in,
and a measurement in ADE's own browser would register a new device on the
account, so it waits for a go-ahead.

### Under load: four projects open

The rows above used one project and three chats. These used four real
projects open as tabs (ADE, Versic, crumb, fleet), every chat of the ADE
project loaded (eight, the largest 13,240 events), measured as an alternating
A/B in one app session (`scripts/perf/ui/interaction.mjs`, warm rounds).

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Project switch: first changed frame (median) | `interaction.mjs projects` | 173-180 ms | 53-55 ms | 75 ms |
| Project switch: longest frame | same | 112-184 ms | 0-50 ms | 60 ms |
| Project switch: page settled | same | 240-580 ms | 96-228 ms | 300 ms |
| Project switch: component renders | render counter | 12,950 | 4,890 | 6,500 |
| Tab switch: first changed frame (median) | `interaction.mjs tabs` | 59-63 ms | 28-32 ms | 45 ms |
| Tab switch: component renders | render counter | 1,227 | 722 | 950 |
| Chat switch: first changed frame (median) | `interaction.mjs chats` | 41-43 ms | 41-47 ms | 60 ms |
| Renderer JS heap after GC | CDP | - | 205 MB | 260 MB |
| Renderer at idle: main-thread work | CDP `Performance.getMetrics`, 30 s | - | 8.6 ms/s | 30 ms/s |

Chat switches did not move. A real Haiku reply streaming into a short chat in
this state drew 240 frames a second with no frame over 6 ms.

### Production build streaming

The dev build pays for React's development checks. The same replay against
production builds of the old and the new renderer (`vite build`, a static
server, headless Chrome, site data cleared before each run, interleaved):

| Metric | Before | Baseline | Ceiling |
|---|---:|---:|---:|
| Script per streamed event | 5.6 ms | 3.4 ms | 4.5 ms |
| Main-thread task time per event | 6.7 ms | 4.4 ms | 5.8 ms |
| Renderer CPU while streaming (30 events/s) | 23.7% | 16.8% | 22% |

### Brain: file watchers

On macOS every watcher polls (`withMacosSafeChokidarOptions`): each path under
the watched root is checked once a second on the brain's worker threads.

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Paths still polled one minute after the Files tab closed, when the page reloaded twice while it was open | `process.getActiveResourcesInfo()` in the brain | 6,994 | 3 | 10 |
| Brain CPU in that state | `process-cpu.sh` | 5.7% | 0.6% | 2% |
| Brain CPU with two leaked watchers on a large project (29,256 paths) | same | 19-20% | - | - |
| Paths still polled 22 s after a client's connection closed with a watch open (15,958 paths) | same | never released | 3 | 10 |

A watcher that is in use used to cost the same poll. On macOS a directory tree
is now watched with one recursive native watch (`watchTree`,
`services/shared/treeWatcher.ts`); measured on this repository's root with
`tree-watcher.bench.mts`, and in the app with the Files tab open:

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Brain CPU, Files tab open on a lane worktree (6,994 paths), nothing changing | `process-cpu.sh` | 5.7% | 0.5% | 2% |
| Paths polled each second in that state | `process.getActiveResourcesInfo()` | 6,994 | 3 (and one native watch) | 10 |
| Watcher CPU at idle over 5 s, repository root | `tree-watcher.bench.mts` | 680-840 ms | 3-66 ms | 150 ms |
| Time until the watcher is ready, repository root | same | 423-438 ms | 94-97 ms | 250 ms |
| Longest event-loop block on open and close | same | 30 ms | 2 ms | 20 ms |
| The same block with chokidar's own native mode (why polling was chosen) | same, `WITH_NATIVE_CHOKIDAR=1` | 13,207 ms | not used | - |

The events are the same as the poller's: `tree-watcher-parity.mts` runs both
on one temp tree through 18 kinds of file operation (create, change, delete,
directory trees, renames, moves in and out, atomic saves, slow writes, bursts,
symlinked directories, ignored paths) and compares what each reports. Over
300 steps and five seeds, two things differ. A file replaced by a directory of
the same name: the poller reports one wrong `change`, the native watcher the
delete and the creates (on purpose). A file written in pieces: either watcher
may report a `change` after its `add`, depending on timing; the file's final
state is reported by both.

## Mac Studio (M4 Max), switch pass: press to content

The rows above time a switch from its click handler. A click fires on
mouse-up, and the button of a normal click is down for 60 to 120 ms first, so
those rows left out most of what the reader waits for. These rows start the
clock at the press. Chat rows, the page tabs of the project sidebar, and the
machine tabs and project tabs of the top bar switch on the press
(`lib/pressActivation.ts`). A drag of a background project tab brings its
project to the front, as a browser tab does.

| | |
|---|---|
| Machine | Mac Studio (Mac16,9), Apple M4 Max, 14 cores, 36 GB, 5120x1440 display at 240 Hz |
| Build | dev build, `npm run dev:desktop` with its own runtime socket, sync OFF |
| Project | four real projects open as tabs (ADE, Versic, crumb, fleet), five chats in the Work list of ADE |
| Input | CDP `Input.dispatchMouseEvent`: 250 ms hover, press, 90 ms hold, release |
| Background | other agents and test runs on the machine; 1-minute load average 9-19 during the timed runs |
| Measured | 2026-10-11, main at `261940374` against the switch pass (on main as `38fad326d`; the project-tab row is `bbfe4e739`), as an alternating A/B in one app session (the renderer sources swapped by hot reload), two pairs each, warm rounds |

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Chat switch: press to content (median; range over the chats) | `press-to-paint.mjs chats` | 136-137 ms (124-138) | 47-51 ms (39-51) | 70 ms |
| Page tab switch: press to content | `press-to-paint.mjs tabs` | 118-120 ms (99-142) | 24-26 ms (7-39) | 50 ms |
| Page tab switch: press to the first frame (the tab strip marks the tab) | same | 100-101 ms | 8 ms | 16 ms |
| Project switch: press to content (its own alternating A/B, 2026-10-11: before is main at `2981421d5`, baseline is the project-tab change on top of it, load average 8-17) | `press-to-paint.mjs projects` | 136-137 ms (134-142) | 44-51 ms (40-54) | 70 ms |
| Rapid chat clicks (5 chats, 120 ms apart, 40 ms hold): last press to that chat's content | `press-to-paint.mjs rapid` | 89-91 ms | 44-51 ms | 70 ms |
| Rapid chat clicks: main-thread task time of the burst | same | 506-510 ms | 511-587 ms | 750 ms |
| Warm chat switch: main-thread task time, script time (700 ms after the click, idle subtracted, median of 20) | CDP `Performance.getMetrics` | 118-126 ms, 55-56 ms | 114-116 ms, 51-52 ms | 150 ms, 70 ms |
| Chat open, cold (after a page reload): press to content | `press-to-paint.mjs chats 1` | not measured as an A/B | 89-266 ms | 350 ms |
| Renderer JS heap after GC, after a visit to all 16 chats of the four projects | CDP `HeapProfiler.collectGarbage` + `Performance.getMetrics` | 235 MB | 246 MB | 260 MB |

The rows that time from the click handler did not move (`interaction.mjs`,
same session): chats 42 ms, page tabs 26 ms, projects 48 ms to the first
changed frame.

What the profile of a warm chat switch showed (CDP trace and CPU profile, 12
to 24 switches):

- The switch is one synchronous task of about 35 ms in the dev build: about
  24 ms of React work (the pane renders about 11 times for one switch, and
  about 350 components mount for the new rows) and about 10 ms of style and
  layout that the row measurement forces. The first frame follows it.
- The history read that follows a switch must give back the event list that
  the pane holds when nothing changed, or the transcript renders a second
  time, 10 to 18 ms after the first frame. Two things keep it so:
  `mergeAgentChatHistorySnapshot` hands back the held envelope of a tool call
  that a provider sent twice, and `RuntimeRpcClient` decodes its stream with
  a `StringDecoder` (a read that is decoded alone turns a multi-byte
  character at its boundary into U+FFFD, at a different place each time).
- The history read itself takes 4 to 19 ms. A cold open is slow because of
  its first render (row build, markdown parse, mounts), not because of data.

Measured and not kept:

- A read of a chat's history when the pointer rests on its row. Cold opens
  stayed in the same range (82-512 ms with it, 89-266 ms without), because
  the read is not what a cold open waits for.
- A project tab press that switches back when the press becomes a drag of
  the tab. A project switch is not a view change only (it writes the
  recent-project order in the main process and resets per-project state), so
  the way back was a second full switch.

The ceiling of the project row is 70 ms, the same as the chat row.

Not measured: the machine tabs of the top bar (Chats, Browser, Music), which
use the same press path as the page tabs.

Open items from this pass:

- A warm chat switch is still about 45 ms from the press in the dev build.
  The next cost to remove is the number of renders of the chat pane per switch
  (about 11) and the mount of every row of the new chat.
- Showing a parked chat pane is not cheap either: the return to the Work tab,
  which shows a pane that stayed mounted, takes 24-34 ms. A pool of mounted
  chat panes would gain little until the pane renders fewer times.
- After the older history of a chat has loaded in idle slots, the next history
  read removes the repeated tool calls of those pages and renders the
  transcript once more (once per chat per session).
- The view cache keeps a chat until 128 MB of cached events are held. A
  session that visits many long chats holds all of them up to that limit; the
  heap row above is 16 chats.

### Project database identity guard

Measured on macOS arm64, Node 26.7.0, warm interleaved medians across seven
runs of 20,000 SQLite operations; implementation commit `b34127f77`
(baseline `96e4a0de6`):

| Metric | Before | After | Budget |
|---|---|---|---|
| 100-row KV list query | 32.64 μs | 35.17 μs | Existing 25% regression rule |
| Device/inode guard incremental cost per operation | — | 2.53 μs | 5 μs |

The representative query increases 7.75%. A trivial one-row KV read increases
5.48 → 8.34 μs (+2.86 μs); this small query pays the full identity-check cost.
Checks run per operation to avoid a polling window that can write to a moved
file. These service measurements do not establish Electron idle, GPU, typing,
or memory numbers. Full desktop scenarios were not measured for this change.

The desktop main process also checks each open project's `ade.db` every
5 seconds (`openProjectDataWatch.ts`); no renderer work until it fires. While
the recovery screen waits on missing data it diagnoses every 2 seconds; the
Trash lookup inside is cached for 5 seconds per project. Measured with an
ad-hoc Node loop (`fs.promises.stat(…, { bigint: true })`, 200 warm-up calls,
then the mean of 2,000) on the same machine, commit `9ee2c4ae0`:

| Metric | Before | After | Budget |
|---|---|---|---|
| Open-project data watch, per open project per 5 s tick | — | 10 μs | 100 μs |

## iOS app: Lanes and PRs (simulator)

The iOS app is measured on its own columns: a simulator on the Mac Studio
(Mac16,9, M4 Max, 36 GB, macOS 27.0), iPhone 17 Pro on iOS 26.3, Debug
build, paired to that Mac's brain with the ADE repository open (8 lanes,
7 open / 1,247 merged / 186 closed PRs). Measured 2026-10-13 against main
`3137fc9b9`, other agents and builds running on the Mac.

How: launch with field diagnostics on
(`xcrun simctl spawn <udid> defaults write com.ade.ios adeScrollDiagnostics -bool YES`),
open the project, then run
`apps/ios/Scripts/bench-lanes-prs.sh <udid> "<lane name>" <pr number>`. It
drives a fixed ~70 s path (Lanes tab, scroll, open two lanes, PRs tab,
scroll, Merged, open a PR, its Checks and Files tabs, back) and summarizes
`Documents/scroll-diagnostics.jsonl` per step: host commands, main-thread
stalls (frames of 100 ms or more), scroll hitches, body evaluations and ready
times. "Before" is one run; "after" is the mean of two. Host latency
(GitHub through the brain) swings run to run, so ready times that wait on a
host call are context, not ceilings.

| Scenario / metric | Before | After | Ceiling |
| --- | ---: | ---: | ---: |
| Relaunch to Lanes/PRs rows (cached project) | never (stuck on skeletons) | ~1 s | 3 s |
| Main-thread stalls ≥100 ms, whole path (count) | 41 | 33 | 40 |
| Main-thread stall time, whole path (ms) | 6,432 | 5,290 | 6,600 |
| Lanes root body evaluations, whole path | 191 | 39 | 60 |
| PR list body evaluations, whole path | 106 | 30 | 45 |
| Network-discovery main-thread time per browse (ms) | 63–74 (×2 per ~30 s) | <50 (not logged) | 50 |
| Lane detail: cached content after open (ms) | 92 / 318 | 94 / 53 | 150 |
| Lane detail: fresh host detail after open (ms) | 466 / 299 | 459–574 | — (host) |
| PR detail: snapshot ready (ms) | 1,616 | 2,395–2,532 | — (host: `prs.getMobileGithubDetail` 1.3–2.2 s) |
| Host commands, whole path | 28 | 31–34 | 40 |

- Relaunch: the cached project id and the machine's id for the same checkout
  flipped back and forth during the first hydration; each flip cancelled the
  refreshes in flight and left every domain on "syncing initial data".
- Body evaluations: Lanes and PRs now take a narrowed `Equatable` input
  struct (the Work tab's pattern), so a hidden tab no longer re-renders on
  every sync publish.
- Discovery: Bonjour alternately resolving the Mac with and without its IPv6
  addresses re-saved the paired profile on every browse (46 ms) and
  republished it to every screen.
- Host commands rose by a few `prs.getGitHubSnapshot` reads that follow the
  host's own revision bumps; switching to Merged still reads it three times,
  which is the next thing to trim.

### Spotify (playing inside ADE)

Measured 2026-10-14 on this Mac Studio, dev build in an App Control session,
signed in with Premium, DevTools closed, other agents running. Spotify's Web
Playback SDK runs in the same macOS host as Apple Music (`page-spotify`, its own
WebKit profile). Apple Music's rows above are the comparison; Spotify has no
before. "Play accepted" is from the command to the first playing state, which
Spotify's service sets when Spotify accepts the play, not when audio starts.

| Metric | How | Apple Music | Spotify | Ceiling |
|---|---|---:|---:|---:|
| Player host and its WebKit processes, playing: CPU | `music-host.sh 10`, 4 runs | 0.5-0.8% | 0.6-1.1% | 3% |
| Same, playing: physical footprint | same | 75-81 MB | 77-82 MB | 120 MB |
| Same, paused: CPU / footprint | same, 3 runs | 0.0-0.2% / 73-75 MB | 0.1-0.2% / 75 MB | 1% / 120 MB |
| Music state pushes to each window, steady playback | `music.mjs pushes 12` | 0/s | 0/s | 0.2/s |
| Tab opened, then play 2.5 s later (the player starts with the tab) | `cdp.mjs eval`: `unload`, `warm`, wait, `playItems`, 5 runs | — | 0.15-0.35 s (was 1.2-1.5 s before the player started with the tab) | 0.6 s |
| Play accepted, player not running (play the instant it starts) | `music.mjs first-play cold`, 4 runs | 0.76-1.15 s | 1.19-1.61 s | 2 s |
| Same, player running | `music.mjs first-play warm`, 3 runs | 0.16-0.39 s | 0.16-0.17 s | 0.6 s |
| Tab closed: player processes / audio output | `pgrep`, `pmset -g assertions` | 0 / none | 0 / none | 0 / none |

- `music.mjs first-play` plays five songs of a search for Spotify (it has no
  charts).
- A cold start is about 0.25 s to launch the host, 0.2 s to load the SDK,
  0.2 s until the SDK asks for a token, then 0.4-0.8 s for Spotify to register
  the device over the network. None of it can be skipped, so the player starts
  when the tab opens (like Apple Music's host) and stops after five minutes
  without playing.
- While ADE's own player plays, the Web API is read once a minute instead of
  every 15 s: the SDK reports track, pause and position changes itself.
- The service's request budget (`spotifyService.test.ts`, fake time): a closed
  tab makes 0 requests; a device other than ADE playing 200-second songs makes
  at most 46 reads and 6 pushes per ten minutes.
- Windows (WebView2, Widevine) is measured separately; see the Windows numbers
  in the PR.

### Focus attention inference (2026-10-15)

Service measurement on the baseline MacBook Pro, Node 22.23.2: four representative
reply endings, 20,000 classifications per round, six interleaved warm rounds.
Baseline source: `c01b80fd2`; candidate: the Focus lifecycle fix. This measures
local classification only, excluding the optional model request.

| Metric | Before | After | Ceiling |
|---|---|---|---|
| Reply-ending classification, median per call | 0.00131 ms | 0.00136 ms | Existing 25% regression rule |

Warm service polling was measured separately with the same baseline and
candidate (`1d3b6389e`, plus query type annotations): 1,000 already-handled PRs,
no pending origins, an in-memory native SQLite database, 100 polls per round,
eight interleaved rounds with the first two discarded.

| Metric | Before | After | Ceiling |
|---|---|---|---|
| Handled PR snapshot, median per poll | 1.31 ms | 1.40 ms | Existing 25% regression rule |

The polling increase is about 7%, within the budget. The classification
difference is within measurement noise. The reported optional offer is
now decided locally, so that case does not make a model request. These service
numbers do not establish Electron idle, GPU, typing, or memory performance;
those desktop scenarios were not measured for this change.
