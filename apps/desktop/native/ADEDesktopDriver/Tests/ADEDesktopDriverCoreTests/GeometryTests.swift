import XCTest
@testable import ADEDesktopDriverCore

final class GeometryTests: XCTestCase {
    private let display = DisplayPlacement(
        origin: CGPoint(x: 8000, y: 0),
        width: 2560,
        height: 1440,
        scale: 2
    )

    func testGlobalAndLocalPointsRoundTrip() {
        let global = Geometry.toGlobal(point: CGPoint(x: 100, y: 50), display: display)
        XCTAssertEqual(global, CGPoint(x: 8100, y: 50))
        XCTAssertEqual(Geometry.toLocal(point: global, display: display), CGPoint(x: 100, y: 50))
    }

    func testGlobalFrameKeepsItsSize() {
        let frame = CGRect(x: 10, y: 20, width: 300, height: 200)
        let global = Geometry.toGlobal(frame: frame, display: display)
        XCTAssertEqual(global, CGRect(x: 8010, y: 20, width: 300, height: 200))
        XCTAssertEqual(Geometry.toLocal(frame: global, display: display), frame)
    }

    func testPixelConversionUsesTheBackingScale() {
        XCTAssertEqual(
            Geometry.toPixel(point: CGPoint(x: 8100, y: 50), display: display),
            CGPoint(x: 200, y: 100)
        )
        XCTAssertEqual(display.pixelWidth, 5120)
        XCTAssertEqual(display.pixelHeight, 2880)
    }

    func testEscapeAndFullyOutsideAreDifferentQuestions() {
        let halfOff = CGRect(x: 7900, y: 100, width: 400, height: 300)
        XCTAssertTrue(Geometry.isEscaping(halfOff, of: display.frame))
        XCTAssertFalse(Geometry.isFullyOutside(halfOff, of: display.frame))

        let gone = CGRect(x: 100, y: 100, width: 400, height: 300)
        XCTAssertTrue(Geometry.isFullyOutside(gone, of: display.frame))
    }

    func testOffscreenOriginClearsTheMainDisplayByTheGap() {
        let main = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let origin = Geometry.offscreenOrigin(mainVisibleFrame: main)
        XCTAssertEqual(origin, CGPoint(x: 1920 + Geometry.offscreenGap, y: 0))
        // The gap is not decorative: a window flush against maxX still shows a
        // shadow and a draggable resize edge.
        XCTAssertGreaterThan(Geometry.offscreenGap, 0)
        XCTAssertTrue(
            Geometry.isFullyOutside(
                CGRect(origin: origin, size: CGSize(width: 800, height: 600)),
                of: main
            )
        )
    }

    func testOffscreenPlacementCarriesTheRequestedSize() {
        let placement = Geometry.offscreenPlacement(
            mainVisibleFrame: CGRect(x: 0, y: 0, width: 1512, height: 982),
            width: 2560,
            height: 1440,
            scale: 2
        )
        XCTAssertEqual(placement.width, 2560)
        XCTAssertEqual(placement.scale, 2)
        XCTAssertEqual(placement.origin.x, 1512 + Geometry.offscreenGap)
    }

    func testCascadeStepsWindowsAndStopsAtTheDisplayEdge() {
        let size = CGSize(width: 800, height: 600)
        XCTAssertEqual(
            Geometry.cascadeFrame(index: 0, size: size, display: display),
            CGRect(x: 8000, y: 0, width: 800, height: 600)
        )
        XCTAssertEqual(
            Geometry.cascadeFrame(index: 2, size: size, display: display),
            CGRect(x: 8064, y: 64, width: 800, height: 600)
        )
        // A window as large as the display cannot cascade off it.
        let full = CGSize(width: 2560, height: 1440)
        XCTAssertEqual(
            Geometry.cascadeFrame(index: 9, size: full, display: display),
            CGRect(x: 8000, y: 0, width: 2560, height: 1440)
        )
    }

    func testCascadeToleratesANegativeIndex() {
        XCTAssertEqual(
            Geometry.cascadeFrame(index: -3, size: CGSize(width: 100, height: 100), display: display).origin,
            CGPoint(x: 8000, y: 0)
        )
    }
}
