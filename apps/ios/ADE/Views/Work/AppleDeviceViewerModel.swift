import Combine
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
  @Published private(set) var status: AppleDeviceStatus?
  @Published private(set) var mode: AppleDeviceViewerMode = .watching
  /// A sentence the view flashes once (control ended, a gesture refused).
  @Published private(set) var notice: String?
  /// The machine the lane lives on, when it is not the focused one.
  @Published private(set) var machineName: String?
  /// A Duo simulator's pose, from the stream. Nil for every other device and
  /// from hosts that do not send it.
  @Published private(set) var posture: AppleStreamPosture?

  /// Whether the phone in the person's hand folds. Sticky for the app's life:
  /// the front screen may not report the hinge.
  static var phoneFolds = false

  /// The socket, decoder, health clock, speed and redials, shared with the
  /// emulator's model. The config record's size is the helper's metrics in
  /// pixels.
  private let stream = AppleStreamSession(
    log: appleViewerLog,
    undecodableMessage: "This Mac is sending video this phone can't decode.",
    watchesFrameStalls: true,
    logsTapToFrame: true
  )
  private weak var syncService: SyncService?
  private var laneId: String = ""
  private var chatSessionId: String?
  /// When the person last touched the picture while controlling.
  private var lastControlActivity = Date()
  private lazy var liveTouch = AppleLiveTouchSender { [weak self] phase, point in
    await self?.sendNow(.touch(phase: phase, at: point))
  }
  /// Fold mirroring: one fold in flight, the newest target waiting behind it.
  private var pendingFold: AppleFoldTarget?
  private var foldInFlight = false
  private var lastFold: AppleFoldTarget?
  private var lastAskedOrientation: String?

  var health: AppleStreamHealth { stream.health }
  var speed: AppleViewerSpeed { stream.speed }
  /// The decoded picture's pixel size, published only when it changes: a
  /// rotation on the Mac or a Duo fold resizes the stage once, not per frame.
  var contentPixelSize: CGSize { stream.contentPixelSize }
  var decoder: AppleStreamDecoder { stream.decoder }

  init() {
    stream.onWillChange = { [weak self] in self?.objectWillChange.send() }
    stream.dial = { [weak self] in await self?.connect() }
  }

  #if DEBUG
  private var isPreview = false

  func installPreview(_ preview: AppleDeviceViewerPreview) {
    isPreview = true
    status = preview.status
    stream.contentPixelSize = CGSize(width: 1206, height: 2622)
    stream.health.frameDecoded(at: Date())
    stream.speed = preview.speed
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
      stream.contentPixelSize = size
    }
    stream.socket.onPosture = { [weak self] posture in
      guard let self, self.posture != posture else { return }
      self.posture = posture
    }
    stream.socket.onError = { [weak self] failure in
      guard let self else { return }
      self.endControl()
      // A transient drop is redialed quietly a few times first. A refusal, or
      // a drop once the budget is spent, offers Reconnect with its reason.
      if self.stream.scheduleAutoRetry(transient: failure.transient) { return }
      self.stream.health.fail(failure.message)
    }
  }

  func start() async {
    guard !stream.started else { return }
    stream.started = true
    await connect()
  }

  func stop() {
    mode = .watching
    stream.stop()
    posture = nil
    pendingFold = nil
  }

  /// How far the picture turns to read upright before the person's own turn:
  /// a Duo's live panel as the guest says it sits, nothing for other devices.
  var guestRotation: AppleDisplayRotation {
    AppleDisplayRotation.guestTurn(displayOrientation: posture?.displayOrientation, framePixels: contentPixelSize)
  }

  /// The simulator folds (it is a Duo whose stream says so).
  var deviceFolds: Bool { posture != nil }

  /// The Reconnect action: the person asked, so the automatic budget refills.
  func reconnect() async {
    await stream.reconnect()
  }

  func setVisible(_ nextVisible: Bool) {
    guard stream.setVisible(nextVisible) else { return }
    if !nextVisible {
      // Nobody is looking: no redial behind their back (the session cancels
      // a pending one). Coming back redials.
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
    // A socket that opened and never drew a frame is the relay race's other
    // face. Redial it quietly, unless the Mac has said why its capture failed.
    if stream.tickHealth(now: now), (status?.stream?.lastError ?? "").isEmpty {
      _ = stream.scheduleAutoRetry(transient: true)
    }
    if mode == .controlling,
       let notice = stream.controlEndNotice(now: now, lastControlActivity: lastControlActivity, idleTimeout: Self.controlIdleTimeout) {
      endControl(notice: notice)
    }
    stream.publishSpeed(now: now, force: true)
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
      return appleHostErrorMessage(hostError)
    }
    return message
  }

  func refreshStatus() async {
    guard let syncService, syncService.supportsAppleDeviceStatus(laneId: laneId) else { return }
    guard let next = try? await syncService.fetchAppleDeviceStatus(laneId: laneId) else { return }
    let previousUdid = status?.device?.udid
    status = next
    // A pose belongs to the device it came from: another one (perhaps rigid)
    // must not be drawn or folded a Duo's way until its own stream says so.
    if let previousUdid, next.device?.udid != previousUdid {
      posture = nil
    }
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
      configPixels: stream.configPixels,
      ticketPixels: stream.ticket?.pixelSize,
      ticketPoints: stream.ticket?.pointSize
    )
  }

  /// Why Control cannot be offered, or nil when it can.
  var controlBlocker: String? {
    #if DEBUG
    if isPreview { return nil }
    #endif
    return appleDeviceControlBlocker(
      hostSupportsControl: syncService?.supportsAppleDeviceControl(laneId: laneId) ?? false,
      hasTicket: stream.ticket != nil,
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
    // The first target after taking control is always sent.
    lastFold = nil
    lastAskedOrientation = nil
    // Whether anyone drives a simulator from a phone at all. Nothing about
    // the device, lane or machine crosses; repeats in one foreground are one.
    ProductAnalytics.shared.captureFeature(.simulatorControl, outcome: .started)
    appleViewerLog.notice("control on lane=\(self.laneId, privacy: .public)")
  }

  func endControl(notice: String? = nil) {
    guard mode == .controlling else { return }
    pendingFold = nil
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

  /// Whether this host takes a live finger. Fixed per ticket.
  var usesLiveTouch: Bool { stream.ticket?.liveTouch == true }

  /// A live finger on the picture. The latency clock starts when it lands.
  /// An `end` always goes out, so a finger is never left down.
  func touch(_ phase: AppleTouchPhase, at point: CGPoint) {
    guard mode == .controlling || phase == .end else { return }
    let now = Date()
    lastControlActivity = now
    if phase == .begin { stream.latency.gestureSent(at: now) }
    liveTouch.push(phase, at: point)
  }

  func send(gesture: AppleDeviceGesture, endingAt end: CGPoint) {
    let now = Date()
    send(gesture.input(endingAt: end, at: now), at: now)
  }

  func type(_ text: String) {
    guard !text.isEmpty else { return }
    send(.type(text), at: Date())
  }

  /// A hardware button by the helper's name: `home`, `lock`, `volume-up`,
  /// `volume-down`, `siri`, `app-switcher`. A swipe cannot do these.
  func press(_ button: String) {
    send(.button(button), at: Date())
  }

  /// Folds the simulator to match the phone, while controlling a Duo. Folds
  /// go one at a time and only the newest waiting target is kept, so a hinge
  /// swung quickly sends where it is, not every step it passed.
  func mirrorFold(_ target: AppleFoldTarget) {
    guard mode == .controlling, deviceFolds, syncService != nil else { return }
    pendingFold = target
    guard !foldInFlight else { return }
    foldInFlight = true
    Task { [weak self] in await self?.drainFolds() }
  }

  private func drainFolds() async {
    defer { foldInFlight = false }
    while let next = pendingFold, mode == .controlling, let syncService {
      pendingFold = nil
      lastControlActivity = Date()
      if next.fold != lastFold {
        do {
          try await syncService.foldAppleDevice(laneId: laneId, chatSessionId: chatSessionId, pose: next.pose, angle: next.angle)
          lastFold = next.fold
        } catch {
          appleViewerLog.error("fold mirror failed: \((error as NSError).localizedDescription, privacy: .public)")
          inputFailed(error)
          return
        }
      }
      // On the front screen the hold is the pose's own (Tent turns it); the
      // inner display gets its turn again when the phone opens.
      if next.askedOrientation == nil { lastAskedOrientation = nil }
      // Held the other way: turn it, unless the picture already runs that way.
      // Remembered only once it took, so the next target tries again.
      if let asked = next.askedOrientation, asked != lastAskedOrientation {
        let alreadyThere = posture?.screen == "inner" && posture?.pictureIsWide == next.wantsWidePicture
        if !alreadyThere {
          do {
            try await syncService.rotateAppleDevice(laneId: laneId, chatSessionId: chatSessionId, orientation: asked)
          } catch {
            appleViewerLog.error("fold mirror rotate failed: \((error as NSError).localizedDescription, privacy: .public)")
            inputFailed(error)
            return
          }
        }
        lastAskedOrientation = asked
      }
    }
  }

  /// Fired without waiting on the previous one, like the desktop pane: the
  /// host serialises device input in arrival order, and waiting here would
  /// add a round trip to every tap after the first.
  private func send(_ input: AppleDeviceInput, at sentAt: Date) {
    guard mode == .controlling else { return }
    lastControlActivity = sentAt
    stream.latency.gestureSent(at: sentAt)
    Task { [weak self] in await self?.sendNow(input) }
  }

  private func sendNow(_ input: AppleDeviceInput) async {
    guard let syncService else { return }
    let started = Date()
    do {
      try await syncService.sendAppleDeviceInput(laneId: laneId, chatSessionId: chatSessionId, input: input)
      let ms = Int(Date().timeIntervalSince(started) * 1_000)
      appleViewerLog.debug("input acked in \(ms)ms")
    } catch {
      inputFailed(error)
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
    guard stream.started else { return }
    guard let syncService else { return }
    guard syncService.supportsAppleDeviceStream(laneId: laneId) else {
      stream.health.markUnsupported()
      return
    }
    stream.health.requestTicket()
    let ticket: AppleStreamTicket
    do {
      ticket = try await syncService.requestAppleStreamTicket(laneId: laneId)
    } catch {
      stream.health.fail(appleStreamTicketFailureMessage((error as NSError).localizedDescription))
      return
    }
    // The view may have been dismissed while the ticket round-trip was in
    // flight. Connecting now would reopen the socket `stop()` just closed and
    // leave a live WebSocket (and the Mac's capture) with no teardown.
    guard stream.started, !Task.isCancelled else { return }
    stream.ticket = ticket
    if let size = Self.initialPixelSize(status: status, ticket: ticket) {
      stream.contentPixelSize = size
    }
    // The machine that minted the ticket is the one to dial: a lane on another
    // Mac answers on that Mac's address, not the focused one's.
    stream.openSocket(
      ticket,
      endpoint: syncService.appleStreamEndpoint(laneId: laneId),
      unreachableMessage: "Your Mac sent an address this phone can't reach."
    )
  }
}
