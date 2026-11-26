import SwiftUI

// MARK: - Words

enum ArchiveKindFilter: String, CaseIterable, Identifiable {
  case all, lane, chat, shell
  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .lane: return "Lanes"
    case .chat: return "Chats"
    case .shell: return "Shells & CLIs"
    }
  }

  /// "No archived lanes", for an empty filter.
  var emptyTitle: String {
    switch self {
    case .all: return "Nothing archived"
    case .lane: return "No archived lanes"
    case .chat: return "No archived chats"
    case .shell: return "No archived shells"
    }
  }
}

/// "2 lanes, 1 chat", kinds with none left out, as the desktop's `describeRefs`.
func archiveDescribe(_ refs: [ArchiveItemRef]) -> String {
  let words: [(kind: String, one: String, many: String)] = [("lane", "lane", "lanes"), ("chat", "chat", "chats"), ("shell", "shell", "shells")]
  return words.compactMap { word in
    let count = refs.filter { $0.kind == word.kind }.count
    guard count > 0 else { return nil }
    return "\(count) \(count == 1 ? word.one : word.many)"
  }.joined(separator: ", ")
}

func archiveBytesLabel(_ bytes: Double) -> String {
  ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
}

/// Archived at least `days` days ago. An unreadable date is never old.
func archiveIsStale(_ archivedAt: String, days: Int, now: Date = Date()) -> Bool {
  guard let at = parseLaneTimestamp(archivedAt) else { return false }
  return at <= now.addingTimeInterval(-Double(days) * 86_400)
}

// MARK: - Rows

/// One archived thing, and the machine it is archived on.
struct ArchiveEntry: Identifiable, Equatable {
  let machine: LaneRecentlyDeletedMachine
  let item: ArchivedItem
  var id: String { "\(machine.id)\n\(item.kind):\(item.id)" }
  var at: Date { parseLaneTimestamp(item.archivedAt) ?? .distantPast }

  var isFreedLane: Bool { item.kind == "lane" && item.worktreePresent == false }

  /// "perf lane 3", "Claude Code", "Archived 3d ago", "2.1 MB", then the
  /// lane's folder state.
  var metaParts: [String] {
    var parts: [String] = []
    if item.kind != "lane", let lane = item.laneName, !lane.isEmpty { parts.append(lane) }
    if let tool = item.toolLabel, !tool.isEmpty, tool != item.title { parts.append(tool) }
    parts.append("Archived \(deletedAgo(item.archivedAt))")
    if let bytes = item.sizeBytes, bytes > 0 { parts.append(archiveBytesLabel(bytes)) }
    if isFreedLane {
      parts.append("space freed, Restore recreates its folder")
    } else if item.kind == "lane", let error = item.freeUpError, !error.isEmpty {
      parts.append("couldn’t free up space: \(error)")
    } else if item.kind == "lane", item.freeUpDue == true {
      parts.append("due to free up space")
    }
    return parts
  }
}

func archiveFiltered(_ entries: [ArchiveEntry], kind: ArchiveKindFilter, query: String) -> [ArchiveEntry] {
  let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
  return entries.filter { entry in
    if kind != .all, entry.item.kind != kind.rawValue { return false }
    guard !words.isEmpty else { return true }
    let text = [entry.item.title, entry.item.laneName, entry.item.toolLabel].compactMap { $0 }.joined(separator: " ").lowercased()
    return words.allSatisfy { text.contains($0) }
  }
}

// MARK: - Store

/// The archive of every live machine with the project, read and acted on per
/// machine, merged newest first. Restore and Delete go to the row's own
/// machine. One slow or failed machine never holds up the others.
@Observable
@MainActor
final class ArchiveEverywhereStore {
  struct Read: Equatable {
    var items: [ArchivedItem] = []
    var staleAfterDays: Int?
    var done = false
    var error: String?
    /// The machine runs an ADE with no archive to list.
    var outdated = false
  }

  static let defaultStaleDays = 14

  private(set) var machines: [LaneRecentlyDeletedMachine] = []
  private(set) var reads: [String: Read] = [:]
  private(set) var entries: [ArchiveEntry] = []
  /// The row an action is running on.
  var running: String?
  var toast: ADEToastMessage?
  var pendingDelete: ArchiveEntry?
  /// A lane Delete refused for unsaved work, waiting for "Delete anyway".
  var pendingForce: (entry: ArchiveEntry, message: String)?

  @ObservationIgnored private var loadedKey: String?
  @ObservationIgnored private var loadedProjectId: String?
  @ObservationIgnored private var readTasks: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private var generation = 0
  /// A preview's fixture: it never reads a machine.
  @ObservationIgnored private let frozen: Bool

  init(machines: [LaneRecentlyDeletedMachine] = [], reads: [String: Read] = [:], frozen: Bool = false) {
    self.machines = machines
    self.reads = reads
    self.frozen = frozen
    rebuild()
  }

  var isBusy: Bool { running != nil }
  var anyDone: Bool { machines.contains { reads[$0.id]?.done == true } }
  var pending: [LaneRecentlyDeletedMachine] { machines.filter { reads[$0.id]?.done != true } }
  var failed: [(machine: LaneRecentlyDeletedMachine, message: String)] {
    machines.compactMap { machine in reads[machine.id]?.error.map { (machine, $0) } }
  }
  var outdated: [LaneRecentlyDeletedMachine] { machines.filter { reads[$0.id]?.outdated == true } }

  /// The line between recent and old: the "Free up space after" setting of
  /// the first machine that answered (the focused one comes first).
  var staleDays: Int {
    machines.lazy.compactMap { self.reads[$0.id]?.staleAfterDays }.first ?? Self.defaultStaleDays
  }

  func load(machines: [LaneRecentlyDeletedMachine], key: String, sync: SyncService) {
    guard !frozen, key != loadedKey else { return }
    loadedKey = key
    let projectId = sync.activeProjectId
    if loadedProjectId != projectId {
      for task in readTasks.values { task.cancel() }
      readTasks = [:]
      reads = [:]
      generation += 1
    }
    loadedProjectId = projectId
    self.machines = machines
    let ids = Set(machines.map(\.id))
    reads = reads.filter { ids.contains($0.key) }
    rebuild()
    for machine in machines { read(machine, sync: sync) }
  }

  func reload(_ machineId: String, sync: SyncService) {
    guard !frozen, let machine = machines.first(where: { $0.id == machineId }) else { return }
    if reads[machineId]?.error != nil { reads[machineId]?.error = nil }
    read(machine, sync: sync)
  }

  private func read(_ machine: LaneRecentlyDeletedMachine, sync: SyncService) {
    readTasks[machine.id]?.cancel()
    let runGeneration = generation
    readTasks[machine.id] = Task { @MainActor [weak self] in
      var next: Read
      do {
        let result = try await sync.listArchive(targetProjectId: machine.projectId, targetProjectRootPath: machine.rootPath)
        next = Read(items: result.items, staleAfterDays: result.staleAfterDays, done: true)
      } catch {
        next = Read(done: true)
        if syncChatLaunchErrorIsUnsupportedCommand(error) {
          next.outdated = true
        } else {
          next.error = SyncUserFacingError.message(for: error)
          // A failed re-read keeps the rows it had.
          next.items = self?.reads[machine.id]?.items ?? []
        }
      }
      guard let self, !Task.isCancelled, runGeneration == self.generation else { return }
      self.reads[machine.id] = next
      self.readTasks[machine.id] = nil
      self.rebuild()
    }
  }

  private func rebuild() {
    var next: [ArchiveEntry] = []
    for machine in machines {
      for item in reads[machine.id]?.items ?? [] {
        next.append(ArchiveEntry(machine: machine, item: item))
      }
    }
    next.sort { $0.at > $1.at }
    if next != entries { entries = next }
  }

  private func forget(_ refs: [ArchiveItemRef], on machineId: String) {
    let gone = Set(refs.map { "\($0.kind):\($0.id)" })
    reads[machineId]?.items.removeAll { gone.contains("\($0.kind):\($0.id)") }
    rebuild()
  }

  // MARK: Actions

  func restore(_ entry: ArchiveEntry, sync: SyncService, onChanged: (() -> Void)?) async {
    guard running == nil else { return }
    running = entry.id
    defer { running = nil }
    do {
      let result = try await sync.restoreArchived(
        [entry.item.ref],
        targetProjectId: entry.machine.projectId,
        targetProjectRootPath: entry.machine.rootPath
      )
      forget(result.done, on: entry.machine.id)
      report("Restored", result)
      if !result.done.isEmpty { onChanged?() }
    } catch {
      ADEHaptics.error()
      toast = ADEToastMessage(text: "Couldn’t restore \(entry.item.title)", kind: .failure, detail: SyncUserFacingError.message(for: error))
    }
    reload(entry.machine.id, sync: sync)
  }

  /// Deletes for good. A lane with unsaved work is refused unless forced: the
  /// refusal asks once, by name ("Delete anyway").
  func delete(_ entry: ArchiveEntry, force: Bool, sync: SyncService, onChanged: (() -> Void)?) async {
    guard running == nil else { return }
    running = entry.id
    defer { running = nil }
    do {
      let result = try await sync.deleteArchived(
        [entry.item.ref],
        force: force,
        targetProjectId: entry.machine.projectId,
        targetProjectRootPath: entry.machine.rootPath
      )
      forget(result.done, on: entry.machine.id)
      if !force, entry.item.kind == "lane",
         let dirty = result.failed.first(where: { $0.kind == "lane" && $0.error.range(of: "enable force delete", options: .caseInsensitive) != nil }) {
        pendingForce = (entry, dirty.error.range(of: "^Lane has uncommitted changes\\.", options: [.regularExpression, .caseInsensitive]) != nil
          ? "Deleting loses it. Commits on the lane’s branch stay."
          : "Deleting also removes files and commits that exist only in this lane’s folders.")
      } else {
        report("Deleted", result)
      }
      if !result.done.isEmpty { onChanged?() }
    } catch {
      ADEHaptics.error()
      toast = ADEToastMessage(text: "Couldn’t delete \(entry.item.title)", kind: .failure, detail: SyncUserFacingError.message(for: error))
    }
    reload(entry.machine.id, sync: sync)
  }

  private func report(_ verb: String, _ result: ArchiveActionResult) {
    if !result.done.isEmpty {
      if let failure = result.failed.first {
        ADEHaptics.warning()
        toast = ADEToastMessage(
          text: "\(verb) \(archiveDescribe(result.done))",
          kind: .info,
          detail: "\(result.failed.count) couldn’t be \(verb.lowercased()): \(failure.error)"
        )
      } else {
        ADEHaptics.success()
        toast = ADEToastMessage(text: "\(verb) \(archiveDescribe(result.done))", kind: .success)
      }
    } else if let failure = result.failed.first {
      ADEHaptics.error()
      toast = ADEToastMessage(text: "Couldn’t \(verb == "Restored" ? "restore" : "delete") that", kind: .failure, detail: failure.error)
    }
  }
}

// MARK: - The list

/// Settings › Deleted & Archived › Archive as List sections: every live
/// machine's archive merged newest first, in two groups (recent, and older
/// than the "Free up space after" setting). Restore and Delete per row.
struct ArchiveEverywhereSections: View {
  let store: ArchiveEverywhereStore
  let syncService: SyncService
  let machines: [LaneRecentlyDeletedMachine]
  var query = ""
  var filter: ArchiveKindFilter = .all
  var canRunLiveActions = true
  var reloadToken = ""
  var onChanged: (() -> Void)?

  private var loadKey: String {
    let machineKeys = machines.map { "\($0.id)|\($0.projectId ?? "")" }.joined(separator: ",")
    return "\(syncService.activeProjectId ?? "")|\(machineKeys)|\(reloadToken)"
  }

  var body: some View {
    ForEach(store.failed, id: \.machine.id) { failure in
      ADEFlatInlineNotice(
        message: "Couldn’t open \(failure.machine.name)’s archive.",
        tint: ADEColor.danger,
        technicalDetail: failure.message,
        retry: { store.reload(failure.machine.id, sync: syncService) }
      )
      .listRowBackground(Color.clear)
      .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
      .listRowSeparator(.hidden)
    }
    ForEach(store.outdated) { machine in
      Text("\(machine.name) runs an older ADE. Update it there to see its archive.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize(horizontal: false, vertical: true)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
        .listRowSeparator(.hidden)
    }
    // Always at least one row (loading, empty, rows), each running the same
    // idempotent load.
    content
      .task(id: loadKey) { store.load(machines: machines, key: loadKey, sync: syncService) }
    if store.anyDone, !store.pending.isEmpty {
      Section {
        Text("Still reading \(store.pending.map(\.name).joined(separator: ", "))…")
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
          .listRowBackground(Color.clear)
          .task(id: loadKey) { store.load(machines: machines, key: loadKey, sync: syncService) }
      }
    }
  }

  @ViewBuilder
  private var content: some View {
    let rows = archiveFiltered(store.entries, kind: filter, query: query)
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if machines.isEmpty {
      Section {
        ADESettingsNotice(message: "Connect a computer to see what you archived.")
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
      }
    } else if !store.anyDone {
      Section {
        HStack(spacing: 10) {
          ProgressView().controlSize(.small)
          Text("Loading the archive…")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .adeSettingsListRow()
      }
    } else if rows.isEmpty && !trimmed.isEmpty {
      Section {
        Text("Nothing archived matches “\(trimmed)”.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeSettingsListRow()
      }
    } else if rows.isEmpty {
      if store.pending.isEmpty {
        Section {
          ADEEmptyStateView(
            symbol: "archivebox",
            title: filter.emptyTitle,
            message: "Archive hides a lane, chat or shell without deleting it. Archived ones show up here."
          )
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
        }
      }
    } else {
      let days = store.staleDays
      let now = Date()
      let recent = rows.filter { !archiveIsStale($0.item.archivedAt, days: days, now: now) }
      let older = rows.filter { archiveIsStale($0.item.archivedAt, days: days, now: now) }
      if !recent.isEmpty { group("Last \(days) days", recent) }
      if !older.isEmpty { group("Older than \(days) days", older) }
    }
  }

  private func group(_ title: String, _ rows: [ArchiveEntry]) -> some View {
    let bytes = rows.reduce(0) { $0 + ($1.item.sizeBytes ?? 0) }
    return Section {
      ForEach(rows) { entry in row(entry) }
    } header: {
      ADESettingsHeader(title: title, inList: true) {
        Text(bytes > 0 ? "\(rows.count) · \(archiveBytesLabel(bytes))" : "\(rows.count)")
          .font(.adeMono(12))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
  }

  private func row(_ entry: ArchiveEntry) -> some View {
    let disabled = store.isBusy || !canRunLiveActions
    return ArchiveRow(
      entry: entry,
      machineName: machines.count > 1 ? entry.machine.name : nil,
      restoring: store.running == entry.id,
      disabled: disabled,
      onRestore: { Task { await store.restore(entry, sync: syncService, onChanged: onChanged) } }
    )
    // On the row, so the popover on a wide screen points at it.
    .confirmationDialog(
      "Delete “\(entry.item.title)”?",
      isPresented: Binding(
        get: { store.pendingDelete?.id == entry.id },
        set: { if !$0, store.pendingDelete?.id == entry.id { store.pendingDelete = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        Task { await store.delete(entry, force: false, sync: syncService, onChanged: onChanged) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(entry.item.kind == "lane"
        ? "Gone for good, transcripts and its folder too. Its branch stays."
        : "Gone for good, its transcript too.")
    }
    .confirmationDialog(
      "\(entry.item.title) has unsaved work",
      isPresented: Binding(
        get: { store.pendingForce?.entry.id == entry.id },
        set: { if !$0, store.pendingForce?.entry.id == entry.id { store.pendingForce = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete anyway", role: .destructive) {
        Task { await store.delete(entry, force: true, sync: syncService, onChanged: onChanged) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(store.pendingForce?.message ?? "")
    }
    .adeSettingsListRow()
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        store.pendingDelete = entry
      } label: {
        Label("Delete", systemImage: "trash")
      }
      .disabled(disabled)
    }
    .contextMenu {
      Button {
        Task { await store.restore(entry, sync: syncService, onChanged: onChanged) }
      } label: {
        Label("Restore", systemImage: "arrow.uturn.backward")
      }
      .disabled(disabled)
      Button(role: .destructive) {
        store.pendingDelete = entry
      } label: {
        Label("Delete", systemImage: "trash")
      }
      .disabled(disabled)
    }
  }
}

/// An archived lane, chat or shell: its mark, title, where, when, Restore.
struct ArchiveRow: View {
  let entry: ArchiveEntry
  let machineName: String?
  let restoring: Bool
  let disabled: Bool
  let onRestore: () -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .subheadline) private var markSize: CGFloat = 30

  private var item: ArchivedItem { entry.item }

  var body: some View {
    if dynamicTypeSize.isAccessibilitySize {
      VStack(alignment: .leading, spacing: 8) {
        text
        restoreButton
      }
    } else {
      HStack(alignment: .center, spacing: 12) {
        mark
        text
        Spacer(minLength: 8)
        restoreButton
      }
    }
  }

  @ViewBuilder
  private var mark: some View {
    if item.kind == "lane" {
      let color = LaneColorPalette.displayColor(forHex: item.laneColor)
      WorkLaneLogoMark(color: color, size: markSize * 0.5)
        .frame(width: markSize, height: markSize)
        .background(color.opacity(0.16), in: RoundedRectangle(cornerRadius: markSize * 0.27, style: .continuous))
        .accessibilityHidden(true)
    } else {
      let tool = item.toolType ?? "shell"
      WorkProviderLogo(
        provider: tool,
        fallbackSymbol: item.kind == "shell" ? "terminal.fill" : providerIcon(tool),
        tint: providerTint(tool),
        size: markSize
      )
      .accessibilityHidden(true)
    }
  }

  private var text: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(item.title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
      if item.kind == "lane", let branch = item.branchRef, !branch.isEmpty {
        Text(branch)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      DeletedMetaLine(parts: entry.metaParts + (machineName.map { [$0] } ?? []))
        .font(.caption)
        .foregroundStyle(item.kind == "lane" && item.freeUpError != nil ? ADEColor.warning : ADEColor.textMuted)
    }
    .accessibilityElement(children: .combine)
  }

  private var restoreButton: some View {
    Button(action: onRestore) {
      if restoring {
        ProgressView().controlSize(.small)
      } else {
        Text("Restore")
      }
    }
    .buttonStyle(ADEKitButtonStyle(tone: .neutral))
    .disabled(disabled)
    .accessibilityLabel("Restore \(item.title)")
  }
}
