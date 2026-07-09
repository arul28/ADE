# Web Client

The web client is an owner-only browser controller for an ADE machine runtime.
It is a hosted static SPA, but it does not introduce an ADE cloud data path:
after pairing, the browser talks directly to the machine's sync WebSocket
protocol, using the same sync host that iOS uses.

Production hosting is Cloudflare Pages. The Pages URL is
`https://ade-web-client.pages.dev`; the canonical product URL in source is
`https://app.ade-app.dev` (`WEB_CLIENT_BASE_URL`). DNS for the canonical domain
is pending, so use the Pages URL for live deployment checks until it resolves.
The app is built from `apps/desktop` with `npm run build:webclient`.

## Source file map

Build and static host:

- `apps/desktop/package.json` - `dev:webclient` and `build:webclient`.
- `apps/desktop/vite.webclient.config.ts` - Vite build for the hosted SPA.
  Renames `webclient.html` to `index.html`, writes to
  `apps/desktop/dist/web-client`, and copies Cloudflare Pages files into the
  output root.
- `apps/desktop/src/renderer/webclient.html` - browser entry HTML.
- `apps/desktop/src/renderer/webclient/public/_headers` - Pages headers,
  including CSP. `connect-src` allows `wss:` and `https:`, not arbitrary
  hosted-page `ws:` connections.
- `apps/desktop/src/renderer/webclient/public/_redirects` - SPA fallback:
  `/* /index.html 200`.

Browser sync client:

- `apps/desktop/src/renderer/webclient/sync/client.ts` - high-level browser
  sync client. Pairs with PIN, stores environments, sends remote commands,
  requests files, subscribes to chat and terminal streams, switches projects,
  and treats `changeset_batch` as invalidation input.
- `apps/desktop/src/renderer/webclient/sync/connection.ts` - WebSocket
  lifecycle, pairing request, paired hello, DPoP proof on reconnect,
  heartbeat, reconnect/backoff, project catalog chunks, and auth-failure
  attribution.
- `apps/desktop/src/renderer/webclient/sync/endpoints.ts` - derives the
  browser-safe endpoint list. Relay and explicit `wss://` are dialable from the
  hosted page; plain `ws://` is dialable only from local/http pages.
- `apps/desktop/src/renderer/webclient/sync/envStore.ts` - IndexedDB storage
  for paired machine environments, per-device secret, host/candidate metadata,
  and the WebCrypto `CryptoKeyPair`.
- `apps/desktop/src/renderer/webclient/sync/dpop.ts` - WebCrypto P-256 ECDSA
  DPoP key generation and proof signing. The private key is non-extractable by
  default.
- `apps/desktop/src/renderer/webclient/sync/wireProtocol.ts` - browser codec
  for the shared sync envelope format, gzip, and project catalog chunk
  assembly.

Browser `window.ade` adapter:

- `apps/desktop/src/renderer/webclient/adapter/index.ts` - installs a
  sync-backed `window.ade` surface and hides native-only capabilities.
- `apps/desktop/src/renderer/webclient/adapter/infra/commandCaller.ts` -
  remote-command dispatch through `SyncRemoteCommandDescriptor` scope/policy,
  with fallback for unsupported hosts.
- `apps/desktop/src/renderer/webclient/adapter/infra/invalidation.ts` -
  maps changed table names from `changeset_batch` envelopes to coarse
  renderer invalidation domains.
- `apps/desktop/src/renderer/webclient/adapter/files.ts` - browser file API
  over sync `file_request`; no local file watcher.
- `apps/desktop/src/renderer/webclient/adapter/sessionsPty.ts` - terminal and
  PTY APIs over `work.*`, `terminal_*`, and `terminal_history`.
- `apps/desktop/src/renderer/webclient/adapter/agentChat.ts`,
  `lanes.ts`, `git.ts`, `prs.ts`, `project.ts`, `app.ts`, and `misc.ts` -
  web implementations of desktop renderer namespaces, mixing remote commands,
  sync sub-protocols, and local browser-only state. `misc.ts` routes
  `window.ade.usage.getAdeStats` through the viewer-allowed
  `usage.getAdeStats` command so the reused empty-Work activity carousel shows
  the runtime's cached cross-client aggregate instead of an empty native stub.

Browser shell and routes:

- `apps/desktop/src/renderer/webclient/main.tsx` - installs the pending
  `window.ade` placeholder before shared renderer modules import, then mounts
  `WebClientRoot`.
- `apps/desktop/src/renderer/webclient/shell/WebClientRoot.tsx` - boot
  sequence, saved-machine reconnect, pair flow, project picker, adapter load,
  pending `/open` target stash, and project binding.
- `apps/desktop/src/renderer/webclient/shell/PairFlow.tsx` - pairing-link
  parser, PIN entry, device name, manual `wss://` endpoint override, and
  hosted-page reachability errors.
- `apps/desktop/src/renderer/webclient/shell/WebShell.tsx` - machine
  switcher, project switcher, forget machine, reconnect hint, and "Open in
  desktop" button.
- `apps/desktop/src/renderer/webclient/shell/MachinePicker.tsx`,
  `ProjectPicker.tsx`, `PinInput.tsx`, `Welcome.tsx`, and `ScreenShell.tsx` -
  the pair/switch UI pieces the boot sequence composes (saved-machine list,
  project list, 6-digit PIN entry, first-run welcome, and the shared screen
  frame); `shellTokens.ts` holds the standalone-shell design tokens.
- `apps/desktop/src/renderer/webclient/shell/webRoutes.ts` - thin web route
  layer over `apps/desktop/src/shared/deeplinks.ts`.

Reused desktop renderer (web-mode adaptation):

- `apps/desktop/src/renderer/lib/webClientMode.ts` - `isWebClientMode()` reads
  the `window.__adeWebClient` flag the bootstrap stamps before the App module
  loads, and `WEB_CLIENT_TAB_PATHS` lists the only surfaced tabs
  (`/work`, `/lanes`, `/files`, `/prs`). Desktop-only chrome
  (`AppShell.tsx`, `TopBar.tsx`, `TabNav.tsx`, `OnboardingBootstrap.tsx`,
  `WelcomeVideoGate.tsx`) reads this flag to hide native window controls, the
  updater, the onboarding tour, and tabs with no sync-protocol backing instead
  of rendering broken affordances.

Machine runtime and sync host:

- `apps/ade-cli/src/services/sync/syncHostService.ts` - sync WebSocket host,
  pairing/hello auth, DPoP enforcement, changeset fan-out, project catalog,
  project switch, file/chat/terminal sub-protocols, and command routing
  advertisement.
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` - remote
  command registry. It carries 45 web-parity `register("...")` entries for
  Work, chat, terminal, files/git, PRs, project config, AI status, GitHub
  status, history, orchestration, and rebase surfaces, plus the
  runtime-scoped `sync.getWebPairingInfo` command (pairing URL, PIN,
  machine name, relay availability) that backs the iOS "Pair a browser" sheet.
- `apps/ade-cli/src/services/sync/syncPairingStore.ts` - PIN pairing result
  store: per-device secret plus optional DPoP public key.
- `apps/ade-cli/src/services/sync/syncDpop.ts` - host-side P-256 proof
  validation and replay guard.
- `apps/ade-cli/src/services/sync/syncCloudRelayStore.ts` - optional cloud
  tunnel identity and browser/phone-facing
  `wss://<relay>/connect/<machineKey>` URL.
- `apps/ade-cli/src/services/sync/syncTunnelClientService.ts` and
  `apps/tunnel-relay/` - brain-side Cloudflare tunnel client and the relay
  Worker/Durable Object.
- `apps/ade-cli/src/services/sync/brainProjectActionsSyncHandler.ts` -
  machine-level fallback handler for pairing/project actions before a project
  host owns the sync listener.
- `apps/ade-cli/src/services/sync/deviceRegistryService.ts` - device records;
  `SyncPeerDeviceType` includes `browser`.

Pairing, links, and entry points:

- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.tsx` -
  desktop Settings > Sync web-client card, web pairing QR/link, cloud relay
  toggle, and Web clients revoke/remove list.
- `apps/desktop/src/shared/pairingQr.ts` - smart pairing URL
  `https://ade-app.dev/pair#<base64url(JSON)>`; the fragment carries host
  identity, port, address candidates, and optional relay URL, never the PIN.
- `apps/desktop/src/shared/webClientUrl.ts` - canonical
  `https://app.ade-app.dev` URL builder for `/open` and `/pair`.
- `apps/desktop/src/shared/deeplinks.ts` - shared deeplink grammar layered
  under the web client's `/open` route.
- `apps/ade-cli/src/commands/deeplinks.ts` - `ade link --web`.
- `apps/ade-cli/src/tuiClient/deeplinkRow.ts` and
  `apps/ade-cli/src/tuiClient/rightPaneFormatters.ts` - TUI web-link helpers.
- `apps/desktop/src/renderer/components/lanes/LaneContextMenu.tsx` and
  `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` /
  `SessionContextMenu.tsx` - desktop "Open in web" entry points.
- `apps/web/src/app/pages/PairPage.tsx` - marketing-site `/pair` hash-forward
  to the hosted web client.
- `apps/ios/ADE/Views/Settings/SettingsWebClientPairSheet.swift` - iOS
  Settings > Pairing > "Pair a browser" sheet. It fetches the machine's
  pairing URL, PIN, machine name, and relay availability over the
  `sync.getWebPairingInfo` remote command and renders a QR, copyable link,
  and pairing code so a browser can be paired from the phone.

Tests:

- `apps/desktop/src/renderer/webclient/sync/__tests__/sync.test.ts`.
- `apps/desktop/src/renderer/webclient/adapter/__tests__/adapter.test.ts`.
- `apps/desktop/src/renderer/webclient/shell/__tests__/webRoutes.test.ts`.
- `apps/desktop/src/shared/webClientUrl.test.ts`.
- `apps/ade-cli/src/commands/deeplinks.test.ts`.
- `apps/ade-cli/src/tuiClient/__tests__/deeplinkKeybind.test.ts`.
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.test.ts`.

## Gotchas

- **The hosted page cannot dial raw LAN or Tailscale-IP `ws://` endpoints.**
  Browsers block mixed content from `https://app.ade-app.dev`. Use the cloud
  tunnel relay or an operator-provided `wss://` endpoint such as Tailscale
  Serve. `ws://127.0.0.1:<port>` is for local web-client development only.
- **The browser has no ADE database.** It does not load cr-sqlite, does not
  apply changesets, and does not advertise the `changesetAck` capability. A
  `changeset_batch` only tells the adapter which table domains to refresh.
- **IndexedDB is the pairing store.** Clearing site data removes the paired
  secret and the non-extractable DPoP private key, so the browser must pair
  again. The private key cannot be exported for backup or migration.
- **The pairing URL fragment must stay a fragment.** The payload is safe to
  copy because it omits the PIN and fragments are not sent to servers. Do not
  move it into a query parameter or server route.
- **The relay is transport, not cloud state.** The Cloudflare tunnel relay is a
  trusted intermediary for sync frames when enabled; it does not store ADE
  project state, but it can read the frames it pipes. End-to-end payload
  encryption is not implemented in `apps/tunnel-relay/README.md`.
- **Remote-command descriptors are the host authority.** The adapter may have a
  method name, but it only executes when the host advertises the action in
  `hello_ok.features.commandRouting.actions`; otherwise it falls back or
  reports unsupported behavior.
- **Native-only surfaces must stay unavailable in the web adapter.** OS
  notifications, external editor open, reveal in Finder, local directory
  picking, native shells, app control, computer use, built-in browser, iOS
  Simulator, updater, and transcription are not browser capabilities.
- **Build output shape matters.** Cloudflare Pages serves from the output root;
  `_headers`, `_redirects`, and `index.html` must sit directly inside
  `apps/desktop/dist/web-client`.

## Architecture

```
Cloudflare Pages static files
https://app.ade-app.dev
  |
  v
Browser shell
apps/desktop/src/renderer/webclient/shell/
  - pair flow
  - saved machine switcher
  - project picker
  - /open resolver
  - open-in-desktop
  |
  v
AdeSyncClient
apps/desktop/src/renderer/webclient/sync/
  - IndexedDB environment store
  - WebCrypto DPoP key
  - sync envelope codec
  - command/file/chat/terminal/project sub-protocols
  - changeset_batch -> invalidation only
  |
  v
Browser-safe WebSocket transport
  - wss://<relay>/connect/<machineKey>
  - wss://<manual endpoint>
  - ws://127.0.0.1:<port> only from local/http dev
  |
  v
ADE machine runtime (`ade serve`)
apps/ade-cli/src/services/sync/
  - syncHostService
  - syncRemoteCommandService
  - syncPairingStore + DPoP validation
  - project catalog and project switch
  |
  v
Project services and state
  - `.ade/ade.db`
  - lanes / git / PRs / chat / PTYs / files
  - worktrees and runtime processes on the machine
```

The hosted SPA is only the controller UI. The machine runtime remains the
authority for project state, file access, process execution, terminal IO, and
agent/chat mutations.

## Pairing and auth flow

1. The operator opens ADE desktop Settings > Sync and uses the Web client card.
   The QR/link is built with `buildWebClientPairUrl(buildPairingQrPayload(...))`.
2. The pairing URL is `https://app.ade-app.dev/pair#<payload>` for web, with
   the same payload shape as `https://ade-app.dev/pair#<payload>` for mobile.
   The payload contains host identity, port, address candidates, and optional
   relay URL. It does not contain the PIN.
3. `PairFlow.tsx` parses the fragment with `parsePairingQrText`, derives
   browser-safe endpoints, and asks for the 6-digit PIN shown in desktop
   Settings.
4. `client.ts` generates a WebCrypto P-256 ECDSA key pair with
   `extractable: false`, exports the public key, and sends a
   `pairing_request` with `deviceType: "browser"`, the PIN, and
   `dpopPublicKey`.
5. The runtime validates the PIN in `syncPairingStore.ts`, stores a
   per-device secret and the browser's DPoP public key, and returns the paired
   device id plus secret.
6. The browser saves the environment in IndexedDB: host identity, endpoints,
   active project id, paired device id, secret, site id, local device id, and
   the non-extractable key pair.
7. Every reconnect sends a paired `hello` with the secret plus a signed DPoP
   proof. `syncHostService.ts` validates the stored secret, public key, nonce,
   and timestamp before the peer is authenticated.
8. Revocation is machine-owned. In Settings > Sync > Web clients, `Revoke`
   calls the same device-forget path as phones. Connected browser sockets are
   closed; future paired hellos fail. The browser deletes its saved environment
   only when the auth failure is attributed to the same host device id.

## Transport matrix

| Transport | Endpoint shape | Hosted page | Use |
|---|---|---:|---|
| Cloud tunnel relay | `wss://<relay>/connect/<machineKey>` | Yes | Default browser-safe route when the operator enables Cloud relay fallback. The default relay base is in `syncCloudRelayStore.ts`; the runtime keeps the outbound host socket open through `syncTunnelClientService.ts`. |
| Manual secure endpoint | `wss://...` | Yes | Operator-managed TLS endpoint, commonly Tailscale Serve or another local reverse proxy that forwards to the machine sync socket. `PairFlow.tsx` exposes this as the manual endpoint field. |
| Local dev loopback | `ws://127.0.0.1:<port>` or `ws://localhost:<port>` | No | Allowed only from `http:` / localhost pages. Use with `npm --prefix apps/desktop run dev:webclient` or local browser testing. |
| Raw LAN / Tailscale IP | `ws://192.168.x.x:<port>` or `ws://100.x.x.x:<port>` | No | Works only from local/http contexts. Blocked from the hosted HTTPS page as mixed content. |

The web client never talks to an ADE application server for project data. A
Cloudflare Pages request serves static assets; after that all application state
flows through the selected sync WebSocket transport to the machine runtime.

## Data strategy: no local DB

The browser intentionally does not maintain a local replica of `.ade/ade.db`.
`SyncConnection.sendHello` sends `dbVersion: 0` and `capabilities: []`, so the
host does not treat it like a changeset-acknowledging CRDT peer.

Incoming `changeset_batch` envelopes are reduced to a set of table names in
`connection.ts`. `createInvalidationScheduler` maps those table names to
domains such as lanes, sessions, chats, PRs, files, GitHub, and rebase. The
adapter then refreshes through the appropriate remote command or sub-protocol:

- Remote commands: `command` / `command_ack` / `command_result`, routed by
  `syncRemoteCommandService.ts`.
- Files: `file_request` / `file_response`.
- Chat: `chat_subscribe`, `chat_event`, `chat_unsubscribe`.
- Terminal: `terminal_subscribe`, `terminal_data`, `terminal_history`,
  `terminal_input`, and `terminal_resize`.
- Projects: `project_catalog`, `project_catalog_request`,
  `project_switch_request`, and `project_switch_result`.

Browser-local persistence is limited to UI state and pairing state:
`envStore.ts` stores paired environments in IndexedDB, and
`adapter/infra/localState.ts` stores browser-only preferences such as layout,
zoom, and keybinding overrides.

## Deeplinks

The web client uses the shared deeplink grammar rather than defining its own
URL contract.

- `buildWebClientUrl` in `apps/desktop/src/shared/webClientUrl.ts` calls
  `buildDeeplink` and rewrites the origin to `https://app.ade-app.dev`.
- `/open?...` in the hosted client is normalized by `parseOpenTarget` in
  `webRoutes.ts`, then mapped to the same in-app routes the desktop renderer
  uses (`/lanes`, `/work`, `/prs`).
- If a user opens `/open` before a machine is connected, `WebClientRoot.tsx`
  stores the target in session storage and applies it after pairing/connect.
- "Open in desktop" in `WebShell.tsx` maps the current web route back through
  `parseWebPath` and emits the `ade://` form.

Entry points:

- CLI: `ade link ... --web` in `apps/ade-cli/src/commands/deeplinks.ts`.
- TUI: `buildWebClientUrlForRow` in `apps/ade-cli/src/tuiClient/deeplinkRow.ts`.
- Desktop lanes: "Open in web" in `LaneContextMenu.tsx`.
- Desktop sessions: "Open in web" in `TerminalsPage.tsx` /
  `SessionContextMenu.tsx`.
- Marketing pairing URL: `apps/web/src/app/pages/PairPage.tsx` forwards
  `https://ade-app.dev/pair#...` to `https://app.ade-app.dev/pair#...` without
  moving the fragment into server-visible state.

## Deploy and ops

Build from the repo root:

```bash
npm --prefix apps/desktop run build:webclient
```

Expected output:

```text
apps/desktop/dist/web-client/
|-- index.html
|-- _headers
|-- _redirects
`-- assets/...
```

Deploy to Cloudflare Pages:

```bash
npx wrangler pages deploy apps/desktop/dist/web-client --project-name ade-web-client
```

Local browser build loop:

```bash
npm --prefix apps/desktop run dev:webclient
```

The dev server uses Vite on port `5174`. From a local `http://localhost:5174`
page, `deriveBrowserSyncEndpoints` can use loopback `ws://127.0.0.1:<port>`.
That does not apply to the hosted Pages deployment.

Ops checks after deploy:

- `https://ade-web-client.pages.dev/` serves the SPA.
- `https://ade-web-client.pages.dev/open?type=lane&id=<uuid>` falls back to
  `index.html` and the shell parses the target.
- `https://ade-web-client.pages.dev/pair#<payload>` loads `PairFlow` without
  sending the fragment to the server.
- Response headers include the CSP from `_headers`.

## Known limitations

- No OS notifications.
- No external editor open.
- No reveal in Finder / Explorer.
- No native directory picker.
- No local shell process. Terminal creation and IO go through the paired
  machine runtime.
- No ADE Browser, app control, computer use, or iOS Simulator surface.
- No local file watcher. File-change events are synthesized from
  changeset-driven invalidation and are coarser than desktop chokidar events.
- Some progress/live updates are invalidation-triggered snapshots rather than
  the exact desktop event stream.
- Hosted HTTPS cannot dial LAN or Tailscale-IP `ws://` candidates. Use relay
  or `wss://`.
- Browser pairing is per browser profile. Clearing site data or using another
  profile requires pairing again.

## Cross-links

- [Sync and multi-device](../sync-and-multi-device/README.md) - shared sync
  protocol, pairing, DPoP, project catalog, remote commands, and relay.
- [Deeplinks](../deeplinks/README.md) - canonical `ade://` and
  `https://ade-app.dev/open` grammar used by `/open`.
- [Remote runtime](../remote-runtime/README.md) - brain/client model and
  machine project catalog.
- [Tunnel relay](../../../apps/tunnel-relay/README.md) - Cloudflare relay trust
  model and deploy path.
