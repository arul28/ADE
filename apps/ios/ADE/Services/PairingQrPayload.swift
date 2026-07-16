import CoreFoundation
import Foundation

/// Address candidate carried in a scanned pairing QR. `kind == "relay"` entries
/// carry a full `wss://…/connect/<machineKey>` URL in `host`; every other kind
/// carries a bare host (LAN IP, Tailscale address, `.local`, loopback).
struct PairingQrAddressCandidate: Equatable {
  let host: String
  let kind: String
}

/// Host identity block from a pairing QR. Mirrors `SyncPairingHostIdentity`.
struct PairingQrHostIdentity: Equatable {
  let deviceId: String
  let siteId: String
  let name: String
  let platform: String
  let deviceType: String
}

/// Decoded pairing QR payload. Swift port of the canonical codec in
/// `apps/desktop/src/shared/pairingQr.ts` — parsing only. The smart URL is
/// `https://ade-app.dev/pair#<base64url(JSON)>`; the PIN is never embedded, so
/// a photographed QR alone cannot pair a device.
struct PairingQrPayload: Equatable {
  /// Minimum payload version this build understands. Newer versions parse
  /// leniently as long as the fields here are present.
  static let requiredVersion = 3
  private static let maxPayloadBytes = 8 * 1024

  let version: Int
  let hostIdentity: PairingQrHostIdentity
  let port: Int
  let addressCandidates: [PairingQrAddressCandidate]
  /// Full `wss://` URL of the cloud tunnel relay, when the user enabled it.
  let relayUrl: String?
  /// Reserved for off-LAN pairing claims once the relay pairing flow ships.
  let claimToken: String?
  /// Additive v3 hint. `nil` means the QR came from an older host; the live
  /// pairing response remains authoritative if the host's PIN changes later.
  let pinConfigured: Bool?

  /// Direct (LAN/Tailscale/saved/loopback) hosts, in payload order.
  var directCandidateHosts: [String] {
    addressCandidates.filter { $0.kind != "relay" }.map(\.host)
  }

  /// Relay wss URLs: `relay`-kind candidates plus the standalone relayUrl.
  var relayCandidateHosts: [String] {
    addressCandidates.filter { $0.kind == "relay" }.map(\.host)
      + (relayUrl.map { [$0] } ?? [])
  }

  /// Parses a scanned pairing code. Accepts the smart URL form (payload in the
  /// fragment) and, defensively, a bare base64url or JSON string.
  static func parse(_ raw: String) -> PairingQrPayload? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.utf8.count <= maxPayloadBytes else { return nil }

    var encoded = trimmed
    if trimmed.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil {
      guard let components = URLComponents(string: trimmed) else { return nil }
      let path = components.path
      guard path == "/pair" || path.hasSuffix("/pair") else { return nil }
      // The payload rides the URL fragment so it never reaches a web server.
      let fragment = components.fragment ?? ""
      guard !fragment.isEmpty else { return nil }
      encoded = fragment
    }

    let json: String?
    if encoded.hasPrefix("{") {
      json = encoded
    } else {
      json = base64UrlDecodeUtf8(encoded)
    }
    guard let json,
          let data = json.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data),
          let object = parsed as? [String: Any] else {
      return nil
    }

    guard let version = readInt(object["version"]), version >= requiredVersion else { return nil }
    guard let hostIdentity = parseHostIdentity(object["hostIdentity"]) else { return nil }
    guard let port = readInt(object["port"]), port > 0, port <= 65_535 else { return nil }

    let relayUrlRaw = readString(object, "relayUrl")
    let relayUrl = relayUrlRaw.range(of: "^wss://", options: [.regularExpression, .caseInsensitive]) != nil
      ? relayUrlRaw
      : nil
    let claimTokenRaw = readString(object, "claimToken")

    return PairingQrPayload(
      version: requiredVersion,
      hostIdentity: hostIdentity,
      port: port,
      addressCandidates: parseAddressCandidates(object["addressCandidates"]),
      relayUrl: relayUrl.isEmptyOrNil ? nil : relayUrl,
      claimToken: claimTokenRaw.isEmpty ? nil : claimTokenRaw,
      pinConfigured: readLiteralBool(object["pinConfigured"])
    )
  }

  // MARK: - Field parsing

  private static let addressCandidateKinds: Set<String> = ["lan", "saved", "tailscale", "loopback", "relay"]

  private static func parseHostIdentity(_ value: Any?) -> PairingQrHostIdentity? {
    guard let object = value as? [String: Any] else { return nil }
    let deviceId = readString(object, "deviceId")
    let name = readString(object, "name")
    guard !deviceId.isEmpty, !name.isEmpty else { return nil }
    let platform = readString(object, "platform")
    let deviceType = readString(object, "deviceType")
    let normalizedPlatform = ["macOS", "iOS", "linux", "windows"].contains(platform) ? platform : "unknown"
    let normalizedDeviceType = ["desktop", "phone", "vps"].contains(deviceType) ? deviceType : "unknown"
    return PairingQrHostIdentity(
      deviceId: deviceId,
      siteId: readString(object, "siteId"),
      name: name,
      platform: normalizedPlatform,
      deviceType: normalizedDeviceType
    )
  }

  private static func parseAddressCandidates(_ value: Any?) -> [PairingQrAddressCandidate] {
    guard let array = value as? [Any] else { return [] }
    var candidates: [PairingQrAddressCandidate] = []
    var seen = Set<String>()
    for entry in array {
      guard let object = entry as? [String: Any] else { continue }
      let host = readString(object, "host")
      guard !host.isEmpty, !seen.contains(host) else { continue }
      let kindRaw = readString(object, "kind")
      let kind = addressCandidateKinds.contains(kindRaw) ? kindRaw : "lan"
      seen.insert(host)
      candidates.append(PairingQrAddressCandidate(host: host, kind: kind))
    }
    return candidates
  }

  private static func readString(_ object: [String: Any], _ key: String) -> String {
    guard let value = object[key] as? String else { return "" }
    return value.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func readInt(_ value: Any?) -> Int? {
    if let intValue = value as? Int { return intValue }
    if let doubleValue = value as? Double, doubleValue.isFinite { return Int(doubleValue) }
    if let number = value as? NSNumber { return number.intValue }
    if let string = value as? String, let parsed = Int(string.trimmingCharacters(in: .whitespacesAndNewlines)) {
      return parsed
    }
    return nil
  }

  private static func readLiteralBool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) == CFBooleanGetTypeID() else {
      return nil
    }
    return number.boolValue
  }

  private static func base64UrlDecodeUtf8(_ value: String) -> String? {
    var normalized = value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let remainder = normalized.count % 4
    if remainder > 0 {
      normalized.append(String(repeating: "=", count: 4 - remainder))
    }
    guard let data = Data(base64Encoded: normalized) else { return nil }
    return String(data: data, encoding: .utf8)
  }
}

private extension Optional where Wrapped == String {
  var isEmptyOrNil: Bool {
    switch self {
    case .none: return true
    case .some(let value): return value.isEmpty
    }
  }
}
