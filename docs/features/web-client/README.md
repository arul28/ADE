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

The browser uses the same abstract route order as native controllers:
LAN → Tailscale → Relay. Eligibility is surface-specific, however: production
HTTPS blocks insecure `ws://` LAN and tailnet addresses, so they are filtered
before dialing and Relay is normally the only eligible route. Local HTTP
development can exercise the direct candidates. Each connection cycle uses one
correlation id, bounded endpoint metadata, and coarse failure classes so browser,
directory, and relay logs can be joined without exposing credentials or URLs.

Production hosting is Cloudflare Pages. The Pages URL is
`https://ade-web-client.pages.dev`; the canonical product URL in source is
`https://app.ade-app.dev` (`WEB_CLIENT_BASE_URL`). The canonical domain is live
and attached to the `ade-web-client` Pages project; the Pages URL remains a
direct deployment-check fallback. The app is built from `apps/desktop` with
`npm run build:webclient`.

## Source file map

Build and static host:

- `apps/desktop/package.json` - `dev:webclient` and `build:webclient`. The
  production build runs `check-webclient-entry.mjs` after Vite succeeds.
- `apps/desktop/vite.webclient.config.ts` - Vite build for the hosted SPA.
  Renames `webclient.html` to `index.html`, writes to
  `apps/desktop/dist/web-client`, and copies Cloudflare Pages files into the
  output root. It relies on Rollup's normal graph splitting instead of forcing
  the desktop renderer's heavy vendor groups into eager module preloads; the
  shared renderer's dynamic imports remain the feature-loading boundaries.
- `apps/desktop/scripts/check-webclient-entry.mjs` - post-build regression
  guard for the first-load graph. It collects local entry scripts and
  `modulepreload` links from the generated `index.html`, rejects eagerly linked
  Monaco/graph/terminal/Markdown-style chunks, rejects external entry scripts,
  and caps raw entry HTML plus referenced JavaScript at 1000 KB.
- `apps/desktop/src/renderer/webclient.html` - browser entry HTML. It paints a
  dependency-free loading shell before React evaluates and preconnects to the
  production Clerk and account-directory origins.
- `apps/desktop/src/renderer/webclient/public/_headers` - Pages headers,
  including CSP. `connect-src` allows `wss:` and `https:`, not arbitrary
  hosted-page `ws:` connections. Fingerprinted `/assets/*` responses are cached
  for one year as immutable; `/` and `/index.html` remain `no-cache` so a new
  deployment's entry graph is discovered immediately. `img-src` allowlists the Clerk image CDNs and
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
  switches projects, and treats compact `invalidation_batch` envelopes as
  refresh input. Its
  terminal subscriptions keep logical UTF-8 byte watermarks, drop duplicates,
  trim overlaps, and perform one guarded `sinceOffset` resubscribe when a gap
  appears. Delta snapshots append only the missing suffix; full snapshots are
  authoritative replacements even when their end offset equals the watermark.
- `apps/desktop/src/renderer/webclient/sync/connection.ts` - WebSocket
  lifecycle, account adoption, paired hello, DPoP proof on reconnect,
  heartbeat, reconnect/backoff, project catalog chunks, and auth-failure
  attribution, with one correlation id spanning directory lookup and route
  attempts. DPoP/token preparation begins in parallel with the socket dial;
  transport open and authenticated hello have separate 8-second and 12-second
  deadlines. Relay authorization is renewed in place ahead of expiry even
  while the tab is hidden, so background timer throttling does not turn a
  healthy socket into a reconnect loop. Relay sockets negotiate ready-v2
  first: no ADE hello is sent
  before `accepted` then `ready`; an old Worker that does not send `accepted`
  within the short negotiation window is retried on a fresh legacy socket,
  never downgraded in place. While the page is visible, a 15-second watchdog closes a socket
  after 75 seconds without inbound traffic; returning to a visible stale tab
  bypasses accumulated backoff. Relay application close codes are translated
  into stable offline/capacity/retry messages instead of exposing raw reasons.
- `apps/desktop/src/renderer/webclient/sync/relayPolicy.ts` - typed hosted Relay
  authorization policy. It keeps local pairing provenance separate from
  account ownership, filters Relay routes while signed out, and surfaces the
  sign-in-required state before a socket is opened.
- `apps/desktop/src/renderer/webclient/sync/endpoints.ts` - derives the
  ordered browser-safe endpoint list (LAN, Tailscale, Relay). Relay and explicit
  `wss://` are dialable from the hosted page; plain `ws://` is dialable only
  from local/http pages.
- `apps/desktop/src/renderer/webclient/sync/envStore.ts` - IndexedDB storage
  for paired machine environments, per-device secret, host/candidate metadata,
  the WebCrypto `CryptoKeyPair`, and the separate account-session object store.
  A versioned one-time trust migration
  clears legacy environments and selection while preserving unrelated browser
  and account state; environments paired after the marker persist normally.
  Every operation runs through an explicit transaction; trust reset and
  account-owner pruning update environments, selection, and metadata
  atomically. Generic IndexedDB opens fail after 4 seconds; a blocked upgrade
  gets a 5-second grace period for another tab to close and reports a distinct
  typed failure. Rejected cached promises are cleared so Retry can reopen, and
  `versionchange` closes/resets the database and the trust-reset state.
- `apps/desktop/src/renderer/webclient/sync/dpop.ts` - WebCrypto P-256 ECDSA
  DPoP key generation and proof signing. The private key is non-extractable by
  default.
- `apps/desktop/src/renderer/webclient/sync/wireProtocol.ts` - browser codec
  for the shared sync envelope format, gzip, and project catalog chunk
  assembly.

Browser `window.ade` adapter:

- `apps/desktop/src/renderer/webclient/adapter/index.ts` - installs a
  sync-backed `window.ade` surface, including the browser account client, and
  hides native-only capabilities. A project rebind creates an explicit project
  boundary: it drops old terminal subscriptions, clears command-read caches,
  binds the newly selected id, and fans a full-domain invalidation out before
  the reused renderer can hydrate stale project data.
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
  sync-driven refresh drops stale reads.
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
  maps changed table names from `invalidation_batch` envelopes to coarse
  renderer invalidation domains. Its coalescing timer starts with the first
  pending change rather than resetting on every one, so sustained chat or
  terminal activity cannot postpone a lane/session/PR refresh indefinitely.
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
  PTY APIs over `work.*`, `terminal_*`, and `terminal_history`. Live subscribe
  requests up to the same 2 MB used by `TerminalView` hydration. Recovery
  snapshots re-enter the renderer as `PtyDataEvent`: deltas append, while a
  full snapshot carries `replace: true` so xterm resets atomically. It also
  owns the session-lifecycle surface: a bounded `sessionMirror` keeps the last
  authoritative rows per `work.listSessions` argument shape (all sessions,
  per-lane, limited) - the only thing an optimistic patch can be painted onto
  without a full round-trip. The mirror is LRU-bounded so a long-lived tab
  cannot accumulate one entry per lane visited, and is cleared on project
  change because both the rows and any pending patches belong to the project
  being left. In-flight reads are coalesced per key. A `lifecycleCall` helper
  wraps every mutation - paint locally, send the non-idempotent sync command,
  reconcile - and **refuses honestly** instead of no-op'ing when the action is
  unadvertised or the socket is down, so the shared Work-tab helpers surface a
  real failure and the optimistic patch rolls back. Several lifecycle commands
  are legitimate no-ops for a row that is not in the expected state (waking a
  row that was never snoozed), and reporting a no-op as applied would strand a
  stale overlay, so the helper checks whether the host actually changed that
  row.
- `apps/desktop/src/renderer/webclient/adapter/sessionLifecycleOverlay.ts` -
  optimistic overlay for lifecycle writes. Desktop and iOS both own a local
  database, so a settle or snooze lands in local state instantly and the UI
  repaints from that row; ADE Web has no local database, so every lifecycle
  mutation is a sync round-trip and the row only changes when a later
  `work.listSessions` read returns. Each mutation therefore records a
  `SessionLifecyclePatch` carrying only the lifecycle columns (`settledAt`,
  `settleOverride`, `snoozedUntil`, `snoozedAt`, `wokeAt`, `wokeReason` - never
  a derived phase), the UI is nudged to re-read at once with the read decorated
  by the patch, and the entry retires in exactly one of three ways:
  **reconciled** (an authoritative row arrives that already satisfies the
  intent, so the overlay is redundant and is dropped), **rejected** (the host
  refused or the transport failed - dropped immediately, the row visibly snaps
  back, and the caller surfaces the failure), or **expired** (a hard TTL, so a
  lost acknowledgement can never wedge a row into a state the machine does not
  agree with). Because the instant columns are host-owned and the browser's
  clock will never equal the machine's, reconciliation compares **presence**
  (set vs cleared) rather than exact timestamps - presence is the only part of
  a timestamp the write actually intended.
- `apps/desktop/src/renderer/webclient/adapter/sessionLifecycleSupport.ts` -
  feature detection for that surface. ADE Web talks to whatever ADE version the
  user happens to run on their Mac, so support is detected exactly the way the
  phone does it: from the `hello_ok.features.commandRouting.actions` list the
  host advertises, surfaced through `AdeSyncClient.getCommandDescriptors()`. An
  older host simply never registers the `session.*` namespace, and a command
  sent to an unknown action resolves to the caller's fallback - a silent
  no-op - so gating on the advertised list is what turns that into an honest,
  explainable refusal. `SESSION_LIFECYCLE_ACTIONS` lists all ten commands; the
  required subset is `session.settleSession` / `session.snoozeSession` /
  `session.wakeSession`, because a host that can do those can drive every row
  affordance while the bulk and marker commands degrade individually. Two copy
  constants carry the refusals: `SESSION_LIFECYCLE_DISCONNECTED_MESSAGE`
  ("Can't reach this Mac right now, so nothing was changed.") and
  `SESSION_LIFECYCLE_UNSUPPORTED_MESSAGE` ("This Mac is running an older ADE
  that can't settle or snooze sessions.").
- `apps/desktop/src/renderer/webclient/adapter/agentChat.ts`,
  `personalChats.ts`, `lanes.ts`, `git.ts`, `prs.ts`, `project.ts`, `app.ts`, and `misc.ts` -
  web implementations of desktop renderer namespaces, mixing remote commands,
  sync sub-protocols, and local browser-only state. The chat adapter subscribes
  only the selected or explicitly requested chat and bounds initial transcript
  hydration to 128 KiB; older events page in on demand instead of every chat
  transcript competing with the active pane. It retains at most eight
  most-recently used chat streams and evicts the oldest before opening another,
  keeping aggregate snapshots below the Relay bridge budget. Host-side
  pagination ranks durable and legacy transcript candidates through one fixed
  identity window, so the initial tail and every older page keep addressing the
  same file even when their response byte budgets differ. It routes
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
  `lanes.ts` carries `getBranchDrift` / `resolveBranchDrift` passthroughs onto
  the matching `lanes.*` remote commands.

Browser shell and routes:

- `apps/desktop/src/renderer/webclient/main.tsx` - installs the pending
  `window.ade` placeholder before shared renderer modules import, then mounts
  `WebClientRoot`.
- `apps/desktop/src/renderer/webclient/shell/WebClientRoot.tsx` - boot
  sequence, retired-`/pair` scrubbing, account privacy pruning, account-first
  machine picker,
  30-second active-account lease monitor, project picker, adapter load, pending
  `/open` target stash, project binding, and projectless `/chats` routing before
  a project is selected. Ordinary visits paint the machine picker immediately;
  account bootstrap/directory work and IndexedDB loading proceed independently
  instead of blocking first paint. Saved environments stay hidden until the
  current account owner's atomic privacy prune completes, and stale async loads
  cannot publish another account's records. Storage failure leaves account
  sign-in and the directory usable with a separate saved-browser Retry path.
  Project binding passes the selected `project.id`
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
  independent directory/storage loading and retry states, project list, and the
  shared screen frame); `shellTokens.ts` holds the standalone-shell design
  tokens.
- `apps/desktop/src/renderer/webclient/shell/AccountIdentity.tsx` - shared
  signed-in identity label and trusted profile-image/initials fallback for the
  machine picker and connected shell; opaque account IDs are not shown.
- `apps/desktop/src/renderer/webclient/shell/sessionLifecycleChrome.ts` -
  web-only presentation for the session-lifecycle controls, installed from
  `WebClientRoot` through `installSessionLifecycleChrome(client)`. The Work list
  is the desktop component mounted verbatim, and it reveals a row's snooze
  control on pointer hover; a phone or tablet never produces hover, so on the
  web that control would be unreachable. Both that and the unsupported-host case
  are web-shell concerns rather than component concerns, so they are handled with
  one injected stylesheet keyed off a single attribute on `<html>`:
  `data-ade-session-lifecycle="ready" | "unsupported"`. Under
  `@media (pointer: coarse)` the snooze button becomes a 2rem touch target with
  `opacity: 1`, the row's `pointer-events-none` action wrapper is re-enabled, and
  the four snooze duration menu rows get a 44px minimum height.
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
  host owns the sync listener. The headless machine catalog marks the
  `ProjectScopeRegistry`'s actual current sync host as `isOpen` on every read,
  including after a host handoff, so reconnect restoration cannot guess from
  stale MRU order and bind streams to the wrong project.
- `apps/ade-cli/src/services/sync/deviceRegistryService.ts` - device records;
  `SyncPeerDeviceType` includes `browser`.

Account connection and entry points:

- `apps/account-directory/src/directory.ts` - Clerk-scoped machine
  register/list/delete routes. The list query reads the 500 most recently seen
  rows, computes online-first order, and exposes auth/D1 durations through the
  CORS-visible `Server-Timing` header. It accepts, reflects, and CORS-exposes
  `X-ADE-Correlation-ID`, then records it with route, method, status, and
  duration for credential-free connection tracing.
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
- `apps/desktop/src/renderer/webclient/sync/envStore.test.ts`.
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
  apply changesets, and does not advertise the `changesetAck` capability. It
  advertises `invalidationOnlyV1`: the host starts it at the current database
  watermark, the browser performs one full-domain refresh after hello, and
  later `invalidation_batch` envelopes identify only the domains that changed.
  The additive `compactInvalidationV1` capability distinguishes this format
  from older invalidation-only browsers that understood only changeset hints.
  The host never includes CRR row values in these hints and caps their serialized
  size at 16 KB, falling back to a full-domain refresh hint for invalid or
  oversized table sets.
  The host must confirm both contracts through
  `hello_ok.features.invalidationOnlyV1` and `compactInvalidationV1`; an older
  host is closed immediately with concrete desktop-update guidance instead of
  being allowed to replay its historical CRR backlog through Relay.
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
  backup or migration. A blocked upgrade or unavailable storage is recoverable:
  the machine directory continues loading, saved environments remain hidden,
  and Retry performs a fresh open attempt. Multi-store privacy cleanup must
  remain transactional so selection metadata cannot outlive a removed
  account-owned environment.
- **Connection liveness is application-observed.** An open browser WebSocket is
  not proof that the relay path is usable. The visible-page watchdog requires
  inbound ADE traffic within 75 seconds and reconnects stale tabs; do not remove
  it in favor of the browser's socket state alone. Transport-open and
  authenticated-hello deadlines are intentionally separate so slow token/DPoP
  preparation and a dead network route produce different failures.
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
- **Optimistic lifecycle state must always be able to expire.** A
  `SessionLifecyclePatch` is a temporary decoration over a host-owned row, not a
  local source of truth. It carries only lifecycle columns, never a derived
  phase, and it must retire through reconcile, reject, or TTL - an overlay with
  no expiry path would leave the browser showing a state the machine never
  agreed to. For the same reason, a lifecycle command that the host treats as a
  legitimate no-op (waking a row that was never snoozed) must not be reported as
  applied.
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
  - invalidation_batch -> bounded refresh hints
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

For Relay, the browser first dials the endpoint with `ready=2`. A current Worker
sends `accepted/v2` immediately and `ready/v2` only after the machine pipe and
validated local listener are both open; the browser sends no ADE hello before
that final readiness frame. If the Worker never advertises v2 during the short
negotiation window, the browser abandons the socket and retries the exact route
on a fresh legacy URL. It never reuses the ready-v2 socket for fallback, and it
does not downgrade after `accepted`.

The web client never talks to an ADE application server for project data. A
Cloudflare Pages request serves static assets; after that all application state
flows through the selected sync WebSocket transport to the machine runtime.

## Account machine directory

ADE account sign-in is the only way to create a new hosted-web connection. The
machine picker loads the user's machines from the Clerk-verified
account-directory Worker. The directory's `online` value is a 90-second
publisher-presence lease, not proof that a validated route disappeared. A row
with an allowlisted, directory-verified secure Relay endpoint remains
selectable after the presence lease expires; the ready-v2 bridge and
authenticated hello decide current reachability. A row with no dialable secure
endpoint remains listed with its last-seen state but cannot be selected. Saved
pre-release direct environments are shown separately as a local compatibility
path; they are not a pairing fallback.
The Worker reads at most the owner's 500 most recently seen rows from D1 before
computing online-first display order. Machine-list responses expose
`Server-Timing` entries for Clerk authentication and the D1 query; CORS exposes
that header to the hosted browser. These timings are diagnostics only and do
not change the directory response contract.

Machine-list requests retry exactly once after HTTP 401 by forcing an access
token refresh. Only a repeated 401/403 becomes `auth_expired` and asks the user
to sign in again; timeouts, server failures, and transient refresh/directory
outages remain retryable and do not prune saved trust.

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
`SyncConnection.sendHello` sends `dbVersion: 0` and advertises
`invalidationOnlyV1` and `compactInvalidationV1` (along with Relay
reauthorization support), so the host
does not replay historical CRR rows to a client that cannot apply them. The
host places the browser at its current watermark; the accepted hello triggers
a full-domain refresh, and subsequent compact invalidation batches remain live
refresh hints rather than replicated state.

Because there is no local replica, every read is a live relay round-trip to the
machine — where the desktop renderer would hit its in-process cr-sqlite. Two
adapter-side measures keep that from turning routine UI into a burst of
redundant relay traffic. First, read commands and file-list requests pass
through a short (3 s) **coalescing read cache**: concurrent identical reads join
one in-flight request and reuse its result for the TTL window, while any
mutation or sync-driven invalidation drops the affected entries.
Second, the PRs surface **batches** its reads: instead of separate `prs.list` /
`prs.getForLane` / `listWithConflicts` round-trips it hydrates a single
coalesced `prs.getMobileSnapshot` and derives the list views from it, and a
`prsInvalidated` event triggers exactly one aggregate refresh rather than an
empty-list marker. These caches are freshness hints over the authoritative
relay reads, not a persisted store.

The same absence shapes session lifecycle. Settle, unsettle, keep-active,
snooze, and wake are all available in ADE Web, but where desktop and iOS write
to a local database and repaint from the resulting row, the browser has nothing
to write to: every lifecycle mutation is a `session.*` round-trip and the row
only changes when a later `work.listSessions` read comes back. The adapter
closes that gap with an **optimistic overlay**. `sessionsPty.ts` keeps a
bounded, project-scoped mirror of the last authoritative rows per
`work.listSessions` argument shape; a mutation records a lifecycle-column-only
patch in `sessionLifecycleOverlay.ts`, nudges an immediate re-read decorated by
that patch, and retires the entry when an authoritative row already satisfies
the intent (reconciled), when the host refuses or the transport fails
(rejected - the row snaps back and the failure is surfaced), or when a hard TTL
elapses (expired). Reconciliation compares presence rather than exact instants,
because the host owns those timestamps and the browser's clock will never match
them. The overlay never records a derived phase: `canonicalSessionState()` still
computes the phase from the columns, and snooze remains a visibility overlay on
top of it rather than a phase of its own.

Because the browser cannot know which ADE version the paired Mac runs, the
lifecycle controls are feature-detected from
`hello_ok.features.commandRouting.actions` before they are offered, and a
mutation issued against an unadvertised action or a dead socket fails with
explicit copy instead of resolving silently. `sessionLifecycleChrome.ts`
reflects that decision onto `<html>` as
`data-ade-session-lifecycle="ready" | "unsupported"`, which also restores the
hover-only snooze affordance for coarse pointers.

A transport transition is not a blanket domain refresh. In particular, the
adapter emits sync status without directly calling `github.getStatus`, because
headless GitHub discovery can touch git, the GitHub CLI, credential files, and
macOS Keychain. On a GitHub-relevant route, the shell consumes each transition
to `connected` once and schedules a forced status read after 750 ms; later route
changes keep the normal 12/30-second policy. The headless implementation uses
asynchronous child processes and credential/file I/O with hard timeouts and
coalesces concurrent status reads, so even an explicit refresh cannot block the
brain's WebSocket event loop.

Chat opens hydrate a 128 KiB recent tail and keep a byte cursor for older
history. Older pages are capped to 256 KiB per request and read with
asynchronous filesystem/zlib APIs on the runtime. Large gzip archives stream
through one globally admitted inflater; during rapid chat switching, only the
active inflate and newest queued destination survive. Archives below 4 MiB may enter a
16 MiB memory cache; larger archives materialize at most once into an unlinked,
process-private temporary file with a 256 MiB logical-size ceiling and bounded
LRU plus a temporary-volume free-space guard, so every older page becomes a
random-access disk read instead of another full inflate. Disconnecting or
replacing a request aborts the queued/read/inflate work. Legacy
`chat.getTranscript` pagination now returns the same append-stable logical byte
cursor (`cursorKind: "byte"`) instead of deriving an index from a bounded tail.
The transcript viewport uses a top sentinel plus an underfill
check, so a short tail keeps loading until the viewport is scrollable (or the
transcript head is reached) without requiring a synthetic scroll event.
Failures preserve the cursor and expose a stable Retry control instead of
treating a missing descriptor or transient disconnect as the end of history.
The scrollbar stays visible, live appends follow only while the reader is
already at the bottom, and ADE's explicit prepend anchor disables native CSS
scroll anchoring to prevent double compensation.

The host also places a per-session hydration barrier before it captures a
`chat_subscribe` snapshot. The live broadcast and transcript pump remain behind
that barrier until the acknowledgement is sent, then resume from the byte
offset captured before the snapshot began. An event appended during a slow
snapshot is therefore delivered after the acknowledgement—never before it and
never lost; overlap is removed by the normal delivery-key dedupe.

Incoming `invalidation_batch` envelopes already contain only table names and
database-version bounds; `connection.ts` validates their table-count and name
limits before emitting them. `createInvalidationScheduler` maps those names to
domains such as lanes, sessions, chats, PRs, files, GitHub, and rebase. The
first pending hint starts the debounce window; later hints coalesce into that
same drain instead of extending it forever. A project switch is a stronger
boundary than an ordinary hint: it clears old terminal streams and read caches,
rebinds the adapter to the selected project id, then invalidates every domain
before shared surfaces rehydrate.

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

Terminal recovery is offset-based rather than best-effort append. The browser
tracks the UTF-8 end byte from snapshots and `terminal_data`, drops complete
replays, trims a partial overlap only at a code-point boundary, and withholds a
chunk that starts after the watermark while one recovery subscribe is in
flight. A delta snapshot fills the missing suffix; a full snapshot replaces
the xterm buffer and invalidates older preview/transcript hydration promises so
stale async work cannot repaint over recovery. Offsetless legacy/untracked
streams keep append-only behavior without inventing a watermark.

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
- Fingerprinted assets return immutable one-year caching while `/` and
  `/index.html` return `no-cache`.
- The build reports the raw first-load entry graph and fails if it exceeds
  1000 KB or eagerly references a guarded heavy feature chunk.

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
  sync-driven invalidation and are coarser than desktop chokidar events.
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
