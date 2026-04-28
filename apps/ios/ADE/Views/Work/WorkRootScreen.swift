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

struct WorkRootSessionPresentationTaskKey: Equatable {
  let sessions: [TerminalSessionSummary]
  let chatSummaries: [String: AgentChatSessionSummary]
  let lanes: [LaneSummary]
  let optimisticSessions: [String: TerminalSessionSummary]
  let selectedLaneId: String
  let selectedStatus: WorkSessionStatusFilter
  let searchText: String
  let archivedSessionIdsStorage: String
  let sessionOrganizationRaw: String
}

struct WorkRootScreen: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @EnvironmentObject var syncService: SyncService
  @Namespace var sessionTransitionNamespace
  var isTabActive = true

  @State var sessions: [TerminalSessionSummary] = []
  @State var chatSummaries: [String: AgentChatSessionSummary] = [:]
  @State var lanes: [LaneSummary] = []
  @State var transcriptCache: [String: [WorkChatEnvelope]] = [:]
  @State var sessionPresentation = WorkRootSessionPresentation.empty
  @State var sessionPresentationRebuildTask: Task<Void, Never>?
  @State var sessionPresentationRebuildGeneration = 0
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
  @State var isSelecting: Bool = false
  @State var selectedSessionIds: Set<String> = []
  @State var bulkActionErrorMessage: String?
  @State var bulkExportShare: WorkArtifactShareItem?
  @State var bulkBusy: Bool = false
  @State var bulkDeleteConfirmPresented: Bool = false
  @State var navigationMutationPending = false
  /// Coalesces expensive per-lane `listChatSessions` refreshes when `localStateRevision` bumps during CRDT sync.
  @State var lastCoalescedChatSummaryRefresh = Date.distantPast
  @State var lastWorkLocalProjectionReload = Date.distantPast
  @State var lastWorkProjectionReloadRevision: Int?
  @AppStorage("ade.work.archivedSessionIds") var archivedSessionIdsStorage = ""
  @AppStorage("ade.work.sessionOrganization") var sessionOrganizationRaw = WorkSessionOrganization.byLane.rawValue
  @AppStorage("ade.work.collapsedSectionIds") var collapsedSectionIdsStorage = ""
  @State var filterPanelOpen = false

  var workStatus: SyncDomainStatus {
    syncService.status(for: .work)
  }

  var isLive: Bool {
    workStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  var isLoadingSkeleton: Bool {
    workStatus.phase == .hydrating || workStatus.phase == .syncingInitialData
  }

  var archivedSessionIds: Set<String> {
    let local = Set(archivedSessionIdsStorage.split(separator: "\n").map(String.init))
    var result = Set<String>()
    for summary in chatSummaries.values {
      if summary.archivedAt != nil {
        result.insert(summary.sessionId)
      }
    }
    let remoteKnownIds = Set(chatSummaries.values.map { $0.sessionId })
    for id in local where !remoteKnownIds.contains(id) {
      result.insert(id)
    }
    return result
  }

  var laneById: [String: LaneSummary] {
    Dictionary(lanes.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
  }

  var mergedSessions: [TerminalSessionSummary] {
    sessionPresentation.mergedSessions
  }

  var displaySessions: [TerminalSessionSummary] {
    sessionPresentation.displaySessions
  }

  var liveChatSessions: [TerminalSessionSummary] {
    sessionPresentation.liveChatSessions
  }

  var hasActiveFilters: Bool {
    selectedStatus != .all
      || selectedLaneId != "all"
      || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var globalNeedsInputCount: Int {
    sessionPresentation.globalNeedsInputCount
  }

  var globalLiveSessionCount: Int {
    sessionPresentation.globalLiveSessionCount
  }

  var firstGlobalAttentionSession: TerminalSessionSummary? {
    guard let id = sessionPresentation.firstGlobalAttentionSessionId else { return nil }
    return mergedSessions.first { $0.id == id }
  }

  var firstGlobalLiveSession: TerminalSessionSummary? {
    guard let id = sessionPresentation.firstGlobalLiveSessionId else { return nil }
    return mergedSessions.first { $0.id == id }
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
    guard !navigationMutationPending else { return }
    let preferred = selectedLaneId == "all" ? lanes.first?.id : selectedLaneId
    navigationMutationPending = true
    selectedSessionTransitionId = nil
    Task { @MainActor in
      await Task.yield()
      path.append(WorkNewChatRoute(preferredLaneId: preferred))
      navigationMutationPending = false
    }
  }

  var sessionGroups: [WorkSessionGroup] {
    sessionPresentation.sessionGroups
  }

  var isWorkRootActive: Bool {
    isTabActive && path.isEmpty
  }

  var sessionPresentationTaskKey: WorkRootSessionPresentationTaskKey {
    WorkRootSessionPresentationTaskKey(
      sessions: sessions,
      chatSummaries: chatSummaries,
      lanes: lanes,
      optimisticSessions: optimisticSessions,
      selectedLaneId: selectedLaneId,
      selectedStatus: selectedStatus,
      searchText: searchText,
      archivedSessionIdsStorage: archivedSessionIdsStorage,
      sessionOrganizationRaw: sessionOrganizationRaw
    )
  }

  var workProjectionReloadKey: Int? {
    isWorkRootActive ? syncService.localStateRevision : nil
  }

  var body: some View {
    NavigationStack(path: $path) {
      ScrollViewReader { proxy in
      List {
        if isLoadingSkeleton {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          }
        } else {
          // Per-screen hydration banners are suppressed when the host is
          // unreachable; the root toolbar connection button is the single
          // source of truth for connection state. Genuine mid-sync failures
          // while connected still show below via `errorMessage`.
          if !syncService.connectionState.isHostUnreachable,
            let hydrationNotice = workStatus.inlineHydrationFailureNotice(for: .work)
          {
            ADENoticeCard(
              title: hydrationNotice.title,
              message: hydrationNotice.message,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          }
          WorkFiltersSection(
            searchText: $searchText,
            selectedLaneId: $selectedLaneId,
            selectedStatus: $selectedStatus,
            organization: sessionOrganizationBinding,
            filterOpen: $filterPanelOpen,
            lanes: lanes,
            liveCount: globalLiveSessionCount,
            needsInputCount: globalNeedsInputCount,
            isLive: isLive,
            onClear: clearWorkFilters,
            onNewChat: pushNewChatRoute
          )
          .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 8, trailing: 16))
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)

          if let errorMessage,
            workStatus.phase == .ready,
            !syncService.connectionState.isHostUnreachable
          {
            ADENoticeCard(
              title: "Work view error",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
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
            .listRowInsets(EdgeInsets(top: 24, leading: 16, bottom: 16, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          } else {
            ForEach(sessionGroups) { group in
              WorkSidebarSectionHeader(
                group: group,
                collapsed: collapsedSectionIds.contains(group.id),
                onToggle: {
                  withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
                    toggleCollapsed(group.id)
                  }
                }
              )
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
              .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 2, trailing: 16))

              if !collapsedSectionIds.contains(group.id) {
                ForEach(group.sessions) { session in
                  WorkSessionListRow(
                    session: session,
                    lane: laneById[session.laneId],
                    chatSummary: chatSummaries[session.id],
                    isArchived: archivedSessionIds.contains(session.id),
                    transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? sessionTransitionNamespace : nil,
                    selectedSessionId: $selectedSessionTransitionId,
                    isSelecting: isSelecting,
                    isChecked: selectedSessionIds.contains(session.id),
                    onLongPressSelect: startSelection,
                    onToggleSelect: toggleSelection,
                    onOpen: openSession,
                    onArchive: toggleArchive,
                    onPin: togglePin,
                    onRename: beginRename,
                    onEnd: { session in endTarget = session },
                    onDelete: deleteChatSession,
                    onResume: resumeSession,
                    onCopyId: copySessionId,
                    onGoToLane: goToLane
                  )
                  .id(session.id)
                  .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                  .listRowBackground(Color.clear)
                  .listRowSeparator(.hidden)
                }
              }
            }
          }
        }
      }
      .listStyle(.plain)
      .listSectionSpacing(.compact)
      .scrollContentBackground(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .contentMargins(.bottom, 72, for: .scrollContent)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .navigationBar)
      .safeAreaInset(edge: .top, spacing: 0) {
        ADERootTopBar(title: isSelecting ? "\(selectedSessionIds.count) selected" : "Work") {
          if isSelecting {
            Button("Cancel") {
              exitSelectionMode()
            }
            .accessibilityLabel("Cancel selection")
          } else {
            if globalLiveSessionCount > 0 || globalNeedsInputCount > 0 {
              WorkLiveCountPill(
                liveCount: globalLiveSessionCount,
                attentionCount: globalNeedsInputCount,
                onTap: {
                  guard let target = firstGlobalAttentionSession ?? firstGlobalLiveSession else { return }
                  if sessionPresentation.displaySessionIds.contains(target.id) {
                    withAnimation(.snappy) {
                      proxy.scrollTo(target.id, anchor: .top)
                    }
                  } else {
                    withAnimation(.snappy) {
                      selectedStatus = .all
                      selectedLaneId = "all"
                      searchText = ""
                    }
                    Task { @MainActor in
                      await Task.yield()
                      withAnimation(.snappy) {
                        proxy.scrollTo(target.id, anchor: .top)
                      }
                    }
                  }
                }
              )
            }
          }
        }
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if isSelecting {
          WorkSelectionActionBar(
            selectedCount: selectedSessionIds.count,
            runningCount: bulkSelectedRunningCount,
            deletableCount: bulkSelectedDeletableCount,
            archivableCount: bulkSelectedArchivableCount,
            restorableCount: bulkSelectedRestorableCount,
            busy: bulkBusy,
            onClose: { Task { await performBulkClose() } },
            onArchive: { Task { await performBulkArchive() } },
            onRestore: { Task { await performBulkRestore() } },
            onDelete: { bulkDeleteConfirmPresented = true },
            onExport: performBulkExport
          )
          .transition(.move(edge: .bottom).combined(with: .opacity))
        }
      }
      .onChange(of: mergedSessions.map(\.id)) { _, newIds in
        let visible = Set(newIds)
        let pruned = selectedSessionIds.intersection(visible)
        if pruned.count != selectedSessionIds.count {
          selectedSessionIds = pruned
          if pruned.isEmpty && isSelecting {
            withAnimation(.snappy) { isSelecting = false }
          }
        }
      }
      .onChange(of: path.count) { _, newCount in
        if newCount == 0, selectedSessionTransitionId != nil {
          selectedSessionTransitionId = nil
        }
      }
      .sheet(item: $bulkExportShare) { share in
        WorkActivityViewController(items: share.items)
      }
      .alert("Delete \(bulkSelectedDeletableCount) chat\(bulkSelectedDeletableCount == 1 ? "" : "s")?",
             isPresented: $bulkDeleteConfirmPresented) {
        Button("Cancel", role: .cancel) {}
        Button("Delete", role: .destructive) {
          Task { await performBulkDelete() }
        }
      } message: {
        Text("This permanently removes the saved chat history from ADE.")
      }
      .alert("Selection action failed",
             isPresented: Binding(
               get: { bulkActionErrorMessage != nil },
               set: { if !$0 { bulkActionErrorMessage = nil } }
             ),
             presenting: bulkActionErrorMessage) { _ in
        Button("OK", role: .cancel) { bulkActionErrorMessage = nil }
      } message: { message in
        Text(message)
      }
      .refreshable {
        await refreshFromPullGesture()
      }
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task(id: workProjectionReloadKey) {
        guard let revision = workProjectionReloadKey else { return }
        guard lastWorkProjectionReloadRevision != revision || sessions.isEmpty else { return }
        let now = Date()
        if !sessions.isEmpty {
          let elapsed = now.timeIntervalSince(lastWorkLocalProjectionReload)
          if elapsed < 0.35 {
            try? await Task.sleep(for: .milliseconds(max(1, Int((0.35 - elapsed) * 1_000))))
            guard !Task.isCancelled, workProjectionReloadKey == revision else { return }
          }
        }
        lastWorkLocalProjectionReload = Date()
        await reloadFromPersistedProjection()
        guard !Task.isCancelled, workProjectionReloadKey == revision else { return }
        lastWorkProjectionReloadRevision = revision
      }
      .task(id: sessionPresentationTaskKey) {
        scheduleSessionPresentationRebuild()
      }
      .task(id: pollingKey) {
        await pollRunningChats()
      }
      .navigationDestination(for: WorkSessionRoute.self) { route in
        let routeTransitionNamespace = route.openingPrompt == nil && selectedSessionTransitionId == route.sessionId
          ? (ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? sessionTransitionNamespace : nil)
          : nil
        WorkSessionDestinationView(
          sessionId: route.sessionId,
          initialOpeningPrompt: route.openingPrompt,
          initialSession: mergedSessions.first(where: { $0.id == route.sessionId }),
          initialChatSummary: chatSummaries[route.sessionId],
          initialTranscript: transcriptCache[route.sessionId],
          transitionNamespace: routeTransitionNamespace,
          isLive: isLive,
          navigationChrome: .pushedDetail,
          lanes: lanes
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
            syncService.cacheChatSummary(summary)
            selectedStatus = .all
            selectedLaneId = summary.laneId
            selectedSessionTransitionId = nil
            // Replace the new-chat page with the live session view so hitting
            // Back goes to the sidebar, not to an empty "Start a new chat"
            // form.
            var fresh = NavigationPath()
            fresh.append(WorkSessionRoute(sessionId: sessionId, openingPrompt: trimmed))
            await Task.yield()
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
        Button("Close", role: .destructive) {
          Task { await endSession(session) }
        }
      } message: { session in
        Text(isChatSession(session)
          ? "ADE will ask the host to stop this chat and keep the transcript available for review."
          : "ADE will stop streaming new terminal output for this session.")
      }
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
    guard isWorkRootActive else { return "paused" }
    let ids = liveChatSessions.map(\.id).sorted().joined(separator: ",")
    // Intentionally omit `localStateRevision`: it changes constantly during host DB sync and was
    // restarting this poll loop while the list `.task(id:)` also reloaded sessions every tick.
    return "\(isLive)-\(ids)"
  }

  func clearWorkFilters() {
    searchText = ""
    selectedLaneId = "all"
    selectedStatus = .all
  }
}
