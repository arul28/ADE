import SwiftUI

struct LaneDetailHeaderCard<Footer: View>: View {
  let snapshot: LaneListSnapshot
  let detail: LaneDetailPayload?
  let linkedPullRequests: [PullRequestListItem]
  let transitionNamespace: Namespace.ID?
  let transitionLaneId: String?
  let canRunLiveActions: Bool
  let onStackTapped: () -> Void
  let onOpenLinkedPullRequest: (PullRequestListItem) -> Void
  let onPush: () -> Void
  let onPull: () -> Void
  let onFetch: () -> Void
  @ViewBuilder let footer: () -> Footer

  // transitionNamespace / transitionLaneId are retained on the init for
  // caller compatibility but intentionally unused in body:
  // navigationTransition(.zoom(sourceID:)) on the container already
  // interpolates child layouts during the push, so this destination must
  // NOT emit per-element matchedGeometryEffect — the list row is the sole
  // isSource=true view in each lane-icon/title/status group.

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      headerTopRow
      detailMetadataRow
      statusRow
      if let summary = headerSummaryText {
        Text(summary)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      activeSessionsRow
      syncActionsRow
      footer()
    }
    .adeGlassCard(cornerRadius: 18, padding: 16)
    .accessibilityElement(children: .contain)
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
            .minimumScaleFactor(0.85)

          laneTypeBadge
        }
      }

      Spacer(minLength: 8)
    }
  }

  /// Inline Pull / Push / Fetch row pinned to the bottom of the header card.
  /// Sync details + the underlying full sync screen live in Advanced now —
  /// this is the everyday "I'm done, push it" affordance.
  @ViewBuilder
  private var syncActionsRow: some View {
    let ahead = snapshot.lane.status.ahead
    let behind = snapshot.lane.status.behind
    let summary = syncSummaryText(ahead: ahead, behind: behind)

    HStack(spacing: 8) {
      Image(systemName: "arrow.triangle.2.circlepath")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text(summary)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 8)

      syncActionButton(
        symbol: "arrow.down.to.line.compact",
        // Action flips between Pull (when there are commits to integrate)
        // and Fetch (when we just want to refresh remote state). The label
        // and accessibility text must follow the action so VoiceOver users
        // hear what the button is actually about to do.
        label: behind > 0 ? "Pull" : "Fetch",
        tint: behind > 0 ? ADEColor.warning : ADEColor.textPrimary,
        emphasize: behind > 0,
        action: behind > 0 ? onPull : onFetch
      )
      syncActionButton(
        symbol: "arrow.up.to.line.compact",
        label: "Push",
        tint: ahead > 0 ? ADEColor.success : ADEColor.textPrimary,
        emphasize: ahead > 0,
        action: onPush
      )
    }
    .padding(.top, 2)
  }

  private func syncSummaryText(ahead: Int, behind: Int) -> String {
    switch (ahead, behind) {
    case (0, 0): return "In sync with remote"
    case (let a, 0): return "\(a) ahead"
    case (0, let b): return "\(b) behind"
    case (let a, let b): return "\(a) ahead · \(b) behind"
    }
  }

  @ViewBuilder
  private func syncActionButton(
    symbol: String,
    label: String,
    tint: Color,
    emphasize: Bool,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: symbol)
          .font(.system(size: 11, weight: .bold))
        Text(label)
          .font(.caption.weight(.semibold))
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(
        (emphasize ? tint.opacity(0.16) : ADEColor.surfaceBackground.opacity(0.45)),
        in: Capsule()
      )
      .overlay(
        Capsule().stroke(tint.opacity(emphasize ? 0.32 : 0.16), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions)
    .opacity(canRunLiveActions ? 1 : 0.5)
    .accessibilityLabel(label)
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
        if let detail, !detail.stackChain.isEmpty {
          Button(action: onStackTapped) {
            LaneMicroChip(icon: "list.number", text: "Stack \(detail.stackChain.count)", tint: ADEColor.accent)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("View stack graph")
        }
      }
    }
  }

  @ViewBuilder
  private var activeSessionsRow: some View {
    let activeSessions = (detail?.sessions ?? []).filter { $0.status == "running" || $0.status == "active" }
    let activeChats = (detail?.chatSessions ?? []).filter { $0.status == "running" || $0.status == "active" }
    let totalActive = activeSessions.count + activeChats.count

    if totalActive > 0 {
      VStack(alignment: .leading, spacing: 6) {
        ForEach(activeSessions.prefix(2)) { session in
          HStack(spacing: 8) {
            LaneStatusIndicator(bucket: "running", size: 7)
            Text(session.title)
              .font(.caption)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Spacer()
            Text("Terminal")
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        ForEach(activeChats.prefix(2)) { chat in
          HStack(spacing: 8) {
            LaneStatusIndicator(bucket: "running", size: 7)
            Text(chat.title ?? chat.provider.capitalized)
              .font(.caption)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Spacer()
            Text(chat.provider.capitalized)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        if totalActive > 4 {
          Text("+ \(totalActive - 4) more")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .padding(10)
      .background(ADEColor.surfaceBackground.opacity(0.4), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
    if snapshot.lane.status.dirty { pieces.append("dirty") } else { pieces.append("clean") }
    if snapshot.lane.status.ahead > 0 { pieces.append("\(snapshot.lane.status.ahead) ahead") }
    if snapshot.lane.status.behind > 0 { pieces.append("\(snapshot.lane.status.behind) behind") }
    if snapshot.lane.childCount > 0 { pieces.append("\(snapshot.lane.childCount) child\(snapshot.lane.childCount == 1 ? "" : "ren")") }
    if !linkedPullRequests.isEmpty { pieces.append("\(linkedPullRequests.count) linked pull request\(linkedPullRequests.count == 1 ? "" : "s")") }
    return pieces.joined(separator: ", ")
  }

  private var headerSummaryText: String? {
    guard let detail else { return nil }
    if let conflictStatus = detail.conflictStatus {
      return conflictSummary(conflictStatus)
    }
    return nil
  }
}
