import SwiftUI
import UIKit

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
/// (`CloudSettingsPage`). Every read and write goes to the machine the phone
/// is connected to (`cloud.read` / `cloud.write`); the account's ADE Cloud is
/// the same from any of the person's machines.
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
            .navigationDestination(for: CloudPhoneMachine.self) { machine in
              CloudMachineScreen(store: store, instanceId: machine.instanceId)
            }
        }
      }
    }
    .task { await store.reload() }
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
          CloudMachineScreen(store: store, instanceId: id)
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
      .navigationDestination(for: CloudPhoneMachine.self) { machine in
        CloudMachineScreen(store: store, instanceId: machine.instanceId)
      }
      .task { await store.reload() }
  }
}

// MARK: - Store

@MainActor
final class CloudPaneStore: ObservableObject {
  enum Phase: Equatable { case loading, loaded, failed(String) }

  @Published private(set) var phase: Phase = .loading
  @Published private(set) var machines: [CloudPhoneMachine] = []
  @Published private(set) var account: CloudPhoneAccount?
  @Published private(set) var limits: CloudPhoneLimits?
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

  let syncService: SyncService

  /// Fixture screens (`-adePreviewScreen duo-cloud…`) hold their data and read nothing.
  private var isFixture = false

  init(syncService: SyncService) {
    self.syncService = syncService
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

  func reload() async {
    if isFixture { return }
    do {
      // The full list: each computer's lane, size, disk parts and last run,
      // and the whole account. An older brain ignores `detail` and sends its
      // summary, which the page shows with fewer facts.
      let list = try await syncService.cloudRead("list", args: ["detail": "full"], as: CloudPhoneList.self)
      now = Date()
      machines = Self.ordered(list.machines, now: now)
      account = list.account
      if selectedId == nil || machine(selectedId!) == nil { selectedId = machines.first?.instanceId }
      phase = .loaded
    } catch {
      let message = error.localizedDescription
      if machines.isEmpty { phase = .failed(message) }
    }
    limits = try? await syncService.cloudRead("limits", as: CloudPhoneLimits.self)
    await reloadSignIns()
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
    do {
      signIns = try await ProviderLoginsPhoneStatus.read(on: syncService)
      signInsUnreadable = false
    } catch {
      signInsUnreadable = signIns == nil
    }
  }

  /// "Share my sign-ins with ADE Cloud": the one switch for all.
  func setSignInsShared(_ on: Bool) async {
    guard !signInsSaving else { return }
    signInsSaving = true
    defer { signInsSaving = false }
    actionError = nil
    do {
      signIns = try await ProviderLoginsPhoneStatus.write("setCloudAll", args: ["on": on], on: syncService)
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
      actionError = error.localizedDescription
      ADEHaptics.error()
    }
    await reload()
  }

  func setLimits(_ args: [String: Any]) async {
    actionError = nil
    do {
      limits = nil
      _ = try await syncService.cloudWrite("set_limits", args: args, as: CloudPhoneAck.self)
    } catch {
      actionError = error.localizedDescription
    }
    limits = try? await syncService.cloudRead("limits", as: CloudPhoneLimits.self)
  }
}
