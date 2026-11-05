import CoreGraphics
import Foundation
import OSLog

/// The part of a live device stream both viewers share: the socket, the
/// decoder, the health clock, the speed readout and the quiet automatic
/// redial. The simulator's model and the emulator's hold one each and keep
/// only what differs: how a ticket is asked for, the device's status, and
/// Control.
///
/// The owning model publishes for it. Every change to `health`, `speed` or
/// `contentPixelSize` sends the model's `objectWillChange` (`onWillChange`),
/// as when they were the model's own `@Published` values.
@MainActor
final class AppleStreamSession {
  /// Sends the owning model's `objectWillChange`.
  var onWillChange: (() -> Void)?
  /// The owning model's connect: asks for a fresh ticket and opens it.
  var dial: (() async -> Void)?

  var health = AppleStreamHealth() {
    willSet { onWillChange?() }
  }
  var speed = AppleViewerSpeed() {
    willSet { onWillChange?() }
  }
  /// The decoded picture's pixel size, set only when it changes: a rotation
  /// or a Duo fold resizes the stage once, not per frame.
  var contentPixelSize = CGSize(width: 9, height: 19.5) {
    willSet { onWillChange?() }
  }

  let decoder = AppleStreamDecoder()
  let socket = AppleStreamSocket()
  var ticket: AppleStreamTicket?
  /// The video's size in pixels, from the stream's config record.
  var configPixels: CGSize?
  var started = false
  private(set) var visible = true
  var latency = AppleTapLatencyProbe()
  private var rateMeter = AppleStreamRateMeter()
  private var networkStats: AppleStreamNetworkStats?
  private var lastSpeedPublish = Date.distantPast
  /// Automatic redials after a transient drop, and the one that is pending.
  private var retryPolicy = AppleStreamRetryPolicy()
  private var retryTask: Task<Void, Never>?

  private let log: Logger
  /// What the stream says when its video is not Annex-B.
  private let undecodableMessage: String
  /// Whether a stream that stops sending frames is stalled. False for the
  /// emulator, whose encoder sends a frame only when the screen changes: once
  /// frames came, a quiet stream is a still screen, and only the first-frame
  /// timeout runs.
  private let watchesFrameStalls: Bool
  /// Whether each tap's round trip to the screen goes to the log.
  private let logsTapToFrame: Bool

  init(log: Logger, undecodableMessage: String, watchesFrameStalls: Bool, logsTapToFrame: Bool) {
    self.log = log
    self.undecodableMessage = undecodableMessage
    self.watchesFrameStalls = watchesFrameStalls
    self.logsTapToFrame = logsTapToFrame
    socket.onOpen = { [weak self] in
      let now = Date()
      self?.health.socketOpened(at: now)
      self?.retryPolicy.streamOpened(at: now)
    }
    socket.onRecord = { [weak self] record in
      self?.handle(record)
    }
    socket.onStats = { [weak self] stats in
      self?.networkStats = stats
    }
  }

  /// Closes the stream for good (the view went away).
  func stop() {
    started = false
    cancelAutoRetry()
    retryPolicy.reset()
    socket.setVisible(false)
    socket.close()
    decoder.reset()
    health.reset()
  }

  /// The Reconnect action: the person asked, so the automatic budget refills.
  func reconnect() async {
    cancelAutoRetry()
    retryPolicy.reset()
    await redial()
  }

  /// A fresh ticket, not a redial of the old one: tickets are short-lived and
  /// single-use by design, so reusing one would fail in a way that reads like
  /// a broken computer.
  private func redial() async {
    socket.close()
    decoder.reset()
    ticket = nil
    configPixels = nil
    await dial?()
  }

  /// Whether anyone is looking. False when nothing changed. Going away
  /// cancels a pending redial: none behind the person's back. Coming back is
  /// the model's to redial.
  func setVisible(_ nextVisible: Bool) -> Bool {
    guard visible != nextVisible else { return false }
    visible = nextVisible
    socket.setVisible(nextVisible)
    if !nextVisible {
      cancelAutoRetry()
    }
    return true
  }

  /// Opens the video socket for a fresh ticket, at the address of the machine
  /// that minted it.
  func openSocket(_ ticket: AppleStreamTicket, endpoint: (address: String?, fallbackPort: Int), unreachableMessage: String) {
    guard
      let url = appleStreamSocketURL(
        ticketURL: ticket.url,
        path: ticket.path,
        token: ticket.token,
        connectedAddress: endpoint.address,
        fallbackPort: endpoint.fallbackPort
      )
    else {
      health.fail(unreachableMessage)
      return
    }
    health.connecting()
    decoder.reset()
    socket.connect(url: url, token: ticket.token)
    socket.setVisible(visible)
  }

  /// The health clock, once a second. True when a socket that opened drew no
  /// frame in time: the relay race's other face, which the model may redial
  /// quietly.
  func tickHealth(now: Date) -> Bool {
    let before = health.phase
    guard watchesFrameStalls || before == .connecting else { return false }
    health.tick(now: now)
    return before == .connecting && health.phase == .stalled && !health.sawFrame
  }

  /// Why Control has to end now, or nil: the picture stopped, or nobody has
  /// touched it for `idleTimeout`.
  func controlEndNotice(now: Date, lastControlActivity: Date, idleTimeout: TimeInterval) -> String? {
    if health.phase != .streaming {
      return "Control ended: the picture stopped."
    }
    if now.timeIntervalSince(lastControlActivity) >= idleTimeout {
      return "Control ended after 5 idle minutes."
    }
    return nil
  }

  /// Schedules one automatic redial, with a fresh ticket, and says so. False
  /// when the failure has to be shown instead (see `AppleStreamRetryPolicy`).
  func scheduleAutoRetry(transient: Bool) -> Bool {
    if retryTask != nil { return true }
    guard let delay = retryPolicy.nextDelay(transient: transient, started: started, visible: visible) else {
      return false
    }
    socket.close()
    decoder.reset()
    health.reconnecting()
    log.notice("stream redial \(self.retryPolicy.attempts, privacy: .public) in \(delay, privacy: .public)s")
    retryTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      guard let self, !Task.isCancelled else { return }
      self.retryTask = nil
      guard self.started, self.visible else { return }
      await self.redial()
    }
    return true
  }

  func cancelAutoRetry() {
    retryTask?.cancel()
    retryTask = nil
  }

  private func handle(_ record: AppleStreamRecord) {
    switch record {
    case .config(_, let width, let height, let annexB):
      guard annexB else {
        // The decoder is built from inline SPS/PPS, so a stream that is not
        // Annex-B would configure cleanly and then show nothing. Saying so is
        // better than a blank rectangle.
        health.fail(undecodableMessage)
        socket.close()
        return
      }
      if let width, let height, width > 0, height > 0 {
        configPixels = CGSize(width: width, height: height)
      }
    case .accessUnit(let keyframe, let bytes):
      let now = Date()
      rateMeter.record(bytes: bytes.count, at: now)
      guard decoder.decode(accessUnit: bytes, keyframe: keyframe) else { return }
      health.frameDecoded(at: now)
      retryPolicy.frameDecoded(at: now)
      if let size = decoder.presentedSize, size != contentPixelSize, size.width > 0, size.height > 0 {
        contentPixelSize = size
      }
      if let ms = latency.frame(bytes: bytes.count, keyframe: keyframe, at: now) {
        if logsTapToFrame {
          log.notice(
            "tap→frame \(Int(ms.rounded()))ms rtt=\(Int(self.networkStats?.rttMs ?? -1))ms"
          )
        }
        publishSpeed(now: now, force: true)
      } else {
        publishSpeed(now: now, force: false)
      }
    }
  }

  /// At most four times a second: the readout is for people, and publishing
  /// per frame would re-render the whole viewer at the stream's frame rate.
  func publishSpeed(now: Date, force: Bool) {
    guard force || now.timeIntervalSince(lastSpeedPublish) >= 0.25 else { return }
    lastSpeedPublish = now
    rateMeter.trim(now: now)
    let next = AppleViewerSpeed(
      fps: health.phase == .streaming ? rateMeter.framesPerSecond : nil,
      kbps: health.phase == .streaming ? rateMeter.kilobitsPerSecond : nil,
      rttMs: networkStats?.rttMs,
      tapToFrameMs: latency.medianMs,
      skipped: networkStats?.skipped
    )
    if next != speed { speed = next }
  }
}
