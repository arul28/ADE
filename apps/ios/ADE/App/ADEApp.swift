import SwiftUI

@main
struct ADEApp: App {
  @UIApplicationDelegateAdaptor(ADEAppDelegate.self) private var appDelegate
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var syncService = SyncService()
  /// App-level dictation singleton. Owning the single `SpeechDictationService`
  /// here (rather than per-composer) lets recording survive navigation and
  /// drive the global in-app recording pill.
  @StateObject private var dictationController = DictationController()
  /// ClerkKit-backed account state (identity + directory machines). A singleton
  /// so it's reachable from sheets without threading it through the environment.
  @StateObject private var accountService = AccountService.shared
  @State private var didBootstrapSync = false
  @State private var lastActivationSyncAt = Date.distantPast
  @State private var didEnterBackground = false
  /// Pending cross-machine deep link awaiting a "Send to Mac" confirmation.
  /// Driven by `.adeSendToMacRequested` notifications from `DeepLinkRouter`.
  @State private var sendToMacTarget: SendToMacTarget?

  @MainActor
  init() {
    ADEIntentCommandRegistry.register(ADESyncIntentBridge.shared)
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(syncService)
        .environmentObject(dictationController)
        .environmentObject(accountService)
        .task {
          // Configure ClerkKit and restore any cached session as early as
          // possible so the account surface has determinate state. No-op when
          // no publishable key is wired into the build.
          await accountService.bootstrap()
        }
        .task {
          guard !didBootstrapSync else { return }
          didBootstrapSync = true
          lastActivationSyncAt = Date()
          await PushNotificationService.shared.clearAppBadge()
          // App Clip → full app handoff: adopt clip-scanned pairing
          // credentials before the first connect so a fresh install lands
          // already paired.
          await syncService.adoptClipPairingHandoffIfPresent()
          await syncService.handleForegroundTransition()
        }
        .onChange(of: scenePhase) { _, newPhase in
          if newPhase == .background {
            didEnterBackground = true
            ProductAnalytics.shared.flush()
            return
          }
          guard newPhase == .active else { return }
          if didEnterBackground {
            didEnterBackground = false
            ProductAnalytics.shared.captureAppOpened(.foreground)
          }
          // Clear the badge on every foreground, independent of the sync
          // throttle below — a lingering count after re-entry reads as stale.
          Task { await PushNotificationService.shared.clearAppBadge() }
          // Defense-in-depth: drain intent commands queued by an extension
          // process while the bridge wasn't reachable (cold launch drains via
          // register(); this covers warm foregrounds).
          Task { await ADEIntentCommandRegistry.drainPendingCommands() }
          Task { await accountService.refreshAttentionSnapshot() }
          guard didBootstrapSync else { return }
          let now = Date()
          guard now.timeIntervalSince(lastActivationSyncAt) > 1.0 else { return }
          lastActivationSyncAt = now
          Task {
            await syncService.handleForegroundTransition()
          }
        }
        .onOpenURL { url in
          DeepLinkRouter.shared.handle(url)
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
          guard let url = activity.webpageURL else { return }
          DeepLinkRouter.shared.handle(url)
        }
        .onReceive(NotificationCenter.default.publisher(for: .adeSendToMacRequested)) { note in
          // Parse the URL out of the payload posted by `DeepLinkRouter`. We
          // accept either a `URL` or a `String` so callers don't have to
          // serialise the same value twice.
          let url: URL?
          if let direct = note.userInfo?["url"] as? URL {
            url = direct
          } else if let string = note.userInfo?["url"] as? String {
            url = URL(string: string)
          } else {
            url = nil
          }
          guard let resolved = url else { return }
          sendToMacTarget = SendToMacTarget(url: resolved)
        }
        .sheet(item: $sendToMacTarget) { target in
          SendToMacCard(target: target) {
            sendToMacTarget = nil
          }
          .environmentObject(syncService)
        }
    }
  }
}

// MARK: - Attention action command bridge

/// Maps the cross-target intent commands to main-app remote commands.
/// Kept in a tiny bridge so App Intent actions do not link `SyncService`.
@MainActor
private final class ADESyncIntentBridge: ADEIntentCommandBridge {
  static let shared = ADESyncIntentBridge()

  private init() {}

  func dispatch(_ kind: ADEIntentCommandKind, payload: [String: Any]) async {
    let mapped: RemoteCommandKind
    switch kind {
    case .approveSession: mapped = .approveSession
    case .denySession: mapped = .denySession
    case .restartSession: mapped = .restartSession
    case .retryPrChecks: mapped = .retryPrChecks
    }
    guard let sync = SyncService.shared else { return }
    // A notification action or Live Activity button can background-launch the
    // app before the sync socket is up; these commands are not queueable
    // (approving a stale item later would be wrong), so give the socket a
    // bounded chance to connect — the tap IS a user-initiated reconnect.
    if sync.connectionState != .connected {
      await sync.reconnectIfPossible(userInitiated: true)
      for _ in 0..<20 where sync.connectionState != .connected {
        try? await Task.sleep(nanoseconds: 250_000_000)
      }
    }
    await sync.sendRemoteCommand(mapped, payload: payload)
  }
}
