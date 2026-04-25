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

  var visibleSuggestions: [LaneListSnapshot] {
    filteredSnapshots.filter { $0.rebaseSuggestion != nil }
  }

  var visibleAutoRebaseAttention: [LaneListSnapshot] {
    filteredSnapshots.filter { snapshot in
      guard snapshot.rebaseSuggestion == nil else { return false }
      guard let status = snapshot.autoRebaseStatus else { return false }
      return status.state != "autoRebased"
    }
  }

  var visibleAttentionLaneIds: Set<String> {
    Set((visibleSuggestions + visibleAutoRebaseAttention).map(\.lane.id))
  }

  var normalVisibleSnapshots: [LaneListSnapshot] {
    filteredSnapshots.filter { !visibleAttentionLaneIds.contains($0.lane.id) }
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

  @ViewBuilder
  var attentionSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("NEEDS REVIEW")
        .font(.caption.weight(.semibold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)
        .padding(.horizontal, 2)

      ForEach(visibleSuggestions) { snapshot in
        HStack(spacing: 12) {
          Image(systemName: "arrow.triangle.2.circlepath")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.warning)
          VStack(alignment: .leading, spacing: 2) {
            Text(snapshot.lane.name)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("Behind parent by \(snapshot.rebaseSuggestion?.behindCount ?? 0) commit(s)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          Spacer(minLength: 8)
          Button("Review") {
            detailSheetTarget = LaneDetailSheetTarget(
              laneId: snapshot.lane.id,
              snapshot: snapshot,
              initialSection: .git
            )
          }
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
          Menu {
            Button("Defer") {
              Task {
                do {
                  try await syncService.deferRebaseSuggestion(laneId: snapshot.lane.id)
                  await reload(refreshRemote: true)
                } catch {
                  ADEHaptics.error()
                  errorMessage = error.localizedDescription
                }
              }
            }
            .disabled(!canRunLiveActions)
            Button("Dismiss") {
              Task {
                do {
                  try await syncService.dismissRebaseSuggestion(laneId: snapshot.lane.id)
                  await reload(refreshRemote: true)
                } catch {
                  ADEHaptics.error()
                  errorMessage = error.localizedDescription
                }
              }
            }
            .disabled(!canRunLiveActions)
          } label: {
            Image(systemName: "ellipsis.circle")
              .font(.caption)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .padding(12)
        .background(ADEColor.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(ADEColor.warning.opacity(0.2), lineWidth: 0.5)
        )
      }

      ForEach(visibleAutoRebaseAttention) { snapshot in
        HStack(spacing: 12) {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(snapshot.autoRebaseStatus?.state == "rebaseConflict" ? ADEColor.danger : ADEColor.warning)
          VStack(alignment: .leading, spacing: 2) {
            Text(snapshot.lane.name)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text(snapshot.autoRebaseStatus?.message ?? "Manual follow-up required")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(2)
          }
          Spacer(minLength: 8)
          Button("Open") {
            detailSheetTarget = LaneDetailSheetTarget(
              laneId: snapshot.lane.id,
              snapshot: snapshot,
              initialSection: .git
            )
          }
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
        }
        .padding(12)
        .background(ADEColor.danger.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(ADEColor.danger.opacity(0.15), lineWidth: 0.5)
        )
      }
    }
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
    guard let stickyPrimarySnapshot, !visibleAttentionLaneIds.contains(stickyPrimarySnapshot.lane.id) else {
      return nil
    }
    return stickyPrimarySnapshot
  }

  var normalTreeSnapshots: [LaneListSnapshot] {
    treeSnapshots.filter { !visibleAttentionLaneIds.contains($0.lane.id) }
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
              LanePeekPreview(snapshot: primarySnapshot)
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
  func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try await syncService.refreshLaneSnapshots()
      }
      let loadedSnapshots = try await syncService.fetchLaneListSnapshots(includeArchived: true)
      if laneSnapshots != loadedSnapshots {
        laneSnapshots = loadedSnapshots
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

    var snapshot = laneSnapshots.first(where: { $0.lane.id == request.laneId })
    if snapshot == nil {
      await reload(refreshRemote: canRunLiveActions)
      snapshot = laneSnapshots.first(where: { $0.lane.id == request.laneId })
    }

    guard let snapshot else {
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
      snapshot: snapshot,
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
