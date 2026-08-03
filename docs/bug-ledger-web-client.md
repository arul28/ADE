# ADE Web Client — Bug Ledger

Working ledger for the web-client bug sweep (session started 2026-08-02).
Issues are reported one at a time, diagnosed, and grouped **by broken code
path / functional area** — not by report order. The goal is a set of clusters
that split cleanly into workstreams that target and batch related bugs.

Status legend: `reported` → `diagnosed` (root cause located in code) →
`clustered` (assigned to a workstream candidate).

---

## Clusters (grouped by broken code path / functionality)

### C1 — Analytics consent banners (marketing site + web client)
**Decision:** remove both consent prompts entirely; collect by default. Both banners are independent implementations
with separate storage keys; **Electron desktop has no consent gate at all** (defaults enabled,
`productAnalyticsService.ts:236`), so no desktop breakage risk. Settings/Privacy toggles remain the opt-outs.
- C1a `diagnosed` — Marketing banner: `apps/web/src/components/MarketingAnalyticsBridge.tsx:60-90`, gated by absence of
  localStorage `ade.analytics.enabled.v1` (`marketingAnalyticsBrowser.ts:14`). Sole capture gate is
  `safePreferenceRead` (`marketingAnalyticsBrowser.ts:36-42`, `=== "true"` → absent = off).
  Edits: strip banner state/JSX from the Bridge (becomes effects-only); flip `safePreferenceRead` to `!== "false"`
  (single change flips whole site to default-on); delete dead `hasMarketingAnalyticsPreference`; leave
  `PrivacyPage.tsx:132-157` toggle untouched (remains the opt-out, copy stays accurate).
- C1b `diagnosed` — Web-client banner: `WebAnalyticsConsentBanner`
  (`ProductAnalyticsLifecycle.tsx:120-142`), rendered from `AppShell.tsx:1224-1230` behind
  `productAnalytics.consentRequired`; key `ade:web-product-analytics-enabled`
  (`webclient/adapter/analytics.ts:14`), `readEnabledPreference` `=== "true"` (:49-56).
  Edits: drop banner render + import in AppShell; delete consent triple from `useProductAnalyticsLifecycle`
  (:93-115, keep the capture effects); flip `readEnabledPreference` to `!== "false"`; retire `consentRequired`
  (adapter :36/:77, optional field `shared/types/productAnalytics.ts:134`).
  **Critical invariant:** keep `syncClientConsent()` + its construction-time call (`adapter/analytics.ts:90-125`) —
  the host's per-peer bit starts **false** (`syncHostService.ts:3280`) and rewrites captures to
  `{accepted:false, reason:"disabled"}` (`productAnalyticsRemoteCommand.ts:54`); without reassertion every web capture
  is dropped server-side. No ade-cli changes needed.
  Tests: `webclient/adapter/__tests__/adapter.test.ts:1590` ("durable browser-local opt-out", asserts
  `consentRequired: true`) BREAKS → rewrite to start-from-enabled; :1679 fail-closed-disconnect test survives, keep.
  Host tests unaffected. Docs stale after change: `docs/features/web-client/README.md` :153-157, :395-397, :415,
  :552-557.
- Note (flagged once, owner's call): default-on collection without a consent prompt has GDPR/ePrivacy implications for
  EU visitors; current design is deliberately fail-closed. Proceeding per product decision.

### C2 — Pre-project surface (Hub) is a parallel UI instead of the desktop welcome flow
The entire signed-out → machine → project funnel is a custom `WebWorkspaceHub` rather than the desktop look/feel.
- C2a `diagnosed` — **No sign-in gate.** `WebClientRoot.tsx` always lands on `/hub`; Hub renders signed-out with a small
  "Sign in" button. Meanwhile the shared renderer's `LaunchGate.tsx` (desktop sign-in gate with `SignInCard`) is
  *deliberately bypassed* in web mode (`const [resolved] = useState(webClient)` — starts resolved). Fix direction:
  web mode gates on `status.signedIn` with no skip (web REQUIRES auth for relay anyway); desktop keeps skip.
- C2b `diagnosed` — **Hub replaces, rather than reuses, `ProjectWelcomePage.tsx`** (desktop's ADE-logo + Add Project +
  Recent Projects screen; 1128 lines, zero `isWebClientMode` references — never adapted). Redesign direction: after
  sign-in, show a desktop-like welcome/recents surface; machine connection becomes a prominent connections control
  (web has no "This Mac", so the machine picker carries more weight than desktop's top-right Connections pane).
- C2c `diagnosed` — **Project catalogs are not persisted**, so a reloaded page cannot show recent projects until a
  machine connects. Catalogs live only in `WebMachineSessionManager` memory (retained for parked sessions, lost on
  reload); `envStore.ts` (IndexedDB) stores no catalog. A desktop-style recents-first screen needs bounded per-machine
  catalog persistence in IndexedDB + stale-marking.
- C2d `diagnosed` — **Account-only machines don't auto-connect on select.** `WebWorkspaceHub.selectMachine` only
  auto-connects when a saved browser environment exists (`if (!machine.session && machine.environment)`), so selecting
  a directory machine shows an empty "Connect to view projects" panel + a separate Reconnect button. Selecting should
  connect.

### C3 — False machine status in Hub
- C3 `diagnosed` — **"Offline" is a lie.** `WebWorkspaceHub.statusForMachine()` derives status ONLY from this browser
  tab's session-pool state; any machine without a live session in this tab falls through to "Offline" — even when the
  directory advertises a dialable relay route. The correct shared helper `accountMachineConnectionState()`
  (`shared/accountDirectory.ts:551`, returns "available" when a verified secure endpoint exists; used by desktop's
  `remoteMachineModel.ts` / `AccountMachineRow.tsx`) is imported by the Hub **and never called** (dead import).
  Fix: status = merge(directory reachability, session state); "Offline" only when no dialable endpoint.

### C4 — "Lanes changed / Lane archived" toast re-fires forever on web
- C4a `diagnosed` — **Web adapter fabricates a fake user-visible lifecycle event on every lanes invalidation.**
  `webclient/adapter/lanes.ts:22-32`: on every `lanesInvalidated` it emits
  `{type: "lane-archived", laneId: "__ade_web_invalidation__", laneName: "Lanes changed"}` as a coarse refresh nudge —
  borrowing a user-visible type. `useLaneEventToasts.ts:32-43` toasts everything that isn't
  created/renamed/branch-updated → title "Lanes changed", body "Lane archived". Toast id IS stable; but
  `toastStore.ts:160-167` dismissal only removes from the array (no tombstone), so the next emit re-adds it.
  **Self-sustaining loop:** synthetic event → `crossMachineLanes.ts:1471` `scheduleRefresh()` → lanes read with
  `includeStatus: true` → host `upsertLaneStateSnapshot` (`laneService.ts:3418`, insert-on-conflict into
  `lane_state_snapshots`) → table name contains "lane" → classified into `lanes` domain
  (`invalidation.ts:64`) → next invalidation → next toast. Hub also polls every foreign machine at 10 s with
  `includeStatus`, so N machines feed one immortal toast. Every reconnect hello re-fires the full-invalidation set
  (`connection.ts:1121`) too. Desktop is unaffected (emits `lane-archived` only inside real `archive()`,
  `laneService.ts:6057`).
  **Fix (agreed direction):** add a neutral `"lanes-invalidated"` type to `LaneLifecycleEvent`
  (`shared/types/lanes.ts:497-512`), emit that from `lanes.ts:25`, ignore it in `useLaneEventToasts.ts:31`.
  All four refresh consumers verified safe with a new type (`useLaneListInvalidation.ts:13`,
  `useWorkLaneDeleteProgress.ts:163-178`, `crossMachineLanes.ts:1471`, PrsContext); adapter test
  `adapter.test.ts:1872` stays green if the emit is retyped, not removed. Secondary insurance: toast hook refuses
  events with sentinel/absent lane identity. Do NOT fix via sticky dismissal (would suppress legit repeat archives)
  or Hub-route suppression (wrong on /lanes too — precedent: `sessionsPty.ts:118-125` already maps invalidation to a
  neutral `reason: "meta-updated"`).
- C4b `diagnosed` (follow-up, perf) — **Invalidation→status-write churn.** Even with the toast fixed, the synthetic
  event drives a 400 ms-floor refresh cycle running a git status per lane per connected machine, whose
  `lane_state_snapshots` writes feed the next invalidation. `crossMachineLanes` should not treat a coarse
  invalidation as reason to re-read every foreign machine with `includeStatus: true`. → belongs with web perf/refresh
  policy work.

### C5 — Project catalog shows "0 lanes" for every project
- C5 `diagnosed` — **Host-side bug; web client renders the wire value faithfully.**
  `apps/ade-cli/src/services/sync/headlessMobileProjectSummary.ts:26` hardcodes `laneCount: 0` as the default, and the
  machine catalog provider (`apps/ade-cli/src/cli.ts:15917-15929`) maps every registry record through
  `toMobileProjectSummary(...)` without a `laneCount` override — `projectRegistry.listRecent()` rows carry no lane
  data at all. Even the open project shows 0 because `markActiveHostProjectOpen` only flips `isOpen`. The paths that
  do compute real counts (`mobileProjectSummaryForHeadlessRecord`, `prepareProjectConnection` via
  `laneService.list()`) are never used for the listing. **Also affects iOS/phone catalog** (same `project_catalog`
  frames).
  - Correct-count reference: desktop's `recentProjectSummary.ts:78-114` (read-only SQLite open of each project's
    `.ade` DB, count non-archived lanes with live worktrees; `readGitLaneCount` fallback).
  - Fix: read-only lane-count helper next to `headlessMobileProjectSummary.ts` following the
    `rosterBuilder.ts:236-262` closed-project pattern (readOnly DatabaseSync, busy_timeout 2000, hasTable guard,
    count non-archived; 0 on failure) — do NOT hydrate project scopes per row.
  - Decision recorded: match desktop's **inclusive-of-primary** count (`recentProjectSummary.ts`) rather than
    `projectPathInspector.ts`'s exclusive count, so desktop recents and web Hub agree.

---

### C6 — Web client viewport collapse (app fills only part of the browser window)
- C6 `diagnosed` — **Percentage-height chain broken at `#root`.** `webclient.html` gives `html/body/#root` only
  `min-height` (`#root` never gets `height`); `index.css:356-358` fixes `html, body { height: 100% }` but nothing
  sizes `#root`. Web-mode `AppShell` uses `h-full` (`AppShell.tsx:1205`) — a percentage that cannot resolve against
  an auto-height parent — so the entire app collapses to content height (screenshot: app in top ~55%, dead black
  below; also visible on every round-1 Hub screenshot). Desktop unaffected (`h-screen`). The `h-full` comment refers
  to a shell "top strip" wrapper that no longer exists — `WebClientRoot` mounts `AppRoot` directly under `#root`.
  Fix: give `#root` definite height (`height: 100%` in `webclient.html`, keep splash `min-height`); one line, fixes
  every web route at once.
  **Confirming evidence (round 4):** /lanes and /graph cut at *different* heights than /work — exactly what
  collapse-to-content-height predicts (each route's content computes a different intrinsic height). One root cause,
  route-dependent symptom; not separate bugs.

### C11 — Zoom control does nothing on web — FIXED (root cause corrected during implementation)
- C11 `fixed` — Original hypothesis (CSS zoom ignored on root `<html>` in modern Chrome) was **disproven by
  measurement** during implementation (Chrome 150 + Electron 41: zoom on html works). Real root cause: **the zoom
  namespace was built in `adapter/misc.ts` and never exposed on the adapter surface in `adapter/index.ts`** — so
  `window.ade.zoom.setLevel()` hit `withFallbackProxy` → silent `Promise.resolve(null)` (another C10-sys instance;
  the `[ade-web] unimplemented: ade zoom` debug line was there all along). Fix: `zoom: misc.zoom` added to the
  surface; factor applied to `document.body` (equivalent, less exposed to root/pinch semantics now that the height
  chain is fixed); persisted level applied at adapter install so reloads restore zoom; deliberately NOT re-applied
  on project rebind (project-scoped localState would reset zoom to 100% on switch).
- Follow-up ledgered: `usage.refreshHistory` needs its own host descriptor (deliberately decoupled from
  refreshQuota host-side); until then web's AdeUsageSection cost stats refresh via proxy no-op.

### C7 — CLI-session status fidelity (cross-cutting: desktop + web + iOS, syncs everywhere)
- C7a `diagnosed` — **CLI sessions never get a turn anchor; the timer renders time-since-last-output-write.**
  `SessionStatusSlot.tsx:87-89`: only chat tool types (`isChatToolType`, matches `cursor`/`*-chat` —
  `chatSessionProjection.ts:42-46`) use `currentTurnStartedAt`; PTY CLIs (`claude`, `codex`, `droid`, `opencode`,
  `shell`) fall to `lastActivityAt`, which `ptyService.updatePreviewThrottled` (`ptyService.ts:3720-3745`)
  re-stamps every ~900 ms of output (deliberately, even on unchanged output — it feeds the 3-hour stale detector,
  `sessionCanonicalState.ts:194`, so the anchor must be a NEW field, not a change to this one). The visible ~5 s
  period is the renderer's `LOCAL_RUNNING_SESSION_REFRESH_INTERVAL_MS = 5_000` (`useWorkSessions.ts:425`); remote/web
  is 15 s.
  **Fix (3 edits, no migration, no new sync column):** (1) `RuntimeStateEntry.runningSince` set ONLY on
  `!running → running` transition in `setRuntimeState` (`ptyService.ts:2150`), nulled on idle demotion (`:2170-2180`);
  (2) `enrichSessions` (`ptyService.ts:6297`) — the single chokepoint desktop/lane-snapshot/web/iOS all pass through
  (wire already ships `currentTurnStartedAt`, `syncRemoteCommandService.ts:1224`) — emits it as
  `currentTurnStartedAt` for live running rows; (3) drop the `isChatToolType` gate in `SessionStatusSlot.tsx:87`.
  Caveat accepted: in-memory anchor → desktop restart mid-turn falls back to today's behavior (same tradeoff chat
  already makes). Prior art: push publisher keeps a transition-gated `statusSinceAt` for Activity
  (`pushPublisherService.ts:700`, `:855`) with a comment explicitly avoiding this reset bug — Work list just can't
  see it.
- C7b `scoped` (product, future workstream line) — richer CLI states: today working/idle = OSC 133 prompt markers +
  12 s silence timer (`ptyService.ts:5026-5035`, `terminalSessionSignals.ts:493`); nothing parses TUI content, and
  provider JSONL transcripts are read only for chat history. The UI vocabulary already exists: `planning` glyph in
  `SessionStatusLabel.tsx:25-26` fed by `chatActivityMode` — detecting Claude Code's footer/plan banner from the PTY
  stream (or tailing provider transcripts) and mapping onto `chatActivityMode` lights up planning/asking for CLI
  sessions with zero new UI.

### C8 — Session preview corruption for full-screen TUI CLIs (spaces gone + escape residue)
- C8a `diagnosed` — **Preview builder flattens PTY bytes with no cursor model; the spaces were never in the stream.**
  `apps/desktop/src/main/utils/terminalPreview.ts:38-63` (`derivePreviewFromChunk`) deletes ANSI CSI wholesale
  (`ansiStrip.ts:8`) then appends remaining printables in arrival order. Full-screen TUIs (Claude Code/Ink) repaint
  only changed cells and skip unchanged ones via cursor-positioning sequences — deleting those sequences deletes the
  gaps, i.e. the spaces (`ESC[50;9H g ESC[50;12H 10s` → `g10s`). Verified by replaying the algorithm over a real PTY
  transcript AND by a corrupted stored preview in `.ade/ade.db` (live-data reproducible, not display-only).
  Single producer shared by all clients: `ptyService.ts:5023` → `:3720-3728` (`entry.latestPreviewLine`) →
  `sessionService.setLastOutputPreview` (`sessionService.ts:1288-1292`, `terminal_sessions.last_output_preview`);
  desktop renders via `SessionCard.tsx:198`, web via `rosterBuilder.ts:464` → sync roster → same SessionCard.
  Desktop and web equally affected; renderer sanitizers are innocent.
- C8b `diagnosed` — **Split-CSI leak, same function:** `stripAnsiWithOptions` is stateless per chunk, so a CSI split
  across a PTY chunk boundary loses its ESC and the tail leaks as literal text (`[53;37H`, `[49m` residue).
- Fix (agreed direction): make `derivePreviewFromChunk` column-aware — cursor `col` into a mutable line buffer
  (CUP captures line on row change; CHA/CUF/CUB move col; EL truncates; printables write at col padding with
  spaces; `\r` sets col=0 instead of clearing the line) + carry trailing partial escapes across chunks (field on
  PtyEntry). Existing `terminalPreview.test.ts` cases remain valid. Alternative (deferred): derive preview from the
  existing headless xterm mirror (`entry.terminalSnapshot`, `ptyService.ts:5022`; precedent
  `agentCliInputReadiness` `:4138-4143`) — more robust but changes WHICH line is picked (footer vs assistant text);
  land the cursor-aware parser first.

### C9 — Terminal image paste on web: Cmd+V silently fails; Ctrl+V "works" by same-machine accident
- C9 `diagnosed` — Cmd+V IS the intended paste key on web-Mac (`TerminalView.tsx:2310-2343`: `mod = metaKey` on Mac).
  For an image, the capture-phase paste listener (`TerminalView.tsx:2293-2303`) checks only
  `clipboardData.getData("text/plain")` and **ignores the image items sitting synchronously in the paste event's
  DataTransfer**; it falls through to `pasteClipboardImageShortcut` → (Work tab uses `runtime-attachment` mode,
  `WorkViewArea.tsx:834`) → web adapter `readClipboardImage()` (`webclient/adapter/app.ts:301-318`) which uses the
  **permission-gated** `navigator.clipboard.read()` and returns `null` on any rejection (silent catch) → Cmd+V image
  paste silently does nothing.
  Ctrl+V "working" is an architecture accident: on Mac, Ctrl+V is NOT intercepted (mod=metaKey), so a literal
  `^V` byte tunnels through the PTY to Claude Code on the desktop, and **Claude Code reads the desktop Mac's own
  clipboard**. It only worked because browser and desktop were the same physical Mac with one clipboard — from a
  genuinely remote browser, Ctrl+V would attach whatever image is on the *host's* clipboard, not the device the user
  is holding (wrong-machine clipboard semantics).
  Fix: in the paste listener, consume `image/*` items from `ev.clipboardData` directly (synchronous, no permission
  prompt, always the browsing device's clipboard), keep `navigator.clipboard.read()` as fallback for non-paste-event
  entry points. Then Cmd+V behaves exactly as a Mac user expects. → WS-E-adjacent but web-adapter surface; assign
  to WS-D or WS-E at cut time.

### C10 — Provider usage panel dead on web ("Waiting · not updated" skeletons)
- C10 `diagnosed` — **Web adapter never implements `usage.getSnapshot`/`refresh`/`onUpdate`; the fallback proxy
  silently resolves them to null.** `createUsageStubs` (`webclient/adapter/misc.ts:672-678`) implements only
  `getAdeStats` (plus dead `getSummary`/`listSessions` that aren't even in the contract). `withFallbackProxy`
  (`adapter/infra/proxy.ts:24-40`) turns every missing method into `console.debug` + `Promise.resolve(null)` (no-op
  unsubscribe for `on*`), so `UsageQuotaPanel` (`UsageQuotaPanel.tsx:215/:255/:384`) keeps `snapshot === null`
  forever → `"Waiting"` + `"not updated"` (:181/:187/:623) + skeletons (:702). `bridgeMissing` never trips because
  the stub object exists, so the honest "Usage isn't available" message never shows. Refresh spins and resolves null.
  **Host descriptors already exist and iOS uses them:** `usage.getQuotaSnapshot` / `usage.refreshQuota`
  (`syncRemoteCommandService.ts:5442/:5447`, viewerAllowed, runtime-scoped, backed by
  `usageTrackingService.getUsageSnapshot()`/`forceRefresh()`); iOS guards via `supportsRemoteAction`
  (`MobileUsageQuotaStore.swift:29`).
  **Fix (~4 lines, adapter only):** add `getSnapshot: () => call("usage.getQuotaSnapshot", {}, null)`,
  `refresh`/`refreshHistory: () => call("usage.refreshQuota", {}, null, /*idempotent*/ false)` (bypasses the 3 s read
  cache so manual Refresh is real), drop dead methods. Older hosts degrade to today's skeleton via the command
  fallback. No streaming descriptor exists — leave `onUpdate` to the proxy; optional follow-up: adapter-side polling
  fan-out through the existing EventBus. Do NOT hide the panel on web.
- C10-sys `systemic note` — **`withFallbackProxy` silent-null pattern is a standing trap:** any renderer surface
  calling an unimplemented web-adapter method gets an eternal pending/empty UI instead of an honest "not available
  in this view" state (the UI's own missing-bridge affordances never trip because the stub object exists). Worth a
  sweep: log-audit `[ade-web] unimplemented:` debug output across the app and triage each hit into implement / hide /
  honest-refusal. Candidate generator for future WS-F items.

### C12 — Hidden-tab surfacing on web (audit complete; product decision + fixes)
Headline: **`WEB_CLIENT_TAB_PATHS` is dead code** (nothing imports it); the real gate is `TabNav.tsx:299`
(`mainItems.slice(4)` hidden on web) + `:396` (Settings). All hidden routes are already in the web shell's
`APP_ROUTE_ROOTS` (`WebClientRoot.tsx:61-78`) and reachable via CommandPalette (rendered unconditionally,
`AppShell.tsx:1723`) — hence the owner's graph discovery. Every hidden page is `React.lazy`; the entry-graph guard
(`check-webclient-entry.mjs:8-9`) is unaffected by adding nav entries → **no first-load perf risk**.
- C12a `works-today` — **Graph `/graph`: enable now.** Reads/mutations all covered (reparent incl. multi-lane
  rollback, env mappings via `projectConfig.get`, activity via real `pty.onData/onExit` subs). Punch list:
  hide "Open folder" menu item (silent no-op, `adapter/lanes.ts:187`); `conflicts.simulateMerge` adapter-wired but
  **no host descriptor** → null (`adapter/git.ts:89`); `conflicts.onEvent` hard no-op → progress bar inert
  (`adapter/git.ts:105`, static matrix still fills); `graphState` browser-local only (positions don't roam).
- C12b `small-fix` — **History `/history`: enable after** 3 new host descriptors (`git.getCommit`,
  `git.getOriginRemote`, `git.getOpenPrForBranch` — adapter-wired at `adapter/git.ts:52,57,58`, host-missing) +
  wire `cto.getState` in adapter (host has it, `syncRemoteCommandService.ts:4777`). Degrades gracefully without.
- C12c `small-fix, highest leverage` — **CTO `/cto`: adapter-only.** Host registers 14 viewer-allowed `cto.*`
  actions (`:4761-4933`); adapter wires only 5 (`adapter/misc.ts:594-606`). Chat rides existing `agentChat` + 56
  `chat.*` actions. **Wire selectively — see C12-sec.** Bonus: `App.tsx:757` already idle-preloads the CTO chunk on
  web (users download a tab they can't open); if NOT enabling, gate that preload on `!isWebClientMode()`.
- C12d `needs-host-descriptors` — **Review `/review`** (~10 new commands; zero `review.*` host-side; today would
  render empty list + dead Start button).
- C12e `needs-host-descriptors + ACTIVE BUG` — **Automations `/automations`**: zero `automations.*` host-side, but
  the adapter hardcodes `automationsEnabled: true` in `app.getInfo` (`adapter/app.ts:27`) so the FULL builder (not
  the coming-soon screen) renders for anyone reaching it via URL/palette today — **rules built there silently
  vanish**. Immediate fix regardless of surfacing decision: flip that to false on web until host support exists.
- C12f `split` — **Settings**: surface Appearance/Notifications/Activity/Stats/Lane Behavior/PR Chat
  Transcripts/Product Analytics/Launch Prompt (localStorage or existing descriptors); keep hidden
  Secrets/Providers/GitHub creds/Dictation/ADE CLI/Auto-updates/Storage (no `storage.*` namespace)/Session
  Lifecycle/Lane Templates (reads land, writes silently discard).
- C12g `native-only, keep hidden` — iOS Sim / Built-in Browser / App Control / Computer Use are Work-tab panes (not
  tabs), all sharing `createNativeUnavailableNamespace` (`adapter/misc.ts:539-542`, `:661-668`). Correct as-is.
- C12-sec `SECURITY` — **`cto.setLinearToken` is registered `viewerAllowed: true`** (`syncRemoteCommandService.ts:4826`);
  it's unreachable from browsers only because the adapter never wired it. Mechanically completing the CTO namespace
  would hand any connected web client write access to the host's Linear credential store. Action: wire CTO
  method-by-method excluding token setters, AND review host-side whether token-writing actions should be
  viewer-allowed at all (defense in depth — the registry, not adapter omission, should be the gate).
- C12-sec-2 `SECURITY (found during implementation)` — **`projectConfig.get`/`save` round-trip plaintext provider
  API keys (`ProjectConfigFile.ai.apiKeys`) viewer-allowed in both directions** with no field validation on save
  (`parseProjectConfigSaveArgs`, `syncRemoteCommandService.ts:1176`): a paired viewer can read AND inject provider
  keys. Fix in flight (impl-hostsec): redact credential fields for remote peers on get, strip/reject on
  remote-originated save, at the sync boundary; desktop-local unchanged.
- C12-sec-3 `SECURITY (found during implementation)` — **`sync.getWebPairingInfo` viewer-allowed and returns the
  raw pairing PIN + ready pairing URL** (sibling `getDesktopPairingInfo` already viewer-blocked with an explicit
  comment). No production callers. Fix in flight: flip to non-viewer.
- C12-sec-4 `flagged, deferred` — `push.unregisterDevice` accepts an arbitrary deviceId: one paired device can
  silently kill another device's push registration (authz/DoS gap, not a credential write). Needs an ownership
  check; out of this pass.
- C12-sec-5 `flagged, deferred` — a viewer can complete `cto.startLinearMobileOAuth`/`completeLinearMobileOAuth`
  with its OWN Linear account, replacing the owner's connection; fix is host-side confirmation, not a flag.
- C12-sec-6 `flagged, deferred` — **`projectConfig.save` stays `viewerAllowed: true` while carrying config fields
  the host later EXECUTES as shell commands**: `automations`, `testSuites`, `laneTemplates`, `laneEnvInit`
  (`shared/types/config.ts:1444-1447`). `mergeProjectConfigCandidateForRemote`
  (`ade-cli/.../syncRemoteCommandService.ts:1216`) restores only credential fields from disk, so a paired viewer's
  candidate rewrites all of these verbatim — the command-injection half of C12-sec-2, which fixed the
  credential half only. Predates this branch and needs a host decision (drop viewerAllowed, or restore
  command-bearing sections from disk the way credentials are). Queue with C12-sec-4/5.
- iOS follow-up (in flight): `LinearConnectionScreen.swift:44/:278` switch to policy-aware
  `supportsViewerRemoteAction` so Disconnect/paste-token hide on viewers instead of failing `forbidden_command`;
  root cause: `hello_ok.features.commandRouting.supportedActions` is built policy-blind (`syncHostService.ts:1312`)
  — descriptor policy is the correct client check.
- C12-pattern — **Silent-discard writes** (`commandCaller.ts:83` resolves fallback on missing descriptor, no error):
  six Settings sections would "work" and lose data. Correct pattern exists: `adapter/lanes.ts:99-105`
  (`archiveAndReclaim` fallback THROWS). Adopt throwing fallbacks for all writes before enabling anything. → merges
  with C10-sys audit.
- Note: there is no Search or Brain/Memory tab (verified `App.tsx:546-597`); search = CommandPalette, already live
  on web.

### C15 — Auto-naming silently degrades to deterministic names (cross-cutting, log-proven live incident)
- C15a `diagnosed, PRIMARY` — **`runCodexTask` never passes `--model` (or effort) to `codex exec`**
  (`providerTaskRunner.ts:266-320`; contrast `runClaudeTask:227-233` which does). ADE selects a naming model,
  logs it, shows it in Settings — then spawns Codex on whatever `~/.codex/config.toml` defaults to. Incident
  evidence (`.ade/transcripts/logs/ade-cli.jsonl:29682/29686/29687`): ADE asked for `openai/gpt-5.4-mini`, Codex ran
  config-default `gpt-5.6-sol` at `high` effort → OpenAI 400 ("model not supported with ChatGPT account") twice →
  `source: "deterministic"` → lane+branch renamed to the title-cased first words. The naming-model setting is inert
  for ALL OpenAI models. Same omission in `automationPlannerService.ts:399`. Fix: push
  `"--model", descriptor.providerModelId` + `-c model_reasoning_effort=<effort>` into the Codex arg list.
- C15b `diagnosed` — **Effort dropped at the last layer**: `ProviderTaskRunnerArgs` has no `reasoningEffort`;
  `executeProviderTaskPath` (`aiIntegrationService.ts:1450-1462`) never forwards it (log shows `high` when ADE
  requested `low`). Thread it through.
- C15c `diagnosed` — **Fallback chain can't escape a broken provider**: `agentChatService.ts:11166-11185` builds
  [primary, same-provider, requested, cross-provider] then `.slice(0, 2)` — cross-provider candidate unreachable, so
  provider-level failures (auth/binary/unsupported-model) are terminal. Older `suggestLaneNameFromPrompt` (:11282)
  has 5 candidates incl. Anthropic and no slice. Fix: reorder/widen so a different provider is reachable.
- C15d `design gap` — Zero user-visible failure: renderer console.warn only (`AgentChatPane.tsx:8786`); the result
  looks like the feature working. Surface a "named deterministically — naming model unavailable" affordance
  (renderer already receives `source`).
- C15e `diagnosed` — Settings "Today —" for auto-name is a hardcoded em dash (`AiFeaturesSection.tsx:688`); naming
  has no own AiFeatureKey (runs as `terminal_summaries`, exempted from its gate at `aiIntegrationService.ts:1505`);
  `logUsage` only counts successes so a fully-broken provider is visually identical to an idle day. Wire a real key +
  failure counting.
- **OWNER DECISION (during impl):** the fallback chain must be: configured naming model → **the model the chat was
  launched with** (always, not only when no titles model is set) → cross-provider candidate → deterministic. Fix
  stream QUEUED (launches when fleet thins, per owner's resource constraint): C15a `--model`+effort on Codex spawn,
  C15b effort threading, C15c chain rework per this decision. C15d/e deferred to polish loop.
- Context notes: naming always spawns a fresh one-shot CLI (never reuses the chat's runtime), so CLI-launched chats
  are NOT the gap; "launched chat model" fallback didn't engage because a titles model was configured
  (`AgentChatPane.tsx:8858-8861`). History shows the feature failing for days (six ChatGPT-account 400s; ENOENT
  spawns on 2026-07-29). Branch rename `ade/371ba43b`→`ade/hey-there-start-skill-then` was the FAILURE path
  completing (`laneService.ts:5460/:5590`), not partial success.

### C16 — Hosted web-client OAuth sign-in fails in ADE's built-in browser — FIXED (client-side)
- C16a `fixed` — Root cause: PKCE state/verifier stashed in `sessionStorage`, which doesn't survive the built-in
  browser's round trip — the agent-navigation guard re-issues the outbound Clerk navigation as a fresh
  browser-initiated `loadURL` (`builtInBrowserService.ts` ~:1500-1547) and tab restore rebuilds tabs as new
  WebContentsViews (~:3404), both minting a new session-storage namespace (IndexedDB/localStorage unaffected —
  persist:ade-browser partition — which is why the refresh store worked while the stash vanished). Failure was
  silent: missing stash → `expireSession` message only in `account.message`, never surfaced. Fix: single JSON
  stash envelope in `localStorage` (10-min TTL, single-use, legacy-key cleanup; injectable storage unchanged);
  callback distinguishes oauth-error / dropped-stash / state-mismatch with explicit copy; WebClientRoot pushes the
  failure into the visible workspace notice. Security tradeoff assessed (standard SPA pattern; verifier single-use
  + TTL; strictly less valuable than the IndexedDB refresh token). Tests: 11/11 client + 16/16 shell.
- C16b `NEW, ledgered` — Built-in browser defect (out of C16 scope, not its cause): an **approved** `will-redirect`
  in an agent-opened tab is still aborted ("Blocked agent-triggered redirect... after recording approval") — any
  OAuth provider that 302s cross-origin mid-flow dead-ends even after human approval
  (`enforceAgentNavigation`). Fix in the built-in browser's redirect approval path; polish loop.

### C17 — Local web-client dev experience (FIXED during test drive)
- C17a `fixed` — Prod account-directory Worker 403s any Origin except the hosted one (verified: OPTIONS
  /account/machines from localhost:5174 → 403; Worker only rejects PRESENT mismatched Origin, directory.ts:675).
  Fix: dev-only Vite proxy `^/account/machines...` → Worker with Origin/referer stripped
  (vite.webclient.config.ts; ADE_DEV_DIRECTORY_PROXY_TARGET; recipe documented in-file). Dev recipe: prod Clerk
  issuer/client + VITE_ADE_ACCOUNT_DIRECTORY_URL=http://localhost:5174. Also required (one-time, done): loopback
  redirect URIs registered on the shared "ADE CLI" OAuth app in Clerk (dev + prod instances — note the app is
  SHARED by CLI device flow and web client; the code's dev/prod client IDs are that app's IDs).
- C17b `fixed` — **Welcome empty state lied**: rendered "No Macs on this account yet" when the directory read
  FAILED. Now branches on account.state: ok+0 → original copy; directory_unavailable → "Couldn't load your
  machines." + reason + Retry; auth_expired → + "Sign in again"; signed_out/unconfigured → their own copy. Failure
  kinds are role="alert". (Account page was already honest — mismatch caught live.)

### C18 — Add Project on web: dead-end flow, one real crash; wiring gap NOT architectural
- C18a `mitigated` — Web adapter lacks every route the add-project flow needs (chooseDirectory→null,
  getDroppedPath→"", browseDirectories returns the CATALOG dressed as directories, createLocal/clone/
  getDefaultParentDir missing → proxy nulls). **CREATE tile crashes to RendererErrorBoundary** when a valid name is
  typed (null parentDir TypeError, CreateProjectForm.tsx:109/:167); CLONE surfaces nonsense errors. Shipped
  mitigation: no machine → Add Project disabled with hint; machine present → honest callout ("Projects are added
  on the Mac that hosts them…") instead of the broken flow.
- C18b `workstream candidate WS-I` — **The host already advertises a `projectActions` capability**
  (syncHostService.ts:7620-7639: browseDirectories, getDefaultParentDir, openProject, createProject, cloneProject,
  listMyGitHubRepos; real handlers incl. project_browse_result) **and iOS consumes it** — the web adapter simply
  never wired it. Wiring = full add/create/clone on web. Comment in WebAddProjectNotice records this.

### C19 — CSS zoom × viewport units: dialogs overflow the screen at non-default zoom
- C19a `fixed (primary instance)` — Web zoom is `body { zoom }`; vh/vw units do NOT participate in zoom while
  zoomed content paints larger → `max-h-[86vh]` dialogs outgrow the viewport (measured on the live dev server,
  Chrome 150: zoom 1.728 → 858px dialog in 720px viewport, interior unreachable — the reported clip; fine at
  zoom ≤1.1 which is why it looked content-dependent). Fix: `max-h-[86%]`/`max-w-[96%]` (percentages resolve
  against the zoomed containing block); desktop unchanged (Electron zooms the viewport itself).
- C19b `follow-up` — Same class elsewhere: WorktreeOpenDialog.tsx:126, MergeWorktreeProjectDialog.tsx:151,
  PublishToGitHubDialog.tsx:245 (max-w-[96vw]); CommandPalette default-mode fixed max-h-[400px]. Sweep in polish
  loop.

### C21 — Cross-machine tab bindings mutated (FIXED, two rounds)
- C21a `fixed` — MRU-sorted session scan let the wrong machine win shared-checkout path resolution (rewrote the
  other tab's MACHINE, in memory + localStorage); host-echo race rebound the outgoing tab mid-activation. Fix:
  held bindings win path resolution; activation guard; machine-scoped rebinds. federated.test.ts, fail-pre-fix
  verified.
- C21b `fixed (residual)` — `specialApp/Project/RemoteRuntime` were one-time SNAPSHOTS of the fallback adapter,
  short-circuited ahead of dynamic routing — and the fallback client IS machine A's live socket (primaryClient →
  availableClients). Non-overridden members (openRepo, closeCurrent, …) always executed against machine A
  regardless of displayed tab → real project_switch on the departing machine, events on an unheard bus. Fix:
  namespaceWithOverrides proxies (overrides first, rest follows displayed/pinned adapter); activation guard spans
  the full commit. 3 new tests fail pre-fix.

### C22 — Project switching latency on web
- C22a `fixed` — Redundant serial `getProjectCatalog()` removed from openProject (switch result + catalog push
  already carry it; isOpen exclusivity handled; converges-on-push test fails pre-fix). Activation: 3 → 2 serial
  round-trips.
- C22b `HOST DESIGN ITEM, queued` — The dominant cost cannot be fixed client-side: each project scope runs its
  own sync host owning the socket; project switch deactivates the previous host AFTER replying (cli.ts:15960-16036,
  projectScope.ts:313-318, syncHostService.ts:4800-4816), so the peer is always dropped and must re-dial + cold-boot
  the target scope. In-place switch requires host scope-ownership redesign (one long-lived socket owner routing
  frames per scope, or warm handover). Real design work — future workstream/plan item.
- C22c `FIXED — remount replaced by durable subscriptions` — AppRoot now keys on `workspaceGeneration` (account
  change only). Tab/adapter swaps re-attach unpinned subscriptions at the federated proxy chokepoint
  (detach-before-attach, per-side try/catch; pinned-binding subscriptions never move — new explicit test);
  project-scoped view state resets via appStore's existing switch logic (desktop's proven model — desktop never
  remounted). Shell, other tabs' terminals/chats, and all stores survive switches; remaining switch cost is the
  host reconnect (C22b). 297 tests across 7 suites; new tests fail-pre-fix verified. Manual sanity item for owner:
  switch between two tabs with live chats once.
- C22c-history `superseded` — original escalation entry: — Full AppRoot remount on every adapter swap
  (`WebClientRoot.tsx:582 key={activeAdapterGeneration}`) is the confirmed root of: Work tab blank ~1 min after
  machine switch (everything refetches from zero over relay; tab-bouncing can't help), AND corrupted xterm
  (federated.ts:623-629 swaps to fallbackAdapter on client replacement → double remount on a socket blip; xterm
  re-hydrated mid-measure → blank buffer + stray line + wedged jump-to-bottom). Load-bearing for cross-machine
  state isolation (PR #983) — replacing it with scoped teardown/targeted invalidation is design work; pair with
  C22b in the next /plan. Mitigations landed meanwhile: html/body overflow:hidden + overscroll none (page-scroll
  symptom fixed, #root fix preserved); classifier safety net (unknown CRR table → ["lanes","sessions","chats"]
  fallback with explicit silent-list — kills the new-table silent-staleness class; verified only 10 low-frequency
  tables hit the fallback). Classifier map itself CLEARED as blank-Work cause (programmatic 89-table diff: only
  intentional losses).
- C22d `pre-ship perf caution (WS-E follow-up)` — Today's preview cursor emulator + TUI marker scans run per PTY
  chunk on the host main process with no chunk-size cap (ptyService.ts:5058-5065; char-loop + ~9 regexes over
  ≤8.5KB). NOT the cause of tonight's web lag (owner's runtime runs the beta, not this branch) but needs
  measurement/capping before this branch ships to the Mac — TUIs repaint multi-KB per keystroke.

### C23 — Terminal mirror: wrong-width scrollback + mouse snapback (both FIXED client-side)
- C23a `fixed` — Full-snapshot `replace` wrote bytes at xterm's constructor-default 80 cols before first fit (xterm
  never reflows) → staircase scrollback; common on web because remounts make snapshot-before-measure the normal
  path. Fix: replace path now drives fit and defers the reset+write until measured (same budget as the existing
  hydration gate), falling through after the budget. Already-measured behavior unchanged (existing test still
  passes synchronously).
- C23b `fixed, was SHARED with desktop` — xterm `scrollOnUserInput` defaults true; with TUI motion mouse-tracking
  (1002/1003) a bare mousemove is "user input" → snap to bottom while scrolled back. Fix: suppressed only while
  (pointer over pane ∧ mouse tracking active ∧ scrolled back); keyboard keeps snap-to-bottom.
- C23c `host residual` — Main-buffer snapshots (`snapshot.serialized`) are captured at the HOST pty width with no
  dims metadata; scrollback captured pre-viewer-resize can still staircase regardless of client gating. Host fix:
  carry pty dims in snapshots (viewer rejects/re-requests) or re-serialize at viewer width post-resize. Queue with
  the C22b host work.
- C23d `test debt` — No regression test for the deferred-replace path (needs an unfitted Terminal mock; deferred to
  /test phase rather than shipping a fragile one).
- C23e `fixed client-side; host arbitration queued` — **Multi-viewer PTY resize war, code-proven**: desktop and web
  run the SAME TerminalView; both continuously push their own dims (desktop via ptyService.resize:5980, web via
  terminal_resize → resizeBySessionId source:"mobile" — the web inherited the phone's tag with no concurrency
  story). Host arbitration exists only as repair-on-detach (restoreDesktopSizeBySessionId on last-peer detach).
  Last write wins → CLI wraps at one width, other viewer renders at another → jumbled fresh+replayed output,
  scrollbar geometry, "worked earlier" when widths coincided. Client fix: `windowOwnsPtySize()` — a viewer pushes
  dims only when hidden=never / focused=owner / recent (60s) pointer-or-key interaction=owner; module-load seeding
  makes a freshly opened viewer take ownership; existing focus→force-refit handles handoff. Residual: two
  actively-used foreground viewers still contend — needs HOST arbitration (recommended: most-recent-input owner
  pushes size, losers follow; snapshot already carries cols/rows, missing an ongoing "pty resized" push). Queue
  with C22b/C23c as the terminal/sync host design bundle. Also verify iOS isn't fighting via the same mobile tag.
  Note: history recorded during the war stays jumbled (nothing reflows recorded bytes) — explains "quit desktop,
  still broken" for old scrollback; fresh output should be clean post-fix.

- C23f `ROOT CAUSE of the staircase — reproduced pixel-perfect, FIXED client-side` — **Web hydrates terminals by
  replaying RAW PTY BYTES; desktop hydrates from a RENDERED GRID.** `sessionsPty.ts:524-549` hardcodes
  `snapshot: null` (the wire's `SyncTerminalSnapshotPayload` has no grid field — only `transcript`), so web always
  takes TerminalView's transcript-replay branch: a full-screen TUI's absolute `ESC[r;cH` repaints recorded at the
  HOST width (measured: 1388 CUPs, max col 155, only 3 clears in the real 708KB tail) land in wrong cells at any
  other width. Deterministic harness on the owner's actual session log: 100-col viewer = pixel match of the
  screenshot; 155-col = readable; desktop grid path = immune. Also explains fresh-output corruption (replay parks
  the cursor at a stale absolute position in an uncleared buffer). Fix: `inferTranscriptColumns` (max addressed
  col) + async `normalizeTranscriptToGrid` (offscreen xterm at recording width → plain rows; bounded 400×96;
  null→raw fallback) applied only to transcript-source hydration; 708,160B → 5,641B. Harness caught the agent's
  own first version being a silent no-op (xterm write is async) — fix re-verified end-to-end with shipped code.
- C23h `fixed, web-only silent resize drop` — webclient `pty.resize` used a STRICT ptyId lookup and returned
  silently on miss: local xterm resized, PTY never told, TUI keeps old width → first full repaint after input
  garbles (matches the owner's onset clue exactly; a dropped keystroke is obvious, a dropped resize is invisible
  until output). Fix: resolveSessionId({ptyId,sessionId,terminalId}) + loud warning on unresolvable. Also: dims
  mismatch detector added ([ade-term] structured warns at resize-send/acked/failed, snapshot-hydrate,
  replace-write-unfitted; columns-only comparison to avoid false positives) — already caught the in-flight
  resize race (sentResize 120 vs grid 140) in an existing test; that race + repaint ordering needs the host
  handshake (no wire tie between a resize and the repaint it causes) → host bundle.
- C23i `fixed — terminal mode restoration on web hydration` — TUI modes (mouse tracking, SGR encoding, cursor
  visibility) are set once at startup; web hydration lost them (raw replay only carried them while the 2MB tail
  still reached the startup bytes — owner's "scrollbar appeared mid-session" = transcript outgrew the window; the
  grid normalization strips them by construction). Fix: `inferTerminalModesFromTranscript` over the RAW transcript
  (multi-param DECSET split; last set/reset per mode; most-capable tracking mode only; encoding after tracking;
  restores hidden-cursor; alt-screen deliberately excluded), appended after the grid. Verified on the live session
  bytes (emits ?1003h ?1006h ?25h — exactly Claude Code's state). Composes with the grid fix: bulk-bytes removal
  un-hijacks the wheel handler (baseY≈0) AND tracking restoration forwards wheel into the TUI = desktop-parity
  scrolling. 690 tests green.
- C23j `fixed — the path the live session ACTUALLY takes` — live subscribe (sessionsPty.ts:56,
  LIVE_TERMINAL_SUBSCRIBE_MAX_BYTES=2MB) emits backlog as `replace:true` PtyDataEvents →
  `applyPendingReplaceWhenFitted` wrote the raw bytes verbatim (reset+write), bypassing all normalization → baseY
  large → wheel hijack + no modes, regardless of the preview-path fixes. Now the replace payload gets the same
  grid+modes treatment (async, generation-token guarded against newer snapshots; raw fallback if normalization
  declines); baseY added to the [ade-term] detector; the one timing assertion updated with its guarantees intact.
  709 tests green. Deliberate-raw stays only for true REPLAY of disposed sessions (where scrollback IS the product).
- C24 `NEW, pre-existing DESKTOP bug found during verification` — @xterm/addon-serialize emits tracking modes but
  NOT ?1006 (SGR encoding) or ?25: desktop hydration silently downgrades to X10 mouse reporting, which cannot
  address columns >223 — wide-pane clicks/wheel on the right side report the wrong cell. Fix candidates: append
  missing modes after desktop snapshot writes (mirror the web inference) or upstream/patch serialize. Polish loop.
- C23g `host follow-up (bundle with C22b/C23c/C23e)` — NOTE: when the wire snapshot gains a grid, it MUST carry
  modes too, or C23i's bug returns via the new path. Measured spec (from the mode work): TUIs like Claude Code
  RE-ASSERT modes continuously (worst gap 1.16MB vs the 2MB tail — tail inference holds, with margin), but a
  once-setting TUI + >2MB quiet output breaks it (detector line `hydrate-no-modes-recovered` marks that case).
  Host fix: additive `modes` field on SyncTerminalHistoryResponsePayload populated from the headless mirror —
  and NOT via SerializeAddon's output alone, which omits ?1006/?25 (the C24 desktop bug). — Add structured grid rows to SyncTerminalSnapshotPayload,
  populate from the host's existing `readStoredTerminalSnapshot`, return as real `snapshot` in sessionsPty so web
  takes desktop's branch: removes the client re-render AND a ~250x relay bandwidth win (2.9KB grid vs 708KB bytes).

### C25 — CSS zoom broke ALL xterm pointer math (FIXED; one root cause, two symptoms)
- C25 `fixed, measured Chromium+WebKit` — Body `zoom` (factor 1.1 at "100%") inflated xterm's pixel→cell math
  (clientY in zoomed space ÷ cellHeight in unzoomed px; error ACCUMULATES down the pane, worst +2 rows) →
  (a) selection/copy landed rows low; (b) with mouse tracking active, WHEEL reports carried the same wrong cell →
  TUI scrolled relative to wrong lines. Fix: terminal host gets `zoom: 1/factor` (compounded zoom at xterm = 1)
  + fontSize scaled by factor in doFit; baseFontSize prevents compounding; bonus: native-resolution canvas at all
  zooms. Post-fix getCoords exact at every row in both engines.

### C26 — Serial connection-candidate dials cost up to ~24s per connect (follow-up, feeds ALL "slow" feels)
- C26 `characterized, queued` — `connectWithCandidates` (connection.ts:511) awaits candidates strictly serially:
  8s transport + 12s hello budget per dead direct candidate (127.0.0.1/LAN/tailnet) before relay is tried LAST —
  worst ~24s pure waiting per connect for any off-network browser. Fix: happy-eyeballs race with short direct
  head-start, or skip direct after first network-level failure. Real connection-logic redesign — queue with the
  host bundle / WS-H follow-up. Also part of machine-switch latency perception.

### C27 — Fallback-proxy audit results (live from console) + attention hardening
- `fixed`: cto.getLinearConnectionStatus wired (host descriptor existed, viewer-allowed — CTO tab's Linear panel
  showed permanently-disconnected on web); attention relay exponential backoff (rejected CORS preflights THROW —
  no response.ok path ever saw them) + `^/attention/` dev proxy. `safe no-ops` (classified): usage.onUpdate,
  app.onRuntimeStatusChanged, app.setDockBadgeCount, attentionNotch.* (notch hidden on web).
- `/test-phase note`: two TerminalView paste tests are FLAKY under parallel load (pass isolated + on rerun;
  disclosed, not chased) — pin during /test.

### C28 — Safari paste-callout on every click (FIXED; self-sustaining focus loop)
- C28 `fixed` — `ClipboardDeeplinkBanner` read the clipboard on mount AND every window focus (desktop-shaped
  ade://-link detection). On Safari each speculative read pops the permission callout; the callout steals focus;
  dismissing it re-focuses the page → re-read → new callout under the pointer — the "every click shows Paste,
  second click lands" loop. Fix: banner inert in web mode (its payoff — openExternal of an ade:// link — is
  meaningless in a browser anyway). Two more Cmd+V-only speculative fallbacks web-gated (TerminalView 120ms
  readText timer — browsers always fire the paste event it insures against; composer image-paste timer). Full
  clipboard-READ call-site enumeration recorded in the agent report; writes are callout-free. Defense-in-depth
  option (userActivation gate in safeClipboardRead) considered and deliberately not taken (browser-dependent);
  the adapter function is the chokepoint if ever wanted. New 2-test coverage for the banner (none existed).

### C29 — The persistent terminal scrollbar + "wheel scrolls the whole thing" (FIXED; the grid was taller than the pane)
- C29 `fixed, measured Chromium + WebKit, zoom 1.0 and 1.1` — **The C23f/C23j normalization grid is a FIXED 96-row
  mirror, and every row beyond the viewer's own row count becomes scrollback.** `normalizeTranscriptToGrid` renders
  the transcript into an offscreen 96-row xterm and returns every non-blank row (measured on the owner's own
  session `a629d31c`: 65 rows). Hydration then wrote all 65 into a pane that fits 54 (48 at 1.1 zoom) → `baseY`
  11 (17 at 1.1). That single number produces BOTH reported symptoms: xterm 6 draws its own scrollbar element, and
  `.xterm-viewport` never scrolls natively (`scrollHeight === clientHeight`, no `.xterm-scroll-area`) — the
  measured DOM flips `class="invisible scrollbar vertical"` → `"visible scrollbar vertical"` with a 628/756px
  slider, which is why every CSS/overflow hunt came up empty; and TerminalView's own wheel handler takes its
  local-scrollback branch (`hasScrollback && mouseTrackingActive` → `scrollLines` + `preventDefault`), so the
  wheel moved the mirror and the PTY received NOTHING. Fix: `normalizeTranscriptToGrid(raw, { maxRows })` keeps
  the LAST `maxRows` rows; both call sites (hydration + the C23j replace path) pass the fitted `term.rows` via
  `hydrationGridMaxRows`, which returns undefined while unfitted so an 80x24 constructor size can never truncate
  a real screen. A hydration grid is a picture of the current screen — the desktop's snapshot carries exactly the
  host's rows for the same reason, which is why desktop never showed this.
  **Before/after, all 8 cells (Chromium+WebKit × zoom 1.0/1.1 × before/after), shipped code driven by a Playwright
  harness over the real 2 MB transcript tail:** baseY 11/17 → 0; scrollbar `visible` → `invisible`; wheel
  `localScrolled=true, viewportY −4, ptyOut=""` → `localScrolled=false, ptyOut="\x1b[<64;100;28M"` (the SGR
  wheel-up report reaching the TUI). 622 terminal tests green (all prior C23 fixes intact).
- C29-timeline `explained` — "it worked at first, then appeared mid-session" is consistent: the grid path itself
  landed mid-session (C23f/C23j), and before the C6 `#root` height fix the pane had no real height for a scrollbar
  to paint down. The overflow was deterministic from the moment both were true.
- C29-testdebt `open` — no jsdom regression test: the mocked `Terminal.write` never invokes its completion
  callback and the mock buffer has no `getLine`, so the offscreen mirror cannot render — the same constraint
  already recorded as C23d. The browser harness is the regression artifact; a real test needs a headless-xterm
  fixture.

### C31 — The scrollbar/jargon endgame: unfitted hydration damage + an uninstrumented live path (FIXED)
- C31a `fixed, reproduced-first` — **Unfitted hydration writes at xterm's 80×24 constructor size** when the fit
  budget (20×60ms) expires (routine under C22c keep-alive: panes hydrate while hidden/unmeasured). Measured on the
  real transcript: baseY 60 + 30 wrapped rows at write → after the pane fits, xterm re-wraps partially but
  committed damage stays: **baseY 1 (near-full-height visible slider), ~10 lines of scrollback, surviving garbled
  rows** — the owner's exact symptom triple. Fix: `rehydrateAfterFit` — hydration completing unfitted arms a flag;
  the FIRST successful fit bumps the generation and re-runs hydration; damaged case now measures identical to
  healthy (baseY 0, wrapped 0, bar invisible; both engines). Armed from both fall-throughs incl. the replace path.
  jsdom regression test + keep-alive reveal-refit verification in flight. (C29's clamp fixed the fitted/over-tall
  case; this fixes the unfitted case — different bugs, same visible signature.)
- C31b `fixed — why every console capture was silent` — Live web sessions hydrate via the subscribe backlog
  `replace:true` path, which marks hydration complete WITHOUT ever calling reportHydrationComplete — finalize (the
  only logger) is bypassed by design on exactly the path web always takes. Desktop uses preview→finalize→logs.
  Same component, two hydration paths, one instrumented — "zero [ade-term] lines" was the code working as written,
  not a wedge. Fix: replace path reports `source=replace` + truthful `normalized=`; decline reasons now logged
  (`hydrate-normalize-declined` with cause). Auditor correctly REFUSED the speculative preview-timeout I asked for
  (nothing hangs; the promise is deliberately discarded) — recorded as the right kind of pushback.
- C31c `verified en route` — Normalization decline hypothesis measured DEAD (156 cols inferred at every tail size
  on the live, rolled-over transcript). Multi-instance probe artifact explained (first .xterm = healthy instance).

### C33 — /quality gate item, disposed by owner's standing merge instruction
- C33 `accepted-unfixed, designed follow-up required` — TUI-heuristic waiting-input emits
  `attentionSource: "provider_structured"` (a lie: it's a regex read). The label is LOAD-BEARING: canonical
  attention only grants needs_you + Settle through it (`sessionCanonicalState.ts:122`), and
  `SessionStatusSlot.tsx:103` keys dismissibility on it — so a relabel without a cross-surface contract change
  (new `tui_heuristic` member + tier decision + iOS decoder + dismiss-clause inversion, 5 surfaces) regresses
  behavior. Owner's C7b decision wanted heuristic waiting feeding Attention, so BEHAVIOR matches intent; only
  provenance is dishonest. Full analysis in `tuiRowOverlay()`'s docblock (ptyService.ts). Disposition: ship as-is
  per owner's explicit merge instruction; schedule the tier design with the C7b follow-on.

### C32 — Polish backlog (from the final live round; queued for quality loop)
- C32a — **"Orphaned sessions" flash on cross-machine project open**: connecting a second machine for the same
  project shows every remote lane as "Orphaned sessions — lane record missing from latest runtime snapshot" and it
  STICKS until any interaction/tab-switch forces a refresh, then reconciles into proper machine-badged rows.
  Race: session rows arrive before the other machine's lane records; web lacks the reconcile trigger desktop's
  event stream provides. Fix direction: after machine-connect/roster merge, schedule a lane/session reconcile pass
  (or suppress the orphan classification while the owning machine's snapshot is still pending).
- C32b — Typing latency variance on web ("sometimes fast, sometimes sucks"): remaining suspects = parked-stream
  wire bytes (measured follow-up per laghunt), relay RTT variance, dev-mode overhead. Measure in quality loop.
- C32d — **Context-menu submenus overflow the viewport on web** (session right-click → Lane submenu renders
  half off-page bottom-right; screenshot evidence). Submenu positioning lacks viewport clamping/flip in the
  browser (Electron window sizing may have masked it). Audit the shared context-menu component's collision
  handling on web; clamp/flip like the parent menu presumably does.
- C32c — Forwarded wheel scroll speed is 1:1 (amplification reverted after live backpressure); acceptable with
  Shift+wheel local fast path; future improvement belongs in the host bundle (frame coalescing), not report
  multiplication.

### C30 — Latent: PaneTilingLayout Panel's overflow-hidden class is dead
- C30 `flagged, untouched` — `PaneTilingLayout.tsx:518` puts `overflow-hidden` (class) on a react-resizable-panels
  Panel whose inner div carries inline `overflow: "auto"` — inline wins, so the clip the author intended is dead
  and any over-tall pane content silently becomes a scroll container inside its tile. Not tonight's symptom (not
  overflowing currently). Fix: pass `style={{overflow:"hidden"}}`. Behavior-change risk → quality loop.

### C20 — Repo-wide latent trap: Tailwind v4 color utilities are ALL dead
- C20 `systemic, ledgered` — Palette (--color-card/fg/muted-fg/border/accent…) lives in `:root`, not `@theme`;
  the v3 tailwind.config.cjs is never loaded (no @config). Every project-color utility (bg-card, border-border,
  text-fg, bg-muted-fg…) compiles to ZERO rules; built-in palette colors work. Invisible for text (inheritance
  masks it) but any utility-first floating surface ships with NO background and currentColor (white) borders —
  exactly how the connections chip shipped broken (fixed by moving to the sibling inline-token pattern; verified
  via the compiled stylesheet `?direct`). Fix options for quality loop: wire palette into @theme + audit the
  visual diff across 177 files, or lint-ban the dead class names.

## Raw reports (chronological, cross-referenced into clusters)

**R1 (2026-08-02)** — Landing-page "Help improve ADE?" consent box: remove, collect regardless. → C1a
**R2** — Web client shows same analytics banner at top: remove completely. → C1b
**R3** — Hub ("Workspace Hub / Machines and projects") UI/UX is bad; should look like desktop app's launch surface;
signed-out users should see a mandatory sign-in (no skip, unlike desktop) before seeing anything; then desktop-like
recents + machines screen; connections UI should be a first-class part of the main screen. → C2a/C2b/C2c
**R4** — Both machines show OFFLINE while demonstrably reachable (Reconnect works instantly). → C3
**R5** — "Lanes changed / Lane archived" bottom-right toast never goes away; X it, comes back immediately. → C4
**R6** — All projects show "0 lanes" in the machine's project list, which is false. → C5
**R7 (discussion)** — Multi-machine: could web connect to N machines at once with Work aggregating all (like desktop),
other tabs following the selected machine? Owner leans: single-machine-at-a-time done extremely well for now. →
architecture note in Workstream candidates. **CONFIRMED by owner (round 2): single machine now, build so aggregation
stays possible later.**
**R8 (round 2)** — /work screen renders in top half of browser window, bottom half dead; banner+toast still present
(expected — no fixes shipped yet). → C6 (new), C1b/C4a (already ledgered)
**R9** — "Hub" tab in top-left should go away with the desktop-style main screen. → folded into C2b redesign scope.
**R10 (owner, cross-cutting)** — CLI session "Working Ns" timer resets every ~5 s; wrong on desktop and web alike;
owner unsure how status can even be derived for uncontrolled PTYs. → C7 (new, cross-cutting)
**R11 (self-observed from owner's screenshot)** — session preview line has all spaces stripped. → C8 (new)
**R12 (round 3)** — Provider usage not visible on web client (permanent skeletons, "Waiting · not updated"); works
everywhere else including mobile. → C10 (new)
**R13** — Pasting an image into the web terminal required Ctrl+V instead of Cmd+V; owner unsure which is expected on
a Mac browser driving a remote PTY. → C9 (new; verdict: Cmd+V is expected and is broken; Ctrl+V is a same-machine
coincidence with wrong-machine semantics when remote)
**R14 (round 4)** — Lanes tab render also clipped, at a different height than /work. → C6 confirming evidence (not a
new bug).
**R15** — Zoom control (top-right − 100% +) does nothing on web. → C11 (new)
**R16 (discussion)** — Graph/canvas tab hidden on web, but its CONTENT renders fine when reached via the Lanes
"Stack graph" dropdown button. Owner asks: if hidden tabs already work over the adapter, why not surface them
(assuming no perf/first-load cost)? → hidden-tabs audit → C12; owner approved Graph/History/CTO/Settings-split
(round 5).
**R17 (round 5, perf)** — Files tab on web is noticeably slow: opening folders, viewing files, editing. Works, not
terrible, but wants real efficiency gains. → C13 (new; tracer running)
**R18 (round 5, perf)** — PRs tab also slow: merged PRs load and PR details. Owner unsure if desktop-shared. →
C14 (new; tracer running with attribution deliverable)
**R19 (process)** — Owner: after research completes, run /plan ONLY for unsure/new-design items; confirmed
mechanical fixes skip planning and go straight to execution.

### C14 — PRs tab latency — DIAGNOSED (mixed attribution; owner's "is it desktop too?" answered per symptom)
- C14a `diagnosed, web-only, biggest` — **Web adapter routes list reads through the expensive aggregate instead of
  the cheap command.** `adapter/prs.ts:72-96/:163-171` sends `listAll`/`getForLane`/non-conflict `listWithConflicts`
  to `prs.getMobileSnapshot`, whose `buildMobileSnapshot` unconditionally runs `conflictService.scanRebaseNeeds()` —
  a sequential per-lane git sweep (`rev-list` + `merge-tree`, 60 s timeout, no memoization,
  `conflictService.ts:4321-4429`) + double lane list. Desktop's `listWithConflicts{includeConflictAnalysis:false}`
  is a bare DB read (`prService.ts:9777-9786`) and IS registered as a relay command (`:5201`) — web just doesn't
  call it. Cold tab open = 4 git sweeps on web vs 2 on desktop, each head-of-line-blocking ALL other `window.ade`
  calls (per-peer serialization, `syncHostService.ts:3343`). Fix: point the three reads at the real commands.
- C14b `diagnosed, web-only feedback loop` — `invalidation.ts:78-87` maps any table containing `queue` or
  `integration` (e.g. `linear_dispatch_queue`) into the `prs` domain; adapter clears cache FIRST then rehydrates the
  full aggregate and synthesizes `prs-updated` (`adapter/prs.ts:51-65`); `GitHubTab.tsx:335-346` consumes it with
  NO freshness guard (unlike `:366`) → full GitHub snapshot reload with merged payload per unrelated queue write.
  Host already sends a proper `prs_updated` envelope (`syncHostService.ts:8617-8623`) — **webclient drops it, no
  handler**. Fix: narrow the classifier, add the freshness guard, handle the real envelope.
- C14c `diagnosed, web-only` — **Detail opens: ~16-17 serialized relay round-trips; the batched command already
  exists, unused.** `prs.getMobileGithubDetail` (host `Promise.all` fan-out of detail/status/checks/reviews/
  comments/files/commits/threads/runs/timeline, `prService.ts:11667-11710`, viewer-allowed `:5260`) has ZERO
  references in the webclient. Steady state with Checks open ≈ 64 serialized round-trips/min (5 s pane + 2.5 s
  mergeability polls) — also lengthen polls on relay transport.
- C14d `diagnosed, desktop-shared` — Host detail path has NO server-side TTL and never reads
  `pull_request_snapshots` (write-through only): ≥5 duplicate `GET /pulls/{n}` per cold open, ~26+ GitHub requests
  min. The ade-perf-prs skill's "hydrate from snapshots first" rule is renderer-honored but never host-implemented.
  Fixes: memoize `GET /pulls/{n}` per (repo,number) few-second TTL; `getActivity` reuse instead of re-fetch;
  stale-while-revalidate snapshot reads; defer files/commits to Files tab.
- C14e `diagnosed, desktop-shared` — Merged path: `fetchMissingSameRepoLanePulls` loses its skip-filter when
  `includeExternalClosed` (`prService.ts:9093`) → up to 12 redundant branch lookups; shared 2-min TTL forces merged
  re-fetch even from the Open view (`:9231-9236`); rate-limit credential fallback (PR #996) multiplies latency
  serially (by design). Web adds a payload tax: up to 1000 unprojected rows double-base64'd through the relay
  (project a lean list shape). Note: merged is fast once `github_pr_projections` warm → matches "intermittently
  slow" feel.

### C13 — Files tab latency on web (perf + a twin correctness bug) — DIAGNOSED
Relay is NOT a factor (`tunnelDo.ts:686` pure passthrough; each op = 1 logical RTT). Three compounding causes +
one broken-both-ways invalidation path.
- C13a `diagnosed, correctness+perf twin` — **Cache wiped constantly AND view permanently stale.**
  (i) Substring-matching bug: `invalidation.ts:88-90` maps any table containing "file"/"tree"/"git_status" to the
  `files` domain — matches `lane_worktree_locks` ("work**tree**", heartbeat-updated, CRR-replicated) and
  `lane_branch_profiles` ("branch_pro**file**s") → ordinary lane activity clears the whole files read cache via
  `adapter/files.ts:69-83` `clearReadCache()` every few seconds (250 ms debounce). **C4b churn CONFIRMED as the
  feeder.** (ii) Dead-end refresh: the resulting `filesChanged` carries `path: ""` and `enqueuePathRefresh`
  (`FilesWorkbench.tsx:744`) starts with `if (!path) return;` — so no host-side file change EVER refreshes the
  tree/decorations/open editor on web (adapter `watchChanges` is a no-op, host rejects watch actions,
  `syncHostService.ts:5906-5908`). Permanently cold cache + permanently stale view. Fixes must ship together:
  correct domain mapping (exact table names, not substrings) + a real full-refresh path for `path: ""`.
- C13b `diagnosed, client RTT waste` — Ranked: (1) `openFile` never checks the 48-entry content LRU
  (`FilesWorkbench.tsx:848`) — most common action, pure waste, ~10 lines; (2) save costs 4 RTTs (write + echo
  re-read of bytes Monaco holds + tree re-list + decorations) — suppress self-originated modified echo → 2 RTTs;
  (3) `adapter/files.ts:65` clears ENTIRE read cache per write — use existing unused `invalidate(predicate)`;
  (4) mount chain is 3 serialized RTTs (`listWorkspaces`→`listTree{depth:1}`→`refreshGitDecorations{forceFresh}`) —
  `Promise.all` + speculative listTree from roster-seeded workspace id; (5) root depth 1→2 (one line, host clamps
  1..8); (6) drop `forceFresh:true` on mount (`:516`, bypasses host 5 s SWR git-status cache + dedupe); (7) batch
  listTreeChildren across parents (protocol change); (8) pipeline 512 KB range reads (5 MB file = 11 sequential
  RTTs today); (9) native `Uint8Array.fromBase64` decode (per-char loop today, `wireProtocol.ts:76-84`).
- C13c `diagnosed, host-side` — (1) **Every file request pays a workspace-roster scan it discards**:
  `assertMobileExternalWorkspaceBlocked` (`syncHostService.ts:5847`) eagerly resolves workspaces (fs.existsSync +
  statSync per non-primary workspace + 2 sync DB reads) but its guard only applies to mobile+external — check
  `isMobilePeer` first; ~3 lines, cheapest fix available. (2) **Per-peer serialization**: every envelope awaited on
  one `peer.messageQueue` chain (`:3341-3347`, file_request awaited `:7796`); a cold searchText index build or git
  blame head-of-line-blocks all reads → the "intermittently stuck" feel; caps client parallelization wins.
  (3) `readFile` stats + reads first 8 KB twice (`fileService.ts:1014-1102`). (4) Sync `realpathSync`/`lstatSync`
  per path segment per request (`shared/utils.ts:294-334`). (5) Sync gzip on event loop (`syncProtocol.ts:221-224`);
  images double-base64'd. (6) `listTree` has no cache; `listTreeChildren` cache is 2 s/32 entries.
- C13-risk `stability flag` — `sendRequired` CLOSES the peer socket at 16 MiB buffered (`syncHostService.ts:382`,
  `:4243-4256`; 60 s message timeout also closes) and `refreshGitDecorations` returns an UNBOUNDED changed-file +
  ancestor list (`fileService.ts:487-497`) → a huge dirty tree can drop the whole connection instead of degrading.
  Same failure family as the known 16 MiB RPC buffer incident. Byte-cap the decorations response.
  Host side DONE (2 MiB estimated-serialized cap + 20k entry cap, shallowest-first, `fileService.ts`
  `capGitDecorationEntries`). OWED: `FilesGitStatusEvent.truncated` is set but has no consumer — the renderer
  (`FilesWorkbench.tsx` decoration merge) should surface a muted "some decorations hidden" hint so a capped
  response doesn't read as "these deep files are clean".

---

## Workstream candidates (draft after round 1 — will re-cut as more reports arrive)

- **WS-A "Collect by default"** (C1a + C1b) — self-contained, no cross-dependencies, ~2 predicate flips + banner
  removals + 1 test rewrite + doc updates. Ships independently.
- **WS-B "Pre-project experience rebuild"** (C2a–C2d + C3) — the big one: mandatory sign-in gate (un-bypass
  LaunchGate, no skip on web), desktop-style welcome/recents replacing WebWorkspaceHub as landing surface,
  IndexedDB catalog persistence, honest machine status via `accountMachineConnectionState`, select-to-connect.
  Design + implementation workstream; keeps Hub's machine-management guts as a manage surface.
- **WS-C "Host catalog truth"** (C5) — ade-cli lane-count helper; also fixes iOS catalog. Small, independent.
- **WS-D "Web event/invalidation hygiene"** (C4a + C4b + C6) — neutral lifecycle type + toast guard, refresh-policy
  fix for the invalidation→includeStatus→write→invalidation cycle, and the one-line `#root` height fix. Likely
  absorbs future "phantom event/refresh/layout" reports as they arrive.
- **WS-E "CLI session telemetry fidelity"** (C7a + C8a + C8b; C7b as stretch/follow-on) — all three bugs live in the
  same `ptyService` telemetry pipeline (runtime state + preview builder) and ship to every surface through
  `enrichSessions`/`last_output_preview`. Turn-anchor fix (3 edits), cursor-aware preview parser + split-CSI carry,
  then optionally TUI-marker → `chatActivityMode` mapping for planning/asking states. Cross-cutting (desktop, web,
  iOS all benefit); not web-only despite being reported from the web client.
- **WS-F "Web adapter parity & input fidelity"** (C9 + C10 + C11 + C10-sys/C12-pattern sweep) — surfaces that exist
  on desktop/iOS but are silently dead or degraded on web: missing adapter passthroughs (usage panel), ignored
  browser-native input channels (paste-event image items), root-element CSS zoom no-op, and the two systemic
  silent-failure layers (fallback-proxy nulls + missing-descriptor fallback resolution). Includes converting write
  fallbacks to throwing refusals. Expected to grow as testing continues.
- **WS-G "Tab expansion on web"** (C12) — staged: (1) immediate: enable Graph (+hide openFolder), flip web
  `automationsEnabled` to false, gate CTO idle-preload; (2) small: History's 3 host descriptors + CTO selective
  adapter wiring (excluding token setters) + Settings split; (3) larger: Review/Automations host command surfaces;
  (4) security review of viewer-allowed write actions (C12-sec) — should precede (2)'s CTO work.
  **OWNER DECISION (round 5): approved — bring in Graph, History, CTO, and the workable Settings sections.**
  Settings semantics follow desktop's remote-connection model: machine-scoped sections read/write the connected
  Mac (via descriptors, clearly labeled as that machine's settings); browser-local sections (appearance, zoom,
  layout) stay per-browser. Review/Automations remain deferred pending host command surfaces.

- **WS-H "Live-read performance"** (C13 + C14) — the relay is exonerated; the workstream is round-trip economics +
  host hygiene. Sub-tracks: (1) invalidation-domain correctness (C13a substring bug + C14b queue/integration bug —
  same classifier file, fix together, unblocks C4b); (2) client RTT waste (C13b + C14a/C14c command rerouting —
  mostly mechanical); (3) host hygiene (C13c roster-scan guard, per-peer queue head-of-line, C14d TTLs/dedupe —
  benefits desktop too); (4) stability caps (C13-risk decorations byte-cap). Only the per-peer queue redesign and
  the listTreeChildren batching protocol need deliberation; the rest is execute-directly.

Architecture note (R7): multi-machine-aggregated Work is deferred; session pool (4 clients) + federated per-tab
bindings already exist, so single-machine polish now does not foreclose aggregation later.

---

## RESEARCH PHASE CLOSED (2026-08-02). Final tally: 14 clusters, ~35 diagnosed items, 8 workstreams (A–H).
Plan-skill agenda (deliberate) vs execute-directly split recorded in the closing summary; every execute-directly
item carries file:line root cause + agreed fix direction in its cluster entry.
