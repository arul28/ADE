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
