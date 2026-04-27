import SwiftUI
import UIKit

extension LaneDetailScreen {
  @ViewBuilder
  var gitSections: some View {
    if let detail {
      VStack(spacing: 14) {
        if let conflictState = detail.conflictState, conflictState.inProgress {
          conflictSection(conflictState: conflictState)
        }

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

        advancedRow(detail: detail)
      }
    }
  }

  // MARK: - Advanced entry

  @ViewBuilder
  func advancedRow(detail: LaneDetailPayload) -> some View {
    NavigationLink {
      LaneAdvancedScreen(
        snapshot: currentSnapshot,
        canRunLiveActions: canRunLiveActions,
        disabledSubtitle: liveActionDisabledSubtitle,
        laneId: laneId,
        branchRef: detail.lane.branchRef,
        laneType: detail.lane.laneType,
        missionId: detail.lane.missionId,
        laneRole: detail.lane.laneRole,
        onOpenManageSheet: { managePresented = true },
        onSwitchBranch: { showBranchPicker = true },
        onStash: {
          Task {
            await performAction("stash") {
              try await syncService.stashPush(laneId: laneId, message: "", includeUntracked: true)
            }
          }
        },
        onRebaseLane: { requestGitConfirmation(.rebaseLane) },
        onRebaseDescendants: { requestGitConfirmation(.rebaseDescendants) },
        onRebaseAndPush: { requestGitConfirmation(.rebaseAndPush) },
        onForcePush: { requestGitConfirmation(.forcePush) }
      )
    } label: {
      summaryRow(
        symbol: "slider.horizontal.3",
        title: "Advanced",
        detail: "Settings, branch tools, rebase & push"
      )
    }
    .buttonStyle(.plain)
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
          requestGitConfirmation(.rebaseLane)
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
      HStack(spacing: 10) {
        Image(systemName: amendCommit ? "arrow.counterclockwise" : "square.and.pencil")
          .font(.system(size: 15, weight: .semibold))
        Text(amendCommit ? "Amend last commit" : commitCTALabel(stagedCount: stagedCount, unstagedCount: unstagedCount))
          .font(.subheadline.weight(.semibold))
        Spacer(minLength: 8)
        Image(systemName: "chevron.up")
          .font(.system(size: 12, weight: .bold))
          .opacity(0.85)
      }
      .foregroundStyle(ADEColor.textPrimary)
      .frame(maxWidth: .infinity)
      .padding(EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14))
      .background(ADEColor.accent.opacity(0.22), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.accent.opacity(0.45), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions)
    .accessibilityHint("Opens the review and commit drawer.")
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
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
        .truncationMode(.tail)
      Image(systemName: "chevron.right")
        .font(.system(size: 11, weight: .bold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeGlassCard(cornerRadius: 14, padding: 0)
  }

  // MARK: - Status banner (inline chips, no glass card — sits inside header)

  @ViewBuilder
  func gitStatusBanner(detail: LaneDetailPayload) -> some View {
    let unstaged = detail.diffChanges?.unstaged.count ?? 0
    let staged = detail.diffChanges?.staged.count ?? 0
    let stashCount = detail.stashes.count

    if unstaged > 0 || staged > 0 || stashCount > 0 {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          if unstaged > 0 {
            LaneMicroChip(icon: "doc.badge.plus", text: "\(unstaged) unstaged", tint: ADEColor.warning)
          }
          if staged > 0 {
            LaneMicroChip(icon: "checkmark.circle", text: "\(staged) staged", tint: ADEColor.success)
          }
          if stashCount > 0 {
            LaneMicroChip(icon: "tray.2", text: "\(stashCount) stash\(stashCount == 1 ? "" : "es")", tint: ADEColor.textMuted)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func conflictContinueButton(conflictState: GitConflictState) -> some View {
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
  }

  @ViewBuilder
  private func conflictAbortButton(conflictState: GitConflictState) -> some View {
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
