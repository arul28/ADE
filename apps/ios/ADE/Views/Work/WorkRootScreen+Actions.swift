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
    let pullRequestsSnapshot = pullRequests
    let githubPrsSnapshot = syncService.laneGithubPrItems
    // Fold offline "Pending sync" chat-creation rows into the optimistic set so
    // they render through the same machinery; committed rows win on id collision.
    let optimisticSessionsSnapshot = optimisticSessions
      .merging(pendingChatCreationOptimisticSessions) { current, _ in current }
    let archivedSessionIdsSnapshot = archivedSessionIds
    let selectedStatusSnapshot = selectedStatus
    let selectedLaneIdSnapshot = selectedLaneId
    let searchTextSnapshot = searchText
    let outputSearchBySessionId = workSessionOutputSearchIndexBySessionId(
      buffers: searchTextSnapshot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [:] : syncService.terminalBuffers
    )
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
        outputSearchBySessionId: outputSearchBySessionId,
        organization: organization,
        orderedLanes: lanesSnapshot,
        pullRequests: pullRequestsSnapshot,
        githubPrs: githubPrsSnapshot
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
  func hydrateSearchOutputBuffersIfNeeded() async {
    guard isLive, isWorkRootActive else { return }
    guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    let candidates = mergedSessions
      .filter { session in
        !isRunOwnedSession(session)
          && syncService.terminalBuffers[session.id] == nil
          && normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id]) != "ended"
      }
      .prefix(8)
    guard !candidates.isEmpty else { return }

    for session in candidates {
      guard isLive, !Task.isCancelled else { return }
      try? await syncService.subscribeTerminal(sessionId: session.id)
    }
    scheduleSessionPresentationRebuild()
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
      let loadedPullRequests = try await syncService.fetchPullRequestListItems()
      if pullRequests != loadedPullRequests {
        pullRequests = loadedPullRequests
      }
      // Layer in GitHub PRs opened outside ADE (matched by branch). Best-effort,
      // non-blocking, internally throttled; pull-to-refresh forces a fresh fetch.
      Task { await syncService.refreshLaneGithubPrItems(force: refreshRemote) }
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
      let loadedPullRequests = try await syncService.fetchPullRequestListItems()
      if pullRequests != loadedPullRequests {
        pullRequests = loadedPullRequests
      }
      Task { await syncService.refreshLaneGithubPrItems() }
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

  func toggleArchive(_ session: TerminalSessionSummary) {
    Task {
      do {
        if isChatSession(session) {
          if archivedSessionIds.contains(session.id) {
            try await syncService.unarchiveChatSession(sessionId: session.id)
            applyArchivedSessionOverride(sessionIds: [session.id], archived: false)
          } else {
            try await syncService.archiveChatSession(sessionId: session.id)
            applyArchivedSessionOverride(sessionIds: [session.id], archived: true)
          }
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
  func submitRename(target capturedTarget: TerminalSessionSummary? = nil, title capturedTitle: String? = nil) async {
    guard let renameTarget = capturedTarget ?? renameTarget else { return }
    let trimmedTitle = (capturedTitle ?? renameText).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedTitle.isEmpty else {
      ADEHaptics.error()
      errorMessage = "Session title cannot be empty."
      return
    }
    do {
      try await syncService.updateSessionMeta(
        sessionId: renameTarget.id,
        title: trimmedTitle,
        manuallyNamed: true
      )
      _ = try? await syncService.updateChatSession(
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

  func copySessionDeepLink(_ session: TerminalSessionSummary) {
    UIPasteboard.general.string = workSessionDeepLink(
      sessionId: session.id,
      laneId: resolvedWorkNavigationLaneId(for: session, lanes: lanes)
    )
  }

  func goToLane(_ session: TerminalSessionSummary) {
    let laneId = resolvedWorkNavigationLaneId(for: session, lanes: lanes)
    Task { @MainActor in
      // Context-menu actions fire before iOS fully dismisses the menu. Publish
      // the cross-tab request after that dismissal so Lanes can present detail.
      try? await Task.sleep(for: .milliseconds(450))
      syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: laneId)
    }
  }

  func openPullRequest(_ session: TerminalSessionSummary, tag: LanePrTag) {
    let laneId = resolvedWorkNavigationLaneId(for: session, lanes: lanes)
    Task { @MainActor in
      // Same menu-dismissal wait as goToLane so the cross-tab request isn't
      // published while the context menu is still animating away.
      try? await Task.sleep(for: .milliseconds(450))
      if let prId = tag.prId, !prId.isEmpty {
        syncService.requestedPrNavigation = PrNavigationRequest(
          prId: prId,
          prNumber: tag.githubPrNumber,
          laneId: laneId.isEmpty ? nil : laneId
        )
      } else {
        syncService.requestedPrNavigation = PrNavigationRequest(prNumber: tag.githubPrNumber)
      }
    }
  }

  func openSession(_ session: TerminalSessionSummary) {
    // A pending-sync row has no synced session to open yet.
    guard !workIsPendingChatCreationSession(session) else { return }
    guard !navigationMutationPending else { return }
    navigationMutationPending = true
    selectedSessionTransitionId = session.id
    Task { @MainActor in
      await Task.yield()
      path.append(WorkSessionRoute(sessionId: session.id))
      navigationMutationPending = false
    }
  }

  @MainActor
  func handleRequestedWorkSessionNavigation() async {
    guard let request = syncService.requestedWorkSessionNavigation else { return }
    navigationMutationPending = false
    selectedSessionTransitionId = request.sessionId
    var fresh = NavigationPath()
    fresh.append(WorkSessionRoute(sessionId: request.sessionId))
    path = fresh
    syncService.requestedWorkSessionNavigation = nil
  }

  @MainActor
  func handleRequestedWorkLaneNavigation(proxy: ScrollViewProxy) async {
    guard let request = syncService.requestedWorkLaneNavigation else { return }
    let sectionId = "lane:\(request.laneId)"

    navigationMutationPending = false
    selectedSessionTransitionId = nil
    path = NavigationPath()
    searchText = ""
    selectedLaneId = "all"
    selectedStatus = .all
    sessionOrganizationRaw = WorkSessionOrganization.byLane.rawValue

    var collapsed = collapsedSectionIds
    if collapsed.remove(sectionId) != nil {
      collapsedSectionIdsStorage = workSerializeCollapsedSectionIds(collapsed)
    }

    if lanes.isEmpty || !lanes.contains(where: { $0.id == request.laneId }) {
      await reload(refreshRemote: isLive)
    }
    scheduleSessionPresentationRebuild()

    // Let the context menu dismiss, the tab switch complete, and the by-lane
    // presentation render before asking the List to reveal the lane header.
    try? await Task.sleep(for: .milliseconds(650))
    // `try? await Task.sleep` returns (not throws) on cancellation, so a cancelled
    // handler could still scroll and clear the request — bail out explicitly.
    guard !Task.isCancelled else { return }
    guard syncService.requestedWorkLaneNavigation?.id == request.id else { return }

    withAnimation(.snappy) {
      proxy.scrollTo(sectionId, anchor: .top)
    }
    syncService.requestedWorkLaneNavigation = nil
  }

  func deleteChatSession(_ session: TerminalSessionSummary) {
    // Deleting a pending-sync row cancels the queued creation locally.
    if workIsPendingChatCreationSession(session) {
      syncService.cancelPendingChatCreation(id: workPendingChatCreationCommandId(session))
      return
    }
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
  func stopRuntime(_ session: TerminalSessionSummary) async {
    defer { stopRuntimeTarget = nil }
    do {
      guard !isChatSession(session) else { return }
      try await syncService.stopWorkRuntime(sessionId: session.id)
      await reload(refreshRemote: true)
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
