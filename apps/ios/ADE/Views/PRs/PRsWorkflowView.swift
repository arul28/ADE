import SwiftUI
import UIKit

struct PrWorkflowsSurfaceView: View {
  @EnvironmentObject private var syncService: SyncService

  @Binding var workflowCategory: PrWorkflowCategory
  @Binding var workflowView: PrWorkflowView
  @Binding var integrationPath: NavigationPath
  @Binding var queuePath: NavigationPath
  @Binding var rebasePath: NavigationPath
  let prs: [PullRequestListItem]
  let snapshotsById: [String: PullRequestSnapshot]
  let collections: PrWorkflowCollections
  let laneSnapshots: [LaneListSnapshot]
  let isLive: Bool
  let statusNotice: ADENoticeCard?
  let errorMessage: String?
  let onRefresh: () -> Void
  let onOpenPr: (String) -> Void

  private var categoryCounts: [PrWorkflowCategory: Int] {
    [
      .integration: collections.integrations.count,
      .queue: collections.queues.count,
      .rebase: collections.rebaseItems.count,
    ]
  }

  var body: some View {
    VStack(spacing: 12) {
      Picker("Workflow category", selection: $workflowCategory) {
        ForEach(PrWorkflowCategory.allCases) { category in
          Text("\(category.title) \(categoryCounts[category] ?? 0)").tag(category)
        }
      }
      .pickerStyle(.segmented)
      .padding(.horizontal, 16)

      Picker("Workflow view", selection: $workflowView) {
        ForEach(PrWorkflowView.allCases) { view in
          Text(view.title).tag(view)
        }
      }
      .pickerStyle(.segmented)
      .padding(.horizontal, 16)

      switch workflowCategory {
      case .integration:
        NavigationStack(path: $integrationPath) {
          workflowList(title: "Integration", count: categoryCounts[.integration] ?? 0) {
            if collections.integrations.isEmpty {
              workflowEmptyState(title: workflowView == .active ? "No active integrations" : "No integration history")
            } else {
              ForEach(collections.integrations) { proposal in
                NavigationLink(value: PrIntegrationRoute.detail(proposal.proposalId)) {
                  IntegrationWorkflowCard(proposal: proposal)
                }
                .buttonStyle(.plain)
                .prListRow()
              }
            }
          }
          .navigationDestination(for: PrIntegrationRoute.self) { route in
            switch route {
            case .detail(let proposalId):
              PrIntegrationDetailView(
                proposalId: proposalId,
                proposals: collections.integrations,
                isLive: isLive,
                onRefresh: onRefresh,
                onOpenPr: onOpenPr
              )
              .environmentObject(syncService)
            }
          }
        }
      case .queue:
        NavigationStack(path: $queuePath) {
          workflowList(title: "Queue", count: categoryCounts[.queue] ?? 0) {
            if collections.queues.isEmpty {
              workflowEmptyState(title: workflowView == .active ? "No active queues" : "No queue history")
            } else {
              ForEach(collections.queues) { queueState in
                NavigationLink(value: PrQueueRoute.detail(queueState.queueId)) {
                  QueueWorkflowCard(queueState: queueState)
                }
                .buttonStyle(.plain)
                .prListRow()
              }
            }
          }
          .navigationDestination(for: PrQueueRoute.self) { route in
            switch route {
            case .detail(let queueId):
              PrQueueDetailView(
                queueId: queueId,
                queues: collections.queues,
                snapshotsById: snapshotsById,
                isLive: isLive,
                onRefresh: onRefresh,
                onOpenPr: onOpenPr
              )
                .environmentObject(syncService)
            }
          }
        }
      case .rebase:
        NavigationStack(path: $rebasePath) {
          workflowList(title: "Rebase", count: categoryCounts[.rebase] ?? 0) {
            if collections.rebaseItems.isEmpty {
              workflowEmptyState(title: workflowView == .active ? "No active rebase work" : "No rebase history")
            } else {
              ForEach(collections.rebaseItems) { item in
                NavigationLink(value: PrRebaseRoute.detail(item.laneId)) {
                  RebaseWorkflowCard(item: item)
                }
                .buttonStyle(.plain)
                .prListRow()
              }
            }
          }
          .navigationDestination(for: PrRebaseRoute.self) { route in
            switch route {
            case .detail(let laneId):
              PrRebaseDetailView(
                laneId: laneId,
                prs: prs,
                snapshots: laneSnapshots,
                isLive: isLive,
                onRefresh: onRefresh,
                onOpenPr: onOpenPr
              )
              .environmentObject(syncService)
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private func workflowList<Content: View>(title: String, count: Int, @ViewBuilder content: () -> Content) -> some View {
    List {
      if let statusNotice {
        statusNotice.prListRow()
      }

      PrDetailSectionCard(title) {
        HStack {
          VStack(alignment: .leading, spacing: 4) {
            Text("\(workflowView.title) workflows")
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
            Text("\(count) \(title.lowercased()) item\(count == 1 ? "" : "s")")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          Spacer(minLength: 8)
          Button {
            onRefresh()
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .buttonStyle(.glass)
          .tint(ADEColor.accent)
        }
      }
      .prListRow()

      if let errorMessage {
        ADENoticeCard(
          title: "Workflow view error",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: onRefresh
        )
        .prListRow()
      }

      content()
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle("PRs")
    .navigationBarTitleDisplayMode(.inline)
    .refreshable {
      onRefresh()
    }
  }

  @ViewBuilder
  private func workflowEmptyState(title: String) -> some View {
    ADEEmptyStateView(
      symbol: "square.stack.3d.up.slash",
      title: title,
      message: "Switch views or refresh after the host syncs workflow state."
    )
    .prListRow()
  }
}

private struct IntegrationWorkflowCard: View {
  let proposal: IntegrationProposal

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(proposal.title?.isEmpty == false ? proposal.title! : (proposal.integrationLaneName?.isEmpty == false ? proposal.integrationLaneName! : "Integration workflow"))
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("Base branch: \(proposal.baseBranch)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        ADEStatusPill(text: proposal.status.uppercased(), tint: proposal.workflowDisplayState == "history" ? ADEColor.textSecondary : ADEColor.accent)
      }

      HStack(spacing: 8) {
        ADEStatusPill(text: proposal.overallOutcome.uppercased(), tint: proposal.overallOutcome == "clean" ? ADEColor.success : ADEColor.warning)
        if let cleanupState = proposal.cleanupState {
          ADEStatusPill(text: cleanupState.uppercased(), tint: ADEColor.warning)
        }
      }

      Text("\(proposal.steps.count) steps · \(proposal.laneSummaries.count) lanes")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct QueueWorkflowCard: View {
  let queueState: QueueLandingState

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(queueState.groupName ?? "Queue workflow")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("Target branch: \(queueState.targetBranch ?? "unknown")")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        ADEStatusPill(text: queueState.state.uppercased(), tint: queueState.state == "completed" ? ADEColor.success : ADEColor.warning)
      }

      Text("\(queueState.entries.count) member\(queueState.entries.count == 1 ? "" : "s")")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct RebaseWorkflowCard: View {
  let item: PrRebaseWorkflowItem

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(item.laneName)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text(item.branchRef)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        ADEStatusPill(text: item.severity.uppercased(), tint: item.severity == "critical" ? ADEColor.danger : item.severity == "warning" ? ADEColor.warning : ADEColor.textSecondary)
      }

      Text(item.statusMessage)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}
