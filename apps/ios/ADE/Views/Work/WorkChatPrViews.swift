import SwiftUI

struct WorkChatPrBadgeModel: Equatable {
  let label: String
  let title: String
  let state: String
  let checksStatus: String?
  let reviewStatus: String?
  let updatedAt: String
}

func workChatPrBadgeModel(tag: LanePrTag?, pr: PullRequestListItem?, summary: PrSummary? = nil) -> WorkChatPrBadgeModel? {
  guard let tag else { return nil }
  return WorkChatPrBadgeModel(
    label: formatLanePrBadgeLabel(tag),
    title: tag.title,
    state: tag.state,
    checksStatus: pr?.checksStatus ?? summary?.checksStatus,
    reviewStatus: pr?.reviewStatus ?? summary?.reviewStatus,
    updatedAt: tag.updatedAt
  )
}

struct WorkChatPrActivePopup: View {
  let badge: WorkChatPrBadgeModel
  let onOpen: () -> Void

  private var tint: Color {
    lanePullRequestTint(badge.state)
  }

  private var ciSymbol: String? {
    switch badge.checksStatus {
    case "passing":
      return "checkmark.circle.fill"
    case "failing":
      return "xmark.circle.fill"
    case "pending":
      return "clock.fill"
    default:
      return nil
    }
  }

  private var accessibilityText: String {
    var parts = [badge.label, lanePrStateLabel(badge.state)]
    if let checksStatus = badge.checksStatus, !checksStatus.isEmpty {
      parts.append("checks \(checksStatus)")
    }
    if let reviewStatus = badge.reviewStatus, !reviewStatus.isEmpty, reviewStatus != "none" {
      parts.append("review \(reviewStatus.replacingOccurrences(of: "_", with: " "))")
    }
    return parts.joined(separator: ", ") + ". Tap for details."
  }

  var body: some View {
    Button(action: onOpen) {
      HStack(spacing: 7) {
        Image(systemName: "arrow.triangle.pull")
          .font(.system(size: 12, weight: .semibold))
        Text(badge.label)
          .font(.caption.weight(.semibold))
          .lineLimit(1)
        if let ciSymbol {
          Image(systemName: ciSymbol)
            .font(.system(size: 10, weight: .bold))
        }
        Image(systemName: "chevron.up")
          .font(.system(size: 10, weight: .bold))
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(ADEColor.cardBackground.opacity(0.76), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(tint.opacity(0.24), lineWidth: 1)
      )
      .contentShape(Capsule(style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibilityText)
  }
}

struct WorkChatPrDetailsSheet: View {
  let tag: LanePrTag?
  let pr: PullRequestListItem?
  let summary: PrSummary?
  let snapshot: PullRequestSnapshot?
  let canCreate: Bool
  let createBlockedReason: String?
  let isRefreshing: Bool
  let errorMessage: String?
  let copiedLink: Bool
  let onRefresh: () -> Void
  let onCreate: () -> Void
  let onOpenPrsTab: () -> Void
  let onOpenGitHub: () -> Void
  let onCopyLink: () -> Void

  private var prNumberLabel: String {
    guard let tag else { return "Pull request" }
    return formatLanePrBadgeLabel(tag)
  }

  private var githubUrl: String {
    (tag?.githubUrl ?? pr?.githubUrl ?? summary?.githubUrl ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var checksStatus: String? {
    snapshot?.status?.checksStatus ?? pr?.checksStatus ?? summary?.checksStatus
  }

  private var reviewStatus: String? {
    snapshot?.status?.reviewStatus ?? pr?.reviewStatus ?? summary?.reviewStatus
  }

  private var additions: Int {
    pr?.additions ?? summary?.additions ?? 0
  }

  private var deletions: Int {
    pr?.deletions ?? summary?.deletions ?? 0
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          if let tag {
            existingPrContent(tag)
          } else {
            emptyPrContent
          }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 22)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle(prNumberLabel)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(action: onRefresh) {
            if isRefreshing {
              ProgressView()
                .controlSize(.small)
            } else {
              Image(systemName: "arrow.clockwise")
            }
          }
          .disabled(isRefreshing)
          .accessibilityLabel("Refresh pull request details")
        }
      }
    }
  }

  private func existingPrContent(_ tag: LanePrTag) -> some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 10) {
          Image(systemName: "arrow.triangle.pull")
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(lanePullRequestTint(tag.state))
            .frame(width: 34, height: 34)
            .background(lanePullRequestTint(tag.state).opacity(0.12), in: Circle())

          VStack(alignment: .leading, spacing: 3) {
            Text(formatLanePrBadgeLabel(tag))
              .font(.caption.weight(.semibold))
              .foregroundStyle(lanePullRequestTint(tag.state))
            Text(lanePrStateLabel(tag.state))
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          Spacer(minLength: 0)
        }

        Text(tag.title)
          .font(.headline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)

        Text("Updated \(prRelativeTime(tag.updatedAt))")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }

      VStack(alignment: .leading, spacing: 10) {
        if let branchLine = workChatPrBranchLine(pr: pr, summary: summary, tag: tag) {
          WorkChatPrDetailRow(label: "Branch", value: branchLine, symbol: "arrow.triangle.branch")
          if pr != nil || summary != nil {
            WorkChatPrDetailRow(label: "Changes", value: "+\(additions) / -\(deletions)", symbol: "plus.forwardslash.minus")
          }
        } else if !tag.headBranch.isEmpty {
          WorkChatPrDetailRow(label: "Branch", value: tag.headBranch, symbol: "arrow.triangle.branch")
        }
        if let checksStatus, !checksStatus.isEmpty {
          WorkChatPrDetailRow(label: "Checks", value: workChatPrStatusLabel(checksStatus), symbol: workChatPrChecksSymbol(checksStatus))
        }
        if let reviewStatus, !reviewStatus.isEmpty, reviewStatus != "none" {
          WorkChatPrDetailRow(label: "Review", value: workChatPrStatusLabel(reviewStatus), symbol: "person.crop.circle.badge.checkmark")
        }
        if let mergeLine = workChatPrMergeLine(snapshot?.status) {
          WorkChatPrDetailRow(label: "Merge", value: mergeLine, symbol: "arrow.merge")
        }
      }

      if let errorMessage, !errorMessage.isEmpty {
        Text(errorMessage)
          .font(.footnote)
          .foregroundStyle(ADEColor.danger)
      }

      VStack(spacing: 10) {
        Button(action: onOpenPrsTab) {
          Label("PRs tab", systemImage: "rectangle.grid.1x2")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)

        HStack(spacing: 10) {
          Button(action: onOpenGitHub) {
            Label("GitHub", systemImage: "link")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .disabled(githubUrl.isEmpty)

          Button(action: onCopyLink) {
            Label(copiedLink ? "Copied" : "Copy", systemImage: copiedLink ? "checkmark" : "doc.on.doc")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .disabled(githubUrl.isEmpty)
        }
      }
    }
  }

  private var emptyPrContent: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 10) {
        Image(systemName: "arrow.triangle.pull")
          .font(.system(size: 20, weight: .bold))
          .foregroundStyle(ADEColor.accent)
          .frame(width: 42, height: 42)
          .background(ADEColor.accent.opacity(0.12), in: Circle())

        Text("No pull request yet")
          .font(.headline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)

        Text("Create one from this lane or open the PRs tab with the lane preselected.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let createBlockedReason, !createBlockedReason.isEmpty {
        Text(createBlockedReason)
          .font(.footnote)
          .foregroundStyle(ADEColor.warning)
      }

      VStack(spacing: 10) {
        Button(action: onCreate) {
          Label("Create pull request", systemImage: "plus")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!canCreate)

        Button(action: onOpenPrsTab) {
          Label("Open PR in PRs tab", systemImage: "rectangle.grid.1x2")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
      }

      if let errorMessage, !errorMessage.isEmpty {
        Text(errorMessage)
          .font(.footnote)
          .foregroundStyle(ADEColor.danger)
      }
    }
  }
}

private struct WorkChatPrDetailRow: View {
  let label: String
  let value: String
  let symbol: String

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 18, height: 18)
      VStack(alignment: .leading, spacing: 2) {
        Text(label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Text(value)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }
}

private func workChatPrStatusLabel(_ status: String) -> String {
  status
    .replacingOccurrences(of: "_", with: " ")
    .split(separator: " ")
    .map { word in
      word.prefix(1).uppercased() + String(word.dropFirst())
    }
    .joined(separator: " ")
}

private func workChatPrBranchLine(pr: PullRequestListItem?, summary: PrSummary?, tag: LanePrTag) -> String? {
  if let pr {
    return "\(pr.headBranch) -> \(pr.baseBranch)"
  }
  if let summary {
    return "\(summary.headBranch) -> \(summary.baseBranch)"
  }
  let head = tag.headBranch.trimmingCharacters(in: .whitespacesAndNewlines)
  return head.isEmpty ? nil : head
}

private func workChatPrChecksSymbol(_ status: String) -> String {
  switch status {
  case "passing":
    return "checkmark.circle.fill"
  case "failing":
    return "xmark.circle.fill"
  case "pending":
    return "clock.fill"
  default:
    return "circle"
  }
}

private func workChatPrMergeLine(_ status: PrStatus?) -> String? {
  guard let status else { return nil }
  if status.mergeConflicts {
    return "Merge conflicts"
  }
  if status.behindBaseBy > 0 {
    return "\(status.behindBaseBy) behind base"
  }
  if status.mergeStateStatus == .draft {
    return "Draft"
  }
  if status.mergeabilityComputing == true {
    return "Computing"
  }
  if status.isMergeable {
    return "Mergeable"
  }
  return "Blocked"
}
