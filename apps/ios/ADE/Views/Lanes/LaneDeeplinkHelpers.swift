import Foundation

enum LaneDeeplinkHelpers {
  static func laneLink(
    laneId: String,
    envelope: ADEDeeplinkEnvelope? = nil,
    form: ADEDeeplinkForm = .ade
  ) -> String {
    switch form {
    case .ade:
      let base = "ade://lane/\(ADEDeepLinkURLParsing.encodedPathSegment(laneId))"
      return appendQuery(to: base, items: envelopeItems(envelope))
    case .https:
      return httpsOpenURL(items: [("type", "lane"), ("id", laneId)] + envelopeItems(envelope))
    }
  }

  static func sessionLink(
    sessionId: String,
    laneId: String?,
    envelope: ADEDeeplinkEnvelope? = nil,
    event: Int? = nil,
    offset: Int? = nil,
    form: ADEDeeplinkForm = .https
  ) -> String {
    switch form {
    case .ade:
      let base = "ade://session/\(ADEDeepLinkURLParsing.encodedPathSegment(sessionId))"
      return appendQuery(
        to: base,
        items: sessionItems(laneId: laneId, event: event, offset: offset) + envelopeItems(envelope)
      )
    case .https:
      return httpsOpenURL(
        items: [("type", "session"), ("id", sessionId)]
          + sessionItems(laneId: laneId, event: event, offset: offset)
          + envelopeItems(envelope)
      )
    }
  }

  static func branchLink(
    repoOwner: String,
    repoName: String,
    branch: String,
    prNumber: Int? = nil,
    form: ADEDeeplinkForm = .https
  ) -> String {
    switch form {
    case .ade:
      let base = [
        "ade://repo",
        ADEDeepLinkURLParsing.encodedPathSegment(repoOwner),
        ADEDeepLinkURLParsing.encodedPathSegment(repoName),
        "branch",
        ADEDeepLinkURLParsing.encodedPath(branch),
      ].joined(separator: "/")
      return appendQuery(to: base, items: [("pr", prNumber.map(String.init))])
    case .https:
      return httpsOpenURL(
        items: [
          ("type", "branch"),
          ("repo", "\(repoOwner)/\(repoName)"),
          ("branch", branch),
          ("pr", prNumber.map(String.init)),
        ]
      )
    }
  }

  static func prLink(
    repoOwner: String,
    repoName: String,
    number: Int,
    form: ADEDeeplinkForm = .https
  ) -> String {
    switch form {
    case .ade:
      return [
        "ade://pr",
        ADEDeepLinkURLParsing.encodedPathSegment(repoOwner),
        ADEDeepLinkURLParsing.encodedPathSegment(repoName),
        String(number),
      ].joined(separator: "/")
    case .https:
      return httpsOpenURL(
        items: [
          ("type", "pr"),
          ("repo", "\(repoOwner)/\(repoName)"),
          ("number", String(number)),
        ]
      )
    }
  }

  static func envelope(
    lane: LaneSummary?,
    pullRequest: PullRequestListItem?
  ) -> ADEDeeplinkEnvelope? {
    let branch = lane.map { normalizedPrBranchName($0.branchRef) }?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let issue = lane.flatMap(primaryLaneLinearIssue(for:))?.identifier
    return envelope(
      repoOwner: pullRequest?.repoOwner,
      repoName: pullRequest?.repoName,
      branch: branch,
      prNumber: pullRequest?.githubPrNumber,
      linearIssue: issue
    )
  }

  static func envelope(
    repoOwner: String? = nil,
    repoName: String? = nil,
    branch: String? = nil,
    prNumber: Int? = nil,
    linearIssue: String? = nil
  ) -> ADEDeeplinkEnvelope? {
    var envelope = ADEDeeplinkEnvelope()
    let owner = repoOwner?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let repo = repoName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if ADEDeepLinkURLParsing.splitRepo("\(owner)/\(repo)") != nil {
      envelope.repoOwner = owner
      envelope.repoName = repo
    }
    let branch = branch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if ADEDeepLinkURLParsing.isValidBranch(branch) {
      envelope.branch = branch
    }
    if let prNumber, prNumber > 0 {
      envelope.prNumber = prNumber
    }
    let linearIssue = linearIssue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if ADEDeepLinkURLParsing.isValidLinearIdentifier(linearIssue) {
      envelope.linearIssue = linearIssue
    }
    return envelope.isEmpty ? nil : envelope
  }

  private static func sessionItems(laneId: String?, event: Int?, offset: Int?) -> [(String, String?)] {
    [
      ("lane", laneId?.trimmingCharacters(in: .whitespacesAndNewlines)),
      ("event", event.map(String.init)),
      ("offset", offset.map(String.init)),
    ]
  }

  private static func envelopeItems(_ envelope: ADEDeeplinkEnvelope?) -> [(String, String?)] {
    [
      ("repo", envelope?.repoSlug),
      ("branch", envelope?.branch),
      ("pr", envelope?.prNumber.map(String.init)),
      ("linear", envelope?.linearIssue),
    ]
  }

  private static func httpsOpenURL(items: [(String, String?)]) -> String {
    appendQuery(to: "https://ade-app.dev/open", items: items)
  }

  private static func appendQuery(to base: String, items: [(String, String?)]) -> String {
    let query = ADEDeepLinkURLParsing.queryString(items)
    return query.isEmpty ? base : "\(base)?\(query)"
  }
}
