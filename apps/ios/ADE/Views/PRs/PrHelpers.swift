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

func filterPullRequestListItems(
  _ items: [PullRequestListItem],
  query: String,
  state: PrListStateFilter
) -> [PullRequestListItem] {
  let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

  return items.filter { item in
    let matchesState: Bool = {
      switch state {
      case .all:
        return true
      case .open:
        return item.state == "open"
      case .draft:
        return item.state == "draft"
      case .closed:
        return item.state == "closed"
      case .merged:
        return item.state == "merged"
      }
    }()

    guard matchesState else { return false }
    guard !normalizedQuery.isEmpty else { return true }

    let haystack = [
      item.title,
      item.headBranch,
      item.baseBranch,
      item.laneName ?? "",
      item.adeKind ?? "",
      "#\(item.githubPrNumber)",
    ].joined(separator: " ").lowercased()

    return haystack.contains(normalizedQuery)
  }
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
  case "queue": return "ADE QUEUE"
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
  return prIsoFormatter.date(from: iso) ?? prIsoFallbackFormatter.date(from: iso)
}

func prRelativeTime(_ iso: String?) -> String {
  guard let date = prParsedDate(iso) else { return "unknown" }
  return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}

func prAbsoluteTime(_ iso: String?) -> String {
  guard let date = prParsedDate(iso) else { return "unknown" }
  let formatter = DateFormatter()
  formatter.dateStyle = .medium
  formatter.timeStyle = .short
  return formatter.string(from: date)
}

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

private final class PrMarkdownAttributedStringBox: NSObject {
  let value: AttributedString

  init(value: AttributedString) {
    self.value = value
  }
}
