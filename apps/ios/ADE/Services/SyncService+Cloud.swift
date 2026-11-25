import Foundation
import OSLog

let cloudServerLog = Logger(subsystem: "com.ade.ios", category: "cloud")

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
  /// Codable: a direct read hands the account server's copy to the page.
  struct DiskUsage: Codable, Equatable {
    struct Part: Codable, Equatable {
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

  /// How many cloud computers the account has (asleep or not) and how many
  /// are awake. `limit` is the plan's computer limit (read it through
  /// `CloudPhoneAccount.computerLimit`); `nextPlan` is the next plan up and
  /// its limit (`CloudNextPlan`), nil on Max. The same object a
  /// `computer_limit` refusal carries.
  struct Computers: Decodable, Equatable {
    let total: Int
    let awake: Int
    let limit: Int?
    let nextPlan: CloudComputerLimit.NextPlan?

    private enum CodingKeys: String, CodingKey { case total, awake, limit, nextPlan }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      total = try c.decode(Int.self, forKey: .total)
      awake = try c.decode(Int.self, forKey: .awake)
      limit = c.lenient(Int.self, forKey: .limit)
      nextPlan = c.lenient(CloudComputerLimit.NextPlan.self, forKey: .nextPlan)
    }
  }

  /// The ADE Cloud iPhone's access for this account (`CloudAccountPhone`):
  /// `on`, else nothing of it shows. Older servers sent `soon`.
  struct Phone: Decodable, Equatable {
    let access: String
    /// The credits the iPhone used this period, in thousandths. The
    /// computers' share is the rest of `hours.usedMilli`. Nil from an older
    /// server.
    let creditsUsedMilli: Int?
    /// A tester's pick of who runs their phones (`auto`, `nomac`, `revyl`):
    /// sent only to accounts on the iPhone's beta list, which may change it
    /// (`POST /cloud/phone/provider`). Nil for everyone else.
    let providerChoice: String?

    private enum CodingKeys: String, CodingKey { case access, creditsUsedMilli, providerChoice }

    init(access: String, creditsUsedMilli: Int? = nil, providerChoice: String? = nil) {
      self.access = access
      self.creditsUsedMilli = creditsUsedMilli
      self.providerChoice = providerChoice
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      access = try c.decode(String.self, forKey: .access)
      creditsUsedMilli = c.lenient(Int.self, forKey: .creditsUsedMilli)
      providerChoice = c.lenient(String.self, forKey: .providerChoice).flatMap { nonEmptyTrimmed($0) }
    }
  }

  /// Credits (`CloudAccountState.credits`): `hours` is one balance of
  /// credits, in thousandths (a Medium computer uses one an hour), and the
  /// ADE Cloud iPhone draws from it at `phoneMilliPerMinute` a minute.
  struct Credits: Decodable, Equatable {
    let phoneMilliPerMinute: Int
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
    /// `out_of_hours`, or `over_plan_disk` from a server before Pricing v2.
    let reason: String
  }

  /// A computer the idle cleanup warned about, or kept because its work
  /// couldn't be saved (`CloudIdleCleanupEntry`). The phone shows the warning
  /// and how to keep it; "Keep it" is on the computer's page.
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
  /// shows it (App Store rule: the iPhone app does not sell plans). `diskGb`
  /// is for older builds only and is not read.
  struct PlanFacts: Decodable, Equatable {
    /// A month's hours for the sizes bigger than Small, in thousandths of a
    /// Medium-hour. Small computers never use them.
    let includedMilli: Int
    /// How many cloud computers the plan allows, asleep or not.
    let computerLimit: Int?
    /// Extra hours past the plan are sold on it (never shown as a price).
    let extraHourCents: Double?
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
  /// `var` so a read that started before a provider pick keeps the pick (`AccountCloudStore.setPhoneProvider`).
  var phone: Phone?
  /// The iPhone's rate of the credits (`CloudBalanceWords`). Always credits:
  /// absent (an older server) reads as one credit a minute.
  let credits: Credits?
  /// Sponsored cards in this account's ADE Cloud chats (`CloudSponsoredState`).
  /// Absent while the server's switch doesn't reach the account: nothing
  /// shows. A consent answer replaces it (`AccountCloudStore.noteSponsored`).
  var sponsored: CloudSponsoredState?

  private enum CodingKeys: String, CodingKey {
    case plan, planId, hours, extraHours, disk, computers, recentUse, billing, catalog
    case earnedHours, freePlan, planCleanup, planCleanupDone, timedWakesCancelled, dueForDeletion, referral, phone, credits, sponsored
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
    phone = c.lenient(Phone.self, forKey: .phone)
    // A rate of 0 or less is no rate: read as absent (one credit a minute) rather than divide by it.
    credits = c.lenient(Credits.self, forKey: .credits).flatMap { $0.phoneMilliPerMinute > 0 ? $0 : nil }
    sponsored = c.lenient(CloudSponsoredState.self, forKey: .sponsored)
  }

  /// The plan's computer limit (`docs/plans/pricing-v2-and-gravity.md`).
  var computerLimit: Int? {
    guard let limit = computers?.limit, limit > 0 else { return nil }
    return limit
  }

  /// Every cloud computer the plan allows is taken: a new lane is refused.
  var atComputerLimit: Bool {
    guard let limit = computerLimit, let total = computers?.total else { return false }
    return total >= limit
  }

  /// The ADE Cloud iPhone is on for this account. Anything else (`off`, an
  /// older server's `soon`, no answer) shows nothing of it.
  var phoneOn: Bool { phone?.access == "on" }

  /// Out of credits for this period, as the server counts it.
  var outOfHours: Bool { hours.state == "zero" }

  /// The account counts in credits: one balance the ADE Cloud iPhone draws from too.
  var usesCredits: Bool { credits != nil }

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
  /// Older apps' limit on paid extra disk (no longer sold since Pricing v2), in cents a month. Kept as saved; never a limit.
  let extraDiskMonthCents: Int?
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

// `CloudServerInstance`, `CloudSavedChatRow` and `CloudServerClient` live in
// `CloudServerClient.swift`.

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
    cloudServerReadFinished = false
    cloudServerLastReadFailed = false
    cloudServerInstances = []
    cloudSavedChats = []
    cloudDeletedLaneTicks = [:]
    // The last account's chat launches from this phone go too.
    AccountCloudLaunchStore.shared.reset()
    // And its ADE Cloud account state, held messages and saved transcripts.
    AccountCloudStore.shared.reset()
    // And its saved Git summaries, CLI and shell copies, and Linear answers.
    CloudAtRestStore.shared.reset()
    AccountLinearCache.shared.reset()
    // An account project scope is the last account's project.
    clearAccountProjectScope()
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

  /// Reads the account's ADE Cloud computers and state now and waits for the answer (a launch's new computer, a
  /// rate the server just moved); a read already out ends first, since it may predate the change.
  func refreshCloudServerInstances() async {
    // A read already out may have started before the launch: let it end, then read again.
    await cloudServerReadTask?.value
    refreshCloudServerIfStale(force: true)
    await cloudServerReadTask?.value
  }

  /// The server deleted this lane and its saved chats: they leave the lists
  /// now, and a read that started before the delete can't bring them back.
  /// `onlyChats`: a move deleted only these saved chats (by chat id) of the
  /// lane's computer `machineKey`; the lane's other saved chats stay listed.
  func noteCloudLaneDeleted(_ laneId: String, onlyChats: Set<String>? = nil, machineKey: String? = nil) {
    cloudLaneDeleteTick &+= 1
    let gone: (CloudSavedChatRow) -> Bool
    if let onlyChats {
      for chatId in onlyChats {
        cloudDeletedLaneTicks[Self.deletedChatKey(machineKey: machineKey, chatId: chatId)] = cloudLaneDeleteTick
      }
      gone = { row in onlyChats.contains(row.chatId) && (machineKey == nil || row.machineKey == machineKey) }
    } else {
      cloudDeletedLaneTicks[laneId] = cloudLaneDeleteTick
      gone = { $0.laneId == laneId }
    }
    guard cloudSavedChats.contains(where: gone) else { return }
    cloudSavedChats.removeAll(where: gone)
    objectWillChange.send()
    resolveCloudMachineKeys()
  }

  /// The `cloudDeletedLaneTicks` key of one deleted saved chat; lane keys are plain lane ids.
  private static func deletedChatKey(machineKey: String?, chatId: String) -> String {
    "chat:\(machineKey ?? "")/\(chatId)"
  }

  /// The newest delete that covers the row: its lane's, or its own chat's
  /// (by machine, or with no machine). An older lane delete must not hide a
  /// newer chat delete.
  private func deletedTick(of row: CloudSavedChatRow) -> UInt64? {
    [
      row.laneId.flatMap { cloudDeletedLaneTicks[$0] },
      cloudDeletedLaneTicks[Self.deletedChatKey(machineKey: row.machineKey, chatId: row.chatId)],
      cloudDeletedLaneTicks[Self.deletedChatKey(machineKey: nil, chatId: row.chatId)],
    ].compactMap { $0 }.max()
  }

  private func readCloudServer() async {
    guard let client = await cloudServerClient(),
          let owner = AccountService.shared.currentPairingAuthorization else { return }
    // Lanes deleted after this tick are newer than this read's answer.
    let startTick = cloudLaneDeleteTick
    // The account's state (hours, deleting soon, lanes without a computer)
    // reads beside the computers, on the same trigger.
    async let accountState: Void = AccountCloudStore.shared.refresh(client: client, owner: owner)
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
    // The open project's at-rest view (its CLI and shell copies, Git counts)
    // in one read. An older server answers 404 and today's rows stay.
    if let origin = cloudProjectOrigin {
      await CloudAtRestStore.shared.refreshOverview(origin: origin, client: client)
    }
    await accountState
    // An account switch while it read: the answer is the old account's.
    guard !Task.isCancelled, AccountService.shared.isPairingCommitAuthorized(owner) else { return }
    cloudServerLastReadFailed = instances == nil
    if instances != nil, !cloudServerReadFinished {
      // Views that tell own computers from cloud ones read again now. A
      // failed read leaves it unset: an unknown computer is not yet the
      // person's own.
      cloudServerReadFinished = true
      objectWillChange.send()
    }
    if let instances {
      cloudServerInstances = instances.filter { !$0.isGone }
      // Note these computers as ADE Cloud: every machine row names them "ADE Cloud".
      CloudLaneComputerLabels.noteServerInstances(cloudServerInstances)
      // The focused cloud computer is no longer on the account server: the
      // account's machine list still names it until it reads again, and that
      // read is how the phone leaves it (`resolveCloudMachineKeys`).
      if let focusedKey = focusedMachineKey, isCloudFleetKey(focusedKey),
         cloudServerInstance(fleetKey: focusedKey) == nil,
         AccountService.shared.machine(forFleetKey: focusedKey) != nil {
        Task { await AccountService.shared.loadMachines() }
      }
    }
    if let chats {
      cloudSavedChats = chats.filter { row in
        guard let tick = deletedTick(of: row) else { return true }
        return tick <= startTick
      }
      // The deletes this read started after are the server's answer now.
      cloudDeletedLaneTicks = cloudDeletedLaneTicks.filter { $0.value > startTick }
    }
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
    probeFocusedLinkIfCloudComputerRests()
    leaveDeletedFocusedCloudComputer()
  }

  /// Every fleet key that has left this phone's ADE Cloud computer set (a
  /// deleted computer, or one before this build). Only grows (capped): the
  /// live set drops a deleted computer, and this is how the phone still knows
  /// the focused machine was one.
  static let seenCloudFleetKeysDefaultsKey = "ade.cloudFleetKeysSeen.v1"

  func rememberSeenCloudFleetKeys(_ keys: Set<String>) {
    guard !keys.isEmpty else { return }
    var seen = UserDefaults.standard.stringArray(forKey: Self.seenCloudFleetKeysDefaultsKey) ?? []
    let fresh = keys.subtracting(seen).sorted()
    guard !fresh.isEmpty else { return }
    seen.append(contentsOf: fresh)
    // Bounded, but never past the focused machine: it is the one the
    // deleted-computer check needs.
    if seen.count > 500 {
      let focused = focusedMachineKey.flatMap { seen.contains($0) ? $0 : nil }
      seen = Array(seen.suffix(500))
      if let focused, !seen.contains(focused) { seen.append(focused) }
    }
    UserDefaults.standard.set(seen, forKey: Self.seenCloudFleetKeysDefaultsKey)
  }

  /// Drops fleet keys the server shows are the person's own machines from
  /// the seen record. True when one was there.
  @discardableResult
  func forgetSeenCloudFleetKeys(_ keys: Set<String>) -> Bool {
    guard !keys.isEmpty else { return false }
    let seen = UserDefaults.standard.stringArray(forKey: Self.seenCloudFleetKeysDefaultsKey) ?? []
    let kept = seen.filter { !keys.contains($0) }
    guard kept.count != seen.count else { return false }
    UserDefaults.standard.set(kept, forKey: Self.seenCloudFleetKeysDefaultsKey)
    return true
  }

  /// The focused machine was an ADE Cloud computer the account has since
  /// deleted: this phone saw it as one, and the account's computers no
  /// longer include it. Its cached lanes and chats belong to a computer
  /// that is gone, so they are not listed.
  var focusedIsDeletedCloudComputer: Bool {
    guard let focusedKey = focusedMachineKey, !cloudMachineFleetKeys.contains(focusedKey) else { return false }
    return (UserDefaults.standard.stringArray(forKey: Self.seenCloudFleetKeysDefaultsKey) ?? []).contains(focusedKey)
  }

  /// The deleted focused computers this launch has left. Once left (and no
  /// longer linked), `forgetDeletedCloudComputerPairings` forgets that pairing
  /// too, focused or not.
  @MainActor enum DeletedFocusedCloudComputer { static var left: Set<String> = [] }

  /// The project open on this phone was on an ADE Cloud computer the account
  /// has since deleted (its lane was deleted, here or on another device). A
  /// cold start restored it with its cached lanes, which read as if it were
  /// only offline: show the Hub instead, where the project opens elsewhere.
  /// Checked on every account list and cloud read, so a check that cannot
  /// tell yet (still connected, list not loaded) is simply made again. An
  /// offline computer of the person's own is never left this way (it was
  /// never an ADE Cloud computer).
  func leaveDeletedFocusedCloudComputer() {
    let account = AccountService.shared
    guard let focusedKey = focusedMachineKey,
          account.machinesState == .loaded,
          account.machine(forFleetKey: focusedKey) == nil,
          focusedIsDeletedCloudComputer
    else { return }
    // The relay can hold a deleted computer's link half-open: prove it is
    // gone first. The drop calls this again.
    if connectionState == .connected {
      probeFocusedLinkIfCloudComputerRests()
      return
    }
    // Once per computer per launch: a person who opens it again stays.
    guard DeletedFocusedCloudComputer.left.insert(focusedKey).inserted else { return }
    // Another live computer takes the focus (its projects stay on the Hub);
    // with none, the Hub shows instead of the deleted computer's lanes.
    if let next = machineFleet?.machines.first(where: { $0.state == .live && !isCloudFleetKey($0.machineKey) })?.machineKey {
      cloudServerLog.notice("cloud_server focused_computer=deleted action=focus_live_machine")
      Task { @MainActor [weak self] in
        // The deleted computer is no longer focused: drop its pairing.
        guard await self?.switchFocus(toMachineKey: next) == true else { return }
        self?.forgetDeletedCloudComputerPairings()
      }
    } else {
      if !projectHubPresented, activeAccountProjectId == nil {
        cloudServerLog.notice("cloud_server focused_computer=deleted action=show_hub")
        showProjectHub()
      }
      // Its pairing goes too, or it reconnects to a computer that is gone.
      forgetDeletedCloudComputerPairings()
    }
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
      // The server said no and why (blocked, out of hours, too many awake): its sentence.
      case .refused(_, let message): return .failed(message)
      case .computerLimit(let limit): return .failed(limit.headline)
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
    // Indexed once per pass: an account with hundreds of cloud lanes must
    // not scan every list for every computer.
    var accountByKey: [String: AccountMachine] = [:]
    for machine in AccountService.shared.machines { accountByKey[machine.machineKey] = machine }
    var byMachine: [String: [CloudSavedChatRow]] = [:]
    for row in cloudSavedChats { byMachine[row.machineKey, default: []].append(row) }
    var laneOnly: [String: CloudServerInstance] = [:]
    var cloudKeys = Set<String>()
    for box in cloudServerInstances {
      guard let key = box.machineKey else { continue }
      cloudKeys.insert(key.lowercased())
      guard box.laneId != nil, box.projectOrigin != nil else { continue }
      laneOnly[key] = box
    }
    var out: [(fleetKey: String, name: String, projects: [RemoteRosterProject])] = []
    for machineKey in Set(byMachine.keys).union(laneOnly.keys).sorted() {
      // Only an ADE Cloud computer, live or deleted. A copy that moved to one
      // of the person's own machines (a lane moved off a sleeping computer)
      // has no computer on the server (`computer: null`): its machine lists
      // its own lanes, and a machine removed from the account is not a
      // deleted ADE Cloud computer. An older server sends no field and
      // decides nothing here.
      guard cloudKeys.contains(machineKey.lowercased())
        || byMachine[machineKey]?.allSatisfy(\.savedByNoCloudComputer) != true
      else { continue }
      let fleetKey: String
      if let machine = accountByKey[machineKey], let deviceId = nonEmptyTrimmed(machine.deviceId) {
        fleetKey = HiddenMachineStore.fleetKey(deviceId: deviceId)
        guard !HiddenMachineStore.shared.isHidden(identity: deviceId.lowercased()) else { continue }
      } else {
        // A computer that left the account (deleted): its saved chats still
        // list, read from the server, and a send continues them on a new
        // computer through the server's queue.
        guard byMachine[machineKey]?.isEmpty == false else { continue }
        fleetKey = cloudSavedFleetKey(accountMachineKey: machineKey)
      }
      guard !skip.contains(fleetKey), fleetKey != focusedMachineKey else { continue }
      let projects = cloudSavedRosterProjects(
        rows: byMachine[machineKey] ?? [],
        box: laneOnly[machineKey],
        sessions: CloudAtRestStore.shared.sessions(machineKey: machineKey)
      )
      guard !projects.isEmpty else { continue }
      // ADE Cloud is one machine to the person: never a computer's own name.
      out.append((fleetKey, ADECloudMachine.name, projects))
    }
    return out
  }

  /// The open project's cloud lanes, one row each, for a new chat on an
  /// existing cloud lane. Ids are namespaced to each lane's own computer
  /// (`workRemoteLaneId`). A cloud computer's main checkout is left out.
  func cloudLanesForActiveProject() -> [LaneSummary] {
    var seen = Set<String>()
    var out: [LaneSummary] = []
    for repo in listedRemoteReposForActiveProject() where isCloudFleetKey(repo.machineKey) {
      for lane in repo.lanes where lane.laneType != "primary" && lane.id != "saved-chats" {
        guard seen.insert(lane.id).inserted else { continue }
        var summary = lane.asLaneSummary()
        summary.id = workRemoteLaneId(machineKey: repo.machineKey, laneId: lane.id)
        out.append(summary)
      }
    }
    return out
  }

  /// Before opening a chat a launch just started: the server's list and the
  /// account's machines, both fresh. The launch made a new computer, and a
  /// machine list from before it would route the chat to a "deleted" copy.
  func readCloudForLaunchedChat() async {
    async let machines: Void = AccountService.shared.loadMachines()
    // A read already out may have started before the launch: it ends, then a new one runs.
    await refreshCloudServerInstances()
    await machines
  }

  /// The chat a cloud launch started now runs on its lane's new computer.
  /// This phone never paired that computer, and its project copy is not in
  /// the account list it read at the last foreground. So it reads the
  /// account again (machines, ADE Cloud computers, project copies), each
  /// read started after the launch ran, and connects the computer, with no
  /// wake. Then the computer's roster lists the chat in Work at once, not
  /// after the next app launch. True when the computer has a live link.
  @discardableResult
  func connectLaunchedCloudComputer(instanceId: String) async -> Bool {
    async let projects: Void = AccountProjectStore.shared.refresh()
    await readCloudForLaunchedChat()
    await projects
    guard let accountKey = cloudServerInstances.first(where: { $0.id == instanceId })?.machineKey else { return false }
    resolveCloudMachineKeys()
    let fleetKey = cloudFleetKey(accountMachineKey: accountKey)
    if fleetKey == focusedMachineKey {
      // The focused computer has its own link (the fleet's connect does not cover it).
      if connectionState != .connected { await reconnectIfPossible() }
      // The person may have picked another computer meanwhile: only this one counts.
      return focusedMachineKey == fleetKey && connectionState == .connected
    }
    guard let fleet = machineFleet else { return false }
    return await fleet.connect(machineKey: fleetKey, timeout: Self.launchedComputerConnectTimeout, wake: false)
  }

  /// How long a launch's new computer may take to answer its first connect.
  private static let launchedComputerConnectTimeout: Duration = .seconds(45)

  /// A pull on Lanes or Work: the account's machines and ADE Cloud computers
  /// read again, so a computer made since the last look (from the web,
  /// another phone, New computer) lists in the same pull. A read already out
  /// may have started before it existed, so it ends and a new one runs. The
  /// fleet publishes on the main queue after the reads; this returns once
  /// those publishes ran. False when either read got no answer.
  func readCloudForPull() async -> Bool {
    async let machines: Void = AccountService.shared.loadMachines()
    await refreshCloudServerInstances()
    await machines
    for _ in 0..<2 {
      await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in DispatchQueue.main.async { done.resume() } }
    }
    if case .unreachable = AccountService.shared.machinesState { return false }
    return !cloudServerLastReadFailed
  }

  /// The fleet key of a saved chat's computer that left the account: no
  /// device id names it, so its account machine key does.
  func cloudSavedFleetKey(accountMachineKey: String) -> String {
    ADECloudMachine.savedFleetKeyPrefix + accountMachineKey.lowercased()
  }

  /// The account machine key behind an ADE Cloud fleet key: the account's
  /// machine, or a computer that left the account (`cloudSavedFleetKey`).
  func cloudAccountMachineKey(fleetKey: String) -> String? {
    if fleetKey.hasPrefix(ADECloudMachine.savedFleetKeyPrefix) {
      return String(fleetKey.dropFirst(ADECloudMachine.savedFleetKeyPrefix.count))
    }
    return AccountService.shared.machine(forFleetKey: fleetKey)?.machineKey
  }

  /// Whether a fleet key names an ADE Cloud computer (asleep, awake or deleted).
  func isCloudFleetKey(_ fleetKey: String?) -> Bool {
    guard let fleetKey else { return false }
    return cloudMachineFleetKeys.contains(fleetKey) || fleetKey.hasPrefix(ADECloudMachine.savedFleetKeyPrefix)
  }

  /// The account server's row for the computer behind a fleet key.
  func cloudServerInstance(fleetKey: String?) -> CloudServerInstance? {
    guard let fleetKey, let accountKey = cloudAccountMachineKey(fleetKey: fleetKey) else { return nil }
    return cloudServerInstances.first { $0.machineKey?.lowercased() == accountKey.lowercased() }
  }

  /// The saved copies of one ADE Cloud computer's account-server rows as roster
  /// projects, for a connection whose own roster is still empty.
  func cloudSavedRosterProjects(fleetKey: String) -> [RemoteRosterProject] {
    // A computer that left the account lists under its saved key.
    guard let machineKey = cloudAccountMachineKey(fleetKey: fleetKey) else { return [] }
    let box = cloudServerInstances.first { $0.machineKey == machineKey && $0.laneId != nil }
    return cloudSavedRosterProjects(
      rows: cloudSavedChats.filter { $0.machineKey == machineKey },
      box: box,
      sessions: CloudAtRestStore.shared.sessions(machineKey: machineKey)
    )
  }

  /// One roster project per repository: its lanes and its chats, as the
  /// computer last saved them. A lane computer with no saved chat still
  /// shows its lane. Rows with no repository are left out (they belong to no
  /// project's list).
  private func cloudSavedRosterProjects(rows: [CloudSavedChatRow], box: CloudServerInstance?, sessions: [CloudSessionRow] = []) -> [RemoteRosterProject] {
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
        // A subagent chat files under its parent chat, as on the computer.
        let parent = nonEmptyTrimmed(row.parentChatId)
        entry.chats.append(RemoteRosterChat(
          id: row.chatId,
          laneId: laneId,
          spawnKind: parent == nil ? nil : AgentChatSpawnKind(wireValue: row.spawnKind ?? ""),
          orchestrationParentSessionId: parent,
          title: nonEmptyTrimmed(row.title) ?? "Saved chat",
          provider: row.provider,
          model: row.model,
          toolType: nonEmptyTrimmed(row.toolType) ?? "claude-chat",
          status: .idle,
          lastActivityAt: activity,
          // As on desktop: a turn its computer's sleep or delete cut reads
          // Stopped, and a turn that died on an error reads Failed.
          lastTurnFailedAt: row.status == "failed" ? activity : nil,
          stoppedForRest: row.status == "interrupted" ? true : nil
        ))
      }
      projects[origin] = entry
    }
    if let box, let laneId = box.laneId, let origin = box.projectOrigin {
      var entry = project(for: origin, projectId: nil, root: nil)
      if let index = entry.lanes.firstIndex(where: { $0.id == laneId }) {
        if entry.lanes[index].branchRef == nil { entry.lanes[index].branchRef = box.laneBranch }
        // The computer's lane name is current; a saved chat keeps the name the
        // lane had when the chat started (before a rename).
        if let current = box.laneName.flatMap({ nonEmptyTrimmed($0) }) { entry.lanes[index].name = current }
      } else {
        entry.lanes.append(RemoteRosterLane(id: laneId, name: box.laneName ?? "Cloud lane", color: nil, icon: nil, laneType: "worktree", branchRef: box.laneBranch))
      }
      projects[origin] = entry
    }
    // The saved copies of its CLI and shell sessions: read-only rows. Their
    // ids never name a live session, so a tap opens the copy.
    for copy in sessions {
      guard let origin = copy.projectKey.flatMap({ nonEmptyTrimmed($0) }) else { continue }
      var entry = project(for: origin, projectId: nil, root: nil)
      let laneId = nonEmptyTrimmed(copy.laneId) ?? "saved-chats"
      if !entry.lanes.contains(where: { $0.id == laneId }) {
        entry.lanes.append(RemoteRosterLane(id: laneId, name: nonEmptyTrimmed(copy.laneName) ?? "Saved chats", color: nil, icon: nil, laneType: "worktree", branchRef: nil))
      }
      let rowId = cloudSessionCopyRowId(machineKey: copy.machineKey, sessionId: copy.sessionId)
      if !entry.chats.contains(where: { $0.id == rowId }) {
        entry.chats.append(RemoteRosterChat(
          id: rowId,
          laneId: laneId,
          title: nonEmptyTrimmed(copy.title) ?? (copy.isShell ? "Shell" : "CLI session"),
          provider: nil,
          model: nil,
          toolType: copy.isShell ? "shell" : (nonEmptyTrimmed(copy.toolType) ?? "cli"),
          status: copy.status == "running" ? .idle : .ended,
          lastActivityAt: nonEmptyTrimmed(copy.lastActivityAt)
            ?? ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: copy.updatedAt / 1000))
        ))
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
  /// `waitsForStart: false` (a read: connect, never wake) pairs only a
  /// computer the account lists online now, and else answers `.skipped`.
  func pairRestingCloudMachine(fleetKey: String, name: String, waking: Bool = false, waitsForStart: Bool = true) async -> CloudWakeResult {
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
      // A read: a computer that is not up has nothing to pair with. Waiting
      // here would read the account every 3 s and end in a false failure.
      if !waitsForStart, current()?.online != true { return .skipped }
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
    let cloudKeys = adeCloudMachineKeys
    return machines.contains { !cloudKeys.contains($0.machineKey.lowercased()) }
  }

  /// Whether a machine key is one of the account's ADE Cloud computers.
  func isADECloudMachineKey(_ key: String?) -> Bool {
    guard let key, !key.isEmpty else { return false }
    return adeCloudMachineKeys.contains(key.lowercased())
  }

  private var adeCloudMachineKeys: Set<String> {
    var cloudKeys = Set(cloudServerInstances.compactMap { $0.machineKey?.lowercased() })
    for key in cloudAccountMachineKeys ?? [] { cloudKeys.insert(key.lowercased()) }
    return cloudKeys
  }
}
