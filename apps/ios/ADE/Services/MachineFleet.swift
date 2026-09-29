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
/// - At most 4 machines live at once, the focused ("primary") one included.
/// - All roster connections close when the app goes to the background, and
///   open again on foreground.
/// - A roster connection never runs to the focused machine (the host keeps one
///   socket per phone per machine).
@MainActor
final class MachineFleet: ObservableObject {
  static let liveMachineLimit = 4
  private static let pinnedKeysDefaultsKey = "ade.fleet.pinnedMachineKeys.v1"
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

  struct Machine: Identifiable, Equatable {
    let machineKey: String
    var name: String
    var state: MachineState
    var projects: [RemoteRosterProject]
    var rosterRevision: Int
    var lastUpdateAt: Date?
    var isPinned: Bool
    /// Ran out of retries: "Offline · Tap to retry" until a retry trigger.
    var gaveUp: Bool = false
    var id: String { machineKey }
  }

  /// Every paired machine except the focused one, in display order.
  @Published private(set) var machines: [Machine] = []
  /// Paired machines in total, the focused one included.
  @Published private(set) var pairedMachineCount = 0

  private weak var syncService: SyncService?
  private var connections: [String: MachineConnection] = [:]
  private var appActive = false
  private var reconcileScheduled = false
  private var publishScheduled = false
  private var needsUpdateSince: [String: Date] = [:]
  private var needsUpdateRetryTask: Task<Void, Never>?
  private var needsUpdateRetryDue: Date?
  private var pinnedKeys: [String]
  private var lastOrder: [String] = []
  private var lastPublishedPhase: [String: MachineConnection.Phase] = [:]
  private var lastLiveKeys: Set<String> = []
  private let hiddenMachines: HiddenMachineStore
  private var hiddenCancellables: Set<AnyCancellable> = []

  init() {
    pinnedKeys = UserDefaults.standard.stringArray(forKey: Self.pinnedKeysDefaultsKey) ?? []
    hiddenMachines = HiddenMachineStore.shared
  }

  func attach(_ syncService: SyncService) {
    guard self.syncService !== syncService else { return }
    self.syncService = syncService
    syncService.machineFleet = self
    observeHiddenMachines()
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
          // A machine the account shows online may answer now.
          self?.machinesCameOnline(machineKeys: Set(machines.compactMap { machine in
            guard machine.online, let deviceId = nonEmptyTrimmed(machine.deviceId) else { return nil }
            return "machine:\(deviceId.lowercased())"
          }))
          self?.hiddenMachines.reconcile(
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
    var resumed = false
    for key in machineKeys {
      guard let connection = connections[key], connection.gaveUp else { continue }
      connection.resumeAfterGivingUp()
      resumed = true
    }
    if resumed { reconcile() }
  }

  private func resumeGivenUpConnections() {
    for connection in connections.values {
      connection.resumeAfterGivingUp()
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
  }

  // MARK: - Queries

  func connection(for machineKey: String) -> MachineConnection? {
    connections[machineKey]
  }

  func machine(for machineKey: String) -> Machine? {
    machines.first { $0.machineKey == machineKey }
  }

  // MARK: - User choices

  /// Keep `machineKey` live. When that goes over the limit, the least recently
  /// used live machine that the user did not choose is paused; returns it so
  /// the caller can say so. Returns nil when nothing had to be paused.
  @discardableResult
  func keepLive(machineKey: String) -> Machine? {
    let before = Set(machines.filter { $0.state != .paused }.map(\.machineKey))
    pinnedKeys.removeAll { $0 == machineKey }
    pinnedKeys.insert(machineKey, at: 0)
    // Never pin more than the limit allows: the oldest choice falls off.
    if pinnedKeys.count > liveOtherMachineLimit {
      pinnedKeys = Array(pinnedKeys.prefix(liveOtherMachineLimit))
    }
    persistPins()
    if let connection = connections[machineKey], case .needsAttention = connection.phase {
      connection.stop(reason: "Retry.", clearAttention: true)
    }
    needsUpdateSince.removeValue(forKey: machineKey)
    reconcile()
    let after = Set(machines.filter { $0.state != .paused }.map(\.machineKey))
    guard let pausedKey = before.subtracting(after).first else { return nil }
    return machine(for: pausedKey)
  }

  /// The machine that `keepLive(machineKey:)` would pause, without changing
  /// anything. Nil when the machine fits under the limit.
  func machineThatWouldPause(forKeepingLive machineKey: String) -> Machine? {
    let order = liveOrder(candidates: machines.map(\.machineKey), pinnedFirst: [machineKey] + pinnedKeys)
    let liveNow = machines.filter { $0.state != .paused }.map(\.machineKey)
    let liveNext = Set(order.prefix(liveOtherMachineLimit))
    guard !liveNext.contains(machineKey) || liveNow.contains(machineKey) else { return nil }
    return liveNow.first { !liveNext.contains($0) }.flatMap(machine(for:))
  }

  func stopKeepingLive(machineKey: String) {
    pinnedKeys.removeAll { $0 == machineKey }
    persistPins()
    reconcile()
  }

  /// The user's connected set (other than the focused machine), least recently
  /// connected first: who to offer when a new machine would go over the limit.
  var connectedMachinesLeastRecentFirst: [Machine] {
    let focused = syncService?.focusedMachineKey
    return pinnedKeys.reversed().filter { $0 != focused }.compactMap(machine(for:))
  }

  /// True when connecting one more machine would go over the limit.
  var isAtLiveLimit: Bool {
    let focused = syncService?.focusedMachineKey
    let connectedOthers = pinnedKeys.filter { $0 != focused }.count
    return connectedOthers >= liveOtherMachineLimit
  }

  /// Adds `machineKey` to the connected set without dialing it, e.g. the
  /// machine that stops being primary stays connected.
  func markConnected(machineKey: String) {
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

    let order = liveOrder(candidates: others.map(\.machineKey), pinnedFirst: pinnedKeys)
    if !UserDefaults.standard.bool(forKey: Self.connectedSetMigratedKey), !others.isEmpty {
      pinnedKeys = Array(order.prefix(liveOtherMachineLimit))
      persistPins()
      UserDefaults.standard.set(true, forKey: Self.connectedSetMigratedKey)
    }
    // Only the machines the user connected are live.
    let pinnedSet = Set(pinnedKeys)
    let liveKeys = Set(order.filter { pinnedSet.contains($0) }.prefix(liveOtherMachineLimit))
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
        name: connection.hostName ?? nonEmptyTrimmed(connection.profile.hostName) ?? "Machine",
        state: state,
        projects: connection.rosterProjects,
        rosterRevision: connection.rosterRevision,
        lastUpdateAt: connection.lastUpdateAt,
        isPinned: pinned.contains(key),
        gaveUp: connection.gaveUp
      )
    }
    if next != machines {
      machines = next
    }
  }

  private func persistPins() {
    UserDefaults.standard.set(pinnedKeys, forKey: Self.pinnedKeysDefaultsKey)
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
/// A hidden machine comes back on its own only when it is on the account again
/// AND online, after having been gone (off the account or offline) at some
/// point since it was hidden -- or the moment the phone connects to it. So
/// removing a machine that is online right now does not make it bounce straight
/// back, and a stale offline machine reappears the next time it is really there.
@MainActor
final class HiddenMachineStore: ObservableObject {
  static let shared = HiddenMachineStore()

  struct Record: Codable, Equatable {
    var hiddenAt: Date
    /// Seen off the account, or offline, since it was hidden.
    var sawGone: Bool
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

  /// `isAvailableNow`: on the account and online right now (or, for a saved
  /// machine, reachable). A machine that is not can come back as soon as it is.
  func hide(identity: String, isAvailableNow: Bool) {
    var next = records
    next[Self.key(forIdentity: identity)] = Record(hiddenAt: Date(), sawGone: !isAvailableNow)
    commit(next)
  }

  func unhide(identity: String) {
    var next = records
    guard next.removeValue(forKey: Self.key(forIdentity: identity)) != nil else { return }
    commit(next)
  }

  /// Applies a freshly loaded account directory: a hidden machine that is off
  /// the account or offline is marked gone; one that was gone and is now on the
  /// account and online is shown again.
  func reconcile(accountMachines: [(identity: String, online: Bool)]) {
    guard !records.isEmpty else { return }
    var onlineByKey: [String: Bool] = [:]
    for machine in accountMachines {
      let key = Self.key(forIdentity: machine.identity)
      onlineByKey[key] = (onlineByKey[key] ?? false) || machine.online
    }
    var next = records
    for (key, record) in records {
      let online = onlineByKey[key] == true
      if !online {
        if !record.sawGone { next[key]?.sawGone = true }
      } else if record.sawGone {
        next.removeValue(forKey: key)
      }
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
