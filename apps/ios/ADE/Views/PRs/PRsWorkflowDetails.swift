import SwiftUI
import UIKit

struct PrIntegrationDetailView: View {
  @EnvironmentObject private var syncService: SyncService

  let proposalId: String
  let proposals: [IntegrationProposal]
  let isLive: Bool
  let onRefresh: () -> Void
  let onOpenPr: (String) -> Void

  @State private var errorMessage: String?

  private var proposal: IntegrationProposal? {
    proposals.first(where: { $0.proposalId == proposalId })
  }

  var body: some View {
    List {
      if let errorMessage {
        ADENoticeCard(
          title: "Integration action failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: onRefresh
        )
        .prListRow()
      }

      if let proposal {
        PrDetailSectionCard("Simulation") {
          VStack(alignment: .leading, spacing: 10) {
            Text(proposal.body?.isEmpty == false ? proposal.body! : "Tracking the lane bundle and merge analysis for this integration.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
            Text("Base branch: \(proposal.baseBranch)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
            Text("Outcome: \(proposal.overallOutcome)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        .prListRow()

        PrDetailSectionCard("Actions") {
          VStack(alignment: .leading, spacing: 10) {
            if let linkedPrId = proposal.linkedPrId, !linkedPrId.isEmpty {
              Button("Open linked PR") {
                onOpenPr(linkedPrId)
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
            } else if proposal.integrationLaneId == nil {
              Button("Create integration lane") {
                Task { await runAction { _ = try await syncService.createIntegrationLaneForProposal(proposalId: proposal.proposalId) } }
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
              .disabled(!isLive)
            } else if proposal.title?.isEmpty == false, proposal.integrationLaneName?.isEmpty == false {
              Button("Commit integration") {
                Task {
                  await runAction {
                    _ = try await syncService.commitIntegration(
                      proposalId: proposal.proposalId,
                      integrationLaneName: proposal.integrationLaneName ?? "integration/\(proposal.proposalId.prefix(6))",
                      title: proposal.title ?? "Integration workflow",
                      body: proposal.body,
                      draft: proposal.draft ?? true
                    )
                  }
                }
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
              .disabled(!isLive)
            }

            Button("Re-simulate") {
              Task {
                await runAction {
                  _ = try await syncService.simulateIntegration(sourceLaneIds: proposal.sourceLaneIds, baseBranch: proposal.baseBranch)
                }
              }
            }
            .buttonStyle(.glass)
            .disabled(!isLive)

            if proposal.workflowDisplayState == "history", proposal.cleanupState != "completed" {
              Button("Dismiss cleanup") {
                Task { await runAction { _ = try await syncService.dismissIntegrationCleanup(proposalId: proposal.proposalId) } }
              }
              .buttonStyle(.glass)
              .disabled(!isLive)
            }

            Button("Delete proposal", role: .destructive) {
              Task { await runAction { _ = try await syncService.deleteIntegrationProposal(proposalId: proposal.proposalId, deleteIntegrationLane: false) } }
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }
        }
        .prListRow()

        PrDetailSectionCard("Steps") {
          VStack(alignment: .leading, spacing: 10) {
            ForEach(proposal.steps) { step in
              VStack(alignment: .leading, spacing: 6) {
                HStack {
                  Text("\(step.position + 1). \(step.laneName)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                  Spacer(minLength: 8)
                  ADEStatusPill(text: step.outcome.uppercased(), tint: step.outcome == "clean" ? ADEColor.success : ADEColor.warning)
                }
                Text("\(step.diffStat.filesChanged) files · +\(step.diffStat.insertions) -\(step.diffStat.deletions)")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
                Button("Re-check step") {
                  Task { await runAction { _ = try await syncService.recheckIntegrationStep(proposalId: proposal.proposalId, laneId: step.laneId) } }
                }
                .buttonStyle(.glass)
                .disabled(!isLive)
              }
              .adeInsetField(cornerRadius: 14, padding: 12)
            }
          }
        }
        .prListRow()

        if !proposal.pairwiseResults.isEmpty {
          PrDetailSectionCard("Pairwise conflicts") {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(proposal.pairwiseResults) { result in
                VStack(alignment: .leading, spacing: 4) {
                  Text("\(result.laneAName) ↔ \(result.laneBName)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                  Text(result.outcome)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }
          .prListRow()
        }

      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(proposal?.title ?? "Integration")
    .navigationBarTitleDisplayMode(.inline)
  }

  @MainActor
  private func runAction(_ action: () async throws -> Void) async {
    do {
      try await action()
      errorMessage = nil
      onRefresh()
    } catch {
      errorMessage = SyncUserFacingError.message(for: error)
    }
  }
}

struct PrQueueDetailView: View {
  @EnvironmentObject private var syncService: SyncService

  let queueId: String
  let queues: [QueueLandingState]
  let snapshotsById: [String: PullRequestSnapshot]
  let isLive: Bool
  let onRefresh: () -> Void
  let onOpenPr: (String) -> Void

  @State private var mergeMethod: PrMergeMethodOption = .squash
  @State private var orderedPrIds: [String] = []
  @State private var groupMembers: [PrGroupMemberSummary] = []
  @State private var errorMessage: String?

  private var queue: QueueLandingState? {
    queues.first(where: { $0.queueId == queueId })
  }

  private var memberLookup: [String: PrGroupMemberSummary] {
    Dictionary(uniqueKeysWithValues: groupMembers.map { ($0.prId, $0) })
  }

  private var activeEntry: QueueLandingEntry? {
    if let queue, let activePrId = queue.activePrId,
       let entry = queue.entries.first(where: { $0.prId == activePrId }) {
      return entry
    }
    return queue?.entries.first(where: { $0.state != "landed" && $0.state != "skipped" })
  }

  private var orderedEntries: [QueueLandingEntry] {
    guard let queue else { return [] }
    let entriesById = Dictionary(uniqueKeysWithValues: queue.entries.map { ($0.prId, $0) })
    let seededIds = orderedPrIds.isEmpty ? queue.entries.sorted(by: { $0.position < $1.position }).map(\.prId) : orderedPrIds
    return seededIds.compactMap { entriesById[$0] }
  }

  private var supportsQueueAutomation: Bool {
    let actions = [
      "prs.startQueueAutomation",
      "prs.pauseQueueAutomation",
      "prs.resumeQueueAutomation",
      "prs.cancelQueueAutomation",
    ]
    return actions.allSatisfy(syncService.supportsRemoteAction)
  }

  var body: some View {
    List {
      if let errorMessage {
        ADENoticeCard(
          title: "Queue action failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: onRefresh
        )
        .prListRow()
      }

      if let queue {
        PrDetailSectionCard("Queue summary") {
          VStack(alignment: .leading, spacing: 10) {
            Text("Target branch: \(queue.targetBranch ?? "unknown")")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
            Text("Automation state: \(queue.state)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
            if let waitReason = queue.waitReason, !waitReason.isEmpty {
              Text("Waiting on: \(waitReason.replacingOccurrences(of: "_", with: " "))")
                .font(.caption)
                .foregroundStyle(ADEColor.warning)
            }
            if let lastError = queue.lastError, !lastError.isEmpty {
              Text(lastError)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
            }
          }
        }
        .prListRow()

        PrDetailSectionCard("Automation") {
          VStack(alignment: .leading, spacing: 10) {
            Picker("Merge strategy", selection: $mergeMethod) {
              ForEach(PrMergeMethodOption.allCases) { option in
                Text(option.shortTitle).tag(option)
              }
            }
            .pickerStyle(.menu)
            .adeInsetField()

            if let activeEntry {
              Button("Land next") {
                Task { await runAction { _ = try await syncService.landQueueNext(groupId: queue.groupId, method: mergeMethod.rawValue) } }
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
              .disabled(!isLive)

              Button("Open active PR") {
                onOpenPr(activeEntry.prId)
              }
              .buttonStyle(.glass)
            }

            if supportsQueueAutomation {
              HStack(spacing: 10) {
                if queue.state == "landing" {
                  Button("Pause") {
                    Task { await runAction { _ = try await syncService.pauseQueueAutomation(queueId: queue.queueId) } }
                  }
                  .buttonStyle(.glass)
                } else if queue.state == "paused" {
                  Button("Resume") {
                    Task {
                      await runAction {
                        _ = try await syncService.resumeQueueAutomation(
                          queueId: queue.queueId,
                          method: mergeMethod.rawValue,
                          archiveLane: false,
                          autoResolve: queue.config.autoResolve,
                          ciGating: queue.config.ciGating
                        )
                      }
                    }
                  }
                  .buttonStyle(.glass)
                } else {
                  Button("Start automation") {
                    Task {
                      await runAction {
                        _ = try await syncService.startQueueAutomation(
                          groupId: queue.groupId,
                          method: mergeMethod.rawValue,
                          archiveLane: false,
                          autoResolve: queue.config.autoResolve,
                          ciGating: queue.config.ciGating
                        )
                      }
                    }
                  }
                  .buttonStyle(.glass)
                }

                Button("Cancel") {
                  Task { await runAction { _ = try await syncService.cancelQueueAutomation(queueId: queue.queueId) } }
                }
                .buttonStyle(.glass)
                .disabled(!isLive)
              }
            } else {
              Text("Queue automation controls will appear here once the desktop host exposes queue automation actions to mobile sync.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
        }
        .prListRow()

        Section {
          ForEach(orderedEntries) { entry in
            queueMemberCard(entry: entry)
              .prListRow()
          }
          .onMove(perform: moveEntries)
        } header: {
          Text("Members")
        }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(queue?.groupName ?? "Queue")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      EditButton()
    }
    .task(id: queue?.groupId) {
      await loadGroupMembers()
      if let queue {
        orderedPrIds = queue.entries.sorted(by: { $0.position < $1.position }).map(\.prId)
      }
    }
  }

  @ViewBuilder
  private func queueMemberCard(entry: QueueLandingEntry) -> some View {
    let member = memberLookup[entry.prId]
    let snapshot = snapshotsById[entry.prId]

    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        ADEStatusPill(text: "#\(entry.position + 1)", tint: ADEColor.textSecondary)
        VStack(alignment: .leading, spacing: 4) {
          Text(member?.title ?? entry.laneName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("#\(member?.githubPrNumber ?? entry.prNumber ?? 0) · \(member?.headBranch ?? "head") → \(member?.baseBranch ?? (queue?.targetBranch ?? "base"))")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
          Text(entry.state.replacingOccurrences(of: "_", with: " "))
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 6) {
          ADEStatusPill(text: prChecksLabel(snapshot?.status?.checksStatus ?? "none"), tint: prChecksTint(snapshot?.status?.checksStatus ?? "none"))
          ADEStatusPill(text: prReviewLabel(snapshot?.status?.reviewStatus ?? "none"), tint: prReviewTint(snapshot?.status?.reviewStatus ?? "none"))
          ADEStatusPill(
            text: (snapshot?.status?.isMergeable ?? false) ? "MERGEABLE" : "BLOCKED",
            tint: (snapshot?.status?.isMergeable ?? false) ? ADEColor.success : ADEColor.warning
          )
        }
      }

      HStack(spacing: 10) {
        Button("View PR") {
          onOpenPr(entry.prId)
        }
        .buttonStyle(.glass)

        Button("Open lane") {
          syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: entry.laneId)
        }
        .buttonStyle(.glass)

        if let urlString = member?.githubUrl ?? entry.githubUrl, let url = URL(string: urlString) {
          Button("Open on GitHub") {
            UIApplication.shared.open(url)
          }
          .buttonStyle(.glass)
        }

        Button("Rebase") {
          Task { await runAction { try await syncService.startLaneRebase(laneId: entry.laneId, scope: "lane_only") } }
        }
        .buttonStyle(.glass)
        .disabled(!isLive)
      }

      Button("Delete PR", role: .destructive) {
        Task { await runAction { _ = try await syncService.deletePullRequest(prId: entry.prId) } }
      }
      .buttonStyle(.glass)
      .disabled(!isLive)

      if let prState = member?.state, prState == "merged" || entry.state == "landed" {
        PrLaneCleanupBanner(
          laneName: member?.laneName ?? entry.laneName,
          onArchive: {
            Task { await runAction { try await syncService.archiveLane(entry.laneId) } }
          },
          onDeleteBranch: {
            Task { await runAction { try await syncService.deleteLane(entry.laneId, deleteBranch: true, deleteRemoteBranch: true) } }
          }
        )
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }

  private func moveEntries(from source: IndexSet, to destination: Int) {
    guard let queue else { return }
    var ids = orderedPrIds
    ids.move(fromOffsets: source, toOffset: destination)
    orderedPrIds = ids
    Task {
      await runAction {
        try await syncService.reorderQueue(groupId: queue.groupId, prIds: ids)
      }
    }
  }

  @MainActor
  private func loadGroupMembers() async {
    guard let queue else { return }
    groupMembers = (try? await syncService.fetchPullRequestGroupMembers(groupId: queue.groupId)) ?? []
  }

  @MainActor
  private func runAction(_ action: () async throws -> Void) async {
    do {
      try await action()
      errorMessage = nil
      await loadGroupMembers()
      onRefresh()
    } catch {
      errorMessage = SyncUserFacingError.message(for: error)
    }
  }
}

struct PrRebaseDetailView: View {
  @EnvironmentObject private var syncService: SyncService

  let laneId: String
  let prs: [PullRequestListItem]
  let snapshots: [LaneListSnapshot]
  let isLive: Bool
  let onRefresh: () -> Void
  let onOpenPr: (String) -> Void

  @State private var errorMessage: String?

  private var snapshot: LaneListSnapshot? {
    snapshots.first(where: { $0.lane.id == laneId })
  }

  private var linkedPr: PullRequestListItem? {
    prs.first(where: { $0.laneId == laneId })
  }

  var body: some View {
    List {
      if let errorMessage {
        ADENoticeCard(
          title: "Rebase action failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: onRefresh
        )
        .prListRow()
      }

      if let snapshot {
        PrDetailSectionCard("Rebase status") {
          VStack(alignment: .leading, spacing: 10) {
            if let suggestion = snapshot.rebaseSuggestion {
              Text("\(suggestion.behindCount) commits behind parent")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
            }
            Text("Base branch: \(snapshot.lane.baseRef)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
            if let message = snapshot.autoRebaseStatus?.message {
              Text(message)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
            if let conflicts = snapshot.autoRebaseStatus?.conflictCount, conflicts > 0 {
              Text("\(conflicts) conflict file(s) predicted")
                .font(.caption)
                .foregroundStyle(ADEColor.warning)
            }
            if let linkedPr {
              Button("Open linked PR") {
                onOpenPr(linkedPr.id)
              }
              .buttonStyle(.glass)
            }
          }
        }
        .prListRow()

        PrDetailSectionCard("Actions") {
          VStack(alignment: .leading, spacing: 10) {
            Button("Rebase lane") {
              Task { await runAction { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_only") } }
            }
            .buttonStyle(.glassProminent)
            .tint(ADEColor.accent)
            .disabled(!isLive)

            Button("Rebase lane + descendants") {
              Task { await runAction { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_and_descendants") } }
            }
            .buttonStyle(.glass)
            .disabled(!isLive)

            Button("Refresh rebase needs") {
              Task { await runAction { try await syncService.refreshLaneSnapshots() } }
            }
            .buttonStyle(.glass)

            Button("Defer") {
              Task { await runAction { try await syncService.deferRebaseSuggestion(laneId: laneId) } }
            }
            .buttonStyle(.glass)

            Button("Dismiss") {
              Task { await runAction { try await syncService.dismissRebaseSuggestion(laneId: laneId) } }
            }
            .buttonStyle(.glass)
          }
        }
        .prListRow()

      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(snapshot?.lane.name ?? "Rebase")
    .navigationBarTitleDisplayMode(.inline)
  }

  @MainActor
  private func runAction(_ action: () async throws -> Void) async {
    do {
      try await action()
      errorMessage = nil
      onRefresh()
    } catch {
      errorMessage = SyncUserFacingError.message(for: error)
    }
  }
}
