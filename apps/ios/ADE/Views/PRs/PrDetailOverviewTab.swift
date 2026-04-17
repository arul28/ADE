import SwiftUI

struct PrOverviewTab: View {
  let pr: PullRequestListItem
  let snapshot: PullRequestSnapshot?
  let deployments: [PrDeployment]
  let aiSummary: AiReviewSummary?
  let actionAvailability: PrActionAvailability
  /// Host-provided capability gates. Nil when the mobile snapshot is
  /// unavailable (offline, pre-contract host); the view falls back to
  /// `actionAvailability` in that case so cached behavior is preserved.
  let capabilities: PrActionCapabilities?
  @Binding var mergeMethod: PrMergeMethodOption
  @Binding var reviewerInput: String
  let isLive: Bool
  let groupMembers: [PrGroupMemberSummary]
  let onMerge: () -> Void
  let onClose: () -> Void
  let onReopen: () -> Void
  let onRequestReviewers: () -> Void
  let onOpenGitHub: () -> Void
  let onOpenStack: (String, String?) -> Void
  let onEditTitle: () -> Void
  let onEditBody: () -> Void
  let onEditLabels: () -> Void
  let onSubmitReview: () -> Void
  let onArchiveLane: () -> Void
  let onDeleteBranch: () -> Void

  // Merge derivation: host capability wins when present. It already folds in
  // draft/failing-checks/closed state via mergeBlockedReason, so we don't
  // also need to AND with actionAvailability.mergeEnabled there.
  private var showsMerge: Bool {
    capabilities?.canMerge ?? actionAvailability.showsMerge
  }
  private var mergeEnabled: Bool {
    if let capabilities {
      return capabilities.canMerge && mergeable
    }
    return actionAvailability.mergeEnabled && mergeable
  }
  private var showsClose: Bool {
    capabilities?.canClose ?? actionAvailability.showsClose
  }
  private var showsReopen: Bool {
    capabilities?.canReopen ?? actionAvailability.showsReopen
  }
  private var showsRequestReviewers: Bool {
    capabilities?.canRequestReviewers ?? actionAvailability.showsRequestReviewers
  }

  private var mergeable: Bool {
    (snapshot?.status?.isMergeable ?? true) && !(snapshot?.status?.mergeConflicts ?? false)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrDetailSectionCard("Description") {
        if let body = snapshot?.detail?.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          PrMarkdownRenderer(markdown: body)
        } else {
          Text("No description was synced for this PR yet.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      PrDetailSectionCard("Overview") {
        VStack(alignment: .leading, spacing: 10) {
          HStack(spacing: 8) {
            ADEStatusPill(text: prChecksLabel(snapshot?.status?.checksStatus ?? pr.checksStatus), tint: prChecksTint(snapshot?.status?.checksStatus ?? pr.checksStatus))
            ADEStatusPill(text: prReviewLabel(snapshot?.status?.reviewStatus ?? pr.reviewStatus), tint: prReviewTint(snapshot?.status?.reviewStatus ?? pr.reviewStatus))
            if let cleanupState = pr.cleanupState, !cleanupState.isEmpty {
              ADEStatusPill(text: cleanupState.uppercased(), tint: ADEColor.warning)
            }
          }

          Text("Author: \(snapshot?.detail?.author.login ?? "Unknown")")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)

          if let detail = snapshot?.detail {
            if !detail.requestedReviewers.isEmpty {
              PrChipWrap(users: detail.requestedReviewers.map(\.login), tint: ADEColor.warning)
            }
            if !detail.labels.isEmpty {
              PrChipWrap(users: detail.labels.map(\.name), tint: ADEColor.accent)
            }
            if !detail.linkedIssues.isEmpty {
              Text(detail.linkedIssues.map { "#\($0.number) \($0.title)" }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }

          if !groupMembers.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              Text("Stack")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              ForEach(groupMembers) { member in
                Text("\(member.position + 1). #\(member.githubPrNumber) · \(member.title)")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
            }
          }

          if let groupId = pr.linkedGroupId {
            Button("Open stack") {
              onOpenStack(groupId, pr.laneName)
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }
        }
      }

      if let aiSummary {
        PrDetailSectionCard("AI summary") {
          VStack(alignment: .leading, spacing: 10) {
            ADEStatusPill(text: aiSummary.mergeReadiness.replacingOccurrences(of: "_", with: " ").uppercased(), tint: aiSummary.mergeReadiness == "ready" ? ADEColor.success : ADEColor.warning)
            Text(aiSummary.summary)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textPrimary)
            if !aiSummary.potentialIssues.isEmpty {
              VStack(alignment: .leading, spacing: 6) {
                Text("Potential issues")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(ADEColor.textPrimary)
                ForEach(aiSummary.potentialIssues.prefix(4), id: \.self) { issue in
                  Label(issue, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(ADEColor.warning)
                }
              }
            }
          }
        }
      }

      if !deployments.isEmpty {
        PrDetailSectionCard("Deployments") {
          VStack(alignment: .leading, spacing: 10) {
            ForEach(deployments.prefix(4)) { deployment in
              HStack(spacing: 10) {
                Image(systemName: "shippingbox.fill")
                  .foregroundStyle(deployment.state == "success" ? ADEColor.success : ADEColor.warning)
                VStack(alignment: .leading, spacing: 2) {
                  Text(deployment.environment)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                  Text(deployment.state.uppercased())
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
                Spacer(minLength: 0)
                if let urlString = deployment.environmentUrl, let url = URL(string: urlString) {
                  Link(destination: url) {
                    Image(systemName: "arrow.up.right.square")
                  }
                  .foregroundStyle(ADEColor.accent)
                }
              }
              .adeInsetField(cornerRadius: 12, padding: 10)
            }
          }
        }
      }

      PrDetailSectionCard("Merge readiness") {
        VStack(alignment: .leading, spacing: 10) {
          Label(
            mergeable ? "Ready to merge" : "Needs attention before merge",
            systemImage: mergeable ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
          )
          .foregroundStyle(mergeable ? ADEColor.success : ADEColor.warning)

          if let status = snapshot?.status {
            if status.mergeConflicts {
              Text("The host reported merge conflicts for this branch.")
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
            }
            if status.behindBaseBy > 0 {
              Text("This branch is \(status.behindBaseBy) commit\(status.behindBaseBy == 1 ? "" : "s") behind the base branch.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
        }
      }

      PrDetailSectionCard("Actions") {
        VStack(alignment: .leading, spacing: 12) {
          LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            Button("Edit title") {
              onEditTitle()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)

            Button("Edit description") {
              onEditBody()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)

            Button("Set labels") {
              onEditLabels()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)

            Button("Submit review") {
              onSubmitReview()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }

          Divider()
            .opacity(0.35)

          Picker("Merge strategy", selection: $mergeMethod) {
            ForEach(PrMergeMethodOption.allCases) { option in
              Text(option.shortTitle).tag(option)
            }
          }
          .pickerStyle(.menu)
          .adeInsetField()

          Text(mergeMethod.description)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          if showsMerge {
            Button(mergeMethod.title) {
              onMerge()
            }
            .buttonStyle(.glassProminent)
            .tint(ADEColor.accent)
            .disabled(!isLive || !mergeEnabled)

            if let reason = capabilities?.mergeBlockedReason, !reason.isEmpty {
              Text("Merge blocked: \(reason)")
                .font(.caption)
                .foregroundStyle(ADEColor.warning)
            }
          }

          if showsClose {
            Button("Close PR", role: .destructive) {
              onClose()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }

          if showsReopen {
            Button("Reopen PR") {
              onReopen()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }

          if showsRequestReviewers {
            TextField("Request reviewers (comma-separated)", text: $reviewerInput)
              .adeInsetField()
            Button("Request reviewers") {
              onRequestReviewers()
            }
            .buttonStyle(.glass)
            .disabled(!isLive || reviewerInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }

          Button("Open in GitHub") {
            onOpenGitHub()
          }
          .buttonStyle(.glass)
          .tint(ADEColor.textSecondary)
        }
      }

      if pr.state == "merged" {
        PrLaneCleanupBanner(laneName: pr.laneName, isLive: isLive, onArchive: onArchiveLane, onDeleteBranch: onDeleteBranch)
      }
    }
  }
}

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
