import SwiftUI
import UIKit

// MARK: - Git section

extension LaneDetailScreen {
  @ViewBuilder
  var gitSections: some View {
    if let detail {
      VStack(spacing: 14) {
        gitStatusBanner(detail: detail)

        if let conflictState = detail.conflictState, conflictState.inProgress {
          conflictSection(conflictState: conflictState)
        }

        if detail.lane.status.dirty || !(detail.diffChanges?.staged.isEmpty ?? true) {
          commitCTAButton(detail: detail)
        }

        if let diffChanges = detail.diffChanges, !diffChanges.unstaged.isEmpty {
          unstagedSection(changes: diffChanges.unstaged)
        }

        if let diffChanges = detail.diffChanges, !diffChanges.staged.isEmpty {
          stagedSection(changes: diffChanges.staged)
        }

        actionsCard

        NavigationLink {
          LaneSyncDetailScreen(
            laneName: detail.lane.name,
            branchRef: detail.lane.branchRef,
            syncStatus: detail.syncStatus,
            canRunLiveActions: canRunLiveActions,
            onFetch: { Task { await performAction("fetch") { try await syncService.fetchGit(laneId: laneId) } } },
            onPullMerge: { Task { await performAction("pull merge") { try await syncService.pullGit(laneId: laneId) } } },
            onPullRebase: { Task { await performAction("pull rebase") { try await syncService.syncGit(laneId: laneId, mode: "rebase") } } },
            onPush: { Task { await performAction("push") { try await syncService.pushGit(laneId: laneId) } } }
          )
        } label: {
          summaryRow(
            symbol: "arrow.triangle.2.circlepath",
            title: "Sync",
            detail: detail.syncStatus.map(syncSummary) ?? "No sync status yet"
          )
        }
        .buttonStyle(.plain)

        NavigationLink {
          LaneStashesScreen(
            laneName: detail.lane.name,
            stashes: detail.stashes,
            canRunLiveActions: canRunLiveActions,
            onCreateStash: { message in
              await performAction("stash") {
                try await syncService.stashPush(laneId: laneId, message: message, includeUntracked: true)
              }
              return errorMessage == nil
            },
            onApply: { ref in
              await performAction("stash apply") { try await syncService.stashApply(laneId: laneId, stashRef: ref) }
            },
            onPop: { ref in
              await performAction("stash pop") { try await syncService.stashPop(laneId: laneId, stashRef: ref) }
            },
            onDrop: { ref in
              await performAction("stash drop") { try await syncService.stashDrop(laneId: laneId, stashRef: ref) }
            },
            onClearAll: {
              await performAction("clear stashes") {
                for stash in detail.stashes.reversed() {
                  try await syncService.stashDrop(laneId: laneId, stashRef: stash.ref)
                }
              }
            }
          )
        } label: {
          summaryRow(
            symbol: "tray.2",
            title: "Stashes",
            detail: detail.stashes.isEmpty ? "No stashes" : "\(detail.stashes.count) stash\(detail.stashes.count == 1 ? "" : "es")"
          )
        }
        .buttonStyle(.plain)

        NavigationLink {
          LaneCommitHistoryScreen(
            laneName: detail.lane.name,
            commits: detail.recentCommits,
            canRunLiveActions: canRunLiveActions,
            allowsDiffInspection: { commit in
              let cached = cachedCommitDiffFilesBySha[commit.sha] ?? []
              return laneAllowsDiffInspection(
                connectionState: syncService.connectionState,
                laneStatus: syncService.status(for: .lanes),
                hasCachedTargets: !cached.isEmpty
              )
            },
            onOpenDiff: { commit in await openCommitDiffs(for: commit) },
            onCopyMessage: { commit in
              do {
                UIPasteboard.general.string = try await syncService.getCommitMessage(laneId: laneId, commitSha: commit.sha)
              } catch {
                ADEHaptics.error()
                errorMessage = error.localizedDescription
              }
            },
            onRevert: { commit in
              await performAction("revert commit") { try await syncService.revertCommit(laneId: laneId, commitSha: commit.sha) }
            },
            onCherryPick: { commit in
              await performAction("cherry pick") { try await syncService.cherryPickCommit(laneId: laneId, commitSha: commit.sha) }
            }
          )
        } label: {
          summaryRow(
            symbol: "clock.arrow.circlepath",
            title: "Recent commits",
            detail: detail.recentCommits.isEmpty ? "No commits yet" : "\(detail.recentCommits.count) commit\(detail.recentCommits.count == 1 ? "" : "s")"
          )
        }
        .buttonStyle(.plain)
      }
    }
  }

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
        canRunLiveActions: canRunLiveActions,
        onRebase: {
          Task { await performAction("rebase lane") { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_only") } }
        },
        onDefer: handleRebaseSuggestionDefer,
        onDismiss: handleRebaseSuggestionDismiss
      )
    }
  }

  // MARK: - Commit CTA

  @ViewBuilder
  func commitCTAButton(detail: LaneDetailPayload) -> some View {
    let stagedCount = detail.diffChanges?.staged.count ?? 0
    let unstagedCount = detail.diffChanges?.unstaged.count ?? 0
    Button {
      showCommitSheet = true
    } label: {
      HStack(spacing: 8) {
        Image(systemName: amendCommit ? "arrow.counterclockwise" : "square.and.pencil")
          .font(.system(size: 14, weight: .semibold))
        Text(amendCommit ? "Amend last commit" : commitCTALabel(stagedCount: stagedCount, unstagedCount: unstagedCount))
          .font(.subheadline.weight(.semibold))
        Spacer()
        Image(systemName: "chevron.up")
          .font(.system(size: 11, weight: .bold))
          .opacity(0.7)
      }
      .foregroundStyle(ADEColor.textPrimary)
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .background(ADEColor.accent.opacity(0.22), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(ADEColor.accent.opacity(0.45), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions)
  }

  private func commitCTALabel(stagedCount: Int, unstagedCount: Int) -> String {
    if stagedCount > 0 {
      return "Commit \(stagedCount) staged file\(stagedCount == 1 ? "" : "s")"
    }
    if unstagedCount > 0 {
      return "Review & commit \(unstagedCount) change\(unstagedCount == 1 ? "" : "s")"
    }
    return "Commit changes"
  }

  // MARK: - Actions card

  @ViewBuilder
  var actionsCard: some View {
    if let detail {
      LaneActionsCard(
        canRunLiveActions: canRunLiveActions,
        canPush: (detail.lane.status.ahead) > 0 || detail.syncStatus?.hasUpstream == false,
        isPublish: detail.syncStatus?.hasUpstream == false,
        onPullMerge: {
          Task { await performAction("pull merge") { try await syncService.pullGit(laneId: laneId) } }
        },
        onPullRebase: {
          Task { await performAction("pull rebase") { try await syncService.syncGit(laneId: laneId, mode: "rebase") } }
        },
        onPush: {
          Task { await performAction("push") { try await syncService.pushGit(laneId: laneId) } }
        },
        onSync: {
          Task { await performAction("sync") { try await syncService.syncGit(laneId: laneId, mode: "rebase") } }
        },
        onFetch: {
          Task { await performAction("fetch") { try await syncService.fetchGit(laneId: laneId) } }
        },
        onRebaseLane: {
          Task { await performAction("rebase lane") { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_only") } }
        },
        onRebaseDescendants: {
          Task { await performAction("rebase descendants") { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_and_descendants") } }
        },
        onRebaseAndPush: {
          requestGitConfirmation(.rebaseAndPush)
        },
        onForcePush: {
          requestGitConfirmation(.forcePush)
        },
        onStash: {
          Task {
            await performAction("stash") {
              try await syncService.stashPush(laneId: laneId, message: "", includeUntracked: true)
            }
          }
        }
      )
    }
  }

  // MARK: - Summary row

  @ViewBuilder
  func summaryRow(symbol: String, title: String, detail: String) -> some View {
    HStack(spacing: 12) {
      Image(systemName: symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 24)
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Spacer(minLength: 8)
      Text(detail)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.tail)
      Image(systemName: "chevron.right")
        .font(.system(size: 11, weight: .bold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeGlassCard(cornerRadius: 14, padding: 0)
  }

  // MARK: - Status banner

  @ViewBuilder
  func gitStatusBanner(detail: LaneDetailPayload) -> some View {
    let unstaged = detail.diffChanges?.unstaged.count ?? 0
    let staged = detail.diffChanges?.staged.count ?? 0
    let stashCount = detail.stashes.count
    let ahead = detail.lane.status.ahead
    let behind = detail.lane.status.behind

    if unstaged > 0 || staged > 0 || stashCount > 0 || ahead > 0 || behind > 0 {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          if unstaged > 0 {
            LaneMicroChip(icon: "doc.badge.plus", text: "\(unstaged) unstaged", tint: ADEColor.warning)
          }
          if staged > 0 {
            LaneMicroChip(icon: "checkmark.circle", text: "\(staged) staged", tint: ADEColor.success)
          }
          if stashCount > 0 {
            LaneMicroChip(icon: "tray.2", text: "\(stashCount) stash\(stashCount == 1 ? "" : "es")", tint: ADEColor.textMuted)
          }
          if ahead > 0 {
            LaneMicroChip(icon: "arrow.up", text: "\(ahead) ahead", tint: ADEColor.success)
          }
          if behind > 0 {
            LaneMicroChip(icon: "arrow.down", text: "\(behind) behind", tint: ADEColor.warning)
          }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 4)
      }
      .padding(10)
      .background(ADEColor.surfaceBackground.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 12))
    }
  }

  // MARK: - Conflict section (always visible when active)

  @ViewBuilder
  func conflictSection(conflictState: GitConflictState) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundStyle(ADEColor.danger)
        Text("Rebase conflict")
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
        }
      }

      HStack(spacing: 12) {
        Button {
          Task { await performAction("rebase continue") { try await syncService.rebaseContinueGit(laneId: laneId) } }
        } label: {
          Label("Continue", systemImage: "play.fill")
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
        .buttonStyle(.borderedProminent)
        .tint(ADEColor.accent)
        .disabled(!canRunLiveActions || !conflictState.canContinue)

        Button {
          Task { await performAction("rebase abort") { try await syncService.rebaseAbortGit(laneId: laneId) } }
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
    }
    .padding(14)
    .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.danger.opacity(0.3), lineWidth: 1)
    )
  }

  // MARK: - Unstaged files

  @ViewBuilder
  func unstagedSection(changes: [FileChange]) -> some View {
    LaneFileTreeSection(
      title: "Unstaged files",
      subtitle: "\(changes.count) file\(changes.count == 1 ? "" : "s")",
      changes: changes,
      allowsLiveActions: canRunLiveActions,
      allowsDiffInspection: true,
      bulkActionTitle: changes.count > 1 ? "Stage all" : nil,
      bulkActionSymbol: "plus.circle.fill",
      bulkActionTint: ADEColor.accent,
      primaryActionTitle: "Stage",
      primaryActionSymbol: "plus.circle.fill",
      primaryActionTint: ADEColor.accent,
      secondaryActionTitle: "Discard",
      secondaryActionSymbol: "trash",
      secondaryActionTint: ADEColor.danger,
      extraBulkActions: [
        LaneFileTreeBulkAction(title: "Discard all", symbol: "trash", tint: ADEColor.danger, isDestructive: true) {
          Task {
            await performAction("discard all") {
              for file in changes {
                try await syncService.discardFile(laneId: laneId, path: file.path)
              }
            }
          }
        }
      ],
      onBulkAction: {
        Task {
          await performAction("stage all") {
            try await syncService.stageAll(laneId: laneId, paths: changes.map(\.path))
          }
        }
      },
      onDiff: { file in
        selectedDiffRequest = LaneDiffRequest(
          laneId: laneId,
          path: file.path,
          mode: "unstaged",
          compareRef: nil,
          compareTo: nil,
          title: (file.path as NSString).lastPathComponent
        )
      },
      onPrimaryAction: { file in
        Task { await performAction("stage file") { try await syncService.stageFile(laneId: laneId, path: file.path) } }
      },
      onSecondaryAction: { file in
        confirmDiscardFile = file
      },
      onOpenFiles: { file in
        Task { await openFiles(path: file.path) }
      }
    )
  }

  // MARK: - Staged files

  @ViewBuilder
  func stagedSection(changes: [FileChange]) -> some View {
    LaneFileTreeSection(
      title: "Staged files",
      subtitle: "\(changes.count) file\(changes.count == 1 ? "" : "s")",
      changes: changes,
      allowsLiveActions: canRunLiveActions,
      allowsDiffInspection: true,
      bulkActionTitle: changes.count > 1 ? "Unstage all" : nil,
      bulkActionSymbol: "minus.circle",
      bulkActionTint: ADEColor.warning,
      primaryActionTitle: "Unstage",
      primaryActionSymbol: "minus.circle",
      primaryActionTint: ADEColor.warning,
      secondaryActionTitle: "Restore",
      secondaryActionSymbol: "trash",
      secondaryActionTint: ADEColor.danger,
      extraBulkActions: [],
      onBulkAction: {
        Task {
          await performAction("unstage all") {
            try await syncService.unstageAll(laneId: laneId, paths: changes.map(\.path))
          }
        }
      },
      onDiff: { file in
        selectedDiffRequest = LaneDiffRequest(
          laneId: laneId,
          path: file.path,
          mode: "staged",
          compareRef: nil,
          compareTo: nil,
          title: (file.path as NSString).lastPathComponent
        )
      },
      onPrimaryAction: { file in
        Task { await performAction("unstage file") { try await syncService.unstageFile(laneId: laneId, path: file.path) } }
      },
      onSecondaryAction: { file in
        Task { await performAction("restore staged file") { try await syncService.restoreStagedFile(laneId: laneId, path: file.path) } }
      },
      onOpenFiles: { file in
        Task { await openFiles(path: file.path) }
      }
    )
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
