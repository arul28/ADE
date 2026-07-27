import SwiftUI
import UIKit
import AVKit

private struct WorkPersistedProjectionLoad {
  let sessions: [TerminalSessionSummary]
  let lanes: [LaneSummary]
  let pullRequests: [PullRequestListItem]
}

extension WorkRootScreen {
  @MainActor
  func scheduleSessionPresentationRebuild() {
    sessionPresentationRebuildTask?.cancel()
    sessionPresentationRebuildGeneration += 1
    let generation = sessionPresentationRebuildGeneration
    let activeProjectId = syncService.activeProjectId
    let localProjectionIsCurrent = activeProjectId != nil
      && loadedProjectionProjectId == activeProjectId
    let localSessions = localProjectionIsCurrent ? sessions : []
    let localLanes = localProjectionIsCurrent ? lanes : []
    // The all-project roster usually learns about a newly-created chat before
    // the active project's CRDT replica does. Overlay only the active roster
    // here, at the detached presentation boundary: local hydrated rows win,
    // while missing roster rows make Work live immediately without adding a
    // second database or per-lane network fan-out.
    let activeRoster = syncService.activeProject.flatMap { syncService.rosterProject(for: $0) }
    let rosterProjection = overlayActiveProjectRoster(
      localSessions: localSessions,
      localLanes: localLanes,
      roster: activeRoster
    )
    let sessionsSnapshot = rosterProjection.sessions
    let chatSummariesSnapshot = localProjectionIsCurrent ? chatSummaries : [:]
    let deletingLaneIds = syncService.pendingLaneDeletionIds
    let lanesSnapshot = rosterProjection.lanes.filter { !deletingLaneIds.contains($0.id) }
    let pullRequestsSnapshot = localProjectionIsCurrent ? pullRequests : []
    let githubPrsSnapshot = localProjectionIsCurrent ? syncService.laneGithubPrItems : []
    // Fold offline "Pending sync" chat-creation rows into the optimistic set so
    // they render through the same machinery; committed rows win on id collision.
    let optimisticSessionsSnapshot = localProjectionIsCurrent
      ? optimisticSessions.merging(pendingChatCreationOptimisticSessions) { current, _ in current }
      : [:]
    let archivedSessionIdsSnapshot = resolvedWorkArchivedSessionIds(
      localStorage: archivedSessionIdsStorage,
      chatSummaries: chatSummariesSnapshot,
      sessions: sessionsSnapshot + Array(optimisticSessionsSnapshot.values)
    )
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
        githubPrs: githubPrsSnapshot,
        deletingLaneIds: deletingLaneIds
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
  func resetWorkProjectionForProjectChange(_ projectId: String?) {
    guard loadedProjectionProjectId != projectId
      || !sessions.isEmpty
      || !lanes.isEmpty
      || !chatSummaries.isEmpty
      || !pullRequests.isEmpty
    else { return }
    sessionPresentationRebuildTask?.cancel()
    sessionPresentationRebuildTask = nil
    sessionPresentationRebuildGeneration += 1
    loadedProjectionProjectId = nil
    sessions = []
    lanes = []
    chatSummaries = [:]
    pullRequests = []
    optimisticSessions = [:]
    sessionPresentation = .empty
    selectedSessionIds = []
    isSelecting = false
    selectedSessionTransitionId = nil
    path = NavigationPath()
    lastWorkProjectionReloadRevision = nil
    lastWorkLocalProjectionReload = .distantPast
    lastCoalescedChatSummaryRefresh = .distantPast
  }

  @MainActor
  func hydrateSearchOutputBuffersIfNeeded() async {
    guard isLive, isWorkRootActive else { return }
    guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    let candidates = mergedSessions
      .filter { session in
        syncService.terminalBuffers[session.id] == nil
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
    guard let requestedProjectId = syncService.activeProjectId else {
      resetWorkProjectionForProjectChange(nil)
      return
    }
    do {
      if refreshRemote {
        try? await syncService.refreshWorkSessions()
        guard requestedProjectId == syncService.activeProjectId else { return }
      }
      guard var projection = try await loadPersistedWorkProjection(for: requestedProjectId) else { return }
      if refreshRemote, projection.lanes.filter({ $0.archivedAt == nil }).isEmpty {
        try? await syncService.refreshLaneSnapshots()
        guard requestedProjectId == syncService.activeProjectId else { return }
        guard let refreshed = try await loadPersistedWorkProjection(for: requestedProjectId) else { return }
        projection = refreshed
      }
      guard installPersistedWorkProjection(projection, for: requestedProjectId) else { return }
      // Layer in GitHub PRs opened outside ADE (matched by branch). Best-effort,
      // non-blocking, internally throttled; pull-to-refresh forces a fresh fetch.
      Task { await syncService.refreshLaneGithubPrItems(force: refreshRemote) }
      if isLive {
        lastCoalescedChatSummaryRefresh = Date()
        await refreshChatSummaries(for: projection.lanes, projectId: requestedProjectId)
      }
      if errorMessage != nil {
        errorMessage = nil
      }
    } catch {
      guard requestedProjectId == syncService.activeProjectId else { return }
      let message = error.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    }
  }

  @MainActor
  private func loadPersistedWorkProjection(
    for projectId: String
  ) async throws -> WorkPersistedProjectionLoad? {
    async let sessionsTask = syncService.fetchSessions()
    async let lanesTask = syncService.fetchLanes()
    async let pullRequestsTask = syncService.fetchPullRequestListItems()
    let projection = try await WorkPersistedProjectionLoad(
      sessions: sessionsTask,
      lanes: lanesTask,
      pullRequests: pullRequestsTask
    )
    guard projectId == syncService.activeProjectId else { return nil }
    return projection
  }

  @MainActor
  private func installPersistedWorkProjection(
    _ projection: WorkPersistedProjectionLoad,
    for projectId: String
  ) -> Bool {
    guard projectId == syncService.activeProjectId else { return false }
    if loadedProjectionProjectId != projectId {
      chatSummaries = [:]
      optimisticSessions = [:]
    }
    loadedProjectionProjectId = projectId
    if sessions != projection.sessions {
      sessions = projection.sessions
    }
    let activeLanes = projection.lanes.filter { $0.archivedAt == nil }
    if lanes != activeLanes {
      lanes = activeLanes
    }
    if pullRequests != projection.pullRequests {
      pullRequests = projection.pullRequests
    }
    var nextOptimisticSessions = optimisticSessions
    for session in projection.sessions where nextOptimisticSessions[session.id] != nil {
      nextOptimisticSessions[session.id] = nil
    }
    if optimisticSessions != nextOptimisticSessions {
      optimisticSessions = nextOptimisticSessions
    }
    return true
  }

  /// Applies replicated SQLite rows to the Work list without fanning out per-lane host `listChatSessions` on every CRDT tick.
  @MainActor
  func reloadFromPersistedProjection() async {
    guard let requestedProjectId = syncService.activeProjectId else {
      resetWorkProjectionForProjectChange(nil)
      return
    }
    do {
      guard let projection = try await loadPersistedWorkProjection(for: requestedProjectId),
            installPersistedWorkProjection(projection, for: requestedProjectId)
      else { return }
      Task { await syncService.refreshLaneGithubPrItems() }
      if isLive {
        let now = Date()
        let minimumSummaryRefreshInterval = syncService.prefersReducedSyncLoad ? 8.0 : 2.6
        if now.timeIntervalSince(lastCoalescedChatSummaryRefresh) >= minimumSummaryRefreshInterval {
          lastCoalescedChatSummaryRefresh = now
          await refreshChatSummaries(for: projection.lanes, projectId: requestedProjectId)
        }
      }
      if errorMessage != nil {
        errorMessage = nil
      }
    } catch {
      guard requestedProjectId == syncService.activeProjectId else { return }
      let message = error.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    }
  }

  @MainActor
  func refreshChatSummaries(for lanes: [LaneSummary], projectId: String) async {
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
    guard projectId == syncService.activeProjectId,
          loadedProjectionProjectId == projectId
    else { return }

    // Keep the currently-open session(s) in the relevant set even when this
    // partial refresh (prefix(6) lanes, or a lane whose listChatSessions threw)
    // didn't return them. `subscribedChatSessionIds` reflects the open
    // WorkSessionDestinationView(s); without this the open chat's summary is
    // filtered out of `nextSummaries`, which reseeds a nil `initialChatSummary`
    // on the next navigation rebuild and blanks the composer controls.
    let relevantSessionIds = Set((sessions + Array(optimisticSessions.values)).map(\.id))
      .union(updated.keys)
      .union(syncService.subscribedChatSessionIds)
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

  // MARK: - Session lifecycle (ADE-125)
  //
  // Every one of these is a host command: the phone is a controller and never
  // runs agents, so it never owns a lifecycle column. `SyncService` writes the
  // column locally first (so the row doesn't flicker), rolls that back if the
  // host rejects, and `reload()` reconciles against the replicated truth.

  private func runSessionLifecycle(_ work: @escaping () async throws -> Void) {
    Task {
      do {
        try await work()
        await reload()
      } catch {
        ADEHaptics.error()
        let message = error.localizedDescription
        // Reconcile against replicated truth first — `SyncService` has already
        // rolled the optimistic column back — and only then surface the
        // failure. This must NOT go through `errorMessage`: every successful
        // projection load clears that (`reload()` here, and
        // `reloadFromPersistedProjection()` on the very next CRDT tick, which
        // the rollback write itself schedules), so a host rejection would
        // leave nothing but a haptic. `actionErrorMessage` is the surface
        // bulk actions already use for exactly this.
        await reload()
        actionErrorMessage = message
      }
    }
  }

  func settleSession(_ session: TerminalSessionSummary) {
    runSessionLifecycle { [syncService] in
      try await syncService.settleSession(sessionId: session.id)
    }
  }

  func unsettleSession(_ session: TerminalSessionSummary) {
    runSessionLifecycle { [syncService] in
      try await syncService.unsettleSession(sessionId: session.id)
    }
  }

  /// The explicit keep-active pin. Suppresses settle — derived (a clean exit)
  /// and declared alike — so a finished PTY keeps a real lifecycle action
  /// instead of being stuck in the quiet tier forever.
  func keepSessionActive(_ session: TerminalSessionSummary) {
    runSessionLifecycle { [syncService] in
      try await syncService.setSessionSettleOverride(sessionId: session.id, override: .active)
    }
  }

  func snoozeSession(_ session: TerminalSessionSummary, duration: WorkSnoozeDuration) {
    guard let deadline = duration.deadline() else { return }
    runSessionLifecycle { [syncService] in
      try await syncService.snoozeSession(sessionId: session.id, until: deadline)
    }
  }

  func wakeSession(_ session: TerminalSessionSummary) {
    runSessionLifecycle { [syncService] in
      try await syncService.wakeSession(sessionId: session.id, reason: .manual)
    }
  }

  /// The woke marker exists to explain why a snoozed row came back. Visiting
  /// the row is the explanation being read, so drop it then — quietly, since a
  /// failure here must never block navigation.
  func clearWokeMarkerOnVisit(_ session: TerminalSessionSummary) {
    // Only a PERSISTED marker needs clearing. A purely derived one (the snooze
    // simply lapsed, so the host never wrote a marker) has nothing to clear.
    let wokeAt = session.wokeAt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !wokeAt.isEmpty else { return }
    Task { [syncService] in
      try? await syncService.clearSessionWokeMarker(sessionId: session.id)
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
    let laneId = resolvedWorkNavigationLaneId(for: session, lanes: lanes)
    let lane = lanes.first(where: { $0.id == laneId })
    let pullRequest = pullRequests.first(where: { $0.laneId == laneId })
    UIPasteboard.general.string = workSessionDeepLink(
      sessionId: session.id,
      laneId: laneId,
      envelope: LaneDeeplinkHelpers.envelope(lane: lane, pullRequest: pullRequest)
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

  /// Header-tag variant of `openPullRequest` — navigates straight to a lane
  /// section's primary PR in the PRs tab (no owning session row). Reuses the
  /// same `requestedPrNavigation` cross-tab handoff.
  func openLanePullRequest(tag: LanePrTag, laneId: String?) {
    let trimmedLaneId = laneId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    Task { @MainActor in
      if let prId = tag.prId, !prId.isEmpty {
        syncService.requestedPrNavigation = PrNavigationRequest(
          prId: prId,
          prNumber: tag.githubPrNumber,
          laneId: trimmedLaneId.isEmpty ? nil : trimmedLaneId
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
    clearWokeMarkerOnVisit(session)
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
    // Scoped links are machine-wide identities, not requests against whichever
    // project happens to own this mounted Work view. Leave the request intact
    // and hand it to Hub's roster resolver, including on a cold app launch
    // where ContentView's onChange may not observe the initial value.
    if syncService.navigationDestination(request) == .hub {
      syncService.showProjectHub()
      return
    }
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
