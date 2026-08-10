import BackgroundTasks
import UIKit
import UserNotifications
import WidgetKit

/// Minimal `UIApplicationDelegate` bridged into the SwiftUI lifecycle via
/// `@UIApplicationDelegateAdaptor`. It exists only to receive the APNs token
/// callbacks and route incoming notifications — all policy lives in
/// `PushNotificationService` and `DeepLinkRouter`.
final class ADEAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        ProductAnalytics.shared.configure()
        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
        registerBackgroundRefreshTask()
        // A push-to-start notification wakes the process before SwiftUI scene
        // tasks are guaranteed to run. Install ActivityKit observers at launch
        // so the newly-created activity and its update token cannot be missed.
        MainActor.assumeIsolated {
            LiveActivityService.shared.start()
        }
        return true
    }

    /// Transcript render caches (parsed Markdown blocks, inline attributed
    /// strings, syntax highlighting) are all derived state — a long chat can
    /// hold megabytes of it, and every entry can be rebuilt on demand. When the
    /// system says it wants memory back, give it these first.
    func applicationDidReceiveMemoryWarning(_ application: UIApplication) {
        workPurgeMarkdownRenderCaches()
        ADECodeRenderingCache.shared.purgeOnMemoryWarning()
        MainActor.assumeIsolated {
            WorkPendingUploadPreviewStore.shared.purge()
        }
    }

    /// Register the approval-alert category so approval pushes carry inline
    /// Approve / Deny actions on the lock screen and in Notification Center. The
    /// brain stamps `aps.category = "ADE_APPROVAL"` on those alerts; the action
    /// identifiers are matched in `didReceive response`.
    private func registerNotificationCategories() {
        let approve = UNNotificationAction(
            identifier: ADEAppDelegate.approveActionIdentifier,
            title: "Approve",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: ADEAppDelegate.denyActionIdentifier,
            title: "Deny",
            options: [.authenticationRequired, .destructive]
        )
        let category = UNNotificationCategory(
            identifier: ADEAppDelegate.approvalCategoryIdentifier,
            actions: [approve, deny],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    // Identifiers shared with the brain's APNs payload contract.
    static let approvalCategoryIdentifier = "ADE_APPROVAL"
    static let approveActionIdentifier = "ADE_APPROVE"
    static let denyActionIdentifier = "ADE_DENY"

    // MARK: - Background refresh

    /// Must match `BGTaskSchedulerPermittedIdentifiers` in `ADE/Info.plist`.
    static let activityRefreshTaskIdentifier = "com.ade.ios.activity.refresh"

    /// The widget renders a cached App-Group snapshot, and that cache was only
    /// ever written while the app was in the foreground — so a backgrounded or
    /// killed app left the widget re-rendering hours-old numbers no matter how
    /// often its timeline fired. Pushes now refresh the snapshot before the
    /// reload (`didReceiveRemoteNotification` below), and this is the path for
    /// the quiet stretches where no push arrives at all.
    ///
    /// The system decides if and when this runs. It is a way for the widget to
    /// *age gracefully*, not a guarantee of freshness — which is exactly why
    /// the widget also renders the snapshot's age rather than trusting it.
    private func registerBackgroundRefreshTask() {
        // Returns false when the identifier is missing from
        // `BGTaskSchedulerPermittedIdentifiers`. Nothing to recover from at
        // runtime — the widget falls back to reporting its own staleness — but
        // the result must not be silently dropped, because a typo in either
        // half of the pair disables background refresh with no other symptom.
        let registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.activityRefreshTaskIdentifier,
            using: nil
        ) { task in
            // `using: nil` runs this on a system-chosen *background* queue, so
            // hop to the main actor before touching `BGTask` or any service —
            // and keep every touch of the task on that one actor.
            Task { @MainActor in
                await ADEAppDelegate.runActivityRefresh(task: task)
            }
        }
        assert(registered, "BGTaskSchedulerPermittedIdentifiers is missing \(Self.activityRefreshTaskIdentifier)")
    }

    @MainActor
    private static func runActivityRefresh(task: BGTask) async {
        // Re-arm first: a handler that returns without scheduling the next one
        // silently ends background refresh for the life of the install.
        scheduleActivityRefresh()

        let work = Task { @MainActor in
            // A background launch has no active scene, so the root view's
            // bootstrap task is not guaranteed to have run — and an
            // unbootstrapped `AccountService` has no session, so the refresh
            // would return without fetching anything. `bootstrap()` guards on
            // its own `didConfigure` flag, so this is a no-op in the warm case.
            await AccountService.shared.bootstrap()
            await AccountService.shared.refreshAttentionSnapshot()
        }
        task.expirationHandler = { work.cancel() }
        await work.value
        // `refreshAttentionSnapshot` reloads timelines itself on a successful
        // write. Reload again regardless so a *failed* refresh still re-renders
        // the widget, which is how the staleness copy appears without waiting
        // for a timeline entry the system may never grant.
        WidgetCenter.shared.reloadAllTimelines()
        task.setTaskCompleted(success: !work.isCancelled)
    }

    /// Ask for a wake in roughly fifteen minutes. iOS treats this as a floor
    /// and a hint, never a promise.
    @MainActor
    static func scheduleActivityRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: activityRefreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        // Throws when the identifier is not permitted (missing Info.plist
        // entry) or the app is over its pending-request budget. Neither is
        // worth failing a launch over — the widget degrades to saying it is
        // stale, which is the honest outcome anyway.
        try? BGTaskScheduler.shared.submit(request)
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        MainActor.assumeIsolated {
            ADEAppDelegate.scheduleActivityRefresh()
        }
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        // Delegate callbacks arrive on the main thread; hop into the main actor
        // without a hop-and-await so the token is handed off synchronously.
        MainActor.assumeIsolated {
            PushNotificationService.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        MainActor.assumeIsolated {
            ProductAnalytics.shared.captureError(.pushRegistration)
            PushNotificationService.shared.didFailToRegisterForRemoteNotifications(error: error)
        }
    }

    /// Silent-push wake. The snapshot is refreshed *before* anything reloads:
    /// a `reloadAllTimelines` on its own only re-reads the same cached
    /// App-Group snapshot, which is why a push used to leave the widget exactly
    /// as wrong as it was.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
        await MainActor.run { PushNotificationService.shared.notePushReceived() }
        let previousRevision = await MainActor.run {
            AccountService.shared.attentionSnapshotRevision
        }
        await AccountService.shared.refreshAttentionSnapshot()
        let refreshedRevision = await MainActor.run {
            AccountService.shared.attentionSnapshotRevision
        }
        // A successful refresh already reloaded. Reload on the failure path too
        // so the widget re-renders and can say how far behind it now is.
        if refreshedRevision == previousRevision {
            WidgetCenter.shared.reloadAllTimelines()
        }
        return refreshedRevision != previousRevision ? .newData : .noData
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension ADEAppDelegate: UNUserNotificationCenterDelegate {
    /// Foreground presentation. We still show a banner + sound when the app is
    /// active, EXCEPT for the chat the user is currently reading — surfacing a
    /// banner for the session already on screen is just noise.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let userInfo = notification.request.content.userInfo
        Task { @MainActor in
            await AccountService.shared.refreshAttentionSnapshot()
        }
        return await MainActor.run {
            PushNotificationService.shared.notePushReceived()
            if let sessionId = ADEAppDelegate.sessionId(from: userInfo),
               SyncService.shared?.subscribedChatSessionIds.contains(sessionId) == true {
                return []
            }
            return [.banner, .list, .sound]
        }
    }

    /// Notification tap → route through the existing deep-link router, which
    /// already knows how to read the payload's `deepLink` / `sessionId` / `prId`
    /// keys and flip navigation (or pop a "send to Mac" card).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let sessionId = (userInfo["sessionId"] as? String) ?? ""
        let itemId = (userInfo["itemId"] as? String) ?? ""
        Task { @MainActor in
            await AccountService.shared.refreshAttentionSnapshot()
        }

        // Both ids are required to target the pending approval — a payload
        // missing either (older host, malformed push) falls through to the
        // deep-link path so the user lands in the app instead of a command
        // that cannot resolve.
        switch response.actionIdentifier {
        case ADEAppDelegate.approveActionIdentifier where !sessionId.isEmpty && !itemId.isEmpty:
            await MainActor.run {
                PushNotificationService.shared.notePushReceived()
                ProductAnalytics.shared.captureFeature(
                    .pushAction,
                    outcome: .approved,
                    source: .notificationApprove
                )
            }
            await ADEIntentCommandRegistry.dispatch(
                .approveSession,
                payload: ["sessionId": sessionId, "itemId": itemId]
            )
        case ADEAppDelegate.denyActionIdentifier where !sessionId.isEmpty && !itemId.isEmpty:
            await MainActor.run {
                PushNotificationService.shared.notePushReceived()
                ProductAnalytics.shared.captureFeature(
                    .pushAction,
                    outcome: .denied,
                    source: .notificationDeny
                )
            }
            await ADEIntentCommandRegistry.dispatch(
                .denySession,
                payload: ["sessionId": sessionId, "itemId": itemId]
            )
        default:
            // Default tap (and any action we don't handle) routes through the
            // existing deep-link navigation, which knows the payload keys.
            await MainActor.run {
                PushNotificationService.shared.notePushReceived()
                ProductAnalytics.shared.captureFeature(
                    .pushNotification,
                    outcome: .opened,
                    source: .notification
                )
                DeepLinkRouter.shared.handleNotificationUserInfo(userInfo)
            }
        }
    }

    /// Extract a session id from the APNs payload — either the explicit
    /// `sessionId` key or the `deepLink` `ade://session/<id>` URL.
    static func sessionId(from userInfo: [AnyHashable: Any]) -> String? {
        if let direct = userInfo["sessionId"] as? String, !direct.isEmpty {
            return direct
        }
        if let deepLink = userInfo["deepLink"] as? String,
           let url = URL(string: deepLink),
           url.scheme?.lowercased() == "ade",
           url.host?.lowercased() == "session" {
            let components = url.pathComponents.filter { $0 != "/" }
            return components.first.flatMap { $0.removingPercentEncoding ?? $0 }
        }
        return nil
    }
}
