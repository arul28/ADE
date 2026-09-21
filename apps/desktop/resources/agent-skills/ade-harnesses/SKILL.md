---
name: ade-harnesses
description: Use this skill when you need to run a chat, a CLI session, or a subagent on a specific setup — a saved Custom provider (a "harness preset" internally), one of this machine's provider accounts, or one stored API key — instead of whatever ADE would pick by default. Covers listing what is available (`ade chat models`, `ade providers accounts list`) and launching with `--preset`, `--credential`, or `--instance`.
---

# ADE harnesses: picking what a session runs on

ADE separates the **harness** (which agent runs: Claude Code, Codex, Droid,
OpenCode, …) from the **model provider** (where it gets its intelligence: a
native sign-in, a stored API key, or a subscription borrowed through ADE's
proxy).

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

## Launch on a specific setup

| you want | flag |
|---|---|
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
```

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

Four CLIs read their identity from their own sign-in and accept no key from the
launch: **Grok**, **Cursor**, **Copilot**, **Kimi**. A preset on one of them in
CLI mode is dropped and the native CLI starts — a working session on the
harness's own account, with the reason recorded. Chat mode is unaffected for the
harnesses whose adapters ADE drives itself.

Two more have no key path at all, in either mode:

- **Pi** reads its endpoints and model ids from its own `models.json`. Add the
  provider in Pi; a preset key has nowhere to go.
- **Cursor** holds one key at a time in its own store, so a per-preset key would
  change every other Cursor session on the machine.

When a preset cannot be honoured, the chat says which capability was dropped and
runs on the harness's own sign-in. It never fails the launch.
