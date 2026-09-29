---
name: ade-harnesses
description: Use this skill when you need to run a chat, a CLI session, or a subagent on a specific setup — any model you pay for inside any harness (e.g. OpenCode Go's DeepSeek inside Claude Code), a saved Custom provider (a "harness preset" internally), one of this machine's provider accounts, or one stored API key — instead of whatever ADE would pick by default. Covers listing what is reachable (`ade harness routes`, `ade chat models`, `ade providers accounts list`), launching with `--via`, `--preset`, `--credential`, or `--instance`, checking a pairing (`ade harness test`), and running one in a plain terminal (`ade harness env`).
---

# ADE harnesses: picking what a session runs on

ADE separates the **harness** (which agent runs: Claude Code, Codex, Droid,
OpenCode, …) from the **model provider** (where it gets its intelligence: a
native sign-in, a provider signed in to OpenCode — OpenCode Go, Zen, or any
provider connected there — a stored API key, or a subscription borrowed
through ADE's proxy). Any routable harness can run any model its sources serve:
ADE points the harness straight at the source when they speak the same API, and
translates through its local proxy when they do not.

A **harness preset** — shown in the app as **Custom** (Settings › Providers ›
Custom) — is one saved pairing of the two, with the model, the thinking level
and the subagent pins attached. It has an id, and that id is the only thing a
launch needs. The permission tier is not part of a preset: it is chosen at
launch, the same way it is for every other provider.

## See what this machine can run

```bash
ade chat models --text                 # every model, grouped by provider
ade chat models --provider claude --text
ade providers accounts list --text     # Claude/Codex accounts on this machine
ade providers accounts list --provider codex --text
```

Presets and accounts also ride the AI status payload, which is the one call that
answers what a session can run on without three round trips:

```bash
ade actions run ai getStatus --text
```

Read `harnessPresets[]` (`{id, name, harness, model, source}`) and
`providerAccounts[]` (`{id, provider, label, isDefault, signedIn}`). Neither
carries a key or a config path — only the ids the flags below take.

## See what each harness can reach

```bash
ade harness routes --harness claude --text   # every model Claude Code can run, by source
ade harness routes --text                    # the same for every routable harness
```

Rows tagged `via ADE proxy` are translated (the proxy starts on demand). Check
one pairing with a one-token request before relying on it — the verdict is
remembered, so later launches route around a protocol the model refused:

```bash
ade harness test --harness claude --via opencode-go --model deepseek-v4.1-flash --text
```

## Launch on a specific setup

| you want | flag |
|---|---|
| any reachable model, no saved preset | `--provider <harness> --via <source> --model <id>` |
| a saved custom setup (harness preset) | `--preset <preset-id>` |
| one stored API key, no preset | `--credential <credential-id>` |
| a specific Claude/Codex account | `--instance <account-id>` |

```bash
# A chat on a saved preset — model, effort and subagent pins all come from
# the preset, so nothing else needs stating.
ade chat create --lane <lane> --preset hp_opus_work

# A tracked CLI terminal on the same preset.
ade new chat --mode cli --lane <lane> --provider claude --preset hp_opus_work

# A key saved on a provider page, with no preset around it.
ade chat create --lane <lane> --provider claude --credential openrouter

# A specific account, without a preset.
ade chat create --lane <lane> --provider claude --instance work

# OpenCode Go's DeepSeek inside Claude Code, chat or CLI, no preset.
ade chat create --lane <lane> --provider claude --via opencode-go --model deepseek-v4.1-flash
ade new chat --mode cli --lane <lane> --provider codex --via opencode-go --model glm-5.3
```

`--via` takes `opencode-go`, `opencode` (Zen), `opencode:<provider>`, or
`key:<provider>[:<credentialId>]`. Subagents follow the main model unless a
preset pins them.

## Run a custom setup in your own terminal

```bash
eval "$(ade harness env <preset-id> --text)" && claude --model <model>
```

The output holds the provider token. It is printed for `eval` and never
written anywhere; do not paste it into a chat or a file.

`--preset` and `--credential` are mutually exclusive: each names a whole setup,
and passing both would leave ADE guessing which one you meant.

## Run subagents on a different preset

A subagent is a chat, so it takes the same flag. Spawn one on a cheaper or
faster preset than the parent and keep working:

```bash
ade chat create --lane <lane> --preset hp_haiku_cheap \
  --type subagent --permission-mode full-auto \
  --prompt "Find every caller of resolveLaunchBrain and report the list."
```

For a Claude preset you do not have to spawn a separate chat at all: a preset
can pin Explore, Plan and general-purpose to their own models (Settings ›
Providers › Custom › Advanced). Those pins apply to every subagent the chat
spawns natively, with no extra flag.

## What does not take a preset

Three CLIs read their identity from their own sign-in and accept no key or
endpoint from the launch: **Cursor**, **Copilot**, **Kimi**. A preset on one of
them in CLI mode is dropped and the native CLI starts — a working session on
the harness's own account, with the reason recorded. (Grok used to be here; it
now runs routed models from an ADE-owned `GROK_HOME`.)

OpenCode's **free** Zen models only answer inside OpenCode itself, so they are
never offered in another harness.

Two more have no key path at all, in either mode:

- **Pi** reads its endpoints and model ids from its own `models.json`. Add the
  provider in Pi; a preset key has nowhere to go.
- **Cursor** holds one key at a time in its own store, so a per-preset key would
  change every other Cursor session on the machine.

When a preset cannot be honoured, the chat says which capability was dropped and
runs on the harness's own sign-in. It never fails the launch.
