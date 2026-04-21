import SwiftUI

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
      aiSummarySection
      checksSummarySection
      if !commits.isEmpty {
        commitsSummarySection
      }
      filesSummarySection

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

  // MARK: AI summary
  private var aiSummarySection: some View {
    let summary = aiSummary
    let trailingText: String = {
      if let readiness = summary?.mergeReadiness.replacingOccurrences(of: "_", with: " "), !readiness.isEmpty {
        return readiness
      }
      return isAiSummaryLoading ? "generating" : "not generated"
    }()

    return VStack(alignment: .leading, spacing: 10) {
      PrSectionHdr(title: "AI summary") {
        Text(trailingText)
      }
      PrAiSummaryCard(
        summary: summary,
        additions: additions,
        deletions: deletions,
        fileCount: files.count,
        isLoading: isAiSummaryLoading,
        isLive: isLive,
        onRegenerate: onRegenerateAiSummary
      )
      .adeListCard()
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
      .adeListCard()
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
        .adeListCard()
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
      .adeListCard()
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
      .adeListCard()
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
  let deployments: [PrDeployment]
  let aiSummary: AiReviewSummary?
  let issueInventory: IssueInventorySnapshot?
  let pipelineSettings: PipelineSettings?
  let capabilities: PrActionCapabilities?
  let isLive: Bool
  let onRefreshAiSummary: () -> Void
  let onRerunChecks: () -> Void
  let onSyncIssueInventory: () -> Void
  let onMarkIssueFixed: (String) -> Void
  let onDismissIssue: (String) -> Void
  let onEscalateIssue: (String) -> Void
  let onResetIssueInventory: () -> Void
  let onToggleAutoMerge: () -> Void
  let onSetPipelineMergeMethod: (String) -> Void
  let onSetPipelineMaxRounds: (Int) -> Void
  let onSetPipelineRebasePolicy: (String) -> Void

  init(
    pr: PullRequestListItem,
    snapshot: PullRequestSnapshot?,
    groupMembers: [PrGroupMemberSummary],
    reviewThreads: [PrReviewThread],
    deployments: [PrDeployment],
    aiSummary: AiReviewSummary?,
    issueInventory: IssueInventorySnapshot?,
    pipelineSettings: PipelineSettings?,
    capabilities: PrActionCapabilities?,
    isLive: Bool,
    onRefreshAiSummary: @escaping () -> Void,
    onRerunChecks: @escaping () -> Void,
    onSyncIssueInventory: @escaping () -> Void,
    onMarkIssueFixed: @escaping (String) -> Void,
    onDismissIssue: @escaping (String) -> Void,
    onEscalateIssue: @escaping (String) -> Void,
    onResetIssueInventory: @escaping () -> Void,
    onToggleAutoMerge: @escaping () -> Void,
    onSetPipelineMergeMethod: @escaping (String) -> Void,
    onSetPipelineMaxRounds: @escaping (Int) -> Void,
    onSetPipelineRebasePolicy: @escaping (String) -> Void
  ) {
    self.pr = pr
    self.snapshot = snapshot
    self.groupMembers = groupMembers
    self.reviewThreads = reviewThreads
    self.deployments = deployments
    self.aiSummary = aiSummary
    self.issueInventory = issueInventory
    self.pipelineSettings = pipelineSettings
    self.capabilities = capabilities
    self.isLive = isLive
    self.onRefreshAiSummary = onRefreshAiSummary
    self.onRerunChecks = onRerunChecks
    self.onSyncIssueInventory = onSyncIssueInventory
    self.onMarkIssueFixed = onMarkIssueFixed
    self.onDismissIssue = onDismissIssue
    self.onEscalateIssue = onEscalateIssue
    self.onResetIssueInventory = onResetIssueInventory
    self.onToggleAutoMerge = onToggleAutoMerge
    self.onSetPipelineMergeMethod = onSetPipelineMergeMethod
    self.onSetPipelineMaxRounds = onSetPipelineMaxRounds
    self.onSetPipelineRebasePolicy = onSetPipelineRebasePolicy
  }

  private var unresolvedThreadCount: Int {
    reviewThreads.filter { !$0.isResolved }.count
  }

  private var resolvedPipelineSettings: PipelineSettings {
    pipelineSettings ?? PipelineSettings(autoMerge: false, mergeMethod: "repo_default", maxRounds: 5, onRebaseNeeded: "pause")
  }

  private var failedChecks: [PrCheck] {
    (snapshot?.checks ?? []).filter { check in
      check.status == "completed" && check.conclusion != nil && check.conclusion != "success" && check.conclusion != "neutral" && check.conclusion != "skipped"
    }
  }

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
      PrDetailSectionCard("Path to merge") {
        VStack(alignment: .leading, spacing: 10) {
          Label(blockers.isEmpty ? "No merge blockers detected" : "Merge path needs attention", systemImage: blockers.isEmpty ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
            .font(.headline)
            .foregroundStyle(blockers.isEmpty ? ADEColor.success : ADEColor.warning)

          if blockers.isEmpty {
            Text("Checks, reviews, branch freshness, and mergeability all look ready from the synced host state.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          } else {
            ForEach(blockers, id: \.self) { blocker in
              Label(blocker, systemImage: "circle.fill")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
        }
      }

      PrDetailSectionCard("Convergence") {
        VStack(alignment: .leading, spacing: 10) {
          HStack(spacing: 8) {
            ADEStatusPill(text: prChecksLabel(snapshot?.status?.checksStatus ?? pr.checksStatus), tint: prChecksTint(snapshot?.status?.checksStatus ?? pr.checksStatus))
            ADEStatusPill(text: prReviewLabel(snapshot?.status?.reviewStatus ?? pr.reviewStatus), tint: prReviewTint(snapshot?.status?.reviewStatus ?? pr.reviewStatus))
            if let issueInventory {
              ADEStatusPill(text: "\(issueInventory.convergence.totalNew) NEW", tint: issueInventory.convergence.totalNew == 0 ? ADEColor.success : ADEColor.warning)
            }
          }

          if let aiSummary {
            Text(aiSummary.summary)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textPrimary)
          } else {
            Text("Generate the desktop-style AI review summary to capture risk, recommendations, and merge readiness on iOS.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          }

          HStack(spacing: 10) {
            Button(aiSummary == nil ? "Generate AI summary" : "Refresh AI summary") {
              onRefreshAiSummary()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)

            Button("Re-run checks") {
              onRerunChecks()
            }
            .buttonStyle(.glass)
            .disabled(!isLive || (snapshot?.checks ?? []).isEmpty)
          }
        }
      }

      PrDetailSectionCard("Issue inventory") {
        VStack(alignment: .leading, spacing: 12) {
          if let issueInventory {
            HStack(spacing: 8) {
              ADEStatusPill(text: "\(issueInventory.convergence.totalNew) new", tint: ADEColor.warning)
              ADEStatusPill(text: "\(issueInventory.convergence.totalSentToAgent) sent", tint: ADEColor.accent)
              ADEStatusPill(text: "\(issueInventory.convergence.totalFixed) fixed", tint: ADEColor.success)
              ADEStatusPill(text: "\(issueInventory.convergence.totalEscalated) escalated", tint: ADEColor.danger)
            }
            .font(.caption)

            Text("Round \(issueInventory.convergence.currentRound) of \(issueInventory.convergence.maxRounds) · \(issueInventory.runtime.status.replacingOccurrences(of: "_", with: " "))")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)

            let activeItems = issueInventory.items.filter { $0.state == "new" || $0.state == "sent_to_agent" || $0.state == "escalated" }
            if activeItems.isEmpty {
              Label("No active inventory items", systemImage: "checkmark.seal.fill")
                .font(.subheadline)
                .foregroundStyle(ADEColor.success)
            } else {
              VStack(alignment: .leading, spacing: 10) {
                ForEach(activeItems.prefix(8)) { item in
                  PrIssueInventoryRow(
                    item: item,
                    isLive: isLive,
                    onFixed: { onMarkIssueFixed(item.id) },
                    onDismiss: { onDismissIssue(item.id) },
                    onEscalate: { onEscalateIssue(item.id) }
                  )
                }
              }
            }
          } else {
            Text("Sync issue inventory to mirror the desktop convergence loop: review threads, failing checks, dismissed findings, and escalations.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          }

          HStack(spacing: 10) {
            Button(issueInventory == nil ? "Sync inventory" : "Refresh inventory") {
              onSyncIssueInventory()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)

            Button("Reset", role: .destructive) {
              onResetIssueInventory()
            }
            .buttonStyle(.glass)
            .disabled(!isLive || issueInventory == nil)
          }
        }
      }

      PrDetailSectionCard("Pipeline") {
        VStack(alignment: .leading, spacing: 10) {
          let settings = resolvedPipelineSettings
          HStack(spacing: 8) {
            ADEStatusPill(text: settings.autoMerge ? "AUTO-MERGE ON" : "AUTO-MERGE OFF", tint: settings.autoMerge ? ADEColor.success : ADEColor.textSecondary)
            ADEStatusPill(text: pipelineMergeMethodLabel(settings.mergeMethod).uppercased(), tint: ADEColor.accent)
            ADEStatusPill(text: "\(settings.maxRounds) rounds", tint: ADEColor.textSecondary)
          }

          Text("Rebase policy: \(pipelineRebasePolicyLabel(settings.onRebaseNeeded))")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          VStack(alignment: .leading, spacing: 8) {
            Button(settings.autoMerge ? "Disable auto-merge" : "Enable auto-merge") {
              onToggleAutoMerge()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)

            HStack(spacing: 8) {
              Menu {
                Button("Repository default") { onSetPipelineMergeMethod("repo_default") }
                ForEach(PrMergeMethodOption.allCases) { option in
                  Button(option.title) { onSetPipelineMergeMethod(option.rawValue) }
                }
              } label: {
                Label(pipelineMergeMethodLabel(settings.mergeMethod), systemImage: "arrow.triangle.merge")
              }
              .buttonStyle(.glass)
              .disabled(!isLive)

              Menu {
                Button("Pause") { onSetPipelineRebasePolicy("pause") }
                Button("Auto-rebase") { onSetPipelineRebasePolicy("auto_rebase") }
              } label: {
                Label(pipelineRebasePolicyLabel(settings.onRebaseNeeded), systemImage: "arrow.triangle.2.circlepath")
              }
              .buttonStyle(.glass)
              .disabled(!isLive)
            }

            HStack(spacing: 10) {
              Button {
                onSetPipelineMaxRounds(max(1, settings.maxRounds - 1))
              } label: {
                Image(systemName: "minus")
                  .frame(width: 34, height: 34)
              }
              .buttonStyle(.glass)
              .disabled(!isLive || settings.maxRounds <= 1)

              Text("Max rounds \(settings.maxRounds)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textSecondary)
                .frame(minWidth: 100)

              Button {
                onSetPipelineMaxRounds(min(10, settings.maxRounds + 1))
              } label: {
                Image(systemName: "plus")
                  .frame(width: 34, height: 34)
              }
              .buttonStyle(.glass)
              .disabled(!isLive || settings.maxRounds >= 10)
            }
          }
        }
      }

      if !groupMembers.isEmpty {
        PrDetailSectionCard("Stack order") {
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
                  Text("#\(member.githubPrNumber) · \(member.headBranch) → \(member.baseBranch)")
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }
        }
      }

      if !deployments.isEmpty || !reviewThreads.isEmpty {
        PrDetailSectionCard("Signals") {
          VStack(alignment: .leading, spacing: 8) {
            if !deployments.isEmpty {
              Label("\(deployments.count) deployment\(deployments.count == 1 ? "" : "s") synced", systemImage: "shippingbox.fill")
                .foregroundStyle(ADEColor.textSecondary)
            }
            if !reviewThreads.isEmpty {
              Label("\(unresolvedThreadCount) unresolved of \(reviewThreads.count) review threads", systemImage: "text.bubble")
                .foregroundStyle(unresolvedThreadCount == 0 ? ADEColor.success : ADEColor.warning)
            }
          }
          .font(.caption.weight(.semibold))
        }
      }
    }
  }
}

private func pipelineMergeMethodLabel(_ method: String) -> String {
  switch method {
  case "repo_default": return "Repository default"
  case "squash": return "Squash"
  case "merge": return "Merge commit"
  case "rebase": return "Rebase merge"
  default: return method.replacingOccurrences(of: "_", with: " ")
  }
}

private func pipelineRebasePolicyLabel(_ policy: String) -> String {
  switch policy {
  case "auto_rebase": return "Auto-rebase"
  case "pause": return "Pause"
  default: return policy.replacingOccurrences(of: "_", with: " ")
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

struct PrIssueInventoryRow: View {
  let item: IssueInventoryItem
  let isLive: Bool
  let onFixed: () -> Void
  let onDismiss: () -> Void
  let onEscalate: () -> Void

  private var tint: Color {
    switch item.severity {
    case "critical": return ADEColor.danger
    case "major": return ADEColor.warning
    default: return ADEColor.textSecondary
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 8) {
        ADEStatusPill(text: item.source.uppercased(), tint: ADEColor.accent)
        ADEStatusPill(text: item.state.replacingOccurrences(of: "_", with: " ").uppercased(), tint: tint)
        Spacer(minLength: 0)
        Menu {
          Button("Mark fixed") { onFixed() }
          Button("Dismiss") { onDismiss() }
          Button("Escalate") { onEscalate() }
        } label: {
          Image(systemName: "ellipsis.circle")
            .frame(width: 32, height: 32)
        }
        .buttonStyle(.glass)
        .disabled(!isLive)
      }

      Text(item.headline)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)

      HStack(spacing: 8) {
        if let filePath = item.filePath, !filePath.isEmpty {
          Text(item.line.map { "\(filePath):\($0)" } ?? filePath)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Text("Round \(item.round)")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(10)
    .background(ADEColor.raisedBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
