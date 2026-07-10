# Configuration Schema

ADE's project configuration is split across two YAML files in every
project and merged into a single `EffectiveProjectConfig` that
downstream services read at runtime. This doc describes the shape,
merge rules, and trust model.

Canonical type definitions: `apps/desktop/src/shared/types/config.ts`.
Canonical service: `apps/desktop/src/main/services/config/projectConfigService.ts`
(~2,870 lines; the largest service in the app).

## Files

| File | Scope | VCS | Purpose |
|---|---|---|---|
| `.ade/ade.yaml` | Shared | committed | Team-wide process, stack, test, overlay, automation, AI, lane template, proxy, and OAuth settings. |
| `.ade/local.yaml` | Local | gitignored | Personal overrides: ports, env vars, local-only processes, machine-specific paths. |

Both files use the lenient `ProjectConfigFile` shape at parse time.
They are merged into the strict `EffectiveProjectConfig` at read
time. `projectConfigService.get()` returns a `ProjectConfigSnapshot`
with all three (`shared`, `local`, `effective`) plus validation and
trust metadata.

`projectConfigService.save({ shared, local })` is also the seam that
promotes a project from the **local-only ADE scaffold** to the **shared
scaffold**. Saving with any non-empty shared content
(`hasSharedConfigContent(shared)` checks for processes, stack buttons,
test suites, overlays, automations, environments, github/git/ai
metadata, lane init, lane templates, lane cleanup, providers, linear
sync, notifications, or a `project` block) calls
`ensureSharedAdeProjectScaffold(projectRoot)` so the canonical
`.ade/.gitignore` and `ade.yaml` exist before the
write hits disk and `.git/info/exclude` is scrubbed. Saves that only
change `local` skip the shared write entirely (so a brand-new project
can stay local-only) and re-run `initializeOrRepairAdeProject` in auto
mode to keep the local-only `.git/info/exclude .ade/` rule in place.

## Top-level type

```ts
type ProjectConfigFile = {
  version?: number;
  project?: ProjectIdentityConfig;
  processes?: ConfigProcessDefinition[];
  processGroups?: ConfigProcessGroupDefinition[];
  stackButtons?: ConfigStackButtonDefinition[];
  testSuites?: ConfigTestSuiteDefinition[];
  laneOverlayPolicies?: ConfigLaneOverlayPolicy[];
  automations?: ConfigAutomationRule[];
  environments?: EnvironmentMapping[];
  github?: { prPollingIntervalSeconds?: number };
  git?: { autoRebaseOnHeadChange?: boolean };
  ai?: AiConfig;
  laneEnvInit?: LaneEnvInitConfig;
  laneTemplates?: ConfigLaneTemplate[];
  defaultLaneTemplate?: string;
  laneCleanup?: LaneCleanupConfig;
  providers?: Record<string, unknown>;
  linearSync?: LinearSyncConfig;
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

The lenient `Config*` variants allow every field to be optional so
`ade.yaml` and `local.yaml` can be partial. `projectConfigService`
applies defaults, merges, and validates on every read.

## Processes

```ts
type ProcessDefinition = {
  id: string;
  name: string;
  command: string[];          // e.g. ["npm", "run", "dev"]
  cwd: string;                // relative to lane worktree
  env: Record<string, string>;
  groupIds: string[];         // refs into processGroups, for Run-page filtering
  autostart: boolean;
  restart: "never" | "on-failure" | "always" | "on_crash";
  gracefulShutdownMs: number;
  dependsOn: string[];        // IDs of other processes
  readiness:
    | { type: "none" }
    | { type: "port"; port: number }
    | { type: "logRegex"; pattern: string };
};
```

Consumed by `processService`. See
[../terminals-and-sessions/pty-and-processes.md](../terminals-and-sessions/pty-and-processes.md)
for the lifecycle and backoff details.

`groupIds` is purely a UI organization concept. The Run page's group
chip row filters the visible command cards to those whose `groupIds`
include the active chip; it does **not** affect start order or
dependency resolution (those belong to `dependsOn` and stacks). Shared
and local configs merge `groupIds` by entry: if `local.yaml` specifies
`groupIds` for a process, it replaces the shared value entirely;
otherwise the shared value is preserved.

## Process groups

```ts
type ProcessGroupDefinition = {
  id: string;
  name: string;
};
```

`EffectiveProjectConfig.processGroups` is merged `by id` across shared
and local, with `name` falling back to `id` when a group was declared
without one. Validation requires non-empty `id`, unique `id` per array,
non-empty `name` (pre-fallback), and any `ProcessDefinition.groupIds`
entry to reference an existing group. Groups persist in shared config
(`.ade/ade.yaml`) because they represent project-wide categorization;
local config rarely introduces its own groups, but merging is supported
for completeness.

## Stacks

```ts
type StackButtonDefinition = {
  id: string;
  name: string;
  processIds: string[];
  startOrder: "parallel" | "dependency";
};
```

A stack is a named collection of processes that start/stop together.
`dependency` ordering runs topologically with cycle detection.
Stacks and process groups are deliberately separate concepts: stacks
define execution bundles (Start/Stop/Restart All), groups define
filter categories in the Run page.

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

Suites run through `testService` (not covered here). Tags drive the
Run tab's filter chips.

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
    processIds?: string[];       // allow-list filter
    testSuiteIds?: string[];
    portRange?: { start: number; end: number };
    proxyHostname?: string;
    computeBackend?: "local" | "vps" | "daytona";
    envInit?: LaneEnvInitConfig;
  };
};
```

Matched via `laneOverlayMatcher.matchLaneOverlayPolicies(lane,
policies)`. Multiple matches merge: later wins per-field except for
`processIds` and `testSuiteIds`, which are intersected (allow-list
narrowing).

Used by `processService.getLaneOverlay()` and the lane runtime env
resolver.

## Lane environment init

```ts
type LaneEnvInitConfig = {
  envFiles?: LaneEnvFileConfig[];
  docker?: LaneDockerConfig;
  dependencies?: LaneDependencyInstallConfig[];
  mountPoints?: LaneMountPointConfig[];
  copyPaths?: LaneCopyPathConfig[];
};
```

Runs when a lane is created. Copies templated env files, starts
docker-compose services, runs install commands, mounts agent profile
paths, and copies project-level files into the worktree.

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

Templates provide a reusable init recipe. `defaultLaneTemplate` (a
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
`LaneBehaviorSection.tsx`.

## Port allocation and proxy

Port allocation is runtime-only, not stored in YAML. The
`PortAllocationConfig` is a runtime thing with `basePort`,
`portsPerLane`, `maxPort`.

Proxy is similar — runtime, with `proxyPort` and `hostnameSuffix`
fields. Settings > Proxy & Preview reads/writes these through
dedicated IPC.

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
  workerSafety?: WorkerSafetyPolicy;
  featureModelOverrides?: Partial<Record<AiFeatureKey, string | null>>;
  featureReasoningOverrides?: Partial<Record<AiFeatureKey, string | null>>;
  sessionIntelligence?: SessionIntelligenceConfig;
};
```

`effective.ai.mode` is the source of truth for guest vs subscription
behavior. Legacy `providers.mode` migration is still in the service
but idempotent.

`AiChatConfig.scheduledWorkPaused?: boolean` is the project-runtime-wide
pause for durable Claude wakeups, cron tasks, and `/loop`. It suppresses
fires and `nextWakeAt` without deleting schedule records. Clearing the pause
causes each overdue schedule to catch up once; recurring cron work then
continues from its next normal occurrence.

`sessionIntelligence` controls background session naming and
end-of-session summaries:

- `titles.enabled`
- `titles.refreshOnComplete`
- `titles.modelId` (`null` clears a project override)
- `titles.reasoningEffort`
- `summaries.enabled`
- `summaries.modelId` (`null` clears a project override)
- `summaries.reasoningEffort`

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
2. `local` overlays per top-level field. For arrays (`processes`,
   `processGroups`, `stackButtons`, `testSuites`, `laneTemplates`,
   `automations`, `laneOverlayPolicies`), entries are matched by `id`;
   matches are deep-merged, non-matches from `local` are appended.
3. Scalar fields in `local` override `shared` when set.
4. The merged result is normalized and strict-typed into
   `EffectiveProjectConfig`. Unknown fields produce validation
   warnings rather than errors.

`EffectiveProjectConfig` always has fully-populated defaults for
`git.autoRebaseOnHeadChange`, `version`, and required arrays (empty
list if unset).

## Trust model

Shared config can introduce new commands that the user has not
approved. `ProjectConfigTrust` tracks:

- `sharedHash` — current sha256 of `ade.yaml`
- `localHash` — current sha256 of `local.yaml`
- `approvedSharedHash` — last sha the user trusted
- `requiresSharedTrust` — `sharedHash !== approvedSharedHash`

`getExecutableConfig()` throws if `requiresSharedTrust` is true —
callers that bypass must use `{ skipTrust: true }` deliberately.

The trust confirmation dialog (rendered from `RunPage` and
`SettingsPage`) calls `projectConfigService.confirmTrust()`, which
writes the new approved hash. The Automations tab exposes the same
`confirmTrust()` via a `Trust config` banner, but only when the rule
list contains a shared-config (non-`local`) rule; `runRuleNow` blocks
a manual run solely for rules defined in `.ade/ade.yaml`, so
local-only automations keep running while shared config is untrusted.

Local config is not trust-gated; users only need to trust their own
overrides.

## Validation

`ProjectConfigValidationResult` lists issues:

```ts
type ProjectConfigValidationIssue = { path: string; message: string };
```

Issues surface in the config editor inline (Run tab editor and
Settings). The validator enforces:

- `id` fields non-empty and unique per array
- `command` arrays non-empty and containing strings
- `cwd` strings (path validation happens at runtime, not here)
- `restart` values in the allowed set
- readiness discriminator matches its payload shape
- `dependsOn` entries reference existing process IDs

Validation is best-effort — the service intentionally does not fail
hard on unknown fields so newer configs remain openable by older app
versions.

## IPC

```
ade.projectConfig.get             → ProjectConfigSnapshot
ade.projectConfig.validate        → ProjectConfigValidationResult
ade.projectConfig.save            → void (triggers reload callbacks)
ade.projectConfig.diffAgainstDisk → ProjectConfigDiff
ade.projectConfig.confirmTrust    → void
```

The `changed` event is emitted after every save (private channel
name handled inside `registerIpc.ts`).

## Gotchas

- `.ade/.gitignore`, `ade.yaml`, and the human-authored `templates/`
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
- Don't edit `.ade/ade.yaml` while ADE is open unless you plan to
  click "reload" or let the file watcher pick it up — concurrent
  edits will lose.
- Trust confirmation is per-project-per-user. Cloning a repo and
  opening it will require confirming trust on the shared config.
- Lane overlay policies evaluate top-to-bottom. If two policies match
  the same lane, later entries overwrite earlier ones for scalar
  fields.
- `NO_DEFAULT_LANE_TEMPLATE` is a sentinel, not a real template ID.
  It exists because a missing `defaultLaneTemplate` in `local.yaml`
  means "inherit from shared"; the sentinel means "inherit nothing".

## Cross-links

- Stack lifecycle and process wiring:
  [../terminals-and-sessions/pty-and-processes.md](../terminals-and-sessions/pty-and-processes.md)
- Run tab UI and config editor:
  [../project-home/README.md](../project-home/README.md)
- First-run setup dashboard (where suggested config gets seeded):
  [first-run.md](./first-run.md)
