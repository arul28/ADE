import XCTest
@testable import ADESimHelperCore

final class ProtocolTests: XCTestCase {
    private func parse(_ line: String) -> Result<SimHelperCommand, SimHelperParseFailure> {
        SimHelperCommandParser.parse(line: line)
    }

    private func command(_ line: String, file: StaticString = #filePath, line lineNumber: UInt = #line) throws -> SimHelperCommand {
        switch parse(line) {
        case let .success(command): return command
        case let .failure(failure):
            XCTFail("Expected a command, got \(failure)", file: file, line: lineNumber)
            throw XCTSkip("unreachable")
        }
    }

    func testParsesTouchInDevicePoints() throws {
        let parsed = try command(#"{"type":"touch","id":"a","udid":"U","phase":"begin","x":100,"y":250.5}"#)
        XCTAssertEqual(parsed, .touch(id: "a", udid: "U", phase: .begin, point: DevicePoint(x: 100, y: 250.5)))
        XCTAssertEqual(parsed.udid, "U")
        XCTAssertEqual(parsed.id, "a")
    }

    func testParsesEveryCommandType() throws {
        let lines = [
            #"{"type":"list-devices","id":"1"}"#,
            #"{"type":"capture-start","id":"2","udid":"U","fps":30,"scale":0.5}"#,
            #"{"type":"capture-stop","id":"3","udid":"U"}"#,
            #"{"type":"touch","id":"4","udid":"U","phase":"end","x":1,"y":2}"#,
            #"{"type":"multi-touch","id":"5","udid":"U","phase":"move","x1":1,"y1":2,"x2":3,"y2":4}"#,
            #"{"type":"button","id":"6","udid":"U","name":"home"}"#,
            #"{"type":"key","id":"7","udid":"U","phase":"down","usage":40}"#,
            #"{"type":"type","id":"8","udid":"U","text":"hi"}"#,
            #"{"type":"scroll","id":"9","udid":"U","deltaX":0,"deltaY":-120}"#,
            #"{"type":"orientation","id":"10","udid":"U","value":3}"#,
            #"{"type":"ax-describe","id":"11","udid":"U"}"#,
            #"{"type":"ax-frontmost","id":"12","udid":"U"}"#,
            #"{"type":"screenshot","id":"13","udid":"U","path":"/tmp/a.png"}"#,
            #"{"type":"quit","id":"14"}"#,
        ]
        for line in lines {
            switch parse(line) {
            case .success:
                continue
            case let .failure(failure):
                XCTFail("\(line) failed to parse: \(failure)")
            }
        }
    }

    /// Version skew must not wedge an older helper.
    func testUnknownCommandIsReportedNotFatal() {
        guard case let .failure(.unknownCommand(id, type)) = parse(#"{"type":"teleport","id":"z"}"#) else {
            return XCTFail("Expected unknownCommand")
        }
        XCTAssertEqual(id, "z")
        XCTAssertEqual(type, "teleport")
    }

    func testJunkIsUnusableRatherThanAnError() {
        for line in ["", "   ", "not json", "[1,2,3]", #"{"no":"type"}"#] {
            guard case .failure(.unusable) = parse(line) else {
                return XCTFail("Expected \(line) to be unusable")
            }
        }
    }

    func testMissingUdidIsInvalid() {
        guard case let .failure(.invalid(id, message)) = parse(#"{"type":"touch","id":"q","phase":"begin","x":1,"y":1}"#) else {
            return XCTFail("Expected invalid")
        }
        XCTAssertEqual(id, "q")
        XCTAssertTrue(message.contains("udid"), message)
    }

    func testRejectsOutOfRangeValues() {
        let bad = [
            #"{"type":"capture-start","id":"1","udid":"U","fps":0}"#,
            #"{"type":"capture-start","id":"1","udid":"U","scale":2}"#,
            #"{"type":"orientation","id":"1","udid":"U","value":9}"#,
            #"{"type":"key","id":"1","udid":"U","phase":"down","usage":0}"#,
            #"{"type":"touch","id":"1","udid":"U","phase":"sideways","x":1,"y":1}"#,
        ]
        for line in bad {
            guard case .failure(.invalid) = parse(line) else {
                return XCTFail("Expected \(line) to be invalid")
            }
        }
    }

    /// A remote viewer's cap reaches the encoder only if `capture-start` carries
    /// it; the field is optional so an older caller keeps the helper default.
    func testCaptureStartCarriesAnOptionalBitrateCap() {
        guard case let .success(.captureStart(_, _, _, _, bitrateKbps)) = parse(
            #"{"type":"capture-start","id":"1","udid":"U","bitrateKbps":2500}"#
        ) else { return XCTFail("Expected success") }
        XCTAssertEqual(bitrateKbps, 2500)

        guard case let .success(.captureStart(_, _, _, _, absent)) = parse(
            #"{"type":"capture-start","id":"1","udid":"U"}"#
        ) else { return XCTFail("Expected success") }
        XCTAssertNil(absent)
    }

    func testRejectsAnOutOfRangeBitrateCap() {
        for kbps in [50, 25_000] {
            guard case .failure(.invalid) = parse(
                #"{"type":"capture-start","id":"1","udid":"U","bitrateKbps":\#(kbps)}"#
            ) else {
                return XCTFail("Expected bitrateKbps \(kbps) to be invalid")
            }
        }
    }

    /// Half an anchor is a caller bug, not a request to centre.
    func testScrollRejectsHalfAnAnchor() {
        guard case .failure(.invalid) = parse(#"{"type":"scroll","id":"1","udid":"U","deltaX":0,"deltaY":1,"anchorX":5}"#) else {
            return XCTFail("Expected invalid")
        }
        guard case let .success(.scroll(_, _, _, _, anchor)) = parse(
            #"{"type":"scroll","id":"1","udid":"U","deltaX":0,"deltaY":1,"anchorX":5,"anchorY":6}"#
        ) else { return XCTFail("Expected success") }
        XCTAssertEqual(anchor, DevicePoint(x: 5, y: 6))
    }

    func testEventsEncodeAsSingleNdjsonLines() throws {
        let events: [SimHelperEvent] = [
            .ready(pid: 42),
            .ok(id: "1", payload: ["typed": 3]),
            .error(id: "2", code: "failed", message: "nope"),
            .captureStopped(udid: "U", reason: "requested"),
        ]
        for event in events {
            let encoded = try XCTUnwrap(event.encoded())
            XCTAssertTrue(encoded.hasSuffix("\n"))
            XCTAssertEqual(encoded.filter { $0 == "\n" }.count, 1)
            let object = try JSONSerialization.jsonObject(
                with: Data(encoded.utf8)
            ) as? [String: Any]
            XCTAssertNotNil(object?["type"])
        }
    }

    func testReadyAdvertisesTheProtocolVersion() throws {
        let encoded = try XCTUnwrap(SimHelperEvent.ready(pid: 7).encoded())
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["protocol"] as? Int, SimHelperProtocol.version)
    }

    func testOkPayloadIsMergedNotNested() throws {
        let encoded = try XCTUnwrap(SimHelperEvent.ok(id: "9", payload: ["path": "/tmp/x.png"]).encoded())
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["path"] as? String, "/tmp/x.png")
        XCTAssertEqual(object["id"] as? String, "9")
    }
}
