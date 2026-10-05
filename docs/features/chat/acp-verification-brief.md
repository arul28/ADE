# ACP Provider Verification Brief

You own the verification of the ACP provider work in this lane. Work
autonomously. Do not wait for the human. Report only when you finish, or when a
decision is genuinely theirs.

## What exists

Read `docs/features/chat/acp-providers-spec.md` first. It is the locked build
spec. Everything below assumes it.

Four new Work providers (`qwen`, `kimi`, `grok`, `copilot`) run over one shared
ACP host. Eight work units build the feature and its verification coverage.

| Area | Path |
|---|---|
| Shared ACP host | `apps/desktop/src/main/services/chat/acpHost/` |
| Dialects | `acpHost/acpDialects/{qwen,kimi,grok,copilot}.ts` |
| Mock agent + matrix | `acpHost/mockAcpAgent.ts`, `acpHost/acpHost.test.ts` |
| Telemetry (usage, cost, account, compaction) | `acpHost/acpTurnTelemetry.ts`, `acpDialects/{grokTelemetry,copilotUsageLedger,qwenUsageLedger,acpAccounts}.ts`, `acpHost/acpTelemetry.test.ts` |
| Chat runtime adapter | `main/services/chat/agentChatService.ts` (`AcpRuntime`, `ensureAcpSessionRuntime`, `runAcpTurn`) |
| Auth probe | `main/services/ai/acpAuthProbe.ts` |
| Executables | `main/services/ai/acpExecutables.ts` |
| Diagnostics | `main/services/ai/acpProviderDiagnostics.ts` |
| Tracked CLI launch | `shared/cliLaunch.ts` |
| Settings UI | `renderer/components/settings/providers/` |
| TUI parity | `apps/ade-cli/src/tuiClient/` |
| iOS parity | `apps/ios/ADE/` |

## The problem you are solving

The human holds no subscription for Qwen, Kimi, or Grok, and does not plan to
test them by hand. **Copilot may be logged in on this machine — check, and if it
is, exercise it for real.** Everything else must be proven under the hood.

Your job: prove each provider works, or name exactly what is broken. Do not
report "tests pass" as proof that a provider works. The existing suites use a
mock agent that ADE itself wrote; a mock cannot falsify a wrong assumption about
a real CLI.

## What to do

### 1. Establish real ground truth per provider

For each of the four, find out what is actually installed and authenticated on
this machine (`acpExecutables.ts` shows where ADE looks). Then, for every
provider whose binary exists:

- Drive the real binary yourself over stdio: `initialize`, `session/new`,
  `session/prompt`, permission round-trip, `session/cancel`, `session/close`.
- Compare the real handshake against the dialect declaration. Every
  `agentCapabilities` claim ADE makes must match what the binary advertises.
- Where ADE declares a capability the binary does not have, that is a defect.
  Where the binary has one ADE ignores, that is a finding.

Record the real `initialize` response for each reachable provider as a fixture.
Fixtures captured from real binaries are worth more than any mock.

Copilot is the priority: if it is authenticated, run a full chat turn through
ADE's own runtime, not just raw stdio. Verify the cancel bug handling
(`stopReason: "end_turn"` after cancel must still read as interrupted).

### 2. Attack the assumptions the mock cannot test

The spec encodes verified vendor facts. Several are load-bearing and were
verified once, on one version. Re-verify what you can and flag what you cannot:

- Grok: the auto-mode neutralization, live-verified 2026-10-05 on 1.0.41
  (installed) and 1.0.46 (throwaway prefix). The load-bearing half is the
  `--permission-mode default` spawn flag plus `_GROK_CLAUDE_MARKER_OVERRIDE=1`
  in the child env; `x.ai/yolo_mode_changed` after `session/new` is
  method-not-found and is only a best-effort extra. In this ask-style mode a cwd
  write raises a real `session/request_permission` ADE can reject, and rejecting
  prevents the write. This holds when the cwd is reached through a symlink. The
  user's `~/.claude/settings.json` `defaultMode` does not leak through with the
  neutralization on.
- Grok: cancel must be a notification, not a request. Re-verified 2026-10-05 on
  1.0.41 and 1.0.46: a `session/cancel` request answers `-32601`, while the
  notification form returns `stopReason:"cancelled"`.
- Grok 1.0.41 (installed) and 1.0.46 (throwaway prefix), live-verified
  2026-10-05: the `initialize` handshake is byte-identical apart from
  `agentVersion` and per-model context-window metadata; `session/new` and
  `session/resume` advertise exactly `model` and `reasoning_effort` (no mode and
  no context-window option over ACP); `session/close` and `session/resume` both
  work. A write offers permission options
  `allow-edits-session`/`allow-once`/`reject-once`; an execute offers
  `always-allow`/`allow-once`/`reject-once`/`reject-always`. On 1.0.46 every
  model reports `_meta.totalContextTokens: 256000` plus a
  `contextWindows: [256000, 500000]` list (1.0.41 reported 500000 for
  grok-4.6/4.5); ADE reads `totalContextTokens`, so its meter follows the
  installed CLI. One live 1.0.46 ping repeated the telemetry shape below with
  extension methods spelled `_x.ai/`. `fixtures/grok.initialize.json` is now
  captured from 1.0.46. Not verified: the `_x.ai/session/update`
  subagent/`auto_compact_*` payloads (no such turn was run).
- Kimi 0.39.1 (baseline) and 2.1.1 (latest), live-verified 2026-10-05: the
  `initialize` handshake is byte-identical apart from `agentInfo.version`;
  `session/close` is advertised and a dummy id returns `{}`; the
  mode/model/thinking `session/set_config_option` exists; unauthenticated
  `session/new` is `-32000 Authentication required`; and `session/cancel` is a
  notification, not a request (a request answers `-32601` on both). Usage is
  wired from the binary's code: one `usage_update` after each settled turn
  (skipped for a model outside Kimi's catalog) and the ACP prompt-result
  `usage` block, both read when present. `fixtures/kimi.initialize.json` is now
  captured from 2.1.1. An authenticated turn is still unconfirmed — this
  machine has no usable Kimi login (the stored subscription credential reports
  "no provider configured") — and that is the check to run. Interactive TUI
  still has no argv prompt.
- Grok 1.0.40 and Copilot 1.0.88 usage: `acpTelemetry.test.ts` replays real
  one-turn captures (`fixtures/grok.live-turn.jsonl`,
  `fixtures/copilot.usage-turn.jsonl`) and the ledger row Copilot wrote for
  that turn (`fixtures/copilot.usage-events.json`). Grok's `auto_compact_*`
  and a Copilot row with an `agent_id` exist only as binary strings and
  fixtures; a long Grok session (80% context) and a Copilot subagent turn
  would confirm them.
- Qwen (verified live on 0.22.3 and 0.25.0; the 0.24.0 fixture is retained):
  `--session-id` vs `--resume`/`--continue` and `--yolo` vs `--approval-mode`
  are parse errors on all three. `session/close` is **not** implemented
  (-32601 on 0.22.3/0.24.0/0.25.0). Cancel is a **notification**: the request
  form answers -32601 on 0.22.3 and 0.25.0, so the dialect sends the
  notification directly. 0.22.3 and 0.25.0 advertise only the `openai` auth
  method; 0.24.0 also advertised `openai-responses`. 0.25.0 dropped `default`
  and `max` from `reasoning_effort` (now none|low|medium|high|xhigh) but still
  accepts `default` as a clear.
- Copilot: `config.json` is JSONC; live 1.0.82 persists `trustedFolders`
  (camelCase — not the `trusted_folders` older notes claimed). ADE writes
  neither: the trust pre-seed is removed and nothing on the Copilot path may
  write `$COPILOT_HOME` again.
- Copilot 1.0.89/1.0.91 ACP: both advertise `loadSession`, image prompts,
  HTTP/SSE MCP, and `session/close`; `session/resume` stays absent and answers
  -32601 on both (verified live 2026-10-05). `config.json` is JSONC; older live
  1.0.82 persisted `trustedFolders` (camelCase — not the `trusted_folders`
  older notes claimed). ADE writes neither: the trust pre-seed is removed and
  nothing on the Copilot path may write `$COPILOT_HOME` again. ACP mode options
  include agent, plan, and autopilot. Headless ACP `session/new` did not
  deadlock without a seed or `--add-dir` on either version, and a cancel
  notification returns `end_turn` on 1.0.89 but `cancelled` on 1.0.91.

- Devin 3000.11.3 (macOS arm64), handshake and unauthenticated methods only,
  verified 2026-10-05 with no login and the binary copied into a temp dir
  (`fixtures/devin.initialize.json`): `session/new` succeeds without a login and
  advertises `mode`/`model` config options; `session/cancel` as a request is
  -32601 (notification is the only form); there is no `session/close`,
  `session/resume`, `session/fork`, or `session/set_model` (all -32601), so
  rejoin is `load_only` and the model is set through the `model` config option;
  an unauthenticated `session/prompt` is -32000 "Please log in to use Devin.
  Use `/login` to authenticate again." Because `session/new` succeeds
  unauthenticated, the auth probe reads Devin as ready without a credential —
  still open. The cloud relay exits "Not logged in" before `initialize`, so
  `devinCloud.ts` stays from an earlier session and was not re-verified.

### 3. Hunt the classes of bug a mock hides

Read the ADE bug classes in `.claude/skills/quality/references/` if present, and
`docs/features/chat/README.md` fragile-wiring section. Then go looking for:

- Stream ordering and the text-flush invariant under real chunk timing.
- Turn lifecycle: every path must reach a terminal `done` so the composer
  releases. Try setup failure, mid-turn kill, permission left open at teardown,
  process exit during a prompt.
- Pool identity: two chats, same lane, different models must not share a
  process. Two chats, same everything, should.
- Resume after a simulated ADE restart: session id persists, replay is
  suppressed when ADE already has a transcript, no duplicate rows.
- Windows-only code paths: read them and reason about correctness even though
  you cannot run them. Process-tree kill, `.cmd` shim prompt delivery, the Kimi
  Git-Bash preflight.
- Permission cancellation: an outstanding permission RPC must be cancelled when
  the turn stops, and must not leave a card stuck in the transcript.

### 4. Widen the automated net where it is thin

Where you find a gap a test could have caught, add the test. Prefer tests that
would fail today if the code were wrong, over tests that restate the
implementation. Extend the run/degrade conformance matrix rather than inventing
a parallel harness. Use recorded real-binary fixtures where you captured them.

Do not add brittle render tests. Do not snapshot-test UI pixels.

### 5. Fix what you find

Fix the defects you can fix safely, in this worktree. Keep each fix narrow and
add the regression test with it. If a fix needs a product decision, or changes
behavior this lane was not asked to change, write it up instead of doing it.

## Rules

- Stay in this lane worktree for all edits. Read-only outside is fine.
- **Do not start the ADE desktop app.** The human drives it and it is
  intentionally down. Everything here is doable headless.
- Do not commit and do not open a PR.
- Never write to the main checkout. Never run `git stash` outside this worktree.
- Do not install tools or packages without asking.
- Do not spend real money. Cheap probes only. Say so if a check needs a paid
  subscription the machine lacks.
- Run typechecks and scoped tests, sharded. Do not run the whole suite serially.

## What to report

A single structured report:

1. Per provider: reachable / authenticated / not installed, and what you proved
   about each — with the evidence, not the intention.
2. Defects found, ranked, each with file:line, a repro, and whether you fixed it.
3. Assumptions in the spec you could NOT verify, and exactly what would verify
   them. Be honest here; unverified is not the same as working.
4. Tests added, and what each would catch.
5. Anything you believe the human must decide.
