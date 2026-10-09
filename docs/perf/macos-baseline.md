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
- **Typing:** each keystroke still re-renders the whole chat pane.

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
| `typing.mjs <keys>` | Types into the composer; keystroke events slower than 16 ms |
| `keystroke-trace.mjs <keys>` | Renderer work per keystroke, split into style, layout, paint and script |
| `cdp.mjs eval\|metrics\|profile\|shot\|anim` | One-off probes: evaluate, metrics delta, CPU profile with top functions, screenshot, running animations |

Brain and services, no app needed (`scripts/perf/service/`, run from
`apps/ade-cli` with `npx tsx ../../scripts/perf/service/<name>.bench.mts`):
`file-index`, `registry-read`, `roster`, `rpc-read`, `shell-path`. They read
temp copies of state and never write to `~/.ade`.

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
