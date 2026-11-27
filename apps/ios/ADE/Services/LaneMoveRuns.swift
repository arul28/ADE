import Combine
import Foundation
import os

private let laneMoveLog = Logger(subsystem: "com.ade.ios", category: "lane-move")

// The lane moves this phone started, and what each one is doing now (the
// desktop's `laneMoveRuns.ts`). A live move is the lane brain's batch move;
// a move from saved copies is the destination brain's kept-lane restore.
// Neither brain sends one event for the whole move, so a run reads its
// record on a short timer while it runs and stops at the end.
//
// A move off an ADE Cloud computer ends with deleting that computer, and
// only after the move is done and checked (`laneMoveBatchAllowsComputerDelete`).
// A failure keeps the computer, so nothing is lost. A move off an asleep
// computer (`fromComputer`) is the destination brain's restore, which
// deletes that computer first, only while its saved copy holds all of the
// lane's work; a refusal deletes nothing (`wakesInstead`). Unfinished runs are
// saved in UserDefaults, so a closed sheet or a relaunch still finishes the
// follow-up and still deletes the computer.

/// The machine and project one lane-move call goes to. `machineKey` is the
/// fleet key; nil is the phone's primary machine (a phone with no account
/// machine keys).
struct LaneMoveRoute: Codable, Equatable, Hashable {
  var machineKey: String?
  var projectId: String?
  var rootPath: String?
}

/// One place a lane can move to.
struct LaneMoveTarget: Identifiable, Equatable, Hashable {
  let id: String
  /// A live move names the destination by this account machine key; a
  /// restore keys its target by fleet key.
  let machineKey: String
  let name: String
  /// It can take the lane now.
  let ready: Bool
  /// Why it can't, when it can't.
  let reason: String?
  /// False: a live move clones the project there first. Nil: not known.
  let hasRepository: Bool?
  /// A move from saved copies runs on this route (the destination).
  let route: LaneMoveRoute?
}

/// The ADE Cloud computer a move leaves, deleted once the move is checked.
struct LaneMoveCloudComputer: Codable, Equatable, Hashable {
  let instanceId: String
  /// The account machine key its saved chats are under.
  let accountMachineKey: String?
  /// The lane's own id on that computer.
  let laneId: String
}

struct LaneMoveRun: Identifiable, Codable, Equatable {
  enum Kind: String, Codable { case live, restore }
  enum Phase: String, Codable {
    /// The move runs.
    case moving
    /// Moved and checked; the ADE Cloud computer is being deleted.
    case deleting
    case done
    /// Moved, but the ADE Cloud computer could not be deleted, or ADE
    /// couldn't check the lane on it first.
    case deleteFailed
    /// Moved, but chats started on the lane on the ADE Cloud computer during
    /// the move, so the computer is kept. A fresh move brings them.
    case moveAgain
    /// Moved, but the lane's files on the ADE Cloud computer changed after the
    /// move, or its older ADE can't say, so the computer is kept. Its chats
    /// already moved, so a new move has nothing to carry: the way on is to
    /// push the files to GitHub and delete the computer (`pushAndDelete`).
    case pushFirst
    /// Part of it, or none of it, arrived. Nothing was deleted.
    case failed
  }

  /// The batch id or the restore id.
  var id: String
  let kind: Kind
  /// The lane as the phone named it when the move started.
  let laneId: String
  let laneName: String
  /// Where the lane goes.
  let targetName: String
  /// The lane's brain for a live move; the destination for a restore.
  let route: LaneMoveRoute
  /// The lane's ADE Cloud computer, deleted once the move is checked.
  let computer: LaneMoveCloudComputer?
  var phase: Phase
  var error: String?
  let startedAt: Date
  /// Set only by the check on a completed batch: everything arrived. Only
  /// then may the computer be deleted, also on a retry after a relaunch.
  var arrived = false
  /// A restore off the lane's asleep ADE Cloud computer: the destination
  /// deletes it first, with no wake. A retry names it again.
  var fromComputer: String? = nil
  /// A live move: the chats that arrived, set with `arrived`. Only their
  /// saved copies are deleted with the computer. Nil (a run saved by an
  /// older app): the computer goes and every saved chat stays.
  var movedChatIds: [String]? = nil
  /// The latest record read; not saved.
  var batch: LaneMoveBatchRecord? = nil
  var restore: CloudKeptLaneRestoreRecord? = nil

  private enum CodingKeys: String, CodingKey {
    case id, kind, laneId, laneName, targetName, route, computer, phase, error, startedAt, arrived, fromComputer, movedChatIds
  }

  var isOpen: Bool {
    phase == .moving || phase == .deleting || phase == .deleteFailed || phase == .failed || phase == .moveAgain || phase == .pushFirst
  }

  /// A run that keeps the lane from a second move until it is closed. A run
  /// that asks for a fresh move doesn't.
  var blocksNewMove: Bool { isOpen && phase != .moveAgain }

  /// A move from an asleep computer's saved copy that deleted nothing,
  /// because the copy isn't complete or the computer woke: the person wakes
  /// it and moves the lane live.
  var wakesInstead: Bool { kind == .restore && phase == .failed && restore?.wakeInstead == true }

  /// The move ends with the lane's ADE Cloud computer deleted.
  var deletesComputer: Bool { computer != nil || (kind == .restore && fromComputer != nil) }
}

/// The plain lane id a run or a screen names (`fleet|…` ids lose their tag).
private func laneMovePlainLaneId(_ laneId: String) -> String {
  workParseRemoteLaneId(laneId)?.laneId ?? laneId
}

@MainActor
final class LaneMoveRuns: ObservableObject {
  static let shared = LaneMoveRuns()

  @Published private(set) var runs: [LaneMoveRun] = []

  private weak var sync: SyncService?
  private var timers: [String: Task<Void, Never>] = [:]
  private var resumed = false
  #if DEBUG
  /// Fixture runs: nothing is read, retried or deleted.
  private var fixture = false
  #endif

  private static let storageKey = "ade.laneMoveRuns.v1"
  /// Reads come quickly at first, when a small lane is done in seconds, then slower.
  private static let fastRead: Duration = .seconds(2)
  private static let slowRead: Duration = .seconds(6)
  /// How often a run past `readFor` asks a machine that didn't answer.
  private static let unreachedRead: Duration = .seconds(60)
  private static let fastReadsFor: TimeInterval = 60
  /// A move still running after this long stops being read; its chats' banners still show it.
  private static let readFor: TimeInterval = 2 * 60 * 60
  /// A run that ended stays this long, so its sheet can show the result.
  private static let keepEnded: Duration = .seconds(10 * 60)

  /// Picks up the runs the last app run left unfinished. Called once at launch.
  func resume(sync: SyncService) {
    self.sync = sync
    guard !resumed else { return }
    resumed = true
    guard let data = UserDefaults.standard.data(forKey: Self.storageKey) else { return }
    guard let saved = try? JSONDecoder().decode([LaneMoveRun].self, from: data) else {
      UserDefaults.standard.removeObject(forKey: Self.storageKey)
      return
    }
    for var run in saved where !runs.contains(where: { $0.id == run.id }) {
      // A delete cut off by the relaunch is offered again: the move had arrived.
      if run.phase == .deleting { run.phase = .deleteFailed }
      runs.append(run)
      // Asks the machine first: a move that ended while the app was closed
      // gets its result, however old the run is.
      if run.phase == .moving {
        let id = run.id
        Task { await read(id) }
      }
    }
  }

  func run(id: String?) -> LaneMoveRun? {
    guard let id else { return nil }
    return runs.first { $0.id == id }
  }

  /// The newest run of a lane that is under way or ended badly, for the
  /// lane's move sheet. Matches a `fleet|…` id and its plain id, and only a
  /// run from the same kind of source: a lane that came back from saved
  /// copies can keep its id, and the restore isn't that lane's move.
  func openRun(source: LaneMoveSource) -> LaneMoveRun? {
    let plain = laneMovePlainLaneId(source.laneId)
    return runs.last {
      $0.isOpen && laneMovePlainLaneId($0.laneId) == plain && ($0.kind == .restore) == source.restores
    }
  }

  /// Starts following a batch move this phone started.
  @discardableResult
  func followLive(
    record: LaneMoveBatchRecord,
    route: LaneMoveRoute,
    laneId: String,
    laneName: String,
    targetName: String,
    computer: LaneMoveCloudComputer?,
    sync: SyncService
  ) -> String {
    self.sync = sync
    add(LaneMoveRun(
      id: record.batchId,
      kind: .live,
      laneId: laneId,
      laneName: laneName,
      targetName: record.machineName.flatMap { nonEmptyTrimmed($0) } ?? targetName,
      route: route,
      computer: computer,
      phase: .moving,
      error: nil,
      startedAt: Date(),
      batch: record
    ))
    return record.batchId
  }

  /// Starts following a move from saved copies this phone started.
  @discardableResult
  func followRestore(
    record: CloudKeptLaneRestoreRecord,
    route: LaneMoveRoute,
    laneId: String,
    targetName: String,
    fromComputer: String? = nil,
    sync: SyncService
  ) -> String {
    self.sync = sync
    add(LaneMoveRun(
      id: record.restoreId,
      kind: .restore,
      laneId: laneId,
      laneName: record.laneName,
      targetName: targetName,
      route: route,
      computer: nil,
      phase: .moving,
      error: nil,
      startedAt: Date(),
      fromComputer: fromComputer,
      restore: record
    ))
    return record.restoreId
  }

  /// "Try again" on a move that did not all arrive. The same machine runs
  /// it: a batch goes on under its own id; a restore starts again for the
  /// same lane and goes on from what came back. Answers the run's id now.
  func retry(id: String) async throws -> String {
    guard let run = self.run(id: id), let sync else { return id }
    #if DEBUG
    if fixture { return id }
    #endif
    switch run.kind {
    case .live:
      let record = try await sync.retryLaneMoveBatch(route: run.route, batchId: run.id)
      replace(id, with: LaneMoveRun(
        id: record.batchId, kind: .live, laneId: run.laneId, laneName: run.laneName, targetName: run.targetName,
        route: run.route, computer: run.computer, phase: .moving, error: nil, startedAt: Date(), batch: record
      ))
      return record.batchId
    case .restore:
      // An earlier try may have deleted the asleep computer already: the brain goes on with its kept lane.
      let record = try await sync.restoreKeptLane(route: run.route, laneId: laneMovePlainLaneId(run.laneId), fromComputer: run.fromComputer)
      replace(id, with: LaneMoveRun(
        id: record.restoreId, kind: .restore, laneId: run.laneId, laneName: run.laneName, targetName: run.targetName,
        route: run.route, computer: nil, phase: .moving, error: nil, startedAt: Date(), fromComputer: run.fromComputer,
        restore: record
      ))
      return record.restoreId
    }
  }

  /// Tries the ADE Cloud computer's delete again, after a move that arrived.
  /// It checks the lane on the computer again first: time has passed.
  func retryDelete(id: String) {
    Task { await deleteComputer(id: id) }
  }

  /// Stops showing an ended run.
  func dismiss(id: String) {
    timers.removeValue(forKey: id)?.cancel()
    runs.removeAll { $0.id == id }
    save()
  }

  // MARK: Following

  private func add(_ run: LaneMoveRun) {
    timers.removeValue(forKey: run.id)?.cancel()
    // A fresh move of the lane replaces the run that asked for it.
    let plain = laneMovePlainLaneId(run.laneId)
    let waitsOnPerson: (LaneMoveRun) -> Bool = { ($0.phase == .moveAgain || $0.phase == .pushFirst) && laneMovePlainLaneId($0.laneId) == plain }
    for ended in runs where waitsOnPerson(ended) {
      timers.removeValue(forKey: ended.id)?.cancel()
    }
    runs.removeAll { $0.id == run.id || waitsOnPerson($0) }
    runs.append(run)
    save()
    Task { await read(run.id) }
  }

  private func replace(_ id: String, with run: LaneMoveRun) {
    timers.removeValue(forKey: id)?.cancel()
    runs.removeAll { $0.id == id || $0.id == run.id }
    runs.append(run)
    save()
    Task { await read(run.id) }
  }

  private func update(_ id: String, _ change: (inout LaneMoveRun) -> Void) {
    guard let index = runs.firstIndex(where: { $0.id == id }) else { return }
    var run = runs[index]
    change(&run)
    guard run != runs[index] else { return }
    runs[index] = run
    save()
  }

  /// `unreached`: the last read didn't reach the machine. A run that old
  /// then reads once a minute, so it goes on when the machine is back.
  private func schedule(_ id: String, unreached: Bool = false) {
    timers.removeValue(forKey: id)?.cancel()
    guard let run = self.run(id: id) else { return }
    let age = Date().timeIntervalSince(run.startedAt)
    let wait: Duration
    if age < Self.readFor {
      wait = age < Self.fastReadsFor ? Self.fastRead : Self.slowRead
    } else if unreached {
      wait = Self.unreachedRead
    } else {
      // Too long to keep reading. Nothing is deleted; Try again asks the
      // same machine again, and it goes on from what already arrived.
      update(id) {
        $0.phase = .failed
        $0.error = "\(Brand.name) stopped checking this move. Open the lane on \(run.targetName) to see what arrived."
      }
      return
    }
    timers[id] = Task { @MainActor [weak self] in
      try? await Task.sleep(for: wait)
      guard !Task.isCancelled else { return }
      await self?.read(id)
    }
  }

  private func read(_ id: String) async {
    #if DEBUG
    if fixture { return }
    #endif
    guard let run = self.run(id: id), run.phase == .moving, let sync else { return }
    do {
      switch run.kind {
      case .live:
        guard let record = try await sync.readLaneMoveBatch(route: run.route, batchId: run.id) else {
          // The machine answered and has no such move: it ends now, nothing deleted.
          finish(id, arrived: false, failure: "The lane's machine no longer knows this move. Open the lane there to see what arrived.")
          return
        }
        update(id) { $0.batch = record; $0.error = nil }
        if laneMoveBatchEnded(record) {
          // The one place a move is judged arrived; nothing else sets it.
          let arrived = laneMoveBatchAllowsComputerDelete(record)
          update(id) { $0.movedChatIds = laneMoveBatchMovedChatIds(record) }
          finish(id, arrived: arrived, failure: arrived ? nil : laneMoveBatchFailure(record))
        } else {
          schedule(id)
        }
      case .restore:
        guard let record = try await sync.readKeptLaneRestore(route: run.route, restoreId: run.id) else {
          finish(id, arrived: false, failure: "\(run.targetName) no longer knows this move. Try again to go on from what came back.")
          return
        }
        update(id) { $0.restore = record; $0.error = nil }
        // The restore forgets the kept lane itself, and only once every chat came back.
        if record.state == "completed" {
          finish(id, arrived: true, failure: nil)
        } else if record.state == "failed" {
          finish(id, arrived: false, failure: nonEmptyTrimmed(record.error) ?? "Part of the lane did not come back.")
        } else {
          schedule(id)
        }
      }
    } catch {
      // A machine that is briefly unreachable is read again; the move goes
      // on there. A read that failed never counts as arrived.
      update(id) { $0.error = SyncUserFacingError.message(for: error) }
      schedule(id, unreached: true)
    }
  }

  private func finish(_ id: String, arrived: Bool, failure: String?) {
    guard let run = self.run(id: id) else { return }
    let toasts = CloudLaneActions.shared
    guard arrived else {
      update(id) { $0.phase = .failed; $0.error = failure }
      if self.run(id: id)?.wakesInstead == true {
        toasts.toast = ADEToastMessage(
          text: "Couldn't move \(run.laneName) from its saved copy",
          kind: .failure,
          detail: [failure, "Nothing was deleted. Wake the \(ADECloudMachine.name) computer to move the lane from there."]
            .compactMap { $0 }.joined(separator: " ")
        )
      } else {
        toasts.toast = ADEToastMessage(
          text: "Couldn't move all of \(run.laneName) to \(run.targetName)",
          kind: .failure,
          detail: run.computer != nil
            ? [failure, "Its \(ADECloudMachine.name) computer is kept, so nothing is lost."].compactMap { $0 }.joined(separator: " ")
            : failure ?? "Open the move again to try again."
        )
      }
      forgetLater(id)
      return
    }
    update(id) { $0.arrived = true }
    if run.kind == .live, run.computer != nil {
      Task { await deleteComputer(id: id) }
      return
    }
    update(id) { $0.phase = .done }
    let fromComputer = run.kind == .restore ? run.fromComputer : nil
    toasts.toast = ADEToastMessage(
      text: "Moved \(run.laneName) to \(run.targetName)",
      kind: .success,
      detail: fromComputer != nil ? "Its \(ADECloudMachine.name) computer is deleted." : nil
    )
    if let fromComputer {
      // The destination deleted the asleep computer: its screens close and the lists drop it.
      toasts.deleted(instanceId: fromComputer)
      Task { await sync?.refreshCloudServerInstances() }
    }
    // A kept lane left the account when it came back: the lists drop it.
    if run.kind == .restore { sync?.refreshCloudServerIfStale(force: true) }
    forgetLater(id)
  }

  /// The chats and CLIs on the source lane now that the move didn't carry
  /// (one started there during the move), counted as the review lists them.
  /// Nil when the lane couldn't be read.
  private func chatsLeftOnSource(_ run: LaneMoveRun, sync: SyncService) async -> Int? {
    do {
      let detail = try await sync.readLaneMoveDetail(route: run.route, laneId: run.laneId)
      let moved = Set(run.movedChatIds ?? [])
      return laneMoveItems(sessions: detail.sessions, chats: detail.chatSessions).filter { !moved.contains($0.id) }.count
    } catch {
      laneMoveLog.notice("lane_move source_read_before_delete=failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return nil
    }
  }

  /// What the read of the lane on the computer found before its delete.
  private enum SourceCheck {
    case clear
    /// Chats started on the lane since the move: the computer stays and a new move brings them.
    case moveAgain(String)
    /// Its files changed since the move, or its ADE can't say: the computer stays until they are pushed.
    case pushFirst(String)
    /// ADE couldn't read the lane: the computer stays and the delete can be tried again.
    case unreadable(String)
  }

  private func checkSource(_ run: LaneMoveRun, sync: SyncService) async -> SourceCheck {
    let cloud = ADECloudMachine.name
    guard let left = await chatsLeftOnSource(run, sync: sync) else {
      return .unreadable("\(Brand.name) couldn't check the lane's chats on \(cloud), so it kept the computer.")
    }
    if left > 0 {
      return .moveAgain(left == 1
        ? "A chat started on the lane during the move, so \(Brand.name) kept the computer. Move the lane again to bring it."
        : "\(left) chats started on the lane during the move, so \(Brand.name) kept the computer. Move the lane again to bring them.")
    }
    do {
      guard let change = try await sync.laneMoveBatchSourceChanged(route: run.route, batchId: run.id) else {
        // An older ADE on the computer can't check its files: never a silent delete.
        laneMoveLog.notice("lane_move source_files_check=unsupported")
        return .pushFirst("The \(Brand.name) on the lane's \(cloud) computer is too old to check for files that changed after the move, so \(Brand.name) kept the computer. Push its work to GitHub, then pull the branch on \(run.targetName).")
      }
      if change.changed {
        laneMoveLog.notice("lane_move source_files_check=changed")
        return .pushFirst("Files on the lane changed on \(cloud) after the move, so \(Brand.name) kept the computer. Push them to GitHub, then pull the branch on \(run.targetName).")
      }
      return .clear
    } catch {
      laneMoveLog.notice("lane_move source_files_check=failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return .unreadable("\(Brand.name) couldn't check the lane's files on \(cloud), so it kept the computer. \(SyncUserFacingError.message(for: error))")
    }
  }

  /// Deletes the lane's ADE Cloud computer and the saved copies of the chats
  /// that moved, only for a run the check marked arrived, and only once the
  /// lane on the computer was read and holds nothing the move didn't carry.
  private func deleteComputer(id: String) async {
    #if DEBUG
    if fixture { return }
    #endif
    guard let run = self.run(id: id), run.kind == .live, run.arrived, let computer = run.computer, let sync,
          run.phase != .deleting, run.phase != .done, run.phase != .moveAgain, run.phase != .pushFirst else { return }
    update(id) { $0.phase = .deleting; $0.error = nil }
    let toasts = CloudLaneActions.shared
    let failure: String?
    var chatsLeft = false
    switch await checkSource(run, sync: sync) {
    case .moveAgain(let reason):
      // Not a failed delete: Close ends this run, and the lane's sheet starts a fresh move.
      update(id) { $0.phase = .moveAgain; $0.error = reason }
      toasts.toast = ADEToastMessage(
        text: "Moved \(run.laneName), but kept its \(ADECloudMachine.name) computer",
        kind: .info,
        detail: reason
      )
      forgetLater(id)
      return
    case .pushFirst(let reason):
      // Its chats already moved, so a new move has nothing to carry: the move's screen offers the push.
      update(id) { $0.phase = .pushFirst; $0.error = reason }
      toasts.toast = ADEToastMessage(
        text: "Moved \(run.laneName), but kept its \(ADECloudMachine.name) computer",
        kind: .info,
        detail: "\(reason) Open the move again to do it."
      )
      return
    case .unreadable(let reason):
      failure = reason
    case .clear:
      if let client = await sync.cloudServerClient() {
        // The move carried the work and every chat, and the check passed: the
        // work check would only find what already arrived, so it is skipped.
        let outcome = await CloudLaneComputerDelete.run(
          client: client,
          instanceId: computer.instanceId,
          accountMachineKey: computer.accountMachineKey,
          laneId: computer.laneId,
          // Unknown (an older run): no saved chat is deleted.
          onlyChats: Set(run.movedChatIds ?? []),
          sync: sync
        )
        failure = outcome.failure
        chatsLeft = outcome.chatsLeft
      } else {
        failure = "Sign in to \(Brand.name), then try again."
      }
    }
    if let failure {
      update(id) { $0.phase = .deleteFailed; $0.error = failure }
      toasts.toast = ADEToastMessage(
        text: "Moved \(run.laneName), but its \(ADECloudMachine.name) computer is still there",
        kind: .info,
        detail: "\(failure) Open the move again to delete it."
      )
      return
    }
    update(id) { $0.phase = .done }
    toasts.deleted(instanceId: computer.instanceId)
    toasts.toast = chatsLeft
      // The computer is gone; only some saved copies are left, which Work deletes.
      ? ADEToastMessage(
        text: "Moved \(run.laneName) to \(run.targetName)",
        kind: .info,
        detail: "Its \(ADECloudMachine.name) computer is deleted, but some saved copies of the chats that moved are still there. Delete them in Work."
      )
      : ADEToastMessage(
        text: "Moved \(run.laneName) to \(run.targetName)",
        kind: .success,
        detail: "Its \(ADECloudMachine.name) computer is deleted."
      )
    await sync.refreshCloudServerInstances()
    forgetLater(id)
  }

  /// For a move whose lane files changed on the ADE Cloud computer after it
  /// (`pushFirst`): ADE commits and pushes the computer's lane work to
  /// GitHub, reads again that nothing is left off GitHub, then deletes the
  /// computer and the saved copies of the chats that moved. A chat started
  /// there since keeps the computer, as the first delete did; so does a push
  /// that didn't finish.
  func pushAndDelete(id: String) {
    Task { await pushThenDelete(id: id) }
  }

  private func pushThenDelete(id: String) async {
    #if DEBUG
    if fixture { return }
    #endif
    guard let run = self.run(id: id), run.kind == .live, run.arrived, run.phase == .pushFirst,
          let computer = run.computer, let sync else { return }
    let cloud = ADECloudMachine.name
    let toasts = CloudLaneActions.shared
    update(id) { $0.phase = .deleting; $0.error = nil }
    func keep(_ why: String) {
      update(id) { $0.phase = .pushFirst; $0.error = why }
      toasts.toast = ADEToastMessage(text: "Kept \(run.laneName)'s \(cloud) computer", kind: .failure, detail: "\(why) Nothing was deleted.")
    }
    guard let left = await chatsLeftOnSource(run, sync: sync) else {
      keep("\(Brand.name) couldn't check the lane's chats on \(cloud).")
      return
    }
    if left > 0 {
      let reason = left == 1
        ? "A chat started on the lane since the move, so \(Brand.name) kept the computer. Move the lane again to bring it."
        : "\(left) chats started on the lane since the move, so \(Brand.name) kept the computer. Move the lane again to bring them."
      update(id) { $0.phase = .moveAgain; $0.error = reason }
      toasts.toast = ADEToastMessage(text: "Kept \(run.laneName)'s \(cloud) computer", kind: .info, detail: reason)
      forgetLater(id)
      return
    }
    guard let client = await sync.cloudServerClient() else {
      keep("Sign in to \(Brand.name), then try again.")
      return
    }
    let pushed = await client.runPushWork(instanceId: computer.instanceId, check: false)
    guard let tally = pushed.tally, tally.failed == 0, tally.leftLanes.isEmpty else {
      keep(pushed.error ?? "\(Brand.name) couldn't push all of the computer's work to GitHub.")
      return
    }
    // Pushed: read once more, so nothing new since slips through.
    let work = await client.workState(instanceId: computer.instanceId)
    guard work.unpushed == false else {
      keep(work.message ?? "Some of the computer's work still isn't on GitHub.")
      return
    }
    let outcome = await CloudLaneComputerDelete.run(
      client: client,
      instanceId: computer.instanceId,
      accountMachineKey: computer.accountMachineKey,
      laneId: computer.laneId,
      onlyChats: Set(run.movedChatIds ?? []),
      sync: sync
    )
    if let failure = outcome.failure {
      // The work is on GitHub now; only the delete is left to try again.
      update(id) { $0.phase = .deleteFailed; $0.error = failure }
      toasts.toast = ADEToastMessage(
        text: "Pushed \(run.laneName), but its \(cloud) computer is still there",
        kind: .info,
        detail: "\(failure) Open the move again to delete it."
      )
      return
    }
    update(id) { $0.phase = .done }
    toasts.deleted(instanceId: computer.instanceId)
    toasts.toast = ADEToastMessage(
      text: "Pushed \(run.laneName) and deleted its \(cloud) computer",
      kind: outcome.chatsLeft ? .info : .success,
      detail: outcome.chatsLeft
        ? "Its files are on GitHub; pull the branch on \(run.targetName). Some saved copies of the chats that moved are still there. Delete them in Work."
        : "Its files are on GitHub; pull the branch on \(run.targetName)."
    )
    await sync.refreshCloudServerInstances()
    forgetLater(id)
  }

  private func forgetLater(_ id: String) {
    timers.removeValue(forKey: id)?.cancel()
    timers[id] = Task { @MainActor [weak self] in
      try? await Task.sleep(for: Self.keepEnded)
      guard !Task.isCancelled, let self else { return }
      self.timers[id] = nil
      self.runs.removeAll { $0.id == id && !$0.isOpenAfterEnd }
      self.save()
    }
  }

  private func save() {
    #if DEBUG
    if fixture { return }
    #endif
    // Every run that still needs the phone or the person: a move or delete
    // under way, and every end that kept the computer and waits on the person
    // (delete again, move again, push then delete), until they finish or close it.
    let unfinished = runs.filter { $0.phase == .moving || $0.phase == .deleting || $0.isOpenAfterEnd }
    if unfinished.isEmpty {
      UserDefaults.standard.removeObject(forKey: Self.storageKey)
    } else if let data = try? JSONEncoder().encode(unfinished) {
      UserDefaults.standard.set(data, forKey: Self.storageKey)
    }
  }

  #if DEBUG
  /// Fixture screens: these runs show as they are, and nothing is sent.
  func seedPreview(_ runs: [LaneMoveRun]) {
    fixture = true
    resumed = true
    self.runs = runs
  }
  #endif
}

private extension LaneMoveRun {
  /// A kept computer that waits on the person stays listed until they finish or close it.
  var isOpenAfterEnd: Bool { phase == .deleteFailed || phase == .moveAgain || phase == .pushFirst }
}
