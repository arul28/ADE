import SwiftUI

// MARK: - One computer

struct CloudMachineScreen: View {
  @ObservedObject var store: CloudPaneStore
  let instanceId: String
  /// False when opened from the lane's own at-rest screen: its work is the page below.
  var showsOpenWork = true

  var body: some View {
    ScrollView {
      if let machine = store.machine(instanceId) {
        VStack(alignment: .leading, spacing: 16) {
          CloudMachineFacts(store: store, machine: machine)
          CloudDiskParts(machine: machine, now: store.now)
          CloudMachineControls(store: store, machine: machine, showsOpenWork: showsOpenWork)
        }
        .padding(16)
      } else if store.phase == .loading {
        ProgressView().frame(maxWidth: .infinity).padding(32)
      } else {
        ADESettingsNotice(message: "That computer is gone. It was deleted, or its lane moved to a new one.", tone: .neutral)
          .padding(16)
      }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .refreshable { await store.reload() }
    .navigationTitle(store.machine(instanceId)?.displayName ?? "Computer")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct CloudMachineFacts: View {
  @ObservedObject var store: CloudPaneStore
  let machine: CloudPhoneMachine

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
      }
      .font(.subheadline)
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
  }

  private func fact(_ label: String, _ value: String) -> some View {
    GridRow {
      Text(label).foregroundStyle(ADEColor.textMuted)
      Text(value).foregroundStyle(ADEColor.textPrimary).lineLimit(2).truncationMode(.middle)
    }
  }
}

/// What uses the disk, as the computer last measured itself while awake.
/// ADE doesn't wake it to look.
struct CloudDiskParts: View {
  let machine: CloudPhoneMachine
  let now: Date

  var body: some View {
    if machine.resources != nil {
      ADEKitCard(
        title: "What uses the disk",
        symbol: "internaldrive",
        hint: machine.diskUsage.map { "Measured \(cloudAgo($0.measuredAt, now: now))" }
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
          }
        } else {
          Text("The computer measures its disk while it's awake and idle, at most every few hours. Its first measure shows here then.")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }
}

/// What the phone can do with a computer: open its work (an asleep one opens
/// what ADE Cloud keeps for its lane, with no wake), sleep or wake it, delete
/// its lane (the computer goes with it) or a computer that holds no lane, and
/// download the lane's saved work.
/// A lane's size and freeing its computer run the desktop's lane steps, so
/// they stay in the ADE desktop app.
struct CloudMachineControls: View {
  @ObservedObject var store: CloudPaneStore
  let machine: CloudPhoneMachine
  /// False when this page was opened from the lane's own at-rest screen.
  var showsOpenWork = true
  @State private var confirmDelete = false

  private var busy: Bool { store.busy.contains(machine.instanceId) || machine.isMoving }

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
                _ = await store.syncService.ensureAccountMachineForNavigation(key)
              })
            } label: {
              Label("Open its work", systemImage: "arrow.up.forward.app")
            }
            .buttonStyle(ADEKitButtonStyle(prominent: true))
          }
        }
        if store.canWrite {
          if machine.isAwake {
            Button { Task { await store.run("sleep", on: machine) } } label: { Label("Sleep now", systemImage: "moon") }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(busy)
          } else if machine.isAsleep {
            Button { Task { await store.run("wake", on: machine) } } label: { Label("Wake", systemImage: "sun.max") }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(busy || store.outOfHours)
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
      if let lane = machine.lane {
        CloudSavedWorkRow(syncService: store.syncService, laneId: lane.laneId)
      }
      Text(machine.noLane
        ? "Deleting it removes everything on its disk for good."
        : "Change its size or free its computer in the ADE desktop app.")
        .font(.system(size: 12))
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .confirmationDialog("Delete \(machine.displayName)?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete it", role: .destructive) { Task { await store.run("delete", on: machine) } }
    } message: {
      Text("Everything on its disk is gone for good: repos, lanes, and any work not pushed.")
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
    backup = (try? await client.laneBackups(laneId: laneId))?.filter { $0.laneId == laneId }.max { $0.savedAt < $1.savedAt }
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
/// delete. One read when the page shows or its computers change.
struct CloudSavedLaneWorkCard: View {
  @ObservedObject var store: CloudPaneStore
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @State private var backups: [CloudLaneBackupRow] = []
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
      if !rows.isEmpty {
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
    .task(id: store.machines.map(\.instanceId)) { await load() }
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

  private func load() async {
    guard let client = await store.syncService.cloudServerClient() else { return }
    if let rows = try? await client.allLaneBackups() { backups = rows }
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
  @Published private(set) var manageTarget: CloudComputerManageTarget?
  /// The result of a delete; the frontmost host shows it.
  @Published var toast: ADEToastMessage?
  /// Hosts on screen, the frontmost last.
  @Published private(set) var hosts: [UUID] = []
  private var deletePresenter: UUID?
  private var managePresenter: UUID?

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
      managePresenter = hosts.last
      manageTarget = CloudComputerManageTarget(instanceId: instanceId, showsOpenWork: showsOpenWork)
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
  func manageTarget(for host: UUID) -> CloudComputerManageTarget? { managePresenter == host ? manageTarget : nil }

  func closeDelete() {
    deleteTarget = nil
    deletePresenter = nil
  }

  func closeManage() {
    manageTarget = nil
    managePresenter = nil
  }

  /// A deleted lane's computer page has nothing left to show: it closes too.
  func deleted(instanceId: String) {
    closeDelete()
    if manageTarget?.instanceId == instanceId { closeManage() }
  }

  func attach(_ host: UUID) {
    hosts.removeAll { $0 == host }
    hosts.append(host)
  }

  func detach(_ host: UUID) {
    hosts.removeAll { $0 == host }
  }
}

private struct CloudLaneActionsHost: ViewModifier {
  @ObservedObject private var actions = CloudLaneActions.shared
  @State private var id = UUID()

  func body(content: Content) -> some View {
    content
      .sheet(item: Binding(
        get: { actions.manageTarget(for: id) },
        set: { if $0 == nil { actions.closeManage() } }
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

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
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
            CloudSavedWorkRow(syncService: syncService, laneId: target.laneId)
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
    let actions = CloudLaneActions.shared
    guard let client = await syncService.cloudServerClient() else {
      ADEHaptics.error()
      actions.toast = ADEToastMessage(text: "Couldn't delete \(target.laneName)", kind: .failure, detail: "Sign in to ADE, then try again.")
      return
    }
    deleting = true
    defer { deleting = false }
    do {
      try await client.deleteInstance(target.instanceId)
    } catch CloudServerClient.Failure.noAccess {
      // The account no longer lists that computer: it is already gone.
    } catch {
      ADEHaptics.error()
      actions.toast = ADEToastMessage(text: "Couldn't delete \(target.laneName)", kind: .failure, detail: cloudServerFailureMessage(error))
      return
    }
    // The chats go after the computer, so a last saved part can't bring one back.
    var chatsLeft = false
    if let machineKey = target.accountMachineKey {
      do {
        try await client.deleteSavedChats(machineKey: machineKey, laneId: target.laneId)
      } catch {
        chatsLeft = true
      }
    }
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
