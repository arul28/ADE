import SwiftUI

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

// MARK: - Unified workflow card

/// Unified workflow card driven by the `PrMobileSnapshot.workflowCards`
/// payload. Integration and rebase cards share one rendering surface.
///
struct PrMobileWorkflowCardView: View {
  let card: PrWorkflowCard
  let isLive: Bool
  let onOpenPr: (String) -> Void
  let onCreateIntegrationLane: (String) -> Void
  let onDeleteIntegrationProposal: (String) -> Void
  let onDismissIntegrationCleanup: (String) -> Void
  let onCleanupIntegrationWorkflow: (String, [String]) -> Void
  let onResolveIntegrationLane: (String, String) -> Void
  let onRecheckIntegrationLane: (String, String) -> Void
  let onRebaseLane: (String) -> Void
  let onDeferRebase: (String) -> Void
  let onDismissRebase: (String) -> Void

  /// Tint applied to the outer liquid-glass card and the 4pt status rail on
  /// the left edge.
  private var cardTint: Color {
    switch card.kind {
    case "integration": return PrGlassPalette.warning
    case "rebase": return PrGlassPalette.warning
    default: return PrGlassPalette.purple
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      // 4pt status rail tinted by workflow kind.
      RoundedRectangle(cornerRadius: 2.5, style: .continuous)
        .fill(
          LinearGradient(
            colors: [cardTint, cardTint.opacity(0.5)],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .frame(width: 4)
        .shadow(color: cardTint.opacity(0.55), radius: 8, x: 0, y: 0)

      VStack(alignment: .leading, spacing: 14) {
        switch card.kind {
        case "integration": integrationSection
        case "rebase": rebaseSection
        default: unknownSection
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(14)
    .prGlassCard(cornerRadius: 20, tint: cardTint)
  }

  // MARK: Integration

  @ViewBuilder
  private var integrationSection: some View {
    let readyCount = (card.laneCount ?? 0) - (card.conflictLaneCount ?? 0)
    let totalCount = card.laneCount ?? 0

    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        PrsEyebrowLabel(text: "INTEGRATION", tint: PrGlassPalette.warning)
        if totalCount > 0 {
          HStack(spacing: 4) {
            Image(systemName: "timer")
              .font(.system(size: 10, weight: .bold))
            Text("\(readyCount) of \(totalCount) ready")
              .font(.system(size: 10, weight: .bold))
          }
          .foregroundStyle(readyCount == totalCount ? PrGlassPalette.success : PrGlassPalette.warning)
          .padding(.horizontal, 8)
          .padding(.vertical, 3)
          .background(
            Capsule(style: .continuous)
              .fill((readyCount == totalCount ? PrGlassPalette.success : PrGlassPalette.warning).opacity(0.16))
          )
          .overlay(
            Capsule(style: .continuous)
              .strokeBorder((readyCount == totalCount ? PrGlassPalette.success : PrGlassPalette.warning).opacity(0.4), lineWidth: 0.5)
          )
        }
        Spacer(minLength: 0)
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
              HStack(spacing: 6) {
                Button {
                  onResolveIntegrationLane(proposalId, lane.laneId)
                } label: {
                  Image(systemName: "wrench.and.screwdriver")
                    .frame(width: 30, height: 30)
                }
                .buttonStyle(.glass)
                .accessibilityLabel("Resolve conflicts for \(lane.laneName)")

                Button {
                  onRecheckIntegrationLane(proposalId, lane.laneId)
                } label: {
                  Image(systemName: "arrow.clockwise")
                    .frame(width: 30, height: 30)
                }
                .buttonStyle(.glass)
                .accessibilityLabel("Recheck \(lane.laneName)")
              }
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

    // Integration configuration. Hidden entirely when the card has no
    // configuration details.
    let cfg = wkIntegrationConfigRows(card: card)
    if !cfg.isEmpty {
      PrSectionHdr(title: "Integration settings")
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
        PrsEyebrowLabel(text: "REBASE", tint: tintForMode)
        if let prNumber = card.prNumber {
          Text("#\(prNumber)")
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .foregroundStyle(tintForMode)
        }
        ADEStatusPill(text: pillLabel, tint: tintForMode)
        PrTagChip(label: "lane", color: PrGlassPalette.blue)
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
          .font(.system(size: 11, weight: .medium, design: .monospaced))
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

    // Tappable link to the new rebase screen — styled as a bold amber→orange
    // gradient CTA per the liquid-glass spec.
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
            .font(.system(size: 13, weight: .bold))
          Text("Inspect drift")
            .font(.system(size: 14, weight: .bold))
          Spacer(minLength: 0)
          Image(systemName: "chevron.right")
            .font(.system(size: 12, weight: .bold))
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(
              LinearGradient(
                colors: [
                  PrGlassPalette.warning,
                  Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x06 / 255),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
        )
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.white.opacity(0.4), lineWidth: 0.5)
        )
        .shadow(color: PrGlassPalette.warning.opacity(0.55), radius: 12, x: 0, y: 3)
      }
      .buttonStyle(.plain)
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
