import SwiftUI
import UIKit
import AVKit

private let workDateFormatter = ISO8601DateFormatter()

private struct WorkSessionRoute: Hashable {
  let sessionId: String
  var openingPrompt: String? = nil
}

private struct WorkDraftChatSession {
  let summary: AgentChatSessionSummary
  let initialMessage: String?
}

struct WorkTabView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService
  @Namespace private var sessionTransitionNamespace

  @State private var sessions: [TerminalSessionSummary] = []
  @State private var chatSummaries: [String: AgentChatSessionSummary] = [:]
  @State private var lanes: [LaneSummary] = []
  @State private var transcriptCache: [String: [WorkChatEnvelope]] = [:]
  @State private var errorMessage: String?
  @State private var path = NavigationPath()
  @State private var searchText = ""
  @State private var selectedLaneId = "all"
  @State private var selectedStatus: WorkSessionStatusFilter = .all
  @State private var newChatPresented = false
  @State private var renameTarget: TerminalSessionSummary?
  @State private var renameText = ""
  @State private var endTarget: TerminalSessionSummary?
  @State private var optimisticSessions: [String: TerminalSessionSummary] = [:]
  @State private var refreshFeedbackToken = 0
  @State private var selectedSessionTransitionId: String?
  /// Coalesces expensive per-lane `listChatSessions` refreshes when `localStateRevision` bumps during CRDT sync.
  @State private var lastCoalescedChatSummaryRefresh = Date.distantPast
  @AppStorage("ade.work.archivedSessionIds") private var archivedSessionIdsStorage = ""

  private var workStatus: SyncDomainStatus {
    syncService.status(for: .work)
  }

  private var isLive: Bool {
    workStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !mergedSessions.isEmpty
  }

  private var isLoadingSkeleton: Bool {
    workStatus.phase == .hydrating || workStatus.phase == .syncingInitialData
  }

  private var archivedSessionIds: Set<String> {
    Set(archivedSessionIdsStorage.split(separator: "\n").map(String.init))
  }

  private var laneById: [String: LaneSummary] {
    Dictionary(uniqueKeysWithValues: lanes.map { ($0.id, $0) })
  }

  private var mergedSessions: [TerminalSessionSummary] {
    let draftValues = optimisticSessions.values.filter { draft in
      !sessions.contains(where: { $0.id == draft.id })
    }
    return (sessions + draftValues)
      .sorted { compareWorkSessionSortOrder($0, $1, chatSummaries: chatSummaries) }
  }

  private var displaySessions: [TerminalSessionSummary] {
    workFilteredSessions(
      mergedSessions,
      chatSummaries: chatSummaries,
      archivedSessionIds: archivedSessionIds,
      selectedStatus: selectedStatus,
      selectedLaneId: selectedLaneId,
      searchText: searchText
    )
  }

  private var needsInputSessions: [TerminalSessionSummary] {
    displaySessions.filter {
      !archivedSessionIds.contains($0.id)
      && normalizedWorkChatSessionStatus(session: $0, summary: chatSummaries[$0.id]) == "awaiting-input"
    }
  }

  private var pinnedSessions: [TerminalSessionSummary] {
    displaySessions.filter {
      $0.pinned
      && !archivedSessionIds.contains($0.id)
      && normalizedWorkChatSessionStatus(session: $0, summary: chatSummaries[$0.id]) != "awaiting-input"
    }
  }

  private var liveSessions: [TerminalSessionSummary] {
    displaySessions.filter { session in
      !session.pinned
      && !archivedSessionIds.contains(session.id)
      && {
        let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
        return status == "active" || status == "idle"
      }()
    }
  }

  private var endedSessions: [TerminalSessionSummary] {
    displaySessions.filter {
      !$0.pinned
      && !archivedSessionIds.contains($0.id)
      && normalizedWorkChatSessionStatus(session: $0, summary: chatSummaries[$0.id]) == "ended"
    }
  }

  private var archivedSessions: [TerminalSessionSummary] {
    displaySessions.filter { archivedSessionIds.contains($0.id) }
  }

  private var liveChatSessions: [TerminalSessionSummary] {
    mergedSessions.filter { session in
      let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
      return isChatSession(session) && status != "ended" && !archivedSessionIds.contains(session.id)
    }
  }

  private var hasActiveFilters: Bool {
    selectedStatus != .all || selectedLaneId != "all"
  }

  private var activityFeed: [WorkAgentActivity] {
    liveChatSessions.flatMap { session in
      let transcript = transcriptCache[session.id] ?? parseWorkChatTranscript(syncService.terminalBuffers[session.id] ?? "")
      return deriveWorkAgentActivities(
        from: transcript,
        session: WorkAgentActivityContext(
          sessionId: session.id,
          title: session.title,
          laneName: session.laneName,
          status: normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id]),
          startedAt: session.startedAt
        )
      )
    }
    .sorted { lhs, rhs in
      if lhs.startedAt == rhs.startedAt {
        return lhs.agentName < rhs.agentName
      }
      return lhs.startedAt > rhs.startedAt
    }
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let statusNotice {
          statusNotice
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }

        if isLoadingSkeleton {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          }
        } else {
          WorkFiltersSection(
            searchText: $searchText,
            selectedLaneId: $selectedLaneId,
            selectedStatus: $selectedStatus,
            lanes: lanes,
            runningCount: liveSessions.count,
            needsInputCount: needsInputSessions.count
          )
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)

          if !liveSessions.isEmpty || !needsInputSessions.isEmpty {
            WorkRunningBanner(activeCount: liveSessions.count, attentionCount: needsInputSessions.count)
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          }

          if !activityFeed.isEmpty {
            Section("Activity") {
              ForEach(activityFeed) { activity in
                WorkActivityRow(activity: activity)
                  .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                  .listRowBackground(Color.clear)
                  .listRowSeparator(.hidden)
              }
            }
          }

          if let errorMessage, workStatus.phase == .ready {
            ADENoticeCard(
              title: "Work view error",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          }

          if displaySessions.isEmpty {
            ADEEmptyStateView(
              symbol: isLive ? "bubble.left.and.bubble.right" : "terminal",
              title: workSessionEmptyStateTitle(status: selectedStatus, searchText: searchText, hasFilters: hasActiveFilters),
              message: workSessionEmptyStateMessage(
                status: selectedStatus,
                searchText: searchText,
                hasFilters: hasActiveFilters,
                isLive: isLive
              )
            ) {
              Button("New chat") {
                newChatPresented = true
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
              .disabled(!isLive)
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          } else {
            if !needsInputSessions.isEmpty {
              WorkSessionSection(
                title: "Needs input",
                sessions: needsInputSessions,
                laneById: laneById,
                chatSummaries: chatSummaries,
                archivedSessionIds: archivedSessionIds,
                transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? sessionTransitionNamespace : nil,
                selectedSessionId: $selectedSessionTransitionId,
                path: $path,
                onArchive: toggleArchive,
                onPin: togglePin,
                onRename: beginRename,
                onEnd: { session in endTarget = session },
                onResume: resumeSession,
                onCopyId: copySessionId,
                onGoToLane: goToLane
              )
            }

            if !pinnedSessions.isEmpty {
              WorkSessionSection(
                title: "Pinned",
                sessions: pinnedSessions,
                laneById: laneById,
                chatSummaries: chatSummaries,
                archivedSessionIds: archivedSessionIds,
                transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? sessionTransitionNamespace : nil,
                selectedSessionId: $selectedSessionTransitionId,
                path: $path,
                onArchive: toggleArchive,
                onPin: togglePin,
                onRename: beginRename,
                onEnd: { session in endTarget = session },
                onResume: resumeSession,
                onCopyId: copySessionId,
                onGoToLane: goToLane
              )
            }

            if !liveSessions.isEmpty {
              WorkSessionSection(
                title: selectedStatus == .running ? "Live" : "Running",
                sessions: liveSessions,
                laneById: laneById,
                chatSummaries: chatSummaries,
                archivedSessionIds: archivedSessionIds,
                transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? sessionTransitionNamespace : nil,
                selectedSessionId: $selectedSessionTransitionId,
                path: $path,
                onArchive: toggleArchive,
                onPin: togglePin,
                onRename: beginRename,
                onEnd: { session in endTarget = session },
                onResume: resumeSession,
                onCopyId: copySessionId,
                onGoToLane: goToLane
              )
            }

            if !endedSessions.isEmpty {
              WorkSessionSection(
                title: selectedStatus == .ended ? "Ended" : "Recent",
                sessions: endedSessions,
                laneById: laneById,
                chatSummaries: chatSummaries,
                archivedSessionIds: archivedSessionIds,
                transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? sessionTransitionNamespace : nil,
                selectedSessionId: $selectedSessionTransitionId,
                path: $path,
                onArchive: toggleArchive,
                onPin: togglePin,
                onRename: beginRename,
                onEnd: { session in endTarget = session },
                onResume: resumeSession,
                onCopyId: copySessionId,
                onGoToLane: goToLane
              )
            }

            if !archivedSessions.isEmpty && selectedStatus != .running && selectedStatus != .ended {
              WorkSessionSection(
                title: "Archived",
                sessions: archivedSessions,
                laneById: laneById,
                chatSummaries: chatSummaries,
                archivedSessionIds: archivedSessionIds,
                transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? sessionTransitionNamespace : nil,
                selectedSessionId: $selectedSessionTransitionId,
                path: $path,
                onArchive: toggleArchive,
                onPin: togglePin,
                onRename: beginRename,
                onEnd: { session in endTarget = session },
                onResume: resumeSession,
                onCopyId: copySessionId,
                onGoToLane: goToLane
              )
            }
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Work")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          ADEConnectionPill()
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            newChatPresented = true
          } label: {
            Image(systemName: "plus.bubble.fill")
          }
          .accessibilityLabel("Create new chat")
          .disabled(!isLive)
        }
      }
      .refreshable {
        await refreshFromPullGesture()
      }
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task {
        await reload()
      }
      .task(id: syncService.localStateRevision) {
        await reloadFromPersistedProjection()
      }
      .task(id: pollingKey) {
        await pollRunningChats()
      }
      .navigationDestination(for: WorkSessionRoute.self) { route in
        WorkSessionDestinationView(
          sessionId: route.sessionId,
          initialOpeningPrompt: route.openingPrompt,
          initialSession: mergedSessions.first(where: { $0.id == route.sessionId }),
          initialChatSummary: chatSummaries[route.sessionId],
          initialTranscript: transcriptCache[route.sessionId],
          transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? sessionTransitionNamespace : nil,
          isLive: isLive,
          disconnectedNotice: !isLive
        )
        .environmentObject(syncService)
      }
      .sheet(isPresented: $newChatPresented) {
        WorkNewChatSheet(
          lanes: lanes,
          initialLaneId: selectedLaneId == "all" ? lanes.first?.id : selectedLaneId,
          onRefreshLanes: { await reload(refreshRemote: true) }
        ) { draft in
          let sessionId = draft.summary.sessionId
          let openingMessage = draft.initialMessage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
          optimisticSessions[sessionId] = makeOptimisticSession(for: draft.summary)
          chatSummaries[sessionId] = draft.summary
          selectedStatus = .all
          selectedLaneId = draft.summary.laneId
          selectedSessionTransitionId = sessionId
          path.append(WorkSessionRoute(sessionId: sessionId, openingPrompt: openingMessage))
          Task { @MainActor in
            await reload(refreshRemote: true)
          }
        }
        .environmentObject(syncService)
      }
      .alert("Rename session", isPresented: renamePresentedBinding) {
        TextField("Title", text: $renameText)
        Button("Cancel", role: .cancel) {
          renameTarget = nil
        }
        Button("Save") {
          Task { await submitRename() }
        }
      } message: {
        Text("Give this session a clearer title for search, pinning, and activity tracking.")
      }
      .alert("End session?", isPresented: endPresentedBinding, presenting: endTarget) { session in
        Button("Cancel", role: .cancel) {
          endTarget = nil
        }
        Button(isChatSession(session) ? "End chat" : "Close", role: .destructive) {
          Task { await endSession(session) }
        }
      } message: { session in
        Text(isChatSession(session)
          ? "ADE will ask the host to stop this chat and keep the transcript available for review."
          : "ADE will stop streaming new terminal output for this session.")
      }
    }
  }

  private var renamePresentedBinding: Binding<Bool> {
    Binding(
      get: { renameTarget != nil },
      set: { presented in
        if !presented {
          renameTarget = nil
          renameText = ""
        }
      }
    )
  }

  private var endPresentedBinding: Binding<Bool> {
    Binding(
      get: { endTarget != nil },
      set: { presented in
        if !presented {
          endTarget = nil
        }
      }
    )
  }

  private var pollingKey: String {
    let ids = liveChatSessions.map(\.id).sorted().joined(separator: ",")
    // Intentionally omit `localStateRevision`: it changes constantly during host DB sync and was
    // restarting this poll loop while the list `.task(id:)` also reloaded sessions every tick.
    return "\(isLive)-\(ids)"
  }

  @MainActor
  private func refreshFromPullGesture() async {
    await reload(refreshRemote: true)
    if errorMessage == nil {
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
        refreshFeedbackToken += 1
      }
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
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
  private func reloadFromPersistedProjection() async {
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
  private func refreshChatSummaries(for lanes: [LaneSummary]) async {
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
  private func pollRunningChats() async {
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

  private func toggleArchive(_ session: TerminalSessionSummary) {
    var archived = archivedSessionIds
    if archived.contains(session.id) {
      archived.remove(session.id)
    } else {
      archived.insert(session.id)
    }
    archivedSessionIdsStorage = archived.sorted().joined(separator: "\n")
  }

  private func togglePin(_ session: TerminalSessionSummary) {
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

  private func beginRename(_ session: TerminalSessionSummary) {
    renameTarget = session
    renameText = session.title
  }

  @MainActor
  private func submitRename() async {
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

  private func copySessionId(_ session: TerminalSessionSummary) {
    UIPasteboard.general.string = session.id
  }

  private func goToLane(_ session: TerminalSessionSummary) {
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: session.laneId)
  }

  private func resumeSession(_ session: TerminalSessionSummary) {
    if archivedSessionIds.contains(session.id) {
      toggleArchive(session)
    }
    selectedSessionTransitionId = session.id
    path.append(WorkSessionRoute(sessionId: session.id))
  }

  @MainActor
  private func endSession(_ session: TerminalSessionSummary) async {
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

  private func makeOptimisticSession(for summary: AgentChatSessionSummary) -> TerminalSessionSummary {
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

  private var statusNotice: ADENoticeCard? {
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

private struct WorkFiltersSection: View {
  @Binding var searchText: String
  @Binding var selectedLaneId: String
  @Binding var selectedStatus: WorkSessionStatusFilter
  let lanes: [LaneSummary]
  let runningCount: Int
  let needsInputCount: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(ADEColor.textSecondary)
        TextField("Search sessions", text: $searchText)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }
      .adeInsetField(cornerRadius: 14, padding: 12)

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(WorkSessionStatusFilter.allCases) { status in
            Button {
              selectedStatus = status
            } label: {
              HStack(spacing: 6) {
                Text(status.title)
                if status == .running && runningCount > 0 {
                  Text("\(runningCount)")
                    .font(.caption2.weight(.semibold))
                } else if status == .needsInput && needsInputCount > 0 {
                  Text("\(needsInputCount)")
                    .font(.caption2.weight(.semibold))
                }
              }
              .font(.caption.weight(.semibold))
              .foregroundStyle(selectedStatus == status ? ADEColor.accent : ADEColor.textSecondary)
              .padding(.horizontal, 12)
              .padding(.vertical, 8)
              .background(
                Capsule(style: .continuous)
                  .fill(selectedStatus == status ? ADEColor.accent.opacity(0.12) : ADEColor.surfaceBackground.opacity(0.6))
              )
            }
            .buttonStyle(.plain)
          }
        }
      }

      Picker("Lane", selection: $selectedLaneId) {
        Text("All lanes").tag("all")
        ForEach(lanes) { lane in
          Text(lane.name).tag(lane.id)
        }
      }
      .pickerStyle(.menu)
      .adeInsetField(cornerRadius: 14, padding: 10)

      HStack(spacing: 8) {
        LaneMicroChip(icon: "waveform.path.ecg", text: "\(runningCount) live", tint: ADEColor.success)
        if needsInputCount > 0 {
          LaneMicroChip(icon: "exclamationmark.bubble.fill", text: "\(needsInputCount) waiting", tint: ADEColor.warning)
        }
        Spacer(minLength: 0)
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }
}

private struct WorkRunningBanner: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  let activeCount: Int
  let attentionCount: Int

  @State private var isPulsing = false

  var body: some View {
    HStack(spacing: 10) {
      Circle()
        .fill(attentionCount > 0 ? ADEColor.warning : ADEColor.success)
        .frame(width: 10, height: 10)
        .scaleEffect(isPulsing && !reduceMotion ? 1.2 : 1.0)
        .animation(ADEMotion.pulse(reduceMotion: reduceMotion), value: isPulsing)
        .onAppear {
          guard !reduceMotion else { return }
          isPulsing = true
        }
      VStack(alignment: .leading, spacing: 2) {
        Text(bannerTitle)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(bannerMessage)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer()
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }

  private var bannerTitle: String {
    if attentionCount > 0 && activeCount > 0 {
      return "\(attentionCount) chat\(attentionCount == 1 ? "" : "s") need input, \(activeCount) still live"
    }
    if attentionCount > 0 {
      return attentionCount == 1 ? "1 chat needs input" : "\(attentionCount) chats need input"
    }
    return activeCount == 1 ? "1 chat is live" : "\(activeCount) chats are live"
  }

  private var bannerMessage: String {
    if attentionCount > 0 {
      return "Open the waiting chat to approve, answer, or resume work without leaving the phone."
    }
    return "The Work tab badge stays visible until every active chat turn finishes."
  }
}

private struct WorkSessionSection: View {
  let title: String
  let sessions: [TerminalSessionSummary]
  let laneById: [String: LaneSummary]
  let chatSummaries: [String: AgentChatSessionSummary]
  let archivedSessionIds: Set<String>
  let transitionNamespace: Namespace.ID?
  @Binding var selectedSessionId: String?
  @Binding var path: NavigationPath
  let onArchive: (TerminalSessionSummary) -> Void
  let onPin: (TerminalSessionSummary) -> Void
  let onRename: (TerminalSessionSummary) -> Void
  let onEnd: (TerminalSessionSummary) -> Void
  let onResume: (TerminalSessionSummary) -> Void
  let onCopyId: (TerminalSessionSummary) -> Void
  let onGoToLane: (TerminalSessionSummary) -> Void

  var body: some View {
    Section(title) {
      ForEach(sessions) { session in
        Button {
          selectedSessionId = session.id
          path.append(WorkSessionRoute(sessionId: session.id))
        } label: {
          WorkSessionRow(
            session: session,
            lane: laneById[session.laneId],
            chatSummary: chatSummaries[session.id],
            isArchived: archivedSessionIds.contains(session.id),
            transitionNamespace: transitionNamespace,
            isSelectedTransitionSource: selectedSessionId == session.id
          )
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          Button(archivedSessionIds.contains(session.id) ? "Restore" : "Archive") {
            onArchive(session)
          }
          .tint(ADEColor.warning)

          Button(session.pinned ? "Unpin" : "Pin") {
            onPin(session)
          }
          .tint(ADEColor.accent)
        }
        .contextMenu {
          Button("Rename") {
            onRename(session)
          }
          Button(session.pinned ? "Unpin" : "Pin") {
            onPin(session)
          }
          Button(archivedSessionIds.contains(session.id) ? "Restore from archive" : "Archive") {
            onArchive(session)
          }
          if shouldShowEndAction(for: session) {
            Button(isChatSession(session) ? "End chat" : "Close session", role: .destructive) {
              onEnd(session)
            }
          } else if shouldShowResumeAction(for: session) {
            Button("Resume") {
              onResume(session)
            }
          }
          Button("Copy session ID") {
            onCopyId(session)
          }
          Button("Go to lane") {
            onGoToLane(session)
          }
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }
    }
  }

  private func sessionStatus(for session: TerminalSessionSummary) -> String {
    normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
  }

  private func shouldShowEndAction(for session: TerminalSessionSummary) -> Bool {
    let status = sessionStatus(for: session)
    return status == "active" || status == "awaiting-input"
  }

  private func shouldShowResumeAction(for session: TerminalSessionSummary) -> Bool {
    let status = sessionStatus(for: session)
    return status == "idle" || status == "ended"
  }
}

private struct WorkSessionRow: View {
  let session: TerminalSessionSummary
  let lane: LaneSummary?
  let chatSummary: AgentChatSessionSummary?
  let isArchived: Bool
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: sessionSymbol(session, provider: chatSummary?.provider))
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(rowTint)
        .frame(width: 28, height: 28)
        .background(rowTint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-icon-\(session.id)" : nil, in: transitionNamespace)

      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              Text(chatSummary?.title ?? session.title)
                .font(.headline)
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
                .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-title-\(session.id)" : nil, in: transitionNamespace)
              if session.pinned {
                Image(systemName: "pin.fill")
                  .font(.caption2)
                  .foregroundStyle(ADEColor.accent)
              }
            }

            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 8) {
                WorkTag(text: session.laneName, icon: "arrow.triangle.branch", tint: ADEColor.textSecondary)
                if lane?.status.dirty == true {
                  WorkTag(text: "Dirty", icon: "circle.fill", tint: ADEColor.warning)
                }
                if let devices = lane?.devicesOpen, !devices.isEmpty {
                  WorkTag(
                    text: devices.count == 1 ? "1 device" : "\(devices.count) devices",
                    icon: devicePresenceSymbol(for: devices),
                    tint: ADEColor.accent
                  )
                }
                if let chatSummary {
                  WorkTag(text: providerLabel(chatSummary.provider), icon: providerIcon(chatSummary.provider), tint: rowTint)
                  WorkTag(text: chatSummary.model, icon: "cpu", tint: ADEColor.textSecondary)
                } else if session.toolType != nil {
                  WorkTag(text: workSessionRuntimeLabel(session: session), icon: isChatSession(session) ? "bubble.left.and.bubble.right.fill" : "terminal.fill", tint: ADEColor.textSecondary)
                }
              }
            }
          }

          Spacer(minLength: 8)

          VStack(alignment: .trailing, spacing: 6) {
            ADEStatusPill(
              text: isArchived ? "ARCHIVED" : sessionStatusLabel(session, summary: chatSummary),
              tint: isArchived ? ADEColor.warning : rowTint
            )
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-status-\(session.id)" : nil, in: transitionNamespace)
            Text(relativeTimestamp(workSessionActivityTimestamp(session: session, summary: chatSummary)))
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
            Text(formattedSessionDuration(startedAt: session.startedAt, endedAt: session.endedAt))
              .font(.caption2.monospacedDigit())
              .foregroundStyle(ADEColor.textMuted)
          }
        }

        if let preview = chatSummary?.summary ?? chatSummary?.lastOutputPreview ?? session.summary ?? session.lastOutputPreview,
           !preview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          Text(preview)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }
    }
    .adeListCard()
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "work-container-\(session.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private var rowTint: Color {
    if isArchived { return ADEColor.warning }
    return workChatStatusTint(normalizedWorkChatSessionStatus(session: session, summary: chatSummary))
  }

  private var accessibilityLabel: String {
    var parts = [chatSummary?.title ?? session.title, session.laneName, sessionStatusLabel(session, summary: chatSummary)]
    if session.pinned {
      parts.append("pinned")
    }
    if isArchived {
      parts.append("archived")
    }
    return parts.joined(separator: ", ")
  }
}

private struct WorkActivityRow: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  let activity: WorkAgentActivity
  @State private var pulse = false

  var body: some View {
    HStack(spacing: 12) {
      Circle()
        .fill(ADEColor.success)
        .frame(width: 10, height: 10)
        .scaleEffect(pulse && !reduceMotion ? 1.25 : 1.0)
        .animation(ADEMotion.pulse(reduceMotion: reduceMotion), value: pulse)
        .onAppear {
          guard !reduceMotion else { return }
          pulse = true
        }
      VStack(alignment: .leading, spacing: 4) {
        Text(activity.agentName)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("\(activity.laneName) · \(activity.toolName ?? "Waiting")")
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
        if let detail = activity.detail, !detail.isEmpty {
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      Spacer()
      Text(formattedSessionDuration(startedAt: activity.startedAt, endedAt: nil))
        .font(.caption2.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeListCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(activity.agentName), \(activity.laneName), \(activity.toolName ?? "Waiting")")
  }
}

private struct WorkTag: View {
  let text: String
  let icon: String
  let tint: Color

  var body: some View {
    Label(text, systemImage: icon)
      .font(.caption2.weight(.medium))
      .foregroundStyle(tint)
      .lineLimit(1)
      .fixedSize(horizontal: true, vertical: false)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(tint.opacity(0.10), in: Capsule(style: .continuous))
  }
}

private struct WorkNewChatSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let lanes: [LaneSummary]
  let initialLaneId: String?
  let onRefreshLanes: @MainActor () async -> Void
  let onCreated: @MainActor (WorkDraftChatSession) async -> Void

  @State private var provider = "claude"
  @State private var models: [AgentChatModelInfo] = []
  @State private var selectedModelId = ""
  @State private var selectedReasoningEffort = ""
  @State private var selectedLaneId = ""
  @State private var initialMessage = ""
  @State private var busy = false
  @State private var errorMessage: String?

  private let providerColumns = [
    GridItem(.flexible(), spacing: 12),
    GridItem(.flexible(), spacing: 12),
  ]

  private var selectedModel: AgentChatModelInfo? {
    models.first(where: { $0.id == selectedModelId })
  }

  private var trimmedInitialMessage: String {
    initialMessage.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var canStartChat: Bool {
    !busy && !selectedLaneId.isEmpty && !selectedModelId.isEmpty && !trimmedInitialMessage.isEmpty
  }

  private var startDisabledReason: String? {
    if busy { return nil }
    if selectedLaneId.isEmpty { return "Choose a lane." }
    if selectedModelId.isEmpty { return "Choose a model." }
    if trimmedInitialMessage.isEmpty { return "Enter an opening prompt." }
    return nil
  }

  private var providerOptions: [WorkProviderOption] {
    [
      WorkProviderOption(
        id: "claude",
        title: "Claude",
        subtitle: "Long-form reasoning and review",
        icon: providerIcon("claude"),
        tint: providerTint("claude")
      ),
      WorkProviderOption(
        id: "codex",
        title: "Codex",
        subtitle: "Fast code execution and edits",
        icon: providerIcon("codex"),
        tint: providerTint("codex")
      ),
      WorkProviderOption(
        id: "opencode",
        title: "OpenCode",
        subtitle: "Open runtime workflows and tools",
        icon: providerIcon("opencode"),
        tint: providerTint("opencode")
      ),
      WorkProviderOption(
        id: "cursor",
        title: "Cursor",
        subtitle: "Cursor-native chat sessions",
        icon: providerIcon("cursor"),
        tint: providerTint("cursor")
      ),
    ]
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Provider") {
            LazyVGrid(columns: providerColumns, spacing: 12) {
              ForEach(providerOptions) { option in
                Button {
                  provider = option.id
                } label: {
                  VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                      Image(systemName: option.icon)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(option.tint)
                        .frame(width: 34, height: 34)
                        .background(option.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                      Spacer(minLength: 0)
                      if provider == option.id {
                        Image(systemName: "checkmark.circle.fill")
                          .foregroundStyle(ADEColor.accent)
                      }
                    }
                    Text(option.title)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEColor.textPrimary)
                    Text(option.subtitle)
                      .font(.caption)
                      .foregroundStyle(ADEColor.textSecondary)
                      .lineLimit(2)
                  }
                  .frame(maxWidth: .infinity, minHeight: 118, alignment: .leading)
                  .padding(12)
                  .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                      .fill(provider == option.id ? option.tint.opacity(0.14) : ADEColor.surfaceBackground.opacity(0.55))
                  )
                  .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                      .stroke(provider == option.id ? option.tint.opacity(0.45) : ADEColor.border.opacity(0.18), lineWidth: provider == option.id ? 1.3 : 0.8)
                  )
                  .glassEffect(in: .rect(cornerRadius: 16))
                }
                .buttonStyle(.plain)
              }
            }
          }

          GlassSection(title: "Model") {
            VStack(alignment: .leading, spacing: 12) {
              if models.isEmpty && errorMessage == nil {
                HStack(spacing: 10) {
                  ProgressView()
                    .tint(ADEColor.accent)
                  Text("Loading \(providerLabel(provider)) models…")
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              } else if models.isEmpty {
                Text(errorMessage ?? "No models are currently available for \(providerLabel(provider)).")
                  .font(.caption)
                  .foregroundStyle(errorMessage == nil ? ADEColor.textSecondary : ADEColor.danger)
              } else {
                ForEach(models) { model in
                  Button {
                    selectedModelId = model.id
                  } label: {
                    VStack(alignment: .leading, spacing: 8) {
                      HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                          Text(model.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ADEColor.textPrimary)
                          if let description = model.description, !description.isEmpty {
                            Text(description)
                              .font(.caption)
                              .foregroundStyle(ADEColor.textSecondary)
                              .lineLimit(2)
                          }
                        }
                        Spacer(minLength: 8)
                        if selectedModelId == model.id {
                          Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(ADEColor.accent)
                        }
                      }

                      HStack(spacing: 6) {
                        if let family = model.family, !family.isEmpty {
                          LaneMicroChip(icon: "circle.grid.2x2.fill", text: family, tint: ADEColor.textSecondary)
                        }
                        if model.supportsReasoning == true {
                          LaneMicroChip(icon: "brain", text: "Reasoning", tint: ADEColor.accent)
                        }
                        if model.supportsTools == true {
                          LaneMicroChip(icon: "hammer.fill", text: "Tools", tint: ADEColor.success)
                        }
                        if model.isDefault {
                          LaneMicroChip(icon: "star.fill", text: "Default", tint: ADEColor.warning)
                        }
                        Spacer(minLength: 0)
                      }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(selectedModelId == model.id ? providerTint(provider).opacity(0.14) : ADEColor.surfaceBackground.opacity(0.55))
                    )
                    .overlay(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(selectedModelId == model.id ? providerTint(provider).opacity(0.42) : ADEColor.border.opacity(0.18), lineWidth: selectedModelId == model.id ? 1.3 : 0.8)
                    )
                    .glassEffect(in: .rect(cornerRadius: 16))
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          }

          if let reasoningEfforts = selectedModel?.reasoningEfforts, !reasoningEfforts.isEmpty {
            GlassSection(title: "Reasoning") {
              VStack(alignment: .leading, spacing: 12) {
                Picker("Reasoning", selection: $selectedReasoningEffort) {
                  Text("Default").tag("")
                  ForEach(reasoningEfforts) { effort in
                    Text(effort.effort.capitalized).tag(effort.effort)
                  }
                }
                .pickerStyle(.segmented)

                if let effort = reasoningEfforts.first(where: { $0.effort == selectedReasoningEffort }) {
                  Text(effort.description)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }

          GlassSection(title: "Lane") {
            if lanes.isEmpty {
              VStack(spacing: 14) {
                ADEEmptyStateView(
                  symbol: "arrow.triangle.branch",
                  title: "No lanes on this phone yet",
                  message: "Lanes are created on the ADE host. After the host syncs lane metadata, pull to refresh on Work or tap below."
                )
                Button {
                  Task { await onRefreshLanes() }
                } label: {
                  Label("Refresh lanes from host", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
                .buttonStyle(.glassProminent)
                .tint(ADEColor.accent)
              }
            } else {
              VStack(spacing: 12) {
                ForEach(lanes) { lane in
                  Button {
                    selectedLaneId = lane.id
                  } label: {
                    VStack(alignment: .leading, spacing: 8) {
                      HStack(spacing: 12) {
                        Circle()
                          .fill(lane.status.dirty ? ADEColor.warning : ADEColor.success)
                          .frame(width: 10, height: 10)
                        VStack(alignment: .leading, spacing: 4) {
                          Text(lane.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ADEColor.textPrimary)
                          Text(lane.branchRef)
                            .font(.caption.monospaced())
                            .foregroundStyle(ADEColor.textSecondary)
                            .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if let devices = lane.devicesOpen, !devices.isEmpty {
                          Image(systemName: devicePresenceSymbol(for: devices))
                            .foregroundStyle(ADEColor.accent)
                        }
                        if selectedLaneId == lane.id {
                          Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(ADEColor.accent)
                        }
                      }

                      HStack(spacing: 6) {
                        if lane.status.dirty {
                          LaneMicroChip(icon: "circle.fill", text: "dirty", tint: ADEColor.warning)
                        }
                        if lane.status.ahead > 0 {
                          LaneMicroChip(icon: "arrow.up", text: "\(lane.status.ahead)", tint: ADEColor.success)
                        }
                        if lane.status.behind > 0 {
                          LaneMicroChip(icon: "arrow.down", text: "\(lane.status.behind)", tint: ADEColor.warning)
                        }
                        if let devices = lane.devicesOpen, !devices.isEmpty {
                          LaneMicroChip(icon: devicePresenceSymbol(for: devices), text: "\(devices.count)", tint: ADEColor.accent)
                        }
                        Spacer(minLength: 0)
                      }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(selectedLaneId == lane.id ? ADEColor.accent.opacity(0.12) : ADEColor.surfaceBackground.opacity(0.55))
                    )
                    .overlay(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(selectedLaneId == lane.id ? ADEColor.accent.opacity(0.4) : ADEColor.border.opacity(0.18), lineWidth: selectedLaneId == lane.id ? 1.3 : 0.8)
                    )
                    .glassEffect(in: .rect(cornerRadius: 16))
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          }

          GlassSection(title: "Opening prompt") {
            VStack(alignment: .leading, spacing: 8) {
              TextField("Tell the agent what to do", text: $initialMessage, axis: .vertical)
                .textInputAutocapitalization(.sentences)
                .autocorrectionDisabled()
                .adeInsetField(cornerRadius: 14, padding: 12)
                .disabled(busy)

              if let startDisabledReason {
                Label(startDisabledReason, systemImage: "info.circle")
                  .font(.caption2)
                  .foregroundStyle(ADEColor.textMuted)
              }
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }

          if busy {
            HStack(spacing: 10) {
              ProgressView()
                .tint(ADEColor.accent)
              Text("Creating \(providerLabel(provider)) chat…")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
              Spacer()
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("New chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Start") {
            Task { await submit() }
          }
          .disabled(!canStartChat)
        }
      }
      .onChange(of: selectedModelId) { _, _ in
        if let reasoningEfforts = selectedModel?.reasoningEfforts, !reasoningEfforts.isEmpty {
          if !reasoningEfforts.contains(where: { $0.effort == selectedReasoningEffort }) {
            selectedReasoningEffort = ""
          }
        } else {
          selectedReasoningEffort = ""
        }
      }
      .task(id: provider) {
        models = []
        selectedModelId = ""
        selectedReasoningEffort = ""
        await loadModels(resetSelection: true)
      }
      .onAppear {
        if selectedLaneId.isEmpty {
          if let initialLaneId,
             lanes.contains(where: { $0.id == initialLaneId }) {
            selectedLaneId = initialLaneId
          } else {
            selectedLaneId = lanes.first?.id ?? ""
          }
        }
      }
    }
  }

  @MainActor
  private func loadModels(resetSelection: Bool) async {
    let requestedProvider = provider
    do {
      let loadedModels = try await syncService.listChatModels(provider: requestedProvider)
      guard provider == requestedProvider else { return }
      models = loadedModels
      if resetSelection || loadedModels.contains(where: { $0.id == selectedModelId }) == false {
        if let preferred = loadedModels.first(where: \.isDefault) ?? loadedModels.first {
          selectedModelId = preferred.id
          selectedReasoningEffort = ""
        } else {
          selectedModelId = ""
          selectedReasoningEffort = ""
        }
      }
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      models = []
      selectedModelId = ""
    }
  }

  @MainActor
  private func submit() async {
    let openingMessage = trimmedInitialMessage
    guard !openingMessage.isEmpty else {
      errorMessage = "Enter an opening message before starting a chat."
      return
    }
    do {
      busy = true
      let summary = try await syncService.createChatSession(
        laneId: selectedLaneId,
        provider: provider,
        model: selectedModelId,
        reasoningEffort: {
          guard !selectedReasoningEffort.isEmpty else { return nil }
          guard selectedModel?.reasoningEfforts?.contains(where: { $0.effort == selectedReasoningEffort }) == true else { return nil }
          return selectedReasoningEffort
        }()
      )
      await onCreated(WorkDraftChatSession(summary: summary, initialMessage: openingMessage))
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}

private struct WorkProviderOption: Identifiable {
  let id: String
  let title: String
  let subtitle: String
  let icon: String
  let tint: Color
}

private struct WorkRuntimeOption: Identifiable {
  let id: String
  let title: String
  let subtitle: String
}

private struct WorkSessionSettingsSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let sessionId: String
  let laneName: String
  let summary: AgentChatSessionSummary
  let onSaved: @MainActor () async -> Void

  @State private var titleText: String
  @State private var models: [AgentChatModelInfo] = []
  @State private var selectedModelId: String
  @State private var selectedReasoningEffort: String
  @State private var selectedRuntimeMode: String
  @State private var selectedCursorModeId: String
  @State private var busy = false
  @State private var errorMessage: String?

  init(
    sessionId: String,
    laneName: String,
    summary: AgentChatSessionSummary,
    onSaved: @escaping @MainActor () async -> Void
  ) {
    self.sessionId = sessionId
    self.laneName = laneName
    self.summary = summary
    self.onSaved = onSaved
    _titleText = State(initialValue: summary.title ?? defaultWorkChatTitle(provider: summary.provider))
    _selectedModelId = State(initialValue: summary.modelId ?? summary.model)
    _selectedReasoningEffort = State(initialValue: summary.reasoningEffort ?? "")
    _selectedRuntimeMode = State(initialValue: workInitialRuntimeMode(summary))
    _selectedCursorModeId = State(initialValue: workInitialCursorModeId(summary))
  }

  private var selectedModel: AgentChatModelInfo? {
    models.first(where: { $0.id == selectedModelId })
  }

  private var resolvedInitialModelId: String {
    summary.modelId ?? summary.model
  }

  private var resolvedInitialTitle: String {
    (summary.title ?? defaultWorkChatTitle(provider: summary.provider))
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var resolvedInitialReasoningEffort: String {
    summary.reasoningEffort ?? ""
  }

  private var runtimeOptions: [WorkRuntimeOption] {
    switch summary.provider {
    case "claude":
      return [
        WorkRuntimeOption(id: "default", title: "Default", subtitle: "Standard approval flow."),
        WorkRuntimeOption(id: "plan", title: "Plan", subtitle: "Analysis and planning turns."),
        WorkRuntimeOption(id: "edit", title: "Edit", subtitle: "Auto-approve file edits."),
        WorkRuntimeOption(id: "full-auto", title: "Full auto", subtitle: "Skip permission prompts."),
      ]
    case "codex":
      return [
        WorkRuntimeOption(id: "default", title: "Default", subtitle: "Ask on request with workspace write."),
        WorkRuntimeOption(id: "plan", title: "Plan", subtitle: "Untrusted approvals with read-only sandbox."),
        WorkRuntimeOption(id: "edit", title: "Edit", subtitle: "Approve on failure with workspace write."),
        WorkRuntimeOption(id: "full-auto", title: "Full auto", subtitle: "Never ask, full sandbox access."),
      ]
    case "opencode":
      return [
        WorkRuntimeOption(id: "plan", title: "Plan", subtitle: "Read-first runtime mode."),
        WorkRuntimeOption(id: "edit", title: "Edit", subtitle: "Normal edit loop."),
        WorkRuntimeOption(id: "full-auto", title: "Full auto", subtitle: "Let the runtime operate freely."),
      ]
    default:
      return []
    }
  }

  private var cursorModeOptions: [WorkRuntimeOption] {
    workCursorModeIds(summary.cursorModeSnapshot, fallback: workInitialCursorModeId(summary)).map { modeId in
      WorkRuntimeOption(
        id: modeId,
        title: workCursorModeLabel(modeId),
        subtitle: modeId == (summary.cursorModeId ?? workInitialCursorModeId(summary))
          ? "Current cursor mode."
          : "Switch this session to \(workCursorModeLabel(modeId))."
      )
    }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Session") {
            VStack(alignment: .leading, spacing: 12) {
              HStack(spacing: 12) {
                Image(systemName: providerIcon(summary.provider))
                  .font(.system(size: 18, weight: .semibold))
                  .foregroundStyle(providerTint(summary.provider))
                  .frame(width: 34, height: 34)
                  .background(providerTint(summary.provider).opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                  Text(providerLabel(summary.provider))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                  Text("Update the live chat without leaving mobile.")
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }

                Spacer(minLength: 0)
              }

              HStack(spacing: 8) {
                WorkTag(text: laneName, icon: "arrow.triangle.branch", tint: ADEColor.textSecondary)
                WorkTag(
                  text: sessionStatusLabel(for: normalizedWorkChatSessionStatus(session: nil, summary: summary)),
                  icon: workChatStatusIcon(normalizedWorkChatSessionStatus(session: nil, summary: summary)),
                  tint: workChatStatusTint(normalizedWorkChatSessionStatus(session: nil, summary: summary))
                )
              }
            }
          }

          GlassSection(title: "Title") {
            TextField("Name this chat", text: $titleText)
              .textInputAutocapitalization(.sentences)
              .autocorrectionDisabled()
              .adeInsetField(cornerRadius: 14, padding: 12)
          }

          GlassSection(title: "Model") {
            VStack(alignment: .leading, spacing: 12) {
              if models.isEmpty && errorMessage == nil {
                HStack(spacing: 10) {
                  ProgressView()
                    .tint(ADEColor.accent)
                  Text("Loading \(providerLabel(summary.provider)) models…")
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              } else if models.isEmpty {
                Text(errorMessage ?? "No models are currently available for \(providerLabel(summary.provider)).")
                  .font(.caption)
                  .foregroundStyle(errorMessage == nil ? ADEColor.textSecondary : ADEColor.danger)
              } else {
                ForEach(models) { model in
                  Button {
                    selectedModelId = model.id
                  } label: {
                    VStack(alignment: .leading, spacing: 8) {
                      HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                          Text(model.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ADEColor.textPrimary)
                          if let description = model.description, !description.isEmpty {
                            Text(description)
                              .font(.caption)
                              .foregroundStyle(ADEColor.textSecondary)
                              .lineLimit(2)
                          }
                        }

                        Spacer(minLength: 8)

                        if selectedModelId == model.id {
                          Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(ADEColor.accent)
                        }
                      }

                      HStack(spacing: 6) {
                        if let family = model.family, !family.isEmpty {
                          LaneMicroChip(icon: "circle.grid.2x2.fill", text: family, tint: ADEColor.textSecondary)
                        }
                        if model.supportsReasoning == true {
                          LaneMicroChip(icon: "brain", text: "Reasoning", tint: ADEColor.accent)
                        }
                        if model.supportsTools == true {
                          LaneMicroChip(icon: "hammer.fill", text: "Tools", tint: ADEColor.success)
                        }
                        if model.isDefault {
                          LaneMicroChip(icon: "star.fill", text: "Default", tint: ADEColor.warning)
                        }
                        Spacer(minLength: 0)
                      }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(selectedModelId == model.id ? providerTint(summary.provider).opacity(0.14) : ADEColor.surfaceBackground.opacity(0.55))
                    )
                    .overlay(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(selectedModelId == model.id ? providerTint(summary.provider).opacity(0.42) : ADEColor.border.opacity(0.18), lineWidth: selectedModelId == model.id ? 1.3 : 0.8)
                    )
                    .glassEffect(in: .rect(cornerRadius: 16))
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          }

          if let reasoningEfforts = selectedModel?.reasoningEfforts, !reasoningEfforts.isEmpty {
            GlassSection(title: "Reasoning") {
              VStack(alignment: .leading, spacing: 12) {
                Picker("Reasoning", selection: $selectedReasoningEffort) {
                  Text("Default").tag("")
                  ForEach(reasoningEfforts) { effort in
                    Text(effort.effort.capitalized).tag(effort.effort)
                  }
                }
                .pickerStyle(.segmented)

                if let effort = reasoningEfforts.first(where: { $0.effort == selectedReasoningEffort }) {
                  Text(effort.description)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }

          if summary.provider == "cursor", !cursorModeOptions.isEmpty {
            GlassSection(title: "Cursor mode") {
              VStack(alignment: .leading, spacing: 12) {
                ForEach(cursorModeOptions) { option in
                  Button {
                    selectedCursorModeId = option.id
                  } label: {
                    runtimeCard(option: option, isSelected: selectedCursorModeId == option.id)
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          } else if !runtimeOptions.isEmpty {
            GlassSection(title: "Runtime mode") {
              VStack(alignment: .leading, spacing: 12) {
                ForEach(runtimeOptions) { option in
                  Button {
                    selectedRuntimeMode = option.id
                  } label: {
                    runtimeCard(option: option, isSelected: selectedRuntimeMode == option.id)
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }

          if busy {
            HStack(spacing: 10) {
              ProgressView()
                .tint(ADEColor.accent)
              Text("Updating chat settings…")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
              Spacer()
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Chat settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            Task { await submit() }
          }
          .disabled(busy || selectedModelId.isEmpty)
        }
      }
      .onChange(of: selectedModelId) { _, _ in
        if let reasoningEfforts = selectedModel?.reasoningEfforts, !reasoningEfforts.isEmpty {
          if !reasoningEfforts.contains(where: { $0.effort == selectedReasoningEffort }) {
            selectedReasoningEffort = ""
          }
        } else {
          selectedReasoningEffort = ""
        }
      }
      .task {
        await loadModels()
      }
    }
  }

  @MainActor
  private func loadModels() async {
    do {
      let loadedModels = try await syncService.listChatModels(provider: summary.provider)
      models = loadedModels

      let matchedModelId =
        loadedModels.first(where: { $0.id == selectedModelId })?.id
        ?? loadedModels.first(where: { $0.id == summary.modelId })?.id
        ?? loadedModels.first(where: { $0.id == summary.model })?.id
        ?? loadedModels.first(where: { $0.displayName == summary.model })?.id
        ?? loadedModels.first(where: \.isDefault)?.id
        ?? loadedModels.first?.id
        ?? ""

      selectedModelId = matchedModelId
      if let selectedModel,
         let reasoningEfforts = selectedModel.reasoningEfforts,
         reasoningEfforts.contains(where: { $0.effort == selectedReasoningEffort }) == false {
        selectedReasoningEffort = ""
      }
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      models = []
      selectedModelId = ""
    }
  }

  @MainActor
  private func submit() async {
    let trimmedTitle = titleText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedTitle.isEmpty else {
      ADEHaptics.error()
      errorMessage = "Chat title cannot be empty."
      return
    }

    let titleChanged = trimmedTitle != resolvedInitialTitle
    let modelChanged = selectedModelId != resolvedInitialModelId
    let normalizedReasoning = selectedReasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
    let reasoningPayload = normalizedReasoning.isEmpty ? "" : normalizedReasoning
    let reasoningChanged = reasoningPayload != resolvedInitialReasoningEffort
    let initialRuntimeMode = workInitialRuntimeMode(summary)
    let initialCursorModeId = workInitialCursorModeId(summary)

    var permissionMode: String?
    var interactionMode: String?
    var claudePermissionMode: String?
    var codexApprovalPolicy: String?
    var codexSandbox: String?
    var codexConfigSource: String?
    var opencodePermissionMode: String?
    var cursorModeId: String?
    var runtimeChanged = false

    switch summary.provider {
    case "claude":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        switch selectedRuntimeMode {
        case "plan":
          interactionMode = "plan"
          claudePermissionMode = "default"
          permissionMode = "plan"
        case "edit":
          interactionMode = "default"
          claudePermissionMode = "acceptEdits"
          permissionMode = "edit"
        case "full-auto":
          interactionMode = "default"
          claudePermissionMode = "bypassPermissions"
          permissionMode = "full-auto"
        default:
          interactionMode = "default"
          claudePermissionMode = "default"
          permissionMode = "default"
        }
      }
    case "codex":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        codexConfigSource = "flags"
        switch selectedRuntimeMode {
        case "plan":
          codexApprovalPolicy = "untrusted"
          codexSandbox = "read-only"
          permissionMode = "plan"
        case "edit":
          codexApprovalPolicy = "on-failure"
          codexSandbox = "workspace-write"
          permissionMode = "edit"
        case "full-auto":
          codexApprovalPolicy = "never"
          codexSandbox = "danger-full-access"
          permissionMode = "full-auto"
        default:
          codexApprovalPolicy = "on-request"
          codexSandbox = "workspace-write"
          permissionMode = "default"
        }
      }
    case "opencode":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        opencodePermissionMode = selectedRuntimeMode
        permissionMode = selectedRuntimeMode
      }
    case "cursor":
      if !selectedCursorModeId.isEmpty && selectedCursorModeId != initialCursorModeId {
        runtimeChanged = true
        cursorModeId = selectedCursorModeId
      }
    default:
      break
    }

    guard titleChanged || modelChanged || reasoningChanged || runtimeChanged else {
      dismiss()
      return
    }

    do {
      busy = true
      _ = try await syncService.updateChatSession(
        sessionId: sessionId,
        title: titleChanged ? trimmedTitle : nil,
        modelId: modelChanged ? selectedModelId : nil,
        reasoningEffort: reasoningChanged ? reasoningPayload : nil,
        permissionMode: permissionMode,
        interactionMode: interactionMode,
        claudePermissionMode: claudePermissionMode,
        codexApprovalPolicy: codexApprovalPolicy,
        codexSandbox: codexSandbox,
        codexConfigSource: codexConfigSource,
        opencodePermissionMode: opencodePermissionMode,
        cursorModeId: cursorModeId,
        manuallyNamed: titleChanged ? true : nil
      )
      if titleChanged {
        try await syncService.updateSessionMeta(
          sessionId: sessionId,
          title: trimmedTitle,
          manuallyNamed: true
        )
      }
      await onSaved()
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busy = false
  }

  private func runtimeCard(option: WorkRuntimeOption, isSelected: Bool) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(option.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(option.subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }

        Spacer(minLength: 8)

        if isSelected {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(ADEColor.accent)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(isSelected ? providerTint(summary.provider).opacity(0.14) : ADEColor.surfaceBackground.opacity(0.55))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(isSelected ? providerTint(summary.provider).opacity(0.42) : ADEColor.border.opacity(0.18), lineWidth: isSelected ? 1.3 : 0.8)
    )
    .glassEffect(in: .rect(cornerRadius: 16))
  }
}

private struct WorkSessionDestinationView: View {
  @EnvironmentObject private var syncService: SyncService

  let sessionId: String
  let initialOpeningPrompt: String?
  let initialSession: TerminalSessionSummary?
  let initialChatSummary: AgentChatSessionSummary?
  let initialTranscript: [WorkChatEnvelope]?
  let transitionNamespace: Namespace.ID?
  let isLive: Bool
  let disconnectedNotice: Bool

  @State private var session: TerminalSessionSummary?
  @State private var chatSummary: AgentChatSessionSummary?
  @State private var transcript: [WorkChatEnvelope] = []
  @State private var fallbackEntries: [AgentChatTranscriptEntry] = []
  @State private var artifacts: [ComputerUseArtifactSummary] = []
  @State private var localEchoMessages: [WorkLocalEchoMessage] = []
  @State private var expandedToolCardIds = Set<String>()
  @State private var artifactContent: [String: WorkLoadedArtifactContent] = [:]
  @State private var fullscreenImage: WorkFullscreenImage?
  @State private var composer = ""
  @State private var sending = false
  @State private var errorMessage: String?
  @State private var announcedLaneId: String?
  @State private var settingsPresented = false
  @State private var lastSessionRowRefreshAt = Date.distantPast
  @State private var handledOpeningPromptKey: String?
  @State private var stagedOpeningPromptKey: String?

  private var sessionDestinationNavigationTitle: String {
    chatSummary?.title ?? session?.title ?? "Session"
  }

  private var sessionDestinationZoomTransitionId: String? {
    transitionNamespace == nil ? nil : "work-container-\(sessionId)"
  }

  var body: some View {
    sessionDestinationRoot
      .navigationTitle(sessionDestinationNavigationTitle)
      .navigationBarTitleDisplayMode(.inline)
      .adeNavigationZoomTransition(id: sessionDestinationZoomTransitionId, in: transitionNamespace)
      .sheet(item: $fullscreenImage) { image in
        WorkFullscreenImageView(image: image)
      }
      .sheet(isPresented: $settingsPresented, content: sessionSettingsSheet)
      .task {
        session = initialSession
        chatSummary = initialChatSummary
        transcript = initialTranscript ?? []
        stageInitialOpeningPromptEchoIfNeeded()
        await load()
        await sendInitialOpeningPromptIfNeeded()
      }
      .task(id: liveChatObservationKey) {
        syncTranscriptFromLiveEvents()
        let now = Date()
        if now.timeIntervalSince(lastSessionRowRefreshAt) >= 1.2 {
          lastSessionRowRefreshAt = now
          if let refreshedSession = try? await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
            session = refreshedSession
          }
        }
      }
      .task(id: session?.laneId ?? initialSession?.laneId ?? "") {
        await syncLanePresence()
      }
      .task(id: pollingKey) {
        await pollIfNeeded()
      }
      .onDisappear {
        if let announcedLaneId {
          syncService.releaseLaneOpen(laneId: announcedLaneId)
          self.announcedLaneId = nil
        }
        Task {
          try? await syncService.unsubscribeFromChatEvents(sessionId: sessionId)
        }
      }
  }

  @ViewBuilder
  private var sessionDestinationRoot: some View {
    if let session {
      if isChatSession(session) {
        WorkChatSessionView(
          session: session,
          chatSummary: chatSummary,
          transcript: transcript,
          fallbackEntries: fallbackEntries,
          artifacts: artifacts,
          localEchoMessages: localEchoMessages,
          expandedToolCardIds: $expandedToolCardIds,
          artifactContent: $artifactContent,
          fullscreenImage: $fullscreenImage,
          composer: $composer,
          sending: $sending,
          errorMessage: $errorMessage,
          isLive: isLive,
          disconnectedNotice: disconnectedNotice,
          transitionNamespace: transitionNamespace,
          onOpenSettings: {
            settingsPresented = true
          },
          onSend: sendMessage,
          onInterrupt: interruptSession,
          onDispose: disposeSession,
          onResume: resumeSession,
          onApproveRequest: approveRequest,
          onRespondToQuestion: respondToQuestion,
          onRetryLoad: load,
          onOpenFile: openFileReference,
          onOpenPr: openPullRequestReference,
          onLoadArtifact: loadArtifactContent,
          onCancelSteer: cancelSteer,
          onEditSteer: editSteer
        )
      } else {
        WorkTerminalSessionView(
          session: session,
          disconnectedNotice: disconnectedNotice,
          transitionNamespace: transitionNamespace
        )
        .environmentObject(syncService)
      }
    } else {
      ADEEmptyStateView(
        symbol: "bubble.left.and.bubble.right",
        title: "Session unavailable",
        message: "This session is no longer cached on the phone. Reconnect and refresh Work to restore it."
      )
      .adeScreenBackground()
    }
  }

  @ViewBuilder
  private func sessionSettingsSheet() -> some View {
    if let chatSummary {
      WorkSessionSettingsSheet(
        sessionId: sessionId,
        laneName: session?.laneName ?? initialSession?.laneName ?? "",
        summary: chatSummary,
        onSaved: {
          await load()
        }
      )
      .environmentObject(syncService)
    }
  }

  private var pollingKey: String {
    let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    return "\(session?.id ?? sessionId)-\(status)-\(isLive)"
  }

  private var liveChatObservationKey: String {
    "\(sessionId)-\(syncService.chatEventRevision(for: sessionId))"
  }

  private var trimmedInitialOpeningPrompt: String {
    initialOpeningPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  }

  @MainActor
  private func syncLanePresence() async {
    guard let laneId = session?.laneId ?? initialSession?.laneId else { return }
    guard announcedLaneId != laneId else { return }
    if let announcedLaneId {
      syncService.releaseLaneOpen(laneId: announcedLaneId)
    }
    announcedLaneId = laneId
    syncService.announceLaneOpen(laneId: laneId)
  }

  @MainActor
  private func load() async {
    do {
      if let fetchedSession = try await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
        session = fetchedSession
      }
      if let fetchedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
        chatSummary = fetchedSummary
      }
      if isLive, let currentSession = session ?? initialSession, isChatSession(currentSession) {
        try? await syncService.subscribeToChatEvents(sessionId: sessionId)
      }
      artifacts = (try? await syncService.fetchComputerUseArtifacts(ownerKind: "chat_session", ownerId: sessionId)) ?? []
      await loadTranscript(forceRemote: isLive)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func loadTranscript(forceRemote: Bool) async {
    if forceRemote, let currentSession = session ?? initialSession, isChatSession(currentSession) {
      try? await syncService.subscribeToChatEvents(sessionId: sessionId)
    }

    let liveTranscript = makeWorkChatTranscript(from: syncService.chatEventHistory(sessionId: sessionId))
    var baseTranscript: [WorkChatEnvelope] = []
    var fetchedFallbackEntries: [AgentChatTranscriptEntry] = []

    if let response = try? await syncService.fetchChatTranscriptResponse(sessionId: sessionId) {
      fetchedFallbackEntries = response.entries
      baseTranscript = makeWorkChatTranscript(from: response.entries, sessionId: sessionId)
    }

    if forceRemote {
      try? await syncService.subscribeTerminal(sessionId: sessionId)
      let raw = syncService.terminalBuffers[sessionId] ?? ""
      let parsed = parseWorkChatTranscript(raw)
      if !parsed.isEmpty {
        baseTranscript = mergeWorkChatTranscripts(base: baseTranscript, live: parsed)
      }
    }

    if baseTranscript.isEmpty {
      baseTranscript = transcript
    }

    let mergedTranscript = mergeWorkChatTranscripts(base: baseTranscript, live: liveTranscript)
    if !mergedTranscript.isEmpty {
      transcript = mergedTranscript
    }
    fallbackEntries = fetchedFallbackEntries

    localEchoMessages.removeAll { echo in
      transcript.contains(where: { envelope in
        if case .userMessage(let text, _, _, _, _) = envelope.event {
          return text.trimmingCharacters(in: .whitespacesAndNewlines) == echo.text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return false
      })
    }
  }

  @MainActor
  private func refreshChatStateAfterAction(forceRemote: Bool = true) async {
    await loadTranscript(forceRemote: forceRemote)
    if let refreshedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
      chatSummary = refreshedSummary
    }
    if let refreshedSession = try? await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
      session = refreshedSession
    }
  }

  @MainActor
  private func sendInitialOpeningPromptIfNeeded() async {
    let prompt = trimmedInitialOpeningPrompt
    guard !prompt.isEmpty else { return }
    let promptKey = "\(sessionId)|\(prompt)"
    guard handledOpeningPromptKey != promptKey else { return }
    if transcript.contains(where: { envelope in
      if case .userMessage(let text, _, _, _, _) = envelope.event {
        return text.trimmingCharacters(in: .whitespacesAndNewlines) == prompt
      }
      return false
    }) {
      handledOpeningPromptKey = promptKey
      return
    }
    handledOpeningPromptKey = promptKey

    let echo: WorkLocalEchoMessage
    if let existingEcho = localEchoMessages.first(where: {
      $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == prompt
    }) {
      echo = existingEcho
    } else {
      let nextEcho = WorkLocalEchoMessage(text: prompt, timestamp: workDateFormatter.string(from: Date()))
      localEchoMessages.append(nextEcho)
      echo = nextEcho
    }
    sending = true
    do {
      try await syncService.sendChatMessage(sessionId: sessionId, text: prompt)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      localEchoMessages.removeAll { $0.id == echo.id }
      composer = prompt
      errorMessage = "Opening message did not reach the host. The chat exists; tap Send to retry. \(error.localizedDescription)"
    }
    sending = false
  }

  @MainActor
  private func stageInitialOpeningPromptEchoIfNeeded() {
    let prompt = trimmedInitialOpeningPrompt
    guard !prompt.isEmpty else { return }
    let promptKey = "\(sessionId)|\(prompt)"
    guard stagedOpeningPromptKey != promptKey else { return }
    stagedOpeningPromptKey = promptKey
    localEchoMessages.append(WorkLocalEchoMessage(text: prompt, timestamp: workDateFormatter.string(from: Date())))
  }

  private func syncTranscriptFromLiveEvents() {
    let liveTranscript = makeWorkChatTranscript(from: syncService.chatEventHistory(sessionId: sessionId))
    guard !liveTranscript.isEmpty else { return }
    let baseTranscript = transcript.isEmpty && !fallbackEntries.isEmpty
      ? makeWorkChatTranscript(from: fallbackEntries, sessionId: sessionId)
      : transcript
    transcript = mergeWorkChatTranscripts(base: baseTranscript, live: liveTranscript)
  }

  @MainActor
  private func pollIfNeeded() async {
    guard isLive,
          let session,
          isChatSession(session)
    else { return }
    let initialStatus = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    guard initialStatus == "active" || initialStatus == "awaiting-input" else { return }
    var pollCycle = 0
    while !Task.isCancelled, isLive,
      {
        let status = normalizedWorkChatSessionStatus(session: self.session, summary: self.chatSummary)
        return status == "active" || status == "awaiting-input"
      }() {
      pollCycle += 1
      syncTranscriptFromLiveEvents()
      if pollCycle % 3 == 1 {
        await loadTranscript(forceRemote: true)
      }
      if pollCycle % 2 == 1 {
        if let refreshedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
          chatSummary = refreshedSummary
        }
        if let refreshedSession = try? await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
          self.session = refreshedSession
        }
      }
      try? await Task.sleep(nanoseconds: 1_700_000_000)
    }
  }

  @MainActor
  private func sendMessage() async {
    let text = composer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }

    localEchoMessages.append(WorkLocalEchoMessage(text: text, timestamp: workDateFormatter.string(from: Date())))
    composer = ""
    sending = true
    do {
      try await syncService.sendChatMessage(sessionId: sessionId, text: text)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      localEchoMessages.removeAll { echo in
        echo.text.trimmingCharacters(in: .whitespacesAndNewlines) == text
      }
      composer = text
      errorMessage = error.localizedDescription
    }
    sending = false
  }

  @MainActor
  private func interruptSession() async {
    do {
      try await syncService.interruptChatSession(sessionId: sessionId)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func disposeSession() async {
    do {
      try await syncService.disposeChatSession(sessionId: sessionId)
      await load()
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func resumeSession() async {
    do {
      _ = try await syncService.resumeChatSession(sessionId: sessionId)
      await load()
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func approveRequest(itemId: String, decision: AgentChatApprovalDecision) async {
    do {
      try await syncService.approveChatSession(sessionId: sessionId, itemId: itemId, decision: decision)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func cancelSteer(_ steerId: String) async {
    do {
      try await syncService.cancelChatSteer(sessionId: sessionId, steerId: steerId)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func editSteer(_ steerId: String, _ text: String) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    do {
      try await syncService.editChatSteer(sessionId: sessionId, steerId: steerId, text: trimmed)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func respondToQuestion(itemId: String, answer: String?, responseText: String?) async {
    do {
      let answerValue = answer?.trimmingCharacters(in: .whitespacesAndNewlines)
      let responseValue = responseText?.trimmingCharacters(in: .whitespacesAndNewlines)
      try await syncService.respondToChatInput(
        sessionId: sessionId,
        itemId: itemId,
        answers: answerValue.flatMap { $0.isEmpty ? nil : ["response": .string($0)] },
        responseText: responseValue?.isEmpty == true ? nil : responseValue
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func loadArtifactContent(_ artifact: ComputerUseArtifactSummary) async {
    guard artifactContent[artifact.id] == nil else { return }

    let cacheKey = "work-artifact::\(artifact.id)::\(artifact.uri)"

    if artifact.artifactKind != "video_recording", let cachedImage = ADEImageCache.shared.cachedImage(for: cacheKey) {
      artifactContent[artifact.id] = .image(cachedImage)
      return
    }

    if let directURL = URL(string: artifact.uri), directURL.scheme?.hasPrefix("http") == true {
      if artifact.artifactKind == "video_recording" || (artifact.mimeType?.contains("video") == true) {
        artifactContent[artifact.id] = .remoteURL(directURL)
      } else if let image = try? await ADEImageCache.shared.loadRemoteImage(from: directURL, cacheKey: cacheKey) {
        artifactContent[artifact.id] = .image(image)
      } else {
        artifactContent[artifact.id] = .error("The host returned an unreadable image preview.")
      }
      return
    }

    do {
      let blob = try await syncService.readArtifact(artifactId: artifact.id, uri: artifact.uri)
      let data: Data
      if blob.isBinary {
        data = Data(base64Encoded: blob.content) ?? Data()
      } else {
        data = blob.content.data(using: .utf8) ?? Data()
      }

      if artifact.artifactKind == "video_recording" || (artifact.mimeType?.contains("video") == true) {
        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent("ade-work-artifact-\(artifact.id)")
          .appendingPathExtension(fileExtension(for: artifact.mimeType, fallback: "mp4"))
        try data.write(to: url, options: .atomic)
        artifactContent[artifact.id] = .video(url)
      } else if let image = UIImage(data: data) {
        ADEImageCache.shared.store(data, for: cacheKey)
        artifactContent[artifact.id] = .image(image)
      } else {
        artifactContent[artifact.id] = .text(blob.content)
      }
    } catch {
      artifactContent[artifact.id] = .error(error.localizedDescription)
    }
  }

  @MainActor
  private func openFileReference(_ path: String) async {
    guard let session else { return }

    do {
      let workspaces = try await syncService.listWorkspaces()
      guard let workspace = workspaces.first(where: { $0.laneId == session.laneId }) ?? workspaces.first else {
        errorMessage = "No Files workspace is available for this lane yet."
        return
      }

      let relativePath = normalizeWorkFileReference(
        path,
        workspaceRoot: workspace.rootPath,
        requestedCwd: chatSummary?.requestedCwd
      )
      guard !relativePath.isEmpty else {
        errorMessage = "ADE could not resolve that file path into the current workspace."
        return
      }

      syncService.requestedFilesNavigation = FilesNavigationRequest(
        workspaceId: workspace.id,
        relativePath: relativePath
      )
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func openPullRequestReference(_ number: Int) async {
    do {
      let pullRequests = try await syncService.fetchPullRequestListItems()
      let laneScoped = pullRequests.first { $0.githubPrNumber == number && $0.laneId == session?.laneId }
      let target = laneScoped ?? pullRequests.first { $0.githubPrNumber == number }

      guard let target else {
        errorMessage = "PR #\(number) is not cached on this phone yet. Refresh PRs and try again."
        return
      }

      syncService.requestedPrNavigation = PrNavigationRequest(prId: target.id)
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

private struct WorkChatSessionView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  let session: TerminalSessionSummary
  let chatSummary: AgentChatSessionSummary?
  let transcript: [WorkChatEnvelope]
  let fallbackEntries: [AgentChatTranscriptEntry]
  let artifacts: [ComputerUseArtifactSummary]
  let localEchoMessages: [WorkLocalEchoMessage]
  @Binding var expandedToolCardIds: Set<String>
  @Binding var artifactContent: [String: WorkLoadedArtifactContent]
  @Binding var fullscreenImage: WorkFullscreenImage?
  @Binding var composer: String
  @Binding var sending: Bool
  @Binding var errorMessage: String?
  @State private var visibleTimelineCount = workTimelinePageSize
  @State private var inputResponseText = ""
  @State private var actionInFlight = false
  @State private var isNearBottom = true
  let isLive: Bool
  let disconnectedNotice: Bool
  let transitionNamespace: Namespace.ID?
  let onOpenSettings: (() -> Void)?
  let onSend: @MainActor () async -> Void
  let onInterrupt: @MainActor () async -> Void
  let onDispose: @MainActor () async -> Void
  let onResume: @MainActor () async -> Void
  let onApproveRequest: @MainActor (String, AgentChatApprovalDecision) async -> Void
  let onRespondToQuestion: @MainActor (String, String?, String?) async -> Void
  let onRetryLoad: @MainActor () async -> Void
  let onOpenFile: @MainActor (String) async -> Void
  let onOpenPr: @MainActor (Int) async -> Void
  let onLoadArtifact: @MainActor (ComputerUseArtifactSummary) async -> Void
  let onCancelSteer: @MainActor (String) async -> Void
  let onEditSteer: @MainActor (String, String) async -> Void

  @State private var steerEditDrafts: [String: String] = [:]

  private var sessionStatus: String {
    normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
  }

  private var pendingInputs: [WorkPendingInputItem] {
    derivePendingWorkInputs(from: transcript)
  }

  private var pendingSteers: [WorkPendingSteerModel] {
    derivePendingWorkSteers(from: transcript)
  }

  private var primaryPendingInput: WorkPendingInputItem? {
    pendingInputs.first
  }

  private var toolCards: [WorkToolCardModel] {
    buildWorkToolCards(from: transcript)
  }

  private var eventCards: [WorkEventCardModel] {
    buildWorkEventCards(from: transcript)
  }

  private var commandCards: [WorkCommandCardModel] {
    buildWorkCommandCards(from: transcript)
  }

  private var fileChangeCards: [WorkFileChangeCardModel] {
    buildWorkFileChangeCards(from: transcript)
  }

  private var sessionUsageSummary: WorkUsageSummary? {
    summarizeWorkSessionUsage(from: transcript)
  }

  private var timeline: [WorkTimelineEntry] {
    buildWorkTimeline(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      toolCards: toolCards,
      commandCards: commandCards,
      fileChangeCards: fileChangeCards,
      eventCards: eventCards,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
    )
  }

  private var visibleTimeline: [WorkTimelineEntry] {
    visibleWorkTimelineEntries(from: timeline, visibleCount: visibleTimelineCount)
  }

  private var hiddenTimelineCount: Int {
    max(timeline.count - visibleTimeline.count, 0)
  }

  private var canCompose: Bool {
    isLive && !sending && sessionStatus != "ended"
  }

  private var composerFeedback: String? {
    if !isLive {
      return "Reconnect to send or resume this chat."
    }
    if sessionStatus == "ended" {
      return "Resume this chat before sending another message."
    }
    if sending {
      return "Sending message to host..."
    }
    if sessionStatus == "awaiting-input" {
      return "Answer the waiting prompt above, or send extra context."
    }
    return nil
  }

  private var sessionOverviewSection: AnyView {
    AnyView(
      Group {
        WorkSessionHeader(
          session: session,
          chatSummary: chatSummary,
          transitionNamespace: transitionNamespace,
          onOpenSettings: onOpenSettings
        )

        if let sessionUsageSummary {
          WorkSessionUsageSummaryCard(summary: sessionUsageSummary)
        }

        if isLive {
          WorkSessionControlBar(
            status: sessionStatus,
            actionInFlight: actionInFlight,
            onInterrupt: {
              await runSessionAction(onInterrupt)
            },
            onResume: {
              await runSessionAction(onResume)
            },
            onDispose: {
              await runSessionAction(onDispose)
            }
          )
        }

        ForEach(pendingInputs) { item in
          if isLive {
            switch item {
            case .approval(let approval):
              WorkApprovalRequestCard(
                approval: approval,
                busy: actionInFlight,
                onDecision: { decision in
                  await runSessionAction {
                    await onApproveRequest(approval.id, decision)
                  }
                }
              )
            case .question(let question):
              WorkStructuredQuestionCard(
                question: question,
                responseText: $inputResponseText,
                busy: actionInFlight,
                onSelectOption: { option in
                  await runSessionAction {
                    await onRespondToQuestion(question.id, option, inputResponseText)
                    inputResponseText = ""
                  }
                },
                onSubmitFreeform: {
                  await runSessionAction {
                    await onRespondToQuestion(question.id, nil, inputResponseText)
                    inputResponseText = ""
                  }
                }
              )
            }
          } else {
            switch item {
            case .approval:
              ADENoticeCard(
                title: "Approval waiting on host",
                message: "Reconnect to approve or deny this tool request. Cached transcript data may be slightly behind the desktop.",
                icon: "lock.shield",
                tint: ADEColor.warning,
                actionTitle: nil,
                action: nil
              )
            case .question:
              ADENoticeCard(
                title: "Host needs your answer",
                message: "Reconnect to respond to this question. The host keeps the session paused until input arrives.",
                icon: "questionmark.circle",
                tint: ADEColor.warning,
                actionTitle: nil,
                action: nil
              )
            }
          }
        }

        if disconnectedNotice {
          ADENoticeCard(
            title: "Connection lost",
            message: "Cached messages stay visible, but sending, streaming, and artifact refresh are paused until the host reconnects.",
            icon: "wifi.slash",
            tint: ADEColor.warning,
            actionTitle: nil,
            action: nil
          )
        }

        if let errorMessage {
          ADENoticeCard(
            title: "Chat error",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await onRetryLoad() } }
          )
        }
      }
    )
  }

  private var timelineSection: AnyView {
    AnyView(
      Group {
        if timeline.isEmpty {
          ADEEmptyStateView(
            symbol: "bubble.left.and.bubble.right",
            title: "No chat messages yet",
            message: isLive ? "Send a message to start streaming the transcript." : "Reconnect to load the latest chat history from the host."
          )
        } else {
          if hiddenTimelineCount > 0 {
            Button {
              loadEarlierTimelineEntries()
            } label: {
              Label(
                "Load \(min(hiddenTimelineCount, workTimelinePageSize)) earlier message\(min(hiddenTimelineCount, workTimelinePageSize) == 1 ? "" : "s")",
                systemImage: "chevron.up.circle"
              )
              .font(.footnote.weight(.semibold))
              .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glass)
            .tint(ADEColor.accent)
            .controlSize(.small)
            .accessibilityLabel("Load earlier messages")
          }

          ForEach(visibleTimeline) { entry in
            switch entry.payload {
            case .message(let message):
              WorkChatMessageBubble(message: message)
            case .toolCard(let toolCard):
              WorkToolCardView(
                toolCard: toolCard,
                references: extractWorkNavigationTargets(from: [toolCard.argsText, toolCard.resultText].compactMap { $0 }.joined(separator: "\n")),
                isExpanded: toolCard.status == .running || expandedToolCardIds.contains(toolCard.id),
                onToggle: { toggleToolCard(toolCard.id) },
                onOpenFile: { path in
                  Task { await onOpenFile(path) }
                },
                onOpenPr: { prNumber in
                  Task { await onOpenPr(prNumber) }
                }
              )
            case .eventCard(let card):
              WorkEventCardView(
                card: card,
                onOpenFile: { path in Task { await onOpenFile(path) } },
                onOpenPr: { number in Task { await onOpenPr(number) } }
              )
            case .commandCard(let commandCard):
              WorkCommandCardView(card: commandCard)
            case .fileChangeCard(let fileChangeCard):
              WorkFileChangeCardView(card: fileChangeCard)
            case .artifact(let artifact):
              WorkArtifactView(
                artifact: artifact,
                content: artifactContent[artifact.id],
                onAppear: { Task { await onLoadArtifact(artifact) } },
                onOpenImage: { image in
                  fullscreenImage = WorkFullscreenImage(title: artifact.title, image: image)
                }
              )
            }
          }
        }
      }
    )
  }

  private var streamingStatusSection: AnyView {
    AnyView(
      Group {
        if sessionStatus == "active" && isLive {
          HStack(spacing: 10) {
            ProgressView()
              .controlSize(.small)
            Text("Streaming new output…")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
      }
    )
  }

  private func composerInset(proxy: ScrollViewProxy) -> AnyView {
    AnyView(
      VStack(spacing: 10) {
        HStack(spacing: 8) {
          ADEStatusPill(
            text: isLive ? sessionStatusLabel(for: sessionStatus) : "OFFLINE",
            tint: isLive ? workChatStatusTint(sessionStatus) : ADEColor.warning
          )

          if sessionStatus == "active" && isLive {
            ProgressView()
              .controlSize(.small)
              .tint(ADEColor.accent)
          }

          Spacer(minLength: 0)

          if sessionStatus == "active" && isLive {
            Button {
              Task { await runSessionAction(onInterrupt) }
            } label: {
              Label("Stop", systemImage: "stop.fill")
                .labelStyle(.iconOnly)
                .frame(width: 32, height: 32)
            }
            .buttonStyle(.glass)
            .tint(ADEColor.warning)
            .disabled(actionInFlight || sending)
            .accessibilityLabel("Interrupt chat")
          } else if (sessionStatus == "idle" || sessionStatus == "ended") && isLive {
            Button {
              Task { await runSessionAction(onResume) }
            } label: {
              Label("Resume", systemImage: "play.fill")
                .labelStyle(.iconOnly)
                .frame(width: 32, height: 32)
            }
            .buttonStyle(.glass)
            .tint(ADEColor.accent)
            .disabled(actionInFlight || sending)
            .accessibilityLabel("Resume chat")
          }
        }

        WorkComposerChipStrip(
          chatSummary: chatSummary,
          queuedSteerCount: pendingSteers.count,
          pendingInputCount: pendingInputs.count,
          onOpenSettings: onOpenSettings
        )

        if let primary = primaryPendingInput {
          let overflow = max(pendingInputs.count - 1, 0)
          switch primary {
          case .approval(let approval):
            WorkComposerInputBanner(
              title: overflow > 0 ? "Approval waiting (+\(overflow) more)" : "Approval waiting",
              message: approval.description,
              icon: "checkmark.shield",
              tint: ADEColor.warning
            )
          case .question(let question):
            WorkComposerInputBanner(
              title: overflow > 0 ? "Question waiting (+\(overflow) more)" : "Question waiting",
              message: question.question,
              icon: "questionmark.circle",
              tint: ADEColor.warning
            )
          }
        }

        if !pendingSteers.isEmpty {
          WorkQueuedSteerStrip(
            steers: pendingSteers,
            drafts: $steerEditDrafts,
            busy: actionInFlight,
            isLive: isLive,
            onCancel: { steerId in
              await runSessionAction {
                await onCancelSteer(steerId)
                steerEditDrafts.removeValue(forKey: steerId)
              }
            },
            onSaveEdit: { steerId, text in
              await runSessionAction {
                await onEditSteer(steerId, text)
                steerEditDrafts.removeValue(forKey: steerId)
              }
            }
          )
        }

        HStack(alignment: .bottom, spacing: 10) {
          TextField("Send a message", text: $composer, axis: .vertical)
            .textFieldStyle(.plain)
            .lineLimit(1...6)
            .adeInsetField(cornerRadius: 14, padding: 12)
            .disabled(!canCompose)

          Button {
            Task {
              await onSend()
              withAnimation(ADEMotion.quick(reduceMotion: transitionNamespace == nil)) {
                proxy.scrollTo("chat-end", anchor: .bottom)
              }
            }
          } label: {
            Image(systemName: sending ? "ellipsis.circle" : "paperplane.fill")
              .font(.system(size: 18, weight: .semibold))
              .foregroundStyle(ADEColor.accent)
              .frame(width: 44, height: 44)
              .background(ADEColor.accent.opacity(0.12), in: Circle())
          }
          .accessibilityLabel(sending ? "Sending message" : "Send message")
          .disabled(!canCompose || composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }

        if let composerFeedback {
          Text(composerFeedback)
            .font(.caption2)
            .foregroundStyle(sessionStatus == "awaiting-input" ? ADEColor.warning : ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, sessionStatus == "awaiting-input" ? 10 : 0)
            .padding(.vertical, sessionStatus == "awaiting-input" ? 7 : 0)
            .background(
              Group {
                if sessionStatus == "awaiting-input" {
                  RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(ADEColor.warning.opacity(0.08))
                }
              }
            )
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      .background(ADEColor.surfaceBackground.opacity(0.08))
      .glassEffect()
    )
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          sessionOverviewSection
          timelineSection
          streamingStatusSection

          Color.clear
            .frame(height: 1)
            .id("chat-end")
            .onAppear {
              isNearBottom = true
            }
            .onDisappear {
              isNearBottom = false
            }
        }
        .padding(16)
      }
      .scrollIndicators(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .safeAreaInset(edge: .bottom) {
        composerInset(proxy: proxy)
      }
      .onChange(of: timeline.count) { _, _ in
        guard isNearBottom else { return }
        withAnimation(ADEMotion.quick(reduceMotion: transitionNamespace == nil)) {
          proxy.scrollTo("chat-end", anchor: .bottom)
        }
      }
    }
  }

  private func toggleToolCard(_ id: String) {
    if expandedToolCardIds.contains(id) {
      expandedToolCardIds.remove(id)
    } else {
      expandedToolCardIds.insert(id)
    }
  }

  private func loadEarlierTimelineEntries() {
    withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
      visibleTimelineCount += workTimelinePageSize
    }
  }

  @MainActor
  private func runSessionAction(_ action: @escaping @MainActor () async -> Void) async {
    actionInFlight = true
    await action()
    actionInFlight = false
  }
}

private struct WorkSessionHeader: View {
  let session: TerminalSessionSummary
  let chatSummary: AgentChatSessionSummary?
  let transitionNamespace: Namespace.ID?
  let onOpenSettings: (() -> Void)?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: providerIcon(chatSummary?.provider ?? ""))
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(providerTint(chatSummary?.provider))
          .frame(width: 34, height: 34)
          .background(providerTint(chatSummary?.provider).opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "work-icon-\(session.id)", in: transitionNamespace)
        VStack(alignment: .leading, spacing: 6) {
          Text(chatSummary?.title ?? session.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "work-title-\(session.id)", in: transitionNamespace)
          HStack(spacing: 8) {
            WorkTag(
              text: sessionStatusLabel(session, summary: chatSummary),
              icon: workChatStatusIcon(normalizedWorkChatSessionStatus(session: session, summary: chatSummary)),
              tint: workChatStatusTint(normalizedWorkChatSessionStatus(session: session, summary: chatSummary))
            )
              .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "work-status-\(session.id)", in: transitionNamespace)
            if let chatSummary {
              WorkTag(text: providerLabel(chatSummary.provider), icon: providerIcon(chatSummary.provider), tint: providerTint(chatSummary.provider))
              WorkTag(text: chatSummary.model, icon: "cpu", tint: ADEColor.textSecondary)
            }
            WorkTag(text: session.laneName, icon: "arrow.triangle.branch", tint: ADEColor.textSecondary)
          }
        }
        Spacer(minLength: 8)
        if let onOpenSettings {
          Button(action: onOpenSettings) {
            Image(systemName: "slider.horizontal.3")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .frame(width: 36, height: 36)
              .background(ADEColor.surfaceBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Open chat settings")
        }
      }

      HStack(spacing: 12) {
        metric(title: "Started", value: relativeTimestamp(session.startedAt))
        metric(title: "Duration", value: formattedSessionDuration(startedAt: session.startedAt, endedAt: session.endedAt))
        if let preview = chatSummary?.summary ?? session.summary, !preview.isEmpty {
          metric(title: "Summary", value: preview)
        }
      }
    }
    .adeListCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(chatSummary?.title ?? session.title), \(sessionStatusLabel(session, summary: chatSummary)), lane \(session.laneName)")
  }

  private func metric(title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(value)
        .font(.caption)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkChatMessageBubble: View {
  let message: WorkChatMessage

  var body: some View {
    HStack {
      if message.role == "assistant" {
        bubbleContent
        Spacer(minLength: 32)
      } else {
        Spacer(minLength: 32)
        bubbleContent
      }
    }
  }

  private var bubbleContent: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Image(systemName: message.role == "assistant" ? "sparkles" : "person.fill")
          .font(.caption.weight(.semibold))
          .foregroundStyle(message.role == "assistant" ? ADEColor.accent : ADEColor.warning)
        Text(message.role == "assistant" ? "Assistant" : "You")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        if let deliveryBadge {
          WorkDeliveryBadge(state: deliveryBadge)
        }
        Spacer(minLength: 8)
        Text(relativeTimestamp(message.timestamp))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      WorkMarkdownRenderer(markdown: message.markdown)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(message.role == "assistant" ? ADEColor.accent.opacity(0.08) : ADEColor.surfaceBackground.opacity(0.7))
    )
    .contextMenu {
      Button {
        UIPasteboard.general.string = message.markdown
      } label: {
        Label("Copy message", systemImage: "doc.on.doc")
      }
    }
  }

  private var deliveryBadge: WorkDeliveryBadge.State? {
    guard message.role == "user" else { return nil }
    if let state = message.deliveryState {
      switch state {
      case "queued": return .queued
      case "delivered":
        return message.processed == true ? nil : .delivered
      case "failed": return .failed
      case "sending": return .sending
      default: return nil
      }
    }
    return nil
  }
}

private struct WorkDeliveryBadge: View {
  enum State {
    case queued, sending, delivered, failed

    var label: String {
      switch self {
      case .queued: return "Queued"
      case .sending: return "Sending"
      case .delivered: return "Delivered"
      case .failed: return "Failed"
      }
    }

    var icon: String {
      switch self {
      case .queued: return "clock"
      case .sending: return "arrow.up.circle"
      case .delivered: return "checkmark.circle"
      case .failed: return "exclamationmark.triangle"
      }
    }

    var tint: Color {
      switch self {
      case .queued: return ADEColor.accent
      case .sending: return ADEColor.accent
      case .delivered: return ADEColor.success
      case .failed: return ADEColor.danger
      }
    }
  }

  let state: State

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: state.icon)
      Text(state.label)
    }
    .font(.caption2.weight(.semibold))
    .foregroundStyle(state.tint)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(state.tint.opacity(0.12), in: Capsule(style: .continuous))
    .accessibilityLabel("Delivery state: \(state.label)")
  }
}

private struct WorkToolCardView: View {
  let toolCard: WorkToolCardModel
  let references: WorkNavigationTargets
  let isExpanded: Bool
  let onToggle: () -> Void
  let onOpenFile: (String) -> Void
  let onOpenPr: (Int) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button(action: onToggle) {
        HStack(spacing: 10) {
          Image(systemName: "hammer.fill")
            .foregroundStyle(statusTint)
          VStack(alignment: .leading, spacing: 4) {
            Text(toolDisplayName(toolCard.toolName))
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            HStack(spacing: 8) {
              WorkTag(text: toolCard.status.rawValue.capitalized, icon: statusIcon, tint: statusTint)
              Text(formattedSessionDuration(startedAt: toolCard.startedAt, endedAt: toolCard.completedAt))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(ADEColor.textMuted)
            }
          }
          Spacer()
          Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .buttonStyle(.plain)

      if isExpanded {
        VStack(alignment: .leading, spacing: 10) {
          if !references.filePaths.isEmpty || !references.pullRequestNumbers.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
              Text("Linked references")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(ADEColor.textMuted)
              ScrollView(.horizontal, showsIndicators: false) {
                ADEGlassGroup(spacing: 8) {
                  ForEach(references.filePaths.prefix(3), id: \.self) { path in
                    Button {
                      onOpenFile(path)
                    } label: {
                      Label(workReferenceLabel(for: path), systemImage: "doc.text")
                        .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.glass)
                    .accessibilityLabel("Open file \(path) in Files")
                  }

                  ForEach(references.pullRequestNumbers.prefix(3), id: \.self) { number in
                    Button {
                      onOpenPr(number)
                    } label: {
                      Label("PR #\(number)", systemImage: "arrow.triangle.pull")
                        .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.glass)
                    .tint(ADEColor.accent)
                    .accessibilityLabel("Open PR number \(number)")
                  }
                }
              }
            }
          }

          if let argsText = toolCard.argsText, !argsText.isEmpty {
            WorkStructuredOutputBlock(title: "Arguments", text: argsText)
          }
          if let resultText = toolCard.resultText, !resultText.isEmpty {
            WorkStructuredOutputBlock(title: "Result", text: resultText)
          }
        }
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(toolDisplayName(toolCard.toolName)), \(toolCard.status.rawValue)")
  }

  private var statusTint: Color {
    switch toolCard.status {
    case .running: return ADEColor.warning
    case .completed: return ADEColor.success
    case .failed: return ADEColor.danger
    }
  }

  private var statusIcon: String {
    switch toolCard.status {
    case .running: return "ellipsis.circle"
    case .completed: return "checkmark.circle.fill"
    case .failed: return "xmark.circle.fill"
    }
  }
}

private struct WorkStructuredOutputBlock: View {
  let title: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      WorkOutputBlockHeader(title: title, copyText: text)
      ScrollView {
        Text(text)
          .frame(maxWidth: .infinity, alignment: .leading)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .textSelection(.enabled)
      }
      .frame(maxHeight: 180)
      .padding(10)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

private struct WorkANSIOutputBlock: View {
  let title: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      WorkOutputBlockHeader(title: title, copyText: text)
      ScrollView([.horizontal, .vertical]) {
        Text(ansiAttributedString(text))
          .frame(maxWidth: .infinity, alignment: .leading)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
      }
      .frame(maxHeight: 200)
      .padding(10)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

private struct WorkOutputBlockHeader: View {
  let title: String
  let copyText: String
  @State private var copied = false

  var body: some View {
    HStack(spacing: 6) {
      Text(title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
      Button {
        UIPasteboard.general.string = copyText
        copied = true
        Task {
          try? await Task.sleep(nanoseconds: 1_400_000_000)
          copied = false
        }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: copied ? "checkmark" : "doc.on.doc")
          Text(copied ? "Copied" : "Copy")
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(copied ? ADEColor.success : ADEColor.textSecondary)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(copied ? "Copied to clipboard" : "Copy \(title.lowercased())")
    }
  }
}

private struct WorkCommandCardView: View {
  let card: WorkCommandCardModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: statusIcon)
          .foregroundStyle(statusTint)
          .frame(width: 28, height: 28)
          .background(statusTint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

        VStack(alignment: .leading, spacing: 4) {
          Text("Command")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(card.command)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .textSelection(.enabled)
        }

        Spacer(minLength: 8)
        Text(relativeTimestamp(card.timestamp))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 8) {
        WorkTag(text: card.status.rawValue.capitalized, icon: statusIcon, tint: statusTint)
        if !card.cwd.isEmpty {
          WorkTag(text: card.cwd, icon: "folder", tint: ADEColor.textSecondary)
        }
        if let exitCode = card.exitCode {
          WorkTag(text: "Exit \(exitCode)", icon: exitCode == 0 ? "checkmark.circle" : "xmark.circle", tint: exitCode == 0 ? ADEColor.success : ADEColor.danger)
        }
        if let durationMs = card.durationMs {
          WorkTag(text: formattedDuration(milliseconds: durationMs), icon: "clock", tint: ADEColor.textSecondary)
        }
      }

      if !card.output.isEmpty {
        WorkANSIOutputBlock(title: "Output", text: card.output)
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
  }

  private var statusTint: Color {
    color(for: card.status)
  }

  private var statusIcon: String {
    icon(for: card.status)
  }
}

private struct WorkDiffOutputBlock: View {
  let title: String
  let diff: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      ScrollView([.horizontal, .vertical]) {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
            Text(line.isEmpty ? " " : line)
              .frame(maxWidth: .infinity, alignment: .leading)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(diffLineColor(for: line))
              .padding(.horizontal, 8)
              .padding(.vertical, 2)
              .background(diffLineBackground(for: line))
              .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 220)
      .padding(10)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

private struct WorkFileChangeCardView: View {
  let card: WorkFileChangeCardModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: fileChangeIcon)
          .foregroundStyle(statusTint)
          .frame(width: 28, height: 28)
          .background(statusTint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

        VStack(alignment: .leading, spacing: 4) {
          Text("File change")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(card.path)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .textSelection(.enabled)
        }

        Spacer(minLength: 8)
        Text(relativeTimestamp(card.timestamp))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 8) {
        WorkTag(text: card.kind.replacingOccurrences(of: "_", with: " ").capitalized, icon: fileChangeIcon, tint: statusTint)
        WorkTag(text: card.status.rawValue.capitalized, icon: statusIcon, tint: statusTint)
      }

      if !card.diff.isEmpty {
        WorkDiffOutputBlock(title: "Diff", diff: card.diff)
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
  }

  private var statusTint: Color {
    color(for: card.status)
  }

  private var fileChangeIcon: String {
    switch card.kind.lowercased() {
    case "create": return "doc.badge.plus"
    case "delete": return "trash"
    default: return "pencil.line"
    }
  }

  private var statusIcon: String {
    icon(for: card.status)
  }
}

private struct WorkEventCardView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let card: WorkEventCardModel
  var onOpenFile: ((String) -> Void)? = nil
  var onOpenPr: ((Int) -> Void)? = nil
  @State private var isAnimating = false

  private var navigationTargets: WorkNavigationTargets? {
    guard card.kind == "completionReport" else { return nil }
    let blob = ([card.body] + card.bullets).compactMap { $0 }.joined(separator: "\n")
    let targets = extractWorkNavigationTargets(from: blob)
    if targets.filePaths.isEmpty && targets.pullRequestNumbers.isEmpty {
      return nil
    }
    return targets
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: card.icon)
          .foregroundStyle(card.tint.color)
          .frame(width: 28, height: 28)
          .background(card.tint.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          .scaleEffect(card.kind == "activity" && isAnimating && !reduceMotion ? 1.08 : 1.0)
          .animation(card.kind == "activity" ? ADEMotion.pulse(reduceMotion: reduceMotion) : .default, value: isAnimating)
        VStack(alignment: .leading, spacing: 4) {
          Text(card.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if !card.metadata.isEmpty {
            Text(card.metadata.joined(separator: " · "))
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        Spacer(minLength: 8)
        Text(relativeTimestamp(card.timestamp))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      if let body = card.body, !body.isEmpty {
        Text(body)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }

      if !card.bullets.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(card.bullets, id: \.self) { bullet in
            HStack(alignment: .top, spacing: 8) {
              Text("•")
                .foregroundStyle(card.tint.color)
              Text(bullet)
                .font(.caption)
                .foregroundStyle(ADEColor.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
        }
      }

      if let navigationTargets {
        ScrollView(.horizontal, showsIndicators: false) {
          ADEGlassGroup(spacing: 8) {
            ForEach(navigationTargets.filePaths.prefix(6), id: \.self) { path in
              Button {
                onOpenFile?(path)
              } label: {
                Label(workReferenceLabel(for: path), systemImage: "doc.text")
                  .font(.caption.weight(.semibold))
              }
              .buttonStyle(.glass)
              .disabled(onOpenFile == nil)
              .accessibilityLabel("Open file \(path)")
            }
            ForEach(navigationTargets.pullRequestNumbers.prefix(6), id: \.self) { number in
              Button {
                onOpenPr?(number)
              } label: {
                Label("PR #\(number)", systemImage: "arrow.triangle.pull")
                  .font(.caption.weight(.semibold))
              }
              .buttonStyle(.glass)
              .disabled(onOpenPr == nil)
              .accessibilityLabel("Open pull request \(number)")
            }
          }
        }
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.65), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel([card.title, card.body, card.bullets.joined(separator: ", ")].compactMap { $0 }.joined(separator: ". "))
    .onAppear {
      guard card.kind == "activity", !reduceMotion else { return }
      isAnimating = true
    }
  }
}

private struct WorkSessionUsageSummaryCard: View {
  let summary: WorkUsageSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Session usage")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        Spacer()
        Text(summary.turnCount == 1 ? "1 completed turn" : "\(summary.turnCount) completed turns")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 12) {
        usageMetric(title: "Input", value: formattedTokenCount(summary.inputTokens))
        usageMetric(title: "Output", value: formattedTokenCount(summary.outputTokens))
        usageMetric(title: "Cache read", value: formattedTokenCount(summary.cacheReadTokens))
        usageMetric(title: "Cache write", value: formattedTokenCount(summary.cacheCreationTokens))
      }

      HStack {
        Text("Estimated cost")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer()
        Text(summary.costUsd > 0 ? String(format: "$%.4f", summary.costUsd) : "$0.0000")
          .font(.caption.monospacedDigit())
          .foregroundStyle(ADEColor.textPrimary)
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }

  private func usageMetric(title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(value)
        .font(.caption.monospacedDigit())
        .foregroundStyle(ADEColor.textPrimary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkSessionControlBar: View {
  let status: String
  let actionInFlight: Bool
  let onInterrupt: @MainActor () async -> Void
  let onResume: @MainActor () async -> Void
  let onDispose: @MainActor () async -> Void

  var body: some View {
    HStack(spacing: 10) {
      if status == "active" {
        Button("Interrupt") {
          Task { await onInterrupt() }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.warning)
        .disabled(actionInFlight)
      } else if status == "idle" || status == "ended" {
        Button(status == "ended" ? "Resume chat" : "Resume") {
          Task { await onResume() }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.accent)
        .disabled(actionInFlight)
      }

      Spacer(minLength: 0)

      Button(status == "ended" ? "Close session" : "End chat") {
        Task { await onDispose() }
      }
      .buttonStyle(.glassProminent)
      .tint(status == "ended" ? ADEColor.textSecondary : ADEColor.danger)
      .disabled(actionInFlight)
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
  }
}

private struct WorkComposerInputBanner: View {
  let title: String
  let message: String
  let icon: String
  let tint: Color

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: icon)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: 24, height: 24)
        .background(tint.opacity(0.12), in: Circle())

      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(message)
          .font(.caption2)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
      }

      Spacer(minLength: 0)
    }
    .padding(10)
    .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(tint.opacity(0.18), lineWidth: 0.8)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title). \(message)")
  }
}

private struct WorkComposerChipStrip: View {
  let chatSummary: AgentChatSessionSummary?
  let queuedSteerCount: Int
  let pendingInputCount: Int
  let onOpenSettings: (() -> Void)?

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        if let chatSummary {
          chip(
            icon: providerIcon(chatSummary.provider),
            label: chatSummary.model,
            tint: providerTint(chatSummary.provider)
          )
          if let runtime = runtimeLabel(for: chatSummary) {
            chip(icon: "shield.lefthalf.filled", label: runtime, tint: ADEColor.accent)
          }
          if let profile = chatSummary.sessionProfile, !profile.isEmpty {
            chip(icon: "slider.horizontal.3", label: profile, tint: ADEColor.textSecondary)
          }
        }

        if queuedSteerCount > 0 {
          chip(icon: "paperplane.circle", label: "\(queuedSteerCount) queued", tint: ADEColor.accent)
        }
        if pendingInputCount > 0 {
          chip(icon: "hand.raised.circle", label: "\(pendingInputCount) waiting", tint: ADEColor.warning)
        }
      }
      .padding(.horizontal, 2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func chip(icon: String, label: String, tint: Color) -> some View {
    Button {
      onOpenSettings?()
    } label: {
      HStack(spacing: 6) {
        Image(systemName: icon)
          .font(.caption2.weight(.semibold))
        Text(label)
          .font(.caption2.weight(.semibold))
          .lineLimit(1)
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background(tint.opacity(0.1), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(tint.opacity(0.18), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .disabled(onOpenSettings == nil)
    .accessibilityLabel("\(label). Open chat settings")
  }

  private func runtimeLabel(for summary: AgentChatSessionSummary) -> String? {
    let normalizedProvider = summary.provider.lowercased()
    switch normalizedProvider {
    case "claude":
      return summary.claudePermissionMode ?? summary.permissionMode
    case "codex":
      if let policy = summary.codexApprovalPolicy, let sandbox = summary.codexSandbox {
        return "\(policy) · \(sandbox)"
      }
      return summary.codexApprovalPolicy ?? summary.codexSandbox
    case "opencode":
      return summary.opencodePermissionMode ?? summary.permissionMode
    default:
      return summary.permissionMode ?? summary.executionMode
    }
  }
}

private struct WorkQueuedSteerStrip: View {
  let steers: [WorkPendingSteerModel]
  @Binding var drafts: [String: String]
  let busy: Bool
  let isLive: Bool
  let onCancel: @MainActor (String) async -> Void
  let onSaveEdit: @MainActor (String, String) async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "paperplane.circle")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
        Text(steers.count == 1 ? "1 queued message" : "\(steers.count) queued messages")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 0)
      }

      VStack(spacing: 6) {
        ForEach(steers) { steer in
          WorkQueuedSteerRow(
            steer: steer,
            draft: Binding(
              get: { drafts[steer.id] ?? steer.text },
              set: { drafts[steer.id] = $0 }
            ),
            isEditing: drafts[steer.id] != nil,
            busy: busy,
            isLive: isLive,
            onBeginEdit: { drafts[steer.id] = steer.text },
            onCancelEdit: { drafts.removeValue(forKey: steer.id) },
            onCancel: { await onCancel(steer.id) },
            onSave: { text in await onSaveEdit(steer.id, text) }
          )
        }
      }
    }
    .padding(10)
    .background(ADEColor.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.accent.opacity(0.18), lineWidth: 0.8)
    )
  }
}

private struct WorkQueuedSteerRow: View {
  let steer: WorkPendingSteerModel
  @Binding var draft: String
  let isEditing: Bool
  let busy: Bool
  let isLive: Bool
  let onBeginEdit: () -> Void
  let onCancelEdit: () -> Void
  let onCancel: @MainActor () async -> Void
  let onSave: @MainActor (String) async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if isEditing {
        TextField("Queued message", text: $draft, axis: .vertical)
          .lineLimit(1...5)
          .adeInsetField(cornerRadius: 12, padding: 10)
          .disabled(busy || !isLive)

        HStack(spacing: 8) {
          Spacer(minLength: 0)
          Button("Cancel edit", action: onCancelEdit)
            .buttonStyle(.glass)
            .tint(ADEColor.textSecondary)
            .controlSize(.small)
            .disabled(busy)

          Button("Save") {
            let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            Task { await onSave(trimmed) }
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.accent)
          .controlSize(.small)
          .disabled(busy || !isLive || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      } else {
        Text(steer.text)
          .font(.caption)
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)

        HStack(spacing: 8) {
          Text(relativeTimestamp(steer.timestamp))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
          Spacer(minLength: 0)
          Button {
            onBeginEdit()
          } label: {
            Label("Edit", systemImage: "pencil")
              .labelStyle(.titleAndIcon)
              .font(.caption2.weight(.semibold))
          }
          .buttonStyle(.glass)
          .tint(ADEColor.accent)
          .controlSize(.mini)
          .disabled(busy || !isLive)

          Button(role: .destructive) {
            Task { await onCancel() }
          } label: {
            Label("Cancel", systemImage: "xmark")
              .labelStyle(.titleAndIcon)
              .font(.caption2.weight(.semibold))
          }
          .buttonStyle(.glass)
          .tint(ADEColor.danger)
          .controlSize(.mini)
          .disabled(busy || !isLive)
        }
      }
    }
    .padding(10)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Queued message: \(steer.text)")
  }
}

private struct WorkApprovalRequestCard: View {
  let approval: WorkPendingApprovalModel
  let busy: Bool
  let onDecision: @MainActor (AgentChatApprovalDecision) async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Approval needed")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)

      Text(approval.description)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)

      if let detail = approval.detail, !detail.isEmpty {
        WorkStructuredOutputBlock(title: "Details", text: detail)
      }

      HStack(spacing: 10) {
        Button("Approve") {
          Task { await onDecision(.accept) }
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.success)
        .disabled(busy)

        Button("Approve for session") {
          Task { await onDecision(.acceptForSession) }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.accent)
        .disabled(busy)

        Button("Deny") {
          Task { await onDecision(.decline) }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.danger)
        .disabled(busy)
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }
}

private struct WorkStructuredQuestionCard: View {
  let question: WorkPendingQuestionModel
  @Binding var responseText: String
  let busy: Bool
  let onSelectOption: @MainActor (String) async -> Void
  let onSubmitFreeform: @MainActor () async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Question")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)

      Text(question.question)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)

      if !question.options.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(question.options, id: \.self) { option in
            Button(option) {
              Task { await onSelectOption(option) }
            }
            .buttonStyle(.glass)
            .tint(ADEColor.accent)
            .disabled(busy)
          }
        }
      }

      HStack(alignment: .bottom, spacing: 10) {
        TextField("Optional response", text: $responseText, axis: .vertical)
          .lineLimit(1...4)
          .adeInsetField(cornerRadius: 14, padding: 12)
          .disabled(busy)

        Button("Send") {
          Task { await onSubmitFreeform() }
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(busy || responseText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }
}

private final class WorkArtifactVideoPlayerModel: ObservableObject {
  let player: AVPlayer

  init(url: URL) {
    player = AVPlayer(url: url)
  }

  func update(url: URL) {
    if let currentURL = (player.currentItem?.asset as? AVURLAsset)?.url, currentURL == url {
      return
    }
    player.replaceCurrentItem(with: AVPlayerItem(url: url))
  }
}

private struct WorkArtifactVideoPlayerView: View {
  let url: URL
  @StateObject private var model: WorkArtifactVideoPlayerModel

  init(url: URL) {
    self.url = url
    _model = StateObject(wrappedValue: WorkArtifactVideoPlayerModel(url: url))
  }

  var body: some View {
    VideoPlayer(player: model.player)
      .frame(height: 220)
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .onChange(of: url) { _, newValue in
        model.update(url: newValue)
      }
  }
}

private struct WorkArtifactView: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?
  let onAppear: () -> Void
  let onOpenImage: (UIImage) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: artifact.artifactKind == "video_recording" ? "video.fill" : "photo.fill")
          .foregroundStyle(ADEColor.accent)
        VStack(alignment: .leading, spacing: 3) {
          Text(artifact.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(artifact.artifactKind.replacingOccurrences(of: "_", with: " ").capitalized)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer()
        Text(relativeTimestamp(artifact.createdAt))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      Group {
        switch content {
        case .image(let image):
          Button {
            onOpenImage(image)
          } label: {
            Image(uiImage: image)
              .resizable()
              .scaledToFill()
              .frame(maxWidth: .infinity)
              .frame(height: 180)
              .clipped()
              .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Open artifact image \(artifact.title)")
        case .video(let url):
          WorkArtifactVideoPlayerView(url: url)
        case .remoteURL(let url):
          if artifact.artifactKind == "video_recording" {
            WorkArtifactVideoPlayerView(url: url)
          } else {
            AsyncImage(url: url) { image in
              image
                .resizable()
                .scaledToFill()
            } placeholder: {
              ProgressView()
            }
            .frame(height: 180)
            .frame(maxWidth: .infinity)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          }
        case .text(let text):
          WorkStructuredOutputBlock(title: "Artifact", text: text)
        case .error(let message):
          Text(message)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
        case .none:
          HStack(spacing: 10) {
            ProgressView()
            Text("Loading artifact preview…")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
          .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .task {
      onAppear()
    }
  }
}

private struct WorkTerminalSessionView: View {
  @EnvironmentObject private var syncService: SyncService
  let session: TerminalSessionSummary
  let disconnectedNotice: Bool
  let transitionNamespace: Namespace.ID?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        WorkSessionHeader(
          session: session,
          chatSummary: nil,
          transitionNamespace: transitionNamespace,
          onOpenSettings: nil
        )

        if disconnectedNotice {
          ADENoticeCard(
            title: "Showing cached terminal output",
            message: "Reconnect to resume live ANSI rendering for this session.",
            icon: "wifi.slash",
            tint: ADEColor.warning,
            actionTitle: nil,
            action: nil
          )
        }

        Text(ansiAttributedString(syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? "No output yet."))
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
          .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
          .textSelection(.enabled)
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .task {
      try? await syncService.subscribeTerminal(sessionId: session.id)
    }
  }
}

private struct WorkFullscreenImageView: View {
  @Environment(\.dismiss) private var dismiss
  let image: WorkFullscreenImage

  @State private var scale: CGFloat = 1
  @State private var lastScale: CGFloat = 1

  var body: some View {
    NavigationStack {
      ScrollView([.horizontal, .vertical]) {
        Image(uiImage: image.image)
          .resizable()
          .scaledToFit()
          .scaleEffect(scale)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .padding(24)
          .gesture(
            MagnifyGesture()
              .onChanged { value in
                scale = max(1, min(6, lastScale * value.magnification))
              }
              .onEnded { _ in
                lastScale = scale
              }
          )
      }
      .background(Color.black.ignoresSafeArea())
      .navigationTitle(image.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

private struct WorkInlineMarkdownText: View {
  let text: String

  var body: some View {
    Text(markdownAttributedString(text))
      .foregroundStyle(ADEColor.textPrimary)
      .tint(ADEColor.accent)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkMarkdownRenderer: View {
  let markdown: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(parseMarkdownBlocks(markdown)) { block in
        switch block.kind {
        case .paragraph(let text):
          WorkInlineMarkdownText(text: text)
        case .heading(let level, let text):
          WorkInlineMarkdownText(text: text)
            .font(headingFont(level: level))
        case .unorderedList(let items):
          VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
              HStack(alignment: .top, spacing: 8) {
                Text("•")
                  .foregroundStyle(ADEColor.accent)
                WorkInlineMarkdownText(text: item)
              }
            }
          }
        case .orderedList(let items):
          VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
              HStack(alignment: .top, spacing: 8) {
                Text("\(index + 1).")
                  .foregroundStyle(ADEColor.accent)
                WorkInlineMarkdownText(text: item)
              }
            }
          }
        case .blockquote(let lines):
          HStack(alignment: .top, spacing: 10) {
            Rectangle()
              .fill(ADEColor.accent.opacity(0.55))
              .frame(width: 3)
            VStack(alignment: .leading, spacing: 4) {
              ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                WorkInlineMarkdownText(text: line)
              }
            }
          }
          .padding(10)
          .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        case .table(let headers, let rows):
          WorkMarkdownTable(headers: headers, rows: rows)
        case .code(let language, let code):
          WorkCodeBlockView(language: language, code: code)
        case .rule:
          Divider()
        }
      }
    }
  }

  private func headingFont(level: Int) -> Font {
    switch level {
    case 1: return .title3.weight(.bold)
    case 2: return .headline.weight(.bold)
    default: return .subheadline.weight(.bold)
    }
  }
}

private struct WorkMarkdownTable: View {
  let headers: [String]
  let rows: [[String]]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      VStack(spacing: 0) {
        HStack(spacing: 0) {
          ForEach(headers.indices, id: \.self) { index in
            WorkInlineMarkdownText(text: headers[index])
              .font(.caption.weight(.semibold))
              .padding(10)
              .frame(minWidth: 120, alignment: .leading)
              .background(ADEColor.surfaceBackground.opacity(0.7))
          }
        }
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          Divider()
          HStack(spacing: 0) {
            ForEach(row.indices, id: \.self) { index in
              WorkInlineMarkdownText(text: row[index])
                .font(.caption)
                .padding(10)
                .frame(minWidth: 120, alignment: .leading)
            }
          }
        }
      }
      .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

private struct WorkCodeBlockView: View {
  let language: String?
  let code: String

  private var detectedLanguage: FilesLanguage {
    FilesLanguage.detect(languageId: language, filePath: "snippet.\(language ?? "txt")")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text((language?.isEmpty == false ? language : detectedLanguage.displayName).map { $0.uppercased() } ?? detectedLanguage.displayName.uppercased())
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
        Spacer()
        Button("Copy") {
          UIPasteboard.general.string = code
        }
        .font(.caption2.weight(.semibold))
      }
      ScrollView(.horizontal, showsIndicators: false) {
        Text(SyntaxHighlighter.highlightedAttributedString(code, as: detectedLanguage))
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .padding(12)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.65), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}

struct WorkAgentActivityContext: Equatable {
  let sessionId: String
  let title: String
  let laneName: String
  let status: String
  let startedAt: String
}

struct WorkAgentActivity: Identifiable, Equatable {
  var id: String { "\(sessionId):\(taskId ?? "session")" }
  let sessionId: String
  let taskId: String?
  let agentName: String
  let toolName: String?
  let laneName: String
  let startedAt: String
  let detail: String?
}

enum WorkToolCardStatus: String, Equatable {
  case running
  case completed
  case failed
}

struct WorkToolCardModel: Identifiable, Equatable {
  let id: String
  let toolName: String
  let status: WorkToolCardStatus
  let startedAt: String
  let completedAt: String?
  let argsText: String?
  let resultText: String?
}

struct WorkNavigationTargets: Equatable {
  let filePaths: [String]
  let pullRequestNumbers: [Int]
}

struct WorkChatMessage: Identifiable, Equatable {
  let id: String
  let role: String
  var markdown: String
  let timestamp: String
  let turnId: String?
  let itemId: String?
  var steerId: String? = nil
  var deliveryState: String? = nil
  var processed: Bool? = nil
}

struct WorkLocalEchoMessage: Identifiable, Equatable {
  let id = UUID().uuidString
  let text: String
  let timestamp: String
}

struct WorkPendingApprovalModel: Identifiable, Equatable {
  let id: String
  let description: String
  let detail: String?
}

struct WorkPendingQuestionModel: Identifiable, Equatable {
  let id: String
  let question: String
  let options: [String]
}

struct WorkUsageSummary: Equatable {
  var turnCount: Int
  var inputTokens: Int
  var outputTokens: Int
  var cacheReadTokens: Int
  var cacheCreationTokens: Int
  var costUsd: Double
}

struct WorkCompletionArtifactModel: Equatable {
  let type: String
  let description: String
  let reference: String?
}

struct WorkCommandCardModel: Identifiable, Equatable {
  let id: String
  let command: String
  let cwd: String
  let output: String
  let status: WorkToolCardStatus
  let timestamp: String
  let exitCode: Int?
  let durationMs: Int?
}

struct WorkFileChangeCardModel: Identifiable, Equatable {
  let id: String
  let path: String
  let diff: String
  let kind: String
  let status: WorkToolCardStatus
  let timestamp: String
}

enum WorkTimelinePayload {
  case message(WorkChatMessage)
  case toolCard(WorkToolCardModel)
  case commandCard(WorkCommandCardModel)
  case fileChangeCard(WorkFileChangeCardModel)
  case eventCard(WorkEventCardModel)
  case artifact(ComputerUseArtifactSummary)
}

struct WorkTimelineEntry: Identifiable {
  let id: String
  let timestamp: String
  let rank: Int
  let payload: WorkTimelinePayload
}

struct WorkEventCardModel: Identifiable, Equatable {
  let id: String
  let kind: String
  let title: String
  let icon: String
  let tint: ColorToken
  let timestamp: String
  let body: String?
  let bullets: [String]
  let metadata: [String]
}

enum ColorToken: Equatable {
  case accent
  case success
  case warning
  case danger
  case secondary

  var color: Color {
    switch self {
    case .accent: return ADEColor.accent
    case .success: return ADEColor.success
    case .warning: return ADEColor.warning
    case .danger: return ADEColor.danger
    case .secondary: return ADEColor.textSecondary
    }
  }
}

enum WorkANSIColor: Equatable {
  case red
  case green
  case yellow
  case blue
  case magenta
  case cyan
  case white
  case black
}

struct ANSISegment: Equatable {
  let text: String
  let foreground: WorkANSIColor?
  let bold: Bool
}

struct WorkFullscreenImage: Identifiable {
  let id = UUID().uuidString
  let title: String
  let image: UIImage
}

enum WorkLoadedArtifactContent {
  case image(UIImage)
  case video(URL)
  case remoteURL(URL)
  case text(String)
  case error(String)
}

struct WorkChatEnvelope: Identifiable, Equatable {
  var id: String { "\(sessionId):\(sequence ?? -1):\(timestamp):\(event.typeKey)" }
  let sessionId: String
  let timestamp: String
  let sequence: Int?
  let event: WorkChatEvent
}

enum WorkChatEvent: Equatable {
  case userMessage(text: String, turnId: String?, steerId: String?, deliveryState: String?, processed: Bool?)
  case assistantText(text: String, turnId: String?, itemId: String?)
  case toolCall(tool: String, argsText: String, itemId: String, parentItemId: String?, turnId: String?)
  case toolResult(tool: String, resultText: String, itemId: String, parentItemId: String?, turnId: String?, status: WorkToolCardStatus)
  case activity(kind: String, detail: String?, turnId: String?)
  case plan(steps: [String], explanation: String?, turnId: String?)
  case subagentStarted(taskId: String, description: String, background: Bool, turnId: String?)
  case subagentProgress(taskId: String, description: String?, summary: String, toolName: String?, turnId: String?)
  case subagentResult(taskId: String, status: String, summary: String, turnId: String?)
  case structuredQuestion(question: String, options: [String], itemId: String, turnId: String?)
  case approvalRequest(description: String, detail: String?, itemId: String, turnId: String?)
  case pendingInputResolved(itemId: String, resolution: String, turnId: String?)
  case todoUpdate(items: [String], turnId: String?)
  case systemNotice(kind: String, message: String, detail: String?, turnId: String?, steerId: String?)
  case error(message: String, detail: String?, category: String, turnId: String?)
  case done(status: String, summary: String, usage: WorkUsageSummary?, turnId: String)
  case promptSuggestion(text: String, turnId: String?)
  case contextCompact(summary: String, turnId: String?)
  case autoApprovalReview(summary: String, turnId: String?)
  case webSearch(query: String, action: String?, status: WorkToolCardStatus, itemId: String, turnId: String?)
  case planText(text: String, turnId: String?)
  case toolUseSummary(text: String, turnId: String?)
  case status(turnStatus: String, message: String?, turnId: String?)
  case reasoning(text: String, turnId: String?)
  case completionReport(summary: String, status: String, artifacts: [WorkCompletionArtifactModel], blockerDescription: String?, turnId: String?)
  case command(command: String, cwd: String, output: String, status: WorkToolCardStatus, itemId: String, exitCode: Int?, durationMs: Int?, turnId: String?)
  case fileChange(path: String, diff: String, kind: String, status: WorkToolCardStatus, itemId: String, turnId: String?)
  case unknown(type: String)

  var typeKey: String {
    switch self {
    case .userMessage: return "user_message"
    case .assistantText: return "text"
    case .toolCall: return "tool_call"
    case .toolResult: return "tool_result"
    case .activity: return "activity"
    case .plan: return "plan"
    case .subagentStarted: return "subagent_started"
    case .subagentProgress: return "subagent_progress"
    case .subagentResult: return "subagent_result"
    case .structuredQuestion: return "structured_question"
    case .approvalRequest: return "approval_request"
    case .pendingInputResolved: return "pending_input_resolved"
    case .todoUpdate: return "todo_update"
    case .systemNotice: return "system_notice"
    case .error: return "error"
    case .done: return "done"
    case .promptSuggestion: return "prompt_suggestion"
    case .contextCompact: return "context_compact"
    case .autoApprovalReview: return "auto_approval_review"
    case .webSearch: return "web_search"
    case .planText: return "plan_text"
    case .toolUseSummary: return "tool_use_summary"
    case .status: return "status"
    case .reasoning: return "reasoning"
    case .completionReport: return "completion_report"
    case .command: return "command"
    case .fileChange: return "file_change"
    case .unknown(let type): return type
    }
  }
}

func parseWorkChatTranscript(_ raw: String) -> [WorkChatEnvelope] {
  extractLooseJSONObjects(from: raw)
    .compactMap { chunk -> WorkChatEnvelope? in
      let normalizedChunk = sanitizeLooseJSONControlCharacters(in: chunk)
      guard let data = normalizedChunk.data(using: .utf8),
            let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let sessionId = envelope["sessionId"] as? String,
            let timestamp = envelope["timestamp"] as? String,
            let eventDict = envelope["event"] as? [String: Any],
            let type = eventDict["type"] as? String
      else {
        return nil
      }

      let sequence = envelope["sequence"] as? Int
      let turnId = eventDict["turnId"] as? String
      let itemId = eventDict["itemId"] as? String
      let parentItemId = eventDict["parentItemId"] as? String
      let event: WorkChatEvent

      switch type {
      case "user_message":
        event = .userMessage(
          text: stringValue(eventDict["text"]),
          turnId: turnId,
          steerId: optionalString(eventDict["steerId"]),
          deliveryState: optionalString(eventDict["deliveryState"]),
          processed: eventDict["processed"] as? Bool
        )
      case "text":
        event = .assistantText(text: stringValue(eventDict["text"]), turnId: turnId, itemId: itemId)
      case "tool_call":
        event = .toolCall(
          tool: stringValue(eventDict["tool"]),
          argsText: prettyPrintedJSONString(eventDict["args"]),
          itemId: itemId ?? UUID().uuidString,
          parentItemId: parentItemId,
          turnId: turnId
        )
      case "tool_result":
        event = .toolResult(
          tool: stringValue(eventDict["tool"]),
          resultText: prettyPrintedJSONString(eventDict["result"]),
          itemId: itemId ?? UUID().uuidString,
          parentItemId: parentItemId,
          turnId: turnId,
          status: toolStatus(from: stringValue(eventDict["status"]))
        )
      case "activity":
        event = .activity(kind: stringValue(eventDict["activity"]), detail: optionalString(eventDict["detail"]), turnId: turnId)
      case "plan":
        let steps = (eventDict["steps"] as? [[String: Any]] ?? []).map { step in
          let status = stringValue(step["status"]).replacingOccurrences(of: "_", with: " ").capitalized
          let description = stringValue(step["description"])
          return description.isEmpty ? status : "\(status): \(description)"
        }
        event = .plan(steps: steps, explanation: optionalString(eventDict["explanation"]), turnId: turnId)
      case "subagent_started":
        event = .subagentStarted(
          taskId: stringValue(eventDict["taskId"]),
          description: stringValue(eventDict["description"]),
          background: (eventDict["background"] as? Bool) ?? false,
          turnId: turnId
        )
      case "subagent_progress":
        event = .subagentProgress(
          taskId: stringValue(eventDict["taskId"]),
          description: optionalString(eventDict["description"]),
          summary: stringValue(eventDict["summary"]),
          toolName: optionalString(eventDict["lastToolName"]),
          turnId: turnId
        )
      case "subagent_result":
        event = .subagentResult(
          taskId: stringValue(eventDict["taskId"]),
          status: stringValue(eventDict["status"]),
          summary: stringValue(eventDict["summary"]),
          turnId: turnId
        )
      case "status":
        event = .status(turnStatus: stringValue(eventDict["turnStatus"]), message: optionalString(eventDict["message"]), turnId: turnId)
      case "reasoning":
        event = .reasoning(text: stringValue(eventDict["text"]), turnId: turnId)
      case "approval_request":
        event = .approvalRequest(
          description: stringValue(eventDict["description"]),
          detail: optionalString(prettyPrintedJSONString(eventDict["detail"])),
          itemId: itemId ?? UUID().uuidString,
          turnId: turnId
        )
      case "pending_input_resolved":
        event = .pendingInputResolved(
          itemId: itemId ?? UUID().uuidString,
          resolution: stringValue(eventDict["resolution"]),
          turnId: turnId
        )
      case "structured_question":
        let options = (eventDict["options"] as? [[String: Any]] ?? []).compactMap { optionalString($0["label"]) ?? optionalString($0["value"]) }
        event = .structuredQuestion(
          question: stringValue(eventDict["question"]),
          options: options,
          itemId: itemId ?? UUID().uuidString,
          turnId: turnId
        )
      case "todo_update":
        let items = (eventDict["items"] as? [[String: Any]] ?? []).map { item in
          let status = stringValue(item["status"]).replacingOccurrences(of: "_", with: " ").capitalized
          let description = stringValue(item["description"])
          return description.isEmpty ? status : "\(status): \(description)"
        }
        event = .todoUpdate(items: items, turnId: turnId)
      case "system_notice":
        event = .systemNotice(
          kind: stringValue(eventDict["noticeKind"]),
          message: stringValue(eventDict["message"]),
          detail: optionalString(prettyPrintedJSONString(eventDict["detail"])),
          turnId: turnId,
          steerId: optionalString(eventDict["steerId"])
        )
      case "error":
        let detailText = optionalString(prettyPrintedJSONString(eventDict["errorInfo"]))
        event = .error(
          message: stringValue(eventDict["message"]),
          detail: detailText,
          category: workErrorCategory(message: stringValue(eventDict["message"]), detail: detailText),
          turnId: turnId
        )
      case "done":
        let usage = prettyPrintedJSONString(eventDict["usage"])
        let cost = eventDict["costUsd"] as? NSNumber
        var summaryParts: [String] = []
        if let status = optionalString(eventDict["status"]) {
          summaryParts.append(status.replacingOccurrences(of: "_", with: " ").capitalized)
        }
        if let model = optionalString(eventDict["model"]) {
          summaryParts.append(model)
        }
        if !usage.isEmpty {
          summaryParts.append(usage)
        }
        if let cost {
          summaryParts.append(String(format: "$%.4f", cost.doubleValue))
        }
        let usageSummary = makeWorkUsageSummary(
          inputTokens: eventDict["usage"].flatMap { value in
            (value as? [String: Any])?["inputTokens"] as? Int
          },
          outputTokens: eventDict["usage"].flatMap { value in
            (value as? [String: Any])?["outputTokens"] as? Int
          },
          cacheReadTokens: eventDict["usage"].flatMap { value in
            (value as? [String: Any])?["cacheReadTokens"] as? Int
          },
          cacheCreationTokens: eventDict["usage"].flatMap { value in
            (value as? [String: Any])?["cacheCreationTokens"] as? Int
          },
          costUsd: cost?.doubleValue
        )
        event = .done(
          status: stringValue(eventDict["status"]),
          summary: summaryParts.joined(separator: "\n"),
          usage: usageSummary,
          turnId: stringValue(eventDict["turnId"])
        )
      case "completion_report":
        let report = eventDict["report"] as? [String: Any] ?? [:]
        let artifacts = (report["artifacts"] as? [[String: Any]] ?? []).map { artifact in
          WorkCompletionArtifactModel(
            type: stringValue(artifact["type"]),
            description: stringValue(artifact["description"]),
            reference: optionalString(artifact["reference"])
          )
        }
        event = .completionReport(
          summary: stringValue(report["summary"]),
          status: stringValue(report["status"]),
          artifacts: artifacts,
          blockerDescription: optionalString(report["blockerDescription"]),
          turnId: turnId
        )
      case "prompt_suggestion":
        event = .promptSuggestion(text: stringValue(eventDict["suggestion"]), turnId: turnId)
      case "context_compact":
        let trigger = stringValue(eventDict["trigger"]).replacingOccurrences(of: "_", with: " ").capitalized
        let preTokens = optionalString(eventDict["preTokens"])
        event = .contextCompact(summary: [trigger, preTokens.map { "Pre-compact tokens: \($0)" }].compactMap { $0 }.joined(separator: "\n"), turnId: turnId)
      case "auto_approval_review":
        let action = optionalString(eventDict["action"])
        let review = optionalString(eventDict["review"])
        let status = stringValue(eventDict["reviewStatus"]).replacingOccurrences(of: "_", with: " ").capitalized
        event = .autoApprovalReview(summary: [status, action, review].compactMap { $0 }.joined(separator: "\n"), turnId: turnId)
      case "web_search":
        event = .webSearch(
          query: stringValue(eventDict["query"]),
          action: optionalString(eventDict["action"]),
          status: toolStatus(from: stringValue(eventDict["status"])),
          itemId: itemId ?? UUID().uuidString,
          turnId: turnId
        )
      case "plan_text":
        event = .planText(text: stringValue(eventDict["text"]), turnId: turnId)
      case "tool_use_summary":
        event = .toolUseSummary(text: stringValue(eventDict["summary"]), turnId: turnId)
      case "command":
        event = .command(
          command: stringValue(eventDict["command"]),
          cwd: stringValue(eventDict["cwd"]),
          output: stringValue(eventDict["output"]),
          status: toolStatus(from: stringValue(eventDict["status"])),
          itemId: itemId ?? UUID().uuidString,
          exitCode: eventDict["exitCode"] as? Int,
          durationMs: eventDict["durationMs"] as? Int,
          turnId: turnId
        )
      case "file_change":
        event = .fileChange(
          path: stringValue(eventDict["path"]),
          diff: stringValue(eventDict["diff"]),
          kind: stringValue(eventDict["kind"]),
          status: toolStatus(from: stringValue(eventDict["status"])),
          itemId: itemId ?? UUID().uuidString,
          turnId: turnId
        )
      default:
        event = .unknown(type: type)
      }

      return WorkChatEnvelope(sessionId: sessionId, timestamp: timestamp, sequence: sequence, event: event)
    }
    .sorted { lhs, rhs in
      if lhs.timestamp == rhs.timestamp {
        return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
      }
      return lhs.timestamp < rhs.timestamp
    }
}

private func extractLooseJSONObjects(from raw: String) -> [String] {
  var objects: [String] = []
  var buffer = ""
  var depth = 0
  var insideString = false
  var escaping = false

  for character in raw {
    if depth == 0 {
      guard character == "{" else { continue }
      depth = 1
      buffer = "{" 
      insideString = false
      escaping = false
      continue
    }

    buffer.append(character)

    if insideString {
      if escaping {
        escaping = false
      } else if character == "\\" {
        escaping = true
      } else if character == "\"" {
        insideString = false
      }
      continue
    }

    if character == "\"" {
      insideString = true
    } else if character == "{" {
      depth += 1
    } else if character == "}" {
      depth -= 1
      if depth == 0 {
        objects.append(buffer)
        buffer = ""
      }
    }
  }

  return objects
}

private func sanitizeLooseJSONControlCharacters(in raw: String) -> String {
  var sanitized = ""
  var insideString = false
  var escaping = false

  for character in raw {
    if insideString {
      if escaping {
        sanitized.append(character)
        escaping = false
        continue
      }

      switch character {
      case "\\":
        sanitized.append(character)
        escaping = true
      case "\"":
        sanitized.append(character)
        insideString = false
      case "\n":
        sanitized.append("\\n")
      case "\r":
        sanitized.append("\\r")
      case "\t":
        sanitized.append("\\t")
      default:
        sanitized.append(character)
      }
      continue
    }

    sanitized.append(character)
    if character == "\"" {
      insideString = true
    }
  }

  return sanitized
}

func extractWorkNavigationTargets(from text: String) -> WorkNavigationTargets {
  let filePattern = #"(?<![A-Za-z0-9_])(?:\.{1,2}/)?(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\.(?:swift|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|json|yaml|yml|toml|md|mdx|txt|html|css|scss|sql|sh|bash|zsh|plist|png|jpg|jpeg|gif|webp|svg)(?::\d+)?"#
  let prPattern = #"(?<![A-Za-z0-9])#(\d+)\b"#

  var filePaths: [String] = []
  var seenFiles = Set<String>()
  for match in workRegexMatches(pattern: filePattern, in: text) {
    guard let normalized = normalizedWorkReferenceFilePath(match), seenFiles.insert(normalized).inserted else { continue }
    filePaths.append(normalized)
  }

  var pullRequestNumbers: [Int] = []
  var seenPullRequests = Set<Int>()
  for match in workRegexMatches(pattern: prPattern, in: text) {
    guard let number = Int(match.dropFirst()), seenPullRequests.insert(number).inserted else { continue }
    pullRequestNumbers.append(number)
  }

  return WorkNavigationTargets(filePaths: filePaths, pullRequestNumbers: pullRequestNumbers)
}

private func workRegexMatches(pattern: String, in text: String) -> [String] {
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
  let range = NSRange(location: 0, length: (text as NSString).length)
  return regex.matches(in: text, range: range).compactMap { match in
    Range(match.range, in: text).map { String(text[$0]) }
  }
}

private func normalizedWorkReferenceFilePath(_ rawPath: String) -> String? {
  var candidate = rawPath.trimmingCharacters(in: CharacterSet(charactersIn: "\"'`()[]{}<>,"))
  guard !candidate.isEmpty else { return nil }
  guard !candidate.contains("://") else { return nil }

  if let lineNumberRange = candidate.range(of: #":\d+$"#, options: .regularExpression) {
    candidate.removeSubrange(lineNumberRange)
  }

  if candidate.hasPrefix("./") {
    candidate.removeFirst(2)
  }

  guard !candidate.hasPrefix("../") else { return nil }
  return candidate
}

func normalizeWorkFileReference(_ rawPath: String, workspaceRoot: String, requestedCwd: String? = nil) -> String {
  guard let normalized = normalizedWorkReferenceFilePath(rawPath) else { return "" }
  let root = workspaceRoot.hasSuffix("/") ? String(workspaceRoot.dropLast()) : workspaceRoot

  func normalizedRequestedCwdPath() -> String? {
    guard let requestedCwd else { return nil }
    let trimmed = requestedCwd.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if trimmed.hasPrefix(root + "/") {
      return String(trimmed.dropFirst(root.count + 1))
    }
    if trimmed.hasPrefix("/") {
      return nil
    }
    return trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  }

  if normalized.hasPrefix(root + "/") {
    return String(normalized.dropFirst(root.count + 1))
  }

  if normalized.hasPrefix("/") {
    return ""
  }

  if let requestedCwdPath = normalizedRequestedCwdPath(), !requestedCwdPath.isEmpty {
    let baseURL = URL(fileURLWithPath: requestedCwdPath, isDirectory: true)
    let resolvedURL = baseURL.appendingPathComponent(normalized).standardizedFileURL
    let resolvedPath = resolvedURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if resolvedPath.isEmpty || resolvedPath.hasPrefix("../") || resolvedPath.contains("/../") {
      return ""
    }
    return resolvedPath
  }

  return normalized
}

private func workReferenceLabel(for path: String) -> String {
  let normalized = normalizedWorkReferenceFilePath(path) ?? path
  let lastComponent = (normalized as NSString).lastPathComponent
  return lastComponent.isEmpty ? normalized : lastComponent
}

func buildWorkToolCards(from transcript: [WorkChatEnvelope]) -> [WorkToolCardModel] {
  var cards: [String: WorkToolCardModel] = [:]
  var orderedIds: [String] = []

  for envelope in transcript {
    switch envelope.event {
    case .toolCall(let tool, let argsText, let itemId, _, _):
      if cards[itemId] == nil {
        orderedIds.append(itemId)
      }
      cards[itemId] = WorkToolCardModel(
        id: itemId,
        toolName: tool,
        status: .running,
        startedAt: envelope.timestamp,
        completedAt: nil,
        argsText: argsText,
        resultText: cards[itemId]?.resultText
      )
    case .toolResult(let tool, let resultText, let itemId, _, _, let status):
      let existing = cards[itemId]
      if existing == nil {
        orderedIds.append(itemId)
      }
      cards[itemId] = WorkToolCardModel(
        id: itemId,
        toolName: existing?.toolName ?? tool,
        status: status,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        completedAt: envelope.timestamp,
        argsText: existing?.argsText,
        resultText: resultText
      )
    default:
      continue
    }
  }

  return orderedIds.compactMap { cards[$0] }
}

func deriveWorkAgentActivities(from transcript: [WorkChatEnvelope], session: WorkAgentActivityContext) -> [WorkAgentActivity] {
  var activeSubagents: [String: WorkAgentActivity] = [:]
  let toolCards = buildWorkToolCards(from: transcript)
  let runningTool = toolCards.last(where: { $0.status == .running })

  for envelope in transcript {
    switch envelope.event {
    case .subagentStarted(let taskId, let description, _, _):
      activeSubagents[taskId] = WorkAgentActivity(
        sessionId: session.sessionId,
        taskId: taskId,
        agentName: description.isEmpty ? session.title : description,
        toolName: nil,
        laneName: session.laneName,
        startedAt: envelope.timestamp,
        detail: nil
      )
    case .subagentProgress(let taskId, let description, let summary, let toolName, _):
      let existing = activeSubagents[taskId]
      activeSubagents[taskId] = WorkAgentActivity(
        sessionId: session.sessionId,
        taskId: taskId,
        agentName: description ?? existing?.agentName ?? session.title,
        toolName: toolName ?? existing?.toolName,
        laneName: session.laneName,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        detail: summary
      )
    case .subagentResult(let taskId, _, _, _):
      activeSubagents.removeValue(forKey: taskId)
    default:
      continue
    }
  }

  let subagents = activeSubagents.values.sorted { $0.startedAt > $1.startedAt }
  if !subagents.isEmpty {
    return subagents
  }

  guard session.status == "active" else { return [] }
  let latestActivityDetail = transcript.reversed().compactMap { envelope -> String? in
    switch envelope.event {
    case .activity(_, let detail, _): return detail
    case .reasoning(let text, _): return text
    case .status(_, let message, _): return message
    default: return nil
    }
  }.first

  return [WorkAgentActivity(
    sessionId: session.sessionId,
    taskId: nil,
    agentName: session.title,
    toolName: runningTool?.toolName,
    laneName: session.laneName,
    startedAt: runningTool?.startedAt ?? session.startedAt,
    detail: latestActivityDetail
  )]
}

func parseANSISegments(_ input: String) -> [ANSISegment] {
  var segments: [ANSISegment] = []
  var buffer = ""
  var foreground: WorkANSIColor?
  var bold = false
  var index = input.startIndex

  func flush() {
    guard !buffer.isEmpty else { return }
    segments.append(ANSISegment(text: buffer, foreground: foreground, bold: bold))
    buffer = ""
  }

  while index < input.endIndex {
    let character = input[index]
    if character == "\u{001B}" {
      let next = input.index(after: index)
      guard next < input.endIndex, input[next] == "[" else {
        buffer.append(character)
        index = input.index(after: index)
        continue
      }
      guard let commandIndex = input[next...].firstIndex(of: "m") else {
        break
      }
      flush()
      let codeString = String(input[input.index(after: next)..<commandIndex])
      let codes = codeString.split(separator: ";").compactMap { Int($0) }
      if codes.isEmpty {
        foreground = nil
        bold = false
      }
      for code in codes {
        switch code {
        case 0:
          foreground = nil
          bold = false
        case 1:
          bold = true
        case 30, 90:
          foreground = .black
        case 31, 91:
          foreground = .red
        case 32, 92:
          foreground = .green
        case 33, 93:
          foreground = .yellow
        case 34, 94:
          foreground = .blue
        case 35, 95:
          foreground = .magenta
        case 36, 96:
          foreground = .cyan
        case 37, 97:
          foreground = .white
        case 39:
          foreground = nil
        case 22:
          bold = false
        default:
          continue
        }
      }
      index = input.index(after: commandIndex)
      continue
    }
    buffer.append(character)
    index = input.index(after: index)
  }

  flush()
  return segments
}

private enum WorkMarkdownBlockKind {
  case paragraph(String)
  case heading(Int, String)
  case unorderedList([String])
  case orderedList([String])
  case blockquote([String])
  case table(headers: [String], rows: [[String]])
  case code(language: String?, code: String)
  case rule
}

private struct WorkMarkdownBlock: Identifiable {
  let id = UUID().uuidString
  let kind: WorkMarkdownBlockKind
}

private func parseMarkdownBlocks(_ markdown: String) -> [WorkMarkdownBlock] {
  let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  var index = 0
  var blocks: [WorkMarkdownBlock] = []

  func appendParagraph(_ lines: [String]) {
    let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
      blocks.append(WorkMarkdownBlock(kind: .paragraph(text)))
    }
  }

  while index < lines.count {
    let line = lines[index]
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    if trimmed.isEmpty {
      index += 1
      continue
    }

    if trimmed.hasPrefix("```") {
      let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
      index += 1
      var codeLines: [String] = []
      while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
        codeLines.append(lines[index])
        index += 1
      }
      if index < lines.count { index += 1 }
      blocks.append(WorkMarkdownBlock(kind: .code(language: language.isEmpty ? nil : language, code: codeLines.joined(separator: "\n"))))
      continue
    }

    if let heading = trimmed.firstIndex(where: { $0 != "#" }), heading > trimmed.startIndex, trimmed[..<heading].allSatisfy({ $0 == "#" }) {
      let level = trimmed[..<heading].count
      let text = trimmed[heading...].trimmingCharacters(in: .whitespaces)
      blocks.append(WorkMarkdownBlock(kind: .heading(level, text)))
      index += 1
      continue
    }

    if ["---", "***", "___"].contains(trimmed) {
      blocks.append(WorkMarkdownBlock(kind: .rule))
      index += 1
      continue
    }

    if trimmed.hasPrefix(">") {
      var quoteLines: [String] = []
      while index < lines.count {
        let value = lines[index].trimmingCharacters(in: .whitespaces)
        guard value.hasPrefix(">") else { break }
        quoteLines.append(String(value.dropFirst()).trimmingCharacters(in: .whitespaces))
        index += 1
      }
      blocks.append(WorkMarkdownBlock(kind: .blockquote(quoteLines)))
      continue
    }

    if isMarkdownTableHeader(lines: lines, index: index) {
      let headers = splitMarkdownTableRow(lines[index])
      index += 2
      var rows: [[String]] = []
      while index < lines.count, lines[index].contains("|") {
        rows.append(splitMarkdownTableRow(lines[index]))
        index += 1
      }
      blocks.append(WorkMarkdownBlock(kind: .table(headers: headers, rows: rows)))
      continue
    }

    if let unordered = parseList(startingAt: index, in: lines, ordered: false) {
      blocks.append(WorkMarkdownBlock(kind: .unorderedList(unordered.items)))
      index = unordered.nextIndex
      continue
    }

    if let ordered = parseList(startingAt: index, in: lines, ordered: true) {
      blocks.append(WorkMarkdownBlock(kind: .orderedList(ordered.items)))
      index = ordered.nextIndex
      continue
    }

    var paragraphLines: [String] = []
    while index < lines.count {
      let value = lines[index].trimmingCharacters(in: .whitespaces)
      if value.isEmpty || value.hasPrefix("```") || value.hasPrefix(">") || isMarkdownTableHeader(lines: lines, index: index) || parseList(startingAt: index, in: lines, ordered: false) != nil || parseList(startingAt: index, in: lines, ordered: true) != nil || ["---", "***", "___"].contains(value) {
        break
      }
      if value.hasPrefix("#") { break }
      paragraphLines.append(lines[index])
      index += 1
    }
    appendParagraph(paragraphLines)
  }

  return blocks
}

private func parseList(startingAt index: Int, in lines: [String], ordered: Bool) -> (items: [String], nextIndex: Int)? {
  guard index < lines.count else { return nil }
  let pattern = ordered ? #"^\d+\.\s+"# : #"^[-*+]\s+"#
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
  var cursor = index
  var items: [String] = []
  while cursor < lines.count {
    let line = lines[cursor].trimmingCharacters(in: .whitespaces)
    let range = NSRange(location: 0, length: (line as NSString).length)
    guard let match = regex.firstMatch(in: line, options: [], range: range) else { break }
    let item = (line as NSString).substring(from: match.range.length)
    items.append(item)
    cursor += 1
  }
  return items.isEmpty ? nil : (items, cursor)
}

private func isMarkdownTableHeader(lines: [String], index: Int) -> Bool {
  guard index + 1 < lines.count else { return false }
  let header = lines[index]
  let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)
  return header.contains("|") && separator.contains("|") && separator.replacingOccurrences(of: "|", with: "").allSatisfy { $0 == "-" || $0 == ":" || $0 == " " }
}

private func splitMarkdownTableRow(_ row: String) -> [String] {
  row
    .split(separator: "|", omittingEmptySubsequences: false)
    .map { $0.trimmingCharacters(in: .whitespaces) }
    .filter { !$0.isEmpty }
}

private func markdownAttributedString(_ text: String) -> AttributedString {
  if let attributed = try? AttributedString(markdown: text) {
    return attributed
  }
  return AttributedString(text)
}

private func buildWorkTimeline(
  transcript: [WorkChatEnvelope],
  fallbackEntries: [AgentChatTranscriptEntry],
  toolCards: [WorkToolCardModel],
  commandCards: [WorkCommandCardModel],
  fileChangeCards: [WorkFileChangeCardModel],
  eventCards: [WorkEventCardModel],
  artifacts: [ComputerUseArtifactSummary],
  localEchoMessages: [WorkLocalEchoMessage]
) -> [WorkTimelineEntry] {
  let messages = transcript.isEmpty && !fallbackEntries.isEmpty
    ? fallbackEntries.map {
        WorkChatMessage(
          id: "fallback-\($0.id)",
          role: $0.role,
          markdown: $0.text,
          timestamp: $0.timestamp,
          turnId: $0.turnId,
          itemId: nil
        )
      }
    : buildWorkChatMessages(from: transcript)

  var entries: [WorkTimelineEntry] = messages.enumerated().map { index, message in
    WorkTimelineEntry(id: "message-\(message.id)", timestamp: message.timestamp, rank: index, payload: .message(message))
  }

  entries.append(contentsOf: toolCards.enumerated().map { index, card in
    WorkTimelineEntry(id: "tool-\(card.id)", timestamp: card.startedAt, rank: 1_000 + index, payload: .toolCard(card))
  })

  entries.append(contentsOf: commandCards.enumerated().map { index, card in
    WorkTimelineEntry(id: "command-\(card.id)", timestamp: card.timestamp, rank: 1_250 + index, payload: .commandCard(card))
  })

  entries.append(contentsOf: fileChangeCards.enumerated().map { index, card in
    WorkTimelineEntry(id: "file-change-\(card.id)", timestamp: card.timestamp, rank: 1_375 + index, payload: .fileChangeCard(card))
  })

  entries.append(contentsOf: eventCards.enumerated().map { index, card in
    WorkTimelineEntry(id: "event-\(card.id)", timestamp: card.timestamp, rank: 1_500 + index, payload: .eventCard(card))
  })

  entries.append(contentsOf: artifacts.enumerated().map { index, artifact in
    WorkTimelineEntry(id: "artifact-\(artifact.id)", timestamp: artifact.createdAt, rank: 2_000 + index, payload: .artifact(artifact))
  })

  entries.append(contentsOf: localEchoMessages.enumerated().map { index, echo in
    let message = WorkChatMessage(id: echo.id, role: "user", markdown: echo.text, timestamp: echo.timestamp, turnId: nil, itemId: nil)
    return WorkTimelineEntry(id: "echo-\(echo.id)", timestamp: echo.timestamp, rank: 3_000 + index, payload: .message(message))
  })

  return entries.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return lhs.rank < rhs.rank
    }
    return lhs.timestamp < rhs.timestamp
  }
}

private func buildWorkCommandCards(from transcript: [WorkChatEnvelope]) -> [WorkCommandCardModel] {
  transcript.compactMap { envelope in
    guard case .command(let command, let cwd, let output, let status, let itemId, let exitCode, let durationMs, _) = envelope.event else {
      return nil
    }
    return WorkCommandCardModel(
      id: itemId,
      command: command,
      cwd: cwd,
      output: output,
      status: status,
      timestamp: envelope.timestamp,
      exitCode: exitCode,
      durationMs: durationMs
    )
  }
}

private func buildWorkFileChangeCards(from transcript: [WorkChatEnvelope]) -> [WorkFileChangeCardModel] {
  transcript.compactMap { envelope in
    guard case .fileChange(let path, let diff, let kind, let status, let itemId, _) = envelope.event else {
      return nil
    }
    return WorkFileChangeCardModel(
      id: itemId,
      path: path,
      diff: diff,
      kind: kind,
      status: status,
      timestamp: envelope.timestamp
    )
  }
}

private func buildWorkEventCards(from transcript: [WorkChatEnvelope]) -> [WorkEventCardModel] {
  transcript.compactMap { envelope in
    switch envelope.event {
    case .activity(let kind, let detail, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "activity",
        title: activityTitle(for: kind),
        icon: "bolt.horizontal.circle.fill",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: detail,
        bullets: [],
        metadata: [kind.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    case .plan(let steps, let explanation, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "plan",
        title: "Plan",
        icon: "list.bullet.clipboard",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: explanation,
        bullets: steps,
        metadata: []
      )
    case .reasoning(let text, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "reasoning",
        title: "Reasoning",
        icon: "brain.head.profile",
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: text,
        bullets: [],
        metadata: []
      )
    case .approvalRequest(let description, let detail, _, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "approval",
        title: "Approval needed",
        icon: "checkmark.shield",
        tint: .warning,
        timestamp: envelope.timestamp,
        body: description,
        bullets: detail.map { [$0] } ?? [],
        metadata: []
      )
    case .pendingInputResolved(_, let resolution, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "pendingInputResolved",
        title: "Input resolved",
        icon: pendingInputResolutionIcon(for: resolution),
        tint: pendingInputResolutionTint(for: resolution),
        timestamp: envelope.timestamp,
        body: nil,
        bullets: [],
        metadata: [pendingInputResolutionLabel(for: resolution)]
      )
    case .structuredQuestion(let question, let options, _, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "question",
        title: "Question",
        icon: "questionmark.circle",
        tint: .warning,
        timestamp: envelope.timestamp,
        body: question,
        bullets: options,
        metadata: []
      )
    case .todoUpdate(let items, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "todo",
        title: "Todo update",
        icon: "checklist",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: nil,
        bullets: items,
        metadata: []
      )
    case .systemNotice(let kind, let message, let detail, _, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "notice",
        title: noticeTitle(for: kind),
        icon: noticeIcon(for: kind),
        tint: noticeTint(for: kind),
        timestamp: envelope.timestamp,
        body: message,
        bullets: detail.map { [$0] } ?? [],
        metadata: [kind.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    case .error(let message, let detail, let category, _):
      let errorStyle = errorPresentation(for: category)
      return WorkEventCardModel(
        id: envelope.id,
        kind: "error",
        title: errorStyle.title,
        icon: errorStyle.icon,
        tint: errorStyle.tint,
        timestamp: envelope.timestamp,
        body: message,
        bullets: detail.map { [$0] } ?? [],
        metadata: [category.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    case .done(let status, let summary, _, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "done",
        title: "Turn finished",
        icon: status == "completed" ? "checkmark.circle.fill" : status == "failed" ? "xmark.circle.fill" : "pause.circle.fill",
        tint: status == "completed" ? .success : status == "failed" ? .danger : .warning,
        timestamp: envelope.timestamp,
        body: summary.isEmpty ? nil : summary,
        bullets: [],
        metadata: [status.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    case .promptSuggestion(let text, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "promptSuggestion",
        title: "Suggested next prompt",
        icon: "lightbulb",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: text,
        bullets: [],
        metadata: []
      )
    case .contextCompact(let summary, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "contextCompact",
        title: "Context compacted",
        icon: "rectangle.compress.vertical",
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: summary,
        bullets: [],
        metadata: []
      )
    case .autoApprovalReview(let summary, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "autoApproval",
        title: "Auto-approval review",
        icon: "shield.lefthalf.filled",
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: summary,
        bullets: [],
        metadata: []
      )
    case .webSearch(let query, let action, let status, _, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "webSearch",
        title: "Web search",
        icon: "globe",
        tint: status == .failed ? .danger : status == .completed ? .success : .warning,
        timestamp: envelope.timestamp,
        body: query,
        bullets: action.map { [$0] } ?? [],
        metadata: [status.rawValue.capitalized]
      )
    case .planText(let text, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "planText",
        title: "Plan detail",
        icon: "text.alignleft",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: text,
        bullets: [],
        metadata: []
      )
    case .toolUseSummary(let text, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "toolUseSummary",
        title: "Tool use summary",
        icon: "hammer.circle",
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: text,
        bullets: [],
        metadata: []
      )
    case .status(let turnStatus, let message, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "status",
        title: "Turn status",
        icon: workChatStatusIcon(turnStatus == "started" ? "active" : turnStatus == "completed" ? "ended" : "idle"),
        tint: turnStatus == "completed" ? .success : turnStatus == "failed" ? .danger : .warning,
        timestamp: envelope.timestamp,
        body: message,
        bullets: [],
        metadata: [turnStatus.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    case .completionReport(let summary, let status, let artifacts, let blockerDescription, _):
      let artifactBullets = artifacts.map { artifact in
        [artifact.type.capitalized, artifact.description, artifact.reference].compactMap { value in
          guard let value, !value.isEmpty else { return nil }
          return value
        }.joined(separator: " · ")
      }
      return WorkEventCardModel(
        id: envelope.id,
        kind: "completionReport",
        title: "Completion report",
        icon: "doc.text.magnifyingglass",
        tint: status == "completed" ? .success : status == "blocked" ? .warning : .secondary,
        timestamp: envelope.timestamp,
        body: [summary, blockerDescription].compactMap { value in
          guard let value, !value.isEmpty else { return nil }
          return value
        }.joined(separator: "\n\n"),
        bullets: artifactBullets,
        metadata: [status.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    default:
      return nil
    }
  }
}

let workTimelinePageSize = 80

func visibleWorkTimelineEntries(from entries: [WorkTimelineEntry], visibleCount: Int) -> [WorkTimelineEntry] {
  let clampedCount = max(visibleCount, 0)
  guard clampedCount < entries.count else { return entries }
  return Array(entries.suffix(clampedCount))
}

func summarizeWorkSessionUsage(from transcript: [WorkChatEnvelope]) -> WorkUsageSummary? {
  let doneEvents = transcript.compactMap { envelope -> WorkUsageSummary? in
    guard case .done(_, _, let usage, _) = envelope.event else { return nil }
    return usage
  }

  let turnCount = transcript.reduce(into: 0) { count, envelope in
    if case .done = envelope.event {
      count += 1
    }
  }

  guard turnCount > 0 else { return nil }

  return doneEvents.reduce(
    WorkUsageSummary(
      turnCount: turnCount,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    )
  ) { partial, usage in
    WorkUsageSummary(
      turnCount: partial.turnCount,
      inputTokens: partial.inputTokens + usage.inputTokens,
      outputTokens: partial.outputTokens + usage.outputTokens,
      cacheReadTokens: partial.cacheReadTokens + usage.cacheReadTokens,
      cacheCreationTokens: partial.cacheCreationTokens + usage.cacheCreationTokens,
      costUsd: partial.costUsd + usage.costUsd
    )
  }
}

private func makeWorkUsageSummary(
  inputTokens: Int?,
  outputTokens: Int?,
  cacheReadTokens: Int?,
  cacheCreationTokens: Int?,
  costUsd: Double?
) -> WorkUsageSummary? {
  guard inputTokens != nil || outputTokens != nil || cacheReadTokens != nil || cacheCreationTokens != nil || costUsd != nil else {
    return nil
  }

  return WorkUsageSummary(
    turnCount: 1,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheCreationTokens: cacheCreationTokens ?? 0,
    costUsd: costUsd ?? 0
  )
}

private func formattedTokenCount(_ value: Int) -> String {
  let formatter = NumberFormatter()
  formatter.numberStyle = .decimal
  return formatter.string(from: NSNumber(value: value)) ?? String(value)
}

private func formattedDuration(milliseconds: Int) -> String {
  if milliseconds < 1_000 {
    return "\(milliseconds) ms"
  }

  let seconds = Double(milliseconds) / 1_000
  if seconds < 60 {
    return String(format: "%.1fs", seconds)
  }

  let minutes = Int(seconds) / 60
  let remainingSeconds = Int(seconds) % 60
  return "\(minutes)m \(remainingSeconds)s"
}

private func diffLineColor(for line: String) -> Color {
  if line.hasPrefix("+") && !line.hasPrefix("+++") {
    return ADEColor.success
  }
  if line.hasPrefix("-") && !line.hasPrefix("---") {
    return ADEColor.danger
  }
  return ADEColor.textPrimary
}

private func diffLineBackground(for line: String) -> Color {
  if line.hasPrefix("+") && !line.hasPrefix("+++") {
    return ADEColor.success.opacity(0.12)
  }
  if line.hasPrefix("-") && !line.hasPrefix("---") {
    return ADEColor.danger.opacity(0.12)
  }
  return .clear
}

private func workErrorCategory(message: String, detail: String?) -> String {
  let haystack = "\(message)\n\(detail ?? "")".lowercased()
  if haystack.contains("auth") || haystack.contains("unauthorized") || haystack.contains("forbidden") || haystack.contains("login") {
    return "auth"
  }
  if haystack.contains("rate limit") || haystack.contains("429") || haystack.contains("quota") || haystack.contains("too many requests") {
    return "rate_limit"
  }
  if haystack.contains("timeout") || haystack.contains("offline") || haystack.contains("network") || haystack.contains("disconnected") {
    return "network"
  }
  if haystack.contains("permission") || haystack.contains("denied") {
    return "permission"
  }
  return "general"
}

private struct WorkErrorPresentation {
  let title: String
  let icon: String
  let tint: ColorToken
}

private func errorPresentation(for category: String) -> WorkErrorPresentation {
  switch category {
  case "auth":
    return WorkErrorPresentation(title: "Authentication issue", icon: "lock.trianglebadge.exclamationmark", tint: .danger)
  case "rate_limit":
    return WorkErrorPresentation(title: "Rate limited", icon: "hourglass", tint: .warning)
  case "network":
    return WorkErrorPresentation(title: "Connection issue", icon: "wifi.exclamationmark", tint: .warning)
  case "permission":
    return WorkErrorPresentation(title: "Permission issue", icon: "hand.raised.fill", tint: .warning)
  default:
    return WorkErrorPresentation(title: "Error", icon: "exclamationmark.triangle.fill", tint: .danger)
  }
}

private func buildWorkChatMessages(from transcript: [WorkChatEnvelope]) -> [WorkChatMessage] {
  var messages: [WorkChatMessage] = []

  for envelope in transcript {
    switch envelope.event {
    case .userMessage(let text, let turnId, let steerId, let deliveryState, let processed):
      // Queued steers render as inline cards above the composer, not in the message stream.
      if deliveryState == "queued", steerId != nil {
        continue
      }
      if let lastIndex = messages.indices.last,
         messages[lastIndex].role == "user",
         messages[lastIndex].turnId == turnId,
         messages[lastIndex].steerId == steerId,
         messages[lastIndex].timestamp == envelope.timestamp {
        messages[lastIndex].markdown += text
        if let deliveryState {
          messages[lastIndex].deliveryState = deliveryState
        }
        if let processed {
          messages[lastIndex].processed = processed
        }
      } else {
        messages.append(WorkChatMessage(
          id: envelope.id,
          role: "user",
          markdown: text,
          timestamp: envelope.timestamp,
          turnId: turnId,
          itemId: nil,
          steerId: steerId,
          deliveryState: deliveryState,
          processed: processed
        ))
      }
    case .assistantText(let text, let turnId, let itemId):
      if let lastIndex = messages.indices.last,
         messages[lastIndex].role == "assistant",
         messages[lastIndex].turnId == turnId,
         messages[lastIndex].itemId == itemId {
        messages[lastIndex].markdown += text
      } else {
        messages.append(WorkChatMessage(id: envelope.id, role: "assistant", markdown: text, timestamp: envelope.timestamp, turnId: turnId, itemId: itemId))
      }
    default:
      continue
    }
  }

  return messages
}

private func makeWorkChatTranscript(from entries: [AgentChatTranscriptEntry], sessionId: String) -> [WorkChatEnvelope] {
  entries.map { entry in
    WorkChatEnvelope(
      sessionId: sessionId,
      timestamp: entry.timestamp,
      sequence: nil,
      event: entry.role == "assistant"
        ? .assistantText(text: entry.text, turnId: entry.turnId, itemId: nil)
        : .userMessage(text: entry.text, turnId: entry.turnId, steerId: nil, deliveryState: nil, processed: nil)
    )
  }
}

private func makeWorkChatTranscript(from entries: [AgentChatEventEnvelope]) -> [WorkChatEnvelope] {
  entries.map { entry in
    WorkChatEnvelope(
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      sequence: entry.sequence,
      event: makeWorkChatEvent(from: entry.event)
    )
  }
  .sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

func mergeWorkChatTranscripts(base: [WorkChatEnvelope], live: [WorkChatEnvelope]) -> [WorkChatEnvelope] {
  guard !live.isEmpty else { return base }
  guard !base.isEmpty else { return live }

  var merged = base
  var indexByKey = Dictionary(uniqueKeysWithValues: merged.enumerated().map { (index, envelope) in
    (workChatEnvelopeMergeKey(envelope), index)
  })

  for envelope in live {
    let key = workChatEnvelopeMergeKey(envelope)
    if let index = indexByKey[key] {
      merged[index] = envelope
    } else {
      indexByKey[key] = merged.count
      merged.append(envelope)
    }
  }

  return merged.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

enum WorkPendingInputItem: Identifiable, Equatable {
  case approval(WorkPendingApprovalModel)
  case question(WorkPendingQuestionModel)

  var id: String {
    switch self {
    case .approval(let model): return "approval:\(model.id)"
    case .question(let model): return "question:\(model.id)"
    }
  }

  var itemId: String {
    switch self {
    case .approval(let model): return model.id
    case .question(let model): return model.id
    }
  }
}

struct WorkPendingSteerModel: Identifiable, Equatable {
  let id: String
  var text: String
  let turnId: String?
  let timestamp: String
}

/// Ordered list of still-open pending inputs (approvals + structured questions) in the order
/// they were requested. Mirrors the desktop `derivePendingInputRequests` helper — resolved items
/// are filtered out using the same predicate as `pendingWorkInputItemIds`.
func derivePendingWorkInputs(from transcript: [WorkChatEnvelope]) -> [WorkPendingInputItem] {
  let openIds = pendingWorkInputItemIds(from: transcript)
  var seen = Set<String>()
  var results: [WorkPendingInputItem] = []
  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .approvalRequest(let description, let detail, let itemId, _):
      guard openIds.contains(itemId), !seen.contains(itemId) else { continue }
      seen.insert(itemId)
      results.append(.approval(WorkPendingApprovalModel(id: itemId, description: description, detail: detail)))
    case .structuredQuestion(let question, let options, let itemId, _):
      guard openIds.contains(itemId), !seen.contains(itemId) else { continue }
      seen.insert(itemId)
      results.append(.question(WorkPendingQuestionModel(id: itemId, question: question, options: options)))
    default:
      continue
    }
  }
  return results
}

/// Ordered list of queued steer messages (user messages with `deliveryState == "queued"` and a
/// `steerId`). Removed once a `system_notice` referencing the same steerId arrives (desktop emits
/// one for both "cancelled" and "delivering") or once the event graduates out of the queued state.
func derivePendingWorkSteers(from transcript: [WorkChatEnvelope]) -> [WorkPendingSteerModel] {
  var queue: [String: WorkPendingSteerModel] = [:]
  var order: [String] = []
  var resolved = Set<String>()
  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .userMessage(let text, let turnId, let steerId, let deliveryState, _):
      guard let steerId, !resolved.contains(steerId) else { continue }
      if deliveryState == "queued" {
        if queue[steerId] == nil { order.append(steerId) }
        queue[steerId] = WorkPendingSteerModel(id: steerId, text: text, turnId: turnId, timestamp: envelope.timestamp)
      } else if deliveryState == "delivered" || deliveryState == "failed" {
        queue.removeValue(forKey: steerId)
        resolved.insert(steerId)
      }
    case .systemNotice(_, _, _, _, let steerId):
      if let steerId {
        queue.removeValue(forKey: steerId)
        resolved.insert(steerId)
      }
    default:
      continue
    }
  }
  return order.compactMap { queue[$0] }
}

func pendingWorkInputItemIds(from transcript: [WorkChatEnvelope]) -> Set<String> {
  var approvals: [String: String?] = [:]
  var questions: [String: String?] = [:]

  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .approvalRequest(_, _, let itemId, let turnId):
      approvals.updateValue(turnId, forKey: itemId)
    case .structuredQuestion(_, _, let itemId, let turnId):
      questions.updateValue(turnId, forKey: itemId)
    case .pendingInputResolved(let itemId, _, _):
      approvals.removeValue(forKey: itemId)
      questions.removeValue(forKey: itemId)
    case .toolResult(_, _, let itemId, _, _, _),
         .command(_, _, _, _, let itemId, _, _, _),
         .fileChange(_, _, _, _, let itemId, _):
      approvals.removeValue(forKey: itemId)
      questions.removeValue(forKey: itemId)
    case .done(let status, _, _, let turnId):
      if status == "completed" {
        approvals = approvals.filter { $0.value != turnId }
      } else {
        approvals.removeAll()
        questions.removeAll()
      }
    default:
      continue
    }
  }

  return Set(approvals.keys).union(questions.keys)
}

private func sortedWorkChatEnvelopes(_ transcript: [WorkChatEnvelope]) -> [WorkChatEnvelope] {
  transcript.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

private func workChatEnvelopeMergeKey(_ envelope: WorkChatEnvelope) -> String {
  "\(envelope.sessionId)|\(envelope.timestamp)|\(workChatEventMergeKey(envelope.event))"
}

private func workChatEventMergeKey(_ event: WorkChatEvent) -> String {
  switch event {
  case .userMessage(let text, let turnId, let steerId, let deliveryState, let processed):
    // Queued steers are uniquely identified by steerId so that editSteer replaces the existing
    // entry in place instead of spawning a duplicate row whose only difference is the edited text.
    if let steerId, deliveryState == "queued" {
      return ["user_message", turnId ?? "", steerId, "queued"].joined(separator: "|")
    }
    return ["user_message", turnId ?? "", steerId ?? "", deliveryState ?? "", processed.map { $0 ? "1" : "0" } ?? "", text].joined(separator: "|")
  case .assistantText(let text, let turnId, let itemId):
    return ["text", turnId ?? "", itemId ?? "", text].joined(separator: "|")
  case .toolCall(let tool, let argsText, let itemId, let parentItemId, let turnId):
    return ["tool_call", turnId ?? "", itemId, parentItemId ?? "", tool, argsText].joined(separator: "|")
  case .toolResult(let tool, let resultText, let itemId, let parentItemId, let turnId, let status):
    return ["tool_result", turnId ?? "", itemId, parentItemId ?? "", tool, status.rawValue, resultText].joined(separator: "|")
  case .activity(let kind, let detail, let turnId):
    return ["activity", turnId ?? "", kind, detail ?? ""].joined(separator: "|")
  case .plan(let steps, let explanation, let turnId):
    return ["plan", turnId ?? "", explanation ?? "", steps.joined(separator: "\n")].joined(separator: "|")
  case .subagentStarted(let taskId, let description, let background, let turnId):
    return ["subagent_started", turnId ?? "", taskId, description, background ? "1" : "0"].joined(separator: "|")
  case .subagentProgress(let taskId, let description, let summary, let toolName, let turnId):
    return ["subagent_progress", turnId ?? "", taskId, description ?? "", summary, toolName ?? ""].joined(separator: "|")
  case .subagentResult(let taskId, let status, let summary, let turnId):
    return ["subagent_result", turnId ?? "", taskId, status, summary].joined(separator: "|")
  case .structuredQuestion(let question, let options, let itemId, let turnId):
    return ["structured_question", turnId ?? "", itemId, question, options.joined(separator: "\n")].joined(separator: "|")
  case .approvalRequest(let description, let detail, let itemId, let turnId):
    return ["approval_request", turnId ?? "", itemId, description, detail ?? ""].joined(separator: "|")
  case .pendingInputResolved(let itemId, let resolution, let turnId):
    return ["pending_input_resolved", turnId ?? "", itemId, resolution].joined(separator: "|")
  case .todoUpdate(let items, let turnId):
    return ["todo_update", turnId ?? "", items.joined(separator: "\n")].joined(separator: "|")
  case .systemNotice(let kind, let message, let detail, let turnId, let steerId):
    return ["system_notice", turnId ?? "", steerId ?? "", kind, message, detail ?? ""].joined(separator: "|")
  case .error(let message, let detail, let category, let turnId):
    return ["error", turnId ?? "", category, message, detail ?? ""].joined(separator: "|")
  case .done(let status, let summary, let usage, let turnId):
    return ["done", turnId, status, summary, workUsageSummaryMergeKey(usage)].joined(separator: "|")
  case .promptSuggestion(let text, let turnId):
    return ["prompt_suggestion", turnId ?? "", text].joined(separator: "|")
  case .contextCompact(let summary, let turnId):
    return ["context_compact", turnId ?? "", summary].joined(separator: "|")
  case .autoApprovalReview(let summary, let turnId):
    return ["auto_approval_review", turnId ?? "", summary].joined(separator: "|")
  case .webSearch(let query, let action, let status, let itemId, let turnId):
    return ["web_search", turnId ?? "", itemId, query, action ?? "", status.rawValue].joined(separator: "|")
  case .planText(let text, let turnId):
    return ["plan_text", turnId ?? "", text].joined(separator: "|")
  case .toolUseSummary(let text, let turnId):
    return ["tool_use_summary", turnId ?? "", text].joined(separator: "|")
  case .status(let turnStatus, let message, let turnId):
    return ["status", turnId ?? "", turnStatus, message ?? ""].joined(separator: "|")
  case .reasoning(let text, let turnId):
    return ["reasoning", turnId ?? "", text].joined(separator: "|")
  case .completionReport(let summary, let status, let artifacts, let blockerDescription, let turnId):
    return ["completion_report", turnId ?? "", status, summary, blockerDescription ?? "", workCompletionArtifactsMergeKey(artifacts)].joined(separator: "|")
  case .command(let command, let cwd, let output, let status, let itemId, let exitCode, let durationMs, let turnId):
    return [
      "command",
      turnId ?? "",
      itemId,
      command,
      cwd,
      output,
      status.rawValue,
      exitCode.map { String($0) } ?? "",
      durationMs.map { String($0) } ?? "",
    ].joined(separator: "|")
  case .fileChange(let path, let diff, let kind, let status, let itemId, let turnId):
    return ["file_change", turnId ?? "", itemId, path, kind, status.rawValue, diff].joined(separator: "|")
  case .unknown(let type):
    return ["unknown", type].joined(separator: "|")
  }
}

private func workUsageSummaryMergeKey(_ usage: WorkUsageSummary?) -> String {
  guard let usage else { return "" }
  return [
    String(usage.turnCount),
    String(usage.inputTokens),
    String(usage.outputTokens),
    String(usage.cacheReadTokens),
    String(usage.cacheCreationTokens),
    String(usage.costUsd),
  ].joined(separator: "|")
}

private func workCompletionArtifactsMergeKey(_ artifacts: [WorkCompletionArtifactModel]) -> String {
  artifacts.map { artifact in
    [artifact.type, artifact.description, artifact.reference ?? ""].joined(separator: "~")
  }.joined(separator: "\n")
}

private func makeWorkChatEvent(from event: AgentChatEvent) -> WorkChatEvent {
  switch event {
  case .userMessage(let text, _, let turnId, let steerId, let deliveryState, let processed):
    return .userMessage(text: text, turnId: turnId, steerId: steerId, deliveryState: deliveryState, processed: processed)
  case .text(let text, _, let turnId, let itemId):
    return .assistantText(text: text, turnId: turnId, itemId: itemId)
  case .toolCall(let tool, let args, let itemId, _, let parentItemId, let turnId):
    return .toolCall(
      tool: tool,
      argsText: prettyPrintedRemoteJSONValue(args),
      itemId: itemId,
      parentItemId: parentItemId,
      turnId: turnId
    )
  case .toolResult(let tool, let result, let itemId, _, let parentItemId, let turnId, let status):
    return .toolResult(
      tool: tool,
      resultText: prettyPrintedRemoteJSONValue(result),
      itemId: itemId,
      parentItemId: parentItemId,
      turnId: turnId,
      status: toolStatus(from: status ?? "running")
    )
  case .activity(let activity, let detail, let turnId):
    return .activity(kind: activity.rawValue, detail: detail, turnId: turnId)
  case .plan(let steps, let explanation, let turnId):
    let renderedSteps = steps.map { step in
      let status = step.status.replacingOccurrences(of: "_", with: " ").capitalized
      return "\(status): \(step.text)"
    }
    return .plan(steps: renderedSteps, explanation: explanation, turnId: turnId)
  case .subagentStarted(let taskId, let description, let background, let turnId):
    return .subagentStarted(taskId: taskId, description: description, background: background ?? false, turnId: turnId)
  case .subagentProgress(let taskId, let description, let summary, _, let lastToolName, let turnId):
    return .subagentProgress(taskId: taskId, description: description, summary: summary, toolName: lastToolName, turnId: turnId)
  case .subagentResult(let taskId, let status, let summary, _, let turnId):
    return .subagentResult(taskId: taskId, status: status.rawValue, summary: summary, turnId: turnId)
  case .structuredQuestion(let question, let options, let itemId, let turnId):
    return .structuredQuestion(question: question, options: options?.map(\.label) ?? [], itemId: itemId, turnId: turnId)
  case .approvalRequest(let itemId, _, _, let description, let turnId, let detail):
    return .approvalRequest(description: description, detail: prettyPrintedRemoteJSONValue(detail), itemId: itemId, turnId: turnId)
  case .pendingInputResolved(let itemId, let resolution, let turnId):
    return .pendingInputResolved(itemId: itemId, resolution: resolution, turnId: turnId)
  case .todoUpdate(let items, let turnId):
    let renderedItems = items.map { item in
      "\(item.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized): \(item.description)"
    }
    return .todoUpdate(items: renderedItems, turnId: turnId)
  case .systemNotice(let noticeKind, let message, let detail, let turnId, let steerId):
    return .systemNotice(kind: noticeKind.rawValue, message: message, detail: prettyPrintedRemoteJSONValue(detail), turnId: turnId, steerId: steerId)
  case .error(let message, let turnId, _, let errorInfo):
    let detailText = prettyPrintedRemoteJSONValue(errorInfo)
    return .error(message: message, detail: detailText, category: workErrorCategory(message: message, detail: detailText), turnId: turnId)
  case .done(let turnId, let status, let model, _, let usage, let costUsd):
    var parts = [status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized]
    if let model, !model.isEmpty {
      parts.append(model)
    }
    if let usage {
      parts.append(prettyPrintedRemoteJSONValue(.object([
        "inputTokens": usage.inputTokens.map { .number(Double($0)) } ?? .null,
        "outputTokens": usage.outputTokens.map { .number(Double($0)) } ?? .null,
        "cacheReadTokens": usage.cacheReadTokens.map { .number(Double($0)) } ?? .null,
        "cacheCreationTokens": usage.cacheCreationTokens.map { .number(Double($0)) } ?? .null,
      ])))
    }
    if let costUsd {
      parts.append(String(format: "$%.4f", costUsd))
    }
    return .done(
      status: status.rawValue,
      summary: parts.joined(separator: "\n"),
      usage: makeWorkUsageSummary(
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.cacheReadTokens,
        cacheCreationTokens: usage?.cacheCreationTokens,
        costUsd: costUsd
      ),
      turnId: turnId
    )
  case .promptSuggestion(let suggestion, let turnId):
    return .promptSuggestion(text: suggestion, turnId: turnId)
  case .contextCompact(let trigger, let preTokens, let turnId):
    let summary = [trigger.rawValue.capitalized, preTokens.map { "Pre-compact tokens: \($0)" }].compactMap { $0 }.joined(separator: "\n")
    return .contextCompact(summary: summary, turnId: turnId)
  case .autoApprovalReview(_, let reviewStatus, let action, let review, let turnId):
    let summary = [reviewStatus.rawValue.capitalized, action, review].compactMap { $0 }.joined(separator: "\n")
    return .autoApprovalReview(summary: summary, turnId: turnId)
  case .webSearch(let query, let action, let itemId, _, let turnId, let status):
    return .webSearch(query: query, action: action, status: toolStatus(from: status), itemId: itemId, turnId: turnId)
  case .planText(let text, let turnId, _):
    return .planText(text: text, turnId: turnId)
  case .toolUseSummary(let summary, _, let turnId):
    return .toolUseSummary(text: summary, turnId: turnId)
  case .status(let turnStatus, let turnId, let message):
    return .status(turnStatus: turnStatus.rawValue, message: message, turnId: turnId)
  case .reasoning(let text, let turnId, _, _):
    return .reasoning(text: text, turnId: turnId)
  case .completionReport(let report, let turnId):
    return .completionReport(
      summary: report.summary,
      status: report.status,
      artifacts: (report.artifacts ?? []).map { artifact in
        WorkCompletionArtifactModel(type: artifact.type, description: artifact.description, reference: artifact.reference)
      },
      blockerDescription: report.blockerDescription,
      turnId: turnId
    )
  case .command(let command, let cwd, let output, let itemId, _, let turnId, let exitCode, let durationMs, let status):
    return .command(
      command: command,
      cwd: cwd,
      output: output,
      status: toolStatus(from: status),
      itemId: itemId,
      exitCode: exitCode,
      durationMs: durationMs,
      turnId: turnId
    )
  case .fileChange(let path, let diff, let kind, let itemId, _, let turnId, let status):
    return .fileChange(path: path, diff: diff, kind: kind.rawValue, status: toolStatus(from: status ?? "running"), itemId: itemId, turnId: turnId)
  case .stepBoundary:
    return .unknown(type: "step_boundary")
  case .delegationState:
    return .unknown(type: "delegation_state")
  case .unknown(let type):
    return .unknown(type: type)
  }
}

private func ansiAttributedString(_ text: String) -> AttributedString {
  var attributed = AttributedString("")
  for segment in parseANSISegments(text) {
    var piece = AttributedString(segment.text)
    piece.font = segment.bold ? .system(.footnote, design: .monospaced).bold() : .system(.footnote, design: .monospaced)
    piece.foregroundColor = ansiColor(segment.foreground)
    attributed.append(piece)
  }
  return attributed
}

private func ansiColor(_ color: WorkANSIColor?) -> Color {
  switch color {
  case .red: return .red
  case .green: return .green
  case .yellow: return .yellow
  case .blue: return .blue
  case .magenta: return .purple
  case .cyan: return .cyan
  case .white: return .white
  case .black: return .black
  case .none: return ADEColor.textPrimary
  }
}

private func toolStatus(from raw: String) -> WorkToolCardStatus {
  switch raw.lowercased() {
  case "failed", "interrupted", "cancelled": return .failed
  case "completed", "success", "succeeded": return .completed
  default: return .running
  }
}

private func icon(for status: WorkToolCardStatus) -> String {
  switch status {
  case .running: return "ellipsis.circle"
  case .completed: return "checkmark.circle.fill"
  case .failed: return "xmark.circle.fill"
  }
}

private func color(for status: WorkToolCardStatus) -> Color {
  switch status {
  case .running: return ADEColor.warning
  case .completed: return ADEColor.success
  case .failed: return ADEColor.danger
  }
}

private func prettyPrintedJSONString(_ value: Any?) -> String {
  guard let value else { return "" }
  if let string = value as? String {
    return string
  }
  if JSONSerialization.isValidJSONObject(value),
     let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
     let string = String(data: data, encoding: .utf8) {
    return string
  }
  return String(describing: value)
}

private func prettyPrintedRemoteJSONValue(_ value: RemoteJSONValue?) -> String {
  guard let value else { return "" }
  let foundationObject = foundationObject(from: value)
  return prettyPrintedJSONString(foundationObject)
}

private func foundationObject(from value: RemoteJSONValue) -> Any {
  switch value {
  case .string(let string):
    return string
  case .number(let number):
    return number
  case .bool(let bool):
    return bool
  case .object(let object):
    return object.mapValues { foundationObject(from: $0) }
  case .array(let array):
    return array.map { foundationObject(from: $0) }
  case .null:
    return NSNull()
  }
}

private func stringValue(_ value: Any?) -> String {
  if let string = value as? String {
    return string
  }
  if let number = value as? NSNumber {
    return number.stringValue
  }
  return ""
}

private func optionalString(_ value: Any?) -> String? {
  let text = stringValue(value).trimmingCharacters(in: .whitespacesAndNewlines)
  return text.isEmpty ? nil : text
}

func isChatSession(_ session: TerminalSessionSummary) -> Bool {
  let raw = session.toolType?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased() ?? ""
  guard !raw.isEmpty else { return false }
  // Must match desktop `isChatToolType` (`apps/desktop/src/renderer/lib/sessions.ts`) — explicit chat tools plus `*-chat` providers.
  if raw == "codex-chat" || raw == "claude-chat" || raw == "opencode-chat" || raw == "cursor" {
    return true
  }
  return raw.hasSuffix("-chat")
}

private func defaultWorkChatTitle(provider: String) -> String {
  switch provider.lowercased() {
  case "codex":
    return "Codex chat"
  case "opencode":
    return "OpenCode chat"
  case "cursor":
    return "Cursor chat"
  default:
    return "Claude chat"
  }
}

private func toolTypeForProvider(_ provider: String) -> String {
  switch provider.lowercased() {
  case "codex": return "codex-chat"
  case "opencode": return "opencode-chat"
  case "cursor": return "cursor"
  default: return "claude-chat"
  }
}

private func providerLabel(_ provider: String) -> String {
  switch provider.lowercased() {
  case "codex": return "Codex"
  case "claude": return "Claude"
  case "opencode": return "OpenCode"
  case "cursor": return "Cursor"
  default: return provider.capitalized
  }
}

private func providerIcon(_ provider: String) -> String {
  switch provider.lowercased() {
  case "codex":
    return "sparkle"
  case "opencode":
    return "hammer.fill"
  case "cursor":
    return "cursorarrow"
  default:
    return "brain.head.profile"
  }
}

private func providerTint(_ provider: String?) -> Color {
  guard let provider else { return ADEColor.accent }
  switch provider.lowercased() {
  case "codex":
    return .blue
  case "opencode":
    return .teal
  case "cursor":
    return .indigo
  default:
    return ADEColor.accent
  }
}

private func sessionSymbol(_ session: TerminalSessionSummary, provider: String?) -> String {
  if isChatSession(session) {
    return providerIcon(provider ?? session.toolType ?? "")
  }
  return "terminal.fill"
}

func normalizedWorkChatSessionStatus(session: TerminalSessionSummary?, summary: AgentChatSessionSummary?) -> String {
  if summary?.awaitingInput == true {
    return "awaiting-input"
  }
  if let status = summary?.status.lowercased() {
    switch status {
    case "active", "running":
      return "active"
    case "idle", "paused":
      return "idle"
    case "ended", "completed", "failed", "interrupted":
      return "ended"
    default:
      break
    }
  }

  guard let session else { return "ended" }
  switch session.runtimeState.lowercased() {
  case "waiting-input":
    return "awaiting-input"
  case "idle":
    return "idle"
  case "running":
    return "active"
  default:
    return session.status == "running" ? "active" : "ended"
  }
}

private func normalizedRuntimeState(for summary: AgentChatSessionSummary) -> String {
  if summary.awaitingInput == true {
    return "waiting-input"
  }
  switch summary.status.lowercased() {
  case "idle", "paused":
    return "idle"
  case "ended", "completed", "failed", "interrupted":
    return "exited"
  default:
    return "running"
  }
}

private func workChatStatusSortRank(_ status: String) -> Int {
  switch status {
  case "awaiting-input": return 0
  case "active": return 1
  case "idle": return 2
  default: return 3
  }
}

private func workChatStatusTint(_ status: String) -> Color {
  switch status {
  case "awaiting-input": return ADEColor.warning
  case "active": return ADEColor.success
  case "idle": return ADEColor.accent
  default: return ADEColor.textSecondary
  }
}

private func workChatStatusIcon(_ status: String) -> String {
  switch status {
  case "awaiting-input": return "exclamationmark.bubble.fill"
  case "active": return "waveform.path.ecg"
  case "idle": return "pause.circle"
  default: return "checkmark.circle"
  }
}

private func workInitialRuntimeMode(_ summary: AgentChatSessionSummary) -> String {
  switch summary.provider {
  case "claude":
    if summary.interactionMode == "plan" || summary.permissionMode == "plan" {
      return "plan"
    }
    if summary.claudePermissionMode == "bypassPermissions" || summary.permissionMode == "full-auto" {
      return "full-auto"
    }
    if summary.claudePermissionMode == "acceptEdits" || summary.permissionMode == "edit" {
      return "edit"
    }
    return "default"
  case "codex":
    if summary.codexApprovalPolicy == "untrusted" && summary.codexSandbox == "read-only" {
      return "plan"
    }
    if summary.codexApprovalPolicy == "on-failure" && summary.codexSandbox == "workspace-write" {
      return "edit"
    }
    if summary.codexApprovalPolicy == "never" && summary.codexSandbox == "danger-full-access" {
      return "full-auto"
    }
    return "default"
  case "opencode":
    return summary.opencodePermissionMode ?? summary.permissionMode ?? "edit"
  default:
    return ""
  }
}

private func workInitialCursorModeId(_ summary: AgentChatSessionSummary) -> String {
  summary.cursorModeId ?? workCursorCurrentModeId(summary.cursorModeSnapshot) ?? "agent"
}

private func workCursorModeIds(_ snapshot: RemoteJSONValue?, fallback: String) -> [String] {
  if case .object(let object) = snapshot,
     case .array(let entries)? = object["availableModeIds"] {
    let ids = entries.compactMap { value -> String? in
      guard case .string(let string) = value else { return nil }
      let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }
    if !ids.isEmpty {
      return ids
    }
  }
  return [fallback]
}

private func workCursorCurrentModeId(_ snapshot: RemoteJSONValue?) -> String? {
  guard case .object(let object)? = snapshot,
        case .string(let currentModeId)? = object["currentModeId"]
  else {
    return nil
  }
  let trimmed = currentModeId.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

private func workCursorModeLabel(_ modeId: String) -> String {
  let normalized = modeId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if normalized.isEmpty { return "Agent" }
  switch normalized {
  case "agent": return "Agent"
  case "ask": return "Ask"
  case "manual": return "Manual"
  default:
    return normalized
      .split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "/" })
      .map { part in
        let word = String(part)
        return word.prefix(1).uppercased() + word.dropFirst()
      }
      .joined(separator: " ")
  }
}

private func sessionStatusLabel(_ session: TerminalSessionSummary, summary: AgentChatSessionSummary? = nil) -> String {
  sessionStatusLabel(for: normalizedWorkChatSessionStatus(session: session, summary: summary))
}

private func sessionStatusLabel(for status: String) -> String {
  switch status {
  case "awaiting-input": return "NEEDS INPUT"
  case "active": return "RUNNING"
  case "idle": return "IDLE"
  default: return "ENDED"
  }
}

private func workParsedDate(_ value: String?) -> Date? {
  guard let value, !value.isEmpty else { return nil }
  return workDateFormatter.date(from: value)
}

private func formattedSessionDuration(startedAt: String, endedAt: String?) -> String {
  guard let start = workParsedDate(startedAt) else { return "—" }
  let end = workParsedDate(endedAt) ?? Date()
  let interval = max(0, Int(end.timeIntervalSince(start)))
  let hours = interval / 3600
  let minutes = (interval % 3600) / 60
  let seconds = interval % 60
  if hours > 0 {
    return String(format: "%dh %02dm", hours, minutes)
  }
  if minutes > 0 {
    return String(format: "%dm %02ds", minutes, seconds)
  }
  return "\(seconds)s"
}

private func relativeTimestamp(_ value: String) -> String {
  guard let date = workParsedDate(value) else { return value }
  return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}

private func activityTitle(for kind: String) -> String {
  switch kind {
  case "thinking": return "Thinking"
  case "working": return "Working"
  case "editing_file": return "Editing file"
  case "running_command": return "Running command"
  case "searching": return "Searching"
  case "reading": return "Reading"
  case "tool_calling": return "Calling tool"
  case "web_searching": return "Searching the web"
  case "spawning_agent": return "Spawning agent"
  default: return kind.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

private func pendingInputResolutionLabel(for resolution: String) -> String {
  switch resolution {
  case "accepted": return "Accepted"
  case "declined": return "Declined"
  case "cancelled": return "Cancelled"
  default: return resolution.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

private func pendingInputResolutionIcon(for resolution: String) -> String {
  switch resolution {
  case "accepted": return "checkmark.circle.fill"
  case "declined": return "xmark.circle.fill"
  case "cancelled": return "minus.circle.fill"
  default: return "checkmark.circle"
  }
}

private func pendingInputResolutionTint(for resolution: String) -> ColorToken {
  switch resolution {
  case "accepted": return .success
  case "declined": return .danger
  case "cancelled": return .secondary
  default: return .accent
  }
}

private func noticeTitle(for kind: String) -> String {
  switch kind {
  case "auth": return "Authentication notice"
  case "rate_limit": return "Rate limit notice"
  case "hook": return "Hook notice"
  case "file_persist": return "File persistence"
  case "memory": return "Memory notice"
  case "provider_health": return "Provider health"
  case "thread_error": return "Thread notice"
  default: return "System notice"
  }
}

private func noticeIcon(for kind: String) -> String {
  switch kind {
  case "auth": return "lock.trianglebadge.exclamationmark"
  case "rate_limit": return "speedometer"
  case "hook": return "bolt.badge.clock"
  case "file_persist": return "externaldrive.badge.checkmark"
  case "memory": return "brain.head.profile"
  case "provider_health": return "waveform.path.ecg"
  case "thread_error": return "exclamationmark.bubble"
  default: return "info.circle"
  }
}

private func noticeTint(for kind: String) -> ColorToken {
  switch kind {
  case "auth", "thread_error": return .danger
  case "rate_limit", "hook": return .warning
  case "provider_health", "memory": return .secondary
  default: return .accent
  }
}

private func toolDisplayName(_ tool: String) -> String {
  let trimmed = tool.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "Tool" }
  if trimmed.hasPrefix("functions.") {
    return String(trimmed.split(separator: ".").last ?? Substring(trimmed))
  }
  if trimmed.hasPrefix("mcp__") {
    return trimmed.replacingOccurrences(of: "mcp__", with: "").replacingOccurrences(of: "__", with: " · ")
  }
  return trimmed
}

private func fileExtension(for mimeType: String?, fallback: String) -> String {
  guard let mimeType else { return fallback }
  if mimeType.contains("png") { return "png" }
  if mimeType.contains("jpeg") || mimeType.contains("jpg") { return "jpg" }
  if mimeType.contains("gif") { return "gif" }
  if mimeType.contains("webp") { return "webp" }
  if mimeType.contains("mov") { return "mov" }
  if mimeType.contains("mp4") { return "mp4" }
  return fallback
}

private extension Font {
  func bold() -> Font {
    self.weight(.bold)
  }
}
