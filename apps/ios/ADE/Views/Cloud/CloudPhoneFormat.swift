import SwiftUI

// The ADE Cloud page's words and sizes: the lines under the hours, a
// computer's mark and line, the four sizes from the server's catalog, and
// the `cloud*` text helpers every card shares (the desktop's
// `cloudDashboardModel.ts` and `shared/cloudTiers.ts`).

/// The lines under the hours, in the desktop's order: why the free plan has
/// no hours here, earned hours, extra hours, and the forecast.
func cloudHoursNotes(_ account: CloudPhoneAccount, now: Date) -> [String] {
  var lines: [String] = []
  if let free = account.freePlan, free.state == "refused" {
    // The phone's own words: the server's sentence names a plan to get
    // (App Store 3.1.1, see `cloudPhoneWords`).
    lines.append("This computer already used another account's free hours, so the free plan has no hours here.")
  }
  if let line = cloudFreeGithubLine(account) {
    lines.append(line)
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

/// Why the free plan's GitHub rules hold its hours, in the phone's own words:
/// facts only, no card or plan to get (App Store 3.1.1). The desktop offers
/// the card (no charge) that starts a new GitHub account's hours early.
func cloudFreeGithubLine(_ account: CloudPhoneAccount) -> String? {
  guard let github = account.freePlan?.github, let state = github.state else { return nil }
  switch state {
  case "no_github":
    return "Free hours need a GitHub account at least 30 days old. Connect GitHub to start."
  case "too_new":
    if let at = github.oldEnoughAt {
      return "Your GitHub account is new, so free hours start on \(cloudFreeGithubDay(at))."
    }
    return "Your GitHub account is new, so free hours start when it is 30 days old."
  case "used":
    return "This GitHub account already gives another ADE account its free hours, so the free plan has no hours here."
  case "checking":
    return "ADE couldn't check your GitHub account just now. It tries again in a few minutes."
  default:
    return nil
  }
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
    let list = done.freed.map { entry in entry.pushed == false ? entry.name : entry.branch.map { "\(entry.name) (work on \($0))" } ?? entry.name }.joined(separator: ", ")
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
    let how = done.freed.allSatisfy { $0.pushed != false } ? "pushed each lane's work to GitHub and removed" : "removed"
    parts.append("To fit \(cloudPlanSentenceName(done.planId)), ADE \(how) \(these): \(list).\(kept)")
  }
  if !done.kept.isEmpty {
    parts.append("ADE kept \(done.kept.map(\.name).joined(separator: ", ")), because its work couldn't all be pushed to GitHub. Push its work or delete it yourself, or pick again in ADE.")
  }
  return parts.isEmpty ? nil : parts.joined(separator: " ")
}

/// A cheaper plan's limits on the phone: the server's sentence, then what
/// holds until the person picks on the desktop (the phone can't pick). Nil
/// when there is nothing to say.
func cloudPlanCleanupMessage(_ cleanup: CloudPhoneAccount.PlanCleanup) -> String? {
  if let ids = cleanup.freeing?.instanceIds {
    return "ADE is freeing \(ids.count == 1 ? "1 computer" : "\(ids.count) computers") you picked to fit \(cloudPlanSentenceName(cleanup.planId ?? "plus")). Their lanes and chats stay."
  }
  guard let sentence = cloudPhoneWords(cleanup.sentence) else { return nil }
  let when = cleanup.startsAt.map { "You move to \(cloudPlanSentenceName(cleanup.planId ?? "plus")) on \(cloudDate($0))." }
    ?? "ADE can't make a new computer until their disk fits."
  return "\(sentence) \(when) ADE deletes nothing on its own: delete computers, or pick the ones ADE frees in the ADE desktop app."
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
/// keep it from here (send a message in the lane) since "Keep it" is on the desktop.
func cloudIdleCleanupMessage(_ entry: CloudPhoneAccount.IdleCleanup, now: Double) -> String {
  let subject = entry.laneName.map { $0.isEmpty ? entry.displayName : "\($0)'s computer" } ?? entry.displayName
  if let held = entry.held {
    return "\(subject) wasn't deleted: ADE couldn't save its work. \(held.reason) Open the lane and push its work yourself, or delete the lane if you don't need it. ADE tries again \(cloudInHowLong(held.retryAt ?? entry.deletesAt, now: now))."
  }
  let save = entry.laneName != nil
    ? "ADE pushes its work to \(entry.branch ?? "the lane's branch") first, and the lane and its chats stay."
    : "ADE pushes its work to GitHub first."
  let ignored = cloudIgnoredFilesShort(entry.ignoredFiles)
  return "\(subject) will be \(cloudIdleCleanupWhen(entry.deletesAt, now: now)), on \(cloudDate(entry.deletesAt)), because it isn't used. \(save)\(ignored) To keep it, send a message in the lane, or choose Keep it in the ADE desktop app."
}

/// The ignored files a delete loses, in one short sentence (with a leading space), or "" when none were found.
func cloudIgnoredFilesShort(_ ignored: CloudPhoneAccount.IdleCleanup.IgnoredFiles?) -> String {
  guard let ignored else { return " Files git ignores, such as .env, aren't pushed." }
  let list: String?
  if ignored.paths.isEmpty {
    list = ignored.more > 0 ? "\(ignored.more) \(ignored.more == 1 ? "file" : "files")" : nil
  } else {
    let shown = ignored.paths.joined(separator: ", ")
    list = ignored.more > 0 ? "\(shown) and \(ignored.more) more" : shown
  }
  if ignored.incomplete == true {
    guard let list else { return " ADE couldn't read every lane to see which files git ignores, such as .env; those aren't pushed." }
    return " Files git ignores aren't pushed, so these won't be kept: \(list). ADE couldn't read every lane, so there may be more."
  }
  guard let list else { return "" }
  return " Files git ignores aren't pushed, so these won't be kept: \(list)."
}

/// Why timed wake-ups were cancelled and how they come back
/// (`timedWakesCancelledSentence`), in the phone's own words: what the person
/// can do that isn't a purchase (App Store 3.1.1). `resetsAt` is when the
/// hours reset, when the account says.
func cloudTimedWakesCancelledSentence(_ notice: CloudPhoneAccount.TimedWakesCancelled, resetsAt: Double?) -> String {
  let what = notice.count == 1 ? "A timed wake-up" : "\(notice.count) timed wake-ups"
  let head = "\(what) on your ADE Cloud computers won't run (a chat's scheduled wake-up or an automation's schedule)"
  let after = "each computer sets its next timed wake-up again the next time it runs."
  if notice.reason == "over_plan_disk" {
    return "\(head), because your computers hold more disk than the free plan has, so they can't wake. Once you delete a computer, \(after)"
  }
  let reset = resetsAt.map { "When your hours reset on \(cloudDate($0))" } ?? "When your hours reset"
  return "\(head), because you're out of ADE Cloud hours, so your computers can't wake. \(reset), \(after)"
}

/// The iPhone never points at a purchase (App Store 3.1.1/3.1.3): a server
/// message keeps only its sentences that don't mention one (getting a plan,
/// a paid plan, upgrading, adding or buying hours, extra hours or disk). A
/// plan named as a fact ("Plus allows 40 GB") stays. Nil when nothing is left.
func cloudPhoneWords(_ message: String?) -> String? {
  guard let message else { return nil }
  let purchase = ["get plus", "get pro", "get a paid plan", "paid plan", "upgrade", "add hours", "buy", "extra hours", "extra disk"]
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
  guard let recent = account.recentUse, recent.days > 0, recent.usedMilli > 0,
        let periodEnd = account.billing?.periodEnd else { return nil }
  let left = Double(account.hours.leftMilli)
  guard left > 0 else { return nil }
  let perDay = recent.usedMilli / recent.days
  let endsAt = now.timeIntervalSince1970 * 1000 + (left / perDay) * 86_400_000
  if endsAt >= periodEnd { return "At this pace your hours last until they reset" }
  return "At this pace your hours last until \(cloudDate(endsAt))"
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

/// "Small · 1× hours · 3.4 GB" (the last run sits under the state).
func cloudMachineLine(_ machine: CloudPhoneMachine, tier: CloudPhoneTier?, now: Date) -> String {
  let size = tier.map { "\($0.label) · \(cloudHoursRate($0.rate))" } ?? machine.size ?? machine.hoursRate.map(cloudHoursRate)
  let disk = machine.resources.map { cloudGb($0.diskGb) }
  return [size, disk].compactMap { $0 }.joined(separator: " · ")
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

  /// How long `leftMilli` hours last at this size (`cloudTierHoursAt`): rounded
  /// down, to a tenth under 10 h and to whole hours from 10 up: "7.5 h", "57 h".
  func hoursLeftLabel(_ leftMilli: Int) -> String {
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
  case "max": return "Max"
  default: return "Plus"
  }
}

/// "Free plan", "Plus plan", "Pro plan" (`planName`).
func cloudPlanName(_ account: CloudPhoneAccount) -> String {
  "\(cloudPlanLabel(account.currentPlanId)) plan"
}

/// Hours from thousandths, as the desktop writes them: "1,600", "118", "42.5".
func cloudHours(_ milli: Int) -> String {
  let hours = Double(max(0, milli)) / 1000
  let shown = hours >= 100 ? hours.rounded(.down) : (hours * 10).rounded(.down) / 10
  return shown.formatted(.number.precision(.fractionLength(0...1)).locale(Locale(identifier: "en_US")))
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
