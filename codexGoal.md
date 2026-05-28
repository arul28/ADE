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
