import XCTest
@testable import ADEAttentionNotchCore

final class NotchInteractionStateTests: XCTestCase {
    func testStaleHoverGenerationCannotOpenPeekAfterPointerExit() {
        var state = NotchInteractionState()
        let hoverGeneration = state.pointerEntered(hasItems: true)
        XCTAssertEqual(state.presentation, .prehover)

        state.pointerExited()
        state.applyPeek(generation: hoverGeneration, pointerInside: true)

        XCTAssertEqual(state.presentation, .compact)
    }

    func testExplicitExpansionOnlyHappensWithItems() {
        var state = NotchInteractionState()
        state.explicitToggle(hasItems: false)
        XCTAssertEqual(state.presentation, .compact)
        XCTAssertFalse(state.isExplicitlyInteractive)

        state.explicitToggle(hasItems: true)
        XCTAssertEqual(state.presentation, .expanded)
        XCTAssertTrue(state.isExplicitlyInteractive)
    }

    func testHidingStopsTransientPresentation() {
        var state = NotchInteractionState()
        state.setCelebration()
        XCTAssertEqual(state.presentation, .celebration)

        state.setVisible(false)

        XCTAssertEqual(state.presentation, .compact)
        XCTAssertFalse(state.isVisible)
    }

    func testNavigationWrapsInBothDirections() {
        var state = NotchInteractionState()
        state.navigate(delta: -1, itemCount: 3)
        XCTAssertEqual(state.selectedIndex, 2)
        state.navigate(delta: 1, itemCount: 3)
        XCTAssertEqual(state.selectedIndex, 0)
        state.select(index: 9, itemCount: 3)
        XCTAssertEqual(state.selectedIndex, 2)
    }

    func testPhysicalSurfaceReservesHardwareAndSideEars() {
        let compact = notchSurfaceSize(
            presentation: .compact,
            physicalNotchWidth: 182,
            safeAreaTop: 34
        )
        let peek = notchSurfaceSize(
            presentation: .peek,
            physicalNotchWidth: 182,
            safeAreaTop: 34
        )
        XCTAssertEqual(compact.width, 390)
        XCTAssertEqual(compact.height, 38)
        XCTAssertGreaterThan(peek.width, compact.width)
        XCTAssertEqual(peek.height, 116)
        XCTAssertEqual(notchSurfaceSize(presentation: .compact, physicalNotchWidth: nil).width, 260)
    }
}
