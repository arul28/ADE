import Foundation
import SwiftUI

/// ADE-135: fallback when the host sent no `checksReason` (older host, or a row
/// written before the column existed). Shared because it had been pasted into
/// six files and one copy had already lost its full stop.
let noCIReasonText = "No CI has run on this commit."


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

private let prDateFormatterLock = NSLock()

private let prParsedDateCache: NSCache<NSString, NSDate> = {
  let cache = NSCache<NSString, NSDate>()
  cache.countLimit = 512
  return cache
}()

private let prRelativeFormatter = RelativeDateTimeFormatter()

private let prAbsoluteFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.dateStyle = .medium
  formatter.timeStyle = .short
  return formatter
}()

func normalizedPrBranchName(_ ref: String?) -> String {
  var value = ref?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if value.hasPrefix("refs/heads/") {
    value.removeFirst("refs/heads/".count)
  } else if value.hasPrefix("refs/remotes/origin/") {
    value.removeFirst("refs/remotes/origin/".count)
  } else if value.hasPrefix("origin/") {
    value.removeFirst("origin/".count)
  }
  return value
}

func matchedLaneForExactBranch(_ headBranch: String?, lanes: [LaneSummary]) -> LaneSummary? {
  let normalizedHead = normalizedPrBranchName(headBranch)
  guard !normalizedHead.isEmpty
  else {
    return nil
  }
  // Git refs are case-sensitive; matching case-insensitively could pick the wrong
  // lane when two branches differ only by case (e.g. Feature-X vs feature-x).
  return lanes.first { lane in
    normalizedPrBranchName(lane.branchRef) == normalizedHead
  }
}

func shouldFetchPrDetailLiveSidecars(hasLoadedLiveSidecars: Bool, refreshRemote: Bool) -> Bool {
  refreshRemote || !hasLoadedLiveSidecars
}

/// Applies a partial aggregate response without turning unavailable sidecars
/// into authoritative empty values. Fresh fields replace the cache; failed
/// fields retain the last known good value and remain visibly marked partial.
func prMergeMobileGithubSnapshot(
  incoming: PullRequestSnapshot,
  previous: PullRequestSnapshot?,
  unavailableParts: [String]
) -> PullRequestSnapshot {
  let unavailable = Set(unavailableParts)
  return PullRequestSnapshot(
    detail: incoming.detail,
    status: unavailable.contains("status") ? previous?.status : incoming.status,
    checks: unavailable.contains("checks") ? (previous?.checks ?? []) : incoming.checks,
    reviews: unavailable.contains("reviews") ? (previous?.reviews ?? []) : incoming.reviews,
    comments: unavailable.contains("comments") ? (previous?.comments ?? []) : incoming.comments,
    files: unavailable.contains("files") ? (previous?.files ?? []) : incoming.files,
    commits: unavailable.contains("commits") ? previous?.commits : incoming.commits
  )
}

func parsePullRequestPatch(_ patch: String) -> [PrDiffDisplayLine] {
  guard !patch.isEmpty else { return [] }

  let headerRegex = try? NSRegularExpression(pattern: #"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#)
  var oldLineNumber = 0
  var newLineNumber = 0

  return patch.components(separatedBy: "\n").map { line in
    if line.hasPrefix("@@") {
      if let headerRegex,
         let match = headerRegex.firstMatch(in: line, range: NSRange(location: 0, length: line.utf16.count)),
         match.numberOfRanges == 3,
         let oldRange = Range(match.range(at: 1), in: line),
         let newRange = Range(match.range(at: 2), in: line) {
        oldLineNumber = Int(line[oldRange]) ?? 0
        newLineNumber = Int(line[newRange]) ?? 0
      }
      return PrDiffDisplayLine(kind: .hunk, prefix: "@@", text: line, oldLineNumber: nil, newLineNumber: nil)
    }

    if line.hasPrefix("+") && !line.hasPrefix("+++") {
      let display = PrDiffDisplayLine(kind: .added, prefix: "+", text: String(line.dropFirst()), oldLineNumber: nil, newLineNumber: newLineNumber)
      newLineNumber += 1
      return display
    }

    if line.hasPrefix("-") && !line.hasPrefix("---") {
      let display = PrDiffDisplayLine(kind: .removed, prefix: "-", text: String(line.dropFirst()), oldLineNumber: oldLineNumber, newLineNumber: nil)
      oldLineNumber += 1
      return display
    }

    if line.hasPrefix(" ") {
      let display = PrDiffDisplayLine(kind: .context, prefix: " ", text: String(line.dropFirst()), oldLineNumber: oldLineNumber, newLineNumber: newLineNumber)
      oldLineNumber += 1
      newLineNumber += 1
      return display
    }

    return PrDiffDisplayLine(kind: .note, prefix: "", text: line, oldLineNumber: nil, newLineNumber: nil)
  }
}

func prPatchPreviewLimit(for patch: String) -> PrPatchPreviewLimit? {
  let metrics = prPatchMetrics(for: patch)
  let lineCount = metrics.lineCount
  let byteCount = metrics.byteCount
  let maxLines = 1_500
  let maxBytes = 300 * 1024

  if lineCount > maxLines {
    return PrPatchPreviewLimit(
      title: "Diff preview paused",
      message: "This patch has \(lineCount) lines. Open the file in Files or GitHub to inspect it without slowing the PR view."
    )
  }

  if byteCount > maxBytes {
    return PrPatchPreviewLimit(
      title: "Diff preview paused",
      message: "This patch is \(formattedFileSize(byteCount)). Open the file in Files or GitHub to inspect the full diff."
    )
  }

  return nil
}

func prFileDiffShouldExpandByDefault(_ file: PrFile) -> Bool {
  guard let patch = file.patch, !patch.isEmpty else {
    return true
  }

  let metrics = prPatchMetrics(for: patch)
  return metrics.lineCount <= 120 && metrics.byteCount <= 48 * 1024
}

func prPatchMetrics(for patch: String) -> (lineCount: Int, byteCount: Int) {
  guard !patch.isEmpty else {
    return (0, 0)
  }

  let lineCount = patch.reduce(1) { count, character in
    character == "\n" ? count + 1 : count
  }
  return (lineCount, patch.utf8.count)
}

final class PrDiffRenderingCache {
  static let shared = PrDiffRenderingCache()

  private let linesCache = NSCache<NSString, PrDiffLinesBox>()

  private init() {
    linesCache.countLimit = 24
  }

  func lines(for patch: String) -> [PrDiffDisplayLine] {
    if let cached = linesCache.object(forKey: patch as NSString)?.value {
      return cached
    }

    let parsed = parsePullRequestPatch(patch)
    linesCache.setObject(PrDiffLinesBox(value: parsed), forKey: patch as NSString)
    return parsed
  }
}

private final class PrDiffLinesBox: NSObject {
  let value: [PrDiffDisplayLine]

  init(value: [PrDiffDisplayLine]) {
    self.value = value
  }
}

func buildPullRequestTimeline(pr: PullRequestListItem, snapshot: PullRequestSnapshot) -> [PrTimelineEvent] {
  var events: [PrTimelineEvent] = [
    PrTimelineEvent(
      id: "state-opened-\(pr.id)",
      kind: .stateChange,
      title: pr.state == "draft" ? "Draft opened" : "Opened",
      author: snapshot.detail?.author.login,
      body: nil,
      timestamp: pr.createdAt,
      metadata: "\(pr.headBranch) → \(pr.baseBranch)"
    )
  ]

  for review in snapshot.reviews {
    events.append(
      PrTimelineEvent(
        id: "review-\(review.id)",
        kind: .review,
        title: titleCase(review.state.replacingOccurrences(of: "_", with: " ")),
        author: review.reviewer,
        body: review.body,
        timestamp: review.submittedAt ?? pr.updatedAt,
        metadata: nil
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
        kind: .comment,
        title: comment.source == "review" ? "Review comment" : "Comment",
        author: comment.author,
        body: comment.body,
        timestamp: comment.updatedAt ?? comment.createdAt ?? pr.updatedAt,
        metadata: locationText
      )
    )
  }

  let finalState = snapshot.status?.state ?? pr.state
  if finalState == "merged" || finalState == "closed" {
    events.append(
      PrTimelineEvent(
        id: "state-\(finalState)-\(pr.id)",
        kind: .stateChange,
        title: finalState == "merged" ? "Merged" : "Closed",
        author: nil,
        body: nil,
        timestamp: pr.updatedAt,
        metadata: nil
      )
    )
  }

  return events.sorted {
    (prParsedDate($0.timestamp) ?? .distantPast) > (prParsedDate($1.timestamp) ?? .distantPast)
  }
}

func filterPullRequestListItems(
  _ items: [PullRequestListItem],
  query: String,
  state: PrGitHubStatusFilter
) -> [PullRequestListItem] {
  let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return items.filter { item in
    matchesPullRequestListItemStatus(item, state: state)
      && matchesPullRequestListItemSearch(item, query: normalizedQuery)
  }
}

func repoScopedGitHubPullRequests(from snapshot: GitHubPrSnapshot?) -> [GitHubPrListItem] {
  snapshot?.repoPullRequests ?? []
}

func prSyntheticGitHubId(repoOwner: String, repoName: String, githubPrNumber: Int) -> String {
  "gh:\(repoOwner)/\(repoName)#\(githubPrNumber)"
}

func prSyntheticGitHubId(for item: GitHubPrListItem) -> String {
  prSyntheticGitHubId(
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    githubPrNumber: item.githubPrNumber
  )
}

func prGitHubCoordinates(fromRouteId routeId: String) -> (repoOwner: String, repoName: String, githubPrNumber: Int)? {
  guard routeId.hasPrefix("gh:") else { return nil }
  let locator = routeId.dropFirst(3)
  guard let hashIndex = locator.lastIndex(of: "#"),
    let slashIndex = locator[..<hashIndex].firstIndex(of: "/"),
    let number = Int(locator[locator.index(after: hashIndex)...])
  else { return nil }
  let owner = String(locator[..<slashIndex])
  let repo = String(locator[locator.index(after: slashIndex)..<hashIndex])
  guard !owner.isEmpty, !repo.isEmpty, number > 0 else { return nil }
  return (owner, repo, number)
}

private func prGitHubIdentityKey(repoOwner: String, repoName: String, githubPrNumber: Int) -> String {
  "\(repoOwner.lowercased())/\(repoName.lowercased())#\(githubPrNumber)"
}

/// Reconciles the bounded live GitHub projection with replicated ADE PR rows.
/// The host projection is authoritative for rich GitHub metadata, while the
/// local rows keep linked and terminal PRs visible during reconnects or while a
/// webhook-backed projection refresh is still in flight.
func prReconcileGitHubPullRequests(
  snapshotItems: [GitHubPrListItem],
  mappedPrs: [PullRequestListItem]
) -> [GitHubPrListItem] {
  var result = snapshotItems
  var indexByIdentity: [String: Int] = [:]
  indexByIdentity.reserveCapacity(snapshotItems.count + mappedPrs.count)
  for (index, item) in result.enumerated() {
    indexByIdentity[
      prGitHubIdentityKey(
        repoOwner: item.repoOwner,
        repoName: item.repoName,
        githubPrNumber: item.githubPrNumber
      )
    ] = index
  }

  for mapped in mappedPrs {
    let key = prGitHubIdentityKey(
      repoOwner: mapped.repoOwner,
      repoName: mapped.repoName,
      githubPrNumber: mapped.githubPrNumber
    )
    if let index = indexByIdentity[key] {
      var item = result[index]
      item.linkedPrId = mapped.id
      item.linkedGroupId = mapped.linkedGroupId
      item.linkedLaneId = mapped.laneId
      item.linkedLaneName = mapped.laneName
      item.adeKind = mapped.adeKind
      item.workflowDisplayState = mapped.workflowDisplayState
      item.cleanupState = mapped.cleanupState
      item.stack = item.stack ?? mapped.stack
      // Let the newest projection own state in either direction. This keeps a
      // terminal replicated row visible behind an older open-only response,
      // while also allowing a freshly reopened local row to override a stale
      // closed projection. If timestamps are unavailable, retain the previous
      // terminal-row safety behavior.
      let mappedUpdatedAt = prParsedDate(mapped.updatedAt)
      let projectedUpdatedAt = prParsedDate(item.updatedAt)
      let mappedStateIsNewer = if let mappedUpdatedAt, let projectedUpdatedAt {
        mappedUpdatedAt >= projectedUpdatedAt
      } else {
        mapped.state == "merged" || mapped.state == "closed"
      }
      if mappedStateIsNewer {
        item.state = mapped.state
        item.isDraft = mapped.state == "draft"
        item.title = mapped.title
        item.githubUrl = mapped.githubUrl
        item.baseBranch = mapped.baseBranch
        item.headBranch = mapped.headBranch
        item.updatedAt = mapped.updatedAt
      }
      result[index] = item
      continue
    }

    let item = GitHubPrListItem(
      id: prSyntheticGitHubId(
        repoOwner: mapped.repoOwner,
        repoName: mapped.repoName,
        githubPrNumber: mapped.githubPrNumber
      ),
      scope: "repo",
      repoOwner: mapped.repoOwner,
      repoName: mapped.repoName,
      githubPrNumber: mapped.githubPrNumber,
      githubUrl: mapped.githubUrl,
      title: mapped.title,
      state: mapped.state,
      isDraft: mapped.state == "draft",
      baseBranch: mapped.baseBranch,
      headBranch: mapped.headBranch,
      headRepoOwner: mapped.repoOwner,
      headRepoName: mapped.repoName,
      author: nil,
      createdAt: mapped.createdAt,
      updatedAt: mapped.updatedAt,
      linkedPrId: mapped.id,
      linkedGroupId: mapped.linkedGroupId,
      linkedLaneId: mapped.laneId,
      linkedLaneName: mapped.laneName,
      adeKind: mapped.adeKind,
      workflowDisplayState: mapped.workflowDisplayState,
      cleanupState: mapped.cleanupState,
      labels: [],
      isBot: false,
      commentCount: 0,
      stack: mapped.stack
    )
    indexByIdentity[key] = result.count
    result.append(item)
  }

  return result
}

struct GitHubStackPositionBadge: View {
  let stack: GitHubPrStackMembership
  var compact = false

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "square.stack.3d.up.fill")
        .font(.system(size: compact ? 9 : 10, weight: .semibold))
      Text(compact ? "\(stack.position)/\(stack.size)" : "Stack \(stack.position)/\(stack.size)")
        .font(.caption2.monospaced().weight(.semibold))
        .lineLimit(1)
    }
    .foregroundStyle(ADEColor.tintPRs)
    .padding(.horizontal, compact ? 0 : 7)
    .padding(.vertical, compact ? 0 : 3)
    .background {
      if !compact {
        Capsule(style: .continuous)
          .fill(ADEColor.tintPRs.opacity(0.12))
      }
    }
    .overlay {
      if !compact {
        Capsule(style: .continuous)
          .stroke(ADEColor.tintPRs.opacity(0.28), lineWidth: 0.6)
      }
    }
    .accessibilityLabel(
      "GitHub Stack \(stack.position) of \(stack.size), base \(stack.baseBranch)"
    )
  }
}

// MARK: - GitHub PR list filter/sort/count (free functions)
//
// These mirror the predicates that used to live as private methods on
// `PRsTabView`. Pulling them out lets the view precompute a memoized
// `PrGitHubDerivedList` once per (snapshot + filter) change in `.onChange`,
// instead of re-filtering / re-sorting / making 7 count passes on every render.

func prMatchesGitHubStatus(_ item: GitHubPrListItem, status: PrGitHubStatusFilter) -> Bool {
  switch status {
  case .all:
    return true
  case .open:
    return item.state == "open" && !item.isDraft
  case .draft:
    return item.isDraft
  case .merged:
    return item.state == "merged"
  case .closed:
    return item.state == "closed"
  }
}

/// Category match for the three headline tabs (desktop parity): Open folds in
/// draft (state open OR draft), Merged/Closed match 1:1.
///
/// We key strictly on `state` (NOT the raw `isDraft` flag): a PR that was a
/// draft when it closed/merged resolves to state "closed"/"merged" but still
/// carries `isDraft == true`, so folding `isDraft` into Open would put it in
/// BOTH Open and Closed (duplicate rows + count drift). Desktop uses the same
/// state-only predicate (GitHubTab `matchesFilter`).
func prMatchesGitHubCategory(_ item: GitHubPrListItem, category: PrGitHubCategory) -> Bool {
  switch category {
  case .open:
    return item.state == "open" || item.state == "draft"
  case .merged:
    return item.state == "merged"
  case .closed:
    return item.state == "closed"
  }
}

func prMatchesGitHubScope(_ item: GitHubPrListItem, scope: PrGitHubScopeFilter) -> Bool {
  switch scope {
  case .all:
    return true
  case .ade:
    return item.adeKind != nil || item.linkedPrId != nil || item.linkedLaneId != nil
  case .external:
    return item.adeKind == nil && item.linkedPrId == nil && item.linkedLaneId == nil
  }
}

func prMatchesGitHubSearch(_ item: GitHubPrListItem, query: String) -> Bool {
  guard !query.isEmpty else { return true }
  let haystack = [
    item.title,
    item.author,
    item.repoOwner,
    item.repoName,
    item.baseBranch,
    item.headBranch,
    item.linkedLaneName,
    item.adeKind,
    item.workflowDisplayState,
    "#\(item.githubPrNumber)",
    "\(item.githubPrNumber)",
  ]
  .compactMap { $0?.lowercased() }
  .joined(separator: " ")
  return haystack.contains(query) || item.labels.contains { $0.name.lowercased().contains(query) }
}

/// Precompute the filtered/sorted GitHub PR list + filter counts + repo/external
/// partition in a single pass set. Recomputed in `.onChange` of the snapshot or
/// filter inputs — never inside a render. `prParsedDate` is cached, so sort
/// comparisons reuse parsed dates instead of re-parsing strings each compare.
func prComputeGitHubDerivedList(
  items: [GitHubPrListItem],
  query rawQuery: String,
  status: PrGitHubStatusFilter,
  scope: PrGitHubScopeFilter,
  sort: PrGitHubSortOption,
  category: PrGitHubCategory? = nil
) -> PrGitHubDerivedList {
  let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

  // Single pass: filter for the visible list, and accumulate the scope/status
  // count breakdowns the filter chips need. The previous implementation made
  // seven independent `.filter` passes over the whole list per render.
  var filtered: [GitHubPrListItem] = []
  filtered.reserveCapacity(items.count)

  var openCount = 0
  var draftCount = 0
  var mergedCount = 0
  var closedCount = 0
  var scopedAllCount = 0
  var adeCount = 0
  var externalCount = 0
  var linkedCount = 0
  // Headline three-tab counts (Open folds draft in), scoped by the active scope.
  var categoryOpenCount = 0
  var categoryMergedCount = 0
  var categoryClosedCount = 0

  for item in items {
    let inScope = prMatchesGitHubScope(item, scope: scope)
    // When a category is supplied (the three-tab headline selector), the
    // primary list filter folds draft into open. Otherwise fall back to the
    // richer 5-way status filter.
    let inStatus = category.map { prMatchesGitHubCategory(item, category: $0) }
      ?? prMatchesGitHubStatus(item, status: status)

    // Counts shown on the filter chips: status counts are scoped by the active
    // scope; scope counts (ade/external) are scoped by the active status.
    if inScope {
      scopedAllCount += 1
      if prMatchesGitHubStatus(item, status: .open) { openCount += 1 }
      if prMatchesGitHubStatus(item, status: .draft) { draftCount += 1 }
      if prMatchesGitHubStatus(item, status: .merged) { mergedCount += 1 }
      if prMatchesGitHubStatus(item, status: .closed) { closedCount += 1 }
      // Reuse the exact category predicate so the tab counts can never disagree
      // with the rendered list (the closed/merged-draft edge included).
      if prMatchesGitHubCategory(item, category: .open) { categoryOpenCount += 1 }
      if prMatchesGitHubCategory(item, category: .merged) { categoryMergedCount += 1 }
      if prMatchesGitHubCategory(item, category: .closed) { categoryClosedCount += 1 }
    }
    if inStatus {
      if prMatchesGitHubScope(item, scope: .ade) { adeCount += 1 }
      if prMatchesGitHubScope(item, scope: .external) { externalCount += 1 }
    }

    if item.linkedPrId != nil || item.linkedLaneId != nil || item.adeKind != nil {
      linkedCount += 1
    }

    if inStatus && inScope && prMatchesGitHubSearch(item, query: query) {
      filtered.append(item)
    }
  }

  // Sort with precomputed comparable keys so date strings parse at most once
  // per item instead of on every comparison.
  switch sort {
  case .updated:
    let keyed = filtered.map { ($0, prParsedDate($0.updatedAt) ?? .distantPast) }
    filtered = keyed.sorted { $0.1 > $1.1 }.map(\.0)
  case .created:
    let keyed = filtered.map { ($0, prParsedDate($0.createdAt) ?? .distantPast) }
    filtered = keyed.sorted { $0.1 > $1.1 }.map(\.0)
  case .number:
    filtered.sort { lhs, rhs in
      if lhs.repoOwner == rhs.repoOwner && lhs.repoName == rhs.repoName {
        return lhs.githubPrNumber > rhs.githubPrNumber
      }
      return "\(lhs.repoOwner)/\(lhs.repoName)" < "\(rhs.repoOwner)/\(rhs.repoName)"
    }
  }

  let repoItems = filtered.filter { $0.scope != "external" }
  let externalItems = filtered.filter { $0.scope == "external" }

  return PrGitHubDerivedList(
    filtered: filtered,
    repoItems: repoItems,
    externalItems: externalItems,
    counts: PrGitHubFilterCounts(
      open: openCount,
      draft: draftCount,
      merged: mergedCount,
      closed: closedCount,
      all: scopedAllCount,
      ade: adeCount,
      external: externalCount
    ),
    categoryCounts: PrGitHubCategoryCounts(
      open: categoryOpenCount,
      merged: categoryMergedCount,
      closed: categoryClosedCount
    ),
    allCount: items.count,
    linkedCount: linkedCount
  )
}

func prDetailRouteListItem(
  from items: [PullRequestListItem],
  prId: String,
  requestedPrNumber: Int?,
  githubItem: GitHubPrListItem?,
  requestedRepoOwner: String? = nil,
  requestedRepoName: String? = nil
) -> PullRequestListItem? {
  guard let requestedPrNumber else {
    return items.first { $0.id == prId }
  }

  let candidates = items.filter { $0.githubPrNumber == requestedPrNumber }
  guard !candidates.isEmpty else { return nil }

  if let linkedPrId = githubItem?.linkedPrId,
     let match = candidates.first(where: { $0.id == linkedPrId }) {
    return match
  }

  if let linkedLaneId = githubItem?.linkedLaneId,
     let match = candidates.first(where: { $0.laneId == linkedLaneId }) {
    return match
  }

  if let githubItem {
    let repoMatches = candidates.filter {
      $0.repoOwner.caseInsensitiveCompare(githubItem.repoOwner) == .orderedSame
        && $0.repoName.caseInsensitiveCompare(githubItem.repoName) == .orderedSame
    }
    if repoMatches.count == 1 {
      return repoMatches[0]
    }
  }

  if let requestedRepoOwner,
     let requestedRepoName,
     !requestedRepoOwner.isEmpty,
     !requestedRepoName.isEmpty {
    let repoMatches = candidates.filter {
      $0.repoOwner.caseInsensitiveCompare(requestedRepoOwner) == .orderedSame
        && $0.repoName.caseInsensitiveCompare(requestedRepoName) == .orderedSame
    }
    if repoMatches.count == 1 {
      return repoMatches[0]
    }
    return nil
  }

  return candidates.count == 1 ? candidates[0] : nil
}

struct PrDetailRouteScope: Equatable {
  let repoOwner: String
  let repoName: String

  init?(repoOwner: String?, repoName: String?) {
    let owner = repoOwner?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let name = repoName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !owner.isEmpty, !name.isEmpty else { return nil }
    self.repoOwner = owner
    self.repoName = name
  }
}

func prDetailWarmEntryMatchesRequestedScope(
  _ entry: PrDetailWarmEntry,
  requestedRepoScope: PrDetailRouteScope?
) -> Bool {
  guard let requestedRepoScope else { return true }
  let repoOwner = firstNonEmptyPrRepoValue(entry.pr?.repoOwner, entry.githubItem?.repoOwner)
  let repoName = firstNonEmptyPrRepoValue(entry.pr?.repoName, entry.githubItem?.repoName)
  guard let repoOwner, let repoName else { return false }
  return repoOwner.caseInsensitiveCompare(requestedRepoScope.repoOwner) == .orderedSame
    && repoName.caseInsensitiveCompare(requestedRepoScope.repoName) == .orderedSame
}

private func firstNonEmptyPrRepoValue(_ values: String?...) -> String? {
  values
    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
    .first { !$0.isEmpty }
}

enum PrNavigationTarget: Equatable {
  case detail(prId: String, laneId: String?, repoScope: PrDetailRouteScope?)
  case github(GitHubPrListItem)
  case unresolved
}

func prNavigationTarget(
  for request: PrNavigationRequest,
  pullRequests: [PullRequestListItem],
  githubItems: [GitHubPrListItem]
) -> PrNavigationTarget {
  let prId: String
  let requestLaneId: String?
  let explicitPrNumber: Int?
  let requestedRepoOwner: String?
  let requestedRepoName: String?
  switch request.target {
  case .detail(let rawPrId, let prNumber, let laneId):
    prId = rawPrId.trimmingCharacters(in: .whitespacesAndNewlines)
    requestLaneId = laneId
    explicitPrNumber = prNumber
    requestedRepoOwner = nil
    requestedRepoName = nil
  case .githubNumber(let prNumber, let repoOwner, let repoName):
    prId = "github-pr-number:\(prNumber)"
    requestLaneId = nil
    explicitPrNumber = prNumber
    requestedRepoOwner = repoOwner?.trimmingCharacters(in: .whitespacesAndNewlines)
    requestedRepoName = repoName?.trimmingCharacters(in: .whitespacesAndNewlines)
  case .create:
    return .unresolved
  }
  let requestedRepoScope = PrDetailRouteScope(repoOwner: requestedRepoOwner, repoName: requestedRepoName)
  guard !prId.isEmpty else { return .unresolved }

  guard prId.hasPrefix("github-pr-number:") else {
    let match = pullRequests.first { $0.id == prId }
    return .detail(prId: prId, laneId: requestLaneId ?? match?.laneId, repoScope: nil)
  }

  let requestedPrNumber = explicitPrNumber ?? syntheticPrNumber(from: prId)
  guard let requestedPrNumber else { return .unresolved }
  let githubItem = githubItems.first {
    guard $0.githubPrNumber == requestedPrNumber else { return false }
    guard let requestedRepoOwner,
          let requestedRepoName,
          !requestedRepoOwner.isEmpty,
          !requestedRepoName.isEmpty else { return true }
    return $0.repoOwner.caseInsensitiveCompare(requestedRepoOwner) == .orderedSame
      && $0.repoName.caseInsensitiveCompare(requestedRepoName) == .orderedSame
  }

  if let match = prDetailRouteListItem(
    from: pullRequests,
    prId: prId,
    requestedPrNumber: requestedPrNumber,
    githubItem: githubItem,
    requestedRepoOwner: requestedRepoOwner,
    requestedRepoName: requestedRepoName
  ) {
    let repoScope = requestedRepoScope ?? PrDetailRouteScope(repoOwner: githubItem?.repoOwner, repoName: githubItem?.repoName)
    return .detail(prId: match.id, laneId: requestLaneId ?? match.laneId, repoScope: repoScope)
  }

  if let linkedPrId = githubItem?.linkedPrId?.trimmingCharacters(in: .whitespacesAndNewlines),
     !linkedPrId.isEmpty {
    let repoScope = requestedRepoScope ?? PrDetailRouteScope(repoOwner: githubItem?.repoOwner, repoName: githubItem?.repoName)
    return .detail(prId: linkedPrId, laneId: requestLaneId ?? githubItem?.linkedLaneId, repoScope: repoScope)
  }

  if let githubItem {
    return .github(githubItem)
  }

  return .unresolved
}

private func syntheticPrNumber(from prId: String) -> Int? {
  let prefix = "github-pr-number:"
  guard prId.hasPrefix(prefix) else { return nil }
  return Int(prId.dropFirst(prefix.count))
}

func matchesPullRequestListItemStatus(_ item: PullRequestListItem, state: PrGitHubStatusFilter) -> Bool {
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

func matchesPullRequestListItemSearch(_ item: PullRequestListItem, query: String) -> Bool {
  guard !query.isEmpty else { return true }
  let haystack = [
    item.title,
    item.headBranch,
    item.baseBranch,
    item.laneName,
    item.repoOwner,
    item.repoName,
    item.adeKind,
    item.workflowDisplayState,
    "#\(item.githubPrNumber)",
    "\(item.githubPrNumber)",
  ]
  .compactMap { $0?.lowercased() }
  .joined(separator: " ")
  return haystack.contains(query)
}

func buildPullRequestTimeline(
  pr: PullRequestListItem,
  snapshot: PullRequestSnapshot,
  activity: [PrActivityEvent]
) -> [PrTimelineEvent] {
  var events = buildPullRequestTimeline(pr: pr, snapshot: snapshot)
  let existingIds = Set(events.map(\.id))
  for item in activity where !existingIds.contains(item.id) {
    events.append(
      PrTimelineEvent(
        id: item.id,
        kind: timelineKind(for: item.type),
        title: prActivityTitle(for: item.type),
        author: item.author,
        body: item.body,
        timestamp: item.timestamp,
        metadata: activityMetadataText(item.metadata)
      )
    )
  }
  return events.sorted {
    (prParsedDate($0.timestamp) ?? .distantPast) > (prParsedDate($1.timestamp) ?? .distantPast)
  }
}

private func timelineKind(for type: String) -> PrTimelineEventKind {
  switch type {
  case "deployment": return .deployment
  case "commit": return .commit
  case "label": return .label
  case "ci_run": return .ci
  case "force_push": return .forcePush
  case "review_request": return .reviewRequest
  case "review": return .review
  case "comment": return .comment
  default: return .stateChange
  }
}

private func prActivityTitle(for type: String) -> String {
  switch type {
  case "ci_run": return "CI run"
  case "force_push": return "Force push"
  case "review_request": return "Review requested"
  default: return titleCase(type.replacingOccurrences(of: "_", with: " "))
  }
}

private func activityMetadataText(_ metadata: [String: RemoteJSONValue]?) -> String? {
  guard let metadata, !metadata.isEmpty else { return nil }
  let preferredKeys = ["path", "line", "status", "conclusion", "environment", "shortSha", "label", "reviewer", "url"]
  let parts = preferredKeys.compactMap { key -> String? in
    guard let value = metadata[key]?.plainTextValue else { return nil }
    return "\(key): \(value)"
  }
  return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

func prStateTint(_ state: String) -> Color {
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

func prChecksTint(_ status: String) -> Color {
  switch status {
  case "passing", "success":
    return ADEColor.success
  case "failing", "failure":
    return ADEColor.danger
  case "pending", "queued", "in_progress":
    return ADEColor.warning
  // ADE-135. `not_run` means nothing verified the commit. It reads as an empty
  // slot, not an alarm, so it stays in the muted tone rather than danger red.
  case "not_run":
    return ADEColor.textSecondary
  default:
    return ADEColor.textSecondary
  }
}

func prReviewTint(_ status: String) -> Color {
  switch status {
  case "approved":
    return ADEColor.success
  case "changes_requested":
    return ADEColor.danger
  case "requested", "commented", "pending":
    return ADEColor.warning
  default:
    return ADEColor.textSecondary
  }
}

func prChecksLabel(_ status: String) -> String {
  switch status {
  case "passing": return "Passing"
  case "failing": return "Failing"
  case "pending": return "Pending"
  case "not_run": return "Not run"
  default: return titleCase(status)
  }
}

func prReviewLabel(_ status: String) -> String {
  switch status {
  case "changes_requested": return "Changes requested"
  case "requested": return "Review requested"
  case "approved": return "Approved"
  case "none": return "No review"
  default: return titleCase(status)
  }
}

func prAdeKindLabel(_ adeKind: String?) -> String? {
  guard let adeKind, !adeKind.isEmpty else { return nil }
  switch adeKind {
  case "single": return "ADE"
  case "integration": return "ADE INT"
  default: return "ADE"
  }
}

func reviewSymbol(_ status: String) -> String {
  switch status {
  case "approved":
    return "checkmark.circle.fill"
  case "changes_requested":
    return "xmark.circle.fill"
  case "requested":
    return "person.badge.clock.fill"
  default:
    return "person.crop.circle.badge.questionmark"
  }
}

func checkSymbol(_ check: PrCheck) -> String {
  if check.status == "completed" {
    if check.conclusion == "success" { return "checkmark.circle.fill" }
    if check.conclusion == "failure" { return "xmark.circle.fill" }
    return "minus.circle.fill"
  }
  return "circle.dashed"
}

func prCheckStatusLabel(_ check: PrCheck) -> String {
  if check.status == "completed" {
    return check.conclusion.map(titleCase) ?? "Completed"
  }
  return titleCase(check.status.replacingOccurrences(of: "_", with: " "))
}

func timelineSymbol(_ kind: PrTimelineEventKind) -> String {
  switch kind {
  case .stateChange: return "arrow.triangle.merge"
  case .review: return "checkmark.seal.fill"
  case .comment: return "text.bubble.fill"
  case .deployment: return "shippingbox.fill"
  case .commit: return "number"
  case .label: return "tag.fill"
  case .ci: return "checklist.checked"
  case .forcePush: return "arrow.up.forward.circle.fill"
  case .reviewRequest: return "person.crop.circle.badge.questionmark"
  }
}

func timelineTint(_ kind: PrTimelineEventKind) -> Color {
  switch kind {
  case .stateChange: return ADEColor.success
  case .review: return ADEColor.accent
  case .comment: return ADEColor.warning
  case .deployment: return ADEColor.tintFiles
  case .commit: return ADEColor.textSecondary
  case .label: return ADEColor.tintPRs
  case .ci: return ADEColor.success
  case .forcePush: return ADEColor.danger
  case .reviewRequest: return ADEColor.warning
  }
}

func fileStatusLabel(_ status: String) -> String {
  switch status {
  case "added": return "A"
  case "removed": return "D"
  case "modified": return "M"
  case "renamed": return "R"
  case "copied": return "C"
  default: return status.prefix(1).uppercased()
  }
}

func fileStatusTint(_ status: String) -> Color {
  switch status {
  case "added": return ADEColor.success
  case "removed": return ADEColor.danger
  case "modified": return ADEColor.warning
  case "renamed", "copied": return ADEColor.accent
  default: return ADEColor.textSecondary
  }
}

func severityRank(_ severity: String) -> Int {
  switch severity {
  case "critical": return 0
  case "warning": return 1
  default: return 2
  }
}

func titleCase(_ raw: String) -> String {
  raw
    .replacingOccurrences(of: "_", with: " ")
    .split(separator: " ")
    .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
    .joined(separator: " ")
}

func prParsedDate(_ iso: String?) -> Date? {
  guard let iso, !iso.isEmpty else { return nil }
  let key = iso as NSString
  if let cached = prParsedDateCache.object(forKey: key) {
    return cached as Date
  }

  prDateFormatterLock.lock()
  let parsed = prIsoFormatter.date(from: iso) ?? prIsoFallbackFormatter.date(from: iso)
  prDateFormatterLock.unlock()

  if let parsed {
    prParsedDateCache.setObject(parsed as NSDate, forKey: key)
  }
  return parsed
}

func prRelativeTime(_ iso: String?) -> String {
  guard let date = prParsedDate(iso) else { return "unknown" }
  return prRelativeFormatter.localizedString(for: date, relativeTo: Date())
}

func prAbsoluteTime(_ iso: String?) -> String {
  guard let date = prParsedDate(iso) else { return "unknown" }
  return prAbsoluteFormatter.string(from: date)
}

// MARK: - Merged/closed period grouping

/// A period header in the merged/closed list, mirroring the desktop PRs tab.
///
/// Merged history is a log, not a queue: it only grows, and the useful question is
/// "what shipped, and when". Open PRs are deliberately left ungrouped.
struct PrListPeriodGroup: Identifiable, Equatable {
  let id: String
  let label: String
  let items: [GitHubPrListItem]

  var count: Int { items.count }

  /// What these rows did. Both merged and closed are grouped, so the header cannot
  /// hardcode "merged".
  var outcome: String { items.first?.state == "closed" ? "closed" : "merged" }

  /// `+1.2k −380`, or nil when nothing has diff stats recorded.
  var diffSummary: String? {
    let additions = items.reduce(0) { $0 + max(0, $1.additions ?? 0) }
    let deletions = items.reduce(0) { $0 + max(0, $1.deletions ?? 0) }
    guard additions > 0 || deletions > 0 else { return nil }
    return "+\(prAbbreviatedCount(additions)) −\(prAbbreviatedCount(deletions))"
  }
}

func prAbbreviatedCount(_ value: Int) -> String {
  guard value >= 1000 else { return String(value) }
  let thousands = Double(value) / 1000.0
  if thousands >= 10 { return "\(Int(thousands.rounded()))k" }
  return String(format: "%.1fk", thousands).replacingOccurrences(of: ".0k", with: "k")
}

/// The timestamp a terminal row is filed under: when it shipped, else last touched.
func prListGroupDate(_ item: GitHubPrListItem) -> Date? {
  prParsedDate(item.mergedAt) ?? prParsedDate(item.updatedAt) ?? prParsedDate(item.createdAt)
}

/// Label for the period `date` falls in. Recent periods get names people actually use;
/// older ones get an explicit range or month, because "5 weeks ago" is hard to place.
/// Weeks are Monday-anchored to match the desktop PRs tab. `Calendar.current` is
/// locale-dependent — Sunday-first under en_US — which would otherwise put the same PR
/// in "This week" on iOS and "Last week" on desktop.
func prMondayAnchoredCalendar(_ base: Calendar = .current) -> Calendar {
  var calendar = base
  calendar.firstWeekday = 2
  return calendar
}

func prListGroupLabel(for date: Date, now: Date, calendar: Calendar = prMondayAnchoredCalendar()) -> (id: String, label: String) {
  if calendar.isDateInToday(date) { return ("today", "Today") }
  if calendar.isDateInYesterday(date) { return ("yesterday", "Yesterday") }

  let itemWeek = calendar.dateInterval(of: .weekOfYear, for: date)
  let thisWeek = calendar.dateInterval(of: .weekOfYear, for: now)
  if let itemWeek, let thisWeek {
    if itemWeek.start == thisWeek.start { return ("this-week", "This week") }
    if let lastWeekStart = calendar.date(byAdding: .weekOfYear, value: -1, to: thisWeek.start),
       itemWeek.start == lastWeekStart {
      return ("last-week", "Last week")
    }
    // Within the same calendar year, an explicit week range stays scannable.
    if calendar.component(.year, from: itemWeek.start) == calendar.component(.year, from: thisWeek.start) {
      let end = calendar.date(byAdding: .day, value: 6, to: itemWeek.start) ?? itemWeek.start
      let key = ISO8601DateFormatter().string(from: itemWeek.start).prefix(10)
      return ("week-\(key)", "\(prDayMonthFormatter.string(from: itemWeek.start)) – \(prDayMonthFormatter.string(from: end))")
    }
  }

  let year = calendar.component(.year, from: date)
  let month = calendar.component(.month, from: date)
  return ("month-\(year)-\(month)", prMonthYearFormatter.string(from: date))
}

/// Group an already-sorted list into periods, preserving the caller's order exactly.
func prListPeriodGroups(
  _ items: [GitHubPrListItem],
  now: Date = Date(),
  calendar: Calendar = prMondayAnchoredCalendar()
) -> [PrListPeriodGroup] {
  var groups: [PrListPeriodGroup] = []
  var currentId: String?
  var currentLabel = ""
  var buffer: [GitHubPrListItem] = []

  func flush() {
    guard let id = currentId, !buffer.isEmpty else { return }
    groups.append(PrListPeriodGroup(id: id, label: currentLabel, items: buffer))
    buffer = []
  }

  for item in items {
    let resolved: (id: String, label: String)
    if let date = prListGroupDate(item) {
      resolved = prListGroupLabel(for: date, now: now, calendar: calendar)
    } else {
      resolved = ("unknown", "Undated")
    }
    if resolved.id != currentId {
      flush()
      currentId = resolved.id
      currentLabel = resolved.label
    }
    buffer.append(item)
  }
  flush()
  return groups
}

let prDayMonthFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.setLocalizedDateFormatFromTemplate("MMMd")
  return formatter
}()

let prMonthYearFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.setLocalizedDateFormatFromTemplate("MMMMy")
  return formatter
}()

func prDurationText(startedAt: String?, completedAt: String?) -> String? {
  guard let started = prParsedDate(startedAt), let completed = prParsedDate(completedAt) else { return nil }
  let seconds = max(completed.timeIntervalSince(started), 0)
  if seconds < 60 {
    return "\(Int(seconds.rounded())) sec"
  }
  return String(format: "%.1f min", seconds / 60.0)
}

func prHeuristicDraft(lane: LaneSummary, detail: LaneDetailPayload?) -> PullRequestDraftSuggestion {
  let commitSubjects = detail?.recentCommits.map(\.subject).filter { !$0.isEmpty } ?? []
  let title = commitSubjects.first ?? lane.name
  let changedFiles = (detail?.diffChanges?.unstaged.count ?? 0) + (detail?.diffChanges?.staged.count ?? 0)
  let bullets = commitSubjects.prefix(3).map { "- \($0)" }
  let body = ([
    "## Summary",
    "",
    bullets.isEmpty ? "- Update \(lane.name) from lane `\(lane.branchRef)`" : bullets.joined(separator: "\n"),
    "",
    "## Notes",
    "",
    "- Source branch: `\(lane.branchRef)`",
    "- Target branch: `\(lane.baseRef)`",
    changedFiles > 0 ? "- Local diff count seen on iPhone: \(changedFiles) files" : nil,
  ].compactMap { $0 }).joined(separator: "\n")
  return PullRequestDraftSuggestion(title: title, body: body)
}

final class PrMarkdownRenderingCache {
  static let shared = PrMarkdownRenderingCache()

  private let cache = NSCache<NSString, PrMarkdownAttributedStringBox>()

  private init() {
    cache.countLimit = 48
  }

  func attributedString(for markdown: String) -> AttributedString? {
    cache.object(forKey: markdown as NSString)?.value
  }

  func store(_ attributed: AttributedString, for markdown: String) {
    cache.setObject(PrMarkdownAttributedStringBox(value: attributed), forKey: markdown as NSString)
  }
}

func normalizePrMarkdownText(_ text: String) -> String {
  var normalized = text
    .replacingOccurrences(of: "\r\n", with: "\n")
    .replacingOccurrences(of: "\r", with: "\n")

  if prMarkdownLooksDoubleEscaped(normalized) {
    normalized = normalized
      .replacingOccurrences(of: "\\r\\n", with: "\n")
      .replacingOccurrences(of: "\\n", with: "\n")
      .replacingOccurrences(of: "\\r", with: "\n")
      .replacingOccurrences(of: "\\t", with: "\t")
  }

  return normalized
}

private func prMarkdownLooksDoubleEscaped(_ text: String) -> Bool {
  guard !text.contains("\n"), !text.contains("\r") else { return false }
  let escapedBreakCount = text.components(separatedBy: "\\n").count - 1
    + text.components(separatedBy: "\\r").count - 1
  guard escapedBreakCount >= 2 else { return false }
  return [
    "\\n\\n",
    "\\n#",
    "\\n- ",
    "\\n* ",
    "\\n> ",
    "\\n```",
    "\\n1. ",
    "\\n|",
  ].contains { text.contains($0) }
}

private final class PrMarkdownAttributedStringBox: NSObject {
  let value: AttributedString

  init(value: AttributedString) {
    self.value = value
  }
}

// MARK: - PrGlassPalette extension (foundation tokens for the PRs overhaul).
//
// The base palette lives in `PrMergeGateCard.swift`. These additions are
// purely additive — they introduce the extra tokens the upcoming PRs tab
// overhaul needs (surface fills, text hierarchy, info accent, eyebrow tint,
// and a couple of alias names so future callers can use the spec vocabulary
// without renaming existing callsites). Do NOT rename existing tokens.

extension PrGlassPalette {
  // Surface fills — route to the adaptive card tokens defined alongside the
  // base palette (PrMergeGateCard.swift) so light mode renders correctly.
  static var cardFill: Color { threadCard }
  static var cardElevated: Color { panelCard }

  // Text hierarchy — alias the app-wide adaptive tokens.
  static var textPrimary: Color { ADEColor.textPrimary }
  static var textSecondary: Color { ADEColor.textSecondary }
  static var textMuted: Color { ADEColor.textMuted }

  // Eyebrow tint for section labels.
  static var eyebrow: Color { ADEColor.textSecondary }

  // Info accent (soft blue, used for non-critical callouts).
  static var info: Color { ADEColor.info }
}

// MARK: - Shared PRs tab view helpers

struct PrSectionHdr<Trailing: View>: View {
  let title: String
  @ViewBuilder let trailing: () -> Trailing

  init(title: String, @ViewBuilder trailing: @escaping () -> Trailing) {
    self.title = title
    self.trailing = trailing
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(title.uppercased())
        .font(.system(size: 10, weight: .bold))
        .tracking(1.1)
        .foregroundColor(ADEColor.textSecondary)
      Spacer(minLength: 12)
      trailing()
        .font(.system(size: 11, weight: .semibold, design: .monospaced))
        .foregroundColor(ADEColor.tintPRs)
    }
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 8)
  }
}

extension PrSectionHdr where Trailing == EmptyView {
  init(title: String) {
    self.init(title: title, trailing: { EmptyView() })
  }
}

#Preview("PrSectionHdr") {
  VStack(alignment: .leading, spacing: 0) {
    PrSectionHdr(title: "Open")
    PrSectionHdr(title: "Checks") {
      Text("3 failing")
    }
  }
  .frame(maxWidth: .infinity)
  .background(ADEColor.pageBackground)
}

struct PrScopeChip: View {
  let label: String
  let count: Int?
  let isActive: Bool
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Text(label)
          .font(.system(size: 13, weight: isActive ? .semibold : .medium))
          .foregroundColor(isActive ? ADEColor.tintPRs : ADEColor.textPrimary)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
        if let count {
          Text("\(count)")
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundColor(isActive ? ADEColor.tintPRs : ADEColor.textSecondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
              Capsule()
                .fill((isActive ? ADEColor.tintPRs : ADEColor.textSecondary).opacity(0.15))
            )
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .fixedSize(horizontal: true, vertical: false)
      .background(
        Capsule()
          .fill(isActive ? ADEColor.tintPRs.opacity(0.14) : ADEColor.recessedBackground)
      )
      .overlay(
        Capsule()
          .strokeBorder(isActive ? ADEColor.tintPRs.opacity(0.45) : Color.clear, lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
  }
}

#Preview("PrScopeChip") {
  HStack(spacing: 8) {
    PrScopeChip(label: "Mine", count: 3, isActive: true, action: {})
    PrScopeChip(label: "Team", count: 12, isActive: false, action: {})
    PrScopeChip(label: "All", count: nil, isActive: false, action: {})
  }
  .padding()
  .background(ADEColor.pageBackground)
}

struct PrTagChip: View {
  let label: String
  let color: Color
  var filled: Bool = false

  var body: some View {
    Text(label.uppercased())
      .font(.system(size: 10, weight: .semibold, design: .monospaced))
      .tracking(1.2)
      .foregroundColor(filled ? Color.white : color)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(
        RoundedRectangle(cornerRadius: 5, style: .continuous)
          .fill(filled ? color : color.opacity(0.16))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 5, style: .continuous)
          .strokeBorder(filled ? Color.clear : color.opacity(0.35), lineWidth: 0.5)
      )
  }
}

#Preview("PrTagChip") {
  HStack(spacing: 6) {
    PrTagChip(label: "ADE", color: ADEColor.tintPRs, filled: true)
    PrTagChip(label: "Stacked", color: ADEColor.warning)
    PrTagChip(label: "Draft", color: ADEColor.textSecondary)
  }
  .padding()
  .background(ADEColor.pageBackground)
}

struct PrStateTile: View {
  let state: String
  var size: CGFloat = 28

  private var tint: Color {
    switch state {
    case "open": return ADEColor.success
    case "draft": return ADEColor.warning
    case "merged": return ADEColor.tintPRs
    case "closed": return ADEColor.danger
    case "blocked": return ADEColor.danger
    default: return ADEColor.textSecondary
    }
  }

  private var symbol: String {
    switch state {
    case "open": return "arrow.triangle.pull"
    case "draft": return "pencil.line"
    case "merged": return "arrow.triangle.merge"
    case "closed": return "xmark"
    case "blocked": return "exclamationmark.octagon.fill"
    default: return "arrow.triangle.branch"
    }
  }

  var body: some View {
    RoundedRectangle(cornerRadius: 7, style: .continuous)
      .fill(tint.opacity(0.16))
      .overlay(
        Image(systemName: symbol)
          .font(.system(size: size * 0.46, weight: .semibold))
          .foregroundColor(tint)
      )
      .frame(width: size, height: size)
  }
}

#Preview("PrStateTile") {
  HStack(spacing: 10) {
    PrStateTile(state: "open")
    PrStateTile(state: "draft")
    PrStateTile(state: "merged")
    PrStateTile(state: "closed")
    PrStateTile(state: "blocked")
  }
  .padding()
  .background(ADEColor.pageBackground)
}

struct PrCheckStatPill: View {
  let count: Int
  let label: String
  let color: Color?

  private var tint: Color { color ?? ADEColor.textSecondary }

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("\(count)")
        .font(.system(size: 20, weight: .semibold, design: .rounded))
        .foregroundColor(tint)
      Text(label.uppercased())
        .font(.system(size: 10, weight: .semibold, design: .monospaced))
        .tracking(1.1)
        .foregroundColor(ADEColor.textSecondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(ADEColor.recessedBackground)
    )
  }
}

#Preview("PrCheckStatPill") {
  HStack(spacing: 8) {
    PrCheckStatPill(count: 14, label: "Passing", color: ADEColor.success)
    PrCheckStatPill(count: 3, label: "Failing", color: ADEColor.danger)
    PrCheckStatPill(count: 1, label: "Pending", color: ADEColor.warning)
  }
  .padding()
  .background(ADEColor.pageBackground)
}

struct PrWarnBanner: View {
  let text: String
  var tint: Color = ADEColor.warning

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 11, weight: .semibold))
        .foregroundColor(tint)
      Text(text)
        .font(.footnote)
        .foregroundColor(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(tint.opacity(0.14))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(tint.opacity(0.35), lineWidth: 0.5)
    )
  }
}

#Preview("PrWarnBanner") {
  VStack(spacing: 10) {
    PrWarnBanner(text: "Merge conflicts detected against main.")
    PrWarnBanner(text: "Changes requested by 2 reviewers.", tint: ADEColor.danger)
  }
  .padding()
  .background(ADEColor.pageBackground)
}

enum PrDiffKind {
  case context
  case added
  case removed
  case conflictMarker
}

struct PrDiffLine: Identifiable {
  let id = UUID()
  let lineNumber: String?
  let text: String
  let kind: PrDiffKind
}

struct PrDiffPreview: View {
  let lines: [PrDiffLine]

  private func bg(for kind: PrDiffKind) -> Color {
    switch kind {
    case .context: return Color.clear
    case .added: return Color(red: 0.13, green: 0.55, blue: 0.35).opacity(0.18)
    case .removed: return Color(red: 0.78, green: 0.22, blue: 0.35).opacity(0.18)
    case .conflictMarker: return ADEColor.warning.opacity(0.22)
    }
  }

  private func fg(for kind: PrDiffKind) -> Color {
    switch kind {
    case .context: return ADEColor.textSecondary
    case .added: return ADEColor.success
    case .removed: return ADEColor.danger
    case .conflictMarker: return ADEColor.warning
    }
  }

  private func prefix(for kind: PrDiffKind) -> String {
    switch kind {
    case .context: return " "
    case .added: return "+"
    case .removed: return "-"
    case .conflictMarker: return "!"
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(lines) { line in
        HStack(alignment: .top, spacing: 10) {
          Text(line.lineNumber ?? "")
            .font(.system(size: 10, weight: .regular, design: .monospaced))
            .foregroundColor(ADEColor.textSecondary.opacity(0.6))
            .frame(width: 32, alignment: .trailing)
          Text(prefix(for: line.kind))
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundColor(fg(for: line.kind))
            .frame(width: 10, alignment: .leading)
          Text(line.text)
            .font(.system(size: 11, design: .monospaced))
            .foregroundColor(line.kind == .context ? ADEColor.textPrimary : fg(for: line.kind))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 2)
        .background(bg(for: line.kind))
      }
    }
    .padding(.vertical, 6)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(ADEColor.recessedBackground)
    )
  }
}

#Preview("PrDiffPreview") {
  PrDiffPreview(lines: [
    PrDiffLine(lineNumber: "12", text: "const user = fetchUser()", kind: .context),
    PrDiffLine(lineNumber: "13", text: "return user.name", kind: .removed),
    PrDiffLine(lineNumber: "13", text: "return user?.name ?? \"guest\"", kind: .added),
    PrDiffLine(lineNumber: "14", text: "<<<<<<< HEAD", kind: .conflictMarker),
  ])
  .padding()
  .background(ADEColor.pageBackground)
}

struct PrCommitDot: View {
  let status: String
  var size: CGFloat = 6

  private var tint: Color {
    switch status {
    case "pass": return ADEColor.success
    case "fail": return ADEColor.danger
    case "pending": return ADEColor.warning
    default: return ADEColor.textSecondary.opacity(0.5)
    }
  }

  var body: some View {
    Circle()
      .fill(tint)
      .frame(width: size, height: size)
      .shadow(color: tint.opacity(status == "none" ? 0 : 0.55), radius: size * 0.6)
  }
}

#Preview("PrCommitDot") {
  HStack(spacing: 10) {
    PrCommitDot(status: "pass")
    PrCommitDot(status: "fail")
    PrCommitDot(status: "pending")
    PrCommitDot(status: "none")
  }
  .padding()
  .background(ADEColor.pageBackground)
}

enum PrBotProvider: String {
  case coderabbit
  case greptile
  case codecov
  case sourcery
  case seer
  case claude
  case copilot
}

func prBotProvider(from author: String?) -> PrBotProvider? {
  guard let author else { return nil }
  let normalized = author.lowercased()
  if normalized.contains("coderabbit") { return .coderabbit }
  if normalized.contains("greptileai") || normalized.contains("greptile") { return .greptile }
  if normalized.contains("codecov") { return .codecov }
  if normalized.contains("sourcery-ai") || normalized.contains("sourcery") { return .sourcery }
  if normalized.contains("seer-by-sentry") || normalized.contains("sentry") { return .seer }
  if normalized.contains("claude-ai[bot]") || normalized.contains("claude[bot]") { return .claude }
  if normalized.contains("github-copilot") || normalized.contains("copilot[bot]") { return .copilot }
  return nil
}

func prBotDisplayName(_ provider: PrBotProvider) -> String {
  switch provider {
  case .coderabbit: return "CodeRabbit"
  case .greptile: return "Greptile"
  case .codecov: return "Codecov"
  case .sourcery: return "Sourcery"
  case .seer: return "Seer"
  case .claude: return "Claude"
  case .copilot: return "Copilot"
  }
}

func prBotLetter(_ provider: PrBotProvider) -> String {
  switch provider {
  case .coderabbit: return "R"
  case .greptile: return "G"
  case .codecov: return "V"
  case .sourcery: return "Y"
  case .seer: return "S"
  case .claude: return "C"
  case .copilot: return "P"
  }
}

#Preview("PrBotProvider") {
  VStack(alignment: .leading, spacing: 6) {
    ForEach(["coderabbit", "greptileai", "codecov", "sourcery-ai", "seer-by-sentry", "claude[bot]", "github-copilot"], id: \.self) { login in
      if let provider = prBotProvider(from: login) {
        Text("\(login) → \(prBotDisplayName(provider)) (\(prBotLetter(provider)))")
          .font(.footnote.monospaced())
          .foregroundColor(ADEColor.textPrimary)
      }
    }
  }
  .padding()
  .background(ADEColor.pageBackground)
}

struct PrMonoText: View {
  let text: String
  var color: Color = ADEColor.textSecondary
  var size: CGFloat = 11

  var body: some View {
    Text(text)
      .font(.system(size: size, design: .monospaced))
      .foregroundColor(color)
  }
}

#Preview("PrMonoText") {
  VStack(alignment: .leading, spacing: 4) {
    PrMonoText(text: "feat/prs-overhaul → main")
    PrMonoText(text: "a1b2c3d · 12 commits", color: ADEColor.tintPRs)
  }
  .padding()
  .background(ADEColor.pageBackground)
}

struct PrStickyActionBar<Content: View>: View {
  @ViewBuilder let content: () -> Content

  init(@ViewBuilder content: @escaping () -> Content) {
    self.content = content
  }

  var body: some View {
    HStack(spacing: 8) {
      content()
    }
    .padding(12)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .strokeBorder(ADEColor.glassBorder, lineWidth: 0.5)
    )
    .padding(.horizontal, 12)
    .padding(.bottom, 8)
  }
}

#Preview("PrStickyActionBar") {
  VStack {
    Spacer()
    PrStickyActionBar {
      Button("Merge") {}
        .buttonStyle(.borderedProminent)
      Button("Close") {}
        .buttonStyle(.bordered)
    }
  }
  .frame(maxWidth: .infinity, maxHeight: .infinity)
  .background(ADEColor.pageBackground)
}

// MARK: - PrGlassDialog
//
// Centered modal dialog used to replace iOS `confirmationDialog`/`alert` with
// a brand-consistent liquid-glass card. Presented via `.prGlassDialog(...)`
// below, which dims the backdrop and centers the dialog on iOS 17+.

struct PrGlassDialog<Actions: View>: View {
  let icon: Image?
  let iconTint: Color
  let title: String
  let message: String?
  @ViewBuilder let actions: () -> Actions

  init(
    icon: Image? = nil,
    iconTint: Color = PrGlassPalette.purple,
    title: String,
    message: String? = nil,
    @ViewBuilder actions: @escaping () -> Actions
  ) {
    self.icon = icon
    self.iconTint = iconTint
    self.title = title
    self.message = message
    self.actions = actions
  }

  var body: some View {
    VStack(spacing: 14) {
      if let icon {
        ZStack {
          Circle()
            .fill(iconTint.opacity(0.22))
            .frame(width: 56, height: 56)
          Circle()
            .strokeBorder(iconTint.opacity(0.45), lineWidth: 1)
            .frame(width: 56, height: 56)
          icon
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(iconTint)
        }
        .padding(.top, 4)
      }

      VStack(spacing: 6) {
        Text(title)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(PrGlassPalette.textPrimary)
          .multilineTextAlignment(.center)
        if let message, !message.isEmpty {
          Text(message)
            .font(.system(size: 13))
            .foregroundStyle(PrGlassPalette.textSecondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      HStack(spacing: 10) {
        actions()
      }
      .padding(.top, 4)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 22)
    .frame(maxWidth: 320)
    .background {
      ZStack {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(PrGlassPalette.cardFill.opacity(0.55))
        // Top-light highlight.
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(
            LinearGradient(
              colors: [Color.white.opacity(0.10), Color.white.opacity(0)],
              startPoint: .top,
              endPoint: .center
            )
          )
      }
    }
    .overlay(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
    )
    .shadow(color: PrGlassPalette.purpleDeep.opacity(0.40), radius: 22, x: 0, y: 8)
  }
}

private struct PrGlassDialogPresenter<DialogContent: View>: ViewModifier {
  @Binding var isPresented: Bool
  @ViewBuilder let dialog: () -> DialogContent

  func body(content: Content) -> some View {
    content.fullScreenCover(isPresented: $isPresented) {
      ZStack {
        Color.black.opacity(0.45)
          .ignoresSafeArea()
          .onTapGesture { isPresented = false }
        dialog()
          .padding(.horizontal, 24)
      }
      .presentationBackground(.clear)
    }
  }
}

extension View {
  func prGlassDialog<DialogContent: View>(
    isPresented: Binding<Bool>,
    @ViewBuilder dialog: @escaping () -> DialogContent
  ) -> some View {
    modifier(PrGlassDialogPresenter(isPresented: isPresented, dialog: dialog))
  }
}

#Preview("PrGlassDialog") {
  ZStack {
    PrGlassPalette.ink.ignoresSafeArea()
    PrGlassDialog(
      icon: Image(systemName: "arrow.triangle.merge"),
      iconTint: PrGlassPalette.purpleBright,
      title: "Merge this pull request?",
      message: "This will squash 4 commits and close the PR."
    ) {
      Button("Cancel") {}
        .buttonStyle(.bordered)
      Button("Merge") {}
        .buttonStyle(.borderedProminent)
    }
  }
}
