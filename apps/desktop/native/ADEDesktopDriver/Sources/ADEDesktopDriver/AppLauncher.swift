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

        // Boxed rather than captured: the completion arrives on AppKit's
        // thread and is read on this one, and a plain captured `var` read
        // inside the pump loop below is a data race the optimiser may resolve
        // by never re-reading it.
        let launchedBox = ValueBox<NSRunningApplication>()
        let failureBox = ValueBox<Error>()
        let settled = SettledFlag()
        let completion: (NSRunningApplication?, Error?) -> Void = { application, error in
            launchedBox.set(application)
            failureBox.set(error)
            settled.set()
        }
        if url.isFileURL {
            workspace.openApplication(at: url, configuration: configuration, completionHandler: completion)
        } else {
            workspace.open(url, configuration: configuration, completionHandler: completion)
        }
        // The run loop has to keep turning: AppKit delivers the completion on
        // the main queue, and blocking it outright would deadlock the launch.
        //
        // Ten seconds, not twenty: this wait plus the three-second parking loop
        // below has to fit inside the dispatcher's watchdog budget, or a slow
        // launch would be answered twice — once by the watchdog and once by
        // this. An `openApplication` that has not answered in ten seconds is
        // not going to.
        let deadline = Date().addingTimeInterval(10)
        while !settled.isSet, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        if let failure = failureBox.value {
            throw DriverError(
                code: DriverErrorCode.internalError,
                message: "Could not open \"\(target)\": \(failure.localizedDescription)"
            )
        }
        guard settled.isSet else {
            // Neither an app nor an error: answered as a failure rather than as
            // an empty success, because "launched nothing, watching nothing" is
            // indistinguishable from a target that opened no process.
            throw DriverError(
                code: DriverErrorCode.internalError,
                message: "Launching \"\(target)\" did not complete within 10s."
            )
        }
        guard let launched = launchedBox.value else {
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
