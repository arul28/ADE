/// The apps a lane starts: how they start blank, which of their windows the
/// watcher still has to park, and which of them `stop` quits.
///
/// Three rules, all bookkeeping, so they live here without AppKit:
///
/// * `BlankLaunch`: every app the lane opens starts as a blank copy. A new
///   instance of Safari restored every window and tab the user had open, and
///   the watcher then tried to park a dozen of them.
/// * `NewWindowTracker`: which windows of a watched app the sweep tries to
///   park, and when it stops trying.
/// * `LaunchedAppRegistry`: which app instances a lane started. Only those are
///   quit when the lane's display goes away; an instance the user started is
///   never quit, even when the lane borrowed one of its windows.
/// * `WindowRelease`: a release of a launched app's window gives the user the
///   whole instance, and the lane forgets it.

import Foundation

// ---------------------------------------------------------------------------
// Blank launch
// ---------------------------------------------------------------------------

public enum BlankLaunch {
    /// How an app reads its command line, which decides whether AppKit
    /// defaults can be passed on it.
    public enum Engine: Equatable, Sendable {
        /// An AppKit app. `NSUserDefaults` reads `-Key value` pairs from the
        /// command line into its argument domain, which wins over every
        /// other domain for this process only.
        case appKit
        /// Chromium, Electron and Gecko apps. They read every loose command
        /// line word as a URL or a file to open, so `-Key YES` would open a
        /// tab or a file named "YES". Google Chrome's framework does not
        /// contain the string `ApplePersistenceIgnoreState` at all.
        case ownCommandLine
    }

    /// The defaults that make an AppKit app start with nothing open:
    ///
    /// * `ApplePersistenceIgnoreState YES`: AppKit skips the saved window
    ///   state (the "Resume" state in `~/Library/Saved Application State`).
    ///   AppKit logs "Existing state will not be touched. New state will be
    ///   written to <temporary path>" for it, so the copy also never
    ///   overwrites the state of the user's own instance.
    /// * `NSQuitAlwaysKeepsWindows NO`: the per-process value of "Close
    ///   windows when quitting an application". The copy keeps no windows
    ///   for a later launch.
    /// * `NSShowAppCentricOpenPanelInsteadOfUntitledFile NO`: a document app
    ///   (TextEdit, Pages) opens an empty untitled document at launch
    ///   instead of its iCloud Open panel. The panel is an out-of-process
    ///   remote view that stalled every accessibility walk into TextEdit.
    ///
    /// All three strings are in the AppKit binary of this macOS
    /// (`dyld_shared_cache`); none of them is in a public header.
    public static let appKitDefaults: [String] = [
        "-ApplePersistenceIgnoreState", "YES",
        "-NSQuitAlwaysKeepsWindows", "NO",
        "-NSShowAppCentricOpenPanelInsteadOfUntitledFile", "NO",
    ]

    /// Framework names that mark an app that parses its own command line.
    private static let ownCommandLineFrameworkMarkers = [
        "electron framework",
        "chromium embedded framework",
        "chrome framework",
        "chromium framework",
        "edge framework",
        "brave browser framework",
        "vivaldi framework",
        "opera framework",
    ]

    /// Decides the engine from the bundle's `Contents/Frameworks` entries and
    /// `Contents/MacOS` entries. Gecko apps (Firefox) carry `XUL` in MacOS.
    public static func engine(frameworkNames: [String], executableNames: [String]) -> Engine {
        for name in frameworkNames {
            let lowered = name.lowercased()
            if ownCommandLineFrameworkMarkers.contains(where: { lowered.contains($0) }) {
                return .ownCommandLine
            }
        }
        if executableNames.contains("XUL") { return .ownCommandLine }
        return .appKit
    }

    /// The launch arguments: the blank-launch defaults first, then the
    /// caller's own. A caller that passes one of the same keys wins, because
    /// the argument domain keeps the last value of a key.
    public static func arguments(engine: Engine, userArguments: [String]) -> [String] {
        switch engine {
        case .appKit: return appKitDefaults + userArguments
        case .ownCommandLine: return userArguments
        }
    }
}

// ---------------------------------------------------------------------------
// New windows of a watched app
// ---------------------------------------------------------------------------

/// Which windows of a watched app the sweep tries to park.
///
/// Two defects came from the old bookkeeping, one set of "known" window ids
/// per pid that `park` reset to the current list on every call:
///
/// * A window of a just-launched app that the launch could not park in its
///   three seconds was already "known", so no sweep ever tried it again.
/// * A window that was "not ready" was removed from the set to retry it, and
///   the next successful `park` of another window of the same app put it
///   back. It was never tried again.
///
/// Here a launched app starts with nothing known, so every window it shows is
/// a candidate until it is parked, and only a park, a give-up or the window's
/// end takes it off the list. A "not ready" window is retried a bounded number
/// of times: a restored Safari window that never publishes an accessibility
/// element cost 1.5 seconds of the main thread per window per second.
public final class NewWindowTracker: @unchecked Sendable {
    public enum NotReadyDecision: Equatable, Sendable {
        /// Try again on the next sweep. `isFirst` is true only once per
        /// window, so the caller logs once.
        case retry(isFirst: Bool)
        /// Stop trying. The caller logs this once.
        case giveUp
    }

    /// How many "not ready" answers a window gets before the sweep stops
    /// trying it. Three sweeps is three seconds plus three readiness waits:
    /// a real new window is ready long before that.
    public static let defaultMaxNotReadyAttempts = 3

    private struct Watch {
        var laneId: String
        var launched: Bool
        /// Windows that need no more attempts: parked, given up, or already
        /// there when a claimed app started to be watched.
        var settled: Set<UInt32>
        var notReady: [UInt32: Int]
    }

    private let lock = NSLock()
    private var watches: [Int32: Watch] = [:]
    public let maxNotReadyAttempts: Int

    public init(maxNotReadyAttempts: Int = NewWindowTracker.defaultMaxNotReadyAttempts) {
        self.maxNotReadyAttempts = max(1, maxNotReadyAttempts)
    }

    /// Starts watching a pid, or keeps the existing watch.
    ///
    /// A launched app starts with nothing settled: every window it has is the
    /// lane's. A claimed app (the user's) settles the windows it already has,
    /// so only windows it opens later are candidates. A second call for a pid
    /// that is already watched changes nothing, except that a launch upgrades
    /// a claimed watch.
    public func watch(pid: Int32, laneId: String, launched: Bool, existing: [UInt32]) {
        lock.lock()
        defer { lock.unlock() }
        if var current = watches[pid], current.laneId == laneId {
            if launched && !current.launched {
                current.launched = true
                watches[pid] = current
            }
            return
        }
        watches[pid] = Watch(
            laneId: laneId,
            launched: launched,
            settled: launched ? [] : Set(existing),
            notReady: [:]
        )
    }

    public func unwatch(pid: Int32) {
        lock.lock()
        defer { lock.unlock() }
        watches.removeValue(forKey: pid)
    }

    public func isWatching(pid: Int32) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return watches[pid] != nil
    }

    public func laneId(forPid pid: Int32) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return watches[pid]?.laneId
    }

    /// Whether the watch is for an app the lane launched.
    public func isLaunched(pid: Int32) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return watches[pid]?.launched ?? false
    }

    public var watchedPids: [Int32: String] {
        lock.lock()
        defer { lock.unlock() }
        return watches.mapValues(\.laneId)
    }

    /// The windows the sweep should try to park now, in the order given.
    ///
    /// `current` is every window the app has; `unowned` is the subset that no
    /// lane holds. Windows that have ended are forgotten here too.
    ///
    /// `minimized` is the subset that is not on any screen: minimized, or off
    /// screen in an app that did not answer Accessibility. Such a window is no
    /// new window to park. A park cannot move it, so the escape check then
    /// "released" it as a window that kept leaving, and the lane listed it with
    /// a minimized badge. It is skipped but not settled: once it is back on a
    /// screen, it is a candidate again.
    public func candidates(
        pid: Int32,
        current: [UInt32],
        unowned: Set<UInt32>,
        minimized: Set<UInt32> = []
    ) -> [UInt32] {
        lock.lock()
        defer { lock.unlock() }
        guard var watch = watches[pid] else { return [] }
        let live = Set(current)
        watch.settled.formIntersection(live)
        watch.notReady = watch.notReady.filter { live.contains($0.key) }
        watches[pid] = watch
        return current.filter {
            unowned.contains($0) && !watch.settled.contains($0) && !minimized.contains($0)
        }
    }

    /// A window was parked (by the sweep, the launch or a claim).
    public func noteParked(pid: Int32, windowId: UInt32) {
        lock.lock()
        defer { lock.unlock() }
        guard var watch = watches[pid] else { return }
        watch.settled.insert(windowId)
        watch.notReady.removeValue(forKey: windowId)
        watches[pid] = watch
    }

    /// A park failed with an error that retrying cannot fix.
    public func noteFailed(pid: Int32, windowId: UInt32) {
        noteParked(pid: pid, windowId: windowId)
    }

    /// A park answered "not ready".
    public func noteNotReady(pid: Int32, windowId: UInt32) -> NotReadyDecision {
        lock.lock()
        defer { lock.unlock() }
        guard var watch = watches[pid] else { return .giveUp }
        let attempts = (watch.notReady[windowId] ?? 0) + 1
        if attempts >= maxNotReadyAttempts {
            watch.notReady.removeValue(forKey: windowId)
            watch.settled.insert(windowId)
            watches[pid] = watch
            return .giveUp
        }
        watch.notReady[windowId] = attempts
        watches[pid] = watch
        return .retry(isFirst: attempts == 1)
    }

    /// The origin a window parked by the sweep carries. A new window of an
    /// app the user started stays the user's: it is "claimed", so ⌘W releases
    /// it rather than closing it, and ⌘Q never counts it as the lane's.
    public func originForNewWindow(pid: Int32) -> String {
        isLaunched(pid: pid) ? "ade_launched" : "claimed"
    }
}

// ---------------------------------------------------------------------------
// Launched app instances
// ---------------------------------------------------------------------------

/// The app instances a lane started, which are the only ones `stop` quits.
public final class LaunchedAppRegistry: @unchecked Sendable {
    public struct App: Equatable, Sendable {
        public let pid: Int32
        public let laneId: String
        public let appName: String
        public let bundleId: String?

        public init(pid: Int32, laneId: String, appName: String, bundleId: String?) {
            self.pid = pid
            self.laneId = laneId
            self.appName = appName
            self.bundleId = bundleId
        }
    }

    private let lock = NSLock()
    private var byPid: [Int32: App] = [:]

    public init() {}

    /// Records the instance a launch handed back, and answers whether it is
    /// the lane's.
    ///
    /// `wasRunningBefore` is whether the pid was already running when the
    /// launch began. A single-instance app ignores "new instance" and hands
    /// back the running one, which the user started. That instance is not
    /// recorded, unless this lane launched it earlier.
    @discardableResult
    public func record(
        pid: Int32,
        laneId: String,
        appName: String,
        bundleId: String?,
        wasRunningBefore: Bool
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let existing = byPid[pid] {
            return existing.laneId == laneId
        }
        guard !wasRunningBefore else { return false }
        byPid[pid] = App(pid: pid, laneId: laneId, appName: appName, bundleId: bundleId)
        return true
    }

    public func isLaunched(pid: Int32, byLane laneId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return byPid[pid]?.laneId == laneId
    }

    public func apps(forLane laneId: String) -> [App] {
        lock.lock()
        defer { lock.unlock() }
        return byPid.values.filter { $0.laneId == laneId }.sorted { $0.pid < $1.pid }
    }

    public var all: [App] {
        lock.lock()
        defer { lock.unlock() }
        return byPid.values.sorted { $0.pid < $1.pid }
    }

    public func forget(pid: Int32) {
        lock.lock()
        defer { lock.unlock() }
        byPid.removeValue(forKey: pid)
    }

    /// Forgets every app of a lane, and returns them.
    @discardableResult
    public func forgetLane(_ laneId: String) -> [App] {
        lock.lock()
        defer { lock.unlock() }
        let apps = byPid.values.filter { $0.laneId == laneId }
        for app in apps { byPid.removeValue(forKey: app.pid) }
        return apps.sorted { $0.pid < $1.pid }
    }
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

/// What releasing one window of a lane gives back to the user.
///
/// Releasing a window of an app the lane launched used to drop the lane's
/// hold on that one window only. The pid stayed watched as the lane's app, so
/// the sweep parked the next window the app showed, and `stop` still quit the
/// app the user now had on their screen. A release now gives the user the
/// whole instance, and the driver does not touch that instance again.
public enum WindowRelease {
    public enum Plan: Equatable, Sendable {
        /// The lane launched the app: every window of the instance goes to
        /// the main screen, and the pid leaves the launched set and the watch.
        case handOverApp
        /// A window the user claimed: only it goes back. `stopWatching` is
        /// true when the lane holds no other window of that app, so a later
        /// window of the user's app is never parked.
        case returnWindow(stopWatching: Bool)
    }

    /// `launchedByLane` is whether the lane that holds the window launched
    /// its app. `otherWindowsHeld` counts the other windows of the same pid
    /// that the lane still holds.
    public static func plan(launchedByLane: Bool, otherWindowsHeld: Int) -> Plan {
        if launchedByLane { return .handOverApp }
        return .returnWindow(stopWatching: otherWindowsHeld == 0)
    }
}

/// What quitting a lane's apps did, for the `display.destroy` reply and the
/// `display-destroyed` event.
public struct LaneQuitReport: Equatable, Sendable {
    public struct LeftOpen: Equatable, Sendable {
        public let pid: Int32
        public let appName: String

        public init(pid: Int32, appName: String) {
            self.pid = pid
            self.appName = appName
        }

        /// The sentence the pane and the CLI show. `stop` force-quits an app
        /// that stays open, so this is an app that survived even that.
        public var message: String {
            "\(appName) did not quit, even when forced. It moved to your screen."
        }

        public func asJSON() -> [String: JSONValue] {
            ["pid": .int(Int(pid)), "appName": .string(appName), "message": .string(message)]
        }
    }

    public var quit: [String]
    public var leftOpen: [LeftOpen]

    public init(quit: [String] = [], leftOpen: [LeftOpen] = []) {
        self.quit = quit
        self.leftOpen = leftOpen
    }

    public static let empty = LaneQuitReport()

    /// Splits the lane's apps into the ones that quit and the ones that did
    /// not, after the wait. `stillRunning` is the set of pids alive now.
    public static func settle(apps: [LaunchedAppRegistry.App], stillRunning: Set<Int32>) -> LaneQuitReport {
        var report = LaneQuitReport()
        for app in apps {
            if stillRunning.contains(app.pid) {
                report.leftOpen.append(LeftOpen(pid: app.pid, appName: app.appName))
            } else {
                report.quit.append(app.appName)
            }
        }
        return report
    }

    public var jsonFields: [String: JSONValue] {
        [
            "quitApps": .array(quit.map(JSONValue.string)),
            "appsLeftOpen": .array(leftOpen.map { .object($0.asJSON()) }),
        ]
    }
}
