import Foundation

/// Central router for `ade://` URLs and deep-link requests posted from the
/// notification delegate. Existing tab/navigation views listen to
/// `.adeDeepLinkRequested` and flip their selection when fired.
///
/// Kept intentionally tiny — the heavy lifting lives in the individual tabs.
@MainActor
final class DeepLinkRouter {
  static let shared = DeepLinkRouter()

  private init() {}

  /// Parse and dispatch an incoming URL or synthesised deep-link from a
  /// notification response. Supports `ade://session/<id>` and `ade://pr/<n>`
  /// today; unknown hosts are ignored rather than crashing on malformed input.
  func handle(_ url: URL) {
    guard url.scheme?.lowercased() == "ade" else { return }
    let host = url.host?.lowercased()
    let pathComponents = url.pathComponents.filter { $0 != "/" }
    switch host {
    case "session":
      guard let sessionId = pathComponents.first, !sessionId.isEmpty else { return }
      post(kind: "session", identifier: sessionId)
    case "pr":
      guard let raw = pathComponents.first, !raw.isEmpty else { return }
      post(kind: "pr", identifier: raw)
    default:
      return
    }
  }

  /// Synthesise a deep link from a notification payload's `sessionId` /
  /// `prNumber` keys. Used when the user taps the notification body or a
  /// default action we do not special-case into a remote command.
  func handleNotificationUserInfo(_ userInfo: [AnyHashable: Any]) {
    if let raw = userInfo["deepLink"] as? String, let url = URL(string: raw) {
      handle(url)
      return
    }
    if let sessionId = userInfo["sessionId"] as? String, !sessionId.isEmpty {
      post(kind: "session", identifier: sessionId)
      return
    }
    if let prId = userInfo["prId"] as? String, !prId.isEmpty {
      post(kind: "pr", identifier: prId)
      return
    }
    if let pr = userInfo["prNumber"] {
      let identifier = "\(pr)"
      guard !identifier.isEmpty else { return }
      post(kind: "pr", identifier: identifier)
    }
  }

  private func post(kind: String, identifier: String) {
    NotificationCenter.default.post(
      name: .adeDeepLinkRequested,
      object: nil,
      userInfo: ["kind": kind, "identifier": identifier]
    )
    if kind == "pr", let prId = resolvePrId(from: identifier) {
      SyncService.shared?.requestedPrNavigation = PrNavigationRequest(prId: prId)
    }
  }

  /// PR deep links carry either a numeric PR number (from `ade://pr/<n>`
  /// widget/live-activity URLs) or a stable `prId` (from notification payloads
  /// that include both). Resolve the number to the matching `prId` via the
  /// App Group workspace snapshot so navigation always uses the same
  /// identifier as `PrsRootScreen`.
  private func resolvePrId(from identifier: String) -> String? {
    let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if let number = Int(trimmed),
       let snapshot = ADESharedContainer.readWorkspaceSnapshot(),
       let match = snapshot.prs.first(where: { $0.number == number }) {
      return match.id
    }
    return trimmed
  }
}

extension Notification.Name {
  /// Posted by `DeepLinkRouter` so navigation views can switch tabs and push
  /// detail destinations without referencing the router directly.
  static let adeDeepLinkRequested = Notification.Name("ade.deepLinkRequested")
}
