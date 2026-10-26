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

    /// The rule takeover turns on: a real event cannot land on the user's own
    /// screen, whatever the viewer sends.
    func testClampKeepsAPointOnItsOwnDisplay() {
        let frame = display.frame
        // Inside is untouched.
        XCTAssertEqual(Geometry.clamp(point: CGPoint(x: 8100, y: 50), to: frame), CGPoint(x: 8100, y: 50))
        // Left of the display is the MAIN display on the usual layout — which
        // is the user's desk, and the one place a lane may never post.
        XCTAssertEqual(Geometry.clamp(point: CGPoint(x: -400, y: 700), to: frame), CGPoint(x: 8000, y: 700))
        XCTAssertEqual(Geometry.clamp(point: CGPoint(x: 99_999, y: 99_999), to: frame), CGPoint(x: 10_559, y: 1_439))
        // The far edges are inset by a point: `maxX` is the first coordinate of
        // whatever sits to the right, not the last one of this display.
        XCTAssertEqual(Geometry.clamp(point: CGPoint(x: frame.maxX, y: frame.maxY), to: frame), CGPoint(x: 10_559, y: 1_439))
        // Its own origin survives a degenerate frame rather than producing NaN.
        XCTAssertEqual(
            Geometry.clamp(point: CGPoint(x: 5, y: 5), to: CGRect(x: 1, y: 2, width: 0, height: 0)),
            CGPoint(x: 1, y: 2)
        )
    }

    func testCornerChainTouchesTheLowestLeftSafeCornerAndKeepsOnlyPointContacts() {
        let real = [CGRect(x: 0, y: 0, width: 5120, height: 1440)]
        let templates = [
            DisplayPlacement(origin: .zero, width: 2560, height: 1440, scale: 1),
            DisplayPlacement(origin: .zero, width: 1280, height: 800, scale: 2),
        ]

        let planned = Geometry.cornerChainPlacements(
            realDisplayFrames: real,
            laneDisplayTemplates: templates
        )

        XCTAssertEqual(planned?.map(\.origin), [
            CGPoint(x: -2560, y: 1440),
            CGPoint(x: -3840, y: 2880),
        ])
        XCTAssertEqual(planned?.map(\.scale), [1, 2])
        for placement in planned ?? [] {
            for display in real {
                let overlapWidth = min(placement.frame.maxX, display.maxX) - max(placement.frame.minX, display.minX)
                let overlapHeight = min(placement.frame.maxY, display.maxY) - max(placement.frame.minY, display.minY)
                XCTAssertFalse(
                    overlapWidth >= 0 && overlapHeight >= 0 && (overlapWidth > 0 || overlapHeight > 0),
                    "A lane display may touch a real display at a point, but may not overlap or share an edge."
                )
            }
        }
    }

    func testCornerChainSkipsAnUnsafeCornerOnAnAsymmetricMonitorLayout() {
        let real = [
            CGRect(x: 0, y: 0, width: 1920, height: 1080),
            // This display blocks the primary's bottom-left corner with an edge.
            CGRect(x: -1280, y: 1080, width: 1280, height: 1024),
        ]
        let template = DisplayPlacement(origin: .zero, width: 1600, height: 900, scale: 1)

        let planned = Geometry.cornerChainPlacements(
            realDisplayFrames: real,
            laneDisplayTemplates: [template]
        )

        XCTAssertEqual(planned?.first?.origin, CGPoint(x: -2880, y: 2104))
    }

    func testCornerChainAvoidsAnExistingLaneDisplayAtThePreferredCorner() {
        let real = [CGRect(x: 0, y: 0, width: 5120, height: 1440)]
        let otherLane = [CGRect(x: -2560, y: 0, width: 2560, height: 1440)]
        let template = DisplayPlacement(origin: .zero, width: 2560, height: 1440, scale: 1)

        let planned = Geometry.cornerChainPlacements(
            realDisplayFrames: real,
            laneDisplayTemplates: [template],
            obstacleDisplayFrames: otherLane
        )

        XCTAssertEqual(planned?.first?.origin, CGPoint(x: 5120, y: 1440))
    }

    /// The AirPlay trap, measured on macOS 27 with a second display added while
    /// a lane display was up: macOS left the new screen sharing an edge only
    /// with the lane display, so the fenced pointer could never reach it. After
    /// the repair every real screen shares an edge with the main one, never
    /// lands on another helper's lane display, and the lane chain planned
    /// against the repaired layout touches real screens at corners only.
    func testCutOffRealDisplaysAreMovedBesideTheMainDisplaysGroup() {
        let main = CGRect(x: 0, y: 0, width: 5120, height: 1440)
        let cases: [(name: String, real: [CGRect], obstacles: [CGRect], cutOff: [Int], expected: [CGRect])] = [
            (
                "nothing cut off stays put",
                [main, CGRect(x: -2560, y: 0, width: 2560, height: 1440)],
                [],
                [],
                [main, CGRect(x: -2560, y: 0, width: 2560, height: 1440)]
            ),
            (
                "a TV beside a lane display slides flush to the main display, half an edge overlapping",
                [main, CGRect(x: 7680, y: 1440, width: 2560, height: 1440)],
                [],
                [1],
                [main, CGRect(x: 5120, y: 720, width: 2560, height: 1440)]
            ),
            (
                "another helper's lane display on that side sends it to the next side",
                [main, CGRect(x: 7680, y: 1440, width: 2560, height: 1440)],
                [CGRect(x: 5120, y: 0, width: 2560, height: 1440)],
                [1],
                [main, CGRect(x: -2560, y: 720, width: 2560, height: 1440)]
            ),
            (
                "a corner-only contact is still cut off",
                [main, CGRect(x: 5120, y: 1440, width: 1920, height: 1080)],
                [],
                [1],
                [main, CGRect(x: 5120, y: 900, width: 1920, height: 1080)]
            ),
            (
                "a cut-off pair keeps its own arrangement and moves as one",
                [
                    main,
                    CGRect(x: -4000, y: 3000, width: 1920, height: 1080),
                    CGRect(x: -2080, y: 3000, width: 1920, height: 1080),
                ],
                [],
                [1, 2],
                [
                    main,
                    CGRect(x: -3840, y: 900, width: 1920, height: 1080),
                    CGRect(x: -1920, y: 900, width: 1920, height: 1080),
                ]
            ),
        ]

        for testCase in cases {
            XCTAssertEqual(
                Geometry.cutOffRealDisplays(realDisplayFrames: testCase.real, mainIndex: 0),
                testCase.cutOff,
                testCase.name
            )
            guard let repaired = Geometry.reconnectedRealDisplayFrames(
                realDisplayFrames: testCase.real,
                mainIndex: 0,
                obstacleDisplayFrames: testCase.obstacles
            ) else {
                XCTFail("\(testCase.name): no repair")
                continue
            }
            XCTAssertEqual(repaired, testCase.expected, testCase.name)
            XCTAssertEqual(Geometry.cutOffRealDisplays(realDisplayFrames: repaired, mainIndex: 0), [], testCase.name)
            let lane = DisplayPlacement(origin: .zero, width: 2560, height: 1440, scale: 1)
            guard let planned = Geometry.cornerChainPlacements(
                realDisplayFrames: repaired,
                laneDisplayTemplates: [lane],
                obstacleDisplayFrames: testCase.obstacles,
                requiresIntegralOrigins: true
            ) else {
                XCTFail("\(testCase.name): no lane placement")
                continue
            }
            for display in repaired {
                XCTAssertFalse(
                    Geometry.pointerCanCross(planned[0].frame, display),
                    "\(testCase.name): a lane display must not share an edge with a real one"
                )
            }
        }
    }

    /// The fence's fallback while a screen is still cut off: every lane display
    /// between the person and that screen is crossable, through a chain of
    /// lane displays that share edges; a lane display elsewhere stays fenced.
    func testLaneDisplaysOnTheRouteToACutOffScreenAreCrossable() {
        let main = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let tv = CGRect(x: 6400, y: 0, width: 1920, height: 1080)
        let lanes = [
            CGRect(x: 1920, y: 0, width: 2560, height: 1440),
            CGRect(x: 4480, y: 0, width: 1920, height: 1080),
            CGRect(x: -2560, y: 1080, width: 2560, height: 1440),
        ]
        XCTAssertEqual(
            Geometry.laneDisplaysOnRouteToCutOffRealDisplays(
                realDisplayFrames: [main, tv],
                mainIndex: 0,
                laneDisplayFrames: lanes
            ),
            [0, 1]
        )
        XCTAssertEqual(
            Geometry.laneDisplaysOnRouteToCutOffRealDisplays(
                realDisplayFrames: [main, CGRect(x: 1920, y: 0, width: 1920, height: 1080)],
                mainIndex: 0,
                laneDisplayFrames: lanes
            ),
            [],
            "nothing is crossable while every screen is reachable"
        )
    }

    /// Cocoa origin is the primary's bottom-left; Quartz / CGEvent origin is
    /// the primary's top-left. A pointer 100pt up from the bottom of a
    /// 1080-tall primary is y=980 in Quartz.
    func testQuartzPointFlipsCocoaYAgainstThePrimaryHeight() {
        XCTAssertEqual(
            Geometry.quartzPoint(fromCocoa: CGPoint(x: 12, y: 100), primaryHeight: 1080),
            CGPoint(x: 12, y: 980)
        )
        XCTAssertEqual(
            Geometry.quartzPoint(fromCocoa: CGPoint(x: 0, y: 0), primaryHeight: 1440),
            CGPoint(x: 0, y: 1440)
        )
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
