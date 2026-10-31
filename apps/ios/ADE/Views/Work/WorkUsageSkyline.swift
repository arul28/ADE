/*
 * Ported from the "contribution-skyline" component on 21st.dev.
 * Copyright (c) Kedhareswer Naidu. Used under the MIT License:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 *
 * Changed for ADE: a native SwiftUI port of the desktop's
 * contributionSkylineModel.ts / contributionSkylineRender.ts, drawn in one
 * Canvas with ADE's iOS palette. Listed in the repository NOTICE.
 */
import SwiftUI
import UIKit

// The new-chat usage card's Activity view: every day a box on a week × weekday
// grid, seen from the corner, so a stretch of work reads as a skyline. Same
// scene, maths and look as desktop `ContributionSkyline` in its card form
// (3D, no toggle, stats or legend).
//
// Cost: one Canvas. The grid, heights, camera fit and the fully risen frame's
// projected faces and draw order are built once per (data, size) and cached in
// `@State`. The rise is a single SwiftUI animation of one number that ends by
// itself (skipped under Reduce Motion); at rest nothing redraws. The view is
// `Equatable`, so the composer's per-keystroke re-renders stop at it.

// MARK: - Data

/// One day as the skyline counts it: chats plus commits and PRs (git or
/// GitHub, whichever saw more), as desktop `skylineDays` does.
struct WorkUsageSkylineDay: Equatable {
  var date: String
  var count: Int
  /// "3 chats · 2 commits · 1.2M tokens"; nil for a day with nothing in it.
  var detail: String?
}

func workUsageSkylineDay(_ point: MobileAdeUsageDailyPoint) -> WorkUsageSkylineDay {
  let sessions = point.sessions ?? 0
  let commits = max(point.commits ?? 0, point.githubCommits ?? 0)
  let prs = max(point.prs ?? 0, point.githubPrs ?? 0)
  let split = (point.inputTokens ?? 0) + (point.outputTokens ?? 0) + (point.cachedTokens ?? 0)
  let tokens = max(split, point.totalTokens ?? 0)
  var parts: [String] = []
  if sessions > 0 { parts.append("\(sessions) \(sessions == 1 ? "chat" : "chats")") }
  if commits > 0 { parts.append("\(commits) \(commits == 1 ? "commit" : "commits")") }
  if prs > 0 { parts.append("\(prs) \(prs == 1 ? "PR" : "PRs")") }
  if tokens > 0 { parts.append("\(adeUsageCompact(tokens)) tokens") }
  return WorkUsageSkylineDay(
    date: point.date,
    // A day with only token usage (no chat row) still stands as a tower.
    count: max(sessions + commits + prs, tokens > 0 ? 1 : 0),
    detail: parts.isEmpty ? nil : parts.joined(separator: " · ")
  )
}

// MARK: - View

struct WorkUsageSkyline: View, Equatable {
  let points: [MobileAdeUsageDailyPoint]
  let selectedDate: String?
  /// A tapped day, or nil for a tap on empty space (clears the selection).
  let onSelect: (WorkUsageSkylineDay?) -> Void

  /// Parent re-renders (each keystroke in the composer) stop here unless the
  /// data or the selection changed. Arrays compare by storage first, so an
  /// unchanged `stats.daily` is an O(1) check.
  nonisolated static func == (lhs: WorkUsageSkyline, rhs: WorkUsageSkyline) -> Bool {
    lhs.points == rhs.points && lhs.selectedDate == rhs.selectedDate
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.colorSchemeContrast) private var contrast
  @State private var size: CGSize = .zero
  @State private var today = ADEUsageDay.localDayKey()
  @State private var layout: WorkUsageSkylineLayout?
  @State private var rise: Double = 0
  @State private var hasRisen = false

  /// Desktop's morph length is 1300ms; a touch shorter on a phone card.
  private static let riseDuration: Double = 1.2

  private var selectedIndex: Int {
    guard let selectedDate, let layout else { return -1 }
    return layout.indexByDate[selectedDate] ?? -1
  }

  var body: some View {
    WorkUsageSkylineCanvas(
      rise: rise,
      layout: layout,
      selected: selectedIndex,
      palette: colorScheme == .dark ? .dark : .light,
      increasedContrast: contrast == .increased
    )
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
    .onChange(
      of: WorkUsageSkylineInput(
        points: points,
        width: Int(size.width.rounded()),
        height: Int(size.height.rounded()),
        today: today
      ),
      initial: true
    ) { _, input in rebuild(input) }
    // The street ends today: a card left open past midnight moves on a day.
    .onReceive(NotificationCenter.default.publisher(for: UIApplication.significantTimeChangeNotification)) { _ in
      today = ADEUsageDay.localDayKey()
    }
    .contentShape(Rectangle())
    .onTapGesture(coordinateSpace: .local) { location in
      guard let layout else { return }
      let index = layout.hit(location)
      onSelect(index >= 0 ? layout.day(at: index) : nil)
    }
    .accessibilityElement()
    .accessibilityLabel("Activity skyline")
    .accessibilityValue(accessibilityValue)
    .accessibilityHint("Swipe up or down to step through days.")
    .accessibilityAdjustableAction { direction in
      guard let layout, layout.count > 0 else { return }
      let current = selectedIndex
      let start = current >= 0 ? current : layout.count
      let next: Int
      switch direction {
      case .increment: next = min(layout.count - 1, start + 1)
      case .decrement: next = max(0, start - 1)
      @unknown default: return
      }
      // The parent toggles a re-selected day off; stay put at either end.
      guard next != current else { return }
      onSelect(layout.day(at: next))
    }
  }

  private var accessibilityValue: String {
    guard let layout else { return "Loading" }
    let index = selectedIndex
    if index >= 0 {
      let day = layout.day(at: index)
      return "\(day.detail ?? "No activity"), \(adeUsageFormatDay(day.date))"
    }
    let total = layout.total
    return "\(total) \(total == 1 ? "contribution" : "contributions") over \(layout.weeks) weeks"
  }

  private func rebuild(_ input: WorkUsageSkylineInput) {
    let next = WorkUsageSkylineLayout(
      points: input.points,
      width: Double(input.width),
      height: Double(input.height),
      today: input.today
    )
    layout = next
    // One rise per appearance, the first time there is something to draw.
    // Later data or size changes redraw at rest, as desktop does.
    guard next != nil, !hasRisen else { return }
    hasRisen = true
    if reduceMotion {
      rise = 1
    } else {
      rise = 0
      withAnimation(.linear(duration: Self.riseDuration)) { rise = 1 }
    }
  }
}

private struct WorkUsageSkylineInput: Equatable {
  var points: [MobileAdeUsageDailyPoint]
  var width: Int
  var height: Int
  var today: String
}

/// The drawing half. `rise` is the morph's linear time (0 flat, 1 risen);
/// SwiftUI interpolates it frame by frame only while the rise animation runs.
private struct WorkUsageSkylineCanvas: View, Animatable {
  var rise: Double
  let layout: WorkUsageSkylineLayout?
  let selected: Int
  let palette: WorkUsageSkylinePalette
  let increasedContrast: Bool

  var animatableData: Double {
    get { rise }
    set { rise = newValue }
  }

  var body: some View {
    Canvas { context, _ in
      guard let layout else { return }
      // At rest, the cached frame; mid-rise, one projection per frame.
      let frame = (rise >= 1 ? layout.final : nil) ?? layout.frame(at: rise)
      WorkUsageSkylineRenderer.draw(
        in: context,
        layout: layout,
        frame: frame,
        selected: selected,
        palette: palette,
        increasedContrast: increasedContrast
      )
    }
    .accessibilityHidden(true)
  }
}

// MARK: - Maths (contributionSkylineModel.ts)

enum SkylineMath {
  static let elev3D = 34.0 * .pi / 180
  static let yawMax = 82.0 * .pi / 180
  /// Share of the morph each bar spends waiting: the wave sweeps oldest week → newest.
  static let wave = 0.42
  /// The 3D view's padding, pt: the bars run close to the card's edges.
  static let pad3D = 6.0

  @inline(__always) static func clamp01(_ v: Double) -> Double { v > 0 ? (v < 1 ? v : 1) : 0 }
  @inline(__always) static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

  static func easeInOutCubic(_ x: Double) -> Double {
    let t = clamp01(x)
    return t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
  }

  static func easeOutCubic(_ x: Double) -> Double { 1 - pow(1 - clamp01(x), 3) }

  static func smoothstep(_ a: Double, _ b: Double, _ x: Double) -> Double {
    let t = clamp01((x - a) / (b - a))
    return t * t * (3 - 2 * t)
  }

  /// 0 for an empty day, else 1–4 by quarters of `busy`.
  static func level(_ count: Int, busy: Int) -> UInt8 {
    if count <= 0 { return 0 }
    if busy <= 0 { return 4 }
    return UInt8(1 + min(3, Int(floor(Double(count) / Double(busy) * 4))))
  }

  /// Box height in grid units. Empty days are thin slabs; a busy day is ~7.6 cells tall.
  static func barHeight(_ count: Int, max: Double) -> Double {
    count > 0 && max > 0 ? 0.4 + pow(min(1.15, Double(count) / max), 0.85) * 7.2 : 0.2
  }

  /// 0 → 1 as a bar rises during the morph.
  static func riseAt(_ t: Double, week: Double, weeks: Int, day: Double) -> Double {
    let delay = (weeks > 1 ? week / Double(weeks - 1) : 0) * 0.36 + (day / 6) * 0.06
    return easeOutCubic((t - delay) / (1 - wave))
  }

  // Civil dates as day numbers (days since 1970-01-01), so "YYYY-MM-DD" keys
  // are read literally with no time zone in the way.
  static func dayNumber(_ key: String) -> Int? {
    let bytes = Array(key.utf8.prefix(10))
    guard bytes.count == 10, bytes[4] == 0x2D, bytes[7] == 0x2D else { return nil }
    func number(_ range: Range<Int>) -> Int? {
      var value = 0
      for index in range {
        let byte = bytes[index]
        guard byte >= 0x30, byte <= 0x39 else { return nil }
        value = value * 10 + Int(byte - 0x30)
      }
      return value
    }
    guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10),
          (1...12).contains(month), (1...31).contains(day) else { return nil }
    let y = month <= 2 ? year - 1 : year
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let mp = (month + 9) % 12
    let doy = (153 * mp + 2) / 5 + day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
  }

  /// `yyyy-MM-dd` for a day number.
  static func dayKey(_ dayNumber: Int) -> String {
    let date = civil(dayNumber)
    return String(format: "%04d-%02d-%02d", date.year, date.month, date.day)
  }

  static func civil(_ dayNumber: Int) -> (year: Int, month: Int, day: Int) {
    let z = dayNumber + 719_468
    let era = (z >= 0 ? z : z - 146_096) / 146_097
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let day = doy - (153 * mp + 2) / 5 + 1
    let month = mp < 10 ? mp + 3 : mp - 9
    return (yoe + era * 400 + (month <= 2 ? 1 : 0), month, day)
  }

  /// 0 = Sunday.
  static func weekday(_ dayNumber: Int) -> Int { ((dayNumber % 7) + 7 + 4) % 7 }
}

/// e=0 looks straight down; e=1 is the corner view. No orbit on the phone card.
private struct SkylineCamera {
  let cs: Double
  let sn: Double
  let se: Double
  let ce: Double

  init(e: Double, baseYaw: Double) {
    let yaw = min(SkylineMath.yawMax, max(0, SkylineMath.lerp(0, baseYaw, e)))
    let elev = SkylineMath.lerp(.pi / 2, SkylineMath.elev3D, e)
    cs = cos(yaw)
    sn = sin(yaw)
    se = sin(elev)
    ce = cos(elev)
  }

  /// World (x = week, y = weekday, z = up) → screen, before scale/offset.
  @inline(__always) func x(_ x: Double, _ y: Double) -> Double { x * cs - y * sn }
  @inline(__always) func y(_ x: Double, _ y: Double, _ z: Double) -> Double { (x * sn + y * cs) * se - z * ce }
}

/// One drawable state of the scene: where every face lands on screen and the
/// back-to-front order to paint them in.
struct WorkUsageSkylineFrame {
  fileprivate let camera: SkylineCamera
  fileprivate let scale: Double
  fileprivate let originX: Double
  fileprivate let originY: Double
  fileprivate let boxWidth: Double
  fileprivate let boxOffset: Double
  fileprivate let eased: Double
  fileprivate let topRadius: Double
  fileprivate let zs: [Double]
  /// 12 points per cell: top, +y side (left on screen), +x side (right on screen).
  fileprivate let quads: [CGPoint]
  /// Bit 1: left side visible, bit 2: right side visible.
  fileprivate let faces: [UInt8]
  fileprivate let order: [Int]
  fileprivate let labelAlpha: Double
  fileprivate let labelAnchors: [(label: String, at: CGPoint)]
}

/// Everything built once per (data, size): the grid, levels, heights, the
/// camera fit, and the fully risen frame.
struct WorkUsageSkylineLayout {
  let width: Double
  let height: Double
  let weeks: Int
  let total: Int
  fileprivate let days: [WorkUsageSkylineDay]
  fileprivate let week: [Double]
  fileprivate let weekday: [Double]
  fileprivate let level: [UInt8]
  fileprivate let barHeight: [Double]
  fileprivate let months: [(week: Int, label: String)]
  fileprivate var baseYaw: Double = .pi / 4
  fileprivate var barScale: Double = 1
  let indexByDate: [String: Int]
  /// The fully risen frame: what every redraw at rest paints, and what taps hit.
  private(set) var final: WorkUsageSkylineFrame?

  var count: Int { days.count }
  func day(at index: Int) -> WorkUsageSkylineDay { days[index] }

  init?(points: [MobileAdeUsageDailyPoint], width: Double, height: Double, today: String) {
    guard width >= 40, height >= 30 else { return nil }
    self.width = width
    self.height = height

    // Repeated dates add up, as desktop `buildGrid` does.
    var byDay: [Int: (count: Int, detail: String?)] = [:]
    var latest = SkylineMath.dayNumber(today) ?? 0
    for point in points {
      guard let number = SkylineMath.dayNumber(point.date) else { continue }
      latest = max(latest, number)
      let day = workUsageSkylineDay(point)
      guard day.count > 0 || day.detail != nil else { continue }
      let prior = byDay[number]
      byDay[number] = ((prior?.count ?? 0) + day.count, prior?.detail ?? day.detail)
    }

    // Weeks follow the width: a column narrower than ~10pt stops reading as a
    // day. Columns are weeks, rows weekdays with Monday on top; the last
    // column holds the latest day. A short history starts the street a week
    // before its first active day, not a year back (it sat as a few small
    // towers at the far end of an empty street), but keeps it long enough to
    // span the card: about four weeks per unit of the card's aspect.
    let widthWeeks = max(8, min(53, Int((width - 8) / 11)))
    let historyWeeks = byDay.keys.min().map { (latest - $0) / 7 + 2 } ?? widthWeeks
    let shortestStreet = max(12, Int(width / height * 4))
    let weeks = min(widthWeeks, max(shortestStreet, historyWeeks))
    let weekStart = 1
    let end = latest
    var start = end - (weeks * 7 - 1)
    start -= (SkylineMath.weekday(start) - weekStart + 7) % 7
    while end - start + 1 > weeks * 7 { start += 7 }

    var days: [WorkUsageSkylineDay] = []
    var week: [Double] = []
    var weekday: [Double] = []
    var indexByDate: [String: Int] = [:]
    var months: [(week: Int, label: String)] = []
    let monthNames = Calendar.current.shortMonthSymbols
    var priorMonth = -1
    let cellCount = end - start + 1
    days.reserveCapacity(cellCount)
    for offset in 0..<cellCount {
      let number = start + offset
      let civil = SkylineMath.civil(number)
      let key = SkylineMath.dayKey(number)
      let entry = byDay[number]
      indexByDate[key] = offset
      days.append(WorkUsageSkylineDay(date: key, count: entry?.count ?? 0, detail: entry?.detail))
      week.append(Double(offset / 7))
      weekday.append(Double(offset % 7))
      // A label on each week whose first day starts a new month.
      if offset % 7 == 0 {
        if civil.month != priorMonth, monthNames.indices.contains(civil.month - 1) {
          months.append((offset / 7, monthNames[civil.month - 1]))
        }
        priorMonth = civil.month
      }
    }
    // A cramped first label is dropped.
    if months.count > 1, months[1].week - months[0].week < 3 { months.removeFirst() }

    // Levels split the non-zero days by their share of a busy day (the 95th
    // percentile), so one freak day can't wash every other day out.
    let nonZero = days.map(\.count).filter { $0 > 0 }.sorted()
    let busy = nonZero.isEmpty ? 0 : nonZero[Int(floor(0.95 * Double(nonZero.count - 1)))]
    let tallest = nonZero.isEmpty ? 0 : min(Double(nonZero[nonZero.count - 1]), Double(busy) * 1.6)

    self.days = days
    self.week = week
    self.weekday = weekday
    self.level = days.map { SkylineMath.level($0.count, busy: busy) }
    self.barHeight = days.map { SkylineMath.barHeight($0.count, max: tallest) }
    self.months = months
    self.weeks = cellCount > 0 ? (cellCount - 1) / 7 + 1 : 0
    self.total = nonZero.reduce(0, +)
    self.indexByDate = indexByDate
    fit()
    final = frame(at: 1)
  }

  /// Projected extent of the scene for a camera, with each bar at `z(i)`.
  private func extent(_ cam: SkylineCamera, e: Double, z: (Int) -> Double)
    -> (minX: Double, maxX: Double, minY: Double, maxY: Double)
  {
    let w = SkylineMath.lerp(0.78, 0.9, e)
    let off = (1 - w) / 2
    var minX = Double.infinity, maxX = -Double.infinity
    var minY = Double.infinity, maxY = -Double.infinity
    func add(_ x: Double, _ y: Double, _ z: Double) {
      let px = cam.x(x, y)
      let py = cam.y(x, y, z)
      if px < minX { minX = px }
      if px > maxX { maxX = px }
      if py < minY { minY = py }
      if py > maxY { maxY = py }
    }
    for i in 0..<days.count {
      let x0 = week[i] + off
      let y0 = weekday[i] + off
      let zi = z(i)
      add(x0, y0, zi)
      add(x0 + w, y0, zi)
      add(x0, y0 + w, zi)
      add(x0 + w, y0 + w, 0)
      add(x0, y0 + w, 0)
      add(x0 + w, y0, 0)
    }
    // Room for the month labels that run along the front edge in 3D.
    add(0, 7 + 1.5 * e, 0)
    add(Double(weeks), 7 + 1.5 * e, 0)
    return (minX, maxX, minY, maxY)
  }

  /// Desktop `fit3d`: the turn (8°–45°) at which the risen skyline draws
  /// biggest, the more corner-on among near ties; then, in a short wide box,
  /// bars come down (to no less than 60%) until the skyline spans the width.
  private mutating func fit() {
    barScale = 1
    let aw = width - SkylineMath.pad3D * 2
    let ah = height - SkylineMath.pad3D * 2
    guard aw > 0, ah > 0, !days.isEmpty else { return }
    func sizeAt(_ yaw: Double, _ zk: Double) -> (w: Double, h: Double) {
      let b = extent(SkylineCamera(e: 1, baseYaw: yaw), e: 1) { barHeight[$0] * zk }
      return (aw / max(1e-6, b.maxX - b.minX), ah / max(1e-6, b.maxY - b.minY))
    }
    var fits: [(yaw: Double, s: Double)] = []
    for deg in 8...45 {
      let yaw = Double(deg) * .pi / 180
      let size = sizeAt(yaw, 1)
      fits.append((yaw, min(size.w, size.h)))
    }
    let best = fits.map(\.s).max() ?? 0
    baseYaw = fits.last { $0.s >= best * 0.96 }?.yaw ?? .pi / 4
    let atFull = sizeAt(baseYaw, 1)
    if atFull.h >= atFull.w { return }
    var lo = 0.6
    var hi = 1.0
    let atFloor = sizeAt(baseYaw, lo)
    if atFloor.h < atFloor.w {
      barScale = lo
      return
    }
    for _ in 0..<12 {
      let mid = (lo + hi) / 2
      let size = sizeAt(baseYaw, mid)
      if size.h >= size.w { lo = mid } else { hi = mid }
    }
    barScale = lo
  }

  /// The scene at morph time `t`: camera eased, bars waved up oldest → newest.
  func frame(at t: Double) -> WorkUsageSkylineFrame {
    let n = days.count
    let e = SkylineMath.easeInOutCubic(t)
    let cam = SkylineCamera(e: e, baseYaw: baseYaw)
    var zs = [Double](repeating: 0, count: n)
    for i in 0..<n {
      zs[i] = SkylineMath.riseAt(t, week: week[i], weeks: weeks, day: weekday[i]) * barHeight[i] * barScale
    }
    let b = extent(cam, e: e) { zs[$0] }
    let pad = SkylineMath.lerp(2, SkylineMath.pad3D, e)
    let aw = width - pad * 2
    let ah = height - pad * 2
    let bw = max(1e-6, b.maxX - b.minX)
    let bh = max(1e-6, b.maxY - b.minY)
    let s = min(aw / bw, ah / bh)
    let ox = pad + (aw - bw * s) / 2 - b.minX * s
    let oy = pad + (ah - bh * s) / 2 - b.minY * s
    let w = SkylineMath.lerp(0.78, 0.9, e)
    let off = (1 - w) / 2

    // Painter's order: far cells first.
    var depth = [Double](repeating: 0, count: n)
    for i in 0..<n { depth[i] = (week[i] + 0.5) * cam.sn + (weekday[i] + 0.5) * cam.cs }
    let order = (0..<n).sorted { depth[$0] < depth[$1] }

    var quads = [CGPoint](repeating: .zero, count: n * 12)
    var faces = [UInt8](repeating: 0, count: n)
    for i in 0..<n {
      faces[i] = writeQuads(i, z: zs[i], cam: cam, s: s, ox: ox, oy: oy, w: w, off: off, into: &quads, at: i * 12)
    }

    let labelAlpha = SkylineMath.smoothstep(0.62, 1, e)
    let anchors = months.map { month -> (label: String, at: CGPoint) in
      let x = Double(month.week) + 0.5
      return (month.label, CGPoint(x: ox + cam.x(x, 7.3) * s, y: oy + cam.y(x, 7.3, 0) * s + 2))
    }

    return WorkUsageSkylineFrame(
      camera: cam, scale: s, originX: ox, originY: oy, boxWidth: w, boxOffset: off, eased: e,
      topRadius: SkylineMath.lerp(0.17, 0.03, e) * s, zs: zs, quads: quads, faces: faces,
      order: order, labelAlpha: labelAlpha, labelAnchors: anchors
    )
  }

  /// Writes cell `i`'s three faces at height `z`; returns which sides show.
  @discardableResult
  fileprivate func writeQuads(
    _ i: Int, z: Double, cam: SkylineCamera, s: Double, ox: Double, oy: Double, w: Double, off: Double,
    into p: inout [CGPoint], at o: Int
  ) -> UInt8 {
    let x0 = week[i] + off
    let y0 = weekday[i] + off
    let x1 = x0 + w
    let y1 = y0 + w
    func pt(_ x: Double, _ y: Double, _ z: Double) -> CGPoint {
      CGPoint(x: ox + cam.x(x, y) * s, y: oy + cam.y(x, y, z) * s)
    }
    // top
    p[o] = pt(x0, y0, z)
    p[o + 1] = pt(x1, y0, z)
    p[o + 2] = pt(x1, y1, z)
    p[o + 3] = pt(x0, y1, z)
    // +y face (left on screen)
    p[o + 4] = pt(x0, y1, 0)
    p[o + 5] = pt(x1, y1, 0)
    p[o + 6] = p[o + 2]
    p[o + 7] = p[o + 3]
    // +x face (right on screen)
    p[o + 8] = pt(x1, y0, 0)
    p[o + 9] = p[o + 5]
    p[o + 10] = p[o + 2]
    p[o + 11] = p[o + 1]
    let tall = z * cam.ce * s
    var f: UInt8 = 0
    if tall > 0.35, w * cam.cs * s > 0.35 { f |= 1 }
    if tall > 0.35, w * cam.sn * s > 0.35 { f |= 2 }
    return f
  }

  /// The front-most cell under a point of the risen skyline, or -1.
  func hit(_ point: CGPoint) -> Int {
    guard let final else { return -1 }
    for k in stride(from: final.order.count - 1, through: 0, by: -1) {
      let i = final.order[k]
      let o = i * 12
      if Self.pointInQuad(final.quads, o, point) { return i }
      if final.faces[i] & 1 != 0, Self.pointInQuad(final.quads, o + 4, point) { return i }
      if final.faces[i] & 2 != 0, Self.pointInQuad(final.quads, o + 8, point) { return i }
    }
    return -1
  }

  private static func pointInQuad(_ p: [CGPoint], _ o: Int, _ q: CGPoint) -> Bool {
    var sign = 0
    for k in 0..<4 {
      let a = p[o + k]
      let b = p[o + (k + 1) % 4]
      let cross = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x)
      if abs(cross) < 1e-9 { continue }
      let s = cross > 0 ? 1 : -1
      if sign == 0 { sign = s } else if s != sign { return false }
    }
    return sign != 0
  }
}

// MARK: - Colour (contributionSkyline.css)

private struct SkylineRGBA {
  var r: Double
  var g: Double
  var b: Double
  var a: Double

  init(r: Double, g: Double, b: Double, a: Double) {
    self.r = r
    self.g = g
    self.b = b
    self.a = a
  }

  init(_ color: Color, _ style: UIUserInterfaceStyle) {
    let resolved = UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
    self.init(r: Double(r), g: Double(g), b: Double(b), a: Double(a))
  }

  /// `color-mix(in srgb, self k, other)`.
  func mix(_ k: Double, _ other: SkylineRGBA) -> SkylineRGBA {
    SkylineRGBA(r: r * k + other.r * (1 - k), g: g * k + other.g * (1 - k), b: b * k + other.b * (1 - k), a: 1)
  }

  func shaded(_ k: Double) -> SkylineRGBA { SkylineRGBA(r: r * k, g: g * k, b: b * k, a: a) }

  var shading: GraphicsContext.Shading {
    .color(Color(.sRGB, red: r, green: g, blue: b, opacity: a))
  }
}

/// The five levels are the accent stepped into the page background; an empty
/// day is a faint tint of the text colour. Resolved once per appearance.
struct WorkUsageSkylinePalette {
  /// [level] → (top, left side, right side): lit top, shaded sides.
  fileprivate let faces: [(top: GraphicsContext.Shading, left: GraphicsContext.Shading, right: GraphicsContext.Shading)]
  /// The tapped day: nudged toward the text colour and fully opaque.
  fileprivate let selectedFaces: [(top: GraphicsContext.Shading, left: GraphicsContext.Shading, right: GraphicsContext.Shading)]
  fileprivate let selectedStroke: GraphicsContext.Shading
  fileprivate let contrastStroke: GraphicsContext.Shading
  fileprivate let label: Color

  static let dark = WorkUsageSkylinePalette(style: .dark)
  static let light = WorkUsageSkylinePalette(style: .light)

  private init(style: UIUserInterfaceStyle) {
    let dark = style == .dark
    let fg = SkylineRGBA(ADEColor.textPrimary, style)
    let bg = SkylineRGBA(ADEColor.pageBackground, style)
    let accent = SkylineRGBA(ADEColor.accent, style)
    let bright = SkylineRGBA(ADEColor.accentBright, style)
    let levels: [SkylineRGBA] = dark
      ? [
        SkylineRGBA(r: fg.r, g: fg.g, b: fg.b, a: 0.09),
        accent.mix(0.30, bg),
        accent.mix(0.54, bg),
        accent.mix(0.80, bg),
        bright.mix(0.60, accent),
      ]
      : [
        SkylineRGBA(r: fg.r, g: fg.g, b: fg.b, a: 0.08),
        accent.mix(0.24, bg),
        accent.mix(0.48, bg),
        accent.mix(0.76, bg),
        accent.mix(0.82, fg),
      ]
    faces = levels.map { ($0.shading, $0.shaded(0.84).shading, $0.shaded(0.68).shading) }
    selectedFaces = levels.map { level in
      let m = 0.16
      let lit = SkylineRGBA(
        r: level.r + (fg.r - level.r) * m,
        g: level.g + (fg.g - level.g) * m,
        b: level.b + (fg.b - level.b) * m,
        a: 1
      )
      return (lit.shading, lit.shaded(0.84).shading, lit.shaded(0.68).shading)
    }
    selectedStroke = SkylineRGBA(r: fg.r, g: fg.g, b: fg.b, a: 0.85).shading
    contrastStroke = SkylineRGBA(r: fg.r, g: fg.g, b: fg.b, a: 0.3).shading
    let muted = fg.mix(0.55, bg)
    label = Color(.sRGB, red: muted.r, green: muted.g, blue: muted.b, opacity: 1)
  }
}

// MARK: - Render (contributionSkylineRender.ts `draw`)

private enum WorkUsageSkylineRenderer {
  static func draw(
    in context: GraphicsContext,
    layout: WorkUsageSkylineLayout,
    frame: WorkUsageSkylineFrame,
    selected: Int,
    palette: WorkUsageSkylinePalette,
    increasedContrast: Bool
  ) {
    let lift = 0.7 * frame.eased
    var liftedQuads = [CGPoint](repeating: .zero, count: 12)

    func cell(_ quads: [CGPoint], _ o: Int, faces f: UInt8, level: Int, isSelected: Bool) {
      let shades = isSelected ? palette.selectedFaces[level] : palette.faces[level]
      if f & 1 != 0 { context.fill(quadPath(quads, o + 4, radius: 0), with: shades.left) }
      if f & 2 != 0 { context.fill(quadPath(quads, o + 8, radius: 0), with: shades.right) }
      let top = quadPath(quads, o, radius: frame.topRadius)
      context.fill(top, with: shades.top)
      if isSelected {
        context.stroke(top, with: palette.selectedStroke, lineWidth: 1.5)
      } else if increasedContrast {
        context.stroke(top, with: palette.contrastStroke, lineWidth: 0.5)
      }
    }

    for i in frame.order {
      let level = Int(min(4, layout.level[i]))
      guard i == selected else {
        cell(frame.quads, i * 12, faces: frame.faces[i], level: level, isSelected: false)
        continue
      }
      // The tapped day stands a little proud of its neighbours.
      let f = layout.writeQuads(
        i, z: frame.zs[i] + lift, cam: frame.camera, s: frame.scale,
        ox: frame.originX, oy: frame.originY, w: frame.boxWidth, off: frame.boxOffset,
        into: &liftedQuads, at: 0
      )
      cell(liftedQuads, 0, faces: f, level: level, isSelected: true)
    }

    // Month labels along the front edge; they fade in as the skyline settles.
    guard frame.labelAlpha > 0.004, !frame.labelAnchors.isEmpty else { return }
    var labels = context
    labels.opacity = frame.labelAlpha
    var edge = -Double.infinity
    for anchor in frame.labelAnchors {
      let text = labels.resolve(
        Text(anchor.label).font(.system(size: 9, weight: .medium)).foregroundStyle(palette.label)
      )
      let textWidth = text.measure(in: CGSize(width: 200, height: 40)).width
      let x = anchor.at.x
      if x < edge || x + textWidth > layout.width { continue }
      labels.draw(text, at: anchor.at, anchor: .topLeading)
      edge = x + textWidth + 10
    }
  }

  /// A face; the top's corners round while the view is still flat.
  private static func quadPath(_ p: [CGPoint], _ o: Int, radius: Double) -> Path {
    var path = Path()
    if radius < 0.3 {
      path.move(to: p[o])
      path.addLine(to: p[o + 1])
      path.addLine(to: p[o + 2])
      path.addLine(to: p[o + 3])
      path.closeSubpath()
      return path
    }
    path.move(to: CGPoint(x: (p[o + 3].x + p[o].x) / 2, y: (p[o + 3].y + p[o].y) / 2))
    for k in 0..<4 {
      path.addArc(tangent1End: p[o + k], tangent2End: p[o + (k + 1) % 4], radius: radius)
    }
    path.closeSubpath()
    return path
  }
}
