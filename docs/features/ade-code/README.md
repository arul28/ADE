# ADE Code (terminal Work chat)

ADE Code is a terminal-native client for the same **Work** agent chat surface the Electron app exposes in `AgentChatPane`. It targets agents and operators who prefer a shell-first workflow: Ink + React render the TUI, while chat transcripts, slash commands, and lane context flow through the same ADE action and JSON-RPC contracts as the desktop.

## Source file map

| Path | Role |
|------|------|
| `apps/ade-cli/src/tuiClient/cli.tsx` | TUI entry: argv parsing, project discovery, connection bootstrap, Ink mount. Built to `apps/ade-cli/dist/tuiClient/cli.mjs` and loaded by `ade code`. |
| `apps/ade-cli/src/tuiClient/app.tsx` | Primary Ink/React surface: navigation, composer, drawers, right pane, session lifecycle. |
| `apps/ade-cli/src/tuiClient/connection.ts` | **Attached** path: JSON-RPC over `.ade/ade.sock` (or Windows named pipe). **Embedded** path: dynamic `import()` of sibling `apps/ade-cli` `bootstrap` + `adeRpcServer` so headless services run in-process. |
| `apps/ade-cli/src/tuiClient/jsonRpcClient.ts` | Socket client: connect, request/response, `chat/event` notifications. |
| `apps/ade-cli/src/tuiClient/adeApi.ts` | Typed wrappers over `AdeCodeConnection.action` / `actionList` for lanes, chat, models, navigation. |
| `apps/ade-cli/src/tuiClient/commands.ts` / `linearCommands.ts` | Slash and command routing. |
| `apps/ade-cli/src/tuiClient/format.ts` | Transcript rendering helpers for the TUI. |
| `apps/ade-cli/src/tuiClient/types.ts` | Connection shape, launch context, navigation DTOs aligned with `apps/desktop/src/shared/types`. |
| `apps/desktop/src/shared/types/chat.ts` | Canonical chat DTOs (`AgentChatEventEnvelope`, sessions, pending input). Imported from **per-module** paths (not `types/index.ts`) so ade-cli typecheck stays scoped. |
| `apps/desktop/src/shared/modelRegistry.ts` | Default model selection for new sessions (`getDefaultModelDescriptor`). |
| `apps/desktop/src/shared/adeLayout.ts` | Resolves `.ade` paths including socket location. |
| `apps/ade-cli/src/cli.ts` | `ade code` launcher: loads the built TUI entry from `dist/tuiClient/cli.mjs`, or the source entry during local development. |
| `apps/desktop/src/main/main.ts` | Multi-window shell: project windows, shared menu, JSON-RPC `app/navigate` for external controllers. |
| `apps/desktop/src/renderer/components/app/TopBar.tsx` | Window tab strip + project navigation when multiple windows are open. |

## Runtime modes

- **Attached** — `JsonRpcClient` connects to the desktop RPC socket. Initialization follows the same `ade/initialize` handshake as other socket clients.
- **Embedded** — no socket: `createAdeRuntime` + `createAdeRpcRequestHandler` from `apps/ade-cli` serve actions in-process. Used for headless/dev environments where Electron is not running.

## Launch

From a machine with the `ade` CLI on `PATH`: `ade code` (see `apps/ade-cli/README.md` for flags and how `--socket` on the parent `ade` process is forwarded). After local changes, run `npm run build` inside `apps/ade-cli` so both `dist/cli.cjs` and `dist/tuiClient/cli.mjs` exist for packaged and linked use.

## Related docs

- [Chat feature](../chat/README.md) — in-app Work chat architecture (service + renderer).
- [ARCHITECTURE.md](../../ARCHITECTURE.md) §2.2–2.3 — CLI and terminal Work chat placement in the system diagram.
