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
    /// An ADE Cloud computer of the account.
    var isCloud: Bool = false
    /// Its chats, sessions and lanes show in the project's lists
    /// (`fleetMachineListsWork`).
    var listsWork: Bool = false
    var id: String { machineKey }
  }

  /// How long a machine that lost its link keeps its rows listed, so a short
  /// reconnect does not make the lists flicker.
  static let workListReconnectWindow: TimeInterval = 20

  /// The machines whose work the project's lists show: live ones, ones inside
  /// the reconnect window, and ADE Cloud computers the user did not disconnect.
  var listedMachines: [Machine] { (machines + restingCloudMachines).filter(\.listsWork) }

  /// ADE Cloud computers this phone holds no link to (it never paired them):
  /// their rows come from the saved copies on the account server, and
  /// opening one wakes and pairs the computer (`connect`).
  @Published private(set) var restingCloudMachines: [Machine] = []

  /// The account server's ADE Cloud answer changed: list it.
  func cloudServerChanged() {
    // A live link to a computer the account says is asleep or stopped may be
    // a dead one (`MachineConnection.probeLink`).
    if let syncService {
      for (key, connection) in connections where cloudMachineKeys.contains(key) {
        guard syncService.cloudServerInstance(fleetKey: key)?.isResting == true else { continue }
        connection.probeLink(trigger: "computer_resting")
      }
    }
    schedulePublish()
  }

  /// ADE Cloud computers (fleet keys). Their work always lists, also while
  /// they sleep.
  private(set) var cloudMachineKeys: Set<String> = []

  func setCloudMachineKeys(_ keys: Set<String>) {
    guard keys != cloudMachineKeys else { return }
    cloudMachineKeys = keys
    publish()
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
  /// Counts the user's Connect and Disconnect choices. A failed connect
  /// undoes its swap only while no newer choice came after it.
  private var keepLiveChoices = 0
  private var projectMachinesScheduled = false
  private var projectCancellables: Set<AnyCancellable> = []
  private var lastOrder: [String] = []
  private var lastPublishedPhase: [String: MachineConnection.Phase] = [:]
  /// When each machine stopped being live (or the app came back to the
  /// front): the start of its reconnect window.
  private var notLiveSince: [String: Date] = [:]
  /// The computers whose work was listed when the app went to the background
  /// (and whether the focused one's was). Only these get a new reconnect
  /// window back in front: a computer that was already offline before that
  /// stays out of the lists and the counts.
  private var listedWhenBackgrounded: Set<String> = []
  private var focusedListedWhenBackgrounded = true
  private var reconnectWindowTask: Task<Void, Never>?
  private var reconnectWindowEnd: Date?
  private var lastLiveKeys: Set<String> = []
  private let hiddenMachines: HiddenMachineStore
  private var hiddenCancellables: Set<AnyCancellable> = []
  /// Fleet keys of the machines the account showed online at its last load.
  private var accountOnlineKeys: Set<String> = []
  /// Of those, the ones not reporting sleep: a Mac with its lid shut stays
  /// "online" in the account but cannot answer.
  private var accountAwakeKeys: Set<String> = []
  /// Each computer's heartbeats across the account loads (see
  /// `accountMachinesLoaded`).
  private var presenceWatch = AccountPresenceWatch()
  /// Reads the account's computer list while a wanted computer is away.
  private var presenceRefreshTask: Task<Void, Never>?
  static let presenceRefreshInterval: Duration = .seconds(30)

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
          self.accountAwakeKeys = Set(machines.compactMap { machine -> String? in
            guard machine.online, machine.sleepState != .asleep,
                  let deviceId = nonEmptyTrimmed(machine.deviceId) else { return nil }
            return HiddenMachineStore.fleetKey(deviceId: deviceId)
          })
          // The ADE Cloud computers resolve to fleet keys through this list.
          self.syncService?.resolveCloudMachineKeys()
          // Their saved chats, read from the account server itself.
          self.syncService?.refreshCloudServerIfStale()
          // A project copy on a computer this list still lacks reads it once more.
          AccountProjectStore.shared.readMachinesForUnknownCopies()
          // Machine names come from the directory: a rename shows at once.
          self.schedulePublish()
          self.accountMachinesLoaded(machines, cameOnline: cameOnline)
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
      listedWhenBackgrounded = Set(machines.filter(\.listsWork).map(\.machineKey))
      focusedListedWhenBackgrounded = syncService?.focusedMachineListsWork ?? true
      for connection in connections.values {
        connection.stop(reason: "App in background.")
      }
      presenceRefreshTask?.cancel()
      presenceRefreshTask = nil
      publish()
    } else {
      // Back in front: every machine reconnects, and the rows of one that was
      // listed when the app left stay listed while it does. One that was
      // offline before that keeps its old time, so it is not counted again.
      let now = Date()
      for key in notLiveSince.keys where listedWhenBackgrounded.contains(key) { notLiveSince[key] = now }
      listedWhenBackgrounded = []
      syncService?.restartFocusedReconnectWindow(wasListed: focusedListedWhenBackgrounded)
      focusedListedWhenBackgrounded = true
      resumeGivenUpConnections()
      reconcile()
      scheduleProjectMachinesUpdate()
      // Which computers came back or moved while the app was away.
      Task { await AccountService.shared.loadMachines() }
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
    // A connect still waiting on a cloud wake belongs to the last account: it
    // stops at its next check and writes nothing into the new account's set.
    keepLiveChoices += 1
    for connection in connections.values {
      connection.stop(reason: "Signed out.", clearAttention: true)
      connection.discardPendingRosterSave()
    }
    connections.removeAll()
    presenceRefreshTask?.cancel()
    presenceRefreshTask = nil
    presenceWatch = AccountPresenceWatch()
    accountOnlineKeys = []
    accountAwakeKeys = []
    needsUpdateSince.removeAll()
    needsUpdateRetryTask?.cancel()
    needsUpdateRetryTask = nil
    needsUpdateRetryDue = nil
    machines = []
    pairedMachineCount = 0
    projectMachineKeys = []
    requestedKey = nil
    // The last account's asleep ADE Cloud rows and the saved chats behind them.
    syncService?.clearCloudServerCache()
    restingCloudMachines = []
  }

  // MARK: - Queries

  func connection(for machineKey: String) -> MachineConnection? {
    connections[machineKey]
  }

  func machine(for machineKey: String) -> Machine? {
    machines.first { $0.machineKey == machineKey }
      ?? restingCloudMachines.first { $0.machineKey == machineKey }
  }

  /// The account showed this machine online and awake at its last load.
  func accountShowsAwake(_ machineKey: String) -> Bool {
    accountAwakeKeys.contains(machineKey)
  }

  /// The machine has a live roster link now.
  func isLive(_ machineKey: String) -> Bool {
    machine(for: machineKey)?.state == .live
  }

  /// The machine answers now: a live roster link, or the phone's primary link.
  private func isServing(_ machineKey: String) -> Bool {
    if isLive(machineKey) { return true }
    guard let syncService else { return false }
    return syncService.focusedMachineKey == machineKey && syncService.connectionState == .connected
  }

  /// Connects `machineKey` (adds it to the connected set and dials it) and
  /// waits up to `timeout` for a live link. False when it needs the user,
  /// runs out of retries, or is not live in time. A machine that this call
  /// pushed out of a full connected set comes back when the link fails.
  /// `wake: false` connects a computer that is up and never wakes an asleep
  /// one (reading never wakes).
  func connect(machineKey: String, timeout: Duration = .seconds(10), wake: Bool = true) async -> Bool {
    if isLive(machineKey) { return true }
    // An asleep ADE Cloud computer is woken first and given the time it
    // needs to start. A Connect or Disconnect the user chose meanwhile wins:
    // this older request then changes nothing.
    let choiceBeforeWake = keepLiveChoices
    let waking = wake ? (await syncService?.beginCloudWakeIfAsleep(fleetKey: machineKey) ?? false) : false
    defer { if waking { syncService?.endCloudWake(fleetKey: machineKey) } }
    if isLive(machineKey) { return true }
    guard choiceBeforeWake == keepLiveChoices else { return false }
    // The wake was refused (the screen says why): nothing comes up to wait for.
    if !waking, syncService?.cloudWakeFailure(fleetKey: machineKey) != nil { return false }
    let name = machine(for: machineKey)?.name ?? "The cloud computer"
    // A computer this phone never paired: pair it through the account once
    // it is up. The pairing can wait for minutes, so a Connect or Disconnect
    // the user chose meanwhile still wins.
    if connections[machineKey] == nil {
      let paired = await syncService?.pairRestingCloudMachine(fleetKey: machineKey, name: name, waking: waking, waitsForStart: wake) ?? .skipped
      guard choiceBeforeWake == keepLiveChoices else { return false }
      switch paired {
      case .started: break
      case .failed(let message):
        syncService?.recordCloudWakeFailure(fleetKey: machineKey, message: message)
        return false
      case .skipped: return false
      }
    }
    let pinsBefore = pinnedKeys
    let requestedBefore = requestedKey
    keepLive(machineKey: machineKey)
    let choice = keepLiveChoices
    let dropped = pinsBefore.filter { !pinnedKeys.contains($0) }
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: waking ? max(timeout, SyncService.cloudWakeConnectTimeout) : timeout)
    // A woken computer comes up with a new heartbeat and maybe a new address:
    // the account is read every few seconds during the wake, and each change
    // dials it at once with what it published (`accountMachinesLoaded`).
    var nextAccountRead = clock.now.advanced(by: .seconds(4))
    var nextFocusedDial = clock.now
    // A Disconnect (or a newer Connect) the user chose ends this wait at once.
    while clock.now < deadline, !Task.isCancelled, choice == keepLiveChoices {
      // A pairing on a phone with no primary makes this computer the primary.
      // The fleet does not dial the primary: its own link does, so wait for it.
      if let syncService, syncService.focusedMachineKey == machineKey {
        if syncService.connectionState == .connected { return true }
        if clock.now >= nextFocusedDial {
          nextFocusedDial = clock.now.advanced(by: .seconds(5))
          syncService.focusedMachineMayAnswer()
        }
        try? await Task.sleep(for: .milliseconds(250))
        continue
      }
      guard let machine = machine(for: machineKey) else {
        // `keepLive` added it; the list shows it from the next publish.
        guard connections[machineKey] != nil else { break }
        try? await Task.sleep(for: .milliseconds(250))
        continue
      }
      if machine.state == .live { return true }
      if case .needsAttention = machine.state { break }
      if machine.gaveUp {
        // A computer that is still starting runs through the short retries
        // quickly. While the wake lasts it is dialed again.
        guard waking, let connection = connections[machineKey] else { break }
        connection.resumeAfterGivingUp()
        reconcile()
      }
      if waking, clock.now >= nextAccountRead {
        nextAccountRead = clock.now.advanced(by: .seconds(4))
        await AccountService.shared.loadMachines()
        continue
      }
      try? await Task.sleep(for: .milliseconds(250))
    }
    if isServing(machineKey) { return true }
    // A woken ADE Cloud computer that never answered: the screen says so.
    if waking, choice == keepLiveChoices, !Task.isCancelled {
      let message: String
      if case .needsAttention(let detail)? = machine(for: machineKey)?.state {
        message = "Couldn't connect to \(name): \(detail)"
      } else {
        message = "\(name) did not answer within 2 minutes. Try again."
      }
      syncService?.recordCloudWakeFailure(fleetKey: machineKey, message: message)
    }
    // A newer choice (this machine again, or another one) is what the user
    // wants now: this older attempt leaves the set as that choice made it.
    if choice == keepLiveChoices {
      givePlaceBack(
        afterFailedConnectOf: machineKey,
        dropped: dropped,
        wasPinned: pinsBefore.contains(machineKey),
        requestedBefore: requestedBefore
      )
    }
    return false
  }

  /// Undoes what `keepLive` did for a connect that never went live. The
  /// request gives its first place back to the machine asked for before it,
  /// so a project machine it pushed out of a live slot comes back. When the
  /// set was full, the pins it dropped return (as the oldest) and the failed
  /// machine leaves the set; with room, it stays in the set and retries. A
  /// machine the user disconnected meanwhile stays off.
  private func givePlaceBack(
    afterFailedConnectOf machineKey: String,
    dropped: [String],
    wasPinned: Bool,
    requestedBefore: String?
  ) {
    let returning = dropped.filter { !pinnedKeys.contains($0) && !userDisconnectedKeys.contains($0) }
    let focused = syncService?.focusedMachineKey
    let overLimit = wantedKeys.filter { $0 != focused }.count > liveOtherMachineLimit
    let wasRequested = requestedKey == machineKey
    guard wasRequested || !returning.isEmpty || overLimit else { return }
    if !wasPinned, !returning.isEmpty || overLimit { pinnedKeys.removeAll { $0 == machineKey } }
    pinnedKeys.append(contentsOf: returning)
    if wasRequested {
      requestedKey = requestedBefore.flatMap { key in
        key != machineKey && !userDisconnectedKeys.contains(key) ? key : nil
      }
    }
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
    // A user choice: an older connect still waiting must not undo it.
    keepLiveChoices += 1
    pinnedKeys.removeAll { $0 == machineKey }
    if requestedKey == machineKey { requestedKey = nil }
    persistPins()
    // The open project does not connect it again behind the user's back.
    if userDisconnectedKeys.insert(machineKey).inserted { persistUserDisconnected() }
    // A failed wake of it asked for a retry the user no longer wants.
    syncService?.clearCloudWakeFailure(fleetKey: machineKey)
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
    var added: [String] = []
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
        added.append(entry.machineKey)
      }
    }
    // A chat opened before its machine was paired (an ADE Cloud computer
    // this phone never connected to) subscribes on the new link.
    for key in added { syncService.subscribeOpenRemoteChats(onMachine: key) }
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
    let now = Date()
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
      if state == .live {
        notLiveSince.removeValue(forKey: key)
      } else if notLiveSince[key] == nil {
        notLiveSince[key] = now
      }
      let isParked = !liveKeys.contains(key) && wanted.contains(key)
      let isCloud = cloudMachineKeys.contains(key)
      return Machine(
        machineKey: key,
        // The account's name for the machine, as Settings lists it.
        name: accountMachinePresentationName(
          hostIdentity: HiddenMachineStore.identity(fromFleetKey: key),
          fallback: connection.hostName ?? nonEmptyTrimmed(connection.profile.hostName),
          machines: AccountService.shared.machines
        ) ?? "Machine",
        state: state,
        projects: cloudMachineProjects(key: key, connection: connection, isCloud: isCloud, isLive: state == .live),
        rosterRevision: connection.rosterRevision,
        lastUpdateAt: connection.lastUpdateAt,
        isPinned: pinned.contains(key),
        isWanted: wanted.contains(key),
        isParked: isParked,
        isDisconnectedByUser: userDisconnectedKeys.contains(key),
        gaveUp: connection.gaveUp,
        routeKind: state == .live ? connection.liveRouteKind : nil,
        appVersion: connection.hostAppVersion,
        isCloud: isCloud,
        listsWork: fleetMachineListsWork(
          isLive: state == .live,
          isCloud: isCloud,
          isWanted: wanted.contains(key),
          isParked: isParked,
          isDisconnectedByUser: userDisconnectedKeys.contains(key),
          notLiveSince: notLiveSince[key],
          now: now,
          window: Self.workListReconnectWindow
        )
      )
    }
    scheduleReconnectWindowEnd(machines: next, now: now)
    updatePresenceRefresh(wanted: wanted)
    publishRestingCloudMachines(skip: Set(connections.keys))
    // A computer that answered has no failed wake to show any more.
    for machine in next where machine.state == .live && syncService?.cloudWakeFailure(fleetKey: machine.machineKey) != nil {
      syncService?.clearCloudWakeFailure(fleetKey: machine.machineKey)
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

  /// While the app is in front and a computer the user wants is not
  /// answering, the account's computer list is read every
  /// `presenceRefreshInterval`: one small request, only then. It tells when
  /// that computer is back (`accountMachinesLoaded`), so the phone dials it
  /// although its own retries ran out and its rows are hidden.
  private func updatePresenceRefresh(wanted: Set<String>) {
    let waiting = appActive && (wanted.contains { key in
      guard let connection = connections[key] else { return false }
      if connection.gaveUp { return true }
      if case .offline = connection.phase { return true }
      return false
    } || syncService?.activeProjectHasUnpairedCopies == true)
    if !waiting {
      presenceRefreshTask?.cancel()
      presenceRefreshTask = nil
      return
    }
    guard presenceRefreshTask == nil else { return }
    presenceRefreshTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.presenceRefreshInterval)
        guard !Task.isCancelled, self != nil else { return }
        await AccountService.shared.loadMachines()
      }
    }
  }

  /// The account's computer list loaded. A computer whose heartbeat started
  /// again after a silence, whose published address changed, or (while the
  /// phone wakes it) that sent any new heartbeat is dialed at once with the
  /// address it published.
  private func accountMachinesLoaded(_ machines: [AccountMachine], cameOnline: Set<String>) {
    let learned = syncService?.learnAccountMachineRoutes(machines) ?? []
    let observations = machines.compactMap { machine -> AccountPresenceObservation? in
      guard let deviceId = nonEmptyTrimmed(machine.deviceId) else { return nil }
      return AccountPresenceObservation(
        key: HiddenMachineStore.fleetKey(deviceId: deviceId),
        lastSeenAt: machine.lastSeenAt,
        endpoints: machine.reachableEndpoints
      )
    }
    let presence = presenceWatch.observe(observations, now: Date())
    let waking = syncService?.wakingCloudMachineKeys ?? []
    let back = cameOnline
      .union(learned)
      .union(presence.resumed)
      .union(presence.advanced.intersection(waking))
    if let focused = syncService?.focusedMachineKey, back.contains(focused) {
      syncService?.focusedMachineMayAnswer()
    }
    machinesCameOnline(machineKeys: back)
  }

  /// A machine's projects. A cloud computer paired but never live here lists
  /// its saved copies. So does one the account says is asleep or stopped
  /// while its link is down: its last live roster ended as the computer went
  /// down (a turn cut by a sleep reads Done there, Stopped in its saved copy).
  private func cloudMachineProjects(
    key: String,
    connection: MachineConnection,
    isCloud: Bool,
    isLive: Bool
  ) -> [RemoteRosterProject] {
    let live = connection.rosterProjectsIncludingOlderChats
    guard isCloud, let syncService else { return live }
    if connection.rosterProjects.isEmpty { return syncService.cloudSavedRosterProjects(fleetKey: key) }
    guard !isLive, syncService.cloudServerInstance(fleetKey: key)?.isResting == true else { return live }
    let saved = syncService.cloudSavedRosterProjects(fleetKey: key)
    return saved.isEmpty ? live : saved
  }

  private func publishRestingCloudMachines(skip: Set<String>) {
    let next = (syncService?.restingCloudMachineRows(skip: skip) ?? []).map { row in
      Machine(
        machineKey: row.fleetKey,
        name: row.name,
        state: .paused,
        projects: row.projects,
        rosterRevision: 0,
        lastUpdateAt: nil,
        isPinned: false,
        isDisconnectedByUser: userDisconnectedKeys.contains(row.fleetKey),
        isCloud: true,
        listsWork: !userDisconnectedKeys.contains(row.fleetKey)
      )
    }
    if next != restingCloudMachines { restingCloudMachines = next }
  }

  /// Republishes when the first reconnect window among the listed machines
  /// ends, so their rows leave the lists then.
  private func scheduleReconnectWindowEnd(machines next: [Machine], now: Date) {
    let end = next.compactMap { machine -> Date? in
      guard machine.listsWork, machine.state != .live, !machine.isCloud,
            let since = notLiveSince[machine.machineKey] else { return nil }
      return since.addingTimeInterval(Self.workListReconnectWindow)
    }.min()
    // Roster deltas publish often; the timer stays while its end stays.
    if end == reconnectWindowEnd, reconnectWindowTask != nil || end == nil { return }
    reconnectWindowTask?.cancel()
    reconnectWindowTask = nil
    reconnectWindowEnd = end
    guard let end else { return }
    let delay = max(0.1, end.timeIntervalSince(now) + 0.1)
    reconnectWindowTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled, let self else { return }
      self.reconnectWindowTask = nil
      self.reconnectWindowEnd = nil
      self.publish()
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

  /// An account left the phone: its computers leave the connected set and
  /// the Disconnect list. Computers still paired by code (`keeping`) stay.
  func forgetConnectionChoices(keeping: Set<String>) {
    pinnedKeys = pinnedKeys.filter { keeping.contains($0) }
    userDisconnectedKeys = userDisconnectedKeys.intersection(keeping)
    if pinnedKeys.isEmpty {
      UserDefaults.standard.removeObject(forKey: Self.pinnedKeysDefaultsKey)
    } else {
      persistPins()
    }
    if userDisconnectedKeys.isEmpty {
      UserDefaults.standard.removeObject(forKey: Self.userDisconnectedKeysDefaultsKey)
    } else {
      persistUserDisconnected()
    }
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

/// Whether a machine's chats, sessions and lanes show in a project's lists.
/// A computer the user disconnected does not list. Live machines and ADE
/// Cloud computers (also asleep) list. One parked past the live limit, or one
/// not wanted live, does not. One that lost its link lists only inside the
/// reconnect window.
func fleetMachineListsWork(
  isLive: Bool,
  isCloud: Bool,
  isWanted: Bool,
  isParked: Bool,
  isDisconnectedByUser: Bool,
  notLiveSince: Date?,
  now: Date,
  window: TimeInterval
) -> Bool {
  // The user's Disconnect wins, also for a cloud computer, as it does for
  // one this phone never paired (`publishRestingCloudMachines`).
  if isDisconnectedByUser { return false }
  if isCloud || isLive { return true }
  if isParked || !isWanted { return false }
  guard let notLiveSince else { return true }
  return now.timeIntervalSince(notLiveSince) < window
}

// MARK: - Account presence

/// One computer in one load of the account's computer list.
struct AccountPresenceObservation: Equatable {
  let key: String
  /// Epoch ms of its last heartbeat (the account server's clock).
  let lastSeenAt: Double?
  let endpoints: [AccountMachineEndpoint]
}

/// Pure: reads the account's heartbeats across loads, with no clock of the
/// server's in the phone's comparisons. A computer sends a heartbeat each
/// minute (and one when its ADE starts). The same heartbeat seen for longer
/// than `silence` means it stopped sending; a newer one after that means it
/// is back, even before the account's online window (150 s) runs out.
struct AccountPresenceWatch {
  struct Changes: Equatable {
    /// Back after a silence, or published a new address.
    var resumed: Set<String> = []
    /// Any newer heartbeat.
    var advanced: Set<String> = []
  }

  private struct Seen {
    var lastSeenAt: Double?
    var firstSeenAt: Date
    var silent: Bool
    var endpoints: [AccountMachineEndpoint]
  }

  /// Longer than one heartbeat period plus the time a heartbeat takes.
  static let silence: TimeInterval = 90

  private var seen: [String: Seen] = [:]

  mutating func observe(_ observations: [AccountPresenceObservation], now: Date) -> Changes {
    var changes = Changes()
    var next: [String: Seen] = [:]
    for observation in observations {
      guard var entry = seen[observation.key] else {
        next[observation.key] = Seen(
          lastSeenAt: observation.lastSeenAt,
          firstSeenAt: now,
          silent: false,
          endpoints: observation.endpoints
        )
        continue
      }
      if observation.endpoints != entry.endpoints {
        changes.resumed.insert(observation.key)
        entry.endpoints = observation.endpoints
      }
      if let latest = observation.lastSeenAt, latest > (entry.lastSeenAt ?? -.infinity) {
        changes.advanced.insert(observation.key)
        if entry.silent { changes.resumed.insert(observation.key) }
        entry.lastSeenAt = latest
        entry.firstSeenAt = now
        entry.silent = false
      } else if now.timeIntervalSince(entry.firstSeenAt) > Self.silence {
        entry.silent = true
      }
      next[observation.key] = entry
    }
    seen = next
    return changes
  }
}
