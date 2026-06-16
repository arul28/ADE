import SwiftUI

@main
struct ADEApp: App {
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

  @MainActor
  init() {
    ADEIntentCommandRegistry.register(ADESyncIntentBridge.shared)
  }

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

// MARK: - Live Activity / Control Widget command bridge

/// Maps the cross-target intent commands to main-app remote commands.
/// Kept in the main ADE target so widgets never link `SyncService`.
@MainActor
private final class ADESyncIntentBridge: ADEIntentCommandBridge {
  static let shared = ADESyncIntentBridge()

  private init() {}

  func dispatch(_ kind: ADEIntentCommandKind, payload: [String: Any]) async {
    if kind == .openPr {
      requestPrNavigationFromIntentPayload(payload)
    }

    let mapped: RemoteCommandKind
    switch kind {
    case .approveSession: mapped = .approveSession
    case .denySession: mapped = .denySession
    case .pauseSession: mapped = .pauseSession
    case .replyToSession: mapped = .replyToSession
    case .restartSession: mapped = .restartSession
    case .retryPrChecks: mapped = .retryPrChecks
    case .openPr: mapped = .openPr
    case .openDeeplink: mapped = .openDeeplink
    }
    await SyncService.shared?.sendRemoteCommand(mapped, payload: payload)
  }
}

@MainActor
func requestPrNavigationFromIntentPayload(_ payload: [String: Any]) {
  let prId = (payload["prId"] as? String)?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  let prNumber = intentPayloadPrNumber(payload["prNumber"])

  if let prId, !prId.isEmpty {
    SyncService.shared?.requestedPrNavigation = PrNavigationRequest(prId: prId, prNumber: prNumber)
  } else if let prNumber {
    SyncService.shared?.requestedPrNavigation = PrNavigationRequest(prNumber: prNumber)
  }
}

private func intentPayloadPrNumber(_ rawValue: Any?) -> Int? {
  if let value = rawValue as? Int, value > 0 {
    return value
  }
  if let value = rawValue as? NSNumber, value.intValue > 0 {
    return value.intValue
  }
  if let string = rawValue as? String,
    let value = Int(string.trimmingCharacters(in: .whitespacesAndNewlines)),
    value > 0 {
    return value
  }
  return nil
}
