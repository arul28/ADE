import SwiftUI
import UIKit

struct PRsTabView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var machineFleet: MachineFleet
  /// PR ↔ lane links and lanes of the other machines holding this repository.
  @StateObject private var remotePrs = PrRemoteMachinesModel()
  var isActive = true

  @State private var path = NavigationPath()
  @State private var prs: [PullRequestListItem] = []
  @State private var lanes: [LaneSummary] = []
  @State private var laneSnapshots: [LaneListSnapshot] = []
  @State private var integrationProposals: [IntegrationProposal] = []
  @State private var mobileSnapshot: PrMobileSnapshot?
  @State private var githubSnapshot: GitHubPrSnapshot?
  @State private var githubExternalHistoryLoaded = false
  @State private var githubHistoryPageLimit = 2
  // Set synchronously on the @MainActor before any awaited fetch so concurrent
  // callers (the `onChange` filter handler and the projection-reload `task`)
  // do not both pass the `!githubExternalHistoryLoaded` guard and issue
  // duplicate `fetchGitHubPullRequestSnapshot(includeExternalClosed: true)`
  // requests.
  @State private var isLoadingExternalHistory = false
  @State private var errorMessage: String?
  @State private var createPresented = false
  @State private var createInitialLaneId: String?
  @State private var stackPresentation: PrStackPresentation?
  @State private var refreshFeedbackToken = 0
  @State private var lastPrsLocalProjectionReload = Date.distantPast
  @State private var lastHandledPrsProjectionRevision: Int?
  @State private var lastPrsLiveSnapshotAttempt = Date.distantPast
  @State private var laneContextLaneId: String?
  @State private var prDetailRouteScopes: [String: PrDetailRouteScope] = [:]
  @State private var prDetailInitialTabs: [String: PrDetailTab] = [:]
  /// Memoized GitHub-list derivations (filter/sort/counts). Recomputed only
  /// when the snapshot or a filter input changes — see `recomputeGitHubDerived`
  /// — instead of on every `body` pass.
  @State private var githubDerived: PrGitHubDerivedList = .empty
  @State private var laneLinkRequest: PrGitHubLaneLinkRequest?
  @State private var autoMapRequest: PrAutoMapRequest?
  @SceneStorage("ade.prs.rootSurface") private var rootSurfaceRawValue = PrRootSurface.github.rawValue
  @SceneStorage("ade.prs.workflowFilter") private var workflowFilterRawValue = PrWorkflowKindFilter.all.rawValue
  /// Primary headline selector for the GitHub surface (desktop parity): three
  /// status categories — Open (folds draft), Merged, Closed.
  @SceneStorage("ade.prs.githubCategory") private var githubCategoryRawValue = PrGitHubCategory.open.rawValue
  @SceneStorage("ade.prs.githubScopeFilter") private var githubScopeFilterRawValue = PrGitHubScopeFilter.all.rawValue
  @SceneStorage("ade.prs.githubSort") private var githubSortRawValue = PrGitHubSortOption.updated.rawValue
  @State private var searchText = ""
  @State private var searchPresented = false
  @State private var toast: ADEToastMessage?

  private var hasActiveFilters: Bool {
    // Status is now driven by the always-visible category tabs, so only the
    // secondary scope + sort controls count as "active advanced filters".
    selectedGitHubScopeFilter.wrappedValue != .all
      || selectedGitHubSort.wrappedValue != .updated
  }

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && syncService.connectionState == .connected && syncService.projectHostIsLive
  }

  private var isLoadingSkeleton: Bool {
    prsStatus.phase == .hydrating || prsStatus.phase == .syncingInitialData
  }

  private var selectedRootSurface: Binding<PrRootSurface> {
    Binding(
      get: { PrRootSurface(rawValue: rootSurfaceRawValue) ?? .github },
      set: { rootSurfaceRawValue = $0.rawValue }
    )
  }

  private var selectedWorkflowFilter: Binding<PrWorkflowKindFilter> {
    Binding(
      get: { PrWorkflowKindFilter(rawValue: workflowFilterRawValue) ?? .all },
      set: { workflowFilterRawValue = $0.rawValue }
    )
  }

  /// Primary three-way category selector (Open / Merged / Closed). Folds draft
  /// into Open. Drives both the headline tabs and the list derivation.
  private var selectedGitHubCategory: Binding<PrGitHubCategory> {
    Binding(
      get: { PrGitHubCategory(rawValue: githubCategoryRawValue) ?? .open },
      set: { githubCategoryRawValue = $0.rawValue }
    )
  }

  private var selectedGitHubScopeFilter: Binding<PrGitHubScopeFilter> {
    Binding(
      get: { PrGitHubScopeFilter(rawValue: githubScopeFilterRawValue) ?? .all },
      set: { githubScopeFilterRawValue = $0.rawValue }
    )
  }

  private var selectedGitHubSort: Binding<PrGitHubSortOption> {
    Binding(
      get: { PrGitHubSortOption(rawValue: githubSortRawValue) ?? .updated },
      set: { githubSortRawValue = $0.rawValue }
    )
  }

  /// Total repo-scoped GitHub PR count (pre-filter). Cheap pass-through; the
  /// expensive derivations are memoized in `githubDerived`.
  private var allGitHubPrsCount: Int {
    let counts = githubCategoryCounts
    return counts.open + counts.merged + counts.closed
  }

  private var githubSnapshotNeedsExternalHistory: Bool {
    selectedGitHubCategory.wrappedValue != .open
  }

  private var githubSnapshotShouldIncludeExternalClosed: Bool {
    githubExternalHistoryLoaded || githubSnapshotNeedsExternalHistory
  }

  /// Memoized filtered + sorted GitHub PR list (see `githubDerived`).
  private var filteredGitHubPrs: [GitHubPrListItem] {
    githubDerived.filtered
  }

  private var githubFilterCounts: PrGitHubFilterCounts {
    githubDerived.counts
  }

  /// Recompute the memoized GitHub-list derivations. Called from `.onChange`
  /// of the snapshot + every filter/search input, so a `body` pass never pays
  /// the filter/sort/count cost.
  private func recomputeGitHubDerived() {
    let next = prComputeGitHubDerivedList(
      // Rows the focused machine does not link take the lane another machine
      // holds for them.
      items: prApplyRemoteLaneLinks(
        prReconcileGitHubPullRequests(
          snapshotItems: repoScopedGitHubPullRequests(from: githubSnapshot),
          mappedPrs: prs
        ),
        links: remotePrs.links
      ),
      query: searchText,
      status: .all,
      scope: selectedGitHubScopeFilter.wrappedValue,
      sort: selectedGitHubSort.wrappedValue,
      category: selectedGitHubCategory.wrappedValue
    )
    if githubDerived != next {
      githubDerived = next
    }
  }

  /// Stable registry key for root-level workflow actions (integration /
  /// create / link). These share one in-flight banner, so one key is correct.
  private static let rootActionKey = "prs.root"

  /// Label of the in-flight root action, if any. Read from the durable service
  /// registry so the banner survives a tab switch + remount.
  private var rootActionInFlightLabel: String? {
    syncService.prActionLabel(forKey: Self.rootActionKey)
  }

  private var isRootActionInFlight: Bool {
    rootActionInFlightLabel != nil
  }

  private var canLinkGitHubPullRequests: Bool {
    isLive && !isRootActionInFlight && syncService.supportsRemoteAction("prs.linkToLane")
  }

  /// Gate for the auto-map ("Create lane from PR branch") affordance. Mirrors
  /// the link gate but on the auto-map remote action so older hosts that don't
  /// expose it simply hide the button (no crash) and keep the link flow.
  private var canAutoMapGitHubPullRequests: Bool {
    isLive && !isRootActionInFlight && syncService.supportsRemoteAction("prs.createLaneFromPrBranch")
  }

  /// Per-category counts for the three headline tabs, scoped by the active
  /// scope filter (ADE / External / All). Host history counts are a cheap
  /// projection floor; never let them undercount rows already visible on the
  /// phone after local reconciliation.
  private var githubCategoryCounts: PrGitHubCategoryCounts {
    if selectedGitHubScopeFilter.wrappedValue == .all,
      let counts = githubSnapshot?.history?.repoPullRequestCounts
    {
      return PrGitHubCategoryCounts(
        open: max(counts.open, githubDerived.categoryCounts.open),
        merged: max(counts.merged, githubDerived.categoryCounts.merged),
        closed: max(counts.closed, githubDerived.categoryCounts.closed)
      )
    }
    return githubDerived.categoryCounts
  }

  /// Prefer the unified `PrMobileSnapshot.workflowCards` payload when available; fall back to the
  /// legacy per-kind fetches (integrationProposals / laneSnapshots-derived rebase)
  /// so offline cached state still renders if the mobile snapshot fetch failed.
  private var workflowCards: [PrWorkflowCard] {
    if let mobileSnapshot {
      return mobileSnapshot.workflowCards.filter {
        $0.kind == "integration" || $0.kind == "rebase"
      }
    }
    return legacyWorkflowCards
  }

  private var legacyWorkflowCards: [PrWorkflowCard] {
    var cards: [PrWorkflowCard] = []

    for proposal in integrationProposals {
      cards.append(legacyIntegrationCard(from: proposal))
    }
    for item in rebaseWorkflowItems {
      cards.append(legacyRebaseCard(from: item))
    }

    return cards
  }

  private var rebaseWorkflowItems: [PrRebaseWorkflowItem] {
    laneSnapshots.compactMap { snapshot in
      guard let suggestion = snapshot.rebaseSuggestion, suggestion.dismissedAt == nil else { return nil }
      let severity: String
      if snapshot.autoRebaseStatus?.state == "rebaseConflict" {
        severity = "critical"
      } else if suggestion.behindCount >= 10 {
        severity = "warning"
      } else {
        severity = "info"
      }

      let message = snapshot.autoRebaseStatus?.message
        ?? "\(snapshot.lane.name) is \(suggestion.behindCount) commit\(suggestion.behindCount == 1 ? "" : "s") behind its parent lane."

      return PrRebaseWorkflowItem(
        laneId: snapshot.lane.id,
        laneName: snapshot.lane.name,
        branchRef: snapshot.lane.branchRef,
        behindCount: suggestion.behindCount,
        severity: severity,
        statusMessage: message,
        deferredUntil: suggestion.deferredUntil
      )
    }
    .sorted { lhs, rhs in
      if lhs.severity == rhs.severity {
        return lhs.behindCount > rhs.behindCount
      }
      return severityRank(lhs.severity) < severityRank(rhs.severity)
    }
  }

  private var canCreatePr: Bool {
    if let createCaps = mobileSnapshot?.createCapabilities {
      return createCaps.canCreateAny && canRunWorkflowActions
    }
    return canRunWorkflowActions && !lanes.isEmpty
  }

  private var canRunWorkflowActions: Bool {
    isLive && !isRootActionInFlight
  }

  private var prsProjectionReloadKey: Int? {
    isActive ? syncService.prsProjectionRevision : nil
  }

  private var prsRemoteReloadKey: Int? {
    isActive ? syncService.prsRemoteRevision : nil
  }

  private var prNavigationRequestKey: String? {
    guard isActive else { return nil }
    return syncService.requestedPrNavigation?.id
  }

  private var workflowKindCounts: [String: Int] {
    var counts: [String: Int] = [:]
    for card in workflowCards {
      counts[card.kind, default: 0] += 1
    }
    counts["all"] = workflowCards.count
    return counts
  }

  /// Re-read the other machines while the tab is visible, for the focused
  /// project, and again when a machine's live link comes or goes.
  private var remotePrsPollKey: String? {
    guard isActive, let projectId = syncService.activeProjectId else { return nil }
    let live = machineFleet.machines.filter { $0.state == .live }.map(\.machineKey).sorted()
    return "\(projectId)|\(live.joined(separator: ","))"
  }

  private var focusedMachineName: String {
    syncService.focusedMachineDisplayName
  }

  /// The machines of the focused repository: names for the lane chips, and
  /// where a lane made from a PR can go (this machine and every live one,
  /// least busy first).
  private var machineContext: PrMachineContext {
    let focusedRunning = syncService.activeProject
      .flatMap { syncService.rosterProject(for: $0) }?.runningCount ?? 0
    var createMachines = [PrLaneMachine(
      id: "",
      name: focusedMachineName,
      target: nil,
      runningCount: focusedRunning
    )]
    for machine in remotePrs.machines where machine.isLive {
      createMachines.append(PrLaneMachine(
        id: machine.machineKey,
        name: machine.name,
        target: LaneCreateTarget(projectId: machine.markedProjectId, rootPath: machine.rootPath),
        runningCount: machine.runningCount
      ))
    }
    createMachines = machineChoicesLeastBusyFirst(createMachines, runningCount: \.runningCount)
    return PrMachineContext(
      focusedName: focusedMachineName,
      remoteNames: Dictionary(
        remotePrs.machines.map { ($0.machineKey, $0.name) },
        uniquingKeysWith: { first, _ in first }
      ),
      createMachines: createMachines
    )
  }

  /// Lanes a PR can be linked to: this machine's and every live machine's
  /// (namespaced ids, so the link is made on the lane's machine).
  private var linkableLanes: [LaneSummary] {
    lanes + remotePrs.machines.flatMap(\.lanes)
  }

  /// The lane another machine holds for a detail route, by the PR's GitHub
  /// coordinates.
  private func remoteLaneLink(forRouteId routeId: String) -> PrRemoteLaneLink? {
    guard let coordinates = prGitHubCoordinates(fromRouteId: routeId) else { return nil }
    return remotePrs.link(
      repoOwner: coordinates.repoOwner,
      repoName: coordinates.repoName,
      githubPrNumber: coordinates.githubPrNumber
    )
  }

  private func refreshRemotePrs() async {
    await remotePrs.refresh(sync: syncService, fleet: machineFleet)
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        noticeRows
        if isLoadingSkeleton {
          Section {
            ForEach(0..<4, id: \.self) { _ in
              PrRowCardSkeleton().adeFlatRow()
            }
          }
        } else {
          switch selectedRootSurface.wrappedValue {
          case .github:
            githubSurfaceRows
          case .workflows:
            workflowsSurfaceRows
          }
        }
      }
      .adeFlatList()
      .contentMargins(.bottom, 24, for: .scrollContent)
      .searchable(
        text: $searchText,
        isPresented: $searchPresented,
        placement: .navigationBarDrawer(displayMode: .automatic),
        prompt: selectedRootSurface.wrappedValue == .github ? "Search PRs, branches, authors" : "Search workflows"
      )
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { prsToolbar }
      .adeToast($toast)
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task(id: prsProjectionReloadKey) {
        guard let revision = prsProjectionReloadKey else { return }
        guard lastHandledPrsProjectionRevision != revision || prs.isEmpty else { return }
        let now = Date()
        if !prs.isEmpty || githubSnapshot != nil || mobileSnapshot != nil {
          let elapsed = now.timeIntervalSince(lastPrsLocalProjectionReload)
          if elapsed < 0.35 {
            try? await Task.sleep(for: .milliseconds(max(1, Int((0.35 - elapsed) * 1_000))))
            guard !Task.isCancelled, prsProjectionReloadKey == revision else { return }
          }
        }
        lastPrsLocalProjectionReload = Date()
        await reload()
        guard !Task.isCancelled, prsProjectionReloadKey == revision else { return }
        lastHandledPrsProjectionRevision = revision
      }
      .task(id: prsRemoteReloadKey) {
        guard let revision = prsRemoteReloadKey, revision > 0 else { return }
        // Webhook bursts can contain several related deliveries. Coalesce them
        // into one bounded snapshot read instead of turning each event into a
        // GitHub request from the phone.
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled, prsRemoteReloadKey == revision else { return }
        await reloadGitHubProjection()
      }
      .task(id: prNavigationRequestKey) {
        guard prNavigationRequestKey != nil else { return }
        await handleRequestedPrNavigation()
      }
      .task(id: remotePrsPollKey) {
        guard remotePrsPollKey != nil else { return }
        while !Task.isCancelled {
          await refreshRemotePrs()
          try? await Task.sleep(nanoseconds: PrRemoteMachinesModel.refreshIntervalNanoseconds)
        }
      }
      .onChange(of: syncService.activeProjectId) { _, _ in
        remotePrs.reset()
      }
      .onChange(of: remotePrs.machines) { _, _ in recomputeGitHubDerived() }
      .onChange(of: githubCategoryRawValue) { _, _ in
        guard selectedGitHubCategory.wrappedValue != .open else { return }
        Task { await loadGitHubExternalHistoryIfNeeded() }
      }
      // Memoize the GitHub-list derivations: recompute only when the snapshot
      // or a filter/search input actually changes, never inside a body pass.
      .onChange(of: githubSnapshot) { _, _ in recomputeGitHubDerived() }
      .onChange(of: prs) { _, _ in recomputeGitHubDerived() }
      .onChange(of: searchText) { _, _ in recomputeGitHubDerived() }
      .onChange(of: githubCategoryRawValue) { _, _ in recomputeGitHubDerived() }
      .onChange(of: githubScopeFilterRawValue) { _, _ in recomputeGitHubDerived() }
      .onChange(of: githubSortRawValue) { _, _ in recomputeGitHubDerived() }
      .onAppear { recomputeGitHubDerived() }
      .refreshable {
        await refreshFromPullGesture()
      }
      // Root PR actions run at the service level (`runDurablePrAction`), so
      // switching tabs never aborts in-flight integration or link work.
      .navigationDestination(for: String.self) { prId in
        let routeScope = prDetailRouteScopes[prId]
        PrDetailView(
          prId: prId,
          transitionNamespace: nil,
          requestedRepoOwner: routeScope?.repoOwner,
          requestedRepoName: routeScope?.repoName,
          availableLanes: linkableLanes,
          initialTab: prDetailInitialTabs[prId] ?? .overview,
          remoteLaneLink: remoteLaneLink(forRouteId: prId),
          machineContext: machineContext,
          onRemoteLinksChanged: { await refreshRemotePrs() }
        )
        .environmentObject(syncService)
      }
      .sheet(isPresented: $createPresented, onDismiss: {
        createInitialLaneId = nil
      }) {
        createPrWizardSheet
      }
      .sheet(item: $stackPresentation) { presentation in
        PrStackSheet(groupId: presentation.id, groupName: presentation.groupName)
          .environmentObject(syncService)
      }
      .sheet(item: $laneLinkRequest) { request in
        PrLaneLinkSheet(
          item: request.item,
          lanes: linkableLanes,
          canLink: canLinkGitHubPullRequests,
          machineContext: machineContext
        ) { laneId in
          runPrRootAction(
            "Linking pull request",
            operation: {
              try await syncService.linkPullRequestToLane(
                laneId: laneId,
                prUrlOrNumber: request.item.githubUrl.isEmpty ? "\(request.item.githubPrNumber)" : request.item.githubUrl
              )
            },
            onSuccess: {
              laneLinkRequest = nil
              // A link made on another machine shows once that machine is
              // read again.
              if isWorkRemoteLaneId(laneId) { Task { await refreshRemotePrs() } }
            }
          )
        } onOpenGitHub: {
          openGitHub(urlString: request.item.githubUrl)
        }
      }
      .sheet(item: $autoMapRequest) { request in
        PrAutoMapSheet(
          item: request.item,
          machines: machineContext.createMachines,
          canCreate: canAutoMapGitHubPullRequests,
          onCreate: { machine in confirmAutoMap(for: request.item, on: machine) },
          onCancel: { autoMapRequest = nil }
        )
        .environmentObject(syncService)
      }
    }
  }

  // MARK: - Top bar

  @ToolbarContentBuilder
  private var prsToolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      ADEHubBackButton()
    }
    .sharedBackgroundVisibility(.hidden)

    ToolbarItem(placement: .topBarLeading) {
      titleMenu
    }
    .sharedBackgroundVisibility(.hidden)

    ToolbarItem(placement: .topBarTrailing) {
      Button {
        searchPresented = true
      } label: {
        ADEKitCircleIcon(systemImage: "magnifyingglass")
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Search pull requests")
    }
    .sharedBackgroundVisibility(.hidden)

    ToolbarItem(placement: .topBarTrailing) {
      Button {
        createInitialLaneId = nil
        createPresented = true
      } label: {
        ADEKitCircleIcon(systemImage: "plus")
      }
      .buttonStyle(.plain)
      .disabled(!canCreatePr)
      .opacity(canCreatePr ? 1 : 0.45)
      .accessibilityLabel("Create pull request")
    }
    .sharedBackgroundVisibility(.hidden)

    ToolbarItem(placement: .topBarTrailing) {
      ADERootToolbarControls(scopeKey: "PRs")
    }
    .sharedBackgroundVisibility(.hidden)
  }

  /// "PRs ▾": GitHub or Workflows, and the list's scope and sort.
  private var titleMenu: some View {
    Menu {
      Picker("View", selection: selectedRootSurface) {
        Label("GitHub", systemImage: "arrow.triangle.pull").tag(PrRootSurface.github)
        Label(workflowCards.isEmpty ? "Workflows" : "Workflows (\(workflowCards.count))", systemImage: "point.3.filled.connected.trianglepath.dotted")
          .tag(PrRootSurface.workflows)
      }
      if selectedRootSurface.wrappedValue == .github {
        Section {
          Picker(selection: selectedGitHubScopeFilter) {
            ForEach(PrGitHubScopeFilter.allCases) { scope in
              Text(scope.title).tag(scope)
            }
          } label: {
            Label("Show", systemImage: "line.3.horizontal.decrease")
          }
          .pickerStyle(.menu)
          Picker(selection: selectedGitHubSort) {
            ForEach(PrGitHubSortOption.allCases) { sort in
              Text(sort.title).tag(sort)
            }
          } label: {
            Label("Sort", systemImage: "arrow.up.arrow.down")
          }
          .pickerStyle(.menu)
        }
      }
      Section {
        Button {
          Task {
            async let remote: Void = refreshRemotePrs()
            await reload(refreshRemote: true)
            await remote
          }
        } label: {
          Label("Refresh", systemImage: "arrow.clockwise")
        }
        .disabled(prsStatus.phase == .hydrating)
      }
    } label: {
      HStack(spacing: 4) {
        Text(selectedRootSurface.wrappedValue == .github ? "PRs" : "Workflows")
          .font(.system(size: 20, weight: .bold, design: .rounded))
          .foregroundStyle(ADEColor.textPrimary)
        Image(systemName: "chevron.down")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
        if hasActiveFilters {
          Circle().fill(ADEColor.accent).frame(width: 6, height: 6)
        }
      }
      .fixedSize()
    }
    .accessibilityLabel(selectedRootSurface.wrappedValue == .github ? "PRs, switch view" : "Workflows, switch view")
  }

  // MARK: - Notices

  @ViewBuilder
  private var noticeRows: some View {
    let hydrationNotice: SyncDomainFailureNotice? = (!syncService.connectionState.isHostUnreachable
      && !syncService.shouldSuppressDomainHydrationNotices)
      ? prsStatus.inlineHydrationFailureNotice(for: .prs) : nil
    let viewError = (prsStatus.phase == .ready && !syncService.connectionState.isHostUnreachable) ? errorMessage : nil
    if hydrationNotice != nil || viewError != nil || rootActionInFlightLabel != nil || laneContextLaneId != nil {
      Section {
        if let hydrationNotice {
          ADEFlatInlineNotice(message: hydrationNotice.title, retry: { Task { await reload(refreshRemote: true) } })
            .adeFlatRow(separator: .hidden)
        }
        if let viewError {
          ADEFlatInlineNotice(message: viewError, tint: ADEColor.danger, retry: { Task { await reload(refreshRemote: true) } })
            .adeFlatRow(separator: .hidden)
        }
        // The in-flight label reads from the durable service registry, so it
        // survives a tab switch and remount.
        if let rootActionInFlightLabel {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(rootActionInFlightLabel).font(.footnote).foregroundStyle(ADEColor.textSecondary)
            Spacer(minLength: 0)
          }
          .adeFlatRow(separator: .hidden)
        }
        if let laneContextLaneId {
          let laneName = lanes.first(where: { $0.id == laneContextLaneId })?.name ?? "a lane"
          HStack(spacing: 8) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 11, weight: .semibold)).foregroundStyle(ADEColor.accent)
            Text("Opened from \(laneName)").font(.footnote).foregroundStyle(ADEColor.textSecondary)
            Spacer(minLength: 8)
            Button("Clear") { self.laneContextLaneId = nil }
              .font(.footnote.weight(.semibold))
              .foregroundStyle(ADEColor.accent)
              .buttonStyle(.plain)
          }
          .adeFlatRow(separator: .hidden)
        }
      }
    }
  }

  // MARK: - GitHub list

  @ViewBuilder
  private var githubSurfaceRows: some View {
    let counts = githubCategoryCounts
    Section {
      Picker("Status", selection: selectedGitHubCategory) {
        Text(verbatim: "Open \(counts.open)").tag(PrGitHubCategory.open)
        Text(verbatim: "Merged \(counts.merged)").tag(PrGitHubCategory.merged)
        Text(verbatim: "Closed \(counts.closed)").tag(PrGitHubCategory.closed)
      }
      .pickerStyle(.segmented)
      .adeFlatRow(insets: EdgeInsets(top: 2, leading: 16, bottom: 8, trailing: 16), separator: .hidden)

      if prsStatus.phase == .ready && filteredGitHubPrs.isEmpty && !isLoadingExternalHistory {
        PrFlatEmptyRow(
          title: searchText.isEmpty ? "No pull requests here" : "No PRs match “\(searchText)”",
          message: searchText.isEmpty ? "Pull down to refresh from GitHub." : "Try a branch, an author, or a number."
        )
        .adeFlatRow(separator: .hidden)
      } else if filteredGitHubPrs.isEmpty && isLoadingExternalHistory {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Loading history…").font(.footnote).foregroundStyle(ADEColor.textSecondary)
        }
        .adeFlatRow(separator: .hidden)
      }
    }

    if githubSnapshot != nil || !prs.isEmpty {
      let repoItems = githubDerived.repoItems
      let externalItems = githubDerived.externalItems
      if !repoItems.isEmpty {
        // Merged/closed history reads as a log, so it gets period headers.
        // Open stays flat: a work queue is not chopped up by date.
        if selectedGitHubCategory.wrappedValue == .open {
          Section {
            ForEach(repoItems) { item in
              githubRow(for: item)
            }
          }
        } else {
          let groups = prListPeriodGroups(repoItems)
          ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
            Section {
              ForEach(group.items) { item in
                githubRow(for: item)
              }
            } header: {
              PrListGroupHeader(group: group, isLoading: index == 0 && isLoadingExternalHistory)
            }
          }
        }
      }
      if !externalItems.isEmpty {
        Section {
          ForEach(externalItems) { item in
            githubRow(for: item)
          }
        } header: {
          ADEFlatSectionHeader("External", detail: "\(externalItems.count)")
        }
      }
      if selectedGitHubCategory.wrappedValue != .open,
        githubSnapshot?.history?.repoPullRequestsMayHaveMore == true,
        githubHistoryPageLimit < 10
      {
        Section {
          Button {
            Task { await loadMoreGitHubHistory() }
          } label: {
            HStack(spacing: 8) {
              if isLoadingExternalHistory {
                ProgressView().controlSize(.small)
              }
              Text(isLoadingExternalHistory ? "Loading more…" : "Load older pull requests")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(ADEColor.accent)
              Spacer(minLength: 0)
            }
          }
          .buttonStyle(.plain)
          .disabled(isLoadingExternalHistory)
          .adeFlatRow(separator: .hidden)
        }
      }
    }
  }

  private func linkedPullRequest(for item: GitHubPrListItem) -> PullRequestListItem? {
    guard let linkedPrId = item.linkedPrId else { return nil }
    return prs.first { $0.id == linkedPrId }
  }

  /// The machine a row's lane is on, only when that is not the primary
  /// (focused) machine. Lanes of other machines have namespaced ids.
  private func laneMachineName(for item: GitHubPrListItem) -> String? {
    guard let laneId = item.linkedLaneId ?? linkedPullRequest(for: item)?.laneId,
      let remote = workParseRemoteLaneId(laneId),
      remote.machineKey != syncService.focusedMachineKey
    else { return nil }
    return remotePrs.machines.first { $0.machineKey == remote.machineKey }?.name ?? "another machine"
  }

  private func openRow(_ item: GitHubPrListItem) {
    if let prId = item.linkedPrId {
      if let routeScope = PrDetailRouteScope(repoOwner: item.repoOwner, repoName: item.repoName) {
        prDetailRouteScopes[prId] = routeScope
      }
      path.append(prId)
    } else {
      openGitHubDetail(item)
    }
  }

  private func openLane(for item: GitHubPrListItem) {
    guard let laneId = item.linkedLaneId ?? linkedPullRequest(for: item)?.laneId, !laneId.isEmpty else { return }
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: laneId)
  }

  private func githubRow(for item: GitHubPrListItem) -> some View {
    let linkedPr = linkedPullRequest(for: item)
    let row = PrRowCard(item: item, linkedPr: linkedPr, laneMachineName: laneMachineName(for: item))
    let hasLane = row.data.laneId != nil
    return Button {
      openRow(item)
    } label: {
      row
    }
    .buttonStyle(.plain)
    .adeFlatRow(insets: EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16))
    .contextMenu {
      if hasLane {
        Button { openLane(for: item) } label: { Label("Open lane", systemImage: "arrow.triangle.branch") }
      } else if item.scope != "external" {
        if canAutoMapGitHubPullRequests {
          Button { presentAutoMap(for: item) } label: { Label("Create lane", systemImage: "plus.square.on.square") }
        }
        if canLinkGitHubPullRequests {
          Button { laneLinkRequest = PrGitHubLaneLinkRequest(item: item) } label: { Label("Link a lane…", systemImage: "link") }
        }
      }
      Button { openGitHub(urlString: item.githubUrl) } label: { Label("Open in GitHub", systemImage: "arrow.up.right.square") }
        .disabled(item.githubUrl.isEmpty)
      Button {
        UIPasteboard.general.string = item.githubUrl
        ADEHaptics.success()
        toast = ADEToastMessage(text: "Link copied")
      } label: { Label("Copy link", systemImage: "link") }
        .disabled(item.githubUrl.isEmpty)
    } preview: {
      PrRowContextPreview(
        data: row.data,
        syncService: syncService,
        snapshotPrId: item.linkedPrId,
        warmKey: item.linkedPrId ?? prSyntheticGitHubId(for: item)
      )
    }
  }

  @MainActor
  private func openGitHubDetail(
    _ item: GitHubPrListItem,
    initialTab: PrDetailTab = .overview
  ) {
    let routeId = prSyntheticGitHubId(for: item)
    prDetailInitialTabs[routeId] = initialTab
    if let routeScope = PrDetailRouteScope(repoOwner: item.repoOwner, repoName: item.repoName) {
      prDetailRouteScopes[routeId] = routeScope
    }
    // Seed the title and identity for an instant transition. `distantPast`
    // deliberately marks this entry stale so detail performs exactly one
    // aggregate live fetch as soon as it appears.
    syncService.storePrDetailWarmEntry(
      PrDetailWarmEntry(
        pr: nil,
        githubItem: item,
        snapshot: nil,
        reviewThreads: [],
        actionRuns: [],
        activityEvents: [],
        deployments: [],
        groupMembers: [],
        capabilities: nil,
        unavailableParts: [],
        loadedAt: .distantPast
      ),
      for: routeId
    )
    path.append(routeId)
  }

  @ViewBuilder
  private var workflowsSurfaceRows: some View {
    Section {
      Picker("Kind", selection: selectedWorkflowFilter) {
        ForEach(PrWorkflowKindFilter.allCases) { filter in
          let count = workflowKindCounts[filter.rawValue] ?? 0
          Text(verbatim: count > 0 ? "\(filter.title) \(count)" : filter.title).tag(filter)
        }
      }
      .pickerStyle(.segmented)
      .adeFlatRow(insets: EdgeInsets(top: 2, leading: 16, bottom: 8, trailing: 16), separator: .hidden)
      if groupedWorkflowCards.isEmpty {
        PrFlatEmptyRow(
          title: "No active PR workflows",
          message: "Integration and rebase work shows here once the machine syncs it."
        )
        .adeFlatRow(separator: .hidden)
      }
    }
    ForEach(groupedWorkflowCards, id: \.title) { group in
      Section {
        ForEach(group.cards) { card in
          workflowCardView(card)
            .adeFlatRow(insets: EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
        }
      } header: {
        ADEFlatSectionHeader(group.title, detail: "\(group.cards.count)")
      }
    }
  }

  private func workflowCardView(_ card: PrWorkflowCard) -> some View {
    PrMobileWorkflowCardView(
      card: card,
      isLive: canRunWorkflowActions,
      onOpenPr: { prId in path.append(prId) },
      onCreateIntegrationLane: { proposalId in
        runPrRootAction("Creating integration lane") {
          _ = try await syncService.createIntegrationLaneForProposal(proposalId: proposalId)
        }
      },
      onDeleteIntegrationProposal: { proposalId in
        runPrRootAction("Deleting integration proposal") {
          _ = try await syncService.deleteIntegrationProposal(proposalId: proposalId)
        }
      },
      onDismissIntegrationCleanup: { proposalId in
        runPrRootAction("Dismissing integration cleanup") {
          try await syncService.dismissIntegrationCleanup(proposalId: proposalId)
        }
      },
      onCleanupIntegrationWorkflow: { proposalId, sourceLaneIds in
        runPrRootAction("Cleaning up integration lanes") {
          try await syncService.cleanupIntegrationWorkflow(
            proposalId: proposalId,
            archiveIntegrationLane: true,
            archiveSourceLaneIds: sourceLaneIds
          )
        }
      },
      onResolveIntegrationLane: { proposalId, laneId in
        runPrRootAction("Resolving integration lane") {
          _ = try await syncService.startIntegrationResolution(proposalId: proposalId, laneId: laneId)
        }
      },
      onRecheckIntegrationLane: { proposalId, laneId in
        runPrRootAction("Rechecking integration lane") {
          _ = try await syncService.recheckIntegrationStep(proposalId: proposalId, laneId: laneId)
        }
      },
      onRebaseLane: { laneId in
        runPrRootAction("Rebasing lane") {
          try await syncService.startLaneRebase(laneId: laneId)
        }
      },
      onDeferRebase: { laneId in
        runPrRootAction("Deferring rebase") {
          try await syncService.deferRebaseSuggestion(laneId: laneId)
        }
      },
      onDismissRebase: { laneId in
        runPrRootAction("Dismissing rebase") {
          try await syncService.dismissRebaseSuggestion(laneId: laneId)
        }
      }
    )
  }

  private struct WorkflowCardGroup {
    let title: String
    let cards: [PrWorkflowCard]
  }

  private var groupedWorkflowCards: [WorkflowCardGroup] {
    let cards = workflowCards.filter { card in
      let selected = selectedWorkflowFilter.wrappedValue
      guard selected != .all else { return true }
      return card.kind == selected.rawValue
    }
    guard !cards.isEmpty else { return [] }

    let integration = cards.filter { $0.kind == "integration" }
    let rebase = cards.filter { $0.kind == "rebase" }

    var groups: [WorkflowCardGroup] = []
    if !integration.isEmpty {
      groups.append(WorkflowCardGroup(title: "Integration", cards: integration))
    }
    if !rebase.isEmpty {
      groups.append(WorkflowCardGroup(title: "Rebase", cards: rebase))
    }
    return groups
  }

  @MainActor
  private func refreshFromPullGesture() async {
    // The other machines are read now, not on their 30-second beat.
    async let remote: Void = refreshRemotePrs()
    await reload(refreshRemote: true)
    await remote
    if errorMessage == nil {
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
        refreshFeedbackToken += 1
      }
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      var refreshError: Error?
      if refreshRemote {
        async let refreshPrs: Void = syncService.refreshPullRequestSnapshots()
        async let refreshLanes: Void = syncService.refreshLaneSnapshots()
        do {
          _ = try await (refreshPrs, refreshLanes)
        } catch {
          refreshError = error
        }
      }

      async let prsTask = syncService.fetchPullRequestListItems()
      async let lanesTask = syncService.fetchLanes()

      let loadedPrs = try await prsTask
      let loadedLanes = try await lanesTask
      if prs != loadedPrs {
        prs = loadedPrs
      }
      if lanes != loadedLanes {
        lanes = loadedLanes
      }

      let now = Date()
      let missingLiveSnapshot = mobileSnapshot == nil || githubSnapshot == nil
      let shouldAttemptLiveSnapshots = isLive
        && (refreshRemote || missingLiveSnapshot || now.timeIntervalSince(lastPrsLiveSnapshotAttempt) >= 10)

      var nextMobileSnapshot: PrMobileSnapshot?
      if shouldAttemptLiveSnapshots {
        lastPrsLiveSnapshotAttempt = now
        let includeExternalClosed = githubSnapshotShouldIncludeExternalClosed
        // If `loadGitHubExternalHistoryIfNeeded` is already fetching external
        // history, skip the external-closed arm here so we don't issue a
        // duplicate concurrent request. The other task will populate the
        // snapshot.
        let suppressExternalClosed = includeExternalClosed && isLoadingExternalHistory
        let effectiveIncludeExternalClosed = includeExternalClosed && !suppressExternalClosed
        let markLoadingExternal = effectiveIncludeExternalClosed
        if markLoadingExternal { isLoadingExternalHistory = true }
        let mobileSnapshotTask = Task { try? await syncService.fetchPrMobileSnapshot() }
        let githubSnapshotTask = Task {
          try? await syncService.fetchGitHubPullRequestSnapshot(
            force: refreshRemote,
            includeExternalClosed: effectiveIncludeExternalClosed,
            historyPageLimit: effectiveIncludeExternalClosed ? githubHistoryPageLimit : nil,
            includeStateCounts: true
          )
        }
        nextMobileSnapshot = await mobileSnapshotTask.value
        if let nextGithubSnapshot = await githubSnapshotTask.value {
          if effectiveIncludeExternalClosed {
            githubExternalHistoryLoaded = true
          }
          if githubSnapshot != nextGithubSnapshot {
            githubSnapshot = nextGithubSnapshot
          }
        }
        if markLoadingExternal { isLoadingExternalHistory = false }
      }

      if !isLive {
        if mobileSnapshot != nil {
          mobileSnapshot = nil
        }
        if githubSnapshot != nil {
          githubSnapshot = nil
        }
        githubExternalHistoryLoaded = false
        isLoadingExternalHistory = false
      }
      if let nextMobileSnapshot {
        if mobileSnapshot != nextMobileSnapshot {
          mobileSnapshot = nextMobileSnapshot
        }
        if !laneSnapshots.isEmpty {
          laneSnapshots = []
        }
        if !integrationProposals.isEmpty {
          integrationProposals = []
        }
      } else if mobileSnapshot == nil {
        async let laneSnapshotsTask = syncService.fetchLaneListSnapshots()
        async let integrationTask = syncService.fetchIntegrationProposals()

        let loadedLaneSnapshots = try await laneSnapshotsTask
        let loadedIntegrationProposals = try await integrationTask
        if laneSnapshots != loadedLaneSnapshots {
          laneSnapshots = loadedLaneSnapshots
        }
        if integrationProposals != loadedIntegrationProposals {
          integrationProposals = loadedIntegrationProposals
        }
      }

      let message = refreshError?.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    } catch {
      let message = error.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    }
  }

  @MainActor
  private func loadGitHubExternalHistoryIfNeeded() async {
    guard isLive, githubSnapshotNeedsExternalHistory, !githubExternalHistoryLoaded else { return }
    // Atomic guard against concurrent fetches: the filter `onChange` and the
    // projection-reload `task` can race here. Setting this synchronously
    // before the first await ensures only one fetch is in flight at a time.
    if isLoadingExternalHistory { return }
    isLoadingExternalHistory = true
    defer { isLoadingExternalHistory = false }
    if let nextGithubSnapshot = try? await syncService.fetchGitHubPullRequestSnapshot(
      includeExternalClosed: true,
      historyPageLimit: githubHistoryPageLimit,
      includeStateCounts: true
    ) {
      githubExternalHistoryLoaded = true
      if githubSnapshot != nextGithubSnapshot {
        githubSnapshot = nextGithubSnapshot
      }
    }
  }

  @MainActor
  private func loadMoreGitHubHistory() async {
    guard isLive, !isLoadingExternalHistory else { return }
    let nextLimit = min(10, githubHistoryPageLimit + 2)
    guard nextLimit > githubHistoryPageLimit else { return }
    isLoadingExternalHistory = true
    defer { isLoadingExternalHistory = false }
    if let nextSnapshot = try? await syncService.fetchGitHubPullRequestSnapshot(
      includeExternalClosed: true,
      historyPageLimit: nextLimit,
      includeStateCounts: true
    ) {
      githubHistoryPageLimit = nextSnapshot.history?.pageLimit ?? nextLimit
      githubExternalHistoryLoaded = true
      if githubSnapshot != nextSnapshot {
        githubSnapshot = nextSnapshot
      }
    }
  }

  @MainActor
  private func reloadGitHubProjection() async {
    guard isLive else { return }
    let includeHistory = githubSnapshotShouldIncludeExternalClosed
    if let nextSnapshot = try? await syncService.fetchGitHubPullRequestSnapshot(
      includeExternalClosed: includeHistory,
      historyPageLimit: includeHistory ? githubHistoryPageLimit : nil,
      revalidate: false,
      includeStateCounts: true
    ), githubSnapshot != nextSnapshot {
      githubSnapshot = nextSnapshot
    }
  }

  @MainActor
  private func handleRequestedPrNavigation() async {
    guard let request = syncService.requestedPrNavigation else { return }
    guard await syncService.ensureAccountMachineForNavigation(
      request.accountMachineKey
    ),
    syncService.requestedPrNavigation?.id == request.id else { return }
    if let createLaneId = request.createLaneId?.trimmingCharacters(in: .whitespacesAndNewlines),
       !createLaneId.isEmpty {
      await reload(refreshRemote: false)
      rootSurfaceRawValue = PrRootSurface.github.rawValue
      path = NavigationPath()
      laneContextLaneId = createLaneId
      createInitialLaneId = createLaneId
      createPresented = true
      syncService.requestedPrNavigation = nil
      return
    }

    var target = prNavigationTarget(
      for: request,
      pullRequests: prs,
      githubItems: githubDerived.repoItems + githubDerived.externalItems
    )
    if case .unresolved = target {
      await reload(refreshRemote: false)
      recomputeGitHubDerived()
      target = prNavigationTarget(
        for: request,
        pullRequests: prs,
        githubItems: githubDerived.repoItems + githubDerived.externalItems
      )
    }

    rootSurfaceRawValue = PrRootSurface.github.rawValue
    path = NavigationPath()
    laneContextLaneId = nil

    let destinationResolved: Bool
    switch target {
    case .detail(let prId, let laneId, let repoScope):
      laneContextLaneId = laneId
      prDetailInitialTabs[prId] = request.detailTab ?? .overview
      if let repoScope {
        prDetailRouteScopes[prId] = repoScope
      } else {
        prDetailRouteScopes.removeValue(forKey: prId)
      }
      path.append(prId)
      destinationResolved = true
    case .github(let item):
      openGitHubDetail(item, initialTab: request.detailTab ?? .overview)
      destinationResolved = true
    case .unresolved:
      errorMessage = "That pull request is not available on this phone yet."
      destinationResolved = false
    }

    if destinationResolved {
      await AccountService.shared.acknowledgeAttentionNavigation(
        request.attentionItemId
      )
    }

    syncService.requestedPrNavigation = nil
  }

  @MainActor
  @ViewBuilder
  private var createPrWizardSheet: some View {
    CreatePrWizardView(
      lanes: lanes,
      createCapabilities: mobileSnapshot?.createCapabilities,
      initialLaneId: createInitialLaneId,
      singleModeOnly: createInitialLaneId != nil,
      onCreateSingle: handleCreateSinglePr,
      onCreateIntegration: handleCreateIntegrationPr
    )
    .environmentObject(syncService)
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .presentationContentInteraction(.scrolls)
  }

  @MainActor
  private func handleCreateSinglePr(
    laneId: String,
    title: String,
    body: String,
    draft: Bool,
    baseBranch: String,
    labels: [String],
    reviewers: [String],
    strategy: String?
  ) async -> Bool {
    await performPrRootAction(
      "Creating pull request",
      operation: {
        try await syncService.createPullRequest(
          laneId: laneId,
          title: title,
          body: body,
          draft: draft,
          baseBranch: baseBranch,
          labels: labels,
          reviewers: reviewers,
          strategy: strategy
        )
      },
      onSuccess: {
        createInitialLaneId = nil
        createPresented = false
      }
    )
  }

  @MainActor
  private func handleCreateIntegrationPr(_ request: CreateIntegrationRequest) async -> Bool {
    await performPrRootAction(
      "Creating integration PR",
      operation: {
        let proposal = try await syncService.simulateIntegration(
          sourceLaneIds: request.sourceLaneIds,
          baseBranch: request.baseBranch,
          persist: true,
          mergeIntoLaneId: nil
        )
        // Conflict path: the desktop surfaces a dedicated conflict
        // resolution UI; on iOS v1 we bail out with a friendly error
        // so the host sheet can re-surface. v2 TODO: render the
        // pairwise conflict matrix inline.
        if proposal.status == "conflict" || proposal.overallOutcome == "conflict" {
          throw PrWizardError.integrationConflict
        }
        _ = try await syncService.commitIntegration(
          proposalId: proposal.proposalId,
          integrationLaneName: request.integrationLaneName,
          title: request.title,
          body: request.body,
          draft: request.draft,
          pauseOnConflict: true,
          allowDirtyWorktree: nil,
          preferredIntegrationLaneId: nil
        )
      },
      onSuccess: {
        createPresented = false
      }
    )
  }

  /// Fire-and-forget root workflow action (integration / link / merge /
  /// rebase). The in-flight entry + Task lifecycle live on `SyncService`, so the
  /// work COMPLETES and the spinner persists even if the user switches tabs and
  /// tears this view down. The view-side closures only run if the view is still
  /// alive — that's fine, they merely surface the ephemeral success/error toast.
  private func runPrRootAction(
    _ label: String,
    operation: @escaping () async throws -> Void,
    onSuccess: @escaping @MainActor () -> Void = {}
  ) {
    let service = syncService
    service.runDurablePrAction(
      key: Self.rootActionKey,
      label: label,
      operation: {
        try await operation()
        // Refresh remote state at the service level so the list reflects the
        // result regardless of whether this view is still mounted.
        try? await service.refreshPullRequestSnapshots()
        try? await service.refreshLaneSnapshots()
      },
      onSuccess: {
        onSuccess()
        Task { await reload() }
        ADEHaptics.success()
        toast = ADEToastMessage(text: "\(label) done")
      },
      onFailure: { error in
        Task { await reload() }
        ADEHaptics.error()
        toast = ADEToastMessage(text: error.localizedDescription, kind: .failure)
      }
    )
  }

  // MARK: - Auto-map (create lane from PR branch)

  /// Open the auto-map confirmation sheet for an unmapped PR. The sheet asks
  /// for the machine when there is more than one and runs the preflight there.
  private func presentAutoMap(for item: GitHubPrListItem) {
    autoMapRequest = PrAutoMapRequest(item: item)
  }

  /// Commit the auto-map: create a lane from the PR's head branch on the
  /// chosen machine via the durable action wrapper (spinner survives a tab
  /// switch), then refresh the list and navigate to the now-mapped PR. A
  /// blocking conflict surfaces its message instead of navigating.
  private func confirmAutoMap(for item: GitHubPrListItem, on machine: PrLaneMachine?) {
    autoMapRequest = nil
    let onRemote = machine?.target != nil
    runPrRootAction(
      "Creating lane from PR branch",
      operation: {
        let result: PrAutoMapCreateResult
        if let machine {
          result = try await syncService.createLaneFromPrBranch(
            repoOwner: item.repoOwner,
            repoName: item.repoName,
            githubPrNumber: item.githubPrNumber,
            on: machine
          )
        } else {
          result = try await syncService.createLaneFromPrBranch(
            repoOwner: item.repoOwner,
            repoName: item.repoName,
            githubPrNumber: item.githubPrNumber
          )
        }
        if let conflict = result.preflight.blockingConflict {
          throw PrAutoMapError.blocked(conflict.message)
        }
      },
      onSuccess: {
        if onRemote {
          // The PR row lives on that machine: read it again, then open the PR.
          Task {
            await refreshRemotePrs()
            openGitHubDetail(item)
          }
        } else {
          // The durable wrapper kicks off a refresh, but it isn't awaited
          // before this fires — so re-pull the list ourselves and only then
          // navigate to the freshly-mapped PR (matched by repo + number).
          Task { await navigateToMappedPr(for: item) }
        }
      }
    )
  }

  /// After an auto-map, refresh the list then locate the now-mapped PR row and
  /// push its detail. Best-effort: silently no-ops if the mapping hasn't
  /// surfaced yet.
  @MainActor
  private func navigateToMappedPr(for item: GitHubPrListItem) async {
    await reload()
    let repoItems = repoScopedGitHubPullRequests(from: githubSnapshot)
    if let mapped = repoItems.first(where: {
      $0.repoOwner == item.repoOwner
        && $0.repoName == item.repoName
        && $0.githubPrNumber == item.githubPrNumber
        && $0.linkedPrId != nil
    }), let prId = mapped.linkedPrId {
      path.append(prId)
    }
  }

  /// Awaitable root action used by the create-PR wizard handlers, which need the
  /// success/failure result to dismiss their sheet. The in-flight entry is
  /// registered on the durable service registry (so the banner survives a tab
  /// switch), but the caller still awaits the outcome here so the sheet can
  /// respond. The underlying remote work is what must not be cancelled — and it
  /// isn't, because the create flows complete their `sendCommand` round-trips
  /// before this returns; this awaits inside a sheet the user is actively in.
  @MainActor
  @discardableResult
  private func performPrRootAction(
    _ label: String,
    operation: @escaping () async throws -> Void,
    onSuccess: @escaping @MainActor () -> Void = {}
  ) async -> Bool {
    let token = syncService.beginPrAction(key: Self.rootActionKey, label: label)
    defer { syncService.endPrAction(key: Self.rootActionKey, token: token) }
    do {
      try await operation()
      onSuccess()
      await reload(refreshRemote: true)
      toast = ADEToastMessage(text: "\(label) done")
      return true
    } catch {
      let message = error.localizedDescription
      await reload(refreshRemote: false)
      toast = ADEToastMessage(text: message, kind: .failure)
      return false
    }
  }

  private func openGitHub(urlString: String) {
    guard let url = URL(string: urlString) else { return }
    UIApplication.shared.open(url)
  }

  // MARK: - Legacy → unified workflow card adapters
  //
  // These let the root screen keep rendering integration/rebase state when the mobile
  // snapshot fetch isn't available (older desktop build, or cold cache). Once every host the
  // user pairs with supports `prs.getMobileSnapshot` these can be dropped.

  private func legacyIntegrationCard(from proposal: IntegrationProposal) -> PrWorkflowCard {
    PrWorkflowCard(
      id: "integration:\(proposal.id)",
      kind: "integration",
      proposalId: proposal.id,
      title: proposal.title ?? proposal.integrationLaneName,
      baseBranch: proposal.baseBranch,
      overallOutcome: proposal.overallOutcome,
      integrationStatus: proposal.status,
      laneCount: proposal.laneSummaries.count,
      conflictLaneCount: proposal.laneSummaries.filter { $0.outcome == "conflict" }.count,
      lanes: proposal.laneSummaries.map {
        PrIntegrationWorkflowLane(laneId: $0.laneId, laneName: $0.laneName, outcome: $0.outcome)
      },
      workflowDisplayState: proposal.workflowDisplayState,
      cleanupState: proposal.cleanupState,
      linkedPrId: proposal.linkedPrId,
      integrationLaneId: proposal.integrationLaneId,
      preferredIntegrationLaneId: proposal.preferredIntegrationLaneId,
      mergeIntoHeadSha: proposal.mergeIntoHeadSha,
      integrationLaneOrigin: proposal.integrationLaneOrigin,
      createdAt: nil,
      laneId: nil,
      laneName: nil,
      behindBy: nil,
      conflictPredicted: nil,
      prId: nil,
      prNumber: nil,
      dismissedAt: nil,
      deferredUntil: nil
    )
  }

  private func legacyRebaseCard(from item: PrRebaseWorkflowItem) -> PrWorkflowCard {
    PrWorkflowCard(
      id: "rebase:\(item.laneId)",
      kind: "rebase",
      proposalId: nil,
      title: nil,
      baseBranch: nil,
      overallOutcome: nil,
      integrationStatus: nil,
      laneCount: nil,
      conflictLaneCount: nil,
      lanes: nil,
      workflowDisplayState: nil,
      cleanupState: nil,
      linkedPrId: nil,
      integrationLaneId: nil,
      preferredIntegrationLaneId: nil,
      mergeIntoHeadSha: nil,
      integrationLaneOrigin: nil,
      createdAt: nil,
      laneId: item.laneId,
      laneName: item.laneName,
      behindBy: item.behindCount,
      conflictPredicted: item.severity == "critical",
      prId: nil,
      prNumber: nil,
      dismissedAt: nil,
      deferredUntil: item.deferredUntil
    )
  }
}
fileprivate enum PrWizardError: LocalizedError {
  case integrationConflict

  var errorDescription: String? {
    switch self {
    case .integrationConflict:
      return "Integration has conflicts — simulate in full first"
    }
  }
}
