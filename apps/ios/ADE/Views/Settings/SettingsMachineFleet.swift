import SwiftUI

// Settings > Machines: state copy, the live-machine limit notice and the
// keep-live prompt of the machine fleet.

/// Short state copy for a machine header.
func machineFleetStateLabel(_ state: MachineFleet.MachineState, lastUpdateAt: Date?, now: Date = Date()) -> String {
  func updated() -> String {
    guard let lastUpdateAt else { return "" }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return " · updated \(formatter.localizedString(for: lastUpdateAt, relativeTo: now))"
  }
  switch state {
  case .live: return "Live"
  case .connecting: return "Connecting…"
  case .offline: return "Offline" + updated()
  case .paused: return "Paused" + updated()
  case .inactive: return "Paused in background"
  case .needsUpdate: return "Update ADE on this machine"
  case .needsAttention(let message): return message
  }
}

/// Shown when the account has more machines than the phone keeps live.
struct MachineFleetLimitNotice: View {
  let pairedMachineCount: Int
  let pausedCount: Int

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "info.circle.fill")
        .foregroundStyle(ADEColor.info)
      VStack(alignment: .leading, spacing: 2) {
        Text("Live updates for \(MachineFleet.liveMachineLimit) machines at a time")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(pausedCount == 1
          ? "1 machine shows its last update. Use its … menu to keep it live."
          : "\(pausedCount) machines show their last update. Use a machine's … menu to keep it live.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(ADEColor.glassBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
    .accessibilityElement(children: .combine)
  }
}

struct MachineFleetKeepLivePrompt: Identifiable, Equatable {
  let machineKey: String
  let machineName: String
  let pausedName: String
  var id: String { machineKey }
}

func machineFleetCanRetry(_ state: MachineFleet.MachineState) -> Bool {
  switch state {
  case .needsUpdate, .needsAttention, .offline: return true
  default: return false
  }
}
