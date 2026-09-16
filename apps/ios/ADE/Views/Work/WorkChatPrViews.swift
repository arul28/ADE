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

func workChatNormalizeBranch(_ value: String?) -> String {
  (value ?? "")
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: "^refs/heads/", with: "", options: [.regularExpression, .caseInsensitive])
    .lowercased()
}

func workChatSelectPrsForChat(
  _ prs: [PullRequestListItem],
  sessionId: String?,
  currentBranch: String?
) -> [PullRequestListItem] {
  let trimmed = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !trimmed.isEmpty else { return prs }
  let edged = prs.filter { ($0.chatSessionIds ?? []).contains(trimmed) }
  if !edged.isEmpty { return edged }
  let branch = workChatNormalizeBranch(currentBranch)
  return prs.filter { pr in
    if (pr.dismissedChatSessionIds ?? []).contains(trimmed) { return false }
    if !((pr.chatSessionIds ?? []).isEmpty) { return false }
    if branch.isEmpty { return true }
    let head = workChatNormalizeBranch(pr.headBranch)
    return head.isEmpty || head == branch
  }
}

struct WorkChatStackOffer: Equatable {
  let stackNumber: Int
  let siblings: [PullRequestListItem]
}

func workChatStackOffer(
  selected: PullRequestListItem,
  catalog: [PullRequestListItem],
  sessionId: String
) -> WorkChatStackOffer? {
  guard let stack = selected.stack else { return nil }
  let linkedIds = Set(
    catalog
      .filter { ($0.chatSessionIds ?? []).contains(sessionId) }
      .map(\.id)
  )
  let siblings = catalog.filter { candidate in
    guard candidate.id != selected.id else { return false }
    guard candidate.stack?.number == stack.number else { return false }
    guard candidate.repoOwner.caseInsensitiveCompare(selected.repoOwner) == .orderedSame else { return false }
    guard candidate.repoName.caseInsensitiveCompare(selected.repoName) == .orderedSame else { return false }
    if linkedIds.contains(candidate.id) { return false }
    let claimedByOther = (candidate.chatSessionIds ?? []).contains { $0 != sessionId }
    return !claimedByOther
  }
  guard !siblings.isEmpty else { return nil }
  return WorkChatStackOffer(stackNumber: stack.number, siblings: siblings)
}

func workChatRankPrFilesByChurn(_ files: [PrFile], limit: Int = 3) -> (files: [PrFile], remaining: Int) {
  let ranked = files.sorted { lhs, rhs in
    let left = lhs.additions + lhs.deletions
    let right = rhs.additions + rhs.deletions
    if left != right { return left > right }
    return lhs.filename < rhs.filename
  }
  let cap = max(0, limit)
  return (Array(ranked.prefix(cap)), max(0, ranked.count - cap))
}

func workChatLinkableCatalog(
  catalog: [PullRequestListItem],
  linked: [PullRequestListItem],
  sessionId: String
) -> [PullRequestListItem] {
  let linkedIds = Set(linked.map(\.id))
  return catalog.filter { candidate in
    if linkedIds.contains(candidate.id) { return false }
    return !((candidate.chatSessionIds ?? []).contains { $0 != sessionId })
  }
}

private func workChatFilePeekLabel(_ filename: String) -> String {
  let parts = filename.split(separator: "/").filter { !$0.isEmpty }
  if parts.count <= 2 { return parts.map(String.init).joined(separator: "/") }
  return parts.suffix(2).map(String.init).joined(separator: "/")
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
  let linkedPrs: [PullRequestListItem]
  let selectedPrId: String?
  let stackOffer: WorkChatStackOffer?
  let linkablePrs: [PullRequestListItem]
  let canLink: Bool
  let linkBusy: Bool
  let laneColor: Color?
  let canCreate: Bool
  let createBlockedReason: String?
  let isRefreshing: Bool
  let errorMessage: String?
  let onRefresh: () -> Void
  let onCreate: () -> Void
  let onSelectPr: (String) -> Void
  let onOpenFiles: () -> Void
  let onOpenPrsTab: () -> Void
  let onOpenGitHub: () -> Void
  let onLinkStack: () -> Void
  let onDismissStackOffer: () -> Void
  let onLinkPr: (String, Bool) -> Void
  let onUnlink: () -> Void

  @State private var linkPickerOpen = false

  init(
    tag: LanePrTag?,
    pr: PullRequestListItem?,
    summary: PrSummary?,
    snapshot: PullRequestSnapshot?,
    linkedPrs: [PullRequestListItem] = [],
    selectedPrId: String? = nil,
    stackOffer: WorkChatStackOffer? = nil,
    linkablePrs: [PullRequestListItem] = [],
    canLink: Bool = false,
    linkBusy: Bool = false,
    laneColor: Color?,
    canCreate: Bool,
    createBlockedReason: String?,
    isRefreshing: Bool,
    errorMessage: String?,
    onRefresh: @escaping () -> Void,
    onCreate: @escaping () -> Void,
    onSelectPr: @escaping (String) -> Void = { _ in },
    onOpenFiles: @escaping () -> Void = {},
    onOpenPrsTab: @escaping () -> Void,
    onOpenGitHub: @escaping () -> Void,
    onLinkStack: @escaping () -> Void = {},
    onDismissStackOffer: @escaping () -> Void = {},
    onLinkPr: @escaping (String, Bool) -> Void = { _, _ in },
    onUnlink: @escaping () -> Void = {}
  ) {
    self.tag = tag
    self.pr = pr
    self.summary = summary
    self.snapshot = snapshot
    self.linkedPrs = linkedPrs
    self.selectedPrId = selectedPrId
    self.stackOffer = stackOffer
    self.linkablePrs = linkablePrs
    self.canLink = canLink
    self.linkBusy = linkBusy
    self.laneColor = laneColor
    self.canCreate = canCreate
    self.createBlockedReason = createBlockedReason
    self.isRefreshing = isRefreshing
    self.errorMessage = errorMessage
    self.onRefresh = onRefresh
    self.onCreate = onCreate
    self.onSelectPr = onSelectPr
    self.onOpenFiles = onOpenFiles
    self.onOpenPrsTab = onOpenPrsTab
    self.onOpenGitHub = onOpenGitHub
    self.onLinkStack = onLinkStack
    self.onDismissStackOffer = onDismissStackOffer
    self.onLinkPr = onLinkPr
    self.onUnlink = onUnlink
  }

  private var sheetTitle: String {
    if linkedPrs.count > 1 { return "Pull requests" }
    guard let tag else { return "Pull request" }
    return "#\(tag.githubPrNumber)"
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

  private var peekFiles: (files: [PrFile], remaining: Int) {
    workChatRankPrFilesByChurn(snapshot?.files ?? [])
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
    VStack(alignment: .leading, spacing: 10) {
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

      if linkedPrs.count > 1 {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(linkedPrs) { candidate in
              Button {
                onSelectPr(candidate.id)
              } label: {
                Text("#\(candidate.githubPrNumber)")
                  .font(.caption.weight(.semibold).monospacedDigit())
                  .foregroundStyle(candidate.id == selectedPrId ? ADEColor.textPrimary : ADEColor.textSecondary)
                  .padding(.horizontal, 9)
                  .padding(.vertical, 5)
                  .background(
                    ADEColor.surfaceBackground.opacity(candidate.id == selectedPrId ? 0.95 : 0.45),
                    in: Capsule(style: .continuous)
                  )
                  .overlay(
                    Capsule(style: .continuous)
                      .stroke(ADEColor.glassBorder.opacity(candidate.id == selectedPrId ? 0.9 : 0.45), lineWidth: 0.7)
                  )
              }
              .buttonStyle(.plain)
              .accessibilityLabel("Show pull request #\(candidate.githubPrNumber)")
            }
          }
        }
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
    let ranked = peekFiles

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
          Text("Merge and rebase this stack on the PRs tab.")
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

      if !ranked.files.isEmpty {
        VStack(alignment: .leading, spacing: 7) {
          Label("Files", systemImage: "doc.text")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
          ForEach(ranked.files) { file in
            HStack {
              Text(workChatFilePeekLabel(file.filename))
                .font(.caption.monospaced())
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
              Spacer(minLength: 8)
              Text("+\(file.additions)")
                .foregroundStyle(ADEColor.success)
              Text("-\(file.deletions)")
                .foregroundStyle(ADEColor.danger)
            }
            .font(.caption.monospacedDigit())
          }
          if ranked.remaining > 0 {
            Text("+\(ranked.remaining) more files")
              .font(.caption)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      }

      if let errorMessage, !errorMessage.isEmpty {
        Text(errorMessage)
          .font(.footnote)
          .foregroundStyle(ADEColor.danger)
      }

      HStack(spacing: 10) {
        WorkChatPrActionButton(
          title: ranked.files.isEmpty ? "Open files" : "Open files on PRs tab",
          symbol: "doc.text",
          tint: ADEColor.accent,
          prominent: true,
          action: onOpenFiles
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
