import Combine
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
  @Published private(set) var status: AndroidDeviceStatus?
  @Published private(set) var mode: AppleDeviceViewerMode = .watching
  /// A sentence the view flashes once (control ended, an input refused).
  @Published private(set) var notice: String?
  /// The machine the lane lives on, when it is not the focused one.
  @Published private(set) var machineName: String?
  /// The emulator is not running: the ticket was refused, or the status says so.
  @Published private(set) var deviceOff = false
  /// A Start this phone sent is in flight.
  @Published private(set) var starting = false
  /// The brain reports the emulator but serves no live picture.
  @Published private(set) var liveViewMissing = false
  /// The host's sentence when the last Start was refused for want of memory
  /// (`ANDROID_LOW_MEMORY`): the card then offers Start anyway.
  @Published private(set) var lowMemorySentence: String?
  /// The emulator has a hinge (`getPosture`): fold mirroring and the hinge
  /// tiles are offered. Read when control begins.
  @Published private(set) var deviceFolds = false
  /// The hinge as last read or set.
  @Published private(set) var posture: AndroidDevicePosture?
  /// Whether the phone in the hand folds, remembered for the session like
  /// the simulator's (`AppleDeviceViewerModel.phoneFolds`).
  static var phoneFolds = false

  /// The socket, decoder, health clock, speed and redials, shared with the
  /// simulator's model. Only the first-frame timeout runs: a still screen
  /// sends no frames.
  private let stream = AppleStreamSession(
    log: androidViewerLog,
    undecodableMessage: "This computer is sending video this phone can't decode.",
    watchesFrameStalls: false,
    logsTapToFrame: false
  )
  private weak var syncService: SyncService?
  private var laneId: String = ""
  private var chatSessionId: String?
  /// When the person last touched the picture while controlling.
  private var lastControlActivity = Date()
  /// Fold mirroring: the newest angle waiting, the last one sent, and one in flight.
  private var pendingFoldAngle: Double?
  private var lastFoldAngle: Double?
  private var foldInFlight = false
  private lazy var liveTouch = AppleLiveTouchSender { [weak self] phase, point in
    await self?.sendTouchNow(phase, at: point)
  }

  var health: AppleStreamHealth { stream.health }
  var speed: AppleViewerSpeed { stream.speed }
  /// The decoded picture's pixel size, published only when it changes.
  var contentPixelSize: CGSize { stream.contentPixelSize }
  var decoder: AppleStreamDecoder { stream.decoder }

  init() {
    stream.onWillChange = { [weak self] in self?.objectWillChange.send() }
    stream.dial = { [weak self] in await self?.connect() }
  }

  #if DEBUG
  private var isPreview = false

  func installPreview(_ preview: AndroidDeviceViewerPreview) {
    isPreview = true
    status = preview.status
    stream.contentPixelSize = CGSize(width: 1080, height: 2424)
    stream.health.frameDecoded(at: Date())
    stream.speed = preview.speed
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
      stream.contentPixelSize = size
    }
    stream.socket.onError = { [weak self] failure in
      guard let self else { return }
      self.endControl()
      // The stream ended because the emulator went down: the card with
      // Start, not a failure. The status poll connects when it is back.
      if failure.message.contains(androidNotRunningCode) {
        self.deviceOff = true
        self.stream.health.reset()
        return
      }
      if self.stream.scheduleAutoRetry(transient: failure.transient) { return }
      self.stream.health.fail(androidStreamMessage(failure.message))
    }
  }

  func start() async {
    guard !stream.started else { return }
    stream.started = true
    // The status says whether there is a live picture at all; without a seed,
    // read it before asking for a ticket.
    if status == nil { await refreshStatus() }
    await connect()
  }

  func stop() {
    mode = .watching
    stream.stop()
  }

  /// The Reconnect action: the person asked, so the automatic budget refills.
  func reconnect() async {
    await stream.reconnect()
  }

  func setVisible(_ nextVisible: Bool) {
    guard stream.setVisible(nextVisible) else { return }
    if !nextVisible {
      endControl()
      return
    }
    Task { await reconnect() }
  }

  func tick() {
    let now = Date()
    // Only the first-frame timeout (the session's `watchesFrameStalls`).
    if stream.tickHealth(now: now) {
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
    } else if mode == .controlling,
              let owner = androidDeviceOwnerLabel(androidDeviceForeignOwner(next.owner, viewerChatSessionId: chatSessionId)) {
      // An agent took the emulator's lease: it is driving now, so hand control
      // back before a touch lands under its feet, as the simulator viewer does.
      endControl(notice: "\(owner.prefix(1).uppercased() + owner.dropFirst()) is driving the emulator now. You're watching.")
    }
    if previousAvd != nil, next.device?.avdName != previousAvd {
      // A hinge belongs to the device it came from.
      deviceFolds = false
      posture = nil
    }
    // Down with no picture: the card with Start. A brain with no live view
    // keeps its own message.
    if !booted, androidDeviceState(next) != "starting", health.phase != .streaming, stream.started, !liveViewMissing {
      deviceOff = true
    }
    // Running now: a memory refusal is history.
    if booted { lowMemorySentence = nil }
    // It booted (this phone's Start, or someone else's): connect now.
    if booted, deviceOff, stream.started {
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
  /// keep the picture away. `force` goes past the host's memory guard: the
  /// person chose Start anyway after an `ANDROID_LOW_MEMORY` refusal.
  func startDevice(force: Bool = false) async {
    guard let syncService, !starting else { return }
    starting = true
    defer { starting = false }
    // Every Start asks again: an old refusal no longer stands.
    lowMemorySentence = nil
    androidViewerLog.notice("start on lane=\(self.laneId, privacy: .public) force=\(force, privacy: .public)")
    do {
      try await syncService.startAndroidDevice(laneId: laneId, chatSessionId: chatSessionId, force: force)
    } catch {
      let lowMemory = androidErrorCode(error) == androidLowMemoryCode
      // The boot can take longer than the phone waits. The status poll
      // connects when it is done, so only a real refusal shows.
      await refreshStatus()
      if !deviceBooted, androidDeviceState(status) != "starting" {
        // The memory guard is the card's to show, with Start anyway, as on
        // the desktop; any other refusal flashes once.
        if lowMemory {
          lowMemorySentence = androidErrorSentence(error)
        } else {
          notice = androidErrorSentence(error)
        }
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
    let lcd = stream.ticket?.pointSize ?? Self.size(status?.device?.width, status?.device?.height)
    return androidDevicePixelSize(lcd: lcd, video: decoder.presentedSize ?? stream.configPixels)
  }

  /// Why Control cannot be offered, or nil when it can.
  var controlBlocker: String? {
    #if DEBUG
    if isPreview { return nil }
    #endif
    guard syncService?.supportsAndroidDeviceControl(laneId: laneId) ?? false else {
      return "This phone can watch this emulator, but not drive it."
    }
    if let ticket = stream.ticket, ticket.liveTouch != true {
      return "Update ADE on the computer to control its emulator from here."
    }
    if let owner = androidDeviceOwnerLabel(androidDeviceForeignOwner(status?.owner, viewerChatSessionId: chatSessionId)) {
      return "\(owner.prefix(1).uppercased() + owner.dropFirst()) is driving this emulator. Control comes back when it lets go."
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
    // The first fold after taking control is always sent.
    lastFoldAngle = nil
    Task { [weak self] in await self?.loadPosture() }
    androidViewerLog.notice("control on lane=\(self.laneId, privacy: .public)")
  }

  // MARK: Fold

  /// Reads the hinge once per control session: whether it folds at all.
  private func loadPosture() async {
    guard let syncService else { return }
    do {
      let next = try await syncService.fetchAndroidPosture(laneId: laneId)
      posture = next
      deviceFolds = next.supported == true
    } catch {
      // A host without the fold verb, or a rigid AVD: no fold controls.
      androidViewerLog.notice("posture read failed: \((error as NSError).localizedDescription, privacy: .public)")
      deviceFolds = false
    }
  }

  /// Folds the emulator to match the phone, while controlling a foldable.
  /// One fold at a time; only the newest waiting angle is kept, so a hinge
  /// swung quickly sends where it is, not every step it passed.
  func mirrorFold(angle: Double) {
    guard mode == .controlling, deviceFolds, syncService != nil else { return }
    pendingFoldAngle = angle
    guard !foldInFlight else { return }
    foldInFlight = true
    Task { [weak self] in await self?.drainFolds() }
  }

  private func drainFolds() async {
    defer { foldInFlight = false }
    while let next = pendingFoldAngle, mode == .controlling, let syncService {
      pendingFoldAngle = nil
      lastControlActivity = Date()
      // Small moves of the hand are not worth a device-state change.
      if let last = lastFoldAngle, abs(last - next) < 10 { continue }
      do {
        try await syncService.setAndroidPosture(laneId: laneId, angle: next, pose: nil)
        lastFoldAngle = next
        posture = AndroidDevicePosture(supported: true, angle: next, state: posture?.state)
      } catch {
        androidViewerLog.error("fold mirror failed: \((error as NSError).localizedDescription, privacy: .public)")
        inputFailed(error)
        return
      }
    }
  }

  /// The hinge tiles: `open`, `half` or `closed`.
  func setHinge(_ pose: String) {
    guard mode == .controlling, deviceFolds, let syncService else { return }
    lastControlActivity = Date()
    Task { [weak self] in
      guard let self else { return }
      do {
        try await syncService.setAndroidPosture(laneId: self.laneId, angle: nil, pose: pose)
        self.lastFoldAngle = nil
        let angle: Double = pose == "open" ? 180 : pose == "half" ? 90 : 0
        self.posture = AndroidDevicePosture(supported: true, angle: angle, state: self.posture?.state)
      } catch {
        self.inputFailed(error)
      }
    }
  }

  func endControl(notice: String? = nil) {
    guard mode == .controlling else { return }
    pendingFoldAngle = nil
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
    if phase == .begin { stream.latency.gestureSent(at: now) }
    liveTouch.push(phase, at: point)
  }

  func type(_ text: String) {
    guard mode == .controlling, !text.isEmpty else { return }
    let now = Date()
    lastControlActivity = now
    stream.latency.gestureSent(at: now)
    Task { [weak self] in await self?.typeNow(text) }
  }

  /// A hardware key a finger on the screen cannot press.
  func press(_ key: AndroidHardwareKey) {
    guard mode == .controlling else { return }
    let now = Date()
    lastControlActivity = now
    stream.latency.gestureSent(at: now)
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
    guard stream.started, let syncService else { return }
    guard syncService.supportsAndroidDeviceStream(laneId: laneId) else {
      stream.health.markUnsupported()
      return
    }
    // A brain with no stream relay says so in the status: no ticket to ask for.
    if status?.liveView == false {
      liveViewMissing = true
      stream.health.markUnsupported()
      return
    }
    liveViewMissing = false
    stream.health.requestTicket()
    let ticket: AppleStreamTicket
    do {
      ticket = try await syncService.requestAndroidStreamTicket(laneId: laneId)
    } catch {
      guard stream.started else { return }
      if androidErrorCode(error) == androidNotRunningCode {
        // Watching never boots the emulator: the view offers Start. The
        // status poll connects once the emulator reads booted.
        deviceOff = true
        stream.health.reset()
        return
      }
      stream.health.fail(androidStreamMessage(androidErrorSentence(error)))
      return
    }
    // The view may have gone while the ticket was in flight. Connecting now
    // would open a socket nobody closes, and keep the stream up on the brain.
    guard stream.started, !Task.isCancelled else { return }
    deviceOff = false
    stream.ticket = ticket
    if let size = Self.initialPixelSize(status: status, ticket: ticket) {
      stream.contentPixelSize = size
    }
    // The machine that minted the ticket is the one to dial.
    stream.openSocket(
      ticket,
      endpoint: syncService.appleStreamEndpoint(laneId: laneId),
      unreachableMessage: "The computer sent an address this phone can't reach."
    )
  }
}
