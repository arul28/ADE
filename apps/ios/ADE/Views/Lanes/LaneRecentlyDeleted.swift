import SwiftUI

extension LanesTabView {
  /// The focused machine, then every live machine with this repository: the
  /// places the Archived filter lists deleted lanes from.
  var recentlyDeletedMachines: [LaneRecentlyDeletedMachine] {
    var machines = [LaneRecentlyDeletedMachine(id: "", name: focusedMachineName, projectId: nil, rootPath: nil)]
    for machine in remoteLanes.machines where machine.isLive {
      machines.append(LaneRecentlyDeletedMachine(
        id: machine.machineKey,
        name: machine.name,
        projectId: machine.markedProjectId,
        rootPath: machine.rootPath
      ))
    }
    return machines
  }

  @MainActor
  func restoreKeptLane(_ kept: LaneDeletionKept) async {
    do {
      let result = try await syncService.restoreDeletedLane(
        kept.id,
        targetProjectId: kept.projectId,
        targetProjectRootPath: kept.projectRootPath
      )
      if result.restoredUncommitted {
        ADEHaptics.success()
      } else {
        ADEHaptics.warning()
        errorMessage = deletedLaneRestoreMessage(kept.snapshot, result)
      }
      await reload(refreshRemote: true)
    } catch {
      ADEHaptics.error()
      errorMessage = "Couldn’t restore \(kept.snapshot.laneName): \(SyncUserFacingError.message(for: error))"
    }
  }
}

// MARK: - Recently deleted lanes

/// One machine's checkout whose deleted lanes the Archived filter lists.
/// `projectId`/`rootPath` are nil for the focused machine (the default route).
struct LaneRecentlyDeletedMachine: Equatable, Identifiable {
  let id: String
  let name: String
  let projectId: String?
  let rootPath: String?
}

/// "kept 29 more days" from a save's expiry.
func deletedLaneKeptLabel(_ snapshot: DeletedLaneSnapshot, now: Date = Date()) -> String {
  guard let expires = parseLaneTimestamp(snapshot.expiresAt) else { return "kept for now" }
  let days = max(0, Int((expires.timeIntervalSince(now) / 86_400).rounded(.up)))
  return days <= 1 ? "kept 1 more day" : "kept \(days) more days"
}

/// "Uncommitted files · Deleted 2 hours ago · kept 29 more days"
func deletedLaneMetaLine(_ snapshot: DeletedLaneSnapshot) -> String {
  [
    snapshot.uncommitted ? "Uncommitted files" : "Unpushed commits",
    "\(snapshot.isFreed ? "Space freed" : "Deleted") \(relativeTimestamp(snapshot.deletedAt))",
    deletedLaneKeptLabel(snapshot),
  ].joined(separator: " · ")
}

/// What a finished restore says, wherever it was started.
func deletedLaneRestoreMessage(_ snapshot: DeletedLaneSnapshot, _ result: RestoreDeletedLaneResult) -> String {
  let extra = (result.extraBranches ?? []).isEmpty ? "" : " Other commits it kept are on \((result.extraBranches ?? []).joined(separator: ", "))."
  guard result.restoredUncommitted else {
    return "\(snapshot.laneName) is back on \(result.branchName), but its uncommitted files did not apply and stay in Archived › Recently deleted: \(result.warning ?? "unknown error").\(extra)"
  }
  return "\(snapshot.laneName) is back on \(result.branchName)\(snapshot.uncommitted ? ", with its uncommitted files" : "").\(extra)"
}

/// The Archived filter's "Recently deleted" sections: lanes whose work a
/// delete (or freeing up space) kept, per machine, with Restore and Drop.
/// Each call goes to the machine the save lives on.
struct LaneRecentlyDeletedSections: View {
  let syncService: SyncService
  let machines: [LaneRecentlyDeletedMachine]
  let canRunLiveActions: Bool
  /// Changes when the list should read again: a pull to refresh, or a delete
  /// or restore elsewhere on the screen.
  let reloadToken: String
  let onRestored: () async -> Void

  /// Rows per machine id; a machine whose read fails keeps its last rows.
  @State private var entries: [String: [DeletedLaneSnapshot]]
  @State private var loadedProjectId: String?
  @State private var loadError: String?
  @State private var attempt = 0
  @State private var running: String?
  @State private var message: (text: String, isError: Bool)?
  @State private var pendingDrop: (machine: LaneRecentlyDeletedMachine, snapshot: DeletedLaneSnapshot)?

  init(
    syncService: SyncService,
    machines: [LaneRecentlyDeletedMachine],
    canRunLiveActions: Bool,
    reloadToken: String = "",
    initialEntries: [String: [DeletedLaneSnapshot]] = [:],
    onRestored: @escaping () async -> Void
  ) {
    self.syncService = syncService
    self.machines = machines
    self.canRunLiveActions = canRunLiveActions
    self.reloadToken = reloadToken
    self.onRestored = onRestored
    _entries = State(initialValue: initialEntries)
  }

  /// Nil-routed calls go to the active project, so it is part of what was read.
  private var loadKey: String {
    let machineKeys = machines.map { "\($0.id)|\($0.projectId ?? "")" }.joined(separator: ",")
    return "\(syncService.activeProjectId ?? "")|\(machineKeys)|\(reloadToken)|\(attempt)"
  }

  var body: some View {
    // A modifier on an empty container never runs, and this view is empty
    // until the first read comes back, so the load hangs off a row that is
    // always there.
    Color.clear
      .frame(height: 0)
      .accessibilityHidden(true)
      .adeFlatRow(insets: EdgeInsets(), separator: .hidden)
      .task(id: loadKey) { await load() }
      .confirmationDialog(
        "Drop this lane's saved work?",
        isPresented: Binding(get: { pendingDrop != nil }, set: { if !$0 { pendingDrop = nil } }),
        titleVisibility: .visible,
        presenting: pendingDrop
      ) { pending in
        Button("Drop", role: .destructive) {
          Task { await drop(pending.snapshot, machine: pending.machine) }
        }
        Button("Cancel", role: .cancel) {}
      } message: { pending in
        Text(pending.snapshot.isFreed
          ? "“\(pending.snapshot.laneName)” stays archived, but ADE will no longer be able to put back its uncommitted files."
          : "ADE will no longer be able to bring back “\(pending.snapshot.laneName)”.")
      }
    if let loadError {
      ADEFlatInlineNotice(message: loadError, tint: ADEColor.danger, retry: { attempt += 1 })
        .adeFlatRow(separator: .hidden)
    }
    if let message {
      if message.isError {
        ADEFlatInlineNotice(message: message.text, tint: ADEColor.danger)
          .adeFlatRow(separator: .hidden)
      } else {
        Label(message.text, systemImage: "checkmark.circle.fill")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .padding(.horizontal, 16)
          .padding(.vertical, 6)
          .adeFlatRow(separator: .hidden)
      }
    }
    ForEach(machines) { machine in
      if let rows = entries[machine.id], !rows.isEmpty {
        Section {
          ForEach(rows) { snapshot in
            row(snapshot, machine: machine)
          }
        } header: {
          ADEFlatSectionHeader(
            machines.count > 1 ? "Recently deleted · \(machine.name)" : "Recently deleted",
            detail: "\(rows.count)"
          )
        }
      }
    }
  }

  private func row(_ snapshot: DeletedLaneSnapshot, machine: LaneRecentlyDeletedMachine) -> some View {
    let restoring = running == snapshot.id
    return HStack(alignment: .center, spacing: 12) {
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 30, height: 30)
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      VStack(alignment: .leading, spacing: 3) {
        Text(snapshot.laneName)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let branch = snapshot.branchName, !branch.isEmpty {
          Text(branch)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Text(deletedLaneMetaLine(snapshot))
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      Button {
        Task { await restore(snapshot, machine: machine) }
      } label: {
        if restoring {
          ProgressView().controlSize(.small)
        } else {
          Text(snapshot.isFreed ? "Put back" : "Restore")
        }
      }
      .buttonStyle(ADEKitButtonStyle(tone: .neutral))
      .disabled(running != nil || !canRunLiveActions)
      .accessibilityLabel(snapshot.isFreed ? "Put back \(snapshot.laneName)'s files" : "Restore \(snapshot.laneName)")
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .adeFlatRow(insets: EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 6))
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        pendingDrop = (machine, snapshot)
      } label: {
        Label("Drop", systemImage: "trash")
      }
      .disabled(running != nil || !canRunLiveActions)
    }
    .contextMenu {
      Button(role: .destructive) {
        pendingDrop = (machine, snapshot)
      } label: {
        Label("Drop saved work", systemImage: "trash")
      }
      .disabled(running != nil || !canRunLiveActions)
    }
  }

  @MainActor
  private func load() async {
    let projectId = syncService.activeProjectId
    // Another project's rows must not show, or restore into this one.
    if let loadedProjectId, loadedProjectId != projectId { entries = [:] }
    loadedProjectId = projectId
    var results: [String: Result<[DeletedLaneSnapshot], Error>] = [:]
    await withTaskGroup(of: (String, Result<[DeletedLaneSnapshot], Error>).self) { group in
      for machine in machines {
        group.addTask { @MainActor in
          do {
            return (machine.id, .success(try await syncService.listDeletedLanes(
              targetProjectId: machine.projectId,
              targetProjectRootPath: machine.rootPath
            )))
          } catch {
            return (machine.id, .failure(error))
          }
        }
      }
      for await (key, result) in group {
        results[key] = result
      }
    }
    guard !Task.isCancelled else { return }
    let current = Set(machines.map(\.id))
    entries = entries.filter { current.contains($0.key) }
    var failed: [String] = []
    for machine in machines {
      switch results[machine.id] {
      case .success(let rows):
        entries[machine.id] = rows
      case .failure(let error):
        // A machine on an older ADE simply has none to list.
        if !syncChatLaunchErrorIsUnsupportedCommand(error) { failed.append(machine.name) }
      case nil:
        break
      }
    }
    // Disconnected already says so at the top of the tab.
    loadError = failed.isEmpty || syncService.connectionState != .connected
      ? nil
      : "Couldn’t read deleted lanes from \(failed.joined(separator: ", "))."
  }

  @MainActor
  private func restore(_ snapshot: DeletedLaneSnapshot, machine: LaneRecentlyDeletedMachine) async {
    guard running == nil else { return }
    running = snapshot.id
    defer { running = nil }
    do {
      let result = try await syncService.restoreDeletedLane(
        snapshot.id,
        targetProjectId: machine.projectId,
        targetProjectRootPath: machine.rootPath
      )
      if result.restoredUncommitted {
        ADEHaptics.success()
        entries[machine.id]?.removeAll { $0.id == snapshot.id }
      } else {
        ADEHaptics.warning()
      }
      message = (deletedLaneRestoreMessage(snapshot, result), !result.restoredUncommitted)
      await onRestored()
    } catch {
      ADEHaptics.error()
      message = ("Couldn’t restore \(snapshot.laneName): \(SyncUserFacingError.message(for: error))", true)
    }
  }

  @MainActor
  private func drop(_ snapshot: DeletedLaneSnapshot, machine: LaneRecentlyDeletedMachine) async {
    guard running == nil else { return }
    running = snapshot.id
    defer { running = nil }
    do {
      try await syncService.removeDeletedLane(
        snapshot.id,
        targetProjectId: machine.projectId,
        targetProjectRootPath: machine.rootPath
      )
      entries[machine.id]?.removeAll { $0.id == snapshot.id }
      message = nil
    } catch {
      ADEHaptics.error()
      message = ("Couldn’t drop that lane’s saved work: \(SyncUserFacingError.message(for: error))", true)
    }
  }
}

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
