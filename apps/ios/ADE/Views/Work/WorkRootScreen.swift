import SwiftUI
import UIKit
import AVKit


let workDateFormatter = ISO8601DateFormatter()

struct WorkSessionRoute: Hashable {
  let sessionId: String
  var openingPrompt: String? = nil
}

struct WorkDraftChatSession {
  let summary: AgentChatSessionSummary
  let initialMessage: String?
}

struct WorkRootScreen: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @EnvironmentObject var syncService: SyncService
  @Namespace var sessionTransitionNamespace

  @State var sessions: [TerminalSessionSummary] = []
  @State var chatSummaries: [String: AgentChatSessionSummary] = [:]
  @State var lanes: [LaneSummary] = []
  @State var transcriptCache: [String: [WorkChatEnvelope]] = [:]
  /// Memoizes parsed transcripts for the Activity feed keyed by session id + cheap buffer fingerprint,
  /// so `localStateRevision` bumps during CRDT sync do not re-parse every terminal buffer in `body`.
  @State var activityTranscriptCache: [String: WorkActivityTranscriptCacheEntry] = [:]
  @State var activityFeedEntries: [WorkAgentActivity] = []
  @State var errorMessage: String?
  @State var path = NavigationPath()
  @State var searchText = ""
  @State var selectedLaneId = "all"
  @State var selectedStatus: WorkSessionStatusFilter = .all
  @State var renameTarget: TerminalSessionSummary?
  @State var renameText = ""
  @State var endTarget: TerminalSessionSummary?
  @State var optimisticSessions: [String: TerminalSessionSummary] = [:]
  @State var refreshFeedbackToken = 0
  @State var selectedSessionTransitionId: String?
  /// Coalesces expensive per-lane `listChatSessions` refreshes when `localStateRevision` bumps during CRDT sync.
  @State var lastCoalescedChatSummaryRefresh = Date.distantPast
  @AppStorage("ade.work.archivedSessionIds") var archivedSessionIdsStorage = ""
  @AppStorage("ade.work.sessionOrganization") var sessionOrganizationRaw = WorkSessionOrganization.byStatus.rawValue
  @AppStorage("ade.work.collapsedSectionIds") var collapsedSectionIdsStorage = ""
  @State var filterPanelOpen = false

  var workStatus: SyncDomainStatus {
    syncService.status(for: .work)
  }

  var isLive: Bool {
    workStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !mergedSessions.isEmpty
  }

  var isLoadingSkeleton: Bool {
    workStatus.phase == .hydrating || workStatus.phase == .syncingInitialData
  }

  var archivedSessionIds: Set<String> {
    Set(archivedSessionIdsStorage.split(separator: "\n").map(String.init))
  }

  var laneById: [String: LaneSummary] {
    Dictionary(lanes.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
  }

  var mergedSessions: [TerminalSessionSummary] {
    let draftValues = optimisticSessions.values.filter { draft in
      !sessions.contains(where: { $0.id == draft.id })
    }
    return (sessions + draftValues)
      .sorted { compareWorkSessionSortOrder($0, $1, chatSummaries: chatSummaries) }
  }

  var displaySessions: [TerminalSessionSummary] {
    workFilteredSessions(
      mergedSessions,
      chatSummaries: chatSummaries,
      archivedSessionIds: archivedSessionIds,
      selectedStatus: selectedStatus,
      selectedLaneId: selectedLaneId,
      searchText: searchText
    )
  }

  var needsInputSessions: [TerminalSessionSummary] {
    displaySessions.filter {
      !archivedSessionIds.contains($0.id)
      && normalizedWorkChatSessionStatus(session: $0, summary: chatSummaries[$0.id]) == "awaiting-input"
    }
  }

  var pinnedSessions: [TerminalSessionSummary] {
    displaySessions.filter {
      $0.pinned
      && !archivedSessionIds.contains($0.id)
      && normalizedWorkChatSessionStatus(session: $0, summary: chatSummaries[$0.id]) != "awaiting-input"
    }
  }

  var liveSessions: [TerminalSessionSummary] {
    displaySessions.filter { session in
      !session.pinned
      && !archivedSessionIds.contains(session.id)
      && {
        let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
        return status == "active" || status == "idle"
      }()
    }
  }

  var endedSessions: [TerminalSessionSummary] {
    displaySessions.filter {
      !$0.pinned
      && !archivedSessionIds.contains($0.id)
      && normalizedWorkChatSessionStatus(session: $0, summary: chatSummaries[$0.id]) == "ended"
    }
  }

  var archivedSessions: [TerminalSessionSummary] {
    displaySessions.filter { archivedSessionIds.contains($0.id) }
  }

  var liveChatSessions: [TerminalSessionSummary] {
    mergedSessions.filter { session in
      let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
      return isChatSession(session) && status != "ended" && !archivedSessionIds.contains(session.id)
    }
  }

  var activitySessions: [TerminalSessionSummary] {
    workActivitySourceSessions(
      displaySessions,
      chatSummaries: chatSummaries,
      archivedSessionIds: archivedSessionIds
    )
  }

  var hasActiveFilters: Bool {
    selectedStatus != .all || selectedLaneId != "all"
  }

  var sessionOrganizationBinding: Binding<WorkSessionOrganization> {
    Binding(
      get: { WorkSessionOrganization(rawValue: sessionOrganizationRaw) ?? .byStatus },
      set: { sessionOrganizationRaw = $0.rawValue }
    )
  }

  var collapsedSectionIds: Set<String> {
    workParseCollapsedSectionIds(collapsedSectionIdsStorage)
  }

  func toggleCollapsed(_ id: String) {
    var ids = collapsedSectionIds
    if ids.contains(id) {
      ids.remove(id)
    } else {
      ids.insert(id)
    }
    collapsedSectionIdsStorage = workSerializeCollapsedSectionIds(ids)
  }

  func pushNewChatRoute() {
    let preferred = selectedLaneId == "all" ? lanes.first?.id : selectedLaneId
    path.append(WorkNewChatRoute(preferredLaneId: preferred))
  }

  var sessionGroups: [WorkSessionGroup] {
    workSessionGroups(
      organization: WorkSessionOrganization(rawValue: sessionOrganizationRaw) ?? .byStatus,
      sessions: displaySessions,
      chatSummaries: chatSummaries,
      archivedSessionIds: archivedSessionIds,
      orderedLanes: lanes
    )
  }

  var activityFeed: [WorkAgentActivity] {
    activityFeedEntries
  }

  /// Composite fingerprint that changes only when the Activity feed actually needs to rebuild.
  /// Built from the activity session ids, their streamed transcript counts, and a cheap buffer
  /// fingerprint so typical `localStateRevision` bumps do not trigger a rebuild.
  var activityFeedFingerprint: String {
    var parts: [String] = []
    parts.reserveCapacity(activitySessions.count)
    for session in activitySessions {
      let streamedCount = transcriptCache[session.id]?.count ?? -1
      let buffer = syncService.terminalBuffers[session.id] ?? ""
      let bufferFingerprint = workActivityBufferFingerprint(buffer)
      let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
      parts.append("\(session.id):\(streamedCount):\(bufferFingerprint):\(status)")
    }
    return parts.joined(separator: "|")
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
            organization: sessionOrganizationBinding,
            filterOpen: $filterPanelOpen,
            lanes: lanes,
            runningCount: liveSessions.count,
            needsInputCount: needsInputSessions.count,
            onNewChat: pushNewChatRoute,
            newChatEnabled: isLive
          )
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)

          if !liveSessions.isEmpty || !needsInputSessions.isEmpty {
            WorkRunningBanner(liveSessions: liveSessions, attentionCount: needsInputSessions.count)
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
                pushNewChatRoute()
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
              .disabled(!isLive)
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          } else {
            ForEach(sessionGroups) { group in
              WorkSidebarSectionHeader(
                group: group,
                collapsed: collapsedSectionIds.contains(group.id),
                onToggle: { toggleCollapsed(group.id) }
              )
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
              .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 2, trailing: 0))

              if !collapsedSectionIds.contains(group.id) {
                ForEach(group.sessions) { session in
                  WorkSessionListRow(
                    session: session,
                    lane: laneById[session.laneId],
                    chatSummary: chatSummaries[session.id],
                    isArchived: archivedSessionIds.contains(session.id),
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
                  .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                  .listRowBackground(Color.clear)
                  .listRowSeparator(.hidden)
                }
              }
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
            pushNewChatRoute()
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
      .task(id: activityFeedFingerprint) {
        rebuildActivityFeed()
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
      .navigationDestination(for: WorkNewChatRoute.self) { route in
        WorkNewChatScreen(
          lanes: lanes,
          preferredLaneId: route.preferredLaneId,
          onStarted: { summary, opener in
            let sessionId = summary.sessionId
            let trimmed = opener.trimmingCharacters(in: .whitespacesAndNewlines)
            optimisticSessions[sessionId] = makeOptimisticSession(for: summary)
            chatSummaries[sessionId] = summary
            selectedStatus = .all
            selectedLaneId = summary.laneId
            selectedSessionTransitionId = sessionId
            // Replace the new-chat page with the live session view so hitting
            // Back goes to the sidebar, not to an empty "Start a new chat"
            // form.
            var fresh = NavigationPath()
            fresh.append(WorkSessionRoute(sessionId: sessionId, openingPrompt: trimmed))
            path = fresh
            Task { @MainActor in
              await reload(refreshRemote: true)
            }
          },
          onRefreshLanes: { await reload(refreshRemote: true) }
        )
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

  var renamePresentedBinding: Binding<Bool> {
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

  var endPresentedBinding: Binding<Bool> {
    Binding(
      get: { endTarget != nil },
      set: { presented in
        if !presented {
          endTarget = nil
        }
      }
    )
  }

  var pollingKey: String {
    let ids = liveChatSessions.map(\.id).sorted().joined(separator: ",")
    // Intentionally omit `localStateRevision`: it changes constantly during host DB sync and was
    // restarting this poll loop while the list `.task(id:)` also reloaded sessions every tick.
    return "\(isLive)-\(ids)"
  }
}
