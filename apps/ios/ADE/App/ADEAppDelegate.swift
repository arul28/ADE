import UIKit
import UserNotifications

/// Minimal `UIApplicationDelegate` bridged into the SwiftUI lifecycle via
/// `@UIApplicationDelegateAdaptor`. It exists only to receive the APNs token
/// callbacks and route incoming notifications — all policy lives in
/// `PushNotificationService` and `DeepLinkRouter`.
final class ADEAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
        return true
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
            PushNotificationService.shared.didFailToRegisterForRemoteNotifications(error: error)
        }
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
        await MainActor.run { PushNotificationService.shared.notePushReceived() }
        // This callback only records push diagnostics; it fetches/syncs nothing,
        // so claiming `.newData` would skew iOS's background-fetch budget.
        return .noData
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

        // Both ids are required to target the pending approval — a payload
        // missing either (older host, malformed push) falls through to the
        // deep-link path so the user lands in the app instead of a command
        // that cannot resolve.
        switch response.actionIdentifier {
        case ADEAppDelegate.approveActionIdentifier where !sessionId.isEmpty && !itemId.isEmpty:
            await MainActor.run { PushNotificationService.shared.notePushReceived() }
            await ADEIntentCommandRegistry.dispatch(
                .approveSession,
                payload: ["sessionId": sessionId, "itemId": itemId]
            )
        case ADEAppDelegate.denyActionIdentifier where !sessionId.isEmpty && !itemId.isEmpty:
            await MainActor.run { PushNotificationService.shared.notePushReceived() }
            await ADEIntentCommandRegistry.dispatch(
                .denySession,
                payload: ["sessionId": sessionId, "itemId": itemId]
            )
        default:
            // Default tap (and any action we don't handle) routes through the
            // existing deep-link navigation, which knows the payload keys.
            await MainActor.run {
                PushNotificationService.shared.notePushReceived()
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
