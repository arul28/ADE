import CoreGraphics
import Foundation

// MARK: - Wire models

/// The lane's Android emulator, as the `android.status` sync command reports it
/// (`buildAndroidStatusPayload` in `androidRemoteCommands.ts`).
///
/// Every field is optional for the same reason as `AppleDeviceStatus`: the host
/// ships on its own cadence, and a field it renames must not blank the viewer.
/// `capabilities` is not decoded: the phone does not use it yet.
struct AndroidDeviceStatus: Codable, Equatable {
  var laneId: String?
  /// Why this machine cannot run the emulator at all, in the host's words.
  /// Null when it can.
  var unavailable: String?
  var sdkFound: Bool?
  /// The lane's AVD. Null when the lane has no Android device.
  var device: AndroidDeviceStatusDevice?
  var error: AndroidDeviceStatusError?
  /// The lane's app's last crash while the emulator runs.
  var appCrash: AndroidDeviceStatusCrash?
  /// True when this brain serves `android.streamTicket`. False on a brain with
  /// no stream relay: the phone shows the status only, with no live picture.
  var liveView: Bool?
  /// The lane's recording while the emulator runs; nil from an older host or
  /// when none runs. Drives the menu's recording dot.
  var recording: AndroidDeviceStatusRecording?
  /// Who holds the emulator's lease (`ade android lease`); nil when nobody
  /// does. Drives the owner ribbon and the "an agent is driving" hand-back.
  var owner: AndroidDeviceStatusOwner?
}

struct AndroidDeviceStatusRecording: Codable, Equatable {
  var active: Bool?
  var id: String?
  var startedAt: String?
  var chatSessionId: String?
}

struct AndroidDeviceStatusOwner: Codable, Equatable {
  /// The lease's holder: a chat id for an agent, else the name it gave.
  var holder: String?
  /// Set when the holder is a chat the host knows.
  var chatSessionId: String?
  /// The chat's title, resolved by the host; nil when it has none yet.
  var chatTitle: String?
  var expiresAt: String?
}

/// The lane's emulator hinge, as `android.invoke getPosture` answers it.
struct AndroidDevicePosture: Codable, Equatable {
  /// False on a device with no hinge.
  var supported: Bool?
  /// 0 is shut, 180 is flat.
  var angle: Double?
  /// `closed`, `half-open` or `open`.
  var state: String?
}

/// The holder of the emulator's lease, when it is not the chat this viewer was
/// opened from: that one is the person's own agent, not someone else's.
func androidDeviceForeignOwner(_ owner: AndroidDeviceStatusOwner?, viewerChatSessionId: String?) -> AndroidDeviceStatusOwner? {
  guard let owner, let holder = owner.holder?.trimmingCharacters(in: .whitespacesAndNewlines), !holder.isEmpty else { return nil }
  // The viewer's chat working through another machine holds it there as
  // `remote:<device>:<chat id>` (`deviceClaimIsViewerChat`).
  if deviceClaimIsViewerChat(owner.chatSessionId ?? "", viewerChatSessionId: viewerChatSessionId)
    || deviceClaimIsViewerChat(holder, viewerChatSessionId: viewerChatSessionId) {
    return nil
  }
  return owner
}

/// How the ribbon names a lease holder: the chat's title, else "an agent".
func androidDeviceOwnerLabel(_ owner: AndroidDeviceStatusOwner?) -> String? {
  guard let owner, owner.holder?.isEmpty == false else { return nil }
  if let title = owner.chatTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
  return "an agent"
}

/// The three hinge tiles of a foldable emulator, as `setPosture` names them.
enum AndroidHingePose: String, CaseIterable {
  case open, half, closed

  /// The hinge angle the pose sets: 0 is shut, 180 is flat.
  var angle: Double {
    switch self {
    case .open: return 180
    case .half: return 90
    case .closed: return 0
    }
  }

  /// Whether a hinge at `angle` reads as this pose.
  func matches(_ angle: Double) -> Bool {
    switch self {
    case .open: return angle >= 170
    case .half: return angle > 10 && angle < 170
    case .closed: return angle <= 10
    }
  }
}

/// The hinge angle that mirrors the phone in the hand onto a foldable
/// emulator. The inner display keeps it open no less than 70°, as the
/// simulator's rule; the front screen shuts it (0°), which shows the
/// emulator's cover screen. Nil on a phone that does not fold.
func androidFoldAngle(isInnerDisplay: Bool, hingeAngle: Double?, phoneFolds: Bool) -> Double? {
  guard phoneFolds else { return nil }
  if isInnerDisplay { return min(180, max(70, (hingeAngle ?? 180).rounded())) }
  return 0
}

struct AndroidDeviceStatusDevice: Codable, Equatable {
  /// The AVD folder name, for example `Pixel_9_API_36`.
  var avdName: String?
  var origin: String?
  var profileId: String?
  /// `none`, `off`, `starting`, `booted`, `stopping` or `crashed`. Kept as a
  /// raw string so a state added on a newer host does not fail to decode.
  var state: String?
  var serial: String?
  /// The AVD's screen in device PIXELS. Either side can be the long one.
  var width: Double?
  var height: Double?
}

struct AndroidDeviceStatusError: Codable, Equatable {
  var code: String?
  var message: String?
}

struct AndroidDeviceStatusCrash: Codable, Equatable {
  var id: String?
  var packageName: String?
  var summary: String?
}

/// The hardware keys `android.input` kind `key` takes (`ANDROID_HARDWARE_KEYS`).
enum AndroidHardwareKey: String, CaseIterable {
  case back
  case home
  case recents
  case power
  case volumeUp = "volume_up"
  case volumeDown = "volume_down"
}

/// One finger event of a live touch, in device PIXELS of the screen the way
/// the video shows it.
struct AndroidTouchEvent: Equatable {
  enum Action: String {
    case down
    case move
    case up
  }

  var action: Action
  var x: Int
  var y: Int
  var pointerId = 0

  init(action: Action, x: Int, y: Int, pointerId: Int = 0) {
    self.action = action
    self.x = x
    self.y = y
    self.pointerId = pointerId
  }

  /// The event for one phase of a finger at a device point.
  init(phase: AppleTouchPhase, at point: CGPoint) {
    switch phase {
    case .begin: action = .down
    case .move: action = .move
    case .end: action = .up
    }
    x = Int(point.x.rounded())
    y = Int(point.y.rounded())
  }

  var payload: [String: Any] {
    ["action": action.rawValue, "x": x, "y": y, "pointerId": pointerId]
  }
}

// MARK: - Display helpers

/// The code the host puts in front of a ticket refusal when the emulator is
/// not booted. Watching never boots it.
let androidNotRunningCode = "ANDROID_NOT_RUNNING"

/// The code the host puts on a Start it refused because the machine has too
/// little free memory. A Start with `force` goes past it.
let androidLowMemoryCode = "ANDROID_LOW_MEMORY"

/// The sentence for a host that does not advertise the Android commands.
let androidDeviceHostUnsupportedMessage = "Update ADE on the computer to watch its Android emulator from here."

/// The sentence for a brain that reports the emulator but cannot send its
/// live picture (`liveView` false).
let androidDeviceNoLiveViewMessage =
  "This computer can't send the emulator's live picture to the phone yet. Update ADE on it to watch here."

/// The name a person reads: the AVD folder name with spaces for underscores
/// (`Pixel_9_API_36` reads "Pixel 9 API 36"), or "Android device".
func androidDeviceDisplayName(_ status: AndroidDeviceStatus?) -> String {
  let raw = status?.device?.avdName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !raw.isEmpty else { return "Android device" }
  return raw.replacingOccurrences(of: "_", with: " ")
}

/// The lane's device state, lowercased. Nil when the lane has no device.
func androidDeviceState(_ status: AndroidDeviceStatus?) -> String? {
  guard status?.device != nil else { return nil }
  let state = status?.device?.state?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
  return state.isEmpty ? "none" : state
}

func androidDeviceIsBooted(_ status: AndroidDeviceStatus?) -> Bool {
  androidDeviceState(status) == "booted"
}

/// The state in words, for the menu and the status card.
func androidDeviceStateLabel(_ state: String?) -> String {
  switch state {
  case "booted": return "Running"
  case "starting": return "Starting"
  case "stopping": return "Stopping"
  case "crashed": return "Stopped unexpectedly"
  case "off": return "Off"
  case nil, "none": return "Not set up"
  default: return state ?? "Not set up"
  }
}

/// The host's error code for an `android.*` failure: the code the host sent
/// apart from the sentence, else an `ANDROID_…:` prefix on the sentence.
func androidErrorCode(_ error: Error) -> String? {
  let nsError = error as NSError
  if let code = nsError.userInfo["ADEErrorCode"] as? String, code.hasPrefix("ANDROID_") { return code }
  let message = nsError.localizedDescription
  guard let range = message.range(of: "^ANDROID_[A-Z_]+(?=:)", options: .regularExpression) else { return nil }
  return String(message[range])
}

/// The host's sentence without its `ANDROID_…:` prefix.
func androidErrorSentence(_ error: Error) -> String {
  let message = (error as NSError).localizedDescription
  guard let range = message.range(of: "^ANDROID_[A-Z_]+:\\s*", options: .regularExpression) else { return message }
  let rest = message[range.upperBound...].trimmingCharacters(in: .whitespaces)
  guard let first = rest.first else { return message }
  return first.uppercased() + String(rest.dropFirst())
}

/// A sentence from the shared stream socket, in words for an emulator. The
/// socket was written for the Mac's simulator; the relay is the same, but the
/// machine can be any computer and the device is an emulator.
func androidStreamMessage(_ message: String) -> String {
  message
    .replacingOccurrences(of: "simulator", with: "emulator")
    .replacingOccurrences(of: "your Mac", with: "the computer")
    .replacingOccurrences(of: "The Mac", with: "The computer")
    .replacingOccurrences(of: "the Mac", with: "the computer")
}

/// The device's size in device PIXELS, the way the video shows it.
///
/// The phone's version of the desktop's `androidDevicePixelSize`. Touches go to
/// the brain in device pixels and the brain scales them to the video. The
/// AVD's screen is portrait; the stream turns with the device, so a wide video
/// means the long side runs across. With no AVD size, the video's own size is
/// used, which is also what the brain uses then.
func androidDevicePixelSize(lcd: CGSize?, video: CGSize?) -> CGSize? {
  if let lcd, lcd.width > 0, lcd.height > 0 {
    let long = max(lcd.width, lcd.height)
    let short = min(lcd.width, lcd.height)
    let landscape = video.map { $0.width > $0.height } ?? false
    return landscape ? CGSize(width: long, height: short) : CGSize(width: short, height: long)
  }
  if let video, video.width > 0, video.height > 0 { return video }
  return nil
}

// MARK: - Commands

/// The `android.*` commands this phone sends, and which machine each one is
/// about.
///
/// `sendCommand` routes each command by the lane's namespaced id, so a lane on
/// another machine is asked there. The capability checks and the video socket
/// do not go through it: they ask `laneCommandDescriptor` and
/// `appleStreamEndpoint` (the same stream relay serves Android), which name the
/// lane's own machine. The `android.*` commands are optional: an older brain
/// does not advertise them, and the phone then offers no Android tool.
extension SyncService {
  /// Whether the lane's machine can describe its Android emulator.
  func supportsAndroidDeviceStatus(laneId: String) -> Bool {
    laneCommandDescriptor("android.status", laneId: laneId) != nil
  }

  /// Whether the lane's machine can mint an Android stream ticket. A brain can
  /// advertise the command and still have no relay: `liveView` in the status
  /// says that.
  func supportsAndroidDeviceStream(laneId: String) -> Bool {
    laneCommandDescriptor("android.streamTicket", laneId: laneId) != nil
  }

  /// Whether the phone offers the Android tool for this lane: the host
  /// advertises both the status read and the stream ticket.
  func supportsAndroidDevice(laneId: String) -> Bool {
    supportsAndroidDeviceStatus(laneId: laneId) && supportsAndroidDeviceStream(laneId: laneId)
  }

  /// Whether the lane's machine lets this phone drive its emulator: touches,
  /// keys and text (`android.input`), and Start (`android.invoke`). Both are
  /// controller-only on the host; a phone at viewer role may only watch.
  func supportsAndroidDeviceControl(laneId: String) -> Bool {
    ["android.input", "android.invoke"].allSatisfy { action in
      laneCommandDescriptor(action, laneId: laneId)?.policy.allowsPhone == true
    }
  }

  /// Whether the lane's machine serves the frozen inspect view of its emulator.
  func supportsAndroidLiveInspect(laneId: String) -> Bool {
    laneCommandDescriptor("android.inspectSnapshot", laneId: laneId)?.policy.allowsPhone == true
  }

  /// The emulator's hinge. A rigid device answers `supported: false`.
  func fetchAndroidPosture(laneId: String) async throws -> AndroidDevicePosture {
    try decode(
      try await invokeAndroid(laneId: laneId, method: "getPosture", methodArgs: [:], timeoutNanoseconds: Self.androidInputTimeoutNanoseconds),
      as: AndroidDevicePosture.self
    )
  }

  /// Moves the emulator's hinge to `angle` (0–180) or a named `pose`
  /// (`open`, `half`, `closed`). The host waits until Android shows the
  /// screen that goes with it.
  func setAndroidPosture(laneId: String, angle: Double?, pose: String?) async throws {
    var methodArgs: [String: Any] = [:]
    if let angle { methodArgs["angle"] = angle }
    if let pose { methodArgs["pose"] = pose }
    _ = try await invokeAndroid(laneId: laneId, method: "setPosture", methodArgs: methodArgs, timeoutNanoseconds: 20_000_000_000)
  }

  /// One `android.invoke` call on the lane's machine. The nested `laneId` is
  /// the plain id; `sendCommand` routes by the namespaced top-level one.
  private func invokeAndroid(laneId: String, method: String, methodArgs: [String: Any], timeoutNanoseconds: UInt64) async throws -> Any {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    try requireAndroidControl(laneId: trimmed)
    var nested = methodArgs
    nested["laneId"] = workParseRemoteLaneId(trimmed)?.laneId ?? trimmed
    return try await sendCommand(
      action: "android.invoke",
      args: ["laneId": trimmed, "method": method, "args": nested],
      disconnectOnTimeout: false,
      timeoutNanoseconds: timeoutNanoseconds,
      attemptedLiveFailurePolicy: .preserveForManualRetry
    )
  }

  /// The lane's emulator, as one snapshot. A poll behind a viewer or a chip,
  /// so a timeout never drops the sync connection.
  func fetchAndroidDeviceStatus(laneId: String) async throws -> AndroidDeviceStatus {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard supportsAndroidDeviceStatus(laneId: trimmed) else {
      throw androidUnsupportedError(androidDeviceHostUnsupportedMessage)
    }
    return try decode(
      try await sendCommand(
        action: "android.status",
        args: ["laneId": trimmed],
        disconnectOnTimeout: false,
        timeoutNanoseconds: Self.workToolsRequestTimeoutNanoseconds
      ),
      as: AndroidDeviceStatus.self
    )
  }

  /// Mints a single-use ticket for the binary video socket. The same ticket
  /// shape as `apple.streamTicket`; its point size is the AVD's screen in
  /// device pixels, portrait. Throws `ANDROID_NOT_RUNNING` when the emulator
  /// is not booted.
  func requestAndroidStreamTicket(laneId: String) async throws -> AppleStreamTicket {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard supportsAndroidDeviceStream(laneId: trimmed) else {
      throw androidUnsupportedError(androidDeviceHostUnsupportedMessage)
    }
    return try decode(
      try await sendCommand(
        action: "android.streamTicket",
        args: ["laneId": trimmed],
        disconnectOnTimeout: false,
        timeoutNanoseconds: Self.workToolsRequestTimeoutNanoseconds
      ),
      as: AppleStreamTicket.self
    )
  }

  /// Finger events of a live touch, at most 64 per call (the host's limit).
  /// Never queued and never retried: a touch replayed after a reconnect lands
  /// on what the device shows by then.
  func sendAndroidTouch(laneId: String, events: [AndroidTouchEvent]) async throws {
    guard !events.isEmpty else { return }
    try await sendAndroidInput(laneId: laneId, kind: "touch", extra: [
      "events": events.prefix(Self.androidMaxTouchEvents).map(\.payload),
    ])
  }

  /// One hardware key: Back, Home, Recents, Power, volume.
  func pressAndroidKey(laneId: String, key: AndroidHardwareKey) async throws {
    try await sendAndroidInput(laneId: laneId, kind: "key", extra: ["key": key.rawValue])
  }

  /// Text typed on the emulator. A newline is the Enter key.
  func typeOnAndroidDevice(laneId: String, text: String) async throws {
    guard !text.isEmpty else { return }
    try await sendAndroidInput(laneId: laneId, kind: "type", extra: ["text": text])
  }

  /// Boots the lane's emulator. The host waits for the boot, which can take a
  /// minute or more, so the timeout is long. The viewer reads the status
  /// meanwhile and connects once the emulator is booted. `force` starts past
  /// the host's memory guard (`ANDROID_LOW_MEMORY`), as the desktop's Start
  /// anyway does.
  func startAndroidDevice(laneId: String, chatSessionId: String?, force: Bool = false) async throws {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    try requireAndroidControl(laneId: trimmed)
    // The top-level `laneId` is the one the host uses; `sendCommand` strips
    // its machine. The nested copy gets the plain id for the same reason.
    let plainLaneId = workParseRemoteLaneId(trimmed)?.laneId ?? trimmed
    var startArgs: [String: Any] = ["laneId": plainLaneId]
    if force { startArgs["force"] = true }
    var args: [String: Any] = ["laneId": trimmed, "method": "start", "args": startArgs]
    if let chatSessionId { args["chatSessionId"] = chatSessionId }
    _ = try await sendCommand(
      action: "android.invoke",
      args: args,
      disconnectOnTimeout: false,
      timeoutNanoseconds: Self.androidStartTimeoutNanoseconds,
      attemptedLiveFailurePolicy: .preserveForManualRetry
    )
  }

  private func sendAndroidInput(laneId: String, kind: String, extra: [String: Any]) async throws {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    try requireAndroidControl(laneId: trimmed)
    var args: [String: Any] = ["laneId": trimmed, "kind": kind]
    for (key, value) in extra { args[key] = value }
    _ = try await sendCommand(
      action: "android.input",
      args: args,
      disconnectOnTimeout: false,
      timeoutNanoseconds: Self.androidInputTimeoutNanoseconds,
      attemptedLiveFailurePolicy: .preserveForManualRetry
    )
  }

  /// The most finger events one `android.input touch` call may carry.
  static let androidMaxTouchEvents = 64

  /// Short enough that a dead route says so.
  private static let androidInputTimeoutNanoseconds: UInt64 = 8_000_000_000

  /// A cold boot of the emulator can take a few minutes on a slow machine.
  private static let androidStartTimeoutNanoseconds: UInt64 = 240_000_000_000

  private func requireAndroidControl(laneId: String) throws {
    guard supportsAndroidDeviceControl(laneId: laneId) else {
      throw androidUnsupportedError("Controlling this emulator needs a newer ADE on the computer.")
    }
  }

  private func androidUnsupportedError(_ message: String) -> NSError {
    NSError(
      domain: "ADE",
      code: 17,
      userInfo: [
        NSLocalizedDescriptionKey: message,
        "ADEErrorCode": "unsupported_action",
      ]
    )
  }
}
