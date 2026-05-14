# Codex CLI slash-command pass-through audit

Date: 2026-05-12
Scope: every Codex slash command listed in
`apps/desktop/src/main/services/chat/agentChatService.ts:498–533` and the matching
Claude slash list at `:535–577`. Goal: find dead-listed commands (advertised in
the palette but with no working ADE handler, no Codex SDK route, or both) so we
can either wire them properly or remove them from the palette in a follow-up.

## How the pass-through works

The Codex provider keeps almost no slash-command logic in ADE. Only `/fast`,
`/plan`, `/compact`, and `/goal` have explicit local handlers
(`agentChatService.ts:7874–8021`); every other registry entry is forwarded
verbatim to the Codex app server through the `sendMessage` path. The Codex
app server then either resolves the command itself or no-ops.

Because the Codex CLI was authored as a terminal UI, several of its slash
commands operate on TUI concerns (`/keymap`, `/statusline`, `/title`,
`/personality`, `/vim`, `/theme`) that ADE renders differently. Those entries
work in the upstream `codex` binary but produce no useful effect in ADE.

Reference: <https://developers.openai.com/codex/cli/slash-commands>

## Codex registry (`agentChatService.ts:498–533`)

| Command | Listing | Local handler | Codex SDK behavior in ADE | Recommendation |
|---|---|---|---|---|
| `/permissions` | sdk | — | Codex sends a `permissions/configure` notification; ADE has no UI consumer so it lands as a `system_notice` row. | Wire to a renderer surface in a follow-up, or document the no-UI behavior. |
| `/sandbox-add-read-dir` | sdk | — | Forwarded; Codex applies the change in-thread, ADE only sees a confirmation `system_notice`. | Keep — works end-to-end. |
| `/agent` | sdk | — | Used to switch between Codex agent threads (sub-agent identity). ADE collapses agents into a single chat session, so the response is informational only. | Keep but document the limitation; revisit when sub-agent UI lands. |
| `/apps` | sdk | — | Opens an in-CLI "apps" browser. ADE has no equivalent; Codex returns an informational message but no usable UI. | Dead-listed for ADE — remove from palette OR wire a proper modal (post-Tier-A). |
| `/plugins` | sdk | — | Same problem as `/apps`. | Dead-listed — remove or wire UI. |
| `/clear` | sdk | TUI-side `/clear` (ADE Code) shadows | Codex app server's `/clear` resets thread state. ADE Code's TUI overrides it locally to clear the viewport. Desktop renderer has no local override — it forwards. | OK for now; desktop UX may want an explicit "Clear viewport" affordance separate from Codex's destructive `/clear`. |
| `/compact` | sdk | yes (`thread/compact/start`) | Direct wire call; emits `codex_context_compaction`. | Keep — works end-to-end. |
| `/copy` | sdk | — | Codex CLI copies the latest output to its TUI buffer. In ADE there is no such buffer; the request is silently dropped. | Dead-listed for ADE. Either implement `/copy` locally (mirror of TUI `Ctrl+O`) or remove from palette. |
| `/diff` | sdk | — | Codex CLI prints a git diff to stdout. ADE has a richer git pane elsewhere; Codex emits text the renderer displays as an assistant message. | Keep (the textual diff still reads). Consider routing to ADE's diff viewer in a follow-up. |
| `/exit` | sdk | — | Tells Codex CLI to exit. In ADE this terminates the app-server process, which the runtime then auto-restarts — surprising side-effect. | Remove from palette (ADE owns `/quit`; session continuation happens by sending the next message). |
| `/experimental` | sdk | — | Codex toggles experimental flags. Works in ADE. | Keep. |
| `/feedback` | sdk | — | Codex queues logs for upload. Works through the SDK. | Keep. |
| `/init` | sdk | — | Generates an `AGENTS.md` scaffold via Codex. Works. | Keep. |
| `/goal` | sdk | yes (`thread/goal/*`) | Local handler covers `set`, `clear`, `status`, `budget`, `pause`/`resume`. | Keep — works end-to-end. |
| `/logout` | sdk | — | Forwarded. Codex clears credentials. | Keep. |
| `/mention` | sdk | — | Codex CLI's mention UI is keyboard-driven; in ADE we have `@`-mentions in the composer that fulfill this need without `/mention`. | Remove from palette to avoid duplicating the composer affordance. |
| `/model` | sdk | shadowed by `/model` in ADE Code (right pane) | ADE owns model selection via right pane; the Codex SDK reply is redundant text. | Remove the Codex `/model` palette entry (ADE owns model selection). |
| `/fast` | sdk | yes | Local handler. | Keep. |
| `/plan` | sdk | yes | Local handler. | Keep. |
| `/personality` | sdk | — | Codex switches its persona; the change applies inside the Codex thread. Works, but discoverability is low. | Keep. |
| `/ps` | sdk | — | Codex lists background terminals. ADE doesn't expose Codex background terminals; the reply is text-only. | Dead-listed — remove or expose Codex BG terminals. |
| `/stop` | sdk | — | Stops all Codex background terminals. Same coverage gap as `/ps`. | Dead-listed — pair with `/ps` decision. |
| `/fork` | sdk | — | After §A.6, the IPC method `forkCodexThread` is gone but the slash remains in the registry. Sending `/fork` now forwards to Codex SDK; Codex responds with a thread-fork notification that ADE no longer renders. | **Remove from palette.** Audit hand-off: §A.6 was supposed to remove this entry. |
| `/rollback` | local | gone | `rollbackCodexThread` IPC was removed in §A.6; sending `/rollback` from chat just forwards plain text to Codex SDK (no rollback). | **Remove from palette.** §A.6 leftover. |
| `/resume` | sdk | gone | `listCodexThreads`/`resumeCodexThread` IPC was removed in §A.6; ResumePalette is gone in §C.1. The slash now forwards to Codex SDK and Codex responds with a thread-resume UI that ADE never surfaces. | **Remove from palette.** §A.6 leftover. ADE uses its chat sidebar instead. |
| `/unarchive` | local | gone | `unarchiveCodexThread` IPC was removed in §A.6; the slash is now inert. | **Remove from palette.** §A.6 leftover. |
| `/new` | sdk | — | Codex starts a new thread. Conflicts with ADE's own `/new chat` / `/new lane`. | Remove the bare `/new` to avoid clashing with ADE's multi-word commands. |
| `/quit` | sdk | TUI `/quit` shadows | TUI handles it inline (exit the CLI). Desktop renderer forwards to Codex SDK which terminates the app-server. | Keep TUI handling; remove from desktop palette where it has destructive side effects. |
| `/review` | sdk | — | Codex starts a review (`review/start { type: "prompt" }`). §F.4 expands this with `diff`/`branch` variants. | Keep. |
| `/status` | sdk | shadowed by ADE Code right-pane `/status` | TUI overrides; desktop forwards to Codex's text status reply. | Keep, but expect duplicate behavior in desktop. |
| `/debug-config` | sdk | — | Codex prints config diagnostics. Works. | Keep. |
| `/statusline` | sdk | — | Configures the Codex CLI status line. No equivalent in ADE; the change applies in the upstream Codex CLI binary but ADE never displays it. | Remove from palette — TUI-only feature. |
| `/title` | sdk | — | Configures the terminal window/tab title. ADE owns its own window chrome. | Remove from palette — TUI-only feature. |

Commands listed in the task scope (Section E.1) but **not** in the Codex
registry: `/keymap`, `/vim`, `/agents`, `/apps` (already covered), `/plugins`
(already covered), `/hooks`, `/ide`. These either belong to the Claude registry
(`/agents`, `/hooks`, `/ide`) or simply don't exist as Codex slashes
(`/keymap`, `/vim`). The audit task's wording suggests they're cross-listed —
they aren't.

## Claude registry (`agentChatService.ts:535–577`) — short pass

| Command | Notes |
|---|---|
| `/agents`, `/hooks`, `/permissions`, `/ide`, `/statusline` | Claude Agent SDK owns these; ADE forwards. UX is text-only, no modal. Same "dead UI" pattern as Codex's `/apps`. Worth noting but the immediate Tier-A scope keeps them. |
| `/keymap`, `/vim` | Not in either registry. The task description listed them as ADE-advertised but they aren't. No action needed. |
| `/clear`, `/compact`, `/copy`, `/diff`, `/feedback`, `/init`, `/model`, `/quit`, `/review`, `/status`, `/title`, `/resume` | Same observations as the Codex versions — works end-to-end via the SDK, modulo the same TUI-only caveats. |
| `/skills`, `/security-review`, `/simplify`, `/tasks`, `/theme`, `/usage` | Claude-specific surfaces; out of scope for this audit. |

## Summary — recommended palette cleanup (Codex)

Removing the dead-listed entries below tightens the palette and removes the
"I see a command but nothing happens" failure mode. None of these need any
behavior change in this PR — just delete the rows from
`CODEX_BUILT_IN_SLASH_COMMANDS`:

- `/fork`, `/resume`, `/rollback`, `/unarchive` — §A.6 was supposed to remove
  these; they were missed during the wire pass. **High priority.**
- `/apps`, `/plugins`, `/ps`, `/stop` — Codex-CLI-only surfaces with no ADE
  consumer.
- `/mention`, `/new` — duplicate ADE's own composer and `/new chat` flows.
- `/statusline`, `/title` — TUI-only configuration; no effect inside ADE.
- `/exit` — destructive side effect on ADE's runtime; ADE owns `/quit`.

Optional but nice: deduplicate `/model`, `/status`, `/quit`, `/clear` once the
desktop renderer adopts the same shadow-list rules ADE Code's TUI already uses.

## Not done in this task

Per the task scope, this audit is documentation only. No palette entries are
deleted in this PR. The cleanup above is a follow-up PR (or §A.6 fix-forward).
