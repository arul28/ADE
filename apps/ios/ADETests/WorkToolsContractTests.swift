import XCTest
@testable import ADE

/// Wire + gating contract for the read-only Work tools pane.
///
/// The phone mirrors a surface it cannot drive, so the only things that can
/// break silently are the two seams it does not compile against: the JSON the
/// daemon's `workTools.*` commands emit
/// (`apps/desktop/src/shared/types/workTools.ts`), and the handshake that
/// decides whether the Tools row exists at all
/// (`apps/desktop/src/shared/syncMobileCompatibility.ts`).
final class WorkToolsContractTests: XCTestCase {

  // MARK: - Wire decoding

  func testLaneStateDecodesTheFullPayloadIncludingFieldsThePhoneIgnores() throws {
    // Byte-for-byte the shape `workToolsStateService.getLaneState` returns,
    // plus a field from a newer host. `activeToolUpdatedAt` / `capturedAt` /
    // `activeTabId` / `byteLength` are deliberately not modelled on the phone;
    // this asserts their presence cannot break the decode.
    let data = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": "browser",
      "activeToolUpdatedAt": "2026-09-07T10:00:00.000Z",
      "browser": {
        "activeTabId": "tab-2",
        "tabs": [
          {
            "id": "tab-1",
            "title": "ADE",
            "url": "https://ade-app.dev",
            "ownerChatSessionId": "chat-9",
            "recording": true,
            "active": false,
            "handoffReason": null
          },
          {
            "id": "tab-2",
            "title": null,
            "url": null,
            "ownerChatSessionId": null,
            "recording": false,
            "active": true,
            "handoffReason": "Sign in to GitHub"
          }
        ],
        "latestObservation": {
          "path": "/p/.ade/cache/browser-observations/c/tab-2/obs.png",
          "capturedAt": "2026-09-07T10:00:01.000Z",
          "caption": "GitHub · Sign in"
        }
      },
      "browserUnavailable": null,
      "appControl": {
        "appName": "Ghost",
        "status": "attached",
        "driver": "cdp",
        "latestObservation": null
      },
      "capturedAt": "2026-09-07T10:00:02.000Z",
      "somethingANewerDesktopAdded": { "enabled": true }
    }
    """#.utf8)

    let state = try JSONDecoder().decode(WorkToolsLaneState.self, from: data)

    XCTAssertEqual(state.laneId, "lane-1")
    XCTAssertEqual(state.activeTool, "browser")
    XCTAssertNil(state.browserUnavailable)
    let tabs = try XCTUnwrap(state.browser?.tabs)
    XCTAssertEqual(tabs.map(\.id), ["tab-1", "tab-2"])
    XCTAssertTrue(tabs[0].recording)
    XCTAssertFalse(tabs[0].active)
    XCTAssertNil(tabs[0].handoffReason)
    XCTAssertNil(tabs[1].title)
    XCTAssertTrue(tabs[1].active)
    // The read-only handoff line is the whole reason a stalled lane is
    // explicable from a phone; losing this field would make it look hung.
    XCTAssertEqual(tabs[1].handoffReason, "Sign in to GitHub")
    XCTAssertEqual(
      state.browser?.latestObservation?.path,
      "/p/.ade/cache/browser-observations/c/tab-2/obs.png")
    XCTAssertEqual(state.browser?.latestObservation?.caption, "GitHub · Sign in")
    XCTAssertEqual(state.appControl?.appName, "Ghost")
    XCTAssertEqual(state.appControl?.driver, "cdp")
    XCTAssertNil(state.appControl?.latestObservation)
  }

  func testLaneStateDecodesTheAbsentBrowserCaseTheDaemonEmitsMostOften() throws {
    // No desktop attached is an ordinary state, not an error: `browser` is null
    // and `browserUnavailable` carries the reason.
    let data = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": null,
      "activeToolUpdatedAt": null,
      "browser": null,
      "browserUnavailable": "desktop_not_attached",
      "appControl": null,
      "capturedAt": "2026-09-07T10:00:02.000Z"
    }
    """#.utf8)

    let state = try JSONDecoder().decode(WorkToolsLaneState.self, from: data)
    XCTAssertNil(state.activeTool)
    XCTAssertNil(state.browser)
    XCTAssertNil(state.appControl)
    XCTAssertEqual(state.browserUnavailable, "desktop_not_attached")
  }

  func testLaneStateDecodesOpenToolsAndAgentBrowserPresenceWhenPresentOrAbsent() throws {
    let populatedData = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": "browser",
      "openTools": ["terminal", "browser", "git"],
      "browser": null,
      "browserUnavailable": "browser_pane_not_opened",
      "agentBrowserPresence": [
        { "chatSessionId": "chat-7", "tabId": "tab-2" }
      ],
      "appControl": null
    }
    """#.utf8)

    let populated = try JSONDecoder().decode(WorkToolsLaneState.self, from: populatedData)
    XCTAssertEqual(populated.openTools, ["terminal", "browser", "git"])
    XCTAssertEqual(
      populated.agentBrowserPresence,
      [WorkToolsAgentBrowserPresence(chatSessionId: "chat-7", tabId: "tab-2")]
    )

    let legacyData = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": null,
      "browser": null,
      "browserUnavailable": "desktop_not_attached",
      "appControl": null
    }
    """#.utf8)

    let legacy = try JSONDecoder().decode(WorkToolsLaneState.self, from: legacyData)
    XCTAssertNil(legacy.openTools)
    XCTAssertNil(legacy.agentBrowserPresence)
  }

  func testObservationPreviewDecodesWithoutTheByteLengthThePhoneIgnores() throws {
    let data = Data(#"""
    { "dataUrl": "data:image/png;base64,AAAA", "mimeType": "image/png", "byteLength": 3 }
    """#.utf8)
    let preview = try JSONDecoder().decode(WorkToolsObservationPreview.self, from: data)
    XCTAssertEqual(preview.mimeType, "image/png")
    XCTAssertTrue(preview.dataUrl.hasPrefix("data:image/png;base64,"))
  }

  // MARK: - Unavailable reasons

  func testEveryUnavailableReasonHasItsOwnSentenceAndUnknownOnesFallBack() {
    // These five strings are `WorkToolsUnavailableReason` in
    // apps/desktop/src/shared/types/workTools.ts, and the sentences must stay
    // byte-identical to `workToolsUnavailableMessage` there — the Swift switch
    // cannot import it, so only this test holds the two wordings together.
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("desktop_not_attached"),
      "The browser runs in ADE Desktop. Open ADE on your Mac to see its tabs.")
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("desktop_not_attached_for_project"),
      "ADE Desktop doesn't have this project open. Open it on your Mac to see its tabs.")
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("browser_pane_not_opened"),
      "Open the Browser tool on the desktop to see tabs here.")
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("unsupported"),
      "The browser isn't available on this machine.")
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("error"),
      "Couldn't read the browser's state.")

    // The three narrow reasons must not collapse into the default: each one
    // sends the user somewhere different.
    let distinct = Set([
      workToolsBrowserUnavailableMessage("desktop_not_attached"),
      workToolsBrowserUnavailableMessage("desktop_not_attached_for_project"),
      workToolsBrowserUnavailableMessage("browser_pane_not_opened"),
      workToolsBrowserUnavailableMessage("unsupported"),
      workToolsBrowserUnavailableMessage("error"),
    ])
    XCTAssertEqual(distinct.count, 5)

    // A reason a newer desktop invents, and an absent one, both degrade to the
    // common case rather than rendering nothing or inventing a diagnosis.
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("some_future_reason"),
      workToolsBrowserUnavailableMessage("desktop_not_attached"))
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage(nil),
      workToolsBrowserUnavailableMessage("desktop_not_attached"))
  }

  func testToolNamesCoverEveryDesktopToolIdAndPassUnknownOnesThrough() {
    // Mirrors WORK_TOOL_IDS in apps/desktop/src/shared/types/workTools.ts.
    XCTAssertEqual(workToolsDisplayName("terminal"), "Terminal")
    XCTAssertEqual(workToolsDisplayName("git"), "Git")
    XCTAssertEqual(workToolsDisplayName("files"), "Files")
    XCTAssertEqual(workToolsDisplayName("ios"), "Simulator")
    XCTAssertEqual(workToolsDisplayName("app-control"), "App Control")
    XCTAssertEqual(workToolsDisplayName("browser"), "Browser")
    // A tool this build has no name for still reads as *something*: dropping it
    // would tell the user no tool is open when one is.
    XCTAssertEqual(workToolsDisplayName("holodeck"), "holodeck")
    XCTAssertNil(workToolsDisplayName(nil))
    XCTAssertNil(workToolsDisplayName(""))
  }

  func testMalformedFramePayloadsProduceNoImageRatherThanACrash() {
    XCTAssertNil(WorkToolsSheet.decodeDataUrl("https://example.com/shot.png"))
    XCTAssertNil(WorkToolsSheet.decodeDataUrl("data:image/png;base64"))
    XCTAssertNil(WorkToolsSheet.decodeDataUrl(""))
    XCTAssertNotNil(WorkToolsSheet.decodeDataUrl("data:image/png;base64,QUJD"))
  }

  // MARK: - Handshake gating

  @MainActor
  func testLegacyHostWithoutMobileCompatibilityConnectsAndSimplyHidesTheToolsRow() throws {
    // The oldest brain shape the phone still has to talk to: a command list
    // with none of the workTools actions and no `mobileCompatibility` block at
    // all. It must connect — a missing compatibility report is not a handshake
    // failure — and the Tools row must gate itself off rather than poll an
    // action the host never advertised.
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "legacy-host", "deviceName": "Old Mac"],
        "features": [
          "commandRouting": ["actions": [
            Self.descriptor("work.listSessions"),
            Self.descriptor("chat.listSessions"),
          ]] as [String: Any],
        ] as [String: Any],
      ])

      XCTAssertEqual(service.connectionState, .connected)
      XCTAssertEqual(service.hostCompatibilityMode, .limited)
      XCTAssertEqual(service.hostCompatibilityMissingActions, ["mobileCompatibility"])
      XCTAssertFalse(service.supportsWorkToolsState)
      XCTAssertFalse(service.supportsWorkToolsObservationPreview)
    }
  }

  @MainActor
  func testUnsupportedWorkToolsReadsFailLocallyInsteadOfGoingOnTheWire() async throws {
    try await withServiceAsync { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "legacy-host", "deviceName": "Old Mac"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("work.listSessions")]] as [String: Any],
        ] as [String: Any],
      ])
      XCTAssertFalse(service.supportsWorkToolsState)

      // Gated locally: no transport is configured here, so a request that
      // reached `sendCommand` would fail for the wrong reason. The explicit
      // `unsupported_action` code is what proves the guard ran first.
      do {
        _ = try await service.fetchWorkToolsLaneState(laneId: "lane-1")
        XCTFail("An unadvertised workTools.getLaneState must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
      }
      do {
        _ = try await service.readWorkToolsObservationPreview(path: "/tmp/a.png")
        XCTFail("An unadvertised workTools.readObservationPreview must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
      }
    }
  }

  @MainActor
  func testHostAdvertisingWorkToolsOptionallyStaysFullyCompatible() throws {
    // `workTools.*` are OPTIONAL actions in syncMobileCompatibility.ts, so a
    // host that reports `full` while advertising them must stay `full` — an
    // additive read-only pane must never flip a phone into limited mode.
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "new-host", "deviceName": "Mac Studio"],
        "features": [
          "commandRouting": ["actions": [
            Self.descriptor("work.listSessions"),
            Self.descriptor("workTools.getLaneState"),
            Self.descriptor("workTools.readObservationPreview"),
          ]] as [String: Any],
          "mobileCompatibility": ["mode": "full", "missingActions": [String]()] as [String: Any],
        ] as [String: Any],
      ])

      XCTAssertEqual(service.hostCompatibilityMode, .full)
      XCTAssertTrue(service.hostCompatibilityMissingActions.isEmpty)
      XCTAssertTrue(service.supportsWorkToolsState)
      XCTAssertTrue(service.supportsWorkToolsObservationPreview)
      // Read-only everywhere: a viewer device sees the pane like anyone else.
      XCTAssertTrue(service.supportsViewerRemoteAction("workTools.getLaneState"))
    }
  }

  @MainActor
  func testStateActionAloneDoesNotUnlockFrameFetching() throws {
    // The two commands are registered together today, but the sheet fetches
    // bytes on a 3s timer — so it feature-detects the preview separately rather
    // than inferring it from the state read.
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "partial-host", "deviceName": "Mac"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("workTools.getLaneState")]] as [String: Any],
          "mobileCompatibility": ["mode": "full", "missingActions": [String]()] as [String: Any],
        ] as [String: Any],
      ])
      XCTAssertTrue(service.supportsWorkToolsState)
      XCTAssertFalse(service.supportsWorkToolsObservationPreview)
    }
  }

  // MARK: - Helpers

  private static func descriptor(_ action: String) -> [String: Any] {
    ["action": action, "policy": ["viewerAllowed": true] as [String: Any]]
  }

  @MainActor
  private func withService(_ body: (SyncService) throws -> Void) throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    try body(service)
  }

  @MainActor
  private func withServiceAsync(_ body: (SyncService) async throws -> Void) async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    try await body(service)
  }
}
