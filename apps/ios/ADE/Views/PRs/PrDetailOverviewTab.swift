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
  let aiResolution: AiResolutionState?
  let isAiResolverBusy: Bool
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
  let onCopyPrompt: () -> Void
  let onLaunchAiResolver: () -> Void
  let onStopAiResolver: () -> Void

  @State private var pipelineExpanded = false

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
    aiResolution: AiResolutionState? = nil,
    isAiResolverBusy: Bool = false,
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
    onSetPipelineRebasePolicy: @escaping (String) -> Void,
    onCopyPrompt: @escaping () -> Void = {},
    onLaunchAiResolver: @escaping () -> Void = {},
    onStopAiResolver: @escaping () -> Void = {}
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
    self.aiResolution = aiResolution
    self.isAiResolverBusy = isAiResolverBusy
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
    self.onCopyPrompt = onCopyPrompt
    self.onLaunchAiResolver = onLaunchAiResolver
    self.onStopAiResolver = onStopAiResolver
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

  // MARK: - Derived state

  private var aiResolverRunning: Bool {
    let status = aiResolution?.status?.lowercased() ?? ""
    return status == "running" || status == "starting" || status == "pending"
  }

  private var isAutoConverge: Bool {
    issueInventory?.runtime.autoConvergeEnabled ?? false
  }

  /// Active items shown in the REVIEW COMMENTS list — anything not yet
  /// reconciled (matches desktop's "unresolved" filter default).
  private var activeItems: [IssueInventoryItem] {
    let items = issueInventory?.items ?? []
    return items.filter { $0.state == "new" || $0.state == "sent_to_agent" || $0.state == "escalated" }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      modeStrip
      counterStrip

      reviewCommentsSection

      pipelineDisclosure
      rebaseCompactCard

      if !groupMembers.isEmpty {
        pathSection(eyebrow: "STACK ORDER", accent: ADEColor.tintPRs) {
          stackOrderCard
        }
      }

      bottomActions
    }
  }

  // MARK: - Mode strip (Manual / Auto-Converge)

  /// Read-only mirror of the desktop's mode toggle. The host doesn't expose a
  /// mobile setter for `auto_converge_enabled`, so we surface state without
  /// trying to write it. Round + status pill appear when in auto mode, exactly
  /// like desktop.
  @ViewBuilder
  private var modeStrip: some View {
    let convergence = issueInventory?.convergence
    let runtimeStatus = issueInventory?.runtime.status.replacingOccurrences(of: "_", with: " ") ?? "idle"
    HStack(spacing: 8) {
      HStack(spacing: 0) {
        modePill(label: "Manual", isActive: !isAutoConverge)
        modePill(label: "Auto-Converge", isActive: isAutoConverge)
      }
      .padding(2)
      .background(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(Color.white.opacity(0.04))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
      )

      Spacer(minLength: 6)

      if isAutoConverge, let convergence {
        Text("Round \(convergence.currentRound)/\(convergence.maxRounds)")
          .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
        ConvergenceStatusPill(status: runtimeStatus)
      }
    }
  }

  private func modePill(label: String, isActive: Bool) -> some View {
    Text(label)
      .font(.system(size: 10.5, weight: isActive ? .bold : .medium))
      .tracking(0.4)
      .foregroundStyle(isActive ? Color(red: 0x10/255, green: 0x0D/255, blue: 0x14/255) : ADEColor.textSecondary)
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background {
        if isActive {
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(ADEColor.tintPRs)
        }
      }
  }

  // MARK: - Counter strip (NEW / FIXED / DISMISSED / ESCALATED)

  @ViewBuilder
  private var counterStrip: some View {
    let convergence = issueInventory?.convergence
    HStack(spacing: 6) {
      PrPathCounterCell(
        label: "NEW",
        count: convergence?.totalNew ?? 0,
        tint: ADEColor.warning,
        isPrimary: (convergence?.totalNew ?? 0) > 0
      )
      PrPathCounterCell(
        label: "FIXED",
        count: convergence?.totalFixed ?? 0,
        tint: ADEColor.success
      )
      PrPathCounterCell(
        label: "DISMISSED",
        count: convergence?.totalDismissed ?? 0,
        tint: ADEColor.textMuted
      )
      PrPathCounterCell(
        label: "ESCALATED",
        count: convergence?.totalEscalated ?? 0,
        tint: ADEColor.danger
      )
    }
  }

  // MARK: - Review comments list

  @ViewBuilder
  private var reviewCommentsSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "text.bubble")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textSecondary)
        Text("REVIEW COMMENTS")
          .font(.system(size: 10, weight: .bold))
          .tracking(1.0)
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 8)
        Text("\(activeItems.count)")
          .font(.system(size: 11, weight: .bold, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 4)

      if issueInventory == nil {
        VStack(alignment: .leading, spacing: 10) {
          Text("Sync the issue inventory to see review comments grouped by source, severity, and round.")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Button("Sync inventory") { onSyncIssueInventory() }
            .buttonStyle(.glass)
            .disabled(!isLive)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .prGlassCard(cornerRadius: 16)
      } else if activeItems.isEmpty {
        HStack(spacing: 10) {
          Image(systemName: "checkmark.seal.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.success)
          Text("No active review comments — everything is reconciled.")
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(ADEColor.textSecondary)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .prGlassCard(cornerRadius: 16)
      } else {
        VStack(spacing: 0) {
          ForEach(Array(activeItems.enumerated()), id: \.element.id) { index, item in
            PrPathReviewCommentRow(
              item: item,
              isLive: isLive,
              onMarkFixed: { onMarkIssueFixed(item.id) },
              onDismiss: { onDismissIssue(item.id) },
              onEscalate: { onEscalateIssue(item.id) }
            )
            if index < activeItems.count - 1 {
              Divider().background(ADEColor.textMuted.opacity(0.12))
            }
          }
        }
        .prGlassCard(cornerRadius: 16)
      }
    }
  }

  // MARK: - Pipeline disclosure

  @ViewBuilder
  private var pipelineDisclosure: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.easeInOut(duration: 0.2)) { pipelineExpanded.toggle() }
      } label: {
        HStack(spacing: 8) {
          Image(systemName: "slider.horizontal.3")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.tintPRs)
          Text("PIPELINE")
            .font(.system(size: 10, weight: .bold))
            .tracking(1.0)
            .foregroundStyle(ADEColor.tintPRs)
          Spacer(minLength: 0)
          Text(pipelineSummaryLine)
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
          Image(systemName: "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(.degrees(pipelineExpanded ? 180 : 0))
            .animation(.easeInOut(duration: 0.18), value: pipelineExpanded)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      if pipelineExpanded {
        Divider().background(ADEColor.textMuted.opacity(0.12))
        pipelineSettingsCard
          .padding(.horizontal, 14)
          .padding(.bottom, 8)
          .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .prGlassCard(cornerRadius: 16)
  }

  private var pipelineSummaryLine: String {
    let s = resolvedPipelineSettings
    let method = pipelineMergeMethodLabel(s.mergeMethod).lowercased()
    let policy = pipelineRebasePolicyLabel(s.onRebaseNeeded).lowercased()
    return "\(method) · max \(s.maxRounds) · \(policy)"
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
        Text(resolvedPipelineSettings.onRebaseNeeded == "auto_rebase" ? "auto-rebase" : "paused")
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
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

  // MARK: - Bottom actions (Copy Prompt + Launch Agent)

  @ViewBuilder
  private var bottomActions: some View {
    HStack(spacing: 8) {
      Button {
        ADEHaptics.success()
        onCopyPrompt()
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "doc.on.doc")
            .font(.system(size: 11, weight: .semibold))
          Text("Copy Prompt")
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

      Button {
        if aiResolverRunning { onStopAiResolver() } else { onLaunchAiResolver() }
      } label: {
        HStack(spacing: 6) {
          if isAiResolverBusy {
            ProgressView().controlSize(.mini).tint(.white)
          } else if aiResolverRunning {
            Image(systemName: "stop.fill").font(.system(size: 11, weight: .bold))
          } else {
            Image(systemName: "sparkles").font(.system(size: 11, weight: .bold))
          }
          Text(aiResolverRunning ? "Stop Agent" : "Launch Agent")
            .font(.system(size: 12, weight: .bold))
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background {
          if aiResolverRunning {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(ADEColor.danger)
          } else {
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
        }
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
        )
        .shadow(
          color: aiResolverRunning ? ADEColor.danger.opacity(0.4) : PrGlassPalette.purpleDeep.opacity(0.5),
          radius: 12, y: 5
        )
      }
      .buttonStyle(.plain)
      .disabled(isAiResolverBusy || !isLive)
      .opacity((isAiResolverBusy || !isLive) ? 0.6 : 1)
    }
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

  // Pipeline settings — list-style rows of setting → value.
  @ViewBuilder
  private var pipelineSettingsCard: some View {
    let settings = resolvedPipelineSettings
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Text("Auto-merge")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
        Toggle("", isOn: Binding(
          get: { settings.autoMerge },
          set: { _ in onToggleAutoMerge() }
        ))
        .labelsHidden()
        .tint(PrGlassPalette.purpleDeep)
        .disabled(!isLive)
      }
      .padding(.vertical, 10)

      Divider().overlay(ADEColor.textMuted.opacity(0.15))

      HStack(spacing: 10) {
        Text("Merge method")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
        Menu {
          Button("Repository default") { onSetPipelineMergeMethod("repo_default") }
          ForEach(PrMergeMethodOption.allCases) { option in
            Button(option.title) { onSetPipelineMergeMethod(option.rawValue) }
          }
        } label: {
          HStack(spacing: 4) {
            Text(pipelineMergeMethodLabel(settings.mergeMethod).lowercased())
              .font(.system(size: 12, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
            Image(systemName: "chevron.up.chevron.down")
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .disabled(!isLive)
      }
      .padding(.vertical, 10)

      Divider().overlay(ADEColor.textMuted.opacity(0.15))

      HStack(spacing: 10) {
        Text("Max retry rounds")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
        HStack(spacing: 10) {
          Button {
            onSetPipelineMaxRounds(max(1, settings.maxRounds - 1))
          } label: {
            Image(systemName: "minus")
              .font(.system(size: 11, weight: .bold))
              .foregroundStyle(ADEColor.textSecondary)
              .frame(width: 22, height: 22)
              .background(Color.white.opacity(0.05), in: Circle())
          }
          .buttonStyle(.plain)
          .disabled(!isLive || settings.maxRounds <= 1)

          Text("\(settings.maxRounds)")
            .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(minWidth: 18)

          Button {
            onSetPipelineMaxRounds(min(10, settings.maxRounds + 1))
          } label: {
            Image(systemName: "plus")
              .font(.system(size: 11, weight: .bold))
              .foregroundStyle(ADEColor.textSecondary)
              .frame(width: 22, height: 22)
              .background(Color.white.opacity(0.05), in: Circle())
          }
          .buttonStyle(.plain)
          .disabled(!isLive || settings.maxRounds >= 10)
        }
      }
      .padding(.vertical, 10)

      Divider().overlay(ADEColor.textMuted.opacity(0.15))

      HStack(spacing: 10) {
        Text("Rebase policy")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
        Menu {
          Button("Pause") { onSetPipelineRebasePolicy("pause") }
          Button("Auto-rebase") { onSetPipelineRebasePolicy("auto_rebase") }
        } label: {
          HStack(spacing: 4) {
            Text(pipelineRebasePolicyLabel(settings.onRebaseNeeded).lowercased())
              .font(.system(size: 12, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
            Image(systemName: "chevron.up.chevron.down")
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .disabled(!isLive)
      }
      .padding(.vertical, 10)
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

/// Counter cell on the Path-to-Merge counter strip. Big number, small label,
/// glass background, accent color when nonzero.
struct PrPathCounterCell: View {
  let label: String
  let count: Int
  let tint: Color
  var isPrimary: Bool = false

  var body: some View {
    VStack(spacing: 4) {
      Text("\(count)")
        .font(.system(size: 22, weight: .bold, design: .rounded))
        .foregroundStyle(count > 0 ? tint : ADEColor.textMuted)
        .shadow(color: (count > 0 ? tint : .clear).opacity(0.45), radius: 5)
        .monospacedDigit()
      Text(label)
        .font(.system(size: 9, weight: .bold))
        .tracking(0.8)
        .foregroundStyle(count > 0 ? tint.opacity(0.9) : ADEColor.textMuted)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 10)
    .background(
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(.ultraThinMaterial)
        if count > 0 {
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(tint.opacity(isPrimary ? 0.18 : 0.10))
        }
      }
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder((count > 0 ? tint : ADEColor.textMuted).opacity(0.28), lineWidth: 0.5)
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

/// One review-comment row in the Path-to-Merge list. Severity badge on the
/// left, headline + file:line in the middle, source initials chip + ellipsis
/// menu on the right. Mirrors the desktop two-line row layout.
struct PrPathReviewCommentRow: View {
  let item: IssueInventoryItem
  let isLive: Bool
  let onMarkFixed: () -> Void
  let onDismiss: () -> Void
  let onEscalate: () -> Void

  private var severityTint: Color {
    switch (item.severity ?? "").lowercased() {
    case "critical", "high": return ADEColor.danger
    case "major": return ADEColor.warning
    case "minor", "low": return ADEColor.textSecondary
    default: return ADEColor.textMuted
    }
  }

  private var severityLabel: String {
    let raw = (item.severity ?? "").lowercased()
    if raw.isEmpty { return "NOTE" }
    return raw.uppercased()
  }

  private var sourceInitials: String {
    // Mirror the desktop's CR/HM/CP-style chip. We derive initials from the
    // source token: CodeRabbit → CR, GreptileReview → GR, etc.
    let raw = item.source.replacingOccurrences(of: "_", with: " ")
    let words = raw.split(separator: " ").prefix(2)
    if words.count >= 2 {
      return String(words.map { $0.first ?? " " }).uppercased()
    }
    return String(raw.prefix(2)).uppercased()
  }

  private var sourceTint: Color {
    switch item.source.lowercased() {
    case let s where s.contains("coderabbit"): return ADEColor.success
    case let s where s.contains("greptile"): return ADEColor.tintPRs
    case let s where s.contains("copilot"): return ADEColor.accent
    case let s where s.contains("human"): return ADEColor.textPrimary
    default: return ADEColor.textSecondary
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Text(severityLabel)
        .font(.system(size: 9, weight: .bold))
        .tracking(0.6)
        .foregroundStyle(severityTint)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Capsule().fill(severityTint.opacity(0.16)))
        .overlay(Capsule().strokeBorder(severityTint.opacity(0.32), lineWidth: 0.5))
        .padding(.top, 2)

      VStack(alignment: .leading, spacing: 4) {
        Text(item.headline)
          .font(.system(size: 12.5, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
        if let path = item.filePath, !path.isEmpty {
          Text(item.line.map { "\(path):\($0)" } ?? path)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }

      Spacer(minLength: 6)

      Text(sourceInitials)
        .font(.system(size: 9, weight: .bold, design: .monospaced))
        .foregroundStyle(sourceTint)
        .frame(width: 22, height: 22)
        .background(Circle().fill(sourceTint.opacity(0.16)))
        .overlay(Circle().strokeBorder(sourceTint.opacity(0.32), lineWidth: 0.5))

      Menu {
        Button("Mark fixed", systemImage: "checkmark") { onMarkFixed() }
        Button("Dismiss", systemImage: "xmark") { onDismiss() }
        Button("Escalate", systemImage: "exclamationmark.triangle") { onEscalate() }
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 24, height: 24)
      }
      .disabled(!isLive)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

/// Small numbered stat chip used on the Path tab header row.
private struct PrPathStatChip: View {
  let count: Int
  let label: String
  let tint: Color

  var body: some View {
    HStack(spacing: 4) {
      Text("\(count)")
        .font(.system(size: 11, weight: .bold, design: .monospaced))
        .foregroundStyle(tint)
      Text(label)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(tint.opacity(0.85))
    }
    .padding(.horizontal, 7)
    .padding(.vertical, 3)
    .background(
      Capsule(style: .continuous)
        .fill(tint.opacity(0.14))
    )
    .overlay(
      Capsule(style: .continuous)
        .strokeBorder(tint.opacity(0.32), lineWidth: 0.5)
    )
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
