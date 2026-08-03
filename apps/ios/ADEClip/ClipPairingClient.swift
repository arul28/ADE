import Foundation

/// Result of a successful App Clip pairing handshake. Mirrors what the full
/// app persists after `pairAndConnect`, minus the sync-database state the
/// clip does not have.
struct ClipPairingSuccess: Equatable {
  let deviceId: String
  let secret: String
  let host: String
  let port: Int
}

enum ClipPairingError: LocalizedError, Equatable {
  case unreachable
  case pinNotSet
  case invalidPin
  case failed(String)

  var errorDescription: String? {
    switch self {
    case .unreachable:
      return "Couldn't reach the machine. Make sure your iPhone is on the same network."
    case .pinNotSet:
      return "No pairing PIN is set on the computer. Open ADE on your computer and set one first."
    case .invalidPin:
      return "That PIN doesn't match. Check the code shown on your computer."
    case .failed(let message):
      return message
    }
  }
}

/// Minimal pairing-only sync client. Speaks just enough of the ADE sync
/// envelope protocol (version 1, uncompressed JSON payloads) to walk the QR's
/// address candidates, deliver one `pairing_request`, and read the
/// `pairing_result`. Deliberately self-contained: the clip must stay far under
/// the App Clip size budget, so it does not link the full `SyncService`.
final class ClipPairingClient: NSObject {
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?

  /// Walks direct candidates first (LAN / Tailscale / loopback), then relay
  /// URLs, mirroring the full app's preference order. Returns the first
  /// address that completes the handshake.
  func pair(payload: PairingQrPayload, pin: String) async throws -> ClipPairingSuccess {
    var lastError: ClipPairingError = .unreachable
    let candidates = payload.directCandidateHosts.map { (host: $0, isRelay: false) }
      + payload.relayCandidateHosts.map { (host: $0, isRelay: true) }
    for candidate in candidates {
      do {
        return try await pairOnce(
          host: candidate.host,
          port: payload.port,
          pin: pin
        )
      } catch let error as ClipPairingError {
        // PIN/host errors are terminal — the host was reached and answered.
        switch error {
        case .pinNotSet, .invalidPin, .failed:
          throw error
        case .unreachable:
          lastError = error
        }
      }
    }
    throw lastError
  }

  /// Hard ceiling on one candidate's full handshake (connect + send +
  /// receive). `timeoutIntervalForRequest` only covers opening the socket;
  /// without this a host that accepts the connection but never answers the
  /// pairing_request would pin the clip in `.pairing` forever.
  private static let handshakeTimeoutSeconds: UInt64 = 15

  private func pairOnce(host: String, port: Int, pin: String) async throws -> ClipPairingSuccess {
    try await withThrowingTaskGroup(of: ClipPairingSuccess.self) { group in
      group.addTask { try await self.pairOnceInner(host: host, port: port, pin: pin) }
      group.addTask {
        try await Task.sleep(nanoseconds: Self.handshakeTimeoutSeconds * 1_000_000_000)
        throw ClipPairingError.unreachable
      }
      defer { group.cancelAll() }
      guard let first = try await group.next() else { throw ClipPairingError.unreachable }
      return first
    }
  }

  private func pairOnceInner(host: String, port: Int, pin: String) async throws -> ClipPairingSuccess {
    guard let url = ClipPairingClient.socketURL(host: host, defaultPort: port) else {
      throw ClipPairingError.unreachable
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 10
    let session = URLSession(configuration: configuration)
    let task = session.webSocketTask(with: url)
    task.maximumMessageSize = 8 * 1024 * 1024
    self.session = session
    self.task = task
    defer {
      task.cancel(with: .normalClosure, reason: nil)
      session.invalidateAndCancel()
      self.task = nil
      self.session = nil
    }
    task.resume()

    // A pending `receive()` does not respond to Swift task cancellation on
    // its own; killing the socket on cancel errors it out so the timeout
    // sibling in `pairOnce` can actually unwind this child.
    return try await withTaskCancellationHandler {
      try await performHandshake(task: task, host: host, port: port, pin: pin)
    } onCancel: {
      task.cancel(with: .goingAway, reason: nil)
      session.invalidateAndCancel()
    }
  }

  private func performHandshake(
    task: URLSessionWebSocketTask,
    host: String,
    port: Int,
    pin: String
  ) async throws -> ClipPairingSuccess {
    let requestId = UUID().uuidString.lowercased()
    let peer: [String: Any] = [
      "deviceId": ClipHandoff.clipDeviceId(),
      "deviceName": ClipHandoff.deviceDisplayName(),
      "platform": "ios",
      "deviceType": "phone",
      // The clip has no sync database; the full app hellos with its real
      // site id and the host upserts peer metadata then. A stable random
      // placeholder satisfies the pairing payload contract.
      "siteId": ClipHandoff.clipSiteId(),
      "dbVersion": 0,
    ]
    let envelope: [String: Any] = [
      "version": 1,
      "type": "pairing_request",
      "compression": "none",
      "payloadEncoding": "json",
      "requestId": requestId,
      "payload": [
        "code": pin.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
        "peer": peer,
      ],
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: envelope),
          let text = String(data: data, encoding: .utf8) else {
      throw ClipPairingError.failed("Couldn't encode the pairing request.")
    }
    do {
      try await task.send(.string(text))
    } catch {
      throw ClipPairingError.unreachable
    }

    // Read frames until the matching pairing_result arrives (the host may
    // interleave unrelated frames); bail after a bounded number of frames.
    for _ in 0..<32 {
      let message: URLSessionWebSocketTask.Message
      do {
        message = try await task.receive()
      } catch {
        throw ClipPairingError.unreachable
      }
      guard let object = ClipPairingClient.decodeEnvelope(message) else { continue }
      guard (object["type"] as? String) == "pairing_result" else { continue }
      if let envelopeRequestId = object["requestId"] as? String,
         !envelopeRequestId.isEmpty, envelopeRequestId != requestId {
        continue
      }
      let payload = object["payload"] as? [String: Any] ?? [:]
      if (payload["ok"] as? Bool) == true,
         let secret = payload["secret"] as? String,
         let deviceId = payload["deviceId"] as? String {
        return ClipPairingSuccess(deviceId: deviceId, secret: secret, host: host, port: port)
      }
      let error = payload["error"] as? [String: Any]
      let code = error?["code"] as? String
      let errorMessage = error?["message"] as? String
      switch code {
      case "pin_not_set": throw ClipPairingError.pinNotSet
      case "invalid_pin": throw ClipPairingError.invalidPin
      default: throw ClipPairingError.failed(errorMessage ?? "Pairing failed. Try scanning the code again.")
      }
    }
    throw ClipPairingError.failed("The machine didn't answer the pairing request.")
  }

  /// Mirrors `syncWebSocketURLString`: full ws/wss relay URLs pass verbatim
  /// (they carry `/connect/<machineKey>` paths); bare hosts become
  /// `ws://host:port` with IPv6 literals bracketed.
  static func socketURL(host rawHost: String, defaultPort: Int) -> URL? {
    let trimmed = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if trimmed.lowercased().hasPrefix("ws://") || trimmed.lowercased().hasPrefix("wss://") {
      return URL(string: trimmed)
    }
    let host = trimmed.contains(":") && !trimmed.hasPrefix("[") ? "[\(trimmed)]" : trimmed
    guard defaultPort > 0, defaultPort <= 65_535 else { return nil }
    return URL(string: "ws://\(host):\(defaultPort)")
  }

  private static func decodeEnvelope(_ message: URLSessionWebSocketTask.Message) -> [String: Any]? {
    let data: Data
    switch message {
    case .string(let text):
      guard let encoded = text.data(using: .utf8) else { return nil }
      data = encoded
    case .data(let raw):
      data = raw
    @unknown default:
      return nil
    }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}
