import SwiftUI

struct LaneSyncDetailScreen: View {
  let laneName: String
  let branchRef: String
  let syncStatus: GitUpstreamSyncStatus?
  let canRunLiveActions: Bool
  let onFetch: () -> Void
  let onPullMerge: () -> Void
  let onPullRebase: () -> Void
  let onPush: () -> Void

  @State private var pendingAction: LaneSyncAction?

  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 6) {
          Text("Upstream")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(summary)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
          VStack(alignment: .leading, spacing: 6) {
            LaneInfoRow(label: "Branch", value: branchRef, isMonospaced: true)
            if let status = syncStatus {
              LaneInfoRow(label: "Upstream", value: status.upstreamRef ?? "—", isMonospaced: status.upstreamRef != nil)
              LaneInfoRow(label: "Ahead", value: "\(status.ahead)")
              LaneInfoRow(label: "Behind", value: "\(status.behind)")
              LaneInfoRow(label: "Diverged", value: status.diverged ? "Yes" : "No")
              if !status.recommendedAction.isEmpty {
                LaneInfoRow(label: "Recommended", value: status.recommendedAction)
              }
            } else {
              Text("Sync status not loaded yet. Pull to refresh the lane detail.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
          .padding(.top, 4)
        }
        .adeGlassCard(cornerRadius: 14, padding: 14)

        ADEGlassSection(title: "Sync actions", subtitle: "Review the lane state before changing refs.") {
          VStack(spacing: 12) {
            HStack(spacing: 12) {
              syncTile(action: .fetch)
              syncTile(action: .pullMerge)
            }
            HStack(spacing: 12) {
              syncTile(action: .pullRebase)
              syncTile(action: .push)
            }
          }
        }
      }
      .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
    }
    .background(ADEColor.surfaceBackground.ignoresSafeArea())
    .navigationTitle("\(laneName) sync")
    .navigationBarTitleDisplayMode(.inline)
    .alert(item: $pendingAction) { action in
      Alert(
        title: Text(action.title),
        message: Text(action.message),
        primaryButton: action.isDestructive
          ? .destructive(Text(action.confirmTitle)) { perform(action) }
          : .default(Text(action.confirmTitle)) { perform(action) },
        secondaryButton: .cancel()
      )
    }
  }

  private var summary: String {
    guard let syncStatus else { return "Awaiting sync status" }
    return syncSummary(syncStatus)
  }

  private func syncTile(action: LaneSyncAction) -> some View {
    Button {
      pendingAction = action
    } label: {
      VStack(spacing: 8) {
        Image(systemName: action.symbol)
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(ADEColor.tintLanes)
        Text(action.buttonTitle)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(action.tint)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
      }
      .frame(maxWidth: .infinity)
      .frame(minHeight: 58)
      .adeGlassCard(cornerRadius: 14, padding: 12)
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions)
  }

  private func perform(_ action: LaneSyncAction) {
    pendingAction = nil
    switch action {
    case .fetch:
      onFetch()
    case .pullMerge:
      onPullMerge()
    case .pullRebase:
      onPullRebase()
    case .push:
      onPush()
    }
  }
}

private enum LaneSyncAction: String, Identifiable {
  case fetch
  case pullMerge
  case pullRebase
  case push

  var id: String { rawValue }

  var buttonTitle: String {
    switch self {
    case .fetch: return "Fetch"
    case .pullMerge: return "Pull merge"
    case .pullRebase: return "Pull rebase"
    case .push: return "Push"
    }
  }

  var title: String {
    switch self {
    case .fetch: return "Fetch remote refs?"
    case .pullMerge: return "Pull with merge?"
    case .pullRebase: return "Pull with rebase?"
    case .push: return "Push commits?"
    }
  }

  var message: String {
    switch self {
    case .fetch:
      return "ADE will update remote-tracking refs for this lane. Local files are not changed."
    case .pullMerge:
      return "ADE will fast-forward this lane to upstream. This only succeeds when local work has not diverged."
    case .pullRebase:
      return "ADE will replay local commits on top of upstream changes. Review status before continuing."
    case .push:
      return "ADE will update the remote branch with local commits from this lane."
    }
  }

  var confirmTitle: String {
    switch self {
    case .fetch: return "Fetch"
    case .pullMerge: return "Pull merge"
    case .pullRebase: return "Pull rebase"
    case .push: return "Push"
    }
  }

  var symbol: String {
    switch self {
    case .fetch: return "arrow.down.circle"
    case .pullMerge: return "arrow.down.to.line"
    case .pullRebase: return "arrow.triangle.2.circlepath"
    case .push: return "arrow.up.to.line"
    }
  }

  var tint: Color {
    switch self {
    case .push: return ADEColor.accent
    case .pullRebase: return ADEColor.warning
    default: return ADEColor.textPrimary
    }
  }

  var isDestructive: Bool {
    switch self {
    case .fetch, .push:
      return false
    case .pullMerge, .pullRebase:
      return true
    }
  }
}
