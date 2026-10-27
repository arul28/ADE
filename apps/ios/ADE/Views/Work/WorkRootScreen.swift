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
  /// Per-lane fingerprint of the session rows at the last chat-summary
  /// refresh, and when every lane was last refreshed. A CRDT tick refreshes
  /// only the lanes whose rows changed; a full sweep still runs every
  /// `workChatSummaryFullSweepInterval`.
  var summaryLaneSignatures: [String: Int] = [:]
  var lastFullChatSummarySweep = Date.distantPast
  /// Which lanes came back out of the Working shelf, handed from one
  /// presentation build to the next so returned lanes keep floating.
  var laneReturnState = WorkLaneReturnState.empty
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
  /// Set for a row from another machine: the chat opens through that
  /// machine's roster connection.
  var remoteChat: WorkChatCrossProjectContext? = nil
  var openingPrompt: String? = nil
  var openingPromptDispatchHandled = false
  var openingDeliveryState: String? = nil
  var openingAttachments: [AgentChatFileRef] = []
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
  let machineFilterStorage: String
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
  let foldBusyLanes: Bool
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
  /// Side chats opened or ended live: the rows' marks and hiding follow.
  var sideChatRevision = 0
  var pendingChatCreations: [PendingChatCreation] = []
  var laneGithubPrItems: [GitHubPrListItem] = []
  var pendingLaneDeletionIds: Set<String> = []
  var projectIconDataUrl: String?
  var showsLinear = false
  var showsCursorCloud = false
  var showsGitHubIssues = false
  var laneColorAvailable = false
  var laneManageAvailable = false
  var lifecycleAvailable = false
  var snoozeAvailable = false
  var spawnKindUpdateAvailable = false
  var deleteSessionAvailable = false
  var generateNamesAvailable = false
  /// Session-menu parity with desktop: Set tag, Restart agent, Hand off ▸.
  /// The focused host's answer only — it re-renders the list when its
  /// capabilities change. Each row asks the brain that owns its chat
  /// (`sessionListRow`), since a chat on another machine or project may differ.
  var chatTagAvailable = false
  var restartAgentAvailable = false
  var localHandoffAvailable = false
  var crossMachineHandoffAvailable = false
  var autoHandoffAvailable = false
  /// Other machines' checkouts of the focused repository (their chats join
  /// the list). Tracked only while the list is visible.
  var remoteMachineRepos: [WorkRemoteMachineRepo] = []
  /// The Machine filter's choices: the focused machine, then the machines in
  /// `remoteMachineRepos`. Tracked only while the list is visible.
  var machineFilterOptions: [WorkMachineFilterOption] = []

  init() {}

  @MainActor
  init(_ sync: SyncService, fleet: MachineFleet? = nil, listVisible: Bool) {
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
    sideChatRevision = sync.sideChatRevision
    pendingChatCreations = sync.pendingChatCreations
    laneGithubPrItems = sync.laneGithubPrItems
    pendingLaneDeletionIds = sync.pendingLaneDeletionIds
    projectIconDataUrl = activeProject?.iconDataUrl
    showsLinear = sync.activeProjectId != nil
    showsCursorCloud = sync.activeProjectId != nil
      && sync.cursorCloudConnected
      && sync.supportsRemoteAction("ai.cursorCloudFleet")
    showsGitHubIssues = sync.activeProjectId.map { sync.githubIssuesMenuProjectIds.contains($0) } ?? false
    laneColorAvailable = sync.canInvokeRemoteAction("lanes.updateAppearance")
    laneManageAvailable = sync.canInvokeRemoteAction("lanes.rename")
    lifecycleAvailable = sync.supportsSessionLifecycleActions
    snoozeAvailable = sync.supportsSessionSnoozeActions
    spawnKindUpdateAvailable = sync.supportsSpawnKindUpdate
    deleteSessionAvailable = sync.supportsWorkSessionDeletion
    generateNamesAvailable = sync.canInvokeRemoteAction("chat.regenerateSessionMetadata")
    chatTagAvailable = sync.canInvokeRemoteAction("chat.updateSession")
    restartAgentAvailable = sync.canInvokeRemoteAction("chat.restartSession")
    localHandoffAvailable = sync.canInvokeRemoteAction("chat.handoff")
    crossMachineHandoffAvailable = sync.canInvokeRemoteAction("chat.getCrossMachineHandoffOptions")
      && sync.canInvokeRemoteAction("chat.startCrossMachineHandoff")
    autoHandoffAvailable = sync.autoHandoffRulesAvailable && sync.canInvokeRemoteAction("automations.saveDraft")
    // Only machines the user keeps connected; a disconnected one stays off.
    if let fleet, case let connected = fleet.machines.filter(\.isPinned), !connected.isEmpty, let activeProject {
      let identity = workRepoIdentity(owner: activeProject.repoOwner, name: activeProject.repoName)
        ?? workRepoIdentity(originUrl: sync.rosterProject(for: activeProject)?.repoOriginUrl)
      remoteMachineRepos = workRemoteMachineRepos(
        machines: connected,
        identity: identity,
        folderKey: hubProjectFolderKey(activeProject.rootPath, displayName: activeProject.displayName)
      )
      // The Work list shows every chat of this repository on the other
      // machines, and its search and filters cover them all: a paged roster
      // loads the rest of the matched project now that the user opened it.
      for repo in remoteMachineRepos {
        guard let connection = fleet.connection(for: repo.machineKey),
              connection.rosterProjects.first(where: { $0.projectId == repo.projectId })?.unloadedChatCount ?? 0 > 0
        else { continue }
        let projectId = repo.projectId
        Task { await connection.loadOlderRosterChats(projectId: projectId, all: true) }
      }
    }
    machineFilterOptions = workMachineFilterOptions(
      primaryName: sync.focusedMachineDisplayName,
      primaryIsLive: isLive,
      remote: remoteMachineRepos,
      isLive: { fleet?.isLive($0) ?? false }
    )
    #if DEBUG
    // The fixture has no machine to probe Cursor credentials on; show the entry
    // so the overflow menu can be screenshotted whole.
    if WorkRootPreviewFixture.active != nil { showsCursorCloud = true }
    // Nor any other machine; add one so the filter panel's Machine row shows.
    if WorkRootPreviewFixture.active != nil, machineFilterOptions.count == 1 {
      machineFilterOptions.append(WorkMachineFilterOption(id: "preview-studio", name: "Mac Studio", isLive: true))
    }
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
  @EnvironmentObject private var machineFleet: MachineFleet
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
      inputs: WorkRootSyncInputs(syncService, fleet: machineFleet, listVisible: isTabActive && path.isEmpty),
      path: $path
    )
    .equatable()
  }
}

struct WorkRootListScreen: View, Equatable {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  /// Regular width (the Duo's inner display): the list and the chat sit side by
  /// side instead of the chat being pushed over the list. Read here rather than
  /// passed down so a fold or unfold needs no navigation-path rewrite.
  @Environment(\.duoLayout) var duoLayout
  @State private var duoRetiringWide = false
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
  /// Session-menu sheets and prompts added for desktop parity.
  @State var tagTarget: TerminalSessionSummary?
  @State var tagText = ""
  @State var restartStopTurnTarget: TerminalSessionSummary?
  @State var localHandoffSubject: WorkSessionHandoffSubject?
  @State var autoHandoffSubject: WorkSessionHandoffSubject?
  @State var crossMachineHandoffTarget: WorkCrossMachineHandoffTarget?
  /// Auto-handoff rule ids scoped to each chat, read once per list load so the
  /// menu can say "Edit auto handoff…" / "Remove auto handoff" without
  /// waiting on the host when it opens. Absent key = unknown.
  @State var autoHandoffRuleIdsBySession: [String: [String]] = [:]
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
  /// By-lane "Fold busy lanes", scoped per project+host like the grouping.
  @State var foldBusyLanes = false
  @State var collapsedSectionIdsStorage = ""
  @State var machineFilterStorage = ""
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

  // Wide-only layout state. Every property here is inert on a phone-sized
  // display, where the chat is pushed exactly as it always was.
  /// The chat the wide detail column is showing. Nil means the empty column.
  @State var duoSelectedRoute: WorkSessionRoute?
  /// The new-chat page the wide detail column is showing, beside the list.
  /// Wins over the selected chat while it is up; Cancel returns to it.
  @State var duoComposeRoute: WorkNewChatRoute?
  /// The chat's tool column: what is open, and whether the sessions column is
  /// showing beside it. Opening a tool collapses the column fully (like the
  /// desktop sidebar); the chat header's sidebar toggle brings it back.
  @StateObject var duoPane = DuoWorkPaneModel()
  @State var duoShowsSessionList = true
  /// The wide split's last measured size and fold, so the sidebar toggle can
  /// answer "does the thread still get a readable width?" without guessing.
  @State var duoWideSize: CGSize = .zero
  @State var duoWideFold: DuoFold = .none
  /// Held landscape or held portrait, as last laid out.
  @State var duoWorkFamily: DuoFamily = .wide
  /// The compact list is on a display with a vertical edge bar (the Duo's
  /// closed outer display): its header actions move onto that bar.
  @State var workListHasEdgeRail = false
  /// List or Board (desktop's view switch). Board shows only while no chat is
  /// open; it is a wide-display view, the phone keeps its list.
  @AppStorage("ade.work.duo.viewMode") var duoViewModeRaw = DuoWorkViewMode.list.rawValue

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
      collapsedSectionIds: collapsedSectionIdsStorage,
      machineFilter: machineFilterStorage,
      foldBusyLanes: foldBusyLanes
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
    machineFilterStorage = restored.machineFilter
    foldBusyLanes = restored.foldBusyLanes
  }

  func persistWorkViewState() {
    guard let scope = workViewStateScopeKey, !workViewStateDeeplinkActive else { return }
    WorkViewStateStore.save(
      WorkProjectViewState(
        searchText: searchText,
        laneFilter: selectedLaneId,
        statusFilter: selectedStatusRawValue,
        organization: sessionOrganizationRaw,
        collapsedSectionIds: collapsedSectionIdsStorage,
        machineFilter: machineFilterStorage,
        foldBusyLanes: foldBusyLanes
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
    machineFilterStorage = restored.machineFilter
    foldBusyLanes = restored.foldBusyLanes
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
      || !machineFilterStorage.isEmpty
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

  var foldBusyLanesBinding: Binding<Bool> {
    Binding(
      get: { foldBusyLanes },
      set: {
        restoreWorkViewStateAfterDeeplink()
        foldBusyLanes = $0
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

  var machineFilterBinding: Binding<String> {
    Binding(
      get: { machineFilterStorage },
      set: {
        restoreWorkViewStateAfterDeeplink()
        machineFilterStorage = $0
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
      if duoLayout.isWide {
        // The page opens in the detail column with the list beside it, as on
        // desktop. The tools pane belongs to the chat it was open for.
        if duoPane.isOpen { duoPane.close() }
        withAnimation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion)) {
          duoComposeRoute = WorkNewChatRoute(preferredLaneId: preferredLaneId)
          if duoWorkFamily == .wide { duoShowsSessionList = true }
        }
      } else {
        path.append(WorkNewChatRoute(preferredLaneId: preferredLaneId))
      }
      navigationMutationPending = false
    }
  }

  var sessionGroups: [WorkSessionGroup] {
    sessionPresentation.sessionGroups
  }

  var workFiltersSection: some View {
    WorkFiltersSection(
      searchText: searchTextBinding,
      selectedLaneId: selectedLaneBinding,
      selectedStatus: selectedStatusBinding,
      organization: sessionOrganizationBinding,
      foldBusyLanes: foldBusyLanesBinding,
      filterOpen: filterPanelOpen,
      activeFilterCount: workActiveFilterCount,
      machineFilter: machineFilterBinding,
      machineOptions: inputs.machineFilterOptions,
      lanes: workOrderedLanes,
      onClear: clearWorkFilters
    )
  }

  /// The groups on screen: lanes filed under the Working shelf render only
  /// while that shelf is expanded.
  var visibleSessionGroups: [WorkSessionGroup] {
    let groups = sessionGroups
    guard let shelf = groups.first(where: { $0.id == workWorkingSectionId }),
          workGroupIsCollapsed(shelf) else { return groups }
    return groups.filter { !$0.inWorkingShelf }
  }

  /// The first shelf (Working, else Snoozed or Settled) draws the quiet zone's
  /// one rule, so all three sit together below it, as on desktop.
  var quietZoneStartGroupId: String? {
    sessionGroups.first(where: \.isShelf)?.id
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
      machineFilterStorage: machineFilterStorage,
      sync: inputs,
      loadedProjectionProjectId: loadedProjectionProjectId,
      snoozeEpoch: snoozeEpoch,
      pinnedLaneIdsStorage: pinnedLaneIdsStorage,
      foldBusyLanes: foldBusyLanes
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
    Group {
      if duoLayout.isWide || duoRetiringWide {
        duoWideBody
          .environment(\.duoRailRetired, duoRetiringWide)
          .opacity(duoRetiringWide ? 0 : 1)
      } else {
        duoCompactBody
      }
    }
    .onChange(of: duoLayout.isWide, initial: true) { old, wide in
      guard old, !wide else {
        handleDuoWidthChange(wide)
        return
      }
      // Folded: the wide columns stay one moment longer, unseen and with no
      // bar items, so the edge bar's items leave with them. Torn down with
      // their items still on the bar, the outer display's tab bar kept them
      // as an empty glass capsule over the composer.
      duoRetiringWide = true
      Task { @MainActor in
        try? await Task.sleep(for: .milliseconds(120))
        handleDuoWidthChange(false)
        duoRetiringWide = false
      }
    }
    // Here, not on the list: a `.task` on the list is cancelled while a chat
    // is pushed over it, so a request made from inside a chat (Chat Info's
    // child chat, the subagent breadcrumb's parent) waited until Back.
    .task(id: workSessionNavigationRequestKey) {
      guard isTabActive, workSessionNavigationRequestKey != nil else { return }
      await handleRequestedWorkSessionNavigation()
    }
    #if DEBUG
    .task(id: "\(duoLayout.isWide)|\(duoPreviewSelectionKey)") {
      if !duoLayout.isWide { applyDuoPreviewSelectionIfNeeded() }
    }
    #endif
  }

  /// Today's layout, unchanged: one column, the chat pushed over the list.
  private var duoCompactBody: some View {
    let _ = ScrollDiagnostics.shared.count(.workListBody)
    return NavigationStack(path: $path) {
      ScrollViewReader { proxy in
        workList(proxy: proxy)
          .onScrollPhaseChange { _, phase in
            if phase.isScrolling {
              ScrollDiagnostics.shared.scrollBegan("work-list")
            } else {
              ScrollDiagnostics.shared.scrollEnded("work-list")
            }
          }
          .onAppear {
            ScrollDiagnostics.shared.enter(.workList)
          }
          .onDisappear {
            ScrollDiagnostics.shared.scrollEnded("work-list")
            ScrollDiagnostics.shared.leave(.workList)
          }
      }
    }
    .environment(\.workCompactEdgeRail, workListHasEdgeRail)
    .onGeometryChange(for: Bool.self) { proxy in
      workDisplayHasEdgeRail(proxy)
    } action: { hasRail in
      if workListHasEdgeRail != hasRail { workListHasEdgeRail = hasRail }
    }
    // The native root tab bar survives a push, so a chat would sit above the
    // five app tabs. Any pushed Work route (chat, new chat, import) hides it.
    // Emitted from the tab's own root, not only from the destination: a
    // destination preference is not reliably visible to the `TabView`. A
    // display with an edge rail keeps it: the rail is the tab bar there, and
    // hiding it leaves an empty glass capsule under the composer.
    .adeRootTabBarHidden(!path.isEmpty && !workListHasEdgeRail)
  }

  /// The Duo's inner display: two sibling navigation stacks, never one stack
  /// around both, because iOS lays the TRAILING stack's toolbar along the
  /// curved edge as the vertical rail (see DuoWorkSplit.swift).
  /// - Held landscape: the sessions column | the detail column (a chat with
  ///   its tools pane, the new-chat page, the board, or the empty state).
  /// - Held portrait: the detail column full width, the sessions column an
  ///   overlay its sidebar button brings in.
  ///
  /// The sessions list is always mounted, collapsed or not: its list carries
  /// the screen's data tasks and alerts, exactly as the phone's list does under
  /// a pushed chat.
  private var duoWideBody: some View {
    GeometryReader { proxy in
      let fold = DuoFoldReading.fold(in: proxy)
      let family = duoFamily(fold: fold)
      let listFits = duoSessionsColumnFits(size: proxy.size, fold: fold)
      ZStack {
        duoColumns(family: family, fold: fold, size: proxy.size)
        if !path.isEmpty {
          // Anything still pushed (a fixture's delayed open) covers the
          // columns as it does on the phone. Its root is clear, so a back
          // swipe reveals the columns, which never left.
          NavigationStack(path: $path) {
            Color.clear
              .containerBackground(.clear, for: .navigation)
              .toolbar(.hidden, for: .navigationBar)
              .navigationDestination(for: WorkSessionRoute.self) { route in
                sessionDestinationView(route, inColumn: false)
              }
              .navigationDestination(for: WorkNewChatRoute.self) { route in
                newChatDestination(route)
              }
          }
          .transition(.move(edge: .trailing))
        }
      }
      .animation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion), value: path.isEmpty)
      .environment(\.duoWorkFamily, family)
      .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
        if duoWideSize != size { duoWideSize = size }
      }
      .onChange(of: fold) { _, next in
        if duoWideFold != next { duoWideFold = next }
      }
      .onChange(of: family, initial: true) { _, next in
        handleDuoFamilyChange(next, listFits: listFits)
      }
      // Turning the open display upright narrows the screen: the chat keeps a
      // readable width and the sessions column steps aside (and comes back
      // when the room does).
      .onChange(of: listFits, initial: true) { _, fits in
        guard family == .wide, !duoPane.isOpen else { return }
        withAnimation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion)) {
          duoShowsSessionList = fits
        }
      }
      // Opening the tools pane cedes the sessions column, exactly like the
      // desktop sidebar; closing it hands the column back (held landscape
      // only: held portrait the list is an overlay that is already away).
      // Set in the pane's own open/close, not in an onChange after it: the
      // list then goes in the same transaction as the pane arrives, instead of
      // a beat later with the pane pushed half off-screen meanwhile.
      .onAppear {
        duoWideFold = fold
        duoWideSize = proxy.size
        duoPane.willChangeOpen = { [duoWorkFamilyBox = $duoWorkFamily, list = $duoShowsSessionList, reduceMotion] open in
          guard duoWorkFamilyBox.wrappedValue == .wide else { return }
          withAnimation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion)) {
            list.wrappedValue = !open
          }
        }
      }
    }
    .background(ADEColor.pageBackground)
    .task(id: duoPreviewSelectionKey) { applyDuoPreviewSelectionIfNeeded() }
    // The swapped-out stack's rail items stayed behind as empty glass over
    // the composer (a circle from nothing-picked's New chat, a capsule from a
    // chat's tool group).
    .onChange(of: duoDetailStackKind) { _, _ in
      if duoLayout.hasEdgeBar { DuoShellChrome.shared.requestBarRebind() }
    }
  }


  /// What the detail column shows, in priority order.
  private enum DuoDetail {
    case compose(WorkNewChatRoute)
    case chat(WorkSessionRoute)
    case board
    case empty
  }

  private var duoDetail: DuoDetail {
    if let route = duoComposeRoute { return .compose(route) }
    if let route = duoSelectedRoute { return .chat(route) }
    if duoViewMode == .board { return .board }
    return .empty
  }

  /// Which navigation stack the detail column holds: changing it swaps the
  /// stack under the edge bar (see `DuoShellChrome.requestBarRebind`).
  private var duoDetailStackKind: Int {
    switch duoDetail {
    case .compose: return 0
    case .chat: return 1
    case .board, .empty: return 2
    }
  }

  @ViewBuilder
  private func duoColumns(family: DuoFamily, fold: DuoFold, size: CGSize) -> some View {
    if family == .tall {
      duoTallColumns(size: size)
    } else {
      duoWideColumns(fold: fold, size: size)
    }
  }

  /// Sessions | detail. The list keeps its slot when it collapses, at zero
  /// width, so its tasks keep running and its scroll position stays.
  private func duoWideColumns(fold: DuoFold, size: CGSize) -> some View {
    let column = DuoWorkMetrics.sessionsColumn(total: size.width, fold: fold)
    // The board is the whole screen, as on desktop: no list beside it.
    let listShown: Bool = {
      if case .board = duoDetail { return false }
      return duoShowsSessionList
    }()
    return HStack(spacing: 0) {
      // The list is always laid out at the column's full width; collapsing
      // only narrows the window onto it. A list whose own width animated from
      // zero kept rows (and its header) sized to a mid-animation width.
      duoSessionsColumn
        .frame(width: column.width)
        .frame(width: listShown ? column.width : 0, alignment: .leading)
        .mask { Rectangle().ignoresSafeArea() }
        .opacity(listShown ? 1 : 0)
        .allowsHitTesting(listShown)
        .accessibilityHidden(!listShown)
      if listShown {
        DuoSeam(axis: .vertical, foldRect: column.fold)
      }
      duoDetailColumn
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .animation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion), value: listShown)
  }

  /// Held portrait: the detail full width, and the list as an overlay column
  /// the sidebar button brings in. With nothing open the list is the page.
  private func duoTallColumns(size: CGSize) -> some View {
    let listIsPage: Bool = {
      if case .empty = duoDetail { return true }
      return false
    }()
    let overlayShown = duoShowsSessionList && !listIsPage
    let overlayWidth = min(DuoWorkMetrics.listWidth, size.width * 0.6)
    return ZStack(alignment: .leading) {
      duoDetailColumn
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(listIsPage ? 0 : 1)
        .allowsHitTesting(!listIsPage && !overlayShown)
      if overlayShown {
        Color.black.opacity(0.18)
          .ignoresSafeArea()
          .onTapGesture { toggleDuoSessionsColumn() }
          .transition(.opacity)
          .accessibilityLabel("Hide chats")
          .accessibilityAddTraits(.isButton)
      }
      duoSessionsColumn
        .frame(width: listIsPage ? size.width : overlayWidth)
        .background(ADEColor.pageBackground.ignoresSafeArea())
        // A mask that reaches into the safe area: the column's navigation bar
        // lives there, and a plain clip would cut it off.
        .mask {
          RoundedRectangle(cornerRadius: listIsPage ? 0 : 28, style: .continuous)
            .ignoresSafeArea()
        }
        .shadow(color: .black.opacity(overlayShown ? 0.18 : 0), radius: 24, x: 6)
        .padding(listIsPage ? 0 : 8)
        .offset(x: listIsPage || overlayShown ? 0 : -(overlayWidth + 40))
        .allowsHitTesting(listIsPage || overlayShown)
        .accessibilityHidden(!(listIsPage || overlayShown))
    }
    .animation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion), value: overlayShown)
    .animation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion), value: listIsPage)
  }

  /// The sessions column, as the real list: filters, grouping, row menus and
  /// every list-level task stay exactly as they are in the compact layout. Only
  /// the chrome is native (see `duoSessionsToolbar`).
  private var duoSessionsColumn: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        workList(proxy: proxy, duoColumn: true)
          .duoLeadingColumnContent()
      }
    }
  }

  @ViewBuilder
  private var duoDetailColumn: some View {
    switch duoDetail {
    case .compose(let route):
      duoComposeColumn(route)
    case .chat(let route):
      sessionDestinationView(route, inColumn: true)
    case .board, .empty:
      // One case, so one NavigationStack across List ⇄ Board: a stack swapped
      // in under the edge bar drops its rail-top item (New Chat) to an empty
      // bubble at the bottom of the column.
      duoBoardOrEmptyColumn(isBoard: { if case .board = duoDetail { return true } else { return false } }())
    }
  }

  /// The phone's new-chat page, in the detail column beside the list, as
  /// desktop opens a new chat. Picking a chat in the list puts it away (no
  /// Cancel of its own); starting the chat turns it into that chat, in place.
  private func duoComposeColumn(_ route: WorkNewChatRoute) -> some View {
    NavigationStack {
      newChatDestination(route)
        .toolbar {
          // Activity and Settings are in the sessions ⋯, not on the rail.
          DuoAppTabsToolbar(includesUtilities: !duoLayout.hasEdgeBar)
        }
        .modifier(duoShowSessionsItem)
    }
    // Import session (pushed from this page) takes the whole screen for its
    // list | preview, as desktop's dialog does; the list comes back after.
    .environment(\.workImportClaimsFullWidth) { claims in
      withAnimation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion)) {
        duoShowsSessionList = claims ? false : duoWorkFamily == .wide
      }
    }
    .id(route.preferredLaneId ?? "-")
  }

  /// The board, or nothing picked (a quiet note in the middle of the column),
  /// in the detail column. The rail keeps New Chat and the app tabs in both;
  /// the board adds ‹ project logo, "Work" and the List | Board switch.
  private func duoBoardOrEmptyColumn(isBoard: Bool) -> some View {
    NavigationStack {
      Group {
        if isBoard {
          duoBoardContent
            .toolbar {
              DuoHubBackToolbarItem()
              duoBoardHeaderItem
            }
        } else {
          DuoWorkEmptyDetail(
            canCreate: inputs.isLive,
            showsNewChatButton: true,
            onNewChat: pushNewChatRoute
          )
          .modifier(duoShowSessionsItem)
        }
      }
      .navigationTitle(isBoard ? "Board" : "")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(removing: .title)
      .toolbar {
        // Never on the edge bar: opening New chat swaps this stack for the
        // compose one, and the edge bar then dropped the rail-top item to an
        // empty glass circle over the composer. The sessions column's header,
        // the empty state and the board header carry New chat there.
        if isBoard && !duoLayout.hasEdgeBar {
          ToolbarItem(placement: .topBarTrailing) { duoNewChatRailButton }
        }
        // Activity and Settings are in the sessions ⋯, not on the rail.
        DuoAppTabsToolbar(includesUtilities: !duoLayout.hasEdgeBar)
      }
    }
  }

  private var duoBoardContent: some View {
    let topLevel = displaySessions.filter { sessionPresentation.topLevelDisplaySessionIds.contains($0.id) }
    let board = duoWorkBoardColumns(
      sessions: topLevel,
      chatSummaries: chatSummaries,
      archivedSessionIds: archivedSessionIds,
      laneWaitingReasonByLaneId: workLaneWaitingReasonByLaneId(lanes: lanes, pullRequests: pullRequests),
      busySubagentParentIds: sessionPresentation.busySubagentParentIds
    )
    return DuoWorkBoard(
      columns: board.columns,
      waitingReasons: board.waitingReasons,
      laneColor: { session in
        laneById[session.laneId].map { LaneColorPalette.displayColor(forHex: $0.color) }
      },
      card: { session in
        sessionListRow(session, compact: false, showsLaneIdentity: true, transitionNamespace: nil, boardCard: true)
      }
    )
  }

  @ToolbarContentBuilder
  private var duoBoardHeaderItem: some ToolbarContent {
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      ToolbarItem(placement: .topBarLeading) { duoBoardHeader }
        .sharedBackgroundVisibility(.hidden)
        .axisBehavior(.horizontalOnly)
    } else {
      ToolbarItem(placement: .topBarLeading) { duoBoardHeader }
        .sharedBackgroundVisibility(.hidden)
    }
    #else
    ToolbarItem(placement: .topBarLeading) { duoBoardHeader }
      .sharedBackgroundVisibility(.hidden)
    #endif
  }

  private var duoBoardHeader: some View {
    HStack(spacing: 14) {
      Text("Work")
        .font(.system(size: 22, weight: .heavy, design: .rounded))
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize()
        .accessibilityAddTraits(.isHeader)
      Picker("View", selection: duoViewModeBinding) {
        ForEach(DuoWorkViewMode.allCases) { mode in
          Text(mode.title).tag(mode)
        }
      }
      .pickerStyle(.segmented)
      .frame(width: 150)
      if duoLayout.hasEdgeBar {
        Button(action: pushNewChatRoute) {
          Image(systemName: "square.and.pencil")
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(inputs.isLive ? ADEColor.textPrimary : ADEColor.textMuted)
            .frame(width: 36, height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!inputs.isLive)
        .accessibilityLabel("New chat")
      }
    }
  }

  /// The detail column's way back to the list while the list is away.
  private var duoShowSessionsItem: DuoShowSessionsItem {
    DuoShowSessionsItem(shown: !duoShowsSessionList) { toggleDuoSessionsColumn() }
  }

  /// Held portrait with nothing open, the list is the whole page: it carries
  /// the app tabs itself, and has no column to collapse.
  private var duoListIsPage: Bool {
    guard duoWorkFamily == .tall else { return false }
    if case .empty = duoDetail { return true }
    return false
  }

  /// New Chat as the rail's one filled circle.
  private var duoNewChatRailButton: some View {
    // A plain toolbar button: the edge bar lifts a custom-styled item
    // (.glassProminent) out of the rail as an empty floating capsule.
    Button("New chat", systemImage: "square.and.pencil", action: pushNewChatRoute)
      .disabled(!inputs.isLive)
      .accessibilityIdentifier("Duo.Work.Rail.NewChat")
  }

  /// The sidebar button (the sessions column's own, or the chat's when the
  /// column is away). Held landscape, hiding the list gives the thread its
  /// width back, and showing it must not squeeze the thread below something
  /// readable: when the pane is the reason it would, the pane gives way. Held
  /// portrait it slides the overlay in and out.
  private func toggleDuoSessionsColumn() {
    withAnimation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion)) {
      if duoShowsSessionList {
        duoShowsSessionList = false
      } else {
        duoShowsSessionList = true
        if duoWorkFamily == .wide, duoPane.isOpen, duoChatWidthWithList() < DuoWorkMetrics.minChatWidth {
          duoPane.close()
        }
      }
    }
  }

  /// The thread's width if the sessions column were showing now, with the pane
  /// still open. The pane's own width rule is shared, so the two cannot
  /// disagree about whether everything fits.
  private func duoChatWidthWithList() -> CGFloat {
    let total = duoWideSize.width
    guard total > 0 else { return DuoWorkMetrics.minChatWidth }
    let list = DuoWorkMetrics.sessionsColumn(total: total, fold: duoWideFold).width
    let detail = max(0, total - list - 1)
    // With the list beside them the hinge is too close for a split on it:
    // the thread and the pane share what is left half and half.
    return DuoWorkMetrics.wideSplit(width: detail, fold: .none, hingeX: nil).chat
  }

  /// Side by side on every open, flat display, held either way (an iPad too);
  /// stacked (tools over the chat) only while the hinge is bent with the fold
  /// across the screen: laptop and tent.
  private func duoFamily(fold: DuoFold) -> DuoFamily {
    #if DEBUG
    if DuoWorkPreviewState.forceStacked, WorkRootPreviewFixture.active != nil { return .tall }
    #endif
    return fold.isStacked && duoLayout.bend > 0 ? .tall : .wide
  }

  /// Whether the sessions column leaves the chat a readable width. Held
  /// upright the Duo is about as wide as an iPad mini: the column starts away.
  private func duoSessionsColumnFits(size: CGSize, fold: DuoFold) -> Bool {
    // Book-folded the two pages are the list and the chat, always.
    if case .sideBySide = fold { return true }
    let column = DuoWorkMetrics.sessionsColumn(total: size.width, fold: fold)
    return size.width - column.width >= DuoWorkMetrics.comfortableChatWidth
  }

  /// Rotating between held landscape and held portrait resets what the list
  /// is: a column beside the chat, or an overlay that starts away.
  private func handleDuoFamilyChange(_ family: DuoFamily, listFits: Bool) {
    guard duoWorkFamily != family else { return }
    duoWorkFamily = family
    switch family {
    case .tall:
      duoShowsSessionList = false
    case .wide:
      duoShowsSessionList = !duoPane.isOpen && listFits
    case .compact:
      break
    }
  }

  /// A width change is the one moment the two layouts disagree about where the
  /// open chat lives. Carrying it over keeps unfolding from dumping the reader
  /// back on the list.
  private func handleDuoWidthChange(_ wide: Bool) {
    guard wide else {
      // Folding back to the phone layout carries the open chat (or the
      // new-chat page) into the stack, so the reader does not land back on
      // the list.
      if path.isEmpty {
        if let route = duoSelectedRoute {
          path.append(route)
        }
        if let compose = duoComposeRoute {
          path.append(compose)
        }
      }
      duoComposeRoute = nil
      return
    }
    // A tool was open before the fold: keep the column collapsed so the split
    // does not have to give up room it had already ceded.
    duoShowsSessionList = !duoPane.isOpen
    if duoSelectedRoute == nil,
       let transition = selectedSessionTransitionId {
      if let session = mergedSessions.first(where: { $0.id == transition }) {
        duoSelectSession(session)
      } else {
        duoSelectedRoute = WorkSessionRoute(sessionId: transition)
      }
    }
    // A chat pushed on the phone is a chat in the column here; a pushed
    // new-chat page is the column's new-chat page.
    if !path.isEmpty { path = NavigationPath() }
  }

  /// Re-selects the fixture chat on a `duo-*` screenshot, and nothing at all in
  /// a real run.
  private var duoPreviewSelectionKey: String {
    #if DEBUG
    "\(mergedSessions.count)|\(duoSelectedRoute?.sessionId ?? "-")"
    #else
    ""
    #endif
  }

  private func applyDuoPreviewSelectionIfNeeded() {
    #if DEBUG
    guard WorkRootPreviewFixture.active != nil else { return }
    // The phone layout (closed Duo, any iPhone): the fixture chat pushed, as
    // a tap on its row would.
    if !duoLayout.isWide {
      if !DuoWorkPreviewState.pushedCompact, path.isEmpty,
         let requested = DuoWorkPreviewState.sessionId,
         mergedSessions.contains(where: { $0.id == requested }) {
        DuoWorkPreviewState.pushedCompact = true
        path.append(WorkSessionRoute(sessionId: requested))
      }
      return
    }
    if DuoWorkPreviewState.compose, duoComposeRoute == nil {
      DuoWorkPreviewState.compose = false
      duoComposeRoute = WorkNewChatRoute(preferredLaneId: nil)
    }
    if duoSelectedRoute == nil, let requested = DuoWorkPreviewState.sessionId,
       let session = mergedSessions.first(where: { $0.id == requested }) {
      duoSelectSession(session)
    }
    if DuoWorkPreviewState.collapsed, duoShowsSessionList {
      duoShowsSessionList = false
    }
    #endif
  }

  /// The sessions column's toolbar, Voice Memos' list column: the sidebar
  /// button as a glass circle at the top-left; Filter and ⋯ (with the List |
  /// Board switch) as one glass capsule and New Chat as its own on the right;
  /// the large "Work" title under them, and the search field under that.
  /// Nothing at the bottom: the column's bottom bar would cross the screen.
  @ToolbarContentBuilder
  private var duoSessionsToolbar: some ToolbarContent {
    if isSelecting {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel", action: exitSelectionMode)
      }
    } else {
      // ‹ project logo (back to the Hub), then "Work".
      ToolbarItem(placement: .topBarLeading) {
        HStack(spacing: 6) {
          WorkHeaderProjectButton(iconDataUrl: inputs.projectIconDataUrl, action: workHeaderActions.onBackToHub)
          Text("Work")
            .font(.system(size: 22, weight: .heavy, design: .rounded))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .fixedSize()
            .accessibilityAddTraits(.isHeader)
        }
        .padding(.horizontal, 4)
      }
      .sharedBackgroundVisibility(.hidden)
      if !duoListIsPage {
        ToolbarItem(placement: .topBarTrailing) {
          Button(duoWorkFamily == .tall ? "Hide chats" : "Collapse sidebar", systemImage: "sidebar.left") {
            ADEHaptics.light()
            toggleDuoSessionsColumn()
          }
          .accessibilityIdentifier("Duo.Work.SessionsCollapse")
        }
      }
      if duoListIsPage {
        DuoAppTabsToolbar(includesUtilities: !duoLayout.hasEdgeBar)
      }
    }
  }

  /// The sessions column's first header row: ‹ project logo (back to the
  /// Hub) and "Work", with the sidebar button on the column's trailing
  /// margin.
  private var duoSessionsTitleRow: some View {
    HStack(spacing: 6) {
      WorkHeaderProjectButton(iconDataUrl: inputs.projectIconDataUrl, action: workHeaderActions.onBackToHub)
      Text("Work")
        .font(.system(size: 22, weight: .heavy, design: .rounded))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .accessibilityAddTraits(.isHeader)
      Spacer(minLength: 8)
      Button {
        ADEHaptics.light()
        toggleDuoSessionsColumn()
      } label: {
        Image(systemName: "sidebar.left")
          .font(.system(size: 17, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(width: 32, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(duoWorkFamily == .tall ? "Hide chats" : "Collapse sidebar")
      .accessibilityIdentifier("Duo.Work.SessionsCollapse")
    }
    .padding(.horizontal, 16)
    .frame(minHeight: 52)
    // On the bar's row, level with the chat's title capsule (and the tools
    // pane's header) on the right: the column hides its bar, so it takes the
    // bar's place itself.
    .padding(.top, duoLayout.hasEdgeBar ? 20 : 0)
  }

  /// The sessions column's second header row, the phone's: search with the
  /// filter chip inside it, New chat, and ⋯ (with the List | Board switch).
  private var duoSessionsSearchRow: some View {
    HStack(spacing: 8) {
      WorkHeaderSearchField(
        searchText: searchTextBinding,
        filterOpen: $filterPanelOpen,
        activeFilterCount: workActiveFilterCount
      )
      Button(action: pushNewChatRoute) {
        Image(systemName: "square.and.pencil")
          .font(.system(size: 18, weight: .medium))
          .foregroundStyle(inputs.isLive ? ADEColor.textPrimary : ADEColor.textMuted)
          .frame(width: 32, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!inputs.isLive)
      .accessibilityLabel("New chat")
      .accessibilityIdentifier("Duo.Work.NewChat")
      WorkHeaderOverflowMenu(
        showsLinear: inputs.showsLinear,
        showsCursorCloud: inputs.showsCursorCloud,
        showsGitHubIssues: inputs.showsGitHubIssues,
        actions: workHeaderActions,
        viewMode: duoViewModeBinding
      )
    }
    .padding(.horizontal, 16)
    .padding(.bottom, 6)
    .background(ADEColor.pageBackground.opacity(0.94))
  }

  /// The chat awaits one constructor in both layouts; only the chrome and the
  /// wide extras differ. Split out so a pushed chat and a column chat cannot
  /// drift on the data they hand the destination.
  @ViewBuilder
  private func sessionDestinationView(_ route: WorkSessionRoute, inColumn: Bool) -> some View {
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
        initialChatSummary: chatSummaries[route.sessionId]
          ?? workRemoteMachineRosterChat(sessionId: route.sessionId, in: inputs.remoteMachineRepos)?.rosterChatSummary,
        transitionNamespace: routeTransitionNamespace,
        isLive: inputs.isLive,
        navigationChrome: inColumn ? .column : .pushedDetail,
        // `sessionPresentationTaskKey` goes nil once a screen is pushed off the
        // root, so `workOrderedLanes` stops refreshing there — fall back to the
        // live `lanes` when the presentation-derived order isn't available.
        lanes: workOrderedLanes.isEmpty ? lanes : workOrderedLanes,
        crossProjectContext: route.remoteChat,
        duoPane: inColumn ? duoPane : nil,
        duoPaneOpen: inColumn && duoPane.isOpen,
        duoShowsSidebar: inColumn && duoShowsSessionList,
        onDuoToggleSidebar: inColumn ? { toggleDuoSessionsColumn() } : nil,
        onDuoBack: inColumn ? { duoClearSelection() } : nil
      )
      .equatable()
    }
    .id(route.openId)
    // Chat Info's child chats, read from the same rows this list holds: a
    // nested subagent is listed nowhere else, and a child on another machine
    // keeps its namespaced lane id so opening it goes to that machine.
    .environment(\.workChatChildRoster, workChatChildRoster(
      parentId: route.sessionId,
      sessions: mergedSessions,
      chatSummaries: chatSummaries,
      now: Date()
    ))
    // The chat's ⋯ is the list row's own menu (Select aside), wired to the
    // same actions, so the two can never offer different things.
    .environment(\.workSessionActionsMenu, WorkSessionActionsMenuProvider { session in
      sessionListRow(
        mergedSessions.first(where: { $0.id == session.id }) ?? session,
        compact: false,
        showsLaneIdentity: true,
        transitionNamespace: nil
      )
    })
    .environmentObject(syncService)
    .environmentObject(dictationController)
  }

  @ViewBuilder
  private func newChatDestination(_ route: WorkNewChatRoute) -> some View {
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
        await showNewChatRoute(WorkSessionRoute(
          sessionId: sessionId,
          openingPrompt: trimmed.isEmpty ? nil : trimmed,
          openingPromptDispatchHandled: openerDispatchHandled,
          openingDeliveryState: openerDeliveryState,
          openingAttachments: openerAttachments
        ))
        Task { @MainActor in
          await reload(refreshRemote: true)
        }
      },
      onCliStarted: { session in
        optimisticSessions[session.id] = session
        selectedSessionTransitionId = nil
        await showNewChatRoute(WorkSessionRoute(sessionId: session.id))
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
        await showNewChatRoute(WorkSessionRoute(sessionId: chatSessionId))
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
        await showNewChatRoute(WorkSessionRoute(sessionId: sessionId))
      }
    )
    .environmentObject(syncService)
    .environmentObject(dictationController)
  }

  /// The new-chat screen's handover: a pushed chat on every phone, the detail
  /// column's chat on a wide display.
  private func showNewChatRoute(_ route: WorkSessionRoute) async {
    await Task.yield()
    if duoLayout.isWide {
      // The compose page becomes the chat, in place, beside the list.
      path = NavigationPath()
      duoComposeRoute = nil
      if let previous = duoSelectedRoute?.sessionId, previous != route.sessionId {
        WorkSeenStore.stamp([previous])
      }
      if duoViewMode == .board { duoViewModeRaw = DuoWorkViewMode.list.rawValue }
      selectedSessionTransitionId = route.sessionId
      duoSelectedRoute = route
    } else {
      var fresh = NavigationPath()
      fresh.append(route)
      path = fresh
    }
    syncService.persistOpenWorkSessionRoute(sessionId: route.sessionId)
  }

  private func workList(proxy: ScrollViewProxy, duoColumn: Bool = false) -> some View {
    let rows = List {
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
          // Search and the filter button live in the header; the open panel
          // floats over the list (below), so it opens wherever the list is
          // scrolled. Only the Clear affordance for active filters sits here.
          if hasActiveFilters && !filterPanelOpen {
            workFiltersSection
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
              if hasActiveFilters {
                // The rows exist; a filter hides them. Offer the way back.
                Button("Clear filters") {
                  withAnimation(.snappy(duration: 0.18)) { clearWorkFilters() }
                }
                .buttonStyle(.glass)
                .tint(ADEColor.accent)
              } else {
                Button("New chat") {
                  pushNewChatRoute()
                }
                .buttonStyle(.glassProminent)
                .tint(ADEColor.accent)
                .disabled(!inputs.isLive)
              }
            }
            .listRowInsets(EdgeInsets(top: 24, leading: 16, bottom: 16, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          } else {
            ForEach(visibleSessionGroups) { group in
              workSessionGroupSection(group)
            }
          }
        }
      }
      .listStyle(.plain)
      .listSectionSpacing(.custom(Self.workGroupSectionSpacing))
      // Rows size themselves; the 44pt default floor turned the one-line
      // subagent/shell marks row into a 44pt band floating between chats.
      .environment(\.defaultMinListRowHeight, 1)
      .scrollContentBackground(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .contentMargins(.bottom, workRootBottomTabBarScrollMargin, for: .scrollContent)
      // The header sits in a safe-area inset directly above; the list's own
      // top margin would double the gap under it.
      .contentMargins(.top, 0, for: .scrollContent)
      // A regular-width list may add its own readable-width side margins; the
      // sessions column is narrow and its rows carry their own insets, so it
      // takes the column's whole width.
      .contentMargins(.horizontal, duoColumn ? 0 : nil, for: .scrollContent)
      .adeScreenBackground()
      .adeNavigationGlass()
    // The filter panel drops from under the header (search and its filter
    // chip), not over it: on the rows, whose safe area the header insets.
    let rowsWithFilters = rows
      .overlay(alignment: .top) {
        if filterPanelOpen {
          ZStack(alignment: .top) {
            // Tapping outside the panel closes it, like a desktop dropdown.
            Color.black.opacity(0.001)
              .ignoresSafeArea()
              .onTapGesture {
                withAnimation(.snappy(duration: 0.18)) { filterPanelOpen = false }
              }
            workFiltersSection
              .padding(.horizontal, 12)
              .padding(.top, 4)
          }
          .transition(.opacity.combined(with: .move(edge: .top)))
        }
      }
      .animation(.snappy(duration: 0.18), value: filterPanelOpen)
    let list = workListChrome(rowsWithFilters, duoColumn: duoColumn)
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
        if newCount == 0, let leftSessionId = selectedSessionTransitionId {
          // Leaving a chat is what marks it seen (desktop stamps the same
          // moment): everything it showed, including output that landed while
          // the user was reading, no longer holds its lane out of the shelf.
          WorkSeenStore.stamp([leftSessionId])
          selectedSessionTransitionId = nil
          // The stamp lives outside the rebuild key, so re-derive the folds now.
          scheduleSessionPresentationRebuild()
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
        #if DEBUG
        // A fixture keeps one project for its whole run (`WorkListPreviewHost`);
        // a flicker of the active id must not pop its open chat.
        if WorkRootPreviewFixture.active != nil { return }
        #endif
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
        GitHubIssuesMenuAvailability.shared.refresh(sync: syncService, projectId: inputs.activeProjectId)
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
      // The transcript draws lane and chat chips from these lists, so a lane
      // id an agent prints shows the lane's name, colour and live state.
      .onChange(of: projectionDataRevision, initial: true) { _, _ in
        WorkThreadEntityDirectory.shared.record(lanes: lanes, sessions: sessions)
      }
      .navigationDestination(for: WorkSessionRoute.self) { route in
        sessionDestinationView(route, inColumn: false)
      }
      .navigationDestination(for: WorkNewChatRoute.self) { route in
        newChatDestination(route)
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
    return sessionMenuPresentations(list)
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

  /// The list's chrome. The phone keeps its one-row header floating over the
  /// list; the Duo's sessions column is a native navigation bar with the title,
  /// search and the toolbar.
  @ViewBuilder
  private func workListChrome<Rows: View>(_ rows: Rows, duoColumn: Bool) -> some View {
    if duoColumn {
      // The phone's Work header, in two rows: ‹ project logo and "Work" with
      // the sidebar button at the right end; then search (filter inside it),
      // New chat and ⋯, the phone's own row.
      // Both rows are the column's own (not bar items), so the sidebar button
      // sits on the column's trailing margin, right above the ⋯. The bar
      // stays for selecting and for the held-upright page (tabs menu).
      let ownsHeader = !isSelecting && !duoListIsPage
      rows
        .navigationTitle(isSelecting ? "\(selectedSessionIds.count) selected" : "Work")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(removing: isSelecting ? nil : .title)
        .toolbar(ownsHeader ? .hidden : .automatic, for: .navigationBar)
        .toolbar { duoSessionsToolbar }
        .safeAreaInset(edge: .top, spacing: 0) {
          if !isSelecting {
            VStack(spacing: 0) {
              if ownsHeader {
                duoSessionsTitleRow
              }
              duoSessionsSearchRow
            }
          }
        }
    } else {
      // Every phone, the Duo's closed outer display included: the header's
      // own row (no buttons on the outer display's rail, which then keeps
      // its five tabs held landscape, and no bell: Activity is in ⋯).
      rows
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
            showsGitHubIssues: inputs.showsGitHubIssues,
            selectionCount: isSelecting ? selectedSessionIds.count : nil,
            actions: workHeaderActions
          )
        }
    }
  }

  /// The session menu's own alerts and sheets (tag, restart, the three
  /// handoff sheets and the auto-handoff rule refresh). Kept out of
  /// `workList`'s modifier chain: with them inline, Swift could not
  /// type-check that expression in reasonable time (CI test-ios).
  private func sessionMenuPresentations<Content: View>(_ content: Content) -> some View {
    content
      .alert("Set tag", isPresented: Binding(
        get: { tagTarget != nil },
        set: { if !$0 { tagTarget = nil } }
      )) {
        TextField("Tag (empty clears)", text: $tagText)
        Button("Cancel", role: .cancel) { tagTarget = nil }
        Button("Save") {
          let target = tagTarget
          let tag = tagText
          tagTarget = nil
          if let target { submitTag(target, tag: tag) }
        }
      } message: {
        Text("Tags the Claude session so you can find it in Claude's own session list.")
      }
      .alert("Stop the turn and restart?", isPresented: Binding(
        get: { restartStopTurnTarget != nil },
        set: { if !$0 { restartStopTurnTarget = nil } }
      ), presenting: restartStopTurnTarget) { session in
        Button("Cancel", role: .cancel) { restartStopTurnTarget = nil }
        Button("Stop and restart", role: .destructive) {
          restartStopTurnTarget = nil
          restartAgentSession(session, stopFirst: true)
        }
      } message: { _ in
        Text("The agent is mid-turn. Restarting stops this turn and any background jobs it started. The conversation is kept.")
      }
      .sheet(item: $localHandoffSubject) { subject in
        WorkLocalHandoffSheet(subject: subject)
          .environmentObject(syncService)
      }
      .sheet(item: $autoHandoffSubject) { subject in
        WorkAutoHandoffSheet(
          subject: subject,
          lanes: lanes,
          onChanged: { rules in autoHandoffRuleIdsBySession[subject.sessionId] = rules.map(\.id) }
        )
        .environmentObject(syncService)
      }
      .sheet(item: $crossMachineHandoffTarget) { target in
        WorkCrossMachineHandoffSheet(target: target)
          .environmentObject(syncService)
      }
      // Once per project (and when the host starts advertising the rules): the
      // menu only needs "does this chat have rules", and the editor re-reads.
      .task(id: "\(inputs.autoHandoffAvailable)|\(inputs.activeProjectId ?? "")|\(sessions.count)") {
        await refreshAutoHandoffRuleIds()
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
        laneMenu: workLaneMenuActions,
        startsQuietZone: group.id == quietZoneStartGroupId,
        branch: duoLayout.isWide ? group.laneId.flatMap { laneById[$0]?.branchRef } : nil,
        minimal: duoLayout.isWide
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
    // Only the shell drawer renders under a row. Nested subagents live in the
    // parent's Chat Info; the row itself carries their mark.
    let shellDrawer = sessionPresentation.shellDrawerByParentId[session.id]
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
    // under the shell drawer instead when there is one, so the drawer reads
    // as part of its parent.
    .workRowHairline(showsDivider && shellDrawer == nil)
    .workLaneAccentRail(railColor, gutter: Self.workLaneRailGutter)
    .id(session.id)
    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)

    if let shellDrawer {
      nestedChildDrawer(
        group: shellDrawer,
        railColor: railColor,
        showsDivider: showsDivider
      )
    }
  }

  /// A chat's shell drawer starts COLLAPSED (`workIsNestedDrawerCollapsed`).
  /// Collapsed, it is one thin mark under the card; opened, its rows render
  /// below that line in the compact form.
  @ViewBuilder
  private func nestedChildDrawer(
    group: WorkShellDrawer,
    railColor: Color?,
    showsDivider: Bool
  ) -> some View {
    let leadingInset = Self.workChildShellIndent - 16 - (railColor == nil ? 0 : Self.workLaneRailGutter)
    if workIsNestedDrawerCollapsed(sectionId: group.collapsedSectionId, collapsedSectionIds: collapsedSectionIds) {
      WorkNestedDrawerMark(group: group) {
        toggleNestedDrawer(group)
      }
      .padding(.leading, leadingInset)
      .padding(.bottom, 4)
      .workRowHairline(showsDivider)
      .workLaneAccentRail(railColor, gutter: Self.workLaneRailGutter)
      .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
    } else {
      WorkNestedSessionSection(
        group: group,
        onCollapse: { toggleNestedDrawer(group) }
      ) {
        ForEach(group.children) { child in
          sessionListRow(
            child,
            compact: true,
            showsLaneIdentity: true,
            transitionNamespace: nil
          )
          .id(child.id)
        }
      }
      .padding(.leading, leadingInset)
      .padding(.bottom, 6)
      .workRowHairline(showsDivider)
      .workLaneAccentRail(railColor, gutter: Self.workLaneRailGutter)
      .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
    }
  }

  private func toggleNestedDrawer(_ group: WorkShellDrawer) {
    withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
      toggleCollapsed(workNestedDrawerOpenMarker(sectionId: group.collapsedSectionId))
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
    transitionNamespace: Namespace.ID?,
    boardCard: Bool = false
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
      subagentMark: sessionPresentation.subagentMarkByParentId[session.id],
      showsLaneIdentity: showsLaneIdentity,
      waitingOnSubagent: sessionPresentation.busySubagentParentIds.contains(session.id),
      boardCard: boardCard,
      // The Duo's sessions column (and an iPad's) draws the wide row; a phone
      // keeps its own full-width row, and drawer shells their compact form.
      duoRow: duoLayout.isWide && !boardCard && !compact,
      machineName: workRemoteLaneMachineName(session.laneId, options: inputs.machineFilterOptions),
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
      laneMenu: workLaneMenuActions,
      generateNamesAvailable: inputs.generateNamesAvailable,
      onGenerateNames: generateSessionNames,
      // Per chat: a chat on another machine (or in another project) is served
      // by that brain, so each item asks the host that owns THIS chat.
      tagAvailable: syncService.canInvokeChatRemoteAction("chat.updateSession", sessionId: session.id),
      onSetTag: beginSetTag,
      restartAvailable: syncService.canInvokeChatRemoteAction("chat.restartSession", sessionId: session.id),
      onRestartAgent: { session in restartAgentSession(session, stopFirst: false) },
      localHandoffAvailable: syncService.canInvokeChatRemoteAction("chat.handoff", sessionId: session.id),
      crossMachineHandoffAvailable: syncService.crossMachineHandoffAvailable(sessionId: session.id),
      crossMachineCancelAvailable: syncService.crossMachineHandoffActionAvailable(
        "chat.cancelCrossMachineHandoff",
        sessionId: session.id
      ),
      crossMachineRetryAvailable: syncService.crossMachineHandoffActionAvailable(
        "chat.retryCrossMachineHandoff",
        sessionId: session.id
      ),
      autoHandoffAvailable: syncService.autoHandoffRulesAvailable(sessionId: session.id),
      autoHandoffRuleCount: autoHandoffRuleIdsBySession[session.id]?.count,
      onHandoff: handleSessionHandoff
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
    (selectedStatus != .all ? 1 : 0)
      + (selectedLaneId != "all" ? 1 : 0)
      + workParseMachineFilter(machineFilterStorage).count
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
      onOpenGitHubIssues: { syncService.githubIssuesPanePresented = true },
      onOpenSettings: { syncService.settingsPresented = true }
    )
  }

  func clearWorkFilters() {
    restoreWorkViewStateAfterDeeplink()
    searchText = ""
    selectedLaneId = "all"
    selectedStatus = .all
    machineFilterStorage = ""
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
