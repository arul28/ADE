# @ade-dev/demo — DataDesk

A reference third-party app built on `@ade-dev/sdk` + `@ade-dev/chat-ui`, and the live
end-to-end proof that both work against a real ADE runtime.

Nothing here touches the developer's `~/.ade`. Every script boots a throwaway
ADE home under the OS temp dir and kills every process it started on exit.

```
mcp-server.mjs      the toy "demodata" MCP server (streamable HTTP, fake data)
lib/                shared by the app and the tests — the app never imports e2e/
  paths.mjs         demo/repo roots and the runtime binary
  processes.mjs     spawn ownership and kill-by-captured-pid teardown
  isolatedHome.mjs  throwaway ADE home under the OS temp dir
  mcpServer.mjs     starts the toy MCP server; reads its call log
  pickModel.mjs     cheapest-usable-model heuristic
e2e/
  harness.mjs       checks, summary, and settling on a real terminal event
  preflight.mjs     boots the SDK and reports readiness — spends no turn
  live.mjs          the live end-to-end proof — spends ONE turn
app/
  host.mjs          Node host: @ade-dev/sdk + a WebSocket bridge
  start.mjs         starts MCP server + host + Vite together
  src/bridgeClient  the renderer's SDK-shaped proxy over that bridge
  src/App.tsx       the DataDesk UI
artifacts/          screenshots and the MCP call log
```

## Build first

```bash
npm --prefix apps/ade-cli run build   # the runtime the SDK spawns
npm run build:sdk
npm run build:chat-ui
cd packages/demo && npm install
```

## Prove it

```bash
npm run e2e:preflight   # no provider turn: runtime, auth, catalog
npm run e2e:live        # ONE Claude turn on the cheapest model
```

`e2e:live` asserts, in order: doctor is sane; Claude is authenticated; a
`tool_call` names a `demodata` tool; the toy server's own log recorded the same
call; the answer names the invoice that changed; every `tool_result` reuses its
`tool_call`'s `itemId` (the chat-ui collapse contract); `exportThread` returns
parseable JSONL containing the turn; `mcpCapability` reports strict mode
`enforced` with no residual; and a brand-new client on the same home resumes the
thread with its history intact.

## Run the app

```bash
npm run app     # http://127.0.0.1:4317
```

`start.mjs` brings up the toy MCP server, the host and Vite, and tears all three
down together.

## The three seams this app exercises

1. **The SDK is Node-only.** It spawns and owns an ADE runtime, so it lives in
   `app/host.mjs`, not the renderer. The bridge mirrors `AdeChatClient` /
   `AdeThread` method for method rather than inventing an app protocol.
2. **The renderer's proxy satisfies the same interface.** `bridgeClient.ts`
   implements `SdkLikeChatClient` over a WebSocket, and `adaptSdkClient()` from
   `@ade-dev/chat-ui` accepts it unchanged — the client surface survives a process
   boundary with no "remote" mode on either side.
3. **The host owns placement and vocabulary.** Provider cards sit in the
   sidebar; the label map renames `mcp__demodata__get_invoices` to "Searching
   your invoices…"; one `createTheme()` call supplies the brand.
