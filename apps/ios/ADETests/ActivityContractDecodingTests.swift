import XCTest
@testable import ADE

final class ActivityContractDecodingTests: XCTestCase {
    func testUnknownPhaseDropsOnlyThatItemAndIgnoresUnknownTopLevelFields() throws {
        let data = Data(#"""
        {
          "contractVersion": 1,
          "revision": 42,
          "generatedAt": "2026-08-01T12:00:00Z",
          "itemsTruncated": true,
          "futureTopLevel": { "enabled": true },
          "items": [
            {
              "contractVersion": 1,
              "id": "known-item",
              "revision": 4,
              "fingerprint": "known-fingerprint",
              "kind": "agent",
              "eventKind": "agent_running",
              "phase": "running",
              "machine": {
                "machineKey": "machine:one",
                "name": "Studio",
                "online": true
              },
              "project": {
                "projectId": "project:one",
                "name": "ADE"
              },
              "title": "Known run",
              "preview": "Working",
              "privacyPreview": "Agent activity",
              "destination": {
                "kind": "session",
                "sessionId": "session-known"
              },
              "actions": [],
              "occurredAt": "2026-08-01T11:59:00Z",
              "updatedAt": "2026-08-01T12:00:00Z"
            },
            {
              "contractVersion": 1,
              "id": "future-item",
              "revision": 5,
              "fingerprint": "future-fingerprint",
              "kind": "agent",
              "eventKind": "agent_running",
              "phase": "future_phase",
              "machine": {
                "machineKey": "machine:one",
                "name": "Studio",
                "online": true
              },
              "project": {
                "projectId": "project:one",
                "name": "ADE"
              },
              "title": "Future run",
              "preview": "Doing something new",
              "privacyPreview": "Agent activity",
              "destination": {
                "kind": "session",
                "sessionId": "session-future"
              },
              "actions": [],
              "occurredAt": "2026-08-01T11:59:30Z",
              "updatedAt": "2026-08-01T12:00:00Z"
            }
          ]
        }
        """#.utf8)

        let snapshot = try XCTUnwrap(ADESharedContainer.decodeAttentionSnapshot(from: data))

        XCTAssertEqual(snapshot.revision, 42)
        XCTAssertEqual(snapshot.items.map(\.id), ["known-item"])
        XCTAssertEqual(snapshot.itemsTruncated, true)
    }

    func testUnknownEnumValuesDecodeAndReencodeTheirRawValues() throws {
        try assertUnknownRoundTrip(
            AccountAttentionItemKind.self,
            rawValue: "future_item",
            expected: .unrecognized("future_item")
        )
        try assertUnknownRoundTrip(
            AccountAttentionPhase.self,
            rawValue: "future_phase",
            expected: .unrecognized("future_phase")
        )
        try assertUnknownRoundTrip(
            AccountAttentionEventKind.self,
            rawValue: "future_event",
            expected: .unrecognized("future_event")
        )
        try assertUnknownRoundTrip(
            AccountAttentionActionKind.self,
            rawValue: "future_action",
            expected: .unrecognized("future_action")
        )
    }

    func testMalformedItemDropsWithoutInvalidatingSnapshot() throws {
        let data = Data(#"""
        {
          "contractVersion": 1,
          "revision": 2,
          "generatedAt": "2026-08-01T12:00:00Z",
          "items": [
            {
              "contractVersion": 1,
              "id": "survivor",
              "revision": 1,
              "fingerprint": "survivor-fingerprint",
              "kind": "agent",
              "eventKind": "agent_running",
              "phase": "running",
              "machine": { "machineKey": "machine:one", "name": "Studio", "online": true },
              "project": { "projectId": "project:one", "name": "ADE" },
              "title": "Survivor",
              "preview": "Working",
              "privacyPreview": "Agent activity",
              "destination": { "kind": "session", "sessionId": "session-survivor" },
              "actions": [],
              "occurredAt": "2026-08-01T11:59:00Z",
              "updatedAt": "2026-08-01T12:00:00Z"
            },
            {
              "contractVersion": 1,
              "revision": 2,
              "kind": "agent"
            }
          ]
        }
        """#.utf8)

        let snapshot = try XCTUnwrap(ADESharedContainer.decodeAttentionSnapshot(from: data))

        XCTAssertEqual(snapshot.items.map(\.id), ["survivor"])
    }

    func testActivityTierAndStatusSinceRoundTrip() throws {
        let statusSince = Date(timeIntervalSince1970: 1_754_046_000)
        let snapshot = AccountAttentionSnapshot(
            revision: 7,
            generatedAt: Date(timeIntervalSince1970: 1_754_046_100),
            items: [
                makeItem(
                    id: "round-trip",
                    phase: .running,
                    activityTier: "ambient",
                    statusSince: statusSince
                )
            ],
            itemsTruncated: false
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601

        let encoded = try encoder.encode(snapshot)
        let decoded = try XCTUnwrap(ADESharedContainer.decodeAttentionSnapshot(from: encoded))
        let item = try XCTUnwrap(decoded.items.first)

        XCTAssertEqual(item.activityTier, "ambient")
        XCTAssertEqual(item.tier, .ambient)
        XCTAssertEqual(item.statusSince, statusSince)
        XCTAssertEqual(decoded.itemsTruncated, false)
    }

    func testTierDefaultsFromPhaseWhenActivityTierIsAbsent() {
        XCTAssertEqual(makeItem(id: "needs-you", phase: .needsYou).tier, .signal)
        XCTAssertEqual(makeItem(id: "failed", phase: .failed).tier, .signal)
        XCTAssertEqual(makeItem(id: "starting", phase: .starting).tier, .ambient)
        XCTAssertEqual(makeItem(id: "running", phase: .running).tier, .ambient)
        XCTAssertEqual(makeItem(id: "completed", phase: .completed).tier, .ambient)
        XCTAssertEqual(makeItem(id: "blocked", phase: .blocked).tier, .idle)
        XCTAssertEqual(makeItem(id: "stale", phase: .stale).tier, .idle)
        XCTAssertTrue(makeItem(id: "legacy-signal", phase: .needsYou).needsInbox)
        XCTAssertFalse(
            makeItem(id: "idle-needs-you", phase: .needsYou, activityTier: "idle").needsInbox
        )
    }

    private func assertUnknownRoundTrip<Value: Codable & Equatable>(
        _ type: Value.Type,
        rawValue: String,
        expected: Value,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let encodedRawValue = try JSONEncoder().encode(rawValue)
        let decoded = try JSONDecoder().decode(type, from: encodedRawValue)
        XCTAssertEqual(decoded, expected, file: file, line: line)

        let reencoded = try JSONEncoder().encode(decoded)
        XCTAssertEqual(
            try JSONDecoder().decode(String.self, from: reencoded),
            rawValue,
            file: file,
            line: line
        )
    }

    private func makeItem(
        id: String,
        phase: AccountAttentionPhase,
        activityTier: String? = nil,
        statusSince: Date? = nil
    ) -> AccountAttentionItem {
        let timestamp = Date(timeIntervalSince1970: 1_754_046_000)
        return AccountAttentionItem(
            id: id,
            revision: 1,
            fingerprint: "fingerprint-\(id)",
            kind: .agent,
            eventKind: .agentRunning,
            phase: phase,
            activityTier: activityTier,
            statusSince: statusSince,
            machine: AccountAttentionMachine(
                machineKey: "machine:one",
                name: "Studio",
                online: true,
                lastSeenAt: timestamp
            ),
            project: AccountAttentionProject(projectId: "project:one", name: "ADE"),
            title: "Agent run",
            preview: "Working",
            privacyPreview: "Agent activity",
            destination: .session(sessionId: "session-\(id)", itemId: nil, eventId: nil),
            occurredAt: timestamp,
            updatedAt: timestamp
        )
    }
}
