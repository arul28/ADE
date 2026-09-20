import XCTest
import SwiftUI
@testable import ADE

/// The composer fold is a gesture now, not a button, so the two things that
/// used to be guaranteed by a tap target have to be guaranteed by these rules
/// instead:
///
/// 1. only a deliberate, mostly-vertical swipe folds or unfolds the card — a
///    horizontal drag belongs to the attachment tray or a text selection;
/// 2. the fold and the keyboard move together, and expanding never raises a
///    keyboard over a field a pending question has locked.
final class WorkComposerFoldStateTests: XCTestCase {
  // MARK: Gesture classification

  func testDownwardSwipePastThresholdCollapses() {
    XCTAssertEqual(
      workComposerFoldGesture(translation: CGSize(width: 4, height: 56), collapsed: false),
      .collapse
    )
  }

  func testShortDownwardDragIsIgnored() {
    XCTAssertEqual(
      workComposerFoldGesture(translation: CGSize(width: 0, height: 24), collapsed: false),
      .ignore
    )
  }

  func testMostlyHorizontalDragIsIgnored() {
    // The compact tray scrolls horizontally; a diagonal flick across it must not
    // fold the composer out from under the finger.
    XCTAssertEqual(
      workComposerFoldGesture(translation: CGSize(width: 120, height: 48), collapsed: false),
      .ignore
    )
  }

  func testDownwardSwipeOnAFoldedCardDoesNothing() {
    XCTAssertEqual(
      workComposerFoldGesture(translation: CGSize(width: 0, height: 80), collapsed: true),
      .ignore
    )
  }

  func testUpwardSwipeOnAFoldedCardExpands() {
    XCTAssertEqual(
      workComposerFoldGesture(translation: CGSize(width: -6, height: -64), collapsed: true),
      .expand
    )
  }

  func testUpwardSwipeOnAnExpandedCardDoesNothing() {
    XCTAssertEqual(
      workComposerFoldGesture(translation: CGSize(width: 0, height: -64), collapsed: false),
      .ignore
    )
  }

  // MARK: Transitions

  func testCollapseLowersTheKeyboardWithTheCard() {
    let next = workComposerFoldTransition(
      WorkComposerFoldState(collapsed: false, focused: true),
      intent: .collapse,
      canCompose: true
    )
    XCTAssertEqual(next, WorkComposerFoldState(collapsed: true, focused: false))
  }

  func testExpandRefocusesTheField() {
    let next = workComposerFoldTransition(
      WorkComposerFoldState(collapsed: true, focused: false),
      intent: .expand,
      canCompose: true
    )
    XCTAssertEqual(next, WorkComposerFoldState(collapsed: false, focused: true))
  }

  func testExpandDoesNotRaiseAKeyboardOverAGatedField() {
    let next = workComposerFoldTransition(
      WorkComposerFoldState(collapsed: true, focused: false),
      intent: .expand,
      canCompose: false
    )
    XCTAssertEqual(next, WorkComposerFoldState(collapsed: false, focused: false))
  }

  func testTypingEscapesTheFoldedState() {
    let next = workComposerFoldTransition(
      WorkComposerFoldState(collapsed: true, focused: false),
      intent: .focusChanged(true),
      canCompose: true
    )
    XCTAssertEqual(next, WorkComposerFoldState(collapsed: false, focused: true))
  }

  func testLosingFocusAloneDoesNotFoldTheCard() {
    // Sending, or a picker taking over, drops focus. That is a keyboard event,
    // not a fold — the card keeps the height the user left it at.
    let next = workComposerFoldTransition(
      WorkComposerFoldState(collapsed: false, focused: true),
      intent: .focusChanged(false),
      canCompose: true
    )
    XCTAssertEqual(next, WorkComposerFoldState(collapsed: false, focused: false))
  }

  func testFoldSurvivesAFocusDropWhileFolded() {
    let next = workComposerFoldTransition(
      WorkComposerFoldState(collapsed: true, focused: false),
      intent: .focusChanged(false),
      canCompose: true
    )
    XCTAssertEqual(next, WorkComposerFoldState(collapsed: true, focused: false))
  }
}
