import SwiftUI
import XCTest
@testable import ADE

/// Shared kind vocabulary between the Swift enum and the cross-surface fixture.
func workChipFixtureKindName(_ kind: WorkSmartLink.Kind) -> String {
  switch kind {
  case .pullRequest: return "pr"
  case .issue: return "issue"
  case .repository: return "repo"
  case .commit: return "commit"
  case .branch: return "branch"
  case .actionsRun: return "actions_run"
  case .linearIssue: return "linear_issue"
  case .lane: return "lane"
  case .chat: return "chat"
  case .terminal: return "terminal"
  case .file: return "file"
  case .artifact: return "artifact"
  case .webPage: return "web_page"
  case .adeLink: return "ade_link"
  }
}

/// The `@chat:` / `@lane:` / `@term:` grammar and the unified one-pass chip
/// scan, both of which iOS re-implements from
/// `apps/desktop/src/shared/chatMentions.ts` and `chips.ts`.
///
/// The fixture case is the load-bearing one: hand-written twin tests prove
/// today's parity and nothing about tomorrow's, so the rows live in a file BOTH
/// surfaces read and a new row fails this suite until Swift matches.
final class WorkChipDetectorTests: XCTestCase {
  private func chips(_ text: String) -> [WorkChip] {
    WorkChipDetector.chips(in: text as NSString)
  }

  // MARK: Mention grammar

  func testMentionAtStartOfText() {
    let found = WorkChatMentionDetector.mentions(in: "@chat:9e2315e8ddef" as NSString)
    XCTAssertEqual(found.count, 1)
    XCTAssertEqual(found.first?.kind, .chat)
    XCTAssertEqual(found.first?.id, "9e2315e8ddef")
    XCTAssertEqual(found.first?.token, "@chat:9e2315e8ddef")
    XCTAssertEqual(found.first?.range, NSRange(location: 0, length: 18))
  }

  func testMentionRangeAnchorsOnTheAtSign() {
    // The regex consumes one leading boundary character; the chip must still
    // start at the `@` or the pill would swallow the space before it.
    let text = "see @lane:abc123de now"
    let found = WorkChatMentionDetector.mentions(in: text as NSString)
    XCTAssertEqual(found.first?.range, NSRange(location: 4, length: 14))
    XCTAssertEqual((text as NSString).substring(with: found[0].range), "@lane:abc123de")
  }

  func testTermPrefixMapsToTerminalKind() {
    let found = WorkChatMentionDetector.mentions(in: "run @term:tty-7" as NSString)
    XCTAssertEqual(found.first?.kind, .terminal)
    XCTAssertEqual(found.first?.defaultLabel, "Terminal tty-7")
    XCTAssertEqual(found.first?.kind.chipKind, .terminal)
  }

  func testMentionNeedsAWordBoundary() {
    // `arul@chat:x` is an email-shaped substring, never a mention.
    XCTAssertTrue(WorkChatMentionDetector.mentions(in: "arul@chat:nope" as NSString).isEmpty)
    XCTAssertTrue(WorkChatMentionDetector.mentions(in: "x@lane:abc" as NSString).isEmpty)
  }

  func testMentionBoundaryCharactersMatchTheDesktopSet() {
    for boundary in [" ", "\t", "\n", "(", "[", "{", ","] {
      let text = "a\(boundary)@chat:id1"
      XCTAssertEqual(
        WorkChatMentionDetector.mentions(in: text as NSString).count,
        1,
        "boundary \(boundary.debugDescription) should open a mention"
      )
    }
  }

  func testUnknownPrefixAndEmptyIdAreNotMentions() {
    XCTAssertTrue(WorkChatMentionDetector.mentions(in: "@bogus:123" as NSString).isEmpty)
    XCTAssertTrue(WorkChatMentionDetector.mentions(in: "@chat:" as NSString).isEmpty)
    XCTAssertTrue(WorkChatMentionDetector.mentions(in: "@chat:a:b" as NSString).first?.id == "a")
  }

  func testDefaultLabelTruncatesToEightCharacters() {
    XCTAssertEqual(
      WorkChatMentionDetector.mentions(in: "@lane:25f280a4-1b2c-4d3e" as NSString).first?.defaultLabel,
      "Lane 25f280a4"
    )
    XCTAssertEqual(
      WorkChatMentionDetector.mentions(in: "@chat:ab" as NSString).first?.defaultLabel,
      "Chat ab"
    )
  }

  func testFormatTokenRoundTrips() {
    for kind in [WorkChatMention.Kind.chat, .lane, .terminal] {
      let token = WorkChatMentionDetector.formatToken(kind: kind, id: "abc-123")
      let parsed = WorkChatMentionDetector.mentions(in: token as NSString).first
      XCTAssertEqual(parsed?.kind, kind)
      XCTAssertEqual(parsed?.id, "abc-123")
      XCTAssertEqual(parsed?.token, token)
    }
  }

  // MARK: Unified scan

  func testChipsMergeMentionsAndLinksInDocumentOrder() {
    let found = chips("see https://github.com/arul28/ade/pull/1237 then @lane:abc123de ok")
    XCTAssertEqual(found.map(\.kind), [.pullRequest, .lane])
    XCTAssertEqual(found.map(\.label), ["arul28/ade#1237", "Lane abc123de"])
  }

  func testChipsNeverOverlap() {
    // Every chip starts at or after the previous chip's end.
    let found = chips("@chat:a ade://session/9e2315e8ddef @term:t1 https://example.com/x")
    var consumedTo = 0
    for chip in found {
      XCTAssertGreaterThanOrEqual(chip.range.location, consumedTo)
      consumedTo = NSMaxRange(chip.range)
    }
    XCTAssertEqual(found.map(\.kind), [.chat, .chat, .terminal, .webPage])
  }

  func testChipTokenIsTheCanonicalTextNotTheLabel() {
    let found = chips("@lane:25f280a4-1b2c-4d3e-8f90-abcdef123456")
    XCTAssertEqual(found.first?.token, "@lane:25f280a4-1b2c-4d3e-8f90-abcdef123456")
    XCTAssertEqual(found.first?.label, "Lane 25f280a4")
  }

  func testChipLimitIsHonoured() {
    let text = Array(repeating: "@chat:a", count: 40).joined(separator: " ")
    XCTAssertEqual(WorkChipDetector.chips(in: text as NSString, limit: 5).count, 5)
    XCTAssertEqual(WorkChipDetector.chips(in: text as NSString, limit: 0).count, 0)
  }

  // MARK: Parts

  func testPartsPreserveEveryCharacterOfTheOriginal() {
    let text = "fix @lane:abc123de and see https://github.com/arul28/ade/pull/9 — thanks"
    let rebuilt = WorkChipDetector.parts(in: text).map { part -> String in
      switch part {
      case .text(let run): return run
      case .chip(let chip): return chip.token
      }
    }.joined()
    XCTAssertEqual(rebuilt, text, "a chip render must never lose or rewrite the raw message")
  }

  func testPartsForPlainTextIsOneRun() {
    XCTAssertEqual(WorkChipDetector.parts(in: "just prose"), [.text("just prose")])
    XCTAssertEqual(WorkChipDetector.parts(in: ""), [])
  }

  func testPartsBeginAndEndWithChips() {
    let parts = WorkChipDetector.parts(in: "@chat:a middle @term:b")
    guard parts.count == 3 else { return XCTFail("expected chip/text/chip, got \(parts)") }
    if case .chip(let first) = parts[0] { XCTAssertEqual(first.token, "@chat:a") } else { XCTFail("first") }
    XCTAssertEqual(parts[1], .text(" middle "))
    if case .chip(let last) = parts[2] { XCTAssertEqual(last.token, "@term:b") } else { XCTFail("last") }
  }

  // MARK: Clipboard

  func testCanonicalPlainTextKeepsTokensNotLabels() {
    // Mirrors `composerClipboard.ts`: the `text/plain` flavour is always the
    // canonical tokens, so a chip pasted into a terminal is still re-parseable.
    let text = "ship @lane:25f280a4-1b2c-4d3e-8f90-abcdef123456 with ade://pr/arul28/ade/1237"
    let plain = WorkChipDetector.canonicalPlainText(text)
    XCTAssertEqual(plain, text)
    XCTAssertFalse(plain.contains("Lane 25f280a4"))
    XCTAssertFalse(plain.contains("#1237"))
  }

  // MARK: Cross-surface fixture

  func testMatchesSharedMentionFixture() throws {
    struct ExpectedChip: Decodable { let kind: String; let token: String; let label: String }
    struct Row: Decodable { let text: String; let chips: [ExpectedChip] }
    struct Fixture: Decodable { let mentions: [Row] }

    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()   // ADETests
      .deletingLastPathComponent()   // apps/ios
      .deletingLastPathComponent()   // apps
      .appendingPathComponent("desktop/src/shared/__fixtures__/chipCases.json")

    let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
    XCTAssertGreaterThan(fixture.mentions.count, 5, "fixture looks empty — parity would silently pass")

    for row in fixture.mentions {
      let found = chips(row.text)
      XCTAssertEqual(
        found.count,
        row.chips.count,
        "chip count mismatch for \(row.text.debugDescription): got \(found.map(\.token))"
      )
      for (actual, expected) in zip(found, row.chips) {
        XCTAssertEqual(workChipFixtureKindName(actual.kind), expected.kind, "kind for \(row.text.debugDescription)")
        XCTAssertEqual(actual.token, expected.token, "token for \(row.text.debugDescription)")
        XCTAssertEqual(actual.label, expected.label, "label for \(row.text.debugDescription)")
      }
    }
  }
}


/// How a sent message turns into chips, and where each chip's tap goes.
final class WorkChipMessageRenderingTests: XCTestCase {
  private func chip(_ text: String) -> WorkChip {
    let found = WorkChipDetector.chips(in: text as NSString)
    return found[0]
  }

  func testInlineLabelIsGlyphPlusLabel() {
    XCTAssertEqual(workChipInlineLabel(chip("@lane:abc123de")), "◫ Lane abc123de")
    XCTAssertEqual(workChipInlineLabel(chip("@term:t1")), "▶ Terminal t1")
    XCTAssertEqual(
      workChipInlineLabel(chip("https://github.com/arul28/ade/pull/1237")),
      "⇄ arul28/ade#1237"
    )
  }

  func testWebChipsKeepTheirOwnURL() {
    XCTAssertEqual(
      workChipNavigationURL(chip("https://github.com/arul28/ade/pull/1237"))?.absoluteString,
      "https://github.com/arul28/ade/pull/1237"
    )
    XCTAssertEqual(
      workChipNavigationURL(chip("ade://lane/25f280a4-1b2c-4d3e-8f90-abcdef123456"))?.absoluteString,
      "ade://lane/25f280a4-1b2c-4d3e-8f90-abcdef123456"
    )
  }

  func testLaneAndChatMentionsGetInAppDeeplinks() {
    let lane = workChipNavigationURL(chip("@lane:25f280a4-1b2c-4d3e-8f90-abcdef123456"))
    XCTAssertEqual(lane?.scheme, "ade")
    XCTAssertEqual(lane?.host, "lane")
    XCTAssertTrue(lane?.path.contains("25f280a4-1b2c-4d3e-8f90-abcdef123456") == true)

    let chat = workChipNavigationURL(chip("@chat:9e2315e8ddef"))
    XCTAssertEqual(chat?.scheme, "ade")
    XCTAssertEqual(chat?.host, "session")
    XCTAssertTrue(chat?.path.contains("9e2315e8ddef") == true)
  }

  func testTerminalMentionHasNoTapTarget() {
    // No `ade://` shape addresses a terminal on any surface, so the pill must
    // stay inert rather than pretend to navigate.
    XCTAssertNil(workChipNavigationURL(chip("@term:tty-7")))
  }

  func testAttributedMessageReplacesTokensWithLabelsAndKeepsProse() {
    let rendered = workChipAttributedMessage(
      "look at @lane:abc123de now",
      chipForeground: .white,
      chipBackground: .clear
    )
    XCTAssertEqual(String(rendered.characters), "look at ◫ Lane abc123de now")
  }

  func testAttributedMessagePreservesHardNewlines() {
    // A flow layout of word subviews would have eaten these. The transcript
    // renders real prompts, and real prompts have paragraphs.
    let rendered = workChipAttributedMessage(
      "first line\n\nsecond @chat:abc line",
      chipForeground: .white,
      chipBackground: .clear
    )
    XCTAssertEqual(String(rendered.characters), "first line\n\nsecond 💬 Chat abc line")
  }

  func testPlainMessageIsUnchanged() {
    let rendered = workChipAttributedMessage(
      "no chips here at all",
      chipForeground: .white,
      chipBackground: .clear
    )
    XCTAssertEqual(String(rendered.characters), "no chips here at all")
  }

  func testChipRunCarriesItsLinkAndPlainProseDoesNot() {
    let rendered = workChipAttributedMessage(
      "see https://example.com/x ok",
      chipForeground: .white,
      chipBackground: .clear
    )
    let links = rendered.runs.compactMap(\.link?.absoluteString)
    XCTAssertEqual(links, ["https://example.com/x"])
  }
}


/// Copy on iOS must yield canonical TOKENS, never display labels — the
/// `text/plain` half of `apps/desktop/src/shared/composerClipboard.ts`.
///
/// iOS has no label-bearing surface to lose: the composer's `UITextView`
/// stores the raw token and only DRAWS a pill behind it, and a sent message is
/// copied from `message.markdown`. These tests pin the invariant that makes
/// that true, so a future "copy the pretty label" change fails here.
final class WorkChipClipboardCanonicalTextTests: XCTestCase {
  func testEveryChipTokenIsTheExactSourceSubstring() {
    let text = "ship @lane:abc123de and @term:t1 per https://github.com/arul28/ade/pull/1237 "
      + "plus ade://session/9e2315e8ddef"
    let ns = text as NSString
    let found = WorkChipDetector.chips(in: ns)
    XCTAssertEqual(found.count, 4)
    for chip in found {
      XCTAssertEqual(
        chip.token,
        ns.substring(with: chip.range),
        "a chip token that is not the source text cannot survive a raw-text copy"
      )
    }
  }

  func testCanonicalPlainTextIsIdempotentAndReparseable() {
    let text = "@chat:9e2315e8ddef then @lane:abc123de"
    let once = WorkChipDetector.canonicalPlainText(text)
    XCTAssertEqual(once, text)
    XCTAssertEqual(WorkChipDetector.canonicalPlainText(once), once)
    XCTAssertEqual(WorkChipDetector.chips(in: once as NSString).count, 2)
  }

  func testLabelsNeverAppearInTheCanonicalText() {
    let text = "@lane:25f280a4-1b2c-4d3e-8f90-abcdef123456"
    let plain = WorkChipDetector.canonicalPlainText(text)
    XCTAssertFalse(plain.contains("Lane "))
    XCTAssertFalse(plain.contains("◫"))
  }
}

/// Which pull requests one chat shows, and which one leads.
///
/// The defect these pin is a cap, not a crash: a chat could surface exactly one
/// PR, so a lane that had opened a second one — or a PR from another lane
/// deliberately linked to this session — was simply invisible on the phone.
final class WorkChatLinkedPrSelectionTests: XCTestCase {
  private func lane(id: String, branch: String, type: String = "worktree") -> LaneSummary {
    LaneSummary(
      id: id, name: "Lane \(id)", description: nil, laneType: type, baseRef: "main",
      branchRef: branch, worktreePath: "/tmp/\(id)", attachedRootPath: nil,
      parentLaneId: nil, childCount: 0, stackDepth: 0, parentStatus: nil, isEditProtected: false,
      status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      color: nil, icon: nil, tags: [], folder: nil, linearIssue: nil, linearIssueLinks: nil,
      createdAt: "", archivedAt: nil, devicesOpen: nil
    )
  }

  private func pr(
    id: String,
    laneId: String,
    number: Int,
    state: String = "open",
    headBranch: String = "feature/a",
    updatedAt: String = "2026-09-01T00:00:00.000Z",
    chatSessionIds: [String]? = nil,
    detached: PrDetachedLane? = nil
  ) -> PullRequestListItem {
    PullRequestListItem(
      id: id,
      laneId: laneId,
      laneName: nil,
      projectId: "project-1",
      repoOwner: "arul28",
      repoName: "ade",
      githubPrNumber: number,
      githubUrl: "https://github.com/arul28/ade/pull/\(number)",
      title: "PR \(number)",
      state: state,
      baseBranch: "main",
      headBranch: headBranch,
      checksStatus: "none",
      reviewStatus: "none",
      additions: 0,
      deletions: 0,
      lastSyncedAt: nil,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: updatedAt,
      adeKind: "single",
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil,
      detached: detached,
      chatSessionIds: chatSessionIds
    )
  }

  func testEveryPrTheLaneOwnsIsVisibleNotJustTheBranchMatch() {
    let l = lane(id: "lane-1", branch: "feature/a")
    let prs = [
      pr(id: "pr-1", laneId: "lane-1", number: 1),
      // Same lane, different branch — visible only because a chat linked it.
      pr(id: "pr-2", laneId: "lane-1", number: 2, headBranch: "feature/b", chatSessionIds: ["chat-1"]),
    ]
    let visible = workChatPullRequests(lane: l, pullRequests: prs, sessionId: "chat-1")
    XCTAssertEqual(Set(visible.map(\.id)), ["pr-1", "pr-2"])
  }

  func testPrLinkedFromAnotherLaneIsVisibleToThisChat() {
    // `linkToLane` leaves `lane_id` on the ORIGINAL owning lane, so a
    // lane-only filter would write the link and then hide it forever.
    let l = lane(id: "lane-1", branch: "feature/a")
    let prs = [
      pr(id: "pr-1", laneId: "lane-1", number: 1),
      pr(id: "pr-9", laneId: "lane-other", number: 9, headBranch: "other", chatSessionIds: ["chat-1"]),
    ]
    let visible = workChatPullRequests(lane: l, pullRequests: prs, sessionId: "chat-1")
    XCTAssertEqual(Set(visible.map(\.id)), ["pr-1", "pr-9"])
  }

  func testAnotherChatsLinkedPrIsNotVisibleHere() {
    let l = lane(id: "lane-1", branch: "feature/a")
    let prs = [
      pr(id: "pr-1", laneId: "lane-1", number: 1),
      pr(id: "pr-2", laneId: "lane-1", number: 2, headBranch: "feature/b", chatSessionIds: ["chat-2"]),
      pr(id: "pr-9", laneId: "lane-other", number: 9, headBranch: "other", chatSessionIds: ["chat-2"]),
    ]
    let visible = workChatPullRequests(lane: l, pullRequests: prs, sessionId: "chat-1")
    XCTAssertEqual(visible.map(\.id), ["pr-1"])
  }

  func testOneLinkedRowDoesNotHideTheLegacyUnlinkedRows() {
    // The lane fallback is decided PER PR. A row with no links at all predates
    // the link table and must stay visible next to a linked one.
    let l = lane(id: "lane-1", branch: "feature/a")
    let prs = [
      pr(id: "pr-legacy", laneId: "lane-1", number: 1),
      pr(id: "pr-linked", laneId: "lane-1", number: 2, chatSessionIds: ["chat-1"]),
    ]
    let visible = workChatPullRequests(lane: l, pullRequests: prs, sessionId: "chat-1")
    XCTAssertEqual(Set(visible.map(\.id)), ["pr-legacy", "pr-linked"])
  }

  func testDetachedRowsAreHistoryNotLiveLaneState() {
    let l = lane(id: "lane-1", branch: "feature/a")
    let prs = [
      pr(id: "pr-1", laneId: "lane-1", number: 1),
      pr(
        id: "pr-gone",
        laneId: "lane-1",
        number: 2,
        chatSessionIds: ["chat-1"],
        detached: PrDetachedLane(at: "2026-09-01T00:00:00.000Z", laneName: "old", laneColor: nil, chats: 0, artifacts: 0, checkpoints: 0)
      ),
    ]
    let visible = workChatPullRequests(lane: l, pullRequests: prs, sessionId: "chat-1")
    XCTAssertEqual(visible.map(\.id), ["pr-1"])
  }

  func testNewestOpenPrLeadsTheList() {
    let l = lane(id: "lane-1", branch: "feature/a")
    let prs = [
      pr(id: "pr-merged", laneId: "lane-1", number: 5, state: "merged",
         updatedAt: "2026-09-10T00:00:00.000Z", chatSessionIds: ["chat-1"]),
      pr(id: "pr-old-open", laneId: "lane-1", number: 3,
         updatedAt: "2026-09-02T00:00:00.000Z", chatSessionIds: ["chat-1"]),
      pr(id: "pr-new-open", laneId: "lane-1", number: 4,
         updatedAt: "2026-09-09T00:00:00.000Z", chatSessionIds: ["chat-1"]),
    ]
    let visible = workChatPullRequests(lane: l, pullRequests: prs, sessionId: "chat-1")
    XCTAssertEqual(visible.first?.id, "pr-new-open")
    XCTAssertEqual(Set(visible.map { $0.id }), ["pr-merged", "pr-old-open", "pr-new-open"])
  }

  func testOpenBeatsDraftWhichBeatsTerminal() {
    let draft = pr(id: "d", laneId: "l", number: 1, state: "draft", updatedAt: "2026-09-12T00:00:00.000Z")
    let open = pr(id: "o", laneId: "l", number: 2, state: "open", updatedAt: "2026-09-01T00:00:00.000Z")
    let merged = pr(id: "m", laneId: "l", number: 3, state: "merged", updatedAt: "2026-09-20T00:00:00.000Z")
    XCTAssertEqual(pickPrimaryPr([merged, draft, open])?.id, "o")
    XCTAssertEqual(pickPrimaryPr([merged, draft])?.id, "d")
    XCTAssertNil(pickPrimaryPr([]))
  }

  func testNoLaneMeansNoPrs() {
    XCTAssertTrue(workChatPullRequests(lane: nil, pullRequests: [], sessionId: "chat-1").isEmpty)
  }

  func testBadgeCarriesTheLinkedCount() {
    let tag = workChatPrTag(from: pr(id: "pr-1", laneId: "lane-1", number: 7))
    XCTAssertEqual(workChatPrBadgeModel(tag: tag, pr: nil, linkedCount: 3)?.linkedCount, 3)
    // Never below one: the badge exists, so at least one PR does.
    XCTAssertEqual(workChatPrBadgeModel(tag: tag, pr: nil, linkedCount: 0)?.linkedCount, 1)
    XCTAssertEqual(workChatPrBadgeModel(tag: tag, pr: nil)?.linkedCount, 1)
  }
}

/// What a blocking question is allowed to take away from the composer.
///
/// The defect these pin: the question card locked the whole composer, so the
/// one moment a user most needs to attach a file — the agent has just asked
/// which of two screenshots to use — was the one moment the phone refused. The
/// desktop never had this; its `AskQuestionComposer` gates the paperclip on
/// `canAttach`, not on the pending-input gate.
final class WorkComposerInputGateTests: XCTestCase {
  private func gate(
    canComposeMessages: Bool = true,
    canSendMessages: Bool = true,
    sending: Bool = false,
    sendWillQueue: Bool = false,
    hasPendingInputGate: Bool = false
  ) -> WorkComposerInputGate {
    workChatComposerInputGate(
      canComposeMessages: canComposeMessages,
      canSendMessages: canSendMessages,
      sending: sending,
      sendWillQueue: sendWillQueue,
      hasPendingInputGate: hasPendingInputGate
    )
  }

  func testAQuestionLocksTextAndSendButNotFiles() {
    let gated = gate(hasPendingInputGate: true)
    XCTAssertFalse(gated.canCompose)
    XCTAssertFalse(gated.canSend)
    XCTAssertTrue(gated.canAttach)
  }

  func testWithNoQuestionOpenEverythingFollowsTheChat() {
    let open = gate()
    XCTAssertTrue(open.canCompose)
    XCTAssertTrue(open.canSend)
    XCTAssertTrue(open.canAttach)
  }

  func testAChatThatCannotComposeAtAllCannotAttachEither() {
    // Reading a subagent transcript, or no host: those are facts about the
    // chat, not about the question, and they close the paperclip too.
    let locked = gate(canComposeMessages: false, hasPendingInputGate: true)
    XCTAssertFalse(locked.canCompose)
    XCTAssertFalse(locked.canAttach)
    XCTAssertFalse(locked.canSend)
  }

  func testAnInFlightSendStillBlocksSendingButNotAttaching() {
    let inFlight = gate(sending: true)
    XCTAssertFalse(inFlight.canSend)
    XCTAssertTrue(inFlight.canAttach)
    // A queueable host keeps Send live while the previous one is still moving.
    XCTAssertTrue(gate(sending: true, sendWillQueue: true).canSend)
  }

  func testSendIsGatedIndependentlyOfComposing() {
    // Drafting stays available while disconnected; only Send closes.
    let offline = gate(canSendMessages: false)
    XCTAssertTrue(offline.canCompose)
    XCTAssertTrue(offline.canAttach)
    XCTAssertFalse(offline.canSend)
  }

  func testAttachHintOnlyAppearsWhenTextIsLockedAndFilesAreNot() {
    XCTAssertEqual(
      workChatComposerAttachHint(canCompose: false, canAttach: true),
      "Files ride your next message"
    )
    XCTAssertNil(workChatComposerAttachHint(canCompose: true, canAttach: true))
    XCTAssertNil(workChatComposerAttachHint(canCompose: false, canAttach: false))
  }
}
