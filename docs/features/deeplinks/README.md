# Deeplinks

One URL contract lets every DAEX surface (desktop, iPhone, web client, site)
and outside tools (GitHub PR bodies, Linear, Slack) point at the same lane,
chat, file, commit, artifact, branch, PR, Linear issue, automation run or
Settings card.

- **New links are `daex://`** (`BRAND.LINK_SCHEME_FOR_NEW_LINKS`; iOS
  `Brand.linkSchemeForNewLinks`), including links forwarded to a phone or
  another computer.
- **`ade://` opens forever.** The desktop registers both schemes
  (`build.protocols` in `apps/desktop/package.json`; the handler claims every
  scheme in `ADE_DEEPLINK_SCHEMES`), iOS lists `ade`, `daex`, `ade-beta`,
  `daex-beta` (`Brand.linkSchemes`), and every parser accepts both.
- **Minting `daex://` is safe because of the launch gate**: the account server's
  minimum version (`GET /client/minimum`, `shared/clientUpdateGate.ts`, iOS
  `ClientUpdateGate.swift`) forces an `ade://`-only app to update. Builds up to
  v1.2.130 predate the gate and cannot open `daex://`.
- **The HTTPS form** is `https://ade-app.dev/open?type=…`
  (`ADE_DEEPLINK_HTTPS_HOST`; the open host has not moved to daex.dev).
  `app.ade-app.dev/open` (the web client's own form) is accepted too.

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
https://ade-app.dev/open?type=session&id=<id>[&lane=…&event=…&offset=…]
https://ade-app.dev/open?type=pr&repo=<owner>/<repo>&number=<n>
(… the same shapes with type=file|commit|artifact|branch|linear-issue|automation-run|settings|lane-share)
```

Lane, session, commit and artifact links also carry a portable **envelope**
(`repo`, `branch`, `pr`, `linear`); chat, lane and PR links carry **ownership**
(`accountMachineKey` + `projectId`).

## Source file map

- `apps/desktop/src/shared/deeplinks.ts` — the one builder and parser (main,
  renderer, CLI, the web `/open` route): `buildDeeplink`, `parseDeeplink`,
  `looksLikeAdeDeeplink`, `describeTarget`, `DeeplinkTarget`, `DeeplinkEnvelope`;
  all validation lives here.
- `apps/desktop/src/shared/githubRemote.ts` — the one GitHub remote parser.
- `apps/desktop/src/shared/adeDeeplinkFooter.ts` — the "Open in DAEX" footer for
  PR bodies and Linear attachments (idempotent `<!-- ade:link v=1 … -->`
  markers).
- `apps/desktop/src/shared/types/core.ts` — `AppNavigationTarget`,
  `AppNavigationRequest`, `AppNavigationResult`.
- `apps/desktop/src/main/services/deeplinks/protocolHandler.ts` — registers both
  schemes, the single-instance lock, `open-url` / `second-instance`, buffering
  before `whenReady`, `handleDeeplinkUrl` (also used by `deeplinks.open`), logs
  to the machine logger.
- `apps/desktop/src/main/services/deeplinks/ownerAwareNavigation.ts`,
  `localProjectResolution.ts`, `projectNavigationWindowSelection.ts` — owned
  routing, resolving a link's project on this machine, picking the window.
- `apps/desktop/src/main/services/projects/repoProjectResolver.ts` —
  `project.findForRepo` (git origin from `.git/config`, cached by mtime).
- `apps/desktop/src/renderer/components/app/App.tsx`
  (`AppNavigationBridge.dispatchTarget`), `InboundDeeplinkModal.tsx`,
  `renderer/lib/otherMachineNavigation.ts`, `renderer/lib/linkOwnership.ts`,
  `renderer/components/terminals/pendingSessionAnchors.ts`.
- `apps/ade-cli/src/commands/deeplinks.ts` — `daex open`, `daex link`,
  `daex linear install`.
- `apps/web/src/app/pages/OpenPage.tsx`, `apps/web/api/open.ts` (OG rewrite),
  `apps/web/vercel.json`, `apps/web/api/device.ts`.
- iOS: `App/DeepLinkRouter.swift`, `Views/Lanes/LaneDeeplinkHelpers.swift`
  (minting), `Views/Deeplinks/SendToMacCard.swift`,
  `Services/DeviceSignInApproval.swift`, `Views/Account/DeviceSignInApprovalSheet.swift`;
  Universal Links via `applinks:ade-app.dev` and
  `apps/web/public/.well-known/apple-app-site-association` (`/open*`, `/pair*`,
  `/device` with a `user_code`).
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts`,
  `syncHostService.ts` — the `deeplinks.open` sync command (Send to your Mac).

## Gotchas

- **Mint with `buildDeeplink`, accept both schemes.** Never hand-write `ade://`
  or `daex://`; check `ADE_DEEPLINK_SCHEMES`. iOS still routes internally on
  `ade` (`withADEScheme`); its sign-in callbacks stay `ade`.
- **Send-to-Mac goes to the paired host's project** window or tab, never the
  focused window.
- **Register the protocol handler before `app.whenReady()`**, or cold-start URLs
  are lost.
- **Validate before dispatch**, even for "trusted" callers (Linear's templates
  can produce empty strings).
- **Use the HTTPS form where previews matter**; `daex://` where DAEX is surely
  installed.
- **A Linear hand-off has no repo**: the desktop opens the Linear pane in the
  active project, or a setup modal with none open.
- **Branch links are the portable lane form**; a receiver without the lane
  imports the branch as a new lane.
- **The PR footer uses only `<p>`, `<img>`, `<a>`, `<strong>`.**
- **Never stamp `projectRoot`** on a link (it leaks the username and layout);
  `projectId` is the canonical `deriveProjectId(rootPath)`.

## URL semantics

| Form | Target | Notes |
|------|--------|-------|
| `lane/<uuid>` | `lane` | UUID v4. |
| `session/<id>` | `session` | Work session; `event` anchors a chat message by sequence, `offset` positions terminal replay. |
| `file/<path>` | `file` | Opens Files at the path (in the lane worktree with `lane`), reveals `line`; traversal refused. |
| `commit/<sha>` | `commit` | The owning lane's detail; foreign fallback is the GitHub commit. |
| `artifact/<id>` | `artifact` | Local proof artifact. |
| `repo/<owner>/<repo>/branch/<branch>` | `branch` | The lane that owns the branch, else a create/import modal. |
| `pr/<owner>/<repo>/<n>` | `pr` | The PRs tab, or create-lane-from-branch. |
| `linear-issue/<KEY>` | `linear-issue` | The Linear pane focused on the issue. |
| `automation-run/<rule>/<run>` | `automation-run` | `/automations?rule=&run=`; phones and the web open the run's chat. Takes ownership. |
| `settings/<entry-id>` | `settings` | One card by its `shared/settingsManifest.ts` id; `machine` picks a Computer page. |
| `lane-share/<grant-id>` | `lane-share` | Invite to a shared lane (`ls_` + 32 hex); routes to `/shared?grant=<id>` ([lane sharing](../lanes/lane-sharing.md)). |
| `open/<place>` | `open` | A page from `shared/openPlaces.ts`; chip click only, refused by the protocol handler. |

## Ownership

Chat, lane and PR links carry `accountMachineKey` and `projectId` together.

- **Stamped by** Activity items, DAEX MCP results, `daex chat inbox`, `daex link`
  (brain action `get_link_ownership`, only when the current project holds the
  item), the Work and lane menus' Copy link / Open in web
  (`remoteRuntime.linkOwnership`), and the Linear agent's cards
  (`localLinkOwnership`).
- **Desktop**: owned targets go through `ownerAwareNavigation.ts`; an owned link
  clicked inside DAEX uses `IPC.appOpenOwnedDeeplink`. A gone item says "no
  longer in this project".
- **Web and iPhone** connect the machine, open the project, then the item
  (`webclient/shell/ownedLinkResolution.ts`; iOS waits up to 10 minutes for the
  account and offers to wake a sleeping Mac, see
  [iOS companion](../sync-and-multi-device/ios-companion.md#waking-a-sleeping-mac)).
- An owner inferred from local snapshots is used only for links from outside the
  app, never a cold-launch restore.

## The `/open` page

`OpenPage.tsx` (at `https://ade-app.dev/open`) offers **Open in the DAEX app**
(`daex://`), **Open in your browser** (`https://app.ade-app.dev/open`, the web
client's own origin), **Install DAEX**, and on iPhone/iPad **Open in DAEX Beta**.
**Remember my choice** stores `ade.openLinksIn` (`app` | `web`); a remembered
choice opens after 1.5 s with Change and Open now. While choices show, the page
frames the web client's `/link-status` for up to 4 s (only an
`ade-link-status` message from that origin counts) and orders the choices by
whether the account has a computer online. `apps/web/api/open.ts` rewrites title
and OG tags for unfurlers.

## Portable envelopes and the resolution ladder

`AppNavigationBridge.dispatchTarget` resolves strictly:

1. **Local** — the id resolves in the active project: open it, anchors included.
2. **Another connected machine** — the cross-machine union holds it for the same
   repo (`otherMachineNavigation.ts`): open it there, no card. It waits up to 3 s
   for the union. An explicit `machineId` beats a local lane with the same id.
3. **Another known project** — the envelope repo matches another project
   (`project.findForRepo`): "Switch project and open".
4. **Foreign** — a card offering only what the envelope carries (create a lane
   from the branch, open the PR or commit on GitHub, open the Linear issue).

All cards are `InboundDeeplinkModal`. Envelope parsing is lenient.

**Session anchors** (`event`, `offset`) cross IPC and are handed one-shot to the
content surface through `pendingSessionAnchors.ts` (chat scroll and highlight,
terminal byte-fraction scroll). Search emits chat anchors as the persisted
`envelope.sequence`.

## Outbound: CLI and PR footer

- `daex open <url>` uses the OS opener (`open`, `xdg-open`, `rundll32.exe
  url.dll,FileProtocolHandler` with the URL as one argument) for a validated
  `daex://` or `https://ade-app.dev/open` URL. `--linear-issue <id> --branch <b>`
  is what Linear's "Open issue in coding tool" passes.
- `daex link …` builds a link and copies it: HTTPS by default, `--ade` for
  `daex://` (the flag keeps its old name), `--web` for the web client form;
  `daex link <url>` re-emits a parsed URL.
- `daex linear install` writes `~/.linear/coding-tools.json` (with a backup).
- `prService.ts` calls `ensureAdeDeeplinkFooter` on PR create and update (branch
  link first, PR link after the number is known). `daex prs create` returns
  `githubUrl` and `adeUrl`; agents put both in their handoff.

## Device sign-in links

`https://ade-app.dev/device?user_code=ABCD-EFGH` (also `daex://device?...`) is the
QR code `daex connect` and the desktop sign-in card show. On iOS it opens
`DeviceSignInApprovalSheet` (computer name from `GET /device/approve`; Approve
runs the directory's one-time Clerk sign-in in an ephemeral web sheet). In a
browser, `apps/web/api/device.ts` redirects to the directory's `/device` page.

## Channel handling

Both schemes are declared in `build.protocols` (macOS `CFBundleURLTypes`);
Windows writes `HKCU\Software\Classes\daex` and `\ade` at runtime (the app is
still `ADE.exe`). Only the packaged **Stable** channel claims the OS default
(`claimAsDefault`, gated in `main.ts`); Alpha and source builds keep the
listeners but never call `app.setAsDefaultProtocolClient`. Desktop betas are the
same `com.ade.desktop` app as Stable. On Linux the claim names a desktop entry
(`native/appImageDesktopEntry.ts` writes one for an AppImage). A launch that
loses the single-instance lock exits before the boot, having handed its URL to
the running copy.

## Cross-links

- [Pull requests](../pull-requests/README.md)
- [Sync and multi-device](../sync-and-multi-device/README.md)
- [System overview](../../ARCHITECTURE.md)
