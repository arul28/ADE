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

- Grok: the auto-mode neutralization (`x.ai/yolo_mode_changed` after
  `session/new`) and that permissions actually prompt. The user's
  `~/.claude/settings.json` `defaultMode` leaks into Grok; confirm ADE defeats
  it. This is the single most important Grok check.
- Grok: cancel must be a notification, not a request.
- Kimi 0.39.1: `session/close` is advertised and implemented. Usage on the wire
  is still unverified. Interactive TUI still has no argv prompt.
- Qwen 0.22.3: `--session-id` vs `--resume`/`--continue` and `--yolo` vs
  `--approval-mode` are parse errors. `session/close` is **not** implemented.
- Copilot: `config.json` is JSONC; live 1.0.82 persists `trustedFolders`
  (camelCase — not the `trusted_folders` older notes claimed). ADE writes
  neither: the trust pre-seed is removed and nothing on the Copilot path may
  write `$COPILOT_HOME` again.
  Headless ACP `session/new` did not deadlock without a seed or `--add-dir`.
  Cwd writes emit 0 `session/request_permission` with `allow_all` off.

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
