import XCTest
@testable import ADEDesktopDriver
@testable import ADEDesktopDriverCore

/// The permission watch and the one prompt the driver is ever allowed to fire.
///
/// Both are the fix for a first-run screen that could not recover: the helper
/// only probed while a display existed, so a grant made in System Settings
/// never reached an already-running process with no display. These tests stay
/// off the real CG prompt — the `allowPrompt: false` arm is the one under test,
/// and firing a system modal from CI is not a thing a test may do.
final class PermissionRequestTests: XCTestCase {
    func testWatchPermissionsStartsTheProbeWithoutADisplay() {
        let runtime = DriverRuntime()
        XCTAssertTrue(runtime.displays.all().isEmpty, "the fixture starts with no display")
        XCTAssertFalse(runtime.isPermissionProbeActive)

        // A pane is open and no display exists yet: the exact stuck state.
        // Watching has to start the probe on its own.
        runtime.setPermissionWatch(true)
        XCTAssertTrue(runtime.isPermissionProbeActive)

        // Nobody watching and no display: the idle helper goes back to idle.
        runtime.setPermissionWatch(false)
        XCTAssertFalse(runtime.isPermissionProbeActive)
    }

    func testRequestPermissionIsIgnoredUnlessAllowed() {
        let refused = Permissions.request(which: "screenRecording", allowPrompt: false)
        XCTAssertEqual(refused["requested"], .bool(false))
        XCTAssertNotNil(refused["permissions"])

        // An unknown permission is refused the same way, even when prompting
        // would have been allowed: there is nothing to prompt for.
        let unknown = Permissions.request(which: "notAPermission", allowPrompt: true)
        XCTAssertEqual(unknown["requested"], .bool(false))
        XCTAssertNotNil(unknown["permissions"])
    }
}
