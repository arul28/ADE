# Configuration schema

A project's configuration is one machine-local file, `.ade/local.yaml`
(gitignored), resolved into a strict `EffectiveProjectConfig` that services
read at runtime. Some keys follow the DAEX account per repository.

## Source file map

- `apps/desktop/src/shared/types/config.ts`: every config type (`ProjectConfigFile`,
  `EffectiveProjectConfig`, `AiConfig`, `LaneEnvInitConfig`, `LaneTemplate`,
  `LaneCleanupConfig`, `AutomationRule`, …), `laneSetupScriptHasWork`,
  `defaultEffectiveGitConfig`, `NO_DEFAULT_LANE_TEMPLATE`,
  `PROJECT_CONFIG_CHANGED_ON_DISK`. Read the types here; this doc does not copy
  them.
- `apps/desktop/src/main/services/config/projectConfigService.ts`: read, coerce,
  merge, validate, save, reload listeners (the largest service in the app).
- `projectConfigCarryOver.ts`: the one-time `.ade/ade.yaml` carry-over.
- `localYamlApiKeys.ts`: moves plaintext `ai.apiKeys` out of the file into the
  machine key store.
- `projectConfigAccountLayer.ts`, `projectConfigAccountKeys.ts`: keys that
  follow the account.
- `laneOverlayMatcher.ts`: lane overlay matching.
- `apps/desktop/src/main/services/lanes/laneEnvInitMerge.ts`: the one merge
  kernel for lane env init.
- `apps/desktop/src/renderer/lib/projectLocalConfig.ts`
  (`saveProjectLocalConfig`): the renderer's save with retry.

## Reading and saving

- `local.yaml` parses into the lenient `ProjectConfigFile` (every field
  optional), then defaults, merges and validates on every read. The parsed file
  is cached by file identity; validation still runs each read.
- `projectConfigService.get()` returns a `ProjectConfigSnapshot` (`shared`,
  `local`, `effective`, validation, hashes). `shared` stays for compatibility
  and is always empty; `save` discards it.
- **Edits made outside DAEX are never overwritten.** A save with
  `baseLocalHash` (the snapshot's `trust.localHash`) is refused with
  `project_config_changed_on_disk` when the file no longer hashes to it.
  `saveProjectLocalConfig` re-reads and re-applies up to three times. The hash
  includes a fingerprint of account values, so a window that read older
  account values is refused too.
- A `local.yaml` that does not parse is logged
  (`project.config_reload.snapshot_failed`) and picked up on the next write.
- **No new plaintext keys.** A write keeps an `ai.apiKeys` entry only when the
  file already holds that exact value; new keys go to the key store first
  (`storeOfferedApiKey`). Existing file keys move to the store
  (`localYamlApiKeys.ts`) unless the store's default holds a different value.

## No trust gate

DAEX does not read repository-committed `.ade/ade.yaml`. If one is in the
working tree, the first read carries only non-executable keys (`project`,
`environments`, `github`, `ai`, `linearSync`, `ui`, `browser`) into
`local.yaml`, local values winning, then deletes the legacy file. Executable
keys (`testSuites`, `laneOverlayPolicies`, `automations`, `laneEnvInit`,
`laneTemplates`, `defaultLaneTemplate`, `git`, `laneCleanup`) and the top-level
`providers` bag are dropped. The carried `ai` value is allowlisted: model ids
and toggles carry; permissions, keys, endpoints, hooks and commands do not. It
logs `projectConfig.carryOver` with counts; an unreadable file is left in place
(`projectConfig.carryOver.unreadable`) and the project still opens.

`ProjectConfigTrust` is only compatibility metadata for the change-detection
hashes. There is no approval verdict and no `getExecutableConfig`; use
`getEffective`.

## Settings that follow the DAEX account

Some keys follow the account per repository (rows under `repo:<normalized
origin>` in the account store, the same scope as automation rules). The key
table is `projectConfigAccountKeys.ts`: PR polling, transcript gists and
branch mapping, Jira project keys (joined), the Linear batch prompt, most of
`ai.*` (`customModelSlugs` joined), `laneEnvInit` and each test suite
(`tests.suite.<id>`). These stay on the computer: `ai.apiKeys` (the key store),
`ai.localProviders`, `ai.customProviders`, `ai.chat.scheduledWorkPaused`,
`ai.chat.continueAfterRestart`, `ai.chat.jevZenCreditEnabled` (spends this
computer's Zen sign-in), the `writablePaths` lists, `browser`, and `linearSync`
(no runtime code reads it).

- **Read**: the account value wins over the file. With no sign-in, no account
  store or no Git remote, the file alone decides.
- **Move**: on sync, each key the account lacks is written to it
  (write-if-absent). A different value keeps the account's and records a notice
  ("Use this computer's value" / "Keep") where the setting is edited. Until the
  first move for the signed-in account, the file alone is the setting. A value
  the file got from the account is never moved back, including after a sign-in
  to another account.
- **Save**: a changed value goes to the account; a cleared value removes the
  row. If the account store refuses, the whole save fails and rows already
  written get their earlier values back.
- **Held on this computer**: a credential-shaped key (for example `API_TOKEN`
  in a suite's `env`), an absolute path in a path key (`cwd`, `source`, `dest`,
  `composePath`, the setup script paths), or a value over 16,000 characters
  stays in the file; Settings says why.
- **Checked**: an account value must pass validation alone, or this computer
  ignores it.
- For one release DAEX mirrors account values into `local.yaml` so an older
  DAEX on the same computer still reads them.

## Notable fields

- **`project.iconPath`**: input to `projectIconResolver`. Must be inside the
  project, one of `.ico .jpeg .jpg .png .svg .webp`, at most 10 MB. A picked
  file outside the project is copied to `.ade/project-icons/<contentHash>.<ext>`.
  `null` turns off auto-detection.
- **`browser`** (`linkOpenMode`: `in-app` | `external`; `autoOpenDevServer`,
  default true): machine-local by intent; invalid values are dropped so a typo
  falls back to the default. Written by `BrowserLinksSection.tsx`.
- **`laneOverlayPolicies`**: match lanes by id, type, name/branch regex or tag
  and override env, cwd, test suites, port range, proxy hostname or env init.
  Multiple matches merge top to bottom (later wins per field); `testSuiteIds`
  intersect.
- **`laneEnvInit`** (env files, docker, dependencies, mount points, copy paths,
  setup script) runs at lane creation. Project, overlay and template scopes
  merge through `laneEnvInitMerge.ts`: lists concatenate, `docker`
  shallow-merges, `setupScript` is last-wins. `laneSetupScriptHasWork` is the
  one "is anything configured" check, so a script with only
  `injectPrimaryPath` is dropped and a Windows-only script saved on macOS is
  kept. Shell semantics:
  [lanes/runtime.md](../lanes/runtime.md#setup-script-execution).
- **`laneTemplates`**, `defaultLaneTemplate`: a template's `portRange` is only a
  fallback; the lane's port lease always wins, so pin a range with an overlay.
  `NO_DEFAULT_LANE_TEMPLATE` (`"__ade_none__"`) means "no default", distinct
  from absent.
- **`laneCleanup`** (day-based keys; build output 7 days and "Ask me" after 14
  days are on without being set). Older hour-based keys are read into day keys
  and never written back. UI: `settings/health/HealthCleanups.tsx`. Rules:
  [Storage and recovery](../storage-and-recovery/README.md).
- **`automations`**: `AutomationRule` in `config.ts`.
  `coerceAutomationGuardrails` drops legacy `maxDurationMin` / `budgetUsd`;
  agent limits come from `normalizeAutomationAgentLimits`
  ([guardrails](../automations/guardrails.md#agent-limits-opt-in)).
- Port allocation, the proxy and OAuth redirect settings are runtime state, not
  YAML.

## AI config

- **Custom providers and model slugs** (`ai.customProviders`,
  `ai.customModelSlugs`) feed DAEX's managed OpenCode config and the model
  picker. `coerceAiConfig` drops a provider missing `id`, `baseURL` or models.
- **`ai.disabledProviders`**: providers switched off on their Settings page.
  They keep their tile and page but offer no models anywhere. Ids are never
  validated against the current provider list (a newer build's id must not
  re-enable a provider elsewhere).
- **Replace semantics.** `customProviders`, `customModelSlugs` and
  `disabledProviders` replace on merge: absent keeps, `[]` clears. The same
  merge runs on the `ai.updateConfig` patch path, where a union would make
  removal impossible. The UI writes whole lists.
- **Chat switches** in `AiChatConfig`: `scheduledWorkPaused` (pause durable
  wakeups, cron and `/loop`; overdue work catches up once),
  `piExtensionsEnabled` (default true; only in `edit` / `full-auto`, only
  `~/.pi/agent/extensions`), `claudePluginUiEnabled` (default false),
  `promptSuggestionsEnabled` (default false), `smartDecisionsEnabled` (default
  true) with its group switches, `jevZenCreditEnabled` (default false),
  `modelHintMode`. Behaviour lives in the [chat docs](../chat/README.md).
- **Helper models are not configurable.** `featureModelOverrides`,
  `featureReasoningOverrides` and `sessionIntelligence.*.modelId` still parse
  but do not pick a model; background naming uses the cheap helper per provider
  (`shared/backgroundUtilityModel.ts`) or the session's model. Legacy
  `ai.chat.autoTitle*` keys migrate into `sessionIntelligence.titles.*` on read
  and are not written back.

## Merge and validation

- `local` is the only real input (`shared` is empty). Arrays of `testSuites`,
  `laneTemplates`, `automations` and `laneOverlayPolicies` merge by `id`.
- `EffectiveProjectConfig` always has full defaults for `git`, `version` and
  required arrays. Build the git block with `defaultEffectiveGitConfig()`, in
  tests too.
- Validation is best-effort: ids non-empty and unique, `command` arrays
  non-empty. Unknown fields warn rather than fail, so older builds open newer
  configs.

## Gotchas

- **New `ai.*` fields need `coerceAiConfig` and `mergeAiConfig`** and the
  `AiConfig` type, or they are dropped silently.
- **`.ade/.gitignore` is `*` plus an allowlist** (`templates/`, `skills/`,
  `workflows/linear/`, `project-icons/`), so new runtime files stay out of git.
- **Hot reload is best-effort.** Process env, overlays and AI mode apply to new
  launches.
- **IPC**: `ade.projectConfig.get`, `validate`, `save`, `diffAgainstDisk`; a
  `changed` event follows every save.
