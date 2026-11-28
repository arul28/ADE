# Web client

DAEX Web is DAEX in a browser: a static SPA on Cloudflare Pages at
`https://app.ade-app.dev` (`WEB_CLIENT_BASE_URL`; project `ade-web-client`,
deploy check `https://ade-web-client.pages.dev`). It reuses the desktop
renderer, and a `window.ade` adapter takes the place of the Electron bridge.
Build with `npm --prefix apps/desktop run build:webclient`.

Sign-in is required; there is no guest view. After sign-in the client shows:

- **Each connected computer of the account**, reached over DAEX Relay. The
  adapter sends remote commands, file requests and chat/terminal streams to
  that computer's brain.
- **DAEX Cloud**, always: one machine in every list. The account server
  (account-directory Worker) and GitHub answer every read; a read never wakes a
  cloud computer. An action (send, run a terminal, open a changed file, Git)
  wakes the lane's computer without the UI waiting.

A person with no computer of their own gets full DAEX on DAEX Cloud. An own
computer that is offline does not show in Work, Lanes or Home; an asleep cloud
computer is not offline, and its lanes and chats stay readable.

## Source file map

Under `apps/desktop/src/renderer/webclient/` unless noted.

**Boot and shell**

- `main.tsx`: installs a pending `window.ade` before shared modules import,
  then mounts `shell/WebClientRoot.tsx`.
- `shell/WebClientRoot.tsx`: boot (retired `/pair`, `/hub` routes go to
  `/work`), account bootstrap and privacy pruning before any saved environment
  shows, the lease monitor, the federated adapter, `/open` targets, owned links.
  Signed out it loads no workspace code (see Gotchas).
- `shell/webRoutes.ts`, `pendingTarget.ts`, `linkStash.ts`,
  `ownedLinkResolution.ts`, `WebOwnedLinkBanner.tsx`, `cloudPlanLink.ts`,
  `WebCloudPlanLink.tsx`: deeplinks.
- `shell/ScreenShell.tsx`, `sessionLifecycleChrome.ts`: the startup/error frame
  and touch styling.
- `webclient.html`, `gate.css`, `apps/desktop/tailwind.gate.config.cjs`: the
  entry and its stylesheet.

**Account**

- `account/client.ts`: Clerk OAuth (code + PKCE); the session record in
  IndexedDB (`account/sessionStore.ts`). Account requests go only to exact
  trusted origins, with no browser credentials or referrer.
- `account/clerkFrontendApi.ts`, `clerkCaptcha.ts`, `useClerkSignIn.ts`: DAEX's
  own Clerk Frontend API client (instead of the ~570 KB SDK), Turnstile, and
  the card's steps including `/sign-in/return`.
- `account/leaseMonitor.ts`: a 30 s check; confirmed expiry, sign-out or an owner
  change disconnects and prunes account-owned trust.
- `account/devTestSession.ts`: dev-only test sign-in.
- `linkStatus/main.ts`, `link-status.html`: the hidden `/link-status` page that
  `apps/web` frames.

**Sync client**

- `sync/client.ts`: the browser sync client (adoption, reconnect, commands,
  files, chat and terminal streams, project switch, invalidation). Terminal
  streams recover by byte offset; terminal input frames are acked and never
  change on retry. The project in front belongs to the browser
  (`ensureHostOnOwnProject`).
- `sync/connection.ts`: WebSocket lifecycle, DPoP, heartbeat, backoff. Transport
  open 8 s (3 s for a speculative direct route), authenticated hello 12 s, a
  75 s inbound watchdog. Relay negotiates ready-v2 (`sync/relayReady.ts`).
  `hello_error.code` decides auth failures
  ([code table](../sync-and-multi-device/README.md#hello_error-codes-are-the-contract-the-message-is-not)).
- `sync/relayPolicy.ts`, `endpoints.ts`, `envStore.ts` (IndexedDB: pairings,
  device secret, key pair, per-machine catalogs), `dpop.ts`,
  `wireProtocol.ts`, `projectHostRecoveryStore.ts` (project-host readiness and
  **Fix connection**).

**Adapter** (`adapter/`)

- `index.ts`: installs the sync-backed `window.ade`; a project rebind drops
  subscriptions, clears caches and invalidates every domain.
- `federated.ts`: the hosted router. Sends each project call to the adapter of
  its exact machine + project binding; account-answered bindings get the
  account adapter. Persists the open bindings and surface per account.
- `runtimePinGuard.ts`: `assertWebRuntimePinRoutable` at every pinned member.
- `infra/commandCaller.ts` (descriptor-based dispatch, coalesced reads,
  write-invalidation), `infra/coalescingReadCache.ts`, `infra/invalidation.ts`
  (`TABLE_DOMAINS`), `infra/projectState.ts`, `infra/bootPriority.ts`,
  `infra/proxy.ts` (stand-ins for missing members).
- Namespaces: `agentChat.ts`, `personalChats.ts`, `lanes.ts`, `git.ts`,
  `prs.ts`, `files.ts`, `sessionsPty.ts`, `project.ts`, `app.ts`, `misc.ts`,
  `account.ts`, `attention.ts`, `analytics.ts`, `providerAccounts.ts`,
  `macDesktop.ts`, `appControl.ts` (watch only), `githubStub.ts`, `search.ts`,
  `remoteRuntime.ts`, `reconnectHold.ts`, `sessionLifecycleOverlay.ts`,
  `sessionLifecycleSupport.ts`.
- DAEX Cloud: `adeCloudSyncClient.ts` (stand-in sync client answering through
  the account reader; never dials, polls or wakes), `cloud.ts`
  (`window.ade.cloud` from the account server), `cloudBilling.ts`.

**Workspace**

- `workspace/WebMachineSessionManager.ts`: machine sessions (Live,
  Reconnecting, Parked, Offline). At most `WEB_MACHINE_SESSION_LIMIT` (8) live
  clients; the next parks the least recently used.
- `workspace/webWorkspaceModel.ts` (`mergeWebMachines`, `webRecentProjects`),
  `machineIdentity.ts` (`machineCatalogKey`), `WebWorkspaceContext.tsx`
  (`useOptionalWebWorkspace`), `useWebChatsMachines.ts`.

**DAEX Cloud (shared with the desktop)**

- `apps/desktop/src/shared/adeCloud/binding.ts`: `adeCloudBinding(project)`
  (target `__ade_cloud__`, `ADE_CLOUD_MACHINE_ID`), `isAccountAnsweredPin`
  (true for it and for `cloud-saved:<machineKey>` pins).
- `apps/desktop/src/shared/adeCloud/accountReader.ts`
  (`createAdeCloudAccountReader`): the reads the account and GitHub answer.
- `renderer/state/adeCloudTabs.ts`, `cloudSavedChats.ts`,
  `cloudSavedChatsSync.ts`, `cloudSavedTerminals.ts`, `adeCloudChatQueue.ts`,
  `adeCloudLaneWake.ts`, `ownComputers.ts`, `renderer/lib/cloudMachineWake.ts`,
  `renderer/components/app/useWebTabsFollowComputers.ts`.

**Reused renderer**

- `renderer/lib/webClientMode.ts` (`isWebClientMode`, `WEB_CLIENT_TAB_PATHS`),
  `renderer/lib/webZoom.ts`, `renderer/lib/adeAvailability.ts`
  (`isAdeAvailable`), `renderer/lib/backoffPoller.ts`,
  `renderer/lib/pageVisibility.ts`.
- `renderer/components/onboarding/LaunchGate.tsx`, `WebSignInGate.tsx`,
  `ClerkSignInPanel.tsx`: the web gate and card.
- `renderer/components/app/ConnectionsPanel.tsx` (hosted mode),
  `ProjectHostRecoveryScreen.tsx`, `AppearanceRoot.tsx`.
- `renderer/components/settings/WebScopePill.tsx`: each Settings section's
  scope on the web.

**Build and host**

- `apps/desktop/vite.webclient.config.ts`: the build (writes
  `apps/desktop/dist/web-client`) and dev-server proxies.
- `apps/desktop/scripts/check-webclient-entry.mjs`: the first-load guard (no
  eager Monaco/graph/terminal/Markdown chunks; entry ≤ 1000 KB).
- `webclient/public/_headers` (CSP, caching), `_redirects` (SPA fallback),
  `_worker.js` + `_routes.json` (a removed chunk 404s with `no-store`, and
  `lib/staleChunkReload.ts` reloads once).
- `apps/desktop/src/renderer/public/scene-frame.html`: the page chat scenes load
  in.

**Machine side**

- `apps/ade-cli/src/services/sync/syncHostService.ts`,
  `syncRemoteCommandService.ts`, `syncPairingStore.ts`, `syncDpop.ts`,
  `syncCloudRelayStore.ts`, `syncTunnelClientService.ts`,
  `syncHostRecovery.ts`, `brainProjectActionsSyncHandler.ts`;
  `apps/tunnel-relay/` (the relay Worker).
- `apps/account-directory/src/directory.ts`: machine register, list, delete.

## Gotchas

- **Every project call goes to its exact binding.** A call that passes a pin
  keeps later callbacks on that project. A new web adapter method that acts on a
  chat, lane or terminal takes the pin, like the desktop preload.
- **A runtime pin the adapter cannot route must throw.** One adapter is one
  machine and one project. Only a pin for this adapter's machine *and* project
  runs unpinned; a `kind: "local"` pin throws. The machine match compares
  `pin.targetId` with `client.getStatus().selectedEnvId`, never a split binding
  key. DAEX Cloud and `cloud-saved:` pins never reach the guard.
- **A missing `window.ade` member is a stand-in, not `undefined`.**
  `withFallbackProxy` (`adapter/infra/proxy.ts`) returns a callable that
  rejects with `AdeUnavailableError` (an `on*` member returns a no-op). It is
  truthy, so feature checks use `isAdeAvailable(window.ade?.ns?.method)`.
- **Remote-command descriptors are the host's authority.** A method runs only
  when the host lists the action in `hello_ok.features.commandRouting.actions`;
  a write with no descriptor throws `UnsupportedRemoteCommandError`.
- **The browser has no DAEX database.** It sends `dbVersion: 0` with
  `invalidationOnlyV1` and `compactInvalidationV1`; the host replays no CRR rows
  and sends only table hints (capped at 16 KB). A host that does not confirm
  both is closed with update guidance.
- **The hosted page cannot dial `ws://`** (mixed content). New connections use
  Relay; a pre-account environment may keep a verified `wss://` route.
  `ws://127.0.0.1` is local development only.
- **Connection liveness is what the app sees.** Keep the 75 s inbound watchdog,
  and keep transport-open and hello deadlines apart.
- **Signed-out boot loads no workspace code**: only `window.ade.account` and
  the lazy `WebSignInScreen`. Gate code reads theme values through
  `state/appearanceStore.ts` until `appStore` loads. A component drawn before
  the workspace loads must be in `tailwind.gate.config.cjs`'s `content`, and its
  rules in a partial both stylesheets import. `loadAppStylesheet()` must come
  first. Numbers: `docs/perf/macos-baseline.md` (`npm run bench:webclient`).
- **Two Clerk facts.** The Clerk OAuth app's consent screen must stay off.
  `clerkFrontendApi.ts` reads Clerk's shapes defensively; after a Clerk API
  version change, sign in for real on the development instance
  (`+clerk_test@example.com`, code `424242`).
- **IndexedDB holds the refresh credential, pairings, DPoP keys and catalogs.**
  Cleared site data means a new sign-in and adoption. Keep multi-store privacy
  cleanup in one transaction.
- **Optimistic lifecycle state must expire.** A `SessionLifecyclePatch` retires
  by reconcile, reject or TTL; a host no-op must not show as applied.
- **Analytics is on by default and honours a browser opt-out.** The host's
  per-socket consent bit starts off, so each connection resends the preference;
  a failed opt-out ack closes the connection.
- **The phone pairing payload stays a URL fragment** (`shared/pairingQr.ts`,
  never the PIN).
- **The relay is transport, not cloud state**, and can read the frames it
  carries.
- **Build output shape**: `_headers`, `_redirects`, `_routes.json`, `_worker.js`
  and `index.html` sit directly in `apps/desktop/dist/web-client`.

## Account connection and auth

1. Boot shows only the sign-in card. The card signs the browser in to Clerk
   (email code, Google, GitHub or Apple), then DAEX Web's OAuth PKCE sign-in
   completes at once.
2. The browser loads the account directory and Home; a returning browser paints
   recents from saved catalogs and dials the last-active machine after first
   paint.
3. Selecting a computer captures the account-session generation, gets a fresh
   token and dials only the directory-verified `wss://<relay>/connect/<machineKey>`.
4. `client.ts` makes a non-extractable P-256 key pair and adopts the machine;
   the runtime returns a per-device secret. It is saved only if the session
   generation is unchanged, so a late reply after sign-out cannot recreate
   trust.
5. Reconnects send a paired `hello` with the secret and a DPoP proof (plus a
   fresh account proof on Relay). A direct route never carries the bearer.
6. Sign-out closes Relay sockets, removes account-owned environments and the
   other account's catalogs, and marks the next sign-in to ask for an account.

- **Where the bearer goes**: only to Clerk's token endpoint, the trusted
  directory origin and a directory-advertised `wss://` relay endpoint with the
  exact `/connect/<machineKey>` path. Never in a query, log or browser storage.
- **Directory rows**: `online` is a 90 s presence lease; a row with a verified
  Relay endpoint stays selectable after it lapses. A 401 forces one token
  refresh; only a second 401 or 403 is `auth_expired`.
- **`/sign-in` for a computer**: the desktop and `daex login` open
  `/sign-in?continue=<authorize URL>` (`buildWebClientSignInUrl`). It accepts
  only this client's issuer, client id and an `http://127.0.0.1` redirect.
  Deploy DAEX Web before a desktop build that opens it.
- **`ade_signed_in` cookie** on `.ade-app.dev` (no token, 30 days) tells
  `apps/web` to send a signed-in visitor to DAEX Web; a contract with
  `apps/web/index.html`.
- Self-hosted builds set `VITE_ADE_CLERK_ISSUER`,
  `VITE_ADE_CLERK_OAUTH_CLIENT_ID`, `VITE_ADE_ACCOUNT_DIRECTORY_URL` and
  optionally `VITE_ADE_ACCOUNT_RELAY_URLS`; the Worker's `WEB_CLIENT_ORIGIN`
  must be the exact origin.

## Transport

| Transport | Endpoint | Hosted page |
|---|---|---|
| Relay | `wss://<relay>/connect/<machineKey>` | yes (every new connection) |
| Saved direct | `wss://…` | yes (pre-account environments only) |
| Local dev | `ws://127.0.0.1:<port>` | no (`http:` pages only) |
| LAN / Tailscale | `ws://…` | no |

Relay uses `ready=2`: no hello before `accepted` then `ready`; a Worker that
does not answer v2 in time gets a fresh legacy socket.

## Data strategy: no local DB

Project reads are live round-trips to the binding's machine.

- **Caches are hints**: reads and file lists use a 3 s coalescing cache; PRs
  read one `prs.getMobileSnapshot`. A write clears its namespace.
- **Invalidation**: `infra/invalidation.ts` maps tables to domains; the debounce
  starts at the first hint, so steady activity cannot postpone a refresh.
- **Chats**: a chat opens on a 128 KiB tail; older pages load on demand. At most
  eight chat streams. The host holds live events while it captures a
  `chat_subscribe` snapshot, so none arrive early or get lost.
- **Terminals**: recovery by byte offset; a full snapshot replaces the buffer.
- **Activity** reads the push relay directly (`adapter/attention.ts`), fenced to
  the snapshot owner.
- **GitHub status** is not read on every connection change (headless discovery
  can touch git, `gh` and the Keychain).
- **Browser storage** holds only UI state, pairings and the catalog paint cache
  (8 machines, 24 projects each, pruned by owner at boot), plus browser-only
  preferences (`adapter/infra/localState.ts`).
- Sub-protocols: `command`, `file_request`, `chat_subscribe`,
  `terminal_subscribe`, `project_catalog` / `project_switch_request`, and
  personal chats with `chatScope: "personal"`.

<a id="ade-cloud-reads"></a>

## DAEX Cloud reads

A project tab binds to DAEX Cloud when no own computer with a copy is online
(`openAdeCloudProject`). Opening a tab whose copy is on a sleeping cloud
computer never wakes it: `openProject` asks the account server and binds to the
repository's DAEX Cloud tab, which moves to the copy when the computer is back
(`useAdeCloudTabFollowsCopy`). A sleeping cloud lane is read through a
`cloud-saved:<machineKey>` pin. Both are account-answered:

| Surface | Source while the computer sleeps |
|---|---|
| Work: chats, subagents | saved chats (`/cloud/chats`), nested by parent |
| Work: CLI sessions, shells | saved copies (`/cloud/sessions`) |
| Lanes | the project overview (`/cloud/projects/overview`) |
| Files | GitHub at the lane's branch, read-only ([files](../files-and-editor/README.md#with-no-computer-awake)) |
| PRs | GitHub with the account's sign-in ([PRs](../pull-requests/README.md#with-no-computer-awake)) |
| Git panel, History | the saved Git summary (`/cloud/git`) and GitHub commits |
| Linear, Jira | the account server |
| Search | online computers with `search.query`, plus Work rows already loaded |

- The account reader answers `lane.list` / `session.list` /
  `chat.listSessions` with `[]` (the saved slices supply them, so nothing shows
  twice). Any unsupported call refuses with `ADE_CLOUD_NEEDS_LANE_SENTENCE`,
  never empty. Reads are coalesced for 15 s; failures are not kept.
- **Sending to a sleeping or deleted cloud chat** goes to the account queue
  (`POST /cloud/chats/:machineKey/:chatId/messages`, with `clientSendId`). The
  server wakes the computer, which sends it once. The composer frees at once;
  failed messages stay with the server's sentence (`useAdeCloudChatQueue`).
- **History from the saved copy**: a cloud chat's older turns may exist only in
  its saved copy, so a history cursor can name that copy
  (`savedCopyHistoryCursor`) and keeps reading it after the computer wakes.
- Saved chats sync page by page (500 a page, at most 10). An older server
  answers new routes with 404 and the client falls back.
- `window.ade.cloud` (`adapter/cloud.ts`) reads plan, hours, disk and computers;
  a failed computer list sets `computersUnread`, so no computer counts as
  deleted. Lane delete, free and size stay desktop-only.

## Tabs and machines

- Checkouts of one repository share one tab; with copies on several machines
  the machine is a selector inside the tab.
- **A computer that leaves never closes a tab** (`useWebTabsFollowComputers.ts`):
  after the 30 s reconnect hold (`reconnectHold.ts`) plus 3 s, each tab moves to
  a copy on another connected computer, else to DAEX Cloud, and moves back when
  the computer returns.
- A `background` connect (a repository tab joining every computer with a copy)
  never parks another machine and skips one the person disconnected.
- Home lists the account's projects (`useHomeAccountProjects.ts`) plus the
  machines' catalogs. With no own computer, Home shows "Get started with DAEX"
  (`GetStartedCard.tsx`).
- Updating another machine works through `machine.updateAndRestart` /
  `machine.updateImpact`; an older brain reports
  `capabilities.remoteUpdate: false`.

## Deeplinks

- `buildWebClientUrl` (`shared/webClientUrl.ts`) builds on the shared grammar;
  `parseOpenTarget` (`shell/webRoutes.ts`) maps `/open?…` to app routes. A
  `lane-share` link maps to `/shared?grant=<id>`.
- The target waits 10 minutes in localStorage (`PENDING_TARGET_TTL_MS`), so it
  survives sign-in.
- **Owned links** (with `accountMachineKey` and `projectId`) resolve in
  `shell/ownedLinkResolution.ts`: find the machine, connect, match the project,
  open it, check the chat or lane exists (`OWNED_LINK_CHECK_MS`, 3 s; no answer
  opens anyway), navigate. Failures show one banner (`WebOwnedLinkBanner.tsx`).
- **DAEX Cloud plan links**: `/?cloudPlan=<free|plus|pro|max>` and Stripe's
  `/?cloudReturn=…` open Settings › DAEX Cloud at Plans. A paid plan starts
  checkout only when `GET /cloud/access` admits the account and it has no paid
  plan.
- Entry points: `daex link … --web`, "Open in web" in the lane and session
  context menus. The website's `/open` page forwards the query unchanged
  ([Deeplinks](../deeplinks/README.md)).

## Deploy and ops

```bash
npm --prefix apps/desktop run build:webclient
npx wrangler pages deploy apps/desktop/dist/web-client --project-name ade-web-client
npm --prefix apps/desktop run dev:webclient    # Vite on port 5174
```

- The dev server proxies account routes and the push relay
  (`VITE_ADE_ACCOUNT_DIRECTORY_URL=http://localhost:5174`,
  `VITE_ADE_PUSH_RELAY_URL`; `ADE_DEV_DIRECTORY_PROXY_TARGET` /
  `ADE_DEV_PUSH_RELAY_PROXY_TARGET` retarget them).
- **Dev test sign-in**: start the dev server with
  `ADE_DEV_TEST_SESSION_FILE=<path>` (a Clerk session for a **test** account,
  never the owner's); the page signs in through `GET /__ade_dev/session-token`
  (loopback only, `no-store`, absent from `vite build`).
- Run the Pages worker locally with `npx wrangler@4 pages dev
  apps/desktop/dist/web-client`.
- After deploy: the SPA serves with `_headers`' CSP, immutable `/assets/*` and
  `no-cache` on `/`; a signed-out visit shows only the sign-in card; sign-in
  returns to `/account/callback` and leaves no token in the address bar;
  `/open?type=lane&id=<uuid>` parses; `/pair` and `/hub` land on Home.

## Known limitations

- No OS notifications, web push, external editors, Finder reveal, native
  directory picker, local shell or file drop.
- No DAEX browser, computer use or iOS Simulator; App Control is watch-only.
- No file watcher; file changes come from invalidation.
- Passwords show only a notice; open DAEX desktop or the iPhone.
- Lane delete, size and freeing a cloud computer stay in the desktop app.
  Moving a lane or chat onto DAEX Cloud is not built; owner lane sharing is
  desktop-only (`laneShare.*` answers `lane_share_desktop_only`), the guest side
  works ([lane sharing](../lanes/lane-sharing.md)).
- Browser trust is per browser profile.

## Cross-links

- [Sync and multi-device](../sync-and-multi-device/README.md): protocol,
  pairing, DPoP, relay.
- [Remote runtime](../remote-runtime/README.md),
  [Personal chats](../personal-chats/README.md),
  [Tunnel relay](../../../apps/tunnel-relay/README.md).
