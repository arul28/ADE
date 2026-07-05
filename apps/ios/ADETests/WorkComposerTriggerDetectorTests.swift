import XCTest
@testable import ADE

/// Pure-logic coverage for the cursor-relative trigger detector that mirrors the
/// shared desktop/TUI regexes (`(?:^|\s)/([^\s/]*)$` and `(?:^|\s)@([^\s@]*)$`).
/// Locks in the boundary rules that keep paths, fractions, and emails from
/// opening the suggestion strip, plus the closest-to-cursor tie-break.
final class WorkComposerTriggerDetectorTests: XCTestCase {
  private func detect(_ text: String, cursor: Int? = nil) -> WorkComposerTriggerMatch? {
    let ns = text as NSString
    return WorkComposerTriggerDetector.detect(in: ns, cursor: cursor ?? ns.length)
  }

  // MARK: Slash

  func testSlashAtStart() {
    let match = detect("/rev")
    XCTAssertEqual(match?.kind, .slash)
    XCTAssertEqual(match?.query, "rev")
    XCTAssertEqual(match?.range, NSRange(location: 0, length: 4))
  }

  func testSlashMidSentenceAfterWhitespace() {
    // "fix this then /pl" — trigger lives after a space, not at index 0.
    let text = "fix this then /pl"
    let match = detect(text)
    XCTAssertEqual(match?.kind, .slash)
    XCTAssertEqual(match?.query, "pl")
    XCTAssertEqual(match?.range, NSRange(location: 14, length: 3))
  }

  func testBareSlashHasEmptyQuery() {
    let match = detect("/")
    XCTAssertEqual(match?.kind, .slash)
    XCTAssertEqual(match?.query, "")
    XCTAssertEqual(match?.range, NSRange(location: 0, length: 1))
  }

  func testSlashInsidePathDoesNotTrigger() {
    // A second `/` breaks the token, so `/usr/bin` never opens the menu.
    XCTAssertNil(detect("cat /usr/bin"))
  }

  func testSlashWithoutBoundaryDoesNotTrigger() {
    // "3/4" — the `/` is glued to a preceding non-space char.
    XCTAssertNil(detect("3/4"))
  }

  // MARK: At

  func testAtFileMidSentence() {
    let text = "look at @src/app.ts"
    let match = detect(text)
    XCTAssertEqual(match?.kind, .at)
    XCTAssertEqual(match?.query, "src/app.ts")
    XCTAssertEqual(match?.range, NSRange(location: 8, length: 11))
  }

  func testAtAllowsSlashesForPaths() {
    let match = detect("@a/b/c")
    XCTAssertEqual(match?.kind, .at)
    XCTAssertEqual(match?.query, "a/b/c")
  }

  func testEmailDoesNotTrigger() {
    // The `@` is glued to a preceding non-space char, so emails never trigger.
    XCTAssertNil(detect("ping foo@bar"))
  }

  // MARK: Cursor relativity

  func testDetectsAtCursorNotEndOfText() {
    // Caret sits right after "/pl"; the trailing " and go" is ignored.
    let text = "/plan and go"
    let match = detect(text, cursor: 3)
    XCTAssertEqual(match?.kind, .slash)
    XCTAssertEqual(match?.query, "pl")
  }

  func testNoTriggerWhenCursorPastCompletedToken() {
    // Caret after the space following "/plan": the token is closed.
    XCTAssertNil(detect("/plan ", cursor: 6))
  }

  // MARK: Tie-break

  func testClosestToCursorWinsWhenBothMatch() {
    // "run /a @b" — the `@` sits closest to the cursor, so it wins.
    let text = "run /a @b"
    let match = detect(text)
    XCTAssertEqual(match?.kind, .at)
    XCTAssertEqual(match?.query, "b")
  }

  func testSlashWinsWhenItIsClosest() {
    // "@a /b" — the `/` is nearest the cursor.
    let match = detect("@a /b")
    XCTAssertEqual(match?.kind, .slash)
    XCTAssertEqual(match?.query, "b")
  }

  // MARK: Bounds

  func testEmptyTextIsNoTrigger() {
    XCTAssertNil(detect(""))
  }

  func testOutOfRangeCursorIsNoTrigger() {
    XCTAssertNil(detect("/rev", cursor: 99))
    XCTAssertNil(detect("/rev", cursor: -1))
  }
}
