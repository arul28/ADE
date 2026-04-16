import SwiftUI
import UIKit
import AVKit

extension WorkRootScreen {
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
      sessions = loadedSessions
      lanes = loadedLanes.filter { $0.archivedAt == nil }
      for session in loadedSessions where optimisticSessions[session.id] != nil {
        optimisticSessions[session.id] = nil
      }
      if isLive {
        lastCoalescedChatSummaryRefresh = Date()
        await refreshChatSummaries(for: loadedLanes)
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
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
      sessions = loadedSessions
      lanes = loadedLanes.filter { $0.archivedAt == nil }
      for session in loadedSessions where optimisticSessions[session.id] != nil {
        optimisticSessions[session.id] = nil
      }
      if isLive {
        let now = Date()
        if now.timeIntervalSince(lastCoalescedChatSummaryRefresh) >= 2.6 {
          lastCoalescedChatSummaryRefresh = now
          await refreshChatSummaries(for: loadedLanes)
        }
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
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
    chatSummaries = nextSummaries
  }

  @MainActor
  func pollRunningChats() async {
    guard isLive else { return }
    let running = liveChatSessions
    guard !running.isEmpty else { return }

    var lastTranscriptFingerprint: [String: String] = [:]
    while !Task.isCancelled && isLive && !liveChatSessions.isEmpty {
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
        transcriptCache[session.id] = nextTranscript
      }
      try? await Task.sleep(nanoseconds: 900_000_000)
    }
  }

  /// Rebuilds `activityFeedEntries` from cached transcripts, reusing any prior parse whose buffer
  /// fingerprint is unchanged. Only sessions without a streamed `transcriptCache` entry fall back to
  /// parsing the terminal buffer, and that parse is memoized in `activityTranscriptCache`.
  @MainActor
  func rebuildActivityFeed() {
    let sources = activitySessions
    guard !sources.isEmpty else {
      if !activityFeedEntries.isEmpty {
        activityFeedEntries = []
      }
      if !activityTranscriptCache.isEmpty {
        activityTranscriptCache = [:]
      }
      return
    }

    var nextCache: [String: WorkActivityTranscriptCacheEntry] = [:]
    nextCache.reserveCapacity(sources.count)
    var activities: [WorkAgentActivity] = []

    for session in sources {
      let transcript: [WorkChatEnvelope]
      if let streamed = transcriptCache[session.id] {
        transcript = streamed
      } else {
        let buffer = syncService.terminalBuffers[session.id] ?? ""
        let fingerprint = workActivityBufferFingerprint(buffer)
        if let existing = activityTranscriptCache[session.id], existing.fingerprint == fingerprint {
          transcript = existing.transcript
          nextCache[session.id] = existing
        } else {
          let parsed = parseWorkChatTranscript(buffer)
          transcript = parsed
          nextCache[session.id] = WorkActivityTranscriptCacheEntry(fingerprint: fingerprint, transcript: parsed)
        }
      }
      activities.append(contentsOf: deriveWorkAgentActivities(
        from: transcript,
        session: WorkAgentActivityContext(
          sessionId: session.id,
          title: session.title,
          laneName: session.laneName,
          status: normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id]),
          startedAt: session.startedAt
        )
      ))
    }

    activities.sort { lhs, rhs in
      if lhs.startedAt == rhs.startedAt {
        return lhs.agentName < rhs.agentName
      }
      return lhs.startedAt > rhs.startedAt
    }

    activityFeedEntries = activities
    activityTranscriptCache = nextCache
  }

  func toggleArchive(_ session: TerminalSessionSummary) {
    var archived = archivedSessionIds
    if archived.contains(session.id) {
      archived.remove(session.id)
    } else {
      archived.insert(session.id)
    }
    archivedSessionIdsStorage = archived.sorted().joined(separator: "\n")
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

  func resumeSession(_ session: TerminalSessionSummary) {
    if archivedSessionIds.contains(session.id) {
      toggleArchive(session)
    }
    selectedSessionTransitionId = session.id
    path.append(WorkSessionRoute(sessionId: session.id))
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

  var statusNotice: ADENoticeCard? {
    let hasCachedSessions = !mergedSessions.isEmpty
    switch workStatus.phase {
    case .disconnected:
      return ADENoticeCard(
        title: hasCachedSessions ? "Showing cached work" : "Host disconnected",
        message: hasCachedSessions
          ? (needsRepairing
              ? "Cached chats and terminal sessions stay readable, but the previous host trust was cleared. Pair again before trusting active work state."
              : "Cached chats and terminal sessions stay readable. Reconnect to stream output, refresh status, or start a new chat.")
          : (syncService.activeHostProfile == nil
              ? "Pair with a host to create chats, stream tool activity, and fetch proof artifacts."
              : "Reconnect to create chats, stream transcripts, and refresh agent activity."),
        icon: "terminal",
        tint: ADEColor.warning,
        actionTitle: syncService.activeHostProfile == nil ? (needsRepairing ? "Pair again" : "Pair with host") : "Reconnect",
        action: {
          if syncService.activeHostProfile == nil {
            syncService.settingsPresented = true
          } else {
            Task {
              await syncService.reconnectIfPossible(userInitiated: true)
              await reload(refreshRemote: true)
            }
          }
        }
      )
    case .hydrating:
      return ADENoticeCard(
        title: "Hydrating work sessions",
        message: "Pulling host sessions, chat metadata, and proof artifacts so Work matches the desktop chat surface.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.accent,
        actionTitle: nil,
        action: nil
      )
    case .syncingInitialData:
      return ADENoticeCard(
        title: "Syncing initial data",
        message: "Waiting for the host to finish syncing core project data before Work hydrates session state.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "Work hydration failed",
        message: workStatus.lastError ?? "The host session list did not hydrate cleanly.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      return nil
    }
  }
}
