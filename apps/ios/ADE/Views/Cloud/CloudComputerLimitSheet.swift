import SwiftUI

// The computer-limit card (Pricing v2): the refusal's facts
// (`CloudComputerLimit`), the sheet that shows them, and its "Free up" and
// "Delete" actions. `CloudLaneActions` (CloudMachineScreen.swift) presents it.
// The desktop's `CloudComputerLimitCard.tsx` has the same shape.

// MARK: - The refusal

/// The plan's cloud computers are all taken (Pricing v2): a new lane, chat or
/// copy is refused with `computer_limit` and these facts
/// (`CloudComputerLimitDetail` in contract.ts). The phone shows them as one
/// card with three ways out: free up another lane's computer (the lane and
/// its chats stay), delete a lane, or the next plan's limit as a fact (the
/// iPhone app sells nothing, App Store 3.1.1). Every field but the sentence
/// may be missing; the card then fills in from the account's state.
struct CloudComputerLimit: Equatable, Identifiable {
  static let code = "computer_limit"

  /// A computer the card offers to free up or delete, least recently used first.
  struct Lane: Equatable, Identifiable {
    let instanceId: String
    let laneName: String
    let awake: Bool
    let lastAwakeAt: Double?
    /// False for a computer that holds no lane: it can only be deleted.
    var hasLane = true
    /// The server said whether it holds a lane (it reads the lane's own rows);
    /// the account's list, which can lag a new lane, never overrides it.
    var serverNamedLane = false
    var id: String { instanceId }
  }

  /// The next plan up and its computers (`CloudNextPlan`), as both the
  /// account (`computers.nextPlan`) and the refusal send it. The price is
  /// in the payload but the phone never reads it (App Store 3.1.1).
  struct NextPlan: Decodable, Equatable {
    let planId: String
    let computerLimit: Int
  }

  /// One card per refusal: a second refusal opens a fresh one.
  let id = UUID()
  /// The server's sentence (or the phone's own when it sent none).
  let message: String
  let planId: String?
  let limit: Int?
  let total: Int?
  let lanes: [Lane]
  let nextPlan: NextPlan?

  init(message: String, planId: String?, limit: Int?, total: Int?, lanes: [Lane], nextPlan: NextPlan?) {
    self.message = message
    self.planId = planId
    self.limit = limit
    self.total = total
    self.lanes = lanes
    self.nextPlan = nextPlan
  }

  /// From the refusal's body (`{ error: { code, message, ...detail } }`);
  /// a part this app can't read drops alone.
  init(refusal body: Data, message: String?) {
    struct Envelope: Decodable {
      struct LaneRow: Decodable {
        let instanceId: String?
        let laneName: String?
        let awake: Bool?
        let lastAwakeAt: Double?
        let hasLane: Bool?
      }
      struct Detail: Decodable {
        let planId: String?
        let limit: Int?
        let total: Int?
        let lanes: [LaneRow]?
        let nextPlan: NextPlan?

        private enum CodingKeys: String, CodingKey { case planId, limit, total, lanes, nextPlan }

        init(from decoder: Decoder) throws {
          let c = try decoder.container(keyedBy: CodingKeys.self)
          planId = c.lenient(String.self, forKey: .planId)
          limit = c.lenient(Int.self, forKey: .limit)
          total = c.lenient(Int.self, forKey: .total)
          lanes = c.lenient([LaneRow].self, forKey: .lanes)
          nextPlan = c.lenient(NextPlan.self, forKey: .nextPlan)
        }
      }
      let error: Detail?
    }
    let detail = (try? JSONDecoder().decode(Envelope.self, from: body))?.error
    let lanes: [Lane] = (detail?.lanes ?? []).compactMap { row in
      guard let id = row.instanceId.flatMap({ nonEmptyTrimmed($0) }) else { return nil }
      return Lane(
        instanceId: id,
        laneName: row.laneName.flatMap { nonEmptyTrimmed($0) } ?? "Computer \(id.prefix(6))",
        awake: row.awake ?? false,
        lastAwakeAt: row.lastAwakeAt,
        hasLane: row.hasLane ?? true,
        serverNamedLane: row.hasLane != nil
      )
    }
    self.init(
      message: message ?? CloudComputerLimit.headline(limit: detail?.limit),
      planId: detail?.planId,
      limit: detail?.limit,
      total: detail?.total,
      lanes: lanes,
      nextPlan: detail?.nextPlan
    )
  }

  /// "You're using all 3 of your cloud computers." (the refusal's sentence when the server sent none).
  static func headline(limit: Int?) -> String {
    guard let limit else { return "You're using all of your cloud computers." }
    return "You're using all \(limit) of your cloud computers."
  }

  var headline: String { Self.headline(limit: limit) }

  /// The card's title (`cloudComputerLimitTitle`): "All 3 of your cloud computers are in use".
  static func title(limit: Int?) -> String {
    guard let limit else { return "All your cloud computers are in use" }
    return limit == 1 ? "Your one cloud computer is in use" : "All \(limit) of your cloud computers are in use"
  }
}

// MARK: - Free up and delete

extension CloudLaneActions {
  /// "Free up" on the limit card: the lane's work is pushed, its computer
  /// goes, the lane and its chats stay (`freeLane`, which ADE Cloud runs on
  /// its own). The result shows as a toast, and the card closes once one
  /// computer is free.
  func freeUp(_ lane: CloudComputerLimit.Lane) {
    guard !freeing.contains(lane.instanceId) else { return }
    markFreeing(lane.instanceId, true)
    Task { @MainActor [self] in
      defer { markFreeing(lane.instanceId, false) }
      let sync = SyncMenuSafePublisher.shared.service
      guard let client = await sync.cloudServerClient() else {
        toast = ADEToastMessage(text: "Couldn't free \(lane.laneName)'s computer", kind: .failure, detail: "Sign in to ADE, then try again.")
        return
      }
      let outcome = await client.freeLane(instanceId: lane.instanceId)
      sync.refreshCloudServerIfStale(force: true)
      if outcome.ok {
        ADEHaptics.success()
        if computerLimit?.lanes.contains(where: { $0.instanceId == lane.instanceId }) == true || computerLimit?.lanes.isEmpty == true { closeComputerLimit() }
        toast = ADEToastMessage(text: "Freed \(lane.laneName)'s computer", detail: "You have a cloud computer free. Send your message again.")
      } else {
        ADEHaptics.error()
        toast = ADEToastMessage(text: "Kept \(lane.laneName)'s computer", kind: .failure, detail: outcome.message)
      }
    }
  }

  /// "Delete this computer" on the limit card, for a computer that holds no
  /// lane (nothing of a lane to check or keep): deleted on ADE Cloud by its
  /// id, then taken off the account's machines, as the computer page does.
  func deleteComputerWithoutLane(_ lane: CloudComputerLimit.Lane) {
    guard !freeing.contains(lane.instanceId) else { return }
    markFreeing(lane.instanceId, true)
    Task { @MainActor [self] in
      defer { markFreeing(lane.instanceId, false) }
      let sync = SyncMenuSafePublisher.shared.service
      guard let client = await sync.cloudServerClient() else {
        toast = ADEToastMessage(text: "Couldn't delete the computer", kind: .failure, detail: "Sign in to ADE, then try again.")
        return
      }
      let machineKey = sync.cloudServerInstances.first { $0.id == lane.instanceId }?.machineKey
      do {
        guard try await client.deleteInstanceConfirmed(lane.instanceId) else {
          ADEHaptics.error()
          toast = ADEToastMessage(text: "Still deleting the computer", kind: .failure, detail: "ADE Cloud took the delete but hasn't finished it yet. Check again in a minute.")
          return
        }
      } catch {
        ADEHaptics.error()
        toast = ADEToastMessage(text: "Couldn't delete the computer", kind: .failure, detail: cloudServerFailureMessage(error))
        return
      }
      let account = AccountService.shared
      if let machineKey, let row = account.machines.first(where: { $0.machineKey.caseInsensitiveCompare(machineKey) == .orderedSame }) {
        do {
          try await account.removeMachineFromAccount(row)
        } catch {
          // The computer is gone; its stale row on the account goes with the next machines read.
          CrashReporting.capture(error, context: ["area": "cloud_limit_remove_machine"])
        }
      }
      sync.refreshCloudServerIfStale(force: true)
      ADEHaptics.success()
      deleted(instanceId: lane.instanceId)
      closeComputerLimit()
      toast = ADEToastMessage(text: "Deleted the computer", detail: "You have a cloud computer free. Send your message again.")
    }
  }
}

// MARK: - The card

/// "All 3 of your cloud computers are in use" (Pricing v2): a new lane needs
/// its own computer and the plan's are all taken. Three ways out, side by
/// side where they fit (stacked on a phone), each with one line under it;
/// picking one opens its step below, which says exactly what will happen,
/// and the confirm button names the action:
///
/// 1. Free up a computer: the lane and its chats stay; it gets a new computer
///    the next time a message is sent there. A computer with no lane can only
///    be deleted.
/// 2. Delete a lane: the ordinary cloud lane delete, which checks its work first.
/// 3. Move to the next plan, said as a fact only: the iPhone app sells
///    nothing (App Store 3.1.1/3.1.3), so there is no checkout, price or link.
///
/// Account level: every call goes to ADE Cloud by the computer's id, no pin.
/// The refusal's facts first; what it leaves out comes from the account's state.
struct CloudComputerLimitSheet: View {
  let limit: CloudComputerLimit
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var actions = CloudLaneActions.shared
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @State private var way: Way?
  @State private var freeId: String?
  @State private var deleteId: String?
  @State private var width: CGFloat = 0
  @State private var now = Date()
  private var syncService: SyncService { syncPublishes.service }

  private enum Way: Equatable { case free, delete, move }

  private var account: CloudPhoneAccount? { cloudStore.account }
  private var limitCount: Int? { limit.limit ?? account?.computerLimit }

  /// The account's computers, least recently used first.
  private var lanes: [CloudComputerLimit.Lane] {
    if !limit.lanes.isEmpty {
      // The refusal names them; when it doesn't say which hold no lane, the account's list does.
      return limit.lanes.map { lane in
        guard !lane.serverNamedLane,
              let instance = syncService.cloudServerInstances.first(where: { $0.id == lane.instanceId }) else { return lane }
        var known = lane
        known.hasLane = lane.hasLane && instance.laneId != nil
        return known
      }
    }
    return syncService.cloudServerInstances
      .filter { !$0.isGone }
      .sorted { ($0.lastActiveAt ?? 0) < ($1.lastActiveAt ?? 0) }
      .map { instance in
        CloudComputerLimit.Lane(
          instanceId: instance.id,
          laneName: instance.laneName ?? instance.name.flatMap { nonEmptyTrimmed($0) } ?? "Computer \(instance.id.prefix(6))",
          awake: instance.isAwake,
          lastAwakeAt: instance.lastActiveAt,
          hasLane: instance.laneId != nil
        )
      }
  }

  /// The next plan's computers, as the server says it: the account's,
  /// else the refusal's; nil on Max.
  private var nextPlan: CloudComputerLimit.NextPlan? {
    account?.computers?.nextPlan ?? limit.nextPlan
  }

  var body: some View {
    NavigationStack {
      ScrollViewReader { scroller in
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          VStack(alignment: .leading, spacing: 6) {
            Text(CloudComputerLimit.title(limit: limitCount))
              .font(.system(size: 18, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityAddTraits(.isHeader)
            Text("A new cloud lane needs a computer of its own. Pick how to make room.")
              .font(.system(size: 13.5))
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          ways
          if way != nil {
            if lanes.isEmpty && way != .move {
              note("ADE couldn't list your computers here. Open Settings › ADE Cloud to see every lane.")
            } else {
              step.id("step")
            }
          }
        }
        .padding(16)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
      }
      // A picked way's step opens below the tiles: bring it up so its button shows.
      .onChange(of: way) { _, picked in
        guard picked != nil else { return }
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(250))
          withAnimation(.easeInOut(duration: 0.25)) { scroller.scrollTo("step", anchor: .bottom) }
        }
      }
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Cloud computers")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(role: .close) { actions.closeComputerLimit() }
            .accessibilityLabel("Close")
        }
      }
      .animation(.easeInOut(duration: 0.18), value: way)
    }
    .presentationDetents([.large])
    // The lane's delete and its computer's page open over this card.
    .cloudLaneActionsHost()
  }

  // MARK: The three ways

  @ViewBuilder
  private var ways: some View {
    // Side by side where three fit with their line; stacked on a phone.
    if width >= 560 {
      HStack(alignment: .top, spacing: 8) { wayTiles }
        .fixedSize(horizontal: false, vertical: true)
    } else {
      VStack(spacing: 8) { wayTiles }
    }
  }

  @ViewBuilder
  private var wayTiles: some View {
    tile(.free, symbol: "arrow.3.trianglepath", title: "Free up a computer", line: "Keep the lane and its chats; it gets a new computer later.")
    tile(.delete, symbol: "trash", title: "Delete a lane", line: "The lane and its computer go. ADE checks its work is on GitHub.")
    if let next = nextPlan {
      tile(.move, symbol: "arrow.up.circle", title: "The \(cloudPlanLabel(next.planId)) plan", line: "\(plural(next.computerLimit, "computer")). Small stays unlimited.")
    }
  }

  private func tile(_ target: Way, symbol: String, title: String, line: String) -> some View {
    let picked = way == target
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    return Button {
      ADEHaptics.light()
      way = picked ? nil : target
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 7) {
          Image(systemName: symbol)
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundStyle(picked ? ADEColor.accent : CloudBrandColor.mark)
            .frame(width: 18)
          Text(title)
            .font(.system(size: 14.5, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Spacer(minLength: 0)
        }
        Text(line)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.leading, 25)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 11)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(picked ? ADEColor.accent.opacity(0.08) : ADEKit.surface, in: shape)
      .overlay(shape.strokeBorder(picked ? ADEColor.accent.opacity(0.55) : ADEKit.edge, lineWidth: picked ? 1.25 : 0.75))
      .contentShape(shape)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(picked ? .isSelected : [])
  }

  // MARK: The step

  @ViewBuilder
  private var step: some View {
    VStack(alignment: .leading, spacing: 12) {
      switch way {
      case .free: freeStep
      case .delete: deleteStep
      case .move: moveStep
      case nil: EmptyView()
      }
    }
    .adeKitCard()
    .transition(.opacity)
  }

  private var withLane: [CloudComputerLimit.Lane] { lanes.filter(\.hasLane) }
  private var freeLane: CloudComputerLimit.Lane? {
    lanes.first { $0.instanceId == (freeId ?? withLane.first?.instanceId) && $0.hasLane }
  }
  private var deleteLane: CloudComputerLimit.Lane? {
    lanes.first { $0.instanceId == (deleteId ?? lanes.first?.instanceId) }
  }

  @ViewBuilder
  private var freeStep: some View {
    if withLane.isEmpty {
      stepText("None of your computers holds a lane to keep. Delete one instead.")
    } else {
      question("Which computer?")
      picker(chosen: freeLane?.instanceId, freeOnly: true) { freeId = $0 }
      if let lane = freeLane {
        what("its work is pushed to GitHub, the computer is deleted, and “\(lane.laneName)” stays in your lanes with its chats.\(lane.awake ? " What runs on it now stops." : "") Your next message there starts a new computer.")
        confirm(
          title: "Free up \(lane.laneName)",
          busyTitle: "Freeing \(lane.laneName)…",
          busy: actions.freeing.contains(lane.instanceId),
          tone: .neutral
        ) { actions.freeUp(lane) }
      }
    }
  }

  @ViewBuilder
  private var deleteStep: some View {
    question("Which lane?")
    picker(chosen: deleteLane?.instanceId, freeOnly: false) { deleteId = $0 }
    if let lane = deleteLane {
      what(lane.hasLane
        ? "“\(lane.laneName)”, its computer and its chats are deleted. If any of its work isn't on GitHub, ADE asks you first."
        : "this computer has no lane; ADE deletes it.")
      confirm(
        title: lane.hasLane ? "Delete \(lane.laneName)" : "Delete this computer",
        busyTitle: "Deleting…",
        busy: actions.freeing.contains(lane.instanceId),
        tone: .crit
      ) { delete(lane) }
    }
  }

  @ViewBuilder
  private var moveStep: some View {
    if let next = nextPlan {
      let label = cloudPlanLabel(next.planId)
      question(label)
      VStack(alignment: .leading, spacing: 6) {
        fact("\(plural(next.computerLimit, "cloud computer"))\(limitCount.map { next.computerLimit > $0 ? ", \(next.computerLimit - $0) more than now" : "" } ?? "")")
        if let hours = planFacts(next.planId)?.includedMilli, hours > 0 {
          fact("\(cloudHours(hours)) hours a month for bigger computers")
        }
        fact("Small computers stay unlimited and never use your hours")
      }
      what("on \(label) you can have \(plural(next.computerLimit, "cloud computer")), and your new lane can start.")
    }
  }

  private func delete(_ lane: CloudComputerLimit.Lane) {
    guard lane.hasLane else {
      actions.deleteComputerWithoutLane(lane)
      return
    }
    if let target = deleteTarget(lane) {
      // The ordinary lane delete: it reads the lane's work and asks first when some isn't on GitHub.
      actions.delete(target)
    } else {
      // The account's list hasn't named the lane's id yet: its computer page deletes it.
      actions.manageComputer(instanceId: lane.instanceId, showsOpenWork: false)
    }
  }

  private func deleteTarget(_ lane: CloudComputerLimit.Lane) -> CloudLaneDeleteTarget? {
    guard let instance = syncService.cloudServerInstances.first(where: { $0.id == lane.instanceId }),
          let laneId = instance.laneId else { return nil }
    return CloudLaneDeleteTarget(
      instanceId: instance.id,
      accountMachineKey: instance.machineKey,
      laneId: laneId,
      laneName: nonEmptyTrimmed(instance.laneName) ?? lane.laneName,
      unpushed: instance.laneWork?.unpushed,
      onDeleted: { @MainActor in
        CloudLaneActions.shared.closeComputerLimit()
        syncService.refreshCloudServerIfStale(force: true)
      }
    )
  }

  /// A plan's facts from the account's catalog (Plus falls back to the old `paid`).
  private func planFacts(_ planId: String) -> CloudPhoneAccount.PlanFacts? {
    guard let plans = account?.catalog?.plans else { return nil }
    switch planId {
    case "plus": return plans.plus ?? plans.paid
    case "pro": return plans.pro
    case "max": return plans.max
    default: return nil
    }
  }

  // MARK: Pieces

  /// The computers to pick from. A computer with no lane can't be freed up
  /// (there is no lane to keep), so the free-up list shows it, disabled.
  private func picker(chosen: String?, freeOnly: Bool, onChoose: @escaping (String) -> Void) -> some View {
    VStack(spacing: 0) {
      ForEach(Array(lanes.enumerated()), id: \.element.id) { index, lane in
        if index > 0 { ADESettingsHairline() }
        let disabled = freeOnly && !lane.hasLane
        let selected = chosen == lane.instanceId && !disabled
        Button { onChoose(lane.instanceId) } label: {
          HStack(spacing: 10) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
              .font(.system(size: 16))
              .foregroundStyle(selected ? ADEColor.accent : ADEColor.textMuted)
            VStack(alignment: .leading, spacing: 2) {
              Text(lane.laneName)
                .font(.system(size: 14.5, weight: .medium))
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
              Text(actions.freeing.contains(lane.instanceId) ? "Working on it…" : disabled ? "No lane · delete only" : stateLine(lane))
                .font(.system(size: 12))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .frame(minHeight: 48)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
    }
    .background(ADEColor.pageBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ADEKit.edge, lineWidth: 0.75))
  }

  /// "Awake · in use now", "Asleep 3 days", "Asleep · no lane" (`laneStateLine`).
  private func stateLine(_ lane: CloudComputerLimit.Lane) -> String {
    let when = lane.lastAwakeAt.flatMap { cloudLimitSince($0, now: now) }
    let state = lane.awake ? "Awake · in use now" : when.map { "Asleep \($0)" } ?? "Asleep"
    return lane.hasLane ? state : "\(state) · no lane"
  }

  private func question(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(ADEColor.textPrimary)
  }

  private func what(_ text: String) -> some View {
    Text("\(Text("What happens: ").fontWeight(.semibold).foregroundStyle(ADEColor.textPrimary))\(Text(text).foregroundStyle(ADEColor.textSecondary))")
      .font(.system(size: 13))
      .fixedSize(horizontal: false, vertical: true)
  }

  private func stepText(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 13))
      .foregroundStyle(ADEColor.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
  }

  private func note(_ text: String) -> some View {
    stepText(text)
      .frame(maxWidth: .infinity, alignment: .leading)
      .adeKitCard()
  }

  private func fact(_ text: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: "checkmark")
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(CloudBrandColor.mark)
      Text(text)
        .font(.system(size: 13))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func confirm(title: String, busyTitle: String, busy: Bool, tone: ADEKitTone, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      if busy {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text(busyTitle).lineLimit(1)
        }
      } else {
        Text(title).lineLimit(1).truncationMode(.middle)
      }
    }
    .buttonStyle(ADEKitButtonStyle(prominent: tone == .neutral, tone: tone, wide: true))
    .disabled(busy)
    .padding(.top, 2)
  }

  private func plural(_ count: Int, _ word: String) -> String {
    "\(count) \(word)\(count == 1 ? "" : "s")"
  }
}

/// "3 days", "5 min", "2 h", "1 day" since `ms` (`formatAgo` without "ago");
/// nil for just now.
func cloudLimitSince(_ ms: Double, now: Date) -> String? {
  let minutes = Int((max(0, now.timeIntervalSince1970 * 1000 - ms) / 60_000).rounded())
  if minutes < 1 { return nil }
  if minutes < 60 { return "\(minutes) min" }
  let hours = Int((Double(minutes) / 60).rounded())
  if hours < 24 { return "\(hours) h" }
  let days = Int((Double(hours) / 24).rounded())
  return days == 1 ? "1 day" : "\(days) days"
}
