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
    VStack(alignment: .leading, spacing: 8) {
      if hasPlanActions || importedRef != nil {
        // One line when it fits (desktop's action bar); else the mode and
        // lane on the first line and the buttons under them.
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 8) {
            configuration
            Spacer(minLength: 8)
            buttons(fill: false)
          }
          VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
              configuration
              Spacer(minLength: 0)
            }
            buttons(fill: true)
          }
        }
      } else {
        Text("Nothing to do for this session here.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
      }

      if let primary = actions.primary, isConfirming(primary) {
        Label("It may be open elsewhere. Tap again to continue anyway.", systemImage: "exclamationmark.triangle.fill")
          .font(.footnote)
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
      } else if let note = displayedNote {
        Text(note)
          .font(.footnote)
          .foregroundStyle(actions.primary?.confirmBeforeRun == true ? ADEColor.warning : ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let error {
        Label(error, systemImage: "xmark.octagon.fill")
          .font(.footnote)
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel("Error: \(error)")
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      ADEColor.pageBackground
        .ignoresSafeArea(edges: .bottom)
        .overlay(alignment: .top) {
          Rectangle().fill(ADEKit.rule).frame(height: 0.75)
        }
    }
  }

  /// The plan's note, or why the lane is locked (a phone has no tooltip).
  private var displayedNote: String? {
    if let note { return note }
    if importedRef == nil, plan.laneLocked, let lockReason = plan.lockReason {
      return "\(lockReason) \(workExternalSessionProviderName(session.provider)) can only reopen a session in the folder it ran in."
    }
    if importedRef == nil, plan.surface == nil, let planNote = plan.note { return planNote }
    return nil
  }

  /// "Chat | CLI in <lane>". An imported session shows only where it is.
  @ViewBuilder
  private var configuration: some View {
    if importedRef != nil {
      Label("Already in ADE", systemImage: "checkmark.circle.fill")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.success)
        .lineLimit(1)
        .fixedSize()
    } else if let current = plan.surface {
      HStack(spacing: 8) {
        if plan.surfaces.count > 1 {
          ADEKitSegmented(
            selection: Binding(
              get: { current },
              set: { surface = $0 }
            ),
            options: plan.surfaces.map { (value: $0, title: workImportSurfaceLabel($0)) }
          )
          .frame(width: 150)
          .disabled(importDisabled)
        } else {
          Text(workImportSurfaceLabel(current))
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize()
        }
        Text("in")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize()
        if plan.laneLocked {
          lockedChip
        } else {
          Menu {
            Picker("Import into lane", selection: $targetLaneId) {
              ForEach(lanes) { lane in
                Text("\(lane.emoji.map { "\($0) " } ?? "")\(lane.name)").tag(lane.id)
              }
            }
          } label: {
            WorkImportPillLabel(
              symbol: "square.stack.3d.up",
              laneMark: lanes.first(where: { $0.id == targetLaneId }),
              title: lanes.first(where: { $0.id == targetLaneId })?.name ?? "Choose lane"
            )
          }
          .disabled(importDisabled)
          .accessibilityLabel("Import into lane")
          .accessibilityValue(lanes.first(where: { $0.id == targetLaneId })?.name ?? "")
        }
      }
    }
  }

  @ViewBuilder
  private func buttons(fill: Bool) -> some View {
    if let importedRef {
      HStack(spacing: 8) {
        if let copy = actions.primary {
          secondaryButton(copy, fill: fill)
        }
        mainButton(label: "Open in ADE", warning: false, fill: fill) {
          onOpenExisting(importedRef)
        }
      }
    } else if let primary = actions.primary {
      HStack(spacing: 8) {
        if let secondary = actions.secondary {
          secondaryButton(secondary, fill: fill)
        }
        let confirming = isConfirming(primary)
        mainButton(label: confirming ? "Continue anyway" : primary.label, warning: confirming, fill: fill) {
          onRun(primary)
        }
      }
    }
  }

  private func mainButton(label: String, warning: Bool, fill: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if importing {
          ProgressView()
            .controlSize(.small)
            .tint(.white)
        }
        Text(label)
      }
      .frame(maxWidth: fill ? .infinity : nil, minHeight: 34)
      .padding(.horizontal, 4)
    }
    .buttonStyle(ADEKitButtonStyle(prominent: true, brand: warning ? ADEColor.warning : nil))
    .disabled(importDisabled)
    .fixedSize(horizontal: !fill, vertical: false)
  }

  private func secondaryButton(_ action: WorkImportPlanAction, fill: Bool) -> some View {
    Button {
      onRun(action)
    } label: {
      Text(action.label)
        .frame(minHeight: 34)
        .padding(.horizontal, 4)
    }
    .buttonStyle(ADEKitButtonStyle())
    .disabled(importDisabled)
    .fixedSize()
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
      WorkLaneLogoMark(color: color, laneIcon: lockedLane?.icon, emoji: lockedLane?.emoji, size: 12)
      Text(name)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Image(systemName: "lock.fill")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 12)
    .frame(height: 34)
    .adeKitPill()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Lane \(name), locked")
    .accessibilityHint(plan.lockReason ?? "")
  }
}
