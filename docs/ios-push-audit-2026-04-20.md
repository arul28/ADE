# iOS Push / Live Activities / Widgets / Notifications Center — Audit Report

Date: 2026-04-20
Scope: WS1–WS9 of the iOS push feature (plan: `/Users/arul/.claude/plans/i-want-to-add-goofy-cake.md`)

## Summary
- **Gaps vs Apple docs:** 4 found / 4 fixed
- **Bugs:** 7 found / 7 fixed (5 by auditor, 2 by coordinator)
- **UX / a11y:** 1 verified OK, 1 deferred (provider brand prefix — requires provider slug threaded through chat envelope; shippable without it)

## Final verification
| Check | Result |
|---|---|
| `xcodebuild ... -scheme ADE build` | **BUILD SUCCEEDED** |
| `xcodebuild ... -scheme ADEWidgets build` | **BUILD SUCCEEDED** |
| `xcodebuild ... -scheme ADENotificationService build` | **BUILD SUCCEEDED** |
| `npx tsc --noEmit` (apps/desktop) | clean |
| `npx vitest run` (targeted notification + sync suites) | 173 passed / 0 failed |

## Gaps vs Apple docs (all FIXED)

**G1. `requestAuthorization` missing `.timeSensitive`.** Entitlement was present but the runtime auth request didn't include `.timeSensitive`, so iOS would silently downgrade awaiting-input pushes to `.active` and kill Focus break-through. Fixed in `AppDelegate.swift` (iOS 15+ gated). [Apple docs: UNAuthorizationOptions.timeSensitive]

**G2. APNs `category` at payload top level instead of inside `aps`.** Apple's payload key reference requires `category` under `aps`; with it at top level iOS never matches the registered `UNNotificationCategory` — so Approve/Deny/Reply/OpenPr/RetryChecks action buttons never render on any push. Fixed in `notificationMapper.ts`. [Apple docs: PayloadKeyReference — category]

**G3. `mutable-content` missing — NotificationService extension never runs.** Without `aps.mutable-content: 1`, iOS skips the service extension; the brand-prefix + threadIdentifier + interruptionLevel work in `ADENotificationService/NotificationService.swift` was inert. Fixed in `notificationMapper.ts`. [Apple docs: UNNotificationServiceExtension]

**G4. `LiveActivityCoordinator` reaped orphans pre-hydration.** Coordinator init ran before `SyncService.refreshActiveSessionsAndSnapshot()`, so `host.activeSessions == []` and every legitimate pre-existing `Activity<ADESessionAttributes>` was immediately ended as "orphan" on app launch. Removed the init-time call; `reconcile(with:)` step 1 already handles orphan eviction correctly post-hydration.

## Bugs (all FIXED)

**B1. `chat.approve` requires `itemId` and a valid decision.** Desktop validator required `itemId` and `decision ∈ {accept, accept_for_session, decline, cancel}`. iOS sent neither `itemId` nor a valid decision value — it was sending `"approve"`/`"deny"`. Two independent fixes: auditor added itemId through the mapper + AppDelegate; coordinator separately corrected the decision string to `"accept"`/`"decline"`. Together these make the Approve/Deny banner actions actually succeed.

**B2. `chat.respondToInput` (Reply action) missing `itemId`.** Same root cause, Reply path. Coordinator added itemId extraction in `SyncService.replyToSession`.

**B3. `prs.rerunChecks` requires `prId`, not just `prNumber`.** Mapper PR metadata now carries `prId`; AppDelegate + SyncService forward it.

**B4. Widgets force-unwrapped `URL(string:)`.** `ADEWorkspaceWidgetViews.swift` `Link(destination: URL(string: ...)!)` would crash on malformed sessionId/prNumber. Replaced with `if let url = URL(...)` and graceful fallback row.

**B5. No `apns-expiration` on any envelope.** Priority 10 → 1 h; priority 5 → 10 min. Set in `notificationEventBus.ts`.

**B6. Lock-screen accessory widgets had no tap destination.** Accessory families don't support `Link`; tap lands on container `widgetURL`. Added `.widgetURL(...)` routing to first awaiting-input session or `ade://workspace`.

**B7.** *(Coordinator-found, not in auditor report)* iOS→desktop decision-string mismatch (tracked under B1).

## UX / a11y

**U1. Provider brand prefix never applied.** `NotificationService.swift` reads `userInfo["providerSlug"]`, but `AgentChatEventEnvelope` doesn't carry provider slug. Threading one through requires either a resolver injected into the mapper or a new field on the chat envelope. Both are beyond polish scope. Extension no-ops cleanly without the field. **DEFERRED — shippable without.**

**U2. Widget Dynamic Type clipping.** All widget labels already scope `.dynamicTypeSize(.small ... .large)`. **VERIFIED OK.**

## Adversarial trace (all OK)

1. APNs 410 Unregistered → `tokenInvalidated` event → `invalidateApnsTokensForDevice`
2. Force-quit with active Live Activity → first `reconcile` step 1 reaps orphans (post-G4)
3. Clock skew → ActivityKit uses device clock only
4. 5+ sessions → `enforceConcurrencyCap` keeps top-5 by relevance
5. Auth revoked → APNs 410 path purges tokens
6. `.p8` missing → `apnsService.configure` never called; bus falls through via `isConfigured()`
7. Pref toggle mid-flight → `getPrefsForDevice` called inside `deliver()`, not cached
8. Vibrant StandBy → `widgetRenderingMode == .accented` branches exist
9. Reduce Motion → all `symbolEffect` gated on `!reduceMotion`
10. AX3 Dynamic Type → clamped per-label

## Manual-verification checklist for a real iPhone 14 Pro+

1. **Time-sensitive break-through.** Send a real awaiting-input push while the device is in Focus / DND — confirm it breaks through with the yellow "Time Sensitive" banner. (Validates G1; simulator doesn't honour Focus.)
2. **Banner actions actually succeed.** Tap Approve / Deny / Reply from the banner with the app backgrounded; watch desktop logs. Confirm `chat.approve` request arrives with both `sessionId` and `itemId` populated, `decision` = `"accept"`/`"decline"`, and the session actually advances. (Best single smoke test — validates B1/B7/G2/G3 together.)
3. **Dynamic Island relevance + lock-screen deep link.** Observe the Dynamic Island as an awaiting-input arrives, then a second session transitions to `running`. Verify the Island flips to the awaiting-input session (higher relevance) and the compact trailing shows the correct "approve" label. Lock the phone and tap the lock-screen accessory rectangular widget. Confirm it deep-links into the awaiting session. (Validates relevance ordering + B6 widgetURL routing.)

## Files changed by audit + coordinator fixes
- `apps/ios/ADE/App/AppDelegate.swift`
- `apps/ios/ADE/Services/LiveActivityCoordinator.swift`
- `apps/ios/ADE/Services/SyncService.swift`
- `apps/ios/ADEWidgets/ADELockScreenWidget.swift`
- `apps/ios/ADEWidgets/ADEWorkspaceWidgetViews.swift`
- `apps/desktop/src/main/services/notifications/notificationMapper.ts`
- `apps/desktop/src/main/services/notifications/notificationEventBus.ts`
