import XCTest
@testable import ADE

/// The chunked file/video attachment route is five brand-new host actions.
/// A phone carrying this build will spend most of its life talking to brains
/// that have never heard of them, so the contract these tests pin is:
///
/// 1. the composer decides availability from the host's advertised actions
///    BEFORE the picker opens — not after the user has waited on a 40 MB video;
/// 2. a host that cannot serve the route is explained ("update your computer"),
///    not silently broken;
/// 3. `SyncService` still refuses the call locally if a caller gets past the UI.
final class WorkComposerFileAttachmentGateTests: XCTestCase {
  private let connectionDefaultsKeys = [
    "ade.sync.hostProfile",
    "ade.sync.hostProfiles",
    "ade.sync.connectionDraft",
    "ade.sync.autoReconnectPausedByUser",
    "ade.sync.activeProjectHostIdentity",
    "ade.sync.remoteCommandDescriptors",
  ]

  private func snapshotDefaults(keys: [String]) -> [String: Any] {
    keys.reduce(into: [String: Any]()) { snapshot, key in
      if let value = UserDefaults.standard.object(forKey: key) {
        snapshot[key] = value
      }
    }
  }

  private func restoreDefaults(_ snapshot: [String: Any], keys: [String]) {
    for key in keys {
      UserDefaults.standard.removeObject(forKey: key)
      if let value = snapshot[key] {
        UserDefaults.standard.set(value, forKey: key)
      }
    }
  }

  // MARK: - The gate itself

  func testHostWithTheChunkedRouteOffersFilesAndVideos() {
    XCTAssertEqual(
      workChatFileAttachmentAvailability(hostSupportsChunkedUpload: true, isPersonalChat: false),
      .available
    )
  }

  func testOlderHostIsExplainedRatherThanSilentlyBroken() {
    let availability = workChatFileAttachmentAvailability(
      hostSupportsChunkedUpload: false,
      isPersonalChat: false
    )
    XCTAssertEqual(availability, .unsupportedHost)
    XCTAssertFalse(availability.isAvailable)
    XCTAssertEqual(
      availability.menuHint,
      "Update ADE on your computer to attach files and videos.",
      "An out-of-date brain must say what to do about it, in the menu, before a picker opens."
    )
  }

  func testPersonalChatsStayImagesOnlyEvenOnAnUpToDateHost() {
    let availability = workChatFileAttachmentAvailability(
      hostSupportsChunkedUpload: true,
      isPersonalChat: true
    )
    XCTAssertEqual(
      availability,
      .imagesOnly,
      "The images-only rule belongs to the chat, so no host version turns it off."
    )
    XCTAssertNil(
      availability.menuHint,
      "The file routes are hidden on a personal chat; a hint about an absent control is noise."
    )
  }

  // MARK: - Host advertisement -> gate

  /// The gate reads exactly one action name. If that name drifts from the one
  /// `SyncService.saveChatFileAttachment` requires, the UI would offer a route
  /// the service refuses.
  func testGateActionMatchesTheActionTheUploadRequires() {
    XCTAssertEqual(workChatFileAttachmentHostAction, "chat.beginTempFileAttachment")
  }

  @MainActor
  func testLegacyHostNeitherAdvertisesNorAcceptsTheChunkedRoute() async throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.configureConnectedTransportForTesting()
    defer {
      service.disconnect(clearCredentials: false)
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    // A brain that stages images the old way and knows nothing of the chunked
    // ladder — and, like every pre-compatibility host, omits the block entirely.
    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "legacy-host", "deviceName": "Mac Studio"],
      "features": [
        "commandRouting": [
          "actions": [
            ["action": "chat.saveTempAttachment", "policy": ["viewerAllowed": true]],
          ],
        ],
      ],
    ])

    XCTAssertEqual(
      service.hostCompatibilityMode,
      .limited,
      "A missing mobileCompatibility block degrades the session; it must not fail the handshake."
    )
    XCTAssertTrue(
      service.supportsViewerRemoteAction("chat.saveTempAttachment"),
      "Image attachment stays available on an older host — the fallback is the whole point."
    )
    XCTAssertEqual(
      workChatFileAttachmentAvailability(
        hostSupportsChunkedUpload: service.supportsViewerRemoteAction(
          workChatFileAttachmentHostAction
        ),
        isPersonalChat: false
      ),
      .unsupportedHost
    )

    // Defence in depth: even if a caller bypasses the menu, the service refuses
    // locally rather than queueing or sending an action the host cannot route.
    do {
      _ = try await service.saveChatFileAttachment(
        data: Data("pretend this is a video".utf8),
        filename: "clip.mov",
        chatSessionId: nil
      )
      XCTFail("An unadvertised chunked upload must be refused before any send.")
    } catch {
      XCTAssertTrue(
        (error as NSError).domain == "ADE",
        "The refusal should be the local capability error, not a transport failure."
      )
    }
  }

  @MainActor
  func testUpToDateHostAdvertisesTheChunkedRouteToTheComposer() throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.configureConnectedTransportForTesting()
    defer {
      service.disconnect(clearCredentials: false)
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "current-host", "deviceName": "Mac Studio"],
      "features": [
        "mobileCompatibility": ["mode": "full", "missingActions": [String]()],
        "commandRouting": [
          "actions": [
            ["action": "chat.saveTempAttachment", "policy": ["viewerAllowed": true]],
            ["action": "chat.beginTempFileAttachment", "policy": ["viewerAllowed": true]],
            ["action": "chat.appendTempFileAttachmentChunk", "policy": ["viewerAllowed": true]],
            ["action": "chat.finishTempFileAttachment", "policy": ["viewerAllowed": true]],
            ["action": "chat.abortTempFileAttachment", "policy": ["viewerAllowed": true]],
            ["action": "chat.getAttachmentChunk", "policy": ["viewerAllowed": true]],
          ],
        ],
      ],
    ])

    XCTAssertEqual(service.hostCompatibilityMode, .full)
    for action in [
      "chat.beginTempFileAttachment",
      "chat.appendTempFileAttachmentChunk",
      "chat.finishTempFileAttachment",
      "chat.abortTempFileAttachment",
      "chat.getAttachmentChunk",
    ] {
      XCTAssertTrue(
        service.supportsViewerRemoteAction(action),
        "\(action) must survive the hello decode, or the upload ladder breaks mid-file."
      )
    }
    XCTAssertEqual(
      workChatFileAttachmentAvailability(
        hostSupportsChunkedUpload: service.supportsViewerRemoteAction(
          workChatFileAttachmentHostAction
        ),
        isPersonalChat: false
      ),
      .available
    )
  }
}
