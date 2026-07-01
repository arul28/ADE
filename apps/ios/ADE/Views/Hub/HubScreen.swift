import SwiftUI

// The all-projects hub — the mobile app's main surface once a machine is
// connected. Lists every project on the machine, each expandable to its chats
// grouped by lane (sourced from the live roster feed). Tapping a project card
// opens its detailed tabbed view; tapping a chat opens that chat directly
// (presented over the hub, so Back returns here). A bottom "type to vibecode"
// bar slides up a new-chat drawer with a Project ▸ Lane destination picker.
//
// Replaces the connected-state layout of the old `ProjectHomeView`; the
// no-machine / connecting states are preserved here.
struct HubScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var addProjectSheetPresented = false
  @State private var collapsedProjectIds: Set<String> = []
  @State private var collapsedLaneKeys: Set<String> = []
  @State private var collapsedDefaultsConnectionKey: String?
  @State private var collapsedDefaultsSeededProjectIds: Set<String> = []
  @State private var collapsedDefaultsSeededLaneKeys: Set<String> = []
  // User's manual project order (drag-to-reorder). Persisted per machine so the
  // hub looks identical after opening a project and coming back — mobile-only,
  // never touches desktop ordering.
  @State private var projectOrder: [String] = []
  @State private var composerPresented = false
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
  @State private var hubProjectPresentations: [HubProjectPresentation] = []

  private var isNoMachineBlankState: Bool {
    syncService.connectionState == .disconnected || syncService.connectionState == .error
  }

  private var canShowProjects: Bool {
    syncService.connectionState == .connected || syncService.connectionState == .syncing
  }

  private var hubIsActive: Bool {
    syncService.shouldShowProjectHome && openChatTarget == nil && !composerPresented
  }

  var body: some View {
    ZStack(alignment: .top) {
      HubBackground()
      if openChatTarget != nil {
        HubCoverParkingSurface()
      } else if isNoMachineBlankState {
        HubNoMachineState()
      } else {
        connectedHub
      }
    }
    .sheet(isPresented: $addProjectSheetPresented) {
      RemoteProjectAddSheet().environmentObject(syncService)
    }
    .hubChatCover(target: $openChatTarget)
    .hubComposerDrawer(isPresented: $composerPresented, onCreated: handleCreated)
    .overlay(alignment: .bottom) {
      if let toast = createdToast {
        HubCreatedToast(toast: toast, onOpen: { openCreated(toast) }, onDismiss: { dismissToast() })
          .padding(.horizontal, 16)
          .padding(.bottom, 78)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(.spring(response: 0.35, dampingFraction: 0.85), value: createdToast)
    .task(id: hubCollapseDefaultsConnectionKey) {
      loadHubLayoutForConnection(hubCollapseDefaultsConnectionKey)
    }
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

  private func openCreated(_ created: HubCreatedChat) {
    dismissToast()
    guard let project = syncService.projects.first(where: { $0.id == created.projectId }) else { return }
    let chat = RemoteRosterChat(
      id: created.sessionId, laneId: "", chatSessionId: nil, title: nil, provider: nil, model: nil, toolType: nil,
      status: .running, awaitingInput: nil, pinned: nil, archived: nil, lastActivityAt: nil, preview: nil
    )
    openChatTarget = HubChatTarget(project: project, lane: nil, chat: chat)
  }

  private var connectedHub: some View {
    VStack(spacing: 0) {
      HubTopBar(onAdd: { addProjectSheetPresented = true })
      ScrollView {
        LazyVStack(spacing: 12) {
          if !canShowProjects {
            HubConnectingCard()
          } else if syncService.projects.isEmpty {
            HubEmptyProjectsCard()
          } else {
            ForEach(hubProjectPresentations) { presentation in
              let project = presentation.project
              HubProjectCard(
                presentation: presentation,
                isCollapsed: collapsedProjectIds.contains(project.id),
                collapsedLaneKeysSnapshot: collapsedLaneKeys,
                collapsedLaneKeys: $collapsedLaneKeys,
                onToggleCollapse: { withAnimation(.easeOut(duration: 0.16)) { toggle(&collapsedProjectIds, project.id) } },
                onOpenProject: { syncService.selectProject(project) },
                onOpenChat: { chat, lane in
                  openChatTarget = HubChatTarget(project: project, lane: lane, chat: chat)
                },
                onArchiveChat: { chat in runRosterChatAction("chat.archive", chat: chat, project: project) },
                onDeleteChat: { chat in runRosterChatAction("chat.delete", chat: chat, project: project) },
                onForget: { syncService.forgetProject(project) }
              )
              .equatable()
              .draggable(project.id)
              .dropDestination(for: String.self) { items, _ in
                guard let draggedId = items.first else { return false }
                moveProject(draggedId, onto: project.id)
                return true
              }
            }
          }
        }
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 16)
      }
      .scrollIndicators(.hidden)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(spacing: 0) {
          LinearGradient(
            colors: [
              ADEColor.pageBackground.opacity(0),
              ADEColor.pageBackground.opacity(0.96)
            ],
            startPoint: .top,
            endPoint: .bottom
          )
          .frame(height: 14)
          .allowsHitTesting(false)

          HubComposerBar { composerPresented = true }
        }
        .background(
          ADEColor.pageBackground
            .opacity(0.96)
            .ignoresSafeArea(edges: .bottom)
        )
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    // Rebuild the active project's local roster whenever its sessions/lanes
    // change or the active project switches.
    .task(id: rebuildKey) {
      guard rebuildKey != nil else { return }
      activeRoster = syncService.buildActiveProjectLocalRoster()
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
    // Persist the user's expand/collapse choices as they change so the hub
    // restores identically after opening a project and returning.
    .onChange(of: collapsedProjectIds) { _, _ in persistHubLayout() }
    .onChange(of: collapsedLaneKeys) { _, _ in persistHubLayout() }
  }

  /// Composite key that changes whenever the active project's local chat/lane
  /// data does, driving an `activeRoster` rebuild.
  private var rebuildKey: String? {
    guard hubIsActive else { return nil }
    return "\(syncService.activeProjectId ?? "-")|\(syncService.workProjectionRevision)|\(syncService.lanesProjectionRevision)"
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
    let remoteRoster = syncService.rosterProject(for: project)
    guard syncService.isActiveProject(project), let activeRoster else {
      return remoteRoster
    }
    guard let remoteRoster else {
      return activeRoster
    }
    return mergedHubRoster(remote: remoteRoster, local: activeRoster)
  }

  private func rebuildHubProjectPresentations() {
    let nextPresentations = hubProjects.map { project in
      buildHubProjectPresentation(
        project: project,
        roster: rosterEntry(for: project),
        isActive: syncService.isActiveProject(project),
        isSwitching: syncService.isSwitchingProject(project)
      )
    }
    if nextPresentations != hubProjectPresentations {
      hubProjectPresentations = nextPresentations
    }
    seedCollapsedHubDefaults(for: nextPresentations)
  }

  private func loadHubLayoutForConnection(_ connectionKey: String?) {
    guard let connectionKey else {
      collapsedDefaultsConnectionKey = nil
      return
    }
    guard collapsedDefaultsConnectionKey != connectionKey else { return }
    collapsedDefaultsConnectionKey = connectionKey

    // Restore the last-known layout for this machine, then seed defaults for any
    // project/lane we've never placed before.
    let saved = HubLayoutStore.load(connectionKey)
    projectOrder = saved.order
    collapsedProjectIds = Set(saved.collapsedProjects)
    collapsedLaneKeys = Set(saved.collapsedLanes)
    collapsedDefaultsSeededProjectIds = Set(saved.seededProjects)
    collapsedDefaultsSeededLaneKeys = Set(saved.seededLanes)
    seedCollapsedHubDefaults(for: hubProjectPresentations)
  }

  private func seedCollapsedHubDefaults(for presentations: [HubProjectPresentation]) {
    guard collapsedDefaultsConnectionKey != nil else { return }
    var changed = false

    // Append any newly-seen project to the manual order (alphabetically among the
    // newcomers). Never drop ids: a transient disconnect can briefly empty the
    // roster, and we must not lose the user's saved order over a blip.
    let orderedIds = Set(projectOrder)
    let newProjectIds = presentations
      .map { $0.project }
      .filter { !orderedIds.contains($0.id) }
      .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
      .map(\.id)
    if !newProjectIds.isEmpty {
      projectOrder.append(contentsOf: newProjectIds)
      changed = true
    }

    let projectIds = Set(presentations.map { $0.project.id })
    let unseededProjectIds = projectIds.subtracting(collapsedDefaultsSeededProjectIds)
    if !unseededProjectIds.isEmpty {
      collapsedProjectIds.formUnion(unseededProjectIds)
      collapsedDefaultsSeededProjectIds.formUnion(unseededProjectIds)
      changed = true
    }

    let laneKeys = Set(presentations.flatMap { presentation in
      presentation.lanes.map { hubLaneKey(project: presentation.project, lane: $0.lane) }
    })
    let unseededLaneKeys = laneKeys.subtracting(collapsedDefaultsSeededLaneKeys)
    if !unseededLaneKeys.isEmpty {
      collapsedLaneKeys.formUnion(unseededLaneKeys)
      collapsedDefaultsSeededLaneKeys.formUnion(unseededLaneKeys)
      changed = true
    }

    if changed { persistHubLayout() }
  }

  private func persistHubLayout() {
    guard let connectionKey = collapsedDefaultsConnectionKey else { return }
    let state = HubLayoutState(
      order: projectOrder,
      collapsedProjects: Array(collapsedProjectIds),
      collapsedLanes: Array(collapsedLaneKeys),
      seededProjects: Array(collapsedDefaultsSeededProjectIds),
      seededLanes: Array(collapsedDefaultsSeededLaneKeys)
    )
    HubLayoutStore.save(state, for: connectionKey)
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

  private func hubLaneKey(project: MobileProjectSummary, lane: RemoteRosterLane) -> String {
    "\(project.id)/\(lane.id)"
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
        merged.chats[index] = mergedHubChat(remote: merged.chats[index], local: localChat)
      } else {
        chatIndexById[localChat.id] = merged.chats.count
        merged.chats.append(localChat)
      }
    }

    merged.booted = remote.booted || local.booted
    merged.runningCount = merged.chats.filter(\.isRunning).count
    merged.attentionCount = merged.chats.filter(\.needsAttention).count
    merged.chats.sort { ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
    return merged
  }

  private func mergedHubChat(remote: RemoteRosterChat, local: RemoteRosterChat) -> RemoteRosterChat {
    var merged = remote
    let localIsAtLeastAsFresh = (local.lastActivityAt ?? "") >= (remote.lastActivityAt ?? "")

    if localIsAtLeastAsFresh {
      merged.status = local.status
      merged.awaitingInput = local.awaitingInput ?? remote.awaitingInput
      merged.pinned = local.pinned ?? remote.pinned
      merged.archived = local.archived ?? remote.archived
      merged.lastActivityAt = nonEmpty(local.lastActivityAt) ?? remote.lastActivityAt
      merged.title = nonEmpty(local.title) ?? remote.title
      merged.preview = nonEmpty(local.preview) ?? remote.preview
    }

    merged.provider = nonEmpty(remote.provider) ?? local.provider
    merged.model = nonEmpty(remote.model) ?? local.model
    merged.toolType = nonEmpty(remote.toolType) ?? local.toolType
    merged.chatSessionId = nonEmpty(remote.chatSessionId) ?? local.chatSessionId
    return merged
  }

  private func nonEmpty(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
    return value
  }

  private func toggle(_ set: inout Set<String>, _ id: String) {
    if set.contains(id) { set.remove(id) } else { set.insert(id) }
  }

  private func runRosterChatAction(_ action: String, chat: RemoteRosterChat, project: MobileProjectSummary) {
    Task { @MainActor in
      try? await syncService.performRosterChatAction(action, sessionId: chat.id, project: project)
    }
  }
}

/// Identifies a chat opened from the hub, carrying enough context to activate
/// the right project and render the chat over the hub.
struct HubChatTarget: Identifiable, Equatable {
  let id = UUID().uuidString
  let project: MobileProjectSummary
  let lane: RemoteRosterLane?
  let chat: RemoteRosterChat
}

// MARK: - Persisted layout

/// The hub's per-machine layout: the user's manual project order plus which
/// projects/lanes are collapsed. Persisted to the App Group so opening a project
/// and returning restores the hub exactly. `seeded*` records which ids have
/// already received a default so newly-appearing ones start collapsed while
/// previously-expanded ones stay expanded.
struct HubLayoutState: Codable, Equatable {
  var order: [String] = []
  var collapsedProjects: [String] = []
  var collapsedLanes: [String] = []
  var seededProjects: [String] = []
  var seededLanes: [String] = []
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

// MARK: - Background

private struct HubBackground: View {
  var body: some View {
    ZStack {
      ADEColor.pageBackground
      RadialGradient(
        colors: [
          ADEColor.purpleAccent.opacity(0.20),
          ADEColor.purpleAccent.opacity(0.06),
          Color.clear,
        ],
        center: .top,
        startRadius: 10,
        endRadius: 360
      )
      .frame(height: 420)
      .frame(maxHeight: .infinity, alignment: .top)
      .blur(radius: 8)
      .allowsHitTesting(false)
    }
    .ignoresSafeArea()
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
