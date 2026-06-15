import SwiftUI
import UIKit

extension LanesTabView {
  var filteredSnapshots: [LaneListSnapshot] {
    laneListFilteredSnapshots(
      laneSnapshots,
      scope: scope,
      runtimeFilter: runtimeFilter,
      searchText: searchText,
      pinnedLaneIds: pinnedLaneIds
    )
  }

  var normalVisibleSnapshots: [LaneListSnapshot] {
    filteredSnapshots
  }

  var primaryLane: LaneSummary? {
    laneSnapshots.first(where: { $0.lane.laneType == "primary" })?.lane
  }

  var manageableVisibleLaneIds: [String] {
    filteredSnapshots
      .map(\.lane)
      .filter { $0.laneType != "primary" && $0.archivedAt == nil }
      .map(\.id)
  }

  var openLaneSnapshots: [LaneListSnapshot] {
    openLaneIds.compactMap { laneId in
      laneSnapshots.first(where: { $0.lane.id == laneId })
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
    laneStackGraphOrder(filteredSnapshots)
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

  var lanePrTagsByLaneId: [String: PullRequestListItem] {
    lanePrTagByLaneId(snapshots: laneSnapshots, pullRequests: pullRequests)
  }

  @ViewBuilder
  var laneList: some View {
    if laneSnapshots.isEmpty {
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
          Text("LANES")
            .font(.caption.weight(.semibold))
            .tracking(0.6)
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 2)

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
                isSelectedTransitionSource: selectedLaneTransitionId == primarySnapshot.lane.id
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
              onSelectLane: { laneId in selectedLaneTransitionId = laneId }
            )
          }
        }
      }
    }
  }

  @ViewBuilder
  func laneContextMenu(snapshot: LaneListSnapshot) -> some View {
    Button {
      detailSheetTarget = LaneDetailSheetTarget(
        laneId: snapshot.lane.id,
        snapshot: snapshot,
        initialSection: .git
      )
    } label: {
      Label("Manage lane", systemImage: "slider.horizontal.3")
    }
    if snapshot.lane.laneType == "primary", !primaryBranches.isEmpty {
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
    if snapshot.adoptableAttached {
      Button {
        Task {
          do {
            _ = try await syncService.adoptAttachedLane(snapshot.lane.id)
            await reload(refreshRemote: true)
          } catch {
            ADEHaptics.error()
            errorMessage = error.localizedDescription
          }
        }
      } label: {
        Label("Move to ADE-managed worktree", systemImage: "folder.badge.gearshape")
      }
      .disabled(!canRunLiveActions)
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
  func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try await syncService.refreshLaneSnapshots()
      }
      let loadedSnapshots = try await syncService.fetchLaneListSnapshots(includeArchived: true)
      let loadedPullRequests = try await syncService.fetchPullRequestListItems()
      if laneSnapshots != loadedSnapshots {
        laneSnapshots = loadedSnapshots
      }
      if pullRequests != loadedPullRequests {
        pullRequests = loadedPullRequests
      }
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

    var snapshot = laneSnapshots.first(where: { $0.lane.id == request.laneId })
    if snapshot == nil {
      await reload(refreshRemote: canRunLiveActions)
      snapshot = laneSnapshots.first(where: { $0.lane.id == request.laneId })
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
    await reload(refreshRemote: true)
    if errorMessage == nil {
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
        refreshFeedbackToken += 1
      }
    }
  }
}
