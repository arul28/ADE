# Performance baseline (Windows, measured)

The Windows counterpart of `docs/perf/macos-baseline.md`: the same rows,
measured on one Windows PC, plus rows that only matter on Windows (cold start
and process spawns). Compare a Windows change against this file, not against
the macOS columns (see **Performance budget** in `AGENTS.md` and `CLAUDE.md`).

## Machine and conditions

| | |
|---|---|
| Machine | MSI MS-7D70, AMD Ryzen 9 7950X3D (16 cores, 32 threads), 63 GB, NVIDIA RTX 4090 (plus the CPU's Radeon iGPU) |
| Display | 5120x1440 at 239 Hz, Windows scaling 110% (`devicePixelRatio` 1.1); the dev window was 1327x800 CSS px |
| OS | Windows 11 Pro, `ver` = 10.0.26200.9457 |
| Node | 22.13.1 (via fnm; the default `node` on this PC is 24 and is not used) |
| Build | dev build, `npm run dev:desktop` with its own runtime pipe `\\.\pipe\ade-runtime-perfwin`, sync OFF (isolation report: `sync : off (--no-sync)`) |
| Project | the ADE repository (primary checkout), one project tab open, 2 chats in the Work list, 6 projects registered, a background image scene as the app backdrop |
| Background | the installed ADE (its brain, three renderers and agent chats, including the chat that ran these measurements) and the Versic runtime. No chat was streaming in the dev app during the idle rows, and the PR had no running checks |
| Measured | 2026-10-13, branch `ade/friend-feedback-bug-triage` at `3137fc9b9` (no product changes) |

Every row was measured twice; both runs are in the Baseline column as
`run 1 / run 2`. Treat a difference under about 20% as noise.

**How the ceilings were set.** Where the Windows baseline is under the macOS
ceiling, the ceiling is the macOS one. Where Windows is already over it, the
ceiling is the Windows baseline plus about 10%, and the row is listed under
**Open items (over the macOS ceiling)**: those are the Windows optimization
targets. Rows with no macOS counterpart get a ceiling of about 25% over the
baseline and are marked *new*.

Process memory on Windows is the working set (the closest thing to macOS RSS);
private bytes are given next to it. The two are not the same measure, so a part
of each memory gap is the measure and not ADE.

## The table

### Moving between tabs (renderer)

`route-sweep.mjs`, second and third passes (the first pass compiles the tabs'
modules). IPC rows are a separate launch with `ADE_PERF_RUN_ID` set.

| Metric | Baseline (run 1 / run 2) | Ceiling |
|---|---|---|
| Longest freeze after switching tabs (sum of long tasks, 4 s) | 0 ms on every tab except CTO 51 / 0 ms; in the perf-run launch Lanes 76 / 96 ms and CTO 67 / 56 ms | 100 ms |
| Lanes: page elements | 2,085 / 2,085 | 5k |
| Other tabs: page elements | 833-1,318 / 833-1,318 (Work 833, CTO 1,318) | 3k |
| Lanes: IPC on open (perf run) | 39 calls, 4,991 ms / 39 calls, 6,982 ms | 70 calls; no call repeated once per row |
| Branch-diff reads per lane open (`diff.getBranchChanges`) | 2 / 2 (1 on the first visit), 1.2-1.8 s each. **After** (Windows pass 1): 1 on a revisit, counted in the pane's component test harness; not re-measured in the app | 1 |
| Commit-message reads per lane open | 0 / 0 | one per commit without a trailer |
| Files: `file.listTree` on open (perf run) | 1,965 / 2,199 ms. **After** (Windows pass 1): not re-measured in the app; the same listing took 4-5 ms alone, 3,452-3,745 ms while chokidar opened the tree watcher on the same event loop, and 20-22 ms while the new watcher opened (see the tree watcher rows) | *new* 2,500 ms |
| PRs: IPC on open (perf run) | 24 calls, 8,679 ms / 25 calls, 9,294 ms (`pr.getActionRunsByGithub` 2.8-3.0 s) | *new* 40 calls |
| Renderer JS heap, any tab | 116-124 / 116-127 MB; 125 MB after a forced GC | 220 MB |

### Idle (renderer, nothing typed)

`route-sweep.mjs` (idle phase, 10 s per tab), `gpu-trace.mjs` (8 s) and
`render-count.mjs` (15 s on Work), perf runs off.

| Metric | Baseline (run 1 / run 2) | Ceiling |
|---|---|---|
| Static tabs (Work, Lanes, Files, PRs, Automations, History, CTO, Settings): main-thread work | 0.6-4.7 / 0.6-2.2 ms/s | 30 ms/s |
| Work with a chat streaming: main-thread work | not measured (no chat was streaming) | 60 ms/s |
| Settings, nothing animating: frames drawn | 0/s / 0/s | 0/s |
| PRs: frames drawn (no running checks, so no spinners) | 0/s / 0/s | 40/s with running checks |
| Work, idle: frames drawn | 0/s / 0/s | 5/s |
| Chat list cards: re-renders | 0 / 0 | 0 |
| Top bar: re-renders | 2 / 2 per 15 s | 5 per 15 s |
| Work area: re-renders | 0 / 0 per 15 s | 5 per 12 s |
| React commits on Work, idle | 0.5/s / 0.7/s | 10/s (the macOS row is while streaming) |

### Processes (CPU and memory)

`process-cpu.mjs` over 15 s on Work, idle, nothing streaming, perf runs off,
after a renderer reload and one visit to every tab.

| Process | Baseline CPU (run 1 / run 2) | Baseline working set (private) | Ceiling |
|---|---|---|---|
| Electron main | 0.6% / 0.7% | 216 / 217 MB (187 MB) | 15%, **240 MB** (macOS: 200 MB; open item) |
| GPU | 0.0% / 0.1% | 192 / 192 MB (217 MB) | 10%, **215 MB** (macOS: 150 MB; open item) |
| Renderer | 0.0% / 0.2% | 550 / 551 MB (480 MB) | 25%, **610 MB** (macOS: 300 MB; open item) |
| Brain (`cli.cjs serve`) | 0.9% / 0.3% | 341 / 341 MB (349 MB) | 10%, **380 MB** (macOS: 250 MB; open item) |
| Network utility | 0.0% / 0.0% | 61 / 61 MB | *new* 80 MB |
| Service-health probe tree (`runtime service-status --json` and its children: 14 processes per probe, about 5 PowerShells and a nested CLI) | **Before**, installed app 1.2.111, job object over 5 runs: 3.2-3.7 s CPU and 3.7-4.4 s wall per probe, one probe every 15 s while connected, so about 13.6 s CPU and 56 process launches per minute. **After** (installed app, integrated build 1.2.113 with #1799, 2026-10-19): 1 probe in 300 s idle while connected (was 20) | not sampled | *new*: not set yet; needs your OK |

Right after launch (before any tab was visited) the renderer was 454 MB and
the brain 239 MB. The CPU numbers are far lower than the macOS row because
no chat was streaming here (macOS had two), so compare them with care.

### Chat and typing

| Metric | How | Baseline (run 1 / run 2) | Ceiling |
|---|---|---|---|
| Switching to a chat: time until settled | `chat-switch.mjs 2` | 32-39 / 22-48 ms | 250 ms |
| Switching to a chat: longest task (warm rounds) | `chat-switch.mjs 2` | 55-74 / 55-74 ms (first switch after a reload: 267 ms) | 120 ms |
| Renderer work per keystroke (dev) | `keystroke-trace.mjs 40` | 4.6 / 4.9 ms (script 3.6 / 3.8, style 0.09, layout 0.25, paint and compositing about 0.9) | 8 ms |
| Keystrokes slower than 16 ms (dev) | `typing.mjs 80` | 6 / 12 of 80 | 16 of 80 |
| Streaming: script per event (12,537-event chat, 400 events at 30/s; dev Vite server, browser mock, headless Chrome 155) | `scripts/perf-chat-stream.mjs` | 3.08 / 3.10 ms | 7.5 ms (the macOS dev row) |
| Streaming: main-thread task time per event | same | 5.27 / 5.29 ms | 10 ms |
| Streaming: renderer CPU | same | 20.6% / 20.8% | 38% |
| Streaming: frame p99, longest frame | same | 4.3 / 4.3 ms, 29.1 / 16.6 ms | *new* 8 ms p99 |
| Open a long chat to its first rows | same | 1,278 ms (first load of the dev page) / 45 ms | 360 ms (warm) |

### Switches (from the click and from the press)

Rows from the macOS file's Mac Studio sections, measured the same way.

| Metric | How | Baseline (run 1 / run 2) | Ceiling |
|---|---|---|---|
| Tab switch: first changed frame, warm (median; range) | `interaction.mjs tabs 4` | 35 / 44 ms (12-63; CTO 93 once) | 60 ms |
| Tab switch: page settled, warm (median; worst) | `interaction.mjs tabs 4` | 87 / 79 ms; worst 357 / 381 ms (Automations, CTO) | **420 ms** worst (macOS: 250 ms; open item) |
| Tab switch: long frames, warm | `interaction.mjs tabs 4` | 0 except CTO 68 / 76 ms | 100 ms |
| Chat switch: first changed frame, warm (median) | `interaction.mjs chats 4` | 88 / 88 ms (69-88) | **97 ms** (macOS: 60 ms; open item) |
| Chat switch: press to content (median) | `press-to-paint.mjs chats 4` | 70 / 70 ms (57-70) | **77 ms** (macOS: 70 ms; open item, at the line) |
| Page tab switch: press to content (median; range) | `press-to-paint.mjs tabs 4` | 39 / 35 ms (10-54) | 50 ms |
| Page tab switch: press to the first frame | `press-to-paint.mjs tabs 4` | 10 / 10 ms | 16 ms |
| Chat open, cold: press to content | `press-to-paint.mjs chats 4` (round 1) | 56-69 / 63-66 ms | 350 ms |
| Renderer JS heap after GC, after a tab sweep | `cdp.mjs gc` | 125 MB | 220 MB |

### Cold start (new, Windows)

`cold-start.mjs`, from the launch command to each milestone, Defender on. The
dev launcher rebuilds the runtime CLI whenever no brain is running on the
pipe, so every launch pays it.

| Metric | Baseline (run 1 / run 2 / perf-run launch) | Ceiling |
|---|---|---|
| Runtime CLI build (tsup) | 6.1 / 6.3 / 6.2 s | *new* 8 s |
| Runtime ready (brain on its pipe; isolation report printed) | 7.1 / 7.3 / 7.3 s | *new* 9 s |
| Electron started | 7.9 / 7.8 / 7.8 s | *new* 10 s |
| First window shown (CDP page target) | 16.8 / 11.7 / 11.6 s | *new* 15 s |
| App mounted (more than 300 elements) | 54.6 / 23.4 / 21.7 s | *new* 30 s |
| Settled (element count unchanged for 2 s) | 55.0 / 24.9 / 23.3 s | *new* 31 s |

Run 1 followed two failed launches and had a cold Vite dependency cache (`VITE
ready in 3847 ms`; 207 ms in run 2), so the warm numbers are run 2 and the
perf-run launch. The 10-12 s from the first window to a mounted app is the
dev renderer loading its module graph from Vite; a packaged build does not
pay it.

### Brain and services

Run without the app (`scripts/perf/service/`).

| Metric | Bench | Baseline (run 1 / run 2) | Ceiling |
|---|---|---|---|
| Files quick-open index build (this worktree) | `file-index.bench.mts` | 195 / 195 ms | 500 ms |
| Quick-open lookup | `file-index.bench.mts` | 1.3-8.2 / 1.3-8.4 ms | 50 ms |
| Project registry: one read per project (6) | `registry-read.bench.mts` | 0.1 / 0.1 ms | 5 ms |
| Project icon detection, cold: one fresh-process resolve for each registered project (ADE 45 ms, Versic 38 ms; the other four 1-10 ms). Before (origin/main `c4ad80e1d`): 1,378 / 1,320 / 1,311 ms, median 1,320; ADE 593, Versic 635 | one-off `tsx` loop over `~/.ade/projects.json`, `resolveProjectIconPath` once per root (no bench file yet); median of 3 runs, interleaved with origin/main | 89 / 88 / 87 ms, median 88 | *new* 110 ms |
| Project icon detection, warm: the same six roots again in that process. Before: 83.7 / 85.0 / 82.8 ms. A "no icon" result is not cached by design, so the four projects without an icon scan again | same | 3.7 / 3.8 / 3.6 ms, median 3.7 | *new* 5 ms |
| Machine roster, warm (4 projects, 7 chats) | `roster.bench.mts` | 2.2-3.0 / 2.0-2.8 ms | 10 ms |
| Machine roster, cold | `roster.bench.mts` | 59 / 51 ms | 150 ms |
| Reading a 10 MB request, Content-Length framed | `rpc-read.bench.mts` | 6.9 / 7.0 ms | 30 ms |
| Reading a 10 MB request, JSONL | `rpc-read.bench.mts` | 6.8 / 6.8 ms | 30 ms |
| CLI PATH lookup once its cache has expired | `shell-path.bench.mts` | 0 / 0 ms; not meaningful on Windows (no login-shell probe; the function returns `PATH` plus known CLI dirs) | 20 ms |
| Transcript rows: full pass as a chat opens (five largest, 3,179-16,033 events; mean) | `chat-transcript.bench.mts` | 31.8 / 32.4 ms (4.4-64.3; 62-64 ms for the 12,937-event chat) | **36 ms** (macOS: 18 ms; open item) |
| Transcript rows: cost per streamed event | `chat-transcript.bench.mts` | 0.059 / 0.068 ms | 0.3 ms |
| Live merge: cost per streamed event | `chat-transcript.bench.mts` | 0.064 / 0.051 ms | 0.15 ms |
| Streamed events over one 240 Hz frame (4 ms), of 2,500 | `chat-transcript.bench.mts` | 2 / 4 (worst 24.8 ms) | 15 |
| Tree watcher: time until ready, repository root | `tree-watcher.bench.mts <root>` | 93 / 92 ms (before Windows pass 1: 2,488 / 2,487; 3,376 / 2,786 on the day of the change) | 250 ms |
| Tree watcher: longest event-loop block on open and close | same | 12 / 11 ms (before: 179 / 181; 220 / 210 on the day) | 20 ms |
| Tree watcher: CPU until ready (includes the bench's 1.5 s after close) | same | 407 / 313 ms (before: 3,344 / 3,234; 4,187 / 3,563 on the day) | *new* 500 ms |
| Tree watcher: CPU at idle over 5 s | same | 0 / 93 ms (other agents were writing in the tree) | 150 ms |
| Tree watcher: memory held by one open watcher of the repository | a focused script (`process.memoryUsage()` around ready, after GC) | 2 / 2 MB heap, 20 / 23 MB RSS (chokidar's native mode: 20 MB heap, 86 MB RSS) | *new* 30 MB RSS |
| `sessions.list` handler, same 617-file fixture as the macOS row. Unscoped (`limit 500`) / lane (`limit 200`) / chat-scoped (3 rows). Median of 7 runs in each of 3 interleaved processes. Main `46b92f0b8` → round 1 `57f8b5e53` (state-file cache) → `f049cc176` (+ per-call hoists). Medians: unscoped 386 → 339 → 200 ms; lane 158 → 135 → 79 ms; chat 39 → 38 → 39 ms (not affected). Chat metadata reads per call: unscoped 352 → 0 → 0; lane 138 → 0 → 0. Config reads per call: unscoped 703 → 702 → 2; lane 274 → 274 → 2. Returned rows byte-identical across all three (parity dump, 12 shapes) | `session-list.bench.mts` | *new*, proposed, needs approval: unscoped 250 ms, lane 120 ms, chat 25 ms (chat is 39 ms here and unchanged by this work; see the macOS row) |

Since Windows pass 1 (`ade/friend-feedback-bug-triage`, after `3137fc9b9`)
`watchTree` on Windows is the single recursive native watch macOS uses
(ReadDirectoryChangesW), not chokidar's native mode (one `fs.watch` per
directory, plus a stat of every path before ready). `tree-watcher-parity.mts`
runs on Windows too (junctions stand in for the links) and found no difference
from the poller in 228 steps (four seeds). The root was the primary checkout
(`C:\Users\arul2\Documents\Programming\ADE`): a lane worktree path contains
`.ade`, which the bench ignores, so it would watch nothing.

### Brain: local chat send (new, Windows)

| Metric | How | Baseline (run 1 / run 2) | Ceiling |
|---|---|---|---|
| Local new chat: Send → first Work row (the renderer's wait for the brain's `chat.createSession`, then `chat.sendMessage`, on this machine's brain). Before this change, installed app: 207–387 ms, median ~246 ms. After: see the next column | in-app, installed app, Send to the first row, several new chats | before: 207–387 ms (median ~246 ms); after (installed 1.2.114 = `main` 7a3615de5, 8 new chats 10 s apart): 69–211 ms, median ~158 ms | *new* 150 ms (the Mac Studio's brain takes ~113-128 ms for the same flow); open item: the median is 5% over, inside the macOS 120-175 ms range for the same action |

The send path asks whether `agent-browser` is installed on every turn. The
probe is a `where` process. Before this change it ran on the brain's event
loop, about 40 ms, on the first ask and again each time the 60 s cache expired.
Now the probe runs in the background, started when the brain creates its
computer-use broker, and a send reads the cached answer without waiting.

### Process spawns (new, Windows)

`spawn.bench.mts`, run from `apps/ade-cli`. `PATH` had 105 entries.

| Metric | Baseline (run 1 / run 2) | Ceiling |
|---|---|---|
| `git --version` (bare process start), median of 10 | 23.9 / 23.0 ms (max 50 / 27) | *new* 30 ms |
| `git status --porcelain` in this worktree, median of 10 | 42.2 / 43.0 ms (max 65 / 67) | *new* 55 ms |
| `node -e 0`, median of 5 | 43.9 / 42.4 ms | *new* 55 ms |
| A `.cmd` shim through `cmd.exe` (`npx --version` via `resolveCliSpawnInvocation`), median of 5 | 274 / 242 ms | *new* 340 ms |
| Resolving 14 CLIs (`resolveExecutableFromKnownLocations`), listing cache dropped | 12.6 / 12.4 ms | *new* 16 ms |
| The same, warm | 4.6 / 4.8 ms | *new* 6 ms |
| OpenCode orphan recovery: longest main-thread block during the Windows process listing (`wmic`, then PowerShell `Get-CimInstance`; 478 processes). One-off script, no bench file yet: 5 interleaved warm runs of `listProcesses` (before, origin/main `56709aebc`) and `listProcessesAsync` (after) | after: median 20.5 ms, worst 24.7 ms, 43 event-loop ticks per call. Before: median 728 ms, worst 3,452 ms, 0 ticks. Wall time 727 → 672 ms median | *new* 30 ms |

`copilot`, `agent`, `cursor-agent`, `gemini` and `bun` are not installed on
this PC, so their lookups are misses (a miss walks every `PATH` entry).
The `npx` row includes npm's own start. The `cmd.exe` wrapper alone
(`cmd.exe /d /s /c exit 0`, median of 10) is 20.9 ms, about a bare `git`
start, so the shim's 250 ms is npm starting node, not `cmd.exe`.

Windows pass 1 removed process starts from the lane-open path rather than
making a start cheaper: `diff.getChanges` runs `git status` and both
`--numstat` diffs at once (one start of wall time instead of two), and the
branch diff finds its base with one `git merge-base` (no `rev-parse
--verify` first) while its index lookup runs alongside. On this worktree, with
a focused script (median of 7 and 5, old code against new in one process):
`getChanges` 244 / 267 ms before, 217 / 220 ms after; `getBranchChanges`
1,151 / 1,202 ms before, 1,146 / 1,103 ms after. The branch diff's time is
git's own work (`git diff --cached --numstat --find-renames` alone was
about 600 ms here), not process starts.

### Hosted web client

`npm run bench:webclient -- --skip-chat` in `apps/desktop` (production build,
headless Chrome 155, local static server on 127.0.0.1, median of 3 runs).

| Metric | Baseline (run 1 / run 2) | Ceiling |
|---|---:|---:|
| Entry stylesheet (KB, raw) | 57.3 / 57.3 | 75 |
| Cold signed-out requests | 53 / 53 | 60 |
| Cold signed-out transfer (KB) | 815.7 / 815.7 | 900 |
| Cold signed-out JS (KB) | 598.1 / 598.1 | 650 |
| Cold signed-out CSS (KB) | 66.7 / 66.7 | 85 |
| Cold signed-out images (KB) | 79.1 / 79.1 | 100 |
| Cold signed-out heap (MB) | 2.5 / 2.5 | 3.0 |
| Cold signed-out long-task total (ms) | 0 / 0 | 10 |
| DOMContentLoaded (ms) | 269 / 267 | **295** (macOS: 28; open item) |
| First contentful paint (ms) | 312 / 304 | **345** (macOS: 60; open item) |
| React mounted (ms) | 286 / 274 | **315** (macOS: 48; open item) |
| Sign-in card visible (ms) | 375 / 376 | **415** (macOS: 100; open item) |

The byte and request rows match macOS to within the growth of the bundle; the
timing rows are 5 to 10 times slower (see the open items).

## Open items (over the macOS ceiling)

These are where Windows is already past the macOS line, with what the
measurements point at. Each is a Windows optimization target.

- **Process memory (all four processes).** Renderer 550 MB against 300,
  brain 341 MB against 250, GPU 192 MB against 150, main 216 MB against 200.
  The renderer's JS heap is only 125 MB after GC, so most of the renderer's
  working set is outside the JS heap: the dev build's unbundled modules and
  source maps, decoded images (the backdrop scene) and Chromium's own
  allocations. The brain is a dev brain that sees every project in `~/.ade`.
  Part of every gap is the measure (working set against macOS RSS). The first
  step is a packaged-build reading and a heap snapshot of the brain. One part
  of the brain's number is known: an open chokidar tree watcher of this
  repository held 20 MB of heap and 86 MB of RSS (a focused script), and the
  brain measured above had visited Files; the watcher Windows pass 1 moved to
  holds 2 MB and 20-23 MB. The brain was not re-measured (no heap snapshot,
  and the dev app was in use).
- **Branch-diff reads per lane open: 2.** *Fixed in Windows pass 1, not yet
  re-measured in the app.* The cause was not Windows: on a revisit the pane
  starts from its cached changes, so its branch-diff effect read on mount and
  read again a moment later when the pane's load bumped `branchReadNonce`
  (the two reads in the perf run started 14 ms apart). A first visit has no
  cache and read once, which is why the first visit showed 1. The effect now
  waits for the load's bump. The `listRecentCommits` (x2) and
  `getSyncStatus` (x2) pairs are two consumers (the lane overview and the
  Git pane), not a repeat.
- **Chat switch: first changed frame 88 ms** (macOS: 38-58 ms, ceiling 60) and
  **press to content 70 ms** (ceiling 70). The task is one synchronous React
  mount of the new chat's rows (one long frame of 59-78 ms in every switch), so
  the macOS open item about the pane rendering about 11 times per switch
  applies here, with slower script (the keystroke trace shows 3.6 ms of script
  per key against 1.6 ms on macOS for the same work). With the beta dialog's
  blurred scrim open, the same switch took 139-179 ms: a backdrop blur over the
  whole window makes every frame under it expensive.
- **Tab switch: page settled, worst 357-381 ms** (macOS ceiling 250).
  Automations settles about 180 ms after its first frame on every visit and
  CTO 190-381 ms; both have a late second render (data arriving after the
  first paint, CTO with a 51-76 ms long task). The first frame is fast (12-44
  ms), so this is late content, not a blocked switch.
- **Transcript full pass as a chat opens: 32 ms** (macOS: 12 ms, ceiling 18),
  in the Node bench, so no rendering is involved. The 12,937-event chat costs
  62-64 ms. Different transcripts than the macOS run, so profile the pass
  (run the bench under `node --cpu-prof`) before calling it a Windows
  regression.
- **Tree watcher: ready in 2.5 s with a 180 ms event-loop block.** *Fixed in
  Windows pass 1:* 92-93 ms and 11-12 ms with the recursive native watch, as on
  macOS. Two Windows-only parts came with it: a full re-read of the tree when
  Windows drops events (a burst that overflows the watch buffer arrives as one
  event with no name; without the re-read, 3,999 of 4,000 changed files went
  unreported in a focused script), and a watch on the root's parent, because a
  Windows watch follows a moved directory and cannot see the root deleted or
  created again. Moving a watched root now works; under chokidar it failed with
  `EPERM`.
- **Hosted web client cold load: 5 to 10 times slower than macOS** (DCL 268 ms,
  FCP 308 ms, sign-in card 375 ms) with the same bytes and no long tasks. The
  page does no main-thread work worth naming, so the time is in loading:
  candidates are headless Chrome's start on Windows, the bench's static server
  reading each file from disk under Defender, and the first-paint path (GPU
  process start). Not profiled.

Not over a macOS ceiling but worth watching:

- **Files tab: `file.listTree` takes 2.0-2.2 s** on every open (perf run).
  The listing itself takes 4-5 ms; it waited behind chokidar opening the Files
  tab's tree watcher on the same event loop (3.5-3.7 s in a focused script,
  20-22 ms with the new watcher). Re-measure in the app.
- **Cold start: 10-12 s from the first window to a mounted app** in the dev
  build, and the dev launcher rebuilds the runtime CLI (6 s) on every launch
  with no brain running.
- **A `.cmd` shim costs about 250 ms to start** (`npx` through `cmd.exe`),
  ten times a native process.

## Not measured on Windows

- **Project switch** (`interaction.mjs projects`, `press-to-paint.mjs
  projects`): one project tab was open, and opening a second changes the
  user's recent-project order.
- **Rapid chat clicks** (`press-to-paint.mjs rapid`): needs three chats; the
  Work list had two.
- **Anything while a chat streams in the app** (Work main-thread work and
  React commits while streaming, the process CPU rows with two chats
  streaming): no chat was streaming, and starting one sends a real prompt.
  `perf-chat-stream.mjs` covers the renderer side of streaming.
- **PRs with running checks** (frames and GPU swap with three spinners): the
  PR had no running checks. Idle PRs drew 0 frames/s.
- **Work, idle Claude chat with mod UI**: not set up on this PC.
- **Production-build rows** of `perf-chat-stream.mjs` (renderer busy per
  keystroke, cost per event against `vite preview`): the harness ran against
  the dev Vite server; this version has no typing mode.
- **Web client chat section and poll counts** (`bench:webclient` without
  `--skip-chat`): its first step, `export-browser-mock-ade-snapshot.mjs`,
  pages through every PR of the repository with `gh api graphql --paginate`
  and had not finished after 15 minutes. The current bench has no poll
  section.
- **Launch event-loop stall** (`renderer.event_loop_stall`): not in the dev
  log on Windows.
- **Brain file-watcher paths after the Files tab closes**
  (`process.getActiveResourcesInfo()` in the brain): needs the brain's
  inspector; not done.
- **The `process-cpu.mjs` CPU columns under load**: every CPU number here is
  idle, so they show the method works but not what streaming costs.

## After Windows pass 1 (same machine, same day)

Measured 2026-10-13 on `ade/550cab0c` (`3137fc9b9` plus the uncommitted
branch changes), with the scripts and conditions of the tables above. Two
runs each. The Work list held the same two chats; one of them is the chat
that did this work and grew during the day (1,133 to 1,244 elements), and
the first open PR was a different one with a spinner on screen (see the
open item below). Nothing got more than 25% worse or crossed a ceiling it
was under before.

| Row | Before (run 1 / run 2) | After (run 1 / run 2) | Ceiling |
|---|---|---|---|
| Tree watcher: time until ready | 3,376 / 2,786 ms | 93 / 92 ms | 250 ms |
| Tree watcher: longest event-loop block | 220 / 210 ms | 12 / 11 ms | 20 ms |
| Branch-diff reads per lane revisit | 2 / 2 | 1 (component harness; not re-counted in the app) | 1 |
| Cold start: runtime starting | 7.1 / 7.3 s | 6.8 / 6.4 s | see Cold start |
| Cold start: first window | 11.7 s | 12.5 / 11.9 s | see Cold start |
| Cold start: app mounted | 22-23 s | 23.0 / 21.3 s | see Cold start |
| Renderer working set, Work idle | 550 MB | 500 / 505 MB | 300 MB (open item) |
| Brain working set, Work idle | 341 MB | 295 / 287 MB | 250 MB (open item) |
| GPU working set | 192 MB | 167 / 165 MB | 150 MB (open item) |
| Main working set | 216 MB | 218 / 218 MB | 200 MB (open item) |
| Renderer JS heap after GC | 125 MB | 119 MB | 220 MB |
| Chat switch: settled, warm | 22-48 ms | 20-33 ms | 250 ms |
| Chat switch: longest task, warm | 55-74 ms | 0-57 ms | 120 ms |
| Chat switch: first changed frame, warm (median) | 88 ms | 71 ms | 60 ms (open item) |
| Press to content, chats (median) | 70 ms | 79 ms (the grown chat; the other chat 55 ms) | 70 ms (open item) |
| Renderer work per keystroke: layout / paint / layerize | 0.24-0.26 / 0.16-0.19 / 0.32-0.35 ms | 0.22 / 0.14 / 0.29 ms | 8 ms total |
| Static tabs: idle main-thread work | 0.6-2.2 ms/s | 1.1-4.1 ms/s (PRs left out: it had a spinner on screen, see the open item) | 30 ms/s |
| File index build / registry / roster warm / rpc 10 MB | 195 ms / 0.1 ms / 2.0-2.8 ms / 7.0 ms | 201 ms / 0.1 ms / 2.3-3.6 ms / 7.3 ms | 500 / 5 / 10 / 30 ms |
| Transcript full pass as a chat opens (five largest) | 32.4 ms | 35.1 ms | 18 ms (open item) |
| `git status` / `node -e 0` / `npx` through cmd.exe | 43 / 42 / 242 ms | 43 / 41 / 261 ms | see Process spawns |

### What Sentry costs (new rows)

Sentry is off in a dev build; these rows turn it on with `ADE_SENTRY_DEV=1`
or compare builds with and without the SDK.

| Row | Without | With | Ceiling |
|---|---|---|---|
| Cold start, dev app: first window / app mounted | 12.5, 11.9 s / 23.0, 21.3 s | 11.8 s / 21.3 s (one run) | no change expected; within noise |
| Idle on Work, 15 s: main / renderer / GPU CPU | 0.8% / 0.2% / 0% | 0.4-0.7% / 0-3.7% / 0.2-3.9% over three runs, 0% / 0-0.4% / 0-0.2% over four 8 s samples once the page was quiet | 15% / 25% / 10% (macOS) |
| Main working set | 219 MB | 218-219 MB | 200 MB (open item, unchanged) |
| Sentry start in the brain (`initBrainSentry`) | - | 51-55 ms, once per brain start | *new* 70 ms |
| `apps/desktop/dist/main/main.cjs` | 15.53 MB | 16.34 MB (+5%) | *new* 17 MB |
| `apps/ade-cli/dist/cli.cjs` | 17.10 MB | 18.43 MB (+8%, includes the branch's other code) | *new* 19 MB |
| `ade --version` (median of 9, three interleaved rounds) | 627-651 ms | 653-675 ms (+3-5%) | *new* 700 ms |
| Web client: JS needed for first paint | 320.9 KB | 321.2 KB | 950 KB cold JS (macOS) |
| Web client: cold signed-out JS, whole load | 598 KB | 693 KB (+16%; the Sentry chunk, 63 KB on disk, loads after first paint) | 950 KB |
| Web client: cold requests / transfer / heap | 53 / 816 KB / 2.5 MB | 56 / 911 KB / 2.7 MB | 60 / 2,000 KB / 3.5 MB |

The web client first shipped with Sentry's browser tracing as well: 761 KB of
cold JS, 27% over the baseline. It reports errors only now. Loading the
Sentry Node SDK lazily in the CLI was tried and made no measurable difference
to `ade --version` (the extra time is the larger bundle), so it loads
statically.

### New open item

- **A spinner on a 240 Hz display.** With one spinner on screen (the PRs
  tab) the renderer ran 240 style recalcs a second and 52 ms/s of main-thread
  work, while only 31 frames a second were drawn (the spinner is
  `steps(30)`). The stepped animation still ticks on the main thread at the
  display's rate. Not caused by this branch; the before run had no spinner on
  screen. High-refresh monitors are common on Windows PCs, so this is the
  next thing to fix: run the spin on the compositor, then re-measure with
  `gpu-trace.mjs` on the PRs tab.

## Installed app, round 4 (2026-10-19)

The tables above are a dev build. These rows are the **installed** app on the
same PC, measured the way a user runs it: the per-user background brain,
connected to the Mac Studio (paired, over Tailscale), two project tabs
(ADE, Versic), window 1327x829 CSS px, nothing streaming, a measurement hold
so no builds or tests ran meanwhile.

- **Before:** the installed release 1.2.111 at the start of round 4, plus a
  test build of the same day (1.2.112, earlier round-4 fixes only) where a row
  was first measured there.
- **After:** a local, unsigned build of `main` at `7a3615de5` (1.2.114), which
  has every round-4 PR (#1782, #1784-#1792, #1794-#1801). Some rows were
  measured on the integrated test build 1.2.113 (the same PRs before they
  merged); those say so.

| Row | How | Before | After | Ceiling |
|---|---|---|---|---|
| Cold start: first window (CDP page target) | `coldstart` script, 3 launches, brain already running | 1.76-2.30 s | 1.11-1.22 s | *new* 1.5 s, proposed, needs approval |
| Cold start: app mounted (>300 elements) | same | 2.58-4.06 s | 1.79-1.91 s | *new* 2.4 s, proposed, needs approval |
| Cold start: settled (element count unchanged 2 s) | same | 6.43-7.89 s | 2.65-5.67 s | *new* 7 s, proposed, needs approval |
| Relaunch keeps the running brain | same | no: replaced whenever the brain was over 120 s old (killing its chats and terminals) | yes, every launch | must stay yes |
| Electron main busy in the first 12 s of launch | inspector, 1 ms sampling, 2-3 launches | 4,229 / 5,910 ms | 1,371 / 1,324 ms (integrated build of #1787-#1791) | *new* 1,700 ms, proposed, needs approval |
| Tab switch: page settled, warm | `interaction.mjs tabs 4`, 3 runs | worst 185 ms (CTO); Automations 170 ms | 18-216 ms; worst Automations 164-216 ms, CTO 179-183 ms; long frames 0 except PRs 53 ms | 250 ms |
| Project-tab switch: page settled, warm | `interaction.mjs projects 4` | 1.2.111: ADE 54-80, Versic 58-67 ms; 1.2.112: ADE 67-113, Versic 68-97 ms | ADE 59-151 (median 71), Versic 54-84 (median 77) ms over 8 runs; no long frames | 300 ms |
| Chat switch: settled | `chat-switch.mjs 3`, 3 runs, Mac Studio chats | avg 22-47 ms; worst long task 136 ms | avg 18-45 ms; worst long task 53 ms | 250 ms |
| Chat switch: first changed frame, warm (median) | `interaction.mjs chats 4`, 3 runs | ~61 ms (45-91) | 56-59 ms | 60 ms |
| Chat switch: every DOM change settled, warm | same | median 267-273 ms, worst 337 ms (the previous chat's proof count was replaced ~245 ms after each switch, #1795) | median 170-171 ms, worst 183 ms | 250 ms |
| New chat on a Mac Studio lane: Send → first row | in-app, 8 new chats | 102-183 ms (median ~113 ms) | 107-151 ms (median ~128 ms) | 150 ms |
| New chat on a local lane: Send → first row | same | 207-387 ms (median ~246 ms) | 69-211 ms (median ~158 ms) | 150 ms (see the row above; open item) |
| Launch → Mac Studio connected | connection snapshot after launch, 3 launches | ~11.1-11.5 s (a dead LAN address timed out after 10 s first) | 1.57-2.35 s (#1794) | *new* 4 s, proposed, needs approval |
| Service-health probes, idle and connected | process watcher, 300 s | 20 (each 14 processes, ~3.4 s CPU) | 1 (1.2.113, #1799) | — |
| `gh auth token` launches by the brain, idle | process watcher, 420 s, 3 pairs | 2 / 2 / 3 | 0 / 0 / 0 (#1801) | — |
| Brain: longest idle event-loop stall | brain CPU profile, 5 min idle | 2.0-2.7 s stalls, ~39 near-misses (over 2 s) in 8 days of logs (project-icon scan, DPAPI) | longest busy stretch 169 ms (#1784, #1785) | *new* 300 ms, proposed, needs approval |
| Brain: blocked per chat send by the `agent-browser` probe | brain CPU profile, 4 sends 65 s apart | 78-152 ms per send | 0 (#1796) | — |
| Chat list (`chat.listSessions`) per call | 20 calls from the renderer, brain bundle swapped, interleaved | median 39-43 ms | median 19-21 ms (#1797) | — |
| Idle CPU, Work open (% of one core) | per-process CPU time over 120 s | — | brain 3.8, main 1.1, main renderer 0.8, GPU 0.3, others 0-0.6 | see Processes |
| Update: quit → new version running | real NSIS update 1.2.111 → 1.2.112, local feed | 42-44 s (two real updates of the release) | 38.6 s quit → main started (42.1 s from the click); 24 s of it is the old copy's uninstaller | *new* 60 s, proposed, needs approval |

Notes:

- The project-switch row is within run-to-run drift: the same-day 1.2.112
  build was slower than the current build, and no round-4 change sits on that
  path. Re-measure it against this row, not the 1.2.111 numbers.
- The local new-chat row is the one open item: 158 ms median against a
  150 ms ceiling, inside the macOS range for the same action (120-175 ms).
  The remaining cost on this PC is the brain building the Claude query
  options synchronously when a chat is created (~41 ms per create) and
  git processes started for the new lane's status.
- Every *new* ceiling here is a proposal and does not count until the owner
  approves it.

## Real load, round 1 (2026-10-29)

The rows below are the first Windows pass on real data since the P0-P4
speed work. They replace the service rows above where they say so; the
dev-app rows above are not re-measured yet (see **Not measured in round 1**).

| | |
|---|---|
| Machine | as in **Machine and conditions** (Ryzen 9 7950X3D, 63 GB, Windows 11 Pro 10.0.26200) |
| Build | `ade/speed-and-windows-competitive-review-windows` at `535985e76`: `main` `76a509deb` plus the bench scripts, no product change |
| Node | 22.13.1 (fnm); search fan-out on 24.13.1, because the 22.13 SQLite build has no FTS5 |
| Data | a copy of this PC's ADE project made with `make-real-load-copy.mts`: 13.3 MB `ade.db`, 3.76 M database versions, 5 active lanes with worktrees, 583 chat records, 136 transcripts, the biggest chat 20.7 MB uncompressed (the two largest have 27k events). The live project and the installed ADE were never opened |
| Load | the installed ADE idle beside it; no other benches. Windows reports no load average |
| Method | each bench 5 times (or 5 runs inside one bench); the median, with the worst run in brackets |

An **outside target** is a number another coding app published for the same
measurement, measured the way it was measured; the source and whether it is
merged are in the PR, not here. A row wins only when its worst run wins.

### Against outside targets

| # | Row | How | Windows now: median (worst) | Outside target | Result |
|---|---|---|---|---|---|
| E1 | Project database first open, one per fresh process | `db-first-open.bench.mts --project`, 5 runs x 7 processes | 36.2 ms (36.2; slowest single open 37.6) | 50-66 ms | win |
| F1 | PR discovery reads, one pass (the six reads, no GitHub) | `db-reads.bench.mts --project`, 10 passes, first dropped | 1.73 ms (1.74) | 4.32 ms | win |
| F5 | Startup recovery read (`reconcileStaleRunningSessions`) | same, 1 + 20 | 0.09 ms (0.09) on 7 sessions; 0.18 ms (0.19) once each pass really recovers its 2 stale rows (round 2) | 0.8 ms; 4.0 ms on a 5.5k-item thread | win on this fixture; the 5.5k size is not run yet |
| F3 | One `git rev-parse HEAD` through `runGit`, 200 per run | `spawn.bench.mts --project` | 28.3 ms (29.2) | 2.7-3.0 ms (macOS/Linux) | loss: a bare `git --version` is 26.9 ms here, so this is the Windows process start |
| F4 | Git processes / full `git status` runs for 1 refresh + 4 overlapping (`get_lane_status`) | `git-status-burst.bench.mts --project` | 20 (35) processes, 3 (13) status runs | at most 2 status runs | loss |
| F2 | Longest database step on the event loop while a phone reconnects and the lane list is read 5 times | `brain-db-steps.bench.mts --project` | 1.69 ms (31.9) | 12.7 ms | loss on the worst run |
| F2b | Worst wait of a request sent every 10 ms beside that load (idle: 0.3 ms) | same | 59.9 ms (245.8) in this run; the cold-connect run measured 956-1,134 ms on the same build in the interleaved A/B below (each brain writes to the copy, so only interleaved pairs compare) | 260 ms | loss on the worst run (see **Fixes in this round**) |
| D4 | 200 streamed updates at 1,000 items, slowest of five chats | `chat-timeline.bench.mts` (Mac branch), esbuild bundle run in Electron 44's V8 (`ELECTRON_RUN_AS_NODE`), 3 rounds | 3.1 ms (4.6) | 15.48 ms | win |
| S7 | One full rebuild of a long chat's rows (11,649 events) | `chat-timeline.bench.mts --scenario rebuild --chat 076a90f9` from `main`, same bundle and V8, 3 rounds alternated with the build before #1985 | 10.1 ms (11.4) on `main` `1881d4ca2` (2026-10-30, after #1985); 11.7 ms (13.5) on `f5a42b34f`, just before #1985 | 8.6 ms, measured on other hardware | loss |
| S8 | One tool completing in that chat | same | 0.028 ms (0.054) | 0.28 ms | win |
| PH-cold | Phone, 3G (400 kbps, 400 ms RTT): cold start → biggest chat (20.7 MB) | `phone-sync.bench.mts all --profiles 3g,lte,lan --runs 5 --phone new`, measurement brain on the copy | 4,815 ms (4,818); run 1 was 1,611 ms | 3.6 s | loss |
| PH-cold bytes | Bytes down before that chat | same | 173.7 KB (173.9); run 1 15.6 KB | 89 KB | loss |
| PH-reconnect | Phone, 3G: reconnect → chat / bytes before it | same | 983 ms (985) / 5.9 KB (5.9) | 1.3 s / 17 KB | win |
| | LTE cold / reconnect → chat; LAN cold / reconnect | same | 404 (408) / 167 (167) ms; 85 (94) / 39 (48) ms | — | — |

What the losses are:

- **Phone cold start on 3G.** Run 1 found the shared reseed snapshot still
  building and got one ordinary first batch with the project row (16 KB before
  the chat). From run 2 the snapshot was ready (the copy compacts to about 170
  KB, under the 4 MB cap), and a cold phone receives it as its first batch,
  so its first screen waits for all of it: 4.4 s to the project row at 400
  kbps. A project whose compacted state is over the cap (the Mac copy, 77 MB)
  never takes this path. Not Windows-specific.

- **F2 worst run.** All 11 steps over 16 ms in five runs came in run 1, the
  phone's first (cold) connect: the reseed snapshot for a phone far behind is
  read with `exportChangesSince` on the brain's own connection, a window per
  step, up to 8 per poll (`syncHostService.ts`, `buildMobileReplicaReseedStep`).
  The ordinary catch-up batches already read off the event loop. Same cause on
  the Mac (47 ms worst).
- **F4.** Each `get_lane_status` also starts `git worktree list` and
  `rev-parse` for itself; the status reads coalesce (one running, one shared
  follow-up), but the first refresh finishes before the four arrive, so a
  burst is 3 status runs. The worst run (13 status runs) overlapped a
  background refresh of every lane, which does not join the burst.
- **F3** is process creation on Windows. Each git start removed is worth about
  27 ms here against about 3 ms on macOS.

### Brain and services (replaces the Oct 13 rows where it says so)

| Row | How | Oct 13 | Now: median (worst) | Ceiling |
|---|---|---|---|---|
| Files quick-open index build (the copy's root) | `file-index.bench.mts <copy>` | 195 ms (this worktree) | 293 ms (333) | 500 ms |
| Quick-open lookup, slowest query | same | 1.3-8.2 ms | 9.0 ms (12.6) | 50 ms |
| Project registry: one read per project (10 projects) | `registry-read.bench.mts` | 0.1 ms (6 projects) | 0.6 ms (0.6) | 5 ms |
| Machine roster, cold / warm (one project, the copy) | `roster.bench.mts`, scratch home | 51-59 / 2.0-3.0 ms (4 projects) | 36.6 ms (43.1) / 1.3 ms (1.4) | 150 / 10 ms |
| Reading a 10 MB request, framed / JSONL | `rpc-read.bench.mts` | 6.9 / 6.8 ms | 8.9 ms (9.1) / 7.2 ms (7.5) | 30 ms |
| Transcript full pass as a chat opens, mean of the five largest | `chat-transcript.bench.mts` (`ADE_PROJECT_ROOT=<copy>`) | 32 ms (other chats, 3k-16k events) | 83.7 ms (92.9); 149 ms (180) for a 27k-event chat | 36 ms (open item; not comparable: larger chats) |
| Transcript rows / live merge per streamed event | same | 0.059 / 0.064 ms | 0.095 ms (0.096) / 0.087 ms (0.091) | 0.3 / 0.15 ms |
| Streamed events over 4 ms, of 2,500; worst step | same | 2-4; 24.8 ms | 5 (6); 13.5 ms (16.4) | 15 |
| Tree watcher: ready / longest loop block / CPU until ready / idle CPU 5 s | `tree-watcher.bench.mts <copy>` | 92 / 11 / 313-407 / 0-93 ms | 91 (99) / 3 (3) / 281 (375) / 0 (78) ms | 250 / 20 / 500 / 150 ms |
| `sessions.list`: unscoped / lane / chat | `session-list.bench.mts` | 200 / 79 / 39 ms | 66.6 (75.9) / 28.7 (30.8) / 14.5 (17.8) ms | 250 / 120 / 25 ms (proposed) |
| Conflict sweep, nothing changed: git processes / wall | `conflict-sweep.bench.mts 8` | not run (the bench needed `/bin/sh`) | 9 (9) / 107 ms (198) | *new* 15 / 200 ms |
| Conflict sweep after one lane commits | same | not run | 42 (42) / 1,174 ms (1,362) | *new* 60 / 1,500 ms |
| Credential read while another process holds the lock | `credential-lock.bench.mts` | not run | 1 ms (1) | 50 ms |
| Chat search across 37 projects: cold / longest block | `search-fanout.bench.mts` (Node 24) | not run | 444 ms (446) / 17.4 ms (19.6) | *new* 550 / 25 ms |
| Slash command discovery, uncached: longest block / wall | `slash-discovery.bench.mts` (`CWD=<copy>`) | not run | 1.8 ms (2.0) / 13.3 ms (13.7) | *new* 5 / 20 ms |
| Chat history backfill: per page (mean of five chats) / last page | `chat-backfill.bench.mts` | not run | 49.5 ms (50.5) / 97.6 ms (104.3) | *new*, not set |
| Branch diff, one file click (lane 4,298 files ahead of main) | `branch-file-diff.bench.mts <lane> main 20 patch` | not run | 1,118 ms (1,127), 3 git processes per click | *new*, open item |

### Process spawns (re-measured)

`spawn.bench.mts --project <copy>`, `PATH` with 107 entries.

| Row | Oct 13 | Now: median (max) | Ceiling |
|---|---|---|---|
| `git --version`, median of 10 | 23.0-23.9 ms | 26.9 ms (126.9) | 30 ms |
| `git status --porcelain` in the copy, median of 10 | 42-43 ms (worktree) | 42.6 ms (106.3) | 55 ms |
| `node -e 0`, median of 5 | 42-44 ms | 42.8 ms (146.1) | 55 ms |
| `npx --version` through `cmd.exe`, median of 5 | 242-274 ms | 242.8 ms (336.7) | 340 ms |
| Resolving 14 CLIs, cold / warm | 12.4-12.6 / 4.6-4.8 ms | 12.3 / 4.2 ms | 16 / 6 ms |
| `git config --get` through Git for Windows' launcher (`cmdgit.exe`, the only git a normal install puts on PATH), 5 alternated rounds of 200 | not measured | p50 37.4 ms, p90 136.2 ms; 2 processes per run | *new* |
| The same through the real `mingw64\bin\git.exe` | not measured | p50 26.9 ms, p90 29.2 ms; 1 process | *new* |

### Fixes in this round (A/B on this PC)

Before is `main` (`76a509deb`, its CLI bundle kept as `perfdist-main`), after
is this branch's bundle, both on the copy, runs alternated. Median, with the
worst run in brackets.

| Row | How | Before | After | Outside target |
|---|---|---|---|---|
| F2: longest event-loop database step, the cold-connect run | `brain-db-steps.bench.mts --runs 2 --cli <build>`, 5 pairs | 30.7 ms (31.7); 11-12 steps over 16 ms | 3.5 ms (5.7); none over 16 ms | 12.7 ms |
| F2b: worst wait beside it, same runs | same | 984 ms (1,134; one more run overlapped a download, 5,424) | 246 ms (340) | 260 ms: wins at the median, loses on the worst run |
| PH-cold: 3G cold start → biggest chat | `phone-sync.bench.mts all --profiles 3g --runs 5`, 2 rounds per side | 4,897 ms (4,910); the first run after each brain start 1,604-1,610 | 1,597 ms (1,607) | 3.6 s |
| PH-cold: bytes before that chat | same | 177.5 KB (178.2) | 15.6 KB (15.7) | 89 KB |
| 3G cold start: replica fully caught up | same | 4.9 s | 7.9 s (the reseed now follows the first screen) | — |
| 3G reconnect → chat | same | 985 ms (987) | 985 ms (990) | 1.3 s |
| F4: git processes per burst (1 refresh + 4 overlapping) | `git-status-burst.bench.mts --cli <build>`, 3 rounds of 5 | 20 (38) | 13 (31) | — |
| F4: `git status` runs per burst | same | 3 (13) | 2 (12) | at most 2 |
| F4: burst wall time | same | 601 ms (843) | 507 ms (1,069) | — |
| `git config --get`, p50 / p90 (S192) | `spawn.bench.mts`, 5 alternated rounds of 200 | 37.4 / 136.2 ms through the launcher, 2 processes | 26.9 / 29.2 ms through the real git.exe, 1 process | 31.4 / 46.4 ms |

What changed:

- **F2** (#1976). The cold phone's reseed snapshot reads its windows off the event
  loop (`exportChangesSinceOffThread`, one step at a time, the peer and the
  cache re-checked after each read). A ~240 ms block that is not SQL is left
  in the cold-connect window; not profiled yet.
- **PH-cold** (#1976). A phone with no batch yet gets its ordinary first batch (the
  project row) before a ready reseed, the order it already got while the
  reseed was building. No wire change. The replica finishes catching up 3 s
  later on 3G; the first screen comes 3.3 s sooner.
- **F4** (#1978). A change read that has not started git yet is shared by later asks
  (`runGit`'s `onStart`), and the primary's branch is read again only when its
  HEAD file changes. The worst runs in both columns are the same scheduled
  background refresh of every lane (10 `git status`, `ls-remote`) landing in
  the burst window in one run of five; it is the next thing to look at.
- **S192** (#1977). A normal Git for Windows install puts only its launcher
  (`<Git>\cmd\git.exe`) on PATH, and the installed ADE on this PC resolved it,
  so every git run started two processes. `runGit` now runs the real
  `<Git>\<build>\bin\git.exe` when `MSYSTEM` is unset (a desktop-started
  brain). A `#!/bin/sh` pre-commit hook ran through it with the installed
  app's PATH.

### Not measured in round 1

- **Every dev-app row** (tab and chat switches, typing, idle frames, process
  memory, cold start): waiting on the owner's choice of an ADE home for a dev
  app on the copy (a scratch home needs a sign-in; the shared home would add
  the copy to the owner's project list).
- **E2 launch, E3 startup JS, E4 thread-switch renders, D1-D7**: dev-app or
  renderer benches, built on the Mac side; E3 counts bytes on disk, the same
  on every OS.
- **Hosted web client** (`bench:webclient`): not re-run.
- **Brain cold start** (`brain-start.bench.mts`): it hard-coded `/tmp` and a
  Unix socket; fixed in this branch, not yet measured.

## Real load, round 2 (2026-10-29)

Same PC, copy and method as round 1. Each before/after pair alternated builds
(`main`'s CLI bundle kept as `perfdist-main`, the change's as its own bundle,
both through `--cli`).

### Chat actions through the brain (#1980)

`chat-status.bench.mts`: `getChatStatus` (what `ade chat status` and an agent's
chat tools ask) for the 5 newest chats, 10 calls each per run, on a measurement
brain that settled 45 s first. 2 rounds x 3 runs per build.

| Build | Median per call (worst run) |
|---|---:|
| `main` | 74.1 ms (74.6) |
| + primary lane from its row, CTO identity written only when it changed | 12.6 ms (14.1) |
| + CTO tools built when first read (from the Mac lane) | 2.3 ms (3.0) |

Before, every call listed every lane with git (about 60 ms here), rewrote
`identity.yaml` and upserted `cto_identity_state` (a synced write on every
read), and built all 126 tool schemas (about 11 ms of CPU).

### An idle brain (#1981)

`brain-idle.bench.mts`: a measurement brain on the copy, nothing connected, 10
idle minutes after a 60 s settle. Per 10 minutes, one run per column per round
(2 rounds).

| | `main` | idle fixes | + PR refresh fix (Mac lane) | Outside target |
|---|---:|---:|---:|---:|
| Process starts | 59, 59 | 24, 27 | 5, 26 | — |
| of which PowerShell (power read) | 10, 10 | 0, 0 | 0, 0 | — |
| of which `git remote get-url` | 22, 21 | 2, 3 | 0, 3 | — |
| of which `tailscale status` | 6, 6 | 2, 2 | 1, 2 | — |
| Synced database versions added | 69, 71 | 71, 69 | 21, 41 | — |
| SQL statements (all on the event loop) | 748, 751 | 749, 754 | 669, 742 | about 1 background poll query per 10 min |
| Writer pragmas | 11, 11 | 11, 11 | 11, 11 | about 3 a minute |
| Brain CPU | 4.28, 4.73 s | 3.97, 4.20 s | 4.33, 3.97 s | — |

About 10 starts per window in every column are `gh auth token`: the
measurement brain's stand-in home has no GitHub CLI config, so its token
lookup always reaches `gh` (round 4 measured 0 on the installed app). One
PowerShell power read costs 240-370 ms wall and about 300 ms CPU here. The
~500 reads per window are mostly the PR poll's (121 PR rows, 30 each of stacks,
stack entries, chat-session links and dismissals) and a Linear link check (53).

Two things make these idle numbers higher than a connected install's. The
measurement brain cannot reach ADE's cloud (the port guard blocks it), so its
GitHub relay is never healthy and the PR poller refreshes the open PRs every
tick; with a healthy relay it refreshes them only on a 15-minute sweep. And
its GitHub calls fail (no token in the stand-in home), so the poller backs
off by a varying amount: the first run of the third column backed off and
shows 5 starts and 21 versions, the second did not (26 and 41). Both show the
PR-refresh fix cutting synced writes (69-71 → 21-41).

### Dev app on the copies (shared home, own pipe)

The owner chose the shared `~/.ade` for the dev app: its own pipe
(`\\.\pipe\ade-runtime-perfwin-r2`), sync off, the isolation report checked
first, and two copies of the project open as tabs (`c2`, `c3`, never the live
project; removed from the project list afterwards through the dev brain). No
other machine was connected from this dev app. `main` plus this branch's
scripts (no renderer change). `interaction.mjs <mode> 4`, 5 runs after a
warm-up; median of the run medians, worst run in brackets.

| Row | Now | Oct 13 (one tab, live project) | Ceiling |
|---|---|---|---|
| Tab switch: first changed frame, warm | 26.5 ms (27.7) | 35 / 44 ms | 60 ms |
| Tab switch: page settled, warm (median) | 61.3 ms (68.3) | 79 / 87 ms | — |
| Tab switch: slowest single settle in a run | 177-403 ms (History 214-387, Automations 175, CTO 156) | 357 / 381 ms (Automations, CTO) | 420 ms (open item) |
| Project tab switch: first changed frame, warm | 47.6 ms (48.5) | not measured | — |
| Project tab switch: page settled, warm | 103.7 ms (107.7) | not measured | 300 ms |
| Renderer JS heap after GC | 127 MB | 125 MB | 220 MB |

`process-cpu.mjs 15`, 5 samples, Work idle after a renderer reload and one
visit to every tab (two project tabs open, so the renderer row is not
comparable with Oct 13's one tab):

| Process | CPU (median) | Working set, median (private) | Oct 13 | Ceiling |
|---|---:|---:|---:|---:|
| Electron main | 0.2% | 225 MB (195) | 216-218 MB | 240 MB |
| GPU | 0% | 176 MB (223) | 165-192 MB | 215 MB |
| Renderer | 0.2% | 613 MB (538) | 500-550 MB | 610 MB (over, with a second tab) |
| Brain | 1.4% | 287 MB (305) | 287-341 MB | 380 MB |

Not measured here:

- **Press to content** (`press-to-paint.mjs`): its real mouse input over CDP
  no longer switches anything in this build (a test click on a sidebar tab hit
  the tab and did nothing), so every switch reads "missed". `interaction.mjs`
  (click handler to frame) works.
- **Chat switch**: the copy's project has 7 chat sessions and the Work list
  shows one row, so there is nothing to switch between. The Mac side measures
  chat switches on the owner's real data with three machines connected.
- The first dev app closed by itself after about 20 minutes with nothing in
  its log; the second ran the whole set.

### Corrected rows

- **F5 startup recovery read**: 0.18 ms (worst run 0.19) on the copy with its
  stale rows restored before every pass (round 1's 0.09 ms measured the no-op
  passes after the first). Outside target 0.8 ms; merged 4.0 ms on a 5.5k-item
  thread. Still a win.

## Real load, round 3 (2026-10-30)

Same PC and copy. `brain-db-steps.bench.mts --runs 2 --settle-ms 15000 --cli <build>`, cold
connect run, 5 fresh measurement brains per build, builds alternated.

| Row | `main` with #1976-#1983 (`f5a42b34f`) | + singleton probes and stale-run sweep off the event loop | Outside target |
|---|---:|---:|---:|
| F2: longest event-loop database step | 3.5 ms (4.1) | 3.6 ms (3.8) | 12.7 ms |
| F2b: worst wait beside a cold phone connect | 241.1 ms (293.4); an earlier set of 5 on `main`: 209.6 ms (257.8) | 197.0 ms (200.8) | 260 ms |

A CPU profile of a cold connect on `main` showed what was left on the event loop: the sync host
singleton starting three PowerShell probes (about 60 ms) and the chat stale-run sweep reading and
parsing the biggest chat's whole 20 MB transcript (about 310 ms with the profiler on), 5 s after the
project opened.

`stale-sweep-read.bench.mts --project <copy> --runs 5`, the three largest transcripts: the
sweep's timer read, the whole file parsed synchronously against chunked async reads that parse
only the lines naming a stale-relevant event type. Both give the same background and subagent
snapshots.

| Chat | Size | Longest block, full read | Longest block, filtered read | Wall, filtered |
|---|---:|---:|---:|---:|
| `feb919f2` | 20.7 MB | 99.2 ms (106.0) | 4.9 ms (7.1) | 67.0 ms (165.5) |
| `5eac6a04` | 18.4 MB, 27k events | 97.6 ms (122.6) | 5.7 ms (7.8) | 95.8 ms (210.5) |
| `a8a1d9fa` | 16.6 MB | 80.2 ms (95.1) | 6.6 ms (6.7) | 64.6 ms (124.8) |

## Final Windows numbers (round 4, 2026-10-30)

Same PC, the same copy of the owner's project (13.3 MB `ade.db`, 5 lanes, the biggest chat 20.7 MB). Each row: median, with the worst run in brackets. An outside target is another coding app's published number for the same measurement. A row wins only when its worst run wins. Every PR named here is merged.

### Every row against its target

| Row | Windows | Target | Result | Where it came from |
|---|---|---|---|---|
| E1 project database first open | 36.2 ms (36.2) | 50-66 ms | WIN | round 1 |
| F1 PR discovery reads, one pass | 1.73 ms (1.74) | 4.32 ms | WIN | round 1 |
| F2 longest database step on the event loop, cold phone connect | 3.6 ms (3.8) | 12.7 ms | WIN | #1976, #1986 |
| F2b worst wait beside a cold phone connect | 197.0 ms (200.8) | 260 ms | WIN | #1983, #1986 |
| F3 one `git rev-parse HEAD` through `runGit` | 28.3 ms (29.2) | 2.7-3.0 ms (macOS/Linux) | LOSS | a bare Windows process start is 26.9 ms here; only fewer git starts help (#1977, #1989) |
| F4 `git status` runs per burst (1 refresh + 4 overlapping) | 2 (12) | at most 2 | WIN at the median, LOSS on the worst | the worst runs are the lane list cache (10 s) expiring inside the burst: the next refresh rebuilds every lane's status once. See below |
| F4 git processes per burst | 8 (21) | — | — | 13 (27) before #1989 |
| F5 startup recovery read, this copy (7 sessions) | 0.18 ms (0.19) | 0.8 ms | WIN | round 2 |
| F5 at 5,500 session rows, 50 of them stale | 0.93 ms (0.94) | 4.0 ms (a 5.5k-item thread) | WIN | `db-reads --seed-sessions 5500 --seed-running 50`. Cost grows about 30 µs per recovered row: 500 stale 12.9 ms (14.7), all 5,500 stale 174.3 ms (175.7) |
| PH-cold, 3G cold start to the biggest chat | 1,597 ms (1,607) | 3.6 s | WIN | #1976 |
| PH-cold bytes before that chat | 15.6 KB (15.7) | 89 KB | WIN | #1976 |
| PH-reconnect, 3G | 985 ms (990), 5.9 KB | 1.3 s, 17 KB | WIN | round 1 |
| D4 200 streamed updates at 1,000 items (Electron V8) | 3.1 ms (4.6) | 15.48 ms | WIN | round 1 |
| S7 one full rebuild of a long chat's rows | 10.1 ms (11.4) | 8.6 ms (other hardware) | LOSS | re-measured 2026-10-30 on `main` `1881d4ca2`; #1985 took it from 11.7 ms (13.5) on this PC. The target was measured on other hardware |
| S8 one tool completing in that chat | 0.028 ms (0.054) | 0.28 ms | WIN | round 1 |
| S98 idle brain, 10 minutes | 5-27 process starts, 4.0-4.3 CPU-s | 1,722 processes, 62 CPU-s (about 60 chats) | WIN | #1981; this copy has 7 chats |
| S99a port polling with no terminals | 0 port scans in 10 idle minutes | 0 work | WIN | round 2 trace |
| S130 changed-file tree for 1,000 files | 1.12 ms (1.16) lane change list; 1.13 ms (1.23) diff tree | 2.38 ms | WIN | `changed-file-tree.bench.mts` |
| S136 workspace file search | index build 293 ms (333), slowest lookup 9.0 ms (12.6) | 351 ms | WIN at this copy's size | round 1; the target's workspace size is not matched |
| S191 PATH x PATHEXT scan per spawn | cached: 14 CLIs 12.3 ms cold, 4.2 ms warm in total | ~22 ms per spawn uncached | WIN | round 1 |
| S192 `git config --get`, p50 / p90 | 26.9 / 29.2 ms | 31.4 / 46.4 ms | WIN | #1977 |
| Chat action through the brain (`getChatStatus`) | 2.3 ms (3.0) | — | — | #1980 (was 74.1 ms) |
| Idle database reads | about 670-750 statements per 10 idle minutes | about 1 poll query | LOSS | mostly the measurement brain's PR poller refreshing every tick, because its relay can never be healthy (a connected install sweeps every 15 minutes), plus a Linear link check; microseconds each. Writer pragmas 11 per 10 minutes against about 3 a minute: WIN |

### The dev app (shared home, own pipe, sync off, copy `c2`, one project tab)

`interaction.mjs tabs 4`, a warm-up, then 5 runs; median of the run medians, worst run in brackets.

| Row | `main` before #1987/#1989 | With #1987 and #1989 | Ceiling |
|---|---|---|---|
| Tab switch, first changed frame | 31.1 ms (32.3) | 25.8 ms (26.5) | 60 ms |
| Tab switch, page settled | 64.6 ms (84.7) | 60.6 ms (135.0) | — |
| History, warm settle per run | 389, 396, 399, 398, 42 ms (median 396) | 206, 367, 47, 142, 201 ms (median 201) | 420 ms (open item) |
| Automations, warm settle | 175-181 ms | 175-177 ms | — |
| `lanes.list` from the renderer | 32.6-34.1 ms | 4.9-6.1 ms | — |
| `git.listBranches` from the renderer | 31.2-32.8 ms | 3.1-3.4 ms | — |
| Project tab switch, first frame / settled | 47.6 (48.5) / 103.7 ms (107.7) | not re-measured (needs a second copy as a tab) | 300 ms settled |

Every call from the renderer into the brain used to cost about 32 ms, even when the answer was cached. A main-only IPC is 0.1-0.5 ms and the brain answers `ping` in 0.2 ms; a spawn trace found a git process start per call (a lane list's `git worktree list`, the lane-folder check before every git operation, a commit's files and message). #1989 keys those on file identity.

`process-cpu.mjs 15`, 5 samples, Work idle after a renderer reload and one visit to every tab (`main` `d60747404`):

| Process | Working set, median (private) | macOS ceiling | Result |
|---|---:|---:|---|
| Electron main | 222 MB (193) | 200 MB | LOSS |
| GPU | 173 MB (233) | 150 MB | LOSS |
| Renderer | 561 MB (485); JS heap 118 MB after a forced GC | 300 MB | LOSS |
| Brain | 243 MB (250) | 250 MB | WIN |

Most of the renderer is not JavaScript: its heap is 118 MB of the 561. The rest is Chromium's own memory and the code of the dev renderer's separately loaded Vite modules (the resource buffer stops counting at 250). The macOS ceilings were also measured on a dev build, so the comparison holds across the two OSes, but a packaged build loads one bundle. This pass found no leak or fixable hot spot. Tracing Chromium's native memory is the next step, and was not done. The installed app was not measured, by rule.

### Cold start

| Row | Windows | Notes |
|---|---|---|
| Brain cold start, `cli.cjs serve` to listening (`brain-start.bench.mts`, 7 pairs) | 798.1 ms (802.4) without the compile cache; 523.3 ms (536.4) with it | `main` `d60747404`; every run stopped gracefully |
| Installed app: first window / app mounted / settled | 1.11-1.22 s / 1.79-1.91 s / 2.65-5.67 s | last measured 2026-10-19, before the speed work. Not re-measured: it means installing a build over the owner's ADE |

### F4's worst run: cause and two attempts

The worst bursts (12 status runs instead of 2) come from the lane list cache (`LANE_LIST_CACHE_TTL_MS`, 10 s). `get_lane_status` reads the lane summary through `laneService.list`, so when the cache has expired, that one refresh rebuilds every lane's status inside the burst. Two variants were measured on the copy over 16 bursts each and dropped:
- `getSummary` for the one lane, reusing its status for 10 s: the median got worse (status runs 2 to 3, git processes 13 to 15-20), because each call read that lane's status again.
- A worktree-root cache key without the `.git` folder's mtime, alone: no change on this path (it is part of #1989, where it does pay off).

The real cost is a few extra git processes at most once per 10 seconds, so lane list freshness is left as it is and the row is recorded as a loss.

### Not measured

- **Chat switch on Windows:** the copy's Work list shows one row. The Mac side measures chat switches on the owner's real data.
- **Press to content:** the CDP mouse input in `press-to-paint.mjs` no longer switches tabs in this build.
- **The hosted web client bench:** not re-run.

`changed-file-tree.bench.mts` and `stale-sweep-read.bench.mts` are new; `db-reads.bench.mts` takes `--seed-sessions` / `--seed-running`; `measure-brain.mjs` passes `ADE_DISABLE_OFF_THREAD_SPAWN` through to the brain for attribution runs (spawn traces then show each process's real caller).

## How to measure on Windows

Everything below ran in Git Bash or PowerShell 7 on this PC.

### Start the dev app for measuring

Use Node 24 (the version in `.nvmrc`) in every shell that runs node or npm:

```bash
eval "$(fnm env --shell bash)"; fnm use 24        # Git Bash
```

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression; fnm use 24
```

Start the app from **PowerShell**. Git Bash rewrites `\\.\pipe\...` (the
launcher then tries `C:\pipe\...` and fails with `EACCES`), and it also
rewrites any argument that starts with `/`, such as a route; set
`MSYS_NO_PATHCONV=1` in every Git Bash command that passes a route or a pipe.

```powershell
$env:ADE_APP_CONTROL_DEBUG_FLAGS = "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling"
$env:ADE_PERF_RUN_ID = $null          # set it only for the IPC pass
$D = "$env:TEMP\ade-perf-windows\before"
node scripts/perf/ui/cold-start.mjs "$D\dev.log" '\\.\pipe\ade-runtime-perfwin' 300
Select-String -Path "$D\dev.log" -Pattern "isolation report" -Context 0,8   # stop if sync is ON
```

`cold-start.mjs` launches through `scripts/dev-detached.mjs` and prints the
pid of the detached `npm` process and the time to each milestone. A plain
`node scripts/dev-detached.mjs "$D\dev.log" npm run dev:desktop -- --socket '\\.\pipe\ade-runtime-perfwin'`
starts it the same way without timing.

Then:

- Close every page that is not the app (`curl -s http://127.0.0.1:9222/json/list`,
  `curl -s http://127.0.0.1:9222/json/close/<id>`). The dev app opens a
  DevTools window on Windows.
- `render-count.mjs ... reload` leaves its render hook in the page, which
  inflates the heap (255 MB) and the renderer's memory. Reload the page from a
  fresh CDP session (`cdp.mjs eval 'location.reload()'`) before measuring
  memory or process numbers.

Stop the app with its whole tree, then confirm its brain is gone. Check that
every process in the tree runs from this worktree first; the installed ADE
runs from `AppData\Local\Programs\ADE` and must not be touched:

```powershell
taskkill /T /F /PID <pid printed at launch>
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ade-runtime-perfwin' }   # expect nothing
```

### Commands that produced this file

```bash
export MSYS_NO_PATHCONV=1
R=/work,/lanes,/files,/prs,/automations,/history,/cto,/settings
node scripts/perf/ui/route-sweep.mjs none $R 3      # warm-up pass, discarded
node scripts/perf/ui/route-sweep.mjs none $R 10     # run 1, then again for run 2
node scripts/perf/ui/route-sweep.mjs <runId> $R 3   # IPC pass, app launched with ADE_PERF_RUN_ID=<runId>
node scripts/perf/ui/gpu-trace.mjs 8                # on /settings, /prs, /work
TOP=25 node scripts/perf/ui/render-count.mjs 15     # on /work
node scripts/perf/ui/chat-switch.mjs 2
node scripts/perf/ui/interaction.mjs tabs 4         # and chats
node scripts/perf/ui/press-to-paint.mjs tabs 4      # and chats
node scripts/perf/ui/typing.mjs 80
node scripts/perf/ui/keystroke-trace.mjs 40
node scripts/perf/ui/cdp.mjs gc
cd apps/ade-cli && npx tsx ../../scripts/perf/service/<name>.bench.mts
npx tsx ../../scripts/perf/service/tree-watcher.bench.mts 'C:\Users\arul2\Documents\Programming\ADE'
npx tsx ../../scripts/perf/service/spawn.bench.mts
cd apps/desktop && npm run bench:webclient -- --skip-chat --out <file>
```

```powershell
node scripts/perf/ui/process-cpu.mjs 15 '\\.\pipe\ade-runtime-perfwin'
```

### Windows changes to the scripts

- `scripts/perf/ui/process-cpu.mjs` (new): the cross-platform `process-cpu.sh`.
  On Windows it samples `Win32_Process` (kernel plus user time, working set,
  private bytes) twice; elsewhere `ps`. It finds the dev Electron main by its
  `--remote-debugging-port`, its GPU, renderer and utility children, and the
  brain by `cli.cjs serve` plus the pipe, so the installed ADE is never
  matched. `process-cpu.sh` is unchanged.
- `scripts/perf/ui/cold-start.mjs` (new): times a dev launch.
- `scripts/perf/ui/cdp.mjs`: a `gc` command (heap before and after a forced GC).
- `scripts/perf/ui/route-sweep.mjs`: reads the perf-run log from
  `os.homedir()` instead of `$HOME`.
- `scripts/perf/service/spawn.bench.mts` (new): the spawn rows.

Raw outputs of this pass: `%TEMP%\ade-perf-windows\before\`.

### Windows changes to the scripts (round 1, real load)

- `scripts/perf/net/make-real-load-copy.mts`: runs on Windows. Plain copies
  instead of APFS clones, the SQLite URI form `file:/C:/...`, an empty git
  config file instead of `os.devNull`, paths rewritten in all three stored
  forms (`C:\x`, `C:/x` and JSON-escaped), a lane whose worktree sits outside
  the project moved into the copy, and worktree `.git` files (hidden on
  Windows) rewritten in place.
- `scripts/perf/net/guard-sync-port.cjs`: matches `C:\...\powershell.exe`,
  blocks `wmic process`, and stands in `cmd.exe /d /c exit 0` for
  `/usr/bin/true`.
- `scripts/perf/ui/spawn-trace.cjs`: writes to the OS temp folder and keeps 16
  arguments (ADE puts ten `-c` arguments before every git verb).
- `scripts/perf/net/measure-brain.mjs`: `ADE_PERF_EXTRA_REQUIRE` preloads.
- `conflict-sweep` and `branch-file-diff` count git processes through
  `git-count.mts`: a wrapper script elsewhere, `spawn-trace.cjs` on Windows,
  where a wrapper cannot be spawned without a shell.
- `brain-start.bench.mts`: the OS temp folder and a named pipe on Windows.
- Not Windows-only, fixed on the way: `chat-transcript` and `chat-backfill`
  read `.ade/transcripts/*.chat.jsonl`, but chats now live in
  `.ade/transcripts/chat/*.jsonl[.gz]` (`transcript-files.mts`), so both
  measured nothing; the `chat-backfill` pager stalled on an event larger than
  a page; the `conflict-sweep` lane stub lacked `getCompareBase`.
- New benches: `db-first-open`, `git-status-burst`, `brain-db-steps` (with
  `scripts/perf/net/sql-trace.cjs` and `brain-rpc.mts`), and the F1, F3, F5 and
  launcher rows in `db-reads` and `spawn`.

Raw outputs of round 1: `%TEMP%\ade-perf-windows\r1\out\`.
