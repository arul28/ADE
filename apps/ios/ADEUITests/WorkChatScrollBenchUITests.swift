import XCTest

/// Gesture driver for the Work chat scroll bench.
///
/// This target exists because `idb`'s HID path needs
/// `Developer/Library/PrivateFrameworks/SimulatorKit.framework`, which the
/// installed Xcode does not ship — XCUITest is the only real-touch path on this
/// machine. Each test launches the DEBUG fixture screen
/// (`-adePreviewScreen chat-scroll`, see `WorkChatScrollBench.swift`) over a
/// transcript JSONL seeded into the app container, drives one case, and leaves
/// the analysis to the `com.ade.ios.scrollbench` log stream.
///
///   DATA=$(xcrun simctl get_app_container <UDID> com.ade.ios data)
///   cp thread.jsonl "$DATA/Documents/bench.jsonl"
///   xcrun simctl spawn <UDID> log stream --style compact \
///     --predicate 'subsystem == "com.ade.ios.scrollbench"' > case.log &
///   xcrun simctl io <UDID> recordVideo --codec h264 case.mp4 &
///   until mkdir "$TMPDIR/ade-xcodebuild.lock" 2>/dev/null; do sleep 15; done; \
///     xcodebuild test -project apps/ios/ADE.xcodeproj -scheme ADEScrollBench \
///       -destination 'platform=iOS Simulator,id=<UDID>' \
///       -derivedDataPath "$TMPDIR/dd-scroll-bench" \
///       -only-testing:ADEUITests/WorkChatScrollBenchUITests/testCaseA_slowScrollUp; \
///     rc=$?; rmdir "$TMPDIR/ade-xcodebuild.lock"; exit $rc
///
/// `ADE_BENCH_TRANSCRIPT` overrides the seeded transcript path.
final class WorkChatScrollBenchUITests: XCTestCase {
  private var transcriptPath: String {
    ProcessInfo.processInfo.environment["ADE_BENCH_TRANSCRIPT"]
      ?? "/tmp/bench.jsonl"
  }

  private func launch(extra: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = [
      "-adePreviewScreen", "chat-scroll",
      "-adeBenchTranscript", transcriptPath,
      "-adeScrollTrace",
      "-adeBenchLimit", ProcessInfo.processInfo.environment["ADE_BENCH_LIMIT"] ?? "3000",
    ] + extra
    app.launch()
    return app
  }

  /// Transcript area of the window: below the header, above the composer.
  private func transcript(_ app: XCUIApplication) -> XCUIElement {
    app.scrollViews.firstMatch.exists ? app.scrollViews.firstMatch : app.windows.firstMatch
  }

  private func drag(
    _ app: XCUIApplication,
    fromY: CGFloat,
    toY: CGFloat,
    duration: TimeInterval
  ) {
    let window = app.windows.firstMatch
    let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: fromY))
    let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: toY))
    start.press(forDuration: duration, thenDragTo: end)
  }

  // (a) Open at the tail, then scroll up slowly through three screens.
  func testCaseA_slowScrollUp() {
    let app = launch()
    sleep(6)
    for _ in 0..<3 {
      drag(app, fromY: 0.25, toY: 0.72, duration: 0.9)
      sleep(2)
    }
    sleep(3)
  }

  // (b) Fling up, then let momentum stop.
  func testCaseB_fling() {
    let app = launch()
    sleep(6)
    for _ in 0..<2 {
      drag(app, fromY: 0.2, toY: 0.8, duration: 0.02)
      sleep(4)
    }
    sleep(3)
  }

  // (c) Scroll up, then tap jump-to-latest.
  func testCaseC_jumpToLatest() {
    let app = launch()
    sleep(6)
    drag(app, fromY: 0.2, toY: 0.8, duration: 0.05)
    sleep(3)
    let pill = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'latest'")).firstMatch
    if pill.waitForExistence(timeout: 3) {
      pill.tap()
    } else {
      // The pill carries a count label rather than text on some builds; fall
      // back to its screen position (bottom trailing of the transcript).
      app.windows.firstMatch
        .coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.76))
        .tap()
    }
    sleep(4)
  }

  // (d) Reach the top, trigger load-older (prepend), keep scrolling.
  func testCaseD_prepend() {
    let app = launch()
    sleep(6)
    for _ in 0..<26 {
      drag(app, fromY: 0.15, toY: 0.85, duration: 0.02)
      usleep(400_000)
    }
    sleep(4)
    for _ in 0..<4 {
      drag(app, fromY: 0.25, toY: 0.7, duration: 0.8)
      sleep(1)
    }
    sleep(4)
  }

  // (e) Sit at the tail while events append.
  func testCaseE_streamAtTail() {
    _ = launch(extra: ["-adeBenchStream", "160", "-adeBenchStreamIntervalMs", "140"])
    sleep(35)
  }

  // (f) Scrolled up two screens while events append.
  func testCaseF_streamScrolledUp() {
    let app = launch(extra: ["-adeBenchStream", "160", "-adeBenchStreamIntervalMs", "140"])
    sleep(5)
    for _ in 0..<2 {
      drag(app, fromY: 0.25, toY: 0.75, duration: 0.5)
      usleep(500_000)
    }
    sleep(32)
  }

  // (g) The keyboard, in both states the transcript can be in: scrolled up
  // (the reader's row must not move) and following (the tail must stay glued).
  func testCaseG_keyboard() {
    let app = launch()
    sleep(6)
    let composer = app.textViews.firstMatch.exists
      ? app.textViews.firstMatch
      : app.textFields.firstMatch

    // (g1) Scrolled up, so the transcript is not following.
    drag(app, fromY: 0.25, toY: 0.75, duration: 0.5)
    sleep(2)
    if composer.waitForExistence(timeout: 4) {
      composer.tap()
    } else {
      app.windows.firstMatch
        .coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.88))
        .tap()
    }
    sleep(5)

    // Interactive dismiss: dragging the transcript down puts the keyboard away.
    drag(app, fromY: 0.35, toY: 0.9, duration: 0.6)
    sleep(3)

    // (g2) Back to the tail, where the transcript follows again, then reopen.
    // Through the pill rather than by dragging: the point of this half is the
    // keyboard, and a drag that stops short leaves the transcript not
    // following and tests the same thing (g1) already did.
    let pill = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'latest'")).firstMatch
    if pill.waitForExistence(timeout: 3) {
      pill.tap()
    } else {
      app.windows.firstMatch
        .coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.76))
        .tap()
    }
    sleep(4)
    if composer.exists {
      composer.tap()
    }
    sleep(5)
  }

  // (h) Cold open: where does the transcript land.
  func testCaseH_initialLanding() {
    _ = launch()
    sleep(12)
  }
}
