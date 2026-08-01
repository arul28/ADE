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

    func testNonNotchMacUsesStatusItemAtRest() {
        for enabled in [false, true] {
            XCTAssertEqual(
                notchPanelShouldShow(
                    surfaceEnabled: enabled,
                    hasPhysicalNotch: false,
                    presentation: .compact
                ),
                false
            )
        }
        for presentation in [
            NotchPresentationState.prehover, .peek, .expanded, .attention, .celebration,
        ] {
            XCTAssertTrue(
                notchPanelShouldShow(
                    surfaceEnabled: true,
                    hasPhysicalNotch: false,
                    presentation: presentation
                )
            )
        }
    }

    func testPhysicalNotchPresentationIsUnchanged() {
        for presentation in [
            NotchPresentationState.compact, .prehover, .peek, .expanded, .attention, .celebration,
        ] {
            XCTAssertTrue(
                notchPanelShouldShow(
                    surfaceEnabled: true,
                    hasPhysicalNotch: true,
                    presentation: presentation
                )
            )
            XCTAssertFalse(
                notchPanelShouldShow(
                    surfaceEnabled: false,
                    hasPhysicalNotch: true,
                    presentation: presentation
                )
            )
        }
    }

    func testMenuBarPanelAnchorsBelowStatusItemAndAvoidsDisplayEdges() {
        let display = NotchRect(x: 0, y: 0, width: 1_440, height: 900)
        let status = NotchRect(x: 1_390, y: 875, width: 24, height: 24)
        let surface = NotchSize(width: 396, height: 232)
        let frame = menuBarAnchoredPanelFrame(
            statusItemFrame: status,
            displayFrame: display,
            surfaceSize: surface
        )

        XCTAssertEqual(frame.maxY, status.y - 4)
        let surfaceMinX = frame.midX - surface.width / 2
        let surfaceMaxX = frame.midX + surface.width / 2
        XCTAssertGreaterThanOrEqual(surfaceMinX, display.x + 8)
        XCTAssertLessThanOrEqual(surfaceMaxX, display.maxX - 8)
        XCTAssertGreaterThan(frame.midX, display.midX)
    }

    func testMenuBarPanelTracksStatusItemUntilSurfaceWouldClip() {
        let display = NotchRect(x: 1_440, y: 0, width: 1_920, height: 1_080)
        let status = NotchRect(x: 2_400, y: 1_050, width: 24, height: 24)
        let surface = NotchSize(width: 316, height: 76)
        let frame = menuBarAnchoredPanelFrame(
            statusItemFrame: status,
            displayFrame: display,
            surfaceSize: surface
        )

        XCTAssertEqual(frame.midX, status.midX)
        XCTAssertEqual(frame.maxY, status.y - 4)
    }

    /// The panel grew to 760×640 for the scrolling Activity list. The surface
    /// is top-aligned inside it, so what has to fit above the display's bottom
    /// edge is the 440pt surface, not the 640pt transparent host — verified
    /// here on the smallest Mac ADE supports, a 1440×900 13".
    func testExpandedSurfaceFitsUnderA13InchMenuBar() {
        XCTAssertEqual(NotchDisplayGeometry.panelSize, NotchSize(width: 760, height: 640))

        let display = NotchRect(x: 0, y: 0, width: 1_440, height: 900)
        let status = NotchRect(x: 1_390, y: 875, width: 24, height: 24)
        let surface = notchSurfaceSize(presentation: .expanded, physicalNotchWidth: nil)
        XCTAssertEqual(surface, NotchSize(width: 420, height: 440))

        let frame = menuBarAnchoredPanelFrame(
            statusItemFrame: status,
            displayFrame: display,
            surfaceSize: surface
        )
        // Top of the surface sits just under the menu bar…
        XCTAssertEqual(frame.maxY, status.y - 4)
        // …and its bottom edge stays comfortably on screen.
        XCTAssertGreaterThan(frame.maxY - surface.height, display.y)
        XCTAssertGreaterThanOrEqual(frame.midX - surface.width / 2, display.x + 8)
        XCTAssertLessThanOrEqual(frame.midX + surface.width / 2, display.maxX - 8)

        // Same on a notched 13" built-in, where the panel hangs from the very
        // top of the display rather than from a status item.
        let notched = NotchDisplayGeometry(
            displayId: 1,
            frame: display,
            visibleFrame: NotchRect(x: 0, y: 0, width: 1_440, height: 875),
            safeAreaTop: 34,
            auxiliaryLeft: NotchRect(x: 0, y: 866, width: 630, height: 34),
            auxiliaryRight: NotchRect(x: 810, y: 866, width: 630, height: 34),
            isBuiltIn: true
        )
        XCTAssertTrue(notched.hasPhysicalNotch)
        let notchedSurface = notchSurfaceSize(
            presentation: .expanded,
            physicalNotchWidth: notched.physicalNotchWidth,
            safeAreaTop: 34
        )
        XCTAssertEqual(notchedSurface.height, 474)
        XCTAssertGreaterThan(notched.frame.maxY - notchedSurface.height, display.y)
        XCTAssertLessThanOrEqual(notchedSurface.width, NotchDisplayGeometry.panelSize.width)
        XCTAssertLessThanOrEqual(notchedSurface.height, NotchDisplayGeometry.panelSize.height)
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
