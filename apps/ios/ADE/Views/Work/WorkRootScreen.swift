import SwiftUI
import UIKit
import AVKit


let workDateFormatter = ISO8601DateFormatter()
private let workRootBottomTabBarScrollMargin: CGFloat = 24

/// The chats to prefetch: the first `topCount` chat rows in display order,
/// plus every chat whose turn is running.
func workChatPrefetchSessionIds(
  _ sessions: [TerminalSessionSummary],
  topCount: Int = 6
) -> [String] {
  var ids: [String] = []
  var seen = Set<String>()
  for session in sessions where isChatSession(session) {
    let live = normalizedWorkChatSessionStatus(session: session, summary: nil) == "active"
    guard ids.count < topCount || live else { continue }
    if seen.insert(session.id).inserted { ids.append(session.id) }
  }
  return ids
}

/// Keeps the Work view state attached to the active project+host scope and
/// writes it back as it changes.
///
/// Packaged as one `ViewModifier` rather than four inline `.onChange`s plus a
/// `.task`: `WorkRootListScreen.body` is a long enough chain that adding five
/// more modifiers to it exceeds the Swift type-checker's budget and fails the
/// build.
/// Bookkeeping the list keeps across renders that must never invalidate it
/// (a reference, so writes are not state changes).
final class WorkRootBookkeeping {
  /// Last set handed to `warmChatThreads`, so the prefetch fires only when the
  /// set of chats worth warming changes.
  var lastPrefetchSessionIds: [String] = []
}

/// Mirrors `terminalBufferRevision` into the list only while a search is
/// typed. Terminal output streams constantly and the list only cares about it
/// when output is being searched; outside that the handler returns without a
/// state write, so streaming output never wakes the list.
private struct WorkSearchOutputRevisionModifier: ViewModifier {
  let publisher: Published<Int>.Publisher
  let isSearching: Bool
  @Binding var revision: Int

  func body(content: Content) -> some View {
    content.onReceive(publisher) { next in
      guard isSearching, revision != next else { return }
      revision = next
    }
  }
}

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

/// What re-runs the presentation rebuild. Scalars only: the list's own rows
/// are represented by `projectionDataRevision`, which bumps whenever any of the
/// five row sources changes, so no body evaluation compares whole arrays.
struct WorkRootSessionPresentationTaskKey: Equatable {
  let projectionDataRevision: Int
  let selectedLaneId: String
  let selectedStatus: WorkSessionStatusFilter
  let searchText: String
  let searchOutputRevision: Int?
  let archivedSessionIdsStorage: String
  let sessionOrganizationRaw: String
  /// Everything the rebuild reads off `SyncService` that can change it: the
  /// active roster revision, launches, pending creations, GitHub PRs, lane
  /// deletions. Already narrowed and compared once by `WorkRootScreen`.
  let sync: WorkRootSyncInputs
  let loadedProjectionProjectId: String?
  /// Bumped when the soonest snooze deadline lapses so the cached groups
  /// re-derive. Snooze expiry has no event to key on — it is pure clock math —
  /// so without this the row stays parked in the Snoozed tail until some
  /// unrelated change happens to rebuild the presentation.
  let snoozeEpoch: Int
  let pinnedLaneIdsStorage: String
}

/// The slice of `SyncService` the Work list renders from, read once per
/// publish by `WorkRootScreen` and compared before anything else runs.
///
/// `SyncService` publishes ~15 times a second while a chat streams. The list
/// used to observe it whole, so its body — and the ~35-argument row builders
/// under it — re-ran on every one of those, including while it sat hidden
/// behind an open chat. Now the list re-renders only when a value in here
/// changes. While the list is not on screen (another tab, or a chat pushed on
/// top) only the fields a pushed destination or a deeplink needs are filled
/// in; everything that exists purely to draw rows stays at its zero value, so
/// row-only churn cannot wake a hidden list at all.
struct WorkRootSyncInputs: Equatable {
  // Always tracked.
  var listVisible = false
  var isLive = false
  var isAttached = false
  var hostUnreachable = false
  var activeProjectId: String?
  var activeProjectRootPath: String?
  var activeProjectHostIdentity: String?
  var workSessionNavigationRequestId: String?
  var workLaneNavigationRequestId: String?
  // Tracked only while the list is visible.
  var suppressHydrationNotices = false
  var workStatus = SyncDomainStatus.disconnected
  var workProjectionRevision: Int?
  var rosterRevision = 0
  var chatLaunchRevision = 0
  var pendingChatCreations: [PendingChatCreation] = []
  var laneGithubPrItems: [GitHubPrListItem] = []
  var pendingLaneDeletionIds: Set<String> = []
  var projectIconDataUrl: String?
  var showsLinear = false
  var showsCursorCloud = false
  var laneColorAvailable = false
  var laneManageAvailable = false
  var lifecycleAvailable = false
  var snoozeAvailable = false
  var spawnKindUpdateAvailable = false
  var deleteSessionAvailable = false
  var generateNamesAvailable = false

  init() {}

  @MainActor
  init(_ sync: SyncService, listVisible: Bool) {
    self.listVisible = listVisible
    isAttached = sync.isAttached
    isLive = isAttached && sync.projectHostIsLive
    #if DEBUG
    if WorkRootPreviewFixture.active?.forcesLive == true { isLive = true }
    #endif
    hostUnreachable = sync.connectionState.isHostUnreachable
    activeProjectId = sync.activeProjectId
    activeProjectRootPath = sync.activeProjectRootPath
    activeProjectHostIdentity = sync.activeProjectHostIdentity
    workSessionNavigationRequestId = sync.requestedWorkSessionNavigation?.id
    workLaneNavigationRequestId = sync.requestedWorkLaneNavigation?.id
    guard listVisible else { return }
    suppressHydrationNotices = sync.shouldSuppressDomainHydrationNotices
    workStatus = sync.status(for: .work)
    workProjectionRevision = sync.workProjectionRevision
    let activeProject = sync.activeProject
    rosterRevision = sync.rosterRevision(for: activeProject)
    chatLaunchRevision = sync.chatLaunchRevision
    pendingChatCreations = sync.pendingChatCreations
    laneGithubPrItems = sync.laneGithubPrItems
    pendingLaneDeletionIds = sync.pendingLaneDeletionIds
    projectIconDataUrl = activeProject?.iconDataUrl
    showsLinear = sync.activeProjectId != nil
    showsCursorCloud = sync.activeProjectId != nil
      && sync.cursorCloudConnected
      && sync.supportsRemoteAction("ai.cursorCloudFleet")
    laneColorAvailable = sync.canInvokeRemoteAction("lanes.updateAppearance")
    laneManageAvailable = sync.canInvokeRemoteAction("lanes.rename")
    lifecycleAvailable = sync.supportsSessionLifecycleActions
    snoozeAvailable = sync.supportsSessionSnoozeActions
    spawnKindUpdateAvailable = sync.supportsSpawnKindUpdate
    deleteSessionAvailable = sync.supportsWorkSessionDeletion
    generateNamesAvailable = sync.canInvokeRemoteAction("chat.regenerateSessionMetadata")
    #if DEBUG
    // The fixture has no machine to probe Cursor credentials on; show the entry
    // so the overflow menu can be screenshotted whole.
    if WorkRootPreviewFixture.active != nil { showsCursorCloud = true }
    #endif
  }
}

/// The Work tab. A thin shell whose only job is to turn `SyncService`'s
/// firehose into `WorkRootSyncInputs` and hand it to the real list, which is
/// `.equatable()` on exactly those inputs. This body re-runs on every publish;
/// it reads a couple of dozen scalars and builds one struct, and the list
/// behind it does nothing unless the struct changed.
///
/// It also owns the navigation path, so "is the list on screen" (tab active and
/// nothing pushed) is known here, where the inputs are narrowed.
struct WorkRootScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var dictationController: DictationController
  var isTabActive = true
  @State private var path = NavigationPath()

  init(isTabActive: Bool = true) {
    self.isTabActive = isTabActive
  }

  var body: some View {
    WorkRootListScreen(
      syncService: syncService,
      dictationController: dictationController,
      isTabActive: isTabActive,
      inputs: WorkRootSyncInputs(syncService, listVisible: isTabActive && path.isEmpty),
      path: $path
    )
    .equatable()
  }
}

struct WorkRootListScreen: View, Equatable {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  /// Deliberately NOT observed: every value the body draws from arrives in
  /// `inputs`. Imperative code (actions, reloads) reads it directly.
  let syncService: SyncService
  /// App-level dictation singleton. Re-injected into pushed composer
  /// destinations below since `navigationDestination` builds outside the view
  /// tree and does not inherit environment objects.
  let dictationController: DictationController
  @Namespace var sessionTransitionNamespace
  let isTabActive: Bool
  let inputs: WorkRootSyncInputs
  @Binding var path: NavigationPath

  init(
    syncService: SyncService,
    dictationController: DictationController,
    isTabActive: Bool,
    inputs: WorkRootSyncInputs,
    path: Binding<NavigationPath>
  ) {
    self.syncService = syncService
    self.dictationController = dictationController
    self.isTabActive = isTabActive
    self.inputs = inputs
    self._path = path
  }

  static func == (lhs: WorkRootListScreen, rhs: WorkRootListScreen) -> Bool {
    lhs.isTabActive == rhs.isTabActive
      && lhs.inputs == rhs.inputs
      && lhs.syncService === rhs.syncService
      && lhs.dictationController === rhs.dictationController
  }

  // The five row sources. Each write bumps `projectionDataRevision`, which is
  // what the presentation rebuild keys on instead of the arrays themselves.
  @State var sessions: [TerminalSessionSummary] = [] {
    didSet { projectionDataRevision &+= 1 }
  }
  @State var chatSummaries: [String: AgentChatSessionSummary] = [:] {
    didSet { projectionDataRevision &+= 1 }
  }
  @State var lanes: [LaneSummary] = [] {
    didSet { projectionDataRevision &+= 1 }
  }
  /// ADE-mapped PRs (synced `pull_requests` table) used to tag each session's
  /// lane with its PR status next to the lane name. Combined with
  /// `syncService.laneGithubPrItems` for PRs opened outside ADE.
  @State var pullRequests: [PullRequestListItem] = [] {
    didSet { projectionDataRevision &+= 1 }
  }
  @State var projectionDataRevision = 0
  /// Terminal output revision, mirrored only while a search is typed (output
  /// is searchable). Terminal output streams constantly; nothing else here
  /// cares about it.
  @State var searchOutputRevision = 0
  /// Bookkeeping that must never invalidate the body.
  @State var bookkeeping = WorkRootBookkeeping()
  @State var sessionPresentation = WorkRootSessionPresentation.empty
  @State var sessionPresentationRebuildTask: Task<Void, Never>?
  @State var sessionPresentationRebuildGeneration = 0
  /// Exactly one pending wait, armed only while something is actually snoozed
  /// and only at the nearest deadline. Not a poll.
  @State var snoozeRegroupTask: Task<Void, Never>?
  @State var snoozeEpoch = 0
  @State var errorMessage: String?
  // Scoped per project+host through `WorkViewStateStore` rather than held in
  // flat global `@AppStorage`, so switching projects or machines restores that
  // scope's view instead of carrying the previous one over.
  @State var searchText = ""
  @State var selectedLaneId = "all"
  @State private var selectedStatusRawValue = WorkSessionStatusFilter.all.rawValue
  @State var renameTarget: TerminalSessionSummary?
  @State var renameText = ""
  @State var stopRuntimeTarget: TerminalSessionSummary?
  @State var optimisticSessions: [String: TerminalSessionSummary] = [:] {
    didSet { projectionDataRevision &+= 1 }
  }
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
  /// Read-only mirror of the Lanes tab's pin store. Pins decide the top lane
  /// tier and keep a lane's header, so the Work list has to see them; it never
  /// writes here, so pinning stays a Lanes-tab gesture with one owner.
  @AppStorage("ade.lanes.pinnedIds") private var pinnedLaneIdsStorage: String = ""
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
  /// Lane the row menu's "Manage lane" is opening, plus the sibling snapshots
  /// the Lanes tab's manage sheet needs to resolve parents and colour reuse.
  /// Both are transient: fetched when the item is tapped, cleared on dismiss.
  @State var manageLaneTarget: LaneListSnapshot?
  @State var manageLaneSnapshots: [LaneListSnapshot] = []

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

  /// Read fresh rather than from `inputs`: action code checks it after awaits,
  /// when a captured `inputs` could be stale. The body's dependency on it is
  /// carried by `inputs.isLive`.
  var isLive: Bool {
    #if DEBUG
    if WorkRootPreviewFixture.active?.forcesLive == true { return true }
    #endif
    return syncService.connectionState == .connected && syncService.projectHostIsLive
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

  var hasActiveFilters: Bool {
    selectedStatus != .all
      || selectedLaneId != "all"
      || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  // No screen-wide live/attention rollup is derived here any more. The counts and
  // the "first session wanting you" lookups that used to hang off
  // `WorkRootSessionPresentation` fed only the deleted top-bar pill and its
  // duplicate chip; the bell's Activity drawer owns that job now, and it reads
  // the drawer's own model rather than this screen's projection.

  var sessionOrganizationBinding: Binding<WorkSessionOrganization> {
    Binding(
      // `.byLane`, not `.byStatus`: it is the real default in both the `@State`
      // above and `WorkProjectViewState.organization`. A fallback that disagrees
      // lets the rendered groups and the filter chip's selection show different
      // groupings for a frame whenever the stored raw value is unparseable.
      // Twin fallback in `WorkRootScreen+Actions.swift`.
      get: { WorkSessionOrganization(rawValue: sessionOrganizationRaw) ?? .byLane },
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
    let preferred = selectedLaneId == "all" ? nil : selectedLaneId
    pushNewChatRoute(preferredLaneId: preferred)
  }

  /// Same route, with the lane chosen by the caller rather than by the filter —
  /// the row menu's "Start chat in lane" targets the row's lane, not whatever
  /// the lane filter happens to be set to.
  func pushNewChatRoute(preferredLaneId: String?) {
    guard !navigationMutationPending else { return }
    navigationMutationPending = true
    selectedSessionTransitionId = nil
    Task { @MainActor in
      // Long-press menu actions fire mid-dismissal; pushing a route into that
      // animation is what the existing yield below is already guarding against.
      await Task.yield()
      path.append(WorkNewChatRoute(preferredLaneId: preferredLaneId))
      navigationMutationPending = false
    }
  }

  var sessionGroups: [WorkSessionGroup] {
    sessionPresentation.sessionGroups
  }

  /// Lanes the user has pinned, read from the Lanes tab's store.
  var workPinnedLaneIds: Set<String> {
    Set(pinnedLaneIdsStorage.split(separator: ",").map(String.init).filter { !$0.isEmpty })
  }

  func toggleWorkPin(_ lane: LaneSummary) {
    var next = workPinnedLaneIds
    if next.contains(lane.id) {
      next.remove(lane.id)
    } else {
      next.insert(lane.id)
    }
    pinnedLaneIdsStorage = next.sorted().joined(separator: ",")
    scheduleSessionPresentationRebuild()
  }

  var isWorkRootActive: Bool {
    isTabActive && path.isEmpty
  }

  var sessionPresentationTaskKey: WorkRootSessionPresentationTaskKey? {
    guard isWorkRootActive else { return nil }
    return WorkRootSessionPresentationTaskKey(
      projectionDataRevision: projectionDataRevision,
      selectedLaneId: selectedLaneId,
      selectedStatus: selectedStatus,
      searchText: searchText,
      searchOutputRevision: workSearchIsActive ? searchOutputRevision : nil,
      archivedSessionIdsStorage: archivedSessionIdsStorage,
      sessionOrganizationRaw: sessionOrganizationRaw,
      sync: inputs,
      loadedProjectionProjectId: loadedProjectionProjectId,
      snoozeEpoch: snoozeEpoch,
      pinnedLaneIdsStorage: pinnedLaneIdsStorage
    )
  }

  var workSearchIsActive: Bool {
    !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var workProjectionReloadKey: Int? {
    isWorkRootActive ? inputs.workProjectionRevision : nil
  }

  var workSessionNavigationRequestKey: String? {
    inputs.workSessionNavigationRequestId
  }

  var workLaneNavigationRequestKey: String? {
    inputs.workLaneNavigationRequestId
  }

  var body: some View {
    let _ = ScrollDiagnostics.shared.count(.workListBody)
    NavigationStack(path: $path) {
      ScrollViewReader { proxy in
        workList(proxy: proxy)
          .onScrollPhaseChange { _, phase in
            if phase.isScrolling {
              ScrollDiagnostics.shared.scrollBegan("work-list")
            } else {
              ScrollDiagnostics.shared.scrollEnded("work-list")
            }
          }
          .onAppear { ScrollDiagnostics.shared.enter(.workList) }
          .onDisappear {
            ScrollDiagnostics.shared.scrollEnded("work-list")
            ScrollDiagnostics.shared.leave(.workList)
          }
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
          if !inputs.hostUnreachable,
            !inputs.suppressHydrationNotices,
            let hydrationNotice = inputs.workStatus.inlineHydrationFailureNotice(for: .work)
          {
            ADEInstructionErrorCard(
              notice: hydrationNotice,
              retry: { Task { await reload(refreshRemote: true) } }
            )
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          }
          // Search and the filter chip live in the header now; only the
          // expanded filter panel (and the Clear affordance) sit in the list.
          if filterPanelOpen || hasActiveFilters {
            WorkFiltersSection(
              searchText: searchTextBinding,
              selectedLaneId: selectedLaneBinding,
              selectedStatus: selectedStatusBinding,
              organization: sessionOrganizationBinding,
              filterOpen: $filterPanelOpen,
              lanes: workOrderedLanes,
              onClear: clearWorkFilters
            )
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          }

          if let errorMessage,
            inputs.workStatus.phase == .ready,
            !inputs.hostUnreachable
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
              symbol: inputs.isLive ? "bubble.left.and.bubble.right" : "terminal",
              title: workSessionEmptyStateTitle(status: selectedStatus, searchText: searchText, hasFilters: hasActiveFilters),
              message: workSessionEmptyStateMessage(
                status: selectedStatus,
                searchText: searchText,
                hasFilters: hasActiveFilters,
                isLive: inputs.isLive
              )
            ) {
              Button("New chat") {
                pushNewChatRoute()
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
              .disabled(!inputs.isLive)
            }
            .listRowInsets(EdgeInsets(top: 24, leading: 16, bottom: 16, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          } else {
            ForEach(sessionGroups) { group in
              workSessionGroupSection(group)
            }
          }
        }
      }
      .listStyle(.plain)
      .listSectionSpacing(.custom(Self.workGroupSectionSpacing))
      .scrollContentBackground(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .contentMargins(.bottom, workRootBottomTabBarScrollMargin, for: .scrollContent)
      // The header sits in a safe-area inset directly above; the list's own
      // top margin would double the gap under it.
      .contentMargins(.top, 0, for: .scrollContent)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .navigationBar)
      .safeAreaInset(edge: .top, spacing: 0) {
        // One row: project / back, title, search with the filter chip inside it,
        // then new chat and the overflow menu. No attention rollup lives here —
        // amber means "your move" and the per-row badge owns it; the Activity
        // drawer is one tap away in the overflow menu, which carries its dot.
        WorkRootHeader(
          projectIconDataUrl: inputs.projectIconDataUrl,
          searchText: searchTextBinding,
          filterOpen: $filterPanelOpen,
          activeFilterCount: workActiveFilterCount,
          isLive: inputs.isLive,
          showsLinear: inputs.showsLinear,
          showsCursorCloud: inputs.showsCursorCloud,
          selectionCount: isSelecting ? selectedSessionIds.count : nil,
          actions: workHeaderActions
        )
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
      .onChange(of: path.count) { _, newCount in
        if newCount == 0, selectedSessionTransitionId != nil {
          selectedSessionTransitionId = nil
        }
        if newCount == 0 {
          syncService.clearOpenWorkSessionRoute()
        }
      }
      .sheet(item: $bulkExportShare) { share in
        WorkActivityViewController(items: share.items)
      }
      .sheet(item: $manageLaneTarget) { snapshot in
        LaneManageSheet(
          snapshot: snapshot,
          allLaneSnapshots: manageLaneSnapshots,
          onDeleted: {
            manageLaneTarget = nil
            await reload(refreshRemote: true)
          },
          onRenamed: {
            await reload(refreshRemote: true)
          },
          onComplete: {
            manageLaneTarget = nil
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
      .onChange(of: inputs.activeProjectId) { _, projectId in
        applyWorkViewStateScope()
        resetWorkProjectionForProjectChange(projectId)
      }
      .modifier(WorkSearchOutputRevisionModifier(
        publisher: syncService.$terminalBufferRevision,
        isSearching: isWorkRootActive && workSearchIsActive,
        revision: $searchOutputRevision
      ))
      .modifier(WorkViewStateScopeModifier(
        hostIdentity: inputs.activeProjectHostIdentity,
        filterPanelOpen: filterPanelOpen,
        signature: currentWorkViewState,
        applyScope: applyWorkViewStateScope,
        onFiltersOpened: restoreWorkViewStateAfterDeeplink,
        persist: persistWorkViewState
      ))
      // Keep both integration entry points honest when the active project or
      // paired host changes. Cursor is stricter than Linear here: its toolbar
      // button is rendered only after this host-owned credential probe passes.
      .task(id: "\(inputs.activeProjectId ?? ""):\(inputs.activeProjectHostIdentity ?? ""):\(inputs.isAttached)") {
        await syncService.refreshLinearConnection()
        await syncService.refreshCursorCloudConnection()
      }
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
        if inputs.workLaneNavigationRequestId != nil {
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
      .onChange(of: inputs.workLaneNavigationRequestId) { _, requestId in
        guard isTabActive, requestId != nil else { return }
        Task { await handleRequestedWorkLaneNavigation(proxy: proxy) }
      }
      .navigationDestination(for: WorkSessionRoute.self) { route in
        let routeTransitionNamespace = route.openingPrompt == nil && selectedSessionTransitionId == route.sessionId
          ? (ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? sessionTransitionNamespace : nil)
          : nil
        let initialSession = optimisticSessions[route.sessionId]
          ?? mergedSessions.first(where: { $0.id == route.sessionId })
          ?? syncService.chatLaunchEntry(sessionId: route.sessionId).map(workChatLaunchOptimisticSession)
        // A chat still being launched into a new lane shows its setup first;
        // the same session id then hands over to the ordinary destination.
        WorkChatLaunchGate(sessionId: route.sessionId) {
        WorkSessionDestinationView(
          sessionId: route.sessionId,
          initialOpeningPrompt: route.openingPrompt,
          initialOpeningPromptDispatchHandled: route.openingPromptDispatchHandled,
          initialOpeningDeliveryState: route.openingDeliveryState,
          initialOpeningAttachments: route.openingAttachments,
          initialSession: initialSession,
          initialChatSummary: chatSummaries[route.sessionId],
          transitionNamespace: routeTransitionNamespace,
          isLive: inputs.isLive,
          navigationChrome: .pushedDetail,
          // `sessionPresentationTaskKey` goes nil once a screen is pushed off the
          // root, so `workOrderedLanes` stops refreshing here — fall back to the
          // live `lanes` when the presentation-derived order isn't available.
          lanes: workOrderedLanes.isEmpty ? lanes : workOrderedLanes
        )
        .equatable()
        }
        .id(route.openId)
        .environmentObject(syncService)
        .environmentObject(dictationController)
      }
      .navigationDestination(for: WorkNewChatRoute.self) { route in
        WorkNewChatScreen(
          lanes: workOrderedLanes.isEmpty ? lanes : workOrderedLanes,
          preferredLaneId: route.preferredLaneId,
          activeProjectId: inputs.activeProjectId,
          activeProjectRootPath: inputs.activeProjectRootPath,
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
            syncService.persistOpenWorkSessionRoute(sessionId: sessionId)
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
            syncService.persistOpenWorkSessionRoute(sessionId: session.id)
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
            syncService.persistOpenWorkSessionRoute(sessionId: chatSessionId)
            Task { @MainActor in
              await reload(refreshRemote: true)
            }
          },
          onRefreshLanes: { await reload(refreshRemote: true) },
          onLaunchStarted: { snapshot in
            // Open the chat now under the session id the host reserved. The
            // gate on the route shows the lane setup until the agent starts.
            let sessionId = snapshot.chatSessionId
            selectedSessionTransitionId = nil
            var fresh = NavigationPath()
            fresh.append(WorkSessionRoute(sessionId: sessionId))
            await Task.yield()
            path = fresh
            syncService.persistOpenWorkSessionRoute(sessionId: sessionId)
          }
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
  ///
  /// A headerless lane is never collapsed: there is no header to collapse it
  /// with, so a collapsed one would be a row the user could not get back.
  private func workGroupIsCollapsed(_ group: WorkSessionGroup) -> Bool {
    if group.isHeaderless { return false }
    return group.isQuiet
      ? !collapsedSectionIds.contains(group.quietOpenSectionId)
      : collapsedSectionIds.contains(group.id)
  }

  /// Top-level rows of a group, in display order. Child shells are rendered by
  /// their parent row, so they are filtered out here.
  private func workTopLevelSessions(in group: WorkSessionGroup) -> [TerminalSessionSummary] {
    group.sessions.filter { sessionPresentation.topLevelDisplaySessionIds.contains($0.id) }
  }

  /// Gutter the lane accent rail occupies: the 1pt rail plus the 8pt gap to the
  /// card. Rows under a lane header shift right by this much; the rail itself is
  /// drawn in that gutter, so it costs no card width of its own.
  private static let workLaneRailGutter: CGFloat = 9

  /// One deliberate gap between adjacent lane/status sections. Card-to-card
  /// breathing room stays inside each row; this value owns only the transition
  /// between groups, including a headerless singleton and the next grouped lane.
  private static let workGroupSectionSpacing: CGFloat = 16

  /// Absolute leading indent of a nested child-shell block, measured from the
  /// list's own 16pt margin. Held constant whether or not a lane rail is present
  /// so a nested shell never reads as double-indented under the rail.
  private static let workChildShellIndent: CGFloat = 30

  /// The `Lane ▸` submenu's wiring. Every entry is a command the Lanes tab
  /// already sends, so the two surfaces cannot disagree about what a lane action
  /// does. The two flags are per-command capability gates: a host that does not
  /// advertise `lanes.updateAppearance` or `lanes.rename` shows no colour or
  /// manage row at all rather than one that fails on tap.
  var workLaneMenuActions: WorkSessionLaneMenuActions {
    WorkSessionLaneMenuActions(
      colorAvailable: inputs.laneColorAvailable,
      manageAvailable: inputs.laneManageAvailable,
      onStartChat: startChatInLane,
      onToggleWorkPin: toggleWorkPin,
      isWorkPinned: { workPinnedLaneIds.contains($0.id) },
      onOpenInWeb: openLaneInWeb,
      onCopyLaneLink: copyLaneLink,
      onCopyBranchLink: copyLaneBranchLink,
      onCopyLinearLink: copyLaneLinearLink,
      onCopyPath: copyLanePath,
      onSetColor: setLaneColor,
      onManage: manageLane
    )
  }

  @ViewBuilder
  private func workSessionGroupSection(_ group: WorkSessionGroup) -> some View {
    // The singleton form: one top-level row in the lane, so the header would be
    // a divider carrying a name the row already says. The row takes the lane
    // identity instead (its meta line and its "Go to lane" / PR actions).
    //
    // Still a `Section`, headerless: it keeps `listSectionSpacing` in charge of
    // the gap to the neighbouring lane, and it gives the group an `.id` for the
    // lane deeplink to scroll to even when there is no header view to carry one.
    if group.isHeaderless {
      let rows = workTopLevelSessions(in: group)
      Section {
        ForEach(rows) { session in
          workSessionRows(session, showsLaneIdentity: true, showsDivider: session.id != rows.last?.id)
        }
      }
      .id(group.id)
    } else {
      workSessionGroupSectionWithHeader(group)
    }
  }

  /// A real `Section` with a `header:`, not a header emitted as an ordinary row.
  /// `List(.plain)` only pins content passed as a section header — as plain rows
  /// these scrolled away, which is what made a long lane lose its name.
  @ViewBuilder
  private func workSessionGroupSectionWithHeader(_ group: WorkSessionGroup) -> some View {
    let isLaneDeleting = group.laneId.map(inputs.pendingLaneDeletionIds.contains) ?? false
    let collapsed = workGroupIsCollapsed(group)
    // Real lane sections get the accent rail; status/time headers span multiple
    // lanes, so a single lane color would be a lie there.
    let railColor: Color? = group.laneId == nil
      ? nil
      : LaneColorPalette.displayColor(forHex: group.laneColor).opacity(0.35)

    Section {
      if group.isOrphaned && !collapsed {
        Text("The lane record is missing from the latest machine snapshot. Refresh to reconcile it. ADE will not delete sessions, branches, worktrees, commits, or pull requests.")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .accessibilityIdentifier("work-orphan-session-explanation")
      }

      // Collapsed means an empty section body, never a hidden section: the
      // header has to stay on screen or there is no way back into the group.
      if !collapsed {
        let rows = workTopLevelSessions(in: group)
        ForEach(rows) { session in
          // An expanded quiet lane holds only settled rows: the full card's
          // preview line and meta row are about work in flight, of which there is
          // none here.
          //
          // A row under a lane header does not repeat the lane name — the header
          // two rows up already says it, and the space is worth more as the model.
          //
          // Compactness is scoped to LANE groups on purpose. A quiet lane folds
          // to compact rows because its header still names the lane, but the
          // Snoozed and Settled shelves span lanes by construction and their
          // headers name none — and `compactBody` has no lane chip to render.
          // Folding a shelf to compact would leave three snoozed rows from three
          // different lanes visually indistinguishable.
          workSessionRows(
            session,
            compact: group.isQuiet && group.laneId != nil,
            showsLaneIdentity: group.laneId == nil,
            railColor: railColor,
            showsDivider: session.id != rows.last?.id
          )
        }
      }
    } header: {
      WorkSidebarSectionHeader(
        group: group,
        collapsed: collapsed,
        onToggle: {
          withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
            toggleCollapsed(group.isQuiet ? group.quietOpenSectionId : group.id)
          }
        },
        pullRequest: group.isOrphaned ? nil : group.laneId.flatMap { lanePrTagsByLaneId[$0] },
        onOpenPullRequest: { tag in
          openLanePullRequest(tag: tag, laneId: group.laneId)
        },
        onRefreshOrphanedSessions: group.isOrphaned
          ? { Task { await refreshFromPullGesture() } }
          : nil,
        // Lane-scoped git state belongs to the lane, so it is stated once here
        // rather than repeated on every row beneath. Orphaned sections have no
        // lane record to read it from.
        laneStatus: group.isOrphaned ? nil : group.laneId.flatMap { laneById[$0]?.status },
        lane: group.isOrphaned ? nil : group.laneId.flatMap { laneById[$0] },
        laneMenu: workLaneMenuActions
      )
      .disabled(isLaneDeleting)
      .redacted(reason: isLaneDeleting ? .placeholder : [])
      // Opaque, not `.clear`: a pinned `List(.plain)` header is transparent by
      // default, so rows would scroll visibly underneath the lane name. This is
      // the same token `adeScreenBackground()` paints behind the list.
      .listRowBackground(ADEColor.pageBackground)
      .listRowSeparator(.hidden)
      .listRowInsets(EdgeInsets(
        top: 0,
        leading: 16,
        bottom: 0,
        trailing: 16
      ))
    }
    // On the `Section`, not on the header row: the header is no longer a row of
    // its own, and the lane deeplink scrolls to this id.
    .id(group.id)
  }

  @ViewBuilder
  private func workSessionRows(
    _ session: TerminalSessionSummary,
    compact: Bool = false,
    showsLaneIdentity: Bool = true,
    railColor: Color? = nil,
    showsDivider: Bool = false
  ) -> some View {
    let nestedGroups = sessionPresentation.nestedGroupsByParentId[session.id] ?? []
    sessionListRow(
      session,
      compact: compact,
      showsLaneIdentity: showsLaneIdentity,
      transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion)
        ? sessionTransitionNamespace
        : nil
    )
    // Rows are flush: no card, no inter-row inset. Their own vertical padding
    // is the gap, a hairline marks the boundary, and zero `listRowInsets`
    // keep the lane rail one unbroken line down the lane. The hairline goes
    // under the subagent drawer instead when there is one, so the drawer
    // reads as part of its parent.
    .workRowHairline(showsDivider && nestedGroups.isEmpty)
    .workLaneAccentRail(railColor, gutter: Self.workLaneRailGutter)
    .id(session.id)
    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)

    nestedChildDrawer(
      groups: nestedGroups,
      railColor: railColor,
      showsDivider: showsDivider
    )
  }

  /// Subagent drawer then shell drawer. Nested subagents sit under a parent
  /// that already names the lane, so they drop lane identity; shells keep the
  /// previous compact default.
  @ViewBuilder
  private func nestedChildDrawer(
    groups: [WorkSessionChildGroup],
    railColor: Color?,
    showsDivider: Bool
  ) -> some View {
    ForEach(groups) { group in
      WorkNestedSessionSection(
        group: group,
        collapsed: collapsedSectionIds.contains(group.collapsedSectionId),
        onToggle: {
          withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
            toggleCollapsed(group.collapsedSectionId)
          }
        }
      ) {
        ForEach(group.children) { child in
          sessionListRow(
            child,
            compact: true,
            showsLaneIdentity: group.kind == .shells,
            nestedSubagent: group.kind == .subagents,
            transitionNamespace: nil
          )
          .id(child.id)
        }
      }
      .padding(.leading, Self.workChildShellIndent - 16 - (railColor == nil ? 0 : Self.workLaneRailGutter))
      .padding(.bottom, 6)
      .workRowHairline(showsDivider && group.id == groups.last?.id)
      .workLaneAccentRail(railColor, gutter: Self.workLaneRailGutter)
      .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
    }
  }

  /// One argument list, two callers (the top-level session row and the nested
  /// child loop). `WorkSessionListRow` takes ~35 arguments, nearly all of them
  /// threaded straight off `self`; when they were spelled out at both call
  /// sites every new callback had to be added twice, and one of the two was
  /// eventually going to be missed. Only the arguments that genuinely differ
  /// between the callers are parameters here.
  ///
  /// List-cell concerns (`.id`, `.listRowInsets`, `.listRowBackground`,
  /// `.listRowSeparator`, the lane accent rail, vertical padding) stay at the
  /// call sites — those really do differ between the two.
  private func sessionListRow(
    _ session: TerminalSessionSummary,
    compact: Bool,
    showsLaneIdentity: Bool,
    nestedSubagent: Bool = false,
    transitionNamespace: Namespace.ID?
  ) -> WorkSessionListRow {
    WorkSessionListRow(
      session: session,
      lane: laneById[session.laneId],
      // Fall back to the resolved lane (name/branch match) so legacy sessions
      // with a stale laneId still surface their PR shortcut.
      pullRequest: lanePrTagsByLaneId[session.laneId]
        ?? lanePrTagsByLaneId[resolvedWorkNavigationLaneId(for: session, lanes: lanes)],
      chatSummary: chatSummaries[session.id],
      isArchived: archivedSessionIds.contains(session.id),
      transitionNamespace: transitionNamespace,
      compact: compact,
      nestedSubagent: nestedSubagent,
      showsLaneIdentity: showsLaneIdentity,
      isLaneDeleting: inputs.pendingLaneDeletionIds.contains(session.laneId),
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
      lifecycleAvailable: inputs.lifecycleAvailable,
      snoozeAvailable: inputs.snoozeAvailable,
      onSettle: settleSession,
      onDismissAndSettle: dismissAndSettleSession,
      onUnsettle: unsettleSession,
      onKeepActive: keepSessionActive,
      onSnooze: snoozeSession,
      onWake: wakeSession,
      onDemoteToPeer: demoteSessionToPeer,
      onPromoteToSubagent: promoteSessionToSubagent,
      spawnKindUpdateAvailable: inputs.spawnKindUpdateAvailable,
      deleteSessionAvailable: inputs.deleteSessionAvailable,
      onDeleteSession: deleteWorkSession,
      onOpenInWeb: openSessionInWeb,
      laneMenu: workLaneMenuActions,
      generateNamesAvailable: inputs.generateNamesAvailable,
      onGenerateNames: generateSessionNames
    )
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

  /// Lane and status filters count; search does not (it is visible in the
  /// field itself). Drives the filter chip's active state inside the field.
  var workActiveFilterCount: Int {
    (selectedStatus != .all ? 1 : 0) + (selectedLaneId != "all" ? 1 : 0)
  }

  var workHeaderActions: WorkRootHeaderActions {
    WorkRootHeaderActions(
      onBackToHub: { syncService.showProjectHub() },
      onNewChat: pushNewChatRoute,
      onCancelSelection: exitSelectionMode,
      onOpenActivity: { syncService.attentionDrawerPresented = true },
      onOpenLinear: {
        syncService.linearPaneAttachSessionId = nil
        syncService.linearPanePresented = true
      },
      onOpenCursorCloud: { syncService.cursorCloudPanePresented = true },
      onOpenSettings: { syncService.settingsPresented = true }
    )
  }

  func clearWorkFilters() {
    restoreWorkViewStateAfterDeeplink()
    searchText = ""
    selectedLaneId = "all"
    selectedStatus = .all
  }
}

private extension View {
  /// Hairline at the bottom of a flush row, between siblings of one group.
  /// The last row of a group has none: section spacing and the next header
  /// already mark that boundary.
  @ViewBuilder
  func workRowHairline(_ visible: Bool) -> some View {
    if visible {
      overlay(alignment: .bottom) {
        Rectangle()
          .fill(ADEColor.glassBorder)
          .frame(height: 0.5)
          .padding(.leading, 4)
          .accessibilityHidden(true)
      }
    } else {
      self
    }
  }

  /// Indents a session cell into a lane section and draws the lane's accent as a
  /// 1pt rail in the gutter that indent opens up. Desktop's equivalent is `pl-2`
  /// on the row container plus a rail at `left-1` (`SessionListPane.tsx`).
  ///
  /// Deliberately padding + overlay rather than wrapping the row in an `HStack`
  /// with the rail as a sibling: the geometry is identical, but the session row
  /// stays the root view of its list cell. `WorkSessionListRow` attaches
  /// `.swipeActions` and `.contextMenu` to its own body, and burying that body
  /// inside a container view inside the cell puts those row-level modifiers at
  /// the mercy of how far SwiftUI propagates them. Keep the row at the root.
  ///
  /// A nil color means no rail and no indent — status and time sections span
  /// several lanes, so there is no single lane color that would be true there.
  @ViewBuilder
  func workLaneAccentRail(_ color: Color?, gutter: CGFloat) -> some View {
    if let color {
      padding(.leading, gutter)
        .overlay(alignment: .leading) {
          // Spans the full cell height, vertical row padding included, so
          // consecutive rows in a lane read as one unbroken line.
          Capsule()
            .fill(color)
            .frame(width: 1)
        }
    } else {
      self
    }
  }
}
