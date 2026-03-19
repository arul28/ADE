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

  var body: some View {
    NavigationStack {
      List {
        if let notice = statusNotice {
          notice
            .listRowBackground(Color.clear)
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
          .listRowBackground(Color.clear)
        }

        Section {
          Picker("Scope", selection: $scope) {
            ForEach(LaneListScope.allCases) { option in
              Text(option.title).tag(option)
            }
          }
          .pickerStyle(.segmented)

          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
              ForEach(LaneRuntimeFilter.allCases) { filter in
                Button {
                  runtimeFilter = filter
                } label: {
                  HStack(spacing: 6) {
                    Circle()
                      .fill(runtimeTint(bucket: filter.rawValue))
                      .frame(width: 8, height: 8)
                    Text(filter.title)
                      .font(.system(.caption, design: .monospaced))
                    Text("\(count(for: filter))")
                      .font(.system(.caption2, design: .monospaced))
                      .foregroundStyle(ADEPalette.textMuted)
                  }
                  .padding(.horizontal, 10)
                  .padding(.vertical, 8)
                  .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                      .fill(runtimeFilter == filter ? ADEPalette.accent.opacity(0.16) : ADEPalette.recessedBackground)
                  )
                }
                .buttonStyle(.plain)
              }
            }
          }

          if let primaryLane {
            VStack(alignment: .leading, spacing: 10) {
              HStack {
                Label("Primary branch", systemImage: "point.topleft.down.curvedto.point.bottomright.up")
                  .font(.subheadline.weight(.semibold))
                Spacer()
                Menu("Checkout") {
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
                .disabled(primaryBranches.isEmpty || !canRunLiveActions)
              }

              Text(primaryLane.branchRef)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ADEPalette.textSecondary)

              if let primaryBranchError {
                Text(primaryBranchError)
                  .font(.caption)
                  .foregroundStyle(ADEPalette.danger)
              }
            }
            .padding(.vertical, 4)
          }
        }

        if !openLaneIds.isEmpty {
          Section("Open lanes") {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 8) {
                ForEach(openLaneIds, id: \.self) { laneId in
                  if let snapshot = laneSnapshots.first(where: { $0.lane.id == laneId }) {
                    NavigationLink {
                      LaneDetailScreen(
                        laneId: snapshot.lane.id,
                        initialSnapshot: snapshot,
                        allLaneSnapshots: laneSnapshots,
                        onRefreshRoot: { await reload(refreshRemote: true) }
                      )
                    } label: {
                      HStack(spacing: 8) {
                        Image(systemName: pinnedLaneIds.contains(snapshot.lane.id) ? "pin.fill" : "square.stack.3d.up")
                          .foregroundStyle(pinnedLaneIds.contains(snapshot.lane.id) ? ADEPalette.accent : ADEPalette.textSecondary)
                        Text(snapshot.lane.name)
                          .font(.system(.caption, design: .monospaced))
                      }
                      .padding(.horizontal, 10)
                      .padding(.vertical, 9)
                      .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                          .fill(ADEPalette.recessedBackground)
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

            HStack {
              Button("Select all visible") {
                openLaneIds = filteredSnapshots.map(\.lane.id)
              }
              .disabled(filteredSnapshots.isEmpty)
              if manageableVisibleLaneIds.count > 1 {
                Button("Manage visible") {
                  batchManageLaneIds = manageableVisibleLaneIds
                  batchManagePresented = true
                }
              }
              Spacer()
              Button("Clear open lanes", role: .destructive) {
                openLaneIds = Array(pinnedLaneIds)
              }
            }
            .font(.caption)
          }
        }

        if !visibleSuggestions.isEmpty {
          Section("Rebase suggested") {
            ForEach(visibleSuggestions.prefix(3)) { snapshot in
              VStack(alignment: .leading, spacing: 10) {
                HStack {
                  Text(snapshot.lane.name)
                    .font(.headline)
                  Spacer()
                  ADEStatusPill(text: "\(snapshot.rebaseSuggestion?.behindCount ?? 0) behind", tint: ADEPalette.warning)
                }
                Text("Rebase this lane onto its parent to pick up new commits.")
                  .font(.caption)
                  .foregroundStyle(ADEPalette.textSecondary)
                HStack {
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
                  Spacer()
                  Button("Rebase now") {
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
                .font(.caption)
              }
              .padding(.vertical, 4)
            }
          }
        }

        if !visibleAutoRebaseAttention.isEmpty {
          Section("Needs attention") {
            ForEach(visibleAutoRebaseAttention.prefix(3)) { snapshot in
              VStack(alignment: .leading, spacing: 8) {
                HStack {
                  Text(snapshot.lane.name)
                    .font(.headline)
                  Spacer()
                  ADEStatusPill(
                    text: snapshot.autoRebaseStatus?.state == "rebaseConflict" ? "Conflict" : "Pending",
                    tint: snapshot.autoRebaseStatus?.state == "rebaseConflict" ? ADEPalette.danger : ADEPalette.warning
                  )
                }
                Text(snapshot.autoRebaseStatus?.message ?? "This lane needs manual rebase attention.")
                  .font(.caption)
                  .foregroundStyle(ADEPalette.textSecondary)
              }
              .padding(.vertical, 2)
            }
          }
        }

        Section(filteredSnapshots.isEmpty ? "Lanes" : "\(scope.title) lanes") {
          if filteredSnapshots.isEmpty {
            Text(emptyStateText)
              .font(.subheadline)
              .foregroundStyle(ADEPalette.textSecondary)
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
      .searchable(text: $searchText, prompt: "Search lanes, is:dirty, type:attached")
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
      .navigationTitle("Lanes")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            Button("Create lane", systemImage: "plus") {
              createPresented = true
            }
            Button("Attach worktree", systemImage: "link") {
              attachPresented = true
            }
          } label: {
            Image(systemName: "plus")
          }
        }
      }
      .refreshable {
        await reload(refreshRemote: true)
      }
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

private struct LaneListRow: View {
  let snapshot: LaneListSnapshot
  let isPinned: Bool
  let isOpen: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Text(snapshot.lane.name)
              .font(.headline)
            if isPinned {
              Image(systemName: "pin.fill")
                .foregroundStyle(ADEPalette.accent)
            }
            if isOpen {
              Image(systemName: "square.stack.3d.up.fill")
                .foregroundStyle(ADEPalette.textSecondary)
            }
          }
          Text(snapshot.lane.branchRef)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEPalette.textSecondary)
        }
        Spacer()
        LaneSnapshotBadges(snapshot: snapshot)
      }

      HStack(spacing: 12) {
        Label("\(snapshot.lane.status.ahead)", systemImage: "arrow.up")
        Label("\(snapshot.lane.status.behind)", systemImage: "arrow.down")
        Label("\(snapshot.lane.childCount)", systemImage: "square.stack.3d.up")
        if snapshot.runtime.sessionCount > 0 {
          Label("\(snapshot.runtime.sessionCount)", systemImage: runtimeSymbol(snapshot.runtime.bucket))
        }
      }
      .font(.system(.caption, design: .monospaced))
      .foregroundStyle(ADEPalette.textMuted)

      if let agentText = summarizeState(snapshot.stateSnapshot?.agentSummary) {
        Label(agentText, systemImage: "person.crop.circle")
          .font(.caption)
          .foregroundStyle(ADEPalette.textSecondary)
      }

      if let missionText = summarizeState(snapshot.stateSnapshot?.missionSummary) {
        Label(missionText, systemImage: "flag.2.crossed")
          .font(.caption)
          .foregroundStyle(ADEPalette.textSecondary)
      }
    }
    .padding(.vertical, 4)
  }
}

private struct LaneSnapshotBadges: View {
  let snapshot: LaneListSnapshot

  var body: some View {
    VStack(alignment: .trailing, spacing: 6) {
      if snapshot.lane.status.dirty {
        ADEStatusPill(text: "DIRTY", tint: ADEPalette.warning)
      } else if snapshot.lane.archivedAt != nil {
        ADEStatusPill(text: "ARCHIVED", tint: ADEPalette.textSecondary)
      }

      if let rebaseSuggestion = snapshot.rebaseSuggestion {
        ADEStatusPill(text: "\(rebaseSuggestion.behindCount) behind", tint: ADEPalette.warning)
      } else if snapshot.autoRebaseStatus?.state == "rebaseConflict" {
        ADEStatusPill(text: "CONFLICT", tint: ADEPalette.danger)
      } else if snapshot.runtime.bucket == "running" {
        ADEStatusPill(text: "RUNNING", tint: ADEPalette.success)
      } else if snapshot.runtime.bucket == "awaiting-input" {
        ADEStatusPill(text: "ATTN", tint: ADEPalette.warning)
      }
    }
  }
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
      Form {
        TextField("Lane name", text: $name)
        TextField("Description", text: $description, axis: .vertical)

        Toggle("Create as child lane", isOn: $createAsChild)

        if createAsChild {
          Picker("Parent lane", selection: $selectedParentLaneId) {
            Text("Select parent").tag("")
            ForEach(lanes.filter { $0.archivedAt == nil }) { lane in
              Text("\(lane.name) (\(lane.branchRef))").tag(lane.id)
            }
          }
        } else {
          Picker("Base branch", selection: $selectedBaseBranch) {
            ForEach(branches.filter { !$0.isRemote }) { branch in
              Text(branch.name).tag(branch.name)
            }
          }
        }

        Picker("Template", selection: $selectedTemplateId) {
          Text("No template").tag("")
          ForEach(templates) { template in
            Text(template.name).tag(template.id)
          }
        }

        if let envProgress {
          Section("Environment setup") {
            Text(envProgress.overallStatus.capitalized)
              .foregroundStyle(ADEPalette.textSecondary)
            ForEach(envProgress.steps) { step in
              HStack {
                Text(step.label)
                Spacer()
                Text(step.status)
                  .font(.system(.caption, design: .monospaced))
                  .foregroundStyle(ADEPalette.textSecondary)
              }
            }
          }
        }

        if let errorMessage {
          Text(errorMessage)
            .foregroundStyle(ADEPalette.danger)
        }
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
      .navigationTitle("Create lane")
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
      Form {
        TextField("Lane name", text: $name)
        TextField("Worktree path", text: $attachedPath)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        TextField("Description", text: $description, axis: .vertical)
        if let errorMessage {
          Text(errorMessage)
            .foregroundStyle(ADEPalette.danger)
        }
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
      .navigationTitle("Attach worktree")
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
    List {
      if let banner = connectionBanner {
        banner
          .listRowBackground(Color.clear)
      }

      if let busyAction {
        ProgressView("Running \(busyAction)...")
          .listRowBackground(Color.clear)
      }

      if let errorMessage {
        Text(errorMessage)
          .foregroundStyle(ADEPalette.danger)
      }

      Picker("Section", selection: $section) {
        ForEach(LaneDetailSection.allCases) { item in
          Text(item.title).tag(item)
        }
      }
      .pickerStyle(.segmented)

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
    .scrollContentBackground(.hidden)
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
  private var overviewSections: some View {
    Section("Overview") {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Text(detail?.lane.branchRef ?? currentSnapshot.lane.branchRef)
            .font(.system(.headline, design: .monospaced))
          Spacer()
          LaneSnapshotBadges(snapshot: currentSnapshot)
        }
        Text("Base \(detail?.lane.baseRef ?? currentSnapshot.lane.baseRef)")
          .font(.caption)
          .foregroundStyle(ADEPalette.textSecondary)
        Text(detail?.lane.worktreePath ?? currentSnapshot.lane.worktreePath)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEPalette.textMuted)
        HStack {
          Button("Copy path") {
            UIPasteboard.general.string = detail?.lane.worktreePath ?? currentSnapshot.lane.worktreePath
          }
          Button("Open workspace") {
            Task { await openFiles() }
          }
        }
        .font(.caption)
      }
      .padding(.vertical, 4)
    }

    if let detail {
      if let autoRebaseStatus = detail.autoRebaseStatus, autoRebaseStatus.state != "autoRebased" {
        Section("Auto rebase") {
          Text(autoRebaseStatus.message ?? "This lane needs manual rebase attention.")
            .foregroundStyle(ADEPalette.textSecondary)
          if autoRebaseStatus.conflictCount > 0 {
            Text("\(autoRebaseStatus.conflictCount) conflict file(s) are blocking auto-rebase.")
              .font(.caption)
              .foregroundStyle(ADEPalette.danger)
          }
          Button("Open Git actions") {
            section = .git
          }
          .font(.caption)
        }
      }

      if let rebaseSuggestion = detail.rebaseSuggestion {
        Section("Rebase") {
          Text("Behind parent by \(rebaseSuggestion.behindCount) commit(s).")
            .font(.subheadline)
          HStack {
            Button("Defer") {
              Task { await performAction("defer rebase") { try await syncService.deferRebaseSuggestion(laneId: laneId) } }
            }
            Button("Dismiss") {
              Task { await performAction("dismiss rebase") { try await syncService.dismissRebaseSuggestion(laneId: laneId) } }
            }
            Spacer()
            Button("Rebase now") {
              Task { await performAction("rebase lane") { try await syncService.startLaneRebase(laneId: laneId) } }
            }
            .disabled(!canRunLiveActions)
          }
          .font(.caption)
        }
      }

      if let conflictStatus = detail.conflictStatus {
        Section("Conflicts") {
          Text(conflictSummary(conflictStatus))
            .foregroundStyle(ADEPalette.textSecondary)
          if !detail.overlaps.isEmpty {
            ForEach(detail.overlaps) { overlap in
              VStack(alignment: .leading, spacing: 6) {
                HStack {
                  Text(overlap.peerName)
                  Spacer()
                  ADEStatusPill(
                    text: overlap.riskLevel.uppercased(),
                    tint: overlap.riskLevel == "high" ? ADEPalette.danger : ADEPalette.warning
                  )
                }
                ForEach(overlap.files.prefix(4)) { file in
                  Text("- \(file.path) | \(file.conflictType)")
                    .font(.caption)
                    .foregroundStyle(ADEPalette.textSecondary)
                }
              }
              .padding(.vertical, 4)
            }
          }
        }
      }

      Section("Hierarchy") {
        HStack {
          Text("Stack chain")
            .font(.headline)
          Spacer()
          Button("Stack graph") {
            showStackGraph = true
          }
          .font(.caption)
        }

        if detail.stackChain.isEmpty {
          Text("No stack chain available.")
            .foregroundStyle(ADEPalette.textSecondary)
        } else {
          ForEach(detail.stackChain) { item in
            HStack {
              Text(String(repeating: "  ", count: item.depth) + item.laneName)
              Spacer()
              Text(item.branchRef)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ADEPalette.textSecondary)
            }
          }
        }

        if !detail.children.isEmpty {
          Divider()
          ForEach(detail.children) { child in
            HStack {
              Text(child.name)
              Spacer()
              Text(child.branchRef)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ADEPalette.textSecondary)
            }
          }
        }
      }

      if let stateText = summarizeState(detail.stateSnapshot?.agentSummary) {
        Section("Agent") {
          Text(stateText)
            .foregroundStyle(ADEPalette.textSecondary)
        }
      }

      if let missionText = summarizeState(detail.stateSnapshot?.missionSummary) {
        Section("Mission") {
          Text(missionText)
            .foregroundStyle(ADEPalette.textSecondary)
        }
      }
    }
  }

  @ViewBuilder
  private var gitSections: some View {
    if let detail {
      Section("Sync") {
        if let syncStatus = detail.syncStatus {
          Text(syncSummary(syncStatus))
            .foregroundStyle(ADEPalette.textSecondary)
        }
        HStack {
          Button("Fetch") {
            Task { await performAction("fetch") { try await syncService.fetchGit(laneId: laneId) } }
          }
          Menu("Pull") {
            Button("Pull (merge)") {
              Task { await performAction("pull merge") { try await syncService.pullGit(laneId: laneId) } }
            }
            Button("Pull (rebase)") {
              Task { await performAction("pull rebase") { try await syncService.syncGit(laneId: laneId, mode: "rebase") } }
            }
          }
          Button(detail.syncStatus?.hasUpstream == false ? "Publish" : "Push") {
            Task { await performAction("push") { try await syncService.pushGit(laneId: laneId) } }
          }
          Menu("More") {
            Button("Force push") {
              Task { await performAction("force push") { try await syncService.pushGit(laneId: laneId, forceWithLease: true) } }
            }
            Button("Rebase lane") {
              Task { await performAction("rebase lane") { try await syncService.startLaneRebase(laneId: laneId) } }
            }
            Button("Rebase and push") {
              Task { await performAction("rebase and push") { try await syncService.startLaneRebase(laneId: laneId, pushMode: "push") } }
            }
          }
        }
        .font(.caption)
      }

      Section("Commit") {
        TextField("Commit message", text: $commitMessage, axis: .vertical)
        Toggle("Amend latest commit", isOn: $amendCommit)
        HStack {
          Button("Generate") {
            Task {
              do {
                commitMessage = try await syncService.generateCommitMessage(laneId: laneId, amend: amendCommit)
              } catch {
                errorMessage = error.localizedDescription
              }
            }
          }
          Button("Commit") {
            Task {
              await performAction("commit") {
                try await syncService.commitLane(laneId: laneId, message: commitMessage, amend: amendCommit)
              }
              commitMessage = ""
            }
          }
        }
        .font(.caption)
      }

      if let diffChanges = detail.diffChanges {
        if !diffChanges.unstaged.isEmpty {
          Section("Unstaged files") {
            if diffChanges.unstaged.count > 1 {
              Button("Stage all") {
                Task {
                  await performAction("stage all") {
                    try await syncService.stageAll(laneId: laneId, paths: diffChanges.unstaged.map(\.path))
                  }
                }
              }
              .font(.caption)
            }
            ForEach(diffChanges.unstaged) { file in
              fileRow(file: file, mode: "unstaged")
            }
          }
        }
        if !diffChanges.staged.isEmpty {
          Section("Staged files") {
            if diffChanges.staged.count > 1 {
              Button("Unstage all") {
                Task {
                  await performAction("unstage all") {
                    try await syncService.unstageAll(laneId: laneId, paths: diffChanges.staged.map(\.path))
                  }
                }
              }
              .font(.caption)
            }
            ForEach(diffChanges.staged) { file in
              fileRow(file: file, mode: "staged")
            }
          }
        }
      }

      if !detail.stashes.isEmpty || canRunLiveActions {
        Section("Stashes") {
          TextField("Stash message", text: $stashMessage)
          Button("Create stash") {
            Task { await performAction("stash") { try await syncService.stashPush(laneId: laneId, message: stashMessage, includeUntracked: true) } }
          }
          .font(.caption)

          ForEach(detail.stashes) { stash in
            VStack(alignment: .leading, spacing: 8) {
              Text(stash.subject)
              HStack {
                Button("Apply") {
                  Task { await performAction("stash apply") { try await syncService.stashApply(laneId: laneId, stashRef: stash.ref) } }
                }
                Button("Pop") {
                  Task { await performAction("stash pop") { try await syncService.stashPop(laneId: laneId, stashRef: stash.ref) } }
                }
                Button("Drop", role: .destructive) {
                  Task { await performAction("stash drop") { try await syncService.stashDrop(laneId: laneId, stashRef: stash.ref) } }
                }
              }
              .font(.caption)
            }
          }
        }
      }

      if !detail.recentCommits.isEmpty {
        Section("Recent commits") {
          ForEach(detail.recentCommits) { commit in
            VStack(alignment: .leading, spacing: 8) {
              HStack {
                Text(commit.subject)
                  .font(.headline)
                Spacer()
                Text(commit.shortSha)
                  .font(.system(.caption, design: .monospaced))
                  .foregroundStyle(ADEPalette.textSecondary)
              }
              Text("\(commit.authorName) | \(relativeTimestamp(commit.authoredAt))")
                .font(.caption)
                .foregroundStyle(ADEPalette.textSecondary)
              HStack {
                Button("Diff") {
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
                Button("Message") {
                  Task {
                    do {
                      commitMessage = try await syncService.getCommitMessage(laneId: laneId, commitSha: commit.sha)
                    } catch {
                      errorMessage = error.localizedDescription
                    }
                  }
                }
                Button("Revert") {
                  Task { await performAction("revert commit") { try await syncService.revertCommit(laneId: laneId, commitSha: commit.sha) } }
                }
                Button("Cherry-pick") {
                  Task { await performAction("cherry pick") { try await syncService.cherryPickCommit(laneId: laneId, commitSha: commit.sha) } }
                }
              }
              .font(.caption)
            }
          }
        }
      }

      if let conflictState = detail.conflictState, conflictState.inProgress {
        Section("Rebase conflict") {
          Text("Git reports a \(conflictState.kind ?? "merge") in progress.")
            .foregroundStyle(ADEPalette.textSecondary)
          if !conflictState.conflictedFiles.isEmpty {
            ForEach(conflictState.conflictedFiles, id: \.self) { path in
              Text(path)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ADEPalette.textSecondary)
            }
          }
          HStack {
            Button("Continue") {
              Task { await performAction("rebase continue") { try await syncService.rebaseContinueGit(laneId: laneId) } }
            }
            .disabled(!conflictState.canContinue)
            Button("Abort", role: .destructive) {
              Task { await performAction("rebase abort") { try await syncService.rebaseAbortGit(laneId: laneId) } }
            }
            .disabled(!conflictState.canAbort)
          }
          .font(.caption)
        }
      }
    }
  }

  @ViewBuilder
  private var workSections: some View {
    if let detail {
      Section("Launch") {
        Toggle("Track launched workspace sessions", isOn: $trackedLaunch)
        HStack {
          Button("Shell") {
            Task {
              await performAction("launch shell") {
                try await syncService.runQuickCommand(laneId: laneId, title: "Shell", toolType: "shell", tracked: trackedLaunch)
              }
            }
          }
          Button("Codex chat") {
            chatLaunchTarget = LaneChatLaunchTarget(provider: "codex")
          }
          Button("Claude chat") {
            chatLaunchTarget = LaneChatLaunchTarget(provider: "claude")
          }
        }
        .font(.caption)
        Button("Open workspace in Files") {
          Task { await openFiles() }
        }
        .font(.caption)
      }

      if !detail.sessions.isEmpty {
        Section("Workspace sessions") {
          ForEach(detail.sessions) { session in
            NavigationLink {
              LaneSessionTranscriptView(session: session)
            } label: {
              VStack(alignment: .leading, spacing: 6) {
                HStack {
                  Text(session.title)
                    .font(.headline)
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
                    .lineLimit(1)
                }
              }
            }
            .swipeActions(edge: .trailing) {
              Button("Close", role: .destructive) {
                Task { await performAction("close session") { try await syncService.closeWorkSession(sessionId: session.id) } }
              }
            }
          }
        }
      }

      if !detail.chatSessions.isEmpty {
        Section("AI chats") {
          ForEach(detail.chatSessions) { chat in
            NavigationLink {
              LaneChatSessionView(summary: chat)
            } label: {
              VStack(alignment: .leading, spacing: 4) {
                HStack {
                  Text(chat.title ?? chat.provider.uppercased())
                    .font(.headline)
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
      }
    }
  }

  @ViewBuilder
  private var manageSections: some View {
    if let detail {
      Section("Rename") {
        TextField("Lane name", text: $renameText)
        Button("Save name") {
          Task { await performAction("rename lane") { try await syncService.renameLane(laneId, name: renameText) } }
        }
        .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || renameText == detail.lane.name)
      }

      Section("Appearance") {
        TextField("Color token or hex", text: $colorText)
          .textInputAutocapitalization(.never)
        TextField("Icon (star, flag, bolt, shield, tag)", text: $iconText)
          .textInputAutocapitalization(.never)
        TextField("Tags (comma separated)", text: $tagsText)
        Button("Save appearance") {
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

      if detail.lane.laneType != "primary" {
        Section("Reparent") {
          Picker("Parent lane", selection: $selectedParentLaneId) {
            Text("Select parent").tag("")
            ForEach(reparentCandidates) { lane in
              Text("\(lane.name) (\(lane.branchRef))").tag(lane.id)
            }
          }
          Button("Save parent") {
            Task { await performAction("reparent lane") { try await syncService.reparentLane(laneId, newParentLaneId: selectedParentLaneId) } }
          }
          .disabled(selectedParentLaneId.isEmpty)
        }
      }

      if detail.lane.laneType == "attached" && detail.lane.archivedAt == nil {
        Section("Attached lane") {
          Text("Move this attached worktree into .ade/worktrees so ADE fully manages lane lifecycle.")
            .foregroundStyle(ADEPalette.textSecondary)
          Button("Move to ADE-managed worktree") {
            Task { await performAction("adopt attached lane") { _ = try await syncService.adoptAttachedLane(laneId) } }
          }
        }
      }

      Section("Archive") {
        if detail.lane.archivedAt == nil {
          Button("Archive lane", role: .destructive) {
            Task { await performAction("archive lane") { try await syncService.archiveLane(laneId) } }
          }
          .disabled(detail.lane.laneType == "primary")
        } else {
          Button("Restore lane") {
            Task { await performAction("restore lane") { try await syncService.unarchiveLane(laneId) } }
          }
        }
      }

      if detail.lane.laneType != "primary" {
        Section("Delete") {
          Picker("Delete mode", selection: $deleteMode) {
            ForEach(LaneDeleteMode.allCases) { mode in
              Text(mode.title).tag(mode)
            }
          }
          if deleteMode == .remoteBranch {
            TextField("Remote name", text: $deleteRemoteName)
          }
          Toggle("Force delete", isOn: $deleteForce)
          TextField("Type delete \(detail.lane.name) to confirm", text: $deleteConfirmText)
          Button("Delete lane", role: .destructive) {
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
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(file.path)
          .font(.system(.caption, design: .monospaced))
        Spacer()
        ADEStatusPill(text: file.kind.uppercased(), tint: file.kind == "modified" ? ADEPalette.warning : ADEPalette.textSecondary)
      }
      HStack {
        Button("Diff") {
          selectedDiffRequest = LaneDiffRequest(
            laneId: laneId,
            path: file.path,
            mode: mode,
            compareRef: nil,
            compareTo: nil,
            title: file.path
          )
        }
        Button("Files") {
          Task { await openFiles(path: file.path) }
        }
        if mode == "unstaged" {
          Button("Stage") {
            Task { await performAction("stage file") { try await syncService.stageFile(laneId: laneId, path: file.path) } }
          }
          Button("Discard", role: .destructive) {
            Task { await performAction("discard file") { try await syncService.discardFile(laneId: laneId, path: file.path) } }
          }
        } else {
          Button("Unstage") {
            Task { await performAction("unstage file") { try await syncService.unstageFile(laneId: laneId, path: file.path) } }
          }
          Button("Restore staged", role: .destructive) {
            Task { await performAction("restore staged file") { try await syncService.restoreStagedFile(laneId: laneId, path: file.path) } }
          }
        }
      }
      .font(.caption)
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
      Form {
        Section("Provider") {
          Text(providerTitle)
            .font(.headline)
          Text("Launch a lane-scoped \(providerTitle) chat from the Lanes tab.")
            .font(.caption)
            .foregroundStyle(ADEPalette.textSecondary)
        }

        if !models.isEmpty {
          Section("Model") {
            Picker("Model", selection: $selectedModelId) {
              ForEach(models) { model in
                Text(model.displayName).tag(model.id)
              }
            }
            if let description = selectedModel?.description, !description.isEmpty {
              Text(description)
                .font(.caption)
                .foregroundStyle(ADEPalette.textSecondary)
            }
          }
        }

        if let reasoningEfforts = selectedModel?.reasoningEfforts, !reasoningEfforts.isEmpty {
          Section("Reasoning") {
            Picker("Reasoning", selection: $selectedReasoningEffort) {
              Text("Default").tag("")
              ForEach(reasoningEfforts) { effort in
                Text(effort.effort.capitalized).tag(effort.effort)
              }
            }
            if let effort = reasoningEfforts.first(where: { $0.effort == selectedReasoningEffort }) {
              Text(effort.description)
                .font(.caption)
                .foregroundStyle(ADEPalette.textSecondary)
            }
          }
        }

        if let errorMessage {
          Text(errorMessage)
            .foregroundStyle(ADEPalette.danger)
        }
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
      .navigationTitle("New \(providerTitle) chat")
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
      Form {
        Section("Selected lanes") {
          ForEach(snapshots) { snapshot in
            VStack(alignment: .leading, spacing: 4) {
              Text(snapshot.lane.name)
              Text(snapshot.lane.branchRef)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ADEPalette.textSecondary)
            }
          }
        }

        Section("Archive") {
          Button("Archive selected lanes", role: .destructive) {
            Task { await archiveSelected() }
          }
          .disabled(busy || laneIds.isEmpty)
        }

        Section("Delete") {
          Picker("Delete mode", selection: $deleteMode) {
            ForEach(LaneDeleteMode.allCases) { mode in
              Text(mode.title).tag(mode)
            }
          }
          if deleteMode == .remoteBranch {
            TextField("Remote name", text: $deleteRemoteName)
          }
          Toggle("Force delete", isOn: $deleteForce)
          TextField("Type delete open lanes to confirm", text: $confirmText)
          Button("Delete selected lanes", role: .destructive) {
            Task { await deleteSelected() }
          }
          .disabled(confirmText.lowercased() != "delete open lanes" || busy || laneIds.isEmpty)
        }

        if let errorMessage {
          Text(errorMessage)
            .foregroundStyle(ADEPalette.danger)
        }
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
      .navigationTitle("Manage lanes")
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
      List {
        ForEach(orderedSnapshots) { snapshot in
          HStack(spacing: 10) {
            Circle()
              .fill(snapshot.lane.id == selectedLaneId ? ADEPalette.accent : runtimeTint(bucket: snapshot.runtime.bucket))
              .frame(width: 8, height: 8)
            Text(String(repeating: "  ", count: snapshot.lane.stackDepth) + snapshot.lane.name)
            Spacer()
            Text(snapshot.lane.branchRef)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEPalette.textSecondary)
          }
          .font(.subheadline)
        }
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
      .navigationTitle("Stack graph")
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
      List {
        if let errorMessage {
          Text(errorMessage)
            .foregroundStyle(ADEPalette.danger)
        }

        if let diff {
          Picker("Side", selection: $side) {
            Text("Original").tag("original")
            Text("Modified").tag("modified")
          }
          .pickerStyle(.segmented)

          if diff.isBinary == true {
            Text("Binary diff is not editable on iPhone.")
              .foregroundStyle(ADEPalette.textSecondary)
          } else {
            TextEditor(text: Binding(
              get: {
                side == "original" ? diff.original.text : editedText
              },
              set: { newValue in
                editedText = newValue
              }
            ))
            .frame(minHeight: 320)
            .font(.system(.footnote, design: .monospaced))
            .disabled(side == "original")
          }
        } else {
          ProgressView()
        }
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
      .navigationTitle(request.title)
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
      Text(syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? "No output yet.")
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .font(.system(.footnote, design: .monospaced))
    }
    .background(ADEPalette.pageBackground.ignoresSafeArea())
    .navigationTitle(session.title)
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

  var body: some View {
    List {
      if let errorMessage {
        Text(errorMessage)
          .foregroundStyle(ADEPalette.danger)
      }

      Section("Transcript") {
        ForEach(transcript) { entry in
          VStack(alignment: .leading, spacing: 6) {
            Text(entry.role.capitalized)
              .font(.caption.weight(.semibold))
              .foregroundStyle(entry.role == "assistant" ? ADEPalette.accent : ADEPalette.textSecondary)
            Text(entry.text)
              .font(.body)
            Text(relativeTimestamp(entry.timestamp))
              .font(.caption2)
              .foregroundStyle(ADEPalette.textMuted)
          }
          .padding(.vertical, 4)
        }
      }

      Section("Reply") {
        TextField("Send a message", text: $composer, axis: .vertical)
        Button("Send") {
          Task {
            do {
              try await syncService.sendChatMessage(sessionId: summary.sessionId, text: composer)
              composer = ""
              transcript = try await syncService.fetchChatTranscript(sessionId: summary.sessionId)
            } catch {
              errorMessage = error.localizedDescription
            }
          }
        }
        .disabled(composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .scrollContentBackground(.hidden)
    .background(ADEPalette.pageBackground.ignoresSafeArea())
    .navigationTitle(summary.title ?? summary.provider.uppercased())
    .task {
      do {
        transcript = try await syncService.fetchChatTranscript(sessionId: summary.sessionId)
      } catch {
        errorMessage = error.localizedDescription
      }
    }
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
