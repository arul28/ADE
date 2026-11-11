import Foundation

// The phone's ADE Cloud page talks to whichever ADE machine it is connected to,
// through `cloud.read` and `cloud.write`: the same actions as
// `ade cloud` (apps/desktop/src/main/services/adeCloud/cloudAgentActions.ts).
// ADE Cloud access, the hours and the limits are the account's, so every machine answers
// the same. The phone is the person's own client, so nothing raises a card.

struct CloudPhoneSleep: Decodable, Equatable {
  let state: String
  let afterMinutes: Int?

  var label: String {
    switch state {
    case "auto": return "after \(afterMinutes ?? 10) min idle"
    case "never": return "never"
    default: return "once ADE on it updates"
    }
  }
}

struct CloudPhoneAccess: Decodable {
  let enabled: Bool
}

struct CloudPhoneMachine: Decodable, Identifiable, Equatable, Hashable {
  /// A computer's CPU, memory and disk (`resources`), from the full list.
  struct Resources: Decodable, Equatable {
    let cpu: Int
    let memoryGb: Double
    let diskGb: Double
  }

  /// The lane a computer was made for (`lane`), from the full list.
  struct Lane: Decodable, Equatable {
    let laneId: String
    let laneName: String
    let projectOrigin: String?
  }

  /// What uses its disk, as it last measured itself while awake (`diskUsage`).
  struct DiskUsage: Decodable, Equatable {
    struct Part: Decodable, Equatable {
      let kind: String
      let label: String
      let gb: Double
      let clearable: Bool?
    }
    let totalGb: Double
    let measuredAt: Double
    let items: [Part]
  }

  /// Its lane's work as it last read it while awake (`laneWork`).
  struct LaneWork: Decodable, Equatable {
    let unpushed: Bool?
    let prState: String?
  }

  let instanceId: String
  let name: String?
  let machineKey: String?
  let state: String
  let type: String?
  /// "Small · 2 CPU · 4 GB": the summary list's own words (an older brain).
  let size: String?
  /// The VM-era shape id (`shape` in the summary, `shapeId` in the full list).
  let shape: String?
  /// How fast this size uses hours, compared with a Small computer.
  let hoursRate: Double?
  let sleep: CloudPhoneSleep?
  let pastDue: Bool?
  let resources: Resources?
  let lane: Lane?
  let lastActiveAtMs: Double?
  let createdAtMs: Double?
  let diskUsage: DiskUsage?
  let laneWork: LaneWork?
  let diskFull: String?

  private enum CodingKeys: String, CodingKey {
    case instanceId, name, machineKey, state, type, size, shape, shapeId, hoursRate, sleep, pastDue
    case resources, lane, lastActiveAtMs, createdAtMs, diskUsage, laneWork, diskFull
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    instanceId = try c.decode(String.self, forKey: .instanceId)
    name = try c.decodeIfPresent(String.self, forKey: .name)
    machineKey = try c.decodeIfPresent(String.self, forKey: .machineKey)
    state = try c.decode(String.self, forKey: .state)
    type = try c.decodeIfPresent(String.self, forKey: .type)
    size = try? c.decodeIfPresent(String.self, forKey: .size)
    shape = (try? c.decodeIfPresent(String.self, forKey: .shape)) ?? (try? c.decodeIfPresent(String.self, forKey: .shapeId))
    hoursRate = try? c.decodeIfPresent(Double.self, forKey: .hoursRate)
    sleep = try? c.decodeIfPresent(CloudPhoneSleep.self, forKey: .sleep)
    pastDue = try? c.decodeIfPresent(Bool.self, forKey: .pastDue)
    // The full list's parts are each optional: one a newer brain shapes
    // differently drops alone instead of failing the whole page.
    resources = try? c.decodeIfPresent(Resources.self, forKey: .resources)
    lane = try? c.decodeIfPresent(Lane.self, forKey: .lane)
    lastActiveAtMs = try? c.decodeIfPresent(Double.self, forKey: .lastActiveAtMs)
    createdAtMs = try? c.decodeIfPresent(Double.self, forKey: .createdAtMs)
    diskUsage = try? c.decodeIfPresent(DiskUsage.self, forKey: .diskUsage)
    laneWork = try? c.decodeIfPresent(LaneWork.self, forKey: .laneWork)
    diskFull = try? c.decodeIfPresent(String.self, forKey: .diskFull)
  }

  var id: String { instanceId }
  var displayName: String {
    if let laneName = lane?.laneName, !laneName.isEmpty { return laneName }
    if let name, !name.isEmpty, name != "ADE Cloud computer" { return name }
    return "Computer \(instanceId.prefix(6))"
  }
  var isVM: Bool { type == "vm" }
  var isAwake: Bool { state == "running" }
  var isAsleep: Bool { state == "asleep" || state == "stopped" }
  var isMoving: Bool { state == "starting" || state == "stopping" || state == "deleting" }
  /// A computer the account pays for that holds no lane (made before lanes
  /// had their own computer). Only the full list says; the summary has no lanes.
  var noLane: Bool { lane == nil && resources != nil }

  var stateLabel: String {
    switch state {
    case "running": return "Awake"
    case "asleep", "stopped": return "Asleep"
    case "starting", "stopping", "deleting": return "Changing"
    default: return "Needs a look"
    }
  }

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.instanceId == rhs.instanceId && lhs.state == rhs.state && lhs.name == rhs.name
      && lhs.shape == rhs.shape && lhs.hoursRate == rhs.hoursRate && lhs.sleep == rhs.sleep
      && lhs.resources == rhs.resources && lhs.lane == rhs.lane && lhs.lastActiveAtMs == rhs.lastActiveAtMs
      && lhs.diskUsage == rhs.diskUsage && lhs.laneWork == rhs.laneWork
  }

  func hash(into hasher: inout Hasher) { hasher.combine(instanceId) }
}

/// The account's plan, hours, disk, computers and catalog (`account` in
/// `cloud.read list`; the server's `CloudAccountState`). Every part past the
/// plan and hours is optional: an older server leaves it out, and the page
/// leaves out what it can't say.
struct CloudPhoneAccount: Decodable, Equatable {
  struct Hours: Decodable, Equatable {
    let includedMilli: Int
    let leftMilli: Int
    let state: String
  }

  struct ExtraHours: Decodable, Equatable {
    let available: Bool
    let enabled: Bool
    let usedMilli: Int?
  }

  struct Disk: Decodable, Equatable {
    let usedGb: Double
    let limitGb: Double?
  }

  struct Computers: Decodable, Equatable {
    let total: Int
    let awake: Int
    let limit: Int
  }

  struct RecentUse: Decodable, Equatable {
    let days: Double
    let usedMilli: Double
  }

  struct Billing: Decodable, Equatable {
    let periodEnd: Double
    let cancelAtPeriodEnd: Bool?
    let nextPlanId: String?
    let notice: String?
  }

  struct EarnedHours: Decodable, Equatable {
    let leftMilli: Int
  }

  struct FreePlan: Decodable, Equatable {
    let state: String
    let sentence: String?
  }

  struct Sentence: Decodable, Equatable {
    let sentence: String?
  }

  /// What one plan includes. The price is in the payload but the phone never
  /// shows it (App Store rule: the iPhone app does not sell plans).
  struct PlanFacts: Decodable, Equatable {
    let includedMilli: Int
    let computerLimit: Int
    let diskGb: Double
  }

  struct Catalog: Decodable, Equatable {
    struct Plans: Decodable, Equatable {
      let free: PlanFacts
      let paid: PlanFacts
      let plus: PlanFacts?
      let pro: PlanFacts?
    }
    struct Size: Decodable, Equatable {
      let type: String
      let cpu: Int
      let memoryGb: Double
      let multiplierMilli: Int
      let tier: String?
      let label: String?
      let diskMaxGb: Double?
    }
    let plans: Plans
    let sizes: [Size]
  }

  let plan: String
  let planId: String?
  let hours: Hours
  let extraHours: ExtraHours?
  let disk: Disk?
  let computers: Computers?
  let recentUse: RecentUse?
  let billing: Billing?
  let catalog: Catalog?
  let earnedHours: EarnedHours?
  let freePlan: FreePlan?
  let planCleanup: Sentence?
  let timedWakesCancelled: Sentence?
  let referral: CloudPhoneReferral?

  private enum CodingKeys: String, CodingKey {
    case plan, planId, hours, extraHours, disk, computers, recentUse, billing, catalog
    case earnedHours, freePlan, planCleanup, timedWakesCancelled, referral
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    plan = try c.decode(String.self, forKey: .plan)
    planId = try? c.decodeIfPresent(String.self, forKey: .planId)
    hours = try c.decode(Hours.self, forKey: .hours)
    extraHours = try? c.decodeIfPresent(ExtraHours.self, forKey: .extraHours)
    disk = try? c.decodeIfPresent(Disk.self, forKey: .disk)
    computers = try? c.decodeIfPresent(Computers.self, forKey: .computers)
    recentUse = try? c.decodeIfPresent(RecentUse.self, forKey: .recentUse)
    billing = try? c.decodeIfPresent(Billing.self, forKey: .billing)
    catalog = try? c.decodeIfPresent(Catalog.self, forKey: .catalog)
    earnedHours = try? c.decodeIfPresent(EarnedHours.self, forKey: .earnedHours)
    freePlan = try? c.decodeIfPresent(FreePlan.self, forKey: .freePlan)
    planCleanup = try? c.decodeIfPresent(Sentence.self, forKey: .planCleanup)
    timedWakesCancelled = try? c.decodeIfPresent(Sentence.self, forKey: .timedWakesCancelled)
    referral = try? c.decodeIfPresent(CloudPhoneReferral.self, forKey: .referral)
  }

  /// Out of hours for this period, as the server counts it.
  var outOfHours: Bool { hours.state == "zero" }

  /// `free`, `plus` or `pro` (`cloudPlanIdOf`): a paid account of an older server is Plus.
  var currentPlanId: String {
    plan == "free" ? "free" : (planId == "pro" ? "pro" : "plus")
  }
}

/// The account's invite link and what it earned (`CloudReferralSummary`).
/// The code and link are the person's own, shown to them to share; they never
/// go to analytics.
struct CloudPhoneReferral: Decodable, Equatable {
  let code: String
  let link: String
  let friendsJoined: Int
  let rewardsPaid: Int
  let rewardsLeft: Int
  let rewardLimit: Int
  let rewardMilli: Int
  let hoursEarnedMilli: Int
  /// May still enter someone's code (no referrer yet, inside the window).
  let canEnterCode: Bool
  let enterCodeUntil: Double?
  let hasReferrer: Bool
  /// `pending`, `rewarded` or `refused` once this account entered a code.
  let referredState: String?

  /// "Were you invited?" shows only while the account may still enter a code.
  var offersCodeBox: Bool { canEnterCode && !hasReferrer }
}

/// `invite_redeem`'s answer: accepted (and whether both got their hours at
/// once), or refused with the server's reason and its sentence to show.
struct CloudPhoneInviteOutcome: Decodable {
  let ok: Bool
  let rewarded: Bool?
  let referral: CloudPhoneReferral?
  let reason: String?
  let message: String?
}

struct CloudPhoneList: Decodable {
  let machines: [CloudPhoneMachine]
  let runningCount: Int?
  let account: CloudPhoneAccount?
}

struct CloudPhoneLimits: Decodable, Equatable {
  let unattendedSpend: Bool
  let machinesPerDay: Int
  let maxShape: String
  let preset: String
}

/// A make, copy or move the phone started in the background (`make_status`).
struct CloudPhoneMakeJob: Decodable, Equatable {
  let requestId: String
  let kind: String
  let stage: String
  let message: String
  let instanceId: String?
  /// While the new machine waits for the person: the sign-in link to approve.
  let approvalUrl: String?
  let done: Bool
  let error: String?

  /// The approval as the phone's own sign-in sheet takes it: the custom-scheme
  /// form, which works whatever host the account service answers from.
  var approvalRequest: DeviceSignInRequest? {
    guard let raw = approvalUrl,
          let components = URLComponents(string: raw),
          let code = components.queryItems?.first(where: { $0.name == "user_code" })?.value,
          let url = URL(string: "ade://device?user_code=\(code)") else { return nil }
    return DeviceSignInRequest(url: url)
  }
}

struct CloudPhoneMakeStarted: Decodable {
  let requestId: String
}

/// Any answer: the write's own result isn't read, only that it worked.
struct CloudPhoneAck: Decodable {
  init(from decoder: Decoder) throws {}
}

@MainActor
extension SyncService {
  /// The connected machine can run the ADE Cloud page.
  var cloudSupported: Bool { supportsRemoteAction("cloud.read") }

  func cloudRead<T: Decodable>(_ action: String, args: [String: Any] = [:], as type: T.Type) async throws -> T {
    try await sendDecodableCommand(action: "cloud.read", args: ["action": action, "args": args], as: type)
  }

  /// Writes that wait on the provider (a wake, a resize restart) take longer than an ordinary command.
  func cloudWrite<T: Decodable>(_ action: String, args: [String: Any] = [:], as type: T.Type) async throws -> T {
    try await sendDecodableCommand(
      action: "cloud.write",
      args: ["action": action, "args": args],
      timeoutNanoseconds: 120 * 1_000_000_000,
      as: type
    )
  }

  /// The account's invite summary (`cloud.read referral`); nil without ADE
  /// Cloud, on an older machine, or when it can't be read.
  func readCloudReferral() async -> CloudPhoneReferral? {
    guard cloudAvailable, cloudSupported else { return nil }
    return try? await cloudRead("referral", as: CloudPhoneReferral.self)
  }

  /// Enters someone's invite (a pasted link, an `ade://` link or the bare
  /// code) for this account. Logs the funnel with no code in it.
  func redeemCloudInvite(_ code: String) async -> CloudPhoneInviteOutcome {
    do {
      let outcome = try await cloudWrite("invite_redeem", args: ["code": code], as: CloudPhoneInviteOutcome.self)
      ProductAnalytics.shared.captureInvite(.codeEntered, outcome: outcome.ok ? "accepted" : "refused_\(outcome.reason ?? "unavailable")")
      return outcome
    } catch {
      ProductAnalytics.shared.captureInvite(.codeEntered, outcome: "refused_unavailable")
      return CloudPhoneInviteOutcome(ok: false, rewarded: nil, referral: nil, reason: "unavailable", message: "ADE couldn't check that code. Try again in a moment.")
    }
  }

  /// Whether ADE Cloud exists for this account: the connected machine's answer
  /// from the server. Off the list, on an older machine, or with no answer,
  /// it's no, and every cloud entry on the phone is gone.
  func refreshCloudAvailability() async {
    guard cloudSupported else {
      cloudAvailable = false
      return
    }
    do {
      cloudAvailable = try await cloudRead("access", as: CloudPhoneAccess.self).enabled
    } catch {
      cloudAvailable = false
    }
  }

  /// Wakes the cloud box behind an account machine before the phone dials
  /// it, through the machine the phone is on now. False when it isn't an
  /// cloud box, nothing here can ask, or the wake was refused.
  func wakeCloudMachineIfNeeded(machineKey: String?) async -> Bool {
    guard let machineKey = syncNonEmpty(machineKey), cloudSupported, connectionState == .connected else { return false }
    do {
      let list = try await cloudRead("list", as: CloudPhoneList.self)
      guard let box = list.machines.first(where: { $0.machineKey == machineKey }) else { return false }
      if box.isAwake { return true }
      _ = try await cloudWrite("wake", args: ["machine": box.instanceId], as: CloudPhoneAck.self)
      return true
    } catch {
      return false
    }
  }
}
