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

  @State private var pendingConfirmation: CommitHistoryConfirmation?

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
      .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
    }
    .background(ADEColor.surfaceBackground.ignoresSafeArea())
    .navigationTitle("\(laneName) commits")
    .navigationBarTitleDisplayMode(.inline)
    .alert(item: $pendingConfirmation) { confirmation in
      Alert(
        title: Text(confirmation.title),
        message: Text(confirmation.message),
        primaryButton: .destructive(Text(confirmation.confirmTitle)) {
          Task { await perform(confirmation) }
        },
        secondaryButton: .cancel()
      )
    }
  }

  private var emptyState: some View {
    ADEEmptyStateView(
      symbol: "clock.arrow.circlepath",
      title: "No commits yet",
      message: "Commits on this lane will appear here."
    )
  }

  private func commitRow(commit: GitCommitSummary, isHead: Bool) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(commit.subject)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .minimumScaleFactor(0.92)
        if isHead {
          LaneMicroChip(icon: "bookmark.fill", text: "HEAD", tint: ADEColor.accent)
        }
        if commit.parents.count > 1 {
          LaneMicroChip(icon: "arrow.triangle.merge", text: "MERGE", tint: ADEColor.warning)
        }
        Spacer()
        Text(commit.shortSha)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
      Text("\(commit.authorName) • \(relativeTimestamp(commit.authoredAt))")
        .font(.caption2)
        .foregroundStyle(ADEColor.textSecondary)
      HStack(spacing: 8) {
        LaneActionButton(title: "Files", symbol: "doc.text.magnifyingglass") {
          Task { await onOpenDiff(commit) }
        }
        .disabled(!allowsDiffInspection(commit))
        LaneActionButton(title: "Copy", symbol: "doc.on.doc") {
          Task { await onCopyMessage(commit) }
        }
        .disabled(!canRunLiveActions)
        Spacer(minLength: 0)
        Menu {
          Button(role: .destructive) {
            pendingConfirmation = CommitHistoryConfirmation(kind: .revert, commit: commit)
          } label: {
            Label("Revert commit", systemImage: "arrow.uturn.backward")
          }
          .disabled(!canRunLiveActions)

          Button {
            pendingConfirmation = CommitHistoryConfirmation(kind: .cherryPick, commit: commit)
          } label: {
            Label("Cherry-pick commit", systemImage: "arrow.triangle.merge")
          }
          .disabled(!canRunLiveActions)
        } label: {
          LaneMenuLabel(title: "More")
        }
      }
    }
  }

  private func perform(_ confirmation: CommitHistoryConfirmation) async {
    pendingConfirmation = nil
    switch confirmation.kind {
    case .revert:
      await onRevert(confirmation.commit)
    case .cherryPick:
      await onCherryPick(confirmation.commit)
    }
  }
}

private struct CommitHistoryConfirmation: Identifiable {
  enum Kind: String {
    case revert
    case cherryPick
  }

  let kind: Kind
  let commit: GitCommitSummary

  var id: String { "\(kind.rawValue):\(commit.sha)" }

  var title: String {
    switch kind {
    case .revert: return "Revert this commit?"
    case .cherryPick: return "Cherry-pick this commit?"
    }
  }

  var message: String {
    switch kind {
    case .revert:
      return "ADE will create a new commit that reverses \(commit.shortSha)."
    case .cherryPick:
      return "ADE will apply \(commit.shortSha) onto the current lane."
    }
  }

  var confirmTitle: String {
    switch kind {
    case .revert: return "Revert"
    case .cherryPick: return "Cherry-pick"
    }
  }
}
