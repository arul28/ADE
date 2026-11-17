import SwiftUI

/// One machine the New Chat page can start a chat on: the primary machine,
/// another machine with a checkout of the focused repository, or ADE Cloud.
struct WorkNewChatMachineOption: Identifiable, Equatable {
  /// Nil for the primary (focused) machine; `ADECloudMachine.id` for ADE Cloud.
  let machineKey: String?
  let name: String
  let symbol: String
  let isLive: Bool
  /// Why ADE Cloud can't start work now (blocked, out of hours): the
  /// server's sentence. The option still shows; it is off for new work.
  var refusal: String? = nil
  var isPrimary: Bool { machineKey == nil }
  var isCloud: Bool { machineKey == ADECloudMachine.id }
  var id: String { machineKey ?? "primary" }
}

/// The ADE Cloud option. Always listed, also before the account server
/// answers: every account has ADE Cloud.
@MainActor
func workNewChatCloudOption(store: AccountCloudStore = .shared) -> WorkNewChatMachineOption {
  WorkNewChatMachineOption(
    machineKey: ADECloudMachine.id,
    name: ADECloudMachine.name,
    symbol: ADECloudMachine.symbol,
    isLive: true,
    refusal: store.doingRefusal
  )
}

/// Whether the page starts on ADE Cloud: the tabs show a project no
/// computer of the person's own serves, or the account has no computer of
/// its own.
@MainActor
func workNewChatPrefersCloud(syncService: SyncService) -> Bool {
  if syncService.isAccountProjectScope { return true }
  return syncService.cloudServerReadFinished && !syncService.accountHasOwnComputer(AccountService.shared.machines)
    && syncService.activeProject != nil && syncService.connectionState != .connected
}

/// The options: the primary machine first (when a computer's project is
/// open), then connected machines, then the ones that are not connected (a
/// pick reconnects them), then ADE Cloud, always. Each cloud lane's own
/// computer is never an option of its own: ADE Cloud is one machine.
@MainActor
func workNewChatMachineOptions(syncService: SyncService, fleet: MachineFleet) -> [WorkNewChatMachineOption] {
  let primaryName = syncService.focusedMachineDisplayName
  var options: [WorkNewChatMachineOption] = []
  // An account project with no computer's copy: the focused computer does
  // not hold it, so it is no option.
  if !syncService.isAccountProjectScope, !syncService.isCloudFleetKey(syncService.focusedMachineKey) {
    options.append(WorkNewChatMachineOption(
      machineKey: nil,
      name: primaryName,
      symbol: machineSymbol(machineKey: syncService.focusedMachineKey, name: primaryName),
      isLive: syncService.connectionState == .connected
    ))
  }
  let others = syncService.remoteReposForActiveProject()
    .filter { !syncService.isCloudFleetKey($0.machineKey) }
    .map { repo in
    WorkNewChatMachineOption(
      machineKey: repo.machineKey,
      name: repo.machineName,
      symbol: machineSymbol(machineKey: repo.machineKey, name: repo.machineName),
      isLive: fleet.isLive(repo.machineKey)
    )
  }
  options += others.filter(\.isLive) + others.filter { !$0.isLive }
  let names = distinctMachineNames(options.map { option in
    (id: option.id, tagSource: option.machineKey ?? syncService.focusedMachineKey ?? option.id, name: option.name)
  })
  let named = options.map { option in
    guard let name = names[option.id], name != option.name else { return option }
    return WorkNewChatMachineOption(machineKey: option.machineKey, name: name, symbol: option.symbol, isLive: option.isLive)
  }
  return named + [workNewChatCloudOption()]
}

/// The name each machine shows in a picker, told apart when two share one.
/// Two of a person's computers often carry the same name (a Mac set up from
/// another keeps "Arul's Mac Studio"), and a picker listing it twice gives no
/// way to choose. Unique names come back as they are; within a group that
/// shares a name (case and spacing aside), each gets the end of its machine
/// key in brackets, long enough to tell them apart. Keyed by `id`. Tracks
/// `distinctMachineNames` on the desktop (`shared/machineIdentity.ts`); every
/// machine a phone lists is another computer, so none reads "This computer".
func distinctMachineNames(_ machines: [(id: String, tagSource: String, name: String)]) -> [String: String] {
  let groups = Dictionary(grouping: machines) { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
  var names: [String: String] = [:]
  for group in groups.values {
    guard group.count > 1 else {
      for machine in group { names[machine.id] = machine.name }
      continue
    }
    let plain = group.map { String($0.tagSource.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }).lowercased() }
    var length = 4
    var tags = plain.map { String($0.suffix(length)) }
    while Set(tags).count < tags.count, length < 32 {
      length += 2
      tags = plain.map { String($0.suffix(length)) }
    }
    for (index, machine) in group.enumerated() { names[machine.id] = "\(machine.name.trimmingCharacters(in: .whitespacesAndNewlines)) (\(tags[index]))" }
  }
  return machineNamesWithoutClashes(machines, names)
}

/// A label made in one group can match a name in another ("Studio (abcd)"
/// made for one of two Studios, beside a machine named "Studio (abcd)"). One
/// label of each clash is kept (one shown as it is named, when there is one)
/// and the rest take their whole key, which no other machine shares.
private func machineNamesWithoutClashes(_ machines: [(id: String, tagSource: String, name: String)], _ start: [String: String]) -> [String: String] {
  var names = start
  let byId = Dictionary(machines.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
  let clashes = Dictionary(grouping: names.keys.sorted()) { (names[$0] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    .values.filter { $0.count > 1 }
  for ids in clashes {
    let keep = ids.first { names[$0] == byId[$0]?.name } ?? ids[0]
    for id in ids where id != keep {
      let tag = String((byId[id]?.tagSource ?? id).filter { $0.isASCII && ($0.isLetter || $0.isNumber) }).lowercased()
      names[id] = "\((byId[id]?.name ?? id).trimmingCharacters(in: .whitespacesAndNewlines)) (\(tag))"
    }
  }
  return names
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
      let connected = options.filter { !$0.isCloud && ($0.isPrimary || $0.isLive) }
      if !connected.isEmpty {
        Section("Connected") {
          ForEach(connected) { option in
            Button {
              onSelect(option)
            } label: {
              Label(option.name, systemImage: option.symbol)
            }
          }
        }
      }
      // ADE Cloud is always here. When it can't start work now, the
      // server's reason shows under it and the pick is off.
      ForEach(options.filter(\.isCloud)) { option in
        Section {
          Button {
            onSelect(option)
          } label: {
            if let refusal = option.refusal {
              Label {
                Text(option.name)
                Text(refusal)
              } icon: {
                Image(systemName: option.symbol)
              }
            } else {
              Label(option.name, systemImage: option.symbol)
            }
          }
          .disabled(option.refusal != nil)
        }
      }
      let notLive = options.filter { !$0.isPrimary && !$0.isLive && !$0.isCloud }
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
          // As wide as the name, up to 140: the pill hugs "This machine"
          // instead of stretching, so the lane pill sits right beside it.
          .frame(maxWidth: 140, alignment: .leading)
          .fixedSize(horizontal: true, vertical: false)
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
