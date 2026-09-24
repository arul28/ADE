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
    /// The app's icon, base64 PNG. Carried by the first window of each bundle
    /// id in a listing and nil on the rest — see `WindowControl.appIconBase64`.
    var iconPng: String? = nil

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
            // Omitted rather than sent as null on every row that does not carry
            // one: a listing is mostly rows without an icon.
        ].merging(iconPng.map { ["iconPng": JSONValue.string($0)] } ?? [:]) { _, new in new }
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

    let ownership: OwnershipRegistry
    let log: (String) -> Void
    let emit: (DriverEvent) -> Void

    /// "Is a real drag holding the mouse button right now?"
    ///
    /// Injected rather than reached for: the watcher's 1-second sweep runs on
    /// the same run loop the drag loop pumps, so without this the sweep can
    /// move a window — possibly the one under the pointer — in the middle of a
    /// gesture. Set by `DriverRuntime`; defaults to "no" so the watcher is
    /// still testable on its own.
    var isGestureInFlight: () -> Bool = { false }

    /// bundle id → base64 PNG, or nil when that app has no readable icon.
    ///
    /// Held for the driver's lifetime: an app's icon does not change while it
    /// is running, and re-rendering eight PNGs on every refresh of a picker
    /// that refreshes on every `windows-changed` is pure waste.
    private var iconCache: [String: String?] = [:]

    private var originalFrames: [CGWindowID: CGRect] = [:]
    var reparkAttempts: [CGWindowID: Int] = [:]
    private var windowOrigins: [CGWindowID: String] = [:]
    var observers: [pid_t: AXObserver] = [:]
    /// The watched pids, and which of their windows the sweep still has to
    /// park. See `NewWindowTracker`.
    let newWindows = NewWindowTracker()
    /// The app instances each lane started. Only these quit when the lane's
    /// display goes away.
    let launchedApps = LaunchedAppRegistry()
    /// The lanes being stopped right now. `launch` and `park` refuse them;
    /// `DriverRuntime` sets it around every stop and checks it for captures.
    let stopGate = LaneStopGate()
    /// True while a sweep runs. A park inside a sweep pumps the run loop, and
    /// the poll timer or an observer callback would otherwise start a second
    /// sweep inside the first one.
    var isSweeping = false
    var pollTimer: Timer?
    private var placements: [String: DisplayPlacement] = [:]
    private var displayIds: [String: CGDirectDisplayID] = [:]
    /// laneId → which of the lane's displays `placements` describes. See
    /// `LanePlacement`: a park compares it across its wait.
    private var placementGenerations: [String: UInt64] = [:]
    private var nextPlacementGeneration: UInt64 = 1
    let lock = NSRecursiveLock()

    /// Apps that stopped answering the Accessibility API recently. Shared with
    /// the observation walk, so a stall one of them sees is skipped by the
    /// other instead of paid for again. See `AXWalkBudget.swift`.
    let stalls: AXStallRegistry

    init(
        ownership: OwnershipRegistry,
        log: @escaping (String) -> Void,
        emit: @escaping (DriverEvent) -> Void,
        stalls: AXStallRegistry = AXStallRegistry()
    ) {
        self.ownership = ownership
        self.log = log
        self.emit = emit
        self.stalls = stalls
    }

    // -----------------------------------------------------------------------
    // Lane display bookkeeping
    // -----------------------------------------------------------------------

    func setPlacement(laneId: String, placement: DisplayPlacement, displayId: CGDirectDisplayID) {
        lock.lock()
        defer { lock.unlock() }
        // A repeat `display.create` hands back the lane's existing display;
        // that is the same display, not a new generation of it.
        let unchanged = placements[laneId] == placement
            && displayIds[laneId] == displayId
            && placementGenerations[laneId] != nil
        placements[laneId] = placement
        displayIds[laneId] = displayId
        if !unchanged {
            placementGenerations[laneId] = nextPlacementGeneration
            nextPlacementGeneration += 1
        }
    }

    func clearPlacement(laneId: String) {
        lock.lock()
        defer { lock.unlock() }
        placements.removeValue(forKey: laneId)
        displayIds.removeValue(forKey: laneId)
        placementGenerations.removeValue(forKey: laneId)
        for (pid, lane) in newWindows.watchedPids where lane == laneId {
            stopWatching(pid: pid)
        }
    }

    func placement(forLane laneId: String) -> DisplayPlacement? {
        lock.lock()
        defer { lock.unlock() }
        return placements[laneId]
    }

    /// The lane's display with its id and generation, read in one go.
    func lanePlacement(forLane laneId: String) -> LanePlacement? {
        lock.lock()
        defer { lock.unlock() }
        guard let placement = placements[laneId],
              let displayId = displayIds[laneId],
              let generation = placementGenerations[laneId]
        else { return nil }
        return LanePlacement(placement: placement, displayId: displayId, generation: generation)
    }

    // -----------------------------------------------------------------------
    // Enumeration
    // -----------------------------------------------------------------------

    /// The windows in scope, as `MacDesktopWindow` rows.
    ///
    /// Every filter is applied to the window server's entry before the one
    /// Accessibility read a listing can make (see `WindowListScope`). Only
    /// the claim picker lists with no filter at all: the watcher and every
    /// lookup by id pass one, so a sweep never asks an unrelated app for its
    /// windows.
    func listWindows(
        laneId: String? = nil,
        pid: pid_t? = nil,
        windowIds: Set<CGWindowID>? = nil
    ) -> [DesktopWindow] {
        let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        let scope = WindowListScope(laneId: laneId, pid: pid, windowIds: windowIds)
        lock.lock()
        let laneDisplay = laneId.flatMap { displayIds[$0] }
        let origins = windowOrigins
        lock.unlock()
        var windows: [DesktopWindow] = []
        // One AX read per app, at most, and only for apps that have an entry the
        // window server says is not on screen. See `axWindowMinimizedState`.
        var axStateByPid: [pid_t: [CGWindowID: Bool]?] = [:]
        // One icon per app per reply: the renderer joins it across the app's
        // other rows, so forty windows of eight apps cost eight PNGs.
        var iconSentFor: Set<String> = []
        for entry in raw {
            guard let layer = entry[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
            guard let windowNumber = entry[kCGWindowNumber as String] as? UInt32 else { continue }
            guard let ownerPid = entry[kCGWindowOwnerPID as String] as? Int32 else { continue }
            if let pid, ownerPid != pid { continue }
            let windowId = CGWindowID(windowNumber)
            if let windowIds, !windowIds.contains(windowId) { continue }
            let ownedBy = ownership.owner(ofWindow: Int(windowId))
            // A lane's list is what is ON its display, owned or not: a window
            // the user dragged there by hand is an app on that desktop too,
            // and the Apps list read "No apps" while Finder sat in the picture.
            // Ownership still decides what the driver may move or release.
            let boundsDict = entry[kCGWindowBounds as String] as? [String: Any]
            let frame = boundsDict.flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } ?? .zero
            let needsDisplay = laneId != nil && ownedBy != laneId
            guard scope.admits(
                windowId: windowId,
                ownerPid: ownerPid,
                ownedBy: ownedBy,
                displayId: needsDisplay ? displayId(containing: frame) : nil,
                laneDisplayId: laneDisplay
            ) else { continue }
            let application = NSRunningApplication(processIdentifier: ownerPid)
            let bundleId = application?.bundleIdentifier
            let appName = (entry[kCGWindowOwnerName as String] as? String)
                ?? application?.localizedName
                ?? "Unknown"
            let onScreen = (entry[kCGWindowIsOnscreen as String] as? Bool) ?? false
            let title = (entry[kCGWindowName as String] as? String).flatMap { $0.isEmpty ? nil : $0 }
            guard Self.isUserWindow(
                title: title,
                frame: frame,
                pid: ownerPid,
                application: application
            ) else { continue }
            /*
              Off screen is three different facts, and reporting them as one is
              what put an app in the claim picker twice.

              `kCGWindowIsOnscreen` is false for a minimized window, for a
              hidden app's windows, AND for the surfaces an app keeps at layer 0
              that are not windows at all: the full-desktop-width 30px menu bar
              strip it publishes once per display, and its 500x500 / 64x64
              scratch planes. Those pass `isUserWindow` (their owner is a
              `.regular` app) and used to be listed as extra untitled
              "minimized" rows of the same app — a second Activity Monitor, a
              second Music, three Grok Bots.

              The Accessibility API is the one list that contains only real
              windows, so an off-screen entry has to appear there to survive,
              and its `AXMinimized` — not the window server's visibility — is
              what "minimized" means. An app that cannot be read through AX at
              all keeps the old reading, because an empty picker is worse than
              an over-full one.
            */
            var minimized = false
            if !onScreen {
                let state: [CGWindowID: Bool]?
                if let cached = axStateByPid[ownerPid] {
                    state = cached
                } else {
                    state = axWindowMinimizedState(pid: ownerPid)
                    axStateByPid[ownerPid] = state
                }
                if let state {
                    guard let isMinimized = state[windowId] else { continue }
                    minimized = isMinimized
                } else {
                    minimized = true
                }
            }
            // A window this lane does not own, and that is not on screen, is
            // not on this desktop — whatever its last frame says. Listing it
            // filled the Apps list with rows for windows nobody could see:
            // four untitled "minimized" Tailscale rows and four Messages, for
            // a display showing one Finder window. An OWNED window keeps its
            // minimized row, because ADE parked it here and the person can
            // still release it.
            if let laneId, ownedBy != laneId, minimized { continue }
            var iconPng: String?
            let iconKey = bundleId ?? appName
            if !iconSentFor.contains(iconKey),
               let icon = appIconBase64(bundleId: bundleId, application: application) {
                iconSentFor.insert(iconKey)
                iconPng = icon
            }
            windows.append(
                DesktopWindow(
                    id: windowId,
                    pid: ownerPid,
                    appName: appName,
                    bundleId: bundleId,
                    title: title,
                    frame: frame,
                    laneId: ownedBy,
                    origin: origins[windowId] ?? "adopted",
                    onDisplayId: displayId(containing: frame),
                    minimized: minimized,
                    singleInstance: Self.isSingleInstance(bundleId: bundleId, application: application),
                    iconPng: iconPng
                )
            )
        }
        return windows.sorted { $0.id < $1.id }
    }

    /// The app's icon as a 32x32 base64 PNG, cached by bundle id.
    ///
    /// `.regular` apps only: an agent or a view service has no icon a person
    /// would recognise, and the list does not show those as apps anyway.
    func appIconBase64(bundleId: String?, application: NSRunningApplication?) -> String? {
        guard let bundleId, let application, application.activationPolicy == .regular else { return nil }
        lock.lock()
        defer { lock.unlock() }
        if let cached = iconCache[bundleId] { return cached }
        let encoded = application.bundleURL.flatMap {
            Self.pngBase64(icon: NSWorkspace.shared.icon(forFile: $0.path), side: 32)
        }
        iconCache[bundleId] = encoded
        return encoded
    }

    /// Draw an `NSImage` at a fixed size and encode it as PNG.
    ///
    /// Drawn into an explicit `NSBitmapImageRep` rather than through
    /// `lockFocus()`: that one needs a window server context on the calling
    /// thread, and this runs wherever a `window.list` request was dispatched.
    static func pngBase64(icon: NSImage, side: Int) -> String? {
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: side,
            pixelsHigh: side,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        icon.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])?.base64EncodedString()
    }

    /// One app's real windows, and which of them are minimized.
    ///
    /// `nil` — not an empty dictionary — when the app cannot be read: no
    /// Accessibility trust, an app that publishes no `AXWindows`, an app that
    /// stopped answering, or a system without the private `CGWindowID` bridge. The caller must treat that as
    /// "no opinion" and keep the window server's answer, because a `nil` read
    /// mistaken for "this app has no windows" hides every window it owns.
    private func axWindowMinimizedState(pid: pid_t) -> [CGWindowID: Bool]? {
        guard AXWindowBridge.isAvailable else { return nil }
        guard let elements = axWindowElements(pid: pid),
              !elements.isEmpty
        else { return nil }
        var state: [CGWindowID: Bool] = [:]
        for element in elements {
            guard let id = AXWindowBridge.windowId(of: element) else { continue }
            var minimizedValue: CFTypeRef?
            AXUIElementSetMessagingTimeout(element, AXTimeouts.walkRead)
            let read = AXUIElementCopyAttributeValue(element, kAXMinimizedAttribute as CFString, &minimizedValue)
            if AXCallResult.classify(rawError: read.rawValue) == .timedOut {
                noteStall(pid: pid, during: "reading a window's minimized state")
                return nil
            }
            state[id] = read == .success && (minimizedValue as? Bool ?? false)
        }
        // Every element answered without an id is the bridge failing on this
        // app rather than the app having no windows.
        return state.isEmpty ? nil : state
    }

    /// Whether a CoreGraphics entry is a window a person could point at.
    ///
    /// `CGWindowListCopyWindowInfo` answers with everything the window server
    /// knows, and on a normal Mac most of that is not a window: XPC view
    /// services (`CursorUIViewService` alone contributed thirteen rows to the
    /// claim picker), zero-size scratch surfaces, and windows belonging to a
    /// process that has since exited. Three rules cut them:
    ///
    /// * the owner must still be running — a dead pid's window can never be
    ///   claimed, only fail;
    /// * the window must have a size — a 0x0 surface is bookkeeping;
    /// * it must either carry a title or belong to a `.regular` app. An
    ///   accessory or prohibited process (a view service, an agent) with no
    ///   title has nothing a user would recognise in a list.
    static func isUserWindow(
        title: String?,
        frame: CGRect,
        pid: pid_t,
        application: NSRunningApplication?
    ) -> Bool {
        if let application {
            if application.isTerminated { return false }
        } else if kill(pid, 0) != 0 {
            return false
        }
        if frame.width <= 0 || frame.height <= 0 { return false }
        if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        return application?.activationPolicy == .regular
    }

    /// One window by id. Scoped to that id, so the lookup reads only its
    /// own app through Accessibility, and only when it is off screen.
    func window(withId windowId: CGWindowID) -> DesktopWindow? {
        listWindows(windowIds: [windowId]).first
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

    /// An app's `AXWindows`, read with the walk's short timeout, or nil.
    ///
    /// Every lookup of a window by id starts here, from the watcher's sweep to
    /// `observe`, so this is where a stalled app is noticed and then skipped:
    /// the read is not even attempted while the app is cooling down, and a read
    /// that times out puts it there. Without that, a sweep every second paid a
    /// full timeout per window of a stalled app on the main thread.
    func axWindowElements(pid: pid_t) -> [AXUIElement]? {
        if stalls.isStalled(pid: pid) { return nil }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, AXTimeouts.walkRead)
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value)
        if AXCallResult.classify(rawError: result.rawValue) == .timedOut {
            noteStall(pid: pid, during: "reading its windows")
            return nil
        }
        guard result == .success, let elements = value as? [AXUIElement] else { return nil }
        return elements
    }

    /// Records a stall, and logs it only when it is new.
    func noteStall(pid: pid_t, during activity: String) {
        guard stalls.noteStall(pid: pid) else { return }
        let appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid \(pid)"
        log("\(appName) did not answer accessibility within \(AXTimeouts.walkRead)s while \(activity); skipping it for \(Int(stalls.cooldown))s")
    }

    func axWindow(for window: DesktopWindow) -> AXUIElement? {
        guard let elements = axWindowElements(pid: window.pid) else { return nil }

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

    /// `axWindow`, but patient.
    ///
    /// A window appears in `CGWindowListCopyWindowInfo` before its application
    /// has published it to the Accessibility API. The pid watcher looks exactly
    /// in that gap — a new TextEdit document was seen roughly 200 ms before it
    /// had an element — so a single failed lookup means "not yet", not "not
    /// permitted". Retrying on `WindowReadiness.backoffMs` closes the race; the
    /// failure that survives it is classified, so a slow app never produces a
    /// permission error the user cannot act on.
    func axWindowWhenReady(for window: DesktopWindow) -> Result<AXUIElement, WindowReadinessFailure> {
        var attempt = 0
        while let delay = WindowReadiness.delaySeconds(beforeAttempt: attempt) {
            // A stalled app is not a slow one: every retry would pay the same
            // timeout again. "Not ready" keeps it on the watch list, and the
            // next sweep after the cooldown tries again.
            if stalls.isStalled(pid: window.pid) { return .failure(.notReady) }
            if delay > 0 {
                // The run loop keeps turning: the app publishing the window is
                // answering on the main thread too, and sleeping outright would
                // starve the very work being waited for.
                RunLoop.current.run(until: Date().addingTimeInterval(delay))
            }
            if let element = axWindow(for: window) {
                if attempt > 0 {
                    log("window \(window.id) became reachable on attempt \(attempt + 1)")
                }
                return .success(element)
            }
            attempt += 1
        }
        return .failure(WindowReadinessFailure.classify(isProcessTrusted: AXIsProcessTrusted()))
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
        if let refusal = stopGate.refusal(laneId: laneId, action: "take a window") { throw refusal }
        guard let placementAtStart = lanePlacement(forLane: laneId) else {
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
        // A window of an app another lane launched is that lane's: its stop
        // quits the app, and the window with it.
        if let refusal = launchedApps.refusal(pid: window.pid, laneId: laneId, appName: window.appName) {
            throw refusal
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

        let element: AXUIElement
        switch axWindowWhenReady(for: window) {
        case .success(let resolved):
            element = resolved
        case .failure(let failure):
            // The wait pumped the run loop, so the same re-check as the
            // success path decides whose hold this is. Still this park's own
            // (it proceeds): drop it, the window never moved. A stop, a
            // release or a later take of this lane inside the wait: leave the
            // hold to them, or `releaseLane` never sees the window.
            switch ParkRecheck.decide(
                laneId: laneId,
                windowId: Int(windowId),
                ownerNow: ownership.owner(ofWindow: Int(windowId)),
                placementAtStart: placementAtStart,
                placementNow: lanePlacement(forLane: laneId),
                isStopping: stopGate.isStopping(laneId)
            ) {
            case .proceed:
                _ = forgetParked(windowId: windowId)
            case .refuse(_, let dropHold):
                if dropHold { _ = forgetParked(windowId: windowId) }
            }
            throw failure.driverError(windowId: Int(windowId))
        }
        // The wait pumped the run loop, and a stop, a release, another lane's
        // claim or a stop-and-start of this lane can have run inside it. The
        // frame and the display id both come from the placement read here.
        let current: LanePlacement
        switch ParkRecheck.decide(
            laneId: laneId,
            windowId: Int(windowId),
            ownerNow: ownership.owner(ofWindow: Int(windowId)),
            placementAtStart: placementAtStart,
            placementNow: lanePlacement(forLane: laneId),
            isStopping: stopGate.isStopping(laneId)
        ) {
        case .proceed(let placementNow):
            current = placementNow
        case .refuse(let error, let dropHold):
            if dropHold { forgetParked(windowId: windowId) }
            throw error
        }
        let placement = current.placement
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
        parked.onDisplayId = current.displayId
        startWatching(pid: window.pid, laneId: laneId, launched: launchedApps.isLaunched(pid: window.pid, byLane: laneId))
        newWindows.noteParked(pid: window.pid, windowId: windowId)
        emitWindowsChanged(laneId: laneId)
        return parked
    }

    /// What `release` gave back to the user.
    struct ReleaseResult {
        /// The window that was asked for, where it is now, or nil when it
        /// had already ended.
        var window: DesktopWindow?
        /// Every window that left the lane: the one asked for, and for a
        /// launched app every other window of that instance.
        var releasedWindowIds: [CGWindowID]
        /// The launched app instance the user now owns, if the release handed
        /// one over. The lane no longer watches it and `stop` never quits it.
        var handedOverPid: pid_t?
    }

    /// Releases one window of a lane: the `window.unpark` request, the pane's
    /// Release button, and a window that keeps leaving the lane's display.
    ///
    /// A window of an app the lane launched hands the whole instance to the
    /// user (see `WindowRelease`). The pid leaves the watch and the launched
    /// set BEFORE its windows move, because the move fires the app's
    /// `AXObserver`, and a sweep in between would park them again. A window
    /// the user claimed goes back alone, and its app stops being watched when
    /// the lane holds none of its other windows. Nil when no lane holds the
    /// window.
    @discardableResult
    func release(windowId: CGWindowID) -> ReleaseResult? {
        guard let record = ownership.ownership(ofWindow: Int(windowId)) else { return nil }
        let laneId = record.laneId
        guard let window = window(withId: windowId) else {
            // The window ended; only the hold on it is left to drop.
            forgetParked(windowId: windowId)
            emitWindowsChanged(laneId: laneId)
            return ReleaseResult(window: nil, releasedWindowIds: [windowId], handedOverPid: nil)
        }
        let pid = window.pid
        let otherWindowsHeld = listWindows(pid: pid)
            .filter { $0.id != windowId && $0.laneId == laneId }
            .count
        let plan = WindowRelease.plan(
            launchedByLane: launchedApps.isLaunched(pid: pid, byLane: laneId),
            otherWindowsHeld: otherWindowsHeld
        )
        switch plan {
        case .handOverApp:
            stopWatching(pid: pid)
            launchedApps.forget(pid: pid)
            var released = moveWindowsToMainScreen(pid: pid, laneId: laneId)
            if !released.contains(windowId) {
                // Not in the pid's listing any more (it ended between the two
                // reads): the hold still goes.
                forgetParked(windowId: windowId)
                released.insert(windowId, at: 0)
            }
            log("released \(window.appName) (pid \(pid)) to the user with \(released.count) window(s); lane \(laneId) no longer watches or quits it")
            emitWindowsChanged(laneId: laneId)
            var now = self.window(withId: windowId) ?? window
            now.laneId = nil
            return ReleaseResult(window: now, releasedWindowIds: released, handedOverPid: pid)
        case .returnWindow(let stopWatchingApp):
            let original = forgetParked(windowId: windowId)
            var returned = window
            if let element = axWindow(for: window) {
                let target = homeFrame(for: window, original: original, laneId: laneId)
                Self.unminimize(element, if: window.minimized)
                _ = Self.setFrame(element, target)
                returned.frame = Self.frame(of: element) ?? target
            }
            if stopWatchingApp, newWindows.laneId(forPid: pid) == laneId {
                stopWatching(pid: pid)
            }
            returned.laneId = nil
            returned.minimized = false
            returned.onDisplayId = displayId(containing: returned.frame)
            emitWindowsChanged(laneId: laneId)
            return ReleaseResult(window: returned, releasedWindowIds: [windowId], handedOverPid: nil)
        }
    }

    /// Drops the lane's hold on a window and the driver's notes about it.
    /// Returns the frame the window had when it was parked, if known.
    @discardableResult
    private func forgetParked(windowId: CGWindowID) -> CGRect? {
        ownership.unpark(windowId: Int(windowId))
        lock.lock()
        defer { lock.unlock() }
        reparkAttempts.removeValue(forKey: windowId)
        windowOrigins.removeValue(forKey: windowId)
        return originalFrames.removeValue(forKey: windowId)
    }

    /// Where a released window goes: back to the real screen it was claimed
    /// from, or else the top left of the main screen.
    ///
    /// Release means "put it back on my screen", so a frame that is still on
    /// the lane's display is no destination at all. `originalFrames` records
    /// where a window was when it was PARKED, and an app that ADE opened for
    /// the lane was already on the lane's display at that moment. Restoring
    /// that frame moved the window from where it was to exactly where it was,
    /// which is why the button looked dead.
    private func homeFrame(for window: DesktopWindow, original: CGRect?, laneId: String) -> CGRect {
        lock.lock()
        let laneDisplay = displayIds[laneId]
        lock.unlock()
        if let original {
            let host = displayId(containing: original)
            if host != nil, host != laneDisplay { return original }
        }
        let main = Self.mainScreenPlacement()
        return Geometry.cascadeFrame(
            index: 0,
            size: CGSize(width: min(window.frame.width, main.width), height: min(window.frame.height, main.height)),
            display: main
        )
    }

    static func mainScreenPlacement() -> DisplayPlacement {
        let bounds = CGDisplayBounds(CGMainDisplayID())
        return DisplayPlacement(origin: bounds.origin, width: bounds.width, height: bounds.height, scale: 1)
    }

    /// A released window comes back where the user can see it. A minimized
    /// window cannot be moved at all: its frame stays where it was, and it
    /// came back as a Dock tile rather than a window.
    static func unminimize(_ element: AXUIElement, if minimized: Bool) {
        guard minimized else { return }
        AXUIElementSetAttributeValue(element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }

    /// Returns every window a lane still holds to the user's screen. Runs
    /// when the lane's display goes away, after its launched apps quit, so
    /// what is left is windows the user claimed and the windows of any app
    /// that could not be quit.
    @discardableResult
    func releaseLane(_ laneId: String) -> Int {
        let held = ownership.windows(forLane: laneId)
        let live = Dictionary(
            listWindows(windowIds: Set(held.map { CGWindowID($0.windowId) })).map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        for record in held {
            let windowId = CGWindowID(record.windowId)
            let original = forgetParked(windowId: windowId)
            guard let window = live[windowId], let element = axWindow(for: window) else { continue }
            Self.unminimize(element, if: window.minimized)
            _ = Self.setFrame(element, homeFrame(for: window, original: original, laneId: laneId))
        }
        clearPlacement(laneId: laneId)
        return held.count
    }

    /// How long `stop` lets the lane's apps quit on their own before it
    /// force-quits the rest. A healthy app quits in well under a second; one
    /// that shows a save or confirm dialog never quits on its own.
    static let quitGrace: TimeInterval = 3

    /// How long a force quit gets to take effect before the app is reported
    /// as one that would not quit.
    static let forceQuitWait: TimeInterval = 1

    /// The grace period when the driver exits. Shorter than `quitGrace`: a
    /// client that restarts the driver sends SIGKILL two seconds after its
    /// SIGTERM (`RESTART_TERM_GRACE_MS`), and a kill in the middle of the
    /// wait would leave the lane's apps asked to quit but never forced.
    static let exitQuitGrace: TimeInterval = 1.5

    /// Quits every app instance the lane launched, and force-quits any that
    /// is still running after `quitGrace`.
    ///
    /// The rule for an intentional stop, and for the display going away for
    /// any other reason: everything the lane opened goes with it, unsaved
    /// work included. Every app the lane opens is a blank copy that holds only
    /// what was done on the lane, and a copy left on the user's screen after
    /// its lane is gone is an app nobody owns. Only instances in
    /// `launchedApps` are quit. An instance the user started is never quit,
    /// even when the lane claimed one of its windows, and an instance the user
    /// took with Release has left `launchedApps`.
    func quitLaunchedApps(laneId: String) -> LaneQuitReport {
        quit(apps: launchedApps.forgetLane(laneId), grace: Self.quitGrace)
    }

    /// Every lane's apps at once, for a driver that is exiting because ADE
    /// quit: one grace period for all of them, not one per lane.
    ///
    /// `duringGrace` runs after every app was asked to quit and before the
    /// wait, and its time counts against the grace. Shutdown finalises its
    /// recordings there: the client sends SIGKILL two seconds after SIGTERM,
    /// and finalising first pushed the force quit past that kill, which left
    /// an app with a save dialog on the user's screen after ADE was gone.
    func quitAllLaunchedApps(duringGrace: () -> Void = {}) -> LaneQuitReport {
        let lanes = Set(launchedApps.all.map(\.laneId))
        return quit(
            apps: lanes.sorted().flatMap { launchedApps.forgetLane($0) },
            grace: Self.exitQuitGrace,
            duringGrace: duringGrace
        )
    }

    private func quit(
        apps: [LaunchedAppRegistry.App],
        grace: TimeInterval,
        duringGrace: () -> Void = {}
    ) -> LaneQuitReport {
        guard !apps.isEmpty else {
            duringGrace()
            return .empty
        }
        var asked: [pid_t: NSRunningApplication] = [:]
        for app in apps {
            // Unwatched first: a save sheet or a last window the app shows
            // while it quits must not be parked again.
            stopWatching(pid: app.pid)
            guard let running = NSRunningApplication(processIdentifier: app.pid),
                  !running.isTerminated else { continue }
            asked[app.pid] = running
            if !running.terminate() {
                log("\(app.appName) (pid \(app.pid)) refused the request to quit")
            }
        }
        let graceEnds = Date().addingTimeInterval(grace)
        duringGrace()
        let isGone: (pid_t) -> Bool = { pid in
            (asked[pid]?.isTerminated ?? true) || kill(pid, 0) != 0
        }
        RunLoopPump.wait(
            until: { asked.keys.allSatisfy(isGone) },
            timeout: max(0, graceEnds.timeIntervalSinceNow)
        )
        let stayed = apps.filter { asked[$0.pid] != nil && !isGone($0.pid) }
        for app in stayed {
            log("\(app.appName) (pid \(app.pid)) did not quit within \(grace)s; force-quitting it")
            if asked[app.pid]?.forceTerminate() != true {
                // A raw kill is by pid, and the pid may have been reused
                // since the app was asked to quit: only the same app dies.
                let current = NSRunningApplication(processIdentifier: app.pid)
                guard app.isStillRunning(
                    currentBundleId: current?.bundleIdentifier,
                    isTerminated: current?.isTerminated ?? true,
                    hasProcess: current != nil
                ) else {
                    log("pid \(app.pid) is no longer \(app.appName); not sending it SIGKILL")
                    continue
                }
                kill(app.pid, SIGKILL)
            }
        }
        if !stayed.isEmpty {
            RunLoopPump.wait(until: { stayed.allSatisfy { isGone($0.pid) } }, timeout: Self.forceQuitWait)
        }
        let stillRunning = Set(asked.keys.filter { !isGone($0) })
        let report = LaneQuitReport.settle(
            apps: apps.filter { asked[$0.pid] != nil },
            stillRunning: stillRunning
        )
        // Not expected: a force quit ends any app this user may signal. An
        // app that survives it must not vanish with the display.
        for app in apps where stillRunning.contains(app.pid) {
            let moved = moveWindowsToMainScreen(pid: app.pid, laneId: app.laneId)
            log("\(app.appName) (pid \(app.pid)) survived a force quit; moved \(moved.count) window(s) to the main screen")
        }
        if !report.quit.isEmpty {
            log("quit \(report.quit.joined(separator: ", "))")
        }
        return report
    }

    /// Moves every window of `pid` that the lane holds or that sits on the
    /// lane's display to the user's main screen, and drops the lane's hold on
    /// them. Returns the windows that left the lane.
    @discardableResult
    func moveWindowsToMainScreen(pid: pid_t, laneId: String) -> [CGWindowID] {
        let main = Self.mainScreenPlacement()
        lock.lock()
        let laneDisplay = displayIds[laneId]
        lock.unlock()
        var left: [CGWindowID] = []
        var moved = 0
        for window in listWindows(pid: pid) {
            let owned = ownership.owner(ofWindow: Int(window.id)) == laneId
            guard owned || (laneDisplay != nil && window.onDisplayId == laneDisplay) else { continue }
            if owned { forgetParked(windowId: window.id) }
            left.append(window.id)
            guard let element = axWindow(for: window) else { continue }
            let size = CGSize(
                width: min(window.frame.width, main.width),
                height: min(window.frame.height, main.height)
            )
            Self.unminimize(element, if: window.minimized)
            if Self.setFrame(element, Geometry.cascadeFrame(index: moved, size: size, display: main)) {
                moved += 1
            }
        }
        return left
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

    func emitWindowsChanged(laneId: String) {
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
}
