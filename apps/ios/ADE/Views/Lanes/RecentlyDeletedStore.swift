import OSLog
import SwiftUI

private let recentlyDeletedLog = Logger(subsystem: "com.ade.ios", category: "recently-deleted")

extension SyncService {
  /// Brings a deleted lane back from its saved work, with the chats its delete
  /// took (`chats`, newest first). The host reopens those chats inside the
  /// restore. A host whose restore hook is missing or failed returns no
  /// `reopenedChats`. The phone then reopens `chats` into the restored lane
  /// itself, oldest first, so the newest is the newest in the lane again. An
  /// older host never marks a chat as gone with its lane, so `chats` is empty
  /// for its lanes. Both Recently deleted and the kept-work notice after a
  /// delete restore through here.
  func restoreDeletedLaneAndChats(
    _ snapshot: DeletedLaneSnapshot,
    chats: [DeletedChat],
    targetProjectId: String?,
    targetProjectRootPath: String?
  ) async throws -> RestoreDeletedLaneResult {
    var result = try await restoreDeletedLane(
      snapshot.id,
      targetProjectId: targetProjectId,
      targetProjectRootPath: targetProjectRootPath
    )
    guard result.reopenedChats == nil, !chats.isEmpty else { return result }
    var back: [RestoredLaneChat] = []
    var failed = 0
    for chat in chats.reversed() {
      do {
        // Another machine's restored lane comes back with its machine in its
        // id, so the router sends this to the same machine.
        let reopened = try await reopenDeletedChat(
          chat.id,
          laneId: result.lane.id,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
        back.append(RestoredLaneChat(chatSessionId: reopened.chatSessionId, title: chat.title))
      } catch {
        failed += 1
        recentlyDeletedLog.warning("restore reopen_chat_failed chat=\(chat.id, privacy: .public) error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      }
    }
    result.reopenedChats = back
    result.chatsNotReopened = failed
    return result
  }
}

/// Recently deleted from every live machine with the project, read and acted
/// on per machine: a lane and its chats live on the machine that ran them, so
/// every call for a row goes to the row's own machine. Shared by Settings ›
/// Deleted & Archived and the Lanes tab's Archived filter.
@Observable
@MainActor
final class RecentlyDeletedStore {
  /// One machine's deleted lanes and chats.
  struct Rows: Equatable {
    var lanes: [DeletedLaneSnapshot] = []
    var chats: [DeletedChat] = []
  }

  typealias Read = EveryMachineReads<Rows>.Read

  struct Running: Equatable {
    enum Kind { case restore, drop, reopen, remove }
    let key: String
    let kind: Kind
  }

  let reads: EveryMachineReads<Rows>
  private(set) var entries: [DeletedEntry] = []
  var running: Running?
  var notice: RecentlyDeletedNotice?
  /// The chat whose conversation the sheet shows.
  var openChat: DeletedChatEntry?
  /// Why the open chat's last Reopen failed.
  var reopenError: String?
  var pendingDrop: DeletedLaneEntry?
  var pendingRemove: DeletedChatEntry?

  /// `frozen` is a preview's fixture: it never reads a machine.
  init(machines: [ProjectCopyMachine] = [], reads: [String: Read] = [:], frozen: Bool = false) {
    self.reads = EveryMachineReads(machines: machines, reads: reads, frozen: frozen, fetch: Self.fetch)
    rebuild()
    self.reads.onChange = { [weak self] in self?.rebuild() }
    self.reads.onProjectChange = { [weak self] in
      self?.notice = nil
      self?.openChat = nil
    }
  }

  var isBusy: Bool { running != nil }

  private static func fetch(_ machine: ProjectCopyMachine, sync: SyncService) async -> (Read?) -> Read {
    async let lanesRead: Result<[DeletedLaneSnapshot], Error> = capture {
      try await sync.listDeletedLanes(targetProjectId: machine.projectId, targetProjectRootPath: machine.rootPath)
    }
    async let chatsRead: Result<[DeletedChat], Error> = capture {
      try await sync.listDeletedChats(targetProjectId: machine.projectId, targetProjectRootPath: machine.rootPath)
    }
    let (lanes, chats) = await (lanesRead, chatsRead)
    return { previous in
      var next = previous ?? Read(value: Rows())
      next.done = true
      next.error = nil
      next.outdated = false
      switch lanes {
      case .success(let rows): next.value.lanes = rows
      case .failure(let error):
        // A machine on an older ADE simply has no saved lanes to list.
        if !syncChatLaunchErrorIsUnsupportedCommand(error) { next.error = SyncUserFacingError.message(for: error) }
      }
      switch chats {
      case .success(let rows): next.value.chats = rows
      case .failure(let error):
        if syncChatLaunchErrorIsUnsupportedCommand(error) {
          next.value.chats = []
          next.outdated = true
        } else if next.error == nil {
          next.error = SyncUserFacingError.message(for: error)
        }
      }
      return next
    }
  }

  private static func capture<T>(_ work: () async throws -> T) async -> Result<T, Error> {
    do { return .success(try await work()) } catch { return .failure(error) }
  }

  private func rebuild() {
    let next = recentlyDeletedEntries(machines: reads.machines, reads: reads.byMachine)
    if next != entries { entries = next }
  }

  private func forget(laneId id: String, on machineId: String) {
    reads.update(machineId) { rows in rows.lanes.removeAll { $0.id == id } }
  }

  private func forget(chatId id: String, on machineId: String) {
    reads.update(machineId) { rows in rows.chats.removeAll { $0.id == id } }
  }

  // MARK: Actions (each on the row's own machine)

  /// Brings the lane back, and the chats its delete took
  /// (`SyncService.restoreDeletedLaneAndChats`).
  func restore(_ entry: DeletedLaneEntry, sync: SyncService, onRestored: (() async -> Void)?) async {
    guard running == nil else { return }
    running = Running(key: entry.id, kind: .restore)
    defer { running = nil }
    let machine = entry.machine
    do {
      let result = try await sync.restoreDeletedLaneAndChats(
        entry.lane,
        chats: entry.chats,
        targetProjectId: machine.projectId,
        targetProjectRootPath: machine.rootPath
      )
      let restored = RecentlyDeletedNotice.restored(entry.lane, result, laneId: machine.navigationLaneId(result.lane.id))
      if restored.tone == .success {
        ADEHaptics.success()
      } else {
        ADEHaptics.warning()
      }
      if result.restoredUncommitted { forget(laneId: entry.lane.id, on: machine.id) }
      notice = restored
    } catch {
      ADEHaptics.error()
      notice = .failure("Couldn’t restore \(entry.lane.laneName)", error)
    }
    reads.reload(machine.id, sync: sync)
    await onRestored?()
  }

  func drop(_ entry: DeletedLaneEntry, sync: SyncService) async {
    guard running == nil else { return }
    running = Running(key: entry.id, kind: .drop)
    defer { running = nil }
    do {
      try await sync.removeDeletedLane(
        entry.lane.id,
        targetProjectId: entry.machine.projectId,
        targetProjectRootPath: entry.machine.rootPath
      )
      forget(laneId: entry.lane.id, on: entry.machine.id)
    } catch {
      ADEHaptics.error()
      notice = .failure("Couldn’t drop that lane’s saved work", error)
    }
    reads.reload(entry.machine.id, sync: sync)
  }

  /// Reopens a chat in its own lane, or (`laneId`, a lane of the same
  /// machine) as a copy in another one. True when it came back.
  @discardableResult
  func reopen(_ entry: DeletedChatEntry, laneId: String?, sync: SyncService) async -> Bool {
    guard running == nil else { return false }
    running = Running(key: entry.id, kind: .reopen)
    defer { running = nil }
    reopenError = nil
    do {
      let result = try await sync.reopenDeletedChat(
        entry.chat.id,
        laneId: laneId,
        targetProjectId: entry.machine.projectId,
        targetProjectRootPath: entry.machine.rootPath
      )
      ADEHaptics.success()
      forget(chatId: entry.chat.id, on: entry.machine.id)
      if openChat?.id == entry.id { openChat = nil }
      notice = .reopened(entry, result)
      reads.reload(entry.machine.id, sync: sync)
      return true
    } catch {
      ADEHaptics.error()
      reopenError = SyncUserFacingError.message(for: error)
      // Reopened from the list without the sheet: open it to say why.
      if openChat?.id != entry.id { openChat = entry }
      return false
    }
  }

  func remove(_ entry: DeletedChatEntry, sync: SyncService) async {
    guard running == nil else { return }
    running = Running(key: entry.id, kind: .remove)
    defer { running = nil }
    do {
      try await sync.removeDeletedChats(
        [entry.chat.id],
        targetProjectId: entry.machine.projectId,
        targetProjectRootPath: entry.machine.rootPath
      )
      forget(chatId: entry.chat.id, on: entry.machine.id)
      if openChat?.id == entry.id { openChat = nil }
    } catch {
      ADEHaptics.error()
      notice = .failure("Couldn’t remove that chat", error)
    }
    reads.reload(entry.machine.id, sync: sync)
  }

  func open(_ entry: DeletedChatEntry) {
    reopenError = nil
    openChat = entry
  }
}
