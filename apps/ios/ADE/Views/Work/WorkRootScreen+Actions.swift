import SwiftUI
import UIKit
import AVKit

extension WorkRootScreen {
  @MainActor
  func scheduleSessionPresentationRebuild() {
    sessionPresentationRebuildTask?.cancel()
    sessionPresentationRebuildGeneration += 1
    let generation = sessionPresentationRebuildGeneration
    let sessionsSnapshot = sessions
    let chatSummariesSnapshot = chatSummaries
    let lanesSnapshot = lanes
    let optimisticSessionsSnapshot = optimisticSessions
    let archivedSessionIdsSnapshot = archivedSessionIds
    let selectedStatusSnapshot = selectedStatus
    let selectedLaneIdSnapshot = selectedLaneId
    let searchTextSnapshot = searchText
    let organization = WorkSessionOrganization(rawValue: sessionOrganizationRaw) ?? .byStatus

    sessionPresentationRebuildTask = Task.detached(priority: .utility) {
      try? await Task.sleep(for: .milliseconds(40))
      guard !Task.isCancelled else { return }
      let nextPresentation = buildWorkRootSessionPresentation(
        sessions: sessionsSnapshot,
        optimisticSessions: optimisticSessionsSnapshot,
        chatSummaries: chatSummariesSnapshot,
        archivedSessionIds: archivedSessionIdsSnapshot,
        selectedStatus: selectedStatusSnapshot,
        selectedLaneId: selectedLaneIdSnapshot,
        searchText: searchTextSnapshot,
        organization: organization,
        orderedLanes: lanesSnapshot
      )
      await MainActor.run {
        guard generation == sessionPresentationRebuildGeneration, !Task.isCancelled else { return }
        if sessionPresentation != nextPresentation {
          sessionPresentation = nextPresentation
        }
        sessionPresentationRebuildTask = nil
      }
    }
  }

  @MainActor
  func refreshFromPullGesture() async {
    await reload(refreshRemote: true)
    if errorMessage == nil {
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
        refreshFeedbackToken += 1
      }
    }
  }

  @MainActor
  func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshWorkSessions()
      }
      async let sessionsTask = syncService.fetchSessions()
      async let lanesTask = syncService.fetchLanes()
      var loadedSessions = try await sessionsTask
      var loadedLanes = try await lanesTask
      if refreshRemote, loadedLanes.filter({ $0.archivedAt == nil }).isEmpty {
        try? await syncService.refreshLaneSnapshots()
        loadedSessions = try await syncService.fetchSessions()
        loadedLanes = try await syncService.fetchLanes()
      }
      if sessions != loadedSessions {
        sessions = loadedSessions
      }
      let activeLanes = loadedLanes.filter { $0.archivedAt == nil }
      if lanes != activeLanes {
        lanes = activeLanes
      }
      var nextOptimisticSessions = optimisticSessions
      for session in loadedSessions where nextOptimisticSessions[session.id] != nil {
        nextOptimisticSessions[session.id] = nil
      }
      if optimisticSessions != nextOptimisticSessions {
        optimisticSessions = nextOptimisticSessions
      }
      if isLive {
        lastCoalescedChatSummaryRefresh = Date()
        await refreshChatSummaries(for: loadedLanes)
      }
      if errorMessage != nil {
        errorMessage = nil
      }
    } catch {
      let message = error.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    }
  }

  /// Applies replicated SQLite rows to the Work list without fanning out per-lane host `listChatSessions` on every CRDT tick.
  @MainActor
  func reloadFromPersistedProjection() async {
    do {
      async let sessionsTask = syncService.fetchSessions()
      async let lanesTask = syncService.fetchLanes()
      let loadedSessions = try await sessionsTask
      let loadedLanes = try await lanesTask
      if sessions != loadedSessions {
        sessions = loadedSessions
      }
      let activeLanes = loadedLanes.filter { $0.archivedAt == nil }
      if lanes != activeLanes {
        lanes = activeLanes
      }
      var nextOptimisticSessions = optimisticSessions
      for session in loadedSessions where nextOptimisticSessions[session.id] != nil {
        nextOptimisticSessions[session.id] = nil
      }
      if optimisticSessions != nextOptimisticSessions {
        optimisticSessions = nextOptimisticSessions
      }
      if isLive {
        let now = Date()
        let minimumSummaryRefreshInterval = syncService.prefersReducedSyncLoad ? 8.0 : 2.6
        if now.timeIntervalSince(lastCoalescedChatSummaryRefresh) >= minimumSummaryRefreshInterval {
          lastCoalescedChatSummaryRefresh = now
          await refreshChatSummaries(for: loadedLanes)
        }
      }
      if errorMessage != nil {
        errorMessage = nil
      }
    } catch {
      let message = error.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    }
  }

  @MainActor
  func refreshChatSummaries(for lanes: [LaneSummary]) async {
    let lanesToRefresh: [LaneSummary] = {
      let activeLanes = lanes.filter { $0.archivedAt == nil }
      guard syncService.prefersReducedSyncLoad else { return activeLanes }
      let relevantLaneIds = Set((sessions + Array(optimisticSessions.values)).map(\.laneId))
      let candidates = activeLanes.filter { relevantLaneIds.contains($0.id) }
      // prefix(6) without prioritization can drop the lane the user is
      // looking at OR a lane currently awaiting input. Order so the selected
      // lane is first, then lanes with awaiting-input / live sessions, then
      // the remainder, before truncating.
      let allSessions = sessions + Array(optimisticSessions.values)
      let priorityLaneIds: Set<String> = Set(allSessions.compactMap { session in
        let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
        return (status == "awaiting-input" || status == "active") ? session.laneId : nil
      })
      let selected = selectedLaneId
      let prioritized = candidates.sorted { lhs, rhs in
        let lhsRank = laneRefreshPriorityRank(laneId: lhs.id, selectedLaneId: selected, priorityLaneIds: priorityLaneIds)
        let rhsRank = laneRefreshPriorityRank(laneId: rhs.id, selectedLaneId: selected, priorityLaneIds: priorityLaneIds)
        return lhsRank < rhsRank
      }
      return Array(prioritized.prefix(6))
    }()
    var updated: [String: AgentChatSessionSummary] = [:]
    await withTaskGroup(of: [(String, AgentChatSessionSummary)].self) { group in
      for lane in lanesToRefresh {
        group.addTask {
          do {
            let summaries = try await syncService.listChatSessions(laneId: lane.id)
            return summaries.map { ($0.sessionId, $0) }
          } catch {
            return []
          }
        }
      }
      for await pairs in group {
        for (sessionId, summary) in pairs {
          updated[sessionId] = summary
        }
      }
    }

    let relevantSessionIds = Set((sessions + Array(optimisticSessions.values)).map(\.id)).union(updated.keys)
    var nextSummaries = chatSummaries.filter { relevantSessionIds.contains($0.key) }
    for (sessionId, summary) in updated {
      nextSummaries[sessionId] = summary
    }
    if chatSummaries != nextSummaries {
      chatSummaries = nextSummaries
    }
    syncService.cacheChatSummaries(nextSummaries)
  }

  @MainActor
  func pollRunningChats() async {
    guard isLive, isWorkRootActive else { return }
    let running = liveChatSessions
    guard !running.isEmpty else { return }

    var lastTranscriptFingerprint: [String: String] = [:]
    while !Task.isCancelled && isLive && isWorkRootActive && !liveChatSessions.isEmpty {
      for session in liveChatSessions {
        try? await syncService.subscribeToChatEvents(sessionId: session.id)
        let streamed = syncService.chatEventHistory(sessionId: session.id)
        let revision = syncService.chatEventRevision(for: session.id)
        let terminalTail = syncService.terminalBuffers[session.id] ?? ""
        var terminalHasher = Hasher()
        terminalHasher.combine(terminalTail)
        let fingerprint = "\(revision)|\(streamed.count)|\(terminalHasher.finalize())"
        if lastTranscriptFingerprint[session.id] == fingerprint {
          continue
        }
        lastTranscriptFingerprint[session.id] = fingerprint
        let nextTranscript: [WorkChatEnvelope] = streamed.isEmpty
          ? parseWorkChatTranscript(syncService.terminalBuffers[session.id] ?? "")
          : makeWorkChatTranscript(from: streamed)
        if transcriptCache[session.id] != nextTranscript {
          transcriptCache[session.id] = nextTranscript
        }
      }
      try? await Task.sleep(nanoseconds: syncService.prefersReducedSyncLoad ? 1_800_000_000 : 900_000_000)
    }
  }

  func toggleArchive(_ session: TerminalSessionSummary) {
    Task {
      do {
        if isChatSession(session) {
          if archivedSessionIds.contains(session.id) {
            try await syncService.unarchiveChatSession(sessionId: session.id)
          } else {
            try await syncService.archiveChatSession(sessionId: session.id)
          }
          let localIds = Set(archivedSessionIdsStorage.split(separator: "\n").map(String.init))
          let prunedLocal = localIds.subtracting([session.id])
          archivedSessionIdsStorage = prunedLocal.sorted().joined(separator: "\n")
          await reload(refreshRemote: true)
          return
        }
        var archived = archivedSessionIds
        if archived.contains(session.id) {
          archived.remove(session.id)
        } else {
          archived.insert(session.id)
        }
        archivedSessionIdsStorage = archived.sorted().joined(separator: "\n")
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
      }
    }
  }

  func togglePin(_ session: TerminalSessionSummary) {
    Task {
      do {
        try await syncService.setSessionPinned(sessionId: session.id, pinned: !session.pinned)
        await reload()
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
      }
    }
  }

  func beginRename(_ session: TerminalSessionSummary) {
    renameTarget = session
    renameText = session.title
  }

  @MainActor
  func submitRename() async {
    guard let renameTarget else { return }
    let trimmedTitle = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedTitle.isEmpty else {
      ADEHaptics.error()
      errorMessage = "Session title cannot be empty."
      return
    }
    do {
      _ = try await syncService.updateChatSession(
        sessionId: renameTarget.id,
        title: trimmedTitle,
        manuallyNamed: true
      )
      try await syncService.updateSessionMeta(
        sessionId: renameTarget.id,
        title: trimmedTitle,
        manuallyNamed: true
      )
      if var summary = chatSummaries[renameTarget.id] {
        summary.title = trimmedTitle
        chatSummaries[renameTarget.id] = summary
        syncService.cacheChatSummary(summary)
      }
      if var session = optimisticSessions[renameTarget.id] {
        session.title = trimmedTitle
        optimisticSessions[renameTarget.id] = session
      }
      self.renameTarget = nil
      renameText = ""
      await reload()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  func copySessionId(_ session: TerminalSessionSummary) {
    UIPasteboard.general.string = session.id
  }

  func goToLane(_ session: TerminalSessionSummary) {
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: session.laneId)
  }

  func openSession(_ session: TerminalSessionSummary) {
    guard !navigationMutationPending else { return }
    navigationMutationPending = true
    selectedSessionTransitionId = session.id
    Task { @MainActor in
      await Task.yield()
      path.append(WorkSessionRoute(sessionId: session.id))
      navigationMutationPending = false
    }
  }

  func resumeSession(_ session: TerminalSessionSummary) {
    if archivedSessionIds.contains(session.id) {
      toggleArchive(session)
    }
    guard !isChatSession(session), session.status != "running", terminalSessionHasResumeTarget(session) else {
      openSession(session)
      return
    }
    Task {
      do {
        let provider = cliProviderForTerminalSession(session)
        let result = try await syncService.startCliSession(
          laneId: session.laneId,
          provider: provider,
          permissionMode: session.resumeMetadata?.launch.permissionMode ?? session.resumeMetadata?.permissionMode,
          title: session.title,
          resumeSessionId: session.id
        )
        let sessionToOpen: TerminalSessionSummary = {
          if let resumed = result.session {
            return resumed
          }
          var fallback = session
          fallback.id = result.sessionId
          fallback.ptyId = result.ptyId ?? session.ptyId
          fallback.status = "running"
          fallback.runtimeState = "running"
          fallback.endedAt = nil
          fallback.exitCode = nil
          return fallback
        }()
        if sessionToOpen.id != session.id {
          optimisticSessions[session.id] = nil
        }
        optimisticSessions[sessionToOpen.id] = sessionToOpen
        openSession(sessionToOpen)
        await reload(refreshRemote: true)
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  func deleteChatSession(_ session: TerminalSessionSummary) {
    Task {
      do {
        try await syncService.deleteChatSession(sessionId: session.id)
        let localIds = Set(archivedSessionIdsStorage.split(separator: "\n").map(String.init))
        let prunedLocal = localIds.subtracting([session.id])
        archivedSessionIdsStorage = prunedLocal.sorted().joined(separator: "\n")
        await reload(refreshRemote: true)
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
      }
    }
  }

  @MainActor
  func endSession(_ session: TerminalSessionSummary) async {
    defer { endTarget = nil }
    do {
      if isChatSession(session) {
        try await syncService.disposeChatSession(sessionId: session.id)
      } else {
        try await syncService.closeWorkSession(sessionId: session.id)
      }
      await reload(refreshRemote: true)
      if let refreshed = mergedSessions.first(where: { $0.id == session.id }), refreshed.status == session.status, isChatSession(session) {
        errorMessage = "This machine keeps chat sessions alive until the turn finishes. Reconnect and try again if the status does not update."
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func makeOptimisticSession(for summary: AgentChatSessionSummary) -> TerminalSessionSummary {
    let lane = lanes.first(where: { $0.id == summary.laneId })
    return TerminalSessionSummary(
      id: summary.sessionId,
      laneId: summary.laneId,
      laneName: lane?.name ?? summary.laneId,
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: summary.goal,
      toolType: toolTypeForProvider(summary.provider),
      title: summary.title ?? defaultWorkChatTitle(provider: summary.provider),
      status: summary.endedAt == nil ? "running" : "completed",
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: summary.lastOutputPreview,
      summary: summary.summary,
      runtimeState: normalizedRuntimeState(for: summary),
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: summary.idleSinceAt
    )
  }

}

private func cliProviderForTerminalSession(_ session: TerminalSessionSummary) -> String {
  if let provider = session.resumeMetadata?.provider, !provider.isEmpty {
    return provider
  }
  let toolType = (session.toolType ?? "").lowercased()
  if toolType.hasPrefix("claude") { return "claude" }
  if toolType.hasPrefix("codex") { return "codex" }
  if toolType.hasPrefix("cursor") { return "cursor" }
  if toolType.hasPrefix("droid") { return "droid" }
  if toolType.hasPrefix("opencode") { return "opencode" }
  return "shell"
}

/// Lower rank = higher priority. Selected lane > priority lanes (live /
/// awaiting-input) > everything else, so reduced-mode prefix(6) keeps the
/// most user-visible refreshes instead of dropping them.
fileprivate func laneRefreshPriorityRank(
  laneId: String,
  selectedLaneId: String,
  priorityLaneIds: Set<String>
) -> Int {
  if selectedLaneId != "all" && laneId == selectedLaneId { return 0 }
  if priorityLaneIds.contains(laneId) { return 1 }
  return 2
}
