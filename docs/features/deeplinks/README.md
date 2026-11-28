# Deeplinks

One URL contract lets every DAEX surface (desktop, iPhone, the web client, the
site) and outside tools (GitHub PR bodies, Linear, Slack) point at the same
lane, chat, file, commit, artifact, branch, PR, Linear issue, automation run or
Settings card.

- **New links are `daex://`.** Every link DAEX mints uses
  `BRAND.LINK_SCHEME_FOR_NEW_LINKS` (iOS `Brand.linkSchemeForNewLinks`),
  including links forwarded to a phone or another computer.
- **`ade://` opens forever.** The desktop registers both schemes
  (`build.protocols` in `apps/desktop/package.json`; the protocol handler
  claims every scheme in `ADE_DEEPLINK_SCHEMES`), the iPhone lists `ade`,
  `daex`, `ade-beta` and `daex-beta` (`Brand.linkSchemes`), and every parser
  accepts both. Old links in PR bodies, Linear and transcripts keep working.
- **Minting `daex://` is safe because of the launch gate.** At launch the
  account server's minimum version (`GET /client/minimum`,
  `shared/clientUpdateGate.ts`, iOS `ClientUpdateGate.swift`) is set to the
  launch build, so an app that registers only `ade://` must update before it
  runs. Builds released before the gate existed (v1.2.130 and older) are not
  blocked and cannot open `daex://`.
- **The HTTPS form** is `https://ade-app.dev/open?type=…`. The open host has
  not moved to daex.dev. `app.ade-app.dev/open` (the web client's own form) is
  accepted as a legacy host by desktop and iOS.

Both forms parse to the same `AppNavigationTarget` and dispatch through
`IPC.appNavigate`:

```
daex://lane/<uuid>
daex://session/<id>[?lane=<lane-uuid>&event=<seq>&offset=<bytes>]
daex://file/<repo-relative-path>[?line=<n>&lane=<lane-uuid>]
daex://commit/<sha>[?lane=<lane-uuid>]
daex://artifact/<artifact-id>
daex://repo/<owner>/<repo>/branch/<branch>[?pr=<n>]
daex://pr/<owner>/<repo>/<number>
daex://linear-issue/<ADE-123>[?branch=<branch>]
daex://automation-run/<rule-id>/<run-id>[?session=<chat-id>]

https://ade-app.dev/open?type=lane&id=<uuid>
https://ade-app.dev/open?type=session&id=<id>[&lane=<lane-uuid>&event=<seq>&offset=<bytes>]
https://ade-app.dev/open?type=file&path=<repo-relative-path>[&line=<n>&lane=<lane-uuid>]
https://ade-app.dev/open?type=commit&sha=<sha>[&lane=<lane-uuid>]
https://ade-app.dev/open?type=artifact&id=<artifact-id>
https://ade-app.dev/open?type=branch&repo=<owner>/<repo>&branch=<branch>[&pr=<n>]
https://ade-app.dev/open?type=pr&repo=<owner>/<repo>&number=<n>
https://ade-app.dev/open?type=linear-issue&issue=<ADE-123>[&branch=<branch>]
```

Lane, session, commit and artifact links also carry a **portable envelope**
(`repo`, `branch`, `pr`, `linear`); chat, lane and PR links carry
**ownership** (`accountMachineKey` + `projectId`). See [Ownership](#ownership)
and [the resolution ladder](#portable-envelopes-and-the-resolution-ladder).

## Source file map

Shared contract:

- `apps/desktop/src/shared/deeplinks.ts` — builder + parser shared across
  main, renderer, DAEX CLI, and the web `/open` API route. Validates UUIDs,
  GitHub owner/repo, Linear issue identifiers, branch refs (rejects
  traversal, control chars, trailing `.lock`), repo-relative file paths,
  commit shas, and session anchors. Exports `buildDeeplink`, `parseDeeplink`,
  `looksLikeAdeDeeplink`, and `describeTarget` plus the `DeeplinkTarget`
  union (`lane | session | file | commit | artifact | branch | pr |
  linear-issue`) and the `DeeplinkEnvelope` shape.
- `apps/desktop/src/shared/githubRemote.ts` — one GitHub remote-URL parser
  (`git@` and https forms) shared by the main-process repo resolver and the
  renderer's active-project repo check.
- `apps/desktop/src/shared/adeDeeplinkFooter.ts` — renders the branded
  "Open in DAEX" footer block (markdown + small HTML subset) appended to
  GitHub PR descriptions and reused as Linear attachment subtitle.
  Idempotent: the block is wrapped in `<!-- ade:link v=1 ... -->` /
  `<!-- /ade:link -->` markers so subsequent renders replace in place
  instead of appending duplicates. Used by `prService.ts` when creating
  or updating PRs.
- `apps/desktop/src/shared/types/core.ts` — `AppNavigationTarget` /
  `AppNavigationRequest` / `AppNavigationResult` carry the parsed deeplink
  payload across IPC. Targets cover `lane`, `chat`/`work` (with `event` /
  `offset` anchors and the envelope), `file`, `commit`, `artifact`, `pr`
  (with optional repoOwner/repoName for not-yet-local PRs), `branch`
  (cross-machine send-to-mac payload), `linear-issue`, and the generic
  `route` shape; plus `ProjectFindForRepoArgs`/`Result` for the catalog
  lookup.

Desktop renderer — resolution ladder + anchors:

- `apps/desktop/src/renderer/components/app/App.tsx` —
  `AppNavigationBridge.dispatchTarget` owns the resolution ladder (local →
  switch-project → foreign card) and the file-path → lane-worktree
  resolution; `InboundDeeplinkModal.tsx` renders the branch / foreign /
  switch-project cards.
- `apps/desktop/src/main/services/projects/repoProjectResolver.ts` — backs
  the `project.findForRepo` IPC: parses recent projects' git origin from
  `.git/config` (no git subprocess), cached by config mtime.
- `apps/desktop/src/renderer/components/terminals/pendingSessionAnchors.ts`
  — one-shot per-session anchor queue between navigation (URL effect in
  `useWorkSessions`, ⌘K palette) and the content surfaces
  (`AgentChatMessageList` scroll-to-sequence + highlight, `TerminalView`
  replay byte-fraction scroll).

Desktop main process — protocol handler:

- `apps/desktop/src/main/services/deeplinks/protocolHandler.ts` — registers
  DAEX as the OS handler for both schemes (`daex://` and `ade://`), acquires the
  single-instance lock so a second `open daex://...` reuses the running
  window, listens for `open-url` (macOS) and `second-instance` (Win/Linux),
  buffers URLs received before `app.whenReady()`, and on dispatch parses
  the URL, maps it to an `AppNavigationTarget`, and forwards through the
  caller-supplied dispatcher. `main.ts` wires the dispatcher to focus the
  most-suitable `BrowserWindow` and `webContents.send(IPC.appNavigate, …)`.
  On Linux the claim names a desktop entry: the `.deb` installs one, and an
  AppImage writes its own to the user's applications folder at launch
  (`native/appImageDesktopEntry.ts`).
  `handleDeeplinkUrl` is also re-used by the iOS Send-to-Mac sync command
  (`syncRemoteCommandService.ts`'s `deeplinks.open`). Its `log` hook is wired
  to the machine logger (`~/.ade/runtime/desktop-main.jsonl`), not a project
  one — all of this happens before a project can be open — and the branch that
  loses the single-instance lock calls `flushLog` first, so
  `deeplink.single_instance.lock_lost` survives the exit.

  Every launch that loses the lock exits there with `app.exit(0)`, before the
  boot in `main.ts` (windows, bridge, services). Any `daex://` URL or file it was
  launched with has already gone to the running copy through
  `requestSingleInstanceLock()`, which reaches the holder's `second-instance`
  handler. That includes an update relaunch: the lock log line records
  `pendingInstallUpdate` (set in `ade-state.json` while an install is pending),
  so an update race can be told apart from a stray launch.
- `apps/desktop/src/main/services/deeplinks/projectNavigationWindowSelection.ts`
  — pure selection helper for project-scoped navigation. It first prefers a
  window whose active project already matches the target root, then a window
  with the target root open in a background project tab, asking main to
  activate that project before dispatching. Only when no existing window/tab
  can own the project does main open a new DAEX window. It also owns the rule for
  a **remote** project opened from Activity: never the window the user is working
  in. Binding a remote project replaces that window's global project context, so
  an item about another machine opens elsewhere or in a new window rather than
  throwing away what was on screen.
- `apps/desktop/src/main/services/deeplinks/ownerAwareNavigation.ts` — routes an
  ownership-carrying target (work / chat / PR) to its owning machine before the
  ordinary focused-window fallback, returning false only for machine-unscoped
  navigation.
- `apps/desktop/src/main/services/deeplinks/localProjectResolution.ts` — resolves
  a link's project against *this* machine's own projects. Three id spaces reach a
  deeplink handler — a canonical `project_<hash>` from a modern link, a
  publishing machine's private uuid from an older one, and this machine's own
  private uuids — so neither an id match nor a path match alone is honest.
  It tries exact id, then the root path the link carried, then a recomputed
  canonical id, and returns `null` as a real answer so the caller routes to the
  owning machine instead of guessing. Its remote twin is
  `resolveRemoteProjectBinding` in `services/ipc/runtimeBridge.ts`; keep the two
  in step.
- `apps/desktop/src/main/main.ts` — calls `registerAdeProtocolHandler({...})`
  before `app.whenReady()` so cold-start URLs aren't lost. The iOS
  `deeplinks.open` path calls the project-scoped dispatcher for the sync
  host's project root so Send-to-Mac targets the paired project's window/tab
  instead of whichever DAEX window is focused locally.

Desktop main process — PR footer integration:

- `apps/desktop/src/main/services/prs/prService.ts` calls
  `ensureAdeDeeplinkFooter` when creating, updating, and re-rendering PR
  descriptions so the branded block always reflects the current branch +
  PR number. Re-render fires a follow-up PATCH once the PR number is
  known.
- `apps/desktop/src/main/services/cto/linearLaneCardService.ts` builds the
  same deeplink target when posting Linear attachments so Linear cards can
  open DAEX lanes, PRs, Work sessions, or the Linear pane via the cross-machine
  `https://ade-app.dev/open?...` URL instead of a Mac-only path.

DAEX CLI — outbound + inbound:

- `apps/ade-cli/src/commands/deeplinks.ts` — `daex open`, `daex link`,
  and `daex linear install` subcommands.
  - `daex open <url>` invokes the OS opener (`open` / `xdg-open` /
    `rundll32.exe url.dll,FileProtocolHandler`). Windows passes the URL as one
    direct process argument so OAuth query characters never enter `cmd.exe`.
    The opener receives only a validated `daex://` or
    `https://ade-app.dev/open?...` URL, which
    routes back through the registered protocol handler. The
    `--linear-issue <id> --branch <branch>` form is what Linear's
    "Open issue in coding tool" entry passes; the receiving install opens
    the Linear pane to that issue, or shows a setup state if the project has
    not connected Linear yet.
  - `daex link …` builds a deeplink for a lane / work session / branch / PR / Linear
    issue and copies it to the clipboard. `--ade` (the flag keeps its old
    name) emits the custom `daex://` scheme; the default is the HTTPS form; `--web` emits the hosted web
    client form (`https://app.ade-app.dev/open?...`, via `buildWebClientUrl`)
    and cannot be combined with `--ade`. Round-trip form
    (`daex link <url>`) re-emits a parsed URL in the chosen form, and the
    round-trip validation gate also accepts a web-client URL.
  - `daex linear install` writes `~/.linear/coding-tools.json` so Linear's
    "Open issue in coding tool" dropdown can launch DAEX. Backs up the
    previous file alongside.
- `apps/ade-cli/src/cli.ts` and `apps/ade-cli/src/adeRpcServer.ts` —
  PR creation formatters/tools include the DAEX HTTPS PR URL next to the
  GitHub URL when the PR number and repo are known. Agents should use
  that `adeUrl` in final handoffs; if a PR was adopted through another
  path, `daex link pr <owner/repo> <number> --no-clipboard` mints the
  same URL.

Apps/web — landing page + OG unfurl:

- `apps/web/src/app/pages/OpenPage.tsx` — React SPA page mounted at
  `/open`. Reads the same query shape as the parser, offers the app, the
  browser and Install, opens a remembered choice after a short pause, and
  orders the choices by the online computers that DAEX Web's `/link-status`
  frame reports.
- `apps/web/api/open.ts` — Vercel serverless function for `/open`. Self-
  fetches `/index.html`, rewrites `<title>`, `og:*`, and `twitter:*`
  meta tags from query params so chat-app unfurlers (Slack, Discord,
  iMessage, Gmail, Linear) show a rich card without executing
  JavaScript. Cache: `public, max-age=600, stale-while-revalidate=86400`.
- `apps/web/vercel.json` — adds `/open → /api/open` rewrite ahead of the
  catch-all SPA rewrite.

iOS — inbound deeplinks, Universal Links, outbound link minting, and
Send-to-Mac:

- `apps/ios/ADE/Views/Lanes/LaneDeeplinkHelpers.swift` — outbound link
  minting on the phone: an envelope-aware builder mirroring the TS
  `buildDeeplink` for the shapes iOS mints (lane / session / branch / PR).
  Lane detail's "Copy DAEX lane link" / "Copy branch link", the Work session
  copy-link, and PR detail's "Copy DAEX link" all mint https-form links with
  envelope params (branch links resolve owner/repo from a linked PR; with no
  GitHub remote the lane link is copied instead, with a notice).
- `apps/ios/ADE/App/DeepLinkRouter.swift` — parses inbound `daex://` URLs and
  the https `/open` mirror. Session links (both forms) and compact
  `daex://pr/<n>` navigate locally via `.adeDeepLinkRequested`; session
  `event`/`offset` anchors ride `WorkSessionNavigationRequest` (carried, not
  yet scrolled to — no route-level scroll hook exists on iOS).
  Lane / repo-branch / full-PR / linear-issue / file / commit / artifact
  shapes validate then post `.adeSendToMacRequested`. A lane link first reads
  the account's DAEX Cloud lanes without a computer; a kept lane posts
  `.adeKeptLaneRequested` instead, and `ADEApp` shows the kept page (New
  computer, Delete).
- Universal Links: `apps/ios/ADE/ADE.entitlements` carries
  `applinks:ade-app.dev`; `ADEApp.swift` routes
  `NSUserActivityTypeBrowsingWeb` activities into the router; the AASA file is
  served from `apps/web/public/.well-known/apple-app-site-association`
  (appID `VQ372F39G6.com.ade.ios`, claiming only `/open*`, `/pair*`, and
  `/device` when it carries a `user_code`) with
  an `application/json` header set in `apps/web/vercel.json`.
- `apps/ios/ADE/Views/Account/DeviceSignInApprovalSheet.swift` and
  `apps/ios/ADE/Services/DeviceSignInApproval.swift` — the sign-in link of
  another computer, `https://ade-app.dev/device?user_code=ABCD-EFGH` (also
  `daex://device?user_code=…`). It is the QR code that `daex connect` and the
  desktop sign-in card show. `DeepLinkRouter` posts `.adeDeviceSignInRequested`
  and `ADEApp` presents the sheet: it reads the computer's name from the
  account directory (`GET /device/approve`), and **Approve** opens the
  directory's one-time Clerk sign-in in an ephemeral web sheet, where the
  person taps **Allow** and types no password. The sheet polls the directory
  and closes the web sheet when the sign-in is approved. While the approval is
  in flight the sheet cannot be dismissed. A phone that is signed out, or a
  directory that cannot approve from an app, offers the browser page. In a browser, `apps/web/api/device.ts` redirects the same link
  to the directory's `/device` page.
- `apps/ios/ADE/Views/Deeplinks/SendToMacCard.swift` — SwiftUI sheet
  bound to `.adeSendToMacRequested`. Parses the URL (including the portable
  envelope) into a `SendToMacTarget` for a human-readable headline / detail,
  forwards the URL to a paired desktop through the sync command surface, and
  offers envelope fallbacks the phone can act on directly (open the PR on
  GitHub, open the Linear issue).
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` — receives
  the iOS "Send to your Mac" payload as the `deeplinks.open` sync
  command and feeds the URL through `handleDeeplinkUrl` so the desktop
  dispatches it through the same parser as an OS-routed `open daex://...`,
  with main scoping delivery to the paired sync service's project root.
- `apps/ade-cli/src/services/sync/syncHostService.ts` — exposes the same
  `deeplinks.open` command from the DAEX runtime so a phone paired
  directly to a headless runtime can still bounce a URL out through that runtime.

## Gotchas

- **Mint with `buildDeeplink`, accept both schemes.** Never hand-write
  `ade://` or `daex://`: `buildDeeplink` uses the new-link scheme, and a
  parser or matcher that checks only one scheme breaks either old links or new
  ones. Check `ADE_DEEPLINK_SCHEMES` (iOS `Brand.linkSchemes`). The iPhone
  still routes internally on `ade` (`withADEScheme`) and its sign-in
  callbacks stay `ade`; they never leave the app.
- **Send-to-Mac goes to the paired host's project.** The phone forwards a link
  through the sync command `deeplinks.open`; main dispatches it into that
  sync host's project window or tab, never whichever window is focused.
- **Register the protocol handler before `app.whenReady()`.** Otherwise
  the cold-start URL on macOS / Windows gets dropped before the listener
  attaches. `protocolHandler.ts` buffers URLs that arrive between
  registration and `whenReady` so they aren't lost.
- **Validate before dispatch.** The parser rejects malformed inputs
  (non-UUID lane ids, traversal in branch refs, non-positive PR numbers,
  unknown hosts). Don't bypass it for "trusted" callers — Linear's
  template substitution can produce empty strings.
- **The HTTPS form is the social form.** When linking from chat apps,
  emails, or anywhere a preview matters, prefer the `https://ade-app.dev/open`
  shape so the unfurl works. Use `daex://` when the target is guaranteed
  to be a machine with DAEX installed (terminal share).
- **Linear hand-off doesn't carry the GitHub repo.** The `linear-issue`
  shape only has the identifier (`ADE-123`) and optionally Linear's
  generated branch name. The desktop opens the Linear pane to that issue
  inside the active project. From there the user can create a lane, start a
  chat, or connect Linear if this project has not been authorized yet. If no
  project is open, DAEX shows a setup modal because the Linear issue identifier
  alone is not enough to choose a local repo.
- **Branch links are the portable lane form.** Lane UUID links are local, but
  branch links can be shared across machines. If the receiver does not already
  have that lane, DAEX fetches remotes and imports the branch as a local
  worktree-backed lane. Without an active project, the import modal stays
  read-only and asks the user to open the matching DAEX project first.
- **The PR footer is GitHub-flavored markdown, not full HTML.** Only the
  `<p>`, `<img>`, `<a>`, `<strong>` subset renders. Linear accepts the same subset.

## URL semantics

| Form | Target | Notes |
|------|--------|-------|
| `daex://lane/<uuid>` | `{ kind: "lane", laneId, envelope? }` | UUID v4 required. |
| `daex://session/<id>[?lane=<uuid>&event=<seq>&offset=<bytes>]` | `{ kind: "session", sessionId, laneId?, event?, offset?, envelope? }` | Local Work tab session link. Routes to `/work` with the selected session. `event` anchors the chat list to the message with that persisted envelope sequence (ordinal fallback when the full transcript is loaded); `offset` best-effort-positions a replayed terminal scrollback by byte fraction. |
| `daex://file/<repo-relative-path>[?line=<n>&lane=<uuid>]` | `{ kind: "file", path, line?, laneId? }` | Opens the Files editor at the path — inside the lane worktree when `lane` is present, else the project root — and reveals `line`. Traversal-safe: WHATWG URL normalization collapses `..` in the custom-scheme path form and the validator rejects traversal/absolute paths in the https `path=` param. |
| `daex://commit/<sha>[?lane=<uuid>]` | `{ kind: "commit", sha, laneId?, envelope? }` | Opens the owning lane's detail (`commitSha` param). Foreign fallback: the envelope's repo yields a GitHub commit URL. 7–40 hex chars. |
| `daex://artifact/<id>` | `{ kind: "artifact", artifactId, envelope? }` | Local-only proof artifact; opens the history surface. |
| `daex://repo/<owner>/<repo>/branch/<branch>[?pr=<n>]` | `{ kind: "branch", repoOwner, repoName, branch, prNumber? }` | Cross-machine. Renderer routes to the lane that already owns the branch; otherwise it opens a create/import modal. PR-backed links use PR preflight, branch-only links fetch the remote branch and import it as a local lane. If no DAEX project is open, the modal asks the user to open the matching project first. |
| `daex://pr/<owner>/<repo>/<number>` | `{ kind: "pr", repoOwner, repoName, prNumber }` | If the PR isn't yet local, the renderer jumps to the PRs tab pre-filtered or falls back to the create-lane-from-branch flow. |
| `daex://linear-issue/<ADE-123>[?branch=<branch>]` | `{ kind: "linear-issue", issueIdentifier, branch? }` | Linear hand-off. Opens DAEX's Linear pane focused to the issue. If no project is open or this project is not connected to Linear, DAEX shows a setup modal with the next action. |
| `daex://automation-run/<rule-id>/<run-id>[?session=<chat-id>]` | `{ kind: "automation-run", ruleId, runId, sessionId?, ownership? }` | One automation run's history: the computer opens `/automations?rule=&run=`, selecting the rule and the run in History (the newest run when that one is gone). https form `type=automation-run&rule=&id=&session=`. A phone, and the hosted web client (which has no run history), open the run's chat when `session` names one; else the phone offers the run to the computer. A link the phone forwards to the computer carries its owner and goes to that computer and project, as a click would. Takes ownership like a session link, so it opens on the machine that ran it. The Send notification step's **This run's history** choice makes it; the step fills an empty `session=` when the run started no chat. |
| `daex://settings/<entry-id>[?machine=<id>]` | `{ kind: "settings", entryId, machineId? }` | One card in Settings, by its id in `shared/settingsManifest.ts`; https form `type=settings&id=`. Navigates only. `machine` picks a Computer page's machine; one this window does not know opens This computer's page. An id this build does not know draws a generic DAEX link. |
| `daex://lane-share/<grant-id>` | `{ kind: "lane-share", grantId }` | A lane another account shares with this one: the invite link. https form `type=lane-share&id=<grant-id>`, minted by the host as `https://ade-app.dev/open?type=lane-share&id=…`. The grant id (`ls_` and 32 hex characters, `LANE_SHARE_GRANT_ID_PATTERN`) is an address only: the account directory decides whether this account may see the grant. Needs no project. Desktop and the hosted web client route it to `/shared?grant=<id>`; in a chat it is a DAEX link chip labelled "Shared lane". See [lane sharing](../lanes/lane-sharing.md). |
| `daex://open/<place>` | `{ kind: "open", place }` | A page from `shared/openPlaces.ts` (PRs, Lanes, History, Connections…). No https form, and the protocol handler refuses it: it runs only from a click on its chip in a chat. |

Validation lives in one place (`shared/deeplinks.ts`) so the parser, the
builders, and the web `/open` handler agree on what counts as
malformed.

## Ownership

Chat (`session`), lane and PR links carry `accountMachineKey` and `projectId`,
always together, so a receiver routes to the machine that owns the work
instead of guessing.

- **Who stamps it:** Activity items; DAEX MCP results (`remoteMcpTools.ts`
  `chatLink`); `daex chat inbox`; `daex link` (brain action
  `get_link_ownership`: it answers only when the current project holds that
  chat, lane or PR repository, so a link to another project's work goes out
  unowned; `--no-envelope` skips it); the Work and lane menus' **Copy link** /
  **Open in web** (`renderer/lib/linkOwnership.ts` →
  `remoteRuntime.linkOwnership`, which names a remote row's host by its paired
  machine key); the Linear agent's cards (`localLinkOwnership(projectRoot)` in
  `apps/ade-cli/src/services/projects/localLinkOwnership.ts`).
- **Desktop routing.** Owned `work`, `chat`, `pr` and `lane` targets go
  through `ownerAwareNavigation.ts`. A local project resolves against open
  windows, recents, then the machine registry, so a project an agent, the CLI
  or a phone added still opens. An owned link clicked inside DAEX goes to main
  over `IPC.appOpenOwnedDeeplink` and takes the same routing as one from
  outside. A chat or lane that is gone says "no longer in this project", not
  "on another machine". A window opened for a link may get its navigation
  before the app mounts; the preload holds it for the first `onNavigate`
  subscriber.
- **Web and iPhone.** The web client (`webclient/shell/ownedLinkResolution.ts`)
  connects to the machine, opens the project, then the item. iOS does the
  same, waits up to 10 minutes for the account (cold launch, or a signed-out
  person signing in), and offers to wake a sleeping Mac instead of failing
  ([iOS companion → Waking a sleeping Mac](../sync-and-multi-device/ios-companion.md#waking-a-sleeping-mac)).
- **No key on the link.** The owner can be recovered from local attention and
  workspace snapshots, but only for a link from outside the app: doing it
  during cold-launch restore would turn a relaunch into a machine switch.
- **`projectId` is the canonical id** (`deriveProjectId(rootPath)`,
  `project_<hash>`), never a machine's private database uuid, which resolves
  nowhere else.
- **Never stamp `projectRoot`.** Links are pasted into PRs, Linear and Slack,
  and a path leaks the username and folder layout. The canonical id is the
  hash of the root, so a receiver recomputes it from each root it knows.
  `projectRoot` is still parsed for older links; an over-long value is dropped.

## The `/open` page

`apps/web/src/app/pages/OpenPage.tsx` (served at `https://ade-app.dev/open`)
is a hand-off screen without the site header and footer. It forwards
everything the link carries and offers:

- **Open in the DAEX app** (the `daex://` form), **Open in your browser** (the
  web client at `https://app.ade-app.dev/open` with the same query; the web
  client must keep its own origin, which holds its sign-in and device keys),
  and **Install DAEX**. On an iPhone or iPad also **Open in DAEX Beta**
  (`daex-beta://`; older Beta builds register only `ade-beta://`; only the App
  Store app claims the universal link).
- **Remember my choice** stores `ade.openLinksIn` (`app` | `web`) in
  localStorage. With nothing remembered, nothing launches until the person
  picks: a page cannot tell whether an app took a custom-scheme link. With a
  choice remembered it opens after 1.5 s with **Change** and **Open now** in
  view; Escape or **Change** stops it; `?choose=1` always shows the choices.
  2.5 s after trying the app, the browser becomes the main button ("DAEX
  didn't open?") unless the page lost focus.
- **Online computers.** While the choices show on a computer, the page frames
  the web client's hidden `/link-status` page (on `app.ade-app.dev`) for up to
  4 s and accepts only a well-formed `ade-link-status` message from that
  origin. If the browser is signed in, the DAEX app goes first when one of the
  account's computers is online, and DAEX Web first when none is.

`apps/web/api/open.ts` rewrites the page's title and `og:*` / `twitter:*` tags
so unfurlers show a card without running JavaScript.

Desktop betas are the same `com.ade.desktop` app as stable. Alpha (a local
build) declares the schemes so a Mac with only Alpha still opens links, but
never claims the OS default (see [Channel handling](#channel-handling)).

## Portable envelopes and the resolution ladder

Lane, session, commit, and artifact ids are machine-local, so those links
carry a portable envelope (`repo` / `branch` / `pr` / `linear` query params)
populated at mint time. On open, the desktop resolves in a strict ladder
(`AppNavigationBridge.dispatchTarget` in `App.tsx`):

1. **Local** — the id resolves in the active project → open it exactly,
   anchors included.
2. **Another connected machine** — the id resolves nowhere locally, but the
   cross-machine union (`renderer/lib/otherMachineNavigation.ts`) holds it on a
   paired machine for the same repo → open it there, no card: a commit in
   History (`?surface=commits&laneId&machineId&commitSha`), a lane in Lanes
   (`?laneId&machineId`), a chat in Work. The dispatcher waits up to 3 s for the
   union when a machine is online, so a link opened before any Work/Lanes/Files
   surface loaded still resolves. An explicit `machineId` on the target wins
   over a local lane with the same id, because lane ids are unique per machine,
   not globally.
3. **Another known project** — the envelope repo matches a different project
   in the machine catalog (`project.findForRepo` IPC →
   `main/services/projects/repoProjectResolver.ts`, which parses each recent
   project's git origin from `.git/config` without spawning git, cached by
   config mtime) → a card offers "Switch project and open", then re-dispatches
   the original target after the switch.
4. **Foreign machine** — the id resolves nowhere → a fallback-only card
   ("This chat/lane lives in `<owner>/<repo>` on another machine", or, with no
   repo and no connected machine, "DAEX cannot find this … on this machine or on
   a connected machine") offering only the actions the envelope carries: create
   a lane from the branch (the existing branch-import flow), open the PR or
   commit on GitHub, open the Linear issue. There is deliberately no
   request-access or shared-transcript path.

All three cards are the one `InboundDeeplinkModal` (generalized to
`branch | foreign | switch-project` targets). Envelope parsing is lenient —
a malformed component is dropped so it can never break the primary target.

### Session anchors

Search results and shared links can point inside a session. The anchor rides
the URL (`event` / `offset`), crosses IPC on the work/chat
`AppNavigationTarget`, and is handed one-shot to the session's content surface
via `renderer/components/terminals/pendingSessionAnchors.ts` (set by
`useWorkSessions`' URL effect and the ⌘K palette; consumed by
`AgentChatMessageList` — scroll + brief highlight — and `TerminalView` —
byte-fraction scroll in replay mode). The search index emits chat anchors as
the persisted `envelope.sequence` so a tail-paged transcript can resolve them
without loading full history.

## End-to-end flow

```
                      ┌────────────────────────────────────────────┐
                      │ Producer                                    │
                      │   - daex link …           (CLI clipboard)   │
                      │   - PR description footer (auto-rendered)   │
                      │   - Linear attachment     (post on lane)    │
                      │   - iOS share / chat app                    │
                      └────────────────────────────────────────────┘
                                         │
                          daex:// URL  or  https://ade-app.dev/open?...
                                         │
        ┌────────────────────────────────┼─────────────────────────────────┐
        │                                │                                  │
        ▼                                ▼                                  ▼
  Browser / chat unfurler         Desktop OS handler             iOS / paired phone
  hits apps/web/api/open.ts       (registerAdeProtocolHandler)   (DeepLinkRouter.swift)
  → rich OG card + SPA            → handleDeeplinkUrl            → adeDeepLinkRequested
                                  → IPC.appNavigate              → adeSendToMacRequested
                                                                     → sync deeplinks.open
                                                                       on paired host
                                                                       → handleDeeplinkUrl
                                                                       → IPC.appNavigate
```

The parser and `AppNavigationTarget` mapping are the same in every case.
Delivery is project-aware: OS-routed desktop URLs use the active-window
dispatcher, while sync-originated Send-to-Mac URLs select the paired
project's existing window or background tab before `IPC.appNavigate` is
sent. The renderer's `window.ade.app.onNavigate` listener owns the routing
decision (open lane tab, jump to PR, prompt to create lane from branch,
resolve Linear issue to lane).

## PR description footer

```html
<!-- ade:link v=1 type=pr repo=<owner>/<repo> branch=<branch> num=<n> -->
<p>
  <img src="https://ade-app.dev/icon-flat.png" height="18" align="left" alt="DAEX">
  &nbsp;&nbsp;<strong>Open in DAEX</strong>
  &nbsp;·&nbsp; <a href="…">branch link</a>
  &nbsp;·&nbsp; <a href="…">PR link</a>
</p>
<!-- /ade:link -->
```

`prService.ts` calls `ensureAdeDeeplinkFooter` on PR create and update.
Re-renders are idempotent — the marker comments mark the block boundary
so the next call replaces it in place rather than appending. When the PR
is first created, the footer initially carries the branch link only;
once the PR number is known, a follow-up patch re-renders the block
with the PR link included.

Agent closeout still includes explicit links. `daex prs create` and the
private `create_pr_from_lane` action return both `githubUrl` and
`adeUrl` when available, and the text formatter prints them as separate
rows. The GitHub PR body footer is automatic, but the final chat
handoff should still include the GitHub URL and the DAEX HTTPS PR URL so
the user can jump directly to either GitHub or the DAEX PRs tab.

## Channel handling

The packaged app declares both schemes (`build.protocols` in
`apps/desktop/package.json`, which electron-builder writes into the macOS
`Info.plist` as `CFBundleURLTypes`). macOS refuses a runtime claim for a scheme
the bundle does not declare. Windows needs no declaration: the runtime claim
writes `HKCU\Software\Classes\daex` and `HKCU\Software\Classes\ade` (the app is
still `ADE.exe` on disk), and the uninstaller removes them.

Only the **Stable** channel claims the schemes as the OS-default handler.
Alpha builds still install the single-instance lock and the
`open-url` / `second-instance` listeners (so a manual `duti` binding
still routes deeplinks to them), but they skip
`app.setAsDefaultProtocolClient` so they don't fight Stable for the
binding on machines where multiple channels are installed.

Source builds default to the same skip behavior and do not expose an env
override to claim the system binding. They can still dispatch URLs that are
explicitly delivered to that process, but the OS-default handler is
reserved for the real packaged Stable desktop build. The gate lives in
`apps/desktop/src/main/main.ts` (packaged Stable channel detection) and the
registration mechanics live in `protocolHandler.ts` behind the
`claimAsDefault` option.

## Cross-links

- [Pull requests](../pull-requests/README.md) — PR description rendering,
  footer integration.
- [Sync and multi-device](../sync-and-multi-device/README.md) — the
  iOS Send-to-Mac sync command bounces deeplinks to a paired host.
- [System overview](../../ARCHITECTURE.md) — `IPC.appNavigate`, web /open
  route placement.
