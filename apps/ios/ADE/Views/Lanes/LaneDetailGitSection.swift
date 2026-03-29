import SwiftUI
import UIKit

// MARK: - Git section

extension LaneDetailScreen {
  @ViewBuilder
  var gitSections: some View {
    if let detail {
      VStack(spacing: 14) {
        GlassSection(title: "Launch") {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
              LaneActionButton(title: "Files", symbol: "folder", tint: ADEColor.accent) {
                Task { await openFiles() }
              }
              LaneActionButton(title: "Shell", symbol: "terminal") {
                Task {
                  await performAction("launch shell") {
                    try await syncService.runQuickCommand(laneId: laneId, title: "Shell", toolType: "shell", tracked: true)
                  }
                }
              }
              LaneActionButton(title: "Codex", symbol: "sparkle", tint: ADEColor.accent) {
                chatLaunchTarget = LaneChatLaunchTarget(provider: "codex")
              }
              LaneActionButton(title: "Claude", symbol: "brain.head.profile", tint: ADEColor.warning) {
                chatLaunchTarget = LaneChatLaunchTarget(provider: "claude")
              }
            }
          }
        }

        GlassSection(title: "Sync", subtitle: detail.syncStatus.map(syncSummary)) {
          VStack(alignment: .leading, spacing: 12) {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 8) {
                LaneActionButton(title: "Fetch", symbol: "arrow.down.circle") {
                  Task { await performAction("fetch") { try await syncService.fetchGit(laneId: laneId) } }
                }
                Menu {
                  Button("Pull (merge)") {
                    Task { await performAction("pull merge") { try await syncService.pullGit(laneId: laneId) } }
                  }
                  Button("Pull (rebase)") {
                    Task { await performAction("pull rebase") { try await syncService.syncGit(laneId: laneId, mode: "rebase") } }
                  }
                } label: {
                  LaneMenuLabel(title: "Pull")
                }
                LaneActionButton(
                  title: detail.syncStatus?.hasUpstream == false ? "Publish" : "Push",
                  symbol: "arrow.up.circle",
                  tint: ADEColor.accent
                ) {
                  Task { await performAction("push") { try await syncService.pushGit(laneId: laneId) } }
                }
                Menu {
                  Button("Force push") {
                    confirmForcePush = true
                  }
                  Divider()
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
                  LaneMenuLabel(title: "More")
                }
              }
            }

            if let upstreamRef = detail.syncStatus?.upstreamRef {
              LaneInfoRow(label: "Upstream", value: upstreamRef, isMonospaced: true)
            }
          }
        }

        GlassSection(title: "Commit") {
          VStack(alignment: .leading, spacing: 12) {
            TextField("Commit message", text: $commitMessage, axis: .vertical)
              .textFieldStyle(.plain)
              .adeInsetField()
            Toggle("Amend latest commit", isOn: $amendCommit)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
            HStack(spacing: 8) {
              LaneActionButton(title: "Generate", symbol: "sparkles") {
                Task {
                  do {
                    commitMessage = try await syncService.generateCommitMessage(laneId: laneId, amend: amendCommit)
                  } catch {
                    errorMessage = error.localizedDescription
                  }
                }
              }
              LaneActionButton(title: "Commit", symbol: "checkmark.circle.fill", tint: ADEColor.accent) {
                let msg = commitMessage
                Task {
                  await performAction("commit") {
                    try await syncService.commitLane(laneId: laneId, message: msg, amend: amendCommit)
                  }
                  if errorMessage == nil { commitMessage = "" }
                }
              }
            }
          }
        }

        if let diffChanges = detail.diffChanges, !diffChanges.unstaged.isEmpty {
          LaneFileTreeSection(
            title: "Unstaged files",
            subtitle: "\(diffChanges.unstaged.count) file\(diffChanges.unstaged.count == 1 ? "" : "s")",
            changes: diffChanges.unstaged,
            bulkActionTitle: diffChanges.unstaged.count > 1 ? "Stage all" : nil,
            bulkActionSymbol: "plus.circle.fill",
            bulkActionTint: ADEColor.accent,
            primaryActionTitle: "Stage",
            primaryActionSymbol: "plus.circle.fill",
            primaryActionTint: ADEColor.accent,
            secondaryActionTitle: "Discard",
            secondaryActionSymbol: "trash",
            secondaryActionTint: ADEColor.danger,
            onBulkAction: {
              Task {
                await performAction("stage all") {
                  try await syncService.stageAll(laneId: laneId, paths: diffChanges.unstaged.map(\.path))
                }
              }
            },
            onDiff: { file in
              selectedDiffRequest = LaneDiffRequest(laneId: laneId, path: file.path, mode: "unstaged", compareRef: nil, compareTo: nil, title: file.path)
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

        if let diffChanges = detail.diffChanges, !diffChanges.staged.isEmpty {
          LaneFileTreeSection(
            title: "Staged files",
            subtitle: "\(diffChanges.staged.count) file\(diffChanges.staged.count == 1 ? "" : "s")",
            changes: diffChanges.staged,
            bulkActionTitle: diffChanges.staged.count > 1 ? "Unstage all" : nil,
            bulkActionSymbol: "minus.circle",
            bulkActionTint: ADEColor.warning,
            primaryActionTitle: "Unstage",
            primaryActionSymbol: "minus.circle",
            primaryActionTint: ADEColor.warning,
            secondaryActionTitle: "Restore",
            secondaryActionSymbol: "trash",
            secondaryActionTint: ADEColor.danger,
            onBulkAction: {
              Task {
                await performAction("unstage all") {
                  try await syncService.unstageAll(laneId: laneId, paths: diffChanges.staged.map(\.path))
                }
              }
            },
            onDiff: { file in
              selectedDiffRequest = LaneDiffRequest(laneId: laneId, path: file.path, mode: "staged", compareRef: nil, compareTo: nil, title: file.path)
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

        if !detail.stashes.isEmpty || canRunLiveActions {
          GlassSection(title: "Stashes") {
            VStack(alignment: .leading, spacing: 12) {
              HStack(spacing: 8) {
                TextField("Stash message", text: $stashMessage)
                  .textFieldStyle(.plain)
                  .adeInsetField(cornerRadius: 10, padding: 10)
                LaneActionButton(title: "Stash", symbol: "tray.and.arrow.down", tint: ADEColor.accent) {
                  Task {
                    await performAction("stash") {
                      try await syncService.stashPush(laneId: laneId, message: stashMessage, includeUntracked: true)
                    }
                    if errorMessage == nil { stashMessage = "" }
                  }
                }
              }

              ForEach(detail.stashes) { stash in
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
                    LaneActionButton(title: "Pop", symbol: "arrow.up.right.square") {
                      Task { await performAction("stash pop") { try await syncService.stashPop(laneId: laneId, stashRef: stash.ref) } }
                    }
                    LaneActionButton(title: "Drop", symbol: "trash", tint: ADEColor.danger) {
                      Task { await performAction("stash drop") { try await syncService.stashDrop(laneId: laneId, stashRef: stash.ref) } }
                    }
                  }
                }
                if stash.id != detail.stashes.last?.id { Divider() }
              }
            }
          }
        }

        if !detail.recentCommits.isEmpty {
          GlassSection(title: "Recent commits") {
            VStack(alignment: .leading, spacing: 12) {
              ForEach(detail.recentCommits) { commit in
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
                      LaneActionButton(title: "Diff", symbol: "doc.text.magnifyingglass") {
                        Task {
                          do {
                            let files = try await syncService.listCommitFiles(laneId: laneId, commitSha: commit.sha)
                            guard let path = files.first else {
                              errorMessage = "This commit has no file diffs."
                              return
                            }
                            selectedDiffRequest = LaneDiffRequest(
                              laneId: laneId,
                              path: path,
                              mode: "commit",
                              compareRef: commit.sha,
                              compareTo: "parent",
                              title: commit.subject
                            )
                          } catch {
                            errorMessage = error.localizedDescription
                          }
                        }
                      }
                      LaneActionButton(title: "Copy message", symbol: "doc.on.doc") {
                        Task {
                          do {
                            UIPasteboard.general.string = try await syncService.getCommitMessage(laneId: laneId, commitSha: commit.sha)
                          } catch {
                            errorMessage = error.localizedDescription
                          }
                        }
                      }
                      LaneActionButton(title: "Revert", symbol: "arrow.uturn.backward", tint: ADEColor.warning) {
                        Task { await performAction("revert commit") { try await syncService.revertCommit(laneId: laneId, commitSha: commit.sha) } }
                      }
                      LaneActionButton(title: "Cherry-pick", symbol: "arrow.triangle.merge") {
                        Task { await performAction("cherry pick") { try await syncService.cherryPickCommit(laneId: laneId, commitSha: commit.sha) } }
                      }
                    }
                  }
                }
                if commit.id != detail.recentCommits.last?.id { Divider() }
              }
            }
          }
        }

        if let conflictState = detail.conflictState, conflictState.inProgress {
          GlassSection(title: "Rebase conflict") {
            VStack(alignment: .leading, spacing: 12) {
              Text("\(conflictState.conflictedFiles.count) conflicted file\(conflictState.conflictedFiles.count == 1 ? "" : "s") in progress.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)

              if !conflictState.conflictedFiles.isEmpty {
                ForEach(conflictState.conflictedFiles, id: \.self) { path in
                  Text(path)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }

              HStack(spacing: 8) {
                LaneActionButton(title: "Continue", symbol: "play.fill", tint: ADEColor.accent) {
                  Task { await performAction("rebase continue") { try await syncService.rebaseContinueGit(laneId: laneId) } }
                }
                .disabled(!conflictState.canContinue)
                LaneActionButton(title: "Abort", symbol: "xmark.circle", tint: ADEColor.danger) {
                  Task { await performAction("rebase abort") { try await syncService.rebaseAbortGit(laneId: laneId) } }
                }
                .disabled(!conflictState.canAbort)
              }
            }
          }
        }
      }
    }
  }
}
