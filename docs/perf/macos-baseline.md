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
| Settings, nothing animating: frames drawn | — | 0/s | 0/s |
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

### Chat and typing

| Metric | How | Before #1560 | Baseline | Ceiling |
|---|---|---|---|---|
| Switching to a chat: time until settled | `chat-switch.mjs` | 247 ms | 56–172 ms | 250 ms |
| Switching to a chat: longest task | `chat-switch.mjs` | — | 77–100 ms | 120 ms |
| Renderer work per keystroke (dev) | `keystroke-trace.mjs` | — | ~4.5 ms (style 2.3, script 1.6) | 8 ms |
| Keystrokes slower than 16 ms (dev) | `typing.mjs` | — | 8 of 80 events | 16 of 80 |
| Renderer busy per keystroke (production build, headless) | `scripts/perf-chat-stream.mjs` harness | 12–15 ms | 12–15 ms | 16 ms |
| Streaming: cost per event (production build) | `scripts/perf-chat-stream.mjs` | 8.1 ms | 7.7 ms | 10 ms |

### Brain and services

Run without the app (`scripts/perf/service/`).

| Metric | Bench | Before #1560 | Baseline | Ceiling |
|---|---|---|---|---|
| Files quick-open index build (this repo) | `file-index.bench.mts` | 17.5 s, ~540 git processes | 120–183 ms, 1 git process | 500 ms |
| Quick-open lookup | `file-index.bench.mts` | — | 2–13 ms | 50 ms |
| Project registry: one read per project (35) | `registry-read.bench.mts` | 360 ms | 0.3 ms | 5 ms |
| Machine roster, warm (11 projects, 23 chats) | `roster.bench.mts` | 43 ms | 2.5–4.2 ms | 10 ms |
| Machine roster, cold | `roster.bench.mts` | — | 70 ms | 150 ms |
| Reading a 10 MB request, Content-Length framed | `rpc-read.bench.mts` | 240 ms | 10.8 ms | 30 ms |
| Reading a 10 MB request, JSONL | `rpc-read.bench.mts` | 99 ms | 8.7 ms | 30 ms |
| CLI PATH lookup once its cache has expired | `shell-path.bench.mts` | 1,265 ms | 2–11 ms | 20 ms |

### Open items (measured, over budget or unbudgeted)

- **Files tab switch:** 0–295 ms. The profile shows the kept-alive Work tab
  re-rendering (TerminalsPage, the chat composer) and the chat list's
  virtualizer forcing layout (`getBoundingClientRect`) when you switch to
  Files.
- **First Work open after launch:** a long chat backfills its older history
  in idle slots: 114–171 pages over 8–14 s, at about 350 ms/s of main-thread
  work, once per chat per session.
- **GitHub calls:** `pr.getChecks` and `pr.getStatus` take 1–1.5 s each
  (network) and dominate the Lanes and PRs IPC totals.
- **Prewarmed Claude processes:** 150–420 MB each until they are reaped
  after 5 minutes.
- **Typing:** each keystroke still re-renders the whole chat pane (about 150
  component renders and 3 ms of script per key in the dev build). The pane's
  header, composer and closed dialogs render with it; the same chrome renders
  once per streamed event.
- **A chat at its resident cap** (60,000 events or 32 MB) drops one event from
  the front on every flush. Each flush is then a new list, and the live merge
  and the row builder fall back to full passes. Not reached by any local chat
  (the largest is at about half the byte cap); trim in steps to fix it.
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
`//localhost:` page. Set `CDP_TARGET_URL=localhost:<port>` to the port on
the log's `dev launcher using` line when more than one window is open.

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

UI, against a running dev app (`scripts/perf/ui/`):

| Script | Measures |
|---|---|
| `route-sweep.mjs <runId> <route>,... [idleSecs]` | Per tab: long tasks after switching, IPC calls and time (perf run only), then idle task time, style recalcs, heap, page elements and running animations |
| `process-cpu.sh <secs> <runtime-socket>` | CPU % and RSS for the main, GPU, renderer and brain processes |
| `gpu-trace.mjs <secs>` | Frames drawn, GPU swap time and rendering phases, for the whole browser |
| `render-count.mjs <secs> reload` | React commits and which components re-render, and why (changed props or hooks) |
| `chat-switch.mjs [rounds]` | Clicks through the chat list; time until each transcript settles, and long tasks |
| `interaction.mjs tabs\|chats\|projects [rounds]` | Per tab, chat or project switch: time to the first frame that shows a change, time until the page stops changing, and long frames in between. Finer than long tasks, which miss every frame under 50 ms |
| `typing.mjs <keys>` | Types into the composer; keystroke events slower than 16 ms |
| `keystroke-trace.mjs <keys>` | Renderer work per keystroke, split into style, layout, paint and script |
| `cdp.mjs eval\|metrics\|profile\|shot\|anim` | One-off probes: evaluate, metrics delta, CPU profile with top functions, screenshot, running animations |

Brain and services, no app needed (`scripts/perf/service/`, run from
`apps/ade-cli` with `npx tsx ../../scripts/perf/service/<name>.bench.mts`):
`file-index`, `registry-read`, `roster`, `rpc-read`, `shell-path`,
`chat-transcript`, `tree-watcher` (plus `tree-watcher-parity.mts`, a
comparison and not a timing). They read temp copies of state and never write
to `~/.ade`.
`chat-transcript` is the chat renderer's own pipeline (live merge, display
filter, row builder) run on real transcripts: one full pass as a chat opens,
then 500 events one at a time as a turn streams.

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
| Open a long chat to its first rows (fresh Chrome profile) | `npm run bench:webclient` | 287 ms | 285 ms | 360 ms |
| Composer keystroke to paint, idle, p50 (headless, 60 Hz) | same | 28.0 ms | 28.5 ms | 35 ms |

The row and merge numbers are a production-style Node run; the streaming
numbers are the dev build, where React's own work is two to three times what a
packaged build pays.

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
