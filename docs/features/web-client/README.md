# Web Client

The web client is an owner-only browser controller for an ADE machine runtime.
It is a hosted static SPA. New connections are account-only: the browser signs
in to ADE, loads the account machine directory, and adopts the chosen machine over
ADE Relay. Localhost pages retain direct `ws://` for development.

Hosted Relay connections require the browser and machine to be signed in to the
same ADE account. The browser sends a fresh short-lived account proof with each
paired Relay hello, and never persists that proof. Signing out immediately
stops the Relay connection. Environments created from the account machine
directory are removed on sign-out or account switch. Browser environments
paired before this release remain locally owned in IndexedDB and can keep using
their saved direct routes, but the hosted client no longer creates non-account
pairings. Its retired `/pair` route discards the payload and opens the normal
account sign-in flow.

Production hosting is Cloudflare Pages. The Pages URL is
`https://ade-web-client.pages.dev`; the canonical product URL in source is
`https://app.ade-app.dev` (`WEB_CLIENT_BASE_URL`). The canonical domain is live
and attached to the `ade-web-client` Pages project; the Pages URL remains a
direct deployment-check fallback. The app is built from `apps/desktop` with
`npm run build:webclient`.

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
  hosted-page `ws:` connections; `img-src` allowlists the Clerk image CDNs and
  Clerk's Google Storage profile-image path used by the account client.
- `apps/desktop/src/renderer/webclient/public/_redirects` - SPA fallback:
  `/* /index.html 200`.

Browser sync client:

- `apps/desktop/src/renderer/webclient/account/client.ts` - Clerk
  OAuth authorization-code + PKCE session for the static client. Access tokens
  remain in module memory; the refresh credential plus exact OAuth issuer/client
  identity persist in IndexedDB so reload boot can restore and refresh before
  directory access. Profile identity is enriched through a bounded, best-effort
  OAuth userinfo request. The callback is scrubbed from the address bar before
  directory loading, and account requests use exact trusted origins with omitted
  browser credentials and referrers.
- `apps/desktop/src/renderer/webclient/account/sessionStore.ts` - versioned
  IndexedDB refresh-session record. Explicit sign-out and confirmed auth expiry
  clear it; OAuth access tokens are never persisted.
- `apps/desktop/src/renderer/webclient/account/leaseMonitor.ts` - live account
  lifetime enforcement for account-owned environments and active Relay
  sockets. A 30-second check refreshes the in-memory token; confirmed expiry,
  sign-out, or owner change disconnects and prunes account-owned trust, while a
  transient token/directory failure preserves it for retry. A direct-owned
  environment using Relay is disconnected but not deleted.
- `apps/desktop/src/renderer/webclient/sync/client.ts` - high-level browser
  sync client. Adopts a machine through the verified account relay, reconnects
  saved environments, stores only the resulting paired credentials, sends
  remote commands, requests files, subscribes to chat and terminal streams,
  switches projects, and treats `changeset_batch` as invalidation input.
- `apps/desktop/src/renderer/webclient/sync/connection.ts` - WebSocket
  lifecycle, account adoption, paired hello, DPoP proof on reconnect,
  heartbeat, reconnect/backoff, project catalog chunks, and auth-failure
  attribution.
- `apps/desktop/src/renderer/webclient/sync/relayPolicy.ts` - typed hosted Relay
  authorization policy. It keeps local pairing provenance separate from
  account ownership, filters Relay routes while signed out, and surfaces the
  sign-in-required state before a socket is opened.
- `apps/desktop/src/renderer/webclient/sync/endpoints.ts` - derives the
  browser-safe endpoint list. Relay and explicit `wss://` are dialable from the
  hosted page; plain `ws://` is dialable only from local/http pages.
- `apps/desktop/src/renderer/webclient/sync/envStore.ts` - IndexedDB storage
  for paired machine environments, per-device secret, host/candidate metadata,
  the WebCrypto `CryptoKeyPair`, and the separate account-session object store.
  A versioned one-time trust migration
  clears legacy environments and selection while preserving unrelated browser
  and account state; environments paired after the marker persist normally.
- `apps/desktop/src/renderer/webclient/sync/dpop.ts` - WebCrypto P-256 ECDSA
  DPoP key generation and proof signing. The private key is non-extractable by
  default.
- `apps/desktop/src/renderer/webclient/sync/wireProtocol.ts` - browser codec
  for the shared sync envelope format, gzip, and project catalog chunk
  assembly.

Browser `window.ade` adapter:

- `apps/desktop/src/renderer/webclient/adapter/index.ts` - installs a
  sync-backed `window.ade` surface, including the browser account client, and
  hides native-only capabilities.
- `apps/desktop/src/renderer/webclient/adapter/account.ts` - maps the browser
  OAuth session and account directory onto the reused `window.ade.account`
  contract for status, sign-in/out, machine listing, and machine removal.
- `apps/desktop/src/renderer/webclient/adapter/analytics.ts` - affirmative
  browser-local analytics preference, runtime-scoped status/capture calls, and
  per-connection consent reassertion. A failed opt-out acknowledgement closes
  the sync connection so the host cannot keep recording exportable web
  mutations for that peer.
- `apps/desktop/src/renderer/webclient/adapter/infra/commandCaller.ts` -
  remote-command dispatch through `SyncRemoteCommandDescriptor` scope/policy,
  with fallback for unsupported hosts. Read commands that pass `cacheTtlMs`
  (and are not marked `idempotent: false`) go through a per-caller coalescing
  read cache: concurrent identical calls join a single in-flight relay request,
  and the resolved value is reused for the TTL window (3 s). `invalidateCache`
  clears the whole cache or a set of action prefixes so a mutation or a
  `changeset_batch`-driven refresh drops stale reads.
- `apps/desktop/src/renderer/webclient/adapter/infra/coalescingReadCache.ts`
  and `infra/cacheKey.ts` - the shared coalescing/TTL cache primitive and a
  deterministic argument-serializer used to key it. The cache keeps concurrent
  callers joined even when the transport outlasts the TTL (the freshness window
  starts at resolution) and never caches rejections.
- `apps/desktop/src/renderer/webclient/adapter/infra/projectState.ts` - holds
  the bound project and, critically, the `projectId` the shell passed at bind
  time. `getProjectId()` prefers that bound id (then a catalog match by root
  path) over the sync client's persisted `activeProjectId`, which can briefly
  name the prior project during reconnect and would otherwise stamp file
  requests and project commands with a stale id.
- `apps/desktop/src/renderer/webclient/adapter/infra/invalidation.ts` -
  maps changed table names from `changeset_batch` envelopes to coarse
  renderer invalidation domains.
- `apps/desktop/src/renderer/webclient/adapter/files.ts` - browser file API
  over sync `file_request`; no local file watcher. List reads
  (`listWorkspaces` / `listTree` / `listTreeChildren`) are coalesced through a
  3 s read cache and now **surface transport errors** instead of silently
  returning an empty result — the earlier fallback-to-empty behavior masked a
  failed request as a legitimately empty tree, which (combined with the stale
  project-id above) produced the Files tab's spurious "no files" state. Writes
  and `filesInvalidated` events clear the read cache and fan a change event out
  to every workspace id seen for the project rather than a single `"*"` marker.
- `apps/desktop/src/renderer/webclient/adapter/remoteRuntime.ts` - a
  `window.ade.remoteRuntime` stub for the hosted client, which is already
  attached to one paired machine and has no desktop-local target registry, SSH
  discovery, or pairing host. Reads return empty collection-shaped results so
  shared shell components still mount; machine-management mutations throw
  "Desktop machine management is unavailable in ADE Web."
- `apps/desktop/src/renderer/webclient/adapter/prs.ts` - PR namespace over
  remote commands. List/detail reads go through the 3 s read cache, and a
  `prsInvalidated` event no longer emits an empty PR list marker: it invalidates
  the `prs.` cache, then hydrates one coalesced aggregate snapshot
  (`prs.getMobileSnapshot`, falling back to `prs.list`) and emits `prs-updated`
  only when the host actually returned a snapshot. `listAll`, `getForLane`, and
  the non-conflict `listWithConflicts` are all derived from that one batched
  snapshot instead of separate per-call round-trips.
- `apps/desktop/src/renderer/webclient/adapter/sessionsPty.ts` - terminal and
  PTY APIs over `work.*`, `terminal_*`, and `terminal_history`.
- `apps/desktop/src/renderer/webclient/adapter/agentChat.ts`,
  `personalChats.ts`, `lanes.ts`, `git.ts`, `prs.ts`, `project.ts`, `app.ts`, and `misc.ts` -
  web implementations of desktop renderer namespaces, mixing remote commands,
  sync sub-protocols, and local browser-only state. The chat adapter routes
  smart-link metadata through viewer-allowed `chat.resolveSmartLinkPreview`
  and falls back to the shared deterministic provider label when an older host
  does not advertise the action. It also routes
  durable scheduled-work create/list/cancel/pause through the host command
  descriptors, so the reused Work and Settings surfaces do not depend on
  Electron-only preload methods. `misc.ts` routes
  `window.ade.usage.getAdeStats` through the viewer-allowed
  `usage.getAdeStats` command so the reused empty-Work activity module shows
  the runtime's cached cross-client aggregate instead of an empty native stub.
  `personalChats.ts` invokes
  runtime-scoped `personalChats.*` actions with `requireProject: false`, adds
  explicit `chatScope: "personal"` transcript subscriptions, dedupes their
  events, and provides the cursor stream consumed by the shared Chats page.

Browser shell and routes:

- `apps/desktop/src/renderer/webclient/main.tsx` - installs the pending
  `window.ade` placeholder before shared renderer modules import, then mounts
  `WebClientRoot`.
- `apps/desktop/src/renderer/webclient/shell/WebClientRoot.tsx` - boot
  sequence, retired-`/pair` scrubbing, account privacy pruning, account-first
  machine picker,
  30-second active-account lease monitor, project picker, adapter load, pending
  `/open` target stash, project binding, and projectless `/chats` routing before
  a project is selected. Project binding now passes the selected `project.id`
  (from the switch result when available) into `bindProject` so the adapter's
  `getProjectId()` cannot fall back to a stale `activeProjectId` mid-reconnect,
  and a failed `switchProject` surfaces its message instead of being swallowed.
  Saved machines are shown first instead of reconnecting automatically on page
  load.
- `apps/desktop/src/renderer/webclient/shell/WebShell.tsx` - machine
  switcher, project switcher, forget machine, reconnect hint, and "Open in
  desktop" button.
- `apps/desktop/src/renderer/webclient/shell/MachinePicker.tsx`,
  `ProjectPicker.tsx`, and `ScreenShell.tsx` - the account/switch UI pieces the
  boot sequence composes (account machines, compatible saved-machine list,
  project list, and the shared screen frame); `shellTokens.ts` holds the
  standalone-shell design tokens.
- `apps/desktop/src/renderer/webclient/shell/AccountIdentity.tsx` - shared
  signed-in identity label and trusted profile-image/initials fallback for the
  machine picker and connected shell; opaque account IDs are not shown.
- `apps/desktop/src/renderer/webclient/shell/webRoutes.ts` - thin web route
  layer over `apps/desktop/src/shared/deeplinks.ts`.

Reused desktop renderer (web-mode adaptation):

- `apps/desktop/src/renderer/lib/webClientMode.ts` - `isWebClientMode()` reads
  the `window.__adeWebClient` flag the bootstrap stamps before the App module
  loads, and `WEB_CLIENT_TAB_PATHS` lists the only surfaced tabs
  (`/work`, `/lanes`, `/files`, `/prs`, `/chats`). Desktop-only chrome
  (`AppShell.tsx`, `TopBar.tsx`, `TabNav.tsx`, `OnboardingBootstrap.tsx`,
  `WelcomeVideoGate.tsx`) reads this flag to hide native window controls, the
  updater, the onboarding tour, and tabs with no sync-protocol backing instead
  of rendering broken affordances.
- `apps/desktop/src/renderer/components/app/TopBar.tsx` and
  `ConnectionsPanel.tsx` - the single desktop Connections control and its
  Machines, Phone, and Web tabs. The Web tab reports connected browser peers
  and directs signed-out users to account sign-in; the entire native control is
  omitted from the hosted web-client shell.
- `apps/desktop/src/renderer/components/analytics/ProductAnalyticsLifecycle.tsx`
  - reused route/project lifecycle capture plus the hosted-web consent banner.
  It sends only normalized inputs through `window.ade.analytics`; the browser
  client never talks to PostHog directly.

Machine runtime and sync host:

- `apps/ade-cli/src/services/sync/syncHostService.ts` - sync WebSocket host,
  pairing/hello auth, DPoP enforcement, changeset fan-out, project catalog,
  project switch, file/chat/terminal sub-protocols, and command routing
  advertisement.
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` - remote
  command registry. It carries the web-parity `register("...")` entries for
  Work, chat, terminal, files/git, PRs, project config, AI status, GitHub
  status, history, orchestration, rebase, and safe smart-link preview surfaces.
  The legacy runtime-scoped
  `sync.getWebPairingInfo` descriptor remains in the protocol, but no current
  iOS or hosted-web UI uses it to create browser pairings.
- `apps/ade-cli/src/services/sync/productAnalyticsRemoteCommand.ts` and
  `syncHostService.ts` - bind untrusted browser capture requests to the host's
  `web` surface/project and keep `analytics.setClientEnabled` peer-scoped. A
  browser choice never changes the machine-wide desktop/runtime preference.
- `apps/ade-cli/src/services/sync/syncPairingStore.ts` - pairing result store:
  per-device secret, optional DPoP public key, and explicit local/account
  provenance used for owner-scoped revocation.
- `apps/ade-cli/src/services/sync/syncDpop.ts` - host-side P-256 proof
  validation and replay guard.
- `apps/ade-cli/src/services/sync/syncCloudRelayStore.ts` - stable cloud-tunnel
  `machineKey`/HMAC identity and browser/phone-facing
  `wss://<relay>/connect/<machineKey>` URL. Deprecated enablement fields are
  removed when the file is read; account sign-in is the only availability gate.
- `apps/ade-cli/src/services/sync/syncTunnelClientService.ts` and
  `apps/tunnel-relay/` - brain-side Cloudflare tunnel client and the relay
  Worker/Durable Object.
- `apps/ade-cli/src/services/sync/brainProjectActionsSyncHandler.ts` -
  machine-level fallback handler for pairing/project actions before a project
  host owns the sync listener.
- `apps/ade-cli/src/services/sync/deviceRegistryService.ts` - device records;
  `SyncPeerDeviceType` includes `browser`.

Account connection and entry points:

- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.tsx` -
  the focused **Connections > Phone** and **Connections > Web** tab bodies plus
  the shared **This Mac** card. The Web variant is account-sign-in only; the
  This Mac card owns the PIN manager and internal phone QR.
- `apps/desktop/src/shared/pairingQr.ts` - smart pairing URL
  `https://ade-app.dev/pair#<base64url(JSON)>`; the fragment carries host
  identity, port, address candidates, an optional relay URL, and an additive
  optional `pinConfigured` hint (the `PairingQrPayload` type) — never the PIN.
  This remains internal wire encoding for the phone's system-camera/App Clip
  flow, not a user-facing browser pairing link.
- `apps/desktop/src/shared/webClientUrl.ts` - canonical
  `https://app.ade-app.dev` URL builder. `/open` remains user-facing; `/pair`
  is retired in the hosted shell.
- `apps/desktop/src/shared/deeplinks.ts` - shared deeplink grammar layered
  under the web client's `/open` route.
- `apps/ade-cli/src/commands/deeplinks.ts` - `ade link --web`.
- `apps/ade-cli/src/tuiClient/deeplinkRow.ts` and
  `apps/ade-cli/src/tuiClient/rightPaneFormatters.ts` - TUI web-link helpers.
- `apps/desktop/src/renderer/components/lanes/LaneContextMenu.tsx` and
  `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` /
  `SessionContextMenu.tsx` - desktop "Open in web" entry points.
- `apps/web/src/app/pages/PairPage.tsx` - marketing-site landing for the smart-QR
  URL. It no longer hash-forwards to the hosted client; the only visitors who
  reach this HTML opened the QR URL on a device **without** the ADE app, so the
  page reads nothing from `window.location` (there is no fragment to copy or
  forward) and simply points them at the iPhone app, with a secondary "open the
  web client instead" link. Separately, the hosted client's own `/pair` route is
  scrubbed by `WebClientRoot` and drops into sign-in.
- `apps/web/scripts/check-entities.mjs` - dependency-free TypeScript-AST guard
  run by the marketing-site build. It rejects unsupported named HTML entities
  in JSX text, expressions, and attributes before they can ship as literal UI
  text.

Tests:

- `apps/desktop/src/renderer/webclient/account/client.test.ts` - OAuth callback,
  refresh-session persistence/rotation/expiry, JWT lifetime, userinfo profile,
  and browser storage/URL privacy contracts.
- `apps/desktop/src/renderer/webclient/sync/envStore.test.ts` - browser trust
  migration plus bounded and cooperative IndexedDB schema upgrades.
- `apps/desktop/src/renderer/components/app/TopBar.test.tsx`.
- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.test.tsx`.
- `apps/desktop/src/renderer/webclient/sync/__tests__/sync.test.ts`.
- `apps/desktop/src/renderer/webclient/adapter/__tests__/adapter.test.ts`.
- `apps/desktop/src/renderer/webclient/shell/__tests__/MachinePicker.test.tsx` -
  signed-in identity, account-machine availability, and reauthentication UI.
- `apps/desktop/src/renderer/webclient/shell/__tests__/webRoutes.test.ts`.
- `apps/desktop/src/renderer/webclient/shell/__tests__/WebClientRoot.test.tsx` -
  verifies that legacy `/pair#...` entry is scrubbed and lands on account sign-in.
- `apps/desktop/src/shared/webClientUrl.test.ts`.
- `apps/ade-cli/src/commands/deeplinks.test.ts`.
- `apps/ade-cli/src/tuiClient/__tests__/deeplinkKeybind.test.ts`.
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.test.ts`.

## Gotchas

- **The hosted page cannot dial raw LAN or Tailscale-IP `ws://` endpoints.**
  Browsers block mixed content from `https://app.ade-app.dev`. New connections
  use the account-authorized cloud relay. A saved pre-release environment may
  still use an already-verified direct `wss://` route.
  `ws://127.0.0.1:<port>` is for local web-client development only.
- **The browser has no ADE database.** It does not load cr-sqlite, does not
  apply changesets, and does not advertise the `changesetAck` capability. A
  `changeset_batch` only tells the adapter which table domains to refresh.
- **Protocol version 1 extensions are additive.** The browser decodes the
  common envelope and ignores valid types it does not implement, including the
  desktop-only `rpc_*` and `fwd_*` channels. Unknown `hello_ok.features` keys
  are harmless, and missing additive keys mean the related capability is not
  available rather than failing the handshake.
- **IndexedDB is the connection and refresh-session store.** Clearing site data
  removes the account refresh credential, paired secrets, and non-extractable
  DPoP private keys. The browser must sign in and
  adopt the account machine again; a legacy direct environment cannot be
  recreated through the hosted UI. The private key cannot be exported for
  backup or migration.
- **Analytics consent is browser-local and fail-closed.** The preference lives
  in local storage, while the host keeps an in-memory consent bit for that
  paired socket. Every adapter connection reasserts the local choice before
  capture; missing storage or a failed disable acknowledgement does not fall
  back to machine-wide consent. Accepted events still consume the host's
  shared 200-event daily budget. See [logging and product analytics](../../logging.md).
- **The smart-QR payload must stay a fragment.** The
  `https://ade-app.dev/pair#...` form survives only as internal wire encoding
  for phone system-camera/App Clip pairing. It omits the PIN, and fragments are
  not sent to servers. Do not turn it back into a user-facing hosted pairing
  route or move it into a query parameter.
- **The relay is transport, not cloud state.** The Cloudflare tunnel relay is a
  trusted intermediary for sync frames while the Mac is signed in; it does not
  store ADE project state, but it can read the frames it pipes. There is no
  separate relay toggle. End-to-end payload encryption is not implemented;
  adding it is planned security work.
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
  - account sign-in + machine directory
  - saved-environment compatibility switcher
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
  - saved pre-release direct wss:// endpoint
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

## Account connection and auth flow

1. The operator opens `https://app.ade-app.dev` and signs in to ADE. Desktop's
   **Connections > Web** surface points to this account flow; it exposes no QR,
   link, PIN, or manual endpoint entry.
2. The browser loads the Clerk-scoped account machine directory and shows the
   signed-in owner's available Macs.
3. Selecting a Mac captures the exact browser account-session generation,
   obtains a fresh access token, and dials only the directory-verified
   `wss://<relay>/connect/<machineKey>` endpoint.
4. `client.ts` generates a non-extractable WebCrypto P-256 ECDSA key pair and
   performs account adoption. The runtime requires the same-account proof,
   stores the browser's DPoP public key, and returns a per-device paired secret.
5. Before committing anything, the browser rechecks that the account-session
   generation is unchanged. It then saves the environment, paired secret, and
   non-extractable key pair in IndexedDB.
6. Every reconnect sends a paired `hello` with the secret plus a signed DPoP
   proof. Relay reconnects additionally fetch a fresh in-memory account proof;
   direct routes saved after adoption use the paired credential without sending
   the Clerk bearer over plaintext `ws://`.
7. Sign-out or account switch closes the Relay socket and removes account-owned
   environments. Machine-side revocation closes connected browser sockets and
   makes future paired hellos fail.

The hosted `/pair` route and `PairFlow`/`PinInput` UI are removed. Older browser
environments already paired locally remain listed under **Saved on this
browser** and can keep reconnecting over their saved direct routes. This is a
compatibility exception only; new non-account web pairings are not possible.

This release does not bump the existing versioned trust-reset marker or clear
saved environments. The historical version-1 migration still runs once on a
browser profile that has never completed it; after that marker is present,
account-owned and legacy-local environments persist according to the ownership
rules above.

## Transport matrix

| Transport | Endpoint shape | Hosted page | Use |
|---|---|---:|---|
| Cloud tunnel relay | `wss://<relay>/connect/<machineKey>` | Yes | Account-authorized route for every new hosted connection. The runtime keeps the outbound host socket open through `syncTunnelClientService.ts` whenever the Mac is signed in; there is no separate Settings/CLI toggle. |
| Saved direct endpoint | `wss://...` | Yes | Compatibility only for an environment paired before hosted non-account pairing was removed; there is no manual endpoint field for new connections. |
| Local dev loopback | `ws://127.0.0.1:<port>` or `ws://localhost:<port>` | No | Allowed only from `http:` / localhost pages. Use with `npm --prefix apps/desktop run dev:webclient` or local browser testing. |
| Raw LAN / Tailscale IP | `ws://192.168.x.x:<port>` or `ws://100.x.x.x:<port>` | No | Works only from local/http contexts. Blocked from the hosted HTTPS page as mixed content. |

The web client never talks to an ADE application server for project data. A
Cloudflare Pages request serves static assets; after that all application state
flows through the selected sync WebSocket transport to the machine runtime.

## Account machine directory

ADE account sign-in is the only way to create a new hosted-web connection. The
machine picker loads the user's machines from the Clerk-verified
account-directory Worker. Offline machines remain listed with their last-seen
state and cannot be selected. Saved pre-release direct environments are shown
separately as a local compatibility path; they are not a pairing fallback.

Hosted builds use ADE's production Clerk application and production directory
by default. Vite development uses the isolated development Clerk application
and directory. Self-hosted builds can override that selection with these
build-time variables:

```text
VITE_ADE_CLERK_ISSUER=https://<clerk-instance-or-approved-proxy>
VITE_ADE_CLERK_OAUTH_CLIENT_ID=<public-oauth-client-id>
VITE_ADE_ACCOUNT_DIRECTORY_URL=https://<account-directory-worker>
VITE_ADE_ACCOUNT_RELAY_URLS=https://<approved-relay-base>[,https://<another-base>]
```

`VITE_ADE_ACCOUNT_RELAY_URLS` is optional when using ADE's default production
tunnel relay; set it for additional approved relay deployments.

The Clerk OAuth application must allow the exact hosted callback
`https://app.ade-app.dev/account/callback` (plus an explicit loopback callback
for local development when needed). The Worker must set `WEB_CLIENT_ORIGIN` to
the exact hosted origin. No wildcard origin is accepted for a request carrying
an account bearer.

The account bearer is sent only to the configured Clerk token endpoint, the
exact trusted account-directory origin, and a clean directory-advertised
`wss://` endpoint matching an allowlisted relay base plus the exact
`/connect/<machineKey>` path. It is never placed in a query,
fragment, log, analytics payload, IndexedDB, local storage, or session storage.
After a new account adoption, the browser persists the returned paired secret
and pinned DPoP key and reconnects through the ordinary paired flow; LAN,
tailnet, and direct `ws://` routes are eligible only at that point. A verified
same-owner account hello with the already-pinned DPoP key may rotate and return
a fresh paired secret, making a lost credential-delivery response retryable
without allowing a different account or key to take over the record. If no
verified WSS relay exists, account connection fails closed.

Every account-adopted IndexedDB environment records the Clerk user id that
created it. Sign-out removes that user's environments, paired secrets, and
non-extractable DPoP keys and disconnects an active owned environment. Legacy
local pairings have no account owner and remain available for their saved
direct routes. If an already direct-paired machine also appears in the account
directory, selecting it keeps the existing direct provenance instead of making
it disappear on sign-out.

Account pairing captures the exact browser session generation before network
work and checks it again before persistence, so a late response after sign-out
or account switch cannot recreate trust. While an account-owned environment or
a direct-owned environment's verified Relay route is active, the browser
refreshes that account lease every 30 seconds. Confirmed expiry/revocation or an
owner change closes the connection immediately; transient refresh and directory
outages do not delete saved trust. Direct-owned environments remain available
for their non-Relay routes.

## Data strategy: no local DB

The browser intentionally does not maintain a local replica of `.ade/ade.db`.
`SyncConnection.sendHello` sends `dbVersion: 0` and `capabilities: []`, so the
host does not treat it like a changeset-acknowledging CRDT peer.

Because there is no local replica, every read is a live relay round-trip to the
machine — where the desktop renderer would hit its in-process cr-sqlite. Two
adapter-side measures keep that from turning routine UI into a burst of
redundant relay traffic. First, read commands and file-list requests pass
through a short (3 s) **coalescing read cache**: concurrent identical reads join
one in-flight request and reuse its result for the TTL window, while any
mutation or `changeset_batch`-driven invalidation drops the affected entries.
Second, the PRs surface **batches** its reads: instead of separate `prs.list` /
`prs.getForLane` / `listWithConflicts` round-trips it hydrates a single
coalesced `prs.getMobileSnapshot` and derives the list views from it, and a
`prsInvalidated` event triggers exactly one aggregate refresh rather than an
empty-list marker. These caches are freshness hints over the authoritative
relay reads, not a persisted store.

Incoming `changeset_batch` envelopes are reduced to a set of table names in
`connection.ts`. `createInvalidationScheduler` maps those table names to
domains such as lanes, sessions, chats, PRs, files, GitHub, and rebase. The
adapter then refreshes through the appropriate remote command or sub-protocol:

- Remote commands: `command` / `command_ack` / `command_result`, routed by
  `syncRemoteCommandService.ts`. This includes best-effort smart-link metadata;
  the browser never fetches arbitrary pasted URLs directly.
- Files: `file_request` / `file_response`.
- Chat: `chat_subscribe`, `chat_event`, `chat_unsubscribe`.
- Terminal: `terminal_subscribe`, `terminal_data`, `terminal_history`,
  `terminal_input`, and `terminal_resize`.
- Projects: `project_catalog`, `project_catalog_request`,
  `project_switch_request`, and `project_switch_result`.
- Personal chats: runtime-scoped `personalChats.*` commands plus
  `chat_subscribe` / `chat_event` carrying `chatScope: "personal"`. These are
  not inferred from, or stored in, the selected project's changeset stream.

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
  stores the target in session storage and applies it after sign-in/connect.
- "Open in desktop" in `WebShell.tsx` maps the current web route back through
  `parseWebPath` and emits the `ade://` form.

Entry points:

- CLI: `ade link ... --web` in `apps/ade-cli/src/commands/deeplinks.ts`.
- TUI: `buildWebClientUrlForRow` in `apps/ade-cli/src/tuiClient/deeplinkRow.ts`.
- Desktop lanes: "Open in web" in `LaneContextMenu.tsx`.
- Desktop sessions: "Open in web" in `TerminalsPage.tsx` /
  `SessionContextMenu.tsx`.
- Smart-QR URL landing: `apps/web/src/app/pages/PairPage.tsx` is an app-first
  fallback. It does not forward the fragment anywhere — it points a browser
  visitor at the iPhone app (secondary "open the web client instead" link) — and
  the hosted client separately retires its own `/pair` route by scrubbing the
  payload and entering the normal sign-in flow. The `https://ade-app.dev/pair#...`
  form is internal phone QR/App Clip encoding, not a browser pairing link.

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
- Account sign-in returns to `/account/callback`, removes the callback query,
  and shows the signed-in machine directory without writing tokens to browser
  storage.
- `https://ade-web-client.pages.dev/open?type=lane&id=<uuid>` falls back to
  `index.html` and the shell parses the target.
- `https://ade-web-client.pages.dev/pair#<payload>` scrubs the obsolete route
  and fragment, then shows account sign-in; no pairing UI is rendered.
- Response headers include the CSP from `_headers`.

## Known limitations

- No OS notifications.
- No external editor open.
- No reveal in Finder / Explorer.
- No native directory picker.
- No local shell process. Terminal creation and IO go through the paired
  machine runtime.
- No ADE Browser, app control, computer use, or iOS Simulator surface.
  Projectless Chats therefore shows its runtime-backed Terminal control but not
  the desktop-only Browser button/profile.
- No local file watcher. File-change events are synthesized from
  changeset-driven invalidation and are coarser than desktop chokidar events.
- Some progress/live updates are invalidation-triggered snapshots rather than
  the exact desktop event stream.
- Hosted HTTPS cannot dial LAN or Tailscale-IP `ws://` candidates. Use relay
  or `wss://`.
- Account-adopted browser trust is per browser profile. Clearing site data or
  using another profile requires signing in and adopting the Mac again. A
  legacy direct environment lost this way cannot be recreated through the
  hosted client.

## Cross-links

- [Personal chats](../personal-chats/README.md) - machine-scoped projectless
  chat storage, command surface, transcript scope, and shared UI contract.
- [Sync and multi-device](../sync-and-multi-device/README.md) - shared sync
  protocol, pairing, DPoP, project catalog, remote commands, and relay.
- [Deeplinks](../deeplinks/README.md) - canonical `ade://` and
  `https://ade-app.dev/open` grammar used by `/open`.
- [Remote runtime](../remote-runtime/README.md) - brain/client model and
  machine project catalog.
- [Tunnel relay](../../../apps/tunnel-relay/README.md) - Cloudflare relay trust
  model and deploy path.
