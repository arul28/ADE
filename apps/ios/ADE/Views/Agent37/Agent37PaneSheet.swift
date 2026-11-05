import SwiftUI

/// The phone's Agent 37 page (Work ⋯ menu): this month's spend, the account's
/// machines with every action the desktop card has, ready machines, a new
/// machine (approved here as it joins), and what agents may spend alone.
///
/// Layouts: on a phone and the Duo's outer display, a list that pushes a
/// machine. On the inner display held as a book, the list on the left page and
/// the machine on the right; held as a laptop, what you read on the top half
/// and what you tap on the bottom half.
struct Agent37PaneSheet: View {
  @StateObject private var store: Agent37PaneStore
  @Environment(\.dismiss) private var dismiss
  @Environment(\.duoLayout) private var duo

  init(syncService: SyncService) {
    _store = StateObject(wrappedValue: Agent37PaneStore(syncService: syncService))
  }

  #if DEBUG
  init(store: Agent37PaneStore) {
    _store = StateObject(wrappedValue: store)
  }
  #endif

  var body: some View {
    DuoLocalFoldReader { fold, size, landscape in
      switch duo.family(landscape: landscape) {
      case .wide:
        bookLayout(fold: fold, size: size)
      case .tall where fold.isStacked:
        laptopLayout(fold: fold)
      default:
        NavigationStack {
          Agent37ListScreen(store: store, onClose: { dismiss() }, pushes: true)
            .navigationDestination(for: Agent37PhoneMachine.self) { machine in
              Agent37MachineScreen(store: store, instanceId: machine.instanceId)
            }
        }
      }
    }
    .task { await store.reload() }
    .sheet(item: $store.approval) { request in
      DeviceSignInApprovalSheet(request: request) { store.approval = nil }
        .environmentObject(AccountService.shared)
    }
    .sheet(isPresented: $store.newMachinePresented) {
      Agent37NewMachineSheet(store: store)
    }
  }

  private func bookLayout(fold: DuoFold, size: CGSize) -> some View {
    let listWidth: CGFloat = {
      if case .sideBySide(let rect) = fold, rect.minX > 240 { return rect.minX }
      return min(360, size.width * 0.4)
    }()
    return HStack(spacing: 0) {
      NavigationStack {
        Agent37ListScreen(store: store, onClose: { dismiss() }, pushes: false)
      }
      .frame(width: listWidth)
      DuoSeam(axis: .vertical, foldRect: fold.frame)
      NavigationStack {
        if let id = store.selectedId {
          Agent37MachineScreen(store: store, instanceId: id)
        } else {
          Agent37PickPrompt()
        }
      }
    }
  }

  private func laptopLayout(fold: DuoFold) -> some View {
    let topHeight = fold.frame?.minY ?? 320
    return VStack(spacing: 0) {
      NavigationStack {
        ScrollView {
          if let machine = store.selected {
            Agent37MachineFacts(store: store, machine: machine).padding(16)
          } else {
            Agent37SpendingSummary(store: store).padding(16)
          }
        }
        .background(ADEColor.pageBackground.ignoresSafeArea())
        .navigationTitle(store.selected?.displayName ?? "Agent 37")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button { dismiss() } label: { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)) }
              .accessibilityLabel("Close Agent 37")
          }
        }
      }
      .frame(height: topHeight)
      DuoSeam(axis: .horizontal, foldRect: fold.frame)
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if let job = store.makeJob {
            Agent37MakeJobRow(store: store, job: job)
              .padding(ADEKit.inset)
              .background(RoundedRectangle(cornerRadius: ADEKit.radius).fill(ADEKit.surface))
          }
          if let machine = store.selected {
            Agent37MachineControls(store: store, machine: machine)
          }
          Agent37SectionLabel("Your machines")
          Agent37MachineChips(store: store)
        }
        .padding(16)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
    }
  }
}

// MARK: - Store

@MainActor
final class Agent37PaneStore: ObservableObject {
  enum Phase: Equatable { case loading, loaded, notConnected, failed(String) }

  @Published private(set) var phase: Phase = .loading
  @Published private(set) var machines: [Agent37PhoneMachine] = []
  @Published private(set) var balanceUsd: Double?
  @Published private(set) var spending: Agent37PhoneSpending?
  @Published private(set) var limits: Agent37PhoneLimits?
  @Published private(set) var readyProjects: [Agent37PhoneReadyPool.Entry] = []
  /// The machine a two-pane layout shows; the first one until the person picks.
  @Published var selectedId: String?
  /// An action running on a machine, by instance id (its buttons wait).
  @Published private(set) var busy: Set<String> = []
  @Published var actionError: String?
  @Published var newMachinePresented = false
  @Published private(set) var makeJob: Agent37PhoneMakeJob?
  @Published var approval: DeviceSignInRequest?

  let syncService: SyncService
  private var pollTask: Task<Void, Never>?
  /// The make whose approval the sheet already opened, so it opens once.
  private var approvalShownFor: String?

  /// Fixture screens (`-adePreviewScreen duo-agent37…`) hold their data and read nothing.
  private var isFixture = false

  init(syncService: SyncService) {
    self.syncService = syncService
  }

  #if DEBUG
  init(syncService: SyncService, fixtureList: Agent37PhoneList, limits: Agent37PhoneLimits, ready: [Agent37PhoneReadyPool.Entry], makeJob: Agent37PhoneMakeJob? = nil) {
    self.syncService = syncService
    isFixture = true
    machines = fixtureList.machines
    balanceUsd = fixtureList.balanceUsd
    spending = fixtureList.spending
    self.limits = limits
    readyProjects = ready
    self.makeJob = makeJob
    selectedId = fixtureList.machines.first?.instanceId
    phase = .loaded
  }
  #endif

  deinit { pollTask?.cancel() }

  var selected: Agent37PhoneMachine? {
    machines.first { $0.instanceId == selectedId } ?? machines.first
  }

  func machine(_ id: String) -> Agent37PhoneMachine? { machines.first { $0.instanceId == id } }

  var savedUsd: Double? {
    let values = machines.compactMap(\.savedUsd)
    return values.isEmpty ? nil : values.reduce(0, +)
  }

  var hourlyUsd: Double {
    machines.reduce(0) { total, machine in
      total + ((machine.isAwake ? machine.runningHourlyUsd : machine.idleHourlyUsd) ?? 0)
    }
  }

  /// "9 days" / "20 hours" the wallet lasts at this rate, or nil when nothing bills.
  var walletRunway: String? {
    guard let balance = balanceUsd, hourlyUsd > 0 else { return nil }
    let hours = balance / hourlyUsd
    if hours >= 24 * 60 { return "60+ days" }
    return hours >= 48 ? "\(Int(hours / 24)) days" : "\(max(1, Int(hours))) hours"
  }

  func reload() async {
    if isFixture { return }
    do {
      let list = try await syncService.agent37Read("list", as: Agent37PhoneList.self)
      machines = list.machines.sorted { lhs, rhs in
        if lhs.isAwake != rhs.isAwake { return lhs.isAwake }
        return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
      }
      balanceUsd = list.balanceUsd
      spending = list.spending
      if selectedId == nil || machine(selectedId!) == nil { selectedId = machines.first?.instanceId }
      phase = .loaded
      limits = try? await syncService.agent37Read("limits", as: Agent37PhoneLimits.self)
      readyProjects = (try? await syncService.agent37Read("ready_status", as: Agent37PhoneReadyPool.self))?.projects ?? []
    } catch {
      let message = error.localizedDescription
      if message.localizedCaseInsensitiveContains("connect agent 37") {
        phase = .notConnected
      } else if machines.isEmpty {
        phase = .failed(message)
      }
    }
  }

  /// One write on a machine; the list reads again after it.
  func run(_ action: String, on machine: Agent37PhoneMachine, args: [String: Any] = [:]) async {
    busy.insert(machine.instanceId)
    defer { busy.remove(machine.instanceId) }
    actionError = nil
    do {
      var input = args
      input["machine"] = machine.instanceId
      _ = try await syncService.agent37Write(action, args: input, as: Agent37PhoneAck.self)
      ADEHaptics.success()
    } catch {
      actionError = error.localizedDescription
      ADEHaptics.error()
    }
    await reload()
  }

  func setLimits(_ args: [String: Any]) async {
    actionError = nil
    do {
      limits = nil
      _ = try await syncService.agent37Write("set_limits", args: args, as: Agent37PhoneAck.self)
    } catch {
      actionError = error.localizedDescription
    }
    limits = try? await syncService.agent37Read("limits", as: Agent37PhoneLimits.self)
  }

  func setCap(_ usd: Double?) async {
    actionError = nil
    do {
      _ = try await syncService.agent37Write("set_cap", args: ["monthlyCapUsd": usd.map { $0 as Any } ?? "off"], as: Agent37PhoneAck.self)
    } catch {
      actionError = error.localizedDescription
    }
    await reload()
  }

  /// Makes, copies or moves in the background on the connected machine, and
  /// follows it: the approval opens here when the new machine waits for it.
  func startMake(_ action: String, args: [String: Any]) async {
    actionError = nil
    do {
      var input = args
      input["background"] = true
      let started = try await syncService.agent37Write(action, args: input, as: Agent37PhoneMakeStarted.self)
      follow(requestId: started.requestId)
    } catch {
      actionError = error.localizedDescription
      ADEHaptics.error()
    }
  }

  private func follow(requestId: String) {
    pollTask?.cancel()
    pollTask = Task { @MainActor [weak self] in
      // A make takes minutes; a status that can't be read for a minute (the
      // machine restarted and forgot the make, or the link dropped) ends the wait.
      var unreadable = 0
      while !Task.isCancelled {
        guard let self else { return }
        let read = try? await self.syncService.agent37Read("make_status", args: ["requestId": requestId], as: Agent37PhoneMakeJob.self)
        if read == nil {
          unreadable += 1
          if unreadable >= 30 {
            self.makeJob = nil
            self.actionError = "ADE lost track of the new machine. Pull to refresh: if it joined, it's in the list."
            await self.reload()
            return
          }
        } else {
          unreadable = 0
        }
        if let job = read {
          self.makeJob = job
          if let request = job.approvalRequest, self.approvalShownFor != requestId {
            self.approvalShownFor = requestId
            self.approval = request
          }
          if job.done {
            if let error = job.error { self.actionError = error } else { ADEHaptics.success() }
            await self.reload()
            return
          }
        }
        try? await Task.sleep(nanoseconds: 2_000_000_000)
      }
    }
  }

  func dismissMakeJob() {
    pollTask?.cancel()
    makeJob = nil
  }
}

// MARK: - List

struct Agent37ListScreen: View {
  @ObservedObject var store: Agent37PaneStore
  var onClose: () -> Void
  /// True on a phone: a row pushes the machine. False in the book layout: a row selects it.
  var pushes: Bool

  var body: some View {
    List {
      switch store.phase {
      case .loading where store.machines.isEmpty:
        Section { ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear) }
      case .notConnected:
        Section {
          Agent37Notice(symbol: "cloud", title: "Agent 37 isn't connected", detail: "Connect it on a desktop: Settings › Integrations › Agent 37. Then your cloud machines show here.")
        }
      case .failed(let message):
        Section { Agent37Notice(symbol: "exclamationmark.triangle", title: "Couldn't read Agent 37", detail: message) }
      default:
        Section { Agent37SpendingSummary(store: store).listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16)) }
          .listRowBackground(Color.clear)
        if let job = store.makeJob { Section { Agent37MakeJobRow(store: store, job: job) } }
        if let error = store.actionError {
          Section { Agent37Notice(symbol: "exclamationmark.circle", title: "That didn't work", detail: error) }
        }
        Section {
          if store.machines.isEmpty {
            Text("No machines yet. Make one with +.").font(.subheadline).foregroundStyle(ADEColor.textSecondary)
          }
          ForEach(store.machines) { machine in
            if pushes {
              NavigationLink(value: machine) { Agent37MachineRow(machine: machine, busy: store.busy.contains(machine.instanceId)) }
            } else {
              Button {
                ADEHaptics.light()
                store.selectedId = machine.instanceId
              } label: {
                Agent37MachineRow(machine: machine, busy: store.busy.contains(machine.instanceId))
              }
              .buttonStyle(.plain)
              .listRowBackground(store.selected?.instanceId == machine.instanceId ? ADEColor.accent.opacity(0.12) : Color.clear)
            }
          }
        } header: { Agent37SectionLabel("Machines") }
        if !store.readyProjects.isEmpty {
          Section {
            ForEach(store.readyProjects) { entry in Agent37ReadyRow(store: store, entry: entry) }
          } header: { Agent37SectionLabel("Ready machines") }
        }
        Section {
          NavigationLink { Agent37LimitsScreen(store: store) } label: {
            Label {
              VStack(alignment: .leading, spacing: 2) {
                Text("What agents may spend")
                Text(store.limits.map(agent37LimitsSummary) ?? "…").font(.caption).foregroundStyle(ADEColor.textSecondary)
              }
            } icon: { Image(systemName: "shield.lefthalf.filled") }
          }
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .refreshable { await store.reload() }
    .navigationTitle("Agent 37")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button { onClose() } label: { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)) }
          .accessibilityLabel("Close Agent 37")
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          ADEHaptics.light()
          store.newMachinePresented = true
        } label: { Image(systemName: "plus") }
          .disabled(store.phase != .loaded || store.spending?.capReached == true)
          .accessibilityLabel("New Agent 37 machine")
      }
    }
  }
}

struct Agent37SpendingSummary: View {
  @ObservedObject var store: Agent37PaneStore

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Agent37Figure(label: "This month", value: store.spending?.monthSpentUsd.map(agent37Usd) ?? "—",
                      unit: store.spending?.monthlyCapUsd.map { "of \(agent37Usd($0))" })
        Agent37Figure(label: "Saved asleep", value: store.savedUsd.map(agent37Usd) ?? "—", unit: nil)
        Agent37Figure(label: "Wallet lasts", value: store.walletRunway ?? "—", unit: nil)
      }
      if store.spending?.capReached == true {
        Agent37Notice(symbol: "pause.circle", title: "At this month's cap", detail: "ADE won't make, wake or resize machines until the cap goes up or the month ends. Running work carries on.")
      } else if let runway = store.walletRunway, let balance = store.balanceUsd, store.hourlyUsd > 0, balance / store.hourlyUsd < 72 {
        Agent37Notice(symbol: "creditcard", title: "Your wallet is running low", detail: "\(agent37Usd(balance)) lasts about \(runway) at this rate. Top it up at agent37.com.")
      }
    }
  }
}

struct Agent37Figure: View {
  let label: String
  let value: String
  let unit: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption2).foregroundStyle(ADEColor.textMuted)
      Text(value).font(.system(.headline, design: .rounded)).monospacedDigit().foregroundStyle(ADEColor.textPrimary)
      if let unit { Text(unit).font(.caption2).foregroundStyle(ADEColor.textMuted) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(10)
    .background(RoundedRectangle(cornerRadius: 10).fill(ADEKit.surface))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(ADEKit.edge))
    .accessibilityElement(children: .combine)
  }
}

struct Agent37MachineRow: View {
  let machine: Agent37PhoneMachine
  var busy = false

  var body: some View {
    HStack(spacing: 10) {
      Agent37StateDot(machine: machine)
      VStack(alignment: .leading, spacing: 2) {
        Text(machine.displayName).font(.subheadline.weight(.semibold)).foregroundStyle(ADEColor.textPrimary).lineLimit(1)
        Text([machine.isVM ? "VM" : "Box", machine.shape.map(agent37ShapeLabel), machine.stateLabel.lowercased()]
          .compactMap { $0 }.joined(separator: " · "))
          .font(.caption).foregroundStyle(ADEColor.textSecondary).lineLimit(1)
      }
      Spacer(minLength: 8)
      if busy {
        ProgressView()
      } else {
        Text(machine.isAwake || machine.isMoving ? machine.runningHourlyUsd.map(agent37Hourly) ?? "" : "disk only")
          .font(.caption).foregroundStyle(ADEColor.textMuted)
      }
    }
    .frame(minHeight: 44)
    .contentShape(Rectangle())
  }
}

struct Agent37StateDot: View {
  let machine: Agent37PhoneMachine

  var body: some View {
    Circle()
      .fill(machine.isAwake ? ADEColor.success : machine.isMoving ? ADEColor.warning : machine.isAsleep ? ADEColor.textMuted : ADEColor.danger)
      .frame(width: 8, height: 8)
      .accessibilityHidden(true)
  }
}

struct Agent37ReadyRow: View {
  @ObservedObject var store: Agent37PaneStore
  let entry: Agent37PhoneReadyPool.Entry

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(entry.projectName).font(.subheadline.weight(.semibold))
        Spacer()
        Text(entry.keptReady ? "On" : "Off").font(.caption).foregroundStyle(ADEColor.textSecondary)
      }
      Text([entry.ready > 0 ? "\(entry.ready) ready" : nil, entry.preparing > 0 ? "\(entry.preparing) preparing" : nil,
            entry.inUse > 0 ? "\(entry.inUse) in use" : nil].compactMap { $0 }.joined(separator: " · ").ifEmpty("Nothing ready yet"))
        .font(.caption).foregroundStyle(ADEColor.textSecondary)
      if let failure = entry.failure {
        Text(failure).font(.caption).foregroundStyle(ADEColor.danger).lineLimit(3)
      }
    }
    .frame(minHeight: 44)
  }
}

struct Agent37MakeJobRow: View {
  @ObservedObject var store: Agent37PaneStore
  let job: Agent37PhoneMakeJob

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      if job.done {
        Image(systemName: job.error == nil ? "checkmark.circle.fill" : "xmark.octagon.fill")
          .foregroundStyle(job.error == nil ? ADEColor.success : ADEColor.danger)
      } else {
        ProgressView()
      }
      VStack(alignment: .leading, spacing: 6) {
        Text(job.done ? (job.error == nil ? "Your new machine is ready" : "The new machine didn't finish") : "Making your machine…")
          .font(.subheadline.weight(.semibold))
        Text(job.error ?? job.message).font(.caption).foregroundStyle(ADEColor.textSecondary)
        if let request = job.approvalRequest, !job.done {
          Button {
            store.approval = request
          } label: {
            Label("Approve", systemImage: "checkmark.shield")
              .symbolRenderingMode(.monochrome)
              .foregroundStyle(.white)
              .frame(minHeight: 32)
          }
          .buttonStyle(.borderedProminent)
          .tint(ADEColor.accent)
          .accessibilityHint("Lets the new machine join your ADE account")
        }
      }
      Spacer(minLength: 0)
      if job.done {
        Button { store.dismissMakeJob() } label: { Image(systemName: "xmark") }
          .buttonStyle(.plain)
          .foregroundStyle(ADEColor.textMuted)
          .accessibilityLabel("Dismiss")
      }
    }
  }
}

// MARK: - One machine

struct Agent37MachineScreen: View {
  @ObservedObject var store: Agent37PaneStore
  let instanceId: String

  var body: some View {
    ScrollView {
      if let machine = store.machine(instanceId) {
        VStack(alignment: .leading, spacing: 18) {
          Agent37MachineFacts(store: store, machine: machine)
          Agent37MachineControls(store: store, machine: machine)
        }
        .padding(16)
      } else {
        Agent37Notice(symbol: "questionmark.circle", title: "That machine is gone", detail: "It was deleted, or moved to a new machine.").padding(16)
      }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .refreshable { await store.reload() }
    .navigationTitle(store.machine(instanceId)?.displayName ?? "Machine")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct Agent37MachineFacts: View {
  @ObservedObject var store: Agent37PaneStore
  let machine: Agent37PhoneMachine

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Agent37StateDot(machine: machine)
        Text(machine.stateLabel).font(.headline)
        if machine.ready != nil {
          Text("Ready machine").font(.caption2.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(ADEColor.accent.opacity(0.16))).foregroundStyle(ADEColor.accent)
        }
      }
      Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
        fact("Size", machine.size ?? (machine.isVM ? "VM" : "Box"))
        fact("Price", [machine.runningHourlyUsd.map { "\(agent37Hourly($0)) awake" }, machine.idleHourlyUsd.map { "\(agent37Daily($0)) asleep" }]
          .compactMap { $0 }.joined(separator: " · ").ifEmpty("—"))
        fact("Sleeps", machine.sleep?.label ?? "—")
        fact("Spent", machine.spentUsd.map { "\(agent37Usd($0)) this month" } ?? "—")
        if let saved = machine.savedUsd, saved > 0 { fact("Saved", "\(agent37Usd(saved)) asleep") }
        if machine.pastDue == true { fact("Wallet", "Empty: Agent 37 suspended it") }
      }
      .font(.subheadline)
    }
    .padding(ADEKit.inset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: ADEKit.radius).fill(ADEKit.surface))
    .overlay(RoundedRectangle(cornerRadius: ADEKit.radius).stroke(ADEKit.edge))
  }

  private func fact(_ label: String, _ value: String) -> some View {
    GridRow {
      Text(label).foregroundStyle(ADEColor.textMuted)
      Text(value).foregroundStyle(ADEColor.textPrimary)
    }
  }
}

struct Agent37MachineControls: View {
  @ObservedObject var store: Agent37PaneStore
  let machine: Agent37PhoneMachine
  @State private var confirmDelete = false
  @State private var resizing = false
  @State private var copying = false
  @State private var moving = false

  private var busy: Bool { store.busy.contains(machine.instanceId) || machine.isMoving }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Agent37SectionLabel("Actions")
      Agent37FlowRow {
        if let key = machine.machineKey {
          Agent37ActionButton("Open its work", symbol: "arrow.up.forward.app", primary: true, disabled: busy) {
            store.syncService.agent37PanePresented = false
            Task { _ = await store.syncService.ensureAccountMachineForNavigation(key) }
          }
        }
        if machine.isAwake {
          Agent37ActionButton("Sleep now", symbol: "moon", disabled: busy) { Task { await store.run("sleep", on: machine) } }
        } else if machine.isAsleep {
          Agent37ActionButton("Wake", symbol: "sun.max", disabled: busy || store.spending?.capReached == true) { Task { await store.run("wake", on: machine) } }
        }
        Agent37ActionButton("Resize…", symbol: "arrow.up.left.and.arrow.down.right", disabled: busy) { resizing = true }
        Agent37ActionButton("Copy…", symbol: "plus.square.on.square", disabled: busy) { copying = true }
        Agent37ActionButton(machine.isVM ? "Move to a box…" : "Move to a VM…", symbol: "arrow.left.arrow.right", disabled: busy) { moving = true }
        Menu {
          ForEach([5, 10, 30, 60], id: \.self) { minutes in
            Button("After \(minutes) min idle") { Task { await store.run("set_sleep", on: machine, args: ["minutes": minutes]) } }
          }
          Button("Never (bills around the clock)") { Task { await store.run("set_sleep", on: machine, args: ["minutes": "never"]) } }
        } label: {
          Agent37ActionLabel(title: "Sleep after…", symbol: "timer", primary: false, destructive: false)
        }
        .disabled(busy)
        Agent37ActionButton("Delete…", symbol: "trash", destructive: true, disabled: busy) { confirmDelete = true }
      }
    }
    .confirmationDialog("Delete \(machine.displayName)?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete it", role: .destructive) { Task { await store.run("delete", on: machine) } }
    } message: {
      Text("Everything on its disk is gone for good: repos, lanes, and any work not pushed.")
    }
    .confirmationDialog("Resize \(machine.displayName)", isPresented: $resizing, titleVisibility: .visible) {
      ForEach(agent37Shapes.filter { $0.id != machine.shape }, id: \.id) { shape in
        Button(shape.label) { Task { await store.run("resize", on: machine, args: ["shape": shape.id]) } }
      }
    } message: {
      Text("It restarts to change size: files stay, running chats and terminals stop.")
    }
    .confirmationDialog("Copy \(machine.displayName)", isPresented: $copying, titleVisibility: .visible) {
      Button("Make a copy") { Task { await store.startMake("copy", args: ["machine": machine.instanceId]) } }
    } message: {
      Text("A new machine with the same files (repos, lanes, installed dependencies). You approve it joining your account.")
    }
    .confirmationDialog("Move \(machine.displayName) to a \(machine.isVM ? "box" : "VM")", isPresented: $moving, titleVisibility: .visible) {
      Button("Move it") { Task { await store.startMake("move", args: ["machine": machine.instanceId, "to": machine.isVM ? "box" : "vm"]) } }
    } message: {
      Text("ADE makes the new machine, copies every repo, lane and chat into it, then deletes this one.\(machine.isVM ? " Docker images stay behind." : "")")
    }
  }
}

struct Agent37MachineChips: View {
  @ObservedObject var store: Agent37PaneStore

  var body: some View {
    Agent37FlowRow {
      ForEach(store.machines) { machine in
        Button {
          ADEHaptics.light()
          store.selectedId = machine.instanceId
        } label: {
          HStack(spacing: 6) {
            Agent37StateDot(machine: machine)
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
      Button { store.newMachinePresented = true } label: {
        Label("New", systemImage: "plus").font(.subheadline).padding(.horizontal, 12).frame(minHeight: 44)
          .overlay(Capsule().stroke(ADEKit.edge))
      }
      .buttonStyle(.plain)
    }
  }
}

struct Agent37PickPrompt: View {
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "cloud").font(.system(size: 30)).foregroundStyle(ADEColor.textMuted)
      Text("Pick a machine").font(.headline)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ADEColor.pageBackground.ignoresSafeArea())
  }
}

// MARK: - New machine

struct Agent37NewMachineSheet: View {
  @ObservedObject var store: Agent37PaneStore
  @Environment(\.dismiss) private var dismiss
  @State private var kind = "box"
  @State private var shape = "2x4"
  @State private var name = ""

  var body: some View {
    NavigationStack {
      Form {
        Section("Type") {
          Picker("Type", selection: $kind) {
            Text("Box").tag("box")
            Text("VM").tag("vm")
          }
          .pickerStyle(.segmented)
          Text(kind == "vm" ? "Its own kernel: Docker and the Android emulator run. About 2.5x a box." : "Lanes, chats, terminals and a Linux desktop. The cheapest.")
            .font(.caption).foregroundStyle(ADEColor.textSecondary)
        }
        Section("Size") {
          Picker("Size", selection: $shape) {
            ForEach(agent37Shapes, id: \.id) { entry in Text(entry.label).tag(entry.id) }
          }
          .pickerStyle(.inline)
          .labelsHidden()
        }
        Section("Name") {
          TextField(kind == "vm" ? "Agent 37 VM" : "Agent 37 box", text: $name)
            .textInputAutocapitalization(.never)
        }
        Section {
          Text("It sleeps after 10 idle minutes and then bills only its disk. When it's ready, you approve it joining your account here.")
            .font(.caption).foregroundStyle(ADEColor.textSecondary)
        }
      }
      .navigationTitle("New machine")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Make it") {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            var args: [String: Any] = ["kind": kind, "shape": shape]
            if !trimmed.isEmpty { args["name"] = trimmed }
            dismiss()
            Task { await store.startMake("create", args: args) }
          }
        }
      }
      .onChange(of: kind) { _, next in if next == "vm" && shape == "2x4" { shape = "4x8" } }
    }
    .presentationDetents([.medium, .large])
  }
}

// MARK: - What agents may spend

struct Agent37LimitsScreen: View {
  @ObservedObject var store: Agent37PaneStore

  private let presets: [(id: String, name: String, line: String, symbol: String)] = [
    ("ask", "Ask me", "Nothing costs money without your yes.", "checkmark.shield"),
    ("balanced", "Balanced", "Agents get what they need, within limits.", "scalemass"),
    ("hands_off", "Hands-off", "For big runs: many machines at once.", "airplane.departure"),
  ]

  var body: some View {
    List {
      Section {
        Text("When you're watching, agents ask first. These choose what an agent may do when nobody is: a full-auto chat or an automation.")
          .font(.subheadline).foregroundStyle(ADEColor.textSecondary)
      }
      .listRowBackground(Color.clear)
      Section {
        ForEach(presets, id: \.id) { preset in
          Button {
            ADEHaptics.light()
            Task { await store.setLimits(["preset": preset.id]) }
          } label: {
            HStack(spacing: 12) {
              Image(systemName: preset.symbol).frame(width: 28).foregroundStyle(ADEColor.accent)
              VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                  Text(preset.name).font(.subheadline.weight(.semibold)).foregroundStyle(ADEColor.textPrimary)
                  if preset.id == "balanced" {
                    Text("Recommended").font(.caption2).padding(.horizontal, 6).padding(.vertical, 1)
                      .background(Capsule().fill(ADEColor.accent.opacity(0.16))).foregroundStyle(ADEColor.accent)
                  }
                }
                Text(preset.line).font(.caption).foregroundStyle(ADEColor.textSecondary)
              }
              Spacer()
              if store.limits?.preset == preset.id { Image(systemName: "checkmark").foregroundStyle(ADEColor.accent) }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
      } header: { Agent37SectionLabel("Choose") } footer: {
        if store.limits?.preset == "custom" { Text("Custom: your own limits below.") }
      }
      if let limits = store.limits {
        Section {
          Toggle("Unattended agents may spend", isOn: Binding(
            get: { limits.unattendedSpend },
            set: { value in Task { await store.setLimits(["unattendedSpend": value]) } }
          ))
          Picker("New machines a day", selection: Binding(
            get: { limits.machinesPerDay },
            set: { value in Task { await store.setLimits(["machinesPerDay": value]) } }
          )) {
            ForEach([1, 3, 5, 10], id: \.self) { Text("\($0)").tag($0) }
          }
          .disabled(!limits.unattendedSpend)
          Picker("Largest size", selection: Binding(
            get: { limits.maxShape },
            set: { value in Task { await store.setLimits(["maxShape": value]) } }
          )) {
            ForEach(agent37Shapes, id: \.id) { Text($0.label).tag($0.id) }
          }
          .disabled(!limits.unattendedSpend)
        } header: { Agent37SectionLabel("Limits") }
      } else {
        Section { ProgressView().frame(maxWidth: .infinity) }
      }
      Section {
        Picker("Monthly cap", selection: Binding(
          get: { store.spending?.monthlyCapUsd ?? 0 },
          set: { value in Task { await store.setCap(value == 0 ? nil : value) } }
        )) {
          Text("Off").tag(0.0)
          ForEach([10.0, 25.0, 50.0, 100.0], id: \.self) { Text("$\(Int($0))").tag($0) }
        }
      } header: { Agent37SectionLabel("Monthly cap") } footer: {
        Text("Optional. Your Agent 37 wallet is prepaid, so it already caps what you can spend.")
      }
      Section {
        Label("Always yours to decide: keeping a machine awake for good, raising the cap or these limits, and deleting a machine an agent didn't make.", systemImage: "lock.fill")
          .font(.caption).foregroundStyle(ADEColor.textSecondary)
      }
      .listRowBackground(Color.clear)
      if let error = store.actionError {
        Section { Agent37Notice(symbol: "exclamationmark.circle", title: "That didn't save", detail: error) }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle("What agents may spend")
    .navigationBarTitleDisplayMode(.inline)
  }
}

// MARK: - Small pieces

struct Agent37SectionLabel: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text.uppercased()).font(.caption2.weight(.semibold)).tracking(0.6).foregroundStyle(ADEColor.textMuted)
  }
}

struct Agent37Notice: View {
  let symbol: String
  let title: String
  let detail: String

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol).foregroundStyle(ADEColor.warning)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.subheadline.weight(.semibold))
        Text(detail).font(.caption).foregroundStyle(ADEColor.textSecondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}

struct Agent37ActionLabel: View {
  let title: String
  let symbol: String
  let primary: Bool
  let destructive: Bool

  var body: some View {
    Label(title, systemImage: symbol)
      .font(.subheadline)
      .padding(.horizontal, 12)
      .frame(minHeight: 44)
      .foregroundStyle(destructive ? ADEColor.danger : primary ? ADEColor.accent : ADEColor.textPrimary)
      .background(RoundedRectangle(cornerRadius: 10).fill(primary ? ADEColor.accent.opacity(0.14) : ADEKit.surface))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(primary ? ADEColor.accent.opacity(0.5) : ADEKit.edge))
  }
}

struct Agent37ActionButton: View {
  let title: String
  let symbol: String
  var primary = false
  var destructive = false
  var disabled = false
  let action: () -> Void

  init(_ title: String, symbol: String, primary: Bool = false, destructive: Bool = false, disabled: Bool = false, action: @escaping () -> Void) {
    self.title = title
    self.symbol = symbol
    self.primary = primary
    self.destructive = destructive
    self.disabled = disabled
    self.action = action
  }

  var body: some View {
    Button {
      ADEHaptics.light()
      action()
    } label: {
      Agent37ActionLabel(title: title, symbol: symbol, primary: primary, destructive: destructive)
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.5 : 1)
  }
}

/// Wraps its children onto as many rows as they need.
struct Agent37FlowRow: Layout {
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

struct Agent37ShapeOption {
  let id: String
  let label: String
}

let agent37Shapes: [Agent37ShapeOption] = [
  .init(id: "2x4", label: "2 vCPU · 4 GB"),
  .init(id: "4x8", label: "4 vCPU · 8 GB"),
  .init(id: "4x16", label: "4 vCPU · 16 GB"),
  .init(id: "4x32", label: "4 vCPU · 32 GB"),
]

func agent37ShapeLabel(_ id: String) -> String {
  agent37Shapes.first { $0.id == id }?.label ?? id
}

/// "$3.42" / "$12" / "under 1¢", as the desktop writes it.
func agent37Usd(_ usd: Double) -> String {
  if usd > 0 && usd < 0.01 { return "under 1¢" }
  return usd >= 10 ? "$\(Int(usd.rounded()))" : String(format: "$%.2f", usd)
}

/// "0.8¢/h" / "2.0¢/h".
func agent37Hourly(_ usd: Double) -> String {
  let cents = usd * 100
  return cents < 10 ? String(format: "%.1f¢/h", cents) : "\(Int(cents.rounded()))¢/h"
}

/// What an hourly rate comes to a day, for a machine asleep (its disk): "1¢/day".
func agent37Daily(_ hourlyUsd: Double) -> String {
  let cents = hourlyUsd * 24 * 100
  return cents < 1 ? "under 1¢/day" : cents < 10 ? String(format: "%.1f¢/day", cents) : "\(Int(cents.rounded()))¢/day"
}

func agent37LimitsSummary(_ limits: Agent37PhoneLimits) -> String {
  let name: String
  switch limits.preset {
  case "ask": name = "Ask me"
  case "balanced": name = "Balanced"
  case "hands_off": name = "Hands-off"
  default: name = "Custom"
  }
  guard limits.unattendedSpend else { return "\(name) · unattended agents ask" }
  return "\(name) · \(limits.machinesPerDay) a day · up to \(agent37ShapeLabel(limits.maxShape))"
}

private extension String {
  func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}

#if DEBUG
/// `-adePreviewScreen duo-agent37` (and `duo-agent37-limits`): the page from
/// fixtures, for screenshots on any device and fold.
enum Agent37Previews {
  @MainActor static func view(_ name: String) -> AnyView? {
    guard name == "duo-agent37" || name == "duo-agent37-limits" || name == "duo-agent37-making" else { return nil }
    let json = """
    {"machines":[
      {"instanceId":"zodqsue74s","name":"supabase-stack","machineKey":"mk1","state":"running","type":"vm","size":"VM · 4 vCPU · 8 GB","shape":"4x8","runningHourlyUsd":0.02,"idleHourlyUsd":0.0004,"spentUsd":2.1,"savedUsd":6.4,"sleep":{"state":"auto","afterMinutes":10},"madeByAde":true,"ready":null,"pastDue":false},
      {"instanceId":"k2p8a1b2c3","name":"lane box","machineKey":"mk2","state":"asleep","type":"box","size":"Box · 2 vCPU · 4 GB","shape":"2x4","runningHourlyUsd":0.008,"idleHourlyUsd":0.0004,"spentUsd":0.42,"savedUsd":3.9,"sleep":{"state":"auto","afterMinutes":10},"madeByAde":true,"ready":null,"pastDue":false},
      {"instanceId":"a9x7c6v5b4","name":"android vm","machineKey":"mk3","state":"starting","type":"vm","size":"VM · 4 vCPU · 8 GB","shape":"4x8","runningHourlyUsd":0.02,"idleHourlyUsd":0.0004,"spentUsd":0.9,"savedUsd":1.5,"sleep":{"state":"auto","afterMinutes":10},"madeByAde":true,"ready":{"projectName":"acme/app","state":"claimed"},"pastDue":false}
    ],"balanceUsd":9.66,"instanceLimit":5,"runningCount":2,
    "spending":{"monthlyCapUsd":null,"monthSpentUsd":3.42,"capReached":false,"capNear":false}}
    """
    guard let list = try? JSONDecoder().decode(Agent37PhoneList.self, from: Data(json.utf8)) else { return nil }
    let limits = Agent37PhoneLimits(unattendedSpend: true, machinesPerDay: 3, maxShape: "4x16", preset: "balanced")
    let ready = [Agent37PhoneReadyPool.Entry(identity: "github.com/acme/app", projectName: "acme/app", keptReady: true, ready: 1, preparing: 0, inUse: 1, failed: 0, failure: nil)]
    let making = name == "duo-agent37-making"
      ? Agent37PhoneMakeJob(requestId: "r1", kind: "create", stage: "approve_elsewhere", message: "Approve lane box 2 joining your account.", instanceId: "n3w4b0x5zz", approvalUrl: "https://ade-app.dev/device?user_code=ABCD-EFGH", done: false, error: nil)
      : nil
    let store = Agent37PaneStore(syncService: SyncService.shared ?? SyncService(), fixtureList: list, limits: limits, ready: ready, makeJob: making)
    if name == "duo-agent37-limits" {
      return AnyView(NavigationStack { Agent37LimitsScreen(store: store) })
    }
    return AnyView(Agent37PaneSheet(store: store))
  }
}
#endif
