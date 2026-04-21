import UIKit
import UserNotifications
import os

private let appDelegateLog = Logger(subsystem: "com.ade.app", category: "notifications")

/// Owns APNs registration, notification-category setup, and foreground /
/// response routing for push notifications.
///
/// Wired into `ADEApp` via `@UIApplicationDelegateAdaptor` so SwiftUI still
/// drives the scene lifecycle — we only need the delegate plumbing for the
/// notification surface APNs does not expose through SwiftUI.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    NotificationCategories.register()

    // Bridge Live Activity / Control Widget intents → SyncService. The
    // registry lives in the shared intents file so widget/NS extensions can
    // reference the symbols; only the main app installs the forwarder.
    Task { @MainActor in
      ADEIntentCommandRegistry.register(ADESyncIntentBridge.shared)
    }

    Task {
      do {
        // `.timeSensitive` is a valid UNAuthorizationOptions value on iOS 15+ and
        // is required so the OS honours our `interruptionLevel = .timeSensitive`
        // pushes (awaiting-input). It pairs with the
        // `com.apple.developer.usernotifications.time-sensitive` entitlement.
        // `.providesAppNotificationSettings` surfaces an in-app "Notification
        // Settings" button in the Settings app (iOS 12+).
        var options: UNAuthorizationOptions = [
          .alert, .badge, .sound, .providesAppNotificationSettings,
        ]
        if #available(iOS 15.0, *) {
          options.insert(.timeSensitive)
        }
        let granted = try await center.requestAuthorization(options: options)
        if granted {
          await MainActor.run {
            application.registerForRemoteNotifications()
          }
        }
      } catch {
        appDelegateLog.error("Notification authorization failed: \(error.localizedDescription, privacy: .public)")
      }
    }

    return true
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    // Never log the hex token — it is effectively a per-install credential.
    appDelegateLog.debug("Registered APNs alert token (\(deviceToken.count, privacy: .public) bytes)")
    Task { @MainActor in
      await SyncService.shared?.registerPushToken(hex, kind: .alert, sessionId: nil)
    }
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    appDelegateLog.error("APNs registration failed: \(error.localizedDescription, privacy: .public)")
  }

  // MARK: - UNUserNotificationCenterDelegate

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let categoryId = notification.request.content.categoryIdentifier
    if categoryId == NotificationCategories.Identifier.chatTurnCompleted {
      let prefs = NotificationPreferences.load(from: ADESharedContainer.defaults)
      if prefs.chatTurnCompleted == false {
        completionHandler([])
        return
      }
    }
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    let actionId = response.actionIdentifier

    Task { @MainActor in
      defer { completionHandler() }

      let sessionId = (userInfo["sessionId"] as? String) ?? ""
      let itemId = (userInfo["itemId"] as? String) ?? ""
      let prNumberValue: Any = userInfo["prNumber"] ?? ""

      switch actionId {
      case NotificationCategories.Action.approve:
        await SyncService.shared?.sendRemoteCommand(
          .approveSession,
          payload: ["sessionId": sessionId, "itemId": itemId]
        )
      case NotificationCategories.Action.deny:
        await SyncService.shared?.sendRemoteCommand(
          .denySession,
          payload: ["sessionId": sessionId, "itemId": itemId]
        )
      case NotificationCategories.Action.reply:
        if let textResponse = response as? UNTextInputNotificationResponse {
          // Never log `userText` — it is user-authored message content.
          await SyncService.shared?.sendRemoteCommand(
            .replyToSession,
            payload: ["sessionId": sessionId, "itemId": itemId, "text": textResponse.userText]
          )
        }
      case NotificationCategories.Action.open:
        DeepLinkRouter.shared.handleNotificationUserInfo(userInfo)
      case NotificationCategories.Action.restart:
        await SyncService.shared?.sendRemoteCommand(
          .restartSession,
          payload: ["sessionId": sessionId]
        )
      case NotificationCategories.Action.openPr:
        DeepLinkRouter.shared.handleNotificationUserInfo(userInfo)
      case NotificationCategories.Action.retryChecks:
        let prId = (userInfo["prId"] as? String) ?? ""
        await SyncService.shared?.sendRemoteCommand(
          .retryPrChecks,
          payload: ["prId": prId, "prNumber": prNumberValue]
        )
      case UNNotificationDefaultActionIdentifier:
        DeepLinkRouter.shared.handleNotificationUserInfo(userInfo)
      case UNNotificationDismissActionIdentifier:
        // User swiped away; nothing to do.
        break
      default:
        DeepLinkRouter.shared.handleNotificationUserInfo(userInfo)
      }
    }
  }
}

// MARK: - Live Activity / Control Widget bridge

/// Maps the cross-target `ADEIntentCommandKind` to the main-app
/// `RemoteCommandKind` and forwards through `SyncService.shared`. Kept in
/// the main target so the widget + notification-service binaries never
/// reference `SyncService` symbols.
@MainActor
final class ADESyncIntentBridge: ADEIntentCommandBridge {
  static let shared = ADESyncIntentBridge()

  private init() {}

  func dispatch(_ kind: ADEIntentCommandKind, payload: [String: Any]) async {
    let mapped: RemoteCommandKind
    switch kind {
    case .approveSession: mapped = .approveSession
    case .denySession: mapped = .denySession
    case .pauseSession: mapped = .pauseSession
    case .replyToSession: mapped = .replyToSession
    case .restartSession: mapped = .restartSession
    case .retryPrChecks: mapped = .retryPrChecks
    case .openPr: mapped = .openPr
    case .setMutePush: mapped = .setMutePush
    }
    await SyncService.shared?.sendRemoteCommand(mapped, payload: payload)
  }
}
