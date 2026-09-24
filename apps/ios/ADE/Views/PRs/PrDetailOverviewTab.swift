import SwiftUI
import UIKit

// MARK: - Overview thread row components (desktop Timeline+Rails parity)
//
// The Overview tab used to render ONE monolithic `PrUnifiedOverviewThread`
// view inside a single List row, which defeated list virtualization and was
// the primary source of scroll lag on long PRs. It is now a set of standalone
// row components that `PrDetailScreen.overviewThreadRows` emits as SIBLING
// List rows:
//
//   unmapped banner → description → chronological event feed →
//   review threads → composer → metadata cards (people / stack / cleanup).
//
// The merge bar and requirement chips live in `PrDetailRedesign.swift`.
//
// All surfaces use the flat adaptive PR tokens (`PrGlassPalette` /
// `prGlassCard`) — no materials, no blend modes, no blur.

/// The record of how a PR shipped, and of the lane it outlived.
struct PrShippedFacts {
  var mergedByLogin: String?
  var mergeMethod: String?
  var mergedAt: String?
  var createdAt: String?
  var commitCount: Int?
  var changedFiles: Int?
  var detached: PrDetachedLane?

  /// `by arul · squash · 3 Jan`
  var attributionLine: String? {
    var parts: [String] = []
    var attribution: [String] = []
    if let login = mergedByLogin, !login.isEmpty { attribution.append(login) }
    if let method = mergeMethod, !method.isEmpty { attribution.append(method) }
    if !attribution.isEmpty { parts.append("by \(attribution.joined(separator: " · "))") }
    if let mergedAt, prParsedDate(mergedAt) != nil { parts.append(prAbsoluteTime(mergedAt)) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  /// `12 commits · 9 files · open 2d 4h`
  var sizeLine: String? {
    var parts: [String] = []
    if let commitCount { parts.append("\(commitCount) commit\(commitCount == 1 ? "" : "s")") }
    if let changedFiles { parts.append("\(changedFiles) file\(changedFiles == 1 ? "" : "s")") }
    if let open = openDuration { parts.append("open \(open)") }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  /// `was: auto-naming · 3 chats · 2 proof`
  var provenanceLine: String? {
    guard let detached, let name = detached.laneName, !name.isEmpty else { return nil }
    var parts = ["was: \(name)"]
    if detached.chats > 0 { parts.append("\(detached.chats) chat\(detached.chats == 1 ? "" : "s")") }
    if detached.artifacts > 0 { parts.append("\(detached.artifacts) proof") }
    return parts.joined(separator: " · ")
  }

  /// "2d 4h" / "5h" / "12m" — how long the PR was open before it merged.
  private var openDuration: String? {
    guard let start = prParsedDate(createdAt), let end = prParsedDate(mergedAt), end > start else { return nil }
    let minutes = Int((end.timeIntervalSince(start) / 60).rounded())
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    let days = hours / 24
    let remainder = hours % 24
    return remainder > 0 ? "\(days)d \(remainder)h" : "\(days)d"
  }

  var isEmpty: Bool {
    attributionLine == nil && sizeLine == nil && provenanceLine == nil
  }
}

// MARK: - Metadata cards

/// People card — author, reviewers with state, labels, assignees, and linked
/// issues (desktop right-rail People + Development cards).
struct PrOverviewPeopleCard: View {
  let detail: PrDetail?
  let reviews: [PrReview]
  let authorLogin: String?

  private struct ReviewerEntry: Identifiable {
    let id: String
    let login: String
    let stateLabel: String
    let stateTint: Color
  }

  private var reviewerEntries: [ReviewerEntry] {
    // A requested reviewer may already have a submitted review (re-request,
    // stale request list) — the submitted state must win over "pending".
    var latestReviewByReviewer: [String: PrReview] = [:]
    for review in reviews where prBotProvider(from: review.reviewer) == nil {
      latestReviewByReviewer[review.reviewer] = review
    }

    func reviewedEntry(_ review: PrReview) -> ReviewerEntry {
      switch review.state {
      case "approved":
        return ReviewerEntry(id: "rev-\(review.reviewer)", login: review.reviewer, stateLabel: "approved", stateTint: ADEColor.success)
      case "changes_requested":
        return ReviewerEntry(id: "rev-\(review.reviewer)", login: review.reviewer, stateLabel: "changes", stateTint: ADEColor.danger)
      default:
        return ReviewerEntry(id: "rev-\(review.reviewer)", login: review.reviewer, stateLabel: "commented", stateTint: ADEColor.textSecondary)
      }
    }

    var seen = Set<String>()
    var entries: [ReviewerEntry] = []
    for user in detail?.requestedReviewers ?? [] where seen.insert(user.login).inserted {
      if let review = latestReviewByReviewer[user.login] {
        entries.append(reviewedEntry(review))
      } else {
        entries.append(ReviewerEntry(id: "req-\(user.login)", login: user.login, stateLabel: "pending", stateTint: ADEColor.warning))
      }
    }
    for review in reviews {
      // Dict membership doubles as the bot filter — only human reviewers were indexed.
      guard let latest = latestReviewByReviewer[review.reviewer],
            seen.insert(review.reviewer).inserted else { continue }
      entries.append(reviewedEntry(latest))
    }
    return entries
  }

  var body: some View {
    let labels = detail?.labels ?? []
    let assignees = detail?.assignees ?? []
    let linkedIssues = detail?.linkedIssues ?? []
    let reviewers = reviewerEntries

    VStack(alignment: .leading, spacing: 0) {
      PrSectionHdr(title: "People")

      if let authorLogin, !authorLogin.isEmpty {
        peopleRow(login: authorLogin, roleLabel: "author", roleTint: ADEColor.textSecondary)
      }
      ForEach(reviewers) { reviewer in
        peopleRow(login: reviewer.login, roleLabel: reviewer.stateLabel, roleTint: reviewer.stateTint)
      }
      ForEach(assignees) { assignee in
        peopleRow(login: assignee.login, roleLabel: "assignee", roleTint: ADEColor.info)
      }

      if !labels.isEmpty {
        Divider().background(PrGlassPalette.cardBorder)
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(labels) { label in
              let tint = prLabelColor(label.color)
              Text(label.name)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(tint)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule(style: .continuous).fill(tint.opacity(0.14)))
                .overlay(Capsule(style: .continuous).strokeBorder(tint.opacity(0.35), lineWidth: 0.5))
            }
          }
          .padding(.horizontal, 14)
        }
        .padding(.vertical, 10)
      }

      if !linkedIssues.isEmpty {
        Divider().background(PrGlassPalette.cardBorder)
        ForEach(linkedIssues) { issue in
          HStack(spacing: 8) {
            Image(systemName: issue.state == "closed" ? "checkmark.circle" : "smallcircle.filled.circle")
              .font(.system(size: 11))
              .foregroundStyle(issue.state == "closed" ? ADEColor.accent : ADEColor.success)
            Text("#\(issue.number)")
              .font(.system(size: 11, weight: .semibold, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
            Text(issue.title)
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
        }
      }
    }
    .padding(.bottom, 6)
    .prGlassCard(cornerRadius: 16)
  }

  private func peopleRow(login: String, roleLabel: String, roleTint: Color) -> some View {
    HStack(spacing: 10) {
      ZStack {
        Circle().fill(ADEColor.accent.opacity(0.14))
        Circle().strokeBorder(ADEColor.accent.opacity(0.3), lineWidth: 0.5)
        Text(String(login.prefix(1)).uppercased())
          .font(.system(size: 10, weight: .heavy))
          .foregroundStyle(ADEColor.accent)
      }
      .frame(width: 24, height: 24)
      Text(login)
        .font(.system(size: 12.5, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 8)
      PrTagChip(label: roleLabel, color: roleTint)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 7)
  }
}

/// Parses a GitHub label hex string (e.g. "d73a4a") into a Color; falls back
/// to the accent for malformed values.
func prLabelColor(_ hex: String) -> Color {
  var value: UInt64 = 0
  let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
  guard cleaned.count == 6, Scanner(string: cleaned).scanHexInt64(&value) else {
    return ADEColor.accent
  }
  return Color(
    red: Double((value >> 16) & 0xFF) / 255,
    green: Double((value >> 8) & 0xFF) / 255,
    blue: Double(value & 0xFF) / 255
  )
}

/// Stack card — sibling PRs in the same lane chain.
struct PrOverviewStackCard: View {
  let groupMembers: [PrGroupMemberSummary]
  let groupId: String
  let laneName: String?
  let isLive: Bool
  let onOpenStack: (String, String?) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      PrSectionHdr(title: "Stack") {
        Text("\(groupMembers.count) PRs")
      }

      VStack(alignment: .leading, spacing: 8) {
        ForEach(groupMembers) { member in
          HStack(spacing: 10) {
            Text("\(member.position + 1)")
              .font(.caption.weight(.bold))
              .foregroundStyle(ADEColor.accent)
              .frame(width: 22, height: 22)
              .background(ADEColor.accent.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
              Text(member.title)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
              Text("#\(member.githubPrNumber) · \(member.headBranch) → \(member.baseBranch)")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
          }
        }

        Button("Open stack") {
          onOpenStack(groupId, laneName)
        }
        .buttonStyle(.glass)
        .disabled(!isLive)
      }
      .padding(.horizontal, 14)
      .padding(.bottom, 12)
    }
    .prGlassCard(cornerRadius: 16)
  }
}

struct PrOverviewGitHubStackCard: View {
  let stack: GitHubPrStackMembership
  let prNumber: Int
  let onOpenGitHub: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrSectionHdr(title: "GitHub stack") {
        Text("\(stack.position) of \(stack.size)")
      }

      HStack(alignment: .top, spacing: 12) {
        VStack(spacing: 3) {
          ForEach(Array((1...max(stack.size, 1)).reversed()), id: \.self) { position in
            Circle()
              .fill(position == stack.position ? ADEColor.tintPRs : ADEColor.textMuted.opacity(0.35))
              .frame(width: position == stack.position ? 10 : 6, height: position == stack.position ? 10 : 6)
              .overlay {
                if position == stack.position {
                  Circle().stroke(Color.white.opacity(0.45), lineWidth: 1)
                }
              }
            if position > 1 {
              Rectangle()
                .fill(ADEColor.tintPRs.opacity(0.25))
                .frame(width: 2, height: 14)
            }
          }
        }
        .frame(width: 18)

        VStack(alignment: .leading, spacing: 6) {
          GitHubStackPositionBadge(stack: stack)
          Text("PR #\(prNumber) is position \(stack.position) of \(stack.size), based on \(stack.baseBranch).")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
          Text("GitHub manages stack-wide review, rebase, and merge. Open the pull request to preview or merge the stack.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      Button(action: onOpenGitHub) {
        Label("Review and merge on GitHub", systemImage: "arrow.up.right.square")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.glassProminent)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .prGlassCard(cornerRadius: 16)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(
      "GitHub Stack \(stack.number), pull request \(stack.position) of \(stack.size), base \(stack.baseBranch)"
    )
  }
}

// MARK: - Shared helpers retained
//
// `PrDetailSectionCard` is shared with `PrDetailChecksTab`; `PrLaneCleanupBanner`
// is emitted by the Overview thread for merged PRs.

struct PrDetailSectionCard<Content: View>: View {
  let title: String
  let content: Content

  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      content
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct PrLaneCleanupBanner: View {
  let laneName: String?
  let isLive: Bool
  let onArchive: () -> Void
  let onDeleteBranch: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "trash.circle.fill")
          .foregroundStyle(ADEColor.warning)
        VStack(alignment: .leading, spacing: 4) {
          Text("Lane cleanup")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("\(laneName ?? "This lane") merged successfully. Clean it up now to archive it or delete its branch.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      HStack(spacing: 10) {
        Button("Archive lane") {
          onArchive()
        }
        .buttonStyle(.glass)
        .disabled(!isLive)

        Button("Delete branch", role: .destructive) {
          onDeleteBranch()
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.warning)
        .disabled(!isLive)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}
