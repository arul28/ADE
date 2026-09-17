/// `app.launch`: starting an app for a lane and parking whatever it opens.
///
/// The window an app opens usually does not exist yet when `NSWorkspace` hands
/// back its `NSRunningApplication`, which is why the launch watches the pid
/// rather than awaiting a window. Lifted out of `WindowControl.swift` unchanged.

import AppKit
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

extension WindowControl {
    struct LaunchResult {
        let pid: pid_t?
        let appName: String?
        let bundleId: String?
        let windows: [DesktopWindow]
        let watching: Bool
    }

    /// `ade desktop open <app|path|url>`.
    ///
    /// The window the app opens usually does not exist yet when this returns,
    /// which is why the pid is watched rather than the result being awaited.
    func launch(laneId: String, target: String, arguments: [String]) throws -> LaunchResult {
        guard placement(forLane: laneId) != nil else {
            throw DriverError(
                code: DriverErrorCode.noDisplay,
                message: "Lane \(laneId) has no display. Start one before opening an app on it."
            )
        }
        let workspace = NSWorkspace.shared
        guard let url = Self.resolveTarget(target, workspace: workspace) else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\"\(target)\" is not an app name, a bundle id, a path, or a URL on this Mac."
            )
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = arguments
        configuration.activates = false
        // A second copy keeps two lanes out of each other's process where the
        // app allows it. Single-instance apps ignore this and hand back the
        // running instance, which `OwnershipRegistry` then refuses for the
        // second lane by name.
        configuration.createsNewApplicationInstance = true

        var launched: NSRunningApplication?
        var failure: Error?
        let semaphore = DispatchSemaphore(value: 0)
        let completion: (NSRunningApplication?, Error?) -> Void = { application, error in
            launched = application
            failure = error
            semaphore.signal()
        }
        if url.isFileURL {
            workspace.openApplication(at: url, configuration: configuration, completionHandler: completion)
        } else {
            workspace.open(url, configuration: configuration, completionHandler: completion)
        }
        // The run loop has to keep turning: AppKit delivers the completion on
        // the main queue, and blocking it outright would deadlock the launch.
        let deadline = Date().addingTimeInterval(20)
        while semaphore.wait(timeout: .now()) == .timedOut, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        if let failure {
            throw DriverError(
                code: DriverErrorCode.internalError,
                message: "Could not open \"\(target)\": \(failure.localizedDescription)"
            )
        }
        guard let launched else {
            return LaunchResult(pid: nil, appName: nil, bundleId: nil, windows: [], watching: false)
        }

        let pid = launched.processIdentifier
        if let bundleId = launched.bundleIdentifier,
           Self.isSingleInstance(bundleId: bundleId, application: launched),
           let holder = ownership.singleInstanceHolder(bundleId: bundleId),
           holder != laneId
        {
            throw OwnershipError.appOwnedByOtherLane(bundleId: bundleId, holderLaneId: holder).driverError
        }

        startWatching(pid: pid, laneId: laneId)
        // Park whatever already exists; the watcher catches the rest.
        var parked: [DesktopWindow] = []
        let windowDeadline = Date().addingTimeInterval(3)
        while Date() < windowDeadline, parked.isEmpty {
            for window in listWindows(pid: pid) where window.laneId == nil {
                do {
                    parked.append(try park(laneId: laneId, windowId: window.id, origin: "ade_launched"))
                } catch {
                    // A window that is not ready yet is the watcher's problem,
                    // not the launch's: `launch` answers with what is parked so
                    // far and `watching: true`, exactly as its result type says.
                    log("launch could not park window \(window.id) yet: \(error)")
                }
            }
            if parked.isEmpty {
                RunLoop.current.run(until: Date().addingTimeInterval(0.15))
            }
        }
        return LaunchResult(
            pid: pid,
            appName: launched.localizedName,
            bundleId: launched.bundleIdentifier,
            windows: parked,
            watching: true
        )
    }
}
