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
  let primaryName = syncService.focusedMachineDisplayName
  var options = [WorkNewChatMachineOption(
    machineKey: nil,
    name: primaryName,
    symbol: machineSymbol(machineKey: syncService.focusedMachineKey, name: primaryName),
    isLive: syncService.connectionState == .connected
  )]
  let others = syncService.remoteReposForActiveProject().map { repo in
    WorkNewChatMachineOption(
      machineKey: repo.machineKey,
      name: repo.machineName,
      symbol: machineSymbol(machineKey: repo.machineKey, name: repo.machineName),
      isLive: fleet.isLive(repo.machineKey)
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

/// Whether the chosen model can run on the chosen machine.
enum WorkNewChatModelCheck: Equatable {
  /// The machine has an account for the model's provider, or said nothing.
  case fits
  /// It has none, and no provider of its own has a default model.
  case noAccount
  /// It has none; its first provider's default model runs there.
  case fallback(modelId: String, provider: String)
}

/// A model needs an account on the machine that runs the chat. Reads the
/// machine's account inventory (`machineKey` is its fleet key).
@MainActor
func workNewChatModelCheck(machineKey: String?, provider: String, mode: WorkCursorAvailabilityMode) -> WorkNewChatModelCheck {
  guard let machine = AccountService.shared.machine(forFleetKey: machineKey),
        let available = workNewChatProvidersWithAccounts(machine.inventory),
        !available.contains(providerFamilyKey(provider))
  else { return .fits }
  guard let fallbackProvider = available.sorted().first,
        let fallback = workDefaultModelIdForAvailabilityMode(preferredProvider: fallbackProvider, mode: mode),
        available.contains(providerFamilyKey(fallback.provider))
  else { return .noAccount }
  return .fallback(modelId: fallback.modelId, provider: fallback.provider)
}

/// The machine dropdown beside the lane dropdown: the same solid kit capsule
/// the Hub composer's destination control uses.
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
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 12)
      .frame(height: 34)
      .adeKitPill()
      .contentShape(Capsule(style: .continuous))
    }
    .accessibilityLabel("Machine")
    .accessibilityValue(selected.name)
  }
}
