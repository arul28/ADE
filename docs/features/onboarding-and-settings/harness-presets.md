# Harness presets

> **Naming.** Users see **Custom** (Settings › Providers › Custom, the first tab
> of every model picker); agent-facing text says **Custom provider**. "Harness
> preset" is the internal name and stays in ids, types, the export format
> (`.ade-harness.json`) and these headings, because renaming storage breaks
> saved links and exported files.

A harness preset pairs a **harness** (the program DAEX runs: `claude`, `codex`,
`opencode`, `droid`, `pi`, `qwen`, `kimi`, `grok`, `copilot`, `cursor`) with a
**source** (the account, key or subscription that answers), plus a model, a
thinking level, subagent settings, a name, an accent and a logo. It carries no
permission mode (chosen at launch, like every provider) and never a credential.

## Source file map

- `apps/desktop/src/shared/harnessPresets.ts`: type, validation, export/import,
  and `HARNESS_SUBAGENT_SUPPORT` (per-harness subagent capability, with where
  each entry was read from). `harnessSubagentLaunch.ts`: what subagent
  settings become in each harness's config.
- `apps/desktop/src/shared/harnessRoutes.ts`: pure routing
  (`resolveHarnessRoute`, protocols, known endpoints,
  `OPENCODE_GO_MODEL_PROTOCOLS`, `OPENCODE_ZEN_FREE_TIER_IDS`, the `route.` id
  codec).
- `apps/desktop/src/main/services/chat/harnessPresetLaunch.ts`: the resolver,
  one preset, key or route in, one launch environment out.
- `main/services/chat/harnessRouteLaunch.ts` (secrets, proxy decision,
  per-harness env/config), `harnessRouteCatalog.ts` (`ai.listHarnessRoutes`,
  `ai.harnessLaunchEnv`), `harnessRouteTest.ts` (`ai.testHarnessRoute`),
  `harnessRouteProbes.ts` (saved protocol verdicts), `harnessLaunchPrepare.ts`
  (`prepareHarnessLaunch`), `harnessKeySourceLaunch.ts` (keys that need no
  route), `harnessPresetConfigHomes.ts` (owner-only per-preset homes and their
  prune), `harnessPresetProxyConnection.ts`, `harnessPresetSettings.ts`,
  `harnessPresetCredentialCatalog.ts`, `harnessPresetSubagents.ts`.
- `apps/desktop/src/shared/harnessCredentialProviders.ts`: the one harness →
  key-store provider map. `shared/safeIdentifier.ts`: path-segment containment
  for every DAEX-owned id.
- `apps/desktop/src/shared/claudeBuiltinAgentPrompts.ts`: DAEX's copies of
  Claude Code's built-in agent prompts.
- `apps/desktop/src/shared/harnessPresetCliGate.ts`: the CLI gate.
- `apps/desktop/src/renderer/lib/harnessPresetAccountSync.ts` (save and launch
  checks), `harnessPresetCarry.ts` (rows this build cannot read),
  `harnessLogoCompaction.ts`; the slice in `renderer/state/appStore.ts`.
- `apps/desktop/src/renderer/components/settings/harnesses/`: the section and
  one-page editor (`CustomProvidersSection.tsx`, `CustomProviderDialog.tsx`,
  `CustomProviderModelPane.tsx`), `harnessReach.ts` (what a harness can reach,
  with reasons), `harnessModels.ts`, `harnessSources.ts`,
  `harnessAvailability.ts`, `useHarnessPresets.ts`.
- `renderer/components/shared/ModelPicker/HarnessPresetList.tsx` (the picker
  tab), `sharedCatalogFetch.ts` (the one de-duplicated catalog fetch),
  `renderer/components/shared/HarnessLogo.tsx`.
- `apps/ade-cli/src/services/proxy/`: the local CLIProxyAPI (download,
  config, supervisor, `cliProxyApiUpstreams.ts`, `borrowedLogins.ts`,
  `proxyEnv.ts`; desktop mirror `main/services/proxy/proxyEnv.ts`).
- `apps/desktop/resources/agent-skills/daex-harnesses/SKILL.md`: how agents use
  presets.

## Sources

- `account`: a provider sign-in by instance id. In its own harness it sets
  `CLAUDE_CONFIG_DIR` / `CODEX_HOME`; in another harness (a Codex account in
  Droid) it runs through the proxy on that account's lent login.
- `key`: a credential in the API-key store, by id.
- `opencode`: a provider signed in inside OpenCode (Go, Zen, …), by OpenCode's
  provider id. Its token is read from OpenCode's store at launch, in the main
  process only.
- `subscription`: Grok, Kimi, Devin and Muse sign-ins lent through the proxy;
  older presets with a Claude or Codex subscription now use the default account
  (or a `daex proxy login` login when present).

## Where a preset lives

Presets are an account-scoped preference: `harnessPresets` in the renderer's
`ade.userPreferences.v1`, registered in `renderer/lib/accountSettingsSync.ts`.
Newer-wins applies to the whole list. The brain resolves launches from
`~/.ade/account-settings.json`, so saves and launches must not race:

- **A save waits for the brain.** `useHarnessPresets` awaits the brain's answer;
  on "not yet" the dialog stays open with the reason and Retry. The local copy is
  never rolled back.
- **A launch checks first.** Surfaces that create a chat or CLI on a `presetId`
  confirm through `harnessPresetAccountSync.ts` that the brain holds it, pushing
  the list when it does not. An unreachable brain never blocks the launch. The
  guard only covers this client's brain.
- **A launch carries the preset.** The preload attaches `presetSnapshot` to chat
  create, headless launch and new-lane launch; the receiving brain merges it
  (`mergeHarnessPresetSnapshot`) unless it holds the same or a newer edit.
- **A miss is not remembered** (`reasonCode: "preset-not-found"` /
  `"preset-unreadable"`), so the next turn resolves again.
- **A chat never runs on a fallback.** An unresolvable preset or key fails the
  turn with the reason (`launchRouteBlockReason` in `agentChatService.ts`), and
  anything pre-warmed is torn down.
- **The list must fit one setting** (16,000 characters). Logos are shrunk to a
  small WebP (`harnessLogoCompaction.ts`).
- **Unreadable rows are kept.** Presets from a newer build are written back
  untouched with every save (`harnessPresetCarry.ts`).

A route id (`route.<…>`) carries its whole spec and needs none of this.

## Your accounts in other harnesses

Every Claude and Codex account on this machine, and its Grok, Kimi, Devin and
Muse sign-ins, is a source in every harness that takes an endpoint. DAEX's local
proxy answers using the account's own login, lent by `borrowedLogins.ts`:

- **Only the access token is lent** (`ade-borrow-<provider>-<account>.json`),
  never the refresh token: both vendors rotate it on use, so a copy would sign
  the user's own CLI out.
- **Renewal**: near expiry DAEX asks its pinned CLI to renew its own login
  (Codex app-server `account/read` with `refreshToken`, Claude Code's SDK
  handshake, `grok models`), then re-lends. One renewal per machine at a time.
  Kimi, Devin and Muse have no headless renew; Devin and Muse tokens do not
  expire.
- A launch takes a lent token only with more than a minute left.
- **Antigravity is not lent**: it would hand the proxy a long-lived refresh
  token, and Google has suspended accounts for that.
- On macOS a Codex login in the Keychain is not read (macOS would prompt); the
  launch says how to switch Codex to `"file"`. Linux and Windows read the
  keyring copy (`ai/codexKeyringAuth.ts`).

## Routes: any source in any harness

`resolveHarnessRoute` decides per harness + source + model:

- **native**: a harness's own account, or an OpenCode sign-in inside OpenCode.
- **direct**: harness and model share a protocol (`anthropic`, `openai-chat`,
  `openai-responses`); the harness points straight at the source.
- **proxy**: no shared protocol; CLIProxyAPI translates through one
  `ade-<source>` upstream per source, addressed by prefix
  (`ade-opencode-go/glm-5.3`). OpenAI goes through its Responses API (gpt-5.x
  refuses the chat translation's `max_tokens`). Removing a key drops its
  upstream.
- **impossible**, with a reason: Cursor, Copilot, Kimi and Pi run only on their
  own sign-in; OpenCode Zen free models and an OpenAI sign-in inside OpenCode
  answer only inside OpenCode.

Protocol support is per model, seeded in `OPENCODE_GO_MODEL_PROTOCOLS` and
overridden by a saved **Test** verdict
(`<adeHome>/cache/harness-route-probes.json`). Free-tier models are refused to
outside clients; a Test that meets the refusal records it.

- OpenCode Go needs a stable `x-opencode-session` header: Claude Code gets it
  through `ANTHROPIC_CUSTOM_HEADERS`, Codex and Grok through `env_http_headers`;
  Droid and Qwen go through the proxy.
- **Every async launch entry calls `prepareHarnessLaunch`**: it starts the proxy
  only when missing, writes the upstream and waits (up to 5 s) until the proxy
  lists the model; a request right after a config write fails otherwise.

**Ad-hoc routes**: a pairing never saved (`--via`, or any caller naming harness,
source and model) travels as `route.<base64url(json)>`, which passes the
existing `presetId` checks, so chat, CLI, resume, remote launch and sync work
with no new field. Its config home is `provider-homes/route/<hash>/`, removed
after 30 idle days or when any key is removed (a Droid home holds its key). CLI
sessions started there are imported from that home
([external session import](../terminals-and-sessions/external-session-import.md#where-the-other-clis-sessions-live)).

## Launching on a preset

Only the id travels: `presetId` rides chat create, the session, persisted state,
CLI resume metadata and `PtyCreateArgs.runtimeCliLaunch`, and the runtime that
owns the lane resolves it against its own presets, keys and accounts. Nothing
resolved is sent over sync or IPC. A stored key's declared models work the same
through `credentialId`.

```bash
daex harness providers --text
daex chat create --lane <lane> --custom-provider "DeepSeek on Claude" --model deepseek-v4.1-flash
daex chat create --lane <lane> --provider claude --credential <credential-id> --model <id>
```

The CLI resolves the name (`customProviderRef.ts`: id, then name ignoring case;
duplicates refused). `--model` must match the preset's model. `--via`,
`--custom-provider` and `--credential` are mutually exclusive. Every launch
from an agent, script or DAEX MCP names its model (`launchModelRule.ts`,
`apps/ade-cli/src/modelNameGuard.ts`).

- **Thinking level**: selecting a preset sets the composer to the preset's
  level, from the source model's ladder filtered to what the harness can send.
- **Switching an open chat**: `chat.updateSession` takes `presetId` (harness,
  model and level, with a handoff when the harness changes); a plain model
  pick sends `presetId: null`. `leftLaunchRoute` keeps a left preset from coming
  back.
- **Model ids are passed through** (`passthroughModelId`), never rewritten by
  the Claude alias table, so gateway spellings survive.

### What each harness accepts

| Harness | Key/route launch | Subagent model | Subagent effort |
|---|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""` (never inherited), every model tier pinned to the route's model, context and output limits. Keeps the user's config home (plugins, skills, MCP). | `CLAUDE_CODE_SUBAGENT_MODEL` + `_FORCE=1` | SDK `agents[].effort` |
| Codex | `CODEX_HOME` with a DAEX-written `config.toml` (`[model_providers.ade]`, `env_key = "ADE_PRESET_API_KEY"`) | `agents.default_subagent_model` | `agents.default_subagent_reasoning_effort` |
| OpenCode | a provider block merged into the session config | `agent.<type>.model` | — |
| Droid | `FACTORY_HOME_OVERRIDE` with `customModels` (camelCase) | — | — |
| Qwen | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | — | — |
| Kimi | `KIMI_CODE_HOME` with `[providers.ade]` and an `ade/<model>` alias | — | — |
| Grok | `GROK_HOME` with `[model."<id>"]` and the session header | `[subagents.models]` | — |
| Copilot | `COPILOT_PROVIDER_*` BYOK variables; the Copilot worker passes the same endpoint per session | — | — |
| Pi | `PI_CODING_AGENT_DIR` with an `ade` provider in `models.json` | — | — |
| Cursor | not supported (single-slot key store shared by every session) | — | — |

Config-file harnesses get an owner-only home under
`<adeHome>/provider-homes/preset/<presetId>/`; the user's own config is never
touched. A harness that cannot take a subagent knob shows one sentence, never a
dead control.

**Claude built-in pins.** Pinning Explore, Plan or general-purpose, or setting a
subagent effort, sends an SDK `agents` entry, which replaces the whole
definition. DAEX supplies its copy of Anthropic's prompt
(`claudeBuiltinAgentPrompts.ts`, stamped with
`CLAUDE_BUILTIN_AGENT_PROMPT_SOURCE_VERSION`, re-extracted whenever the SDK pin
moves). Its template holes (shell, Glob/Grep) are filled from Claude's
`system/init` tool list (`claudeCodeInit.ts`). A pinned role stops tracking
upstream; the editor says so.

**The CLI gate.** In CLI mode a preset on Cursor, Copilot or Kimi launches the
native CLI with the reason recorded; CLI surfaces show those as unavailable.

### Running one outside DAEX

`daex harness env "<name>"|<id>|<route-id> --text` (`ai.harnessLaunchEnv`,
CTO-only, secret-bearing) prints exports for `eval` (or `--shell pwsh`) ending
with a shell function that runs DAEX's pinned binary
(`buildHarnessLaunchEnv`). It waits for the pin's download and exits non-zero
when the pin is unavailable. The path printed is the brain machine's.

## Managing them

Each list row has Edit, Rename, Duplicate, Export and Delete. **Export** writes
`.ade-harness.json` with references only (instance or credential ids, never a
key); a logo over 200 KB is dropped with a note. **Import** opens the editor
prefilled and lists what this computer lacks; nothing is saved until the person
saves, and importing twice makes two presets.
