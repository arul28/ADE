import CoreMedia
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
    XCTAssertEqual(status.display?.origin, MacDesktopPoint(x: 0, y: 0))
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

  // MARK: - Takeover

  func testLetterboxMapsTheCenterOfThePictureAndDropsTheBars() {
    let display = MacDesktopDisplayGeometry(width: 2560, height: 1440, originX: 8000, originY: 0)
    let view = MacDesktopViewRect(width: 1000, height: 1000)
    // 2560×1440 fitted into 1000×1000 is 1000×562.5, centered. The middle of
    // the view is the middle of the picture: (1280, 720) plus the origin.
    let center = MacDesktopGeometry.displayPoint(localX: 500, localY: 500, view: view, display: display)
    XCTAssertEqual(center?.x ?? -1, 8000 + 1280, accuracy: 0.01)
    XCTAssertEqual(center?.y ?? -1, 720, accuracy: 0.01)
    // The top of the view is letterbox, not the top of the screen.
    XCTAssertNil(MacDesktopGeometry.displayPoint(localX: 500, localY: 10, view: view, display: display))
    XCTAssertNil(MacDesktopGeometry.displayPoint(
      localX: 10, localY: 10,
      view: MacDesktopViewRect(width: 0, height: 0),
      display: display
    ))
  }

  func testAShortPressIsAClickAndATravelledOneIsADrag() {
    let start = MacDesktopPoint(x: 10, y: 10)
    let nearby = MacDesktopPoint(x: 12, y: 11)
    let far = MacDesktopPoint(x: 40, y: 10)
    XCTAssertEqual(MacDesktopControlGesture.ended(from: start, to: nearby), .click(nearby))
    XCTAssertEqual(MacDesktopControlGesture.ended(from: start, to: far), .drag(from: start, to: far))
    XCTAssertEqual(MacDesktopControlGesture.ended(from: nil, to: far), .click(far))
  }

  func testReleaseOmitsTheViewersOwnScreenPoint() {
    let call = MacDesktopControlWire.call(
      laneId: "lane-1",
      controllerId: "tab-1",
      event: .release(button: "left")
    )
    XCTAssertEqual(call["kind"] as? String, "releaseInput")
    let args = call["args"] as? [String: Any]
    XCTAssertEqual(args?["laneId"] as? String, "lane-1")
    XCTAssertEqual(args?["controllerId"] as? String, "tab-1")
    XCTAssertEqual(args?["button"] as? String, "left")
    XCTAssertNil(args?["homeX"])
    XCTAssertNil(args?["homeY"])
    XCTAssertNil(args?["home"])
  }

  @MainActor
  func testMacDesktopControlRequiresTheFeatureBitAndEveryCommand() throws {
    let actions = [
      "macDesktop.takeControl", "macDesktop.returnControl",
      "macDesktop.renewLease", "macDesktop.input",
    ]
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "mac-host", "deviceName": "Mac Studio"],
        "features": [
          "commandRouting": ["actions": actions.map(Self.controllerDescriptor)] as [String: Any],
          "macDesktopControl": true,
        ] as [String: Any],
      ])
      XCTAssertTrue(service.supportsMacDesktopControl)
    }
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "mac-host", "deviceName": "Mac Studio"],
        "features": [
          "commandRouting": ["actions": actions.map(Self.controllerDescriptor)] as [String: Any],
          "macDesktopControl": false,
        ] as [String: Any],
      ])
      XCTAssertFalse(service.supportsMacDesktopControl)
    }
    try withService { service in
      // Take without input would show a button that cannot click.
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "mac-host", "deviceName": "Mac Studio"],
        "features": [
          "commandRouting": ["actions": [Self.controllerDescriptor("macDesktop.takeControl")]] as [String: Any],
          "macDesktopControl": true,
        ] as [String: Any],
      ])
      XCTAssertFalse(service.supportsMacDesktopControl)
    }
  }

  @MainActor
  func testUnadvertisedMacDesktopControlFailsLocallyInsteadOfGoingOnTheWire() async throws {
    try await withServiceAsync { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "legacy-host", "deviceName": "Old Mac"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("work.listSessions")]] as [String: Any],
        ] as [String: Any],
      ])
      do {
        _ = try await service.macDesktopTakeControl(laneId: "lane-1", controllerId: "tab", controllerLabel: "iPhone")
        XCTFail("An unadvertised takeover must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
      }
      do {
        try await service.macDesktopInput(laneId: "lane-1", call: ["kind": "click"])
        XCTFail("An unadvertised click must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
      }
    }
  }

  private static func controllerDescriptor(_ action: String) -> [String: Any] {
    [
      "action": action,
      "policy": ["viewerAllowed": false, "controllerAllowed": true] as [String: Any],
    ]
  }

  // MARK: - Sample attachments

  func testSampleAttachmentsPresentImmediatelyAndMarkDeltaFramesNotSync() throws {
    // A keyframe needs DisplayImmediately — this stream has no control
    // timebase, so without it the layer holds every frame forever — and no
    // NotSync, because an absent key means sync.
    let keyframeBuffer = try makeSyntheticSample()
    MacDesktopSampleAttachments.apply(to: keyframeBuffer, keyframe: true)
    let keyframeAttachments = try XCTUnwrap(attachmentDictionary(of: keyframeBuffer))
    XCTAssertTrue(attachmentFlag(keyframeAttachments, kCMSampleAttachmentKey_DisplayImmediately as CFString))
    XCTAssertFalse(attachmentFlag(keyframeAttachments, kCMSampleAttachmentKey_NotSync as CFString))

    // A P-frame is a delta frame: the layer must not treat it as a sync sample.
    let deltaBuffer = try makeSyntheticSample()
    MacDesktopSampleAttachments.apply(to: deltaBuffer, keyframe: false)
    let deltaAttachments = try XCTUnwrap(attachmentDictionary(of: deltaBuffer))
    XCTAssertTrue(attachmentFlag(deltaAttachments, kCMSampleAttachmentKey_DisplayImmediately as CFString))
    XCTAssertTrue(attachmentFlag(deltaAttachments, kCMSampleAttachmentKey_NotSync as CFString))
  }

  // MARK: - Serial decode

  @MainActor
  func testDecodeQueueKeepsOneSubscriptionInArrivalOrderWithoutBlockingOthers() async throws {
    let queue = MacDesktopStreamDecodeQueue()
    let probe = DecodeOrderProbe()
    let release = DispatchSemaphore(value: 0)
    let firstStarted = expectation(description: "first decode started")

    let first = queue.decode(subscriptionId: "sub-1") {
      await probe.append(0)
      firstStarted.fulfill()
      release.wait()
      return nil
    }
    await fulfillment(of: [firstStarted], timeout: 5)

    // The second record for the same subscription must wait; a record for
    // another subscription must not.
    let second = queue.decode(subscriptionId: "sub-1") {
      await probe.append(1)
      return nil
    }
    let other = queue.decode(subscriptionId: "sub-2") {
      await probe.append(2)
      return nil
    }
    await other.value
    for _ in 0..<20 {
      await Task.yield()
    }
    let blocked = await probe.values()
    XCTAssertEqual(blocked, [0, 2])

    release.signal()
    await first.value
    await second.value
    let delivered = await probe.values()
    XCTAssertEqual(delivered, [0, 2, 1])
  }

  // MARK: - Viewer label

  @MainActor
  func testViewerLabelIsGenericRatherThanTheDeviceName() {
    let label = MacDesktopLiveSession.defaultViewerLabel()
    XCTAssertTrue(["iPhone", "iPad"].contains(label))
    // The device's own name is user-identifying; only the form factor travels.
    XCTAssertNotEqual(label, UIDevice.current.name)
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

  /// One synthetic H.264 sample, built the way `MacDesktopLiveSession.enqueue`
  /// builds one, so the attachment assertions exercise the real object.
  private func makeSyntheticSample() throws -> CMSampleBuffer {
    let sps: [UInt8] = [0x67, 0x42, 0x00, 0x0A, 0xF8, 0x41, 0xA2]
    let pps: [UInt8] = [0x68, 0xCE, 0x38, 0x80]
    let format = try XCTUnwrap(MacDesktopAnnexB.formatDescription(sps: sps, pps: pps))
    let accessUnit = Data([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84])

    var blockBuffer: CMBlockBuffer?
    XCTAssertEqual(
      CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault,
        memoryBlock: nil,
        blockLength: accessUnit.count,
        blockAllocator: kCFAllocatorDefault,
        customBlockSource: nil,
        offsetToData: 0,
        dataLength: accessUnit.count,
        flags: 0,
        blockBufferOut: &blockBuffer
      ),
      kCMBlockBufferNoErr
    )
    let block = try XCTUnwrap(blockBuffer)
    let copyStatus = accessUnit.withUnsafeBytes { raw -> OSStatus in
      guard let base = raw.baseAddress else { return -1 }
      return CMBlockBufferReplaceDataBytes(
        with: base,
        blockBuffer: block,
        offsetIntoDestination: 0,
        dataLength: accessUnit.count
      )
    }
    XCTAssertEqual(copyStatus, kCMBlockBufferNoErr)

    var sampleBuffer: CMSampleBuffer?
    var timing = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: CMTime(value: 0, timescale: 1_000_000),
      decodeTimeStamp: .invalid
    )
    var sampleSize = accessUnit.count
    XCTAssertEqual(
      CMSampleBufferCreateReady(
        allocator: kCFAllocatorDefault,
        dataBuffer: block,
        formatDescription: format,
        sampleCount: 1,
        sampleTimingEntryCount: 1,
        sampleTimingArray: &timing,
        sampleSizeEntryCount: 1,
        sampleSizeArray: &sampleSize,
        sampleBufferOut: &sampleBuffer
      ),
      noErr
    )
    return try XCTUnwrap(sampleBuffer)
  }

  /// The per-sample dictionary the display layer reads, not the buffer-level
  /// attachment dictionary `CMSetAttachment` writes.
  private func attachmentDictionary(of sampleBuffer: CMSampleBuffer) -> CFDictionary? {
    guard
      let array = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false),
      CFArrayGetCount(array) > 0
    else { return nil }
    return unsafeBitCast(CFArrayGetValueAtIndex(array, 0), to: CFDictionary.self)
  }

  private func attachmentFlag(_ dictionary: CFDictionary, _ key: CFString) -> Bool {
    guard let raw = CFDictionaryGetValue(dictionary, Unmanaged.passUnretained(key).toOpaque()) else {
      return false
    }
    let value = Unmanaged<CFBoolean>.fromOpaque(raw).takeUnretainedValue()
    return CFBooleanGetValue(value)
  }
}

/// Records the order detached decodes actually completed in.
private actor DecodeOrderProbe {
  private var entries: [Int] = []

  func append(_ value: Int) {
    entries.append(value)
  }

  func values() -> [Int] {
    entries
  }
}
