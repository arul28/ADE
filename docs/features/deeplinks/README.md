# Deeplinks

Deeplinks are the shared URL contract that lets every ADE surface — desktop,
ADE Code TUI, iOS, the marketing site, and external tools (Linear, GitHub
PR descriptions, chat apps) — point at the same lane, work session, branch, PR, or Linear
issue. Two forms carry identical semantics:

```
ade://lane/<uuid>
ade://session/<id>[?lane=<lane-uuid>]
ade://repo/<owner>/<repo>/branch/<branch>[?pr=<n>]
ade://pr/<owner>/<repo>/<number>
ade://linear-issue/<ADE-123>[?branch=<branch>]

https://ade-app.dev/open?type=lane&id=<uuid>
https://ade-app.dev/open?type=session&id=<id>[&lane=<lane-uuid>]
https://ade-app.dev/open?type=branch&repo=<owner>/<repo>&branch=<branch>[&pr=<n>]
https://ade-app.dev/open?type=pr&repo=<owner>/<repo>&number=<n>
https://ade-app.dev/open?type=linear-issue&issue=<ADE-123>[&branch=<branch>]
```

The HTTPS form lives on `apps/web` (Vercel) and acts as a marketing landing
page plus an OS-level upgrade into the `ade://` form when an ADE client is
registered. The `ade://` form routes directly through the OS to the running
desktop process (or starts it cold). Both forms parse to the same
`AppNavigationTarget` shape and dispatch through `IPC.appNavigate`.

## Source file map

Shared contract:

- `apps/desktop/src/shared/deeplinks.ts` — builder + parser shared across
  main, renderer, ADE CLI, and the web `/open` API route. Validates UUIDs,
  GitHub owner/repo, Linear issue identifiers, and branch refs (rejects
  traversal, control chars, trailing `.lock`). Exports `buildDeeplink`,
  `parseDeeplink`, `looksLikeAdeDeeplink`, and `describeTarget` plus the
  `DeeplinkTarget` union (`lane | session | branch | pr | linear-issue`).
- `apps/desktop/src/shared/adeDeeplinkFooter.ts` — renders the branded
  "Open in ADE" footer block (markdown + small HTML subset) appended to
  GitHub PR descriptions and reused as Linear attachment subtitle.
  Idempotent: the block is wrapped in `<!-- ade:link v=1 ... -->` /
  `<!-- /ade:link -->` markers so subsequent renders replace in place
  instead of appending duplicates. Used by `prService.ts` when creating
  or updating PRs.
- `apps/desktop/src/shared/types/core.ts` — `AppNavigationTarget` /
  `AppNavigationRequest` / `AppNavigationResult` carry the parsed deeplink
  payload across IPC. Targets cover `lane`, `chat`/`work`, `pr` (with
  optional repoOwner/repoName for not-yet-local PRs), `branch` (cross-machine
  send-to-mac payload), `linear-issue`, and the generic `route` shape.

Desktop main process — protocol handler:

- `apps/desktop/src/main/services/deeplinks/protocolHandler.ts` — registers
  ADE as the OS handler for the `ade://` scheme, acquires the
  single-instance lock so a second `open ade://...` reuses the running
  window, listens for `open-url` (macOS) and `second-instance` (Win/Linux),
  buffers URLs received before `app.whenReady()`, and on dispatch parses
  the URL, maps it to an `AppNavigationTarget`, and forwards through the
  caller-supplied dispatcher. `main.ts` wires the dispatcher to focus the
  most-suitable `BrowserWindow` and `webContents.send(IPC.appNavigate, …)`.
  `handleDeeplinkUrl` is also re-used by the iOS Send-to-Mac sync command
  (`syncRemoteCommandService.ts`'s `deeplinks.open`).
- `apps/desktop/src/main/services/deeplinks/projectNavigationWindowSelection.ts`
  — pure selection helper for project-scoped navigation. It first prefers a
  window whose active project already matches the target root, then a window
  with the target root open in a background project tab, asking main to
  activate that project before dispatching. Only when no existing window/tab
  can own the project does main open a new ADE window.
- `apps/desktop/src/main/main.ts` — calls `registerAdeProtocolHandler({...})`
  before `app.whenReady()` so cold-start URLs aren't lost. The iOS
  `deeplinks.open` path calls the project-scoped dispatcher for the sync
  host's project root so Send-to-Mac targets the paired project's window/tab
  instead of whichever ADE window is focused locally.

Desktop main process — PR footer integration:

- `apps/desktop/src/main/services/prs/prService.ts` calls
  `ensureAdeDeeplinkFooter` when creating, updating, and re-rendering PR
  descriptions so the branded block always reflects the current branch +
  PR number. Re-render fires a follow-up PATCH once the PR number is
  known.
- `apps/desktop/src/main/services/cto/linearLaneCardService.ts` builds the
  same deeplink target when posting Linear attachments so Linear cards can
  open ADE lanes, PRs, Work sessions, or the Linear pane via the cross-machine
  `https://ade-app.dev/open?...` URL instead of a Mac-only path.

ADE CLI — outbound + inbound:

- `apps/ade-cli/src/commands/deeplinks.ts` — `ade open`, `ade link`,
  and `ade linear install` subcommands.
  - `ade open <url>` invokes the OS opener (`open` / `xdg-open` / `start`)
    on a validated `ade://` or `https://ade-app.dev/open?...` URL, which
    routes back through the registered protocol handler. The
    `--linear-issue <id> --branch <branch>` form is what Linear's
    "Open issue in coding tool" entry passes; the receiving install opens
    the Linear pane to that issue, or shows a setup state if the project has
    not connected Linear yet.
  - `ade link …` builds a deeplink for a lane / work session / branch / PR / Linear
    issue and copies it to the clipboard. `--ade` emits the custom
    scheme; the default is the HTTPS form. Round-trip form
    (`ade link <url>`) re-emits a parsed URL in the chosen form.
  - `ade linear install` writes `~/.linear/coding-tools.json` so Linear's
    "Open issue in coding tool" dropdown can launch ADE. Backs up the
    previous file alongside.
- `apps/ade-cli/src/cli.ts` and `apps/ade-cli/src/adeRpcServer.ts` —
  PR creation formatters/tools include the ADE HTTPS PR URL next to the
  GitHub URL when the PR number and repo are known. Agents should use
  that `adeUrl` in final handoffs; if a PR was adopted through another
  path, `ade link pr <owner/repo> <number> --no-clipboard` mints the
  same URL.
- `apps/ade-cli/src/tuiClient/deeplinkRow.ts` — pure helper used by the
  TUI's `Ctrl+Y` keybinding. Resolves the focused row (lane / PR) to a
  canonical `ade://` URL, including parsing GitHub PR URLs to lift
  owner/repo/number when the right-pane only carries the URL.
- `apps/ade-cli/src/tuiClient/keybindings/index.ts` — registers
  `copy_deeplink` so `Ctrl+Y` over a highlighted lane or PR row builds
  and copies the link via `tuiClient/app.tsx`.

Apps/web — landing page + OG unfurl:

- `apps/web/src/app/pages/OpenPage.tsx` — React SPA page mounted at
  `/open`. Reads the same query shape as the parser, attempts the
  `ade://` upgrade, and falls back to a download / install card with
  the parsed target described inline.
- `apps/web/api/open.ts` — Vercel serverless function for `/open`. Self-
  fetches `/index.html`, rewrites `<title>`, `og:*`, and `twitter:*`
  meta tags from query params so chat-app unfurlers (Slack, Discord,
  iMessage, Gmail, Linear) show a rich card without executing
  JavaScript. Cache: `public, max-age=600, stale-while-revalidate=86400`.
- `apps/web/vercel.json` — adds `/open → /api/open` rewrite ahead of the
  catch-all SPA rewrite.

iOS — inbound deeplinks + Send-to-Mac:

- `apps/ios/ADE/App/DeepLinkRouter.swift` — parses inbound `ade://` URLs.
  `ade://session/<id>` and `ade://pr/<n>` (and the longer
  `ade://pr/<owner>/<repo>/<number>` form) flip the active tab via
  `.adeDeepLinkRequested`. `ade://lane/<uuid>` and
  `ade://repo/<owner>/<repo>/branch/<branch>` are local-only desktop
  concepts and instead post `.adeSendToMacRequested` so the parent view
  shows the "Send to your Mac" confirmation card.
- `apps/ios/ADE/Views/Deeplinks/SendToMacCard.swift` — SwiftUI sheet
  bound to `.adeSendToMacRequested`. Parses the URL into a
  `SendToMacTarget` (`lane`, `repoBranch`, `other`) for a human-readable
  headline / detail and forwards the URL to a paired desktop through the
  sync command surface.
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` — receives
  the iOS "Send to your Mac" payload as the `deeplinks.open` sync
  command and feeds the URL through `handleDeeplinkUrl` so the desktop
  dispatches it through the same parser as an OS-routed `open ade://...`,
  with main scoping delivery to the paired sync host's project root.
- `apps/ade-cli/src/services/sync/syncHostService.ts` — exposes the same
  `deeplinks.open` command from the runtime daemon so a phone paired
  directly to a headless host can still bounce a URL out to the host.

## URL semantics

| Form | Target | Notes |
|------|--------|-------|
| `ade://lane/<uuid>` | `{ kind: "lane", laneId }` | UUID v4 required. |
| `ade://session/<id>[?lane=<uuid>]` | `{ kind: "session", sessionId, laneId? }` | Local Work tab session link. Routes to `/work` with the selected session. |
| `ade://repo/<owner>/<repo>/branch/<branch>[?pr=<n>]` | `{ kind: "branch", repoOwner, repoName, branch, prNumber? }` | Cross-machine. Renderer routes to the lane that already owns the branch; otherwise it opens a create/import modal. PR-backed links use PR preflight, branch-only links fetch the remote branch and import it as a local lane. If no ADE project is open, the modal asks the user to open the matching project first. |
| `ade://pr/<owner>/<repo>/<number>` | `{ kind: "pr", repoOwner, repoName, prNumber }` | If the PR isn't yet local, the renderer jumps to the PRs tab pre-filtered or falls back to the create-lane-from-branch flow. |
| `ade://linear-issue/<ADE-123>[?branch=<branch>]` | `{ kind: "linear-issue", issueIdentifier, branch? }` | Linear hand-off. Opens ADE's Linear pane focused to the issue. If no project is open or this project is not connected to Linear, ADE shows a setup modal with the next action. |

Validation lives in one place (`shared/deeplinks.ts`) so the parser, the
TUI builders, and the web `/open` handler agree on what counts as
malformed.

## End-to-end flow

```
                      ┌────────────────────────────────────────────┐
                      │ Producer                                    │
                      │   - ade link …            (CLI clipboard)   │
                      │   - Ctrl+Y in ade code    (TUI copy)        │
                      │   - PR description footer (auto-rendered)   │
                      │   - Linear attachment     (post on lane)    │
                      │   - iOS share / chat app                    │
                      └────────────────────────────────────────────┘
                                         │
                          ade:// URL  or  https://ade-app.dev/open?...
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
  <img src="https://ade-app.dev/images/ade-mark.svg" height="18" align="left" alt="ADE">
  &nbsp;&nbsp;<strong>Open in ADE</strong>
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

Agent closeout still includes explicit links. `ade prs create` and the
private `create_pr_from_lane` action return both `githubUrl` and
`adeUrl` when available, and the text formatter prints them as separate
rows. The GitHub PR body footer is automatic, but the final chat or TUI
handoff should still include the GitHub URL and the ADE HTTPS PR URL so
the user can jump directly to either GitHub or the ADE PRs tab.

## Channel handling

Only the **Stable** channel claims `ade://` as the OS-default handler.
Beta and Alpha builds still install the single-instance lock and the
`open-url` / `second-instance` listeners (so a manual `duti` binding
still routes deeplinks to them), but they skip
`app.setAsDefaultProtocolClient` so they don't fight Stable for the
binding on machines where multiple channels are installed.

Source builds default to the same skip behavior and do not expose an env
override to claim the system binding. They can still dispatch URLs that are
explicitly delivered to that process, but the OS-default `ade://` handler is
reserved for the real packaged Stable desktop build. The gate lives in
`apps/desktop/src/main/main.ts` (packaged Stable channel detection) and the
registration mechanics live in `protocolHandler.ts` behind the
`claimAsDefault` option.

## Gotchas

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
  shape so the unfurl works. Use `ade://` when the target is guaranteed
  to be a machine with ADE installed (TUI copy, terminal share).
- **Linear hand-off doesn't carry the GitHub repo.** The `linear-issue`
  shape only has the identifier (`ADE-123`) and optionally Linear's
  generated branch name. The desktop opens the Linear pane to that issue
  inside the active project. From there the user can create a lane, start a
  chat, or connect Linear if this project has not been authorized yet. If no
  project is open, ADE shows a setup modal because the Linear issue identifier
  alone is not enough to choose a local repo.
- **Branch links are the portable lane form.** Lane UUID links are local, but
  branch links can be shared across machines. If the receiver does not already
  have that lane, ADE fetches remotes and imports the branch as a local
  worktree-backed lane. Without an active project, the import modal stays
  read-only and asks the user to open the matching ADE project first.
- **The PR footer is GitHub-flavored markdown, not full HTML.** Only the
  `<p>`, `<img>`, `<a>`, `<strong>` subset renders. Linear accepts the same subset.

## Cross-links

- [Pull requests](../pull-requests/README.md) — PR description rendering,
  footer integration.
- [Sync and multi-device](../sync-and-multi-device/README.md) — the
  iOS Send-to-Mac sync command bounces deeplinks to a paired host.
- [ADE Code](../ade-code/README.md) — `ade open` / `ade link` /
  `ade linear install` subcommands, `Ctrl+Y` copy.
- [System overview](../../ARCHITECTURE.md) — `IPC.appNavigate`, web /open
  route placement.
