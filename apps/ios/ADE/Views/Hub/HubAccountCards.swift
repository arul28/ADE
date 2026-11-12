import SwiftUI

// The account's projects as Hub cards: which machine card shows which account
// project, the cards of projects no machine shows, each card's computer chip,
// and the saved order (account project ids, the same on every machine).
// Pure; `HubScreen` feeds them its state on each rebuild.

/// The account project whose page (home, Location) is open over the Hub.
struct HubAccountHomeTarget: Identifiable, Equatable {
  let id: String
}

// MARK: - Pages over the Hub

extension View {
  /// The account project pages the Hub opens: a project's home (an
  /// account-only card), its Location page, and Remove from ADE. `onNotice`
  /// shows the line a page ends with.
  func hubAccountProjectSheets(
    home: Binding<HubAccountHomeTarget?>,
    location: Binding<HubAccountHomeTarget?>,
    remove: Binding<AccountProject?>,
    onConnectComputer: @escaping () -> Void,
    onNotice: @escaping (String) -> Void
  ) -> some View {
    sheet(item: home) { target in
      AccountProjectHomeScreen(projectId: target.id, onConnectComputer: onConnectComputer, onRemoved: onNotice)
        .presentationDetents([.medium, .large])
    }
    .sheet(item: location) { target in
      ProjectLocationScreen(projectId: target.id)
    }
    .sheet(item: remove) { project in
      DeleteProjectSheet(project: project, onRemoved: onNotice)
        .presentationDetents([.medium, .large])
    }
  }
}

// MARK: - Status line

/// What the status line and the empty grid are decided from, read from the
/// phone's state now.
@MainActor
func hubAccountStatusInputs(
  sync: SyncService,
  account: AccountService,
  list: AccountProjectStore,
  fleetMachines: [MachineFleet.Machine],
  hasCards: Bool,
  canAddProject: Bool
) -> HubAccountStatusInputs {
  HubAccountStatusInputs(
    governedByAccount: list.governsHub,
    listPhase: list.phase,
    listHasSavedCopy: list.hasList,
    // A project switch can re-dial; it is not a lost computer.
    focusedState: sync.isProjectSwitching ? .connected : sync.connectionState,
    focusedDisconnectedByUser: sync.primaryDisconnectedByUser,
    // The machine attached, or the one a connect in flight or just failed
    // targeted (the header pill names the same one).
    focusedMachineName: sync.focusedMachineAccountName
      ?? sync.connectAttemptTarget.flatMap {
        accountMachinePresentationName(hostIdentity: $0.machineIdentity, fallback: $0.machineName, machines: account.machines)
      },
    focusedLastSeen: hubAccountRelativeTime(epochMs: account.machine(forFleetKey: sync.focusedMachineKey)?.lastSeenAt),
    anyFleetMachineLive: fleetMachines.contains { $0.state == .live },
    anyFleetMachineConnecting: fleetMachines.contains { $0.isPinned && $0.state == .connecting },
    hasPairedComputer: sync.canReconnectToSavedHost || !fleetMachines.isEmpty,
    accountHasComputers: !account.machines.isEmpty,
    hasCards: hasCards,
    canAddProject: canAddProject
  )
}

// MARK: - Join input

/// The cards as the account join sees them: each card's GitHub address and
/// every machine folder behind it, by account machine key and registry id.
/// `accountMachineKey` maps a phone (fleet) key to its account machine key.
func hubAccountJoinCards(
  focused: [(project: MobileProjectSummary, roster: RemoteRosterProject?)],
  merge: HubFleetMerge,
  focusedAccountKey: String?,
  accountMachineKey: (String) -> String?
) -> [HubAccountJoinCard] {
  func locationRefs(_ cardId: String) -> [HubAccountCopyRef] {
    (merge.projectLocations[cardId] ?? []).compactMap { location in
      accountMachineKey(location.machineKey).map { HubAccountCopyRef(accountMachineKey: $0, checkoutId: location.project.id) }
    }
  }
  var cards = focused.map { entry in
    HubAccountJoinCard(
      cardId: entry.project.id,
      gitHubIdentity: workRepoIdentity(owner: entry.project.repoOwner, name: entry.project.repoName)
        ?? hubGitHubRepoIdentity(originUrl: entry.roster?.repoOriginUrl),
      copies: (focusedAccountKey.map { [HubAccountCopyRef(accountMachineKey: $0, checkoutId: entry.project.id)] } ?? [])
        + locationRefs(entry.project.id),
      accountProjectId: merge.accountIdByCardId[entry.project.id]
    )
  }
  cards += merge.extraProjects.map { extra in
    HubAccountJoinCard(
      cardId: extra.summary.id,
      gitHubIdentity: hubGitHubRepoIdentity(originUrl: extra.roster.repoOriginUrl),
      copies: locationRefs(extra.summary.id),
      accountProjectId: merge.accountIdByCardId[extra.summary.id]
    )
  }
  return cards
}

// MARK: - The card pass

/// The machine cards after the account list had its say.
struct HubAccountCardPass {
  var presentations: [HubProjectPresentation]
  var join: HubAccountJoin
  /// Account projects no reachable machine shows, by card id (the project id).
  var accountOnly: [String: AccountProject]
  /// The icon each joined card shows now, kept for when no machine is
  /// reachable (`AccountProjectStore.recordDisplay`).
  var icons: [String: AccountProjectDisplay]
}

/// Pure: match each card to its account project, hide cards of removed
/// projects, add a card for every project no machine shows, and name each
/// joined card by the account. The account has no icon, so a joined card
/// keeps the icon its machine sends (the shared project icon), then the
/// saved one.
func hubAccountCardPass(
  presentations: [HubProjectPresentation],
  cards: [HubAccountJoinCard],
  live: [AccountProject],
  removed: [AccountProject],
  merged: [String: String],
  display: [String: AccountProjectDisplay],
  machines: [AccountMachine]
) -> HubAccountCardPass {
  let join = hubJoinAccountProjects(cards: cards, live: live, removed: removed, merged: merged)
  var next = presentations.filter { !join.hiddenCardIds.contains($0.project.id) }
  var icons: [String: AccountProjectDisplay] = [:]
  for presentation in next {
    guard let accountId = join.accountIdByCardId[presentation.project.id] else { continue }
    icons[accountId] = AccountProjectDisplay(iconDataUrl: presentation.project.iconDataUrl)
  }
  let projectsById = Dictionary(live.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
  next = next.map { presentation in
    guard let accountId = join.accountIdByCardId[presentation.project.id],
          let accountProject = projectsById[accountId]
    else { return presentation }
    return presentation.showing(
      name: accountProject.name,
      iconDataUrl: presentation.project.iconDataUrl ?? display[accountId]?.iconDataUrl
    )
  }
  var accountOnly: [String: AccountProject] = [:]
  for project in join.unmatchedProjects {
    accountOnly[project.id] = project
    next.append(HubProjectPresentation(
      project: hubAccountProjectSummary(project, display: display[project.id]),
      isActive: false,
      isSwitching: false,
      isLoading: false,
      laneCount: 0,
      chatCount: 0,
      lanes: [],
      note: hubAccountProjectNote(project, machines: machines)
    ))
  }
  return HubAccountCardPass(presentations: next, join: join, accountOnly: accountOnly, icons: icons)
}

// MARK: - Computer chip

/// A card's computer chip: a name or "N computers", how many computers, and
/// (for an account project) how many are connected now.
struct HubComputerChip: Equatable {
  var label: String?
  var total: Int
  var live: Int?
}

/// A computer that shows a joined card's folder now.
struct HubChipHolder: Equatable {
  let accountKey: String
  let name: String?
  let isLive: Bool
}

/// Pure: the chip of a card of an account project. It counts every computer
/// with a copy (the account's copies and the machines that show the card's
/// folders), and how many of them are connected.
func hubAccountProjectChip(_ project: AccountProject, holders: [HubChipHolder], machines: [AccountMachine]) -> HubComputerChip {
  var all = Set(project.copies.map(\.machineKey))
  var live = Set<String>()
  var names: [String: String] = [:]
  for holder in holders {
    all.insert(holder.accountKey)
    if let name = holder.name { names[holder.accountKey] = name }
    if holder.isLive { live.insert(holder.accountKey) }
  }
  let label: String?
  if all.count > 1 {
    label = "\(all.count) computers"
  } else if let key = all.first {
    label = names[key] ?? machines.first { $0.machineKey == key }?.displayName
  } else {
    label = nil
  }
  return HubComputerChip(label: label, total: all.count, live: live.count)
}

/// Pure: the chip of a project no reachable machine shows: the computers
/// that hold a folder of it. The name is unknown until the computer list
/// loads; the count still shows.
func hubAccountOnlyChip(_ project: AccountProject, machines: [AccountMachine]) -> HubComputerChip {
  let held = accountProjectCopyMachines(project, machines: machines)
  let label = held.count > 1 ? "\(held.count) computers" : held.first?.machine?.displayName
  return HubComputerChip(label: label, total: held.count, live: nil)
}

// MARK: - Saved order

/// Pure: the saved order with each id that `map` names replaced (a merged
/// project by the one it became, a machine's folder id by its account
/// project), keeping the first place of each id. Nil when no id changes.
func hubRedirectedOrder(_ order: [String], through map: [String: String]) -> [String]? {
  guard order.contains(where: { map[$0] != nil }) else { return nil }
  var seen = Set<String>()
  return order.map { map[$0] ?? $0 }.filter { seen.insert($0).inserted }
}

/// Pure: one order for every card. The saved order comes first; the rest
/// keep the order they came in (the focused machine's by name, then the
/// others, then the account-only cards).
func hubOrderedPresentations(
  _ presentations: [HubProjectPresentation],
  order: [String],
  orderKey: (String) -> String
) -> [HubProjectPresentation] {
  let rankById = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
  return presentations.enumerated().sorted { lhs, rhs in
    switch (rankById[orderKey(lhs.element.project.id)], rankById[orderKey(rhs.element.project.id)]) {
    case let (l?, r?): return l < r
    case (.some, .none): return true
    case (.none, .some): return false
    case (.none, .none): return lhs.offset < rhs.offset
    }
  }.map(\.element)
}

/// Pure: the order with `id` first.
func hubOrderMovingToTop(_ order: [String], id: String) -> [String] {
  [id] + order.filter { $0 != id }
}

/// Pure: the order with `draggedId` moved into `targetId`'s slot (the end
/// when the order does not name the target). Nil when nothing moves.
func hubOrderMoving(_ order: [String], _ draggedId: String, onto targetId: String) -> [String]? {
  guard draggedId != targetId, let from = order.firstIndex(of: draggedId) else { return nil }
  var next = order
  next.remove(at: from)
  next.insert(draggedId, at: next.firstIndex(of: targetId) ?? next.count)
  return next
}

/// Pure: the cards the order does not name yet, by name. Ids are never
/// dropped: a short disconnect can empty the roster for a moment.
func hubNewOrderIds(order: [String], cards: [(key: String, name: String)]) -> [String] {
  let ordered = Set(order)
  return cards
    .filter { !ordered.contains($0.key) }
    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    .map(\.key)
}

/// The hub's saved layout: the user's manual project order. Persisted to the
/// App Group so opening a project and returning restores the hub exactly.
/// (Older saves also carry collapse keys from the list layout; decoding
/// ignores them.)
struct HubLayoutState: Codable, Equatable {
  var order: [String] = []
}

enum HubLayoutStore {
  private static let accountPrefix = "account|"

  /// The account-wide order (v2): account project ids, the same on every
  /// machine. The per-machine orders (v1) stay as they were.
  static func accountKey(userId: String) -> String { accountPrefix + userId }

  static func isAccountKey(_ key: String) -> Bool { key.hasPrefix(accountPrefix) }

  private static func defaultsKey(_ connectionKey: String) -> String {
    if isAccountKey(connectionKey) {
      return "ade.hub.layout.v2|\(connectionKey.dropFirst(accountPrefix.count))"
    }
    return "ade.hub.layout.v1|\(connectionKey)"
  }

  static func load(_ connectionKey: String) -> HubLayoutState {
    guard let data = ADESharedContainer.defaults.data(forKey: defaultsKey(connectionKey)),
          let state = try? JSONDecoder().decode(HubLayoutState.self, from: data)
    else { return HubLayoutState() }
    return state
  }

  static func save(_ state: HubLayoutState, for connectionKey: String) {
    guard let data = try? JSONEncoder().encode(state) else { return }
    ADESharedContainer.defaults.set(data, forKey: defaultsKey(connectionKey))
  }
}
