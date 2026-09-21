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
    var watchedPids: [pid_t: String] = [:]
    var observers: [pid_t: AXObserver] = [:]
    var knownWindowsByPid: [pid_t: Set<CGWindowID>] = [:]
    var pollTimer: Timer?
    private var placements: [String: DisplayPlacement] = [:]
    private var displayIds: [String: CGDirectDisplayID] = [:]
    let lock = NSRecursiveLock()

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
            let ownedBy = ownership.owner(ofWindow: Int(windowId))
            // A lane's list is what is ON its display, owned or not: a window
            // the user dragged there by hand is an app on that desktop too,
            // and the Apps list read "No apps" while Finder sat in the picture.
            // Ownership still decides what the driver may move or release.
            let boundsDict = entry[kCGWindowBounds as String] as? [String: Any]
            let frame = boundsDict.flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } ?? .zero
            if let laneId, ownedBy != laneId {
                guard let laneDisplay = displayIds[laneId],
                      displayId(containing: frame) == laneDisplay else { continue }
            }
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
                    origin: windowOrigins[windowId] ?? "adopted",
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
    /// Accessibility trust, an app that publishes no `AXWindows`, or a system
    /// without the private `CGWindowID` bridge. The caller must treat that as
    /// "no opinion" and keep the window server's answer, because a `nil` read
    /// mistaken for "this app has no windows" hides every window it owns.
    private func axWindowMinimizedState(pid: pid_t) -> [CGWindowID: Bool]? {
        guard AXWindowBridge.isAvailable else { return nil }
        let application = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
              let elements = value as? [AXUIElement],
              !elements.isEmpty
        else { return nil }
        var state: [CGWindowID: Bool] = [:]
        for element in elements {
            guard let id = AXWindowBridge.windowId(of: element) else { continue }
            var minimizedValue: CFTypeRef?
            let read = AXUIElementCopyAttributeValue(element, kAXMinimizedAttribute as CFString, &minimizedValue)
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

        let element: AXUIElement
        switch axWindowWhenReady(for: window) {
        case .success(let resolved):
            element = resolved
        case .failure(let failure):
            ownership.unpark(windowId: Int(windowId))
            throw failure.driverError(windowId: Int(windowId))
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
