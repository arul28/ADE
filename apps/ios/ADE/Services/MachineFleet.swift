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
/// Policy (owner decisions 2026-09-25):
/// - At most 4 machines live at once, the focused one included. Machines the
///   user chose ("keep live") come first, then the most recently used.
/// - All roster connections close when the app goes to the background, and
///   open again on foreground.
/// - A roster connection never runs to the focused machine (the host keeps one
///   socket per phone per machine).
@MainActor
final class MachineFleet: ObservableObject {
  static let liveMachineLimit = 4
  private static let pinnedKeysDefaultsKey = "ade.fleet.pinnedMachineKeys.v1"
  private static let needsUpdateRetryInterval: TimeInterval = 30 * 60

  enum MachineState: Equatable {
    case live
    case connecting
    case offline(message: String?)
    /// Over the live-machine limit: shows its last roster, connects on demand.
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
  private var pinnedKeys: [String]
  private var lastOrder: [String] = []
  private var lastPublishedPhase: [String: MachineConnection.Phase] = [:]
  private var lastLiveKeys: Set<String> = []

  init() {
    pinnedKeys = UserDefaults.standard.stringArray(forKey: Self.pinnedKeysDefaultsKey) ?? []
  }

  func attach(_ syncService: SyncService) {
    guard self.syncService !== syncService else { return }
    self.syncService = syncService
    syncService.machineFleet = self
    scheduleReconcile()
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
      reconcile()
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

  /// Keys of the machines the user chose to keep live, in their order.
  var pinnedMachineKeys: [String] { pinnedKeys }

  /// Machines over the limit (paused) right now.
  var pausedMachines: [Machine] {
    machines.filter { $0.state == .paused }
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

  /// Retry a machine that asked for attention or an update.
  func retry(machineKey: String) {
    needsUpdateSince.removeValue(forKey: machineKey)
    connections[machineKey]?.stop(reason: "Retry.", clearAttention: true)
    reconcile()
  }

  // MARK: - Reconcile

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
    let profiles = syncService.fleetMachineProfiles()
    let blocked = syncService.fleetBlockedMachineKeys
    let focusedKey = syncService.focusedMachineKey
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
    let liveKeys = Set(order.prefix(liveOtherMachineLimit))
    let now = Date()
    for key in order {
      guard let connection = connections[key] else { continue }
      let wantsLive = appActive && liveKeys.contains(key) && !blocked.contains(key)
      if wantsLive {
        if let since = needsUpdateSince[key], now.timeIntervalSince(since) < Self.needsUpdateRetryInterval {
          continue
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
        name: connection.hostName ?? fleetNonEmpty(connection.profile.hostName) ?? "Machine",
        state: state,
        projects: connection.rosterProjects,
        rosterRevision: connection.rosterRevision,
        lastUpdateAt: connection.lastUpdateAt,
        isPinned: pinned.contains(key)
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
