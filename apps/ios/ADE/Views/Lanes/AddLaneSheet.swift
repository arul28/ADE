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
        VStack(alignment: .leading, spacing: ADEKit.sectionGap) {
          if machines.count > 1 {
            machinePicker
          }
          ADESettingsSection(machines.count > 1 ? "Kind" : nil) {
          ADESettingsRows {
          LaneCreateOptionLink(
            symbol: "plus.square.on.square",
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
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 24)
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
    ADESettingsSection("Machine") {
      ADESettingsRows {
        ForEach(Array(machines.enumerated()), id: \.element.id) { index, machine in
          Button {
            selectedMachineId = machine.id
          } label: {
            ADESettingsRow(
              title: machine.name,
              hint: machineChoiceSubtitle(runningCount: machine.runningCount, isLeastBusy: index == 0),
              symbol: "desktopcomputer"
            ) {
              if selectedMachineId == machine.id {
                Image(systemName: "checkmark")
                  .font(.system(size: 14, weight: .semibold))
                  .foregroundStyle(ADEColor.accent)
              }
            }
          }
          .buttonStyle(ADEKitRowButtonStyle())
          .accessibilityAddTraits(selectedMachineId == machine.id ? .isSelected : [])
        }
      }
    }
  }

  @MainActor
  private func handleCreate(_ laneId: String) async {
    ADEHaptics.success()
    await onLaneCreated(laneId)
  }
}

/// One way to create a lane: a kit row that pushes its form.
private struct LaneCreateOptionLink<Destination: View>: View {
  let symbol: String
  let title: String
  let subtitle: String
  @ViewBuilder let destination: () -> Destination

  var body: some View {
    NavigationLink {
      destination()
    } label: {
      ADESettingsRow(title: title, hint: subtitle, symbol: symbol) {
        ADESettingsChevron()
      }
    }
    .buttonStyle(ADEKitRowButtonStyle())
    .accessibilityLabel("\(title). \(subtitle)")
  }
}
