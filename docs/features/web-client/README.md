# Web Client

The web client is ADE in a browser. It is a static SPA on Cloudflare Pages at
`https://app.ade-app.dev`. It reuses the desktop renderer, and a `window.ade`
adapter takes the place of the Electron bridge.

The person must sign in. There is no skip and no guest view. After sign-in,
the client shows two kinds of machine:

- Each computer of the account that is connected. The browser reaches it over
  ADE Relay.
- ADE Cloud, always. ADE Cloud is one machine that every signed-in account
  has. The person never sees the separate cloud computers behind it (one for
  each cloud lane).

A person with no computer of their own gets the full ADE on ADE Cloud: every
tab, the normal composer, and the same flows as on the desktop. An own
computer that is offline does not show in Work, Lanes or the welcome page. An
asleep cloud computer is not offline: its lanes and chats stay listed and
readable.

Two paths answer the calls of a project tab:

- **A connected computer.** The adapter sends remote commands, file
  requests, and chat and terminal streams to that computer's brain, normally
  over Relay (see *Transport matrix*).
- **ADE Cloud.** The account server (the account-directory Worker) and GitHub
  answer every read. A read never wakes a cloud computer. An action (send a
  message, run a terminal, open a changed file, a Git action) wakes the
  lane's computer, and the UI does not wait for it.

Relay connections need the browser and the machine on the same ADE account
(see *Account connection and auth flow*). The web uses browser-safe
shortcuts: `Mod+J` toggles tools, `Mod+Shift+O` opens a new chat, ``Ctrl+` ``
and `Ctrl+Shift+~` move between project tabs. User overrides win. What the
web cannot do is in *Known limitations*.

Production hosting is the `ade-web-client` Cloudflare Pages project.
`https://app.ade-app.dev` (`WEB_CLIENT_BASE_URL`) is the product URL, and
`https://ade-web-client.pages.dev` is the direct deploy-check URL. Build it
from `apps/desktop` with `npm run build:webclient`.

## Source file map

- `apps/desktop/src/renderer/components/app/AppearanceRoot.tsx` — shared appearance lifetime for workspace and sign-in.
- `apps/desktop/src/renderer/lib/backoffPoller.ts` — visibility-aware unchanged-read cadence and teardown, shared by the adapter and renderer pollers (Linear, cloud agents, Activity, Work tools pane).
- `apps/desktop/src/renderer/lib/pageVisibility.ts` — shared tab visibility observer.
- `apps/desktop/src/renderer/webclient/adapter/infra/proxy.ts` and `apps/desktop/src/renderer/lib/adeAvailability.ts` — the stand-in for every `window.ade` member the adapter lacks (see Gotchas) and the `isAdeAvailable` check renderer code uses instead of a truthiness or `typeof` test.
- `apps/desktop/src/renderer/scene/scenePreferences.ts` — platform defaults and explicit scene choices.

ADE Cloud, and ADE with no computer of your own:

- `apps/desktop/src/shared/adeCloud/binding.ts` - the ADE Cloud binding.
  `adeCloudBinding(project)` builds a remote binding with the target id
  `__ade_cloud__` (`ADE_CLOUD_MACHINE_ID`) and the key
  `remote:__ade_cloud__:<accountProjectId>`. `isAccountAnsweredPin` is true for
  this binding and for a `cloud-saved:<machineKey>` target (a saved copy of an
  asleep or deleted cloud computer). The account answers the reads of such a
  pin; nothing dials a computer for them.
- `apps/desktop/src/shared/adeCloud/accountReader.ts` -
  `createAdeCloudAccountReader`, the reads that the account and GitHub answer:
  - `lane.list`, `session.list` and `chat.listSessions` give `[]`. Cloud lanes
    and chats come from the saved slices (below), so nothing shows twice.
  - `file.listWorkspaces` gives one read-only workspace for each lane with a
    branch (`ade-cloud-lane:<laneId>`).
  - `file.listTree`, `file.listTreeChildren` and `file.readFile` read GitHub at
    the lane's branch. The changed files come from the Git summary that the
    computer saved at rest.
  - `git.listRecentCommits` reads GitHub. `git.getSyncStatus` and
    `diff.getChanges` read the saved Git summary.
  - Linear and Jira reads go to the account server through
    `integrationReads.ts` and `accountCalls.ts`.
  - Any other call refuses with `ADE_CLOUD_NEEDS_LANE_SENTENCE`. It never
    answers empty.
  - Reads are coalesced and kept for 15 s. A failed read is not kept.
- `apps/desktop/src/shared/adeCloud/chatQueue.ts` - the queue types and
  `queuedMessageOpen`.
- `apps/desktop/src/renderer/webclient/adapter/adeCloudSyncClient.ts` - a
  stand-in sync client for the ADE Cloud binding. It answers through the
  account reader. It never dials, polls or wakes.
- `apps/desktop/src/renderer/webclient/adapter/federated.ts` - the hosted
  router for `window.ade`.
  - It stores the welcome, Chats or project surface (`activeSurface: "hub"`
    means the welcome page), the open bindings and the selected machine per
    account, and restores them at boot.
  - It sends each project call to the adapter of its exact machine + project
    binding. An account-answered binding (ADE Cloud, `cloud-saved:`) gets the
    account adapter and never connects to a computer.
  - A binding passed as an argument pins later callbacks and subscriptions to
    its project. A change of active adapter remounts the renderer.
  - Account-wide members (`usage.getAdeStats`, `usage.getGithubContributions`,
    `usage.onUpdate`, `cloud`, `cloudAccess`) go to a connected computer when
    the shown adapter is disconnected. With no computer connected, the
    account server answers `cloud` and `cloudAccess`, and the top bar's
    Settings opens on its own.
- `apps/desktop/src/renderer/webclient/adapter/cloud.ts` - `window.ade.cloud`
  on the web. It reads the plan, hours, disk and the cloud computers from the
  account server (`GET /cloud/access`, `GET /cloud/account`,
  `GET /cloud/instances`). A failed computer list sets `computersUnread`, and
  then no computer counts as deleted. It also has:
  - sleep, wake, resize, backup and update through `/cloud/instances/:id/...`;
  - new chats on ADE Cloud (`POST /cloud/launches`, `accountCloudLaunches.ts`);
  - `sendChatMessage`, `serverLaunchStatus` and `carriedSignIns`;
  - `laneLife`, which only reads: `lanesWithoutComputer` and
    `forgetLaneWithoutComputer`. Delete, free and size stay in the desktop app,
    with a sentence that says so.
- `apps/desktop/src/renderer/state/appStore.ts` - `openAdeCloudProject` opens
  a project tab on ADE Cloud. `takeLegacyNoMachineTabs` moves the tabs that an
  older build saved for its no-computer page to ADE Cloud tabs, once.
- `apps/desktop/src/renderer/state/adeCloudTabs.ts` - `adeCloudProjectOf`,
  `adeCloudProjectForTabId` and `useAdeCloudTabFollowsCopy`.
- `apps/desktop/src/renderer/components/app/useWebTabsFollowComputers.ts` - the
  tab of a computer that stops moves to a copy on another connected computer,
  or else to ADE Cloud. When the computer comes back, the tab moves back
  (`webResumeOwnedTabs.ts`).
- `apps/desktop/src/renderer/state/ownComputers.ts` - `useOwnWebComputers` and
  `useHasOwnComputer`: the machines of the account that are not ADE Cloud
  computers. Always true on the desktop.
- `apps/desktop/src/renderer/state/cloudSavedChats.ts` and
  `cloudSavedChatsSync.ts` - the saved copies of cloud chats in Work. The sync
  reads the saved chats page by page (500 a page, at most 10 pages) and the
  project overview (`/cloud/projects/overview`). It adds:
  - a slice for each cloud computer that is not live here and not gone;
  - child chats under their parent chat (`parentChatId`);
  - lane computers with no chat yet, once;
  - saved CLI and shell copies as read-only rows
    (`cloudSavedTerminals.ts`, prefix `cloud-saved-terminal:`).
  Each slice binding carries the project's repository as `gitOriginUrl`, so an
  account read of a saved lane finds its repository.
- `apps/desktop/src/renderer/state/adeCloudChatQueue.ts` - the account's
  message queue for a cloud chat whose computer is asleep or deleted.
  `useAdeCloudChatQueue({pin, sessionId})` gives the open messages
  (queued, sending, waiting for a sign-in), the failed messages with the
  server's sentence, `cancel` and `dismiss`. A failed message stays until the
  person puts its text back or dismisses it; this browser keeps that choice
  in `localStorage`. Reads run when the chat opens, on window focus and after a
  send. Nothing polls.
- `apps/desktop/src/renderer/state/adeCloudLaneWake.ts` -
  `useAdeCloudLaneWake(pin)` wakes a lane's computer and returns at once.
  `adeCloudMoveSource` tells the move menu that a source computer is resting
  ("Wake and move") or gone.
- `apps/desktop/src/renderer/lib/cloudMachineWake.ts` -
  `wakeRestingCloudMachine` runs an `onConnected` action after the wake. A
  failed wake shows the server's sentence.
- `apps/desktop/src/renderer/components/projects/GetStartedCard.tsx` - the
  "Get started with ADE" steps on Home (Connect GitHub, Add a project, Send
  your first chat) and the install chip.
- `apps/desktop/src/renderer/state/cloudModelCatalog.ts` - `GET /cloud/models`
  once for each page, and the last model used.
- `apps/desktop/src/renderer/components/settings/providers/cloud/AccountCloudProvidersPanel.tsx` -
  Settings › Providers for ADE Cloud: each provider's sign-in and the
  account's saved keys (`/cloud/sign-ins`).
- `apps/desktop/src/renderer/webclient/adapter/search.ts` - web search asks
  each online copy of the repository. It asks a computer only when that
  computer has `search.query` or `search.indexStatus`; else it answers null,
  and the palette skips it. `rebuildIndex` answers `{ started: false }`.
  - With no online copy, the palette makes no search call. It matches only
    the Work rows that the page already loaded (saved chats, saved terminals,
    cloud lanes).
  - A result with no lane name gets one from the account lane index
    (`withIndexedLaneName` in `commandPaletteSearch.tsx`, one index read each
    time the palette opens).
  - Nothing extra is saved for search.

Build and static host:

- `apps/desktop/package.json` - `dev:webclient` and `build:webclient`. The
  build runs `check-webclient-entry.mjs` after Vite.
- `apps/desktop/vite.webclient.config.ts` - the Vite build. It renames
  `webclient.html` to `index.html`, writes `apps/desktop/dist/web-client`, and
  copies the Pages files to the output root. Rollup's normal graph splitting
  decides the chunks; the renderer's dynamic imports are the feature
  boundaries. The dev server's proxies and test sign-in are in *Deploy and ops*.
- `apps/desktop/src/renderer/public/scene-frame.html` - the page a chat scene
  loads in. `_headers` gives it the scene policy (and no `X-Frame-Options`),
  because a `blob:` scene document inherits the app's policy and its scripts
  would not run. `SceneFrame` posts the scene document to it.
- `apps/desktop/scripts/check-webclient-entry.mjs` - the first-load guard. It
  rejects eagerly linked Monaco, graph, terminal and Markdown-style chunks and
  external entry scripts, and caps the entry HTML plus its JavaScript at
  1000 KB.
- `apps/desktop/src/renderer/webclient.html` - the entry HTML. It paints a
  loading shell before React runs and preconnects to the production Clerk and
  account-directory origins.
- `apps/desktop/src/renderer/webclient/public/_headers` - Pages headers and
  CSP. `connect-src` allows `wss:` and `https:`, not hosted-page `ws:`.
  `/assets/*` is cached for one year as immutable; `/` and `/index.html` are
  `no-cache`. `img-src` allows the Clerk image CDNs and Clerk's Google Storage
  profile path. `script-src` and `frame-src` allow
  `https://challenges.cloudflare.com` (Turnstile in the sign-in card).
- `apps/desktop/src/renderer/webclient/public/_redirects` - SPA fallback
  `/* /index.html 200`. A static file wins.
- `apps/desktop/src/renderer/webclient/public/_worker.js` and `_routes.json` -
  a Pages worker for `/assets/*` only. A chunk that a deploy removed gets a
  404 with `no-store`, not `index.html` with the immutable cache. An old tab
  then gets a load failure, and `lib/staleChunkReload.ts` reloads it once. If
  the worker throws, it returns the static answer. Run it locally with
  `npx wrangler@4 pages dev apps/desktop/dist/web-client`.

Browser sync client:

- `apps/desktop/src/renderer/webclient/account/client.ts` - Clerk OAuth
  (authorization code + PKCE). IndexedDB keeps the refresh credential, the
  last access token with its expiry, and the issuer/client identity. A reload
  inside the token's life reads the directory with it and skips the refresh;
  if the directory refuses it, boot refreshes once. The profile comes from a
  bounded, best-effort userinfo read. The callback leaves the address bar
  before the directory loads. Account requests go only to exact trusted
  origins, with no browser credentials and no referrer. In a dev build only,
  it can sign in with the dev test session (*Deploy and ops*).
- `apps/desktop/src/renderer/webclient/account/clerkFrontendApi.ts` - a small
  Clerk Frontend API client (environment, client, email-code sign-in and
  sign-up, OAuth start, sessions) that follows clerk-js's wire rules (form
  bodies, `credentials: "include"`, GET/POST with `_method`, a pinned
  `__clerk_api_version`) instead of the ~570 KB SDK. A development instance
  carries a dev-browser id in `__clerk_db_jwt`, also on the authorize
  navigation (`decorateNavigationUrl`).
- `apps/desktop/src/renderer/webclient/account/clerkCaptcha.ts` - Clerk's
  sign-up bot check (Cloudflare Turnstile), shown only when Cloudflare wants a
  click.
- `apps/desktop/src/renderer/webclient/account/useClerkSignIn.ts` - the card's
  steps (loading, "Continue as", form, code, finishing) and the OAuth return
  `/sign-in/return`, as clerk-js `_handleRedirectCallback` handles it. `fresh`
  (after a sign-out) ends the browser's Clerk session first and asks Google
  and GitHub for their account picker.
- `apps/desktop/src/renderer/webclient/account/sessionStore.ts` - the
  versioned IndexedDB session record (refresh token, last access token and
  expiry). `usablePersistedAccessToken` returns the token only while it has
  more than the skew to live. Sign-out and confirmed expiry clear it.
- `apps/desktop/src/renderer/webclient/account/devTestSession.ts` - dev only:
  reads `/__ade_dev/session-token`. A production build has none of it.
- `apps/desktop/src/renderer/webclient/linkStatus/main.ts` and
  `link-status.html` - the hidden `/link-status` page that `apps/web`
  `OpenPage.tsx` frames. It reads the online computers with the stored access
  token only (it never refreshes, because the refresh token rotates) and posts
  one `ade-link-status` message to the ade-app.dev origins only. `_headers`
  lets only those origins frame it.
- `apps/desktop/src/renderer/webclient/account/leaseMonitor.ts` - a 30 s check
  for account-owned environments and Relay sockets. Confirmed expiry,
  sign-out or an owner change disconnects and prunes account-owned trust; a
  transient failure keeps it. A direct-owned environment on Relay is
  disconnected, not deleted.
- `apps/desktop/src/renderer/webclient/sync/client.ts` - the browser sync
  client: account adoption over Relay, saved-environment reconnect, remote
  commands, files, chat and terminal streams, project switch, and
  `invalidation_batch` as refresh input.
  - Terminal streams keep UTF-8 byte watermarks, drop duplicates, trim
    overlaps, and resubscribe once with `sinceOffset` on a gap. A delta
    snapshot appends the missing suffix; a full snapshot replaces.
  - Terminal input waits for each frame's ack. Keys typed meanwhile join the
    next unsent frame (at most 16 KB). A sent frame never changes, so a retry
    resends the same id and bytes.
  - `isRetryingDial` tells a failed dial round apart from a refusal.
  - The project in front belongs to the browser. If the brain restarts on
    another project or another client moves it, the client keeps its project
    and streams and asks for its project again (`ensureHostOnOwnProject`), at
    most once per 15 s.
- `apps/desktop/src/renderer/webclient/sync/connection.ts` - the WebSocket
  lifecycle: account adoption, paired hello, DPoP, heartbeat, backoff,
  project catalog chunks, and one correlation id from the directory read to
  the last route.
  - Token and DPoP preparation runs with the dial. Transport open has 8 s and
    the authenticated hello 12 s. A direct route ahead of the last good route
    gets 3 s (Relay always gets 8). A project switch dials the route that was
    live first (`firstEndpoint`).
  - Relay authorization renews in place before expiry, also in a hidden tab.
  - Relay negotiates ready-v2 first: no hello before `accepted` then `ready`.
    A Worker that does not send `accepted` in time is retried on a fresh
    legacy socket, never downgraded in place.
  - While visible, a 15 s watchdog closes a socket after 75 s with no inbound
    traffic. A tab that becomes visible skips the backoff.
  - Relay close codes map to stable offline, capacity and retry messages.
  - A rejected hello is read from `hello_error.code`. Only a real pairing
    rejection becomes `auth_failed` (which invalidates the environment).
    `account_session_changed` is transient. `host_update_required` stops the
    dial but keeps the pairing and shows the host's message. See
    [the `hello_error` code table](../sync-and-multi-device/README.md#hello_error-codes-are-the-contract-the-message-is-not).
- `apps/desktop/src/renderer/webclient/sync/relayPolicy.ts` - the Relay
  authorization policy: local pairing provenance stays apart from account
  ownership, Relay routes are filtered while signed out, and sign-in-required
  shows before a socket opens.
- `apps/desktop/src/renderer/webclient/sync/endpoints.ts` - the ordered
  browser-safe endpoints (LAN, Tailscale, Relay). The hosted page dials only
  Relay and `wss://`; `ws://` only from local `http:` pages.
- `apps/desktop/src/renderer/webclient/sync/envStore.ts` - IndexedDB for paired
  environments, the per-device secret, host metadata, the WebCrypto key pair,
  the account-session store and the version-3 `catalogs` store.
  - `catalogs` keeps each machine's last project catalog by
    `machineCatalogKey` and the last-active machine key, so recents paint
    before a connection. Limits: 8 machines, 24 projects each, oldest machine
    evicted in the same transaction, icons over 24,000 characters dropped.
    Records carry `ownerUserId`; `pruneMachineCatalogs` deletes another
    account's records at boot.
  - A versioned one-time trust migration clears legacy environments and the
    selection, and keeps other state.
  - Every operation is one explicit transaction. Opens fail after 4 s; a
    blocked upgrade waits 5 s and reports its own typed failure. A rejected
    open is not cached, so Retry reopens. `versionchange` closes and resets.
- `apps/desktop/src/renderer/webclient/sync/dpop.ts` - P-256 ECDSA DPoP keys
  (non-extractable) and proofs.
- `apps/desktop/src/renderer/webclient/sync/wireProtocol.ts` - the envelope
  codec, gzip, and catalog chunk assembly.
- `apps/desktop/src/renderer/webclient/sync/projectHostRecoveryStore.ts` - the
  project-host readiness state, fed by `hello_ok.projectHost` and every
  `host_unavailable` failure from `CommandCaller`. Phases: `ready`,
  `retrying`, `takeover`, `recovering`. It retries silently (2 s, 4 s, 8 s over
  `sync.diagnoseHost`) before it takes the screen, and calls
  `sync.recoverHost` for **Fix connection**. It binds to the active machine's
  client only (`bindProjectHostRecoveryClient`), because the repair stops a
  process on that host. A socket drop keeps the binding, so `recovering`
  survives the restart it causes.
- `apps/desktop/src/renderer/components/app/ProjectHostRecoveryScreen.tsx` -
  the recovery card and the `ProjectHostStartingBanner` before it (web mode
  only). The card names the owner, the project and what a stop interrupts,
  keeps PIDs and socket paths in the technical fold, and lists the repair
  steps as they finish. **Retry stays enabled during a repair**, so a restart
  that never reports back does not leave a dead spinner. Switch Mac works at
  any time. The banner keeps the cached lists and marks them as possibly out
  of date.

Browser `window.ade` adapter:

- `apps/desktop/src/renderer/webclient/adapter/index.ts` - installs the
  sync-backed `window.ade` with the browser account client, and hides
  native-only members. A project rebind drops old terminal subscriptions,
  clears read caches, binds the new id, and invalidates every domain before
  the renderer can show stale data.
- `apps/desktop/src/renderer/webclient/adapter/misc.ts` - the small
  namespaces. `workTools` is read-only: `getLaneState` and
  `readObservationPreview` are remote commands, and `setActiveTool` does
  nothing (only a surface with a tool open may publish it). `builtInBrowser`
  is unavailable except `getStatus` (an empty `BuiltInBrowserStatus`, because
  callers read `status.tabs`) and `getDevServers` (an empty list). Other
  members are absent, so callers feature-detect.
- `apps/desktop/src/renderer/webclient/adapter/providerAccounts.ts` - the
  host's Claude and Codex logins for the web **AI accounts** card. Each member
  calls the host's `providerAccounts.*` command and unwraps `{ instance }` or
  `{ login }`. Reads may use the last good reply while the host is away;
  changes and sign-in status always go to the host. `loginCommand` and
  `setAccent` are absent. An older host rejects, and the panel shows the
  error, not an empty list.
- `apps/desktop/src/renderer/webclient/adapter/macDesktop.ts` - the lane's
  macOS screen on the web. `getStatus`, `start` and `stop` are the desktop's
  `macDesktop.*` commands. `streamSubscribe` and `streamUnsubscribe` keep at
  most one live subscription for each view (`subscriptionId`). Pushed
  `macDesktop.streamRecord` and `macDesktop.streamEnded` envelopes come out
  through `onStreamRecord` and `onStreamEnded`; the view subscribes again after
  a reconnect.
  - `supportsLiveStream()` needs the `hello.features.macDesktopStream` bit and
    the advertised subscribe command.
  - `supportsMacDesktopControl()` needs `hello.features.macDesktopControl` and
    `macDesktop.takeControl`. Only then do `takeControl`, `returnControl`,
    `renewLease` and `input` exist. The web sends a per-tab token; the host
    makes the lease id `web:<connectionId>:<token>`.
  - `WorkToolReadOnlyView` feeds `H264StreamView` from the pushed records. It
    shows the last still frame until the first keyframe, and only the still
    with a notice on a browser without WebCodecs. With control, it forwards
    input through `useMacDesktopRealInput` and renews the lease until it
    returns control.
- `apps/desktop/src/renderer/webclient/adapter/account.ts` - `window.ade.account`
  on the browser session and the account directory (status, sign-in/out,
  machines, removal), and `accountSettings` through the push relay.
- `apps/desktop/src/renderer/webclient/adapter/attention.ts` - Activity from
  the account. Signed in, reads, acks, presence and preferences go to the push
  relay, fenced to the owner that loaded the snapshot. A signed-out legacy
  environment reads and acks only its paired host
  (`attention.getMachineSnapshot`, `attention.acknowledgeMachine`); an older
  host shows update guidance. Relay polls back off with jitter on failure,
  network errors included (5xx and 429 as transient, other 4xx faster). The
  backoff stops only the timed polls; a click always tries, and a success
  resumes polling.
  - An item with a lane id and no lane name gets the name from the account
    lane index (`accountLanes()`, `GET /account/lanes`). One index read is
    used again for 60 s (`LANE_INDEX_REUSE_MS`). The index is for lane names
    and mentions only.
- `apps/desktop/src/renderer/webclient/adapter/analytics.ts` - the browser's
  analytics preference (on unless opted out), runtime-scoped capture, and the
  preference sent again on each connection. A failed opt-out ack closes the
  connection.
- `apps/desktop/src/renderer/webclient/adapter/infra/commandCaller.ts` -
  remote-command dispatch by `SyncRemoteCommandDescriptor` scope and policy.
  - Identical idempotent reads join one in-flight request; a failure reaches
    every caller, and each applies its own fallback. `cacheTtlMs` keeps a
    value for that window.
  - A write (`idempotent: false`) clears its namespace's reads and last-good
    fallbacks when it settles; a read in flight across a write stores no
    fallback. A write with no descriptor throws
    `UnsupportedRemoteCommandError`.
  - `invalidateCache` clears all or some action prefixes.
- `apps/desktop/src/renderer/webclient/adapter/infra/bootPriority.ts` - on a
  page that opens on a chat, heavy startup reads (usage, model catalog,
  provider status and similar) wait until the chat history paints, until the
  session list shows no chat, or for at most 12 s. Writes never wait.
- `apps/desktop/src/renderer/webclient/adapter/infra/coalescingReadCache.ts`
  and `infra/cacheKey.ts` - the coalescing TTL cache and its key builder. The
  TTL starts when a read resolves, so slow reads still join; rejections are
  never kept.
- `apps/desktop/src/renderer/webclient/adapter/infra/projectState.ts` - the
  bound project. `getProjectId()` prefers the id bound by the shell (then a
  catalog match by root path) over the client's `activeProjectId`, which can
  name the prior project during a reconnect.
- `apps/desktop/src/renderer/webclient/adapter/infra/invalidation.ts` - maps
  `invalidation_batch` table names to renderer domains with an exhaustive
  `TABLE_DOMAINS` map, `SILENT_TABLES` and a few prefix rules (no substring
  rules). An unknown table falls back to `UNCLASSIFIED_TABLE_DOMAINS`. The
  debounce starts at the first pending change, so steady activity cannot
  postpone a refresh. `runtime_processes` is local-only
  (`LOCAL_ONLY_CRR_EXCLUDED_TABLES`), so the process heartbeat never makes a
  batch.
- `apps/desktop/src/renderer/webclient/adapter/appControl.ts` - App Control,
  watch only. `getStatus`, `onEvent`, `holdFrames` and `streamSubscribe` work;
  every driving call rejects with "App Control runs on the desktop. From here
  you can only watch it." Status polls while a listener exists: 3 s, backing
  off to 15 s while unchanged, paused while hidden.
- `apps/desktop/src/renderer/lib/pageVisibility.ts` - the visibility helper
  for the relay pollers (visible when there is no `document`).
- `apps/desktop/src/renderer/webclient/adapter/runtimePinGuard.ts` -
  `assertWebRuntimePinRoutable(operation, pin, scope)` runs at every pinned
  member (`agentChat.ts`, `files.ts`, `git.ts`, `lanes.ts`, `prs.ts`,
  `sessionsPty.ts`; each takes `RuntimePinArg`).
  - A pin for this adapter's machine and project runs unpinned (the Chats
    page's pinned `pty.create`).
  - A pin for the same machine but another project throws.
  - A `kind: "local"` pin throws "This chat runs on a machine ADE Web can't
    reach directly."
  - The machine match compares `pin.targetId` with
    `client.getStatus().selectedEnvId` (a web target id is an environment
    id), never a split of the binding key.
  - ADE Cloud and `cloud-saved:` pins never reach the guard.
- `apps/desktop/src/renderer/webclient/adapter/files.ts` - files over
  `file_request`; no file watcher.
  - `listWorkspaces`, `listTree` and `listTreeChildren` share a 3 s read cache
    and show transport errors (an empty answer would read as an empty tree).
  - `readFile` and the writes reject like the desktop host, so a failed read
    never looks like an empty file and a failed write never marks a tab saved.
  - Cache keys are structured. A write evicts by scope: other workspaces and
    `listWorkspaces` stay; `listTreeChildren` loses the changed path's
    ancestors and descendants.
  - `filesInvalidated` clears the cache and sends a path-less change for each
    workspace seen, with `origin: "self"` so the workbench does not re-read
    its own write.
- `apps/desktop/src/renderer/webclient/adapter/remoteRuntime.ts` - a fallback
  for native remote-runtime calls. The federated adapter overrides target,
  connection, project, connect, park and forget. SSH discovery, local pairing
  hosts and target editing are unavailable.
- `apps/desktop/src/renderer/webclient/adapter/prs.ts` - PRs over remote
  commands with the 3 s read cache. `prsInvalidated` clears `prs.` and reads
  one aggregate `prs.getMobileSnapshot` (else `prs.list`); `listAll`,
  `getForLane` and `listWithConflicts` come from it. `updateDescription`
  (`prs.updateBody` on an older machine), `searchMentionables` and
  `getRepoReferences` go to the machine; an older machine says "Update ADE on
  that computer…".
- `apps/desktop/src/renderer/webclient/adapter/sessionsPty.ts` - terminal and
  PTY APIs over `work.*`, `terminal_*` and `terminal_history`. A live subscribe
  asks for up to 2 MB, as `TerminalView` hydration does. A delta snapshot
  appends; a full snapshot carries `replace: true`, so xterm resets at once.
  - A bounded `sessionMirror` keeps the last host rows for each
    `work.listSessions` argument shape (LRU, cleared on a project change). The
    optimistic lifecycle patches paint on it.
  - `lifecycleCall` paints, sends the command, and reconciles. It refuses when
    the action is not advertised or the socket is down, so the patch rolls
    back. A host no-op (wake a row that was never snoozed) is not reported as
    applied.
  - Every PTY and terminal shim, and `sessions.list`, `get` and
    `readTranscriptTail`, passes its pin through `assertWebRuntimePinRoutable`.
    `project.ts` leaves `gitOriginUrl` out of `listRecent`, so it starts no
    pinned reads that this adapter cannot serve.
- `apps/desktop/src/renderer/webclient/adapter/sessionLifecycleOverlay.ts` -
  the optimistic overlay for settle, snooze and wake. A
  `SessionLifecyclePatch` holds only `settledAt`, `settleOverride`,
  `snoozedUntil`, `snoozedAt`, `wokeAt` and `wokeReason`. It retires when
  **reconciled** (a host row shows the intent; the match compares set or
  cleared, because the host owns timestamps), **rejected** (the row snaps
  back with the error) or **expired** (a hard TTL).
- `apps/desktop/src/renderer/webclient/adapter/sessionLifecycleSupport.ts` -
  feature detection from the host's advertised actions
  (`hello_ok.features.commandRouting.actions`).
  `SESSION_LIFECYCLE_ACTIONS` lists the ten commands; `session.settleSession`,
  `session.snoozeSession` and `session.wakeSession` are required. The refusals
  are `SESSION_LIFECYCLE_DISCONNECTED_MESSAGE` and
  `SESSION_LIFECYCLE_UNSUPPORTED_MESSAGE`.
- `apps/desktop/src/renderer/webclient/adapter/agentChat.ts`,
  `personalChats.ts`, `lanes.ts`, `git.ts`, `prs.ts`, `project.ts`, `app.ts`,
  and `misc.ts` - web versions of the desktop renderer namespaces. They use
  remote commands, sync sub-protocols and browser-only state.
  - Chat streams: the adapter subscribes only the selected or requested chat
    and loads a 128 KiB tail first; older events page in on demand. It keeps
    at most eight chat streams (least recently used goes first), below the
    Relay bridge budget. It prefers `chat.getChatEventHistoryPage` and accepts
    the older `agentChat.getEventHistoryPage` alias.
  - Smart links use `chat.resolveSmartLinkPreview`, and Sources favicons use
    `chat.resolveSourceFavicons`. An older host gets the plain fallback.
  - `agentChat.drafts` uses `chat.listDrafts`, `createDraft`, `deleteDraft`,
    `updateDraft` and `claimDraft`.
  - The cross-machine handoff calls `chat.prepareCrossMachineHandoff`,
    `chat.validateCrossMachineSource` and `chat.markCrossMachineHandoff`. A
    host without them fails through `callRequired`.
  - List answers are normalized to an array. A mutation fails when the host
    lacks its descriptor. A settings write with no descriptor fails; it never
    echoes a "Saved" snapshot.
  - Scheduled work (create, list, cancel, pause) goes through host commands.
  - `usage.getAdeStats` and `usage.getGithubContributions` read the brain.
    `usage.onUpdate` is made here: while a stats read says `refreshing`, it
    notifies on a capped backoff (5 s, 15 s, 45 s, 120 s), and a tab that
    returns after ten minutes notifies once.
  - `computerUse.getOwnerSnapshot` builds the proof drawer from
    `computerUse.listArtifacts` (`shared/computerUseSnapshot.ts`).
  - Provider sign-in status (OpenCode OAuth, Pi) has no push channel on the
    web. `misc.ts` drains the runtime event buffer through
    `personalChats.streamEvents`, only while a sign-in runs: every 1 s, then
    every 5 s after a quiet minute, paused while hidden, and stopped at the
    21-minute deadline or the flow's last state.
  - The Cursor Cloud fleet (`ai.cursorCloudFleet`) polls every 2 s while a
    listener exists, backs off to 15 s after three unchanged reads, and pauses
    while hidden. Fleet actions use the host's Cursor API key.
  - `cto.*` is added method by method, so a browser never gets the host's
    Linear credential writes. Each CTO call carries the CTO home's pin; a pin
    for another machine refuses.
  - `applyHostedWebZoom` (`lib/webZoom.ts`) runs at install and on
    `AppShell` mount, so a reload paints at the user's zoom. At zoom 1 the
    body stays `height: 100%`.
  - `personalChats.ts` calls runtime-scoped `personalChats.*` actions
    (`requireProject: false`) and subscribes transcripts with
    `chatScope: "personal"`.
  - `lanes.ts` passes `getBranchDrift` and `resolveBranchDrift` to the
    `lanes.*` commands.
- `apps/desktop/src/renderer/webclient/adapter/githubStub.ts` -
  `window.ade.github` on the web. Reads a paired machine can serve go to it;
  the rest answer with a stub that says so. `getAppUserAuthStatus` answers
  `GITHUB_APP_USER_AUTH_UNSUPPORTED` (`appUserAuthSupported: false` and a true
  `credentialState`); renderers check `isGithubAppUserAuthSupported`.
- `apps/desktop/src/renderer/webclient/adapter/reconnectHold.ts` - a machine
  that was connected reads as connected for up to 30 s of time in front while
  it reconnects, so Work keeps the open chat. A first connect, a refusal and a
  parked machine are not held.

Browser shell and routes:

- `apps/desktop/src/renderer/webclient/main.tsx` - installs a pending
  `window.ade` before shared modules import, then mounts `WebClientRoot`.
- `apps/desktop/src/renderer/webclient/shell/WebClientRoot.tsx` - the boot.
  - It replaces the retired routes `/pair` and `/hub` first; visits land on
    `/work`, where the App shows the welcome page.
  - Account bootstrap, catalog pruning and privacy pruning finish before saved
    environments show, so no other account's records leak. Then it starts the
    30 s lease monitor, restores environments and catalogs, installs the
    federated adapter, keeps a pending `/open` target, and restores the
    project or Chats.
  - With nothing restored, it dials the last-active machine *after* first
    paint. A storage failure is a non-fatal notice; sign-in still works.
  - Signed out, it loads no workspace code: only `window.ade.account` and the
    lazy `WebSignInScreen` (`components/onboarding/WebSignInGate.tsx`). The
    gate reads theme values through `state/appearanceStore.ts` until
    `appStore` loads. With a stored session (`hasPersistedSession()`),
    `preloadWorkspaceModules()` starts those imports during bootstrap.
    Numbers: `docs/perf/macos-baseline.md` (`npm run bench:webclient`).
  - The entry stylesheet is `webclient/gate.css`: Tailwind limited to
    `apps/desktop/tailwind.gate.config.cjs`, `styles/foundation.css`, the
    surface kit, the scene rules, `styles/toolPickerBackdrop.css` and
    `styles/smartTooltip.css`. `index.css` imports the same partials.
    `loadAppStylesheet()` loads the full stylesheet first in `loadAppRoot()`
    and `preloadWorkspaceModules()`, because it must come before every chunk
    stylesheet. A component that renders before the workspace loads must be
    in the gate config's `content`, and its rules in a shared partial.

  Signed-out boot loads no workspace code. After account bootstrap and privacy
  pruning, a visitor with no account session gets only `window.ade.account`
  and a lazy `WebSignInScreen` chunk (`components/onboarding/WebSignInGate.tsx`).
  The federated adapter, `App` and `appStore` stay unloaded: the gate's theme,
  scene and tooltip code read their values through `state/appearanceStore.ts`,
  which is a stand-in filled from the saved preferences until `appStore` loads
  and registers itself there. When
  `hasPersistedSession()` reports a stored session, `preloadWorkspaceModules()`
  starts those imports alongside bootstrap, so a signed-in reload does not wait
  for them afterwards. The signed-out numbers are in
  `docs/perf/macos-baseline.md` (`npm run bench:webclient`).

  The entry stylesheet is `webclient/gate.css`, not `index.css`. It holds what
  the boot screens and the sign-in card draw: Tailwind limited to the files in
  `apps/desktop/tailwind.gate.config.cjs`, `styles/foundation.css` (theme
  values, the dark and light token blocks, base element rules), the surface
  kit, the scene rules, and the backdrop and tooltip partials
  (`styles/toolPickerBackdrop.css`, `styles/smartTooltip.css`). `index.css`
  imports the same partials, so every rule of the entry stylesheet is in the
  full one as well. The full stylesheet loads with the workspace
  (`loadAppStylesheet()` in `WebClientRoot.tsx`): `loadAppRoot()` waits for it,
  and `preloadWorkspaceModules()` starts it with the other imports. It is
  first in both lists, because stylesheets apply in the order their links are
  added, and the app's stylesheet must come before every chunk stylesheet. A
  component that renders before the workspace
  loads must be in the gate config's `content` list, and a component rule it
  needs must be in a partial that both stylesheets import; otherwise it is
  unstyled on the sign-in screen only.
- `apps/desktop/src/renderer/webclient/workspace/WebMachineSessionManager.ts` -
  the machine sessions: Live, Reconnecting, Parked and Offline.
  - It merges saved environments with live clients, serializes admission and
    joins same-target connects.
  - The pool holds at most four `AdeSyncClient`s. A fifth parks the
    least-recently-used inactive session; selecting a parked machine
    reconnects it.
  - It owns the catalog cache (`hydrateCatalogs` at boot, live catalogs
    written to IndexedDB, the last-active key on connect, a forgotten
    machine's catalog dropped). Without a store it runs without the cache.
  - A `background` connect (a repository tab joins every computer with a
    copy) never parks another machine and skips a machine the person
    disconnected (`disconnectByUser`, kept in `localStorage`). The person's
    own connect clears that, and waits for a background connect in flight.
- `apps/desktop/src/renderer/webclient/workspace/machineIdentity.ts` -
  `machineCatalogKey` (`device:<hostDeviceId>`, else the environment id). It
  is a leaf module, so shared desktop components can import it without the
  sync client.
- `apps/desktop/src/renderer/webclient/workspace/webWorkspaceModel.ts` -
  `mergeWebMachines` folds the directory, saved environments, live sessions
  and catalogs into one row per machine. Status comes from
  `accountMachineConnectionState`, so a machine with a relay route reads
  **Available**, not Offline. `webConnectStage` gives the stage (Dialing
  relay, Authenticating, Loading projects). `webRecentProjects` builds the
  `RecentProjectSummary` rows of the welcome page.
- `apps/desktop/src/renderer/webclient/workspace/WebWorkspaceContext.tsx` -
  the account, directory, session pool, federated adapter, notices, machine
  actions and deferred deeplinks. `connectMachineEntry` uses a saved pairing
  first, else account adoption. `forgetMachineCatalog` drops cached projects.
  Shared components call `useOptionalWebWorkspace` to know they run in ADE
  Web.
- `apps/desktop/src/renderer/components/app/ConnectionsPanel.tsx` (hosted
  mode) - the account header and machine list, without This computer, the
  pairing code, or the Phone and Web tabs. **Connect** goes through the
  tab's `WebMachineSessionManager` and reuses a saved pairing. At
  `WEB_MACHINE_SESSION_LIMIT` the panel says so (it loads the limit on
  demand). The `ade-web:open-connections` event opens it.
- `apps/desktop/src/renderer/webclient/shell/ScreenShell.tsx` and
  `shellTokens.ts` - the startup and error frame. Machine and project choice
  live in the app shell (welcome page, connections chip, tab strip).
- `apps/desktop/src/renderer/webclient/shell/sessionLifecycleChrome.ts` -
  one injected stylesheet keyed on `<html data-ade-session-lifecycle="ready" |
  "unsupported">`. Under `@media (pointer: coarse)` the hover-only snooze
  control becomes a visible 2rem touch target and the snooze menu rows get a
  44px minimum height.
- `apps/desktop/src/renderer/webclient/shell/webRoutes.ts` - web routes over
  `apps/desktop/src/shared/deeplinks.ts`. A `lane-share` link maps to
  `/shared?grant=<id>`, which needs no machine.
- `apps/desktop/src/renderer/webclient/sync/relayReady.ts` - the Relay
  `ready=2` handshake for every browser socket to
  `wss://<relay>/connect/<machineKey>`.
- Lane sharing: the guest side works (`/shared`, the shared lane view,
  `laneShareGuest` calls); the owner side is desktop-only (`laneShare.*`
  answers `lane_share_desktop_only`; Settings › Sharing is hidden). See
  [lane sharing](../lanes/lane-sharing.md).

Reused desktop renderer (web-mode adaptation):

- `apps/desktop/src/renderer/lib/webClientMode.ts` - `isWebClientMode()` reads
  the `window.__adeWebClient` flag. `WEB_CLIENT_TAB_PATHS` lists the web tabs
  (`/work`, `/lanes`, `/files`, `/prs`, `/chats`); the welcome page on `/work`
  is the pre-project page. `isCssZoomedBrowserSurface()` (hosted client and
  the `browserMock` preview) makes `AppShell` use `h-full`, not `100vh`.
  `AppShell.tsx`, `TopBar.tsx`, `projectSidebar/` and
  `OnboardingBootstrap.tsx` read the flag to hide window controls, the
  updater, the tour and tabs with no sync backing.
- `apps/desktop/src/renderer/lib/webZoom.ts` - the web stand-in for Electron
  zoom: inverse-sized `<body>` plus CSS `zoom`.
- `apps/desktop/src/renderer/lib/fixedMenuPlacement.ts` - a fixed menu above
  its anchor uses `top` plus `translateY(-100%)`, so zoomed rects never mix
  with `window.innerHeight`.
- `apps/desktop/src/renderer/components/activity/HeaderActivityControl.tsx`
  and `ActivityPane.tsx` - the Activity popover and pane (one
  `ActivityPanel`, grouped like the Work board). It is not a tab.
  `/activity` (and the old name `/attention`) opens the pane over the current
  tab; both are in `APP_ROUTE_ROOTS`.
- `apps/desktop/src/renderer/components/app/TopBar.tsx` and
  `ConnectionsPanel.tsx` - the Connections chip and panel (Machines, Phone,
  Web; hosted mode shows the hosted sections only) and the tab strip.
  - Checkouts of one repository share one tab; with copies on several
    machines, the machine is a selector inside the tab. Parked and offline
    bindings stay and reconnect when chosen.
  - A computer that leaves never closes a tab (`moveWebTabsOffGoneTargets`).
    It left when it is forgotten or removed, or when it stays not connected
    3 s after the reconnect hold ends. Each tab moves to a copy on another
    connected computer; a tab with no other copy moves to ADE Cloud
    (`useWebTabsFollowComputers.ts`). When the computer comes back, its tabs
    move back.
- `apps/desktop/src/renderer/components/onboarding/LaunchGate.tsx` - the web
  variant gates on the account only: signed in shows the app, signed out
  shows `WebSignInGate` (`GlassSignInCard`) with no skip. The boot shows the
  same card through `WebSignInScreen` earlier. The desktop gate keeps one
  button that opens ADE Web's `/sign-in`.
- `apps/desktop/src/renderer/components/onboarding/ClerkSignInPanel.tsx` -
  ADE's own Clerk sign-in in the card: Google, GitHub and Apple, an email
  code, sign-up, and "Continue as". If Clerk cannot be reached or needs a step
  the card does not show (a second factor), the card's button opens Clerk's
  hosted page. A fallback that is not a second factor is a Sentry warning
  (`clerk_sign_in_unavailable`).
- `apps/desktop/src/renderer/components/onboarding/GateBackdrop.tsx` - on ADE
  Web a visitor with no picked scene sees "Mountain vista"
  (`useActiveScene({ untouched })`). The desktop shuffles.
- `apps/desktop/src/renderer/components/projects/ProjectWelcomePage.tsx` - the
  shared welcome surface (Home) on desktop and web. It renders the home
  dashboard (`ProjectWelcomeHome.tsx`: the hero and the widget grid) and the
  projects list. The account's projects decide the rows on every client
  (`useHomeAccountProjects.ts`); on the web, the machines' catalogs
  (`webRecentProjects`) add their copies. One card shows each repository, with
  its machines behind an **N machines** chip. An own computer that is offline
  does not show. Clicking a card connects that machine first, then opens the
  project. A project with no own computer online opens on ADE Cloud. With no
  own computer, Home shows the "Get started with ADE" steps
  (`GetStartedCard.tsx`). **Chat without a project** shows on the web only
  while an own computer is live, and it names that computer.
- `apps/desktop/src/renderer/components/projects/ProjectWelcomeHome.tsx` - the
  home hero and cards (running work, activity, limits and machines, the open
  project's PRs). Each card reads state the renderer holds; the PR card reads
  `prReadCache`.
- `apps/desktop/src/renderer/components/projects/ProjectWelcomeWebRows.tsx` -
  the row parts (artwork, the **N machines** chip and menu, badges, relative
  time), driven by props only.
- `apps/desktop/src/renderer/components/projects/ProjectWelcomeWebNotices.tsx` -
  `webZeroMachinesNotice`, a pure function of the account snapshot, for a
  machine list that did not load. Kinds: `loading`, `signed_out`,
  `unconfigured`, `unavailable`. An account with no computer is not an error:
  it has ADE Cloud. Failure kinds add a `reassurance` line.
- `apps/desktop/src/renderer/components/settings/WebScopePill.tsx` - on the
  web, each Settings section says where it saves: the connected machine, the
  account, or this browser. Scope comes from `sectionWebScope`
  (`settingsManifest.ts`); `hidden` sections do not render. The desktop shows
  no pill.
- `apps/desktop/src/renderer/webclient/workspace/useWebChatsMachines.ts` - the
  Chats page on the web. The rail lists every live machine's chats; a call
  that names a machine goes to its chats adapter. The composer's picker keys
  options by `machineCatalogKey`, because a machine never dialed has no
  target id; picking one connects it first. Null on the desktop.
- `apps/desktop/src/renderer/components/analytics/ProductAnalyticsLifecycle.tsx`
  - route and project capture plus the web startup event, through
  `window.ade.analytics` only. No consent prompt; an earlier browser opt-out
  still applies.

Machine runtime and sync host:

- `apps/ade-cli/src/services/sync/syncHostService.ts` - the sync host:
  pairing and hello auth, DPoP, changesets, project catalog and switch, file,
  chat and terminal streams, and command descriptors.
- `apps/ade-cli/src/services/sync/syncHostRecovery.ts` - project-host
  readiness and **Fix connection**. The web shows the same card as iOS
  (`ProjectHostRecoveryScreen`, not the local `ProjectRecoveryScreen`) and
  keeps cached lists. The machine serializes the repair with a deadline, so a
  second tab joins it. Shared parsing and the retry ladder:
  `apps/desktop/src/shared/syncHostRecoveryUi.ts` and
  `apps/desktop/src/shared/types/syncHostRecovery.ts` (iOS mirrors them).
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` - the command
  registry with the web `register("...")` entries. `sync.getWebPairingInfo`
  stays in the protocol; no client uses it.
- `apps/ade-cli/src/services/sync/productAnalyticsRemoteCommand.ts` and
  `syncHostService.ts` - bind browser capture to the host's `web` surface and
  keep `analytics.setClientEnabled` per peer; a browser never changes the
  machine's own preference.
- `apps/ade-cli/src/services/sync/syncPairingStore.ts` - pairings: the device
  secret, an optional DPoP key, and local or account provenance
  (`accountOwnerUserId`, `localTrustOrigin`). A same-account hello with a
  valid DPoP proof adopts a local pairing into the account; owner revocation
  demotes such a record to local trust, not deletes it.
- `apps/ade-cli/src/services/sync/syncDpop.ts` - host-side P-256 proof
  validation and replay guard.
- `apps/ade-cli/src/services/sync/syncCloudRelayStore.ts` - the relay
  `machineKey` and HMAC identity and the `wss://<relay>/connect/<machineKey>`
  URL. Account sign-in is the only gate.
- `apps/ade-cli/src/services/sync/syncTunnelClientService.ts` and
  `apps/tunnel-relay/` - brain-side Cloudflare tunnel client and the relay
  Worker/Durable Object.
- `apps/ade-cli/src/services/sync/brainProjectActionsSyncHandler.ts` - the
  machine-level handler before a project host owns the listener. The machine
  catalog marks the `ProjectScopeRegistry`'s current host as `isOpen` on each
  read, so a reconnect binds streams to the right project.
- `apps/ade-cli/src/services/sync/deviceRegistryService.ts` - device records;
  `SyncPeerDeviceType` includes `browser`.

Account connection and entry points:

- `apps/account-directory/src/directory.ts` - machine register, list and
  delete. The list reads the 500 most recently seen rows, orders online
  first, adds the cloud truth for cloud computers (`withCloudTruth`), and
  exposes `Server-Timing`. It echoes `X-ADE-Correlation-ID` and logs it with
  route, status and duration.
- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.tsx` - the
  **Connections › Phone** and **› Web** bodies and the **This Mac** card (PIN
  and phone QR). Web is account sign-in only.
- `apps/desktop/src/shared/pairingQr.ts` - the phone's pairing URL
  `https://ade-app.dev/pair#<base64url(JSON)>` (`PairingQrPayload`: host,
  port, addresses, optional relay URL and `pinConfigured`; never the PIN).
  It is not a browser pairing link.
- `apps/desktop/src/shared/webClientUrl.ts` - the `https://app.ade-app.dev`
  URL builder (`/open`; `/pair` is retired).
- `apps/desktop/src/shared/deeplinks.ts` - shared deeplink grammar layered
  under the web client's `/open` route.
- `apps/ade-cli/src/commands/deeplinks.ts` - `ade link --web`.
- `apps/desktop/src/renderer/components/lanes/LaneContextMenu.tsx` and
  `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` /
  `SessionContextMenu.tsx` - desktop "Open in web" entry points.
- `apps/web/src/app/pages/PairPage.tsx` - the marketing page for the pairing
  URL on a device without the app. It reads nothing from the URL and points
  to the iPhone app, with a link to the web client.
- `apps/web/scripts/check-entities.mjs` - a build guard that rejects
  unsupported named HTML entities in JSX.

Tests:

- `apps/desktop/src/renderer/webclient/account/client.test.ts` - OAuth, the
  session record, token lifetime, and storage and URL privacy.
- `apps/desktop/src/renderer/webclient/sync/envStore.test.ts` - the trust
  migration and IndexedDB upgrades.
- `apps/desktop/src/renderer/webclient/sync/__tests__/sync.test.ts`.
- `apps/desktop/src/renderer/webclient/adapter/__tests__/adapter.test.ts`,
  `runtimePinGuard.test.ts` (the pin boundary), `federated.test.ts`
  (restoration, binding pins, adapter changes),
  `sessionLifecycleOverlay.test.ts` and `appleDevice.test.ts`.
- `apps/desktop/src/renderer/webclient/workspace/__tests__/WebMachineSessionManager.test.ts` -
  the four-client pool, parking and auth-failure cleanup.
- `apps/desktop/src/renderer/webclient/shell/__tests__/webClientShell.test.tsx` -
  boot, the retired route, account privacy.
- `apps/desktop/src/renderer/components/app/TopBar.test.tsx`,
  `apps/desktop/src/renderer/components/settings/SyncDevicesSection.test.tsx`,
  `apps/ade-cli/src/commands/deeplinks.test.ts`,
  `apps/ade-cli/src/services/sync/syncRemoteCommandService.test.ts`.

## Gotchas

- **The sign-in card depends on two Clerk facts.** The Clerk OAuth app's
  consent screen must stay off; with it on, the authorize step goes to
  Clerk's consent page and a development session is lost.
  `clerkFrontendApi.ts` reads Clerk's shapes defensively, so a renamed field
  sends the card to its one button (Clerk's hosted page). After a Clerk API
  version change, sign in for real on the development instance
  (`npm run dev:webclient`, a `+clerk_test@example.com` address, code
  `424242`).
- **A `window.ade` member the adapter lacks is a stand-in, not `undefined`.**
  `withFallbackProxy` (`adapter/infra/proxy.ts`) returns a callable that
  rejects with `AdeUnavailableError`; an `on*` member returns a no-op
  unsubscribe. It is truthy, so feature checks must use
  `isAdeAvailable(window.ade?.ns?.method)` (`lib/adeAvailability.ts`). An
  unhandled `AdeUnavailableError` is swallowed (`webclient/main.tsx`) and not
  sent to Sentry.
- **The hosted page cannot dial LAN or Tailscale `ws://`.** Browsers block
  mixed content. New connections use the account relay; a saved environment
  may keep a verified `wss://` route. `ws://127.0.0.1:<port>` is for local
  development only.
- **The browser has no ADE database.** It advertises `invalidationOnlyV1` and
  `compactInvalidationV1`, refreshes every domain after hello, and then
  refreshes only the domains each `invalidation_batch` names. The host sends
  no row values and caps a hint at 16 KB (else a full refresh hint). A host
  that does not confirm both features in `hello_ok.features` is closed with
  update guidance, so it cannot replay its CRR backlog over Relay.
- **Protocol version 1 extensions are additive.** The browser ignores types it
  does not implement (`rpc_*`, `fwd_*`) and unknown feature keys. A missing
  key means the capability is not there.
- **IndexedDB holds the refresh credential, pairings, DPoP keys and
  catalogs.** Cleared site data means a new sign-in and a new adoption; a
  legacy direct environment cannot come back through the hosted UI, and the
  private key cannot be exported. Unavailable storage is recoverable: the
  directory still loads, saved environments hide, and Retry opens again.
  Keep multi-store privacy cleanup in one transaction.
- **Connection liveness is what the app sees.** An open WebSocket does not
  prove the relay path works. Keep the 75 s inbound watchdog. Keep the
  transport-open and hello deadlines apart, so slow token work and a dead
  route fail differently.
- **Analytics is on by default and honors a browser opt-out.** The host keeps
  a per-socket consent bit that starts off, so each connection must send the
  preference again before capture. A failed opt-out ack closes the
  connection. Accepted events use the host's 200-event daily budget. See
  [logging and product analytics](../../logging.md).
- **The phone pairing payload must stay a URL fragment.** It omits the PIN,
  and fragments do not reach servers. Do not make it a hosted pairing route
  or a query parameter.
- **The relay is transport, not cloud state.** It stores no project state but
  can read the frames it carries. There is no end-to-end payload encryption.
- **Remote-command descriptors are the host's authority.** An adapter method
  runs only when the host lists the action in
  `hello_ok.features.commandRouting.actions`.
- **Optimistic lifecycle state must expire.** A `SessionLifecyclePatch` carries
  only lifecycle columns and retires by reconcile, reject or TTL. A host
  no-op (waking a row that was never snoozed) must not show as applied.
- **A runtime pin the adapter cannot route must throw.** One adapter is one
  machine and one project. Only a pin for this adapter's own machine *and*
  project may run unpinned. A new pinned member takes `RuntimePinArg` and
  calls `assertWebRuntimePinRoutable` first. ADE Cloud and `cloud-saved:` pins
  go to the account adapter, never to a sync adapter.
- **Native-only surfaces stay unavailable.** OS notifications, external
  editors, Finder, directory pickers, native shells, computer use, the
  built-in browser, the iOS Simulator, an update of the tab's own app and
  transcription. App Control is watch-only (`adapter/appControl.ts`).
- **Updating another machine works.** A tab installs nothing itself. It calls
  `remoteRuntime.updateAndRestart` / `getUpdateImpact`, which the federated
  adapter sends as that machine's `machine.updateAndRestart` /
  `machine.updateImpact` sync commands (`adapter/federated.ts`,
  `machineUpdateRemoteCommands.ts`). A machine whose brain predates them
  reports `capabilities.remoteUpdate: false`, so its row shows "Update it on
  that machine" and no Update button.
- **The build output shape matters.** `_headers`, `_redirects`,
  `_routes.json`, `_worker.js` and `index.html` must sit directly in
  `apps/desktop/dist/web-client`.

## Architecture

```
Cloudflare Pages static files
https://app.ade-app.dev
  |
  v
Browser shell
apps/desktop/src/renderer/webclient/{shell,workspace}/
  - mandatory account sign-in gate (no skip)
  - projects-first welcome: recents across every machine
  - persisted per-machine project catalogs + Chats entry
  - connections chip: status, account and browser trust management
  - /open resolver
  |
  v
WebMachineSessionManager
  - four-client hard cap
  - serialized admission + same-target dedupe
  - LRU park/resume with catalog retention
  |
  v
Federated window.ade adapter
  - one adapter per machine + project binding
  - persisted welcome/project/Chats surface
  - repo tabs with machine selection inside the tab
  |                                   |
  | own computer                      | ADE Cloud binding or cloud-saved: pin
  |                                   v
  |                                 Account adapter (adeCloudSyncClient)
  |                                   - account reader: account server + GitHub
  |                                   - saved chats, terminal copies, Git summaries
  |                                   - message queue; wakes run in the background
  |                                   - never dials a computer
  v
AdeSyncClient pool (own computers)
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

The hosted SPA is only the controller UI. A machine runtime is the authority
for its project state, file access, processes, terminal IO, and chat
mutations. For ADE Cloud, the account server holds what a person can read
while the cloud computers sleep: saved chats, CLI and shell copies, Git
summaries, the lane index, the CTO copy and account settings.

## Account connection and auth flow

1. The boot shows only the sign-in card (`WebSignInScreen`), with no skip.
   The card signs the browser in to Clerk on the page (email code, or Google,
   GitHub or Apple through `/sign-in/return`). Then ADE Web's OAuth PKCE
   sign-in runs, and Clerk completes it at once. Desktop **Connections › Web**
   points to this flow; there is no QR, link, PIN or manual endpoint.
2. The browser loads the account directory and shows the welcome page. A
   returning browser paints recents from the saved catalogs first and dials
   the last-active machine in the background.
3. Selecting a computer (or one of its projects) captures the account-session
   generation, gets a fresh access token, and dials only the
   directory-verified `wss://<relay>/connect/<machineKey>`.
4. `client.ts` makes a non-extractable P-256 key pair and adopts the machine.
   The runtime checks the same-account proof, stores the DPoP public key and
   returns a per-device secret.
5. If the session generation is unchanged, the browser saves the environment,
   the secret and the key pair in IndexedDB.
6. Each reconnect sends a paired `hello` with the secret and a DPoP proof.
   Relay reconnects also send a fresh account proof. A direct route never
   carries the Clerk bearer over `ws://`.
7. Sign-out or an account switch closes Relay sockets, removes account-owned
   environments and the other account's catalogs, and shows the sign-in gate.
   It also stores a "signed out by the user" marker, so the next sign-in ends
   the browser's Clerk session first and asks for an account.

**Sign-in for a computer (`/sign-in`).** The desktop app and `ade login`
open `https://app.ade-app.dev/sign-in?continue=<authorize URL>`
(`buildWebClientSignInUrl`, production Clerk only). The page runs the card,
then goes to that authorize URL, which returns to the computer's loopback
listener.

- It accepts only this client's issuer, `/oauth/authorize`, its client id and
  an `http://127.0.0.1` redirect. Anything else loads ADE Web as usual.
- `prompt=login` (after the computer's sign-out) becomes `fresh`.
- A fallback opens the same authorize URL on Clerk's own page.
- Deploy ADE Web before a desktop build that opens `/sign-in`.

**The `ade_signed_in` marker.** On sign-in ADE Web sets `ade_signed_in=1` on
`.ade-app.dev` (Path `/`, Secure, SameSite Lax, 30 days). It carries no
token. `apps/web` reads it on `/` to send a signed-in visitor to ADE Web
(`?home` skips that). Sign-out, an expired session and a boot with no session
delete it. Only ade-app.dev pages write it. Its name and rules are a contract
with `apps/web/index.html`.

Browser pairings made before account-only pairing stay under **Saved on this
browser** and reconnect over their saved routes. New non-account pairings are
not possible.

## Transport matrix

| Transport | Endpoint | Hosted page | Use |
|---|---|---:|---|
| Relay | `wss://<relay>/connect/<machineKey>` | Yes | Every new hosted connection. The runtime keeps its outbound socket (`syncTunnelClientService.ts`) while signed in. |
| Saved direct | `wss://...` | Yes | Only an environment paired before account-only pairing. |
| Local dev | `ws://127.0.0.1:<port>`, `ws://localhost:<port>` | No | `http:` and localhost pages (`npm --prefix apps/desktop run dev:webclient`). |
| LAN or Tailscale IP | `ws://192.168.x.x:<port>`, `ws://100.x.x.x:<port>` | No | Local pages only; mixed content on the hosted page. |

Relay uses `ready=2`: the Worker sends `accepted/v2`, then `ready/v2` when the
machine pipe and listener are open. The browser sends no hello before `ready`.
A Worker that does not answer v2 in time gets a fresh legacy socket.

Own computers send project state over one live sync transport. ADE Cloud
reads come from the account server and GitHub (*ADE Cloud reads*). Only the
active project mounts, so an inactive project's subscriptions cannot use
another machine's adapter.

## Account machine directory

The shell loads the account's machines from the account-directory Worker and
merges them with saved environments and catalogs (`mergeWebMachines`).

- The account's cloud computers are not own computers
  (`useOwnWebComputers`, `state/ownComputers.ts`). They show only as ADE
  Cloud. A cloud computer that is not in the lane index yet makes one new
  read of the cloud computers.
- `online` is a 90 s presence lease, not proof that a route is gone. A row
  with a verified Relay endpoint stays selectable after the lease ends; the
  ready-v2 bridge and hello decide. A row with no secure endpoint is listed
  but cannot be selected.
- A row is Live, Reconnecting, Parked or Offline.
- A 401 forces one token refresh and one retry. Only a second 401 or 403 is
  `auth_expired`. Timeouts and outages stay retryable and keep saved trust.

Hosted builds use the production Clerk app and directory; Vite development
uses the development ones. Self-hosted builds can set:

```text
VITE_ADE_CLERK_ISSUER=https://<clerk-instance-or-approved-proxy>
VITE_ADE_CLERK_OAUTH_CLIENT_ID=<public-oauth-client-id>
VITE_ADE_ACCOUNT_DIRECTORY_URL=https://<account-directory-worker>
VITE_ADE_ACCOUNT_RELAY_URLS=https://<approved-relay-base>[,https://<another-base>]
```

`VITE_ADE_ACCOUNT_RELAY_URLS` is optional with the default relay. The Clerk
OAuth app must allow `https://app.ade-app.dev/account/callback`, and the
Worker's `WEB_CLIENT_ORIGIN` must be the exact hosted origin. No wildcard
origin is accepted with an account bearer.

**Where the bearer goes.** Only to the Clerk token endpoint, the trusted
directory origin, and a directory-advertised `wss://` endpoint on an
allowed relay base with the exact `/connect/<machineKey>` path. It never goes
in a query, fragment, log, analytics payload or browser storage. LAN,
tailnet and `ws://` routes become eligible only after adoption. A same-owner
hello with the pinned DPoP key may rotate the secret, so a lost reply is
retryable. With no verified relay, the connection fails closed.

**Ownership.** Each adopted environment records its Clerk user id. Sign-out
removes that user's environments, secrets and keys. Legacy local pairings have
no owner and stay. A direct-paired machine that is also in the directory
keeps its direct provenance.

**Machine actions.**

- **Remove from account** deletes the directory row for every client. The
  confirm names the install ("MacBook Pro · ADE Alpha"); for a machine seen in
  the last five minutes it warns that the machine disconnects until someone
  confirms it there.
- **Forget on this browser** deletes only the local environment and its keys.
- Rename sets the account display name.

Account pairing checks the session generation before and after the network
work, so a late reply after sign-out cannot recreate trust.

## Data strategy: no local DB

The browser keeps no copy of `.ade/ade.db`. `SyncConnection.sendHello` sends
`dbVersion: 0` with `invalidationOnlyV1` and `compactInvalidationV1`, so the
host starts it at the current watermark and replays no CRR rows (see
*Gotchas*). Project reads are live round-trips to the binding's machine.
Account Activity is the exception: a signed-in browser reads the push relay
directly.

- **Read cost.** Reads and file lists go through the 3 s coalescing cache
  (`infra/commandCaller.ts`, `adapter/files.ts`). PRs read one
  `prs.getMobileSnapshot` (`adapter/prs.ts`). These caches are hints, not a
  store.
- **Sessions.** At most four live sync clients. Parked sessions keep bounded
  metadata and free their slot. Open tabs persist per account as bindings; a
  call that carries a binding stays on that machine and project.
- **Activity.** `adapter/attention.ts` keeps its own account cursor and
  validates every item, destination, action, machine, project, tombstone and
  preference before `window.ade` shows it. A 401 may force one token refresh.
  Machine fallback acks with the snapshot owner and item revision; an account
  switch rejects stale opens and acks until a new snapshot loads.
- **Lifecycle writes** (settle, snooze, wake) use `sessionLifecycleOverlay.ts`
  and `sessionLifecycleSupport.ts`.
- **GitHub status.** A connection change does not call `github.getStatus`,
  because headless GitHub discovery can touch git, the GitHub CLI and the
  Keychain. On a GitHub route the shell forces one status read 750 ms after
  each change to `connected`; after that the 12 s and 30 s policy applies.
  The headless read is asynchronous, time-boxed and coalesced.
- **Chat history.** A chat opens on a 128 KiB tail with a byte cursor. Older
  pages are at most 256 KiB, read with asynchronous fs and zlib. One global
  inflater runs at a time; during fast switching only the active inflate and
  the newest queued request stay. Archives under 4 MiB may enter a 16 MiB
  memory cache. Larger archives inflate at most once to an unlinked private
  temp file (256 MiB ceiling, LRU, a free-space guard). A cancelled request
  aborts its work. `chat.getTranscript` uses the same byte cursor
  (`cursorKind: "byte"`). The adapter accepts the page action and the older
  `agentChat.getEventHistoryPage`.
- **Chat viewport.** A top sentinel and an underfill check keep loading until
  the view scrolls or the head is reached. A failure keeps the cursor and
  shows Retry. Live appends follow only at the bottom, and ADE's prepend
  anchor turns off CSS scroll anchoring.
- **Subscribe barrier.** The host holds live events for a session while it
  captures a `chat_subscribe` snapshot, then resumes from the offset taken
  before it. An event during a slow snapshot arrives after the ack, never
  before and never lost; delivery keys remove overlap.
- **Invalidation.** `connection.ts` checks the batch's table limits.
  `createInvalidationScheduler` maps tables to domains (lanes, sessions,
  chats, PRs, files, GitHub, rebase); the first hint starts the debounce. A
  project switch clears streams and caches, rebinds, and invalidates every
  domain.
- **Terminals.** Recovery is by byte offset (`sync/client.ts`). A full
  snapshot replaces the xterm buffer and voids older hydration promises.
  Streams with no offset stay append-only.

Sub-protocols:

- Remote commands: `command`, `command_ack`, `command_result`
  (`syncRemoteCommandService.ts`). Smart-link metadata comes from the host;
  the browser never fetches pasted URLs.
- Files: `file_request`, `file_response`.
- Chat: `chat_subscribe`, `chat_event`, `chat_unsubscribe`.
- Terminal: `terminal_subscribe`, `terminal_data`, `terminal_history`,
  `terminal_input`, `terminal_resize`.
- Projects: `project_catalog`, `project_catalog_request`,
  `project_switch_request`, `project_switch_result`.
- Personal chats: runtime-scoped `personalChats.*` and `chat_subscribe` with
  `chatScope: "personal"`.

Browser storage holds only UI state, pairings and the catalog paint cache
(`envStore.ts`), plus browser-only preferences such as layout, zoom and
keybindings (`adapter/infra/localState.ts`). Catalogs hold names, paths, lane
counts and icons, never project contents, and go away at sign-out or an
account switch.

## ADE Cloud reads

A project tab binds to ADE Cloud when no own computer with a copy is online
(`openAdeCloudProject`). A cloud lane whose computer sleeps is read through a
`cloud-saved:<machineKey>` pin. Both are account-answered pins:

| Surface | Source while the computer sleeps |
|---|---|
| Work: chats, subagents | Saved chats (`/cloud/chats`), nested by parent |
| Work: CLI sessions, shells | Saved copies (`/cloud/sessions`; shells keep the last 5,000 lines) |
| Lanes | The project overview (`/cloud/projects/overview`) |
| Files | GitHub at the lane's branch, read-only; changed files from the Git summary. See [Files with no computer awake](../files-and-editor/README.md#with-no-computer-awake) |
| PRs | GitHub with the account's sign-in (`direct` reader, `DirectPrsList`), read-only, with lane chips from the lane index. See [PRs with no computer awake](../pull-requests/README.md#with-no-computer-awake) |
| Git panel, History | The Git summary (`/cloud/git`) and GitHub commits |
| Linear, Jira | The account server (`/cloud/integrations/...`) |
| Search | Each online computer that has `search.query`, plus the Work rows the page already loaded; with no online copy, only those rows |

A send to an asleep or deleted cloud chat goes to the account's queue
(`POST /cloud/chats/:machineKey/:chatId/messages`, with a `clientSendId`). The
server keeps the message, wakes the computer, and the computer sends it once.
The composer is free at once. The chat shows the waiting messages, Cancel for
a queued one, and a failed one with the server's sentence until the person
acts. A chat whose computer was deleted continues on a new computer in the
same chat row.

A cloud chat's older turns can exist only in its saved copy: the computer's
own transcript can start later. So a history cursor from the saved copy names
a part of it (`savedCopyHistoryCursor`, `chatHistoryWindow.ts`), and a scroll
up reads that part from the account even after the computer wakes and the
list drops the chat's saved row (`cloudSavedChats.ts`). Each saved page is
deduped against the whole loaded list, not only its seam.

An older server answers a new route with 404. Then the client keeps the
earlier behavior: the separate lists, or a wake and a direct send.

## Appearance and background reads

`components/app/AppearanceRoot.tsx` owns theme, color scheme, motion and
scene for `App` and the lazy `WebSignInScreen`. A failed sign-in chunk load
shows the shell's error with Retry.

- The web default scene is `plain` (no picture, no motion); the desktop
  default is Shuffle. An untouched earlier default reads as the current
  default; a saved choice stays. `showImage` stays true in the default.
  Reset is kept on reload.
- The command palette uses `Z_LAYERS.commandPalette`.
- `lib/backoffPoller.ts` runs the App Control and Cursor fleet polls per
  subscriber: three unchanged reads at the base interval, then doubling to
  15 s. A change or an action resets it. Hidden tabs make no reads; a tab
  that becomes visible reads at once. Stop removes timers and listeners.
- OAuth status draining (`adapter/misc.ts`) pauses while hidden and slows
  when quiet. A cancel during a read still delivers the final cancelled
  status.

## Deeplinks

The web client uses the shared deeplink grammar.

- `buildWebClientUrl` (`shared/webClientUrl.ts`) calls `buildDeeplink` with
  the `https://app.ade-app.dev` origin. `parseOpenTarget` (`webRoutes.ts`)
  maps `/open?...` to the desktop routes (`/lanes`, `/work`, `/prs`).
- The target waits in localStorage for 10 minutes (`shell/pendingTarget.ts`
  on `shell/linkStash.ts`), so it survives a sign-in. The stash also reads
  the field an older build wrote.
- **Owned links** (chat, lane or PR links with `accountMachineKey` and
  `projectId`) resolve after sign-in in `shell/ownedLinkResolution.ts`:
  find the machine, connect it, match the project (catalog id, then
  `projectRoot`, then a single repo match), open it, check that the chat or
  lane exists (6 s, `OWNED_LINK_CHECK_MS`; no answer opens anyway), then
  navigate. The "Opening your link" screen ticks each step.
- A failure shows one banner (`WebOwnedLinkBanner.tsx`) with Try again and,
  where it helps, Your computers. Failures: not in this account, list
  unavailable, computer offline, could not connect, project not there, older
  ADE, project failed to open, chat or lane gone. Before the project opens,
  the last project comes back behind the banner and the link waits; closing
  the banner drops it.
- A link with no owner applies when the person opens a project. A waiting
  owned link applies only to its own project. Selecting or reconnecting a
  machine does not use the target.
- The website's `/open` page forwards the query unchanged; see
  [Deeplinks](../deeplinks/README.md).
- **ADE Cloud plan links** (`shell/cloudPlanLink.ts`,
  `WebCloudPlanLink.tsx`). `/?cloudPlan=<free|plus|pro|max>` comes from the
  website; `/?cloudReturn=<done|cancelled|portal|card|card_cancelled>` is
  Stripe's return (built from the server's `WEB_CLIENT_ORIGIN`). Only an
  exact value counts, once.
  - The request waits 10 minutes in localStorage (the sign-in card says a
    link waits), and both parameters leave the address bar at once.
  - Signed in, the app opens Settings › ADE Cloud at Plans, also with no
    computer online.
  - A paid plan starts Stripe checkout in the tab only when
    `GET /cloud/access` lets the account in and `GET /cloud/account` shows no
    paid plan; else the page shows a toast. Free only shows the page.
  - A return shows how Stripe ended. An owned link in the same boot wins.
    The link never starts a sign-in.

Entry points: `ade link ... --web` (`apps/ade-cli/src/commands/deeplinks.ts`),
"Open in web" in `LaneContextMenu.tsx`, `TerminalsPage.tsx` and
`SessionContextMenu.tsx`, and `apps/web/src/app/pages/PairPage.tsx` for the
phone pairing URL.

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

The dev server proxies the account routes (`/account/machines`,
`/account/projects`, `/account/lanes`, `/cloud/...`, `/github/...`) and the push
relay (`/attention...`) and removes `Origin`. Set
`VITE_ADE_ACCOUNT_DIRECTORY_URL=http://localhost:5174` (and
`VITE_ADE_PUSH_RELAY_URL` for the relay) to use them.
`ADE_DEV_DIRECTORY_PROXY_TARGET` and `ADE_DEV_PUSH_RELAY_PROXY_TARGET` point
the proxies at another Worker, for example a local `wrangler dev`. The recipe
is in `vite.webclient.config.ts`.

**Dev test sign-in.** An agent that checks the web client on screen can sign
in without a browser sign-in:

1. Make a Clerk client session file for a **test** account
   (`{ "clientAuth": ..., "sessionId": ... }`). Do not use the owner's real
   account.
2. Start the dev server with `ADE_DEV_TEST_SESSION_FILE=<path>`.
3. Open the page. `GET /__ade_dev/session-token` mints a fresh session token
   in Node, and the page signs in with it (`account/devTestSession.ts`).

The route answers loopback callers and GET only, with `no-store`, and never
logs the token. The browser stores nothing. `vite build` has neither the
route nor the client code (`import.meta.env.DEV` removes it).

Ops checks after deploy:

- `https://ade-web-client.pages.dev/` serves the SPA, with the CSP from
  `_headers`, immutable `/assets/*` and `no-cache` on `/`.
- A signed-out visit shows the sign-in card and nothing else.
- Sign-in returns to `/account/callback`, removes the query, and shows the
  welcome page with the owner's machines and projects. No token is in
  browser storage.
- A reload of a known browser paints recents before any socket opens.
- `/open?type=lane&id=<uuid>` falls back to `index.html` and parses.
- `/pair#<payload>` scrubs the route and shows sign-in. `/hub` goes to the
  welcome page.
- The build fails over 1000 KB of first-load entry or on an eager heavy
  chunk.

## Known limitations

- No OS notifications, external editors, Finder reveal, native directory
  picker or local shell. Terminals run on the machine.
- No file or folder drop into the editor (no local path on the machine).
- Settings › ADE Cloud reads the plan, hours, disk and cloud lanes from the
  account server and pays through it (`adapter/cloudBilling.ts`). A lane's
  size, its delete, freeing its computer and Clear caches stay in the
  desktop app.
- Passwords: "Open ADE desktop or the iPhone to see and change Passwords.
  Agents on every computer, ADE Cloud too, still use them."
- No web push.
- Moving a lane or chat onto ADE Cloud is not built. Moving a chat between
  computers works; a resting source offers "Wake and move". Owner lane
  sharing is desktop-only.
- No ADE Browser, computer use or iOS Simulator. App Control is watch-only.
  Projectless Chats shows Terminal but not the Browser button.
- No file watcher: file changes come from invalidation and are coarser than
  desktop chokidar events. Some live updates are snapshots.
- Hosted HTTPS cannot dial `ws://` LAN or Tailscale. Use Relay or `wss://`.
- Browser trust is per browser profile. Cleared site data means a new
  sign-in and adoption.

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
