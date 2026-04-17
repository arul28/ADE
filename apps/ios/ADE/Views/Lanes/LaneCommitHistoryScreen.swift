import SwiftUI

struct LaneCommitHistoryScreen: View {
  let laneName: String
  let commits: [GitCommitSummary]
  let canRunLiveActions: Bool
  let allowsDiffInspection: (GitCommitSummary) -> Bool
  let onOpenDiff: (GitCommitSummary) async -> Void
  let onCopyMessage: (GitCommitSummary) async -> Void
  let onRevert: (GitCommitSummary) async -> Void
  let onCherryPick: (GitCommitSummary) async -> Void

  var body: some View {
    ScrollView {
      VStack(spacing: 14) {
        if commits.isEmpty {
          emptyState
        } else {
          ADEGlassSection(title: "History", subtitle: "\(commits.count) commit\(commits.count == 1 ? "" : "s")") {
            VStack(alignment: .leading, spacing: 14) {
              ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
                commitRow(commit: commit, isHead: index == 0)
                if index < commits.count - 1 {
                  Divider().opacity(0.35)
                }
              }
            }
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
    }
    .background(ADEColor.surfaceBackground.ignoresSafeArea())
    .navigationTitle("\(laneName) commits")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var emptyState: some View {
    VStack(spacing: 8) {
      Image(systemName: "clock.arrow.circlepath")
        .font(.system(size: 26))
        .foregroundStyle(ADEColor.textMuted)
      Text("No commits yet")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text("Commits on this lane will appear here.")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 32)
  }

  private func commitRow(commit: GitCommitSummary, isHead: Bool) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(commit.subject)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        if isHead {
          LaneTypeBadge(text: "HEAD", tint: ADEColor.accent)
        }
        if commit.parents.count > 1 {
          LaneTypeBadge(text: "MERGE", tint: ADEColor.warning)
        }
        Spacer()
        Text(commit.shortSha)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
      Text("\(commit.authorName) • \(relativeTimestamp(commit.authoredAt))")
        .font(.caption2)
        .foregroundStyle(ADEColor.textSecondary)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          LaneActionButton(title: "Files", symbol: "doc.text.magnifyingglass") {
            Task { await onOpenDiff(commit) }
          }
          .disabled(!allowsDiffInspection(commit))
          LaneActionButton(title: "Copy message", symbol: "doc.on.doc") {
            Task { await onCopyMessage(commit) }
          }
          .disabled(!canRunLiveActions)
          LaneActionButton(title: "Revert", symbol: "arrow.uturn.backward", tint: ADEColor.warning) {
            Task { await onRevert(commit) }
          }
          .disabled(!canRunLiveActions)
          LaneActionButton(title: "Cherry-pick", symbol: "arrow.triangle.merge") {
            Task { await onCherryPick(commit) }
          }
          .disabled(!canRunLiveActions)
        }
      }
    }
  }
}
