import Foundation
import OSLog

private let cloudServerLog = Logger(subsystem: "com.ade.ios", category: "cloud")

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
    size = c.lenient(String.self, forKey: .size)
    shape = c.lenient(String.self, forKey: .shape) ?? c.lenient(String.self, forKey: .shapeId)
    hoursRate = c.lenient(Double.self, forKey: .hoursRate)
    sleep = c.lenient(CloudPhoneSleep.self, forKey: .sleep)
    pastDue = c.lenient(Bool.self, forKey: .pastDue)
    // The full list's parts are each optional: one a newer brain shapes
    // differently drops alone instead of failing the whole page.
    resources = c.lenient(Resources.self, forKey: .resources)
    lane = c.lenient(Lane.self, forKey: .lane)
    lastActiveAtMs = c.lenient(Double.self, forKey: .lastActiveAtMs)
    createdAtMs = c.lenient(Double.self, forKey: .createdAtMs)
    diskUsage = c.lenient(DiskUsage.self, forKey: .diskUsage)
    laneWork = c.lenient(LaneWork.self, forKey: .laneWork)
    diskFull = c.lenient(String.self, forKey: .diskFull)
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
    /// Used this period; nil from a payload that leaves it out.
    let usedMilli: Int?
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

  /// No plan limits how many computers an account has; `limit` is still sent
  /// for older builds and is never shown.
  struct Computers: Decodable, Equatable {
    let total: Int
    let awake: Int
  }

  struct RecentUse: Decodable, Equatable {
    let days: Double
    let usedMilli: Double
  }

  struct Billing: Decodable, Equatable {
    /// When this period began (ms); the plan confirmation keys on it.
    let periodStart: Double?
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
    /// The free plan's GitHub rules (`CloudFreePlanGithub`); older servers leave it out.
    let github: FreePlanGithub?

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      state = try c.decode(String.self, forKey: .state)
      sentence = c.lenient(String.self, forKey: .sentence)
      github = c.lenient(FreePlanGithub.self, forKey: .github)
    }

    private enum CodingKeys: String, CodingKey { case state, sentence, github }
  }

  /// Why the free plan has no hours under its GitHub rules: `no_github`,
  /// `too_new` (free hours start at `oldEnoughAt`, ms), `used` (that GitHub
  /// account gives another ADE account its free plan), `checking`; `ok` when
  /// nothing is held. Every field optional, so a newer server never breaks it.
  struct FreePlanGithub: Decodable, Equatable {
    let state: String?
    let oldEnoughAt: Double?
    let githubLogin: String?
  }

  /// What goes over a cheaper plan's limits (`CloudPlanCleanup`). ADE frees
  /// nothing on its own: the person picks on the desktop. `startsAt`: when a
  /// waiting cheaper plan starts (nil once it is in force, when no new
  /// computer can be made). `freeing`: ADE is freeing the person's pick now.
  struct PlanCleanup: Decodable, Equatable {
    struct Freeing: Decodable, Equatable {
      let instanceIds: [String]?
    }
    let planId: String?
    let sentence: String?
    let startsAt: Double?
    let freeing: Freeing?
  }

  /// What a cheaper plan's limits freed and kept (`CloudPlanCleanupDone`, no
  /// sentence: the phone builds it as `planCleanupDoneSentence` does).
  struct PlanCleanupDone: Decodable, Equatable {
    struct Freed: Decodable, Equatable {
      let name: String
      let branch: String?
      /// The computer held a lane, which ADE kept; nil (an older server) reads as no.
      let laneKept: Bool?
      /// False when the person chose to delete it without pushing; nil (an older server) reads as pushed.
      let pushed: Bool?
    }
    struct Kept: Decodable, Equatable {
      let name: String
    }
    let at: Double
    let planId: String
    let freed: [Freed]
    let kept: [Kept]
  }

  /// Timed wake-ups this period cancelled (`CloudTimedWakesCancelled`, no
  /// sentence: the phone builds it as `timedWakesCancelledSentence` does).
  struct TimedWakesCancelled: Decodable, Equatable {
    let at: Double
    let count: Int
    /// `out_of_hours` or `over_plan_disk`.
    let reason: String
  }

  /// A computer the idle cleanup warned about, or kept because its work
  /// couldn't be saved (`CloudIdleCleanupEntry`). The phone shows the warning
  /// and how to keep it; "Keep it" is on the desktop.
  struct IdleCleanup: Decodable, Equatable {
    struct IgnoredFiles: Decodable, Equatable {
      let paths: [String]
      let more: Int
      let rebuildable: Int?
      /// Some lane couldn't be read, so there may be more than listed.
      let incomplete: Bool?
    }
    struct Held: Decodable, Equatable {
      let at: Double
      let reason: String
      /// When ADE tries again; an older server leaves it out (`deletesAt` then).
      let retryAt: Double?
    }
    let instanceId: String
    let name: String?
    let deletesAt: Double
    let laneName: String?
    let branch: String?
    let idleDays: Int?
    let ignoredFiles: IgnoredFiles?
    let held: Held?

    private enum CodingKeys: String, CodingKey {
      case instanceId, name, deletesAt, laneName, branch, idleDays, ignoredFiles, held
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      instanceId = try c.decode(String.self, forKey: .instanceId)
      deletesAt = try c.decode(Double.self, forKey: .deletesAt)
      name = c.lenient(String.self, forKey: .name)
      laneName = c.lenient(String.self, forKey: .laneName)
      branch = c.lenient(String.self, forKey: .branch)
      idleDays = c.lenient(Int.self, forKey: .idleDays)
      ignoredFiles = c.lenient(IgnoredFiles.self, forKey: .ignoredFiles)
      held = c.lenient(Held.self, forKey: .held)
    }

    var displayName: String {
      if let laneName, !laneName.isEmpty { return laneName }
      if let name, !name.isEmpty { return name }
      return "Computer \(instanceId.prefix(6))"
    }
  }

  /// What one plan includes. The price is in the payload but the phone never
  /// shows it (App Store rule: the iPhone app does not sell plans).
  struct PlanFacts: Decodable, Equatable {
    let includedMilli: Int
    let diskGb: Double
    /// Phone minutes a month (shown on the plan table only); nil from an older server.
    let phoneMinutes: Int?
  }

  struct Catalog: Decodable, Equatable {
    struct Plans: Decodable, Equatable {
      let free: PlanFacts
      let paid: PlanFacts
      let plus: PlanFacts?
      let pro: PlanFacts?
      let max: PlanFacts?
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
  let planCleanup: PlanCleanup?
  let planCleanupDone: PlanCleanupDone?
  let timedWakesCancelled: TimedWakesCancelled?
  /// The idle cleanup's warnings; an older server sends the 30-day list's
  /// entries, which decode with only an id and a date.
  let dueForDeletion: [IdleCleanup]
  let referral: CloudPhoneReferral?

  private enum CodingKeys: String, CodingKey {
    case plan, planId, hours, extraHours, disk, computers, recentUse, billing, catalog
    case earnedHours, freePlan, planCleanup, planCleanupDone, timedWakesCancelled, dueForDeletion, referral
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    plan = try c.decode(String.self, forKey: .plan)
    planId = c.lenient(String.self, forKey: .planId)
    hours = try c.decode(Hours.self, forKey: .hours)
    extraHours = c.lenient(ExtraHours.self, forKey: .extraHours)
    disk = c.lenient(Disk.self, forKey: .disk)
    computers = c.lenient(Computers.self, forKey: .computers)
    recentUse = c.lenient(RecentUse.self, forKey: .recentUse)
    billing = c.lenient(Billing.self, forKey: .billing)
    catalog = c.lenient(Catalog.self, forKey: .catalog)
    earnedHours = c.lenient(EarnedHours.self, forKey: .earnedHours)
    freePlan = c.lenient(FreePlan.self, forKey: .freePlan)
    planCleanup = c.lenient(PlanCleanup.self, forKey: .planCleanup)
    planCleanupDone = c.lenient(PlanCleanupDone.self, forKey: .planCleanupDone)
    timedWakesCancelled = c.lenient(TimedWakesCancelled.self, forKey: .timedWakesCancelled)
    dueForDeletion = c.lenient([IdleCleanup].self, forKey: .dueForDeletion) ?? []
    referral = c.lenient(CloudPhoneReferral.self, forKey: .referral)
  }

  /// Out of hours for this period, as the server counts it.
  var outOfHours: Bool { hours.state == "zero" }

  /// `free`, `plus`, `pro` or `max` (`cloudPlanIdOf`): a paid account of an older server is Plus.
  var currentPlanId: String {
    if plan == "free" { return "free" }
    if let planId, planId == "pro" || planId == "max" { return planId }
    return "plus"
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

  /// Whether the account pays for ADE Cloud, or nil while that can't be read
  /// (ADE Cloud is off for the account, an older machine, no connection).
  /// One account read, no computers: the CTO's home chooser needs only the
  /// plan to word its one ADE Cloud row.
  func readCloudPlanIsPaid() async -> Bool? {
    guard cloudAvailable, cloudSupported, connectionState == .connected else { return nil }
    guard let account = try? await cloudRead("hours", as: CloudPhoneAccount.self) else { return nil }
    return account.currentPlanId != "free"
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
  /// An answer that lands after the phone left that machine is dropped: the
  /// read the new connection starts decides.
  func refreshCloudAvailability() async {
    guard cloudSupported else {
      cloudAvailable = false
      return
    }
    let host = activeHostProfile?.hostIdentity
    let access = try? await cloudRead("access", as: CloudPhoneAccess.self)
    let enabled = access?.enabled ?? false
    guard isAttached, activeHostProfile?.hostIdentity == host else { return }
    cloudAvailable = enabled
    // Which computers are ADE Cloud ones: their work always lists. A clear
    // "no access" empties the list; no answer keeps the saved one.
    if enabled {
      if let list = try? await cloudRead("list", as: CloudPhoneList.self),
         isAttached, activeHostProfile?.hostIdentity == host {
        setCloudMachines(list.machines)
      }
    } else if access != nil {
      setCloudMachines([])
    }
  }

  /// Wakes the cloud box behind an account machine before the phone dials
  /// it, through the machine the phone is on now, else through another
  /// connected machine that can send cloud commands, else through the
  /// account server itself. `name` is the computer's name for the failure
  /// message.
  func wakeCloudMachineIfNeeded(machineKey: String?, name: String) async -> CloudWakeResult {
    guard let machineKey = syncNonEmpty(machineKey) else { return .skipped }
    // Each way is tried in turn: a computer that could not send it (an
    // older one, one whose own server call failed) leaves it to the next.
    if cloudSupported, connectionState == .connected,
       let list = try? await cloudRead("list", as: CloudPhoneList.self),
       let box = list.machines.first(where: { $0.machineKey == machineKey }) {
      if box.isAwake { return .started }
      if (try? await cloudWrite("wake", args: ["machine": box.instanceId], as: CloudPhoneAck.self)) != nil { return .started }
    }
    if let fleet = machineFleet,
       let connection = fleet.liveMachineKeys.lazy
         .compactMap({ fleet.connection(for: $0) })
         .first(where: { $0.supportsAction("cloud.read") && $0.supportsAction("cloud.write") }),
       let raw = try? await connection.sendCommand(
         action: "cloud.read",
         args: ["action": "list", "args": [String: Any]()],
         projectId: nil,
         projectRootPath: nil
       ),
       let list = machineConnectionDecode(raw, as: CloudPhoneList.self),
       let box = list.machines.first(where: { $0.machineKey == machineKey }) {
      if box.isAwake { return .started }
      if (try? await connection.sendCommand(
        action: "cloud.write",
        args: ["action": "wake", "args": ["machine": box.instanceId]],
        projectId: nil,
        projectRootPath: nil,
        timeoutNanoseconds: 120 * 1_000_000_000
      )) != nil { return .started }
    }
    // No connected computer sent it: the phone asks the account server.
    return await wakeCloudMachineThroughServer(machineKey: machineKey, name: name)
  }

}

// MARK: - ADE Cloud straight from the account server

/// How a wake of an ADE Cloud computer went.
/// What the account says about a computer that changes when it comes up: its
/// last heartbeat and the addresses it published. A pairing that failed is
/// worth another try once either one moves.
struct CloudPairingSignal: Equatable {
  let lastSeenAt: Double?
  let endpoints: [AccountMachineEndpoint]

  init(_ machine: AccountMachine) {
    lastSeenAt = machine.lastSeenAt
    endpoints = machine.reachableEndpoints
  }
}

enum CloudWakeResult: Equatable {
  /// It is awake, coming up, or the start was sent.
  case started
  /// It cannot wake now; the message says why, in words for the person.
  case failed(String)
  /// Not a cloud computer, or the account changed meanwhile: nothing to say.
  case skipped
}

// The phone asks the account server itself, with its own account sign-in,
// for what a sleeping ADE Cloud computer cannot answer: the computers
// (`GET /cloud/instances`), their saved chats (`GET /cloud/chats`) and a wake
// (`POST /cloud/instances/:id/start`). The desktop uses the same routes. No
// connected computer is needed, so the work of a computer this phone never
// connected to still lists, and opening it wakes the computer.

/// One ADE Cloud computer as the account server lists it.
struct CloudServerInstance: Decodable, Equatable {
  let id: String
  let name: String?
  let status: String
  let pastDue: Bool
  let metadata: [String: String]

  private enum CodingKeys: String, CodingKey { case id, name, status, pastDue, metadata }

  init(id: String, name: String?, status: String, pastDue: Bool, metadata: [String: String]) {
    self.id = id
    self.name = name
    self.status = status
    self.pastDue = pastDue
    self.metadata = metadata
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = c.lenient(String.self, forKey: .name)
    status = c.lenient(String.self, forKey: .status) ?? ""
    pastDue = c.lenient(Bool.self, forKey: .pastDue) ?? false
    metadata = c.lenient([String: String].self, forKey: .metadata) ?? [:]
  }

  private func fact(_ key: String) -> String? {
    metadata[key].flatMap { nonEmptyTrimmed($0) }
  }

  /// The ADE machine on it (`ade_machine_key`), once that machine joined.
  var machineKey: String? { fact("ade_machine_key") }
  /// The lane it was made for (`ade_lane_id`, `ade_lane_name`), if any.
  var laneId: String? { fact("ade_lane_id") }
  var laneName: String? { fact("ade_lane_name") }
  /// The lane's project (`github.com/owner/repo`).
  var projectOrigin: String? { fact("ade_project_origin")?.lowercased() }
  var isAwake: Bool { status == "running" }
  /// Already starting: its ADE answers soon, with no wake of its own.
  var isComingUp: Bool { status == "starting" || status == "waking" }
  var isGone: Bool { status == "deleted" }
}

/// The server's saved copy of one chat of an ADE Cloud computer.
struct CloudSavedChatRow: Decodable, Equatable {
  let machineKey: String
  let chatId: String
  let instanceId: String?
  let title: String?
  let laneId: String?
  let laneName: String?
  let toolType: String?
  let provider: String?
  let model: String?
  /// The repository (`github.com/owner/repo`).
  let projectKey: String?
  /// The computer's own id and folder for the project.
  let projectId: String?
  let projectRoot: String?
  let lastActivityAt: String?
  /// When the computer last saved it (ms).
  let updatedAt: Double

  private enum CodingKeys: String, CodingKey {
    case machineKey, chatId, instanceId, title, laneId, laneName, toolType, provider, model
    case projectKey, projectId, projectRoot, lastActivityAt, updatedAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    machineKey = try c.decode(String.self, forKey: .machineKey)
    chatId = try c.decode(String.self, forKey: .chatId)
    instanceId = c.lenient(String.self, forKey: .instanceId)
    title = c.lenient(String.self, forKey: .title)
    laneId = c.lenient(String.self, forKey: .laneId)
    laneName = c.lenient(String.self, forKey: .laneName)
    toolType = c.lenient(String.self, forKey: .toolType)
    provider = c.lenient(String.self, forKey: .provider)
    model = c.lenient(String.self, forKey: .model)
    projectKey = c.lenient(String.self, forKey: .projectKey)
    projectId = c.lenient(String.self, forKey: .projectId)
    projectRoot = c.lenient(String.self, forKey: .projectRoot)
    lastActivityAt = c.lenient(String.self, forKey: .lastActivityAt)
    updatedAt = c.lenient(Double.self, forKey: .updatedAt) ?? 0
  }
}

/// The account server's ADE Cloud routes: one bearer, a 12-second timeout
/// (a wake waits longer), one retry after a 401 with a fresh token.
struct CloudServerClient {
  enum Failure: Error, Equatable {
    /// The account has no ADE Cloud (the server answers 404 off its list).
    case noAccess
    case unauthorized
    case server(Int, message: String?)
    case transport
    case unreadable
  }

  var baseURL: URL
  var token: String
  var refreshToken: (() async -> String?)?
  var session: URLSession = .adeAccount

  private struct InstanceList: Decodable { let data: [CloudServerInstance] }
  private struct ChatList: Decodable { let chats: [CloudSavedChatRow] }
  /// `{ error: { code, message } }` (`cloud/http.ts` `fail`).
  private struct ErrorBody: Decodable {
    struct Detail: Decodable { let message: String? }
    let error: Detail?
  }

  func instances() async throws -> [CloudServerInstance] {
    try decode(InstanceList.self, from: try await send("GET", "cloud/instances")).data
  }

  /// The newest 500 saved chats of the account's computers.
  func savedChats() async throws -> [CloudSavedChatRow] {
    try decode(ChatList.self, from: try await send("GET", "cloud/chats", query: [URLQueryItem(name: "limit", value: "500")])).chats
  }

  func start(instanceId: String) async throws {
    _ = try await send("POST", "cloud/instances/\(instanceId)/start", body: Data("{}".utf8), timeout: 120)
  }

  private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do { return try JSONDecoder().decode(type, from: data) } catch { throw Failure.unreadable }
  }

  /// One call to the account server; `AccountCloudLaunches.swift` adds the launch routes.
  func send(
    _ method: String,
    _ path: String,
    query: [URLQueryItem] = [],
    body: Data? = nil,
    timeout: TimeInterval = 12
  ) async throws -> Data {
    var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
    if !query.isEmpty { components?.queryItems = query }
    guard let url = components?.url else { throw Failure.transport }
    let correlationID = UUID().uuidString.lowercased()
    func once(_ bearer: String) async throws -> (Data, HTTPURLResponse) {
      var request = URLRequest(url: url)
      request.httpMethod = method
      request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.setValue(correlationID, forHTTPHeaderField: "X-ADE-Correlation-ID")
      if let body {
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      }
      request.timeoutInterval = timeout
      request.cachePolicy = .reloadIgnoringLocalCacheData
      do {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.transport }
        return (data, http)
      } catch let failure as Failure {
        throw failure
      } catch {
        throw Failure.transport
      }
    }
    var (data, http) = try await once(token)
    if http.statusCode == 401, let refreshToken,
       let fresh = await refreshToken().flatMap({ nonEmptyTrimmed($0) }) {
      (data, http) = try await once(fresh)
    }
    switch http.statusCode {
    case 200..<300: return data
    case 401, 403: throw Failure.unauthorized
    case 404: throw Failure.noAccess
    default: throw Failure.server(http.statusCode, message: (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error?.message.flatMap { nonEmptyTrimmed($0) })
    }
  }
}

@MainActor
extension SyncService {
  /// How often the phone asks the account server at most. Asked when the
  /// account's machine list loads (sign-in, the app coming back to the
  /// front), never on a timer.
  static let cloudServerReadFloor: TimeInterval = 30

  /// A client for the account server with this phone's sign-in, or nil when
  /// signed out or not configured.
  func cloudServerClient() async -> CloudServerClient? {
    guard let baseURL = AccountConfig.directoryBaseURL else { return nil }
    let account = AccountService.shared
    guard let session = await account.pairingSession() else { return nil }
    return CloudServerClient(baseURL: baseURL, token: session.token, refreshToken: {
      guard account.isPairingCommitAuthorized(session.authorization) else { return nil }
      return try? await account.freshRelaySession(expectedAuthorization: session.authorization).token
    })
  }

  /// Forgets the last account's ADE Cloud computers and saved chats (an
  /// account change), so the next account reads its own at once.
  func clearCloudServerCache() {
    cloudServerReadTask?.cancel()
    cloudServerReadTask = nil
    cloudServerReadAt = nil
    cloudServerInstances = []
    cloudSavedChats = []
    // The last account's chat launches from this phone go too.
    AccountCloudLaunchStore.shared.reset()
    // The last account's ADE Cloud computers and wake messages go too.
    setCloudMachines([])
    cloudAccountMachineKeys = nil
    clearCloudWakeFailures()
  }

  /// Reads the account's ADE Cloud computers and their saved chats from the
  /// account server, unless it was read in the last 30 seconds.
  func refreshCloudServerIfStale(force: Bool = false) {
    guard cloudServerReadTask == nil, AccountService.shared.isSignedIn else { return }
    if !force, let at = cloudServerReadAt, Date().timeIntervalSince(at) < Self.cloudServerReadFloor { return }
    cloudServerReadAt = Date()
    cloudServerReadTask = Task { @MainActor [weak self] in
      await self?.readCloudServer()
      // A cancelled read (an account change) leaves a newer read in place.
      if !Task.isCancelled { self?.cloudServerReadTask = nil }
    }
  }

  private func readCloudServer() async {
    guard let client = await cloudServerClient(),
          let owner = AccountService.shared.currentPairingAuthorization else { return }
    let instances: [CloudServerInstance]?
    do {
      instances = try await client.instances()
    } catch CloudServerClient.Failure.noAccess {
      instances = []
    } catch {
      // No answer (a server with no provider, the network): the saved chats
      // still list; the last list stays for a wake.
      cloudServerLog.error("cloud_server read=instances failed error=\(String(describing: error), privacy: .public)")
      instances = nil
    }
    let chats: [CloudSavedChatRow]?
    do {
      chats = try await client.savedChats()
    } catch CloudServerClient.Failure.noAccess {
      chats = []
    } catch {
      cloudServerLog.error("cloud_server read=chats failed error=\(String(describing: error), privacy: .public)")
      chats = nil
    }
    // An account switch while it read: the answer is the old account's.
    guard !Task.isCancelled, AccountService.shared.isPairingCommitAuthorized(owner) else { return }
    if let instances { cloudServerInstances = instances.filter { !$0.isGone } }
    if let chats { cloudSavedChats = chats }
    guard instances != nil || chats != nil else { return }
    // Every computer that saves chats is an ADE Cloud computer: its work
    // always lists. A connected computer's cloud list says the same.
    // `resolveCloudMachineKeys` adds the computers named here to the list.
    if instances?.isEmpty == true, chats?.isEmpty == true, cloudAccountMachineKeys == nil {
      setCloudMachines([])
    } else {
      resolveCloudMachineKeys()
    }
    machineFleet?.cloudServerChanged()
  }

  /// Wakes an ADE Cloud computer through the account server, with no other
  /// computer: finds it by its machine key and asks the server to start it.
  /// `name` is the computer's name for the failure message.
  func wakeCloudMachineThroughServer(machineKey: String, name: String) async -> CloudWakeResult {
    guard let client = await cloudServerClient(),
          let owner = AccountService.shared.currentPairingAuthorization
    else { return .failed("Sign in to ADE to wake \(name).") }
    var listed = false
    do {
      let instances = try await client.instances()
      listed = true
      // An account change while it read: the list is the old account's.
      guard AccountService.shared.isPairingCommitAuthorized(owner) else { return .skipped }
      cloudServerInstances = instances.filter { !$0.isGone }
      guard let box = instances.first(where: { !$0.isGone && $0.machineKey == machineKey }) else {
        return .failed("\(name) is no longer on this account's ADE Cloud.")
      }
      if box.isAwake || box.isComingUp { return .started }
      // The server refuses a suspended computer itself.
      if box.pastDue { return .failed("\(name) can't wake: the ADE Cloud bill is past due.") }
      try await client.start(instanceId: box.id)
      return .started
    } catch let failure as CloudServerClient.Failure {
      switch failure {
      case .noAccess:
        // After a good list, a 404 is the computer, not the account.
        return .failed(listed
          ? "\(name) is no longer on this account's ADE Cloud."
          : "This account has no ADE Cloud access, so \(name) can't wake.")
      case .unauthorized: return .failed("ADE Cloud did not accept this sign-in. Sign in again to wake \(name).")
      case .transport: return .failed("ADE Cloud did not answer. Check the connection and try again.")
      case .unreadable: return .failed("ADE Cloud sent an answer this app can't read.")
      case .server(let status, let message):
        return .failed(message ?? "ADE Cloud could not wake \(name) (error \(status)).")
      }
    } catch {
      return .failed("ADE Cloud did not answer. Check the connection and try again.")
    }
  }

  // MARK: Rows of a computer this phone holds no link to

  /// The fleet key and name of each ADE Cloud computer with saved chats or a
  /// lane that this phone has no connection to, with the rows its saved
  /// copies give. `skip` holds the keys the fleet already lists.
  func restingCloudMachineRows(skip: Set<String>) -> [(fleetKey: String, name: String, projects: [RemoteRosterProject])] {
    let accountMachines = AccountService.shared.machines
    var byMachine: [String: [CloudSavedChatRow]] = [:]
    for row in cloudSavedChats { byMachine[row.machineKey, default: []].append(row) }
    var laneOnly: [String: CloudServerInstance] = [:]
    for box in cloudServerInstances {
      guard let key = box.machineKey, box.laneId != nil, box.projectOrigin != nil else { continue }
      laneOnly[key] = box
    }
    var out: [(fleetKey: String, name: String, projects: [RemoteRosterProject])] = []
    for machineKey in Set(byMachine.keys).union(laneOnly.keys).sorted() {
      guard let machine = accountMachines.first(where: { $0.machineKey == machineKey }),
            let deviceId = nonEmptyTrimmed(machine.deviceId) else { continue }
      let fleetKey = HiddenMachineStore.fleetKey(deviceId: deviceId)
      guard !skip.contains(fleetKey), fleetKey != focusedMachineKey,
            !HiddenMachineStore.shared.isHidden(identity: deviceId.lowercased()) else { continue }
      let projects = cloudSavedRosterProjects(rows: byMachine[machineKey] ?? [], box: laneOnly[machineKey])
      guard !projects.isEmpty else { continue }
      let box = cloudServerInstances.first { $0.machineKey == machineKey }
      out.append((fleetKey, machine.displayName.isEmpty ? (box?.laneName ?? "ADE Cloud") : machine.displayName, projects))
    }
    return out
  }

  /// The saved copies of one ADE Cloud computer's account-server rows as roster
  /// projects, for a connection whose own roster is still empty.
  func cloudSavedRosterProjects(fleetKey: String) -> [RemoteRosterProject] {
    guard let machineKey = AccountService.shared.machine(forFleetKey: fleetKey)?.machineKey else { return [] }
    let box = cloudServerInstances.first { $0.machineKey == machineKey && $0.laneId != nil }
    return cloudSavedRosterProjects(rows: cloudSavedChats.filter { $0.machineKey == machineKey }, box: box)
  }

  /// One roster project per repository: its lanes and its chats, as the
  /// computer last saved them. A lane computer with no saved chat still
  /// shows its lane. Rows with no repository are left out (they belong to no
  /// project's list).
  private func cloudSavedRosterProjects(rows: [CloudSavedChatRow], box: CloudServerInstance?) -> [RemoteRosterProject] {
    var order: [String] = []
    var projects: [String: RemoteRosterProject] = [:]
    func project(for origin: String, projectId: String?, root: String?) -> RemoteRosterProject {
      if let existing = projects[origin] { return existing }
      order.append(origin)
      let name = origin.split(separator: "/").last.map(String.init) ?? origin
      return RemoteRosterProject(
        projectId: projectId ?? origin,
        rootPath: root,
        displayName: name,
        iconDataUrl: nil,
        lastOpenedAt: nil,
        booted: false,
        runningCount: 0,
        attentionCount: 0,
        lanes: [],
        chats: [],
        repoOriginUrl: origin
      )
    }
    for row in rows.sorted(by: { $0.updatedAt > $1.updatedAt }) {
      guard let origin = row.projectKey.flatMap({ nonEmptyTrimmed($0) })?.lowercased() else { continue }
      var entry = project(for: origin, projectId: nonEmptyTrimmed(row.projectId), root: nonEmptyTrimmed(row.projectRoot))
      let laneId = nonEmptyTrimmed(row.laneId) ?? "saved-chats"
      if !entry.lanes.contains(where: { $0.id == laneId }) {
        entry.lanes.append(RemoteRosterLane(id: laneId, name: nonEmptyTrimmed(row.laneName) ?? "Saved chats", color: nil, icon: nil, laneType: "worktree", branchRef: nil))
      }
      if !entry.chats.contains(where: { $0.id == row.chatId }) {
        let activity = nonEmptyTrimmed(row.lastActivityAt)
          ?? ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: row.updatedAt / 1000))
        entry.chats.append(RemoteRosterChat(
          id: row.chatId,
          laneId: laneId,
          title: nonEmptyTrimmed(row.title) ?? "Saved chat",
          provider: row.provider,
          model: row.model,
          toolType: nonEmptyTrimmed(row.toolType) ?? "claude-chat",
          status: .idle,
          lastActivityAt: activity
        ))
      }
      projects[origin] = entry
    }
    if let box, let laneId = box.laneId, let origin = box.projectOrigin {
      var entry = project(for: origin, projectId: nil, root: nil)
      if !entry.lanes.contains(where: { $0.id == laneId }) {
        entry.lanes.append(RemoteRosterLane(id: laneId, name: box.laneName ?? "Cloud lane", color: nil, icon: nil, laneType: "worktree", branchRef: nil))
      }
      projects[origin] = entry
    }
    return order.compactMap { projects[$0] }
  }

  /// Opens a link to an ADE Cloud computer this phone never paired: wakes it
  /// through the account server, waits for the account to list it online,
  /// then pairs it next to the primary (the primary is never touched).
  /// `.skipped` when it is not one or the account changed meanwhile.
  ///
  /// `waking` says the phone just asked the computer to start. Its last
  /// heartbeat from before it slept can still read "online" for a while, and
  /// its ADE answers only once it is up, so a failed pairing is tried again
  /// (after a new heartbeat, a new address, or 15 s) until the wake time ends.
  func pairRestingCloudMachine(fleetKey: String, name: String, waking: Bool = false) async -> CloudWakeResult {
    guard machineFleet?.connection(for: fleetKey) == nil,
          let accountKey = AccountService.shared.machine(forFleetKey: fleetKey)?.machineKey,
          cloudMachineFleetKeys.contains(fleetKey),
          let owner = AccountService.shared.currentPairingAuthorization
    else { return .skipped }
    func current() -> AccountMachine? {
      AccountService.shared.machines.first { $0.machineKey == accountKey }
    }
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: Self.cloudWakeConnectTimeout)
    var lastFailure: String?
    var lastAttempt: (at: ContinuousClock.Instant, signal: CloudPairingSignal)?
    while !Task.isCancelled {
      guard AccountService.shared.isPairingCommitAuthorized(owner) else { return .skipped }
      if let machine = current(), machine.online {
        let signal = CloudPairingSignal(machine)
        let due = lastAttempt.map { attempt in
          attempt.signal != signal || clock.now >= attempt.at.advanced(by: .seconds(15))
        } ?? true
        if due {
          lastAttempt = (clock.now, signal)
          cloudServerLog.notice("ADE_SYNC_TRACE cloud_pair attempt waking=\(waking) endpoints=\(machine.reachableEndpoints.count)")
          // The caller adds it to the connected set, after it checked that no
          // newer choice was made during the wait.
          switch await pairAccountMachineAlongsidePrimary(machine, authorization: owner, keepConnected: false) {
          case .success: return .started
          case .failure(let failure):
            lastFailure = failure.message
            cloudServerLog.notice("ADE_SYNC_TRACE cloud_pair failed reason=\(failure.message, privacy: .public)")
          }
          // Not woken by this open: the computer was up, so its answer stands.
          if !waking { break }
        }
      }
      guard clock.now < deadline, !Task.isCancelled else { break }
      try? await Task.sleep(for: .seconds(3))
      await AccountService.shared.loadMachines()
    }
    guard !Task.isCancelled, AccountService.shared.isPairingCommitAuthorized(owner) else { return .skipped }
    // A computer that is still starting is not a network problem on the
    // phone: say it did not answer, never the local-network advice.
    if waking || lastFailure == nil {
      return .failed("\(name) did not answer within 2 minutes. Try again.")
    }
    return .failed(lastFailure ?? "\(name) did not answer. Try again.")
  }
}

@MainActor
extension SyncService {
  /// Whether the account has a computer of the person's own: an account
  /// machine that is not one of the account's ADE Cloud computers. A chat
  /// on ADE Cloud from the phone is offered without one.
  func accountHasOwnComputer(_ machines: [AccountMachine]) -> Bool {
    var cloudKeys = Set(cloudServerInstances.compactMap { $0.machineKey?.lowercased() })
    for key in cloudAccountMachineKeys ?? [] { cloudKeys.insert(key.lowercased()) }
    return machines.contains { !cloudKeys.contains($0.machineKey.lowercased()) }
  }
}
