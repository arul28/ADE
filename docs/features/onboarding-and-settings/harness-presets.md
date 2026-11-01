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
| Source | `account` (a provider sign-in named by instance id), `key` (a credential in the API-key store, named by id), `opencode` (a provider signed in *inside OpenCode* — OpenCode Go, Zen, or anything connected there — named by OpenCode's provider id; a sign-in there that is measured as a subscription-only login routes only inside OpenCode), or `subscription` (older presets: a Claude or Codex subscription in another harness, now served by the provider's default account). An `account` in a harness that is not its own (a Codex account in Droid) runs through ADE's proxy on that account's own login. |
| Model | A model id. The wizard reads the same live catalog the composer's picker uses, so a runtime-discovered provider (Cursor, OpenCode, Pi, the ACP providers) lists its real models. Free text survives for exactly two cases: a key pointing at a custom OpenAI-compatible endpoint that declares no models of its own, and a first-class key provider that neither the static registry nor the catalog can enumerate (OpenRouter, Google, DeepSeek, Mistral, Groq, Together). |
| Effort | The model's thinking tier, when it offers tiers. |
| Subagents | A model id, or `Same as main`, and — where the harness takes one — its own thinking level. |
| Subagent naming | Per-role pins for the types the harness exposes by name (Explore, Plan, general-purpose), each with its own level where the harness takes one. A role that follows the subagents takes their model and level. |
| Name, accent, logo | The identity a preset is recognised by. The logo is the ADE mark, a provider mark, an uploaded image, or a generated one, kept as a small icon so the list fits the one setting it syncs as. |

A preset never holds a credential. The `key` source stores the credential's id
and label; the key itself stays in the API-key store.

## Where a preset lives

Presets are an account-scoped preference. They persist in the renderer's
`ade.userPreferences.v1` blob under `harnessPresets`, and
`renderer/lib/accountSettingsSync.ts` registers that key so every machine
signed into the same ADE account converges on the same list. The registry's
newer-wins rule applies to the list as a whole: two machines never interleave
half of each other's edits into one preset.

The list also has to be on the brain, not only in the account. The brain is
what *resolves* a launch, out of the same `~/.ade/account-settings.json` the
sync writes, so a save and a launch cannot be allowed to race:

- **A save waits for the brain.** `useHarnessPresets` pushes the list and
  awaits the brain's own answer before it reports success. When the answer is
  "not yet" — the account service is unreachable, ownership changed, no brain
  is running — the dialog stays open, says the preset is saved on this
  computer but not on the account yet *with the reason the brain gave*, and
  offers Retry. The local copy is never rolled back: it is the user's work, and
  it stays queued for the ordinary retry.
- **A launch checks first.** Every surface that creates a chat or a CLI session
  on a saved `presetId` (`AgentChatPane`'s draft launch, the Work tab's PTY
  create, the batch and Linear launches) asks
  `renderer/lib/harnessPresetAccountSync.ts` to confirm the brain holds it.
  One cached read in the common case; when the preset is genuinely absent, the
  machine's list is pushed and awaited. An unreachable brain never blocks the
  launch — it degrades exactly as it always did.
- **A miss is not remembered.** "This harness preset no longer exists on this
  account" and "ADE could not read this account's harness presets" carry
  `reasonCode: "preset-not-found"` / `"preset-unreadable"`, so the chat
  resolves again on its next turn instead of pinning the failure for the
  session's life. That is the same rule `proxy-not-ready` and
  `sign-in-expired` already followed.
- **A launch carries the preset.** The chat may run on another machine (a
  pinned launch, or a project tab bound to one) whose synced list is behind.
  The preload attaches this machine's copy as `presetSnapshot` to chat create,
  headless launch and new-lane launch; the receiving brain adds it to its own
  list (`mergeHarnessPresetSnapshot`) unless it already holds the same preset
  at the same or a newer edit.
- **A chat never runs on a fallback.** When a chat's preset or stored key
  cannot be resolved, its turn fails with the reason and the message stays in
  the transcript (`launchRouteBlockReason` in `agentChatService.ts`). Anything
  built for the chat meanwhile (a pre-warmed query) is torn down before the
  next turn, so it cannot run on the harness's own sign-in either.
- **The list must fit one setting.** The account service caps a setting at
  16,000 characters and refuses the whole upload batch over it. An uploaded or
  generated logo is shrunk to a small WebP icon
  (`renderer/lib/harnessLogoCompaction.ts`), oversized logos already saved are
  shrunk in the background, a save that would still not fit says so, and the
  brain drops an unsendable value from its upload queue instead of letting it
  hold back every other setting.

A route id (`route.<…>`) needs none of this: it carries its whole launch spec
in the id, so there is nothing to look up.

## Building one

The editor is one page, top to bottom the order of the decision: which harness
runs it, which source supplies the model, which model it is, how hard it
thinks, and what it is called.

1. **Pick a harness.** Every harness is shown with its real provider mark. A
   harness that is not downloaded or not signed in shows the reason and stays
   selectable — a preset is a saved intention, not a description of this
   computer.
2. **Pick a source, then a model.** A source rail lists every provider this
   computer could draw on — the harness's own accounts, the OpenCode sign-ins
   and stored keys, and every other Claude and Codex account on this machine — and
   selecting one scopes the model pane beside it, the same way the composer's
   picker rails by provider. The search field spans every source. Accounts
   list their email and plan, keys their label and masked tail. A signed-out
   account says to sign it in under Providers. A
   source that can serve nothing in this harness stays in the rail with a
   warning mark, and its pane says so: the models, under **N models can't run
   in {harness}**, each with the route decision's reason (a ChatGPT sign-in
   inside OpenCode, Zen's free tier). Below the pane: the effort, the subagent
   model and level, and a folded **Subagent naming** disclosure. Pinning a
   role to a specific model shows the note that the role now runs on ADE's
   copy of Anthropic's prompt and stops tracking Claude Code. A harness that
   cannot take a subagent model or level says so in one sentence next to where
   the control would be, instead of showing a control it would drop.
3. **Name it.** Name, accent colour, and a logo tile — Default (the purple
   gear-and-wrench mark), provider logo,
   Upload (which opens a round crop with drag and zoom and writes a 256×256
   PNG), and Generate when the host exposes a generator. A live preview chip
   shows the result.

## Your accounts in other harnesses

Every Claude and Codex account already signed in on this machine, and this
machine's Grok sign-in, is a source in every other harness that takes an
endpoint (Droid, OpenCode, Grok, Qwen, and Claude Code or Codex for the other
provider). There is no second sign-in. Claude and Codex appear as `account`
sources (one per account); Grok as a `subscription` source (`grok`), listed by
the route catalog with the models the proxy last served for it
(`<adeHome>/proxy/borrowed-models.json`). On the command line they are
`--via account:<claude|codex>:<accountId>` and `--via subscription:grok`.

ADE's local proxy (CLIProxyAPI) answers for the account, using the account's
own login, lent to it by `ade-cli/src/services/proxy/borrowedLogins.ts`:

- Only the access token is lent, as `ade-borrow-<provider>-<account>.json` in
  the proxy's auth folder, with the routing prefix `ade-<provider>-<account>`.
  The refresh token never leaves the CLI. Both vendors rotate it on every use,
  so a copy in the proxy would sign the user's own CLI out the first time
  either side renewed.
- When a lent token nears expiry, ADE asks its pinned copy of that CLI to renew
  its own login, then lends the new token: Codex through app-server
  `account/read` with `refreshToken: true` (a day ahead; tokens last 10 days),
  Claude Code through its SDK-mode startup handshake (100 s ahead: Claude Code
  2.1.310 renews only in its last ~2 minutes; tokens last ~8 hours), Grok
  through `grok --no-auto-update models` (200 s ahead: Grok CLI 1.0.46 renews
  only in its last few minutes; tokens last 6 hours). None is a model request. One renewal runs at a time per machine
  (`.ade-borrow-renew.lock`).
- The proxy service lends every account when it starts (`ensureRunning`, which
  a launch's prepare step calls when its login is not lent yet), then re-lends
  on a timer aimed at the soonest token's renew window, at most 10 minutes
  apart, only while logins are lent.
- The proxy writes its own fields back into a lent file, in place, and can mark
  it disabled. A pass rewrites a file that is disabled or carries an old token,
  and readers retry a file caught mid-write.
- A launch takes a lent token only with more than a minute left; otherwise its
  prepare step renews it first. A signed-out account's lent file is removed,
  and the launch says to sign the account in under Providers.

Kimi, Devin and Muse sign-ins are lent the same way, as `subscription`
sources (`--via subscription:kimi|devin|muse`). They follow CLIProxyAPI
8.0.48's source and were checked with placeholder logins only (each loaded as
active and reached its vendor, which refused the placeholder token); no real
account has run them yet:

| Provider | Read from | Lent as (proxy `type`) | Renewal |
|---|---|---|---|
| Kimi | Kimi Code's token file for the region's login slot (`resolveKimiCodeLogin`), plus `<KIMI_CODE_HOME>/device_id` | `kimi`, with `device_id`, `domain`, `base_url` | None: Kimi Code 2.3.1 has no headless renew. A lent token runs until it lapses and is re-lent when the user's own Kimi renews it. |
| Devin | `credentials.toml` (`windsurf_api_key`) under the XDG data home, or `%APPDATA%` / `%LOCALAPPDATA%` on Windows | `devin`, as `session_token` | None: the token does not expire. |
| Muse | `<XDG config>/muse/auth.json` `providers` | `meta`, as `api_key` (or `dca_token` for a `dca:` value) | None: a minted key does not expire. |

Antigravity is not lent. Its ACP agent stores only a refresh token (no access
token), so lending it would hand the proxy the long-lived credential, and
Google has suspended accounts that used Antigravity's sign-in through other
clients.

On macOS, a Codex login kept in the Keychain (`cli_auth_credentials_store =
"keyring"` or `"auto"`) is not read: Codex creates the item so only Codex may
read it, and any other reader makes macOS ask the user. The launch says so and
how to switch Codex to `"file"`. On Linux and Windows ADE reads Codex's keyring
copy (`ai/codexKeyringAuth.ts`), which asks nothing.

A preset saved with a `subscription` source runs on the provider's default
account, or on a login the user signed in to the proxy itself with
`ade proxy login` (that login wins when present).

Presets this build cannot read (a newer build's source kind or subscription
provider) are kept, untouched, in every write of the list to disk and to the
account (`withUnreadableHarnessPresets` in `appStore.ts`), so editing another
preset here never deletes them on every machine. Builds before this one do
drop them on save.

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
  hold, or a provider sign-in (Grok, Kimi, Devin, Muse) this computer is not
  signed in to. Nothing lands in the list until
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

**A picker picks.** The tab is the saved providers, and one link — "Manage
custom providers" — to Settings › Providers › Custom, where they are built.
Building one is a five-step form over a live model catalog with its own page;
a second, weaker copy of that form behind a tab in a model dropdown put the same
list in two places with two different sets of controls, and the picker's copy
could not save anything it produced. Selecting a saved provider applies the
whole configuration — its model, its thinking level, its subagent settings, its
harness — in one click, which is the entire point of saving one.

Selecting a preset sets the composer's thinking level to the preset's, and the
launch carries that level: a preset saved at High launches at High even when
the previous pick was on Low. An ordinary model pick still reconciles the level
against the new model, because there the old level belonged to a model the user
just left; the composer's own control keeps working either way, so changing the
level after the pick wins.

**Switching an open chat.** The picker works the same on a chat that is already
running. The pick shows on the trigger at once and applies with the next send:
`chat.updateSession` takes `presetId` to move the chat onto a preset (its
harness, model and thinking level, with the usual handoff when the harness
changes; `modelId` is then ignored), and a plain model picked on a preset chat
sends `presetId: null` with the model, which leaves the preset. A `modelId`
alone leaves a preset only when it names another model, so a settings save that
re-sends the current model keeps it. Each launch reads the preset's model over
the row's, so a chat that kept its preset while naming another model would say
one model and run the other; `leftLaunchRoute` keeps a left preset from coming
back from the persisted record.

What a chat runs on is said in the same accent everywhere, and with one mark
per row:

- the **composer's model trigger** draws the preset's own mark (for an ad-hoc
  route, the mark of the *source* that serves the model) with that mark's
  accent, and a harness chip beside it names the program that runs it in the
  harness's own colour;
- the **session card** draws that same single mark. The harness is not a second
  glyph — two marks in one row compete with the title for a fact the row's
  tooltip already carries, and the harness is the less surprising half of the
  pairing, since the Custom provider is what the person chose.

A mark is never drawn without its accent. The default purple is a preset's
fallback colour, not "no colour", so using it for a preset that has one of its
own is the mismatch this note exists to prevent.

**The launch guard is local.** It reads and writes the account-settings copy of
the brain this client is attached to. A launch pinned to another machine is
resolved by *that* machine's copy, which this client can neither read nor write,
so the guard reports that it cannot vouch for it and the other machine's own
account sync is what converges.

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
  their own sign-in; OpenCode Zen's free models only answer inside OpenCode;
  an OpenAI sign-in inside OpenCode is a ChatGPT subscription whose token
  api.openai.com refuses on every protocol, measured 2026-10-15, so it also
  only answers inside OpenCode — use an OpenAI API key or a Codex
  subscription instead).

Protocol support is **per model**. OpenCode Go serves DeepSeek, Kimi K3, Qwen
and MiniMax on its Anthropic endpoint, GLM, Hy, MiMo and LongCat on OpenAI chat
only, and GPT/Grok on Responses only (measured 2026-09-29, seeded in
`OPENCODE_GO_MODEL_PROTOCOLS`). A Test (below) overrides the seed: its verdict
is saved in `<adeHome>/cache/harness-route-probes.json` and every launch reads
it.

A free-tier model is refused by its own gateway to every outside client no
matter the protocol — usually spelled `-free`, but not always (`big-pickle`,
measured 2026-10-15, is free-tier and carries no suffix, so it is listed in
`OPENCODE_ZEN_FREE_TIER_IDS`). A Test that meets the refusal records it like a
protocol refusal, so a free-tier model with a novel name stops being offered as
a reachable choice (it stays listed, greyed, under "N models can't run in …")
instead of failing a launch.

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

A pairing that was never saved — `ade chat create --via opencode-go --model
…`, or any caller that names a harness, a source and a model directly — travels
as a preset id of the form `route.<base64url(json)>` — the harness, the source
reference and the model, never a secret. base64url passes the safe-identifier
check every launch surface already applies to `presetId`, so an ad-hoc choice
gets chat, CLI, resume, remote launch and sync with no new wire field. A route
id is minted by whoever knows the pairing; the model picker no longer mints
one, because building a pairing is what Settings › Providers › Custom is for.
Its
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
| `account` | In its own harness, the instance's config home as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. In another harness, the proxy's connection for that account's lent login, shaped like `subscription`. |
| `key` / `opencode` | The route's endpoint and token, per harness below. Harnesses that read a config file (Codex, Grok, Droid) get one in a home ADE owns at `<adeHome>/provider-homes/preset/<presetId>/`; Claude Code needs none and keeps the user's own config home, so their plugins, skills and MCP servers still load. The OpenCode token is read from OpenCode's store at launch, in the main process only. |
| `subscription` | The proxy's connection, shaped per harness by `proxyEnv.ts`. The model becomes the proxy's `<prefix>/<model>` routing id. |

### What each harness accepts

| Harness | Key | Subscription | Subagent model | Subagent effort |
|---|---|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` (no `/v1`), `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""` (never inherited — a shell key would reach another vendor as `x-api-key`), `ANTHROPIC_MODEL` and every tier (`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`) pinned to the route's model so background calls do not ask another vendor for Haiku, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from the model's real limits. | Yes | Yes | Yes |
| Codex CLI | `CODEX_HOME` plus a `config.toml` ADE writes there naming one `[model_providers.ade]` block (`wire_api = "responses"`, `env_key = "ADE_PRESET_API_KEY"`, `model_context_window` from the model's limits). `~/.codex/config.toml` is never touched. | Yes | Yes (key/subscription; a Codex *account* preset keeps the account's own config) | same |
| OpenCode | A provider block merged into the session's config, not an env var — OpenCode has no "use this key against this endpoint" variable. Needs an endpoint. | Yes | Yes (`agent.<type>.model`; nothing for a preset running on an OpenCode sign-in, which owns its config) | No |
| Droid | `FACTORY_HOME_OVERRIDE` at a preset-owned home, with `customModels` (camelCase; Droid ignores snake_case `custom_models`) written into its `.factory/settings.json`. | Yes (via proxy) | No | No |
| Qwen Code | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`. | Yes (via proxy) | No | No |
| Kimi | `KIMI_CODE_HOME` at a preset-owned home whose `config.toml` defines `[providers.ade]` (`type` openai, openai_responses or anthropic, `base_url`, `api_key`), a `[models."ade/<model>"]` alias and `default_model`. The launch names the alias, which ADE passes through untouched. Checked with Kimi Code 2.3.1, CLI and ACP. | Yes (via proxy) | No | No |
| Grok | `GROK_HOME` at a preset-owned home whose `config.toml` defines `[model."<id>"]` with the route's `base_url`, `api_backend` (`messages`, `chat_completions` or `responses`), `env_key` and the session header. | Yes (via proxy) | Yes (`[subagents.models]`) | No |
| GitHub Copilot | The runtime's BYOK switches: `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE` (openai or anthropic), `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_WIRE_API`, `COPILOT_MODEL`. The CLI reads them itself and needs no GitHub sign-in; the SDK runtime behind Copilot chats does not, so ADE's Copilot worker passes the same endpoint as each session's `provider`. Checked with CLI 1.0.105 and SDK runtime 1.0.22. | Yes (via proxy) | No | No |
| Cursor | No. Cursor signs in from its own single-slot store, and a per-preset key would change every other Cursor session on the machine. | No | No | No |
| Pi | `PI_CODING_AGENT_DIR` at a preset-owned folder whose `models.json` defines provider `ade` (`api` openai-completions, openai-responses or anthropic-messages) and whose `settings.json` makes it the default; a routed Pi chat selects `ade/<model>` explicitly. The user's own `~/.pi/agent` is never touched. Checked with Pi 1.4.0, CLI and chat. | Yes (via proxy) | No | No |

### Subagents and subagent naming

Two independent knobs, because no harness has both for free. The capability
table lives in `shared/harnessPresets.ts` (`HARNESS_SUBAGENT_SUPPORT`) with the
harness or documentation each entry was read from, and the wizard renders
straight from it: a harness that cannot take a knob gets one sentence naming
the harness and saying it runs subagents on the main model, never a dead
control.

| Harness | Subagent model | Subagent effort | Named roles |
|---|---|---|---|
| Claude Code | `CLAUDE_CODE_SUBAGENT_MODEL` + `_FORCE` | SDK `agents[].effort` | Explore, Plan, general-purpose |
| Codex CLI | `agents.default_subagent_model` in the `CODEX_HOME` ADE owns | `agents.default_subagent_reasoning_effort` | user-defined roles via `[agents.<role>] config_file` |
| Grok | `[subagents.models]` per type in the `GROK_HOME` ADE owns | — (a subagent inherits the main thread's level) | explore, plan, general-purpose |
| OpenCode | `agent.<type>.model` in the `opencode.json` ADE owns | — | explore, general |
| Droid, Qwen Code, Pi, Kimi, GitHub Copilot, Cursor | — | — | — |

The thinking level is the awkward half in Claude Code: there is no
`CLAUDE_CODE_SUBAGENT_*` variable for it, so a preset that names one gets an
SDK `agents` entry for `general-purpose` — the type every unspecified spawn
lands on — carrying ADE's copy of Anthropic's prompt. That is the same fork a
named pin already makes, and the wizard says so at the point of the choice. A
role pinned to a level with no model of its own takes the subagent model, so
the level has somewhere to land.

Models are passed through exactly as saved, and every pin that travels through
ADE's proxy carries the proxy's upstream prefix, the same as the main model.

An unsupported pairing is a value, not an error: the create succeeds, and the
chat's turns fail with the reason until the preset can be resolved. A chat
never runs on the harness's own sign-in in its place.

### Model ids are passed through

Every other ADE launch path rewrites a Claude model id through its alias table.
A preset's launch does not (`passthroughModelId`), because a preset's model can
be a gateway's spelling — `anthropic/claude-opus-4.5` on OpenRouter — that must
reach the endpoint exactly as typed.

### Claude subagents and built-in pins

A subagent model becomes `CLAUDE_CODE_SUBAGENT_MODEL` plus
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Without the force flag the CLI treats the
value as a default a per-agent setting may override, and "subagents on Haiku"
would silently keep running on the main model. A subagent *effort* has no
environment variable at all and goes through the SDK `agents` entries
described under "Subagents and subagent naming" above.

Pinning Explore, Plan or general-purpose sends an SDK `agents` entry. The SDK
has no "same agent, different model" overlay — an entry replaces the whole
definition — so ADE supplies its own copy of Anthropic's prompt and the
built-in's `disallowedTools` and `omitClaudeMd` alongside the model. Those
copies live in `shared/claudeBuiltinAgentPrompts.ts`, stamped with the CLI
version they came from (`CLAUDE_BUILTIN_AGENT_PROMPT_SOURCE_VERSION`) and
re-extracted from the pinned binary's template source whenever the SDK pin
moves, compared whole and not only line by line. The templates have holes that
Claude fills from the tools it gives agents: the shell (Bash, or PowerShell on
Windows without Git Bash) and whether Glob and Grep exist. ADE fills them from
the same facts, which Claude reports in each `system/init` tool list
(`claudeCodeInit.ts`); before a report, macOS and Linux use the Agent SDK's set
(Bash, no Glob or Grep). A pinned agent stops tracking upstream the moment it
is used. The wizard says so at the point of the choice.

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

The script runs ADE's pinned copy of the harness, never the one on the PATH
(`buildHarnessLaunchEnv` in `chat/harnessRouteCatalog.ts`). It first waits for
or joins the pin's download, exports the harness's self-update switches, and
ends with a shell function named after the harness command that runs the
pinned binary: `claude() { '<pin>' … "$@"; }` in zsh/bash,
`function claude { & '<pin>' … @args }` in PowerShell. Node-run harnesses get
`'<node>' '<script>'` (plus Cursor's flags). So the copied
`… && claude --model …` runs the pin with no change. When the pin is not
available on this machine or its download fails, the action throws the state
sentence and `ade harness env` exits non-zero, so neither launcher form runs
anything. `ai.harnessLaunchEnv` runs on the brain's machine, so the path it
prints is that machine's.

## Source file map

- `apps/desktop/src/shared/harnessPresets.ts` — the type, validation,
  normalisation, export/import, the label helpers, and the per-harness
  subagent capability table (`HARNESS_SUBAGENT_SUPPORT`). No React, no IPC.
- `apps/desktop/src/shared/harnessSubagentLaunch.ts` — what a preset's
  subagent settings become in each harness's config file (Codex's TOML,
  Grok's table, OpenCode's agent block). Pure; the writers append what it
  returns.
- `apps/desktop/src/renderer/lib/harnessPresetAccountSync.ts` — the two
  moments a preset must already be on the brain: a confirmed save, and a
  launch that checks the machine's copy before the runtime resolves it.
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
  - `CustomProvidersSection.tsx` — the section: the saved list, its row actions,
    the "?" explainer, and the starter suggestions shown while the list is
    empty.
  - `CustomProviderDialog.tsx` — the one-page editor: harness chips, the source
    rail and model pane, thinking, and name and look. Its unreachable-models
    panel states why a source's models cannot run in the chosen harness.
  - `CustomProviderModelPane.tsx` — the editor's model pane: the source rail,
    the scoped list, the per-source search, and the
    "N models can't run in {harness}" disclosure with the reasons.
  - `CustomProviderSourceRail.tsx` — the provider rail that scopes the model
    pane to one source, with a warning mark on a source that can serve nothing.
  - `harnessReach.ts` — pure: every model one harness can reach, grouped by
    source, with the routes that work and the models that cannot run (each with
    its reason). The composer picker's rail is not built from this.
  - `useHarnessReach.ts` — gathers those inputs (the route catalog, the
    accounts, the runtime catalog) and runs a row's live Test.
  - `wizardPrimitives.tsx` — the `Row`, `SectionLabel` and `FieldError`
    primitives the dialog shares.
  - `harnessSources.ts` — reads the provider accounts and the stored keys into
    the rows the rail lists. The renderer-local type is `HarnessModelSource`.
  - `harnessAvailability.ts` — whether a harness's pinned copy is downloaded and signed in on
    this computer, as a reason string rather than a disabled row.
  - `harnessModels.ts` — pure: source → provider family, the model choices for a
    source (a key's declared models, then the live catalog, then the static
    registry), and whether the id must be typed instead of picked. It takes the
    catalog as an argument; fetching it is the ModelPicker's job.
  - `presetFacts.tsx`, `HarnessLogoCropper.tsx`, `useHarnessPresets.ts`,
    `harnessLauncher.ts`, `harnessLaunchTarget.ts` — the row facts, the round
    256x256 crop, the store binding, and the Copy terminal launcher.
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
