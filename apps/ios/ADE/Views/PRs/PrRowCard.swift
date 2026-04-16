import SwiftUI

struct PrRowCard: View {
  let pr: PullRequestListItem
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool
  let onShowStack: (String, String?) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 6) {
          Text(pr.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-title-\(pr.id)" : nil, in: transitionNamespace)

          HStack(spacing: 8) {
            Text("#\(pr.githubPrNumber)")
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
            if let laneName = pr.laneName, !laneName.isEmpty {
              Text(laneName)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
          }
        }

        Spacer(minLength: 8)

        VStack(alignment: .trailing, spacing: 6) {
          ADEStatusPill(text: pr.state.uppercased(), tint: prStateTint(pr.state))
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-status-\(pr.id)" : nil, in: transitionNamespace)
          if let adeKindLabel = prAdeKindLabel(pr.adeKind) {
            ADEStatusPill(text: adeKindLabel, tint: ADEColor.accent)
          }
        }
      }

      Text("\(pr.headBranch) → \(pr.baseBranch)")
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)

      HStack(spacing: 10) {
        PrSignalChip(icon: "circle.fill", text: prChecksLabel(pr.checksStatus), tint: prChecksTint(pr.checksStatus))
        PrSignalChip(icon: reviewSymbol(pr.reviewStatus), text: prReviewLabel(pr.reviewStatus), tint: prReviewTint(pr.reviewStatus))

        if let groupId = pr.linkedGroupId, pr.linkedGroupCount > 1 {
          Button {
            onShowStack(groupId, pr.linkedGroupName)
          } label: {
            Label("\(pr.linkedGroupCount)", systemImage: "list.number")
              .font(.caption.weight(.semibold))
          }
          .buttonStyle(.glass)
          .tint(ADEColor.textSecondary)
        }

        Spacer(minLength: 0)

        Text("+\(pr.additions) -\(pr.deletions)")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .adeListCard()
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "pr-container-\(pr.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("PR #\(pr.githubPrNumber): \(pr.title), state \(pr.state), checks \(pr.checksStatus), review \(pr.reviewStatus)")
  }
}
