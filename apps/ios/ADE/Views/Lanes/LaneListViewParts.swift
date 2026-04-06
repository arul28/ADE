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
      guard let status = snapshot.autoRebaseStatus else { return false }
      return status.state != "autoRebased"
    }
  }

  var primaryLane: LaneSummary? {
    laneSnapshots.first(where: { $0.lane.laneType == "primary" })?.lane
  }

  var manageableVisibleLaneIds: [String] {
    filteredSnapshots
      .map(\.lane)
      .filter { $0.laneType != "primary" }
      .map(\.id)
  }

  var openLaneSnapshots: [LaneListSnapshot] {
    openLaneIds.compactMap { laneId in
      laneSnapshots.first(where: { $0.lane.id == laneId })
    }
  }

  var statusNotice: ADENoticeCard? {
    switch laneStatus.phase {
    case .disconnected:
      return ADENoticeCard(
        title: laneSnapshots.isEmpty ? "Host disconnected" : "Showing cached lanes",
        message: laneSnapshots.isEmpty
          ? (syncService.activeHostProfile == nil
            ? "Pair with a host to load the current lane graph."
            : "Reconnect to load the current lane graph from the host.")
          : (needsRepairing
            ? "Cached data shown. Re-pair to verify the lane graph."
            : "Cached data available. Reconnect to refresh."),
        icon: "bolt.horizontal.circle",
        tint: ADEColor.warning,
        actionTitle: syncService.activeHostProfile == nil ? (needsRepairing ? "Pair again" : "Pair with host") : "Reconnect",
        action: {
          if syncService.activeHostProfile == nil {
            syncService.settingsPresented = true
          } else {
            Task {
              await syncService.reconnectIfPossible()
              await reload(refreshRemote: true)
            }
          }
        }
      )
    case .hydrating:
      return ADENoticeCard(
        title: "Hydrating lane graph",
        message: "Pulling lane snapshots from the host.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.accent,
        actionTitle: nil,
        action: nil
      )
    case .syncingInitialData:
      return ADENoticeCard(
        title: "Syncing initial data",
        message: "Waiting for host to finish syncing before lane graph loads.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "Lane hydration failed",
        message: laneStatus.lastError ?? "Lane hydration did not complete.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      return nil
    }
  }

  var primaryBranchNotice: ADENoticeCard? {
    guard let primaryBranchError else { return nil }
    return ADENoticeCard(
      title: "Primary branch update failed",
      message: primaryBranchError,
      icon: "exclamationmark.triangle.fill",
      tint: ADEColor.danger,
      actionTitle: "Retry",
      action: {
        Task {
          await refreshPrimaryBranches(force: true)
        }
      }
    )
  }

  @MainActor
  func refreshPrimaryBranches(force: Bool = false) async {
    guard let primaryLane else {
      primaryBranches = []
      primaryBranchLaneId = nil
      primaryBranchError = nil
      return
    }
    if !force, primaryBranchLaneId == primaryLane.id, !primaryBranches.isEmpty {
      return
    }
    do {
      primaryBranches = try await syncService.listBranches(laneId: primaryLane.id)
      primaryBranchLaneId = primaryLane.id
      primaryBranchError = nil
    } catch {
      primaryBranches = []
      primaryBranchLaneId = primaryLane.id
      primaryBranchError = error.localizedDescription
    }
  }

  @ViewBuilder
  var openLanesTray: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Label("Open lanes", systemImage: "square.stack.3d.up.fill")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
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
        HStack(spacing: 8) {
          ForEach(openLaneSnapshots) { snapshot in
            NavigationLink {
              LaneDetailScreen(
                laneId: snapshot.lane.id,
                initialSnapshot: snapshot,
                allLaneSnapshots: laneSnapshots,
                onRefreshRoot: { await reload(refreshRemote: true) }
              )
            } label: {
              LaneOpenChip(snapshot: snapshot, isPinned: pinnedLaneIds.contains(snapshot.lane.id))
            }
            .buttonStyle(.plain)
            .contextMenu {
              Button("Manage lane") {
                detailSheetTarget = LaneDetailSheetTarget(
                  laneId: snapshot.lane.id,
                  snapshot: snapshot,
                  initialSection: .manage
                )
              }
              Button(pinnedLaneIds.contains(snapshot.lane.id) ? "Unpin" : "Pin") {
                togglePin(snapshot.lane.id)
              }
              Button("Remove from open lanes") {
                closeLaneChip(snapshot.lane.id)
              }
              Button("Close others") {
                openLaneIds = [snapshot.lane.id]
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
    VStack(spacing: 12) {
      ForEach(visibleSuggestions.prefix(3)) { snapshot in
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
          Button("Rebase") {
            Task {
              do {
                try await syncService.startLaneRebase(laneId: snapshot.lane.id)
                await reload(refreshRemote: true)
              } catch {
                errorMessage = error.localizedDescription
              }
            }
          }
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
          .disabled(!canRunLiveActions)
          Menu {
            Button("Defer") {
              Task {
                do {
                  try await syncService.deferRebaseSuggestion(laneId: snapshot.lane.id)
                  await reload(refreshRemote: true)
                } catch {
                  errorMessage = error.localizedDescription
                }
              }
            }
            Button("Dismiss") {
              Task {
                do {
                  try await syncService.dismissRebaseSuggestion(laneId: snapshot.lane.id)
                  await reload(refreshRemote: true)
                } catch {
                  errorMessage = error.localizedDescription
                }
              }
            }
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

      ForEach(visibleAutoRebaseAttention.prefix(3)) { snapshot in
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

  @ViewBuilder
  var laneList: some View {
    if filteredSnapshots.isEmpty {
      ADEEmptyStateView(
        symbol: "square.stack.3d.up.slash",
        title: laneListEmptyStateTitle(scope: scope),
        message: laneListEmptyStateMessage(scope: scope, searchText: searchText, hasFilters: scope != .active || runtimeFilter != .all)
      )
      .padding(.top, 40)
    } else {
      ForEach(filteredSnapshots) { snapshot in
        NavigationLink {
          LaneDetailScreen(
            laneId: snapshot.lane.id,
            initialSnapshot: snapshot,
            allLaneSnapshots: laneSnapshots,
            onRefreshRoot: { await reload(refreshRemote: true) }
          )
        } label: {
          LaneListRow(
            snapshot: snapshot,
            isPinned: pinnedLaneIds.contains(snapshot.lane.id),
            isOpen: openLaneIds.contains(snapshot.lane.id)
          )
          .equatable()
        }
        .buttonStyle(ADEScaleButtonStyle())
        .contextMenu {
          Button("Manage lane") {
            detailSheetTarget = LaneDetailSheetTarget(
              laneId: snapshot.lane.id,
              snapshot: snapshot,
              initialSection: .manage
            )
          }
          Button(openLaneIds.contains(snapshot.lane.id) ? "Remove from open lanes" : "Add to open lanes") {
            toggleOpenLane(snapshot.lane.id)
          }
          Button(pinnedLaneIds.contains(snapshot.lane.id) ? "Unpin" : "Pin") {
            togglePin(snapshot.lane.id)
          }
          Button("Close others") {
            openLaneIds = [snapshot.lane.id]
          }
          Button("Select all visible") {
            batchManageLaneIds = manageableVisibleLaneIds
            batchManagePresented = !manageableVisibleLaneIds.isEmpty
          }
          if manageableVisibleLaneIds.count > 1 {
            Button("Manage \(manageableVisibleLaneIds.count) visible lanes") {
              batchManageLaneIds = manageableVisibleLaneIds
              batchManagePresented = true
            }
          }
          if snapshot.lane.archivedAt == nil && snapshot.lane.laneType != "primary" {
            Button("Archive", role: .destructive) {
              Task {
                do {
                  try await syncService.archiveLane(snapshot.lane.id)
                  await reload(refreshRemote: true)
                } catch {
                  errorMessage = error.localizedDescription
                }
              }
            }
          } else if snapshot.lane.archivedAt != nil {
            Button("Restore") {
              Task {
                do {
                  try await syncService.unarchiveLane(snapshot.lane.id)
                  await reload(refreshRemote: true)
                } catch {
                  errorMessage = error.localizedDescription
                }
              }
            }
          }
          Button("Copy path") {
            UIPasteboard.general.string = snapshot.lane.worktreePath
          }
          if snapshot.adoptableAttached {
            Button("Move to ADE-managed worktree") {
              Task {
                do {
                  _ = try await syncService.adoptAttachedLane(snapshot.lane.id)
                  await reload(refreshRemote: true)
                } catch {
                  errorMessage = error.localizedDescription
                }
              }
            }
          }
        }
      }
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
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  var canRunLiveActions: Bool {
    syncService.connectionState == .connected || syncService.connectionState == .syncing
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

  func closeLaneChip(_ laneId: String) {
    if pinnedLaneIds.contains(laneId) {
      return
    }
    openLaneIds.removeAll { $0 == laneId }
  }

  func togglePin(_ laneId: String) {
    if pinnedLaneIds.contains(laneId) {
      pinnedLaneIds.remove(laneId)
    } else {
      pinnedLaneIds.insert(laneId)
      if !openLaneIds.contains(laneId) {
        openLaneIds.insert(laneId, at: 0)
      }
    }
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
