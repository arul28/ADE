/// Keeps an unleased physical pointer on the real displays.
///
/// On this Mac, a relative HID move can cross a virtual display's shared corner
/// diagonally even though straight motion along either edge clamps. A listen-
/// only tap puts that hardware pointer back at the nearest real-screen point;
/// ADE's own tagged posts and active leases pass through unchanged.

import AppKit
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

final class PointerFence {
    private let shouldRedirect: (String?) -> Bool
    private let laneIdForDisplay: (CGDirectDisplayID) -> String?
    private let log: (String) -> Void
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var lastRealDisplayId: CGDirectDisplayID?
    private var lastFailureLogAt = Date.distantPast
    /// Lane displays the pointer may cross because a real display is cut off
    /// behind them. Read on every fenced event, so it is computed on display
    /// changes (`refreshRoutes`), never per event.
    private var routeDisplayIds: Set<CGDirectDisplayID> = []

    init(
        shouldRedirect: @escaping (String?) -> Bool,
        laneIdForDisplay: @escaping (CGDirectDisplayID) -> String?,
        log: @escaping (String) -> Void
    ) {
        self.shouldRedirect = shouldRedirect
        self.laneIdForDisplay = laneIdForDisplay
        self.log = log
    }

    func start() {
        guard eventTap == nil else { return }
        let types: [CGEventType] = [
            .mouseMoved,
            .leftMouseDragged,
            .rightMouseDragged,
            .otherMouseDragged,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        let callback: CGEventTapCallBack = { _, type, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            let fence = Unmanaged<PointerFence>.fromOpaque(context).takeUnretainedValue()
            return fence.handle(type: type, event: event)
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .tailAppendEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            log("pointer fence unavailable: macOS refused the listen-only event tap")
            return
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            log("pointer fence unavailable: could not create the event tap run-loop source")
            CFMachPortInvalidate(tap)
            return
        }
        eventTap = tap
        runLoopSource = source
        lastRealDisplayId = realDisplay(at: CGEvent(source: nil)?.location ?? .zero)?.first
        refreshRoutes()
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    func stop() {
        guard let source = runLoopSource, let tap = eventTap else { return }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: false)
        CFMachPortInvalidate(tap)
        runLoopSource = nil
        eventTap = nil
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent> {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
            logFailure("macOS disabled the pointer fence event tap; re-enabled it")
            return Unmanaged.passUnretained(event)
        }

        // The driver uses a HID event source for real input. Ignore our own pid
        // and the marker on posts from another ADE helper before inspecting the
        // cursor, so a takeover never fences itself.
        let sourcePid = pid_t(event.getIntegerValueField(.eventSourceUnixProcessID))
        let sourceState = event.getIntegerValueField(.eventSourceStateID)
        let isTaggedDriverPost = event.getIntegerValueField(.eventSourceUserData) == DriverPointerEventMarker.sourceUserData
            && sourceState == Int64(CGEventSourceStateID.hidSystemState.rawValue)
        guard sourcePid != getpid(), !isTaggedDriverPost else {
            return Unmanaged.passUnretained(event)
        }

        // A physical drag is fenced too: a window dragged onto a lane display
        // would be lost there with the pointer. Drags this driver posts were
        // let through above, and a lane's own lease or gesture is left alone by
        // `shouldRedirect`, so this only ever stops the person's own hand.
        let point = event.location
        let displays = displays(at: point)
        let realMatches = displays.filter { !isADEDisplay($0) }
        if let real = realMatches.first {
            lastRealDisplayId = real
            return Unmanaged.passUnretained(event)
        }
        guard let laneDisplayId = displays.first(where: isADEDisplay),
              shouldRedirect(laneIdForDisplay(laneDisplayId)),
              !routeDisplayIds.contains(laneDisplayId),
              let destination = nearestRealPoint(to: point)
        else {
            return Unmanaged.passUnretained(event)
        }

        // Offscreen-region fallback has no ADE display id, so it is never
        // caught by this path.
        let warp = CGWarpMouseCursorPosition(destination)
        if warp == .success {
            _ = CGAssociateMouseAndMouseCursorPosition(boolean_t(1))
        } else {
            logFailure("pointer fence could not return the cursor to a real display (CGError \(warp.rawValue))")
        }
        return Unmanaged.passUnretained(event)
    }

    /// Recomputes which lane displays stand between the person and one of
    /// their screens. While any do, the fence lets the pointer cross them
    /// rather than trap it; the placement pass moves that screen back, which
    /// empties the set. Main queue, like the tap.
    func refreshRoutes() {
        let route = DisplayLayout.current().laneDisplaysOnRouteToCutOffRealDisplays()
        if route != routeDisplayIds, !route.isEmpty {
            let names = route.sorted().map(String.init).joined(separator: ", ")
            log("lane display \(names) is the only way to reach one of the user's screens; the pointer may cross it")
        }
        routeDisplayIds = route
    }

    private func nearestRealPoint(to point: CGPoint) -> CGPoint? {
        let active = activeDisplays().filter { !isADEDisplay($0.id) }
        guard !active.isEmpty else {
            logFailure("pointer fence found no real display to return to")
            return nil
        }

        if let preferred = lastRealDisplayId,
           let display = active.first(where: { $0.id == preferred }) {
            return nearestInsidePoint(point, frame: display.frame)
        }

        let nearest = active.min { lhs, rhs in
            squaredDistance(point, nearestInsidePoint(point, frame: lhs.frame))
                < squaredDistance(point, nearestInsidePoint(point, frame: rhs.frame))
        }
        guard let nearest else { return nil }
        lastRealDisplayId = nearest.id
        return nearestInsidePoint(point, frame: nearest.frame)
    }

    private func nearestInsidePoint(_ point: CGPoint, frame: CGRect) -> CGPoint {
        guard frame.width > 2, frame.height > 2 else { return frame.origin }
        return CGPoint(
            x: min(max(point.x, frame.minX + 1), frame.maxX - 1),
            y: min(max(point.y, frame.minY + 1), frame.maxY - 1)
        )
    }

    private func realDisplay(at point: CGPoint) -> [CGDirectDisplayID]? {
        let matches = displays(at: point).filter { !isADEDisplay($0) }
        return matches.isEmpty ? nil : matches
    }

    private func displays(at point: CGPoint) -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        guard CGGetDisplaysWithPoint(point, UInt32(ids.count), &ids, &count) == .success else { return [] }
        return Array(ids.prefix(Int(count)))
    }

    private func activeDisplays() -> [(id: CGDirectDisplayID, frame: CGRect)] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { (id: $0, frame: CGDisplayBounds($0)) }
    }

    private func isADEDisplay(_ displayId: CGDirectDisplayID) -> Bool {
        VirtualDisplayIdentity.isADEDisplay(displayId)
    }

    private func squaredDistance(_ first: CGPoint, _ second: CGPoint) -> CGFloat {
        let dx = first.x - second.x
        let dy = first.y - second.y
        return dx * dx + dy * dy
    }

    private func logFailure(_ message: String) {
        let now = Date()
        guard now.timeIntervalSince(lastFailureLogAt) >= 5 else { return }
        lastFailureLogAt = now
        log(message)
    }
}
