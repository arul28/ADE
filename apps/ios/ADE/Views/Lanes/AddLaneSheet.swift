import SwiftUI

/// A machine a new lane can go to: its checkout's primary lane and lanes
/// (namespaced ids for another machine), and where `lanes.create` goes.
struct LaneCreateMachine: Identifiable, Equatable {
  /// The machine key, or "" for the focused machine.
  let id: String
  let name: String
  let primaryLane: LaneSummary?
  let lanes: [LaneSummary]
  let target: LaneCreateTarget?
  /// Chats running in its lanes now: fewer is shown first.
  let runningCount: Int
}

struct AddLaneSheet: View {
  @Environment(\.dismiss) private var dismiss

  /// Least busy first. With more than one, the user must pick (the desktop
  /// rule: creating a lane always asks which machine).
  let machines: [LaneCreateMachine]
  let onLaneCreated: @MainActor (String) async -> Void

  @State private var selectedMachineId: String?

  init(machines: [LaneCreateMachine], onLaneCreated: @escaping @MainActor (String) async -> Void) {
    self.machines = machines
    self.onLaneCreated = onLaneCreated
    _selectedMachineId = State(initialValue: machines.count == 1 ? machines.first?.id : nil)
  }

  private var selected: LaneCreateMachine? {
    machines.first { $0.id == selectedMachineId }
  }

  private var primaryLane: LaneSummary? { selected?.primaryLane }
  private var lanes: [LaneSummary] { selected?.lanes ?? [] }
  private var target: LaneCreateTarget? { selected?.target }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 12) {
          if machines.count > 1 {
            machinePicker
          }
          VStack(spacing: 12) {
          LaneCreateOptionLink(
            symbol: "plus.square.on.square",
            symbolTint: ADEColor.accent,
            title: "New lane",
            subtitle: "Start from the primary branch"
          ) {
            LaneCreateSheet(
              primaryLane: primaryLane,
              lanes: lanes,
              initialMode: .primary,
              showsModePicker: false,
              target: target,
              onComplete: handleCreate
            )
          }

          LaneCreateOptionLink(
            symbol: "arrow.triangle.branch",
            symbolTint: ADEColor.accent,
            title: "From existing branch",
            subtitle: "Import an existing git branch"
          ) {
            LaneCreateSheet(
              primaryLane: primaryLane,
              lanes: lanes,
              initialMode: .importBranch,
              showsModePicker: false,
              target: target,
              onComplete: handleCreate
            )
          }

          LaneCreateOptionLink(
            symbol: "square.stack.3d.up",
            symbolTint: ADEColor.purpleAccent,
            title: "Child lane",
            subtitle: "Stack on top of another lane"
          ) {
            LaneCreateSheet(
              primaryLane: primaryLane,
              lanes: lanes,
              initialMode: .child,
              showsModePicker: false,
              target: target,
              onComplete: handleCreate
            )
          }

          LaneCreateOptionLink(
            symbol: "cross.case",
            symbolTint: ADEColor.warning,
            title: "Rescue unstaged",
            subtitle: "Move dirty changes into a new lane"
          ) {
            LaneCreateSheet(
              primaryLane: primaryLane,
              lanes: lanes,
              initialMode: .rescueUnstaged,
              showsModePicker: false,
              target: target,
              onComplete: handleCreate
            )
          }
          }
          // Creating a lane always names its machine first.
          .disabled(selected == nil)
          .opacity(selected == nil ? 0.45 : 1)
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Add lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
  }

  private var machinePicker: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("MACHINE")
        .font(.caption.weight(.semibold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)
        .padding(.horizontal, 2)
      VStack(spacing: 0) {
        ForEach(Array(machines.enumerated()), id: \.element.id) { index, machine in
          Button {
            selectedMachineId = machine.id
          } label: {
            HStack(spacing: 12) {
              Image(systemName: "desktopcomputer")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ADEColor.accent)
                .frame(width: 28)
              VStack(alignment: .leading, spacing: 2) {
                Text(machine.name)
                  .font(.subheadline.weight(.semibold))
                  .foregroundStyle(ADEColor.textPrimary)
                Text(machineChoiceSubtitle(runningCount: machine.runningCount, isLeastBusy: index == 0))
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
              Spacer(minLength: 0)
              if selectedMachineId == machine.id {
                Image(systemName: "checkmark")
                  .font(.subheadline.weight(.semibold))
                  .foregroundStyle(ADEColor.accent)
              }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(selectedMachineId == machine.id ? .isSelected : [])
          if index < machines.count - 1 {
            Divider().padding(.leading, 54)
          }
        }
      }
      .background(ADEColor.surfaceBackground.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.75)
      )
    }
  }

  @MainActor
  private func handleCreate(_ laneId: String) async {
    ADEHaptics.success()
    await onLaneCreated(laneId)
  }
}

private struct LaneCreateOptionLink<Destination: View>: View {
  let symbol: String
  let symbolTint: Color
  let title: String
  let subtitle: String
  @ViewBuilder let destination: () -> Destination

  var body: some View {
    NavigationLink {
      destination()
    } label: {
      HStack(alignment: .center, spacing: 14) {
        Image(systemName: symbol)
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(symbolTint)
          .frame(width: 44, height: 44)
          .background(symbolTint.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .glassEffect(in: .rect(cornerRadius: 12))

        VStack(alignment: .leading, spacing: 3) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }

        Spacer(minLength: 0)

        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.surfaceBackground.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.75)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .accessibilityLabel("\(title). \(subtitle)")
  }
}


