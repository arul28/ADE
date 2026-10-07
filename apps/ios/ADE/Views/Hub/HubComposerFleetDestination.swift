import SwiftUI

// The hub composer's destinations on machines other than the primary one: which
// machines offer projects, how a pick on one reads, and the machine headers
// that group the picker's project list.

extension MachineFleet {
  /// Live machines other than the primary that have projects to offer.
  var composerDestinationMachines: [Machine] {
    machines.filter { $0.state == .live && !$0.projects.isEmpty }
  }
}

/// "ADE", or "ADE · windows" when the project is on another machine.
func hubComposerDestinationTitle(projectName: String?, machineName: String?) -> String {
  guard let projectName else { return "Select project" }
  return machineName.map { "\(projectName) · \($0)" } ?? projectName
}

/// One machine's header above its projects in the destination picker.
struct HubComposerMachineHeader: View {
  let name: String

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: machineSymbol(machineKey: nil, name: name))
        .font(.system(size: 11, weight: .regular))
      Text(name)
        .font(.system(size: 12, weight: .semibold))
        .lineLimit(1)
      Spacer(minLength: 0)
    }
    .foregroundStyle(ADEColor.textSecondary)
    .padding(.horizontal, 8)
    .padding(.top, 8)
    .padding(.bottom, 2)
  }
}
