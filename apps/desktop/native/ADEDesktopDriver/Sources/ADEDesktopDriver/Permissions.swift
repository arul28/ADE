/// Screen Recording and Accessibility, probed without asking.
///
/// The driver never prompts on its own. `getStatus` runs on every status read
/// and on the agent action allowlist; if the probe prompted, opening a tab
/// would throw a system dialog at whoever happened to be at the Mac — on a
/// *remote* runtime host, at somebody who is not even the person using ADE.
/// The one exception is `request-permission`: the service asks for it only
/// after a local user clicked a button, and it never fires from a background
/// read. Asking for the grant is otherwise the app's job, through System
/// Settings; this helper only reports, from the `ping` reply and from the
/// periodic `permission-changed` probe.

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

    /// Asks macOS to show the grant prompt for one permission, if allowed.
    ///
    /// `allowPrompt` is the whole gate and the caller owns it: the service
    /// passes true only for a local renderer's explicit click. When it is
    /// false this is a no-op that still returns the current snapshot, which is
    /// what makes the request safe to test without firing a real modal.
    static func request(which: String, allowPrompt: Bool) -> [String: JSONValue] {
        var requested = false
        switch which {
        case "screenRecording":
            if allowPrompt {
                requested = CGRequestScreenCaptureAccess()
            }
        case "accessibility":
            if allowPrompt {
                let options = [
                    kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
                ] as CFDictionary
                requested = AXIsProcessTrustedWithOptions(options)
            }
        default:
            break
        }
        return [
            "requested": .bool(requested),
            "permissions": .object(snapshot()),
        ]
    }
}
