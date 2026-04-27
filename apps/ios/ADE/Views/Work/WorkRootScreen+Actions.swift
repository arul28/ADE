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
        if now.timeIntervalSince(lastCoalescedChatSummaryRefresh) >= 2.6 {
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
    var updated: [String: AgentChatSessionSummary] = [:]
    await withTaskGroup(of: [(String, AgentChatSessionSummary)].self) { group in
      for lane in lanes where lane.archivedAt == nil {
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
      try? await Task.sleep(nanoseconds: 900_000_000)
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
    openSession(session)
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
        errorMessage = "This host keeps chat runtimes alive until the turn finishes. Reconnect and try again if the status does not update."
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
