import SwiftUI

struct WorkChatPrBadgeModel: Equatable {
  let label: String
  let title: String
  let state: String
  let checksStatus: String?
  /// Host-supplied explanation for a non-obvious checks rollup (ADE-135).
  let checksReason: String?
  let reviewStatus: String?
  let updatedAt: String
  let stack: GitHubPrStackMembership?
}

func workChatPrBadgeModel(tag: LanePrTag?, pr: PullRequestListItem?, summary: PrSummary? = nil) -> WorkChatPrBadgeModel? {
  guard let tag else { return nil }
  return WorkChatPrBadgeModel(
    label: formatLanePrBadgeLabel(tag),
    title: tag.title,
    state: tag.state,
    checksStatus: pr?.checksStatus ?? summary?.checksStatus,
    checksReason: pr?.checksReason ?? summary?.checksReason,
    reviewStatus: pr?.reviewStatus ?? summary?.reviewStatus,
    updatedAt: tag.updatedAt,
    stack: tag.stack ?? pr?.stack ?? summary?.stack
  )
}

struct WorkChatPrActivePopup: View {
  let badge: WorkChatPrBadgeModel
  let onOpen: () -> Void

  private var tint: Color {
    lanePullRequestTint(badge.state)
  }

  /// ADE-135: `notRun` draws a hollow dashed ring rather than a symbol, so an
  /// absent CI result never borrows the vocabulary of a pass or a failure.
  private enum CiGlyph: Equatable {
    case symbol(String)
    case notRun
  }

  private var ciGlyph: CiGlyph? {
    switch badge.checksStatus {
    case "passing":
      return .symbol("checkmark.circle.fill")
    case "failing":
      return .symbol("xmark.circle.fill")
    case "pending":
      return .symbol("clock.fill")
    case "not_run":
      return .notRun
    default:
      return nil
    }
  }

  private var accessibilityText: String {
    var parts = [badge.label, lanePrStateLabel(badge.state)]
    if badge.checksStatus == "not_run" {
      parts.append(badge.checksReason ?? "No CI has run on this commit.")
    } else if let checksStatus = badge.checksStatus, !checksStatus.isEmpty {
      parts.append("checks \(checksStatus)")
    }
    if let reviewStatus = badge.reviewStatus, !reviewStatus.isEmpty, reviewStatus != "none" {
      parts.append("review \(reviewStatus.replacingOccurrences(of: "_", with: " "))")
    }
    if let stack = badge.stack {
      parts.append("GitHub Stack \(stack.position) of \(stack.size)")
    }
    return parts.joined(separator: ", ") + ". Tap for details."
  }

  var body: some View {
    WorkComposerBadgeCapsule(
      tint: tint,
      strokeOpacity: 0.24,
      accessibilityLabel: accessibilityText,
      onOpen: onOpen
    ) {
      Image(systemName: "arrow.triangle.pull")
        .font(.system(size: 12, weight: .semibold))
      Text(badge.label)
        .font(.caption.weight(.semibold))
        .lineLimit(1)
      if let stack = badge.stack {
        GitHubStackPositionBadge(stack: stack, compact: true)
      }
      if let ciGlyph {
        switch ciGlyph {
        case let .symbol(name):
          Image(systemName: name)
            .font(.system(size: 10, weight: .bold))
        case .notRun:
          Circle()
            .strokeBorder(
              ADEColor.textSecondary,
              style: StrokeStyle(lineWidth: 1.2, lineCap: .round, dash: [2.0, 2.4])
            )
            .frame(width: 11, height: 11)
        }
      }
    }
  }
}

struct WorkChatPrDetailsSheet: View {
  let tag: LanePrTag?
  let pr: PullRequestListItem?
  let summary: PrSummary?
  let snapshot: PullRequestSnapshot?
  let laneColor: Color?
  let canCreate: Bool
  let createBlockedReason: String?
  let isRefreshing: Bool
  let errorMessage: String?
  let onRefresh: () -> Void
  let onCreate: () -> Void
  let onOpenPrsTab: () -> Void
  let onOpenGitHub: () -> Void

  private var sheetTitle: String {
    guard let tag else { return "Pull request" }
    return "PR #\(tag.githubPrNumber) \(lanePrStateLabel(tag.state))"
  }

  private var githubUrl: String {
    (tag?.githubUrl ?? pr?.githubUrl ?? summary?.githubUrl ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var checksStatus: String? {
    snapshot?.status?.checksStatus ?? pr?.checksStatus ?? summary?.checksStatus
  }

  private var checksReason: String? {
    snapshot?.status?.checksReason ?? pr?.checksReason ?? summary?.checksReason
  }

  private var additions: Int {
    pr?.additions ?? summary?.additions ?? 0
  }

  private var deletions: Int {
    pr?.deletions ?? summary?.deletions ?? 0
  }

  var body: some View {
    VStack(spacing: 0) {
      topBar

      ScrollView {
        if let tag {
          existingPrContent(tag)
        } else {
          emptyPrContent
        }
      }
      .scrollIndicators(.hidden)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
  }

  private var topBar: some View {
    ZStack {
      Text(sheetTitle)
        .font(.headline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .padding(.horizontal, 58)

      HStack {
        Spacer()
        Button(action: onRefresh) {
          if isRefreshing {
            ProgressView()
              .controlSize(.small)
          } else {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 16, weight: .bold))
          }
        }
        .foregroundStyle(ADEColor.accent)
        .frame(width: 36, height: 36)
        .background(ADEColor.surfaceBackground.opacity(0.86), in: Circle())
        .overlay(Circle().stroke(ADEColor.glassBorder.opacity(0.8), lineWidth: 0.7))
        .disabled(isRefreshing)
        .accessibilityLabel("Refresh pull request details")
      }
    }
    .padding(.horizontal, 18)
    .padding(.top, 18)
    .padding(.bottom, 8)
  }

  private func existingPrContent(_ tag: LanePrTag) -> some View {
    let branches = workChatPrBranches(pr: pr, summary: summary, tag: tag)
    let stateTint = workChatPrStateTint(tag.state)
    let branchTint = laneColor ?? stateTint

    return VStack(alignment: .leading, spacing: 12) {
      WorkChatPrSummaryHeader(
        title: tag.title,
        updatedText: "Updated \(prRelativeTime(tag.updatedAt))",
        symbol: workChatPrStateSymbol(tag.state),
        tint: stateTint
      )

      WorkChatPrBranchFlowCard(
        headBranch: branches.head,
        baseBranch: branches.base,
        tint: branchTint
      )

      if let stack = tag.stack ?? pr?.stack ?? summary?.stack {
        HStack(spacing: 9) {
          GitHubStackPositionBadge(stack: stack)
          Text("GitHub manages review, rebase, and merge for this stack.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ADEColor.tintPRs.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
      }

      HStack(spacing: 10) {
        WorkChatPrChangesMetricCard(additions: additions, deletions: deletions)
        WorkChatPrChecksMetricCard(status: checksStatus, reason: checksReason)
      }

      if let errorMessage, !errorMessage.isEmpty {
        Text(errorMessage)
          .font(.footnote)
          .foregroundStyle(ADEColor.danger)
      }

      HStack(spacing: 10) {
        WorkChatPrActionButton(
          title: "Open in ADE",
          symbol: "rectangle.grid.1x2",
          tint: ADEColor.accent,
          prominent: true,
          action: onOpenPrsTab
        )

        WorkChatPrActionButton(
          title: "Open in GitHub",
          symbol: "link",
          tint: ADEColor.accent,
          disabled: githubUrl.isEmpty,
          action: onOpenGitHub
        )
      }
    }
    .padding(.horizontal, 18)
    .padding(.top, 6)
    .padding(.bottom, 18)
  }

  private var emptyPrContent: some View {
    VStack(alignment: .leading, spacing: 12) {
      WorkChatPrSummaryHeader(
        title: "No pull request yet",
        updatedText: "Create one from this lane or open PRs with the lane preselected.",
        symbol: "arrow.triangle.pull",
        tint: ADEColor.accent
      )

      if let createBlockedReason, !createBlockedReason.isEmpty {
        Text(createBlockedReason)
          .font(.footnote)
          .foregroundStyle(ADEColor.warning)
      }

      HStack(spacing: 10) {
        WorkChatPrActionButton(
          title: "Create PR",
          symbol: "plus",
          tint: ADEColor.accent,
          prominent: true,
          disabled: !canCreate,
          action: onCreate
        )

        WorkChatPrActionButton(
          title: "Open in ADE",
          symbol: "rectangle.grid.1x2",
          tint: ADEColor.accent,
          action: onOpenPrsTab
        )
      }

      if let errorMessage, !errorMessage.isEmpty {
        Text(errorMessage)
          .font(.footnote)
          .foregroundStyle(ADEColor.danger)
      }
    }
    .padding(.horizontal, 18)
    .padding(.top, 6)
    .padding(.bottom, 18)
  }
}

private struct WorkChatPrSummaryHeader: View {
  let title: String
  let updatedText: String
  let symbol: String
  let tint: Color

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbol)
        .font(.system(size: 18, weight: .bold))
        .foregroundStyle(tint)
        .frame(width: 38, height: 38)
        .background(tint.opacity(0.14), in: Circle())

      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.headline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
        Text(updatedText)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
      }

      Spacer(minLength: 0)
    }
  }
}

private struct WorkChatPrBranchFlowCard: View {
  let headBranch: String
  let baseBranch: String?
  let tint: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("Branch", systemImage: "arrow.triangle.branch")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)

      HStack(spacing: 8) {
        branchPill(headBranch, tint: tint, emphasized: true)
          .frame(maxWidth: .infinity, alignment: .leading)

        if let baseBranch, !baseBranch.isEmpty {
          Image(systemName: "arrow.right")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(tint)
          branchPill(baseBranch, tint: ADEColor.textSecondary, emphasized: false)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(tint.opacity(0.2), lineWidth: 0.8)
    )
  }

  private func branchPill(_ branch: String, tint: Color, emphasized: Bool) -> some View {
    Text(branch)
      .font(.caption.weight(.semibold))
      .foregroundStyle(emphasized ? tint : ADEColor.textPrimary)
      .lineLimit(1)
      .truncationMode(.middle)
      .padding(.horizontal, 9)
      .padding(.vertical, 6)
      .background(tint.opacity(emphasized ? 0.16 : 0.08), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(tint.opacity(emphasized ? 0.34 : 0.16), lineWidth: 0.7)
      )
  }
}

private struct WorkChatPrChangesMetricCard: View {
  let additions: Int
  let deletions: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Label("Changes", systemImage: "plus.forwardslash.minus")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)

      HStack(spacing: 8) {
        Text("+\(additions)")
          .foregroundStyle(ADEColor.success)
        Text("/").foregroundStyle(ADEColor.textMuted)
        Text("-\(deletions)")
          .foregroundStyle(ADEColor.danger)
      }
      .font(.headline.weight(.semibold))
      .lineLimit(1)
      .minimumScaleFactor(0.78)
    }
    .frame(maxWidth: .infinity, minHeight: 70, alignment: .leading)
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }
}

private struct WorkChatPrChecksMetricCard: View {
  let status: String?
  let reason: String?

  private var normalized: String {
    status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
  }

  private var tint: Color {
    workChatPrChecksTint(normalized)
  }

  /// "Not run" alone invites the reader to assume a transient state, so ADE-135
  /// carries the host's one-line explanation with it.
  private var detail: String? {
    guard normalized == "not_run" else { return nil }
    return reason ?? "No CI has run on this commit."
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Label("Checks", systemImage: workChatPrChecksSymbol(normalized))
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)

      Text(workChatPrChecksLabel(normalized))
        .font(.headline.weight(.semibold))
        .foregroundStyle(tint)
        .lineLimit(1)
        .minimumScaleFactor(0.78)

      if let detail {
        Text(detail)
          .font(.system(size: 10.5))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, minHeight: 70, alignment: .leading)
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(tint.opacity(0.16), lineWidth: 0.8)
    )
  }
}

private struct WorkChatPrActionButton: View {
  let title: String
  let symbol: String
  let tint: Color
  var prominent = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button {
      guard !disabled else { return }
      action()
    } label: {
      Label(title, systemImage: symbol)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(disabled ? ADEColor.textSecondary.opacity(0.45) : (prominent ? Color.white : tint))
        .lineLimit(1)
        .minimumScaleFactor(0.82)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11)
        .background(buttonBackground, in: Capsule(style: .continuous))
        .overlay(
          Capsule(style: .continuous)
            .stroke(disabled ? ADEColor.glassBorder.opacity(0.55) : tint.opacity(prominent ? 0 : 0.28), lineWidth: 0.8)
        )
    }
    .buttonStyle(.plain)
    .disabled(disabled)
  }

  private var buttonBackground: Color {
    if disabled {
      return ADEColor.surfaceBackground.opacity(0.45)
    }
    return prominent ? tint : tint.opacity(0.13)
  }
}

private func workChatPrBranches(pr: PullRequestListItem?, summary: PrSummary?, tag: LanePrTag) -> (head: String, base: String?) {
  if let pr {
    return (pr.headBranch, pr.baseBranch)
  }
  if let summary {
    return (summary.headBranch, summary.baseBranch)
  }
  let head = tag.headBranch.trimmingCharacters(in: .whitespacesAndNewlines)
  return (head.isEmpty ? "Branch unavailable" : head, nil)
}

private func workChatPrStateSymbol(_ state: String) -> String {
  switch state {
  case "merged":
    return "arrow.merge"
  case "closed":
    return "xmark.circle"
  default:
    return "arrow.triangle.pull"
  }
}

private func workChatPrStateTint(_ state: String) -> Color {
  switch state {
  case "open":
    return Color(red: 0x60 / 255, green: 0xA5 / 255, blue: 0xFA / 255)
  case "merged":
    return Color(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255)
  case "draft":
    return ADEColor.warning
  case "closed":
    return Color(red: 0xA1 / 255, green: 0xA1 / 255, blue: 0xAA / 255)
  default:
    return ADEColor.textSecondary
  }
}

private func workChatPrChecksSymbol(_ status: String) -> String {
  switch status {
  case "passing", "passed", "success":
    return "checkmark.circle.fill"
  case "failing", "failed", "failure", "error":
    return "xmark.circle.fill"
  case "pending", "queued", "running", "in_progress":
    return "clock.fill"
  // ADE-135: dashed circle, matching the hollow ring the PR row draws. Nothing
  // verified the commit, so the slot reads as empty rather than as a verdict.
  case "not_run":
    return "circle.dashed"
  default:
    return "circle"
  }
}

private func workChatPrChecksTint(_ status: String) -> Color {
  switch status {
  case "passing", "passed", "success":
    return ADEColor.success
  case "failing", "failed", "failure", "error":
    return ADEColor.danger
  case "pending", "queued", "running", "in_progress":
    return ADEColor.warning
  // Muted, never danger red: an absent result is a gap, not a red build.
  case "not_run":
    return ADEColor.textSecondary
  default:
    return ADEColor.textSecondary
  }
}

private func workChatPrChecksLabel(_ status: String) -> String {
  switch status {
  case "", "none", "unknown":
    return "None"
  case "not_run":
    return "Not run"
  case "passing", "passed", "success":
    return "Passing"
  case "failing", "failed", "failure", "error":
    return "Failing"
  case "pending", "queued", "running", "in_progress":
    return "Pending"
  default:
    return status
      .replacingOccurrences(of: "_", with: " ")
      .split(separator: " ")
      .map { word in
        word.prefix(1).uppercased() + String(word.dropFirst())
      }
      .joined(separator: " ")
  }
}
