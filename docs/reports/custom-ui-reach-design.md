# Extending ADE's custom-render tier into existing chrome

Design doc. Author: research pass on `plugin-platform`, 2026-08-25. Read-only investigation; no product code changed.

Audience: the product owner deciding what to fund, and the future implementer. Every claim is anchored to `file:line`.

---

## The gap, in one paragraph

An ADE plugin has two ways to draw UI. Tier 1 is a **declarative vocabulary**: the plugin ships strict JSON (`VocabPanel`) naming components from a fixed set, and desktop, web, iOS and the TUI each render that JSON with their own native widgets (`apps/desktop/src/shared/plugins/vocabulary.ts:1`). It mounts anywhere ADE has a socket for it — 17 socket kinds across 8 surfaces (`apps/desktop/src/shared/plugins/sockets.ts:41`) — but a plugin can only say what the vocabulary can say. Tier 2 is a **webview**: the plugin's own HTML/JS/CSS in a sandboxed Electron guest (`apps/desktop/src/renderer/components/plugins/PluginWebviewHost.tsx:44`). It can draw anything, but it is desktop-only and it can only mount as its **own full tab or pane** — the surface kinds are exactly `tab | pane | webview` (`apps/desktop/src/shared/plugins/manifest.ts:114`), and the host fills the whole frame with it (`apps/desktop/src/renderer/components/plugins/PluginTabPage.tsx:74`). There is **no way for custom-rendered UI to appear inside ADE's existing chrome** — a chat-header button that animates, a custom-drawn badge on a row, a composer control, a card in the transcript that draws its own canvas. The Tipsy retro's motivating example — "the button fills up like a glass as the drink count rises" — is unbuildable today: the button is a Tier-1 chrome contribution (`chat-header-action`, a fixed label + icon + action, `apps/desktop/src/shared/plugins/sockets.ts:597`), and custom rendering only exists as a Tier-2 pane.

---

## How each tier works today

### Tier 1 — the declarative vocabulary and its sockets

**The vocabulary.** A panel is `{v, title?, fallback, body}` where `body` is a tree of nodes (`apps/desktop/src/shared/plugins/vocabulary.ts:86`). The component set is thirteen names: `stack, text, badge, button, list, table, form, chart, video, image, divider, keyValue, emptyState` (`apps/desktop/src/shared/plugins/vocabularyNodes.ts:68`). Four rules make one wire contract safe across four independent release trains (desktop auto-update, App Store review, npm, web):

1. The component union is **open** (`| (string & {})`, line 82) — an unknown name renders a small "not supported here" node, never a crash.
2. `fallback` (title + text + optional deeplink) is **required on every panel** — the floor a client draws when it cannot render at all (`vocabulary.ts:79`, `:253`).
3. **Data, never code.** No expressions, no format strings, no conditionals, no callbacks. A binding names a `plugin_collections` collection the plugin already wrote render-ready rows into; an action names a plugin action id the host dispatches (`vocabulary.ts:36`, `vocabularyNodes.ts:126`).
4. **Limits are part of the contract**, enforced identically everywhere: 200 nodes, depth 8, 64 KB schema, etc. (`vocabularyNodes.ts:31`).

**How a contribution reaches chrome.** A manifest `sockets[]` entry names a `socket` kind and a `surface` (`manifest.ts:215`). The host validates the payload once, per kind, through `parsePluginContributionPayload` — the single gate every surface calls (`sockets.ts:837`). A malformed payload renders nothing rather than a half-built row (`sockets.ts:24`). Two invariants the host enforces and clients rely on: placement is host-controlled and always **after** core content (a plugin never reorders or replaces the product's own rows), and payload shape is per-kind (`sockets.ts:20`). Static contributions come from the manifest; **dynamic per-entity** values (this PR's badge, this lane's menu item) come from `plugin_contributions` rows written by the machine that owns the data (`sockets.ts:33`).

The chat-header button is `chat-header-action`. Its payload is `PluginActionButtonPayload` — `label, icon?, actionId, disabled?, menu?` (`sockets.ts:477`, `:597`). It mounts on the header every chat surface shares (`apps/desktop/src/renderer/components/work/WorkSurfaceHeader.tsx`, the `PluginToolbarActions`-family component, and `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` supplies the session context). The point to hold onto: **the payload has no visual state a plugin can drive.** It is a label and an action id. There is no field for a fill level, a progress value, an animation, or a custom drawing. A `row-badge` is the same story — `text, tone, icon?, tooltip?` (`sockets.ts:532`), four tones, no red (`vocabularyNodes.ts:89`). The `chat-card` kind is "a panel in a card frame" — payload is a `panelId` and nothing else (`sockets.ts:609`), so a transcript card is exactly as expressive as the vocabulary and no more.

**Why declarative-only.** A socket contribution is drawn by native widgets on four clients that ship on four schedules. iOS decodes ten of the seventeen kinds at compile time and maps an unknown `socket` string to `.unsupported` (`sockets.ts:266`, the `PLUGIN_SOCKET_CLIENT_SUPPORT` table). Adding an eighteenth kind is "a platform change with a parity cost on four clients" (`sockets.ts:9`). The vocabulary is the mechanism that lets one declaration reach all four; a custom-drawn control has no native widget to map to, which is exactly why it is confined to the webview escape hatch.

**How a panel stays fresh.** `PluginPanelHost` fetches the schema and the collections it binds, and re-fetches on the host's `changed` stream — but only for a *visible* panel; a hidden one refetches once on reveal (`apps/desktop/src/renderer/components/plugins/PluginPanelHost.tsx:36`). This is a data round-trip, not a render loop. A "fill" that animated by the plugin writing a new value and emitting `changed` per frame would be an IPC/sync storm; smooth motion has to live on the client side of this boundary (see Option A).

### Tier 2 — the webview, and its real security model

A `webview` surface renders the plugin's own HTML in a sandboxed guest. The security model is deliberate and worth stating precisely, because every option below either inherits it or has to re-earn it:

- **One origin per plugin.** Pages are served over a custom scheme `ade-plugin://<pluginId>/<path>` (`apps/desktop/src/main/services/plugins/pluginWebviewProtocol.ts:1`). The custom scheme exists *for* the origin: `file:` would share one origin across every plugin and the whole filesystem; one origin per plugin makes the browser's own same-origin machinery do the isolation (`pluginWebviewProtocol.ts:5`).
- **The install directory is the whole world.** Every request resolves against `<pluginRoot>` and is refused unless its real path (symlinks followed) stays inside it; a refusal is a 403 with no bytes, a directory is a 404 not a listing (`pluginWebviewProtocol.ts:149`, `:207`, `:234`). Only an installed *and enabled* plugin has an origin at all; disabled = 404 (`pluginWebviewProtocol.ts:189`, `:267`).
- **Locked-down guest.** The attach handler sets `sandbox = true`, `nodeIntegration = false`, `contextIsolation = true`, `webSecurity = true`, `nodeIntegrationInSubFrames = false`, `webviewTag = false` (`apps/desktop/src/main/main.ts:895`–`904`), on a **non-persistent** partition `ade-plugin-<pluginId>` — the page's cookies, storage and caches die with the window, so plugin state has to live in collections where it is budgeted, synced and visible in the usage meter (`apps/desktop/src/shared/plugins/webviewBridge.ts:85`).
- **Strict CSP on every response, refusals included.** `default-src 'self'; script-src 'self'; connect-src https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'` (`webviewBridge.ts:114`). No CDN escape — a plugin vendors its libraries. `img/media-src` reach `https:` because images do not execute; `connect-src https:` because a plugin is ambient-trust code the user installed and its child process already reaches the network (`webviewBridge.ts:98`).
- **A small, scoped bridge.** `window.adePlugin` is exposed via `contextBridge` (not `postMessage`, so there is no channel an injected script can also post on — the function reference *is* the capability, `webviewBridge.ts:28`). It carries **no plugin id on the wire**: the host derives the id from the guest's own origin and cross-checks it against the registry entry written at attach time, so a page cannot forge identity (`webviewBridge.ts:19`, `apps/desktop/src/main/services/plugins/pluginWebviewBridgeServer.ts:117`). The method set is a deliberate subset of the child SDK — `collections.get/put/list, invoke, config.get, openDeeplink`, plus a `changed` event — with `secrets`, `contributions.publish`, `panels.update` and `collections.delete` all absent on purpose (`webviewBridge.ts:138`). `BRIDGE_VERSION` is 1 and additive (`webviewBridge.ts:41`).
- **A whole extra renderer process.** The host comment states it directly: "a webview is a whole extra renderer process" (`PluginWebviewHost.tsx:29`). It is created imperatively (not JSX) so its partition is right at insert time (`:71`), deferred until first reveal and kept but unpainted when hidden (`:63`, `:122`).
- **Desktop-only, with an honest fallback.** `supportsPluginWebviews()` is `!isWebClientMode()` (`PluginWebviewHost.tsx:193`); the hosted web client has no `<webview>`, no custom protocol, no preload. Every `webview` surface still **requires** a `panelId`, and that vocabulary panel is what iOS, web and the TUI render in its place — "desktop-only degrades to the plugin's own sentence and an open-on-desktop link rather than to a blank space" (`manifest.ts:98`, resolved at `PluginTabPage.tsx:73`).

**Why you can't just drop 50 webviews into a transcript.** Each `<webview>` is an OS-level `WebContentsView` / out-of-process guest with its own renderer process, its own V8 heap, its own compositor surface. Fifty in a scrolling transcript means fifty renderer processes (hundreds of MB, plus GPU surfaces), each a separate paint/composite root that does not share ADE's scroll or z-index context, each needing focus arbitration against the transcript, and each a desktop-local object the phone and web client cannot show at all. That is the real constraint every "custom render inside chrome" option has to design around.

---

## The options

| Option | Cross-client parity | Security / sandbox | Perf / instancing | Sync | Size |
|---|---|---|---|---|---|
| **A. Grow the vocabulary** (fill/progress + animation tokens + gauge/sparkline) | Full, by construction — desktop/web/iOS/TUI each draw it natively | No new surface; same data-only contract, no new code execution | Cheap — one more native node per panel; motion is client-side interpolation | Rides existing collections + `changed`; no new sync object | **S** (fill/progress), **M** (animation tokens, gauge) |
| **B. Micro-webview socket** (webview into a bounded slot) | Desktop-only; web/iOS/TUI show the required `panelId` fallback | Inherits the full Tier-2 model; new work is *scoping the slot* and capping instances | Expensive — one renderer process per live instance; needs a hard per-surface cap and reveal-gating | Desktop-local; phone shows the fallback panel, never the custom render | **L** |
| **C. Sandboxed non-webview renderer** (constrained canvas / declarative-animation runtime) | Potentially portable, but nothing in ADE points at it today — greenfield on every client | New sandbox to design and defend from scratch (no Node, no DOM escape, CPU/GPU budget) | Cheaper to instance than a webview *if* it shares the host process; unproven | Depends on the model chosen | **XL** |
| **D. Hybrid** (Tier-1 shell + opt-in Tier-2 slot where the author accepts desktop-only) | Shell is full-parity; the custom patch is desktop-only with fallback | = A for the shell, = B for the patch | = A for the shell, = B for the patch | = A for the shell, = B for the patch | **L** (A + B, sequenced) |

### Option A — grow Tier 1's vocabulary

**What it is.** Add expressive-but-declarative primitives that the four clients each draw natively. The high-leverage ones, in order:

1. **A `progress` / `fill` node.** `{component: "progress", value: 0..1, max?, tone?, label?, style?: "bar" | "fill"}`. This answers the Tipsy example directly: the "glass" is a `fill`-styled progress node inside the `chat-card` panel (or, if a header control is wanted, see the note below). The plugin writes the count to a collection; the node's `value` binds to it; each client draws its own fill. Adding a component is "one line" in `VOCAB_COMPONENTS_V1` plus a parse arm plus a renderer arm per client (`vocabularyNodes.ts:650`).
2. **Animation tokens on existing nodes.** A small, closed set — `transition?: "none" | "ease" | "spring"`, `pulse?: boolean` on `badge`, `animate?: boolean` on `progress`. The client interpolates from the previous value to the new one **on its own side** of the `changed` boundary, so motion is smooth without an IPC storm (this is the reason the fill has to be a native node, not a plugin-drawn frame loop — see `PluginPanelHost.tsx:36`).
3. **A `gauge` / `sparkline`.** The `chart` node already exists but is deliberately sparse — line/bar, ≤3 series, ≤200 points, no axes (`vocabularyNodes.ts:246`). A radial `gauge` and an inline `sparkline` are the two shapes it cannot make and that dashboards actually ask for.
4. **(Ceiling-pushing) a constrained declarative-canvas node.** A fixed grammar of shapes (`rect/circle/line/path/text` with tone tokens and bounded counts), *not* arbitrary drawing code. This is where Option A starts to shade into "reinventing SVG," and is the natural boundary with Option C.

**The header-button sub-case.** The Tipsy ask was specifically a *button that fills*. Two honest sub-paths: (a) extend `PluginActionButtonPayload` with an optional `fill?: 0..1` / `progress?` field read by the three button kinds (`sockets.ts:477`) — small, and it makes the exact retro example buildable in chrome; or (b) keep the button plain and put the glass in an adjacent `chat-card`. Path (a) is the smaller, more direct win and is the recommended first slice.

**Parity.** Full and by construction. A `progress` node reaches iOS, web and the TUI the moment each grows a one-line arm; until then it degrades to its `fallback` like any unknown component (`vocabularyNodes.ts:63`). No desktop-only surface, no fallback authoring burden beyond what every panel already carries.

**Security.** None added. The data-only contract is unchanged: a `value` is a number in a collection row, not code. No new execution surface, no new sandbox.

**Perf.** Negligible — one more native node per panel, motion is CSS/native animation on the client. No new process.

**Sync.** Rides the existing `plugin_collections` + `changed` machinery. Nothing new crosses the wire.

**The ceiling.** Every primitive is a platform change with a four-client parity cost (`sockets.ts:9`), so the vocabulary can only grow as fast as the team funds native arms on each client. And it can only ever express what a *closed* set of components can express. The moment a plugin needs genuinely arbitrary layout or interaction — a custom timeline, a drag-to-reorder board, a WebGL visualization — Option A cannot reach it without becoming HTML. The design boundary to hold: **add primitives that answer recurring, nameable shapes (progress, gauge, sparkline); refuse primitives that are just "a box you draw into."** The latter is Option C's job, done properly, not a vocabulary node done badly.

### Option B — a micro-webview socket

**What it is.** Let a `webview` mount into a **bounded slot** — a card body in the transcript, a header popover, a section inside a pane — instead of only a full tab/pane. Concretely, a new socket kind (e.g. `webview-card`) or an `entryHtml` field on `chat-card` / `detail-section`, resolved by the same `ade-plugin://` protocol and the same attach handler, but sized to a slot rather than the frame.

**The hard problems, each real:**

- **Per-instance process cost.** Every slot is a renderer process (`PluginWebviewHost.tsx:29`). A transcript or a PR list can have many rows; N visible slots = N processes. This *must* be capped hard — a small per-surface ceiling (single digits), reveal-gated so off-screen slots hold no guest (the existing `revealed` gate, `PluginWebviewHost.tsx:63`), and virtualized so scrolling does not spawn a process per row. Without a cap this is a memory and GPU-surface catastrophe.
- **Desktop-only degradation, per slot.** `supportsPluginWebviews()` is false on web (`:193`) and the concept does not exist on iOS/TUI. Every slot needs the same required-`panelId` fallback the full surface has (`manifest.ts:98`) — so the author writes *both* a vocabulary panel and an HTML page for one contribution, and accepts that the phone only ever sees the panel. This is the honest cost: the custom render is a desktop luxury layered over a portable floor.
- **Bridge scoping.** The bridge derives identity from origin (`webviewBridge.ts:19`), which still holds in a slot. But a slotted webview needs *context* the full surface does not — which chat, which PR, which row it sits on. That context has to reach the guest without letting it forge the subject, i.e. the host injects it (as the socket context already does for native contributions, `sockets.ts:597`), never the page claiming it.
- **Sizing and reflow inside ADE's layout.** A full-frame guest fills its container; a slot guest has to report or accept a size and reflow with the transcript. `<webview>` does not participate in the parent's CSS layout — its height is imperative. A card that grows with its content needs a resize protocol (guest posts a desired height, host clamps it), which is new surface area and a new way for a page to misbehave (claiming 10,000 px).
- **The sync story.** A webview is a desktop-local object; the phone shows the fallback panel and never the custom render. So a "canvas card in the transcript" is, on the phone, a vocabulary card — which is fine *if the author designed the fallback to carry the meaning*, and a broken promise if they treated the HTML as the real thing and the panel as an afterthought.

**Parity / security / perf / sync.** Desktop-only with fallback; inherits the full Tier-2 security model unchanged (the sandbox, CSP, origin isolation all still apply); expensive to instance and gated by a hard cap; desktop-local sync with a panel fallback on every other client.

**Size: L.** The protocol, sandbox and bridge already exist and are reused wholesale — the new work is the slot: a new socket kind or surface field, the instance cap + virtualization, the resize protocol, the per-slot context injection, and a fallback-authoring path. That is real but bounded, because the dangerous half (isolation) is done.

### Option C — a sandboxed non-webview custom renderer

**What it is.** A custom-drawing surface that is *not* a full Electron webview — e.g. a constrained JS/canvas runtime (QuickJS or a locked-down worker driving a `<canvas>`) or a declarative-animation runtime (a Lottie/Rive-style document the client plays). The appeal: cheaper to instance than a whole renderer process, and potentially portable to iOS/TUI in a way a webview never is.

**Does anything in ADE point at this today? No.** A search for `lottie`, `rive`, `skia`, a plugin canvas, `quickjs`, or a wasm sandbox in the plugin code and the renderer finds nothing (verified across `apps/desktop/src/shared/plugins` and `apps/desktop/src/renderer/components/plugins`, and `framer-motion`/animation libs are not used in the renderer). This is **greenfield on every client.** There is no existing sandbox to extend, no animation runtime already shipped, no canvas-plugin precedent.

**The costs, honestly:**

- **A new sandbox to design and defend from scratch.** The webview's isolation is the browser's, earned by decades of same-origin and process-sandbox work (`pluginWebviewProtocol.ts:5`). A bespoke JS/canvas runtime means re-earning CPU budgeting, memory caps, denial-of-service resistance (an infinite draw loop), and the guarantee that "draw" cannot reach the DOM, the network, or the filesystem. This is the highest-risk option precisely where risk is most expensive.
- **A declarative-animation document (Lottie/Rive) is the safer shape of C** — it is data, not code, so it inherits the vocabulary's "data, never code" safety (`vocabulary.ts:36`) and could ride the same collections + `changed` plumbing. But it is a large new renderer on every client (a Lottie player on desktop, web, iOS *and* the TUI, which cannot play one at all), and it answers only *animation*, not *interaction*.
- **A canvas + constrained-JS runtime** answers interaction too, but is the full XL: a language sandbox, a frame budget, an input model, on four clients.

**Verdict on C:** the right long-horizon answer *if* the product's ambition is genuinely arbitrary, portable, cheap-to-instance custom UI — but it is a platform investment, not a feature, and nothing in the codebase reduces its cost today. It should not be the first thing built.

### Option D — hybrid (Tier-1 shell + opt-in Tier-2 slot)

**What it is.** The author writes a Tier-1 vocabulary shell (full parity, the floor) and *optionally* opts one region into a Tier-2 webview slot for desktop-only custom render, with the vocabulary version as the declared, required fallback. This is not a third mechanism — it is Options A and B sequenced and composed: A gives the shell more expressive floors, B gives the opt-in patch. The manifest already models exactly this shape (a `webview` surface that *must* carry a `panelId` fallback, `manifest.ts:98`); Option D generalizes that pattern from "whole surface" to "region within chrome."

**Why it is the right *end state* rather than a separate build:** it makes the desktop-only cost explicit and opt-in per region, keeps the cross-surface promise honest by construction (the fallback is required, not encouraged), and lets most plugins never touch a webview at all because the grown vocabulary (A) covers them. Its size is L because it *is* A + B; there is no separate D to fund.

---

## Recommended ordering

Cheapest high-leverage win first, biggest platform bet last.

1. **A.1 — a `progress`/`fill` node, plus an optional `fill?` on the action-button payload (S).** This is the single change that makes the Tipsy example buildable in chrome, with full four-client parity, no new security surface, and no new process. Fund this first and independently; it is a week-class change, not a quarter-class one.
2. **A.2 — animation tokens + a `gauge`/`sparkline` (M).** Client-side interpolation across the `changed` boundary, and the two dashboard shapes the sparse `chart` cannot make. Still full parity, still data-only.
3. **B — the micro-webview slot (L), *only when* a real plugin needs genuinely arbitrary render inside chrome and the team accepts a desktop-only region with a mandatory panel fallback.** Reuses the entire existing Tier-2 isolation stack; the new work is the slot (cap, virtualization, resize protocol, context injection). This is Option D's custom half; shipping B on top of A *is* shipping D.
4. **C — a sandboxed non-webview renderer (XL), only as a deliberate platform initiative** if portable, cheap-to-instance custom UI becomes a strategic goal. Start with the *declarative-animation* shape (data, not code) before ever considering a JS/canvas sandbox, because the former inherits the vocabulary's safety and the latter re-earns the browser's from zero.

The through-line: **grow the vocabulary until it stops being able to name the shape, then reach for a webview slot with an honest fallback, and only build a bespoke sandbox if the product's ambition genuinely outruns both.**

---

## Do not build

- **Arbitrary webviews in every socket.** A webview per row/badge/header across the list surfaces is a process-count and security nightmare: each is a full renderer process (`PluginWebviewHost.tsx:29`), none share ADE's scroll/z-index/focus context, and all are desktop-local with no phone story. If B is built, it is *capped, virtualized, reveal-gated slots in a few named places*, never an open `entryHtml` field on any socket.
- **A webview that participates in ADE's layout as if it were a DOM node.** `<webview>` is an OS-level view; letting a guest's self-reported height drive ADE's reflow unbounded lets a page claim 10,000 px and shove the transcript around. Any slot resize is host-clamped.
- **Animation by re-writing collection values per frame.** The `changed` stream is a data-freshness signal that triggers a panel refetch (`PluginPanelHost.tsx:36`); driving a frame loop through it is an IPC/sync storm. Motion belongs on the client side of that boundary (Option A.2), full stop.
- **A "canvas" vocabulary node that is really arbitrary drawing code.** A constrained shape grammar (Option A.4) is defensible; a `component: "canvas"` with a script payload smuggles code into a contract whose whole safety rests on "data, never code" (`vocabulary.ts:36`). If arbitrary drawing is genuinely needed, that is Option B (a real sandbox) or Option C (a new one), not a vocabulary node.
- **A bespoke JS sandbox as the *first* custom-render investment.** It re-earns the browser's isolation from scratch (`pluginWebviewProtocol.ts:5`) at the highest risk, when the webview already provides that isolation for free and the vocabulary already covers most cases. C is last for a reason.
- **Dropping the required panel fallback to "simplify" a desktop-only slot.** The mandatory `panelId` on every webview surface (`manifest.ts:98`) is the thing that keeps the cross-surface promise honest. A slot without a fallback is a blank box on the phone; the fallback is not optional polish, it is the contract.

---

## Anchor index

- Surface kinds `tab|pane|webview`, the required-fallback design: `apps/desktop/src/shared/plugins/manifest.ts:114`, `:98`, `:188`.
- Socket taxonomy (17 kinds, 8 surfaces), the single payload gate, per-client support table, action-button/badge/card/chat-header payloads: `apps/desktop/src/shared/plugins/sockets.ts:41`, `:837`, `:266`, `:477`, `:532`, `:597`, `:609`.
- Vocabulary panel contract, limits, the 13 components, chart's deliberate sparseness, "one line to add a component": `apps/desktop/src/shared/plugins/vocabulary.ts:1`, `apps/desktop/src/shared/plugins/vocabularyNodes.ts:31`, `:68`, `:246`, `:650`.
- Panel data plumbing and the reveal/`changed` refetch model: `apps/desktop/src/renderer/components/plugins/PluginPanelHost.tsx:36`.
- Webview protocol / origin isolation / traversal guard: `apps/desktop/src/main/services/plugins/pluginWebviewProtocol.ts:1`, `:149`, `:207`.
- Webview bridge (CSP, partition, method set, no-plugin-id-on-wire): `apps/desktop/src/shared/plugins/webviewBridge.ts:41`, `:85`, `:114`, `:138`.
- Attach handler sandbox flags: `apps/desktop/src/main/main.ts:895`–`904`.
- Bridge server identity check (origin ∧ registry): `apps/desktop/src/main/services/plugins/pluginWebviewBridgeServer.ts:117`.
- Webview host (process cost, reveal-gating, desktop-only): `apps/desktop/src/renderer/components/plugins/PluginWebviewHost.tsx:29`, `:63`, `:193`.
- Webview-vs-panel degradation at the surface: `apps/desktop/src/renderer/components/plugins/PluginTabPage.tsx:73`.
- Motivating example: `docs/reports/ade-tipsy-plugin-alpha-ux-retrospective.md`.
