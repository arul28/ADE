import SwiftUI
import UIKit

/// Which machines' lanes the Lanes tab shows.
enum LaneMachineFilter: Equatable {
  case all
  case focused
  case machine(String)
}

struct LaneListPresentation: Equatable {
  var filteredSnapshots: [LaneListSnapshot]
  var stackOrderedSnapshots: [LaneListSnapshot]
  var lanePrTagsByLaneId: [String: LanePrTag]

  static let empty = LaneListPresentation(
    filteredSnapshots: [],
    stackOrderedSnapshots: [],
    lanePrTagsByLaneId: [:]
  )
}

extension LanesTabView {
  var filteredSnapshots: [LaneListSnapshot] {
    laneListPresentation.filteredSnapshots
  }

  var normalVisibleSnapshots: [LaneListSnapshot] {
    filteredSnapshots
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
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Label("OPEN LANES", systemImage: "square.stack.3d.up.fill")
          .font(.caption.weight(.semibold))
          .tracking(0.6)
          .foregroundStyle(ADEColor.textMuted)
        Spacer()
        Button {
          withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
            openLaneIds = openLaneIds.filter { pinnedLaneIds.contains($0) }
          }
        } label: {
          Text("Clear")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textMuted)
        }
        .accessibilityLabel("Clear open lanes")
      }
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 10) {
          ForEach(openLaneSnapshots) { snapshot in
            NavigationLink {
              LaneDetailScreen(
                laneId: snapshot.lane.id,
                initialSnapshot: snapshot,
                allLaneSnapshots: laneSnapshots,
                transitionNamespace: nil,
                onRefreshRoot: { await reload(refreshRemote: true) }
              )
            } label: {
              LaneOpenChip(snapshot: snapshot, isPinned: pinnedLaneIds.contains(snapshot.lane.id))
            }
            .buttonStyle(.plain)
            .contextMenu {
              Button {
                detailSheetTarget = LaneDetailSheetTarget(
                  laneId: snapshot.lane.id,
                  snapshot: snapshot,
                  initialSection: .git
                )
              } label: {
                Label("Manage lane", systemImage: "slider.horizontal.3")
              }
              Button {
                togglePin(snapshot.lane.id)
              } label: {
                let pinned = pinnedLaneIds.contains(snapshot.lane.id)
                Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash.fill" : "pin.fill")
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
    .adeGlassCard(cornerRadius: 14, padding: 12)
  }

  var stackOrderedSnapshots: [LaneListSnapshot] {
    laneListPresentation.stackOrderedSnapshots
  }

  var stickyPrimarySnapshot: LaneListSnapshot? {
    stackOrderedSnapshots.first(where: { $0.lane.laneType == "primary" })
  }

  var treeSnapshots: [LaneListSnapshot] {
    stackOrderedSnapshots.filter { $0.lane.laneType != "primary" }
  }

  var normalStickyPrimarySnapshot: LaneListSnapshot? {
    stickyPrimarySnapshot
  }

  var normalTreeSnapshots: [LaneListSnapshot] {
    treeSnapshots
  }

  var lanePrTagsByLaneId: [String: LanePrTag] {
    laneListPresentation.lanePrTagsByLaneId
  }

  @MainActor
  func refreshLaneListPresentation() {
    let filtered = laneListFilteredSnapshots(
      visibleLaneSnapshots,
      scope: scope,
      runtimeFilter: runtimeFilter,
      searchText: searchText,
      pinnedLaneIds: pinnedLaneIds
    )
    let next = LaneListPresentation(
      filteredSnapshots: filtered,
      stackOrderedSnapshots: laneStackGraphOrder(filtered),
      lanePrTagsByLaneId: lanePrTagByLaneId(
        snapshots: laneSnapshots,
        pullRequests: pullRequests,
        githubPrs: syncService.laneGithubPrItems
      )
    )
    guard next != laneListPresentation else { return }
    laneListPresentation = next
  }

  /// The focused machine's name for its chip and filter.
  var focusedMachineName: String {
    syncService.hostName ?? syncService.activeHostProfile?.hostName ?? "This machine"
  }

  var laneMachineChips: LaneMachineChips {
    guard !remoteLanes.machines.isEmpty else { return .none }
    return LaneMachineChips(
      focused: LaneMachineChip(name: focusedMachineName, isLive: true),
      byMachineKey: Dictionary(
        remoteLanes.machines.map { ($0.machineKey, LaneMachineChip(name: $0.name, isLive: $0.isLive)) },
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

  /// The other machines the filter shows, each with its rows filtered the
  /// same way as the focused list and in stack order.
  var visibleRemoteMachineLanes: [(machine: LaneRemoteMachinesModel.MachineLanes, snapshots: [LaneListSnapshot])] {
    remoteLanes.machines.compactMap { machine in
      switch machineFilter {
      case .focused: return nil
      case .machine(let key) where key != machine.machineKey: return nil
      default: break
      }
      let filtered = laneListFilteredSnapshots(
        machine.snapshots,
        scope: scope,
        runtimeFilter: runtimeFilter,
        searchText: searchText,
        pinnedLaneIds: pinnedLaneIds
      )
      guard !filtered.isEmpty else { return nil }
      return (machine, laneStackGraphOrder(filtered))
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
          symbol: settingsMachineSymbol(forName: focusedMachineName),
          liveDot: true,
          selected: machineFilter == .focused
        ) {
          machineFilter = machineFilter == .focused ? .all : .focused
        }
        ForEach(remoteLanes.machines) { machine in
          LaneMachineFilterChip(
            title: machine.name,
            symbol: settingsMachineSymbol(forName: machine.name),
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

  @ViewBuilder
  var remoteMachineLaneSections: some View {
    ForEach(visibleRemoteMachineLanes, id: \.machine.machineKey) { entry in
      LaneTreeView(
        snapshots: entry.snapshots,
        pinnedLaneIds: pinnedLaneIds,
        openLaneIds: openLaneIds,
        allLaneSnapshots: entry.machine.snapshots,
        lanePrTagsByLaneId: [:],
        transitionNamespace: transitionNamespace,
        selectedLaneId: selectedLaneTransitionId,
        onRefreshRoot: { await remoteLanes.refresh(sync: syncService, fleet: machineFleet) },
        onContextMenu: { snapshot in AnyView(laneContextMenu(snapshot: snapshot)) },
        onTogglePin: { laneId in togglePin(laneId) },
        onSelectLane: { laneId in selectedLaneTransitionId = laneId },
        machineChips: laneMachineChips
      )
    }
  }

  @ViewBuilder
  var laneList: some View {
    if !showsFocusedMachineLanes {
      VStack(spacing: 10) {
        laneListHeader
        remoteMachineLaneSections
      }
    } else if laneSnapshots.isEmpty && remoteLanes.machines.isEmpty {
      if let emptyStatePresentation {
        emptyStateCard(emptyStatePresentation)
          .padding(.top, 24)
      } else if !showsLaneLoadingSkeletons {
        ADEEmptyStateView(
          symbol: "plus.circle.dashed",
          title: "No lanes yet",
          message: "Tap + to create your first lane."
        )
        .padding(.top, 40)
      }
    } else if filteredSnapshots.isEmpty {
      ADEEmptyStateView(
        symbol: "square.stack.3d.up.slash",
        title: laneListEmptyStateTitle(scope: scope),
        message: laneListEmptyStateMessage(scope: scope, searchText: searchText, hasFilters: scope != .active || runtimeFilter != .all)
      )
      .padding(.top, 40)
    } else {
      if normalVisibleSnapshots.isEmpty {
        EmptyView()
      } else {
        VStack(spacing: 10) {
          laneListHeader

          if let primarySnapshot = normalStickyPrimarySnapshot {
            NavigationLink {
              LaneDetailScreen(
                laneId: primarySnapshot.lane.id,
                initialSnapshot: primarySnapshot,
                allLaneSnapshots: laneSnapshots,
                transitionNamespace: transitionNamespace,
                onRefreshRoot: { await reload(refreshRemote: true) }
              )
            } label: {
              LaneStackCard(
                snapshot: primarySnapshot,
                isPinned: pinnedLaneIds.contains(primarySnapshot.lane.id),
                isOpen: openLaneIds.contains(primarySnapshot.lane.id),
                depth: 0,
                pullRequest: lanePrTagsByLaneId[primarySnapshot.lane.id],
                transitionNamespace: transitionNamespace,
                isSelectedTransitionSource: selectedLaneTransitionId == primarySnapshot.lane.id,
                machine: laneMachineChips.chip(forLaneId: primarySnapshot.lane.id)
              )
              .equatable()
            }
            .simultaneousGesture(TapGesture().onEnded {
              selectedLaneTransitionId = primarySnapshot.lane.id
            })
            .buttonStyle(ADEScaleButtonStyle())
            .contextMenu { laneContextMenu(snapshot: primarySnapshot) } preview: {
              LanePeekPreview(
                snapshot: primarySnapshot,
                pullRequest: lanePrTagsByLaneId[primarySnapshot.lane.id]
              )
            }
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
              Button {
                togglePin(primarySnapshot.lane.id)
              } label: {
                Label(pinnedLaneIds.contains(primarySnapshot.lane.id) ? "Unpin" : "Pin",
                      systemImage: pinnedLaneIds.contains(primarySnapshot.lane.id) ? "pin.slash.fill" : "pin.fill")
              }
              .tint(ADEColor.accent)
            }
          }

          if !normalTreeSnapshots.isEmpty {
            LaneTreeView(
              snapshots: normalTreeSnapshots,
              pinnedLaneIds: pinnedLaneIds,
              openLaneIds: openLaneIds,
              allLaneSnapshots: laneSnapshots,
              lanePrTagsByLaneId: lanePrTagsByLaneId,
              transitionNamespace: transitionNamespace,
              selectedLaneId: selectedLaneTransitionId,
              onRefreshRoot: { await reload(refreshRemote: true) },
              onContextMenu: { snapshot in AnyView(laneContextMenu(snapshot: snapshot)) },
              onTogglePin: { laneId in togglePin(laneId) },
              onSelectLane: { laneId in selectedLaneTransitionId = laneId },
              machineChips: laneMachineChips
            )
          }
          remoteMachineLaneSections
        }
      }
    }
  }

  var laneListHeader: some View {
    Text("LANES")
      .font(.caption.weight(.semibold))
      .tracking(0.6)
      .foregroundStyle(ADEColor.textMuted)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 2)
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
    Button {
      detailSheetTarget = LaneDetailSheetTarget(
        laneId: snapshot.lane.id,
        snapshot: snapshot,
        initialSection: .git
      )
    } label: {
      Label("Manage lane", systemImage: "slider.horizontal.3")
    }
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
      let pinned = pinnedLaneIds.contains(snapshot.lane.id)
      Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash.fill" : "pin.fill")
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
      if snapshot.lane.color != nil {
        Divider()
        Button(role: .destructive) {
          Task { await applyLaneColor(nil, to: snapshot.lane.id) }
        } label: {
          Label("Clear color", systemImage: "xmark.circle")
        }
        .disabled(!canRunLiveActions)
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
    if snapshot.lane.archivedAt == nil && snapshot.lane.laneType != "primary" {
      Button(role: .destructive) {
        Task {
          do {
            try await syncService.archiveLane(snapshot.lane.id)
            await reload(refreshRemote: true)
          } catch {
            ADEHaptics.error()
            errorMessage = error.localizedDescription
          }
        }
      } label: {
        Label("Archive", systemImage: "archivebox")
      }
      .disabled(!canRunLiveActions)
    } else if snapshot.lane.archivedAt != nil {
      Button {
        Task {
          do {
            try await syncService.unarchiveLane(snapshot.lane.id)
            await reload(refreshRemote: true)
          } catch {
            ADEHaptics.error()
            errorMessage = error.localizedDescription
          }
        }
      } label: {
        Label("Restore", systemImage: "tray.and.arrow.up")
      }
      .disabled(!canRunLiveActions)
    }
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
      await reload(refreshRemote: false)
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func reload(refreshRemote: Bool = false, includeDecorations: Bool = true) async {
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
      let visibleIds = Set(loadedSnapshots.map(\.lane.id))
      let nextOpenLaneIds = openLaneIds.filter { visibleIds.contains($0) }
      if nextOpenLaneIds != openLaneIds {
        openLaneIds = nextOpenLaneIds
      }
      let nextPinnedLaneIds = Set(pinnedLaneIds.filter { visibleIds.contains($0) })
      if nextPinnedLaneIds != pinnedLaneIds {
        pinnedLaneIds = nextPinnedLaneIds
      }
      if let selectedLaneTransitionId, !visibleIds.contains(selectedLaneTransitionId) {
        self.selectedLaneTransitionId = nil
      }
      if errorMessage != nil {
        errorMessage = nil
      }
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
    try? await Task.sleep(for: .milliseconds(650))
    guard syncService.requestedLaneNavigation?.id == request.id else { return }

    var snapshot: LaneListSnapshot?
    if isWorkRemoteLaneId(request.laneId) {
      // A lane of another machine (from the PRs tab or a link): its row comes
      // from that machine, read again once when this phone has not yet.
      let remoteSnapshot = { remoteLanes.machines.lazy.flatMap(\.snapshots).first { $0.lane.id == request.laneId } }
      snapshot = remoteSnapshot()
      if snapshot == nil {
        await remoteLanes.refresh(sync: syncService, fleet: machineFleet)
        snapshot = remoteSnapshot()
      }
    } else {
      snapshot = laneSnapshots.first(where: { $0.lane.id == request.laneId })
      if snapshot == nil {
        await reload(refreshRemote: canRunLiveActions)
        snapshot = laneSnapshots.first(where: { $0.lane.id == request.laneId })
      }
    }

    guard let resolvedSnapshot = snapshot else {
      errorMessage = "The requested lane is not cached on this phone yet. Refresh Lanes and try again."
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
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(selected ? ADEColor.accent : ADEColor.textSecondary)
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textSecondary)
          .lineLimit(1)
        if let liveDot {
          Circle()
            .fill(liveDot ? ADEColor.success : ADEColor.textMuted.opacity(0.6))
            .frame(width: 6, height: 6)
        }
      }
      .padding(.horizontal, 11)
      .frame(height: 32)
      .background(
        Capsule(style: .continuous)
          .fill(selected ? ADEColor.accent.opacity(0.16) : ADEColor.surfaceBackground.opacity(0.5))
      )
      .glassEffect(in: .capsule)
      .overlay(
        Capsule(style: .continuous)
          .stroke(selected ? ADEColor.accent.opacity(0.45) : ADEColor.glassBorder, lineWidth: 0.7)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel(liveDot == false ? "\(title), not live" : title)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}
