import SwiftUI

extension LanesTabView {
  /// The kept-work notice's Restore after a delete: the same restore as
  /// Recently deleted's, with no chats for the phone to reopen.
  @MainActor
  func restoreKeptLane(_ kept: LaneDeletionKept) async {
    do {
      let result = try await syncService.restoreDeletedLaneAndChats(
        kept.snapshot,
        chats: [],
        targetProjectId: kept.projectId,
        targetProjectRootPath: kept.projectRootPath
      )
      await reload(refreshRemote: true)
      // After the reload, which clears the tab's message when it succeeds.
      if result.restoredUncommitted, (result.chatsNotReopened ?? 0) == 0 {
        ADEHaptics.success()
      } else {
        ADEHaptics.warning()
        errorMessage = RecentlyDeletedNotice.restored(kept.snapshot, result, laneId: result.lane.id).summary
      }
    } catch {
      ADEHaptics.error()
      errorMessage = "Couldn’t restore \(kept.snapshot.laneName): \(SyncUserFacingError.message(for: error))"
    }
  }
}

// MARK: - The list

/// Recently deleted as List sections, for Settings › Deleted & Archived
/// (`.settings`: every lane and chat, grouped by day, in settings panels) and
/// the Lanes tab's Archived filter (`.flat`: lanes only, with the chats that
/// went with them, under one header). The conversation sheet hangs off the
/// List (`recentlyDeletedPresentations`), so a row scrolled out of view never
/// takes it along. Each confirm sits on its row, so the popover on a wide
/// screen points at that row.
struct RecentlyDeletedSections: View {
  let store: RecentlyDeletedStore
  let syncService: SyncService
  let machines: [ProjectCopyMachine]
  let style: EveryMachineListStyle
  var query = ""
  var filter: DeletedKindFilter = .all
  var canRunLiveActions = true
  /// Changes when the list should read again: a pull to refresh, or a delete
  /// or restore elsewhere on the screen.
  var reloadToken = ""
  var onRestored: (() async -> Void)?

  private var showsMachine: Bool { machines.count > 1 }

  private var visible: [DeletedEntry] {
    let entries = style == .flat
      ? store.entries.filter { if case .lane = $0 { return true } else { return false } }
      : store.entries
    return recentlyDeletedFiltered(entries, kind: style == .flat ? .lanes : filter, query: query)
  }

  var body: some View {
    if let notice = store.notice {
      noticeCard(notice)
        .modifier(EveryMachineNoticeRowChrome(style: style))
    }
    EveryMachineStatusRows(
      reads: store.reads,
      syncService: syncService,
      machines: machines,
      style: style,
      reloadToken: reloadToken,
      failedMessage: { "Couldn’t read \($0.name)." },
      outdatedMessage: { "\($0.name) runs an older ADE. Update it there to see its deleted chats." },
      noMachinesMessage: "Connect a computer to see what you deleted.",
      loadingMessage: "Looking for deleted lanes and chats…"
    ) {
      switch style {
      case .flat: flatContent
      case .settings: settingsContent
      }
    }
  }

  /// A finished action, with the way to what came back: "Open lane" first
  /// when a lane came back, then the chat.
  private func noticeCard(_ notice: RecentlyDeletedNotice) -> ADENoticeCard {
    typealias Action = (title: String, run: () -> Void)
    let lane: Action? = notice.openLaneId.map { laneId in (title: "Open lane", run: { openLane(laneId) }) }
    let session: Action? = notice.openSessionId.map { sessionId in
      (title: notice.openSessionTitle, run: { openSession(sessionId, laneId: notice.openSessionLaneId) })
    }
    let primary = lane ?? session
    let secondary = lane == nil ? nil : session
    return ADENoticeCard(
      title: notice.title,
      message: notice.message,
      icon: notice.tone.icon,
      tint: notice.tone.tint,
      actionTitle: primary?.title,
      action: primary?.run,
      secondaryActionTitle: secondary?.title,
      secondaryAction: secondary?.run,
      onDismiss: { store.notice = nil }
    )
  }

  // MARK: Lanes tab

  @ViewBuilder
  private var flatContent: some View {
    let rows = visible
    if !rows.isEmpty {
      Section {
        ForEach(rows) { entry in
          if case .lane(let lane) = entry {
            laneRow(lane)
          }
        }
      } header: {
        ADEFlatSectionHeader("Recently deleted", detail: "\(rows.count)")
      }
    }
  }

  // MARK: Settings

  /// The rows once a machine answered.
  @ViewBuilder
  private var settingsContent: some View {
    let rows = visible
    if store.entries.isEmpty && store.reads.pending.isEmpty {
      Section {
        ADEEmptyStateView(
          symbol: "clock.arrow.circlepath",
          title: "Nothing deleted",
          message: "Lanes and chats you delete show up here, so you can bring them back."
        )
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
      }
    } else if rows.isEmpty && (!query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || filter != .all) {
      Section {
        Text(emptyMatchText)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeSettingsListRow()
      }
    } else if !rows.isEmpty {
      ForEach(dayGroups(rows), id: \.label) { group in
        Section {
          ForEach(group.rows) { entry in
            switch entry {
            case .lane(let lane): laneRow(lane)
            case .chat(let chat): chatRow(chat)
            }
          }
        } header: {
          ADESettingsHeader(title: group.label, inList: true) {
            Text("\(group.rows.count)")
              .font(.adeMono(12))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
      }
    }
  }

  private var emptyMatchText: String {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty { return "Nothing deleted matches “\(trimmed)”." }
    return filter == .lanes ? "No deleted lanes." : "No deleted chats."
  }

  private func dayGroups(_ rows: [DeletedEntry]) -> [(label: String, rows: [DeletedEntry])] {
    var groups: [(label: String, rows: [DeletedEntry])] = []
    for entry in rows {
      let label = workImportDateGroup(entry.at == .distantPast ? nil : entry.at.timeIntervalSince1970)
      if groups.last?.label == label {
        groups[groups.count - 1].rows.append(entry)
      } else {
        groups.append((label, [entry]))
      }
    }
    return groups
  }

  // MARK: Rows

  private func laneRow(_ entry: DeletedLaneEntry) -> some View {
    let disabled = store.isBusy || !canRunLiveActions
    return DeletedLaneRow(
      entry: entry,
      machineName: showsMachine ? entry.machine.name : nil,
      restoring: store.running == RecentlyDeletedStore.Running(key: entry.id, kind: .restore),
      disabled: disabled,
      onRestore: { Task { await store.restore(entry, sync: syncService, onRestored: onRestored) } },
      onOpenChat: { store.open(entry.chatEntry($0)) }
    )
    .confirmationDialog(
      "Drop this lane’s saved work?",
      isPresented: pendingBinding(store, \.pendingDrop, id: entry.id),
      titleVisibility: .visible
    ) {
      Button("Drop", role: .destructive) {
        Task { await store.drop(entry, sync: syncService) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(deletedLaneDropMessage(entry.lane))
    }
    .modifier(DeletedRowChrome(style: style))
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        store.pendingDrop = entry
      } label: {
        Label("Drop", systemImage: "trash")
      }
      .disabled(disabled)
    }
    .contextMenu {
      Button {
        Task { await store.restore(entry, sync: syncService, onRestored: onRestored) }
      } label: {
        Label(entry.lane.isFreed ? "Put back" : "Restore", systemImage: "arrow.uturn.backward")
      }
      .disabled(disabled)
      Button(role: .destructive) {
        store.pendingDrop = entry
      } label: {
        Label("Drop saved work", systemImage: "trash")
      }
      .disabled(disabled)
    }
  }

  private func chatRow(_ entry: DeletedChatEntry) -> some View {
    let disabled = store.isBusy || !canRunLiveActions
    return DeletedChatRow(
      entry: entry,
      machineName: showsMachine ? entry.machine.name : nil,
      reopening: store.running == RecentlyDeletedStore.Running(key: entry.id, kind: .reopen),
      disabled: disabled,
      onOpen: { store.open(entry) },
      onReopen: {
        // A chat whose lane is gone needs a lane first: the sheet asks.
        if entry.chat.laneExists {
          Task { await store.reopen(entry, laneId: nil, sync: syncService) }
        } else {
          store.open(entry)
        }
      }
    )
    .confirmationDialog(
      "Remove from Recently deleted?",
      isPresented: pendingBinding(store, \.pendingRemove, id: entry.id),
      titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        Task { await store.remove(entry, sync: syncService) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(deletedChatRemoveMessage(entry.chat))
    }
    .modifier(DeletedRowChrome(style: style))
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        store.pendingRemove = entry
      } label: {
        Label("Remove", systemImage: "xmark")
      }
      .disabled(disabled)
    }
    .contextMenu {
      Button {
        store.open(entry)
      } label: {
        Label("Show conversation", systemImage: "text.bubble")
      }
      Button(role: .destructive) {
        store.pendingRemove = entry
      } label: {
        Label("Remove from list", systemImage: "xmark")
      }
      .disabled(disabled)
    }
  }

  // MARK: Navigation

  private func openLane(_ laneId: String) {
    syncService.settingsPresented = false
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: laneId)
  }

  private func openSession(_ sessionId: String, laneId: String?) {
    syncService.settingsPresented = false
    syncService.requestedWorkSessionNavigation = WorkSessionNavigationRequest(sessionId: sessionId, laneId: laneId)
  }
}

/// Each style's row chrome: flat rows on the page (Lanes) or the settings
/// panel's surface (Settings).
private struct DeletedRowChrome: ViewModifier {
  let style: EveryMachineListStyle

  func body(content: Content) -> some View {
    switch style {
    case .flat:
      content
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .adeFlatRow(insets: EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 6))
    case .settings:
      content.adeSettingsListRow()
    }
  }
}

// MARK: - Presentations

extension View {
  /// The conversation sheet of a `RecentlyDeletedSections`, on the List that
  /// hosts it.
  func recentlyDeletedPresentations(_ store: RecentlyDeletedStore, syncService: SyncService) -> some View {
    modifier(RecentlyDeletedPresentations(store: store, syncService: syncService))
  }
}

private struct RecentlyDeletedPresentations: ViewModifier {
  let store: RecentlyDeletedStore
  let syncService: SyncService

  func body(content: Content) -> some View {
    content
      .sheet(item: Binding(get: { store.openChat }, set: { store.openChat = $0 })) { entry in
        RecentlyDeletedChatSheet(entry: entry, store: store, syncService: syncService)
      }
  }
}

// MARK: - The kept-work notice after a delete

/// After a delete that kept work: its name, what was kept, Restore.
struct LaneDeletionKeptNotice: View {
  let kept: LaneDeletionKept
  let canRunLiveActions: Bool
  let onRestore: () async -> Void
  let onDismiss: () -> Void
  @State private var restoring = false

  var body: some View {
    ADENoticeCard(
      title: kept.snapshot.laneName,
      message: "\(kept.snapshot.uncommitted ? "Uncommitted work" : "Unpushed commits") kept 30 days in Archived.",
      icon: "tray.and.arrow.down.fill",
      tint: ADEColor.accent,
      actionTitle: "Restore",
      action: canRunLiveActions ? {
        Task {
          restoring = true
          await onRestore()
          restoring = false
        }
      } : nil,
      isBusy: restoring,
      onDismiss: onDismiss
    )
  }
}
