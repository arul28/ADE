import UIKit
import XCTest
@testable import ADE

/// Mobile thread engine (units I2–I4): log merge, incremental fold, disk
/// persistence, overlays, registry eviction and routing. Numbered edge cases
/// refer to `.ade/plans/mobile-thread-engine.md` "Edge cases".
@MainActor
final class ChatThreadEngineTests: XCTestCase {
  // MARK: - Incremental fold == full rebuild (local-only gate)

  /// Replays the last 1,500 events of real transcripts through the engine, one
  /// live event at a time and in seeded random batches of 1–20, and after
  /// every step requires the engine's frame to equal a from-scratch
  /// `buildWorkChatTimelineSnapshot` + presentation over the frame's own
  /// transcript. Opt-in because it takes minutes: run it with
  /// `TEST_RUNNER_ADE_THREAD_EQUIVALENCE=1 xcodebuild test-without-building
  /// -only-testing:ADETests/ChatThreadEngineTests/testIncrementalFoldMatchesFullRebuildOnRealTranscripts`
  /// after any change to the fold or the timeline builders. Skips on machines
  /// without the transcript folder.
  func testIncrementalFoldMatchesFullRebuildOnRealTranscripts() async throws {
    try XCTSkipUnless(
      ProcessInfo.processInfo.environment["ADE_THREAD_EQUIVALENCE"] == "1",
      "set ADE_THREAD_EQUIVALENCE=1 to run the real-transcript equivalence gate"
    )
    let paths = chatThreadEquivalenceTranscriptPaths()
    try XCTSkipIf(paths.isEmpty, "no local transcripts")
    var stepsChecked = 0
    var summary: [String] = []
    for path in paths {
      let events = WorkChatScrollBenchLoader.load(path: path, limit: 2_000)
      guard events.count > 1 else { continue }
      let replayCount = min(1_500, events.count - 1)
      let base = Array(events.dropLast(replayCount))
      let replay = Array(events.suffix(replayCount))
      let name = (path as NSString).lastPathComponent
      var rng = ChatThreadSeededGenerator(seed: 0xC0FFEE)
      var batched: [[ChatThreadLiveEvent]] = []
      var cursor = 0
      while cursor < replay.count {
        let size = Int.random(in: 1...20, using: &rng)
        batched.append(Array(replay[cursor..<min(replay.count, cursor + size)]))
        cursor += size
      }
      for (mode, batches) in [("single", replay.map { [$0] }), ("batched", batched)] {
        let overlays = liveOverlays()
        let engine = ChatThreadEngine(
          key: ChatThreadKey(machineKey: "m", sessionId: base.first?.envelope.sessionId ?? "s", scope: .personal),
          store: nil
        )
        _ = await engine.setOverlays(overlays)
        await engine.ingest(.snapshot(ChatThreadSnapshotInput(
          sessionId: base.first?.envelope.sessionId ?? "s",
          events: base,
          hasOlderHistory: false,
          turnActive: true,
          hostSupportsChatLogV2: true
        )))
        var frame = await engine.flush()
        if let mismatch = chatThreadFrameMismatch(frame, overlays: overlays) {
          XCTFail("\(name) \(mode) snapshot: \(mismatch)")
          continue
        }
        stepsChecked += 1
        var failed = false
        var resumed = 0
        for (step, batch) in batches.enumerated() {
          await engine.ingest(.live(batch))
          frame = await engine.flush()
          if case .resumed = await engine.lastTimelinePass { resumed += 1 }
          if let mismatch = chatThreadFrameMismatch(frame, overlays: overlays) {
            let types = batch.map(\.envelope.event.typeName).joined(separator: ",")
            XCTFail("\(name) \(mode) step \(step) [\(types)]: \(mismatch)")
            failed = true
            break
          }
          stepsChecked += 1
        }
        summary.append("\(name.prefix(8)) \(mode) steps=\(batches.count) resumed=\(resumed)\(failed ? " FAILED" : "")")
      }
    }
    print("EQUIV transcripts=\(paths.count) steps=\(stepsChecked)\n" + summary.joined(separator: "\n"))
  }

  private var directory: URL!
  private let sessionId = "chat-1"

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("ChatThreadEngineTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  // MARK: - Fixtures

  private var key: ChatThreadKey {
    ChatThreadKey(machineKey: "machine:mac-1", sessionId: sessionId, scope: .project("p1"))
  }

  private func makeStore() -> ChatLogStore {
    ChatLogStore(directoryURL: directory)
  }

  private func makeEngine(
    store: ChatLogStore? = nil,
    signals: SignalBox? = nil,
    key: ChatThreadKey? = nil
  ) -> ChatThreadEngine {
    let box = signals
    return ChatThreadEngine(key: key ?? self.key, store: store) { signal in
      box?.append(signal)
    }
  }

  private static let timestampFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private func timestamp(_ offset: Int) -> String {
    Self.timestampFormatter.string(from: Date(timeIntervalSince1970: 1_790_000_000 + Double(offset)))
  }

  /// A wire envelope dictionary, decoded exactly the way SyncService does.
  private func event(
    _ sequence: Int?,
    _ body: [String: Any],
    at offset: Int? = nil,
    sequenceStart: Int? = nil
  ) -> ChatThreadLiveEvent {
    var dict: [String: Any] = [
      "sessionId": sessionId,
      "timestamp": timestamp(offset ?? sequence ?? 0),
      "event": body,
    ]
    if let sequence { dict["sequence"] = sequence }
    if let sequenceStart { dict["sequenceStart"] = sequenceStart }
    guard let decoded = chatThreadDecodeLiveEvent(dict) else {
      XCTFail("fixture failed to decode: \(body)")
      fatalError()
    }
    return decoded
  }

  private func user(_ sequence: Int?, _ text: String, turn: String? = nil, steerId: String? = nil, delivery: String? = nil, processed: Bool? = nil, at offset: Int? = nil) -> ChatThreadLiveEvent {
    var body: [String: Any] = ["type": "user_message", "text": text]
    if let turn { body["turnId"] = turn }
    if let steerId { body["steerId"] = steerId }
    if let delivery { body["deliveryState"] = delivery }
    if let processed { body["processed"] = processed }
    return event(sequence, body, at: offset)
  }

  private func text(_ sequence: Int?, _ text: String, item: String = "msg-1", turn: String = "turn-1", sequenceStart: Int? = nil, at offset: Int? = nil) -> ChatThreadLiveEvent {
    event(sequence, ["type": "text", "text": text, "itemId": item, "turnId": turn], at: offset, sequenceStart: sequenceStart)
  }

  private func status(_ sequence: Int?, _ turnStatus: String, turn: String = "turn-1") -> ChatThreadLiveEvent {
    event(sequence, ["type": "status", "turnStatus": turnStatus, "turnId": turn])
  }

  private func approval(_ sequence: Int, item: String, turn: String = "turn-1") -> ChatThreadLiveEvent {
    event(sequence, [
      "type": "approval_request",
      "itemId": item,
      "kind": "command",
      "description": "Run the migration",
      "turnId": turn,
    ])
  }

  private func snapshot(
    _ events: [ChatThreadLiveEvent],
    v2: Bool = true,
    generation: Int? = 1,
    resumed: Bool = false,
    resumeKind: String? = nil,
    gap: Bool = false,
    pinned: [ChatThreadLiveEvent] = [],
    hasOlder: Bool? = false,
    tailStartOffset: Int? = nil
  ) -> ChatThreadIngest {
    .snapshot(ChatThreadSnapshotInput(
      sessionId: sessionId,
      events: events,
      pinnedEvents: pinned,
      resumed: resumed,
      resumeKind: resumeKind,
      gap: gap,
      historyGeneration: v2 ? generation : nil,
      hasOlderHistory: hasOlder,
      tailStartOffset: tailStartOffset,
      cursorKind: tailStartOffset == nil ? nil : "byte",
      turnActive: nil,
      truncated: false,
      sessionFound: true,
      capturedAt: timestamp(0),
      hostSupportsChatLogV2: v2
    ))
  }

  private func messages(_ frame: ChatThreadFrame?) -> [WorkChatMessage] {
    (frame?.snapshot.timeline ?? []).compactMap { entry in
      if case .message(let message) = entry.payload { return message }
      return nil
    }
  }

  private func texts(_ frame: ChatThreadFrame?) -> [String] {
    messages(frame).map { "\($0.role):\($0.markdown)" }
  }

  private func storedSequences(_ store: ChatLogStore) async -> [Int] {
    await store.loadTail(key.logKey, maxEvents: 10_000, maxBytes: 100_000_000).events.map(\.sequence)
  }

  private func liveOverlays(status: String = "active") -> ChatThreadOverlays {
    var overlays = ChatThreadOverlays()
    overlays.sessionStatus = status
    overlays.summary.isLive = true
    overlays.summary.provider = "claude"
    return overlays
  }

  // MARK: - 1. Generation bump

  func testGenerationBumpDropsCacheAndResetsToNewHistory() async {
    let store = makeStore()
    let engine = makeEngine(store: store)
    await engine.ingest(snapshot([user(1, "old question"), text(2, "old answer")], generation: 1))
    _ = await engine.flush()

    // Splice repair on the host: generation 2, rewritten history.
    await engine.ingest(snapshot([user(1, "new question"), text(2, "new answer")], generation: 2))
    let frame = await engine.flush()

    XCTAssertEqual(texts(frame), ["user:new question", "assistant:new answer"])
    XCTAssertTrue(frame?.didResetHistory == true, "view must drop its anchor and pin to the bottom")
    XCTAssertEqual(frame?.resumePoint, ChatThreadResumePoint(sinceSequence: 2, generation: 2))

    await engine.flushPersistence()
    let stored = await store.loadTail(key.logKey, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(stored.meta?.generation, 2)
    XCTAssertEqual(stored.events.map(\.sequence), [1, 2])
    let payloadText = String(decoding: stored.events[0].payload, as: UTF8.self)
    XCTAssertTrue(payloadText.contains("new question"))
  }

  // MARK: - 2. Brain restart, durable resume

  func testDurableResumeAfterBrainRestartKeepsCacheAndAppends() async {
    let store = makeStore()
    let engine = makeEngine(store: store)
    await engine.ingest(snapshot([user(1, "hi", turn: "t1"), text(2, "hello", turn: "t1"), text(3, " there", turn: "t1")], generation: 7))
    _ = await engine.flush()

    // The brain restarted: the transport watermark is gone, the durable one is not.
    let resume = await engine.resumePoint
    XCTAssertEqual(resume, ChatThreadResumePoint(sinceSequence: 3, generation: 7))
    let fields = chatThreadSubscribeResumeFields(
      hostSupportsChatLogV2: true,
      includeResume: true,
      resumePoint: resume,
      legacySinceSeq: nil
    )
    XCTAssertEqual(fields["sinceSequence"] as? Int, 3)
    XCTAssertEqual(fields["generation"] as? Int, 7)
    XCTAssertEqual(fields["chatLogV2"] as? Bool, true)
    XCTAssertNil(fields["sinceSeq"])

    // Ack resumed by sequence; missed events follow on the live stream.
    await engine.ingest(snapshot([], generation: 7, resumed: true, resumeKind: "sequence"))
    await engine.ingest(.live([user(4, "next", turn: "t2"), text(5, "sure", item: "msg-2", turn: "t2")]))
    let frame = await engine.flush()

    XCTAssertEqual(texts(frame), ["user:hi", "assistant:hello there", "user:next", "assistant:sure"])
    await engine.flushPersistence()
    let sequences = await storedSequences(store)
    XCTAssertEqual(sequences, [1, 2, 3, 4, 5])
  }

  // MARK: - 3. Gap larger than the resume cap

  func testGapSnapshotDropsCachedRowsBelowIt() async {
    let store = makeStore()
    await store.append(key.logKey, events: [user(1, "ancient"), text(2, "ancient answer")].map(stored), generation: 1)
    await store.flush()

    let engine = makeEngine(store: store)
    await engine.loadCache()
    let disk = await engine.flush()
    XCTAssertEqual(disk?.cacheOrigin, .disk)
    XCTAssertEqual(texts(disk), ["user:ancient", "assistant:ancient answer"])

    await engine.ingest(snapshot([user(50, "recent"), text(51, "recent answer", item: "msg-9")], generation: 1, gap: true))
    let frame = await engine.flush()

    XCTAssertEqual(texts(frame), ["user:recent", "assistant:recent answer"])
    await engine.flushPersistence()
    let sequences = await storedSequences(store)
    XCTAssertEqual(sequences, [50, 51])
  }

  func testHoleBetweenCacheAndSnapshotIsTreatedAsGap() async {
    let engine = makeEngine()
    await engine.ingest(.cached(meta: nil, events: [user(1, "cached"), text(2, "cached answer")].map(stored)))
    // No gap flag, but sequences 3...49 are missing: never show 1–2 above 50.
    await engine.ingest(snapshot([user(50, "recent")], generation: nil))
    let frame = await engine.flush()
    XCTAssertEqual(texts(frame), ["user:recent"])
  }

  // MARK: - 5. Unsequenced live events

  func testUnsequencedLiveEventsFoldButAreNeverCached() async {
    let store = makeStore()
    let engine = makeEngine(store: store)
    await engine.ingest(snapshot([user(1, "go")], generation: 1))
    await engine.ingest(.live([
      event(nil, ["type": "api_retry", "attempt": 1], at: 2),
      event(nil, ["type": "session_meta_updated", "title": "Renamed"], at: 3),
    ]))
    let frame = await engine.flush()

    XCTAssertEqual(frame?.transcript.filter { $0.sequence == nil }.count, 2, "folded live")
    await engine.flushPersistence()
    let sequences = await storedSequences(store)
    XCTAssertEqual(sequences, [1], "unsequenced rows are never stored")
  }

  func testHistoryInvalidatedDropsEverythingAndAsksForASnapshot() async {
    let store = makeStore()
    let signals = SignalBox()
    let engine = makeEngine(store: store, signals: signals)
    await engine.ingest(snapshot([user(1, "go"), text(2, "ok")], generation: 1))
    _ = await engine.flush()

    await engine.ingest(.live([event(nil, ["type": "session_meta_updated", "historyInvalidated": true], at: 3)]))
    let frame = await engine.flush()

    XCTAssertTrue(signals.needsSnapshotCount >= 1)
    XCTAssertEqual(texts(frame), [])
    XCTAssertEqual(frame?.loadState, .loading)
    XCTAssertTrue(frame?.didResetHistory == true)
    XCTAssertNil(frame?.resumePoint)
    await engine.flushPersistence()
    let sequences = await storedSequences(store)
    XCTAssertEqual(sequences, [])
  }

  // MARK: - 6. Steers, resolutions, retractions

  func testGraduatedQueuedSteerRendersOnce() async {
    let engine = makeEngine()
    await engine.ingest(snapshot([user(1, "start", turn: "t1"), text(2, "working", turn: "t1")]))
    _ = await engine.flush()

    await engine.ingest(.live([user(3, "also do this", turn: "t1", steerId: "s1", delivery: "queued")]))
    let queued = await engine.flush()
    XCTAssertEqual(queued?.pendingSteers.map(\.id), ["s1"])

    await engine.ingest(.live([user(4, "also do this", turn: "t2", steerId: "s1", delivery: "delivered")]))
    let frame = await engine.flush()
    XCTAssertEqual(frame?.pendingSteers.map(\.id), [])
    XCTAssertEqual(messages(frame).filter { $0.role == "user" && $0.markdown == "also do this" }.count, 1)
  }

  func testUserMessageResolutionAttachesToItsMessage() async {
    let engine = makeEngine()
    await engine.ingest(snapshot([
      user(1, "unprocessed ask", turn: "t1", steerId: "s2", delivery: "delivered", processed: false),
      event(2, [
        "type": "user_message_resolution",
        "steerId": "s2",
        "action": "dismiss",
        "state": "dismissed",
        "resolvedAt": timestamp(2),
      ]),
    ]))
    let frame = await engine.flush()
    let message = messages(frame).first { $0.markdown == "unprocessed ask" }
    XCTAssertEqual(message?.unprocessedResolution?.action, "dismiss")
  }

  func testTranscriptRetractionRemovesTheAssistantMessage() async {
    let engine = makeEngine()
    await engine.ingest(snapshot([user(1, "q"), text(2, "draft answer", item: "msg-a")]))
    _ = await engine.flush()
    await engine.ingest(.live([event(3, ["type": "transcript_retraction", "messageIds": ["msg-a"]])]))
    let frame = await engine.flush()
    XCTAssertEqual(texts(frame), ["user:q"])
  }

  // MARK: - 7. Pinned approval older than the window

  func testPinnedApprovalOutsideTheWindowIsStillPending() async {
    let engine = makeEngine()
    await engine.ingest(snapshot(
      [user(100, "later", turn: "turn-1"), text(101, "still waiting", turn: "turn-1")],
      pinned: [approval(5, item: "approval-1")]
    ))
    let frame = await engine.flush()
    XCTAssertEqual(frame?.pendingInputs.map(\.itemId), ["approval-1"])
  }

  // MARK: - 8. Resolution for an approval not in the window

  func testResolutionForUnknownApprovalIsHarmless() async {
    let engine = makeEngine()
    await engine.ingest(snapshot([
      user(1, "q"),
      event(2, ["type": "pending_input_resolved", "itemId": "ghost", "resolution": "accepted"]),
      text(3, "done"),
    ]))
    let frame = await engine.flush()
    XCTAssertEqual(frame?.pendingInputs.count, 0)
    XCTAssertEqual(texts(frame), ["user:q", "assistant:done"])
  }

  // MARK: - 10. Subagent child whose parent arrived in an earlier delta

  func testSubagentChildFromLaterDeltaIsFiltered() async {
    let engine = makeEngine()
    await engine.ingest(snapshot([user(1, "spawn one")]))
    await engine.ingest(.live([
      event(2, ["type": "tool_call", "tool": "Task", "args": [:], "itemId": "tool-parent", "turnId": "turn-1"]),
      event(3, ["type": "subagent_started", "taskId": "task-1", "parentToolUseId": "tool-parent", "description": "look around", "turnId": "turn-1"]),
    ]))
    _ = await engine.flush()

    await engine.ingest(.live([
      event(4, ["type": "tool_call", "tool": "Read", "args": [:], "itemId": "child-1", "parentItemId": "tool-parent", "turnId": "turn-1"]),
      event(5, ["type": "tool_result", "tool": "Read", "result": "x", "itemId": "child-1", "turnId": "turn-1"]),
    ]))
    let frame = await engine.flush()

    let childRows = frame?.transcript.filter { envelope in
      switch envelope.event {
      case .toolCall(_, _, let itemId, _, _), .toolResult(_, _, let itemId, _, _, _):
        return itemId == "child-1"
      default:
        return false
      }
    } ?? []
    XCTAssertTrue(childRows.isEmpty)
  }

  func testSubagentChildBeforeItsParentIsFilteredRetroactively() async {
    let engine = makeEngine()
    await engine.ingest(snapshot([user(1, "spawn")]))
    await engine.ingest(.live([
      event(2, ["type": "tool_call", "tool": "Read", "args": [:], "itemId": "child-2", "parentItemId": "tool-p2", "turnId": "turn-1"]),
    ]))
    _ = await engine.flush()
    await engine.ingest(.live([
      event(3, ["type": "subagent_started", "taskId": "task-2", "parentToolUseId": "tool-p2", "description": "d", "turnId": "turn-1"]),
    ]))
    let frame = await engine.flush()
    let full = makeWorkChatTranscript(from: [user(1, "spawn"), event(2, ["type": "tool_call", "tool": "Read", "args": [:], "itemId": "child-2", "parentItemId": "tool-p2", "turnId": "turn-1"]), event(3, ["type": "subagent_started", "taskId": "task-2", "parentToolUseId": "tool-p2", "description": "d", "turnId": "turn-1"])].map(\.envelope))
    XCTAssertEqual(frame?.transcript.count, full.count, "incremental filter matches the whole-window builder")
  }

  // MARK: - 11. Folded replay rows over cached deltas

  func testFoldedReplayRowReplacesCachedDeltas() async {
    let engine = makeEngine()
    await engine.ingest(.cached(meta: nil, events: [
      user(4, "q"), text(5, "Hel"), text(6, "lo "), text(7, "world"),
    ].map(stored)))
    _ = await engine.flush()

    await engine.ingest(snapshot([user(4, "q"), text(7, "Hello world", sequenceStart: 5)]))
    let frame = await engine.flush()
    XCTAssertEqual(texts(frame), ["user:q", "assistant:Hello world"])
  }

  func testFoldedLiveRowReplacesDeltasItCovers() async {
    let engine = makeEngine()
    await engine.ingest(snapshot([user(1, "q"), text(2, "Hel"), text(3, "lo")]))
    _ = await engine.flush()
    await engine.ingest(.live([text(3, "Hello", sequenceStart: 2)]))
    let frame = await engine.flush()
    XCTAssertEqual(texts(frame), ["user:q", "assistant:Hello"])
  }

  // MARK: - 12. Duplicate delivery

  func testDuplicateDeliveryAddsNoRows() async {
    let store = makeStore()
    let engine = makeEngine(store: store)
    let events = [user(1, "q"), text(2, "answer")]
    await engine.ingest(snapshot(events))
    let first = await engine.flush()
    await engine.ingest(.live(events))
    await engine.ingest(.live([text(2, "answer")]))
    let frame = await engine.flush()
    XCTAssertEqual(texts(frame), texts(first))
    XCTAssertEqual(texts(frame), ["user:q", "assistant:answer"])
    await engine.flushPersistence()
    let sequences = await storedSequences(store)
    XCTAssertEqual(sequences, [1, 2])
  }

  // MARK: - 13. Out-of-order arrival

  func testOutOfOrderArrivalIsOrderedBySequence() async {
    let engine = makeEngine()
    await engine.ingest(snapshot([user(1, "first", turn: "t1"), text(2, "a1", item: "m1", turn: "t1")]))
    _ = await engine.flush()
    await engine.ingest(.live([text(4, "a2", item: "m2", turn: "t2")]))
    await engine.ingest(.live([user(3, "second", turn: "t2")]))
    let frame = await engine.flush()
    XCTAssertEqual(texts(frame), ["user:first", "assistant:a1", "user:second", "assistant:a2"])
    XCTAssertEqual(frame?.resumePoint?.sinceSequence, 4)
  }

  // MARK: - 14. A 2 MB event

  func testTwoMegabyteEventIsStoredAndRendered() async {
    let store = makeStore()
    let engine = makeEngine(store: store)
    // Distinct words: a repeated phrase is a replay the message fold
    // collapses (same as a full rebuild), which is not what this case tests.
    let big = (0..<200_000).map { "word\($0)" }.joined(separator: " ") // ~2.1 MB
    await engine.ingest(snapshot([user(1, "dump it")]))
    await engine.ingest(.live([text(2, big)]))
    let frame = await engine.flush()
    XCTAssertEqual(messages(frame).last?.markdown.utf8.count, big.utf8.count)

    await engine.flushPersistence()
    let stored = await store.loadTail(key.logKey, maxEvents: 10, maxBytes: 100_000_000)
    XCTAssertEqual(stored.events.last?.sequence, 2)
    XCTAssertGreaterThan(stored.events.last?.payload.count ?? 0, 2_000_000)
  }

  // MARK: - 16. Memory warning

  func testMemoryWarningEvictsAllButOpenAndLiveTurns() async {
    let registry = ChatThreadRegistry(store: nil)
    let open = ChatThreadKey(machineKey: "m", sessionId: "open", scope: .project("p"))
    let idle = ChatThreadKey(machineKey: "m", sessionId: "idle", scope: .project("p"))
    let live = ChatThreadKey(machineKey: "m", sessionId: "live", scope: .project("p"))
    _ = registry.attach(open)
    _ = registry.model(for: idle)
    let liveModel = registry.model(for: live)
    await liveModel.engine.setOverlays(liveOverlays())
    await liveModel.engine.ingest(.live([status(1, "started")]))
    guard let liveFrame = await liveModel.engine.flush() else { return XCTFail("no frame") }
    XCTAssertTrue(liveFrame.isStreamingTurn)
    registry.frameApplied(liveFrame, key: live)

    registry.evictForMemoryWarning()

    XCTAssertTrue(registry.hasEngine(for: open))
    XCTAssertTrue(registry.hasEngine(for: live))
    XCTAssertFalse(registry.hasEngine(for: idle))
  }

  func testWarmLimitEvictsLeastRecentlyUsed() {
    let registry = ChatThreadRegistry(store: nil)
    let keys = (0..<(ChatThreadRegistry.warmLimit + 2)).map {
      ChatThreadKey(machineKey: "m", sessionId: "s\($0)", scope: .project("p"))
    }
    for key in keys { _ = registry.model(for: key) }
    XCTAssertEqual(registry.warmKeys.count, ChatThreadRegistry.warmLimit)
    XCTAssertFalse(registry.hasEngine(for: keys[0]))
    XCTAssertTrue(registry.hasEngine(for: keys.last!))
  }

  // MARK: - 20. Scopes

  func testScopesKeepSeparateEnginesAndRouting() async throws {
    let registry = ChatThreadRegistry(store: nil)
    let projectKey = ChatThreadKey(machineKey: "m", sessionId: sessionId, scope: .project("p1"))
    let personalKey = ChatThreadKey(machineKey: "m", sessionId: sessionId, scope: .personal)
    XCTAssertNotEqual(projectKey.logKey, personalKey.logKey)
    let projectModel = registry.model(for: projectKey)
    let personalModel = registry.model(for: personalKey)
    XCTAssertFalse(projectModel === personalModel)

    registry.routeLive(user(1, "only in project"), key: projectKey)
    let deadline = Date().addingTimeInterval(3)
    var projectFrame: ChatThreadFrame?
    while Date() < deadline {
      try await Task.sleep(nanoseconds: 20_000_000)
      projectFrame = await projectModel.engine.flush()
      if !texts(projectFrame).isEmpty { break }
    }
    XCTAssertEqual(texts(projectFrame), ["user:only in project"])
    let personalFrame = await personalModel.engine.flush()
    XCTAssertEqual(texts(personalFrame), [])
  }

  // MARK: - 22. Host without chatLogV2

  func testOldHostSnapshotMidTurnFetchesBoundaryPageBeforeShowing() async {
    let signals = SignalBox()
    let engine = makeEngine(signals: signals)
    await engine.ingest(snapshot(
      [text(10, "…middle of an answer"), text(11, " and the end")],
      v2: false,
      hasOlder: true,
      tailStartOffset: 5_000
    ))
    _ = await engine.flush()
    XCTAssertEqual(signals.boundaryPageCount, 1)
    XCTAssertEqual(signals.frameCount, 0, "no host frame until the boundary page lands")

    let request = await engine.beginOlderHostRequest()
    XCTAssertEqual(request, .beforeOffset(5_000))

    await engine.ingest(.olderPage(ChatThreadOlderPageInput(
      sessionId: sessionId,
      events: [user(9, "the question")],
      hasMore: false,
      startOffset: 0
    )))
    let frame = await engine.flush()
    XCTAssertGreaterThan(signals.frameCount, 0)
    XCTAssertEqual(texts(frame).first, "user:the question")

    let fields = chatThreadSubscribeResumeFields(
      hostSupportsChatLogV2: false,
      includeResume: true,
      resumePoint: ChatThreadResumePoint(sinceSequence: 11, generation: nil),
      legacySinceSeq: 42
    )
    XCTAssertEqual(fields["sinceSeq"] as? Int, 42)
    XCTAssertNil(fields["sinceSequence"])
    XCTAssertNil(fields["chatLogV2"])
  }

  // MARK: - 23. Local echo and optimistic steer

  func testLocalEchoAndOptimisticSteerAreInTheOverlayFrame() async {
    let engine = makeEngine()
    await engine.ingest(snapshot([user(1, "q"), text(2, "a")]))
    _ = await engine.flush()

    var overlays = liveOverlays(status: "idle")
    overlays.localEchoMessages = [WorkLocalEchoMessage(text: "sent from phone", timestamp: timestamp(3))]
    let echoFrame = await engine.setOverlays(overlays)
    XCTAssertTrue(echoFrame?.isUrgent == true)
    XCTAssertEqual(texts(echoFrame).last, "user:sent from phone")

    overlays.optimisticPendingSteers = [WorkPendingSteerModel(
      id: "local-steer",
      text: "and this",
      attachments: nil,
      turnId: nil,
      timestamp: timestamp(4)
    )]
    let steerFrame = await engine.setOverlays(overlays)
    XCTAssertTrue(steerFrame?.isUrgent == true)
    XCTAssertEqual(steerFrame?.pendingSteers.map(\.id), ["local-steer"])
  }

  func testModelAppliesUrgentFramesAtOnceAndCoalescesTheRest() async {
    let engine = makeEngine()
    let model = ChatThreadModel(key: key, engine: engine, registry: nil)
    await engine.ingest(snapshot([user(1, "q")]))
    guard let first = await engine.flush() else { return XCTFail("no frame") }
    XCTAssertTrue(first.isUrgent)
    model.receive(first)
    XCTAssertEqual(model.frame?.revision, first.revision)

    await engine.setOverlays(liveOverlays(status: "idle"))
    await engine.ingest(.live([text(2, "a")]))
    guard let idleFrame = await engine.flush(), !idleFrame.isUrgent else { return XCTFail("no plain frame") }
    await engine.ingest(.live([text(3, "b", item: "msg-2")]))
    guard let burstFrame = await engine.flush(), !burstFrame.isUrgent else { return XCTFail("no plain frame") }

    // Nothing applied within the last display frame: the frame applies now.
    try? await Task.sleep(nanoseconds: 50_000_000)
    model.receive(idleFrame)
    XCTAssertEqual(model.frame?.revision, idleFrame.revision, "idle thread applies at once")

    // A second frame inside the same display frame waits for the display link.
    model.receive(burstFrame)
    XCTAssertEqual(model.frame?.revision, idleFrame.revision, "burst waits for the display link")
    ChatThreadFrameCoalescer.shared.flushAll()
    XCTAssertEqual(model.frame?.revision, burstFrame.revision)
  }

  // MARK: - 25. Load older while streaming

  func testOlderPageWhileStreamingKeepsTheVisibleTail() async {
    let engine = makeEngine()
    await engine.setOverlays(liveOverlays())
    var rows: [ChatThreadLiveEvent] = []
    for index in 0..<40 {
      let sequence = 100 + index * 2
      rows.append(user(sequence, "question \(index)", turn: "t\(index)"))
      rows.append(text(sequence + 1, "answer \(index)", item: "m\(index)", turn: "t\(index)"))
    }
    await engine.ingest(snapshot(rows, hasOlder: true))
    await engine.ingest(.live([status(180, "started", turn: "t40"), user(181, "live", turn: "t40"), text(182, "streaming", item: "m40", turn: "t40")]))
    guard let before = await engine.flush() else { return XCTFail("no frame") }
    XCTAssertTrue(before.isStreamingTurn)
    let olderRequest = await engine.beginOlderHostRequest()
    XCTAssertEqual(olderRequest, .beforeSequence(100))

    var older: [ChatThreadLiveEvent] = []
    for index in 0..<5 {
      let sequence = 90 + index * 2
      older.append(user(sequence, "older \(index)", turn: "o\(index)"))
      older.append(text(sequence + 1, "older answer \(index)", item: "om\(index)", turn: "o\(index)"))
    }
    await engine.ingest(.olderPage(ChatThreadOlderPageInput(
      sessionId: sessionId,
      events: older,
      hasMore: false,
      historyGeneration: 1
    )))
    guard let after = await engine.flush() else { return XCTFail("no frame") }

    XCTAssertGreaterThan(after.prependedTimelineCount, 0)
    XCTAssertGreaterThan(after.visibleTimelineCount, before.visibleTimelineCount)
    XCTAssertEqual(after.presentation.timelineLastId, before.presentation.timelineLastId)
    XCTAssertEqual(
      after.presentation.visibleEntries.suffix(10).map(\.id),
      before.presentation.visibleEntries.suffix(10).map(\.id),
      "rows on screen stay put"
    )
    XCTAssertEqual(after.olderHistoryState, .exhausted)
  }

  // MARK: - Disk paging before host paging

  func testOlderHistoryPagesFromDiskBeforeTheHost() async {
    let store = makeStore()
    let rows = (1...20).map { user($0, "row \($0)", turn: "t\($0)") }
    await store.append(key.logKey, events: rows.map(stored), generation: 1)
    await store.flush()

    let engine = makeEngine(store: store)
    await engine.loadCache(firstSliceEvents: 5, fullEvents: 5)
    let first = await engine.flush()
    XCTAssertEqual(messages(first).count, 5)
    XCTAssertTrue(first?.hasOlderHistory == true)

    let added = await engine.loadOlderFromDisk(maxEvents: 10)
    XCTAssertEqual(added, 10)
    let frame = await engine.flush()
    XCTAssertEqual(messages(frame).count, 15)
  }

  // MARK: - Resumable timeline fold: fallbacks and cross-checkpoint references
  //
  // Every test asserts two things: the frame equals a from-scratch
  // `buildWorkChatTimelineSnapshot` + presentation over its own transcript,
  // and the fold took the path it should (resumed, one component refolded,
  // full, or delegated).

  private func toolCall(_ sequence: Int, item: String, tool: String = "Read", turn: String = "turn-1") -> ChatThreadLiveEvent {
    event(sequence, ["type": "tool_call", "tool": tool, "args": ["file_path": "/tmp/\(item)"], "itemId": item, "turnId": turn])
  }

  private func toolResult(_ sequence: Int, item: String, tool: String = "Read", turn: String = "turn-1") -> ChatThreadLiveEvent {
    event(sequence, ["type": "tool_result", "tool": tool, "result": "ok \(item)", "itemId": item, "turnId": turn, "status": "completed"])
  }

  /// Snapshot, fold once (the checkpoint lands), apply `live`, fold again.
  private func foldAfter(
    _ base: [ChatThreadLiveEvent],
    live: [[ChatThreadLiveEvent]],
    overlays: ChatThreadOverlays? = nil,
    file: StaticString = #filePath,
    line: UInt = #line
  ) async -> (engine: ChatThreadEngine, frame: ChatThreadFrame?, overlays: ChatThreadOverlays) {
    let overlays = overlays ?? liveOverlays()
    let engine = makeEngine()
    _ = await engine.setOverlays(overlays)
    await engine.ingest(snapshot(base))
    var frame = await engine.flush()
    XCTAssertNil(chatThreadFrameMismatch(frame, overlays: overlays), "base fold", file: file, line: line)
    for batch in live {
      await engine.ingest(.live(batch))
      frame = await engine.flush()
      if let mismatch = chatThreadFrameMismatch(frame, overlays: overlays) {
        XCTFail("frame differs from a full rebuild: \(mismatch)", file: file, line: line)
      }
    }
    return (engine, frame, overlays)
  }

  private func assertResumed(
    _ engine: ChatThreadEngine,
    refolded: [String] = [],
    file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    let pass = await engine.lastTimelinePass
    guard case .resumed(_, let components) = pass else {
      return XCTFail("expected a resumed fold, got \(pass)", file: file, line: line)
    }
    XCTAssertEqual(components, refolded, file: file, line: line)
  }

  private func assertFullFold(_ engine: ChatThreadEngine, file: StaticString = #filePath, line: UInt = #line) async {
    let pass = await engine.lastTimelinePass
    guard case .full = pass else {
      return XCTFail("expected a full fold, got \(pass)", file: file, line: line)
    }
  }

  func testFoldResumesForAppendedToolEvents() async {
    let result = await foldAfter(
      [user(1, "read two files"), text(2, "Reading.", item: "msg-a"), toolCall(3, item: "t1")],
      live: [[toolResult(4, item: "t1")], [toolCall(5, item: "t2")], [toolResult(6, item: "t2")]]
    )
    await assertResumed(result.engine)
    XCTAssertEqual(result.frame?.snapshot.toolCards.map(\.id), ["t1", "t2"])
  }

  func testToolResultForACallBeforeTheCheckpointStaysExact() async {
    // The checkpoint moves past t1's call when msg-b arrives; the result
    // lands after it and still completes the earlier card.
    let result = await foldAfter(
      [user(1, "go"), text(2, "First.", item: "msg-a"), toolCall(3, item: "t1")],
      live: [[text(4, "Second.", item: "msg-b")], [toolResult(5, item: "t1")]]
    )
    await assertResumed(result.engine)
    XCTAssertEqual(result.frame?.snapshot.toolCards.first?.status, .completed)
  }

  func testLateDeltaForAnOlderMessageRefoldsFromZero() async {
    let result = await foldAfter(
      [user(1, "q"), text(2, "Hi", item: "msg-a"), toolCall(3, item: "t1"), toolResult(4, item: "t1"), text(5, "Next", item: "msg-b")],
      live: [[text(6, " there", item: "msg-a")]]
    )
    await assertFullFold(result.engine)
    XCTAssertEqual(texts(result.frame), ["user:q", "assistant:Hi there", "assistant:Next"])
  }

  func testOutOfOrderEnvelopeRefoldsFromZero() async {
    // Sequence 10 stamped before everything else: the transcript re-sorts.
    let result = await foldAfter(
      [user(1, "q", at: 100), text(2, "a", item: "msg-a", at: 101), toolCall(3, item: "t1"), toolResult(4, item: "t1")],
      live: [[toolCall(10, item: "t0")]]
    )
    await assertFullFold(result.engine)
  }

  func testSecondSnapshotRefoldsFromZero() async {
    let engine = makeEngine()
    let overlays = liveOverlays()
    _ = await engine.setOverlays(overlays)
    await engine.ingest(snapshot([user(1, "q"), text(2, "a", item: "msg-a")]))
    _ = await engine.flush()
    await engine.ingest(snapshot([user(1, "q"), text(2, "a", item: "msg-a"), toolCall(3, item: "t1")]))
    let frame = await engine.flush()
    XCTAssertNil(chatThreadFrameMismatch(frame, overlays: overlays))
    await assertFullFold(engine)
  }

  func testSteerGraduationRefoldsFromZero() async {
    let result = await foldAfter(
      [user(1, "q", turn: "t1"), text(2, "a", item: "msg-a", turn: "t1"), user(3, "also this", steerId: "s1", delivery: "queued")],
      live: [[user(4, "also this", turn: "t2", steerId: "s1", delivery: "delivered")]]
    )
    await assertFullFold(result.engine)
    XCTAssertEqual(result.frame?.pendingSteers.map(\.id), [])
  }

  func testApprovalOpeningAndResolvingRefoldsOnlyToolCards() async {
    // A provider approval shares its tool call's item id: while it is open
    // the call is suppressed from the tool cards, and comes back once resolved.
    let base = [user(1, "run it"), text(2, "Running.", item: "msg-a"), toolCall(3, item: "cmd-1", tool: "Bash")]
    let opened = await foldAfter(base, live: [[approval(4, item: "cmd-1")]])
    await assertResumed(opened.engine, refolded: ["tools"])
    XCTAssertEqual(opened.frame?.snapshot.toolCards.map(\.id), [])

    await opened.engine.ingest(.live([event(5, ["type": "pending_input_resolved", "itemId": "cmd-1", "resolution": "accepted"])]))
    let resolved = await opened.engine.flush()
    XCTAssertNil(chatThreadFrameMismatch(resolved, overlays: opened.overlays))
    await assertResumed(opened.engine, refolded: ["tools"])
    XCTAssertEqual(resolved?.snapshot.toolCards.map(\.id), ["cmd-1"])
  }

  func testUsageLimitTurnChangeRefoldsOnlyTurnEnds() async {
    let result = await foldAfter(
      [user(1, "q", turn: "turn-1"), text(2, "a", item: "msg-a"), event(3, ["type": "done", "turnId": "turn-1", "status": "failed"])],
      live: []
    )
    var overlays = result.overlays
    overlays.summary.usageLimitTurnId = "turn-1"
    _ = await result.engine.setOverlays(overlays)
    let frame = await result.engine.flush()
    XCTAssertNil(chatThreadFrameMismatch(frame, overlays: overlays))
    await assertResumed(result.engine, refolded: ["turnEnds"])
  }

  func testDoneForAnEarlierTurnAppliesModelMetadataWithoutRefold() async {
    let result = await foldAfter(
      [user(1, "q", turn: "turn-1"), text(2, "a", item: "msg-a"), toolCall(3, item: "t1")],
      live: [[toolResult(4, item: "t1")], [event(5, ["type": "done", "turnId": "turn-1", "status": "completed", "model": "claude-opus-4"])]]
    )
    await assertResumed(result.engine)
    XCTAssertNotNil(messages(result.frame).first { $0.role == "assistant" }?.turnProvider)
  }

  func testRetractionOfAMessageBeforeTheCheckpointStaysExact() async {
    let result = await foldAfter(
      [user(1, "q"), text(2, "draft", item: "msg-a"), toolCall(3, item: "t1"), text(4, "final", item: "msg-b")],
      live: [[toolResult(5, item: "t1")], [event(6, ["type": "transcript_retraction", "messageIds": ["msg-a"]])]]
    )
    await assertResumed(result.engine)
    XCTAssertEqual(texts(result.frame), ["user:q", "assistant:final"])
  }

  func testResolutionForAnEarlierSteerStaysExact() async {
    let result = await foldAfter(
      [user(1, "ask", turn: "t1", steerId: "s2", delivery: "delivered", processed: false), text(2, "ok", item: "msg-a", turn: "t1")],
      live: [[toolCall(3, item: "t1", turn: "t1")], [event(4, [
        "type": "user_message_resolution", "steerId": "s2", "action": "dismiss", "state": "dismissed", "resolvedAt": timestamp(4),
      ])]]
    )
    await assertResumed(result.engine)
    XCTAssertEqual(messages(result.frame).first?.unprocessedResolution?.action, "dismiss")
  }

  func testSubagentResultForAnEarlierSubagentStaysExact() async {
    let result = await foldAfter(
      [user(1, "spawn"), text(2, "Spawning.", item: "msg-a"),
       event(3, ["type": "subagent_started", "taskId": "task-1", "agentType": "general-purpose", "description": "look", "turnId": "turn-1"])],
      live: [[toolCall(4, item: "t1")], [event(5, ["type": "subagent_result", "taskId": "task-1", "status": "completed", "summary": "found it", "turnId": "turn-1"])]]
    )
    await assertResumed(result.engine)
    XCTAssertEqual(result.frame?.snapshot.subagentSnapshots.first?.status, .succeeded)
  }

  func testUnkeyedFragmentsMergeAcrossTheCheckpoint() async {
    // Text without an item id merges into the previous assistant message only
    // while the previous envelope was assistant text; that flag is fold state.
    let result = await foldAfter(
      [user(1, "q"), event(2, ["type": "text", "text": "Hello", "turnId": "turn-1"])],
      live: [[event(3, ["type": "text", "text": " world", "turnId": "turn-1"])], [toolCall(4, item: "t1")],
             [event(5, ["type": "text", "text": "After tool", "turnId": "turn-1"])]]
    )
    await assertResumed(result.engine)
    XCTAssertEqual(texts(result.frame), ["user:q", "assistant:Hello world", "assistant:After tool"])
  }

  func testLocalEchoOverlayReassemblesWithoutRefold() async {
    let result = await foldAfter([user(1, "q"), text(2, "a", item: "msg-a"), toolCall(3, item: "t1")], live: [])
    var overlays = result.overlays
    overlays.localEchoMessages = [WorkLocalEchoMessage(text: "next question", timestamp: timestamp(9))]
    let frame = await result.engine.setOverlays(overlays)
    XCTAssertNil(chatThreadFrameMismatch(frame, overlays: overlays))
    await assertResumed(result.engine)
  }

  func testUnsortedTranscriptDelegatesToTheFullBuilder() {
    func envelope(_ sequence: Int, _ at: String, _ event: WorkChatEvent) -> WorkChatEnvelope {
      WorkChatEnvelope(sessionId: sessionId, timestamp: at, sequence: sequence, event: event)
    }
    let transcript = [
      envelope(1, timestamp(5), .assistantText(text: "later", turnId: "turn-1", itemId: "b")),
      envelope(2, timestamp(1), .assistantText(text: "earlier", turnId: "turn-1", itemId: "a")),
    ]
    var fold = ChatThreadTimelineFold()
    let snapshot = fold.snapshot(transcript: transcript, artifacts: [], localEchoMessages: [], usageLimitTurnId: nil)
    let full = buildWorkChatTimelineSnapshot(transcript: transcript, fallbackEntries: [], artifacts: [], localEchoMessages: [])
    XCTAssertNil(chatThreadSnapshotMismatch(snapshot, full))
    guard case .delegated = fold.lastPass else { return XCTFail("expected delegation, got \(fold.lastPass)") }
  }

  func testShrunkTranscriptRefoldsFromZero() {
    func envelope(_ sequence: Int, _ event: WorkChatEvent) -> WorkChatEnvelope {
      WorkChatEnvelope(sessionId: sessionId, timestamp: timestamp(sequence), sequence: sequence, event: event)
    }
    // No assistant text, so the checkpoint lands at the end (index 3).
    let long = [
      envelope(1, .userMessage(text: "q", attachments: nil, turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)),
      envelope(2, .status(turnStatus: "started", message: nil, turnId: "turn-1")),
      envelope(3, .toolCall(tool: "Read", argsText: "{}", itemId: "c", parentItemId: nil, turnId: "turn-1")),
    ]
    var fold = ChatThreadTimelineFold()
    _ = fold.snapshot(transcript: long, artifacts: [], localEchoMessages: [], usageLimitTurnId: nil)
    let short = Array(long.prefix(1))
    let snapshot = fold.snapshot(transcript: short, artifacts: [], localEchoMessages: [], usageLimitTurnId: nil)
    let full = buildWorkChatTimelineSnapshot(transcript: short, fallbackEntries: [], artifacts: [], localEchoMessages: [])
    XCTAssertNil(chatThreadSnapshotMismatch(snapshot, full))
    guard case .full = fold.lastPass else { return XCTFail("expected a full fold, got \(fold.lastPass)") }
  }

  func testTrackedAppendReportsTheFirstChangedIndex() {
    func envelope(_ sequence: Int, _ at: Int, _ event: WorkChatEvent) -> WorkChatEnvelope {
      WorkChatEnvelope(sessionId: sessionId, timestamp: timestamp(at), sequence: sequence, event: event)
    }
    let base = [
      envelope(1, 1, .userMessage(text: "q", attachments: nil, turnId: "t", steerId: nil, deliveryState: nil, processed: nil)),
      envelope(2, 2, .assistantText(text: "Hel", turnId: "t", itemId: "m")),
      envelope(3, 3, .toolCall(tool: "Read", argsText: "{}", itemId: "c", parentItemId: nil, turnId: "t")),
    ]
    var keyIndex: WorkChatTranscriptKeyIndex?
    // A streaming delta merges into index 1 and keeps its ordering key: no re-sort.
    let delta = appendWorkChatTranscriptsTracked(
      base: base,
      live: [envelope(4, 4, .assistantText(text: "lo", turnId: "t", itemId: "m"))],
      keyIndex: &keyIndex
    )
    XCTAssertEqual(delta.firstChangedIndex, 1)
    XCTAssertEqual(delta.transcript, appendWorkChatTranscripts(base: base, live: [envelope(4, 4, .assistantText(text: "lo", turnId: "t", itemId: "m"))]))
    // A pure append changes nothing below the old end.
    let appended = appendWorkChatTranscriptsTracked(base: base, live: [envelope(5, 5, .status(turnStatus: "started", message: nil, turnId: "t"))], keyIndex: &keyIndex)
    XCTAssertEqual(appended.firstChangedIndex, base.count)
    // An envelope stamped before the tail re-sorts: everything may have moved.
    var freshIndex: WorkChatTranscriptKeyIndex?
    let resorted = appendWorkChatTranscriptsTracked(base: base, live: [envelope(6, 0, .status(turnStatus: "started", message: nil, turnId: "t"))], keyIndex: &freshIndex)
    XCTAssertEqual(resorted.firstChangedIndex, 0)
    XCTAssertEqual(resorted.transcript.first?.sequence, 6)
  }

  // MARK: - Overlays that do not touch the timeline

  func testViewportAndCardExpansionOverlaysDoNotFold() async {
    let signals = SignalBox()
    let engine = makeEngine(signals: signals)
    _ = await engine.setOverlays(liveOverlays())
    await engine.ingest(snapshot([user(1, "q"), text(2, "a", item: "msg-a")]))
    let first = await engine.flush()
    let framesBefore = signals.frameCount

    var overlays = liveOverlays()
    overlays.viewportWidth = 390
    overlays.cardExpansionSignature = 7
    _ = await engine.setOverlays(overlays)
    let after = await engine.flush()
    XCTAssertEqual(after?.revision, first?.revision, "no fold, no new frame")
    XCTAssertEqual(signals.frameCount, framesBefore)
  }

  func testOverlaysBeforeTheFirstFrameFoldOnceWithTheFirstData() async {
    let signals = SignalBox()
    let engine = makeEngine(signals: signals)
    var overlays = liveOverlays()
    overlays.viewportWidth = 390
    let returned = await engine.setOverlays(overlays)
    overlays.summary.model = "claude-opus-4"
    _ = await engine.setOverlays(overlays)
    XCTAssertNil(returned)
    XCTAssertEqual(signals.frameCount, 0, "nothing on screen yet: overlays wait for data")

    await engine.ingest(snapshot([user(1, "q"), text(2, "a", item: "msg-a")]))
    let frame = await engine.flush()
    XCTAssertEqual(frame?.revision, 1, "one fold carries the snapshot and every overlay so far")
    XCTAssertEqual(frame?.viewportWidth, 390)
    XCTAssertNil(chatThreadFrameMismatch(frame, overlays: overlays))
  }

  // MARK: - Helpers

  private func stored(_ event: ChatThreadLiveEvent) -> ChatLogStoredEvent {
    ChatLogStoredEvent(sequence: event.envelope.sequence ?? 0, timestamp: event.envelope.timestamp, payload: event.raw)
  }
}

// MARK: - View integration (unit V: I5–I9, edge cases 19, 21, 23, 24)

extension ChatThreadEngineTests {
  /// Edge case 21: offline open paints the cached rows, and the empty-state
  /// logic never shows the skeleton over a chat that has a cache.
  func testOfflineOpenShowsCachedRowsWithoutTheSkeleton() async {
    let store = makeStore()
    let rows = [user(1, "cached question"), text(2, "cached answer")]
    await store.append(key.logKey, events: rows.map(stored), generation: 1)
    await store.flush()

    let engine = makeEngine(store: store)
    await engine.loadCache()
    let frame = await engine.flush()
    XCTAssertEqual(frame?.cacheOrigin, .disk)
    XCTAssertEqual(texts(frame), ["user:cached question", "assistant:cached answer"])
    XCTAssertEqual(workChatTranscriptLoadState(frame: frame, isLiveAndReachable: false), .idle)
    XCTAssertEqual(workChatTranscriptLoadState(frame: frame, isLiveAndReachable: true), .idle)
  }

  /// No cache and no snapshot yet: a skeleton while the host can answer, the
  /// "reconnect" empty state while it cannot (the wait would never end).
  func testLoadStateWithoutAFrameDependsOnReachability() {
    XCTAssertEqual(workChatTranscriptLoadState(frame: nil, isLiveAndReachable: true), .loading)
    XCTAssertEqual(workChatTranscriptLoadState(frame: nil, isLiveAndReachable: false), .idle)
  }

  /// Edge case 4 as the view sees it: a deleted chat is a stated failure, not
  /// "No chat messages yet".
  func testDeletedChatIsAFailureNotAnEmptyChat() async {
    let engine = makeEngine()
    await engine.ingest(.snapshot(ChatThreadSnapshotInput(
      sessionId: sessionId,
      events: [],
      sessionFound: false,
      hostSupportsChatLogV2: true
    )))
    let frame = await engine.flush()
    XCTAssertEqual(frame?.sessionDeleted, true)
    guard case .failed = workChatTranscriptLoadState(frame: frame, isLiveAndReachable: true) else {
      return XCTFail("a deleted chat must not read as empty")
    }
  }

  /// Edge case 23 through the model API the send handler uses: the echo is
  /// set before any await and lands in the model's next frame; an unchanged
  /// overlay value is not re-sent.
  func testModelUpdateOverlaysPutsTheEchoInTheNextFrame() async {
    let engine = makeEngine()
    let model = ChatThreadModel(key: key, engine: engine, registry: nil)
    await engine.ingest(snapshot([user(1, "q"), text(2, "a")]))
    guard let first = await engine.flush() else { return XCTFail("no frame") }
    model.receive(first)

    model.updateOverlays { $0.localEchoMessages = [WorkLocalEchoMessage(text: "from the phone", timestamp: timestamp(3))] }
    XCTAssertEqual(model.overlays.localEchoMessages.count, 1, "overlays are recorded synchronously")
    for _ in 0..<200 where texts(model.frame).last != "user:from the phone" {
      await Task.yield()
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTAssertEqual(texts(model.frame).last, "user:from the phone")
    let revision = model.frame?.revision
    model.updateOverlays { $0.localEchoMessages = model.overlays.localEchoMessages }
    try? await Task.sleep(nanoseconds: 50_000_000)
    XCTAssertEqual(model.frame?.revision, revision, "an unchanged overlay does not fold again")
  }

  /// I7 / edge case 24: the streaming flag reconfigures only the row it
  /// marks; an in-flight action and a keyboard resize reconfigure no plain
  /// message row at all.
  func testRowInputsReconfigureOnlyTheRowsThatReadThem() async {
    let engine = makeEngine()
    await engine.setOverlays(liveOverlays())
    await engine.ingest(snapshot([
      user(1, "first", turn: "t1"),
      text(2, "reply", item: "m1", turn: "t1"),
      user(3, "second", turn: "t2"),
    ]))
    guard let frame = await engine.flush() else { return XCTFail("no frame") }
    let entries = frame.presentation.renderEntries
    let messageIds: [String] = entries.compactMap { entry in
      guard case .entry(let timelineEntry) = entry.payload,
            case .message(let message) = timelineEntry.payload else { return nil }
      return message.id
    }
    guard let marked = messageIds.first else { return XCTFail("no message rows") }

    let quiet = WorkChatTranscriptRowInputs(
      streamingAssistantMessageId: nil,
      isStreamingTurn: false,
      liveTurnEntryIds: [],
      latestReasoningCardId: nil,
      latestTurnEndTurnId: nil,
      viewportHeightBucket: 640,
      turnEndState: 0
    )
    func revisions(_ inputs: WorkChatTranscriptRowInputs) -> [String: Int] {
      Dictionary(uniqueKeysWithValues: entries.map { entry in
        (entry.id, workChatTranscriptRowRevision(entry, base: frame.rowRevisions[entry.id] ?? 0, inputs: inputs))
      })
    }
    let baseline = revisions(quiet)

    var keyboard = quiet
    keyboard.viewportHeightBucket = 320
    XCTAssertEqual(revisions(keyboard), baseline, "no plain row reads the viewport height")

    // Opening one card re-keys that card's row only; an override for an id no
    // row draws re-keys nothing.
    let ownedIds: [String] = entries.compactMap { entry in
      guard case .entry(let timelineEntry) = entry.payload else { return nil }
      return timelineEntry.id
    }
    guard let ownedId = ownedIds.first else { return XCTFail("no timeline entry rows") }
    var opened = quiet
    opened.cardExpansion = WorkCardExpansionState(expandedIds: [ownedId])
    let openedChanged = revisions(opened).filter { baseline[$0.key] != $0.value }.map(\.key)
    XCTAssertEqual(openedChanged.count, 1, "only the row that draws the opened card changes")
    var stray = quiet
    stray.cardExpansion = WorkCardExpansionState(expandedIds: ["not-a-row"])
    XCTAssertEqual(revisions(stray), baseline, "an override no row owns re-keys nothing")

    var streaming = quiet
    streaming.streamingAssistantMessageId = marked
    let changed = revisions(streaming).filter { baseline[$0.key] != $0.value }.map(\.key)
    XCTAssertEqual(changed.count, 1, "only the marked message row changes")
  }

  /// I7: the height cache key is (row, revision, width); the transcript-wide
  /// revision is folded into the row's effective revision, never summed.
  func testHeightKeyIsRowRevisionAndWidth() {
    let key = WorkChatTranscriptHeightKey(rowId: "r", width: 390, rowRevision: 1, contentRevision: 7)
    XCTAssertEqual(key, WorkChatTranscriptHeightKey(rowId: "r", width: 390, rowRevision: 1, contentRevision: 7))
    XCTAssertNotEqual(key, WorkChatTranscriptHeightKey(rowId: "r", width: 390, rowRevision: 2, contentRevision: 7))
    XCTAssertNotEqual(key, WorkChatTranscriptHeightKey(rowId: "r", width: 390, rowRevision: 1, contentRevision: 8))
    XCTAssertNotEqual(key, WorkChatTranscriptHeightKey(rowId: "r", width: 414, rowRevision: 1, contentRevision: 7))
    XCTAssertNotEqual(
      WorkChatTranscriptHeightKey(rowId: "r", width: 390, rowRevision: 1, contentRevision: 2),
      WorkChatTranscriptHeightKey(rowId: "r", width: 390, rowRevision: 2, contentRevision: 1),
      "the two revisions must not cancel out"
    )
  }

  /// I6 launch warm: keys read back from the store map onto engine scopes.
  func testScopeStorageKeyRoundTrips() {
    let scopes: [ChatThreadScope] = [
      .project("p1"),
      .personal,
      .crossProject(projectId: "p2", rootPath: "/Users/me/code/app"),
    ]
    for scope in scopes {
      XCTAssertEqual(ChatThreadScope(storageKey: scope.storageKey), scope)
    }
    XCTAssertNil(ChatThreadScope(storageKey: "machine:weird"))
  }

  /// I6 list prefetch: the first rows the list shows, plus every live turn
  /// further down.
  func testPrefetchPicksTheTopRowsAndEveryLiveTurn() {
    var sessions: [TerminalSessionSummary] = []
    for index in 0..<9 {
      var session = benchTerminalSession(sessionId: "chat-\(index)")
      session.status = "ended"
      session.runtimeState = "exited"
      sessions.append(session)
    }
    sessions[8].status = "running"
    sessions[8].runtimeState = "running"
    let ids = workChatPrefetchSessionIds(sessions, topCount: 3)
    XCTAssertEqual(ids, ["chat-0", "chat-1", "chat-2", "chat-8"])
  }

  /// Edge case 19: forgetting a machine drops its warm engines and its disk
  /// cache; another machine's cache survives.
  func testPurgeMachineDropsItsEnginesAndCache() async {
    let store = makeStore()
    let other = ChatThreadKey(machineKey: "machine:mac-2", sessionId: sessionId, scope: .project("p1"))
    await store.append(key.logKey, events: [user(1, "mine")].map(stored), generation: 1)
    await store.append(other.logKey, events: [user(1, "theirs")].map(stored), generation: 1)
    await store.flush()

    let registry = ChatThreadRegistry(store: store)
    _ = registry.model(for: key)
    _ = registry.model(for: other)
    registry.purgeMachine(key.machineKey)
    XCTAssertFalse(registry.hasEngine(for: key))
    XCTAssertTrue(registry.hasEngine(for: other))

    var remaining = await store.loadTail(key.logKey, maxEvents: 10, maxBytes: 1_000_000).events.count
    for _ in 0..<100 where remaining > 0 {
      try? await Task.sleep(nanoseconds: 10_000_000)
      remaining = await store.loadTail(key.logKey, maxEvents: 10, maxBytes: 1_000_000).events.count
    }
    XCTAssertEqual(remaining, 0)
    let survived = await store.loadTail(other.logKey, maxEvents: 10, maxBytes: 1_000_000).events.count
    XCTAssertEqual(survived, 1)
  }
}

/// Thread-safe collector for engine signals.
final class SignalBox: @unchecked Sendable {
  private let lock = NSLock()
  private var signals: [ChatThreadEngineSignal] = []

  func append(_ signal: ChatThreadEngineSignal) {
    lock.lock(); defer { lock.unlock() }
    signals.append(signal)
  }

  private func count(_ matches: (ChatThreadEngineSignal) -> Bool) -> Int {
    lock.lock(); defer { lock.unlock() }
    return signals.filter(matches).count
  }

  var frameCount: Int { count { if case .frame = $0 { return true } else { return false } } }
  var needsSnapshotCount: Int { count { if case .needsSnapshot = $0 { return true } else { return false } } }
  var boundaryPageCount: Int { count { if case .needsBoundaryPage = $0 { return true } else { return false } } }
}


/// Real transcripts for the local-only equivalence gates: three named long
/// chats plus the ten most recently modified in the host's transcript folder.
/// Empty (tests skip) on machines without that folder.
func chatThreadEquivalenceTranscriptPaths() -> [String] {
  let directory = "/Users/admin/Projects/ADE/.ade/transcripts/chat"
  let fileManager = FileManager.default
  guard fileManager.fileExists(atPath: directory) else { return [] }
  let named = [
    "67757bac-b9de-4df6-8f8b-cdccac23f92d.jsonl",
    "13ddd345-f88c-4f69-bc9b-2a865d4712d7.jsonl",
    "d5964fd9-00a3-4477-af89-d476c9ea588b.jsonl",
  ].map { "\(directory)/\($0)" }.filter { fileManager.fileExists(atPath: $0) }
  let url = URL(fileURLWithPath: directory)
  let recent = ((try? fileManager.contentsOfDirectory(
    at: url,
    includingPropertiesForKeys: [.contentModificationDateKey],
    options: [.skipsHiddenFiles]
  )) ?? [])
    .filter { $0.pathExtension == "jsonl" }
    .map { ($0.path, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
    .sorted { $0.1 > $1.1 }
    .prefix(10)
    .map(\.0)
  var seen = Set<String>()
  return (named + recent).filter { seen.insert($0).inserted }
}

/// Deterministic generator for the equivalence gates (SplitMix64).
struct ChatThreadSeededGenerator: RandomNumberGenerator {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}


/// The first way `frame` differs from a from-scratch fold over its own
/// transcript, or nil. Compares every snapshot field (the snapshot's `==` is
/// signature-only), the whole timeline, the presentation's rows, the tool
/// activity index, pending inputs/steers and the streaming flags.
func chatThreadFrameMismatch(_ frame: ChatThreadFrame?, overlays: ChatThreadOverlays) -> String? {
  guard let frame else { return "no frame" }
  let summary = overlays.summary
  let full = frame.transcript.isEmpty && overlays.localEchoMessages.isEmpty && overlays.artifacts.isEmpty
    ? WorkChatTimelineSnapshot.empty
    : buildWorkChatTimelineSnapshot(
        transcript: frame.transcript,
        fallbackEntries: [],
        artifacts: overlays.artifacts,
        localEchoMessages: overlays.localEchoMessages,
        usageLimitTurnId: summary.usageLimitTurnId
      )
  if let mismatch = chatThreadSnapshotMismatch(frame.snapshot, full) { return mismatch }
  return chatThreadFramePresentationMismatch(frame, full: full, overlays: overlays)
}

/// The first field where two snapshots differ (every field; the snapshot's
/// own `==` compares only the signature), or nil.
func chatThreadSnapshotMismatch(_ got: WorkChatTimelineSnapshot, _ full: WorkChatTimelineSnapshot) -> String? {
  if got.timeline.map(\.id) != full.timeline.map(\.id) {
    let firstDiff = zip(got.timeline, full.timeline).enumerated().first { $0.element.0.id != $0.element.1.id }?.offset ?? min(got.timeline.count, full.timeline.count)
    return "timeline ids differ at \(firstDiff) (got \(got.timeline.count), want \(full.timeline.count)): "
      + "\(got.timeline.dropFirst(firstDiff).prefix(3).map(\.id)) vs \(full.timeline.dropFirst(firstDiff).prefix(3).map(\.id))"
  }
  if let index = zip(got.timeline, full.timeline).enumerated().first(where: { $0.element.0 != $0.element.1 })?.offset {
    return "timeline entry \(got.timeline[index].id) differs:\n got \(got.timeline[index])\n want \(full.timeline[index])"
  }
  if got.signature != full.signature { return "signature" }
  if got.pendingInputs != full.pendingInputs { return "pendingInputs" }
  if got.pendingInputQueue != full.pendingInputQueue { return "pendingInputQueue" }
  if got.pendingSteers != full.pendingSteers { return "pendingSteers" }
  if got.toolCards != full.toolCards { return "toolCards" }
  if got.eventCards != full.eventCards { return "eventCards" }
  if got.commandCards != full.commandCards { return "commandCards" }
  if got.fileChangeCards != full.fileChangeCards { return "fileChangeCards" }
  if got.subagentSnapshots != full.subagentSnapshots { return "subagentSnapshots" }
  if got.scheduledWorkSnapshots != full.scheduledWorkSnapshots { return "scheduledWorkSnapshots" }
  if got.transcriptIndicatesActiveTurn != full.transcriptIndicatesActiveTurn { return "transcriptIndicatesActiveTurn" }
  if got.transcriptLatestTurnEnded != full.transcriptLatestTurnEnded { return "transcriptLatestTurnEnded" }
  if got.transcriptHasInterruptibleActivity != full.transcriptHasInterruptibleActivity { return "transcriptHasInterruptibleActivity" }
  if got.latestTranscriptTimestamp != full.latestTranscriptTimestamp { return "latestTranscriptTimestamp" }
  if got.latestMessageAssistantId != full.latestMessageAssistantId { return "latestMessageAssistantId" }
  if got.latestMessageAssistantItemId != full.latestMessageAssistantItemId { return "latestMessageAssistantItemId" }
  if got.latestTurnEndTurnId != full.latestTurnEndTurnId { return "latestTurnEndTurnId" }
  if got.liveTurnEntryIds != full.liveTurnEntryIds { return "liveTurnEntryIds" }
  return nil
}

private func chatThreadFramePresentationMismatch(
  _ frame: ChatThreadFrame,
  full: WorkChatTimelineSnapshot,
  overlays: ChatThreadOverlays
) -> String? {
  let summary = overlays.summary
  let toolActivity = workTurnToolActivityIndex(from: full.timeline)
  if frame.turnToolActivity != toolActivity { return "turnToolActivity" }
  let isStreaming = workChatIsStreaming(
    sessionStatus: overlays.sessionStatus ?? "",
    isLive: summary.isLive,
    transcriptIndicatesActiveTurn: full.transcriptIndicatesActiveTurn,
    liveTurnActiveHint: frame.hostTurnActiveHint ?? overlays.turnActiveHint,
    transcriptLatestTurnEnded: full.transcriptLatestTurnEnded,
    rowEndedAfterLatestTranscript: chatThreadRowEndedAfterLatestTranscript(
      sessionStatus: overlays.sessionStatus ?? "",
      rowEndedAtCandidates: summary.rowEndedAtCandidates,
      latestTranscriptAt: full.latestTranscriptTimestamp
    )
  )
  if frame.isStreamingTurn != isStreaming { return "isStreamingTurn" }
  let streamingId = isStreaming && full.transcriptHasInterruptibleActivity ? full.latestMessageAssistantId : nil
  if frame.streamingAssistantMessageId != streamingId { return "streamingAssistantMessageId" }
  if frame.transcriptIndicatesActiveTurn != full.transcriptIndicatesActiveTurn { return "frame.transcriptIndicatesActiveTurn" }
  let latestReasoning = full.eventCards.last(where: { $0.kind == "reasoning" })?.id
  if frame.latestReasoningCardId != latestReasoning { return "latestReasoningCardId" }
  let expectedActivity = isStreaming ? chatThreadActivityPresentation(frame.transcript) : nil
  if frame.activityPresentation != expectedActivity { return "activityPresentation" }

  let canonical = full.pendingInputQueue.resolved(hostPendingInputItemId: summary.pendingInputItemId)
  if frame.canonicalPendingInputs != canonical { return "canonicalPendingInputs" }
  let pending = canonical.filter { !overlays.optimisticallyAnsweredInputIds.contains($0.itemId) }
  if frame.pendingInputs != pending { return "frame.pendingInputs" }
  let steers = mergeWorkPendingSteers(optimistic: overlays.optimisticPendingSteers, canonical: full.pendingSteers)
  if frame.pendingSteers != steers { return "frame.pendingSteers" }

  let presented = workPresentedTimelineEntries(full.timeline, provider: summary.effectiveProvider, toolActivity: toolActivity)
  let presentation = makeWorkTimelinePresentation(
    timeline: presented,
    visibleCount: frame.visibleTimelineCount,
    provider: summary.provider,
    model: summary.model,
    modelId: summary.modelId,
    transcript: frame.transcript,
    assistantPreviewCache: WorkAssistantPreviewCache(),
    streamingAssistantMessageId: streamingId
  )
  let gotPresentation = frame.presentation
  if gotPresentation.visibleEntries != presentation.visibleEntries { return "presentation.visibleEntries" }
  if gotPresentation.renderEntries.map(\.id) != presentation.renderEntries.map(\.id) { return "presentation.renderEntries ids" }
  if let index = zip(gotPresentation.renderEntries, presentation.renderEntries).enumerated().first(where: { $0.element.0 != $0.element.1 })?.offset {
    return "presentation.renderEntries[\(index)] \(gotPresentation.renderEntries[index].id)"
  }
  if gotPresentation.timelineCount != presentation.timelineCount
    || gotPresentation.timelineFirstId != presentation.timelineFirstId
    || gotPresentation.timelineLastId != presentation.timelineLastId
    || gotPresentation.hiddenCount != presentation.hiddenCount
    || gotPresentation.signature != presentation.signature {
    return "presentation window/signature"
  }
  for entry in presentation.renderEntries where frame.rowRevisions[entry.id] != workChatTranscriptRowRevision(entry) {
    return "rowRevision \(entry.id)"
  }
  return nil
}
