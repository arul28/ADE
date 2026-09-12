import XCTest
@testable import ADE

final class WorkAssistantRenderingTests: XCTestCase {
  func testAssistantMessageMarkdownWithPaddedTableIsNotMonospaced() {
    let markdown = """
    Here's the summary of the run:

    | File            | Status   |
    |-----------------|----------|
    | AppDelegate     | modified |
    | SceneDelegate   | deleted  |

    All tests passed. Let me know if you want the diff.
    """
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessageFencedCodeWithAlignedColumnsIsNotMonospaced() {
    let markdown = """
    The tests all pass now:

    ```
    Suite ADETests started
    testPreview        passed   0.003s
    testTimeline       passed   0.108s
    ```

    I also cleaned up the helper while I was in there.
    """
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessageFencedWireframeGlyphsAreNotMonospaced() {
    let markdown = """
    Proposed layout:

    ```
    ┌─────────┬─────────┐
    │ sidebar │ content │
    └─────────┴─────────┘
    ```

    The sidebar keeps its fixed width.
    """
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessageFencedUnicodeTreeOutputIsNotMonospaced() {
    let markdown = """
    Here's the new layout of the module:

    ```
    apps/ios/ADE/Views/Work
    ├── WorkChatSessionView.swift
    ├── WorkMarkdownParsing.swift
    │   └── WorkMarkdownViews.swift
    └── WorkChatHeaderAndMessageViews.swift
    ```

    The parser helpers stay in one file.
    """
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessageUnfencedWireframeStaysMonospaced() {
    let markdown = (1...40).map { "│ pane \($0)  │" }.joined(separator: "\n")
    XCTAssertTrue(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessagePlainAsciiLayoutDominatedByAlignedColumnsIsMonospaced() {
    let markdown = (1...30).map { "[Button \($0)]      [Input field \($0)]" }.joined(separator: "\n")
    XCTAssertTrue(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessageProseWithFewAlignedLinesIsNotMonospaced() {
    let prose = (1...20).map { "This is regular prose line number \($0) in the final answer." }
    let aligned = ["column a      column b", "value 1       value 2"]
    let markdown = (prose + aligned).joined(separator: "\n")
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testLatestAssistantAnswerWithPaddedTableRendersFullMarkdownWithoutShowMore() {
    let tableLines = (1...20).map { "| file-\($0).swift    | modified |" }
    let markdown = (
      ["Here's where things landed:", "", "| File | Status |", "|------|--------|"]
        + tableLines
        + ["", "Everything is committed on the branch."]
    ).joined(separator: "\n")
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))

    let preview = workAssistantMessagePreview(markdown)
    XCTAssertEqual(preview.text, markdown)

    var message = makeAssistantMessage(id: "assistant-table-answer", markdown: markdown)
    message.assistantPreview = preview
    let rendered = workTimelineRenderEntries(
      from: [makeMessageEntry(message)],
      streamingAssistantMessageId: nil,
      splitAssistantMessageId: message.id
    )
    assertMarkdownOnly(rendered)
  }


  func testFiftyFourLineProseAndFencedTreeRendersFullyWithoutShowMore() {
    let markdownLines = (
      ["Here is the result:", "", "```", "root"]
        + (1...42).map { "├── item-\($0)" }
        + ["└── final-item", "```", "", "The tree is complete.", "All expected files are present.", "No files were omitted.", "The checks passed.", "That is the full result."]
    )
    XCTAssertEqual(markdownLines.count, 54)
    let markdown = markdownLines.joined(separator: "\n")
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))

    let preview = workAssistantMessagePreview(markdown)
    XCTAssertEqual(preview.text, markdown)

    var message = makeAssistantMessage(id: "assistant-fifty-four-lines", markdown: markdown)
    message.assistantPreview = preview
    let rendered = workTimelineRenderEntries(
      from: [makeMessageEntry(message)],
      streamingAssistantMessageId: nil,
      splitAssistantMessageId: message.id
    )
    assertMarkdownOnly(rendered)
  }

  // MARK: - Nothing is ever truncated

  /// The owner's rule, at the seam every render path goes through: the preview
  /// hands back the WHOLE message and reports its real counts, so no caller has
  /// a "visible vs total" gap to draw a "Show more" row from.
  func testAssistantPreviewRendersTheWholeMessage() {
    let markdown = (1...1_200).map { "Line \($0): the agent explained another step." }
      .joined(separator: "\n")

    let preview = workAssistantMessagePreview(markdown)
    XCTAssertEqual(preview.text, markdown)
    XCTAssertEqual(preview.totalLineCount, 1_200)
    XCTAssertEqual(preview.totalCharacterCount, markdown.count)
  }

  /// A very wide monospaced answer used to walk the slower 24-line ladder.
  /// It renders whole too.
  func testWideMonospacedAnswerRendersWhole() {
    let markdown = (1...400).map { _ in String(repeating: "█", count: 200) }
      .joined(separator: "\n")
    let preview = workAssistantMessagePreview(markdown)
    XCTAssertEqual(preview.text, markdown)
  }


  // MARK: - Position-stable block ids

  func testMarkdownBlockIdsAreIndexBasedAndSurviveContentEdits() {
    let before = parseMarkdownBlocks("First paragraph.\n\n## Heading\n\nSecond paragraph.")
    let after = parseMarkdownBlocks("First paragraph, revised.\n\n## Heading\n\nSecond paragraph.")

    XCTAssertEqual(before.map(\.id), after.map(\.id))
    XCTAssertEqual(before.map(\.id), (0..<before.count).map { "markdown-block-\($0)" })
    // Identity is stable, but the change is still visible to change detection.
    XCTAssertNotEqual(before[0].digest, after[0].digest)
    XCTAssertEqual(before[1].digest, after[1].digest)
    XCTAssertNotEqual(before[0], after[0])
  }

  func testStreamingBlockIdsMatchTheWholeTextParse() {
    let markdown = "Intro paragraph.\n\n```swift\nlet x = 1\n```\n\nClosing paragraph."
    let streamed = parseMarkdownBlocksForStreaming(markdown, cacheKey: "streaming-id-parity")
    let whole = parseMarkdownBlocks(markdown)
    XCTAssertEqual(streamed.map(\.id), whole.map(\.id))
    XCTAssertEqual(streamed.map(\.digest), whole.map(\.digest))
  }

  /// A streaming message grows one delta at a time. Every already-rendered row
  /// has to keep its identity across those deltas, or the LazyVStack rebuilds
  /// the whole subtree on every frame instead of updating the tail.
  func testStreamingDeltasDoNotChurnEarlierBlockIds() {
    let head = "Intro paragraph.\n\n## Findings\n\n"
    let first = parseMarkdownBlocksForStreaming(head + "Partial", cacheKey: "streaming-churn")
    let second = parseMarkdownBlocksForStreaming(head + "Partial answer, now longer.", cacheKey: "streaming-churn")
    XCTAssertGreaterThanOrEqual(first.count, 2)
    XCTAssertEqual(Array(first.prefix(2)).map(\.id), Array(second.prefix(2)).map(\.id))
    XCTAssertEqual(Array(first.prefix(2)), Array(second.prefix(2)))
  }

  /// The result box shows a slice; the clipboard never does.
  func testToolResultBoxSeparatesWhatIsShownFromWhatIsCopied() {
    let resultText = String(repeating: "x", count: workToolResultTruncateLimit + 400)
    let collapsed = workToolResultBlockText(resultText, expanded: false)
    XCTAssertTrue(collapsed.didTruncate)
    XCTAssertLessThan(collapsed.displayed.count, resultText.count)
    XCTAssertEqual(collapsed.copy, resultText)

    let expanded = workToolResultBlockText(resultText, expanded: true)
    XCTAssertFalse(expanded.didTruncate)
    XCTAssertEqual(expanded.displayed, resultText)
    XCTAssertEqual(expanded.copy, resultText)
  }

  // MARK: - Hybrid expand ladder

  func testHybridLadderStepsOnceInPlaceThenOffersTheViewer() {
    XCTAssertEqual(
      workTruncatedOutputAffordance(isTruncated: true, hasExpandedInPlace: false, isClipped: false),
      .showMore
    )
    XCTAssertEqual(
      workTruncatedOutputAffordance(isTruncated: true, hasExpandedInPlace: true, isClipped: false),
      .openFullOutput
    )
  }

  /// Nothing truncated and nothing clipped means nothing to offer — the ladder
  /// must not leave a permanent control under every box.
  func testHybridLadderOffersNothingWhenTheWholeBoxIsVisible() {
    XCTAssertEqual(
      workTruncatedOutputAffordance(isTruncated: false, hasExpandedInPlace: false, isClipped: false),
      .none
    )
    XCTAssertEqual(
      workTruncatedOutputAffordance(isTruncated: false, hasExpandedInPlace: true, isClipped: false),
      .none
    )
  }

  /// Expanding a box that clips at a fixed height adds text nobody can see, so
  /// a fully-expanded-but-clipped box goes straight to the viewer.
  func testHybridLadderOffersTheViewerForAClippedBox() {
    XCTAssertEqual(
      workTruncatedOutputAffordance(isTruncated: false, hasExpandedInPlace: true, isClipped: true),
      .openFullOutput
    )
  }





  func testOutputBoxOverflowsCountsWrappedLinesForAWrappingBox() {
    let short = "one\ntwo\nthree"
    XCTAssertFalse(workOutputBoxOverflows(short, lineCapacity: 11, columnCapacity: 46))

    let tall = (1...40).map { "line \($0)" }.joined(separator: "\n")
    XCTAssertTrue(workOutputBoxOverflows(tall, lineCapacity: 11, columnCapacity: 46))

    // One long line wraps into many in a wrapping box…
    let oneLongLine = String(repeating: "y", count: 46 * 12)
    XCTAssertTrue(workOutputBoxOverflows(oneLongLine, lineCapacity: 11, columnCapacity: 46))
    // …and stays one line in a box that scrolls horizontally instead.
    XCTAssertFalse(workOutputBoxOverflows(oneLongLine, lineCapacity: 11, columnCapacity: nil))
  }

  func testOutputBoxOverflowsCountsOnlyHardBreaksForADiff() {
    let diff = (1...30).map { "+ added line \($0)" }.joined(separator: "\n")
    XCTAssertTrue(workOutputBoxOverflows(diff, lineCapacity: workDiffOutputBoxLineCapacity, columnCapacity: nil))
    XCTAssertFalse(workOutputBoxOverflows(diff, lineCapacity: 40, columnCapacity: nil))
    XCTAssertFalse(workOutputBoxOverflows("", lineCapacity: 11, columnCapacity: nil))
  }

  // MARK: - Viewer search

  func testViewerSearchCountsEveryOccurrenceNotEveryLine() {
    let lines = ["alpha beta alpha", "gamma", "ALPHA"]
    XCTAssertEqual(workOutputViewerMatchLines(lines, query: "alpha"), [0, 0, 2])
    XCTAssertEqual(workOutputViewerMatchLines(lines, query: "delta"), [])
    XCTAssertEqual(workOutputViewerMatchLines(lines, query: "   "), [])
  }

  func testViewerSearchStepsWrapAtBothEnds() {
    XCTAssertEqual(workOutputViewerSteppedMatchIndex(current: 2, delta: 1, count: 3), 0)
    XCTAssertEqual(workOutputViewerSteppedMatchIndex(current: 0, delta: -1, count: 3), 2)
    XCTAssertEqual(workOutputViewerSteppedMatchIndex(current: 0, delta: 1, count: 0), 0)
  }

  // MARK: - Helpers

  private func makeAssistantMessage(id: String, markdown: String) -> WorkChatMessage {
    WorkChatMessage(
      id: id,
      role: "assistant",
      markdown: markdown,
      timestamp: "2026-07-22T00:00:01.000Z",
      turnId: "turn-1",
      itemId: "item-1"
    )
  }

  private func makeMessageEntry(_ message: WorkChatMessage) -> WorkTimelineEntry {
    WorkTimelineEntry(id: "message-\(message.id)", timestamp: message.timestamp, rank: 0, payload: .message(message))
  }

  private func assertMarkdownOnly(_ rendered: [WorkTimelineRenderEntry], file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(rendered.contains { if case .assistantMarkdownBlock = $0.payload { return true }; return false }, file: file, line: line)
    XCTAssertFalse(rendered.contains { if case .assistantMonospaced = $0.payload { return true }; return false }, file: file, line: line)
  }
}

/// The lane→PR gate `WorkSessionDestinationView` reads before it resolves a PR
/// or hands a badge to the chat view. CTO reuses that destination with a
/// synthetic lane id, so the gate — not `showsLaneActions` alone — is what keeps
/// the project's primary-lane PR out of the CTO composer.
final class WorkChatLanePrPolicyTests: XCTestCase {
  /// A resolved primary-lane PR, i.e. exactly what the CTO chat used to inherit.
  private func makeTag() -> LanePrTag {
    LanePrTag(
      source: .ade,
      prId: "pr-1",
      githubPrNumber: 1235,
      githubUrl: "https://github.com/example/ade/pull/1235",
      title: "Mobile sync host recovery",
      state: "open",
      headBranch: "ade/8eab2d87",
      updatedAt: "2026-09-11T00:00:00.000Z"
    )
  }

  func testCtoConfigurationResolvesNoLanePr() {
    let policy = WorkChatLanePrPolicy(showsLaneActions: false)
    XCTAssertFalse(policy.resolvesLanePr)
    XCTAssertFalse(policy.rendersPrBadge)
  }

  func testLaneBackedChatResolvesAndRendersLanePr() {
    let policy = WorkChatLanePrPolicy(showsLaneActions: true)
    XCTAssertTrue(policy.resolvesLanePr)
    XCTAssertTrue(policy.rendersPrBadge)
  }

  func testSubagentTranscriptRendersNoBadgeButStillResolves() {
    let policy = WorkChatLanePrPolicy(showsLaneActions: true, viewingSubagent: true)
    XCTAssertTrue(policy.resolvesLanePr)
    XCTAssertFalse(policy.rendersPrBadge)
  }

  /// The composer badge input itself: even when a lane PR is somehow in state,
  /// a lane-action-free chat passes `nil` to `WorkChatSessionView`.
  func testCtoConfigurationPassesNoPrBadgeEvenWithAResolvedTag() {
    let tag = makeTag()
    let ctoPolicy = WorkChatLanePrPolicy(showsLaneActions: false)
    let ctoBadge = ctoPolicy.rendersPrBadge ? workChatPrBadgeModel(tag: tag, pr: nil) : nil
    XCTAssertNil(ctoBadge)

    let lanePolicy = WorkChatLanePrPolicy(showsLaneActions: true)
    let laneBadge = lanePolicy.rendersPrBadge ? workChatPrBadgeModel(tag: tag, pr: nil) : nil
    XCTAssertEqual(laneBadge?.title, "Mobile sync host recovery")
  }
}

/// The CTO composer's send-mode filter (`workChatActiveSendCapability`). The
/// host caps the identity session's steer queue at zero and rewrites a queued
/// delivery into the provider's first live-redirect mode, so offering "send
/// after turn" there would promise a wait that never happens. Desktop applies
/// the same filter in `AgentChatComposer.tsx`; these pin the iOS half, and the
/// unchanged half for every ordinary chat that shares this composer.
final class WorkChatActiveSendCapabilityTests: XCTestCase {
  func testCtoSurfaceOffersNoQueueModeForEveryEligibleProvider() {
    // Read off the eligibility contract rather than restating the list.
    for provider in ctoLiveRedirectProviders {
      let capability = workChatActiveSendCapability(provider: provider, liveRedirectOnly: true)
      XCTAssertFalse(capability.modes.contains(.queue), "expected \(provider) CTO menu to drop queue")
      XCTAssertFalse(capability.modes.isEmpty, "expected \(provider) CTO menu to keep a live-redirect mode")
    }
  }

  func testCtoSurfaceKeepsExactlyTheLiveRedirectModesInMenuOrder() {
    XCTAssertEqual(
      workChatActiveSendCapability(provider: "claude", liveRedirectOnly: true).modes,
      [.inline, .interrupt]
    )
    XCTAssertEqual(
      workChatActiveSendCapability(provider: "codex", liveRedirectOnly: true).modes,
      [.inline]
    )
    XCTAssertEqual(
      workChatActiveSendCapability(provider: "cursor", liveRedirectOnly: true).modes,
      [.interrupt]
    )
  }

  /// The primary send button labels itself with `defaultMode`, so a queue
  /// default would name a mode the caret menu no longer lists.
  func testCtoDefaultModeIsNeverQueue() {
    for provider in ctoLiveRedirectProviders {
      let capability = workChatActiveSendCapability(provider: provider, liveRedirectOnly: true)
      XCTAssertNotEqual(capability.defaultMode, .queue, "expected \(provider) CTO default to redirect")
      XCTAssertEqual(capability.defaultMode, capability.modes.first)
    }
  }

  /// Family collapse still applies: a CTO session labelled `claude-code` or
  /// `cursor-agent` must not fall through to the queue-only default arm.
  func testCtoSurfaceNormalizesProviderFamilyAliases() {
    XCTAssertEqual(
      workChatActiveSendCapability(provider: "claude-code", liveRedirectOnly: true).modes,
      [.inline, .interrupt]
    )
    XCTAssertEqual(
      workChatActiveSendCapability(provider: "cursor-agent", liveRedirectOnly: true).modes,
      [.interrupt]
    )
  }

  /// Copy and interrupt wording are untouched by the filter — only the menu
  /// contents change.
  func testCtoSurfaceKeepsAgentLabelAndInterruptWording() {
    let cursor = workChatActiveSendCapability(provider: "cursor", liveRedirectOnly: true)
    XCTAssertEqual(cursor.agentLabel, "Cursor")
    XCTAssertTrue(cursor.interruptContinues)

    let claude = workChatActiveSendCapability(provider: "claude", liveRedirectOnly: true)
    XCTAssertEqual(claude.agentLabel, "Claude")
    XCTAssertFalse(claude.interruptContinues)
  }

  /// The regression guard that matters most: this composer is every chat on the
  /// phone, so an ordinary chat must see the provider table verbatim — here an
  /// inline-capable provider and a queue-only one.
  func testOrdinaryChatKeepsEveryProviderMenuUnchanged() {
    for provider in ["claude", "codex", "cursor", "claude-code", "qwen", "kimi", "grok", "copilot", "droid"] {
      XCTAssertEqual(
        workChatActiveSendCapability(provider: provider, liveRedirectOnly: false),
        WorkActiveSendCapability.forProvider(provider),
        "expected \(provider) to keep its unfiltered menu outside the CTO"
      )
    }
    XCTAssertEqual(
      workChatActiveSendCapability(provider: "claude", liveRedirectOnly: false).modes,
      [.inline, .queue, .interrupt]
    )
    XCTAssertEqual(
      workChatActiveSendCapability(provider: "qwen", liveRedirectOnly: false).modes,
      [.queue]
    )
  }

  /// Safety rule, mirrored from desktop: filtering must never empty the menu.
  /// No CTO-eligible provider is queue-only today, so this is unreachable in
  /// the product — but an empty send menu is a dead end and must stay
  /// impossible if some other caller ever sets the flag.
  func testQueueOnlyProviderKeepsItsRealMenuUnderTheCtoFilter() {
    for provider in ["qwen", "kimi", "grok", "copilot", "droid"] {
      let filtered = workChatActiveSendCapability(provider: provider, liveRedirectOnly: true)
      XCTAssertEqual(filtered, WorkActiveSendCapability.forProvider(provider), "expected \(provider) menu kept")
      XCTAssertFalse(filtered.modes.isEmpty, "expected \(provider) menu to stay non-empty")
    }
  }

  /// The composer hides the picker for a single-mode provider, so the CTO on
  /// Codex or Cursor gets a plain send button rather than a one-item menu,
  /// while Claude keeps a real two-way choice.
  func testCtoPickerRemainsAChoiceOnlyWhereMoreThanOneModeSurvives() {
    XCTAssertEqual(workChatActiveSendCapability(provider: "claude", liveRedirectOnly: true).modes.count, 2)
    XCTAssertEqual(workChatActiveSendCapability(provider: "codex", liveRedirectOnly: true).modes.count, 1)
    XCTAssertEqual(workChatActiveSendCapability(provider: "cursor", liveRedirectOnly: true).modes.count, 1)
  }

  // MARK: - Work-board move (chat side)

  /// The host writes the board-drag nudge as a `user_message`. Rendering it as
  /// a user bubble would put words in the user's mouth they never typed — the
  /// same rule desktop's `AgentChatMessageList` states — so the parser has to
  /// lift it out of the user-message path entirely.
  func testBoardMoveArrivesAsANoticeRatherThanAUserBubble() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-09-12T00:00:01.000Z","sequence":1,"event":{"type":"user_message","text":"The user moved this to Done on the board.","turnId":"turn-1","metadata":{"boardMove":{"from":"needs_you","to":"done","at":"2026-09-12T00:00:01.000Z","moveId":"move-1"}}}}
    """
    let transcript = parseWorkChatTranscript(raw)
    XCTAssertEqual(transcript.count, 1)
    guard case .systemNotice(let kind, let message, let detail, _, _) = transcript[0].event else {
      return XCTFail("expected a system notice, got \(transcript[0].event)")
    }
    XCTAssertEqual(kind, "board_move")
    // The EXACT sentence the agent received, so the phone and the agent cannot
    // be told two different things.
    XCTAssertEqual(message, "The user moved this to Done on the board.")
    // Columns pass through raw; only the card turns them into words.
    XCTAssertEqual(detail, "needs_you|done")
  }

  /// An ordinary user message must be unaffected — the lift is keyed to the
  /// `boardMove` marker and nothing else.
  func testPlainUserMessageStillRendersAsAUserMessage() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-09-12T00:00:01.000Z","sequence":1,"event":{"type":"user_message","text":"ship it","turnId":"turn-1"}}
    """
    guard case .userMessage(let text, _, _, _, _, _) = parseWorkChatTranscript(raw)[0].event else {
      return XCTFail("expected a user message")
    }
    XCTAssertEqual(text, "ship it")
  }

  /// The card reads the way the board header reads: labels, never wire ids.
  func testBoardMoveCardNamesColumnsTheWayTheBoardDoes() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-09-12T00:00:01.000Z","sequence":1,"event":{"type":"user_message","text":"The user moved this to Done on the board.","turnId":"turn-1","metadata":{"boardMove":{"from":"needs_you","to":"done","at":"2026-09-12T00:00:01.000Z","moveId":"move-1"}}}}
    """
    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: parseWorkChatTranscript(raw),
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    let cards = snapshot.timeline.compactMap { entry -> WorkEventCardModel? in
      guard case .eventCard(let card) = entry.payload else { return nil }
      return card.title == "Moved on the board" ? card : nil
    }
    XCTAssertEqual(cards.count, 1, "expected exactly one board-move card")
    XCTAssertEqual(cards.first?.metadata, ["Needs you → Done"])
    XCTAssertEqual(cards.first?.body, "The user moved this to Done on the board.")
    // A move card is identity for an action the user took, not an alarm.
    XCTAssertEqual(cards.first?.tint, ColorToken.secondary)
  }

  /// A host that names a column this build has never heard of should still be
  /// legible: the raw id is the fallback, not a blank or a guess.
  func testUnknownBoardColumnFallsBackToItsRawId() {
    XCTAssertEqual(workBoardColumnLabel("needs_you"), "Needs you")
    XCTAssertEqual(workBoardColumnLabel("waiting"), "Waiting")
    XCTAssertEqual(workBoardColumnLabel("blocked"), "blocked")
  }
}
