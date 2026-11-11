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
    // The server's sentence, as the desktop shows it; the phone's own words
    // only when an older server sends none.
    let sentence = free.sentence?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    lines.append(sentence.isEmpty ? "This computer already used another account's free hours, so the free plan has no hours here." : sentence)
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

  /// How long `leftMilli` hours last at this size, rounded down to a tenth: "57.4 h".
  func hoursLeftLabel(_ leftMilli: Int) -> String {
    let hours = Double(max(0, leftMilli)) / Double(max(1, multiplierMilli))
    let shown = hours >= 100 ? hours.rounded(.down) : (hours * 10).rounded(.down) / 10
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
  let shown = hours >= 100 ? hours.rounded(.down) : (hours * 10).rounded(.down) / 10
  return shown.formatted(.number.precision(.fractionLength(0...1)).grouping(.never))
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
