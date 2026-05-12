# ADE Code (terminal Work chat)

`ade code` is a terminal-native client for the same **Work** agent chat surface the Electron app exposes in `AgentChatPane`. It targets agents and operators who prefer a shell-first workflow: Ink + React render the TUI, while chat transcripts, slash commands, lane navigation, model picks, and ADE actions all flow through the same JSON-RPC contracts the desktop uses.

It is a client. The runtime, lanes, chats, transcripts, PRs, processes, and proof artifacts live in the per-machine `ade serve` daemon. `ade code` attaches to that daemon, drives a single project scope, and renders incoming events.

## Source file map

| Path | Role |
|------|------|
| `apps/ade-cli/src/cli.ts` | Resolves the built or source TUI entry and forwards the parsed launch context to `runAdeCodeCli`. |
| `apps/ade-cli/src/tuiClient/cli.tsx` | TUI entry: argv parsing, project discovery, connection bootstrap, Ink mount. Built to `apps/ade-cli/dist/tuiClient/cli.mjs`. |
| `apps/ade-cli/src/tuiClient/app.tsx` | Primary Ink/React surface: navigation, composer, drawers, right pane, session lifecycle, slash command dispatch. |
| `apps/ade-cli/src/tuiClient/connection.ts` | Resolves attached vs embedded mode, runs the `ade/initialize` handshake, registers the project with `projects.add`, wraps subsequent requests with `projectId`. |
| `apps/ade-cli/src/tuiClient/jsonRpcClient.ts` | Socket client: connect, request/response, `chat/event` notifications. |
| `apps/ade-cli/src/tuiClient/adeApi.ts` | Typed wrappers over `AdeCodeConnection.action` / `actionList` for lanes, chat, models, navigation, provider readiness, API-key status, OpenCode diagnostics, and project slash-command discovery. |
| `apps/ade-cli/src/tuiClient/commands.ts` / `linearCommands.ts` | Slash command catalog and routing. |
| `apps/ade-cli/src/tuiClient/format.ts` | Transcript rendering helpers for the TUI. |
| `apps/ade-cli/src/tuiClient/state.ts` | Persists terminal-client state such as the last selected chat per lane under the project `.ade/cache` layout. |
| `apps/ade-cli/src/tuiClient/theme.ts` | Shared Ink color and status tokens used by the header, model setup pane, transcript, and controls. |
| `apps/ade-cli/src/tuiClient/types.ts` | `AdeCodeConnection`, `ProjectLaunchContext`, navigation DTOs aligned with `apps/desktop/src/shared/types`. |
| `apps/ade-cli/src/tuiClient/components/` | `AdeWordmark`, `Drawer`, `ChatView`, `Header`, `RightPane`, `SlashPalette`, `MentionPalette`, `ApprovalPrompt`, `ModelStatus`, `FooterControls`. |
| `apps/ade-cli/src/tuiClient/keybindings/index.ts` | Verbatim `~/.claude/keybindings.json` reader and TUI action dispatcher (chord support, vim namespace, clipboard-image paste hooks). Resolves `defaultKeybindingsPath()`, parses the Claude keybindings schema, and maps key sequences onto TUI actions. |
| `apps/ade-cli/src/tuiClient/statusline/index.ts` | Claude-compatible status line config reader and runner. Reads the `~/.claude/statusline.json` contract, executes the configured status command, and exposes the rendered lines to `ModelStatus`. |
| `apps/desktop/src/shared/types/chat.ts` | Canonical chat DTOs (`AgentChatEventEnvelope`, sessions, pending input, `AgentChatContextUsage`, `AgentChatClaudeMcpServerStatus`, `AgentChatClaudeOutputStyle`, `AgentChatClaudePlugin`, subagent kinds). Imported per-module so ade-cli typecheck stays scoped. |
| `apps/desktop/src/shared/modelRegistry.ts` | Default model selection for new sessions (`getDefaultModelDescriptor`). |
| `apps/desktop/src/shared/adeLayout.ts` | Resolves project-scoped `.ade` paths. |

## Modes

### Attached (default)

`ade code` opens a Unix-domain or named-pipe socket connection to the runtime daemon. Resolution order in `connectToAde`:

1. `--socket /path/to/sock` on the parent `ade` process (also reads `ADE_RPC_SOCKET_PATH`).
2. The machine socket from `resolveMachineAdeLayout()` (`~/.ade/sock/ade.sock` or `\\.\pipe\ade-runtime`).
3. If the machine socket is not listening, `connection.ts` calls `spawnDaemon(socketPath)` — a detached `ade serve --socket <socketPath>` — and retries up to 25 times with a 200 ms delay.
4. As a final fallback, the legacy project-scoped socket from `resolveAdeLayout(projectRoot)` if the user passed `--require-socket` and the machine socket is unavailable.

`ade code --print-state` exercises that whole path, prints the chosen mode and socket path, and exits.

### Embedded

`ade code --embedded` (or `ade --headless code`) skips the daemon and builds an `AdeRuntime` in-process via `loadEmbeddedAdeCli()`, which dynamic-imports `bootstrap` and `adeRpcServer` from the `ade-cli` package itself. Used for headless or development environments where Electron / `ade serve` is not present. This mode is single-project, single-process: closing the TUI tears the runtime down.

`forceEmbedded` and `requireSocket` are mutually exclusive — `connectToAde` rejects the combination.

## Initialize handshake

Both modes run the same handshake before the TUI mounts:

```text
-> ade/initialize {
     protocolVersion: "2025-06-18",
     clientName: "ade-code",
     identity: { role: "cto", callerId: "ade-code:<pid>" }
   }
<- { runtimeInfo: { multiProject: true, version, ... }, capabilities: { projects: true, ... } }
-> ade/initialized
```

If the response advertises `runtimeInfo.multiProject === true` or `capabilities.projects === true`, `connection.ts` calls `projects.add { rootPath: <project-root> }`, captures the returned `projectId`, and from then on every project-scoped request is rewritten to include `projectId`. The runtime-scoped methods (the set in `MULTI_PROJECT_RUNTIME_METHODS`: `ade/initialize`, `projects.*`, `ping`, `runtime/info`, etc.) pass through unchanged.

For the embedded runtime there is no `projects.add` step — the in-process runtime is already bound to one project root.

## TUI surface

`apps/ade-cli/src/tuiClient/app.tsx` is the Ink root. Layout:

- **Header** — project name, active lane, branch, and the terminal client frame.
- **Drawer** (toggled with the configured shortcut) — two sections: Lanes and Chats. Selecting a lane in the Lanes pane switches the active lane and filters the Chats pane to that lane's sessions. Lane and chat selection drive the right pane's context.
- **ChatView** — the main transcript. Renders user, assistant, tool, and system events from `chat/event` notifications. Tool calls collapse into expandable blocks; the most recent expandable failure id is tracked so `Enter` can drill into it.
- **Composer** — multi-line input with mention completion (`@…`) sourced from `MentionPalette` and slash command completion from `SlashPalette`. Pending tool approvals surface as `ApprovalPrompt`.
- **RightPane** — context-sensitive drawer for slash command output. The "right" placement commands (see below) render their results here as forms, lists, diffs, help text, or rendered objects.

Heartbeats are kept alive with `startTuiHeartbeat` so the runtime knows the chat client is still attached.

## Slash commands

`commands.ts` exports the built-in slash command catalog. `placement` decides whether the command runs inline in the chat or opens the right pane. The TUI also discovers project command files and Codex prompts before a chat exists, then refreshes against server-provided `AgentChatSlashCommand`s from the active runtime via `getSlashCommands`. Provider/runtime commands win over same-named built-ins except for local terminal controls such as `/login`, `/quit`, `/clear`, and `/end`.

Inline (acts on chat or shell):

| Command | Effect |
| --- | --- |
| `/commit [message]` | Commit lane changes through `git.commit`. |
| `/push` | Push the active lane branch. |
| `/clear` | Clear the local TUI transcript view. |
| `/end` | End the active chat runtime. |
| `/open` | Hand the current ADE context off to desktop via `app/navigate`. |
| `/quit` | Exit `ade code`. |
| `/remember <fact>` | Write a durable ADE memory entry. |

Right pane (open the contextual drawer):

| Command | Pane |
| --- | --- |
| `/new lane` | Lane creation form. |
| `/new chat [title]` | New chat in the active lane. |
| `/rename [title]` | Rename the active chat. |
| `/tag <tag\|clear>` | Tag the active Claude chat (Claude only). |
| `/output-style [style]` | List or select the active Claude output style (Claude only). |
| `/plugin [reload\|native args]` | List, reload, or manage Claude plugins (Claude only). |
| `/agents` | List Claude agents from user/project config (Claude only). |
| `/skills` | List Claude skills from user/project config (Claude only). |
| `/mcp` | Show Claude MCP server status (Claude only). |
| `/context` | Show Claude context usage breakdown (Claude only). |
| `/init` | Generate AGENTS.md and Claude pointer files (Claude only). |
| `/status` | Project, lane, runtime state summary. |
| `/diff` | Active lane diff (file list with summarized hunks). |
| `/log` | Recent commits. |
| `/pr`, `/pr open`, `/pr review`, `/pr checks` | PR state, create/open PR, reviews, checks. |
| `/linear …` (`list`, `workflows`, `run`, `route`, `sync`, `ingress`, `pull`, `comment`, `status`, `assign`) | Linear sub-router; backed by `linearCommands.ts`. |
| `/memory [query]`, `/forget` | Search and manage ADE memory. |
| `/chats` | Sessions in the active lane. |
| `/switch [lane\|chat]` | Switcher palette. |
| `/resume` | Resume the active ended chat. |
| `/help` | Keymap and command help. |
| `/keybindings` | Show Claude-compatible keybinding config diagnostics. |
| `/statusline` | Show Claude-compatible status line config. |
| `/doctor` | Show ADE Code and Claude-compat diagnostics. |
| `/model`, `/effort` | Model and reasoning-effort pickers. |
| `/system` | System and runtime details. |
| `/ade <domain.action> [json]` | Run an allowlisted ADE action; shows result in RightPane. |

Inline chat commands (run through the active Claude SDK session, Claude only):

| Command | Effect |
| --- | --- |
| `/compact [instructions]` | Compact the Claude context window through the active SDK session. |
| `/usage` | Show Claude usage / rate-limit window through the active SDK session. |
| `/insights` | Generate Claude session insights through the active SDK session. |
| `/fast [on\|off]` | Toggle Claude fast mode through the active SDK session. |
| `/goal [condition\|clear]` | Set or clear the Claude completion goal. |

Claude-only commands only appear in the slash palette when the active chat's provider is `claude`. The palette filters built-in entries by their `providers` whitelist so a Codex / OpenCode / Cursor chat does not show parity affordances that have no backing call.

Several slash commands forward to a desktop route when issued from `ade code`:

```text
/app-control          -> /app-control
/browser              -> /browser
/computer             -> /proof
/computer-use         -> /proof
/ios, /ios-sim        -> /ios-sim
/macos-vm             -> /macos-vm
/mission, /missions   -> /missions
/pencil               -> /pencil
/proof                -> /proof
```

`navigateDesktop` posts an `app/navigate` request to the same runtime, which the multi-window desktop shell uses to open or focus the appropriate window. The TUI does not host these surfaces itself; it points the desktop at them.

## Project / lane resolution

`chooseInitialLane` (in `tuiClient/project.ts`) picks the active lane on launch:

1. The lane the user passed via `--lane` (if any).
2. The most recently active lane reported by `lanes.list`.
3. The first lane in the project, falling back to "no lane" when the project has none yet.

Lane selection updates the daemon's session state so the same lane is reflected in desktop and iOS clients attached to the same runtime.

## Launch

```bash
ade code                                 # attached to the machine daemon for the current project
ade code --print-state                   # smoke-test: print mode + socket and exit
ade code --embedded                      # in-process runtime fallback
ade --project-root /repo code            # bind to a different project
ade --socket /tmp/ade-runtime-dev.sock code
                                         # attach to a specific socket (dev runtime, peer machine, etc.)
```

After local changes, run `npm run build` inside `apps/ade-cli` so both `dist/cli.cjs` and `dist/tuiClient/cli.mjs` exist for packaged and linked use. During repo development, `npm run dev:code` runs the source TUI against the shared dev runtime at `/tmp/ade-runtime-dev.sock`.

## Claude Code 2.1.x parity

`ade code` ships verbatim compatibility with the Claude Code 2.1.x terminal contracts so users coming from Claude Code keep their existing config and muscle memory:

- **Keybindings.** `tuiClient/keybindings/index.ts` reads `~/.claude/keybindings.json` (resolved through `defaultKeybindingsPath()`, with `CLAUDE_HOME` and `XDG_CONFIG_HOME` overrides). The full Claude schema is honored — chord sequences, modifier syntax, and the `vim` namespace — and dispatched onto TUI actions through `dispatchKeybinding()`. `/keybindings` surfaces a diagnostics view; `openKeybindingsFile()` opens the config in the user's editor.
- **Status line.** `tuiClient/statusline/index.ts` reads `~/.claude/statusline.json`, executes the configured command, and feeds the rendered lines into `ModelStatus`. `/statusline` shows the contract and the most recent stdout/stderr. When a status command produces output, the status panel hides the default token/context meter for the same row.
- **Vim namespace.** When vim mode is active, the model-status row exposes the current `insert`/`normal` mode tag and the keybindings dispatcher routes `vim.*` actions.
- **Clipboard image paste.** Cross-platform clipboard-image paste is wired into the composer (Linux via `xclip`/`wl-paste`, macOS via `pngpaste`/AppleScript, Windows via PowerShell), so pasting a screenshot uploads it as a Claude attachment alongside text.
- **`auto` permission mode.** The Claude permission picker accepts `auto` (mapped onto the SDK `permissionMode: "auto"`) in addition to `default`, `plan`, `acceptEdits`, and `bypassPermissions`.
- **Subagent panel.** The right pane's subagent surface is re-keyed on `agentId` + `parentToolUseId` and split across three tabs — Subagents, Teammates, Background — so spawned Claude agents and background runs are distinguished. Snapshots are reconstructed live from `subagent_*` envelopes via `subagentSnapshotsFromEvents()`.
- **Context, MCP, output styles, plugins.** `/context`, `/mcp`, `/output-style`, and `/plugin` call `chat.getContextUsage`, `chat.getClaudeMcpStatus`, `chat.listClaudeOutputStyles` / `chat.setClaudeOutputStyle`, and `chat.listClaudePlugins` / `chat.reloadClaudePlugins` against the same Claude SDK runtime the desktop chat uses.

## Chat setup

- `+ new chat` opens a draft setup view in the details pane; it does not create a backend chat until the first prompt is sent from the middle composer.
- `/model` opens the model setup view. It can switch provider, model, reasoning, and permission settings, refresh provider readiness through `ai.getStatus`, and open desktop Settings > AI Providers for full configuration.
- `/login` delegates only to provider CLIs that can authenticate in the current terminal: Claude (`claude auth login`), Codex (`codex login`), and OpenCode (`opencode auth login`). Cursor chat is `@cursor/sdk` and needs `CURSOR_API_KEY` or desktop Settings > AI Providers. Droid chat runs Factory Droid over ACP and needs `FACTORY_API_KEY` or Factory's interactive `droid` login.
- The middle composer shows the selected provider, model, reasoning, and permission mode under the prompt so draft changes on the right are visible before the chat starts.

## Related docs

- [ADE CLI](../../../apps/ade-cli/README.md) — runtime daemon, install paths, service manager, full CLI surface.
- [Chat feature](../chat/README.md) — in-app Work chat architecture (service + renderer); same agent chat backend.
- [Remote runtime](../remote-runtime/README.md) — how the same runtime daemon is reached over SSH.
- [System overview](../../ARCHITECTURE.md) — CLI / terminal client placement in the system diagram.
