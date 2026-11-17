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

- **A connected computer.** The adapter sends sync remote commands, file
  requests, and chat and terminal streams to that computer's brain. The route
  order is LAN, Tailscale, then Relay. The hosted HTTPS page cannot dial
  `ws://`, so Relay is normally the only route. Local `http:` pages can use
  the direct routes.
- **ADE Cloud.** The account server (the account-directory Worker) and GitHub
  answer every read. A read never wakes a cloud computer. An action (send a
  message, run a terminal, open a changed file, a Git action) wakes the
  lane's computer, and the UI does not wait for it.

Hosted Relay connections need the browser and the machine on the same ADE
account. The browser sends a fresh, short-lived account proof with each paired
Relay hello and never stores that proof. Sign-out stops the Relay connection
and removes the environments that the account directory created.

The hosted client uses web keyboard defaults for shortcuts that browsers
reserve: `Mod+J` toggles tools, `Mod+Shift+O` opens a new chat, ``Ctrl+` ``
moves to the next project tab, and `Ctrl+Shift+~` moves to the previous tab.
User overrides take precedence.

The browser cannot read or change Passwords (the account vault). Web Settings ›
Passwords shows only: "Open ADE desktop or the iPhone to see and change
Passwords. Agents on every computer, ADE Cloud too, still use them." File and
folder drops into the editor, and **Open externally**, are desktop-only.

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
- `apps/desktop/src/renderer/webclient/adapter/federated.ts` -
  `accountAnsweredAdapterFor` is checked first in `adapterForBinding`, so an
  account-answered pin never connects to a computer. `adeCloudOverrides` adds
  `window.ade.adeCloud`, and `cloudQueueOverrides` adds the queue send.
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
  each online copy of the repository. The cloud rows that the page already
  loaded match in the Work list. Nothing extra is saved for search.

Build and static host:

- `apps/desktop/package.json` - `dev:webclient` and `build:webclient`. The
  production build runs `check-webclient-entry.mjs` after Vite succeeds.
- `apps/desktop/vite.webclient.config.ts` - Vite build for the hosted SPA.
  Renames `webclient.html` to `index.html`, writes to
  `apps/desktop/dist/web-client`, and copies Cloudflare Pages files into the
  output root. It relies on Rollup's normal graph splitting instead of forcing
  the desktop renderer's heavy vendor groups into eager module preloads; the
  shared renderer's dynamic imports remain the feature-loading boundaries.
- `apps/desktop/src/renderer/public/scene-frame.html` - the page a chat scene loads in on the hosted client. `_headers` gives it the scene policy in place of the app's (and lifts `X-Frame-Options`), because a `blob:` scene document inherits the app's policy and its scripts never run. `SceneFrame` posts the scene document to it on request.
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
  `script-src` and `frame-src` allow `https://challenges.cloudflare.com`:
  Clerk's sign-up bot check (Cloudflare Turnstile) runs inside ADE's own
  sign-in card.
- `apps/desktop/src/renderer/webclient/public/_redirects` - SPA fallback:
  `/* /index.html 200`. A static file wins over this rewrite.
- `apps/desktop/src/renderer/webclient/public/_worker.js` and `_routes.json` -
  a Pages worker for `/assets/*` only. A deploy removes the old build's chunks,
  and the SPA fallback would answer a removed chunk with `index.html`, as 200
  and with the one-year immutable cache. The worker answers it with a 404 and
  `Cache-Control: no-store` instead. An open tab from the old build then gets a
  plain load failure, and `lib/staleChunkReload.ts` reloads it once. The worker
  sets the `/assets/*` cache headers itself. If its own code throws, it
  returns the static answer unchanged. `_headers` and `_redirects` still apply to every other path.
  `npx wrangler@4 pages dev apps/desktop/dist/web-client` runs it on this
  machine.

Browser sync client:

- `apps/desktop/src/renderer/webclient/account/client.ts` - Clerk
  OAuth authorization-code + PKCE session for the static client. The refresh
  credential, the last access token with its expiry, and the exact OAuth
  issuer/client identity persist in IndexedDB. A reload within the stored
  access token's life reads the directory with it and skips the refresh and
  the profile read; when the directory turns that token down, boot refreshes
  once and reads again. Without a usable token, boot refreshes before
  directory access. Profile identity is enriched through a bounded, best-effort
  OAuth userinfo request. The callback is scrubbed from the address bar before
  directory loading, and account requests use exact trusted origins with omitted
  browser credentials and referrers.
- `apps/desktop/src/renderer/webclient/account/clerkFrontendApi.ts` - a small
  client for Clerk's Frontend API: environment, client, sign-in and sign-up
  with an email code, OAuth start, session list. It follows clerk-js's wire
  rules (form bodies, `credentials: "include"`, only GET/POST with `_method`,
  a pinned `__clerk_api_version`) instead of shipping the ~570 KB SDK. A
  development instance has no cross-site cookies, so it carries a dev-browser
  id in `__clerk_db_jwt`, also on the authorize navigation
  (`decorateNavigationUrl`).
- `apps/desktop/src/renderer/webclient/account/clerkCaptcha.ts` - Clerk's
  sign-up bot check, Cloudflare Turnstile run the way clerk-js runs it. A
  "smart" widget renders into the card's captcha slot and shows only when
  Cloudflare wants a click.
- `apps/desktop/src/renderer/webclient/account/useClerkSignIn.ts` - the card's
  sign-in steps (loading, "Continue as", form, code, finishing) and the OAuth
  return (`/sign-in/return`), which mirrors clerk-js `_handleRedirectCallback`:
  a complete sign-in, an existing account that came through sign-up, and a new
  account from Google / GitHub / Apple. `fresh` (the person signed out) ends
  the browser's Clerk session first and asks Google and GitHub for their
  account picker.
- `apps/desktop/src/renderer/webclient/account/sessionStore.ts` - versioned
  IndexedDB session record: the refresh token, and the last access token with
  its expiry (absent in a record saved by an older build).
  `usablePersistedAccessToken` returns the stored token only while it has more
  than the given skew to live. Explicit sign-out and confirmed auth expiry
  clear the record.
- `apps/desktop/src/renderer/webclient/linkStatus/main.ts` and
  `link-status.html` - the hidden `/link-status` page that the link page
  (`apps/web` `OpenPage.tsx`) frames. It reads the account's online computers
  with the stored access token only and never refreshes the session, because
  the refresh token rotates on every use. It posts one `ade-link-status`
  message (signed in, and the names of the online computers or null) only to
  the ade-app.dev origins, and `_headers` allows only those origins to frame
  it.
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
  Terminal input waits for each frame's acknowledgement. Keys typed meanwhile
  for the same session join the next unsent frame (at most 16 KB). A frame
  that was sent once never changes, so a retry resends its id with the same
  bytes. `isRetryingDial` tells a dial round that failed and retries apart
  from a refusal. The project in front belongs to this browser, not to the
  brain. A brain that restarts on its own default project, or that another
  client moves to another project, does not move the browser: the client keeps
  its project and its chat and terminal streams, and sends a
  `project_switch_request` for its own project again
  (`ensureHostOnOwnProject`). It sends at most one such request per 15 seconds,
  so two clients that show different projects of one computer do not keep
  moving it. A request inside that gap runs when the gap ends.
- `apps/desktop/src/renderer/webclient/sync/connection.ts` - WebSocket
  lifecycle, account adoption, paired hello, DPoP proof on reconnect,
  heartbeat, reconnect/backoff, project catalog chunks, and auth-failure
  attribution, with one correlation id spanning directory lookup and route
  attempts. DPoP/token preparation begins in parallel with the socket dial;
  transport open and authenticated hello have separate 8-second and 12-second
  deadlines. A direct route that comes before the last good route in the dial
  order gets 3 seconds to open (ADE Relay always gets the full 8), and a
  project switch dials the route that was live first
  (`AdeSyncClient.connect`'s `firstEndpoint`). Relay authorization is renewed in place ahead of expiry even
  while the tab is hidden, so background timer throttling does not turn a
  healthy socket into a reconnect loop. Relay sockets negotiate ready-v2
  first: no ADE hello is sent
  before `accepted` then `ready`; an old Worker that does not send `accepted`
  within the short negotiation window is retried on a fresh legacy socket,
  never downgraded in place. While the page is visible, a 15-second watchdog closes a socket
  after 75 seconds without inbound traffic; returning to a visible stale tab
  bypasses accumulated backoff. Relay application close codes are translated
  into stable offline/capacity/retry messages instead of exposing raw reasons.
  A rejected hello is classified from the host's structured `hello_error.code`,
  and only a genuine pairing rejection is allowed to reach the `auth_failed`
  status that `WebMachineSessionManager` reads as "invalidate this
  environment". `account_session_changed` is transient — surface it and keep
  reconnecting. `host_update_required` is not — stop dialing
  (`shouldReconnect = false`) but keep the pairing and show the host's own
  message, so the displayed fix is "update ADE on that machine" rather than
  "pair again". See
  [the `hello_error` code table](../sync-and-multi-device/README.md#hello_error-codes-are-the-contract-the-message-is-not).
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
  the WebCrypto `CryptoKeyPair`, the separate account-session object store, and
  the schema-version-3 `catalogs` store. That store holds each machine's last
  seen project catalog keyed by `machineCatalogKey`, plus the last-active
  machine key in `meta`, so recents can paint before any connection exists. It
  is a paint cache and is bounded like one: at most 8 machines and 24 projects
  per machine, oldest machines evicted in the same write transaction, and icon
  data URLs over 24,000 characters dropped rather than stored. Each record
  carries its `ownerUserId`, and `pruneMachineCatalogs` deletes another
  account's records on the same boot step that prunes its environments.
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
- `apps/desktop/src/renderer/webclient/sync/projectHostRecoveryStore.ts` - the
  browser's project-host readiness state, fed by `hello_ok.projectHost` and by
  every `host_unavailable` command failure `CommandCaller` forwards. It holds
  one phase (`ready` / `retrying` / `takeover` / `recovering`), runs the shared
  2 s / 4 s / 8 s silent-retry ladder over `sync.diagnoseHost` before taking
  the screen, and calls `sync.recoverHost` for **Fix connection**. It is bound
  to exactly one client at a time: `bindProjectHostRecoveryClient` in
  `sync/client.ts` follows the active machine session, because the repair it
  offers terminates a process on the host and must only ever reach the machine
  on screen. A socket drop clears what is displayed but keeps the binding — a
  repair that restarts the brain drops the socket on purpose, so the
  `recovering` phase survives it and the next hello decides the outcome.
  Disposing a background session never disarms the active one.
- `apps/desktop/src/renderer/components/app/ProjectHostRecoveryScreen.tsx` -
  the full-surface recovery card and the `ProjectHostStartingBanner` that
  precedes it, both mounted by `App.tsx` only in web mode. The card names the
  owner, the project, and what stopping it interrupts, keeps raw PIDs and
  socket paths in the technical fold, and renders the host's repair steps in
  past/present tense as they complete. **Retry stays enabled during a repair**
  on purpose: a restart that never reports back would otherwise leave the card
  an inert spinner, so an explicit tap ends the "a repair is running"
  assumption and re-diagnoses. Switch Mac is available at every moment,
  including mid-repair. The banner keeps the cached lists on screen and is the
  one place that marks them as possibly out of date.

Browser `window.ade` adapter:

- `apps/desktop/src/renderer/webclient/adapter/index.ts` - installs a
  sync-backed `window.ade` surface, including the browser account client, and
  hides native-only capabilities. A project rebind creates an explicit project
  boundary: it drops old terminal subscriptions, clears command-read caches,
  binds the newly selected id, and fans a full-domain invalidation out before
  the reused renderer can hydrate stale project data.
- `apps/desktop/src/renderer/webclient/adapter/misc.ts` - the small
  namespaces, including the two Work-tools ones. `workTools` is a read-only
  mirror: `getLaneState` and `readObservationPreview` are real remote
  commands, and `setActiveTool` is a deliberate no-op, because publishing
  which tool is open is the privilege of the surface that actually has one
  and a web tab echoing its own picker would overwrite the desktop's truth on
  every phone. `builtInBrowser` is an unavailable stub with two exceptions
  whose *shape* is load-bearing: `getStatus` returns a real, empty
  `BuiltInBrowserStatus` (the Work tools pane and the corner card read
  `status.tabs`), and `getDevServers`
  returns an empty list because dev-server discovery reads this machine's PTY
  output and a web tab has none. Everything else in the namespace is
  deliberately absent so a caller feature-detects instead of getting a fake.
- `apps/desktop/src/renderer/webclient/adapter/providerAccounts.ts` - the host's
  Claude and Codex logins, backing the web-only **AI accounts** card
  (`agents.accounts`, the `providerInstances` namespace). Each member forwards to
  the host's `providerAccounts.*` command (which runs the `provider_instances`
  action) and unwraps its `{ instance }` / `{ login }` envelope into what the
  desktop bridge returns. Reads may be answered from the last good reply while
  the host is away; a change, or a running sign-in's status, goes to the host
  every time. `loginCommand` and `setAccent` stay absent — a browser cannot run
  the host's shell command, and no account screen offers a colour any more. A
  host older than these commands rejects, and the panel shows its error rather
  than an empty list that looks like "no accounts".
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
- `apps/desktop/src/renderer/webclient/adapter/account.ts` - maps the browser
  OAuth session and account directory onto the reused `window.ade.account`
  contract for status, sign-in/out, machine listing, and machine removal.
- `apps/desktop/src/renderer/webclient/adapter/attention.ts` - account-first
  Attention adapter. Signed-in reads/ACKs/presence/preferences go directly to
  the Clerk-authenticated push relay and are fenced to the owner that loaded
  the snapshot, so the selected project or paired machine cannot block the
  account view. Signed-out legacy environments may read/acknowledge only their
  explicitly paired host through `attention.getMachineSnapshot` and
  `attention.acknowledgeMachine`; unsupported older hosts surface update
  guidance rather than an invented empty snapshot. Its relay polls back off on
  failure with jitter, so several surfaces polling the same dead relay do not
  resynchronize into one thundering retry. Network-level failures (a rejected
  CORS preflight, DNS, the socket) are caught alongside status codes, because
  they carry no response to inspect; 5xx and 429 back off as transient and
  other 4xx back off faster, since neither is going to be served until
  something changes. The backoff silences the fixed-interval pollers only — a
  user who just clicked something still gets their attempt, and a success
  resumes polling immediately.
- `apps/desktop/src/renderer/webclient/adapter/analytics.ts` - browser-local
  analytics preference (collection is on unless the browser opted out),
  runtime-scoped status/capture calls, and per-connection preference
  reassertion. A failed opt-out acknowledgement closes the sync connection so
  the host cannot keep recording exportable web mutations for that peer.
- `apps/desktop/src/renderer/webclient/adapter/infra/commandCaller.ts` -
  remote-command dispatch through `SyncRemoteCommandDescriptor` scope/policy,
  with fallback for unsupported hosts. Every idempotent read joins an identical
  in-flight relay request (authoritative reads keep their own key). Only the
  host's answer is shared: a failure reaches every caller and each applies its
  own fallback. Reads that pass `cacheTtlMs` also keep the resolved value for
  that window. A write (`idempotent: false`) clears its namespace's in-flight
  and retained reads and last-good fallbacks when it settles, and a read that
  was in flight across a write does not store its answer as a fallback.
  `invalidateCache` clears the whole cache or a set of action prefixes so a
  sync-driven refresh drops stale reads.
- `apps/desktop/src/renderer/webclient/adapter/infra/bootPriority.ts` - on a
  page that opens on a chat, heavy startup reads (usage, model catalog,
  provider status and similar) wait until the chat history paints, until the
  session list shows no chat, or for at most 12 s. Writes never wait.
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
  Routing is an exhaustive `TABLE_DOMAINS` map plus a `SILENT_TABLES` set and a
  few prefix rules, not substring matching (a substring rule would let a
  `lane_worktree_locks` heartbeat clear the Files read cache). An unrecognized table still falls back to the
  `UNCLASSIFIED_TABLE_DOMAINS` set rather than going silently stale.
  `runtime_processes` is mapped to `sessions`, but it is local-only: it is in
  `LOCAL_ONLY_CRR_EXCLUDED_TABLES` (`state/kvDb.ts`), has no change-tracking
  clock or triggers, and writes nothing to `crsql_changes`. The 5-second
  process heartbeat therefore never produces an `invalidation_batch`, and
  `sessions` refetches come only from real session-table writes.
- `apps/desktop/src/renderer/webclient/adapter/appControl.ts` - the App Control
  namespace on web, watch only. `getStatus` and `onEvent` read the lane's session
  from `appControl.status`; `holdFrames` and `streamSubscribe` deliver the
  lane's JPEG screencast frames. Every call that would drive the app (click,
  type, observe, launch, connect, stop, and the rest) rejects with "App Control
  runs on the desktop. From here you can only watch it." Status is polled while
  a listener exists: every 3 s, backing off to 15 s while the session is
  unchanged, paused while hidden, read at once when visible.
- `apps/desktop/src/renderer/lib/pageVisibility.ts` - the
  `document.visibilityState` helper the relay pollers use. Without a `document`
  (Node tests) the page counts as visible.
- `apps/desktop/src/renderer/webclient/adapter/runtimePinGuard.ts` - the
  guard for runtime pins. One web adapter speaks to one machine and one bound
  project. `assertWebRuntimePinRoutable(operation, pin, scope)` runs at every
  pinned member (`agentChat.ts`, `files.ts`, `git.ts`, `lanes.ts`, `prs.ts`,
  `sessionsPty.ts`), and each takes `RuntimePinArg`.
  - A pin that names this adapter's own machine and project goes on unpinned
    (the Chats page's pinned `pty.create` is the common case).
  - A pin for the same machine but another project throws, so it is never
    answered for the wrong project.
  - A `kind: "local"` pin throws "This chat runs on a machine ADE Web can't
    reach directly."
  - The machine match compares `pin.targetId` with
    `client.getStatus().selectedEnvId`; on the web a target id is an
    environment id. The guard reads the fields, never a split of the binding
    key.
  - Account-answered pins (ADE Cloud, `cloud-saved:`) never reach this guard:
    the federated adapter sends them to the account adapter first.
- `apps/desktop/src/renderer/webclient/adapter/files.ts` - browser file API
  over sync `file_request`; no local file watcher. List reads
  (`listWorkspaces` / `listTree` / `listTreeChildren`) are coalesced through a
  3 s read cache and **show transport errors**. An empty answer would read as
  an empty tree. `readFile` and the write helpers reject like the desktop
  host, so a failed read never looks like an empty file and a failed write
  never marks a tab saved. Cache
  keys are structured (project, action, workspace, scope path, stable args)
  instead of substring-matched, so a write evicts by scope rather than clearing
  everything: other workspaces survive, `listWorkspaces` always survives
  because a file write cannot change the workspace roster, and
  `listTreeChildren` loses only the ancestor listings of the changed path plus
  its descendants (for a directory rename or delete). `filesInvalidated` events
  still clear the whole cache and fan a path-less change event out to every
  workspace id seen for the project rather than a single `"*"` marker — the
  workbench absorbs that with its own full-refresh throttle. Its synthesized
  events carry `origin: "self"`, which is how the workbench knows not to
  re-read the bytes it just wrote.
- `apps/desktop/src/renderer/webclient/adapter/remoteRuntime.ts` - a
  single-machine adapter fallback for native-only remote-runtime operations.
  The federated adapter overrides its target, connection, project, connect,
  park, and forget methods with browser-session-manager state. SSH discovery,
  desktop-local pairing hosts, and native target editing remain unavailable.
- `apps/desktop/src/renderer/webclient/adapter/prs.ts` - PR namespace over
  remote commands. List/detail reads go through the 3 s read cache, and a
  `prsInvalidated` event invalidates
  the `prs.` cache, then hydrates one coalesced aggregate snapshot
  (`prs.getMobileSnapshot`, falling back to `prs.list`) and emits `prs-updated`
  only when the host actually returned a snapshot. `listAll`, `getForLane`, and
  the non-conflict `listWithConflicts` are all derived from that one batched
  snapshot instead of separate per-call round-trips. The PR writing helpers
  call the machine too: `updateDescription` (`prs.updateDescription`, or
  `prs.updateBody` on a machine without it), `searchMentionables` and
  `getRepoReferences` behind the reviewer picker and the @ / # menus. A machine
  without the two reads says "Update ADE on that computer…" rather than
  answering an empty list.
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
  the optimistic overlay for session lifecycle writes (settle, snooze, wake).
  The browser has no database, so each write is a round trip. A
  `SessionLifecyclePatch` holds only the lifecycle columns (`settledAt`,
  `settleOverride`, `snoozedUntil`, `snoozedAt`, `wokeAt`, `wokeReason`), never
  a derived phase. It retires in one of three ways: **reconciled** (a host
  row already shows the intent), **rejected** (the host refused; the row
  snaps back and the error shows), or **expired** (a hard TTL). The match
  compares presence (set or cleared), because the host owns the timestamps.
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
  - `applyHostedWebZoom` puts CSS zoom on `<body>` and divides the body's
    width and height by the factor, so the zoomed box is one viewport. At
    identity zoom the body stays `height: 100%`. It runs at install and on
    `AppShell` mount, so a reload paints at the user's zoom.
  - `personalChats.ts` calls runtime-scoped `personalChats.*` actions
    (`requireProject: false`) and subscribes transcripts with
    `chatScope: "personal"`.
  - `lanes.ts` passes `getBranchDrift` and `resolveBranchDrift` to the
    `lanes.*` commands.
- `apps/desktop/src/renderer/webclient/adapter/githubStub.ts` - the whole
  `window.ade.github` namespace for the web client, split out of `misc.ts` so a
  renderer can import the stub's own declaration rather than pattern-match its
  shape. Reads a paired machine can serve are routed to it; everything needing a
  machine of its own answers with a stub that says so. The GitHub App account
  credential is the important one: a hosted-web build has no machine to hold it,
  so `getAppUserAuthStatus` answers `GITHUB_APP_USER_AUTH_UNSUPPORTED`, which
  carries `appUserAuthSupported: false` **and** an honest `credentialState`.
  Renderers gate on that flag through `isGithubAppUserAuthSupported` rather than
  inferring a stub from missing fields.
- `apps/desktop/src/renderer/webclient/adapter/federated.ts` - the hosted
  workspace router for `window.ade`. It persists the welcome/Chats/project
  surface (the stored value `activeSurface: "hub"` means the welcome page),
  open remote project bindings, and the selected machine per account; restores
  those bindings at boot; and dispatches project-scoped calls to an adapter
  keyed by the exact machine + project binding. An account-answered binding
  (ADE Cloud, or a `cloud-saved:` copy) gets the account adapter and never
  connects to a computer. Remote bindings passed as
  control arguments pin delayed callbacks and subscriptions to their
  originating project even after the visible tab changes. Switching the active
  adapter notifies `WebClientRoot`, which remounts the shared renderer so
  unpinned long-lived subscriptions cannot remain attached to the prior
  machine. Account-wide members (`usage.getAdeStats`,
  `usage.getGithubContributions`, `usage.onUpdate`, and every `cloud` and
  `cloudAccess` member) go to a connected computer when the displayed adapter
  is a disconnected fallback, and their subscriptions move with the adapter
  that serves those reads. So the Connections panel keeps the cloud status and
  Wake while the computer that dropped is still the displayed one. With no
  computer connected, the account server answers `cloud` and `cloudAccess`
  (`adapter/cloud.ts`), and the top bar's Settings opens Settings on its own.
- `apps/desktop/src/renderer/webclient/adapter/reconnectHold.ts` - keeps a
  machine that was connected reading as connected for up to 30 s of time in
  front while its connection comes back, so Work keeps the open chat after a
  suspended tab returns. A first connect, a refusal and a parked machine are
  not held. Time in the background does not count. A spent hold is gone until
  the machine connects again.

Browser shell and routes:

- `apps/desktop/src/renderer/webclient/main.tsx` - installs the pending
  `window.ade` placeholder before shared renderer modules import, then mounts
  `WebClientRoot`.
- `apps/desktop/src/renderer/webclient/shell/WebClientRoot.tsx` - boot
  sequence, retired-route scrubbing, account privacy pruning, account-first
  30-second active-account lease monitor, IndexedDB environment restoration,
  catalog hydration, federated-adapter installation, pending `/open` target
  stash, and initial project/Chats restoration. Both retired routes, `/pair`
  and `/hub`, are replaced in history before anything else runs; ordinary
  visits land on `/work`, where the shared App renders the project welcome
  surface because no project is open. Account bootstrap, catalog pruning, and
  environment privacy pruning finish before saved environments are published,
  so stale async loads cannot expose another account's records or project
  names. When nothing is restored, the last-active machine is dialed *after*
  first paint, never as a gate on it. Storage failure leaves account sign-in
  and the account directory usable and is surfaced as a non-fatal notice.
  Session-lifecycle chrome follows the client currently assigned to the active
  machine rather than the bootstrap client.

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
  browser machine-session owner. It merges saved environments with live
  clients, serializes admission, deduplicates same-target connects, retains
  project catalogs for parked machines, and exposes Live, Reconnecting, Parked,
  and Offline states. The pool owns at most four `AdeSyncClient` instances. A
  fifth connection parks the least-recently-used non-active session, disconnects
  it, and returns that client object to the pool; selecting the parked machine
  reconnects it on demand and parks the next eligible LRU session. It also owns
  the catalog cache: `hydrateCatalogs` loads the persisted records at boot, every
  live catalog frame is written through to IndexedDB, a successful connect
  records the last-active machine key, and forgetting a machine drops its cached
  catalog. The optional store is injected, so a manager without browser storage
  simply runs without the cache. A `background` connect (a repository tab
  joins every computer with a copy) never parks another machine for room and
  skips a machine the person disconnected (`disconnectByUser`). That choice is
  kept in `localStorage` across reloads, and the person's own connect clears it.
  A person's connect that finds a background connect in flight waits for it and
  then runs its own.
- `apps/desktop/src/renderer/webclient/workspace/machineIdentity.ts` - the
  `machineCatalogKey` identity (`device:<hostDeviceId>`, falling back to the
  environment id) shared by the catalog store, the session pool, and the
  pre-project UI. It is a dependency-free leaf module on purpose: the shared
  desktop components that render these surfaces import the model, and that
  import must never drag the sync client into the desktop bundle.
- `apps/desktop/src/renderer/webclient/workspace/webWorkspaceModel.ts` - the one
  model behind both pre-project surfaces. `mergeWebMachines` folds the account
  directory, browser-saved environments, live sessions, and persisted catalogs
  into one row per physical machine; status comes from
  `accountMachineConnectionState`, not from whether this tab holds a socket, so a
  machine with a verified relay route reads **Available** rather than Offline.
  `webConnectStage` maps the connection lifecycle to the honest stage the UI
  shows (Dialing relay / Authenticating / Loading projects), and
  `webRecentProjects` projects every known catalog into the shared
  `RecentProjectSummary` shape the desktop welcome page already renders.
- `apps/desktop/src/renderer/webclient/workspace/WebWorkspaceContext.tsx` -
  shared account, directory, session-pool, federated-adapter, notice, machine
  management, and deferred-deeplink actions used by the hosted workspace.
  `connectMachineEntry` connects whichever route a merged row has - saved
  browser pairing first, account adoption otherwise - and resolves its live
  target id; `forgetMachineCatalog` drops a machine's cached projects.
  `useOptionalWebWorkspace` is how shared desktop components ask whether they
  are running inside ADE Web instead of assuming.
- `apps/desktop/src/renderer/components/app/ConnectionsPanel.tsx` (hosted
  mode) - ADE Web uses the desktop Connections chip and panel: the account
  header and the machine list, without the This computer card, the pairing
  code, or the Phone and Web tabs. **Connect** on an account machine connects
  it through the tab's `WebMachineSessionManager`, and reuses a pairing this
  browser saved when it has one. When the tab already holds
  `WEB_MACHINE_SESSION_LIMIT` machines, the panel says so. The panel loads that
  limit on demand, so the desktop bundle never pulls in the hosted workspace.
  Pages outside the top bar open the panel with the
  `ade-web:open-connections` window event.
- `apps/desktop/src/renderer/webclient/shell/ScreenShell.tsx` and
  `shellTokens.ts` - the minimal startup/error frame and standalone shell design
  tokens. Machine and project selection live inside the reused app shell's
  welcome surface, connections chip, and tab strip rather than a separate
  pre-app picker.
- `apps/desktop/src/renderer/webclient/shell/sessionLifecycleChrome.ts` -
  web-only presentation for the session-lifecycle controls, installed from
  `WebClientRoot` for the active machine client. The Work list
  is the desktop component mounted verbatim, and it reveals a row's snooze
  control on pointer hover; a phone or tablet never produces hover, so on the
  web that control would be unreachable. Both that and the unsupported-host case
  are web-shell concerns rather than component concerns, so they are handled with
  one injected stylesheet keyed off a single attribute on `<html>`:
  `data-ade-session-lifecycle="ready" | "unsupported"`. Under
  `@media (pointer: coarse)` the snooze button becomes a 2rem touch target with
  `opacity: 1`, the row's `pointer-events-none` action wrapper is re-enabled, and
  the snooze duration menu rows get a 44px minimum height (the row count varies
  with the time of day — see `resolveSnoozePresets`).
- `apps/desktop/src/renderer/webclient/shell/webRoutes.ts` - thin web route
  layer over `apps/desktop/src/shared/deeplinks.ts`. A `lane-share` link maps
  to `/shared?grant=<id>`, the shared lanes page, which needs no machine of the
  browser's own.
- `apps/desktop/src/renderer/webclient/sync/relayReady.ts` - ADE Relay's
  `ready=2` socket handshake (`accepted`, then `ready`) for every browser-side
  socket to `wss://<relay>/connect/<machineKey>`: the paired sync connection
  and the lane share guest connection.
- Lane sharing in the web client: the guest's side works (the `/shared` page,
  the shared lane view and the guest connection, with
  `laneShareGuest` account calls through `account/client.ts`), and the owner's
  side does not (the adapter's `laneShare.*` answers `lane_share_desktop_only`,
  and Settings › Sharing is hidden). See [lane sharing](../lanes/lane-sharing.md).

Reused desktop renderer (web-mode adaptation):

- `apps/desktop/src/renderer/lib/webClientMode.ts` - `isWebClientMode()` reads
  the `window.__adeWebClient` flag the bootstrap stamps before the App module
  loads, and `WEB_CLIENT_TAB_PATHS` lists the only surfaced tabs
  (`/work`, `/lanes`, `/files`, `/prs`, `/chats`). There is no hosted-only
  landing route: the pre-project surface is the shared welcome page on `/work`.
  `isCssZoomedBrowserSurface()` is true for the hosted client and the Vite
  `browserMock` preview so `AppShell` fills the inverse-sized body with
  `h-full` instead of `100vh`. Desktop-only chrome
  (`AppShell.tsx`, `TopBar.tsx`, `projectSidebar/`, `OnboardingBootstrap.tsx`)
  reads the web-client flag to hide native window
  controls, the updater, the onboarding tour, and tabs with no sync-protocol
  backing instead of rendering broken affordances.
- `apps/desktop/src/renderer/lib/webZoom.ts` - hosted-web stand-in for
  Electron `webFrame` zoom. Inverse-sizes `<body>` then applies CSS `zoom` so
  the used box is one viewport.
- `apps/desktop/src/renderer/lib/fixedMenuPlacement.ts` - `position: fixed`
  menus that open above an anchor use `top` plus `translateY(-100%)` so
  vertical math never mixes `window.innerHeight` with a CSS-zoomed rect.
- `apps/desktop/src/renderer/components/activity/HeaderActivityControl.tsx`
  and `ActivityPane.tsx` - the project-independent header popover and the
  expanded pane its "Open all" raises: one `ActivityPanel` in two sizes, grouped
  by the Work board's four columns exactly as on desktop. Activity is a global utility surface, not
  another selected-machine tab, so it is intentionally separate from
  `WEB_CLIENT_TAB_PATHS`. Its `/activity` pathname (and the `/attention` name it
  replaced) is a deep link that opens the pane over the current tab; both are in
  `APP_ROUTE_ROOTS` so a hard reload keeps it.
- `apps/desktop/src/renderer/components/app/TopBar.tsx` and
  `ConnectionsPanel.tsx` - the single desktop Connections control and its
  Machines, Phone, and Web tabs. The Web tab reports connected browser peers
  and directs signed-out users to account sign-in. In hosted mode, `TopBar`
  renders the same chip and panel with the hosted sections only (see
  `ConnectionsPanel.tsx` above), and logical repository tabs in the tab strip. Checkouts with the same repository origin
  collapse into one tab; when that repository exists on multiple machines, the
  machine becomes a compact selector inside the tab. Parked and offline bindings
  remain visible and reconnect when chosen. A computer that leaves this tab
  never closes a tab (`moveWebTabsOffGoneTargets`): it was forgotten or removed
  (it leaves the connection list), or it stopped (still listed, not connected
  3 s after the reconnect hold reports it; a project open passes through
  "idle" for a moment). Each of its tabs moves to a copy on another connected
  computer and keeps its place in front. A tab with no other copy moves to ADE
  Cloud (`useWebTabsFollowComputers.ts`). When a stopped computer connects
  again, its tabs move back to their copy there.
- `apps/desktop/src/renderer/components/onboarding/LaunchGate.tsx` - the launch
  gate, split into a web variant and a desktop variant so neither constrains the
  other. The web variant gates on account state alone and offers no way past it:
  signed in renders the app, signed out renders `WebSignInGate` (the
  `GlassSignInCard`) with no skip button. The hosted shell's own boot path
  renders the same card through `WebSignInScreen` before `LaunchGate` exists
  (see `WebClientRoot.tsx` above). With a Clerk configuration the card runs
  the whole Clerk sign-in itself (`ClerkSignInPanel`, below) and then a
  full-page OAuth redirect that Clerk completes at once, so there is no
  polling phase to survive. The desktop app's gate keeps its one button, which
  opens ADE Web's `/sign-in` page.
- `apps/desktop/src/renderer/components/onboarding/ClerkSignInPanel.tsx` -
  ADE's own Clerk sign-in inside the glass card: "Continue with" Google,
  GitHub and Apple, an email code, sign-up for a new email, and "Continue as"
  when the browser already holds a Clerk session. When Clerk cannot be reached,
  or the sign-in needs a step the card does not show (a second factor), it
  hands back to the card's one button, which opens Clerk's hosted page. A
  fallback that is not a second factor is a Sentry warning
  (`clerk_sign_in_unavailable`).
- `apps/desktop/src/renderer/components/onboarding/GateBackdrop.tsx` - the
  backdrop behind the card. On ADE Web a visitor who never picked a scene sees
  the shipped "Mountain vista" picture (`useActiveScene({ untouched })`); a
  picked scene always wins. The desktop gate keeps its shuffle.
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
  home dashboard's hero and cards, shared by desktop and web. Each card answers
  one question at a glance (what is running, this machine's activity, its live
  limits and the machines, and the open project's pull requests), links to the
  full surface, and reads state the renderer already holds; the PR card reads the
  same GitHub snapshot the PRs tab reads through `prReadCache`.
- `apps/desktop/src/renderer/components/projects/ProjectWelcomeWebRows.tsx` -
  the recents-row chrome: project artwork, the **N machines** chip and its
  menu (each machine's state, and open there), worktree/lane badges, and
  relative activity.
  Every export is driven entirely by its props, which is what keeps the welcome
  page's own body readable as page logic rather than row markup.
- `apps/desktop/src/renderer/components/projects/ProjectWelcomeWebNotices.tsx` -
  what the hosted welcome surface says when the machine list did not load.
  `webZeroMachinesNotice` is a pure function of the account snapshot. Its
  `kind` is `loading`, `signed_out`, `unconfigured` or `unavailable`. An
  account with no computer is not an error: it has ADE Cloud. The failure
  kinds carry a `reassurance` line (the machines and their projects are
  untouched; only the list failed to load).
- `apps/desktop/src/renderer/components/settings/WebScopePill.tsx` - the
  per-section scope line in Settings. On the desktop "where does this setting
  go" has one answer; in the browser it has three - the connected machine, the
  ADE account, or this browser's local storage alone - and which one is not
  guessable from the control, so every web-visible section opens by saying
  which. Scope comes from `sectionWebScope` in `settingsManifest.ts`, and
  sections scoped `hidden` are not rendered in web at all. Desktop renders
  sections exactly as before: no banner, no wrapper.
- `apps/desktop/src/renderer/webclient/workspace/useWebChatsMachines.ts` - the
  Chats page's machines in the browser. The rail lists the chats of every live
  machine (`liveMachines`, by target id), and the federated adapter's
  `personalChats` override sends a call that names its machine to that
  machine's chats adapter. The picker beside the composer chooses where a new
  chat runs: options are keyed by `machineCatalogKey` rather than target id,
  because a machine this browser has never dialled has no target id yet -
  selecting it connects first and hands the resolved target to `activateChats`.
  It returns null on the desktop.
- `apps/desktop/src/renderer/components/analytics/ProductAnalyticsLifecycle.tsx`
  - reused route/project lifecycle capture plus the hosted-web startup event.
  It sends only normalized inputs through `window.ade.analytics`; the browser
  client never talks to PostHog directly. There is no in-app consent prompt and
  no Settings control; a browser opt-out stored earlier is still honored.

Machine runtime and sync host:

- `apps/ade-cli/src/services/sync/syncHostService.ts` - sync WebSocket host,
  pairing/hello auth, DPoP enforcement, changeset fan-out, project catalog,
  project switch, file/chat/terminal sub-protocols, and command routing
  advertisement.
- `apps/ade-cli/src/services/sync/syncHostRecovery.ts` - typed project-host
  readiness and **Fix connection**. Hosted web reads `hello_ok.projectHost`
  and `host_unavailable` snapshots, retries a generic starting failure, then
  overlays the same recovery card as iOS (`ProjectHostRecoveryScreen`).
  Cached lists stay on screen; the overlay is not `ProjectRecoveryScreen`
  (that screen is local disk/brain repair). The repair itself is serialized and
  deadline-bounded on the machine, so a second browser tab joins the running
  one rather than opening a second stop/restart sequence. Parsing, the retry
  ladder, and the "why is there no Fix button" classification are the shared
  `apps/desktop/src/shared/syncHostRecoveryUi.ts` and
  `apps/desktop/src/shared/types/syncHostRecovery.ts`, which iOS mirrors.
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` - remote
  command registry. It carries the web-parity `register("...")` entries for
  Work, chat, terminal, files/git, PRs, project config, AI status, GitHub
  status, history, rebase, and safe smart-link preview surfaces.
  The legacy runtime-scoped
  `sync.getWebPairingInfo` descriptor remains in the protocol, but no current
  iOS or hosted-web UI uses it to create browser pairings.
- `apps/ade-cli/src/services/sync/productAnalyticsRemoteCommand.ts` and
  `syncHostService.ts` - bind untrusted browser capture requests to the host's
  `web` surface/project and keep `analytics.setClientEnabled` peer-scoped. A
  browser choice never changes the machine-wide desktop/runtime preference.
- `apps/ade-cli/src/services/sync/syncPairingStore.ts` - pairing result store:
  per-device secret, optional DPoP public key, and explicit local/account
  provenance (`accountOwnerUserId` plus the sticky `localTrustOrigin` flag) used
  for owner-scoped revocation. A same-account hello backed by a DPoP proof
  against the record's pinned key adopts a still-local pairing into the account;
  owner-scoped revocation demotes such records back to local trust instead of
  deleting them.
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
- `apps/desktop/src/renderer/components/lanes/LaneContextMenu.tsx` and
  `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` /
  `SessionContextMenu.tsx` - desktop "Open in web" entry points.
- `apps/web/src/app/pages/PairPage.tsx` - marketing-site landing for the smart-QR
  URL. A visitor here opened the QR URL on a device without the ADE app. The
  page reads nothing from `window.location` and points the visitor at the
  iPhone app, with a secondary "open the web client instead" link. The hosted
  client's own `/pair` route is scrubbed by `WebClientRoot` and opens sign-in.
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
- `apps/desktop/src/renderer/webclient/adapter/__tests__/adapter.test.ts` -
  sync-backed namespaces, including the non-null prompt-stash contract.
- `apps/desktop/src/renderer/webclient/adapter/__tests__/runtimePinGuard.test.ts` -
  the pin boundary: same-machine/same-project pins proceeding unpinned,
  same-machine/other-project and foreign-machine pins throwing, and the
  `kind: "local"` message.
- `apps/desktop/src/renderer/webclient/adapter/__tests__/federated.test.ts` -
  persisted welcome/Chats/project restoration, cross-machine and same-machine
  binding pinning, active-adapter transitions, and host-driven project changes.
- `apps/desktop/src/renderer/webclient/workspace/__tests__/WebMachineSessionManager.test.ts` -
  four-client admission, concurrent-connect bounds, LRU parking, parked resume,
  auth-failure cleanup, and project switching.
- `apps/desktop/src/renderer/webclient/shell/__tests__/webClientShell.test.tsx` -
  startup shell, retired pairing route, account privacy, welcome-surface boot,
  and StrictMode lifecycle coverage.
- `apps/ade-cli/src/commands/deeplinks.test.ts`.
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.test.ts`.

## Gotchas

- **ADE's sign-in card depends on two Clerk settings.** The Clerk OAuth app's
  consent screen must stay off: with it on, the authorize step after the card
  goes to Clerk's hosted consent page (and a development session is lost
  there). And Clerk's Frontend API shapes are read defensively by
  `clerkFrontendApi.ts`; a renamed field reads as missing, and the card falls
  back to its one button (Clerk's hosted page). After a Clerk API version
  change, run a real sign-in on the development instance (`npm run
  dev:webclient`, a `+clerk_test@example.com` address, code `424242`).

- **A `window.ade` member the web adapter lacks is a stand-in, not `undefined`.**
  `withFallbackProxy` (`adapter/infra/proxy.ts`) answers it with a callable so
  a direct call never throws synchronously inside an effect. Calling it rejects
  with `AdeUnavailableError` ("… is not available in the ADE web app"), and an
  `on*` member returns a no-op unsubscribe. It is still truthy and a function,
  so a feature check must use `isAdeAvailable(window.ade?.ns?.method)`
  (`lib/adeAvailability.ts`), never truthiness or `typeof`. An unhandled
  `AdeUnavailableError` from a fire-and-forget call is swallowed
  (`webclient/main.tsx`) and never reported to Sentry.
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
- **IndexedDB is the connection, refresh-session, and catalog store.** Clearing
  site data removes the account refresh credential, paired secrets,
  non-extractable DPoP private keys, and the cached project catalogs - which
  costs only the instant recents paint, since catalogs are rebuilt from the
  first live connection. The browser must sign in and
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
- **Analytics collection is on by default and honors a browser-local opt-out.**
  No consent prompt is shown and no Settings control writes the preference; a
  `"false"` in local storage from an earlier build still disables collection. The host
  keeps an in-memory consent bit for that paired socket and starts it
  disabled, so every adapter connection must reassert the local preference
  before capture. An opt-out is still fail-closed: a failed disable
  acknowledgement closes the connection rather than falling back to
  machine-wide consent. Accepted events still consume the host's shared
  200-event daily budget. See [logging and product analytics](../../logging.md).
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
- **A runtime pin the adapter cannot route must throw, not be dropped.** One
  adapter instance is one machine and one project, so silently ignoring a
  foreign pin turns a precise request into a read or write against the wrong
  runtime. Only a pin restating this adapter's own machine *and* project may
  proceed unpinned. Any new pinned adapter member takes `RuntimePinArg` and
  calls `assertWebRuntimePinRoutable` first.
- **Native-only surfaces must stay unavailable in the web adapter.** OS
  notifications, external editor open, reveal in Finder, local directory
  picking, native shells, computer use, built-in browser, iOS Simulator,
  updater, and transcription are not browser capabilities. App Control is the
  exception that is watch-only: its status and frames are served, and driving
  calls reject (see `adapter/appControl.ts`).
- **Build output shape matters.** Cloudflare Pages serves from the output root;
  `_headers`, `_redirects`, `_routes.json`, `_worker.js`, and `index.html`
  must sit directly inside `apps/desktop/dist/web-client`.

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
  v                                   v
AdeSyncClient pool                  Account adapter (adeCloudSyncClient)
                                      - account reader: account server + GitHub
                                      - saved chats, terminal copies, Git summaries
                                      - message queue; wakes run in the background
                                      - never dials a computer
  |
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

1. The operator opens `https://app.ade-app.dev`. The boot path renders the
   sign-in card (`WebSignInScreen`) and nothing else - there is no skip,
   because every byte this
   client can show arrives over account-authorized Relay. The card signs the
   browser in to Clerk on this page (email code, or Google / GitHub / Apple
   with a return to `/sign-in/return`), then starts ADE Web's OAuth PKCE
   sign-in, which Clerk completes at once because the session exists. The
   consent screen is off on ADE's Clerk OAuth app, so no Clerk page shows. Desktop's
   **Connections > Web** surface points to this account flow; it exposes no QR,
   link, PIN, or manual endpoint entry.
2. The browser loads the Clerk-scoped account machine directory and lands on the
   welcome surface, which lists recent projects across every known Mac. On a
   returning browser those recents paint immediately from the persisted
   catalogs, before any socket exists, and the last-active machine is dialed in
   the background to refresh them.
3. Selecting a Mac - or opening any project on it - captures the exact browser
   account-session generation,
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
7. Sign-out or account switch closes the Relay socket, removes account-owned
   environments, drops the other account's cached project catalogs, and returns
   the browser to the sign-in gate. Machine-side revocation closes connected
   browser sockets and makes future paired hellos fail. Sign-out also saves a
   "signed out by the user" marker in localStorage. The next sign-in ends the
   browser's Clerk session first, so it asks for an account instead of
   signing the same person straight back in; a completed sign-in clears it.

**Sign-in for a computer (`/sign-in`).** The desktop app and `ade login`
open `https://app.ade-app.dev/sign-in?continue=<authorize URL>` for ADE's
production Clerk app (`buildWebClientSignInUrl`; other configurations open
Clerk's page as before). The page runs the same card and then goes on to that
authorize URL, which returns to the computer's loopback listener. It accepts
only this client's issuer, `/oauth/authorize`, its own client id, and an
`http://127.0.0.1` redirect (the computer's listener binds only that); anything else loads ADE Web as
usual, so the page never forwards a browser elsewhere. The computer adds
`prompt=login` after its own sign-out; the page takes it off and treats it as
`fresh`. When the card falls back, its one button opens that same authorize
URL, `prompt` included, on Clerk's own page, so the sign-in still returns to
the computer. This browser's own ADE Web session plays no part. Release order: ADE
Web must deploy before a desktop build that opens `/sign-in`, or the old web
build shows its normal gate there.

**The `ade_signed_in` marker.** On sign-in ADE Web sets `ade_signed_in=1` on
`.ade-app.dev` (Path `/`, Secure, SameSite Lax, 30 days). It carries no token
and grants nothing. The landing site (`apps/web`) reads it on `/` to send a
signed-in visitor straight to ADE Web; `?home` skips that, and the account
panel's "ADE website" link uses it. Sign-out, an expired session, and a boot
that finds no session delete it, so nobody loops. Only pages served from
ade-app.dev write it (not localhost or the Pages preview URL). Its name and
rules are a contract with `apps/web/index.html`.

The hosted client has no pairing UI. Browser environments that were paired
locally before account-only pairing stay listed under **Saved on this
browser** and reconnect over their saved direct routes. New non-account web
pairings are not possible. The version-1 trust migration runs once on a
browser profile that has never completed it.

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

For an own computer, all project state flows through one of the bounded live
sync transports to that machine's runtime. For ADE Cloud, the account server
and GitHub answer reads (see *ADE Cloud reads* below). Only the active project
surface mounts in hosted mode, so background subscriptions from an inactive
project cannot dispatch through another machine's adapter.

## Account machine directory

ADE account sign-in is the only way to create a new hosted-web connection. The
shell loads the user's machines from the Clerk-verified account-directory Worker
and merges them with compatible browser-saved environments and persisted
catalogs in `mergeWebMachines`. The directory's
`online` value is a 90-second
publisher-presence lease, not proof that a validated route disappeared. A row
with an allowlisted, directory-verified secure Relay endpoint remains
selectable after the presence lease expires; the ready-v2 bridge and
authenticated hello decide current reachability. A row with no dialable secure
endpoint remains listed with its last-seen state but cannot be selected. Saved
pre-release direct environments remain a local compatibility path; they are not
a pairing fallback. The merged row reports Live, Reconnecting, Parked, or
Offline, and selecting a saved row reconnects it without forcing the user
through machine selection again for every project.
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

Machine management has two explicit scopes. **Remove from account** deletes the
owner-scoped directory registration, so the machine disappears for that ADE
account across clients. Its confirm names the install ("MacBook Pro · ADE
Alpha") and, for a machine seen in the last five minutes, warns that removing
it disconnects it until someone confirms it on that computer. **Forget on this browser** deletes only the local
IndexedDB environment and its paired secret/key material; it does not remove
the account machine. Renaming is account-scoped and updates the directory's
custom display name.

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

Because there is no local replica, project/runtime reads are live transport
round-trips to the active project binding's machine — where the desktop renderer would hit its
in-process cr-sqlite. Account Activity is the deliberate exception: a
signed-in browser reads the consolidated push-relay stream directly, so changing
the active machine/project cannot narrow or block the account inbox. Two
adapter-side measures keep ordinary machine reads from turning routine UI into
a burst of redundant relay traffic. First, read commands and file-list requests
pass through a short (3 s) **coalescing read cache**: concurrent identical reads
join one in-flight request and reuse its result for the TTL window, while any
mutation or sync-driven invalidation drops the affected entries.
Second, the PRs surface **batches** its reads: instead of separate `prs.list` /
`prs.getForLane` / `listWithConflicts` round-trips it hydrates a single
coalesced `prs.getMobileSnapshot` and derives the list views from it, and a
`prsInvalidated` event triggers exactly one aggregate refresh rather than an
empty-list marker. These caches are freshness hints over the authoritative
relay reads, not a persisted store.

The browser may retain several machine catalogs and open project bindings, but
it owns at most four live sync clients. Parked sessions retain only bounded
workspace metadata and release their transport/client slot. Reopening a parked
project reconnects its machine and restores the exact project-scoped adapter.
Open tabs are persisted per account as remote bindings; project calls carrying
one of those bindings stay pinned to that machine/project even if another tab
became active before the call executes.

The Attention adapter maintains a separate incremental account cursor and
validates every item, destination, action, machine, project, tombstone, and
preference object before exposing it through `window.ade`. A 401 may trigger one
forced access-token refresh; malformed or still-unauthorized responses stay
visible as account-service failures. Machine fallback uses the loaded
machine-snapshot owner and per-item source revision on acknowledgment, and an
account switch rejects stale opens/ACKs until a fresh snapshot establishes the
new scope.

Session lifecycle writes (settle, snooze, wake) use the optimistic overlay
(`sessionLifecycleOverlay.ts`) and the feature detection
(`sessionLifecycleSupport.ts`) in the source file map. `sessionLifecycleChrome.ts`
sets `data-ade-session-lifecycle="ready" | "unsupported"` on `<html>`.

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
The adapter resolves both the canonical page action and the older
`agentChat.getEventHistoryPage` alias; only a host advertising neither is
treated as unsupported.
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

Browser-local persistence is limited to UI state, pairing state, and one paint
cache: `envStore.ts` stores paired environments in IndexedDB alongside the
bounded per-machine project catalogs that let recents paint before a connection
exists, and `adapter/infra/localState.ts` stores browser-only preferences such
as layout, zoom, and keybinding overrides. The catalog cache holds project
names, paths, lane counts, and icons - never project contents - and is dropped
when its account signs out or another account signs in.

## ADE Cloud reads

A project tab binds to ADE Cloud when no own computer with a copy is online
(`openAdeCloudProject`). A cloud lane whose computer sleeps is read through a
`cloud-saved:<machineKey>` pin. Both are account-answered pins:

| Surface | Source while the computer sleeps |
|---|---|
| Work: chats, subagents | Saved chats (`/cloud/chats`), nested by parent |
| Work: CLI sessions, shells | Saved copies (`/cloud/sessions`; shells keep the last 5,000 lines) |
| Lanes | The project overview (`/cloud/projects/overview`) |
| Files | GitHub at the lane's branch; changed files from the Git summary |
| Git panel, History | The Git summary (`/cloud/git`) and GitHub commits |
| Linear, Jira | The account server (`/cloud/integrations/...`) |
| Search | Each online computer, plus the cloud rows the page already loaded |

A send to an asleep or deleted cloud chat goes to the account's queue
(`POST /cloud/chats/:machineKey/:chatId/messages`, with a `clientSendId`). The
server keeps the message, wakes the computer, and the computer sends it once.
The composer is free at once. The chat shows the waiting messages, Cancel for
a queued one, and a failed one with the server's sentence until the person
acts. A chat whose computer was deleted continues on a new computer in the
same chat row.

An older server answers a new route with 404. Then the client keeps the
earlier behavior: the separate lists, or a wake and a direct send.

## Appearance and background reads

`components/app/AppearanceRoot.tsx` owns the shared theme, document colour
scheme, motion, and scene preferences for both `App` and the lazily loaded
`WebSignInScreen`. Signed-out boot loads the sign-in chunk without the workspace
router; a failed chunk load reaches the shell's error phase with Retry.

The web default scene is `plain`: the theme background without a picture or
motion. Desktop defaults to Shuffle over the pictures that fit the screen. An
untouched earlier default also reads as the client's default; a saved choice or
tuned texture, dim, theme matching, or image visibility stays as chosen.
`showImage` remains true in the default so choosing Image shows its picture.
Reset is an explicit choice, so it is kept on reload.
The command palette uses `Z_LAYERS.commandPalette` above the shared overlays.

`lib/backoffPoller.ts` owns subscriber-scoped App Control and Cursor
fleet cadence: three unchanged reads at the base interval, then doubling to
15 seconds; a changed snapshot or explicit action resets the cadence. Hidden
tabs make no reads and visibility resumes with an immediate read. App Control's
explicit status read moves a pending long timer back to the base delay. Stopping
removes timers and visibility listeners. OAuth status draining in `adapter/misc.ts`
also pauses while hidden and slows after a quiet interval; cancellation during
an in-flight read sets a drain-again flag so the terminal cancelled status is
still delivered before the drain stops.

## Deeplinks

The web client uses the shared deeplink grammar rather than defining its own
URL contract.

- `buildWebClientUrl` in `apps/desktop/src/shared/webClientUrl.ts` calls
  `buildDeeplink` and rewrites the origin to `https://app.ade-app.dev`.
- `/open?...` in the hosted client is normalized by `parseOpenTarget` in
  `webRoutes.ts`, then mapped to the same in-app routes the desktop renderer
  uses (`/lanes`, `/work`, `/prs`).
- The arriving target is kept in localStorage for 10 minutes
  (`shell/pendingTarget.ts`, on the shared `shell/linkStash.ts`), like the
  sign-in stash, so it survives a sign-in round trip that loses session
  storage. The stash also reads the field an older build wrote, so a link
  saved just before a deploy still restores.
- **Owned links** (chat, lane or PR links carrying `accountMachineKey` +
  `projectId`) are resolved by `shell/ownedLinkResolution.ts` after sign-in,
  instead of restoring the last project: find the account machine by key,
  connect it ("Connecting to <machine>…"), match the project (catalog id, then
  a legacy `projectRoot`, then the envelope repo when unambiguous), open it
  unless already open, confirm the chat or lane exists there, then navigate.
  The loading screen is titled "Opening your link" and lists each step, ticked
  when it ends, so a slow step is plain to see. The existence check waits 6 s
  (`OWNED_LINK_CHECK_MS`); with no answer the link opens anyway.
  Failures show one app banner (`WebOwnedLinkBanner.tsx`) with Try again and,
  where it helps, Your computers: computer not in this account, computers list
  unavailable, computer offline, could not connect, project not on that
  computer, older ADE there, project failed to open, and chat or lane gone. For
  failures before the project opens the last project is restored behind the
  banner and the link keeps waiting; closing the banner drops it.
- A link without ownership keeps the old behaviour: it is applied after the
  user opens a project from the welcome surface. A waiting owned link is used
  only when the project opened is its own. Merely selecting or reconnecting a
  machine does not consume the target.
- Links reach the web client from the website's `/open` page ("Open in your
  browser", or a remembered browser choice), which forwards the query
  unchanged; see [Deeplinks](../deeplinks/README.md).
- **ADE Cloud plan links** (`shell/cloudPlanLink.ts`, `WebCloudPlanLink.tsx`,
  kept with `shell/linkStash.ts`).
  `https://app.ade-app.dev/?cloudPlan=<free|plus|pro|max>` comes from the
  website's plan buttons; `/?cloudReturn=<done|cancelled|portal|card|card_cancelled>`
  is where Stripe sends the person back (the account server builds it from
  its `WEB_CLIENT_ORIGIN`). The value must be exactly one of those, once;
  anything else is ignored. On load the request is kept in localStorage for
  10 minutes (so it survives the sign-in, and the sign-in card says a link
  is waiting) and both parameters leave the address bar at once. Once
  signed in, the app opens Settings › ADE Cloud at Plans (on its own, as the
  top bar's Settings opens it, when no project came back) instead of the
  restored route; this works with no computer online. A paid plan then starts Stripe's checkout in this tab, but
  only when `GET /cloud/access` says ADE Cloud lets the account in and `GET
  /cloud/account` shows no paid plan (a paid account would otherwise change
  plans with no question; it sees the page and a toast instead). Both reads
  go to the account server with the browser's own token, so a person with no
  computer online can still buy. Free only shows the page. A return shows a
  toast saying how Stripe ended. An owned link in the same boot wins and the
  plan link is dropped. The link never starts a sign-in itself.

Entry points:

- CLI: `ade link ... --web` in `apps/ade-cli/src/commands/deeplinks.ts`.
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

- `https://ade-web-client.pages.dev/` serves the SPA.
- A signed-out visit shows the sign-in card and no way past it: no skip button,
  no welcome surface, no machine list.
- Account sign-in returns to `/account/callback`, removes the callback query,
  and shows the welcome surface with the signed-in owner's machines and recent
  projects, without writing tokens to browser storage.
- A reload of a browser that has connected before paints recent projects before
  any socket opens, and the rows stop shimmering as the last-active machine
  reconnects behind them.
- `https://ade-web-client.pages.dev/open?type=lane&id=<uuid>` falls back to
  `index.html` and the shell parses the target.
- `https://ade-web-client.pages.dev/pair#<payload>` scrubs the obsolete route
  and fragment, then shows account sign-in; no pairing UI is rendered.
- `https://ade-web-client.pages.dev/hub` redirects to the welcome surface; the
  retired route renders no Hub and leaves no Hub tab in the top bar.
- Response headers include the CSP from `_headers`.
- Fingerprinted assets return immutable one-year caching while `/` and
  `/index.html` return `no-cache`.
- The build reports the raw first-load entry graph and fails if it exceeds
  1000 KB or eagerly references a guarded heavy feature chunk.

## Known limitations

- No OS notifications.
- No external editor open.
- No file or folder drop into the editor; the browser cannot map local dropped
  files to paths on the connected machine.
- No reveal in Finder / Explorer.
- No native directory picker.
- No local shell process. Terminal creation and IO go through the paired
  machine runtime.
- Settings › ADE Cloud reads the plan, hours, disk and cloud lanes from the
  account server, and pays through it (`adapter/cloudBilling.ts`). A lane's
  size, its delete, freeing its computer, and Clear caches stay in the desktop
  app.
- Passwords are not readable or changeable from a browser.
- No web push notifications.
- Moving a lane or chat onto ADE Cloud is not built. Moving a chat between
  computers works; a resting source offers "Wake and move". Lane sharing as
  the owner (`laneShare.*`) is desktop-only.
- No ADE Browser, computer use, or iOS Simulator surface. App Control is
  watch-only: the Work tool shows the lane's live frames and session state, and
  no driving action runs from the web. Projectless Chats therefore shows its
  runtime-backed Terminal control but not the desktop-only Browser button/profile.
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
