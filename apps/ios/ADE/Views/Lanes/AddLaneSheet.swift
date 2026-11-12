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

/// The Start-on list of an account project for the Add lane sheet, and the
/// two steps a pick can need before a lane can start: connect the computer,
/// or copy the project onto it.
struct LaneStartOnContext {
  let accountProjectId: String
  let projectName: String
  /// In Start-on order (`resolveStartOn`).
  let candidates: [StartOnCandidate]
  /// The primary's key: its `LaneCreateMachine` has the id "".
  let focusedKey: String?
  /// Connects a computer and reads its lanes. Nil when done, or the reason.
  let connect: @MainActor (StartOnCandidate) async -> String?
  /// Copies the project onto a computer and reads its lanes. Nil when done,
  /// or the reason.
  let copy: @MainActor (StartOnCandidate) async -> String?
}

struct AddLaneSheet: View {
  @Environment(\.dismiss) private var dismiss

  /// Least busy first. With more than one, the user must pick (the desktop
  /// rule: creating a lane always asks which machine).
  let machines: [LaneCreateMachine]
  /// Set for an account project: the sheet lists computers in Start-on order
  /// instead of the live machines alone.
  let startOn: LaneStartOnContext?
  let onLaneCreated: @MainActor (String) async -> Void

  @State private var selectedMachineId: String?
  @State private var selectedStartOnId: String?
  @State private var busyStartOnIds = Set<String>()
  /// Counts the picks, so a connect or copy that ends after a newer pick
  /// does not take the selection back.
  @State private var startOnPicks = 0
  @State private var startOnError: String?

  init(
    machines: [LaneCreateMachine],
    startOn: LaneStartOnContext? = nil,
    onLaneCreated: @escaping @MainActor (String) async -> Void
  ) {
    self.machines = machines
    self.startOn = startOn
    self.onLaneCreated = onLaneCreated
    _selectedMachineId = State(initialValue: machines.count == 1 ? machines.first?.id : nil)
    _selectedStartOnId = State(initialValue: startOn.flatMap { startOnDefault($0.candidates)?.id })
  }

  /// The chosen row, or the default when the chosen one went offline or
  /// left the list after the account's computers were read again.
  private var selectedCandidate: StartOnCandidate? {
    guard let startOn else { return nil }
    if let selectedStartOnId,
       let row = startOn.candidates.first(where: { $0.id == selectedStartOnId }),
       row.kind != .offline {
      return row
    }
    return startOnDefault(startOn.candidates)
  }

  /// The machine of a Start-on row, once the Lanes tab reads lanes there.
  private func laneMachine(for candidate: StartOnCandidate) -> LaneCreateMachine? {
    guard let key = candidate.fleetKey else { return nil }
    let id = key == startOn?.focusedKey ? "" : key
    return machines.first { $0.id == id }
  }

  private var selected: LaneCreateMachine? {
    if startOn != nil {
      return selectedCandidate.flatMap(laneMachine(for:))
    }
    return machines.first { $0.id == selectedMachineId }
  }

  private var primaryLane: LaneSummary? { selected?.primaryLane }
  private var lanes: [LaneSummary] { selected?.lanes ?? [] }
  private var target: LaneCreateTarget? { selected?.target }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: ADEKit.sectionGap) {
          if let startOn {
            StartOnSection(
              candidates: startOn.candidates,
              selectedId: selectedCandidate?.id,
              busyIds: busyStartOnIds,
              onPick: pick,
              onWake: { candidate in run(candidate, startOn.connect) }
            )
            if let startOnError {
              Text(startOnError)
                .font(.system(size: 13))
                .foregroundStyle(ADEColor.danger)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
            }
            if let candidate = selectedCandidate, candidate.kind == .cloneFirst, laneMachine(for: candidate) == nil {
              copyFirstCard(candidate, project: startOn.projectName, copy: startOn.copy)
            }
          } else if machines.count > 1 {
            machinePicker
          }
          ADESettingsSection(machines.count > 1 || startOn != nil ? "Kind" : nil) {
          ADESettingsRows {
          ForEach(LaneCreateMode.allCases) { mode in
            LaneCreateOptionLink(
              symbol: mode.symbol,
              title: mode.title,
              subtitle: mode.help
            ) {
              LaneCreateSheet(
                primaryLane: primaryLane,
                lanes: lanes,
                initialMode: mode,
                showsModePicker: false,
                target: target,
                onComplete: handleCreate
              )
            }
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

  /// A pick: the row is chosen at once. A computer with a copy that is not
  /// live yet connects; one with no copy waits for "Copy".
  private func pick(_ candidate: StartOnCandidate) {
    startOnPicks += 1
    selectedStartOnId = candidate.id
    startOnError = nil
    guard candidate.kind == .copy, laneMachine(for: candidate) == nil, let startOn else { return }
    run(candidate, startOn.connect)
  }

  private func run(_ candidate: StartOnCandidate, _ step: @escaping @MainActor (StartOnCandidate) async -> String?) {
    guard !busyStartOnIds.contains(candidate.id) else { return }
    busyStartOnIds.insert(candidate.id)
    startOnError = nil
    let pickAtStart = startOnPicks
    Task { @MainActor in
      let failure = await step(candidate)
      busyStartOnIds.remove(candidate.id)
      guard startOnPicks == pickAtStart else { return }
      if let failure {
        startOnError = failure
        ADEHaptics.warning()
      } else {
        selectedStartOnId = candidate.id
        ADEHaptics.light()
      }
    }
  }

  /// A computer with no copy: say what happens, and copy on a tap.
  private func copyFirstCard(
    _ candidate: StartOnCandidate,
    project: String,
    copy: @escaping @MainActor (StartOnCandidate) async -> String?
  ) -> some View {
    let busy = busyStartOnIds.contains(candidate.id)
    return VStack(alignment: .leading, spacing: 10) {
      Text("\(project) is not on \(candidate.name) yet. ADE copies it there from GitHub, then you choose the kind of lane.")
        .font(.system(size: 13.5))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      Button {
        run(candidate, copy)
      } label: {
        HStack(spacing: 8) {
          if busy { ProgressView().controlSize(.small) }
          Text(busy ? "Copying to \(candidate.name)…" : "Copy to \(candidate.name)")
        }
      }
      .buttonStyle(ADEKitButtonStyle(prominent: true))
      .disabled(busy)
    }
    .padding(14)
    .adeKitCard(padding: nil)
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
    if let startOn, let candidate = selectedCandidate {
      StartOnMemory.remember(candidate.accountMachineKey, for: startOn.accountProjectId)
    }
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
