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

  func testSmartLinkCataloguePreservesURLsAndCompactLabels() throws {
    let text = "https://github.com/arul28/ADE/pull/835 https://linear.app/ade/issue/ADE-89/title https://evil.github.com/x/y https://example.com/foo(bar)." as NSString
    let links = WorkSmartLinkDetector.links(in: text)

    guard links.count == 4 else {
      XCTFail("Expected 4 links, got \(links.count)")
      return
    }
    XCTAssertEqual(links[0].url, "https://github.com/arul28/ADE/pull/835")
    XCTAssertEqual(links[0].compactLabel, "arul28/ADE#835")
    XCTAssertEqual(links[1].provider, .linear)
    XCTAssertEqual(links[1].compactLabel, "ADE-89")
    XCTAssertEqual(links[2].provider, .web)
    XCTAssertEqual(links[3].url, "https://example.com/foo(bar)")
    XCTAssertTrue(WorkSmartLinkDetector.links(in: "broken http:// and ade://" as NSString).isEmpty)
  }

  func testSmartLinkCatalogueNormalizesProviderSpecificLabels() {
    let text = "https://github.com/Arul/ADE.git/PULL/835 https://linear.app/ade/ISSUE/ade-89/title https://linear.app/ade/project/roadmap ade://lane/25f280a4/session/abc" as NSString
    let links = WorkSmartLinkDetector.links(in: text)

    guard links.count == 4 else {
      XCTFail("Expected 4 links, got \(links.count)")
      return
    }
    XCTAssertEqual(links[0].provider, .github)
    XCTAssertEqual(links[0].compactLabel, "Arul/ADE#835")
    XCTAssertEqual(links[1].provider, .linear)
    XCTAssertEqual(links[1].compactLabel, "ADE-89")
    XCTAssertEqual(links[2].provider, .web)
    XCTAssertEqual(links[2].compactLabel, "https://linear.app/ade/project/roadmap")
    XCTAssertEqual(links[3].provider, .ade)
    XCTAssertEqual(links[3].compactLabel, "ADE · lane/25f280a4/session/abc")
  }

  func testSmartLinkDeletionExpandsSingleKeysAndBroaderSelections() throws {
    let text = "before https://example.com/a after" as NSString
    let link = try XCTUnwrap(WorkSmartLinkDetector.links(in: text).first)
    let oneCharacter = NSRange(location: NSMaxRange(link.range) - 1, length: 1)
    let broadSelection = NSRange(location: 3, length: NSMaxRange(link.range) - 3 - 1)

    XCTAssertEqual(
      WorkSmartLinkDetector.atomicDeletionRange(in: text, range: oneCharacter, replacementText: ""),
      link.range
    )
    let expanded = try XCTUnwrap(
      WorkSmartLinkDetector.atomicDeletionRange(in: text, range: broadSelection, replacementText: "")
    )
    XCTAssertEqual(expanded.location, broadSelection.location)
    XCTAssertEqual(NSMaxRange(expanded), NSMaxRange(link.range))
    XCTAssertNil(WorkSmartLinkDetector.atomicDeletionRange(in: text, range: oneCharacter, replacementText: "x"))
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

  func testCliInitialInputIncludesDesktopParityAttachmentManifest() {
    let prompt = workCliInitialInput(
      text: "  Inspect these inputs  ",
      attachments: [
        AgentChatFileRef(path: "/tmp/screenshot.jpg", type: "image"),
        AgentChatFileRef(path: "/tmp/notes.txt", type: "file"),
        AgentChatFileRef(path: "", type: "image-url", url: "https://example.com/reference.png"),
      ]
    )

    XCTAssertEqual(
      prompt,
      """
      Attached files and images:
      1. Image file: /tmp/screenshot.jpg
      2. File: /tmp/notes.txt
      3. Image URL: https://example.com/reference.png

      Inspect these inputs
      """
    )
    XCTAssertEqual(workCliInitialInput(text: "  hello  ", attachments: []), "hello")
    XCTAssertEqual(
      workCliInitialInput(
        text: "",
        attachments: [AgentChatFileRef(path: "/tmp/only-image.jpg", type: "image")]
      ),
      """
      Attached files and images:
      1. Image file: /tmp/only-image.jpg
      """
    )
  }

  @MainActor
  func testOfflinePreparedAttachmentWaitsForReconnectBeforeSend() throws {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
      UIColor.systemGreen.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
    }
    let attachment = try XCTUnwrap(workChatInputAttachment(from: image))

    XCTAssertFalse(workChatInputCanSend(
      text: "Inspect this",
      attachments: [attachment],
      baseEnabled: true,
      canUploadAttachments: false
    ))
    XCTAssertTrue(workChatInputCanSend(
      text: "Inspect this",
      attachments: [attachment],
      baseEnabled: true,
      canUploadAttachments: true
    ))

    let failed = WorkChatInputAttachment(filename: "bad.jpg", state: .failed("Could not load image."))
    XCTAssertFalse(workChatInputCanSend(
      text: "Send anyway",
      attachments: [failed],
      baseEnabled: true,
      canUploadAttachments: true
    ))
  }

  @MainActor
  func testPastedImagesAreBoundedAndOverflowIsVisible() {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in
      UIColor.black.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
    }
    var attachments: [WorkChatInputAttachment] = []
    workChatInputPasteImages(
      Array(repeating: image, count: workChatInputAttachmentLimit + 2),
      into: Binding(get: { attachments }, set: { attachments = $0 })
    )

    XCTAssertEqual(workChatInputReadyAttachments(attachments).count, workChatInputAttachmentLimit)
    XCTAssertEqual(attachments.count, workChatInputAttachmentLimit + 1)
    XCTAssertTrue(workChatInputHasFailedAttachments(attachments))
    XCTAssertEqual(attachments.last?.errorMessage, "You can attach up to 10 images at a time.")

    workChatInputPasteImages(
      Array(repeating: image, count: workChatInputAttachmentLimit),
      into: Binding(get: { attachments }, set: { attachments = $0 })
    )
    XCTAssertEqual(attachments.count, workChatInputAttachmentLimit + 1)
    XCTAssertEqual(
      attachments.filter { $0.errorMessage == "You can attach up to 10 images at a time." }.count,
      1
    )
  }

  @MainActor
  func testImageOnlyClipboardExposesPasteAndDispatchesEveryImage() {
    let first = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
      UIColor.systemRed.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
    }
    let second = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
      UIColor.systemBlue.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
    }
    let pasteboard = UIPasteboard.general
    let previousItems = pasteboard.items
    defer { pasteboard.items = previousItems }
    pasteboard.images = [first, second]

    let textView = WorkComposerPastingTextView()
    var receivedImages: [UIImage] = []
    textView.onPasteImages = { images in
      receivedImages = images
      return true
    }

    XCTAssertTrue(textView.canPerformAction(
      #selector(UIResponderStandardEditActions.paste(_:)),
      withSender: nil
    ))
    textView.paste(nil)
    XCTAssertEqual(receivedImages.count, 2)
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
  func testAmbiguousOpeningPromptRestoresOnceIntoMountedComposer() {
    let draft = WorkChatComposerDraftState()
    let restore = WorkChatComposerDraftRestore(
      text: "Check whether this already started",
      id: UUID()
    )

    draft.applyRestore(restore)
    XCTAssertEqual(draft.text, "Check whether this already started")
    XCTAssertTrue(draft.isFocused)

    XCTAssertEqual(draft.consumeSendableText(), "Check whether this already started")
    draft.applyRestore(restore)
    XCTAssertEqual(draft.text, "", "The same restoration token must not refill a draft after the user sends it.")

    draft.applyRestore(WorkChatComposerDraftRestore(
      text: "A later unconfirmed send",
      id: UUID()
    ))
    XCTAssertEqual(draft.text, "A later unconfirmed send")
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
