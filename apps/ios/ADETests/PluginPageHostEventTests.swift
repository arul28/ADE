import XCTest
@testable import ADE

/// What tells a plugin page that ADE's own world moved.
///
/// The producer's three rules are proved separately, because they fail in
/// different ways: the DIFF decides which ids are real, the TURN MAPPING decides
/// what counts as a turn moving, and the COALESCER decides what one wake-up of a
/// guest contains. Nothing here waits on a clock — the coalescer's window is
/// driven by the test.
@MainActor
final class PluginPageHostEventTests: XCTestCase {
    // MARK: The diff

    func testAChangedFingerprintIsTheOnlyThingReported() {
        let changed = PluginPageHostDiffer.changedIds(
            previous: ["a": "1", "b": "1", "c": "1"],
            current: ["a": "1", "b": "2", "c": "1"]
        )

        XCTAssertEqual(changed, ["b"])
    }

    /// An entity the page has never seen is one it should draw, and one that
    /// disappeared is one it must stop drawing. Reporting only updates leaves a
    /// list permanently one archive behind.
    func testAnAppearanceAndADisappearanceAreBothChanges() {
        let changed = PluginPageHostDiffer.changedIds(
            previous: ["gone": "1", "kept": "1"],
            current: ["kept": "1", "fresh": "1"]
        )

        XCTAssertEqual(changed, ["gone", "fresh"])
    }

    func testAnIdenticalSnapshotReportsNothing() {
        let snapshot = ["a": "1", "b": "2"]

        XCTAssertTrue(PluginPageHostDiffer.changedIds(previous: snapshot, current: snapshot).isEmpty)
    }

    // MARK: Turn mapping

    func testATurnStartsWhenASessionBeginsRunning() {
        let turns = PluginPageHostDiffer.chatTurns(
            previous: ["s1": observation("idle")],
            current: ["s1": observation("running")]
        )

        XCTAssertEqual(turns, [PluginPageChatTurn(sessionId: "s1", state: .started)])
    }

    func testATurnCompletesOnlyFromALiveTurn() {
        let fromRunning = PluginPageHostDiffer.chatTurns(
            previous: ["s1": observation("running")],
            current: ["s1": observation("idle")]
        )
        XCTAssertEqual(fromRunning.first?.state, .completed)

        // `awaiting` is a live turn holding for the reader, so finishing from it
        // is a completion too.
        let fromAwaiting = PluginPageHostDiffer.chatTurns(
            previous: ["s1": observation("awaiting")],
            current: ["s1": observation("ended")]
        )
        XCTAssertEqual(fromAwaiting.first?.state, .completed)
    }

    /// Telling a page a turn "completed" for work it never saw start is worse
    /// than silence — it would draw a result for a session it was not watching.
    func testASessionThatAppearsAlreadyIdleProducesNoTurn() {
        let turns = PluginPageHostDiffer.chatTurns(previous: [:], current: ["s1": observation("idle")])

        XCTAssertTrue(turns.isEmpty)
    }

    func testAFailureCarriesTheHostsOwnSentence() {
        let turns = PluginPageHostDiffer.chatTurns(
            previous: ["s1": observation("running")],
            current: ["s1": PluginPageChatObservation(status: "failed", statusNote: "The agent ran out of context.", turnId: "t9")]
        )

        XCTAssertEqual(turns.first?.state, .failed)
        XCTAssertEqual(turns.first?.message, "The agent ran out of context.")
        XCTAssertEqual(turns.first?.turnId, "t9")
    }

    /// A session that was running and still is has not moved. Reporting it on
    /// every roster republish would make a page redraw on a heartbeat.
    func testAnUnchangedStatusIsNotATurn() {
        let turns = PluginPageHostDiffer.chatTurns(
            previous: ["s1": observation("running")],
            current: ["s1": observation("running")]
        )

        XCTAssertTrue(turns.isEmpty)
    }

    func testOnlyAFailureCarriesAMessageOnTheWire() {
        let completed = PluginPageChatTurn(sessionId: "s1", state: .completed, message: "leaked?")
        let failed = PluginPageChatTurn(sessionId: "s1", state: .failed, message: "Broke.")

        XCTAssertNil(completed.jsonValue["message"])
        XCTAssertEqual(failed.jsonValue["message"] as? String, "Broke.")
    }

    func testAFailureSentenceIsCappedOnTheWire() {
        let turn = PluginPageChatTurn(
            sessionId: "s1",
            state: .failed,
            message: String(repeating: "x", count: 1_000)
        )

        XCTAssertEqual((turn.jsonValue["message"] as? String)?.count, PluginPageChatTurn.messageMaxChars)
    }

    // MARK: Coalescing

    /// A rebase moves a dozen lanes in a few milliseconds. Delivered raw that is
    /// a dozen wake-ups of a webview that will redraw once either way.
    func testOneWindowEmitsTheUnionAsASingleFrame() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let coalescer = makeCoalescer { frames.append($0) }

        coalescer.ingest(kind: .lane, ids: ["b", "a"])
        coalescer.ingest(kind: .lane, ids: ["c", "a"])
        XCTAssertTrue(frames.isEmpty, "nothing leaves before the window closes")
        coalescer.flush()

        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames.first?.kind, .lane)
        XCTAssertEqual(frames.first?.ids, ["a", "b", "c"])
        XCTAssertEqual(frames.first?.overflow, false)
    }

    func testEachKindGetsItsOwnFrame() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let coalescer = makeCoalescer { frames.append($0) }

        coalescer.ingest(kind: .pr, ids: ["pr-1"])
        coalescer.ingest(kind: .lane, ids: ["lane-1"])
        coalescer.flush()

        // Emitted in the enum's own order, so a page logging frames sees a
        // stable sequence for the same window.
        XCTAssertEqual(frames.map(\.kind), [.lane, .pr])
    }

    func testAnEmptyWindowEmitsNothing() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let coalescer = makeCoalescer { frames.append($0) }

        coalescer.flush()

        XCTAssertTrue(frames.isEmpty)
    }

    /// A turn that started and then failed inside one window is one fact, and
    /// the fact is the failure. Keeping both would make a page draw a spinner it
    /// must immediately replace with an error.
    func testALaterTurnReplacesAnEarlierOneForTheSameSession() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let coalescer = makeCoalescer { frames.append($0) }

        coalescer.ingest(turns: [PluginPageChatTurn(sessionId: "s1", state: .started)])
        coalescer.ingest(turns: [PluginPageChatTurn(sessionId: "s1", state: .failed, message: "Broke.")])
        coalescer.flush()

        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames.first?.turns.count, 1)
        XCTAssertEqual(frames.first?.turns.first?.state, .failed)
        XCTAssertEqual(frames.first?.ids, ["s1"], "a turn also names its session on the chat frame")
    }

    func testTooManyIdsBecomeAnOverflow() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let coalescer = makeCoalescer { frames.append($0) }
        let many = Set((0..<(PluginPageHostEventLimits.maxIds + 10)).map { String(format: "lane-%04d", $0) })

        coalescer.ingest(kind: .lane, ids: many)
        coalescer.flush()

        XCTAssertEqual(frames.first?.ids.count, PluginPageHostEventLimits.maxIds)
        XCTAssertEqual(frames.first?.overflow, true)
        // Sorted before capping, so which ids survive is deterministic rather
        // than whatever the set happened to hash to.
        XCTAssertEqual(frames.first?.ids.first, "lane-0000")
    }

    func testTooManyTurnsBecomeAnOverflow() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let coalescer = makeCoalescer { frames.append($0) }
        let turns = (0..<(PluginPageChatTurn.turnsMax + 5)).map {
            PluginPageChatTurn(sessionId: String(format: "s-%04d", $0), state: .started)
        }

        coalescer.ingest(turns: turns)
        coalescer.flush()

        XCTAssertEqual(frames.first?.turns.count, PluginPageChatTurn.turnsMax)
        XCTAssertEqual(frames.first?.overflow, true)
    }

    func testTheWindowMatchesTheDesktopCoalesceWindow() {
        XCTAssertEqual(PluginPageHostCoalescer.windowMs, 120)
    }

    // MARK: The source

    /// A page that has only just subscribed already read the world on its first
    /// render. Telling it every lane changed would make that render happen twice.
    func testSubscribingTakesABaselineWithoutEmitting() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let world = FakeHostWorld()
        world.fingerprints[.lane] = ["lane-1": "open", "lane-2": "open"]
        let source = makeSource(world: world) { frames.append($0) }

        source.subscribe(to: [.lane])
        source.scan(kinds: [.lane])
        source.flushForTests()

        XCTAssertTrue(frames.isEmpty)
    }

    func testAScanAfterTheBaselineReportsOnlyWhatMoved() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let world = FakeHostWorld()
        world.fingerprints[.lane] = ["lane-1": "open", "lane-2": "open"]
        let source = makeSource(world: world) { frames.append($0) }
        source.subscribe(to: [.lane])

        world.fingerprints[.lane] = ["lane-1": "open", "lane-2": "merged"]
        source.scan(kinds: [.lane])
        source.flushForTests()

        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames.first?.ids, ["lane-2"])
    }

    /// The cost of this whole producer is zero for a page that does not use it.
    func testAKindNobodySubscribedToIsNeverRead() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let world = FakeHostWorld()
        world.fingerprints[.pr] = ["pr-1": "open"]
        let source = makeSource(world: world) { frames.append($0) }
        source.subscribe(to: [.lane])

        world.fingerprints[.pr] = ["pr-1": "merged"]
        source.scan(kinds: [.pr])
        source.flushForTests()

        XCTAssertTrue(frames.isEmpty)
        XCTAssertFalse(world.readKinds.contains(.pr))
    }

    func testChatScansProduceTurnsAndSessionIds() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let world = FakeHostWorld()
        world.chats = ["s1": observation("idle")]
        let source = makeSource(world: world) { frames.append($0) }
        source.subscribe(to: [.chat])

        world.chats = ["s1": observation("running")]
        source.scan(kinds: [.chat])
        source.flushForTests()

        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames.first?.kind, .chat)
        XCTAssertEqual(frames.first?.turns.first?.state, .started)
        XCTAssertEqual(frames.first?.ids, ["s1"])
    }

    func testUnsubscribingStopsTheDiffAndDropsTheSnapshot() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let world = FakeHostWorld()
        world.fingerprints[.lane] = ["lane-1": "open"]
        let source = makeSource(world: world) { frames.append($0) }
        source.subscribe(to: [.lane])
        source.unsubscribe(from: [.lane])

        world.fingerprints[.lane] = ["lane-1": "merged"]
        source.scan(kinds: [.lane])
        source.flushForTests()

        XCTAssertTrue(frames.isEmpty)
    }

    /// Re-subscribing must re-baseline rather than replay everything that moved
    /// while nobody was listening.
    func testResubscribingRebaselines() {
        var frames: [PluginPageHostCoalescer.Frame] = []
        let world = FakeHostWorld()
        world.fingerprints[.lane] = ["lane-1": "open"]
        let source = makeSource(world: world) { frames.append($0) }
        source.subscribe(to: [.lane])
        source.unsubscribe(from: [.lane])

        world.fingerprints[.lane] = ["lane-1": "merged"]
        source.subscribe(to: [.lane])
        source.scan(kinds: [.lane])
        source.flushForTests()

        XCTAssertTrue(frames.isEmpty)
    }

    // MARK: Helpers

    private func observation(_ status: String) -> PluginPageChatObservation {
        PluginPageChatObservation(status: status, statusNote: nil, turnId: nil)
    }

    /// A coalescer whose window never elapses on its own, so a test decides when
    /// a frame is sent instead of waiting on a clock.
    private func makeCoalescer(
        emit: @escaping (PluginPageHostCoalescer.Frame) -> Void
    ) -> PluginPageHostCoalescer {
        PluginPageHostCoalescer(emit: emit, sleep: { _ in
            // Never returns, so the scheduled flush cannot fire; `flush()` is
            // the only path a test exercises.
            await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
        })
    }

    private func makeSource(
        world: FakeHostWorld,
        emit: @escaping (PluginPageHostCoalescer.Frame) -> Void
    ) -> PluginPageHostEventSource {
        PluginPageHostEventSource(world: world, coalescer: makeCoalescer(emit: emit))
    }
}

/// The phone's world, scripted.
@MainActor
private final class FakeHostWorld: PluginPageHostWorldReading {
    var fingerprints: [PluginPageHostKind: PluginPageHostFingerprints] = [:]
    var chats: [String: PluginPageChatObservation] = [:]
    private(set) var readKinds: Set<PluginPageHostKind> = []

    func pluginPageHostFingerprints(kind: PluginPageHostKind) -> PluginPageHostFingerprints {
        readKinds.insert(kind)
        return fingerprints[kind] ?? [:]
    }

    func pluginPageChatObservations() -> [String: PluginPageChatObservation] {
        readKinds.insert(.chat)
        return chats
    }
}
