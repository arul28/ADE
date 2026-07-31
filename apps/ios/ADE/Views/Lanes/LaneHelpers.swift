import SwiftUI

// MARK: - Utility functions

@ViewBuilder
func lanePriorityBadge(snapshot: LaneListSnapshot) -> some View {
  if snapshot.autoRebaseStatus?.state == "rebaseConflict" {
    LaneTypeBadge(text: "Conflict", tint: ADEColor.danger)
  } else if snapshot.lane.status.dirty {
    LaneTypeBadge(text: "Dirty", tint: ADEColor.warning)
  } else if snapshot.runtime.bucket == "running" {
    LaneTypeBadge(text: "Running", tint: ADEColor.success)
  } else if snapshot.runtime.bucket == "awaiting-input" {
    LaneTypeBadge(text: "Attention", tint: ADEColor.warning)
  } else if snapshot.lane.archivedAt != nil {
    LaneTypeBadge(text: "Archived", tint: ADEColor.textMuted)
  } else if let rebaseSuggestion = snapshot.rebaseSuggestion {
    LaneTypeBadge(text: "\(rebaseSuggestion.behindCount)\u{2193}", tint: ADEColor.warning)
  } else {
    EmptyView()
  }
}

func laneActivitySummary(_ snapshot: LaneListSnapshot) -> String? {
  if let agentText = summarizeState(snapshot.stateSnapshot?.agentSummary) {
    return agentText
  }
  return nil
}

func primaryLaneLinearIssue(for lane: LaneSummary) -> LaneLinearIssue? {
  if let issue = lane.linearIssue {
    return issue
  }
  return lane.linearIssueLinks?
    .sorted { lhs, rhs in
      let lhsRank = laneLinearIssueLinkRoleRank(lhs.role)
      let rhsRank = laneLinearIssueLinkRoleRank(rhs.role)
      if lhsRank != rhsRank { return lhsRank < rhsRank }
      return lhs.updatedAt > rhs.updatedAt
    }
    .first?
    .issue
}

func laneLinearIssueLinkCount(for lane: LaneSummary) -> Int {
  lane.linearIssueLinks?.count ?? (lane.linearIssue == nil ? 0 : 1)
}

private func laneLinearIssueLinkRoleRank(_ role: String) -> Int {
  switch role {
  case "primary": return 0
  case "worked": return 1
  case "referenced": return 2
  case "inferred": return 3
  default: return 4
  }
}

func laneListFilteredSnapshots(
  _ snapshots: [LaneListSnapshot],
  scope: LaneListScope,
  runtimeFilter: LaneRuntimeFilter,
  searchText: String,
  pinnedLaneIds: Set<String>
) -> [LaneListSnapshot] {
  snapshots
    .filter { snapshot in
      switch scope {
      case .active:
        return snapshot.lane.archivedAt == nil
      case .archived:
        return snapshot.lane.archivedAt != nil
      case .all:
        return true
      }
    }
    .filter { snapshot in
      runtimeFilter == .all || snapshot.runtime.bucket == runtimeFilter.rawValue
    }
    .filter { snapshot in
      laneMatchesSearch(snapshot: snapshot, isPinned: pinnedLaneIds.contains(snapshot.lane.id), query: searchText)
    }
    .sorted(by: laneListSortSnapshots)
}

private func parseLaneTimestamp(_ rawValue: String) -> Date? {
  cachedISO8601Formatter.date(from: rawValue) ?? cachedISO8601FormatterNoFractional.date(from: rawValue)
}

func laneListSortSnapshots(_ lhs: LaneListSnapshot, _ rhs: LaneListSnapshot) -> Bool {
  if lhs.lane.laneType == "primary" && rhs.lane.laneType != "primary" { return true }
  if lhs.lane.laneType != "primary" && rhs.lane.laneType == "primary" { return false }
  if let ld = parseLaneTimestamp(lhs.lane.createdAt), let rd = parseLaneTimestamp(rhs.lane.createdAt), ld != rd {
    return ld > rd
  }
  if lhs.lane.createdAt != rhs.lane.createdAt {
    return lhs.lane.createdAt > rhs.lane.createdAt
  }
  if lhs.lane.name.localizedCaseInsensitiveCompare(rhs.lane.name) != .orderedSame {
    return lhs.lane.name.localizedCaseInsensitiveCompare(rhs.lane.name) == .orderedAscending
  }
  return lhs.lane.id < rhs.lane.id
}

func laneScopeCount(_ snapshots: [LaneListSnapshot], scope: LaneListScope) -> Int {
  snapshots.filter { snapshot in
    switch scope {
    case .active:
      return snapshot.lane.archivedAt == nil
    case .archived:
      return snapshot.lane.archivedAt != nil
    case .all:
      return true
    }
  }.count
}

func laneRuntimeCount(_ snapshots: [LaneListSnapshot], filter: LaneRuntimeFilter) -> Int {
  if filter == .all {
    return snapshots.count
  }
  return snapshots.filter { $0.runtime.bucket == filter.rawValue }.count
}

func laneListEmptyStateTitle(scope: LaneListScope) -> String {
  switch scope {
  case .active: return "No active lanes"
  case .archived: return "No archived lanes"
  case .all: return "No lanes"
  }
}

func laneListEmptyStateMessage(scope: LaneListScope, searchText: String, hasFilters: Bool) -> String {
  if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return "Try a different search or clear the filter."
  }
  if hasFilters {
    return "Try clearing the current filters."
  }
  switch scope {
  case .active: return "Create a new lane or connect to a machine."
  case .archived: return "Archived lanes will appear here."
  case .all: return "No lanes yet. Create a lane or connect to a machine."
  }
}

func laneMatchesSearch(snapshot: LaneListSnapshot, isPinned: Bool, query: String) -> Bool {
  let tokens = query
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .split(whereSeparator: \.isWhitespace)
    .map(String.init)
  guard !tokens.isEmpty else { return true }
  return tokens.allSatisfy { token in
    matchesLaneToken(snapshot: snapshot, isPinned: isPinned, token: token)
  }
}

func matchesLaneToken(snapshot: LaneListSnapshot, isPinned: Bool, token: String) -> Bool {
  if token.hasPrefix("is:") {
    switch String(token.dropFirst(3)) {
    case "dirty": return snapshot.lane.status.dirty
    case "clean": return !snapshot.lane.status.dirty
    case "pinned": return isPinned
    case "primary": return snapshot.lane.laneType == "primary"
    case "worktree": return snapshot.lane.laneType == "worktree"
    case "attached": return snapshot.lane.laneType == "attached"
    default: return false
    }
  }
  if token.hasPrefix("type:") {
    return snapshot.lane.laneType.lowercased() == String(token.dropFirst(5))
  }
  let indexed = [
    snapshot.lane.name,
    snapshot.lane.branchRef,
    snapshot.lane.baseRef,
    snapshot.lane.laneType,
    snapshot.lane.description ?? "",
    snapshot.lane.worktreePath,
    primaryLaneLinearIssue(for: snapshot.lane).map { "\($0.identifier) \($0.title) \($0.projectName ?? "") \($0.teamKey ?? "") \($0.stateName ?? "")" } ?? "",
    snapshot.lane.linearIssueLinks?.map { "\($0.issue.identifier) \($0.issue.title) \($0.role) \($0.source)" }.joined(separator: " ") ?? "",
    snapshot.lane.archivedAt == nil ? "active" : "archived",
    snapshot.lane.status.dirty ? "dirty modified changed" : "clean",
    "ahead \(snapshot.lane.status.ahead)",
    "behind \(snapshot.lane.status.behind)",
    "\(snapshot.lane.status.ahead)",
    "\(snapshot.lane.status.behind)",
    snapshot.runtime.bucket,
    "\(snapshot.runtime.sessionCount)",
    summarizeState(snapshot.stateSnapshot?.agentSummary) ?? "",
    isPinned ? "pinned" : "",
  ].joined(separator: " ").lowercased()
  return indexed.contains(token)
}

func summarizeState(_ summary: [String: RemoteJSONValue]?) -> String? {
  guard let summary else { return nil }
  let preferredKeys = [
    "summary", "status", "state", "label", "title", "objective",
    "stepLabel", "step", "name", "agent", "agentName", "assignee",
  ]
  for key in preferredKeys {
    if let value = flattenedString(summary[key]) {
      return value
    }
  }
  for key in summary.keys.sorted() {
    if let flattened = flattenedString(summary[key]) {
      return flattened
    }
  }
  return nil
}

func flattenedString(_ value: RemoteJSONValue?) -> String? {
  guard let value else { return nil }
  switch value {
  case .string(let string):
    return string
  case .number(let number):
    return String(number)
  case .bool(let bool):
    return bool ? "true" : "false"
  case .array(let values):
    return values.compactMap(flattenedString).first
  case .object(let object):
    return summarizeState(object)
  case .null:
    return nil
  }
}

func laneStackGraphOrder(_ snapshots: [LaneListSnapshot]) -> [LaneListSnapshot] {
  let childrenByParent = Dictionary(grouping: snapshots) { snapshot in
    snapshot.lane.parentLaneId ?? "__root__"
  }
  let primaryId = snapshots.first(where: { $0.lane.laneType == "primary" })?.lane.id

  func visit(parentId: String?) -> [LaneListSnapshot] {
    let key = parentId ?? "__root__"
    let children = (childrenByParent[key] ?? []).sorted { lhs, rhs in
      lhs.lane.createdAt < rhs.lane.createdAt
    }
    return children.flatMap { child in
      [child] + visit(parentId: child.lane.id)
    }
  }

  let primaryBranch = primaryId.flatMap { id in snapshots.first(where: { $0.lane.id == id }) }.map { [$0] + visit(parentId: $0.lane.id) } ?? []
  let seen = Set(primaryBranch.map(\.lane.id))
  let remaining = snapshots.filter { !seen.contains($0.lane.id) }
  let remainingIds = Set(remaining.map(\.lane.id))
  let roots = remaining
    .filter { ($0.lane.parentLaneId == nil) || !remainingIds.contains($0.lane.parentLaneId!) }
    .sorted { $0.lane.createdAt < $1.lane.createdAt }
  let groupedRemaining = roots.flatMap { root in
    [root] + visit(parentId: root.lane.id).filter { remainingIds.contains($0.lane.id) }
  }
  return primaryBranch + groupedRemaining
}

func laneTreeDisplayDepth(for lane: LaneSummary) -> Int {
  max(0, lane.stackDepth)
}

func runtimeTint(bucket: String) -> Color {
  switch bucket {
  case "running":
    return ADEColor.success
  case "awaiting-input":
    return ADEColor.warning
  case "ended":
    return ADEColor.textMuted
  default:
    return ADEColor.textSecondary
  }
}

func lanePullRequestTint(_ state: String) -> Color {
  switch state {
  case "open":
    return ADEColor.success
  case "draft":
    return ADEColor.warning
  case "closed":
    return ADEColor.danger
  case "merged":
    return ADEColor.accent
  default:
    return ADEColor.textSecondary
  }
}

func lanePrStateRank(_ state: String) -> Int {
  switch state {
  case "open", "draft": return 0
  case "merged": return 1
  default: return 2
  }
}

/// Human label for a PR state, used by the Work tab indicator ("Open" / "Draft"
/// / "Closed" / "Merged"). Mirrors the desktop state captions.
func lanePrStateLabel(_ state: String) -> String {
  switch state {
  case "merged": return "Merged"
  case "closed": return "Closed"
  case "draft": return "Draft"
  default: return "Open"
  }
}

// MARK: - Unified lane PR tag
//
// A lane is a branch, and a branch can carry a PR that was opened either through
// ADE (mapped into the synced `pull_requests` table as `PullRequestListItem`) or
// directly on GitHub (surfaced via the `prs.getGitHubSnapshot` command as
// `GitHubPrListItem`). `LanePrTag` is the single shape both sources collapse
// into so the lane card chip and the Work tab indicator render identically
// regardless of provenance. This mirrors the desktop `selectLaneTabPrTag`
// merge in `lanePageModel.ts`.

enum LanePrTagSource: Equatable { case ade, github }

struct LanePrTag: Equatable {
  var source: LanePrTagSource
  /// ADE PR id when known (drives in-app navigation); nil for GitHub-only PRs.
  var prId: String?
  var githubPrNumber: Int
  var githubUrl: String
  var title: String
  /// "open" / "draft" / "closed" / "merged".
  var state: String
  var headBranch: String
  var updatedAt: String
  var stack: GitHubPrStackMembership? = nil
}

/// Common ordering signal shared by both PR sources so a single comparator ranks
/// either kind (open/draft first, then most-recently-updated, then highest #).
protocol LanePrComparable {
  var lanePrState: String { get }
  var lanePrUpdatedAt: String { get }
  var lanePrNumber: Int { get }
}

extension PullRequestListItem: LanePrComparable {
  var lanePrState: String { state }
  var lanePrUpdatedAt: String { updatedAt }
  var lanePrNumber: Int { githubPrNumber }
}

extension GitHubPrListItem: LanePrComparable {
  var lanePrState: String { isDraft ? "draft" : state }
  var lanePrUpdatedAt: String { updatedAt }
  var lanePrNumber: Int { githubPrNumber }
}

/// `true` when `a` should sort ahead of `b`.
func lanePrTagPrecedes(_ a: LanePrComparable, _ b: LanePrComparable) -> Bool {
  let byState = lanePrStateRank(a.lanePrState) - lanePrStateRank(b.lanePrState)
  if byState != 0 { return byState < 0 }
  if a.lanePrUpdatedAt != b.lanePrUpdatedAt { return a.lanePrUpdatedAt > b.lanePrUpdatedAt }
  return a.lanePrNumber > b.lanePrNumber
}

private func lanePrIsTerminalState(_ state: String) -> Bool {
  state == "merged" || state == "closed"
}

func lanePrMatchesCurrentBranch(lane: LaneSummary, pr: PullRequestListItem) -> Bool {
  guard pr.laneId == lane.id else { return false }
  let laneBranch = normalizedPrBranchName(lane.branchRef)
  let prHeadBranch = normalizedPrBranchName(pr.headBranch)
  guard !laneBranch.isEmpty, !prHeadBranch.isEmpty, laneBranch == prHeadBranch else { return false }
  if lane.laneType == "primary" {
    let baseBranch = normalizedPrBranchName(lane.baseRef)
    if !laneBranch.isEmpty, !baseBranch.isEmpty, laneBranch == baseBranch { return false }
  }
  return true
}

/// Branch-only match for raw GitHub PRs — does NOT require the PR to be linked to
/// the lane in ADE, so a PR opened outside ADE on the lane's branch still tags
/// the lane. Mirrors desktop `githubPrMatchesCurrentBranch`.
func lanePrMatchesCurrentBranch(lane: LaneSummary, githubPr: GitHubPrListItem) -> Bool {
  guard githubPr.scope == "repo" else { return false }
  let laneBranch = normalizedPrBranchName(lane.branchRef)
  let prHeadBranch = normalizedPrBranchName(githubPr.headBranch)
  guard !laneBranch.isEmpty, !prHeadBranch.isEmpty, laneBranch == prHeadBranch else { return false }
  // Reject fork PRs: a head repo that differs from the base repo means the head
  // branch lives in another repository, so a same-named local lane branch is not
  // this PR's branch. Mirrors desktop `githubPrMatchesCurrentBranch`. `headRepo*`
  // is nil against older hosts that don't send it — then fall back to the
  // branch-only match.
  if let headRepoOwner = githubPr.headRepoOwner?.trimmingCharacters(in: .whitespaces),
    !headRepoOwner.isEmpty, !githubPr.repoOwner.isEmpty,
    headRepoOwner.lowercased() != githubPr.repoOwner.lowercased()
  {
    return false
  }
  if let headRepoName = githubPr.headRepoName?.trimmingCharacters(in: .whitespaces),
    !headRepoName.isEmpty, !githubPr.repoName.isEmpty,
    headRepoName.lowercased() != githubPr.repoName.lowercased()
  {
    return false
  }
  if lane.laneType == "primary" {
    let baseBranch = normalizedPrBranchName(lane.baseRef)
    if !laneBranch.isEmpty, !baseBranch.isEmpty, laneBranch == baseBranch { return false }
  }
  return true
}

func selectLanePrTag(lane: LaneSummary, pullRequests: [PullRequestListItem]) -> PullRequestListItem? {
  pullRequests
    .filter { lanePrMatchesCurrentBranch(lane: lane, pr: $0) }
    .sorted(by: lanePrTagPrecedes)
    .first
}

func selectGithubLanePrTag(lane: LaneSummary, githubPrs: [GitHubPrListItem]) -> GitHubPrListItem? {
  githubPrs
    .filter { lanePrMatchesCurrentBranch(lane: lane, githubPr: $0) }
    .sorted(by: lanePrTagPrecedes)
    .first
}

private func lanePrTag(from pr: PullRequestListItem) -> LanePrTag {
  LanePrTag(
    source: .ade,
    prId: pr.id,
    githubPrNumber: pr.githubPrNumber,
    githubUrl: pr.githubUrl,
    title: pr.title,
    state: pr.state,
    headBranch: pr.headBranch,
    updatedAt: pr.updatedAt,
    stack: pr.stack
  )
}

private func lanePrTag(from pr: GitHubPrListItem, laneId: String) -> LanePrTag {
  LanePrTag(
    source: .github,
    prId: pr.linkedLaneId == laneId ? pr.linkedPrId : nil,
    githubPrNumber: pr.githubPrNumber,
    githubUrl: pr.githubUrl,
    title: pr.title,
    state: pr.isDraft ? "draft" : pr.state,
    headBranch: pr.headBranch ?? "",
    updatedAt: pr.updatedAt,
    stack: pr.stack
  )
}

private func githubPrMatchesAdePr(_ pr: PullRequestListItem, _ githubPr: GitHubPrListItem) -> Bool {
  githubPr.linkedPrId == pr.id
    || githubPr.githubPrNumber == pr.githubPrNumber
    || githubPr.githubUrl == pr.githubUrl
}

/// A GitHub item that records a terminal (merged/closed) outcome for an
/// ADE-mapped PR whose synced row is still non-terminal — lets a freshly merged
/// PR flip to "merged" before the slower changeset pump catches up.
private func selectTerminalGithubUpdate(
  for pr: PullRequestListItem,
  githubPrs: [GitHubPrListItem]
) -> GitHubPrListItem? {
  if lanePrIsTerminalState(pr.state) { return nil }
  return githubPrs
    .filter { $0.scope == "repo" && lanePrIsTerminalState($0.state) && githubPrMatchesAdePr(pr, $0) }
    .sorted(by: lanePrTagPrecedes)
    .first
}

private func shouldPreferGithubTag(_ pr: PullRequestListItem, _ githubPr: GitHubPrListItem) -> Bool {
  let githubState = githubPr.isDraft ? "draft" : githubPr.state
  guard githubPrMatchesAdePr(pr, githubPr) else {
    return lanePrIsTerminalState(pr.state) && !lanePrIsTerminalState(githubState)
  }
  // A terminal ADE state (merged/closed) can never be superseded by a stale
  // non-terminal GitHub snapshot for the SAME PR, so keep the ADE row.
  if lanePrIsTerminalState(pr.state), !lanePrIsTerminalState(githubState) {
    return false
  }
  return githubState != pr.state
}

/// Resolve the single PR tag for a lane, preferring the ADE-mapped PR but
/// adopting the GitHub state when it is newer/terminal, and falling back to a
/// branch-matched GitHub PR when the lane has no ADE-mapped PR at all. Faithful
/// to desktop `selectLaneTabPrTag`.
func selectLaneTabPrTag(
  lane: LaneSummary,
  pullRequests: [PullRequestListItem],
  githubPrs: [GitHubPrListItem]
) -> LanePrTag? {
  let mappedPr = selectLanePrTag(lane: lane, pullRequests: pullRequests)
  let githubPr = selectGithubLanePrTag(lane: lane, githubPrs: githubPrs)
  guard let mappedPr else {
    return githubPr.map { lanePrTag(from: $0, laneId: lane.id) }
  }
  var mappedTag = lanePrTag(from: mappedPr)
  if let githubPr, githubPrMatchesAdePr(mappedPr, githubPr) {
    mappedTag.stack = githubPr.stack ?? mappedTag.stack
  }
  if let terminalGithubPr = selectTerminalGithubUpdate(for: mappedPr, githubPrs: githubPrs) {
    var tag = lanePrTag(from: terminalGithubPr, laneId: lane.id)
    tag.prId = tag.prId ?? mappedTag.prId
    return tag
  }
  if let githubPr, shouldPreferGithubTag(mappedPr, githubPr) {
    var tag = lanePrTag(from: githubPr, laneId: lane.id)
    tag.prId = tag.prId ?? mappedTag.prId
    return tag
  }
  return mappedTag
}

func lanePrTagByLaneId(
  lanes: [LaneSummary],
  pullRequests: [PullRequestListItem],
  githubPrs: [GitHubPrListItem] = []
) -> [String: LanePrTag] {
  var result: [String: LanePrTag] = [:]
  for lane in lanes {
    if let tag = selectLaneTabPrTag(lane: lane, pullRequests: pullRequests, githubPrs: githubPrs) {
      result[lane.id] = tag
    }
  }
  return result
}

func lanePrTagByLaneId(
  snapshots: [LaneListSnapshot],
  pullRequests: [PullRequestListItem],
  githubPrs: [GitHubPrListItem] = []
) -> [String: LanePrTag] {
  lanePrTagByLaneId(
    lanes: snapshots.map(\.lane),
    pullRequests: pullRequests,
    githubPrs: githubPrs
  )
}

func formatLanePrBadgeLabel(_ tag: LanePrTag) -> String {
  let prefix: String
  switch tag.state {
  case "merged": prefix = "MERGED"
  case "closed": prefix = "CLOSED"
  case "draft": prefix = "DRAFT"
  default: prefix = "PR"
  }
  return "\(prefix) #\(tag.githubPrNumber)"
}

func runtimeSymbol(_ bucket: String) -> String {
  switch bucket {
  case "running":
    return "waveform.path.ecg"
  case "awaiting-input":
    return "exclamationmark.bubble"
  case "ended":
    return "stop.circle"
  default:
    return "circle"
  }
}

func devicePresenceSymbol(for devices: [DeviceMarker]) -> String {
  let platforms = Set(devices.map { $0.platform.lowercased() })
  if platforms.contains("ios") || platforms.contains("ipados") {
    return "iphone"
  }
  if platforms.contains("macos") || platforms.contains("darwin") {
    return "laptopcomputer"
  }
  return "rectangle.on.rectangle"
}

private let cachedISO8601Formatter: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()

private let cachedRelativeDateFormatter: RelativeDateTimeFormatter = {
  let f = RelativeDateTimeFormatter()
  f.unitsStyle = .abbreviated
  return f
}()

private let cachedISO8601FormatterNoFractional: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  return f
}()

func relativeTimestamp(_ timestamp: String?) -> String {
  guard let timestamp else { return "Unknown" }
  guard let date = cachedISO8601Formatter.date(from: timestamp)
          ?? cachedISO8601FormatterNoFractional.date(from: timestamp) else {
    return "Unknown"
  }
  return cachedRelativeDateFormatter.localizedString(for: date, relativeTo: Date())
}

func syncSummary(_ status: GitUpstreamSyncStatus) -> String {
  if !status.hasUpstream {
    return "No upstream. Publish to create a remote branch."
  }
  if status.diverged {
    return "Diverged. Rebase or pull before pushing."
  }
  if status.ahead > 0 && status.behind == 0 {
    return "Ahead by \(status.ahead). Push to publish."
  }
  if status.behind > 0 && status.ahead == 0 {
    return "Behind by \(status.behind). Pull to catch up."
  }
  return "In sync with remote."
}

func conflictSummary(_ status: ConflictStatus) -> String {
  switch status.status {
  case "conflict-active":
    return "\(status.overlappingFileCount) overlapping file(s) in active conflict."
  case "conflict-predicted":
    return "\(status.overlappingFileCount) overlapping file(s) predicted across \(status.peerConflictCount) peer(s)."
  case "behind-base":
    return "Behind base. Rebase before merging."
  case "merge-ready":
    return "Conflict prediction clear. Merge-ready."
  default:
    return "Conflict status available from machine."
  }
}
