import Foundation
import SwiftUI

/// One key per (session, action, lane): the second tap on a live continue
/// must match the first.
func workImportConfirmKey(session: ExternalSessionSummary, action: WorkImportPlanAction, laneId: String?) -> String {
  "\(session.importIdentity):\(action.target):\(action.mode):\(laneId ?? "")"
}

/// The action bar, pinned under the session: mode switch, lane control, note,
/// and one main button with an optional Copy — all from `workPlanImport`.
struct WorkImportActionBar: View {
  let session: ExternalSessionSummary
  let plan: WorkImportPlan
  let lanes: [LaneSummary]
  @Binding var targetLaneId: String
  @Binding var surface: String
  let confirmingKey: String?
  /// This session's import is running.
  let importing: Bool
  /// Any import is running.
  let importDisabled: Bool
  let error: String?
  let onRun: (WorkImportPlanAction) -> Void
  let onOpenExisting: (ExternalSessionImportedRef) -> Void

  private var importedRef: ExternalSessionImportedRef? {
    workImportedSessionRef(for: session)
  }

  /// An imported row opens its ADE session instead of continuing it again;
  /// only the copy stays on offer.
  private var actions: (primary: WorkImportPlanAction?, secondary: WorkImportPlanAction?) {
    guard importedRef != nil else { return (plan.primary, plan.secondary) }
    let copies = [plan.primary, plan.secondary].compactMap { $0 }.filter { $0.mode == "fork" }
    return (copies.first, nil)
  }

  private var hasPlanActions: Bool {
    actions.primary != nil || actions.secondary != nil
  }

  private var note: String? {
    guard let primary = actions.primary, primary == plan.primary else { return nil }
    return plan.note
  }

  private func isConfirming(_ action: WorkImportPlanAction) -> Bool {
    confirmingKey == workImportConfirmKey(session: session, action: action, laneId: plan.targetLaneId)
  }

  private var lockedLane: LaneSummary? {
    guard let laneId = plan.targetLaneId else { return nil }
    return lanes.first(where: { $0.id == laneId })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if importedRef != nil {
        Label("Already in ADE", systemImage: "checkmark.circle.fill")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.success)
      }

      if hasPlanActions {
        configuration
      }

      if let primary = actions.primary, isConfirming(primary) {
        Label("It may be open elsewhere. Tap again to continue anyway.", systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
      } else if let note {
        Text(note)
          .font(.caption)
          .foregroundStyle(actions.primary?.confirmBeforeRun == true ? ADEColor.warning : ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let error {
        Label(error, systemImage: "xmark.octagon.fill")
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel("Error: \(error)")
      }

      buttons
    }
    .padding(14)
    .background(ADEColor.composerBackground, in: RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    }
  }

  @ViewBuilder
  private var configuration: some View {
    if plan.surfaces.count > 1 {
      Picker("Open as", selection: $surface) {
        ForEach(plan.surfaces, id: \.self) { value in
          Text(workImportSurfaceLabel(value)).tag(value)
        }
      }
      .pickerStyle(.segmented)
      .disabled(importDisabled)
      .accessibilityLabel("Open as")
    } else if let only = plan.surface {
      Text("Opens as \(workImportSurfaceLabel(only))")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
    }

    if plan.surface != nil {
      HStack(alignment: .center, spacing: 8) {
        Text("in")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        if plan.laneLocked {
          lockedChip
        } else {
          WorkLanePickerDropdown(
            lanes: lanes,
            selectedLaneId: $targetLaneId,
            showsAutoCreateOption: false
          )
          .disabled(importDisabled)
        }
        Spacer(minLength: 0)
      }
      if plan.laneLocked, let lockReason = plan.lockReason {
        // Why the lane can't change, in the open: a phone has no tooltip.
        Label {
          // A lane locks only when every CLI action needs the session's own
          // folder (the provider cannot resume or fork it anywhere else).
          Text("\(lockReason) \(workExternalSessionProviderName(session.provider)) can only reopen a session in the folder it ran in.")
        } icon: {
          Image(systemName: "lock.fill")
        }
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  @ViewBuilder
  private var buttons: some View {
    if let importedRef {
      HStack(spacing: 10) {
        if let copy = actions.primary {
          secondaryButton(copy)
        }
        mainButton(label: "Open in ADE", tint: ADEColor.accent) {
          onOpenExisting(importedRef)
        }
      }
    } else if let primary = actions.primary {
      HStack(spacing: 10) {
        if let secondary = actions.secondary {
          secondaryButton(secondary)
        }
        let confirming = isConfirming(primary)
        mainButton(
          label: confirming ? "Continue anyway" : primary.label,
          tint: confirming ? ADEColor.warning : ADEColor.accent
        ) {
          onRun(primary)
        }
      }
    } else {
      Text("Nothing to do for this session here.")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
    }
  }

  private func mainButton(label: String, tint: Color, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if importing {
          ProgressView()
            .controlSize(.small)
            .tint(.white)
        }
        Text(label)
          .font(.subheadline.weight(.semibold))
          .lineLimit(1)
          .minimumScaleFactor(0.85)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 4)
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .tint(tint)
    .disabled(importDisabled)
  }

  private func secondaryButton(_ action: WorkImportPlanAction) -> some View {
    Button {
      onRun(action)
    } label: {
      Text(action.label)
        .font(.subheadline.weight(.semibold))
        .lineLimit(1)
        .padding(.vertical, 4)
    }
    .buttonStyle(.bordered)
    .controlSize(.large)
    .tint(ADEColor.textPrimary)
    .disabled(importDisabled)
    // The phone sends no model: for a chat copy (`needsModel`) the machine
    // picks the session's own model family, else that provider's default.
    .accessibilityHint(action.needsModel
      ? "Makes a new ADE chat with this history. The machine picks the model."
      : "Makes a copy in a new terminal.")
  }

  private var lockedChip: some View {
    let name = lockedLane?.name ?? session.home?.laneName ?? "its lane"
    let color = LaneColorPalette.displayColor(
      forHex: lockedLane?.color ?? session.home?.color,
      fallback: ADEColor.textSecondary
    )
    return HStack(spacing: 6) {
      WorkLaneLogoMark(color: color, laneIcon: lockedLane?.icon, size: 12)
      Text(name)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Image(systemName: "lock.fill")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(ADEColor.textPrimary.opacity(0.04), in: Capsule(style: .continuous))
    .overlay(Capsule(style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 0.6))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Lane \(name), locked")
    .accessibilityHint(plan.lockReason ?? "")
  }
}
