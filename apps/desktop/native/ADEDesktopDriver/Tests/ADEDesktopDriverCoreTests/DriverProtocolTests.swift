import XCTest
@testable import ADEDesktopDriverCore

final class DriverProtocolTests: XCTestCase {
    func testDecodesARequestAndKeepsItsFields() throws {
        let line = #"{"id":"7","op":"observe","laneId":"lane-a","limit":40,"map":true}"#
        guard case .request(let request) = try DriverInputDecoder.decode(line: line) else {
            return XCTFail("Expected a request")
        }
        XCTAssertEqual(request.id, "7")
        XCTAssertEqual(request.knownOp, .observe)
        XCTAssertEqual(request.string("laneId"), "lane-a")
        XCTAssertEqual(request.int("limit"), 40)
        XCTAssertEqual(request.bool("map"), true)
        XCTAssertNil(request.fields["id"])
        XCTAssertNil(request.fields["op"])
    }

    func testAcceptsBothOpSpellings() {
        XCTAssertEqual(DriverOp(wireName: "createDisplay"), .createDisplay)
        XCTAssertEqual(DriverOp(wireName: "display.create"), .createDisplay)
        XCTAssertEqual(DriverOp(wireName: "stream.setRate"), .setStreamRate)
        XCTAssertEqual(DriverOp(wireName: "lease.set"), .setLease)
        XCTAssertEqual(DriverOp(wireName: "ping"), .health)
        XCTAssertNil(DriverOp(wireName: "display.teleport"))
    }

    func testEveryOpHasItsOwnDottedName() {
        let dotted = DriverOp.allCases.map(\.dottedName)
        XCTAssertEqual(Set(dotted).count, dotted.count, "Two ops share a dotted name")
        for op in DriverOp.allCases {
            XCTAssertEqual(DriverOp(wireName: op.dottedName), op)
            XCTAssertEqual(DriverOp(wireName: op.rawValue), op)
        }
    }

    func testUnknownOpIsAnErrorReplyAndNotACrash() throws {
        let line = #"{"id":"9","op":"launchTheMissiles"}"#
        guard case .request(let request) = try DriverInputDecoder.decode(line: line) else {
            return XCTFail("Expected a request")
        }
        XCTAssertNil(request.knownOp)
        let reply = DriverReply.unknownOp(id: request.id, op: request.op)
        XCTAssertFalse(reply.ok)
        XCTAssertEqual(reply.error?.code, DriverErrorCode.unknownOp)
        let encoded = String(decoding: try JSONEncoder().encode(reply), as: UTF8.self)
        XCTAssertTrue(encoded.contains("\"id\":\"9\""))
        XCTAssertTrue(encoded.contains("launchTheMissiles"))
    }

    func testAnObjectWithNeitherIdNorOpIsIgnoredRatherThanRejected() throws {
        XCTAssertEqual(try DriverInputDecoder.decode(line: #"{"keepalive":true}"#), .ignored)
    }

    func testNonObjectLineIsAProtocolFault() {
        XCTAssertThrowsError(try DriverInputDecoder.decode(line: "not json")) { error in
            XCTAssertEqual(error as? DriverProtocolError, .malformedLine("Line is not a JSON object."))
        }
        XCTAssertThrowsError(try DriverInputDecoder.decode(line: "[1,2,3]"))
    }

    func testARequestWithoutAnOpIsAMissingFieldFault() {
        XCTAssertThrowsError(try DriverInputDecoder.decode(line: #"{"id":"3"}"#)) { error in
            XCTAssertEqual(error as? DriverProtocolError, .missingField("op"))
        }
    }

    func testReplyRoundTripsThroughJSON() throws {
        let reply = DriverReply.success(id: "1", result: ["stopped": .bool(true), "moved": .int(3)])
        let data = try JSONEncoder().encode(reply)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded.objectValue?["ok"], .bool(true))
        XCTAssertEqual(decoded.objectValue?["result"]?.objectValue?["moved"], .int(3))
        // Integers must not come back as 3.0: window ids and pids ride this path.
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("\"moved\":3"))
    }

    func testEventEncodesItsOwnFieldsWithoutAnId() throws {
        let event = DriverEvent(
            event: "windows-changed",
            fields: ["laneId": .string("lane-a"), "windows": .array([])]
        )
        let text = String(decoding: try JSONEncoder().encode(DriverOutput.event(event)), as: UTF8.self)
        XCTAssertTrue(text.contains("\"event\":\"windows-changed\""))
        XCTAssertTrue(text.contains("\"laneId\":\"lane-a\""))
        XCTAssertFalse(text.contains("\"id\""))
    }

    func testRequiredFieldsRefuseEmptyValues() {
        let request = DriverRequest(id: "1", op: "createDisplay", fields: ["laneId": .string("")])
        XCTAssertThrowsError(try request.requireString("laneId")) { error in
            XCTAssertEqual((error as? DriverError)?.code, DriverErrorCode.invalidArgument)
        }
        XCTAssertThrowsError(try request.requireInt("width"))
    }

    func testStreamRecordHeaderMatchesTheSimulatorLayout() {
        let payload = Data([0x00, 0x00, 0x00, 0x01, 0x65])
        let record = StreamRecord.accessUnitRecord(payload: payload, keyframe: true)
        XCTAssertEqual(record.count, StreamRecord.headerBytes + payload.count)
        XCTAssertEqual(Array(record.prefix(4)), [0xAD, 0xE1, 0xF0, 0x0D])
        XCTAssertEqual(record[4], StreamRecord.typeAccessUnit)
        XCTAssertEqual(record[5], StreamRecord.flagKeyframe)
        XCTAssertEqual(Array(record[8..<12]), [0, 0, 0, UInt8(payload.count)])
    }
}
