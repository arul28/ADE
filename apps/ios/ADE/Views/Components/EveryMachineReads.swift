import SwiftUI

// Lists that read every live machine with a copy of the open project and show
// one list: Recently deleted and the Archive. Each machine is read on its own,
// so one slow or failed machine never holds up the others, and every action on
// a row goes to the row's own machine.

// MARK: - Machines

/// One machine's copy of the open project, for a list read from every machine.
/// `projectId`/`rootPath` are nil for the focused machine (the default route).
/// For another machine they are its machine-marked project, so every call for
/// one of its rows goes over that machine's own link.
struct ProjectCopyMachine: Equatable, Identifiable, Hashable {
  let id: String
  let name: String
  let projectId: String?
  let rootPath: String?

  var isFocused: Bool { id.isEmpty }

  /// The focused machine while the phone is connected to it, then every live
  /// machine with a copy of the open repository, from the same source as the
  /// Lanes tab's other-machine rows. A machine that is not live (reconnecting,
  /// or an ADE Cloud computer that is asleep) is left out, so reading the list
  /// never wakes it.
  @MainActor
  static func everyLiveCopy(sync: SyncService) -> [ProjectCopyMachine] {
    var machines: [ProjectCopyMachine] = []
    if sync.connectionState == .connected {
      machines.append(ProjectCopyMachine(id: "", name: sync.focusedMachineDisplayName, projectId: nil, rootPath: nil))
    }
    for repo in sync.listedRemoteReposForActiveProject() where sync.machineFleet?.isLive(repo.machineKey) == true {
      machines.append(ProjectCopyMachine(
        id: repo.machineKey,
        name: repo.machineName,
        projectId: repo.markedProjectId,
        rootPath: repo.rootPath
      ))
    }
    return machines
  }

  /// A lane id the phone can navigate to and route by: another machine's
  /// lanes carry their machine (`workRemoteLaneId`).
  func navigationLaneId(_ laneId: String) -> String {
    guard !isFocused, !isWorkRemoteLaneId(laneId) else { return laneId }
    return workRemoteLaneId(machineKey: id, laneId: laneId)
  }
}

/// The key a list loads once per: the project, each machine's copy, and a
/// reload token (a pull to refresh, or an action elsewhere on the screen).
func everyMachineLoadKey(_ machines: [ProjectCopyMachine], projectId: String?, reloadToken: String) -> String {
  let machineKeys = machines.map { "\($0.id)|\($0.projectId ?? "")" }.joined(separator: ",")
  return "\(projectId ?? "")|\(machineKeys)|\(reloadToken)"
}

// MARK: - Reads

/// One read per machine with a copy of the project. The store that owns it
/// builds its rows from `byMachine` and keeps its own actions.
@Observable
@MainActor
final class EveryMachineReads<Value: Equatable> {
  /// One machine's answer. `done` stays true across a re-read, so the rows
  /// already shown stay while it runs.
  struct Read: Equatable {
    var value: Value
    var done = false
    var error: String?
    /// The machine runs an ADE too old to answer this read.
    var outdated = false
  }

  /// Reads one machine. It returns how to fold the answer into the read that
  /// machine holds when the answer comes back.
  typealias Fetch = @MainActor (ProjectCopyMachine, SyncService) async -> (Read?) -> Read

  private(set) var machines: [ProjectCopyMachine] = []
  private(set) var byMachine: [String: Read] = [:]

  /// Runs after `machines` or `byMachine` changes: the store rebuilds its rows.
  @ObservationIgnored var onChange: (() -> Void)?
  /// Runs when a load drops another project's reads: the store clears what
  /// belongs to that project.
  @ObservationIgnored var onProjectChange: (() -> Void)?

  @ObservationIgnored private let fetch: Fetch
  @ObservationIgnored private var loadedKey: String?
  @ObservationIgnored private var loadedProjectId: String?
  @ObservationIgnored private var readTasks: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private var generation = 0
  /// A preview's fixture: it never reads a machine.
  @ObservationIgnored private let frozen: Bool

  init(machines: [ProjectCopyMachine] = [], reads: [String: Read] = [:], frozen: Bool = false, fetch: @escaping Fetch) {
    self.machines = machines
    byMachine = reads
    self.frozen = frozen
    self.fetch = fetch
  }

  var anyDone: Bool { machines.contains { byMachine[$0.id]?.done == true } }
  var pending: [ProjectCopyMachine] { machines.filter { byMachine[$0.id]?.done != true } }
  var failed: [(machine: ProjectCopyMachine, message: String)] {
    machines.compactMap { machine in byMachine[machine.id]?.error.map { (machine, $0) } }
  }
  var outdated: [ProjectCopyMachine] { machines.filter { byMachine[$0.id]?.outdated == true } }

  /// Reads every machine once per `key` (see `everyMachineLoadKey`). A view's
  /// `.task` can run this on every appear. The reads are not tied to the view,
  /// so scrolling away does not cancel one.
  func load(machines: [ProjectCopyMachine], key: String, sync: SyncService) {
    guard !frozen, key != loadedKey else { return }
    loadedKey = key
    let projectId = sync.activeProjectId
    if loadedProjectId != projectId {
      // Another project's rows must not show, or take an action in this one.
      for task in readTasks.values { task.cancel() }
      readTasks = [:]
      byMachine = [:]
      generation += 1
      onProjectChange?()
    }
    loadedProjectId = projectId
    self.machines = machines
    let ids = Set(machines.map(\.id))
    byMachine = byMachine.filter { ids.contains($0.key) }
    onChange?()
    for machine in machines { read(machine, sync: sync) }
  }

  /// Reads one machine again: its Retry, or after an action on one of its rows.
  func reload(_ machineId: String, sync: SyncService) {
    guard !frozen, let machine = machines.first(where: { $0.id == machineId }) else { return }
    if byMachine[machineId]?.error != nil { byMachine[machineId]?.error = nil }
    read(machine, sync: sync)
  }

  /// Changes one machine's rows in place, such as a row an action took away.
  func update(_ machineId: String, _ change: (inout Value) -> Void) {
    guard var read = byMachine[machineId] else { return }
    change(&read.value)
    byMachine[machineId] = read
    onChange?()
  }

  private func read(_ machine: ProjectCopyMachine, sync: SyncService) {
    readTasks[machine.id]?.cancel()
    let runGeneration = generation
    let fetch = self.fetch
    readTasks[machine.id] = Task { @MainActor [weak self] in
      let fold = await fetch(machine, sync)
      guard let self, !Task.isCancelled, runGeneration == self.generation else { return }
      self.byMachine[machine.id] = fold(self.byMachine[machine.id])
      self.readTasks[machine.id] = nil
      self.onChange?()
    }
  }
}

// MARK: - The list's status rows

/// How a list read from every machine sits on its screen: flat rows on a page
/// (the Lanes tab) or rows in settings panels (Settings).
enum EveryMachineListStyle { case flat, settings }

/// The rows a list read from every machine shows about the reads, around the
/// list's own rows (`content`): a failed read with Retry, a machine on an
/// older ADE, no machine, the first read running, and the machines still
/// reading. It also starts the load. A flat list shows only the failures.
struct EveryMachineStatusRows<Value: Equatable, Content: View>: View {
  let reads: EveryMachineReads<Value>
  let syncService: SyncService
  /// The machines to read (`ProjectCopyMachine.everyLiveCopy`).
  let machines: [ProjectCopyMachine]
  let style: EveryMachineListStyle
  /// Changes when the list should read again.
  let reloadToken: String
  /// "Couldn’t read Mac Studio."
  let failedMessage: (ProjectCopyMachine) -> String
  /// A settings list's line for a machine on an older ADE.
  var outdatedMessage: ((ProjectCopyMachine) -> String)?
  /// A settings list's notice while no machine has the project.
  var noMachinesMessage = ""
  /// A settings list's line until the first machine answers.
  var loadingMessage = ""
  @ViewBuilder let content: () -> Content

  private var loadKey: String {
    everyMachineLoadKey(machines, projectId: syncService.activeProjectId, reloadToken: reloadToken)
  }

  var body: some View {
    switch style {
    case .flat:
      // A modifier on an empty container never runs, and a flat list is
      // empty until the first read comes back, so the load hangs off a row
      // that is always there (zero high in a flat list).
      Color.clear
        .frame(height: 0)
        .accessibilityHidden(true)
        .adeFlatRow(insets: EdgeInsets(), separator: .hidden)
        .task(id: loadKey) { load() }
      failures
      content()
    case .settings:
      failures
      if let outdatedMessage {
        ForEach(reads.outdated) { machine in
          Text(outdatedMessage(machine))
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
            .modifier(EveryMachineNoticeRowChrome(style: style))
        }
      }
      // Always at least one row (no machine, loading, the list's rows), each
      // running the same idempotent load. A settings list's 48pt rows would
      // show a zero-high anchor as a gap.
      settingsRows
        .task(id: loadKey) { load() }
      if reads.anyDone, !reads.pending.isEmpty {
        Section {
          Text("Still reading \(reads.pending.map(\.name).joined(separator: ", "))…")
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .listRowBackground(Color.clear)
            .task(id: loadKey) { load() }
        }
      }
    }
  }

  private func load() {
    reads.load(machines: machines, key: loadKey, sync: syncService)
  }

  /// Disconnected already says so at the top of the screen.
  private var failures: some View {
    ForEach(reads.failed, id: \.machine.id) { failure in
      ADEFlatInlineNotice(
        message: failedMessage(failure.machine),
        tint: ADEColor.danger,
        technicalDetail: failure.message,
        retry: { reads.reload(failure.machine.id, sync: syncService) }
      )
      .modifier(EveryMachineNoticeRowChrome(style: style))
    }
  }

  @ViewBuilder
  private var settingsRows: some View {
    if machines.isEmpty {
      Section {
        ADESettingsNotice(message: noMachinesMessage)
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
      }
    } else if !reads.anyDone {
      Section {
        HStack(spacing: 10) {
          ProgressView().controlSize(.small)
          Text(loadingMessage)
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .adeSettingsListRow()
      }
    } else {
      content()
    }
  }
}

/// A notice row above a list read from every machine: on the page, not in a
/// panel.
struct EveryMachineNoticeRowChrome: ViewModifier {
  let style: EveryMachineListStyle

  func body(content: Content) -> some View {
    switch style {
    case .flat:
      content.adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16), separator: .hidden)
    case .settings:
      content
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
        .listRowSeparator(.hidden)
    }
  }
}

/// A row's dialog flag: true while `keyPath` holds the item with `id`. Closing
/// the dialog clears the item only while it is still this row's, so one row's
/// dialog never closes another row's.
@MainActor
func pendingBinding<Root: AnyObject, Item: Identifiable>(
  _ root: Root,
  _ keyPath: ReferenceWritableKeyPath<Root, Item?>,
  id: Item.ID
) -> Binding<Bool> {
  Binding(
    get: { root[keyPath: keyPath]?.id == id },
    set: { if !$0, root[keyPath: keyPath]?.id == id { root[keyPath: keyPath] = nil } }
  )
}
