# Configuration Schema

ADE's project configuration is stored in one machine-local YAML file and
resolved into a single `EffectiveProjectConfig` that downstream services read
at runtime. This doc describes the shape and resolution rules. The former
repository-committed file is accepted only for one-time, non-executable
carry-over; it is not an input to normal config reads.

Canonical type definitions: `apps/desktop/src/shared/types/config.ts`.
Canonical service: `apps/desktop/src/main/services/config/projectConfigService.ts`
(~3,150 lines; the largest service in the app).

## Files

| File | Scope | VCS | Purpose |
|---|---|---|---|
| `.ade/local.yaml` | Local | gitignored | The only project config file ADE reads: every setting, personal to this machine. |

`.ade/ade.yaml` is **no longer read**. If a legacy file is still in a working
tree, the first snapshot read carries only the non-executable keys
(`project`, `environments`, `github`, `ai`, `linearSync`, `ui`, and `browser`)
into `local.yaml`, with local values winning conflicts. It drops executable
keys (`testSuites`, `laneOverlayPolicies`, `automations`, `laneEnvInit`,
`laneTemplates`, `defaultLaneTemplate`, `git`, and `laneCleanup`), logs one
`projectConfig.carryOver` line with both counts, and then deletes the legacy
file. Deleting it makes the carry-over idempotent; an unreadable file is left
in place, logged as `projectConfig.carryOver.unreadable`, and the project still
opens.

The carried `ai` value is recursively allowlisted: model ids, feature toggles,
feature model overrides, session-intelligence model/enabled flags, and local
provider enabled/auto-detect/preferred-model fields are inert and may carry
over. Permissions, API keys, endpoints, hooks, and commands are skipped and
counted in the carry-over log. The legacy top-level `providers` bag is not
carried because its conflict-resolver entries can execute commands.

`local.yaml` uses the lenient `ProjectConfigFile` shape at parse time and
resolves into the strict `EffectiveProjectConfig` at read time.
`projectConfigService.get()` still returns a `ProjectConfigSnapshot` with
`shared`, `local`, `effective` plus validation and hash metadata — `shared` is
kept on the compatibility shape because callers round-trip it through `save`,
but it is always empty. `save` accepts and discards whatever is passed for it.

`projectConfigService.save({ shared, local })` writes `local.yaml` only. It no
longer promotes a project from the local-only ADE scaffold to the shared one,
because there is no shared config file left to write.

A save that passes `baseLocalHash` (the `trust.localHash` of the snapshot it
was edited from) is refused with `project_config_changed_on_disk` when
`.ade/local.yaml` no longer hashes to it, so an edit made outside ADE (an
editor, an agent) is never written over. Renderer settings save through
`saveProjectLocalConfig` (`renderer/lib/projectLocalConfig.ts`), which re-reads
and re-applies its change up to three times. A save without `baseLocalHash`
(an older client) writes as before. A `local.yaml` that does not parse is
logged by the config reload watcher (`project.config_reload.snapshot_failed`)
and picked up again on the next write.

## Settings that follow the ADE account

Some `local.yaml` keys follow the ADE account, per repository, so every
computer signed in to the account gets them
(`main/services/config/projectConfigAccountLayer.ts`, key table in
`projectConfigAccountKeys.ts`). The rows live in the account store under
`repo:<normalized origin>`, the same scope as automation rules.

| Row | `local.yaml` key |
|---|---|
| `prs.pollIntervalSeconds`, `prs.transcriptGists`, `prs.autoMapByBranch` | `github.prPollingIntervalSeconds`, `github.prTranscriptGists.enabled`, `github.autoMapByBranch` |
| `jira.projectKeys` (joined) | `issueTrackers.jira.projectKeys` |
| `linear.batchLaunchPrompt` | `ui.linearBatchLaunchDefaultPrompt` |
| `ai.<group>`, `ai.chat.<field>` | `ai.*`, except `ai.chat.scheduledWorkPaused`, `ai.chat.continueAfterRestart`, and the `writablePaths` lists, which stay on the computer |
| `lanes.envInit` | `laneEnvInit` |
| `tests.suite.<id>` | one row per entry of `testSuites` |

- **Read.** The account value wins over the file. With no sign-in, no account
  store, or no Git remote, ADE reads the file alone.
- **Move.** When the account syncs, each key the account does not have yet is
  written to it (write-if-absent). A joined list takes the union. A different
  value keeps the account's and records a notice; the person answers with
  "Use this computer's value" or "Keep" where the setting is edited. A joined
  list the account refuses gets a notice too. Until the first move for the
  signed-in account, the file alone is the setting, so nothing replaces this
  computer's values before the move has seen them. After it, a value the file
  got from the account is never moved back: the account's newer value wins.
- **Save.** A changed value goes to the account. A cleared value removes the
  row, and the other computers remove their copy only when it came from the
  account. This computer's own parts (the `writablePaths` lists) stay. When
  the account store refuses the write, the whole save fails with an error, so
  the person can try again; nothing is written to the file alone. Notices
  belong to one repository: after `origin` changes, the old ones are gone. For one release ADE also writes the account values back into
  `local.yaml` (the mirror), so an older ADE on the same computer still reads
  them.
- **Held on this computer.** A value with a credential-shaped key (for
  example `API_TOKEN` in a suite's `env`), a folder path under `cwd`,
  `source`, `dest` or `composePath`, or over 16,000 characters stays in the
  file. Settings names the key and the reason.
- **Checked.** A value from the account must pass the config's own
  validation alone, or this computer ignores it.
- **Stale saves.** `trust.localHash` includes a fingerprint of the account
  values, so a save from a window that read older account values is refused
  with `project_config_changed_on_disk` and re-applied.

## Top-level type

```ts
type ProjectConfigFile = {
  version?: number;
  project?: ProjectIdentityConfig;
  testSuites?: ConfigTestSuiteDefinition[];
  laneOverlayPolicies?: ConfigLaneOverlayPolicy[];
  automations?: ConfigAutomationRule[];
  environments?: EnvironmentMapping[];
  github?: { prPollingIntervalSeconds?: number };
  ai?: AiConfig;
  laneEnvInit?: LaneEnvInitConfig;
  laneTemplates?: ConfigLaneTemplate[];
  defaultLaneTemplate?: string;
  laneCleanup?: LaneCleanupConfig;
  providers?: Record<string, unknown>;
  linearSync?: LinearSyncConfig;
  browser?: ProjectBrowserConfig;
};

type ProjectBrowserConfig = {
  /**
   * Where a link clicked inside ADE opens. `in-app` (default) uses the
   * built-in browser, which carries the authenticated profile;
   * `external` hands it to the system browser. Mod+Click always
   * overrides to external, Shift+Click to in-app.
   */
  linkOpenMode?: "in-app" | "external";
  /**
   * Open a background tab when a terminal in this project prints a
   * dev-server ready line. Defaults to `true`. The tab never steals
   * focus and never opens the pane.
   */
  autoOpenDevServer?: boolean;
};

type ProjectIdentityConfig = {
  /**
   * Project-root-relative path to the icon shown in ADE project
   * tabs/catalogs. `null` explicitly disables automatic icon detection
   * for the project; when omitted, ADE auto-detects.
   */
  iconPath?: string | null;
};
```

`project.iconPath` is the user-overridable input to
`projectIconResolver`. Validation rejects paths outside the project
root or with unsupported extensions (must be one of `.ico`, `.jpeg`,
`.jpg`, `.png`, `.svg`, `.webp`) and enforces a 10 MB cap. The TopBar
tab icon picker (`window.ade.project.chooseIcon` / `removeIcon`)
writes this field; selecting a file outside the project root copies
the bytes into `.ade/project-icons/<contentHash>.<ext>` so the icon
travels with the repo.

`browser` is machine-local by intent — which browser your links open in
is a property of the machine you are sitting at, not of the repository —
so ADE only ever writes it to `.ade/local.yaml`. Both fields are coerced, not passed through: a `linkOpenMode`
that is neither `in-app` nor `external`, or an `autoOpenDevServer` that
is not a boolean, is dropped so a hand-edited typo falls back to the
default instead of silently routing every link to the system browser.
The Settings › Browser section (`settings/BrowserLinksSection.tsx`)
writes both fields.

The lenient `Config*` variants allow every field to be optional so
`local.yaml` can be partial. `projectConfigService`
applies defaults, merges, and validates on every read.

## Tests

```ts
type TestSuiteDefinition = {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number | null;
  tags: TestSuiteTag[];       // "unit" | "lint" | "integration" | "e2e" | "custom"
};
```

Suites run through `testService` (not covered here). Tags categorize suites for test execution and filtering.

## Lane overlay policies

A lane overlay customizes the effective config per lane based on
matching criteria:

```ts
type LaneOverlayPolicy = {
  id: string;
  name: string;
  enabled: boolean;
  match: {
    laneIds?: string[];
    laneTypes?: LaneType[];
    namePattern?: string;        // regex
    branchPattern?: string;      // regex
    tags?: string[];
  };
  overrides: {
    env?: Record<string, string>;
    cwd?: string;
    testSuiteIds?: string[];
    portRange?: { start: number; end: number };
    proxyHostname?: string;
    envInit?: LaneEnvInitConfig;
  };
};
```

Matched via `laneOverlayMatcher.matchLaneOverlayPolicies(lane,
policies)`. Multiple matches merge: later wins per-field except for `testSuiteIds`, which is intersected (allow-list narrowing).

Used by the lane runtime env resolver.

## Lane environment init

```ts
type LaneEnvInitConfig = {
  envFiles?: LaneEnvFileConfig[];
  docker?: LaneDockerConfig;
  dependencies?: LaneDependencyInstallConfig[];
  mountPoints?: LaneMountPointConfig[];
  copyPaths?: LaneCopyPathConfig[];
  setupScript?: LaneSetupScriptConfig;
};
```

Runs when a lane is created. Copies templated env files, starts
docker-compose services, runs install commands, mounts agent profile
paths, copies project-level files into the worktree, and finally runs
the setup script when one is configured.

Every field here, including `copyPaths` and `setupScript`, can be authored in
`local.yaml` or carried in from a local lane template. When both a
project-level and a template/overlay setup script exist the more specific one
wins, and `copyPaths` concatenate. There is no repository-config trust gate;
the setup-script step runs from the local effective config. See
[`lanes/runtime.md`](../lanes/runtime.md#setup-script-execution) for shell
semantics, available environment variables, and failure behavior.

```ts
type LaneSetupScriptConfig = {
  commands?: string[];          // shell command lines, run in order
  unixCommands?: string[];      // used on macOS/Linux instead of `commands`
  windowsCommands?: string[];   // used on Windows instead of `commands`
  scriptPath?: string;          // relative to the project root, run last
  unixScriptPath?: string;
  windowsScriptPath?: string;
  injectPrimaryPath?: boolean;  // expose $PRIMARY_WORKTREE_PATH
};
```

`laneSetupScriptHasWork(script)` (exported from
`src/shared/types/config.ts`) is the shared "is a script configured at
all" predicate: true when any command list or script path is non-empty
after trimming, on any platform. Config parsing, normalization, and the
template editor all use it, so a config carrying only
`injectPrimaryPath` is dropped rather than persisted as a step that
always succeeds without doing anything — and a `windowsCommands`-only
script saved on macOS is not silently thrown away. Choosing what to run
on *this* machine is a separate, platform-aware question answered by
`resolveSetupScriptConfig`.

Config parsing coerces every one of these fields (and `copyPaths`) on
`laneEnvInit`, on `laneOverlayPolicies[].overrides.envInit`, and on
`laneTemplates[]`. All three scopes merge through one kernel,
`services/lanes/laneEnvInitMerge.ts`, rather than per-call-site copies:
list fields concatenate, `docker` shallow-merges, and `setupScript` is
last-wins.

## Lane templates

```ts
type LaneTemplate = {
  id: string;
  name: string;
  description?: string;
  envFiles?: LaneEnvFileConfig[];
  docker?: LaneDockerConfig;
  dependencies?: LaneDependencyInstallConfig[];
  mountPoints?: LaneMountPointConfig[];
  copyPaths?: LaneCopyPathConfig[];
  portRange?: { start: number; end: number };
  envVars?: Record<string, string>;
  setupScript?: LaneSetupScriptConfig;
};
```

Templates provide a reusable init recipe. `copyPaths` and `setupScript`
round-trip through `local.yaml` and are applied with the
rest of the recipe. `portRange` is only a fallback for a lane that holds
no port lease: lane creation takes a lease before the template is
applied, and the lease always outranks the template value — so hand-
editing `portRange` in YAML will not move a normally created lane's
ports. Use `laneOverlayPolicies[].overrides.portRange` to pin a range.
`defaultLaneTemplate` (a
template id) is applied to new lanes. `NO_DEFAULT_LANE_TEMPLATE = "__ade_none__"`
is a sentinel for explicitly overriding an inherited shared default
back to "none" in `local.yaml`.

## Lane cleanup

```ts
type LaneCleanupConfig = {
  /** Archive idle, finished lanes after this many days. Absent or 0 = off. */
  archiveIdleAfterDays?: number;
  /** Free up an archived lane's folder this many days after archiving. Absent = 14; 0 = off. */
  freeUpSpaceAfterDays?: number;
  /** "ask" (default): remind, remove nothing. "auto": remove during the hourly check. */
  freeUpSpaceMode?: "ask" | "auto";
  /** Delete archived lanes this many days after archiving. Absent or 0 = off. */
  deleteArchivedAfterDays?: number;
  /** The automatic delete also deletes the local branch. Never the remote one. */
  deleteLocalBranchOnAutoDelete?: boolean;
  /** Remove build output from lanes idle this many days. Absent = 7; 0 = off. */
  cleanBuildOutputAfterDays?: number;
};
```

Older files with `cleanupIntervalHours`, `autoArchiveAfterHours`,
`maxActiveLanes`, `reclaimArchivedAfterHours` or `autoDeleteArchivedAfterHours`
are read into these day keys and never written back; see
`docs/features/storage-and-recovery/README.md` ("Lane lifecycle rules").

`cleanBuildOutputAfterDays` and `freeUpSpaceAfterDays` are on without being
set: a `local.yaml` with no value gets 7 days of build output and "Ask me"
after 14 days. See
`docs/features/storage-and-recovery/README.md` ("Build output in idle lanes").

Policy enforced by the lane cleanup service. UI lives in
`StorageSection.tsx` (Project → Storage & cleanup → Rules), not
`LaneBehaviorSection.tsx` — that section owns lane *behavior*
(start defaults and templates), not storage rules.

## Port allocation and proxy

Port allocation is runtime-only, not stored in YAML. The
`PortAllocationConfig` is a runtime thing with `basePort`,
`portsPerLane`, `maxPort`.

Proxy is similar — runtime, with `proxyPort` and `hostnameSuffix`
fields, read and written through dedicated IPC.

> There is no Proxy & Preview settings surface. `ProxyAndPreviewSection.tsx`
> was imported by nothing and was deleted in the settings IA rewrite; the
> proxy IPC has no UI today.

OAuth redirect handling (runtime again):

```ts
type OAuthRedirectConfig = {
  enabled: boolean;
  callbackPaths: string[];
  routingMode: "state-parameter" | "hostname";
};
```

## AI config

```ts
type AiConfig = {
  mode?: "guest" | "subscription";
  defaultProvider?: string;
  taskRouting?: Partial<Record<AiTaskRoutingKey, AiTaskRoutingRule>>;
  features?: AiFeatureToggles;
  budgets?: AiBudgets;
  permissions?: AiPermissionSettings;
  conflictResolution?: AiConflictResolutionConfig;
  chat?: AiChatConfig;
  defaultModel?: ModelId;
  apiKeys?: Record<string, string>;       // stored encrypted per provider
  localProviders?: AiLocalProviderConfigs;
  customProviders?: AiCustomProviderConfig[];  // user-defined OpenAI-/Anthropic-compatible providers
  customModelSlugs?: string[];            // extra provider/model slugs pinned as selectable
  disabledProviders?: string[];           // providers switched off in Settings
  workerSafety?: WorkerSafetyPolicy;
  featureModelOverrides?: Partial<Record<AiFeatureKey, string | null>>;
  featureReasoningOverrides?: Partial<Record<AiFeatureKey, string | null>>;
  sessionIntelligence?: SessionIntelligenceConfig;
};
```

`featureModelOverrides` / `featureReasoningOverrides` remain in the
schema for older configs, but Settings no longer offers per-helper
model pickers. Background naming and idle status lines run on one
model: the cheap helper for a Claude, Codex or Cursor session (Haiku 5.5
/ GPT-6 Luna / Composer 2.5), the session's own model for every other
provider, then a deterministic slug. Manual Graph PR create is
title plus optional markdown — ADE does not draft the description.
Live chat compaction stays on
the chat's own provider. Session intelligence
(`sessionIntelligence.titles.enabled`) is not a gate: naming always
runs. Legacy `ai.chat.autoTitleModelId` values still parse into
`sessionIntelligence.titles.*` by `coerceAiConfig`. They are
the chat's own provider.

### Disabled providers

`ai.disabledProviders` holds the ids of providers switched off with the
toggle on a provider's page in Settings → Agents & Models. A disabled
provider keeps its tile (reading **Disabled**) and its page, so the
switch is always findable, and it offers no models anywhere else: it is
dropped from `getAvailableModels`, from the model catalog the pickers,
the phone, and the relay all read, and from the AI status payload.

Ids are lower-cased on read but never validated against the current
provider list — the field crosses the sync wire, and dropping an id a
newer build wrote would silently re-enable a provider on the other
machine. Like `customProviders`, the field uses replace semantics on
merge: the UI writes the whole authoritative list, so an empty array
clears it and an absent key keeps what is stored.

### Custom providers and model slugs

`ai.customProviders` and `ai.customModelSlugs` back the **Advanced —
custom providers & model slugs** block in AI Connections settings. They
let a user add an OpenAI-/Anthropic-compatible provider (or extra model
slugs) that flow into ADE's managed OpenCode server config and the model
picker.

```ts
type AiCustomProviderConfig = {
  id: string;
  name: string;                 // falls back to id when omitted
  baseURL: string;
  npm?: "@ai-sdk/openai-compatible" | "@ai-sdk/openai" | "@ai-sdk/anthropic";
  models: string[];             // provider-local model ids
};
```

`coerceAiConfig` drops any custom-provider entry missing `id`,
`baseURL`, or a non-empty `models` list, and coerces an unrecognized
`npm` value back to `undefined`. `customModelSlugs` are trimmed
`providerId/modelId` strings.

**Both fields must be handled in two places in `projectConfigService`:**
`coerceAiConfig` (validate/parse off disk) and `mergeAiConfig` (fold
shared + local into `effective`). A field added to only one is silently
dropped. Unlike the id-matched array merges elsewhere in this schema,
these two use **replace semantics**: `local` provides the full
authoritative list and wins outright, because the same merge runs on the
`ai.updateConfig` write-patch path where a union would make removals
impossible. Absent keeps the existing list; `[]` clears it. The AI
Connections UI always writes the complete list, never a delta. Any new
`ai.*` field follows the same both-places rule and must also be added to
`AiConfig` in `shared/types/config.ts`.

`AiChatConfig.scheduledWorkPaused?: boolean` is the project-runtime-wide
pause for durable Claude wakeups, cron tasks, and `/loop`. It suppresses
fires and `nextWakeAt` without deleting schedule records. Clearing the pause
causes each overdue schedule to catch up once; recurring cron work then
continues from its next normal occurrence.

`AiChatConfig.piExtensionsEnabled?: boolean` loads the user's own Pi
extensions inside ADE chat, bound to ADE's UI bridge. It **defaults to true**,
matching what `pi` does in a terminal; only an explicit `false` turns it off,
which runs ADE chat with Pi's built-in tools only. The Pi CLI is unaffected
either way. The flag is a ceiling, not a switch: extensions load only in the
modes that grant their tools outright (`edit`, `full-auto`). Read-only
(`plan`) and ask-first (`default`, `auto`, `config-toml`) sessions ignore it,
because enabling extensions drops Pi's flat tool allowlist and an extension
tool cannot be wrapped in an approval card — neither mode's promise would
survive. Personal chats also skip them (no project worktree). Only the user's own `~/.pi/agent/extensions` ever
load — the worker pins Pi's `projectTrusted: false`, so a checked-out
repository's `.pi/extensions` never executes. See
[Chat › Pi UI bridge](../chat/README.md#pi-ui-bridge-ask_user-and-extensions).

`AiChatConfig.claudePluginUiEnabled?: boolean` draws what Claude Code mods show
in ADE chat: status lines, toasts, a band above the prompt and panes. It
**defaults to false**; only an explicit `true` turns it on, because the channel
is private to Claude Code. The mods' hooks
run in the Claude process either way, so this controls the drawing only. See
[Chat › Claude mod UI](../chat/README.md#claude-mod-ui).

`AiChatConfig.promptSuggestionsEnabled?: boolean` suggests the next prompt in
the empty composer for providers that do not send one natively (Claude Code
always does). It **defaults to false**: each completed turn costs one short
call on the chat's helper model. See
[Chat › Next prompt suggestions](../chat/README.md#next-prompt-suggestions).

`AiChatConfig.smartDecisionsEnabled?: boolean` lets ADE ask the Jev decision
model before its built-in rules ("Smart decisions (Jev)"): OpenCode's free Jev
with no sign-in, then the ADE bonus. It **defaults to true**; `false` makes
every Jev call answer `null` with no network call. The group switches
(`smartChatStatusEnabled`, `smartSettleNudgeEnabled`, `smartPaletteEnabled`,
`smartLaneEmojiEnabled`, each default true) turn off one group of features.
`jevZenCreditEnabled?: boolean` (default false) spends the user's own OpenCode
Zen balance on Jev once the free allowance is out, before the bonus. See
[Chat › Jev decisions](../chat/README.md#jev-decisions).

`AiChatConfig.modelHintMode?: "model_and_effort" | "effort_only" | "off"`
controls Jev's model and effort hint in the composer (Settings › Chat ›
Smart decisions). It **defaults to
`model_and_effort`**; `effort_only` never suggests another model; `off` hides
the hint. It needs `smartDecisionsEnabled`. See
[Composer › Model hint](../chat/composer-and-ui.md#composer).

`sessionIntelligence` controls background session naming and
end-of-session summaries:

- `titles.enabled`
- `titles.refreshOnComplete`
- `titles.modelId` (`null` clears a project override)
- `titles.reasoningEffort`
- `summaries.enabled`
- `summaries.modelId` (`null` clears a project override)
- `summaries.reasoningEffort`

`titles.refreshOnComplete` is parsed but is not a gate either. A chat's
title is refined once after its first completed run, and only when ADE
wrote that title itself; a terminal session's title is refreshed at close
whenever an AI provider is available.

`titles.modelId` / `summaries.modelId` are parsed but do not pick the
model. Chat, lane, metadata, handoff, and continuity callers use one
model: the cheap helper for a Claude, Codex or Cursor chat, otherwise
this session's model. An empty list still uses the deterministic name.
CLI title callers use the cheap helper for a Claude, Codex or Cursor
CLI, otherwise `resumeMetadata.launch.model`, and skip AI when neither
exists.

Legacy `ai.chat.autoTitleEnabled`, `ai.chat.autoTitleModelId`, and
`ai.chat.autoTitleRefreshOnComplete` are read on load and migrated
into `sessionIntelligence.titles.*` by `coerceAiConfig`. They are
no longer written back — once a project is loaded, writes go to the
`sessionIntelligence` tree only.

## Automations

Full schema lives in `AutomationRule` (see `config.ts` around line
749). Key slots: `trigger`, `actions`, `execution` (agent session /
built-in), `executor`, `contextSources`,
`guardrails`, `outputs`, `verification`. Triggers cover session end,
git events, file changes, lane lifecycle, Linear webhooks, GitHub
webhooks, and schedules.

`coerceAutomationGuardrails` keeps `confidenceThreshold`, `maxFindings`,
`reserveBudget`, and `activeHours`; there is no duration or dollar
guardrail, so legacy `maxDurationMin` / `budgetUsd` keys are dropped on
load. Optional agent limits (`stopAfterMin`, `stopWhenIdleMin`) are read
from `execution.session` and from `agent-session` actions through
`normalizeAutomationAgentLimits` (`shared/automationLimits.ts`); see
[automations guardrails](../automations/guardrails.md#agent-limits-opt-in).

## Linear sync

```ts
type LinearSyncConfig = {
  enabled?: boolean;
  // workspace IDs, filters, status maps, etc.
};
```

The config service still parses, merges and validates `linearSync`, but no
runtime code reads it. Linear work starts from automation rules (one home
computer per rule) and from the Linear agent's relay claim (the first claim
wins). So `linearSync` stays on the computer and does not follow the account.

## Context refresh events

## Merge rules

The service does a shallow-first, deep-on-known-fields merge:

1. `shared` is the base.
2. `local` overlays per top-level field. For arrays (`testSuites`, `laneTemplates`,
   `automations`, `laneOverlayPolicies`), entries are matched by `id`;
   matches are deep-merged, non-matches from `local` are appended.
3. Scalar fields in `local` override `shared` when set.
4. The merged result is normalized and strict-typed into
   `EffectiveProjectConfig`. Unknown fields produce validation
   warnings rather than errors.

`EffectiveProjectConfig` always has fully-populated defaults for every
`git` field, `version`, and required arrays (empty list if unset). Build
the git block with `defaultEffectiveGitConfig()` from
`shared/types/config.ts` rather than by hand — including in tests — so
adding a git setting doesn't require editing every fixture.



## No trust gate

ADE no longer reads repository-committed `.ade/ade.yaml`. The one-time
carry-over copies only the allowlisted non-executable fields into
`.ade/local.yaml`, drops executable fields, and deletes the legacy file after a
successful read. Current configuration is personal, scoped to an account or to
a machine, and there is no approval verdict to grant or revoke.

`ProjectConfigTrust` remains only as compatibility metadata for the two content
hashes used by change detection; it carries no trust decision and no execution
permission.


## Validation

`ProjectConfigValidationResult` lists issues:

```ts
type ProjectConfigValidationIssue = { path: string; message: string };
```

Issues surface inline in Settings. The validator enforces:

- `id` fields non-empty and unique per array
- `command` arrays non-empty and containing strings
- `cwd` strings (path validation happens at runtime, not here)

Validation is best-effort — the service intentionally does not fail
hard on unknown fields so newer configs remain openable by older app
versions.

## IPC

```
ade.projectConfig.get             → ProjectConfigSnapshot
ade.projectConfig.validate        → ProjectConfigValidationResult
ade.projectConfig.save            → void (triggers reload callbacks)
ade.projectConfig.diffAgainstDisk → ProjectConfigDiff
```

The `changed` event is emitted after every save (private channel
name handled inside `registerIpc.ts`).

## Gotchas

- `.ade/.gitignore` and the human-authored `templates/`
  / `skills/` / `workflows/linear/` / `project-icons/` directories are
  the only `.ade/` paths under version control. The shared
  `.ade/.gitignore` is `*` with explicit allowlist entries, so any new
  runtime file dropped into `.ade/` stays out of git automatically.
- A project saves configuration to `.ade/local.yaml`; it does not promote a
  shared config file. The tracked `.ade/.gitignore` allowlist still controls
  which authored templates, skills, workflows, and icons may be committed.
- Hot-reload of config changes is best-effort. Process env, lane
  overlay policies, and AI mode apply to new launches, not live
  ones.
- Don't edit `.ade/local.yaml` while ADE is open unless you plan to
  click "reload" or let the file watcher pick it up — concurrent
  edits will lose.
- Lane overlay policies evaluate top-to-bottom. If two policies match
  the same lane, later entries overwrite earlier ones for scalar
  fields.
- `NO_DEFAULT_LANE_TEMPLATE` is a sentinel, not a real template ID.
  It exists because a missing `defaultLaneTemplate` in `local.yaml`
  means "inherit from shared"; the sentinel means "inherit nothing".

## Cross-links

- First-run setup dashboard (where suggested config gets seeded):
  [first-run.md](./first-run.md)
