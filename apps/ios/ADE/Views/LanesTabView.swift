import SwiftUI
import UIKit

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

  var symbol: String {
    switch self {
    case .active: return "circle.grid.2x2.fill"
    case .archived: return "archivebox.fill"
    case .all: return "square.stack.3d.up.fill"
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
    case .awaitingInput: return "Awaiting input"
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
  case overview
  case git
  case work
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

struct LanesTabView: View {
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
        LazyVStack(spacing: 16) {
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
              tint: ADEPalette.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .transition(.opacity)
          }

          laneControlDeck

          if !openLaneSnapshots.isEmpty {
            laneOpenDeck
              .transition(.move(edge: .top).combined(with: .opacity))
          }

          if !visibleSuggestions.isEmpty || !visibleAutoRebaseAttention.isEmpty {
            laneAttentionDeck
              .transition(.move(edge: .top).combined(with: .opacity))
          }

          laneListDeck
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .animation(.easeInOut(duration: 0.3), value: filteredSnapshots.count)
        .animation(.easeInOut(duration: 0.3), value: openLaneSnapshots.count)
      }
      .background(ADEPalette.pageBackground.ignoresSafeArea())
      .navigationTitle("Lanes")
      .navigationBarTitleDisplayMode(.inline)
      .refreshable {
        await reload(refreshRemote: true)
      }
      .sensoryFeedback(.success, trigger: laneSnapshots.count)
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

  @ViewBuilder
  private var laneControlDeck: some View {
    LaneSurfaceCard {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .top, spacing: 12) {
          VStack(alignment: .leading, spacing: 4) {
            Text("Current lane graph")
              .font(.headline)
              .foregroundStyle(ADEPalette.textPrimary)
            Text("\(filteredSnapshots.count) visible • \(activeLaneCount) active • \(archivedLaneCount) archived")
              .font(.subheadline)
              .foregroundStyle(ADEPalette.textSecondary)
          }

          Spacer(minLength: 12)

          LaneSummaryCountPill(
            label: "Open",
            value: "\(openLaneSnapshots.count)",
            tint: openLaneSnapshots.isEmpty ? ADEPalette.textMuted : ADEPalette.accent
          )
        }

        LaneSearchField(
          text: $searchText,
          placeholder: "Filter by lane, branch, is:dirty, type:attached"
        )

        LaneInlineGroup(title: "Scope") {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
              ForEach(LaneListScope.allCases) { option in
                LaneFilterChip(
                  title: option.title,
                  symbol: option.symbol,
                  count: option == .active ? activeLaneCount : option == .archived ? archivedLaneCount : laneSnapshots.count,
                  isActive: scope == option,
                  tint: scope == option ? ADEPalette.accent : ADEPalette.textSecondary
                ) {
                  scope = option
                }
              }
            }
          }
        }

        LaneInlineGroup(title: "Runtime") {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
              ForEach(LaneRuntimeFilter.allCases) { filter in
                LaneFilterChip(
                  title: filter.title,
                  symbol: filter.symbol,
                  count: count(for: filter),
                  isActive: runtimeFilter == filter,
                  tint: runtimeFilter == filter ? runtimeTint(bucket: filter.rawValue) : ADEPalette.textSecondary
                ) {
                  runtimeFilter = filter
                }
              }
            }
          }
        }

        LaneInlineGroup(title: "Actions") {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
              LaneActionStripButton(
                title: "New lane",
                symbol: "plus.square.fill",
                tint: ADEPalette.accent,
                prominence: .primary
              ) {
                createPresented = true
              }

              LaneActionStripButton(
                title: "Attach worktree",
                symbol: "link",
                tint: ADEPalette.textSecondary
              ) {
                attachPresented = true
              }

              if manageableVisibleLaneIds.count > 1 {
                LaneActionStripButton(
                  title: "Manage visible",
                  symbol: "slider.horizontal.3",
                  tint: ADEPalette.warning
                ) {
                  batchManageLaneIds = manageableVisibleLaneIds
                  batchManagePresented = true
                }
              }
            }
          }
        }

        if let primaryLane {
          Divider()
            .overlay(ADEPalette.border.opacity(0.75))

          VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
              LaneSectionMarker(
                title: "Primary branch",
                detail: primaryLane.branchRef,
                symbol: "point.topleft.down.curvedto.point.bottomright.up",
                tint: ADEPalette.accent
              )
              Spacer()
              Menu {
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
              } label: {
                LaneCompactMenuButton(title: "Checkout", tint: ADEPalette.accent)
              }
              .disabled(primaryBranches.isEmpty || !canRunLiveActions)
            }

            if let primaryBranchError {
              Text(primaryBranchError)
                .font(.caption)
                .foregroundStyle(ADEPalette.danger)
            } else if !canRunLiveActions {
              Text("Reconnect to refresh and switch the primary branch.")
                .font(.caption)
                .foregroundStyle(ADEPalette.textMuted)
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private var laneOpenDeck: some View {
    LaneSurfaceCard(title: "Open lanes", subtitle: "\(openLaneSnapshots.count) kept in the tray") {
      VStack(alignment: .leading, spacing: 12) {
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

        HStack(spacing: 8) {
          LaneInlineButton(title: "Open filtered", symbol: "checklist") {
            openLaneIds = filteredSnapshots.map(\.lane.id)
          }
          .disabled(filteredSnapshots.isEmpty)

          if manageableOpenLaneIds.count > 1 {
            LaneInlineButton(title: "Manage open", symbol: "slider.horizontal.3") {
              batchManageLaneIds = manageableOpenLaneIds
              batchManagePresented = true
            }
          }

          Spacer(minLength: 8)

          LaneInlineButton(
            title: "Clear tray",
            symbol: "xmark.circle",
            tint: ADEPalette.danger
          ) {
            openLaneIds = Array(pinnedLaneIds)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var laneAttentionDeck: some View {
    LaneSurfaceCard(title: "Needs attention", subtitle: "Rebase and auto-rebase issues stay visible here") {
      VStack(alignment: .leading, spacing: 14) {
        if !visibleSuggestions.isEmpty {
          LaneInlineGroup(title: "Behind parent") {
            VStack(spacing: 10) {
              ForEach(visibleSuggestions.prefix(3)) { snapshot in
                HStack(alignment: .center, spacing: 10) {
                  VStack(alignment: .leading, spacing: 3) {
                    Text(snapshot.lane.name)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEPalette.textPrimary)
                    Text("Behind parent by \(snapshot.rebaseSuggestion?.behindCount ?? 0) commit(s)")
                      .font(.caption)
                      .foregroundStyle(ADEPalette.textSecondary)
                  }

                  Spacer(minLength: 8)

                  ADEStatusPill(
                    text: "\(snapshot.rebaseSuggestion?.behindCount ?? 0)\u{2193}",
                    tint: ADEPalette.warning
                  )

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
                      .foregroundStyle(ADEPalette.textMuted)
                  }

                  LaneInlineButton(
                    title: "Rebase",
                    symbol: "arrow.triangle.2.circlepath",
                    tint: ADEPalette.accent
                  ) {
                    Task {
                      do {
                        try await syncService.startLaneRebase(laneId: snapshot.lane.id)
                        await reload(refreshRemote: true)
                      } catch {
                        errorMessage = error.localizedDescription
                      }
                    }
                  }
                  .disabled(!canRunLiveActions)
                }
              }
            }
          }
        }

        if !visibleAutoRebaseAttention.isEmpty {
          LaneInlineGroup(title: "Auto rebase") {
            VStack(spacing: 10) {
              ForEach(visibleAutoRebaseAttention.prefix(3)) { snapshot in
                HStack(alignment: .center, spacing: 10) {
                  VStack(alignment: .leading, spacing: 3) {
                    Text(snapshot.lane.name)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEPalette.textPrimary)
                    Text(snapshot.autoRebaseStatus?.message ?? "Manual follow-up is required.")
                      .font(.caption)
                      .foregroundStyle(ADEPalette.textSecondary)
                      .lineLimit(2)
                  }

                  Spacer(minLength: 8)

                  ADEStatusPill(
                    text: snapshot.autoRebaseStatus?.state == "rebaseConflict" ? "CONFLICT" : "PENDING",
                    tint: snapshot.autoRebaseStatus?.state == "rebaseConflict" ? ADEPalette.danger : ADEPalette.warning
                  )

                  LaneInlineButton(title: "Open lane", symbol: "arrow.right") {
                    detailSheetTarget = LaneDetailSheetTarget(
                      laneId: snapshot.lane.id,
                      snapshot: snapshot,
                      initialSection: .git
                    )
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private var laneListDeck: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 8) {
        Text(scope.title)
          .font(.headline)
          .foregroundStyle(ADEPalette.textPrimary)
        Text("\(filteredSnapshots.count)")
          .font(.system(.caption, design: .monospaced).weight(.semibold))
          .foregroundStyle(ADEPalette.textMuted)
        Spacer()
        if !searchText.isEmpty {
          Text("Filtered")
            .font(.caption)
            .foregroundStyle(ADEPalette.textMuted)
        }
      }

      if filteredSnapshots.isEmpty {
        LaneSurfaceCard {
          Text(emptyStateText)
            .font(.subheadline)
            .foregroundStyle(ADEPalette.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      } else {
        VStack(spacing: 10) {
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
            .buttonStyle(.plain)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
              Button(openLaneIds.contains(snapshot.lane.id) ? "Close" : "Open") {
                toggleOpenLane(snapshot.lane.id)
              }
              .tint(ADEPalette.accent)

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
    }
  }

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
    if openLaneIds.contains(laneId) {
      closeLaneChip(laneId)
    } else {
      openLaneIds.insert(laneId, at: 0)
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

  private var emptyStateText: String {
    switch scope {
    case .active:
      return "No active lanes match this filter."
    case .archived:
      return "No archived lanes match this filter."
    case .all:
      return "No lanes match this filter."
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
              : "Cached lane data is available. Reconnect to confirm lane state, rebase status, and work activity."),
        icon: "bolt.horizontal.circle",
        tint: ADEPalette.warning,
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
        message: "Pulling lane snapshots, stack state, and lane work metadata from the host.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEPalette.accent,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "Lane hydration failed",
        message: laneStatus.lastError ?? "The host connection is up, but lane hydration did not complete cleanly.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEPalette.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      guard laneSnapshots.isEmpty else { return nil }
      return ADENoticeCard(
        title: "No lanes on this host",
        message: "This ADE host does not currently have any lanes to show on iPhone.",
        icon: "square.stack.3d.up.slash",
        tint: ADEPalette.textSecondary,
        actionTitle: nil,
        action: nil
      )
    }
  }
}

private struct LaneSurfaceCard<Content: View>: View {
  let title: String?
  let subtitle: String?
  let cornerRadius: CGFloat
  let padding: CGFloat
  let fill: Color
  let border: Color
  let content: Content

  init(
    title: String? = nil,
    subtitle: String? = nil,
    cornerRadius: CGFloat = 16,
    padding: CGFloat = 16,
    fill: Color = ADEPalette.surfaceBackground,
    border: Color = ADEPalette.border,
    @ViewBuilder content: () -> Content
  ) {
    self.title = title
    self.subtitle = subtitle
    self.cornerRadius = cornerRadius
    self.padding = padding
    self.fill = fill
    self.border = border
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: title == nil && subtitle == nil ? 0 : 14) {
      if let title {
        VStack(alignment: .leading, spacing: 4) {
          Text(title)
            .font(.headline)
            .foregroundStyle(ADEPalette.textPrimary)
          if let subtitle {
            Text(subtitle)
              .font(.subheadline)
              .foregroundStyle(ADEPalette.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }

      content
    }
    .padding(padding)
    .background(
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .fill(fill)
        .overlay(
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .stroke(border.opacity(0.8), lineWidth: 0.5)
        )
    )
    .shadow(color: Color.black.opacity(0.08), radius: 6, x: 0, y: 2)
  }
}

private struct LaneSummaryCountPill: View {
  let label: String
  let value: String
  let tint: Color

  var body: some View {
    VStack(alignment: .trailing, spacing: 2) {
      Text(label)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEPalette.textMuted)
      Text(value)
        .font(.system(.caption, design: .monospaced).weight(.semibold))
        .foregroundStyle(tint)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(tint.opacity(0.24), lineWidth: 1)
    )
  }
}

private struct LaneSearchField: View {
  @Binding var text: String
  let placeholder: String
  @FocusState private var isFocused: Bool

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(isFocused ? ADEPalette.accent : ADEPalette.textMuted)
      TextField(placeholder, text: $text)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.search)
        .foregroundStyle(ADEPalette.textPrimary)
        .focused($isFocused)
      if !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(ADEPalette.textMuted)
        }
        .transition(.scale.combined(with: .opacity))
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 11)
    .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(isFocused ? ADEPalette.accent.opacity(0.5) : ADEPalette.border.opacity(0.75), lineWidth: isFocused ? 1.5 : 1)
    )
    .animation(.easeInOut(duration: 0.2), value: isFocused)
    .animation(.easeInOut(duration: 0.2), value: text.isEmpty)
    .accessibilityLabel("Search lanes")
  }
}

private struct LaneInlineGroup<Content: View>: View {
  let title: String
  let content: Content

  init(title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEPalette.textMuted)
      content
    }
  }
}

private struct LaneFilterChip: View {
  let title: String
  let symbol: String
  let count: Int?
  let isActive: Bool
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Image(systemName: symbol)
          .font(.system(size: 11, weight: .semibold))
        Text(title)
          .font(.system(.caption, design: .monospaced).weight(.semibold))
        if let count {
          Text("\(count)")
            .font(.system(.caption2, design: .monospaced).weight(.medium))
            .foregroundStyle(isActive ? tint : ADEPalette.textMuted)
        }
      }
      .foregroundStyle(isActive ? tint : ADEPalette.textSecondary)
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(isActive ? tint.opacity(0.14) : ADEPalette.recessedBackground)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(isActive ? tint.opacity(0.26) : ADEPalette.border.opacity(0.65), lineWidth: 1)
      )
      .animation(.easeInOut(duration: 0.2), value: isActive)
    }
    .buttonStyle(.plain)
    .sensoryFeedback(.selection, trigger: isActive)
    .accessibilityLabel("\(title)\(count.map { ", \($0) items" } ?? "")")
    .accessibilityAddTraits(isActive ? .isSelected : [])
  }
}

private enum LaneActionProminence {
  case primary
  case secondary
}

private struct LaneActionStripButton: View {
  let title: String
  let symbol: String
  let tint: Color
  let prominence: LaneActionProminence
  let action: () -> Void

  init(title: String, symbol: String, tint: Color, prominence: LaneActionProminence = .secondary, action: @escaping () -> Void) {
    self.title = title
    self.symbol = symbol
    self.tint = tint
    self.prominence = prominence
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        Image(systemName: symbol)
          .font(.system(size: 12, weight: .semibold))
        Text(title)
          .font(.system(.caption, design: .monospaced).weight(.semibold))
      }
      .foregroundStyle(prominence == .primary ? ADEPalette.textPrimary : tint)
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(prominence == .primary ? tint.opacity(0.18) : ADEPalette.recessedBackground)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(prominence == .primary ? tint.opacity(0.3) : ADEPalette.border.opacity(0.65), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
  }
}

private struct LaneSectionMarker: View {
  let title: String
  let detail: String
  let symbol: String
  let tint: Color

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEPalette.textMuted)
        Text(detail)
          .font(.system(.caption, design: .monospaced).weight(.medium))
          .foregroundStyle(ADEPalette.textPrimary)
      }
    }
  }
}

private struct LaneCompactMenuButton: View {
  let title: String
  let tint: Color

  var body: some View {
    HStack(spacing: 6) {
      Text(title)
        .font(.system(.caption, design: .monospaced).weight(.semibold))
      Image(systemName: "chevron.down")
        .font(.system(size: 10, weight: .bold))
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEPalette.border.opacity(0.65), lineWidth: 1)
    )
  }
}

private struct LaneOpenChip: View {
  let snapshot: LaneListSnapshot
  let isPinned: Bool

  var body: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(runtimeTint(bucket: snapshot.runtime.bucket))
        .frame(width: 7, height: 7)
      Text(snapshot.lane.name)
        .font(.system(.caption, design: .monospaced).weight(.semibold))
        .foregroundStyle(ADEPalette.textPrimary)
        .lineLimit(1)
      if isPinned {
        Image(systemName: "pin.fill")
          .font(.system(size: 9))
          .foregroundStyle(ADEPalette.accent)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEPalette.border.opacity(0.65), lineWidth: 1)
    )
    .accessibilityLabel("\(snapshot.lane.name)\(isPinned ? ", pinned" : "")")
  }
}

private struct LaneInlineButton: View {
  let title: String
  let symbol: String
  let tint: Color
  let action: () -> Void

  init(title: String, symbol: String, tint: Color = ADEPalette.accent, action: @escaping () -> Void) {
    self.title = title
    self.symbol = symbol
    self.tint = tint
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Image(systemName: symbol)
          .font(.system(size: 11, weight: .semibold))
        Text(title)
          .font(.system(.caption, design: .monospaced).weight(.semibold))
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
    .buttonStyle(.plain)
  }
}

private struct LaneMetaChip: View {
  let title: String
  let symbol: String
  let tint: Color

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: symbol)
        .font(.system(size: 10, weight: .semibold))
      Text(title)
        .font(.system(.caption2, design: .monospaced).weight(.semibold))
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
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
          .font(.system(.caption, design: .monospaced).weight(.semibold))
      }
      .foregroundStyle(tint)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 14)
      .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(tint.opacity(0.18), lineWidth: 1)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .sensoryFeedback(.impact(weight: .light), trigger: UUID())
    .accessibilityLabel("Launch \(title)")
  }
}

private struct ADEScaleButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.96 : 1.0)
      .opacity(configuration.isPressed ? 0.85 : 1.0)
      .animation(.easeInOut(duration: 0.15), value: configuration.isPressed)
  }
}

private struct LaneSessionCard: View {
  let session: TerminalSessionSummary

  var body: some View {
    LaneSurfaceCard(cornerRadius: 12, padding: 12, fill: ADEPalette.recessedBackground, border: ADEPalette.border.opacity(0.6)) {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text(session.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEPalette.textPrimary)
          Spacer()
          ADEStatusPill(text: session.status.uppercased(), tint: session.status == "running" ? ADEPalette.success : ADEPalette.textSecondary)
        }
        Text(session.laneName)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEPalette.textSecondary)
        if let preview = session.lastOutputPreview {
          Text(preview)
            .font(.caption.monospaced())
            .foregroundStyle(ADEPalette.textMuted)
            .lineLimit(2)
        }
      }
    }
  }
}

private struct LaneChatCard: View {
  let chat: AgentChatSessionSummary

  var body: some View {
    LaneSurfaceCard(cornerRadius: 12, padding: 12, fill: ADEPalette.recessedBackground, border: ADEPalette.border.opacity(0.6)) {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text(chat.title ?? chat.provider.uppercased())
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEPalette.textPrimary)
          Spacer()
          ADEStatusPill(text: chat.status.uppercased(), tint: chat.status == "active" ? ADEPalette.success : ADEPalette.textSecondary)
        }
        Text(chat.model)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEPalette.textSecondary)
        if let preview = chat.lastOutputPreview {
          Text(preview)
            .font(.caption)
            .foregroundStyle(ADEPalette.textMuted)
            .lineLimit(2)
        }
      }
    }
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
        .foregroundStyle(ADEPalette.textMuted)
        .frame(width: 54, alignment: .leading)
      Text(value)
        .font(isMonospaced ? .system(.caption, design: .monospaced) : .subheadline)
        .foregroundStyle(ADEPalette.textPrimary)
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
      .padding(12)
      .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEPalette.border.opacity(0.75), lineWidth: 1)
      )
      .foregroundStyle(ADEPalette.textPrimary)
  }
}

private struct LaneListRow: View {
  let snapshot: LaneListSnapshot
  let isPinned: Bool
  let isOpen: Bool

  var body: some View {
    LaneSurfaceCard(
      cornerRadius: 14,
      padding: 14,
      fill: isOpen ? ADEPalette.surfaceBackground.opacity(0.96) : ADEPalette.surfaceBackground,
      border: isOpen ? ADEPalette.accent.opacity(0.5) : ADEPalette.border.opacity(0.7)
    ) {
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .top, spacing: 12) {
          Circle()
            .fill(runtimeTint(bucket: snapshot.runtime.bucket))
            .frame(width: 9, height: 9)
            .padding(.top, 6)

          VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
              Text(snapshot.lane.name)
                .font(.system(.body).weight(.semibold))
                .foregroundStyle(ADEPalette.textPrimary)
                .lineLimit(1)

              if snapshot.lane.laneType == "primary" {
                ADEStatusPill(text: "PRIMARY", tint: ADEPalette.accent)
              } else if snapshot.lane.laneType == "attached" {
                ADEStatusPill(text: "ATTACHED", tint: ADEPalette.textSecondary)
              }
            }

            HStack(spacing: 8) {
              Text(snapshot.lane.branchRef)
                .font(.system(.caption, design: .monospaced).weight(.medium))
                .foregroundStyle(ADEPalette.textSecondary)
                .lineLimit(1)
              if snapshot.lane.baseRef != snapshot.lane.branchRef {
                Text("from \(snapshot.lane.baseRef)")
                  .font(.caption)
                  .foregroundStyle(ADEPalette.textMuted)
                  .lineLimit(1)
              }
            }
          }

          Spacer(minLength: 8)

          lanePriorityBadge(snapshot: snapshot)
        }

        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            if isPinned {
              LaneMetaChip(title: "Pinned", symbol: "pin.fill", tint: ADEPalette.accent)
            }
            if isOpen {
              LaneMetaChip(title: "Open", symbol: "square.stack.3d.up.fill", tint: ADEPalette.textSecondary)
            }
            if snapshot.lane.status.ahead > 0 {
              LaneMetaChip(title: "\(snapshot.lane.status.ahead)", symbol: "arrow.up", tint: ADEPalette.success)
            }
            if snapshot.lane.status.behind > 0 {
              LaneMetaChip(title: "\(snapshot.lane.status.behind)", symbol: "arrow.down", tint: ADEPalette.warning)
            }
            if snapshot.lane.childCount > 0 {
              LaneMetaChip(title: "\(snapshot.lane.childCount)", symbol: "square.stack.3d.up", tint: ADEPalette.textMuted)
            }
            if snapshot.runtime.sessionCount > 0 {
              LaneMetaChip(title: "\(snapshot.runtime.sessionCount)", symbol: runtimeSymbol(snapshot.runtime.bucket), tint: runtimeTint(bucket: snapshot.runtime.bucket))
            }
          }
        }

        if let activity = laneActivitySummary(snapshot) {
          Text(activity)
            .font(.caption)
            .foregroundStyle(ADEPalette.textMuted)
            .lineLimit(2)
        }
      }
    }
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

@ViewBuilder
private func lanePriorityBadge(snapshot: LaneListSnapshot) -> some View {
  if snapshot.autoRebaseStatus?.state == "rebaseConflict" {
    ADEStatusPill(text: "CONFLICT", tint: ADEPalette.danger)
  } else if snapshot.lane.status.dirty {
    ADEStatusPill(text: "DIRTY", tint: ADEPalette.warning)
  } else if snapshot.runtime.bucket == "running" {
    ADEStatusPill(text: "RUN", tint: ADEPalette.success)
  } else if snapshot.runtime.bucket == "awaiting-input" {
    ADEStatusPill(text: "ATTN", tint: ADEPalette.warning)
  } else if snapshot.lane.archivedAt != nil {
    ADEStatusPill(text: "ARCH", tint: ADEPalette.textMuted)
  } else if let rebaseSuggestion = snapshot.rebaseSuggestion {
    ADEStatusPill(text: "\(rebaseSuggestion.behindCount)\u{2193}", tint: ADEPalette.warning)
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
        VStack(spacing: 16) {
          LaneSurfaceCard(title: "Create lane", subtitle: createAsChild ? "This lane will branch from another ADE lane." : "This lane will branch from the selected base branch.") {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $name)
              LaneTextField("Description", text: $description)
            }
          }

          LaneSurfaceCard(title: "Branching", subtitle: createAsChild ? "Child lanes inherit the selected parent." : "Base branch is taken from the primary lane branch list.") {
            VStack(alignment: .leading, spacing: 12) {
              Toggle("Create as child lane", isOn: $createAsChild)
                .font(.subheadline)
                .foregroundStyle(ADEPalette.textSecondary)

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

          LaneSurfaceCard(title: "Template", subtitle: "Apply a default lane template immediately after creation") {
            Picker("Template", selection: $selectedTemplateId) {
              Text("No template").tag("")
              ForEach(templates) { template in
                Text(template.name).tag(template.id)
              }
            }
            .pickerStyle(.menu)
          }

          if let envProgress {
            LaneSurfaceCard(title: "Environment setup", subtitle: envProgress.overallStatus.capitalized) {
              VStack(alignment: .leading, spacing: 10) {
                ForEach(envProgress.steps) { step in
                  HStack {
                    Text(step.label)
                      .font(.subheadline)
                      .foregroundStyle(ADEPalette.textPrimary)
                    Spacer()
                    Text(step.status)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEPalette.textSecondary)
                  }
                }
              }
            }
          }

          if let errorMessage {
            LaneSurfaceCard(fill: ADEPalette.danger.opacity(0.08), border: ADEPalette.danger.opacity(0.28)) {
              Text(errorMessage)
                .font(.subheadline)
                .foregroundStyle(ADEPalette.danger)
            }
          }
        }
        .padding(16)
      }
      .background(ADEPalette.pageBackground.ignoresSafeArea())
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
        VStack(spacing: 16) {
          LaneSurfaceCard(title: "Attach worktree", subtitle: "Register an existing worktree as a lane without moving it into .ade/worktrees yet.") {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $name)
              LaneTextField("Worktree path", text: $attachedPath)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
              LaneTextField("Description", text: $description)
            }
          }

          LaneSurfaceCard(title: "Path expectations", subtitle: "The path should point at the existing worktree root on the host.") {
            Text("Attached lanes remain externally managed until you adopt them into .ade/worktrees from the lane manage surface.")
              .font(.subheadline)
              .foregroundStyle(ADEPalette.textSecondary)
          }

          if let errorMessage {
            LaneSurfaceCard(fill: ADEPalette.danger.opacity(0.08), border: ADEPalette.danger.opacity(0.28)) {
              Text(errorMessage)
                .font(.subheadline)
                .foregroundStyle(ADEPalette.danger)
            }
          }
        }
        .padding(16)
      }
      .background(ADEPalette.pageBackground.ignoresSafeArea())
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

private struct LaneDetailSheetTarget: Identifiable {
  var id: String { "\(laneId):\(initialSection.rawValue)" }
  let laneId: String
  let snapshot: LaneListSnapshot
  let initialSection: LaneDetailSection
}

private struct LaneDetailScreen: View {
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

  init(
    laneId: String,
    initialSnapshot: LaneListSnapshot,
    allLaneSnapshots: [LaneListSnapshot],
    initialSection: LaneDetailSection = .overview,
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
      LazyVStack(spacing: 16, pinnedViews: [.sectionHeaders]) {
        if let banner = connectionBanner {
          banner
        }
        if let busyAction {
          LaneSurfaceCard {
            HStack(spacing: 10) {
              ProgressView()
              Text("Running \(busyAction)...")
                .font(.subheadline)
                .foregroundStyle(ADEPalette.textSecondary)
              Spacer()
            }
          }
        }
        if let errorMessage {
          LaneSurfaceCard(fill: ADEPalette.danger.opacity(0.08), border: ADEPalette.danger.opacity(0.28)) {
            Text(errorMessage)
              .font(.subheadline)
              .foregroundStyle(ADEPalette.danger)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }

        detailSummaryHeader

        Section {
          selectedSectionContent
        } header: {
          detailSectionSwitcher
            .padding(.bottom, 6)
            .background(ADEPalette.pageBackground.opacity(0.96))
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
    }
    .background(ADEPalette.pageBackground.ignoresSafeArea())
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

  @ViewBuilder
  private var detailSummaryHeader: some View {
    LaneSurfaceCard(
      title: detail?.lane.name ?? currentSnapshot.lane.name,
      subtitle: detail?.lane.description ?? currentSnapshot.lane.description ?? "Lane details"
    ) {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .top, spacing: 10) {
          VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
              Text(detail?.lane.branchRef ?? currentSnapshot.lane.branchRef)
                .font(.system(.headline, design: .monospaced))
                .foregroundStyle(ADEPalette.textPrimary)
              lanePriorityBadge(snapshot: currentSnapshot)
            }

            Text("Base: \(detail?.lane.baseRef ?? currentSnapshot.lane.baseRef)")
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEPalette.textSecondary)
          }

          Spacer(minLength: 10)

          VStack(alignment: .trailing, spacing: 6) {
            if currentSnapshot.lane.laneType == "primary" {
              ADEStatusPill(text: "PRIMARY", tint: ADEPalette.accent)
            } else if currentSnapshot.lane.laneType == "attached" {
              ADEStatusPill(text: "ATTACHED", tint: ADEPalette.textSecondary)
            }
            if currentSnapshot.runtime.sessionCount > 0 {
              ADEStatusPill(text: "\(currentSnapshot.runtime.sessionCount) LIVE", tint: runtimeTint(bucket: currentSnapshot.runtime.bucket))
            }
          }
        }

        Text(detail?.lane.worktreePath ?? currentSnapshot.lane.worktreePath)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEPalette.textMuted)
          .frame(maxWidth: .infinity, alignment: .leading)

        HStack(spacing: 8) {
          if currentSnapshot.lane.status.ahead > 0 {
            LaneMetaChip(title: "\(currentSnapshot.lane.status.ahead) ahead", symbol: "arrow.up", tint: ADEPalette.success)
          }
          if currentSnapshot.lane.status.behind > 0 {
            LaneMetaChip(title: "\(currentSnapshot.lane.status.behind) behind", symbol: "arrow.down", tint: ADEPalette.warning)
          }
          if currentSnapshot.lane.status.dirty {
            LaneMetaChip(title: "Dirty", symbol: "pencil.line", tint: ADEPalette.warning)
          }
          if currentSnapshot.lane.childCount > 0 {
            LaneMetaChip(title: "\(currentSnapshot.lane.childCount) child", symbol: "square.stack.3d.up", tint: ADEPalette.textMuted)
          }
        }

        HStack(spacing: 8) {
          LaneInlineButton(title: "Files", symbol: "folder") {
            Task { await openFiles() }
          }
          LaneInlineButton(title: "Copy path", symbol: "doc.on.doc") {
            UIPasteboard.general.string = detail?.lane.worktreePath ?? currentSnapshot.lane.worktreePath
          }
          LaneInlineButton(title: "Git", symbol: "arrow.triangle.branch", tint: ADEPalette.textSecondary) {
            section = .git
          }
          LaneInlineButton(title: "Work", symbol: "terminal", tint: ADEPalette.textSecondary) {
            section = .work
          }
        }
      }
    }
  }

  @ViewBuilder
  private var detailSectionSwitcher: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(LaneDetailSection.allCases) { item in
          LaneFilterChip(
            title: item.title,
            symbol: item.symbol,
            count: nil,
            isActive: section == item,
            tint: section == item ? ADEPalette.accent : ADEPalette.textSecondary
          ) {
            withAnimation(.easeInOut(duration: 0.25)) {
              section = item
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private var selectedSectionContent: some View {
    if detail == nil && errorMessage == nil {
      LaneSurfaceCard {
        HStack(spacing: 12) {
          ProgressView()
          Text("Loading lane detail...")
            .font(.subheadline)
            .foregroundStyle(ADEPalette.textSecondary)
          Spacer()
        }
      }
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

  @ViewBuilder
  private var overviewSections: some View {
    if let detail {
      VStack(spacing: 16) {
        LaneSurfaceCard(title: "Lane summary", subtitle: "Key references and hand-off points") {
          VStack(alignment: .leading, spacing: 12) {
            LaneInfoRow(label: "Type", value: detail.lane.laneType.capitalized)
            LaneInfoRow(label: "Base", value: detail.lane.baseRef)
            LaneInfoRow(label: "Path", value: detail.lane.worktreePath, isMonospaced: true)
            if let parentLaneId = detail.lane.parentLaneId,
               let parent = allLaneSnapshots.first(where: { $0.lane.id == parentLaneId })?.lane {
              LaneInfoRow(label: "Parent", value: "\(parent.name) (\(parent.branchRef))")
            }

            HStack(spacing: 8) {
              LaneInlineButton(title: "Copy path", symbol: "doc.on.doc") {
                UIPasteboard.general.string = detail.lane.worktreePath
              }
              LaneInlineButton(title: "Files", symbol: "folder") {
                Task { await openFiles() }
              }
              LaneInlineButton(title: "Stack graph", symbol: "list.number") {
                showStackGraph = true
              }
            }
          }
        }

        if detail.autoRebaseStatus != nil || detail.rebaseSuggestion != nil {
          LaneSurfaceCard(title: "Rebase", subtitle: "Keep this lane current with its parent") {
            VStack(alignment: .leading, spacing: 12) {
              if let autoRebaseStatus = detail.autoRebaseStatus, autoRebaseStatus.state != "autoRebased" {
                VStack(alignment: .leading, spacing: 6) {
                  Text(autoRebaseStatus.message ?? "This lane needs manual rebase attention.")
                    .font(.subheadline)
                    .foregroundStyle(ADEPalette.textPrimary)
                  if autoRebaseStatus.conflictCount > 0 {
                    Text("\(autoRebaseStatus.conflictCount) conflict file(s) are blocking auto-rebase.")
                      .font(.caption)
                      .foregroundStyle(ADEPalette.danger)
                  }
                }
              }

              if let rebaseSuggestion = detail.rebaseSuggestion {
                VStack(alignment: .leading, spacing: 6) {
                  Text("Behind parent by \(rebaseSuggestion.behindCount) commit(s).")
                    .font(.subheadline)
                    .foregroundStyle(ADEPalette.textPrimary)
                  Text("Use rebase now for the fastest route, or defer/dismiss if you are waiting on other lane work.")
                    .font(.caption)
                    .foregroundStyle(ADEPalette.textSecondary)
                }
              }

              HStack(spacing: 8) {
                if detail.rebaseSuggestion != nil {
                  LaneInlineButton(title: "Defer", symbol: "clock.badge.pause") {
                    Task { await performAction("defer rebase") { try await syncService.deferRebaseSuggestion(laneId: laneId) } }
                  }
                  LaneInlineButton(title: "Dismiss", symbol: "xmark.circle") {
                    Task { await performAction("dismiss rebase") { try await syncService.dismissRebaseSuggestion(laneId: laneId) } }
                  }
                }
                Spacer(minLength: 8)
                LaneInlineButton(title: "Open Git", symbol: "arrow.triangle.branch", tint: ADEPalette.textSecondary) {
                  section = .git
                }
                LaneInlineButton(title: "Rebase now", symbol: "arrow.triangle.2.circlepath", tint: ADEPalette.accent) {
                  Task { await performAction("rebase lane") { try await syncService.startLaneRebase(laneId: laneId) } }
                }
                .disabled(!canRunLiveActions)
              }
            }
          }
        }

        if let conflictStatus = detail.conflictStatus {
          LaneSurfaceCard(title: "Conflicts", subtitle: conflictSummary(conflictStatus)) {
            VStack(alignment: .leading, spacing: 10) {
              if detail.overlaps.isEmpty {
                Text("No overlap detail is currently attached to this lane.")
                  .font(.caption)
                  .foregroundStyle(ADEPalette.textSecondary)
              } else {
                ForEach(detail.overlaps) { overlap in
                  VStack(alignment: .leading, spacing: 8) {
                    HStack {
                      Text(overlap.peerName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ADEPalette.textPrimary)
                      Spacer()
                      ADEStatusPill(
                        text: overlap.riskLevel.uppercased(),
                        tint: overlap.riskLevel == "high" ? ADEPalette.danger : ADEPalette.warning
                      )
                    }

                    ForEach(overlap.files.prefix(4)) { file in
                      HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "arrow.triangle.branch")
                          .font(.system(size: 10))
                          .foregroundStyle(ADEPalette.textMuted)
                          .padding(.top, 3)
                        VStack(alignment: .leading, spacing: 2) {
                          Text(file.path)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(ADEPalette.textPrimary)
                          Text(file.conflictType)
                            .font(.caption2)
                            .foregroundStyle(ADEPalette.textSecondary)
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }

        LaneSurfaceCard(title: "Stack", subtitle: "Hierarchy and child lanes") {
          VStack(alignment: .leading, spacing: 12) {
            if detail.stackChain.isEmpty {
              Text("No stack chain available.")
                .font(.subheadline)
                .foregroundStyle(ADEPalette.textSecondary)
            } else {
              ForEach(detail.stackChain) { item in
                HStack(alignment: .center, spacing: 10) {
                  Circle()
                    .fill(item.laneId == laneId ? ADEPalette.accent : runtimeTint(bucket: detail.runtime.bucket))
                    .frame(width: 7, height: 7)
                  Text(String(repeating: "  ", count: item.depth) + item.laneName)
                    .font(.subheadline)
                    .foregroundStyle(ADEPalette.textPrimary)
                  Spacer()
                  Text(item.branchRef)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ADEPalette.textSecondary)
                }
              }
            }

            if !detail.children.isEmpty {
              Divider()
                .overlay(ADEPalette.border.opacity(0.75))
              VStack(alignment: .leading, spacing: 8) {
                Text("Children")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(ADEPalette.textMuted)
                ForEach(detail.children) { child in
                  HStack {
                    Text(child.name)
                      .font(.subheadline)
                      .foregroundStyle(ADEPalette.textPrimary)
                    Spacer()
                    Text(child.branchRef)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEPalette.textSecondary)
                  }
                }
              }
            }
          }
        }

        if summarizeState(detail.stateSnapshot?.agentSummary) != nil || summarizeState(detail.stateSnapshot?.missionSummary) != nil {
          LaneSurfaceCard(title: "Live state", subtitle: "Agent and mission context carried on the lane") {
            VStack(alignment: .leading, spacing: 12) {
              if let stateText = summarizeState(detail.stateSnapshot?.agentSummary) {
                LaneInlineGroup(title: "Agent") {
                  Text(stateText)
                    .font(.subheadline)
                    .foregroundStyle(ADEPalette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
              }

              if let missionText = summarizeState(detail.stateSnapshot?.missionSummary) {
                LaneInlineGroup(title: "Mission") {
                  Text(missionText)
                    .font(.subheadline)
                    .foregroundStyle(ADEPalette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
              }
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private var gitSections: some View {
    if let detail {
      VStack(spacing: 16) {
        LaneSurfaceCard(title: "Sync", subtitle: detail.syncStatus.map(syncSummary) ?? "Host sync status is not available for this lane.") {
          VStack(alignment: .leading, spacing: 12) {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 8) {
                LaneInlineButton(title: "Fetch", symbol: "arrow.down.circle") {
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
                  LaneCompactMenuButton(title: "Pull", tint: ADEPalette.textSecondary)
                }
                LaneInlineButton(title: detail.syncStatus?.hasUpstream == false ? "Publish" : "Push", symbol: "arrow.up.circle", tint: ADEPalette.accent) {
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
                  LaneCompactMenuButton(title: "More", tint: ADEPalette.textSecondary)
                }
              }
            }

            if let upstreamRef = detail.syncStatus?.upstreamRef {
              LaneInfoRow(label: "Upstream", value: upstreamRef, isMonospaced: true)
            }
          }
        }

        LaneSurfaceCard(title: "Commit", subtitle: amendCommit ? "Amend is on for the next commit." : "Generate a message or type one directly.") {
          VStack(alignment: .leading, spacing: 12) {
            TextField("Commit message", text: $commitMessage, axis: .vertical)
              .textFieldStyle(.plain)
              .padding(12)
              .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                  .stroke(ADEPalette.border.opacity(0.75), lineWidth: 1)
              )

            Toggle("Amend latest commit", isOn: $amendCommit)
              .font(.subheadline)
              .foregroundStyle(ADEPalette.textSecondary)

            HStack(spacing: 8) {
              LaneInlineButton(title: "Generate", symbol: "sparkles") {
                Task {
                  do {
                    commitMessage = try await syncService.generateCommitMessage(laneId: laneId, amend: amendCommit)
                  } catch {
                    errorMessage = error.localizedDescription
                  }
                }
              }
              LaneInlineButton(title: "Commit", symbol: "checkmark.circle.fill", tint: ADEPalette.accent) {
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
          LaneSurfaceCard(title: "Unstaged files", subtitle: "Review, open, stage, or discard individual files") {
            VStack(alignment: .leading, spacing: 12) {
              if diffChanges.unstaged.count > 1 {
                LaneInlineButton(title: "Stage all", symbol: "plus.circle.fill", tint: ADEPalette.accent) {
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
          LaneSurfaceCard(title: "Staged files", subtitle: "Diff, open, unstage, or restore staged work") {
            VStack(alignment: .leading, spacing: 12) {
              if diffChanges.staged.count > 1 {
                LaneInlineButton(title: "Unstage all", symbol: "minus.circle", tint: ADEPalette.warning) {
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
          LaneSurfaceCard(title: "Stashes", subtitle: "Park or restore work without changing the lane state") {
            VStack(alignment: .leading, spacing: 12) {
              TextField("Stash message", text: $stashMessage)
                .textFieldStyle(.plain)
                .padding(12)
                .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(ADEPalette.border.opacity(0.75), lineWidth: 1)
                )

              LaneInlineButton(title: "Create stash", symbol: "tray.and.arrow.down", tint: ADEPalette.accent) {
                Task { await performAction("stash") { try await syncService.stashPush(laneId: laneId, message: stashMessage, includeUntracked: true) } }
              }

              ForEach(detail.stashes) { stash in
                VStack(alignment: .leading, spacing: 8) {
                  HStack {
                    Text(stash.subject)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEPalette.textPrimary)
                    Spacer()
                    if let createdAt = stash.createdAt {
                      Text(relativeTimestamp(createdAt))
                        .font(.caption)
                        .foregroundStyle(ADEPalette.textMuted)
                    }
                  }
                  HStack(spacing: 8) {
                    LaneInlineButton(title: "Apply", symbol: "tray.and.arrow.up") {
                      Task { await performAction("stash apply") { try await syncService.stashApply(laneId: laneId, stashRef: stash.ref) } }
                    }
                    LaneInlineButton(title: "Pop", symbol: "arrow.up.right.square") {
                      Task { await performAction("stash pop") { try await syncService.stashPop(laneId: laneId, stashRef: stash.ref) } }
                    }
                    LaneInlineButton(title: "Drop", symbol: "trash", tint: ADEPalette.danger) {
                      Task { await performAction("stash drop") { try await syncService.stashDrop(laneId: laneId, stashRef: stash.ref) } }
                    }
                  }
                }
                if stash.id != detail.stashes.last?.id {
                  Divider()
                    .overlay(ADEPalette.border.opacity(0.75))
                }
              }
            }
          }
        }

        if !detail.recentCommits.isEmpty {
          LaneSurfaceCard(title: "Recent commits", subtitle: "Review commit metadata and act without leaving the lane") {
            VStack(alignment: .leading, spacing: 12) {
              ForEach(detail.recentCommits) { commit in
                VStack(alignment: .leading, spacing: 8) {
                  HStack {
                    Text(commit.subject)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEPalette.textPrimary)
                    Spacer()
                    Text(commit.shortSha)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEPalette.textSecondary)
                  }
                  Text("\(commit.authorName) • \(relativeTimestamp(commit.authoredAt))")
                    .font(.caption)
                    .foregroundStyle(ADEPalette.textSecondary)

                  ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                      LaneInlineButton(title: "Diff", symbol: "doc.text.magnifyingglass") {
                        Task {
                          do {
                            let files = try await syncService.listCommitFiles(laneId: laneId, commitSha: commit.sha)
                            guard let path = files.first else {
                              errorMessage = "This commit does not include any file diffs."
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
                      LaneInlineButton(title: "Message", symbol: "text.alignleft") {
                        Task {
                          do {
                            commitMessage = try await syncService.getCommitMessage(laneId: laneId, commitSha: commit.sha)
                          } catch {
                            errorMessage = error.localizedDescription
                          }
                        }
                      }
                      LaneInlineButton(title: "Revert", symbol: "arrow.uturn.backward", tint: ADEPalette.warning) {
                        Task { await performAction("revert commit") { try await syncService.revertCommit(laneId: laneId, commitSha: commit.sha) } }
                      }
                      LaneInlineButton(title: "Cherry-pick", symbol: "arrow.triangle.merge") {
                        Task { await performAction("cherry pick") { try await syncService.cherryPickCommit(laneId: laneId, commitSha: commit.sha) } }
                      }
                    }
                  }
                }

                if commit.id != detail.recentCommits.last?.id {
                  Divider()
                    .overlay(ADEPalette.border.opacity(0.75))
                }
              }
            }
          }
        }

        if let conflictState = detail.conflictState, conflictState.inProgress {
          LaneSurfaceCard(title: "Rebase conflict", subtitle: "Git reports a \(conflictState.kind ?? "merge") in progress.") {
            VStack(alignment: .leading, spacing: 12) {
              if !conflictState.conflictedFiles.isEmpty {
                ForEach(conflictState.conflictedFiles, id: \.self) { path in
                  Text(path)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ADEPalette.textSecondary)
                }
              }
              HStack(spacing: 8) {
                LaneInlineButton(title: "Continue", symbol: "play.fill", tint: ADEPalette.accent) {
                  Task { await performAction("rebase continue") { try await syncService.rebaseContinueGit(laneId: laneId) } }
                }
                .disabled(!conflictState.canContinue)
                LaneInlineButton(title: "Abort", symbol: "xmark.circle", tint: ADEPalette.danger) {
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

  @ViewBuilder
  private var workSections: some View {
    if let detail {
      VStack(spacing: 16) {
        LaneSurfaceCard(title: "Launch", subtitle: "Start work for this lane without leaving the detail screen") {
          VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
              LaneLaunchTile(title: "Shell", symbol: "terminal", tint: ADEPalette.textSecondary) {
                Task {
                  await performAction("launch shell") {
                    try await syncService.runQuickCommand(laneId: laneId, title: "Shell", toolType: "shell", tracked: trackedLaunch)
                  }
                }
              }
              LaneLaunchTile(title: "Codex", symbol: "sparkle", tint: ADEPalette.accent) {
                chatLaunchTarget = LaneChatLaunchTarget(provider: "codex")
              }
              LaneLaunchTile(title: "Claude", symbol: "brain.head.profile", tint: ADEPalette.warning) {
                chatLaunchTarget = LaneChatLaunchTarget(provider: "claude")
              }
            }

            Toggle("Track sessions", isOn: $trackedLaunch)
              .font(.subheadline)
              .foregroundStyle(ADEPalette.textSecondary)

            LaneInlineButton(title: "Open in Files", symbol: "folder", tint: ADEPalette.accent) {
              Task { await openFiles() }
            }
          }
        }

        if !detail.sessions.isEmpty {
          LaneSurfaceCard(title: "Workspace sessions", subtitle: "\(detail.sessions.count) lane-scoped session(s)") {
            VStack(alignment: .leading, spacing: 12) {
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
          LaneSurfaceCard(title: "AI chats", subtitle: "\(detail.chatSessions.count) lane-scoped chat(s)") {
            VStack(alignment: .leading, spacing: 12) {
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

  @ViewBuilder
  private var manageSections: some View {
    if let detail {
      VStack(spacing: 16) {
        LaneSurfaceCard(title: "Identity", subtitle: "Rename the lane without changing its branch history") {
          VStack(alignment: .leading, spacing: 12) {
            LaneTextField("Lane name", text: $renameText)
            LaneInlineButton(title: "Save name", symbol: "checkmark.circle.fill", tint: ADEPalette.accent) {
              Task { await performAction("rename lane") { try await syncService.renameLane(laneId, name: renameText) } }
            }
            .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || renameText == detail.lane.name)
          }
        }

        LaneSurfaceCard(title: "Appearance", subtitle: "Keep the lane recognizable in dense views") {
          VStack(alignment: .leading, spacing: 12) {
            LaneTextField("Color token or hex", text: $colorText)
              .textInputAutocapitalization(.never)
            LaneTextField("Icon (star, flag, bolt, shield, tag)", text: $iconText)
              .textInputAutocapitalization(.never)
            LaneTextField("Tags (comma separated)", text: $tagsText)
            LaneInlineButton(title: "Save appearance", symbol: "paintpalette", tint: ADEPalette.accent) {
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
          LaneSurfaceCard(title: "Reparent", subtitle: "Move the lane under a different parent lane") {
            VStack(alignment: .leading, spacing: 12) {
              Picker("Parent lane", selection: $selectedParentLaneId) {
                Text("Select parent").tag("")
                ForEach(reparentCandidates) { lane in
                  Text("\(lane.name) (\(lane.branchRef))").tag(lane.id)
                }
              }
              .pickerStyle(.menu)

              LaneInlineButton(title: "Save parent", symbol: "arrow.triangle.swap", tint: ADEPalette.accent) {
                Task { await performAction("reparent lane") { try await syncService.reparentLane(laneId, newParentLaneId: selectedParentLaneId) } }
              }
              .disabled(selectedParentLaneId.isEmpty)
            }
          }
        }

        if detail.lane.laneType == "attached" && detail.lane.archivedAt == nil {
          LaneSurfaceCard(title: "Attached lane", subtitle: "Adopt this worktree into .ade/worktrees so ADE manages lifecycle end-to-end") {
            LaneInlineButton(title: "Move to ADE-managed worktree", symbol: "arrow.down.doc", tint: ADEPalette.accent) {
              Task { await performAction("adopt attached lane") { _ = try await syncService.adoptAttachedLane(laneId) } }
            }
          }
        }

        LaneSurfaceCard(title: detail.lane.archivedAt == nil ? "Archive" : "Restore", subtitle: detail.lane.archivedAt == nil ? "Hide the lane from the active view without deleting it." : "Return the lane to the active view.") {
          if detail.lane.archivedAt == nil {
            LaneInlineButton(title: "Archive lane", symbol: "archivebox", tint: ADEPalette.warning) {
              Task { await performAction("archive lane") { try await syncService.archiveLane(laneId) } }
            }
            .disabled(detail.lane.laneType == "primary")
          } else {
            LaneInlineButton(title: "Restore lane", symbol: "tray.and.arrow.up", tint: ADEPalette.accent) {
              Task { await performAction("restore lane") { try await syncService.unarchiveLane(laneId) } }
            }
          }
        }

        if detail.lane.laneType != "primary" {
          LaneSurfaceCard(title: "Danger zone", subtitle: "Deletion is destructive and requires exact confirmation") {
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
                  .foregroundStyle(ADEPalette.textSecondary)

                LaneTextField("Type delete \(detail.lane.name) to confirm", text: $deleteConfirmText)

                LaneInlineButton(title: "Delete lane", symbol: "trash", tint: ADEPalette.danger) {
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
            .tint(ADEPalette.danger)
          }
        }
      }
    }
  }

  private var connectionBanner: ADENoticeCard? {
    guard !canRunLiveActions else { return nil }
    return ADENoticeCard(
      title: "Showing cached lane detail",
      message: "Reconnect to refresh git state, work sessions, chat threads, and lane actions from the host.",
      icon: "icloud.slash",
      tint: ADEPalette.warning,
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
        errorMessage = "No Files workspace is available for this lane."
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

  private func seedForms(from detail: LaneDetailPayload) {
    renameText = detail.lane.name
    colorText = detail.lane.color ?? ""
    iconText = detail.lane.icon?.rawValue ?? ""
    tagsText = detail.lane.tags.joined(separator: ", ")
    selectedParentLaneId = detail.lane.parentLaneId ?? ""
  }

  @ViewBuilder
  private func fileRow(file: FileChange, mode: String) -> some View {
    LaneSurfaceCard(cornerRadius: 12, padding: 12, fill: ADEPalette.recessedBackground, border: ADEPalette.border.opacity(0.6)) {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .top, spacing: 10) {
          VStack(alignment: .leading, spacing: 4) {
            Text(file.path)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEPalette.textPrimary)
              .lineLimit(2)
            Text(mode == "unstaged" ? "Unstaged change" : "Staged change")
              .font(.caption2)
              .foregroundStyle(ADEPalette.textMuted)
          }
          Spacer()
          ADEStatusPill(text: file.kind.uppercased(), tint: file.kind == "modified" ? ADEPalette.warning : ADEPalette.textSecondary)
        }

        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            LaneInlineButton(title: "Diff", symbol: "doc.text.magnifyingglass") {
              selectedDiffRequest = LaneDiffRequest(
                laneId: laneId,
                path: file.path,
                mode: mode,
                compareRef: nil,
                compareTo: nil,
                title: file.path
              )
            }
            LaneInlineButton(title: "Files", symbol: "folder") {
              Task { await openFiles(path: file.path) }
            }
            if mode == "unstaged" {
              LaneInlineButton(title: "Stage", symbol: "plus.circle.fill", tint: ADEPalette.accent) {
                Task { await performAction("stage file") { try await syncService.stageFile(laneId: laneId, path: file.path) } }
              }
              LaneInlineButton(title: "Discard", symbol: "trash", tint: ADEPalette.danger) {
                Task { await performAction("discard file") { try await syncService.discardFile(laneId: laneId, path: file.path) } }
              }
            } else {
              LaneInlineButton(title: "Unstage", symbol: "minus.circle", tint: ADEPalette.warning) {
                Task { await performAction("unstage file") { try await syncService.unstageFile(laneId: laneId, path: file.path) } }
              }
              LaneInlineButton(title: "Restore", symbol: "trash", tint: ADEPalette.danger) {
                Task { await performAction("restore staged file") { try await syncService.restoreStagedFile(laneId: laneId, path: file.path) } }
              }
            }
          }
        }
      }
    }
  }
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
        VStack(spacing: 16) {
          LaneSurfaceCard(title: providerTitle, subtitle: "Launch a lane-scoped \(providerTitle) chat from the Lanes tab.") {
            HStack(alignment: .center, spacing: 12) {
              Image(systemName: provider == "claude" ? "brain.head.profile" : "sparkle")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(ADEPalette.accent)
              VStack(alignment: .leading, spacing: 4) {
                Text(selectedModel?.displayName ?? "Choose a model")
                  .font(.subheadline.weight(.semibold))
                  .foregroundStyle(ADEPalette.textPrimary)
                Text("Session stays lane-scoped and visible from the Work section.")
                  .font(.caption)
                  .foregroundStyle(ADEPalette.textSecondary)
              }
              Spacer()
            }
          }

          if !models.isEmpty {
            LaneSurfaceCard(title: "Model", subtitle: "Use the host-provided list for this provider") {
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
                        .font(.subheadline)
                        .foregroundStyle(ADEPalette.textSecondary)
                    }
                    HStack(spacing: 8) {
                      if let family = selectedModel.family, !family.isEmpty {
                        LaneMetaChip(title: family, symbol: "circle.grid.2x2.fill", tint: ADEPalette.textSecondary)
                      }
                      if selectedModel.supportsReasoning == true {
                        LaneMetaChip(title: "Reasoning", symbol: "brain", tint: ADEPalette.accent)
                      }
                      if selectedModel.supportsTools == true {
                        LaneMetaChip(title: "Tools", symbol: "hammer.fill", tint: ADEPalette.success)
                      }
                    }
                  }
                }
              }
            }
          }

          if let reasoningEfforts = selectedModel?.reasoningEfforts, !reasoningEfforts.isEmpty {
            LaneSurfaceCard(title: "Reasoning", subtitle: "Default keeps the provider’s standard behavior") {
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
                    .foregroundStyle(ADEPalette.textSecondary)
                } else {
                  Text("Use the provider default unless you need a stronger or lighter pass.")
                    .font(.caption)
                    .foregroundStyle(ADEPalette.textSecondary)
                }
              }
            }
          }

          if let errorMessage {
            LaneSurfaceCard(fill: ADEPalette.danger.opacity(0.08), border: ADEPalette.danger.opacity(0.28)) {
              Text(errorMessage)
                .font(.subheadline)
                .foregroundStyle(ADEPalette.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }

          if busy {
            LaneSurfaceCard(cornerRadius: 12, padding: 12, fill: ADEPalette.recessedBackground, border: ADEPalette.border.opacity(0.6)) {
              HStack(spacing: 10) {
                ProgressView()
                Text("Creating lane-scoped \(providerTitle) chat…")
                  .font(.subheadline)
                  .foregroundStyle(ADEPalette.textSecondary)
                Spacer()
              }
            }
          }
        }
        .padding(16)
      }
      .background(ADEPalette.pageBackground.ignoresSafeArea())
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
        VStack(spacing: 16) {
          LaneSurfaceCard(title: "Selected lanes", subtitle: "\(laneIds.count) lane\(laneIds.count == 1 ? "" : "s") currently targeted") {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(snapshots) { snapshot in
                HStack(alignment: .top, spacing: 10) {
                  Circle()
                    .fill(runtimeTint(bucket: snapshot.runtime.bucket))
                    .frame(width: 8, height: 8)
                    .padding(.top, 6)
                  VStack(alignment: .leading, spacing: 4) {
                    Text(snapshot.lane.name)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEPalette.textPrimary)
                    Text(snapshot.lane.branchRef)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEPalette.textSecondary)
                  }
                  Spacer()
                  if snapshot.lane.status.dirty {
                    ADEStatusPill(text: "DIRTY", tint: ADEPalette.warning)
                  }
                }
              }
            }
          }

          LaneSurfaceCard(title: "Archive", subtitle: "Hide selected lanes without deleting worktrees or branches") {
            Button {
              Task { await archiveSelected() }
            } label: {
              HStack {
                Image(systemName: "archivebox.fill")
                Text("Archive selected lanes")
                  .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                Spacer()
              }
              .foregroundStyle(ADEPalette.warning)
              .padding(12)
              .background(ADEPalette.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(busy || laneIds.isEmpty)
          }

          LaneSurfaceCard(title: "Delete", subtitle: "This removes the worktree, and optionally the branch, for every selected lane.") {
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
                .foregroundStyle(ADEPalette.textSecondary)

              LaneTextField("Type delete open lanes to confirm", text: $confirmText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

              Button(role: .destructive) {
                Task { await deleteSelected() }
              } label: {
                HStack {
                  Image(systemName: "trash.fill")
                  Text("Delete selected lanes")
                    .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                  Spacer()
                }
                .padding(12)
                .background(ADEPalette.danger.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
              }
              .buttonStyle(.plain)
              .disabled(confirmText.lowercased() != "delete open lanes" || busy || laneIds.isEmpty)
            }
          }

          if let errorMessage {
            LaneSurfaceCard(fill: ADEPalette.danger.opacity(0.08), border: ADEPalette.danger.opacity(0.28)) {
              Text(errorMessage)
                .font(.subheadline)
                .foregroundStyle(ADEPalette.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
        }
        .padding(16)
      }
      .background(ADEPalette.pageBackground.ignoresSafeArea())
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
    let laneById = Dictionary(uniqueKeysWithValues: snapshots.map { ($0.lane.id, $0) })
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

    let primaryBranch = primaryId.flatMap { laneById[$0] }.map { [$0] + visit(parentId: $0.lane.id) } ?? []
    let seen = Set(primaryBranch.map(\.lane.id))
    let remaining = snapshots.filter { !seen.contains($0.lane.id) }.sorted { $0.lane.createdAt < $1.lane.createdAt }
    return primaryBranch + remaining
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 16) {
          LaneSurfaceCard(title: "Stack graph", subtitle: "Primary lane first, then children in creation order") {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(orderedSnapshots) { snapshot in
                HStack(alignment: .top, spacing: 12) {
                  HStack(spacing: 0) {
                    if snapshot.lane.stackDepth > 0 {
                      Rectangle()
                        .fill(ADEPalette.border.opacity(0.55))
                        .frame(width: CGFloat(snapshot.lane.stackDepth) * 12, height: 1)
                        .padding(.top, 10)
                    }
                    Circle()
                      .fill(snapshot.lane.id == selectedLaneId ? ADEPalette.accent : runtimeTint(bucket: snapshot.runtime.bucket))
                      .frame(width: 9, height: 9)
                      .padding(.top, 6)
                  }
                  VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                      Text(snapshot.lane.name)
                        .font(.subheadline.weight(snapshot.lane.id == selectedLaneId ? .semibold : .regular))
                        .foregroundStyle(ADEPalette.textPrimary)
                        .lineLimit(1)
                      if snapshot.lane.id == selectedLaneId {
                        ADEStatusPill(text: "CURRENT", tint: ADEPalette.accent)
                      }
                    }
                    Text(snapshot.lane.branchRef)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEPalette.textSecondary)
                  }
                  Spacer()
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 10)
                .background(
                  RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(snapshot.lane.id == selectedLaneId ? ADEPalette.accent.opacity(0.1) : ADEPalette.recessedBackground)
                )
              }
            }
          }
        }
        .padding(16)
      }
      .background(ADEPalette.pageBackground.ignoresSafeArea())
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
      VStack(spacing: 12) {
        ScrollView {
          VStack(spacing: 16) {
            LaneSurfaceCard(title: request.title, subtitle: request.mode.replacingOccurrences(of: "_", with: " ").capitalized) {
              VStack(alignment: .leading, spacing: 10) {
                if let path = request.path {
                  Text(path)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ADEPalette.textSecondary)
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
              LaneSurfaceCard(fill: ADEPalette.danger.opacity(0.08), border: ADEPalette.danger.opacity(0.28)) {
                Text(errorMessage)
                  .font(.subheadline)
                  .foregroundStyle(ADEPalette.danger)
                  .frame(maxWidth: .infinity, alignment: .leading)
              }
            }

            if diff != nil {
              LaneSurfaceCard(cornerRadius: 12, padding: 12, fill: ADEPalette.surfaceBackground, border: ADEPalette.border.opacity(0.65)) {
                Picker("Side", selection: $side) {
                  Text("Original").tag("original")
                  Text("Modified").tag("modified")
                }
                .pickerStyle(.segmented)
              }
            }
          }
          .padding(16)
        }

        if let diff {
          if diff.isBinary == true {
            LaneSurfaceCard(title: "Binary diff", subtitle: "Binary content is view-only on iPhone.") {
              Text("Open the file in Files or switch to desktop to edit this binary change.")
                .font(.subheadline)
                .foregroundStyle(ADEPalette.textSecondary)
            }
            .padding(.horizontal, 16)
          } else {
            VStack(alignment: .leading, spacing: 8) {
              HStack {
                Text(side == "original" ? "Original" : "Modified")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(ADEPalette.textMuted)
                Spacer()
                if request.mode == "unstaged" && side == "modified" {
                  Text("Editable")
                    .font(.system(.caption2, design: .monospaced).weight(.semibold))
                    .foregroundStyle(ADEPalette.accent)
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
              .padding(12)
              .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                  .stroke(ADEPalette.border.opacity(0.75), lineWidth: 1)
              )
              .disabled(side == "original")
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
          }
        } else {
          Spacer()
          ProgressView()
          Spacer()
        }
      }
      .background(ADEPalette.pageBackground.ignoresSafeArea())
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

private struct LaneSessionTranscriptView: View {
  @EnvironmentObject private var syncService: SyncService
  let session: TerminalSessionSummary

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        LaneSurfaceCard(title: session.title, subtitle: session.laneName) {
          HStack(spacing: 8) {
            ADEStatusPill(text: session.status.uppercased(), tint: session.status == "running" ? ADEPalette.success : ADEPalette.textSecondary)
            if let goal = session.goal, !goal.isEmpty {
              Text(goal)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ADEPalette.textSecondary)
                .lineLimit(1)
            }
          }
        }

        LaneSurfaceCard(title: "Transcript", subtitle: "Live terminal output for this session") {
          Text(syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? "No output yet.")
            .frame(maxWidth: .infinity, alignment: .leading)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEPalette.textSecondary)
            .textSelection(.enabled)
            .padding(12)
            .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
      }
      .padding(16)
    }
    .background(ADEPalette.pageBackground.ignoresSafeArea())
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
        VStack(spacing: 16) {
          LaneSurfaceCard(title: summary.title ?? summary.provider.uppercased(), subtitle: summary.model) {
            HStack(spacing: 8) {
              ADEStatusPill(text: summary.status.uppercased(), tint: summary.status == "active" ? ADEPalette.success : ADEPalette.textSecondary)
              if let goal = summary.goal, !goal.isEmpty {
                Text(goal)
                  .font(.system(.caption, design: .monospaced))
                  .foregroundStyle(ADEPalette.textSecondary)
                  .lineLimit(1)
              }
            }
          }

          if let errorMessage {
            LaneSurfaceCard(fill: ADEPalette.danger.opacity(0.08), border: ADEPalette.danger.opacity(0.28)) {
              Text(errorMessage)
                .font(.subheadline)
                .foregroundStyle(ADEPalette.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }

          if transcript.isEmpty {
            LaneSurfaceCard(title: "Transcript", subtitle: "Messages appear here as the lane chat progresses") {
              Text("No chat messages yet.")
                .font(.subheadline)
                .foregroundStyle(ADEPalette.textSecondary)
            }
          } else {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(transcript) { entry in
                VStack(alignment: .leading, spacing: 6) {
                  Text(entry.role.uppercased())
                    .font(.system(.caption2, design: .monospaced).weight(.bold))
                    .foregroundStyle(entry.role == "assistant" ? ADEPalette.accent : ADEPalette.textMuted)
                  Text(entry.text)
                    .font(.body)
                    .foregroundStyle(ADEPalette.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                  Text(relativeTimestamp(entry.timestamp))
                    .font(.caption2)
                    .foregroundStyle(ADEPalette.textMuted)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                  RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(entry.role == "assistant" ? ADEPalette.accent.opacity(0.08) : ADEPalette.recessedBackground)
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
        LaneSurfaceCard(title: "Reply", subtitle: "Send a lane-scoped follow-up to this chat session") {
          VStack(alignment: .leading, spacing: 12) {
            TextField("Send a message", text: $composer, axis: .vertical)
              .textFieldStyle(.plain)
              .padding(12)
              .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                  .stroke(ADEPalette.border.opacity(0.7), lineWidth: 1)
              )

            Button {
              Task {
                await sendMessage()
                withAnimation(.snappy) {
                  proxy.scrollTo("lane-chat-end", anchor: .bottom)
                }
              }
            } label: {
              HStack {
                if sending {
                  ProgressView()
                    .tint(ADEPalette.textPrimary)
                } else {
                  Image(systemName: "paperplane.fill")
                }
                Text("Send")
                  .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                Spacer()
              }
              .foregroundStyle(ADEPalette.textPrimary)
              .padding(12)
              .background(ADEPalette.accent.opacity(0.18), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
          }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(ADEPalette.pageBackground.opacity(0.96))
      }
      .onChange(of: transcript.count) { _, _ in
        withAnimation(.snappy) {
          proxy.scrollTo("lane-chat-end", anchor: .bottom)
        }
      }
    }
    .background(ADEPalette.pageBackground.ignoresSafeArea())
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
    return ADEPalette.success
  case "awaiting-input":
    return ADEPalette.warning
  case "ended":
    return ADEPalette.textMuted
  default:
    return ADEPalette.textSecondary
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
    return "No upstream yet. Publish this lane to create and track a remote branch."
  }
  if status.diverged {
    return "Local and remote history diverged. Rebase or pull before pushing."
  }
  if status.ahead > 0 && status.behind == 0 {
    return "Ahead by \(status.ahead) commit(s). Push to publish your local work."
  }
  if status.behind > 0 && status.ahead == 0 {
    return "Behind by \(status.behind) commit(s). Pull or rebase to catch up."
  }
  return "Local and remote are in sync."
}

private func conflictSummary(_ status: ConflictStatus) -> String {
  switch status.status {
  case "conflict-active":
    return "\(status.overlappingFileCount) overlapping file(s) are in active conflict."
  case "conflict-predicted":
    return "\(status.overlappingFileCount) overlapping file(s) are predicted to conflict across \(status.peerConflictCount) peer lane(s)."
  case "behind-base":
    return "This lane is behind its base and should be rebased before merging."
  case "merge-ready":
    return "Conflict prediction is clear. This lane is merge-ready."
  default:
    return "Conflict status is available from the host."
  }
}
