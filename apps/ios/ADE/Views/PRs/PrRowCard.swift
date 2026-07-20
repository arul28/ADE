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

    HStack(alignment: .top, spacing: 12) {
      Image(systemName: stateSymbol)
        .font(.body.weight(.semibold))
        .foregroundStyle(stateColors.text)
        .frame(width: 22, height: 22)
        .padding(.top, 1)

      VStack(alignment: .leading, spacing: 7) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(data.title)
            .font(.body.weight(.semibold))
            .foregroundStyle(PrsGlass.textPrimary)
            .lineLimit(2)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-title-\(data.id)" : nil, in: transitionNamespace)

          if !data.timeAgo.isEmpty {
            Text(data.timeAgo)
              .font(.caption2.monospaced())
              .foregroundStyle(PrsGlass.textMuted)
              .lineLimit(1)
              .fixedSize()
          }
        }

        metadataRow
        signalsRow

        if !data.isUnmapped, let warnMessage = data.warnMessage {
          PrWarnBanner(text: warnMessage)
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 13)
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
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "pr-container-\(data.id)" : nil, in: transitionNamespace)
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
    if let head = data.headBranch, let base = data.baseBranch { parts.append("\(head) into \(base)") }
    if let ci = data.ciIndicator { parts.append(ci.title) }
    if let review = data.reviewIndicator { parts.append(review.label) }
    if data.commentCount > 0 { parts.append("\(data.commentCount) comments") }
    if data.isUnmapped {
      parts.append("Not mapped to an ADE lane")
    } else if let lane = data.laneLabel {
      parts.append("Lane \(lane)")
    }
    if !data.timeAgo.isEmpty { parts.append("Updated \(data.timeAgo)") }
    return parts.joined(separator: ", ")
  }

  private var metadataRow: some View {
    HStack(spacing: 5) {
      Text("#\(data.prNumber)")
        .foregroundStyle(PrRowDesktopPalette.stateColors(data.state).text)
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
      Spacer(minLength: 0)
    }
    .font(.caption.monospaced())
    .foregroundStyle(PrsGlass.textMuted)
  }

  @ViewBuilder
  private var signalsRow: some View {
    HStack(spacing: 12) {
      if let head = data.headBranch, let base = data.baseBranch {
        HStack(spacing: 4) {
          Text(head)
            .lineLimit(1)
            .truncationMode(.middle)
          Text("→")
          Text(base)
            .lineLimit(1)
        }
        .font(.caption2.monospaced())
        .foregroundStyle(PrsGlass.textSecondary)
        .layoutPriority(1)
      }

      Spacer(minLength: 0)

      if let ci = data.ciIndicator {
        Image(systemName: ci.symbol)
          .foregroundStyle(ci.color)
          .accessibilityLabel(ci.title)
      }

      if let review = data.reviewIndicator {
        Image(systemName: reviewSymbol)
          .foregroundStyle(review.color)
          .accessibilityLabel(review.label)
      }

      if data.commentCount > 0 {
        Label("\(data.commentCount)", systemImage: "text.bubble")
          .labelStyle(.titleAndIcon)
      }

      if data.isUnmapped {
        Label("Unmapped", systemImage: "link.badge.plus")
          .foregroundStyle(PrsGlass.draftTop)
      } else if let laneLabel = data.laneLabel {
        Label(laneLabel, systemImage: "rectangle.stack")
          .lineLimit(1)
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
    let reviewStatus: String?
    let warnMessage: String?
    let stackGroupId: String?
    let stackGroupName: String?
    let stackGroupCount: Int?

    var timeAgo: String {
      prRelativeTime(updatedAt)
    }

    struct CIIndicator {
      let symbol: String
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
        return CIIndicator(symbol: "checkmark.circle.fill", color: PrsGlass.openTop, title: "CI passing")
      case "failing":
        return CIIndicator(symbol: "xmark.circle.fill", color: PrsGlass.closedTop, title: "CI failing")
      case "pending":
        return CIIndicator(symbol: "clock.fill", color: PrsGlass.draftTop, title: "CI pending")
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
      self.checksStatus = pr.checksStatus == "none" ? nil : pr.checksStatus
      self.reviewStatus = pr.reviewStatus == "none" ? nil : pr.reviewStatus
      self.warnMessage = Self.warnMessage(
        workflowDisplayState: pr.workflowDisplayState,
        checksStatus: pr.checksStatus,
        baseBranch: pr.baseBranch
      )
      self.stackGroupId = pr.linkedGroupId
      self.stackGroupName = pr.linkedGroupName
      self.stackGroupCount = pr.linkedGroupCount > 0 ? pr.linkedGroupCount : nil
    }

    init(item: GitHubPrListItem, linkedPr: PullRequestListItem?) {
      let unmapped = item.scope != "external"
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
      return nil
    }
  }
}
