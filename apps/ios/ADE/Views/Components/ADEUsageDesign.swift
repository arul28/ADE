import Foundation
import SwiftUI

/// Shared visual vocabulary and precomputed chart geometry for every iOS usage
/// surface (the Settings Usage page and the Work new-chat activity module).
///
/// This is the iOS counterpart of the desktop `usageDesign.ts`: the same five
/// type steps, the same section/card rhythm, the same pressure thresholds, and
/// the same "top N providers plus a merged neutral Other" chart rule, so the two
/// products read as one.
///
/// Everything that costs more than a few dozen operations lives in a `build`
/// function that callers invoke from a task/`onChange` and hold in `@State` —
/// never from a SwiftUI `body`.

// MARK: - Type scale

/// Five steps, and no more. Anything that does not fit one of these belongs to a
/// role that already exists — pick the nearest step rather than adding a sixth.
enum ADEUsageType {
  /// The one hero figure per page. Tabular, tight tracking.
  static let hero: CGFloat = 32
  /// Section-leading values: metric-strip figures, provider totals.
  static let title: CGFloat = 18
  /// Body: table cells, provider names, primary labels.
  static let body: CGFloat = 14
  /// Supporting detail beneath a value.
  static let detail: CGFloat = 12
  /// Eyebrow labels, axis ticks, footnotes.
  static let micro: CGFloat = 11

  static func heroFont() -> Font { .system(size: hero, weight: .semibold).monospacedDigit() }
  static func titleFont(_ weight: Font.Weight = .semibold) -> Font {
    .system(size: title, weight: weight).monospacedDigit()
  }
  static func bodyFont(_ weight: Font.Weight = .regular) -> Font { .system(size: body, weight: weight) }
  static func detailFont(_ weight: Font.Weight = .regular) -> Font { .system(size: detail, weight: weight) }
  static func microFont(_ weight: Font.Weight = .regular) -> Font { .system(size: micro, weight: weight) }
}

// MARK: - Rhythm

enum ADEUsageLayout {
  /// Vertical rhythm between top-level bands of the page.
  static let sectionGap: CGFloat = 32
  /// Interior padding for cards and bands.
  static let cardPadding: CGFloat = 24
  /// Gap between related rows inside a single band.
  static let rowGap: CGFloat = 12
  static let cardCorner: CGFloat = 16
}

// MARK: - Pressure

/// Thresholds shared by the pace bars and the compact Work module, so "nearly
/// dry" means the same thing on both surfaces (and matches desktop).
enum ADEUsagePressure {
  static let warn: Double = 70
  static let critical: Double = 90

  static func color(percent: Double, providerColor: Color) -> Color {
    if percent > critical { return ADEColor.danger }
    if percent > warn { return ADEColor.warning }
    return providerColor
  }
}

// MARK: - Chart vocabulary

enum ADEUsageChartStyle {
  /// How many provider series the daily chart draws before merging the tail.
  /// Beyond roughly four the layered fills stop being separable by colour.
  static let maxSeries = 4
  static let otherId = "__other"
  static let otherLabel = "Other"
  /// Neutral colour for the merged tail, distinct from any brand token.
  static var otherColor: Color { ADEColor.textMuted }
}

// MARK: - Activity heatmap

/// The heatmap's five-step scale, shared with desktop (`activityIntensity.ts`
/// for the buckets, `HEATMAP_RAMP` in `ActivityHeatmap.tsx` for the colours) so
/// a busy Tuesday looks the same on both products.
enum ADEUsageHeatmap {
  /// 0 = no activity; 1–4 = quartile of the non-zero distribution.
  ///
  /// A linear value/max ramp is useless here: one 35.9B-token session is
  /// entirely normal, and that single outlier pushes every other day onto the
  /// floor tone. Quartiles are computed over the NON-ZERO days only, so empty
  /// days never dilute the distribution, and the busiest day always lands at
  /// level 4 even when the range is flat or carries a single spike.
  static func levels(_ scores: [Int]) -> [Int] {
    let active = scores.filter { $0 > 0 }.sorted()
    guard let maximum = active.last else { return scores.map { _ in 0 } }

    func percentile(_ fraction: Double) -> Int {
      let rank = Int(ceil(fraction * Double(active.count))) - 1
      return active[min(active.count - 1, max(0, rank))]
    }
    let thresholds = [percentile(0.25), percentile(0.5), percentile(0.75)]

    return scores.map { score in
      guard score > 0 else { return 0 }
      if score >= maximum { return 4 }
      var level = 1
      for threshold in thresholds where score > threshold { level += 1 }
      return min(4, level)
    }
  }

  /// Fill for a level. Level 0 is structure, not damage — a visible tile rather
  /// than a hole in the card.
  static func fill(level: Int) -> Color {
    switch level {
    case 1: return ADEColor.heatmapLevel1
    case 2: return ADEColor.heatmapLevel2
    case 3: return ADEColor.heatmapLevel3
    case let value where value >= 4: return ADEColor.heatmapLevel4
    default: return ADEColor.textMuted.opacity(0.14)
    }
  }

  /// Local calendar day as `yyyy-MM-dd`, matching the daily-point key format,
  /// so today's cell can be anchored without re-parsing every key.
  static func localDayKey(_ now: Date = Date()) -> String {
    let parts = Calendar.current.dateComponents([.year, .month, .day], from: now)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }
}

// MARK: - Formatting

/// Compact magnitude used by every usage surface (1.2K / 3.4M / 1.1B).
func adeUsageCompact(_ value: Int) -> String {
  if value >= 1_000_000_000 { return String(format: "%.1fB", Double(value) / 1_000_000_000) }
  if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
  if value >= 1_000 { return String(format: "%.1fK", Double(value) / 1_000) }
  return value.formatted()
}

/// Cost rendered at a precision that stays honest at both ends of the range:
/// sub-cent amounts keep three decimals rather than collapsing to "$0.00".
func adeUsageCost(_ value: Double) -> String {
  guard value.isFinite, value > 0 else { return "$0" }
  if value >= 1_000 { return String(format: "$%.0f", value) }
  if value >= 10 { return String(format: "$%.2f", value) }
  if value >= 0.01 { return String(format: "$%.2f", value) }
  return String(format: "$%.3f", value)
}

/// Rounds a magnitude UP to a readable 1/2/5×10^n step, so the tallest day is
/// never clipped and the axis label is a number a person would choose.
func adeUsageNiceCeiling(_ value: Double) -> Double {
  guard value.isFinite, value > 0 else { return 1 }
  let exponent = floor(log10(value))
  let magnitude = pow(10, exponent)
  let normalized = value / magnitude
  let step: Double
  if normalized <= 1 { step = 1 }
  else if normalized <= 2 { step = 2 }
  else if normalized <= 5 { step = 5 }
  else { step = 10 }
  return step * magnitude
}

private let adeUsageDayParser: DateFormatter = {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "yyyy-MM-dd"
  return formatter
}()

private let adeUsageDayDisplay: DateFormatter = {
  let formatter = DateFormatter()
  formatter.setLocalizedDateFormatFromTemplate("MMMd")
  return formatter
}()

func adeUsageFormatDay(_ date: String) -> String {
  guard let parsed = adeUsageDayParser.date(from: date) else { return date }
  return adeUsageDayDisplay.string(from: parsed)
}

func adeUsageParseISODate(_ iso: String?) -> Date? {
  guard let iso, !iso.isEmpty else { return nil }
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
}

func adeUsageRelativeTime(_ iso: String?) -> String {
  guard let date = adeUsageParseISODate(iso) else { return "not yet" }
  let seconds = max(0, Int(Date().timeIntervalSince(date)))
  if seconds < 60 { return "now" }
  if seconds < 3_600 { return "\(seconds / 60)m ago" }
  if seconds < 86_400 { return "\(seconds / 3_600)h ago" }
  return "\(seconds / 86_400)d ago"
}

/// "2d 3h" / "4h 12m" / "9m" — used by both reset labels and ETA-to-dry.
func adeUsageDurationLabel(milliseconds: Double) -> String {
  let seconds = max(0, Int(milliseconds / 1_000))
  let days = seconds / 86_400
  let hours = (seconds % 86_400) / 3_600
  let minutes = (seconds % 3_600) / 60
  if days > 0 { return "\(days)d \(hours)h" }
  if hours > 0 { return "\(hours)h \(minutes)m" }
  if minutes > 0 { return "\(minutes)m" }
  return "under a minute"
}

// MARK: - Quota pace

/// A quota window read as a rate rather than a level: how far through the window
/// we are, whether consumption is ahead of that, and when it runs dry.
///
/// `windowDurationMs` is absent on some hosts, so the duration falls back to the
/// window type's nominal length. Without a duration there is no elapsed
/// fraction, and pace/ETA are simply not offered rather than guessed.
struct ADEUsageWindowPace: Equatable {
  /// 0...1 through the window.
  var elapsedFraction: Double
  /// Percentage points ahead (+) or behind (−) an even burn.
  var paceDelta: Double
  /// Milliseconds until the quota reaches 100% at the current rate, when that
  /// happens before the window resets. Nil means it does not run dry first.
  var dryInMs: Double?
  var resetsInMs: Double

  var isAheadOfPace: Bool { paceDelta > 5 }
  var isBehindPace: Bool { paceDelta < -5 }

  var paceLabel: String {
    if isAheadOfPace { return "\(Int(paceDelta.rounded())) pts ahead of pace" }
    if isBehindPace { return "\(Int(abs(paceDelta).rounded())) pts under pace" }
    return "On pace"
  }

  var dryLabel: String {
    if let dryInMs { return "Dry in \(adeUsageDurationLabel(milliseconds: dryInMs))" }
    return "Lasts to reset"
  }
}

/// Nominal window lengths for hosts that omit `windowDurationMs`.
private func adeUsageNominalWindowMs(_ windowType: String) -> Double? {
  switch windowType {
  case "five_hour": return 5 * 3_600_000
  case "weekly", "weekly_oauth_apps", "weekly_cowork": return 7 * 86_400_000
  case "monthly": return 30 * 86_400_000
  default: return nil
  }
}

func adeUsageWindowPace(_ window: MobileUsageQuotaWindow) -> ADEUsageWindowPace? {
  var resolvedDuration = window.windowDurationMs ?? 0
  if resolvedDuration <= 0 { resolvedDuration = adeUsageNominalWindowMs(window.windowType) ?? 0 }
  let duration = resolvedDuration
  guard duration > 0 else { return nil }
  let resetsInMs = max(0, min(window.resetsInMs, duration))
  let elapsedMs = max(0, duration - resetsInMs)
  let elapsedFraction = min(1, elapsedMs / duration)
  let percent = window.clampedPercentUsed
  let expected = elapsedFraction * 100
  let remaining = max(0, 100 - percent)

  var dryInMs: Double?
  if elapsedMs > 0, percent > 0, remaining > 0 {
    let ratePerMs = percent / elapsedMs
    if ratePerMs > 0 {
      let projected = remaining / ratePerMs
      if projected < resetsInMs { dryInMs = projected }
    }
  } else if remaining == 0 {
    dryInMs = 0
  }

  return ADEUsageWindowPace(
    elapsedFraction: elapsedFraction,
    paceDelta: percent - expected,
    dryInMs: dryInMs,
    resetsInMs: resetsInMs
  )
}

func adeUsageWindowLabel(_ window: MobileUsageQuotaWindow) -> String {
  if window.windowType == "five_hour",
     let durationMs = window.windowDurationMs,
     durationMs > 0 {
    let minutes = Int((durationMs / 60_000).rounded())
    if minutes < 60 { return "\(minutes)-min" }
    let hours = Double(minutes) / 60
    if hours.rounded() == hours { return "\(Int(hours))-hour" }
    return String(format: "%.1f-hour", hours)
  }
  switch window.windowType {
  case "five_hour": return "5-hour"
  case "weekly": return "Weekly"
  case "monthly": return "Monthly"
  case "weekly_oauth_apps": return "OAuth apps"
  case "weekly_cowork": return "Cowork"
  default: return window.windowType.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

// MARK: - Estimation

/// How a provider's tokens were established. The hero cost carries a `*` whose
/// explanation is built from these.
enum ADEUsageEstimationKind: String {
  case exact
  case chars
  case distribution
  case mixed

  init(raw: String?) {
    self = ADEUsageEstimationKind(rawValue: raw ?? "exact") ?? .exact
  }

  var isEstimated: Bool { self != .exact }

  var shortLabel: String {
    switch self {
    case .exact: return "Counted"
    case .chars: return "Estimated"
    case .distribution: return "Modelled"
    case .mixed: return "Partly counted"
    }
  }

  var explanation: String {
    switch self {
    case .exact: return "Token counts came straight from the provider's ledger."
    case .chars: return "The ledger reports characters, not tokens — tokens are estimated from character counts."
    case .distribution: return "The ledger reports totals only — the input/output split is modelled from typical turns."
    case .mixed: return "Some days were counted from the ledger and some estimated from character counts."
    }
  }
}

// MARK: - Chart model

/// One provider's daily series. Values are already bucketed and aligned to
/// `ADEUsageChartModel.buckets`.
struct ADEUsageChartSeries: Identifiable, Equatable {
  var id: String
  var label: String
  var assetName: String?
  var color: Color
  /// Same count as `ADEUsageChartModel.buckets`.
  var values: [Double]
  var total: Double
}

/// Intermediate for ranking providers before the top-N / "Other" split.
private struct RankedProviderSeries {
  var provider: String
  var values: [Double]
  var total: Double
}

/// Fully precomputed chart geometry. Built once per (points, metric) change and
/// held in `@State`; the drawing code only scales normalized values.
struct ADEUsageChartModel: Equatable {
  enum Metric: String, Equatable {
    case cost
    case tokens

    var axisPrefix: String { self == .cost ? "$" : "" }
  }

  /// Bucket day keys (`yyyy-MM-dd`), oldest first.
  var buckets: [String] = []
  var series: [ADEUsageChartSeries] = []
  var yMax: Double = 1
  var metric: Metric = .tokens
  /// True when no host supplied `byProvider`, so this is one combined series.
  /// A real supported state, not an error.
  var isCombinedFallback = false

  var hasData: Bool { !buckets.isEmpty && series.contains { $0.total > 0 } }

  var axisTop: String {
    metric == .cost ? adeUsageCost(yMax) : adeUsageCompact(Int(yMax.rounded()))
  }

  var axisMid: String {
    metric == .cost ? adeUsageCost(yMax / 2) : adeUsageCompact(Int((yMax / 2).rounded()))
  }

  var startLabel: String { buckets.first.map(adeUsageFormatDay) ?? "" }
  var endLabel: String { buckets.last.map(adeUsageFormatDay) ?? "" }

  /// Builds the layered per-provider daily series.
  ///
  /// Deliberately NOT stacked: stacking makes whichever series draws last look
  /// permanently larger. Every series shares the zero baseline and the same
  /// y scale, so their heights are directly comparable.
  ///
  /// - Parameters:
  ///   - points: raw daily records from the host.
  ///   - metric: cost when the range has any cost attributed, else tokens.
  ///   - maxBuckets: caps the drawn resolution so a multi-year range does not
  ///     turn into thousands of path segments.
  static func build(
    points: [MobileAdeUsageDailyPoint],
    metric: Metric,
    maxBuckets: Int = 60
  ) -> ADEUsageChartModel {
    guard !points.isEmpty else { return ADEUsageChartModel(metric: metric) }
    // A host can report a range cost while predating per-day cost attribution.
    // Plotting cost then would draw an empty chart under a non-zero hero, so the
    // chart quietly falls back to tokens — the shape is the same story.
    let hasDailyCost = points.contains { point in
      point.byProvider?.values.contains { ($0.costUsd ?? 0) > 0 } == true
    }
    let resolvedMetric: Metric = (metric == .cost && hasDailyCost) ? .cost : .tokens
    let ordered = points.sorted { $0.date < $1.date }
    let chunkSize = max(1, Int(ceil(Double(ordered.count) / Double(maxBuckets))))
    let bucketCount = Int(ceil(Double(ordered.count) / Double(chunkSize)))

    var bucketDates: [String] = []
    bucketDates.reserveCapacity(bucketCount)
    // provider id -> per-bucket values, filled lazily so a provider that only
    // appears late still lines up with the bucket axis.
    var byProvider: [String: [Double]] = [:]
    var combined = [Double](repeating: 0, count: bucketCount)
    var sawProviderSplit = false

    var bucketIndex = 0
    var cursor = 0
    while cursor < ordered.count {
      let end = min(cursor + chunkSize, ordered.count)
      bucketDates.append(ordered[end - 1].date)
      for point in ordered[cursor..<end] {
        let flat = Double(point.totalTokens ?? 0)
        if resolvedMetric == .tokens { combined[bucketIndex] += flat }
        guard let split = point.byProvider, !split.isEmpty else {
          continue
        }
        sawProviderSplit = true
        for (provider, value) in split {
          let magnitude = resolvedMetric == .cost ? (value.costUsd ?? 0) : Double(value.totalTokens ?? 0)
          guard magnitude > 0 else { continue }
          if byProvider[provider] == nil {
            byProvider[provider] = [Double](repeating: 0, count: bucketCount)
          }
          byProvider[provider]?[bucketIndex] += magnitude
          if resolvedMetric == .cost { combined[bucketIndex] += magnitude }
        }
      }
      cursor = end
      bucketIndex += 1
    }

    var model = ADEUsageChartModel()
    model.buckets = bucketDates
    model.metric = resolvedMetric

    if !sawProviderSplit || byProvider.isEmpty {
      // Supported fallback: one combined series, drawn in the neutral accent.
      let total = combined.reduce(0, +)
      model.isCombinedFallback = true
      model.series = [
        ADEUsageChartSeries(
          id: "__all",
          label: "All providers",
          assetName: nil,
          color: ADEColor.purpleAccent,
          values: combined,
          total: total
        )
      ]
      model.yMax = adeUsageNiceCeiling(combined.max() ?? 0)
      return model
    }

    // Built with an explicit type and a plain loop: the equivalent
    // map/filter/sorted chain over an inferred tuple blows the type checker's
    // budget outright (`unable to type-check this expression in reasonable
    // time`), and this runs on every payload change.
    var ranked: [RankedProviderSeries] = []
    ranked.reserveCapacity(byProvider.count)
    for (provider, values) in byProvider {
      let total = values.reduce(0, +)
      if total > 0 {
        ranked.append(RankedProviderSeries(provider: provider, values: values, total: total))
      }
    }
    ranked.sort { lhs, rhs in
      lhs.total == rhs.total ? lhs.provider < rhs.provider : lhs.total > rhs.total
    }

    var series: [ADEUsageChartSeries] = []
    series.reserveCapacity(min(ranked.count, ADEUsageChartStyle.maxSeries + 1))
    for entry in ranked.prefix(ADEUsageChartStyle.maxSeries) {
      series.append(
        ADEUsageChartSeries(
          id: entry.provider,
          label: providerLabel(entry.provider),
          assetName: providerAssetName(entry.provider),
          color: ADEColor.providerBrand(for: entry.provider),
          values: entry.values,
          total: entry.total
        )
      )
    }
    let tail = ranked.dropFirst(ADEUsageChartStyle.maxSeries)
    if !tail.isEmpty {
      var merged = [Double](repeating: 0, count: bucketCount)
      for entry in tail {
        for index in 0..<bucketCount { merged[index] += entry.values[index] }
      }
      series.append(
        ADEUsageChartSeries(
          id: ADEUsageChartStyle.otherId,
          label: ADEUsageChartStyle.otherLabel,
          assetName: nil,
          color: ADEUsageChartStyle.otherColor,
          values: merged,
          total: merged.reduce(0, +)
        )
      )
    }

    model.series = series
    model.yMax = adeUsageNiceCeiling(series.flatMap(\.values).max() ?? 0)
    return model
  }
}

// MARK: - Shape-preserving smoothing

/// Monotone cubic Hermite (Fritsch–Carlson) control points.
///
/// Plain Catmull-Rom overshoots: a flat day between two busy ones dips below
/// zero and a spike gains a phantom shoulder, both of which read as data the
/// host never sent. Clamping the tangents keeps the curve smooth without ever
/// leaving the interval between neighbouring samples.
func adeUsageMonotoneTangents(_ values: [Double]) -> [Double] {
  let count = values.count
  guard count > 1 else { return [0] }
  var slopes = [Double](repeating: 0, count: count - 1)
  for index in 0..<(count - 1) { slopes[index] = values[index + 1] - values[index] }

  var tangents = [Double](repeating: 0, count: count)
  tangents[0] = slopes[0]
  tangents[count - 1] = slopes[count - 2]
  for index in 1..<(count - 1) {
    if slopes[index - 1] * slopes[index] <= 0 {
      tangents[index] = 0
    } else {
      tangents[index] = (slopes[index - 1] + slopes[index]) / 2
    }
  }
  for index in 0..<(count - 1) {
    if slopes[index] == 0 {
      tangents[index] = 0
      tangents[index + 1] = 0
      continue
    }
    let alpha = tangents[index] / slopes[index]
    let beta = tangents[index + 1] / slopes[index]
    let magnitude = alpha * alpha + beta * beta
    if magnitude > 9 {
      let scale = 3 / magnitude.squareRoot()
      tangents[index] = scale * alpha * slopes[index]
      tangents[index + 1] = scale * beta * slopes[index]
    }
  }
  return tangents
}

/// Builds the smooth line path for `values` scaled into `rect`.
func adeUsageSeriesPath(values: [Double], yMax: Double, in rect: CGRect) -> Path {
  var path = Path()
  guard values.count > 1, yMax > 0, rect.width > 0, rect.height > 0 else {
    if values.count == 1, yMax > 0 {
      let y = rect.maxY - rect.height * CGFloat(min(1, values[0] / yMax))
      path.move(to: CGPoint(x: rect.minX, y: y))
      path.addLine(to: CGPoint(x: rect.maxX, y: y))
    }
    return path
  }
  let step = rect.width / CGFloat(values.count - 1)
  let tangents = adeUsageMonotoneTangents(values)
  func point(_ index: Int) -> CGPoint {
    CGPoint(
      x: rect.minX + step * CGFloat(index),
      y: rect.maxY - rect.height * CGFloat(min(1, max(0, values[index] / yMax)))
    )
  }
  path.move(to: point(0))
  let scale = rect.height / CGFloat(yMax)
  for index in 0..<(values.count - 1) {
    let start = point(index)
    let end = point(index + 1)
    // Tangents are in value space; convert to the (inverted) y pixel space.
    let control1 = CGPoint(
      x: start.x + step / 3,
      y: start.y - CGFloat(tangents[index]) * scale / 3
    )
    let control2 = CGPoint(
      x: end.x - step / 3,
      y: end.y + CGFloat(tangents[index + 1]) * scale / 3
    )
    path.addCurve(to: end, control1: control1, control2: control2)
  }
  return path
}

/// The same curve closed down to the shared zero baseline, for the area fill.
func adeUsageSeriesAreaPath(values: [Double], yMax: Double, in rect: CGRect) -> Path {
  var path = adeUsageSeriesPath(values: values, yMax: yMax, in: rect)
  guard !path.isEmpty else { return path }
  path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
  path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
  path.closeSubpath()
  return path
}
