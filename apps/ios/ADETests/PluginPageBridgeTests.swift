import SwiftUI
import UIKit
import XCTest
@testable import ADE

/// `window.adePlugin`, as the phone answers it.
///
/// Two halves are proved here. The DECODER: which bodies become a request, and
/// where the plugin id comes from — the one rule that keeps one plugin out of
/// another's collections. And the BRIDGE: every verb in the closed method list,
/// including the ones a machine may be too old to offer.
final class PluginPageBridgeTests: XCTestCase {
    // MARK: The plugin id

    /// Not from the page. The origin is the identity, and a body that carries a
    /// `pluginId` is a claim the bridge has no field to read.
    func testThePluginIdComesFromTheOriginAndNowhereElse() {
        XCTAssertEqual(
            PluginPageBridgeDecoder.pluginId(fromOriginScheme: "ade-plugin", host: "ade-linear"),
            "ade-linear"
        )
        XCTAssertNil(PluginPageBridgeDecoder.pluginId(fromOriginScheme: "https", host: "ade-linear"))
        XCTAssertNil(PluginPageBridgeDecoder.pluginId(fromOriginScheme: "ade-plugin", host: ""))
        XCTAssertNil(PluginPageBridgeDecoder.pluginId(fromOriginScheme: "ade-plugin", host: "../escape"))
        XCTAssertNil(PluginPageBridgeDecoder.pluginId(fromOriginScheme: "ade-plugin", host: "9lives"))
        XCTAssertNil(PluginPageBridgeDecoder.pluginId(fromOriginScheme: "ade-plugin", host: String(repeating: "a", count: 65)))
    }

    /// Neither stricter nor looser than `PLUGIN_ID_PATTERN` on the desktop. A
    /// phone that refused an id the Mac installed would show a page that never
    /// loads, with nothing anywhere saying why.
    func testThePluginIdRuleMatchesTheDesktopPatternExactly() {
        for allowed in ["a", "ade-linear", "trailing-", "a--b", "x9", String(repeating: "a", count: 64)] {
            XCTAssertTrue(PluginPageBridgeDecoder.isValidPluginPageId(allowed), allowed)
        }
        for refused in ["", "9lives", "-leading", "Up-Per", "has_underscore", "has.dot", String(repeating: "a", count: 65)] {
            XCTAssertFalse(PluginPageBridgeDecoder.isValidPluginPageId(refused), refused)
        }
    }

    func testAPluginIdInTheBodyIsNeverRead() throws {
        let request = try PluginPageBridgeDecoder.decode(body: [
            "id": "r1",
            "bridgeVersion": 2,
            "method": "collections.get",
            "params": ["collection": "issues", "key": "one"],
            "pluginId": "someone-else",
        ])

        XCTAssertEqual(request.method, .collectionsGet)
        XCTAssertNil(request.params["pluginId"], "the decoder must not carry a claimed id through")
    }

    // MARK: Decoding

    func testEveryMethodInTheClosedListDecodes() throws {
        for method in PluginPageBridgeMethod.allCases {
            let request = try PluginPageBridgeDecoder.decode(body: [
                "id": "r1",
                "bridgeVersion": 2,
                "method": method.rawValue,
                "params": [:],
            ])
            XCTAssertEqual(request.method, method)
        }
        XCTAssertEqual(PluginPageBridgeMethod.allCases.count, 20)
    }

    func testAnUnknownMethodIsRefusedByName() {
        XCTAssertThrowsError(try PluginPageBridgeDecoder.decode(body: [
            "id": "r1", "method": "secrets.get", "params": [:],
        ])) { error in
            XCTAssertEqual(error as? PluginPageBridgeDecodeError, .unknownMethod("secrets.get"))
        }
    }

    func testABodyWithNoRequestIdIsRefused() {
        XCTAssertThrowsError(try PluginPageBridgeDecoder.decode(body: [
            "method": "invoke", "params": [:],
        ])) { error in
            XCTAssertEqual(error as? PluginPageBridgeDecodeError, .missingRequestId)
        }
    }

    /// A missing version reads as v1, never as an error: the number exists so a
    /// page can feature-detect the HOST, not so the host can refuse a page.
    func testAMissingBridgeVersionReadsAsOne() throws {
        let request = try PluginPageBridgeDecoder.decode(body: [
            "id": "r1", "method": "theme.get", "params": [:],
        ])
        XCTAssertEqual(request.bridgeVersion, 1)
    }

    func testTheBridgeVersionMatchesTheDesktopHandshake() {
        XCTAssertEqual(pluginPageBridgeVersion, 2)
    }

    // MARK: Context

    func testTheContextRoundTripsThroughTheSourceUrl() throws {
        let context = PluginPageContext(
            subject: ["kind": .string("lane"), "id": .string("lane-1")],
            surfaceId: "browser",
            placement: .popover,
            project: PluginPageProjectContext(projectId: "p1", root: "/repo", binding: "remote")
        )
        let url = try XCTUnwrap(PluginPageURLBuilder.url(pluginId: "ade-linear", path: "index.html", context: context))

        XCTAssertEqual(url.host, "ade-linear")
        XCTAssertEqual(url.path, "/index.html")
        XCTAssertEqual(PluginPageURLBuilder.decodeContext(from: url), context)
    }

    /// Half a subject is worse than none: a page cannot tell a field the host
    /// omitted from one the host truncated away.
    func testAnOversizeContextIsDroppedRatherThanTruncated() {
        let huge = String(repeating: "x", count: pluginPageContextMaxBytes + 100)
        let context = PluginPageContext(pointer: ["blob": .string(huge)])

        XCTAssertNil(PluginPageURLBuilder.encodeContext(context))
    }

    func testAnInvalidPluginIdNeverBecomesAnOrigin() {
        XCTAssertNil(PluginPageURLBuilder.url(pluginId: "../escape", path: "index.html", context: nil))
    }

    // MARK: Verbs

    @MainActor
    func testCollectionsReadFromTheLocalMirror() async throws {
        let data = FakePageDataSource()
        data.rows = [
            PluginCollectionEntry(
                pluginId: "ade-linear",
                collection: "issues",
                key: "ADE-1",
                valueJSON: "{\"title\":\"One\"}",
                updatedAt: "2026-01-01T00:00:00.000Z"
            ),
        ]
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: data, host: host)

        let one = try await bridge.handle(request(.collectionsGet, ["collection": "issues", "key": "ADE-1"]), pluginId: "ade-linear")
        XCTAssertEqual((one as? [String: Any])?["title"] as? String, "One")

        let listed = try await bridge.handle(request(.collectionsList, ["collection": "issues"]), pluginId: "ade-linear")
        XCTAssertEqual((listed as? [[String: Any]])?.count, 1)
        XCTAssertEqual(data.readPluginIds, ["ade-linear", "ade-linear"], "the id is the caller's, never the page's")
    }

    @MainActor
    func testCollectionsListIsCappedAtTheRowCeiling() async throws {
        let data = FakePageDataSource()
        let bridge = PluginPageBridge(dataSource: data, host: RecordingPageHost())

        _ = try await bridge.handle(
            request(.collectionsList, ["collection": "issues", "limit": 100_000]),
            pluginId: "ade-linear"
        )

        XCTAssertEqual(data.lastLimit, PluginPageBridge.listMaxRows)
    }

    /// A machine too old to offer the write says so by name, so a page can grey
    /// out its save button instead of throwing on every press.
    @MainActor
    func testAWriteAgainstAnOlderMachineIsUnsupportedByName() async {
        let data = FakePageDataSource()
        data.supportedActions = []
        let bridge = PluginPageBridge(dataSource: data, host: RecordingPageHost())

        do {
            _ = try await bridge.handle(
                request(.configSet, ["key": "token", "value": "x"]),
                pluginId: "ade-linear"
            )
            XCTFail("an unsupported write must refuse")
        } catch let error as PluginPageBridgeError {
            XCTAssertEqual(error.code, "unsupported")
            XCTAssertTrue(error.message.contains(PluginPageBridge.RemoteAction.setConfig))
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    @MainActor
    func testAWriteReachesTheMachineWhenItIsOffered() async throws {
        let data = FakePageDataSource()
        data.supportedActions = [PluginPageBridge.RemoteAction.putCollection]
        let bridge = PluginPageBridge(dataSource: data, host: RecordingPageHost())

        _ = try await bridge.handle(
            request(.collectionsPut, ["collection": "filters", "key": "mine", "value": "open"]),
            pluginId: "ade-linear"
        )

        XCTAssertEqual(data.remoteCalls.first?.action, PluginPageBridge.RemoteAction.putCollection)
        XCTAssertEqual(data.remoteCalls.first?.args["pluginId"] as? String, "ade-linear")
    }

    /// The control-flow answers a socket press applies today. The desktop bridge
    /// returned the raw result and the renderer ignored it, so a page could not
    /// do what a button could.
    @MainActor
    func testInvokeAppliesTheControlFlowAnswer() async throws {
        let data = FakePageDataSource()
        data.invokeResult = PluginInvokeResult(
            ok: true,
            message: "Done",
            navigate: nil,
            openURL: URL(string: "https://linear.app/issue/ADE-1"),
            openSettings: "secrets.secrets"
        )
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: data, host: host)

        let answer = try await bridge.handle(
            request(.invoke, ["actionId": "open", "args": ["id": "ADE-1"]]),
            pluginId: "ade-linear"
        ) as? [String: Any]

        XCTAssertEqual(host.applied.count, 1)
        XCTAssertEqual(host.applied.first?.pluginId, "ade-linear")
        XCTAssertEqual(answer?["ok"] as? Bool, true)
        XCTAssertEqual(answer?["message"] as? String, "Done")
        XCTAssertEqual(answer?["openedUrl"] as? Bool, true)
        XCTAssertEqual(answer?["openedSettings"] as? Bool, true)
    }

    @MainActor
    func testInvokeReportsAComposerEditBackToThePage() async throws {
        let data = FakePageDataSource()
        data.invokeResult = PluginInvokeResult(ok: true, composer: .insert("ADE-1"))
        let bridge = PluginPageBridge(dataSource: data, host: RecordingPageHost())

        let answer = try await bridge.handle(request(.invoke, ["actionId": "attach"]), pluginId: "ade-linear") as? [String: Any]

        XCTAssertEqual((answer?["composer"] as? [String: Any])?["insert"] as? String, "ADE-1")
    }

    @MainActor
    func testSurfaceCloseComposerAndClipboardReachTheHost() async throws {
        let host = RecordingPageHost()
        let pasteboard = UIPasteboard.withUniqueName()
        defer { UIPasteboard.remove(withName: pasteboard.name) }
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host, pasteboard: { pasteboard })

        _ = try await bridge.handle(request(.surfaceClose, [:]), pluginId: "ade-linear")
        _ = try await bridge.handle(request(.composerInsert, ["text": "hello"]), pluginId: "ade-linear")
        _ = try await bridge.handle(request(.composerAttach, [
            "provider": "linear", "issueId": "abc", "identifier": "ADE-1", "title": "One",
        ]), pluginId: "ade-linear")
        _ = try await bridge.handle(request(.clipboardWrite, ["text": "copied"]), pluginId: "ade-linear")
        let read = try await bridge.handle(request(.clipboardRead, [:]), pluginId: "ade-linear")

        XCTAssertEqual(host.closes, 1)
        XCTAssertEqual(host.inserted, ["hello"])
        XCTAssertEqual(host.attached.first?.identifier, "ADE-1")
        XCTAssertEqual(read as? String, "copied")
    }

    @MainActor
    func testAToastIsCappedAndReturnsAnIdToDismiss() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        let answer = try await bridge.handle(request(.uiToast, [
            "level": "warning",
            "message": String(repeating: "x", count: 1_000),
        ]), pluginId: "ade-linear") as? [String: Any]

        XCTAssertEqual(host.toasts.first?.level, .warning)
        XCTAssertEqual(host.toasts.first?.message.count, PluginPageToast.messageMaxChars)
        let id = try XCTUnwrap(answer?["id"] as? String)
        _ = try await bridge.handle(request(.uiDismissToast, ["id": id]), pluginId: "ade-linear")
        XCTAssertEqual(host.dismissed, [id])
    }

    @MainActor
    func testAnUnknownToastLevelIsRefused() async {
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: RecordingPageHost())

        do {
            _ = try await bridge.handle(request(.uiToast, ["level": "catastrophe", "message": "hi"]), pluginId: "ade-linear")
            XCTFail("an unknown level must refuse")
        } catch let error as PluginPageBridgeError {
            XCTAssertEqual(error.code, "invalid_params")
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    @MainActor
    func testConfirmReturnsTheReadersAnswer() async throws {
        let host = RecordingPageHost()
        host.confirmAnswer = true
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        let answer = try await bridge.handle(request(.uiConfirm, [
            "title": "Delete", "body": "Are you sure?", "destructive": true,
        ]), pluginId: "ade-linear")

        XCTAssertEqual(answer as? Bool, true)
        XCTAssertEqual(host.confirms.first?.destructive, true)
    }

    @MainActor
    func testOpenDeeplinkAcceptsOnlyAdeAndHttps() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        _ = try await bridge.handle(request(.openDeeplink, ["url": "ade://plugin/ade-linear/main"]), pluginId: "ade-linear")
        _ = try await bridge.handle(request(.openDeeplink, ["url": "https://linear.app"]), pluginId: "ade-linear")
        do {
            _ = try await bridge.handle(request(.openDeeplink, ["url": "file:///etc/hosts"]), pluginId: "ade-linear")
            XCTFail("a file URL must refuse")
        } catch let error as PluginPageBridgeError {
            XCTAssertEqual(error.code, "invalid_params")
        }

        XCTAssertEqual(host.deeplinks.count, 2)
    }

    @MainActor
    func testHostSubscribeNarrowsToTheKindsTheHostKnows() async throws {
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: RecordingPageHost())

        let subscribed = try await bridge.handle(
            request(.hostSubscribe, ["kinds": ["lane", "pr", "asteroid"]]),
            pluginId: "ade-linear"
        ) as? [String: Any]

        XCTAssertEqual(subscribed?["kinds"] as? [String], ["lane", "pr"])
        XCTAssertEqual(bridge.subscribedHostKinds, [.lane, .pr])

        // No kinds named means "everything", which is what a page tearing itself
        // down has to be able to say.
        _ = try await bridge.handle(request(.hostUnsubscribe, [:]), pluginId: "ade-linear")
        XCTAssertTrue(bridge.subscribedHostKinds.isEmpty)
    }

    @MainActor
    func testThemeGetAnswersWithSchemeAndTokens() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        let theme = try await bridge.handle(request(.themeGet, [:]), pluginId: "ade-linear") as? [String: Any]

        XCTAssertEqual(theme?["scheme"] as? String, "dark")
        XCTAssertEqual((theme?["tokens"] as? [String: String])?["--ade-accent"], "#a78bfa")
    }

    /// The tokens a page writes onto its own `:root`. Leading dashes intact, and
    /// every value a plain hex string — a page cannot resolve a dynamic colour.
    func testThemeSnapshotResolvesRealHexForBothSchemes() {
        let dark = PluginPageTheme.snapshot(scheme: .dark)
        let light = PluginPageTheme.snapshot(scheme: .light)

        XCTAssertEqual(dark.scheme, "dark")
        XCTAssertEqual(light.scheme, "light")
        XCTAssertNotEqual(dark.tokens["--ade-bg"], light.tokens["--ade-bg"])
        for (name, value) in dark.tokens {
            XCTAssertTrue(name.hasPrefix("--ade-"), "\(name) must be an --ade-* custom property")
            XCTAssertEqual(value.count, 7, "\(name) must be #rrggbb")
        }
    }

    // MARK: Placement and the fallback

    /// A popover on a compact screen is a sheet in every meaningful sense, so
    /// the phone says sheet rather than pretending otherwise.
    func testPopoverIsNarrowedToASheetOnACompactScreen() {
        XCTAssertEqual(PluginPageRequest.placement(requested: "popover", horizontalSizeClass: .regular), .popover)
        XCTAssertEqual(PluginPageRequest.placement(requested: "popover", horizontalSizeClass: .compact), .tab)
        XCTAssertEqual(PluginPageRequest.placement(requested: "popover", horizontalSizeClass: nil), .tab)
        XCTAssertEqual(PluginPageRequest.placement(requested: "settings-section", horizontalSizeClass: .compact), .settingsSection)
        XCTAssertEqual(PluginPageRequest.placement(requested: "composer-picker", horizontalSizeClass: .compact), .composerPicker)
        XCTAssertEqual(PluginPageRequest.placement(requested: "asteroid", horizontalSizeClass: .compact), .tab)
    }

    /// Never an "open this on your Mac" card. A phone with nothing cached draws
    /// the plugin's vocabulary panel, which is a surface the user can use.
    func testNoCachedPageFallsBackToTheVocabularyPanel() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("plugin-fallback-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = PluginPageAssetStore(root: root, bundleRoot: nil)

        XCTAssertEqual(PluginPageSurfaceResolver.state(pluginId: "ade-linear", store: store), .vocabulary)
    }

    // MARK: The openWebview answer

    func testOpenWebviewDecodesFromAnInvokeResult() throws {
        let json = Data(#"{"ok":true,"result":{"openWebview":{"surfaceId":"browser","placement":"popover"}}}"#.utf8)

        let result = try JSONDecoder().decode(PluginInvokeResult.self, from: json)

        XCTAssertEqual(result.openWebview?.surfaceId, "browser")
        XCTAssertEqual(result.openWebview?.placement, "popover")
    }

    /// A surface id is quoted back into a URL path, so an unvalidated one is a
    /// page opening something the manifest never declared.
    func testAnInvalidSurfaceIdDropsTheWholeOpenWebviewAnswer() throws {
        let json = Data(#"{"ok":true,"result":{"openWebview":{"surfaceId":"../escape"},"message":"still said"}}"#.utf8)

        let result = try JSONDecoder().decode(PluginInvokeResult.self, from: json)

        XCTAssertNil(result.openWebview)
        XCTAssertTrue(result.ok)
    }

    // MARK: Helpers

    private func request(_ method: PluginPageBridgeMethod, _ params: [String: Any]) -> PluginPageBridgeRequest {
        PluginPageBridgeRequest(
            id: "r1",
            bridgeVersion: pluginPageBridgeVersion,
            method: method,
            params: params.mapValues { PluginPageJSON.from($0) }
        )
    }
}

// MARK: - Fakes

private final class FakePageDataSource: PluginPageBridgeDataSource {
    var rows: [PluginCollectionEntry] = []
    var invokeResult = PluginInvokeResult(ok: true)
    var supportedActions: Set<String> = []
    var remoteAnswer: Any = ["ok": true]

    private(set) var readPluginIds: [String] = []
    private(set) var lastLimit: Int?
    private(set) var remoteCalls: [(action: String, args: [String: Any])] = []

    func pluginPageCollectionEntries(
        pluginId: String,
        collection: String,
        keyPrefix: String?,
        limit: Int
    ) -> [PluginCollectionEntry] {
        readPluginIds.append(pluginId)
        lastLimit = limit
        return rows
    }

    func pluginPageInvoke(pluginId: String, actionId: String, args: [String: Any]) async throws -> PluginInvokeResult {
        invokeResult
    }

    func pluginPageRemoteAction(_ action: String, args: [String: Any]) async throws -> Any {
        remoteCalls.append((action, args))
        return remoteAnswer
    }

    func pluginPageSupportsRemoteAction(_ action: String) -> Bool {
        supportedActions.contains(action)
    }
}

@MainActor
private final class RecordingPageHost: PluginPageBridgeHosting {
    var closes = 0
    var inserted: [String] = []
    var attached: [PluginPageComposerAttach] = []
    var toasts: [PluginPageToast] = []
    var dismissed: [String] = []
    var confirms: [PluginPageConfirm] = []
    var deeplinks: [URL] = []
    var applied: [(result: PluginInvokeResult, pluginId: String)] = []
    var settings: [(entryId: String?, socketId: String?)] = []
    var confirmAnswer = false
    var promptAnswer: String?

    func pluginPageCloseSurface() { closes += 1 }
    func pluginPageComposerAttach(_ attach: PluginPageComposerAttach) { attached.append(attach) }
    func pluginPageComposerInsert(_ text: String) { inserted.append(text) }

    func pluginPageShowToast(_ toast: PluginPageToast) -> String {
        toasts.append(toast)
        return "toast-\(toasts.count)"
    }

    func pluginPageDismissToast(id: String) { dismissed.append(id) }
    func pluginPagePrompt(_ prompt: PluginActionPrompt) async -> String? { promptAnswer }

    func pluginPageConfirm(_ confirm: PluginPageConfirm) async -> Bool {
        confirms.append(confirm)
        return confirmAnswer
    }

    func pluginPageOpenSettings(entryId: String?, socketId: String?) { settings.append((entryId, socketId)) }
    func pluginPageApply(_ result: PluginInvokeResult, pluginId: String) async { applied.append((result, pluginId)) }
    func pluginPageOpenDeeplink(_ url: URL) { deeplinks.append(url) }
    func pluginPageTheme() -> PluginPageThemeSnapshot { PluginPageTheme.snapshot(scheme: .dark) }
}
