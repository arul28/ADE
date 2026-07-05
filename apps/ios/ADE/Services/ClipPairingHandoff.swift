import Foundation

/// Pairing credentials handed off by the ADE App Clip through the shared App
/// Group container. The clip pairs (PIN-gated) before the full app is
/// installed and writes this blob; the app adopts it on first launch and
/// deletes the file. Field shape is versioned and must stay in sync with
/// `ClipHandoff.Payload` in the ADEClip target.
struct ClipPairingHandoff: Codable, Equatable {
  static let appGroupIdentifier = "group.com.ade.ios"
  static let handoffFilename = "clip-pairing-handoff.v1.json"
  /// Handoffs older than this are ignored (stale scan long before install).
  static let maxAgeSeconds: Double = 60 * 60 * 24 * 7

  var version: Int = 1
  let deviceId: String
  let secret: String
  let host: String
  let port: Int
  let hostIdentity: String
  let hostName: String
  let siteId: String?
  let addressCandidates: [String]
  let relayCandidates: [String]
  let pairedAtEpochSeconds: Double

  static func containerURL() -> URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
      .appendingPathComponent(handoffFilename, isDirectory: false)
  }

  /// Reads AND removes the pending handoff (one-shot: the blob holds a
  /// secret, so it never outlives its first read, valid or not).
  static func consume() -> ClipPairingHandoff? {
    guard let url = containerURL(),
          let data = try? Data(contentsOf: url) else {
      return nil
    }
    try? FileManager.default.removeItem(at: url)
    guard let handoff = try? JSONDecoder().decode(ClipPairingHandoff.self, from: data),
          handoff.version == 1,
          !handoff.deviceId.isEmpty,
          !handoff.secret.isEmpty,
          Date().timeIntervalSince1970 - handoff.pairedAtEpochSeconds < maxAgeSeconds else {
      return nil
    }
    return handoff
  }
}
