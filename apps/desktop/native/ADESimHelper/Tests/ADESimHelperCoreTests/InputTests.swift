import XCTest
@testable import ADESimHelperCore

final class DeviceMetricsTests: XCTestCase {
    /// iPhone 17 Pro: 402x874 points at 3x.
    private let iPhone = DeviceMetrics(pointWidth: 402, pointHeight: 874, scale: 3)

    func testReportsPixelsFromPointsAndScale() {
        XCTAssertEqual(iPhone.pixelWidth, 1206)
        XCTAssertEqual(iPhone.pixelHeight, 2622)
    }

    /// The vendored HID layer wants 0..1 fractions, NOT pixels — it ignores the
    /// screenWidth/screenHeight arguments it takes, which is the easy way to get
    /// this wrong.
    func testNormalisesDevicePointsToFractions() {
        let centre = iPhone.normalize(DevicePoint(x: 201, y: 437))
        XCTAssertEqual(centre.x, 0.5, accuracy: 0.0001)
        XCTAssertEqual(centre.y, 0.5, accuracy: 0.0001)
    }

    /// A drag that runs off the edge is a real gesture; an out-of-range
    /// fraction makes the simulator drop the whole touch.
    func testClampsRatherThanDroppingOffScreenPoints() {
        let over = iPhone.normalize(DevicePoint(x: 5_000, y: -20))
        XCTAssertEqual(over.x, 1)
        XCTAssertEqual(over.y, 0)
    }

    func testDerivesMetricsFromAFramebufferWhenCoreSimulatorWillNotSay() {
        let derived = DeviceMetrics.fromPixels(width: 1206, height: 2622, assumedScale: 3)
        XCTAssertEqual(derived.pointWidth, 402, accuracy: 0.0001)
        XCTAssertEqual(derived.pointHeight, 874, accuracy: 0.0001)
        XCTAssertEqual(derived.pixelWidth, 1206)
    }

    func testAZeroScaleDoesNotProduceInfinitePoints() {
        let derived = DeviceMetrics.fromPixels(width: 100, height: 200, assumedScale: 0)
        XCTAssertEqual(derived.scale, 1)
        XCTAssertEqual(derived.pointWidth, 100)
    }
}

final class KeyboardUsageTests: XCTestCase {
    func testMapsLettersToContiguousUsages() {
        XCTAssertEqual(KeyboardUsage.stroke(for: "a"), .init(usage: 0x04, shifted: false))
        XCTAssertEqual(KeyboardUsage.stroke(for: "z"), .init(usage: 0x1D, shifted: false))
    }

    /// Zero is 0x27, AFTER nine — not before one. Laying the digits out
    /// contiguously from "0" is the classic HID table bug.
    func testDigitsHandleZeroCorrectly() {
        XCTAssertEqual(KeyboardUsage.stroke(for: "1"), .init(usage: 0x1E, shifted: false))
        XCTAssertEqual(KeyboardUsage.stroke(for: "9"), .init(usage: 0x26, shifted: false))
        XCTAssertEqual(KeyboardUsage.stroke(for: "0"), .init(usage: 0x27, shifted: false))
    }

    func testShiftedCharactersReuseTheirBaseKey() {
        XCTAssertEqual(KeyboardUsage.stroke(for: "A"), .init(usage: 0x04, shifted: true))
        XCTAssertEqual(KeyboardUsage.stroke(for: "!"), .init(usage: 0x1E, shifted: true))
        XCTAssertEqual(KeyboardUsage.stroke(for: ")"), .init(usage: 0x27, shifted: true))
        XCTAssertEqual(KeyboardUsage.stroke(for: "?"), .init(usage: 0x38, shifted: true))
    }

    func testWhitespaceAndReturn() {
        XCTAssertEqual(KeyboardUsage.stroke(for: " ")?.usage, 0x2C)
        XCTAssertEqual(KeyboardUsage.stroke(for: "\n")?.usage, KeyboardUsage.returnKey)
        XCTAssertEqual(KeyboardUsage.stroke(for: "\t")?.usage, 0x2B)
    }

    /// Reported, not silently dropped: a field typed with the emoji missing
    /// looks almost right, which is the worst possible failure.
    func testReportsCharactersWithNoHidUsage() {
        let (strokes, unsupported) = KeyboardUsage.usages(for: "ok👍é")
        XCTAssertEqual(strokes.count, 2)
        XCTAssertEqual(unsupported, ["👍", "é"])
    }

    func testMapsAWholeAsciiString() {
        let (strokes, unsupported) = KeyboardUsage.usages(for: "Hi There 42!")
        XCTAssertTrue(unsupported.isEmpty)
        XCTAssertEqual(strokes.count, 12)
        XCTAssertTrue(strokes[0].shifted)   // H
        XCTAssertFalse(strokes[1].shifted)  // i
    }
}

final class SimButtonTests: XCTestCase {
    func testNamedButtonsGoThroughTheVendoredEventSources() {
        XCTAssertEqual(SimButton.resolve("home"), .named("home"))
        XCTAssertEqual(SimButton.resolve("lock"), .named("lock"))
        XCTAssertEqual(SimButton.resolve("siri"), .named("siri"))
    }

    /// Volume has no Indigo event source, so it has to travel as a raw HID
    /// Consumer-page usage instead.
    func testVolumeTravelsAsConsumerPageHid() {
        XCTAssertEqual(SimButton.resolve("volume-up"), .hid(page: 0x0C, usage: 0xE9))
        XCTAssertEqual(SimButton.resolve("volume-down"), .hid(page: 0x0C, usage: 0xEA))
        XCTAssertEqual(SimButton.resolve("volume_up"), .hid(page: 0x0C, usage: 0xE9))
    }

    func testUnknownButtonsAreRefusedNotGuessed() {
        XCTAssertNil(SimButton.resolve("eject"))
        XCTAssertNil(SimButton.resolve(""))
    }
}

final class FrameStreamServerTests: XCTestCase {
    func testTokensAreLongAndUnique() {
        let first = FrameStreamServer.randomToken()
        let second = FrameStreamServer.randomToken()
        XCTAssertEqual(first.count, 64)
        XCTAssertNotEqual(first, second)
    }

    func testConstantTimeComparison() {
        XCTAssertTrue(FrameStreamServer.constantTimeEquals("abc", "abc"))
        XCTAssertFalse(FrameStreamServer.constantTimeEquals("abc", "abd"))
        // Length must not short-circuit into a match.
        XCTAssertFalse(FrameStreamServer.constantTimeEquals("abc", "abcd"))
        XCTAssertFalse(FrameStreamServer.constantTimeEquals("", "a"))
        XCTAssertTrue(FrameStreamServer.constantTimeEquals("", ""))
    }

    func testBindsToLoopbackOnAnEphemeralPort() throws {
        let server = try FrameStreamServer()
        let port = try server.start()
        defer { server.stop() }
        XCTAssertGreaterThan(port, 0)
        XCTAssertTrue(server.url.hasPrefix("http://127.0.0.1:"), server.url)
        XCTAssertTrue(server.url.hasSuffix("/ios-simulator-video"), server.url)
        XCTAssertEqual(server.readerCount, 0)
    }
}
