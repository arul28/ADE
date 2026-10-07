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
  let onRebaseDescendants: () -> Void
  let onRebaseAndPush: () -> Void
  let onForcePush: () -> Void
  let onOpenLinkedPullRequest: (PullRequestListItem) -> Void
  let onCreateLaneFromChanges: () -> Void
  /// Reads the lane's branch changes; nil when the host predates branch diffs.
  var loadBranchChanges: (() async throws -> BranchDiffChanges)? = nil
  var onOpenBranchDiff: ((FileChange) -> Void)? = nil

  @State private var pullMode: String = "rebase"
  @State private var pendingCommitConfirmation: CommitHistoryConfirmation?
  @State private var filesDisclosure = LaneSectionDisclosure()
  @State private var stashesDisclosure = LaneSectionDisclosure()
  @State private var historyDisclosure = LaneSectionDisclosure()
  @State private var branchDisclosure = LaneSectionDisclosure()
  @State private var branchChanges: BranchDiffChanges?
  @State private var branchError: String?
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
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          filesSection
          if loadBranchChanges != nil {
            branchSection
          }
          stashesSection
          historySection
        }
        .padding(EdgeInsets(top: 12, leading: 0, bottom: 20, trailing: 0))
      }
    }
    .onAppear { applyAutoDisclosure() }
    .onChange(of: stagedFiles.count) { _, _ in applyAutoDisclosure() }
    .onChange(of: unstagedFiles.count) { _, _ in applyAutoDisclosure() }
    .onChange(of: detail.stashes.count) { _, _ in applyAutoDisclosure() }
    .onChange(of: detail.recentCommits.count) { _, _ in applyAutoDisclosure() }
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
        WorkLaneLogoMark(color: laneAccentColor, laneIcon: snapshot.lane.icon, size: 15)
        Text(snapshot.lane.name)
          .font(.system(size: 22, weight: .bold))
          .foregroundStyle(ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
      }

      branchBadge

      LaneChipFlowLayout(spacing: 6, lineSpacing: 6) {
        cleanBadge
        if snapshot.lane.status.ahead > 0 || snapshot.lane.status.behind > 0 {
          Text("↑\(snapshot.lane.status.ahead) ↓\(snapshot.lane.status.behind) vs base")
            .font(.adeMono(11))
            .foregroundStyle(ADEColor.textMuted)
            .frame(minHeight: 18)
        }
        linkedPullRequestBadge
        if let issue = primaryLaneLinearIssue(for: snapshot.lane) {
          LaneLinearIssueBadge(issue: issue, compact: true)
        }
        if let origin = originLabel {
          Text(origin)
            .font(.system(size: 11.5))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .frame(minHeight: 18)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if let conflictStatus = detail.conflictStatus {
        Text(conflictSummary(conflictStatus))
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
      }
    }
    .padding(EdgeInsets(top: 4, leading: 2, bottom: 14, trailing: 0))
  }

  private func applyAutoDisclosure() {
    filesDisclosure.syncAuto(hasContent: !(stagedFiles.isEmpty && unstagedFiles.isEmpty))
    stashesDisclosure.syncAuto(hasContent: !detail.stashes.isEmpty)
    historyDisclosure.syncAuto(hasContent: !detail.recentCommits.isEmpty)
  }

  private var laneAccentColor: Color {
    laneSurfaceTint(forHex: snapshot.lane.color).text ?? ADEColor.accent
  }

  private var branchBadge: some View {
    HStack(spacing: 5) {
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 10, weight: .medium))
      Text(normalizedPrBranchName(snapshot.lane.branchRef))
        .font(.adeMono(12))
        .lineLimit(1)
        .truncationMode(.middle)
    }
    .foregroundStyle(ADEColor.textSecondary)
  }

  private var cleanBadge: some View {
    let dirty = snapshot.lane.status.dirty || !stagedFiles.isEmpty || !unstagedFiles.isEmpty
    return ADEKitTag(text: dirty ? "Dirty" : "Clean", tone: dirty ? .warn : .ok)
  }

  @ViewBuilder
  private var linkedPullRequestBadge: some View {
    if linkedPullRequests.count == 1, let pr = linkedPullRequests.first {
      Button { onOpenLinkedPullRequest(pr) } label: {
        ADEKitTag(text: "PR #\(pr.githubPrNumber)", color: lanePullRequestTint(pr.state))
      }
      .buttonStyle(.plain)
    } else if linkedPullRequests.count > 1 {
      ForEach(linkedPullRequests.prefix(3)) { pr in
        Button { onOpenLinkedPullRequest(pr) } label: {
          ADEKitTag(text: "#\(pr.githubPrNumber)", color: lanePullRequestTint(pr.state))
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
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .bottom, spacing: 8) {
        TextField("Commit message", text: $commitMessage, axis: .vertical)
          .lineLimit(1...3)
          .font(.system(size: 14))
          .padding(.horizontal, 11)
          .padding(.vertical, 8)
          .frame(maxWidth: .infinity, minHeight: 36)
          .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          .focused($commitFieldFocused)
          .disabled(!canRunLiveActions || busyAction != nil)
        Button("Commit") { onCommit() }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
          .frame(minHeight: 36)
          .disabled(!canRunLiveActions || busyAction != nil || (!amendCommit && stagedFiles.isEmpty))
          .opacity(!canRunLiveActions || busyAction != nil || (!amendCommit && stagedFiles.isEmpty) ? 0.45 : 1)
      }
      HStack(spacing: 6) {
        Button(amendCommit ? "Amend on" : "Amend") { amendCommit.toggle() }
          .buttonStyle(ADEKitButtonStyle(tone: amendCommit ? .warn : .neutral))
          .disabled(!canRunLiveActions || busyAction != nil)
        Button("Pull") { onPull(pullMode) }
          .buttonStyle(ADEKitButtonStyle(tone: shouldPull ? .warn : .neutral))
          .disabled(!canRunLiveActions || busyAction != nil || !shouldPull)
          .accessibilityHint("Pulls with \(pullMode)")
        Button(pushTitle) { onPush(false) }
          .buttonStyle(ADEKitButtonStyle(tone: shouldPush ? .ok : .neutral))
          .disabled(!canRunLiveActions || busyAction != nil || !shouldPush || (syncStatus?.diverged ?? false))
        moreActionsMenu
        Spacer(minLength: 0)
        Button(action: onRefresh) {
          Image(systemName: "arrow.clockwise")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 30, height: 30)
            .background(ADEKit.track, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(busyAction != nil)
        .accessibilityLabel("Refresh git state")
      }
    }
    .adeKitCard(padding: 12)
    .padding(.bottom, 4)
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

  // MARK: - More actions

  /// The rest of the git actions as a plain system menu.
  private var moreActionsMenu: some View {
    Menu {
      Section("Pull with") {
        Picker("Pull with", selection: $pullMode) {
          Label("Rebase", systemImage: "arrow.triangle.branch").tag("rebase")
          Label("Merge", systemImage: "arrow.triangle.merge").tag("merge")
        }
      }
      Button { onFetch() } label: { Label("Fetch only", systemImage: "arrow.down.circle") }
      Button { onSwitchBranch() } label: { Label("Switch branch", systemImage: "arrow.triangle.branch") }
      Button { onStashPush("") } label: { Label("Stash changes", systemImage: "tray.and.arrow.down") }
      Divider()
      Button { onRebaseLane() } label: { Label("Rebase lane", systemImage: "arrow.triangle.branch") }
      Button { onRebaseDescendants() } label: { Label("Rebase + descendants", systemImage: "arrow.triangle.branch") }
      Button { onRebaseAndPush() } label: { Label("Rebase and push", systemImage: "arrow.up.and.down.text.horizontal") }
      Button(role: .destructive) { onForcePush() } label: { Label("Force push (lease)", systemImage: "arrow.up.forward.circle") }
    } label: {
      HStack(spacing: 4) {
        Text("More")
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .semibold))
      }
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(ADEColor.textPrimary)
      .padding(.horizontal, 12)
      .frame(minHeight: 30)
      .background(ADEKit.track, in: Capsule(style: .continuous))
    }
    .disabled(!canRunLiveActions || busyAction != nil)
    .accessibilityLabel("More git actions")
  }

  // MARK: - Files

  private var filesSection: some View {
    sectionCard(expanded: filesDisclosure.expanded) {
      disclosureHeader(
        title: "Files",
        badge: stagedFiles.count + unstagedFiles.count,
        expanded: filesDisclosure.expanded,
        onToggle: { withAnimation(.smooth(duration: 0.2)) { filesDisclosure.toggle() } }
      ) {
        if canRescueUnstaged {
          Button("New lane with changes") {
            onCreateLaneFromChanges()
          }
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(ADEColor.textSecondary)
        }
      }
    } content: {
      filesContent
    }
  }

  @ViewBuilder
  private var filesContent: some View {
    VStack(alignment: .leading, spacing: 14) {
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

  // MARK: - Branch

  /// Everything the lane changed since its base, read-only: the files a
  /// committed lane's PR is made of, which "Files" cannot show once the work
  /// is committed.
  private var branchSection: some View {
    sectionCard(expanded: branchDisclosure.expanded) {
      disclosureHeader(
        title: branchChanges.map { "Branch vs \($0.baseRef)" } ?? "Branch",
        badge: branchChanges?.files.count ?? 0,
        expanded: branchDisclosure.expanded,
        onToggle: { withAnimation(.smooth(duration: 0.2)) { branchDisclosure.toggle() } }
      )
    } content: {
        VStack(alignment: .leading, spacing: 8) {
          if let branchError {
            Text(branchError).font(.caption).foregroundStyle(ADEColor.textSecondary)
          } else if let branchChanges {
            Text("+\(branchChanges.additions) −\(branchChanges.deletions) · \(branchChanges.files.count) file\(branchChanges.files.count == 1 ? "" : "s")")
              .font(.caption.monospacedDigit())
              .foregroundStyle(ADEColor.textSecondary)
            if branchChanges.files.isEmpty {
              Text("No changes since \(branchChanges.baseRef).").font(.caption).foregroundStyle(ADEColor.textSecondary)
            }
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
                  if let additions = file.additions, additions > 0 {
                    Text("+\(additions)").font(.caption2.monospacedDigit()).foregroundStyle(ADEColor.success)
                  }
                  if let deletions = file.deletions, deletions > 0 {
                    Text("−\(deletions)").font(.caption2.monospacedDigit()).foregroundStyle(ADEColor.danger)
                  }
                }
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
            }
          } else {
            ProgressView().frame(maxWidth: .infinity)
          }
        }
        .task(id: "\(detail.recentCommits.first?.sha ?? ""):\(stagedFiles.count):\(unstagedFiles.count)") {
          await reloadBranchChanges()
        }
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
    sectionCard(expanded: stashesDisclosure.expanded) {
      disclosureHeader(
        title: "Stashes",
        badge: detail.stashes.count,
        expanded: stashesDisclosure.expanded,
        onToggle: { withAnimation(.smooth(duration: 0.2)) { stashesDisclosure.toggle() } }
      )
    } content: {
      stashesContent
    }
  }

  @ViewBuilder
  private var stashesContent: some View {
    VStack(alignment: .leading, spacing: 10) {
      if detail.stashes.isEmpty {
        HStack {
          Text("None saved")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
          Spacer()
          Button("Save changes") {
            onStashPush(stashMessage)
          }
          .buttonStyle(ADEKitButtonStyle())
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
              ADEKitActionButton(title: "Apply", symbol: "tray.and.arrow.down") { onStashApply(stash.ref) }
                .disabled(!canRunLiveActions || busyAction != nil)
              ADEKitActionButton(title: "Pop", symbol: "tray.and.arrow.up") { onStashPop(stash.ref) }
                .disabled(!canRunLiveActions || busyAction != nil)
              ADEKitActionButton(title: "Drop", symbol: "trash", tint: ADEColor.danger) { onStashDrop(stash.ref) }
                .disabled(!canRunLiveActions || busyAction != nil)
            }
          }
          .padding(.vertical, 4)
        }
      }
    }
  }

  // MARK: - History

  private var historySection: some View {
    sectionCard(expanded: historyDisclosure.expanded) {
      disclosureHeader(
        title: "History",
        badge: detail.recentCommits.count,
        expanded: historyDisclosure.expanded,
        onToggle: { withAnimation(.smooth(duration: 0.2)) { historyDisclosure.toggle() } }
      )
    } content: {
      historyContent
    }
  }

  @ViewBuilder
  private var historyContent: some View {
    VStack(alignment: .leading, spacing: 8) {
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
        .padding(.horizontal, 2)
      }
    }
  }

  private func historyRow(commit: GitCommitSummary, isHead: Bool, isLast: Bool) -> some View {
    let isMerge = commit.parents.count > 1
    let dotColor: Color = isHead ? ADEColor.success : ADEColor.textMuted

    return HStack(alignment: .top, spacing: 8) {
      VStack(spacing: 0) {
        Circle()
          .strokeBorder(dotColor, lineWidth: isHead || isMerge ? 2 : 1.5)
          .background(Circle().fill(isHead ? ADEColor.success : ADEKit.surface))
          .frame(width: 9, height: 9)
        if !isLast {
          Rectangle()
            .fill(ADEKit.rule)
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .padding(.vertical, 2)
        }
      }
      .frame(width: 10)

      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 4) {
          Text(commit.shortSha)
            .font(.adeMono(11, weight: .medium))
            .foregroundStyle(ADEColor.textMuted)
          if isHead {
            ADEKitTag(text: "Head", tone: .ok)
          }
          if isMerge {
            ADEKitTag(text: "Merge")
          }
          if commit.pushed {
            // On the remote: a quiet glyph rather than a tag on every row.
            Image(systemName: "icloud")
              .font(.system(size: 10, weight: .medium))
              .foregroundStyle(ADEColor.textMuted)
              .accessibilityLabel("Pushed")
          }
          Spacer(minLength: 0)
          Text(relativeTimestampCompact(commit.authoredAt))
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Text(commit.subject)
          .font(.system(size: 13))
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

  /// A collapsible kit card: the disclosure head, a hairline, then the body.
  private func sectionCard<Body: View>(expanded: Bool, @ViewBuilder head: () -> some View, @ViewBuilder content: () -> Body) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      head()
        .padding(.horizontal, ADEKit.inset)
        .frame(minHeight: 44)
      if expanded {
        Rectangle().fill(ADEKit.rule).frame(height: 0.75)
        content()
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
      }
    }
    .adeKitCard(padding: nil)
  }

  @ViewBuilder
  private func disclosureHeader<Trailing: View>(
    title: String,
    badge: Int,
    expanded: Bool,
    onToggle: @escaping () -> Void,
    @ViewBuilder trailing: () -> Trailing = { EmptyView() }
  ) -> some View {
    HStack(spacing: 8) {
      Button(action: onToggle) {
        HStack(spacing: 8) {
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .frame(width: 12)
          Text(title)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if badge > 0 {
            Text("\(badge)")
              .font(.adeMono(11.5))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      Spacer(minLength: 0)
      trailing()
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title), \(badge) item\(badge == 1 ? "" : "s")")
    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    .accessibilityHint(expanded ? "Double tap to collapse" : "Double tap to expand")
    .accessibilityAddTraits(.isButton)
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
