import SwiftUI

/// One machine the New Chat page can start a chat on: the primary machine, or
/// another machine with a checkout of the focused repository.
struct WorkNewChatMachineOption: Identifiable, Equatable {
  /// Nil for the primary (focused) machine.
  let machineKey: String?
  let name: String
  let symbol: String
  let isLive: Bool
  var isPrimary: Bool { machineKey == nil }
  var id: String { machineKey ?? "primary" }
}

/// The options: the primary machine first, then connected machines, then the
/// ones that are not connected (a pick reconnects them).
@MainActor
func workNewChatMachineOptions(syncService: SyncService, fleet: MachineFleet) -> [WorkNewChatMachineOption] {
  let primaryName = nonEmptyTrimmed(syncService.hostName) ?? "Primary machine"
  var options = [WorkNewChatMachineOption(
    machineKey: nil,
    name: primaryName,
    symbol: settingsMachineSymbol(forName: primaryName),
    isLive: syncService.connectionState == .connected
  )]
  let others = syncService.remoteReposForActiveProject().map { repo in
    WorkNewChatMachineOption(
      machineKey: repo.machineKey,
      name: repo.machineName,
      symbol: settingsMachineSymbol(forName: repo.machineName),
      isLive: fleet.machine(for: repo.machineKey)?.state == .live
    )
  }
  options += others.filter(\.isLive) + others.filter { !$0.isLive }
  return options
}

/// Provider families with an account on the machine, from its account
/// inventory. Nil when the machine did not publish one (nothing to check).
func workNewChatProvidersWithAccounts(_ inventory: AccountMachineInventorySummary?) -> Set<String>? {
  guard let inventory, !inventory.providers.isEmpty else { return nil }
  return Set(inventory.providers.filter { $0.accounts > 0 }.map { providerFamilyKey($0.provider) })
}

/// The machine dropdown beside the lane dropdown: same floating glass capsule.
struct WorkNewChatMachineDropdown: View {
  let options: [WorkNewChatMachineOption]
  let selected: WorkNewChatMachineOption
  let onSelect: (WorkNewChatMachineOption) -> Void

  var body: some View {
    Menu {
      Section("Connected") {
        ForEach(options.filter { $0.isPrimary || $0.isLive }) { option in
          Button {
            onSelect(option)
          } label: {
            Label(option.isPrimary ? "\(option.name) · Primary" : option.name, systemImage: option.symbol)
          }
        }
      }
      let notLive = options.filter { !$0.isPrimary && !$0.isLive }
      if !notLive.isEmpty {
        Section("Not connected · tap to reconnect") {
          ForEach(notLive) { option in
            Button {
              onSelect(option)
            } label: {
              Label(option.name, systemImage: option.symbol)
            }
          }
        }
      }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: selected.symbol)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(selected.isLive ? ADEColor.textSecondary : ADEColor.textMuted)
        Text(selected.name)
          .font(.system(size: 13, weight: .semibold))
          .frame(maxWidth: 140, alignment: .leading)
          .foregroundStyle(selected.isLive ? ADEColor.textPrimary : ADEColor.textMuted)
          .lineLimit(1)
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 12)
      .frame(height: 32)
      .workChatGlass(in: Capsule(style: .continuous), interactive: true)
      .overlay(Capsule(style: .continuous).stroke(ADEColor.textMuted.opacity(0.3), lineWidth: 0.75))
      .contentShape(Capsule(style: .continuous))
    }
    .accessibilityLabel("Machine")
    .accessibilityValue(selected.name)
  }
}
