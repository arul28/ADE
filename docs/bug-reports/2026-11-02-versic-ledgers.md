# Bug check: the open items of the two Versic ADE ledgers (2026-11-02)

This file follows `2026-10-24-cto-run.md`. It checks what was still open on two
ledgers that Versic agents wrote, as copied on 2026-11-02 to
`/Users/admin/.claude/projects/-Volumes-Dev-Projects-Versic/scheduled/fix-lanes-2026-11-02/`:

- `cto-ade-ledger.md`, issues 29-32 (1-28 were fixed by #1909 and #1915; see the
  file before this one).
- `mobile-ade-bug-ledger.md`, the items its last three sections ("Retest on ADE
  1.2.126", "Retest on ADE 1.2.127", "Duo work on ADE 1.2.127") list as still
  present or not retested.

- **Checked on:** 2026-11-02, on the Mac Studio.
- **Code:** `main` at `ff01b6e17`, plus this branch.
- **Installed ADE:** v1.2.127 (ADE.app and its brain). A standalone
  `~/.ade/bin/ade` 1.2.125 is also on disk.
- **Method:** code reading; the CTO and worker transcripts on disk (read only);
  read-only CLI calls; this lane's own private Mac screen; simulators created
  for this lane only, deleted afterwards.
- **Not used:** the owner's real screen, other projects' lanes, chats and
  simulators. No message went to the Versic chats named in the ledgers.

## Summary

| Item | Status | Where |
| --- | --- | --- |
| CTO 29 `steerChat` queued | confirmed, fixed | `ctoOperatorTools.ts` |
| CTO 30 red "connection closed" banner | confirmed, fixed | `chatNotice.ts` |
| CTO 31 `steerChat` has no `machine` | confirmed, fixed | `ctoOperatorTools.ts` |
| CTO 32 full-auto capped across projects | confirmed, fixed | `multiProjectRpcServer.ts` |
| Mobile 35 tabs missing from `snapshot` | confirmed, fixed | simulator helper (`AccessibilityBridge.swift`) |
| Mobile 18 `fold open` prints the old shape | fixed before this branch (#1953); 11 of 11 folds right | none |
| Mobile 48 stale `~/.ade/bin/ade` | confirmed, fixed | `ade doctor` row |
| Mobile W3 `chat show` on a remote chat | confirmed, fixed | `cli.ts` |
| Mobile 29 extra powered off | fixed before this branch; seen working | none |
| Mobile 11, 12 `apple test` counts and failures | fixed; one more count bug fixed | `appleTestRun.ts` |
| Mobile 15 `device-detach` | fixed; a `--device` bug fixed | `cli.ts` |
| Mobile 2, 3, 4, 9, 16, 20, 25, 32, 34, 36 | fixed on 1.2.127 | none |
| Mobile 37, 40, 41/44, 42 (Mac Desktop) | fixed on 1.2.127 | none |
| Mobile 27, 46 | fixed in code by #1953 | none |
| Mobile 14 | by design, and now said on detach | none |
| Mobile 17 | probably the cause of 35; not testable on Versic | helper fix |
| Mobile 33 | not rechecked | none |
| Mobile 38/47 | inconclusive | none |
| Mobile 39, 43 | cannot test safely / not retested | none |
| New: `apple install --app-bundle`, `device-detach --device` ignored | fixed | `cli.ts` |
| New: `apple test --project` refusal named `--out` | fixed | `iosSimulatorService.ts` |

---

## CTO ledger

### 29. The owner's messages "queue instead of steering"
- **Status:** confirmed, but not as the ledger describes it. Fixed on this branch.
- **Evidence:**
  - The owner's two complaints (2026-10-26 23:28 and 23:31 EDT, rows 1309 and
    1361 of the CTO transcript `15a7b887….jsonl`) are about the CTO's messages
    to its worker: "everytime u message u queue instead of steer … always steer
    ur agents". Each of the owner's own messages to the CTO started a CTO turn
    at once (same timestamp as its `turnStatus: started`). For the CTO chat the
    service already redirects every message into the running turn
    (`steerWithOptions`, the `identityKey === "cto"` branch).
  - The CTO's `steerChat` calls did queue. In the worker transcript
    (`6207a427….jsonl.gz`) each one is first written with
    `deliveryState: "queued"` and only later again with `"inline"`:
    03:26:18 → 03:27:59Z, 03:27:49 → 03:28:05Z, 03:29:36 → 03:31:33Z. The last
    instruction waited two minutes while the worker kept working. The CTO's
    ledger note ("they were not queued, the transcript shows them Steered") read
    only the second row.
  - Cause: `steerChat` called `steer` with no dispatch mode, and a steer with no
    mode is staged for the next turn (`AgentChatSteerArgs.dispatchMode`, "Omit
    to stage the message for the next turn"). The composer's "Steer" sends
    `inline`.
  - The UI shows both states correctly (a queued row, then "Steered" on the
    bubble); the confusion came from the tool, not the display.
- **Fix:** `steerChat` asks for the provider's live mode (`inline`). If the
  chat's provider cannot take a message mid-turn, the service refuses that mode
  before it delivers anything, and the tool then stages it. The result says
  `delivery: "live"` or `"queued"` and returns the `steerId` that `cancelSteer`
  needs (it returned neither before). An idle chat starts a turn, as before.

### 30. "Remote ADE service connection closed" banner in a worker chat
- **Status:** confirmed. Fixed on this branch.
- **Evidence:**
  - The owner's screenshot (`attachments/2e2017e3….png`, sent with CTO
    transcript row 1361) is worker chat 6207a427 at 23:31 EDT, with the red
    banner over the chat.
  - `ade.remoteRuntime.callAction` is the IPC channel a desktop window uses for
    its own calls to a chat on another machine (a pinned pane). An agent's CLI
    calls never reach a pane's banner. So the call that failed was the window's
    own read or send for that chat, made while the connection to the Mac Studio
    dropped; the worker agent did not make it, and it kept working.
  - Which pane call it was cannot be named now: the renderer logs of that day
    are not kept. Every caught pane error goes through one reducer
    (`chatNoticeReducer`), which showed the raw Electron text as a red failure.
- **Fix:** the reducer recognises a dropped connection
  (`isRemoteRuntimeConnectionError`) and shows a status line instead: "The
  connection to this chat's machine dropped for a moment. The chat keeps running
  there, and ADE reconnects by itself. If something you just did is missing, do
  it again." Other errors stay failures.

### 31. `steerChat` has no `machine`
- **Status:** confirmed. Fixed on this branch.
- **Evidence:** the schema was `{ sessionId, instruction }`
  (`ctoOperatorTools.ts`), while `sendChatMessage`, `getChatStatus`,
  `getChatTranscript`, `listChats` and `spawnChat` take `machine`.
  `interruptChat` and `cancelSteer` had the same gap.
- **Fix:** `steerChat`, `cancelSteer` and `interruptChat` take `machine` and
  run `chat.steer`, `chat.cancelSteer` and `chat.interrupt` on that machine (all
  three are remote-callable chat actions). A steer and its cancel go to the same
  machine.

### 32. A full-auto chat cannot start a full-auto chat in another project
- **Status:** confirmed. Fixed on this branch. Added to the ledger on 2026-11-02,
  after this lane started; this lane's own chat (8fb94d00) is the case.
- **Evidence:**
  - The CTO chat 15a7b887 (Versic project, full-auto) ran `ade chat create
    --no-parent --permissions full-auto` in the ADE project. The chat started at
    `default`, and `ade chat update 8fb94d00 --permissions full-auto` was
    refused with "can't give a chat more access than "ask before changes"".
    `spawnChat` inside Versic gave full-auto (a48e1a89).
  - A chat is capped at the lower of its parent's level and the calling chat's
    level (`resolvePermissionCeiling`). The target project does not know a chat
    from another project, so it reads the level the brain recorded for it
    (`externalChatContext`), and falls back to `ask` when there is none.
  - The brain recorded the caller's level only when the call named the caller
    as the new chat's parent (`multiProjectRpcServer`, `parent === callerChat`).
    With `--no-parent`, and for every `chat update`, nothing was recorded, so
    the caller counted as `ask`. `spawnChat` worked because its child is in the
    caller's own project. The remote-machine path already sends the caller's
    level on every call.
- **Fix:** for every call that starts a chat (`chat.createSession`,
  `chat.launchHeadless`, `chat.startLaunch`, `start_cli_session`) or runs
  `chat.updateSession`, the brain records the calling chat's real level before
  the target project handles it, parent or not. The cap itself is unchanged: a
  chat still never gets more access than the chat that asked for it.
- **For this lane:** the fix takes effect when the brain runs it. Until then the
  owner can raise this chat to full-auto from its composer.

---

## Mobile ledger: still present on 1.2.127

How it was tested: a small SwiftUI app with the Versic tab layout (5 tabs, the
iOS 26.1 `Tab` API, a `role: .search` tab, a tile grid with `.contextMenu`, a
NavigationStack, a search field, adjustable sliders, a 200-row list), built into
`/tmp/ios-retest`, on two simulators this lane created (iPhone 17 Pro on iOS
27.0, iPhone Duo on iOS 27.1). Both were deleted afterwards. A copy of the
Versic lane's own build (`Versic.app`, read from its DerivedData, run on this
lane's devices only) stops at its sign-in screen, so it could only be used for
fold timing. No Versic account was used.

### 35. Tabs missing from `apple snapshot`
- **Status:** confirmed on 1.2.127. Fixed on this branch.
- **Evidence:**
  - With tiles scrolled behind the tab bar, `apple snapshot` listed only
    Projects and Settings. Library, Shares and Search were missing, and
    `find --label Library` matched the page heading instead. This is the mirror
    image of the ledger (there Projects and Settings were missing); which tabs
    drop depends on where the content behind the bar sits.
  - Cause: the helper finds a tab bar's items only by hit-testing a 32-point
    grid (the bar is a group with no children). It skips every grid point that
    lies inside an element it already knows, to save round trips. The tree walk
    also lists content scrolled *behind* the floating bar (here tiles 18-20 at
    y 815), so the points over most tabs were skipped and never asked.
- **Fix:** `AccessibilityCoverage` (`AccessibilityBridge.swift`) treats a large
  element with no walked children as a bar. A point on a bar counts as covered
  only by a leaf inside that bar. The helper's `cover` uses the same rule.
- **Check:** the raw `ax-describe` from the installed helper against this
  branch's helper on the same screen: 2 of 5 tabs before, 5 of 5 after; same
  read time (about 0.9 s both); no change on a 200-row list or on the Duo in
  laptop and open postures. The helper's 84 Swift tests pass.
- The ledger's first report (frames in the wrong order, a minimised bar still
  listed) was not reproduced: the test app's tab frames matched the drawn bar.

### 18. `fold open` prints the old shape
- **Status:** fixed before this branch; not reproduced on 1.2.127.
- **Evidence:** on the Duo, closed→open, closed→book, closed→laptop, book→open,
  laptop→open and three more closed→open with the test app, and three
  closed→open with Versic in front: 11 of 11 printed the same picture that
  `posture` read 2.5 s later (open and book "inner display, wide", laptop
  "inner display, tall"). The retry on a failed read during the panel switch
  (#1953) shipped in 1.2.126; the 1.2.126 retest that still saw it had the full
  player sheet up in Versic, which needs a signed-in account.

### 48. Standalone `~/.ade/bin/ade` 1.2.125 next to ADE.app 1.2.127
- **Status:** confirmed. Fixed on this branch.
- **Evidence:** the version-skew warning shipped in 1.2.126, so the 1.2.125
  binary cannot warn about itself.
- **Fix:** `ade doctor` has a row for it, checked against the running brain:
  "run `ade brain update` (or delete it) · …/ade is 1.2.125, the brain
  1.2.127".

### W3. `chat show <remote session>` without `--machine`
- **Status:** confirmed on 1.2.127 (header only). Fixed on this branch.
- **Evidence:** `chat show` got a null summary back without an error, so it
  never looked on the other machines, unlike `chat status`.
- **Fix:** it marks the miss, so the other-machine lookup and its hint run. The
  Windows chat from the CTO ledger is now found "on windows" and shown; an id
  that exists nowhere says so and exits 1.

### 29. An extra device that ADE powered off
- **Status:** fixed before this branch.
- **Evidence:** seen today: `device-list` notes "ADE powered ADE · retest Duo
  off after 33 min idle at 02:11; the next --device command boots it again",
  and `boot --device` printed "… this command booted it again". The ledger's
  later reports came from raw `simctl install`, which ADE cannot see.

---

## Mobile ledger: not retested before

| Entry | Status on 1.2.127 | Evidence |
| --- | --- | --- |
| 2 | fixed | `screenshot --device` right after `fold open`: 2853x2007, the open panel |
| 3 | fixed | `snapshot` prints `screen 402x874 @3x` |
| 4 | fixed | `tap-element --label Shares` / `--label Library` switch tabs |
| 9 | fixed | `fold laptop` prints `inner display, tall`, the same as `posture` |
| 11 | fixed | `apple test`: "4 run, … 1 skipped" for 2 suites with a skip |
| 12 | fixed | the failing test listed with file, line and each assertion on its own line |
| 14 | by design | `device-detach` now says the ADE-made device becomes a leftover, when it is deleted, and how to keep it |
| 15 | fixed | `device-detach --text` prints the device, its origin and "deletes after" |
| 16 | fixed | `tap-element --label BackButton` says it matched the identifier, and goes back |
| 17 | probably 35 | elements under floating content (the deck over the list) are the case the 35 fix covers; the Versic deck needs sign-in, so not confirmed |
| 20 | fixed | `fill-element --identifier search-field` types and verifies ("The field reads \"Hello\"") |
| 25 | fixed | `boot --device` reports `state Booted` |
| 32 | fixed | `snapshot` listed all 41 rows of the tile screen |
| 33 | not rechecked | `log-start` on the extra was refused; the reason was not captured |
| 34 | fixed | `tap-element --text-match Everything` tapped the tile (no context menu) |
| 36 | fixed | both sliders read `0:29 of 0:49` |
| 27, 46 | fixed in code | #1953 |
| 37 | fixed | a second document went to the lane's running TextEdit |
| 40 | fixed | `quit TextEdit` is accepted and TextEdit quits |
| 41, 44, 42 | fixed | on this lane's private Mac screen |
| 38, 47 | inconclusive | ⌘S from the lane did not open TextEdit's Save panel (⌘N did) |
| 39 | cannot test | needs an approval card in front of the owner |
| 43 | not retested | |

### Found during the retest, fixed on this branch
- **`apple install --app-bundle <path>` installed the wrong app.** `install`
  has no such flag; it passed it through unread, built this repo's own iOS
  app and installed that. It now refuses the flag and names
  `apple launch --app-bundle <path> --no-build`.
- **`apple device-detach --device <extra>` detached the lane's own device.**
  Detach acts only on the lane's device and ignored `--device`. It now refuses
  `--device`/`--udid` and names `device-delete --device`.
- **`apple test` counted assertions as failed tests.** XCTest's "with 2
  failures" counts failed assertions; one test with two failing asserts read
  "2 failed". It now counts the failing test cases.
- **`apple test --project` outside the worktree** answered with the `--out`
  hint. It now says the project must be inside the lane's worktree.
- Not ADE: after the tests ended in 9 s, `xcodebuild` took 10 more minutes to
  write the result bundle (Xcode 27.1 printed `IDESchemeActionSDKRecord …
  invalidDigitCount(94232)`), so `apple test` reported 610 s.
