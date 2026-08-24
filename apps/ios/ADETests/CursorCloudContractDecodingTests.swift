import XCTest
@testable import ADE

final class CursorCloudContractDecodingTests: XCTestCase {
  func testFleetResultDecodesEpochMsAndIsoTimestampsWithNullsAndUnknownFields() throws {
    // Mirrors desktop CursorCloudFleetResult: agent timestamps arrive as
    // epoch-ms numbers (typed) or ISO strings, `| null` fields may be absent,
    // and unknown fields from a newer host must be ignored.
    let data = Data(#"""
    {
      "items": [
        {
          "agent": {
            "agentId": "bc-1",
            "name": "Refactor auth",
            "summary": "Splitting session helpers",
            "status": "running",
            "archived": false,
            "lastModified": 1770000000000,
            "createdAt": "2026-02-02T10:00:00Z",
            "repos": ["arul/ade"],
            "webUrl": null,
            "futureAgentField": { "enabled": true }
          },
          "runStatus": "running",
          "latestRunId": null,
          "branch": "ade/auth-split",
          "prUrl": null,
          "modelId": null,
          "ownership": {
            "sessionId": "s-1",
            "sessionTitle": "Refactor auth",
            "laneId": "lane-1",
            "laneName": "auth-split",
            "linearIssueId": "ADE-12"
          },
          "matchedBy": "both"
        }
      ],
      "relayState": "ready",
      "lastEventAt": "2026-08-24T09:30:00.123Z",
      "fetchedAt": "2026-08-24T09:31:00.456Z",
      "futureTopLevelField": true
    }
    """#.utf8)

    let result = try JSONDecoder().decode(CursorCloudFleetResult.self, from: data)

    XCTAssertTrue(result.relayLive)
    let entry = try XCTUnwrap(result.items.first)
    XCTAssertEqual(entry.branch, "ade/auth-split")
    XCTAssertNil(entry.latestRunId)
    XCTAssertEqual(entry.displayStatus, "running")
    XCTAssertTrue(entry.isActiveRun)
    XCTAssertEqual(entry.ownership.linearIssueId, "ADE-12")

    let agent = entry.agent
    if case .epochMs(let ms) = try XCTUnwrap(agent.lastModified) {
      XCTAssertEqual(ms, 1_770_000_000_000)
    } else {
      XCTFail("epoch-ms timestamp should decode as .epochMs")
    }
    let expectedCreated = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-02-02T10:00:00Z"))
    XCTAssertEqual(
      try XCTUnwrap(agent.createdAt?.date).timeIntervalSince1970,
      expectedCreated.timeIntervalSince1970,
      accuracy: 0.5)
    XCTAssertEqual(
      try XCTUnwrap(agent.lastActivityDate).timeIntervalSince1970,
      1_770_000_000,
      accuracy: 1)
  }

  func testCursorCloudTimestampAcceptsNumberAndBothIsoStringFormsButNotJunk() throws {
    let decoder = JSONDecoder()

    let epochMs = try decoder.decode(CursorCloudTimestamp.self, from: Data("1770000000000".utf8))
    XCTAssertEqual(epochMs, .epochMs(1_770_000_000_000))
    XCTAssertEqual(try XCTUnwrap(epochMs.date).timeIntervalSince1970, 1_770_000_000, accuracy: 1)

    let isoFractional = try decoder.decode(
      CursorCloudTimestamp.self,
      from: Data(#""2026-08-24T09:30:00.500Z""#.utf8))
    guard case .iso = isoFractional else {
      return XCTFail("ISO string should decode as .iso")
    }

    // Plain ISO (no fractional seconds) must still convert to a date.
    let isoPlain = try decoder.decode(
      CursorCloudTimestamp.self,
      from: Data(#""2026-02-02T10:00:00Z""#.utf8))
    let expectedPlain = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-02-02T10:00:00Z"))
    XCTAssertEqual(try XCTUnwrap(isoPlain.date), expectedPlain)

    XCTAssertThrowsError(try decoder.decode(CursorCloudTimestamp.self, from: Data("[1]".utf8)))
  }
}
