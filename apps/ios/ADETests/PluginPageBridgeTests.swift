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
        // 20 + `dialog.submit` + `ui.resize`. The count is here so a verb added
        // to the closed list is a deliberate edit of the permission model
        // rather than something that arrives with a feature.
        XCTAssertEqual(PluginPageBridgeMethod.allCases.count, 22)
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

    // MARK: composer.attach

    /// The short form is the smallest ref anyone can write, and it has to become
    /// a real one: the composer attaches an issue by writing ADE's own session
    /// link, and that row is an `IssueRef` with a legacy projection beside it.
    @MainActor
    func testComposerAttachReadsTheShortFormIntoAnIssueRef() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        _ = try await bridge.handle(request(.composerAttach, [
            "provider": "Linear", "issueId": "abc", "identifier": "ADE-1",
            "title": "One", "url": "https://linear.app/x/ADE-1",
        ]), pluginId: "ade-linear")

        let ref = try XCTUnwrap(host.attached.first?.issue)
        // Lowercased: `Linear` and `linear` are one tracker, and a ref that
        // disagreed with itself would render under a different badge than the
        // rows beside it.
        XCTAssertEqual(ref.provider, "linear")
        XCTAssertEqual(ref.issueId, "abc")
        XCTAssertEqual(ref.key, "ADE-1")
        XCTAssertEqual(ref.title, "One")
        XCTAssertEqual(ref.url, "https://linear.app/x/ADE-1")
    }

    /// `dialog.submit` is gated on the HOST's word about where it drew the page.
    ///
    /// A tab that could name the issue for a dialog nobody opened would be
    /// writing into a form the reader is not looking at, so the refusal is
    /// `not_permitted` — a permanent fact about the placement, not something a
    /// retry could change.
    @MainActor
    func testDialogSubmitIsRefusedOutsideTheDialogPicker() async {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)
        bridge.placement = .tab

        do {
            _ = try await bridge.handle(request(.dialogSubmit, [
                "issue": [
                    "provider": "jira",
                    "issueId": "10001",
                    "key": "OPS-7",
                    "title": "Rotate the key",
                ],
            ]), pluginId: "ade-jira")
            XCTFail("a tab must not be able to answer a dialog")
        } catch let error as PluginPageBridgeError {
            XCTAssertEqual(error.code, "not_permitted")
        } catch {
            XCTFail("unexpected error \(error)")
        }
        XCTAssertTrue(host.dialogSubmits.isEmpty)
    }

    @MainActor
    func testDialogSubmitStampsTheCallingPluginAndCarriesAClearedSelection() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)
        bridge.placement = .dialogPicker

        _ = try await bridge.handle(request(.dialogSubmit, [
            "issue": [
                "pluginId": "ade-impostor",
                "provider": "jira",
                "issueId": "10001",
                "key": "OPS-7",
                "title": "Rotate the key",
            ],
        ]), pluginId: "ade-jira")
        XCTAssertEqual(host.dialogSubmits.first?.issue?.pluginId, "ade-jira")

        // `issue: null` is a real answer: the reader cleared the selection.
        _ = try await bridge.handle(request(.dialogSubmit, ["issue": NSNull()]), pluginId: "ade-jira")
        XCTAssertEqual(host.dialogSubmits.count, 2)
        XCTAssertNil(host.dialogSubmits.last?.issue)
    }

    /// A height report answers nothing and is clamped at the shared ceiling, so
    /// one page is the same height on the phone and on the desktop.
    @MainActor
    func testResizeReportsAClampedHeightAndAnswersNothing() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        let answer = try await bridge.handle(request(.uiResize, ["height": 420]), pluginId: "ade-jira")
        XCTAssertNil(answer)
        _ = try await bridge.handle(request(.uiResize, ["height": 99_000]), pluginId: "ade-jira")
        // Nothing usable: dropped rather than applied as zero.
        _ = try await bridge.handle(request(.uiResize, ["height": 0]), pluginId: "ade-jira")
        XCTAssertEqual(host.heights, [420, pluginPageMaxHeightPx])
    }

    /// A turn's failure sentence is the one thing a `chat` frame carries beyond
    /// identity, and only on a failure.
    @MainActor
    func testChatTurnEncodesTheFailureSentenceAndNothingElse() {
        let failed = PluginPageChatTurn(
            sessionId: "sess-1",
            state: .failed,
            turnId: "t1",
            message: String(repeating: "x", count: PluginPageChatTurn.messageMaxChars + 20)
        )
        XCTAssertEqual(failed.jsonValue["sessionId"] as? String, "sess-1")
        XCTAssertEqual(failed.jsonValue["state"] as? String, "failed")
        XCTAssertEqual((failed.jsonValue["message"] as? String)?.count, PluginPageChatTurn.messageMaxChars)

        let completed = PluginPageChatTurn(sessionId: "sess-1", state: .completed, turnId: "t1", message: "ignored")
        XCTAssertNil(completed.jsonValue["message"])
    }

    /// The owner of a link decides who may later remove it, so it is stamped
    /// from the calling guest and never read out of the body — the same rule
    /// `ade.lanes.linkIssue` follows on the machine.
    @MainActor
    func testComposerAttachStampsTheCallingPluginAsTheOwner() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        _ = try await bridge.handle(request(.composerAttach, [
            "issue": [
                "pluginId": "ade-impostor",
                "provider": "jira",
                "issueId": "10001",
                "key": "OPS-7",
                "title": "Rotate the key",
            ],
        ]), pluginId: "ade-jira")

        XCTAssertEqual(host.attached.first?.issue.pluginId, "ade-jira")
    }

    /// A page that already holds a whole ref loses nothing by sending it. The
    /// parse is `parseIssueRefValue` — the one reader of a ref on this phone —
    /// so a page's payload and a lane's row are validated by the same rule.
    @MainActor
    func testComposerAttachKeepsAWholeRefThePageSent() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        _ = try await bridge.handle(request(.composerAttach, [
            "issue": [
                "provider": "jira",
                "issueId": "10001",
                "key": "OPS-7",
                "title": "Rotate the key",
                "state": ["id": "3", "name": "In Progress", "category": "started"],
                "container": ["id": "c1", "key": "OPS", "name": "Operations"],
                "labels": ["security"],
                "extra": ["sprint": "24"],
            ],
        ]), pluginId: "ade-jira")

        let ref = try XCTUnwrap(host.attached.first?.issue)
        XCTAssertEqual(ref.state?.category, .started)
        XCTAssertEqual(ref.state?.name, "In Progress")
        XCTAssertEqual(ref.container?.key, "OPS")
        XCTAssertEqual(ref.labels, ["security"])
        XCTAssertEqual(ref.extra?["sprint"], .string("24"))
    }

    /// The host's parser requires ten non-empty fields and drops an issue that
    /// is missing one — silently, which is a chip that never appears with
    /// nothing anywhere saying why. A tracker with no team and no state is the
    /// case that exposes it.
    @MainActor
    func testTheAttachedRowFillsEveryFieldTheHostParserRequires() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        _ = try await bridge.handle(request(.composerAttach, [
            "provider": "jira", "issueId": "10001", "identifier": "OPS-7", "title": "Rotate the key",
        ]), pluginId: "ade-jira")

        let row = try XCTUnwrap(host.attached.first?.laneIssue)
        XCTAssertEqual(row.id, "10001")
        XCTAssertEqual(row.identifier, "OPS-7")
        XCTAssertEqual(row.title, "Rotate the key")
        // A tracker with no container borrows its own name, exactly as
        // `issueRefToLinearIssue` does: a mislabel on a build that predates
        // `IssueRef` is the documented price, a dropped row would not be.
        XCTAssertEqual(row.teamKey, "JIRA")
        XCTAssertEqual(row.teamId, "JIRA")
        XCTAssertEqual(row.stateId, "unstarted")
        XCTAssertEqual(row.stateName, "unstarted")
        XCTAssertEqual(row.stateType, "unstarted")
        XCTAssertFalse((row.createdAt ?? "").isEmpty)
        XCTAssertFalse((row.updatedAt ?? "").isEmpty)
        // Derived by the host on every attach, so a value invented here would be
        // the phone disagreeing with the machine about a branch it does not name.
        XCTAssertNil(row.branchName)
    }

    /// The island is what says which tracker this is. Reading it back with the
    /// same accessor every lane and PR surface uses is the round trip that
    /// proves a key spelled differently would have been caught.
    @MainActor
    func testTheAttachedRowCarriesTheRefBackUnchanged() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        _ = try await bridge.handle(request(.composerAttach, [
            "issue": [
                "provider": "jira",
                "issueId": "10001",
                "key": "OPS-7",
                "title": "Rotate the key",
                "url": "https://jira.example/OPS-7",
                "state": ["id": "3", "name": "In Progress", "category": "started"],
                "container": ["id": "c1", "key": "OPS", "name": "Operations"],
                "assignee": ["id": "u1", "name": "Ari"],
                "priority": ["rank": 2, "label": "high"],
                "labels": ["security"],
                "description": "Rotate it.",
                "createdAt": "2026-09-01T00:00:00.000Z",
                "updatedAt": "2026-09-02T00:00:00.000Z",
                "extra": ["sprint": "24"],
            ],
        ]), pluginId: "ade-jira")

        let attach = try XCTUnwrap(host.attached.first)
        XCTAssertEqual(attach.laneIssue.issueRef, attach.issue)
        // And the legacy projection still says something true to a reader that
        // has never heard of a ref.
        XCTAssertEqual(attach.laneIssue.stateName, "In Progress")
        XCTAssertEqual(attach.laneIssue.priorityLabel, "high")
    }

    /// A ref nothing can identify is refused rather than attached as a blank
    /// chip. Both shapes refuse, because both reach the same model.
    @MainActor
    func testComposerAttachRefusesAnIssueItCannotIdentify() async throws {
        let host = RecordingPageHost()
        let bridge = PluginPageBridge(dataSource: FakePageDataSource(), host: host)

        let shortForm: [String: Any] = ["provider": "linear", "issueId": "abc", "identifier": "ADE-1"]
        let wholeRef: [String: Any] = ["issue": ["provider": "jira", "issueId": "10001"]]
        for params in [shortForm, wholeRef] {
            do {
                _ = try await bridge.handle(request(.composerAttach, params), pluginId: "ade-linear")
                XCTFail("attach with no title should refuse")
            } catch let error as PluginPageBridgeError {
                XCTAssertEqual(error.code, "invalid_params")
            }
        }
        XCTAssertTrue(host.attached.isEmpty)
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
    var socketItems: [PluginPageSocketItem] = []

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

    func pluginPageSocketItems(socket: String) -> [PluginPageSocketItem] {
        socketItems.filter { $0.socket == socket }
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
    var dialogSubmits: [PluginPageDialogSubmit] = []
    var dialogSubmitAnswer = true
    var heights: [Int] = []

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

    func pluginPageDialogSubmit(_ answer: PluginPageDialogSubmit) -> Bool {
        dialogSubmits.append(answer)
        return dialogSubmitAnswer
    }

    func pluginPageResize(height: Int) { heights.append(height) }
}
