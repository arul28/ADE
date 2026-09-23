/// One private screen per lane, built out of CoreGraphics SPI.
///
/// `CGVirtualDisplay` and friends are not public API. They are reached through
/// `NSClassFromString` and never linked, so the day a macOS release drops them
/// this file reports `available: false` with a reason and the caller falls back
/// to parking windows outside the main display's visible frame. The fallback is
/// weaker and is reported as `offscreen-region`, never dressed up as a private
/// screen: a caller that believes it owns a screen it does not will type a
/// password onto the user's desk.
///
/// Ownership rule: ADE destroys only displays it created, tracked by the exact
/// `CGDirectDisplayID` it received at creation. BetterDisplay and similar tools
/// create their own virtual displays and are none of this driver's business.

import AppKit
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

/// Identifies an ADE-made display to a human reading Displays or Mission
/// Control, and to a future reconciliation pass.
enum VirtualDisplayIdentity {
    /// Fixed, ADE-flavoured, and deliberately not a real vendor's id.
    static let vendorID: UInt32 = 0x0000_ADE0
    static let productID: UInt32 = 0x0000_D15D
    /// Every ADE display's name starts with this. `macDesktopDisplayName` in
    /// `macDesktop.ts` produces the same prefix; the two must not drift.
    static let namePrefix = "ADE · "

    /// A stable per-lane serial, so two runs of the same lane look like the same
    /// monitor to anything that remembers monitors.
    static func serial(forLane laneId: String) -> UInt32 {
        var hash: UInt32 = 2_166_136_261
        for byte in laneId.utf8 {
            hash = (hash ^ UInt32(byte)) &* 16_777_619
        }
        // Keep it out of the low numbers real hardware likes to use.
        return hash | 0x0100_0000
    }
}

struct VirtualDisplayHandle {
    let laneId: String
    let name: String
    let displayId: CGDirectDisplayID
    let mode: String
    let placement: DisplayPlacement
    let createdAt: Date
    /// Nil in `offscreen-region` mode: there is no display object, only a rect.
    let display: NSObject?
}

enum VirtualDisplayHostError: Error {
    case unavailable(String)
}

final class VirtualDisplayHost {
    private let className = (
        display: "CGVirtualDisplay",
        descriptor: "CGVirtualDisplayDescriptor",
        settings: "CGVirtualDisplaySettings",
        mode: "CGVirtualDisplayMode"
    )

    private var handles: [String: VirtualDisplayHandle] = [:]
    private let lock = NSRecursiveLock()
    private let log: (String) -> Void

    /// Why the private API could not be used, once something has tried.
    private(set) var unavailableReason: String?

    /// Called on the main queue when the window server ends a lane's current
    /// display on its own. The handle is already gone by then.
    var onTerminated: ((String) -> Void)?

    init(log: @escaping (String) -> Void) {
        self.log = log
        self.unavailableReason = Self.probeReason(className: className)
    }

    private static func probeReason(
        className: (display: String, descriptor: String, settings: String, mode: String)
    ) -> String? {
        guard ObjCDynamic.isAvailable else {
            return "The Objective-C runtime message send could not be resolved."
        }
        var missing: [String] = []
        for name in [className.display, className.descriptor, className.settings, className.mode]
        where !ObjCDynamic.hasClass(name) {
            missing.append(name)
        }
        guard missing.isEmpty else {
            return "This macOS build has no \(missing.joined(separator: ", ")). "
                + "Virtual displays are unavailable; windows will be parked off-screen instead."
        }
        return nil
    }

    var isVirtualDisplayAvailable: Bool { unavailableReason == nil }

    /// What the host can do right now, in `MacDesktopDisplayMode` spelling.
    var displayMode: String {
        isVirtualDisplayAvailable ? "virtual" : "offscreen-region"
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    func handle(forLane laneId: String) -> VirtualDisplayHandle? {
        lock.lock()
        defer { lock.unlock() }
        return handles[laneId]
    }

    func all() -> [VirtualDisplayHandle] {
        lock.lock()
        defer { lock.unlock() }
        return handles.values.sorted { $0.createdAt < $1.createdAt }
    }

    /// Creates, or returns, the lane's display.
    ///
    /// Idempotent: two chats in one lane race to open the tab, and the second
    /// one is owed the first one's display rather than a second screen.
    func create(
        laneId: String,
        name: String,
        width: Int,
        height: Int,
        scale: Int
    ) -> VirtualDisplayHandle {
        lock.lock()
        defer { lock.unlock() }
        if let existing = handles[laneId] {
            return existing
        }
        let clampedScale = max(1, min(2, scale))
        if isVirtualDisplayAvailable,
           let handle = makeVirtualDisplay(
               laneId: laneId,
               name: name,
               width: width,
               height: height,
               scale: clampedScale
           )
        {
            handles[laneId] = handle
            return handle
        }
        let handle = makeOffscreenRegion(
            laneId: laneId,
            name: name,
            width: width,
            height: height,
            scale: clampedScale
        )
        handles[laneId] = handle
        return handle
    }

    @discardableResult
    func destroy(laneId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let handle = handles.removeValue(forKey: laneId) else { return false }
        // Releasing the last reference is what tears the display down; there is
        // no explicit `destroy` on the private class. Holding the object in a
        // local and letting it fall out of scope is the teardown.
        //
        // One subtlety, measured: the runtime-dispatched `initWithDescriptor:`
        // leaves an autoreleased reference behind, so the object dies when the
        // *creating* pool drains, not at the instant of that call. In this
        // process that pool is a run-loop iteration and has long since drained
        // by the time a lane is destroyed. A caller that creates and destroys a
        // display inside one pool — an XCTest method, say — has to drain it
        // itself or the display outlives the call.
        if handle.display != nil {
            log("destroyed virtual display \(handle.displayId) for lane \(laneId)")
        }
        return true
    }

    /// Destroys every display this process created whose lane is not in the
    /// live set.
    ///
    /// Best-effort by construction: a `CGVirtualDisplay` lives and dies with the
    /// process that created it, so a *previous* run's displays are already gone
    /// by the time anything could reconcile them. There is nothing to sweep
    /// after a crash, which is why this only ever walks `handles`.
    @discardableResult
    func reconcile(liveLaneIds: Set<String>) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        let stale = handles.keys.filter { !liveLaneIds.contains($0) }
        for laneId in stale {
            handles.removeValue(forKey: laneId)
        }
        if !stale.isEmpty {
            log("reconcile destroyed \(stale.count) display(s): \(stale.joined(separator: ", "))")
        }
        return stale.sorted()
    }

    /// The window server's termination handler.
    ///
    /// It used to only log, which left the handle in place: the driver kept
    /// answering for a display that no longer existed, and the service kept
    /// telling every client the lane had a screen. A display this process
    /// released itself has no handle by the time the handler runs, so a
    /// termination that follows our own destroy is a no-op here.
    private func displayTerminated(laneId: String, displayId: CGDirectDisplayID?) {
        lock.lock()
        let isCurrent = displayId != nil && handles[laneId]?.displayId == displayId
        if isCurrent { handles.removeValue(forKey: laneId) }
        lock.unlock()
        log("window server terminated virtual display \(displayId.map(String.init) ?? "?") for lane \(laneId)")
        if isCurrent { onTerminated?(laneId) }
    }

    func destroyAll() {
        lock.lock()
        defer { lock.unlock() }
        handles.removeAll()
    }

    // -----------------------------------------------------------------------
    // The private path
    // -----------------------------------------------------------------------

    private func makeVirtualDisplay(
        laneId: String,
        name: String,
        width: Int,
        height: Int,
        scale: Int
    ) -> VirtualDisplayHandle? {
        // `maxPixelsWide`/`High` is what the window server turns into the
        // display's *point* size, measured on macOS 27: a descriptor capped at
        // 2560 comes up as a 2560-point display whatever the mode says, and
        // `hiDPI` did not double the backing scale on this release. So the cap
        // is the requested working size, `hiDPI` is asked for in case a later
        // release honours it, and the scale that actually resulted is measured
        // rather than assumed. A lane asking for 2560x1440@2 therefore gets a
        // 2560x1440 desktop at whatever scale the system gave, and `scale` in
        // the reply says which.
        let pixelWidth = UInt32(max(1, width))
        let pixelHeight = UInt32(max(1, height))

        guard let descriptor = ObjCDynamic.makeInstance(className.descriptor) else {
            fail("\(className.descriptor) could not be instantiated.")
            return nil
        }
        ObjCDynamic.setProperty(descriptor, "name", name)
        ObjCDynamic.setProperty(descriptor, "maxPixelsWide", NSNumber(value: pixelWidth))
        ObjCDynamic.setProperty(descriptor, "maxPixelsHigh", NSNumber(value: pixelHeight))
        // A plausible physical size keeps the display out of the "unknown
        // monitor" bucket in Displays. 110 dpi-ish.
        let millimetresWide = Double(width) / 110.0 * 25.4
        let millimetresHigh = Double(height) / 110.0 * 25.4
        ObjCDynamic.setProperty(
            descriptor,
            "sizeInMillimeters",
            NSValue(size: CGSize(width: millimetresWide, height: millimetresHigh))
        )
        ObjCDynamic.setProperty(descriptor, "vendorID", NSNumber(value: VirtualDisplayIdentity.vendorID))
        ObjCDynamic.setProperty(descriptor, "productID", NSNumber(value: VirtualDisplayIdentity.productID))
        ObjCDynamic.setProperty(
            descriptor,
            "serialNum",
            NSNumber(value: VirtualDisplayIdentity.serial(forLane: laneId))
        )
        ObjCDynamic.setProperty(descriptor, "queue", DispatchQueue.main)
        // Filled in once the display has an id. The handler compares it with
        // the lane's current handle, so a late termination of a display this
        // lane already replaced cannot take the new one down with it.
        let createdDisplayId = ValueBox<CGDirectDisplayID>()
        let terminationHandler: @convention(block) (AnyObject?, AnyObject?) -> Void = { [weak self] _, _ in
            self?.displayTerminated(laneId: laneId, displayId: createdDisplayId.value)
        }
        ObjCDynamic.setProperty(descriptor, "terminationHandler", terminationHandler)

        guard let display = ObjCDynamic.makeInstance(
            className.display,
            initSelector: "initWithDescriptor:",
            argument: descriptor
        ) else {
            fail("\(className.display) refused initWithDescriptor:.")
            return nil
        }

        guard let settings = ObjCDynamic.makeInstance(className.settings) else {
            fail("\(className.settings) could not be instantiated.")
            return nil
        }
        guard let mode = ObjCDynamic.makeMode(
            className.mode,
            width: pixelWidth,
            height: pixelHeight,
            refreshRate: 60
        ) else {
            fail("\(className.mode) refused initWithWidth:height:refreshRate:.")
            return nil
        }
        ObjCDynamic.setProperty(settings, "modes", [mode])
        ObjCDynamic.setProperty(settings, "hiDPI", NSNumber(value: scale > 1 ? 1 : 0))

        guard let applied = ObjCDynamic.sendBool(display, selector: "applySettings:", argument: settings) else {
            fail("\(className.display) has no applySettings:.")
            return nil
        }
        guard applied else {
            fail("applySettings: refused \(pixelWidth)x\(pixelHeight)@60.")
            return nil
        }

        guard let displayId = ObjCDynamic.sendUInt32(display, selector: "displayID"), displayId != 0 else {
            fail("The virtual display came up without a display id.")
            return nil
        }
        createdDisplayId.set(displayId)

        // Everything reported back is measured, never assumed: `hiDPI` is a
        // request, and a display that came up at a different size or scale than
        // was asked for must say so rather than have the caller compute points
        // from a number the window server disagreed with.
        let bounds = Self.waitForDisplayBounds(displayId: displayId)
        let placement = DisplayPlacement(
            origin: bounds.origin,
            width: bounds.width > 0 ? bounds.width : CGFloat(width),
            height: bounds.height > 0 ? bounds.height : CGFloat(height),
            scale: Self.backingScale(displayId: displayId, fallback: CGFloat(scale))
        )
        log("created virtual display \(displayId) \"\(name)\" for lane \(laneId) at \(placement.origin)")
        return VirtualDisplayHandle(
            laneId: laneId,
            name: name,
            displayId: displayId,
            mode: "virtual",
            placement: placement,
            createdAt: Date(),
            display: display
        )
    }

    /// The window server publishes the new display asynchronously; asking for
    /// its bounds immediately answers `CGRect.zero` often enough to matter.
    private static func waitForDisplayBounds(
        displayId: CGDirectDisplayID,
        timeout: TimeInterval = 2.0
    ) -> CGRect {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let bounds = CGDisplayBounds(displayId)
            if bounds.width > 0, bounds.height > 0 {
                return bounds
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return CGDisplayBounds(displayId)
    }

    /// Pixels per point, as the window server actually built the display.
    private static func backingScale(displayId: CGDirectDisplayID, fallback: CGFloat) -> CGFloat {
        // The mode is published a moment after the bounds are, so this waits
        // rather than reporting the requested scale as if it were measured.
        let deadline = Date().addingTimeInterval(1)
        while Date() < deadline {
            if let mode = CGDisplayCopyDisplayMode(displayId) {
                let points = CGFloat(mode.width)
                let pixels = CGFloat(mode.pixelWidth)
                if points > 0, pixels > 0 { return pixels / points }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return fallback
    }

    private func fail(_ reason: String) {
        unavailableReason = reason
        log("virtual display unavailable: \(reason)")
    }

    // -----------------------------------------------------------------------
    // The honest fallback
    // -----------------------------------------------------------------------

    private func makeOffscreenRegion(
        laneId: String,
        name: String,
        width: Int,
        height: Int,
        scale: Int
    ) -> VirtualDisplayHandle {
        let mainBounds = CGDisplayBounds(CGMainDisplayID())
        let placement = Geometry.offscreenPlacement(
            mainVisibleFrame: mainBounds,
            width: CGFloat(width),
            height: CGFloat(height),
            scale: CGFloat(scale)
        )
        log(
            "lane \(laneId) is using the offscreen-region fallback at \(placement.origin): "
                + (unavailableReason ?? "no reason recorded")
        )
        return VirtualDisplayHandle(
            laneId: laneId,
            name: name,
            displayId: 0,
            mode: "offscreen-region",
            placement: placement,
            createdAt: Date(),
            display: nil
        )
    }
}

extension VirtualDisplayHandle {
    /// `MacDesktopDisplay`, field for field.
    func asJSON(windowCount: Int, lastActivityAt: Date) -> [String: JSONValue] {
        [
            "laneId": .string(laneId),
            "displayId": .int(Int(displayId)),
            "name": .string(name),
            "mode": .string(mode),
            "width": .int(Int(placement.width.rounded())),
            "height": .int(Int(placement.height.rounded())),
            "scale": .double(Double(placement.scale)),
            "origin": .object([
                "x": .double(Double(placement.origin.x)),
                "y": .double(Double(placement.origin.y)),
            ]),
            "createdAt": .string(ISO8601.string(createdAt)),
            "windowCount": .int(windowCount),
            "lastActivityAt": .string(ISO8601.string(lastActivityAt)),
        ]
    }
}

enum ISO8601 {
    private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    static func string(_ date: Date) -> String {
        formatter.string(from: date)
    }
}
