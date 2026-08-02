import SwiftUI

struct PrRowCard: View {
  let data: Data
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool
  let onShowStack: (String, String?) -> Void

  init(
    pr: PullRequestListItem,
    transitionNamespace: Namespace.ID? = nil,
    isSelectedTransitionSource: Bool = false,
    onShowStack: @escaping (String, String?) -> Void = { _, _ in }
  ) {
    self.data = Data(pr: pr)
    self.transitionNamespace = transitionNamespace
    self.isSelectedTransitionSource = isSelectedTransitionSource
    self.onShowStack = onShowStack
  }

  init(
    item: GitHubPrListItem,
    linkedPr: PullRequestListItem? = nil,
    transitionNamespace: Namespace.ID? = nil,
    isSelectedTransitionSource: Bool = false
  ) {
    self.data = Data(item: item, linkedPr: linkedPr)
    self.transitionNamespace = transitionNamespace
    self.isSelectedTransitionSource = isSelectedTransitionSource
    self.onShowStack = { _, _ in }
  }

  var body: some View {
    let stateColors = PrRowDesktopPalette.stateColors(data.state)

    HStack(alignment: .top, spacing: 11) {
      Image(systemName: stateSymbol)
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(stateColors.text)
        .frame(width: 20, height: 22)

      VStack(alignment: .leading, spacing: 5) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text(data.title)
            .font(.body.weight(.semibold))
            .foregroundStyle(PrsGlass.textPrimary)
            .lineLimit(2)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-title-\(data.id)" : nil, in: transitionNamespace)

          if !data.timeAgo.isEmpty {
            Text(data.timeAgo)
              .font(.caption)
              .foregroundStyle(PrsGlass.textMuted)
              .lineLimit(1)
              .fixedSize(horizontal: true, vertical: false)
          }
        }

        metadataRow
        branchAndSignalsRow

        if !data.isUnmapped, let warnMessage = data.warnMessage {
          PrWarnBanner(text: warnMessage)
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      if isSelectedTransitionSource {
        LinearGradient(
          colors: [stateColors.background, Color.white.opacity(0.015)],
          startPoint: .leading,
          endPoint: .trailing
        )
      } else {
        Color.clear
      }
    }
    .overlay(alignment: .leading) {
      Rectangle()
        .fill(isSelectedTransitionSource ? stateColors.text : .clear)
        .frame(width: 3)
    }
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(Color.white.opacity(0.055))
        .frame(height: 1)
        .padding(.leading, 50)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilitySummary)
    .adeInspectable(
      "PR.List.Row",
      metadata: [
        "label": "PR #\(data.prNumber): \(data.title), state \(data.state)",
        "prId": data.id,
        "number": String(data.prNumber),
        "state": data.state,
        "title": data.title,
        "role": "row"
      ]
    )
  }

  private var stateSymbol: String {
    switch data.state {
    case "merged": return "arrow.triangle.merge"
    case "closed": return "xmark.circle"
    case "draft": return "circle.dashed"
    default: return "arrow.triangle.pull"
    }
  }

  private var accessibilitySummary: String {
    var parts = ["Pull request \(data.prNumber)", data.title, "State \(data.state)"]
    if let author = data.authorLogin, !author.isEmpty { parts.append("Author \(author)") }
    if let stack = data.githubStack {
      parts.append("GitHub Stack \(stack.position) of \(stack.size)")
    }
    if let head = data.headBranch, let base = data.baseBranch { parts.append("\(head) into \(base)") }
    if let ci = data.ciIndicator { parts.append(ci.title) }
    if let review = data.reviewIndicator { parts.append(review.label) }
    if data.commentCount > 0 { parts.append("\(data.commentCount) comments") }
    if data.isUnmapped {
      parts.append("Not mapped to an ADE lane")
    } else if let provenance = data.provenanceLabel {
      parts.append(provenance)
    } else if let lane = data.laneLabel {
      parts.append("Lane \(lane)")
    }
    if let facts = data.mergeFacts { parts.append("Merged \(facts)") }
    if data.needsBranchCleanup { parts.append("Remote branch still exists") }
    if !data.timeAgo.isEmpty { parts.append("Updated \(data.timeAgo)") }
    return parts.joined(separator: ", ")
  }

  private var metadataRow: some View {
    HStack(spacing: 5) {
      Text("#\(data.prNumber)")
        .foregroundStyle(PrRowDesktopPalette.stateColors(data.state).text)
      if let stack = data.githubStack {
        GitHubStackPositionBadge(stack: stack, compact: true)
      }
      if let author = data.authorLogin, !author.isEmpty {
        Text("·")
        Text("@\(author)")
      }
      if data.isBot {
        Text("bot")
          .fontWeight(.semibold)
      }
      if data.isExternal {
        Text("·")
        Text("\(data.repoOwner)/\(data.repoName)")
          .lineLimit(1)
      }
      if data.isUnmapped {
        // Neutral, not amber: an unmapped PR is a fact, not a problem. Amber is
        // reserved for the branch-cleanup chip, which is genuinely actionable.
        Text("Unmapped")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(PrsGlass.textMuted)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(
            Capsule(style: .continuous)
              .fill(PrsGlass.textMuted.opacity(0.12))
          )
          .fixedSize(horizontal: true, vertical: false)
      } else if let provenance = data.provenanceLabel {
        // The lane is gone, but what happened in it is not.
        Label(provenance, systemImage: "clock.arrow.circlepath")
          .font(.caption2)
          .foregroundStyle(PrsGlass.textMuted)
          .lineLimit(1)
      } else if let laneLabel = data.laneLabel, !laneLabel.isEmpty {
        Label(laneLabel, systemImage: "rectangle.stack")
          .font(.caption2.weight(.medium))
          .foregroundStyle(PrsGlass.textSecondary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .font(.caption)
    .foregroundStyle(PrsGlass.textMuted)
  }

  @ViewBuilder
  private var branchAndSignalsRow: some View {
    HStack(spacing: 10) {
      if data.isTerminal {
        // A merged PR is a record: how it shipped replaces the branch pair, and CI /
        // review outcomes are all answered by the fact that it merged.
        if let facts = data.mergeFacts {
          Text(facts)
            .font(.caption2)
            .foregroundStyle(PrsGlass.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .layoutPriority(1)
        }
      } else if let head = data.headBranch, let base = data.baseBranch {
        Text("\(head) → \(base)")
          .font(.caption2.monospaced())
          .foregroundStyle(PrsGlass.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .layoutPriority(1)
      }

      Spacer(minLength: 0)

      HStack(spacing: 9) {
        if data.needsBranchCleanup {
          Label("branch", systemImage: "arrow.triangle.branch")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(PrsGlass.draftTop)
            .accessibilityLabel("Remote branch still exists")
        }

        if !data.isTerminal, let ci = data.ciIndicator {
          PrRowCiGlyph(indicator: ci)
        }

        if !data.isTerminal, let review = data.reviewIndicator {
          Image(systemName: reviewSymbol)
            .foregroundStyle(review.color)
            .accessibilityLabel(review.label)
        }

        if data.commentCount > 0 {
          Label("\(data.commentCount)", systemImage: "text.bubble")
            .labelStyle(.titleAndIcon)
        }

        if let groupId = data.stackGroupId, let groupCount = data.stackGroupCount, groupCount > 0 {
          Button {
            onShowStack(groupId, data.stackGroupName)
          } label: {
            Label("\(groupCount)", systemImage: "list.number")
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Open stack of \(groupCount) pull requests")
        }
      }
      .fixedSize(horizontal: true, vertical: false)
    }
    .font(.caption2.weight(.medium))
    .foregroundStyle(PrsGlass.textMuted)
  }

  private var reviewSymbol: String {
    switch data.reviewStatus {
    case "approved": return "checkmark.bubble"
    case "changes_requested": return "exclamationmark.bubble"
    default: return "bubble.left.and.exclamationmark.bubble.right"
    }
  }
}

/// Renders the row's CI signal. Symbol states track the ambient caption font so
/// they stay aligned with the review glyph beside them; the `not_run` ring is
/// drawn at a fixed 13pt, which matches a filled `.caption2` symbol optically.
private struct PrRowCiGlyph: View {
  let indicator: PrRowCard.Data.CIIndicator

  var body: some View {
    switch indicator.glyph {
    case let .symbol(name):
      Image(systemName: name)
        .foregroundStyle(indicator.color)
        .accessibilityLabel(indicator.title)
    case .hollowRing:
      Circle()
        .strokeBorder(
          indicator.color,
          style: StrokeStyle(lineWidth: 1.3, lineCap: .round, dash: [2.2, 2.6])
        )
        .frame(width: 13, height: 13)
        // Shapes are not accessibility elements by default, so the ring has to be
        // promoted to one or the finding is invisible to VoiceOver.
        .accessibilityElement()
        .accessibilityLabel(indicator.title)
    }
  }
}

struct PrRowCardSkeleton: View {
  var body: some View {
    HStack(alignment: .top, spacing: 11) {
      ADESkeletonView(width: 20, height: 20, cornerRadius: 10)

      VStack(alignment: .leading, spacing: 7) {
        HStack(spacing: 10) {
          ADESkeletonView(height: 16, cornerRadius: 5)
          ADESkeletonView(width: 52, height: 12, cornerRadius: 4)
        }
        HStack(spacing: 8) {
          ADESkeletonView(width: 42, height: 11, cornerRadius: 4)
          ADESkeletonView(width: 86, height: 11, cornerRadius: 4)
          ADESkeletonView(width: 58, height: 16, cornerRadius: 8)
        }
        HStack(spacing: 10) {
          ADESkeletonView(width: 180, height: 10, cornerRadius: 4)
          Spacer(minLength: 0)
          ADESkeletonView(width: 42, height: 10, cornerRadius: 4)
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private enum PrRowDesktopPalette {
  struct StateColors {
    let background: Color
    let text: Color
  }

  static func stateColors(_ state: String) -> StateColors {
    switch state {
    case "open":
      return StateColors(
        background: Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255, opacity: 0.10),
        text: Color(red: 0x60 / 255, green: 0xA5 / 255, blue: 0xFA / 255)
      )
    case "draft":
      return StateColors(
        background: Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255, opacity: 0.10),
        text: Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
      )
    case "merged":
      return StateColors(
        background: Color(red: 0x22 / 255, green: 0xC5 / 255, blue: 0x5E / 255, opacity: 0.10),
        text: Color(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255)
      )
    default:
      return StateColors(
        background: Color(red: 0xA1 / 255, green: 0xA1 / 255, blue: 0xAA / 255, opacity: 0.08),
        text: Color(red: 0xA1 / 255, green: 0xA1 / 255, blue: 0xAA / 255)
      )
    }
  }
}

extension PrRowCard {
  struct Data {
    let id: String
    let prNumber: Int
    let title: String
    let state: String
    let updatedAt: String
    let headBranch: String?
    let baseBranch: String?
    let authorLogin: String?
    let isBot: Bool
    let commentCount: Int
    let repoOwner: String
    let repoName: String
    let isExternal: Bool
    let isUnmapped: Bool
    let laneLabel: String?
    let checksStatus: String?
    /// Host-supplied explanation for a non-obvious rollup. Surfaced verbatim on
    /// the CI indicator's accessibility label so the "why" travels with the glyph.
    let checksReason: String?
    let reviewStatus: String?
    let warnMessage: String?
    let stackGroupId: String?
    let stackGroupName: String?
    let stackGroupCount: Int?
    let githubStack: GitHubPrStackMembership?
    /// True for merged/closed rows, which render as a record rather than a queue item.
    var isTerminal: Bool = false
    /// Lane provenance frozen when the lane was deleted.
    var detached: PrDetachedLane? = nil
    var mergedAt: String? = nil
    var mergedByLogin: String? = nil
    var mergeMethod: String? = nil
    var needsBranchCleanup: Bool = false

    var timeAgo: String {
      // Open rows are about how long something has waited; merged rows about when it
      // shipped.
      prRelativeTime(isTerminal ? (mergedAt ?? updatedAt) : updatedAt)
    }

    /// `arul · squash · → main` — how a terminal PR shipped. Each part is optional so
    /// PRs merged before the host recorded this simply show less.
    var mergeFacts: String? {
      guard isTerminal else { return nil }
      var parts: [String] = []
      if let login = mergedByLogin, !login.isEmpty { parts.append(login) }
      if let method = mergeMethod, !method.isEmpty { parts.append(method) }
      if let base = baseBranch, !base.isEmpty { parts.append("→ \(base)") }
      return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// `was: auto-naming · 3 chats · 2 proof`
    var provenanceLabel: String? {
      guard let detached else { return nil }
      var parts: [String] = []
      if let name = detached.laneName, !name.isEmpty { parts.append("was: \(name)") }
      if detached.chats > 0 { parts.append("\(detached.chats) chat\(detached.chats == 1 ? "" : "s")") }
      if detached.artifacts > 0 { parts.append("\(detached.artifacts) proof") }
      return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    struct CIIndicator {
      /// ADE-135. `not_run` has no honest SF Symbol — every circle-with-a-mark
      /// reads as a verdict, and this state is the absence of one. It draws a
      /// hollow dashed ring instead: an empty slot where a result should be.
      enum Glyph: Equatable {
        case symbol(String)
        case hollowRing
      }

      let glyph: Glyph
      let color: Color
      let title: String
    }

    struct ReviewIndicator {
      let label: String
      let color: Color
    }

    var ciIndicator: CIIndicator? {
      switch checksStatus {
      case "passing":
        return CIIndicator(glyph: .symbol("checkmark.circle.fill"), color: PrsGlass.openTop, title: "CI passing")
      case "failing":
        return CIIndicator(glyph: .symbol("xmark.circle.fill"), color: PrsGlass.closedTop, title: "CI failing")
      case "pending":
        return CIIndicator(glyph: .symbol("clock.fill"), color: PrsGlass.draftTop, title: "CI pending")
      case "not_run":
        // Checks exist or are required, but nothing verified this commit. Muted,
        // never the failure red — this is a gap, not a red build.
        return CIIndicator(
          glyph: .hollowRing,
          color: PrsGlass.textMuted,
          title: checksReason ?? noCIReasonText
        )
      default:
        return nil
      }
    }

    var reviewIndicator: ReviewIndicator? {
      switch reviewStatus {
      case "approved":
        return ReviewIndicator(label: "Approved", color: PrsGlass.openTop)
      case "changes_requested":
        return ReviewIndicator(label: "Changes", color: PrsGlass.closedTop)
      case "requested":
        return ReviewIndicator(label: "Review required", color: PrsGlass.draftTop)
      default:
        return nil
      }
    }

    init(pr: PullRequestListItem) {
      self.id = pr.id
      self.prNumber = pr.githubPrNumber
      self.title = pr.title
      self.state = pr.state
      self.updatedAt = pr.updatedAt
      self.headBranch = pr.headBranch
      self.baseBranch = pr.baseBranch
      self.authorLogin = nil
      self.isBot = false
      self.commentCount = 0
      self.repoOwner = pr.repoOwner
      self.repoName = pr.repoName
      self.isExternal = false
      self.isUnmapped = false
      self.laneLabel = pr.laneName ?? pr.laneId
      // Only "none" (nothing observed, nothing expected) is silent. "not_run" is a
      // finding and must survive to `ciIndicator`.
      self.checksStatus = pr.checksStatus == "none" ? nil : pr.checksStatus
      self.checksReason = pr.checksReason
      self.reviewStatus = pr.reviewStatus == "none" ? nil : pr.reviewStatus
      self.warnMessage = Self.warnMessage(
        workflowDisplayState: pr.workflowDisplayState,
        checksStatus: pr.checksStatus,
        baseBranch: pr.baseBranch
      )
      self.stackGroupId = pr.linkedGroupId
      self.stackGroupName = pr.linkedGroupName
      self.stackGroupCount = pr.linkedGroupCount > 0 ? pr.linkedGroupCount : nil
      self.githubStack = pr.stack
    }

    init(item: GitHubPrListItem, linkedPr: PullRequestListItem?) {
      // Mapping is a live-work concept. On a merged or closed PR the lane is usually
      // gone and mapping one would do nothing, so the badge is suppressed there —
      // otherwise the merged list reads as a wall of warnings.
      let terminal = item.state == "merged" || item.state == "closed"
      let unmapped = !terminal
        && item.scope != "external"
        && item.linkedPrId == nil
        && item.linkedLaneId == nil
        && item.adeKind == nil
      self.id = item.linkedPrId ?? item.id
      self.prNumber = item.githubPrNumber
      self.title = item.title
      self.state = item.isDraft ? "draft" : item.state
      self.updatedAt = item.updatedAt
      self.headBranch = item.headBranch
      self.baseBranch = item.baseBranch
      self.authorLogin = item.author
      self.isBot = item.isBot
      self.commentCount = item.commentCount
      self.repoOwner = item.repoOwner
      self.repoName = item.repoName
      self.isExternal = item.scope == "external"
      self.isUnmapped = unmapped
      self.laneLabel = item.linkedLaneName ?? item.linkedLaneId ?? linkedPr?.laneName ?? linkedPr?.laneId
      self.checksStatus = linkedPr?.checksStatus == "none" ? nil : linkedPr?.checksStatus
      self.checksReason = linkedPr?.checksReason
      self.reviewStatus = linkedPr?.reviewStatus == "none" ? nil : linkedPr?.reviewStatus
      self.warnMessage = unmapped
        ? nil
        : Self.warnMessage(
          workflowDisplayState: item.workflowDisplayState,
          checksStatus: linkedPr?.checksStatus,
          baseBranch: item.baseBranch
        )
      self.stackGroupId = item.linkedGroupId
      self.stackGroupName = nil
      self.stackGroupCount = nil
      self.githubStack = item.stack ?? linkedPr?.stack
      self.isTerminal = terminal
      self.detached = item.detached ?? linkedPr?.detached
      self.mergedAt = item.mergedAt ?? linkedPr?.mergedAt
      self.mergedByLogin = (item.mergedBy ?? linkedPr?.mergedBy)?.login
      self.mergeMethod = item.mergeMethod ?? linkedPr?.mergeMethod
      // The only actionable thing left on a merged PR: its remote branch still exists.
      self.needsBranchCleanup = terminal && item.cleanupState == "required"
    }

    private static func warnMessage(
      workflowDisplayState: String?,
      checksStatus: String?,
      baseBranch: String?
    ) -> String? {
      if let state = workflowDisplayState {
        switch state {
        case "rebase-needed":
          let target = baseBranch ?? "base"
          return "Rebase against \(target)"
        case "conflict", "merge-conflict":
          return "Merge conflict detected"
        case "queued":
          return "In queue"
        default:
          break
        }
      }
      if checksStatus == "failing" {
        return "CI failing"
      }
      // "not_run" deliberately produces no warn banner: the hollow ring already
      // states it, and this row is reserved for things the user must act on.
      return nil
    }
  }
}
