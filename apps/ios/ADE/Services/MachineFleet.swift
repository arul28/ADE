import Combine
import Foundation
import OSLog

private let machineFleetLog = Logger(subsystem: "com.ade.ios", category: "fleet")

/// The phone's live view of every paired machine other than the focused one.
///
/// `SyncService` keeps the focused machine's full connection. The fleet keeps
/// one light roster connection (`MachineConnection`) to each other machine, up
/// to `liveMachineLimit` machines in total, and publishes their rosters for the
/// Hub and the Work tab. It publishes on its own, so a roster delta from
/// another machine never re-renders the views that observe `SyncService`.
///
/// Policy (the desktop machine model):
/// - The user chooses which machines are connected (Settings > Machines). Only
///   those get a roster connection; the rest stay listed as available.
/// - The open project connects every paired machine with a copy of it, with
///   no pick (`setProjectMachines`). Those come first; a machine the user
///   disconnected in Settings stays off.
/// - At most 8 machines live at once, the focused ("primary") one included.
///   A wanted machine past the limit is parked: its rows show, dimmed.
/// - All roster connections close when the app goes to the background, and
///   open again on foreground.
/// - A roster connection never runs to the focused machine (the host keeps one
///   socket per phone per machine).
@MainActor
final class MachineFleet: ObservableObject {
  nonisolated static let liveMachineLimit = 8
  private static let pinnedKeysDefaultsKey = "ade.fleet.pinnedMachineKeys.v1"
  /// Machines the user disconnected in Settings: the open project does not
  /// connect them again until the user connects them.
  private static let userDisconnectedKeysDefaultsKey = "ade.fleet.userDisconnectedMachineKeys.v1"
  /// Set once the pins became the user's connected set. Before, every paired
  /// machine was live up to the limit; the first reconcile after the change
  /// pins those machines so nothing the user had drops.
  private static let connectedSetMigratedKey = "ade.fleet.connectedSetMigrated.v2"
  private static let needsUpdateRetryInterval: TimeInterval = 30 * 60

  enum MachineState: Equatable {
    case live
    case connecting
    case offline(message: String?)
    /// Not in the user's connected set: listed as available, shows its last
    /// roster, connects on demand.
    case paused
    /// The app is in the background (all roster connections closed).
    case inactive
    case needsUpdate
    case needsAttention(message: String)
  }

  /// A connect past the limit dropped the least recently chosen computer.
  struct MachineAutoDisconnectNotice: Equatable {
    let id = UUID()
    let names: [String]

    var message: String {
      "Disconnected \(names.joined(separator: ", ")) to stay at \(MachineFleet.liveMachineLimit) live computers."
    }
  }

  @Published var autoDisconnectNotice: MachineAutoDisconnectNotice?

  struct Machine: Identifiable, Equatable {
    let machineKey: String
    var name: String
    var state: MachineState
    var projects: [RemoteRosterProject]
    var rosterRevision: Int
    var lastUpdateAt: Date?
    var isPinned: Bool
    /// In the connected set or the open project's machines: wanted live.
    /// Settings lists it as connected, with Disconnect.
    var isWanted: Bool = false
    /// Wanted live (connected set or the open project's copy) but past the
    /// live limit: shown as parked.
    var isParked: Bool = false
    /// The user disconnected it in Settings.
    var isDisconnectedByUser: Bool = false
    /// Ran out of retries: "Offline · Tap to retry" until a retry trigger.
    var gaveUp: Bool = false
    /// The route its live link actually took.
    var routeKind: SyncConnectionRouteKind? = nil
    /// The machine's ADE version from its last hello, nil for an older host.
    var appVersion: String? = nil
    var id: String { machineKey }
  }

  /// Every paired machine except the focused one, in display order.
  @Published private(set) var machines: [Machine] = []
  /// Paired machines in total, the focused one included.
  @Published private(set) var pairedMachineCount = 0

  /// The machines with a live link, by key, sorted: a stable key for work
  /// that reruns when a machine's link comes or goes.
  var liveMachineKeys: [String] {
    machines.filter { $0.state == .live }.map(\.machineKey).sorted()
  }

  private weak var syncService: SyncService?
  private var connections: [String: MachineConnection] = [:]
  private var appActive = false
  private var reconcileScheduled = false
  private var publishScheduled = false
  private var needsUpdateSince: [String: Date] = [:]
  private var needsUpdateRetryTask: Task<Void, Never>?
  private var needsUpdateRetryDue: Date?
  private var pinnedKeys: [String]
  private var userDisconnectedKeys: Set<String>
  /// The paired machines with a copy of the open project, best first. Live
  /// before the rest of the connected set. Not saved: it follows the project.
  private var projectMachineKeys: [String] = []
  /// The machine the user asked for last (Connect, open its chat): live
  /// before the project's machines, so it never waits parked. Not saved.
  private var requestedKey: String?
  /// Counts the user's connect choices. A failed connect undoes its swap
  /// only while no newer choice came after it.
  private var keepLiveChoices = 0
  private var projectMachinesScheduled = false
  private var projectCancellables: Set<AnyCancellable> = []
  private var lastOrder: [String] = []
  private var lastPublishedPhase: [String: MachineConnection.Phase] = [:]
  private var lastLiveKeys: Set<String> = []
  private let hiddenMachines: HiddenMachineStore
  private var hiddenCancellables: Set<AnyCancellable> = []
  /// Fleet keys of the machines the account showed online at its last load.
  private var accountOnlineKeys: Set<String> = []

  init() {
    pinnedKeys = UserDefaults.standard.stringArray(forKey: Self.pinnedKeysDefaultsKey) ?? []
    userDisconnectedKeys = Set(UserDefaults.standard.stringArray(forKey: Self.userDisconnectedKeysDefaultsKey) ?? [])
    hiddenMachines = HiddenMachineStore.shared
  }

  func attach(_ syncService: SyncService) {
    guard self.syncService !== syncService else { return }
    self.syncService = syncService
    syncService.machineFleet = self
    observeHiddenMachines()
    observeOpenProject(syncService)
    scheduleReconcile()
  }

  /// The open project, the account's copies, the account's computers and
  /// the rosters decide which machines the project needs live.
  private func observeOpenProject(_ syncService: SyncService) {
    projectCancellables.removeAll()
    syncService.$activeProjectId
      .removeDuplicates()
      .receive(on: DispatchQueue.main)
      .sink { [weak self] _ in
        MainActor.assumeIsolated { self?.scheduleProjectMachinesUpdate() }
      }
      .store(in: &projectCancellables)
    AccountProjectStore.shared.objectWillChange
      .receive(on: DispatchQueue.main)
      .sink { [weak self] _ in
        MainActor.assumeIsolated { self?.scheduleProjectMachinesUpdate() }
      }
      .store(in: &projectCancellables)
    // A copy's computer maps to a paired machine, and comes online, through
    // the account's machine list, which can load after the project opens.
    AccountService.shared.$machines
      .receive(on: DispatchQueue.main)
      .sink { [weak self] _ in
        MainActor.assumeIsolated { self?.scheduleProjectMachinesUpdate() }
      }
      .store(in: &projectCancellables)
  }

  /// Recomputes the open project's machines once per run-loop turn.
  func scheduleProjectMachinesUpdate() {
    guard !projectMachinesScheduled else { return }
    projectMachinesScheduled = true
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.projectMachinesScheduled = false
        guard let syncService = self.syncService else { return }
        self.setProjectMachines(syncService.activeProjectCopyMachineKeys())
        if self.appActive { syncService.connectActiveProjectAccountCopies() }
      }
    }
  }

  /// The machines with a copy of the open project: kept live before the rest
  /// of the connected set, within the limit, with no pick and no toast. A
  /// machine the user disconnected in Settings is left out.
  func setProjectMachines(_ keys: [String]) {
    var seen = Set<String>()
    let next = keys.filter { !userDisconnectedKeys.contains($0) && seen.insert($0).inserted }
    guard next != projectMachineKeys else { return }
    projectMachineKeys = next
    scheduleReconcile()
  }

  /// A machine the user removed from this phone's lists gets no roster
  /// connection and no place in the Hub or Work merges. The account directory
  /// decides when it comes back (see `HiddenMachineStore.reconcile`).
  private func observeHiddenMachines() {
    guard hiddenCancellables.isEmpty else { return }
    let account = AccountService.shared
    account.$identity
      .map { $0?.userId }
      .removeDuplicates()
      .receive(on: DispatchQueue.main)
      .sink { [weak self] userId in
        MainActor.assumeIsolated { self?.hiddenMachines.setAccountScope(userId) }
      }
      .store(in: &hiddenCancellables)
    Publishers.CombineLatest(account.$machines, account.$machinesState)
      .receive(on: DispatchQueue.main)
      .sink { [weak self] machines, state in
        // Only a loaded list says anything about presence. An empty list while
        // loading would read as "every hidden machine left the account" and
        // bring them all back on the next load.
        guard state == .loaded else { return }
        MainActor.assumeIsolated {
          // A machine the account now shows online (it was not before) may
          // answer: dial it again if it had run out of retries.
          guard let self else { return }
          let online = Set(machines.compactMap { machine -> String? in
            guard machine.online, let deviceId = nonEmptyTrimmed(machine.deviceId) else { return nil }
            return HiddenMachineStore.fleetKey(deviceId: deviceId)
          })
          let cameOnline = online.subtracting(self.accountOnlineKeys)
          self.accountOnlineKeys = online
          // Machine names come from the directory: a rename shows at once.
          self.schedulePublish()
          self.machinesCameOnline(machineKeys: cameOnline)
          self.hiddenMachines.reconcile(
            // Both keys a row can be hidden under: the device identity, and
            // `account:<machine key>` for a directory row without one.
            accountMachines: machines.flatMap { machine in
              [nonEmptyTrimmed(machine.deviceId), "account:\(machine.machineKey)"]
                .compactMap { $0 }
                .map { (identity: $0, online: machine.online) }
            }
          )
        }
      }
      .store(in: &hiddenCancellables)
    hiddenMachines.$records
      .dropFirst()
      .sink { [weak self] _ in
        MainActor.assumeIsolated { self?.scheduleReconcile() }
      }
      .store(in: &hiddenCancellables)
  }

  var liveOtherMachineLimit: Int {
    let hasFocus = syncService?.focusedMachineKey != nil
    return max(0, Self.liveMachineLimit - (hasFocus ? 1 : 0))
  }

  // MARK: - Signals

  func setAppActive(_ active: Bool) {
    guard appActive != active else { return }
    appActive = active
    if !active {
      for connection in connections.values {
        connection.stop(reason: "App in background.")
      }
      publish()
    } else {
      resumeGivenUpConnections()
      reconcile()
      scheduleProjectMachinesUpdate()
    }
  }

  /// The phone's network changed: machines that ran out of retries may be
  /// reachable now.
  func networkChanged() {
    resumeGivenUpConnections()
    reconcile()
  }

  /// The account shows these machines online: dial the ones that ran out of
  /// retries again.
  func machinesCameOnline(machineKeys: Set<String>) {
    guard !machineKeys.isEmpty else { return }
    for key in machineKeys {
      connections[key]?.dialSoonerIfWaiting()
    }
    reconcile()
  }

  /// Every connection waiting out a backoff, or that gave up, dials again.
  private func resumeGivenUpConnections() {
    for connection in connections.values {
      connection.dialSoonerIfWaiting()
    }
  }

  /// Called synchronously before the focused connection dials `machineKey`.
  /// Closes any roster connection to it first.
  func focusedWillDial(machineKey: String) {
    guard let connection = connections[machineKey], connection.isRunning || connection.isLive else { return }
    machineFleetLog.notice("fleet yields machine=\(machineKey, privacy: .public) to focused dial")
    connection.stop(reason: "Machine focused.")
    schedulePublish()
  }

  func focusedConnectionChanged() {
    scheduleReconcile()
  }

  /// Saved machines were added, removed or re-paired.
  func savedMachinesChanged() {
    scheduleReconcile()
  }

  /// Sign-out or account switch: close everything and forget in-memory rosters.
  func reset() {
    for connection in connections.values {
      connection.stop(reason: "Signed out.", clearAttention: true)
    }
    connections.removeAll()
    needsUpdateSince.removeAll()
    needsUpdateRetryTask?.cancel()
    needsUpdateRetryTask = nil
    needsUpdateRetryDue = nil
    machines = []
    pairedMachineCount = 0
    projectMachineKeys = []
    requestedKey = nil
  }

  // MARK: - Queries

  func connection(for machineKey: String) -> MachineConnection? {
    connections[machineKey]
  }

  func machine(for machineKey: String) -> Machine? {
    machines.first { $0.machineKey == machineKey }
  }

  /// The machine has a live roster link now.
  func isLive(_ machineKey: String) -> Bool {
    machine(for: machineKey)?.state == .live
  }

  /// Connects `machineKey` (adds it to the connected set and dials it) and
  /// waits up to `timeout` for a live link. False when it needs the user,
  /// runs out of retries, or is not live in time. A machine that this call
  /// pushed out of a full connected set comes back when the link fails.
  func connect(machineKey: String, timeout: Duration = .seconds(10)) async -> Bool {
    if isLive(machineKey) { return true }
    let pinsBefore = pinnedKeys
    keepLive(machineKey: machineKey)
    let choice = keepLiveChoices
    let dropped = pinsBefore.filter { !pinnedKeys.contains($0) }
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline, !Task.isCancelled {
      guard let machine = machine(for: machineKey) else { break }
      if machine.state == .live { return true }
      if machine.gaveUp { break }
      if case .needsAttention = machine.state { break }
      try? await Task.sleep(for: .milliseconds(250))
    }
    if isLive(machineKey) { return true }
    // A newer choice (this machine again, or another one) is what the user
    // wants now: this older attempt leaves the set as that choice made it.
    if choice == keepLiveChoices {
      givePlaceBack(afterFailedConnectOf: machineKey, dropped: dropped, wasPinned: pinsBefore.contains(machineKey))
    }
    return false
  }

  /// Undoes the swap `keepLive` made for a connect that never went live: the
  /// machines it dropped return (as the oldest), and the failed one leaves
  /// the set. Nothing changes when the set had room. A machine the user
  /// disconnected meanwhile stays off.
  private func givePlaceBack(afterFailedConnectOf machineKey: String, dropped: [String], wasPinned: Bool) {
    let returning = dropped.filter { !pinnedKeys.contains($0) && !userDisconnectedKeys.contains($0) }
    guard !returning.isEmpty else { return }
    if !wasPinned { pinnedKeys.removeAll { $0 == machineKey } }
    pinnedKeys.append(contentsOf: returning)
    if requestedKey == machineKey { requestedKey = nil }
    persistPins()
    reconcile()
  }

  // MARK: - User choices

  /// Adds `machineKey` to the user's connected set and dials it now, also when
  /// it had asked for attention or had run out of retries. The caller keeps
  /// the set under the limit (Settings asks which machine to disconnect);
  /// past it, the oldest choice other than the primary machine falls off.
  func keepLive(machineKey: String) {
    keepLiveChoices += 1
    if userDisconnectedKeys.remove(machineKey) != nil { persistUserDisconnected() }
    requestedKey = machineKey
    pinnedKeys.removeAll { $0 == machineKey }
    pinnedKeys.insert(machineKey, at: 0)
    // The primary machine may sit in the set (it stays connected when another
    // machine becomes primary); it never counts toward the limit.
    let focused = syncService?.focusedMachineKey
    var others = 0
    let before = pinnedKeys
    pinnedKeys = pinnedKeys.filter { key in
      guard key != focused else { return true }
      others += 1
      return others <= liveOtherMachineLimit
    }
    let dropped = before.filter { !pinnedKeys.contains($0) }
    if !dropped.isEmpty {
      // The swap happens without a question; the Hub says which one went.
      autoDisconnectNotice = MachineAutoDisconnectNotice(
        names: dropped.map { machine(for: $0)?.name ?? "a computer" }
      )
    }
    persistPins()
    if let connection = connections[machineKey] {
      if case .needsAttention = connection.phase {
        connection.stop(reason: "Retry.", clearAttention: true)
      }
      // Tapping Connect means now, not after the rest of a backoff wait.
      connection.dialSoonerIfWaiting()
    }
    needsUpdateSince.removeValue(forKey: machineKey)
    reconcile()
  }

  func stopKeepingLive(machineKey: String) {
    pinnedKeys.removeAll { $0 == machineKey }
    if requestedKey == machineKey { requestedKey = nil }
    persistPins()
    // The open project does not connect it again behind the user's back.
    if userDisconnectedKeys.insert(machineKey).inserted { persistUserDisconnected() }
    projectMachineKeys.removeAll { $0 == machineKey }
    reconcile()
  }

  /// The user's connected set (other than the focused machine), least recently
  /// connected first: who to offer when a new machine would go over the limit.
  var connectedMachinesLeastRecentFirst: [Machine] {
    let focused = syncService?.focusedMachineKey
    return pinnedKeys.reversed().filter { $0 != focused }.compactMap(machine(for:))
  }

  /// True when connecting one more machine would go over the limit.
  var isAtLiveLimit: Bool { isAtLiveLimit(pending: 0) }

  /// True when `pending` more machines (pairings still in flight) plus one
  /// more would go over the limit.
  func isAtLiveLimit(pending: Int) -> Bool {
    let focused = syncService?.focusedMachineKey
    let connectedOthers = pinnedKeys.filter { $0 != focused }.count
    return connectedOthers + pending >= liveOtherMachineLimit
  }

  /// Adds `machineKey` to the connected set without dialing it, e.g. the
  /// machine that stops being primary stays connected.
  func markConnected(machineKey: String) {
    if userDisconnectedKeys.remove(machineKey) != nil { persistUserDisconnected() }
    guard !pinnedKeys.contains(machineKey) else { return }
    pinnedKeys.insert(machineKey, at: 0)
    persistPins()
    scheduleReconcile()
  }

  /// Retry a machine that asked for attention or an update.
  func retry(machineKey: String) {
    needsUpdateSince.removeValue(forKey: machineKey)
    connections[machineKey]?.stop(reason: "Retry.", clearAttention: true)
    reconcile()
  }

  // MARK: - Reconcile

  /// One pending wake-up for the earliest "update needed" wait that ends.
  private func scheduleNeedsUpdateRetry(after seconds: TimeInterval) {
    let due = Date().addingTimeInterval(seconds)
    if let needsUpdateRetryDue, needsUpdateRetryDue <= due { return }
    needsUpdateRetryDue = due
    needsUpdateRetryTask?.cancel()
    needsUpdateRetryTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(max(1, seconds) * 1_000_000_000))
      guard let self, !Task.isCancelled else { return }
      self.needsUpdateRetryDue = nil
      self.needsUpdateRetryTask = nil
      self.reconcile()
    }
  }

  private func scheduleReconcile() {
    guard !reconcileScheduled else { return }
    reconcileScheduled = true
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.reconcileScheduled = false
        self.reconcile()
      }
    }
  }

  func reconcile() {
    guard let syncService else { return }
    let focusedKey = syncService.focusedMachineKey
    // Focusing a machine is the phone connecting to it: a hidden machine the
    // user connects to again is back in the lists.
    if let focusedKey,
       let identity = HiddenMachineStore.identity(fromFleetKey: focusedKey)
         ?? syncService.activeHostProfile.flatMap(HiddenMachineStore.nameIdentity(for:)),
       hiddenMachines.isHidden(identity: identity) {
      hiddenMachines.unhide(identity: identity)
    }
    // Hidden machines are treated exactly like unpaired ones below: their
    // roster connection is closed and dropped. The pairing itself is kept.
    let profiles = syncService.fleetMachineProfiles().filter { entry in
      guard let identity = HiddenMachineStore.identity(fromFleetKey: entry.machineKey)
        ?? HiddenMachineStore.nameIdentity(for: entry.profile)
      else { return true }
      return !hiddenMachines.isHidden(identity: identity)
    }
    let blocked = syncService.fleetBlockedMachineKeys
    let profileKeys = Set(profiles.map(\.machineKey))
    pairedMachineCount = profileKeys.union(focusedKey.map { [$0] } ?? []).count

    // Machines that are no longer paired: close and drop.
    for key in connections.keys where !profileKeys.contains(key) {
      connections[key]?.stop(reason: "Machine removed.", clearAttention: true)
      connections.removeValue(forKey: key)
      needsUpdateSince.removeValue(forKey: key)
    }
    let prunedPins = pinnedKeys.filter { profileKeys.contains($0) }
    if prunedPins != pinnedKeys {
      pinnedKeys = prunedPins
      persistPins()
    }

    let others = profiles.filter { $0.machineKey != focusedKey }
    for entry in others {
      if let existing = connections[entry.machineKey] {
        existing.updateProfile(entry.profile)
      } else {
        let connection = MachineConnection(
          machineKey: entry.machineKey,
          profile: entry.profile,
          syncService: syncService,
          registry: syncService.chatThreadRegistry
        )
        connection.onChange = { [weak self] in self?.connectionChanged(connection) }
        connections[entry.machineKey] = connection
      }
    }
    // The focused machine keeps its full connection in SyncService.
    if let focusedKey, let focused = connections[focusedKey], focused.isRunning || focused.isLive {
      focused.stop(reason: "Machine focused.")
    }

    // The machine the user just asked for, then the open project's machines,
    // then the rest of the user's connected set. A project machine past the
    // limit parks; the one the user asked for never does.
    let order = liveOrder(
      candidates: others.map(\.machineKey),
      pinnedFirst: (requestedKey.map { [$0] } ?? []) + projectMachineKeys + pinnedKeys
    )
    if !UserDefaults.standard.bool(forKey: Self.connectedSetMigratedKey), !others.isEmpty {
      pinnedKeys = Array(order.prefix(liveOtherMachineLimit))
      persistPins()
      UserDefaults.standard.set(true, forKey: Self.connectedSetMigratedKey)
    }
    // Only the machines the user connected, and the open project's, are live.
    let wanted = wantedKeys
    let liveKeys = Set(order.filter { wanted.contains($0) }.prefix(liveOtherMachineLimit))
    let now = Date()
    for key in order {
      guard let connection = connections[key] else { continue }
      let wantsLive = appActive && liveKeys.contains(key) && !blocked.contains(key)
      if wantsLive {
        if let since = needsUpdateSince[key] {
          let remaining = Self.needsUpdateRetryInterval - now.timeIntervalSince(since)
          if remaining > 0 {
            // Try again when the wait ends: the machine may be updated by then.
            scheduleNeedsUpdateRetry(after: remaining)
            continue
          }
        }
        connection.start()
      } else if connection.isRunning || connection.isLive {
        connection.stop(reason: liveKeys.contains(key) ? "Machine focused." : "Over the live machine limit.")
      }
    }
    publish(order: order, liveKeys: liveKeys)
  }

  /// Pinned machines first (in the user's order), then the rest in the order
  /// given (most recently used first).
  private func liveOrder(candidates: [String], pinnedFirst: [String]) -> [String] {
    let candidateSet = Set(candidates)
    var seen = Set<String>()
    var order: [String] = []
    for key in pinnedFirst where candidateSet.contains(key) && seen.insert(key).inserted {
      order.append(key)
    }
    for key in candidates where seen.insert(key).inserted {
      order.append(key)
    }
    return order
  }

  private func connectionChanged(_ connection: MachineConnection) {
    if connection.phase == .needsUpdate {
      needsUpdateSince[connection.machineKey] = Date()
    }
    if lastPublishedPhase[connection.machineKey] != connection.phase {
      lastPublishedPhase[connection.machineKey] = connection.phase
      syncService?.fleetConnectionPhaseChanged(machineKey: connection.machineKey)
    }
    schedulePublish()
  }

  private func schedulePublish() {
    guard !publishScheduled else { return }
    publishScheduled = true
    // Coalesce bursts of roster deltas from several machines into one publish
    // per run-loop turn.
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.publishScheduled = false
        self.publish()
      }
    }
  }

  /// Republish with the order and live set of the last reconcile. Roster
  /// deltas land here; they must not re-read saved profiles or the keychain.
  private func publish() {
    publish(order: lastOrder, liveKeys: lastLiveKeys)
  }

  private func publish(order: [String], liveKeys: Set<String>) {
    lastOrder = order
    lastLiveKeys = liveKeys
    let pinned = Set(pinnedKeys)
    let wanted = wantedKeys
    let next: [Machine] = order.compactMap { key -> Machine? in
      guard let connection = connections[key] else { return nil }
      let state: MachineState
      if !liveKeys.contains(key) {
        state = .paused
      } else if !appActive {
        state = .inactive
      } else {
        switch connection.phase {
        case .live: state = .live
        case .connecting, .idle: state = .connecting
        case .offline(let message): state = .offline(message: message)
        case .needsUpdate: state = .needsUpdate
        case .needsAttention(let message): state = .needsAttention(message: message)
        }
      }
      return Machine(
        machineKey: key,
        // The account's name for the machine, as Settings lists it.
        name: accountMachinePresentationName(
          hostIdentity: HiddenMachineStore.identity(fromFleetKey: key),
          fallback: connection.hostName ?? nonEmptyTrimmed(connection.profile.hostName),
          machines: AccountService.shared.machines
        ) ?? "Machine",
        state: state,
        projects: connection.rosterProjectsIncludingOlderChats,
        rosterRevision: connection.rosterRevision,
        lastUpdateAt: connection.lastUpdateAt,
        isPinned: pinned.contains(key),
        isWanted: wanted.contains(key),
        isParked: !liveKeys.contains(key) && wanted.contains(key),
        isDisconnectedByUser: userDisconnectedKeys.contains(key),
        gaveUp: connection.gaveUp,
        routeKind: state == .live ? connection.liveRouteKind : nil,
        appVersion: connection.hostAppVersion
      )
    }
    if next != machines {
      // A roster can add or drop a copy of the open project.
      let rostersChanged = !next.elementsEqual(machines) {
        $0.machineKey == $1.machineKey && $0.rosterRevision == $1.rosterRevision
      }
      machines = next
      if rostersChanged { scheduleProjectMachinesUpdate() }
    }
  }

  /// How many more of the open project's machines could go live. The rest
  /// of the connected set does not count: project machines go live before
  /// it, and it parks instead.
  var projectMachineRoom: Int {
    let focused = syncService?.focusedMachineKey
    return max(0, liveOtherMachineLimit - projectMachineKeys.filter { $0 != focused }.count)
  }

  /// The machines that should be live: the user's connected set and the open
  /// project's machines.
  private var wantedKeys: Set<String> {
    Set(pinnedKeys).union(projectMachineKeys)
  }

  private func persistPins() {
    UserDefaults.standard.set(pinnedKeys, forKey: Self.pinnedKeysDefaultsKey)
  }

  private func persistUserDisconnected() {
    UserDefaults.standard.set(userDisconnectedKeys.sorted(), forKey: Self.userDisconnectedKeysDefaultsKey)
  }
}

/// Machines the user removed from this phone's lists with "Remove from this
/// list" (Settings > Machines). Persisted per signed-in account on this device.
///
/// Hiding is not forgetting: a saved pairing keeps its credential, so bringing
/// the machine back never needs a new PIN. What hiding does is keep the machine
/// out of Settings > Machines, out of the Hub and Work merges, and out of the
/// fleet's roster connections.
///
/// Only a machine that is gone (off the account, or offline) stays hidden. A
/// machine the account shows online is always listed, as Available when this
/// phone holds no pairing for it: hiding an online machine left it with no way
/// back while it stayed on (a desktop that never sleeps), short of signing out.
/// So hiding a machine that is online right now only drops it from lists until
/// the next directory load, and a hidden offline machine reappears as soon as
/// it is online again, or the moment the phone connects to it.
@MainActor
final class HiddenMachineStore: ObservableObject {
  static let shared = HiddenMachineStore()

  struct Record: Codable, Equatable {
    var hiddenAt: Date
  }

  /// Keyed by `HiddenMachineStore.key(forIdentity:)`.
  @Published private(set) var records: [String: Record] = [:]
  private var scope: String?
  private let defaults = UserDefaults.standard

  private init() {
    setAccountScope(nil)
  }

  /// A device identity (account `deviceId` or a saved host's identity), or
  /// `name:<host name>` for a saved host that never reported one.
  static func key(forIdentity identity: String) -> String {
    identity.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  /// The identity inside a fleet storage key (`machine:<device id>`). Nil for
  /// keys built from an address, site or name, which have no stable identity.
  /// The fleet key of a machine with this device identity (the inverse of
  /// `identity(fromFleetKey:)`).
  static func fleetKey(deviceId: String) -> String {
    "machine:\(deviceId.lowercased())"
  }

  static func identity(fromFleetKey key: String) -> String? {
    let prefix = "machine:"
    guard key.hasPrefix(prefix) else { return nil }
    let rest = String(key.dropFirst(prefix.count))
    if rest.hasPrefix("addr:") || rest.hasPrefix("site:") || rest.hasPrefix("name:") { return nil }
    return rest.isEmpty ? nil : rest
  }

  /// The identity Settings hides a saved machine under when it never
  /// reported a device identity (`name:<host name>`).
  static func nameIdentity(for profile: HostConnectionProfile) -> String? {
    nonEmptyTrimmed(profile.hostName).map { "name:\($0)" }
  }

  func setAccountScope(_ userId: String?) {
    let next = nonEmptyTrimmed(userId) ?? "signed-out"
    guard next != scope else { return }
    scope = next
    if let data = defaults.data(forKey: defaultsKey),
       let decoded = try? JSONDecoder().decode([String: Record].self, from: data) {
      records = decoded
    } else {
      records = [:]
    }
  }

  func isHidden(identity: String) -> Bool {
    records[Self.key(forIdentity: identity)] != nil
  }

  func hide(identity: String) {
    var next = records
    next[Self.key(forIdentity: identity)] = Record(hiddenAt: Date())
    commit(next)
  }

  func unhide(identity: String) {
    var next = records
    guard next.removeValue(forKey: Self.key(forIdentity: identity)) != nil else { return }
    commit(next)
  }

  /// Applies a freshly loaded account directory: a hidden machine the account
  /// shows online is listed again.
  func reconcile(accountMachines: [(identity: String, online: Bool)]) {
    guard !records.isEmpty else { return }
    var onlineByKey: [String: Bool] = [:]
    for machine in accountMachines {
      let key = Self.key(forIdentity: machine.identity)
      onlineByKey[key] = (onlineByKey[key] ?? false) || machine.online
    }
    var next = records
    for key in records.keys where onlineByKey[key] == true {
      next.removeValue(forKey: key)
    }
    commit(next)
  }

  private var defaultsKey: String {
    "ade.machines.hidden.v1.\(scope ?? "signed-out")"
  }

  private func commit(_ next: [String: Record]) {
    guard next != records else { return }
    records = next
    if let data = try? JSONEncoder().encode(next) {
      defaults.set(data, forKey: defaultsKey)
    }
  }
}
