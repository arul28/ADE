import SwiftUI

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
/// no price and links to no checkout. The plans card says what each plan
/// includes and where plans change.
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

// MARK: - The page

struct CloudDashboardScreen: View {
  @ObservedObject var store: CloudPaneStore
  /// Close, for the sheet; nil inside Settings, whose stack has its own.
  var onClose: (() -> Void)?
  /// True on a phone: a row pushes the computer. False in the book layout: a row selects it.
  var pushes: Bool

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        switch store.phase {
        case .loading where store.machines.isEmpty && store.account == nil:
          ProgressView()
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
        case .failed(let message):
          ADESettingsNotice(message: "Couldn't read ADE Cloud. \(message)", actionTitle: "Try again") {
            Task { await store.reload() }
          }
        default:
          CloudHero(store: store)
          CloudNotices(store: store)
          CloudLanesCard(store: store, pushes: pushes)
          if let account = store.account, account.catalog != nil {
            CloudPlansCard(account: account)
            CloudSizesCard(account: account, tiers: store.tiers)
          }
          CloudSignInsCard(store: store)
          CloudAgentsCard(store: store)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 36)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .refreshable { await store.reload() }
    .navigationTitle("ADE Cloud")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let onClose {
        ToolbarItem(placement: .topBarLeading) {
          Button { onClose() } label: { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)) }
            .accessibilityLabel("Close ADE Cloud")
        }
      }
    }
  }
}

// MARK: Hero

/// The top block: the plan, the hours, disk and computers. The numbers are
/// said once on the page; nothing below repeats them.
struct CloudHero: View {
  @ObservedObject var store: CloudPaneStore

  var body: some View {
    if let account = store.account {
      VStack(alignment: .leading, spacing: 14) {
        HStack(spacing: 10) {
          ADEBrandTile(brand: .cloud, size: 28)
          VStack(alignment: .leading, spacing: 1) {
            Text(cloudPlanName(account))
              .font(.system(size: 16, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("ADE Cloud")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textMuted)
          }
          Spacer(minLength: 0)
        }
        hours(account)
        HStack(alignment: .top, spacing: 10) {
          if let disk = account.disk {
            CloudMiniMeter(
              label: "Disk",
              value: cloudGb(disk.usedGb),
              of: disk.limitGb.map { "of \(cloudGb($0))" },
              fraction: disk.limitGb.map { $0 > 0 ? disk.usedGb / $0 : 0 } ?? 0,
              note: "All your computers together"
            )
          }
          if let computers = account.computers {
            CloudMiniMeter(
              label: "Computers",
              value: "\(computers.total)",
              of: "of \(computers.limit)",
              fraction: computers.limit > 0 ? Double(computers.total) / Double(computers.limit) : 0,
              note: "\(computers.awake) awake now"
            )
          }
        }
      }
      .adeKitCard()
    }
  }

  private func hours(_ account: CloudPhoneAccount) -> some View {
    let hours = account.hours
    let percentLeft = hours.includedMilli > 0 ? Double(hours.leftMilli) / Double(hours.includedMilli) * 100 : 0
    let resets: String? = account.billing.map { billing in
      billing.cancelAtPeriodEnd == true ? "plan ends \(cloudDate(billing.periodEnd))" : "resets \(cloudDate(billing.periodEnd))"
    }
    return VStack(alignment: .leading, spacing: 6) {
      ADEEyebrow("Hours left this month")
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(cloudHours(hours.leftMilli))
          .font(.system(size: 30, weight: .medium, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
        Text(["of \(cloudHours(hours.includedMilli)) h", resets].compactMap { $0 }.joined(separator: ", "))
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
      }
      .accessibilityElement(children: .combine)
      ADEKitMeter(
        fraction: percentLeft / 100,
        color: ADEUsagePressure.color(percentLeft: percentLeft, fallback: ADEColor.accent),
        height: 5
      )
      VStack(alignment: .leading, spacing: 3) {
        ForEach(cloudHoursNotes(account, now: store.now), id: \.self) { line in
          Text(line)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.top, 2)
    }
  }
}

/// The lines under the hours, in the desktop's order: why the free plan has
/// no hours here, earned hours, extra hours, and the forecast.
func cloudHoursNotes(_ account: CloudPhoneAccount, now: Date) -> [String] {
  var lines: [String] = []
  if let free = account.freePlan, free.state == "refused" {
    // The server's sentence names the paid plan; the phone says only why.
    lines.append("This computer already used another account's free hours, so the free plan has no hours here.")
  }
  if let earned = account.earnedHours, earned.leftMilli > 0 {
    lines.append("+\(cloudHours(earned.leftMilli)) hours earned from invites. They never expire.")
  }
  if let extra = account.extraHours, extra.available {
    if extra.enabled {
      let used = extra.usedMilli ?? 0
      lines.append(used > 0 ? "Extra hours are on: \(cloudHours(used)) h used this month." : "Extra hours are on.")
    } else {
      lines.append("Extra hours are off. Work stops when your hours run out.")
    }
  }
  if let forecast = cloudHoursForecast(account, now: now) {
    lines.append("\(forecast) (estimate)")
  }
  return lines
}

/// "At this pace your hours last until Nov 24", from the last days' use; nil
/// when the server doesn't say or nothing was used (`hoursForecast`).
func cloudHoursForecast(_ account: CloudPhoneAccount, now: Date) -> String? {
  guard let recent = account.recentUse, recent.days > 0, recent.usedMilli > 0,
        let periodEnd = account.billing?.periodEnd else { return nil }
  let left = Double(account.hours.leftMilli)
  guard left > 0 else { return nil }
  let perDay = recent.usedMilli / recent.days
  let endsAt = now.timeIntervalSince1970 * 1000 + (left / perDay) * 86_400_000
  if endsAt >= periodEnd { return "At this pace your hours last until they reset" }
  return "At this pace your hours last until \(cloudDate(endsAt))"
}

struct CloudMiniMeter: View {
  let label: String
  let value: String
  let of: String?
  let fraction: Double
  let note: String

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      ADEEyebrow(label)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(value)
          .font(.system(size: 17, weight: .medium, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
        if let of {
          Text(of).font(.system(size: 12)).foregroundStyle(ADEColor.textMuted)
        }
      }
      ADEKitMeter(
        fraction: fraction,
        color: ADEUsagePressure.color(percentLeft: (1 - min(1, fraction)) * 100, fallback: ADEKit.fill)
      )
      Text(note)
        .font(.system(size: 11.5))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(2)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEKit.track.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

// MARK: Notices

/// Out of hours, a failed payment, a full disk, what a cheaper plan will
/// free, cancelled timed wakes, and the last action's failure.
struct CloudNotices: View {
  @ObservedObject var store: CloudPaneStore

  var body: some View {
    VStack(spacing: 8) {
      if let account = store.account {
        if account.billing?.notice == "past_due" {
          ADESettingsNotice(message: "A payment didn't go through, so your plan follows the free plan's limits until it's paid.", tone: .crit)
        } else if account.outOfHours {
          ADESettingsNotice(message: "You're out of hours. Your computers wait until your hours reset. Running work saves and stops.", tone: .warn)
        }
        if let disk = account.disk, let limit = disk.limitGb, limit > 0, disk.usedGb / limit >= 0.8 {
          ADESettingsNotice(message: "Your disk is \(Int((disk.usedGb / limit * 100).rounded()))% full. Free some space in the ADE desktop app before your lanes need more.", tone: .warn)
        }
        if let sentence = account.planCleanup?.sentence {
          ADESettingsNotice(message: sentence, tone: .warn)
        }
        if let sentence = account.timedWakesCancelled?.sentence {
          ADESettingsNotice(message: sentence, tone: .warn)
        }
      }
      if let error = store.actionError {
        ADESettingsNotice(message: error, tone: .crit, dismiss: { store.actionError = nil })
      }
    }
  }
}

// MARK: Lanes and computers

struct CloudLanesCard: View {
  @ObservedObject var store: CloudPaneStore
  var pushes: Bool

  private var hint: String? {
    guard let computers = store.account?.computers else { return nil }
    return "\(computers.total) of \(computers.limit) computers · \(computers.awake) awake"
  }

  var body: some View {
    ADEKitCard(title: "Lanes and computers", symbol: "desktopcomputer", count: "\(store.machines.count)", hint: hint, flush: true) {
      if store.machines.isEmpty {
        Text("No cloud lanes yet. Pick ADE Cloud under Run on when you send a message: ADE makes a computer for the lane, and it shows here.")
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, ADEKit.inset)
          .padding(.bottom, ADEKit.inset)
      } else {
        VStack(spacing: 0) {
          ForEach(Array(store.machines.enumerated()), id: \.element.id) { index, machine in
            if index > 0 { ADESettingsHairline() }
            row(machine)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func row(_ machine: CloudPhoneMachine) -> some View {
    let rowView = CloudMachineRow(
      machine: machine,
      tier: cloudPhoneTier(of: machine, in: store.tiers),
      now: store.now,
      busy: store.busy.contains(machine.instanceId)
    )
    if pushes {
      NavigationLink(value: machine) { rowView }
        .buttonStyle(ADEKitRowButtonStyle())
    } else {
      Button {
        ADEHaptics.light()
        store.selectedId = machine.instanceId
      } label: { rowView }
        .buttonStyle(ADEKitRowButtonStyle())
        .background(store.selected?.instanceId == machine.instanceId ? ADEColor.accent.opacity(0.12) : Color.clear)
    }
  }
}

struct CloudMachineRow: View {
  let machine: CloudPhoneMachine
  let tier: CloudPhoneTier?
  let now: Date
  var busy = false

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: tier?.symbol ?? "cloud")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 28, height: 28)
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(machine.displayName)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if let mark = cloudMachineMark(machine, now: now) {
            ADEKitTag(text: mark.text, tone: mark.tone)
          }
        }
        Text(cloudMachineLine(machine, tier: tier, now: now))
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
      .layoutPriority(1)
      Spacer(minLength: 8)
      if busy {
        ProgressView()
      } else {
        HStack(spacing: 5) {
          ADEKitDot(tone: cloudStateTone(machine))
          Text(machine.stateLabel)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

/// One mark at most, so the name keeps its room: no lane, then unused, then safe to delete.
func cloudMachineMark(_ machine: CloudPhoneMachine, now: Date) -> (text: String, tone: ADEKitTone)? {
  if machine.noLane { return ("No lane", .neutral) }
  if cloudMachineOld(machine, now: now) { return ("Unused", .warn) }
  if machine.laneWork?.prState == "merged", machine.laneWork?.unpushed == false { return ("Safe to delete", .ok) }
  return nil
}

/// Not used for 14 days (or, never used, made 14 days ago).
func cloudMachineOld(_ machine: CloudPhoneMachine, now: Date) -> Bool {
  let nowMs = now.timeIntervalSince1970 * 1000
  let fourteenDays: Double = 14 * 86_400_000
  if let last = machine.lastActiveAtMs { return nowMs - last >= fourteenDays }
  if let made = machine.createdAtMs { return nowMs - made >= fourteenDays }
  return false
}

/// "Small · 1× hours · 3.4 GB · Ran 3 h ago".
func cloudMachineLine(_ machine: CloudPhoneMachine, tier: CloudPhoneTier?, now: Date) -> String {
  let size = tier.map { "\($0.label) · \(cloudHoursRate($0.rate))" } ?? machine.size ?? machine.hoursRate.map(cloudHoursRate)
  let disk = machine.resources.map { cloudGb($0.diskGb) }
  return [size, disk, cloudLastRun(machine, now: now)].compactMap { $0 }.joined(separator: " · ")
}

func cloudLastRun(_ machine: CloudPhoneMachine, now: Date) -> String {
  if machine.isAwake { return "Running now" }
  guard let last = machine.lastActiveAtMs else { return machine.resources == nil ? "" : "Not used yet" }
  return "Ran \(cloudAgo(last, now: now))"
}

func cloudStateTone(_ machine: CloudPhoneMachine) -> ADEKitTone {
  if machine.isAwake { return .ok }
  if machine.isMoving { return .warn }
  if machine.isAsleep { return .neutral }
  return .crit
}

// MARK: Plans

/// The plans side by side: what each includes, the current one marked. No
/// price and no button: the iPhone app does not sell or change plans.
struct CloudPlansCard: View {
  let account: CloudPhoneAccount

  private struct Column: Identifiable {
    let id: String
    let label: String
    let facts: CloudPhoneAccount.PlanFacts
  }

  private var columns: [Column] {
    guard let plans = account.catalog?.plans else { return [] }
    var out: [Column] = [
      Column(id: "free", label: "Free", facts: plans.free),
      Column(id: "plus", label: "Plus", facts: plans.plus ?? plans.paid),
    ]
    if let pro = plans.pro { out.append(Column(id: "pro", label: "Pro", facts: pro)) }
    return out
  }

  private var statusLine: String? {
    guard let billing = account.billing else { return nil }
    if billing.cancelAtPeriodEnd == true { return "Your plan ends \(cloudDate(billing.periodEnd)). You're on Free after that." }
    if let next = billing.nextPlanId, next != account.currentPlanId { return "You move to \(cloudPlanLabel(next)) on \(cloudDate(billing.periodEnd))." }
    if account.plan == "paid" { return "Renews \(cloudDate(billing.periodEnd))." }
    return nil
  }

  var body: some View {
    ADEKitCard(title: "Plans", symbol: "square.stack.3d.up", hint: statusLine) {
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .top, spacing: 8) {
          ForEach(columns) { column in
            planColumn(column)
          }
        }
        Text("An hour is one hour of a Small computer while it's awake; bigger sizes use hours faster. Disk and computers count what you have at one time, across all your computers.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Image(systemName: "desktopcomputer")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
          Text("Change your plan in the ADE desktop app.")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
    }
  }

  private func planColumn(_ column: Column) -> some View {
    let current = column.id == account.currentPlanId
    let next = account.billing?.nextPlanId == column.id && !current
    let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
    return VStack(alignment: .leading, spacing: 8) {
      VStack(alignment: .leading, spacing: 4) {
        Text(column.label)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if current {
          ADEKitTag(text: "Your plan", tone: .accent)
        } else if next, let end = account.billing?.periodEnd {
          ADEKitTag(text: "From \(cloudDate(end))", tone: .neutral, keepsCase: true)
        } else {
          Color.clear.frame(height: 18)
        }
      }
      fact(Int(Double(column.facts.includedMilli) / 1000).formatted(), "hours a month")
      fact(cloudGb(column.facts.diskGb), "disk in all")
      fact("\(column.facts.computerLimit)", column.facts.computerLimit == 1 ? "computer at a time" : "computers at a time")
      Text(column.id == "free" ? "Work stops until the next month" : "Extra hours, if you turn them on")
        .font(.system(size: 11.5))
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .topLeading)
    .background(current ? ADEColor.accent.opacity(0.08) : Color.clear, in: shape)
    .overlay(shape.strokeBorder(current ? ADEColor.accent.opacity(0.45) : ADEKit.edge, lineWidth: current ? 1 : 0.75))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(column.label)\(current ? ", your plan" : ""): \(Int(Double(column.facts.includedMilli) / 1000)) hours a month, \(cloudGb(column.facts.diskGb)) disk, \(column.facts.computerLimit) computers")
  }

  private func fact(_ value: String, _ unit: String) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(value)
        .font(.system(size: 15, weight: .medium, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
      Text(unit)
        .font(.system(size: 11))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(2)
    }
  }
}

// MARK: Sizes

/// The four sizes (`cloudTierFacts`): CPU, memory, how far the disk can grow,
/// what each runs, how fast it uses hours, and how long the hours left last.
struct CloudSizesCard: View {
  let account: CloudPhoneAccount
  let tiers: [CloudPhoneTier]

  private var leftMilli: Int { account.hours.leftMilli + max(0, account.earnedHours?.leftMilli ?? 0) }

  var body: some View {
    if !tiers.isEmpty {
      ADEKitCard(title: "Sizes", symbol: "cpu", hint: "Each lane picks its size when it starts.", flush: true) {
        VStack(spacing: 0) {
          ForEach(Array(tiers.enumerated()), id: \.element.id) { index, tier in
            if index > 0 { ADESettingsHairline() }
            row(tier)
          }
        }
      }
    }
  }

  private func row(_ tier: CloudPhoneTier) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: tier.symbol)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 28, height: 28)
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(tier.label)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
          if tier.full { ADEKitTag(text: "Full computer") }
          Spacer(minLength: 4)
          Text("\(tier.rate.formatted(.number.precision(.fractionLength(0...1))))×")
            .font(.system(size: 14, weight: .medium, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
        }
        Text(tier.specs.joined(separator: " · "))
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
        Text(tier.runs)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
        Text("\(tier.rateLine). Your hours last \(tier.hoursLeftLabel(leftMilli)) here.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}

// MARK: Agents

struct CloudAgentsCard: View {
  @ObservedObject var store: CloudPaneStore

  var body: some View {
    ADEKitCard(title: "What agents may do alone", symbol: "shield.lefthalf.filled", flush: true) {
      NavigationLink {
        CloudLimitsScreen(store: store)
      } label: {
        ADESettingsRow(
          title: store.limits.map(cloudLimitsPresetName) ?? "…",
          hint: store.limits.map(cloudLimitsSummary) ?? "Reading…"
        ) {
          ADESettingsChevron()
        }
      }
      .buttonStyle(ADEKitRowButtonStyle())
    }
  }
}

// MARK: - One computer

struct CloudMachineScreen: View {
  @ObservedObject var store: CloudPaneStore
  let instanceId: String

  var body: some View {
    ScrollView {
      if let machine = store.machine(instanceId) {
        VStack(alignment: .leading, spacing: 16) {
          CloudMachineFacts(store: store, machine: machine)
          CloudDiskParts(machine: machine, now: store.now)
          CloudMachineControls(store: store, machine: machine)
        }
        .padding(16)
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
        if let mark = cloudMachineMark(machine, now: store.now) {
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
      if let full = machine.diskFull {
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

/// What the phone can do with a computer: open its work, sleep or wake it,
/// and delete a computer that holds no lane. A lane's size, freeing its
/// computer and deleting the lane run the desktop's lane steps (its work is
/// pushed first), so they stay in the ADE desktop app.
struct CloudMachineControls: View {
  @ObservedObject var store: CloudPaneStore
  let machine: CloudPhoneMachine
  @State private var confirmDelete = false

  private var busy: Bool { store.busy.contains(machine.instanceId) || machine.isMoving }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ADEEyebrow("Actions")
      CloudFlowRow {
        if let key = machine.machineKey {
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
      }
      Text(machine.noLane
        ? "Deleting it removes everything on its disk for good."
        : "Change its size, free its computer or delete the lane in the ADE desktop app: ADE pushes the lane's work first.")
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

// MARK: - What agents may do

struct CloudLimitsScreen: View {
  @ObservedObject var store: CloudPaneStore

  private let presets: [(id: String, name: String, line: String, symbol: String)] = [
    ("ask", "Ask me", "Nothing costs money without your yes.", "checkmark.shield"),
    ("balanced", "Balanced", "Agents get what they need, within limits.", "scalemass"),
    ("hands_off", "Hands-off", "For big runs: many computers at once.", "airplane.departure"),
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
          .disabled(!store.canWrite)
        }
      } header: { CloudSectionLabel("Choose") } footer: {
        if store.limits?.preset == "custom" { Text("Custom: your own limits below.") }
      }
      if let limits = store.limits {
        Section {
          Toggle("Unattended agents may spend", isOn: Binding(
            get: { limits.unattendedSpend },
            set: { value in Task { await store.setLimits(["unattendedSpend": value]) } }
          ))
          .disabled(!store.canWrite)
          Picker("New computers a day", selection: Binding(
            get: { limits.machinesPerDay },
            set: { value in Task { await store.setLimits(["machinesPerDay": value]) } }
          )) {
            ForEach([1, 3, 5, 10], id: \.self) { Text("\($0)").tag($0) }
          }
          .disabled(!limits.unattendedSpend || !store.canWrite)
          Picker("Largest size", selection: Binding(
            get: { limits.maxShape },
            set: { value in Task { await store.setLimits(["maxShape": value]) } }
          )) {
            ForEach(cloudShapes, id: \.id) { Text($0.label).tag($0.id) }
          }
          .disabled(!limits.unattendedSpend || !store.canWrite)
        } header: { CloudSectionLabel("Limits") }
      } else {
        Section { ProgressView().frame(maxWidth: .infinity) }
      }
      Section {
        Label("Always yours to decide: keeping a computer awake for good, raising these limits, and deleting a computer an agent didn't make.", systemImage: "lock.fill")
          .font(.caption).foregroundStyle(ADEColor.textSecondary)
      }
      .listRowBackground(Color.clear)
      if let error = store.actionError {
        Section { ADESettingsNotice(message: "That didn't save. \(error)", tone: .crit) }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle("What agents may do")
    .navigationBarTitleDisplayMode(.inline)
  }
}

// MARK: - Small pieces

struct CloudSectionLabel: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text.uppercased()).font(.caption2.weight(.semibold)).tracking(0.6).foregroundStyle(ADEColor.textMuted)
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

// MARK: - Sizes and words

/// One of the four lane sizes (`shared/cloudTiers.ts`), from the server's
/// catalog: its rate is the catalog's, never a number here.
struct CloudPhoneTier: Identifiable, Equatable {
  let id: String
  let label: String
  /// `default` (a standard computer) or `vm` (a full one).
  let type: String
  let cpu: Int
  let memoryGb: Double
  let multiplierMilli: Int
  let diskMaxGb: Double?

  var rate: Double { Double(multiplierMilli) / 1000 }
  var full: Bool { type == "vm" }

  var symbol: String {
    switch id {
    case "small": return "square"
    case "medium": return "square.split.2x1"
    case "large": return "square.grid.2x2"
    default: return "square.grid.3x3"
    }
  }

  /// "2 CPU", "4 GB memory", "Up to 12 GB disk" (the disk only when the server says).
  var specs: [String] {
    ["\(cpu) CPU", "\(cloudGbText(memoryGb)) GB memory"] + (diskMaxGb.map { ["Up to \(cloudGbText($0)) GB disk"] } ?? [])
  }

  var runs: String {
    switch id {
    case "small": return "Agents, builds and tests"
    case "medium": return "Bigger builds and test suites"
    case "large": return "Docker and the Android emulator"
    default: return "Docker, Android and heavy builds"
    }
  }

  /// "1 hour of work uses 5 hours".
  var rateLine: String {
    let value = rate.formatted(.number.precision(.fractionLength(0...1)))
    return "1 hour of work uses \(value) hour\(rate == 1 ? "" : "s")"
  }

  /// How long `leftMilli` hours last at this size, rounded down to a tenth: "57.4 h".
  func hoursLeftLabel(_ leftMilli: Int) -> String {
    let hours = Double(max(0, leftMilli)) / Double(max(1, multiplierMilli))
    let shown = hours >= 100 ? String(Int(hours)) : String(Double(Int(hours * 10)) / 10)
    return "\(shown) h"
  }
}

private let cloudTierOrder: [(id: String, label: String, type: String, cpu: Int, memoryGb: Double)] = [
  ("small", "Small", "default", 2, 4),
  ("medium", "Medium", "default", 4, 8),
  ("large", "Large", "vm", 4, 8),
  ("xlarge", "X-Large", "vm", 4, 16),
]

/// The sizes this catalog offers, Small first. A size the catalog has none
/// for is left out. A catalog that names no tiers (an older server) is
/// matched by shape, as the desktop does.
func cloudPhoneTiers(_ catalog: CloudPhoneAccount.Catalog?) -> [CloudPhoneTier] {
  guard let sizes = catalog?.sizes, !sizes.isEmpty else { return [] }
  let named = sizes.contains { size in cloudTierOrder.contains { $0.id == size.tier } }
  return cloudTierOrder.compactMap { entry in
    let size = named
      ? sizes.first { $0.tier == entry.id }
      : sizes.first { $0.type == entry.type && $0.cpu == entry.cpu && $0.memoryGb == entry.memoryGb }
    guard let size else { return nil }
    let label = size.label?.trimmingCharacters(in: .whitespacesAndNewlines)
    return CloudPhoneTier(
      id: entry.id,
      label: label?.isEmpty == false ? label! : entry.label,
      type: size.type,
      cpu: size.cpu,
      memoryGb: size.memoryGb,
      multiplierMilli: size.multiplierMilli,
      diskMaxGb: size.diskMaxGb
    )
  }
}

/// The size a computer runs at, from its CPU and memory; nil without them.
func cloudPhoneTier(of machine: CloudPhoneMachine, in tiers: [CloudPhoneTier]) -> CloudPhoneTier? {
  guard let resources = machine.resources, machine.type != "performance" else { return nil }
  let type = machine.isVM ? "vm" : "default"
  return tiers.first { $0.type == type && $0.cpu == resources.cpu && $0.memoryGb == resources.memoryGb }
}

struct CloudShapeOption {
  let id: String
  let label: String
}

/// The shapes `set_limits`'s largest size takes (`CLOUD_SHAPES`).
let cloudShapes: [CloudShapeOption] = [
  .init(id: "2x4", label: "2 vCPU · 4 GB"),
  .init(id: "4x8", label: "4 vCPU · 8 GB"),
  .init(id: "4x16", label: "4 vCPU · 16 GB"),
  .init(id: "4x32", label: "4 vCPU · 32 GB"),
]

func cloudShapeLabel(_ id: String) -> String {
  cloudShapes.first { $0.id == id }?.label ?? id
}

func cloudPlanLabel(_ id: String) -> String {
  switch id {
  case "free": return "Free"
  case "pro": return "Pro"
  default: return "Plus"
  }
}

/// "Free plan", "Plus plan", "Pro plan" (`planName`).
func cloudPlanName(_ account: CloudPhoneAccount) -> String {
  "\(cloudPlanLabel(account.currentPlanId)) plan"
}

/// Hours from thousandths, as the desktop writes them: "118", "42.5".
func cloudHours(_ milli: Int) -> String {
  let hours = Double(max(0, milli)) / 1000
  return hours >= 100 ? String(Int(hours)) : String(Double(Int(hours * 10)) / 10)
}

/// "2.5× hours", as the desktop writes it.
func cloudHoursRate(_ rate: Double) -> String {
  "\(rate.formatted(.number.precision(.fractionLength(0...1))))× hours"
}

/// "4", "7.5": a GB figure without a trailing ".0".
func cloudGbText(_ gb: Double) -> String {
  gb.formatted(.number.precision(.fractionLength(0...1)))
}

/// "3.4 GB", "820 MB" (`formatGb`).
func cloudGb(_ gb: Double) -> String {
  if gb > 0 && gb < 1 { return "\(max(1, Int((gb * 1000).rounded()))) MB" }
  let rounded = gb >= 100 ? gb.rounded() : (gb * 10).rounded() / 10
  return "\(cloudGbText(rounded)) GB"
}

/// Every date on the page is read in UTC, as the plan's period ends at
/// midnight UTC: "resets Dec 1" everywhere (`formatCloudDate`).
func cloudDate(_ ms: Double) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale.current
  formatter.timeZone = TimeZone(identifier: "UTC")
  formatter.setLocalizedDateFormatFromTemplate("MMM d")
  return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
}

/// "just now", "5 min ago", "3 h ago", "4 days ago".
func cloudAgo(_ ms: Double, now: Date) -> String {
  let seconds = max(0, now.timeIntervalSince1970 - ms / 1000)
  if seconds < 60 { return "just now" }
  if seconds < 3600 { return "\(Int(seconds / 60)) min ago" }
  if seconds < 86_400 { return "\(Int(seconds / 3600)) h ago" }
  let days = Int(seconds / 86_400)
  return days == 1 ? "yesterday" : "\(days) days ago"
}

func cloudLimitsPresetName(_ limits: CloudPhoneLimits) -> String {
  switch limits.preset {
  case "ask": return "Ask me"
  case "balanced": return "Balanced"
  case "hands_off": return "Hands-off"
  default: return "Custom"
  }
}

func cloudLimitsSummary(_ limits: CloudPhoneLimits) -> String {
  guard limits.unattendedSpend else { return "Unattended agents ask before anything uses hours" }
  return "\(limits.machinesPerDay) new computers a day, up to \(cloudShapeLabel(limits.maxShape))"
}
