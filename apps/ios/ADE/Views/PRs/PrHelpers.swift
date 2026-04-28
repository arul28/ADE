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

private let prRelativeFormatter = RelativeDateTimeFormatter()

private let prAbsoluteFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.dateStyle = .medium
  formatter.timeStyle = .short
  return formatter
}()

func matchedLaneForExactBranch(_ headBranch: String?, lanes: [LaneSummary]) -> LaneSummary? {
  guard let headBranch = headBranch?.trimmingCharacters(in: .whitespacesAndNewlines),
    !headBranch.isEmpty
  else {
    return nil
  }
  return lanes.first { lane in
    lane.branchRef.caseInsensitiveCompare(headBranch) == .orderedSame
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
  return prRelativeFormatter.localizedString(for: date, relativeTo: Date())
}

func prAbsoluteTime(_ iso: String?) -> String {
  guard let date = prParsedDate(iso) else { return "unknown" }
  return prAbsoluteFormatter.string(from: date)
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

// MARK: - PrGlassPalette extension (foundation tokens for the PRs overhaul).
//
// The base palette lives in `PrMergeGateCard.swift`. These additions are
// purely additive — they introduce the extra tokens the upcoming PRs tab
// overhaul needs (surface fills, text hierarchy, info accent, eyebrow tint,
// and a couple of alias names so future callers can use the spec vocabulary
// without renaming existing callsites). Do NOT rename existing tokens.

extension PrGlassPalette {
  // Surface fills.
  static let cardFill = Color(red: 0x14 / 255, green: 0x13 / 255, blue: 0x1C / 255)
  static let cardElevated = Color(red: 0x1B / 255, green: 0x1F / 255, blue: 0x26 / 255)

  // Text hierarchy (mirror the PrsGlass values so the two palettes stay in
  // sync without forcing callers to switch enums).
  static let textPrimary = Color(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF2 / 255)
  static let textSecondary = Color(red: 0xA8 / 255, green: 0xA8 / 255, blue: 0xB4 / 255)
  static let textMuted = Color(red: 0x5E / 255, green: 0x5A / 255, blue: 0x70 / 255)

  // Eyebrow tint (muted violet for section labels).
  static let eyebrow = Color(red: 0x8F / 255, green: 0x7B / 255, blue: 0xC7 / 255)

  // Info accent (soft blue, used for non-critical callouts).
  static let info = Color(red: 0x6B / 255, green: 0x8A / 255, blue: 0xFD / 255)

  // Aliases for spec vocabulary. `purpleSoft` = existing `purple`.
  static var purpleSoft: Color { purple }
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
    PrTagChip(label: "Queue", color: ADEColor.warning)
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
