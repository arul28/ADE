import SwiftUI

extension LanesTabView {
  /// The focused machine while the phone is connected to it, then every live
  /// machine with this repository: the places the Archived filter lists
  /// deleted lanes from. Disconnected already says so at the top of the tab.
  var recentlyDeletedMachines: [LaneRecentlyDeletedMachine] {
    var machines: [LaneRecentlyDeletedMachine] = []
    if syncService.connectionState == .connected {
      machines.append(LaneRecentlyDeletedMachine(id: "", name: focusedMachineName, projectId: nil, rootPath: nil))
    }
    for machine in remoteLanes.machines where machine.isLive {
      machines.append(LaneRecentlyDeletedMachine(
        id: machine.machineKey,
        name: machine.name,
        projectId: machine.markedProjectId,
        rootPath: machine.rootPath
      ))
    }
    return machines
  }

  @MainActor
  func restoreKeptLane(_ kept: LaneDeletionKept) async {
    do {
      let result = try await syncService.restoreDeletedLane(
        kept.id,
        targetProjectId: kept.projectId,
        targetProjectRootPath: kept.projectRootPath
      )
      await reload(refreshRemote: true)
      // After the reload, which clears the tab's message when it succeeds.
      if result.restoredUncommitted {
        ADEHaptics.success()
      } else {
        ADEHaptics.warning()
        errorMessage = deletedLaneRestoreMessage(kept.snapshot, result)
      }
    } catch {
      ADEHaptics.error()
      errorMessage = "Couldn’t restore \(kept.snapshot.laneName): \(SyncUserFacingError.message(for: error))"
    }
  }
}

// MARK: - Machines

/// One machine's checkout whose deleted lanes and chats Recently deleted
/// lists. `projectId`/`rootPath` are nil for the focused machine (the default
/// route); for another machine they are its machine-marked project, so every
/// call for one of its rows goes over that machine's own link.
struct LaneRecentlyDeletedMachine: Equatable, Identifiable, Hashable {
  let id: String
  let name: String
  let projectId: String?
  let rootPath: String?

  var isFocused: Bool { id.isEmpty }

  /// The same list as the Lanes tab's: the focused machine while the phone is
  /// connected to it, then every live machine with a checkout of the open
  /// repository. A machine that is not live (reconnecting, or an ADE Cloud
  /// computer that is asleep) is left out, so reading the list never wakes it.
  @MainActor
  static func everyLiveCopy(sync: SyncService) -> [LaneRecentlyDeletedMachine] {
    var machines: [LaneRecentlyDeletedMachine] = []
    if sync.connectionState == .connected {
      machines.append(LaneRecentlyDeletedMachine(id: "", name: sync.focusedMachineDisplayName, projectId: nil, rootPath: nil))
    }
    for repo in sync.listedRemoteReposForActiveProject() where sync.machineFleet?.isLive(repo.machineKey) == true {
      machines.append(LaneRecentlyDeletedMachine(
        id: repo.machineKey,
        name: repo.machineName,
        projectId: repo.markedProjectId,
        rootPath: repo.rootPath
      ))
    }
    return machines
  }

  /// A lane id the phone can navigate to and route by: another machine's
  /// lanes carry their machine (`workRemoteLaneId`).
  func navigationLaneId(_ laneId: String) -> String {
    guard !isFocused, !isWorkRemoteLaneId(laneId) else { return laneId }
    return workRemoteLaneId(machineKey: id, laneId: laneId)
  }
}

// MARK: - Copy

/// "kept 29 more days" from a save's expiry.
func deletedLaneKeptLabel(_ snapshot: DeletedLaneSnapshot, now: Date = Date()) -> String {
  guard let expires = parseLaneTimestamp(snapshot.expiresAt) else { return "kept for now" }
  let days = max(0, Int((expires.timeIntervalSince(now) / 86_400).rounded(.up)))
  return days <= 1 ? "kept 1 more day" : "kept \(days) more days"
}

/// "14m ago", "3d ago", "just now": the desktop's compact relative time.
func deletedAgo(_ timestamp: String) -> String {
  let compact = relativeTimestampCompact(timestamp)
  return compact == "now" ? "just now" : "\(compact) ago"
}

/// "Uncommitted files saved", "Deleted 2h ago, kept 29 more days", as the
/// desktop's row.
func deletedLaneMetaParts(_ snapshot: DeletedLaneSnapshot) -> [String] {
  let saved = snapshot.uncommitted ? "Uncommitted files saved" : "Unpushed commits saved"
  let when = "\(snapshot.isFreed ? "Space freed" : "Deleted") \(deletedAgo(snapshot.deletedAt))"
  return [saved, "\(when), \(deletedLaneKeptLabel(snapshot))"]
}

/// What a finished restore says after a delete's kept-work notice.
func deletedLaneRestoreMessage(_ snapshot: DeletedLaneSnapshot, _ result: RestoreDeletedLaneResult) -> String {
  let extra = (result.extraBranches ?? []).isEmpty ? "" : " Other commits it kept are on \((result.extraBranches ?? []).joined(separator: ", "))."
  guard result.restoredUncommitted else {
    return "\(snapshot.laneName) is back on \(result.branchName), but its uncommitted files did not apply and stay in Archived › Recently deleted: \(result.warning ?? "unknown error").\(extra)"
  }
  return "\(snapshot.laneName) is back on \(result.branchName)\(snapshot.uncommitted ? ", with its uncommitted files" : "").\(extra)"
}

func deletedChatTitle(_ chat: DeletedChat) -> String {
  let title = chat.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !title.isEmpty { return title }
  return chat.isCli ? "Untitled CLI session" : "Untitled chat"
}

/// The row's logo: a CLI's own tool, else the agent that keeps the
/// conversation, as the desktop's `deletedChatToolType`.
func deletedChatLogoProvider(_ chat: DeletedChat) -> String {
  if chat.isCli, let tool = chat.toolType?.trimmingCharacters(in: .whitespacesAndNewlines), !tool.isEmpty { return tool }
  return chat.sourceProvider.isEmpty ? chat.provider : chat.sourceProvider
}

func deletedChatModelLabel(_ chat: DeletedChat) -> String? {
  workKnownModelDisplayName(chat.modelId) ?? workPrettyModelNameFromId(chat.modelId)
}

/// "perf lane 3", "Deleted 2h ago", "CLI session", "Claude Opus 5.5"
func deletedChatMetaParts(_ chat: DeletedChat) -> [String] {
  var parts: [String] = []
  if chat.laneExists {
    parts.append(chat.laneName ?? "Its lane")
  } else {
    parts.append(chat.laneName.map { "\($0), lane deleted" } ?? "Lane deleted")
  }
  parts.append("Deleted \(deletedAgo(chat.deletedAt))")
  if chat.isCli { parts.append(chat.resumable == true ? "CLI session" : "CLI session, starts fresh") }
  if let model = deletedChatModelLabel(chat) { parts.append(model) }
  return parts
}

/// A row's meta items, joined by "·". A line breaks only between items, so
/// "Deleted 13m ago" never splits across two lines (the desktop's
/// `MetaLine`); an item wider than the row still wraps inside itself.
struct DeletedMetaLine: View {
  let parts: [String]

  var body: some View {
    DeletedMetaFlowLayout {
      ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
        // A no-break space keeps the "·" on its item's last line.
        Text(index < parts.count - 1 ? "\(part)\u{00A0}·" : part)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(parts.joined(separator: ", "))
  }
}

/// Places items left to right and starts a new line when the next one does
/// not fit. An item wider than the row wraps and gets the whole line. Lines
/// sit flush, like the lines of one wrapped text.
private struct DeletedMetaFlowLayout: Layout {
  /// About one space of the caption font, after each "·".
  var spacing: CGFloat = 4

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
    let lines = lines(maxWidth: proposal.width ?? .infinity, subviews: subviews)
    let width = lines.map(\.width).max() ?? 0
    return CGSize(width: proposal.width.map { min($0, width) } ?? width, height: lines.reduce(0) { $0 + $1.height })
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
    var y = bounds.minY
    for line in lines(maxWidth: bounds.width, subviews: subviews) {
      var x = bounds.minX
      for item in line.items {
        subviews[item.index].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(item.size))
        x += item.size.width + spacing
      }
      y += line.height
    }
  }

  private struct Line {
    var items: [(index: Int, size: CGSize)] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func lines(maxWidth: CGFloat, subviews: Subviews) -> [Line] {
    var lines: [Line] = []
    var current = Line()
    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      if size.width > maxWidth {
        if !current.items.isEmpty { lines.append(current) }
        let wrapped = subviews[index].sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
        lines.append(Line(items: [(index, wrapped)], width: wrapped.width, height: wrapped.height))
        current = Line()
        continue
      }
      let projected = current.items.isEmpty ? size.width : current.width + spacing + size.width
      if projected > maxWidth && !current.items.isEmpty {
        lines.append(current)
        current = Line(items: [(index, size)], width: size.width, height: size.height)
      } else {
        current.items.append((index, size))
        current.width = projected
        current.height = max(current.height, size.height)
      }
    }
    if !current.items.isEmpty { lines.append(current) }
    return lines
  }
}

// MARK: - Entries

/// A deleted chat, and the machine it lives on.
struct DeletedChatEntry: Identifiable, Equatable {
  let machine: LaneRecentlyDeletedMachine
  let chat: DeletedChat
  var id: String { "\(machine.id)\nchat\n\(chat.id)" }
  var at: Date { parseLaneTimestamp(chat.deletedAt) ?? .distantPast }
}

/// A deleted lane, with the chats that went with its delete.
struct DeletedLaneEntry: Identifiable, Equatable {
  let machine: LaneRecentlyDeletedMachine
  let lane: DeletedLaneSnapshot
  var chats: [DeletedChat]
  var id: String { "\(machine.id)\nlane\n\(lane.id)" }
  var at: Date { parseLaneTimestamp(lane.deletedAt) ?? .distantPast }

  func chatEntry(_ chat: DeletedChat) -> DeletedChatEntry {
    DeletedChatEntry(machine: machine, chat: chat)
  }
}

enum DeletedEntry: Identifiable, Equatable {
  case lane(DeletedLaneEntry)
  case chat(DeletedChatEntry)

  var id: String {
    switch self {
    case .lane(let entry): return entry.id
    case .chat(let entry): return entry.id
    }
  }

  var at: Date {
    switch self {
    case .lane(let entry): return entry.at
    case .chat(let entry): return entry.at
    }
  }
}

enum DeletedKindFilter: String, CaseIterable, Identifiable {
  case all, lanes, chats
  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .lanes: return "Lanes"
    case .chats: return "Chats"
    }
  }
}

/// Every machine's lanes and chats as one list, newest first. A chat that
/// went with a lane's delete sits under that lane when the lane's work was
/// kept; otherwise it is its own row. Mirrors the desktop's `buildEntries`.
func recentlyDeletedEntries(
  machines: [LaneRecentlyDeletedMachine],
  reads: [String: RecentlyDeletedStore.Read]
) -> [DeletedEntry] {
  var entries: [DeletedEntry] = []
  for machine in machines {
    guard let read = reads[machine.id] else { continue }
    var laneEntries: [DeletedLaneEntry] = read.lanes.map { DeletedLaneEntry(machine: machine, lane: $0, chats: []) }
    // The newest deleted save of each lane id holds its chats. A freed lane
    // is still there (archived); its chats were never deleted. Another
    // machine's `lanes.*` reply carries its machine in its lane ids and its
    // `chat.*` reply does not, so they meet on the plain id.
    func plain(_ laneId: String) -> String { workParseRemoteLaneId(laneId)?.laneId ?? laneId }
    var owner: [String: Int] = [:]
    for (index, entry) in laneEntries.enumerated() where !entry.lane.isFreed {
      let key = plain(entry.lane.laneId)
      if let held = owner[key], laneEntries[held].at >= entry.at { continue }
      owner[key] = index
    }
    var loose: [DeletedChat] = []
    for chat in read.chats {
      if chat.withLane == true, !chat.laneExists, let laneId = chat.laneId, let index = owner[plain(laneId)] {
        laneEntries[index].chats.append(chat)
      } else {
        loose.append(chat)
      }
    }
    for index in laneEntries.indices {
      laneEntries[index].chats.sort {
        (parseLaneTimestamp($0.lastActiveAt ?? $0.deletedAt) ?? .distantPast)
          > (parseLaneTimestamp($1.lastActiveAt ?? $1.deletedAt) ?? .distantPast)
      }
    }
    entries.append(contentsOf: laneEntries.map(DeletedEntry.lane))
    entries.append(contentsOf: loose.map { DeletedEntry.chat(DeletedChatEntry(machine: machine, chat: $0)) })
  }
  return entries.sorted { $0.at > $1.at }
}

private func deletedChatMatches(_ chat: DeletedChat, _ needle: String) -> Bool {
  deletedChatTitle(chat).lowercased().contains(needle)
    || (chat.laneName ?? "").lowercased().contains(needle)
    || workExternalSessionProviderName(chat.sourceProvider).lowercased().contains(needle)
}

/// The entries a filter and a search leave, newest first. Chats shows a
/// lane's chats as rows of their own.
func recentlyDeletedFiltered(_ entries: [DeletedEntry], kind: DeletedKindFilter, query: String) -> [DeletedEntry] {
  let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  var out: [DeletedEntry] = []
  for entry in entries {
    switch entry {
    case .chat(let chat):
      guard kind != .lanes else { continue }
      if needle.isEmpty || deletedChatMatches(chat.chat, needle) { out.append(entry) }
    case .lane(let lane):
      if kind == .chats {
        for chat in lane.chats where needle.isEmpty || deletedChatMatches(chat, needle) {
          out.append(.chat(lane.chatEntry(chat)))
        }
        continue
      }
      let laneHit = needle.isEmpty
        || lane.lane.laneName.lowercased().contains(needle)
        || (lane.lane.branchName ?? "").lowercased().contains(needle)
      if laneHit {
        out.append(entry)
        continue
      }
      let chats = lane.chats.filter { deletedChatMatches($0, needle) }
      if !chats.isEmpty {
        var narrowed = lane
        narrowed.chats = chats
        out.append(.lane(narrowed))
      }
    }
  }
  return kind == .chats ? out.sorted { $0.at > $1.at } : out
}

// MARK: - Store

/// What a finished action says, at the top of the list: a lane that came
/// back (with its chats), a chat that reopened, or why something failed. The
/// buttons open what came back.
struct RecentlyDeletedNotice: Identifiable, Equatable {
  enum Tone { case success, warning, failure }

  let id = UUID()
  var tone: Tone
  var title: String
  var message: String?
  /// "Open lane": a lane id the phone can navigate to.
  var openLaneId: String?
  /// "Open chat": the chat (or CLI session) that came back, and its lane.
  var openSessionId: String?
  var openSessionLaneId: String?
  var openSessionTitle = "Open chat"

  static func == (lhs: RecentlyDeletedNotice, rhs: RecentlyDeletedNotice) -> Bool { lhs.id == rhs.id }

  static func failure(_ title: String, _ error: Error) -> RecentlyDeletedNotice {
    RecentlyDeletedNotice(tone: .failure, title: title, message: SyncUserFacingError.message(for: error))
  }

  /// "<lane> is back. Its 2 chats are back too.", as the desktop's toast.
  static func restored(_ entry: DeletedLaneEntry, _ result: RestoreDeletedLaneResult) -> RecentlyDeletedNotice {
    let lane = entry.lane
    var parts: [String] = []
    if !result.restoredUncommitted {
      parts.append("Its uncommitted files did not apply and stay saved: \(result.warning ?? "unknown error").")
    } else if result.branchName != lane.branchName {
      parts.append("On branch \(result.branchName).")
    }
    let extra = result.extraBranches ?? []
    if !extra.isEmpty { parts.append("Other commits it kept are on \(extra.joined(separator: ", ")).") }
    let back = result.reopenedChats ?? []
    let stuck = result.chatsNotReopened ?? 0
    if !back.isEmpty { parts.append(back.count == 1 ? "Its chat is back too." : "Its \(back.count) chats are back too.") }
    if stuck > 0 {
      parts.append(stuck == 1
        ? "One chat couldn’t come back — it’s still in Recently deleted."
        : "\(stuck) chats couldn’t come back — they’re still in Recently deleted.")
    }
    let laneId = entry.machine.navigationLaneId(result.lane.id)
    return RecentlyDeletedNotice(
      tone: result.restoredUncommitted && stuck == 0 ? .success : .warning,
      title: lane.isFreed ? "\(lane.laneName)’s files are back" : "\(lane.laneName) is back",
      message: parts.isEmpty ? nil : parts.joined(separator: " "),
      openLaneId: laneId,
      // The newest chat that came back: the brain reopens them oldest first.
      openSessionId: back.last?.chatSessionId,
      openSessionLaneId: laneId
    )
  }

  static func reopened(_ entry: DeletedChatEntry, _ result: DeletedChatReopenResult) -> RecentlyDeletedNotice {
    let title = deletedChatTitle(entry.chat)
    let message: String
    if result.mode == "copy" {
      message = "\(title), as a copy in the lane you picked."
    } else if let notice = result.notice?.trimmingCharacters(in: .whitespacesAndNewlines), !notice.isEmpty {
      message = "\(title). \(notice)"
    } else {
      message = title
    }
    return RecentlyDeletedNotice(
      tone: .success,
      title: result.isCli ? "CLI session reopened" : "Chat reopened",
      message: message,
      openSessionId: result.chatSessionId,
      openSessionLaneId: entry.machine.navigationLaneId(result.laneId),
      openSessionTitle: result.isCli ? "Open session" : "Open chat"
    )
  }
}

/// Recently deleted from every live machine with the project, read and acted
/// on per machine: a lane and its chats live on the machine that ran them, so
/// every call for a row goes to the row's own machine. One slow or failed
/// machine never holds up the others. Shared by Settings › Deleted & Archived
/// and the Lanes tab's Archived filter.
@Observable
@MainActor
final class RecentlyDeletedStore {
  /// One machine's answer. `done` stays true across a re-read, so the rows
  /// already shown stay while it runs.
  struct Read: Equatable {
    var lanes: [DeletedLaneSnapshot] = []
    var chats: [DeletedChat] = []
    var done = false
    var error: String?
    /// The machine runs an ADE with no deleted chats to list.
    var outdated = false
  }

  struct Running: Equatable {
    enum Kind { case restore, drop, reopen, remove }
    let key: String
    let kind: Kind
  }

  private(set) var machines: [LaneRecentlyDeletedMachine] = []
  private(set) var reads: [String: Read] = [:]
  private(set) var entries: [DeletedEntry] = []
  var running: Running?
  var notice: RecentlyDeletedNotice?
  /// The chat whose conversation the sheet shows.
  var openChat: DeletedChatEntry?
  /// Why the open chat's last Reopen failed.
  var reopenError: String?
  var pendingDrop: DeletedLaneEntry?
  var pendingRemove: DeletedChatEntry?

  @ObservationIgnored private var loadedKey: String?
  @ObservationIgnored private var loadedProjectId: String?
  @ObservationIgnored private var readTasks: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private var generation = 0
  /// A preview's fixture: it never reads a machine.
  @ObservationIgnored private let frozen: Bool

  init(machines: [LaneRecentlyDeletedMachine] = [], reads: [String: Read] = [:], frozen: Bool = false) {
    self.machines = machines
    self.reads = reads
    self.frozen = frozen
    entries = recentlyDeletedEntries(machines: machines, reads: reads)
  }

  var isBusy: Bool { running != nil }
  var anyDone: Bool { machines.contains { reads[$0.id]?.done == true } }
  var pending: [LaneRecentlyDeletedMachine] { machines.filter { reads[$0.id]?.done != true } }
  var failed: [(machine: LaneRecentlyDeletedMachine, message: String)] {
    machines.compactMap { machine in reads[machine.id]?.error.map { (machine, $0) } }
  }
  var outdated: [LaneRecentlyDeletedMachine] { machines.filter { reads[$0.id]?.outdated == true } }

  /// Reads every machine once per `key` (the machines, the project and a
  /// reload token). A view's `.task` can run this on every appear; the reads
  /// themselves are not tied to the view, so scrolling away does not cancel one.
  func load(machines: [LaneRecentlyDeletedMachine], key: String, sync: SyncService) {
    guard !frozen, key != loadedKey else { return }
    loadedKey = key
    let projectId = sync.activeProjectId
    if loadedProjectId != projectId {
      // Another project's rows must not show, or restore into this one.
      for task in readTasks.values { task.cancel() }
      readTasks = [:]
      reads = [:]
      notice = nil
      openChat = nil
      generation += 1
    }
    loadedProjectId = projectId
    self.machines = machines
    let ids = Set(machines.map(\.id))
    reads = reads.filter { ids.contains($0.key) }
    rebuild()
    for machine in machines { read(machine, sync: sync) }
  }

  /// Reads one machine again: its Retry, or after an action on one of its rows.
  func reload(_ machineId: String, sync: SyncService) {
    guard !frozen, let machine = machines.first(where: { $0.id == machineId }) else { return }
    if reads[machineId]?.error != nil { reads[machineId]?.error = nil }
    read(machine, sync: sync)
  }

  private func read(_ machine: LaneRecentlyDeletedMachine, sync: SyncService) {
    readTasks[machine.id]?.cancel()
    let runGeneration = generation
    readTasks[machine.id] = Task { @MainActor [weak self] in
      async let lanesRead: Result<[DeletedLaneSnapshot], Error> = Self.capture {
        try await sync.listDeletedLanes(targetProjectId: machine.projectId, targetProjectRootPath: machine.rootPath)
      }
      async let chatsRead: Result<[DeletedChat], Error> = Self.capture {
        try await sync.listDeletedChats(targetProjectId: machine.projectId, targetProjectRootPath: machine.rootPath)
      }
      let (lanes, chats) = await (lanesRead, chatsRead)
      guard let self, !Task.isCancelled, runGeneration == self.generation else { return }
      var next = self.reads[machine.id] ?? Read()
      next.done = true
      next.error = nil
      next.outdated = false
      switch lanes {
      case .success(let rows): next.lanes = rows
      case .failure(let error):
        // A machine on an older ADE simply has no saved lanes to list.
        if !syncChatLaunchErrorIsUnsupportedCommand(error) { next.error = SyncUserFacingError.message(for: error) }
      }
      switch chats {
      case .success(let rows): next.chats = rows
      case .failure(let error):
        if syncChatLaunchErrorIsUnsupportedCommand(error) {
          next.chats = []
          next.outdated = true
        } else if next.error == nil {
          next.error = SyncUserFacingError.message(for: error)
        }
      }
      self.reads[machine.id] = next
      self.readTasks[machine.id] = nil
      self.rebuild()
    }
  }

  private static func capture<T>(_ work: () async throws -> T) async -> Result<T, Error> {
    do { return .success(try await work()) } catch { return .failure(error) }
  }

  private func rebuild() {
    let next = recentlyDeletedEntries(machines: machines, reads: reads)
    if next != entries { entries = next }
  }

  private func forget(laneId id: String, on machineId: String) {
    reads[machineId]?.lanes.removeAll { $0.id == id }
    rebuild()
  }

  private func forget(chatId id: String, on machineId: String) {
    reads[machineId]?.chats.removeAll { $0.id == id }
    rebuild()
  }

  // MARK: Actions (each on the row's own machine)

  /// Brings the lane back, and the chats its delete took. The brain reopens
  /// them inside the restore; an older one restores the lane alone, so the
  /// phone reopens them into the restored lane itself, oldest first, so the
  /// newest is the newest in the lane again.
  func restore(_ entry: DeletedLaneEntry, sync: SyncService, onRestored: (() async -> Void)?) async {
    guard running == nil else { return }
    running = Running(key: entry.id, kind: .restore)
    defer { running = nil }
    let machine = entry.machine
    do {
      var result = try await sync.restoreDeletedLane(
        entry.lane.id,
        targetProjectId: machine.projectId,
        targetProjectRootPath: machine.rootPath
      )
      if result.reopenedChats == nil, !entry.chats.isEmpty {
        var back: [RestoredLaneChat] = []
        var failed = 0
        for chat in entry.chats.reversed() {
          do {
            // Another machine's restored lane comes back with its machine in
            // its id, so the router sends this to the same machine.
            let reopened = try await sync.reopenDeletedChat(
              chat.id,
              laneId: result.lane.id,
              targetProjectId: machine.projectId,
              targetProjectRootPath: machine.rootPath
            )
            back.append(RestoredLaneChat(chatSessionId: reopened.chatSessionId, title: chat.title))
          } catch {
            failed += 1
          }
        }
        result.reopenedChats = back
        result.chatsNotReopened = failed
      }
      if result.restoredUncommitted && (result.chatsNotReopened ?? 0) == 0 {
        ADEHaptics.success()
      } else {
        ADEHaptics.warning()
      }
      if result.restoredUncommitted { forget(laneId: entry.lane.id, on: machine.id) }
      notice = .restored(entry, result)
    } catch {
      ADEHaptics.error()
      notice = .failure("Couldn’t restore \(entry.lane.laneName)", error)
    }
    reload(machine.id, sync: sync)
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
    reload(entry.machine.id, sync: sync)
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
      reload(entry.machine.id, sync: sync)
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
    reload(entry.machine.id, sync: sync)
  }

  func open(_ entry: DeletedChatEntry) {
    reopenError = nil
    openChat = entry
  }
}

// MARK: - The list

/// Recently deleted as List sections, for Settings › Deleted & Archived
/// (`.settings`: every lane and chat, grouped by day, in settings panels) and
/// the Lanes tab's Archived filter (`.flat`: lanes only, with the chats that
/// went with them, under one header). The conversation sheet hangs off the
/// List (`recentlyDeletedPresentations`), so a row scrolled out of view never
/// takes it along. Each confirm sits on its row, so the popover on a wide
/// screen points at that row.
struct RecentlyDeletedSections: View {
  enum Style { case flat, settings }

  let store: RecentlyDeletedStore
  let syncService: SyncService
  let machines: [LaneRecentlyDeletedMachine]
  let style: Style
  var query = ""
  var filter: DeletedKindFilter = .all
  var canRunLiveActions = true
  /// Changes when the list should read again: a pull to refresh, or a delete
  /// or restore elsewhere on the screen.
  var reloadToken = ""
  var onRestored: (() async -> Void)?

  private var loadKey: String {
    let machineKeys = machines.map { "\($0.id)|\($0.projectId ?? "")" }.joined(separator: ",")
    return "\(syncService.activeProjectId ?? "")|\(machineKeys)|\(reloadToken)"
  }

  private var showsMachine: Bool { machines.count > 1 }

  private var visible: [DeletedEntry] {
    let entries = style == .flat
      ? store.entries.filter { if case .lane = $0 { return true } else { return false } }
      : store.entries
    return recentlyDeletedFiltered(entries, kind: style == .flat ? .lanes : filter, query: query)
  }

  var body: some View {
    switch style {
    case .flat:
      // A modifier on an empty container never runs, and the flat list is
      // empty until the first read comes back, so the load hangs off a row
      // that is always there (zero high in a flat list).
      Color.clear
        .frame(height: 0)
        .accessibilityHidden(true)
        .adeFlatRow(insets: EdgeInsets(), separator: .hidden)
        .task(id: loadKey) { load() }
      notices
      flatContent
    case .settings:
      notices
      // Always at least one row (loading, empty, rows), each running the
      // same idempotent load; a settings list's 48pt rows would show a
      // zero-high anchor as a gap.
      settingsContent
        .task(id: loadKey) { load() }
    }
  }

  private func load() {
    store.load(machines: machines, key: loadKey, sync: syncService)
  }

  // MARK: Notices

  @ViewBuilder
  private var notices: some View {
    if let notice = store.notice {
      RecentlyDeletedNoticeCard(notice: notice, onDismiss: { store.notice = nil }, onOpenLane: { openLane($0) }, onOpenSession: { openSession($0, laneId: $1) })
        .modifier(DeletedNoticeRowChrome(style: style))
    }
    // Disconnected already says so at the top of the screen.
    ForEach(store.failed, id: \.machine.id) { failure in
      ADEFlatInlineNotice(
        message: "Couldn’t read \(failure.machine.name).",
        tint: ADEColor.danger,
        technicalDetail: failure.message,
        retry: { store.reload(failure.machine.id, sync: syncService) }
      )
      .modifier(DeletedNoticeRowChrome(style: style))
    }
    if style == .settings {
      ForEach(store.outdated) { machine in
        Text("\(machine.name) runs an older ADE. Update it there to see its deleted chats.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
          .modifier(DeletedNoticeRowChrome(style: style))
      }
    }
  }

  // MARK: Lanes tab

  @ViewBuilder
  private var flatContent: some View {
    let rows = visible
    if !rows.isEmpty {
      Section {
        ForEach(rows) { entry in
          if case .lane(let lane) = entry {
            laneRow(lane)
          }
        }
      } header: {
        ADEFlatSectionHeader("Recently deleted", detail: "\(rows.count)")
      }
    }
  }

  // MARK: Settings

  @ViewBuilder
  private var settingsContent: some View {
    let rows = visible
    if machines.isEmpty {
      Section {
        ADESettingsNotice(message: "Connect a computer to see what you deleted.")
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
      }
    } else if !store.anyDone {
      Section {
        HStack(spacing: 10) {
          ProgressView().controlSize(.small)
          Text("Looking for deleted lanes and chats…")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .adeSettingsListRow()
      }
    } else if store.entries.isEmpty && store.pending.isEmpty {
      Section {
        ADEEmptyStateView(
          symbol: "clock.arrow.circlepath",
          title: "Nothing deleted",
          message: "Lanes and chats you delete show up here, so you can bring them back."
        )
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
      }
    } else if rows.isEmpty && (!query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || filter != .all) {
      Section {
        Text(emptyMatchText)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeSettingsListRow()
      }
    } else if !rows.isEmpty {
      ForEach(dayGroups(rows), id: \.label) { group in
        Section {
          ForEach(group.rows) { entry in
            switch entry {
            case .lane(let lane): laneRow(lane)
            case .chat(let chat): chatRow(chat)
            }
          }
        } header: {
          ADESettingsHeader(title: group.label, inList: true) {
            Text("\(group.rows.count)")
              .font(.adeMono(12))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
      }
    }
    if store.anyDone, !store.pending.isEmpty {
      Section {
        Text("Still reading \(store.pending.map(\.name).joined(separator: ", "))…")
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
          .listRowBackground(Color.clear)
          .task(id: loadKey) { load() }
      }
    }
  }

  private var emptyMatchText: String {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty { return "Nothing deleted matches “\(trimmed)”." }
    return filter == .lanes ? "No deleted lanes." : "No deleted chats."
  }

  private func dayGroups(_ rows: [DeletedEntry]) -> [(label: String, rows: [DeletedEntry])] {
    var groups: [(label: String, rows: [DeletedEntry])] = []
    for entry in rows {
      let label = workImportDateGroup(entry.at == .distantPast ? nil : entry.at.timeIntervalSince1970)
      if groups.last?.label == label {
        groups[groups.count - 1].rows.append(entry)
      } else {
        groups.append((label, [entry]))
      }
    }
    return groups
  }

  // MARK: Rows

  private func laneRow(_ entry: DeletedLaneEntry) -> some View {
    let disabled = store.isBusy || !canRunLiveActions
    return DeletedLaneRow(
      entry: entry,
      machineName: showsMachine ? entry.machine.name : nil,
      restoring: store.running == RecentlyDeletedStore.Running(key: entry.id, kind: .restore),
      disabled: disabled,
      onRestore: { Task { await store.restore(entry, sync: syncService, onRestored: onRestored) } },
      onOpenChat: { store.open(entry.chatEntry($0)) }
    )
    .confirmationDialog(
      "Drop this lane’s saved work?",
      isPresented: Binding(
        get: { store.pendingDrop?.id == entry.id },
        set: { if !$0, store.pendingDrop?.id == entry.id { store.pendingDrop = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Drop", role: .destructive) {
        Task { await store.drop(entry, sync: syncService) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(deletedLaneDropMessage(entry.lane))
    }
    .modifier(DeletedRowChrome(style: style))
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        store.pendingDrop = entry
      } label: {
        Label("Drop", systemImage: "trash")
      }
      .disabled(disabled)
    }
    .contextMenu {
      Button {
        Task { await store.restore(entry, sync: syncService, onRestored: onRestored) }
      } label: {
        Label(entry.lane.isFreed ? "Put back" : "Restore", systemImage: "arrow.uturn.backward")
      }
      .disabled(disabled)
      Button(role: .destructive) {
        store.pendingDrop = entry
      } label: {
        Label("Drop saved work", systemImage: "trash")
      }
      .disabled(disabled)
    }
  }

  private func chatRow(_ entry: DeletedChatEntry) -> some View {
    let disabled = store.isBusy || !canRunLiveActions
    return DeletedChatRow(
      entry: entry,
      machineName: showsMachine ? entry.machine.name : nil,
      reopening: store.running == RecentlyDeletedStore.Running(key: entry.id, kind: .reopen),
      disabled: disabled,
      onOpen: { store.open(entry) },
      onReopen: {
        // A chat whose lane is gone needs a lane first: the sheet asks.
        if entry.chat.laneExists {
          Task { await store.reopen(entry, laneId: nil, sync: syncService) }
        } else {
          store.open(entry)
        }
      }
    )
    .confirmationDialog(
      "Remove from Recently deleted?",
      isPresented: Binding(
        get: { store.pendingRemove?.id == entry.id },
        set: { if !$0, store.pendingRemove?.id == entry.id { store.pendingRemove = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        Task { await store.remove(entry, sync: syncService) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(deletedChatRemoveMessage(entry.chat))
    }
    .modifier(DeletedRowChrome(style: style))
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        store.pendingRemove = entry
      } label: {
        Label("Remove", systemImage: "xmark")
      }
      .disabled(disabled)
    }
    .contextMenu {
      Button {
        store.open(entry)
      } label: {
        Label("Show conversation", systemImage: "text.bubble")
      }
      Button(role: .destructive) {
        store.pendingRemove = entry
      } label: {
        Label("Remove from list", systemImage: "xmark")
      }
      .disabled(disabled)
    }
  }

  // MARK: Navigation

  private func openLane(_ laneId: String) {
    syncService.settingsPresented = false
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: laneId)
  }

  private func openSession(_ sessionId: String, laneId: String?) {
    syncService.settingsPresented = false
    syncService.requestedWorkSessionNavigation = WorkSessionNavigationRequest(sessionId: sessionId, laneId: laneId)
  }
}

/// Each style's row chrome: flat rows on the page (Lanes) or the settings
/// panel's surface (Settings).
private struct DeletedRowChrome: ViewModifier {
  let style: RecentlyDeletedSections.Style

  func body(content: Content) -> some View {
    switch style {
    case .flat:
      content
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .adeFlatRow(insets: EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 6))
    case .settings:
      content.adeSettingsListRow()
    }
  }
}

private struct DeletedNoticeRowChrome: ViewModifier {
  let style: RecentlyDeletedSections.Style

  func body(content: Content) -> some View {
    switch style {
    case .flat:
      content.adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16), separator: .hidden)
    case .settings:
      content
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
        .listRowSeparator(.hidden)
    }
  }
}

// MARK: - Presentations

extension View {
  /// The conversation sheet of a `RecentlyDeletedSections`, on the List that
  /// hosts it.
  func recentlyDeletedPresentations(_ store: RecentlyDeletedStore, syncService: SyncService) -> some View {
    modifier(RecentlyDeletedPresentations(store: store, syncService: syncService))
  }
}

private struct RecentlyDeletedPresentations: ViewModifier {
  let store: RecentlyDeletedStore
  let syncService: SyncService

  func body(content: Content) -> some View {
    content
      .sheet(item: Binding(get: { store.openChat }, set: { store.openChat = $0 })) { entry in
        RecentlyDeletedChatSheet(entry: entry, store: store, syncService: syncService)
      }
  }
}

func deletedLaneDropMessage(_ lane: DeletedLaneSnapshot) -> String {
  if lane.isFreed { return "“\(lane.laneName)” stays archived, but ADE will no longer be able to put back its uncommitted files." }
  if lane.uncommitted { return "ADE will no longer be able to bring back “\(lane.laneName)” or its uncommitted files." }
  return "ADE will no longer be able to bring back “\(lane.laneName)”. Commits that only it held are lost."
}

// MARK: - Rows

/// The square at the start of a lane row.
struct DeletedLaneMark: View {
  @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 30

  var body: some View {
    Image(systemName: "arrow.triangle.branch")
      .font(.system(size: size * 0.47, weight: .semibold))
      .foregroundStyle(ADEColor.textSecondary)
      .frame(width: size, height: size)
      .background(ADEKit.track, in: RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
      .accessibilityHidden(true)
  }
}

/// A deleted lane, with the chats that went with it under it.
struct DeletedLaneRow: View {
  let entry: DeletedLaneEntry
  /// Shown when the list holds more than one machine.
  let machineName: String?
  let restoring: Bool
  let disabled: Bool
  let onRestore: () -> Void
  let onOpenChat: (DeletedChat) -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private var lane: DeletedLaneSnapshot { entry.lane }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 8) {
          text
          restoreButton
        }
      } else {
        HStack(alignment: .center, spacing: 12) {
          DeletedLaneMark()
          text
          Spacer(minLength: 8)
          restoreButton
        }
      }
      if !entry.chats.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(entry.chats) { chat in
            Button { onOpenChat(chat) } label: {
              DeletedNestedChatLine(chat: chat)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(deletedChatTitle(chat))")
          }
        }
        .padding(.leading, dynamicTypeSize.isAccessibilitySize ? 0 : 42)
      }
    }
  }

  private var text: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(lane.laneName)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
      if let branch = lane.branchName, !branch.isEmpty {
        Text(branch)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      DeletedMetaLine(parts: deletedLaneMetaParts(lane) + (machineName.map { [$0] } ?? []))
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
    }
  }

  private var restoreButton: some View {
    Button(action: onRestore) {
      if restoring {
        ProgressView().controlSize(.small)
      } else {
        Text(lane.isFreed ? "Put back" : "Restore")
      }
    }
    .buttonStyle(ADEKitButtonStyle(tone: .neutral))
    .disabled(disabled)
    .accessibilityLabel(restoreAccessibilityLabel)
  }

  private var restoreAccessibilityLabel: String {
    if lane.isFreed { return "Put back \(lane.laneName)'s files" }
    switch entry.chats.count {
    case 0: return "Restore \(lane.laneName)"
    case 1: return "Restore \(lane.laneName) and its chat"
    default: return "Restore \(lane.laneName) and its \(entry.chats.count) chats"
    }
  }
}

/// A chat under its deleted lane: logo, title, model.
private struct DeletedNestedChatLine: View {
  let chat: DeletedChat
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    HStack(spacing: 8) {
      DeletedChatLogo(chat: chat, size: 18)
      // At accessibility sizes the model goes under the title, whole,
      // instead of being cut to a letter beside it.
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 2) {
          title.lineLimit(2)
          if let model = deletedChatModelLabel(chat) { modelText(model) }
        }
      } else {
        title.lineLimit(1)
        if let model = deletedChatModelLabel(chat) {
          modelText(model).layoutPriority(-1)
        }
      }
      Spacer(minLength: 4)
      Image(systemName: "chevron.right")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityHidden(true)
    }
    .frame(minHeight: 34)
    .contentShape(Rectangle())
  }

  private var title: some View {
    Text(deletedChatTitle(chat))
      .font(.footnote)
      .foregroundStyle(ADEColor.textPrimary)
  }

  private func modelText(_ model: String) -> some View {
    Text(model)
      .font(.caption)
      .foregroundStyle(ADEColor.textMuted)
      .lineLimit(1)
  }
}

/// A deleted chat's mark: the provider logo the Work rows draw.
struct DeletedChatLogo: View {
  let chat: DeletedChat
  var size: CGFloat = 30

  var body: some View {
    let provider = deletedChatLogoProvider(chat)
    WorkProviderLogo(
      provider: provider,
      fallbackSymbol: chat.isCli ? "terminal.fill" : providerIcon(provider),
      tint: providerTint(provider),
      size: size
    )
    .accessibilityHidden(true)
  }
}

/// A chat deleted on its own (or, under Chats, one that went with its lane).
struct DeletedChatRow: View {
  let entry: DeletedChatEntry
  let machineName: String?
  let reopening: Bool
  let disabled: Bool
  let onOpen: () -> Void
  let onReopen: () -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .subheadline) private var logoSize: CGFloat = 30

  private var chat: DeletedChat { entry.chat }

  var body: some View {
    if dynamicTypeSize.isAccessibilitySize {
      VStack(alignment: .leading, spacing: 8) {
        openButton
        reopenButton
      }
    } else {
      HStack(alignment: .center, spacing: 12) {
        openButton
        Spacer(minLength: 8)
        reopenButton
      }
    }
  }

  private var openButton: some View {
    Button(action: onOpen) {
      HStack(alignment: .center, spacing: 12) {
        if !dynamicTypeSize.isAccessibilitySize {
          DeletedChatLogo(chat: chat, size: logoSize)
        }
        VStack(alignment: .leading, spacing: 3) {
          Text(deletedChatTitle(chat))
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
          DeletedMetaLine(parts: metaParts)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(deletedChatTitle(chat)). \(metaLine)")
    .accessibilityHint("Shows the conversation")
  }

  private var metaParts: [String] {
    deletedChatMetaParts(chat) + (machineName.map { [$0] } ?? [])
  }

  private var metaLine: String { metaParts.joined(separator: " · ") }

  private var reopenButton: some View {
    Button(action: onReopen) {
      if reopening {
        ProgressView().controlSize(.small)
      } else {
        Text(chat.laneExists ? "Reopen" : "Reopen…")
      }
    }
    .buttonStyle(ADEKitButtonStyle(tone: .neutral))
    .disabled(disabled)
    .accessibilityLabel("Reopen \(deletedChatTitle(chat))")
  }
}

// MARK: - Notice card

/// A finished action at the top of the list, with the way to what came back.
struct RecentlyDeletedNoticeCard: View {
  let notice: RecentlyDeletedNotice
  let onDismiss: () -> Void
  let onOpenLane: (String) -> Void
  let onOpenSession: (String, String?) -> Void

  private var tint: Color {
    switch notice.tone {
    case .success: return ADEColor.success
    case .warning: return ADEColor.warning
    case .failure: return ADEColor.danger
    }
  }

  private var icon: String {
    switch notice.tone {
    case .success: return "checkmark.circle.fill"
    case .warning: return "exclamationmark.triangle.fill"
    case .failure: return "exclamationmark.octagon.fill"
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: icon)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 32, height: 32)
          .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 3) {
          Text(notice.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          if let message = notice.message {
            Text(message)
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 0)
        Button(action: onDismiss) {
          Image(systemName: "xmark")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 32, height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss")
      }
      if notice.openLaneId != nil || notice.openSessionId != nil {
        HStack(spacing: 8) {
          if let laneId = notice.openLaneId {
            Button("Open lane") { onOpenLane(laneId) }
              .buttonStyle(ADEKitButtonStyle(prominent: true))
          }
          if let sessionId = notice.openSessionId {
            Button(notice.openSessionTitle) { onOpenSession(sessionId, notice.openSessionLaneId) }
              .buttonStyle(ADEKitButtonStyle(prominent: notice.openLaneId == nil))
          }
        }
        .padding(.leading, 44)
      }
    }
    .adeKitCard()
    .accessibilityElement(children: .contain)
  }
}

// MARK: - The kept-work notice after a delete

/// After a delete that kept work: its name, what was kept, Restore.
struct LaneDeletionKeptNotice: View {
  let kept: LaneDeletionKept
  let canRunLiveActions: Bool
  let onRestore: () async -> Void
  let onDismiss: () -> Void
  @State private var restoring = false

  var body: some View {
    ADENoticeCard(
      title: kept.snapshot.laneName,
      message: "\(kept.snapshot.uncommitted ? "Uncommitted work" : "Unpushed commits") kept 30 days in Archived.",
      icon: "tray.and.arrow.down.fill",
      tint: ADEColor.accent,
      actionTitle: "Restore",
      action: canRunLiveActions ? {
        Task {
          restoring = true
          await onRestore()
          restoring = false
        }
      } : nil,
      isBusy: restoring,
      onDismiss: onDismiss
    )
  }
}
