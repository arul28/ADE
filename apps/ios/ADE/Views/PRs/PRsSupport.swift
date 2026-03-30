import Foundation
import SwiftUI

private let prIsoFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

private let prIsoFallbackFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter
}()

enum PrTopLevelSurface: String, CaseIterable, Identifiable {
  case github
  case workflows

  var id: String { rawValue }

  var title: String {
    switch self {
    case .github: return "GitHub"
    case .workflows: return "Workflows"
    }
  }
}

enum PrWorkflowCategory: String, CaseIterable, Identifiable {
  case integration
  case queue
  case rebase

  var id: String { rawValue }

  var title: String {
    switch self {
    case .integration: return "Integration"
    case .queue: return "Queue"
    case .rebase: return "Rebase"
    }
  }
}

enum PrWorkflowView: String, CaseIterable, Identifiable {
  case active
  case history

  var id: String { rawValue }

  var title: String {
    switch self {
    case .active: return "Active"
    case .history: return "History"
    }
  }
}

struct PrActionAvailability: Equatable {
  let showsMerge: Bool
  let mergeEnabled: Bool
  let showsClose: Bool
  let showsReopen: Bool
  let showsRequestReviewers: Bool

  init(prState: String) {
    switch prState {
    case "open":
      showsMerge = true
      mergeEnabled = true
      showsClose = true
      showsReopen = false
      showsRequestReviewers = true
    case "draft":
      showsMerge = true
      mergeEnabled = false
      showsClose = false
      showsReopen = false
      showsRequestReviewers = true
    case "closed":
      showsMerge = false
      mergeEnabled = false
      showsClose = false
      showsReopen = true
      showsRequestReviewers = false
    default:
      showsMerge = false
      mergeEnabled = false
      showsClose = false
      showsReopen = false
      showsRequestReviewers = false
    }
  }
}

enum PrListStateFilter: String, CaseIterable, Identifiable {
  case all
  case open
  case draft
  case merged
  case closed

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .open: return "Open"
    case .draft: return "Draft"
    case .merged: return "Merged"
    case .closed: return "Closed"
    }
  }
}

enum PrListSortOption: String, CaseIterable, Identifiable {
  case updated
  case created
  case title

  var id: String { rawValue }

  var title: String {
    switch self {
    case .updated: return "Updated"
    case .created: return "Created"
    case .title: return "Title"
    }
  }
}

enum PrMergeMethodOption: String, CaseIterable, Identifiable {
  case squash
  case merge
  case rebase

  var id: String { rawValue }

  var title: String {
    switch self {
    case .squash: return "Squash and merge"
    case .merge: return "Merge commit"
    case .rebase: return "Rebase and merge"
    }
  }

  var shortTitle: String {
    switch self {
    case .squash: return "Squash"
    case .merge: return "Merge"
    case .rebase: return "Rebase"
    }
  }

  var description: String {
    switch self {
    case .squash:
      return "Combine all commits into one tidy commit on the base branch."
    case .merge:
      return "Preserve the full branch history with a merge commit."
    case .rebase:
      return "Replay commits onto the base branch for linear history."
    }
  }
}

enum PrDetailTab: String, CaseIterable, Identifiable {
  case overview
  case files
  case checks
  case activity

  var id: String { rawValue }

  var title: String {
    switch self {
    case .overview: return "Overview"
    case .files: return "Files"
    case .checks: return "Checks"
    case .activity: return "Activity"
    }
  }
}

enum PrCleanupChoice {
  case archive
  case deleteBranch
}

struct PullRequestSearchContext: Equatable {
  var authorLogin: String?
}

struct PrGitHubSections: Equatable {
  var repoPullRequests: [PullRequestListItem]
  var externalPullRequests: [PullRequestListItem]
}

struct PrWorkflowCollections: Equatable {
  var integrations: [IntegrationProposal]
  var queues: [QueueLandingState]
  var rebaseItems: [PrRebaseWorkflowItem]
}

struct PrRebaseWorkflowItem: Identifiable, Equatable {
  let laneId: String
  let laneName: String
  let branchRef: String
  let behindCount: Int
  let severity: String
  let statusMessage: String
  let deferredUntil: String?

  var id: String { laneId }
}

func pullRequestStateCounts(_ items: [PullRequestListItem]) -> [PrListStateFilter: Int] {
  var counts: [PrListStateFilter: Int] = [.all: items.count]
  for filter in PrListStateFilter.allCases where filter != .all {
    counts[filter] = items.filter { pullRequestMatchesState($0, state: filter) }.count
  }
  return counts
}

func filterPullRequestListItems(
  _ items: [PullRequestListItem],
  query: String,
  state: PrListStateFilter,
  contexts: [String: PullRequestSearchContext] = [:]
) -> [PullRequestListItem] {
  let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

  return items.filter { item in
    guard pullRequestMatchesState(item, state: state) else { return false }
    guard !normalizedQuery.isEmpty else { return true }

    let authorLogin = contexts[item.id]?.authorLogin ?? ""
    let haystack = [
      item.title,
      authorLogin,
      item.headBranch,
      item.baseBranch,
      item.laneName ?? "",
      item.repoOwner,
      item.repoName,
      "#\(item.githubPrNumber)",
    ]
      .joined(separator: " ")
      .lowercased()

    return haystack.contains(normalizedQuery)
  }
}

func sortPullRequestListItems(_ items: [PullRequestListItem], option: PrListSortOption) -> [PullRequestListItem] {
  items.sorted { lhs, rhs in
    switch option {
    case .updated:
      return comparePullRequests(lhs, rhs, lhsDate: prParsedDate(lhs.updatedAt), rhsDate: prParsedDate(rhs.updatedAt))
    case .created:
      return comparePullRequests(lhs, rhs, lhsDate: prParsedDate(lhs.createdAt), rhsDate: prParsedDate(rhs.createdAt))
    case .title:
      let comparison = lhs.title.localizedCaseInsensitiveCompare(rhs.title)
      if comparison == .orderedSame {
        return comparePullRequests(lhs, rhs, lhsDate: prParsedDate(lhs.updatedAt), rhsDate: prParsedDate(rhs.updatedAt))
      }
      return comparison == .orderedAscending
    }
  }
}

func partitionGitHubPullRequests(_ items: [PullRequestListItem]) -> PrGitHubSections {
  let partitions = items.reduce(into: (repo: [PullRequestListItem](), external: [PullRequestListItem]())) { result, item in
    if item.laneId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (item.laneName?.isEmpty ?? true) {
      result.external.append(item)
    } else {
      result.repo.append(item)
    }
  }

  return PrGitHubSections(repoPullRequests: partitions.repo, externalPullRequests: partitions.external)
}

func buildRebaseWorkflowItems(from snapshots: [LaneListSnapshot]) -> [PrRebaseWorkflowItem] {
  snapshots.compactMap { snapshot in
    guard let suggestion = snapshot.rebaseSuggestion else { return nil }
    let statusMessage = snapshot.autoRebaseStatus?.message
      ?? "\(snapshot.lane.name) is \(suggestion.behindCount) commit\(suggestion.behindCount == 1 ? "" : "s") behind its parent lane."

    let severity: String
    if snapshot.autoRebaseStatus?.state == "rebaseConflict" {
      severity = "critical"
    } else if suggestion.behindCount >= 10 {
      severity = "warning"
    } else {
      severity = "info"
    }

    return PrRebaseWorkflowItem(
      laneId: snapshot.lane.id,
      laneName: snapshot.lane.name,
      branchRef: snapshot.lane.branchRef,
      behindCount: suggestion.behindCount,
      severity: severity,
      statusMessage: statusMessage,
      deferredUntil: suggestion.deferredUntil
    )
  }
  .sorted { lhs, rhs in
    if lhs.severity == rhs.severity {
      return lhs.behindCount > rhs.behindCount
    }
    return severityRank(lhs.severity) < severityRank(rhs.severity)
  }
}

func partitionWorkflowCollections(
  integrations: [IntegrationProposal],
  queues: [QueueLandingState],
  rebaseItems: [PrRebaseWorkflowItem],
  laneSnapshots: [LaneListSnapshot],
  view: PrWorkflowView,
  now: Date = Date()
) -> PrWorkflowCollections {
  let integrationItems = integrations.filter { proposal in
    switch view {
    case .active:
      return proposal.workflowDisplayState != "history"
    case .history:
      return proposal.workflowDisplayState == "history"
    }
  }

  let queueItems = queues.filter { queue in
    let isHistory = queue.state == "completed" || queue.state == "cancelled"
    return view == .active ? !isHistory : isHistory
  }

  let snapshotByLaneId = Dictionary(uniqueKeysWithValues: laneSnapshots.map { ($0.lane.id, $0) })
  let rebaseFiltered = rebaseItems.filter { item in
    let suggestion = snapshotByLaneId[item.laneId]?.rebaseSuggestion
    let dismissed = suggestion?.dismissedAt != nil
    let behindCount = suggestion?.behindCount ?? item.behindCount
    let deferredUntil = suggestion?.deferredUntil.flatMap(prParsedDate)
    let deferredIntoFuture = deferredUntil.map { $0 > now } ?? false
    let isHistory = dismissed || deferredIntoFuture || behindCount == 0
    return view == .active ? !isHistory : isHistory
  }

  return PrWorkflowCollections(
    integrations: integrationItems,
    queues: queueItems,
    rebaseItems: rebaseFiltered
  )
}

enum PrDiffDisplayLineKind: Equatable {
  case hunk
  case context
  case added
  case removed
  case note
}

struct PrDiffDisplayLine: Identifiable, Equatable {
  let id: Int
  let kind: PrDiffDisplayLineKind
  let prefix: String
  let text: String
  let oldLineNumber: Int?
  let newLineNumber: Int?
}

func parsePullRequestPatch(_ patch: String) -> [PrDiffDisplayLine] {
  guard !patch.isEmpty else { return [] }

  let headerRegex = try? NSRegularExpression(pattern: #"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#)
  var oldLineNumber = 0
  var newLineNumber = 0

  return patch.components(separatedBy: "\n").enumerated().map { index, line in
    if line.hasPrefix("@@") {
      if let headerRegex,
         let match = headerRegex.firstMatch(in: line, range: NSRange(location: 0, length: line.utf16.count)),
         match.numberOfRanges == 3,
         let oldRange = Range(match.range(at: 1), in: line),
         let newRange = Range(match.range(at: 2), in: line) {
        oldLineNumber = Int(line[oldRange]) ?? 0
        newLineNumber = Int(line[newRange]) ?? 0
      }
      return PrDiffDisplayLine(id: index, kind: .hunk, prefix: "@@", text: line, oldLineNumber: nil, newLineNumber: nil)
    }

    if line.hasPrefix("+") && !line.hasPrefix("+++") {
      let display = PrDiffDisplayLine(id: index, kind: .added, prefix: "+", text: String(line.dropFirst()), oldLineNumber: nil, newLineNumber: newLineNumber)
      newLineNumber += 1
      return display
    }

    if line.hasPrefix("-") && !line.hasPrefix("---") {
      let display = PrDiffDisplayLine(id: index, kind: .removed, prefix: "-", text: String(line.dropFirst()), oldLineNumber: oldLineNumber, newLineNumber: nil)
      oldLineNumber += 1
      return display
    }

    if line.hasPrefix(" ") {
      let display = PrDiffDisplayLine(id: index, kind: .context, prefix: " ", text: String(line.dropFirst()), oldLineNumber: oldLineNumber, newLineNumber: newLineNumber)
      oldLineNumber += 1
      newLineNumber += 1
      return display
    }

    return PrDiffDisplayLine(id: index, kind: .note, prefix: "", text: line, oldLineNumber: nil, newLineNumber: nil)
  }
}

enum PrTimelineEventKind: Equatable {
  case stateChange
  case review
  case comment
  case commit
  case ciRun
  case reviewRequest
  case deployment
  case forcePush
  case labelUpdate
}

struct PrTimelineEvent: Identifiable, Equatable {
  let id: String
  let rawType: String
  let kind: PrTimelineEventKind
  let badgeText: String
  let title: String
  let author: String?
  let avatarUrl: String?
  let body: String?
  let timestamp: String
  let metadata: String?
  let commentId: String?
  let commentSource: String?
  let commentUrl: String?
  let canReply: Bool
  let canEdit: Bool
  let canDelete: Bool
}

func buildPullRequestTimeline(pr: PullRequestListItem, snapshot: PullRequestSnapshot) -> [PrTimelineEvent] {
  var events: [PrTimelineEvent] = [
    PrTimelineEvent(
      id: "state-opened-\(pr.id)",
      rawType: "state_change",
      kind: .stateChange,
      badgeText: timelineBadgeText(for: "state_change"),
      title: pr.state == "draft" ? "Draft opened" : "Opened",
      author: snapshot.detail?.author.login,
      avatarUrl: snapshot.detail?.author.avatarUrl,
      body: nil,
      timestamp: pr.createdAt,
      metadata: "\(pr.headBranch) → \(pr.baseBranch)",
      commentId: nil,
      commentSource: nil,
      commentUrl: nil,
      canReply: false,
      canEdit: false,
      canDelete: false
    )
  ]

  for review in snapshot.reviews {
    events.append(
      PrTimelineEvent(
        id: "review-\(review.id)",
        rawType: "review",
        kind: .review,
        badgeText: timelineBadgeText(for: "review"),
        title: titleCase(review.state.replacingOccurrences(of: "_", with: " ")),
        author: review.reviewer,
        avatarUrl: review.reviewerAvatarUrl,
        body: review.body,
        timestamp: review.submittedAt ?? pr.updatedAt,
        metadata: nil,
        commentId: nil,
        commentSource: nil,
        commentUrl: nil,
        canReply: false,
        canEdit: false,
        canDelete: false
      )
    )
  }

  for comment in snapshot.comments {
    let locationText: String?
    if let path = comment.path, let line = comment.line {
      locationText = "\(path):\(line)"
    } else {
      locationText = comment.path
    }

    events.append(
      PrTimelineEvent(
        id: "comment-\(comment.id)",
        rawType: "comment",
        kind: .comment,
        badgeText: timelineBadgeText(for: "comment"),
        title: comment.source == "review" ? "Review comment" : "Comment",
        author: comment.author,
        avatarUrl: comment.authorAvatarUrl,
        body: comment.body,
        timestamp: comment.updatedAt ?? comment.createdAt ?? pr.updatedAt,
        metadata: locationText,
        commentId: comment.id,
        commentSource: comment.source,
        commentUrl: comment.url,
        canReply: true,
        canEdit: false,
        canDelete: false
      )
    )
  }

  let finalState = snapshot.status?.state ?? pr.state
  if finalState == "merged" || finalState == "closed" {
    events.append(
      PrTimelineEvent(
        id: "state-final-\(pr.id)-\(finalState)",
        rawType: "state_change",
        kind: .stateChange,
        badgeText: timelineBadgeText(for: "state_change"),
        title: finalState == "merged" ? "Merged" : "Closed",
        author: nil,
        avatarUrl: nil,
        body: nil,
        timestamp: pr.updatedAt,
        metadata: nil,
        commentId: nil,
        commentSource: nil,
        commentUrl: nil,
        canReply: false,
        canEdit: false,
        canDelete: false
      )
    )
  }

  return events.sorted { lhs, rhs in
    (prParsedDate(lhs.timestamp) ?? .distantPast) > (prParsedDate(rhs.timestamp) ?? .distantPast)
  }
}

func buildPullRequestTimeline(activityEvents: [PrActivityEvent]) -> [PrTimelineEvent] {
  activityEvents
    .map { event in
      let rawType = event.type
      let commentId = timelineCommentId(for: event)
      let commentSource = remoteJSONString(event.metadata, key: "source")
      let commentUrl = remoteJSONString(event.metadata, key: "url")
      let canEdit = remoteJSONBool(event.metadata, key: "viewerCanEdit") ?? false
      return PrTimelineEvent(
        id: event.id,
        rawType: rawType,
        kind: timelineKind(for: rawType),
        badgeText: timelineBadgeText(for: rawType),
        title: timelineTitle(for: rawType, metadata: event.metadata),
        author: event.author,
        avatarUrl: event.avatarUrl,
        body: event.body,
        timestamp: event.timestamp,
        metadata: summarizeTimelineMetadata(event.metadata),
        commentId: commentId,
        commentSource: commentSource,
        commentUrl: commentUrl,
        canReply: rawType == "comment" && commentId != nil,
        canEdit: rawType == "comment" && canEdit,
        canDelete: rawType == "comment" && canEdit
      )
    }
    .sorted { lhs, rhs in
      (prParsedDate(lhs.timestamp) ?? .distantPast) > (prParsedDate(rhs.timestamp) ?? .distantPast)
    }
}

private func timelineKind(for rawType: String) -> PrTimelineEventKind {
  switch rawType {
  case "comment":
    return .comment
  case "review":
    return .review
  case "commit":
    return .commit
  case "ci_run":
    return .ciRun
  case "review_request":
    return .reviewRequest
  case "deployment":
    return .deployment
  case "force_push":
    return .forcePush
  case "label":
    return .labelUpdate
  default:
    return .stateChange
  }
}

private func timelineBadgeText(for rawType: String) -> String {
  switch rawType {
  case "ci_run":
    return "CI run"
  case "review_request":
    return "Review requested"
  case "force_push":
    return "Force push"
  case "deployment":
    return "Deployment"
  case "commit":
    return "Commit"
  case "label":
    return "Label"
  case "state_change":
    return "State"
  default:
    return titleCase(rawType.replacingOccurrences(of: "_", with: " "))
  }
}

private func timelineTitle(for rawType: String, metadata: [String: RemoteJSONValue]) -> String {
  switch rawType {
  case "comment":
    return remoteJSONString(metadata, key: "source") == "review" ? "Review comment" : "Comment"
  case "review":
    if let state = remoteJSONString(metadata, key: "state"), !state.isEmpty {
      return titleCase(state)
    }
    return "Review"
  case "ci_run":
    return "Check run"
  case "state_change":
    return "State change"
  case "review_request":
    return "Review requested"
  case "force_push":
    return "Force push"
  case "deployment":
    return "Deployment"
  case "commit":
    return "Commit"
  case "label":
    return "Label update"
  default:
    return titleCase(rawType.replacingOccurrences(of: "_", with: " "))
  }
}

private func summarizeTimelineMetadata(_ metadata: [String: RemoteJSONValue]) -> String? {
  guard !metadata.isEmpty else { return nil }
  let hiddenKeys = Set(["commentId", "viewerCanEdit", "url"])
  let parts = metadata
    .sorted { $0.key < $1.key }
    .compactMap { key, value -> String? in
      guard !hiddenKeys.contains(key) else { return nil }
      let rendered = renderRemoteJSONValue(value)
      return rendered.isEmpty ? nil : "\(key): \(rendered)"
    }
  return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

private func remoteJSONString(_ metadata: [String: RemoteJSONValue], key: String) -> String? {
  guard let value = metadata[key] else { return nil }
  guard case .string(let stringValue) = value, !stringValue.isEmpty else { return nil }
  return stringValue
}

private func remoteJSONBool(_ metadata: [String: RemoteJSONValue], key: String) -> Bool? {
  guard let value = metadata[key] else { return nil }
  guard case .bool(let boolValue) = value else { return nil }
  return boolValue
}

private func timelineCommentId(for event: PrActivityEvent) -> String? {
  if let explicit = remoteJSONString(event.metadata, key: "commentId") {
    return explicit
  }
  guard event.type == "comment", event.id.hasPrefix("comment-") else { return nil }
  return String(event.id.dropFirst("comment-".count))
}

private func renderRemoteJSONValue(_ value: RemoteJSONValue) -> String {
  switch value {
  case .string(let value):
    return value
  case .number(let value):
    if value.rounded() == value {
      return String(Int(value))
    }
    return String(value)
  case .bool(let value):
    return value ? "true" : "false"
  case .null:
    return ""
  case .array(let values):
    return values.map(renderRemoteJSONValue).filter { !$0.isEmpty }.joined(separator: ", ")
  case .object(let object):
    return object
      .sorted { $0.key < $1.key }
      .compactMap { key, value -> String? in
        let rendered = renderRemoteJSONValue(value)
        return rendered.isEmpty ? nil : "\(key)=\(rendered)"
      }
      .joined(separator: ", ")
  }
}


private func pullRequestMatchesState(_ item: PullRequestListItem, state: PrListStateFilter) -> Bool {
  switch state {
  case .all:
    return true
  case .open:
    return item.state == "open"
  case .draft:
    return item.state == "draft"
  case .merged:
    return item.state == "merged"
  case .closed:
    return item.state == "closed"
  }
}

private func comparePullRequests(
  _ lhs: PullRequestListItem,
  _ rhs: PullRequestListItem,
  lhsDate: Date?,
  rhsDate: Date?
) -> Bool {
  switch (lhsDate, rhsDate) {
  case let (left?, right?):
    if left != right {
      return left > right
    }
  case (_?, nil):
    return true
  case (nil, _?):
    return false
  case (nil, nil):
    break
  }

  if lhs.githubPrNumber != rhs.githubPrNumber {
    return lhs.githubPrNumber > rhs.githubPrNumber
  }
  return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
}
