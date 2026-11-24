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
// pure rules are in `LaneMoveModel.swift`, where a lane moves from in
// `LaneMoveSource.swift`, and the calls in `LaneMoveBackend.swift`.

// MARK: - The machine list

struct LaneMoveSheet: View {
  // The places the backend lists follow the sync state.
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  /// The cloud account, for its unit (hours or credits).
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @ObservedObject private var runs = LaneMoveRuns.shared
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
  private let onAwake: (@MainActor () async -> Void)?
  private let backend: any LaneMoveBackend

  init(
    source: LaneMoveSource,
    backend: any LaneMoveBackend = SyncLaneMoveBackend(),
    onAwake: (@MainActor () async -> Void)? = nil
  ) {
    _source = State(initialValue: source)
    self.backend = backend
    self.onAwake = onAwake
  }

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
    if restores { return backend.restoreTargets() }
    guard let options else { return [] }
    let machines = backend.liveMachines(options)
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

  private var openRun: LaneMoveRun? { runs.openRun(source: source) }

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
          backend: backend
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
            backend: backend
          )
        }
      }
    }
    .task { await load() }
    .interactiveDismissDisabled(waking)
    .adeInspectable("Lanes.Move")
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
        Text(CloudBalanceWords(cloudStore.account).wakingUses)
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
    // A lane with a move under way (or one to close first) takes no second
    // destination: each would bring the lane back on its own.
    let blocked = !blockers.isEmpty || waitingChat != nil || openRun?.blocksNewMove == true
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
    guard !restores, source.kind != .cloudAsleep else { return }
    loadError = nil
    do {
      let read = try await backend.readLive(source: source)
      route = read.route
      items = read.items
      if let laneName = read.laneName { source.laneName = laneName }
      if let chats = read.chats { source.chats = chats }
      options = read.options
    } catch {
      loadError = (error as? LaneMoveReadFailure)?.message ?? SyncUserFacingError.message(for: error)
    }
  }

  /// A doing action: the person asked to move the lane, so its computer wakes.
  private func wakeThenLoad() async {
    guard let fleetKey = source.fleetKey, !waking else { return }
    waking = true
    wakeError = nil
    let failure = await backend.wake(fleetKey: fleetKey)
    waking = false
    if let failure {
      wakeError = failure
      return
    }
    if source.viaSessionId == nil, let onAwake {
      dismiss()
      await onAwake()
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
  case .moveAgain: return "Moved to \(run.targetName). Some work stayed on \(ADECloudMachine.name); move the lane again."
  case .pushFirst: return "Moved to \(run.targetName). Files stayed on \(ADECloudMachine.name); push them to GitHub."
  case .failed: return "The move to \(run.targetName) did not finish."
  case .done: return "Moved to \(run.targetName)."
  case .moving: return "Moving to \(run.targetName)…"
  }
}

// MARK: - A lane whose ADE Cloud computer is not awake

/// "Move to…" on the lane at rest: the usual move sheet, from the source the
/// lane's computer allows. An asleep computer made for this lane moves from
/// its saved copy; one that holds other lanes too wakes first, in the sheet.
/// A deleted computer's lane comes back from the account's saved copies.
/// Only a deleted computer whose lane ADE no longer keeps has nothing to move.
struct CloudLaneRestingMoveSheet: View {
  let laneId: String
  let laneName: String
  let fleetKey: String
  /// The computer woke for the move: the host opens the live lane, which
  /// opens the move again.
  let onAwake: @MainActor () async -> Void
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @Environment(\.dismiss) private var dismiss
  /// The move's source, kept once found: a move deletes the computer or
  /// forgets the kept lane, and the sheet must stay on its progress.
  @State private var heldSource: LaneMoveSource?

  private var foundSource: LaneMoveSource? {
    laneMoveSourceAtRest(laneId: laneId, laneName: laneName, fleetKey: fleetKey, sync: syncPublishes.service)
  }

  var body: some View {
    Group {
      if let source = heldSource ?? foundSource {
        LaneMoveSheet(source: source, onAwake: onAwake)
      } else {
        nothingToMove
      }
    }
    .onChange(of: foundSource, initial: true) { _, found in
      if heldSource == nil, let found { heldSource = found }
    }
  }

  private var nothingToMove: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: "icloud.slash")
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 28)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 4) {
            Text("This lane's computer was deleted")
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
            Text("ADE Cloud no longer keeps this lane, so there is nothing to bring back. Send a message in one of its chats to continue it on ADE Cloud.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(20)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Move lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium])
  }
}
