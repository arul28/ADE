import SwiftUI

// The computer-limit card (Pricing v2): the refusal's facts
// (`CloudComputerLimit`), the sheet that shows them, and its "Free up"
// action. `CloudLaneActions` (CloudMachineScreen.swift) presents it.

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
      return Lane(instanceId: id, laneName: row.laneName.flatMap { nonEmptyTrimmed($0) } ?? "Computer \(id.prefix(6))", awake: row.awake ?? false, lastAwakeAt: row.lastAwakeAt)
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

  /// "You're using all 3 of your cloud computers."
  static func headline(limit: Int?) -> String {
    guard let limit else { return "You're using all of your cloud computers." }
    return "You're using all \(limit) of your cloud computers."
  }

  var headline: String { Self.headline(limit: limit) }
}

// MARK: - Free up

extension CloudLaneActions {
  /// "Free up" on the limit card: the lane's work is pushed, its computer
  /// goes, the lane and its chats stay (`freeLane`, which ADE Cloud runs on
  /// its own). The result shows as a toast, and the card closes once one
  /// computer is free.
  func freeUp(_ lane: CloudComputerLimit.Lane) {
    guard !freeing.contains(lane.instanceId) else { return }
    freeing.insert(lane.instanceId)
    Task { @MainActor [self] in
      defer { freeing.remove(lane.instanceId) }
      let sync = SyncMenuSafePublisher.shared.service
      guard let client = await sync.cloudServerClient() else {
        toast = ADEToastMessage(text: "Couldn't free \(lane.laneName)'s computer", kind: .failure, detail: "Sign in to ADE, then try again.")
        return
      }
      let outcome = await client.freeLane(instanceId: lane.instanceId)
      sync.refreshCloudServerIfStale(force: true)
      if outcome.ok {
        ADEHaptics.success()
        if computerLimit?.lanes.contains(where: { $0.instanceId == lane.instanceId }) == true { closeComputerLimit() }
        toast = ADEToastMessage(text: "Freed \(lane.laneName)'s computer", detail: "You have a cloud computer free. Send your message again.")
      } else {
        ADEHaptics.error()
        toast = ADEToastMessage(text: "Kept \(lane.laneName)'s computer", kind: .failure, detail: outcome.message)
      }
    }
  }
}

// MARK: - The card


/// "You're using all 3 of your cloud computers." (Pricing v2): a new lane
/// needs its own computer and the plan's are all taken. Three ways out: free
/// up another lane's computer (the lane and its chats stay; it gets a new
/// computer with its next message), delete a lane, or the next plan's
/// computers, said as a fact (the iPhone app sells nothing, App Store
/// 3.1.1/3.1.3). The refusal's facts first; what it leaves out comes from
/// the account's state.
struct CloudComputerLimitSheet: View {
  let limit: CloudComputerLimit
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var actions = CloudLaneActions.shared
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  @State private var askFree: CloudComputerLimit.Lane?
  private var syncService: SyncService { syncPublishes.service }

  private var account: CloudPhoneAccount? { cloudStore.account }
  private var limitCount: Int? { limit.limit ?? account?.computerLimit }

  /// The account's computers, least recently used first.
  private var lanes: [CloudComputerLimit.Lane] {
    if !limit.lanes.isEmpty { return limit.lanes }
    return syncService.cloudServerInstances
      .filter { !$0.isGone }
      .sorted { ($0.lastActiveAt ?? 0) < ($1.lastActiveAt ?? 0) }
      .map { instance in
        CloudComputerLimit.Lane(
          instanceId: instance.id,
          laneName: instance.laneName ?? instance.name.flatMap { nonEmptyTrimmed($0) } ?? "Computer \(instance.id.prefix(6))",
          awake: instance.isAwake,
          lastAwakeAt: instance.lastActiveAt
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
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          VStack(alignment: .leading, spacing: 6) {
            Text(CloudComputerLimit.headline(limit: limitCount))
              .font(.system(size: 17, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .fixedSize(horizontal: false, vertical: true)
            Text("Each lane on ADE Cloud has its own computer, asleep or awake. Make room one of these ways.")
              .font(.system(size: 13))
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          way(
            symbol: "shippingbox",
            title: "Free up a computer from another lane",
            detail: "The lane and its chats stay. It gets a new computer the next time you send a message there."
          )
          if !lanes.isEmpty {
            VStack(spacing: 0) {
              ForEach(Array(lanes.enumerated()), id: \.element.id) { index, lane in
                if index > 0 { ADESettingsHairline() }
                row(lane)
              }
            }
            .adeKitCard(padding: 0)
          }
          way(
            symbol: "trash",
            title: "Delete a lane",
            detail: "Open a lane's menu above. Its branch stays on GitHub; its chats go."
          )
          if let next = nextPlan {
            way(
              symbol: "square.stack.3d.up",
              title: "\(cloudPlanLabel(next.planId)) has \(next.computerLimit) cloud \(next.computerLimit == 1 ? "computer" : "computers")",
              detail: "A bigger plan has room for more lanes on ADE Cloud."
            )
          }
        }
        .padding(16)
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
      .confirmationDialog(
        askFree.map { "Free up \($0.laneName)'s computer?" } ?? "",
        isPresented: Binding(get: { askFree != nil }, set: { if !$0 { askFree = nil } }),
        titleVisibility: .visible,
        presenting: askFree
      ) { lane in
        Button("Free up") { actions.freeUp(lane) }
        Button("Cancel", role: .cancel) {}
      } message: { lane in
        Text("ADE pushes the lane's work to GitHub, then removes its computer. The lane and its chats stay; your next message there makes a new computer.\(lane.awake ? " Work running on it stops." : "")")
      }
    }
    .presentationDetents([.medium, .large])
    // The lane's delete and its computer's page open over this card.
    .cloudLaneActionsHost()
  }

  private func way(symbol: String, title: String, detail: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(CloudBrandColor.mark)
        .frame(width: 26, height: 26)
        .background(CloudBrandColor.violet.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(detail)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
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

  private func row(_ lane: CloudComputerLimit.Lane) -> some View {
    let freeing = actions.freeing.contains(lane.instanceId)
    // A computer known to hold no lane has no lane to keep: Manage deletes it.
    let holdsLane = syncService.cloudServerInstances.first { $0.id == lane.instanceId }.map { $0.laneId != nil } ?? true
    return HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(lane.laneName)
          .font(.system(size: 14.5, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text(lane.awake ? "Awake now" : lane.lastAwakeAt.map { "Asleep · used \(cloudAgo($0, now: Date()))" } ?? "Asleep")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer(minLength: 8)
      if freeing {
        ProgressView().controlSize(.small)
          .accessibilityLabel("Freeing")
      } else {
        if holdsLane {
          Button("Free up") { askFree = lane }
            .buttonStyle(ADEKitButtonStyle())
        }
        Menu {
          Button { actions.manageComputer(instanceId: lane.instanceId, showsOpenWork: false) } label: {
            Label("Manage computer", systemImage: "slider.horizontal.3")
          }
          if let target = deleteTarget(lane) {
            Button(role: .destructive) { actions.delete(target, fromMenu: true) } label: {
              Label("Delete lane", systemImage: "trash")
            }
          }
        } label: {
          Image(systemName: "ellipsis")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 32, height: 32)
        }
        .accessibilityLabel("More for \(lane.laneName)")
      }
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 10)
  }
}
