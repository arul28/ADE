import Foundation

/// Central router for ADE URLs and deep-link requests posted from the
/// notification delegate. Existing tab/navigation views listen to
/// `.adeDeepLinkRequested` and flip their selection when fired; new
/// cross-machine shapes (lane / repo / extended pr / linear-issue) instead
/// post `.adeSendToMacRequested` so the parent view can show a "Send to your
/// Mac" confirmation card. Repo-scoped PR URLs are also accepted locally
/// because push notifications use them to disambiguate duplicate PR numbers.
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
  ///   * `ade://file/<repo-relative-path>[?line=<n>&lane=<uuid>]`
  ///   * `ade://commit/<sha>[?lane=<uuid>]`
  ///   * `ade://artifact/<id>`
  ///   * `ade://repo/<owner>/<repo>/branch/<branch>`
  ///   * `ade://pr/<owner>/<repo>/<number>`
  ///   * `ade://linear-issue/<ADE-123>[?branch=<branch>]`
  ///
  /// Also accepts the web mirror used by CLI / agent handoff output:
  /// `https://ade-app.dev/open?type=<lane|session|file|commit|artifact|branch|pr|linear-issue>&...`.
  ///
  /// Unknown hosts are ignored rather than crashing on malformed input.
  func handle(_ url: URL) {
    if routePairingURL(url) { return }
    if routeHttpsOpenURL(url) { return }
    guard url.scheme?.lowercased() == "ade" else { return }
    let host = url.host?.lowercased()
    let pathComponents = url.pathComponents
      .filter { $0 != "/" }
      .map { $0.removingPercentEncoding ?? $0 }
    switch host {
    case "session":
      guard let sessionId = pathComponents.first,
            ADEDeepLinkURLParsing.isValidOpaqueId(sessionId),
            let anchors = sessionAnchors(from: url) else { return }
      post(kind: "session", identifier: sessionId, event: anchors.event, offset: anchors.offset)
    case "pr":
      // Two accepted shapes today:
      //   `ade://pr/<n>`                       (compact local link)
      //   `ade://pr/<owner>/<repo>/<number>`   (repo-scoped local link)
      // Anything else is ignored so a malformed link can't crash navigation.
      if pathComponents.count >= 3 {
        let owner = pathComponents[0]
        let repo = pathComponents[1]
        guard ADEDeepLinkURLParsing.splitRepo("\(owner)/\(repo)") != nil,
              let number = Int(pathComponents[2]),
              number > 0 else { return }
        post(kind: "pr", identifier: "\(number)", prNumber: number, repoOwner: owner, repoName: repo)
        return
      }
      guard let raw = pathComponents.first, !raw.isEmpty else { return }
      post(kind: "pr", identifier: raw)
    case "lane":
      // Lanes are a local-only desktop concept — the iOS client has no
      // counterpart UI, so we surface a "Send to your Mac" card instead of
      // trying to navigate.
      guard let laneId = pathComponents.first,
            ADEDeepLinkURLParsing.isValidUUID(laneId) else { return }
      postSendToMac(url: url)
    case "file":
      let path = pathComponents.joined(separator: "/")
      guard isValidFileTarget(path: path, url: url) else { return }
      postSendToMac(url: url)
    case "commit":
      guard let sha = pathComponents.first,
            isValidCommitTarget(sha: sha, url: url) else { return }
      postSendToMac(url: url)
    case "artifact":
      guard let artifactId = pathComponents.first,
            ADEDeepLinkURLParsing.isValidOpaqueId(artifactId) else { return }
      postSendToMac(url: url)
    case "repo":
      // `ade://repo/<owner>/<repo>/branch/<branch>` — also cross-machine.
      // We validate the shape so a stray `ade://repo/foo` doesn't trigger
      // an empty send-to-mac sheet.
      guard pathComponents.count >= 4,
            pathComponents[2].lowercased() == "branch",
            ADEDeepLinkURLParsing.splitRepo("\(pathComponents[0])/\(pathComponents[1])") != nil,
            ADEDeepLinkURLParsing.isValidBranch(pathComponents.dropFirst(3).joined(separator: "/"))
      else { return }
      postSendToMac(url: url)
    case "linear-issue":
      // `ade://linear-issue/<ADE-123>[?branch=<branch>]` — Linear "Open in
      // coding tool" hand-off. When a project is open on the phone the global
      // Linear pane resolves the issue itself (it searches Linear by
      // identifier); otherwise we bounce the link to the paired Mac. We validate
      // the identifier shape so a stray `ade://linear-issue/` doesn't fire.
      guard let identifier = pathComponents.first,
            ADEDeepLinkURLParsing.isValidLinearIdentifier(identifier),
            isValidLinearIssueBranch(url: url)
      else { return }
      routeLinearIssue(identifier: identifier, url: url)
    default:
      return
    }
  }

  /// Routes a scanned/opened pairing URL — `https://ade-app.dev/pair#<payload>`
  /// or `ade://pair#<payload>` — into the pairing flow. The payload rides the
  /// fragment; we hand the whole URL to `SyncService` for the settings screen
  /// to parse and present (reconnect for a known machine, PIN for a new one).
  private func routePairingURL(_ url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
    let scheme = components.scheme?.lowercased()
    let isHttpsPair = scheme == "https"
      && ADEDeepLinkURLParsing.isADEWebHost(components.host)
      && (components.path == "/pair" || components.path.hasSuffix("/pair"))
    let isCustomPair = scheme == "ade" && url.host?.lowercased() == "pair"
    guard isHttpsPair || isCustomPair else { return false }
    // A pairing URL with no fragment carries no payload — swallow it so it
    // doesn't fall through to other handlers, but there's nothing to present.
    guard components.fragment?.isEmpty == false else { return true }
    ProductAnalytics.shared.captureFeature(
      .deepLink,
      outcome: .opened,
      source: .pairingLink
    )
    SyncService.shared?.requestedPairingQrNavigation = PairingQrNavigationRequest(raw: url.absoluteString)
    NotificationCenter.default.post(
      name: .adeDeepLinkRequested,
      object: nil,
      userInfo: ["kind": "pairing", "identifier": url.absoluteString]
    )
    return true
  }

  private func routeHttpsOpenURL(_ url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.scheme?.lowercased() == "https",
          ADEDeepLinkURLParsing.isADEWebHost(components.host),
          components.path == "/open" else {
      return false
    }

    let query = ADEDeepLinkURLParsing.adeQueryValues(from: components)
    switch query["type"]?.lowercased() {
    case "lane":
      guard ADEDeepLinkURLParsing.isValidUUID(query["id"]) else { return true }
      postSendToMac(url: url)
    case "session":
      guard let sessionId = query["id"],
            ADEDeepLinkURLParsing.isValidOpaqueId(sessionId),
            let anchors = sessionAnchors(from: query) else { return true }
      post(kind: "session", identifier: sessionId, event: anchors.event, offset: anchors.offset)
    case "file":
      guard isValidFileTarget(path: query["path"] ?? "", query: query) else { return true }
      postSendToMac(url: url)
    case "commit":
      guard isValidCommitTarget(sha: query["sha"] ?? "", query: query) else { return true }
      postSendToMac(url: url)
    case "artifact":
      guard ADEDeepLinkURLParsing.isValidOpaqueId(query["id"]) else { return true }
      postSendToMac(url: url)
    case "branch":
      guard ADEDeepLinkURLParsing.splitRepo(query["repo"]) != nil,
            ADEDeepLinkURLParsing.isValidBranch(query["branch"]),
            query["pr"] == nil || ADEDeepLinkURLParsing.positiveInteger(query["pr"]) != nil else { return true }
      postSendToMac(url: url)
    case "pr":
      guard let number = ADEDeepLinkURLParsing.positiveInteger(query["number"]) else { return true }
      // PR numbers are only unique within a repository, and the local
      // workspace snapshot carries no repo identity — when the link names a
      // repo, hand off to the paired Mac (whose resolution ladder verifies
      // the repo) instead of guessing a local PR by bare number.
      if query["repo"]?.isEmpty ?? true {
        post(kind: "pr", identifier: "\(number)", prNumber: number)
        return true
      }
      guard ADEDeepLinkURLParsing.splitRepo(query["repo"]) != nil else { return true }
      postSendToMac(url: url)
    case "linear-issue":
      guard let identifier = query["issue"],
            ADEDeepLinkURLParsing.isValidLinearIdentifier(identifier),
            ADEDeepLinkURLParsing.isValidBranch(query["branch"] ?? "main")
              || query["branch"] == nil else { return true }
      routeLinearIssue(identifier: identifier, url: url)
    default:
      break
    }
    return true
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
      post(
        kind: "pr",
        identifier: prId,
        prNumber: prNumberValue(from: userInfo["prNumber"])
      )
      return
    }
    if let pr = userInfo["prNumber"] {
      let identifier = "\(pr)"
      guard !identifier.isEmpty else { return }
      post(
        kind: "pr",
        identifier: identifier,
        prNumber: prNumberValue(from: userInfo["prNumber"]),
        repoOwner: stringValue(from: userInfo["repoOwner"]),
        repoName: stringValue(from: userInfo["repoName"])
      )
    }
  }

  private func post(
    kind: String,
    identifier: String,
    prNumber: Int? = nil,
    repoOwner: String? = nil,
    repoName: String? = nil,
    event: Int? = nil,
    offset: Int? = nil
  ) {
    let analyticsSource: ADEAnalyticsSource?
    switch kind {
    case "session": analyticsSource = .sessionLink
    case "pr": analyticsSource = .pullRequestLink
    default: analyticsSource = nil
    }
    if let analyticsSource {
      ProductAnalytics.shared.captureFeature(
        .deepLink,
        outcome: .opened,
        source: analyticsSource
      )
    }

    var userInfo: [String: Any] = ["kind": kind, "identifier": identifier]
    if let event { userInfo["event"] = event }
    if let offset { userInfo["offset"] = offset }
    let scopedRepoOwner = repoOwner?.trimmingCharacters(in: .whitespacesAndNewlines)
    let scopedRepoName = repoName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let scopedRepoOwner, !scopedRepoOwner.isEmpty { userInfo["repoOwner"] = scopedRepoOwner }
    if let scopedRepoName, !scopedRepoName.isEmpty { userInfo["repoName"] = scopedRepoName }
    NotificationCenter.default.post(
      name: .adeDeepLinkRequested,
      object: nil,
      userInfo: userInfo
    )
    if kind == "session" {
      SyncService.shared?.requestedWorkSessionNavigation = WorkSessionNavigationRequest(
        sessionId: identifier,
        event: event,
        offset: offset
      )
    }
    if kind == "pr" {
      let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
      if let number = prNumber ?? Int(trimmed),
         let scopedRepoOwner,
         let scopedRepoName,
         !scopedRepoOwner.isEmpty,
         !scopedRepoName.isEmpty {
        SyncService.shared?.requestedPrNavigation = PrNavigationRequest(
          prNumber: number,
          repoOwner: scopedRepoOwner,
          repoName: scopedRepoName
        )
      } else if let prId = resolvePrId(from: trimmed) {
        SyncService.shared?.requestedPrNavigation = PrNavigationRequest(
          prId: prId,
          prNumber: prNumber ?? Int(trimmed)
        )
      } else if let prNumber = Int(trimmed), prNumber > 0 {
        SyncService.shared?.requestedPrNavigation = PrNavigationRequest(prNumber: prNumber)
      }
    }
  }

  private func sessionAnchors(from url: URL) -> (event: Int?, offset: Int?)? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return (nil, nil)
    }
    return sessionAnchors(from: ADEDeepLinkURLParsing.adeQueryValues(from: components))
  }

  private func sessionAnchors(from query: [String: String]) -> (event: Int?, offset: Int?)? {
    if let lane = query["lane"], !ADEDeepLinkURLParsing.isValidUUID(lane) {
      return nil
    }
    let event = ADEDeepLinkURLParsing.nonNegativeInteger(query["event"])
    if query["event"] != nil && event == nil { return nil }
    let offset = ADEDeepLinkURLParsing.nonNegativeInteger(query["offset"])
    if query["offset"] != nil && offset == nil { return nil }
    return (event, offset)
  }

  private func isValidFileTarget(path: String, url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
    return isValidFileTarget(path: path, query: ADEDeepLinkURLParsing.adeQueryValues(from: components))
  }

  private func isValidFileTarget(path: String, query: [String: String]) -> Bool {
    guard ADEDeepLinkURLParsing.isValidRepoRelativePath(path) else { return false }
    if let lane = query["lane"], !ADEDeepLinkURLParsing.isValidUUID(lane) {
      return false
    }
    if let line = query["line"], ADEDeepLinkURLParsing.positiveInteger(line) == nil {
      return false
    }
    return true
  }

  private func isValidCommitTarget(sha: String, url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
    return isValidCommitTarget(sha: sha, query: ADEDeepLinkURLParsing.adeQueryValues(from: components))
  }

  private func isValidCommitTarget(sha: String, query: [String: String]) -> Bool {
    guard ADEDeepLinkURLParsing.isValidCommitSha(sha) else { return false }
    if let lane = query["lane"], !ADEDeepLinkURLParsing.isValidUUID(lane) {
      return false
    }
    return true
  }

  private func isValidLinearIssueBranch(url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return true }
    let query = ADEDeepLinkURLParsing.adeQueryValues(from: components)
    guard let branch = query["branch"] else { return true }
    return ADEDeepLinkURLParsing.isValidBranch(branch)
  }

  /// A `linear-issue` link resolves in-app when a project is open on the phone
  /// (the global Linear pane searches Linear by identifier); otherwise it bounces
  /// to the paired Mac, which owns the workspace's lane↔issue mapping.
  private func routeLinearIssue(identifier: String, url: URL) {
    if SyncService.shared?.activeProjectId != nil {
      ProductAnalytics.shared.captureFeature(
        .deepLink,
        outcome: .opened,
        source: .linearIssueLink
      )
      SyncService.shared?.requestedLinearIssueNavigation = LinearIssueNavigationRequest(identifier: identifier)
    } else {
      postSendToMac(url: url, analyticsSource: .linearIssueLink)
    }
  }

  /// Cross-machine deep links (lane / repo-branch / linear-issue) post on the
  /// send-to-mac channel so the presentation layer can pop the confirmation
  /// card. We pass the raw URL through so the card can render the target
  /// plainly without the router needing to know about each shape.
  private func postSendToMac(
    url: URL,
    analyticsSource: ADEAnalyticsSource = .sendToMacLink
  ) {
    ProductAnalytics.shared.captureFeature(
      .deepLink,
      outcome: .opened,
      source: analyticsSource
    )
    NotificationCenter.default.post(
      name: .adeSendToMacRequested,
      object: nil,
      userInfo: ["url": url.absoluteString]
    )
  }

  private func prNumberValue(from value: Any?) -> Int? {
    if let number = value as? Int, number > 0 { return number }
    if let number = value as? NSNumber {
      let intValue = number.intValue
      if intValue > 0 { return intValue }
    }
    if let string = value as? String {
      let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
      if let number = Int(trimmed), number > 0 { return number }
    }
    return nil
  }

  private func stringValue(from value: Any?) -> String? {
    guard let string = value as? String else { return nil }
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  /// PR deep links carry either a numeric PR number (from `ade://pr/<n>`
  /// compact local URLs) or a stable `prId` (from notification payloads
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
