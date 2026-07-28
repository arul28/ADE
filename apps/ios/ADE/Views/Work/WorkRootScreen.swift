import SwiftUI
import UIKit
import AVKit


let workDateFormatter = ISO8601DateFormatter()
private let workRootBottomTabBarScrollMargin: CGFloat = 24

/// Keeps the Work view state attached to the active project+host scope and
/// writes it back as it changes.
///
/// Packaged as one `ViewModifier` rather than four inline `.onChange`s plus a
/// `.task`: `WorkRootScreen.body` is a long enough chain that adding five more
/// modifiers to it exceeds the Swift type-checker's budget and fails the build.
private struct WorkViewStateScopeModifier: ViewModifier {
  let hostIdentity: String?
  let filterPanelOpen: Bool
  let signature: WorkProjectViewState
  let applyScope: () -> Void
  let onFiltersOpened: () -> Void
  let persist: () -> Void

  func body(content: Content) -> some View {
    content
      // A machine switch changes the scope without changing the project id.
      .onChange(of: hostIdentity) { _, _ in applyScope() }
      // Opening the filters is the user taking the view back from a deeplink;
      // from here on their choices are theirs and get persisted again.
      .onChange(of: filterPanelOpen) { _, isOpen in
        if isOpen { onFiltersOpened() }
      }
      .onChange(of: signature) { _, _ in persist() }
      .task { applyScope() }
  }
}

func resolvedWorkArchivedSessionIds(
  localStorage: String,
  chatSummaries: [String: AgentChatSessionSummary],
  sessions: [TerminalSessionSummary] = []
) -> Set<String> {
  let local = Set(localStorage.split(separator: "\n").map(String.init))
  let archivedChats = Set(chatSummaries.values.compactMap { summary in
    summary.archivedAt == nil ? nil : summary.sessionId
  })
  let archivedSessions = Set(sessions.compactMap { session in
    session.archivedAt == nil ? nil : session.id
  })
  return local.union(archivedChats).union(archivedSessions)
}

func workPendingChatCreationMatchesProject(
  _ creation: PendingChatCreation,
  projectId: String?,
  projectRootPath: String?
) -> Bool {
  let creationId = creation.projectId?.trimmingCharacters(in: .whitespacesAndNewlines)
  let activeId = projectId?.trimmingCharacters(in: .whitespacesAndNewlines)
  if let creationId, !creationId.isEmpty, let activeId, !activeId.isEmpty, creationId == activeId {
    return true
  }
  let creationRoot = syncNormalizedProjectRootScope(creation.projectRootPath)
  let activeRoot = syncNormalizedProjectRootScope(projectRootPath)
  if let creationRoot, let activeRoot, creationRoot == activeRoot { return true }
  // Legacy pending rows predate project scoping; keep them visible in the
  // active project rather than orphaning an offline draft after upgrade.
  return (creationId == nil || creationId?.isEmpty == true) && creationRoot == nil
}

struct WorkSessionRoute: Hashable {
  let openId: UUID = UUID()
  let sessionId: String
  var openingPrompt: String? = nil
  var openingPromptDispatchHandled = false
  var openingDeliveryState: String? = nil
  var openingAttachments: [AgentChatFileRef] = []
}

struct WorkDraftChatSession {
  let summary: AgentChatSessionSummary
  let initialMessage: String?
}

struct WorkRootSessionPresentationTaskKey: Equatable {
  let sessions: [TerminalSessionSummary]
  let chatSummaries: [String: AgentChatSessionSummary]
  let lanes: [LaneSummary]
  let pullRequests: [PullRequestListItem]
  let githubPrs: [GitHubPrListItem]
  let optimisticSessions: [String: TerminalSessionSummary]
  let pendingChatCreations: [PendingChatCreation]
  let selectedLaneId: String
  let selectedStatus: WorkSessionStatusFilter
  let searchText: String
  let searchOutputRevision: Int?
  let archivedSessionIdsStorage: String
  let sessionOrganizationRaw: String
  /// The machine-wide roster is a faster projection than CRDT replication.
  /// Key the rebuild on its monotonic revision instead of comparing the full
  /// all-project payload during every unrelated SyncService publication.
  let activeRosterRevision: Int
  let activeProjectId: String?
  let loadedProjectionProjectId: String?
  let pendingLaneDeletionIds: Set<String>
  /// Bumped when the soonest snooze deadline lapses so the cached groups
  /// re-derive. Snooze expiry has no event to key on — it is pure clock math —
  /// so without this the row stays parked in the Snoozed tail until some
  /// unrelated change happens to rebuild the presentation.
  let snoozeEpoch: Int
}

struct WorkRootScreen: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @EnvironmentObject var syncService: SyncService
  /// App-level dictation singleton. Re-injected into pushed composer
  /// destinations below since `navigationDestination` builds outside the view
  /// tree and does not inherit environment objects.
  @EnvironmentObject var dictationController: DictationController
  @Namespace var sessionTransitionNamespace
  var isTabActive = true

  @State var sessions: [TerminalSessionSummary] = []
  @State var chatSummaries: [String: AgentChatSessionSummary] = [:]
  @State var lanes: [LaneSummary] = []
  /// ADE-mapped PRs (synced `pull_requests` table) used to tag each session's
  /// lane with its PR status next to the lane name. Combined with
  /// `syncService.laneGithubPrItems` for PRs opened outside ADE.
  @State var pullRequests: [PullRequestListItem] = []
  @State var sessionPresentation = WorkRootSessionPresentation.empty
  @State var sessionPresentationRebuildTask: Task<Void, Never>?
  @State var sessionPresentationRebuildGeneration = 0
  /// Exactly one pending wait, armed only while something is actually snoozed
  /// and only at the nearest deadline. Not a poll.
  @State var snoozeRegroupTask: Task<Void, Never>?
  @State var snoozeEpoch = 0
  @State var errorMessage: String?
  @State var path = NavigationPath()
  // Scoped per project+host through `WorkViewStateStore` rather than held in
  // flat global `@AppStorage`, so switching projects or machines restores that
  // scope's view instead of carrying the previous one over.
  @State var searchText = ""
  @State var selectedLaneId = "all"
  @State private var selectedStatusRawValue = WorkSessionStatusFilter.all.rawValue
  @State var renameTarget: TerminalSessionSummary?
  @State var renameText = ""
  @State var stopRuntimeTarget: TerminalSessionSummary?
  @State var optimisticSessions: [String: TerminalSessionSummary] = [:]
  @State var refreshFeedbackToken = 0
  @State var selectedSessionTransitionId: String?
  @State var isSelecting: Bool = false
  @State var selectedSessionIds: Set<String> = []
  /// Failures from an explicit user action (bulk selection commands and
  /// single-row lifecycle commands alike). Deliberately separate from
  /// `errorMessage`, which every successful projection load clears — an action
  /// the host rejected has to outlive the reload that reconciles the rollback.
  @State var actionErrorMessage: String?
  @State var bulkExportShare: WorkArtifactShareItem?
  @State var bulkBusy: Bool = false
  @State var bulkDeleteConfirmPresented: Bool = false
  @State var navigationMutationPending = false
  /// Coalesces expensive per-lane `listChatSessions` refreshes when the work projection bumps during CRDT sync.
  @State var lastCoalescedChatSummaryRefresh = Date.distantPast
  @State var lastWorkLocalProjectionReload = Date.distantPast
  @State var lastWorkProjectionReloadRevision: Int?
  /// Project scope currently represented by the local @State projections.
  /// This prevents an in-place project remap from briefly mixing old rows with
  /// the new project's live roster while the database reload catches up.
  @State var loadedProjectionProjectId: String?
  @AppStorage("ade.work.archivedSessionIds") var archivedSessionIdsStorage = ""
  @State var sessionOrganizationRaw = WorkSessionOrganization.byLane.rawValue
  @State var collapsedSectionIdsStorage = ""
  /// The project+host scope the five view-state properties above currently hold.
  @State private var workViewStateScopeKey: String?
  /// True while a lane deeplink is framing the view. Its filter reset is shown
  /// but never persisted, so following a notification cannot permanently
  /// overwrite the filters and grouping the user chose. Cleared once the user
  /// touches the filters themselves or the scope changes.
  @State var workViewStateDeeplinkActive = false
  /// Persisted base hidden beneath the current deeplink framing. User edits
  /// restore it first so changing one filter cannot save unrelated deeplink
  /// resets for grouping or collapsed sections.
  @State var workViewStateBeforeDeeplink: WorkProjectViewState?
  @State var filterPanelOpen = false
  @State var addLaneSheetPresented = false

  var selectedStatus: WorkSessionStatusFilter {
    get { WorkSessionStatusFilter(rawValue: selectedStatusRawValue) ?? .all }
    nonmutating set { selectedStatusRawValue = newValue.rawValue }
  }

  /// Scope the Work view state belongs to. Nil while no project is active, in
  /// which case nothing is written — a nil scope must never clobber a real
  /// project's saved view.
  private var currentWorkViewScopeKey: String? {
    WorkViewStateStore.scopeKey(
      projectId: syncService.activeProjectId,
      hostIdentity: syncService.activeProjectHostIdentity
    )
  }

  var currentWorkViewState: WorkProjectViewState {
    WorkProjectViewState(
      searchText: searchText,
      laneFilter: selectedLaneId,
      statusFilter: selectedStatusRawValue,
      organization: sessionOrganizationRaw,
      collapsedSectionIds: collapsedSectionIdsStorage
    )
  }

  /// Swaps the in-memory view state over to the active project+host, saving the
  /// outgoing scope first so switching away never drops what the user had.
  func applyWorkViewStateScope() {
    let nextScope = currentWorkViewScopeKey
    guard nextScope != workViewStateScopeKey else { return }
    if workViewStateScopeKey != nil { persistWorkViewState() }
    let restored = WorkViewStateStore.load(scope: nextScope)
    workViewStateScopeKey = nextScope
    workViewStateDeeplinkActive = false
    workViewStateBeforeDeeplink = nil
    searchText = restored.searchText
    selectedLaneId = restored.laneFilter
    selectedStatusRawValue = restored.statusFilter
    sessionOrganizationRaw = restored.organization
    collapsedSectionIdsStorage = restored.collapsedSectionIds
  }

  func persistWorkViewState() {
    guard let scope = workViewStateScopeKey, !workViewStateDeeplinkActive else { return }
    WorkViewStateStore.save(
      WorkProjectViewState(
        searchText: searchText,
        laneFilter: selectedLaneId,
        statusFilter: selectedStatusRawValue,
        organization: sessionOrganizationRaw,
        collapsedSectionIds: collapsedSectionIdsStorage
      ),
      scope: scope
    )
  }

  /// Ends transient deeplink framing without treating its reset values as user
  /// preferences. The next user mutation is applied on top of the saved base.
  func restoreWorkViewStateAfterDeeplink() {
    guard workViewStateDeeplinkActive else { return }
    let restored = workViewStateRestoringUserControl(
      savedBase: workViewStateBeforeDeeplink,
      current: currentWorkViewState
    )
    searchText = restored.searchText
    selectedLaneId = restored.laneFilter
    selectedStatusRawValue = restored.statusFilter
    sessionOrganizationRaw = restored.organization
    collapsedSectionIdsStorage = restored.collapsedSectionIds
    workViewStateDeeplinkActive = false
    workViewStateBeforeDeeplink = nil
  }

  var workStatus: SyncDomainStatus {
    syncService.status(for: .work)
  }

  var isLive: Bool {
    syncService.connectionState == .connected || syncService.connectionState == .syncing
  }

  var isLoadingSkeleton: Bool {
    workStatus.phase == .hydrating || workStatus.phase == .syncingInitialData
  }

  var archivedSessionIds: Set<String> {
    resolvedWorkArchivedSessionIds(
      localStorage: archivedSessionIdsStorage,
      chatSummaries: chatSummaries,
      sessions: sessions + Array(optimisticSessions.values)
    )
  }

  /// Synthesized optimistic rows for offline chat creations awaiting sync,
  /// keyed by their synthetic session id.
  var pendingChatCreationOptimisticSessions: [String: TerminalSessionSummary] {
    var result: [String: TerminalSessionSummary] = [:]
    for creation in syncService.pendingChatCreations where workPendingChatCreationMatchesProject(
      creation,
      projectId: syncService.activeProjectId,
      projectRootPath: syncService.activeProjectRootPath
    ) {
      let lane = lanes.first(where: { $0.id == creation.laneId })
      let session = workPendingChatCreationOptimisticSession(creation, lane: lane)
      result[session.id] = session
    }
    return result
  }

  var laneById: [String: LaneSummary] {
    sessionPresentation.laneById
  }

  var workOrderedLanes: [LaneSummary] {
    sessionPresentation.workOrderedLanes
  }

  /// PR status tag per lane id, merging ADE-mapped PRs with branch-matched
  /// GitHub PRs (same resolution the Lanes tab uses), so the Work session rows
  /// can show a minimal PR indicator beside the lane name.
  var lanePrTagsByLaneId: [String: LanePrTag] {
    sessionPresentation.lanePrTagsByLaneId
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
      set: {
        restoreWorkViewStateAfterDeeplink()
        sessionOrganizationRaw = $0.rawValue
      }
    )
  }

  var selectedStatusBinding: Binding<WorkSessionStatusFilter> {
    Binding(
      get: { selectedStatus },
      set: {
        restoreWorkViewStateAfterDeeplink()
        selectedStatus = $0
      }
    )
  }

  var searchTextBinding: Binding<String> {
    Binding(
      get: { searchText },
      set: {
        restoreWorkViewStateAfterDeeplink()
        searchText = $0
      }
    )
  }

  var selectedLaneBinding: Binding<String> {
    Binding(
      get: { selectedLaneId },
      set: {
        restoreWorkViewStateAfterDeeplink()
        selectedLaneId = $0
      }
    )
  }

  var collapsedSectionIds: Set<String> {
    workParseCollapsedSectionIds(collapsedSectionIdsStorage)
  }

  func toggleCollapsed(_ id: String) {
    restoreWorkViewStateAfterDeeplink()
    var ids = collapsedSectionIds
    if ids.contains(id) {
      ids.remove(id)
    } else {
      ids.insert(id)
    }
    collapsedSectionIdsStorage = workSerializeCollapsedSectionIds(ids)
  }

  /// A quiet expansion belongs only to the current quiet spell. Once a lane
  /// contains real work again, discard its inverted marker so the next
  /// all-quiet transition returns to the thin collapsed row.
  func pruneStaleQuietOpenMarkers(sessions: [TerminalSessionSummary]) {
    var ids = collapsedSectionIds
    var removedMarkers = Set<String>()
    for marker in ids.filter({ $0.hasPrefix("lane-open:") }) {
      let laneId = String(marker.dropFirst("lane-open:".count))
      guard sessions.contains(where: { $0.laneId == laneId }) else { continue }
      if !workLaneSessionsAreQuiet(
        laneId: laneId,
        sessions: sessions,
        chatSummaries: chatSummaries,
        archivedSessionIds: archivedSessionIds,
        now: Date()
      ) {
        ids.remove(marker)
        removedMarkers.insert(marker)
      }
    }
    if !removedMarkers.isEmpty {
      collapsedSectionIdsStorage = workSerializeCollapsedSectionIds(ids)
      if var base = workViewStateBeforeDeeplink {
        var baseIds = workParseCollapsedSectionIds(base.collapsedSectionIds)
        baseIds.subtract(removedMarkers)
        base.collapsedSectionIds = workSerializeCollapsedSectionIds(baseIds)
        workViewStateBeforeDeeplink = base
      }
    }
  }

  func pushNewChatRoute() {
    guard !navigationMutationPending else { return }
    let preferred = selectedLaneId == "all" ? nil : selectedLaneId
    navigationMutationPending = true
    selectedSessionTransitionId = nil
    Task { @MainActor in
      await Task.yield()
      path.append(WorkNewChatRoute(preferredLaneId: preferred))
      navigationMutationPending = false
    }
  }

  func presentAddLaneSheet() {
    guard isLive else { return }
    addLaneSheetPresented = true
  }

  var sessionGroups: [WorkSessionGroup] {
    sessionPresentation.sessionGroups
  }

  var isWorkRootActive: Bool {
    isTabActive && path.isEmpty
  }

  var sessionPresentationTaskKey: WorkRootSessionPresentationTaskKey? {
    guard isWorkRootActive else { return nil }
    return WorkRootSessionPresentationTaskKey(
      sessions: sessions,
      chatSummaries: chatSummaries,
      lanes: lanes,
      pullRequests: pullRequests,
      githubPrs: syncService.laneGithubPrItems,
      optimisticSessions: optimisticSessions,
      pendingChatCreations: syncService.pendingChatCreations,
      selectedLaneId: selectedLaneId,
      selectedStatus: selectedStatus,
      searchText: searchText,
      searchOutputRevision: searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : syncService.terminalBufferRevision,
      archivedSessionIdsStorage: archivedSessionIdsStorage,
      sessionOrganizationRaw: sessionOrganizationRaw,
      activeRosterRevision: syncService.rosterRevision(for: syncService.activeProject),
      activeProjectId: syncService.activeProjectId,
      loadedProjectionProjectId: loadedProjectionProjectId,
      pendingLaneDeletionIds: syncService.pendingLaneDeletionIds,
      snoozeEpoch: snoozeEpoch
    )
  }

  var workProjectionReloadKey: Int? {
    isWorkRootActive ? syncService.workProjectionRevision : nil
  }

  var workSessionNavigationRequestKey: String? {
    syncService.requestedWorkSessionNavigation?.id
  }

  var workLaneNavigationRequestKey: String? {
    syncService.requestedWorkLaneNavigation?.id
  }

  var body: some View {
    NavigationStack(path: $path) {
      ScrollViewReader { proxy in
        workList(proxy: proxy)
      }
    }
  }

  private func workList(proxy: ScrollViewProxy) -> some View {
    List {
        if isLoadingSkeleton && sessions.isEmpty && optimisticSessions.isEmpty {
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
            searchText: searchTextBinding,
            selectedLaneId: selectedLaneBinding,
            selectedStatus: selectedStatusBinding,
            organization: sessionOrganizationBinding,
            filterOpen: $filterPanelOpen,
            lanes: workOrderedLanes,
            liveCount: globalLiveSessionCount,
            needsInputCount: globalNeedsInputCount,
            isLive: isLive,
            onClear: clearWorkFilters,
            onNewChat: pushNewChatRoute,
            onAddLane: presentAddLaneSheet
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
              workSessionGroupRows(group)
            }
          }
        }
      }
      .listStyle(.plain)
      .listSectionSpacing(.compact)
      .scrollContentBackground(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .contentMargins(.bottom, workRootBottomTabBarScrollMargin, for: .scrollContent)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .navigationBar)
      .safeAreaInset(edge: .top, spacing: 0) {
        ADERootTopBar(
          title: isSelecting ? "\(selectedSessionIds.count) selected" : "Work",
          showsSettings: !isSelecting
        ) {
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
                    openSession(target)
                  }
                }
              )
            }
            // Real-Linear-logo button, immediately left of the bell; gated on the
            // active project's Linear connection.
            LinearPaneToolbarButton()
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
            onStopRuntime: { Task { await performBulkStopRuntime() } },
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
      .sheet(isPresented: $addLaneSheetPresented) {
        AddLaneSheet(
          primaryLane: lanes.first(where: { $0.laneType == "primary" }),
          lanes: lanes,
          onLaneCreated: { createdLaneId in
            addLaneSheetPresented = false
            restoreWorkViewStateAfterDeeplink()
            selectedLaneId = createdLaneId
            await reload(refreshRemote: true)
          }
        )
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
      .alert("Action failed",
             isPresented: Binding(
               get: { actionErrorMessage != nil },
               set: { if !$0 { actionErrorMessage = nil } }
             ),
             presenting: actionErrorMessage) { _ in
        Button("OK", role: .cancel) { actionErrorMessage = nil }
      } message: { message in
        Text(message)
      }
      .refreshable {
        await refreshFromPullGesture()
      }
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .onChange(of: syncService.activeProjectId) { _, projectId in
        applyWorkViewStateScope()
        resetWorkProjectionForProjectChange(projectId)
      }
      .modifier(WorkViewStateScopeModifier(
        hostIdentity: syncService.activeProjectHostIdentity,
        filterPanelOpen: filterPanelOpen,
        signature: currentWorkViewState,
        applyScope: applyWorkViewStateScope,
        onFiltersOpened: restoreWorkViewStateAfterDeeplink,
        persist: persistWorkViewState
      ))
      .task(id: workProjectionReloadKey) {
        guard let revision = workProjectionReloadKey else { return }
        guard lastWorkProjectionReloadRevision != revision || sessions.isEmpty else { return }
        let now = Date()
        if !sessions.isEmpty {
          let elapsed = now.timeIntervalSince(lastWorkLocalProjectionReload)
          let minimumProjectionReloadInterval = syncService.prefersReducedSyncLoad ? 1.2 : 0.75
          if elapsed < minimumProjectionReloadInterval {
            try? await Task.sleep(for: .milliseconds(max(1, Int((minimumProjectionReloadInterval - elapsed) * 1_000))))
            guard !Task.isCancelled, workProjectionReloadKey == revision else { return }
          }
        }
        lastWorkLocalProjectionReload = Date()
        await reloadFromPersistedProjection()
        guard !Task.isCancelled, workProjectionReloadKey == revision else { return }
        lastWorkProjectionReloadRevision = revision
      }
      .task(id: sessionPresentationTaskKey) {
        guard sessionPresentationTaskKey != nil else {
          sessionPresentationRebuildTask?.cancel()
          sessionPresentationRebuildTask = nil
          // Nothing is rendering the groups, so nothing needs waking.
          cancelSnoozeRegroupRefresh()
          return
        }
        scheduleSessionPresentationRebuild()
        await hydrateSearchOutputBuffersIfNeeded()
      }
      .task(id: workSessionNavigationRequestKey) {
        guard isTabActive, workSessionNavigationRequestKey != nil else { return }
        await handleRequestedWorkSessionNavigation()
      }
      .task(id: workLaneNavigationRequestKey) {
        guard isTabActive, workLaneNavigationRequestKey != nil else { return }
        await handleRequestedWorkLaneNavigation(proxy: proxy)
      }
      .onAppear {
        guard isTabActive else { return }
        if syncService.requestedWorkLaneNavigation != nil {
          Task { await handleRequestedWorkLaneNavigation(proxy: proxy) }
        }
      }
      .onChange(of: isTabActive) { _, active in
        guard active else { return }
        if syncService.requestedWorkLaneNavigation != nil {
          Task { await handleRequestedWorkLaneNavigation(proxy: proxy) }
        }
        if syncService.requestedWorkSessionNavigation != nil {
          Task { await handleRequestedWorkSessionNavigation() }
        }
      }
      .onChange(of: syncService.requestedWorkLaneNavigation?.id) { _, requestId in
        guard isTabActive, requestId != nil else { return }
        Task { await handleRequestedWorkLaneNavigation(proxy: proxy) }
      }
      .navigationDestination(for: WorkSessionRoute.self) { route in
        let routeTransitionNamespace = route.openingPrompt == nil && selectedSessionTransitionId == route.sessionId
          ? (ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? sessionTransitionNamespace : nil)
          : nil
        let initialSession = optimisticSessions[route.sessionId]
          ?? mergedSessions.first(where: { $0.id == route.sessionId })
        WorkSessionDestinationView(
          sessionId: route.sessionId,
          initialOpeningPrompt: route.openingPrompt,
          initialOpeningPromptDispatchHandled: route.openingPromptDispatchHandled,
          initialOpeningDeliveryState: route.openingDeliveryState,
          initialOpeningAttachments: route.openingAttachments,
          initialSession: initialSession,
          initialChatSummary: chatSummaries[route.sessionId],
          initialTranscript: nil,
          transitionNamespace: routeTransitionNamespace,
          isLive: isLive,
          navigationChrome: .pushedDetail,
          // `sessionPresentationTaskKey` goes nil once a screen is pushed off the
          // root, so `workOrderedLanes` stops refreshing here — fall back to the
          // live `lanes` when the presentation-derived order isn't available.
          lanes: workOrderedLanes.isEmpty ? lanes : workOrderedLanes
        )
        .equatable()
        .id(route.openId)
        .environmentObject(syncService)
        .environmentObject(dictationController)
      }
      .navigationDestination(for: WorkNewChatRoute.self) { route in
        WorkNewChatScreen(
          lanes: workOrderedLanes.isEmpty ? lanes : workOrderedLanes,
          preferredLaneId: route.preferredLaneId,
          activeProjectId: syncService.activeProjectId,
          activeProjectRootPath: syncService.activeProjectRootPath,
          onStarted: { summary, opener, openerDispatchHandled, openerDeliveryState, openerAttachments in
            let sessionId = summary.sessionId
            let trimmed = opener.trimmingCharacters(in: .whitespacesAndNewlines)
            optimisticSessions[sessionId] = makeOptimisticSession(for: summary)
            chatSummaries[sessionId] = summary
            syncService.cacheChatSummary(summary)
            selectedSessionTransitionId = nil
            // Replace the new-chat page with the live session view so hitting
            // Back goes to the sidebar, not to an empty "Start a new chat"
            // form.
            var fresh = NavigationPath()
            fresh.append(WorkSessionRoute(
              sessionId: sessionId,
              openingPrompt: trimmed.isEmpty ? nil : trimmed,
              openingPromptDispatchHandled: openerDispatchHandled,
              openingDeliveryState: openerDeliveryState,
              openingAttachments: openerAttachments
            ))
            await Task.yield()
            path = fresh
            Task { @MainActor in
              await reload(refreshRemote: true)
            }
          },
          onCliStarted: { session in
            optimisticSessions[session.id] = session
            selectedSessionTransitionId = nil
            var fresh = NavigationPath()
            fresh.append(WorkSessionRoute(sessionId: session.id))
            await Task.yield()
            path = fresh
            Task { @MainActor in
              await reload(refreshRemote: true)
            }
          },
          onChatImported: { summary in
            let chatSessionId = summary.sessionId
            optimisticSessions[chatSessionId] = makeOptimisticSession(for: summary)
            chatSummaries[chatSessionId] = summary
            syncService.cacheChatSummary(summary)
            selectedSessionTransitionId = nil
            var fresh = NavigationPath()
            fresh.append(WorkSessionRoute(sessionId: chatSessionId))
            await Task.yield()
            path = fresh
            Task { @MainActor in
              await reload(refreshRemote: true)
            }
          },
          onRefreshLanes: { await reload(refreshRemote: true) }
        )
        .environmentObject(syncService)
        .environmentObject(dictationController)
      }
      .alert("Rename session", isPresented: renamePresentedBinding) {
        TextField("Title", text: $renameText)
        Button("Cancel", role: .cancel) {
          renameTarget = nil
        }
        Button("Save") {
          let target = renameTarget
          let title = renameText
          Task { await submitRename(target: target, title: title) }
        }
      } message: {
        Text("Give this session a clearer title for search, pinning, and activity tracking.")
      }
      .alert("Stop runtime?", isPresented: stopRuntimePresentedBinding, presenting: stopRuntimeTarget) { session in
        Button("Cancel", role: .cancel) {
          stopRuntimeTarget = nil
        }
        Button("Stop", role: .destructive) {
          Task { await stopRuntime(session) }
        }
      } message: { session in
        Text("ADE will stop the running process. The saved session stays available unless you delete it.")
      }
  }

  /// A quiet lane is collapsed unless explicitly expanded; every other section
  /// is expanded unless explicitly collapsed.
  private func workGroupIsCollapsed(_ group: WorkSessionGroup) -> Bool {
    group.isQuiet
      ? !collapsedSectionIds.contains(group.quietOpenSectionId)
      : collapsedSectionIds.contains(group.id)
  }

  @ViewBuilder
  private func workSessionGroupRows(_ group: WorkSessionGroup) -> some View {
    let isLaneDeleting = group.laneId.map(syncService.pendingLaneDeletionIds.contains) ?? false
    let collapsed = workGroupIsCollapsed(group)
    let isQuietRow = group.isQuiet && collapsed
    WorkSidebarSectionHeader(
      group: group,
      collapsed: collapsed,
      onToggle: {
        withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
          toggleCollapsed(group.isQuiet ? group.quietOpenSectionId : group.id)
        }
      },
      pullRequest: group.laneId.flatMap { lanePrTagsByLaneId[$0] },
      onOpenPullRequest: { tag in
        openLanePullRequest(tag: tag, laneId: group.laneId)
      }
    )
    .disabled(isLaneDeleting)
    .redacted(reason: isLaneDeleting ? .placeholder : [])
    .id(group.id)
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
    .listRowInsets(EdgeInsets(
      top: isQuietRow ? 2 : 8,
      leading: 16,
      bottom: isQuietRow ? 0 : 2,
      trailing: 16
    ))

    if !collapsed {
      ForEach(group.sessions.filter { sessionPresentation.topLevelDisplaySessionIds.contains($0.id) }) { session in
        // An expanded quiet lane holds only settled rows: the full card's
        // preview line and meta row are about work in flight, of which there is
        // none here.
        workSessionRows(session, compact: group.isQuiet)
      }
    }
  }

  @ViewBuilder
  private func workSessionRows(
    _ session: TerminalSessionSummary,
    compact: Bool = false
  ) -> some View {
    WorkSessionListRow(
      session: session,
      lane: laneById[session.laneId],
      // Fall back to the resolved lane (name/branch match) so legacy sessions
      // with a stale laneId still surface their PR shortcut.
      pullRequest: lanePrTagsByLaneId[session.laneId]
        ?? lanePrTagsByLaneId[resolvedWorkNavigationLaneId(for: session, lanes: lanes)],
      chatSummary: chatSummaries[session.id],
      isArchived: archivedSessionIds.contains(session.id),
      transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion)
        ? sessionTransitionNamespace
        : nil,
      compact: compact,
      isLaneDeleting: syncService.pendingLaneDeletionIds.contains(session.laneId),
      selectedSessionId: $selectedSessionTransitionId,
      isSelecting: isSelecting,
      isChecked: selectedSessionIds.contains(session.id),
      onLongPressSelect: startSelection,
      onToggleSelect: toggleSelection,
      onOpen: openSession,
      onPin: togglePin,
      onRename: beginRename,
      onStopRuntime: { session in stopRuntimeTarget = session },
      onDelete: deleteChatSession,
      onCopyId: copySessionId,
      onCopyDeepLink: copySessionDeepLink,
      onGoToLane: goToLane,
      onOpenPullRequest: openPullRequest,
      lifecycleAvailable: syncService.supportsSessionLifecycleActions,
      snoozeAvailable: syncService.supportsSessionSnoozeActions,
      onSettle: settleSession,
      onUnsettle: unsettleSession,
      onKeepActive: keepSessionActive,
      onSnooze: snoozeSession,
      onWake: wakeSession
    )
    .id(session.id)
    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)

    if let childGroup = sessionPresentation.childGroupsByParentId[session.id] {
      WorkChildShellSection(
        group: childGroup,
        collapsed: collapsedSectionIds.contains(childGroup.collapsedSectionId),
        onToggle: {
          withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
            toggleCollapsed(childGroup.collapsedSectionId)
          }
        }
      ) {
        ForEach(childGroup.children) { child in
          WorkSessionListRow(
            session: child,
            lane: laneById[child.laneId],
            pullRequest: lanePrTagsByLaneId[child.laneId]
              ?? lanePrTagsByLaneId[resolvedWorkNavigationLaneId(for: child, lanes: lanes)],
            chatSummary: chatSummaries[child.id],
            isArchived: archivedSessionIds.contains(child.id),
            transitionNamespace: nil,
            compact: true,
            isLaneDeleting: syncService.pendingLaneDeletionIds.contains(child.laneId),
            selectedSessionId: $selectedSessionTransitionId,
            isSelecting: isSelecting,
            isChecked: selectedSessionIds.contains(child.id),
            onLongPressSelect: startSelection,
            onToggleSelect: toggleSelection,
            onOpen: openSession,
            onPin: togglePin,
            onRename: beginRename,
            onStopRuntime: { session in stopRuntimeTarget = session },
            onDelete: deleteChatSession,
            onCopyId: copySessionId,
            onCopyDeepLink: copySessionDeepLink,
            onGoToLane: goToLane,
            onOpenPullRequest: openPullRequest,
            lifecycleAvailable: syncService.supportsSessionLifecycleActions,
            snoozeAvailable: syncService.supportsSessionSnoozeActions,
            onSettle: settleSession,
            onUnsettle: unsettleSession,
            onKeepActive: keepSessionActive,
            onSnooze: snoozeSession,
            onWake: wakeSession
          )
          .id(child.id)
        }
      }
      .listRowInsets(EdgeInsets(top: 0, leading: 30, bottom: 6, trailing: 16))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
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

  var stopRuntimePresentedBinding: Binding<Bool> {
    Binding(
      get: { stopRuntimeTarget != nil },
      set: { presented in
        if !presented {
          stopRuntimeTarget = nil
        }
      }
    )
  }

  func clearWorkFilters() {
    restoreWorkViewStateAfterDeeplink()
    searchText = ""
    selectedLaneId = "all"
    selectedStatus = .all
  }
}
