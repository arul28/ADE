# Plugin page tier — spec (2026-09-03)

Owner decision after the Linear acceptance walk on the Alpha build: the JSON
vocabulary cannot reach the quality of the compiled pages. The webview becomes
the primary plugin page tier on desktop, hosted web and iOS. The terminal gets a
frozen subset of the vocabulary. The JSON vocabulary is frozen, not deleted,
until the last official plugin no longer needs it.

Acceptance for the first port (ade-linear): one-to-one design and behaviour with
the compiled Linear on desktop and hosted web; the same page on the phone in a
WKWebView; the terminal draws the plugin's terminal-profile panel. The compiled
Linear stays in the binary until the owner passes the walk.

Ticket: ADE-148. Research reports that fed this spec are summarised inline.

## 1. Decisions (locked)

| Topic | Decision |
|---|---|
| Page tier | A plugin ships its own HTML/JS page (`webview` surface). Desktop, web and iOS draw it in an isolated guest. |
| Build policy | Source in `src/`, prebuilt `dist/` committed. Vite. Official plugins build in CI. Install copies the tree as-is (5,000 files / 64 MiB cap, existing). |
| UI kit | `packages/ui` → `@ade-dev/ui`, tsup ESM+CJS+dts, React 18/19 peer, styles shipped as an injected string against `--ade-*` tokens (the `chat-ui` precedent). Published by the existing SDK workflow. The desktop app consumes it through `file:../../packages/ui` and re-export shims, so the two never drift. |
| Sockets | Stay declarative. A socket action may open a page in a popover (`{ openWebview: { surfaceId, placement: "popover" } }`). |
| Memory | One live guest per placement, destroyed when hidden. State lives in the plugin's collections, never in the guest (partition is non-persistent). |
| Terminal | Frozen "terminal profile": `list`, `group`, `text`, `badge`, `button`, `emptyState`. Everything else draws the existing unknown marker. No storage change. |
| Phone data | Reads from the replicated `plugin_*` tables (offline-capable); `invoke` and writes over RPC (existing generic action). |
| Phone assets | A sibling of `readArtifact` on the sync file channel serves the plugin's `dist/` from the install directory (same containment guard, 8 MiB per file); manifest of `{path, bytes, sha256}` first; phone caches by hash, keyed on plugin id + version; bundled official plugins ship their dist inside the iOS app as a pre-seeded cache. |
| Consistency | Not a requirement for third parties. Official plugins use the kit. |
| In-renderer React | Rejected: no isolation, coupling to internals, impossible on iOS. |

## 2. Bridge v2 (`window.adePlugin`)

Today: `collections.get/put/list`, `config.get/set`, `invoke`, `openDeeplink`;
event `changed`. `list` caps at 500 rows. The plugin id is derived from the
frame origin, never from the message.

Add (all host-side, closed list, no pluginId on the wire):

| Method | Args | Returns | Notes |
|---|---|---|---|
| `openSettings` | `{ entryId } \| { socketId }` | void | same resolution as the action answer; socket scoped to the caller |
| `surface.close` | — | void | closes the caller's popover/overlay/picker; no-op in a tab |
| `composer.attach` | `{ provider, issueId, identifier, title, url }` | void | same payload the socket `{composer}` answer carries |
| `composer.insert` | `{ text }` | void | |
| `ui.toast` | `{ level, message, actionLabel?, actionId? }` | `{ id }` | `ui.dismissToast(id)` |
| `ui.prompt` | `PluginActionPrompt` | answer or null | reuses the host prompt UI |
| `ui.confirm` | `{ title, body, confirmLabel, destructive? }` | boolean | |
| `clipboard.read` / `clipboard.write` | — / `text` | string / void | |
| `theme.get` | — | `{ scheme, tokens }` | plus event `theme` on `PLUGIN_THEME_CHANGED_EVENT` |
| `context.project` | (attach handshake) | `{ projectId, root, binding: "local" \| "remote" }` | added beside `context.subject` |
| `host.subscribe` | `{ kinds: ["lane","session","pr"] }` | unsubscribe | delivered on `events.on("host")` |

Invoke results honour the same control-flow answers the socket path honours:
`navigate`, `openUrl`, `openSettings`, `composer`, `prompt`, `dialog`, `message`,
`authSession`. Today `pluginWebviewBridgeServer.ts:211` returns the raw result and
the renderer ignores it.

Hot reload: the guest recreates when the plugin version changes (today only on a
source change or Try again). `ade plugin create --webview` scaffolds a page.

## 3. Page hosts

Desktop today: tab, Work-rail pane, drawer tab, one full-frame overlay. Add:

- **Popover** anchored under a top-bar or chat-header socket button, one at a
  time, Esc or click-away closes, `surface.close` closes.
- **Settings section**: a `settings-section` socket may name a `webview`
  surface; the section body is the guest, sized to content (ResizeObserver
  message from the page, capped).
- **Composer picker**: a `composer-action` may open a `webview` surface as a
  picker over the composer; `composer.attach` + `surface.close` finish it.
- **Destroy when hidden** for every placement (replaces "keep alive, stop
  painting").

Hosted web: the plugin page runs in a sandboxed `<iframe>` with a per-plugin
opaque origin. Dist bytes come over the sync socket (the same file channel the
phone uses) into a service-worker-backed cache under `/plugin-assets/<id>/<ver>/`;
the bridge is `postMessage` with the host as the only counterpart; `frame-src`
is allowed for that path. Same placements as desktop.

iOS: `WKWebView` in a `UIViewRepresentable`; a `WKURLSchemeHandler` serving the
cached dist under `ade-plugin://<id>/`; a `WKScriptMessageHandler` bridge with
the same method list (writes and `invoke` over RPC; reads from the local
mirror); a content policy equal to the desktop CSP; placements: sheet (tab),
popover on iPad, settings section, composer picker. App Store rule 2.5.2 permits
JavaScript in WebKit.

## 4. UI kit (`packages/ui`)

First cut = exactly what the compiled Linear pages import: `Button`, `cn`,
`vcsIcons` (`BranchIcon`), `laneDesignTokens` (`COLORS`, `SANS_FONT`,
`MONO_FONT`, `LABEL_STYLE`, `primaryButton`, `outlineButton`),
`settingsSectionUi` shell, `automations/shared` input styles, the markdown stack
wrapper (`chatMarkdown` over react-markdown + remark-gfm + rehype-sanitize),
`PaneHeader`, `EmptyState`, `Chip`, the Linear brand/priority/state/project
icon set, and the theme tokens as CSS variables.

Rules: no Tailwind at runtime (styles ship as a string), no `useAppStore`, no
Electron, no app routing. `SmartTooltip` and `vocabularyCanvas` are excluded
from the first cut. Fonts (Geist, JetBrains Mono woff2) are vendored into the
plugin directory; the protocol already serves them and the CSP allows
`font-src 'self'`.

## 5. The Linear port

Move, do not rewrite: `LinearIssueBrowser` (1,874), `LinearQuickViewButton`
(814, the page half), `LinearSection` (905), `LinearPaneModal`,
`LinearIssueSelectModal`, `LinearIssueResolveModals`, `BatchLaunchStatusToast`,
`linearBatchLaunch`, `linearIssueQuickViewNavigation`, `LinearIssueBadge` hover
card, `linearBrand`, `linearProjectIcon`, `linearIssueDisplay`,
`LinearTriggerFilters`, `UserMessageIssueContext`.

Host calls map as: Linear API → the plugin's own client via `invoke`; token and
OAuth → child (`secrets`, `auth.beginSession`) via `invoke`; lanes/chats/launch →
`actions.invoke` via `invoke`; navigation → `openDeeplink`; settings →
`openSettings`; composer → `composer.attach`; toasts, prompts, clipboard,
theme, project context, live updates → the new verbs. Filters and selection move
from `localStorage` to collections.

Placements: rail tab (browser, full page), top-bar popover (quick view), Settings
Integrations section (LinearSection), composer picker (issue select), chat
header action (issue select popover), lane badge hover card (socket +
popover), Create-lane and Create-PR pickers (socket + picker). Automations
trigger tile, filters and templates: declarative sockets as today.

Terminal: the plugin publishes a terminal-profile panel (issues list with
state/priority badges, launch actions) alongside the page.

Seam test: a fake-bridge end-to-end test that mounts the built page against a
scripted bridge and walks sign-in, list, open, state change, comment, launch.

## 6. Waves

1. Platform: bridge v2 + control-flow answers (main/preload/shared); desktop
   placements + destroy-when-hidden (renderer); `packages/ui` kit + desktop
   consumption; hot reload + scaffold; terminal profile freeze.
2. Linear port to the page tier (plugin) + sockets rewired + seam test; hosted
   web host; iOS host + asset channel; MacBook builds; acceptance walk.
3. Cursor Cloud, Review, History, Graph, Control, Simulator on the page tier;
   delete the JSON vocabulary when the last official plugin no longer needs it.
