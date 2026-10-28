import CoreGraphics
import Foundation

// MARK: - Modes

/// What a touch on the simulator's picture does.
///
/// Watching is the default and the state the viewer falls back to whenever it
/// cannot be sure a touch would land where the person meant: backgrounded,
/// disconnected, stalled, or the device claimed by an agent's chat. A touch
/// that travels from a pocket to someone's Mac is worse than useless, so
/// controlling is something a person asks for and the viewer gives back.
enum AppleDeviceViewerMode: Equatable {
  case watching
  case controlling
}

/// Why the viewer cannot offer Control right now, in the words it shows.
///
/// Nil from `appleDeviceControlBlocker` means Control may be offered. Ordered
/// by what the person can do about it: an update, then a claim they can see,
/// then a picture that is not live yet.
func appleDeviceControlBlocker(
  hostSupportsControl: Bool,
  hasTicket: Bool,
  pointMetrics: CGSize?,
  ownsDevice: Bool,
  owner: AppleDeviceStatusOwner?,
  streaming: Bool
) -> String? {
  // Both are an older Mac: no input commands, or a ticket without points.
  // No ticket at all is not one: the stream has not started (or the Mac
  // refused it, and the viewer already shows why), so nothing is known yet.
  let hasMetrics = pointMetrics.map { $0.width > 0 && $0.height > 0 } ?? false
  guard hostSupportsControl, hasMetrics || !hasTicket else {
    return "Update ADE on your Mac to control its simulator from here."
  }
  guard ownsDevice else {
    return "This simulator isn't this lane's own, so it's watch-only."
  }
  if let label = appleDeviceOwnerLabel(owner) {
    return "\(label) is driving this simulator. You can watch."
  }
  guard streaming, hasMetrics else {
    return "Control turns on once the picture is live."
  }
  return nil
}

/// The claim that keeps this viewer from driving, or nil when there is none.
///
/// A claim by the chat the viewer was opened from is not one: that chat's own
/// desktop pane may drive its device, and so may its viewer. The host applies
/// the same rule to the `chatSessionId` the input carries.
func appleDeviceForeignOwner(
  _ owner: AppleDeviceStatusOwner?,
  viewerChatSessionId: String?
) -> AppleDeviceStatusOwner? {
  guard let owner, let claimant = owner.chatSessionId, !claimant.isEmpty else { return nil }
  if let viewerChatSessionId, viewerChatSessionId == claimant { return nil }
  return owner
}

// MARK: - Geometry

/// How far the phone turns the picture, clockwise, to make it readable.
///
/// Display only: nothing about the device on the Mac changes. It still matters
/// to a touch, which lands on the turned picture and has to be turned back
/// before it means a point on the device.
enum AppleDisplayRotation: Int, Equatable {
  case upright = 0
  case clockwise = 90

  var isSideways: Bool { self == .clockwise }

  var degrees: Double { Double(rawValue) }
}

enum AppleDeviceTouchMapping {
  /// The aspect-fit rect a `content`-sized picture takes inside `container`,
  /// once it is turned by `rotation`. This is the box the person sees.
  static func pictureRect(
    container: CGSize,
    content: CGSize,
    rotation: AppleDisplayRotation
  ) -> CGRect? {
    guard container.width > 0, container.height > 0 else { return nil }
    guard content.width > 0, content.height > 0 else { return nil }
    let drawn = rotation.isSideways ? CGSize(width: content.height, height: content.width) : content
    let scale = min(container.width / drawn.width, container.height / drawn.height)
    let size = CGSize(width: drawn.width * scale, height: drawn.height * scale)
    return CGRect(
      x: (container.width - size.width) / 2,
      y: (container.height - size.height) / 2,
      width: size.width,
      height: size.height
    )
  }

  /// A point inside the drawn picture, back to the same point on the RAW
  /// frame, both as 0...1 fractions.
  ///
  /// The inverse of turning the picture clockwise by a quarter: the raw
  /// frame's top-left ends up at the drawn picture's top-right. Mirrors
  /// `appleViewToFrameFraction(…, 90)` on the desktop.
  static func frameFraction(of point: CGPoint, in picture: CGRect, rotation: AppleDisplayRotation) -> CGPoint? {
    guard picture.width > 0, picture.height > 0 else { return nil }
    // Clamped rather than refused: a drag that leaves the picture should end
    // at the edge, not vanish and leave the device holding a touch.
    let x = min(max((point.x - picture.minX) / picture.width, 0), 1)
    let y = min(max((point.y - picture.minY) / picture.height, 0), 1)
    switch rotation {
    case .upright:
      return CGPoint(x: x, y: y)
    case .clockwise:
      return CGPoint(x: y, y: 1 - x)
    }
  }

  /// Device POINTS for a fraction of the raw frame.
  ///
  /// `metrics` is the helper's own point size: the helper divides every touch
  /// by it to get back to a fraction of the frame, so this is the one product
  /// that lands where the finger was, whatever way up the picture is.
  static func devicePoint(frameFraction: CGPoint, metrics: CGSize) -> CGPoint {
    CGPoint(x: frameFraction.x * metrics.width, y: frameFraction.y * metrics.height)
  }

  /// The helper's current point metrics.
  ///
  /// The stream's config record carries the helper's metrics in PIXELS, and
  /// it is re-sent whenever they change — a Duo folding to its other panel.
  /// The ticket fixes the points-per-pixel ratio, which a fold does not
  /// change. A decoded frame size is deliberately not used: an app drawing
  /// landscape turns the framebuffer while the helper's metrics, and so the
  /// meaning of a touch, stay portrait.
  static func pointMetrics(
    configPixels: CGSize?,
    ticketPixels: CGSize?,
    ticketPoints: CGSize?
  ) -> CGSize? {
    guard
      let ticketPoints, ticketPoints.width > 0, ticketPoints.height > 0
    else { return nil }
    guard
      let configPixels, configPixels.width > 0, configPixels.height > 0,
      let ticketPixels, ticketPixels.width > 0, ticketPixels.height > 0
    else { return ticketPoints }
    return CGSize(
      width: configPixels.width * ticketPoints.width / ticketPixels.width,
      height: configPixels.height * ticketPoints.height / ticketPixels.height
    )
  }
}

// MARK: - Gestures

/// What one control leaves the phone as. Device POINTS throughout.
enum AppleDeviceInput: Equatable {
  /// One phase of a live finger.
  case touch(phase: AppleTouchPhase, at: CGPoint)
  case tap(CGPoint)
  case drag(from: CGPoint, to: CGPoint, durationMs: Int)
  case type(String)
  /// A hardware button, by the helper's name (`home`, `lock`, …).
  case button(String)

  /// The sync command that carries it: `apple.input` for touches and text,
  /// the allowlisted `apple.invoke pressButton` for a button. Both carry the
  /// viewer's chat, which the host's ownership guard reads.
  func command(laneId: String, chatSessionId: String?) -> (action: String, args: [String: Any]) {
    var args: [String: Any] = ["laneId": laneId]
    if let chatSessionId { args["chatSessionId"] = chatSessionId }
    switch self {
    case .touch(let phase, let point):
      args["kind"] = "touch"
      args["phase"] = phase.rawValue
      args["x"] = Self.round(point.x)
      args["y"] = Self.round(point.y)
    case .tap(let point):
      args["kind"] = "tap"
      args["x"] = Self.round(point.x)
      args["y"] = Self.round(point.y)
    case .drag(let from, let to, let durationMs):
      args["kind"] = "drag"
      args["startX"] = Self.round(from.x)
      args["startY"] = Self.round(from.y)
      args["endX"] = Self.round(to.x)
      args["endY"] = Self.round(to.y)
      args["durationMs"] = durationMs
    case .type(let text):
      args["kind"] = "type"
      args["text"] = text
    case .button(let name):
      args["method"] = "pressButton"
      args["args"] = ["name": name]
      return ("apple.invoke", args)
    }
    return ("apple.input", args)
  }

  /// Device points to a tenth: finer than any finger, and short on the wire.
  private static func round(_ value: CGFloat) -> Double {
    (Double(value) * 10).rounded() / 10
  }
}

/// One finger on the picture, turned into ONE `apple.input` call.
///
/// The same rule as the desktop's `useAppleDeviceInput`: a press that did not
/// travel is a tap, one that did is a drag the Mac replays at its real
/// duration (so iOS reads a drag, not a flick). Sending a call per finger
/// sample would queue a trail of stale moves behind the finger on a slow link.
struct AppleDeviceGesture: Equatable {
  /// Travel, in device points, under which a gesture is a tap.
  static let tapSlopPoints: Double = 10
  static let minDragMs: Double = 60
  static let maxDragMs: Double = 2_000

  let start: CGPoint
  let startedAt: Date
  /// Sent as a live finger from its `begin`, so it must end the same way
  /// whatever happens to the stream meanwhile.
  var isLive = false
  private(set) var last: CGPoint
  private(set) var travel: Double = 0

  init(start: CGPoint, at date: Date) {
    self.start = start
    self.startedAt = date
    self.last = start
  }

  mutating func move(to point: CGPoint) {
    last = point
    travel = max(travel, hypot(point.x - start.x, point.y - start.y))
  }

  /// The finished gesture.
  func input(endingAt point: CGPoint, at date: Date) -> AppleDeviceInput {
    var finished = self
    finished.move(to: point)
    if finished.travel <= Self.tapSlopPoints {
      return .tap(finished.last)
    }
    let elapsed = date.timeIntervalSince(startedAt) * 1_000
    let durationMs = Int(min(Self.maxDragMs, max(Self.minDragMs, elapsed)).rounded())
    return .drag(from: start, to: finished.last, durationMs: durationMs)
  }
}

/// The phases of a live finger, as `apple.input` kind `touch` names them.
enum AppleTouchPhase: String, Equatable {
  case begin
  case move
  case end
}

/// A live finger, sent as it moves, one call in flight at a time.
///
/// `begin` and `end` are never dropped and never reordered; a `move` that has
/// not left yet is replaced by the newer one, because a finger is where it is
/// now, not the trail behind it. On a slow link the device sees fewer points
/// along the way, never stale ones after the finger has moved on.
///
/// While a finger is down, its point is repeated every `heartbeat`. A finger
/// held still sends nothing of its own, and the host lifts a finger it has
/// not heard about for a few seconds (the guard against a phone that drops
/// off the network mid-gesture), so a long press would otherwise be cut short.
@MainActor
final class AppleLiveTouchSender {
  static let heartbeat: Duration = .milliseconds(500)

  private var pending: [(phase: AppleTouchPhase, point: CGPoint)] = []
  private var busy = false
  private var heldPoint: CGPoint?
  private var heartbeatTask: Task<Void, Never>?
  private let send: (AppleTouchPhase, CGPoint) async -> Void

  init(send: @escaping (AppleTouchPhase, CGPoint) async -> Void) {
    self.send = send
  }

  func push(_ phase: AppleTouchPhase, at point: CGPoint) {
    switch phase {
    case .begin:
      heldPoint = point
      startHeartbeat()
    case .move:
      heldPoint = point
    case .end:
      heldPoint = nil
      heartbeatTask?.cancel()
      heartbeatTask = nil
    }
    enqueue(phase, at: point)
  }

  private func enqueue(_ phase: AppleTouchPhase, at point: CGPoint) {
    if phase == .move, let last = pending.last, last.phase == .move {
      pending[pending.count - 1] = (phase, point)
    } else {
      pending.append((phase, point))
    }
    guard !busy else { return }
    busy = true
    Task { await drain() }
  }

  private func startHeartbeat() {
    heartbeatTask?.cancel()
    heartbeatTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.heartbeat)
        guard !Task.isCancelled, let self, let point = self.heldPoint else { return }
        self.enqueue(.move, at: point)
      }
    }
  }

  private func drain() async {
    while !pending.isEmpty {
      let next = pending.removeFirst()
      await send(next.phase, next.point)
    }
    busy = false
  }
}

// MARK: - Speed

/// Tap-to-picture latency, measured on the phone.
///
/// The phone cannot see pixels (the decoder renders straight to the display
/// layer, by design), so "the picture changed" is read from the stream itself.
/// An idle simulator is captured at a 5 fps floor with tiny delta frames; a
/// change on screen starts a burst of frames a display refresh apart, and its
/// frames are several times the recent size. The first frame after a gesture
/// that shows either ends the sample. Measured on the Mac's own helper, both
/// signals fire on the first changed frame. A gesture that changes nothing on
/// screen produces no sample, and times out after `window` instead of lying.
struct AppleTapLatencyProbe {
  /// A frame this much larger than the recent average is a change on screen.
  static let changeFactor: Double = 3
  /// And at least this big: a near-empty frame doubling is still noise.
  static let minChangeBytes: Int = 1_500
  /// Frames closer than this are a burst, not the idle floor (~200 ms apart).
  static let burstGap: TimeInterval = 0.1
  static let window: TimeInterval = 2

  private var pendingSince: Date?
  /// Whether the stream was at its idle floor when the gesture left, which is
  /// the only time a burst means "this gesture changed the screen".
  private var idleAtSend = false
  private var lastFrameAt: Date?
  private var lastGap: TimeInterval?
  /// Exponential average of recent delta-frame sizes.
  private var averageBytes: Double = 0
  private var samples: [Double] = []

  /// A gesture just left the phone.
  mutating func gestureSent(at date: Date) {
    pendingSince = date
    let sinceLast = lastFrameAt.map { date.timeIntervalSince($0) } ?? .infinity
    idleAtSend = sinceLast >= Self.burstGap && (lastGap ?? .infinity) >= Self.burstGap
  }

  /// A decoded frame. Returns the latency in ms when it ends a sample.
  mutating func frame(bytes: Int, keyframe: Bool, at date: Date) -> Double? {
    let gap = lastFrameAt.map { date.timeIntervalSince($0) }
    defer {
      lastFrameAt = date
      lastGap = gap
      // Keyframes are large for their own reasons, and would teach the
      // average that every frame is a change.
      if !keyframe {
        averageBytes = averageBytes == 0 ? Double(bytes) : averageBytes * 0.9 + Double(bytes) * 0.1
      }
    }
    guard let since = pendingSince else { return nil }
    let elapsed = date.timeIntervalSince(since)
    if elapsed > Self.window {
      pendingSince = nil
      return nil
    }
    let threshold = max(Double(Self.minChangeBytes), averageBytes * Self.changeFactor)
    let burst = idleAtSend && (gap ?? .infinity) < Self.burstGap
    guard keyframe || burst || Double(bytes) >= threshold else { return nil }
    pendingSince = nil
    let ms = elapsed * 1_000
    samples.append(ms)
    if samples.count > 50 { samples.removeFirst(samples.count - 50) }
    return ms
  }

  /// The median of the recent samples, which one stray sample cannot move.
  var medianMs: Double? {
    guard !samples.isEmpty else { return nil }
    let sorted = samples.sorted()
    let mid = sorted.count / 2
    return sorted.count % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  }
}

/// Frames and bytes per second over a sliding second, for the speed readout.
struct AppleStreamRateMeter {
  private var events: [(at: Date, bytes: Int)] = []

  mutating func record(bytes: Int, at date: Date) {
    events.append((date, bytes))
    trim(now: date)
  }

  mutating func trim(now: Date) {
    let cutoff = now.addingTimeInterval(-1)
    if let firstKept = events.firstIndex(where: { $0.at >= cutoff }) {
      if firstKept > 0 { events.removeFirst(firstKept) }
    } else {
      events.removeAll()
    }
  }

  var framesPerSecond: Int { events.count }

  var kilobitsPerSecond: Double {
    Double(events.reduce(0) { $0 + $1.bytes }) * 8 / 1_000
  }
}
