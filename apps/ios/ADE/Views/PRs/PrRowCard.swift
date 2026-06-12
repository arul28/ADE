import SwiftUI

struct PrRowCard: View {
  let data: Data
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool
  let onShowStack: (String, String?) -> Void
  let onLink: (() -> Void)?

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
    self.onLink = nil
  }

  init(
    item: GitHubPrListItem,
    linkedPr: PullRequestListItem? = nil,
    transitionNamespace: Namespace.ID? = nil,
    isSelectedTransitionSource: Bool = false,
    onLink: (() -> Void)? = nil
  ) {
    self.data = Data(item: item, linkedPr: linkedPr)
    self.transitionNamespace = transitionNamespace
    self.isSelectedTransitionSource = isSelectedTransitionSource
    self.onShowStack = { _, _ in }
    self.onLink = onLink
  }

  var body: some View {
    let stateColors = PrRowDesktopPalette.stateColors(data.state)

    VStack(alignment: .leading, spacing: 6) {
      primaryRow(stateColors: stateColors)
      if !data.visibleLabels.isEmpty {
        labelsRow
      }
      if data.showsBranchRow {
        branchRow
      }
      statsRow
      if !data.isUnmapped, let warnMessage = data.warnMessage {
        PrWarnBanner(text: warnMessage)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      if isSelectedTransitionSource {
        LinearGradient(
          colors: [stateColors.background, Color.white.opacity(0.02)],
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
        .fill(Color.white.opacity(0.04))
        .frame(height: 1)
    }
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "pr-container-\(data.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("PR #\(data.prNumber): \(data.title), state \(data.state)")
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

  private func primaryRow(stateColors: PrRowDesktopPalette.StateColors) -> some View {
    HStack(alignment: .center, spacing: 6) {
      authorAvatar(borderColor: stateColors.background)

      if data.isBot {
        Text("bot")
          .font(.system(size: 9, weight: .bold))
          .textCase(.uppercase)
          .foregroundStyle(PrsGlass.textMuted)
          .padding(.horizontal, 5)
          .padding(.vertical, 1)
          .background(
            RoundedRectangle(cornerRadius: 3, style: .continuous)
              .fill(Color.white.opacity(0.06))
          )
      }

      Text("#\(data.prNumber)")
        .font(.system(size: 11, weight: .bold, design: .monospaced))
        .foregroundStyle(stateColors.text)

      Text(data.title)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(PrsGlass.textPrimary)
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(maxWidth: .infinity, alignment: .leading)
        .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-title-\(data.id)" : nil, in: transitionNamespace)

      if let ci = data.ciIndicator {
        Image(systemName: ci.symbol)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ci.color)
          .accessibilityLabel(ci.title)
      }

      if !data.timeAgo.isEmpty {
        PrMonoText(text: data.timeAgo, color: PrsGlass.textMuted, size: 10)
          .lineLimit(1)
      }

      if data.commentCount > 0 {
        HStack(spacing: 3) {
          Image(systemName: "text.bubble")
            .font(.system(size: 12))
          Text("\(data.commentCount)")
            .font(.system(size: 10, weight: .regular, design: .monospaced))
        }
        .foregroundStyle(PrsGlass.textMuted)
      }
    }
  }

  private var labelsRow: some View {
    HStack(spacing: 4) {
      ForEach(data.visibleLabels) { label in
        Text(label.name)
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(prLabelTextColor(label.color))
          .padding(.horizontal, 8)
          .padding(.vertical, 1)
          .background(
            Capsule(style: .continuous)
              .fill(Color(hex: label.color))
          )
          .lineLimit(1)
      }
      if data.labelOverflowCount > 0 {
        Text("+\(data.labelOverflowCount)")
          .font(.system(size: 10))
          .foregroundStyle(PrsGlass.textMuted)
      }
    }
    .padding(.leading, 30)
  }

  private var branchRow: some View {
    HStack(spacing: 4) {
      if let head = data.headBranch {
        PrMonoText(text: head, color: PrsGlass.textMuted, size: 10)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      if data.headBranch != nil, data.baseBranch != nil {
        Text("→")
          .font(.system(size: 10, weight: .regular, design: .monospaced))
          .foregroundStyle(PrsGlass.textSecondary.opacity(0.55))
      }
      if let base = data.baseBranch {
        PrMonoText(text: base, color: PrsGlass.textMuted, size: 10)
          .lineLimit(1)
      }
    }
    .padding(.leading, 30)
  }

  private var statsRow: some View {
    HStack(spacing: 6) {
      if data.showsStateBadge {
        Text(titleCase(data.state))
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(PrRowDesktopPalette.stateColors(data.state).text)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
              .fill(PrRowDesktopPalette.stateColors(data.state).background)
          )
          .overlay(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
              .stroke(PrRowDesktopPalette.stateColors(data.state).border, lineWidth: 1)
          )
      }

      if let adeKind = data.adeKindBadgeLabel, let style = PrRowDesktopPalette.adeKindStyle(data.adeKind) {
        Text(adeKind)
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(style.text)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
              .fill(style.background)
          )
          .overlay(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
              .stroke(style.border, lineWidth: 1)
          )
      }

      if data.isExternal {
        PrMonoText(
          text: "\(data.repoOwner)/\(data.repoName)",
          color: PrsGlass.textMuted,
          size: 10
        )
        .lineLimit(1)
      }

      if let laneLabel = data.laneLabel {
        HStack(spacing: 4) {
          Circle()
            .fill(data.laneTint ?? PrsGlass.textSecondary)
            .frame(width: 6, height: 6)
          Text(laneLabel)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(data.laneTint ?? PrsGlass.textSecondary)
            .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(
          RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(Color.white.opacity(0.04))
        )
        .overlay(
          RoundedRectangle(cornerRadius: 5, style: .continuous)
            .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
      } else if data.isUnmapped {
        Text("unmapped")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(PrsGlass.draftTop)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
              .fill(Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255, opacity: 0.10))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
              .stroke(Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255, opacity: 0.18), lineWidth: 1)
          )
      }

      if let review = data.reviewIndicator {
        Text(review.label)
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(review.color)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
              .fill(review.color.opacity(0.10))
          )
      }

      if data.additions > 0 || data.deletions > 0 {
        HStack(spacing: 4) {
          Text("+\(data.additions)")
            .foregroundStyle(PrsGlass.openTop)
          Text("-\(data.deletions)")
            .foregroundStyle(PrsGlass.closedTop)
        }
        .font(.system(size: 10, weight: .regular, design: .monospaced))
      }

      if data.cleanupRequired {
        Text("cleanup")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(PrsGlass.draftTop)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
              .fill(PrsGlass.draftTop.opacity(0.10))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
              .stroke(PrsGlass.draftTop.opacity(0.18), lineWidth: 1)
          )
      }

      if data.adeKind == "queue", let groupId = data.stackGroupId {
        Button {
          onShowStack(groupId, data.stackGroupName)
        } label: {
          Text("open queue")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(PrsGlass.externalTop)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(
              RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(PrsGlass.externalTop.opacity(0.10))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 5, style: .continuous)
                .stroke(PrsGlass.externalTop.opacity(0.18), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
      } else if let groupId = data.stackGroupId, let groupCount = data.stackGroupCount, groupCount > 0 {
        Button {
          onShowStack(groupId, data.stackGroupName)
        } label: {
          HStack(spacing: 3) {
            Image(systemName: "list.number")
              .font(.system(size: 9, weight: .bold))
            Text("\(groupCount)")
              .font(.system(size: 10, weight: .semibold, design: .monospaced))
          }
          .foregroundStyle(PrsGlass.textSecondary)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background {
            Capsule(style: .continuous)
              .fill(Color.white.opacity(0.06))
          }
          .overlay {
            Capsule(style: .continuous)
              .stroke(Color.white.opacity(0.10), lineWidth: 0.5)
          }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open stack of \(groupCount) pull requests")
      }

      Spacer(minLength: 0)

      if data.isUnmapped, let onLink {
        Button(action: onLink) {
          Image(systemName: "link")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(PrsGlass.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Link pull request to a lane")
      }
    }
    .padding(.leading, 30)
  }

  @ViewBuilder
  private func authorAvatar(borderColor: Color) -> some View {
    if let author = data.authorLogin {
      AsyncImage(url: URL(string: "https://avatars.githubusercontent.com/\(author)?size=64")) { phase in
        switch phase {
        case .success(let image):
          image
            .resizable()
            .scaledToFill()
        default:
          Circle()
            .fill(Color.white.opacity(0.05))
        }
      }
      .frame(width: 22, height: 22)
      .clipShape(Circle())
      .overlay {
        Circle()
          .stroke(borderColor, lineWidth: 1.5)
      }
    } else {
      Circle()
        .fill(Color.white.opacity(0.05))
        .overlay {
          Circle()
            .stroke(Color.white.opacity(0.08), lineWidth: 1)
        }
        .frame(width: 22, height: 22)
    }
  }
}

private enum PrRowDesktopPalette {
  struct StateColors {
    let background: Color
    let border: Color
    let text: Color
  }

  struct AdeKindStyle {
    let text: Color
    let background: Color
    let border: Color
  }

  static func stateColors(_ state: String) -> StateColors {
    switch state {
    case "open":
      return StateColors(
        background: Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255, opacity: 0.10),
        border: Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255, opacity: 0.20),
        text: Color(red: 0x60 / 255, green: 0xA5 / 255, blue: 0xFA / 255)
      )
    case "draft":
      return StateColors(
        background: Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255, opacity: 0.10),
        border: Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255, opacity: 0.20),
        text: Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
      )
    case "merged":
      return StateColors(
        background: Color(red: 0x22 / 255, green: 0xC5 / 255, blue: 0x5E / 255, opacity: 0.10),
        border: Color(red: 0x22 / 255, green: 0xC5 / 255, blue: 0x5E / 255, opacity: 0.20),
        text: Color(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255)
      )
    default:
      return StateColors(
        background: Color(red: 0xA1 / 255, green: 0xA1 / 255, blue: 0xAA / 255, opacity: 0.08),
        border: Color(red: 0xA1 / 255, green: 0xA1 / 255, blue: 0xAA / 255, opacity: 0.15),
        text: Color(red: 0xA1 / 255, green: 0xA1 / 255, blue: 0xAA / 255)
      )
    }
  }

  static func adeKindStyle(_ adeKind: String?) -> AdeKindStyle? {
    switch adeKind {
    case "integration":
      return AdeKindStyle(
        text: Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255),
        background: Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255, opacity: 0.14),
        border: Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255, opacity: 0.22)
      )
    case "queue":
      return AdeKindStyle(
        text: Color(red: 0x60 / 255, green: 0xA5 / 255, blue: 0xFA / 255),
        background: Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255, opacity: 0.14),
        border: Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255, opacity: 0.22)
      )
    default:
      return nil
    }
  }
}

private func prLabelTextColor(_ hexColor: String) -> Color {
  let hex = hexColor.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
  guard hex.count >= 6,
        let value = Int(hex.prefix(6), radix: 16) else {
    return PrsGlass.textPrimary
  }
  let r = Double((value >> 16) & 0xFF) / 255
  let g = Double((value >> 8) & 0xFF) / 255
  let b = Double(value & 0xFF) / 255
  let luminance = (0.299 * r) + (0.587 * g) + (0.114 * b)
  return luminance > 0.5
    ? Color(red: 0x1A / 255, green: 0x1A / 255, blue: 0x2E / 255)
    : PrsGlass.textPrimary
}

private extension Color {
  init(hex: String) {
    let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    let value = Int(hex.prefix(6), radix: 16) ?? 0
    self.init(
      red: Double((value >> 16) & 0xFF) / 255,
      green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255
    )
  }
}

extension PrRowCard {
  struct Data {
    let id: String
    let prNumber: Int
    let title: String
    let state: String
    let adeKind: String?
    let createdAt: String
    let updatedAt: String
    let headBranch: String?
    let baseBranch: String?
    let authorLogin: String?
    let isBot: Bool
    let labels: [PrLabel]
    let commentCount: Int
    let repoOwner: String
    let repoName: String
    let isExternal: Bool
    let isUnmapped: Bool
    let laneLabel: String?
    let laneTint: Color?
    let checksStatus: String?
    let reviewStatus: String?
    let additions: Int
    let deletions: Int
    let cleanupRequired: Bool
    let warnMessage: String?
    let stackGroupId: String?
    let stackGroupName: String?
    let stackGroupCount: Int?

    var visibleLabels: [PrLabel] {
      Array(labels.prefix(4))
    }

    var labelOverflowCount: Int {
      max(0, labels.count - 4)
    }

    var timeAgo: String {
      prRelativeTime(updatedAt)
    }

    var showsBranchRow: Bool {
      headBranch != nil && baseBranch != nil
    }

    var showsStateBadge: Bool {
      state != "open" && state != "draft"
    }

    var adeKindBadgeLabel: String? {
      guard let adeKind, adeKind != "single" else { return nil }
      return adeKind
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
      self.adeKind = pr.adeKind
      self.createdAt = pr.createdAt
      self.updatedAt = pr.updatedAt
      self.headBranch = pr.headBranch
      self.baseBranch = pr.baseBranch
      self.authorLogin = nil
      self.isBot = false
      self.labels = []
      self.commentCount = 0
      self.repoOwner = pr.repoOwner
      self.repoName = pr.repoName
      self.isExternal = false
      self.isUnmapped = false
      self.laneLabel = pr.laneName ?? pr.laneId
      self.laneTint = ADEColor.tintPRs
      self.checksStatus = pr.checksStatus == "none" ? nil : pr.checksStatus
      self.reviewStatus = pr.reviewStatus == "none" ? nil : pr.reviewStatus
      self.additions = pr.additions
      self.deletions = pr.deletions
      self.cleanupRequired = pr.cleanupState == "required"
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
      self.adeKind = item.adeKind
      self.createdAt = item.createdAt
      self.updatedAt = item.updatedAt
      self.headBranch = item.headBranch
      self.baseBranch = item.baseBranch
      self.authorLogin = item.author
      self.isBot = item.isBot
      self.labels = item.labels
      self.commentCount = item.commentCount
      self.repoOwner = item.repoOwner
      self.repoName = item.repoName
      self.isExternal = item.scope == "external"
      self.isUnmapped = unmapped
      self.laneLabel = item.linkedLaneName ?? item.linkedLaneId ?? linkedPr?.laneName ?? linkedPr?.laneId
      self.laneTint = ADEColor.tintPRs
      self.checksStatus = linkedPr?.checksStatus == "none" ? nil : linkedPr?.checksStatus
      self.reviewStatus = linkedPr?.reviewStatus == "none" ? nil : linkedPr?.reviewStatus
      self.additions = linkedPr?.additions ?? 0
      self.deletions = linkedPr?.deletions ?? 0
      self.cleanupRequired = item.cleanupState == "required"
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
