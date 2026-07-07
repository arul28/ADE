import Foundation
import UIKit

/// Hands pairing credentials from the App Clip to the full app through the
/// shared App Group container. App Clips cannot share a keychain with their
/// full app, so the blob lives in the group container protected with
/// `.completeFileProtection`; the full app migrates it into the Keychain and
/// deletes the file on first launch (see `ClipHandoffAdopter` in the app).
enum ClipHandoff {
  static let appGroupIdentifier = "group.com.ade.ios"
  static let handoffFilename = "clip-pairing-handoff.v1.json"
  private static let defaultsKey = "clip.pairing.identity.v1"

  struct Payload: Codable, Equatable {
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
  }

  /// Stable per-install identity for the clip's pairing request. Persisted in
  /// the shared group defaults so a re-scan before the full app installs
  /// reuses the same deviceId instead of piling up registrations on the host.
  static func clipDeviceId() -> String {
    identity().deviceId
  }

  static func clipSiteId() -> String {
    identity().siteId
  }

  static func deviceDisplayName() -> String {
    UIDevice.current.name
  }

  static func store(success: ClipPairingSuccess, payload: PairingQrPayload) -> Bool {
    let blob = Payload(
      deviceId: success.deviceId,
      secret: success.secret,
      host: success.host,
      port: success.port,
      hostIdentity: payload.hostIdentity.deviceId,
      hostName: payload.hostIdentity.name,
      siteId: payload.hostIdentity.siteId,
      addressCandidates: payload.directCandidateHosts,
      relayCandidates: payload.relayCandidateHosts,
      pairedAtEpochSeconds: Date().timeIntervalSince1970
    )
    guard let url = handoffURL(),
          let data = try? JSONEncoder().encode(blob) else {
      return false
    }
    do {
      try data.write(to: url, options: [.atomic, .completeFileProtection])
      return true
    } catch {
      return false
    }
  }

  static func handoffURL() -> URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
      .appendingPathComponent(handoffFilename, isDirectory: false)
  }

  private struct Identity: Codable {
    let deviceId: String
    let siteId: String
  }

  private static func identity() -> Identity {
    let defaults = UserDefaults(suiteName: appGroupIdentifier) ?? .standard
    if let data = defaults.data(forKey: defaultsKey),
       let stored = try? JSONDecoder().decode(Identity.self, from: data) {
      return stored
    }
    let fresh = Identity(
      deviceId: UUID().uuidString.lowercased(),
      siteId: UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    )
    if let data = try? JSONEncoder().encode(fresh) {
      defaults.set(data, forKey: defaultsKey)
    }
    return fresh
  }
}
