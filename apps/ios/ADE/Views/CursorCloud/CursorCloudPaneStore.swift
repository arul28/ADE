import SwiftUI

/// Cursor Cloud brand tokens for the pane. The accent mirrors the desktop
/// fleet view's violet so the two surfaces read as one feature.
enum CursorCloudBrand {
  static let primary = Color(red: 0.655, green: 0.545, blue: 0.980) // #A78BFA
  static let primaryBright = Color(red: 0.769, green: 0.710, blue: 0.992) // #C4B5FD
}

/// A group of finished agents sharing an owning lane, or keyed by repo+branch
/// when no ADE chat claims them.
struct CursorCloudAgentGroup: Identifiable, Equatable {
  let id: String
  let title: String
  /// Linear identifier prefix when the lane carries one.
  let issueIdentifier: String?
  var entries: [CursorCloudFleetEntry]
}

enum CursorCloudStatusPreset: String, CaseIterable, Identifiable {
  case all, active, finished, failed

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .active: return "Active"
    case .finished: return "Finished"
    case .failed: return "Failed"
    }
  }

  func matches(_ entry: CursorCloudFleetEntry) -> Bool {
    switch self {
    case .all: return true
    case .active: return entry.isActiveRun
    case .finished: return entry.displayStatus == "finished"
    case .failed: return entry.displayStatus == "error" || entry.displayStatus == "expired"
    }
  }
}

func cursorCloudRelativeAge(_ date: Date?) -> String? {
  guard let date else { return nil }
  let delta = Date().timeIntervalSince(date)
  if delta < 0 { return nil }
  if delta < 45 { return "now" }
  let minutes = Int(delta / 60)
  if minutes < 60 { return "\(minutes)m" }
  let hours = minutes / 60
  if hours < 48 { return "\(hours)h" }
  return "\(hours / 24)d"
}

@MainActor
final class CursorCloudPaneStore: ObservableObject {
  enum Phase: Equatable {
    case idle, loading, loaded, failed(String)
  }

  @Published var statusPreset: CursorCloudStatusPreset = .all {
    didSet { if oldValue != statusPreset { applyFilters() } }
  }
  @Published var laneFilterId: String? {
    didSet { if oldValue != laneFilterId { applyFilters() } }
  }
  @Published var showArchived = false {
    didSet { if oldValue != showArchived { applyFilters() } }
  }

  @Published private(set) var entries: [CursorCloudFleetEntry] = []
  @Published private(set) var visibleEntries: [CursorCloudFleetEntry] = []
  @Published private(set) var laneOptions: [(id: String, name: String)] = []
  @Published private(set) var phase: Phase = .idle
  @Published private(set) var relayLive = false
  @Published private(set) var keyMissing = false

  private let syncService: SyncService

  init(syncService: SyncService) {
    self.syncService = syncService
  }

  func reload() async {
    if phase == .loaded { /* soft refresh keeps prior rows visible */ }
    if entries.isEmpty { phase = .loading }
    keyMissing = false
    do {
      let result = try await syncService.fetchCursorCloudFleet()
      entries = result.items
      relayLive = result.relayLive
      rebuildLaneOptions()
      applyFilters()
      phase = .loaded
    } catch let error {
      let message = error.localizedDescription
      if message.range(of: "api key", options: .caseInsensitive) != nil
        || message.range(of: "cursor api key", options: .caseInsensitive) != nil {
        keyMissing = true
      }
      phase = entries.isEmpty ? .failed(message) : .loaded
    }
  }

  private func rebuildLaneOptions() {
    var seen: [String: String] = [:]
    for entry in entries {
      if let id = entry.ownership.laneId, let name = entry.ownership.laneName {
        seen[id] = name
      }
    }
    laneOptions = seen.map { (id: $0.key, name: $0.value) }.sorted { $0.name < $1.name }
  }

  private func applyFilters() {
    visibleEntries = entries.filter { entry in
      if !showArchived && entry.agent.isArchived { return false }
      if let laneFilterId, entry.ownership.laneId != laneFilterId { return false }
      return statusPreset.matches(entry)
    }
  }

  /// Active runs first; then per-lane groups; then Unlinked keyed repo+branch.
  var groupedSections: [CursorCloudAgentGroup] {
    let recency: (CursorCloudFleetEntry) -> Date? = { $0.agent.lastActivityDate }
    func latestDate(_ list: [CursorCloudFleetEntry]) -> Date {
      list.compactMap(recency).max() ?? Date.distantPast
    }

    var active: [CursorCloudFleetEntry] = []
    var byLane: [String: CursorCloudAgentGroup] = [:]
    var unlinkedOrder: [String] = []
    var unlinked: [String: CursorCloudAgentGroup] = [:]

    for entry in visibleEntries where entry.isActiveRun {
      active.append(entry)
    }
    for entry in visibleEntries where !entry.isActiveRun {
      if let laneId = entry.ownership.laneId {
        var group = byLane[laneId] ?? CursorCloudAgentGroup(
          id: "lane:\(laneId)",
          title: entry.ownership.laneName ?? "Lane",
          issueIdentifier: entry.ownership.linearIssueId,
          entries: []
        )
        group.entries.append(entry)
        byLane[laneId] = group
      } else {
        let repo = entry.agent.repos?.first ?? ""
        let key = "unlinked:\(repo)|\(entry.branch ?? "")"
        if unlinked[key] == nil { unlinkedOrder.append(key) }
        var group = unlinked[key] ?? CursorCloudAgentGroup(
          id: key,
          title: Self.unlinkedLabel(repo: repo, branch: entry.branch),
          issueIdentifier: nil,
          entries: []
        )
        group.entries.append(entry)
        unlinked[key] = group
      }
    }

    var sections: [CursorCloudAgentGroup] = []
    if !active.isEmpty {
      sections.append(CursorCloudAgentGroup(id: "active", title: "Active runs", issueIdentifier: nil, entries: active.sorted {
        (recency($0) ?? .distantPast) > (recency($1) ?? .distantPast)
      }))
    }
    sections.append(contentsOf: byLane.values.sorted { latestDate($0.entries) > latestDate($1.entries) })
    sections.append(contentsOf: unlinkedOrder.compactMap { unlinked[$0] }.sorted { latestDate($0.entries) > latestDate($1.entries) })
    return sections
  }

  static func unlinkedLabel(repo: String, branch: String?) -> String {
    let trimmedRepo = repo
      .replacingOccurrences(of: "https://", with: "")
      .replacingOccurrences(of: "http://", with: "")
      .replacingOccurrences(of: "git@github.com:", with: "")
      .replacingOccurrences(of: ".git", with: "")
    let parts = trimmedRepo.split(separator: "/")
    let shortRepo = parts.count >= 2 ? "\(parts[parts.count - 2])/\(parts[parts.count - 1])" : trimmedRepo
    if let branch, !branch.isEmpty { return "\(shortRepo) · \(branch)" }
    return shortRepo.isEmpty ? "Unknown repo" : shortRepo
  }
}
