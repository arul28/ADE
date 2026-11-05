import CoreGraphics
import Foundation
import OSLog

private let androidViewerLog = Logger(subsystem: "com.ade.ios", category: "android-stream")

// MARK: - Model

/// Owns the ticket, the socket, the decoder, the health clock and the mode of
/// the Android viewer.
///
/// The Apple viewer's model, for the lane's Android emulator. The stream is the
/// same: the brain's stream relay serves Android on the same socket path, with
/// the same records, so the socket, the parser and the decoder are the Apple
/// ones. What differs:
///
/// - **A still screen sends no frames.** The emulator's encoder sends a frame
///   only when the screen changes, so a quiet stream is not a stalled one.
///   Only the first-frame timeout runs; a dead socket reports itself.
/// - **The finger is the device's.** Every touch goes out live (down, moves,
///   up) in device pixels, and Android reads the gesture itself.
/// - **Watching never boots.** A ticket for an emulator that is off is refused
///   (`ANDROID_NOT_RUNNING`), and the viewer offers Start instead.
@MainActor
final class AndroidDeviceViewerModel: ObservableObject {
  @Published private(set) var health = AppleStreamHealth()
  @Published private(set) var status: AndroidDeviceStatus?
  @Published private(set) var mode: AppleDeviceViewerMode = .watching
  /// A sentence the view flashes once (control ended, an input refused).
  @Published private(set) var notice: String?
  @Published private(set) var speed = AppleViewerSpeed()
  /// The decoded picture's pixel size, published only when it changes.
  @Published private(set) var contentPixelSize = CGSize(width: 9, height: 19.5)
  /// The machine the lane lives on, when it is not the focused one.
  @Published private(set) var machineName: String?
  /// The emulator is not running: the ticket was refused, or the status says so.
  @Published private(set) var deviceOff = false
  /// A Start this phone sent is in flight.
  @Published private(set) var starting = false
  /// The brain reports the emulator but serves no live picture.
  @Published private(set) var liveViewMissing = false

  let decoder = AppleStreamDecoder()

  private let socket = AppleStreamSocket()
  private weak var syncService: SyncService?
  private var laneId: String = ""
  private var chatSessionId: String?
  private var ticket: AppleStreamTicket?
  /// The video's size in pixels, from the stream's config record.
  private var configPixels: CGSize?
  private var visible = true
  private var started = false
  private var rateMeter = AppleStreamRateMeter()
  private var latency = AppleTapLatencyProbe()
  private var networkStats: AppleStreamNetworkStats?
  private var lastSpeedPublish = Date.distantPast
  /// When the person last touched the picture while controlling.
  private var lastControlActivity = Date()
  private var retryPolicy = AppleStreamRetryPolicy()
  private var retryTask: Task<Void, Never>?
  private lazy var liveTouch = AppleLiveTouchSender { [weak self] phase, point in
    await self?.sendTouchNow(phase, at: point)
  }

  #if DEBUG
  private var isPreview = false

  func installPreview(_ preview: AndroidDeviceViewerPreview) {
    isPreview = true
    status = preview.status
    contentPixelSize = CGSize(width: 1080, height: 2424)
    health.frameDecoded(at: Date())
    speed = preview.speed
    mode = preview.mode
  }
  #endif

  /// Control hands itself back after this long without a touch: a phone put
  /// down mid-session should not leave a live input path into the emulator.
  static let controlIdleTimeout: TimeInterval = 5 * 60

  func attach(syncService: SyncService, laneId: String, chatSessionId: String?, status: AndroidDeviceStatus?) {
    self.syncService = syncService
    self.laneId = laneId
    self.chatSessionId = chatSessionId
    if self.status == nil { self.status = status }
    // The helper is named for Apple, but it names the lane's machine.
    machineName = syncService.appleLaneMachineName(laneId: laneId)
    if let size = Self.initialPixelSize(status: self.status, ticket: nil) {
      contentPixelSize = size
    }
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
    socket.onError = { [weak self] failure in
      guard let self else { return }
      self.endControl()
      // The stream ended because the emulator went down: the card with
      // Start, not a failure. The status poll connects when it is back.
      if failure.message.contains(androidNotRunningCode) {
        self.deviceOff = true
        self.health.reset()
        return
      }
      if self.scheduleAutoRetry(transient: failure.transient) { return }
      self.health.fail(androidStreamMessage(failure.message))
    }
  }

  func start() async {
    guard !started else { return }
    started = true
    // The status says whether there is a live picture at all; without a seed,
    // read it before asking for a ticket.
    if status == nil { await refreshStatus() }
    await connect()
  }

  func stop() {
    started = false
    cancelAutoRetry()
    retryPolicy.reset()
    mode = .watching
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

  private func redial() async {
    // A fresh ticket every time: tickets are short-lived and single use.
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
      cancelAutoRetry()
      endControl()
      return
    }
    Task { await reconnect() }
  }

  func tick() {
    let now = Date()
    // Only the first-frame timeout. Once frames came, a quiet stream is a
    // still screen: the emulator's encoder sends nothing until it changes.
    if health.phase == .connecting {
      health.tick(now: now)
      if health.phase == .stalled, !health.sawFrame {
        _ = scheduleAutoRetry(transient: true)
      }
    }
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

  /// What the overlay says while the picture is not live. Nil while the
  /// emulator is off: the view draws its own card with Start.
  var overlayMessage: String? {
    if deviceOff { return nil }
    switch health.phase {
    case .requestingTicket:
      return "Asking for the emulator's picture…"
    case .unsupported:
      return liveViewMissing ? androidDeviceNoLiveViewMessage : androidDeviceHostUnsupportedMessage
    default:
      return health.statusMessage
    }
  }

  /// Whether the status read says the emulator is running now.
  var deviceBooted: Bool { androidDeviceIsBooted(status) }

  func refreshStatus() async {
    guard let syncService, syncService.supportsAndroidDeviceStatus(laneId: laneId) else { return }
    guard let next = try? await syncService.fetchAndroidDeviceStatus(laneId: laneId) else { return }
    let previousAvd = status?.device?.avdName
    status = next
    let booted = androidDeviceIsBooted(next)
    // Another AVD is behind the picture now, or the emulator went down: a
    // touch aimed at the old screen must not land anywhere.
    if mode == .controlling, previousAvd != nil, next.device?.avdName != previousAvd {
      endControl(notice: "The emulator changed. You're watching.")
    } else if mode == .controlling, !booted {
      endControl(notice: "The emulator stopped. You're watching.")
    }
    // Down with no picture: the card with Start. A brain with no live view
    // keeps its own message.
    if !booted, androidDeviceState(next) != "starting", health.phase != .streaming, started, !liveViewMissing {
      deviceOff = true
    }
    // It booted (this phone's Start, or someone else's): connect now.
    if booted, deviceOff, started {
      deviceOff = false
      await reconnect()
    }
  }

  // MARK: Start

  /// Whether the Start button is offered: the phone may drive the emulator.
  var canStart: Bool {
    #if DEBUG
    if isPreview { return true }
    #endif
    return syncService?.supportsAndroidDeviceControl(laneId: laneId) ?? false
  }

  /// Boots the lane's emulator, then connects. The status poll also connects
  /// as soon as the emulator reads booted, so a slow answer to Start does not
  /// keep the picture away.
  func startDevice() async {
    guard let syncService, !starting else { return }
    starting = true
    defer { starting = false }
    androidViewerLog.notice("start on lane=\(self.laneId, privacy: .public)")
    do {
      try await syncService.startAndroidDevice(laneId: laneId, chatSessionId: chatSessionId)
    } catch {
      // The boot can take longer than the phone waits. The status poll
      // connects when it is done, so only a real refusal shows.
      await refreshStatus()
      if !deviceBooted, androidDeviceState(status) != "starting" {
        notice = androidErrorSentence(error)
      }
      return
    }
    // The status read connects when it sees the emulator booted. When the
    // read failed, or the picture is still down, connect here.
    await refreshStatus()
    if deviceOff || health.phase == .idle {
      deviceOff = false
      await reconnect()
    }
  }

  // MARK: Control

  /// The device's size in device pixels, the way the video shows it, or nil
  /// when there is nothing to map a touch against yet.
  var devicePixelSize: CGSize? {
    let lcd = ticket?.pointSize ?? Self.size(status?.device?.width, status?.device?.height)
    return androidDevicePixelSize(lcd: lcd, video: decoder.presentedSize ?? configPixels)
  }

  /// Why Control cannot be offered, or nil when it can.
  var controlBlocker: String? {
    #if DEBUG
    if isPreview { return nil }
    #endif
    guard syncService?.supportsAndroidDeviceControl(laneId: laneId) ?? false else {
      return "This phone can watch this emulator, but not drive it."
    }
    if let ticket, ticket.liveTouch != true {
      return "Update ADE on the computer to control its emulator from here."
    }
    guard health.phase == .streaming, devicePixelSize != nil else {
      return "Control turns on once the picture is live."
    }
    return nil
  }

  func beginControl() {
    if let blocker = controlBlocker {
      notice = blocker
      return
    }
    lastControlActivity = Date()
    mode = .controlling
    androidViewerLog.notice("control on lane=\(self.laneId, privacy: .public)")
  }

  func endControl(notice: String? = nil) {
    guard mode == .controlling else { return }
    mode = .watching
    if let notice { self.notice = notice }
    androidViewerLog.notice("control off lane=\(self.laneId, privacy: .public)")
  }

  /// A location on the stage, as device pixels, or nil when there is nothing
  /// to map against yet. The video arrives the right way up, so only the
  /// person's own turn is undone.
  func devicePoint(for location: CGPoint, in picture: CGRect, rotation: AppleDisplayRotation) -> CGPoint? {
    guard let size = devicePixelSize,
          let fraction = AppleDeviceTouchMapping.frameFraction(of: location, in: picture, rotation: rotation)
    else { return nil }
    return AppleDeviceTouchMapping.devicePoint(frameFraction: fraction, metrics: size)
  }

  /// A live finger on the picture. An `end` always goes out, so a finger is
  /// never left down.
  func touch(_ phase: AppleTouchPhase, at point: CGPoint) {
    guard mode == .controlling || phase == .end else { return }
    let now = Date()
    lastControlActivity = now
    if phase == .begin { latency.gestureSent(at: now) }
    liveTouch.push(phase, at: point)
  }

  func type(_ text: String) {
    guard mode == .controlling, !text.isEmpty else { return }
    let now = Date()
    lastControlActivity = now
    latency.gestureSent(at: now)
    Task { [weak self] in await self?.typeNow(text) }
  }

  /// A hardware key a finger on the screen cannot press.
  func press(_ key: AndroidHardwareKey) {
    guard mode == .controlling else { return }
    let now = Date()
    lastControlActivity = now
    latency.gestureSent(at: now)
    Task { [weak self] in await self?.pressNow(key) }
  }

  private func typeNow(_ text: String) async {
    guard let syncService else { return }
    do {
      try await syncService.typeOnAndroidDevice(laneId: laneId, text: text)
    } catch {
      inputFailed(error)
    }
  }

  private func pressNow(_ key: AndroidHardwareKey) async {
    guard let syncService else { return }
    do {
      try await syncService.pressAndroidKey(laneId: laneId, key: key)
    } catch {
      inputFailed(error)
    }
  }

  private func sendTouchNow(_ phase: AppleTouchPhase, at point: CGPoint) async {
    guard let syncService else { return }
    do {
      try await syncService.sendAndroidTouch(laneId: laneId, events: [AndroidTouchEvent(phase: phase, at: point)])
    } catch {
      inputFailed(error)
    }
  }

  private func inputFailed(_ error: Error) {
    androidViewerLog.error("input failed: \((error as NSError).localizedDescription, privacy: .public)")
    if androidErrorCode(error) == androidNotRunningCode {
      endControl(notice: "The emulator stopped. You're watching.")
      Task { await refreshStatus() }
      return
    }
    notice = androidErrorSentence(error)
  }

  // MARK: Stream

  private func scheduleAutoRetry(transient: Bool) -> Bool {
    if retryTask != nil { return true }
    guard let delay = retryPolicy.nextDelay(transient: transient, started: started, visible: visible) else {
      return false
    }
    socket.close()
    decoder.reset()
    health.reconnecting()
    androidViewerLog.notice("stream redial \(self.retryPolicy.attempts, privacy: .public) in \(delay, privacy: .public)s")
    retryTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      guard let self, !Task.isCancelled else { return }
      self.retryTask = nil
      guard self.started, self.visible else { return }
      await self.redial()
    }
    return true
  }

  private func cancelAutoRetry() {
    retryTask?.cancel()
    retryTask = nil
  }

  private static func size(_ width: Double?, _ height: Double?) -> CGSize? {
    guard let width, let height, width > 0, height > 0 else { return nil }
    return CGSize(width: width, height: height)
  }

  /// Aspect source before the first keyframe: the ticket's video size, then
  /// the AVD's screen (portrait). The decoder's own size replaces it.
  private static func initialPixelSize(status: AndroidDeviceStatus?, ticket: AppleStreamTicket?) -> CGSize? {
    if let size = ticket?.pixelSize { return size }
    guard let lcd = size(status?.device?.width, status?.device?.height) else { return nil }
    return CGSize(width: min(lcd.width, lcd.height), height: max(lcd.width, lcd.height))
  }

  private func connect() async {
    guard started, let syncService else { return }
    guard syncService.supportsAndroidDeviceStream(laneId: laneId) else {
      health.markUnsupported()
      return
    }
    // A brain with no stream relay says so in the status: no ticket to ask for.
    if status?.liveView == false {
      liveViewMissing = true
      health.markUnsupported()
      return
    }
    liveViewMissing = false
    health.requestTicket()
    let ticket: AppleStreamTicket
    do {
      ticket = try await syncService.requestAndroidStreamTicket(laneId: laneId)
    } catch {
      guard started else { return }
      if androidErrorCode(error) == androidNotRunningCode {
        // Watching never boots the emulator: the view offers Start. The
        // status poll connects once the emulator reads booted.
        deviceOff = true
        health.reset()
        return
      }
      health.fail(androidStreamMessage(androidErrorSentence(error)))
      return
    }
    // The view may have gone while the ticket was in flight. Connecting now
    // would open a socket nobody closes, and keep the stream up on the brain.
    guard started, !Task.isCancelled else { return }
    deviceOff = false
    self.ticket = ticket
    if let size = Self.initialPixelSize(status: status, ticket: ticket) {
      contentPixelSize = size
    }
    // The machine that minted the ticket is the one to dial.
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
      health.fail("The computer sent an address this phone can't reach.")
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
        health.fail("This computer is sending video this phone can't decode.")
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
      if latency.frame(bytes: bytes.count, keyframe: keyframe, at: now) != nil {
        publishSpeed(now: now, force: true)
      } else {
        publishSpeed(now: now, force: false)
      }
    }
  }

  /// At most four times a second, as on Apple.
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
