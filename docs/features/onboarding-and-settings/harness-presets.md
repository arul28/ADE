# Harness presets

> **Naming.** The feature is called **Custom** everywhere a user can see it —
> the settings section, the manager page, the model picker's rail tab, the
> wizard. "Harness preset" is the internal name and stays in the ids, the
> types, the file format (`.ade-harness.json`) and this document's headings,
> because renaming storage to match copy breaks every saved link and every
> exported file. The mark is a purple hammer
> (`renderer/components/shared/CustomHammerMark.tsx`), never the ADE logo.

A harness is a saved pairing of a **body** — the agent ADE runs — and a
**brain** — where that agent gets its intelligence. It carries the model, the
thinking level, the permission mode, what subagents run on, a name, an accent
colour, and a logo. Presets live in Settings › Providers › Custom — its own
section below the provider list — and appear as the first tab of every model
picker.

## What a harness holds

| Field | Meaning |
|---|---|
| Harness | One of `claude`, `codex`, `opencode`, `droid`, `pi`, `qwen`, `kimi`, `grok`, `copilot`, `cursor`. |
| Source | `account` (a provider sign-in named by instance id), `key` (a credential in the API-key store, named by id), or `subscription` (a Claude or Codex subscription borrowed inside another harness through ADE's proxy). |
| Model | A model id from the registry, or free text when the source is a key pointing at a custom OpenAI-compatible endpoint. |
| Effort | The model's thinking tier, when it offers tiers. |
| Subagents | A model id, or `Same as main`. |
| Advanced (Claude only) | Per-built-in pins for Explore, Plan, and general-purpose. Each defaults to `Follows subagents`. |
| Permission mode | The harness's own vocabulary — Claude's five modes, Codex's four presets, Droid's five levels, Cursor's machine-reported list, or the runtime's six-value set. |
| Name, accent, logo | The identity a preset is recognised by. The logo is the ADE mark, a provider mark, an uploaded 256×256 PNG, or a generated one. |

A preset never holds a credential. The `key` source stores the credential's id
and label; the key itself stays in the API-key store.

## Where a preset lives

Presets are an account-scoped preference. They persist in the renderer's
`ade.userPreferences.v1` blob under `harnessPresets`, and
`renderer/lib/accountSettingsSync.ts` registers that key so every machine
signed into the same ADE account converges on the same list. The registry's
newer-wins rule applies to the list as a whole: two machines never interleave
half of each other's edits into one preset.

## Building one

The wizard is three steps.

1. **Pick an agent.** Every harness is shown with its real provider mark. A
   harness that is not installed or not signed in shows the reason and stays
   selectable — a preset is a saved intention, not a description of this
   computer.
2. **Pick a brain.** Accounts list their email and plan; stored keys list their
   label and masked tail; subscription rows carry a Sign in button. When the
   host exposes no proxy sign-in, that button is disabled and reads
   "Sign-in through ADE's proxy is not available yet on this host." ADE never
   fakes the sign-in. Below the source list: the model (filtered to the chosen
   source's provider family), the effort, the permission mode, the subagent
   model, and a folded **Advanced** disclosure for Claude's built-in agents.
   Pinning a built-in to a specific model shows the note that the agent now
   runs on ADE's copy of Anthropic's prompt and stops tracking Claude Code.
3. **Name it.** Name, accent colour, and a logo tile — Default (the purple
   hammer), provider logo,
   Upload (which opens a round crop with drag and zoom and writes a 256×256
   PNG), and Generate when the host exposes a generator. A live preview chip
   shows the result.

The chosen body slides in and the brain card snaps onto it in the preset's
accent. Both respect `prefers-reduced-motion`.

## Subscription sources

Choose a subscription source when a preset should use a Claude or Codex
subscription on this machine. Select the provider's subscription in step 2
and choose **Sign in**. ADE opens the provider sign-in page and waits until
the sign-in is complete; the preset wizard does not store or display the
provider credential.

If the host cannot sign in through ADE, the button is disabled and the wizard
explains why. A signed-in subscription can be checked, disabled, or removed
with the local proxy controls without deleting the preset. The preset keeps
using its selected model and source until you edit or delete it.

## Managing them

The list page lays its rows flat on the page — no table inside a box. Each row
reads left to right: the preset's logo, its name, the agent that runs it with
that agent's provider mark, and its models labelled by role (`main`,
`subagents`) with each model's own mark. Each row carries Edit, Rename,
Duplicate, Export, and Delete; Delete asks first. The toolbar holds exactly two
buttons — **Add new** and **Import** — and the explanation of what a custom
setup is sits behind a "?" beside the title rather than in a paragraph under
it.

- **Export** writes a `.ade-harness.json` file. It contains references only —
  the account's instance id or the credential's id, never a key value — and
  drops an uploaded logo over 200 KB with a note saying so.
- **Import** reads a file and opens the wizard prefilled, listing anything this
  computer does not have: a provider account it does not hold, a key it does not
  hold, or a proxy sign-in it cannot perform. Nothing lands in the list until
  you save it, and importing the same file twice makes two presets rather than
  one that silently overwrites itself.

## Choosing one

Every model picker has a **Custom** rail entry above Favorites and Recents,
marked with the purple hammer at the same size as the provider logos beside it.
The rows are drawn exactly like the provider model rows — mark, name, a chip
naming the agent, one muted subtitle — and the caret expands each into a
labelled panel: agent, source, models by role, built-in pins, and permission
mode, each with the logo that says whose it is, so a one-click launch cannot
quietly apply a permission mode you did not see. The search box filters presets
by name, agent, and model. An empty list points at Settings › Providers ›
Custom.

## Launching on a preset

Selecting a preset returns its model id plus `presetId` on the picker's
selection. The id is the only thing that travels: `presetId` rides
`AgentChatCreateArgs`, the chat session, its persisted state, the CLI resume
metadata and `PtyCreateArgs.runtimeCliLaunch`, and the runtime that owns the
lane resolves it against its own preset list, key store and provider accounts.
Nothing resolved — no key, no config path — is ever sent over sync or IPC.

A model reachable through a stored key with no preset around it works the same
way through a second id, `credentialId`: the key's declared `models[]` appear
under that provider in the picker in their own section, and choosing one goes
through the same resolver.

`ade` takes both:

```bash
ade chat create --lane <lane> --preset <preset-id>
ade new chat --mode cli --lane <lane> --provider claude --preset <preset-id>
ade chat create --lane <lane> --provider claude --credential <credential-id>
```

`--preset` and `--credential` are mutually exclusive. Agents discover what
exists through `ade chat models`, `ade providers accounts list`, or the
`harnessPresets[]` and `providerAccounts[]` arrays on `ai.getStatus`; the
`ade-harnesses` skill teaches the whole flow.

### What each source does to the environment

| Source | What the launch gets |
|---|---|
| `account` | The instance's config home as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. A Claude account cannot sign Codex in — that is what the subscription source is for. |
| `key` | A config home ADE owns at `<adeHome>/provider-homes/preset/<presetId>/`, plus the per-harness variables below. |
| `subscription` | The proxy's connection, shaped per harness by `proxyEnv.ts`. The model becomes the proxy's `<prefix>/<model>` routing id. |

### What each harness accepts

| Harness | Key | Subscription | Subagent model |
|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` (no `/v1` suffix). `ANTHROPIC_API_KEY=""` for an OpenRouter endpoint, which rejects a request carrying both an `x-api-key` and a bearer token. | Yes | Yes |
| Codex CLI | `CODEX_HOME` plus a `config.toml` ADE writes there naming one `[model_providers.ade]` block with `env_key = "ADE_PRESET_OPENAI_API_KEY"`. `~/.codex/config.toml` is never touched. | Yes | No |
| OpenCode | A provider block merged into the session's config, not an env var — OpenCode has no "use this key against this endpoint" variable. Needs an endpoint. | Yes | No |
| Droid | `FACTORY_HOME_OVERRIDE` at a preset-owned home, with `custom_models` written into its `.factory/settings.json`. | No | No |
| Qwen Code | `OPENAI_API_KEY`, `OPENAI_BASE_URL`. | No | No |
| Kimi | `MOONSHOT_API_KEY`. | No | No |
| Grok | `XAI_API_KEY`. | No | No |
| GitHub Copilot | `GITHUB_TOKEN`. | No | No |
| Cursor | No. Cursor signs in from its own single-slot store, and a per-preset key would change every other Cursor session on the machine. | No | No |
| Pi | No. Pi reads endpoints and model ids from its own `models.json`; add the provider in Pi instead. | No | No |

An unsupported pairing is a value, not an error: the chat runs on the harness's
own sign-in and says which capability was dropped. It never fails the launch.

### Model ids are passed through

Every other ADE launch path rewrites a Claude model id through its alias table.
A preset's launch does not (`passthroughModelId`), because a preset's model can
be a gateway's spelling — `anthropic/claude-opus-4.5` on OpenRouter — that must
reach the endpoint exactly as typed.

### Claude subagents and built-in pins

A subagent model becomes `CLAUDE_CODE_SUBAGENT_MODEL` plus
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Without the force flag the CLI treats the
value as a default a per-agent setting may override, and "subagents on Haiku"
would silently keep running on the main model.

Pinning Explore, Plan or general-purpose sends an SDK `agents` entry. The SDK
has no "same agent, different model" overlay — an entry replaces the whole
definition — so ADE supplies its own copy of Anthropic's prompt and the
built-in's `disallowedTools` alongside the model. Those copies live in
`shared/claudeBuiltinAgentPrompts.ts` with the CLI version they came from, and
they stop tracking upstream the moment they are used. The wizard says so at the
point of the choice.

### The CLI gate

In CLI mode a preset on **Grok**, **Cursor**, **Copilot** or **Kimi** launches
the native CLI instead: those binaries take no key from the launch, and failing
a launch to protect a capability that never existed there would remove a working
session. The preset is dropped with the reason recorded. CLI-mode surfaces do
not list presets at all, so the choice cannot be made and then ignored.

## Source file map

- `apps/desktop/src/shared/harnessPresets.ts` — the type, validation,
  normalisation, export/import, and the label helpers. No React, no IPC.
- `apps/desktop/src/renderer/state/appStore.ts` — the `harnessPresets` slice and
  its setter, persisted into `ade.userPreferences.v1`.
- `apps/desktop/src/renderer/lib/accountSettingsSync.ts` — registers
  `harnessPresets` as an account-scoped synced setting.
- `apps/desktop/src/main/services/chat/harnessPresetSettings.ts` — reads the
  account-settings cache without confusing an unreadable cache with a confirmed
  empty list, so a temporary read failure cannot prune live preset homes.
- `apps/desktop/src/main/services/chat/harnessPresetCredentialCatalog.ts` —
  resolves direct stored-key launches and OpenCode custom-provider credentials,
  decoding only safe ids and returning the model catalog used by the picker.
- `apps/desktop/src/renderer/components/settings/harnesses/` — the list page,
  the wizard, the logo cropper, and the readers for accounts, keys, harness
  availability, model choices, and permission vocabularies.
- `apps/desktop/src/renderer/components/shared/HarnessLogo.tsx` — the one place
  a preset's mark is drawn.
- `apps/desktop/src/renderer/components/shared/ModelPicker/HarnessPresetList.tsx`
  — the picker's Harnesses tab.
- `apps/desktop/src/main/services/chat/harnessPresetLaunch.ts` — the resolver:
  one preset (or one stored key) in, one launch environment out.
- `apps/desktop/src/main/services/chat/harnessPresetConfigHomes.ts` — the
  per-preset and per-credential config homes the resolver hands a launch:
  creation, owner-only permissions (POSIX mode plus a Windows ACL), and the
  retrying prune of a home whose preset or key is gone.
- `apps/desktop/src/main/services/chat/harnessPresetProxyConnection.ts` — reads
  the local subscription proxy's port, key and route prefix for one provider.
  Resolves only while the proxy is running AND recently healthy; otherwise it
  answers `proxy-stopped` and the preset is dropped with that reason.
- `apps/desktop/src/shared/harnessCredentialProviders.ts` — the one map from a
  harness body to its credential-store provider, shared by launch resolution and
  the settings key surface so a key cannot be filed under one provider and
  launched from another.
- `apps/desktop/src/shared/safeIdentifier.ts` — the containment rule for every
  ADE-owned path or storage-key segment (`.`, `..` and separators rejected), so
  a preset, credential or account id cannot escape the directory ADE owns.
- `apps/ade-cli/src/services/proxy/` — the proxy itself: release resolution and
  hash-verified download (`cliProxyApiRelease.ts`), install and config
  management (`cliProxyApiManagement.ts`), the supervisor that starts, stops and
  health-checks it (`cliProxyApiSupervisor.ts`), the service the `proxy.*`
  actions call (`proxyService.ts`), and the shared env/provider vocabulary
  (`proxyEnv.ts`).
- `apps/desktop/src/main/services/proxy/proxyEnv.ts` — the desktop-side mirror
  of the proxy environment vocabulary, so provider-specific route prefixes and
  credential variables stay identical between desktop launches and the CLI
  supervisor.
- `apps/ade-cli/src/services/providerInstances/providerInstanceStore.ts` — the
  machine's provider accounts: the registry, the base account that is always
  present, default selection, per-provider settings, and the config home each
  account resolves to.
- `apps/desktop/src/shared/claudeBuiltinAgentPrompts.ts` — ADE's copies of the
  three built-in agent prompts, with the CLI version they were taken from.
- `apps/desktop/src/shared/harnessPresetCliGate.ts` — the locked CLI gate.
- `apps/desktop/resources/agent-skills/ade-harnesses/SKILL.md` — how an agent
  discovers and uses a preset.
