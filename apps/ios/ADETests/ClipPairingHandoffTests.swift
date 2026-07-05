import XCTest
@testable import ADE

/// Covers the App Clip → full app pairing handoff blob: decode gates
/// (version / required fields / age) and the one-shot consume semantics the
/// adoption path in `SyncService.adoptClipPairingHandoffIfPresent` relies on.
/// Field shape must stay in sync with `ClipHandoff.Payload` in the ADEClip
/// target.
final class ClipPairingHandoffTests: XCTestCase {
  private var tempURL: URL!

  override func setUpWithError() throws {
    tempURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("clip-handoff-tests-\(UUID().uuidString).json")
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: tempURL)
  }

  private func writeBlob(
    version: Int = 1,
    deviceId: String = "device-1",
    secret: String = "secret-1",
    pairedAt: Double = Date().timeIntervalSince1970
  ) throws {
    let blob: [String: Any] = [
      "version": version,
      "deviceId": deviceId,
      "secret": secret,
      "host": "192.168.1.42",
      "port": 8787,
      "hostIdentity": "dev-abc123",
      "hostName": "Arul MacBook",
      "siteId": "site-xyz",
      "addressCandidates": ["192.168.1.42", "100.101.102.103"],
      "relayCandidates": ["wss://relay.ade-app.dev/connect/machinekey123"],
      "pairedAtEpochSeconds": pairedAt,
    ]
    let data = try JSONSerialization.data(withJSONObject: blob)
    try data.write(to: tempURL)
  }

  func testConsumesValidBlobAndDeletesFile() throws {
    try writeBlob()
    let handoff = try XCTUnwrap(ClipPairingHandoff.consume(at: tempURL))
    XCTAssertEqual(handoff.deviceId, "device-1")
    XCTAssertEqual(handoff.secret, "secret-1")
    XCTAssertEqual(handoff.host, "192.168.1.42")
    XCTAssertEqual(handoff.port, 8787)
    XCTAssertEqual(handoff.hostIdentity, "dev-abc123")
    XCTAssertEqual(handoff.addressCandidates, ["192.168.1.42", "100.101.102.103"])
    XCTAssertEqual(handoff.relayCandidates, ["wss://relay.ade-app.dev/connect/machinekey123"])
    // One-shot: the blob holds a secret and must not survive its first read.
    XCTAssertFalse(FileManager.default.fileExists(atPath: tempURL.path))
  }

  func testConsumeIsOneShotEvenWhenValid() throws {
    try writeBlob()
    XCTAssertNotNil(ClipPairingHandoff.consume(at: tempURL))
    XCTAssertNil(ClipPairingHandoff.consume(at: tempURL))
  }

  func testRejectsUnknownVersionButStillDeletes() throws {
    try writeBlob(version: 2)
    XCTAssertNil(ClipPairingHandoff.consume(at: tempURL))
    XCTAssertFalse(FileManager.default.fileExists(atPath: tempURL.path))
  }

  func testRejectsEmptyDeviceIdOrSecret() throws {
    try writeBlob(deviceId: "")
    XCTAssertNil(ClipPairingHandoff.consume(at: tempURL))
    try writeBlob(secret: "")
    XCTAssertNil(ClipPairingHandoff.consume(at: tempURL))
  }

  func testRejectsStaleHandoff() throws {
    let paired = Date().timeIntervalSince1970
    try writeBlob(pairedAt: paired)
    let justInside = Date(timeIntervalSince1970: paired + ClipPairingHandoff.maxAgeSeconds - 60)
    let justOutside = Date(timeIntervalSince1970: paired + ClipPairingHandoff.maxAgeSeconds + 60)
    XCTAssertNotNil(ClipPairingHandoff.consume(at: tempURL, now: justInside))
    try writeBlob(pairedAt: paired)
    XCTAssertNil(ClipPairingHandoff.consume(at: tempURL, now: justOutside))
  }

  func testRejectsMalformedJsonAndDeletes() throws {
    try Data("not json".utf8).write(to: tempURL)
    XCTAssertNil(ClipPairingHandoff.consume(at: tempURL))
    XCTAssertFalse(FileManager.default.fileExists(atPath: tempURL.path))
  }

  func testMissingFileReturnsNil() {
    XCTAssertNil(ClipPairingHandoff.consume(at: tempURL))
  }
}
