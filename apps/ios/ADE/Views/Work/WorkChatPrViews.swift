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
  /// How many pull requests this chat is linked to in total. `1` for the
  /// ordinary case; above that the badge carries the count so a second linked
  /// PR is discoverable without opening the sheet.
  var linkedCount: Int = 1
}

func workChatPrBadgeModel(
  tag: LanePrTag?,
  pr: PullRequestListItem?,
  summary: PrSummary? = nil,
  linkedCount: Int = 1
) -> WorkChatPrBadgeModel? {
  guard let tag else { return nil }
  return WorkChatPrBadgeModel(
    label: formatLanePrBadgeLabel(tag),
    title: tag.title,
    state: tag.state,
    checksStatus: pr?.checksStatus ?? summary?.checksStatus,
    checksReason: pr?.checksReason ?? summary?.checksReason,
    reviewStatus: pr?.reviewStatus ?? summary?.reviewStatus,
    updatedAt: tag.updatedAt,
    stack: tag.stack ?? pr?.stack ?? summary?.stack,
    linkedCount: max(1, linkedCount)
  )
}

struct WorkChatStackOffer: Equatable {
  let stackNumber: Int
  let siblings: [PullRequestListItem]
}

/// Siblings of the selected PR's GitHub stack that this chat could adopt. Nil
/// when the selected PR is not stacked, the session is unknown, or every
/// sibling is already linked to this or another chat.
func workChatStackOffer(
  selected: PullRequestListItem,
  catalog: [PullRequestListItem],
  sessionId: String
) -> WorkChatStackOffer? {
  guard let stack = selected.stack else { return nil }
  let trimmed = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  let linkedIds = Set(
    catalog.filter { ($0.chatSessionIds ?? []).contains(trimmed) }.map(\.id)
  )
  let siblings = catalog.filter { candidate in
    guard candidate.id != selected.id else { return false }
    guard candidate.stack?.number == stack.number else { return false }
    guard candidate.repoOwner.caseInsensitiveCompare(selected.repoOwner) == .orderedSame else { return false }
    guard candidate.repoName.caseInsensitiveCompare(selected.repoName) == .orderedSame else { return false }
    if linkedIds.contains(candidate.id) { return false }
    let claimedByOther = (candidate.chatSessionIds ?? []).contains { $0 != trimmed }
    return !claimedByOther
  }
  guard !siblings.isEmpty else { return nil }
  return WorkChatStackOffer(stackNumber: stack.number, siblings: siblings)
}

/// PRs a chat could link from its picker: everything in the catalog this chat
/// does not already show and no other chat claims.
func workChatLinkableCatalog(
  catalog: [PullRequestListItem],
  linked: [PullRequestListItem],
  sessionId: String
) -> [PullRequestListItem] {
  let trimmed = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
  let linkedIds = Set(linked.map(\.id))
  return catalog.filter { candidate in
    if linkedIds.contains(candidate.id) { return false }
    return !((candidate.chatSessionIds ?? []).contains { $0 != trimmed })
  }
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
      parts.append(badge.checksReason ?? noCIReasonText)
    } else if let checksStatus = badge.checksStatus, !checksStatus.isEmpty {
      parts.append("checks \(checksStatus)")
    }
    if let reviewStatus = badge.reviewStatus, !reviewStatus.isEmpty, reviewStatus != "none" {
      parts.append("review \(reviewStatus.replacingOccurrences(of: "_", with: " "))")
    }
    if let stack = badge.stack {
      parts.append("GitHub Stack \(stack.position) of \(stack.size)")
    }
    if badge.linkedCount > 1 {
      parts.append("\(badge.linkedCount) linked pull requests")
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
      // No text label: the chip is icon + CI glyph + state tint. Everything the
      // label used to say (PR number, state, CI state) is in
      // `accessibilityText`, which VoiceOver reads instead.
      Image(systemName: "arrow.triangle.pull")
        .font(.system(size: 13, weight: .semibold))
      if let stack = badge.stack {
        GitHubStackPositionBadge(stack: stack, compact: true)
      }
      if badge.linkedCount > 1 {
        Text("\(badge.linkedCount)")
          .font(.caption2.monospacedDigit().weight(.bold))
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
  /// Every pull request this chat is linked to, primary first. A chat is not
  /// capped at one PR: a lane can own several, and a PR opened on another lane
  /// can be linked to this session explicitly.
  var linkedPrs: [PullRequestListItem] = []
  /// Which row the sheet is showing. Nil means "whatever the resolver chose",
  /// which is the first row.
  var selectedPrId: String? = nil
  var onSelectPr: (String) -> Void = { _ in }
  /// GitHub stack siblings this chat could adopt, when the selected PR is
  /// stacked and unclaimed siblings remain.
  var stackOffer: WorkChatStackOffer? = nil
  /// PRs the "Link another PR" picker may offer.
  var linkablePrs: [PullRequestListItem] = []
  /// Whether link/unlink controls are available (host reachable, session known).
  var canLink: Bool = false
  var linkBusy: Bool = false
  var onLinkStack: () -> Void = {}
  var onDismissStackOffer: () -> Void = {}
  var onLinkPr: (String, Bool) -> Void = { _, _ in }
  var onUnlink: () -> Void = {}

  @State private var linkPickerOpen = false

  private var sheetTitle: String {
    guard let tag else { return "Pull request" }
    return "PR #\(tag.githubPrNumber) \(lanePrStateLabel(tag.state))"
  }

  private var githubUrl: String {
    (tag?.githubUrl ?? pr?.githubUrl ?? summary?.githubUrl ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// ADE-135: status and reason must come from the SAME source. Resolving them
  /// as two independent `??` chains let a status from `pr` be captioned with a
  /// stale sentence from `summary` — the reason no longer explaining the state
  /// it sits next to. Pick the source once, then read both off it.
  private var checks: (status: String?, reason: String?) {
    if let status = snapshot?.status { return (status.checksStatus, status.checksReason) }
    if let pr { return (pr.checksStatus, pr.checksReason) }
    if let summary { return (summary.checksStatus, summary.checksReason) }
    return (nil, nil)
  }

  private var checksStatus: String? { checks.status }

  private var checksReason: String? { checks.reason }

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
        VStack(alignment: .leading, spacing: 12) {
          prSwitcher
          if let tag {
            existingPrContent(tag)
          } else {
            emptyPrContent
          }
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

  /// State-coloured row of every linked PR. Hidden at one PR, because a
  /// switcher with a single option is pure noise.
  @ViewBuilder
  private var prSwitcher: some View {
    if linkedPrs.count > 1 {
      let activeId = selectedPrId ?? linkedPrs.first?.id
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(linkedPrs) { linked in
            let isActive = linked.id == activeId
            let tint = lanePullRequestTint(linked.state)
            Button {
              onSelectPr(linked.id)
            } label: {
              HStack(spacing: 6) {
                Circle()
                  .fill(tint)
                  .frame(width: 7, height: 7)
                Text(verbatim: "#\(linked.githubPrNumber)")
                  .font(.caption.monospacedDigit().weight(.semibold))
                Text(lanePrStateLabel(linked.state))
                  .font(.caption2)
                  .foregroundStyle(ADEColor.textSecondary)
              }
              .foregroundStyle(ADEColor.textPrimary)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .background(
                isActive ? tint.opacity(0.16) : ADEColor.surfaceBackground.opacity(0.6),
                in: Capsule(style: .continuous)
              )
              .overlay(
                Capsule(style: .continuous)
                  .stroke(isActive ? tint.opacity(0.55) : ADEColor.border.opacity(0.25), lineWidth: 0.8)
              )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
              "Pull request \(linked.githubPrNumber), \(lanePrStateLabel(linked.state))"
                + (isActive ? ", showing" : "")
            )
            .accessibilityAddTraits(isActive ? [.isSelected] : [])
          }
        }
        .padding(.horizontal, 18)
      }
      .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
      .padding(.top, 2)
    }
  }

  private func existingPrContent(_ tag: LanePrTag) -> some View {
    let branches = workChatPrBranches(pr: pr, summary: summary, tag: tag)
    let stateTint = workChatPrStateTint(tag.state)
    let branchTint = laneColor ?? stateTint

    return VStack(alignment: .leading, spacing: 12) {
      if let stackOffer {
        VStack(alignment: .leading, spacing: 8) {
          Label("Also in GitHub Stack #\(stackOffer.stackNumber)", systemImage: "square.stack.3d.up.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(stackOffer.siblings.map { "#\($0.githubPrNumber)" }.joined(separator: ", "))
            .font(.caption.monospacedDigit())
            .foregroundStyle(ADEColor.textSecondary)
          HStack(spacing: 8) {
            Button("Link stack", action: onLinkStack)
              .font(.caption.weight(.semibold))
              .disabled(linkBusy)
            Button("Not now", action: onDismissStackOffer)
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ADEColor.tintPRs.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
      }

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

      if canLink {
        if linkPickerOpen {
          VStack(alignment: .leading, spacing: 8) {
            Text("Link another PR")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
            if linkablePrs.isEmpty {
              Text("No other unclaimed pull requests.")
                .font(.caption)
                .foregroundStyle(ADEColor.textMuted)
            } else {
              ForEach(Array(linkablePrs.prefix(8))) { candidate in
                Button {
                  onLinkPr(candidate.id, candidate.laneId != (pr?.laneId ?? ""))
                } label: {
                  HStack {
                    Text("#\(candidate.githubPrNumber)")
                      .font(.caption.monospacedDigit())
                      .foregroundStyle(ADEColor.textSecondary)
                    Text(candidate.title)
                      .font(.caption)
                      .foregroundStyle(ADEColor.textPrimary)
                      .lineLimit(1)
                  }
                }
                .buttonStyle(.plain)
                .disabled(linkBusy)
              }
            }
            Button("Cancel") { linkPickerOpen = false }
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
          }
          .padding(12)
          .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else {
          WorkChatPrActionButton(
            title: "Link another PR",
            symbol: "plus",
            tint: ADEColor.accent,
            action: { linkPickerOpen = true }
          )
        }
        WorkChatPrActionButton(
          title: "Unlink this PR",
          symbol: "minus.circle",
          tint: ADEColor.textSecondary,
          disabled: linkBusy,
          action: onUnlink
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
    return reason ?? noCIReasonText
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

/// What the PR Watch / Ship chip shows for the chat's open PR.
struct WorkChatPrWatchModel: Equatable {
  let prNumber: Int
  /// `"watch"`, `"ship"`, or nil for Off.
  let mode: String?
  /// Ship: news found and held until CI and the review bots finish.
  let holding: Bool
  let lastToldAt: String?
  let lastToldSummary: String?
  let armedByAgent: Bool
  let busy: Bool
  let error: String?

  var systemImage: String {
    switch mode {
    case "ship": return "paperplane.fill"
    case "watch": return "eye.fill"
    default: return "eye.slash"
    }
  }

  /// One short line, only while a watch is on (desktop `PrWatchPill.statusLine`).
  func statusLine(now: Date = Date()) -> String? {
    guard mode != nil else { return nil }
    if holding { return "Holding for CI and reviews" }
    let by = armedByAgent ? " · on by agent" : ""
    if let summary = lastToldSummary, !summary.isEmpty,
       let told = workPrWatchRelativeTime(lastToldAt, now: now) {
      return "Told \(told): \(summary)\(by)"
    }
    return "No changes yet\(by)"
  }
}

func workPrWatchRelativeTime(_ iso: String?, now: Date = Date()) -> String? {
  guard let iso, let date = workParsedDate(iso) else { return nil }
  let seconds = now.timeIntervalSince(date)
  guard seconds.isFinite, seconds >= 0 else { return nil }
  let minutes = Int((seconds / 60).rounded())
  if minutes < 1 { return "just now" }
  if minutes < 60 { return "\(minutes)m ago" }
  let hours = Int((Double(minutes) / 60).rounded())
  if hours < 24 { return "\(hours)h ago" }
  return "\(Int((Double(hours) / 24).rounded()))d ago"
}

/// Icon-only Off / Watch / Ship beside the composer PR chip (desktop
/// `PrWatchPill`). Watch wakes the agent with PR news; Ship adds standing
/// orders to land it.
struct WorkChatPrWatchChip: View {
  let model: WorkChatPrWatchModel
  let onSelect: (String?) -> Void

  @State private var pulse = false

  private var tint: Color {
    switch model.mode {
    case "ship": return ADEColor.warning
    case "watch": return Color.blue
    default: return ADEColor.textMuted
    }
  }

  private static let choices: [(mode: String?, label: String, hint: String)] = [
    (nil, "Off", "Cards only"),
    ("watch", "Watch", "Wake on changes"),
    ("ship", "Ship", "Fix and merge"),
  ]

  private var modeName: String {
    switch model.mode {
    case "ship": return "shipping"
    case "watch": return "watching"
    default: return "off"
    }
  }

  var body: some View {
    Menu {
      // Written bottom-up: the menu opens upward from the composer row.
      if let error = model.error {
        Section { Text(error) }
      }
      if let status = model.statusLine() {
        Section { Text(status) }
      }
      Section("PR #\(model.prNumber)") {
        ForEach(Self.choices.reversed(), id: \.label) { choice in
          Button {
            guard choice.mode != model.mode else { return }
            ADEHaptics.light()
            onSelect(choice.mode)
          } label: {
            if choice.mode == model.mode {
              Label("\(choice.label) — \(choice.hint)", systemImage: "checkmark")
            } else {
              Text("\(choice.label) — \(choice.hint)")
            }
          }
        }
      }
    } label: {
      HStack(spacing: 4) {
        if model.busy {
          ProgressView().controlSize(.mini)
        } else {
          Image(systemName: model.systemImage)
            .font(.system(size: 12, weight: .semibold))
        }
        if model.holding {
          Circle()
            .fill(ADEColor.warning)
            .frame(width: 5, height: 5)
            .opacity(pulse ? 0.35 : 1)
            .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
            .onAppear { pulse = true }
            .accessibilityHidden(true)
        }
        Image(systemName: "chevron.down")
          .font(.system(size: 8, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 9)
      .frame(minHeight: workChatComposerChipRowHeight)
      .workChatGlass(in: Capsule(style: .continuous), interactive: true)
      .overlay(Capsule(style: .continuous).stroke(tint.opacity(0.24), lineWidth: 0.75))
      .contentShape(Capsule(style: .continuous))
    }
    .disabled(model.busy)
    .accessibilityLabel(
      ["PR #\(model.prNumber) watch: \(modeName)", model.statusLine()].compactMap { $0 }.joined(separator: ". ")
    )
    .accessibilityIdentifier("Work.Chat.PrWatch")
  }
}
