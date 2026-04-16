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

/// Unified workflow card driven by the `PrMobileSnapshot.workflowCards` payload. Dispatches on
/// `card.kind` ("queue" | "integration" | "rebase") so a single ForEach over the snapshot's cards
/// can render all three surfaces without separate legacy fetch fan-out.
struct PrMobileWorkflowCardView: View {
  let card: PrWorkflowCard
  let isLive: Bool
  let onOpenPr: (String) -> Void
  let onLand: (String, PrMergeMethodOption) -> Void
  let onRebaseLane: (String) -> Void
  let onDeferRebase: (String) -> Void
  let onDismissRebase: (String) -> Void

  @State private var mergeMethod: PrMergeMethodOption = .squash

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      switch card.kind {
      case "queue": queueSection
      case "integration": integrationSection
      case "rebase": rebaseSection
      default: unknownSection
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }

  @ViewBuilder
  private var queueSection: some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Text(card.groupName.nonEmpty ?? "Queue workflow")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          // Inline position chip next to the title so users see progress
          // at a glance instead of after the action buttons.
          if let position = card.currentPosition, let total = card.totalEntries, total > 0 {
            ADEStatusPill(text: "\(position + 1)/\(total)", tint: ADEColor.textMuted)
          }
        }
        if let targetBranch = card.targetBranch {
          Text("Target: \(targetBranch)")
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      Spacer(minLength: 8)
      if let state = card.state {
        ADEStatusPill(text: state.uppercased(), tint: state == "completed" ? ADEColor.success : ADEColor.warning)
      }
    }

    if let waitReason = card.waitReason.nonEmpty {
      Text("Waiting on \(waitReason)")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }

    if let lastError = card.lastError.nonEmpty {
      Text(lastError)
        .font(.caption)
        .foregroundStyle(ADEColor.danger)
    }

    if let activePrId = card.activePrId {
      Picker("Merge strategy", selection: $mergeMethod) {
        ForEach(PrMergeMethodOption.allCases) { option in
          Text(option.shortTitle).tag(option)
        }
      }
      .pickerStyle(.menu)
      .adeInsetField()

      HStack(spacing: 10) {
        Button("Land active PR") {
          onLand(activePrId, mergeMethod)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(!isLive)

        Button("Open") {
          onOpenPr(activePrId)
        }
        .buttonStyle(.glass)
      }
    }
  }

  @ViewBuilder
  private var integrationSection: some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(alignment: .leading, spacing: 4) {
        Text(card.title.nonEmpty ?? "Integration workflow")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        if let baseBranch = card.baseBranch {
          Text("Base: \(baseBranch)")
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      Spacer(minLength: 8)
      if let outcome = card.overallOutcome {
        ADEStatusPill(text: outcome.uppercased(), tint: outcome == "clean" ? ADEColor.success : ADEColor.warning)
      }
    }

    HStack(spacing: 6) {
      if let status = card.integrationStatus {
        ADEStatusPill(text: status.uppercased(), tint: ADEColor.accent)
      }
      if let workflowDisplayState = card.workflowDisplayState {
        ADEStatusPill(text: workflowDisplayState.uppercased(), tint: ADEColor.textSecondary)
      }
      if let cleanupState = card.cleanupState {
        ADEStatusPill(text: cleanupState.uppercased(), tint: ADEColor.warning)
      }
    }

    if let laneCount = card.laneCount {
      let conflictSegment = card.conflictLaneCount.map { " · \($0) conflict\($0 == 1 ? "" : "s")" } ?? ""
      Text("\(laneCount) lane\(laneCount == 1 ? "" : "s")\(conflictSegment)")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }

    // Larger, prominent tap target so users immediately see the PR escape
    // hatch. Uses the prominent glass button style to separate it from the
    // passive status pills above.
    if let linkedPrId = card.linkedPrId {
      Button {
        onOpenPr(linkedPrId)
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "arrow.up.right.square.fill")
          Text("Open linked PR")
        }
        .frame(maxWidth: .infinity)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
    }
  }

  @ViewBuilder
  private var rebaseSection: some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(alignment: .leading, spacing: 4) {
        Text(card.laneName.nonEmpty ?? "Rebase suggestion")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        if let behindBy = card.behindBy {
          Text("Behind parent by \(behindBy) commit\(behindBy == 1 ? "" : "s")")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      Spacer(minLength: 8)
      if card.conflictPredicted == true {
        // Solid red badge — a predicted conflict is a blocker the user
        // must see before they tap Rebase, so it gets stronger contrast
        // than the other tinted pills on this card.
        PrConflictBadge()
      }
    }

    if let deferredUntil = card.deferredUntil {
      Text("Deferred until \(prAbsoluteTime(deferredUntil))")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
    }

    HStack(spacing: 10) {
      if let laneId = card.laneId {
        Button("Rebase") { onRebaseLane(laneId) }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.accent)
          .disabled(!isLive)

        Button("Defer") { onDeferRebase(laneId) }
          .buttonStyle(.glass)
          .disabled(!isLive)

        Button("Dismiss") { onDismissRebase(laneId) }
          .buttonStyle(.glass)
          .tint(ADEColor.textSecondary)
          .disabled(!isLive)
      }

      if let prId = card.prId {
        Spacer(minLength: 0)
        Button("Open PR") { onOpenPr(prId) }
          .buttonStyle(.glass)
      }
    }
  }

  @ViewBuilder
  private var unknownSection: some View {
    Text("Unsupported workflow card kind: \(card.kind)")
      .font(.caption)
      .foregroundStyle(ADEColor.textMuted)
  }
}

private extension Optional where Wrapped == String {
  var nonEmpty: String? {
    switch self {
    case .some(let value) where !value.isEmpty: return value
    default: return nil
    }
  }
}

/// High-contrast solid badge used when a rebase or integration would
/// collide. Stronger visual weight than ADEStatusPill (which only tints)
/// so a predicted conflict can't be glanced past.
struct PrConflictBadge: View {
  var text: String = "CONFLICT"

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "exclamationmark.triangle.fill")
      Text(text)
    }
    .font(.system(.caption2, design: .monospaced).weight(.bold))
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .foregroundStyle(Color.white)
    .background(ADEColor.danger, in: Capsule())
    .accessibilityLabel("Warning: \(text)")
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
