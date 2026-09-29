# Harness presets

> **Naming.** The feature is called **Custom** everywhere a user can see it —
> the settings section, the manager page, the model picker's rail tab, the
> wizard. "Harness preset" is the internal name and stays in the ids, the
> types, the file format (`.ade-harness.json`) and this document's headings,
> because renaming storage to match copy breaks every saved link and every
> exported file. The mark is a purple gear-and-wrench mark
> (`renderer/components/shared/CustomToolMark.tsx`), never the ADE logo.

A harness preset pairs a **harness** — the program ADE runs — with a **model
provider** — the account, key, or subscription that answers for it. It carries
the model, the thinking level, what subagents run on, a name, an accent colour,
and a logo.

It does not carry a permission mode. Permission tiers belong to the harness and
are chosen at launch, the same way every other provider does it, so a preset
can never disagree with the composer.

Presets live in Settings › Providers › Custom — its own section below the
provider list — and appear as the first tab of every model picker.

## What a harness holds

| Field | Meaning |
|---|---|
| Harness | One of `claude`, `codex`, `opencode`, `droid`, `pi`, `qwen`, `kimi`, `grok`, `copilot`, `cursor`. |
| Source | `account` (a provider sign-in named by instance id), `key` (a credential in the API-key store, named by id), `opencode` (a provider signed in *inside OpenCode* — OpenCode Go, Zen, or anything connected there — named by OpenCode's provider id), or `subscription` (a Claude or Codex subscription borrowed inside another harness through ADE's proxy). |
| Model | A model id. The wizard reads the same live catalog the composer's picker uses, so a runtime-discovered provider (Cursor, OpenCode, Pi, the ACP providers) lists its real models. Free text survives for exactly two cases: a key pointing at a custom OpenAI-compatible endpoint that declares no models of its own, and a first-class key provider that neither the static registry nor the catalog can enumerate (OpenRouter, Google, DeepSeek, Mistral, Groq, Together). |
| Effort | The model's thinking tier, when it offers tiers. |
| Subagents | A model id, or `Same as main`. |
| Advanced (Claude only) | Per-built-in pins for Explore, Plan, and general-purpose. Each defaults to `Follows subagents`. |
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

1. **Pick a harness.** Every harness is shown with its real provider mark. A
   harness that is not installed or not signed in shows the reason and stays
   selectable — a preset is a saved intention, not a description of this
   computer.
2. **Pick a model provider.** The list is split into two groups. **Your
   accounts and keys** holds the provider sign-ins and the stored API keys;
   accounts list their email and plan, keys list their label and masked tail.
   **Through ADE's proxy** holds the subscription rows, each with a Sign in
   button. When the host exposes no proxy sign-in, that button is disabled and
   reads "Sign-in through ADE's proxy is not available yet on this host." ADE
   never fakes the sign-in. A group with no rows shows no heading. Below the
   list: the model, the effort, the subagent model, and a folded **Advanced**
   disclosure for Claude's built-in agents. Pinning a built-in to a specific
   model shows the note that the agent now runs on ADE's copy of Anthropic's
   prompt and stops tracking Claude Code.
3. **Name it.** Name, accent colour, and a logo tile — Default (the purple
   gear-and-wrench mark), provider logo,
   Upload (which opens a round crop with drag and zoom and writes a 256×256
   PNG), and Generate when the host exposes a generator. A live preview chip
   shows the result.

The chosen harness slides in and the model card snaps onto it in the preset's
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
reads left to right: the preset's logo, its name, the harness that runs it with
that harness's provider mark, and its models labelled by role (`main`,
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
marked with the purple gear-and-wrench mark at the same size as the provider logos beside it.
The rows are drawn exactly like the provider model rows — mark, name, a chip
naming the harness, one muted subtitle — and the caret expands each into a
labelled panel: harness, source, models by role, and built-in pins, each with
the logo that says whose it is, so a one-click launch shows everything it is
about to apply. The search box filters presets by name, harness, and model. An empty list points at Settings › Providers ›
Custom.

## Routes: any source in any harness

Every harness speaks one or a few wire protocols (`anthropic`,
`openai-chat`, `openai-responses`) and every source answers on one or a few
endpoints. `shared/harnessRoutes.ts` decides, per harness + source + model:

- **native** — a harness's own account (a Claude account in Claude Code), or
  an OpenCode sign-in inside OpenCode. No endpoint is involved.
- **direct** — the harness and the model share a protocol, so the harness is
  pointed straight at the source's endpoint (OpenCode Go's
  `inference/go/anthropic` into Claude Code, DeepSeek's `/anthropic`).
- **proxy** — no shared protocol; ADE's local CLIProxyAPI translates. ADE
  writes one `ade-<source>` upstream per source (per credential for a key)
  into the proxy's config, which hot-reloads, and the harness asks for the
  model through that entry's prefix (`ade-opencode-go/glm-5.3`), so two
  sources serving the same model id never mix. Removing a key drops its
  upstream, so its secret does not outlive it there.
- **impossible** — with the reason (Cursor, Copilot, Kimi and Pi only run on
  their own sign-in; OpenCode Zen's free models only answer inside OpenCode).

Protocol support is **per model**. OpenCode Go serves DeepSeek, Kimi K3, Qwen
and MiniMax on its Anthropic endpoint, GLM, Hy, MiMo and LongCat on OpenAI chat
only, and GPT/Grok on Responses only (measured 2026-09-29, seeded in
`OPENCODE_GO_MODEL_PROTOCOLS`). A Test (below) overrides the seed: its verdict
is saved in `<adeHome>/cache/harness-route-probes.json` and every launch reads
it.

OpenCode Go rejects any request without a stable `x-opencode-session`
header. Claude Code gets it through `ANTHROPIC_CUSTOM_HEADERS`, Codex and Grok
through `env_http_headers` bound to `ADE_ROUTE_SESSION_ID`. Harnesses that
cannot set a header (Droid, Qwen) are sent through the proxy, whose
per-harness upstream adds one.

A plan built on an OpenCode OAuth token carries the token's expiry; a chat
that outlives it resolves again and picks up the refreshed token.

A route needs the proxy running before the synchronous resolver can point a
harness at it, so every async launch entry (chat create and send, PTY create,
CLI-from-chat, the brain's CLI and remote-launch actions) first calls
`prepareHarnessLaunch`, which starts the proxy only when that is the one
missing piece.

### Ad-hoc routes

A model picked in the composer's "Run in" view without a saved preset travels
as a preset id of the form `route.<base64url(json)>` — the harness, the source
reference and the model, never a secret. base64url passes the safe-identifier
check every launch surface already applies to `presetId`, so an ad-hoc choice
gets chat, CLI, resume, remote launch and sync with no new wire field. Its
private config home lives under `provider-homes/route/<hash>/`, outside the
preset namespace the orphan pruner sweeps. Route homes idle for 30 days are
removed, and removing any key removes them all (they are rebuilt on the next
launch), because a Droid route home holds its key.

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

`--preset` and `--credential` are mutually exclusive. `--via <source>` with
`--provider` and `--model` builds an ad-hoc route id (`ade harness routes
--text` lists what each harness can reach; `ade harness test` checks one). Agents discover what
exists through `ade chat models`, `ade providers accounts list`, or the
`harnessPresets[]` and `providerAccounts[]` arrays on `ai.getStatus`; the
`ade-harnesses` skill teaches the whole flow.

### What each source does to the environment

| Source | What the launch gets |
|---|---|
| `account` | The instance's config home as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. A Claude account cannot sign Codex in — that is what the subscription source is for. |
| `key` / `opencode` | The route's endpoint and token, per harness below. Harnesses that read a config file (Codex, Grok, Droid) get one in a home ADE owns at `<adeHome>/provider-homes/preset/<presetId>/`; Claude Code needs none and keeps the user's own config home, so their plugins, skills and MCP servers still load. The OpenCode token is read from OpenCode's store at launch, in the main process only. |
| `subscription` | The proxy's connection, shaped per harness by `proxyEnv.ts`. The model becomes the proxy's `<prefix>/<model>` routing id. |

### What each harness accepts

| Harness | Key | Subscription | Subagent model |
|---|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` (no `/v1`), `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""` (never inherited — a shell key would reach another vendor as `x-api-key`), `ANTHROPIC_MODEL` and every tier (`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`) pinned to the route's model so background calls do not ask another vendor for Haiku, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from the model's real limits. | Yes | Yes |
| Codex CLI | `CODEX_HOME` plus a `config.toml` ADE writes there naming one `[model_providers.ade]` block (`wire_api = "responses"`, `env_key = "ADE_PRESET_API_KEY"`, `model_context_window` from the model's limits). `~/.codex/config.toml` is never touched. | Yes | No |
| OpenCode | A provider block merged into the session's config, not an env var — OpenCode has no "use this key against this endpoint" variable. Needs an endpoint. | Yes | No |
| Droid | `FACTORY_HOME_OVERRIDE` at a preset-owned home, with `custom_models` written into its `.factory/settings.json`. | No | No |
| Qwen Code | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`. | No | No |
| Kimi | `MOONSHOT_API_KEY`. | No | No |
| Grok | `GROK_HOME` at a preset-owned home whose `config.toml` defines `[model."<id>"]` with the route's `base_url`, `api_backend` (`messages`, `chat_completions` or `responses`), `env_key` and the session header. | Yes (via proxy) | No |
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
`shared/claudeBuiltinAgentPrompts.ts`, stamped with the CLI version they came
from (`CLAUDE_BUILTIN_AGENT_PROMPT_SOURCE_VERSION`) and re-extracted from the
pinned binary whenever the SDK pin moves; a pinned agent stops tracking upstream
the moment it is used. The wizard says so at the point of the choice.

### The CLI gate

In CLI mode a preset on **Cursor**, **Copilot** or **Kimi** launches the native
CLI instead: those binaries take no key or endpoint from the launch, and
failing a launch to protect a capability that never existed there would remove
a working session. The preset is dropped with the reason recorded. CLI-mode
surfaces list presets and routes for every other harness and show these three
as unavailable with the reason, so the choice cannot be made and then ignored.

### Running one outside ADE

`ade harness env <preset-id|route-id> --text` prints the launch's exports
(zsh/bash, or `--shell pwsh`) for `eval`, and the Copy launcher button builds
the matching `claude --model …` / `codex -m …` command. The output contains the
provider token and is never written anywhere by ADE.

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
- `apps/desktop/src/renderer/components/settings/harnesses/` — the settings
  surface:
  - `HarnessesPage.tsx` — the list page and its row actions.
  - `HarnessWizard.tsx` — the coordinator: draft state, validation, save, and
    step 1 (pick a harness). The two later steps and the shared primitives were
    lifted out of it, so no one file owns the whole wizard.
  - `HarnessWizardStepModel.tsx` — step 2: the two-group source list (your
    accounts and keys, then subscriptions through ADE's proxy) plus the model,
    effort, subagent, and Advanced controls.
  - `HarnessWizardStepIdentity.tsx` — step 3: name, accent, and logo.
  - `wizardPrimitives.tsx` — the `Row`, `SectionLabel` and `FieldError`
    primitives the steps share.
  - `harnessSources.ts` — reads the provider accounts, the stored keys, and the
    proxy subscriptions into the rows step 2 groups. The renderer-local type is
    `HarnessModelSource`.
  - `harnessAvailability.ts` — whether a harness is installed and signed in on
    this computer, as a reason string rather than a disabled row.
  - `harnessModels.ts` — pure: source → provider family, the model choices for a
    source (a key's declared models, then the live catalog, then the static
    registry), and whether the id must be typed instead of picked. It takes the
    catalog as an argument; fetching it is the ModelPicker's job.
  - `presetFacts.tsx`, `HarnessLogoCropper.tsx`, `useHarnessPresets.ts` — the
    row facts, the round 256x256 crop, and the store binding.
  - `harnessTestCatalog.ts` — the one typed catalog fixture the folder's tests
    share.
- `apps/desktop/src/renderer/components/shared/HarnessLogo.tsx` — the one place
  a preset's mark is drawn.
- `apps/desktop/src/renderer/components/shared/ModelPicker/HarnessPresetList.tsx`
  — the picker's Custom tab.
- `apps/desktop/src/renderer/components/shared/ModelPicker/sharedCatalogFetch.ts`
  — the one de-duplicated runtime-catalog fetch. The request-key format and the
  bucket claim live here, and both the composer's picker and the wizard's model
  select go through it, so there is no second hand-built copy of that
  concurrency protocol to drift.
- `apps/desktop/src/renderer/components/shared/ModelPicker/useRuntimeCatalogForFamily.ts`
  — React state over the runtime catalog for one provider family, which is what
  the wizard's model select consumes instead of the picker's loading ladder.
- `apps/desktop/src/main/services/chat/harnessPresetLaunch.ts` — the resolver:
  one preset (or one stored key, or one ad-hoc route id) in, one launch
  environment out.
- `apps/desktop/src/shared/harnessRoutes.ts` — pure routing: harness
  protocols, known source endpoints, the measured OpenCode Go protocol seed,
  `resolveHarnessRoute`, and the `route.` preset-id codec.
- `apps/desktop/src/main/services/chat/harnessRouteLaunch.ts` — carries a route
  out: resolves the source's secret, applies the proxy decision, and writes the
  per-harness endpoint env/config.
- `apps/desktop/src/main/services/chat/harnessRouteCatalog.ts` — the
  `ai.listHarnessRoutes` catalog and the `ai.harnessLaunchEnv` terminal
  launcher (CTO-only and secret-bearing: its result holds the token).
- `apps/desktop/src/main/services/chat/harnessRouteTest.ts` — the
  `ai.testHarnessRoute` live check (CTO-only), which resolves the source
  exactly as a launch does.
- `apps/desktop/src/main/services/chat/harnessKeySourceLaunch.ts` — the plain
  key table for keys that need no route: a bare provider-card key, and a
  preset key on OpenCode, Kimi or Copilot.
- `apps/desktop/src/main/services/chat/harnessRouteProbes.ts` — the persisted
  per-model protocol verdicts.
- `apps/desktop/src/main/services/chat/harnessLaunchPrepare.ts` — starts the
  proxy before a launch whose route needs it.
- `apps/ade-cli/src/services/proxy/cliProxyApiUpstreams.ts` — ADE's upstream
  entries in the proxy config.
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
  three built-in agent prompts, stamped with the CLI version they were taken
  from and re-extracted from the pinned binary when the SDK pin moves.
- `apps/desktop/src/shared/harnessPresetCliGate.ts` — the locked CLI gate.
- `apps/desktop/resources/agent-skills/ade-harnesses/SKILL.md` — how an agent
  discovers and uses a preset.
