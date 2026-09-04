Linear ticket: ADE-148 (https://linear.app/ade-linear/issue/ADE-148). Keep this file and the ticket in sync.

## Why this ticket exists

The `plugin-platform` branch is a three-week program. The coordinating Claude session lost access on 2026-09-01. This ticket is the full handoff. Read it top to bottom before you touch the branch.

Branch: `plugin-platform` (origin). Last merged `origin/main` at `9bb2b26b3` (2026-09-02). Unit A is committed (`02090d9e7`). Unit B is in progress. Compiled Linear and Cursor Cloud stay in the binary until Unit C passes.

## Read these first, in this order

1. `docs/features/plugins/README.md` — the platform contract. Updated at the handoff commit to cover every seam listed below (auth sessions, credential handoff, official client broker, issue links, session env, URL matchers, graph-node socket, vocabulary growth, the two polarities, program status).
2. `docs/logging.md` — section "Plugins" (new at the handoff commit): every `plugin.*` structured event, its sink, and what may reach PostHog.
3. `docs/reports/linear-plugin-parity-map.md` — the 113-row audit of the compiled Linear integration vs the plugin. The 7 C items and 5 B items in it are all built.
4. `docs/reports/cursor-cloud-plugin-extraction-spec.md` — Cursor Cloud extraction spec (wave 1 shipped). Remaining gaps after merging origin/main are listed under Unit B below.
5. `docs/reports/custom-ui-reach-design.md` — Tier 2 (webview) reach design.
6. `plugins/ade-linear/` — the worked example of a real plugin (8.8k lines JS, 467 node tests, `test/*.test.js`). Read `plugin.json` first, then `index.js`, `connect.js`, `flows.js`, `panels/contract.js`.
7. `plugins/README.md` — plugin authoring guide.

## The product decision that governs everything

The owner's words: gating shells are NOT acceptable. Everything extracted as a plugin must be a full extraction. The ultimate test: an ADE install with no Linear, install the plugin from the Marketplace, and it works fully on desktop and mobile.

Standing rules from the owner:
- Use Claude Opus 5 MEDIUM subagents for implementation (the owner is low on Claude credits). Never Fable subagents. The coordinator writes specs, judges results, and owns commits.
- No Codex unless the owner names it for a task.
- No git worktrees.
- Agents never commit. The coordinator commits by explicit path per unit.
- Never invent platform semantics. If the code does not do it, do not document it.
- Never restore deleted branches.
- Test prompts for the owner must be plain language a new user would type.

## What is built (waves 1-3, all committed and pushed)

### Platform seams (generic, usable by a Jira-class third-party plugin)
- C1 host-brokered auth sessions: `authSessions` in the manifest; the host builds the URL and holds `state`; loopback and app callbacks; iOS `ASWebAuthenticationSession` runner (`PluginAuthSessionRunner.swift`); relay route `/plugin/auth/callback`.
- C4 credential handoff: `credentialHandoff` — COPY, not move; the OAuth client secret is withheld; consent card; connections leave with the plugin.
- `auth.officialClient` broker (`apps/desktop/src/main/services/plugins/pluginOfficialClients.ts`): a public PKCE client id lent to builtin-surface owners; `assertNoClientSecret`.
- C2 issue links on lanes and sessions: `sdk.lanes.linkIssue`, `lanes.listSessionIssues -> [{sessionId, issueLinks}]`, `laneService.ts listIssueLinksForLaneSessions`. Version-inside-JSON rule: `__issueRef` beside the legacy projection, NO SQL migration (`issueRef.ts` — read its comment before "fixing" it into a column).
- PR transitions: `PluginPrTransition`, produced ONLY by the daemon (`apps/ade-cli/src/bootstrap.ts` inside `onPullRequestsChanged`); `pluginEntityChanges.ts prTransitionsFromChanges`.
- C5 session env injection: `sessionSetup` with the static `ADE_PLUGIN_` prefix and an unforgeable `ADE_PLUGIN_SOURCE_ID`.
- C6 URL matchers: `urlMatchers` (no-regex grammar), chips + deeplink ownership; the `linear.app` relaxation is keyed on surface OWNERSHIP (`coreSmartLinkBuiltinsOwnedBy` in `urlMatchers.ts`). iOS renders plugin URLs as plain links (limitation).
- C7 graph-node socket on the lanes surface (far-end-only edges, caps 24/48/4, desktop + web only).
- Webhook ingress with declared verification: `webhookIngress.verify {kind: hmac-sha256, secretRef, header}`, fail-closed; `linear-signature` in `PLUGIN_WEBHOOK_STORED_HEADERS` (`apps/webhook-relay/src/relay.ts`).
- Sync: plugin tables are CRR at creation (`ensureTablesAreCrr` + two-shape repair); per-device plugin watermark in a local-only table, never seeded from the peer version space; local-only CRRs filtered from `exportChangesSince`.
- Chat runtime seam (PX-10): `runtimeRef`, `sdk.chat.*`, presence via the existing watch action, hydrate paging.

### Vocabulary (Tier 1, data-never-code, 4-client parity desktop/web/iOS/TUI)
Rich list rows, bound rows may act + confirm, `{openUrl}`, banners, refresh contract, segmented + `where` client-evaluated three-valued state, `{prompt}` one-hop text capture, `config.set`, `since/before/$rel`, `form.applyOnChange`, markdown node (bounded AST, no HTML path, 4000-char cap), `list.selectable` + bulk bar (visible-intersection batch, refuse-not-evict), `segmented.optionsFrom` (50 cap, menu past 8, signs the binding not the options), `group` node, `maxStateKeys` 8, `maxListItems` 250 with honest paging labels, iOS back stack (push snapshot incl. state signatures), brand icon tokens (`brand:cursor/claude/codex/github/openai`), `{navigate target: tools-pane}` default for chat sockets.

### ade-linear (wave 3, a real plugin)
Two-half build (core + panels) with a seam contract test owned by neither half. Five seam defects were found only by cross-half tests: `panels.build` missing, undressed rows, three colliding action ids, context-less `publish(panelId)`, `clientSource` read at the wrong level. LESSON: any split plugin build must have the cross-half test mandated up front.
Manifest: tab surface `linear` (panels issues/issue/settings/launch), work-rail pane, chat-header + composer actions, row-badge + graph-node, `urlMatchers` for linear.app, `authSessions`, `credentialHandoff ["linear"]`, `network ["api.linear.app"]`, `webhookIngress` channel `linear` with hmac verify, 8 collections, 5 automation triggers, `cli ["linear"]`, skill.
`TRIGGER_ID_REMAP` frozen at `webhook.js:52`.

### The supersedes flip (commit 54df53935)
`linear` builtin surface = `supersedes` on all four clients (`builtinSurfaces.ts:190`, `manifest.ts PLUGIN_BUILTIN_SURFACE_PRESENCE`). `actionDomains` empty; `actionNames` = all 30 `linear_*` verbs: advertisement hides, DISPATCH STAYS OPEN (refusing would break in-flight chats and paired phones). The missing-surface denial asks `builtinSurfaceDrawn`, not `Installed`. Gated sites: TopBar quick view, Integrations card, lane badges, composer attach, Create-PR card + close-on-merge, both Copy-Linear-link menus, automations trigger tile + ingress strip + templates, `integrations.linear` settings entry (nav/search/⌘K), all 7 TUI `/linear` rows, iOS pane + toolbar button + CTO Settings card (`awaitDrawsBuiltin` replaces the polarity-blind `awaitOwner`). Rule: gate entry points and connection UI; keep read-only rendering of data the user already has.
Gates at the flip: 5,111 desktop vitest, 1,500 ade-cli vitest, 467 plugin node tests, 291 iOS XCTest (real `xcodebuild`), typecheck clean, NUL scan clean.

IMPORTANT: the compiled Linear code is STILL in the binary. Deletion is wave 5. With no plugin, ADE shows the compiled Linear integration unchanged. With the plugin installed, every compiled surface hides and the plugin does all the work.

## The test we were about to run (do this before any deletion)

Rebuild Alpha + Debug iOS from `origin/plugin-platform`. Then:
1. Before install: ADE looks as before (compiled Linear visible on Mac and phone).
2. Install `ade-linear` from the Marketplace.
3. Mac: confirm every compiled Linear surface is gone (list above). Phone: pane, toolbar button, CTO Settings card gone; the CTO Settings sheet opens without a crash (no test constructs `CtoSettingsScreen`; the presenter audit found exactly one construction site at `CtoRootScreen.swift:43` with both environment objects injected).
4. Connect via handoff card (existing credential) or sign-in (ADE's official client, asks `admin`).
5. Mac: list issues, open one, change state, comment, lane from issue, attach in composer, agent from issue, PR -> Done on merge.
6. Phone: tab, detail, state change, back stack, connect.
7. Disable the plugin: compiled Linear returns unchanged.
This is the "switch to the plugin version on install, do not remove code from the binary yet" test. The owner extended it: run the same test for EVERY extracted plugin at once (see scope below) so one build proves the platform.

## Product decision (settled 2026-09-01, owner's call)
Self-registered Linear OAuth clients used to request `read,write`, so their webhooks never fired (a faithful port of `linearOAuthService.ts:260`). The owner chose the full product for a self-registered app: `SCOPES_CUSTOM` is now `read,write,admin`, so a custom client's webhooks deliver. An existing custom-client user re-consents on their next sign-in, which is the accepted cost. `webhooksReachable` now tests for an OAuth grant rather than for ADE's own app, and the three "webhooks are impossible" surfaces (settings panel, `ade linear status`, ingress strip) are gone. The remaining warning is the API-key connection, which carries no OAuth grant at all, plus the missing-signing-secret warning.

## THE NEW SCOPE (owner's instruction on 2026-09-01, verbatim intent)

"The exact same plugin as it is now, native to both desktop and mobile." No reduced-polish versions. And: "everything that was in ADE before this Marketplace stuff, of those we have extracted as plugins, including Linear, all of it should be this same gate: still in the install, but on plugin install it changes to the plugin version, for both mobile and desktop, and expand language or logic as needed. With that we can test multiple things at once, and if they all work as expected, we know our plugin system is sound and ready for a real push to main."

### Unit A — Linear at full parity (vocabulary growth + plugin adoption)
Every reduced item becomes a vocabulary node on all four clients, then ade-linear adopts it. The reduced list (the owner's success metric, unsoftened):
Phone LOST: sticky launch bar (no sticky footer/action-bar region); Linear brand glyph (no `brand:linear` token; a plugin cannot ship a mono glyph); org-avatar initials fallback.
Phone REDUCED: search is a `{prompt}` not a nav-bar search field; paging 250 via button vs ~1000 on scroll; group headers carry no state icon; filter chips wrap (8 segmented) vs one horizontal scrolling strip; markdown has no images/tables and >4000 chars renders plain; priority = one icon token (three levels share one glyph); no red/destructive tone; comments window 20; Open-in-Linear in body not nav bar; model picker = flat select <=40; writes are round-trips (no optimistic local echo).
Desktop REDUCED: master/detail is two panels + navigate; bulk bar per list (grouped view = 7 bars, hidden behind a View toggle); pages 250 not 500; no hover card; no per-node graph glyph; comment rows plain text.
Proposed split (one Opus 5 medium agent per feature, each across all four clients, as in waves 1-2; then one panels-adoption agent; plus a seam contract test owned by neither):
- vocab-A1 panel chrome: sticky footer/action-bar region, nav-bar search field, nav-bar actions (Open-in-Linear), group header icon.
- vocab-A2 lists: scroll-to-load paging contract + raise `maxListItems` (target 1000 with byte math), horizontal chip strip for segmented, per-panel (not per-list) bulk bar, hover card node (desktop/web).
- vocab-A3 text: markdown images + tables (bounded), raise or stream past the 4000 cap, markdown in list rows (comment rows).
- vocab-A4 tone/icons: red/destructive tone, `brand:*` via plugin-shipped mono SVG (sanitized, size-capped, no scripts), more priority icon tokens, avatar-initials fallback node.
- vocab-A5 state: optimistic local echo for state controls, bound single-select picker node (closes "Link to a lane picks the first lane"), larger model select.
- linear-panels-c: adopt all of the above in ade-linear; delete the "reduced" branches.
- seam test agent: cross-half contract test as before.

### Unit B — every extracted plugin becomes a real `supersedes` plugin
Today's inventory (`plugins/`): ade-linear (real, supersedes, Unit A landed), ade-cursor-cloud (real, supersedes; PX-11 tab badge landed), ade-review (real, supersedes; engine stays in core), ade-history (real, supersedes; git/operation engines stay in core), ade-graph (real, supersedes; React Flow engine stays in core), ade-ios-sim / ade-app-control (real, supersedes; host engines `simulator` / `electron-control` mount the compiled Work panes; simctl/idb and CDP stay in core), ade-log-viewer (489 lines), ade-voice (1.7k lines), themes.
Required end state for each extracted plugin: a real plugin that re-implements the compiled feature on desktop AND mobile (where the compiled feature exists on mobile), flipped to `supersedes` exactly like Linear: compiled stays in the install; plugin install hides every compiled surface and the plugin's version stands in its place; disable brings the compiled version back.
Canvas language: vocabulary `canvas` with host engines `git-dag`, `swimlane`, `graph`, `workspace`, `electron-control`, and `simulator` (data-only; desktop paints, phone/TUI list). History uses `git-dag`. Graph uses `workspace`. Control uses `electron-control`. Simulator uses `simulator`. The Work rail remaps `ios` / `app-control` onto the plugin pane (and back) so the install flip does not dump the user onto Git.
Cursor Cloud remaining gaps after merging origin/main:
- secret reveal
- composer-native launch parity (main deleted `CursorCloudInlineLaunch`; compiled launch is cloud mode + Advanced menu + secrets picker + model eligibility + git remote, not a strip)
- `webhooks.status()` is on the SDK; Linear's settings strip reads the ledger; the Cursor Cloud fleet does not yet
Landed against this list: PX-11 tab badge (`row-badge` on `app`, `viewAction` on the fleet panel); `ade cursor cloud <word>` aliases the plugin's declared CLI words when `ade-cursor-cloud` is installed (disable restores the compiled SDK path; `models` stays compiled because the plugin does not declare it); plugin-owned Cursor Cloud chats stamp `cursorCloudAgentId` so Cursor's rename lock applies on every client; `{openSettings: "agents.provider.cursor"}` opens ADE's Cursor provider page on desktop/web and names it on the phone and TUI; create sends REST `model: { id, params? }` (not a string) and fails closed when the launch form named reasoning or speed the `GET /v1/models` catalog cannot express; a finished run's artifact files are fetched by the host from the signed HTTPS URL and written into the lane cache.
ACP providers (Qwen/Kimi/Grok/Copilot) on main are not plugin-extraction work.
Proposed split: 5 parity-map agents in parallel (read-only, Opus 5 medium) -> coordinator writes one spec per shell -> per-shell build with core/panels split + seam test -> supersedes flip agent per shell (use the Linear flip commit 54df53935 as the template: builtinSurfaces row, manifest presence, gating predicate at every entry point on 4 clients, iOS `awaitDrawsBuiltin`, TUI rows tagged, tests inverted).

### Unit C — the combined acceptance build
One build with ALL plugins installable. Run the install-switch test above for every plugin, desktop + phone. Only when every plugin passes does the branch go to main.

### Wave 5 (after Unit C passes) — delete the compiled code
Linear ~16.5k lines (5.4k renderer + 2.9k iOS + 8.2k main), legacy lane columns, owner rows, PX-14-style migration cards. MUST ride the same commit: rename `skills/ade-linear/SKILL.md` env var `ADE_LINEAR_ISSUE_IDS` -> `ADE_PLUGIN_LINEAR_ISSUE_IDS` (the host env prefix is fixed; a one-commit lag silently loses every agent's issue context). Also: fix core's `updatedFrom` misread (`linearAutomationDispatch.ts:82`) with the trigger remap; the pre-existing dead `linear_dispatcher`/`linear_sync` picker rows in `adeActionSchemas.ts:1436-1468`.

## Remaining Linear core-removal gap list (no blockers)
1. skill env rename (rides the removal commit). 2. `github.listRepoAutolinks` read-back (plugin follow-up). 3. core `updatedFrom` bug. 4. `builtin:linear` scaffolding dies with core. 5. custom-client `admin` scope (product decision above).

Cursor Cloud remaining gaps after merging origin/main: secret reveal, composer-native launch parity (the launch strip is gone on main). PX-11 tab badge, CLI alias, the Cursor rename lock for plugin-owned chats, `{openSettings}` for the Cursor provider page, REST `model: { id, params? }` fail-closed on create, and host-fetched artifact files in the lane cache are landed. `webhooks.status()` is on the SDK.

## Other logged backlog
- Remote-machine Marketplace: when the global project tab points at another machine, the Marketplace must show that machine's marketplace; today it throws.
- Approval card: plugin icon + "View in Marketplace" — BUILT (origin field, real ADE mark); verify on the acceptance build.
- Cursor Cloud: fleet limit error copy; logo too small/boxed.
- Automation DDL into `migrate()`; `manifestCache` null-latch; skill roster discoverability; proof-status process split.
- NUL policy: main owns 4 literal-NUL source files (composerDrafts.ts:29, openCodeAdeInstructions.ts:45, githubRequestAccounting.ts:78, prChecksGraphLayout.ts:313 — the last is escaped on this branch only). One upstream PR to main for all four + a CI NUL scan. Use a python byte scan; shell grep cannot see NUL.
- Sync: never filter a column from an inbound changeset; cr-sqlite deletes are sentinel rows.

## Logging findings from the handoff doc pass (docs/logging.md "Plugins", commit d23d957fc) — not fixed, backlog
- F1 SINK RULE VIOLATED: the plugin host is a machine-scoped singleton (`pluginHostService.ts:3023`) but every plugin line lands in a PROJECT log: `apps/ade-cli/src/bootstrap.ts:1089-1093` says children belong to the machine, then passes the project logger (`:970` = `<project>/.ade/transcripts/logs/ade-cli.jsonl`); the first project to open owns every plugin line machine-wide (`projectScope.ts:174`). No plugin event reaches `desktop-main.jsonl` or `brain.jsonl`. Fix: give the host a machine-scoped `createFileLogger` sink.
- F2 PostHog: no plugin fact reaches analytics (clean).
- F3 full URLs in local log fields: `apps/desktop/src/main/main.ts:914` (`src`), `:987`, `:997` (`url`).
- F4 filesystem paths in fields: `pluginInstallService.ts:532` (`source`), `:482` (`statePath`), `:1043` (`root`).
- F5 plugin-relative request paths: `pluginWebviewProtocol.ts:203/209/222` (`path`).
- F6 `plugin.child_stderr` is truncated (500 chars) but NOT rate-limited (`pluginChildSupervisor.ts:447`, debug level; crash ring bounded at 4000 bytes at `:77`).
- F7 plugin/third-party-authored text in fields: `pluginChildSupervisor.ts:316`, `pluginScheduleService.ts:268`, `pluginInstallService.ts:161` (git stderr 200 chars), `pluginRegistryService.ts:597,601-604` (remote Marketplace index parser messages).
- F8 git identifiers and raw git stderr: `agentChatService.ts:40017-40022` `agent_chat.plugin_branch_fetch_failed` logs branch, remote, unbounded `fetched.stderr`.
- F9 WEBHOOK VERIFICATION FAILS SILENTLY: `pluginWebhookIngressService.ts:435-459` `passesVerification` returns false with no log line in three cases (secret not on this machine :442, header absent :451, HMAC mismatch :454). Only `plugin.webhook_delivery_abandoned` at :467 records anything, with a caller-chosen reason. Add a coarse reason code (never the signature or body).
- F10 renderer plugin failures are bare `console.warn` with no logger: `PluginPanelHost.tsx:580` (malformed prompt dropped), `PluginWebviewHost.tsx:117` (webview load failure, carries Chromium's errorDescription). docs/logging.md:29 forbids bare console for loggable events.
- F11 low: `pluginAuthSessionService.ts:346` logs `paramKeys` from the OAuth provider's redirect (key names only, provider-controlled vocabulary, not enforced).

## Process lessons that cost real time
- Only `xcodebuild` is authoritative for Swift; per-file `swiftc -typecheck` missed two committed defects. Use `-IDEBuildOperationContinueBuildingAfterErrors=YES` on a failing build; `simctl boot` before `xcodebuild`; the 30 GB disk gate in the global CLAUDE.md is real (this session freed disk twice: cursor-sdk worker cache leak, leaked test temp dirs, abandoned `~/.cache/codex-runtimes/codex-runtime-install-*`).
- Never sample a shared test directory while another agent writes to it; the combined `node --test` glob reported phantom failures twice.
- Commit by explicit path per unit; `git add -A` swept another agent's in-flight hunks once.
- Other sessions' release runs switched the working directory to `main` twice; always check `git branch --show-current` before committing.
- Three sessions crashed mid-wave; the resume pattern that worked: back up the diff to a patch, respawn resume agents on the surviving diff.

## Handoff commit
`54df53935` at ticket creation. QUALITY PASS COMPLETE (2026-09-01, commits 54df53935..c47e2779a, all pushed, tree clean). 62 findings (A 32 + B 30): every fixable item is fixed and committed; gated to the owner: OAuth redirect URI 19837 registration on ADE's Linear app; issue state order; custom-client `admin` scope; iOS deep-link wait-for-hello; the loopback "Close the other program" copy on Windows exclusion ranges. Landed commits: docs d23d957fc 3e6e3be99; reports c19610122 ebc117deb 366e6fe9d; fixes e8654e229 b12b591a0 f5b6daacb 0fe27c974 8244ddefc 29fe9aa9a 8ee4464a9 e7b2300c5 47cee6102 24ab8762e 856da8413 0ab6de037 c47e2779a. Final gates: desktop tsc + ade-cli tsc clean; 4,340 desktop vitest; ade-cli sync 703 + tuiClient 1,505; plugin node 495; iOS 202 Plugin* XCTest (real xcodebuild); validate-platform-gates passes; CI runs plugin suites by glob. `/test` was NOT run at the handoff (owner.s call).

## 2026-09-02 fix pass

Four Opus agents reviewed `02090d9e7..61ee82327` and counted 35 review defects
(badges 8, Unit B 11, Unit A 16) plus 4 red gates (desktop typecheck 2 errors,
desktop lint 4 rules-of-hooks errors, 7 CLI tests, 21 desktop tests), 39 items in
total. One badge item — a supersedes plugin could not badge on desktop — did not
reproduce and was hardened only. Everything else is fixed in the tree (90 files).

- Badges: `pluginRailTabSurface` is the one rule for which surface a rail tab,
  its badge address and its default panel mean; the pill clamps to 6 characters;
  a gated plugin badges its compiled tab; Cursor Cloud persists its count.
- Unit B: canvas host engines are owner-only, page like a list, honour `confirm`
  and pause while hidden; markdown images degrade to a link; socket actions show
  `{message}` and refuse an unknown `{openSettings}` id out loud.
- Unit A: `sourceUrl` fetches cap before buffering, re-validate the final hop and
  refuse both HTML and a path Windows cannot hold; iOS honours `ownsSend`,
  `{openSettings}` and `{openUrl}` on the socket path.
- Gates: superseded action domains dispatch with no plugin installed and stop
  being advertised once it is; skills roots carry the `.claude-plugin` marker;
  the Work rail keeps its Control/Simulator slot through an install.

Not verified: iOS. `xcodebuild` is blocked by the 30 GB disk gate. Unit C
acceptance is the next gate.

## 2026-09-03 pivot to the page tier

Owner decision after the Linear acceptance walk on the Alpha build: the JSON
vocabulary cannot reach the quality of the compiled pages, so the WEBVIEW is the
primary plugin page tier on desktop, hosted web and iOS. The vocabulary is
frozen, not deleted; the terminal draws a frozen "terminal profile". Spec:
`docs/reports/plugin-page-tier-spec.md` (`1f72bb4e5`). Ticket ADE-148.

Landed, `1f72bb4e5..e933845c5`:

- `2c5f6b11b` terminal profile frozen to eight nodes; the frozen render arms stay behind `TERMINAL_PROFILE_ONLY` for one later sweep.
- `4df39e06d` bridge v2 — 20 methods, three events, control-flow answers on `invoke`, `ade plugin create --webview`.
- `46bdf4243` desktop placements (popover, settings section, composer picker), destroy-when-hidden, the renderer relay, `webviewSurfaceId`, `openWebview.placement`, `popover: {width, height}`.
- `1bb47b982` + `e933845c5` `packages/ui` as `@ade-dev/ui`, five entry points; the desktop app consumes it through `file:../../packages/ui`.
- `86edbdd35` cold-launch manifest retry, top-bar cluster no-drag and shell chrome, brand glyphs in every socket, first refresh on a seeded panel, desktop back stack.
- `0054ff0de` iOS page host — WKWebView, `ade-plugin://` scheme handler, content-addressed cache, bundled pre-seeded pages, the sync asset channel.
- `047cba2c3` `6f67682c9` `1cf5c0eea` `d5563289f` hosted web page host — sandboxed same-origin iframe, service worker, cached assets, lazy load.
- `fbb227210` `00c8dff4c` `plugins.putCollection/getConfig/setConfig`.

In flight: the `ade-linear` port to the page tier. `plugins/ade-linear/page/`
and `plugins/ade-linear/dist/` exist in the working tree and are NOT committed.

Outstanding verification: iOS is UNVERIFIED on this Mac — `xcodebuild` is
blocked by the 30 GB disk gate, and the MacBook build is pending. No official
plugin ships a page yet, so the page-tier acceptance walk has not run.

## 2026-09-03 handoff to the next coordinator (usage cliff)

Read in this order: this section, `docs/reports/plugin-page-tier-spec.md`,
`docs/reports/plugin-page-tier-wave2-spec.md`, then every
`plugins/<id>/page/PARITY.md`. Ticket ADE-148 has the day-by-day comments.

### What happened, in order
1. Took over at `61ee82327`. Four Opus review agents over `02090d9e7..61ee82327`
   found 35 defects + 4 red gates; five fix batches closed all; iOS verified
   244/0 on a real `xcodebuild` (5546a1623).
2. The owner deleted the lane by accident; the branch was recovered from
   dangling commits. Edit only under `.ade/worktrees/plugin-platform-c7103e2e`.
3. Alpha acceptance walk on the owner's MacBook Pro. The install flip worked.
   The JSON vocabulary panels looked like a form generator; sign-in never opened
   a browser on desktop (renderer discarded the authSession URL); the
   credential handoff never worked. Owner verdict: a regression.
4. PIVOT (owner): the webview is the primary page tier on desktop, hosted web
   and iOS (WKWebView); the JSON vocabulary is frozen and will be deleted except
   the terminal profile. Built: bridge v2 (relay, control-flow answers), desktop
   placements (popover, settings section, composer picker, destroy-when-hidden),
   web iframe host (sandbox header + service worker), iOS WKWebView host +
   asset channel + bundled pages, `@ade-dev/ui` kit (8 subpaths, desktop
   consumes it as a COPIED `file:` dep), Linear 2.0.0 ported one-to-one to a page
   with 15 parity gaps closed, remote plugin config/collection writes, docs.
   Gates green at `d575a53d2`; iOS 333/0 at `f8f4d1381`.
5. Second walk: the owner found the header quick view broken, the launch
   kickoff never sent, settings bloated, generic automations tile, extra
   buttons. Three plan rounds locked WAVE 2 (`plugin-page-tier-wave2-spec.md`).
6. Merged `origin/main` (10 commits, 9 conflicts) → `29c540311`, green.
7. Six wave-2 builders ran in parallel and were STOPPED mid-flight at the
   owner's usage limit. Their tree is committed as WIP `14a483582` on branch
   `plugin-platform-wave2-wip` (= `plugin-platform` + one commit). NOT green.

### Where each batch stopped (all uncommitted work is in the WIP commit)
- w2p-a (sockets `composer-menu-item`, `chat-menu-item`, `machine-entry`,
  `automation-trigger-tile`, `automation-template`; host pickers renderer side;
  chat chrome; header system; page error card): partially built; check
  `apps/desktop/src/shared/plugins/sockets.ts`, `renderer/components/plugins/sockets/**`,
  `renderer/components/app/TopBar.tsx`, `renderer/components/automations/**`.
- w2p-b (bridge verbs `ui.pick*`, `ui.openPathInEditor`, `sockets.list/invoke`,
  `chat.setHeader`, `attachBranch.prUrl`, `host.subscribe` kinds
  operation/conflict/review, `runtimeRef.capabilities`, per-runtime rename lock,
  `page.error`, `hostEngine.place/release`; iOS mirrors + pull to refresh;
  doctor page checks): partially built; iOS side reported picker shapes in
  `apps/ios/ADE/Models/PluginPageWave2.swift`; nothing built on this Mac
  (disk gate) — all Swift UNVERIFIED until a MacBook build.
- w2-linear (kickoff fix, remove quick view/chat-header/bar button, composer
  menu item, issue-context menu item, slim settings, templates, trigger tile,
  webhook auto-register, host pickers in the launch form): partially built.
- w2-cursor-cloud (entire feature as a plugin): page dir created; partial.
- w2-graph-history: Graph page in progress (`plugins/ade-graph/page`,
  `pageActions.js`); History not started or early.
- w2-review-control-sim: ade-review is 2.0.0 (page tier, green on its own);
  index row `marketplaceLocalIndex.ts` / `registry/seed-entries.json` NOT yet
  re-synced (pilotPackages red on ade-review 1.1.0 vs 2.0.0); Electron Control /
  iOS Sim Control pages and the rename list not started or early.

### Resume protocol
1. `cd .ade/worktrees/plugin-platform-c7103e2e && git branch --show-current`
   must be `plugin-platform-wave2-wip`. Node 22 via `brew --prefix node@22`;
   desktop typecheck needs `NODE_OPTIONS=--max-old-space-size=12288`; deps are
   installed in-tree (never `npm --prefix … install`; kit reinstall is
   `cd apps/desktop && npm install ../../packages/ui --install-links`).
2. Run both typechecks and the plugin suites; list what is red per area.
3. Finish each batch per the wave-2 spec with Opus 5 subagents (owner rule:
   Fable/coordinator writes specs and judges; never spawns Fable subagents;
   medium effort for routine, high for hard; agents never commit; commit by
   explicit path per batch; never `git add -A`).
4. Then: delete the desktop/web/iOS vocabulary renderers (keep the terminal
   profile), docs, full gates, fast-forward `plugin-platform`, MacBook builds,
   ONE owner test round (desktop one-to-one Linear, Cursor Cloud, Graph,
   History, Review, Electron Control, iOS Sim Control; phone Linear + Cursor
   Cloud; header system).

### The owner's MacBook Pro (acceptance builds run THERE, never on the main Mac)
- Tailscale `100.117.237.95` (`macbook-pro-97`), SSH `arul@100.117.237.95`
  with this Mac's key already authorized (BatchMode works). Connectivity flaps;
  wrap commands in retries. Keep it awake with `setsid nohup caffeinate -dims &`.
- Worktree there: `/Users/arul/ADE/.ade/worktrees/alpha-build-1b4714f3`
  (branch plugin-platform; `git fetch && git merge --ff-only`). Node 22.13.1 at
  `/Users/arul/.asdf/installs/nodejs/22.13.1/bin`. Logs and scripts in
  `~/alpha-build-logs/`: `round3.sh` (deps + kit + page sync + iOS build +
  11 Plugin XCTest classes + Alpha package + install + relaunch), `ios-only.sh`,
  `alpha-adhoc.sh`, `adea` (the Alpha-home CLI wrapper), `sim-udid`
  (iPhone 17 Pro, iOS 26.2). Xcode 26.6.
- Alpha: `npm run package:alpha -- --skip-install` builds ad-hoc; install by
  `ditto` into `/Applications/ADE Alpha.app` and `open -a`. Ad-hoc = two
  keychain password prompts per relaunch. SIGNED builds only work from the
  owner's own Terminal (`--sign 30DBB64B65F04B3619DF489A1FF8B74D4DC0BC23`);
  over SSH codesign fails with errSecInternalComponent. Never `--sign-auto`
  there (a foreign Developer ID cert is in that keychain).
- Alpha home `~/.ade-alpha`; `~/.ade-alpha/bin/ade` is a stale binary — use
  `~/alpha-build-logs/adea` (runs the worktree cli.cjs with ADE_HOME set).
  Plugin installs need `--role cto`.
- The bundled iOS pages come from `node scripts/sync-bundled-plugin-pages.mjs`;
  run it after any plugin page rebuild.

### Owner rules that stand
Gating shells are not acceptable. Compiled owners stay in the binary until the
acceptance walk passes. One-to-one with the compiled UI is the bar. Hit every
surface (desktop, web, iOS, TUI, CLI). Windows is part of done. Do not invent
platform semantics. Plugins are plain files; pages ship source + committed
`dist/`. Never edit the project-root checkout. Never push a red tree to
`plugin-platform`.

## 2026-09-04 round 3 (the third walk ledger) — fixed, pushed, built

Tip `0566b88c8` on `plugin-platform` (plus the headless-CLI fix that follows
it). Gates on that tip: desktop and CLI typecheck clean, lint 0 errors, 8
desktop shards (3300 tests), webclient entry graph 415 KB, 8 plugin node
suites, 7 page suites, 7 page builds with no dist drift, 335 iOS plugin tests.
MacBook: ad-hoc Alpha installed and running at that tip; the iOS Debug app is
built and tested on the simulator.

What changed, by area:
- Host: tab re-entry crash (detached `executeJavaScript`) fixed; Report issue
  goes to the ADE report flow everywhere; `chat.capabilities()` answers
  `defaultModel`; the picker host keeps the provider; webview surfaces may
  declare `mobile: true` (bridge v3, `context` event, `railTab: false`
  opt-out); a tab page hands the guest the selected lane; the relay honours
  `{openWebview}` from a page invoke; Work-rail panes with an entry page mount
  the page; the two host engines paint only the picture.
- Linear 2.1.2: chrome-less picker and popover, Attach from the popover opens
  the picker in place, chips always open a picker and seed from the host
  default model, filters emit keys, `lane.created` fires, merge template on
  `lane.merged`, Open in Linear resolves through the automation resolver.
- Cursor Cloud 2.0.3: three sockets only (machine-entry, row-badge,
  automation-trigger-tile), three-state fast tier, durable follow-up keys,
  model titles, archived rows behind a reveal, pages on the phone.
- Graph 2.0.2 (edges, drag guard, four view modes restored), History 2.0.2,
  Review 2.0.2 (no Work-rail pane; fast mode, models, busy, PR scope, toasts),
  Electron Control and iOS Sim Control 2.0.1 (pages mount).
- Themes: 114-token packs, twelve official themes. Grove and Sakura are
  deleted; Ocean, Ember, Iris and Synthwave are replaced by Frost, Kiln, Mocha
  and Spectre under NEW ids. An installed old id stays installed with no
  registry row (the owner's Alpha has `ade-theme-sakura` 1.0.0 installed).
- Marketplace: Plugins and Themes views, kind-derived filters, sort.

Open items found while verifying on the Alpha:
1. The webhook relay worker in production is the `main` build. The
   `/plugin/:id/register` route and the `plugin_webhook_secrets` D1 migration
   exist only on this branch, so the Linear one-click webhook answers HTTP 404
   and Cursor Cloud never registers. Deploying is
   `cd apps/webhook-relay && npm run deploy` (runs the remote D1 migration then
   `wrangler deploy`). Owner decision: deploy from this branch before the
   webhook part of the walk.
2. `ade plugin doctor <id>` from a directory that is not a project fell into
   headless mode, booted an embedded runtime, and crashed on the Cursor Cloud
   relay poller after the database closed, printing nothing. Fixed after
   `0566b88c8` (see the commit that follows). From inside a project it reports
   correctly.
3. The Alpha still has the OLD plugin versions installed (linear 2.1.0, the
   others 2.0.0). That is the owner's Marketplace update path; nothing was
   pre-updated.
4. Linear Disconnect does not confirm (`ui.confirm` is not called). Product
   call, unchanged.
5. The walk itself: no GUI walk was possible from the main Mac (the MacBook
   has no screen-recording grant for SSH, and Chrome automation is not
   connected). CLI-level checks passed: doctor for linear, graph and cursor
   cloud from a project root; all pages resolve and their bundles measure.

Rule learned this round: never message the old `w2-*` agents; a stray message
revives them and they overwrite current files (it happened twice with
`w2-cursor-cloud`).
