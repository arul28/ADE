Linear ticket: ADE-148 (https://linear.app/ade-linear/issue/ADE-148). Keep this file and the ticket in sync.

## Why this ticket exists

The `plugin-platform` branch is a three-week program. The coordinating Claude session lost access on 2026-09-01. This ticket is the full handoff. Read it top to bottom before you touch the branch.

Branch: `plugin-platform` (origin). Last commit: `54df53935`. Tree is clean at that commit. Base: `main` (last merged through #1192).

## Read these first, in this order

1. `docs/features/plugins/README.md` — the platform contract. Updated at the handoff commit to cover every seam listed below (auth sessions, credential handoff, official client broker, issue links, session env, URL matchers, graph-node socket, vocabulary growth, the two polarities, program status).
2. `docs/logging.md` — section "Plugins" (new at the handoff commit): every `plugin.*` structured event, its sink, and what may reach PostHog.
3. `docs/reports/linear-plugin-parity-map.md` — the 113-row audit of the compiled Linear integration vs the plugin. The 7 C items and 5 B items in it are all built.
4. `docs/reports/cursor-cloud-plugin-extraction-spec.md` — Cursor Cloud extraction spec (wave 1 shipped; 7 gaps open, listed below).
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

## Open product decision (owner's call)
Self-registered Linear OAuth clients request `read,write`, so their webhooks never fire (faithful port of `linearOAuthService.ts:260`). Two lines widen custom clients to `admin`, but that changes what an existing custom-client user consents to on next sign-in. The plugin says so on three surfaces (settings, `ade linear status`, ingress strip).

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
Today's inventory (`plugins/`): ade-linear (real, supersedes), ade-cursor-cloud (real, supersedes, 3.4k lines, 7 gaps), ade-graph / ade-review / ade-history / ade-ios-sim / ade-app-control (`enables` gating shells with 0 lines of code — they only unlock compiled surfaces), ade-log-viewer (489 lines), ade-voice (1.7k lines), themes.
Required end state for each of graph, review, history, ios-sim, app-control (and cursor-cloud's 7 gaps): a real plugin that re-implements the compiled feature on desktop AND mobile (where the compiled feature exists on mobile), flipped to `supersedes` exactly like Linear: compiled stays in the install; plugin install hides every compiled surface and the plugin's version stands in its place; disable brings the compiled version back.
First step per shell: a parity map like `docs/reports/linear-plugin-parity-map.md` (what the compiled surface does on each client; which seams the plugin needs; which vocabulary nodes are missing). Expect new platform work: graph needs a canvas (Tier 2 webview on desktop; decide mobile), ios-sim and app-control drive local processes (simctl, computer-use) and stream screens — the plugin child needs a process/stream seam, or these need a declared capability the host brokers. "Expand language or logic as needed" is the owner's explicit permission to grow the platform.
Cursor Cloud's 7 open gaps: `webhooks.status()` ledger read (shared with Linear gap), secret reveal, navigate-to-settings, PX-11 tab badge, artifact download, launch strip, CLI alias.
Proposed split: 5 parity-map agents in parallel (read-only, Opus 5 medium) -> coordinator writes one spec per shell -> per-shell build with core/panels split + seam test -> supersedes flip agent per shell (use the Linear flip commit 54df53935 as the template: builtinSurfaces row, manifest presence, gating predicate at every entry point on 4 clients, iOS `awaitDrawsBuiltin`, TUI rows tagged, tests inverted).

### Unit C — the combined acceptance build
One build with ALL plugins installable. Run the install-switch test above for every plugin, desktop + phone. Only when every plugin passes does the branch go to main.

### Wave 5 (after Unit C passes) — delete the compiled code
Linear ~16.5k lines (5.4k renderer + 2.9k iOS + 8.2k main), legacy lane columns, owner rows, PX-14-style migration cards. MUST ride the same commit: rename `skills/ade-linear/SKILL.md` env var `ADE_LINEAR_ISSUE_IDS` -> `ADE_PLUGIN_LINEAR_ISSUE_IDS` (the host env prefix is fixed; a one-commit lag silently loses every agent's issue context). Also: fix core's `updatedFrom` misread (`linearAutomationDispatch.ts:82`) with the trigger remap; the pre-existing dead `linear_dispatcher`/`linear_sync` picker rows in `adeActionSchemas.ts:1436-1468`.

## Remaining Linear core-removal gap list (no blockers)
1. skill env rename (rides the removal commit). 2. `webhooks.status()` SDK read. 3. 250 vs 500 list (Unit A). 4. comment rows plain text (Unit A). 5. no picker node (Unit A). 6. `github.listRepoAutolinks` read-back (plugin follow-up). 7. core `updatedFrom` bug. 8. `builtin:linear` scaffolding dies with core. 9. custom-client `admin` scope (product decision above).

## Other logged backlog
- Remote-machine Marketplace: when the global project tab points at another machine, the Marketplace must show that machine's marketplace; today it throws.
- Approval card: plugin icon + "View in Marketplace" — BUILT (origin field, real ADE mark); verify on the acceptance build.
- Cursor Cloud: fleet limit error copy; logo too small/boxed.
- Automation DDL into `migrate()`; `manifestCache` null-latch; skill roster discoverability; proof-status process split.
- NUL policy: main owns 4 literal-NUL source files (composerDrafts.ts:29, openCodeAdeInstructions.ts:45, githubRequestAccounting.ts:78, prChecksGraphLayout.ts:313 — the last is escaped on this branch only). One upstream PR to main for all four + a CI NUL scan. Use a python byte scan; shell grep cannot see NUL.
- Sync: never filter a column from an inbound changeset; cr-sqlite deletes are sentinel rows.

## Process lessons that cost real time
- Only `xcodebuild` is authoritative for Swift; per-file `swiftc -typecheck` missed two committed defects. Use `-IDEBuildOperationContinueBuildingAfterErrors=YES` on a failing build; `simctl boot` before `xcodebuild`; the 30 GB disk gate in the global CLAUDE.md is real (this session freed disk twice: cursor-sdk worker cache leak, leaked test temp dirs, abandoned `~/.cache/codex-runtimes/codex-runtime-install-*`).
- Never sample a shared test directory while another agent writes to it; the combined `node --test` glob reported phantom failures twice.
- Commit by explicit path per unit; `git add -A` swept another agent's in-flight hunks once.
- Other sessions' release runs switched the working directory to `main` twice; always check `git branch --show-current` before committing.
- Three sessions crashed mid-wave; the resume pattern that worked: back up the diff to a patch, respawn resume agents on the surviving diff.

## Handoff commit
`54df53935` at ticket creation. IN FLIGHT at creation: the two doc updates (plugins README, logging.md Plugins section) and a scoped `/quality` pass over `c35bc0b88^..HEAD`. If they landed, later commits on the branch and a comment on this ticket say so. If no later commit exists, the docs are NOT updated and quality did NOT run — do them first. `/test` was NOT run at the handoff (owner.s call).
