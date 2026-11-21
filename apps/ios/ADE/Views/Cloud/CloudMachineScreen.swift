import OSLog
import SwiftUI

private let cloudLaneDeleteLog = Logger(subsystem: "com.ade.ios", category: "cloud-lane-delete")

// MARK: - One computer

struct CloudMachineScreen: View {
  @ObservedObject var store: CloudPaneStore
  let instanceId: String
  /// False when opened from the lane's own at-rest screen: its work is the page below.
  var showsOpenWork = true
  /// The page closes when its computer moved and is gone with no new one to
  /// show. False in the book layout's right pane, which picks another computer.
  var pops = true
  /// The new computer this one moved to: the page shows it from then on.
  @State private var movedTo: String?
  @Environment(\.dismiss) private var dismiss

  private var shownId: String { movedTo ?? instanceId }

  var body: some View {
    ScrollView {
      if let machine = store.machine(shownId) {
        VStack(alignment: .leading, spacing: 16) {
          CloudMachineFacts(store: store, machine: machine)
          if let move = store.move(for: machine.instanceId) {
            CloudMoveCard(store: store, move: move)
          }
          CloudDiskParts(store: store, machine: machine)
          CloudMachineSizeCard(store: store, machine: machine)
          CloudMachineControls(store: store, machine: machine, showsOpenWork: showsOpenWork)
        }
        .padding(16)
      } else if store.phase == .loading {
        ProgressView().frame(maxWidth: .infinity).padding(32)
      } else if let move = store.move(for: shownId), move.state != "failed" {
        // The move deleted this computer and hasn't said it's done yet: its card until it does.
        CloudMoveCard(store: store, move: move)
          .padding(16)
      } else {
        ADESettingsNotice(message: "That computer is gone. It was deleted, or its lane moved to a new one.", tone: .neutral)
          .padding(16)
      }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .refreshable { await store.reload() }
    .navigationTitle(store.machine(shownId)?.displayName ?? "Computer")
    .navigationBarTitleDisplayMode(.inline)
    .onChange(of: instanceId) { _, _ in movedTo = nil }
    // Freed or deleted from this page (or elsewhere) while it was open: back to
    // the list, not a page about a computer that is gone. A move goes on to
    // its new computer below first.
    .onChange(of: store.machine(shownId) == nil) { wasGone, gone in
      guard gone, !wasGone, store.phase != .loading, store.endedMove(from: shownId) == nil else { return }
      // A move of this computer deletes it before it says it's done, and its
      // ending reads the lists before it is noted as ended: go on to the new
      // computer when the lists have it, else wait for the move's end below.
      if let move = store.move(for: shownId), move.state != "failed", move.sourceInstanceId == shownId {
        if let target = move.targetInstanceId, store.machine(target) != nil {
          if store.selectedId == shownId { store.selectedId = target }
          movedTo = target
        }
        return
      }
      if pops {
        dismiss()
      } else if store.selectedId == shownId {
        store.selectedId = store.machines.first?.instanceId
      }
    }
    // A move of this computer ended well and the lists read again: go on to
    // the new computer, or back to the list when there is none to show.
    .onChange(of: store.endedMove(from: shownId)?.moveId) { _, moveId in
      guard moveId != nil, let ended = store.endedMove(from: shownId) else { return }
      if let target = ended.targetInstanceId, store.machine(target) != nil {
        if store.selectedId == ended.sourceInstanceId { store.selectedId = target }
        movedTo = target
      } else if store.machine(ended.sourceInstanceId) == nil {
        if pops {
          dismiss()
        } else if store.selectedId == ended.sourceInstanceId {
          store.selectedId = store.machines.first?.instanceId
        }
      }
    }
  }
}

/// A move of a computer to the other kind, as the account server runs it:
/// its one sentence, "Approve the new computer" while the new one waits for
/// the person, Cancel until its copy starts, and the reason when it failed.
/// It reads the move every 5 s only while it is on screen and the move runs.
struct CloudMoveCard: View {
  @ObservedObject var store: CloudPaneStore
  let move: CloudServerMove
  @Environment(\.openURL) private var openURL

  private var failed: Bool { move.state == "failed" }

  private var title: String {
    failed ? "Couldn't move to \(move.kindWords)" : "Moving to \(move.kindWords)"
  }

  private var sentence: String {
    cloudPhoneWords(move.message) ?? (move.isFinished ? "The move ended." : "ADE Cloud is moving this computer.")
  }

  var body: some View {
    ADEKitCard(title: title, symbol: failed ? "exclamationmark.triangle" : "arrow.left.arrow.right", hint: move.sourceName) {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          if !move.isFinished { ProgressView().controlSize(.small) }
          Text(sentence)
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if failed {
          ADESettingsNotice(message: cloudPhoneWords(move.error) ?? "ADE Cloud couldn't finish the move. The computer stays as it was.", tone: .crit, dismiss: {
            store.dismissMove(move.moveId)
          })
        }
        if move.approval != nil || move.canCancel {
          CloudFlowRow {
            if let url = move.approval {
              Button { ADEHaptics.light(); openURL(url) } label: {
                Label("Approve the new computer", systemImage: "checkmark.shield")
              }
              .buttonStyle(ADEKitButtonStyle(prominent: true))
            }
            if move.canCancel {
              let cancelling = store.cancellingMoves.contains(move.moveId)
              Button { Task { await store.cancelMove(move) } } label: {
                Label(cancelling ? "Cancelling…" : "Cancel the move", systemImage: "xmark")
              }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(cancelling)
            }
          }
        }
      }
    }
    // Keyed on the move's id: a newer read of the same move keeps one follow.
    .task(id: move.isFinished ? nil : move.moveId) {
      guard !move.isFinished else { return }
      await store.followMove(move.moveId)
    }
  }
}

struct CloudMachineFacts: View {
  @ObservedObject var store: CloudPaneStore
  let machine: CloudPhoneMachine
  /// Its live facts from the account server (`GET .../status`), read once
  /// each time the page opens or its state changes; never wakes it. Nil
  /// (no rows) on a server older than the route or any failed read.
  @State private var live: CloudComputerLiveStatus?

  var body: some View {
    let tier = cloudPhoneTier(of: machine, in: store.tiers)
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        ADEKitDot(tone: cloudStateTone(machine), size: 8)
        Text(machine.stateLabel).font(.headline)
        if let mark = cloudMachineMark(machine, idle: store.account?.dueForDeletion.first { $0.instanceId == machine.instanceId }, now: store.now) {
          ADEKitTag(text: mark.text, tone: mark.tone)
        }
      }
      Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
        if let lane = machine.lane {
          fact("Lane", lane.laneName)
          if let origin = lane.projectOrigin { fact("Repository", origin) }
        }
        if let tier {
          fact("Size", "\(tier.label)\(tier.full ? ", full computer" : "") · \(tier.cpu) CPU · \(cloudGbText(tier.memoryGb)) GB")
          fact("Uses", cloudHoursRate(tier.rate))
        } else if let size = machine.size {
          fact("Size", size)
          if let rate = machine.hoursRate { fact("Uses", cloudHoursRate(rate)) }
        }
        if let resources = machine.resources { fact("Disk", cloudGb(resources.diskGb)) }
        let lastRun = cloudLastRun(machine, now: store.now)
        if !lastRun.isEmpty { fact("Last run", lastRun) }
        if machine.pastDue == true { fact("State", "Suspended") }
        if let live, machine.isAwake {
          if let since = live.awakeSince { fact("Awake for", cloudAwakeFor(since, now: store.now)) }
          if let agents = cloudLiveAgentsLine(live.activity, now: store.now) { fact("Agents", agents) }
          if let restarts = live.restarts, restarts > 0 {
            fact("Restarts", "\(restarts) since it woke")
          }
        }
      }
      .font(.subheadline)
      if let live, machine.isAwake, let memory = cloudLiveMemoryWarning(live) {
        ADESettingsNotice(message: memory, tone: .warn)
      }
      if machine.noLane {
        Text("Made before each lane had its own computer. It still counts toward your computers and disk.")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let full = cloudPhoneWords(machine.diskFull) {
        ADESettingsNotice(message: full, tone: .warn)
      }
    }
    .adeKitCard()
    .task(id: "\(machine.instanceId)#\(machine.state)") {
      guard machine.isAwake else { live = nil; return }
      guard let client = await SyncService.shared?.cloudServerClient() else { live = nil; return }
      // A 404 (an older server) or any other failure: today's facts, no rows added.
      let read = try? await client.computerStatus(instanceId: machine.instanceId)
      guard !Task.isCancelled else { return }
      live = read
    }
  }

  private func fact(_ label: String, _ value: String) -> some View {
    GridRow {
      Text(label).foregroundStyle(ADEColor.textMuted)
      Text(value).foregroundStyle(ADEColor.textPrimary).lineLimit(2).truncationMode(.middle)
    }
  }
}

/// "2 h 5 min", "12 min": how long this stretch awake has lasted.
func cloudAwakeFor(_ sinceMs: Double, now: Date) -> String {
  let minutes = max(0, Int((now.timeIntervalSince1970 - sinceMs / 1000) / 60))
  if minutes < 60 { return "\(max(1, minutes)) min" }
  let rest = minutes % 60
  return rest == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(rest) min"
}

/// "2 running", else "None · sleeps in ~N min" when it will sleep on its own.
func cloudLiveAgentsLine(_ activity: CloudComputerLiveStatus.Activity?, now: Date) -> String? {
  guard let activity else { return nil }
  if let running = activity.runningAgents, running > 0 { return "\(running) running" }
  if let sleepsAt = activity.sleepsAt {
    let minutes = max(1, Int(((sleepsAt / 1000 - now.timeIntervalSince1970) / 60).rounded(.up)))
    return "None · sleeps in ~\(minutes) min"
  }
  return activity.busy == true ? "Working" : nil
}

/// The memory warning to show, or nil when memory is fine or unknown.
func cloudLiveMemoryWarning(_ live: CloudComputerLiveStatus) -> String? {
  if live.outOfMemory == true {
    return "It ran out of memory and restarted. A bigger size gives it more."
  }
  switch live.memory {
  case "critical": return "Its memory is nearly full. A bigger size gives it more."
  case "pressure": return "Its memory is running high."
  default: return nil
  }
}

/// What uses the disk, as the computer last measured itself while awake.
/// ADE doesn't wake it to look. Parts marked safe to clear can be cleared from
/// here (the desktop's Look inside › Clear caches).
struct CloudDiskParts: View {
  @ObservedObject var store: CloudPaneStore
  let machine: CloudPhoneMachine
  @State private var confirmClear = false

  private var clearableGb: Double {
    (machine.diskUsage?.items ?? []).filter { $0.clearable == true }.reduce(0) { $0 + $1.gb }
  }

  private var canClear: Bool {
    clearableGb > 0 && store.canManage && (machine.isAwake || machine.isAsleep)
  }

  var body: some View {
    if machine.resources != nil {
      let busy = store.busy.contains(machine.instanceId) || machine.isMoving || store.isMoving(machine.instanceId)
      ADEKitCard(
        title: "What uses the disk",
        symbol: "internaldrive",
        hint: machine.diskUsage.map { "Measured \(cloudAgo($0.measuredAt, now: store.now))" }
      ) {
        if let usage = machine.diskUsage, !usage.items.isEmpty {
          VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(usage.items.enumerated()), id: \.offset) { _, part in
              VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                  Text(part.label).font(.system(size: 13.5)).foregroundStyle(ADEColor.textPrimary).lineLimit(1)
                  if part.clearable == true { ADEKitTag(text: "Safe to clear", tone: .ok) }
                  Spacer(minLength: 4)
                  Text(cloudGb(part.gb)).font(.adeMono(12)).foregroundStyle(ADEColor.textSecondary)
                }
                ADEKitMeter(fraction: usage.totalGb > 0 ? part.gb / usage.totalGb : 0)
              }
            }
            Text("\(cloudGb(usage.totalGb)) used of \(cloudGb(machine.resources?.diskGb ?? 0))\(machine.isAwake ? "" : ". Asleep: its last measure.")")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textMuted)
            if canClear {
              Button { confirmClear = true } label: {
                Label("Clear \(cloudGb(clearableGb)) of caches", systemImage: "sparkles")
              }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(busy)
            }
          }
        } else {
          Text("The computer measures its disk while it's awake and idle, at most every few hours. Its first measure shows here then.")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .confirmationDialog("Clear caches on \(machine.displayName)?", isPresented: $confirmClear, titleVisibility: .visible) {
        Button("Clear caches") { Task { await store.clearCaches(machine) } }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("\(machine.isAwake ? "ADE deletes" : "ADE wakes the computer, then deletes") package and build caches. Repositories, dependencies, images and emulators stay. It measures its disk again when it's next idle.")
      }
    }
  }
}

/// The computer's size: the sizes of its own kind, each with how fast it uses
/// hours (never a price). A change restarts it now, so running chats and
/// terminals stop; their chats are saved first. A size of the other kind
/// (standard ↔ full computer) is a move the account server runs: a new
/// computer, the files copied over, this one deleted. On a server too old for
/// moves it shows why (a move needs ADE on a computer) and stays off.
struct CloudMachineSizeCard: View {
  @ObservedObject var store: CloudPaneStore
  let machine: CloudPhoneMachine
  @State private var ask: CloudPhoneTier?

  var body: some View {
    let tiers = store.tiers
    if store.canManage, let current = cloudPhoneTier(of: machine, in: tiers) {
      let busy = store.busy.contains(machine.instanceId) || machine.isMoving || store.isMoving(machine.instanceId)
      let otherKind = store.movesUnsupported ? tiers.first { $0.type != current.type } : nil
      ADEKitCard(title: "Size", symbol: "cpu", hint: "More CPU and memory use hours faster.", flush: true) {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(tiers.enumerated()), id: \.element.id) { index, tier in
            if index > 0 { ADESettingsHairline() }
            row(tier, current: current, busy: busy)
          }
          if let otherKind {
            Text(cloudPhoneKindChangeReason(to: otherKind))
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textMuted)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.horizontal, ADEKit.inset)
              .padding(.top, 4)
              .padding(.bottom, 12)
          }
        }
      }
      .confirmationDialog(
        confirmTitle(current: current),
        isPresented: Binding(get: { ask != nil }, set: { if !$0 { ask = nil } }),
        titleVisibility: .visible,
        presenting: ask
      ) { tier in
        if tier.type == current.type {
          Button("Change to \(tier.label)") { Task { await store.changeSize(machine, to: tier) } }
        } else {
          Button("Move to \(tier.label)") { Task { await store.startMove(machine, to: tier) } }
        }
        Button("Cancel", role: .cancel) {}
      } message: { tier in
        if tier.type == current.type {
          Text("It restarts on the new size, so running chats and terminals stop. Their chats are saved first. \(tier.rateLine).")
        } else {
          Text("ADE copies its files to a new computer and deletes this one. Its lane and chats come along. It takes a few minutes and uses hours on both while it copies. \(tier.rateLine).")
        }
      }
    }
  }

  private func confirmTitle(current: CloudPhoneTier) -> String {
    guard let ask else { return "Change \(machine.displayName)?" }
    if ask.type == current.type { return "Change \(machine.displayName) to \(ask.label)?" }
    return "Move \(machine.displayName) to a \(ask.full ? "Full" : "Standard") computer?"
  }

  @ViewBuilder
  private func tierTags(_ tier: CloudPhoneTier, isCurrent: Bool) -> some View {
    if tier.full { ADEKitTag(text: "Full computer") }
    if isCurrent { ADEKitTag(text: "Current", tone: .ok) }
  }

  private func row(_ tier: CloudPhoneTier, current: CloudPhoneTier, busy: Bool) -> some View {
    let isCurrent = tier.id == current.id
    let sameKind = tier.type == current.type
    return Button { ask = tier } label: {
      HStack(spacing: 12) {
        Image(systemName: tier.symbol)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(CloudBrandColor.mark)
          .frame(width: 28, height: 28)
          .background(CloudBrandColor.violet.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        VStack(alignment: .leading, spacing: 2) {
          // The name never breaks: its tags go under it when they don't fit
          // beside it, and on a very narrow row the tags stack and the name
          // truncates instead of pushing the rate off the card.
          let name = Text(tier.label).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { name.fixedSize(); HStack(spacing: 6) { tierTags(tier, isCurrent: isCurrent) }.fixedSize() }
            VStack(alignment: .leading, spacing: 4) { name.fixedSize(); HStack(spacing: 6) { tierTags(tier, isCurrent: isCurrent) }.fixedSize() }
            VStack(alignment: .leading, spacing: 4) { name; VStack(alignment: .leading, spacing: 4) { tierTags(tier, isCurrent: isCurrent) } }
          }
          Text("\(tier.cpu) CPU · \(cloudGbText(tier.memoryGb)) GB memory")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
        Text(cloudHoursRate(tier.rate))
          .font(.system(size: 13, weight: .semibold))
          .monospacedDigit()
          .foregroundStyle(CloudBrandColor.mark)
          .fixedSize()
      }
      .padding(.horizontal, ADEKit.inset)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .buttonStyle(ADEKitRowButtonStyle(dimsWhenDisabled: !isCurrent))
    .disabled(isCurrent || (!sameKind && store.movesUnsupported) || busy)
    .accessibilityHint(
      isCurrent ? "Its size now."
        : sameKind ? "\(tier.rateLine). It restarts on the new size."
        : store.movesUnsupported ? cloudPhoneKindChangeReason(to: tier)
        : "\(tier.rateLine). ADE moves it to a new computer."
    )
  }
}

/// What the phone can do with a computer, with or without a computer of the
/// person's own: open its work (an asleep one opens what ADE Cloud keeps for
/// its lane, with no wake), sleep or wake it, keep it from the idle cleanup,
/// update it, free its computer (the lane stays), delete its lane (the
/// computer goes with it) or a computer that holds no lane, and download the
/// lane's saved work. Its size and caches are the cards above.
struct CloudMachineControls: View {
  @ObservedObject var store: CloudPaneStore
  let machine: CloudPhoneMachine
  /// False when this page was opened from the lane's own at-rest screen.
  var showsOpenWork = true
  @State private var confirmDelete = false
  @State private var confirmFree = false

  private var working: Bool { store.busy.contains(machine.instanceId) }
  private var busy: Bool { working || machine.isMoving || store.isMoving(machine.instanceId) }
  private var idle: CloudPhoneAccount.IdleCleanup? {
    store.account?.dueForDeletion.first { $0.instanceId == machine.instanceId }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ADEEyebrow("Actions")
      CloudFlowRow {
        if showsOpenWork, let key = machine.machineKey {
          if machine.isAwake {
            Button {
              ADEHaptics.light()
              store.syncService.cloudPanePresented = false
              // Opened from Settings the page is in Settings' own stack;
              // closing Settings closes it too, so the work shows.
              store.syncService.settingsPresented = false
              // Opened from a lane's "Manage computer" sheet: it closes too.
              CloudLaneActions.shared.closeAllManage()
              Task { _ = await store.syncService.ensureAccountMachineForNavigation(key) }
            } label: {
              Label("Open its work", systemImage: "arrow.up.forward.app")
            }
            .buttonStyle(ADEKitButtonStyle(prominent: true))
            .disabled(busy)
          } else if let subject = cloudLaneAtRestSubject(machine: machine, sync: store.syncService) {
            // Asleep: what the account keeps for the lane. Reading never wakes
            // the computer; its own Wake button does.
            NavigationLink {
              CloudLaneAtRestScreen(subject: subject, onAwake: {
                store.syncService.cloudPanePresented = false
                store.syncService.settingsPresented = false
                CloudLaneActions.shared.closeAllManage()
                _ = await store.syncService.ensureAccountMachineForNavigation(key)
              })
            } label: {
              Label("Open its work", systemImage: "arrow.up.forward.app")
            }
            .buttonStyle(ADEKitButtonStyle(prominent: true))
          }
        }
        if store.canManage {
          if idle != nil {
            Button { ADEHaptics.light(); Task { await store.keep(machine) } } label: { Label("Keep it", systemImage: "clock.arrow.circlepath") }
              .buttonStyle(ADEKitButtonStyle(tone: .warn))
              .disabled(busy)
          }
          if machine.isAwake {
            Button { ADEHaptics.light(); Task { await store.sleep(machine) } } label: { Label("Sleep now", systemImage: "moon") }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(busy)
          } else if machine.isAsleep {
            Button { ADEHaptics.light(); Task { await store.wake(machine) } } label: { Label("Wake", systemImage: "sun.max") }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(busy || store.outOfHours)
          }
          if store.serverInstance(machine.instanceId)?.updateBehind == true {
            Button { ADEHaptics.light(); Task { await store.update(machine) } } label: { Label("Update", systemImage: "arrow.triangle.2.circlepath") }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(busy)
          }
          if machine.lane != nil {
            Button { confirmFree = true } label: { Label("Free computer", systemImage: "shippingbox") }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(busy)
          }
          if machine.noLane {
            Button(role: .destructive) { confirmDelete = true } label: { Label("Delete computer", systemImage: "trash") }
              .buttonStyle(ADEKitButtonStyle(tone: .crit))
              .disabled(busy)
          }
        }
        // An account delete: no wake, so it works on an asleep computer too.
        if let target = CloudLaneDeleteTarget(machine: machine, onDeleted: { await store.reload() }) {
          Button(role: .destructive) { CloudLaneActions.shared.delete(target) } label: { Label("Delete lane", systemImage: "trash") }
            .buttonStyle(ADEKitButtonStyle(tone: .crit))
            .disabled(busy)
        }
      }
      if working {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("ADE Cloud is on it. This can take a few minutes.")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if let error = store.actionError {
        ADESettingsNotice(message: error, tone: .crit, dismiss: { store.actionError = nil })
      }
      if let lane = machine.lane {
        CloudSavedWorkRow(syncService: store.syncService, laneId: lane.laneId, machineKey: machine.machineKey)
      }
      // The note explains Free computer, so it shows only with that button.
      if machine.noLane || store.canManage {
        Text(machine.noLane
          ? "Deleting it removes everything on its disk for good."
          : "Free computer pushes the lane's work to GitHub, then removes the computer. The lane and its chats stay; your next message makes a new computer.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .confirmationDialog("Delete \(machine.displayName)?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete it", role: .destructive) { Task { await store.deleteComputer(machine) } }
    } message: {
      Text("Everything on its disk is gone for good: repos, lanes, and any work not pushed.")
    }
    .confirmationDialog("Free the computer of \(machine.displayName)?", isPresented: $confirmFree, titleVisibility: .visible) {
      Button("Free the computer") { Task { await store.freeComputer(machine) } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("ADE pushes its work to GitHub, then removes the computer. The lane and its chats stay. Your next message makes a new computer.")
    }
  }
}

/// What a dashboard computer's lane needs to open at rest. Nil for a computer
/// with no lane or no machine key.
@MainActor
func cloudLaneAtRestSubject(machine: CloudPhoneMachine, sync: SyncService) -> CloudLaneAtRestSubject? {
  guard let accountKey = machine.machineKey, let lane = machine.lane else { return nil }
  let fleetKey = sync.cloudMachineFleetKeys.first {
    AccountService.shared.machine(forFleetKey: $0)?.machineKey.caseInsensitiveCompare(accountKey) == .orderedSame
  } ?? sync.cloudSavedFleetKey(accountMachineKey: accountKey)
  let instance = sync.cloudServerInstances.first { $0.id == machine.instanceId }
  return CloudLaneAtRestSubject(
    fleetKey: fleetKey,
    accountMachineKey: accountKey,
    laneId: lane.laneId,
    laneName: lane.laneName,
    branchHint: instance?.laneBranch,
    repo: cloudGitHubRepo(origin: lane.projectOrigin) ?? sync.cloudProjectRepo
  )
}

/// `github.com/owner/repo` as a repository GitHub can be read from.
func cloudGitHubRepo(origin: String?) -> GitHubDirectRepoRef? {
  guard let origin else { return nil }
  let parts = origin.lowercased().split(separator: "/").map(String.init)
  guard parts.count == 3, parts[0] == "github.com" else { return nil }
  return GitHubDirectRepoRef(owner: parts[1], name: parts[2])
}

/// "Get this lane's work" on the phone: the lane's saved work at rest, as a
/// patch to share or save (`laneBackups.ts`). It needs no wake and no hours,
/// so it works at 0 hours, and from the account alone, so it still works once
/// the lane's computer was deleted. One read when it shows; nothing shows
/// with no saved work.
struct CloudSavedWorkRow: View {
  let syncService: SyncService
  let laneId: String
  /// The computer whose lane this shows (account machine key): its own
  /// backup wins over another computer's copy of the same lane.
  var machineKey: String? = nil
  /// In its own card (a lane's page); bare inside another card.
  var framed = false
  @State private var backup: CloudLaneBackupRow?

  var body: some View {
    Group {
      if let backup {
        if framed {
          ADEKitCard(title: "Saved work", symbol: "arrow.down.doc") {
            CloudSavedWorkDownload(syncService: syncService, backup: backup)
          }
        } else {
          CloudSavedWorkDownload(syncService: syncService, backup: backup)
        }
      }
    }
    .task(id: laneId) { await load() }
  }

  private func load() async {
    guard let client = await syncService.cloudServerClient() else { return }
    let rows = (try? await client.laneBackups(laneId: laneId))?.filter { $0.laneId == laneId } ?? []
    let own = machineKey.map { key in rows.filter { $0.machineKey.lowercased() == key.lowercased() } } ?? []
    backup = (own.isEmpty ? rows : own).max { $0.savedAt < $1.savedAt }
  }
}

/// One saved lane work: what it holds, and its download as a patch.
struct CloudSavedWorkDownload: View {
  let syncService: SyncService
  let backup: CloudLaneBackupRow
  @State private var file: URL?
  @State private var loading = false
  @State private var failure: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(backup.sentence)
        .font(.system(size: 12))
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize(horizontal: false, vertical: true)
      if let file {
        ShareLink(item: file) { Label("Share the patch", systemImage: "square.and.arrow.up") }
          .buttonStyle(ADEKitButtonStyle())
      } else if backup.patchParts > 0 {
        Button {
          Task { await download() }
        } label: {
          Label(loading ? "Downloading…" : "Download saved work", systemImage: "arrow.down.doc")
        }
        .buttonStyle(ADEKitButtonStyle())
        .disabled(loading)
      }
      if let failure {
        Text(failure).font(.system(size: 12)).foregroundStyle(ADEColor.textMuted)
      }
    }
    // The downloaded patch is a copy of the person's code: it leaves the phone with the row.
    .onDisappear {
      if let file { try? FileManager.default.removeItem(at: file) }
      file = nil
    }
  }

  private func download() async {
    guard let client = await syncService.cloudServerClient() else {
      failure = "Sign in to ADE to download this lane's work."
      return
    }
    loading = true
    defer { loading = false }
    do {
      file = try await client.laneBackupPatchFile(backup)
      failure = nil
    } catch {
      failure = "ADE couldn't download this lane's work. Try again in a moment."
    }
  }
}

/// The dashboard's "Saved lane work": what ADE Cloud keeps for lanes whose
/// computer is gone (`GET /cloud/backups`), each with its download and its
/// delete. One read when the page shows, its computers change or it is
/// pulled to refresh.
struct CloudSavedLaneWorkCard: View {
  @ObservedObject var store: CloudPaneStore
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @State private var backups: [CloudLaneBackupRow] = []
  /// The last read failed: a notice with a retry, not an empty page.
  @State private var loadFailed = false
  @State private var forgetAsk: CloudLaneBackupRow?
  @State private var forgetting: String?

  /// Backups whose machine key no computer of the account holds now.
  private var withoutComputer: [CloudLaneBackupRow] {
    let live = Set(
      (store.machines.compactMap(\.machineKey) + store.syncService.cloudServerInstances.compactMap(\.machineKey))
        .map { $0.lowercased() }
    )
    return backups.filter { !live.contains($0.machineKey.lowercased()) }.sorted { $0.savedAt > $1.savedAt }
  }

  private func name(_ backup: CloudLaneBackupRow) -> String {
    nonEmptyTrimmed(backup.laneName)
      ?? cloudStore.lanesWithoutComputer.first { $0.laneId == backup.laneId }?.laneName
      ?? nonEmptyTrimmed(backup.branchRef)
      ?? "Cloud lane"
  }

  var body: some View {
    let rows = withoutComputer
    Group {
      if loadFailed, rows.isEmpty {
        ADESettingsNotice(message: "Couldn't read your saved lane work.", actionTitle: "Try again") {
          Task { await load() }
        }
      } else if !rows.isEmpty {
        ADEKitCard(title: "Saved lane work", symbol: "arrow.down.doc", count: "\(rows.count)", hint: "Lanes whose computer is gone") {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(rows) { backup in
              VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                  Text(name(backup))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                    .lineLimit(1)
                  Spacer(minLength: 4)
                  Button(role: .destructive) { forgetAsk = backup } label: {
                    if forgetting == backup.id { ProgressView().controlSize(.small) } else { Image(systemName: "trash") }
                  }
                  .buttonStyle(.plain)
                  .foregroundStyle(ADEColor.danger)
                  .disabled(forgetting != nil)
                  .accessibilityLabel("Delete the saved work of \(name(backup))")
                }
                CloudSavedWorkDownload(syncService: store.syncService, backup: backup)
              }
              if backup.id != rows.last?.id { Divider().opacity(0.5) }
            }
          }
        }
      }
    }
    .task(id: ReadKey(machineIds: store.machines.map(\.instanceId), refreshes: store.refreshes)) { await load() }
    .confirmationDialog(
      "Delete the saved work of \(forgetAsk.map(name) ?? "this lane")?",
      isPresented: Binding(get: { forgetAsk != nil }, set: { if !$0 { forgetAsk = nil } }),
      titleVisibility: .visible,
      presenting: forgetAsk
    ) { backup in
      Button("Delete saved work", role: .destructive) { Task { await forget(backup) } }
      Button("Cancel", role: .cancel) {}
    } message: { _ in
      Text("ADE Cloud's copy of this work is gone for good. Download it first if you need it.")
    }
  }

  private struct ReadKey: Equatable {
    let machineIds: [String]
    let refreshes: Int
  }

  private func load() async {
    guard let client = await store.syncService.cloudServerClient() else { return }
    do {
      backups = try await client.allLaneBackups()
      loadFailed = false
    } catch {
      // A cancelled read was replaced by a newer one.
      if !Task.isCancelled { loadFailed = true }
    }
  }

  private func forget(_ backup: CloudLaneBackupRow) async {
    let laneName = name(backup)
    guard let client = await store.syncService.cloudServerClient() else {
      CloudLaneActions.shared.toast = ADEToastMessage(text: "Couldn't delete the saved work", kind: .failure, detail: "Sign in to ADE, then try again.")
      return
    }
    forgetting = backup.id
    defer { forgetting = nil }
    do {
      try await client.forgetLaneBackup(backup)
      backups.removeAll { $0.id == backup.id }
      ADEHaptics.success()
      CloudLaneActions.shared.toast = ADEToastMessage(text: "Deleted the saved work of \(laneName)")
    } catch CloudServerClient.Failure.server(let status, _) where status == 409 {
      ADEHaptics.error()
      CloudLaneActions.shared.toast = ADEToastMessage(
        text: "Kept the saved work of \(laneName)",
        kind: .failure,
        detail: "Its computer still has this work. Delete the lane to remove it."
      )
    } catch {
      ADEHaptics.error()
      CloudLaneActions.shared.toast = ADEToastMessage(text: "Couldn't delete the saved work", kind: .failure, detail: cloudServerFailureMessage(error))
    }
  }
}

// MARK: - Deleting a cloud lane

/// One cloud lane's account delete: its computer goes, and the lane, its
/// saved work and its chats with it. No wake.
struct CloudLaneDeleteTarget: Identifiable {
  let instanceId: String
  /// The account machine key its saved chats are under.
  let accountMachineKey: String?
  /// The lane's own id on its computer.
  let laneId: String
  let laneName: String
  /// Whether its computer last read work that isn't on GitHub; nil before its first read.
  let unpushed: Bool?
  /// Runs after a delete that worked (a list read, a screen closing).
  var onDeleted: (@MainActor () async -> Void)?

  var id: String { instanceId }
}

extension CloudLaneDeleteTarget {
  /// The delete of a dashboard computer's lane. Nil for a computer with no lane.
  init?(machine: CloudPhoneMachine, onDeleted: (@MainActor () async -> Void)? = nil) {
    guard let lane = machine.lane else { return nil }
    self.init(
      instanceId: machine.instanceId,
      accountMachineKey: machine.machineKey,
      laneId: lane.laneId,
      laneName: lane.laneName,
      unpushed: machine.laneWork?.unpushed,
      onDeleted: onDeleted
    )
  }
}

/// The "Manage computer" page of a cloud lane, opened from a lane menu.
struct CloudComputerManageTarget: Identifiable, Equatable {
  let instanceId: String
  var showsOpenWork = true
  var id: String { instanceId }
}

/// Where a cloud lane's delete and its computer's page open from, and where
/// their result shows as a toast. Any screen asks; the frontmost host (the
/// app's root, or a sheet that hosts with `cloudLaneActionsHost()`) presents.
/// Nothing polls: each ask sets one value and the sheet clears it.
@MainActor
final class CloudLaneActions: ObservableObject {
  static let shared = CloudLaneActions()

  @Published private(set) var deleteTarget: CloudLaneDeleteTarget?
  /// Each host's "Manage computer" sheet. One per host, so a computer page
  /// asked from inside another one opens over it and the first stays open.
  @Published private(set) var manageTargets: [UUID: CloudComputerManageTarget] = [:]
  /// The result of a delete; the frontmost host shows it.
  @Published var toast: ADEToastMessage?
  /// Hosts on screen, the frontmost last.
  @Published private(set) var hosts: [UUID] = []
  private var deletePresenter: UUID?

  /// Asks before deleting a cloud lane. `fromMenu`: a context menu is still
  /// closing, and a sheet presented into that is dropped.
  func delete(_ target: CloudLaneDeleteTarget, fromMenu: Bool = false) {
    present(fromMenu) { [self] in
      deletePresenter = hosts.last
      deleteTarget = target
    }
  }

  func manageComputer(instanceId: String, showsOpenWork: Bool = true, fromMenu: Bool = false) {
    present(fromMenu) { [self] in
      guard let host = hosts.last else { return }
      manageTargets[host] = CloudComputerManageTarget(instanceId: instanceId, showsOpenWork: showsOpenWork)
    }
  }

  private func present(_ fromMenu: Bool, _ show: @escaping @MainActor () -> Void) {
    guard fromMenu else { return show() }
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(450))
      show()
    }
  }

  func deleteTarget(for host: UUID) -> CloudLaneDeleteTarget? { deletePresenter == host ? deleteTarget : nil }
  func manageTarget(for host: UUID) -> CloudComputerManageTarget? { manageTargets[host] }

  func closeDelete() {
    deleteTarget = nil
    deletePresenter = nil
  }

  func closeManage(host: UUID) {
    manageTargets[host] = nil
  }

  /// Every computer page closes: the person opened a lane's work, which
  /// shows under them.
  func closeAllManage() {
    manageTargets.removeAll()
  }

  /// A deleted lane's computer pages have nothing left to show: they close too.
  func deleted(instanceId: String) {
    closeDelete()
    manageTargets = manageTargets.filter { $0.value.instanceId != instanceId }
  }

  func attach(_ host: UUID) {
    hosts.removeAll { $0 == host }
    hosts.append(host)
  }

  func detach(_ host: UUID) {
    hosts.removeAll { $0 == host }
    // A host gone from screen leaves no sheet waiting to reopen.
    manageTargets[host] = nil
  }
}

private struct CloudLaneActionsHost: ViewModifier {
  @ObservedObject private var actions = CloudLaneActions.shared
  @State private var id = UUID()

  func body(content: Content) -> some View {
    content
      .sheet(item: Binding(
        get: { actions.manageTarget(for: id) },
        set: { if $0 == nil { actions.closeManage(host: id) } }
      )) { target in
        CloudLaneManageSheet(syncService: SyncMenuSafePublisher.shared.service, instanceId: target.instanceId, showsOpenWork: target.showsOpenWork)
      }
      .sheet(item: Binding(
        get: { actions.deleteTarget(for: id) },
        set: { if $0 == nil { actions.closeDelete() } }
      )) { target in
        CloudLaneDeleteSheet(target: target)
      }
      .adeToast(Binding(
        get: { actions.hosts.last == id ? actions.toast : nil },
        set: { if $0 == nil { actions.toast = nil } }
      ))
      .onAppear { actions.attach(id) }
      .onDisappear { actions.detach(id) }
  }
}

extension View {
  /// Presents a cloud lane's delete and its computer's page when this is the
  /// frontmost host, and shows their results as toasts. The app's root hosts;
  /// so does each sheet a cloud lane's delete can be asked from.
  func cloudLaneActionsHost() -> some View {
    modifier(CloudLaneActionsHost())
  }
}

/// The steps of a cloud lane's account delete once the person (or a checked
/// lane move) decided it: the computer goes, then its row on the account,
/// then the lane's saved chats. No wake and no work check. The delete sheet
/// and the move after a lane moved off ADE Cloud both run it; the move
/// deletes only the saved copies of the chats that moved (`onlyChats`).
enum CloudLaneComputerDelete {
  struct Outcome {
    /// Why the computer is still there; nil when it is gone.
    let failure: String?
    /// The computer is gone but some of its saved chats are not.
    let chatsLeft: Bool
  }

  @MainActor
  static func run(
    client: CloudServerClient,
    instanceId: String,
    accountMachineKey: String?,
    laneId: String,
    onlyChats: Set<String>? = nil,
    sync: SyncService
  ) async -> Outcome {
    do {
      // Waits until ADE Cloud confirms the computer is gone.
      guard try await client.deleteInstanceConfirmed(instanceId) else {
        return Outcome(failure: "ADE Cloud took the delete but the computer is still there. Check again in a minute; if it stays, delete it again.", chatsLeft: true)
      }
    } catch {
      return Outcome(failure: cloudServerFailureMessage(error), chatsLeft: true)
    }
    // Off the account's machines too, as the desktop's delete does: else the
    // lane stays in Lanes and Work from the machine list.
    let account = AccountService.shared
    if let key = accountMachineKey,
       let row = account.machines.first(where: { $0.machineKey.caseInsensitiveCompare(key) == .orderedSame }) {
      do {
        try await account.removeMachineFromAccount(row)
      } catch {
        cloudLaneDeleteLog.notice("cloud_lane delete account_row=left error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      }
    }
    // The server may have taken the row off already: read the list again so
    // this phone's copy drops it either way.
    await account.loadMachines()
    // The chats go after the computer, so a last saved part can't bring one back.
    var chatsLeft = false
    if let machineKey = accountMachineKey {
      if let onlyChats {
        // A move: the chats it left (Done, archived, another surface) stay
        // readable from ADE Cloud. Its chats are all under this key.
        for chatId in onlyChats.sorted() {
          do {
            try await client.deleteSavedChat(machineKey: machineKey, chatId: chatId)
          } catch {
            chatsLeft = true
          }
        }
      } else {
        do {
          try await client.deleteSavedChats(machineKey: machineKey, laneId: laneId)
        } catch {
          chatsLeft = true
        }
      }
    }
    // The lists drop the lane and its chats now; an older read can't bring them back.
    sync.noteCloudLaneDeleted(laneId)
    return Outcome(failure: nil, chatsLeft: chatsLeft)
  }
}

/// "Delete <lane>?": the account delete of a cloud lane, the desktop's
/// `deleteCloudLane.tsx` on the phone. It deletes the lane's computer through
/// the account server (no wake, so it works on an asleep computer too), then
/// the lane's saved chats. When the lane's work may not all be on GitHub it
/// warns, with the saved work's download in the sheet.
struct CloudLaneDeleteSheet: View {
  let target: CloudLaneDeleteTarget
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var deleting = false
  /// Why the last delete didn't go through; it stays in the sheet, not only in a toast.
  @State private var failure: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if let failure {
            ADESettingsNotice(message: failure, tone: .crit, dismiss: { self.failure = nil })
          }
          Text("ADE deletes the lane, its computer and its chats.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          if target.unpushed != false {
            ADESettingsNotice(
              message: target.unpushed == true
                ? "This lane has work that isn't on GitHub. Deleting the lane deletes ADE Cloud's saved copy too."
                : "ADE can't tell whether all of this lane's work is on GitHub. Deleting the lane deletes ADE Cloud's saved copy too.",
              tone: .warn
            )
            CloudSavedWorkRow(syncService: syncService, laneId: target.laneId, machineKey: target.accountMachineKey)
          }
          Button(role: .destructive) {
            Task { await delete() }
          } label: {
            if deleting {
              HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Deleting…")
              }
            } else {
              Label("Delete lane", systemImage: "trash")
            }
          }
          .buttonStyle(ADEKitButtonStyle(tone: .crit, wide: true))
          .disabled(deleting)
          .adeInspectable("CloudLane.Delete.Confirm")
        }
        .padding(16)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Delete \(target.laneName)?")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { CloudLaneActions.shared.closeDelete() }
            .disabled(deleting)
        }
      }
    }
    .presentationDetents([.medium, .large])
    .interactiveDismissDisabled(deleting)
    // A failure shows here, over the sheet that stays open.
    .cloudLaneActionsHost()
  }

  private func delete() async {
    guard !deleting else { return }
    // Set before the client read, which can wait on a token refresh: a
    // second tap or a Cancel meanwhile does nothing.
    deleting = true
    defer { deleting = false }
    let actions = CloudLaneActions.shared
    guard let client = await syncService.cloudServerClient() else {
      ADEHaptics.error()
      actions.toast = ADEToastMessage(text: "Couldn't delete \(target.laneName)", kind: .failure, detail: "Sign in to ADE, then try again.")
      return
    }
    func fail(_ why: String) {
      ADEHaptics.error()
      failure = why
      actions.toast = ADEToastMessage(text: "Couldn't delete \(target.laneName)", kind: .failure, detail: why)
    }
    failure = nil
    // The server answers "not found" both for a computer already gone and for
    // one on another account; only the first is a delete that worked.
    do {
      _ = try await client.instance(target.instanceId)
    } catch CloudServerClient.Failure.noAccess {
      if (try? await client.instances())?.contains(where: { $0.id == target.instanceId && !$0.isGone }) != true {
        fail("This computer isn't on the ADE account this phone is signed in to, so ADE can't delete it from here. Sign in with the account that owns it, then try again.")
        return
      }
    } catch {
      // A read that didn't answer: the delete below says whether it worked.
    }
    let outcome = await CloudLaneComputerDelete.run(
      client: client,
      instanceId: target.instanceId,
      accountMachineKey: target.accountMachineKey,
      laneId: target.laneId,
      sync: syncService
    )
    if let why = outcome.failure {
      fail(why)
      return
    }
    let chatsLeft = outcome.chatsLeft
    ADEHaptics.success()
    actions.deleted(instanceId: target.instanceId)
    actions.toast = ADEToastMessage(
      text: "Deleted \(target.laneName)",
      kind: chatsLeft ? .info : .success,
      detail: chatsLeft
        ? "The lane and its computer are gone. ADE couldn't delete all its chats; remove the rest in Work."
        : "The lane, its computer and its chats are gone."
    )
    await syncService.refreshCloudServerInstances()
    await target.onDeleted?()
  }
}

struct CloudMachineChips: View {
  @ObservedObject var store: CloudPaneStore

  var body: some View {
    CloudFlowRow {
      ForEach(store.machines) { machine in
        Button {
          ADEHaptics.light()
          store.selectedId = machine.instanceId
        } label: {
          HStack(spacing: 6) {
            ADEKitDot(tone: cloudStateTone(machine))
            Text(machine.displayName).lineLimit(1)
          }
          .font(.subheadline)
          .padding(.horizontal, 12)
          .frame(minHeight: 44)
          .background(Capsule().fill(store.selected?.instanceId == machine.instanceId ? ADEColor.accent.opacity(0.16) : ADEKit.surface))
          .overlay(Capsule().stroke(ADEKit.edge))
        }
        .buttonStyle(.plain)
      }
    }
  }
}

struct CloudPickPrompt: View {
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "cloud").font(.system(size: 30)).foregroundStyle(ADEColor.textMuted)
      Text("Pick a lane or computer").font(.headline)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ADEColor.pageBackground.ignoresSafeArea())
  }
}

/// Wraps its children onto as many rows as they need.
struct CloudFlowRow: Layout {
  var spacing: CGFloat = 8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > width {
        y += rowHeight + spacing
        x = 0
        rowHeight = 0
      }
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
      widest = max(widest, x - spacing)
    }
    return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > bounds.minX && x + size.width > bounds.maxX {
        y += rowHeight + spacing
        x = bounds.minX
        rowHeight = 0
      }
      view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
  }
}
