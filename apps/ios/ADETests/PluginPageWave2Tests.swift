import XCTest
@testable import ADE

/// The wire shapes wave 2 added to the plugin page tier.
///
/// Every assertion here is about a VALUE that crosses a boundary — a
/// dictionary the page receives, a field decoded off a synced session row, a
/// kind the bridge accepts — and never about a view. The desktop and the phone
/// have to agree on all of them, and a rendering test would not catch the one
/// failure that matters: a key spelled differently on one client.
@MainActor
final class PluginPageWave2Tests: XCTestCase {
    // MARK: - Helpers

    private func request(
        _ method: PluginPageBridgeMethod,
        _ params: [String: Any] = [:]
    ) -> PluginPageBridgeRequest {
        PluginPageBridgeRequest(
            id: "r1",
            bridgeVersion: pluginPageBridgeVersion,
            method: method,
            params: params.mapValues { PluginPageJSON.from($0) }
        )
    }

    /// The answer as it actually crosses to the page: through
    /// `JSONSerialization`, so a value WebKit could not carry fails here rather
    /// than silently on a device.
    private func serialized(_ value: Any?) throws -> [String: Any] {
        let object = try XCTUnwrap(value as? [String: Any])
        let data = try JSONSerialization.data(withJSONObject: object)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func serializedList(_ value: Any?) throws -> [[String: Any]] {
        let object = try XCTUnwrap(value as? [Any])
        let data = try JSONSerialization.data(withJSONObject: object)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    }

    // MARK: - The five picker answers

    func testPickModelCarriesTheIdAndTheFastModeFlag() throws {
        let encoded = try serialized(PluginPagePickerAnswer.model(modelId: "claude-opus-5", fastMode: true).jsonValue)
        XCTAssertEqual(encoded["modelId"] as? String, "claude-opus-5")
        XCTAssertEqual(encoded["fastMode"] as? Bool, true)
        XCTAssertEqual(encoded.keys.sorted(), ["fastMode", "modelId"])

        // False, not absent, for a model with no fast tier: a page reading an
        // absent flag as "unknown" would have to guess.
        let plain = try serialized(PluginPagePickerAnswer.model(modelId: "gpt", fastMode: false).jsonValue)
        XCTAssertEqual(plain["fastMode"] as? Bool, false)
    }

    func testPickLaneAlwaysCarriesTheName() throws {
        let encoded = try serialized(PluginPagePickerAnswer.lane(laneId: "lane-1", name: "Wave 2").jsonValue)
        XCTAssertEqual(encoded["laneId"] as? String, "lane-1")
        XCTAssertEqual(encoded["name"] as? String, "Wave 2")
        // `name` is required and `branch` is not part of the contract at all —
        // a page reading a key the desktop never sends would break there.
        XCTAssertEqual(encoded.keys.sorted(), ["laneId", "name"])
    }

    func testPickPermissionModeAnswersTheProviderFieldValueTriple() throws {
        let encoded = try serialized(PluginPagePickerAnswer.permissionMode(
            provider: "claude",
            field: "claudePermissionMode",
            value: "acceptEdits"
        ).jsonValue)
        XCTAssertEqual(encoded["provider"] as? String, "claude")
        XCTAssertEqual(encoded["field"] as? String, "claudePermissionMode")
        XCTAssertEqual(encoded["value"] as? String, "acceptEdits")
        XCTAssertEqual(encoded.keys.sorted(), ["field", "provider", "value"])
    }

    /// The triple is DERIVED from the phone's own wire mapping, never from a
    /// second table: a page must not end up holding a provider→field table that
    /// goes stale when a sixth provider arrives.
    func testPermissionModeChoiceNamesTheNativeFieldPerProvider() {
        let claude = pluginPagePermissionModeChoice(provider: "claude", mode: "edit")
        XCTAssertEqual(claude.field, "claudePermissionMode")
        XCTAssertEqual(claude.value, "acceptEdits")

        let droid = pluginPagePermissionModeChoice(provider: "droid", mode: "full-auto")
        XCTAssertEqual(droid.field, "droidPermissionMode")
        XCTAssertEqual(droid.value, "auto-high")

        let cursor = pluginPagePermissionModeChoice(provider: "cursor", mode: "edit")
        XCTAssertEqual(cursor.field, "cursorModeId")
        XCTAssertEqual(cursor.value, "ask")

        // Codex and Pi express permission through the unified field itself, so
        // that is the field they honestly report.
        let codex = pluginPagePermissionModeChoice(provider: "codex", mode: "full-auto")
        XCTAssertEqual(codex.field, "permissionMode")
        XCTAssertEqual(codex.value, "full-auto")

        // A provider this build has no mapping for still answers something true.
        let unknown = pluginPagePermissionModeChoice(provider: "spaceship", mode: "plan")
        XCTAssertEqual(unknown.field, "permissionMode")
        XCTAssertEqual(unknown.value, "plan")
    }

    func testPickReasoningEffortAnswersTheModelAndTheEffort() throws {
        let encoded = try serialized(
            PluginPagePickerAnswer.reasoningEffort(modelId: "openai/gpt-5.6-sol", effort: "xhigh").jsonValue
        )
        XCTAssertEqual(encoded["modelId"] as? String, "openai/gpt-5.6-sol")
        XCTAssertEqual(encoded["effort"] as? String, "xhigh")
        XCTAssertEqual(encoded.keys.sorted(), ["effort", "modelId"])
    }

    func testAReasoningEffortOfNullIsARealAnswer() throws {
        let encoded = try serialized(
            PluginPagePickerAnswer.reasoningEffort(modelId: "claude-opus-5", effort: nil).jsonValue
        )
        // Present and null — "run this model without reasoning" — never absent,
        // which a page would read as a host too old to answer.
        XCTAssertTrue(encoded.keys.contains("effort"))
        XCTAssertTrue(encoded["effort"] is NSNull)
        XCTAssertEqual(encoded["modelId"] as? String, "claude-opus-5")
    }

    func testPickProviderAnswersOneFamily() throws {
        let encoded = try serialized(PluginPagePickerAnswer.provider("codex").jsonValue)
        XCTAssertEqual(encoded["provider"] as? String, "codex")
        XCTAssertEqual(encoded.keys.sorted(), ["provider"])
    }

    func testTheTwoRequiredPickerArgumentsAreRefusedWhenMissing() async {
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: RecordingWave2Host())
        for method in [PluginPageBridgeMethod.uiPickPermissionMode, .uiPickReasoningEffort] {
            do {
                _ = try await bridge.handle(request(method), pluginId: "linear")
                XCTFail("\(method.rawValue) has a required argument and must refuse without it.")
            } catch let error as PluginPageBridgeError {
                XCTAssertEqual(error.code, "invalid_params")
            } catch {
                XCTFail("Unexpected error \(error)")
            }
        }
    }

    func testPickModelForwardsThePreselectionAndTheNarrowedCatalogue() async throws {
        let host = RecordingWave2Host()
        host.pickAnswer = .model(modelId: "claude-opus-5", fastMode: false)
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: host)
        _ = try await bridge.handle(
            request(.uiPickModel, ["value": "gpt", "availableModelIds": ["gpt", "claude-opus-5"]]),
            pluginId: "linear"
        )
        XCTAssertEqual(host.picked.first?.value, "gpt")
        XCTAssertEqual(host.picked.first?.availableModelIds, ["gpt", "claude-opus-5"])
    }

    func testAnAbsentAvailableModelIdsMeansTheWholeCatalogue() async throws {
        let host = RecordingWave2Host()
        host.pickAnswer = .model(modelId: "gpt", fastMode: false)
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: host)
        _ = try await bridge.handle(request(.uiPickModel), pluginId: "linear")
        XCTAssertNil(
            host.picked.first?.availableModelIds,
            "Nil is the whole catalogue; an empty array would be a picker with nothing in it."
        )
    }

    func testPickerResolvesToNullWhenTheReaderDismissedIt() async throws {
        let host = RecordingWave2Host()
        host.pickAnswer = nil
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: host)
        let answer = try await bridge.handle(request(.uiPickModel), pluginId: "linear")
        XCTAssertNil(answer, "A dismissal is a resolved null, not a rejection.")
    }

    func testPickerRefusalIsAnErrorRatherThanANull() async {
        let host = RecordingWave2Host()
        host.pickError = PluginPageBridgeError.notSupportedHere("Nope.")
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: host)
        do {
            _ = try await bridge.handle(
                request(.uiPickReasoningEffort, ["model": "openai/gpt-5.6-sol"]),
                pluginId: "linear"
            )
            XCTFail("A refusal must reject; a null would read as a dismissal.")
        } catch let error as PluginPageBridgeError {
            XCTAssertEqual(error.code, "not_supported")
            XCTAssertEqual(error.message, "Nope.")
        } catch {
            XCTFail("Unexpected error \(error)")
        }
    }

    func testPickerArgumentsReachTheHost() async throws {
        let host = RecordingWave2Host()
        host.pickAnswer = .reasoningEffort(modelId: "openai/gpt-5.6-sol", effort: "high")
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: host)
        let answer = try await bridge.handle(
            request(.uiPickReasoningEffort, ["model": "openai/gpt-5.6-sol", "value": "low"]),
            pluginId: "linear"
        )
        XCTAssertEqual(try serialized(answer)["effort"] as? String, "high")
        XCTAssertEqual(try serialized(answer)["modelId"] as? String, "openai/gpt-5.6-sol")
        XCTAssertEqual(host.picked.first?.kind, .reasoningEffort)
        XCTAssertEqual(host.picked.first?.model, "openai/gpt-5.6-sol")
        XCTAssertEqual(host.picked.first?.value, "low")
    }

    // MARK: - The honest refusal

    func testOpenPathInEditorRefusesWithASentence() async {
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: RecordingWave2Host())
        do {
            _ = try await bridge.handle(
                request(.uiOpenPathInEditor, ["path": "/repo/src/main.ts"]),
                pluginId: "linear"
            )
            XCTFail("A phone has no editor; the page must hear so.")
        } catch let error as PluginPageBridgeError {
            XCTAssertEqual(error.code, "not_supported")
            XCTAssertTrue(error.message.contains("editor"), "The refusal must say why: \(error.message)")
        } catch {
            XCTFail("Unexpected error \(error)")
        }
    }

    // MARK: - sockets.list / sockets.invoke

    private func toolbarContribution(
        pluginId: String = "graph",
        label: String = "Rebuild",
        actionId: String = "graph.rebuild"
    ) -> PluginContribution? {
        PluginContributionParser.parse(
            entityKind: "surface",
            entityId: "lanes",
            pluginId: pluginId,
            socket: "toolbar-action",
            payloadJSON: #"{ "label": "\#(label)", "actionId": "\#(actionId)", "icon": "hammer" }"#,
            updatedAt: "2026-09-03T00:00:00Z"
        )
    }

    func testSocketItemCarriesEveryFieldAPageDraws() throws {
        let contribution = try XCTUnwrap(toolbarContribution())
        let item = PluginPageSocketItem(contribution: contribution)
        XCTAssertEqual(item.pluginId, "graph")
        XCTAssertEqual(item.socket, "toolbar-action")
        XCTAssertEqual(item.label, "Rebuild")
        XCTAssertEqual(item.icon, "hammer")
        XCTAssertEqual(item.actionId, "graph.rebuild")

        let encoded = item.jsonValue
        XCTAssertEqual(encoded["socketId"] as? String, contribution.socketId)
        let payload = try XCTUnwrap(encoded["payload"] as? [String: Any])
        XCTAssertEqual(payload["actionId"] as? String, "graph.rebuild")
        XCTAssertEqual(payload["label"] as? String, "Rebuild")
    }

    func testSocketsListAnswersAnArray() async throws {
        let source = FakeWave2DataSource()
        source.socketItems = [PluginPageSocketItem(contribution: try XCTUnwrap(toolbarContribution()))]
        let bridge = PluginPageBridge(dataSource: source, host: RecordingWave2Host())
        let answer = try await bridge.handle(
            request(.socketsList, ["socket": "toolbar-action"]),
            pluginId: "linear"
        )
        let items = try serializedList(answer)
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0]["pluginId"] as? String, "graph")
        XCTAssertEqual(items[0]["socket"] as? String, "toolbar-action")
    }

    func testSocketsInvokeRefusesASocketThePageWasNeverShown() async {
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: RecordingWave2Host())
        do {
            _ = try await bridge.handle(
                request(.socketsInvoke, ["socketId": "graph.rebuild", "args": [:]]),
                pluginId: "linear"
            )
            XCTFail("A page must not be able to press a socket it never listed.")
        } catch let error as PluginPageBridgeError {
            XCTAssertEqual(error.code, "not_permitted")
        } catch {
            XCTFail("Unexpected error \(error)")
        }
    }

    func testSocketsInvokeRunsTheContributionsOwnPluginAndAction() async throws {
        let source = FakeWave2DataSource()
        let contribution = try XCTUnwrap(toolbarContribution())
        source.socketItems = [PluginPageSocketItem(contribution: contribution)]
        let bridge = PluginPageBridge(dataSource: source, host: RecordingWave2Host())
        _ = try await bridge.handle(request(.socketsList, ["socket": "toolbar-action"]), pluginId: "linear")

        let answer = try await bridge.handle(
            request(.socketsInvoke, ["socketId": contribution.socketId, "args": ["from": "page"]]),
            pluginId: "linear"
        )
        XCTAssertEqual(try serialized(answer)["ok"] as? Bool, true)
        // The action is the CONTRIBUTION's, invoked against the contribution's
        // own plugin — never the calling page's, and never a name the page sent.
        XCTAssertEqual(source.invocations.first?.pluginId, "graph")
        XCTAssertEqual(source.invocations.first?.actionId, "graph.rebuild")
        XCTAssertEqual(source.invocations.first?.args["from"] as? String, "page")
        XCTAssertEqual(source.invocations.first?.args["socketId"] as? String, contribution.socketId)
    }

    // MARK: - chat.setHeader, as it lands on the session record

    private func summary(withHeader headerJSON: String) throws -> AgentChatSessionSummary {
        let json = """
        {
          "sessionId": "s1", "laneId": "l1", "provider": "claude", "model": "opus",
          "status": "idle", "startedAt": "2026-09-03T00:00:00Z",
          "lastActivityAt": "2026-09-03T00:00:00Z",
          "pluginHeader": \(headerJSON)
        }
        """
        return try JSONDecoder().decode(AgentChatSessionSummary.self, from: Data(json.utf8))
    }

    func testPluginHeaderDecodesLabelAndChips() throws {
        let decoded = try summary(
            withHeader: #"{ "label": "Cursor Cloud", "chips": [{ "label": "Running", "tone": "accent" }, { "label": "3 files" }] }"#
        )
        let header = try XCTUnwrap(decoded.pluginHeader)
        XCTAssertEqual(header.label, "Cursor Cloud")
        XCTAssertEqual(header.chips.map(\.label), ["Running", "3 files"])
        XCTAssertEqual(header.chips[0].tone, "accent")
        XCTAssertNil(header.chips[1].tone, "A chip with no tone must stay untoned, not default to one.")
    }

    func testPluginHeaderDropsBlankChipsAndCapsTheRest() throws {
        let chips = (0..<10).map { #"{ "label": "c\#($0)" }"# }.joined(separator: ",")
        let decoded = try summary(withHeader: #"{ "chips": [{ "label": "  " }, \#(chips)] }"#)
        let header = try XCTUnwrap(decoded.pluginHeader)
        XCTAssertNil(header.label)
        XCTAssertEqual(header.chips.count, PluginChatHeader.chipsMax)
        XCTAssertEqual(header.chips.first?.label, "c0", "The blank chip is dropped, not drawn empty.")
    }

    func testPluginHeaderRoundTripsThroughTheSessionRecord() throws {
        let decoded = try summary(withHeader: #"{ "label": "Linear", "chips": [{ "label": "ADE-148", "tone": "success" }] }"#)
        let data = try JSONEncoder().encode(decoded)
        let again = try JSONDecoder().decode(AgentChatSessionSummary.self, from: data)
        XCTAssertEqual(again.pluginHeader, decoded.pluginHeader)
    }

    func testASessionWithoutAPluginHeaderDecodesToNil() throws {
        let json = """
        { "sessionId": "s1", "laneId": "l1", "provider": "claude", "model": "opus",
          "status": "idle", "startedAt": "2026-09-03T00:00:00Z",
          "lastActivityAt": "2026-09-03T00:00:00Z" }
        """
        let decoded = try JSONDecoder().decode(AgentChatSessionSummary.self, from: Data(json.utf8))
        XCTAssertNil(decoded.pluginHeader)
    }

    // MARK: - host.subscribe gains three kinds

    func testTheThreeNewHostKindsDecodeFromTheirWireNames() {
        XCTAssertEqual(PluginPageHostKind(rawValue: "operation"), .operation)
        XCTAssertEqual(PluginPageHostKind(rawValue: "conflict"), .conflict)
        XCTAssertEqual(PluginPageHostKind(rawValue: "review"), .review)
        XCTAssertNil(PluginPageHostKind(rawValue: "spaceship"))
    }

    func testHostSubscribeAcceptsAndEchoesTheNewKinds() async throws {
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: RecordingWave2Host())
        let answer = try await bridge.handle(
            request(.hostSubscribe, ["kinds": ["operation", "conflict", "review", "lane"]]),
            pluginId: "linear"
        )
        let kinds = try XCTUnwrap(try serialized(answer)["kinds"] as? [String])
        XCTAssertEqual(kinds, ["conflict", "lane", "operation", "review"])
        XCTAssertEqual(
            bridge.subscribedHostKinds,
            [.conflict, .lane, .operation, .review],
            "A kind the bridge accepted but did not record would never be delivered."
        )
    }

    func testANewKindFrameCarriesTheSameShapeAsTheOldOnes() {
        let frame = PluginPageHostCoalescer.Frame(
            kind: .conflict,
            ids: ["lane-1"],
            overflow: false,
            turns: []
        )
        XCTAssertEqual(frame.kind.rawValue, "conflict")
        XCTAssertEqual(frame.ids, ["lane-1"])
        XCTAssertFalse(frame.overflow)
        XCTAssertTrue(frame.turns.isEmpty, "Only a chat frame carries turns.")
    }

    // MARK: - page.error

    func testPageErrorReachesTheHostWithItsSourceAndSentence() async throws {
        let host = RecordingWave2Host()
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: host)
        _ = try await bridge.handle(
            request(.pageError, ["message": "boom", "source": "contentPolicy"]),
            pluginId: "linear"
        )
        XCTAssertEqual(host.errors.first?.message, "boom")
        XCTAssertEqual(host.errors.first?.source, .contentPolicy)
    }

    func testPageErrorKindCspMapsToContentPolicyEvenWhenSourceIsAUri() async throws {
        let host = RecordingWave2Host()
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: host)
        _ = try await bridge.handle(
            request(.pageError, [
                "kind": "csp",
                "message": "script-src blocked https://cdn.example.com/react.js",
                "source": "https://cdn.example.com/react.js",
            ]),
            pluginId: "linear"
        )
        XCTAssertEqual(host.errors.first?.source, .contentPolicy)
        XCTAssertTrue(host.errors.first?.message.contains("cdn.example.com") == true)
    }

    func testHostEnginePlaceAndReleaseRefuseOnThisPhone() async {
        let bridge = PluginPageBridge(dataSource: FakeWave2DataSource(), host: RecordingWave2Host())
        for method in [PluginPageBridgeMethod.hostEnginePlace, .hostEngineRelease] {
            do {
                _ = try await bridge.handle(request(method), pluginId: "ade-app-control")
                XCTFail("\(method.rawValue) has no engine on the phone and must refuse.")
            } catch let error as PluginPageBridgeError {
                XCTAssertEqual(error.code, "not_supported")
                XCTAssertTrue(error.message.contains("engine"), "The refusal must say why: \(error.message)")
            } catch {
                XCTFail("Unexpected error \(error)")
            }
        }
    }

    func testTheGuestScriptForwardsPickerArgsAndHostEngine() {
        let script = PluginPageHostView.bridgeScript(
            pluginId: "linear",
            context: PluginPageContext()
        )
        XCTAssertTrue(script.contains("pickModel: function (request)"))
        XCTAssertTrue(script.contains("pickLane: function (request)"))
        XCTAssertTrue(script.contains("pickProvider: function (request)"))
        XCTAssertTrue(script.contains("openPathInEditor: function (request)"))
        XCTAssertTrue(script.contains("hostEngine.place"))
        XCTAssertTrue(script.contains("hostEngine.release"))
        XCTAssertFalse(script.contains("{ path: path }"))
        XCTAssertTrue(script.contains("kind: kind || \"error\""))
    }

    func testRuntimeRefDecodesCapabilitiesAndOwnsName() throws {
        let json = """
        {
          "sessionId": "s1", "laneId": "l1", "provider": "plugin", "model": "cloud",
          "status": "idle", "startedAt": "2026-09-03T00:00:00Z",
          "lastActivityAt": "2026-09-03T00:00:00Z",
          "runtimeRef": {
            "pluginId": "ade-cursor-cloud",
            "runtimeId": "cloud",
            "externalId": "bc-1",
            "ownsName": true,
            "capabilities": { "followUp": true, "interrupt": false, "hydrate": true, "artifacts": true }
          },
          "pluginPrUrl": "https://github.com/org/repo/pull/12"
        }
        """
        let decoded = try JSONDecoder().decode(AgentChatSessionSummary.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.runtimeRef?.pluginId, "ade-cursor-cloud")
        XCTAssertEqual(decoded.runtimeRef?.ownsName, true)
        XCTAssertEqual(decoded.runtimeRef?.capabilities?.interrupt, false)
        XCTAssertEqual(decoded.pluginPrUrl, "https://github.com/org/repo/pull/12")
        XCTAssertTrue(
            CursorCloudNaming.sessionNameIsLocked(
                cursorCloudAgentId: decoded.cursorCloudAgentId,
                runtimeRef: decoded.runtimeRef
            )
        )
        XCTAssertEqual(
            CursorCloudNaming.blockedMessage(
                cursorCloudAgentId: decoded.cursorCloudAgentId,
                runtimeRef: decoded.runtimeRef
            ),
            CursorCloudNaming.pluginRenameBlockedMessage
        )
    }

    func testAnOlderRuntimeRefWithoutCapabilitiesStillDecodes() throws {
        let json = """
        {
          "sessionId": "s1", "laneId": "l1", "provider": "plugin", "model": "cloud",
          "status": "idle", "startedAt": "2026-09-03T00:00:00Z",
          "lastActivityAt": "2026-09-03T00:00:00Z",
          "runtimeRef": { "pluginId": "ade-linear", "runtimeId": "issue", "externalId": "ADE-148" }
        }
        """
        let decoded = try JSONDecoder().decode(AgentChatSessionSummary.self, from: Data(json.utf8))
        XCTAssertNil(decoded.runtimeRef?.capabilities)
        XCTAssertNil(decoded.runtimeRef?.ownsName)
        XCTAssertFalse(
            CursorCloudNaming.sessionNameIsLocked(
                cursorCloudAgentId: decoded.cursorCloudAgentId,
                runtimeRef: decoded.runtimeRef
            )
        )
    }

    func testAnEmptyPageErrorBecomesTheHostsOwnSentence() {
        let report = PluginPageErrorReport.fromPage(message: "   ", source: .script)
        XCTAssertFalse(report.message.isEmpty, "An error card that says nothing is the one outcome to avoid.")
        XCTAssertEqual(report.source, .script)
    }

    func testAPageCannotFillTheCardWithItsOwnStackTrace() {
        let report = PluginPageErrorReport.fromPage(
            message: String(repeating: "x", count: 4_000),
            source: .script
        )
        XCTAssertEqual(report.message.count, PluginPageErrorReport.messageMaxChars)
    }

    func testTheErrorCardTitleMatchesTheDesktopWords() {
        XCTAssertEqual(PluginPageErrorReport.title, "This page didn\u{2019}t open")
    }

    // MARK: - The refresh event

    func testRefreshIsAnEventOnTheOneChannel() {
        XCTAssertEqual(PluginPageBridgeEvent.refresh.rawValue, "refresh")
        XCTAssertNil(
            PluginPageBridgeMethod(rawValue: "refresh"),
            "Refresh is the host telling the page, never the page asking the host."
        )
    }
}

// MARK: - Fakes

private final class FakeWave2DataSource: PluginPageBridgeDataSource {
    var socketItems: [PluginPageSocketItem] = []
    var invokeResult = PluginInvokeResult(ok: true)
    private(set) var invocations: [(pluginId: String, actionId: String, args: [String: Any])] = []

    func pluginPageCollectionEntries(
        pluginId: String,
        collection: String,
        keyPrefix: String?,
        limit: Int
    ) -> [PluginCollectionEntry] { [] }

    func pluginPageInvoke(pluginId: String, actionId: String, args: [String: Any]) async throws -> PluginInvokeResult {
        invocations.append((pluginId, actionId, args))
        return invokeResult
    }

    func pluginPageRemoteAction(_ action: String, args: [String: Any]) async throws -> Any { [:] }

    func pluginPageSupportsRemoteAction(_ action: String) -> Bool { true }

    func pluginPageSocketItems(socket: String) -> [PluginPageSocketItem] {
        socketItems.filter { $0.socket == socket }
    }
}

@MainActor
private final class RecordingWave2Host: PluginPageBridgeHosting {
    var pickAnswer: PluginPagePickerAnswer?
    var pickError: PluginPageBridgeError?
    private(set) var picked: [PluginPagePickerRequest] = []
    private(set) var errors: [PluginPageErrorReport] = []

    func pluginPageCloseSurface() {}
    func pluginPageComposerAttach(_ attach: PluginPageComposerAttach) {}
    func pluginPageComposerInsert(_ text: String) {}
    func pluginPageShowToast(_ toast: PluginPageToast) -> String { "t" }
    func pluginPageDismissToast(id: String) {}
    func pluginPagePrompt(_ prompt: PluginActionPrompt) async -> String? { nil }
    func pluginPageConfirm(_ confirm: PluginPageConfirm) async -> Bool { false }
    func pluginPageOpenSettings(entryId: String?, socketId: String?) {}
    func pluginPageApply(_ result: PluginInvokeResult, pluginId: String) async {}
    func pluginPageOpenDeeplink(_ url: URL) {}
    func pluginPageTheme() -> PluginPageThemeSnapshot { PluginPageTheme.snapshot(scheme: .dark) }

    func pluginPagePick(_ request: PluginPagePickerRequest) async throws -> PluginPagePickerAnswer? {
        picked.append(request)
        if let pickError { throw pickError }
        return pickAnswer
    }

    func pluginPageReportError(_ report: PluginPageErrorReport) {
        errors.append(report)
    }
}
