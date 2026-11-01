---
name: ade-harnesses
description: Use this skill to run a chat, CLI session or subagent on a specific setup instead of ADE's default: any model inside any harness, a saved Custom provider, one provider account, or one stored API key. Covers `ade harness routes`, launching with `--via`, `--preset`, `--credential` or `--instance`, and `ade harness test`.
---

# ADE harnesses: picking what a session runs on

ADE separates the **harness** (which agent runs: Claude Code, Codex, Droid,
OpenCode, …) from the **model provider** (where it gets its intelligence: a
native sign-in, a provider signed in to OpenCode — OpenCode Go, Zen, or any
provider connected there — a stored API key, or a Claude or Codex account or
the Grok sign-in already on this machine, which ADE's proxy runs on that
login in any other harness, with no extra sign-in: `--via
account:<claude|codex>:<accountId>`, or `--via subscription:<grok|kimi|devin|muse>`). Any routable harness can run any model its sources serve:
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
ade chat create --lane <lane> --provider claude --instance claude-2

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

For a harness that takes one, you do not have to spawn a separate chat at all:
a preset can name its subagents' model and thinking level (Settings ›
Providers › Custom › Subagents), which apply to every subagent the chat spawns
natively, with no extra flag. Claude Code, Codex CLI, Grok and OpenCode take a
subagent model; Claude Code and Codex CLI take a level too. Claude Code, Grok
and OpenCode also let you pin individual named roles (Explore, Plan,
general-purpose) under **Subagent naming**. A harness the preset's wizard says
runs subagents on the main model takes neither.

## What does not take a preset

One CLI reads its identity from its own sign-in and accepts no key or endpoint
from the launch: **Cursor**. A preset on it in CLI mode is dropped and the
native CLI starts — a working session on the harness's own account, with the
reason recorded. (Grok, Copilot, Kimi and Pi used to be here; each now runs
routed models: Grok from an ADE-owned `GROK_HOME`, Copilot through its
`COPILOT_PROVIDER_*` BYOK switches, Kimi from an ADE-owned `KIMI_CODE_HOME`,
Pi from an ADE-owned `PI_CODING_AGENT_DIR`.)

OpenCode's **free** Zen models only answer inside OpenCode itself, so they are
never offered as a reachable choice in another harness (the editor still lists
them, greyed, with the reason). The same goes for an OpenCode sign-in that is
measured as a subscription-only login — an OpenAI sign-in there is a ChatGPT
subscription whose token no outside client can use; route it with an OpenAI API
key or a Codex subscription through ADE's proxy instead.

Cursor has no key path at all, in either mode: it holds one key at a time in
its own store, so a per-preset key would change every other Cursor session on
the machine.

Antigravity's sign-in is never lent to the proxy: its CLI stores only a
long-lived refresh token, and Google has suspended accounts that used it
through other clients.

When a preset cannot be honoured, the chat says which capability was dropped and
runs on the harness's own sign-in. It never fails the launch.
