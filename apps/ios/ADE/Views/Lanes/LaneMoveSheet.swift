import SwiftUI

// "Move this lane to": the lane, its commits, its uncommitted work and its
// open chats and CLIs move to another of the person's computers. It opens
// from the lane detail's ⋯ menu and from a chat's machine label. The first
// screen lists the person's computers (ADE Cloud is one muted row: it can't
// take a moved lane yet). A pick opens the review, which says what moves and
// how; the move starts only from its Move button, and the same screen then
// follows it. Closing the sheet leaves the move running (`LaneMoveRuns`).
//
// Where each call goes: a live move runs on the lane's own brain
// (`laneMoveRoute`); a lane whose ADE Cloud computer was deleted comes back
// from the account's saved copies, run by the DESTINATION's brain (each
// target's own route). A lane whose ADE Cloud computer is asleep lists the
// same places and moves from the copy it saved, with no wake: the
// destination deletes the computer first. When that copy isn't complete,
// the review offers "Wake and move", which wakes it and moves it live. The
// pure rules are in `LaneMoveModel.swift`.

/// A lane move asked for while its ADE Cloud computer slept: once the
/// computer is up, the live lane detail opens the move sheet.
@MainActor
enum LaneMoveAfterWake {
  private(set) static var laneId: String?

  static func request(laneId: String) { self.laneId = laneId }

  /// Takes the request when it is for this lane (raw or `fleet|…` id).
  static func take(laneId: String) -> Bool {
    guard let pending = self.laneId else { return false }
    let raw = workParseRemoteLaneId(laneId)?.laneId ?? laneId
    guard pending == raw || pending == laneId else { return false }
    self.laneId = nil
    return true
  }
}

/// The chats of a lane that start a tree: the lane detail offers "Move to…"
/// only when it has one, since a live move reads its options through a
/// chat. The brain adds each one's subagents. A chat that already continues
/// on another machine stays out. Pure.
func laneMoveChats(_ chats: [AgentChatSessionSummary]) -> [AgentChatSessionSummary] {
  chats.filter { chat in
    chat.archivedAt == nil
      && (chat.surface ?? "work") == "work"
      && chat.orchestrationParentSessionId == nil
      && chat.crossMachineHandoff?.state != .continued
  }
}

/// The places a lane can move to: the brain's machines without the ADE
/// Cloud computers, which hold one lane each.
@MainActor
func laneMoveMachines(_ options: AgentChatCrossMachineHandoffOptions, sync: SyncService) -> [AgentChatCrossMachineHandoffMachineOption] {
  let cloudKeys = Set((sync.cloudAccountMachineKeys ?? []).map { $0.lowercased() })
    .union(sync.cloudServerInstances.compactMap { $0.machineKey?.lowercased() })
  return options.machines.filter { !cloudKeys.contains($0.machineKey.lowercased()) }
}

// MARK: - Where a lane moves from

/// Where a lane is, as its move needs it.
struct LaneMoveSource: Identifiable, Equatable {
  var id: String { laneId }
  var kind: LaneMoveSourceKind
  /// The lane as the phone names it (`fleet|…` for a lane of another
  /// machine); the kept lane's own id for a move from saved copies.
  let laneId: String
  var laneName: String
  /// Where the lane is now, for "From …" and the summary note.
  let machineName: String
  /// A chat on the lane: a live move reads its options through it.
  let viaSessionId: String?
  /// The fleet key of the lane's computer (an asleep one wakes through it).
  let fleetKey: String?
  /// The lane's own ADE Cloud computer, deleted once the move is checked.
  var computer: LaneMoveCloudComputer?
  /// The lane's sessions and chats when the caller already read them.
  var sessions: [TerminalSessionSummary]? = nil
  var chats: [AgentChatSessionSummary]? = nil

  /// The move ends with deleting the lane's ADE Cloud computer.
  var deletesComputer: Bool { kind == .cloud && computer != nil }

  /// The asleep ADE Cloud computer a move from its saved copy deletes first.
  /// Only a computer made for this one lane; nil for every other move.
  var fromComputer: String? { kind == .cloudAsleep ? computer?.instanceId : nil }

  /// The move comes from saved copies, run by the destination: a deleted
  /// computer's kept lane, or an asleep computer's saved copy.
  var restores: Bool { kind == .cloudGone || fromComputer != nil }

  /// The lane's own id, as a move from saved copies names it.
  var restoreLaneId: String { computer?.laneId ?? workParseRemoteLaneId(laneId)?.laneId ?? laneId }

  /// A lane whose ADE Cloud computer was deleted (a kept lane).
  static func kept(_ lane: CloudLaneWithoutComputer) -> LaneMoveSource {
    LaneMoveSource(
      kind: .cloudGone,
      laneId: lane.laneId,
      laneName: lane.laneName,
      machineName: ADECloudMachine.name,
      viaSessionId: nil,
      fleetKey: nil,
      computer: nil
    )
  }
}

/// What kind of move a lane gets, from where it lives now.
@MainActor
private func laneMoveKind(laneId: String, sync: SyncService) -> (
  kind: LaneMoveSourceKind,
  fleetKey: String?,
  computer: LaneMoveCloudComputer?,
  kept: CloudLaneWithoutComputer?
) {
  let fleetKey = cloudLaneFleetKey(laneId, sync: sync)
  guard sync.isCloudFleetKey(fleetKey) else { return (.own, fleetKey, nil, nil) }
  let plain = workParseRemoteLaneId(laneId)?.laneId ?? laneId
  if fleetKey?.hasPrefix(ADECloudMachine.savedFleetKeyPrefix) == true {
    let kept = AccountCloudStore.shared.lanesWithoutComputer.first { $0.laneId == plain }
    return (.cloudGone, fleetKey, nil, kept)
  }
  // Only a computer made for this one lane is deleted after the move.
  let computer = cloudLaneComputer(laneId, sync: sync).flatMap { instance -> LaneMoveCloudComputer? in
    guard instance.laneId == plain else { return nil }
    return LaneMoveCloudComputer(instanceId: instance.id, accountMachineKey: instance.machineKey, laneId: plain)
  }
  if case .awake? = cloudLaneState(fleetKey: fleetKey, sync: sync, store: AccountCloudStore.shared) {
    return (.cloud, fleetKey, computer, nil)
  }
  return (.cloudAsleep, fleetKey, computer, nil)
}

/// The move of a live lane the lane detail shows, with the sessions and
/// chats it already read.
@MainActor
func laneMoveSource(
  laneId: String,
  laneName: String,
  machineName: String?,
  sessions: [TerminalSessionSummary],
  chats: [AgentChatSessionSummary],
  sync: SyncService
) -> LaneMoveSource {
  let found = laneMoveKind(laneId: laneId, sync: sync)
  if found.kind == .cloudGone, let kept = found.kept { return .kept(kept) }
  let cloud = found.kind != .own
  return LaneMoveSource(
    kind: found.kind,
    laneId: laneId,
    laneName: laneName,
    machineName: cloud ? ADECloudMachine.name : (nonEmptyTrimmed(machineName) ?? "this computer"),
    viaSessionId: laneMoveChats(chats).first?.sessionId,
    fleetKey: found.fleetKey,
    computer: found.computer,
    sessions: sessions,
    chats: chats
  )
}

/// The move a chat's machine label opens: the chat's lane, from wherever it
/// is. Nil for a chat that can't move its lane (a CTO or personal chat, a
/// chat with no lane, a deleted ADE Cloud computer whose lane ADE no longer
/// keeps).
@MainActor
func laneMoveSourceForChat(
  sessionId: String,
  laneId: String,
  laneName: String?,
  surface: String?,
  sync: SyncService
) -> LaneMoveSource? {
  guard (surface ?? "work") == "work", nonEmptyTrimmed(laneId) != nil else { return nil }
  let found = laneMoveKind(laneId: laneId, sync: sync)
  if found.kind == .cloudGone {
    return found.kept.map(LaneMoveSource.kept)
  }
  return LaneMoveSource(
    kind: found.kind,
    laneId: laneId,
    laneName: nonEmptyTrimmed(laneName) ?? "This lane",
    machineName: found.kind == .own ? (sync.chatMachineName(sessionId: sessionId) ?? "this computer") : ADECloudMachine.name,
    viaSessionId: sessionId,
    fleetKey: found.fleetKey,
    computer: found.computer
  )
}

#if DEBUG
/// What a fixture screen shows in place of the brains' answers. Nothing is sent.
struct LaneMoveFixture {
  var options: AgentChatCrossMachineHandoffOptions? = nil
  var items: [LaneMoveItem] = []
  var restoreTargets: [LaneMoveTarget] = []
  var preview: CloudKeptLaneRestorePreview? = nil
}
#endif

// MARK: - The machine list

struct LaneMoveSheet: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var runs = LaneMoveRuns.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @State private var source: LaneMoveSource
  @State private var route: LaneMoveRoute?
  @State private var options: AgentChatCrossMachineHandoffOptions?
  @State private var items: [LaneMoveItem]?
  @State private var loadError: String?
  @State private var picked: LaneMoveTarget?
  @State private var openRunId: String?
  @State private var waking = false
  @State private var wakeError: String?
  /// After a wake, for a host that knows no chat on the lane: it opens the
  /// live lane, which reads the chats and opens the move again.
  private let afterWake: (@MainActor () async -> Void)?
  #if DEBUG
  var fixture: LaneMoveFixture?
  #endif

  init(source: LaneMoveSource, afterWake: (@MainActor () async -> Void)? = nil) {
    _source = State(initialValue: source)
    self.afterWake = afterWake
  }

  #if DEBUG
  init(source: LaneMoveSource, fixture: LaneMoveFixture) {
    self.init(source: source)
    self.fixture = fixture
  }
  #endif

  private var restores: Bool { source.restores }

  /// "Wake and move" from the review or the progress: back to this list,
  /// which wakes the computer and then lists the places for a live move.
  private var wakeAndMove: (() -> Void)? {
    guard source.kind == .cloudAsleep, source.fleetKey != nil else { return nil }
    return {
      picked = nil
      openRunId = nil
      Task { await wakeThenLoad() }
    }
  }

  /// The places, in list order: ready first, then by name. The lane's own
  /// machine is never listed: a move needs another one.
  private var targets: [LaneMoveTarget] {
    #if DEBUG
    if let fixture, restores { return fixture.restoreTargets }
    #endif
    if restores { return syncService.keptLaneRestoreTargets() }
    guard let options else { return [] }
    #if DEBUG
    let machines = fixture != nil ? options.machines : laneMoveMachines(options, sync: syncService)
    #else
    let machines = laneMoveMachines(options, sync: syncService)
    #endif
    let ownKeys = Set([route?.machineKey, route?.machineKey.flatMap { AccountService.shared.machine(forFleetKey: $0)?.machineKey }]
      .compactMap { $0?.lowercased() })
    return machines
      .filter { !ownKeys.contains($0.machineKey.lowercased()) }
      .map { machine in
        let ready = machine.online && nonEmptyTrimmed(machine.unavailableReason) == nil
        return LaneMoveTarget(
          id: machine.machineKey,
          machineKey: machine.machineKey,
          name: machine.name,
          ready: ready,
          reason: nonEmptyTrimmed(machine.unavailableReason) ?? (machine.online ? nil : "\(machine.name) is not on."),
          hasRepository: machine.hasRepository,
          route: nil
        )
      }
      .sorted { $0.ready != $1.ready ? $0.ready : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  /// Blockers that moving the changes along does not clear.
  private var blockers: [AgentChatCrossMachineHandoffBlocker] {
    (options?.blockers ?? []).filter { !$0.clearedByIncludeChanges && $0.id != "move_in_progress" }
  }

  private var waitingChat: AgentChatSessionSummary? {
    laneMoveChats(source.chats ?? []).first { $0.awaitingInput == true }
  }

  private var openRun: LaneMoveRun? { runs.openRun(laneId: source.laneId) }

  var body: some View {
    NavigationStack {
      List {
        Section {
        } header: {
          Text("Everything on \(source.laneName) moves together: its branch, its work that isn't pushed, and its chats and CLIs.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .textCase(nil)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let openRun {
          Section {
            Button {
              openRunId = openRun.id
            } label: {
              HStack(spacing: 12) {
                Image(systemName: "arrow.triangle.2.circlepath")
                  .foregroundStyle(openRun.phase == .moving ? ADEColor.accent : ADEColor.warning)
                  .frame(width: 22)
                Text(laneMoveRunLabel(openRun))
                  .foregroundStyle(ADEColor.textPrimary)
                  .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                  .font(.footnote.weight(.semibold))
                  .foregroundStyle(ADEColor.textMuted)
              }
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .adeInspectable("Lanes.Move.Run")
          }
        }
        content
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Move lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(openRun == nil ? "Cancel" : "Done") { dismiss() }
        }
      }
      .navigationDestination(item: $picked) { target in
        LaneMoveReviewView(
          source: source,
          target: target,
          route: restores ? target.route : route,
          items: items ?? [],
          changes: options?.changes,
          initialRunId: nil,
          close: { dismiss() },
          wake: wakeAndMove,
          fixturePreview: fixturePreview
        )
      }
      .navigationDestination(item: $openRunId) { runId in
        if let run = runs.run(id: runId) {
          LaneMoveReviewView(
            source: source,
            target: LaneMoveTarget(id: run.id, machineKey: "", name: run.targetName, ready: true, reason: nil, hasRepository: true, route: run.route),
            route: run.route,
            items: items ?? [],
            changes: nil,
            initialRunId: run.id,
            close: { dismiss() },
            wake: wakeAndMove,
            fixturePreview: fixturePreview
          )
        }
      }
    }
    .task { await load() }
    .interactiveDismissDisabled(waking)
    .adeInspectable("Lanes.Move")
  }

  private var fixturePreview: CloudKeptLaneRestorePreview? {
    #if DEBUG
    return fixture?.preview
    #else
    return nil
    #endif
  }

  @ViewBuilder
  private var content: some View {
    if source.kind == .cloudAsleep, !restores || waking || wakeError != nil {
      // A computer that holds other lanes too has no saved copy for one
      // lane, so it wakes first. The same section follows "Wake and move".
      asleepSection
    } else if let loadError {
      Section {
        Text(loadError)
          .font(.subheadline)
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
        Button("Try again") { Task { await load() } }
      }
    } else if !restores, options == nil {
      Section {
        HStack(spacing: 10) {
          ProgressView()
          Text("Finding your computers…").foregroundStyle(ADEColor.textSecondary)
        }
      }
    } else {
      if let waitingChat {
        Section {
          Label("Answer the question in \(nonEmptyTrimmed(waitingChat.title) ?? "its chat") first.", systemImage: "questionmark.bubble")
            .foregroundStyle(ADEColor.warning)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if !blockers.isEmpty {
        Section("Before it can move") {
          ForEach(blockers) { blocker in
            VStack(alignment: .leading, spacing: 2) {
              Text(blocker.title).font(.subheadline.weight(.semibold))
              Text(blocker.detail)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
      placesSection
      if source.deletesComputer, let instanceId = source.computer?.instanceId {
        Section {
          Button {
            dismiss()
            CloudLaneActions.shared.manageComputer(instanceId: instanceId, fromMenu: true)
          } label: {
            Label("Change size…", systemImage: "slider.horizontal.3")
          }
          .adeInspectable("Lanes.Move.ChangeSize")
        } header: {
          Text("This lane's \(ADECloudMachine.name) computer").textCase(nil)
        }
      }
    }
  }

  private var asleepSection: some View {
    Section {
      VStack(alignment: .leading, spacing: 12) {
        Label(waking
          ? "Waking your \(ADECloudMachine.name) computer. Then pick where this lane goes."
          : "Your \(ADECloudMachine.name) computer is asleep. Wake it to move this lane.", systemImage: "moon.zzz")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        Text("Waking it uses \(ADECloudMachine.name) hours.")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
        if let wakeError {
          Text(wakeError)
            .font(.footnote)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
        Button {
          Task { await wakeThenLoad() }
        } label: {
          HStack(spacing: 6) {
            if waking { ProgressView().controlSize(.small).tint(.white) }
            Text(waking ? "Waking the computer…" : "Wake and move")
          }
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
        .disabled(waking)
        .adeInspectable("Lanes.Move.Wake")
      }
      .padding(.vertical, 4)
    }
  }

  @ViewBuilder
  private var placesSection: some View {
    let blocked = !blockers.isEmpty || waitingChat != nil
    Section {
      if targets.isEmpty {
        Text(restores
          ? "Open this project on one of your computers, then bring the lane there."
          : "No other computer on this account can take it.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      ForEach(targets) { target in
        LaneMoveTargetRow(target: target, restores: restores, disabled: !target.ready || blocked) {
          picked = target
        }
      }
      // ADE Cloud is one place. A lane moves only onto a computer that is
      // already on, and ADE Cloud makes a new one per lane.
      HStack(spacing: 12) {
        Image(systemName: ADECloudMachine.symbol)
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text(ADECloudMachine.name).foregroundStyle(ADEColor.textMuted)
          Text("ADE Cloud can't take a moved lane yet. Pick one of your computers.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
        Text("Not yet")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }
      .accessibilityElement(children: .combine)
    } header: {
      Text("Move this lane to").textCase(nil)
    }
  }

  private func load() async {
    #if DEBUG
    if let fixture {
      options = fixture.options
      items = fixture.items
      return
    }
    #endif
    guard !restores, source.kind != .cloudAsleep else { return }
    loadError = nil
    guard let via = source.viaSessionId else {
      loadError = "This lane has no chat yet. Start a chat on it, then move it."
      return
    }
    do {
      let route = try syncService.laneMoveRoute(laneId: source.laneId, viaSessionId: via)
      self.route = route
      guard syncService.laneMoveActionAvailable("chat.getCrossMachineHandoffOptions", route: route),
            syncService.laneMoveActionAvailable("chat.startCrossMachineBatchMove", route: route),
            syncService.laneMoveActionAvailable("chat.getCrossMachineBatchMove", route: route)
      else {
        loadError = "The computer this lane is on needs an ADE update to move a lane from the phone."
        return
      }
      let read = try await syncService.laneMoveOptions(route: route, viaSessionId: via)
      if let sessions = source.sessions, let chats = source.chats {
        items = laneMoveItems(sessions: sessions, chats: chats)
      } else {
        // Opened from a chat: one read of the lane on its own brain.
        let detail = try await syncService.readLaneMoveDetail(route: route, laneId: source.laneId)
        items = laneMoveItems(sessions: detail.sessions, chats: detail.chatSessions)
        source.laneName = detail.lane.displayName
        source.chats = detail.chatSessions
      }
      options = read
    } catch {
      loadError = SyncUserFacingError.message(for: error)
    }
  }

  /// A doing action: the person asked to move the lane, so its computer wakes.
  private func wakeThenLoad() async {
    guard let fleetKey = source.fleetKey, !waking else { return }
    #if DEBUG
    if fixture != nil { return }
    #endif
    waking = true
    wakeError = nil
    let up: Bool
    if fleetKey == syncService.focusedMachineKey {
      up = await syncService.wakeFocusedCloudMachineIfAsleep()
    } else {
      up = await syncService.machineFleet?.connect(machineKey: fleetKey, timeout: .seconds(150)) ?? false
    }
    waking = false
    guard up else {
      wakeError = syncService.cloudWakeFailure(fleetKey: fleetKey) ?? "The computer didn't come up. Try again."
      return
    }
    if source.viaSessionId == nil, let afterWake {
      dismiss()
      await afterWake()
      return
    }
    source.kind = .cloud
    await load()
  }
}

/// What the lane's move sheet says about a run under way or ended badly.
func laneMoveRunLabel(_ run: LaneMoveRun) -> String {
  switch run.phase {
  case .deleting: return "Moved to \(run.targetName). Deleting the \(ADECloudMachine.name) computer…"
  case .deleteFailed: return "Moved to \(run.targetName). The \(ADECloudMachine.name) computer is still there."
  case .failed: return "The move to \(run.targetName) did not finish."
  case .done: return "Moved to \(run.targetName)."
  case .moving: return "Moving to \(run.targetName)…"
  }
}

private struct LaneMoveTargetRow: View {
  let target: LaneMoveTarget
  let restores: Bool
  let disabled: Bool
  let pick: () -> Void

  private var note: String? {
    if !target.ready { return target.reason ?? "Not on" }
    if !restores, target.hasRepository == false { return "Clones the project from GitHub first" }
    return nil
  }

  var body: some View {
    Button(action: pick) {
      HStack(spacing: 12) {
        Image(systemName: "desktopcomputer")
          .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.accent)
          .frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text(target.name)
            .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.textPrimary)
          if let note {
            Text(note)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 8)
        if !disabled {
          Image(systemName: "chevron.right")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .accessibilityLabel(note.map { "\(target.name), \($0)" } ?? target.name)
    .adeInspectable("Lanes.Move.Target")
  }
}

// MARK: - The review, then the progress

/// The step between a pick and the move: what goes where, each chat with how
/// much of its history arrives, that the work comes along and nothing is
/// pushed, a clone when the destination has no copy, and for an ADE Cloud
/// lane, that its computer is deleted only once everything arrived. Once the
/// move starts, the same screen follows it.
struct LaneMoveReviewView: View {
  let source: LaneMoveSource
  let target: LaneMoveTarget
  /// The lane's brain for a live move; the destination for a restore.
  let route: LaneMoveRoute?
  /// A live move: what it carries, from the lane's own lists.
  let items: [LaneMoveItem]
  let changes: AgentChatCrossMachineHandoffChanges?
  let initialRunId: String?
  /// Closes the whole sheet; the move goes on.
  let close: () -> Void
  /// Wakes the asleep ADE Cloud computer, for a live move instead.
  var wake: (() -> Void)? = nil
  var fixturePreview: CloudKeptLaneRestorePreview? = nil
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var runs = LaneMoveRuns.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var preview: CloudKeptLaneRestorePreview?
  @State private var previewError: String?
  @State private var runId: String?
  @State private var starting = false
  @State private var startError: String?
  @State private var retrying = false

  private var restores: Bool { source.restores }
  private var run: LaneMoveRun? { runs.run(id: runId ?? initialRunId) }
  private var rows: [LaneMoveItem] { restores ? (preview?.items ?? []) : items }
  private var deletesComputer: Bool { !restores && source.deletesComputer }

  /// The asleep computer's saved copy doesn't hold all of the lane's work,
  /// so the move wakes it instead.
  private var savedCopyIncomplete: Bool {
    source.fromComputer != nil && preview?.fromComputer?.saved == false
  }

  /// The files git ignores on the ADE Cloud computer the move deletes.
  private var ignoredNote: String? {
    guard !savedCopyIncomplete else { return nil }
    if source.fromComputer != nil {
      guard let preview else { return nil }
      return laneMoveIgnoredFilesNote(preview.fromComputer?.ignored, asleep: true)
    }
    guard deletesComputer, let instanceId = source.computer?.instanceId else { return nil }
    let ignored = syncService.cloudServerInstances.first { $0.id == instanceId }?.ignoredFiles
    return laneMoveIgnoredFilesNote(ignored, asleep: false)
  }

  var body: some View {
    List {
      if let run {
        progress(run)
      } else {
        review
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle("Move to \(target.name)")
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
    .interactiveDismissDisabled(starting)
    .task { await loadPreview() }
    .adeInspectable(run == nil ? "Lanes.Move.Review" : "Lanes.Move.Progress")
  }

  // MARK: Review

  @ViewBuilder
  private var review: some View {
    Section {
    } header: {
      Text("From \(source.machineName). Everything on \(source.laneName) moves together.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .textCase(nil)
        .fixedSize(horizontal: false, vertical: true)
    }
    if restores, preview == nil {
      Section {
        if let previewError {
          Text(previewError)
            .font(.subheadline)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
          Button("Try again") { Task { await loadPreview(force: true) } }
          if source.fromComputer != nil, let wake {
            Button("Wake and move") { wake() }
              .adeInspectable("Lanes.Move.WakeInstead")
          }
        } else {
          HStack(spacing: 10) {
            ProgressView()
            Text("Reading the lane…").foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
    } else {
      Section {
        if rows.isEmpty {
          Text("This lane has no chats or CLI sessions to move.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
        ForEach(rows) { item in
          LaneMoveItemRow(item: item, state: nil)
        }
      } header: {
        Text("What moves").textCase(nil)
      } footer: {
        let deletes = deletesComputer || source.fromComputer != nil
        if let note = laneMoveSummaryNote(items: rows, sourceMachineName: source.machineName, deletesComputer: deletes, restores: restores) {
          Text(note)
            .foregroundStyle(deletes ? ADEColor.warning : ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Section {
        LaneMoveFactRow(symbol: "arrow.triangle.branch", text: laneMoveBranchSentence(workPhrase: workPhrase))
        if !restores, target.hasRepository == false {
          LaneMoveFactRow(
            symbol: "square.and.arrow.down",
            text: "\(target.name) doesn't have this project yet. ADE clones it from GitHub first, into the folder beside its newest project. To use another folder, open the project there first."
          )
        }
        if restores, preview?.hasRepository == false {
          LaneMoveFactRow(
            symbol: "exclamationmark.triangle",
            text: "This project on \(target.name) isn't the lane's repository. Open a clone of it there, then move the lane there.",
            tone: ADEColor.warning
          )
        }
        if savedCopyIncomplete {
          LaneMoveFactRow(
            symbol: "exclamationmark.triangle.fill",
            text: "\(nonEmptyTrimmed(preview?.fromComputer?.reason) ?? "The computer's saved copy doesn't hold all of this lane's work.") So ADE wakes the computer and moves the lane from there. Waking it uses \(ADECloudMachine.name) hours.",
            tone: ADEColor.warning
          )
        } else if source.fromComputer != nil {
          LaneMoveFactRow(
            symbol: "trash",
            text: "The \(ADECloudMachine.name) computer stays asleep. It saved all of this lane's work when it went to sleep, so ADE deletes it first and brings the lane back from that saved copy. If anything fails after that, the lane stays in your account and you can move it again."
          )
        } else if deletesComputer {
          LaneMoveFactRow(
            symbol: "trash",
            text: "When everything has arrived and ADE has checked it, ADE deletes this lane's \(ADECloudMachine.name) computer and its saved chats. If anything fails, the computer stays."
          )
        }
        if let ignoredNote {
          LaneMoveFactRow(symbol: "eye.slash", text: ignoredNote)
        }
      }
      if let startError {
        Section {
          Text(startError)
            .font(.subheadline)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private var workPhrase: String? {
    if restores {
      guard let work = preview?.work else { return nil }
      return laneMoveWorkPhrase(commits: work.unpushedCommits ?? 0, files: work.changedFiles ?? 0)
        ?? "the work this lane saved when its computer stopped"
    }
    guard let changes else { return nil }
    return laneMoveWorkPhrase(commits: changes.unpushedCommits, files: changes.changedFiles)
  }

  private var canMove: Bool {
    guard !starting, target.ready, route != nil, !rows.isEmpty else { return false }
    if restores { return preview?.hasRepository == true && !savedCopyIncomplete }
    return true
  }

  // MARK: Progress

  @ViewBuilder
  private func progress(_ run: LaneMoveRun) -> some View {
    let parts = run.kind == .live
      ? laneMoveProgressRows(batch: run.batch, review: items)
      : laneMoveProgressRows(restore: run.restore, review: preview?.items ?? [])
    let arrived = parts.filter { $0.state == .arrived }.count
    let ended = run.phase == .failed || run.phase == .deleteFailed
    let failure = parts.first(where: { $0.state == .failed && $0.error != nil })?.error ?? run.error
    Section {
      VStack(alignment: .leading, spacing: 6) {
        Text(status(run, arrived: arrived, total: parts.count))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ended ? ADEColor.warning : ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.updatesFrequently)
        if run.wakesInstead, let reason = nonEmptyTrimmed(failure) {
          // The server's reason; nothing moved, so there are no rows to show.
          Text(reason)
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if run.phase == .moving || run.phase == .deleting {
          Text("You can close this. The move goes on, and each chat shows its own progress.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.vertical, 2)
    }
    // A refused release moved nothing and deleted nothing: no rows.
    if !run.wakesInstead, !parts.isEmpty {
      Section {
        ForEach(parts) { part in
          LaneMoveItemRow(item: part.item, state: part.state)
        }
      } footer: {
        if let failure, ended {
          Text(failure).fixedSize(horizontal: false, vertical: true)
        } else if run.phase == .moving, let error = run.error {
          // A read that failed: the move goes on there; this phone reads again.
          Text("Checking again soon. \(error)").fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func status(_ run: LaneMoveRun, arrived: Int, total: Int) -> String {
    let cloud = ADECloudMachine.name
    if run.wakesInstead {
      return "ADE didn't use the saved copy, and nothing was deleted. Wake the \(cloud) computer to move the lane from there."
    }
    switch run.phase {
    case .moving:
      if run.kind == .restore, run.restore?.step == "release" {
        return "Deleting the asleep \(cloud) computer and keeping its lane…"
      }
      return total > 0 ? "Moving: \(arrived) of \(total) \(total == 1 ? "part" : "parts") arrived." : "Starting the move…"
    case .deleting: return "Everything arrived. Deleting the \(cloud) computer…"
    case .done: return run.deletesComputer ? "Moved. The \(cloud) computer is deleted." : "Moved. Everything arrived."
    case .deleteFailed: return "Everything arrived, but the \(cloud) computer is still there."
    case .failed:
      if run.computer != nil { return "Not all of it arrived. The \(cloud) computer is kept, so nothing is lost." }
      if run.kind == .restore, run.fromComputer != nil { return "Not all of it arrived. The lane stays in your account, so nothing is lost." }
      return "Not all of it arrived."
    }
  }

  // MARK: Actions

  /// The screen's one main action, below the list where the thumb is.
  @ViewBuilder
  private var actionBar: some View {
    VStack(spacing: 8) {
      if let run {
        switch run.phase {
        case .failed where run.wakesInstead:
          if let wake {
            Button {
              runs.dismiss(id: run.id)
              wake()
            } label: {
              Text("Wake and move")
            }
            .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
            .adeInspectable("Lanes.Move.WakeInstead")
          }
          Button("Close") {
            runs.dismiss(id: run.id)
            close()
          }
          .buttonStyle(ADEKitButtonStyle(wide: true))
        case .failed:
          Button {
            Task { await retry(run) }
          } label: {
            HStack(spacing: 6) {
              if retrying { ProgressView().controlSize(.small).tint(.white) }
              Text("Try again")
            }
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
          .disabled(retrying)
          .adeInspectable("Lanes.Move.Retry")
          Button("Close") {
            runs.dismiss(id: run.id)
            close()
          }
          .buttonStyle(ADEKitButtonStyle(wide: true))
        case .deleteFailed:
          Button {
            ADEHaptics.light()
            runs.retryDelete(id: run.id)
          } label: {
            Label("Delete \(ADECloudMachine.name) computer", systemImage: "trash")
          }
          .buttonStyle(ADEKitButtonStyle(tone: .crit, wide: true))
          .adeInspectable("Lanes.Move.RetryDelete")
          Button("Close") { close() }
            .buttonStyle(ADEKitButtonStyle(wide: true))
        case .moving, .deleting, .done:
          Button(run.phase == .done ? "Done" : "Close") { close() }
            .buttonStyle(ADEKitButtonStyle(wide: true))
        }
      } else if savedCopyIncomplete, let wake {
        Button {
          wake()
        } label: {
          Text("Wake and move")
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
        .adeInspectable("Lanes.Move.WakeInstead")
      } else {
        Button {
          Task { await start() }
        } label: {
          HStack(spacing: 6) {
            if starting { ProgressView().controlSize(.small).tint(.white) }
            Text(starting ? "Starting the move…" : "Move lane")
          }
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
        .disabled(!canMove)
        .adeInspectable("Lanes.Move.Confirm")
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 8)
    .frame(maxWidth: 560)
    .frame(maxWidth: .infinity)
    .background(.bar)
  }

  private func loadPreview(force: Bool = false) async {
    guard restores, run == nil || force else { return }
    if let fixturePreview {
      preview = fixturePreview
      return
    }
    guard let route else {
      previewError = "\(target.name) can't be reached from the phone."
      return
    }
    previewError = nil
    do {
      preview = try await syncService.previewKeptLaneRestore(route: route, laneId: source.restoreLaneId, fromComputer: source.fromComputer)
    } catch {
      previewError = SyncUserFacingError.message(for: error)
    }
  }

  private func start() async {
    guard canMove, let route else { return }
    starting = true
    startError = nil
    defer { starting = false }
    #if DEBUG
    if fixturePreview != nil || LaneMoveFixtureFlag.active {
      ADEHaptics.success()
      return
    }
    #endif
    do {
      if restores {
        // The destination's brain deletes an asleep computer itself, first; nothing is deleted after.
        let record = try await syncService.restoreKeptLane(route: route, laneId: source.restoreLaneId, fromComputer: source.fromComputer)
        runId = runs.followRestore(
          record: record,
          route: route,
          laneId: source.laneId,
          targetName: target.name,
          fromComputer: source.fromComputer,
          sync: syncService
        )
      } else {
        let record = try await syncService.startLaneMoveBatch(
          route: route,
          sessionIds: rows.map(\.id),
          machineKey: target.machineKey,
          clone: target.hasRepository == false
        )
        runId = runs.followLive(
          record: record,
          route: route,
          laneId: source.laneId,
          laneName: source.laneName,
          targetName: target.name,
          computer: deletesComputer ? source.computer : nil,
          sync: syncService
        )
      }
      ADEHaptics.success()
    } catch {
      startError = SyncUserFacingError.message(for: error)
      ADEHaptics.error()
    }
  }

  private func retry(_ run: LaneMoveRun) async {
    guard !retrying else { return }
    retrying = true
    defer { retrying = false }
    do {
      runId = try await runs.retry(id: run.id)
    } catch {
      CloudLaneActions.shared.toast = ADEToastMessage(
        text: "Couldn't try the move again",
        kind: .failure,
        detail: SyncUserFacingError.message(for: error)
      )
      ADEHaptics.error()
    }
  }
}

#if DEBUG
/// Fixture screens set this: a Move there sends nothing.
@MainActor
enum LaneMoveFixtureFlag {
  static var active = false
}
#endif

// MARK: - Rows

/// One chat, CLI or the lane's branch: its logo, its name, and either how
/// much of its history arrives (the review) or where its move is (the progress).
private struct LaneMoveItemRow: View {
  let item: LaneMoveItem
  let state: LaneMoveRowState?

  var body: some View {
    // Large text: the history label goes under the name instead of beside it.
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 12) {
        logo
        name
        Spacer(minLength: 8)
        trailing
      }
      HStack(alignment: .top, spacing: 12) {
        logo
        VStack(alignment: .leading, spacing: 4) {
          name
          trailing
        }
        Spacer(minLength: 0)
      }
    }
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private var logo: some View {
    if item.kind == .lane {
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 24, height: 24)
    } else {
      WorkProviderLogo(
        provider: item.provider.isEmpty ? nil : item.provider,
        fallbackSymbol: item.kind == .cli ? "terminal.fill" : "bubble.left.fill",
        size: 24
      )
    }
  }

  private var name: some View {
    HStack(spacing: 6) {
      Text(item.title)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
      if item.kind == .cli {
        Text("CLI")
          .font(.caption2.weight(.medium))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
  }

  @ViewBuilder
  private var trailing: some View {
    if let state {
      LaneMoveStateMark(state: state)
    } else if item.kind != .lane {
      Text(item.history.label)
        .font(.caption)
        .foregroundStyle(item.history.reduced ? ADEColor.warning : ADEColor.textSecondary)
        .fixedSize()
    }
  }
}

private struct LaneMoveStateMark: View {
  let state: LaneMoveRowState

  var body: some View {
    switch state {
    case .arrived:
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(ADEColor.success)
        .accessibilityLabel("Arrived")
    case .failed:
      Image(systemName: "xmark.circle.fill")
        .foregroundStyle(ADEColor.danger)
        .accessibilityLabel("Did not arrive")
    case .moving:
      ProgressView()
        .controlSize(.small)
        .accessibilityLabel("Moving")
    case .waiting:
      Circle()
        .fill(ADEColor.textMuted.opacity(0.45))
        .frame(width: 7, height: 7)
        .frame(width: 18, height: 18)
        .accessibilityLabel("Waiting")
    }
  }
}

private struct LaneMoveFactRow: View {
  let symbol: String
  let text: String
  /// A warning's color; nil for a plain fact.
  var tone: Color? = nil

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(tone ?? ADEColor.textSecondary)
        .frame(width: 22)
        .accessibilityHidden(true)
      Text(text)
        .font(.subheadline)
        .foregroundStyle(tone ?? ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 2)
  }
}

// MARK: - A lane whose ADE Cloud computer is not awake

/// "Move to…" for a lane whose ADE Cloud computer is not awake. An asleep
/// computer made for this lane moves from its saved copy, with no wake (the
/// usual move sheet); "Wake and move" there opens the live lane detail,
/// which opens the move sheet again. A computer that holds other lanes too
/// wakes first. A deleted computer's lane comes back from the account's
/// saved copies, run by the computer it moves to.
struct CloudLaneRestingMoveSheet: View {
  let laneId: String
  let laneName: String
  let fleetKey: String
  let deleted: Bool
  /// The computer is up: the lane route changes to the live lane detail.
  let onAwake: @MainActor () async -> Void
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @State private var waking = false
  @State private var error: String?
  /// The move's source, kept once found: a move deletes the computer or
  /// forgets the kept lane, and the sheet must stay on its progress.
  @State private var heldSource: LaneMoveSource?

  private var plainLaneId: String { workParseRemoteLaneId(laneId)?.laneId ?? laneId }

  private var foundSource: LaneMoveSource? {
    if deleted {
      return cloudStore.lanesWithoutComputer.first { $0.laneId == plainLaneId }.map(LaneMoveSource.kept)
    }
    // Only a computer made for this one lane has a saved copy of it alone.
    guard let instance = syncService.cloudServerInstance(fleetKey: fleetKey), instance.laneId == plainLaneId else { return nil }
    return LaneMoveSource(
      kind: .cloudAsleep,
      laneId: plainLaneId,
      laneName: laneName,
      machineName: ADECloudMachine.name,
      viaSessionId: nil,
      fleetKey: fleetKey,
      computer: LaneMoveCloudComputer(instanceId: instance.id, accountMachineKey: instance.machineKey, laneId: plainLaneId)
    )
  }

  var body: some View {
    Group {
      if let source = heldSource ?? foundSource {
        LaneMoveSheet(source: source, afterWake: {
          LaneMoveAfterWake.request(laneId: laneId)
          await onAwake()
        })
      } else {
        restingBody
      }
    }
    .onChange(of: foundSource, initial: true) { _, found in
      if heldSource == nil, let found { heldSource = found }
    }
  }

  private var restingBody: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: deleted ? "icloud.slash" : "moon.zzz")
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 28)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 4) {
            Text(deleted ? "This lane's computer was deleted" : "This lane's computer is asleep")
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
            Text(deleted
              ? "ADE Cloud no longer keeps this lane, so there is nothing to bring back. Send a message in one of its chats to continue it on ADE Cloud."
              : "To move the lane, its computer packs it first. Waking it uses ADE Cloud hours.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        if let error {
          Text(error)
            .font(.footnote)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        if !deleted {
          Button {
            Task { await wakeThenMove() }
          } label: {
            HStack(spacing: 6) {
              if waking { ProgressView().controlSize(.small).tint(.white) }
              Text(waking ? "Waking the computer…" : "Wake and move")
            }
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
          .disabled(waking)
          .adeInspectable("Lanes.CloudMove.Wake")
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Move lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(deleted ? "Done" : "Cancel") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium])
    .interactiveDismissDisabled(waking)
  }

  private func wakeThenMove() async {
    waking = true
    error = nil
    let up = await syncService.machineFleet?.connect(machineKey: fleetKey, timeout: .seconds(150)) ?? false
    waking = false
    guard up else {
      error = syncService.cloudWakeFailure(fleetKey: fleetKey) ?? "The computer didn't come up. Try again."
      return
    }
    LaneMoveAfterWake.request(laneId: laneId)
    dismiss()
    await onAwake()
  }
}
