import SwiftUI
import UIKit

// MARK: - Enums

private enum LaneListScope: String, CaseIterable, Identifiable {
  case active
  case archived
  case all

  var id: String { rawValue }

  var title: String {
    switch self {
    case .active: return "Active"
    case .archived: return "Archived"
    case .all: return "All"
    }
  }
}

private enum LaneRuntimeFilter: String, CaseIterable, Identifiable {
  case all
  case running
  case awaitingInput = "awaiting-input"
  case ended

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .running: return "Running"
    case .awaitingInput: return "Awaiting"
    case .ended: return "Ended"
    }
  }

  var symbol: String {
    switch self {
    case .all: return "line.3.horizontal.decrease.circle"
    case .running: return "waveform.path.ecg"
    case .awaitingInput: return "exclamationmark.bubble.fill"
    case .ended: return "stop.circle.fill"
    }
  }
}

private enum LaneDetailSection: String, CaseIterable, Identifiable {
  case git
  case work
  case overview
  case manage

  var id: String { rawValue }

  var title: String {
    rawValue.capitalized
  }

  var symbol: String {
    switch self {
    case .overview: return "square.grid.2x2"
    case .git: return "arrow.triangle.branch"
    case .work: return "terminal"
    case .manage: return "slider.horizontal.3"
    }
  }
}

private enum LaneDeleteMode: String, CaseIterable, Identifiable {
  case worktree
  case localBranch = "local_branch"
  case remoteBranch = "remote_branch"

  var id: String { rawValue }

  var title: String {
    switch self {
    case .worktree: return "Worktree only"
    case .localBranch: return "Worktree + local"
    case .remoteBranch: return "Worktree + local + remote"
    }
  }
}

// MARK: - Lanes tab

struct LanesTabView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService

  @State private var laneSnapshots: [LaneListSnapshot] = []
  @State private var errorMessage: String?
  @State private var searchText = ""
  @State private var scope: LaneListScope = .active
  @State private var runtimeFilter: LaneRuntimeFilter = .all
  @State private var createPresented = false
  @State private var attachPresented = false
  @State private var openLaneIds: [String] = []
  @State private var pinnedLaneIds = Set<String>()
  @State private var primaryBranches: [GitBranchSummary] = []
  @State private var primaryBranchError: String?
  @State private var detailSheetTarget: LaneDetailSheetTarget?
  @State private var batchManageLaneIds: [String] = []
  @State private var batchManagePresented = false
  @State private var showFilters = false
  @State private var refreshFeedbackToken = 0

  private var laneStatus: SyncDomainStatus {
    syncService.status(for: .lanes)
  }

  private var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !laneSnapshots.isEmpty
  }

  private var filteredSnapshots: [LaneListSnapshot] {
    laneSnapshots
      .filter { snapshot in
        switch scope {
        case .active:
          return snapshot.lane.archivedAt == nil
        case .archived:
          return snapshot.lane.archivedAt != nil
        case .all:
          return true
        }
      }
      .filter { snapshot in
        runtimeFilter == .all || snapshot.runtime.bucket == runtimeFilter.rawValue
      }
      .filter { snapshot in
        laneMatchesSearch(snapshot: snapshot, isPinned: pinnedLaneIds.contains(snapshot.lane.id), query: searchText)
      }
      .sorted { lhs, rhs in
        if lhs.lane.laneType == "primary" && rhs.lane.laneType != "primary" { return true }
        if lhs.lane.laneType != "primary" && rhs.lane.laneType == "primary" { return false }
        return lhs.lane.createdAt > rhs.lane.createdAt
      }
  }

  private var visibleSuggestions: [LaneListSnapshot] {
    filteredSnapshots.filter { $0.rebaseSuggestion != nil }
  }

  private var visibleAutoRebaseAttention: [LaneListSnapshot] {
    filteredSnapshots.filter { snapshot in
      guard let status = snapshot.autoRebaseStatus else { return false }
      return status.state != "autoRebased"
    }
  }

  private var primaryLane: LaneSummary? {
    laneSnapshots.first(where: { $0.lane.laneType == "primary" })?.lane
  }

  private var manageableVisibleLaneIds: [String] {
    filteredSnapshots
      .map(\.lane)
      .filter { $0.laneType != "primary" }
      .map(\.id)
  }

  private var activeLaneCount: Int {
    laneSnapshots.filter { $0.lane.archivedAt == nil }.count
  }

  private var archivedLaneCount: Int {
    laneSnapshots.filter { $0.lane.archivedAt != nil }.count
  }

  private var openLaneSnapshots: [LaneListSnapshot] {
    openLaneIds.compactMap { laneId in
      laneSnapshots.first(where: { $0.lane.id == laneId })
    }
  }

  private var manageableOpenLaneIds: [String] {
    openLaneSnapshots
      .map(\.lane)
      .filter { $0.laneType != "primary" }
      .map(\.id)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 14) {
          // Connection status
          if let notice = statusNotice {
            notice
              .transition(.asymmetric(
                insertion: .move(edge: .top).combined(with: .opacity),
                removal: .opacity
              ))
          }

          if let errorMessage, laneStatus.phase == .ready {
            ADENoticeCard(
              title: "Lane view error",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .transition(.opacity)
          }

          if laneStatus.phase == .hydrating || laneStatus.phase == .syncingInitialData {
            ADECardSkeleton(rows: 4)
            ADECardSkeleton(rows: 3)
          }

          // Inline filter bar
          filterBar

          // Open lanes tray
          if !openLaneSnapshots.isEmpty {
            openLanesTray
              .transition(.move(edge: .top).combined(with: .opacity))
          }

          // Attention banners
          if !visibleSuggestions.isEmpty || !visibleAutoRebaseAttention.isEmpty {
            attentionSection
              .transition(.move(edge: .top).combined(with: .opacity))
          }

          // Lane list
          laneList
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .animation(.smooth, value: filteredSnapshots.count)
        .animation(.smooth, value: openLaneSnapshots.count)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .searchable(text: $searchText, prompt: "Filter by lane, branch, is:dirty...")
      .navigationTitle("Lanes")
      .toolbar {
        ToolbarItemGroup(placement: .topBarTrailing) {
          Menu {
            Section("Scope") {
              ForEach(LaneListScope.allCases) { option in
                Button {
                  scope = option
                } label: {
                  Label(
                    "\(option.title) (\(option == .active ? activeLaneCount : option == .archived ? archivedLaneCount : laneSnapshots.count))",
                    systemImage: scope == option ? "checkmark.circle.fill" : "circle"
                  )
                }
              }
            }

            Section("Runtime") {
              ForEach(LaneRuntimeFilter.allCases) { filter in
                Button {
                  runtimeFilter = filter
                } label: {
                  Label(
                    "\(filter.title) (\(count(for: filter)))",
                    systemImage: runtimeFilter == filter ? "checkmark.circle.fill" : "circle"
                  )
                }
              }
            }

            if manageableVisibleLaneIds.count > 1 {
              Section {
                Button {
                  batchManageLaneIds = manageableVisibleLaneIds
                  batchManagePresented = true
                } label: {
                  Label("Manage visible lanes", systemImage: "slider.horizontal.3")
                }
              }
            }

            if let primaryLane {
              Section("Primary branch") {
                ForEach(primaryBranches) { branch in
                  Button(branch.name) {
                    Task {
                      do {
                        try await syncService.checkoutPrimaryBranch(laneId: primaryLane.id, branchName: branch.name)
                        try await syncService.refreshLaneSnapshots()
                        await reload()
                      } catch {
                        primaryBranchError = error.localizedDescription
                      }
                    }
                  }
                }
              }
            }
          } label: {
            Image(systemName: "line.3.horizontal.decrease.circle")
              .symbolVariant(scope != .active || runtimeFilter != .all ? .fill : .none)
          }
          .accessibilityLabel("Lane filters")

          Menu {
            Button {
              createPresented = true
            } label: {
              Label("New lane", systemImage: "plus.square")
            }
            Button {
              attachPresented = true
            } label: {
              Label("Attach worktree", systemImage: "link")
            }
          } label: {
            Image(systemName: "plus.circle.fill")
              .symbolRenderingMode(.hierarchical)
          }
          .accessibilityLabel("Create or attach lane")
        }
      }
      .refreshable {
        await refreshFromPullGesture()
      }
      .sensoryFeedback(.success, trigger: laneSnapshots.count)
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task {
        await reload(refreshRemote: true)
      }
      .task(id: syncService.localStateRevision) {
        await reload()
      }
      .sheet(isPresented: $createPresented) {
        LaneCreateSheet(primaryLane: primaryLane, lanes: laneSnapshots.map(\.lane)) { createdLaneId in
          createPresented = false
          if !openLaneIds.contains(createdLaneId) {
            openLaneIds.insert(createdLaneId, at: 0)
          }
          await reload(refreshRemote: true)
        }
      }
      .sheet(isPresented: $attachPresented) {
        LaneAttachSheet { attachedLaneId in
          attachPresented = false
          if !openLaneIds.contains(attachedLaneId) {
            openLaneIds.insert(attachedLaneId, at: 0)
          }
          await reload(refreshRemote: true)
        }
      }
      .sheet(item: $detailSheetTarget) { target in
        NavigationStack {
          LaneDetailScreen(
            laneId: target.laneId,
            initialSnapshot: target.snapshot,
            allLaneSnapshots: laneSnapshots,
            initialSection: target.initialSection,
            onRefreshRoot: { await reload(refreshRemote: true) }
          )
        }
      }
      .sheet(isPresented: $batchManagePresented) {
        LaneBatchManageSheet(
          snapshots: laneSnapshots.filter { batchManageLaneIds.contains($0.lane.id) }
        ) {
          batchManagePresented = false
          await reload(refreshRemote: true)
        }
      }
    }
  }

  // MARK: - Filter bar

  @ViewBuilder
  private var filterBar: some View {
    VStack(spacing: 10) {
      HStack(spacing: 8) {
        ForEach(LaneListScope.allCases) { option in
          LaneFilterPill(
            title: option.title,
            count: option == .active ? activeLaneCount : option == .archived ? archivedLaneCount : laneSnapshots.count,
            isActive: scope == option,
            tint: scope == option ? ADEColor.accent : ADEColor.textSecondary
          ) {
            withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) { scope = option }
          }
        }

        Spacer()

        if !searchText.isEmpty || runtimeFilter != .all {
          Text("\(filteredSnapshots.count) results")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
      }

      if !laneSnapshots.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(LaneRuntimeFilter.allCases) { filter in
              LaneFilterPill(
                title: filter.title,
                count: count(for: filter),
                isActive: runtimeFilter == filter,
                tint: runtimeFilter == filter ? runtimeTint(bucket: filter.rawValue) : ADEColor.textSecondary
              ) {
                withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) { runtimeFilter = filter }
              }
            }
          }
        }
      }
    }
  }

  // MARK: - Open lanes tray

  @ViewBuilder
  private var openLanesTray: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Label("Open lanes", systemImage: "square.stack.3d.up.fill")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer()
        Button {
          withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
            openLaneIds = Array(pinnedLaneIds)
          }
        } label: {
          Text("Clear")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textMuted)
        }
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
              LaneOpenChip(
                snapshot: snapshot,
                isPinned: pinnedLaneIds.contains(snapshot.lane.id)
              )
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

  // MARK: - Attention section

  @ViewBuilder
  private var attentionSection: some View {
    VStack(spacing: 10) {
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

  // MARK: - Lane list

  @ViewBuilder
  private var laneList: some View {
    if filteredSnapshots.isEmpty {
      ADEEmptyStateView(
        symbol: "square.stack.3d.up.slash",
        title: emptyStateTitle,
        message: emptyStateText
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
        }
        .buttonStyle(ADEScaleButtonStyle())
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          Button(openLaneIds.contains(snapshot.lane.id) ? "Close" : "Open") {
            toggleOpenLane(snapshot.lane.id)
          }
          .tint(ADEColor.accent)

          if snapshot.lane.archivedAt == nil {
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
          } else {
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
            .tint(.green)
          }
        }
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
            openLaneIds = filteredSnapshots.map(\.lane.id)
          }
          if manageableVisibleLaneIds.count > 1 {
            Button("Manage \(manageableVisibleLaneIds.count) visible lanes") {
              batchManageLaneIds = manageableVisibleLaneIds
              batchManagePresented = true
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

  // MARK: - Helpers

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try await syncService.refreshLaneSnapshots()
      }
      let loadedSnapshots = try await syncService.fetchLaneListSnapshots(includeArchived: true)
      laneSnapshots = loadedSnapshots
      let visibleIds = Set(loadedSnapshots.map(\.lane.id))
      openLaneIds = openLaneIds.filter { visibleIds.contains($0) }
      pinnedLaneIds = Set(pinnedLaneIds.filter { visibleIds.contains($0) })
      errorMessage = nil
      primaryBranchError = nil
      if let primaryLane, canRunLiveActions {
        do {
          primaryBranches = try await syncService.listBranches(laneId: primaryLane.id)
        } catch {
          primaryBranches = []
          primaryBranchError = error.localizedDescription
        }
      } else {
        primaryBranches = []
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var canRunLiveActions: Bool {
    syncService.connectionState == .connected || syncService.connectionState == .syncing
  }

  private func count(for filter: LaneRuntimeFilter) -> Int {
    if filter == .all { return laneSnapshots.count }
    return laneSnapshots.filter { $0.runtime.bucket == filter.rawValue }.count
  }

  private func toggleOpenLane(_ laneId: String) {
    withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
      if openLaneIds.contains(laneId) {
        closeLaneChip(laneId)
      } else {
        openLaneIds.insert(laneId, at: 0)
      }
    }
  }

  private func closeLaneChip(_ laneId: String) {
    if pinnedLaneIds.contains(laneId) { return }
    openLaneIds.removeAll { $0 == laneId }
  }

  private func togglePin(_ laneId: String) {
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
  private func refreshFromPullGesture() async {
    await reload(refreshRemote: true)
    if errorMessage == nil {
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
        refreshFeedbackToken += 1
      }
    }
  }

  private var emptyStateTitle: String {
    switch scope {
    case .active: return "No active lanes"
    case .archived: return "No archived lanes"
    case .all: return "No lanes"
    }
  }

  private var emptyStateText: String {
    if !searchText.isEmpty {
      return "Try a different search or clear the filter."
    }
    switch scope {
    case .active:
      return "Create a new lane or connect to a host."
    case .archived:
      return "Archived lanes will appear here."
    case .all:
      return "No lanes match the current filters."
    }
  }

  private var statusNotice: ADENoticeCard? {
    switch laneStatus.phase {
    case .disconnected:
      return ADENoticeCard(
        title: laneSnapshots.isEmpty ? "Host disconnected" : "Showing cached lanes",
        message: laneSnapshots.isEmpty
          ? (syncService.activeHostProfile == nil
              ? "Pair with a host to load the current lane graph."
              : "Reconnect to load the current lane graph from the host.")
          : (needsRepairing
              ? "Cached lane data is still visible, but the previous host trust was cleared. Pair again before trusting the lane graph."
              : "Cached lane data is available. Reconnect to refresh."),
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
        message: "Waiting for the host to finish syncing project data before the lane graph hydrates.",
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
}

// MARK: - Lane list row

private struct LaneListRow: View {
  let snapshot: LaneListSnapshot
  let isPinned: Bool
  let isOpen: Bool

  var body: some View {
    HStack(spacing: 14) {
      LaneStatusIndicator(bucket: snapshot.runtime.bucket)

      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 8) {
          Text(snapshot.lane.name)
            .font(.body.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)

          if snapshot.lane.laneType == "primary" {
            LaneTypeBadge(text: "Primary", tint: ADEColor.accent)
          } else if snapshot.lane.laneType == "attached" {
            LaneTypeBadge(text: "Attached", tint: ADEColor.textMuted)
          }
        }

        Text(snapshot.lane.branchRef)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)

        HStack(spacing: 6) {
          if snapshot.lane.status.ahead > 0 {
            LaneMicroChip(icon: "arrow.up", text: "\(snapshot.lane.status.ahead)", tint: ADEColor.success)
          }
          if snapshot.lane.status.behind > 0 {
            LaneMicroChip(icon: "arrow.down", text: "\(snapshot.lane.status.behind)", tint: ADEColor.warning)
          }
          if snapshot.runtime.sessionCount > 0 {
            LaneMicroChip(
              icon: runtimeSymbol(snapshot.runtime.bucket),
              text: "\(snapshot.runtime.sessionCount)",
              tint: runtimeTint(bucket: snapshot.runtime.bucket)
            )
          }
          if snapshot.lane.childCount > 0 {
            LaneMicroChip(icon: "square.stack.3d.up", text: "\(snapshot.lane.childCount)", tint: ADEColor.textMuted)
          }
          if isPinned {
            Image(systemName: "pin.fill")
              .font(.system(size: 9))
              .foregroundStyle(ADEColor.accent)
          }
        }

        if let activity = laneActivitySummary(snapshot) {
          Text(activity)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }

      Spacer(minLength: 8)

      VStack(alignment: .trailing, spacing: 6) {
        lanePriorityBadge(snapshot: snapshot)
      }

      Image(systemName: "chevron.right")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeGlassCard(cornerRadius: 16, padding: 14)
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(isOpen ? ADEColor.accent.opacity(0.35) : ADEColor.border.opacity(0.14), lineWidth: isOpen ? 1 : 0.75)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel(laneRowAccessibilityLabel)
  }

  private var laneRowAccessibilityLabel: String {
    var parts = [snapshot.lane.name, snapshot.lane.branchRef]
    if snapshot.lane.status.dirty { parts.append("dirty") }
    if isPinned { parts.append("pinned") }
    if isOpen { parts.append("open") }
    if snapshot.lane.status.ahead > 0 { parts.append("\(snapshot.lane.status.ahead) ahead") }
    if snapshot.lane.status.behind > 0 { parts.append("\(snapshot.lane.status.behind) behind") }
    return parts.joined(separator: ", ")
  }
}

// MARK: - Lane detail screen

private struct LaneDetailScreen: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService

  let laneId: String
  let initialSnapshot: LaneListSnapshot
  let allLaneSnapshots: [LaneListSnapshot]
  let onRefreshRoot: @MainActor () async -> Void

  @State private var detail: LaneDetailPayload?
  @State private var errorMessage: String?
  @State private var section: LaneDetailSection
  @State private var busyAction: String?
  @State private var renameText = ""
  @State private var selectedParentLaneId = ""
  @State private var colorText = ""
  @State private var iconText = ""
  @State private var tagsText = ""
  @State private var commitMessage = ""
  @State private var amendCommit = false
  @State private var stashMessage = ""
  @State private var deleteMode: LaneDeleteMode = .worktree
  @State private var deleteRemoteName = "origin"
  @State private var deleteForce = false
  @State private var deleteConfirmText = ""
  @State private var selectedDiffRequest: LaneDiffRequest?
  @State private var trackedLaunch = true
  @State private var showStackGraph = false
  @State private var chatLaunchTarget: LaneChatLaunchTarget?
  @State private var lanePullRequests: [PullRequestListItem] = []

  init(
    laneId: String,
    initialSnapshot: LaneListSnapshot,
    allLaneSnapshots: [LaneListSnapshot],
    initialSection: LaneDetailSection = .git,
    onRefreshRoot: @escaping @MainActor () async -> Void
  ) {
    self.laneId = laneId
    self.initialSnapshot = initialSnapshot
    self.allLaneSnapshots = allLaneSnapshots
    self.onRefreshRoot = onRefreshRoot
    _section = State(initialValue: initialSection)
  }

  private var currentSnapshot: LaneListSnapshot {
    allLaneSnapshots.first(where: { $0.lane.id == laneId }) ?? initialSnapshot
  }

  private var reparentCandidates: [LaneSummary] {
    allLaneSnapshots
      .map(\.lane)
      .filter { $0.id != laneId && $0.archivedAt == nil }
      .sorted { lhs, rhs in
        if lhs.laneType == "primary" && rhs.laneType != "primary" { return true }
        if lhs.laneType != "primary" && rhs.laneType == "primary" { return false }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
      }
  }

  var body: some View {
    ScrollView {
      LazyVStack(spacing: 14, pinnedViews: [.sectionHeaders]) {
        // Connection banner
        if let banner = connectionBanner {
          banner
        }

        // Busy indicator
        if let busyAction {
          HStack(spacing: 10) {
            ProgressView()
              .tint(ADEColor.accent)
            Text(busyAction.capitalized)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
            Spacer()
          }
          .adeGlassCard(cornerRadius: 12, padding: 12)
        }

        // Error
        if let errorMessage {
          HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(ADEColor.danger)
            Text(errorMessage)
              .font(.caption)
              .foregroundStyle(ADEColor.danger)
            Spacer()
          }
          .padding(12)
          .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }

        // Header card
        detailHeader

        // Quick actions
        quickActionBar

        // Section picker + content
        Section {
          selectedSectionContent
            .id(section)
            .transition(.opacity.animation(.smooth))
        } header: {
          sectionPicker
            .padding(.bottom, 6)
            .background(ADEColor.pageBackground.opacity(0.96))
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .animation(ADEMotion.emphasis(reduceMotion: reduceMotion), value: section)
    .adeNavigationGlass()
    .navigationTitle(detail?.lane.name ?? initialSnapshot.lane.name)
    .navigationBarTitleDisplayMode(.inline)
    .task {
      await loadDetail(refreshRemote: true)
    }
    .refreshable {
      await loadDetail(refreshRemote: true)
    }
    .sheet(item: $selectedDiffRequest) { request in
      LaneDiffScreen(request: request)
    }
    .sheet(isPresented: $showStackGraph) {
      LaneStackGraphSheet(snapshots: allLaneSnapshots, selectedLaneId: laneId)
    }
    .sheet(item: $chatLaunchTarget) { target in
      LaneChatLaunchSheet(laneId: laneId, provider: target.provider) { _ in
        await loadDetail(refreshRemote: true)
      }
    }
  }

  // MARK: Detail header

  @ViewBuilder
  private var detailHeader: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        LaneStatusIndicator(bucket: currentSnapshot.runtime.bucket, size: 12)

        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Text(detail?.lane.branchRef ?? currentSnapshot.lane.branchRef)
              .font(.system(.headline, design: .monospaced))
              .foregroundStyle(ADEColor.textPrimary)
            lanePriorityBadge(snapshot: currentSnapshot)
          }

          if currentSnapshot.lane.baseRef != currentSnapshot.lane.branchRef {
            Text("from \(detail?.lane.baseRef ?? currentSnapshot.lane.baseRef)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }

        Spacer(minLength: 10)

        VStack(alignment: .trailing, spacing: 6) {
          if currentSnapshot.lane.laneType == "primary" {
            LaneTypeBadge(text: "Primary", tint: ADEColor.accent)
          } else if currentSnapshot.lane.laneType == "attached" {
            LaneTypeBadge(text: "Attached", tint: ADEColor.textSecondary)
          }
          if currentSnapshot.runtime.sessionCount > 0 {
            LaneTypeBadge(
              text: "\(currentSnapshot.runtime.sessionCount) live",
              tint: runtimeTint(bucket: currentSnapshot.runtime.bucket)
            )
          }
        }
      }

      // Meta chips
      HStack(spacing: 6) {
        if currentSnapshot.lane.status.ahead > 0 {
          LaneMicroChip(icon: "arrow.up", text: "\(currentSnapshot.lane.status.ahead) ahead", tint: ADEColor.success)
        }
        if currentSnapshot.lane.status.behind > 0 {
          LaneMicroChip(icon: "arrow.down", text: "\(currentSnapshot.lane.status.behind) behind", tint: ADEColor.warning)
        }
        if currentSnapshot.lane.status.dirty {
          LaneMicroChip(icon: "pencil.line", text: "Dirty", tint: ADEColor.warning)
        }
        if currentSnapshot.lane.childCount > 0 {
          LaneMicroChip(icon: "square.stack.3d.up", text: "\(currentSnapshot.lane.childCount) child", tint: ADEColor.textMuted)
        }
      }
    }
    .adeGlassCard(cornerRadius: 16, padding: 14)
  }

  // MARK: Quick actions

  @ViewBuilder
  private var quickActionBar: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        LaneQuickAction(title: "Files", symbol: "folder", tint: ADEColor.accent) {
          Task { await openFiles() }
        }
        if !lanePullRequests.isEmpty {
          LaneQuickAction(title: lanePullRequests.count == 1 ? "PR" : "PRs", symbol: "arrow.triangle.pull", tint: ADEColor.warning) {
            openPullRequest(lanePullRequests[0].id)
          }
        }
        LaneQuickAction(title: "Copy path", symbol: "doc.on.doc", tint: ADEColor.textSecondary) {
          UIPasteboard.general.string = detail?.lane.worktreePath ?? currentSnapshot.lane.worktreePath
        }
        LaneQuickAction(title: "Stack", symbol: "list.number", tint: ADEColor.textSecondary) {
          showStackGraph = true
        }
        if canRunLiveActions {
          LaneQuickAction(title: "Shell", symbol: "terminal", tint: ADEColor.success) {
            Task {
              await performAction("launch shell") {
                try await syncService.runQuickCommand(laneId: laneId, title: "Shell", toolType: "shell", tracked: trackedLaunch)
              }
            }
          }
        }
      }
    }
  }

  // MARK: Section picker

  @ViewBuilder
  private var sectionPicker: some View {
    Picker("Section", selection: $section) {
      ForEach(LaneDetailSection.allCases) { item in
        Label(item.title, systemImage: item.symbol)
          .tag(item)
      }
    }
    .pickerStyle(.segmented)
    .sensoryFeedback(.selection, trigger: section)
  }

  // MARK: Section content

  @ViewBuilder
  private var selectedSectionContent: some View {
    if detail == nil && errorMessage == nil {
      HStack(spacing: 12) {
        ProgressView()
          .tint(ADEColor.accent)
        Text("Loading lane detail...")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
        Spacer()
      }
      .adeGlassCard(cornerRadius: 14, padding: 14)
    } else {
      switch section {
      case .overview:
        overviewSections
      case .git:
        gitSections
      case .work:
        workSections
      case .manage:
        manageSections
      }
    }
  }

  // MARK: - Overview section

  @ViewBuilder
  private var overviewSections: some View {
    if let detail {
      VStack(spacing: 14) {
        GlassSection(title: "Lane summary") {
          VStack(alignment: .leading, spacing: 10) {
            LaneInfoRow(label: "Type", value: detail.lane.laneType.capitalized)
            LaneInfoRow(label: "Base", value: detail.lane.baseRef)
            LaneInfoRow(label: "Path", value: detail.lane.worktreePath, isMonospaced: true)
            if let parentLaneId = detail.lane.parentLaneId,
               let parent = allLaneSnapshots.first(where: { $0.lane.id == parentLaneId })?.lane {
              LaneInfoRow(label: "Parent", value: "\(parent.name) (\(parent.branchRef))")
            }
          }
        }

        if !lanePullRequests.isEmpty {
          GlassSection(title: lanePullRequests.count == 1 ? "Linked PR" : "Linked PRs") {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(lanePullRequests.prefix(3)) { pr in
                Button {
                  openPullRequest(pr.id)
                } label: {
                  HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                      Text(pr.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ADEColor.textPrimary)
                      Text("#\(pr.githubPrNumber) · \(pr.state.uppercased())")
                        .font(.caption.monospaced())
                        .foregroundStyle(ADEColor.textSecondary)
                    }
                    Spacer(minLength: 8)
                    ADEStatusPill(text: pr.state.uppercased(), tint: lanePullRequestTint(pr.state))
                  }
                }
                .buttonStyle(.glass)
                .accessibilityLabel("Open pull request number \(pr.githubPrNumber), \(pr.title)")
              }
            }
          }
        }

        if detail.autoRebaseStatus != nil || detail.rebaseSuggestion != nil {
          GlassSection(title: "Rebase status") {
            VStack(alignment: .leading, spacing: 10) {
              if let autoRebaseStatus = detail.autoRebaseStatus, autoRebaseStatus.state != "autoRebased" {
                Text(autoRebaseStatus.message ?? "This lane needs manual rebase attention.")
                  .font(.subheadline)
                  .foregroundStyle(ADEColor.textPrimary)
                if autoRebaseStatus.conflictCount > 0 {
                  Text("\(autoRebaseStatus.conflictCount) conflict file(s) blocking auto-rebase.")
                    .font(.caption)
                    .foregroundStyle(ADEColor.danger)
                }
              }

              if let rebaseSuggestion = detail.rebaseSuggestion {
                Text("Behind parent by \(rebaseSuggestion.behindCount) commit(s).")
                  .font(.subheadline)
                  .foregroundStyle(ADEColor.textPrimary)
              }

              HStack(spacing: 8) {
                if detail.rebaseSuggestion != nil {
                  LaneActionButton(title: "Defer", symbol: "clock.badge.pause") {
                    Task { await performAction("defer rebase") { try await syncService.deferRebaseSuggestion(laneId: laneId) } }
                  }
                  LaneActionButton(title: "Dismiss", symbol: "xmark.circle") {
                    Task { await performAction("dismiss rebase") { try await syncService.dismissRebaseSuggestion(laneId: laneId) } }
                  }
                }
                Spacer(minLength: 8)
                LaneActionButton(title: "Rebase", symbol: "arrow.triangle.2.circlepath", tint: ADEColor.accent) {
                  Task { await performAction("rebase lane") { try await syncService.startLaneRebase(laneId: laneId) } }
                }
                .disabled(!canRunLiveActions)
              }
            }
          }
        }

        if let conflictStatus = detail.conflictStatus {
          GlassSection(title: "Conflicts") {
            VStack(alignment: .leading, spacing: 10) {
              Text(conflictSummary(conflictStatus))
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)

              ForEach(detail.overlaps) { overlap in
                VStack(alignment: .leading, spacing: 6) {
                  HStack {
                    Text(overlap.peerName)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEColor.textPrimary)
                    Spacer()
                    LaneTypeBadge(
                      text: overlap.riskLevel.uppercased(),
                      tint: overlap.riskLevel == "high" ? ADEColor.danger : ADEColor.warning
                    )
                  }

                  ForEach(overlap.files.prefix(4)) { file in
                    HStack(alignment: .top, spacing: 8) {
                      Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 10))
                        .foregroundStyle(ADEColor.textMuted)
                        .padding(.top, 3)
                      VStack(alignment: .leading, spacing: 2) {
                        Text(file.path)
                          .font(.system(.caption, design: .monospaced))
                          .foregroundStyle(ADEColor.textPrimary)
                        Text(file.conflictType)
                          .font(.caption2)
                          .foregroundStyle(ADEColor.textSecondary)
                      }
                    }
                  }
                }
              }
            }
          }
        }

        GlassSection(title: "Stack") {
          VStack(alignment: .leading, spacing: 10) {
            if detail.stackChain.isEmpty {
              Text("No stack chain available.")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
            } else {
              ForEach(detail.stackChain) { item in
                HStack(alignment: .center, spacing: 10) {
                  Circle()
                    .fill(item.laneId == laneId ? ADEColor.accent : runtimeTint(bucket: detail.runtime.bucket))
                    .frame(width: 7, height: 7)
                  Text(String(repeating: "  ", count: item.depth) + item.laneName)
                    .font(.subheadline.weight(item.laneId == laneId ? .semibold : .regular))
                    .foregroundStyle(ADEColor.textPrimary)
                  Spacer()
                  Text(item.branchRef)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }

            if !detail.children.isEmpty {
              Divider()
              VStack(alignment: .leading, spacing: 8) {
                Text("Children")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(ADEColor.textMuted)
                ForEach(detail.children) { child in
                  HStack {
                    Text(child.name)
                      .font(.subheadline)
                      .foregroundStyle(ADEColor.textPrimary)
                    Spacer()
                    Text(child.branchRef)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                }
              }
            }
          }
        }

        if summarizeState(detail.stateSnapshot?.agentSummary) != nil || summarizeState(detail.stateSnapshot?.missionSummary) != nil {
          GlassSection(title: "Live state") {
            VStack(alignment: .leading, spacing: 10) {
              if let stateText = summarizeState(detail.stateSnapshot?.agentSummary) {
                VStack(alignment: .leading, spacing: 4) {
                  Text("Agent")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ADEColor.textMuted)
                  Text(stateText)
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
              if let missionText = summarizeState(detail.stateSnapshot?.missionSummary) {
                VStack(alignment: .leading, spacing: 4) {
                  Text("Mission")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ADEColor.textMuted)
                  Text(missionText)
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }
        }
      }
    }
  }

  // MARK: - Git section

  @ViewBuilder
  private var gitSections: some View {
    if let detail {
      VStack(spacing: 14) {
        GlassSection(title: "Sync", subtitle: detail.syncStatus.map(syncSummary)) {
          VStack(alignment: .leading, spacing: 12) {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 8) {
                LaneActionButton(title: "Fetch", symbol: "arrow.down.circle") {
                  Task { await performAction("fetch") { try await syncService.fetchGit(laneId: laneId) } }
                }
                Menu {
                  Button("Pull (merge)") {
                    Task { await performAction("pull merge") { try await syncService.pullGit(laneId: laneId) } }
                  }
                  Button("Pull (rebase)") {
                    Task { await performAction("pull rebase") { try await syncService.syncGit(laneId: laneId, mode: "rebase") } }
                  }
                } label: {
                  LaneMenuLabel(title: "Pull")
                }
                LaneActionButton(
                  title: detail.syncStatus?.hasUpstream == false ? "Publish" : "Push",
                  symbol: "arrow.up.circle",
                  tint: ADEColor.accent
                ) {
                  Task { await performAction("push") { try await syncService.pushGit(laneId: laneId) } }
                }
                Menu {
                  Button("Force push") {
                    Task { await performAction("force push") { try await syncService.pushGit(laneId: laneId, forceWithLease: true) } }
                  }
                  Divider()
                  Button("Rebase lane only") {
                    Task { await performAction("rebase lane") { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_only") } }
                  }
                  Button("Rebase lane + descendants") {
                    Task { await performAction("rebase descendants") { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_and_descendants") } }
                  }
                  Button("Rebase and push") {
                    Task { await performAction("rebase and push") { try await runRebaseAndPush() } }
                  }
                } label: {
                  LaneMenuLabel(title: "More")
                }
              }
            }

            if let upstreamRef = detail.syncStatus?.upstreamRef {
              LaneInfoRow(label: "Upstream", value: upstreamRef, isMonospaced: true)
            }
          }
        }

        GlassSection(title: "Commit") {
          VStack(alignment: .leading, spacing: 12) {
            TextField("Commit message", text: $commitMessage, axis: .vertical)
              .textFieldStyle(.plain)
              .adeInsetField()

            Toggle("Amend latest commit", isOn: $amendCommit)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)

            HStack(spacing: 8) {
              LaneActionButton(title: "Generate", symbol: "sparkles") {
                Task {
                  do {
                    commitMessage = try await syncService.generateCommitMessage(laneId: laneId, amend: amendCommit)
                  } catch {
                    errorMessage = error.localizedDescription
                  }
                }
              }
              LaneActionButton(title: "Commit", symbol: "checkmark.circle.fill", tint: ADEColor.accent) {
                Task {
                  await performAction("commit") {
                    try await syncService.commitLane(laneId: laneId, message: commitMessage, amend: amendCommit)
                  }
                  commitMessage = ""
                }
              }
            }
          }
        }

        if let diffChanges = detail.diffChanges, !diffChanges.unstaged.isEmpty {
          GlassSection(title: "Unstaged files (\(diffChanges.unstaged.count))") {
            VStack(alignment: .leading, spacing: 10) {
              if diffChanges.unstaged.count > 1 {
                LaneActionButton(title: "Stage all", symbol: "plus.circle.fill", tint: ADEColor.accent) {
                  Task {
                    await performAction("stage all") {
                      try await syncService.stageAll(laneId: laneId, paths: diffChanges.unstaged.map(\.path))
                    }
                  }
                }
              }
              ForEach(diffChanges.unstaged) { file in
                fileRow(file: file, mode: "unstaged")
              }
            }
          }
        }

        if let diffChanges = detail.diffChanges, !diffChanges.staged.isEmpty {
          GlassSection(title: "Staged files (\(diffChanges.staged.count))") {
            VStack(alignment: .leading, spacing: 10) {
              if diffChanges.staged.count > 1 {
                LaneActionButton(title: "Unstage all", symbol: "minus.circle", tint: ADEColor.warning) {
                  Task {
                    await performAction("unstage all") {
                      try await syncService.unstageAll(laneId: laneId, paths: diffChanges.staged.map(\.path))
                    }
                  }
                }
              }
              ForEach(diffChanges.staged) { file in
                fileRow(file: file, mode: "staged")
              }
            }
          }
        }

        if !detail.stashes.isEmpty || canRunLiveActions {
          GlassSection(title: "Stashes") {
            VStack(alignment: .leading, spacing: 12) {
              HStack(spacing: 8) {
                TextField("Stash message", text: $stashMessage)
                  .textFieldStyle(.plain)
                  .adeInsetField(cornerRadius: 10, padding: 10)
                LaneActionButton(title: "Stash", symbol: "tray.and.arrow.down", tint: ADEColor.accent) {
                  Task { await performAction("stash") { try await syncService.stashPush(laneId: laneId, message: stashMessage, includeUntracked: true) } }
                }
              }

              ForEach(detail.stashes) { stash in
                VStack(alignment: .leading, spacing: 8) {
                  HStack {
                    Text(stash.subject)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEColor.textPrimary)
                    Spacer()
                    if let createdAt = stash.createdAt {
                      Text(relativeTimestamp(createdAt))
                        .font(.caption2)
                        .foregroundStyle(ADEColor.textMuted)
                    }
                  }
                  HStack(spacing: 8) {
                    LaneActionButton(title: "Apply", symbol: "tray.and.arrow.up") {
                      Task { await performAction("stash apply") { try await syncService.stashApply(laneId: laneId, stashRef: stash.ref) } }
                    }
                    LaneActionButton(title: "Pop", symbol: "arrow.up.right.square") {
                      Task { await performAction("stash pop") { try await syncService.stashPop(laneId: laneId, stashRef: stash.ref) } }
                    }
                    LaneActionButton(title: "Drop", symbol: "trash", tint: ADEColor.danger) {
                      Task { await performAction("stash drop") { try await syncService.stashDrop(laneId: laneId, stashRef: stash.ref) } }
                    }
                  }
                }
                if stash.id != detail.stashes.last?.id {
                  Divider()
                }
              }
            }
          }
        }

        if !detail.recentCommits.isEmpty {
          GlassSection(title: "Recent commits") {
            VStack(alignment: .leading, spacing: 12) {
              ForEach(detail.recentCommits) { commit in
                VStack(alignment: .leading, spacing: 6) {
                  HStack {
                    Text(commit.subject)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEColor.textPrimary)
                      .lineLimit(2)
                    Spacer()
                    Text(commit.shortSha)
                      .font(.system(.caption2, design: .monospaced))
                      .foregroundStyle(ADEColor.textMuted)
                  }
                  Text("\(commit.authorName) \u{2022} \(relativeTimestamp(commit.authoredAt))")
                    .font(.caption2)
                    .foregroundStyle(ADEColor.textSecondary)

                  ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                      LaneActionButton(title: "Diff", symbol: "doc.text.magnifyingglass") {
                        Task {
                          do {
                            let files = try await syncService.listCommitFiles(laneId: laneId, commitSha: commit.sha)
                            guard let path = files.first else {
                              errorMessage = "This commit has no file diffs."
                              return
                            }
                            selectedDiffRequest = LaneDiffRequest(
                              laneId: laneId,
                              path: path,
                              mode: "commit",
                              compareRef: commit.sha,
                              compareTo: "parent",
                              title: commit.subject
                            )
                          } catch {
                            errorMessage = error.localizedDescription
                          }
                        }
                      }
                      LaneActionButton(title: "Message", symbol: "text.alignleft") {
                        Task {
                          do {
                            commitMessage = try await syncService.getCommitMessage(laneId: laneId, commitSha: commit.sha)
                          } catch {
                            errorMessage = error.localizedDescription
                          }
                        }
                      }
                      LaneActionButton(title: "Revert", symbol: "arrow.uturn.backward", tint: ADEColor.warning) {
                        Task { await performAction("revert commit") { try await syncService.revertCommit(laneId: laneId, commitSha: commit.sha) } }
                      }
                      LaneActionButton(title: "Cherry-pick", symbol: "arrow.triangle.merge") {
                        Task { await performAction("cherry pick") { try await syncService.cherryPickCommit(laneId: laneId, commitSha: commit.sha) } }
                      }
                    }
                  }
                }

                if commit.id != detail.recentCommits.last?.id {
                  Divider()
                }
              }
            }
          }
        }

        if let conflictState = detail.conflictState, conflictState.inProgress {
          GlassSection(title: "Rebase conflict") {
            VStack(alignment: .leading, spacing: 12) {
              Text("Git reports a \(conflictState.kind ?? "merge") in progress.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)

              if !conflictState.conflictedFiles.isEmpty {
                ForEach(conflictState.conflictedFiles, id: \.self) { path in
                  Text(path)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
              HStack(spacing: 8) {
                LaneActionButton(title: "Continue", symbol: "play.fill", tint: ADEColor.accent) {
                  Task { await performAction("rebase continue") { try await syncService.rebaseContinueGit(laneId: laneId) } }
                }
                .disabled(!conflictState.canContinue)
                LaneActionButton(title: "Abort", symbol: "xmark.circle", tint: ADEColor.danger) {
                  Task { await performAction("rebase abort") { try await syncService.rebaseAbortGit(laneId: laneId) } }
                }
                .disabled(!conflictState.canAbort)
              }
            }
          }
        }
      }
    }
  }

  // MARK: - Work section

  @ViewBuilder
  private var workSections: some View {
    if let detail {
      VStack(spacing: 14) {
        GlassSection(title: "Launch") {
          VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
              LaneLaunchTile(title: "Shell", symbol: "terminal", tint: ADEColor.textSecondary) {
                Task {
                  await performAction("launch shell") {
                    try await syncService.runQuickCommand(laneId: laneId, title: "Shell", toolType: "shell", tracked: trackedLaunch)
                  }
                }
              }
              LaneLaunchTile(title: "Codex", symbol: "sparkle", tint: ADEColor.accent) {
                chatLaunchTarget = LaneChatLaunchTarget(provider: "codex")
              }
              LaneLaunchTile(title: "Claude", symbol: "brain.head.profile", tint: ADEColor.warning) {
                chatLaunchTarget = LaneChatLaunchTarget(provider: "claude")
              }
            }

            Toggle("Track sessions", isOn: $trackedLaunch)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)

            LaneActionButton(title: "Open in Files", symbol: "folder", tint: ADEColor.accent) {
              Task { await openFiles() }
            }
          }
        }

        if !detail.sessions.isEmpty {
          GlassSection(title: "Workspace sessions (\(detail.sessions.count))") {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(detail.sessions) { session in
                NavigationLink {
                  LaneSessionTranscriptView(session: session)
                } label: {
                  LaneSessionCard(session: session)
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .trailing) {
                  Button("Close", role: .destructive) {
                    Task { await performAction("close session") { try await syncService.closeWorkSession(sessionId: session.id) } }
                  }
                }
              }
            }
          }
        }

        if !detail.chatSessions.isEmpty {
          GlassSection(title: "AI chats (\(detail.chatSessions.count))") {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(detail.chatSessions) { chat in
                NavigationLink {
                  LaneChatSessionView(summary: chat)
                } label: {
                  LaneChatCard(chat: chat)
                }
                .buttonStyle(.plain)
              }
            }
          }
        }
      }
    }
  }

  // MARK: - Manage section

  @ViewBuilder
  private var manageSections: some View {
    if let detail {
      VStack(spacing: 14) {
        GlassSection(title: "Identity") {
          VStack(alignment: .leading, spacing: 12) {
            LaneTextField("Lane name", text: $renameText)
            LaneActionButton(title: "Save name", symbol: "checkmark.circle.fill", tint: ADEColor.accent) {
              Task { await performAction("rename lane") { try await syncService.renameLane(laneId, name: renameText) } }
            }
            .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || renameText == detail.lane.name)
          }
        }

        GlassSection(title: "Appearance") {
          VStack(alignment: .leading, spacing: 12) {
            LaneTextField("Color token or hex", text: $colorText)
              .textInputAutocapitalization(.never)
            LaneTextField("Icon (star, flag, bolt, shield, tag)", text: $iconText)
              .textInputAutocapitalization(.never)
            LaneTextField("Tags (comma separated)", text: $tagsText)
            LaneActionButton(title: "Save appearance", symbol: "paintpalette", tint: ADEColor.accent) {
              Task {
                let tags = tagsText
                  .split(separator: ",")
                  .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                  .filter { !$0.isEmpty }
                await performAction("save appearance") {
                  try await syncService.updateLaneAppearance(
                    laneId,
                    color: colorText,
                    icon: iconText,
                    tags: tags
                  )
                }
              }
            }
          }
        }

        if detail.lane.laneType != "primary" {
          GlassSection(title: "Reparent") {
            VStack(alignment: .leading, spacing: 12) {
              Picker("Parent lane", selection: $selectedParentLaneId) {
                Text("Select parent").tag("")
                ForEach(reparentCandidates) { lane in
                  Text("\(lane.name) (\(lane.branchRef))").tag(lane.id)
                }
              }
              .pickerStyle(.menu)

              LaneActionButton(title: "Save parent", symbol: "arrow.triangle.swap", tint: ADEColor.accent) {
                Task { await performAction("reparent lane") { try await syncService.reparentLane(laneId, newParentLaneId: selectedParentLaneId) } }
              }
              .disabled(selectedParentLaneId.isEmpty)
            }
          }
        }

        if detail.lane.laneType == "attached" && detail.lane.archivedAt == nil {
          GlassSection(title: "Attached lane") {
            VStack(alignment: .leading, spacing: 8) {
              Text("Adopt this worktree into .ade/worktrees so ADE manages it end-to-end.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
              LaneActionButton(title: "Move to ADE-managed worktree", symbol: "arrow.down.doc", tint: ADEColor.accent) {
                Task { await performAction("adopt attached lane") { _ = try await syncService.adoptAttachedLane(laneId) } }
              }
            }
          }
        }

        GlassSection(title: detail.lane.archivedAt == nil ? "Archive" : "Restore") {
          if detail.lane.archivedAt == nil {
            LaneActionButton(title: "Archive lane", symbol: "archivebox", tint: ADEColor.warning) {
              Task { await performAction("archive lane") { try await syncService.archiveLane(laneId) } }
            }
            .disabled(detail.lane.laneType == "primary")
          } else {
            LaneActionButton(title: "Restore lane", symbol: "tray.and.arrow.up", tint: ADEColor.accent) {
              Task { await performAction("restore lane") { try await syncService.unarchiveLane(laneId) } }
            }
          }
        }

        if detail.lane.laneType != "primary" {
          GlassSection(title: "Danger zone") {
            DisclosureGroup("Delete lane") {
              VStack(alignment: .leading, spacing: 12) {
                Picker("Delete mode", selection: $deleteMode) {
                  ForEach(LaneDeleteMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                  }
                }
                .pickerStyle(.menu)

                if deleteMode == .remoteBranch {
                  LaneTextField("Remote name", text: $deleteRemoteName)
                }

                Toggle("Force delete", isOn: $deleteForce)
                  .font(.subheadline)
                  .foregroundStyle(ADEColor.textSecondary)

                LaneTextField("Type delete \(detail.lane.name) to confirm", text: $deleteConfirmText)

                LaneActionButton(title: "Delete lane", symbol: "trash", tint: ADEColor.danger) {
                  Task {
                    await performAction("delete lane") {
                      try await syncService.deleteLane(
                        laneId,
                        deleteBranch: deleteMode != .worktree,
                        deleteRemoteBranch: deleteMode == .remoteBranch,
                        remoteName: deleteRemoteName,
                        force: deleteForce
                      )
                    }
                  }
                }
                .disabled(deleteConfirmText.lowercased() != "delete \(detail.lane.name)".lowercased())
              }
              .padding(.top, 12)
            }
            .tint(ADEColor.danger)
          }
        }
      }
    }
  }

  // MARK: - Detail helpers

  private var connectionBanner: ADENoticeCard? {
    guard !canRunLiveActions else { return nil }
    return ADENoticeCard(
      title: "Showing cached lane detail",
      message: "Reconnect to refresh git state, sessions, and lane actions.",
      icon: "icloud.slash",
      tint: ADEColor.warning,
      actionTitle: syncService.activeHostProfile == nil ? "Pair again" : "Reconnect",
      action: {
        if syncService.activeHostProfile == nil {
          syncService.settingsPresented = true
        } else {
          Task {
            await syncService.reconnectIfPossible()
            await loadDetail(refreshRemote: true)
          }
        }
      }
    )
  }

  private var canRunLiveActions: Bool {
    syncService.connectionState == .connected || syncService.connectionState == .syncing
  }

  @MainActor
  private func loadDetail(refreshRemote: Bool) async {
    do {
      if let cached = try await syncService.fetchLaneDetail(laneId: laneId) {
        detail = cached
        seedForms(from: cached)
      }
      if refreshRemote {
        let refreshed = try await syncService.refreshLaneDetail(laneId: laneId)
        detail = refreshed
        seedForms(from: refreshed)
        await onRefreshRoot()
      }
      lanePullRequests = (try? await syncService.fetchPullRequestListItems().filter { $0.laneId == laneId }) ?? []
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func performAction(_ label: String, operation: () async throws -> Void) async {
    do {
      busyAction = label
      try await operation()
      await loadDetail(refreshRemote: true)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    busyAction = nil
  }

  private func runRebaseAndPush() async throws {
    try await syncService.startLaneRebase(laneId: laneId, scope: "lane_only", pushMode: "none")
    try? await syncService.fetchGit(laneId: laneId)
    let syncStatus = try await syncService.fetchSyncStatus(laneId: laneId)
    if syncStatus.hasUpstream == false {
      try await syncService.pushGit(laneId: laneId)
      return
    }
    if syncStatus.diverged && syncStatus.ahead > 0 {
      try await syncService.pushGit(laneId: laneId, forceWithLease: true)
      return
    }
    if syncStatus.ahead > 0 {
      try await syncService.pushGit(laneId: laneId)
    }
  }

  @MainActor
  private func openFiles(path: String? = nil) async {
    do {
      let workspaces = try await syncService.listWorkspaces()
      guard let workspace = workspaces.first(where: { $0.laneId == laneId }) else {
        errorMessage = "No Files workspace for this lane."
        return
      }
      syncService.requestedFilesNavigation = FilesNavigationRequest(
        workspaceId: workspace.id,
        relativePath: path
      )
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func openPullRequest(_ prId: String) {
    syncService.requestedPrNavigation = PrNavigationRequest(prId: prId)
  }

  private func seedForms(from detail: LaneDetailPayload) {
    renameText = detail.lane.name
    colorText = detail.lane.color ?? ""
    iconText = detail.lane.icon?.rawValue ?? ""
    tagsText = detail.lane.tags.joined(separator: ", ")
    selectedParentLaneId = detail.lane.parentLaneId ?? ""
  }

  @ViewBuilder
  private func fileRow(file: FileChange, mode: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 10) {
        Circle()
          .fill(file.kind == "modified" ? ADEColor.warning : file.kind == "added" ? ADEColor.success : ADEColor.danger)
          .frame(width: 6, height: 6)
          .padding(.top, 7)
        VStack(alignment: .leading, spacing: 2) {
          Text(file.path)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          Text(file.kind.capitalized)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
        Spacer()
      }

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          LaneActionButton(title: "Diff", symbol: "doc.text.magnifyingglass") {
            selectedDiffRequest = LaneDiffRequest(
              laneId: laneId,
              path: file.path,
              mode: mode,
              compareRef: nil,
              compareTo: nil,
              title: file.path
            )
          }
          LaneActionButton(title: "Files", symbol: "folder") {
            Task { await openFiles(path: file.path) }
          }
          if mode == "unstaged" {
            LaneActionButton(title: "Stage", symbol: "plus.circle.fill", tint: ADEColor.accent) {
              Task { await performAction("stage file") { try await syncService.stageFile(laneId: laneId, path: file.path) } }
            }
            LaneActionButton(title: "Discard", symbol: "trash", tint: ADEColor.danger) {
              Task { await performAction("discard file") { try await syncService.discardFile(laneId: laneId, path: file.path) } }
            }
          } else {
            LaneActionButton(title: "Unstage", symbol: "minus.circle", tint: ADEColor.warning) {
              Task { await performAction("unstage file") { try await syncService.unstageFile(laneId: laneId, path: file.path) } }
            }
            LaneActionButton(title: "Restore", symbol: "trash", tint: ADEColor.danger) {
              Task { await performAction("restore staged file") { try await syncService.restoreStagedFile(laneId: laneId, path: file.path) } }
            }
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 10, padding: 10)
  }
}

// MARK: - Sheets

private struct LaneDetailSheetTarget: Identifiable {
  var id: String { "\(laneId):\(initialSection.rawValue)" }
  let laneId: String
  let snapshot: LaneListSnapshot
  let initialSection: LaneDetailSection
}

private struct LaneDiffRequest: Identifiable {
  var id: String { "\(laneId):\(mode):\(path ?? "none"):\(compareRef ?? "none")" }
  let laneId: String
  let path: String?
  let mode: String
  let compareRef: String?
  let compareTo: String?
  let title: String
}

private struct LaneChatLaunchTarget: Identifiable {
  var id: String { provider }
  let provider: String
}

private struct LaneCreateSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let primaryLane: LaneSummary?
  let lanes: [LaneSummary]
  let onComplete: @MainActor (String) async -> Void

  @State private var name = ""
  @State private var description = ""
  @State private var createAsChild = false
  @State private var selectedParentLaneId = ""
  @State private var selectedBaseBranch = ""
  @State private var templates: [LaneTemplate] = []
  @State private var selectedTemplateId = ""
  @State private var branches: [GitBranchSummary] = []
  @State private var errorMessage: String?
  @State private var busy = false
  @State private var envProgress: LaneEnvInitProgress?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Create lane", subtitle: createAsChild ? "Branches from another ADE lane." : "Branches from the selected base.") {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $name)
              LaneTextField("Description", text: $description)
            }
          }

          GlassSection(title: "Branching") {
            VStack(alignment: .leading, spacing: 12) {
              Toggle("Create as child lane", isOn: $createAsChild)
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)

              if createAsChild {
                Picker("Parent lane", selection: $selectedParentLaneId) {
                  Text("Select parent").tag("")
                  ForEach(lanes.filter { $0.archivedAt == nil }) { lane in
                    Text("\(lane.name) (\(lane.branchRef))").tag(lane.id)
                  }
                }
                .pickerStyle(.menu)
              } else {
                Picker("Base branch", selection: $selectedBaseBranch) {
                  ForEach(branches.filter { !$0.isRemote }) { branch in
                    Text(branch.name).tag(branch.name)
                  }
                }
                .pickerStyle(.menu)
              }
            }
          }

          GlassSection(title: "Template") {
            Picker("Template", selection: $selectedTemplateId) {
              Text("No template").tag("")
              ForEach(templates) { template in
                Text(template.name).tag(template.id)
              }
            }
            .pickerStyle(.menu)
          }

          if let envProgress {
            GlassSection(title: "Environment setup") {
              VStack(alignment: .leading, spacing: 10) {
                ForEach(envProgress.steps) { step in
                  HStack {
                    Text(step.label)
                      .font(.subheadline)
                      .foregroundStyle(ADEColor.textPrimary)
                    Spacer()
                    Text(step.status)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                }
              }
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
    .adeNavigationGlass()
      .navigationTitle("Create lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") {
            Task { await submit() }
          }
          .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (createAsChild && selectedParentLaneId.isEmpty) || busy)
        }
      }
      .task {
        await loadOptions()
      }
    }
  }

  @MainActor
  private func loadOptions() async {
    do {
      templates = try await syncService.fetchLaneTemplates()
      selectedTemplateId = try await syncService.fetchDefaultLaneTemplateId() ?? ""
      if let primaryLane {
        branches = try await syncService.listBranches(laneId: primaryLane.id)
        selectedBaseBranch = branches.first(where: { $0.isCurrent })?.name ?? branches.first?.name ?? primaryLane.branchRef
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func submit() async {
    do {
      busy = true
      errorMessage = nil
      let created: LaneSummary
      if createAsChild {
        created = try await syncService.createChildLane(name: name, parentLaneId: selectedParentLaneId, description: description)
      } else {
        created = try await syncService.createLane(
          name: name,
          description: description,
          parentLaneId: nil,
          baseBranch: selectedBaseBranch
        )
      }
      envProgress = selectedTemplateId.isEmpty
        ? try await syncService.initializeLaneEnvironment(laneId: created.id)
        : try await syncService.applyLaneTemplate(laneId: created.id, templateId: selectedTemplateId)
      await onComplete(created.id)
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}

private struct LaneAttachSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let onComplete: @MainActor (String) async -> Void

  @State private var name = ""
  @State private var attachedPath = ""
  @State private var description = ""
  @State private var busy = false
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Attach worktree", subtitle: "Register an existing worktree as a lane.") {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $name)
              LaneTextField("Worktree path", text: $attachedPath)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
              LaneTextField("Description", text: $description)
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
    .adeNavigationGlass()
      .navigationTitle("Attach worktree")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Attach") {
            Task { await submit() }
          }
          .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachedPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
        }
      }
    }
  }

  @MainActor
  private func submit() async {
    do {
      busy = true
      errorMessage = nil
      let lane = try await syncService.attachLane(name: name, attachedPath: attachedPath, description: description)
      await onComplete(lane.id)
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}

private struct LaneBatchManageSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let snapshots: [LaneListSnapshot]
  let onComplete: @MainActor () async -> Void

  @State private var deleteMode: LaneDeleteMode = .worktree
  @State private var deleteRemoteName = "origin"
  @State private var deleteForce = false
  @State private var confirmText = ""
  @State private var errorMessage: String?
  @State private var busy = false

  private var laneIds: [String] {
    snapshots.map(\.lane.id)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Selected lanes (\(laneIds.count))") {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(snapshots) { snapshot in
                HStack(alignment: .center, spacing: 10) {
                  LaneStatusIndicator(bucket: snapshot.runtime.bucket, size: 8)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(snapshot.lane.name)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEColor.textPrimary)
                    Text(snapshot.lane.branchRef)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                  Spacer()
                  if snapshot.lane.status.dirty {
                    LaneTypeBadge(text: "Dirty", tint: ADEColor.warning)
                  }
                }
              }
            }
          }

          GlassSection(title: "Archive") {
            Button {
              Task { await archiveSelected() }
            } label: {
              HStack {
                Image(systemName: "archivebox.fill")
                Text("Archive selected lanes")
                  .font(.subheadline.weight(.semibold))
                Spacer()
              }
              .foregroundStyle(ADEColor.warning)
              .padding(12)
              .background(ADEColor.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(busy || laneIds.isEmpty)
          }

          GlassSection(title: "Delete") {
            VStack(alignment: .leading, spacing: 12) {
              Picker("Delete mode", selection: $deleteMode) {
                ForEach(LaneDeleteMode.allCases) { mode in
                  Text(mode.title).tag(mode)
                }
              }
              .pickerStyle(.menu)

              if deleteMode == .remoteBranch {
                LaneTextField("Remote name", text: $deleteRemoteName)
                  .textInputAutocapitalization(.never)
                  .autocorrectionDisabled()
              }

              Toggle("Force delete", isOn: $deleteForce)
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)

              LaneTextField("Type delete open lanes to confirm", text: $confirmText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

              Button(role: .destructive) {
                Task { await deleteSelected() }
              } label: {
                HStack {
                  Image(systemName: "trash.fill")
                  Text("Delete selected lanes")
                    .font(.subheadline.weight(.semibold))
                  Spacer()
                }
                .padding(12)
                .background(ADEColor.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
              }
              .buttonStyle(.plain)
              .disabled(confirmText.lowercased() != "delete open lanes" || busy || laneIds.isEmpty)
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
    .adeNavigationGlass()
      .navigationTitle("Manage lanes")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .disabled(busy)
        }
      }
    }
  }

  @MainActor
  private func archiveSelected() async {
    do {
      busy = true
      for laneId in laneIds {
        try await syncService.archiveLane(laneId)
      }
      await onComplete()
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }

  @MainActor
  private func deleteSelected() async {
    do {
      busy = true
      for laneId in laneIds {
        try await syncService.deleteLane(
          laneId,
          deleteBranch: deleteMode != .worktree,
          deleteRemoteBranch: deleteMode == .remoteBranch,
          remoteName: deleteRemoteName,
          force: deleteForce
        )
      }
      await onComplete()
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}

private struct LaneStackGraphSheet: View {
  @Environment(\.dismiss) private var dismiss

  let snapshots: [LaneListSnapshot]
  let selectedLaneId: String

  private var orderedSnapshots: [LaneListSnapshot] {
    let childrenByParent = Dictionary(grouping: snapshots) { snapshot in
      snapshot.lane.parentLaneId ?? "__root__"
    }
    let primaryId = snapshots.first(where: { $0.lane.laneType == "primary" })?.lane.id

    func visit(parentId: String?) -> [LaneListSnapshot] {
      let key = parentId ?? "__root__"
      let children = (childrenByParent[key] ?? []).sorted { lhs, rhs in
        lhs.lane.createdAt < rhs.lane.createdAt
      }
      return children.flatMap { child in
        [child] + visit(parentId: child.lane.id)
      }
    }

    let primaryBranch = primaryId.flatMap { id in snapshots.first(where: { $0.lane.id == id }) }.map { [$0] + visit(parentId: $0.lane.id) } ?? []
    let seen = Set(primaryBranch.map(\.lane.id))
    let remaining = snapshots.filter { !seen.contains($0.lane.id) }.sorted { $0.lane.createdAt < $1.lane.createdAt }
    return primaryBranch + remaining
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Stack graph") {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(orderedSnapshots) { snapshot in
                HStack(alignment: .top, spacing: 12) {
                  HStack(spacing: 0) {
                    if snapshot.lane.stackDepth > 0 {
                      Rectangle()
                        .fill(ADEColor.border.opacity(0.4))
                        .frame(width: CGFloat(snapshot.lane.stackDepth) * 12, height: 1)
                        .padding(.top, 10)
                    }
                    Circle()
                      .fill(snapshot.lane.id == selectedLaneId ? ADEColor.accent : runtimeTint(bucket: snapshot.runtime.bucket))
                      .frame(width: 8, height: 8)
                      .padding(.top, 6)
                  }
                  VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                      Text(snapshot.lane.name)
                        .font(.subheadline.weight(snapshot.lane.id == selectedLaneId ? .semibold : .regular))
                        .foregroundStyle(ADEColor.textPrimary)
                        .lineLimit(1)
                      if snapshot.lane.id == selectedLaneId {
                        LaneTypeBadge(text: "Current", tint: ADEColor.accent)
                      }
                    }
                    Text(snapshot.lane.branchRef)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                  Spacer()
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                  RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(snapshot.lane.id == selectedLaneId ? ADEColor.accent.opacity(0.1) : ADEColor.surfaceBackground.opacity(0.6))
                )
              }
            }
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
    .adeNavigationGlass()
      .navigationTitle("Stack graph")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

private struct LaneDiffScreen: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let request: LaneDiffRequest

  @State private var diff: FileDiff?
  @State private var editedText = ""
  @State private var errorMessage: String?
  @State private var side = "modified"

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        ScrollView {
          VStack(spacing: 14) {
            GlassSection(title: request.title) {
              VStack(alignment: .leading, spacing: 8) {
                if let path = request.path {
                  Text(path)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ADEColor.textSecondary)
                }
                if let compareRef = request.compareRef, !compareRef.isEmpty {
                  LaneInfoRow(label: "Base", value: compareRef, isMonospaced: true)
                }
                if let compareTo = request.compareTo, !compareTo.isEmpty {
                  LaneInfoRow(label: "Against", value: compareTo, isMonospaced: true)
                }
              }
            }

            if let errorMessage {
              HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                  .foregroundStyle(ADEColor.danger)
                Text(errorMessage)
                  .font(.caption)
                  .foregroundStyle(ADEColor.danger)
                Spacer()
              }
              .padding(12)
              .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            if diff != nil {
              Picker("Side", selection: $side) {
                Text("Original").tag("original")
                Text("Modified").tag("modified")
              }
              .pickerStyle(.segmented)
            }
          }
          .padding(16)
        }

        if let diff {
          if diff.isBinary == true {
            GlassSection(title: "Binary diff") {
              Text("Binary content is view-only on iPhone.")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
            }
            .padding(.horizontal, 16)
          } else {
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(side == "original" ? "Original" : "Modified")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(ADEColor.textMuted)
                Spacer()
                if request.mode == "unstaged" && side == "modified" {
                  Text("Editable")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(ADEColor.accent)
                }
              }
              TextEditor(text: Binding(
                get: {
                  side == "original" ? diff.original.text : editedText
                },
                set: { newValue in
                  editedText = newValue
                }
              ))
              .font(.system(.footnote, design: .monospaced))
              .scrollContentBackground(.hidden)
              .adeInsetField(cornerRadius: 14, padding: 12)
              .disabled(side == "original")
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
          }
        } else {
          Spacer()
          ProgressView()
            .tint(ADEColor.accent)
          Spacer()
        }
      }
      .adeScreenBackground()
    .adeNavigationGlass()
      .navigationTitle(request.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          if request.mode == "unstaged", let path = request.path, side == "modified" {
            Button("Save") {
              Task {
                do {
                  try await syncService.writeLaneFileText(laneId: request.laneId, path: path, text: editedText)
                  try await load()
                } catch {
                  errorMessage = error.localizedDescription
                }
              }
            }
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          if let path = request.path {
            Button("Files") {
              Task {
                do {
                  let workspaces = try await syncService.listWorkspaces()
                  guard let workspace = workspaces.first(where: { $0.laneId == request.laneId }) else { return }
                  syncService.requestedFilesNavigation = FilesNavigationRequest(
                    workspaceId: workspace.id,
                    relativePath: path
                  )
                  dismiss()
                } catch {
                  errorMessage = error.localizedDescription
                }
              }
            }
          }
        }
      }
      .task {
        try? await load()
      }
    }
  }

  @MainActor
  private func load() async throws {
    guard let path = request.path else { return }
    let loaded = try await syncService.fetchFileDiff(
      laneId: request.laneId,
      path: path,
      mode: request.mode,
      compareRef: request.compareRef,
      compareTo: request.compareTo
    )
    diff = loaded
    editedText = loaded.modified.text
  }
}

private struct LaneChatLaunchSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let laneId: String
  let provider: String
  let onComplete: @MainActor (AgentChatSessionSummary) async -> Void

  @State private var models: [AgentChatModelInfo] = []
  @State private var selectedModelId = ""
  @State private var selectedReasoningEffort = ""
  @State private var busy = false
  @State private var errorMessage: String?

  private var selectedModel: AgentChatModelInfo? {
    models.first(where: { $0.id == selectedModelId })
  }

  private var providerTitle: String {
    provider == "claude" ? "Claude" : "Codex"
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: providerTitle) {
            HStack(alignment: .center, spacing: 12) {
              Image(systemName: provider == "claude" ? "brain.head.profile" : "sparkle")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(ADEColor.accent)
              VStack(alignment: .leading, spacing: 3) {
                Text(selectedModel?.displayName ?? "Choose a model")
                  .font(.subheadline.weight(.semibold))
                  .foregroundStyle(ADEColor.textPrimary)
                Text("Session stays lane-scoped.")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
              Spacer()
            }
          }

          if !models.isEmpty {
            GlassSection(title: "Model") {
              VStack(alignment: .leading, spacing: 12) {
                Picker("Model", selection: $selectedModelId) {
                  ForEach(models) { model in
                    Text(model.displayName).tag(model.id)
                  }
                }
                .pickerStyle(.menu)

                if let selectedModel {
                  VStack(alignment: .leading, spacing: 8) {
                    if let description = selectedModel.description, !description.isEmpty {
                      Text(description)
                        .font(.caption)
                        .foregroundStyle(ADEColor.textSecondary)
                    }
                    HStack(spacing: 6) {
                      if let family = selectedModel.family, !family.isEmpty {
                        LaneMicroChip(icon: "circle.grid.2x2.fill", text: family, tint: ADEColor.textSecondary)
                      }
                      if selectedModel.supportsReasoning == true {
                        LaneMicroChip(icon: "brain", text: "Reasoning", tint: ADEColor.accent)
                      }
                      if selectedModel.supportsTools == true {
                        LaneMicroChip(icon: "hammer.fill", text: "Tools", tint: ADEColor.success)
                      }
                    }
                  }
                }
              }
            }
          }

          if let reasoningEfforts = selectedModel?.reasoningEfforts, !reasoningEfforts.isEmpty {
            GlassSection(title: "Reasoning") {
              VStack(alignment: .leading, spacing: 12) {
                Picker("Reasoning", selection: $selectedReasoningEffort) {
                  Text("Default").tag("")
                  ForEach(reasoningEfforts) { effort in
                    Text(effort.effort.capitalized).tag(effort.effort)
                  }
                }
                .pickerStyle(.segmented)

                if let effort = reasoningEfforts.first(where: { $0.effort == selectedReasoningEffort }) {
                  Text(effort.description)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }

          if busy {
            HStack(spacing: 10) {
              ProgressView()
                .tint(ADEColor.accent)
              Text("Creating \(providerTitle) chat...")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
              Spacer()
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
    .adeNavigationGlass()
      .navigationTitle("New \(providerTitle) chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Launch") {
            Task { await submit() }
          }
          .disabled(busy || (models.isEmpty == false && selectedModelId.isEmpty))
        }
      }
      .task {
        await loadModels()
      }
    }
  }

  @MainActor
  private func loadModels() async {
    do {
      models = try await syncService.listChatModels(provider: provider)
      if let preferred = models.first(where: \.isDefault) ?? models.first {
        selectedModelId = preferred.id
        selectedReasoningEffort = preferred.reasoningEfforts?.first?.effort ?? ""
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func submit() async {
    do {
      busy = true
      let session = try await syncService.createChatSession(
        laneId: laneId,
        provider: provider,
        model: selectedModelId,
        reasoningEffort: selectedReasoningEffort.isEmpty ? nil : selectedReasoningEffort
      )
      await onComplete(session)
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}

// MARK: - Sub-views

private struct LaneSessionTranscriptView: View {
  @EnvironmentObject private var syncService: SyncService
  let session: TerminalSessionSummary

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        GlassSection(title: session.title) {
          HStack(spacing: 8) {
            LaneTypeBadge(text: session.status.uppercased(), tint: session.status == "running" ? ADEColor.success : ADEColor.textSecondary)
            if let goal = session.goal, !goal.isEmpty {
              Text(goal)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
          }
        }

        GlassSection(title: "Transcript") {
          Text(syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? "No output yet.")
            .frame(maxWidth: .infinity, alignment: .leading)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .textSelection(.enabled)
            .adeInsetField(cornerRadius: 12, padding: 12)
        }
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(session.title)
    .navigationBarTitleDisplayMode(.inline)
    .task {
      try? await syncService.subscribeTerminal(sessionId: session.id)
    }
  }
}

private struct LaneChatSessionView: View {
  @EnvironmentObject private var syncService: SyncService
  let summary: AgentChatSessionSummary

  @State private var transcript: [AgentChatTranscriptEntry] = []
  @State private var composer = ""
  @State private var errorMessage: String?
  @State private var sending = false

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: summary.title ?? summary.provider.uppercased()) {
            HStack(spacing: 8) {
              LaneTypeBadge(text: summary.status.uppercased(), tint: summary.status == "active" ? ADEColor.success : ADEColor.textSecondary)
              Text(summary.model)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }

          if transcript.isEmpty {
            GlassSection(title: "Transcript") {
              Text("No chat messages yet.")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
            }
          } else {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(transcript) { entry in
                VStack(alignment: .leading, spacing: 4) {
                  Text(entry.role.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(entry.role == "assistant" ? ADEColor.accent : ADEColor.textMuted)
                  Text(entry.text)
                    .font(.body)
                    .foregroundStyle(ADEColor.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                  Text(relativeTimestamp(entry.timestamp))
                    .font(.caption2)
                    .foregroundStyle(ADEColor.textMuted)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                  RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(entry.role == "assistant" ? ADEColor.accent.opacity(0.08) : ADEColor.surfaceBackground.opacity(0.6))
                )
              }
            }
          }

          Color.clear
            .frame(height: 1)
            .id("lane-chat-end")
        }
        .padding(16)
      }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 10) {
          HStack(spacing: 10) {
            TextField("Send a message", text: $composer, axis: .vertical)
              .textFieldStyle(.plain)
              .adeInsetField(cornerRadius: 12, padding: 10)

            Button {
              Task {
                await sendMessage()
                withAnimation(.snappy) {
                  proxy.scrollTo("lane-chat-end", anchor: .bottom)
                }
              }
            } label: {
              Image(systemName: sending ? "ellipsis.circle" : "paperplane.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(ADEColor.accent)
                .frame(width: 40, height: 40)
                .background(ADEColor.accent.opacity(0.15), in: Circle())
            }
            .disabled(composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(ADEColor.surfaceBackground.opacity(0.08))
        .glassEffect()
      }
      .onChange(of: transcript.count) { _, _ in
        withAnimation(.snappy) {
          proxy.scrollTo("lane-chat-end", anchor: .bottom)
        }
      }
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(summary.title ?? summary.provider.uppercased())
    .navigationBarTitleDisplayMode(.inline)
    .task {
      await loadTranscript()
    }
  }

  @MainActor
  private func loadTranscript() async {
    do {
      transcript = try await syncService.fetchChatTranscript(sessionId: summary.sessionId)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func sendMessage() async {
    do {
      sending = true
      let text = composer.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else {
        sending = false
        return
      }
      try await syncService.sendChatMessage(sessionId: summary.sessionId, text: text)
      composer = ""
      transcript = try await syncService.fetchChatTranscript(sessionId: summary.sessionId)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    sending = false
  }
}

// MARK: - Design system components

private struct GlassSection<Content: View>: View {
  let title: String
  let subtitle: String?
  let content: Content

  init(title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
    self.title = title
    self.subtitle = subtitle
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if let subtitle {
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      content
    }
    .adeGlassCard(cornerRadius: 16, padding: 14)
  }
}

private struct LaneStatusIndicator: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  let bucket: String
  var size: CGFloat = 10

  @State private var isPulsing = false

  var body: some View {
    Circle()
      .fill(runtimeTint(bucket: bucket))
      .frame(width: size, height: size)
      .shadow(color: runtimeTint(bucket: bucket).opacity(isAnimating ? 0.5 : 0), radius: isAnimating ? 6 : 0)
      .scaleEffect(isPulsing && isAnimating && !reduceMotion ? 1.3 : 1.0)
      .animation(ADEMotion.pulse(reduceMotion: reduceMotion), value: isPulsing)
      .onAppear {
        if isAnimating && !reduceMotion {
          isPulsing = true
        }
      }
  }

  private var isAnimating: Bool {
    (bucket == "running" || bucket == "awaiting-input") && !reduceMotion
  }
}

private struct LaneFilterPill: View {
  let title: String
  let count: Int
  let isActive: Bool
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Text(title)
          .font(.caption.weight(.medium))
        Text("\(count)")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(isActive ? tint : ADEColor.textMuted)
      }
      .foregroundStyle(isActive ? tint : ADEColor.textSecondary)
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(
        isActive
          ? AnyShapeStyle(tint.opacity(0.12))
          : AnyShapeStyle(ADEColor.surfaceBackground.opacity(0.55)),
        in: Capsule()
      )
      .glassEffect()
      .overlay(
        Capsule()
          .stroke(isActive ? tint.opacity(0.2) : ADEColor.border.opacity(0.16), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .sensoryFeedback(.selection, trigger: isActive)
    .accessibilityLabel("\(title), \(count) items")
    .accessibilityAddTraits(isActive ? .isSelected : [])
  }
}

private struct LaneTypeBadge: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.caption2.weight(.semibold))
      .foregroundStyle(tint)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(tint.opacity(0.12), in: Capsule())
      .glassEffect()
  }
}

private struct LaneMicroChip: View {
  let icon: String
  let text: String?
  let tint: Color

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: icon)
        .font(.system(size: 8, weight: .semibold))
      if let text {
        Text(text)
          .font(.system(.caption2).weight(.medium))
      }
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 6)
    .padding(.vertical, 3)
    .background(tint.opacity(0.1), in: Capsule())
    .glassEffect()
  }
}

private struct LaneActionButton: View {
  let title: String
  let symbol: String
  let tint: Color
  let action: () -> Void

  init(title: String, symbol: String, tint: Color = ADEColor.textSecondary, action: @escaping () -> Void) {
    self.title = title
    self.symbol = symbol
    self.tint = tint
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: symbol)
          .font(.system(size: 11, weight: .semibold))
        Text(title)
          .font(.caption.weight(.medium))
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(tint.opacity(0.1), in: Capsule())
      .glassEffect()
    }
    .buttonStyle(.plain)
  }
}

private struct LaneQuickAction: View {
  let title: String
  let symbol: String
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 4) {
        Image(systemName: symbol)
          .font(.system(size: 16, weight: .medium))
          .symbolRenderingMode(.hierarchical)
        Text(title)
          .font(.caption2.weight(.medium))
      }
      .foregroundStyle(tint)
      .frame(width: 64, height: 54)
      .background(ADEColor.surfaceBackground.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 12))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.16), lineWidth: 0.5)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
  }
}

private struct LaneMenuLabel: View {
  let title: String

  var body: some View {
    HStack(spacing: 4) {
      Text(title)
        .font(.caption.weight(.medium))
      Image(systemName: "chevron.down")
        .font(.system(size: 8, weight: .bold))
    }
    .foregroundStyle(ADEColor.textSecondary)
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: Capsule())
    .glassEffect()
    .overlay(
      Capsule()
        .stroke(ADEColor.border.opacity(0.16), lineWidth: 0.5)
    )
  }
}

private struct LaneOpenChip: View {
  let snapshot: LaneListSnapshot
  let isPinned: Bool

  var body: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(runtimeTint(bucket: snapshot.runtime.bucket))
        .frame(width: 6, height: 6)
      Text(snapshot.lane.name)
        .font(.caption.weight(.medium))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      if isPinned {
        Image(systemName: "pin.fill")
          .font(.system(size: 8))
          .foregroundStyle(ADEColor.accent)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: Capsule())
    .glassEffect()
    .overlay(
      Capsule()
        .stroke(ADEColor.border.opacity(0.16), lineWidth: 0.5)
    )
    .accessibilityLabel("\(snapshot.lane.name)\(isPinned ? ", pinned" : "")")
  }
}

private struct LaneLaunchTile: View {
  let title: String
  let symbol: String
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 8) {
        Image(systemName: symbol)
          .font(.system(size: 18, weight: .semibold))
          .symbolRenderingMode(.hierarchical)
        Text(title)
          .font(.caption.weight(.medium))
      }
      .foregroundStyle(tint)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 14)
      .background(ADEColor.surfaceBackground.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 12))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(tint.opacity(0.14), lineWidth: 0.5)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .accessibilityLabel("Launch \(title)")
  }
}

private struct LaneSessionCard: View {
  let session: TerminalSessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(session.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer()
        LaneTypeBadge(text: session.status.uppercased(), tint: session.status == "running" ? ADEColor.success : ADEColor.textSecondary)
      }
      if let preview = session.lastOutputPreview {
        Text(preview)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
      }
    }
    .adeGlassCard(cornerRadius: 10, padding: 10)
  }
}

private struct LaneChatCard: View {
  let chat: AgentChatSessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(chat.title ?? chat.provider.uppercased())
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer()
        LaneTypeBadge(text: chat.status.uppercased(), tint: chat.status == "active" ? ADEColor.success : ADEColor.textSecondary)
      }
      Text(chat.model)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
      if let preview = chat.lastOutputPreview {
        Text(preview)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
      }
    }
    .adeGlassCard(cornerRadius: 10, padding: 10)
  }
}

private struct LaneInfoRow: View {
  let label: String
  let value: String
  var isMonospaced = false

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Text(label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 54, alignment: .leading)
      Text(value)
        .font(isMonospaced ? .system(.caption, design: .monospaced) : .subheadline)
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

private struct LaneTextField: View {
  let title: String
  @Binding var text: String

  init(_ title: String, text: Binding<String>) {
    self.title = title
    self._text = text
  }

  var body: some View {
    TextField(title, text: $text, axis: .vertical)
      .textFieldStyle(.plain)
      .foregroundStyle(ADEColor.textPrimary)
      .adeInsetField()
  }
}

private struct ADEScaleButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
      .opacity(configuration.isPressed ? 0.85 : 1.0)
      .animation(.snappy(duration: 0.2), value: configuration.isPressed)
  }
}

// MARK: - Utility functions

@ViewBuilder
private func lanePriorityBadge(snapshot: LaneListSnapshot) -> some View {
  if snapshot.autoRebaseStatus?.state == "rebaseConflict" {
    LaneTypeBadge(text: "Conflict", tint: ADEColor.danger)
  } else if snapshot.lane.status.dirty {
    LaneTypeBadge(text: "Dirty", tint: ADEColor.warning)
  } else if snapshot.runtime.bucket == "running" {
    LaneTypeBadge(text: "Running", tint: ADEColor.success)
  } else if snapshot.runtime.bucket == "awaiting-input" {
    LaneTypeBadge(text: "Attention", tint: ADEColor.warning)
  } else if snapshot.lane.archivedAt != nil {
    LaneTypeBadge(text: "Archived", tint: ADEColor.textMuted)
  } else if let rebaseSuggestion = snapshot.rebaseSuggestion {
    LaneTypeBadge(text: "\(rebaseSuggestion.behindCount)\u{2193}", tint: ADEColor.warning)
  } else {
    EmptyView()
  }
}

private func laneActivitySummary(_ snapshot: LaneListSnapshot) -> String? {
  if let agentText = summarizeState(snapshot.stateSnapshot?.agentSummary) {
    return agentText
  }
  if let missionText = summarizeState(snapshot.stateSnapshot?.missionSummary) {
    return missionText
  }
  return nil
}

private func laneMatchesSearch(snapshot: LaneListSnapshot, isPinned: Bool, query: String) -> Bool {
  let tokens = query
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .split(whereSeparator: \.isWhitespace)
    .map(String.init)
  guard !tokens.isEmpty else { return true }
  return tokens.allSatisfy { token in
    matchesLaneToken(snapshot: snapshot, isPinned: isPinned, token: token)
  }
}

private func matchesLaneToken(snapshot: LaneListSnapshot, isPinned: Bool, token: String) -> Bool {
  if token.hasPrefix("is:") {
    switch String(token.dropFirst(3)) {
    case "dirty": return snapshot.lane.status.dirty
    case "clean": return !snapshot.lane.status.dirty
    case "pinned": return isPinned
    case "primary": return snapshot.lane.laneType == "primary"
    case "worktree": return snapshot.lane.laneType == "worktree"
    case "attached": return snapshot.lane.laneType == "attached"
    default: return false
    }
  }
  if token.hasPrefix("type:") {
    return snapshot.lane.laneType.lowercased() == String(token.dropFirst(5))
  }
  let indexed = [
    snapshot.lane.name,
    snapshot.lane.branchRef,
    snapshot.lane.baseRef,
    snapshot.lane.laneType,
    snapshot.lane.description ?? "",
    snapshot.lane.worktreePath,
    snapshot.lane.status.dirty ? "dirty modified changed" : "clean",
    snapshot.lane.status.ahead > 0 ? "ahead ahead:\(snapshot.lane.status.ahead)" : "ahead:0",
    snapshot.lane.status.behind > 0 ? "behind behind:\(snapshot.lane.status.behind)" : "behind:0",
    snapshot.runtime.bucket,
    summarizeState(snapshot.stateSnapshot?.agentSummary) ?? "",
    summarizeState(snapshot.stateSnapshot?.missionSummary) ?? "",
    isPinned ? "pinned" : "",
  ].joined(separator: " ").lowercased()
  return indexed.contains(token)
}

private func summarizeState(_ summary: [String: RemoteJSONValue]?) -> String? {
  guard let summary else { return nil }
  let preferredKeys = [
    "summary", "status", "state", "label", "title", "objective",
    "stepLabel", "step", "name", "agent", "agentName", "assignee",
  ]
  for key in preferredKeys {
    if let value = flattenedString(summary[key]) {
      return value
    }
  }
  for value in summary.values {
    if let flattened = flattenedString(value) {
      return flattened
    }
  }
  return nil
}

private func flattenedString(_ value: RemoteJSONValue?) -> String? {
  guard let value else { return nil }
  switch value {
  case .string(let string):
    return string
  case .number(let number):
    return String(number)
  case .bool(let bool):
    return bool ? "true" : "false"
  case .array(let values):
    return values.compactMap(flattenedString).first
  case .object(let object):
    return summarizeState(object)
  case .null:
    return nil
  }
}

private func runtimeTint(bucket: String) -> Color {
  switch bucket {
  case "running":
    return ADEColor.success
  case "awaiting-input":
    return ADEColor.warning
  case "ended":
    return ADEColor.textMuted
  default:
    return ADEColor.textSecondary
  }
}

private func lanePullRequestTint(_ state: String) -> Color {
  switch state {
  case "open":
    return ADEColor.success
  case "draft":
    return ADEColor.warning
  case "closed":
    return ADEColor.danger
  case "merged":
    return ADEColor.accent
  default:
    return ADEColor.textSecondary
  }
}

private func runtimeSymbol(_ bucket: String) -> String {
  switch bucket {
  case "running":
    return "waveform.path.ecg"
  case "awaiting-input":
    return "exclamationmark.bubble"
  case "ended":
    return "stop.circle"
  default:
    return "circle"
  }
}

private func relativeTimestamp(_ timestamp: String?) -> String {
  guard let timestamp, let date = ISO8601DateFormatter().date(from: timestamp) else {
    return timestamp ?? "Unknown"
  }
  return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}

private func syncSummary(_ status: GitUpstreamSyncStatus) -> String {
  if !status.hasUpstream {
    return "No upstream. Publish to create a remote branch."
  }
  if status.diverged {
    return "Diverged. Rebase or pull before pushing."
  }
  if status.ahead > 0 && status.behind == 0 {
    return "Ahead by \(status.ahead). Push to publish."
  }
  if status.behind > 0 && status.ahead == 0 {
    return "Behind by \(status.behind). Pull to catch up."
  }
  return "In sync with remote."
}

private func conflictSummary(_ status: ConflictStatus) -> String {
  switch status.status {
  case "conflict-active":
    return "\(status.overlappingFileCount) overlapping file(s) in active conflict."
  case "conflict-predicted":
    return "\(status.overlappingFileCount) overlapping file(s) predicted across \(status.peerConflictCount) peer(s)."
  case "behind-base":
    return "Behind base. Rebase before merging."
  case "merge-ready":
    return "Conflict prediction clear. Merge-ready."
  default:
    return "Conflict status available from host."
  }
}

// MARK: - Previews

#Preview("Lane list rows") {
  let mockLanes: [LaneListSnapshot] = [
    LaneListSnapshot(
      lane: LaneSummary(
        id: "1", name: "main", description: "Primary branch", laneType: "primary",
        baseRef: "main", branchRef: "main", worktreePath: "/project",
        attachedRootPath: nil, parentLaneId: nil, childCount: 3, stackDepth: 0,
        parentStatus: nil, isEditProtected: false,
        status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
        color: nil, icon: nil, tags: [], folder: nil,
        createdAt: "2026-01-01T00:00:00Z", archivedAt: nil
      ),
      runtime: LaneRuntimeSummary(bucket: "running", runningCount: 2, awaitingInputCount: 0, endedCount: 1, sessionCount: 3),
      rebaseSuggestion: nil, autoRebaseStatus: nil, conflictStatus: nil, stateSnapshot: nil, adoptableAttached: false
    ),
    LaneListSnapshot(
      lane: LaneSummary(
        id: "2", name: "feature/auth-flow", description: "OAuth integration", laneType: "worktree",
        baseRef: "main", branchRef: "feat/auth-flow", worktreePath: "/project/.ade/worktrees/auth",
        attachedRootPath: nil, parentLaneId: "1", childCount: 0, stackDepth: 1,
        parentStatus: nil, isEditProtected: false,
        status: LaneStatus(dirty: true, ahead: 3, behind: 1, remoteBehind: 0, rebaseInProgress: false),
        color: nil, icon: nil, tags: [], folder: nil,
        createdAt: "2026-03-01T00:00:00Z", archivedAt: nil
      ),
      runtime: LaneRuntimeSummary(bucket: "awaiting-input", runningCount: 0, awaitingInputCount: 1, endedCount: 0, sessionCount: 1),
      rebaseSuggestion: nil, autoRebaseStatus: nil, conflictStatus: nil,
      stateSnapshot: LaneStateSnapshotSummary(laneId: "2", agentSummary: ["summary": .string("Codex waiting for approval")], missionSummary: nil, updatedAt: nil),
      adoptableAttached: false
    ),
    LaneListSnapshot(
      lane: LaneSummary(
        id: "3", name: "fix/login-redirect", description: nil, laneType: "worktree",
        baseRef: "main", branchRef: "fix/login-redirect", worktreePath: "/project/.ade/worktrees/fix-login",
        attachedRootPath: nil, parentLaneId: "1", childCount: 1, stackDepth: 1,
        parentStatus: nil, isEditProtected: false,
        status: LaneStatus(dirty: false, ahead: 7, behind: 0, remoteBehind: 0, rebaseInProgress: false),
        color: nil, icon: nil, tags: [], folder: nil,
        createdAt: "2026-03-10T00:00:00Z", archivedAt: nil
      ),
      runtime: LaneRuntimeSummary(bucket: "running", runningCount: 1, awaitingInputCount: 0, endedCount: 0, sessionCount: 1),
      rebaseSuggestion: nil, autoRebaseStatus: nil, conflictStatus: nil,
      stateSnapshot: LaneStateSnapshotSummary(laneId: "3", agentSummary: ["summary": .string("Claude writing tests")], missionSummary: nil, updatedAt: nil),
      adoptableAttached: false
    ),
    LaneListSnapshot(
      lane: LaneSummary(
        id: "4", name: "refactor/db-layer", description: "Database abstraction", laneType: "attached",
        baseRef: "main", branchRef: "refactor/db-layer", worktreePath: "/other/project",
        attachedRootPath: "/other/project", parentLaneId: nil, childCount: 0, stackDepth: 0,
        parentStatus: nil, isEditProtected: false,
        status: LaneStatus(dirty: false, ahead: 0, behind: 4, remoteBehind: 0, rebaseInProgress: false),
        color: nil, icon: nil, tags: [], folder: nil,
        createdAt: "2026-03-15T00:00:00Z", archivedAt: nil
      ),
      runtime: LaneRuntimeSummary(bucket: "ended", runningCount: 0, awaitingInputCount: 0, endedCount: 1, sessionCount: 1),
      rebaseSuggestion: RebaseSuggestion(laneId: "4", parentLaneId: "1", parentHeadSha: "abc", behindCount: 4, lastSuggestedAt: "2026-03-22T00:00:00Z", deferredUntil: nil, dismissedAt: nil, hasPr: false),
      autoRebaseStatus: nil, conflictStatus: nil, stateSnapshot: nil, adoptableAttached: true
    ),
  ]

  ScrollView {
    LazyVStack(spacing: 14) {
      ForEach(mockLanes) { snapshot in
        LaneListRow(
          snapshot: snapshot,
          isPinned: snapshot.lane.id == "2",
          isOpen: snapshot.lane.id == "2" || snapshot.lane.id == "3"
        )
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
  }
  .background(ADEColor.pageBackground)
  
}
