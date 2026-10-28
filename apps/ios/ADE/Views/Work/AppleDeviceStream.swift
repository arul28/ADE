import AVFoundation
import Foundation
import SwiftUI
import UIKit

// MARK: - Wire models

/// Everything the host knows about one lane's Apple device, as published by the
/// `apple.status` sync command.
///
/// Every field is optional. This type is decoded from a host that ships on its
/// own cadence, so a phone that hard-required any of it would blank the card on
/// the first field the Mac renames. What the phone actually needs is small:
/// which device, which app, who owns it, and whether it is recording.
struct AppleDeviceStatus: Codable, Equatable {
  var laneId: String?
  /// Why there is no device. Always present on the wire (null when fine), and
  /// kept as a raw string so a sentence worded on a newer Mac is shown rather
  /// than failing to decode.
  var unavailable: String?
  var device: AppleDeviceStatusDevice?
  var app: AppleDeviceStatusApp?
  /// Always present on the wire, even with nothing running. Optional here only
  /// so a host mid-rollout that omits it decodes instead of blanking the card.
  var stream: AppleDeviceStatusStream?
  var recording: AppleDeviceStatusRecording?
  var owner: AppleDeviceStatusOwner?
  /// The device this lane owns (created or attached), when it has one. `device`
  /// can be a booted simulator the host picked for a lane with none, so only a
  /// `device` whose udid matches this one is the lane's. Absent from older hosts.
  var laneDevice: AppleDeviceStatusLaneDevice?
}

struct AppleDeviceStatusLaneDevice: Codable, Equatable {
  var udid: String?
}

struct AppleDeviceStatusDevice: Codable, Equatable {
  var udid: String?
  var name: String?
  /// `iphone` | `ipad` | `watch`. Raw so an unknown family degrades to a
  /// generic glyph instead of dropping the whole device.
  var family: String?
  var runtime: String?
  var origin: String?
  /// simctl's own device state, e.g. `Booted`.
  var state: String?
}

struct AppleDeviceStatusApp: Codable, Equatable {
  var bundleId: String?
  var name: String?
  var state: String?
}

struct AppleDeviceStatusStream: Codable, Equatable {
  var running: Bool?
  var codec: String?
  /// Device PIXELS. This is also the only geometry the phone gets — the status
  /// carries no separate screen size — so it is what the viewer sizes to.
  var width: Double?
  var height: Double?
  var bitrateKbps: Double?
  var fps: Double?
  /// The host's own last capture error. Shown verbatim: the Mac knows why its
  /// helper stopped and the phone does not.
  var lastError: String?
}

struct AppleDeviceStatusRecording: Codable, Equatable {
  var active: Bool?
  var id: String?
  var startedAt: String?
  var mode: String?
}

/// Who claimed the device.
///
/// `chatTitle` is resolved on the host, not here: the phone enters the tools
/// sheet with a laneId and no chat roster, so without it the ribbon could only
/// ever say "a chat in this lane". It is null whenever the chat has no title
/// yet, the lookup throws, or the runtime wired no chat service — never a
/// fabricated name — so the nameless sentence stays as the null branch rather
/// than being dropped.
struct AppleDeviceStatusOwner: Codable, Equatable {
  var chatSessionId: String?
  var chatTitle: String?
}

/// The answer to `apple.streamTicket`.
///
/// `url` is nullable and in practice always null: the command handler has no
/// view of which transport the requester dialed on, so it cannot honestly
/// build an absolute address. `path` is the real answer, resolved by the
/// client against its own connected endpoint. Single use, 60 s TTL, and
/// minting one starts or restarts capture at the remote bitrate cap — which is
/// why the geometry it carries is real rather than a guess.
struct AppleStreamTicket: Codable, Equatable {
  var url: String?
  var path: String?
  var token: String?
  var ticket: String?
  var codec: String?
  var width: Double?
  var height: Double?
  /// Device POINTS. With `width`/`height` this is the points-per-pixel ratio a
  /// touch on the picture needs to become a tap. Absent from older hosts,
  /// which leaves the viewer watch-only.
  var pointWidth: Double?
  var pointHeight: Double?
  /// The host takes a live finger (`apple.input` kind `touch`). Older hosts
  /// omit it, and the viewer sends whole taps and drags instead.
  var liveTouch: Bool?
  var expiresAt: String?

  /// Frame size in pixels, when the host sent a real one.
  var pixelSize: CGSize? { Self.size(width, height) }

  /// Screen size in points, when the host sent one.
  var pointSize: CGSize? { Self.size(pointWidth, pointHeight) }

  private static func size(_ width: Double?, _ height: Double?) -> CGSize? {
    guard let width, let height, width > 0, height > 0 else { return nil }
    return CGSize(width: width, height: height)
  }
}

/// What the relay says about this viewer's link, about once a second.
///
/// Only sent to a viewer that acks (see `AppleStreamSocket`). Every field is
/// optional for the same reason as the status: a newer Mac may say more.
struct AppleStreamNetworkStats: Equatable {
  /// The last record's round trip, Mac to phone and back.
  var rttMs: Double?
  /// Frames the relay skipped to keep this viewer current.
  var skipped: Int?

  init?(control object: [String: Any]) {
    guard object["t"] as? String == "stats" else { return nil }
    rttMs = (object["rttMs"] as? NSNumber)?.doubleValue
    skipped = (object["skipped"] as? NSNumber)?.intValue
  }
}

// MARK: - Display helpers

/// Human label for a device family. Unknown families come from a newer Mac, so
/// they are shown verbatim rather than dropped.
func appleDeviceFamilyLabel(_ family: String?) -> String? {
  guard let family, !family.isEmpty else { return nil }
  switch family {
  case "iphone": return "iPhone"
  case "ipad": return "iPad"
  case "watch": return "Apple Watch"
  default: return family
  }
}

/// How a claim is named.
///
/// One function rather than a computed property on each of the two surfaces
/// that show it: the ribbon and the card must not drift on the null branch,
/// which is the branch that actually ships — a chat is titled asynchronously,
/// so an unnamed claim is the normal state for the first seconds of every one.
/// Returns nil only when there is no claim at all.
func appleDeviceOwnerLabel(_ owner: AppleDeviceStatusOwner?) -> String? {
  guard let owner, owner.chatSessionId?.isEmpty == false else { return nil }
  if let title = owner.chatTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
    return title
  }
  return "a chat in this lane"
}

/// Whether the device the status shows is the one this lane holds.
///
/// For a lane with no device the host reports any booted iPhone, so `device`
/// alone could be another lane's or the user's own simulator. Only a match
/// with `laneDevice` makes it this lane's to drive.
func appleStatusShowsLaneDevice(_ status: AppleDeviceStatus?) -> Bool {
  guard
    let shown = status?.device?.udid, !shown.isEmpty,
    let held = status?.laneDevice?.udid
  else { return false }
  return shown == held
}

func appleDeviceFamilySymbol(_ family: String?) -> String {
  switch family {
  case "ipad": return "ipad"
  case "watch": return "applewatch"
  default: return "iphone"
  }
}

/// The sentence shown when the host advertises no Apple support at all.
///
/// Worded as an instruction rather than a fact, unlike the Work tools absences:
/// here the phone knows exactly what is wrong (the Mac predates the feature)
/// and exactly what fixes it.
let appleDeviceHostUnsupportedMessage = "Update ADE on your Mac to watch its simulator from here."

/// The sentence for a Mac whose ADE install has lost its simulator helper.
///
/// Not "update ADE": the Mac's ADE can be current and still be missing the
/// helper (a standalone brain that looks for it next to itself). What brings
/// it back is a reinstall or an update of ADE on that Mac.
let appleDeviceHelperMissingMessage =
  "The simulator helper is missing on your Mac. Reinstall or update ADE on the Mac to restore it."

/// A host's own capture or helper error, in words for this phone.
///
/// The host writes its helper errors for a developer at that Mac ("Run
/// `npm run build:sim-helper` in apps/desktop."). Those few are reworded;
/// every other sentence is the Mac's own and is shown as it wrote it.
func appleHostErrorMessage(_ raw: String) -> String {
  if raw.range(
    of: "simulator helper binary is missing|simulator helper (client )?has been disposed|simulator helper exited",
    options: [.regularExpression, .caseInsensitive]
  ) != nil {
    return appleDeviceHelperMissingMessage
  }
  if raw.range(of: "simulator helper is not running yet", options: .caseInsensitive) != nil {
    return "The simulator helper on your Mac is still starting. Try again in a moment."
  }
  return raw
}

/// Why the Mac refused a stream ticket, in words.
///
/// The one refusal worth rewording is `APPLE_DEVICE_OFF`: the simulator is
/// powered off, and watching from the phone never boots it. The host's
/// message is "APPLE_DEVICE_OFF: {name} is off. …", so the name is kept.
/// A missing helper gets its own sentence (`appleHostErrorMessage`); anything
/// else is shown as the host wrote it.
func appleStreamTicketFailureMessage(_ raw: String) -> String {
  guard let code = raw.range(of: "APPLE_DEVICE_OFF") else { return appleHostErrorMessage(raw) }
  let tail = raw[code.upperBound...].drop { $0 == ":" || $0 == " " }
  if let off = tail.range(of: " is off") {
    let name = tail[..<off.lowerBound].trimmingCharacters(in: .whitespaces)
    if !name.isEmpty { return "\(name) is off on your Mac. Start it in ADE on the Mac to watch it here." }
  }
  return "The simulator is off on your Mac. Start it in ADE on the Mac to watch it here."
}

/// Why there is no device to watch. Mirrors the host's `unavailable` reasons.
func appleDeviceUnavailableMessage(_ reason: String?) -> String {
  switch reason {
  case "unsupported":
    return "Simulators aren't available on this machine."
  case "desktop_not_attached", "desktop_not_attached_for_project":
    return "ADE Desktop doesn't have this project open. Open it on your Mac to watch its simulator."
  case "no_device":
    return "No simulator is open in this lane."
  case "error":
    return "Couldn't read the simulator's state."
  default:
    return "No simulator is open in this lane."
  }
}

// MARK: - Record framing

/// One record off the binary stream.
///
/// The framing is ADE's existing simulator-video wire format, defined by
/// `apps/desktop/src/shared/types/iosSimulator.ts` and reproduced in the sim
/// helper's `VideoRecord.swift`. Big-endian, a 12-byte header then the payload:
///
///     0..3   magic  0xADE1F00D
///     4      type   1 = config, 2 = access unit
///     5      flags  bit 0 = keyframe
///     6..7   reserved, zero
///     8..11  payload length
enum AppleStreamRecord: Equatable {
  case config(codec: String, width: Int?, height: Int?, annexB: Bool)
  case accessUnit(keyframe: Bool, bytes: Data)
}

struct AppleStreamProtocolError: LocalizedError, Equatable {
  let message: String
  var errorDescription: String? { message }
}

/// Incremental reader for the framed byte stream.
///
/// Deliberately free of `URLSession` and of AVFoundation: the viewer owns the
/// socket and the decoder, and a test feeds this hand-built chunks. A WebSocket
/// preserves message boundaries where a chunked HTTP body does not, but the
/// brain is free to coalesce or split records across frames when it pipes the
/// helper's stream through, so this must still reassemble across chunks.
struct AppleStreamRecordParser {
  static let magic: UInt32 = 0xADE1_F00D
  static let headerBytes = 12
  static let typeConfig: UInt8 = 1
  static let typeAccessUnit: UInt8 = 2
  static let flagKeyframe: UInt8 = 1

  /// A record larger than this is not something the host sends. Refusing it
  /// stops a desynchronised reader from allocating on a length it misread.
  static let maxRecordBytes = 16 * 1024 * 1024

  private var buffer = Data()

  var pendingBytes: Int { buffer.count }

  mutating func reset() {
    buffer = Data()
  }

  mutating func push(_ chunk: Data) throws -> [AppleStreamRecord] {
    if buffer.isEmpty {
      buffer = chunk
    } else {
      buffer.append(chunk)
    }
    var records: [AppleStreamRecord] = []
    var offset = 0
    while buffer.count - offset >= Self.headerBytes {
      let header = buffer.subdata(in: rangeIn(buffer, offset, Self.headerBytes))
      let magic = Self.readUInt32(header, 0)
      guard magic == Self.magic else {
        throw AppleStreamProtocolError(message: "The simulator video stream is not framed as expected.")
      }
      let type = header[header.startIndex + 4]
      let flags = header[header.startIndex + 5]
      let length = Int(Self.readUInt32(header, 8))
      guard length <= Self.maxRecordBytes else {
        throw AppleStreamProtocolError(message: "The simulator video stream declared a \(length) byte record.")
      }
      let end = offset + Self.headerBytes + length
      guard buffer.count >= end else { break }
      let payload = buffer.subdata(in: rangeIn(buffer, offset + Self.headerBytes, length))
      if type == Self.typeConfig {
        records.append(try Self.decodeConfig(payload))
      } else if type == Self.typeAccessUnit {
        records.append(.accessUnit(keyframe: (flags & Self.flagKeyframe) != 0, bytes: payload))
      }
      // Any other type is a record this build has no use for. Skipping it by
      // its declared length keeps the reader in sync with a newer host rather
      // than treating an addition as corruption.
      offset = end
    }
    // Re-base rather than slice: `Data` slices keep the parent's indices alive,
    // so a stream that never fully drains would grow an ever-offset buffer.
    buffer = offset == 0 ? buffer : Data(buffer.suffix(from: buffer.startIndex + offset))
    return records
  }

  private func rangeIn(_ data: Data, _ offset: Int, _ count: Int) -> Range<Data.Index> {
    (data.startIndex + offset)..<(data.startIndex + offset + count)
  }

  private static func readUInt32(_ data: Data, _ offset: Int) -> UInt32 {
    let i = data.startIndex + offset
    return (UInt32(data[i]) << 24) | (UInt32(data[i + 1]) << 16) | (UInt32(data[i + 2]) << 8) | UInt32(data[i + 3])
  }

  private static func decodeConfig(_ payload: Data) throws -> AppleStreamRecord {
    guard
      let object = try? JSONSerialization.jsonObject(with: payload),
      let dict = object as? [String: Any]
    else {
      throw AppleStreamProtocolError(message: "The simulator video stream sent an unreadable configuration.")
    }
    guard let codec = dict["codec"] as? String, !codec.isEmpty else {
      throw AppleStreamProtocolError(message: "The simulator video stream sent no codec.")
    }
    let width = (dict["width"] as? NSNumber)?.intValue
    let height = (dict["height"] as? NSNumber)?.intValue
    // `annexB` defaults to true: the helper only ever writes Annex-B, and a
    // host that omits the flag is the helper's own stream.
    let annexB = (dict["annexB"] as? Bool) ?? true
    return .config(codec: codec, width: width, height: height, annexB: annexB)
  }
}

// MARK: - Health state machine

/// What the viewer is doing, as one value the view renders directly.
enum AppleStreamPhase: Equatable {
  case idle
  /// Asking the host for a ticket.
  case requestingTicket
  /// Socket dialing, or dialed and waiting on the first decoded frame.
  case connecting
  case streaming
  /// Connected but no frames for longer than the watchdog allows.
  case stalled
  /// A transient drop (the relay's bridge race, a lost connection, a first
  /// frame that never came) the viewer is already redialing by itself.
  case reconnecting
  /// Terminal until the user reconnects. Carries the host's own sentence where
  /// there is one.
  case failed(String)
  /// The connected Mac does not advertise the Apple stream commands at all.
  case unsupported
}

/// Health policy for the viewer, kept pure so the two timeouts that decide
/// whether a stream is alive are tested rather than observed.
///
/// Both numbers come from the phase 4 contract: 5 s to the first frame, 3 s
/// between frames once running. They are separate because they mean different
/// things — a stream that never starts is a broken pipe, a stream that stops is
/// a wedged capture — and the viewer says so differently.
struct AppleStreamHealth: Equatable {
  static let firstFrameTimeout: TimeInterval = 5
  static let frameWatchdog: TimeInterval = 3

  private(set) var phase: AppleStreamPhase = .idle
  /// When the socket opened; the first-frame timeout runs from here.
  private(set) var openedAt: Date?
  private(set) var lastFrameAt: Date?
  /// True once any frame has been decoded on the current socket, so a stall is
  /// reported as a stall rather than as a stream that never started.
  private(set) var sawFrame = false

  mutating func requestTicket() {
    phase = .requestingTicket
    openedAt = nil
    lastFrameAt = nil
    sawFrame = false
  }

  mutating func connecting() {
    phase = .connecting
    openedAt = nil
    lastFrameAt = nil
    sawFrame = false
  }

  mutating func socketOpened(at date: Date) {
    // Stay in `.connecting`: an open socket with no picture is still, to the
    // person holding the phone, a stream that has not started.
    phase = .connecting
    openedAt = date
    sawFrame = false
  }

  mutating func frameDecoded(at date: Date) {
    phase = .streaming
    sawFrame = true
    lastFrameAt = date
    if openedAt == nil { openedAt = date }
  }

  mutating func fail(_ message: String) {
    phase = .failed(message)
  }

  /// An automatic redial is pending. Not a failure: no Reconnect is offered.
  mutating func reconnecting() {
    phase = .reconnecting
    openedAt = nil
    lastFrameAt = nil
    sawFrame = false
  }

  mutating func markUnsupported() {
    phase = .unsupported
  }

  /// Back to nothing — used when the viewer goes hidden, so returning starts a
  /// clean connect rather than inheriting a stale watchdog.
  mutating func reset() {
    phase = .idle
    openedAt = nil
    lastFrameAt = nil
    sawFrame = false
  }

  /// Advances the two timers. Idempotent, so the viewer can call it from a
  /// display-rate timer without the phase flapping.
  mutating func tick(now: Date) {
    switch phase {
    case .connecting:
      guard let openedAt, !sawFrame else { return }
      if now.timeIntervalSince(openedAt) >= Self.firstFrameTimeout {
        phase = .stalled
      }
    case .streaming:
      guard let lastFrameAt else { return }
      if now.timeIntervalSince(lastFrameAt) >= Self.frameWatchdog {
        phase = .stalled
      }
    case .idle, .requestingTicket, .stalled, .reconnecting, .failed, .unsupported:
      return
    }
  }

  /// The line the viewer puts under the picture for the current phase.
  var statusMessage: String? {
    switch phase {
    case .idle: return nil
    case .requestingTicket: return "Asking your Mac for the stream…"
    case .connecting: return "Connecting…"
    case .streaming: return nil
    case .stalled: return sawFrame ? "The stream stopped sending frames." : "No frames arrived."
    case .reconnecting: return "Reconnecting…"
    case .failed(let message): return message
    case .unsupported: return appleDeviceHostUnsupportedMessage
    }
  }

  /// Whether the Reconnect affordance should be offered. Never during a connect
  /// in flight — a second dial on top of the first is the fastest way to leave
  /// two sockets attached to one capture.
  var offersReconnect: Bool {
    switch phase {
    case .stalled, .failed: return true
    case .idle, .requestingTicket, .connecting, .reconnecting, .streaming, .unsupported: return false
    }
  }
}

// MARK: - Automatic redial

/// One way the stream socket ended.
struct AppleStreamSocketFailure: Equatable {
  let message: String
  /// A drop a fresh ticket and a redial usually cure, as opposed to a refusal
  /// (an expired pass, a stream this phone cannot decode, the Mac's own error)
  /// that would fail the same way again.
  let transient: Bool
}

/// When the viewer redials by itself instead of showing the failure.
///
/// Kept pure so the budget and the guards are tested rather than observed.
/// A few quick tries, each with a fresh single-use ticket. The budget refills
/// only once a stream has stayed up for `steadyAfter` seconds, so a stream
/// that decodes one keyframe and drops does not redial forever; and a viewer
/// session redials by itself at most `sessionCeiling` times before it offers
/// Reconnect. `reset()` (Reconnect, or the viewer closing) clears both.
struct AppleStreamRetryPolicy: Equatable {
  /// The pause before each automatic try. Its length is the budget.
  static let delays: [TimeInterval] = [0.5, 1.5, 3]
  /// How long a stream must keep decoding after it opens before the budget
  /// refills.
  static let steadyAfter: TimeInterval = 5
  /// Automatic redials per viewer session, however steady the stream was
  /// between them.
  static let sessionCeiling = 10

  private(set) var attempts = 0
  private(set) var sessionRedials = 0
  private var openedAt: Date?

  /// The pause before the next try, or nil when the viewer must show the
  /// failure instead: a refusal, a hidden or closed viewer, a spent budget.
  mutating func nextDelay(transient: Bool, started: Bool, visible: Bool) -> TimeInterval? {
    guard transient, started, visible,
          attempts < Self.delays.count, sessionRedials < Self.sessionCeiling else { return nil }
    defer {
      attempts += 1
      sessionRedials += 1
      openedAt = nil
    }
    return Self.delays[attempts]
  }

  /// The socket opened: the steady clock starts.
  mutating func streamOpened(at now: Date) {
    openedAt = now
  }

  /// A frame decoded: once the stream has been up `steadyAfter` seconds, the
  /// budget refills.
  mutating func frameDecoded(at now: Date) {
    guard attempts > 0, let openedAt, now.timeIntervalSince(openedAt) >= Self.steadyAfter else { return }
    attempts = 0
  }

  mutating func reset() {
    attempts = 0
    sessionRedials = 0
    openedAt = nil
  }
}

// MARK: - Stream URL resolution

/// Turns a ticket into the URL actually dialed.
///
/// The ticket's `url` is nullable and in practice always null: the host mints
/// tickets without knowing which transport the requester came in on, so it
/// refuses to guess an absolute address. `path` (`/apple/stream/<ticket>`) is
/// the documented answer, and resolving it is the client's job — which means
/// this function has to know the difference between the two routes:
///
/// - **Direct.** The connected sync endpoint is `ws://host:port`, so the path
///   is appended by ordinary URL arithmetic and the token rides the query.
/// - **Relay.** The endpoint is `wss://relay/connect/<machineKey>`, and the
///   tab is paired with a brain-side pipe that dials loopback itself. The path
///   cannot be appended to the relay's own URL; it rides as `kind=apple-stream`
///   plus `path=<local path>?token=<token>`, which the brain validates against
///   a strict regex before dialing. This mirrors `resolveAppleStreamUrl` in
///   `apps/desktop/src/renderer/webclient/adapter/appleDevice.ts` — the web
///   client and the phone must resolve identically or one of them silently
///   dials the relay's root.
///
/// The token also rides an `Authorization: Bearer` header on the direct route
/// (the server accepts either), but the query is what survives the relay.
func appleStreamSocketURL(
  ticketURL: String?,
  path ticketPath: String?,
  token: String?,
  connectedAddress: String?,
  fallbackPort: Int
) -> URL? {
  let absolute = (ticketURL ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let path = (ticketPath ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

  // An absolute URL, if a future host ever sends one, is authoritative: only
  // it can know about a route this phone cannot see.
  if !absolute.isEmpty,
     absolute.range(of: "^[a-z][a-z0-9+.-]*://", options: [.regularExpression, .caseInsensitive]) != nil {
    guard var components = URLComponents(string: absolute) else { return nil }
    guard appleStreamNormalizeScheme(&components) else { return nil }
    appleStreamAppendTokenIfAbsent(&components, token: token)
    return components.url
  }

  let localPath = path.isEmpty ? absolute : path
  guard localPath.hasPrefix("/") else { return nil }
  guard
    let connectedAddress,
    let baseString = syncWebSocketURLString(host: connectedAddress, port: fallbackPort),
    var base = URLComponents(string: baseString)
  else { return nil }
  guard appleStreamNormalizeScheme(&base) else { return nil }

  if base.path.range(of: "/connect/[^/]+$", options: .regularExpression) != nil {
    var items = base.queryItems ?? []
    items.removeAll { $0.name == "kind" || $0.name == "path" }
    items.append(URLQueryItem(name: "kind", value: appleStreamPipeKind))
    // The token rides inside the forwarded path, because the relay's own query
    // belongs to the pipe and is not passed through to the brain's socket.
    let forwarded = (token?.isEmpty == false) && !localPath.contains("token=")
      ? "\(localPath)?token=\(token!)"
      : localPath
    items.append(URLQueryItem(name: "path", value: forwarded))
    base.queryItems = items
    return base.url
  }

  let parts = localPath.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
  base.path = String(parts[0])
  base.query = parts.count > 1 ? String(parts[1]) : nil
  appleStreamAppendTokenIfAbsent(&base, token: token)
  return base.url
}

/// The relay pipe kind the brain matches on. Must stay byte-identical to
/// `APPLE_STREAM_PIPE_KIND` in `syncTunnelClientService.ts`; a mismatch makes
/// the brain dial its sync root instead of the stream and the viewer sees a
/// socket that opens and never sends a frame.
let appleStreamPipeKind = "apple-stream"

/// `http(s)` is upgraded rather than refused: a host naming its own HTTP origin
/// is naming the same listener. Anything else is not dialed at all.
private func appleStreamNormalizeScheme(_ components: inout URLComponents) -> Bool {
  switch components.scheme?.lowercased() {
  case "http": components.scheme = "ws"
  case "https": components.scheme = "wss"
  case "ws", "wss": break
  default: return false
  }
  return true
}

private func appleStreamAppendTokenIfAbsent(_ components: inout URLComponents, token: String?) {
  guard let token, !token.isEmpty else { return }
  var items = components.queryItems ?? []
  guard !items.contains(where: { $0.name == "token" }) else { return }
  items.append(URLQueryItem(name: "token", value: token))
  components.queryItems = items
}

// MARK: - Decoder

/// The Apple device viewer's picture: a display layer it owns, fed by the
/// shared `H264SampleBufferFeeder`.
///
/// The helper's access units carry SPS/PPS inline on every keyframe, so the
/// format is built from any keyframe and rebuilt when the device rotates and
/// the parameter sets change mid-stream.
@MainActor
final class AppleStreamDecoder {
  let layer = AVSampleBufferDisplayLayer()
  private let feeder = H264SampleBufferFeeder()

  var presentedSize: CGSize? { feeder.presentedSize }

  init() {
    layer.videoGravity = .resizeAspect
    layer.backgroundColor = UIColor.black.cgColor
    feeder.attach(layer)
  }

  func reset() {
    feeder.reset()
  }

  /// Decodes one access unit. Returns true when a sample was enqueued, which is
  /// what feeds the frame watchdog — a unit that only carried parameter sets,
  /// or a P-frame held until the next keyframe, is not a frame.
  @discardableResult
  func decode(accessUnit: Data, keyframe: Bool) -> Bool {
    feeder.feed(annexB: accessUnit, keyframe: keyframe) == .enqueued
  }
}

// MARK: - Layer host

/// Hosts the decoder's `AVSampleBufferDisplayLayer`.
///
/// The layer belongs to the decoder, not to this view: SwiftUI rebuilds a
/// representable freely, and a layer recreated on a rebuild would drop the
/// format description and stall until the next keyframe.
struct AppleStreamLayerView: UIViewRepresentable {
  let layer: AVSampleBufferDisplayLayer

  func makeUIView(context: Context) -> AppleStreamLayerHostView {
    let view = AppleStreamLayerHostView()
    view.install(layer)
    return view
  }

  func updateUIView(_ uiView: AppleStreamLayerHostView, context: Context) {
    uiView.install(layer)
  }
}

final class AppleStreamLayerHostView: UIView {
  private weak var installed: AVSampleBufferDisplayLayer?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    isUserInteractionEnabled = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func install(_ next: AVSampleBufferDisplayLayer) {
    guard installed !== next else { return }
    installed?.removeFromSuperlayer()
    layer.addSublayer(next)
    installed = next
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // No implicit animation: the layer is resized on rotation and on the first
    // frame, and an animated bounds change makes the picture visibly swim.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    installed?.frame = bounds
    CATransaction.commit()
  }
}

/// Bitrate as the stream stats say it. Sub-megabit reads in kb/s because "0.8 Mb/s"
/// is a worse answer than "800 kb/s" for the number people are watching drop.
func appleStreamBitrateLabel(kbps: Double) -> String {
  guard kbps > 0 else { return "0 kb/s" }
  if kbps < 1000 { return "\(Int(kbps.rounded())) kb/s" }
  return String(format: "%.1f Mb/s", kbps / 1000)
}

// MARK: - Socket

/// The binary stream socket.
///
/// Separate from `SyncService`'s socket on purpose: video never rides the JSON
/// envelope. The same `URLSessionWebSocketTask` works for both the direct and
/// the relay path — the relay forwards binary frames verbatim — so there is one
/// client here and the host's ticket decides which one it is.
///
/// Every batch of records is acked (`{t:"ack",n}`, the count received on this
/// socket). The relay times those acks, which is the only way it can see a
/// queue building between the Mac and the phone when the socket it writes to
/// is the tunnel's loopback pipe; past its budget it skips frames and resumes
/// at a keyframe, and it answers with `{t:"stats"}`. A host that predates
/// pacing ignores the acks.
@MainActor
final class AppleStreamSocket: NSObject {
  private var task: URLSessionWebSocketTask?
  private var session: URLSession?
  private var parser = AppleStreamRecordParser()
  private var closed = false
  private var visible = true
  /// Records received on this socket; what an ack reports.
  private var received = 0
  /// One failure per connection: a server close arrives both as a failed
  /// receive and as `didCloseWith`, and two reports would schedule two redials.
  private var failureReported = false

  var onOpen: (() -> Void)?
  var onRecord: ((AppleStreamRecord) -> Void)?
  var onError: ((AppleStreamSocketFailure) -> Void)?
  var onStats: ((AppleStreamNetworkStats) -> Void)?

  func connect(url: URL, token: String?) {
    close()
    closed = false
    failureReported = false
    parser.reset()
    received = 0
    var request = URLRequest(url: url)
    if let token, !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let configuration = URLSessionConfiguration.default
    // A viewer that cannot reach the Mac should say so, not sit on a spinner
    // until the system's default minute is up.
    configuration.timeoutIntervalForRequest = 15
    configuration.waitsForConnectivity = false
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    let task = session.webSocketTask(with: request)
    self.session = session
    self.task = task
    task.resume()
    receive()
  }

  /// Tells the host whether anyone is looking. The brain stops forwarding on
  /// `hidden` — and asks the helper to stop capturing when no local viewer is
  /// left — so this is what keeps a backgrounded phone from holding a capture
  /// open on someone's Mac.
  func setVisible(_ visible: Bool) {
    self.visible = visible
    guard let task, !closed else { return }
    let payload = visible ? "{\"t\":\"visible\"}" : "{\"t\":\"hidden\"}"
    task.send(.string(payload)) { _ in
      // A failed visibility hint is not worth surfacing: the receive loop is
      // about to report the same dead socket with a better sentence.
    }
  }

  func close() {
    closed = true
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    session?.invalidateAndCancel()
    session = nil
    parser.reset()
  }

  private func receive() {
    guard let task else { return }
    task.receive { [weak self] result in
      // The session's delegate queue is main, so this is already on the main
      // actor: handling the frame in place saves a task hop on every frame,
      // which is time the picture would otherwise spend waiting to decode.
      if Thread.isMainThread {
        MainActor.assumeIsolated { self?.handle(result, from: task) }
      } else {
        Task { @MainActor [weak self] in self?.handle(result, from: task) }
      }
    }
  }

  private func handle(
    _ result: Result<URLSessionWebSocketTask.Message, Error>,
    from task: URLSessionWebSocketTask
  ) {
    guard !closed, self.task === task else { return }
    switch result {
    case .failure(let error):
      // A peer close fails the pending receive too. Its close code says more
      // than the generic socket error does, so it wins when there is one.
      if task.closeCode != .invalid {
        let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) }
        report(Self.failure(forCloseCode: task.closeCode.rawValue, reason: reason))
      } else {
        report(Self.failure(for: error))
      }
    case .success(let message):
      switch message {
      case .data(let data):
        ingest(data)
      case .string(let text):
        // The host's own channel: a text frame on a binary stream is how it
        // explains itself once the pipe is up, and how the relay reports pace.
        handleControl(text)
      @unknown default:
        break
      }
      receive()
    }
  }

  private func ingest(_ data: Data) {
    do {
      let records = try parser.push(data)
      guard !records.isEmpty else { return }
      received += records.count
      // Acked before decoding: the relay is measuring the network, and decode
      // time on this end is not a queue it can drain by skipping frames.
      ack()
      for record in records {
        onRecord?(record)
      }
    } catch {
      report(AppleStreamSocketFailure(
        message: (error as? AppleStreamProtocolError)?.message ?? error.localizedDescription,
        transient: false
      ))
      close()
    }
  }

  private func ack() {
    guard let task, !closed, visible else { return }
    task.send(.string("{\"t\":\"ack\",\"n\":\(received)}")) { _ in
      // A lost ack only makes the relay think this viewer is a little behind;
      // the receive loop reports a dead socket with a better sentence.
    }
  }

  private func handleControl(_ text: String) {
    guard
      let data = text.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return }
    if let stats = AppleStreamNetworkStats(control: object) {
      onStats?(stats)
      return
    }
    // The host explaining itself: its own sentence, never redialed.
    if let message = object["error"] as? String, !message.isEmpty {
      report(AppleStreamSocketFailure(message: appleHostErrorMessage(message), transient: false))
      close()
      return
    }
    if let message = object["message"] as? String, object["t"] as? String == "error", !message.isEmpty {
      report(AppleStreamSocketFailure(message: appleHostErrorMessage(message), transient: false))
      close()
    }
  }

  private func report(_ failure: AppleStreamSocketFailure) {
    guard !failureReported else { return }
    failureReported = true
    onError?(failure)
  }

  /// Close codes a redial usually cures: the relay's bridge race (4510), a
  /// relay forwarding failure (4509), a pre-ready buffer overflow (4506), and
  /// a connection that went away or dropped without a close frame.
  static let transientCloseCodes: Set<Int> = [1001, 1006, 4506, 4509, 4510]

  static func failure(forCloseCode code: Int, reason: String?) -> AppleStreamSocketFailure {
    AppleStreamSocketFailure(
      message: message(forCloseCode: code, reason: reason),
      transient: transientCloseCodes.contains(code)
    )
  }

  static func failure(for error: Error) -> AppleStreamSocketFailure {
    let nsError = error as NSError
    let transient: Bool
    switch (nsError.domain, nsError.code) {
    case (NSURLErrorDomain, NSURLErrorNetworkConnectionLost), (NSURLErrorDomain, NSURLErrorTimedOut):
      transient = true
    case (NSPOSIXErrorDomain, Int(ECONNRESET)), (NSPOSIXErrorDomain, Int(ENOTCONN)):
      transient = true
    default:
      transient = false
    }
    return AppleStreamSocketFailure(message: message(for: error), transient: transient)
  }

  /// The three close codes the brain actually sends.
  ///
  /// 4401 is the one worth wording carefully: tickets are single-use and live
  /// 60 seconds, so a viewer that sat on the sheet past the TTL — or that the
  /// user reconnected twice in a row — gets it routinely. It is not a broken
  /// Mac and must not read like one.
  static func message(forCloseCode code: Int, reason: String?) -> String {
    switch code {
    case 4401:
      return "The stream pass expired. Reconnect to get a new one."
    case 1012:
      return "The simulator stopped streaming."
    case 1000:
      return "The stream ended."
    default:
      if let reason, !reason.isEmpty { return reason }
      return "The Mac closed the stream."
    }
  }

  private static func message(for error: Error) -> String {
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain {
      switch nsError.code {
      case NSURLErrorCancelled: return "The stream was closed."
      case NSURLErrorTimedOut: return "The stream timed out."
      case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost:
        return "Couldn't reach the stream on your Mac."
      default: break
      }
    }
    return nsError.localizedDescription
  }
}

extension AppleStreamSocket: URLSessionWebSocketDelegate {
  nonisolated func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol proto: String?
  ) {
    Task { @MainActor [weak self] in
      guard let self, self.task === webSocketTask else { return }
      self.onOpen?()
    }
  }

  nonisolated func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    let text = reason.flatMap { String(data: $0, encoding: .utf8) }
    let code = closeCode.rawValue
    Task { @MainActor [weak self] in
      guard let self, self.task === webSocketTask, !self.closed else { return }
      self.report(Self.failure(forCloseCode: code, reason: text))
    }
  }
}
