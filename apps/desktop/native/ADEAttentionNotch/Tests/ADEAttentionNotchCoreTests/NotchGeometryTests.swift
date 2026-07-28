import XCTest
@testable import ADEAttentionNotchCore

final class NotchGeometryTests: XCTestCase {
    func testPhysicalNotchRequiresBuiltInSafeAreaAndAuxiliaryRegions() {
        let physical = geometry(
            safeAreaTop: 34,
            left: NotchRect(x: 0, y: 866, width: 650, height: 34),
            right: NotchRect(x: 830, y: 866, width: 650, height: 34),
            isBuiltIn: true
        )
        XCTAssertTrue(physical.hasPhysicalNotch)
        XCTAssertEqual(physical.physicalNotchWidth, 180)
        XCTAssertEqual(physical.panelFrame.maxY, physical.frame.maxY)

        let external = geometry(
            safeAreaTop: 34,
            left: NotchRect(x: 0, y: 866, width: 650, height: 34),
            right: NotchRect(x: 830, y: 866, width: 650, height: 34),
            isBuiltIn: false
        )
        XCTAssertFalse(external.hasPhysicalNotch)
    }

    func testFallbackPanelAnchorsBelowMenuBar() {
        let display = geometry(safeAreaTop: 0, left: nil, right: nil, isBuiltIn: false)
        XCTAssertLessThan(display.panelFrame.maxY, display.frame.maxY)
        XCTAssertLessThan(display.panelFrame.maxY, display.visibleFrame.maxY)
    }

    private func geometry(
        safeAreaTop: Double,
        left: NotchRect?,
        right: NotchRect?,
        isBuiltIn: Bool
    ) -> NotchDisplayGeometry {
        NotchDisplayGeometry(
            displayId: 1,
            frame: NotchRect(x: 0, y: 0, width: 1480, height: 900),
            visibleFrame: NotchRect(x: 0, y: 0, width: 1480, height: 875),
            safeAreaTop: safeAreaTop,
            auxiliaryLeft: left,
            auxiliaryRight: right,
            isBuiltIn: isBuiltIn
        )
    }
}
