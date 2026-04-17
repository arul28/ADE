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

  var body: some View {
    ScrollView {
      VStack(spacing: 14) {
        ADEGlassSection(title: "Upstream", subtitle: summary) {
          VStack(alignment: .leading, spacing: 10) {
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
        }

        ADEGlassSection(title: "Quick sync") {
          VStack(spacing: 10) {
            HStack(spacing: 10) {
              syncTile(title: "Fetch", symbol: "arrow.down.circle", action: onFetch)
              syncTile(title: "Pull (merge)", symbol: "arrow.down.to.line", action: onPullMerge)
            }
            HStack(spacing: 10) {
              syncTile(title: "Pull (rebase)", symbol: "arrow.triangle.2.circlepath", action: onPullRebase)
              syncTile(title: "Push", symbol: "arrow.up.to.line", tint: ADEColor.accent, action: onPush)
            }
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
    }
    .background(ADEColor.surfaceBackground.ignoresSafeArea())
    .navigationTitle("\(laneName) sync")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var summary: String {
    guard let syncStatus else { return "Awaiting sync status" }
    return syncSummary(syncStatus)
  }

  private func syncTile(title: String, symbol: String, tint: Color = ADEColor.textPrimary, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 4) {
        Image(systemName: symbol)
          .font(.system(size: 16, weight: .semibold))
        Text(title)
          .font(.caption2.weight(.semibold))
      }
      .foregroundStyle(tint)
      .frame(maxWidth: .infinity)
      .frame(height: 58)
      .background(ADEColor.surfaceBackground.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions)
  }
}
