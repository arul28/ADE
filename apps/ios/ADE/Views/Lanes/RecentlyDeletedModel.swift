import SwiftUI

// Recently deleted's words, entries and filters: the rows the store builds
// from every machine's read, and what a finished action says.

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

func deletedLaneDropMessage(_ lane: DeletedLaneSnapshot) -> String {
  if lane.isFreed { return "“\(lane.laneName)” stays archived, but \(Brand.name) will no longer be able to put back its uncommitted files." }
  if lane.uncommitted { return "\(Brand.name) will no longer be able to bring back “\(lane.laneName)” or its uncommitted files." }
  return "\(Brand.name) will no longer be able to bring back “\(lane.laneName)”. Commits that only it held are lost."
}

func deletedChatRemoveMessage(_ chat: DeletedChat) -> String {
  let keeper = workExternalSessionProviderName(chat.sourceProvider)
  let copy = chat.isCli && chat.resumable != true ? "its own copy, if it made one" : "its own copy"
  return "You won’t be able to reopen “\(deletedChatTitle(chat))” in \(Brand.name) anymore. \(keeper) keeps \(copy)."
}

// MARK: - Entries

/// A deleted chat, and the machine it lives on.
struct DeletedChatEntry: Identifiable, Equatable {
  let machine: ProjectCopyMachine
  let chat: DeletedChat
  var id: String { "\(machine.id)\nchat\n\(chat.id)" }
  var at: Date { parseLaneTimestamp(chat.deletedAt) ?? .distantPast }
}

/// A deleted lane, with the chats that went with its delete.
struct DeletedLaneEntry: Identifiable, Equatable {
  let machine: ProjectCopyMachine
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
  machines: [ProjectCopyMachine],
  reads: [String: RecentlyDeletedStore.Read]
) -> [DeletedEntry] {
  var entries: [DeletedEntry] = []
  for machine in machines {
    guard let read = reads[machine.id]?.value else { continue }
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

// MARK: - Notice

/// What a finished action says, at the top of the list: a lane that came
/// back (with its chats), a chat that reopened, or why something failed. The
/// buttons open what came back.
struct RecentlyDeletedNotice: Identifiable, Equatable {
  enum Tone {
    case success, warning, failure

    var tint: Color {
      switch self {
      case .success: return ADEColor.success
      case .warning: return ADEColor.warning
      case .failure: return ADEColor.danger
      }
    }

    var icon: String {
      switch self {
      case .success: return "checkmark.circle.fill"
      case .warning: return "exclamationmark.triangle.fill"
      case .failure: return "exclamationmark.octagon.fill"
      }
    }
  }

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

  /// The title and the message as one line, for a place that shows text only.
  var summary: String {
    message.map { "\(title). \($0)" } ?? title
  }

  static func failure(_ title: String, _ error: Error) -> RecentlyDeletedNotice {
    RecentlyDeletedNotice(tone: .failure, title: title, message: SyncUserFacingError.message(for: error))
  }

  /// "<lane> is back. Its 2 chats are back too.", as the desktop's toast.
  /// `laneId` is the restored lane's id the phone can navigate to.
  static func restored(_ lane: DeletedLaneSnapshot, _ result: RestoreDeletedLaneResult, laneId: String) -> RecentlyDeletedNotice {
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
