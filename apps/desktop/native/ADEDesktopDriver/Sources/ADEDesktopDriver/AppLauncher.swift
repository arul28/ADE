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

        let documents = Self.documentLaunch(target: url, arguments: arguments, workspace: workspace)
        let configuration = NSWorkspace.OpenConfiguration()
        // A blank copy: no restored windows, tabs or documents. A new Safari
        // instance restored every window the user had open. See `BlankLaunch`.
        configuration.arguments = BlankLaunch.arguments(
            engine: Self.launchEngine(for: documents?.app ?? url, workspace: workspace),
            userArguments: documents == nil ? arguments : []
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
        if let documents {
            workspace.open(documents.files, withApplicationAt: documents.app, configuration: configuration, completionHandler: completion)
        } else if url.isFileURL {
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

    /// The files a launch opens as documents, and the app that opens them, or
    /// nil for a plain app launch.
    ///
    /// A file has to reach its app as a document (an open-documents event),
    /// not as a command-line word: a sandboxed app such as TextEdit may read
    /// only the files macOS hands it that way. Given `open TextEdit -- <file>`
    /// as an argument, TextEdit said it had no permission to open the file
    /// (2026-09-28).
    ///
    /// * `open <file>`: the file, in the app macOS picks for it.
    /// * `open <app> -- <file> [<file>…]`: when every argument is an existing
    ///   absolute or `~` path. An argument list with anything else in it (a
    ///   flag, a value) stays a command line.
    static func documentLaunch(target url: URL, arguments: [String], workspace: NSWorkspace) -> (app: URL, files: [URL])? {
        guard url.isFileURL else { return nil }
        if url.pathExtension != "app" {
            guard let app = workspace.urlForApplication(toOpen: url) else { return nil }
            return (app, [url])
        }
        guard !arguments.isEmpty else { return nil }
        var files: [URL] = []
        for argument in arguments {
            guard argument.hasPrefix("/") || argument.hasPrefix("~") else { return nil }
            let path = (argument as NSString).expandingTildeInPath
            guard FileManager.default.fileExists(atPath: path) else { return nil }
            files.append(URL(fileURLWithPath: path))
        }
        return (url, files)
    }

    /// `app.quit`: quits the app instances this lane opened, on request.
    ///
    /// Covers the instances the lane still holds and the ones it opened and
    /// then released to the user. `stop` and the idle close never quit a
    /// released app; this does, because the user asked for it ("close what
    /// you opened"). A held app is quit like `stop` quits it (force-quit after
    /// `quitGrace`). A released app is only asked to quit: its windows are on
    /// the user's screen, so a save dialog is where the user can answer it.
    ///
    /// `match` is an app name, a bundle id or a pid; nil quits every one.
    func quitApps(laneId: String, match: String?) throws -> [(app: LaunchedAppRegistry.App, released: Bool)] {
        let needle = match?.trimmingCharacters(in: .whitespaces).lowercased()
        let candidates = launchedApps.apps(forLane: laneId).map { (app: $0, released: false) }
            + launchedApps.releasedApps(forLane: laneId).map { (app: $0, released: true) }
        let wanted = candidates.filter { candidate in
            guard let needle, !needle.isEmpty else { return true }
            return candidate.app.appName.lowercased() == needle
                || candidate.app.bundleId?.lowercased() == needle
                || String(candidate.app.pid) == needle
        }
        guard !wanted.isEmpty else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: match == nil
                    ? "Lane \(laneId) has no open app that it opened."
                    : "Lane \(laneId) did not open \"\(match!)\". It quits only apps it opened with `open`."
            )
        }
        var quit: [(app: LaunchedAppRegistry.App, released: Bool)] = []
        for candidate in wanted {
            let pid = candidate.app.pid
            guard let running = NSRunningApplication(processIdentifier: pid),
                  candidate.app.isStillRunning(
                    currentBundleId: running.bundleIdentifier,
                    isTerminated: running.isTerminated,
                    hasProcess: true
                  )
            else {
                launchedApps.forget(pid: pid)
                continue
            }
            launchedApps.forget(pid: pid)
            if candidate.released {
                log("asking \(candidate.app.appName) (pid \(pid)) to quit: the user asked lane \(laneId) to close what it opened")
                _ = running.terminate()
            } else {
                stopWatching(pid: pid)
                discard(running, reason: "the user asked lane \(laneId) to close it")
            }
            quit.append(candidate)
        }
        emitWindowsChanged(laneId: laneId)
        return quit
    }

    /// One window a driver exit took off a lane, and where it sat: the frame
    /// is relative to the lane display's top-left corner, so it lands in the
    /// same spot on the next display wherever macOS places that one.
    struct HandedOffWindow {
        let id: CGWindowID
        let frame: CGRect
        let minimized: Bool

        func asJSON() -> [String: Any] {
            [
                "id": Int(id),
                "x": Double(frame.origin.x), "y": Double(frame.origin.y),
                "width": Double(frame.width), "height": Double(frame.height),
                "minimized": minimized,
            ]
        }
    }

    /// One app with windows on a lane when the driver exited: an instance the
    /// lane opened (`launched`), or one of the user's apps the lane borrowed
    /// windows from. Either way it is still running, and the next brain takes
    /// it back.
    struct HandedOffApp {
        let laneId: String
        let pid: pid_t
        let appName: String
        let bundleId: String?
        /// `launchDate` in ms since 1970: with the bundle id, what tells the
        /// same instance from a process that reused its pid.
        let launchedAt: Double?
        let launched: Bool
        let windows: [HandedOffWindow]

        func asJSON() -> [String: Any] {
            var json: [String: Any] = [
                "laneId": laneId, "pid": Int(pid), "appName": appName,
                "launched": launched, "windows": windows.map { $0.asJSON() },
            ]
            if let bundleId { json["bundleId"] = bundleId }
            if let launchedAt { json["launchedAt"] = launchedAt }
            return json
        }
    }

    /// A lane's display as it was, so the next one is made the same size.
    struct HandedOffLane {
        let laneId: String
        let width: Int
        let height: Int

        func asJSON() -> [String: Any] { ["laneId": laneId, "width": width, "height": height] }
    }

    /// Every lane's apps leave the lanes, still running, for a driver that
    /// exits because the brain is restarting (an update, a service restart).
    /// The virtual displays die with this process; the apps on them, their
    /// unsaved work, and the windows the lanes borrowed do not have to.
    ///
    /// What each lane held is recorded first — the display size and every
    /// window's frame on it — so `app.adopt` can put it all back where it was.
    /// Then an app the lane opened moves to the main screen, and a borrowed
    /// window goes home the way a Release sends it. If no brain takes them
    /// back, they are ordinary apps on the user's screen.
    func handOffLanes() -> (lanes: [HandedOffLane], apps: [HandedOffApp]) {
        let laneIds = Set(launchedApps.all.map(\.laneId)).union(ownership.all.map(\.laneId))
        var lanes: [HandedOffLane] = []
        var apps: [HandedOffApp] = []
        for laneId in laneIds.sorted() {
            guard let placement = placement(forLane: laneId) else { continue }
            lanes.append(HandedOffLane(laneId: laneId, width: Int(placement.width), height: Int(placement.height)))
            let held = listWindows(laneId: laneId).filter { $0.laneId == laneId }
            var pids = Set(held.map(\.pid))
            pids.formUnion(launchedApps.apps(forLane: laneId).map(\.pid))
            for pid in pids.sorted() {
                guard let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated else { continue }
                let windows = held.filter { $0.pid == pid }
                apps.append(HandedOffApp(
                    laneId: laneId,
                    pid: pid,
                    appName: running.localizedName ?? windows.first?.appName ?? "pid \(pid)",
                    bundleId: running.bundleIdentifier,
                    launchedAt: running.launchDate.map { $0.timeIntervalSince1970 * 1000 },
                    launched: launchedApps.isLaunched(pid: pid, byLane: laneId),
                    windows: windows.map { window in
                        HandedOffWindow(
                            id: window.id,
                            frame: window.frame.offsetBy(dx: -placement.origin.x, dy: -placement.origin.y),
                            minimized: window.minimized
                        )
                    }
                ))
            }
        }
        for app in apps {
            if app.launched {
                stopWatching(pid: app.pid)
                launchedApps.forget(pid: app.pid)
                let moved = moveWindowsToMainScreen(pid: app.pid, laneId: app.laneId)
                log("handed \(app.appName) (pid \(app.pid)) of lane \(app.laneId) to the main screen with \(moved.count) window(s)")
            } else {
                for window in app.windows { _ = release(windowId: window.id) }
                log("sent lane \(app.laneId)'s \(app.windows.count) borrowed \(app.appName) window(s) home")
            }
        }
        return (lanes, apps)
    }

    /// `app.adopt`: takes back an app a previous driver handed off.
    ///
    /// A `launched` app becomes the lane's own instance again: every window is
    /// parked, new ones are watched, and the lane's stop quits it. Otherwise
    /// only the named windows are borrowed again, as a claim would. Each
    /// window with a recorded frame goes back to that spot on the lane's
    /// display, minimized if it was.
    ///
    /// Only the same instance: the pid must still run the recorded bundle,
    /// launched at the recorded moment, so a reused pid is never taken.
    func adopt(
        laneId: String,
        pid: pid_t,
        bundleId: String?,
        launchedAt: Double?,
        launched: Bool,
        windows recorded: [HandedOffWindow]
    ) throws -> LaunchResult {
        if let refusal = stopGate.refusal(laneId: laneId, action: "take back an app") { throw refusal }
        guard placement(forLane: laneId) != nil else {
            throw DriverError(
                code: DriverErrorCode.noDisplay,
                message: "Lane \(laneId) has no display. Start one before taking an app back onto it."
            )
        }
        guard let running = NSRunningApplication(processIdentifier: pid),
              !running.isTerminated,
              running.bundleIdentifier == bundleId,
              Self.sameLaunch(running.launchDate, recorded: launchedAt)
        else {
            throw DriverError(
                code: DriverErrorCode.windowNotFound,
                message: "pid \(pid) is no longer the app lane \(laneId) had."
            )
        }
        let appName = running.localizedName ?? bundleId ?? "pid \(pid)"
        if let refusal = launchedApps.refusal(pid: pid, laneId: laneId, appName: appName) { throw refusal }
        if launched {
            launchedApps.record(pid: pid, laneId: laneId, appName: appName, bundleId: bundleId, wasRunningBefore: false)
            startWatching(pid: pid, laneId: laneId, launched: true)
        }
        let wanted = Set(recorded.map(\.id))
        var parked: [DesktopWindow] = []
        for window in listWindows(pid: pid) where window.laneId == nil && (launched || wanted.contains(window.id)) {
            guard !stopGate.isStopping(laneId),
                  !launched || launchedApps.isLaunched(pid: pid, byLane: laneId)
            else { break }
            do {
                parked.append(try park(laneId: laneId, windowId: window.id, origin: launched ? "ade_launched" : "claimed"))
            } catch {
                // A launched app's watcher parks it once it is ready.
                log("adopt could not park window \(window.id) yet: \(error)")
            }
        }
        if let placement = placement(forLane: laneId) {
            for index in parked.indices {
                guard let spot = recorded.first(where: { $0.id == parked[index].id }),
                      let element = axWindow(for: parked[index])
                else { continue }
                let size = CGSize(width: min(spot.frame.width, placement.width), height: min(spot.frame.height, placement.height))
                let x = min(max(spot.frame.origin.x, 0), placement.width - size.width)
                let y = min(max(spot.frame.origin.y, 0), placement.height - size.height)
                let target = CGRect(origin: CGPoint(x: placement.origin.x + x, y: placement.origin.y + y), size: size)
                if Self.setFrame(element, target) { parked[index].frame = Self.frame(of: element) ?? target }
                if spot.minimized {
                    AXUIElementSetAttributeValue(element, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
                    parked[index].minimized = true
                }
            }
        }
        if !parked.isEmpty { emitWindowsChanged(laneId: laneId) }
        log("lane \(laneId) took back \(appName) (pid \(pid)) with \(parked.count) window(s)")
        return LaunchResult(pid: pid, appName: appName, bundleId: bundleId, windows: parked, watching: launched)
    }

    /// A recorded launch moment matches when it is within a second; a record
    /// without one matches on the bundle id alone.
    static func sameLaunch(_ launchDate: Date?, recorded: Double?) -> Bool {
        guard let recorded else { return true }
        guard let launchDate else { return false }
        return abs(launchDate.timeIntervalSince1970 * 1000 - recorded) < 1000
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
