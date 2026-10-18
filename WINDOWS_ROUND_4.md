# ADE round 4: Windows. Handoff to the coordinator on the Windows PC

You are the **coordinator** of round 4 of an ongoing performance and bug-fix pass on ADE (GitHub `arul28/ADE`). This round runs **on the user's Windows PC**, because everything left from the earlier rounds needs a real Windows machine. The two Mac coordinators that ran rounds 1–3 had none: they wrote Windows code they could not run, and the user says that code "just breaks randomly".

This file is your whole brief. It lives on the branch `handoff/windows-round-4` and is never merged. The user will delete the branch when you finish. Read all of it before doing anything, then read the in-repo docs listed in section 9.

Your round has three goals, in this order:
1. **Make ADE on Windows work properly.** Find every feature that is broken, missing, or never ran on Windows, and fix it. Prove each fix in the real Windows app.
2. **Make ADE on Windows fast.** The user calls it "kinda slow and clunky". Measure it, find out why, and fix the biggest costs with proven before/after numbers.
3. **Remove the Windows beta notice**, but only once you can honestly say Windows is as smooth as macOS (section 0 defines what that means). That PR is your last one.

Along the way, close the Windows-only items earlier rounds left open (section 6) and the cross-platform items in section 7.

---

## 0. Finish line

This is one round with an end, not an open loop. You decide when Windows is ready, and the user trusts you to be honest about it. **Validate everything yourself.** The user was angry when PR bodies listed long "Not checked" sections. Unless something is truly blocked on the user, you check it.

**The round is DONE when all of these are true:**
1. **Inventory exists.** There is a written inventory of Windows gaps (section 5, phase 1), each marked fixed / accepted-by-design / blocked. "Accepted by design" is only for OS limits already documented in `docs/development/windows-support.md`, such as no iOS Simulator. Anything else is a bug.
2. **Every gap you can fix is fixed and merged**, and each was verified in the real Windows app, broken before and fixed after.
3. **Windows meets the same perf ceilings as macOS** (section 4), measured in the real installed Windows app on a quiet machine. Each interaction is either under its limit or fixed until it is. If something can't get there for an OS reason, write down the measured reason. Don't wave it off.
4. **The Windows-only leftovers in section 6 are done**, or blocked with a reason.
5. **The beta notice PR is merged.**
   - Remove `WindowsBetaNoticeModal` and its host in `App.tsx`.
   - Remove every surface that opens or mentions it: `git grep -n -i -E "windows ?beta|requestWindowsBetaNotice|WindowsBetaNotice"`. That includes the ChannelBadge re-open affordance, any Settings/About row and the browserMock preview hooks.
   - Update the related copy and docs: `docs/development/windows-support.md` says "shipped as a public beta".
   - Keep `isWindowsPlatform` if other code uses it. Merge it only when 1–4 and 6 are true **and** you have done a final full manual pass of every surface in section 5 phase 1 on the installed build of `main`, with nothing broken. If any doubt remains, don't remove it; report what still fails.
6. **A Windows perf baseline is committed:** `docs/perf/windows-baseline.md`, in the same shape as `docs/perf/macos-baseline.md`, which says "A Windows or Linux baseline goes in its own file". That way future Mac-written changes have Windows numbers to stay under.
7. **`main` CI is green** and nothing you started is half-done: no open PRs from this round, no stray worktrees or processes, scratch lanes and chats deleted.

**Then STOP and hand back** with:
- a Windows before/after table: the release you started from vs `main`, same metrics as section 4, on the installed app;
- the gap inventory with its final state;
- what's blocked and why;
- a short ranked list for the next round.

Don't release (the user runs `/release`), and don't start another round.

**Stop and report early only if:**
- the same fix fails review or CI 3 times;
- the machine keeps running out of memory even after you cut parallelism;
- you hit something only the user can decide (ask once, clearly).

---

## 1. Who the user is and their standing rules

The user builds ADE and uses it all day across three machines:
- a **MacBook Pro**, where rounds 1–3 ran;
- a **Mac Studio**, which runs real work;
- this **Windows PC**, which shows up as `windows` in ADE's Connections panel.

They want the WHOLE app to feel native-fast under real load (several machines connected, many projects, many agents streaming), with **zero functional, UX or visual regression**.

**Rules they have stated, all binding:**
- **Never make data arrive later.** An optimization that delays an update, or makes the UI feel behind, is a bug, even if it saves CPU.
- **Validate, don't list "Not checked".** Every claim in a PR is checked by you or a reviewer before merge. A "Not checked" item is allowed only when it is truly blocked (say by what), never because checking was inconvenient.
- **No test bloat.** AGENTS.md rule 13 is a hard rule: "New tests are the exception… A new test must guard a critical contract (data loss or corruption, security or privacy, a race or process/lifecycle seam, a cross-machine, IPC or sync contract a caller depends on), and no existing test may already catch its failure. UI layout, copy, wiring, render-only checks, and one past bug instance do not qualify."
  - The user deleted 63,000 lines of tests in PR #1689 on 2026-10-16. Round 3 then added +4,695 net test lines against +2,846 lines of real code, because its briefs demanded "a test that fails on main" for every fix. The user called this out, and round 4 opened a PR to trim them (section 3).
  - **Don't repeat it.** Proof means the real app on this PC, before and after, not a new unit test. Tell every worker this explicitly.
- **Bugs are a separate track from perf.** Bug fixes need a real-app repro: broken before, fixed after, with a screenshot or CDP log. Perf fixes need the merge gate (section 2).
- **Releases are the user's.** Merge freely; never run `/release`.
- **One concern per PR.** No drive-by refactors.
- **Never ask for secrets in chat.** If you need a token, use T3's `request_secret`.
- **Windows parity was already the repo default** ("Windows is part of done, not a follow-up"). The Mac rounds couldn't honor it. You can.
- **The hosted web client** (app.ade-app.dev, `apps/desktop/src/renderer/webclient`) runs the same renderer. Don't break it; mention it in each PR's Platforms section when a change touches shared renderer code.

**Machine boundaries:**
- **This Windows PC is yours.** The user said you may stop, break, reinstall and restart ADE and its brain here as long as you **recover it to a clean, working, signed-in state** at the end. Same version channel, projects reopened, connections to the Mac Studio and MacBook working. Before you break anything, write down exactly what is installed and running (version, channel, brain service state, open projects) so you can restore it.
- **The Mac Studio is off limits.** It runs the user's real work. You may connect to it from ADE and read through that connection: view lanes and chats, list artifacts, read through ADE's own UI and IPC. Never:
  - halt, restart, stop or reconfigure its brain;
  - run `ade` writes against it, or `launchctl`;
  - kill processes on it;
  - push a different version onto it.
- **The MacBook is not yours from here.** Don't connect to it to change anything.
- **Never touch the user's real work:** their lanes, chats, branches, drafts. Prefix everything you create (e.g. `perf-r4w-…`, `r4w`), and delete it when done, including remote branches.
- **Don't send prompts into the user's real chats.** A message sent to another ADE chat (`ade chat send …`, or typing in the UI) IS a prompt; its agent will act on it. A round-2 coordinator sent a "report" that ended with a build command, and the Studio agent started a TestFlight build nobody wanted. If you ever must message another chat, open with "Report only — no action needed, don't run anything", and include no commands or to-do phrasing.
- **One ADE connection per computer at a time.** If a dev app here connects to the Mac Studio, it takes the connection "lease" from the installed app. The installed app then shows the Studio as `error: Another ADE on this computer is using the connection` and an empty Work list. Click **Connect** in the installed app's Connections panel to take it back. Do this when you're done with a dev app.
- **The user may use ADE on this PC while you work.** If they say they need it, pause, let them, and resume. Re-take the connection lease afterwards (above).

---

## 2. MERGE GATE: non-negotiable for every PR

The code is delicate, and one bad merge can undo the whole pass. When in doubt, don't merge; a parked PR costs nothing.

**Every perf PR must:**
1. **Be small and single-purpose:** one change, one metric. Multi-step work is a series of PRs, each with its own proven win.
2. **Name the metric before any code is written:** what is measured, which instrument (exact script and command), the scenario, and the baseline number. Put this in the brief and the PR body.
3. **Show before and after** from the same instrument, same machine, back to back, on a **quiet machine** (no typechecks, builds or installs running; check CPU load). Use the median and spread of ≥3 runs. The win has to clearly exceed run-to-run noise; a delta inside the noise is "no win".
4. **Prove nothing got worse:**
   - output parity, or a clear argument why the output can't change;
   - no later-arriving data (measure update latency if timing, polling, caching or events are touched);
   - neighbouring metrics re-run;
   - a real-app check for anything user-visible.
5. **Be independently re-run before merge:** you or a reviewer who didn't write it re-runs the measurement from the PR body's command and gets a matching result.

**Bug-fix PRs** don't need a speed number. They need a before/after repro in the real Windows app, and must not regress any perf metric they touch. Say "correctness fix, no perf claim".

**PR bodies** have these sections:
- **Why**
- **What changed**
- **Evidence:** exact commands and numbers, screenshots, CDP logs.
- **Platforms:** Windows / macOS / Linux / hosted web / iOS, saying what was verified where. A change in shared code must say how macOS is unaffected: an argument, or "CI covers X", or "needs a Mac check: <exact steps>".
- **Not checked:** only what is truly blocked.

End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Commits end with the `Co-Authored-By` line your environment gives you. Overclaiming in PR bodies was the #1 problem a round-1 audit found. Be literal.

**Merge:** `gh pr merge <N> --admin --squash --match-head-commit <FULL 40-char sha>`. `--admin` is needed because the author owns CODEOWNERS; the user authorized the bypass. A short SHA is rejected. After merging, confirm `main` CI is green.

**CI notes:**
- The GitHub API is rate-limited across all agents: no `gh pr checks --watch`; poll at most every 2 minutes.
- A Vercel "rate limited" failure is infra.
- PR #1689 made the slow, flaky `windows-foundation` CI job opt-in on PRs: it runs on main pushes, dispatch, and PRs labelled `windows`. Add the `windows` label to PRs that touch Windows-only code (PowerShell, services, named pipes, process kill), so that job runs on a real Windows runner. Don't propose a big Windows test job; the user removed that on purpose.
- Read bot review comments once CI settles; fix valid ones, at most 2 rounds.
- **The GitHub Actions cache can be over its 10 GB limit.** It was 11.7 GB on 2026-10-18, mostly 2 GB `nm-v3-*` node_modules caches from many PRs plus Dependabot. A PR's cache can then be evicted between the `install` job and the jobs that restore it, so nearly every job fails with "Cannot find module typescript/eslint/@types/node". That's infrastructure, not your code. Re-run the WHOLE workflow (`gh run rerun <id>`, not `--failed`) so install rebuilds and saves the cache right before the other jobs. Tell the user if it keeps happening; the Dependabot PRs are their call.

---

## 3. What already happened (rounds 1–4 on the Mac)

### Rounds 1–2: the first coordinator, 2026-10-16
- Shipped 33+ PRs and released v1.2.109.
- Headline: longest real chat open 1174 → 94 ms; 5-chat mean 259 → 36 ms.
- Two big lessons:
  - **Bench numbers taken under load were inflated about 10×**, so measure only on a quiet machine.
  - **About 15 parallel typechecks thrashed an 18 GB Mac to death**, taking every agent with it. Hence the serial limiter (section 8).
- An audit of round-1 PRs found overclaims and several follow-ups. Most were fixed in round 3.

### Round 3: my round (the MacBook coordinator), 2026-10-17 → 18
**Released in v1.2.109–v1.2.111.**

User bugs fixed:
- #1725 settings/sidebar dead end
- #1724 remote lane delete shows progress
- #1742 + #1750 the Tools pane no longer reopens while a remote shell streams

Sync:
- #1730 a non-host never claims the cluster
- #1735 serve keeps the live host
- #1736 sync status waits for first readiness
- #1738 Start sync gives an honest deadline
- #1739 a machine row says why it isn't auto-connecting
- #1751 an unscoped disconnect is refused
- #1757 a real "Stop following <machine>" button
- #1764 legacy drafts scoped per project
- #1766 a viewer never dials loopback for a remote brain with no address

Perf:
- #1737 slash-command discovery no longer blocks the brain (11.1 → 1.9 ms)
- #1743 desktop main compile cache (window 1097 → 945 ms)
- #1744 brain compile cache (brain start 2723 → 2523 ms)
- #1748 prunes old compile caches
- #1754 summarizes only the chats a list shows
- #1761 the Files list mounts only visible rows
- #1762 the Lanes revisit paints the last Branch diff/History instantly
- #1767 a chat warm-switch keeps the transcript (no re-paging, no flicker)

Windows written blind:
- #1755 cooperative sync-host takeover (RPC shutdown before `taskkill`)
- #1758 Windows status timeouts 45/50 s
- #1759 a second launch that loses the single-instance lock exits

Hosted web:
- #1771 menus and submenus sit beside their row at web zoom
- #1772 512 KB history pages
- #1773 cited proofs load instead of reading "missing"

Other:
- #1749 the settle metric
- #1765 CTO identity chats
- #1752 path-refusal text doesn't leak existence

**Parked or closed with evidence:**
- #1747: main already coalesces.
- #1753, #1756, #1763.
- #1760: Windows install sweep. Three high review findings; needs real Windows. See section 6.
- #1768/#1769: Lanes caches; no live win.
- #1770: optimistic new chat; no live win, plus a duplicate-send risk.
- #1729, #1731, #1732, #1734, #1740, #1741: see the log if you need them.

### Round 4 today (2026-10-18, MacBook coordinator)
- **#1777 `fix(work): a chat launched onto another machine stays on screen while that machine lists it`.** The user reported that launching a new-lane chat onto another machine showed the setup card, then the chat vanished and an OLD chat showed for ~5 s, then it came back.
  - Real-app repro: gaps of 2.9 s, 9.5 s and 5.6 s on main; 0/3 with the fix (Mac dev app ↔ Mac Studio, 50 ms DOM sampler).
  - Cause: the placeholder row was dropped when the agent started, the other machine's list only refreshes every 10 s, and `WorkViewArea.tsx` fell back to `visibleSessions[0]`.
  - Merged as `8be0b3f`; see section 10.
- **#1778 test trim:** removes the round-3 tests that guard no critical contract (−4,122 net). See section 10.

### What the user actually feels (read this twice)
The user said the latest release didn't feel much faster. "If anything switching project tabs feels slower, like the chats load in pretty slow, but it did before too, not always but sometimes." The perf wins were small (10–30% off things already at 150–300 ms) and add up, but they aren't felt. The one thing the user did notice is lower CPU and memory use.

**The lesson for you:** chase what the user FEELS. That means intermittent multi-second stalls, things that vanish and come back, "loading…" that lingers, jank while agents stream. Shaving 20 ms off a 200 ms path the user doesn't notice is not the goal. On Windows, start by using the app like the user does and writing down every moment that feels slow or wrong, with a timestamp. Then measure those.

### The architecture fact behind most "sometimes slow" reports
- A project is a git repo. Each machine has its own checkout, run by its own brain. ADE joins checkouts across machines by normalized git origin URL.
- A project **tab** is attached to one checkout, its *binding*: `local`, or `remote` (another machine's checkout, used when this machine has no clone).
- The Work view shows the union of every connected machine's checkout. But **only the bound machine's chats update live. Every other machine is polled**:
  - its sessions every `FOREIGN_MACHINE_REFRESH_MS` = 10 s;
  - its lanes every `FOREIGN_LANE_REFRESH_MS` = 30 s;
  - both in `apps/desktop/src/renderer/state/crossMachineLanes.ts`.
- So chats on "other" machines are second-class: status, titles and new chats lag by up to 10–30 s, and fixes like #1777 only patch single symptoms.
- The user's mental model ("a project is a repo with machines connected to it, all equal") is right. The code isn't there yet. **Making every connected machine's chats and lanes live (push/subscribe instead of poll) is the top cross-platform item** (section 7, item 1). Windows is a connected machine too, so it matters to you directly.

---

## 4. Perf ceilings and what to measure on Windows

Ceilings come from `docs/perf/macos-baseline.md`:
- tab settle ≤ 250 ms;
- no long task > 100 ms;
- chat switch content ≤ 250 ms;
- new chat on a remote lane: first row ≤ 150 ms.

Use the same ceilings on Windows. That's what "as smooth as macOS" means.

Measure these on the **installed** Windows app (Tier 1) before changing anything, and keep the table:

| # | Interaction | macOS reference (installed 1.2.110/111) |
|---|---|---|
| 1 | Cold start: launch → first window → Work content | window ~945 ms (desktop main) |
| 2 | Brain cold start: service start → ready | 2,523 ms |
| 3 | Tab settle, warm: /work /lanes /prs /files /settings /history | /work 58, /lanes 223–238 content, /prs 150, /files 46, /settings 79, /history 47 |
| 4 | Project-tab switch (2–3 projects open) → chats visible | 169–227 ms |
| 5 | Chat switch, long chats (local and on the Mac Studio) | warm 188–306 ms, cold first open ~330 ms |
| 6 | New chat on a lane (local; and launched onto the Mac Studio) | first row 120–175 ms |
| 7 | Keystroke → paint in a long chat composer | (measure) |
| 8 | Idle CPU and memory: brain, main, renderer, GPU (DevTools closed) | brain 2.4%, main 1.1%, renderer 0.2%, GPU 0% |
| 9 | Streaming: CPU and jank while 2–3 agents stream | (measure) |
| 10 | Update install + relaunch time (NSIS) | "minutes" per windows-support.md vs <10 s on macOS |
| 11 | Terminal/PTY: open a shell, first prompt; output throughput | (measure) |

**Windows suspects to check, not assume:**
- process spawn cost: `git.exe`, `powershell.exe`; every PowerShell spawn is ~200–500 ms;
- synchronous PowerShell queries (`Get-NetTCPConnection`, `Get-CimInstance`) on hot paths;
- Defender real-time scanning of worktrees and node_modules;
- file watching (ReadDirectoryChangesW) on large trees;
- named-pipe RPC latency;
- ConPTY;
- the GPU/compositor path;
- font rendering;
- window-chrome resize jank;
- long sync IPC on the main thread;
- the scheduled-task brain supervisor;
- NSIS install steps.

Profile (CDP `Profiler.start/stop`, `process-cpu.mjs`, Windows Performance Recorder / `wpr` if needed) before deciding where the time goes. Don't guess from code.

---

## 5. The Windows work: phases

### Phase 0: set up and baseline (first day)
1. **Record the starting state** so you can restore it:
   - ADE version and channel (Settings → About);
   - brain service state;
   - open projects;
   - connections (Mac Studio, MacBook);
   - where `~/.ade` is;
   - which repos are cloned on this PC.
2. Read the in-repo Windows docs (section 9), especially **"On Windows" in `docs/development/local-development.md`**. Highlights:
   - named pipes for `--socket`;
   - launch from PowerShell, not Git Bash, because MSYS rewrites pipe paths;
   - don't set `ADE_HOME`;
   - share `~/.ade` and isolate the pipe.
3. **Node 22** is required (`node:sqlite`). Check `node -v`.
4. Get CDP control of the **installed app**: quit it fully, then start it with `--remote-debugging-port=9222`. Check `windows-support.md` for how the packaged app is launched. Under T3, unset `ELECTRON_RUN_AS_NODE` first: T3 shells carry it, and it makes Electron run as plain Node. The packaged renderer uses **hash routes** (`#/work`). The perf scripts in `scripts/perf/ui/` take `CDP_TARGET_URL=index.html`.
5. Get a **dev app** working from your worktree (the "On Windows" recipe, its own pipe, CDP on another port).
6. Take the section 4 baseline on the installed app. Quiet machine, ≥3 runs each.

### Phase 1: inventory of what's broken or missing on Windows
Build `r4w-inventory.md`; keep it in your worktree and outside the PR set. Sources:
- **Use every surface as a user would, on the installed app**, connected to the Mac Studio, with at least 2 local projects open. Surfaces:
  - Work: list, kanban, focus grid, filters, snooze, context menus and submenus;
  - chat: send, steer, queue, model picker, attachments and paste, images, @mentions, slash commands, proofs, handoff to another machine, launch onto another machine, subagents;
  - terminals and shells, CLI tools (Claude Code, Codex, OpenCode, Cursor, Copilot);
  - Lanes: create, delete, rebase, Branch diff, History, Files, templates;
  - Files: editor, search;
  - PRs, Automations, CTO, History, Issues/Linear/Jira;
  - Settings: every page, including This computer, Diagnostics and Account;
  - Connections and pairing: machines, phone, web;
  - Windows Desktop (lane screen), App Control, the built-in Browser, proof capture and recording;
  - notifications, deep links (`ade://`), tray/taskbar, keyboard shortcuts (Ctrl vs Cmd labels), window chrome, multi-window, project-tab drag;
  - updates (check, download, install, relaunch), uninstall/reinstall, `ade` CLI on PATH, the brain service across reboot and sign-out/in;
  - onboarding on a clean profile (you may create a throwaway Windows user if needed).
- **`docs/development/windows-support.md`**, the "What Windows gets instead" table. It says anything missing that is NOT in the table is a bug. Also re-check each "Degraded" row: is the degradation still necessary?
- **`WINDOWS_PORT.md`**, "Explicit follow-ups" and "Readiness and uncertainty".
- **The code:**
  - `git grep -n 'process.platform === "darwin"'` (about 55 sites in `apps/desktop/src`) and macOS-only branches: is there a Windows path, or is the feature silently absent?
  - POSIX-isms: `/bin/sh`, `bash -lc`, `lsof`, `ps`, `kill -0` semantics, `SIGTERM`, `chmod`, `/tmp`, `:` PATH separators, case-sensitive path compares, `\n` vs `\r\n`, symlinks.
  - `.agents/skills/quality/references/windows-quirks.md` lists the known failure classes and the canonical helper for each.
- **Sentry:** errors with `os: Windows` (the repo has Sentry wiring; check `docs/` for how the team reads it, and don't paste secrets).
- **Logs on this PC:** `~/.ade/runtime/brain.jsonl`, `desktop-main.jsonl`, per-project `.ade/…/main.jsonl`. Look for errors, timeouts and slow-call warnings over the last days of real use.

Rank the inventory: broken/missing first, then slow, then cosmetic.

### Phase 2: fix what's broken or missing (correctness PRs)
One concern per PR. Real-app repro before, real-app proof after, on this PC. For things that also exist on macOS, make sure the fix doesn't change macOS behavior, or say how it does and why that's right.

### Phase 3: make Windows fast (perf PRs, merge gate)
Take the worst rows of the section 4 table first, profile, fix, prove. Also look at what the user FEELS (section 3).

### Phase 4: Windows leftovers from the Mac rounds (section 6)

### Phase 5: cross-platform items (section 7), as far as you get

### Phase 6: the beta notice PR (section 0, item 5), then the final report

---

## 6. Windows-only leftovers from rounds 1–3 (each needs real Windows)

Read the details in the closed PRs and the code. Re-verify each against current `main` first: some may already be fixed or moot.

1. **#1760 Windows install sweep** (closed; branch `perf/win-install-sweep` kept on origin). It reworked how the installer stops a previous brain: cooperative RPC first, identity-checked `taskkill /T` using exact FILETIME, CIM re-read of cmdline/SID/parent while holding the handle. Luna's 5th review left 3 HIGH findings:
   - an unpinned supervisor kill;
   - an ignored orphan-stop failure;
   - the service left unregistered on failure;
   - plus a bare-pid kill.

   Rule from that review: **scan and identify everything before stopping anything; any failure aborts and leaves the existing service untouched.** It needs a real install, upgrade and uninstall run here, including a failure injected mid-way.
2. **Duplicate launch, option A.** #1759 made a lock-losing second launch exit (option B). Option A deferred: while an NSIS update relaunches the app, the new copy can start before the old one releases the single-instance lock, so it quits and the user ends up with no ADE. Design: an updater-identified, bounded retry (probe acquire, then `app.relaunch` on acquire; measured on Mac: acquire 2.8 s → child ready 167 ms). Electron 41.5 caveat: re-requesting the lock acquires, but `ready` never fires, so retry-then-boot inside one process is impossible. Prove it with a **real NSIS update** on this PC.
3. **#1671 status timeout chain on a cold start.** The overall cap included `connect()`, which can legitimately take ~30 s on a Windows cold start, plus an 8 s read. #1758 raised the Windows caps to 45/50 s blind. Verify on a real cold start (reboot, first launch): no "listener not bound" card, no false degraded This-Machine card, and no 30 s backoff lag.
4. **Stale scan `taskkill /F` without `/T`** in the stale-brain scan: children survive. Other `stopWindowsBrainGracefully` callers do the same.
5. **Bare-pid kill in `removeWindowsRunEntryIfPresent`:** no identity check, so a reused PID could be killed.
6. **Desktop quit force-kills a desktop-owned brain on Windows** (`taskkill /F`) with no cooperative shutdown. It needs a quit-budget decision: how long quit may wait. Propose one, measure it, ask the user if it's user-visible.
7. **Windows stop path:** early SIGTERM bypasses shutdown hooks, and stop force-kills. Windows has no deliverable SIGTERM (`process.kill` = TerminateProcess), so every stop must go through the brain's RPC shutdown first. Audit all stop paths.
8. **#1755 sync-host takeover** (merged, never run on Windows): verify a pid-checked RPC shutdown happens before `taskkill` on a real takeover.
9. **#1758** (merged blind): verify the Windows status timeouts behave on a cold start (see 3).
10. **Compile caches on Windows** (#1743/#1744/#1748): verify `NODE_COMPILE_CACHE` is set for the brain service and desktop main on Windows, is used (a warm start is faster), and is pruned. #1744 review noted that Windows `ade app open` and `ade reset` relaunch pass `NODE_COMPILE_CACHE` into the desktop app. Check that's intended.
11. **Update time** (windows-support.md says minutes): attribute it with `docs/development/windows-update-timeline.md`, and cut what you can (e.g. the install step that registers a scheduled task and starts a brain the app then replaces).

---

## 7. Cross-platform items left (also affect Windows), ranked

1. **Make every connected machine live, not polled.** See section 3. Today other machines' sessions are polled every 10 s and lanes every 30 s.
   - Goal: when any connected machine's chat or lane changes, every viewer sees it within a frame or two, with no 10–30 s lag, and no extra cost when nothing changes.
   - Measure first: update latency for a status change, a new chat, a title change and a new lane on another machine, before and after.
   - This is a design-sized change. Plan it, get the user's OK on the design, and split it into proven steps.
   - It would also fix:
     - the #1777 class of symptoms;
     - Mac Studio chat status lagging on the MacBook;
     - "sometimes the chats load slow" on project switch, if those chats are on other machines.
2. **Project-tab switch: sometimes slow chat loading** (user report). Lab numbers were fine (169–227 ms), so the slow cases are intermittent. Add lightweight instrumentation that logs each project-tab switch (click → chats visible, and what it waited on), so slow switches in real use leave a trace. Then fix what the traces show. Check whether slow switches correlate with remote bindings or other-machine chats (item 1).
3. **Chat switch on long chats** on other machines: warm content 188–306 ms (limit 250), cold first open ~330 ms with one frame of layout shift on a backfill page. Dominated by ~20 serialized RPCs to the other machine per switch: dedupe the tool-status readers, add per-pin stale-while-revalidate caches, parse history pages once, make `getSessionSummary` async, fix the `prs.listAll` scan.
4. **Pinned-pump replay** (the root cause of the old Tools-pane bug): on re-subscribe the remote pump replays the whole buffer, and there are 9–12 identical polls per pin. #1742/#1750 patched the symptom; #1732 failed review 3 times.
5. **Lanes route keep-alive:** warm Lanes content is ~223–238 ms, just under 250, and the sidebar and dashboard still refetch on every visit.
6. **New chat on a remote lane:** first row 120–175 ms (limit 150). Idea: a client-minted session id on `chat.create` (#1770 was parked: no live win, and a duplicate-send risk to design around).
7. **Hosted web client:** verify #1771/#1772/#1773 live on app.ade-app.dev, now that the web bundle has deployed and the Studio runs ≥1.2.111.
   - Open chat `b42c9a4b-3de8-4f3f-8159-1a7f32d1745b` (Mac Studio, ADE project): proof screenshots render; it loads fast.
   - Right-click a Work card → Copy ›: the submenu sits beside it.
   - Check the image request count on chats with many proofs.
   - Surfaces still not converted to web zoom: chatLaunchDock, native panel bounds, Apple overlays, the WorkLiveCornerCard drag preview.
8. **WorkViewArea fallback.** When the active chat id isn't in the list, `activeSession` falls back to `visibleSessions[0]`, i.e. some old chat. #1777 removed the common trigger. Showing a neutral loading/missing state for an id the app knows is coming (`knownLaunchSessionIds`) would remove the class.
9. **Product decision for the user:** the 3-day remote-brain reclaim window. Ask; don't decide.

---

## 8. Delegation, tools and machine safety

### Workers (T3 `delegate_task`)
- **Implementers:** Claude Haiku 5.5, effort xhigh: `{"providerInstanceId":"claudeAgent","model":"claude-haiku-5-5","options":{"effort":"xhigh"}}`.
- **Reviewers:** GPT-6 Luna, reasoning high: `{"providerInstanceId":"codex","model":"gpt-6-luna","options":{"reasoningEffort":"high"}}`.
- Never fan out Opus or Fable subagents. Re-check ids with `orchestrator_capabilities`, since providers on this PC may differ.
- Never use T3/Claude built-in worktree isolation (`isolation:"worktree"`). Make worktrees yourself with `git worktree add` off `origin/main` and give each worker its path. Workers never run `npm install`; reuse your installed `node_modules`. On Windows use a directory junction (`mklink /J`), or run `npm ci` once per worktree if junctions misbehave.
- **What worked:**
  - One worker per concern per worktree.
  - Haiku implements, Luna reviews the diff and the claims, then you validate live and merge. Luna caught real bugs every round.
  - Each brief contains:
    - the concern and file/line pointers;
    - the worktree path;
    - "read section 1–2 rules";
    - the metric or repro it must produce;
    - "no new tests unless a critical contract (AGENTS.md 13)";
    - the stop condition ("open PR, do NOT merge, report PR URL, full head SHA, evidence, CI state").
  - Use `mode:"async"` with a stable `clientRequestId` per round. Don't poll; completion wakes you.
  - **Review rounds:** each round is a NEW `delegate_task` containing the original brief, the prior findings and the responses.
- **Memory caution:** a desktop typecheck takes several GB. Find out this PC's RAM and keep heavy jobs to 2 at a time. Port the limiter below. 6–8 implementers in flight is plenty.

### `serial.ps1`: machine-wide limiter for heavy commands (typecheck, vitest, eslint, builds)
Put it somewhere stable, e.g. `~/ade-r4w/serial.ps1`, and make every brief run heavy commands through it.

```powershell
# usage: powershell -File ~/ade-r4w/serial.ps1 <command> [args...]
# Runs one heavy command while holding one of 2 machine-wide slots; waits for a free slot.
# While $env:TEMP\ade-measure.hold exists (you are measuring), new heavy jobs wait.
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Cmd)
$hold = Join-Path $env:TEMP 'ade-measure.hold'
for ($i = 0; $i -lt 900 -and (Test-Path $hold); $i++) { Start-Sleep 2 }
for ($i = 0; $i -lt 1800; $i++) {
  foreach ($slot in 1, 2) {
    $m = New-Object System.Threading.Mutex($false, "Global\ade-heavy-$slot")
    $got = $false
    try { $got = $m.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }
    if ($got) {
      try { & $Cmd[0] @($Cmd | Select-Object -Skip 1); exit $LASTEXITCODE }
      finally { $m.ReleaseMutex(); $m.Dispose() }
    }
    $m.Dispose()
  }
  Start-Sleep 2
}
Write-Error 'serial.ps1: gave up waiting for a heavy-job slot'; exit 99
```

### `drive.mjs`: a minimal CDP driver for the installed or dev app (Node 22)
It sends trusted input and runs `eval`. Usage:

```
node drive.mjs click <x> <y>
node drive.mjs key <Key>
node drive.mjs type <text>
node drive.mjs eval <expr>
node drive.mjs shot <out.png>
node drive.mjs find <text>
```

- `CDP_PORT` defaults to 9222.
- `CDP_TARGET_URL` is a substring of the page URL: `index.html` for the packaged app, `localhost:517` for the dev app.

```js
import { writeFileSync } from "node:fs";
const port = Number(process.env.CDP_PORT ?? 9222);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const t = list.find((x) => x.type === "page" && x.url.includes(process.env.CDP_TARGET_URL ?? "index.html"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const m = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)); return m.result?.result?.value; };
const [cmd, ...a] = process.argv.slice(2);
if (cmd === "click") { const [x, y] = a.map(Number); for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); }
else if (cmd === "key") { const key = a[0]; const vk = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8 }[key]; for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: vk }); }
else if (cmd === "type") { await send("Input.insertText", { text: a.join(" ") }); }
else if (cmd === "eval") { console.log(JSON.stringify(await ev(a.join(" ")), null, 1)); }
else if (cmd === "shot") { const m = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(a[0], Buffer.from(m.result.data, "base64")); }
else if (cmd === "find") { const n = a.join(" ").toLowerCase(); console.log(JSON.stringify(await ev(`(() => { const n=${JSON.stringify(n)}; const out=[]; for (const e of document.querySelectorAll("*")) { const own=[...e.childNodes].filter(c=>c.nodeType===3).map(c=>c.textContent).join("").trim(); const lab=e.getAttribute("aria-label")||e.getAttribute("title")||""; if(!(own.toLowerCase().includes(n)||lab.toLowerCase().includes(n))) continue; const r=e.getBoundingClientRect(); if(!r.width||!r.height) continue; out.push({tag:e.tagName.toLowerCase(), text:(own||lab).slice(0,60), x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}); } return out.slice(0,25); })()`))); }
ws.close();
```

- In a **dev** renderer you can import live modules for probes, e.g. `await import("/state/appStore.ts")`, `await import("/state/chatLaunchStore.ts")`. The packaged app can't do this; use DOM and `window.ade.*`.
- Click coordinates come from `getBoundingClientRect()` (CSS px), not screenshot pixels, which are scaled.
- **A "did it vanish?" sampler** like the one that caught #1777: poll every 50 ms whether a unique marker in your test prompt is visible in the main pane, and record each state change with its timestamp. Gaps show up as `NEW → other → NEW`.
- Repo perf scripts live in `scripts/perf/ui/`: `interaction.mjs` (tabs/chats/projects; settle + content-ready), `chat-switch.mjs`, `keystroke-trace.mjs`, `typing.mjs`, `render-count.mjs`, `process-cpu.mjs`, `cold-start.mjs`, `press-to-paint.mjs`, `route-sweep.mjs`. Some assume macOS process names or pathname routes; fix them in small tooling PRs as needed. That's allowed, but keep each one small.

### Measurement traps learned the hard way
- **A hidden window reads nothing remote.** When the window is covered, minimized, or the display sleeps, `document.visibilityState` becomes `hidden` and the cross-machine reader deliberately stops. Work then shows "No sessions" for other machines, which looks like a bug but isn't. Keep the measured window in front and the display awake: on Windows use `powercfg /change monitor-timeout-ac 0` (restore it afterwards), or a keep-awake tool.
- **The welcome card** ("Welcome to ADE") swallows keys on fresh loads. Dismiss it with Escape first.
- **DevTools open invalidates** idle, GPU and CPU numbers. Close it.
- **Measure under no load.** Gate on CPU load being low, not just on "I think nothing is running". Pause launches while measuring (touch the hold file).
- **History backfill** keeps changing counters for 40–90 s after a chat opens. Settle before comparing text.
- **Run-to-run drift** on the same build is ~15%. Compare before/after in one session (A/B by hot-swapping renderer files through Vite in a dev app), or interleave runs.
- **Simulating the hosted web client** in a dev renderer: call `(await import("/lib/webZoom.ts")).applyHostedWebZoom(1.1)`. Never set `document.body.style.zoom` alone: `index.css` counter-zooms poppers through `--ade-web-zoom-factor`, so body-zoom alone shows false "detached popover" bugs.
- **After a dev renderer `location.reload()`**, the other-machine connection can come back empty. Reconnect from Connections and re-select the project tab.
- **The first synthetic right-click after a reload** sometimes opens nothing; retry until the menu exists.
- **Typing into the draft composer:** pick the machine and lane through the real pickers. Verify both (`[data-draft-machine-picker]` aria-label, `[aria-label="Select lane"]` text) **and** the textarea value before you click Send. Abort if any differ. This is how you guarantee you never type into a real chat or onto a real lane (e.g. the Studio's "Primary" lane is the user's main checkout). Use cheap test prompts: "reply with just OK. Do not run any tools."
- **New-lane launches onto the Mac Studio** create a real lane, branch and worktree there. Delete them through ADE (`window.ade.lanes.delete({laneId, deleteBranch:true, deleteRemoteBranch:true, force:true}, <studio binding>)`) after checking the lane name matches your prefix. Then confirm no remote branch is left on GitHub.
- **Brains:** one brain per ADE home. A dev brain outlives its app; check it's gone after you stop a dev app. Never point a dev app's `--socket`/pipe at the installed brain's endpoint (it replaces the installed brain). Never run a dev app with an alternate sync-enabled home that could open the user's real project. A round-2 incident had a second identity write itself into the real project DB as the sync host, breaking sync for a week.

---

## 9. Read these in the repo (on `main`)

- `AGENTS.md`: conventions, Running checks (one check pass at the end; CI is the full gate), test rules (rule 13).
- `docs/development/local-development.md`, section **On Windows**.
- `docs/development/windows-support.md`: what Windows gets instead (the known-gaps table the beta notice links to), the background brain, troubleshooting.
- `WINDOWS_PORT.md`: port status, readiness table, original release blockers, explicit follow-ups.
- `docs/development/windows-release-proof.md`, `docs/development/windows-update-timeline.md`, `docs/development/windows-port-lane.md`, `docs/playbooks/windows-signed-release.md`.
- `.agents/skills/quality/references/windows-quirks.md`: failure classes and the canonical helper for each.
- `docs/perf/macos-baseline.md`: the ceilings.
- `docs/features/sync-and-multi-device/`: how machines, bindings and cross-machine chats work.
- `docs/ARCHITECTURE.md`: only the section for what you touch.

---

## 10. Status at handoff (2026-10-18) and how to start

- `main` at handoff: see `git log origin/main -5`. Latest release: **v1.2.111** (2026-10-18), which includes all of round 3. Installed versions on the machines may differ; check each in Connections.
- **#1777 (launch gap):** MERGED (`8be0b3f`).
  - The launch's placeholder row now stays until either the real chat is listed (lane-aware), the chat is deleted (in any window), or two successful reads from the owning machine, both started after the agent started, come back without it.
  - There is no wall-clock timer. A hidden window does no reads, so it simply waits.
  - Live: main 3/3 launches showed the old chat for 2.9–9.5 s; with the fix, 0 gaps in 18 launches, including hidden-window runs. The real row lands 1.2–3.3 s after agent start.
  - Took 7 GPT-6 Luna review rounds. The lesson: a time-based expiry kept producing new timing edges; anchoring to events and reads ended them. Prefer event/read-anchored designs over TTLs for anything that waits on another machine.
- **#1778 test trim:** MERGED (`ec5a99d`), +273 / −4,395 lines.
  - Removed the round-3 tests that guard no critical contract.
  - Kept compact guards for:
    - outside-root refusal text and filesystem-probe parity (#1752);
    - viewer-never-dials-self, including saved loopback addresses (#1766);
    - legacy drafts scoped per project, and the brain refusing disconnect (#1764);
    - Stop-following never disconnects a project that changed during confirmation (#1757);
    - a CLI projectRoot/projectId disconnect only stops its own project (#1751);
    - compile-cache pruning never deletes outside its root or through symlinks (#1748);
    - the chat-history resent-tool-call join (#1767);
    - a lock-losing second launch exits (#1759);
    - sync-host takeover (#1755);
    - the web computerUse foreign-pin refusal (#1773);
    - authoritative session reads never return stale mirror data (#1750).
  - Lesson: GPT-6 Luna's review caught six over-deletions and a test that had been silently skipping. Have trims reviewed too.
- No PRs from these rounds are open.
- The user's own recent merges are #1774 (model-picker sign-in on the composer's machine), #1775 (plain-text paste), #1776 (Copilot on its SDK; SDK agents on headless ADE) and #1779 (the personal Chats page lists every machine's chats).
  - #1779 makes personal chats multi-machine. It does not change the polled cross-machine reads for a project's Work view (section 3).

**First steps:**
1. Read this file, then section 9's docs.
2. Phase 0: record the starting state, get CDP on the installed app and a dev app, take the section 4 baseline.
3. Post a short plan to the user, which they will read:
   - the baseline table;
   - your first inventory pass;
   - the ceilings you'll hold Windows to;
   - what you'll do first;
   - any decision you need from them (e.g. the quit budget, the live-updates design).
4. Then work through phases 1–6 without waiting for approval on routine fixes. Keep a running log `r4w-log.md` in your worktree: what's in flight, merged, measured, parked, and why.
