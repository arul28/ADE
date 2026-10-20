---
name: update-providers
description: 'Plan a provider version bump on a Dependabot or pin-watcher PR branch. Finds which agent provider the branch bumps, finds that provider''s newest stable version (even if newer than the PR''s), learns how ADE pins it, reads every release between the current pin and the newest, sorts each change into three layers (works as-is / small ADE change / new feature to design), and reports back for discussion. Research only: it changes no code and moves no pin until the owner decides. Use when the user runs /update-providers on a provider bump branch.'
---

# /update-providers — plan a provider bump

ADE runs its own pinned copy of every agent provider. It never runs the
user's installed CLI. A pin moves only after a person checks the new version
in ADE. This skill does the research for that check, on one provider, and
reports. **It changes no code, no pin file and no lockfile.** The owner reads
the report and decides what to build.

Policy and mechanics live in
[docs/features/onboarding-and-settings/agent-tools-cache.md](../../../docs/features/onboarding-and-settings/agent-tools-cache.md).
Read it first if any step below is unclear.

## 1. Find the provider

1. Read the branch name and the PR (`gh pr view --json title,body,headRefName,files`).
   - Dependabot branches bump an npm SDK in `apps/desktop/package.json` and/or
     `apps/ade-cli/package.json` (see `.github/dependabot.yml`).
   - Pin-watcher branches are named `pins/<tool>` and change
     `apps/ade-cli/scripts/pins/<tool>.json` (see `.github/workflows/agent-tool-pins.yml`).
2. Map the change to one provider with the table in step 3. If the branch
   bumps more than one provider, stop and ask which one to plan.

## 2. Find the newest version

Find the newest **stable** release, even if it is newer than the one the PR
opened for. Do not use alpha, beta, preview or nightly tags.

- npm-pinned providers: `npm view <package> dist-tags --json` and `versions --json`.
- Pin-watcher providers: `cd apps/ade-cli && node scripts/pin-tool.mjs <tool> --latest-version`
  (needs no install; set `GITHUB_TOKEN` for qwen and kimi).
- Record three versions: the **current pin** (on `main`), the **PR's version**,
  and the **newest**. The plan covers current pin → newest.

## 3. Learn how ADE pins it

| Provider | Tool name(s) in the tools cache | How the pin moves | Where ADE uses it |
|---|---|---|---|
| Claude | `claude-code` | Dependabot: `@anthropic-ai/claude-agent-sdk` (SDK 0.3.N bundles Claude Code 2.1.N), then `npm run tools:manifest` in `apps/ade-cli` | `ai/claudeCodeExecutable.ts`, the Claude runtime in `chat/agentChatService.ts`, `claude*.ts` in `chat/`, fall-forward in `ai/claudeFallForward.ts` |
| Codex | `codex` | Dependabot: `@openai/codex`, then `tools:manifest` | `ai/codexExecutable.ts`, `chat/codex*.ts`, app-server feature gates in `chat/codexAppServerFeatures.ts`, fall-forward in `ai/codexFallForward.ts` |
| OpenCode | `opencode` | Dependabot: `@opencode/cli` + `@opencode/client`, then `tools:manifest` | `opencode/**` |
| Copilot | `copilot` (SDK runtime), `copilot-cli` (terminal CLI) | Dependabot: `@github/copilot-sdk` (runtime is pinned from the lockfile; SDK and runtime must stay the same version), then `tools:manifest`. `copilot-cli` moves with `tools:pin` | `chat/copilotSdk*.ts`, `ai/acpExecutables.ts` (runtime resolver), `pty/pinnedProviderCli.ts` |
| Cursor | none for chat (`@cursor/sdk` ships in the installer); `cursor-cli` for terminals | Dependabot: `@cursor/sdk`. `cursor-cli` moves with `tools:pin` | `ai/cursorSdk*.ts`, `chat/cursorSdk*.ts`, `chat/cursorModelsDiscovery.ts` |
| Droid | `droid` | Dependabot: `@factory/droid-sdk` (the SDK in the app). The `droid` binary moves with `tools:pin` | `ai/droidExecutable.ts`, `chat/droidSdk*.ts` |
| Muse | `muse` | Dependabot: `@muse-code/sdk`, then `npm run tools:muse-pin` (the binary must pair with the SDK version) | `ai/museExecutable.ts`, `ai/museAuth.ts`, `chat/museSdkHost.ts`, fall-forward in `ai/museFallForward.ts` |
| Pi | `pi` (npm tree), `node` (runs Pi's CLI) | `tools:pin -- pi <version>` | `ai/piInstallation.ts`, `chat/piSdk*.ts` |
| Qwen | `qwen` | `tools:pin` (official standalone bundle with its own Node) | `chat/acpHost/acpDialects/qwen.ts`, `qwenSkillDefaults.ts` |
| Kimi | `kimi` | `tools:pin` | `chat/acpHost/acpDialects/kimi.ts` |
| Grok | `grok` | `tools:pin` | `chat/acpHost/acpDialects/grok.ts` |
| Devin | `devin` | `tools:pin` | `chat/acpHost/acpDialects/devin.ts`, `devinCloud.ts` |
| Antigravity | `antigravity` | `tools:pin` (computes the sha256; Google publishes none) | `chat/acpHost/acpDialects/antigravity.ts`, `ai/antigravityAuth.ts`, `ai/antigravitySignIn.ts` |
| Node runtime | `node` | `tools:pin -- node` (newest Node 24 LTS) | `pty/pinnedProviderCli.ts` (Pi terminal) |

Paths are under `apps/desktop/src/main/services/` unless shown. Shared for
every provider: the pin files in `apps/ade-cli/scripts/pins/`, the manifest
`apps/ade-cli/src/services/tools/toolsManifest.generated.json`, the
self-update switches in `apps/desktop/src/shared/pinnedToolSpawnEnv.ts`, the
terminal launch in `pty/pinnedProviderCli.ts`, and the background-job model
in `chat/sessionNaming.ts`.

Read the provider's dialect or runtime file and its header comment before you
read any release note. The header records what ADE relies on and which
version it was verified against.

## 4. Read every release between the pin and the newest

For each version after the current pin, up to and including the newest:

- Read the vendor's changelog or release notes (GitHub releases, the npm
  package's CHANGELOG, the vendor's docs changelog).
- Where ADE depends on a protocol (ACP `initialize` capabilities, Codex
  app-server JSON-RPC, SDK types, CLI flags), compare the old and new
  package or binary directly: the `.d.ts` files, `--help` output,
  `codex app-server generate-json-schema`, or a captured ACP `initialize`.
  Download into a fresh `/tmp` directory. Never into `~/.ade/tools`.
- You may run the new build's `--version`, `--help` and an ACP `initialize`
  with a scratch `HOME`. Do not make model requests and do not use the
  owner's logins.
- Note every change to: protocol or SDK types, CLI flags ADE passes,
  permission and approval behavior, session resume/fork/close, models and
  reasoning options, auth and login storage, self-update switches, config
  and session file formats (shared with the user's own CLI), Windows
  behavior, and anything a release calls breaking or deprecated.

## 5. Sort every change into three layers

1. **Comes with the bump.** No ADE change. The pin moves and it works
   (bug fixes, speed, new models that ADE already lists from the account).
2. **Small ADE change.** Not a new feature, but ADE must adapt: a renamed
   flag, a new required argument, a changed event shape, a new self-update
   switch, a new model option to map, a test fixture to recapture.
   Name the file and the change.
3. **New feature to design.** A provider capability ADE does not show yet
   (a new mode, a new tool type, new session controls, a new sign-in method).
   Describe what it does, where it could appear in ADE (chat, Settings,
   terminal, mobile), and the questions the owner must answer. Do not design
   the UI alone.

Also list **risks**: anything that can break a running user (a removed flag,
a migration of shared files in `~/.<provider>`, an auth change), and whether
ADE's fall-forward detection still matches (`ai/providerVersionRejection.ts`).

## 6. Report back

Write the report in chat, in this order:

1. Provider, current pin, PR version, newest stable version, and the source
   of each release note you read.
2. The three layers as three lists. Each item: version, change, effect on
   ADE, file(s), size of the work.
3. Risks.
4. What the owner must decide.
5. The exact commands to move the pin when approved (for example
   `npm run tools:pin -- grok 1.0.62` or the Dependabot bump plus
   `npm run tools:manifest`).

Then stop. Do not edit code, pins or lockfiles. When the owner decides, the
work follows the normal dev loop (`/quality`, `/test`, `/ship`).
