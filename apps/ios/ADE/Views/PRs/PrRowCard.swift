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
    transitionNamespace: Namespace.ID? = nil,
    isSelectedTransitionSource: Bool = false
  ) {
    self.data = Data(item: item)
    self.transitionNamespace = transitionNamespace
    self.isSelectedTransitionSource = isSelectedTransitionSource
    self.onShowStack = { _, _ in }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 11) {
      PrStateTile(state: data.state)
        .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-status-\(data.id)" : nil, in: transitionNamespace)

      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Text("#\(data.prNumber)")
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .foregroundStyle(prStateTint(data.state))

          if let kindLabel = data.adeKindLabel, let tint = data.adeKindTint {
            PrTagChip(label: kindLabel, color: tint)
          }

          if data.isUnmapped {
            PrTagChip(label: "unmapped", color: ADEColor.warning, filled: true)
          }

          if data.isExternal {
            PrTagChip(label: "external", color: ADEColor.textSecondary)
          }

          Spacer(minLength: 0)

          PrMonoText(text: prRelativeTime(data.updatedAt), color: ADEColor.textMuted, size: 10)
            .lineLimit(1)
        }

        Text(data.title)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .multilineTextAlignment(.leading)
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-title-\(data.id)" : nil, in: transitionNamespace)

        metaLine

        if let warn = data.warnMessage {
          PrWarnBanner(text: warn)
            .padding(.top, 2)
        }
      }
    }
    .padding(.vertical, 4)
    .adeListCard()
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "pr-container-\(data.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("PR #\(data.prNumber): \(data.title), state \(data.state)")
  }

  @ViewBuilder
  private var metaLine: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 4) {
        Image(systemName: "arrow.triangle.branch")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary.opacity(0.7))
        PrMonoText(text: data.branchDisplayLabel, color: ADEColor.textSecondary, size: 10)
          .lineLimit(1)
          .truncationMode(.tail)
          .layoutPriority(1)

        if let author = data.authorLabel {
          PrMonoText(text: "by \(author)", color: ADEColor.textMuted, size: 10)
            .lineLimit(1)
            .truncationMode(.tail)
        }
      }

      HStack(spacing: 8) {
        if let checks = data.checkCounts {
          HStack(spacing: 5) {
            if checks.fail > 0 {
              PrMonoText(text: "✗ \(checks.fail)", color: ADEColor.danger, size: 10)
            }
            if checks.pass > 0 {
              PrMonoText(text: "✓ \(checks.pass)", color: ADEColor.success, size: 10)
            }
            if checks.pending > 0 {
              PrMonoText(text: "◐ \(checks.pending)", color: ADEColor.warning, size: 10)
            }
          }
        }

        if let approvals = data.approvals {
          PrMonoText(
            text: "✓ \(approvals.have)/\(approvals.need)",
            color: approvals.have >= approvals.need ? ADEColor.success : ADEColor.textSecondary,
            size: 10
          )
        }

        if data.isUnmapped {
          PrMonoText(text: "read before linking", color: ADEColor.warning, size: 10)
            .lineLimit(1)
        }

        Spacer(minLength: 0)

        if let groupId = data.stackGroupId, let groupCount = data.stackGroupCount, groupCount > 0 {
          Button {
            onShowStack(groupId, data.stackGroupName)
          } label: {
            HStack(spacing: 3) {
              Image(systemName: "list.number")
                .font(.system(size: 9, weight: .bold))
              Text("\(groupCount)")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
            }
            .foregroundStyle(ADEColor.textSecondary)
          }
          .buttonStyle(.plain)
        }
      }
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
    let branchLabel: String
    let baseBranch: String?
    let author: String?
    let adeKindLabel: String?
    let adeKindTint: Color?
    let isExternal: Bool
    let isUnmapped: Bool
    let checkCounts: CheckCounts?
    let approvals: Approvals?
    let warnMessage: String?
    let stackGroupId: String?
    let stackGroupName: String?
    let stackGroupCount: Int?

    var branchDisplayLabel: String {
      guard let baseBranch, !baseBranch.isEmpty else { return branchLabel }
      return "\(branchLabel) → \(baseBranch)"
    }

    var authorLabel: String? {
      guard let author, !author.isEmpty else { return nil }
      return author.hasPrefix("@") ? author : "@\(author)"
    }

    struct CheckCounts {
      let pass: Int
      let fail: Int
      let pending: Int
    }

    struct Approvals {
      let have: Int
      let need: Int
    }

    init(pr: PullRequestListItem) {
      self.id = pr.id
      self.prNumber = pr.githubPrNumber
      self.title = pr.title
      self.state = pr.state
      self.updatedAt = pr.updatedAt
      self.branchLabel = pr.headBranch
      self.baseBranch = pr.baseBranch
      self.author = nil
      self.adeKindLabel = prAdeKindLabel(pr.adeKind)
      self.adeKindTint = pr.adeKind != nil ? ADEColor.tintPRs : nil
      self.isExternal = false
      self.isUnmapped = false
      self.checkCounts = Self.checkCounts(from: pr.checksStatus)
      self.approvals = Self.approvals(from: pr.reviewStatus)
      self.warnMessage = Self.warnMessage(
        workflowDisplayState: pr.workflowDisplayState,
        checksStatus: pr.checksStatus,
        baseBranch: pr.baseBranch
      )
      self.stackGroupId = pr.linkedGroupId
      self.stackGroupName = pr.linkedGroupName
      self.stackGroupCount = pr.linkedGroupCount
    }

    init(item: GitHubPrListItem) {
      let unmapped = item.linkedPrId == nil && item.linkedLaneId == nil && item.adeKind == nil
      self.id = item.linkedPrId ?? item.id
      self.prNumber = item.githubPrNumber
      self.title = item.title
      self.state = item.isDraft ? "draft" : item.state
      self.updatedAt = item.updatedAt
      self.branchLabel = item.headBranch ?? "\(item.repoOwner)/\(item.repoName)"
      self.baseBranch = item.baseBranch
      self.author = item.author
      self.adeKindLabel = prAdeKindLabel(item.adeKind)
      self.adeKindTint = Self.adeKindTint(for: item)
      self.isExternal = item.scope == "external"
      self.isUnmapped = unmapped
      self.checkCounts = nil
      self.approvals = nil
      self.warnMessage = unmapped
        ? "Unmapped: review details before linking a lane."
        : Self.warnMessage(
          workflowDisplayState: item.workflowDisplayState,
          checksStatus: nil,
          baseBranch: item.baseBranch
        )
      self.stackGroupId = item.linkedGroupId
      self.stackGroupName = nil
      self.stackGroupCount = nil
    }

    private static func checkCounts(from status: String) -> CheckCounts? {
      switch status {
      case "passing":
        return CheckCounts(pass: 1, fail: 0, pending: 0)
      case "failing":
        return CheckCounts(pass: 0, fail: 1, pending: 0)
      case "pending":
        return CheckCounts(pass: 0, fail: 0, pending: 1)
      default:
        return nil
      }
    }

    private static func approvals(from reviewStatus: String) -> Approvals? {
      switch reviewStatus {
      case "approved":
        return Approvals(have: 1, need: 1)
      case "changes_requested":
        return Approvals(have: 0, need: 1)
      case "requested", "pending":
        return Approvals(have: 0, need: 1)
      default:
        return nil
      }
    }

    private static func adeKindTint(for item: GitHubPrListItem) -> Color? {
      guard let adeKind = item.adeKind, !adeKind.isEmpty else { return nil }
      switch adeKind {
      case "integration": return ADEColor.warning
      case "queue": return ADEColor.accent
      default: return ADEColor.tintPRs
      }
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
