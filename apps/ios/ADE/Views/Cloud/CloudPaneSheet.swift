import Combine
import OSLog
import SwiftUI
import UIKit

private let cloudPaneLog = Logger(subsystem: "com.ade.ios", category: "cloud-pane")

/// The phone's ADE Cloud page: the mirror of the desktop's Settings › ADE
/// Cloud dashboard (`settings/cloudDashboard/CloudDashboard.tsx`), in the
/// same order and words, drawn with ADEKit (flat, cheap in lists):
///
/// 1. the plan, hours left (of N, resets <UTC date>), earned hours, extra
///    hours, the forecast, disk and computers;
/// 2. every lane and every computer the account pays for (a computer with no
///    lane says "No lane"): size, disk, state, last run;
/// 3. the plans side by side (what each includes, the current one marked);
/// 4. the sizes (CPU, memory, disk limit, what it runs, rate, how long the
///    hours left last there);
/// 5. the sign-ins cloud computers use, one row per provider;
/// 6. what agents may do alone.
///
/// App Store rule: the iPhone app never offers to buy or change a plan, shows
/// no price, links to no checkout and says nowhere where to change a plan.
/// The plans card says only what each plan includes.
///
/// Two ways in, both behind `sync.cloudAvailable && sync.cloudSupported`:
/// Work › ⋯ › ADE Cloud (this sheet) and Settings › ADE Cloud
/// (`CloudSettingsPage`). Reads go to the machine the phone is connected to
/// (`cloud.read`); with none, the phone reads the account server itself. A
/// computer's actions (sleep, wake, size, free, clear caches, keep, update,
/// delete) work with no computer of the person's own: they go to the account
/// server with the phone's own sign-in, the same routes the desktop uses
/// (sleep, wake and a no-lane delete still go through a connected machine's
/// `cloud.write`). The account's ADE Cloud is the same from any device.
///
/// Layouts: on a phone and the Duo's outer display, one page that pushes a
/// computer. On the inner display held as a book, the page on the left and
/// the computer on the right; held as a laptop, what you read on the top half
/// and what you tap on the bottom half.
struct CloudPaneSheet: View {
  @StateObject private var store: CloudPaneStore
  @Environment(\.dismiss) private var dismiss
  @Environment(\.duoLayout) private var duo

  init(syncService: SyncService) {
    _store = StateObject(wrappedValue: CloudPaneStore(syncService: syncService))
  }

  #if DEBUG
  init(store: CloudPaneStore) {
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
          CloudDashboardScreen(store: store, onClose: { dismiss() }, pushes: true)
        }
      }
    }
    .task { await store.load() }
    .cloudLaneActionsHost()
  }

  private func bookLayout(fold: DuoFold, size: CGSize) -> some View {
    let listWidth: CGFloat = {
      if case .sideBySide(let rect) = fold, rect.minX > 240 { return rect.minX }
      return min(380, size.width * 0.42)
    }()
    return HStack(spacing: 0) {
      NavigationStack {
        CloudDashboardScreen(store: store, onClose: { dismiss() }, pushes: false)
      }
      .frame(width: listWidth)
      DuoSeam(axis: .vertical, foldRect: fold.frame)
      NavigationStack {
        if let id = store.selectedId {
          CloudMachineScreen(store: store, instanceId: id, pops: false)
        } else {
          CloudPickPrompt()
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
            CloudMachineFacts(store: store, machine: machine).padding(16)
          } else {
            CloudHero(store: store).padding(16)
          }
        }
        .background(ADEColor.pageBackground.ignoresSafeArea())
        .navigationTitle(store.selected?.displayName ?? "ADE Cloud")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button { dismiss() } label: { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)) }
              .accessibilityLabel("Close ADE Cloud")
          }
        }
      }
      .frame(height: topHeight)
      DuoSeam(axis: .horizontal, foldRect: fold.frame)
      // Its own stack, so an asleep lane's "Open its work" pushes the lane's
      // saved work into this half. The bar shows only on that pushed page.
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
            if let machine = store.selected {
              CloudMachineControls(store: store, machine: machine)
            }
            ADEEyebrow("Lanes and computers")
            CloudMachineChips(store: store)
          }
          .padding(16)
        }
        .background(ADEColor.pageBackground.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
      }
    }
  }
}

/// Settings › ADE Cloud: the same page, pushed in Settings' own stack (the
/// desktop's sidebar tab). Settings shows the row only with access.
struct CloudSettingsPage: View {
  @StateObject private var store: CloudPaneStore

  init(syncService: SyncService) {
    _store = StateObject(wrappedValue: CloudPaneStore(syncService: syncService))
  }

  var body: some View {
    CloudDashboardScreen(store: store, onClose: nil, pushes: true)
      .task { await store.load() }
      .cloudLaneActionsHost()
  }
}

/// A cloud lane's "Manage computer": the same `CloudMachineScreen` as ADE
/// Cloud's dashboard, for one computer. It shows the computer's state, size,
/// disk and last run; opens the lane's work (at rest when the computer is
/// asleep); sleeps or wakes it; changes its size; frees its computer (the
/// lane stays); clears its caches; deletes the lane (with its computer, from
/// the account, no wake); and downloads the lane's saved work. All of it
/// works with no computer of the person's own.
struct CloudLaneManageSheet: View {
  @StateObject private var store: CloudPaneStore
  let instanceId: String
  let showsOpenWork: Bool
  @Environment(\.dismiss) private var dismiss

  init(syncService: SyncService, instanceId: String, showsOpenWork: Bool = true) {
    _store = StateObject(wrappedValue: CloudPaneStore(syncService: syncService))
    self.instanceId = instanceId
    self.showsOpenWork = showsOpenWork
  }

  var body: some View {
    NavigationStack {
      CloudMachineScreen(store: store, instanceId: instanceId, showsOpenWork: showsOpenWork)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { dismiss() }
          }
        }
    }
    .task { await store.load() }
    .cloudLaneActionsHost()
  }
}

// MARK: - Store

@MainActor
final class CloudPaneStore: ObservableObject {
  enum Phase: Equatable { case loading, loaded, failed(String) }

  @Published private(set) var phase: Phase = .loading
  @Published private(set) var machines: [CloudPhoneMachine] = []
  @Published private(set) var account: CloudPhoneAccount?
  @Published private(set) var limits: CloudPhoneLimits? {
    didSet { if limits != nil { limitsError = nil } }
  }
  /// Why the account's limits could not be read; the card shows it in
  /// place of "Reading…". Nil once limits are read.
  @Published private(set) var limitsError: String?
  /// The account's sign-ins (`providerLogins.status`); nil before the read,
  /// on an older machine, or when it can't be read.
  @Published private(set) var signIns: ProviderLoginsPhoneStatus?
  @Published private(set) var signInsUnreadable = false
  @Published private(set) var signInsSaving = false
  /// The computer a two-pane layout shows; the first one until the person picks.
  @Published var selectedId: String?
  /// An action running on a computer, by instance id (its buttons wait).
  @Published private(set) var busy: Set<String> = []
  @Published var actionError: String?
  /// One clock per read: "ran 3 h ago" moves when the list is read again.
  @Published private(set) var now = Date()
  /// Bumped by each pull to refresh: cards with reads of their own read again.
  @Published private(set) var refreshes = 0

  let syncService: SyncService

  /// Fixture screens (`-adePreviewScreen duo-cloud…`) hold their data and read nothing.
  private var isFixture = false
  private var signInsWatch: AnyCancellable?
  /// Bumped by each sign-ins read and write: only the newest one's answer lands.
  private var signInsRequest = 0

  init(syncService: SyncService) {
    self.syncService = syncService
    // A sign-in saved or applied on the machine shows at once (its push), not on the next open.
    signInsWatch = syncService.$providerLoginsRevision
      .dropFirst()
      .removeDuplicates()
      .sink { [weak self] _ in
        Task { @MainActor in await self?.reloadSignIns() }
      }
  }

  #if DEBUG
  init(syncService: SyncService, fixtureList: CloudPhoneList, limits: CloudPhoneLimits, signIns: ProviderLoginsPhoneStatus? = nil, now: Date = Date()) {
    self.syncService = syncService
    isFixture = true
    machines = CloudPaneStore.ordered(fixtureList.machines, now: now)
    account = fixtureList.account
    self.limits = limits
    self.signIns = signIns
    self.now = now
    selectedId = machines.first?.instanceId
    phase = .loaded
  }
  #endif

  var selected: CloudPhoneMachine? {
    machines.first { $0.instanceId == selectedId } ?? machines.first
  }

  func machine(_ id: String) -> CloudPhoneMachine? { machines.first { $0.instanceId == id } }

  var outOfHours: Bool { account?.outOfHours == true }

  var tiers: [CloudPhoneTier] { cloudPhoneTiers(account?.catalog) }

  /// The phone may change things on this machine (a controlling device).
  var canWrite: Bool { syncService.canInvokeRemoteAction("cloud.write") }

  /// No connected computer runs this page: the phone reads the account
  /// server itself (`/cloud/account`, `/cloud/instances`, `/cloud/limits`,
  /// `/cloud/sign-ins`), and acts on each computer there too.
  @Published private(set) var isDirect = false
  /// Why the direct read of the account's computers failed; nil once it worked.
  @Published private(set) var instancesError: String?
  /// The revision of the limits a direct write names (`ifRevision`).
  private var limitsRevision: String?

  /// The person may change what agents may do: through a connected
  /// computer, or straight on the account with their own sign-in.
  var canWriteLimits: Bool { isDirect || canWrite }

  /// Whether this page reads the account server itself.
  static func readsDirect(_ sync: SyncService) -> Bool {
    !sync.cloudSupported || sync.connectionState != .connected
  }

  func reload() async {
    if isFixture { return }
    if Self.readsDirect(syncService) {
      await reloadDirect()
      return
    }
    isDirect = false
    instancesError = nil
    do {
      // The full list: each computer's lane, size, disk parts and last run,
      // and the whole account. An older brain ignores `detail` and sends its
      // summary, which the page shows with fewer facts.
      let list = try await syncService.cloudRead("list", args: ["detail": "full"], as: CloudPhoneList.self)
      now = Date()
      machines = Self.ordered(list.machines, now: now)
      CloudLaneComputerLabels.note(list.machines)
      account = list.account
      if selectedId == nil || machine(selectedId!) == nil { selectedId = machines.first?.instanceId }
      phase = .loaded
    } catch {
      // The computer can't answer for the account: read it directly. With a
      // sign-in, also over a list already shown: the computer that answered
      // before may be the one that just went to sleep, and its old row
      // would keep showing it awake.
      if machines.isEmpty || AccountService.shared.isSignedIn {
        await reloadDirect()
        return
      }
    }
    await readLimitsThroughComputer()
    await reloadSignIns()
  }

  /// A pull to refresh: the page, and each card's own read.
  func refresh() async {
    refreshes += 1
    await reload()
    await loadMoves()
  }

  /// The page's first read, then the moves once (a move started on another device shows).
  func load() async {
    await reload()
    await loadMoves()
  }

  /// The page from the account server, with this phone's own sign-in.
  private func reloadDirect() async {
    isDirect = true
    guard let client = await syncService.cloudServerClient() else {
      phase = .failed("Sign in to ADE to see ADE Cloud.")
      return
    }
    async let accountRead = Self.readDirect("account") { try await client.account() }
    // The computers' read keeps its failure: the lanes card shows the
    // server's sentence then, never "No cloud lanes yet".
    async let instancesRead: Result<[CloudServerInstance], Error> = {
      do { return .success(try await client.instances()) } catch { return .failure(error) }
    }()
    limitsError = nil
    async let limitsRead = client.agentLimits()
    let (account, instancesResult) = await (accountRead, instancesRead)
    let instances = try? instancesResult.get()
    if case .failure(let error) = instancesResult {
      instancesError = cloudPhoneWords(cloudServerFailureMessage(error)) ?? "ADE Cloud couldn't list your computers. Try again in a moment."
      cloudPaneLog.notice("cloud_pane read=instances failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    } else {
      instancesError = nil
    }
    now = Date()
    if let account { self.account = account }
    if let instances {
      let live = instances.filter { !$0.isGone }
      serverInstances = Dictionary(live.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
      let list = live.compactMap(cloudPhoneMachine(from:))
      machines = Self.ordered(list, now: now)
      if selectedId == nil || machine(selectedId!) == nil { selectedId = machines.first?.instanceId }
    }
    if account == nil, instances == nil {
      if machines.isEmpty { phase = .failed("ADE Cloud didn't answer. Check the connection, then try again.") }
    } else {
      phase = .loaded
    }
    do {
      let state = try await limitsRead
      limits = state.phoneLimits
      limitsRevision = state.revision
    } catch CloudServerClient.Failure.noAccess {
      // An older server has no limits route.
      limitsError = "This ADE Cloud server can't show agent limits yet."
    } catch {
      limitsError = cloudServerFailureMessage(error)
      cloudPaneLog.notice("cloud_pane read=limits failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    }
    signIns = nil
  }

  /// The limits through the connected computer. A failed read gives the
  /// card its reason in place of "Reading…".
  private func readLimitsThroughComputer() async {
    limitsError = nil
    do {
      limits = try await syncService.cloudRead("limits", as: CloudPhoneLimits.self)
    } catch {
      limitsError = cloudPhoneWords(error.localizedDescription) ?? "ADE couldn't read the agent limits."
      cloudPaneLog.notice("cloud_pane read=limits failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    }
  }

  /// One direct read of the page; a failure is logged and reads as nil.
  private static func readDirect<T>(_ name: String, _ read: () async throws -> T) async -> T? {
    do {
      return try await read()
    } catch {
      cloudPaneLog.notice("cloud_pane read=\(name, privacy: .public) failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return nil
    }
  }

  /// Lanes first (awake, then the most recent), then computers with no lane.
  static func ordered(_ machines: [CloudPhoneMachine], now: Date) -> [CloudPhoneMachine] {
    machines.sorted { lhs, rhs in
      if lhs.noLane != rhs.noLane { return !lhs.noLane }
      if lhs.isAwake != rhs.isAwake { return lhs.isAwake }
      let left = lhs.lastActiveAtMs ?? 0
      let right = rhs.lastActiveAtMs ?? 0
      if left != right { return left > right }
      return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
    }
  }

  func reloadSignIns() async {
    guard !isFixture else { return }
    guard syncService.supportsRemoteAction("providerLogins.status") else {
      signIns = nil
      return
    }
    signInsRequest += 1
    let request = signInsRequest
    do {
      let status = try await ProviderLoginsPhoneStatus.read(on: syncService)
      guard request == signInsRequest else { return }
      signIns = status
      signInsUnreadable = false
    } catch {
      guard request == signInsRequest else { return }
      signInsUnreadable = signIns == nil
    }
  }

  /// "Share my sign-ins with ADE Cloud": the one switch for all.
  func setSignInsShared(_ on: Bool) async {
    guard !signInsSaving else { return }
    signInsSaving = true
    defer { signInsSaving = false }
    actionError = nil
    signInsRequest += 1
    let request = signInsRequest
    do {
      let status = try await ProviderLoginsPhoneStatus.write("setCloudAll", args: ["on": on], on: syncService)
      if request == signInsRequest { signIns = status }
    } catch {
      actionError = SyncUserFacingError.message(for: error)
      ADEHaptics.error()
    }
  }

  /// One write on a computer; the list reads again after it.
  func run(_ action: String, on machine: CloudPhoneMachine, args: [String: Any] = [:]) async {
    busy.insert(machine.instanceId)
    defer { busy.remove(machine.instanceId) }
    actionError = nil
    do {
      var input = args
      input["machine"] = machine.instanceId
      _ = try await syncService.cloudWrite(action, args: input, as: CloudPhoneAck.self)
      ADEHaptics.success()
    } catch {
      actionError = cloudPhoneWords(error.localizedDescription) ?? "ADE Cloud couldn't do that."
      ADEHaptics.error()
    }
    await reload()
  }

  // MARK: Actions on one computer

  /// The phone can act on a computer: through the connected computer's
  /// `cloud.write`, or with its own sign-in straight on the account server
  /// (no computer of the person's own needed).
  var canManage: Bool { canWrite || AccountService.shared.isSignedIn }

  /// Every action asks the account server with the phone's own sign-in: it
  /// is the account's, the same from any device. Only a phone that isn't
  /// signed in to ADE sends sleep, wake and a no-lane delete through the
  /// connected computer. Through the computer, a sleep of that same computer
  /// never answered: it slept mid-call and the page kept showing it awake.
  private var writesThroughComputer: Bool { !isDirect && canWrite && !AccountService.shared.isSignedIn }

  /// The account server's rows from the last direct read, by id.
  @Published private(set) var serverInstances: [String: CloudServerInstance] = [:]

  /// The account server's row for a computer (its update facts): this page's
  /// last direct read, else the phone's own read of the account's computers.
  func serverInstance(_ instanceId: String) -> CloudServerInstance? {
    serverInstances[instanceId] ?? syncService.cloudServerInstances.first { $0.id == instanceId }
  }

  func sleep(_ machine: CloudPhoneMachine) async {
    if writesThroughComputer { return await run("sleep", on: machine) }
    await act(on: machine) { client in
      try await client.sleep(instanceId: machine.instanceId)
      return nil
    }
  }

  func wake(_ machine: CloudPhoneMachine) async {
    if writesThroughComputer { return await run("wake", on: machine) }
    await act(on: machine) { client in
      try await client.start(instanceId: machine.instanceId)
      return nil
    }
  }

  /// Deletes a computer that holds no lane, and takes it off the account's machines.
  func deleteComputer(_ machine: CloudPhoneMachine) async {
    if writesThroughComputer {
      await run("delete", on: machine)
      if actionError == nil { CloudLaneActions.shared.deleted(instanceId: machine.instanceId) }
      return
    }
    await act(on: machine, title: "Deleted \(machine.displayName)", gone: true) { client in
      guard try await client.deleteInstanceConfirmed(machine.instanceId) else {
        return CloudComputerOutcome(ok: false, message: "ADE Cloud took the delete but hasn't finished it yet. Check again in a minute; if the computer is still there, delete it again.")
      }
      let account = AccountService.shared
      if let key = machine.machineKey,
         let row = account.machines.first(where: { $0.machineKey.caseInsensitiveCompare(key) == .orderedSame }) {
        do {
          try await account.removeMachineFromAccount(row)
        } catch {
          cloudPaneLog.notice("cloud_pane delete account_row=left error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
          return CloudComputerOutcome(ok: true, message: "Deleted on ADE Cloud. ADE couldn't take it off your computers; remove it in Settings › Machines.")
        }
      }
      return CloudComputerOutcome(ok: true, message: "Deleted on ADE Cloud and removed from ADE.")
    }
  }

  /// "Keep the lane, free its computer": the work is pushed, the computer
  /// goes, the lane and its chats stay. It takes minutes.
  func freeComputer(_ machine: CloudPhoneMachine) async {
    let name = machine.displayName
    await act(on: machine, title: "Freed \(name)'s computer", failureTitle: "Kept \(name)'s computer", gone: true) { client in
      await client.freeLane(instanceId: machine.instanceId)
    }
  }

  /// A size of the same kind, now: the computer restarts on it.
  func changeSize(_ machine: CloudPhoneMachine, to tier: CloudPhoneTier) async {
    await act(on: machine, title: "Changing \(machine.displayName) to \(tier.label)") { client in
      await client.changeSize(instanceId: machine.instanceId, to: tier)
    }
  }

  func clearCaches(_ machine: CloudPhoneMachine) async {
    await act(on: machine, title: "Cleared caches on \(machine.displayName)") { client in
      await client.clearCaches(instanceId: machine.instanceId)
    }
  }

  /// "Keep it": the idle cleanup's clock starts again, with no wake.
  func keep(_ machine: CloudPhoneMachine) async {
    await act(on: machine, title: "Kept \(machine.displayName)") { _ in
      if let failure = await AccountCloudStore.shared.keep(instanceId: machine.instanceId, using: syncService) {
        return CloudComputerOutcome(ok: false, message: failure)
      }
      return CloudComputerOutcome(ok: true, message: "ADE won't delete it for not being used. Its idle clock starts again.")
    }
  }

  /// Moves the computer to its channel's newest image; it restarts on it.
  func update(_ machine: CloudPhoneMachine) async {
    await act(on: machine, title: "Updating \(machine.displayName)") { _ in
      if let failure = await AccountCloudStore.shared.updateComputer(instanceId: machine.instanceId, using: syncService) {
        return CloudComputerOutcome(ok: false, message: failure)
      }
      return CloudComputerOutcome(ok: true, message: "It restarts and is back in a few minutes.")
    }
  }

  /// One action on a computer, straight on the account server with the
  /// phone's own sign-in. Its buttons wait meanwhile; a long one (a free
  /// pushes work for minutes) goes on for a while with the app in the
  /// background. It worked: a toast with its sentence (`title`). It didn't:
  /// the server's sentence in `actionError` (and a toast with `failureTitle`).
  /// `gone`: the computer is deleted after it worked, so its pages close and
  /// the phone's own list reads again. The page reads again after.
  private func act(
    on machine: CloudPhoneMachine,
    title: String? = nil,
    failureTitle: String? = nil,
    gone: Bool = false,
    _ body: (CloudServerClient) async throws -> CloudComputerOutcome?
  ) async {
    let instanceId = machine.instanceId
    guard !busy.contains(instanceId) else { return }
    busy.insert(instanceId)
    actionError = nil
    var background = UIBackgroundTaskIdentifier.invalid
    background = UIApplication.shared.beginBackgroundTask(withName: "ade.cloud.computer-action") {
      UIApplication.shared.endBackgroundTask(background)
      background = .invalid
    }
    var worked = false
    if let client = await syncService.cloudServerClient() {
      do {
        let outcome = try await body(client)
        worked = outcome?.ok ?? true
        if let outcome, !outcome.ok {
          // The phone never points at a purchase (App Store rule).
          actionError = cloudPhoneWords(outcome.message) ?? "ADE Cloud couldn't do that."
          if let failureTitle { CloudLaneActions.shared.toast = ADEToastMessage(text: failureTitle, kind: .failure, detail: actionError) }
        } else if let title {
          CloudLaneActions.shared.toast = ADEToastMessage(text: title, detail: outcome.flatMap { cloudPhoneWords($0.message) })
        }
      } catch {
        actionError = cloudPhoneWords(cloudServerFailureMessage(error)) ?? "ADE Cloud couldn't do that."
      }
    } else {
      actionError = "Sign in to ADE, then try again."
    }
    if worked { ADEHaptics.success() } else { ADEHaptics.error() }
    busy.remove(instanceId)
    if worked && gone {
      CloudLaneActions.shared.deleted(instanceId: instanceId)
      await syncService.refreshCloudServerInstances()
    }
    await reload()
    if background != .invalid {
      UIApplication.shared.endBackgroundTask(background)
      background = .invalid
    }
  }

  // MARK: Moves to the other kind

  /// The moves this page shows, by move id: running ones, and failed ones
  /// until the person dismisses them. A finished move leaves once handled.
  @Published private(set) var moves: [String: CloudServerMove] = [:]
  /// The account server is older than the move route: a size of the other
  /// kind says why (a move needs ADE on a computer) and stays off.
  @Published private(set) var movesUnsupported = false
  /// When each move was last read, so two cards following one move read it once.
  private var moveReadAt: [String: Date] = [:]
  /// Each finished move's follow-up (lists read again, its toast), once.
  private var moveEndings: [String: Task<Void, Never>] = [:]
  /// Moves that ended well while this page followed them, by move id, once
  /// their follow-up ran: a computer's page goes on to the new computer.
  @Published private(set) var endedMoves: [String: CloudServerMove] = [:]
  /// Moves whose cancel is on its way (their Cancel waits).
  @Published private(set) var cancellingMoves: Set<String> = []

  /// The moves to show, oldest first.
  var shownMoves: [CloudServerMove] {
    moves.values.sorted { ($0.createdAt ?? 0, $0.moveId) < ($1.createdAt ?? 0, $1.moveId) }
  }

  /// The move this computer is part of (from it or onto it), a running one first.
  func move(for instanceId: String) -> CloudServerMove? {
    let mine = moves.values.filter { $0.involves(instanceId) }
    return mine.first { !$0.isFinished } ?? mine.first
  }

  /// The move that took this computer to a new one and ended well, once the
  /// lists show the new computer.
  func endedMove(from instanceId: String) -> CloudServerMove? {
    endedMoves.values.first { $0.sourceInstanceId == instanceId }
  }

  /// The computer is part of a running move: its other actions wait.
  func isMoving(_ instanceId: String) -> Bool {
    moves.values.contains { !$0.isFinished && $0.involves(instanceId) }
  }

  /// The account's moves, once per open and per pull to refresh. Moves that
  /// ended well or were cancelled aren't news; a failed one shows its reason.
  func loadMoves() async {
    guard !isFixture, AccountService.shared.isSignedIn,
          let client = await syncService.cloudServerClient() else { return }
    do {
      let rows = try await client.moves()
      movesUnsupported = false
      for row in rows {
        if let known = moves[row.moveId] {
          await apply(row, was: known)
        } else if !row.isFinished || row.state == "failed" {
          moves[row.moveId] = row
        }
      }
    } catch CloudServerClient.Failure.noAccess {
      // An older server has no move routes; the POST says so when it's tried.
    } catch {
      cloudPaneLog.notice("cloud_pane read=moves failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    }
  }

  /// Starts the server's move of a computer to `tier`, of the other kind.
  func startMove(_ machine: CloudPhoneMachine, to tier: CloudPhoneTier) async {
    let instanceId = machine.instanceId
    guard !busy.contains(instanceId), !isMoving(instanceId) else { return }
    busy.insert(instanceId)
    defer { busy.remove(instanceId) }
    actionError = nil
    let kind = tier.full ? "a full computer" : "a standard computer"
    guard let client = await syncService.cloudServerClient() else {
      actionError = "Sign in to ADE, then try again."
      ADEHaptics.error()
      return
    }
    do {
      let record = try await client.startMove(instanceId: instanceId, to: tier.full ? "full" : "standard", sizeId: tier.id, moveId: UUID().uuidString.lowercased())
      moves[record.moveId] = record
      moveReadAt[record.moveId] = Date()
      ADEHaptics.success()
      CloudLaneActions.shared.toast = ADEToastMessage(text: "Moving \(machine.displayName) to \(kind)", kind: .info, detail: cloudPhoneWords(record.message))
    } catch CloudServerClient.Failure.noAccess {
      movesUnsupported = true
      actionError = cloudPhoneKindChangeReason(to: tier)
      ADEHaptics.error()
    } catch {
      let why = cloudPhoneWords(cloudServerFailureMessage(error)) ?? "ADE Cloud couldn't start the move."
      actionError = why
      ADEHaptics.error()
      CloudLaneActions.shared.toast = ADEToastMessage(text: "Couldn't move \(machine.displayName)", kind: .failure, detail: why)
    }
  }

  /// Cancels a move before its copy starts; the server's answer shows next.
  func cancelMove(_ move: CloudServerMove) async {
    guard !cancellingMoves.contains(move.moveId) else { return }
    cancellingMoves.insert(move.moveId)
    defer { cancellingMoves.remove(move.moveId) }
    guard let client = await syncService.cloudServerClient() else {
      actionError = "Sign in to ADE, then try again."
      return
    }
    do {
      try await client.cancelMove(move.moveId)
      ADEHaptics.success()
      if let fresh = try? await client.move(move.moveId) {
        await apply(fresh, was: moves[move.moveId])
      } else {
        moves[move.moveId] = nil
        CloudLaneActions.shared.toast = ADEToastMessage(text: "Cancelled the move", detail: "\(move.sourceName ?? "The computer") stays as it was.")
      }
    } catch {
      ADEHaptics.error()
      CloudLaneActions.shared.toast = ADEToastMessage(text: "Couldn't cancel the move", kind: .failure, detail: cloudPhoneWords(cloudServerFailureMessage(error)))
    }
  }

  /// A failed move the person has read.
  func dismissMove(_ moveId: String) {
    guard moves[moveId]?.isFinished == true else { return }
    moves[moveId] = nil
  }

  /// Follows one running move while a screen showing it is on screen: a
  /// read every 5 s, none once it ends or the screen's task is cancelled.
  /// Two screens following one move read it once.
  func followMove(_ moveId: String) async {
    while !Task.isCancelled {
      guard let current = moves[moveId], !current.isFinished else { return }
      try? await Task.sleep(for: .seconds(5))
      if Task.isCancelled { return }
      if let last = moveReadAt[moveId], Date().timeIntervalSince(last) < 4 { continue }
      moveReadAt[moveId] = Date()
      guard let client = await syncService.cloudServerClient() else { continue }
      do {
        let fresh = try await client.move(moveId)
        await apply(fresh, was: moves[moveId])
      } catch CloudServerClient.Failure.noAccess {
        // The server keeps it no more.
        moves[moveId] = nil
        return
      } catch {
        // A read that didn't answer: the next round reads again.
      }
    }
  }

  /// A newer read of a move. The step to finished runs its follow-up once:
  /// done reads the computers and the account's machines again and says
  /// "Moved"; failed keeps the move to show its reason; cancelled leaves.
  private func apply(_ fresh: CloudServerMove, was: CloudServerMove?) async {
    moves[fresh.moveId] = fresh
    guard fresh.isFinished, was?.isFinished != true, moveEndings[fresh.moveId] == nil else {
      await moveEndings[fresh.moveId]?.value
      return
    }
    let ending = Task { @MainActor [weak self] in
      guard let self else { return }
      let name = fresh.sourceName ?? "The computer"
      switch fresh.state {
      case "done":
        await self.syncService.refreshCloudServerInstances()
        await AccountService.shared.loadMachines()
        await self.reload()
        ADEHaptics.success()
        CloudLaneActions.shared.toast = ADEToastMessage(
          text: "Moved",
          detail: fresh.sourceDeleted == false
            ? "\(name) is on \(fresh.kindWords) now. ADE couldn't delete the old computer; delete it from its page."
            : "\(name) is on \(fresh.kindWords) now. Its lane and chats came along."
        )
      case "failed":
        ADEHaptics.error()
        CloudLaneActions.shared.toast = ADEToastMessage(text: "Couldn't move \(name)", kind: .failure, detail: cloudPhoneWords(fresh.error ?? fresh.message))
        await self.reload()
      default:
        CloudLaneActions.shared.toast = ADEToastMessage(text: "Cancelled the move", detail: cloudPhoneWords(fresh.message))
        await self.reload()
      }
    }
    moveEndings[fresh.moveId] = ending
    await ending.value
    if fresh.state == "done" { endedMoves[fresh.moveId] = fresh }
    if fresh.state != "failed" { moves[fresh.moveId] = nil }
  }

  func setLimits(_ args: [String: Any]) async {
    actionError = nil
    if isDirect {
      await setLimitsDirect(args)
      return
    }
    do {
      limits = nil
      _ = try await syncService.cloudWrite("set_limits", args: args, as: CloudPhoneAck.self)
    } catch {
      actionError = cloudPhoneWords(error.localizedDescription) ?? "ADE Cloud couldn't do that."
    }
    await readLimitsThroughComputer()
  }

  /// One limits write on the account. A preset sends its whole set of
  /// limits. Another device's newer write wins: the page reads it again and
  /// says so.
  private func setLimitsDirect(_ args: [String: Any]) async {
    var changes = args
    if let preset = changes.removeValue(forKey: "preset") as? String, let values = CloudAgentLimitsState.presets[preset] {
      changes["unattendedSpend"] = values.unattendedSpend
      changes["machinesPerDay"] = values.machinesPerDay
      changes["maxShape"] = values.maxShape
      changes["extraDiskMonthCents"] = values.extraDiskMonthCents ?? NSNull()
    }
    guard let client = await syncService.cloudServerClient() else {
      actionError = "Sign in to ADE again, then try again."
      return
    }
    do {
      let state = try await client.setAgentLimits(changes, ifRevision: limitsRevision)
      limits = state.phoneLimits
      limitsRevision = state.revision
      ADEHaptics.success()
    } catch CloudServerClient.Failure.refused(let code, _) where code == "limits_changed" {
      actionError = "These limits changed on another device. Check them, then try again."
      if let state = try? await client.agentLimits() {
        limits = state.phoneLimits
        limitsRevision = state.revision
      }
    } catch {
      actionError = cloudServerFailureMessage(error)
      ADEHaptics.error()
    }
  }
}

/// A computer as the dashboard draws it, from the account server's row.
/// Nil for a row with no id.
/// The account server's computer status in the brain list's words
/// (`computerStateOf` on the server): "sleeping" read as "Needs a look".
func cloudPhoneMachineState(serverStatus status: String) -> String {
  switch status {
  case "running", "restarting": return "running"
  case "sleeping": return "asleep"
  case "waking", "provisioning", "updating": return "starting"
  default: return status
  }
}

func cloudPhoneMachine(from instance: CloudServerInstance) -> CloudPhoneMachine? {
  var object: [String: Any] = [
    "instanceId": instance.id,
    // A computer saving its work for the idle cleanup is on its way down.
    "state": instance.idleSaving ? "stopping" : cloudPhoneMachineState(serverStatus: instance.status),
  ]
  if let name = instance.name { object["name"] = name }
  if let machineKey = instance.machineKey { object["machineKey"] = machineKey }
  if let laneId = instance.laneId {
    var lane: [String: Any] = ["laneId": laneId, "laneName": instance.laneName ?? "Cloud lane"]
    if let origin = instance.projectOrigin { lane["projectOrigin"] = origin }
    object["lane"] = lane
  }
  object["pastDue"] = instance.pastDue
  // Its size, disk and last run: the computer page's facts, sizes and disk parts.
  if let type = instance.type { object["type"] = type }
  if let resources = instance.resources {
    object["resources"] = ["cpu": resources.cpu, "memoryGb": resources.memory, "diskGb": resources.disk]
  }
  if let lastActiveAt = instance.lastActiveAt { object["lastActiveAtMs"] = lastActiveAt }
  // The server's `created` is in seconds.
  if let created = instance.created { object["createdAtMs"] = created * 1000 }
  if let usage = instance.diskUsage,
     let data = try? JSONEncoder().encode(usage),
     let json = try? JSONSerialization.jsonObject(with: data) {
    object["diskUsage"] = json
  }
  // "Safe to delete" and the delete's warning read it.
  if let work = instance.laneWork {
    object["laneWork"] = ["unpushed": work.unpushed as Any? ?? NSNull(), "prState": work.prState as Any? ?? NSNull()]
  }
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
  return try? JSONDecoder().decode(CloudPhoneMachine.self, from: data)
}
