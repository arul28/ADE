import SwiftUI

struct IntegrationWorkflowCard: View {
  let proposal: IntegrationProposal
  let onOpenPr: (String) -> Void

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
        ADEStatusPill(text: proposal.overallOutcome.uppercased(), tint: proposal.overallOutcome == "clean" ? ADEColor.success : ADEColor.warning)
      }

      HStack(spacing: 8) {
        ADEStatusPill(text: proposal.status.uppercased(), tint: ADEColor.accent)
        if let workflowDisplayState = proposal.workflowDisplayState {
          ADEStatusPill(text: workflowDisplayState.uppercased(), tint: ADEColor.textSecondary)
        }
        if let cleanupState = proposal.cleanupState {
          ADEStatusPill(text: cleanupState.uppercased(), tint: ADEColor.warning)
        }
      }

      Text("\(proposal.steps.count) steps · \(proposal.laneSummaries.count) lanes")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)

      if !proposal.steps.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(proposal.steps.prefix(3)) { step in
            Text("\(step.position + 1). \(step.laneName) · \(step.outcome)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }

      if let linkedPrId = proposal.linkedPrId {
        Button("Open linked PR") {
          onOpenPr(linkedPrId)
        }
        .buttonStyle(.glass)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct QueueWorkflowCard: View {
  let queueState: QueueLandingState
  let isLive: Bool
  let onOpenPr: (String) -> Void
  let onLand: (String, PrMergeMethodOption) -> Void
  let onRebaseLane: (String) -> Void
  @State private var mergeMethod: PrMergeMethodOption = .squash

  private var activeEntry: QueueLandingEntry? {
    if let activePrId = queueState.activePrId,
       let entry = queueState.entries.first(where: { $0.prId == activePrId }) {
      return entry
    }
    return queueState.entries.first(where: { $0.state != "landed" && $0.state != "skipped" })
  }

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

      if let waitReason = queueState.waitReason, !waitReason.isEmpty {
        Text("Waiting on: \(waitReason)")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }

      if let lastError = queueState.lastError, !lastError.isEmpty {
        Text(lastError)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
      }

      if let activeEntry {
        Picker("Merge strategy", selection: $mergeMethod) {
          ForEach(PrMergeMethodOption.allCases) { option in
            Text(option.shortTitle).tag(option)
          }
        }
        .pickerStyle(.menu)
        .adeInsetField()

        Button("Land active PR") {
          onLand(activeEntry.prId, mergeMethod)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(!isLive)
      }

      VStack(alignment: .leading, spacing: 8) {
        ForEach(queueState.entries.sorted(by: { $0.position < $1.position })) { entry in
          HStack(alignment: .top, spacing: 10) {
            ADEStatusPill(text: "#\(entry.position + 1)", tint: ADEColor.textSecondary)
            VStack(alignment: .leading, spacing: 4) {
              Text(entry.laneName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              Text(entry.state.replacingOccurrences(of: "_", with: " "))
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
            Spacer(minLength: 8)
            if let prNumber = entry.prNumber {
              Button("#\(prNumber)") {
                onOpenPr(entry.prId)
              }
              .buttonStyle(.glass)
            }
            Button("Rebase") {
              onRebaseLane(entry.laneId)
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct RebaseWorkflowCard: View {
  let item: PrRebaseWorkflowItem
  let onRebase: () -> Void
  let onDefer: () -> Void
  let onDismiss: () -> Void

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
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)

      if let deferredUntil = item.deferredUntil {
        Text("Deferred until \(prAbsoluteTime(deferredUntil))")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 10) {
        Button("Rebase") {
          onRebase()
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)

        Button("Defer") {
          onDefer()
        }
        .buttonStyle(.glass)

        Button("Dismiss") {
          onDismiss()
        }
        .buttonStyle(.glass)
        .tint(ADEColor.textSecondary)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}
