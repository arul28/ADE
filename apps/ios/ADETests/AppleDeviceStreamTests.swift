import XCTest
@testable import ADE

/// Wire + health contract for the phone's view-only Apple device viewer.
///
/// Two seams the phone does not compile against, and one it cannot observe:
///
/// - The binary record framing, whose authority is
///   `apps/desktop/src/shared/types/iosSimulator.ts` and the sim helper's
///   `VideoRecord.swift`. If this parser drifts, the viewer shows a black
///   rectangle with no error anywhere.
/// - The `apple.status` / `apple.streamTicket` JSON, which ships on the Mac's
///   cadence, so every field must survive being absent, null, or new.
/// - The two health timeouts. A stall is not reproducible on demand, so the
///   clock is a pure value that gets tested rather than watched.
///
/// No network, no simulator, no AVFoundation: everything here is a value.
final class AppleDeviceStreamTests: XCTestCase {

  // MARK: - Record framing

  private func record(type: UInt8, payload: Data, keyframe: Bool = false) -> Data {
    var out = Data()
    var magic = AppleStreamRecordParser.magic.bigEndian
    withUnsafeBytes(of: &magic) { out.append(contentsOf: $0) }
    out.append(type)
    out.append(keyframe ? AppleStreamRecordParser.flagKeyframe : 0)
    out.append(0)
    out.append(0)
    var length = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
    out.append(payload)
    return out
  }

  private func configPayload(codec: String = "avc1.42E01E", width: Int? = 390, height: Int? = 844, annexB: Bool? = nil) -> Data {
    var object: [String: Any] = ["codec": codec]
    if let width { object["width"] = width }
    if let height { object["height"] = height }
    if let annexB { object["annexB"] = annexB }
    return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  // MARK: - Ticket refusals

  func testAnOffDeviceReadsAsOffOnTheMacNotAsTheWireCode() {
    XCTAssertEqual(
      appleStreamTicketFailureMessage("APPLE_DEVICE_OFF: iPhone 17 Pro is off. Watching a device never boots it."),
      "iPhone 17 Pro is off on your Mac. Start it in ADE on the Mac to watch it here."
    )
    XCTAssertEqual(
      appleStreamTicketFailureMessage("APPLE_DEVICE_OFF"),
      "The simulator is off on your Mac. Start it in ADE on the Mac to watch it here."
    )
    XCTAssertEqual(appleStreamTicketFailureMessage("Something else broke."), "Something else broke.")
  }

  func testParsesAConfigThenAKeyframeFromOneChunk() throws {
    var parser = AppleStreamRecordParser()
    let payload = Data([0, 0, 0, 1, 0x67, 0x42])
    let chunk = record(type: AppleStreamRecordParser.typeConfig, payload: configPayload())
      + record(type: AppleStreamRecordParser.typeAccessUnit, payload: payload, keyframe: true)

    let records = try parser.push(chunk)

    XCTAssertEqual(records.count, 2)
    XCTAssertEqual(records[0], .config(codec: "avc1.42E01E", width: 390, height: 844, annexB: true))
    XCTAssertEqual(records[1], .accessUnit(keyframe: true, bytes: payload))
    XCTAssertEqual(parser.pendingBytes, 0)
  }

  func testReassemblesARecordSplitAcrossChunksIncludingMidHeader() throws {
    // The brain pipes the helper's stream through; it is free to coalesce or
    // split records at any byte, so a header cut in half must not desync the
    // reader or throw.
    var parser = AppleStreamRecordParser()
    let payload = Data(repeating: 0xAB, count: 300)
    let whole = record(type: AppleStreamRecordParser.typeAccessUnit, payload: payload, keyframe: true)

    XCTAssertTrue(try parser.push(whole.prefix(5)).isEmpty)
    XCTAssertTrue(try parser.push(whole.dropFirst(5).prefix(20)).isEmpty)
    let records = try parser.push(whole.dropFirst(25))

    XCTAssertEqual(records, [.accessUnit(keyframe: true, bytes: payload)])
    XCTAssertEqual(parser.pendingBytes, 0)
  }

  func testAPartialTrailingRecordIsHeldNotDropped() throws {
    var parser = AppleStreamRecordParser()
    let first = record(type: AppleStreamRecordParser.typeAccessUnit, payload: Data([1, 2, 3]))
    let second = record(type: AppleStreamRecordParser.typeAccessUnit, payload: Data([4, 5, 6, 7]))

    let records = try parser.push(first + second.prefix(8))
    XCTAssertEqual(records, [.accessUnit(keyframe: false, bytes: Data([1, 2, 3]))])
    XCTAssertEqual(parser.pendingBytes, 8)

    XCTAssertEqual(
      try parser.push(second.dropFirst(8)),
      [.accessUnit(keyframe: false, bytes: Data([4, 5, 6, 7]))]
    )
  }

  func testAnUnknownRecordTypeIsSkippedByItsLengthRatherThanTreatedAsCorruption() throws {
    // A newer Mac adding a record type must not break a shipped phone: it is
    // skipped by its declared length and the stream stays in sync.
    var parser = AppleStreamRecordParser()
    let chunk = record(type: 9, payload: Data(repeating: 7, count: 12))
      + record(type: AppleStreamRecordParser.typeAccessUnit, payload: Data([9, 9]))

    XCTAssertEqual(try parser.push(chunk), [.accessUnit(keyframe: false, bytes: Data([9, 9]))])
  }

  func testAWrongMagicIsRejectedRatherThanResynchronised() throws {
    var parser = AppleStreamRecordParser()
    var bad = record(type: AppleStreamRecordParser.typeAccessUnit, payload: Data([1]))
    bad[bad.startIndex] = 0x00

    XCTAssertThrowsError(try parser.push(bad)) { error in
      XCTAssertTrue(error is AppleStreamProtocolError)
    }
  }

  func testAnOversizedDeclaredLengthIsRefusedBeforeAllocating() throws {
    var parser = AppleStreamRecordParser()
    var header = record(type: AppleStreamRecordParser.typeAccessUnit, payload: Data())
    let lengthOffset = header.startIndex + 8
    var huge = UInt32(AppleStreamRecordParser.maxRecordBytes + 1).bigEndian
    withUnsafeBytes(of: &huge) { bytes in
      for (index, byte) in bytes.enumerated() { header[lengthOffset + index] = byte }
    }

    XCTAssertThrowsError(try parser.push(header))
  }

  func testAConfigWithoutACodecIsAProtocolError() throws {
    var parser = AppleStreamRecordParser()
    let payload = try! JSONSerialization.data(withJSONObject: ["width": 100])
    XCTAssertThrowsError(try parser.push(record(type: AppleStreamRecordParser.typeConfig, payload: payload)))
  }

  func testConfigAnnexBDefaultsToTrueAndIsHonouredWhenFalse() throws {
    var parser = AppleStreamRecordParser()
    // The helper only ever writes Annex-B and may omit the flag; an explicit
    // false is the one case the viewer must refuse, because a decoder built
    // from inline SPS/PPS configures cleanly on AVCC and then shows nothing.
    XCTAssertEqual(
      try parser.push(record(type: AppleStreamRecordParser.typeConfig, payload: configPayload(width: nil, height: nil))),
      [.config(codec: "avc1.42E01E", width: nil, height: nil, annexB: true)]
    )
    XCTAssertEqual(
      try parser.push(record(type: AppleStreamRecordParser.typeConfig, payload: configPayload(annexB: false))),
      [.config(codec: "avc1.42E01E", width: 390, height: 844, annexB: false)]
    )
  }

  func testResetDropsAHalfReadRecord() throws {
    var parser = AppleStreamRecordParser()
    _ = try parser.push(record(type: AppleStreamRecordParser.typeAccessUnit, payload: Data([1, 2, 3])).prefix(9))
    XCTAssertEqual(parser.pendingBytes, 9)
    parser.reset()
    XCTAssertEqual(parser.pendingBytes, 0)
  }

  // MARK: - Annex-B

  func testSplitsNalUnitsOnBothStartCodeLengths() {
    let data = Data([0, 0, 0, 1, 0x67, 0xAA] + [0, 0, 1, 0x68, 0xBB] + [0, 0, 0, 1, 0x65, 0xCC, 0xDD])
    let units = AppleAnnexB.nalUnits(in: data)

    XCTAssertEqual(units.count, 3)
    XCTAssertEqual(AppleAnnexB.nalType(of: units[0]), AppleAnnexB.nalTypeSps)
    XCTAssertEqual(AppleAnnexB.nalType(of: units[1]), AppleAnnexB.nalTypePps)
    XCTAssertEqual(AppleAnnexB.nalType(of: units[2]), AppleAnnexB.nalTypeIdr)
    XCTAssertEqual(units[2], Data([0x65, 0xCC, 0xDD]))
  }

  func testAvccSampleDropsParameterSetsAndLengthPrefixesTheRest() throws {
    // SPS/PPS live in the format description, not in the sample; leaving them
    // in is how a stream decodes to nothing on some devices and fine on others.
    let units = [Data([0x67, 0xAA]), Data([0x68, 0xBB]), Data([0x65, 0xCC, 0xDD])]
    let sample = try XCTUnwrap(AppleAnnexB.avccSample(from: units))

    XCTAssertEqual(sample, Data([0, 0, 0, 3, 0x65, 0xCC, 0xDD]))
  }

  func testAvccSampleOfParameterSetsOnlyIsNil() {
    XCTAssertNil(AppleAnnexB.avccSample(from: [Data([0x67, 0xAA]), Data([0x68, 0xBB])]))
  }

  // MARK: - Health state machine

  func testFirstFrameTimeoutStallsAConnectionThatNeverShowsAPicture() {
    let opened = Date()
    var health = AppleStreamHealth()
    health.requestTicket()
    health.connecting()
    health.socketOpened(at: opened)

    XCTAssertEqual(health.phase, .connecting)
    health.tick(now: opened.addingTimeInterval(AppleStreamHealth.firstFrameTimeout - 0.1))
    XCTAssertEqual(health.phase, .connecting)

    health.tick(now: opened.addingTimeInterval(AppleStreamHealth.firstFrameTimeout))
    XCTAssertEqual(health.phase, .stalled)
    // Distinguished from a stream that ran and stopped: this one never started.
    XCTAssertEqual(health.statusMessage, "No frames arrived.")
    XCTAssertTrue(health.offersReconnect)
  }

  func testFrameWatchdogStallsAStreamThatStops() {
    let start = Date()
    var health = AppleStreamHealth()
    health.connecting()
    health.socketOpened(at: start)
    health.frameDecoded(at: start.addingTimeInterval(0.2))

    XCTAssertEqual(health.phase, .streaming)
    health.tick(now: start.addingTimeInterval(0.2 + AppleStreamHealth.frameWatchdog - 0.1))
    XCTAssertEqual(health.phase, .streaming)

    health.tick(now: start.addingTimeInterval(0.2 + AppleStreamHealth.frameWatchdog))
    XCTAssertEqual(health.phase, .stalled)
    XCTAssertEqual(health.statusMessage, "The stream stopped sending frames.")
  }

  func testFramesKeepResettingTheWatchdog() {
    let start = Date()
    var health = AppleStreamHealth()
    health.connecting()
    health.socketOpened(at: start)
    for step in 1...10 {
      let now = start.addingTimeInterval(Double(step) * 2)
      health.frameDecoded(at: now)
      health.tick(now: now.addingTimeInterval(1))
      XCTAssertEqual(health.phase, .streaming, "A 2s frame gap is inside the 3s watchdog")
    }
  }

  func testTickIsIdempotentInTerminalPhases() {
    var health = AppleStreamHealth()
    health.fail("The Mac closed the stream.")
    health.tick(now: Date().addingTimeInterval(600))
    XCTAssertEqual(health.phase, .failed("The Mac closed the stream."))
    XCTAssertEqual(health.statusMessage, "The Mac closed the stream.")

    var unsupported = AppleStreamHealth()
    unsupported.markUnsupported()
    unsupported.tick(now: Date().addingTimeInterval(600))
    XCTAssertEqual(unsupported.phase, .unsupported)
    XCTAssertEqual(unsupported.statusMessage, appleDeviceHostUnsupportedMessage)
    // Reconnect cannot help a Mac that does not have the feature.
    XCTAssertFalse(unsupported.offersReconnect)
  }

  func testReconnectIsNeverOfferedWhileAConnectIsInFlight() {
    // Two sockets on one capture is the fastest way to wedge the helper, so a
    // connect in flight must not show a second button.
    var health = AppleStreamHealth()
    health.requestTicket()
    XCTAssertFalse(health.offersReconnect)
    health.connecting()
    XCTAssertFalse(health.offersReconnect)
    health.socketOpened(at: Date())
    XCTAssertFalse(health.offersReconnect)
    health.frameDecoded(at: Date())
    XCTAssertFalse(health.offersReconnect)
  }

  func testResetClearsTheClockSoReturningStartsCleanRatherThanStalled() {
    let start = Date()
    var health = AppleStreamHealth()
    health.connecting()
    health.socketOpened(at: start)
    health.frameDecoded(at: start)

    // Going hidden resets; returning must not inherit the old lastFrameAt and
    // immediately declare a stall before the new socket has had a chance.
    health.reset()
    health.tick(now: start.addingTimeInterval(600))
    XCTAssertEqual(health.phase, .idle)
    XCTAssertNil(health.statusMessage)
  }

  // MARK: - Ticket URL resolution

  func testRelativeTicketPathResolvesAgainstADirectSyncEndpoint() throws {
    // The documented path, not a fallback: the host mints tickets without
    // knowing which transport the requester came in on, so `url` is null and
    // `path` is the real answer.
    let url = try XCTUnwrap(
      appleStreamSocketURL(
        ticketURL: nil,
        path: "/apple/stream/t-4",
        token: "tok",
        connectedAddress: "192.168.1.8",
        fallbackPort: 4599
      )
    )
    XCTAssertEqual(url.scheme, "ws")
    XCTAssertEqual(url.host, "192.168.1.8")
    XCTAssertEqual(url.port, 4599)
    XCTAssertEqual(url.path, "/apple/stream/t-4")
    XCTAssertEqual(url.query, "token=tok")
  }

  func testRelayEndpointForwardsTheLocalPathAsAPipeKindInsteadOfAppendingIt() throws {
    // The relay pairs the phone with a brain-side pipe that dials loopback
    // itself. Appending the ticket path to the relay's own URL would dial the
    // relay's root and open a socket that never sends a frame. This must match
    // `resolveAppleStreamUrl` in the web adapter exactly.
    let url = try XCTUnwrap(
      appleStreamSocketURL(
        ticketURL: nil,
        path: "/apple/stream/t-5",
        token: "tok12345",
        connectedAddress: "wss://relay.ade.app/connect/machine-key",
        fallbackPort: 4599
      )
    )
    XCTAssertEqual(url.scheme, "wss")
    XCTAssertEqual(url.host, "relay.ade.app")
    XCTAssertEqual(url.path, "/connect/machine-key")
    let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
    XCTAssertEqual(items.first(where: { $0.name == "kind" })?.value, appleStreamPipeKind)
    // The token rides INSIDE the forwarded path: the relay's own query belongs
    // to the pipe and is not passed through to the brain's socket.
    XCTAssertEqual(items.first(where: { $0.name == "path" })?.value, "/apple/stream/t-5?token=tok12345")
    XCTAssertNil(items.first(where: { $0.name == "token" }))
  }

  func testRelayForwardedPathIsNotGivenASecondTokenWhenItAlreadyCarriesOne() throws {
    let url = try XCTUnwrap(
      appleStreamSocketURL(
        ticketURL: nil,
        path: "/apple/stream/t-6?token=inline",
        token: "other",
        connectedAddress: "wss://relay.ade.app/connect/machine-key",
        fallbackPort: 4599
      )
    )
    let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
    XCTAssertEqual(items.first(where: { $0.name == "path" })?.value, "/apple/stream/t-6?token=inline")
  }

  func testDirectPathKeepsItsOwnQueryAndIsNotGivenASecondToken() throws {
    let url = try XCTUnwrap(
      appleStreamSocketURL(
        ticketURL: nil,
        path: "/apple/stream/t-7?token=inline",
        token: "other",
        connectedAddress: "192.168.1.8",
        fallbackPort: 4599
      )
    )
    XCTAssertEqual(url.path, "/apple/stream/t-7")
    XCTAssertEqual(url.query, "token=inline")
  }

  func testAnAbsoluteTicketUrlStillWinsIfAHostEverSendsOne() throws {
    // `url` is null today, but only the host can know about a route the phone
    // cannot see, so an absolute address must stay authoritative.
    let url = try XCTUnwrap(
      appleStreamSocketURL(
        ticketURL: "https://mac.example/apple/stream/t-8",
        path: "/apple/stream/t-8",
        token: "secret",
        connectedAddress: "wss://relay.ade.app/connect/machine-key",
        fallbackPort: 4599
      )
    )
    XCTAssertEqual(url.scheme, "wss")
    XCTAssertEqual(url.host, "mac.example")
    XCTAssertEqual(url.query, "token=secret")
  }

  func testUnusableTicketsResolveToNilRatherThanADialedGuess() {
    // Nothing to resolve against.
    XCTAssertNil(appleStreamSocketURL(ticketURL: nil, path: "/apple/stream/t", token: nil, connectedAddress: nil, fallbackPort: 4599))
    // No address at all.
    XCTAssertNil(appleStreamSocketURL(ticketURL: nil, path: nil, token: nil, connectedAddress: "192.168.1.8", fallbackPort: 4599))
    // A relative path that is not a path.
    XCTAssertNil(appleStreamSocketURL(ticketURL: nil, path: "apple/stream/t", token: nil, connectedAddress: "192.168.1.8", fallbackPort: 4599))
    // A scheme the phone will not dial.
    XCTAssertNil(appleStreamSocketURL(ticketURL: "file:///tmp/x", path: nil, token: nil, connectedAddress: nil, fallbackPort: 4599))
  }

  // MARK: - Close codes

  @MainActor
  func testCloseCodesAreWordedForWhatTheyActuallyMean() {
    // 4401 is routine, not a broken Mac: tickets are single-use with a 60s TTL,
    // so a sheet left open past the TTL gets it every time.
    XCTAssertEqual(
      AppleStreamSocket.message(forCloseCode: 4401, reason: nil),
      "The stream pass expired. Reconnect to get a new one."
    )
    XCTAssertEqual(AppleStreamSocket.message(forCloseCode: 1012, reason: nil), "The simulator stopped streaming.")
    XCTAssertEqual(AppleStreamSocket.message(forCloseCode: 1000, reason: nil), "The stream ended.")
    XCTAssertEqual(AppleStreamSocket.message(forCloseCode: 1006, reason: "upstream gone"), "upstream gone")
    XCTAssertEqual(AppleStreamSocket.message(forCloseCode: 1006, reason: nil), "The Mac closed the stream.")
  }

  // MARK: - apple.status / apple.streamTicket decoding

  func testStatusDecodesTheFullPayloadIncludingFieldsThePhoneIgnores() throws {
    // Byte-for-byte what `buildAppleStatusPayload` emits
    // (`apps/ade-cli/src/services/sync/appleRemoteCommands.ts`), plus a field
    // from a newer Mac.
    let data = Data(#"""
    {
      "laneId": "lane-1",
      "unavailable": null,
      "device": {
        "udid": "UDID-1",
        "name": "iPhone 17 Pro",
        "family": "iphone",
        "runtime": "iOS 26.0",
        "origin": "clone",
        "state": "Booted"
      },
      "app": { "bundleId": "dev.ade.Demo", "name": "Demo", "state": "running" },
      "stream": {
        "running": true,
        "codec": "avc1.42E01E",
        "width": 402,
        "height": 874,
        "bitrateKbps": 1100,
        "fps": 30,
        "lastError": null
      },
      "recording": { "active": true, "id": "rec-1", "startedAt": "2026-09-21T10:00:00.000Z", "mode": "auto" },
      "owner": { "chatSessionId": "chat-9", "chatTitle": "Fix the login screen" },
      "laneDevice": { "udid": "UDID-1" },
      "somethingANewerMacAdded": { "enabled": true }
    }
    """#.utf8)

    let status = try JSONDecoder().decode(AppleDeviceStatus.self, from: data)

    XCTAssertEqual(status.device?.name, "iPhone 17 Pro")
    XCTAssertEqual(status.device?.family, "iphone")
    XCTAssertEqual(status.device?.state, "Booted")
    XCTAssertEqual(status.app?.name, "Demo")
    XCTAssertEqual(status.stream?.running, true)
    XCTAssertEqual(status.stream?.bitrateKbps, 1100)
    XCTAssertEqual(status.stream?.fps, 30)
    XCTAssertNil(status.stream?.lastError)
    // The stream's own device pixels are the ONLY geometry on this wire; there
    // is no separate screen size, so the viewer sizes to these.
    XCTAssertEqual(status.stream?.width, 402)
    XCTAssertEqual(status.stream?.height, 874)
    // The recording dot and the owner claim are the two things that stop a
    // viewer misreading a driven device as an idle one.
    XCTAssertEqual(status.recording?.active, true)
    XCTAssertEqual(status.owner?.chatSessionId, "chat-9")
    XCTAssertEqual(status.owner?.chatTitle, "Fix the login screen")
    // The lane's own device. The simulator chip shows only when this udid is
    // the same as `device.udid`.
    XCTAssertEqual(status.laneDevice?.udid, "UDID-1")
  }

  func testStatusDecodesALaneWithNoDeviceOfItsOwn() throws {
    // The host sends `laneDevice: null` when `device` is only its fallback
    // (a booted simulator that no lane holds).
    let status = try JSONDecoder().decode(
      AppleDeviceStatus.self,
      from: Data(#"{"laneId":"lane-1","device":{"udid":"UDID-9","state":"Booted"},"laneDevice":null}"#.utf8)
    )
    XCTAssertEqual(status.device?.udid, "UDID-9")
    XCTAssertNil(status.laneDevice)
  }

  func testOwnerLabelKeepsTheClaimWhenTheHostCouldNotNameTheChat() throws {
    // The null branch is the one that actually ships: a chat is titled
    // asynchronously, the lookup is failure-safe by construction on the host,
    // and a runtime with no chat service never sets it at all. Losing the whole
    // claim in any of those cases would read as an idle device.
    let named = try JSONDecoder().decode(
      AppleDeviceStatusOwner.self,
      from: Data(#"{"chatSessionId":"chat-9","chatTitle":"Fix the login screen"}"#.utf8)
    )
    XCTAssertEqual(appleDeviceOwnerLabel(named), "Fix the login screen")

    let untitled = try JSONDecoder().decode(
      AppleDeviceStatusOwner.self,
      from: Data(#"{"chatSessionId":"chat-9","chatTitle":null}"#.utf8)
    )
    XCTAssertEqual(appleDeviceOwnerLabel(untitled), "a chat in this lane")

    // A host that predates the field at all.
    let legacy = try JSONDecoder().decode(
      AppleDeviceStatusOwner.self,
      from: Data(#"{"chatSessionId":"chat-9"}"#.utf8)
    )
    XCTAssertEqual(appleDeviceOwnerLabel(legacy), "a chat in this lane")

    // Whitespace is not a name. The host normalizes this away too (`chatTitle`
    // goes through the same `asString` as every other string in the
    // projection), so this guard should never fire against a current Mac — it
    // is here so the phone cannot print " " as an owner if any host ever does.
    XCTAssertEqual(
      appleDeviceOwnerLabel(AppleDeviceStatusOwner(chatSessionId: "chat-9", chatTitle: "   ")),
      "a chat in this lane"
    )

    // No claim at all is the one case with nothing to say.
    XCTAssertNil(appleDeviceOwnerLabel(nil))
    XCTAssertNil(appleDeviceOwnerLabel(AppleDeviceStatusOwner(chatSessionId: nil, chatTitle: "orphan")))
  }

  func testStatusDecodesTheHostsOwnCaptureError() throws {
    let data = Data(#"""
    {"laneId":"l","unavailable":null,"device":null,"app":null,
     "stream":{"running":false,"codec":null,"width":null,"height":null,"bitrateKbps":null,"fps":null,"lastError":"The capture helper exited."},
     "recording":null,"owner":null}
    """#.utf8)
    let status = try JSONDecoder().decode(AppleDeviceStatus.self, from: data)
    // Shown verbatim: the Mac knows why its helper stopped and the phone does
    // not, so repeating it beats "no frames arrived".
    XCTAssertEqual(status.stream?.lastError, "The capture helper exited.")
    XCTAssertEqual(status.stream?.running, false)
  }

  func testStatusDecodesAnEmptyLaneAndAnUnknownReason() throws {
    let data = Data(#"{"laneId":"lane-2","unavailable":"something_new","device":null,"app":null,"stream":{"running":false},"recording":null,"owner":null}"#.utf8)
    let status = try JSONDecoder().decode(AppleDeviceStatus.self, from: data)

    XCTAssertNil(status.device)
    XCTAssertEqual(status.unavailable, "something_new")
    // An unknown reason must fall back rather than show an empty card.
    XCTAssertEqual(appleDeviceUnavailableMessage(status.unavailable), "No simulator is open in this lane.")
  }

  func testStatusDecodesFromAnAlmostEmptyObject() throws {
    // Everything optional is not defensive decoration: this is the shape a Mac
    // mid-rollout answers with, and blanking the card on it would be a bug.
    let status = try JSONDecoder().decode(AppleDeviceStatus.self, from: Data("{}".utf8))
    XCTAssertNil(status.laneId)
    XCTAssertNil(status.device)
    // An older Mac sends no `laneDevice`.
    XCTAssertNil(status.laneDevice)
  }

  func testStreamTicketDecodesTheLandedShapeWithANullUrl() throws {
    // `url` is null in practice — the command handler has no view of which
    // transport the requester dialed on — so `path` is what the phone resolves.
    let ticket = try JSONDecoder().decode(
      AppleStreamTicket.self,
      from: Data(#"""
      {"url":null,"path":"/apple/stream/abcdefgh","token":"tok12345","ticket":"abcdefgh",
       "codec":"avc1.42E01E","width":402,"height":874,"expiresAt":"2026-09-21T10:01:00.000Z"}
      """#.utf8)
    )
    XCTAssertNil(ticket.url)
    XCTAssertEqual(ticket.path, "/apple/stream/abcdefgh")
    XCTAssertEqual(ticket.token, "tok12345")
    XCTAssertEqual(ticket.ticket, "abcdefgh")
    XCTAssertEqual(ticket.width, 402)

    let minimal = try JSONDecoder().decode(AppleStreamTicket.self, from: Data(#"{"path":"/apple/stream/x"}"#.utf8))
    XCTAssertNil(minimal.token)
    XCTAssertEqual(minimal.path, "/apple/stream/x")
  }

  // MARK: - Labels

  func testFamilyLabelsAndSymbolsFallBackRatherThanDropAnUnknownDevice() {
    XCTAssertEqual(appleDeviceFamilyLabel("iphone"), "iPhone")
    XCTAssertEqual(appleDeviceFamilyLabel("ipad"), "iPad")
    XCTAssertEqual(appleDeviceFamilyLabel("watch"), "Apple Watch")
    // A family only a newer Mac knows about is shown verbatim.
    XCTAssertEqual(appleDeviceFamilyLabel("vision"), "vision")
    XCTAssertNil(appleDeviceFamilyLabel(""))
    XCTAssertEqual(appleDeviceFamilySymbol("vision"), "iphone")
    XCTAssertEqual(appleDeviceFamilySymbol("ipad"), "ipad")
  }

  func testBitrateLabelSwitchesUnitsAtAMegabit() {
    XCTAssertEqual(appleStreamBitrateLabel(kbps: 0), "0 kb/s")
    XCTAssertEqual(appleStreamBitrateLabel(kbps: 800), "800 kb/s")
    XCTAssertEqual(appleStreamBitrateLabel(kbps: 1100), "1.1 Mb/s")
    XCTAssertEqual(appleStreamBitrateLabel(kbps: 2500), "2.5 Mb/s")
  }

  // MARK: - Capability gating

  @MainActor
  func testUnsupportedAppleReadsFailLocallyInsteadOfGoingOnTheWire() async throws {
    try await withServiceAsync { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "legacy-host", "deviceName": "Old Mac"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("work.listSessions")]] as [String: Any],
        ] as [String: Any],
      ])
      XCTAssertFalse(service.supportsAppleDeviceStatus)
      XCTAssertFalse(service.supportsAppleDeviceStream)

      do {
        _ = try await service.fetchAppleDeviceStatus(laneId: "lane-1")
        XCTFail("An unadvertised apple.status must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
        XCTAssertEqual((error as NSError).localizedDescription, appleDeviceHostUnsupportedMessage)
      }
      do {
        _ = try await service.requestAppleStreamTicket(laneId: "lane-1")
        XCTFail("An unadvertised apple.streamTicket must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
      }
    }
  }

  @MainActor
  func testStatusActionAloneDoesNotUnlockTheVideoPipe() throws {
    // A host can describe its device without being able to forward video to a
    // remote viewer. The card must still show the device and its last still in
    // that state, so the two are feature-detected apart.
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "partial-host", "deviceName": "Mac"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("apple.status")]] as [String: Any],
          "mobileCompatibility": ["mode": "full", "missingActions": [String]()] as [String: Any],
        ] as [String: Any],
      ])
      XCTAssertTrue(service.supportsAppleDeviceStatus)
      XCTAssertFalse(service.supportsAppleDeviceStream)
    }
  }

  @MainActor
  func testHostAdvertisingAppleOptionallyStaysFullyCompatible() throws {
    // `apple.*` must be OPTIONAL actions: an additive, view-only surface can
    // never be the reason a phone drops into limited mode.
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "new-host", "deviceName": "Mac Studio"],
        "features": [
          "commandRouting": ["actions": [
            Self.descriptor("apple.status"),
            Self.descriptor("apple.streamTicket"),
          ]] as [String: Any],
          "mobileCompatibility": ["mode": "full", "missingActions": [String]()] as [String: Any],
        ] as [String: Any],
      ])

      XCTAssertEqual(service.hostCompatibilityMode, .full)
      XCTAssertTrue(service.supportsAppleDeviceStatus)
      XCTAssertTrue(service.supportsAppleDeviceStream)
      // The phone is view-only, so both must be reachable by a viewer device.
      XCTAssertTrue(service.supportsViewerRemoteAction("apple.status"))
      XCTAssertTrue(service.supportsViewerRemoteAction("apple.streamTicket"))
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
