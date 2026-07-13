import XCTest
import UIKit
import SwiftUI
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

  @MainActor
  func testInputImageAttachmentNormalizesToJPEGDataURL() throws {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 12)).image { context in
      UIColor.systemBlue.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 24, height: 12))
    }

    let attachment = try XCTUnwrap(workChatInputAttachment(from: image, filename: " pasted.png "))
    XCTAssertEqual(attachment.filename, "pasted.png")
    XCTAssertEqual(attachment.mimeType, "image/jpeg")
    XCTAssertTrue(attachment.isReady)
    XCTAssertTrue((attachment.uploadData?.count ?? 0) > 0)
    XCTAssertTrue(workChatInputAttachmentDataURL(attachment)?.hasPrefix("data:image/jpeg;base64,") == true)
    XCTAssertEqual(workChatOutgoingText("", attachmentCount: 1), "Attached image.")
    XCTAssertEqual(workChatOutgoingText("  hello  ", attachmentCount: 1), "hello")
  }

  @MainActor
  func testPlainComposerDefersFocusTransitionsOutsideSwiftUIUpdate() async {
    var text = ""
    var isFocused = false
    var measuredHeight: CGFloat = 28
    let parent = WorkPlainComposerTextView(
      text: Binding(get: { text }, set: { text = $0 }),
      isFocused: Binding(get: { isFocused }, set: { isFocused = $0 }),
      measuredHeight: Binding(get: { measuredHeight }, set: { measuredHeight = $0 }),
      placeholder: "Type to vibecode..."
    )
    let coordinator = WorkPlainComposerTextView.Coordinator(parent)
    let textView = FocusRecordingTextView()
    textView.resetRecording()

    textView.fakeIsFirstResponder = true
    let initialTask = coordinator.applyFocusRequest(false, to: textView)
    await initialTask?.value
    XCTAssertEqual(textView.resignCount, 0)
    XCTAssertTrue(textView.fakeIsFirstResponder)

    textView.fakeIsFirstResponder = false
    let focusTask = coordinator.applyFocusRequest(true, to: textView)
    XCTAssertEqual(textView.becomeCount, 0)
    await focusTask?.value
    XCTAssertEqual(textView.becomeCount, 1)
    XCTAssertTrue(textView.fakeIsFirstResponder)

    let settledFocusTask = coordinator.applyFocusRequest(true, to: textView)
    XCTAssertNil(settledFocusTask)
    XCTAssertEqual(textView.becomeCount, 1)

    coordinator.applyFocusRequest(false, to: textView)
    let dismissTask = coordinator.applyFocusRequest(false, to: textView)
    XCTAssertEqual(textView.resignCount, 0)
    await dismissTask?.value
    XCTAssertEqual(textView.resignCount, 1)
    XCTAssertFalse(textView.fakeIsFirstResponder)
  }

  @MainActor
  func testSendingAndRestoringChatDraftUpdatesTextAndFocus() {
    let draft = WorkChatComposerDraftState()
    draft.text = "  Ship this change  "
    draft.isFocused = true

    XCTAssertEqual(draft.consumeSendableText(), "Ship this change")
    XCTAssertEqual(draft.text, "")
    XCTAssertFalse(draft.isFocused)

    draft.restoreUnsentText("Ship this change")
    XCTAssertEqual(draft.text, "Ship this change")
    XCTAssertTrue(draft.isFocused)
  }

  @MainActor
  func testChatComposerDefersAndCoalescesRequestedFocusTransitions() async {
    let draft = WorkChatComposerDraftState()
    let controller = WorkComposerSuggestionController()
    var measuredHeight: CGFloat = 24
    let parent = WorkComposerTextView(
      draftState: draft,
      controller: controller,
      canCompose: true,
      placeholder: "Message ADE…",
      measuredHeight: Binding(get: { measuredHeight }, set: { measuredHeight = $0 })
    )
    let coordinator = WorkComposerTextView.Coordinator(parent)
    let textView = FocusRecordingTextView()
    textView.resetRecording()

    let initialTask = coordinator.applyFocusRequest(false, to: textView)
    await initialTask?.value
    XCTAssertEqual(textView.resignCount, 0)

    let focusTask = coordinator.applyFocusRequest(true, to: textView)
    XCTAssertEqual(textView.becomeCount, 0)
    await focusTask?.value
    XCTAssertEqual(textView.becomeCount, 1)
    XCTAssertTrue(textView.fakeIsFirstResponder)

    let settledFocusTask = coordinator.applyFocusRequest(true, to: textView)
    XCTAssertNil(settledFocusTask)
    XCTAssertEqual(textView.becomeCount, 1)

    let dismissTask = coordinator.applyFocusRequest(false, to: textView)
    XCTAssertEqual(textView.resignCount, 0)
    await dismissTask?.value
    XCTAssertEqual(textView.resignCount, 1)
    XCTAssertFalse(textView.fakeIsFirstResponder)

    // A failed send can restore focus before the queued dismissal runs. Only
    // the latest request should win, so the keyboard never flickers closed.
    textView.fakeIsFirstResponder = true
    let refocusTask = coordinator.applyFocusRequest(true, to: textView)
    await refocusTask?.value
    textView.resetRecording(firstResponder: true)

    coordinator.applyFocusRequest(false, to: textView)
    let restoredFocusTask = coordinator.applyFocusRequest(true, to: textView)
    await restoredFocusTask?.value

    XCTAssertEqual(textView.becomeCount, 0)
    XCTAssertEqual(textView.resignCount, 0)
    XCTAssertTrue(textView.fakeIsFirstResponder)
  }
}

private final class FocusRecordingTextView: UITextView {
  var fakeIsFirstResponder = false
  var becomeCount = 0
  var resignCount = 0

  override var isFirstResponder: Bool {
    fakeIsFirstResponder
  }

  override func becomeFirstResponder() -> Bool {
    becomeCount += 1
    fakeIsFirstResponder = true
    return true
  }

  override func resignFirstResponder() -> Bool {
    resignCount += 1
    fakeIsFirstResponder = false
    return true
  }

  func resetRecording(firstResponder: Bool = false) {
    becomeCount = 0
    resignCount = 0
    fakeIsFirstResponder = firstResponder
  }
}
