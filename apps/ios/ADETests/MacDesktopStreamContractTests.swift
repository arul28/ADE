import XCTest
@testable import ADE

/// Wire + decoder contract for the Mac Desktop live view.
///
/// The phone mirrors a stream it can only watch, so the seams that can break
/// silently are the pushed record JSON (`apps/desktop/src/shared/types/sync.ts`,
/// `macDesktop.streamRecord` / `macDesktop.streamEnded`), the Annex-B framing
/// the driver emits, and the handshake that decides whether the live picture
/// exists at all (`hello.features.macDesktopStream`).
final class MacDesktopStreamContractTests: XCTestCase {

  // MARK: - Wire decoding

  func testStreamRecordEnvelopeDecodesTheConfigRecordTheHostPushes() throws {
    let configJSON = #"{"codec":"avc1.640032","width":2560,"height":1440,"annexB":true}"#
    let payload: [String: Any] = [
      "subscriptionId": "sub-1",
      "seq": 0,
      "kind": "config",
      "keyframe": false,
      "timestampUs": 0,
      "data": Data(configJSON.utf8).base64EncodedString(),
    ]
    let envelope = try XCTUnwrap(MacDesktopStreamRecordEnvelope(payload))
    XCTAssertEqual(envelope.subscriptionId, "sub-1")
    XCTAssertEqual(envelope.seq, 0)
    XCTAssertEqual(envelope.kind, .config)
    XCTAssertFalse(envelope.keyframe)
    XCTAssertEqual(envelope.timestampUs, 0)

    let config = try JSONDecoder().decode(
      MacDesktopStreamConfig.self,
      from: Data(base64Encoded: envelope.base64Data)!)
    XCTAssertEqual(config.codec, "avc1.640032")
    XCTAssertEqual(config.width, 2560)
    XCTAssertEqual(config.height, 1440)
    XCTAssertTrue(config.annexB)
  }

  func testStreamRecordEnvelopeDecodesAFrameAndItsAnnexBBytes() throws {
    let accessUnit: [UInt8] = [0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84]
    let payload: [String: Any] = [
      "subscriptionId": "sub-1",
      "seq": 12,
      "kind": "frame",
      "keyframe": true,
      "timestampUs": 1_234_567,
      "data": Data(accessUnit).base64EncodedString(),
      "byteLength": accessUnit.count,
    ]
    let envelope = try XCTUnwrap(MacDesktopStreamRecordEnvelope(payload))
    XCTAssertEqual(envelope.kind, .frame)
    XCTAssertTrue(envelope.keyframe)
    XCTAssertEqual(envelope.timestampUs, 1_234_567)
    let record = MacDesktopStreamRecord(
      envelope: envelope,
      data: try XCTUnwrap(Data(base64Encoded: envelope.base64Data)))
    XCTAssertEqual([UInt8](record.data), accessUnit)
  }

  func testStreamRecordEnvelopeRejectsRecordsItCannotUse() {
    XCTAssertNil(MacDesktopStreamRecordEnvelope(["kind": "frame"]))
    XCTAssertNil(MacDesktopStreamRecordEnvelope([
      "subscriptionId": "s", "seq": 0, "kind": "holodeck", "data": "",
    ]))
  }

  func testStreamEndedDecodesEveryReasonIncludingTheOnesThisBuildDoesNotName() throws {
    for reason in ["unsubscribed", "stopped", "display_destroyed", "connection_closed", "error"] {
      let payload: [String: Any] = ["subscriptionId": "sub-1", "reason": reason]
      let ended = try XCTUnwrap(MacDesktopStreamEnded(payload))
      XCTAssertEqual(ended.reason, reason)
      XCTAssertNil(ended.message)
    }
    let withMessage = try XCTUnwrap(MacDesktopStreamEnded([
      "subscriptionId": "sub-1", "reason": "error", "message": "Encoder failed.",
    ]))
    XCTAssertEqual(withMessage.message, "Encoder failed.")
    // A reason a newer host invents stays readable instead of failing to decode.
    let future = try XCTUnwrap(MacDesktopStreamEnded([
      "subscriptionId": "sub-1", "reason": "some_future_reason",
    ]))
    XCTAssertEqual(future.reason, "some_future_reason")
  }

  func testSubscribeResultAndStatusDecodeTheHostPayloadsIncludingFieldsThePhoneIgnores() throws {
    let subscribe = try JSONDecoder().decode(
      MacDesktopStreamSubscribeResult.self,
      from: Data(#"{"ok":true,"width":2560,"height":1440,"codec":"avc1.640032","viewerCount":1}"#.utf8))
    XCTAssertTrue(subscribe.ok)
    XCTAssertEqual(subscribe.width, 2560)
    XCTAssertEqual(subscribe.height, 1440)
    XCTAssertEqual(subscribe.codec, "avc1.640032")

    // The redacted getStatus reply: the desktop's full status shape minus the
    // token, including every field the phone deliberately does not decode.
    let statusData = Data(#"""
    {
      "platform": "darwin",
      "supported": true,
      "unsupportedReason": null,
      "driver": { "state": "running", "title": "Driver", "message": "", "recovery": null, "version": "1" },
      "permissions": { "screenRecording": "granted", "accessibility": "granted" },
      "displayMode": "virtual",
      "display": {
        "laneId": "lane-1",
        "displayId": 7,
        "name": "ADE · fix-header",
        "mode": "virtual",
        "width": 2560,
        "height": 1440,
        "scale": 2,
        "origin": { "x": 0, "y": 0 },
        "createdAt": "2026-09-18T10:00:00.000Z",
        "windowCount": 1,
        "lastActivityAt": "2026-09-18T10:01:00.000Z"
      },
      "windows": [
        { "id": 11, "pid": 42, "appName": "Safari", "bundleId": "com.apple.Safari",
          "title": "Example", "frame": { "x": 0, "y": 0, "width": 800, "height": 600 },
          "laneId": "lane-1", "origin": "ade_launched", "onDisplayId": 7,
          "minimized": false, "singleInstance": false }
      ],
      "lease": { "laneId": "lane-1", "holder": "agent", "holderId": "chat-7",
                 "holderLabel": "Fix the header", "grantedAt": "2026-09-18T10:00:00.000Z",
                 "expiresAt": "2026-09-18T10:01:00.000Z" },
      "stream": { "running": false, "idle": true, "fps": 0, "bitrateKbps": null, "lastError": null },
      "recording": null,
      "lanes": [],
      "hostIsLocal": true
    }
    """#.utf8)
    let status = try JSONDecoder().decode(MacDesktopStatus.self, from: statusData)
    XCTAssertTrue(status.supported)
    XCTAssertEqual(status.display?.width, 2560)
    XCTAssertEqual(status.display?.mode, "virtual")
    XCTAssertEqual(status.windows?.map(\.id), [11])
    XCTAssertEqual(status.stream?.running, false)
    XCTAssertEqual(status.stream?.idle, true)
    XCTAssertEqual(macDesktopLeaseLine(status.lease), "Agent driving · Fix the header")
  }

  // MARK: - Annex-B → AVCC

  func testAnnexBConversionSplitsBothStartCodeLengthsAndLengthPrefixesEachNAL() {
    let sps: [UInt8] = [0x67, 0x42, 0x00, 0x0A, 0xF8, 0x41, 0xA2]
    let pps: [UInt8] = [0x68, 0xCE, 0x38, 0x80]
    let idr: [UInt8] = [0x65, 0x88, 0x84, 0x00, 0x21, 0xFF]
    let annexB = Data([0, 0, 0, 1] + sps + [0, 0, 1] + pps + [0, 0, 0, 1] + idr)

    let units = MacDesktopAnnexB.nalUnits(in: annexB)
    XCTAssertEqual(units, [sps, pps, idr])
    XCTAssertEqual(MacDesktopAnnexB.nalUnitType(sps), 7)
    XCTAssertEqual(MacDesktopAnnexB.nalUnitType(pps), 8)
    XCTAssertEqual(MacDesktopAnnexB.nalUnitType(idr), 5)
    XCTAssertEqual(MacDesktopAnnexB.parameterSets(in: units)?.sps, sps)
    XCTAssertEqual(MacDesktopAnnexB.parameterSets(in: units)?.pps, pps)

    // The decoder's AVCC payload keeps the parameter sets out of the access
    // unit — they travel in the format description.
    let decoderPayload = MacDesktopAnnexB.avccAccessUnit(fromAnnexB: annexB)
    XCTAssertEqual([UInt8](decoderPayload), [0, 0, 0, 6] + idr)

    // The pure framing conversion keeps every NAL, length-prefixed.
    let framed = MacDesktopAnnexB.avccAccessUnit(fromAnnexB: annexB, excludingParameterSets: false)
    XCTAssertEqual(
      [UInt8](framed),
      [0, 0, 0, 7] + sps + [0, 0, 0, 4] + pps + [0, 0, 0, 6] + idr)
  }

  func testAnnexBConversionToleratesLeadingGarbageAndEmptyStartCodeRuns() {
    let idr: [UInt8] = [0x65, 0xAA]
    let stream = Data([0xDE, 0xAD] + [0, 0, 0, 1] + [0, 0, 1] + idr)
    XCTAssertEqual(MacDesktopAnnexB.nalUnits(in: stream), [idr])
    XCTAssertEqual(MacDesktopAnnexB.avccAccessUnit(fromAnnexB: stream), Data([0, 0, 0, 2] + idr))
    XCTAssertTrue(MacDesktopAnnexB.nalUnits(in: Data([1, 2, 3])).isEmpty)
    XCTAssertTrue(MacDesktopAnnexB.avccAccessUnit(fromAnnexB: Data()).isEmpty)
  }

  // MARK: - Frame gate

  func testFrameGateHoldsPFramesUntilTheKeyframeAfterASequenceGap() {
    var gate = MacDesktopStreamFrameGate()
    // The contract says a new subscriber's first frame is a keyframe; a P-frame
    // that arrives first has nothing to reference.
    XCTAssertFalse(gate.shouldDeliver(keyframe: false, seq: 0))
    XCTAssertTrue(gate.shouldDeliver(keyframe: true, seq: 1))
    XCTAssertTrue(gate.shouldDeliver(keyframe: false, seq: 2))
    XCTAssertTrue(gate.shouldDeliver(keyframe: false, seq: 3))

    // Backpressure skipped 4 and 5: nothing may be decoded until the host's next
    // keyframe, even though P-frames keep arriving.
    XCTAssertFalse(gate.shouldDeliver(keyframe: false, seq: 6))
    XCTAssertFalse(gate.shouldDeliver(keyframe: false, seq: 7))
    XCTAssertTrue(gate.shouldDeliver(keyframe: true, seq: 8))
    XCTAssertTrue(gate.shouldDeliver(keyframe: false, seq: 9))

    // A decode failure or format change flushes the decoder; the gate then
    // waits for the next keyframe even with no gap in sequence numbers.
    gate.requireKeyframe()
    XCTAssertFalse(gate.shouldDeliver(keyframe: false, seq: 10))
    XCTAssertTrue(gate.shouldDeliver(keyframe: true, seq: 11))
  }

  // MARK: - Handshake gating

  @MainActor
  func testMacDesktopStreamFeatureFlagAndSubscribeAdvertisementBothGateTheLiveView() throws {
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "mac-host", "deviceName": "Mac Studio"],
        "features": [
          "commandRouting": ["actions": [
            Self.descriptor("macDesktop.getStatus"),
            Self.descriptor("macDesktop.streamSubscribe"),
            Self.descriptor("macDesktop.streamUnsubscribe"),
          ]] as [String: Any],
          "macDesktopStream": true,
        ] as [String: Any],
      ])
      XCTAssertTrue(service.supportsMacDesktopStream)
      XCTAssertTrue(service.supportsViewerRemoteAction("macDesktop.streamSubscribe"))
    }
  }

  @MainActor
  func testMacDesktopStreamWithoutTheFeatureBitOrTheSubscribeCommandStaysOnStills() throws {
    // The bit is the contract's support signal...
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "mac-host", "deviceName": "Mac Studio"],
        "features": [
          "commandRouting": ["actions": [
            Self.descriptor("macDesktop.streamSubscribe"),
          ]] as [String: Any],
          "macDesktopStream": false,
        ] as [String: Any],
      ])
      XCTAssertFalse(service.supportsMacDesktopStream)
    }
    // ...and the advertised command is what the phone is about to invoke. A
    // feature bit alone must not mount a live view whose first RPC the host
    // would reject.
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "mac-host", "deviceName": "Mac Studio"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("work.listSessions")]] as [String: Any],
          "macDesktopStream": true,
        ] as [String: Any],
      ])
      XCTAssertFalse(service.supportsMacDesktopStream)
    }
  }

  @MainActor
  func testUnsupportedMacDesktopStreamReadsFailLocallyInsteadOfGoingOnTheWire() async throws {
    try await withServiceAsync { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "legacy-host", "deviceName": "Old Mac"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("work.listSessions")]] as [String: Any],
        ] as [String: Any],
      ])
      XCTAssertFalse(service.supportsMacDesktopStream)

      // No transport is configured here, so a request that reached `sendCommand`
      // would fail for the wrong reason. The explicit `unsupported_action` code
      // is what proves the guard ran first.
      do {
        _ = try await service.macDesktopGetStatus(laneId: "lane-1")
        XCTFail("An unadvertised macDesktop.getStatus must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
      }
      do {
        _ = try await service.macDesktopStreamSubscribe(
          laneId: "lane-1",
          subscriptionId: "sub-1")
        XCTFail("An unadvertised macDesktop.streamSubscribe must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
      }
      do {
        try await service.macDesktopStreamUnsubscribe(subscriptionId: "sub-1")
        XCTFail("An unadvertised macDesktop.streamUnsubscribe must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
      }
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
