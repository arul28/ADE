import CoreGraphics
import Foundation
import OSLog

private let appleViewerLog = Logger(subsystem: "com.ade.ios", category: "apple-stream")

/// The speed readout's numbers. Nil is "not measured yet", shown as a dash.
struct AppleViewerSpeed: Equatable {
  var fps: Int?
  var kbps: Double?
  var rttMs: Double?
  var tapToFrameMs: Double?
  var skipped: Int?
}

// MARK: - Model

/// Owns the ticket, the socket, the decoder, the health clock and the mode.
///
/// An `ObservableObject` rather than view state because all of it outlives a
/// SwiftUI body evaluation and must be torn down exactly once, on dismiss.
@MainActor
final class AppleDeviceViewerModel: ObservableObject {
  @Published private(set) var health = AppleStreamHealth()
  @Published private(set) var status: AppleDeviceStatus?
  @Published private(set) var mode: AppleDeviceViewerMode = .watching
  /// A sentence the view flashes once (control ended, a gesture refused).
  @Published private(set) var notice: String?
  @Published private(set) var speed = AppleViewerSpeed()
  /// The decoded picture's pixel size, published only when it changes: a
  /// rotation on the Mac or a Duo fold resizes the stage once, not per frame.
  @Published private(set) var contentPixelSize = CGSize(width: 9, height: 19.5)
  /// The machine the lane lives on, when it is not the focused one.
  @Published private(set) var machineName: String?

  let decoder = AppleStreamDecoder()

  private let socket = AppleStreamSocket()
  private weak var syncService: SyncService?
  private var laneId: String = ""
  private var chatSessionId: String?
  private var ticket: AppleStreamTicket?
  /// The helper's metrics in pixels, from the stream's config record.
  private var configPixels: CGSize?
  private var visible = true
  private var started = false
  private var rateMeter = AppleStreamRateMeter()
  private var latency = AppleTapLatencyProbe()
  private var networkStats: AppleStreamNetworkStats?
  private var lastSpeedPublish = Date.distantPast
  /// When the person last touched the picture while controlling.
  private var lastControlActivity = Date()

  #if DEBUG
  private var isPreview = false

  func installPreview(_ preview: AppleDeviceViewerPreview) {
    isPreview = true
    status = preview.status
    contentPixelSize = CGSize(width: 1206, height: 2622)
    health.frameDecoded(at: Date())
    speed = preview.speed
    mode = preview.mode
  }
  #endif

  /// Control hands itself back after this long without a touch: a phone put
  /// down mid-session should not leave a live input path into someone's Mac.
  static let controlIdleTimeout: TimeInterval = 5 * 60

  func attach(syncService: SyncService, laneId: String, chatSessionId: String?, status: AppleDeviceStatus?) {
    self.syncService = syncService
    self.laneId = laneId
    self.chatSessionId = chatSessionId
    if self.status == nil { self.status = status }
    machineName = syncService.appleLaneMachineName(laneId: laneId)
    if let size = Self.initialPixelSize(status: status, ticket: nil) {
      contentPixelSize = size
    }
    socket.onOpen = { [weak self] in
      self?.health.socketOpened(at: Date())
    }
    socket.onRecord = { [weak self] record in
      self?.handle(record)
    }
    socket.onStats = { [weak self] stats in
      self?.networkStats = stats
    }
    socket.onError = { [weak self] message in
      guard let self else { return }
      // A failure after frames were flowing is a stall the user can retry;
      // before any frame it is a connection that never worked. Both offer
      // Reconnect, but only the second names the host's own reason.
      self.health.fail(message)
      self.endControl()
    }
  }

  func start() async {
    guard !started else { return }
    started = true
    await connect()
  }

  func stop() {
    started = false
    mode = .watching
    socket.setVisible(false)
    socket.close()
    decoder.reset()
    health.reset()
  }

  func reconnect() async {
    // A fresh ticket, not a redial: tickets are short-lived and single-use by
    // design, so reusing one would fail in a way that reads like a broken Mac.
    socket.close()
    decoder.reset()
    ticket = nil
    configPixels = nil
    await connect()
  }

  func setVisible(_ nextVisible: Bool) {
    guard visible != nextVisible else { return }
    visible = nextVisible
    socket.setVisible(nextVisible)
    if !nextVisible {
      endControl()
      return
    }
    // Coming back: the brain stopped forwarding while we were away, and the
    // capture may have been stopped entirely, so a redial is the only way to
    // be sure of a keyframe.
    Task { await reconnect() }
  }

  func tick() {
    let now = Date()
    health.tick(now: now)
    if mode == .controlling {
      if health.phase != .streaming {
        endControl(notice: "Control ended: the picture stopped.")
      } else if now.timeIntervalSince(lastControlActivity) >= Self.controlIdleTimeout {
        endControl(notice: "Control ended after 5 idle minutes.")
      }
    }
    publishSpeed(now: now, force: true)
  }

  func clearNotice() {
    notice = nil
  }

  /// What the overlay says. The host's own capture error wins over the phone's
  /// "no frames arrived", because the Mac knows why its helper stopped and this
  /// end only knows that nothing showed up.
  var overlayMessage: String? {
    guard let message = health.statusMessage else { return nil }
    if case .stalled = health.phase, let hostError = status?.stream?.lastError, !hostError.isEmpty {
      return hostError
    }
    return message
  }

  func refreshStatus() async {
    guard let syncService, syncService.supportsAppleDeviceStatus(laneId: laneId) else { return }
    guard let next = try? await syncService.fetchAppleDeviceStatus(laneId: laneId) else { return }
    let previousUdid = status?.device?.udid
    status = next
    // Another device is behind the picture now: a touch aimed at the old one
    // must not land on it.
    if mode == .controlling, let previousUdid, next.device?.udid != previousUdid {
      endControl(notice: "The simulator changed. You're watching.")
      return
    }
    // An agent's chat claimed the device: the host refuses this phone's
    // touches from now on, so stop offering them before the next one fails.
    if mode == .controlling,
       let owner = appleDeviceOwnerLabel(appleDeviceForeignOwner(next.owner, viewerChatSessionId: chatSessionId)) {
      endControl(notice: "\(owner) took the simulator. You're watching.")
    }
  }

  // MARK: Control

  /// The helper's point metrics, or nil when this host cannot tell us (and
  /// so cannot be controlled from here).
  var pointMetrics: CGSize? {
    AppleDeviceTouchMapping.pointMetrics(
      configPixels: configPixels,
      ticketPixels: ticket?.pixelSize,
      ticketPoints: ticket?.pointSize
    )
  }

  /// Why Control cannot be offered, or nil when it can.
  var controlBlocker: String? {
    #if DEBUG
    if isPreview { return nil }
    #endif
    return appleDeviceControlBlocker(
      hostSupportsControl: syncService?.supportsAppleDeviceControl(laneId: laneId) ?? false,
      pointMetrics: pointMetrics,
      ownsDevice: appleStatusShowsLaneDevice(status),
      owner: appleDeviceForeignOwner(status?.owner, viewerChatSessionId: chatSessionId),
      streaming: health.phase == .streaming
    )
  }

  func beginControl() {
    if let blocker = controlBlocker {
      notice = blocker
      return
    }
    lastControlActivity = Date()
    mode = .controlling
    appleViewerLog.notice("control on lane=\(self.laneId, privacy: .public)")
  }

  func endControl(notice: String? = nil) {
    guard mode == .controlling else { return }
    mode = .watching
    if let notice { self.notice = notice }
    appleViewerLog.notice("control off lane=\(self.laneId, privacy: .public)")
  }

  /// A location on the stage, as device points, or nil when there is nothing
  /// to map against yet.
  func devicePoint(for location: CGPoint, in picture: CGRect, rotation: AppleDisplayRotation) -> CGPoint? {
    guard let metrics = pointMetrics,
          let fraction = AppleDeviceTouchMapping.frameFraction(of: location, in: picture, rotation: rotation)
    else { return nil }
    return AppleDeviceTouchMapping.devicePoint(frameFraction: fraction, metrics: metrics)
  }

  func send(gesture: AppleDeviceGesture, endingAt end: CGPoint) {
    let now = Date()
    send(gesture.input(endingAt: end, at: now), at: now)
  }

  func type(_ text: String) {
    guard !text.isEmpty else { return }
    send(.type(text), at: Date())
  }

  func pressHome() {
    send(.button("home"), at: Date())
  }

  /// Fired without waiting on the previous one, like the desktop pane: the
  /// host serialises device input in arrival order, and waiting here would
  /// add a round trip to every tap after the first.
  private func send(_ input: AppleDeviceInput, at sentAt: Date) {
    guard mode == .controlling, let syncService else { return }
    lastControlActivity = sentAt
    latency.gestureSent(at: sentAt)
    let lane = laneId
    let chat = chatSessionId
    Task { [weak self] in
      do {
        try await syncService.sendAppleDeviceInput(laneId: lane, chatSessionId: chat, input: input)
        let ms = Int(Date().timeIntervalSince(sentAt) * 1_000)
        appleViewerLog.debug("input acked in \(ms)ms")
      } catch {
        self?.inputFailed(error)
      }
    }
  }

  private func inputFailed(_ error: Error) {
    let nsError = error as NSError
    appleViewerLog.error("input failed: \(nsError.localizedDescription, privacy: .public)")
    // The host sends the code apart from the sentence, which it strips of the
    // code (and of nothing else: it names the claiming chat's raw id).
    if nsError.userInfo["ADEErrorCode"] as? String == "APPLE_OWNED_BY_OTHER_SESSION" {
      endControl(notice: "An agent is driving this simulator now. You're watching.")
      Task { await refreshStatus() }
      return
    }
    notice = nsError.localizedDescription
  }

  // MARK: Stream

  /// Aspect source before the first keyframe: the ticket's geometry, then the
  /// status's. The decoder's own size replaces it on the first frame.
  private static func initialPixelSize(status: AppleDeviceStatus?, ticket: AppleStreamTicket?) -> CGSize? {
    if let size = ticket?.pixelSize { return size }
    if let stream = status?.stream, let width = stream.width, let height = stream.height, width > 0, height > 0 {
      return CGSize(width: width, height: height)
    }
    return nil
  }

  private func connect() async {
    guard started else { return }
    guard let syncService else { return }
    guard syncService.supportsAppleDeviceStream(laneId: laneId) else {
      health.markUnsupported()
      return
    }
    health.requestTicket()
    let ticket: AppleStreamTicket
    do {
      ticket = try await syncService.requestAppleStreamTicket(laneId: laneId)
    } catch {
      health.fail(appleStreamTicketFailureMessage((error as NSError).localizedDescription))
      return
    }
    // The view may have been dismissed while the ticket round-trip was in
    // flight. Connecting now would reopen the socket `stop()` just closed and
    // leave a live WebSocket (and the Mac's capture) with no teardown.
    guard started, !Task.isCancelled else { return }
    self.ticket = ticket
    if let size = Self.initialPixelSize(status: status, ticket: ticket) {
      contentPixelSize = size
    }
    // The machine that minted the ticket is the one to dial: a lane on another
    // Mac answers on that Mac's address, not the focused one's.
    let endpoint = syncService.appleStreamEndpoint(laneId: laneId)
    guard
      let url = appleStreamSocketURL(
        ticketURL: ticket.url,
        path: ticket.path,
        token: ticket.token,
        connectedAddress: endpoint.address,
        fallbackPort: endpoint.fallbackPort
      )
    else {
      health.fail("Your Mac sent an address this phone can't reach.")
      return
    }
    health.connecting()
    decoder.reset()
    socket.connect(url: url, token: ticket.token)
    socket.setVisible(visible)
  }

  private func handle(_ record: AppleStreamRecord) {
    switch record {
    case .config(_, let width, let height, let annexB):
      guard annexB else {
        // The decoder is built from inline SPS/PPS, so a stream that is not
        // Annex-B would configure cleanly and then show nothing. Saying so is
        // better than a blank rectangle.
        health.fail("This Mac is sending video this phone can't decode.")
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
      if let size = decoder.presentedSize, size != contentPixelSize, size.width > 0, size.height > 0 {
        contentPixelSize = size
      }
      if let ms = latency.frame(bytes: bytes.count, keyframe: keyframe, at: now) {
        appleViewerLog.notice(
          "tap→frame \(Int(ms.rounded()))ms rtt=\(Int(self.networkStats?.rttMs ?? -1))ms"
        )
        publishSpeed(now: now, force: true)
      } else {
        publishSpeed(now: now, force: false)
      }
    }
  }

  /// At most four times a second: the readout is for people, and publishing
  /// per frame would re-render the whole viewer at the stream's frame rate.
  private func publishSpeed(now: Date, force: Bool) {
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
