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
            let scope = sessionNavigationScope(from: url) else { return }
      post(
        kind: "session",
        identifier: sessionId,
        laneId: scope.laneId,
        repoOwner: scope.repoOwner,
        repoName: scope.repoName,
        branch: scope.branch,
        accountMachineKey: scope.accountMachineKey,
        itemId: scope.itemId,
        eventId: scope.eventId,
        event: scope.event,
        offset: scope.offset
      )
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
        post(
          kind: "pr",
          identifier: "\(number)",
          prNumber: number,
          repoOwner: owner,
          repoName: repo,
          detailTab: prDetailTab(from: url),
          accountMachineKey: accountMachineKey(from: url),
          eventId: eventId(from: url)
        )
        return
      }
      guard let raw = pathComponents.first, !raw.isEmpty else { return }
      post(
        kind: "pr",
        identifier: raw,
        detailTab: prDetailTab(from: url),
        accountMachineKey: accountMachineKey(from: url),
        eventId: eventId(from: url)
      )
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
            let scope = sessionNavigationScope(from: query) else { return true }
      post(
        kind: "session",
        identifier: sessionId,
        laneId: scope.laneId,
        repoOwner: scope.repoOwner,
        repoName: scope.repoName,
        branch: scope.branch,
        accountMachineKey: scope.accountMachineKey,
        itemId: scope.itemId,
        eventId: scope.eventId,
        event: scope.event,
        offset: scope.offset
      )
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
      if let accountMachineKey = query["accountmachinekey"],
         !ADEDeepLinkURLParsing.isValidOpaqueId(accountMachineKey) {
        return true
      }
      if let eventId = query["event"],
         !ADEDeepLinkURLParsing.isValidOpaqueId(eventId) {
        return true
      }
      let detailTab = prDetailTab(from: query["tab"])
      if query["repo"]?.isEmpty ?? true {
        post(
          kind: "pr",
          identifier: "\(number)",
          prNumber: number,
          detailTab: detailTab,
          accountMachineKey: query["accountmachinekey"],
          eventId: query["event"]
        )
        return true
      }
      guard let repo = ADEDeepLinkURLParsing.splitRepo(query["repo"]) else { return true }
      post(
        kind: "pr",
        identifier: "\(number)",
        prNumber: number,
        repoOwner: repo.owner,
        repoName: repo.repo,
        detailTab: detailTab,
        accountMachineKey: query["accountmachinekey"],
        eventId: query["event"]
      )
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
      post(
        kind: "session",
        identifier: sessionId,
        laneId: stringValue(from: userInfo["laneId"]),
        repoOwner: stringValue(from: userInfo["repoOwner"]),
        repoName: stringValue(from: userInfo["repoName"]),
        branch: stringValue(from: userInfo["branch"]),
        accountMachineKey: stringValue(from: userInfo["accountMachineKey"]),
        itemId: stringValue(from: userInfo["itemId"]),
        eventId: stringValue(from: userInfo["eventId"])
      )
      return
    }
    if let prId = userInfo["prId"] as? String, !prId.isEmpty {
      post(
        kind: "pr",
        identifier: prId,
        prNumber: prNumberValue(from: userInfo["prNumber"]),
        detailTab: prDetailTab(from: stringValue(from: userInfo["detailTab"])),
        accountMachineKey: stringValue(from: userInfo["accountMachineKey"]),
        eventId: stringValue(from: userInfo["eventId"])
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
        repoName: stringValue(from: userInfo["repoName"]),
        detailTab: prDetailTab(from: stringValue(from: userInfo["detailTab"])),
        accountMachineKey: stringValue(from: userInfo["accountMachineKey"]),
        eventId: stringValue(from: userInfo["eventId"])
      )
    }
  }

  private func post(
    kind: String,
    identifier: String,
    prNumber: Int? = nil,
    laneId: String? = nil,
    repoOwner: String? = nil,
    repoName: String? = nil,
    detailTab: PrDetailTab? = nil,
    branch: String? = nil,
    accountMachineKey: String? = nil,
    itemId: String? = nil,
    eventId: String? = nil,
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
    let scopedLaneId = laneId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let scopedRepoOwner = repoOwner?.trimmingCharacters(in: .whitespacesAndNewlines)
    let scopedRepoName = repoName?.trimmingCharacters(in: .whitespacesAndNewlines)
    let scopedBranch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
    let scopedAccountMachineKey = accountMachineKey?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let scopedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let scopedEventId = eventId?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let scopedLaneId, !scopedLaneId.isEmpty { userInfo["laneId"] = scopedLaneId }
    if let scopedRepoOwner, !scopedRepoOwner.isEmpty { userInfo["repoOwner"] = scopedRepoOwner }
    if let scopedRepoName, !scopedRepoName.isEmpty { userInfo["repoName"] = scopedRepoName }
    if let detailTab { userInfo["detailTab"] = detailTab.rawValue }
    if let scopedBranch, !scopedBranch.isEmpty { userInfo["branch"] = scopedBranch }
    if let scopedAccountMachineKey, !scopedAccountMachineKey.isEmpty {
      userInfo["accountMachineKey"] = scopedAccountMachineKey
    }
    if let scopedItemId, !scopedItemId.isEmpty { userInfo["itemId"] = scopedItemId }
    if let scopedEventId, !scopedEventId.isEmpty { userInfo["eventId"] = scopedEventId }
    NotificationCenter.default.post(
      name: .adeDeepLinkRequested,
      object: nil,
      userInfo: userInfo
    )
    if kind == "session" {
      SyncService.shared?.requestedWorkSessionNavigation = WorkSessionNavigationRequest(
        sessionId: identifier,
        laneId: scopedLaneId,
        repoOwner: scopedRepoOwner,
        repoName: scopedRepoName,
        branch: scopedBranch,
        accountMachineKey: scopedAccountMachineKey,
        itemId: scopedItemId,
        eventId: scopedEventId,
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
          repoName: scopedRepoName,
          detailTab: detailTab,
          accountMachineKey: scopedAccountMachineKey,
          eventId: scopedEventId
        )
      } else if let prId = resolvePrId(from: trimmed) {
        SyncService.shared?.requestedPrNavigation = PrNavigationRequest(
          prId: prId,
          prNumber: prNumber ?? Int(trimmed),
          detailTab: detailTab,
          accountMachineKey: scopedAccountMachineKey,
          eventId: scopedEventId
        )
      } else if let prNumber = Int(trimmed), prNumber > 0 {
        SyncService.shared?.requestedPrNavigation = PrNavigationRequest(
          prNumber: prNumber,
          detailTab: detailTab,
          accountMachineKey: scopedAccountMachineKey,
          eventId: scopedEventId
        )
      }
    }
  }

  private func prDetailTab(from url: URL) -> PrDetailTab? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return nil
    }
    return prDetailTab(
      from: components.queryItems?.first(where: { $0.name.lowercased() == "tab" })?.value
    )
  }

  private func accountMachineKey(from url: URL) -> String? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return nil
    }
    let value = ADEDeepLinkURLParsing.adeQueryValues(from: components)["accountmachinekey"]
    guard ADEDeepLinkURLParsing.isValidOpaqueId(value) else { return nil }
    return value
  }

  private func eventId(from url: URL) -> String? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return nil
    }
    let value = ADEDeepLinkURLParsing.adeQueryValues(from: components)["event"]
    guard ADEDeepLinkURLParsing.isValidOpaqueId(value) else { return nil }
    return value
  }

  private func prDetailTab(from rawValue: String?) -> PrDetailTab? {
    switch rawValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "overview", "activity":
      return .overview
    case "files":
      return .files
    case "checks":
      return .checks
    default:
      return nil
    }
  }

  private func sessionNavigationScope(
    from url: URL
  ) -> (
    laneId: String?,
    repoOwner: String?,
    repoName: String?,
    branch: String?,
    accountMachineKey: String?,
    itemId: String?,
    eventId: String?,
    event: Int?,
    offset: Int?
  )? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return nil
    }
    return sessionNavigationScope(from: ADEDeepLinkURLParsing.adeQueryValues(from: components))
  }

  private func sessionNavigationScope(
    from query: [String: String]
  ) -> (
    laneId: String?,
    repoOwner: String?,
    repoName: String?,
    branch: String?,
    accountMachineKey: String?,
    itemId: String?,
    eventId: String?,
    event: Int?,
    offset: Int?
  )? {
    if let lane = query["lane"], !ADEDeepLinkURLParsing.isValidUUID(lane) {
      return nil
    }
    let repo = ADEDeepLinkURLParsing.splitRepo(query["repo"])
    if query["repo"] != nil && repo == nil { return nil }
    if let branch = query["branch"], !ADEDeepLinkURLParsing.isValidBranch(branch) {
      return nil
    }
    if let accountMachineKey = query["accountmachinekey"],
       !ADEDeepLinkURLParsing.isValidOpaqueId(accountMachineKey) {
      return nil
    }
    if let itemId = query["item"],
       !ADEDeepLinkURLParsing.isValidOpaqueId(itemId) {
      return nil
    }
    let rawEvent = query["event"]
    let event = ADEDeepLinkURLParsing.nonNegativeInteger(rawEvent)
    let eventId: String?
    if event == nil, let rawEvent {
      guard ADEDeepLinkURLParsing.isValidOpaqueId(rawEvent) else { return nil }
      eventId = rawEvent
    } else {
      eventId = nil
    }
    let offset = ADEDeepLinkURLParsing.nonNegativeInteger(query["offset"])
    if query["offset"] != nil && offset == nil { return nil }
    return (
      laneId: query["lane"],
      repoOwner: repo?.owner,
      repoName: repo?.repo,
      branch: query["branch"],
      accountMachineKey: query["accountmachinekey"],
      itemId: query["item"],
      eventId: eventId,
      event: event,
      offset: offset
    )
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
