import SwiftUI

// MARK: - Legacy cards (unchanged surface, lightly restyled)

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

  var body: some View {
    // Flat: the row sits on the page; the section header names the kind.
    VStack(alignment: .leading, spacing: 12) {
      switch card.kind {
      case "integration": integrationSection
      case "rebase": rebaseSection
      default: unknownSection
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: Integration

  @ViewBuilder
  private var integrationSection: some View {
    let readyCount = (card.laneCount ?? 0) - (card.conflictLaneCount ?? 0)
    let totalCount = card.laneCount ?? 0

    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        ADEEyebrow("Integration")
        if totalCount > 0 {
          ADEKitTag(text: "\(readyCount) of \(totalCount) ready", tone: readyCount == totalCount ? .ok : .warn)
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
        ADEKitTag(text: status, color: ADEColor.accent)
      }
      if let workflowDisplayState = card.workflowDisplayState {
        ADEKitTag(text: workflowDisplayState)
      }
      if let cleanupState = card.cleanupState {
        ADEKitTag(text: cleanupState, color: ADEColor.warning)
      }
      Spacer(minLength: 0)
      if let outcome = card.overallOutcome {
        ADEKitTag(text: outcome, color: outcome == "clean" ? ADEColor.success : ADEColor.warning)
      }
    }

    if let lanes = card.lanes, !lanes.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(lanes.prefix(6)) { lane in
          HStack(spacing: 10) {
            ADEKitTag(
              text: lane.outcome.replacingOccurrences(of: "_", with: " "),
              color: lane.outcome == "clean" ? ADEColor.success : ADEColor.warning
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
                .buttonStyle(ADEKitButtonStyle())
                .accessibilityLabel("Resolve conflicts for \(lane.laneName)")

                Button {
                  onRecheckIntegrationLane(proposalId, lane.laneId)
                } label: {
                  Image(systemName: "arrow.clockwise")
                    .frame(width: 30, height: 30)
                }
                .buttonStyle(ADEKitButtonStyle())
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
      .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
    }

    if let proposalId = card.proposalId {
      HStack(spacing: 10) {
        Button(card.integrationLaneId == nil ? "Create lane" : "Refresh lane") {
          onCreateIntegrationLane(proposalId)
        }
        .buttonStyle(ADEKitButtonStyle())
        .disabled(!isLive)

        Button("Delete", role: .destructive) {
          onDeleteIntegrationProposal(proposalId)
        }
        .buttonStyle(ADEKitButtonStyle())
        .disabled(!isLive)
      }

      if card.cleanupState == "required" || card.cleanupState == "declined" {
        HStack(spacing: 10) {
          Button {
            onCleanupIntegrationWorkflow(proposalId, card.lanes?.map(\.laneId) ?? [])
          } label: {
            Label("Clean up lanes", systemImage: "archivebox")
          }
          .buttonStyle(ADEKitButtonStyle())
          .disabled(!isLive)

          Button {
            onDismissIntegrationCleanup(proposalId)
          } label: {
            Label("Not now", systemImage: "clock")
          }
          .buttonStyle(ADEKitButtonStyle())
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
      .adeKitCard(padding: nil)
    }
  }

  // MARK: Rebase

  @ViewBuilder
  private var rebaseSection: some View {
    // Default to "auto" when older hosts omit the field. `manual` → PR was
    // opened with lane_base strategy so auto-rebase is suppressed and the
    // user has to trigger it by hand.
    let isManual = (card.rebaseMode == "manual")
    let pillLabel = isManual ? "manual rebase" : "rebase needed"
    let rebaseButtonLabel = isManual ? "Rebase now" : "Rebase"

    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        ADEEyebrow("Rebase")
        if let prNumber = card.prNumber {
          Text(verbatim: "#\(prNumber)")
            .font(.adeMono(11, weight: .medium))
            .foregroundStyle(ADEColor.textMuted)
        }
        ADEKitTag(text: pillLabel, tone: isManual ? .neutral : .warn)
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
    }

    if let deferredUntil = card.deferredUntil {
      Text("Deferred until \(prAbsoluteTime(deferredUntil))")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
    }

    // Opens the rebase screen.
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
          Image(systemName: "chevron.right")
            .font(.system(size: 12, weight: .semibold))
        }
      }
      .buttonStyle(ADEKitButtonStyle(tone: .warn, wide: true))
    }

    HStack(spacing: 10) {
      if let laneId = card.laneId {
        Button(rebaseButtonLabel) { onRebaseLane(laneId) }
          .buttonStyle(ADEKitButtonStyle())
          .disabled(!isLive)

        Button("Defer") { onDeferRebase(laneId) }
          .buttonStyle(ADEKitButtonStyle())
          .disabled(!isLive)

        Button("Dismiss") { onDismissRebase(laneId) }
          .buttonStyle(ADEKitButtonStyle())
          .disabled(!isLive)
      }

      Spacer(minLength: 0)

      if let prId = card.prId {
        Button("Open PR") { onOpenPr(prId) }
          .buttonStyle(ADEKitButtonStyle())
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

/// A predicted conflict, in the critical tone so it can't be glanced past.
struct PrConflictBadge: View {
  var text: String = "Conflict"

  var body: some View {
    ADEKitTag(text: text, tone: .crit)
      .accessibilityLabel("Warning: \(text)")
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
