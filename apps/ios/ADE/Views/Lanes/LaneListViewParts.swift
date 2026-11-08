import SwiftUI
import UIKit

/// A lane pushed on the Lanes stack.
struct LaneRoute: Hashable {
  let laneId: String
}

/// Which machines' lanes the Lanes tab shows.
enum LaneMachineFilter: Equatable {
  case all
  case focused
  case machine(String)
}

struct LaneListPresentation: Equatable {
  var filteredSnapshots: [LaneListSnapshot]
  var orderedSnapshots: [LaneListSnapshot]
  var lanePrTagsByLaneId: [String: LanePrTag]
  /// Rows each quick filter would show (before search), for its chip.
  var quickFilterCounts: [LaneQuickFilter: Int] = [:]

  static let empty = LaneListPresentation(
    filteredSnapshots: [],
    orderedSnapshots: [],
    lanePrTagsByLaneId: [:]
  )
}

extension LanesTabView {
  var filteredSnapshots: [LaneListSnapshot] {
    laneListPresentation.filteredSnapshots
  }

  var primaryLane: LaneSummary? {
    visibleLaneSnapshots.first(where: { $0.lane.laneType == "primary" })?.lane
  }

  /// A host-side lane delete may take several minutes. Keep its stale local
  /// snapshot out of navigation and list affordances while SyncService owns
  /// that cleanup request.
  var visibleLaneSnapshots: [LaneListSnapshot] {
    laneSnapshots.filter { !syncService.isLaneDeletionPending($0.lane.id) }
  }

  var manageableVisibleLaneIds: [String] {
    filteredSnapshots
      .map(\.lane)
      .filter { $0.laneType != "primary" && $0.archivedAt == nil }
      .map(\.id)
  }

  var openLaneSnapshots: [LaneListSnapshot] {
    openLaneIds.compactMap { laneId in
      visibleLaneSnapshots.first(where: { $0.lane.id == laneId })
    }
  }

  @ViewBuilder
  var openLanesTray: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        ADEEyebrow("Open lanes")
        Spacer()
        Button {
          withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
            openLaneIds = openLaneIds.filter { pinnedLaneIds.contains($0) }
          }
        } label: {
          Text("Clear")
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(ADEColor.textSecondary)
        }
        .accessibilityLabel("Clear open lanes")
      }
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(openLaneSnapshots) { snapshot in
            Button {
              openLane(snapshot.lane.id)
            } label: {
              LaneOpenChip(snapshot: snapshot, isPinned: pinnedLaneIds.contains(snapshot.lane.id))
            }
            .buttonStyle(.plain)
            .contextMenu {
              manageLaneButton(snapshot)
              Button {
                togglePin(snapshot.lane.id)
              } label: {
                LanePinLabel(pinned: pinnedLaneIds.contains(snapshot.lane.id))
              }
              Button {
                closeLaneChip(snapshot.lane.id)
              } label: {
                Label("Remove from open lanes", systemImage: "xmark.rectangle")
              }
              Button {
                openLaneIds = [snapshot.lane.id]
              } label: {
                Label("Close others", systemImage: "rectangle.on.rectangle.slash")
              }
            }
          }
        }
      }
    }
    .padding(.horizontal, 2)
  }

  var orderedSnapshots: [LaneListSnapshot] {
    laneListPresentation.orderedSnapshots
  }

  var lanePrTagsByLaneId: [String: LanePrTag] {
    laneListPresentation.lanePrTagsByLaneId
  }

  @MainActor
  func refreshLaneListPresentation() {
    let visible = visibleLaneSnapshots
    let filtered = laneListFilteredSnapshots(
      visible.filter(quickFilter.matches),
      scope: quickFilter.scope,
      searchText: searchText,
      pinnedLaneIds: pinnedLaneIds
    )
    var counts: [LaneQuickFilter: Int] = [:]
    for filter in LaneQuickFilter.allCases {
      counts[filter] = visible.reduce(0) { $0 + (filter.matches($1) ? 1 : 0) }
    }
    let next = LaneListPresentation(
      filteredSnapshots: filtered,
      orderedSnapshots: laneListDisplayOrder(filtered),
      lanePrTagsByLaneId: lanePrTagByLaneId(
        snapshots: laneSnapshots,
        pullRequests: pullRequests,
        githubPrs: syncService.laneGithubPrItems
      ),
      quickFilterCounts: counts
    )
    guard next != laneListPresentation else { return }
    laneListPresentation = next
  }

  /// The focused machine's name for its chip and filter.
  var focusedMachineName: String {
    syncService.focusedMachineDisplayName
  }

  var laneMachineChips: LaneMachineChips {
    guard !remoteLanes.machines.isEmpty else { return .none }
    return LaneMachineChips(
      focused: LaneMachineChip(
        name: focusedMachineName,
        isLive: true,
        symbol: machineSymbol(machineKey: syncService.focusedMachineKey, name: focusedMachineName)
      ),
      byMachineKey: Dictionary(
        remoteLanes.machines.map {
          ($0.machineKey, LaneMachineChip(name: $0.name, isLive: $0.isLive, symbol: machineSymbol(machineKey: $0.machineKey, name: $0.name)))
        },
        uniquingKeysWith: { first, _ in first }
      )
    )
  }

  var showsFocusedMachineLanes: Bool {
    switch machineFilter {
    case .all, .focused: return true
    case .machine: return false
    }
  }

  /// The other machines the filter shows, each with its rows filtered and
  /// ordered the same way as the focused list.
  var visibleRemoteMachineLanes: [(machine: LaneRemoteMachinesModel.MachineLanes, snapshots: [LaneListSnapshot])] {
    remoteLanes.machines.compactMap { machine in
      switch machineFilter {
      case .focused: return nil
      case .machine(let key) where key != machine.machineKey: return nil
      default: break
      }
      let filtered = laneListFilteredSnapshots(
        machine.snapshots.filter(quickFilter.matches),
        scope: quickFilter.scope,
        searchText: searchText,
        pinnedLaneIds: pinnedLaneIds
      )
      guard !filtered.isEmpty else { return nil }
      return (machine, laneListDisplayOrder(filtered))
    }
  }

  @ViewBuilder
  var laneMachineFilterChips: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 7) {
        LaneMachineFilterChip(
          title: "All",
          symbol: "square.stack.3d.up",
          liveDot: nil,
          selected: machineFilter == .all
        ) {
          machineFilter = .all
        }
        LaneMachineFilterChip(
          title: focusedMachineName,
          symbol: machineSymbol(machineKey: syncService.focusedMachineKey, name: focusedMachineName),
          liveDot: true,
          selected: machineFilter == .focused
        ) {
          machineFilter = machineFilter == .focused ? .all : .focused
        }
        ForEach(remoteLanes.machines) { machine in
          LaneMachineFilterChip(
            title: machine.name,
            symbol: machineSymbol(machineKey: machine.machineKey, name: machine.name),
            liveDot: machine.isLive,
            selected: machineFilter == .machine(machine.machineKey)
          ) {
            machineFilter = machineFilter == .machine(machine.machineKey) ? .all : .machine(machine.machineKey)
          }
        }
      }
      .padding(.horizontal, 2)
      .padding(.vertical, 1)
    }
    .scrollClipDisabled()
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Machines")
  }

  /// "Show only <machine>" for a lane's machine, from its long-press menu.
  func showOnlyMachine(ofLaneId laneId: String) {
    if let remote = workParseRemoteLaneId(laneId) {
      machineFilter = .machine(remote.machineKey)
    } else {
      machineFilter = .focused
    }
  }

  /// Pushes a lane's detail through the stack's path on the phone; fills the
  /// detail column instead on the Duo's inner display.
  func openLane(_ laneId: String) {
    // Kept in both layouts so folding or unfolding the device keeps the lane
    // the reader was looking at.
    duoSelectedLaneId = laneId
    if duoLayout.isWide {
      return
    }
    lanePath.append(LaneRoute(laneId: laneId))
  }

  /// The detail screen for a pushed lane: this machine's row, or the row
  /// another machine holds for a namespaced id.
  @ViewBuilder
  func laneDestination(_ route: LaneRoute, showsBackButton: Bool = true) -> some View {
    if let snapshot = laneSnapshots.first(where: { $0.lane.id == route.laneId }) {
      LaneDetailScreen(
        laneId: route.laneId,
        initialSnapshot: snapshot,
        allLaneSnapshots: laneSnapshots,
        transitionNamespace: transitionNamespace,
        showsBackButton: showsBackButton,
        machineName: focusedMachineName,
        onRefreshRoot: { await reload(refreshRemote: true) }
      )
    } else if let machine = remoteLanes.machines.first(where: { $0.snapshots.contains { $0.lane.id == route.laneId } }),
      let snapshot = machine.snapshots.first(where: { $0.lane.id == route.laneId })
    {
      LaneDetailScreen(
        laneId: route.laneId,
        initialSnapshot: snapshot,
        allLaneSnapshots: machine.snapshots,
        transitionNamespace: transitionNamespace,
        showsBackButton: showsBackButton,
        machineName: machine.name,
        onRefreshRoot: { await remoteLanes.refresh(sync: syncService, fleet: machineFleet) }
      )
    } else {
      ADEEmptyStateView(
        symbol: "square.stack.3d.up.slash",
        title: "Lane unavailable",
        message: "This lane is no longer on this phone. Refresh Lanes and try again."
      )
    }
  }

  var laneRowInsets: EdgeInsets {
    EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 6)
  }

  /// One lane as a list row: the tree row, plus pin (leading) and archive or
  /// restore (trailing) on swipe.
  @ViewBuilder
  func laneListRow(
    _ snapshot: LaneListSnapshot,
    pullRequest: LanePrTag?,
    showsMachineChip: Bool,
    chips: LaneMachineChips
  ) -> some View {
    let laneId = snapshot.lane.id
    let pinned = pinnedLaneIds.contains(laneId)
    let machine = chips.chip(forLaneId: laneId)
    // A machine with no live link shows its last roster dimmed and inert, so
    // its rows carry no swipe actions either.
    let actionable = machine?.isLive != false
    let isDuoSelected = duoLayout.isWide && duoSelectedLaneId == laneId
    LaneTreeRow(
      snapshot: snapshot,
      pullRequest: pullRequest,
      isPinned: pinned,
      isOpen: openLaneIds.contains(laneId),
      transitionNamespace: transitionNamespace,
      isSelectedTransitionSource: isDuoSelected || selectedLaneTransitionId == laneId,
      onContextMenu: { snapshot in AnyView(laneContextMenu(snapshot: snapshot)) },
      onSelectLane: { selectedLaneTransitionId = $0 },
      onOpen: { openLane(laneId) },
      machine: machine,
      showsMachineChip: showsMachineChip
    )
    // The Duo's list column marks its selected row the way a desktop sidebar
    // does (a tinted rounded rectangle inset from the column's edges); the
    // phone has no selection to show.
    .background {
      if isDuoSelected {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(ADEColor.accent.opacity(0.12))
          .padding(.horizontal, 6)
      }
    }
    .adeFlatRow(insets: laneRowInsets)
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      if actionable {
        Button {
          togglePin(laneId)
        } label: {
          LanePinLabel(pinned: pinned)
        }
        .tint(ADEColor.accent)
      }
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      if actionable {
        archiveOrRestoreButton(snapshot)
          .tint(snapshot.lane.archivedAt == nil ? ADEColor.warning : ADEColor.success)
      }
    }
  }

  /// Archive for an active lane, Restore for an archived one; nothing for the
  /// primary lane.
  /// `archiveRole` is `.destructive` in menus (red); a swipe action takes
  /// its tint instead.
  @ViewBuilder
  func archiveOrRestoreButton(_ snapshot: LaneListSnapshot, archiveRole: ButtonRole? = nil) -> some View {
    if snapshot.lane.laneType != "primary" {
      if snapshot.lane.archivedAt == nil {
        Button(role: archiveRole) {
          Task { await archiveLane(snapshot) }
        } label: {
          Label("Archive", systemImage: "archivebox")
        }
        .disabled(!canRunLiveActions)
      } else {
        Button {
          Task { await restoreLane(snapshot) }
        } label: {
          Label("Restore", systemImage: "tray.and.arrow.up")
        }
        .disabled(!canRunLiveActions)
      }
    }
  }

  func manageLaneButton(_ snapshot: LaneListSnapshot) -> some View {
    Button {
      detailSheetTarget = LaneDetailSheetTarget(laneId: snapshot.lane.id, snapshot: snapshot, initialSection: .git)
    } label: {
      Label("Manage lane", systemImage: "slider.horizontal.3")
    }
  }

  /// The lane rows: the focused machine's lanes (primary first, then the
  /// rest oldest first), then each other machine's lanes under its name.
  @ViewBuilder
  var laneListSections: some View {
    // Built once per pass, not once per row.
    let chips = laneMachineChips
    let remoteSections = visibleRemoteMachineLanes
    if showsFocusedMachineLanes, laneSnapshots.isEmpty, remoteLanes.machines.isEmpty {
      if let emptyStatePresentation {
        emptyStateCard(emptyStatePresentation)
          .padding(.top, 16)
          .adeFlatRow(insets: EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16), separator: .hidden)
      } else if !showsLaneLoadingSkeletons {
        ADEEmptyStateView(
          symbol: "plus.circle.dashed",
          title: "No lanes yet",
          message: "Tap + to create your first lane."
        )
        .padding(.top, 32)
        .adeFlatRow(separator: .hidden)
      }
    } else if (!showsFocusedMachineLanes || filteredSnapshots.isEmpty) && remoteSections.isEmpty {
      ADEEmptyStateView(
        symbol: "square.stack.3d.up.slash",
        title: quickFilter.emptyTitle,
        message: laneQuickFilterEmptyMessage
      )
      .padding(.top, 32)
      .adeFlatRow(separator: .hidden)
    } else {
      if showsFocusedMachineLanes, !orderedSnapshots.isEmpty {
        Section {
          ForEach(orderedSnapshots) { snapshot in
            laneListRow(
              snapshot,
              pullRequest: lanePrTagsByLaneId[snapshot.lane.id],
              // Each machine's lanes are their own section, named in its
              // header: a machine chip on every row only repeated it.
              showsMachineChip: false,
              chips: chips
            )
          }
        } header: {
          if !remoteLanes.machines.isEmpty {
            ADEFlatSectionHeader(focusedMachineName, detail: "\(orderedSnapshots.count)")
          }
        }
      }
      ForEach(remoteSections, id: \.machine.machineKey) { entry in
        Section {
          ForEach(entry.snapshots) { snapshot in
            laneListRow(
              snapshot,
              pullRequest: nil,
              showsMachineChip: false,
              chips: chips
            )
          }
        } header: {
          ADEFlatSectionHeader(
            entry.machine.isLive ? entry.machine.name : "\(entry.machine.name) · not live",
            detail: "\(entry.snapshots.count)"
          )
        }
      }
    }
  }

  private var laneQuickFilterEmptyMessage: String {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    if !query.isEmpty { return "No lanes match “\(query)”." }
    switch quickFilter {
    case .active: return "Tap + to create a lane."
    case .running: return "No lane has a chat running right now."
    case .attention: return "Nothing is waiting on you."
    case .dirty: return "Every lane's working tree is clean."
    case .archived: return "Archived lanes show here."
    }
  }

  /// Search, always on screen (the old `.searchable` drawer never rendered:
  /// this screen hides its navigation bar).
  var laneSearchField: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(ADEColor.textMuted)
      TextField("Search lanes, branches, is:dirty", text: $searchText)
        .font(.system(size: 15))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.search)
      if !searchText.isEmpty {
        Button {
          searchText = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 15))
            .foregroundStyle(ADEColor.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear search")
      }
    }
    .padding(.horizontal, 12)
    .frame(height: 38)
    .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
  }

  /// Active / Running / Needs you / Changes / Archived, each with its count.
  /// A filter with no lanes stays tappable so its empty state can say so, but
  /// reads muted.
  var laneQuickFilterChips: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 7) {
        ForEach(LaneQuickFilter.allCases) { filter in
          let count = laneListPresentation.quickFilterCounts[filter] ?? 0
          LaneQuickFilterChip(
            title: filter.title,
            count: count,
            tone: filter == .attention && count > 0 ? ADEColor.warning : nil,
            selected: quickFilter == filter
          ) {
            withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
              quickFilter = quickFilter == filter && filter != .active ? .active : filter
            }
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 1)
    }
    .scrollClipDisabled()
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Lane filters")
  }

  @ViewBuilder
  var laneNoticeRows: some View {
    let hostReachable = !syncService.connectionState.isHostUnreachable
    if hostReachable,
      !syncService.shouldSuppressDomainHydrationNotices,
      let hydrationNotice = laneStatus.inlineHydrationFailureNotice(for: .lanes)
    {
      ADEFlatInlineNotice(message: hydrationNotice.title, retry: { Task { await reload(refreshRemote: true) } })
        .adeFlatRow(separator: .hidden)
    }
    if let errorMessage, laneStatus.phase == .ready, hostReachable {
      ADEFlatInlineNotice(message: errorMessage, tint: ADEColor.danger, retry: { Task { await reload(refreshRemote: true) } })
        .adeFlatRow(separator: .hidden)
    }
    ForEach(syncService.activeLaneDeletionsKept) { kept in
      LaneDeletionKeptNotice(
        kept: kept,
        canRunLiveActions: canRunLiveActions,
        onRestore: { await restoreKeptLane(kept) },
        onDismiss: { syncService.dismissLaneDeletionKept(kept.id) }
      )
      .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16), separator: .hidden)
    }
    if let laneDeletionError = syncService.activeLaneDeletionError {
      ADENoticeCard(
        title: "Lane deletion failed",
        message: laneDeletionError,
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Dismiss",
        action: { syncService.clearLaneDeletionFailure() }
      )
      .adeFlatRow(separator: .hidden)
    }
    if let primaryBranchError, laneStatus.phase == .ready, hostReachable {
      ADEFlatInlineNotice(message: primaryBranchError, tint: ADEColor.danger, retry: { Task { await refreshPrimaryBranches(force: true) } })
        .adeFlatRow(separator: .hidden)
    }
    if hostReachable, let liveActionNoticePresentation {
      ADENoticeCard(
        title: liveActionNoticePresentation.title,
        message: liveActionNoticePresentation.message,
        icon: liveActionNoticePresentation.symbol,
        tint: ADEColor.warning,
        actionTitle: liveActionNoticePresentation.actionTitle,
        action: liveActionNoticePresentation.action.map { action in
          { handleNoticeAction(action) }
        }
      )
      .adeFlatRow(separator: .hidden)
    }
  }

  /// The focused machine, then every live machine with this repository: the
  /// places the Archived filter lists deleted lanes from.
  var recentlyDeletedMachines: [LaneRecentlyDeletedMachine] {
    var machines = [LaneRecentlyDeletedMachine(id: "", name: focusedMachineName, projectId: nil, rootPath: nil)]
    for machine in remoteLanes.machines where machine.isLive {
      machines.append(LaneRecentlyDeletedMachine(
        id: machine.machineKey,
        name: machine.name,
        projectId: machine.markedProjectId,
        rootPath: machine.rootPath
      ))
    }
    return machines
  }

  @MainActor
  func restoreKeptLane(_ kept: LaneDeletionKept) async {
    do {
      let result = try await syncService.restoreDeletedLane(
        kept.id,
        targetProjectId: kept.projectId,
        targetProjectRootPath: kept.projectRootPath
      )
      if result.restoredUncommitted {
        ADEHaptics.success()
      } else {
        ADEHaptics.warning()
        errorMessage = "\(kept.snapshot.laneName) is back on \(result.branchName), but its uncommitted files did not apply and stay in Archived › Recently deleted: \(result.warning ?? "unknown error")"
      }
      await reload(refreshRemote: true)
    } catch {
      ADEHaptics.error()
      errorMessage = "Couldn’t restore \(kept.snapshot.laneName): \(SyncUserFacingError.message(for: error))"
    }
  }

  @MainActor
  func archiveLane(_ snapshot: LaneListSnapshot) async {
    do {
      try await syncService.archiveLane(snapshot.lane.id)
      ADEHaptics.success()
      await reloadAfterLaneAction(snapshot.lane.id, refreshRemote: true)
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func restoreLane(_ snapshot: LaneListSnapshot) async {
    do {
      try await syncService.unarchiveLane(snapshot.lane.id)
      ADEHaptics.success()
      await reloadAfterLaneAction(snapshot.lane.id, refreshRemote: true)
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @ViewBuilder
  func laneContextMenu(snapshot: LaneListSnapshot) -> some View {
    if let chip = laneMachineChips.chip(forLaneId: snapshot.lane.id) {
      Button {
        showOnlyMachine(ofLaneId: snapshot.lane.id)
      } label: {
        Label("Show only \(chip.name)", systemImage: "desktopcomputer")
      }
    }
    manageLaneButton(snapshot)
    // The branch list belongs to the focused machine's primary lane.
    if snapshot.lane.laneType == "primary", !isWorkRemoteLaneId(snapshot.lane.id), !primaryBranches.isEmpty {
      Menu {
        ForEach(primaryBranches) { branch in
          Button(branch.name) {
            Task {
              do {
                try await syncService.checkoutPrimaryBranch(
                  laneId: snapshot.lane.id,
                  branchName: branch.name,
                  mode: "existing",
                  startPoint: nil,
                  baseRef: nil,
                  acknowledgeActiveWork: false
                )
                await reload(refreshRemote: true)
                await refreshPrimaryBranches(force: true)
              } catch {
                ADEHaptics.error()
                primaryBranchError = error.localizedDescription
              }
            }
          }
          .disabled(!canRunLiveActions)
        }
      } label: {
        Label("Switch primary branch", systemImage: "arrow.triangle.branch")
      }
    }
    Button {
      toggleOpenLane(snapshot.lane.id)
    } label: {
      let isOpen = openLaneIds.contains(snapshot.lane.id)
      Label(
        isOpen ? "Remove from open lanes" : "Add to open lanes",
        systemImage: isOpen ? "xmark.rectangle" : "rectangle.badge.plus"
      )
    }
    Button {
      togglePin(snapshot.lane.id)
    } label: {
      LanePinLabel(pinned: pinnedLaneIds.contains(snapshot.lane.id))
    }
    Menu {
      ForEach(LaneColorPalette.entries) { entry in
        let used = LaneColorPalette.colorsInUse(amongLanes: laneSnapshots.map(\.lane), excluding: snapshot.lane.id)
        let isTaken = used.contains(entry.hex.lowercased()) && snapshot.lane.color?.lowercased() != entry.hex.lowercased()
        Button {
          Task { await applyLaneColor(entry.hex, to: snapshot.lane.id) }
        } label: {
          Label(entry.name, systemImage: snapshot.lane.color?.lowercased() == entry.hex.lowercased() ? "checkmark.circle.fill" : "circle.fill")
        }
        .disabled(isTaken || !canRunLiveActions)
      }
    } label: {
      Label("Color", systemImage: "paintpalette")
    }
    Button {
      openLaneIds = [snapshot.lane.id]
    } label: {
      Label("Close others", systemImage: "rectangle.on.rectangle.slash")
    }
    if !manageableVisibleLaneIds.isEmpty {
      Button {
        batchManageLaneIds = manageableVisibleLaneIds
        batchManagePresented = true
      } label: {
        Label("Select all active visible lanes", systemImage: "checkmark.rectangle.stack")
      }
      .disabled(!canRunLiveActions)
    }
    if manageableVisibleLaneIds.count > 1 {
      Button {
        batchManageLaneIds = manageableVisibleLaneIds
        batchManagePresented = true
      } label: {
        Label("Manage \(manageableVisibleLaneIds.count) visible lanes", systemImage: "square.grid.2x2")
      }
      .disabled(!canRunLiveActions)
    }
    archiveOrRestoreButton(snapshot, archiveRole: .destructive)
    Button {
      UIPasteboard.general.string = snapshot.lane.worktreePath
    } label: {
      Label("Copy path", systemImage: "doc.on.doc")
    }
  }

  @MainActor
  func applyLaneColor(_ hex: String?, to laneId: String) async {
    do {
      try await syncService.updateLaneAppearance(laneId, color: hex ?? "")
      await reloadAfterLaneAction(laneId, refreshRemote: false)
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  /// After a lane action, read the lane's own machine again: another
  /// machine's lane otherwise stays stale until its 30-second poll.
  @MainActor
  func reloadAfterLaneAction(_ laneId: String, refreshRemote: Bool) async {
    if isWorkRemoteLaneId(laneId) {
      await remoteLanes.refresh(sync: syncService, fleet: machineFleet)
    } else {
      await reload(refreshRemote: refreshRemote)
    }
  }

  @MainActor
  func reload(refreshRemote: Bool = false, includeDecorations: Bool = true) async {
    let diagnosticsStart = CACurrentMediaTime()
    defer { ScrollDiagnostics.shared.record(.lanesReload, since: diagnosticsStart) }
    do {
      if refreshRemote {
        try await syncService.refreshLaneSnapshots(includeDecorations: includeDecorations)
      }
      let loadedSnapshots = try await syncService.fetchLaneListSnapshots(includeArchived: true)
      let loadedPullRequests = try await syncService.fetchPullRequestListItems()
      if laneSnapshots != loadedSnapshots {
        laneSnapshots = loadedSnapshots
      }
      if pullRequests != loadedPullRequests {
        pullRequests = loadedPullRequests
      }
      refreshLaneListPresentation()
      // Layer in GitHub PRs opened outside ADE (matched to lanes by branch).
      // Best-effort and non-blocking: the ADE-mapped chip is already rendered;
      // `laneGithubPrItems` publishes when the snapshot lands and recomputes the
      // tag map. Pull-to-refresh forces a fresh fetch; routine reloads throttle.
      Task { await syncService.refreshLaneGithubPrItems(force: refreshRemote) }
      // This reads only this machine's lanes, so it prunes only those ids;
      // another machine's lanes keep their pin and open state.
      let visibleIds = Set(loadedSnapshots.map(\.lane.id))
      // A remote id is dropped only once its machine's lanes are loaded and
      // no longer hold it; a machine not read yet keeps its ids.
      let remoteIdsByMachine = Dictionary(
        remoteLanes.machines.map { ($0.machineKey, Set($0.snapshots.map(\.lane.id))) },
        uniquingKeysWith: { first, _ in first }
      )
      let isStillHere = { (id: String) -> Bool in
        guard let remote = workParseRemoteLaneId(id) else { return visibleIds.contains(id) }
        return remoteIdsByMachine[remote.machineKey]?.contains(id) ?? true
      }
      let nextOpenLaneIds = openLaneIds.filter(isStillHere)
      if nextOpenLaneIds != openLaneIds {
        openLaneIds = nextOpenLaneIds
      }
      let nextPinnedLaneIds = Set(pinnedLaneIds.filter(isStillHere))
      if nextPinnedLaneIds != pinnedLaneIds {
        pinnedLaneIds = nextPinnedLaneIds
      }
      if let selectedLaneTransitionId, !isStillHere(selectedLaneTransitionId) {
        self.selectedLaneTransitionId = nil
      }
      if errorMessage != nil {
        errorMessage = nil
      }
    } catch is CancellationError {
      // A newer reload or a view restart took over; it reports its own result.
    } catch {
      ADEHaptics.error()
      let message = error.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    }
  }

  func toggleOpenLane(_ laneId: String) {
    withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
      if openLaneIds.contains(laneId) {
        closeLaneChip(laneId)
      } else {
        openLaneIds.insert(laneId, at: 0)
      }
    }
  }

  /// Pinned lanes cannot be closed; they stay in the open-lanes tray until explicitly unpinned.
  func closeLaneChip(_ laneId: String) {
    if pinnedLaneIds.contains(laneId) {
      return
    }
    openLaneIds.removeAll { $0 == laneId }
  }

  func togglePin(_ laneId: String) {
    var next = pinnedLaneIds
    if next.contains(laneId) {
      next.remove(laneId)
    } else {
      next.insert(laneId)
      if !openLaneIds.contains(laneId) {
        openLaneIds.insert(laneId, at: 0)
      }
    }
    pinnedLaneIds = next
    ADEHaptics.light()
  }

  @MainActor
  func handleRequestedLaneNavigation() async {
    guard let request = syncService.requestedLaneNavigation else { return }

    // Let the context menu dismiss and the TabView finish presenting Lanes before
    // attaching a sheet. Without this hop, cross-tab "Go to lane" can switch
    // tabs while SwiftUI silently drops the detail presentation.
    do {
      try await Task.sleep(for: .milliseconds(650))
    } catch {
      return
    }
    guard syncService.requestedLaneNavigation?.id == request.id else { return }

    var snapshot: LaneListSnapshot?
    if isWorkRemoteLaneId(request.laneId) {
      // A lane of another machine (from the PRs tab or a link): its row comes
      // from that machine, read again once when this phone has not yet.
      let remoteSnapshot = { remoteLanes.machines.lazy.flatMap(\.snapshots).first { $0.lane.id == request.laneId } }
      snapshot = remoteSnapshot()
      if snapshot == nil {
        await remoteLanes.refresh(sync: syncService, fleet: machineFleet)
        guard !Task.isCancelled, syncService.requestedLaneNavigation?.id == request.id else { return }
        snapshot = remoteSnapshot()
      }
    } else {
      snapshot = laneSnapshots.first(where: { $0.lane.id == request.laneId })
      if snapshot == nil {
        await reload(refreshRemote: canRunLiveActions)
        guard !Task.isCancelled, syncService.requestedLaneNavigation?.id == request.id else { return }
        snapshot = laneSnapshots.first(where: { $0.lane.id == request.laneId })
      }
    }

    guard let resolvedSnapshot = snapshot else {
      errorMessage = request.projectName.map { "That lane isn't in \($0) any more." }
        ?? "The requested lane is not cached on this phone yet. Refresh Lanes and try again."
      syncService.requestedLaneNavigation = nil
      return
    }

    if !openLaneIds.contains(request.laneId) {
      openLaneIds.insert(request.laneId, at: 0)
    }
    selectedLaneTransitionId = request.laneId
    detailSheetTarget = LaneDetailSheetTarget(
      laneId: request.laneId,
      snapshot: resolvedSnapshot,
      initialSection: .git
    )
    syncService.requestedLaneNavigation = nil
  }

  @MainActor
  func refreshFromPullGesture() async {
    // The other machines are read now, not on their 30-second beat.
    async let remote: Void = remoteLanes.refresh(sync: syncService, fleet: machineFleet)
    await reload(refreshRemote: true)
    await remote
    if errorMessage == nil {
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
        refreshFeedbackToken += 1
      }
    }
  }
}

/// One machine filter on the Lanes tab: the machine's symbol, its name, and a
/// dot that says whether the phone has a live link to it.
struct LaneMachineFilterChip: View {
  let title: String
  let symbol: String
  /// Nil for "All"; true when the phone has a live link to the machine.
  let liveDot: Bool?
  let selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Image(systemName: symbol)
          .font(.system(size: 11.5, weight: .medium))
          .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textSecondary)
        Text(title)
          .font(.system(size: 12.5, weight: selected ? .semibold : .medium))
          .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textSecondary)
          .lineLimit(1)
        if let liveDot {
          Circle()
            .fill(liveDot ? ADEColor.success : ADEColor.textMuted.opacity(0.6))
            .frame(width: 6, height: 6)
        }
      }
      .padding(.horizontal, 11)
      .frame(height: 30)
      // Kit segmented look: neutral track, the selected machine raised.
      .background(selected ? ADEKit.surface : ADEKit.track, in: Capsule(style: .continuous))
      .overlay {
        if selected {
          Capsule(style: .continuous).strokeBorder(ADEKit.edge, lineWidth: 0.75)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(liveDot == false ? "\(title), not live" : title)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// One quick filter on the Lanes tab: its name and how many lanes it holds.
struct LaneQuickFilterChip: View {
  let title: String
  let count: Int
  /// A colour for the count when the filter needs attention (Needs you).
  var tone: Color? = nil
  let selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Text(title)
          .font(.system(size: 13, weight: selected ? .semibold : .medium))
        Text("\(count)")
          .font(.system(size: 12, weight: .semibold).monospacedDigit())
          .foregroundStyle(selected ? ADEColor.textSecondary : (tone ?? ADEColor.textMuted))
      }
      .foregroundStyle(selected ? ADEColor.textPrimary : (count == 0 ? ADEColor.textMuted : ADEColor.textSecondary))
      .padding(.horizontal, 12)
      .frame(height: 30)
      .background(selected ? ADEKit.surface : ADEKit.track, in: Capsule(style: .continuous))
      .overlay {
        if selected {
          Capsule(style: .continuous).strokeBorder(ADEKit.edge, lineWidth: 0.75)
        }
      }
      .contentShape(Capsule(style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(title), \(count)")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// A lane row's shape while the first lanes load.
struct LaneRowSkeleton: View {
  var body: some View {
    HStack(spacing: 11) {
      RoundedRectangle(cornerRadius: 5).fill(ADEKit.track).frame(width: 18, height: 18)
      VStack(alignment: .leading, spacing: 7) {
        RoundedRectangle(cornerRadius: 4).fill(ADEKit.track).frame(width: 170, height: 12)
        RoundedRectangle(cornerRadius: 4).fill(ADEKit.track.opacity(0.7)).frame(width: 230, height: 9)
      }
      Spacer(minLength: 0)
    }
    .padding(.leading, ADEKit.inset)
    .padding(.vertical, 14)
    .accessibilityHidden(true)
  }
}

/// Pin / Unpin for a lane's menus and swipe action.
struct LanePinLabel: View {
  let pinned: Bool

  var body: some View {
    Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash.fill" : "pin.fill")
  }
}

// MARK: - Recently deleted lanes

/// One machine's checkout whose deleted lanes the Archived filter lists.
/// `projectId`/`rootPath` are nil for the focused machine (the default route).
struct LaneRecentlyDeletedMachine: Equatable, Identifiable {
  let id: String
  let name: String
  let projectId: String?
  let rootPath: String?
}

/// "Kept 30 more days" from a save's expiry.
func deletedLaneKeptLabel(_ snapshot: DeletedLaneSnapshot, now: Date = Date()) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let expires = formatter.date(from: snapshot.expiresAt)
    ?? ISO8601DateFormatter().date(from: snapshot.expiresAt)
  guard let expires else { return "kept 30 days" }
  let days = max(0, Int((expires.timeIntervalSince(now) / 86_400).rounded(.up)))
  return days <= 1 ? "kept 1 more day" : "kept \(days) more days"
}

/// "Uncommitted files · Deleted 2 hours ago · kept 29 more days"
func deletedLaneMetaLine(_ snapshot: DeletedLaneSnapshot) -> String {
  [
    snapshot.uncommitted ? "Uncommitted files" : "Unpushed commits",
    "\(snapshot.isFreed ? "Space freed" : "Deleted") \(relativeTimestamp(snapshot.deletedAt))",
    deletedLaneKeptLabel(snapshot),
  ].joined(separator: " · ")
}

/// The Archived filter's "Recently deleted" sections: lanes whose work a
/// delete (or freeing up space) kept, per machine, with Restore and Drop.
/// Each call goes to the machine the save lives on.
struct LaneRecentlyDeletedSections: View {
  let syncService: SyncService
  let machines: [LaneRecentlyDeletedMachine]
  let canRunLiveActions: Bool
  /// Changes when the list should read again: a pull to refresh, or a delete
  /// or restore elsewhere on the screen.
  let reloadToken: String
  let onRestored: () async -> Void

  /// Rows per machine id; a machine whose read fails keeps its last rows.
  @State private var entries: [String: [DeletedLaneSnapshot]]
  @State private var running: String?
  @State private var message: (text: String, isError: Bool)?
  @State private var pendingDrop: (machine: LaneRecentlyDeletedMachine, snapshot: DeletedLaneSnapshot)?

  init(
    syncService: SyncService,
    machines: [LaneRecentlyDeletedMachine],
    canRunLiveActions: Bool,
    reloadToken: String = "",
    initialEntries: [String: [DeletedLaneSnapshot]] = [:],
    onRestored: @escaping () async -> Void
  ) {
    self.syncService = syncService
    self.machines = machines
    self.canRunLiveActions = canRunLiveActions
    self.reloadToken = reloadToken
    self.onRestored = onRestored
    _entries = State(initialValue: initialEntries)
  }

  private var loadKey: String {
    machines.map { "\($0.id)|\($0.projectId ?? "")" }.joined(separator: ",") + "|" + reloadToken
  }

  var body: some View {
    Group {
      if let message {
        if message.isError {
          ADEFlatInlineNotice(message: message.text, tint: ADEColor.danger)
            .adeFlatRow(separator: .hidden)
        } else {
          Label(message.text, systemImage: "checkmark.circle.fill")
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .adeFlatRow(separator: .hidden)
        }
      }
      ForEach(machines) { machine in
        if let rows = entries[machine.id], !rows.isEmpty {
          Section {
            ForEach(rows) { snapshot in
              row(snapshot, machine: machine)
            }
          } header: {
            ADEFlatSectionHeader(
              machines.count > 1 ? "Recently deleted · \(machine.name)" : "Recently deleted",
              detail: "\(rows.count)"
            )
          }
        }
      }
    }
    .task(id: loadKey) { await load() }
    .confirmationDialog(
      "Drop this lane's saved work?",
      isPresented: Binding(get: { pendingDrop != nil }, set: { if !$0 { pendingDrop = nil } }),
      titleVisibility: .visible,
      presenting: pendingDrop
    ) { pending in
      Button("Drop", role: .destructive) {
        Task { await drop(pending.snapshot, machine: pending.machine) }
      }
      Button("Cancel", role: .cancel) {}
    } message: { pending in
      Text(pending.snapshot.isFreed
        ? "“\(pending.snapshot.laneName)” stays archived, but ADE will no longer be able to put back its uncommitted files."
        : "ADE will no longer be able to bring back “\(pending.snapshot.laneName)”.")
    }
  }

  private func row(_ snapshot: DeletedLaneSnapshot, machine: LaneRecentlyDeletedMachine) -> some View {
    let restoring = running == snapshot.id
    return HStack(alignment: .center, spacing: 12) {
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 30, height: 30)
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      VStack(alignment: .leading, spacing: 3) {
        Text(snapshot.laneName)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let branch = snapshot.branchName, !branch.isEmpty {
          Text(branch)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Text(deletedLaneMetaLine(snapshot))
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      Button {
        Task { await restore(snapshot, machine: machine) }
      } label: {
        if restoring {
          ProgressView().controlSize(.small)
        } else {
          Text(snapshot.isFreed ? "Put back" : "Restore")
        }
      }
      .buttonStyle(ADEKitButtonStyle(tone: .neutral))
      .disabled(running != nil || !canRunLiveActions)
      .accessibilityLabel(snapshot.isFreed ? "Put back \(snapshot.laneName)'s files" : "Restore \(snapshot.laneName)")
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .adeFlatRow(insets: EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 6))
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        pendingDrop = (machine, snapshot)
      } label: {
        Label("Drop", systemImage: "trash")
      }
      .disabled(running != nil || !canRunLiveActions)
    }
    .contextMenu {
      Button(role: .destructive) {
        pendingDrop = (machine, snapshot)
      } label: {
        Label("Drop saved work", systemImage: "trash")
      }
      .disabled(running != nil || !canRunLiveActions)
    }
  }

  @MainActor
  private func load() async {
    var next: [String: [DeletedLaneSnapshot]] = [:]
    await withTaskGroup(of: (String, [DeletedLaneSnapshot]?).self) { group in
      for machine in machines {
        group.addTask { @MainActor in
          // A machine on an older ADE has no saves to list; it simply shows none.
          let rows = try? await syncService.listDeletedLanes(
            targetProjectId: machine.projectId,
            targetProjectRootPath: machine.rootPath
          )
          return (machine.id, rows)
        }
      }
      for await (key, rows) in group {
        if let rows { next[key] = rows }
      }
    }
    guard !Task.isCancelled else { return }
    let current = Set(machines.map(\.id))
    entries = entries.filter { current.contains($0.key) }.merging(next) { _, fresh in fresh }
  }

  @MainActor
  private func restore(_ snapshot: DeletedLaneSnapshot, machine: LaneRecentlyDeletedMachine) async {
    guard running == nil else { return }
    running = snapshot.id
    defer { running = nil }
    do {
      let result = try await syncService.restoreDeletedLane(
        snapshot.id,
        targetProjectId: machine.projectId,
        targetProjectRootPath: machine.rootPath
      )
      if result.restoredUncommitted {
        ADEHaptics.success()
        entries[machine.id]?.removeAll { $0.id == snapshot.id }
        message = (snapshot.isFreed
          ? "\(snapshot.laneName) is restored on \(result.branchName), with its uncommitted files."
          : "\(snapshot.laneName) is back on \(result.branchName)\(snapshot.uncommitted ? ", with its uncommitted files" : "").", false)
      } else {
        ADEHaptics.warning()
        message = ("\(snapshot.laneName) is back on \(result.branchName), but its uncommitted files did not apply and stay saved: \(result.warning ?? "unknown error")", true)
      }
      await onRestored()
    } catch {
      ADEHaptics.error()
      message = ("Couldn’t restore \(snapshot.laneName): \(SyncUserFacingError.message(for: error))", true)
    }
  }

  @MainActor
  private func drop(_ snapshot: DeletedLaneSnapshot, machine: LaneRecentlyDeletedMachine) async {
    guard running == nil else { return }
    running = snapshot.id
    defer { running = nil }
    do {
      try await syncService.removeDeletedLane(
        snapshot.id,
        targetProjectId: machine.projectId,
        targetProjectRootPath: machine.rootPath
      )
      entries[machine.id]?.removeAll { $0.id == snapshot.id }
      message = nil
    } catch {
      ADEHaptics.error()
      message = ("Couldn’t drop that lane’s saved work: \(SyncUserFacingError.message(for: error))", true)
    }
  }
}

/// After a delete that kept work: "Kept X's uncommitted files", Restore.
struct LaneDeletionKeptNotice: View {
  let kept: LaneDeletionKept
  let canRunLiveActions: Bool
  let onRestore: () async -> Void
  let onDismiss: () -> Void
  @State private var restoring = false

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: "tray.and.arrow.down.fill")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .frame(width: 30, height: 30)
        .background(ADEColor.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      VStack(alignment: .leading, spacing: 2) {
        Text(kept.snapshot.laneName)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text("\(kept.snapshot.uncommitted ? "Uncommitted work" : "Unpushed commits") kept 30 days in Archived")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
      }
      Spacer(minLength: 6)
      Button {
        Task {
          restoring = true
          await onRestore()
          restoring = false
        }
      } label: {
        if restoring { ProgressView().controlSize(.small) } else { Text("Restore") }
      }
      .buttonStyle(ADEKitButtonStyle(tone: .neutral))
      .disabled(restoring || !canRunLiveActions)
      Button(action: onDismiss) {
        Image(systemName: "xmark")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 28, height: 28)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Dismiss")
    }
    .padding(12)
    .background(ADEKit.track.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}
