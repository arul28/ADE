import XCTest
import CoreGraphics
@testable import ADEDesktopDriverCore
@testable import ADEDesktopDriver

/// The one test that touches the window server.
///
/// Guarded by `ADE_DESKTOP_DRIVER_LIVE_TESTS=1` because it creates a real
/// virtual display on whatever machine runs it. CI and a routine `swift test`
/// skip it; a human verifying the private API on a new macOS build opts in.
final class VirtualDisplayLiveTests: XCTestCase {
    private var isEnabled: Bool {
        ProcessInfo.processInfo.environment["ADE_DESKTOP_DRIVER_LIVE_TESTS"] == "1"
    }

    func testCreatesListsAndDestroysAVirtualDisplay() throws {
        try XCTSkipUnless(isEnabled, "Set ADE_DESKTOP_DRIVER_LIVE_TESTS=1 to create a real virtual display.")

        let host = VirtualDisplayHost(log: { FileHandle.standardError.write(Data(($0 + "\n").utf8)) })
        try XCTSkipUnless(
            host.isVirtualDisplayAvailable,
            "The private virtual-display classes are unavailable: \(host.unavailableReason ?? "no reason")"
        )

        let laneId = "live-test-\(UUID().uuidString.prefix(8))"
        // The handle is scoped inside an autorelease pool, and both halves of
        // that matter. `VirtualDisplayHandle` holds the `CGVirtualDisplay`
        // object, and that object *is* the display: the last release is the
        // teardown. The object also carries an autoreleased reference from the
        // runtime-dispatched `initWithDescriptor:`, so it does not actually die
        // until the enclosing pool drains. In the driver that pool is a run-loop
        // iteration and drains milliseconds after `display.create` answers; in a
        // test method there is no such iteration, so without this pool the
        // display would outlive `destroy` for the length of the test and the
        // assertion below would fail for a reason that never happens in
        // production.
        let displayId: CGDirectDisplayID = autoreleasepool { () -> CGDirectDisplayID in
            let handle = host.create(
                laneId: laneId,
                name: "\(VirtualDisplayIdentity.namePrefix)live test",
                width: 1280,
                height: 800,
                scale: 2
            )
            XCTAssertEqual(handle.mode, "virtual")
            XCTAssertNotEqual(handle.displayId, 0)
            XCTAssertTrue(handle.name.hasPrefix(VirtualDisplayIdentity.namePrefix))
            // The working area is the one that was asked for, whatever the
            // backing scale turned out to be.
            XCTAssertEqual(handle.placement.width, 1280)
            XCTAssertEqual(handle.placement.height, 800)
            return handle.displayId
        }
        // Whatever happens below, the display must not outlive this test.
        defer { host.destroy(laneId: laneId) }

        XCTAssertTrue(host.all().contains { $0.laneId == laneId })

        var displays = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        XCTAssertEqual(CGGetActiveDisplayList(16, &displays, &count), .success)
        XCTAssertTrue(
            displays.prefix(Int(count)).contains(displayId),
            "The window server never published the virtual display"
        )
        XCTAssertGreaterThan(CGDisplayBounds(displayId).width, 0)

        XCTAssertTrue(host.destroy(laneId: laneId))
        XCTAssertFalse(host.all().contains { $0.laneId == laneId })

        // The window server takes a moment to retire it.
        let deadline = Date().addingTimeInterval(5)
        var stillListed = true
        while Date() < deadline, stillListed {
            var after = [CGDirectDisplayID](repeating: 0, count: 16)
            var afterCount: UInt32 = 0
            _ = CGGetActiveDisplayList(16, &after, &afterCount)
            stillListed = after.prefix(Int(afterCount)).contains(displayId)
            if stillListed { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        }
        XCTAssertFalse(stillListed, "The virtual display outlived its handle")
    }

    func testCreateIsIdempotentPerLane() throws {
        try XCTSkipUnless(isEnabled, "Set ADE_DESKTOP_DRIVER_LIVE_TESTS=1 to create a real virtual display.")
        let host = VirtualDisplayHost(log: { _ in })
        let laneId = "live-test-\(UUID().uuidString.prefix(8))"
        defer { host.destroy(laneId: laneId) }
        let first = host.create(laneId: laneId, name: "ADE · idempotent", width: 1280, height: 800, scale: 1)
        let second = host.create(laneId: laneId, name: "ADE · idempotent", width: 1920, height: 1080, scale: 2)
        XCTAssertEqual(first.displayId, second.displayId)
        XCTAssertEqual(host.all().filter { $0.laneId == laneId }.count, 1)
    }

    /// Runs everywhere: the fallback must be honest even on a Mac where the
    /// private API works.
    func testFallbackReportsOffscreenRegionRatherThanPretending() {
        let placement = Geometry.offscreenPlacement(
            mainVisibleFrame: CGDisplayBounds(CGMainDisplayID()),
            width: 1280,
            height: 800,
            scale: 2
        )
        XCTAssertTrue(
            Geometry.isFullyOutside(
                CGRect(origin: placement.origin, size: CGSize(width: 400, height: 300)),
                of: CGDisplayBounds(CGMainDisplayID())
            )
        )
    }
}
