import SwiftUI
import UIKit

/// Slim git-actions surface ported from desktop `LaneGitActionsPane` / Work git drawer.
struct LaneDetailGitActionsPane: View {
  let snapshot: LaneListSnapshot
  let detail: LaneDetailPayload
  let linkedPullRequests: [PullRequestListItem]
  let canRunLiveActions: Bool
  let busyAction: String?
  @Binding var commitMessage: String
  @Binding var amendCommit: Bool
  @Binding var stashMessage: String

  let onRefresh: () -> Void
  let onCommit: () -> Void
  let onGenerateMessage: () async throws -> String
  let onPull: (_ mode: String) -> Void
  let onPush: (_ forceWithLease: Bool) -> Void
  let onFetch: () -> Void
  let onStageFile: (FileChange) -> Void
  let onUnstageFile: (FileChange) -> Void
  let onDiscardFile: (FileChange) -> Void
  let onRestoreStaged: (FileChange) -> Void
  let onStageAll: () -> Void
  let onUnstageAll: () -> Void
  let onDiscardAllUnstaged: () -> Void
  let onRestoreAllStaged: () -> Void
  let onOpenDiff: (FileChange, _ staged: Bool) -> Void
  let onOpenFiles: (FileChange) -> Void
  let onStashPush: (_ message: String) -> Void
  let onStashApply: (_ ref: String) -> Void
  let onStashPop: (_ ref: String) -> Void
  let onStashDrop: (_ ref: String) -> Void
  let onOpenCommitDiff: (GitCommitSummary) async -> Void
  let onCopyCommitMessage: (GitCommitSummary) async -> Void
  let onRevertCommit: (GitCommitSummary) -> Void
  let onCherryPickCommit: (GitCommitSummary) -> Void
  let onSwitchBranch: () -> Void
  let onRebaseLane: () -> Void
  let onRebaseDescendants: () -> Void
  let onRebaseAndPush: () -> Void
  let onForcePush: () -> Void
  let onOpenLinkedPullRequest: (PullRequestListItem) -> Void
  let onCreateLaneFromChanges: () -> Void

  @State private var pullMode: String = "rebase"
  @State private var showMoreActions = false
  @State private var isGeneratingMessage = false
  @State private var aiSetupHint: String?
  @State private var pendingCommitConfirmation: CommitHistoryConfirmation?
  @FocusState private var commitFieldFocused: Bool

  private var stagedFiles: [FileChange] { detail.diffChanges?.staged ?? [] }
  private var unstagedFiles: [FileChange] { detail.diffChanges?.unstaged ?? [] }
  private var syncStatus: GitUpstreamSyncStatus? { detail.syncStatus }
  private var canRescueUnstaged: Bool {
    !unstagedFiles.isEmpty && stagedFiles.isEmpty && canRunLiveActions && busyAction == nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      headerSection
      actionToolbar
      if showMoreActions {
        moreActionsSection
      }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          filesSection
          stashesSection
          historySection
        }
        .padding(EdgeInsets(top: 12, leading: 0, bottom: 20, trailing: 0))
      }
    }
    .alert(item: $pendingCommitConfirmation) { confirmation in
      Alert(
        title: Text(confirmation.title),
        message: Text(confirmation.message),
        primaryButton: .destructive(Text(confirmation.confirmTitle)) {
          switch confirmation.kind {
          case .revert: onRevertCommit(confirmation.commit)
          case .cherryPick: onCherryPickCommit(confirmation.commit)
          }
        },
        secondaryButton: .cancel()
      )
    }
  }

  // MARK: - Header

  private var headerSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Circle()
          .fill(laneAccentColor)
          .frame(width: 8, height: 8)
        Text(snapshot.lane.name)
          .font(.headline.weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        if let issue = primaryLaneLinearIssue(for: snapshot.lane) {
          LaneLinearIssueBadge(issue: issue)
        }
        Spacer(minLength: 0)
        if let syncStatus {
          Text(compactSyncSummary(syncStatus))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          branchBadge
          cleanBadge
          if snapshot.lane.status.ahead > 0 || snapshot.lane.status.behind > 0 {
            LaneMicroChip(
              icon: "arrow.up.arrow.down",
              text: "base ↑\(snapshot.lane.status.ahead) ↓\(snapshot.lane.status.behind)",
              tint: ADEColor.textMuted
            )
          }
          linkedPullRequestBadge
          if let origin = originLabel {
            Text(origin)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }
      }

      if let conflictStatus = detail.conflictStatus {
        Text(conflictSummary(conflictStatus))
          .font(.caption2)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
      }
    }
    .padding(EdgeInsets(top: 4, leading: 0, bottom: 10, trailing: 0))
  }

  private var laneAccentColor: Color {
    laneSurfaceTint(forHex: snapshot.lane.color).text ?? ADEColor.accent
  }

  private var branchBadge: some View {
    HStack(spacing: 4) {
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 9, weight: .bold))
      Text(normalizedPrBranchName(snapshot.lane.branchRef))
        .font(.system(.caption2, design: .monospaced))
        .lineLimit(1)
    }
    .foregroundStyle(ADEColor.accent)
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(ADEColor.accent.opacity(0.14), in: Capsule())
  }

  private var cleanBadge: some View {
    let dirty = snapshot.lane.status.dirty || !stagedFiles.isEmpty || !unstagedFiles.isEmpty
    return Text(dirty ? "DIRTY" : "CLEAN")
      .font(.system(.caption2, design: .monospaced).weight(.bold))
      .foregroundStyle(dirty ? ADEColor.warning : ADEColor.success)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background((dirty ? ADEColor.warning : ADEColor.success).opacity(0.14), in: Capsule())
  }

  @ViewBuilder
  private var linkedPullRequestBadge: some View {
    if linkedPullRequests.count == 1, let pr = linkedPullRequests.first {
      Button { onOpenLinkedPullRequest(pr) } label: {
        LaneTypeBadge(text: "PR #\(pr.githubPrNumber)", tint: lanePullRequestTint(pr.state))
      }
      .buttonStyle(.plain)
    } else if linkedPullRequests.count > 1 {
      ForEach(linkedPullRequests.prefix(3)) { pr in
        Button { onOpenLinkedPullRequest(pr) } label: {
          LaneTypeBadge(text: "#\(pr.githubPrNumber)", tint: lanePullRequestTint(pr.state))
        }
        .buttonStyle(.plain)
      }
    }
  }

  private var originLabel: String? {
    if snapshot.lane.laneType == "primary" { return nil }
    if let base = detail.lane.baseRef.nilIfEmpty, base != snapshot.lane.branchRef {
      return "from \(normalizedPrBranchName(base))"
    }
    return nil
  }

  // MARK: - Toolbar

  private var actionToolbar: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        TextField("Commit message", text: $commitMessage, axis: .vertical)
          .lineLimit(1...3)
          .font(.system(.subheadline, design: .monospaced))
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
          .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.5)
          )
          .focused($commitFieldFocused)
          .disabled(!canRunLiveActions || busyAction != nil)

        gitToolbarButton(
          title: amendCommit ? "Amend on" : "Amend",
          tint: amendCommit ? ADEColor.warning : ADEColor.textSecondary,
          emphasize: amendCommit
        ) {
          amendCommit.toggle()
        }
        .disabled(!canRunLiveActions || busyAction != nil)

        gitToolbarButton(title: "Commit", tint: ADEColor.accent, emphasize: true) {
          onCommit()
        }
        .disabled(!canRunLiveActions || busyAction != nil || (!amendCommit && stagedFiles.isEmpty))
      }

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          gitToolbarButton(title: pullMode == "merge" ? "Merge" : "Rebase", tint: ADEColor.textSecondary) {
            pullMode = pullMode == "merge" ? "rebase" : "merge"
          }
          gitToolbarButton(title: "Pull", tint: shouldPull ? ADEColor.warning : ADEColor.textPrimary, emphasize: shouldPull) {
            onPull(pullMode)
          }
          .disabled(!canRunLiveActions || busyAction != nil || !shouldPull)
          gitToolbarButton(title: pushTitle, tint: shouldPush ? ADEColor.success : ADEColor.textPrimary, emphasize: shouldPush) {
            onPush(false)
          }
          .disabled(!canRunLiveActions || busyAction != nil || !shouldPush || (syncStatus?.diverged ?? false))
          gitToolbarButton(title: showMoreActions ? "More ▴" : "More ▾", tint: showMoreActions ? ADEColor.accent : ADEColor.textMuted) {
            withAnimation(.smooth(duration: 0.2)) { showMoreActions.toggle() }
          }
          Button(action: onRefresh) {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
              .frame(width: 34, height: 34)
              .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
          }
          .buttonStyle(.plain)
          .disabled(busyAction != nil)
          .accessibilityLabel("Refresh git state")
        }
      }

      HStack(spacing: 8) {
        Button(action: triggerSuggest) {
          Label("Suggest message", systemImage: "sparkles")
            .font(.caption.weight(.semibold))
        }
        .buttonStyle(.borderless)
        .disabled(!canRunLiveActions || isGeneratingMessage || aiSetupHint != nil)
        Spacer(minLength: 0)
        Text(compactSyncSummary(syncStatus))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      if let aiSetupHint {
        Text(aiSetupHint)
          .font(.caption2)
          .foregroundStyle(ADEColor.warning)
      }
    }
    .padding(.vertical, 10)
    .padding(.horizontal, 10)
    .background(ADEColor.surfaceBackground.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.border.opacity(0.16), lineWidth: 0.5)
    )
    .padding(.bottom, 10)
  }

  private var shouldPull: Bool {
    guard let syncStatus else { return true }
    return syncStatus.hasUpstream && syncStatus.behind > 0 && !syncStatus.diverged
  }

  private var shouldPush: Bool {
    guard let syncStatus else { return true }
    return !syncStatus.hasUpstream || syncStatus.ahead > 0
  }

  private var pushTitle: String {
    syncStatus?.hasUpstream == false ? "Publish" : "Push"
  }

  @ViewBuilder
  private func gitToolbarButton(
    title: String,
    tint: Color,
    emphasize: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Text(title.uppercased())
        .font(.system(size: 10, weight: .bold, design: .monospaced))
        .foregroundStyle(tint)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
          (emphasize ? tint.opacity(0.16) : ADEColor.surfaceBackground.opacity(0.45)),
          in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(tint.opacity(emphasize ? 0.35 : 0.14), lineWidth: 0.5)
        )
    }
    .buttonStyle(.plain)
  }

  private func triggerSuggest() {
    guard !isGeneratingMessage else { return }
    isGeneratingMessage = true
    Task {
      defer { isGeneratingMessage = false }
      do {
        let message = try await onGenerateMessage()
        commitMessage = message
        ADEHaptics.success()
      } catch {
        let text = error.localizedDescription
        if text.localizedCaseInsensitiveContains("not configured") || text.localizedCaseInsensitiveContains("disabled") {
          aiSetupHint = "Enable AI commit messages on desktop in Settings."
        } else {
          ADEHaptics.error()
        }
      }
    }
  }

  // MARK: - More actions

  private var moreActionsSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      moreActionRow("Fetch only", symbol: "arrow.down.circle") { onFetch() }
      moreActionRow("Switch branch", symbol: "arrow.triangle.branch") { onSwitchBranch() }
      moreActionRow("Stash changes", symbol: "tray.and.arrow.down") {
        onStashPush("")
      }
      moreActionRow("Rebase lane", symbol: "arrow.triangle.branch") { onRebaseLane() }
      moreActionRow("Rebase + descendants", symbol: "arrow.triangle.branch") { onRebaseDescendants() }
      moreActionRow("Rebase and push", symbol: "arrow.up.and.down.text.horizontal") { onRebaseAndPush() }
      moreActionRow("Force push (lease)", symbol: "arrow.up.forward.circle.fill", tint: ADEColor.warning) {
        onForcePush()
      }
    }
    .padding(10)
    .background(ADEColor.surfaceBackground.opacity(0.28), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .padding(.bottom, 10)
  }

  private func moreActionRow(_ title: String, symbol: String, tint: Color = ADEColor.textPrimary, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: symbol)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 20)
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
      }
      .padding(.vertical, 6)
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions || busyAction != nil)
    .opacity(canRunLiveActions ? 1 : 0.55)
  }

  // MARK: - Files

  private var filesSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text("FILES")
          .font(.caption.weight(.bold))
          .tracking(0.7)
          .foregroundStyle(ADEColor.textMuted)
        let fileCount = stagedFiles.count + unstagedFiles.count
        if fileCount > 0 {
          Text("\(fileCount)")
            .font(.caption2.weight(.bold))
            .foregroundStyle(ADEColor.accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(ADEColor.accent.opacity(0.14), in: Capsule())
        }
        Spacer(minLength: 0)
        if canRescueUnstaged {
          Button("New lane with changes") {
            onCreateLaneFromChanges()
          }
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.accent)
        }
      }
      if stagedFiles.isEmpty && unstagedFiles.isEmpty {
        Text("No changed files.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .padding(.horizontal, 2)
      } else {
        if !unstagedFiles.isEmpty {
          LaneFileTreeSection(
            title: "Unstaged",
            subtitle: "\(unstagedFiles.count) file\(unstagedFiles.count == 1 ? "" : "s")",
            changes: unstagedFiles,
            allowsLiveActions: canRunLiveActions,
            allowsDiffInspection: true,
            bulkActionTitle: unstagedFiles.count > 1 ? "Stage all" : nil,
            bulkActionSymbol: "plus.circle",
            bulkActionTint: ADEColor.success,
            primaryActionTitle: "Stage",
            primaryActionSymbol: "plus.circle",
            primaryActionTint: ADEColor.success,
            secondaryActionTitle: "Discard",
            secondaryActionSymbol: "arrow.uturn.backward",
            secondaryActionTint: ADEColor.danger,
            extraBulkActions: unstagedFiles.count > 1 ? [
              LaneFileTreeBulkAction(title: "Discard unstaged", symbol: "trash", tint: ADEColor.danger, isDestructive: true, action: onDiscardAllUnstaged)
            ] : [],
            onBulkAction: unstagedFiles.count > 1 ? onStageAll : nil,
            onDiff: { onOpenDiff($0, false) },
            onPrimaryAction: onStageFile,
            onSecondaryAction: onDiscardFile,
            onOpenFiles: onOpenFiles
          )
        }
        if !stagedFiles.isEmpty {
          LaneFileTreeSection(
            title: "Staged",
            subtitle: "\(stagedFiles.count) file\(stagedFiles.count == 1 ? "" : "s")",
            changes: stagedFiles,
            allowsLiveActions: canRunLiveActions,
            allowsDiffInspection: true,
            bulkActionTitle: stagedFiles.count > 1 ? "Unstage all" : nil,
            bulkActionSymbol: "minus.circle",
            bulkActionTint: ADEColor.textSecondary,
            primaryActionTitle: "Unstage",
            primaryActionSymbol: "minus.circle",
            primaryActionTint: ADEColor.textSecondary,
            secondaryActionTitle: "Restore",
            secondaryActionSymbol: "arrow.uturn.backward.circle",
            secondaryActionTint: ADEColor.warning,
            extraBulkActions: stagedFiles.count > 1 ? [
              LaneFileTreeBulkAction(title: "Restore all staged", symbol: "arrow.uturn.backward.circle.fill", tint: ADEColor.warning, isDestructive: true, action: onRestoreAllStaged)
            ] : [],
            onBulkAction: stagedFiles.count > 1 ? onUnstageAll : nil,
            onDiff: { onOpenDiff($0, true) },
            onPrimaryAction: onUnstageFile,
            onSecondaryAction: onRestoreStaged,
            onOpenFiles: onOpenFiles
          )
        }
      }
    }
  }

  // MARK: - Stashes

  private var stashesSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      sectionTitle("Branch stashes", badge: detail.stashes.count)
      if detail.stashes.isEmpty {
        HStack {
          Text("None saved")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
          Spacer()
          Button("Save changes") {
            onStashPush(stashMessage)
          }
          .font(.caption.weight(.semibold))
          .disabled(!canRunLiveActions || busyAction != nil)
        }
      } else {
        ForEach(detail.stashes) { stash in
          VStack(alignment: .leading, spacing: 6) {
            Text(stash.subject.isEmpty ? stash.ref : stash.subject)
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(2)
            HStack(spacing: 8) {
              LaneActionButton(title: "Apply", symbol: "tray.and.arrow.down") { onStashApply(stash.ref) }
                .disabled(!canRunLiveActions || busyAction != nil)
              LaneActionButton(title: "Pop", symbol: "tray.and.arrow.up") { onStashPop(stash.ref) }
                .disabled(!canRunLiveActions || busyAction != nil)
              LaneActionButton(title: "Drop", symbol: "trash", tint: ADEColor.danger) { onStashDrop(stash.ref) }
                .disabled(!canRunLiveActions || busyAction != nil)
            }
          }
          .padding(10)
          .background(ADEColor.surfaceBackground.opacity(0.28), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
      }
    }
  }

  // MARK: - History

  private var historySection: some View {
    VStack(alignment: .leading, spacing: 8) {
      sectionTitle("History", badge: detail.recentCommits.count)
      if detail.recentCommits.isEmpty {
        Text("No commits yet.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      } else {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(detail.recentCommits.enumerated()), id: \.element.id) { index, commit in
            historyRow(
              commit: commit,
              isHead: index == 0,
              isLast: index == detail.recentCommits.count - 1
            )
          }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(ADEColor.surfaceBackground.opacity(0.28), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }
    }
  }

  private func historyRow(commit: GitCommitSummary, isHead: Bool, isLast: Bool) -> some View {
    let isMerge = commit.parents.count > 1
    let dotColor: Color = isHead ? ADEColor.success : (isMerge ? ADEColor.accent : ADEColor.textMuted)

    return HStack(alignment: .top, spacing: 8) {
      VStack(spacing: 0) {
        Circle()
          .strokeBorder(dotColor, lineWidth: isHead || isMerge ? 2 : 1.5)
          .background(Circle().fill(isHead ? ADEColor.success : (isMerge ? ADEColor.accent.opacity(0.35) : ADEColor.pageBackground)))
          .frame(width: 9, height: 9)
        if !isLast {
          Rectangle()
            .fill(ADEColor.border.opacity(0.45))
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .padding(.vertical, 2)
        }
      }
      .frame(width: 10)

      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 4) {
          Text(commit.shortSha)
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundStyle(isHead ? ADEColor.success : ADEColor.textMuted)
          if isHead {
            historyBadge("HEAD", tint: ADEColor.success)
          }
          if isMerge {
            historyBadge("MERGE", tint: ADEColor.accent)
          }
          if commit.pushed {
            historyBadge("REMOTE", tint: ADEColor.accent)
          }
          Spacer(minLength: 0)
          Text(relativeTimestampCompact(commit.authoredAt))
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Text(commit.subject)
          .font(.caption)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 5)
    .contentShape(Rectangle())
    .contextMenu {
      Button {
        Task { await onOpenCommitDiff(commit) }
      } label: {
        Label("View files", systemImage: "doc.text.magnifyingglass")
      }
      Button {
        Task { await onCopyCommitMessage(commit) }
      } label: {
        Label("Copy message", systemImage: "doc.on.doc")
      }
      .disabled(!canRunLiveActions)
      Button {
        pendingCommitConfirmation = CommitHistoryConfirmation(kind: .revert, commit: commit)
      } label: {
        Label("Revert", systemImage: "arrow.uturn.backward")
      }
      .disabled(!canRunLiveActions)
      Button {
        pendingCommitConfirmation = CommitHistoryConfirmation(kind: .cherryPick, commit: commit)
      } label: {
        Label("Cherry-pick", systemImage: "arrow.triangle.merge")
      }
      .disabled(!canRunLiveActions)
    }
  }

  private func historyBadge(_ text: String, tint: Color) -> some View {
    Text(text)
      .font(.system(size: 8, weight: .bold, design: .monospaced))
      .foregroundStyle(tint)
      .padding(.horizontal, 4)
      .padding(.vertical, 1)
      .background(tint.opacity(0.14), in: Capsule())
  }

  private func sectionTitle(_ title: String, badge: Int) -> some View {
    HStack(spacing: 8) {
      Text(title.uppercased())
        .font(.caption.weight(.bold))
        .tracking(0.7)
        .foregroundStyle(ADEColor.textMuted)
      if badge > 0 {
        Text("\(badge)")
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.accent)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(ADEColor.accent.opacity(0.14), in: Capsule())
      }
      Spacer(minLength: 0)
    }
  }
}

private struct CommitHistoryConfirmation: Identifiable {
  enum Kind { case revert, cherryPick }
  let kind: Kind
  let commit: GitCommitSummary
  var id: String { "\(kind)-\(commit.sha)" }
  var title: String {
    switch kind {
    case .revert: return "Revert this commit?"
    case .cherryPick: return "Cherry-pick this commit?"
    }
  }
  var message: String {
    switch kind {
    case .revert: return "ADE will create a new commit that reverses \(commit.shortSha)."
    case .cherryPick: return "ADE will apply \(commit.shortSha) onto the current lane."
    }
  }
  var confirmTitle: String {
    switch kind {
    case .revert: return "Revert"
    case .cherryPick: return "Cherry-pick"
    }
  }
}

private extension String {
  var nilIfEmpty: String? {
    isEmpty ? nil : self
  }
}
