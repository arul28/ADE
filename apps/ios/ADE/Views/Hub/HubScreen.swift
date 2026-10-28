import SwiftUI

// The all-projects hub — the mobile app's main surface once a machine is
// connected. Every project on every paired machine as a grid of cards with
// their agents' status counts (from the live roster feed); tapping a card
// opens the project, the only way to its lanes and chats. One compact row of
// status counts filters the grid (All / Needs you / Working / Waiting / Done).
// The bottom "type to vibecode" box is the inline new-chat composer — focusing
// it expands the full controls above the keyboard (see HubInlineComposer).
//
// Replaces the connected-state layout of the old `project hub`; the
// no-machine / connecting states are preserved here.
struct HubScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var machineFleet: MachineFleet
  // Every other machine's projects, lanes and chats folded into this one list
  // (one list of projects, chats from all machines inside).
  @State private var fleetMerge = HubFleetMerge()
  /// A project that lives only on another machine while the phone focuses it.
  @State private var switchingRemoteProjectId: String?
  @State private var addProjectSheetPresented = false
  /// The machine whose saved project order `projectOrder` holds.
  @State private var layoutConnectionKey: String?
  // User's manual project order (drag-to-reorder). Persisted per machine so the
  // hub looks identical after opening a project and coming back — mobile-only,
  // never touches desktop ordering.
  @State private var projectOrder: [String] = []
  // Whether the bottom composer is expanded (keyboard/session controls up).
  // Owned here so taps on the list behind it collapse it.
  @State private var composerExpanded = false
  @State private var composerSwitchingMachine = false
  @State private var projectOpenFailureToast: ADEToastMessage?
  /// The Hub notice waiting for a covering pane to close.
  @State private var heldHubNoticeId: UUID?
  // Set when a hub chat row is tapped — drives the chat cover (wired in
  // HubScreen+ChatNavigation).
  @State var openChatTarget: HubChatTarget?
  // "Created in <project> · <lane>" toast shown after a drawer send (the chat is
  // created in place and does NOT auto-open; the toast offers an Open shortcut).
  @State private var createdToast: HubCreatedChat?
  @State private var toastDismissTask: Task<Void, Never>?
  // The active project's chats come straight from the phone's already-synced
  // local DB (authoritative + instant), independent of the cross-project roster
  // feed — so the active card is never stuck on "Loading chats…".
  @State private var activeRoster: RemoteRosterProject?
  // The project id `activeRoster` was built for. `hubPresentationKey` can rebuild
  // before `rebuildKey` refreshes `activeRoster` after a project switch, so we
  // only overlay the local roster when it still matches the project being rendered.
  @State private var activeRosterProjectId: String?
  @State private var hubProjectPresentations: [HubProjectPresentation] = []
  @State private var personalChatsPresented = false
  // Brief success checkmark shown after a quick-connect from the no-machine
  // home (haptic fires at the same moment).
  @State private var showConnectBeat = false
  @State private var connectBeatTask: Task<Void, Never>?
  // Avoid repeatedly requesting the same roster snapshot while a scoped deep
  // link waits for its project/session to appear. Roster revisions still retry
  // local resolution without creating a request loop.
  @State private var requestedRosterLookupRequestId: String?
  @State private var rosterFilter: HubRosterFilter = .all
  @Environment(\.scenePhase) private var scenePhase
  /// The inner display is wide enough for the two-page Home.
  @Environment(\.duoLayout) private var duo

  private var isNoMachineBlankState: Bool {
    // A send switching machines keeps the hub (and its composer) up through
    // the reconnect, so its draft and any error stay on screen.
    !composerSwitchingMachine
      && (syncService.connectionState == .disconnected || syncService.connectionState == .error)
      && fleetMerge.extraProjects.isEmpty
  }

  private var canShowProjects: Bool {
    syncService.connectionState == .connected
  }

  private var hubIsActive: Bool {
    syncService.shouldShowProjectHub && openChatTarget == nil
  }

  var body: some View {
    hubRoot
    .overlay {
      if showConnectBeat { ConnectSuccessBeat() }
    }
    .sheet(isPresented: $addProjectSheetPresented) {
      RemoteProjectAddSheet().environmentObject(syncService)
    }
    .hubChatCover(target: $openChatTarget)
    .overlay(alignment: .bottom) {
      if let toast = createdToast {
        HubCreatedToast(toast: toast, onOpen: { openCreated(toast) }, onDismiss: { dismissToast() })
          .padding(.horizontal, 16)
          .padding(.bottom, 78)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(.spring(response: 0.35, dampingFraction: 0.85), value: createdToast)
    // A project the machine refused to open says why, instead of the tap
    // looking like it hung on the hub.
    .adeToast($projectOpenFailureToast)
    // A tap from outside the app that could not land where it pointed lands
    // here and says why ("Arul's Mac Studio is offline.").
    .onChange(of: syncService.hubNotice, initial: true) { _, _ in
      showHubNoticeIfVisible()
    }
    // A notice that arrived while a pane covered the Hub waits for it to close.
    .onChange(of: syncService.hubIsCoveredBySheet) { _, _ in
      showHubNoticeIfVisible()
    }
    .onChange(of: syncService.projectOpenFailure) { _, failure in
      guard let failure else { return }
      projectOpenFailureToast = ADEToastMessage(
        text: "Couldn’t open \(failure.projectName): \(failure.message)",
        kind: .failure
      )
      syncService.projectOpenFailure = nil
    }
    .task(id: hubCollapseDefaultsConnectionKey) {
      loadHubLayoutForConnection(hubCollapseDefaultsConnectionKey)
    }
    .task(id: workSessionDeepLinkKey) {
      handleRequestedWorkSessionNavigation()
    }
  }

  /// The inner display's Home is two pages, each its own navigation stack (the
  /// trailing one's toolbar is the edge bar), so it cannot sit inside the
  /// phone's single stack: a stack nested in another merges into its bar.
  private var usesWideHome: Bool {
    duo.isWide && openChatTarget == nil && !isNoMachineBlankState
  }

  @ViewBuilder
  private var hubRoot: some View {
    if usesWideHome {
      connectedHub
    } else {
      NavigationStack {
        ZStack(alignment: .top) {
          ADEColor.pageBackground.ignoresSafeArea()
          if openChatTarget != nil {
            HubCoverParkingSurface()
          } else if isNoMachineBlankState {
            HubNoMachineState(onConnectSuccess: triggerConnectBeat)
          } else {
            connectedHub
          }
        }
        .navigationDestination(isPresented: $personalChatsPresented) {
          PersonalChatsScreen()
        }
      }
      .hubHeaderStaysOnTop()
    }
  }

  /// Shows the pending Hub notice as a toast, once the Hub is what the user
  /// sees. While the Linear, Cursor Cloud or GitHub Issues pane is up (it may
  /// hold a draft, so it is never closed for this), the notice is held and
  /// shown when the pane closes, however long that takes.
  private func showHubNoticeIfVisible() {
    guard let notice = syncService.hubNotice else { return }
    if syncService.hubIsCoveredBySheet {
      heldHubNoticeId = notice.id
      return
    }
    let wasHeld = heldHubNoticeId == notice.id
    heldHubNoticeId = nil
    syncService.hubNotice = nil
    // A notice raised while the Hub could not show at all (signed out, still
    // launching) is about a tap the user has long moved past.
    guard wasHeld || notice.isFresh() else { return }
    openChatTarget = nil
    projectOpenFailureToast = ADEToastMessage(text: notice.message, kind: .info)
  }

  private func handleCreated(_ created: HubCreatedChat) {
    createdToast = created
    // Nudge a fresh roster so the new chat surfaces under its project promptly,
    // even if the create routed into a project that wasn't the active one.
    syncService.requestRosterSnapshot()
    toastDismissTask?.cancel()
    toastDismissTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      if !Task.isCancelled { dismissToast() }
    }
  }

  private func dismissToast() {
    toastDismissTask?.cancel()
    createdToast = nil
  }

  private func triggerConnectBeat() {
    connectBeatTask?.cancel()
    withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { showConnectBeat = true }
    connectBeatTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 750_000_000)
      guard !Task.isCancelled else { return }
      withAnimation(.easeOut(duration: 0.2)) { showConnectBeat = false }
    }
  }

  private func openCreated(_ created: HubCreatedChat) {
    dismissToast()
    guard let project = syncService.projects.first(where: { $0.id == created.projectId }) else { return }
    let chat = RemoteRosterChat(
      id: created.sessionId, laneId: "", chatSessionId: nil, title: nil, provider: created.provider, model: nil,
      toolType: created.stubToolType,
      status: .running, awaitingInput: nil, pinned: nil, archived: nil, lastActivityAt: nil, preview: nil
    )
    openChatTarget = HubChatTarget(project: project, lane: nil, chat: chat)
  }

  @MainActor
  private func handleRequestedWorkSessionNavigation() {
    guard let request = syncService.requestedWorkSessionNavigation else { return }
    // A chat already open here yields to a tap from outside the app (a push, a
    // widget, the Live Activity): that tap names the chat the user wants now.
    // An in-app request never replaces the open chat.
    guard openChatTarget == nil || request.origin == .external else { return }
    if request.origin == .external, let fleetTarget = syncService.fleetChatTarget(for: request) {
      openChatTarget = HubChatTarget(
        project: fleetTarget.project.asRemoteMachineProjectSummary,
        lane: fleetTarget.lane,
        chat: fleetTarget.chat,
        machineKey: fleetTarget.machineKey
      )
      if request.attentionItemId != nil {
        Task { await AccountService.shared.acknowledgeAttentionNavigation(request.attentionItemId) }
      }
      syncService.requestedWorkSessionNavigation = nil
      return
    }
    // ContentView and Work observe the same request concurrently during a root
    // transition. Hub only consumes requests assigned to Hub by the shared
    // decision table; active-project rows remain for Work to open.
    guard syncService.navigationDestination(request) == .hub else {
      // Hub is also the cold-launch root. An active/legacy request may already
      // exist before ContentView installs its onChange observer, so hand it to
      // the newly mounted Work root instead of leaving both surfaces waiting.
      syncService.closeProjectHub()
      return
    }
    guard let target = syncService.rosterNavigationTarget(for: request) else {
      if !canShowProjects {
        requestedRosterLookupRequestId = nil
      } else if requestedRosterLookupRequestId != request.id {
        requestedRosterLookupRequestId = request.id
        syncService.requestRosterSnapshot()
        // A paged roster may hold the chat only on the host: ask for it by id.
        // Its arrival moves the roster revision, which runs this again.
        let sessionId = request.sessionId
        Task { await syncService.loadOlderRosterChatForNavigation(sessionId: sessionId) }
      }
      return
    }
    requestedRosterLookupRequestId = nil
    openChatTarget = HubChatTarget(
      project: target.project,
      lane: target.lane,
      chat: target.chat
    )
    if request.attentionItemId != nil {
      Task {
        await AccountService.shared.acknowledgeAttentionNavigation(
          request.attentionItemId
        )
      }
    }
    syncService.requestedWorkSessionNavigation = nil
  }

  private var chatsAttentionCount: Int {
    syncService.personalChatSessions.filter {
      $0.archivedAt == nil && ($0.awaitingInput == true || $0.status == "awaiting-input")
    }.count
  }

  private var connectedHub: some View {
    hubContent
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    // Rebuild the active project's local roster whenever its sessions/lanes
    // change or the active project switches.
    .task(id: rebuildKey) {
      guard rebuildKey != nil else { return }
      activeRoster = syncService.buildActiveProjectLocalRoster()
      activeRosterProjectId = syncService.activeProjectId
      rebuildHubProjectPresentations()
    }
    .task(id: hubPresentationKey) {
      guard hubPresentationKey != nil else { return }
      rebuildHubProjectPresentations()
    }
    .task(id: rosterRequestKey) {
      guard rosterRequestKey != nil, canShowProjects else { return }
      syncService.requestRosterSnapshot()
    }
    .task(id: personalChatsRefreshKey) {
      guard personalChatsRefreshKey != nil else { return }
      _ = try? await syncService.refreshPersonalChats(includeArchived: true)
    }
    // Launches set up in other projects get no pushes. While the Hub is on
    // screen and one is still moving, pull those projects every few seconds;
    // the loop ends as soon as nothing is pending.
    .task(id: foreignLaunchRefreshActive) {
      guard foreignLaunchRefreshActive else { return }
      while !Task.isCancelled {
        await syncService.refreshForeignProjectChatLaunches()
        guard !syncService.foreignChatLaunchRefreshScopes().isEmpty else { return }
        try? await Task.sleep(nanoseconds: 3_000_000_000)
      }
    }
    .task(id: machineFleet.machines) { rebuildHubProjectPresentations() }
    .onChange(of: switchingRemoteProjectId) { _, _ in rebuildHubProjectPresentations() }
  }

  /// The inner display gets the two-page Home; every other iPhone (and the
  /// Duo's outer display) keeps today's single roster, unchanged.
  @ViewBuilder
  private var hubContent: some View {
    if duo.isWide {
      wideHome
    } else {
      phoneHub
    }
  }

  /// The toolbar's actions, shared by every form of the Hub.
  private var hubToolbarActions: HubToolbarActions {
    HubToolbarActions(
      chatsAvailable: syncService.supportsPersonalChats,
      chatsAttentionCount: chatsAttentionCount,
      onAdd: { addProjectSheetPresented = true },
      onOpenChats: { personalChatsPresented = true },
      onOpenActivity: { syncService.attentionDrawerPresented = true },
      onOpenSettings: { syncService.settingsPresented = true }
    )
  }

  /// Two pages: every project, and the agents across them by status (see
  /// `DuoHomeWide`); Chats pushes on the projects page.
  private var wideHome: some View {
    DuoHomeWide(
      presentations: hubProjectPresentations,
      actions: hubToolbarActions,
      showsOverview: canShowProjects || !hubProjectPresentations.isEmpty,
      onOpenAgent: { item in
        openHubChat(item.row.chat, lane: item.lane, project: item.project)
      },
      chatsPresented: $personalChatsPresented,
      title: { HubLiveConnectionMenu() },
      projects: { rosterList },
      composer: { composerBar },
      chatsDestination: { PersonalChatsScreen() }
    )
  }

  private var phoneHub: some View {
    HubPhoneLayout(
      composerExpanded: $composerExpanded,
      actions: hubToolbarActions,
      title: { HubLiveConnectionMenu() },
      filterBar: { rosterFilterBar },
      roster: { rosterList },
      composer: { composerBar }
    )
  }

  @ViewBuilder
  private var rosterFilterBar: some View {
    if (canShowProjects && !syncService.projects.isEmpty) || !fleetMerge.extraProjects.isEmpty {
      HubRosterFilterBar(counts: hubRosterFilterCounts, selection: $rosterFilter)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }
  }

  @ViewBuilder
  private var composerBar: some View {
    // Kept while a send switches machines: the primary is reconnecting, and the
    // draft and any error belong to this composer.
    if canShowProjects || composerSwitchingMachine {
      // The list ends above it: the composer is the screen's footer, never a
      // layer over the last rows.
      HubInlineComposer(
        expanded: $composerExpanded,
        onCreated: handleCreated,
        onMachineSwitch: { composerSwitchingMachine = $0 }
      )
    }
  }

  private var rosterList: some View {
    ScrollView {
      // The grid sizes its own columns to the width, so it fills the page
      // edge to edge (with the usual margins) at any width.
      LazyVStack(spacing: 8) {
        rosterRows
      }
      .frame(maxWidth: .infinity)
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 16)
    }
    .scrollIndicators(.hidden)
    .scrollDismissesKeyboard(.interactively)
  }

  @ViewBuilder
  private var rosterRows: some View {
    // Keep the project catalog mounted while a switch is in flight: only fall
    // back to the connecting card when there's nothing to show yet. The
    // switching row carries its own spinner and the others disable, so the list
    // never blanks to a full-screen connecting swap (M12).
    if !canShowProjects && hubProjectPresentations.isEmpty {
      HubConnectingCard()
    } else if syncService.projects.isEmpty && hubProjectPresentations.isEmpty {
      HubEmptyProjectsCard()
    } else if filteredHubProjectPresentations.isEmpty {
      HubRosterFilterEmptyState(filter: effectiveRosterFilter)
    } else {
      LazyVGrid(columns: HubProjectGridMetrics.columns, spacing: HubProjectGridMetrics.spacing) {
      ForEach(filteredHubProjectPresentations) { presentation in
        let project = presentation.project
        HubProjectTile(
          presentation: presentation,
          machineLabel: hubMachineLabel(for: project),
          machineCount: hubMachineCount(for: project),
          canChangeIcon: hubCanChangeIcon(for: project),
          canMoveToTop: projectOrder.first != project.id,
          onOpenProject: { openHubProject(project) },
          onChangeIcon: { png in changeHubProjectIcon(project, png: png) },
          onMoveToTop: { moveProjectToTop(project.id) },
          onForget: {
            // A project that lives only on another machine is forgotten there.
            guard fleetMerge.projectOwners[project.id] == nil else { return }
            syncService.forgetProject(project)
          }
        )
        .equatable()
        .draggable(project.id)
        .dropDestination(for: String.self) { items, _ in
          guard let draggedId = items.first else { return false }
          moveProject(draggedId, onto: project.id)
          return true
        }
        // While one project is switching in, the tapped row shows its own
        // spinner and every other row is disabled + dimmed so the catalog
        // stays visible but non-interactive (M12).
        .disabled(syncService.isProjectSwitching && !presentation.isSwitching)
        .opacity(syncService.isProjectSwitching && !presentation.isSwitching ? 0.55 : 1)
      }
      }
    }
  }

  // MARK: Other machines, folded in

  private func openHubProject(_ project: MobileProjectSummary) {
    guard let owner = fleetMerge.projectOwners[project.id] else {
      syncService.selectProject(project)
      return
    }
    // Lives only on another machine: focus that machine, then open it there.
    switchingRemoteProjectId = project.id
    Task { @MainActor in
      await syncService.openProject(owner.project, onMachine: owner.machineKey)
      if switchingRemoteProjectId == project.id { switchingRemoteProjectId = nil }
    }
  }

  private func openHubChat(_ chat: RemoteRosterChat, lane: RemoteRosterLane?, project: MobileProjectSummary) {
    guard let owner = fleetMerge.chatOwners[chat.id] else {
      openChatTarget = HubChatTarget(project: project, lane: lane, chat: chat)
      return
    }
    // The chat's own lane id on its machine, not the Hub's namespaced one.
    var ownChat = chat
    if let ownLane = owner.lane { ownChat.laneId = ownLane.id }
    let state = machineFleet.machine(for: owner.machineKey)?.state
    if state == .live || state == .connecting {
      openChatTarget = HubChatTarget(project: owner.project, lane: owner.lane, chat: ownChat, machineKey: owner.machineKey)
      return
    }
    // No live roster connection to that machine (paused, offline, or an older
    // ADE there): focus the machine, then open the chat the ordinary way.
    Task { @MainActor in
      guard await syncService.switchFocus(toMachineKey: owner.machineKey) else { return }
      openChatTarget = HubChatTarget(project: owner.project, lane: owner.lane, chat: ownChat)
    }
  }

  // MARK: Project card actions

  /// Every other machine that has this project, with its own id and root.
  private func hubProjectLocations(_ project: MobileProjectSummary) -> [HubRemoteOwner] {
    fleetMerge.projectLocations[project.id] ?? []
  }

  /// The card's machine chip: one machine's name, or "N machines". Nil while
  /// the phone knows a single machine, where it would only repeat itself.
  private func hubMachineLabel(for project: MobileProjectSummary) -> String? {
    guard machineFleet.machines.contains(where: \.isPinned) else { return nil }
    let others = hubProjectLocations(project)
    let onFocused = fleetMerge.projectOwners[project.id] == nil
    let count = others.count + (onFocused ? 1 : 0)
    if count > 1 { return "\(count) machines" }
    if onFocused { return syncService.focusedMachineDisplayName }
    guard let key = others.first?.machineKey else { return nil }
    return machineFleet.machine(for: key)?.name ?? "Another machine"
  }

  private func hubMachineCount(for project: MobileProjectSummary) -> Int {
    hubProjectLocations(project).count + (fleetMerge.projectOwners[project.id] == nil ? 1 : 0)
  }

  /// Change icon… shows when a machine the project is on can store one.
  private func hubCanChangeIcon(for project: MobileProjectSummary) -> Bool {
    if fleetMerge.projectOwners[project.id] == nil, syncService.supportsProjectIcon { return true }
    return hubProjectLocations(project).contains { location in
      machineFleet.connection(for: location.machineKey)?.supportsProjectIcon == true
    }
  }

  /// Sends a picked icon to every machine the project is on, each with its
  /// own project id and root (a project on several machines shows the same
  /// icon on all of them). A machine that is offline or too old is named in
  /// the toast; the others still change.
  private func changeHubProjectIcon(_ project: MobileProjectSummary, png: Data) {
    let onFocused = fleetMerge.projectOwners[project.id] == nil
    let locations = hubProjectLocations(project)
    Task { @MainActor in
      var failures: [String] = []
      if onFocused {
        do {
          try await syncService.setProjectIcon(project, png: png)
        } catch {
          failures.append("\(syncService.focusedMachineDisplayName): \(error.localizedDescription)")
        }
      }
      for location in locations {
        let name = machineFleet.machine(for: location.machineKey)?.name ?? "Another machine"
        guard let connection = machineFleet.connection(for: location.machineKey),
              connection.isLive, connection.supportsProjectIcon else {
          failures.append("\(name): can’t reach it, or its ADE is too old")
          continue
        }
        do {
          try await connection.setProjectIcon(
            projectId: location.project.id,
            rootPath: location.project.rootPath,
            png: png
          )
        } catch {
          failures.append("\(name): \(error.localizedDescription)")
        }
      }
      projectOpenFailureToast = failures.isEmpty
        ? ADEToastMessage(text: "Changed the icon for \(project.displayName).", kind: .info)
        : ADEToastMessage(text: "Couldn’t change the icon on \(failures.joined(separator: "; "))", kind: .failure)
    }
  }

  /// Move to top: the phone's own project order (desktop's "Pin to top"
  /// lives in its recents; the Hub's order is this phone's).
  private func moveProjectToTop(_ projectId: String) {
    var order = projectOrder.isEmpty ? hubProjects.map(\.id) : projectOrder
    order.removeAll { $0 == projectId }
    order.insert(projectId, at: 0)
    ADEHaptics.light()
    withAnimation(.easeInOut(duration: 0.22)) {
      projectOrder = order
      rebuildHubProjectPresentations()
    }
    persistHubLayout()
  }

  private var foreignLaunchRefreshActive: Bool {
    hubIsActive
      && canShowProjects
      && scenePhase == .active
      && !syncService.foreignChatLaunchRefreshScopes().isEmpty
  }

  /// Composite key that changes whenever the active project's local chat/lane
  /// data does, driving an `activeRoster` rebuild.
  private var rebuildKey: String? {
    guard hubIsActive else { return nil }
    return "\(syncService.activeProjectId ?? "-")|\(syncService.workProjectionRevision)|\(syncService.lanesProjectionRevision)"
  }

  private var workSessionDeepLinkKey: String? {
    // An outside tap (push, widget, Live Activity) is handled even while a chat
    // is open here, because it replaces that chat; an in-app request waits.
    guard syncService.shouldShowProjectHub,
          let request = syncService.requestedWorkSessionNavigation,
          openChatTarget == nil || request.origin == .external else { return nil }
    return [
      request.id,
      String(syncService.rosterRevision),
      rosterNavigationCatalogRevisionKey(syncService.projects),
      String(describing: syncService.connectionState),
    ].joined(separator: "|")
  }

  /// Display order: the user's persisted manual order first, with any project
  /// not yet placed falling back to alphabetical. Stable so viewing a project
  /// never reorders the hub.
  private var hubProjects: [MobileProjectSummary] {
    let projects = syncService.projects
    guard !projectOrder.isEmpty else {
      return projects.sorted {
        $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
      }
    }
    let rankById = Dictionary(uniqueKeysWithValues: projectOrder.enumerated().map { ($1, $0) })
    return projects.sorted { lhs, rhs in
      switch (rankById[lhs.id], rankById[rhs.id]) {
      case let (l?, r?): return l < r
      case (.some, .none): return true
      case (.none, .some): return false
      case (.none, .none):
        return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
      }
    }
  }

  private var hubRosterFilterCounts: [HubRosterFilter: Int] {
    Dictionary(uniqueKeysWithValues: HubRosterFilter.allCases.map { filter in
      (filter, hubRosterFilterCount(hubProjectPresentations, filter: filter))
    })
  }

  private var filteredHubProjectPresentations: [HubProjectPresentation] {
    hubProjectPresentations.compactMap { hubProjectPresentation($0, matching: effectiveRosterFilter) }
  }

  /// The filter the project list honours. On the inner display the status
  /// filters choose the agent list beside it, and the projects page always
  /// shows every project.
  private var effectiveRosterFilter: HubRosterFilter {
    duo.isWide ? .all : rosterFilter
  }

  private var hubPresentationKey: String? {
    guard hubIsActive else { return nil }
    let projectKey = syncService.projects.map { project in
      [
        project.id,
        project.displayName,
        project.rootPath ?? "",
        project.lastOpenedAt ?? "",
        String(project.laneCount),
        String(project.isOpen ?? false),
      ].joined(separator: ":")
    }.joined(separator: "|")
    return [
      projectKey,
      String(syncService.rosterRevision),
      String(syncService.chatLaunchRevision),
      syncService.activeProjectId ?? "",
      String(syncService.isProjectSwitching),
    ].joined(separator: "#")
  }

  private var rosterRequestKey: String? {
    guard hubIsActive else { return nil }
    return [
      String(describing: syncService.connectionState),
      String(syncService.projects.count),
      syncService.projects.map(\.id).joined(separator: ",")
    ].joined(separator: "|")
  }

  /// Refresh badges when the Hub becomes visible on a compatible live host.
  /// The key intentionally excludes `personalChatsRevision`: the refresh
  /// mutates that revision, so including it would create a request loop.
  private var personalChatsRefreshKey: String? {
    guard hubIsActive,
          !personalChatsPresented,
          syncService.supportsPersonalChats,
          syncService.canInvokeRemoteAction("personalChats.list")
    else { return nil }
    // Keyed on the host, not on connection or hydration progress: a stable host
    // key avoids redundant refreshes while normal sync batches flow.
    return hubCollapseDefaultsConnectionKey ?? "machine"
  }

  /// Machine identity used to scope the persisted hub layout. Keyed on the host
  /// name (not the address) so a reconnect that drifts the port doesn't drop the
  /// user's saved order and expand/collapse state.
  private var hubCollapseDefaultsConnectionKey: String? {
    guard canShowProjects else { return nil }
    let host = (syncService.hostName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let key = host.isEmpty ? (syncService.currentAddress ?? "") : host
    return key.isEmpty ? nil : key
  }

  /// Prefer the machine-wide roster for shape (all lanes/chats). For the active
  /// project, merge in the phone's local cache as a live overlay instead of
  /// replacing the roster; otherwise opening Versic collapses it to whichever
  /// small subset has hydrated locally and makes ADE's rows appear to vanish.
  private func rosterEntry(for project: MobileProjectSummary) -> RemoteRosterProject? {
    // Chats still being launched into a new lane show under that lane before
    // the roster (or the lane) knows about them.
    hubRosterOverlayingChatLaunches(
      baseRosterEntry(for: project),
      project: project,
      launches: syncService.chatLaunches(for: project)
    )
  }

  private func baseRosterEntry(for project: MobileProjectSummary) -> RemoteRosterProject? {
    let remoteRoster = syncService.rosterProject(for: project)
    guard syncService.isActiveProject(project),
          activeRosterProjectId == project.id,
          let activeRoster
    else {
      return remoteRoster
    }
    guard let remoteRoster else {
      return activeRoster
    }
    return mergedHubRoster(remote: remoteRoster, local: activeRoster)
  }

  private func rebuildHubProjectPresentations() {
    let focusedProjects = hubProjects
    let focusedRosters = focusedProjects.map { (project: $0, roster: rosterEntry(for: $0)) }
    // Only machines the user keeps connected: a disconnected machine's last
    // roster would keep its projects on the hub (and hide the no-machine state).
    let merge = hubMergeFleetRosters(focused: focusedRosters, machines: machineFleet.machines.filter(\.isPinned))
    if merge != fleetMerge { fleetMerge = merge }
    var nextPresentations = focusedRosters.map { entry in
      buildHubProjectPresentation(
        project: entry.project,
        roster: merge.mergedRosters[entry.project.id] ?? entry.roster,
        isActive: syncService.isActiveProject(entry.project),
        isSwitching: syncService.isSwitchingProject(entry.project)
      )
    }
    // Projects that live only on other machines, in the saved order when the
    // user placed them, else by name after the focused machine's.
    let rankById = Dictionary(projectOrder.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
    let extras = merge.extraProjects.sorted { lhs, rhs in
      switch (rankById[lhs.summary.id], rankById[rhs.summary.id]) {
      case let (l?, r?): return l < r
      case (.some, .none): return true
      case (.none, .some): return false
      case (.none, .none):
        return lhs.summary.displayName.localizedCaseInsensitiveCompare(rhs.summary.displayName) == .orderedAscending
      }
    }
    nextPresentations += extras.map { extra in
      buildHubProjectPresentation(
        project: extra.summary,
        roster: extra.roster,
        isActive: false,
        isSwitching: switchingRemoteProjectId == extra.summary.id
      )
    }
    if nextPresentations != hubProjectPresentations {
      hubProjectPresentations = nextPresentations
    }
    placeNewProjects(nextPresentations)
  }

  private func loadHubLayoutForConnection(_ connectionKey: String?) {
    guard let connectionKey else {
      layoutConnectionKey = nil
      return
    }
    guard layoutConnectionKey != connectionKey else { return }
    layoutConnectionKey = connectionKey
    // Restore the last-known order for this machine, then place any project
    // we've never seen.
    projectOrder = HubLayoutStore.load(connectionKey).order
    placeNewProjects(hubProjectPresentations)
  }

  private func placeNewProjects(_ presentations: [HubProjectPresentation]) {
    guard layoutConnectionKey != nil else { return }
    // Append any newly-seen project to the manual order (alphabetically among the
    // newcomers). Never drop ids: a transient disconnect can briefly empty the
    // roster, and we must not lose the user's saved order over a blip.
    let orderedIds = Set(projectOrder)
    let newProjectIds = presentations
      .map { $0.project }
      .filter { !orderedIds.contains($0.id) }
      .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
      .map(\.id)
    guard !newProjectIds.isEmpty else { return }
    projectOrder.append(contentsOf: newProjectIds)
    persistHubLayout()
  }

  private func persistHubLayout() {
    guard let connectionKey = layoutConnectionKey else { return }
    HubLayoutStore.save(HubLayoutState(order: projectOrder), for: connectionKey)
  }

  /// Drag-reorder: drop `draggedId` onto `targetId`, moving it into that slot.
  /// Purely local — desktop ordering is untouched.
  private func moveProject(_ draggedId: String, onto targetId: String) {
    guard draggedId != targetId else { return }
    var order = projectOrder.isEmpty ? hubProjects.map(\.id) : projectOrder
    guard let from = order.firstIndex(of: draggedId) else { return }
    order.remove(at: from)
    let insertAt = order.firstIndex(of: targetId) ?? order.count
    order.insert(draggedId, at: insertAt)
    ADEHaptics.light()
    withAnimation(.easeInOut(duration: 0.22)) {
      projectOrder = order
      rebuildHubProjectPresentations()
    }
    persistHubLayout()
  }

  private func mergedHubRoster(remote: RemoteRosterProject, local: RemoteRosterProject) -> RemoteRosterProject {
    var merged = remote

    var laneIds = Set(merged.lanes.map(\.id))
    for lane in local.lanes where laneIds.insert(lane.id).inserted {
      merged.lanes.append(lane)
    }

    var chatIndexById = Dictionary(uniqueKeysWithValues: merged.chats.enumerated().map { ($0.element.id, $0.offset) })
    for localChat in local.chats {
      if let index = chatIndexById[localChat.id] {
        merged.chats[index] = merged.chats[index].merging(local: localChat)
      } else {
        chatIndexById[localChat.id] = merged.chats.count
        merged.chats.append(localChat)
      }
    }

    merged.booted = remote.booted || local.booted
    merged.runningCount = merged.chats.filter(\.countsTowardRunning).count
    merged.attentionCount = merged.chats.filter(\.needsAttention).count
    merged.chats.sort { ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
    return merged.excludingIdentityChats()
  }
}

/// The Hub on the phone, the Duo's outer display and every other iPhone: the
/// header row, the roster filter row, the project list, and the composer under
/// it as the screen's footer (the list ends above it), at the screen's bottom
/// the way a bottom bar sits.
struct HubPhoneLayout<Title: View, FilterBar: View, Roster: View, Composer: View>: View {
  @Binding var composerExpanded: Bool
  let actions: HubToolbarActions
  @ViewBuilder var title: () -> Title
  @ViewBuilder var filterBar: () -> FilterBar
  @ViewBuilder var roster: () -> Roster
  @ViewBuilder var composer: () -> Composer
  /// Where the status bar leaves an empty band beside the clock
  /// (`hubStatusBandLeadingWidth`): the band's width and height. The header
  /// moves up into it and everything under it gains the row's height.
  @State private var statusBand: CGSize?

  var body: some View {
    VStack(spacing: 0) {
      header
      filterBar()
      roster()
        .frame(maxHeight: .infinity)
        // The list ends at the composer's top, never behind it.
        .clipped()
        // While the composer is expanded, a dim scrim covers the list: it
        // swallows taps and drags (no accidental row opens), and any touch on
        // it collapses the composer.
        .overlay {
          if composerExpanded {
            Color.black.opacity(0.38)
              .ignoresSafeArea()
              .onTapGesture { collapse() }
              .gesture(
                DragGesture(minimumDistance: 12).onEnded { value in
                  if value.translation.height > 24 { collapse() }
                }
              )
              .transition(.opacity)
          }
        }
      HubComposerClearsCorner(content: composer)
    }
    .hubComposerAtScreenBottom()
    .onGeometryChange(for: CGSize?.self) { proxy in
      hubStatusBandLeadingWidth(proxy).map { CGSize(width: $0, height: proxy.safeAreaInsets.top) }
    } action: { band in
      if band != statusBand { statusBand = band }
    }
    .navigationBarTitleDisplayMode(.inline)
    // The header is a row of its own (under the status bar, the full width),
    // the same row every other form of the Hub shows.
    .toolbar(.hidden, for: .navigationBar)
  }

  @ViewBuilder
  private var header: some View {
    if let statusBand {
      // In the band beside the clock, level with it, ending short of it.
      HubHeaderRow(actions: actions, title: title)
        .environment(\.hubHeaderInline, true)
        .padding(.leading, 16)
        .frame(width: max(0, statusBand.width - 8), alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: statusBand.height, alignment: .center)
        .padding(.top, 6)
        .padding(.top, -statusBand.height)
        .padding(.bottom, 8)
    } else {
      HubHeaderRow(actions: actions, title: title)
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
        .hubHeaderClearsStatusBar()
    }
  }

  private func collapse() {
    withAnimation(hubComposerSpring) { composerExpanded = false }
  }
}

/// Identifies a chat opened from the hub, carrying enough context to activate
/// the right project and render the chat over the hub.
struct HubChatTarget: Identifiable, Equatable {
  let id = UUID().uuidString
  let project: MobileProjectSummary
  let lane: RemoteRosterLane?
  let chat: RemoteRosterChat
  /// Set when the chat lives on another paired machine: it opens through that
  /// machine's roster connection and never activates the project.
  var machineKey: String? = nil
}

// MARK: - Persisted layout

/// The hub's per-machine layout: the user's manual project order. Persisted to
/// the App Group so opening a project and returning restores the hub exactly.
/// (Older saves also carry collapse keys from the list layout; decoding
/// ignores them.)
struct HubLayoutState: Codable, Equatable {
  var order: [String] = []
}

enum HubLayoutStore {
  private static func defaultsKey(_ connectionKey: String) -> String {
    "ade.hub.layout.v1|\(connectionKey)"
  }

  static func load(_ connectionKey: String) -> HubLayoutState {
    guard let data = ADESharedContainer.defaults.data(forKey: defaultsKey(connectionKey)),
          let state = try? JSONDecoder().decode(HubLayoutState.self, from: data)
    else { return HubLayoutState() }
    return state
  }

  static func save(_ state: HubLayoutState, for connectionKey: String) {
    guard let data = try? JSONEncoder().encode(state) else { return }
    ADESharedContainer.defaults.set(data, forKey: defaultsKey(connectionKey))
  }
}

/// While a chat opened from the hub is presented, keep the presenter mounted
/// but collapse its expensive roster/list tree. `fullScreenCover` keeps the
/// presenting hierarchy alive; leaving the whole hub underneath chat detail
/// makes roster updates diff both screens during streaming and scrolling.
private struct HubCoverParkingSurface: View {
  var body: some View {
    ADEColor.pageBackground
      .ignoresSafeArea()
      .accessibilityHidden(true)
  }
}
