import SwiftUI

// MARK: - Header card

struct LaneDetailHeaderCard: View {
  let snapshot: LaneListSnapshot
  let detail: LaneDetailPayload?
  let linkedPullRequests: [PullRequestListItem]
  let isExpanded: Bool
  let onToggleExpanded: () -> Void
  let onManageTapped: () -> Void
  let onStackTapped: () -> Void
  let onOpenLinkedPullRequest: (PullRequestListItem) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      headerTopRow
      if isExpanded {
        VStack(alignment: .leading, spacing: 10) {
          detailMetadataRow
          statusRow
          if let summary = headerSummaryText {
            Text(summary)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          if let detail {
            stackRow(detail: detail)
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 16)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(headerAccessibilityLabel)
  }

  private var headerTopRow: some View {
    HStack(alignment: .top, spacing: 10) {
      LaneStatusIndicator(bucket: snapshot.runtime.bucket, size: 12)

      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(detail?.lane.name ?? snapshot.lane.name)
            .font(.headline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)

          laneTypeBadge
        }

        if !isExpanded {
          Text(snapshot.lane.branchRef)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }

      Spacer(minLength: 8)

      VStack(alignment: .trailing, spacing: 8) {
        Button(action: onManageTapped) {
          Image(systemName: "gearshape.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(8)
            .background(ADEColor.surfaceBackground.opacity(0.45), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Manage lane")

        Button(action: onToggleExpanded) {
          Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(8)
            .background(ADEColor.surfaceBackground.opacity(0.45), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isExpanded ? "Collapse lane header" : "Expand lane header")
      }
    }
  }

  @ViewBuilder
  private var detailMetadataRow: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(snapshot.lane.branchRef)
        .font(.system(.subheadline, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
      if snapshot.lane.baseRef != snapshot.lane.branchRef {
        Text("from \(snapshot.lane.baseRef)")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
  }

  private var statusRow: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        laneStatusBadge
        if snapshot.lane.status.ahead > 0 {
          LaneMicroChip(icon: "arrow.up", text: "\(snapshot.lane.status.ahead) ahead", tint: ADEColor.success)
        }
        if snapshot.lane.status.behind > 0 {
          LaneMicroChip(icon: "arrow.down", text: "\(snapshot.lane.status.behind) behind", tint: ADEColor.warning)
        }
        if snapshot.lane.childCount > 0 {
          LaneMicroChip(icon: "square.stack.3d.up", text: "\(snapshot.lane.childCount) child\(snapshot.lane.childCount == 1 ? "" : "ren")", tint: ADEColor.textMuted)
        }
        linkedPullRequestBadge
      }
    }
  }

  @ViewBuilder
  private func stackRow(detail: LaneDetailPayload) -> some View {
    if !detail.stackChain.isEmpty {
      Button(action: onStackTapped) {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 6) {
            Image(systemName: "list.number")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary)
            Text("Stack")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
            Spacer()
            Text("\(detail.stackChain.count) lane\(detail.stackChain.count == 1 ? "" : "s")")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
          }

          VStack(alignment: .leading, spacing: 4) {
            ForEach(detail.stackChain.prefix(3)) { item in
              HStack(spacing: 8) {
                Circle()
                  .fill(item.laneId == snapshot.lane.id ? ADEColor.accent : runtimeTint(bucket: detail.runtime.bucket))
                  .frame(width: 6, height: 6)
                  .padding(.leading, CGFloat(item.depth) * 10)
                Text(item.laneName)
                  .font(.caption)
                  .foregroundStyle(ADEColor.textPrimary)
                  .lineLimit(1)
                Spacer(minLength: 8)
                Text(item.branchRef)
                  .font(.system(.caption2, design: .monospaced))
                  .foregroundStyle(ADEColor.textSecondary)
              }
            }
            if detail.stackChain.count > 3 {
              Text("+ \(detail.stackChain.count - 3) more")
                .font(.caption2)
                .foregroundStyle(ADEColor.textMuted)
            }
          }
        }
        .padding(12)
        .background(ADEColor.surfaceBackground.opacity(0.4), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      }
      .buttonStyle(.plain)
    }
  }

  @ViewBuilder
  private var laneTypeBadge: some View {
    switch snapshot.lane.laneType {
    case "primary":
      LaneTypeBadge(text: "Primary", tint: ADEColor.accent)
    case "attached":
      LaneTypeBadge(text: "Attached", tint: ADEColor.textSecondary)
    default:
      LaneTypeBadge(text: "Worktree", tint: ADEColor.textSecondary)
    }
  }

  private var laneStatusBadge: some View {
    Group {
      if let detail, let conflictStatus = detail.conflictStatus, conflictStatus.status == "conflict-active" {
        LaneTypeBadge(text: "Conflict", tint: ADEColor.danger)
      } else if let detail, let autoRebaseStatus = detail.autoRebaseStatus, autoRebaseStatus.state != "autoRebased" {
        LaneTypeBadge(text: "Rebase attention", tint: ADEColor.warning)
      } else if snapshot.lane.archivedAt != nil {
        LaneTypeBadge(text: "Archived", tint: ADEColor.textMuted)
      } else if snapshot.lane.status.dirty {
        LaneTypeBadge(text: "Dirty", tint: ADEColor.warning)
      } else {
        LaneTypeBadge(text: "Clean", tint: ADEColor.success)
      }
    }
  }

  @ViewBuilder
  private var linkedPullRequestBadge: some View {
    if linkedPullRequests.count == 1, let pr = linkedPullRequests.first {
      Button {
        onOpenLinkedPullRequest(pr)
      } label: {
        LaneTypeBadge(
          text: "PR",
          tint: lanePullRequestTint(pr.state)
        )
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open linked pull request")
    } else if linkedPullRequests.count > 1 {
      Menu {
        ForEach(Array(linkedPullRequests.enumerated()), id: \.offset) { _, pr in
          Button(pr.title.isEmpty ? "PR #\(pr.githubPrNumber)" : pr.title) {
            onOpenLinkedPullRequest(pr)
          }
        }
      } label: {
        LaneTypeBadge(
          text: "\(linkedPullRequests.count) PRs",
          tint: lanePullRequestTint(linkedPullRequests.first?.state ?? "open")
        )
      }
      .accessibilityLabel("\(linkedPullRequests.count) linked pull requests")
    }
  }

  private var headerAccessibilityLabel: String {
    var pieces = [snapshot.lane.name, snapshot.lane.branchRef]
    if snapshot.lane.status.dirty {
      pieces.append("dirty")
    } else {
      pieces.append("clean")
    }
    if snapshot.lane.status.ahead > 0 {
      pieces.append("\(snapshot.lane.status.ahead) ahead")
    }
    if snapshot.lane.status.behind > 0 {
      pieces.append("\(snapshot.lane.status.behind) behind")
    }
    if snapshot.lane.childCount > 0 {
      pieces.append("\(snapshot.lane.childCount) child\(snapshot.lane.childCount == 1 ? "" : "ren")")
    }
    if !linkedPullRequests.isEmpty {
      pieces.append("\(linkedPullRequests.count) linked pull request\(linkedPullRequests.count == 1 ? "" : "s")")
    }
    return pieces.joined(separator: ", ")
  }

  private var headerSummaryText: String? {
    guard let detail else { return nil }
    if let conflictStatus = detail.conflictStatus {
      return conflictSummary(conflictStatus)
    }
    if let autoRebaseStatus = detail.autoRebaseStatus, autoRebaseStatus.state != "autoRebased" {
      return autoRebaseStatus.message ?? "Rebase attention required."
    }
    if let rebaseSuggestion = detail.rebaseSuggestion {
      return "Behind parent by \(rebaseSuggestion.behindCount) commit\(rebaseSuggestion.behindCount == 1 ? "" : "s")."
    }
    return nil
  }
}
