import Combine
import Foundation
import QuartzCore
import UIKit

/// Field diagnostics for scroll smoothness on a real phone, for when
/// Instruments cannot attach (no cable).
///
/// Off unless the app launches with `-adeScrollDiagnostics 1` (launch
/// arguments land in `UserDefaults`). While on, a display link measures every
/// frame interval and tags it with the visible surface and whether a scroll
/// view is moving; counters record work on the suspect paths. Once a second the
/// window is appended as one JSON line to `Documents/scroll-diagnostics.jsonl`.
/// Pull it with `xcrun devicectl device copy from --domain-type
/// appDataContainer --domain-identifier com.ade.ios --source
/// Documents/scroll-diagnostics.jsonl --destination <local path>`.
@MainActor
final class ScrollDiagnostics {
  static let shared = ScrollDiagnostics()

  static var isEnabled: Bool {
    UserDefaults.standard.bool(forKey: "adeScrollDiagnostics")
  }

  enum Surface: String {
    case thread
    case workList
    case other
  }

  /// A timed code path. Keep the set small; each one is a suspect.
  enum Probe: String, CaseIterable {
    case transcriptApply
    case transcriptCellMeasure
    case workListReload
    case workListBody
    case workRowBody
    case threadViewBody
    /// A transcript cell built its row view (dequeue or reconfigure).
    case transcriptCellConfigure
    /// Rows `apply` asked UIKit to reconfigure.
    case transcriptReconfigure
    /// A transcript cell answered its self-sizing pass from the height cache.
    case transcriptCellCacheHit
    /// Inside `transcriptApply`: the diffable snapshot apply alone.
    case transcriptSnapshotApply
    /// Inside `transcriptApply`: the forced layout pass after it.
    case transcriptApplyLayout
    /// A transcript cell re-measured because its hosted content reported a
    /// size change (see `WorkChatTranscriptCell.contentSizeInvalidated`).
    case transcriptCellRemeasure
    /// A transcript row measured off screen while the reader was idle, so it
    /// scrolls in as a cache hit instead of measuring mid-scroll.
    case transcriptPremeasure
  }

  private struct ProbeStat {
    var count = 0
    var totalMs = 0.0
    var maxMs = 0.0
  }

  private var displayLink: CADisplayLink?
  private var lastTimestamp: CFTimeInterval = 0
  private var surfaceStack: [Surface] = []
  private var scrollingKeys = Set<String>()
  private var scrollingViews: Int { scrollingKeys.count }
  private var syncPublishCancellable: AnyCancellable?
  private var fileHandle: FileHandle?
  private var windowStartedAt: CFTimeInterval = 0

  // Current one-second window.
  private var frameIntervalsMs: [Double] = []
  private var scrollingFrames = 0
  private var hitches = 0
  private var hitchMs = 0.0
  private var syncPublishes = 0
  private var syncPublishesWhileScrolling = 0
  private var probes: [Probe: ProbeStat] = [:]
  /// The same probes, counted only while a scroll view is moving: work that
  /// lands during a scroll is what costs frames.
  private var probesWhileScrolling: [Probe: ProbeStat] = [:]
  /// Where the SyncService publishes in this window came from (see
  /// `publishSource()`).
  private var publishSources: [String: Int] = [:]
  /// The reader's row moved on screen inside a transcript layout pass by more
  /// than a pixel, without the reader moving it: the "text jumps" symptom.
  private var visibleJumps = 0
  private var visibleJumpPoints = 0.0
  private var windowSurface: Surface = .other
  #if DEBUG
  private var benchPublishTimer: Timer?
  #endif

  private init() {}

  /// Called once at launch. No-op unless the flag is set.
  func startIfEnabled() {
    guard Self.isEnabled, displayLink == nil else { return }
    openLog()
    let link = CADisplayLink(target: DisplayLinkProxy(owner: self), selector: #selector(DisplayLinkProxy.tick(_:)))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
    link.add(to: .main, forMode: .common)
    displayLink = link
    syncPublishCancellable = SyncService.shared?.objectWillChange.sink { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.syncPublishes += 1
        if self.scrollingViews > 0 { self.syncPublishesWhileScrolling += 1 }
        self.publishSources[Self.publishSource(), default: 0] += 1
      }
    }
    write(["event": "start", "maxFps": UIScreen.main.maximumFramesPerSecond, "device": Self.deviceModel])
    #if DEBUG
    startBenchPublisherIfRequested()
    #endif
  }

  /// The SyncService frame that raised a publish: the property setter (its
  /// mangled name carries the property) plus its caller. Diagnostics-only, and
  /// cheap next to the SwiftUI invalidation the publish itself triggers.
  private static func publishSource() -> String {
    let frames = Thread.callStackSymbols.dropFirst(3)
    var picked: [String] = []
    for frame in frames where frame.contains("SyncService") {
      // `0x… ADE  0x… $s3ADE11SyncServiceC…` -> the symbol column only.
      let symbol = frame.split(separator: " ", omittingEmptySubsequences: true)
        .first { $0.contains("SyncService") }
        .map(String.init) ?? frame
      picked.append(String(symbol.prefix(96)))
      if picked.count == 2 { break }
    }
    return picked.isEmpty ? "unknown" : picked.joined(separator: " <- ")
  }

  #if DEBUG
  /// Scroll-bench fixture: `-adeBenchSyncPublishHz <n>` fires SyncService's
  /// `objectWillChange` n times a second with nothing changed, standing in for
  /// the ~15/s a connected phone sees, so a simulator run can show what an
  /// unrelated publish costs the surface being scrolled.
  private func startBenchPublisherIfRequested() {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "-adeBenchSyncPublishHz"),
          index + 1 < arguments.count,
          let hz = Double(arguments[index + 1]), hz > 0
    else { return }
    let timer = Timer(timeInterval: 1 / hz, repeats: true) { _ in
      MainActor.assumeIsolated {
        SyncService.shared?.objectWillChange.send()
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    benchPublishTimer = timer
  }
  #endif

  // MARK: Tags from views

  func enter(_ surface: Surface) {
    guard displayLink != nil else { return }
    surfaceStack.append(surface)
  }

  func leave(_ surface: Surface) {
    guard displayLink != nil, let index = surfaceStack.lastIndex(of: surface) else { return }
    surfaceStack.remove(at: index)
  }

  /// A scroll view started moving (drag or momentum). Keyed so a drag that
  /// interrupts momentum does not count twice.
  func scrollBegan(_ key: String) {
    guard displayLink != nil else { return }
    scrollingKeys.insert(key)
  }

  func scrollEnded(_ key: String) {
    guard displayLink != nil else { return }
    scrollingKeys.remove(key)
  }

  // MARK: Probes

  /// Times `body` when diagnostics are on; a plain call otherwise.
  @discardableResult
  func measure<T>(_ probe: Probe, _ body: () throws -> T) rethrows -> T {
    guard displayLink != nil else { return try body() }
    let start = CACurrentMediaTime()
    defer { record(probe, ms: (CACurrentMediaTime() - start) * 1000) }
    return try body()
  }

  func count(_ probe: Probe) {
    guard displayLink != nil else { return }
    record(probe, ms: 0)
  }

  /// Records a duration measured by the caller (for async code paths).
  func record(_ probe: Probe, since start: CFTimeInterval) {
    guard displayLink != nil else { return }
    record(probe, ms: (CACurrentMediaTime() - start) * 1000)
  }

  var isRunning: Bool { displayLink != nil }

  private var frameLog: [String: (count: Int, bytes: Int, handleMs: Double, maxMs: Double)] = [:]
  private var frameLogStartedAt: CFTimeInterval = 0

  /// Incoming sync frames by type: count, bytes and time the phone spent
  /// handling them before reading the next frame. Flushed every 2 s as one
  /// line, so a host that closes on backpressure shows what the phone was
  /// slow on.
  func noteFrame(type: String, bytes: Int, handleMs: Double) {
    guard displayLink != nil else { return }
    let now = CACurrentMediaTime()
    if frameLogStartedAt == 0 { frameLogStartedAt = now }
    var entry = frameLog[type] ?? (0, 0, 0, 0)
    entry.count += 1
    entry.bytes += bytes
    entry.handleMs += handleMs
    entry.maxMs = max(entry.maxMs, handleMs)
    frameLog[type] = entry
    guard now - frameLogStartedAt >= 2 else { return }
    var fields: [String: Any] = [:]
    for (key, value) in frameLog {
      fields[key] = [
        "n": value.count,
        "kb": value.bytes / 1024,
        "ms": Int(value.handleMs.rounded()),
        "max": Int(value.maxMs.rounded()),
      ]
    }
    event("sync.frames", ["byType": fields])
    frameLog.removeAll()
    frameLogStartedAt = now
  }

  /// A one-off event line (connection failures and the like), written at once.
  func event(_ name: String, _ fields: [String: Any] = [:]) {
    guard displayLink != nil else { return }
    var line = fields
    line["event"] = name
    line["t"] = Date().timeIntervalSince1970
    line["surface"] = nil
    write(line)
  }

  private func record(_ probe: Probe, ms: Double) {
    Self.accumulate(&probes, probe, ms: ms)
    if scrollingViews > 0 {
      Self.accumulate(&probesWhileScrolling, probe, ms: ms)
    }
  }

  private static func accumulate(_ table: inout [Probe: ProbeStat], _ probe: Probe, ms: Double) {
    var stat = table[probe] ?? ProbeStat()
    stat.count += 1
    stat.totalMs += ms
    stat.maxMs = max(stat.maxMs, ms)
    table[probe] = stat
  }

  /// The reader's row moved on screen by `points` inside a layout pass.
  func noteVisibleJump(points: CGFloat) {
    guard displayLink != nil else { return }
    visibleJumps += 1
    visibleJumpPoints += Double(abs(points))
  }

  // MARK: Frames

  fileprivate func tick(_ link: CADisplayLink) {
    let now = link.timestamp
    let surface = surfaceStack.last ?? .other
    if lastTimestamp > 0 {
      let intervalMs = (now - lastTimestamp) * 1000
      let expectedMs = max(1, (link.targetTimestamp - link.timestamp) * 1000)
      // Only moving frames matter for smoothness; an idle screen may be
      // throttled by the system.
      if scrollingViews > 0 {
        frameIntervalsMs.append(intervalMs)
        scrollingFrames += 1
        if intervalMs > expectedMs * 1.5 {
          hitches += 1
          hitchMs += intervalMs - expectedMs
        }
      }
    }
    lastTimestamp = now
    if surface != windowSurface || now - windowStartedAt >= 1 {
      flushWindow(now: now)
      windowSurface = surface
    }
  }

  private func flushWindow(now: CFTimeInterval) {
    defer {
      windowStartedAt = now
      frameIntervalsMs.removeAll(keepingCapacity: true)
      scrollingFrames = 0
      hitches = 0
      hitchMs = 0
      syncPublishes = 0
      syncPublishesWhileScrolling = 0
      probes.removeAll(keepingCapacity: true)
      probesWhileScrolling.removeAll(keepingCapacity: true)
      publishSources.removeAll(keepingCapacity: true)
      visibleJumps = 0
      visibleJumpPoints = 0
    }
    guard scrollingFrames > 0 || !probes.isEmpty || syncPublishes > 0 else { return }
    let sorted = frameIntervalsMs.sorted()
    func percentile(_ p: Double) -> Double {
      guard !sorted.isEmpty else { return 0 }
      return sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))]
    }
    func fields(_ table: [Probe: ProbeStat]) -> [String: Any] {
      var result: [String: Any] = [:]
      for (probe, stat) in table {
        result[probe.rawValue] = [
          "n": stat.count,
          "ms": (stat.totalMs * 10).rounded() / 10,
          "max": (stat.maxMs * 10).rounded() / 10,
        ]
      }
      return result
    }
    let topSources = publishSources.sorted { $0.value > $1.value }.prefix(6)
    write([
      "t": Date().timeIntervalSince1970,
      "surface": windowSurface.rawValue,
      "scrollFrames": scrollingFrames,
      "hitches": hitches,
      "hitchMs": (hitchMs * 10).rounded() / 10,
      "p50": (percentile(0.5) * 10).rounded() / 10,
      "p95": (percentile(0.95) * 10).rounded() / 10,
      "max": ((sorted.last ?? 0) * 10).rounded() / 10,
      "syncPublishes": syncPublishes,
      "syncPublishesScrolling": syncPublishesWhileScrolling,
      "probes": fields(probes),
      "probesScrolling": fields(probesWhileScrolling),
      "publishSources": Dictionary(uniqueKeysWithValues: topSources.map { ($0.key, $0.value) }),
      "visibleJumps": visibleJumps,
      "visibleJumpPts": (visibleJumpPoints * 10).rounded() / 10,
    ])
  }

  // MARK: Log file

  private func openLog() {
    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
    let url = documents.appendingPathComponent("scroll-diagnostics.jsonl")
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    fileHandle = try? FileHandle(forWritingTo: url)
    _ = try? fileHandle?.seekToEnd()
  }

  private func write(_ object: [String: Any]) {
    guard let fileHandle,
          var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else { return }
    data.append(0x0A)
    try? fileHandle.write(contentsOf: data)
  }

  private static var deviceModel: String {
    var info = utsname()
    uname(&info)
    return withUnsafeBytes(of: &info.machine) { buffer in
      String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
    }
  }
}

@MainActor
private final class DisplayLinkProxy: NSObject {
  weak var owner: ScrollDiagnostics?

  init(owner: ScrollDiagnostics) {
    self.owner = owner
  }

  @objc func tick(_ link: CADisplayLink) {
    owner?.tick(link)
  }
}
