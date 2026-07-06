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
        return true
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
        await MainActor.run {
            PushNotificationService.shared.notePushReceived()
            DeepLinkRouter.shared.handleNotificationUserInfo(userInfo)
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
