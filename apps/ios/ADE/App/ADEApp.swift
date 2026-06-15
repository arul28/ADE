import SwiftUI

@main
struct ADEApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var syncService = SyncService()
  /// App-level dictation singleton. Owning the single `SpeechDictationService`
  /// here (rather than per-composer) lets recording survive navigation and
  /// drive the Dynamic Island Live Activity.
  @StateObject private var dictationController = DictationController()
  @State private var didBootstrapSync = false
  @State private var lastActivationSyncAt = Date.distantPast
  /// Pending cross-machine deep link awaiting a "Send to Mac" confirmation.
  /// Driven by `.adeSendToMacRequested` notifications from `DeepLinkRouter`.
  @State private var sendToMacTarget: SendToMacTarget?

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(syncService)
        .environmentObject(dictationController)
        .task {
          guard !didBootstrapSync else { return }
          didBootstrapSync = true
          lastActivationSyncAt = Date()
          await syncService.handleForegroundTransition()
        }
        .onChange(of: scenePhase) { _, newPhase in
          guard newPhase == .active else { return }
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

