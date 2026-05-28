# ADE CLI sessions: finish correctness, UX, and performance proof

You are taking over the `app-control-fixes` lane in:

`/Users/arul/ADE/.ade/worktrees/app-control-fixes-d55c0422`

The user is debugging ADE Work-tab CLI sessions across Codex, Claude, Cursor,
OpenCode, and Droid. They are frustrated because prior smoke testing created
confusing stale sessions, stale green status indicators, duplicate resumed
rows, auto-closing PTYs, and high memory/lag. Do not give a theoretical answer.
Trace the real code, fix the real issue, and verify in the dev Electron app.

## Non-negotiable expectations

- Preserve user changes in the dirty worktree. Do not reset or revert unrelated
  files.
- Use Node 22 for desktop commands:
  `PATH=$HOME/.asdf/installs/nodejs/22.13.1/bin:$PATH`.
- Use the dev Electron app as the UI source of truth, not Safari.
- Use Codex Computer Use or CDP to verify the actual Electron UI behavior.
- Stop and report clearly if a provider cannot work because auth/setup is
  missing. Do not fake a passing result.
- Run small focused tests while iterating. Do not jump straight to full test
  suites until the implementation and smoke proof are complete.
- When testing CLI sessions, clean up the sessions/processes you create.

## Current known state from the previous pass

Several fixes are already present on this branch. Re-read the code before
trusting this list, but these are the intended current changes:

- Dead/stale CLI rows should no longer stay green after app restart. Detached or
  killed PTY-backed sessions should render as ended/red.
- Sending a resume message to a dead CLI session should reuse the same session
  row and create a new PTY under that same session id, not create a duplicate
  sidebar row.
- Resume composer UI was simplified to message-only; the previous model and
  runtime metadata should be reused for the resume.
- Cursor CLI launch defaults should use `cursor-agent --model auto`, not GPT
  model names.
- Cursor CLI resume should preserve the Cursor session id and should not append
  a stray literal `n` to the resume id.
- PTY termination paths were changed to kill the process tree instead of only
  the top-level PTY process.
- Droid CLI exists on the machine, but Droid is blocked by account/subscription
  setup unless the user has since authenticated it.

Important files likely involved:

- `apps/desktop/src/main/services/pty/ptyService.ts`
- `apps/desktop/src/main/utils/terminalSessionSignals.ts`
- `apps/desktop/src/main/services/sessions/sessionService.ts`
- `apps/desktop/src/shared/cliLaunch.ts`
- `apps/desktop/src/shared/types/sessions.ts`
- `apps/desktop/src/renderer/components/terminals/cliLaunch.ts`
- `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts`
- `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx`
- `apps/desktop/src/renderer/components/terminals/WorkViewArea.tsx`
- Settings/runtime availability files for Cursor SDK and CLI model discovery.
  Find these with `rg "Cursor|cursor-agent|CURSOR_API_KEY|models.list|list-models" apps/desktop/src`.

## Task 1: fully investigate the PTY lag and memory issue

The user observed that only four ADE CLI sessions made the computer feel slow
and memory-heavy. Four normal terminal sessions should not do that. Treat this
as a real product bug until disproven.

Do a focused performance/resource investigation before making guesses:

1. Launch the dev desktop app from `apps/desktop` with the current lane code.
   Use a throwaway ADE home/project root if needed so smoke sessions do not
   pollute the user's real state.
2. Create a small controlled set of CLI sessions: one each for Codex, Claude,
   Cursor, and OpenCode. Skip Droid unless auth/subscription is available.
3. Record process tree and RSS before, during, after stop/delete, and after app
   restart. Include Electron main, Electron renderer, node child processes,
   PTYs, provider CLIs, and any lingering descendants.
4. Inspect whether ADE is doing expensive renderer work:
   - transcript re-render frequency
   - session list polling/subscription churn
   - title/summary extraction or preview parsing
   - hidden terminal rendering
   - unbounded transcript buffers or IPC payloads
5. Inspect whether main process leaves stale resources:
   - process trees after stop/delete
   - timers
   - event subscriptions
   - file watchers
   - session list intervals
   - leaked PTY objects
6. Add instrumentation only if needed, and remove or gate noisy logging before
   finalizing.

Expected outcome:

- Either fix the root cause, or produce a concrete measured bottleneck with a
  small high-confidence fix plan.
- If you fix it, add tests or a smoke assertion that would catch the regression
  where feasible.
- Confirm cleanup leaves no stale provider CLI processes from your smoke run.

## Task 2: fix Cursor model availability UX for CLI and SDK separately

Current bad UX:

- The ADE UI model picker does not show Cursor models until the Cursor SDK is
  configured.
- That is wrong because Cursor CLI sessions can still be available through the
  local `cursor-agent` binary even when `@cursor/sdk` / `CURSOR_API_KEY` is not
  configured.

Desired UX:

- ADE should check both Cursor availability paths:
  - Cursor SDK/native runtime availability via `@cursor/sdk` and
    `CURSOR_API_KEY`.
  - Cursor CLI availability via the local `cursor-agent` binary and its CLI
    model listing, for example `cursor-agent models` or
    `cursor-agent --list-models`.
- If only Cursor CLI is available, show Cursor models in model selection with a
  small `CLI only` tag.
- If only Cursor SDK/chat runtime is available, show Cursor models with a small
  `Chat only` tag.
- If both are available, show Cursor models normally with no tag.
- Do not block CLI model selection just because the Cursor SDK settings card
  says sign-in required.
- Keep copy concise and stateful.

Implementation guidance:

- Do not hard-code only `auto` unless there is no reliable discovery path.
  Prefer real CLI discovery and cache it with sane invalidation/error handling.
- If SDK and CLI return overlapping model ids, merge them by model id and keep
  source availability metadata.
- If a model exists only in CLI discovery, it must still be launchable by
  Cursor CLI sessions.
- If a model exists only in SDK discovery, it must not be offered for Cursor CLI
  launch unless Cursor CLI accepts it.
- Add focused tests for:
  - SDK unavailable + CLI available => models visible with `CLI only`.
  - SDK available + CLI unavailable => models visible with `Chat only`.
  - both available => merged models, no source tag.
  - neither available => current sign-in/setup UI remains understandable.

## Task 3: smoke every permission mode for each supported CLI runtime

The user explicitly asked for every permission mode on every runtime that has a
CLI session option:

- Codex
- Claude
- Cursor
- OpenCode
- Droid only if auth/subscription is actually available

Use one model per runtime. For Cursor, use `auto` or another real Cursor CLI
model, not GPT model ids. For each runtime, use two reasoning/autonomy levels
where that runtime exposes them. If a runtime does not have an equivalent
reasoning control, document that as "not applicable" with the exact help/doc
evidence.

Before testing, verify current CLI flags against installed help output and, if
needed, official/runtime docs:

- `codex --help` and `codex resume --help`
- `claude --help`
- `cursor-agent --help` and `cursor-agent models` or `cursor-agent --list-models`
- `opencode --help` and `opencode run --help`
- `droid --help` and `droid exec --help`

For each runtime and mode:

1. Launch from the ADE UI or the same IPC path the UI uses.
2. Confirm the spawned command contains the expected permission/autonomy flags.
3. Confirm the prompt opens the PTY immediately after sending a message.
4. Send 2-3 small messages back and forth where possible.
5. Stop/kill/close ADE, reopen it, and confirm old CLI rows appear ended/red,
   not green and not gray.
6. Resume by sending a message to the dead row.
7. Confirm the same session row is reused in-place, with no duplicate sidebar
   row.
8. Confirm the resume command uses the right provider/session id and preserved
   launch metadata.
9. Delete the session after it is stopped or dead; deletion should not fail
   with "Running terminal sessions must be...".
10. Confirm no stale processes from that session remain.

If a runtime cannot be tested because setup is missing, stop and report the
exact blocker. For Droid, the acceptable blocker is the local Droid CLI saying
there is no active subscription or no credentials.

## Task 4: verify app close/reopen behavior

This is separate from normal stop/delete. The required product behavior is:

- If the Electron app exits, live PTYs are gone.
- On next launch, ADE should not pretend those process-local PTYs are still
  live.
- The old rows should show ended/red.
- The transcript should still be viewable.
- The user should be able to type a resume message into the same row.
- Resume should create a new PTY backing the same session row.

Do this for Codex, Claude, Cursor, and OpenCode. Droid only if setup permits.

## Task 5: clean up old smoke/test sessions in the dev ADE app

The prior pass created confusing "soak" and smoke rows. Before final smoke
proof, clean your own test sessions out of the dev ADE home/project state.

If deletion fails because ADE thinks a dead PTY is running:

- Trace why the session still reports running.
- Fix the status/enrichment/delete guard path.
- Verify the user can delete dead/unreachable sessions from the UI.

Do not delete user-owned real sessions unless the user explicitly asks.

## Task 6: run validation and final commands

After fixes and smoke proof:

1. Run focused tests for the touched surfaces.
2. Run:
   - `npm --prefix apps/desktop run typecheck`
   - relevant focused desktop Vitest files
   - `npm --prefix apps/desktop run lint` if touched code should be linted
3. If broad validation is requested, follow `AGENTS.md` validation order.
4. The user previously requested the repo commands:
   - `/Users/arul/ADE/.claude/commands/automate.md`
   - `/Users/arul/ADE/.claude/commands/finalize.md`

Before running broad automate/finalize-style checks, make sure the actual
implementation and smoke proof above are done. Do not run huge suites as a
substitute for the missing UI/runtime verification.

## Required final report

The final response must be concrete and must include:

- What was fixed.
- What was measured for lag/memory and the before/after or blocker.
- Cursor model UX behavior for SDK-only, CLI-only, and both-available cases.
- A matrix of runtime x permission mode x reasoning/autonomy levels tested.
- For each runtime, whether app close/reopen showed ended/red and resumed
  in-place without duplicates.
- Any provider blockers, with exact command output summary.
- Validation commands run and their results.
- Confirmation that smoke sessions/processes were cleaned up.

## Handoff update: 2026-05-26 16:35 EDT

This goal is not complete. Resume from this file and the current worktree state.
The worktree is intentionally dirty from earlier passes; do not reset it. The
changes from this pass are focused in:

- `apps/desktop/src/main/services/pty/ptyService.ts`
- `apps/desktop/src/main/services/pty/ptyService.test.ts`
- `apps/desktop/src/shared/cliLaunch.ts`
- `apps/desktop/src/main/utils/terminalSessionSignals.ts`
- `apps/desktop/src/renderer/components/terminals/cliLaunch.test.ts`
- this `codexGoal.md`

### Socket and lane discipline

- This lane socket is `/tmp/ade-runtime-app-control-fixes-d55c0422.sock`.
- Another active lane socket exists at
  `/tmp/ade-runtime-ui-clean-up-3470f34e.sock`. Do not touch or kill it.
- User explicitly wants: if this lane socket is already up, reuse it. If not,
  create a new socket only for this lane when launching the desktop app.
- Dev launch command used:
  ```bash
  PATH=$HOME/.asdf/installs/nodejs/22.13.1/bin:$PATH \
  ADE_PROJECT_ROOT=/Users/arul/ADE \
  ADE_DEV_RUNTIME_SOCKET_PATH=/tmp/ade-runtime-app-control-fixes-d55c0422.sock \
  NO_DEVTOOLS=1 \
  npm run dev:desktop -- --skip-runtime-build
  ```
- The dev app may rebuild stale CLI/main bundles before opening Electron. That
  happened in the latest run and is expected.

### Computer Use workflow that worked best

The user specifically wants real Work-tab testing through Codex Computer Use,
not direct CLI launch flags. Keep using this flow:

1. Start the dev Electron app from this worktree, pointed at this lane socket.
2. Before any UI action in a new assistant turn, call Computer Use
   `get_app_state({"app":"Electron"})`.
3. Confirm the state shows the local dev Electron app:
   - bundle `com.github.Electron`
   - HTML URL includes `localhost:5173`
   - Work tab URL is `/work?...`
4. Interact with the Work tab exactly as a user would:
   - click the existing lane row
   - click an existing stopped CLI row or create a new Work CLI session
   - type into the Work composer
   - click Send
   - use the visible Stop button for cleanup
5. Use shell/SQLite only for evidence after the UI action:
   - process tree/RSS
   - transcript tail
   - `.ade/ade.db` row state
   - no lingering provider processes

Do not use Safari as the parity reference. Do not bypass the Work tab with
direct CLI flags except for harmless help/docs/probe commands.

### Official/runtime docs checked in this pass

Use these as the runtime truth sources when continuing:

- OpenAI Codex CLI docs:
  `https://developers.openai.com/codex/cli/reference`
  - Current docs say `codex resume` accepts the same global flags as `codex`,
    including model and sandbox overrides.
  - Current docs list `codex exec resume` for non-interactive resume, but ADE
    Work-tab CLI sessions are interactive TUI sessions.
- OpenAI Codex security/permissions docs:
  `https://developers.openai.com/codex/security`
- Claude Code CLI docs:
  `https://docs.anthropic.com/en/docs/claude-code/cli-usage`
  - `--permission-mode default|acceptEdits|plan|bypassPermissions` are valid.
  - `--resume` resumes a specific session.
- Claude permission docs:
  `https://docs.anthropic.com/en/docs/claude-code/iam`
  - Confirms the permission-mode meanings.
- Cursor CLI docs:
  `https://docs.cursor.com/en/cli/overview`
  `https://docs.cursor.com/en/cli/reference/parameters`
  `https://docs.cursor.com/en/cli/using`
  - Confirms `cursor-agent --resume`, `--model`, `--force`, `--mode plan`,
    and command approval behavior.
  - Cursor modes doc confirms Agent/Ask/Plan behavior.
- OpenCode CLI docs:
  `https://dev.opencode.ai/docs/cli/`
  - Confirms bare `opencode` starts the TUI, and `opencode run` is the
    non-interactive path with `--interactive`, `--session`, `--continue`,
    `--model`, `--agent`, `--replay`, and `--replay-limit`.
- Factory Droid CLI docs:
  `https://docs.factory.ai/cli/configuration/cli-reference`
  `https://docs.factory.ai/cli/configuration/settings`
  `https://docs.factory.ai/cli/user-guides/auto-run`
  - Confirms bare `droid` is interactive and `droid "<prompt>"` starts the
    same interactive CLI with initial context.
  - Confirms `droid exec` is non-interactive.
  - Confirms `--auto low|medium|high`, `--session-id`, and
    `--skip-permissions-unsafe` for `droid exec`.
  - Confirms interactive Droid uses settings such as `model`,
    `reasoningEffort`, `sessionDefaultSettings.interactionMode`, and
    `sessionDefaultSettings.autonomyLevel`.

Local installed help also confirmed:

- `droid --help`: "Running 'droid' without any options starts interactive mode.
  Provide an inline prompt to start the session with initial context."
- `droid exec --help`: "Execute a single command (non-interactive mode)" and
  lists `--auto low|medium|high`, `--skip-permissions-unsafe`,
  `--session-id`, `--model`, and `--reasoning-effort`.

### What was verified with Computer Use

The following was driven from the real Work tab in Electron:

- The Work tab was open on lane `cli perf resource smoke 20260526`.
- A stopped Cursor Agent row was selected:
  `b491b60d-5e97-4e8c-8aca-70f652f5f5c8`.
- The row had previously printed
  `MATRIX_CURSOR_AGENT_RESUME_AFTER_REOPEN_526` after an app quit/reopen.
- After reloading the patched main bundle, a Work-tab follow-up was sent:
  `Print MATRIX_CURSOR_AGENT_PATCHED_DIRECT_RESUME_526 and then wait.`
- The same session row was reused in place. It did not create a duplicate
  sidebar row.
- DB evidence after sending:
  - `id`: `b491b60d-5e97-4e8c-8aca-70f652f5f5c8`
  - `title`: `Print MATRIX_CURSOR_AGENT_PATCHED_DIRECT_RESUME_526 then wait`
  - `status`: `running` during smoke, later returned to follow-up/ended state
    after Cursor printed the marker and waited.
  - `pty_id`: `b52eeea6-4955-49a5-9fcb-69c567818490`
  - `owner_pid`: Electron PID at the time, `21997` before tsup restarted it.
  - `resume_command` remained
    `cursor-agent --model auto --resume 53c58376-3e41-4e89-a417-138712566865`
  - `resume_metadata_json` preserved provider `cursor`, target id
    `53c58376-3e41-4e89-a417-138712566865`, permission mode `default`, model
    `auto`.
- Process tree evidence while the patched resume was alive:
  - `cursor-agent --model auto --resume 53c58376-...` was a child of Electron
    and its own process group.
  - Cursor again spawned AWS MCP sidecars:
    `uv tool uvx awslabs.aws-iac-mcp-server@latest`,
    `uv tool uvx awslabs.aws-pricing-mcp-server@latest`, and their Python
    children.
- Transcript evidence:
  - Old pre-patch resume had zsh/asdf noise:
    `/Users/arul/.asdf/completions/asdf.bash:98: command not found: complete`.
  - The patched follow-up appended
    `MATRIX_CURSOR_AGENT_PATCHED_DIRECT_RESUME_526` without new asdf/zsh
    startup noise.

The latest CUA state after the marker printed showed the Cursor row as
"Add a follow-up" rather than a visible running terminal. It did not need a
Stop click at that point. Reconfirm with `ps` when resuming.

### Fix 1: non-interactive clean shell for resumed CLI sessions

Problem found:

- Resumed ended CLI sessions were being relaunched by starting an interactive
  shell and typing the resume command into it.
- For Cursor this produced user shell startup noise:
  `/Users/arul/.asdf/completions/asdf.bash:98: command not found: complete`.
- It also made process ownership/cleanup harder to reason about.

Patch made:

- `apps/desktop/src/main/services/pty/ptyService.ts`
  - Added `directShellLaunchForCommandLine(...)`.
  - On non-Windows, resumed command lines now launch as:
    `/bin/bash --noprofile --norc -lc <resume command>`.
  - Applied this to:
    - `sendToSession(...)` resume path.
    - `reattachChatCli(...)` resume path.
- `apps/desktop/src/main/services/pty/ptyService.test.ts`
  - Updated tests so resumed CLI follow-ups assert direct non-interactive bash
    spawn instead of typed startup commands.
  - Cursor resumed follow-up test now asserts no startup command is typed before
    readiness and that the follow-up message is submitted normally.
  - OpenCode replay resume test now inspects spawn args.

Validation run:

```bash
PATH=$HOME/.asdf/installs/nodejs/22.13.1/bin:$PATH \
npm --prefix apps/desktop run test -- --run src/main/services/pty/ptyService.test.ts -t "sendToSession|reattach"
```

Result:

- Passed.
- Vitest output: `1 passed`, `21 passed | 118 skipped` inside the filtered file
  run.

Important nuance:

- In `ps`, bash may not remain visible because `bash -lc` can exec the final
  command. That is okay. The evidence to check is: no interactive zsh prompt,
  no `.asdf/completions/asdf.bash` noise, correct resume command, and cleanup of
  the provider process tree.

### Fix 2: Droid Work-tab launches should be interactive, not `droid exec`

Problem found:

- ADE fresh Droid Work-tab launches were built with `droid exec ...`.
- Factory docs and local help say `droid exec` is non-interactive.
- That contradicts the Work-tab expectation and the user's explicit test
  requirement that CLI sessions stay up for a while and support follow-ups.

Patch started:

- `apps/desktop/src/shared/cliLaunch.ts`
  - Fresh Droid Work-tab launches now build an interactive command using
    `droid --settings "$ADE_DROID_SETTINGS" "<prompt>"` through
    `/bin/bash -lc`, not `droid exec`.
  - Droid model IDs now strip ADE's `droid/` prefix before passing them to the
    Factory CLI/settings. Example: `droid/gpt-5.4` becomes `gpt-5.4`.
  - Temporary Droid settings now include:
    - `model`
    - `reasoningEffort`
    - `sessionDefaultSettings.interactionMode`
    - `sessionDefaultSettings.autonomyLevel`
    - for plan/spec mode, `specModeModel` and `specModeReasoningEffort`
  - Droid resume command generation now carries preserved model/reasoning into
    the temp settings file.
- `apps/desktop/src/main/utils/terminalSessionSignals.ts`
  - Mirrored the Droid temp-settings/model-prefix behavior for resume command
    reconstruction from terminal signals.
- `apps/desktop/src/renderer/components/terminals/cliLaunch.test.ts`
  - Updated the Droid launch test to expect an interactive Droid command and
    settings JSON instead of `droid exec`.
  - Added resume override coverage for Droid model/reasoning/autonomy.

This Droid patch has not yet been validated. Run tests before trusting it.

Recommended next validation for this patch:

```bash
PATH=$HOME/.asdf/installs/nodejs/22.13.1/bin:$PATH \
npm --prefix apps/desktop run test -- --run \
  src/renderer/components/terminals/cliLaunch.test.ts \
  src/main/utils/terminalSessionSignals.test.ts \
  -t "Droid|droid|resume-time model"
```

Then run a real Work-tab Droid launch only if Droid auth/subscription is
available. If blocked, capture the exact Droid CLI error and put it in the
final matrix.

### Runtime matrix status

Not complete. Current visible Work-tab rows show broad partial coverage:

- Cursor:
  - Plan long session printed `MATRIX_CURSOR_PLAN_AUTO_LONG_526`.
  - Agent long session printed `MATRIX_CURSOR_AGENT_AUTO_LONG_526`.
  - Ask session printed `MATRIX_CURSOR_ASK_AUTO_CLI_526`.
  - Agent resumed after app reopen printed
    `MATRIX_CURSOR_AGENT_RESUME_AFTER_REOPEN_526`.
  - Patched direct resume smoke printed
    `MATRIX_CURSOR_AGENT_PATCHED_DIRECT_RESUME_526`.
- Claude:
  - Default, Plan, Accept/Edit rows exist and have markers around
    `MATRIX_CLAUDE_*_HAIKU_526`.
  - Need verify exact process cleanup and close/reopen behavior with current
    patch state.
- Codex:
  - Default/Plan/Edit rows exist and have markers around
    `MATRIX_CODEX_*_MED_526` and `MATRIX_CODEX_RESUME_PATCHED_UI_526`.
  - Codex often showed `linear` MCP startup incomplete. Treat that as a real
    runtime startup warning, not a blocker to Codex CLI itself unless the tested
    task needs Linear.
- OpenCode:
  - Edit/Plan rows exist and have markers around
    `MATRIX_OPENCODE_*_BIGPICKLE_526`.
  - One OpenCode Plan row preview still shows Kitty graphics payload text:
    `Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA`. This needs follow-up. It may be an
    ANSI/terminal-preview filtering issue or an old row from before a preview
    fix.
- Droid:
  - Not completed.
  - Droid CLI exists at `/Users/arul/.local/bin/droid`.
  - Must check auth/subscription through the Work tab or harmless local CLI
    probes before claiming coverage.
  - Fresh launch code has just been changed to interactive Droid but is not
    validated.

The matrix needs to be converted from "visible rows exist" into proof:

- For each runtime/mode, query the DB row for `resume_command`,
  `resume_metadata_json`, `status`, `pty_id`, `ended_at`, and transcript path.
- Check transcript markers.
- Check process tree before/after stop/app quit.
- Use UI close/reopen and in-place resume where still missing.

### Performance/resource findings so far

The clearest measured resource issue is provider-side process fan-out, especially
Cursor:

- A single live Cursor session can spawn:
  - `cursor-agent`
  - `uv tool uvx awslabs.aws-iac-mcp-server@latest`
  - `uv tool uvx awslabs.aws-pricing-mcp-server@latest`
  - Python children for those MCP servers.
- Two Cursor sessions produced multiple AWS MCP sidecar trees.
- Earlier samples had `cursor-agent` around hundreds of MB RSS and Python MCP
  sidecars with non-trivial RSS. The latest post-wait sample had smaller Cursor
  RSS but sidecars still present.
- `cursor-agent mcp list` only showed `posthog`; the AWS sidecars appear to be
  coming from Cursor/plugin/runtime configuration outside ADE's direct MCP
  list. Do not disable them with invented flags. Find official Cursor-supported
  config if continuing.

ADE-side issues fixed/started:

- Resume relaunch no longer uses the user's interactive zsh startup path.
- Droid fresh launch is being aligned to interactive sessions so it can stay up
  instead of exiting like an automation command.

Still needed for performance:

- Measure renderer/main churn, not just process RSS.
- Inspect terminal preview/title extraction for hidden or old rows, especially
  the OpenCode Kitty payload preview.
- Confirm stop/delete/app-close cleanup leaves no provider descendants for each
  runtime.

### Commands and queries that were useful

Socket/process checks:

```bash
lsof -nU | rg '/tmp/ade-runtime-(app-control-fixes-d55c0422|ui-clean-up-3470f34e)\\.sock|COMMAND'
ps -axo pid,ppid,pgid,rss,command | rg 'app-control-fixes-d55c0422|cursor-agent|awslabs|opencode|claude|codex|droid'
```

DB row check for the Cursor resume smoke:

```bash
sqlite3 /Users/arul/ADE/.ade/ade.db \
"select id,title,status,pty_id,owner_pid,owner_process_started_at,resume_command,substr(resume_metadata_json,1,300),transcript_path from terminal_sessions where id='b491b60d-5e97-4e8c-8aca-70f652f5f5c8';"
```

Transcript checks:

```bash
tail -n 160 /Users/arul/ADE/.ade/transcripts/b491b60d-5e97-4e8c-8aca-70f652f5f5c8.log
rg -n 'asdf\\.bash|command not found: complete|MATRIX_CURSOR_AGENT_PATCHED_DIRECT_RESUME_526|cursor-agent --model auto --resume' \
  /Users/arul/ADE/.ade/transcripts/b491b60d-5e97-4e8c-8aca-70f652f5f5c8.log
```

Official/help probes:

```bash
codex --help
codex resume --help
claude --help
cursor-agent --help
cursor-agent models
opencode --help
opencode run --help
droid --help
droid exec --help
```

### Immediate next steps when resuming

1. Reconfirm current working tree and do not revert unrelated dirty files.
2. Check no smoke provider process is still running from this handoff:
   ```bash
   ps -axo pid,ppid,pgid,rss,command | rg 'cursor-agent|opencode|claude|codex|droid|awslabs|cli-perf-resource-smoke-20260526'
   ```
3. If the dev app is not running, relaunch with this lane socket. Do not touch
   `/tmp/ade-runtime-ui-clean-up-3470f34e.sock`.
4. Run the focused tests for the unvalidated Droid/CLI launch changes:
   ```bash
   PATH=$HOME/.asdf/installs/nodejs/22.13.1/bin:$PATH \
   npm --prefix apps/desktop run test -- --run \
     src/renderer/components/terminals/cliLaunch.test.ts \
     src/main/utils/terminalSessionSignals.test.ts \
     -t "Droid|droid|resume-time model"
   ```
5. Rerun the PTY focused test if `ptyService.ts` changes further:
   ```bash
   PATH=$HOME/.asdf/installs/nodejs/22.13.1/bin:$PATH \
   npm --prefix apps/desktop run test -- --run \
     src/main/services/pty/ptyService.test.ts \
     -t "sendToSession|reattach"
   ```
6. Use Computer Use to continue the Work-tab matrix. Do not substitute a direct
   CLI run for the Work-tab launch.
7. Finish stop/delete/app-close/reopen proof by runtime.
8. Fix remaining confirmed bugs:
   - OpenCode Kitty graphics payload in previews if reproducible on fresh rows.
   - Any Droid launch/auth/resume issue exposed by Work-tab smoke.
   - Any stale green/deletion guard issue still present after app close/reopen.
9. Only after proof is complete, run broader validation from AGENTS.md as
   appropriate.

### Current cleanup note

At handoff time the latest Cursor patched resume had already printed its marker
and returned to "Add a follow-up" in the Work tab. A final `ps` check should be
done on resume anyway because Cursor sidecars can outlive the obvious row if a
cleanup path regressed.

Final stop-state check after this handoff:

- The dev Electron/Vite/tsup processes launched from this lane were stopped with
  `Ctrl-C`; the dev launcher ran `app.process_cleanup_now`.
- The lane runtime socket remained up and was not killed:
  `/tmp/ade-runtime-app-control-fixes-d55c0422.sock`.
- The other active lane socket was only inspected and was not touched:
  `/tmp/ade-runtime-ui-clean-up-3470f34e.sock`.
- A process check after stopping the dev app still showed provider/runtime
  descendants unrelated to the dev Electron process, including AWS MCP sidecars,
  Claude/Codex sessions, and a Droid `droid exec` process from earlier matrix
  work. Treat these as part of the remaining cleanup/audit work: identify which
  terminal session owns each process from ADE's DB/transcripts, stop them
  through the Work tab where possible, and only kill manually after confirming
  ownership.

## Handoff update: 2026-05-26 16:45 EDT

User asked to stop, update this file, push, and report.

Latest work completed after the prior handoff:

- Validated the previously untested Droid launch patch against the installed
  Droid CLI help:
  - `droid --help` says bare `droid` starts interactive mode and an inline
    prompt starts the same interactive CLI with initial context.
  - `droid exec --help` says `exec` is non-interactive and exposes
    `--auto low|medium|high`, `--model`, `--reasoning-effort`,
    `--spec-model`, and `--spec-reasoning-effort`.
- Confirmed the generated Work-tab Droid command now uses interactive Droid via
  `droid --settings "$ADE_DROID_SETTINGS" "<prompt>"`, not `droid exec`.
- Found and fixed a real resume-metadata bug in
  `apps/desktop/src/main/utils/terminalSessionSignals.ts`:
  - After the interactive Droid settings-file patch, Droid launch metadata
    lived inside the generated `printf %s <json> > "$ADE_DROID_SETTINGS"`
    command.
  - `parseTrackedCliLaunchConfig(...)` was still looking only for plain CLI
    flags or unescaped JSON fragments.
  - Result before fix: a generated Droid edit launch parsed as only
    `{ permissionMode: "plan" }`, losing model, reasoning effort, and autonomy.
  - Result after fix: the same generated launch parses as
    `{ permissionMode: "edit", model: "claude-sonnet-4-6", reasoningEffort:
    "high" }`.
- Updated focused tests:
  - `apps/desktop/src/main/utils/terminalSessionSignals.test.ts` now covers
    generated Droid settings JSON for edit/auto and plan/spec settings.
  - `apps/desktop/src/renderer/components/terminals/cliLaunch.test.ts` now
    asserts the shell-escaped JSON format produced by `quoteShellArg(...)`.

Validation run after this patch:

```bash
PATH=$HOME/.asdf/installs/nodejs/22.13.1/bin:$PATH \
npm --prefix apps/desktop run test -- --run \
  src/renderer/components/terminals/cliLaunch.test.ts \
  src/main/utils/terminalSessionSignals.test.ts
```

Result:

- Passed.
- `2 passed`, `70 passed`.

Runtime/UI state when stopped:

- Dev Electron/Vite/tsup was not running after the user interruption.
- I had restarted this lane's runtime socket during the aborted dev launch
  because the launcher detected a build-hash change:
  `/tmp/ade-runtime-app-control-fixes-d55c0422.sock`.
- This lane runtime should be stopped for this handoff because the user asked
  to stop.
- The other lane socket remains off-limits:
  `/tmp/ade-runtime-ui-clean-up-3470f34e.sock`.
- The Work-tab Computer Use smoke for Droid was not completed. The app state
  was inspected and the Work tab was visible, but no new Droid session was
  launched before the user stopped the run.

Files from this latest stop-point that should be committed/pushed as one
focused follow-up:

- `apps/desktop/src/shared/cliLaunch.ts`
- `apps/desktop/src/main/utils/terminalSessionSignals.ts`
- `apps/desktop/src/main/utils/terminalSessionSignals.test.ts`
- `apps/desktop/src/renderer/components/terminals/cliLaunch.test.ts`
- `codexGoal.md`

Remaining high-priority work:

1. Resume through Codex Computer Use from the Work tab and run an actual Droid
   UI smoke if Droid auth/subscription permits.
2. Finish the runtime matrix and app close/reopen proof for Codex, Claude,
   Cursor, OpenCode, and Droid if available.
3. Clean or account for old smoke sessions and provider sidecars through the
   Work tab, then verify no stale provider descendants remain.
4. Investigate the OpenCode Kitty graphics payload still visible in one old
   Work sidebar preview.
5. Continue performance/resource measurement from real Work-tab UI evidence.

---

# Goal: Make Files tab folder/file clicks instant

Added 2026-05-27 by Claude. Independent of the CLI sessions goal above.

## Symptom

Clicking a folder in the Files tab (primary workspace or any lane) can take
seconds, and frequently throws "Remote ADE service connection failed: timed
out waiting for method ade/actions/call." Once any single call times out, the
RPC client used to mark itself closed and every subsequent click would reject
instantly with the same message until the connection rebuilt — making one
slow call look like a total outage.

A live probe (`/tmp/probe-runtime.mjs` shape) against the running daemon
shows `file.listTree` actually completes in **0–49 ms** for every folder in
the ADE repo (root, `apps`, `apps/desktop`, `.ade`, `node_modules`). So the
runtime itself is fast — the latency is in the architecture around it.

## Why it's slow today

A single folder click in ADE takes **6 hops**:

```
renderer click
  → preload (window.ade.files.listTree)
  → IPC (localRuntimeCallAction)
  → main process (LocalRuntimeConnectionPool.callActionForRoot)
  → unix socket (ade/actions/call JSON-RPC)
  → daemon (ProjectScopeRegistry → fileService.listTree)
  → fs.readdirSync + git status --porcelain
  ← back through every layer
```

VS Code does **two hops** for the same interaction:

```
renderer click
  → main process IPC (fs.readDir)
  → fs.readdir
  ← back
```

ADE routes everything through the daemon because the daemon is the source of
truth for multiple clients (desktop, iOS via WebSocket, `ade code` CLI).
That's the right design for write ops and shared state. But for **read-only
file listing** on a workspace that only the local desktop is attached to,
every extra hop is ceremony.

Other production patterns that mature IDEs use and ADE is missing:

- **OS-level recursive watcher in a separate process.** VS Code uses
  `@parcel/watcher` in a `UtilityProcess` with excludes for `node_modules`,
  `.git/objects`, etc., and pushes change events. ADE re-fetches on demand.
- **Cancellation.** VS Code's `AsyncDataTree` cancels in-flight
  `refreshPromise`s on collapse/navigation. ADE has no cancel path — once a
  `listTree` is queued, it runs to completion.
- **Request dedup.** Two clicks on the same folder fire two requests. VS
  Code dedupes via `subTreeRefreshPromises` keyed by node.
- **Exclude list for the tree.** `.ade/worktrees/` (each lane's full checkout,
  multi-GB) is visible by default with `includeIgnored: true`. Click through
  a worktree and the same scan happens against every duplicate `node_modules`.
- **Background work isolated from the file path.** Lane delete, sync, AI
  orchestration, git ops, and the cr-sqlite writer all run on the daemon's
  one event loop. A heavy mutation can starve concurrent file reads.

## The fix

Four pieces, in order of impact:

### 1. Bypass the daemon for read-only file ops on local workspaces

The biggest single win. The preload already has a fallback path in
`apps/desktop/src/preload/preload.ts:1367-1384`:

```ts
async function callProjectFileRuntimeActionOr<T>(action, request, local) {
  const remote = await callRemoteProjectActionIfBound<T>("file", action, request);
  if (remote.handled) return remote.result;
  const localRuntime = await callLocalProjectActionStrictIfBound<T>("file", action, request);
  return localRuntime.handled ? localRuntime.result : local();
}
```

Today: remote → local daemon → direct IPC (only when no daemon binding).
Change: for read-only file methods (`listTree`, `readFile`, `listWorkspaces`,
`searchText`, `quickOpen`, `watchChanges`), invert the precedence when no
remote runtime is bound and the workspace's root lives on the local
filesystem. Go straight to the existing direct IPC handler
(`IPC.filesListTree`), which runs `fileService.listTree` in the main process.

Write ops (`writeText`, `rename`, `delete`, `createFile`, `createDirectory`)
and git ops keep going through the daemon — they mutate shared state that
other clients need to see.

This change is local to the preload routing function plus the existing main-
process IPC handlers (already exist for the fallback case). Expected folder
click cost: **renderer → main IPC → fs.readdir → back ≈ 5 ms.**

### 2. OS-level recursive watcher with excludes

Add `@parcel/watcher` (same library VS Code uses) per workspace root in a
`UtilityProcess` or worker thread. Watch the whole tree with a hardcoded
exclude list:

```
node_modules/**
.git/objects/**
.git/lfs/**
.ade/worktrees/**       ← Lanes own this; never show in Files tab
.ade/cache/**
.ade/transcripts/**
dist/**
build/**
release/**
release-beta/**
release-alpha/**
.next/**
.vite/**
```

Watcher pushes coalesced (≈100 ms debounce) `fs.changed` events to the
renderer. Files tab marks affected nodes dirty and re-fetches only the
changed parent on next visible render. Replaces today's "refresh whole tree
on any change" pattern.

### 3. Renderer-side request dedup + cancellation

In `FilesPage.tsx`, wrap `window.ade.files.listTree` with an in-flight map
keyed by `${workspaceId}::${parentPath}`. Second call for the same key
reuses the first's promise. On collapse/navigation, abort via
`AbortController` threaded through preload → main → fileService (bail in the
readdir loop).

Match VS Code's `slow` flag: if a single `listTree` hasn't resolved in 800
ms, flip the affected node into a "loading" state with a spinner. Never show
a hard error to the user for a slow read.

### 4. Default-exclude `.ade/worktrees/` from the primary Files tab

Lanes have their own tab and their own workspace switcher. The Files tab
showing the primary workspace should not also recurse into every worktree
checkout. The existing security guard (`isVolatileAdeRuntimePath`) already
refuses calls *into* `.ade/worktrees/`; this just hides the directory entry
itself from the primary workspace's root listing in
`fileService.listTreeNode`.

## Out of scope for this proposal

- The 8 s `LOCAL_RUNTIME_FILE_ACTION_TIMEOUT_MS`. With #1 in place, most
  file ops won't go through the daemon at all. The cascading-failure pattern
  was already fixed on this branch (`runtimeRpcClient` per-call timeout no
  longer tears down the connection).
- Moving lane delete / sync / AI to a worker thread. Worth doing, but not on
  the file-tree critical path once #1 lands.
- Replacing the JSON-RPC daemon with something else. The daemon is the right
  shape; the desktop just shouldn't pretend it's a remote client for
  read-only reads against its own filesystem.

## Acceptance

A click on any folder in the Files tab — primary workspace or a lane — shows
its contents in under 50 ms on the user's hardware, every time, with no
spinner. No "timed out waiting for method ade/actions/call" error appears
under normal use. The `local_runtime.action_slow` diagnostic log (added on
this branch) stays silent for `file.listTree`.

---

# Goal: Diagnose and fix remote machine Connect SSH handshake timeout

Added 2026-05-27 by Codex. Independent of the Files tab timeout goal above,
but in the same class of UX problem: ADE is surfacing a low-level timeout as a
scary generic Electron IPC failure instead of telling the user what actually
failed and what to do next.

Do not start by changing beta runtime upload code. The reported error happens
before ADE starts the remote ADE service.

## Symptom

From the Remote / nearby machines UI, selecting the nearby Mac Studio and
clicking Connect shows:

```text
Error invoking remote method 'ade.remoteRuntime.connect': Error: Timed out while waiting for handshake
```

The user sees this in the ADE beta build after using nearby machine discovery.
The beta build may matter for state isolation and packaging, but it is not the
direct cause of this exact error unless later evidence shows SSH succeeds and
the remote runtime bootstrap then fails.

## Diagnosis

The exact string `Timed out while waiting for handshake` is emitted by `ssh2`
when its `readyTimeout` fires. ADE sets that timeout to 20 seconds in
`apps/desktop/src/main/services/remoteRuntime/sshTransport.ts` while building
the SSH connection config.

The connection path is:

```text
RemoteTargetList Connect button
  -> preload IPC ade.remoteRuntime.connect
  -> RemoteConnectionService.connect(id)
  -> RemoteConnectionPool.connect(id)
  -> bootstrapRemoteRuntime(...)
  -> connectSshWithRoute(target)
  -> ssh2 Client.connect(...)
```

`bootstrapRemoteRuntime` only runs `uname`, checks/uploads the ADE runtime, and
launches `ade rpc --stdio` after `connectSshWithRoute` returns a ready SSH
client. Therefore this error means ADE did not complete SSH handshake to the
selected host/port/user route. It is not a JSON-RPC initialize timeout and not
a remote `ade rpc --stdio` crash.

Current local evidence from this machine:

- `tailscale status` reports `Logged out.`
- `tailscale status --json` reports `BackendState: "NeedsLogin"` and the local
  node key expired at `2026-05-26T21:57:58Z`.
- MagicDNS for `aruls-mac-studio.tail7497a6.ts.net` does not resolve while
  Tailscale is logged out.
- `nc -vz -G 5 100.75.20.63 22` times out.
- `~/.ade-beta/secrets/remote-machines.json` has the Studio saved from
  Tailscale discovery with no `sshUser`, no `sshKeyPath`, no successful
  `lastConnectedAt`, and routes for MagicDNS, host name, and `100.75.20.63`.
- `~/.ade/secrets/remote-machines.json` has a prior known-good non-beta target
  for `admin@100.75.20.63` with `/Users/arul/.ssh/id_ed25519` and a successful
  `lastConnectedAt`.

Backend simulation evidence:

- A direct `ssh2` probe using the same library as ADE fails MagicDNS with
  `getaddrinfo ENOTFOUND aruls-mac-studio.tail7497a6.ts.net`.
- The same direct `ssh2` probe against `100.75.20.63:22` reproduces the exact
  ADE error: `Timed out while waiting for handshake` with
  `level: "client-timeout"`.
- The timeout reproduces for both the beta target's implicit local user
  (`arul`) and the known-good saved user/key (`admin` +
  `/Users/arul/.ssh/id_ed25519`), which means the current failure happens
  before authentication.
- System OpenSSH also times out to `admin@100.75.20.63` with
  `connect to address 100.75.20.63 port 22: Operation timed out`.
- `ssh -G` for both the MagicDNS name and `100.75.20.63` shows default
  host/user/port behavior with no relevant custom host entry; this repro is not
  caused by ADE missing an obvious local SSH config alias.
- `tailscale netcheck` shows ordinary internet/DERP reachability, so the local
  machine has network access; the bad state is specifically Tailscale session /
  tailnet routing for this peer.

Likely root cause for the live repro: beta's nearby-machine flow saved a
Tailscale-discovered SSH target that is not actually reachable from the current
machine because local Tailscale is logged out / expired. ADE then tries SSH port
22 against that route and lets the raw `ssh2` timeout escape through Electron
IPC. Missing beta credentials (`sshUser` and `sshKeyPath`) make the target
weaker than the known-good non-beta saved target, but the observed timeout is
reachability/handshake first, not authentication failure.

## Follow-up diagnosis after Tailscale login

After the user logged back into Tailscale, the reported error changed to:

```text
Error invoking remote method 'ade.remoteRuntime.connect': Error: ADE service is not installed on the remote machine and no bundled ADE service is available for darwin-arm64.
```

This is a different failure stage and proves the original SSH handshake problem
was resolved. ADE now reaches `bootstrapRemoteRuntime`, successfully connects
over SSH, runs `uname -sm`, identifies the remote as `Darwin arm64`, then fails
while trying to find either:

1. an installed remote beta runtime at `$HOME/.ade-beta/bin/ade`, or
2. a local packaged `runtime/ade-darwin-arm64` binary it can upload to the
   remote machine.

Remote evidence from `admin@100.75.20.63`:

- `uname -sm` returns `Darwin arm64`.
- `$HOME` for the SSH user is `/Users/admin`.
- `/Users/admin/.ade-beta/bin/ade` does not exist.
- Running with `ADE_HOME="$HOME/.ade-beta"` and
  `PATH="$HOME/.ade-beta/bin:..."`, `ade --version` is `command not found`.

Local packaging evidence from this checkout:

- `apps/desktop/resources/runtime/ade-darwin-arm64` exists in the dev checkout.
- `apps/desktop/release-alpha/mac-arm64/ADE Alpha.app/Contents/Resources/runtime/ade-darwin-arm64`
  exists.
- The searched local beta app,
  `apps/desktop/release-beta/mac-arm64/Electron.app`, did not show
  `Contents/Resources/runtime/ade-darwin-arm64` or the native deps archive in
  the same way alpha/dev do.

Why this happens in code:

- `remoteBootstrap.ts` chooses the beta remote layout when
  `ADE_PACKAGE_CHANNEL=beta`, so it looks for `$HOME/.ade-beta/bin/ade`.
- It checks `${layout.binaryExpr} --version`; on this Studio that returns
  nothing because the beta runtime binary is absent.
- It calls `bundledRuntimePath(resourcesPath, "darwin-arm64")`, which only
  succeeds if the packaged app resources contain one of:
  - `Resources/runtime/ade-darwin-arm64`
  - `Resources/app.asar.unpacked/runtime/ade-darwin-arm64`
  - `resources/runtime/ade-darwin-arm64` relative to the current process cwd
- In the beta app currently being used, ADE apparently cannot find that local
  packaged runtime artifact, so it cannot upload a fresh remote runtime.
- It then tries `ADE_HOME="$HOME/.ade-beta" PATH="$HOME/.ade-beta/bin:..." ade --version`.
  That also fails because remote beta `ade` is not installed on PATH.
- With no remote runtime version and no local uploadable binary, it throws:
  `ADE service is not installed on the remote machine and no bundled ADE service is available for darwin-arm64.`

So the answer to "does the older beta build matter?" is: yes, it can matter,
but not because beta intentionally disables remote connections. The code has
explicit beta-channel support:

- desktop beta sets `ADE_PACKAGE_CHANNEL=beta` and `ADE_HOME=~/.ade-beta`;
- `remoteBootstrap.ts` maps beta to remote `$HOME/.ade-beta/bin/ade`;
- `buildRemoteRuntimeEnvironmentPrefix` exports `ADE_PACKAGE_CHANNEL="beta"`
  and `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` for the remote runtime command;
- `package.json` includes `resources/runtime -> Contents/Resources/runtime`,
  which is the local upload source for remote ADE service binaries;
- `scripts/package-channel.mjs` materializes host runtime resources before
  packaging channel builds.

That means beta builds are supposed to be able to remote-connect. The failure
mode is that Remote Connect needs the **CLI/runtime** side of beta, not merely
the ADE beta GUI. If the remote has no `$HOME/.ade-beta/bin/ade`, the local beta
app must contain the `darwin-arm64` runtime artifact so ADE can upload it. An
older, raw, or incorrectly packaged beta build can fail this exact way if it
lacks that artifact or if its resources path does not point at it.

One strong clue that the local beta artifact is not a finished ADE Beta package:
the searched app is named `Electron.app`, its `Info.plist` identifies it as
`com.github.Electron` / `Electron`, and no `Contents/Resources/runtime` files
were found under `apps/desktop/release-beta/mac-arm64/Electron.app`. A proper
channel package should be branded as ADE Beta and include
`Contents/Resources/runtime/ade-darwin-arm64` plus
`ade-darwin-arm64.native.tar.gz`.

This should be treated as the second bug after the SSH diagnostics bug:

- The user-facing message is technically accurate but not actionable.
- ADE should report the remote path it checked, the local resource paths it
  checked, and the channel (`beta`) it is using.
- Beta packaging should include the same runtime artifacts as dev/alpha, or the
  remote bootstrap should fall back to a clearly documented installer path.
- Having the ADE beta GUI open on the remote machine should not be implied as
  sufficient unless the beta CLI/runtime install path is actually present.

## Why ADE makes this confusing today

- Discovery treats Tailscale peers as nearby SSH targets even when Tailscale is
  not usable locally.
- The nearby card still offers `Use host` for `tailscale-peer-offline` or
  otherwise unreachable peers if a route string exists.
- Bonjour `_ade-sync._tcp` discovery advertises ADE sync on its own port, but
  the remote runtime connect form defaults SSH to port 22. Discovery does not
  prove that SSH is listening on 22.
- `RemoteTargetList` prefers `machine.tailscaleAddress` before
  `machine.primaryRoute`, even though discovery may already have picked a LAN
  primary route.
- `connectSshWithRoute` throws the last raw `ssh2` error and does not preserve
  a useful per-route/per-username attempt report.
- After a non-auth error on a route, `connectSshWithRoute` skips the remaining
  username candidates for that same route, which can hide whether `admin` would
  have behaved differently than the local macOS username.
- The renderer displays the Electron wrapper:
  `Error invoking remote method 'ade.remoteRuntime.connect': ...`
  instead of an ADE-owned message like "SSH to 100.75.20.63:22 timed out before
  handshake. Tailscale is logged out on this Mac."
- The `ssh2` config path only handles a subset of OpenSSH config
  (`HostName`, `User`, `Port`, `IdentityFile`). If Terminal SSH works because
  of `ProxyJump`, `ProxyCommand`, `Include`, certs, or other OpenSSH behavior,
  ADE's native `ssh2` path may still fail.

## The fix

Implement this as remote-connection reliability and diagnostics, not as a
blind beta retry.

1. Normalize remote connect errors at the main-process boundary.
   - Convert `ssh2` `client-timeout`, auth, DNS, refused, and network errors
     into ADE-owned error objects/messages.
   - Include stage (`tcp/ssh-handshake`, `auth`, `remote-command`,
     `rpc-initialize`), host, port, username, route source, elapsed time, and
     candidate count.
   - Strip Electron IPC wrapper noise before the renderer displays the error.

2. Add structured attempt diagnostics in `connectSshWithRoute`.
   - Record every route + username candidate tried.
   - Record skipped candidates and why they were skipped.
   - Preserve the final user-facing error plus a compact debug payload for logs.
   - Do not lose useful earlier errors when the final candidate is merely the
     last timeout.

3. Gate and preflight nearby machine connects.
   - If `tailscale status` is logged out, `NeedsLogin`, expired, or DNS is not
     usable, mark Tailscale-discovered peers as unavailable and do not offer a
     blind `Use host` / Connect path.
   - Add an SSH preflight for discovered machines before saving or connecting:
     DNS resolution, TCP connect to selected SSH port, and a clear state for
     "sync service found, SSH not verified".
   - Keep Bonjour ADE sync discovery separate from SSH readiness; sync port
     discovery must not imply SSH port 22 is reachable.

4. Fix route and credential selection.
   - Prefer a verified/reachable route over `tailscaleAddress` just because it
     exists.
   - Reuse known-good saved credentials/routes across ADE channels when the
     target identity matches, or at least prompt to use the known-good
     `admin@100.75.20.63` + key instead of saving a blank beta target.
   - Consider continuing to the next username candidate after a timeout when a
     known-good username exists, while still avoiding excessive hangs.

5. Add an OpenSSH-backed probe or fallback.
   - At minimum, detect when `ssh -G <host>` resolves materially different
     settings than ADE's parsed subset and surface that in diagnostics.
   - Preferably allow an OpenSSH transport path for hosts that need
     ProxyJump/ProxyCommand/Include/certs or other behavior `ssh2` does not
     implement.

6. Split remote bootstrap timeouts by stage.
   - TCP/connectivity timeout.
   - SSH ready/handshake timeout.
   - Authentication timeout/failure.
   - Remote command startup/stderr.
   - JSON-RPC initialize timeout.
   Capture stderr from the `ade rpc --stdio` command so post-SSH runtime
   failures do not look like transport timeouts.

7. Verify beta packaging only after SSH is proven reachable.
   - Beta uses local `~/.ade-beta` state and remote `$HOME/.ade-beta/bin/ade`.
   - A normal version mismatch should upload or produce an explicit version /
     capability error after SSH succeeds.
   - Check packaged beta runtime artifacts and host-only fallback behavior, but
     keep that as a separate post-handshake failure mode.
   - Make the "remote runtime missing and no bundled runtime available" error
     actionable by listing the remote path checked, local bundle paths checked,
     resolved channel, remote arch, and next action.
   - Ensure beta packages include `runtime/ade-darwin-arm64` and
     `runtime/ade-darwin-arm64.native.tar.gz` for mac-arm64 releases, matching
     dev/alpha behavior.

## Tests / proof required

- Unit tests for `ssh2` timeout normalization:
  `level: "client-timeout"` becomes an ADE remote-connect error with stage,
  host, port, username, route source, and no Electron wrapper.
- Unit tests for Tailscale discovery states:
  logged out / `NeedsLogin` / expired local node does not present peers as
  connectable SSH targets.
- Unit tests for discovered route priority:
  verified LAN route beats stale Tailscale route; Tailscale route wins only when
  it is the verified reachable route or no LAN route exists.
- Unit tests for route/user candidate diagnostics, including skipped username
  candidates after non-auth failures.
- Renderer tests for the Remote targets UI:
  unavailable Tailscale peers show a concrete blocked state and do not show a
  blind Connect action.
- Unit tests for beta remote bootstrap when SSH succeeds but both remote
  `$HOME/.ade-beta/bin/ade` and local bundled `runtime/ade-darwin-arm64` are
  missing. The thrown error should include channel, remote path, local checked
  paths, arch, and an actionable install/package hint.
- Packaging check for beta mac-arm64 output proving the app contains the
  darwin-arm64 runtime binary and native deps archive in a path
  `bundledRuntimePath` / `bundledNativeDepsPath` can actually find.
- A live smoke after the fix:
  1. With Tailscale logged out, ADE should fail fast with a clear local
     Tailscale/login/reachability message.
  2. After Tailscale login, ADE should either connect to the Mac Studio or fail
     with the precise next stage (auth, remote runtime upload, RPC initialize),
     not a generic handshake timeout.
  3. Beta and non-beta should not diverge silently for the same machine
     identity; if beta lacks credentials that non-beta has, the UI should make
     that visible and actionable.
