/// Finding windows, moving them onto a lane's display, and keeping them there.
///
/// Enumeration is CoreGraphics (`CGWindowListCopyWindowInfo`), because that is
/// the only list that includes windows the user cannot see. Moving is
/// Accessibility (`kAXPositionAttribute`), because that is the only way to move
/// another process's window without being that process.
///
/// The two APIs do not share an identifier, which is the awkward part of this
/// file: CoreGraphics knows a `CGWindowID`, Accessibility knows an
/// `AXUIElement`. `_AXUIElementGetWindow` bridges them and is private, so it is
/// resolved with `dlsym` and there is a title-and-frame fallback for the day it
/// disappears.
///
/// Window ids die with their process. Nothing here caches one across a relaunch,
/// and the service must not either.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

struct DesktopWindow {
    var id: CGWindowID
    var pid: pid_t
    var appName: String
    var bundleId: String?
    var title: String?
    var frame: CGRect
    var laneId: String?
    var origin: String
    var onDisplayId: CGDirectDisplayID?
    var minimized: Bool
    var singleInstance: Bool

    /// `MacDesktopWindow`, field for field.
    func asJSON() -> [String: JSONValue] {
        [
            "id": .int(Int(id)),
            "pid": .int(Int(pid)),
            "appName": .string(appName),
            "bundleId": bundleId.map(JSONValue.string) ?? .null,
            "title": title.map(JSONValue.string) ?? .null,
            "frame": .object([
                "x": .double(Double(frame.origin.x)),
                "y": .double(Double(frame.origin.y)),
                "width": .double(Double(frame.width)),
                "height": .double(Double(frame.height)),
            ]),
            "laneId": laneId.map(JSONValue.string) ?? .null,
            "origin": .string(origin),
            "onDisplayId": onDisplayId.map { JSONValue.int(Int($0)) } ?? .null,
            "minimized": .bool(minimized),
            "singleInstance": .bool(singleInstance),
        ]
    }
}

/// `_AXUIElementGetWindow`, resolved at runtime.
///
/// Private, and the only direct CGWindowID → AXUIElement bridge that exists.
/// When it cannot be resolved, `WindowControl` falls back to matching an app's
/// AX windows by title and frame, which is right almost always and ambiguous
/// for two identical untitled windows — a trade the alternative (no parking at
/// all) loses.
enum AXWindowBridge {
    private typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    private static let getWindow: GetWindow? = {
        let rtldDefault = UnsafeMutableRawPointer(bitPattern: -2)
        guard let symbol = dlsym(rtldDefault, "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(symbol, to: GetWindow.self)
    }()

    static var isAvailable: Bool { getWindow != nil }

    static func windowId(of element: AXUIElement) -> CGWindowID? {
        guard let getWindow else { return nil }
        var value: CGWindowID = 0
        guard getWindow(element, &value) == .success, value != 0 else { return nil }
        return value
    }
}

final class WindowControl {
    /// Apps that refuse to run twice. Checked against the bundle's own
    /// `LSMultipleInstancesProhibited` first; this list is the backstop for the
    /// well-known ones that do not declare it.
    static let knownSingleInstanceBundleIds: Set<String> = [
        "com.apple.dt.Xcode",
        "com.apple.iphonesimulator",
        "com.apple.CoreSimulator.SimulatorTrampoline",
        "com.apple.finder",
        "com.apple.Safari",
        "com.tinyspeck.slackmacgap",
        "com.apple.Terminal",
        "com.apple.systempreferences",
    ]

    /// How many times a window that leaves its display is dragged back before
    /// the driver stops fighting it and says so.
    static let maxReparkAttempts = 3

    private let ownership: OwnershipRegistry
    private let log: (String) -> Void
    private let emit: (DriverEvent) -> Void

    private var originalFrames: [CGWindowID: CGRect] = [:]
    private var reparkAttempts: [CGWindowID: Int] = [:]
    private var windowOrigins: [CGWindowID: String] = [:]
    private var watchedPids: [pid_t: String] = [:]
    private var observers: [pid_t: AXObserver] = [:]
    private var knownWindowsByPid: [pid_t: Set<CGWindowID>] = [:]
    private var pollTimer: Timer?
    private var placements: [String: DisplayPlacement] = [:]
    private var displayIds: [String: CGDirectDisplayID] = [:]
    private let lock = NSRecursiveLock()

    init(
        ownership: OwnershipRegistry,
        log: @escaping (String) -> Void,
        emit: @escaping (DriverEvent) -> Void
    ) {
        self.ownership = ownership
        self.log = log
        self.emit = emit
    }

    // -----------------------------------------------------------------------
    // Lane display bookkeeping
    // -----------------------------------------------------------------------

    func setPlacement(laneId: String, placement: DisplayPlacement, displayId: CGDirectDisplayID) {
        lock.lock()
        defer { lock.unlock() }
        placements[laneId] = placement
        displayIds[laneId] = displayId
    }

    func clearPlacement(laneId: String) {
        lock.lock()
        defer { lock.unlock() }
        placements.removeValue(forKey: laneId)
        displayIds.removeValue(forKey: laneId)
        for (pid, lane) in watchedPids where lane == laneId {
            stopWatching(pid: pid)
        }
    }

    func placement(forLane laneId: String) -> DisplayPlacement? {
        lock.lock()
        defer { lock.unlock() }
        return placements[laneId]
    }

    // -----------------------------------------------------------------------
    // Enumeration
    // -----------------------------------------------------------------------

    func listWindows(laneId: String? = nil, pid: pid_t? = nil) -> [DesktopWindow] {
        let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        var windows: [DesktopWindow] = []
        for entry in raw {
            guard let layer = entry[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
            guard let windowNumber = entry[kCGWindowNumber as String] as? UInt32 else { continue }
            guard let ownerPid = entry[kCGWindowOwnerPID as String] as? Int32 else { continue }
            if let pid, ownerPid != pid { continue }
            let windowId = CGWindowID(windowNumber)
            let ownedBy = ownership.owner(ofWindow: Int(windowId))
            if let laneId, ownedBy != laneId { continue }
            let boundsDict = entry[kCGWindowBounds as String] as? [String: Any]
            let frame = boundsDict.flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } ?? .zero
            let application = NSRunningApplication(processIdentifier: ownerPid)
            let bundleId = application?.bundleIdentifier
            let appName = (entry[kCGWindowOwnerName as String] as? String)
                ?? application?.localizedName
                ?? "Unknown"
            let onScreen = (entry[kCGWindowIsOnscreen as String] as? Bool) ?? false
            windows.append(
                DesktopWindow(
                    id: windowId,
                    pid: ownerPid,
                    appName: appName,
                    bundleId: bundleId,
                    title: (entry[kCGWindowName as String] as? String).flatMap { $0.isEmpty ? nil : $0 },
                    frame: frame,
                    laneId: ownedBy,
                    origin: windowOrigins[windowId] ?? "adopted",
                    onDisplayId: displayId(containing: frame),
                    minimized: !onScreen,
                    singleInstance: Self.isSingleInstance(bundleId: bundleId, application: application)
                )
            )
        }
        return windows.sorted { $0.id < $1.id }
    }

    func window(withId windowId: CGWindowID) -> DesktopWindow? {
        listWindows().first { $0.id == windowId }
    }

    private func displayId(containing frame: CGRect) -> CGDirectDisplayID? {
        guard frame.width > 0 else { return nil }
        var displays = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(16, &displays, &count) == .success else { return nil }
        let point = CGPoint(x: frame.midX, y: frame.midY)
        for index in 0..<Int(count) {
            if CGDisplayBounds(displays[index]).contains(point) {
                return displays[index]
            }
        }
        return nil
    }

    static func isSingleInstance(bundleId: String?, application: NSRunningApplication?) -> Bool {
        guard let bundleId else { return false }
        if knownSingleInstanceBundleIds.contains(bundleId) { return true }
        guard let url = application?.bundleURL, let bundle = Bundle(url: url) else { return false }
        return (bundle.object(forInfoDictionaryKey: "LSMultipleInstancesProhibited") as? Bool) ?? false
    }

    // -----------------------------------------------------------------------
    // The CGWindowID → AXUIElement bridge
    // -----------------------------------------------------------------------

    func axWindow(for window: DesktopWindow) -> AXUIElement? {
        let application = AXUIElementCreateApplication(window.pid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
              let elements = value as? [AXUIElement]
        else { return nil }

        if AXWindowBridge.isAvailable {
            for element in elements where AXWindowBridge.windowId(of: element) == window.id {
                return element
            }
        }
        // Fallback: title first, then frame. Two identical untitled windows in
        // one app are genuinely ambiguous here, and that is reported by picking
        // nothing rather than picking wrong.
        if let title = window.title, !title.isEmpty {
            let titled = elements.filter { Self.stringAttribute($0, kAXTitleAttribute) == title }
            if titled.count == 1 { return titled[0] }
        }
        let matching = elements.filter { element in
            guard let frame = Self.frame(of: element) else { return false }
            return abs(frame.origin.x - window.frame.origin.x) < 2
                && abs(frame.origin.y - window.frame.origin.y) < 2
        }
        return matching.count == 1 ? matching[0] : nil
    }

    static func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    static func frame(of element: AXUIElement) -> CGRect? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success
        else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard let positionValue, let sizeValue else { return nil }
        // swiftlint:disable:next force_cast
        AXValueGetValue(positionValue as! AXValue, .cgPoint, &origin)
        // swiftlint:disable:next force_cast
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        return CGRect(origin: origin, size: size)
    }

    @discardableResult
    static func setFrame(_ element: AXUIElement, _ frame: CGRect) -> Bool {
        var origin = frame.origin
        var size = frame.size
        guard let positionValue = AXValueCreate(.cgPoint, &origin),
              let sizeValue = AXValueCreate(.cgSize, &size)
        else { return false }
        // Size first: a window that cannot fit the display should be shrunk
        // before it is moved, or the move lands it half off the right edge.
        let sizeResult = AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, sizeValue)
        let positionResult = AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, positionValue)
        return positionResult == .success || sizeResult == .success
    }

    // -----------------------------------------------------------------------
    // Parking
    // -----------------------------------------------------------------------

    func park(laneId: String, windowId: CGWindowID, origin: String = "claimed") throws -> DesktopWindow {
        guard let placement = placement(forLane: laneId) else {
            throw DriverError(
                code: DriverErrorCode.noDisplay,
                message: "Lane \(laneId) has no display. Start one before parking a window."
            )
        }
        guard let window = window(withId: windowId) else {
            throw DriverError(
                code: DriverErrorCode.windowNotFound,
                message: "No window \(windowId) on this Mac. Window ids die with their process; list again."
            )
        }
        do {
            try ownership.park(
                laneId: laneId,
                windowId: Int(windowId),
                bundleId: window.bundleId,
                singleInstance: window.singleInstance
            )
        } catch let error as OwnershipError {
            throw error.driverError
        }

        lock.lock()
        if originalFrames[windowId] == nil {
            originalFrames[windowId] = window.frame
        }
        windowOrigins[windowId] = origin
        reparkAttempts[windowId] = 0
        lock.unlock()

        guard let element = axWindow(for: window) else {
            ownership.unpark(windowId: Int(windowId))
            throw DriverError(
                code: DriverErrorCode.permissionRequired,
                message: "Window \(windowId) has no reachable accessibility element. "
                    + "Grant Accessibility to ADE, or the window's app is not scriptable."
            )
        }
        let index = ownership.windows(forLane: laneId).count - 1
        let size = CGSize(
            width: min(window.frame.width > 0 ? window.frame.width : placement.width, placement.width),
            height: min(window.frame.height > 0 ? window.frame.height : placement.height, placement.height)
        )
        let target = Geometry.cascadeFrame(index: max(0, index), size: size, display: placement)
        _ = Self.setFrame(element, target)

        var parked = window
        parked.laneId = laneId
        parked.frame = Self.frame(of: element) ?? target
        parked.origin = origin
        parked.onDisplayId = displayIds[laneId]
        startWatching(pid: window.pid, laneId: laneId)
        emitWindowsChanged(laneId: laneId)
        return parked
    }

    @discardableResult
    func unpark(windowId: CGWindowID) -> DesktopWindow? {
        guard let ownershipRecord = ownership.unpark(windowId: Int(windowId)) else { return nil }
        lock.lock()
        let original = originalFrames.removeValue(forKey: windowId)
        reparkAttempts.removeValue(forKey: windowId)
        windowOrigins.removeValue(forKey: windowId)
        lock.unlock()

        guard var window = window(withId: windowId) else { return nil }
        if let original, let element = axWindow(for: window) {
            _ = Self.setFrame(element, original)
            window.frame = Self.frame(of: element) ?? original
        }
        window.laneId = nil
        window.onDisplayId = displayId(containing: window.frame)
        emitWindowsChanged(laneId: ownershipRecord.laneId)
        return window
    }

    @discardableResult
    func releaseLane(_ laneId: String) -> Int {
        let held = ownership.windows(forLane: laneId)
        for record in held {
            ownership.unpark(windowId: record.windowId)
            let windowId = CGWindowID(record.windowId)
            lock.lock()
            let original = originalFrames.removeValue(forKey: windowId)
            reparkAttempts.removeValue(forKey: windowId)
            windowOrigins.removeValue(forKey: windowId)
            lock.unlock()
            if let original, let window = window(withId: windowId), let element = axWindow(for: window) {
                _ = Self.setFrame(element, original)
            }
        }
        clearPlacement(laneId: laneId)
        return held.count
    }

    /// `present`: bring the lane's windows to the user's main display, or send
    /// them back.
    @discardableResult
    func present(laneId: String, destination: String) -> Int {
        let held = ownership.windows(forLane: laneId)
        guard !held.isEmpty else { return 0 }
        let mainBounds = CGDisplayBounds(CGMainDisplayID())
        let placement = placement(forLane: laneId)
        var moved = 0
        for (index, record) in held.enumerated() {
            let windowId = CGWindowID(record.windowId)
            guard let window = window(withId: windowId), let element = axWindow(for: window) else { continue }
            let target: CGRect
            if destination == "main" {
                let size = CGSize(
                    width: min(window.frame.width, mainBounds.width),
                    height: min(window.frame.height, mainBounds.height)
                )
                target = Geometry.cascadeFrame(
                    index: index,
                    size: size,
                    display: DisplayPlacement(
                        origin: mainBounds.origin,
                        width: mainBounds.width,
                        height: mainBounds.height,
                        scale: 1
                    )
                )
            } else if let placement {
                target = Geometry.cascadeFrame(index: index, size: window.frame.size, display: placement)
            } else {
                continue
            }
            if Self.setFrame(element, target) { moved += 1 }
        }
        emitWindowsChanged(laneId: laneId)
        return moved
    }

    // -----------------------------------------------------------------------
    // Watching
    // -----------------------------------------------------------------------

    func startWatching(pid: pid_t, laneId: String) {
        lock.lock()
        let alreadyWatching = watchedPids[pid] != nil
        watchedPids[pid] = laneId
        knownWindowsByPid[pid] = Set(listWindows(pid: pid).map(\.id))
        lock.unlock()
        if !alreadyWatching {
            installObserver(pid: pid)
        }
        ensurePollTimer()
    }

    func stopWatching(pid: pid_t) {
        lock.lock()
        defer { lock.unlock() }
        watchedPids.removeValue(forKey: pid)
        knownWindowsByPid.removeValue(forKey: pid)
        if let observer = observers.removeValue(forKey: pid) {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(observer),
                .defaultMode
            )
        }
    }

    private func installObserver(pid: pid_t) {
        var observer: AXObserver?
        let callback: AXObserverCallback = { _, _, _, refcon in
            guard let refcon else { return }
            let control = Unmanaged<WindowControl>.fromOpaque(refcon).takeUnretainedValue()
            // The notification fires before the window has its final frame, so
            // the sweep runs a beat later rather than inline.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                control.sweep()
            }
        }
        guard AXObserverCreate(pid, callback, &observer) == .success, let observer else {
            log("no AX observer for pid \(pid); falling back to polling")
            return
        }
        let application = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(observer, application, kAXWindowCreatedNotification as CFString, refcon)
        AXObserverAddNotification(observer, application, kAXUIElementDestroyedNotification as CFString, refcon)
        AXObserverAddNotification(observer, application, kAXWindowMovedNotification as CFString, refcon)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        lock.lock()
        observers[pid] = observer
        lock.unlock()
    }

    /// The 1 s belt to the observer's braces.
    ///
    /// An `AXObserver` misses windows created before the observer was installed,
    /// and apps that create windows in a helper process never fire it at all.
    private func ensurePollTimer() {
        guard pollTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.sweep()
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    /// Adopt new windows of watched pids, and drag escaped windows back.
    func sweep() {
        lock.lock()
        let watched = watchedPids
        lock.unlock()
        var touchedLanes = Set<String>()

        for (pid, laneId) in watched {
            guard NSRunningApplication(processIdentifier: pid) != nil else {
                stopWatching(pid: pid)
                touchedLanes.insert(laneId)
                continue
            }
            let current = listWindows(pid: pid)
            lock.lock()
            let known = knownWindowsByPid[pid] ?? []
            knownWindowsByPid[pid] = Set(current.map(\.id))
            lock.unlock()
            for window in current where !known.contains(window.id) && window.laneId == nil {
                do {
                    _ = try park(laneId: laneId, windowId: window.id, origin: "ade_launched")
                    touchedLanes.insert(laneId)
                } catch {
                    log("could not park new window \(window.id) of pid \(pid): \(error)")
                }
            }
        }

        for record in ownership.all {
            let windowId = CGWindowID(record.windowId)
            guard let placement = placement(forLane: record.laneId) else { continue }
            guard let window = window(withId: windowId) else {
                // The window is gone; so is its ownership.
                ownership.unpark(windowId: record.windowId)
                touchedLanes.insert(record.laneId)
                continue
            }
            guard Geometry.isFullyOutside(window.frame, of: placement.frame) else {
                lock.lock()
                reparkAttempts[windowId] = 0
                lock.unlock()
                continue
            }
            lock.lock()
            let attempts = (reparkAttempts[windowId] ?? 0) + 1
            reparkAttempts[windowId] = attempts
            lock.unlock()
            if attempts > Self.maxReparkAttempts {
                log("window \(windowId) keeps leaving lane \(record.laneId); releasing it")
                emit(
                    DriverEvent(
                        event: "window-escaped",
                        fields: [
                            "laneId": .string(record.laneId),
                            "windowId": .int(record.windowId),
                            "attempts": .int(attempts - 1),
                        ]
                    )
                )
                _ = unpark(windowId: windowId)
                touchedLanes.insert(record.laneId)
                continue
            }
            if let element = axWindow(for: window) {
                let target = Geometry.cascadeFrame(index: 0, size: window.frame.size, display: placement)
                _ = Self.setFrame(element, target)
                touchedLanes.insert(record.laneId)
            }
        }

        for laneId in touchedLanes {
            emitWindowsChanged(laneId: laneId)
        }
    }

    private func emitWindowsChanged(laneId: String) {
        let windows = listWindows(laneId: laneId)
        emit(
            DriverEvent(
                event: "windows-changed",
                fields: [
                    "laneId": .string(laneId),
                    "windows": .array(windows.map { .object($0.asJSON()) }),
                ]
            )
        )
    }

    // -----------------------------------------------------------------------
    // Launching
    // -----------------------------------------------------------------------

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
                if let result = try? park(laneId: laneId, windowId: window.id, origin: "ade_launched") {
                    parked.append(result)
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

    static func resolveTarget(_ target: String, workspace: NSWorkspace) -> URL? {
        if let url = URL(string: target), let scheme = url.scheme, scheme != "file", !scheme.isEmpty {
            return url
        }
        if target.hasPrefix("/") || target.hasPrefix("~") {
            let expanded = (target as NSString).expandingTildeInPath
            if FileManager.default.fileExists(atPath: expanded) {
                return URL(fileURLWithPath: expanded)
            }
        }
        if target.contains("."), let url = workspace.urlForApplication(withBundleIdentifier: target) {
            return url
        }
        let name = target.hasSuffix(".app") ? target : "\(target).app"
        for directory in ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                          NSHomeDirectory() + "/Applications"] {
            let candidate = "\(directory)/\(name)"
            if FileManager.default.fileExists(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        return nil
    }

    func dispose() {
        pollTimer?.invalidate()
        pollTimer = nil
        lock.lock()
        let pids = Array(watchedPids.keys)
        lock.unlock()
        for pid in pids {
            stopWatching(pid: pid)
        }
    }
}
