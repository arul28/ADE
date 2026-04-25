import SwiftUI
import UIKit

extension WorkRootScreen {
  var bulkSelectedSessions: [TerminalSessionSummary] {
    mergedSessions.filter { selectedSessionIds.contains($0.id) }
  }

  var bulkSelectedRunningCount: Int {
    bulkSelectedSessions.filter { session in
      let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
      return status == "active" || status == "awaiting-input" || status == "idle"
    }.count
  }

  var bulkSelectedDeletableCount: Int {
    bulkSelectedSessions.filter { session in
      isChatSession(session) && normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id]) == "ended"
    }.count
  }

  var bulkSelectedArchivableCount: Int {
    bulkSelectedSessions.filter { session in
      isChatSession(session) && !archivedSessionIds.contains(session.id)
    }.count
  }

  var bulkSelectedRestorableCount: Int {
    bulkSelectedSessions.filter { session in
      isChatSession(session) && archivedSessionIds.contains(session.id)
    }.count
  }

  func startSelection(_ session: TerminalSessionSummary) {
    ADEHaptics.medium()
    withAnimation(.snappy) {
      isSelecting = true
      selectedSessionIds.insert(session.id)
    }
  }

  func toggleSelection(_ session: TerminalSessionSummary) {
    withAnimation(.snappy) {
      if selectedSessionIds.contains(session.id) {
        selectedSessionIds.remove(session.id)
      } else {
        selectedSessionIds.insert(session.id)
      }
    }
    if selectedSessionIds.isEmpty {
      withAnimation(.snappy) { isSelecting = false }
    }
  }

  func exitSelectionMode() {
    withAnimation(.snappy) {
      isSelecting = false
      selectedSessionIds.removeAll()
    }
  }

  @MainActor
  func performBulkClose() async {
    let targets = bulkSelectedSessions.filter { session in
      let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
      return status == "active" || status == "awaiting-input" || status == "idle"
    }
    guard !targets.isEmpty else { return }
    bulkBusy = true
    defer { bulkBusy = false }
    var failed = 0
    await withTaskGroup(of: Bool.self) { group in
      for session in targets {
        group.addTask {
          do {
            if isChatSession(session) {
              try await syncService.disposeChatSession(sessionId: session.id)
            } else {
              try await syncService.closeWorkSession(sessionId: session.id)
            }
            return true
          } catch {
            return false
          }
        }
      }
      for await success in group where !success {
        failed += 1
      }
    }
    await reload(refreshRemote: true)
    if failed > 0 {
      bulkActionErrorMessage = "Close failed for \(failed) selected session\(failed == 1 ? "" : "s")."
    }
    exitSelectionMode()
  }

  @MainActor
  func performBulkArchive() async {
    let targets = bulkSelectedSessions.filter { isChatSession($0) && !archivedSessionIds.contains($0.id) }
    guard !targets.isEmpty else { return }
    bulkBusy = true
    defer { bulkBusy = false }
    var failed = 0
    await withTaskGroup(of: Bool.self) { group in
      for session in targets {
        group.addTask {
          do {
            try await syncService.archiveChatSession(sessionId: session.id)
            return true
          } catch {
            return false
          }
        }
      }
      for await success in group where !success {
        failed += 1
      }
    }
    await reload(refreshRemote: true)
    if failed > 0 {
      bulkActionErrorMessage = "Archive failed for \(failed) chat\(failed == 1 ? "" : "s")."
    }
    exitSelectionMode()
  }

  @MainActor
  func performBulkRestore() async {
    let targets = bulkSelectedSessions.filter { isChatSession($0) && archivedSessionIds.contains($0.id) }
    guard !targets.isEmpty else { return }
    bulkBusy = true
    defer { bulkBusy = false }
    var failed = 0
    var succeededIds = Set<String>()
    await withTaskGroup(of: (String, Bool).self) { group in
      for session in targets {
        group.addTask {
          do {
            if isChatSession(session) {
              try await syncService.unarchiveChatSession(sessionId: session.id)
            }
            return (session.id, true)
          } catch {
            return (session.id, false)
          }
        }
      }
      for await (sessionId, success) in group {
        if success {
          succeededIds.insert(sessionId)
        } else {
          failed += 1
        }
      }
    }
    if !succeededIds.isEmpty {
      var localIds = Set(archivedSessionIdsStorage.split(separator: "\n").map(String.init))
      for sessionId in succeededIds { localIds.remove(sessionId) }
      archivedSessionIdsStorage = localIds.sorted().joined(separator: "\n")
    }
    await reload(refreshRemote: true)
    if failed > 0 {
      bulkActionErrorMessage = "Restore failed for \(failed) chat\(failed == 1 ? "" : "s")."
    }
    exitSelectionMode()
  }

  @MainActor
  func performBulkDelete() async {
    let targets = bulkSelectedSessions.filter { session in
      isChatSession(session) && normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id]) == "ended"
    }
    guard !targets.isEmpty else { return }
    bulkBusy = true
    defer { bulkBusy = false }
    var failed = 0
    var succeededIds = Set<String>()
    await withTaskGroup(of: (String, Bool).self) { group in
      for session in targets {
        group.addTask {
          do {
            try await syncService.deleteChatSession(sessionId: session.id)
            return (session.id, true)
          } catch {
            return (session.id, false)
          }
        }
      }
      for await (sessionId, success) in group {
        if success {
          succeededIds.insert(sessionId)
        } else {
          failed += 1
        }
      }
    }
    if !succeededIds.isEmpty {
      var localIds = Set(archivedSessionIdsStorage.split(separator: "\n").map(String.init))
      for sessionId in succeededIds { localIds.remove(sessionId) }
      archivedSessionIdsStorage = localIds.sorted().joined(separator: "\n")
    }
    await reload(refreshRemote: true)
    if failed > 0 {
      bulkActionErrorMessage = "Delete failed for \(failed) chat\(failed == 1 ? "" : "s")."
    }
    exitSelectionMode()
  }

  func performBulkExport() {
    let targets = bulkSelectedSessions
    guard !targets.isEmpty else { return }
    let markdown = formatWorkSessionBundleMarkdown(
      sessions: targets,
      chatSummaries: chatSummaries,
      archivedSessionIds: archivedSessionIds
    )
    let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
    let fileURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("ade-sessions-\(stamp).md")
    do {
      try markdown.write(to: fileURL, atomically: true, encoding: .utf8)
      bulkExportShare = WorkArtifactShareItem(items: [fileURL])
    } catch {
      bulkActionErrorMessage = "Export failed: \(error.localizedDescription)"
    }
  }
}

func formatWorkSessionBundleMarkdown(
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  archivedSessionIds: Set<String>
) -> String {
  var lines: [String] = []
  lines.append("# ADE session bundle")
  lines.append("")
  lines.append("Exported: \(ISO8601DateFormatter().string(from: Date()))")
  lines.append("Sessions: \(sessions.count)")
  lines.append("")
  lines.append("---")
  lines.append("")
  for session in sessions {
    let kind = isChatSession(session) ? "Chat" : "Terminal"
    let title = workMarkdownLine(session.title).isEmpty ? session.id : workMarkdownLine(session.title)
    let laneLabel = workMarkdownLine(session.laneName).isEmpty ? workMarkdownLine(session.laneId) : workMarkdownLine(session.laneName)
    let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
    let isArchived = archivedSessionIds.contains(session.id)
    lines.append("## \(title)")
    lines.append("")
    lines.append("- **Kind:** \(kind)")
    lines.append("- **Session ID:** `\(session.id)`")
    lines.append("- **Lane:** \(laneLabel)")
    lines.append("- **Status:** \(status)\(isArchived ? " (archived)" : "")")
    lines.append("- **Started:** \(workMarkdownLine(session.startedAt))")
    if let ended = session.endedAt {
      lines.append("- **Ended:** \(workMarkdownLine(ended))")
    }
    if let toolType = session.toolType {
      lines.append("- **Tool:** \(workMarkdownLine(toolType))")
    }
    if let goal = session.goal, !goal.isEmpty {
      lines.append("")
      lines.append("**Goal:** \(workMarkdownLine(goal))")
    }
    lines.append("")
    lines.append("---")
    lines.append("")
  }
  return lines.joined(separator: "\n")
}

private func workMarkdownLine(_ value: String) -> String {
  value
    .components(separatedBy: .whitespacesAndNewlines)
    .filter { !$0.isEmpty }
    .joined(separator: " ")
}
