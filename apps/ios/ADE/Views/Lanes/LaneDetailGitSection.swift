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

        if let diffChanges = detail.diffChanges, !diffChanges.unstaged.isEmpty {
          unstagedSection(changes: diffChanges.unstaged)
        }

        if let diffChanges = detail.diffChanges, !diffChanges.staged.isEmpty {
          stagedSection(changes: diffChanges.staged)
        }

        DisclosureGroup(isExpanded: $syncExpanded) {
          syncSectionContent(detail: detail)
        } label: {
          sectionHeader(title: "Sync", symbol: "arrow.triangle.2.circlepath", subtitle: detail.syncStatus.map(syncSummary))
        }
        .disclosureGroupStyle(GlassDisclosureStyle())

        if !detail.stashes.isEmpty || canRunLiveActions {
          DisclosureGroup(isExpanded: $stashesExpanded) {
            stashesSectionContent(detail: detail)
          } label: {
            sectionHeader(title: "Stashes", symbol: "tray.2", badge: detail.stashes.isEmpty ? nil : "\(detail.stashes.count)")
          }
          .disclosureGroupStyle(GlassDisclosureStyle())
        }

        if !detail.recentCommits.isEmpty {
          DisclosureGroup(isExpanded: $historyExpanded) {
            historySectionContent(detail: detail)
          } label: {
            sectionHeader(title: "Recent commits", symbol: "clock.arrow.circlepath", badge: "\(detail.recentCommits.count)")
          }
          .disclosureGroupStyle(GlassDisclosureStyle())
        }
      }
    }
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

  // MARK: - Sync section content

  @ViewBuilder
  func syncSectionContent(detail: LaneDetailPayload) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
        LaneQuickAction(title: "Fetch", symbol: "arrow.down.circle", tint: ADEColor.textSecondary) {
          Task { await performAction("fetch") { try await syncService.fetchGit(laneId: laneId) } }
        }
        .disabled(!canRunLiveActions)
        Menu {
          Button("Pull (merge)") {
            Task { await performAction("pull merge") { try await syncService.pullGit(laneId: laneId) } }
          }
          Button("Pull (rebase)") {
            Task { await performAction("pull rebase") { try await syncService.syncGit(laneId: laneId, mode: "rebase") } }
          }
        } label: {
          LaneQuickAction(title: "Pull", symbol: "arrow.down.to.line", tint: ADEColor.textSecondary) {}
        }
        .disabled(!canRunLiveActions)
        LaneQuickAction(
          title: detail.syncStatus?.hasUpstream == false ? "Publish" : "Push",
          symbol: "arrow.up.circle",
          tint: ADEColor.accent
        ) {
          Task { await performAction("push") { try await syncService.pushGit(laneId: laneId) } }
        }
        .disabled(!canRunLiveActions)
        Menu {
          Button("Force push") {
            Task { await performAction("force push") { try await syncService.pushGit(laneId: laneId, forceWithLease: true) } }
          }
          Button("Rebase lane only") {
            Task { await performAction("rebase lane") { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_only") } }
          }
          Button("Rebase lane + descendants") {
            Task { await performAction("rebase descendants") { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_and_descendants") } }
          }
          Button("Rebase and push") {
            Task { await performAction("rebase and push") { try await runRebaseAndPush() } }
          }
        } label: {
          LaneQuickAction(title: "More", symbol: "ellipsis.circle", tint: ADEColor.textSecondary) {}
        }
        .disabled(!canRunLiveActions)
      }

      if !canRunLiveActions {
        Text("Live git actions unlock after reconnect and lane sync finish.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }

      if let upstreamRef = detail.syncStatus?.upstreamRef {
        LaneInfoRow(label: "Upstream", value: upstreamRef, isMonospaced: true)
      }
    }
    .padding(.top, 8)
  }

  // MARK: - Stashes section content

  @ViewBuilder
  func stashesSectionContent(detail: LaneDetailPayload) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        TextField("Stash message", text: $stashMessage)
          .textFieldStyle(.plain)
          .adeInsetField(cornerRadius: 10, padding: 10)
          .disabled(!canRunLiveActions)
        LaneActionButton(title: "Stash", symbol: "tray.and.arrow.down", tint: ADEColor.accent) {
          Task {
            await performAction("stash") {
              try await syncService.stashPush(laneId: laneId, message: stashMessage, includeUntracked: true)
            }
            if errorMessage == nil { stashMessage = "" }
          }
        }
        .disabled(!canRunLiveActions)
      }

      if detail.stashes.count > 1 {
        LaneHoldToConfirmButton(title: "Clear all stashes", symbol: "trash", tint: ADEColor.danger) {
          Task {
            await performAction("clear stashes") {
              for stash in detail.stashes.reversed() {
                try await syncService.stashDrop(laneId: laneId, stashRef: stash.ref)
              }
            }
          }
        }
        .disabled(!canRunLiveActions)
      }

      ForEach(detail.stashes.prefix(20)) { stash in
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(stash.subject)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Spacer()
            if let createdAt = stash.createdAt {
              Text(relativeTimestamp(createdAt))
                .font(.caption2)
                .foregroundStyle(ADEColor.textMuted)
            }
          }
          HStack(spacing: 8) {
            LaneActionButton(title: "Apply", symbol: "tray.and.arrow.up") {
              Task { await performAction("stash apply") { try await syncService.stashApply(laneId: laneId, stashRef: stash.ref) } }
            }
            .disabled(!canRunLiveActions)
            LaneActionButton(title: "Pop", symbol: "arrow.up.right.square") {
              Task { await performAction("stash pop") { try await syncService.stashPop(laneId: laneId, stashRef: stash.ref) } }
            }
            .disabled(!canRunLiveActions)
            LaneActionButton(title: "Drop", symbol: "trash", tint: ADEColor.danger) {
              Task { await performAction("stash drop") { try await syncService.stashDrop(laneId: laneId, stashRef: stash.ref) } }
            }
            .disabled(!canRunLiveActions)
          }
        }
        if stash.id != detail.stashes.last?.id { Divider() }
      }
    }
    .padding(.top, 8)
  }

  // MARK: - Recent commits section content

  @ViewBuilder
  func historySectionContent(detail: LaneDetailPayload) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(detail.recentCommits.prefix(20)) { commit in
        let cachedCommitFiles = cachedCommitDiffFilesBySha[commit.sha] ?? []
        let allowsCommitDiffInspection = laneAllowsDiffInspection(
          connectionState: syncService.connectionState,
          laneStatus: syncService.status(for: .lanes),
          hasCachedTargets: !cachedCommitFiles.isEmpty
        )
        VStack(alignment: .leading, spacing: 6) {
          HStack {
            Text(commit.subject)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(2)
            if commit == detail.recentCommits.first {
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
                Task { await openCommitDiffs(for: commit) }
              }
              .disabled(!allowsCommitDiffInspection)
              LaneActionButton(title: "Copy message", symbol: "doc.on.doc") {
                Task {
                  do {
                    UIPasteboard.general.string = try await syncService.getCommitMessage(laneId: laneId, commitSha: commit.sha)
                  } catch {
                    ADEHaptics.error()
                    errorMessage = error.localizedDescription
                  }
                }
              }
              .disabled(!canRunLiveActions)
              LaneActionButton(title: "Revert", symbol: "arrow.uturn.backward", tint: ADEColor.warning) {
                Task { await performAction("revert commit") { try await syncService.revertCommit(laneId: laneId, commitSha: commit.sha) } }
              }
              .disabled(!canRunLiveActions)
              LaneActionButton(title: "Cherry-pick", symbol: "arrow.triangle.merge") {
                Task { await performAction("cherry pick") { try await syncService.cherryPickCommit(laneId: laneId, commitSha: commit.sha) } }
              }
              .disabled(!canRunLiveActions)
            }
          }
        }
        if commit.id != detail.recentCommits.last?.id { Divider() }
      }
    }
    .padding(.top, 8)
  }

  @MainActor
  private func openCommitDiffs(for commit: GitCommitSummary) async {
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
