/// Screen Recording and Accessibility, probed without asking.
///
/// Probing and prompting are separate ops on purpose. `getStatus` runs on every
/// status read and on the agent action allowlist; if the probe prompted, opening
/// a tab would throw a system dialog at whoever happened to be at the Mac — on
/// a *remote* runtime host, at somebody who is not even the person using ADE.
/// `permissions.request` is the one that prompts, and something has to ask for
/// it by name.

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

    /// The prompting path. `which` is `screenRecording`, `accessibility`, or
    /// `all`.
    static func request(which: String) -> [String: JSONValue] {
        if which == "screenRecording" || which == "all" {
            _ = CGRequestScreenCaptureAccess()
        }
        if which == "accessibility" || which == "all" {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        return snapshot()
    }
}
