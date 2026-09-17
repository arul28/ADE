/// Screen Recording and Accessibility, probed without asking.
///
/// The driver never prompts. `getStatus` runs on every status read and on the
/// agent action allowlist; if the probe prompted, opening a tab would throw a
/// system dialog at whoever happened to be at the Mac — on a *remote* runtime
/// host, at somebody who is not even the person using ADE. Asking for the grant
/// is the app's job, through System Settings; this helper only reports, from
/// the `ping` reply and from the periodic `permission-changed` probe.

import ApplicationServices
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

enum Permissions {
    /// `MacDesktopPermissionState`.
    static func screenRecordingState() -> String {
        CGPreflightScreenCaptureAccess() ? "granted" : "denied"
    }

    static func accessibilityState() -> String {
        // No prompt: the options dictionary is deliberately empty.
        AXIsProcessTrustedWithOptions(nil) ? "granted" : "denied"
    }

    /// `MacDesktopPermissions`.
    static func snapshot() -> [String: JSONValue] {
        [
            "screenRecording": .string(screenRecordingState()),
            "accessibility": .string(accessibilityState()),
        ]
    }
}
