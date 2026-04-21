import SwiftUI

// MARK: - Manage lane sheet

struct LaneManageSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let snapshot: LaneListSnapshot
  let allLaneSnapshots: [LaneListSnapshot]
  let onComplete: @MainActor () async -> Void

  @State private var renameText: String
  @State private var selectedParentLaneId: String
  @State private var colorText: String
  @State private var iconText: String
  @State private var tagsText: String
  @State private var deleteMode: LaneDeleteMode
  @State private var deleteRemoteName = "origin"
  @State private var deleteForce = false
  @State private var busyAction: String?
  @State private var errorMessage: String?

  init(
    snapshot: LaneListSnapshot,
    allLaneSnapshots: [LaneListSnapshot],
    onComplete: @escaping @MainActor () async -> Void
  ) {
    self.snapshot = snapshot
    self.allLaneSnapshots = allLaneSnapshots
    self.onComplete = onComplete
    _renameText = State(initialValue: snapshot.lane.name)
    _selectedParentLaneId = State(initialValue: snapshot.lane.parentLaneId ?? "")
    _colorText = State(initialValue: snapshot.lane.color ?? "")
    _iconText = State(initialValue: snapshot.lane.icon?.rawValue ?? "")
    _tagsText = State(initialValue: snapshot.lane.tags.joined(separator: ", "))
    _deleteMode = State(initialValue: .worktree)
  }

  private var descendantIds: Set<String> {
    var result = Set<String>()
    func collectDescendants(of parentId: String) {
      for s in allLaneSnapshots where s.lane.parentLaneId == parentId {
        if result.insert(s.lane.id).inserted {
          collectDescendants(of: s.lane.id)
        }
      }
    }
    collectDescendants(of: snapshot.lane.id)
    return result
  }

  private var reparentCandidates: [LaneSummary] {
    let excluded = descendantIds
    return allLaneSnapshots
      .map(\.lane)
      .filter { $0.id != snapshot.lane.id && $0.archivedAt == nil && !excluded.contains($0.id) }
      .sorted { lhs, rhs in
        if lhs.laneType == "primary" && rhs.laneType != "primary" { return true }
        if lhs.laneType != "primary" && rhs.laneType == "primary" { return false }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
      }
  }

  private var canArchive: Bool {
    snapshot.lane.laneType != "primary"
  }

  private var canRunLiveActions: Bool {
    laneAllowsLiveActions(connectionState: syncService.connectionState, laneStatus: syncService.status(for: .lanes))
  }

  private var liveActionNoticePresentation: LaneEmptyStatePresentation? {
    laneLiveActionNotice(
      connectionState: syncService.connectionState,
      laneStatus: syncService.status(for: .lanes),
      hasHostProfile: syncService.activeHostProfile != nil
    )
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          // Connection-caused live-action notices are suppressed — the gear
          // dot in the toolbar already communicates offline state.
          if !syncService.connectionState.isHostUnreachable,
            let liveActionNoticePresentation
          {
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

          GlassSection(title: "Identity") {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $renameText)
              LaneActionButton(title: "Save name", symbol: "checkmark.circle.fill", tint: ADEColor.accent) {
                Task { await performAction("rename lane") { try await syncService.renameLane(snapshot.lane.id, name: renameText) } }
              }
              .disabled(!canRunLiveActions || renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || renameText == snapshot.lane.name)
            }
          }

          GlassSection(title: "Appearance") {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Color token or hex", text: $colorText).textInputAutocapitalization(.never)
              LaneTextField("Icon (star, flag, bolt, shield, tag)", text: $iconText).textInputAutocapitalization(.never)
              LaneTextField("Tags (comma separated)", text: $tagsText)
              LaneActionButton(title: "Save appearance", symbol: "paintpalette", tint: ADEColor.accent) {
                Task {
                  let tags = tagsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                  await performAction("save appearance") {
                    try await syncService.updateLaneAppearance(snapshot.lane.id, color: colorText, icon: iconText, tags: tags)
                  }
                }
              }
              .disabled(!canRunLiveActions)
            }
          }

          if snapshot.lane.laneType != "primary" {
            GlassSection(title: "Reparent") {
              VStack(alignment: .leading, spacing: 12) {
                Picker("Parent lane", selection: $selectedParentLaneId) {
                  Text("No parent").tag("")
                  ForEach(reparentCandidates) { lane in
                    Text("\(lane.name) (\(lane.branchRef))").tag(lane.id)
                  }
                }
                .pickerStyle(.menu)

                LaneActionButton(title: "Save parent", symbol: "arrow.triangle.swap", tint: ADEColor.accent) {
                  Task {
                    await performAction("reparent lane") {
                      try await syncService.reparentLane(snapshot.lane.id, newParentLaneId: selectedParentLaneId.isEmpty ? nil : selectedParentLaneId)
                    }
                  }
                }
                .disabled(!canRunLiveActions || selectedParentLaneId == (snapshot.lane.parentLaneId ?? ""))
              }
            }
          }

          GlassSection(title: snapshot.lane.archivedAt == nil ? "Archive" : "Restore") {
            if snapshot.lane.archivedAt == nil {
              LaneActionButton(title: "Archive lane", symbol: "archivebox", tint: ADEColor.warning) {
                Task { await performAction("archive lane") { try await syncService.archiveLane(snapshot.lane.id) } }
              }
              .disabled(!canRunLiveActions || !canArchive)
            } else {
              LaneActionButton(title: "Restore lane", symbol: "tray.and.arrow.up", tint: ADEColor.accent) {
                Task { await performAction("restore lane") { try await syncService.unarchiveLane(snapshot.lane.id) } }
              }
              .disabled(!canRunLiveActions)
            }
          }

          if snapshot.lane.laneType != "primary" {
            GlassSection(title: "Danger zone") {
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

                Text("Hold to confirm deletion of \(snapshot.lane.name).")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)

                LaneHoldToConfirmButton(title: "Delete lane", symbol: "trash", tint: ADEColor.danger) {
                  Task {
                    await performAction("delete lane") {
                      try await syncService.deleteLane(
                        snapshot.lane.id,
                        deleteBranch: deleteMode != .worktree,
                        deleteRemoteBranch: deleteMode == .remoteBranch,
                        remoteName: deleteRemoteName,
                        force: deleteForce
                      )
                    }
                  }
                }
                .disabled(!canRunLiveActions)
              }
            }
          }
        }
        .padding(16)
        .allowsHitTesting(busyAction == nil)
      }
      .adeScreenBackground()
      .overlay {
        if busyAction != nil {
          VStack(spacing: 10) {
            ProgressView()
              .tint(ADEColor.accent)
            Text(busyAction?.capitalized ?? "Working...")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(.ultraThinMaterial)
        }
      }
      .adeNavigationGlass()
      .navigationTitle("Manage lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
            .disabled(busyAction != nil)
        }
      }
    }
  }

  @MainActor
  private func performAction(_ label: String, operation: () async throws -> Void) async {
    guard canRunLiveActions else {
      ADEHaptics.warning()
      errorMessage = "Reconnect to desktop before you \(label)."
      return
    }
    do {
      busyAction = label
      errorMessage = nil
      try await operation()
      dismiss()
      await onComplete()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busyAction = nil
  }

  @MainActor
  private func handleNoticeAction(_ action: LaneConnectionNoticeAction) {
    switch action {
    case .openSettings:
      syncService.settingsPresented = true
    case .reconnect, .retry:
      Task { await syncService.reconnectIfPossible(userInitiated: true) }
    }
  }
}
