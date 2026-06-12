import SwiftUI
import UIKit

// MARK: - Overview tab (rebuilt)
//
// The Overview tab renders four stacked sections wrapped in `adeListCard`s:
// AI summary, Checks summary, Commits rail, Files summary. Merge/rebase
// actions live on the sticky bar in `PrDetailScreen` so the tab body stays
// focused on *signal*, not controls.

/// Destinations used by the Checks / Files "see all" affordances. The parent
/// screen maps these onto its sub-tab selection state.
enum PrOverviewNavTarget: Equatable {
  case checks
  case files
}

/// Maps the AI summary's freeform merge-readiness string onto a status tint.
/// Used by the Overview eyebrow so readers see "ready for merge" / "needs
/// attention" / "blocked" at a glance in the right colour.
func prReadinessTint(_ readiness: String?) -> Color {
  let raw = (readiness ?? "").lowercased()
  if raw.contains("block") || raw.contains("high") {
    return ADEColor.danger
  }
  if raw.contains("needs") || raw.contains("medium") || raw.contains("warn") || raw.contains("attention") {
    return ADEColor.warning
  }
  if raw.contains("ready") || raw.contains("low") {
    return ADEColor.success
  }
  return ADEColor.textMuted
}

struct PrOverviewTab: View {
  let pr: PullRequestListItem
  let snapshot: PullRequestSnapshot?
  let aiSummary: AiReviewSummary?
  let isLive: Bool
  let isAiSummaryLoading: Bool
  let groupMembers: [PrGroupMemberSummary]
  let onNavigate: (PrOverviewNavTarget) -> Void
  let onRegenerateAiSummary: () -> Void
  let onOpenStack: (String, String?) -> Void
  let onArchiveLane: () -> Void
  let onDeleteBranch: () -> Void

  private var checks: [PrCheck] { snapshot?.checks ?? [] }
  private var files: [PrFile] { snapshot?.files ?? [] }
  private var commits: [PrCommit] { snapshot?.commits ?? [] }

  private var additions: Int {
    files.reduce(0) { $0 + $1.additions }
  }

  private var deletions: Int {
    files.reduce(0) { $0 + $1.deletions }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      mergeSignalStrip
      aiSummarySection
      if !checks.isEmpty {
        checksSummarySection
      }
      if !commits.isEmpty {
        commitsSummarySection
      }
      if !files.isEmpty {
        filesSummarySection
      }

      if !groupMembers.isEmpty, let groupId = pr.linkedGroupId {
        stackSection(groupId: groupId)
      }

      if pr.state == "merged" {
        PrLaneCleanupBanner(
          laneName: pr.laneName,
          isLive: isLive,
          onArchive: onArchiveLane,
          onDeleteBranch: onDeleteBranch
        )
      }
    }
  }

  // MARK: - Merge signal strip
  //
  // Mirrors the desktop Overview's 6-signal row. We collapse to a 3+3 grid for
  // narrow widths so each tile keeps its big number readable. Order matches
  // desktop: state-of-merge first, then size of change.

  @ViewBuilder
  private var mergeSignalStrip: some View {
    let status = snapshot?.status
    let behind = status?.behindBaseBy ?? 0
    let conflicts = status?.mergeConflicts ?? false
    let mergeable = status?.isMergeable ?? false

    let stateTuple: (String, String, Color) = {
      if conflicts { return ("MERGE", "Conflicts", ADEColor.danger) }
      if behind > 0 { return ("BEHIND", "\(behind)", ADEColor.warning) }
      if mergeable { return ("MERGE", "Ready", ADEColor.success) }
      return ("MERGE", "Pending", ADEColor.textMuted)
    }()
    let stateLabel = stateTuple.0
    let stateValue = stateTuple.1
    let stateTint = stateTuple.2

    let pass = checks.filter { $0.status == "completed" && ($0.conclusion == "success" || $0.conclusion == "neutral" || $0.conclusion == "skipped") }.count
    let total = checks.count

    VStack(spacing: 6) {
      HStack(spacing: 6) {
        PrSignalTile(label: stateLabel, value: stateValue, tint: stateTint)
        PrSignalTile(label: "CHECKS", value: total == 0 ? "—" : "\(pass)/\(total)", tint: total == 0 ? ADEColor.textMuted : (pass == total ? ADEColor.success : ADEColor.warning))
        PrSignalTile(label: "FILES", value: files.isEmpty ? "—" : "\(files.count)", tint: ADEColor.tintPRs)
      }
      HStack(spacing: 6) {
        PrSignalTile(label: "ADDED", value: "+\(additions)", tint: ADEColor.success)
        PrSignalTile(label: "DELETED", value: "−\(deletions)", tint: ADEColor.danger)
        PrSignalTile(label: "COMMITS", value: commits.isEmpty ? "—" : "\(commits.count)", tint: ADEColor.accent)
      }
    }
  }

  // MARK: AI summary
  private var aiSummarySection: some View {
    let summary = aiSummary
    let trailingText: String = {
      if let readiness = summary?.mergeReadiness.replacingOccurrences(of: "_", with: " "), !readiness.isEmpty {
        return readiness
      }
      return isAiSummaryLoading ? "generating" : "not generated"
    }()
    let trailingTint = prReadinessTint(summary?.mergeReadiness)

    return VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("AI SUMMARY")
          .font(.system(size: 10, weight: .bold))
          .tracking(1.0)
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 8)
        Text(trailingText)
          .font(.system(size: 10, weight: .bold))
          .tracking(0.8)
          .foregroundStyle(trailingTint)
      }
      .padding(.horizontal, 4)

      PrAiSummaryCard(
        summary: summary,
        additions: additions,
        deletions: deletions,
        fileCount: files.count,
        isLoading: isAiSummaryLoading,
        isLive: isLive,
        onRegenerate: onRegenerateAiSummary
      )
      .padding(14)
      .prGlassCard(cornerRadius: 18)
    }
  }

  // MARK: Checks summary
  private var checksSummarySection: some View {
    let groups = prGroupChecks(checks)
    let trailing = checks.isEmpty ? "no checks" : "\(checks.count) check\(checks.count == 1 ? "" : "s")"

    return VStack(alignment: .leading, spacing: 10) {
      PrSectionHdr(title: "Checks") {
        Text(trailing)
      }

      VStack(spacing: 0) {
        if groups.isEmpty {
          HStack(spacing: 10) {
            Circle()
              .fill(ADEColor.textMuted.opacity(0.4))
              .frame(width: 8, height: 8)
            Text("No check signals synced yet")
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textSecondary)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 11)
        } else {
          ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
            PrOverviewCheckRow(group: group) {
              onNavigate(.checks)
            }
            if index < groups.count - 1 {
              Divider()
                .background(ADEColor.textMuted.opacity(0.15))
            }
          }
        }
      }
      .prGlassCard(cornerRadius: 18)
    }
  }

  // MARK: Commits summary
  private var commitsSummarySection: some View {
    let total = commits.count
    let top = Array(commits.prefix(8))
    let entries: [PrCommitRailEntry] = top.map { commit in
      PrCommitRailEntry(
        id: commit.id,
        sha: commit.sha,
        message: commit.message,
        author: commit.authorLogin ?? commit.authorName,
        timestampIso: commit.committedDate,
        checksState: commit.checkStatus ?? "none"
      )
    }

    return VStack(alignment: .leading, spacing: 10) {
      PrSectionHdr(title: "Commits") {
        Text(total == 1 ? "1 commit" : "\(total) commits")
      }
      PrCommitRailView(commits: entries)
        .prGlassCard(cornerRadius: 18)
    }
  }

  // MARK: Files summary
  private var filesSummarySection: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrSectionHdr(title: "Files") {
        Text(files.isEmpty ? "—" : "+\(additions) / −\(deletions)")
      }

      VStack(spacing: 0) {
        if files.isEmpty {
          HStack(spacing: 10) {
            Image(systemName: "doc")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textMuted)
            Text("No file changes synced yet")
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textSecondary)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 11)
        } else {
          let top = Array(files.prefix(4))
          ForEach(Array(top.enumerated()), id: \.element.id) { index, file in
            PrOverviewFileRow(file: file)
            if index < top.count - 1 || files.count > top.count {
              Divider()
                .background(ADEColor.textMuted.opacity(0.15))
            }
          }

          if files.count > 4 {
            Button {
              onNavigate(.files)
            } label: {
              Text("+ \(files.count - 4) more files")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ADEColor.tintPRs)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
            }
            .buttonStyle(.plain)
          }
        }
      }
      .prGlassCard(cornerRadius: 18)
    }
  }

  private func stackSection(groupId: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      PrSectionHdr(title: "Stack") {
        Text("\(groupMembers.count) PRs")
      }

      VStack(alignment: .leading, spacing: 8) {
        ForEach(groupMembers) { member in
          HStack(spacing: 10) {
            Text("\(member.position + 1)")
              .font(.caption.weight(.bold))
              .foregroundStyle(ADEColor.accent)
              .frame(width: 22, height: 22)
              .background(ADEColor.accent.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
              Text(member.title)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
              Text("#\(member.githubPrNumber) · \(member.headBranch) → \(member.baseBranch)")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
          }
        }

        Button("Open stack") {
          onOpenStack(groupId, pr.laneName)
        }
        .buttonStyle(.glass)
        .disabled(!isLive)
      }
      .prGlassCard(cornerRadius: 18)
    }
  }
}

// MARK: - Unified Overview thread (desktop parity)
//
// Folds the former Overview + Activity tabs into ONE top→bottom thread:
//   1. (optional) Unmapped banner — create-lane / map-to-lane CTAs
//   2. Summary content (merge signals, AI summary, checks/commits/files)
//      via the existing `PrOverviewTab`
//   3. PR description (body) as the first feed card
//   4. Chronological event feed (commits / reviews / comments / deploys / …)
//   5. Review threads (unresolved + collapsed resolved)
//   6. Chat composer (locked when the PR is unmapped)
//   7. Inline merge rail (terminal states + blockers + merge/close actions)
//
// It reuses the existing `PrOverviewTab`, `PrActivityTimelineList`,
// `PrReviewThreadCard`, `PrReplyComposerInline`, and the shared merge-gate
// derivation so no data fetching or rendering is duplicated.

struct PrUnifiedOverviewThread: View {
  // Summary / overview content
  let pr: PullRequestListItem
  let snapshot: PullRequestSnapshot?
  let aiSummary: AiReviewSummary?
  let isLive: Bool
  let isAiSummaryLoading: Bool
  let groupMembers: [PrGroupMemberSummary]
  let onNavigate: (PrOverviewNavTarget) -> Void
  let onRegenerateAiSummary: () -> Void
  let onOpenStack: (String, String?) -> Void
  let onArchiveLane: () -> Void
  let onDeleteBranch: () -> Void

  // Thread content
  let timeline: [PrTimelineEvent]
  let reviewThreads: [PrReviewThread]
  let descriptionBody: String?
  let descriptionAuthor: String?

  // Composer
  @Binding var commentInput: String
  let canAddComment: Bool
  let isMapped: Bool
  let onSubmitComment: () -> Void
  let onReplyToThread: (String, String) -> Void
  let onSetThreadResolved: (String, Bool) -> Void

  // Unmapped affordance
  let canAutoMap: Bool
  let onAutoMap: () -> Void
  let onOpenInGitHub: () -> Void

  // Inline merge rail
  let mergeRail: PrOverviewMergeRailModel

  @State private var focusedThreadId: String?
  @State private var replyDraft: [String: String] = [:]

  private var sortedThreads: [PrReviewThread] {
    reviewThreads.sorted {
      if $0.isResolved != $1.isResolved { return !$0.isResolved && $1.isResolved }
      let l = prParsedDate($0.updatedAt ?? $0.createdAt) ?? .distantPast
      let r = prParsedDate($1.updatedAt ?? $1.createdAt) ?? .distantPast
      return l > r
    }
  }
  private var unresolvedThreads: [PrReviewThread] { sortedThreads.filter { !$0.isResolved } }
  private var resolvedThreads: [PrReviewThread] { sortedThreads.filter { $0.isResolved } }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if !isMapped {
        PrUnmappedThreadBanner(
          canAutoMap: canAutoMap,
          onAutoMap: onAutoMap,
          onOpenInGitHub: onOpenInGitHub
        )
      }

      // Summary cards (AI summary pinned near top, merge signals, checks).
      PrOverviewTab(
        pr: pr,
        snapshot: snapshot,
        aiSummary: aiSummary,
        isLive: isLive,
        isAiSummaryLoading: isAiSummaryLoading,
        groupMembers: groupMembers,
        onNavigate: onNavigate,
        onRegenerateAiSummary: onRegenerateAiSummary,
        onOpenStack: onOpenStack,
        onArchiveLane: onArchiveLane,
        onDeleteBranch: onDeleteBranch
      )

      // Description (PR body) — the first card of the chronological thread.
      if let body = descriptionBody?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
        PrThreadDescriptionCard(author: descriptionAuthor, text: body)
      }

      // Chronological event feed.
      if !timeline.isEmpty {
        PrActivityTimelineList(events: timeline)
      }

      // Review threads.
      if !unresolvedThreads.isEmpty {
        threadSectionHeader(title: "Threads", trailing: "\(unresolvedThreads.count) unresolved")
        ForEach(unresolvedThreads) { thread in
          PrReviewThreadCard(
            thread: thread,
            isLive: isLive,
            isFocused: focusedThreadId == thread.id,
            replyDraft: Binding(
              get: { replyDraft[thread.id] ?? "" },
              set: { replyDraft[thread.id] = $0 }
            ),
            onFocus: { focusedThreadId = thread.id },
            onReply: { body in
              onReplyToThread(thread.id, body)
              replyDraft[thread.id] = ""
            },
            onResolve: { resolved in onSetThreadResolved(thread.id, resolved) }
          )
        }
      }

      if !resolvedThreads.isEmpty {
        PrCollapsibleResolvedSection(
          threads: resolvedThreads,
          isLive: isLive,
          onReopen: { threadId in onSetThreadResolved(threadId, false) }
        )
      }

      // Chat composer — locked when the PR is unmapped.
      if isMapped {
        PrReplyComposer(
          text: $commentInput,
          placeholder: focusedThreadId != nil ? "Reply…" : "Comment on PR…",
          isLive: isLive && canAddComment,
          onSend: {
            if let focusedThreadId {
              onReplyToThread(focusedThreadId, commentInput)
              commentInput = ""
            } else {
              onSubmitComment()
            }
          },
          onClearFocus: focusedThreadId != nil ? { focusedThreadId = nil } : nil
        )
        if !canAddComment {
          Text("Posting comments requires a machine that exposes PR comment actions to mobile.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      } else {
        PrLockedComposerBar()
      }

      // Inline merge rail.
      PrOverviewMergeRail(model: mergeRail)

      Color.clear
        .frame(height: 88)
        .accessibilityHidden(true)
    }
  }

  @ViewBuilder
  private func threadSectionHeader(title: String, trailing: String?) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(title.uppercased())
        .font(.system(size: 10, weight: .bold))
        .tracking(1.0)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 8)
      if let trailing {
        Text(trailing)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 4)
  }
}

/// PR description rendered as the first card of the thread.
private struct PrThreadDescriptionCard: View {
  let author: String?
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "text.alignleft")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(PrGlassPalette.purpleBright)
        Text("DESCRIPTION")
          .font(.system(size: 10, weight: .bold))
          .tracking(1.0)
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 0)
        if let author, !author.isEmpty {
          Text("@\(author)")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      Text(text)
        .font(.system(size: 13))
        .foregroundStyle(ADEColor.textPrimary)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16)
  }
}

/// Amber banner shown at the top of the thread when the PR is not mapped to an
/// ADE lane. Primary action is auto-map ("Create lane from PR branch", gated on
/// host support); the secondary action opens the PR on GitHub. (Linking to an
/// existing lane lives on the root unmapped-PR sheet.)
private struct PrUnmappedThreadBanner: View {
  let canAutoMap: Bool
  let onAutoMap: () -> Void
  let onOpenInGitHub: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.system(size: 14))
          .foregroundStyle(PrGlassPalette.warning)
          .padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          Text("Not mapped to a lane")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Create a lane from this PR's branch to track and act on it inside ADE.")
            .font(.system(size: 11.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }

      HStack(spacing: 8) {
        if canAutoMap {
          Button(action: onAutoMap) {
            Label("Create lane from PR branch", systemImage: "arrow.triangle.branch")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(.white)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 9)
              .background(PrGlassPalette.accentGradient, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
          }
          .buttonStyle(.plain)
        }
        Button(action: onOpenInGitHub) {
          Label("Open in GitHub", systemImage: "arrow.up.right.square")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(PrGlassPalette.purpleBright)
            .frame(maxWidth: canAutoMap ? nil : .infinity)
            .padding(.horizontal, canAutoMap ? 12 : 0)
            .padding(.vertical, 9)
            .background(
              RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(PrGlassPalette.purple.opacity(0.14))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(PrGlassPalette.purple.opacity(0.35), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16, tint: PrGlassPalette.warning.opacity(0.5), shadow: false)
  }
}

/// Locked comment composer shown when the PR is unmapped (desktop parity).
private struct PrLockedComposerBar: View {
  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "lock.fill")
        .font(.system(size: 13))
        .foregroundStyle(ADEColor.textMuted)
      Text("Map this PR to a lane to comment")
        .font(.system(size: 12))
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(Color.white.opacity(0.04))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
    )
  }
}

// MARK: - Inline merge rail (unified thread bottom)

/// Drives the inline merge rail at the bottom of the unified Overview thread.
/// Mirrors desktop's `PrDetailMergeRail`: terminal states, a derived blockers
/// list, a merge split-button, a close action, and a copyable command-line
/// instruction. Built from the already-fetched PR status / checks / reviews.
struct PrOverviewMergeRailModel {
  enum Phase {
    case merged
    case closed
    case active
  }

  let phase: Phase
  let repoOwner: String
  let repoName: String
  let prNumber: Int
  /// Merge-gate summary (green/amber/red) for the active state.
  let gate: PrMergeGateInfo
  /// Bulleted blocker reasons when merging is blocked.
  let blockers: [String]
  let isDraft: Bool
  let canMerge: Bool
  let canClose: Bool
  let canDeleteBranch: Bool
  let canReopen: Bool
  let isBusy: Bool
  let mergeMethod: PrMergeMethodOption

  let onMerge: () -> Void
  let onChangeMethod: () -> Void
  let onClose: () -> Void
  let onReopen: () -> Void
  let onDeleteBranch: () -> Void

  var commandLine: String {
    "gh -R \(repoOwner)/\(repoName) pr merge \(prNumber) --\(mergeMethod.rawValue)"
  }
}

struct PrOverviewMergeRail: View {
  let model: PrOverviewMergeRailModel

  @State private var showCommandLine = false
  @State private var confirmClose = false
  @State private var confirmDelete = false
  @State private var copiedCommand = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      PrEyebrow(text: "Merge", tint: ADEColor.textSecondary)

      switch model.phase {
      case .merged:
        mergedSection
      case .closed:
        closedSection
      case .active:
        activeSection
      }
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 18)
  }

  // MARK: Terminal: merged

  private var mergedSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      statusLine(icon: "checkmark.seal.fill", tint: ADEColor.success, title: "Merged and closed")
      if model.canDeleteBranch {
        if confirmDelete {
          confirmRow(
            message: "Delete the branch?",
            confirmTitle: "Delete branch",
            tint: ADEColor.danger,
            onConfirm: { confirmDelete = false; model.onDeleteBranch() },
            onCancel: { confirmDelete = false }
          )
        } else {
          secondaryButton(title: "Delete branch", icon: "trash", tint: ADEColor.danger) {
            confirmDelete = true
          }
        }
      }
    }
  }

  // MARK: Terminal: closed

  private var closedSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      statusLine(icon: "xmark.circle.fill", tint: ADEColor.danger, title: "This PR is closed")
      if model.canReopen {
        secondaryButton(title: "Reopen pull request", icon: "arrow.uturn.up", tint: ADEColor.accent) {
          model.onReopen()
        }
      }
    }
  }

  // MARK: Active (open / draft)

  private var activeSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      // Mergeability status line.
      switch model.gate.tone {
      case .green:
        statusLine(icon: "checkmark.seal.fill", tint: ADEColor.success, title: "Ready to merge")
      case .amber:
        statusLine(icon: "clock.fill", tint: ADEColor.warning, title: model.isDraft ? "Draft — not ready" : "Checking…")
      case .red:
        VStack(alignment: .leading, spacing: 8) {
          statusLine(icon: "exclamationmark.octagon.fill", tint: ADEColor.danger, title: "Merging is blocked")
          if !model.blockers.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
              ForEach(Array(model.blockers.enumerated()), id: \.offset) { _, blocker in
                HStack(alignment: .top, spacing: 7) {
                  Circle()
                    .fill(ADEColor.danger.opacity(0.7))
                    .frame(width: 5, height: 5)
                    .padding(.top, 5)
                  Text(blocker)
                    .font(.system(size: 12))
                    .foregroundStyle(ADEColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
              }
            }
            .padding(.leading, 2)
          }
        }
      }

      // Merge split-button (primary action + method menu).
      HStack(spacing: 8) {
        Button {
          if model.canMerge && !model.isBusy { model.onMerge() }
        } label: {
          HStack(spacing: 8) {
            if model.isBusy {
              ProgressView().controlSize(.small).tint(.white)
            } else {
              Image(systemName: "arrow.triangle.merge")
                .font(.system(size: 13, weight: .bold))
            }
            Text(model.mergeMethod.shortTitle)
              .font(.system(size: 14, weight: .bold))
          }
          .foregroundStyle(.white)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 13)
          .background(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
              .fill(
                LinearGradient(
                  colors: [ADEColor.success, ADEColor.success.opacity(0.82)],
                  startPoint: .top, endPoint: .bottom
                )
              )
          )
          .opacity(model.canMerge && !model.isBusy ? 1 : 0.5)
        }
        .buttonStyle(.plain)
        .disabled(!model.canMerge || model.isBusy)

        Button(action: model.onChangeMethod) {
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 44, height: 46)
            .background(
              RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(Color.white.opacity(0.06))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Change merge method")
      }

      // Close pull request (two-tap confirm).
      if model.canClose {
        if confirmClose {
          confirmRow(
            message: "Close this PR?",
            confirmTitle: "Close PR",
            tint: ADEColor.danger,
            onConfirm: { confirmClose = false; model.onClose() },
            onCancel: { confirmClose = false }
          )
        } else {
          secondaryButton(title: "Close pull request", icon: "xmark.circle", tint: ADEColor.danger) {
            confirmClose = true
          }
        }
      }

      // Command-line instructions disclosure.
      commandLineDisclosure
    }
  }

  // MARK: Pieces

  private func statusLine(icon: String, tint: Color, title: String) -> some View {
    HStack(spacing: 9) {
      Image(systemName: icon)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(tint)
      Text(title)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(tint)
      Spacer(minLength: 0)
    }
  }

  private func secondaryButton(title: String, icon: String, tint: Color, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 7) {
        Image(systemName: icon).font(.system(size: 12, weight: .semibold))
        Text(title).font(.system(size: 13, weight: .semibold))
        Spacer(minLength: 0)
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 13)
      .padding(.vertical, 11)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(tint.opacity(0.10))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(tint.opacity(0.30), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
  }

  private func confirmRow(
    message: String,
    confirmTitle: String,
    tint: Color,
    onConfirm: @escaping () -> Void,
    onCancel: @escaping () -> Void
  ) -> some View {
    HStack(spacing: 8) {
      Text(message)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Spacer(minLength: 0)
      Button("Cancel", action: onCancel)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .buttonStyle(.plain)
      Button(confirmTitle, action: onConfirm)
        .font(.system(size: 12, weight: .bold))
        .foregroundStyle(tint)
        .buttonStyle(.plain)
    }
    .padding(.horizontal, 13)
    .padding(.vertical, 11)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(tint.opacity(0.10))
    )
  }

  private var commandLineDisclosure: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) { showCommandLine.toggle() }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: showCommandLine ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .bold))
          Text("View command line instructions")
            .font(.system(size: 11.5, weight: .medium))
          Spacer(minLength: 0)
        }
        .foregroundStyle(ADEColor.textMuted)
      }
      .buttonStyle(.plain)

      if showCommandLine {
        HStack(spacing: 8) {
          Text(model.commandLine)
            .font(.system(size: 11.5, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 0)
          Button {
            UIPasteboard.general.string = model.commandLine
            copiedCommand = true
            ADEHaptics.success()
          } label: {
            Image(systemName: copiedCommand ? "checkmark" : "doc.on.doc")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(copiedCommand ? ADEColor.success : ADEColor.textSecondary)
          }
          .buttonStyle(.plain)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color.black.opacity(0.25))
        )
      }
    }
  }
}

// MARK: - Check group summary

struct PrOverviewCheckGroup: Identifiable, Equatable {
  let id: String
  let name: String
  let pass: Int
  let fail: Int
  let pending: Int

  var total: Int { pass + fail + pending }

  var dotColor: Color {
    if fail > 0 { return ADEColor.danger }
    if pending > 0 { return ADEColor.warning }
    return ADEColor.success
  }
}

private struct PrOverviewCheckRow: View {
  let group: PrOverviewCheckGroup
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(spacing: 10) {
        Circle()
          .fill(group.dotColor)
          .frame(width: 8, height: 8)
          .shadow(color: group.dotColor.opacity(0.5), radius: 3)
        Text(group.name)
          .font(.system(size: 12.5, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
        Text("\(group.pass)/\(group.total) passing")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

/// Buckets individual `PrCheck`s into the four visual groups used on Overview.
/// Heuristics: name prefix `bot`/`[bot]` or bot-like suffix → Bots; names
/// containing `security`/`codeql`/`snyk`/`trivy` → Security; otherwise → CI.
func prGroupChecks(_ checks: [PrCheck]) -> [PrOverviewCheckGroup] {
  guard !checks.isEmpty else { return [] }

  var ci: (p: Int, f: Int, pnd: Int) = (0, 0, 0)
  var bots: (p: Int, f: Int, pnd: Int) = (0, 0, 0)
  var security: (p: Int, f: Int, pnd: Int) = (0, 0, 0)
  var other: (p: Int, f: Int, pnd: Int) = (0, 0, 0)

  for check in checks {
    let bucket = prCheckBucket(check.name)
    let outcome = prCheckOutcome(check)
    switch bucket {
    case .ci:
      if outcome == .pass { ci.p += 1 } else if outcome == .fail { ci.f += 1 } else { ci.pnd += 1 }
    case .bots:
      if outcome == .pass { bots.p += 1 } else if outcome == .fail { bots.f += 1 } else { bots.pnd += 1 }
    case .security:
      if outcome == .pass { security.p += 1 } else if outcome == .fail { security.f += 1 } else { security.pnd += 1 }
    case .other:
      if outcome == .pass { other.p += 1 } else if outcome == .fail { other.f += 1 } else { other.pnd += 1 }
    }
  }

  var groups: [PrOverviewCheckGroup] = []
  if ci.p + ci.f + ci.pnd > 0 { groups.append(PrOverviewCheckGroup(id: "CI", name: "CI", pass: ci.p, fail: ci.f, pending: ci.pnd)) }
  if bots.p + bots.f + bots.pnd > 0 { groups.append(PrOverviewCheckGroup(id: "Bots", name: "Bots", pass: bots.p, fail: bots.f, pending: bots.pnd)) }
  if security.p + security.f + security.pnd > 0 { groups.append(PrOverviewCheckGroup(id: "Security", name: "Security", pass: security.p, fail: security.f, pending: security.pnd)) }
  if other.p + other.f + other.pnd > 0 { groups.append(PrOverviewCheckGroup(id: "Other", name: "Other", pass: other.p, fail: other.f, pending: other.pnd)) }
  return groups
}

private enum PrCheckBucket { case ci, bots, security, other }
private enum PrCheckOutcome { case pass, fail, pending }

private func prCheckBucket(_ name: String) -> PrCheckBucket {
  let lowered = name.lowercased()
  if lowered.contains("[bot]") || lowered.contains("bot:") || lowered.contains("coderabbit") || lowered.contains("greptile") || lowered.contains("codecov") || lowered.contains("sourcery") {
    return .bots
  }
  if lowered.contains("security") || lowered.contains("codeql") || lowered.contains("snyk") || lowered.contains("trivy") || lowered.contains("dependabot") {
    return .security
  }
  if lowered.contains("ci") || lowered.contains("test") || lowered.contains("lint") || lowered.contains("build") || lowered.contains("typecheck") {
    return .ci
  }
  return .other
}

private func prCheckOutcome(_ check: PrCheck) -> PrCheckOutcome {
  if check.status != "completed" {
    return .pending
  }
  switch check.conclusion {
  case "success", "neutral", "skipped":
    return .pass
  case nil:
    return .pending
  default:
    return .fail
  }
}

// MARK: - File row

private struct PrOverviewFileRow: View {
  let file: PrFile

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "doc")
        .font(.system(size: 13))
        .foregroundStyle(ADEColor.textMuted)
      Text(file.filename)
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 0)
      if file.status == "added" {
        PrOverviewInlineChip(text: "new", tint: ADEColor.success)
      } else if file.status == "removed" {
        PrOverviewInlineChip(text: "del", tint: ADEColor.danger)
      } else if file.status == "renamed" {
        PrOverviewInlineChip(text: "ren", tint: ADEColor.accent)
      }
      Text("+\(file.additions)")
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ADEColor.success)
      Text("−\(file.deletions)")
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ADEColor.danger)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }
}

private struct PrOverviewInlineChip: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.system(size: 9, weight: .bold))
      .tracking(0.5)
      .foregroundStyle(tint)
      .padding(.horizontal, 5)
      .padding(.vertical, 2)
      .background(
        Capsule(style: .continuous)
          .fill(tint.opacity(0.14))
      )
      .overlay(
        Capsule(style: .continuous)
          .strokeBorder(tint.opacity(0.35), lineWidth: 0.5)
      )
  }
}

// MARK: - Legacy helpers retained
//
// These types are shared with other screens (PrDetailChecksTab / Activity /
// CreatePrWizard / PrsRootScreen) and the Path-to-merge tab. They are kept
// intact to avoid churn across other agents' files.

struct PrHeaderCard: View {
  let pr: PullRequestListItem
  let transitionNamespace: Namespace.ID?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 6) {
          Text(pr.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-title-\(pr.id)", in: transitionNamespace)
          Text("#\(pr.githubPrNumber) · \(pr.headBranch) → \(pr.baseBranch)")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        ADEStatusPill(text: pr.state.uppercased(), tint: prStateTint(pr.state))
          .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-status-\(pr.id)", in: transitionNamespace)
      }

      HStack(spacing: 8) {
        if let laneName = pr.laneName, !laneName.isEmpty {
          ADEStatusPill(text: laneName.uppercased(), tint: ADEColor.textSecondary)
        }
        if let label = prAdeKindLabel(pr.adeKind) {
          ADEStatusPill(text: label, tint: ADEColor.accent)
        }
        Spacer(minLength: 0)
        Text("Updated \(prRelativeTime(pr.updatedAt))")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .adeListCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("PR #\(pr.githubPrNumber), \(pr.title), state \(pr.state)")
  }
}

struct PrPathToMergeTab: View {
  let pr: PullRequestListItem
  let snapshot: PullRequestSnapshot?
  let groupMembers: [PrGroupMemberSummary]
  let reviewThreads: [PrReviewThread]
  let runtime: ConvergenceRuntimeState?
  let capabilities: PrActionCapabilities?
  let isLive: Bool
  /// True while a `prs.pathToMerge.start` or `prs.pathToMerge.stop` round-trip
  /// is in flight. Prevents double-taps on the launch / stop control.
  let isPathToMergeBusy: Bool
  /// `(gating, additionalInstructions, pollIntervalSeconds)` — the launch
  /// config the watcher chat is seeded with. `gating` is `checks` / `comments`
  /// / `both`.
  let onStartPathToMerge: (String, String, Int) -> Void
  let onStopPathToMerge: () -> Void
  /// Open the watcher chat session (when one is active). No-op when the parent
  /// can't navigate to a Work-tab chat.
  let onOpenWatcherChat: () -> Void

  @State private var gating: String = "both"
  @State private var additionalInstructions: String = ""
  @State private var pollMinutes: Int = 10

  init(
    pr: PullRequestListItem,
    snapshot: PullRequestSnapshot?,
    groupMembers: [PrGroupMemberSummary],
    reviewThreads: [PrReviewThread],
    runtime: ConvergenceRuntimeState?,
    capabilities: PrActionCapabilities?,
    isLive: Bool,
    isPathToMergeBusy: Bool = false,
    onStartPathToMerge: @escaping (String, String, Int) -> Void = { _, _, _ in },
    onStopPathToMerge: @escaping () -> Void = {},
    onOpenWatcherChat: @escaping () -> Void = {}
  ) {
    self.pr = pr
    self.snapshot = snapshot
    self.groupMembers = groupMembers
    self.reviewThreads = reviewThreads
    self.runtime = runtime
    self.capabilities = capabilities
    self.isLive = isLive
    self.isPathToMergeBusy = isPathToMergeBusy
    self.onStartPathToMerge = onStartPathToMerge
    self.onStopPathToMerge = onStopPathToMerge
    self.onOpenWatcherChat = onOpenWatcherChat
  }

  // MARK: - Derived state

  /// True when a watcher loop is armed for this PR (the host's runtime row
  /// reports auto-converge enabled). Drives launch-vs-status rendering.
  private var isRunning: Bool {
    runtime?.autoConvergeEnabled ?? false
  }

  private var unresolvedThreadCount: Int {
    reviewThreads.filter { !$0.isResolved }.count
  }

  private var failedChecks: [PrCheck] {
    (snapshot?.checks ?? []).filter { check in
      check.status == "completed" && check.conclusion != nil && check.conclusion != "success" && check.conclusion != "neutral" && check.conclusion != "skipped"
    }
  }

  /// Human-readable list of what currently stands between this PR and a merge.
  /// Surfaced on the launch card so the user knows what the watcher will take
  /// on; the agent itself re-derives ground truth each turn.
  private var blockers: [String] {
    var items: [String] = []
    if snapshot?.status?.mergeConflicts == true {
      items.append("Merge conflicts")
    }
    if (snapshot?.status?.behindBaseBy ?? 0) > 0 {
      items.append("Behind base by \(snapshot?.status?.behindBaseBy ?? 0)")
    }
    if !failedChecks.isEmpty {
      items.append("\(failedChecks.count) failing check\(failedChecks.count == 1 ? "" : "s")")
    }
    if unresolvedThreadCount > 0 {
      items.append("\(unresolvedThreadCount) unresolved review thread\(unresolvedThreadCount == 1 ? "" : "s")")
    }
    if let reason = capabilities?.mergeBlockedReason, !reason.isEmpty {
      items.append(reason)
    }
    return items
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if isRunning {
        runningCard
      } else {
        launchCard
      }

      rebaseCompactCard

      if !groupMembers.isEmpty {
        pathSection(eyebrow: "STACK ORDER", accent: ADEColor.tintPRs) {
          stackOrderCard
        }
      }
    }
  }

  // MARK: - Launch config

  /// Pre-launch configuration: gating, free-form instructions, and poll
  /// cadence. Tapping "Launch watcher" starts a visible Work-tab chat that
  /// watches the PR and drives it to merge itself.
  @ViewBuilder
  private var launchCard: some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          Image(systemName: "point.topleft.down.curvedto.point.bottomright.up")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(ADEColor.tintPRs)
          Text("PATH TO MERGE")
            .font(.system(size: 10, weight: .bold))
            .tracking(1.0)
            .foregroundStyle(ADEColor.tintPRs)
          Spacer(minLength: 0)
        }
        Text("Launch a visible agent chat that watches this PR and drives it to merge — fixing CI, replying to review threads, rebasing, and merging when it's terminal.")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      VStack(alignment: .leading, spacing: 8) {
        Text("GATE MERGE ON")
          .font(.system(size: 10, weight: .bold))
          .tracking(0.8)
          .foregroundStyle(ADEColor.textSecondary)
        Picker("Gating", selection: $gating) {
          Text("CI checks").tag("checks")
          Text("Comments").tag("comments")
          Text("Both").tag("both")
        }
        .pickerStyle(.segmented)
        .disabled(!isLive || isPathToMergeBusy)
      }

      VStack(alignment: .leading, spacing: 8) {
        Text("ADDITIONAL INSTRUCTIONS")
          .font(.system(size: 10, weight: .bold))
          .tracking(0.8)
          .foregroundStyle(ADEColor.textSecondary)
        TextField("Optional — e.g. \"don't force-merge, wait for the design review\"", text: $additionalInstructions, axis: .vertical)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2...5)
          .padding(10)
          .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
              .fill(Color.white.opacity(0.05))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
              .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
          )
          .disabled(!isLive || isPathToMergeBusy)
      }

      HStack(spacing: 10) {
        Text("Check every")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
        Stepper(value: $pollMinutes, in: 1...60) {
          Text("\(pollMinutes) min")
            .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
        }
        .labelsHidden()
        .fixedSize()
        .disabled(!isLive || isPathToMergeBusy)
      }

      if !blockers.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("OPEN BLOCKERS")
            .font(.system(size: 10, weight: .bold))
            .tracking(0.8)
            .foregroundStyle(ADEColor.warning)
          ForEach(blockers, id: \.self) { blocker in
            HStack(alignment: .top, spacing: 6) {
              Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(ADEColor.warning)
                .padding(.top, 2)
              Text(blocker)
                .font(.system(size: 12))
                .foregroundStyle(ADEColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }

      launchButton
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16)
  }

  @ViewBuilder
  private var launchButton: some View {
    Button {
      ADEHaptics.success()
      let trimmed = additionalInstructions.trimmingCharacters(in: .whitespacesAndNewlines)
      onStartPathToMerge(gating, trimmed, pollMinutes * 60)
    } label: {
      HStack(spacing: 6) {
        if isPathToMergeBusy {
          ProgressView().controlSize(.mini).tint(.white)
        } else {
          Image(systemName: "play.fill").font(.system(size: 11, weight: .bold))
        }
        Text(isPathToMergeBusy ? "Launching…" : "Launch watcher")
          .font(.system(size: 12, weight: .bold))
      }
      .foregroundStyle(.white)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
      .background {
        ZStack {
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(PrGlassPalette.accentGradient)
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(
              LinearGradient(
                colors: [Color.white.opacity(0.22), Color.white.opacity(0)],
                startPoint: .top,
                endPoint: .bottom
              )
            )
        }
      }
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
      )
      .shadow(color: PrGlassPalette.purpleDeep.opacity(0.5), radius: 12, y: 5)
    }
    .buttonStyle(.plain)
    .disabled(isPathToMergeBusy || !isLive)
    .opacity((isPathToMergeBusy || !isLive) ? 0.6 : 1)
  }

  // MARK: - Running status

  /// Status card shown once a watcher is armed: state pill, an "agent is
  /// watching" note, optional pause/error footnote, an Open-chat link to the
  /// watcher session, and a Stop control.
  @ViewBuilder
  private var runningCard: some View {
    let status = (runtime?.status ?? "running").replacingOccurrences(of: "_", with: " ")
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: "dot.radiowaves.left.and.right")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(ADEColor.tintPRs)
        Text("PATH TO MERGE")
          .font(.system(size: 10, weight: .bold))
          .tracking(1.0)
          .foregroundStyle(ADEColor.tintPRs)
        Spacer(minLength: 6)
        if isPathToMergeBusy {
          ProgressView().controlSize(.mini).tint(ADEColor.textSecondary)
        } else {
          ConvergenceStatusPill(status: status)
        }
      }

      Text("An agent is watching this PR and taking a fresh turn on each interval until it merges or you stop it.")
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      if let footnote = runningFootnote {
        Text(footnote)
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }

      HStack(spacing: 8) {
        if runtime?.activeSessionId != nil {
          Button {
            ADEHaptics.light()
            onOpenWatcherChat()
          } label: {
            HStack(spacing: 6) {
              Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 11, weight: .semibold))
              Text("Open chat")
                .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(ADEColor.textPrimary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.ultraThinMaterial)
            )
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
            )
          }
          .buttonStyle(.plain)
          .disabled(!isLive)
        }

        Button {
          ADEHaptics.light()
          onStopPathToMerge()
        } label: {
          HStack(spacing: 6) {
            if isPathToMergeBusy {
              ProgressView().controlSize(.mini).tint(.white)
            } else {
              Image(systemName: "stop.fill").font(.system(size: 11, weight: .bold))
            }
            Text("Stop")
              .font(.system(size: 12, weight: .bold))
          }
          .foregroundStyle(.white)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
          .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(ADEColor.danger)
          )
        }
        .buttonStyle(.plain)
        .disabled(isPathToMergeBusy || !isLive)
        .opacity((isPathToMergeBusy || !isLive) ? 0.6 : 1)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16)
  }

  /// One-line explanation under the running status — surfaces offline,
  /// in-flight, pause, or error state.
  private var runningFootnote: String? {
    if !isLive { return "Reconnect to control Path to Merge." }
    if isPathToMergeBusy { return "Stopping…" }
    if let reason = runtime?.pauseReason, !reason.isEmpty { return "Paused: \(reason)" }
    if let err = runtime?.errorMessage, !err.isEmpty { return err }
    return nil
  }

  // MARK: - Compact rebase card

  @ViewBuilder
  private var rebaseCompactCard: some View {
    let behind = snapshot?.status?.behindBaseBy ?? 0
    let conflicts = snapshot?.status?.mergeConflicts ?? false
    let baseLabel = pr.baseBranch.isEmpty ? "base" : pr.baseBranch

    HStack(spacing: 10) {
      if behind > 0 || conflicts {
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.warning)
        Text(conflicts ? "Merge conflicts detected" : "\(behind) commit\(behind == 1 ? "" : "s") behind \(baseLabel)")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
      } else {
        Image(systemName: "checkmark.seal.fill")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.success)
        Text("Up to date with \(baseLabel)")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16)
  }

  // Wrapper: status-tinted eyebrow + glass card. Used by Stack Order section.
  @ViewBuilder
  private func pathSection<Content: View>(eyebrow: String, accent: Color, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Circle()
          .fill(accent)
          .frame(width: 6, height: 6)
          .shadow(color: accent.opacity(0.6), radius: 3)
        Text(eyebrow)
          .font(.system(size: 10, weight: .bold))
          .tracking(1.0)
          .foregroundStyle(accent)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 4)

      content()
        .padding(14)
        .prGlassCard(cornerRadius: 16)
    }
  }

  private var stackOrderCard: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(groupMembers) { member in
        HStack(spacing: 10) {
          Text("\(member.position + 1)")
            .font(.caption.weight(.bold))
            .foregroundStyle(ADEColor.accent)
            .frame(width: 24, height: 24)
            .background(ADEColor.accent.opacity(0.12), in: Circle())
          VStack(alignment: .leading, spacing: 2) {
            Text(member.title)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Text("#\(member.githubPrNumber) · \(member.headBranch) → \(member.baseBranch)")
              .font(.system(size: 10.5, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
          }
        }
      }
    }
  }

}

/// Compact signal tile shown on the Overview merge-signal strip. Three of
/// these fit comfortably in one mobile row; we run two rows for the six
/// signals that mirror desktop's merge status bar.
struct PrSignalTile: View {
  let label: String
  let value: String
  let tint: Color

  var body: some View {
    VStack(spacing: 2) {
      Text(label)
        .font(.system(size: 9, weight: .bold))
        .tracking(0.7)
        .foregroundStyle(tint.opacity(0.9))
      Text(value)
        .font(.system(size: 17, weight: .bold, design: .rounded))
        .foregroundStyle(tint)
        .shadow(color: tint.opacity(0.4), radius: 4)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
    .background(
      ZStack {
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .fill(tint.opacity(0.12))
      }
    )
    .overlay(
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .strokeBorder(tint.opacity(0.32), lineWidth: 0.5)
    )
  }
}

/// Status pill rendered next to the round indicator when in auto-converge.
/// Mirrors desktop's ConvergenceStatusPill — small, color-coded.
struct ConvergenceStatusPill: View {
  let status: String

  private var tint: Color {
    let s = status.lowercased()
    if s.contains("running") || s.contains("polling") || s.contains("launching") { return ADEColor.tintPRs }
    if s.contains("paus") || s.contains("waiting") { return ADEColor.warning }
    if s.contains("error") || s.contains("fail") { return ADEColor.danger }
    if s.contains("done") || s.contains("complete") { return ADEColor.success }
    return ADEColor.textMuted
  }

  var body: some View {
    Text(status.uppercased())
      .font(.system(size: 9, weight: .bold))
      .tracking(0.8)
      .foregroundStyle(tint)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(Capsule().fill(tint.opacity(0.16)))
      .overlay(Capsule().strokeBorder(tint.opacity(0.32), lineWidth: 0.5))
  }
}

struct PrDetailSectionCard<Content: View>: View {
  let title: String
  let content: Content

  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      content
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct PrChipWrap: View {
  let users: [String]
  let tint: Color

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(users, id: \.self) { user in
          ADEStatusPill(text: user.uppercased(), tint: tint)
        }
      }
    }
  }
}

struct PrLaneCleanupBanner: View {
  let laneName: String?
  let isLive: Bool
  let onArchive: () -> Void
  let onDeleteBranch: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "trash.circle.fill")
          .foregroundStyle(ADEColor.warning)
        VStack(alignment: .leading, spacing: 4) {
          Text("Lane cleanup")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("\(laneName ?? "This lane") merged successfully. Clean it up now to archive it or delete its branch.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      HStack(spacing: 10) {
        Button("Archive lane") {
          onArchive()
        }
        .buttonStyle(.glass)
        .disabled(!isLive)

        Button("Delete branch", role: .destructive) {
          onDeleteBranch()
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.warning)
        .disabled(!isLive)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}
