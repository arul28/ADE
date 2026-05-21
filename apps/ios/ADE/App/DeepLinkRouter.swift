import Foundation

/// Central router for `ade://` URLs and deep-link requests posted from the
/// notification delegate. Existing tab/navigation views listen to
/// `.adeDeepLinkRequested` and flip their selection when fired; new
/// cross-machine shapes (lane / repo / extended pr / linear-issue) instead
/// post `.adeSendToMacRequested` so the parent view can show a "Send to your
/// Mac" confirmation card.
///
/// Kept intentionally tiny — the heavy lifting lives in the individual tabs.
@MainActor
final class DeepLinkRouter {
  static let shared = DeepLinkRouter()

  private init() {}

  /// Parse and dispatch an incoming URL or synthesised deep-link from a
  /// notification response. Supports the legacy `ade://session/<id>` and
  /// `ade://pr/<n>` forms plus the four new desktop-originated shapes:
  ///
  ///   * `ade://lane/<uuid>`
  ///   * `ade://repo/<owner>/<repo>/branch/<branch>`
  ///   * `ade://pr/<owner>/<repo>/<number>`
  ///   * `ade://linear-issue/<ADE-123>[?branch=<branch>]`
  ///
  /// Unknown hosts are ignored rather than crashing on malformed input.
  func handle(_ url: URL) {
    guard url.scheme?.lowercased() == "ade" else { return }
    let host = url.host?.lowercased()
    let pathComponents = url.pathComponents.filter { $0 != "/" }
    switch host {
    case "session":
      guard let sessionId = pathComponents.first, !sessionId.isEmpty else { return }
      post(kind: "session", identifier: sessionId)
    case "pr":
      // Two accepted shapes today:
      //   `ade://pr/<n>`                       (legacy widget/live-activity)
      //   `ade://pr/<owner>/<repo>/<number>`   (desktop cross-machine form)
      // Anything else is ignored so a malformed link can't crash navigation.
      if pathComponents.count >= 3 {
        let raw = pathComponents[2]
        guard !raw.isEmpty else { return }
        post(kind: "pr", identifier: raw)
        return
      }
      guard let raw = pathComponents.first, !raw.isEmpty else { return }
      post(kind: "pr", identifier: raw)
    case "lane":
      // Lanes are a local-only desktop concept — the iOS client has no
      // counterpart UI, so we surface a "Send to your Mac" card instead of
      // trying to navigate.
      guard let laneId = pathComponents.first, !laneId.isEmpty else { return }
      postSendToMac(url: url)
    case "repo":
      // `ade://repo/<owner>/<repo>/branch/<branch>` — also cross-machine.
      // We validate the shape so a stray `ade://repo/foo` doesn't trigger
      // an empty send-to-mac sheet.
      guard pathComponents.count >= 4,
            pathComponents[2].lowercased() == "branch",
            !pathComponents[0].isEmpty,
            !pathComponents[1].isEmpty,
            !pathComponents[3].isEmpty
      else { return }
      postSendToMac(url: url)
    case "linear-issue":
      // `ade://linear-issue/<ADE-123>[?branch=<branch>]` — Linear "Open in
      // coding tool" hand-off. Resolving the issue to a lane requires the
      // workspace's `lane.linearIssue` mapping, which only the desktop has,
      // so we bounce the link to the paired Mac. We validate the identifier
      // shape so a stray `ade://linear-issue/` doesn't pop an empty sheet.
      guard let identifier = pathComponents.first,
            !identifier.isEmpty
      else { return }
      postSendToMac(url: url)
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
    if kind == "session" {
      SyncService.shared?.requestedWorkSessionNavigation = WorkSessionNavigationRequest(sessionId: identifier)
    }
    if kind == "pr", let prId = resolvePrId(from: identifier) {
      SyncService.shared?.requestedPrNavigation = PrNavigationRequest(prId: prId)
    }
  }

  /// Cross-machine deep links (lane / repo-branch / linear-issue) post on the
  /// send-to-mac channel so the presentation layer can pop the confirmation
  /// card. We pass the raw URL through so the card can render the target
  /// plainly without the router needing to know about each shape.
  private func postSendToMac(url: URL) {
    NotificationCenter.default.post(
      name: .adeSendToMacRequested,
      object: nil,
      userInfo: ["url": url.absoluteString]
    )
  }

  /// PR deep links carry either a numeric PR number (from `ade://pr/<n>`
  /// widget/live-activity URLs) or a stable `prId` (from notification payloads
  /// that include both). Resolve the number to the matching `prId` via the
  /// App Group workspace snapshot so navigation always uses the same
  /// identifier as `PrsRootScreen`.
  private func resolvePrId(from identifier: String) -> String? {
    let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if let number = Int(trimmed) {
      // Pure-number deep links (e.g. `ade://pr/123`) must look up the canonical
      // prId from the workspace snapshot. If we can't, returning the numeric
      // string would be stored as a `prId` in `PrNavigationRequest` and silently
      // fail to match any PR in `PrsRootScreen`. Fall back to nil so callers can
      // degrade gracefully (e.g., the number-based notification path).
      guard let snapshot = ADESharedContainer.readWorkspaceSnapshot(),
            let match = snapshot.prs.first(where: { $0.number == number }) else {
        return nil
      }
      return match.id
    }
    return trimmed
  }
}

extension Notification.Name {
  /// Posted by `DeepLinkRouter` so navigation views can switch tabs and push
  /// detail destinations without referencing the router directly.
  static let adeDeepLinkRequested = Notification.Name("ade.deepLinkRequested")

  /// Posted by `DeepLinkRouter` for cross-machine deep links (lane / repo /
  /// branch / linear-issue) that the mobile client can't open directly.
  /// `userInfo["url"]` carries the original `ade://...` URL string.
  static let adeSendToMacRequested = Notification.Name("ade.sendToMacRequested")
}
