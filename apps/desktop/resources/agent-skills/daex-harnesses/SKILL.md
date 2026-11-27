---
name: daex-harnesses
description: "Run a chat, CLI session or subagent on a chosen setup: any model in any harness (`--via`), a saved Custom provider (`--custom-provider`), one provider account (`--instance`), or one stored API key (`--credential`); `daex harness routes`, `providers`, `test` and `env`. Every launch passes `--model`."
---

# Daex harnesses: picking what a session runs on

Daex was called ADE: the CLI is `daex`, and `ade …` still works the same (older transcripts and prompts use it).

Two words, kept apart:

- **Harness**: the agent program Daex runs. It is the `--provider` value:
  `claude` (Claude Code), `codex`, `opencode`, `droid`, `pi`, `cursor`, …
- **Where the model runs**: the harness's own sign-in, or a source Daex routes
  it to with `--via`: a provider signed in to OpenCode (OpenCode Go, Zen, or
  any provider connected there), a stored API key, or a Claude, Codex, Grok,
  Kimi, Devin or Muse sign-in already on this machine, which Daex's proxy runs
  in any other harness.

**Every launch passes `--model <id>`.** Daex never picks a model for an agent;
a launch without one is refused with the command that lists the ids.

## See what this machine can run

```bash
daex chat models --text                        # every model, grouped by provider
daex chat models --provider claude --text
daex harness routes --text                     # every model each harness can reach, and how
daex harness routes --provider claude --text   # one harness
daex harness providers --text                  # saved Custom providers, with the flags to launch each
daex providers accounts list --text            # Claude/Codex accounts on this machine
```

Rows tagged `via Daex proxy` are translated (the proxy starts on demand).
Check one pairing with a one-token request before relying on it. The verdict
is remembered, so later launches route around a protocol the model refused:

```bash
daex harness test --provider claude --via opencode-go --model deepseek-v4.1-flash --text
```

## Launch on a specific setup

Use at most one of `--via`, `--custom-provider` and `--credential`: each says
where the model runs, so Daex refuses two of them together.

| you want | flags |
|---|---|
| the harness's own sign-in | `--provider <harness> --model <id>` |
| any reachable model, nothing saved | `--provider <harness> --via <source> --model <id>` |
| a saved Custom provider | `--custom-provider "<name>" --model <its model>` |
| one stored API key | `--provider <harness> --credential <credential-id> --model <id>` |
| one Claude/Codex account | add `--instance <email>` (an account with no readable email: its id from `daex providers accounts list`) |

```bash
# OpenCode Go's DeepSeek inside Claude Code: chat, then a tracked CLI session.
daex chat create --lane <lane> --provider claude --via opencode-go --model deepseek-v4.1-flash
daex new chat --mode cli --lane <lane> --provider codex --via opencode-go --model glm-5.3

# A saved Custom provider, by its name. The model is its own model.
daex chat create --lane <lane> --custom-provider "DeepSeek on Claude" --model deepseek-v4.1-flash

# A key saved on a provider page.
daex chat create --lane <lane> --provider claude --credential openrouter --model anthropic/claude-sonnet-5-5

# One account, by its email.
daex chat create --lane <lane> --provider claude --instance you@example.com --model claude-opus-5-5
```

`--via` takes `opencode-go`, `opencode` (Zen), `opencode:<provider>`,
`key:<provider>[:<credentialId>]`, `account:<claude|codex>:<accountId>` (one
named account), or `subscription:<claude|codex|grok|kimi|devin|muse>` (that
provider's sign-in on this machine; the only form for Grok, Kimi, Devin and
Muse). Model ids in this file are examples; `daex harness routes --text` has
the current ones.

## Custom providers

A **Custom provider** is one setup saved under a name in Settings › Providers
› Custom providers: a harness, where it runs, one model, a thinking level, and
optionally the model its subagents use. `daex harness providers --text` prints
each one with the exact flags to launch it.

- Name it with `--custom-provider "<name>"` (or its id). A name is matched
  ignoring case; two with the same name are refused, and the error lists their
  ids.
- Still pass `--model`, and it must be that Custom provider's model. A
  different model is refused with the right one named: a Custom provider runs
  one model, so a mismatch is a mistake, not a choice.
- `--provider` is optional with it. If you pass one, it must be the Custom
  provider's harness.
- The permission level is chosen at launch, as for every provider.

## Run a Custom provider in your own terminal

```bash
eval "$(daex harness env "DeepSeek on Claude" --text)" && claude --model <model>
```

The output holds the provider token. It is printed for `eval` and never
written anywhere; do not paste it into a chat or a file.

## Subagents

A subagent is a chat, so it takes the same flags. Spawn one on a cheaper or
faster model than yours and keep working:

```bash
daex chat create --lane <lane> --provider claude --via opencode-go --model deepseek-v4.1-flash \
  --type subagent --permission-mode full-auto \
  --prompt "Find every caller of parseConfig and report the list."
```

A Custom provider can also name its subagents' model and thinking level
(Settings › Providers › Custom providers › Subagents). Those apply to every
subagent the chat starts inside its own harness, with no extra flag. Claude
Code, Codex CLI, Grok and OpenCode take a subagent model; Claude Code and
Codex CLI take a level too. Claude Code, Grok and OpenCode also let you pin
named roles (Explore, Plan, general-purpose) under **Subagent naming**.
Without one, subagents run on the chat's model.

## What cannot be routed

**Cursor** reads its identity from its own sign-in and takes no key or
endpoint from a launch. A Custom provider on it in CLI mode is dropped and
Cursor starts on its own account, with the reason recorded. Cursor holds one
key at a time in its own store, so it has no key path in either mode.

OpenCode's **free** Zen models only answer inside OpenCode, so no other
harness is offered them. An OpenCode sign-in that is a subscription-only login
(an OpenAI sign-in there is a ChatGPT subscription whose token no outside
client can use) is not offered either: route it with an OpenAI API key, or
with your Codex account (`--via account:codex:<id>`).

Antigravity's sign-in is never lent to the proxy: its CLI stores only a
long-lived refresh token, and Google has suspended accounts that used it
through other clients.

When a setup cannot be honoured at launch, the chat says which part was
dropped and runs on the harness's own sign-in. It does not fail the launch.
