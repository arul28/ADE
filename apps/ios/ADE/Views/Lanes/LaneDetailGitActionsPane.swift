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
  let onRebaseAndPush: () -> Void
  let onForcePush: () -> Void
  let onOpenLinkedPullRequest: (PullRequestListItem) -> Void
  /// A new lane from this lane's branch with a copy of its uncommitted changes.
  let onCreateLaneFromChanges: () -> Void
  /// Reads the lane's branch changes; nil when the host predates branch diffs.
  var loadBranchChanges: (() async throws -> BranchDiffChanges)? = nil
  var onOpenBranchDiff: ((FileChange) -> Void)? = nil

  @State private var pullMode: String = "rebase"
  @State private var pendingCommitConfirmation: CommitHistoryConfirmation?
  @State private var branchExpanded = false
  @State private var branchChanges: BranchDiffChanges?
  @State private var branchError: String?
  @FocusState private var commitFieldFocused: Bool

  private var stagedFiles: [FileChange] { detail.diffChanges?.staged ?? [] }
  private var unstagedFiles: [FileChange] { detail.diffChanges?.unstaged ?? [] }
  private var syncStatus: GitUpstreamSyncStatus? { detail.syncStatus }
  private var actionsEnabled: Bool { canRunLiveActions && busyAction == nil }
  private var canCopyChangesToNewLane: Bool {
    !unstagedFiles.isEmpty && actionsEnabled
  }

  /// The lane's git, as the same inset-grouped rows the Overview uses: what
  /// to commit, how the branch stands against its upstream and base, the
  /// changed files, the branch's diff, stashes and history. The column's
  /// header already names the lane, its branch and its state, and the
  /// toolbar's ⋯ (and pull to refresh) refreshes, so neither repeats here.
  var body: some View {
    List {
      if hasCommittableWork {
        commitSection
      }
      syncSection
      changesSections
      if loadBranchChanges != nil {
        branchSection
      }
      stashesSection
      historySection
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground)
    .listSectionSpacing(.compact)
    .contentMargins(.top, 4, for: .scrollContent)
    .contentMargins(.bottom, 24, for: .scrollContent)
    .duoInsetGroupedMargins()
    .scrollDismissesKeyboard(.interactively)
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

  // MARK: - Commit

  private var hasCommittableWork: Bool {
    amendCommit || !stagedFiles.isEmpty || !unstagedFiles.isEmpty || !commitMessage.isEmpty
  }

  private var commitTitle: String {
    if amendCommit { return "Amend last commit" }
    if stagedFiles.isEmpty { return "Stage files to commit" }
    return "Commit \(stagedFiles.count) staged file\(stagedFiles.count == 1 ? "" : "s")"
  }

  private var commitSection: some View {
    Section("Commit") {
      TextField("Commit message", text: $commitMessage, axis: .vertical)
        .lineLimit(1...4)
        .font(.subheadline)
        .focused($commitFieldFocused)
        .disabled(!actionsEnabled)
      Toggle("Amend", isOn: $amendCommit)
        .font(.subheadline)
        .disabled(!actionsEnabled)
      let canCommit = actionsEnabled && (amendCommit || !stagedFiles.isEmpty)
      Button {
        commitFieldFocused = false
        onCommit()
      } label: {
        Label(commitTitle, systemImage: "checkmark.circle")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(canCommit ? ADEColor.accent : ADEColor.textMuted)
      }
      .disabled(!canCommit)
    }
  }

  // MARK: - Sync

  private var shouldPull: Bool {
    guard let syncStatus else { return true }
    return syncStatus.hasUpstream && syncStatus.behind > 0 && !syncStatus.diverged
  }

  private var shouldPush: Bool {
    guard let syncStatus else { return true }
    return !syncStatus.hasUpstream || syncStatus.ahead > 0
  }

  private var pushValue: String {
    guard let syncStatus else { return "" }
    if !syncStatus.hasUpstream { return "Not pushed" }
    if syncStatus.diverged { return "Diverged" }
    return syncStatus.ahead > 0 ? "\(syncStatus.ahead) ahead" : "Up to date"
  }

  private var pullValue: String {
    guard let syncStatus else { return "" }
    return syncStatus.behind > 0 ? "\(syncStatus.behind) behind" : "Up to date"
  }

  /// Push (Publish before the branch has an upstream), Pull while the
  /// upstream has commits, Rebase while the base moved on, then the rest.
  /// Pull only shows when there is something to pull: a greyed Pull beside
  /// "behind base" read as broken, and catching up with the base is a rebase.
  private var syncSection: some View {
    Section("Sync") {
      if syncStatus?.hasUpstream == false {
        actionRow("Publish branch", systemImage: "icloud.and.arrow.up", value: "Not pushed") { onPush(false) }
          .disabled(!actionsEnabled)
      } else {
        actionRow("Push", systemImage: "arrow.up", value: pushValue) { onPush(false) }
          .disabled(!actionsEnabled || !shouldPush || (syncStatus?.diverged ?? false))
        if shouldPull {
          actionRow("Pull", systemImage: "arrow.down", value: pullValue) { onPull(pullMode) }
            .disabled(!actionsEnabled)
            .accessibilityHint("Pulls with \(pullMode)")
        }
      }
      if snapshot.lane.status.behind > 0, snapshot.lane.laneType != "primary" {
        actionRow(
          "Rebase onto \(normalizedPrBranchName(detail.lane.baseRef))",
          systemImage: "arrow.triangle.branch",
          value: "\(snapshot.lane.status.behind) behind",
          action: onRebaseLane
        )
        .disabled(!actionsEnabled)
      }
      moreActionsMenu
    }
  }

  private func actionRow(
    _ title: String,
    systemImage: String,
    value: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      LabeledContent {
        Text(value)
          .foregroundStyle(ADEColor.textSecondary)
      } label: {
        Label(title, systemImage: systemImage)
          .foregroundStyle(ADEColor.textPrimary)
      }
      .font(.subheadline)
      .contentShape(Rectangle())
    }
  }

  /// The rest of the git actions as a plain system menu row.
  private var moreActionsMenu: some View {
    Menu {
      Section("Pull with") {
        Picker("Pull with", selection: $pullMode) {
          Label("Rebase", systemImage: "arrow.triangle.branch").tag("rebase")
          Label("Merge", systemImage: "arrow.triangle.merge").tag("merge")
        }
      }
      Button { onPull(pullMode) } label: { Label("Pull", systemImage: "arrow.down") }
      Button { onFetch() } label: { Label("Fetch only", systemImage: "arrow.down.circle") }
      Button { onSwitchBranch() } label: { Label("Switch branch", systemImage: "arrow.triangle.branch") }
      Button { onStashPush(stashMessage) } label: { Label("Stash changes", systemImage: "tray.and.arrow.down") }
      Divider()
      Button { onRebaseLane() } label: { Label("Rebase lane", systemImage: "arrow.triangle.branch") }
      Button { onRebaseAndPush() } label: { Label("Rebase and push", systemImage: "arrow.up.and.down.text.horizontal") }
      Button(role: .destructive) { onForcePush() } label: { Label("Force push (lease)", systemImage: "arrow.up.forward.circle") }
    } label: {
      Label("More git actions", systemImage: "ellipsis.circle")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
    .disabled(!actionsEnabled)
    .accessibilityLabel("More git actions")
  }

  // MARK: - Changes

  @ViewBuilder
  private var changesSections: some View {
    if stagedFiles.isEmpty && unstagedFiles.isEmpty {
      Section("Changes") {
        Text("No uncommitted changes")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
      }
    } else {
      if !unstagedFiles.isEmpty {
        Section {
          ForEach(unstagedFiles) { file in
            fileRow(file, staged: false)
          }
        } header: {
          changesHeader(title: "Unstaged", count: unstagedFiles.count) {
            Button("Stage all", action: onStageAll)
              .disabled(!actionsEnabled)
          } menu: {
            Button(action: onStageAll) { Label("Stage all", systemImage: "plus.circle") }
            if canCopyChangesToNewLane {
              Button(action: onCreateLaneFromChanges) {
                Label("New lane with these changes", systemImage: "plus.square.on.square")
              }
            }
            Divider()
            Button(role: .destructive, action: onDiscardAllUnstaged) {
              Label("Discard all unstaged", systemImage: "trash")
            }
          }
        }
      }
      if !stagedFiles.isEmpty {
        Section {
          ForEach(stagedFiles) { file in
            fileRow(file, staged: true)
          }
        } header: {
          changesHeader(title: "Staged", count: stagedFiles.count) {
            Button("Unstage all", action: onUnstageAll)
              .disabled(!actionsEnabled)
          } menu: {
            Button(action: onUnstageAll) { Label("Unstage all", systemImage: "minus.circle") }
            Divider()
            Button(role: .destructive, action: onRestoreAllStaged) {
              Label("Restore all staged", systemImage: "arrow.uturn.backward.circle")
            }
          }
        }
      }
    }
  }

  private func changesHeader<Primary: View, MenuItems: View>(
    title: String,
    count: Int,
    @ViewBuilder primary: () -> Primary,
    @ViewBuilder menu: () -> MenuItems
  ) -> some View {
    HStack(spacing: 6) {
      Text(title)
      Text("\(count)")
        .monospacedDigit()
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 8)
      primary()
        .font(.caption.weight(.semibold))
        .textCase(nil)
      Menu {
        menu()
      } label: {
        Image(systemName: "ellipsis")
          .font(.caption.weight(.semibold))
          .frame(width: 28, height: 22)
          .contentShape(Rectangle())
      }
      .disabled(!actionsEnabled)
      .accessibilityLabel("\(title) actions")
    }
  }

  /// One changed file: its name and folder, a tap opens the diff, the
  /// trailing button stages (or unstages) it, the rest is on swipe and in
  /// the long-press menu.
  private func fileRow(_ file: FileChange, staged: Bool) -> some View {
    let name = (file.path as NSString).lastPathComponent
    let folder = (file.path as NSString).deletingLastPathComponent
    return HStack(spacing: 10) {
      Button {
        onOpenDiff(file, staged)
      } label: {
        HStack(spacing: 10) {
          Circle()
            .fill(fileKindTint(file.kind))
            .frame(width: 7, height: 7)
          VStack(alignment: .leading, spacing: 2) {
            Text(name)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
              .truncationMode(.middle)
            if !folder.isEmpty {
              Text(folder)
                .font(.caption)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
                .truncationMode(.head)
            }
          }
          Spacer(minLength: 4)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("\(name), \(file.kind)")
      .accessibilityHint("Opens the diff")

      Button {
        staged ? onUnstageFile(file) : onStageFile(file)
      } label: {
        Image(systemName: staged ? "minus.circle" : "plus.circle")
          .font(.body)
          .foregroundStyle(staged ? ADEColor.textSecondary : ADEColor.success)
          .frame(width: 32, height: 32)
          .contentShape(Rectangle())
      }
      .buttonStyle(.borderless)
      .disabled(!actionsEnabled)
      .accessibilityLabel(staged ? "Unstage" : "Stage")
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        staged ? onRestoreStaged(file) : onDiscardFile(file)
      } label: {
        Label(staged ? "Restore" : "Discard", systemImage: "arrow.uturn.backward")
      }
      .disabled(!actionsEnabled)
    }
    .contextMenu {
      Button { onOpenDiff(file, staged) } label: { Label("Diff", systemImage: "doc.text.magnifyingglass") }
      Button { onOpenFiles(file) } label: { Label("Open in Files", systemImage: "folder") }
      Button {
        staged ? onUnstageFile(file) : onStageFile(file)
      } label: {
        Label(staged ? "Unstage" : "Stage", systemImage: staged ? "minus.circle" : "plus.circle")
      }
      .disabled(!actionsEnabled)
      Button(role: .destructive) {
        staged ? onRestoreStaged(file) : onDiscardFile(file)
      } label: {
        Label(staged ? "Restore" : "Discard", systemImage: "arrow.uturn.backward")
      }
      .disabled(!actionsEnabled)
    }
  }

  private func fileKindTint(_ kind: String) -> Color {
    switch kind.lowercased() {
    case "added", "created", "untracked": return ADEColor.success
    case "deleted", "removed": return ADEColor.danger
    case "renamed", "moved": return ADEColor.info
    default: return ADEColor.warning
    }
  }

  // MARK: - Branch

  /// Everything the lane changed since its base, read-only: the files a
  /// committed lane's PR is made of, which the changes above cannot show
  /// once the work is committed.
  private var branchSection: some View {
    Section {
      if let branchError {
        Text(branchError)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
      } else if let branchChanges {
        if branchChanges.files.isEmpty {
          Text("No changes since \(branchChanges.baseRef)")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        } else {
          DisclosureGroup(isExpanded: $branchExpanded) {
            ForEach(branchChanges.files) { file in
              Button {
                onOpenBranchDiff?(file)
              } label: {
                HStack(spacing: 8) {
                  Text(file.path)
                    .font(.caption.monospaced())
                    .foregroundStyle(ADEColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.head)
                  Spacer(minLength: 6)
                  PrDiffStat(additions: file.additions ?? 0, deletions: file.deletions ?? 0, size: 11)
                }
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
            }
          } label: {
            LabeledContent {
              PrDiffStat(additions: branchChanges.additions, deletions: branchChanges.deletions, size: 12)
            } label: {
              Text("\(branchChanges.files.count) file\(branchChanges.files.count == 1 ? "" : "s")")
                .foregroundStyle(ADEColor.textPrimary)
            }
            .font(.subheadline)
          }
          .tint(ADEColor.textMuted)
        }
      } else {
        ProgressView()
          .frame(maxWidth: .infinity)
      }
    } header: {
      Text(branchChanges.map { "Branch vs \(normalizedPrBranchName($0.baseRef))" } ?? "Branch")
    }
    .task(id: "\(detail.recentCommits.first?.sha ?? ""):\(stagedFiles.count):\(unstagedFiles.count)") {
      await reloadBranchChanges()
    }
  }

  private func reloadBranchChanges() async {
    guard let loadBranchChanges else { return }
    do {
      branchChanges = try await loadBranchChanges()
      branchError = nil
    } catch {
      // A newer reload replaced this one (`.task(id:)` cancels it); that is not a failure.
      if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { return }
      branchError = error.localizedDescription
    }
  }

  // MARK: - Stashes

  private var stashesSection: some View {
    Section("Stashes") {
      if detail.stashes.isEmpty {
        actionRow("Stash changes", systemImage: "tray.and.arrow.down", value: "None saved") {
          onStashPush(stashMessage)
        }
        .disabled(!actionsEnabled || (stagedFiles.isEmpty && unstagedFiles.isEmpty))
      } else {
        ForEach(detail.stashes) { stash in
          Menu {
            Button { onStashApply(stash.ref) } label: { Label("Apply", systemImage: "tray.and.arrow.down") }
            Button { onStashPop(stash.ref) } label: { Label("Pop", systemImage: "tray.and.arrow.up") }
            Divider()
            Button(role: .destructive) { onStashDrop(stash.ref) } label: { Label("Drop", systemImage: "trash") }
          } label: {
            LabeledContent {
              Text(stash.ref)
                .font(.adeMono(11))
                .foregroundStyle(ADEColor.textMuted)
            } label: {
              Text(stash.subject.isEmpty ? stash.ref : stash.subject)
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(2)
            }
            .font(.subheadline)
            .contentShape(Rectangle())
          }
          .disabled(!actionsEnabled)
        }
      }
    }
  }

  // MARK: - History

  private var historySection: some View {
    Section("History") {
      if detail.recentCommits.isEmpty {
        Text("No commits yet")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
      } else {
        ForEach(Array(detail.recentCommits.enumerated()), id: \.element.id) { index, commit in
          historyRow(commit: commit, isHead: index == 0)
        }
      }
    }
  }

  /// The Overview's history row: the subject, then sha, author and age.
  /// A tap lists the commit's files; the long-press menu has the rest.
  private func historyRow(commit: GitCommitSummary, isHead: Bool) -> some View {
    Button {
      Task { await onOpenCommitDiff(commit) }
    } label: {
      VStack(alignment: .leading, spacing: 3) {
        Text(commit.subject)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        HStack(spacing: 6) {
          Text(verbatim: commit.shortSha)
            .font(.adeMono(11))
            .foregroundStyle(ADEColor.accent)
          Text("\(commit.authorName) · \(prCompactRelativeTime(commit.authoredAt))")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
          if isHead {
            Text("Head")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.success)
          }
          if commit.parents.count > 1 {
            Text("Merge")
              .font(.caption)
              .foregroundStyle(ADEColor.textMuted)
          }
          if !commit.pushed {
            Text("not pushed")
              .font(.caption)
              .foregroundStyle(ADEColor.warning)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
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
