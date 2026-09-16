# Configuration Schema

ADE's project configuration is split across two YAML files in every
project and merged into a single `EffectiveProjectConfig` that
downstream services read at runtime. This doc describes the shape,
merge rules, and trust model.

Canonical type definitions: `apps/desktop/src/shared/types/config.ts`.
Canonical service: `apps/desktop/src/main/services/config/projectConfigService.ts`
(~3,150 lines; the largest service in the app).

## Files

| File | Scope | VCS | Purpose |
|---|---|---|---|
| `.ade/local.yaml` | Local | gitignored | The only project config file ADE reads: every setting, personal to this machine. |

`.ade/ade.yaml` is **no longer read**. The committed file was the one channel
through which a repository could hand your machine an executable `command`, a
lane `setupScript`, or an agent prompt; the trust gate that used to guard it is
retired, and ignoring the file is what makes that retirement safe. If a legacy
`.ade/ade.yaml` is still in a working tree, the first snapshot read carries its
non-executable keys over into `local.yaml` — `project`, `environments`,
`github`, `git`, `ai`, `laneCleanup`, `linearSync`, `ui`,
`browser`, with local winning every conflict — drops the executable ones
(`testSuites`, `laneOverlayPolicies`, `automations`, `laneEnvInit`,
`laneTemplates`, `defaultLaneTemplate`), logs one `projectConfig.carryOver`
line with both counts, and then deletes the file from the working tree. Deleting
it is what makes the carry-over idempotent; an unreadable file is left in place,
logged as `projectConfig.carryOver.unreadable`, and the project still opens.

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
kept on the shape because dozens of callers round-trip it through `save`, but it
is always an empty config, and `save` accepts and discards whatever is passed
for it.

`projectConfigService.save({ shared, local })` writes `local.yaml` only. It no
longer promotes a project from the local-only ADE scaffold to the shared one,
because there is no shared config file left to write.

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
  git?: {
    autoRebaseOnHeadChange?: boolean;
    newLaneBaseSource?: "local" | "remote";
    /** How a lane that fell behind its parent is surfaced. */
    rebaseSuggestions?: "off" | "badge" | "banner";
    /** Don't suggest until the lane is at least this far behind. */
    rebaseSuggestionMinBehind?: number;
    /** Max banners stacked above the Lanes list before they collapse. */
    laneBannerBudget?: number;
  };
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
    computeBackend?: "local" | "vps" | "daytona";
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

Every field here, including `copyPaths` and `setupScript`, can be
authored directly in `ade.yaml` / `local.yaml` as well as carried in
from a lane template; when both a project-level and a template/overlay
setup script exist the more specific one wins, and `copyPaths`
concatenate. Because `ade.yaml` is shared (repo-committed), the
setup-script step is gated on the shared config being trusted — see
[`lanes/runtime.md`](../lanes/runtime.md#setup-script-execution) for the
trust gate, shell semantics, available environment variables, and
failure behavior.

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
round-trip through `local.yaml` / `ade.yaml` and are applied with the
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
  maxActiveLanes?: number;
  cleanupIntervalHours?: number;
  autoArchiveAfterHours?: number;
  autoDeleteArchivedAfterHours?: number;
  deleteRemoteBranchOnCleanup?: boolean;
};
```

Policy enforced by the lane cleanup service. UI lives in
`StorageSection.tsx` (Settings > Diagnostics), not
`LaneBehaviorSection.tsx` — that section owns lane *behavior*
(base source, auto-rebase, rebase noise), not storage rules.

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
  orchestrator?: AiOrchestratorConfig;
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
model pickers. Background naming, idle status lines, and commit
suggestions pick a cheap model from the ADE provider that owns the
session (Haiku 4.5 / GPT-5.6 Luna / Composer 2.5), then that session's
model, then a deterministic slug. OpenCode, Droid, Pi, and ACP skip the
cheap helper and use the session model. Manual Graph PR create is
title plus optional markdown — ADE does not draft the description.
Review start still requires an explicit `modelId`.
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

`sessionIntelligence` controls background session naming and
end-of-session summaries:

- `titles.enabled`
- `titles.refreshOnComplete`
- `titles.modelId` (`null` clears a project override)
- `titles.reasoningEffort`
- `summaries.enabled`
- `summaries.modelId` (`null` clears a project override)
- `summaries.reasoningEffort`

Chat, lane, metadata, handoff, and continuity callers walk
`titles.modelId` / `summaries.modelId` and then this session's model.
An empty list still uses the deterministic name. CLI title/summary
callers walk the same settings and then `resumeMetadata.launch.model`,
and skip AI when both are missing.

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

## Linear sync

```ts
type LinearSyncConfig = {
  enabled?: boolean;
  // workspace IDs, filters, status maps, etc.
};
```

Resolved through `projectConfigService.linearSync` and surfaced in
`LinearSection.tsx`.

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

`git.rebaseSuggestions` defaults to `banner`,
`git.rebaseSuggestionMinBehind` to `1`, and `git.laneBannerBudget` to `2`,
which together reproduce the pre-setting behavior. `off` is honored in
`rebaseSuggestionService` *before* the scan runs, so it skips the
remote-tracking fetch and per-lane behind-count rather than just hiding
the result.

## The trust model is retired

Shared config used to be able to introduce commands a user had not approved, so
`ProjectConfigTrust` carried an `approvedSharedHash` and `getExecutableConfig()`
refused while `requiresSharedTrust` was true.

That gate is gone, along with the repo-committed `.ade/ade.yaml` it guarded.
ADE's configuration is personal now — scoped to an account or to a machine —
so nothing arrives from a repository that could run on your computer, and there
is no approval left to grant or to revoke.

Two things are worth recording about why it went rather than being fixed:

- **It was unopenable.** The only control that ever called `confirmTrust` was a
  banner in the Automations tab, and that banner renders solely when the rule
  list contains a shared (non-`local`) rule. A repository with `automations: []`
  — ADE's own among them — could therefore reach a state where test runs and
  lane setup scripts refused, with no user interface anywhere able to clear it.
  The documented `SettingsPage` trust dialog did not exist, and neither did the
  `{ skipTrust: true }` escape hatch the old text described.
- **It was not the boundary it looked like.** `laneEnvInit.dependencies[].command`
  and the Docker compose path both reached `execCommand` through `getEffective()`,
  which never checked trust at all. Only test suites, setup scripts, and manual
  runs of shared automation rules were ever gated.

`ProjectConfigTrust` now carries two content hashes and no verdict. They stay
because change detection still needs them.


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
- A project that has only ever saved local-only state (no shared
  config, no shared icon override, no Linear workflow) keeps `.ade/`
  ignored via `.git/info/exclude` instead of materializing the shared
  `.ade/.gitignore`. The first save that changes shared content (or
  any caller of `ensureSharedAdeProjectScaffold`) promotes the
  scaffold and removes the local exclude rule. After that the project
  behaves like a normal shared-scaffold ADE project.
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
