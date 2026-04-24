import SwiftUI

private enum WorkflowLandingConfirmation {
  case activePr(prId: String)
  case queueNext(groupId: String, prId: String)

  var title: String {
    switch self {
    case .activePr:
      return "Land active PR?"
    case .queueNext:
      return "Land queue next?"
    }
  }

  var actionTitle: String {
    switch self {
    case .activePr:
      return "Land active PR"
    case .queueNext:
      return "Land queue next"
    }
  }

  var message: String {
    switch self {
    case .activePr:
      return "This asks the host to merge the active queue pull request using the selected strategy. GitHub may merge into the target branch if checks pass."
    case .queueNext:
      return "This asks the host to merge the next queued pull request using the selected strategy. GitHub may merge into the target branch if checks pass."
    }
  }
}

// MARK: - Legacy cards (unchanged surface, lightly restyled)

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
  @State private var landingConfirmation: WorkflowLandingConfirmation?

  private var landingConfirmationPresented: Binding<Bool> {
    Binding(
      get: { landingConfirmation != nil },
      set: { presented in
        if !presented { landingConfirmation = nil }
      }
    )
  }

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
          landingConfirmation = .activePr(prId: activeEntry.prId)
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
    .confirmationDialog(
      landingConfirmation?.title ?? "Land workflow",
      isPresented: landingConfirmationPresented,
      titleVisibility: .visible
    ) {
      if let landingConfirmation {
        Button(landingConfirmation.actionTitle, role: .destructive) {
          performLandingConfirmation(landingConfirmation)
        }
      }
      Button("Cancel", role: .cancel) {
        landingConfirmation = nil
      }
    } message: {
      Text(landingConfirmation?.message ?? "This will ask the host to merge the selected pull request.")
    }
  }

  private func performLandingConfirmation(_ confirmation: WorkflowLandingConfirmation) {
    landingConfirmation = nil
    switch confirmation {
    case .activePr(let capturedPrId):
      // Guard against a stale snapshot: the active PR may have changed while
      // the confirmation dialog was visible. Only dispatch if the card still
      // points at the same PR the user approved.
      guard let currentActivePrId = activeEntry?.prId,
            currentActivePrId == capturedPrId else {
        return
      }
      onLand(capturedPrId, mergeMethod)
    case .queueNext:
      assertionFailure("QueueWorkflowCard does not support queueNext landing")
    }
  }
}

// MARK: - Unified workflow card

/// Unified workflow card driven by the `PrMobileSnapshot.workflowCards` payload. Dispatches on
/// `card.kind` ("queue" | "integration" | "rebase") so a single ForEach over the snapshot's cards
/// can render all three surfaces without separate legacy fetch fan-out.
///
/// NOTE: Init signature must be preserved — callers in `PrsRootScreen` pass every callback
/// positionally by name.
struct PrMobileWorkflowCardView: View {
  let card: PrWorkflowCard
  let isLive: Bool
  let onOpenPr: (String) -> Void
  let onLand: (String, PrMergeMethodOption) -> Void
  let onLandQueueNext: (String, PrMergeMethodOption) -> Void
  let onPauseQueue: (String) -> Void
  let onResumeQueue: (String, PrMergeMethodOption) -> Void
  let onCancelQueue: (String) -> Void
  let onReorderQueue: (String, [String]) -> Void
  let onCreateIntegrationLane: (String) -> Void
  let onDeleteIntegrationProposal: (String) -> Void
  let onDismissIntegrationCleanup: (String) -> Void
  let onCleanupIntegrationWorkflow: (String, [String]) -> Void
  let onResolveIntegrationLane: (String, String) -> Void
  let onRecheckIntegrationLane: (String, String) -> Void
  let onRebaseLane: (String) -> Void
  let onDeferRebase: (String) -> Void
  let onDismissRebase: (String) -> Void

  @State private var mergeMethod: PrMergeMethodOption = .squash
  @State private var landingConfirmation: WorkflowLandingConfirmation?

  private var queueId: String? {
    card.queueId.nonEmpty ?? (card.id.hasPrefix("queue:") ? String(card.id.dropFirst("queue:".count)) : nil)
  }

  private var nextQueueEntry: QueueLandingEntry? {
    card.entries?
      .sorted(by: { $0.position < $1.position })
      .first { entry in
        let state = entry.state.lowercased()
        return state == "open" || state == "draft"
      }
  }

  private var landingConfirmationPresented: Binding<Bool> {
    Binding(
      get: { landingConfirmation != nil },
      set: { presented in
        if !presented { landingConfirmation = nil }
      }
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      switch card.kind {
      case "queue": queueSection
      case "integration": integrationSection
      case "rebase": rebaseSection
      default: unknownSection
      }
    }
    .adeGlassCard(cornerRadius: 18)
    .confirmationDialog(
      landingConfirmation?.title ?? "Land workflow",
      isPresented: landingConfirmationPresented,
      titleVisibility: .visible
    ) {
      if let landingConfirmation {
        Button(landingConfirmation.actionTitle, role: .destructive) {
          performLandingConfirmation(landingConfirmation)
        }
      }
      Button("Cancel", role: .cancel) {
        landingConfirmation = nil
      }
    } message: {
      Text(landingConfirmation?.message ?? "This will ask the host to merge the selected pull request.")
    }
  }

  // MARK: Queue

  @ViewBuilder
  private var queueSection: some View {
    // Violet banner for running / healthy queues.
    let isRunning = (card.state == "landing" || card.state == "running" || card.state == "active" || card.state == "in_progress")

    if isRunning {
      WkQueueBanner(
        title: card.groupName.nonEmpty ?? "Merge queue",
        target: card.targetBranch,
        waitReason: card.waitReason,
        state: card.state ?? "running"
      )
    }

    HStack(alignment: .top, spacing: 10) {
      VStack(alignment: .leading, spacing: 4) {
        PrEyebrow(text: "QUEUE WORKFLOW")
        HStack(spacing: 6) {
          Text(card.groupName.nonEmpty ?? "Queue workflow")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          if let position = card.currentPosition, let total = card.totalEntries, total > 0 {
            ADEStatusPill(text: "\(position + 1)/\(total)", tint: ADEColor.textMuted)
          }
        }
        if let targetBranch = card.targetBranch {
          Text(targetBranch)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      Spacer(minLength: 8)
      if let state = card.state {
        ADEStatusPill(text: state.uppercased(), tint: state == "completed" ? ADEColor.success : (state == "paused" ? ADEColor.warning : ADEColor.accent))
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
          landingConfirmation = .activePr(prId: activePrId)
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

    // Queue order list — restyled to mirror the mock's position tile + state pill rows.
    if let entries = card.entries?.sorted(by: { $0.position < $1.position }), !entries.isEmpty {
      PrSectionHdr(title: "Queue order") {
        Text("\(entries.count) in queue")
      }
      VStack(spacing: 0) {
        ForEach(Array(entries.enumerated()), id: \.element.prId) { index, entry in
          WkQueueRow(
            index: index,
            entry: entry,
            isActive: entry.prId == card.activePrId,
            isLive: isLive,
            isFirst: index == 0,
            isLast: index == entries.count - 1,
            onOpenPr: { onOpenPr(entry.prId) },
            onMoveUp: { reorder(entries: entries, from: index, to: max(0, index - 1)) },
            onMoveDown: { reorder(entries: entries, from: index, to: min(entries.count - 1, index + 1)) },
            freezeOrder: card.state == "landing"
          )
          if index < entries.count - 1 {
            Divider().overlay(ADEColor.textMuted.opacity(0.15))
          }
        }
      }
      .padding(.vertical, 2)
      .background(ADEColor.textPrimary.opacity(0.02), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    if let groupId = card.groupId {
      let nextPrId = nextQueueEntry?.prId
      Button {
        if let nextPrId {
          landingConfirmation = .queueNext(groupId: groupId, prId: nextPrId)
        }
      } label: {
        Label("Land queue next", systemImage: "arrow.forward.to.line")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.glass)
      .disabled(!isLive || nextPrId == nil)
    }

    if let queueId {
      HStack(spacing: 10) {
        if card.state == "paused" {
          Button("Resume") { onResumeQueue(queueId, mergeMethod) }
            .buttonStyle(.glass)
            .disabled(!isLive)
        } else {
          Button("Pause") { onPauseQueue(queueId) }
            .buttonStyle(.glass)
            .disabled(!isLive)
        }

        Button("Cancel", role: .destructive) { onCancelQueue(queueId) }
          .buttonStyle(.glass)
          .disabled(!isLive)
      }
    }

    // Recently merged — derived from entries in "landed" state. Hides when none.
    if let entries = card.entries?.filter({ $0.state == "landed" }), !entries.isEmpty {
      PrSectionHdr(title: "Recently merged") {
        Text("last 24h")
      }
      VStack(spacing: 0) {
        ForEach(Array(entries.enumerated()), id: \.element.prId) { index, entry in
          WkMergedRow(entry: entry)
          if index < entries.count - 1 {
            Divider().overlay(ADEColor.textMuted.opacity(0.15))
          }
        }
      }
      .padding(.vertical, 2)
      .background(ADEColor.textPrimary.opacity(0.02), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }

  private func reorder(entries: [QueueLandingEntry], from sourceIndex: Int, to targetIndex: Int) {
    guard let groupId = card.groupId, sourceIndex != targetIndex else { return }
    var ordered = entries.map(\.prId)
    let moving = ordered.remove(at: sourceIndex)
    ordered.insert(moving, at: targetIndex)
    onReorderQueue(groupId, ordered)
  }

  private func performLandingConfirmation(_ confirmation: WorkflowLandingConfirmation) {
    landingConfirmation = nil
    switch confirmation {
    case .activePr(let capturedPrId):
      // If the active PR changed while the dialog was open, don't act on a
      // stale id — the user approved a different PR than the one now active.
      guard let currentActivePrId = card.activePrId, currentActivePrId == capturedPrId else {
        return
      }
      onLand(capturedPrId, mergeMethod)
    case .queueNext(let capturedGroupId, let capturedPrId):
      guard card.groupId == capturedGroupId,
            nextQueueEntry?.prId == capturedPrId else { return }
      onLandQueueNext(capturedGroupId, mergeMethod)
    }
  }

  // MARK: Integration

  @ViewBuilder
  private var integrationSection: some View {
    let readyCount = (card.laneCount ?? 0) - (card.conflictLaneCount ?? 0)
    let totalCount = card.laneCount ?? 0

    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        PrTagChip(label: "integration", color: ADEColor.warning)
        if totalCount > 0 {
          ADEStatusPill(text: "\(readyCount) of \(totalCount) ready", tint: readyCount == totalCount ? ADEColor.success : ADEColor.warning)
        }
      }
      Text(card.title.nonEmpty ?? "Integration workflow")
        .font(.title3.weight(.bold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)

      // Mono subtitle: integration-lane → base · N children · M commits-ish summary.
      let childrenPart = totalCount > 0 ? " · \(totalCount) child\(totalCount == 1 ? "" : "ren")" : ""
      let conflictPart = (card.conflictLaneCount ?? 0) > 0 ? " · \(card.conflictLaneCount!) conflict\((card.conflictLaneCount ?? 0) == 1 ? "" : "s")" : ""
      let base = card.baseBranch ?? "main"
      let head = card.title.nonEmpty ?? "integration"
      Text("\(head) → \(base)\(childrenPart)\(conflictPart)")
        .font(.caption.monospaced())
        .foregroundStyle(ADEColor.textSecondary)
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
      Spacer(minLength: 0)
      if let outcome = card.overallOutcome {
        ADEStatusPill(text: outcome.uppercased(), tint: outcome == "clean" ? ADEColor.success : ADEColor.warning)
      }
    }

    if let lanes = card.lanes, !lanes.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(lanes.prefix(6)) { lane in
          HStack(spacing: 10) {
            ADEStatusPill(
              text: lane.outcome.replacingOccurrences(of: "_", with: " ").uppercased(),
              tint: lane.outcome == "clean" ? ADEColor.success : ADEColor.warning
            )
            VStack(alignment: .leading, spacing: 2) {
              Text(lane.laneName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              Text(lane.laneId)
                .font(.caption2.monospaced())
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
            Spacer(minLength: 0)
            if lane.outcome != "clean", let proposalId = card.proposalId {
              Menu {
                Button("Resolve conflicts") { onResolveIntegrationLane(proposalId, lane.laneId) }
                Button("Recheck") { onRecheckIntegrationLane(proposalId, lane.laneId) }
              } label: {
                Image(systemName: "ellipsis.circle")
                  .frame(width: 32, height: 32)
              }
              .buttonStyle(.glass)
              .disabled(!isLive)
            }
          }
        }
      }
    }

    // Big tappable "Open stack" CTA that jumps to the linked PR (parent wires
    // stackPresentation off the PR row; this is the closest proxy without
    // widening the view's public callback list).
    if let linkedPrId = card.linkedPrId {
      Button {
        onOpenPr(linkedPrId)
      } label: {
        HStack(spacing: 8) {
          Image(systemName: "rectangle.stack.fill")
          Text("Open stack")
          Spacer(minLength: 0)
          Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
    }

    if let proposalId = card.proposalId {
      HStack(spacing: 10) {
        Button(card.integrationLaneId == nil ? "Create lane" : "Refresh lane") {
          onCreateIntegrationLane(proposalId)
        }
        .buttonStyle(.glass)
        .disabled(!isLive)

        Button("Delete", role: .destructive) {
          onDeleteIntegrationProposal(proposalId)
        }
        .buttonStyle(.glass)
        .disabled(!isLive)
      }

      if card.cleanupState == "required" || card.cleanupState == "declined" {
        HStack(spacing: 10) {
          Button {
            onCleanupIntegrationWorkflow(proposalId, card.lanes?.map(\.laneId) ?? [])
          } label: {
            Label("Clean up lanes", systemImage: "archivebox")
          }
          .buttonStyle(.glass)
          .disabled(!isLive)

          Button {
            onDismissIntegrationCleanup(proposalId)
          } label: {
            Label("Not now", systemImage: "clock")
          }
          .buttonStyle(.glass)
          .disabled(!isLive)
        }
      }
    }

    // Queue config row-list. Rendered opportunistically from whatever surrogate
    // fields are present on the card; hidden entirely when empty.
    let cfg = wkIntegrationConfigRows(card: card)
    if !cfg.isEmpty {
      PrSectionHdr(title: "Queue config")
      VStack(spacing: 0) {
        ForEach(Array(cfg.enumerated()), id: \.element.label) { index, row in
          WkConfigRow(label: row.label, value: row.value)
          if index < cfg.count - 1 {
            Divider().overlay(ADEColor.textMuted.opacity(0.15))
          }
        }
      }
      .padding(.vertical, 2)
      .background(ADEColor.textPrimary.opacity(0.02), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }

  // MARK: Rebase

  @ViewBuilder
  private var rebaseSection: some View {
    // Default to "auto" when older hosts omit the field. `manual` → PR was
    // opened with lane_base strategy so auto-rebase is suppressed and the
    // user has to trigger it by hand.
    let isManual = (card.rebaseMode == "manual")
    let tintForMode: Color = isManual ? ADEColor.tintPRs : ADEColor.warning
    let pillLabel = isManual ? "manual rebase" : "rebase needed"
    let rebaseButtonLabel = isManual ? "Rebase now" : "Rebase"

    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        if let prNumber = card.prNumber {
          Text("#\(prNumber)")
            .font(.system(.caption, design: .monospaced).weight(.bold))
            .foregroundStyle(tintForMode)
        }
        ADEStatusPill(text: pillLabel, tint: tintForMode)
        PrTagChip(label: "lane", color: ADEColor.tintFiles)
        Spacer(minLength: 0)
        if card.conflictPredicted == true {
          PrConflictBadge()
        }
      }
      Text(card.laneName.nonEmpty ?? "Rebase suggestion")
        .font(.title3.weight(.bold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
      if let behindBy = card.behindBy {
        Text("\(behindBy) commit\(behindBy == 1 ? "" : "s") behind target")
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
      }
      // Mode-specific explainer copy.
      Text(
        isManual
          ? "PR carries immutable base — drift detected. Rebase manually."
          : "Auto-rebase pending — target has moved."
      )
      .font(.caption)
      .foregroundStyle(ADEColor.textSecondary)
    }

    if let deferredUntil = card.deferredUntil {
      Text("Deferred until \(prAbsoluteTime(deferredUntil))")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
    }

    // Tappable link to the new rebase screen.
    if let laneId = card.laneId {
      NavigationLink {
        PrRebaseScreen(
          laneId: laneId,
          laneName: card.laneName.nonEmpty,
          prNumber: card.prNumber,
          prId: card.prId,
          behindCount: card.behindBy ?? 0,
          conflictPredicted: card.conflictPredicted ?? false,
          branchRef: nil,
          baseBranch: nil,
          targetCommits: card.targetCommits,
          rebaseMode: card.rebaseMode,
          creationStrategy: card.creationStrategy
        )
      } label: {
        HStack(spacing: 8) {
          Image(systemName: "chart.bar.doc.horizontal")
          Text("Inspect drift")
          Spacer(minLength: 0)
          Image(systemName: "chevron.right").font(.caption.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
    }

    HStack(spacing: 10) {
      if let laneId = card.laneId {
        Button(rebaseButtonLabel) { onRebaseLane(laneId) }
          .buttonStyle(.glass)
          .disabled(!isLive)

        Button("Defer") { onDeferRebase(laneId) }
          .buttonStyle(.glass)
          .disabled(!isLive)

        Button("Dismiss") { onDismissRebase(laneId) }
          .buttonStyle(.glass)
          .tint(ADEColor.textSecondary)
          .disabled(!isLive)
      }

      Spacer(minLength: 0)

      if let prId = card.prId {
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

// MARK: - Private styling helpers
// Scoped to this file — shared public helpers (PrSectionHdr, PrTagChip, ...)
// are being introduced by the foundation workstream; this file stays
// self-contained so it compiles independently.

private struct WkPulseDot: View {
  let color: Color
  @State private var pulse = false
  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 6, height: 6)
      .opacity(pulse ? 0.4 : 1.0)
      .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: pulse)
      .onAppear { pulse = true }
  }
}

private struct WkStatePill: View {
  let state: String
  var body: some View {
    let (color, pulse, label) = wkStateInfo(for: state)
    HStack(spacing: 4) {
      if pulse {
        WkPulseDot(color: color)
      }
      Text(label.uppercased())
        .font(.system(.caption2, design: .monospaced).weight(.bold))
        .tracking(0.8)
    }
    .padding(.horizontal, 7)
    .padding(.vertical, 3)
    .foregroundStyle(color)
    .background(color.opacity(0.14), in: Capsule())
  }
}

private func wkStateInfo(for state: String) -> (Color, Bool, String) {
  switch state {
  case "running", "landing", "in_progress", "active":
    return (ADEColor.accent, true, "running")
  case "queued", "waiting":
    return (ADEColor.warning, false, "queued")
  case "landed", "merged", "completed":
    return (ADEColor.success, false, "landed")
  case "skipped", "cancelled":
    return (ADEColor.textSecondary, false, "skipped")
  case "paused":
    return (ADEColor.warning, false, "paused")
  default:
    return (ADEColor.textSecondary, false, state)
  }
}

private struct WkQueueBanner: View {
  let title: String
  let target: String?
  let waitReason: String?
  let state: String

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(ADEColor.accent.opacity(0.18))
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(ADEColor.accent.opacity(0.4), lineWidth: 0.5)
        Image(systemName: "arrow.triangle.swap")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
      }
      .frame(width: 36, height: 36)

      VStack(alignment: .leading, spacing: 2) {
        Text("\(title) · \(target ?? "main")")
          .font(.system(.caption, design: .default).weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(waitReason ?? "processing · auto-rebase on")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      ADEStatusPill(text: "healthy", tint: ADEColor.success)
    }
    .padding(10)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(ADEColor.accent.opacity(0.08))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(ADEColor.accent.opacity(0.25), lineWidth: 0.5)
    )
  }
}

private struct WkQueueRow: View {
  let index: Int
  let entry: QueueLandingEntry
  let isActive: Bool
  let isLive: Bool
  let isFirst: Bool
  let isLast: Bool
  let onOpenPr: () -> Void
  let onMoveUp: () -> Void
  let onMoveDown: () -> Void
  let freezeOrder: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      // Position tile
      Text("\(index + 1)")
        .font(.system(.callout, design: .default).weight(.heavy))
        .foregroundStyle(isActive ? ADEColor.accent : ADEColor.textSecondary)
        .frame(width: 30, height: 30)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(ADEColor.textPrimary.opacity(0.04))
        )
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(isActive ? ADEColor.accent.opacity(0.4) : ADEColor.textMuted.opacity(0.15), lineWidth: 0.5)
        )

      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          if let prNumber = entry.prNumber {
            Text("#\(prNumber)")
              .font(.system(.caption2, design: .monospaced).weight(.bold))
              .foregroundStyle(ADEColor.accent)
          }
          PrTagChip(label: "lane", color: ADEColor.tintFiles)
          Spacer(minLength: 4)
          WkStatePill(state: entry.state)
        }

        Text(entry.laneName)
          .font(.system(.subheadline, design: .default).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)

        Text(entry.waitingOn ?? entry.state.replacingOccurrences(of: "_", with: " "))
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(wkStateInfo(for: entry.state).0)
          .lineLimit(1)
      }

      VStack(spacing: 4) {
        Button(action: onOpenPr) {
          Image(systemName: "arrow.up.right.square")
        }
        .buttonStyle(.glass)
        .disabled(entry.prId.isEmpty)

        HStack(spacing: 4) {
          Button(action: onMoveUp) {
            Image(systemName: "chevron.up")
          }
          .buttonStyle(.glass)
          .disabled(!isLive || isFirst || freezeOrder)

          Button(action: onMoveDown) {
            Image(systemName: "chevron.down")
          }
          .buttonStyle(.glass)
          .disabled(!isLive || isLast || freezeOrder)
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

private struct WkMergedRow: View {
  let entry: QueueLandingEntry
  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(ADEColor.accent.opacity(0.16))
        Image(systemName: "arrow.triangle.merge")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
      }
      .frame(width: 22, height: 22)

      if let prNumber = entry.prNumber {
        Text("#\(prNumber)")
          .font(.system(.caption, design: .monospaced).weight(.bold))
          .foregroundStyle(ADEColor.accent)
      }

      Text(entry.laneName)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)

      Spacer(minLength: 0)

      Text(prRelativeTime(entry.updatedAt))
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

private struct WkConfigRow: View {
  let label: String
  let value: String
  var body: some View {
    HStack(spacing: 10) {
      Text(label)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 0)
      Text(value)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

private struct WkConfigRowData {
  let label: String
  let value: String
}

private func wkIntegrationConfigRows(card: PrWorkflowCard) -> [WkConfigRowData] {
  var rows: [WkConfigRowData] = []
  if let base = card.baseBranch {
    rows.append(.init(label: "Base branch", value: base))
  }
  if let state = card.workflowDisplayState {
    rows.append(.init(label: "Workflow state", value: state))
  }
  if let cleanup = card.cleanupState {
    rows.append(.init(label: "Cleanup", value: cleanup))
  }
  if let mergeTarget = card.preferredIntegrationLaneId, !mergeTarget.isEmpty {
    rows.append(.init(label: "Merge target", value: mergeTarget))
  }
  if let laneCount = card.laneCount {
    rows.append(.init(label: "Lanes", value: "\(laneCount)"))
  }
  if let conflicts = card.conflictLaneCount, conflicts > 0 {
    rows.append(.init(label: "Conflicts", value: "\(conflicts)"))
  }
  return rows
}
