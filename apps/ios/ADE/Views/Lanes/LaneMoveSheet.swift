import SwiftUI

// "Move to…" in the lane detail's ⋯ menu: the lane, its commits, its
// uncommitted work and its open chats move to another of the person's
// computers (`chat.startCrossMachineBatchMove` on the lane's own brain).
// The places are the person's own computers that are online, and ADE Cloud
// as one place, never one row per ADE Cloud computer. A lane whose ADE Cloud
// computer sleeps wakes first (a doing action); a lane whose computer was
// deleted has nothing to move from.

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

/// The chats a lane move takes: the lane's open Work chats that start a
/// tree. The brain adds each one's subagents. A chat that already continues
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

struct LaneMoveSheet: View {
  let laneName: String
  /// The lane's chats as the lane detail lists them.
  let chats: [AgentChatSessionSummary]
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @State private var options: AgentChatCrossMachineHandoffOptions?
  @State private var loadError: String?
  @State private var selected: String?
  @State private var moving = false
  @State private var moveError: String?
  @State private var moved: String?
  #if DEBUG
  /// Fixture screens show these options and send nothing.
  var fixtureOptions: AgentChatCrossMachineHandoffOptions?
  #endif

  private var moveChats: [AgentChatSessionSummary] { laneMoveChats(chats) }

  private var machines: [AgentChatCrossMachineHandoffMachineOption] {
    guard let options else { return [] }
    #if DEBUG
    if fixtureOptions != nil { return options.machines }
    #endif
    return laneMoveMachines(options, sync: syncService)
  }

  /// Blockers that moving the changes along does not clear.
  private var blockers: [AgentChatCrossMachineHandoffBlocker] {
    (options?.blockers ?? []).filter { !$0.clearedByIncludeChanges && $0.id != "move_in_progress" }
  }

  private var waitingChat: AgentChatSessionSummary? {
    moveChats.first { $0.awaitingInput == true }
  }

  private func takes(_ machine: AgentChatCrossMachineHandoffMachineOption) -> Bool {
    machine.online && machine.unavailableReason == nil && machine.hasRepository != false
  }

  var body: some View {
    NavigationStack {
      List {
        Section {
        } header: {
          Text(intro)
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .textCase(nil)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let moved {
          Section {
            Label(moved, systemImage: "checkmark.circle.fill")
              .foregroundStyle(ADEColor.success)
              .fixedSize(horizontal: false, vertical: true)
          }
        } else if moveChats.isEmpty {
          Section {
            Text("This lane has no open chats. A lane moves with its chats: start a chat here, then move the lane.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        } else if let loadError {
          Section {
            Text(loadError)
              .font(.subheadline)
              .foregroundStyle(ADEColor.danger)
            Button("Try again") { Task { await load() } }
          }
        } else if options == nil {
          Section {
            HStack(spacing: 10) {
              ProgressView()
              Text("Checking your computers…").foregroundStyle(ADEColor.textSecondary)
            }
          }
        } else {
          placesSection
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
                  Text(blocker.detail).font(.caption).foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }
          if let changes = options?.changes, changes.unpushedCommits + changes.changedFiles > 0 {
            Section {
              Label(changesLine(changes), systemImage: "shippingbox")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          if let moveError {
            Section {
              Text(moveError)
                .font(.subheadline)
                .foregroundStyle(ADEColor.danger)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Move lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(moved == nil ? "Cancel" : "Done") { dismiss() }
        }
        if moved == nil, !moveChats.isEmpty {
          ToolbarItem(placement: .confirmationAction) {
            Button {
              Task { await move() }
            } label: {
              if moving { ProgressView() } else { Text("Move") }
            }
            .disabled(!canMove)
            .adeInspectable("Lanes.Move.Confirm")
          }
        }
      }
    }
    .task { await load() }
    .interactiveDismissDisabled(moving)
    .adeInspectable("Lanes.Move")
  }

  private var intro: String {
    let count = moveChats.count
    guard count > 0 else { return "\(laneName) moves with its chats to the computer you pick." }
    let chatsPart = count == 1 ? "its chat" : "its \(count) chats"
    return "\(laneName), its commits, its uncommitted work and \(chatsPart) move to the computer you pick. The chats continue there."
  }

  @ViewBuilder
  private var placesSection: some View {
    Section("Move to") {
      ForEach(machines) { machine in
        let available = takes(machine)
        Button {
          selected = machine.machineKey
        } label: {
          HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
              .foregroundStyle(available ? ADEColor.accent : ADEColor.textMuted)
              .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
              Text(machine.name)
                .foregroundStyle(available ? ADEColor.textPrimary : ADEColor.textMuted)
              if let reason = unavailableReason(machine) {
                Text(reason).font(.caption).foregroundStyle(ADEColor.textSecondary)
              }
            }
            Spacer(minLength: 8)
            if selected == machine.machineKey {
              Image(systemName: "checkmark").foregroundStyle(ADEColor.accent)
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!available || moving)
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
      }
      .accessibilityElement(children: .combine)
    }
  }

  private func unavailableReason(_ machine: AgentChatCrossMachineHandoffMachineOption) -> String? {
    if !machine.online { return "Offline" }
    if let reason = nonEmptyTrimmed(machine.unavailableReason) { return reason }
    if machine.hasRepository == false { return "Open this project on \(machine.name) first." }
    return nil
  }

  private func changesLine(_ changes: AgentChatCrossMachineHandoffChanges) -> String {
    var parts: [String] = []
    if changes.unpushedCommits > 0 { parts.append("\(changes.unpushedCommits) \(changes.unpushedCommits == 1 ? "commit" : "commits") not pushed") }
    if changes.changedFiles > 0 { parts.append("\(changes.changedFiles) changed \(changes.changedFiles == 1 ? "file" : "files")") }
    return "\(parts.joined(separator: " and ")) go along."
  }

  private var canMove: Bool {
    guard !moving, let selected, let machine = machines.first(where: { $0.machineKey == selected }) else { return false }
    return takes(machine) && blockers.isEmpty && waitingChat == nil
  }

  private func load() async {
    #if DEBUG
    if let fixtureOptions {
      options = fixtureOptions
      selected = fixtureOptions.machines.first(where: takes)?.machineKey
      return
    }
    #endif
    guard let via = moveChats.first?.sessionId else { return }
    loadError = nil
    guard syncService.laneMoveAvailable(viaSessionId: via) else {
      loadError = "The computer this lane is on needs an ADE update to move a lane from the phone."
      return
    }
    do {
      let next = try await syncService.crossMachineHandoffOptions(sourceSessionId: via)
      options = next
      if selected == nil || !laneMoveMachines(next, sync: syncService).contains(where: { $0.machineKey == selected && takes($0) }) {
        selected = laneMoveMachines(next, sync: syncService).first(where: takes)?.machineKey
      }
    } catch {
      loadError = SyncUserFacingError.message(for: error)
    }
  }

  private func move() async {
    guard canMove, let selected, let via = moveChats.first?.sessionId else { return }
    let name = machines.first { $0.machineKey == selected }?.name ?? "the other computer"
    moving = true
    moveError = nil
    defer { moving = false }
    #if DEBUG
    if fixtureOptions != nil {
      moved = "\(laneName) is moving to \(name). Its chats continue there."
      return
    }
    #endif
    do {
      try await syncService.startLaneMove(viaSessionId: via, sessionIds: moveChats.map(\.sessionId), machineKey: selected)
      ADEHaptics.success()
      moved = "\(laneName) is moving to \(name). Its chats continue there."
    } catch {
      moveError = SyncUserFacingError.message(for: error)
      ADEHaptics.error()
    }
  }
}

/// "Move to…" for a lane whose ADE Cloud computer is not awake. An asleep
/// computer wakes first, then the live lane detail opens the move sheet. A
/// deleted computer has no lane to move.
struct CloudLaneRestingMoveSheet: View {
  let laneId: String
  let fleetKey: String
  let deleted: Bool
  /// The computer is up: the lane route changes to the live lane detail.
  let onAwake: @MainActor () async -> Void
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @State private var waking = false
  @State private var error: String?

  var body: some View {
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
              ? "This lane's computer was deleted. Send a message in one of its chats to continue it on ADE Cloud."
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
