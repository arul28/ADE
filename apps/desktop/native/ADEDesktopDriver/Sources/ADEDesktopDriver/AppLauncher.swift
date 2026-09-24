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
        if let refusal = stopGate.refusal(laneId: laneId, action: "open an app") { throw refusal }
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
        // A blank copy: no restored windows, tabs or documents. A new Safari
        // instance restored every window the user had open. See `BlankLaunch`.
        configuration.arguments = BlankLaunch.arguments(
            engine: Self.launchEngine(for: url, workspace: workspace),
            userArguments: arguments
        )
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
        // What ran before the launch, so an instance the user started — which
        // a single-instance app hands back instead of a new one — is never
        // taken for the lane's, and never quit by `stop`.
        let runningBefore = Set(workspace.runningApplications.map(\.processIdentifier))
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
        let isNewInstance = !runningBefore.contains(pid)
        // The wait above pumped the run loop, and the lane's stop can have run
        // inside it: its apps were collected to quit before this one existed,
        // so nothing would ever quit it. A new instance goes now.
        if let refusal = stopGate.refusal(laneId: laneId, action: "open an app")
            ?? (placement(forLane: laneId) == nil
                ? DriverError(
                    code: DriverErrorCode.noDisplay,
                    message: "Lane \(laneId) stopped while \"\(target)\" was opening; it was closed again."
                )
                : nil)
        {
            if isNewInstance, launchedApps.laneId(forPid: pid) == nil {
                discard(launched, reason: "lane \(laneId) stopped while it was opening")
            }
            throw refusal
        }
        // An instance another lane launched (a single-instance app hands it
        // back) is that lane's: this lane neither watches it nor takes its
        // windows, and that lane's stop quits it.
        if let refusal = launchedApps.refusal(
            pid: pid,
            laneId: laneId,
            appName: launched.localizedName ?? target
        ) {
            throw refusal
        }
        if let bundleId = launched.bundleIdentifier,
           Self.isSingleInstance(bundleId: bundleId, application: launched),
           let holder = ownership.singleInstanceHolder(bundleId: bundleId),
           holder != laneId
        {
            throw OwnershipError.appOwnedByOtherLane(bundleId: bundleId, holderLaneId: holder).driverError
        }

        let isLanes = launchedApps.record(
            pid: pid,
            laneId: laneId,
            appName: launched.localizedName ?? target,
            bundleId: launched.bundleIdentifier,
            wasRunningBefore: !isNewInstance
        )
        if !isLanes {
            log("launch of \"\(target)\" handed back pid \(pid), which was already running; only its new windows are parked, and stop does not quit it")
        }
        startWatching(pid: pid, laneId: laneId, launched: isLanes)
        // Park whatever already exists; the watcher catches the rest. An
        // instance the user started keeps the windows it already had.
        var parked: [DesktopWindow] = []
        let windowDeadline = Date().addingTimeInterval(3)
        // Each park pumps the run loop, and the lane can stop or the user can
        // take the app with Release inside it. Either ends this loop: the app
        // is no longer the lane's to park.
        let stillLanes: () -> Bool = {
            self.launchedApps.isLaunched(pid: pid, byLane: laneId)
                && self.placement(forLane: laneId) != nil
                && !self.stopGate.isStopping(laneId)
        }
        while isLanes, stillLanes(), Date() < windowDeadline, parked.isEmpty {
            for window in listWindows(pid: pid) where window.laneId == nil {
                // Checked per window as well: each park that is not ready yet
                // waits about 1.5 s, and a dozen restored windows would have
                // run this past the dispatcher's watchdog.
                guard Date() < windowDeadline, stillLanes() else { break }
                do {
                    parked.append(try park(laneId: laneId, windowId: window.id, origin: "ade_launched"))
                } catch {
                    // A window that is not ready yet is the watcher's problem,
                    // not the launch's: `launch` answers with what is parked so
                    // far and `watching: true`, exactly as its result type says.
                    // It stays a candidate for the watcher's sweep.
                    log("launch could not park window \(window.id) yet: \(error)")
                }
            }
            if parked.isEmpty, stillLanes() {
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

    /// Quits an instance a launch started for a lane that is gone, and
    /// force-quits it if it is still running after `quitGrace`.
    ///
    /// Not waited for: this runs inside a request, and the lane's own stop is
    /// already waiting on the main thread. `NSRunningApplication` is bound to
    /// the process, not the pid, so the late force quit cannot hit a process
    /// that reused the pid.
    func discard(_ application: NSRunningApplication, reason: String) {
        let name = application.localizedName ?? "pid \(application.processIdentifier)"
        log("quitting \(name): \(reason)")
        if !application.terminate() {
            log("\(name) refused the request to quit")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.quitGrace) { [weak self] in
            guard !application.isTerminated else { return }
            self?.log("\(name) did not quit within \(Self.quitGrace)s; force-quitting it")
            application.forceTerminate()
        }
    }

    /// Whether the app behind a launch target reads AppKit defaults from its
    /// command line. A target that is a document or a URL is judged by the
    /// app that opens it. Unknown means AppKit: that is every Mac app that is
    /// not a Chromium, Electron or Gecko shell.
    static func launchEngine(for url: URL, workspace: NSWorkspace) -> BlankLaunch.Engine {
        let appURL: URL?
        if url.isFileURL, url.pathExtension == "app" {
            appURL = url
        } else {
            appURL = workspace.urlForApplication(toOpen: url)
        }
        guard let appURL else { return .appKit }
        let contents = appURL.appendingPathComponent("Contents")
        let fileManager = FileManager.default
        let frameworks = (try? fileManager.contentsOfDirectory(
            atPath: contents.appendingPathComponent("Frameworks").path
        )) ?? []
        let executables = (try? fileManager.contentsOfDirectory(
            atPath: contents.appendingPathComponent("MacOS").path
        )) ?? []
        return BlankLaunch.engine(frameworkNames: frameworks, executableNames: executables)
    }
}
