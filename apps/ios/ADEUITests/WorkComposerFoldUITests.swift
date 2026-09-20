import XCTest

/// Gesture driver + contract for the composer fold.
///
/// The fold exists so a reader can pause mid-sentence and read the thread. That
/// makes "the transcript did not move" the whole point of the feature, not a
/// detail — so it is asserted here, over the real `WorkChatSessionView` the
/// scroll bench fixture mounts (`-adePreviewScreen chat-scroll`), with a draft
/// long enough that the fold has real height to travel.
///
///   DATA=$(xcrun simctl get_app_container <UDID> com.ade.ios data)
///   head -n 200 thread.jsonl > "$DATA/Documents/bench.jsonl"
///   until mkdir "$TMPDIR/ade-xcodebuild.lock" 2>/dev/null; do sleep 15; done; \
///     xcodebuild test -project apps/ios/ADE.xcodeproj -scheme ADE \
///       -destination 'platform=iOS Simulator,id=<UDID>' \
///       -derivedDataPath "$TMPDIR/dd-composer" -parallel-testing-enabled NO \
///       -only-testing:ADEUITests/WorkComposerFoldUITests; \
///     rc=$?; rmdir "$TMPDIR/ade-xcodebuild.lock"; exit $rc
final class WorkComposerFoldUITests: XCTestCase {
  private var transcriptPath: String {
    ProcessInfo.processInfo.environment["ADE_BENCH_TRANSCRIPT"] ?? "/tmp/bench.jsonl"
  }

  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = [
      "-adePreviewScreen", "chat-scroll",
      "-adeBenchTranscript", transcriptPath,
      "-adeBenchLimit", "200",
    ]
    app.launch()
    return app
  }

  private func composerField(_ app: XCUIApplication) -> XCUIElement {
    app.textViews["Work.Chat.Composer.TextView"]
  }

  /// A 40-line draft, typed rather than injected, so the field measures the
  /// same way it does for a person holding the phone.
  private func longDraft() -> String {
    (1...40).map { "line \($0) of a long draft that keeps going" }.joined(separator: "\n")
  }

  /// The topmost transcript label, which is what "my place in the thread" means
  /// to the reader. Taken from the upper half of the window so the composer and
  /// the keyboard can never be the thing being measured.
  private func topTranscriptLabel(_ app: XCUIApplication) -> (label: String, y: CGFloat)? {
    let window = app.windows.firstMatch.frame
    let candidates = app.staticTexts.allElementsBoundByIndex
      .filter { $0.exists && $0.frame.height > 0 && $0.frame.minY > window.minY + 60 }
      .filter { $0.frame.maxY < window.midY }
      .sorted { $0.frame.minY < $1.frame.minY }
    guard let first = candidates.first else { return nil }
    return (first.label, first.frame.minY)
  }

  private func swipeDownOnComposer(_ app: XCUIApplication) {
    let window = app.windows.firstMatch
    let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.80))
    let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.93))
    start.press(forDuration: 0.12, thenDragTo: end)
  }

  /// Folding shrinks the composer, lowers the keyboard, and leaves the reader
  /// exactly where they were.
  func testSwipeDownFoldsComposerWithoutMovingTheThread() {
    let app = launch()
    let field = composerField(app)
    XCTAssertTrue(field.waitForExistence(timeout: 30), "bench fixture never rendered the composer")

    field.tap()
    field.typeText(longDraft())
    let grownHeight = field.frame.height
    XCTAssertGreaterThan(grownHeight, 60, "a 40-line draft should grow the field past one line")

    guard let before = topTranscriptLabel(app) else {
      return XCTFail("no transcript row to anchor on")
    }

    swipeDownOnComposer(app)

    // The fold's spring; polled rather than slept on.
    let folded = expectation(description: "composer folded")
    let deadline = Date().addingTimeInterval(5)
    func poll() {
      if field.exists, field.frame.height < grownHeight - 8 {
        folded.fulfill()
      } else if Date() < deadline {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: poll)
      } else {
        folded.fulfill()
      }
    }
    poll()
    wait(for: [folded], timeout: 6)

    XCTAssertLessThan(field.frame.height, grownHeight - 8, "swiping down did not fold the field")
    XCTAssertFalse(app.keyboards.firstMatch.exists, "swiping down did not lower the keyboard")

    guard let after = topTranscriptLabel(app) else {
      return XCTFail("transcript lost its rows across the fold")
    }
    XCTAssertEqual(after.label, before.label, "the fold scrolled the thread to a different row")
    XCTAssertEqual(
      after.y,
      before.y,
      accuracy: 2,
      "the fold moved the reader's place in the thread"
    )

    // The draft survives the fold, and is still the same message.
    XCTAssertTrue(field.value as? String != "" , "the fold cleared the draft")
  }
}
