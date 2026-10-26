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

### Onboarding tour

The guided tour after first-run setup (`components/onboarding/tour/`). Mac
Studio dev build on its own socket, CDP 9233, 1.1× zoom, nothing streaming,
2026-10-21 on the `ade/onboarding-tiers-planning` branch; not the baseline
machine. `cdp.mjs metrics` and `gpu-trace.mjs`, 4 s windows from a Next click.

| Metric | Before (first tour) | Baseline | Ceiling |
|---|---|---|---|
| Step change between read steps: frames drawn / GPU | 187–217/s, 183–212 ms/s | 38/s, 35 ms/s | 60/s, 60 ms/s |
| Step change into a do-it step (pulse + click): frames drawn / GPU | — | 71/s, 76 ms/s | 100/s, 110 ms/s |
| Step change: main-thread work | 14–19 ms/s | 16–20 ms/s | 30 ms/s |
| Card showing, idle: main-thread work | 2.9 ms/s | 2.4 ms/s | 5 ms/s |
| Paused pill, idle: main-thread work | 4.5 ms/s | 2.5 ms/s | 5 ms/s |

### Processes (CPU and memory)

Measured with `process-cpu.sh` over 15 s on Work, idle, with 2 chats
streaming in the background, perf runs off.

| Process | Baseline CPU | Baseline RSS | Ceiling |
|---|---|---|---|
| Electron main | 10.5% | 120 MB | 15%, 200 MB |
| GPU | 3.4% | 64 MB | 10%, 150 MB |
| Renderer | 17.4% | 131 MB | 25%, 300 MB |
| Brain (`cli.cjs serve`) | 4.5% | 55 MB | 10%, 250 MB |

### Window wallpaper (scene picture)

GPU process physical footprint (`footprint -p`) with a picture scene against
the plain background, 2560×1440 window, the screen reported as 2560×1440 through
CDP `Emulation.setDeviceMetricsOverride` (`screenWidth`/`screenHeight` only),
each state after a reload and a forced GC, 3 rounds, median. The renderer's
footprint moved ±40 MB between identical reloads, so it is not a usable signal
here. Mac Studio M4 Max, isolated first-run dev app, nothing else open in it,
2026-10-25.

| Picture on a 1440p screen | Before | Baseline | Ceiling |
|---|---|---|---|
| Standard picture (3840×2400 file before, 2560×1600 copy now), over plain | +25 MB | +11 MB | +20 MB |
| Ultrawide picture (5120×1440, unchanged) | +21 MB | +20 MB | +30 MB |

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
| Idle chat runtimes: 5 chats (3 Claude Haiku, 2 Codex), one turn each, then idle; agent processes held under the brain (count, RSS) | one-off headless brain on a throwaway `ADE_HOME` and scratch project, process tree sampled every 30 s for 11 min (no bench file yet) | 20 processes, 0.7–1.1 GB, until 4.5–5 min idle; 0 by 5.5 min | 20 processes until 2 min idle; 0 by 3.5 min (ademark-idle-shutdown, 2026-10-20, not the baseline machine; measured before #1838, when each Codex chat had its own app-server) | not set yet; needs approval |
| Codex turn after an idle teardown: new (uncached) input tokens, against a warm turn's 205–215 | same run, two turns per chat after the idle window | 2,520 and 8,121 on the first turn, then up to 5,832 on the next | 223–255 on both turns | not set yet; needs approval |
| Claude turn after an idle teardown: prompt-cache read / write | same run | ~47.7k read / 67–780 written (no miss) | ~47.7k read / 930–3,528 written (no miss) | not set yet; needs approval |
| Brain cold start, spawn of `cli.cjs serve` to `ADE brain listening` (throwaway home, `--no-sync`): no compile cache → the service's compile cache; median of 9 pairs, two sessions | `brain-start.bench.mts` | — | 2,725 → 2,498 ms and 2,737 → 2,525 ms (perf/brain-compile-cache) | not set yet; needs approval |
| Settings › MCP servers: scan of the provider CLI configs (169 KB `~/.claude.json`, 17 KB Codex `config.toml`; runs in Electron main, twice per page open) | one-off `tsx` loop over `scanProviderMcpConfigs`, 20 runs (no bench file yet) | — | 4–6 ms, 18 ms cold | 25 ms |
| MCP App: file one app with the chat (218 KB page, its record, and the prune of a 40-app chat; `mcpAppStore.write`, runs in the brain once per tool call that has a page) | one-off `tsx` loop, 60 runs (no bench file yet) | — | 0.9–1.7 ms; reading one back 0.1 ms | 10 ms |
| MCP App: tool result to transcript card (list lookup, `resources/read` through the live session, file, emit), 6 KB page | timestamps of the `tool_result` and `ade_card` events in a dev-brain transcript, Claude ×4 and Codex ×2 | — | 2–10 ms (Claude, first call of a session reads the tool list); 2 ms (Codex) | 100 ms |
| Chat search across 37 registered projects (2,000 chat docs each, every doc a hit) | `search-fanout.bench.mts` | not from #1560: until 2026-10-13 the search loaded every project and blocked the brain past its 30 s watchdog | 325–341 ms, longest event-loop block 10 ms | 800 ms, block 50 ms |
| Apple stream relay, one viewer, 2.5 Mb/s 60 fps stream, second half of a 30 s run: delay from the relay's send to the viewer (p50 / p90 / p99), frames delivered per second, and delta frames delivered ahead of a keyframe (checked by sequence number). 1 Mb/s 40 ms link, plus a fast Wi-Fi link that stalls 250 ms every 2 s | `apple-stream-pacing.bench.mts` | not paced (no acks, as before): 1 Mb/s 34.9 s / 43.9 s / 45.8 s, still growing; Wi-Fi stalls 9 / 70 / 239 ms, 57 fps | paced (the viewer acks): 1 Mb/s 52 / 73 / 240 ms, 58 fps, cap 2500 → 540–675 kb/s; Wi-Fi stalls 8 / 43 / 236 ms, 60 fps, 2 frames skipped; 0 undecodable throughout (also 600 kb/s 120 ms: 133 / 319 / 392 ms; 5 Mb/s 20 ms: 30 / 31 / 162 ms, no skips) | proposed, needs approval: p50 100 ms, p90 350 ms, ≥ 50 fps, 0 undecodable |
| Apple pane, 3D view of an iPhone Duo (inner display, 2007×2853 frame), the simulator scrolling continuously (an agent drag every ~0.5 s), 20 s average: dev Electron renderer / GPU process CPU. The screen texture now follows the pane's size up to 1,600 px on its long side (was a fixed 512 wide, soft on Retina and in renders) | `ps` sampling (`%cpu` of the worktree's `--type=renderer` and `--type=gpu-process`), same window, same pane size, back to back; the chat UI was live in both runs (idle reads 24–28% / 50–61%) | 512: 36.6% / 64.4% | 1,600: 45.0% / 75.1% (Mac Studio M4 Max dev build, 2026-10-22, not the baseline machine) | not set yet; needs approval |
| `sessions.list` handler, 617 chat metadata files (synthetic, sized like a real project: 8.1 MB, p50 4.4 KB, p90 34 KB, max 152 KB). Chat-scoped (a chat pane's shells, per chat switch) / lane (`limit 200`) / unscoped (`limit 500`); median of 7 runs in each of 3 processes | `session-list.bench.mts` | — | chat-scoped 226 → 13 ms; lane 102 → 78 ms; unscoped 235 → 191 ms (main → head, with the orphan repair; medians of 3 interleaved processes). Chat metadata reads per call 500 → 0, 222 → 137, 500 → 351 | proposed, needs approval: chat-scoped 25 ms, lane 120 ms, unscoped 250 ms |
| Onboarding discovery: first-run setup's project discovery (`app.discoverOnboardingProjects`, 460 agent folders → 12 projects, 11 providers) and one cold chat list (`app.listOnboardingProjectChats`), Electron main event loop. Mac Studio M4 Max, 2026-10-21, this branch (not the baseline machine) | one-off `vite-node` script on this machine's real provider history, 1 ms interval probe + `monitorEventLoopDelay` (no bench file yet) | — | discovery: longest main-thread block 2,742 → 7 ms, total 4.7 → 5.5 s (now in a child process; the extra is its start); cold chat list: block 769–957 → 3–7 ms, total 0.85–1.7 → 1.1–1.9 s; a list after discovery 0 ms (kept in main) | proposed, needs approval: longest main-thread block 50 ms |
| Idle-lane build output cleanup (storage doctor step `fs.lane_build_output`, at most once a day): one run over a throwaway 8-lane project (git `ls-files`/`status`/`check-ignore` per lane, one `lsof -d cwd`, 8 folders removed); and the shared disk accounting (`diskUsage.measureTree`, allocated blocks + hard-link tally + pnpm store skip) against the old `stat.size` walk on this lane's `apps/desktop/node_modules` (114,573 files). Mac Studio, 2026-10-25, load average 400–800 from other agents' typechecks (not the baseline machine) | one-off `tsx` scripts driving `createStorageInsightsService` and `measureTree` (no bench file yet) | — | sweep 3.6 s for 8 lanes; accounting 3.6–9.2 s new vs 5.4–6.7 s old over 3 interleaved rounds (same file count, 3.10 GB allocated vs 2.77 GB length), longest event-loop gap 131 ms under that load | sweep within its own 15 min budget; accounting within 25% of the old walk (approved by the owner 2026-10-26) |

On 2026-10-19, a focused Node 22 harness compared the existing 5-second
desktop poll with the brain poll after this change. Both used the same activity
summary over 35 registered projects (12 booted), with no active work, for 15 s:
the old desktop loop used 0.711% process CPU for 3 summary reads; the brain loop
used 0.082% for 4 reads. This is a service-only sample, not a full ADE process
benchmark. The default remains `never`, so the brain adds no poll in the normal
idle baseline above; the enabled path moves the existing poll to the brain and
keeps its 5-second cadence.

### Agent prompt (Hello Tax)

Input tokens on the first turn of a chat whose only message is `hi`, ADE versus
the bare CLI in the same folder (this repo's lane worktree), same model, same
provider home. ADE side: a Work chat on a dev brain with its own socket
(`ade new chat --provider … --prompt hi`); bare side: the pinned CLI run by hand
with stdin closed. Claude: Haiku 5.5, CLI 0.3.300, `CLAUDE_CONFIG_DIR` set to
ADE's account home, `claude -p hi --model haiku --output-format json`, usage of
the first assistant message in the transcript (input + cache write + cache
read). Codex: `gpt-6-luna`, CLI 0.162.1, `codex exec --json -m gpt-6-luna hi`,
the first `token_count` in the rollout. Mac Studio, 2026-10-20, on top of
`0d9211fd1` (not the baseline machine). Per-section sizes came from the request
bodies, captured through a local pass-through proxy (`ANTHROPIC_BASE_URL`).

| Metric | Bare CLI | Before | Baseline | Ceiling |
|---|---|---|---|---|
| Claude chat, first turn (`hi`) | 30,624 | 63,575 (+32,951) | 39,369 (+8,745) | +11,000 over bare |
| Codex chat, first turn (`hi`) | 27,716 | 32,324 (+4,608) | 30,258 (+2,542) | +3,200 over bare |
| Computer-use block in the first message (Mac host, lane screen available) | — | 9,775 chars with the lane directive | 2,629 chars with the lane directive | — |

Per-turn cost on the providers that have no instruction channel but the user
turn, or that got ADE's guidance in both places: growth in input tokens from
turn 1 (`hi`) to turn 2 (`ok`), read from ADE's own `done` usage. Before:
this repo's lane on the shared home (2026-10-20). After: a throwaway
`ADE_HOME` and scratch project (the isolation rule forbids the real one); the
growth does not depend on the repo, and Grok's own history shows turn 2 is the
bare `ok`. Droid (no API key here), Cursor (rate-limited), Kimi, Qwen and Muse
(not signed in) could not be measured.

| Metric | Before | Baseline | Ceiling |
|---|---|---|---|
| Antigravity, turn 2 growth | +5,254 | +670 | +1,000 |
| Grok, turn 2 growth (Grok's own per-turn reminders are ~900 of it) | +2,733 | +1,020 | +1,300 |
| Pi, turn 2 growth | +1,593 | +56 | +200 |
| Copilot, turn 2 growth | +818 | +44 | +200 |
| Claude, a second new chat in the same lane: tokens written to cache | 26,384 | 0 (40,916 read) | — |

Ceilings in the two tables above approved by the owner on 2026-10-20.

Most of the Claude gap was `ENABLE_TOOL_SEARCH=auto`, which ADE forced on
every query: "auto" only defers tool schemas once they pass a share of the
context window, so every schema went inline. The bare CLI measured 30,624 with
the variable unset or `true`, 45,010 with `false` and 48,454 with `auto`. A
brain started from an older ADE's shell inherits the variable, so ADE now drops
it from the query environment.

Not ADE's: the `## Skills` listing Codex builds itself (~23k chars here), the
claude.ai connector tools and `AskUserQuestion`/plan-mode tools the SDK adds in
streaming mode, and project or user skills ADE lists for Claude (this
machine's `~/.codex` skills were 4.9k chars). A small repo pays the same
ADE addition on a smaller base: bare Claude in a one-file repo was 22,525.

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

#### Electron 41.5.0 → 44.9.3

Measured 2026-10-25 on the `ade/t3-electron-network-c64e8985` branch, Mac Studio
M4 Max (not the baseline machine), the same branch code on both, only the
Electron binary swapped (`ELECTRON_OVERRIDE_DIST_PATH`), `--use-mock-keychain`.
Start-up: `desktop-main-start.mjs --mode warm --runs 9`. Processes: an
isolated dev app (throwaway `ADE_HOME`, user data and project) idle on the
sign-in screen, `footprint` after 60 s.

| Metric | Bench | Electron 41.5.0 | Electron 44.9.3 | Ceiling |
|---|---|---|---|---|
| Process start to first window, warm cache (median; sd 10–11 ms) | `desktop-main-start.mjs --mode warm` | 626 ms | 556 ms | not set, needs your OK |
| Process start to bundle evaluated, warm cache (median) | `desktop-main-start.mjs --mode warm` | 403 ms | 338 ms | not set, needs your OK |
| Electron main / GPU footprint, idle | `footprint` | 170 MB / 79 MB | 170–181 MB / 54 MB | the Processes table |
| App renderer footprint, idle (wallpaper differed between the runs) | `footprint` | 436 MB | 467–473 MB | the Processes table |
| Clipboard history poll read (text + flavor list; async on 44) | one-off Electron loop, 200 reads | 0.042 ms | 0.056 ms | — |

#### Brain on Node 22.22 → 24.22

Same branch, machine and date. A headless brain (`serve --no-sync`) on a
throwaway `ADE_HOME` and scratch project, tool downloads off, idle for 30 s
after its socket appears; two runs each. Node 24's V8 sizes the young
generation by machine memory, so the release runtime is built with Node 22's
16 MB cap (`execArgv` in `build-static.mjs`).

| Metric | Bench | Node 22.22.2 (`cli.cjs`) | Node 24.22.1 (`cli.cjs`, no cap) | Node 24.22.1 release runtime, capped | Ceiling |
|---|---|---|---|---|---|
| Spawn to socket listening | one-off loop | 2,595–2,645 ms | 2,484–2,528 ms | 2,502–2,511 ms | — |
| Footprint, idle 30 s | `footprint` | 226 MB | 279 MB | 224–225 MB (264 MB uncapped) | the Processes table |
| CPU time, first 30 s | `ps` | 0.97–1.01 s | 0.70–0.71 s | 0.74–0.80 s | — |

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
  after 3 minutes idle.
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

The UI scripts talk to the renderer over CDP port 9222 (`CDP_PORT=<port>` for
a dev app launched with another `ADE_APP_CONTROL_CDP_PORT`, e.g. when another
lane's dev app already holds 9222) and pick the first
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
| `loop-delay-trace.cjs` (load like `spawn-trace.cjs`) | Each process's event-loop delay (p50, p99, max at 10 ms resolution) and CPU time, one line per 5 s window in `$ADE_SPAWN_TRACE_DIR/loopdelay-<pid>.log`. For the brain loop-delay rows |
| `gpu-trace.mjs <secs>` | Frames drawn, GPU swap time and rendering phases, for the whole browser |
| `render-count.mjs <secs> reload` | React commits and which components re-render, and why (changed props or hooks) |
| `chat-switch.mjs [rounds]` | Clicks through the chat list; time until each transcript settles, and long tasks |
| `interaction.mjs tabs\|chats\|projects\|pickers [rounds]` | Per tab, chat or project switch, or composer picker open (`pickers`; `SCREENCAST=1` for a covered window): time to the first frame that shows a change, time until the page stops changing (`settled`, every DOM change), and long frames in between. `content settled` ignores decoration and tickers (`data-perf-ignore`, `aria-hidden` inside `<main>`), and `content ready` is when the page's `<main>` first has new text. The rules are in `scripts/perf/ui/settle.mjs`. Finer than long tasks, which miss every frame under 50 ms |
| `press-to-paint.mjs chats\|tabs\|projects [rounds]` | The same switches from the hand: real mouse input (move, press, a held button, release) and the time from the press to the first frame that shows the new chat, page or project. `interaction.mjs` starts its clock in the click handler and cannot see the time the button is held |
| `press-to-paint.mjs rapid [runs]` | Presses several chat rows a fixed interval apart: time from the last press to the last chat's content, which earlier chats painted on the way, and the main-thread work of the whole burst |
| `typing.mjs <keys>` | Types into the composer; keystroke events slower than 16 ms |
| `terminal-flood.mjs <laneId> seq\|yes [secs]` | Starts a shell in the lane and floods it (16 MB `seq` or 200 MB colored `yes`) while the renderer calls `sessions.get` again 100 ms after each reply: time to finish, that round trip (p50, p95, max over answered calls, plus failures), frame gaps, long tasks, and the brain's CPU (`ADE_RUNTIME_SOCKET`) |
| `keystroke-trace.mjs <keys>` | Renderer work per keystroke, split into style, layout, paint and script |
| `cdp.mjs eval\|metrics\|profile\|shot\|anim` | One-off probes: evaluate, metrics delta, CPU profile with top functions, screenshot, running animations |
| `music-host.sh <secs>` | CPU %, RSS and physical footprint of the macOS Apple Music host and the WebKit processes it started |
| `music.mjs first-play cold\|warm`, `music.mjs pushes <secs>` | Time from Play to the first playing state, with the host stopped or running; Music state pushes a window receives |
| `music-library.mjs detail\|grid\|scroll\|memory` | Apple Music library: time to a playlist's first rows and full list, Playlists grid open and scroll (long tasks, IPC and Apple requests through the main process's inspector, artwork requests), renderer heap after opening playlists |
| `loop-cost.mjs <case>,... [secs] [socket]` | One looping animation (the app's own markup) at a time, as plain CSS and on the stepped loop clock: compositor ticks, frames drawn, style recalcs and timers per second, plus process CPU with a socket |

Brain and services, no app needed (`scripts/perf/service/`, run from
`apps/ade-cli` with `npx tsx ../../scripts/perf/service/<name>.bench.mts`):
`file-index`, `registry-read`, `roster`, `rpc-read`, `shell-path`,
`search-fanout`, `chat-transcript`, `chat-backfill`, `spawn`, `conflict-sweep`
(the conflict predictor's sweep over scratch lane worktrees: git processes,
wall time and synced row changes), `db-reads <ade.db>` (the heaviest reads
on a copy of a project database), `tree-watcher` (plus `tree-watcher-parity.mts`, a
comparison and not a timing), `codex-app-server` (macOS: Codex app-server
memory and thread start, one process per chat vs one shared). They read temp
copies of state and never write to `~/.ade`.
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

### Looping animations (stepped loop clock)

Measured 2026-10-20 on this machine (240 Hz) with `loop-cost.mjs`, dev build
on top of `45458b44e`, two runs of 10 s each, App Control detached, DevTools
closed. Each case puts the app's own loop markup on the page with nothing else
moving; "Before" is the same markup as plain CSS in the same page (a finite
iteration count, which the clock never adopts), "Baseline" is with the clock.
CPU is % of one core.

| Loop on screen | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Top-bar activity pulse (4 steps in 3 s): compositor ticks / renderer / GPU | `loop-cost.mjs header-pulse` | 240/s; 4.7%; 3.1% | 1/s; 1.0-1.7%; 0.9-1.0% | 5/s; 3%; 2% |
| Thinking dots (3, staggered): renderer / GPU | `loop-cost.mjs dots` | 9.4-9.8%; 6.5-7.7% | 3.9-6.3%; 3.9-4.7% | 8%; 6% |
| `animate-pulse` dot: renderer / GPU | `loop-cost.mjs duty-pulse` | 5.8-6.1%; 2.7-4.1% | 2.8-3.7%; 1.4-2.5% | 5%; 3% |
| Work list "Working" label x3: renderer / GPU | `loop-cost.mjs breathe` | 5.4-6.8%; 4.1-5.3% | 3.4-4.2%; 3.1-4.2% | 6%; 5% |
| `animate-spin` on an SVG icon: style recalcs / renderer | `loop-cost.mjs svg-spinner` | 240/s; 14.3% | 73-75/s; 7.1-7.8% | 100/s; 10% |
| "Thinking" shimmer text: style recalcs / renderer | `loop-cost.mjs shimmer` | 240-250/s; 14.6-16.6% | 61/s; 7.0% | 100/s; 10% |
| Agent working (dots, pulse dot, Working label, top-bar pulse): compositor ticks / renderer / GPU | `loop-cost.mjs working-set` | 240/s; 7.2-8.5%; 6.4-7.4% | 41-47/s; 6.2% (one run 12.4%, machine noise); 6.6% | 60/s; 10%; 9% |
| Lanes working mark (60 steps/s, compositor): not adopted, unchanged | `loop-cost.mjs lane-spin` | 240/s; 7.6%; 8.8% | same | — |

Any running infinite CSS animation makes Chromium service every display
frame, whatever its `steps()` say: a compositor loop ticks the compositor and
the GPU process's display scheduler 240 times a second, a main-thread loop (an
animated SVG element, a `background-position` shimmer) restyles 240 times a
second. `lib/steppedLoopClock.ts` freezes each stepped loop that changes at
most 31 times a second (`playbackRate = 0`) and sets its time at its step
instants from one timer, so a frame happens only when a loop shows a new value.
Sampled every frame next to a plain-CSS twin, the clocked loops show the same
value on 98.5-100% of frames, never differing for more than 2 frames (8 ms).
A hidden window stops the clock (timers back to the app's own 5/s).
Faster compositor loops stay CSS: driving the 60 steps/s Lanes mark from a
timer cost the renderer more (4.3% → 8.3% in the prototype). At rest, with no
agent live, ADE runs no loops at all (0 ticks, renderer 0.2%, GPU 0.0-0.1%),
and a covered window draws nothing, so neither number moved.

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

### Terminals: output floods and switching (2026-10-20)

Same Mac Studio, dev build with its own socket, the ADE repository open, a
dozen chats in the Work list. Before is main at `45458b44e`; baseline is the
ademark-terminals branch. One terminal floods while the renderer calls
`sessions.get` again 100 ms after each reply (`terminal-flood.mjs`).

| Metric | Script | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| `seq 1 2000000` (16 MB): time to finish | `terminal-flood.mjs <lane> seq` | not done in 120 s | 6.3-11.2 s | 15 s |
| Same: brain CPU | same | 85-107 s (still going) | 4.6-7.1 s | 10 s |
| Same: `sessions.get` p50 / max | same | 4 ms / 30 s timeout | 2-4 ms / 2.2-6.4 s | 10 ms / 8 s |
| 200 MB colored `yes`: `sessions.get` p95 over the first 120 s | `terminal-flood.mjs <lane> yes` | 23.4 s | 3 ms-6.6 s | 8 s |
| Brain's longest single task during a flood | CPU profile through the brain's inspector | 809 ms | 342 ms | 500 ms |

Before, the brain re-copied a 2M-character live tail and re-ran the resume
scan on every PTY chunk, so one flooding terminal pinned it and every other
request (opening a terminal, a chat action) timed out.

Replies also share the brain-to-desktop socket with terminal output, and a
macOS unix socket moves 8 KB per round trip, so the brain queued the flood
(19-20 MB on `seq`, 66-67 MB on 200 MB `yes`, past the 64 MB point where it
drops a client) and replies waited behind it. Flow control (a later commit
on the same branch) pauses the flooding PTYs while the desktop is over 1 MB
behind. These rows were measured with an isolated dev brain (own `ADE_HOME`,
scratch project, sync off), before and after that commit:

| Metric | Script | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| `seq` 16 MB: time to finish | `terminal-flood.mjs <lane> seq` | 6.7-7.2 s | 6.6-9.4 s | 15 s |
| Same: brain reply p95 / max | same | 1.3-1.7 s / 2.1 s | 0.16-0.49 s / 0.6-2.1 s | 1 s / 3 s |
| Same: socket backlog peak (brain inspector, `writableLength`) | same | 19-20 MB | 1.2-1.3 MB | 4 MB |
| 200 MB `yes`: time to finish | `terminal-flood.mjs <lane> yes` | 16.0-17.6 s | 17.6 s | 25 s |
| Same: brain reply p95 / max | same | 3.1-3.6 s / 4.0 s | 61 ms / 321 ms | 1 s / 2 s |
| Same: socket backlog peak | same | 66-67 MB | 1.4 MB | 4 MB |
| Echo in a second terminal during the `seq` flood, median / max | a probe that types a marker and polls the live tail | - | 27-32 ms / 0.7-1.1 s | 100 ms / 2 s |

The window sizes were picked by measurement: 512K/128K left the socket idle
between pauses and slowed the flood 2-4x; 2M/512K doubled reply waits.

Terminal switching, 16 shells each holding 12,000 colored lines, every one
shown, then every one shown again, Work to Files to Work between
measurements (a dev-only probe read xterm's buffers):

| Metric | Before | Baseline |
|---|---:|---:|
| Copies of a terminal's history in its scrollback after two visits | 2-5 | 1 |
| xterm buffer lines across the 16 terminals | 103,398 | 32,528 |
| Renderer JS heap after the second pass | 133.9 MB | 126.5 MB |
| First reveal: text on screen, median / max | 172 / 243 ms | 175 / 267 ms |
| Revisit: text on screen, median / max | 23 / 43 ms | 26 / 59 ms |

PTY host processes (isolated dev brain, `footprint` of each `ptyHostWorker`
child of the brain):

| Metric | Before | Baseline | Ceiling |
|---|---:|---:|---:|
| PTY host memory with 8 terminals open | 8 hosts, ~144 MB (18 MB each) | 1 host, 18 MB | 40 MB |
| Echo in a terminal while another in the same host floods, median / max | 27-32 ms / 0.7-1.1 s (separate hosts) | 2 ms / 562 ms | 100 ms / 2 s |

WebGL contexts of parked terminals, measured directly with ADE's xterm and
WebGL addon in the dev renderer (8 terminals, 3,000 colored lines each). The
Work tab could not be driven: an isolated dev home stops at the sign-in gate.

| Metric | Value |
|---|---:|
| GPU process memory per WebGL context | 8-19 MB |
| Reveal with the context kept, median / max | 8 / 85-233 ms |
| Reveal with the context re-acquired, median / max | 12-14 / 28-67 ms, no long tasks |

So a terminal parked for 30 s gives its context back, and takes one again
when it is shown (about 5 ms more per reveal).

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

### Brain: memory a loaded brain keeps

Measured 2026-10-20 on this Mac (Node 26.3), lane `ademark-brain-memory`.
The installed brain logs its memory every five minutes as
`brain.memory_sample` (`rssBytes`, `heapUsedBytes`, `externalBytes`) in
`<ADE_HOME>/runtime/brain.jsonl`, `~/.ade/runtime/brain.jsonl` for the
installed app. That log is how the installed numbers below were read; nothing
attached to the installed brain.

The installed brain, for scale (41 registered projects, about 150 child
processes): 706 MB footprint after 9.5 h, peak 2,426 MB; `heapUsedBytes`
126 MB at start, climbing to about 480 MB by hour 9. About 580 MB of the
footprint is the V8 heap; native malloc is about 30 MB.

The dev brain rows run on a throwaway `ADE_HOME`, six throwaway projects, a
clean provider environment, an inspector on the dev brain only, and a forced
GC before each read. Load: 12 Claude Haiku chats (two turns each, large shell
output), a history read of each, 6 archived, then 11 idle minutes.

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Dev brain after the load and 11 idle minutes: heap used / footprint | `bench2.sh` style run: `cdp.mjs mem` and `footprint`, same load both sides | 115.1 MB / 245 MB | 101.9 MB / 209 MB | proposed, needs approval: 120 MB / 260 MB |
| Brain bundle source text held for the life of the process | heap snapshot, largest string | 44.0 MB (two bytes per character) | 22.0 MB (ASCII) | 23 MB |
| Chat event rings, one project: the 51 chats the installed brain served in its last 9.5 h, rebuilt from their real transcripts with the ring's caps (4,000 events, 4 M characters) | `ring-sim.mjs` (one-off, no bench file yet) | 98.5 MB, held until restart | 0 after 10 quiet minutes; 29 MB for the 23 chats active in the busiest 10 minutes measured | proposed, needs approval: 0 when every chat is quiet |
| Parsed transcript windows, one project (32 chats × 2 MB tail) | `tcache-sim.mjs` (one-off) | 47.4 MB, refilled every 10 min by the stale-run sweep | 0 when no history read in 10 min | proposed, needs approval: 0 when no reads |
| Slash-command discovery, retained per cached folder (this repository) | `disc-measure.ts` (one-off) | 1.36 MB | 0.12 MB | 0.25 MB |

Electron main's bundle had the same two-byte source: 18.7 M characters, 37 MB
held, about 19 MB as ASCII (`scripts/build/asciiBundleSource.ts` covers both
bundles). Not measured in a running app: the dev app was not launched for this
lane.

The event ring and the transcript windows were bounded by count per project
(64 and 32 chats), never by time, so a long-lived brain kept every recent
chat's history until it restarted, once per open project. A chat quiet for
10 minutes now gives both back; its transcript already holds every event, and
the idle release skips a chat whose transcript had a failed append (the count caps still apply).

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

## Mac Studio (M4 Max), Codex chats on one app-server

Same Mac Studio as above (Mac16,9, M4 Max, 36 GB, macOS 27.0), measured
2026-10-20 on the `ade/ademark-shared-codex` branch over main at `0d9211fd1`.
The dev brain ran on a throwaway `ADE_HOME` and a scratch project with sync
off; Codex 0.162.1, model `gpt-6-luna`. "Before" is the same build with
`ADE_CODEX_SHARED_APP_SERVER=0` (one app-server per chat, as on main). Main
itself, with 5 chats idle after one turn, ran 5 app-servers at 422 MB plus
43 MB of hosts.

### Codex chats: app-server processes

N Codex chats created with `ade chat create` and all mid-turn at the sample
(each runs `sleep 90` before printing its `ADE_CHAT_SESSION_ID`); physical
footprint (`footprint`) of the `codex app-server` processes under the brain
plus their `codex-code-mode-host` children. Every chat printed its own id.
Per-thread MCP servers (Lane H) and the `codex exec` side jobs (session titles)
are not in these numbers. Standalone: `scripts/perf/service/codex-app-server.bench.mts`
(no app, temp `CODEX_HOME`; `--turns` runs one short model turn per thread).

| Metric | Before | Baseline | Ceiling |
|---|---|---|---|
| 1 Codex chat | 125 MB, 1 process | 112 MB, 1 process | — |
| 5 Codex chats at once | 736 MB, 5 app-servers + 5 hosts | 240 MB, 1 app-server (168 MB on a rerun) | proposed, needs approval: 350 MB |
| 10 Codex chats at once | 1,745 MB, 10 app-servers + 4 hosts | 394 MB, 1 app-server + 2 hosts | proposed, needs approval: 600 MB |
| A later chat's thread ready (`thread/start` incl. process start), bench | 41 ms (new process); the first chat 375–484 ms | 7–8 ms | — |
| Input tokens, a new chat's first turn (`hi`), from Codex's own usage | 24,211 | 24,312 (no change: a new thread lists its skills either way) | — |
| Input tokens, a resumed chat's turn (`ok`) after Restart | 26,520 | 26,637 (+~110, unexplained) | — |

Crash check: `kill -9` of the shared app-server with 3 chats mid-turn; all
three reported `Codex app-server exited`, and each resumed its own thread on
one new process with its next message. A model and permission switch in one
chat, an approval, and an interrupt left the other chats on the process alone.
Some resumed turns waited 30–50 s for the model's first output in both
columns; that wait is not the app-server's.

## Mac Studio (M4 Max), PRs tab: GitHub requests (2026-10-26)

Dev app on its own socket, pointed at a throwaway shallow clone of
`pingdotgg/t3code` (1,400+ open PRs, so every list walk hits the 10-page
budget), warm project database. The app starts on Lanes, waits 25 s, then
opens `#/prs?pr=23706` (42 files, 28 commits, CI finished) and sits idle for
5 minutes. Every GitHub request the brain sends is logged by a temporary
trace in its request wrapper (not committed). Before is `a2659aa41`; after is
this branch's PRs speed commits; both runs on the same clone and database,
minutes apart. Not the baseline machine.

| Metric | Before | After | Ceiling |
|---|---|---|---|
| Opening the PR: GitHub requests in its first 60 s | 57 (29 per-commit check reads) | 22 (one GraphQL rollup for the commit checks) | not set yet; needs approval |
| Opening the PR: most requests in flight at once | 19 | 6 (the process-wide cap) | 6 |
| Opening the PR: time until the overview body shows | 1,118 ms | 710–896 ms | not set yet; needs approval |
| Launch to the PRs tab: PR-list pages read | 29 (three full walks) | 14 (one full walk, then one page per refresh) | not set yet; needs approval |
| Idle with the PR open: GitHub requests per hour | 1,680 (40+ list pages, 24 CI job reads and 12 `GET /user` per 5 min) | 600 (no list walks, no job reads, 4 `GET /user`) | not set yet; needs approval |
| Idle with the PR open: requests per hour that count against the rate limit (not `304`) | 540 | 144 (merge box and review threads GraphQL reused while the PR is quiet) | not set yet; needs approval |

The list rows paint from the local cache in 80–130 ms in both, so time to
rows did not move. Most idle requests are `304 Not Modified` answers, which
GitHub does not count against the rate limit. The tab still loads the first
PR's detail when it opens without a deep link: that PR is the one on screen,
so its reads are the point, not waste.

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

### Apple pane: iPhone Duo (2026-10-21)

Measured 2026-10-21 on this Mac Studio (M4 Max), dev build at `da37d1019` in an App
Control session (window covered, launched with
`--disable-backgrounding-occluded-windows`, so the renderer was not throttled),
throwaway project, one iPhone Duo simulator on iOS 27.1 showing a still screen,
an App Control DevTools window open, other agents running. `process-cpu.sh 20`
with the debugging port swapped and the sim helper added; two runs each. The
Apple pane had no row before; "Pane closed" is the comparison. Renderer RSS
includes this long session and swings 50-80 MB between runs.

| Metric | How | Pane closed | Duo, 3D | Duo, flat | Ceiling |
|---|---|---:|---:|---:|---:|
| Renderer CPU | `process-cpu.sh 20` | 3.0-3.2% | 3.3-3.4% | 2.5-2.6% | 25% |
| GPU process CPU | same | 7.8-7.9% | 7.9-8.3% | 7.2-7.3% | 10% |
| Sim helper CPU / RSS (capturing the live panel) | same | 1.7% / 60 MB (an orphaned capture, see below) | 1.9% / 70 MB | 1.7% / 60 MB | 3% / 120 MB |
| Electron main / brain CPU | same | 0.4-0.9% / 0.4-1.6% | 0.5% / 0.7-0.8% | 0.4-1.7% / 0.6-1.6% | 15% / 10% |
| Renderer JS heap after load | `performance.memory` | 243 MB | 253 MB | — | +40 MB over pane closed |

- Folding (six poses in 20 s, 3D): GPU 25.5%, renderer 13.3%, helper 12.4%
  for the sweep, back to the still-screen numbers once it settles. A fold
  sweeps the hinge in 10° steps and the 3D body redraws each one; it is
  user-driven, not idle.
- Nothing new polls: pose and panel changes arrive as helper events, the
  runtime list is read on open and refresh, and the Xcode feed once a day.
- The pane's own cost over the closed baseline is about 10 MB of JS heap
  (Apple's V68 model and three.js) and the helper's capture. The heap is over
  the 220 MB "any tab" ceiling with the pane closed too, in this long dev
  session; that is not this pane.
- A reload or a closed window used to leave the capture running with no
  viewer (the stop's 1 s grace timer died with the page); it now stops on
  `pagehide`. A renderer crash still leaves it to the next viewer's stop.

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

## Mac Studio (M4 Max): MCP server processes per chat (2026-10-20)

Mac16,9, M4 Max, 36 GB, macOS 27.0. A brain-only dev runtime
(`npm run dev:runtime`) on its own socket and its own `ADE_HOME`, `--no-sync`,
with only a throwaway git project registered and every `ADE_*`,
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` variable of the calling chat removed.
Codex read the real `~/.codex/config.toml` (Playwright via
`npx @playwright/mcp@latest`, `node_repl`, plus Codex's own plugin helpers);
Claude read a throwaway `CLAUDE_CONFIG_DIR` whose `.claude.json` held a
user-scope `npx @playwright/mcp@latest`, a local-scope
`npx -y xcodebuildmcp@latest mcp` and one server switched off for the folder.
Each chat was created with `ade chat create ... --prompt "Reply with exactly: ok"`;
footprint is `footprint -p` summed over every process under each chat's
runtime (`codex app-server` / `claude`), shells excluded, 45 s after the
last chat. Before is main at `0d9211fd1`, after is `338962c68`.

| Metric | How | Before | After | Ceiling |
|---|---|---|---|---|
| Codex chat: MCP processes from the user's config.toml, 5 chats | sum over the 5 runtimes | 30 processes, 1,598 MB (311–325 MB per chat; `npm exec` 181–192 MB of it) | 25 processes, 656 MB (125–136 MB per chat) | 160 MB per chat |
| Claude chat (account reading a `.claude.json`) with two `npx` servers | one runtime | 4 processes, 635 MB | 2 processes, 238 MB | 300 MB |
| One `npx @playwright/mcp@latest` server: spawn to `tools/list` answered | one-off stdio probe, 3 runs each | 1,261–1,809 ms, 2 processes, ~290 MB | 218–360 ms, 1 process, ~104 MB | 600 ms |
| Codex side job (`codex exec`, background utility such as a chat title): processes it starts | one-off sampler every 100 ms, 3 runs each | peak 5–6 (npm, Playwright, `node_repl`, plugin helpers) | peak 2–3 (Codex plugin helpers only) | 3 |

A server switched off for the folder stayed off. A Codex chat called
Playwright's `browser_navigate` through the direct launch and read the page
title back. Wall time of the side job was within noise (3.0–3.9 s against
3.3–4.3 s, one 47.8 s outlier on the old path).

## Mac Studio (M4 Max): Work with a side chat (2026-10-24)

Dev build on its own socket, sync off, a throwaway project, one Claude Haiku
chat, the Tools pane open, nothing streaming; `route-sweep.mjs none /work 12`,
two passes each. Not the baseline machine. "No side chat" is the same branch
with the feature idle, which is what `main` draws.

| Metric | No side chat | Side chat, tab closed (marks on the row and header) | Side chat tab open | Ceiling |
|---|---|---|---|---|
| Work idle: main-thread work | 0.6–2.5 ms/s | 0.6–2.1 ms/s | 0.5–2.5 ms/s | 30 ms/s |
| Work idle: renderer heap | 108–110 MB | 114–115 MB | 109–112 MB | 220 MB |
| Work idle: page elements | 628 | 642 | 823 | 3k |

Brain, `roster.bench.mts` on this machine's data (41 projects, 322 chats), two
runs each: `main`'s roster code cold 102–105 ms, warm 8.5–11.3 ms; this branch
cold 107–111 ms, warm 9.2–11.2 ms. The warm row's 10 ms ceiling was set with 11
projects and 23 chats; both builds now sit at it because of the data, not the
code. Not measured: Work while a chat streams with the side chat tab open.

## Mac Studio (M4 Max): subagents in the chat actions pane (2026-10-24)

Same machine as the ADE-175 pass. Before is main at `bb5087d1e` from a
temporary worktree; after is the `ade/mobile-settled-collapse-and-subagents`
branch. Each was a freshly launched dev app (own socket, sync off, CDP 9233)
driven through the same steps: the ADE repository, the Settled shelf open
(7 settled parents with 2 to 20 same-lane subagents), one parent chat open
with its actions pane showing. Two `route-sweep.mjs` runs and one
`render-count.mjs` window each. Other agents were running on the machine.

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Work: page elements | `route-sweep.mjs none /work 12` | 2,487 | 1,878-1,894 | 3k (Other tabs row) |
| Work: idle main-thread work | same | 0.6-5.0 ms/s | 0.9-5.1 ms/s | 30 ms/s |
| Work: renderer JS heap | same | 130-131 MB | 125-131 MB | 220 MB |
| Work: React commits while idle | `render-count.mjs 12` | 0.7-1.0/s | 0.8-1.0/s | no list or pane re-renders |
| Machine roster, warm (42 projects, 318 chats) | `roster.bench.mts`, two runs each | 15-47 ms | 10-15 ms | not set yet; needs approval |
| Machine roster, cold (same) | same | 184-204 ms | 129-133 ms | not set yet; needs approval |

The roster now also reads each chat's spawn kind and parent (from the sidecar
it already opened, or a tracked CLI row's `resume_metadata_json`); the
before/after gap is run-order noise, not a speedup.

## Linux lane screen on a 2-vCPU box (2026-10-25)

Not the macOS baseline machine: a boat.dev sandbox (Ubuntu 24.04, x86_64,
2 vCPU, 4 GB, no GPU), the helper from `native/ADEDesktopDriverLinux` built at
this branch, one lane screen at 1920x1080 with Google Chrome on a Wikipedia
article, nothing else running on that display. CPU is the sum of `utime+stime`
from `/proc` over the window, as % of one core; memory is PSS. Driven through
the helper's NDJSON wire (a Python harness on the box) for the stream and
recording rows, and through `ade screen` for the action rows. These are new
rows: the ceilings are proposals and need approval.

| Metric | How | Before (first build) | Baseline | Ceiling |
|---|---|---:|---:|---:|
| Empty lane screen (Xvfb + openbox), memory | PSS | — | 37 MB | proposed 80 MB |
| `ade screen start` | wall clock, CLI | — | 1.6 s | proposed 3 s |
| Observe, Chrome on Wikipedia (266–383 elements) | driver `observe` | — | 0.29–0.59 s | proposed 1.5 s |
| Live stream, still screen: helper + ffmpeg | 8 s window, one reader | — | 0.4–0.7% + 0.9–1.7% | proposed 3% |
| Live stream, scrolling (~23–26 fps delivered): helper | 10 s window | 18% (frames over the X socket) | 5.3% (MIT-SHM) | proposed 10% |
| Live stream, scrolling: ffmpeg (libx264 ultrafast) | same | 22% | 25% | proposed 40% |
| Frame capture, 1920x1080 | helper timing log | 11–18 ms (GetImage) | 2 ms (MIT-SHM) | proposed 5 ms |
| Recording while scrolling: ffmpeg | 10 s window, 30 fps MP4 | 44% (superfast) | 35% (ultrafast) | proposed 50% |
| Chrome launched by `ade screen open`, scrolling | 10 s window, stream reader attached | 132% (SwiftShader compositing) | 28–34% (`--disable-gpu-compositing`) | proposed 60% |

Chrome is still the largest cost on such a box (~710 MB PSS for one tab).
Before, it composited every frame through SwiftShader, a software GL, at
115–165% of a core; the helper now launches Chromium and Electron apps with
software compositing, which draws the same pixels for about a quarter of the
CPU at the same delivered frame rate (25 fps), and WebGL still works. Over the ADE account relay from a Mac, the
desktop app pinned to the box decoded 38 H.264 frames in a 9 s scroll window
at ~0.8 Mb/s.

## Mac Studio (M4 Max): brain, git and database (2026-10-26)

Lane `perf-p4-brain-git`. Before is `e2f42f44c`; baseline is this branch.
Not the baseline machine: a Mac Studio with only Apple's git (`/usr/bin/git`,
Git 2.54.0 Apple Git-157), load average 17-30 from other agents throughout,
so every pair was run interleaved (before, after, before, after) and each
cell is the range over the runs. Service benches run from `apps/ade-cli`
with `npx tsx ../../scripts/perf/service/<name>`; the repository rows use a
clone of this repository (7,800 files).

| Metric | How | Before | Baseline | Ceiling |
|---|---|---:|---:|---:|
| One git process through `runGit` (`rev-parse HEAD`, median of 200), macOS with only Apple's git | `spawn.bench.mts` (runGit row; `ADE_GIT_EXECUTABLE=/usr/bin/git` for before) | 9.5-11.7 ms | 4.2-6.0 ms | 8 ms |
| Lane status read on a just-created lane (`status --porcelain=v2 --branch`, each of 5 reads) | `runGit` after `worktree add` on the clone | 1,202-1,288 ms | 26-40 ms | 100 ms |
| Conflict sweep (`runPrediction({})`, 8 lanes) with no commit since the last sweep: git processes / wall / synced row changes | `conflict-sweep.bench.mts 8` | 169 / 917-1,006 ms / 72 | 25 / 40-42 ms / 0 | 40 / 150 ms / 0 |
| Same, after one lane commits | same | 169 / 919 ms / 72 | 57 / 251 ms / 16 | 80 / 500 ms / 20 |
| Turn-end change capture on a lane with 300 edited and 3,000 new files (median of 5) | `collectTurnDiffSummary`, one-off loop on the clone | 211-228 ms, 4 git processes | 129-133 ms, 3 | 200 ms |
| Terminal snapshot, one busy 160×48 terminal with 2,000 colored lines: serialize + JSON / file write (every 5 s while output flows) | one-off loop over `@xterm/headless` + `addon-serialize` | 9.5 ms (max 18) / 0.3 ms | unchanged | 30 ms |

A dev brain end to end: an isolated brain (own `ADE_HOME` and socket,
`--no-sync`, `spawn-trace.cjs` and `loop-delay-trace.cjs` loaded) on a
scratch clone of this repository with 6 new lanes and one shell printing
`date; ls -la` every 0.2 s, while a CLI asks for the lane list every 3 s for
3 minutes (an open Lanes tab's pattern). Two interleaved runs per side, load
average 13-27; the brain's database versions are read from the scratch
project's cr-sqlite clock tables.

| Metric | Before | Baseline | Ceiling |
|---|---:|---:|---:|
| Child processes the brain started per lane-list request | 22.2 (both runs) | 14.0-14.1 | 18 |
| Same, per minute (the after runs answered 29% more requests in the window) | 255-259 | 210 | 260 |
| Git processes per lane status refresh | 7 | 4 | 5 |
| Project-icon worker processes (a node and a CLI process each) per minute | 23-24 | 0 | 2 |
| `ade lanes list` from a CLI, median | 1,577-1,592 ms | 767-850 ms | 1,200 ms |
| Synced database versions per second (one busy shell) | 1.85-1.86 | 0.94-0.96 | 1.2 |
| Brain event-loop delay, p99 (median 5 s window / worst window) | 12.9-13.7 / 15.6-16.2 ms | 13.1-13.4 / 18-39.5 ms | 50 ms / 100 ms |
| Brain event-loop delay, max | 92-109 ms | 79-107 ms | 250 ms |
| Brain CPU over the window | 3.7-3.9% | 4.0-4.3% (29% more requests) | 10% (Processes table) |

The icon workers: every `projects.list` (each CLI call, each desktop and
phone connect) resolved up to 24 project icons, each in a new node process
loading the whole CLI bundle. On this machine one took 775 ms, past its
750 ms budget, so it was killed every time: no icon was ever shown and every
list paid for another worker. The worker now finishes (up to 15 s) after the
caller stops waiting, and the brain keeps its answer while the same signature
the in-process resolver trusts still holds. The database versions were the
busy shell's row: every 0.9 s output tick wrote `last_output_at` and then the
preview with `last_output_at` again, two versions sent to every synced
device; a tick that writes a preview now writes once.

The racy-index row is git distrusting every file of a checkout written in the
same second as its index. ADE's reads never write the index back
(`GIT_OPTIONAL_LOCKS=0`), so before, every status and diff on a new lane
re-read all its files until the first `git add`. ADE now refreshes the index
once, just past that second (`refreshNewWorktreeIndexSoon`).

Project database reads, `db-reads.bench.mts` (new) on a copy of this
repository's own `ade.db` (74 MB, 640 PR snapshots holding 30 MB), median of
8 after a first run:

| Read | Default pragmas | 64 MB page cache + 256 MB mmap | mmap only | 16 MB cache |
|---|---:|---:|---:|---:|
| Usage stats, all time (Stats page) | 28.6-49.8 ms | 29.7-30.7 ms | 27.1-27.6 ms | 28.5-29.8 ms |
| Every PR snapshot (the PRs tab reads a bounded set) | 65-83 ms | 28-31 ms | 66-68 ms | 66-69 ms |
| History, newest 500 operations | 0.5 ms | 0.5 ms | 0.5 ms | 0.5 ms |
| Conflict matrix rows | 0.3-0.4 ms | 0.3 ms | 0.3 ms | 0.3-0.4 ms |
| A phone's first sync export, 5,000 changes | 124-147 ms | 120-130 ms | 122-123 ms | 113-118 ms |
| `openKvDb` on the copy (migrations included) | 417 ms | - | - | - |

No pragma change shipped: only a cache big enough to hold the whole PR table
helped, on a read no surface makes, and a page cache is per connection, so it
would be paid once per open project in a brain that opens dozens. Moving reads
to a read-only worker connection (measured with a one-off probe on the same
copy) took the main-thread block of every-PR-snapshot from 75 ms (459 ms cold)
to 1-2 ms and of 7,800 history rows from 16-69 ms to 1-3 ms, but the longest
real read, the sync export, needs cr-sqlite's virtual table, which a plain
read-only connection does not have.

Brain event loop with sync ON, idle: P0's isolated measurement brain
(`scripts/perf/net/measure-brain.mjs` on lane `perf-p0-scoreboard`: fake
`HOME`, loopback, guard preload) on its seeded 1,000-chat project, 5 idle
minutes after the project is added, `loop-delay-trace.cjs` loaded (its
`gapMaxMs` is the longest a 50 ms timer fired late; the delay histogram alone
reported 23 ms for some of these 2 s blocks). Two interleaved runs per side.

| Metric | Before | Baseline | Ceiling |
|---|---:|---:|---:|
| Brain event-loop max, idle, sync ON | 2,048-2,052 ms | 22-40 ms | 250 ms |
| Freezes of 100 ms or more in 5 idle minutes | 8-9 (every ~32 s) | 0 | 1 |
| Brain watchdog `event_loop_near_miss` lines in that window | 9 | 0 | 0 |
| Brain event-loop p99, median 5 s window | 13.2 ms | 13.1 ms | 50 ms |

The freeze was the account lease refresh (every ~32 s) reading the encrypted
credential store, whose synchronous read asked the macOS keychain for key
material every time its 30 s miss backoff ran out: `security
find-generic-password`, then `add-generic-password` killed at its 2 s
timeout, then `find` again, on the main thread. Wherever the keychain cannot
answer (the measurement brain's fake home has none; a locked or unreachable
keychain does the same) that is 2 s every cycle. Stores are sealed with the
machine key alone now, so a read asks the keychain only when the machine key
does not open the store.

Phone reconnect's lane refresh: `lanes.refreshSnapshots` with the phone's
iOS arguments and its last signature (so every answer is `notModified`), 10
timed calls on LAN after a reconnect, P0's measurement brain on the seeded
project (20 lanes, 1,000 chats), two interleaved runs per side, load 10-11.

| Metric | Before | Baseline | Ceiling |
|---|---:|---:|---:|
| `lanes.refreshSnapshots`, not modified, median per call | 161.5-165 ms | 90.5-93.5 ms | 130 ms |
| Git processes per call | 54.9 | 15.8 | 25 |

Per lane, a refresh re-ran five git processes whose answers cannot change
without their input changing: HEAD's commit date (now keyed by the commit
the status names), ahead/behind (keyed by the two commits), the worktree
root (keyed by the folder's and its `.git` entry's identity), and the
conflict check (`ls-files -u`, keyed by the index file's identity). Only
`git status` runs every time, so edits, commits and base moves show at once.
SQLite statements are now compiled once per connection and reused; before,
compiling them was the largest single cost on the brain's main thread during
these calls (628 ms of a 40 s profile). The rest is the chat list the
snapshot builds (per-row lookups in `agentChatService.listSessions`, chat
state files) and the 500-row session list: about 44 ms of main-thread time
per call.

Chat and session lists (`b109c1239`): `scripts/perf/service/session-list.bench.mts`
(the real chat service over 617 chat metadata files, 8.1 MB), five interleaved
runs per side against `66d671759`, load 30-104, the fixture's files left 2.5 s
to settle first so both sides read them from the state-file cache. (Without
the pause the faster build finishes inside the cache's 2 s settle window and
reads every file again; that is the bench, not the brain.)

| `sessions.list` (median of 7 per run; range of 5 runs) | Before | Baseline | Ceiling |
|---|---:|---:|---:|
| 500-row window | 75-84 ms | 19-28 ms | 40 ms |
| One lane, 200 rows | 33-46 ms | 9-11 ms | 20 ms |
| Every row (764) | 105-141 ms | 28-39 ms | 60 ms |

Within one listing each row's Claude resume pointer, parent chat and move
record are read once (not once or twice per row), a non-running OpenCode
chat's `/compact` check walks the prompt folders once per listing instead of
once per row, the chat tool types come from one statement instead of one query
per type, and a row whose columns are unchanged reuses its mapped form.

Phone reconnect's lane refresh on the owner's real project: a clone of P0's
golden copy (47 active lanes, 46 worktrees of the 7,600-file repo, 78 M db
versions), P0's sync-ON measurement brain, a reconnect then 5 not-modified
`lanes.refreshSnapshots` and 5 refresh + `work.listSessions` pairs on LAN,
five interleaved runs per side (`main` e2f42f44c vs `744f102c3`), load 11-77.

| Real load, 47 lanes | Before (`main`) | Baseline | Ceiling |
|---|---:|---:|---:|
| Not-modified lane refresh, median of the 5 run medians | 1,975 ms (runs 1,901-2,399) | 1,579 ms (runs 1,515-1,766) | 2,000 ms |
| Slowest single refresh in 25 | 4,759 ms | 2,472 ms | 3,000 ms |
| Git processes per measured window | ~5,000 | ~1,100 | 1,500 |

What is left is `git status` itself: ~50 ms per real worktree (33 ms for the
tracked files, ~20 ms for the untracked walk), so 46 lanes are ~1.5 s of git
whatever the order. The untracked cache and the fsmonitor daemon do not help
while ADE reads with `GIT_OPTIONAL_LOCKS=0` (41-58 ms per status with the
daemon). The conflict and rebase summaries now reuse the HEAD each lane's
status printed, behind counts are kept per commit pair, and the search index
lists the lanes once per pass instead of once per lane.

Brain event loop under real load while a phone connects, measured by P0
(`perf_hooks.monitorEventLoopDelay` inside the brain, 5 s windows, golden
clones of the owner's ADE project, machine load 30-50): windows holding a real
main-thread block over 1 s.

| Real load, phone connecting | Before (`main`) | Baseline (`744f102c3`) | Ceiling |
|---|---:|---:|---:|
| Windows with a block > 1 s | 51 of 352 (25 of 169 on a rerun) | 1 of 295 | 1% of windows |
| Longest block | 3.1 s | 1.1 s | 1.5 s |

The ~2 s blocks every ~30 s on `main` are the keychain read (`0224073ec`)
and synchronous shell probes that never cached a failure (`744f102c3`).

The first lane refresh after a brain starts is slower than the warm one
above (Work usable 2.2-2.7 s): each lane also fills its one-time caches (the
HEAD date, the index path, the conflict check, behind counts), 288 processes
on 47 lanes. The index path now comes from the worktree's `.git` file
(`ff8d90ce2`), 49 fewer.

Lane refresh answered from each lane's last status (`93ccf2adb`, the
owner-approved option): same real-load clone and brain, the phone asks with
the status allowed to be up to 5 minutes old, the brain answers from each
lane's last check and re-checks git behind it. The follow-up waits for that
re-check. Five interleaved runs per side, 5 refreshes each, load 12-62.

| Real load, 47 lanes | Exact status | Baseline (last status) | Ceiling |
|---|---:|---:|---:|
| First answer, median of the 5 run medians | 1,753 ms (runs 1,600-1,871) | 45 ms (runs 44-126) | 300 ms |
| Slowest first answer in 25 | 3,008 ms | 300 ms (load 62) | 1,000 ms |
| Background re-check, median | n/a | 1,700 ms (one 7.7 s at load 62) | 3,000 ms |

Only the dirty/ahead/behind numbers can be old; lane names, archive state,
parents and deleted lanes are read live. Without the option (desktop, older
phones) the answer is the exact one.

Credential reads while another ADE process holds the store lock
(`scripts/perf/service/credential-lock.bench.mts`: a second process holds
the lock 3 s, a cold store reads one key with `getSync`, as the brain does
on its event loop for the account lease, Linear and session reads), 3 runs:

| Metric | Before | Baseline (`09e100e94`) | Ceiling |
|---|---:|---:|---:|
| Brain event loop blocked by one read | 3,004-3,011 ms (up to the 15 s lock timeout) | 0 ms | 50 ms |

The owner's installed brain logged an 11.1 s freeze at idle with 123 ms of
CPU and no page faults: a sleeping wait, which is what this lock wait is
(25 ms sleeps until the holder, often an `ade` CLI call, lets go).
