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

private let prRelativeFormatter: RelativeDateTimeFormatter = {
  let formatter = RelativeDateTimeFormatter()
  formatter.unitsStyle = .abbreviated
  return formatter
}()

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
  case .commit: return "arrow.triangle.branch"
  case .ciRun: return "checklist.checked"
  case .reviewRequest: return "person.badge.clock"
  case .deployment: return "shippingbox.fill"
  case .forcePush: return "bolt.horizontal.circle.fill"
  case .labelUpdate: return "tag.fill"
  }
}

func timelineTint(_ kind: PrTimelineEventKind) -> Color {
  switch kind {
  case .stateChange: return ADEColor.success
  case .review: return ADEColor.accent
  case .comment: return ADEColor.warning
  case .commit: return ADEColor.textSecondary
  case .ciRun: return ADEColor.accent
  case .reviewRequest: return ADEColor.warning
  case .deployment: return ADEColor.success
  case .forcePush: return ADEColor.danger
  case .labelUpdate: return ADEColor.accent
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

extension View {
  func prListRow() -> some View {
    listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
  }
}
