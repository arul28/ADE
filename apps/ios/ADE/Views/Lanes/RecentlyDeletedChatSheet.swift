import SwiftUI

/// A deleted chat's conversation, read-only, with Reopen under it: the
/// phone's version of the desktop's Recently deleted dialog. Every read and
/// action goes to the chat's own machine. A chat whose lane is gone reopens
/// as a copy in a lane of that machine that the person picks here.
struct RecentlyDeletedChatSheet: View {
  let entry: DeletedChatEntry
  let store: RecentlyDeletedStore
  let syncService: SyncService

  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var lanes: [LaneSummary]?
  @State private var lanesError: String?
  @State private var targetLaneId = ""
  @State private var confirmingRemove = false

  private var chat: DeletedChat { entry.chat }
  private var machine: ProjectCopyMachine { entry.machine }
  private var needsLane: Bool { !chat.laneExists }
  private var reopening: Bool { store.running == RecentlyDeletedStore.Running(key: entry.id, kind: .reopen) }
  private var removing: Bool { store.running == RecentlyDeletedStore.Running(key: entry.id, kind: .remove) }
  private var canReopen: Bool { !store.isBusy && (!needsLane || !targetLaneId.isEmpty) }

  /// The import preview's reader, pointed at the deleted chat's own call.
  private var session: ExternalSessionSummary {
    ExternalSessionSummary(provider: chat.sourceProvider, id: chat.id, title: chat.title)
  }

  private var source: WorkImportSource {
    WorkImportSource(machineKey: machine.isFocused ? nil : machine.id, markedProjectId: machine.projectId, rootPath: machine.rootPath)
  }

  var body: some View {
    NavigationStack {
      WorkImportSessionPreview(session: session, source: source, loadPage: { before in
        try await syncService.deletedChatDetail(
          chat.id,
          before: before,
          targetProjectId: machine.projectId,
          targetProjectRootPath: machine.rootPath
        )
      })
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .safeAreaInset(edge: .top, spacing: 0) { header }
      .safeAreaInset(edge: .bottom, spacing: 0) { footer }
      .navigationTitle(deletedChatTitle(chat))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button {
            dismiss()
          } label: {
            Label("Close", systemImage: "xmark")
          }
          .disabled(store.isBusy)
        }
      }
    }
    .presentationDetents([.large])
    .interactiveDismissDisabled(store.isBusy)
    .task(id: needsLane ? machine.id : "") {
      guard needsLane else { return }
      await loadLanes()
    }
  }

  // MARK: Header

  private var header: some View {
    HStack(alignment: .center, spacing: 10) {
      DeletedChatLogo(chat: chat, size: 24)
      ADEMetaLine(parts: headerMeta)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      ADEColor.pageBackground
        .overlay(alignment: .bottom) {
          Rectangle().fill(ADEKit.rule).frame(height: 0.75)
        }
    }
    .accessibilityElement(children: .combine)
  }

  private var headerMeta: [String] {
    deletedChatMetaParts(chat) + (store.reads.machines.count > 1 ? [machine.name] : [])
  }

  // MARK: Footer

  private var footer: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let error = store.reopenError {
        ADEFlatInlineNotice(message: "Couldn’t reopen this chat.", tint: ADEColor.danger, technicalDetail: error)
      }
      if needsLane {
        lanePicker
      } else {
        Text(reopenHint)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if dynamicTypeSize.isAccessibilitySize {
        VStack(spacing: 8) {
          reopenButton(fill: true)
          removeButton(fill: true)
        }
      } else {
        HStack(spacing: 8) {
          removeButton(fill: false)
          Spacer(minLength: 8)
          reopenButton(fill: false)
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      ADEColor.pageBackground
        .ignoresSafeArea(edges: .bottom)
        .overlay(alignment: .top) {
          Rectangle().fill(ADEKit.rule).frame(height: 0.75)
        }
    }
  }

  private var reopenHint: String {
    let lane = chat.laneName ?? "its lane"
    guard chat.isCli else { return "Picks up where it left off, in \(lane)." }
    return chat.resumable == true
      ? "Relaunches the CLI in \(lane), resuming its conversation."
      : "Starts a new CLI in \(lane): \(Brand.name) can’t resume its conversation."
  }

  @ViewBuilder
  private var lanePicker: some View {
    HStack(spacing: 8) {
      Text("Reopen in")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize()
      if let lanes {
        Menu {
          Picker("Reopen in lane", selection: $targetLaneId) {
            ForEach(lanes) { lane in
              Text("\(lane.emoji.map { "\($0) " } ?? "")\(lane.displayName)").tag(lane.id)
            }
          }
        } label: {
          WorkImportPillLabel(
            symbol: "square.stack.3d.up",
            laneMark: lanes.first(where: { $0.id == targetLaneId }),
            title: lanes.first(where: { $0.id == targetLaneId })?.displayName ?? "Pick a lane"
          )
        }
        .disabled(store.isBusy || lanes.isEmpty)
        .accessibilityLabel("Reopen in lane")
        .accessibilityValue(lanes.first(where: { $0.id == targetLaneId })?.displayName ?? "None")
      } else if lanesError == nil {
        ProgressView().controlSize(.small)
        Text("Loading lanes…")
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
      }
      Spacer(minLength: 0)
    }
    if let lanesError {
      ADEFlatInlineNotice(message: lanesError, tint: ADEColor.danger, retry: { Task { await loadLanes() } })
    } else if lanes?.isEmpty == true {
      Text("\(machine.name) has no open lanes in this project.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textMuted)
    }
  }

  private func reopenButton(fill: Bool) -> some View {
    Button {
      Task {
        if await store.reopen(entry, laneId: needsLane ? targetLaneId : nil, sync: syncService) {
          dismiss()
        }
      }
    } label: {
      HStack(spacing: 6) {
        if reopening {
          ProgressView().controlSize(.small).tint(.white)
        }
        Text(reopenTitle)
      }
      .frame(maxWidth: fill ? .infinity : nil, minHeight: 34)
      .padding(.horizontal, 4)
    }
    .buttonStyle(ADEKitButtonStyle(prominent: true))
    .disabled(!canReopen)
  }

  private var reopenTitle: String {
    if reopening { return "Reopening…" }
    guard needsLane else { return "Reopen" }
    return chat.isCli ? "Reopen in this lane" : "Reopen as a copy"
  }

  private func removeButton(fill: Bool) -> some View {
    Button {
      confirmingRemove = true
    } label: {
      HStack(spacing: 6) {
        if removing { ProgressView().controlSize(.small) }
        Text("Remove from list")
      }
      .frame(maxWidth: fill ? .infinity : nil, minHeight: 34)
      .padding(.horizontal, 4)
    }
    .buttonStyle(ADEKitButtonStyle())
    .disabled(store.isBusy)
    // On the button, so the popover on a wide screen points at it.
    .confirmationDialog(
      "Remove from Recently deleted?",
      isPresented: $confirmingRemove,
      titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        Task { await store.remove(entry, sync: syncService) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(deletedChatRemoveMessage(chat))
    }
  }

  // MARK: Lanes of the chat's machine

  /// The lanes a chat whose lane is gone can reopen into: open lanes of the
  /// chat's own machine, never another one's. Another machine's come back
  /// with its machine in their ids, so the reopen routes there.
  @MainActor
  private func loadLanes() async {
    lanesError = nil
    do {
      var next: [LaneSummary]
      if machine.isFocused {
        next = try await syncService.fetchLanes(includeArchived: false)
        if syncService.isCloudFleetKey(syncService.focusedMachineKey) {
          next.removeAll { $0.laneType == "primary" }
        }
      } else {
        let repo = try syncService.requireRemoteLaneRepo(machineKey: machine.id)
        let snapshots = try await syncService.fetchRemoteLaneSnapshots(
          repo: repo,
          timeoutNanoseconds: LaneRemoteMachinesModel.readTimeoutNanoseconds
        )
        next = laneSnapshotsWithoutCloudMainCheckout(snapshots, machineKey: machine.id, sync: syncService).map(\.lane)
      }
      next = next.filter { $0.archivedAt == nil }
      lanes = next
      if !next.contains(where: { $0.id == targetLaneId }) {
        targetLaneId = (next.first { $0.laneType == "primary" } ?? next.first)?.id ?? ""
      }
    } catch {
      lanesError = "Couldn’t read \(machine.name)’s lanes."
    }
  }
}
