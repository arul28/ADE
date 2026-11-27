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
  let machine: ProjectCopyMachine
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
/// machine.
@Observable
@MainActor
final class ArchiveEverywhereStore {
  /// One machine's archive, and its "Free up space after" setting.
  struct Rows: Equatable {
    var items: [ArchivedItem] = []
    var staleAfterDays: Int?
  }

  typealias Read = EveryMachineReads<Rows>.Read

  /// A lane Delete refused for unsaved work, waiting for "Delete anyway".
  struct PendingForce: Identifiable {
    let entry: ArchiveEntry
    let message: String
    var id: String { entry.id }
  }

  static let defaultStaleDays = 14

  let reads: EveryMachineReads<Rows>
  private(set) var entries: [ArchiveEntry] = []
  /// The row an action is running on.
  var running: String?
  var toast: ADEToastMessage?
  var pendingDelete: ArchiveEntry?
  var pendingForce: PendingForce?

  /// `frozen` is a preview's fixture: it never reads a machine.
  init(machines: [ProjectCopyMachine] = [], reads: [String: Read] = [:], frozen: Bool = false) {
    self.reads = EveryMachineReads(machines: machines, reads: reads, frozen: frozen, fetch: Self.fetch)
    rebuild()
    self.reads.onChange = { [weak self] in self?.rebuild() }
  }

  var isBusy: Bool { running != nil }

  /// A machine's line between recent and old: its "Free up space after"
  /// setting, or `defaultStaleDays` when it sent none. Each machine keeps its
  /// own setting, so each row splits at its own machine's line.
  func staleDays(on machineId: String) -> Int {
    reads.byMachine[machineId]?.value.staleAfterDays ?? Self.defaultStaleDays
  }

  private static func fetch(_ machine: ProjectCopyMachine, sync: SyncService) async -> (Read?) -> Read {
    do {
      let result = try await sync.listArchive(targetProjectId: machine.projectId, targetProjectRootPath: machine.rootPath)
      let next = Read(value: Rows(items: result.items, staleAfterDays: result.staleAfterDays), done: true)
      return { _ in next }
    } catch {
      if syncChatLaunchErrorIsUnsupportedCommand(error) {
        return { _ in Read(value: Rows(), done: true, outdated: true) }
      }
      let message = SyncUserFacingError.message(for: error)
      // A failed re-read keeps the rows it had, and the line they split at.
      return { previous in
        Read(
          value: Rows(items: previous?.value.items ?? [], staleAfterDays: previous?.value.staleAfterDays),
          done: true,
          error: message
        )
      }
    }
  }

  private func rebuild() {
    var next: [ArchiveEntry] = []
    for machine in reads.machines {
      for item in reads.byMachine[machine.id]?.value.items ?? [] {
        next.append(ArchiveEntry(machine: machine, item: item))
      }
    }
    next.sort { $0.at > $1.at }
    if next != entries { entries = next }
  }

  private func forget(_ refs: [ArchiveItemRef], on machineId: String) {
    let gone = Set(refs.map { "\($0.kind):\($0.id)" })
    reads.update(machineId) { rows in rows.items.removeAll { gone.contains("\($0.kind):\($0.id)") } }
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
    reads.reload(entry.machine.id, sync: sync)
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
        pendingForce = PendingForce(
          entry: entry,
          message: dirty.error.range(of: "^Lane has uncommitted changes\\.", options: [.regularExpression, .caseInsensitive]) != nil
            ? "Deleting loses it. Commits on the lane’s branch stay."
            : "Deleting also removes files and commits that exist only in this lane’s folders."
        )
      } else {
        report("Deleted", result)
      }
      if !result.done.isEmpty { onChanged?() }
    } catch {
      ADEHaptics.error()
      toast = ADEToastMessage(text: "Couldn’t delete \(entry.item.title)", kind: .failure, detail: SyncUserFacingError.message(for: error))
    }
    reads.reload(entry.machine.id, sync: sync)
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
/// than each row's machine's "Free up space after" setting). Restore and
/// Delete per row.
struct ArchiveEverywhereSections: View {
  let store: ArchiveEverywhereStore
  let syncService: SyncService
  let machines: [ProjectCopyMachine]
  var query = ""
  var filter: ArchiveKindFilter = .all
  var canRunLiveActions = true
  var reloadToken = ""
  var onChanged: (() -> Void)?

  var body: some View {
    EveryMachineStatusRows(
      reads: store.reads,
      syncService: syncService,
      machines: machines,
      style: .settings,
      reloadToken: reloadToken,
      failedMessage: { "Couldn’t open \($0.name)’s archive." },
      outdatedMessage: { "\($0.name) runs an older ADE. Update it there to see its archive." },
      noMachinesMessage: "Connect a computer to see what you archived.",
      loadingMessage: "Loading the archive…"
    ) {
      content
    }
  }

  /// The rows once a machine answered.
  @ViewBuilder
  private var content: some View {
    let rows = archiveFiltered(store.entries, kind: filter, query: query)
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if rows.isEmpty && !trimmed.isEmpty {
      Section {
        Text("Nothing archived matches “\(trimmed)”.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeSettingsListRow()
      }
    } else if rows.isEmpty {
      if store.reads.pending.isEmpty {
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
      let split = staleSplit(rows)
      if !split.recent.isEmpty { group(split.days.map { "Last \($0) days" } ?? "Recent", split.recent) }
      if !split.older.isEmpty { group(split.days.map { "Older than \($0) days" } ?? "Older", split.older) }
    }
  }

  /// The rows split at each row's own machine's line. `days` is that line
  /// when every row's machine uses the same one, else nil.
  private func staleSplit(_ rows: [ArchiveEntry]) -> (recent: [ArchiveEntry], older: [ArchiveEntry], days: Int?) {
    let now = Date()
    var recent: [ArchiveEntry] = []
    var older: [ArchiveEntry] = []
    var lines = Set<Int>()
    for entry in rows {
      let days = store.staleDays(on: entry.machine.id)
      lines.insert(days)
      if archiveIsStale(entry.item.archivedAt, days: days, now: now) {
        older.append(entry)
      } else {
        recent.append(entry)
      }
    }
    return (recent, older, lines.count == 1 ? lines.first : nil)
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
      isPresented: pendingBinding(store, \.pendingDelete, id: entry.id),
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
      isPresented: pendingBinding(store, \.pendingForce, id: entry.id),
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
      ADEMetaLine(parts: entry.metaParts + (machineName.map { [$0] } ?? []))
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
