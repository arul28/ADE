import SwiftUI

// The ADE Cloud page's words and sizes: the lines under the hours, a
// computer's mark and line, the four sizes from the server's catalog, and
// the `cloud*` text helpers every card shares (the desktop's
// `cloudDashboardModel.ts` and `shared/cloudTiers.ts`).

/// One line under the hours on the hero: a warning in words, or a short chip.
struct CloudHoursNote: Hashable {
  enum Tone: Hashable { case warn, chip, lamp, on, off }
  let text: String
  let tone: Tone
}

/// The hero's lines under the hours: why the free plan has no hours (warnings,
/// in full), then short lines for earned hours, extra hours and the pace.
func cloudHoursNotes(_ account: CloudPhoneAccount, now: Date) -> [CloudHoursNote] {
  let words = CloudBalanceWords(account)
  var notes: [CloudHoursNote] = []
  if let free = account.freePlan, free.state == "refused" {
    // The phone's own words: the server's sentence names a plan to get
    // (App Store 3.1.1, see `cloudPhoneWords`).
    notes.append(.init(text: "This computer already used another account's \(words.free), so the free plan has no \(words.unit) here.", tone: .warn))
  }
  if let line = cloudFreeGithubLine(account) {
    notes.append(.init(text: line, tone: .warn))
  }
  if let earned = account.earnedHours, earned.leftMilli > 0 {
    notes.append(.init(text: "+\(words.amount(earned.leftMilli)) from invites", tone: .lamp))
  }
  // Extra credits have their own tile on the hero ("When credits run out").
  if let forecast = cloudHoursForecast(account, now: now) {
    notes.append(.init(text: forecast, tone: .chip))
  }
  return notes
}

/// Why the free plan's GitHub rules hold its hours, in the phone's own words:
/// facts only, no card or plan to get (App Store 3.1.1). The desktop offers
/// the card (no charge) that starts a new GitHub account's hours early.
func cloudFreeGithubLine(_ account: CloudPhoneAccount) -> String? {
  guard let github = account.freePlan?.github, let state = github.state else { return nil }
  let words = CloudBalanceWords(account)
  switch state {
  case "no_github":
    return "\(words.freeTitle) need a GitHub account at least 30 days old. Connect GitHub to start."
  case "too_new":
    if let at = github.oldEnoughAt {
      return "Your GitHub account is new, so \(words.free) start on \(cloudFreeGithubDay(at))."
    }
    return "Your GitHub account is new, so \(words.free) start when it is 30 days old."
  case "used":
    return "This GitHub account already gives another \(Brand.name) account its \(words.free), so the free plan has no \(words.unit) here."
  case "checking":
    return "\(Brand.name) couldn't check your GitHub account just now. It tries again in a few minutes."
  default:
    return nil
  }
}

/// The GitHub rule holds this Free account's credits: the hold, said where
/// the person tries to use ADE Cloud (a new cloud chat, a lane's state, a
/// refused send) instead of "out of credits". The card is named in words
/// only (`cloudCardElsewhereLine`): no button or link to payment from the
/// app. Nil on a paid plan and when nothing is held.
func cloudFreeGithubHoldLine(_ account: CloudPhoneAccount) -> String? {
  guard account.plan == "free", let github = account.freePlan?.github,
        let state = github.state, state != "ok", let line = cloudFreeGithubLine(account) else { return nil }
  guard state == "too_new", github.canUnlockWithCard != false else { return line }
  return "\(line) You can start them sooner from \(Brand.name) on your computer."
}

/// "December 13", in UTC like the server and the desktop, so every screen names the same day.
func cloudFreeGithubDay(_ ms: Double) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US")
  formatter.timeZone = TimeZone(identifier: "UTC")
  formatter.dateFormat = "MMMM d"
  return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
}

/// Each plan's name inside a sentence (`CLOUD_PLAN_SENTENCE_NAMES`).
func cloudPlanSentenceName(_ id: String) -> String {
  switch id {
  case "free": return "the free plan"
  case "pro": return "Pro"
  case "max": return "Max"
  default: return "Plus"
  }
}

/// What a cheaper plan's limits freed and kept, in the server's words
/// (`planCleanupDoneSentence`); nil when it freed and kept nothing.
func cloudPlanCleanupDoneSentence(_ done: CloudPhoneAccount.PlanCleanupDone) -> String? {
  var parts: [String] = []
  if !done.freed.isEmpty {
    let list = done.freed.map(\.name).joined(separator: ", ")
    let these = done.freed.count == 1 ? "this computer" : "these computers"
    // Only a computer that held a lane keeps one: a computer made for no lane is simply gone.
    let lanesKept = done.freed.filter { $0.laneKept == true }.count
    let kept: String
    if lanesKept == 0 {
      kept = ""
    } else if lanesKept == done.freed.count {
      kept = " \(lanesKept == 1 ? "Its lane and chats stay" : "Their lanes and chats stay"); the next message to a lane makes a new computer."
    } else {
      kept = " \(lanesKept == 1 ? "The lane among them and its chats stay" : "The lanes among them and their chats stay"); the next message to a lane makes a new computer."
    }
    let how = done.freed.allSatisfy { $0.pushed != false } ? "saved each lane's work and removed" : "removed"
    parts.append("To fit \(cloudPlanSentenceName(done.planId)), \(Brand.name) \(how) \(these): \(list).\(kept)")
  }
  if !done.kept.isEmpty {
    parts.append("\(Brand.name) kept \(done.kept.map(\.name).joined(separator: ", ")), because \(Brand.name) couldn't save its lanes' work. Use it once so \(Brand.name) saves the work when it rests, delete it yourself, or pick again in \(Brand.name).")
  }
  return parts.isEmpty ? nil : parts.joined(separator: " ")
}

/// A cheaper plan's limits on the phone: the server's sentence, then what
/// holds until the person picks on the desktop (the phone can't pick). Nil
/// when there is nothing to say.
func cloudPlanCleanupMessage(_ cleanup: CloudPhoneAccount.PlanCleanup) -> String? {
  if let ids = cleanup.freeing?.instanceIds {
    return "\(Brand.name) is freeing \(ids.count == 1 ? "1 computer" : "\(ids.count) computers") you picked to fit \(cloudPlanSentenceName(cleanup.planId ?? "plus")). Their lanes and chats stay."
  }
  guard let sentence = cloudPhoneWords(cleanup.sentence) else { return nil }
  let when = cleanup.startsAt.map { "You move to \(cloudPlanSentenceName(cleanup.planId ?? "plus")) on \(cloudDate($0))." }
    ?? "\(Brand.name) can't make a new computer until you have fewer."
  return "\(sentence) \(when) \(Brand.name) deletes nothing on its own: delete computers, or pick the ones \(Brand.name) frees in the \(Brand.name) desktop app."
}

/// "in 1 day", "in 5 hours", "within the hour" (`inHowLong`).
private func cloudInHowLong(_ at: Double, now: Double) -> String {
  let left = max(0, at - now)
  let hours = Int((left / 3_600_000).rounded())
  if hours < 1 { return "within the hour" }
  if hours < 20 { return "in \(hours) \(hours == 1 ? "hour" : "hours")" }
  let days = max(1, Int((left / 86_400_000).rounded()))
  return "in \(days) \(days == 1 ? "day" : "days")"
}

/// "deleted in 1 day", "deleted in 5 hours" (`idleCleanupWhen`).
func cloudIdleCleanupWhen(_ deletesAt: Double, now: Double) -> String {
  "deleted \(cloudInHowLong(deletesAt, now: now))"
}

/// One idle cleanup notice on the phone, in the desktop's words, with how to
/// keep it: a message in the lane, or "Keep it" on the computer's page.
func cloudIdleCleanupMessage(_ entry: CloudPhoneAccount.IdleCleanup, now: Double) -> String {
  let subject = entry.laneName.map { $0.isEmpty ? entry.displayName : "\($0)'s computer" } ?? entry.displayName
  if let held = entry.held {
    return "\(subject) wasn't deleted: \(Brand.name) couldn't save its work. \(held.reason) Open the lane once so \(Brand.name) saves its work when the computer rests, or delete the lane if you don't need it. \(Brand.name) checks again \(cloudInHowLong(held.retryAt ?? entry.deletesAt, now: now)).\(cloudIgnoredFilesShort(entry.ignoredFiles))"
  }
  let save = entry.laneName != nil
    ? "Its work that isn't on GitHub is saved in \(Brand.cloudName), and the lane and its chats stay."
    : "Its work that isn't on GitHub is saved in \(Brand.cloudName) first."
  let ignored = cloudIgnoredFilesShort(entry.ignoredFiles)
  return "\(subject) will be \(cloudIdleCleanupWhen(entry.deletesAt, now: now)), on \(cloudDate(entry.deletesAt)), because it isn't used. \(save)\(ignored) To keep it, send a message in the lane, or choose Keep it on its computer's page."
}

/// The ignored files a delete loses, in one short sentence (with a leading space), or "" when none were found.
func cloudIgnoredFilesShort(_ ignored: CloudPhoneAccount.IdleCleanup.IgnoredFiles?) -> String {
  guard let ignored else { return " Files git ignores, such as .env, aren't saved." }
  let list: String?
  if ignored.paths.isEmpty {
    list = ignored.more > 0 ? "\(ignored.more) \(ignored.more == 1 ? "file" : "files")" : nil
  } else {
    let shown = ignored.paths.joined(separator: ", ")
    list = ignored.more > 0 ? "\(shown) and \(ignored.more) more" : shown
  }
  if ignored.incomplete == true {
    guard let list else { return " \(Brand.name) couldn't read every lane to see which files git ignores, such as .env; those aren't saved." }
    return " Files git ignores aren't saved, so these won't be kept: \(list). \(Brand.name) couldn't read every lane, so there may be more."
  }
  guard let list else { return "" }
  return " Files git ignores aren't saved, so these won't be kept: \(list)."
}

/// Why timed wake-ups were cancelled and how they come back
/// (`timedWakesCancelledSentence`), in the phone's own words: what the person
/// can do that isn't a purchase (App Store 3.1.1). `resetsAt` is when the
/// hours reset, when the account says.
func cloudTimedWakesCancelledSentence(_ notice: CloudPhoneAccount.TimedWakesCancelled, resetsAt: Double?, words: CloudBalanceWords) -> String {
  let what = notice.count == 1 ? "A timed wake-up" : "\(notice.count) timed wake-ups"
  let head = "\(what) on your \(Brand.cloudName) computers won't run (a chat's scheduled wake-up or an automation's schedule)"
  let after = "each computer sets its next timed wake-up again the next time it runs."
  if notice.reason == "over_plan_disk" {
    return "\(head), because your computers hold more disk than the free plan has, so they can't wake. Once you delete a computer, \(after)"
  }
  let reset = resetsAt.map { "When your \(words.unit) reset on \(cloudDate($0))" } ?? "When your \(words.unit) reset"
  return "\(head), because you're out of \(words.cloudUnit), so your computers can't wake. \(reset), \(after)"
}

/// The iPhone never points at a purchase (App Store 3.1.1/3.1.3): a server
/// message keeps only its sentences that don't mention one (getting a plan,
/// a paid plan, picking a plan, upgrading, adding or buying hours, extra
/// hours, credits or disk). A
/// plan named as a fact ("Plus allows 40 GB") stays. Nil when nothing is left.
func cloudPhoneWords(_ message: String?) -> String? {
  guard let message else { return nil }
  let purchase = ["get plus", "get pro", "get a paid plan", "paid plan", "pick a plan", "upgrade", "add hours", "buy", "extra hours", "extra credits", "extra disk"]
  var kept: [String] = []
  message.enumerateSubstrings(in: message.startIndex..., options: .bySentences) { sentence, _, _, _ in
    guard let sentence = sentence?.trimmingCharacters(in: .whitespacesAndNewlines), !sentence.isEmpty else { return }
    let lower = sentence.lowercased()
    if !purchase.contains(where: lower.contains) { kept.append(sentence) }
  }
  return kept.isEmpty ? nil : kept.joined(separator: " ")
}

/// "At this pace your hours last until Nov 24", from the last days' use; nil
/// when the server doesn't say or nothing was used (`hoursForecast`).
func cloudHoursForecast(_ account: CloudPhoneAccount, now: Date) -> String? {
  // Nothing used yet this period (a plan just bought, a month just reset): no pace to speak of.
  guard let recent = account.recentUse, recent.days > 0, recent.usedMilli > 0, (account.hours.usedMilli ?? 1) > 0,
        let periodEnd = account.billing?.periodEnd else { return nil }
  let left = Double(account.hoursLeftMilli)
  guard left > 0 else { return nil }
  let perDay = recent.usedMilli / recent.days
  let endsAt = now.timeIntervalSince1970 * 1000 + (left / perDay) * 86_400_000
  let unit = CloudBalanceWords(account).unit
  if endsAt >= periodEnd { return "At this pace your \(unit) last until they reset" }
  return "At this pace your \(unit) last until \(cloudDate(endsAt))"
}

/// One mark at most, so the name keeps its room: the idle cleanup's warning,
/// no lane, then unused, then safe to delete.
func cloudMachineMark(_ machine: CloudPhoneMachine, idle: CloudPhoneAccount.IdleCleanup? = nil, now: Date) -> (text: String, tone: ADEKitTone)? {
  if let idle {
    if idle.held != nil { return ("Not deleted", .warn) }
    let when = cloudIdleCleanupWhen(idle.deletesAt, now: now.timeIntervalSince1970 * 1000)
    return (when.prefix(1).uppercased() + when.dropFirst(), .warn)
  }
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

/// "Small · Never uses hours" ("Small · Uses no credits"), "Large · Full
/// computer" (the last run sits under the state). No multiplier and no disk:
/// hours are time on a size, and disk shows only on a computer whose disk is
/// nearly full.
func cloudMachineLine(_ machine: CloudPhoneMachine, tier: CloudPhoneTier?, now: Date, words: CloudBalanceWords) -> String {
  guard let tier else { return machine.size ?? "" }
  if !tier.usesHours { return "\(tier.label) · \(words.smallNever)" }
  return tier.full ? "\(tier.label) · Full computer" : tier.label
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

// MARK: - Sizes and words

/// One of the four lane sizes (`shared/cloudTiers.ts`), from the server's
/// catalog: how fast it uses hours is the catalog's, never a number here.
/// Hours show as time on a size ("20 h on a Large"), never as a multiplier.
struct CloudPhoneTier: Identifiable, Equatable {
  let id: String
  let label: String
  /// `default` (a standard computer) or `vm` (a full one).
  let type: String
  let cpu: Int
  let memoryGb: Double
  let multiplierMilli: Int
  let diskMaxGb: Double?
  /// Pricing v3: the ad price (`adMultiplierMilli`); nil while Pricing v3 doesn't reach the account.
  var adMultiplierMilli: Int? = nil

  /// The full and ad price, for `CloudAdPriceWords.rate`. Without an ad price both are the full one.
  var ratePair: CloudRatePair { CloudRatePair(fullMilli: multiplierMilli, adMilli: adMultiplierMilli ?? multiplierMilli) }

  /// This size at the rate the account pays now (Pricing v3): the ad price
  /// while ads are on, so "left on it" counts what the credits really buy.
  func atPriceNow(_ pricing: CloudPricingState?) -> CloudPhoneTier {
    guard let pricing, pricing.ads.available, pricing.ads.on, let ad = adMultiplierMilli, ad != multiplierMilli else { return self }
    return CloudPhoneTier(id: id, label: label, type: type, cpu: cpu, memoryGb: memoryGb, multiplierMilli: ad, diskMaxGb: diskMaxGb, adMultiplierMilli: ad)
  }

  /// Small on a Pricing v2 server: it never uses hours (`multiplierMilli` 0),
  /// unless the account's catalog rates it (Free, sponsored cards off).
  var usesHours: Bool { multiplierMilli > 0 }
  var full: Bool { type == "vm" }
  /// "a Medium", "an X-Large".
  var withArticle: String { "\(cloudSizeArticle(label)) \(label)" }

  var symbol: String {
    switch id {
    case "small": return "square"
    case "medium": return "square.split.2x1"
    case "large": return "square.grid.2x2"
    default: return "square.grid.3x3"
    }
  }

  /// "2 CPU", "4 GB memory". No disk: each size's disk maximum is a
  /// backstop, never a number the person plans around.
  var specs: [String] {
    ["\(cpu) CPU", "\(cloudGbText(memoryGb)) GB memory"]
  }

  var runs: String {
    switch id {
    case "small": return "Agents, builds and tests"
    case "medium": return "Bigger builds and test suites"
    case "large": return "Docker and the Android emulator"
    default: return "Docker, Android and heavy builds"
    }
  }

  /// What this size does with the account's hours, as time: "Never uses
  /// your hours" on Small, else "Your hours last 20 h on it" (nil
  /// `leftMilli`: the account wasn't read, "Uses your hours"). Credits say
  /// the same in theirs (`CloudBalanceWords`).
  func hoursLine(leftMilli: Int?, words: CloudBalanceWords) -> String {
    guard usesHours else { return words.neverUsesYours }
    guard let leftMilli else { return words.uses(self) }
    return "Your \(words.unit) last \(hoursLeftLabel(leftMilli)) on it"
  }

  /// How long `leftMilli` hours last at this size (`cloudTierHoursAt`): rounded
  /// down, to a tenth under 10 h and to whole hours from 10 up: "7.5 h", "57 h".
  /// "Unlimited" on a size that never uses hours.
  func hoursLeftLabel(_ leftMilli: Int) -> String {
    guard usesHours else { return "Unlimited" }
    let hours = Double(max(0, leftMilli)) / Double(max(1, multiplierMilli))
    let shown = hours >= 10 ? hours.rounded(.down) : (hours * 10).rounded(.down) / 10
    return "\(shown.formatted(.number.precision(.fractionLength(0...1)).grouping(.never)))\u{00A0}h"
  }
}

private let cloudTierOrder: [(id: String, label: String, type: String, cpu: Int, memoryGb: Double)] = [
  ("small", "Small", "default", 2, 4),
  ("medium", "Medium", "default", 4, 8),
  ("large", "Large", "vm", 4, 8),
  ("xlarge", "X-Large", "vm", 4, 16),
]

/// A size's kind by its id (`default` standard, `vm` full), fixed for the four sizes; nil for another id.
func cloudPhoneTierType(id: String) -> String? {
  cloudTierOrder.first { $0.id == id }?.type
}

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
      diskMaxGb: size.diskMaxGb,
      adMultiplierMilli: size.adMultiplierMilli
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
  case "max": return "Max"
  default: return "Plus"
  }
}

/// "Free plan", "Plus plan", "Pro plan" (`planName`).
func cloudPlanName(_ account: CloudPhoneAccount) -> String {
  "\(cloudPlanLabel(account.currentPlanId)) plan"
}

/// Hours from thousandths, as the desktop writes them (`formatCloudHours`):
/// "1,600", "299.8", "42.5". Whole hours plainly, anything else to the tenth,
/// rounded down at every size, so 299.8 left never reads "299" or "300".
func cloudHours(_ milli: Int) -> String {
  let tenths = max(0, milli) / 100
  let shown = Double(tenths) / 10
  return shown.formatted(.number.precision(.fractionLength(0...1)).locale(Locale(identifier: "en_US")))
}

/// "a" or "an" before a size's name: "a Medium", "an X-Large" (said "ex").
func cloudSizeArticle(_ label: String) -> String {
  guard let first = label.uppercased().first else { return "a" }
  return "AEIOUX".contains(first) ? "an" : "a"
}

/// A plan's hours as time on each size that uses them, never a multiplier:
/// "50 hours on a Medium · 20 on a Large · 12 on an X-Large" (whole hours,
/// rounded down). Nil when no size uses hours or the catalog has none.
/// A plan's line, so never Small: a plan's Small is unlimited, even when
/// this account's Free Small uses hours (sponsored cards off).
func cloudHoursOnSizes(_ milli: Int, tiers: [CloudPhoneTier]) -> String? {
  let sized = tiers.filter { $0.id != "small" && $0.usesHours }
  guard !sized.isEmpty else { return nil }
  let parts = sized.enumerated().map { index, tier -> String in
    let hours = Int((Double(max(0, milli)) / Double(tier.multiplierMilli)).rounded(.down))
    let count = hours.formatted(.number.locale(Locale(identifier: "en_US")))
    return index == 0 ? "\(count) \(hours == 1 ? "hour" : "hours") on \(tier.withArticle)" : "\(count) on \(tier.withArticle)"
  }
  return parts.joined(separator: " · ")
}

/// This account's Small size when it uses hours, or nil when Small is
/// unlimited (`cloudSmallRateMilli`). Small uses hours only on Free with
/// sponsored cards off while the server's `smallNeedsCards` rule is on: the
/// account's catalog then rates it above 0. Read the catalog, never assume 0.
@MainActor func cloudSmallTierUsingHours(_ account: CloudPhoneAccount) -> CloudPhoneTier? {
  guard let small = cloudPhoneTiers(account.catalog).first(where: { $0.id == "small" }), small.usesHours else { return nil }
  // Pricing v3: Free's Small is free at the ad price, while ads are on here.
  if let pricing = cloudPricing(), pricing.ads.available, pricing.ads.on, small.adMultiplierMilli == 0 { return nil }
  return small
}

/// The small print beside the Small offer (`CLOUD_SMALL_FAIR_USE_SENTENCE`).
let cloudSmallFairUseSentence = "Small computers are for your own work and fall under fair use."

// MARK: - Credits

/// ADE Cloud's one balance, in credits (`CloudPhoneAccount.credits`): a
/// Medium computer uses one an hour, and the ADE Cloud iPhone draws from it
/// too. The numbers are thousandths. Every word for it comes from here,
/// never from where it is shown.
struct CloudBalanceWords: Equatable {
  /// What a minute on the ADE Cloud iPhone uses, in thousandths of a credit.
  let phoneMilliPerMinute: Int
  /// Pricing v3's shown scale (`creditScale`): shown credits = milli / 1000 x
  /// scale. 1 (the old unit) until the server sends one. Read from the
  /// account, never a constant of the app.
  let scale: Int

  /// The words before the account is read: one credit a minute on the iPhone.
  static let credits = CloudBalanceWords(phoneMilliPerMinute: 1000)

  init(phoneMilliPerMinute: Int, scale: Int = 1) {
    self.phoneMilliPerMinute = phoneMilliPerMinute
    self.scale = max(1, scale)
  }
  init(_ account: CloudPhoneAccount?) {
    let perMinute = account?.credits?.phoneMilliPerMinute ?? 0
    phoneMilliPerMinute = perMinute > 0 ? perMinute : CloudBalanceWords.credits.phoneMilliPerMinute
    scale = max(1, account?.pricing?.creditScale ?? account?.catalog?.creditScale ?? 1)
  }

  /// A balance or used amount at the account's scale: "4,180". Under Pricing
  /// v3 (scale above 1) always whole credits, rounded down; at the
  /// old unit today's tenths ("2.5"). Rates use `CloudAdPriceWords`.
  func number(_ milli: Int) -> String {
    guard scale > 1 else { return cloudCredits(milli, scale: scale) }
    return wholeCredits(milli).formatted(.number.locale(Locale(identifier: "en_US")))
  }

  /// Whole shown credits, rounded down.
  func wholeCredits(_ milli: Int) -> Int { max(0, milli) * scale / 1000 }

  /// The parts of one total in whole credits that add up to the total's
  /// whole credits (largest remainder). `fixed` keeps its own
  /// rounded-down value (the balance the big number shows); the others share
  /// what is left of the total. At the old unit each part is shown as is.
  func wholeParts(_ millis: [Int], total: Int, fixed: Int?) -> [String] {
    guard scale > 1 else { return millis.map(number) }
    var shown = millis.map(wholeCredits)
    let others = millis.indices.filter { $0 != fixed }
    let target = wholeCredits(total) - (fixed.map { shown[$0] } ?? 0)
    var missing = target - others.reduce(0) { $0 + shown[$1] }
    let byRemainder = others.sorted { (max(0, millis[$0]) * scale) % 1000 > (max(0, millis[$1]) * scale) % 1000 }
    for index in byRemainder where missing > 0 && (max(0, millis[index]) * scale) % 1000 > 0 {
      shown[index] += 1
      missing -= 1
    }
    return shown.map { $0.formatted(.number.locale(Locale(identifier: "en_US"))) }
  }

  /// "credits".
  var unit: String { "credits" }
  /// "Credits".
  var title: String { "Credits" }
  /// "ADE Cloud credits".
  var cloudUnit: String { "\(Brand.cloudName) \(unit)" }
  /// "free credits".
  var free: String { "free \(unit)" }
  /// "Free credits".
  var freeTitle: String { "Free \(unit)" }
  /// "free cloud credits".
  var freeCloud: String { "free cloud \(unit)" }
  /// "Extra credits": past the plan, on a paid plan.
  var extra: String { "Extra \(unit)" }

  /// A number of them with the unit: "42.5 credits", "1 credit".
  func amount(_ milli: Int) -> String {
    let number = number(milli)
    return "\(number) \(number == "1" ? "credit" : "credits")"
  }

  /// A number of them in words: "20 credits", "1 credit".
  func spelled(_ milli: Int) -> String { amount(milli) }

  /// A size that never uses the balance: "Uses no credits".
  var smallNever: String { "Uses no credits" }
  /// "Uses no credits".
  var neverUsesYours: String { "Uses no credits" }
  /// "They use no credits".
  var theyNeverUse: String { "They use no credits" }

  /// What a size uses, its rate in credits: "Uses 2.5 credits an hour".
  func uses(_ tier: CloudPhoneTier) -> String {
    guard tier.usesHours else { return neverUsesYours }
    return "Uses \(spelled(tier.multiplierMilli)) an hour"
  }

  /// A rate, short and lowercase, for a before → after line (`CloudUnitWords.hourly`):
  /// "0 credits an hour", "1 credit an hour", "2.5 credits an hour".
  func hourly(milli: Int) -> String {
    "\(spelled(max(0, milli))) an hour"
  }

  /// A size change's rates, now → after (`cloudTierChangeRateText`): "4 credits
  /// an hour now → 1 credit an hour on Medium"; with no size now "1 credit an
  /// hour on Medium"; the size it is already "Medium now · 1 credit an hour".
  func changeRates(from: CloudPhoneTier?, to: CloudPhoneTier) -> String {
    let after = hourly(milli: to.multiplierMilli)
    guard let from else { return cloudCapitalized("\(after) on \(to.label)") }
    if from.id == to.id { return "\(to.label) now · \(after)" }
    return "\(cloudCapitalized(hourly(milli: from.multiplierMilli))) now → \(after) on \(to.label)"
  }

  /// How long the credits left last at a size (`cloudTierHoursOnText`): "418
  /// credits last about 418 h on Medium."; nil on a size that uses none.
  func hoursOn(_ tier: CloudPhoneTier, leftMilli: Int) -> String? {
    guard tier.usesHours else { return nil }
    let left = amount(leftMilli)
    return "\(left) \(left.hasSuffix(" credit") ? "lasts" : "last") about \(tier.hoursLeftLabel(leftMilli)) on \(tier.label)."
  }

  /// The offer, as every surface says it (`CLOUD_SMALL_UNLIMITED_SENTENCE`). Never "0 credits".
  var smallUnlimitedSentence: String { "Unlimited Small computers. \(theyNeverUse)." }

  /// What one of them is (`CLOUD_CREDIT_UNIT_SENTENCE`).
  /// What one credit is at the old unit; nil under Pricing v3 (scale above 1),
  /// whose plans card names the rates instead of a unit.
  var unitSentence: String? {
    guard scale == 1 else { return nil }
    return "A credit is an hour on a Medium computer or a minute on the \(Brand.cloudName) iPhone. Small computers use none."
  }

  /// A plan's month: "100 credits a month".
  func monthly(_ milli: Int) -> String { "\(number(milli)) \(unit) a month" }

  /// The hero's label over the number left.
  var leftTitle: String { "Credits left this month" }

  /// "of 600 credits".
  func of(_ milli: Int) -> String { "of \(amount(milli))" }

  /// The plan table's unit under its big number: "credits a month".
  var perMonth: String { "credits a month" }
  /// "credits until Dec 1".
  func until(_ date: String) -> String { "credits until \(date)" }
  /// A plan's balance in one short line: "100 credits a month".
  func planLine(_ milli: Int) -> String { "\(amount(milli)) a month" }
  /// "50 credits a month".
  func planSentence(_ milli: Int) -> String { "\(spelled(milli)) a month" }

  /// Out of the balance, on the notices card.
  func outNotice(smallUsesBalance: Bool) -> String {
    smallUsesBalance
      ? "You're out of \(unit). Your computers stop until your \(unit) reset; running work on them saves first."
      : "You're out of \(unit). Small computers keep working. Bigger sizes stop until your \(unit) reset; running work on them saves first."
  }

  /// Free's Small with sponsored cards off.
  var smallWithoutCards: String { "Small computers use credits, half a credit for each hour awake" }

  /// "Waking it uses ADE Cloud credits."
  var wakingUses: String { "Waking it uses \(cloudUnit)." }

  /// "About 482 iPhone minutes, or 482 hours on a Medium computer.": what
  /// the credits left buy, rounded down. The iPhone part only while it is on
  /// for the account; nil with nothing to say it in.
  func leftBuys(_ leftMilli: Int, medium: CloudPhoneTier?, phoneOn: Bool) -> String? {
    func whole(_ value: Int) -> String { value.formatted(.number.locale(Locale(identifier: "en_US"))) }
    let left = max(0, leftMilli)
    let hours = medium.flatMap { $0.usesHours ? left / $0.multiplierMilli : nil }
    let hoursPart = hours.map { "\(whole($0)) \($0 == 1 ? "hour" : "hours") on a Medium computer" }
    if phoneOn {
      let minutes = left / phoneMilliPerMinute
      let minutesPart = "\(whole(minutes)) iPhone \(minutes == 1 ? "minute" : "minutes")"
      return "About \(minutesPart)\(hoursPart.map { ", or \($0)" } ?? "")."
    }
    return hoursPart.map { "About \($0)." }
  }

  // The ADE Cloud iPhone: a minute's rate of the credits.

  /// "1 credit a minute".
  var phoneRate: String { "\(spelled(phoneMilliPerMinute)) a minute" }

  /// The sheet's header: the credits left, "42 credits left".
  func phoneLeft(_ minutes: CloudIphoneStatus.Minutes) -> (text: String, spoken: String) {
    let milli = max(0, minutes.left) * phoneMilliPerMinute
    return ("\(amount(milli)) left", "\(spelled(milli)) left this period")
  }

  /// Under Start phone: where its time comes from.
  /// `rate`: Pricing v3's pair ("4 credits a minute with ads · 5 with no ads"); today's rate without it.
  func phoneStartNote(device: String, rate: String? = nil) -> String {
    "Starts an \(device) simulator in the cloud. It uses \(rate ?? phoneRate) of your \(Brand.cloudName) credits."
  }
}

/// "3 cloud computers" (`cloudComputersPhrase`).
func cloudComputersPhrase(_ count: Int) -> String {
  "\(count) cloud \(count == 1 ? "computer" : "computers")"
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

func cloudLimitsSummary(_ limits: CloudPhoneLimits, words: CloudBalanceWords) -> String {
  guard limits.unattendedSpend else { return "Unattended agents ask before anything uses \(words.unit)" }
  return "\(limits.machinesPerDay) new computers a day, up to \(cloudShapeLabel(limits.maxShape))"
}

// MARK: - "You're on Plus"

/// A purchase or a move up that just landed (the desktop's `CloudPlanMoment`).
struct CloudPlanMoment: Equatable {
  /// `<plan>:<periodStart>`, as `CloudPlanSeenStore.momentKey`.
  let key: String
  /// The account it is about (`CloudPlanSeenStore.accountKey`).
  let accountKey: String
  let planId: String
  let includedMilli: Int
  /// The plan's cloud computers (Pricing v2); nil from an older server.
  let computerLimit: Int?
  let renewsAt: Double
  /// Free hours left before the upgrade that the paid period replaced; nil when none were.
  let replacedFreeMilli: Int?
  /// The account's unit when the plan landed.
  let words: CloudBalanceWords

  var title: String { "You're on \(cloudPlanLabel(planId))" }

  var detail: String {
    let amount = words.number(includedMilli)
    var line = computerLimit.map { "\(cloudComputersPhrase($0)) and \(words.monthly(includedMilli)). Renews \(cloudDate(renewsAt))." }
      ?? "\(words.monthly(includedMilli)). Renews \(cloudDate(renewsAt))."
    if let replaced = replacedFreeMilli {
      line += " Your \(words.number(replaced)) unused \(words.free) were replaced by \(cloudPlanLabel(planId))'s \(amount)."
    }
    return line
  }
}

/// What this phone last saw of the account, per account (its invite code):
/// the plan, the period and the hours left then (the desktop's
/// `cloudPlanMoment.ts`, in UserDefaults). A phone that never saw the account
/// seeds quietly, so updating the app never celebrates an old purchase; a
/// moment is said once per account, plan and period.
enum CloudPlanSeenStore {
  static let defaultsKey = "ade.cloud.planSeen.v1"
  private static let rank: [String: Int] = ["free": 0, "plus": 1, "pro": 2, "max": 3]

  /// The account's invite code; without one, a shared "account" key that
  /// another account on this phone could have written, so it records but
  /// never celebrates (`canCelebrate` false), as on the desktop.
  static func accountKey(_ account: CloudPhoneAccount) -> (key: String, canCelebrate: Bool) {
    if let code = account.referral?.code, !code.isEmpty { return (code, true) }
    return ("account", false)
  }

  /// `<plan>:<periodStart>`: a moment is said once per account, plan and period.
  static func momentKey(_ account: CloudPhoneAccount) -> String {
    "\(account.currentPlanId):\(Int(account.billing?.periodStart ?? 0))"
  }

  /// Records what the account shows now and returns the moment to show, if the plan just went up.
  static func observe(_ account: CloudPhoneAccount, defaults: UserDefaults = .standard) -> CloudPlanMoment? {
    let planId = account.currentPlanId
    let periodStart = account.billing?.periodStart ?? 0
    let key = momentKey(account)
    var all = defaults.dictionary(forKey: defaultsKey) as? [String: [String: Any]] ?? [:]
    let (accountKey, canCelebrate) = accountKey(account)
    let previous = all[accountKey]
    let previousPlan = previous?["planId"] as? String
    let previousStart = previous?["periodStart"] as? Double
    let previousLeft = previous?["leftMilli"] as? Int ?? 0
    let celebrated = previous?["celebrated"] as? String
    // Paid and in good standing: a failed payment is never a moment.
    let landed = planId != "free" && account.plan == "paid" && account.billing?.notice != "past_due"
    let wentUp = (rank[planId] ?? 0) > (rank[previousPlan ?? "free"] ?? 0)
    let moment: CloudPlanMoment? = (canCelebrate && previousPlan != nil && landed && celebrated != key && wentUp) ? CloudPlanMoment(
      key: key,
      accountKey: accountKey,
      planId: planId,
      includedMilli: account.hours.includedMilli,
      computerLimit: account.computerLimit,
      renewsAt: account.billing?.periodEnd ?? 0,
      replacedFreeMilli: previousPlan == "free" && previousStart != periodStart && previousLeft > 0 ? previousLeft : nil,
      words: CloudBalanceWords(account)
    ) : nil
    var record: [String: Any] = ["planId": planId, "periodStart": periodStart, "leftMilli": max(0, account.hours.leftMilli)]
    if let shown = moment?.key ?? celebrated { record["celebrated"] = shown }
    all[accountKey] = record
    defaults.set(all, forKey: defaultsKey)
    return moment
  }
}

// MARK: Cloud computer labels

/// What a person sees for any ADE Cloud computer: "ADE Cloud". ADE Cloud is one
/// machine to the person; its lane computers and a CTO home computer never
/// show their own names (an instance id as host name, a lane-derived name).
/// The account's cloud computers as last read, kept on this phone (lane names
/// and ids, no secret), so the Machines list, pickers and chat headers name
/// them before the ADE Cloud page is opened. A label only: routing keeps the
/// machine key.
enum CloudLaneComputerLabels {
  static let defaultsKey = "ade.cloudLaneComputers.v1"
  /// The name for any ADE Cloud computer.
  static let cloudLabel = ADECloudMachine.name

  /// Records the lane computers of a good read of the account's computers,
  /// and tells views that show the labels outside an observed model (the PRs
  /// header) when they changed (`CloudLaneComputerLabelsRevision`).
  @MainActor
  static func note(_ machines: [CloudPhoneMachine], defaults: UserDefaults = .standard) {
    var lanes: [String: String] = [:]
    for machine in machines {
      // Every cloud computer counts, a CTO home with no lane too.
      let laneName = machine.lane?.laneName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      lanes[machine.instanceId.lowercased()] = laneName
      if let key = machine.machineKey?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty { lanes[key.lowercased()] = laneName }
    }
    if (defaults.dictionary(forKey: defaultsKey) as? [String: String]) == lanes { return }
    defaults.set(lanes, forKey: defaultsKey)
    CloudLaneComputerLabelsRevision.shared.value += 1
  }

  /// Adds the lane computers of the account server's computer list
  /// (`GET /cloud/instances`, read with no computer of the person's own):
  /// each computer made for a lane carries its lane name and, once joined,
  /// its machine key. Adds only: the full list above stays the one that
  /// drops a computer.
  @MainActor
  static func noteServerInstances(_ instances: [CloudServerInstance], defaults: UserDefaults = .standard) {
    var lanes = defaults.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
    let before = lanes
    for instance in instances {
      let laneName = instance.metadata["ade_lane_name"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      lanes[instance.id.lowercased()] = laneName
      if let key = instance.metadata["ade_machine_key"]?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty { lanes[key.lowercased()] = laneName }
    }
    if lanes == before { return }
    defaults.set(lanes, forKey: defaultsKey)
    CloudLaneComputerLabelsRevision.shared.value += 1
  }

  /// "ADE Cloud" for a cloud computer known by its machine key or host name; nil for any other machine.
  static func label(machineKey: String?, hostName: String? = nil, defaults: UserDefaults = .standard) -> String? {
    let lanes = defaults.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
    guard !lanes.isEmpty else { return nil }
    for candidate in [machineKey, hostName] {
      guard let id = candidate?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !id.isEmpty else { continue }
      if lanes[id] != nil { return cloudLabel }
    }
    return nil
  }

  /// `name`, or "ADE Cloud" when the machine is an ADE Cloud computer.
  static func present(_ name: String, machineKey: String?, hostName: String? = nil) -> String {
    label(machineKey: machineKey, hostName: hostName) ?? name
  }
}

/// Bumped when the saved lane-computer labels change, for a view that reads
/// them through a plain value (`PRsTabShell` rebuilds its inputs on it).
@MainActor
final class CloudLaneComputerLabelsRevision: ObservableObject {
  static let shared = CloudLaneComputerLabelsRevision()
  @Published var value = 0
}

extension AccountMachine {
  /// The name a row shows: "ADE Cloud" for any ADE Cloud computer,
  /// else `displayName`. Rename fields and name matching keep `displayName`.
  var presentedName: String {
    CloudLaneComputerLabels.label(machineKey: machineKey, hostName: name) ?? displayName
  }
}

/// The phrase with its first letter in capitals; one that starts with a number ("0 credits an hour") stays as it is.
func cloudCapitalized(_ phrase: String) -> String {
  phrase.prefix(1).uppercased() + phrase.dropFirst()
}

extension CloudPhoneAccount {
  /// The credits the person can spend, the plan's and invites', as every "hours left" and "minutes left" counts them (desktop `cloudHoursLeftMilli`).
  var hoursLeftMilli: Int { hours.leftMilli + max(0, earnedHours?.leftMilli ?? 0) }
}
