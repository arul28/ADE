# Agents

DAEX has no agents hub page. Agents run on three surfaces: the CTO (one
persistent identity per project), regular lane-bound chats, and machine-owned
personal chats. This folder covers what they share: skill delivery, spawning
and reporting, the CLI bridge and roles, and provider sign-in from a chat.

The CTO's identity, memory and prompt live in [CTO](../cto/README.md).
Personal chats live in [Personal chats](../personal-chats/README.md).

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/cli.ts` | The `daex` command (`ade` still works). `daex new chat --mode chat\|cli … [--no-report]` mirrors the New Chat toggle; `daex chat read <session> --limit --max-chars` reads a bounded transcript window across registered projects (`--page --cursor` for older content); `daex chat note\|activity\|ask`, scheduled work, secrets, Linear, iOS, App Control and browser command families. |
| `apps/ade-cli/src/adeRpcServer.ts`, `multiProjectRpcServer.ts`, `runtimeRoles.ts` | The private action RPC, caller roles, multi-project routing. Derives trusted parent→child provenance on `chat.messageSession` / `sendMessage` / `steer` and strips spoofed markers. `resolveSessionBoundRole` keeps a bound session from inheriting CTO authority. See [Tool Registration](tool-registration.md). |
| `apps/ade-cli/src/services/account/accountAuthService.ts` | DAEX account auth for humans, remote agents and CI: loopback OAuth, device authorization, shared `account.session.v1` refresh storage, one refresh-rotation recovery after `invalid_grant`, `ADE_ACCOUNT_TOKEN` credentials. |
| `apps/ade-cli/src/services/agentRegistry.ts` | Provider binaries and `classifyAgentCliError` (missing copy / signed out → the `agentCli` error payload). |
| `apps/ade-cli/src/services/skills/agentSkillCatalogService.ts` | `daex skill list\|show`: project, user and bundled skills, labelled `[project]`, `[user]`, `[bundled]`; `readAgentSkillFile` reads Markdown inside the skill's own folder only. |
| `apps/desktop/resources/agent-skills/` | The one bundled skill tree (`daex-*` skills; packaged as `Resources/agent-skills`). Old `ade-*` names still resolve. |
| `apps/desktop/src/shared/agentSkillRoots.ts` | Resolves skill roots for prompts and `ADE_AGENT_SKILLS_DIRS` (ancestor and home `.claude/skills`, `.agents/skills`, `.ade/skills`, `.codex/skills`, env roots, packaged resources). |
| `apps/desktop/src/shared/adeCliGuidance.ts` | The canonical CLI guidance injected into Work chats, CLI launches, the CTO and phone-started work: finding the CLI, reading skills on demand, row reports, proof, process cleanup. |
| `apps/desktop/src/main/services/skills/skillDelivery.ts` | `logSkillDelivery`: the one `agent_chat.skill_delivery` telemetry point and its mechanism union. |
| `apps/desktop/src/main/services/skills/cursorAgentSkillShim.ts` | Per-lane copy of the bundled skills for Cursor's workspace discovery. |
| `apps/desktop/src/main/services/chat/spawnMissionOwnership.ts` | Which child inputs continue a mission and still wake the parent. |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | Provider-runtime prompt assembly: the shared scheduled-work contract and native-subagent vs DAEX-child routing guidance. |
| `apps/desktop/src/main/services/ai/piInstallation.ts`, `piAuthService.ts` | DAEX's pinned Pi (CLI path, SDK root, agent dir, provider inventory, `blocker`) and in-app Pi sign-in through Pi's own `ModelRuntime.login`. |
| `apps/desktop/src/main/services/agentTools/agentToolsService.ts` | Detects external CLIs on PATH (informational only; DAEX runs its own pinned copies). |
| `apps/desktop/src/main/services/ai/apiKeyStore.ts`, `services/cto/linearCredentialService.ts` | Encrypted provider and Linear credentials with account/device provenance. |
| `apps/desktop/src/main/services/builtInBrowser/desktopBridgeServer.ts`, `builtInBrowserAgentDispatch.ts`; `apps/ade-cli/src/services/builtInBrowser/` | The browser bridge (owner-only socket, no per-chat token) and the remote forwarder for machines with no desktop attached (`remoteBrowserForwarder.ts`, `remoteBrowserTabHosts.ts`, `remoteBrowserBroadcast.ts`). |
| `apps/desktop/src/main/utils/codexComputerUse.ts` | Gate for direct Codex Computer Use: explicit opt-in and OpenAI code-signature check. |
| `apps/desktop/src/renderer/components/chat/ProviderSignInCard.tsx`; `apps/ios/ADE/Views/Work/WorkProviderSignIn.swift` | The sign-in card that replaces the composer when the chat's provider is signed out. |

## Gotchas / fragile areas

- **A bound session never inherits CTO authority.** Role resolution goes
  through `resolveSessionBoundRole` in both RPC servers, and tracked CLI and
  SDK chat environments are stamped `ADE_DEFAULT_ROLE=agent`. The brain may be
  CTO-capable; the child is not.
- **Provenance is host-authored.** `withTrustedAgentProvenance` deletes every
  caller-supplied marker on `chat.messageSession`, `chat.sendMessage` and
  `chat.steer`, then re-derives `spawnDispatch` or `agentRelay` from observed
  identity. Positional calls of those actions are refused. A child cannot
  claim ownership of itself.
- **Never install bundled skills into provider homes** (`~/.claude/skills`,
  `~/.agents/skills`, `~/.cursor/skills`, `~/.factory/skills`,
  `~/.config/opencode/skills`). That leaks DAEX skills into the user's own
  sessions. A DAEX-owned directory handed to one session is fine.
- **Advertised skill roots must exist.** `adePromptAgentSkillRoots` checks the
  disk first; the prompt list is capped, so a dead root costs a real one.
- **Cursor skill shim uses real copies, per lane.** Cursor drops a skill whose
  realpath escapes its roots (and Windows needs privileges for symlinks). One
  root per lane, so a rebuild cannot delete files another chat holds open.
- **Agents cannot settle.** There is no `chat settle`/`session settle` verb.
  Only the person or `autoSettleLaneSessionsOnPrMerge` settles a row.
- **Logins never move between machines.** Download and sign-in run on the
  chat's machine (`useChatRuntimeScope().pin` on desktop).

## Agent surfaces

- **CTO.** One persistent identity per project. See [CTO](../cto/README.md).
- **Regular chats.** Ephemeral, lane-bound, no identity document; state lives
  in the transcript and resumes across restarts. Default models come from
  `apps/desktop/src/shared/model-manifest.json` (see
  [Agent routing](../chat/agent-routing.md)). Claude SDK subagent snapshots
  carry `parent_agent_id`, kept as `parentAgentId` so surfaces can nest real
  hierarchies (absent means depth one).
- **Personal chats.** No visible project; a neutral or assistant prompt and a
  scratch cwd. See [Personal chats](../personal-chats/README.md).

### Row reports and schedules

Any chat or tracked CLI agent can report into its Work row:

- `daex chat note "<text>"`: the row's status line (72 chars max; empty clears).
- `daex chat activity planning|exploring|implementing|testing|debugging|reviewing|shipping|monitoring|clear`:
  refines the detected activity. It never changes the board phase; **Needs
  you** wins; a new user turn clears it.
- `daex chat ask "<question>"`: a persisted **Needs you** state plus a
  time-sensitive push; the next user turn clears it.
- `daex notify --title … [--body …] [--open daex://…]`: a push to the person's
  phones, open to agents, capped at 60 an hour per account
  (`ACCOUNT_NOTIFY_LIMIT_PER_HOUR` in `apps/push-relay`). See
  [Custom notifications](../sync-and-multi-device/push-notifications.md#custom-notifications).
- `daex session snooze <id> --for 1h`: quiets a row without claiming it is done.

Every chat can schedule durable future work (`daex chat scheduled-work create`
or `chat.createScheduledWork`). The schedule is DAEX-owned, so every provider
uses the same scheduler and `messageSession(kind: "wake")` delivery. The shared
prompt asks for relative one-shots for "in N", an explicit offset for absolute
times, treats cron as brain-local, and asks the agent to check the returned
next-run values.

## Bundled skill delivery

Each DAEX-launched session gets the bundled root through
`ADE_AGENT_SKILLS_DIRS` and the compact catalog in the injected guidance, plus
the provider's own channel where one exists:

| Provider | Native channel (`skill_delivery` mechanism) |
|---|---|
| Claude | Agent SDK local plugin via `.claude-plugin/plugin.json` (`claude-plugin`, `claude-listing`); CLI and `claude --bg` launches get `--plugin-dir`. |
| Codex | app-server `skills/extraRoots/set` with `perCwdExtraUserRoots` (`codex-extra-roots`); a runtime too old for it is logged, not silent. |
| OpenCode | `skills.paths` in the generated `OPENCODE_CONFIG` (`opencode-skill-paths`); personal chats get none (one shared server). |
| Pi | `noSkills: true` plus `additionalSkillPaths` (`pi-additional-paths`), so Pi sees exactly DAEX's catalog. |
| Qwen | `skills.directories` in a DAEX-owned system-defaults file under `.ade/cache/qwen-skill-defaults/`, named by `QWEN_CODE_SYSTEM_DEFAULTS_PATH` (`qwen-skill-directories`). Lowest tier, union merge, layered over any existing system defaults. |
| Cursor | Per-lane shim at `<ADE_HOME>/agent-skill-shims/cursor/<lane-key>` passed as an extra `LocalAgentOptions.dirs` root (`cursor-workspace-dirs`); content-hashed; the one read-only path outside the lane the Cursor guard allows. Skipped for personal chats and orchestration leads. A failure falls back to env + catalog. |
| Copilot | SDK session `skillDirectories` (not personal chats). |
| Droid, Kimi, Grok, Muse, Devin, Antigravity | No session-scoped root option without writing a provider home: catalog + `daex skill list --text` / `daex skill show <name> [references/<file>] --text`. |

The CLI path works for every provider and is the fallback for older runtimes.
A large skill keeps rare detail in `references/<topic>.md` listed in a "Detail
files" table.

## Spawning and reporting

Any chat-bound agent can run `daex new chat` (a chat or a tracked CLI
session). The child inherits `orchestrationParentSessionId` from the caller's
`ADE_CHAT_SESSION_ID`; both modes take `--parent`, `--no-parent` and
`--no-report`. Plain shells record no lineage.

- **Subagent** (default): reports to the parent after every turn, steering an
  active parent or waking an idle one.
- **`--no-report`** (stored `spawnKind: "peer"`; `--type peer` still works;
  the UI never says "peer"): posts nothing to the parent. `none` is rejected.
- **`--no-parent`**: an independent session; the launcher is recorded as
  `launchedBySessionId` only for the Focus rule.

Lineage decides only who gets reports; any agent may read, message, interrupt
or stop any chat (`CHAT_ACTION_SCOPE` in `adeRpcServer.ts`). Unattended child
resumption stops once the parent is settled, archived or deleted.

`spawnMissionOwnership.ts` keeps these inputs as mission continuation (the
child still wakes its parent at the end): `scheduledWake`, `spawnCompletion`,
`agentRelay`, `hostContinuation` (older `continuity_recovery` still matched),
`orchestrationOrigin` with a non-`directive` intent, and `deliveryState:
"queued"`. A human message on a subagent does not take over the report
channel; taking over is explicit (**Stop reports to <parent>** in the session
menu, `daex chat demote`, `/session demote`), and **Report back to <parent>**
or `daex chat promote` restores it. A later parent dispatch auto-promotes a
peer child.

A missing parent is noted once and closes the channel; a delivery failure to a
reachable parent becomes one warning after bounded retries. For a CLI child
the lineage lives in `resumeMetadata` and is projected onto
`TerminalSessionSummary` (never `chatSessionId`, which means terminal
ownership). Children get `ADE_PARENT_CHAT_SESSION_ID` and `ADE_SPAWN_KIND`.

There is no orchestration mode: a coordinator spawns helpers with
`daex chat create --type subagent --provider <p> --model <m> [--instance <id>] [--custom-provider <name>]`.
To carry unmerged commits, spawn from a lane created with
`daex lanes create --name <n> --from <branch> --on local` (`--on uncommitted`
copies uncommitted changes too). Runtime mechanics live in
[Chat › Spawn types and completion reporting](../chat/README.md#spawn-types-and-completion-reporting).

## Agent download & auth from chat

DAEX runs its own pinned copy of every agent and downloads it on demand
([agent tools cache](../onboarding-and-settings/agent-tools-cache.md)). When the
chat's machine lacks the copy or is signed out, the error carries an `agentCli`
payload. A missing copy shows `AgentCliAuthCard` with Download/Retry
(`ai.pinnedToolDownload`). Signed out shows the sign-in card in the composer's
place, which runs the provider's own login through the host's runners
(`providerInstances.login*`, `ai.cliLogin*`, `ai.antigravitySignIn*`, Cursor's
login) and resends the turn once the login reads back.

**Pi signs in inside DAEX.** Settings → Providers drives Pi's
`ModelRuntime.login` (`piAuthService.ts`) and renders its URL, device code,
fields or choices as cards; Pi's `AuthStorage` owns `auth.json`. DAEX never
types `/login` into Pi's TUI. Without the Pi SDK (missing, or Node older than
`PI_SDK_MIN_NODE`) the card states the terminal instruction. See
[Agent Routing › Pi sign-in](../chat/agent-routing.md#pi-sign-in).

### DAEX account auth for agents and CI

`daex login` uses a loopback OAuth callback where a browser exists and a
device URL plus code on SSH or headless machines. Non-interactive automation
creates a refresh credential once with `daex account token create` and gives it
to the brain as `ADE_ACCOUNT_TOKEN`. Account actions are CTO-only, and no
agent may remove a machine: `daex machines remove` from a chat raises a card
only the person can answer ("Removing a computer from a chat" in
[sync-and-multi-device](../sync-and-multi-device/README.md)); a chat-less
agent is refused.

## Tool tiers

| Tier | CTO | Regular chat | Personal chat |
|---|:-:|:-:|:-:|
| Provider-native tools (as permitted) | yes | yes | yes |
| DAEX workflow guidance and actions | yes | yes | no |
| CTO operator tools (`spawnChat`, memory, lanes/PRs/git/tests) | yes | no | no |
| Linear tools | when connected | no | no |
| `recordDiscovery` (append-only, hands a finding to the CTO) | yes | yes | no (no project) |

Ordinary chats keep the user's provider config and MCP servers; only a chat
whose embedder asked for `strictMcpConfig` gets DAEX's isolated config. DAEX
names a config key only when it owns it (see
[Provider config ownership](../chat/agent-routing.md#provider-config-ownership)).
The isolated OpenCode server rebuilds its environment and so sets
`OPENCODE_DISABLE_AUTOUPDATE=1` itself.

## Detail docs

- [Tool Registration](tool-registration.md): CLI integration, action RPC, roles, filtering.
- [CTO](../cto/README.md), [Personal chats](../personal-chats/README.md),
  [Chat](../chat/README.md), [Agent routing](../chat/agent-routing.md),
  [Tool system](../chat/tool-system.md).
