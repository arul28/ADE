import SwiftUI

extension LaneDetailScreen {
  // MARK: - Rebase banner

  @ViewBuilder
  var rebaseBannerSection: some View {
    if let detail,
       let suggestion = detail.rebaseSuggestion,
       !rebaseSuggestionDismissed,
       suggestion.dismissedAt == nil {
      LaneDetailRebaseBanner(
        behindCount: suggestion.behindCount,
        parentLabel: detail.lane.baseRef,
        hasPr: suggestion.hasPr,
        canRunLiveActions: canRunLiveActions,
        onViewRebase: {
          requestGitConfirmation(.rebaseLane)
        },
        onDismiss: handleRebaseSuggestionDismiss
      )
    }
  }

  // MARK: - Conflict section

  @ViewBuilder
  func conflictSection(conflictState: GitConflictState) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundStyle(ADEColor.danger)
        Text(conflictState.kind == "merge" ? "Merge conflict" : "Rebase conflict")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer()
      }

      Text("\(conflictState.conflictedFiles.count) conflicted file\(conflictState.conflictedFiles.count == 1 ? "" : "s")")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)

      if !conflictState.conflictedFiles.isEmpty {
        ForEach(conflictState.conflictedFiles, id: \.self) { path in
          Text(path)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }

      ViewThatFits(in: .horizontal) {
        HStack(spacing: 12) {
          conflictContinueButton(conflictState: conflictState)
          conflictAbortButton(conflictState: conflictState)
        }
        VStack(spacing: 10) {
          conflictContinueButton(conflictState: conflictState)
          conflictAbortButton(conflictState: conflictState)
        }
      }
    }
    .padding(14)
    .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.danger.opacity(0.3), lineWidth: 1)
    )
  }

  @ViewBuilder
  private func conflictContinueButton(conflictState: GitConflictState) -> some View {
    Button {
      Task {
        await performAction(conflictState.kind == "merge" ? "merge continue" : "rebase continue") {
          if conflictState.kind == "merge" {
            try await syncService.mergeContinueGit(laneId: laneId)
          } else {
            try await syncService.rebaseContinueGit(laneId: laneId)
          }
        }
      }
    } label: {
      Label("Continue", systemImage: "play.fill")
        .font(.subheadline.weight(.semibold))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
    .buttonStyle(.borderedProminent)
    .tint(ADEColor.accent)
    .disabled(!canRunLiveActions || !conflictState.canContinue)
  }

  @ViewBuilder
  private func conflictAbortButton(conflictState: GitConflictState) -> some View {
    Button {
      Task {
        await performAction(conflictState.kind == "merge" ? "merge abort" : "rebase abort") {
          if conflictState.kind == "merge" {
            try await syncService.mergeAbortGit(laneId: laneId)
          } else {
            try await syncService.rebaseAbortGit(laneId: laneId)
          }
        }
      }
    } label: {
      Label("Abort", systemImage: "xmark.circle")
        .font(.subheadline.weight(.semibold))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
    .buttonStyle(.bordered)
    .tint(ADEColor.danger)
    .disabled(!canRunLiveActions || !conflictState.canAbort)
  }

  @MainActor
  func openCommitDiffs(for commit: GitCommitSummary) async {
    do {
      let files: [String]
      if let cached = cachedCommitDiffFilesBySha[commit.sha], !cached.isEmpty {
        files = cached
      } else {
        let loadedFiles = try await syncService.listCommitFiles(laneId: laneId, commitSha: commit.sha)
        cachedCommitDiffFilesBySha[commit.sha] = loadedFiles
        files = loadedFiles
      }

      guard !files.isEmpty else {
        errorMessage = "This commit has no file changes."
        return
      }

      commitDiffFiles = files
      commitDiffSha = commit.sha
      commitDiffSubject = commit.subject
      showCommitDiffPicker = true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }
}
