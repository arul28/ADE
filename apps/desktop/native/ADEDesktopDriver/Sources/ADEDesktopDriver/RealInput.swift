/// The global pointer and keyboard. The one capability that can reach the user.
///
/// Everything in `AccessibilityDriver` is process-scoped. Everything here is
/// not: `CGEvent.post(tap:)` hands the event to the window server, which
/// delivers it to whatever is frontmost — possibly the user's own window, in the
/// middle of the user's own sentence. So every call here is gated on a lease,
/// and the gate is checked *in this file* rather than trusted to the caller.
///
/// That is not belt-and-braces for its own sake. The Node service is the policy
/// engine and will hold the authoritative lease, but the service is also the
/// thing most likely to have a bug, and a request line is trivially replayable.
/// The driver refuses on its own authority, so a lease-less post is impossible
/// rather than merely unlikely.

import AppKit
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

final class RealInput {
    private let leases: InputLeaseStore
    private let log: (String) -> Void
    /// HID source with suppression 0. A warp/post otherwise eats the next
    /// ~250ms of events — including the viewer's real mouse over ADE.
    private let hidSource: CGEventSource?
    /// Cancels a stale delayed restore when a later post starts its own.
    private var restoreGeneration: UInt64 = 0

    init(leases: InputLeaseStore, log: @escaping (String) -> Void) {
        self.leases = leases
        self.log = log
        let source = CGEventSource(stateID: .hidSystemState)
        source?.localEventsSuppressionInterval = 0
        self.hidSource = source
    }

    /// Where a MOUSE event goes: the HID tap, always.
    ///
    /// This file briefly posted mouse events to the pid under the point, to
    /// spare the user's own cursor the trip to the virtual display. It does
    /// spare it, and it also makes every click do nothing. A `CGEvent` built
    /// from `mouseCursorPosition` carries window number 0, and the window
    /// number is what AppKit resolves a mouse event's target window from. The
    /// HID tap goes through the window server, which hit-tests the point and
    /// fills that number in; `postToPid` hands the app the raw event, AppKit
    /// resolves window 0 to no window, and drops it. Keyboard events have no
    /// such field — they go to whatever is key — which is why typing kept
    /// working while clicking and dragging silently stopped.
    ///
    /// The cursor is put back by {@link posting} instead. That is the trade
    /// this feature actually has: a click that works and a pointer that is
    /// warped back within the same turn of the main queue.
    private func postMouse(_ event: CGEvent) {
        event.post(tap: .cghidEventTap)
    }

    /// Where a KEY event goes: to the lane's frontmost process when it has
    /// one. Safe here for the reason above — a keyboard event names no window,
    /// so delivering it straight to the app is exactly right, and it keeps the
    /// keystroke off whatever is frontmost on the user's own screen.
    private func postKey(_ event: CGEvent, to pid: pid_t?) {
        if let pid {
            event.postToPid(pid)
        } else {
            event.post(tap: .cghidEventTap)
        }
    }

    /// Where the user's own pointer was when a takeover began, per lane.
    ///
    /// A takeover drives the lane's display with the one system cursor, so
    /// every posted event moves the person's real pointer there. Warping it
    /// home after each event — which is what this file used to do — costs four
    /// `CGWarpMouseCursorPosition` calls and three main-queue hops per event,
    /// and a wheel turn is twenty events: that is where "the scroll arrives
    /// five seconds later" came from. It also loses the race constantly, which
    /// is how the pointer ended up stranded on the lane's display with the
    /// local glyph frozen where it was abandoned.
    ///
    /// So a takeover holds instead: the position is saved once, the cursor is
    /// left on the lane's display for the whole session, and it is put back
    /// once when the person gives control back. The viewer locks its own
    /// pointer for the duration, so there is no second cursor to fight.
    private var cursorHold: [String: CGPoint] = [:]

    /// Saves the pointer's home, once per takeover. Later calls are no-ops.
    func beginCursorHold(laneId: String) {
        guard cursorHold[laneId] == nil, let saved = quartzCursorLocation() else { return }
        cursorHold[laneId] = saved
    }

    /// True while this lane is driving with the cursor held.
    func isHoldingCursor(laneId: String) -> Bool { cursorHold[laneId] != nil }

    /// Puts the pointer back where the takeover found it.
    func endCursorHold(laneId: String, holderId: String?) throws {
        try authorize(laneId: laneId, holderId: holderId)
        guard let saved = cursorHold.removeValue(forKey: laneId) else { return }
        warpCursorBack(to: saved)
    }

    /// Drops a hold without warping. For a lane whose display is going away.
    func forgetCursorHold(laneId: String) { cursorHold.removeValue(forKey: laneId) }

    /// The panic release. Escape in the viewer, a closing pane, a lost socket.
    ///
    /// Unconditional, which is the whole difference from `endCursorHold`: that
    /// one returns immediately unless a cursor hold was started, and a desktop
    /// takeover never starts one, so the path that most needs a way out did
    /// nothing at all. This always lifts the button and always warps.
    ///
    /// `button` is sent only when the viewer knows a press is outstanding, so
    /// this does not post mouse-ups nobody asked for. `home` is the viewer's
    /// own pointer in screen coordinates; only the viewing window knows where
    /// its person is, because the last warp may have left the cursor stranded
    /// on this lane's display.
    func releaseInput(
        laneId: String,
        holderId: String?,
        button: String?,
        home: CGPoint?
    ) throws {
        try authorizeRelease(laneId: laneId, holderId: holderId)
        let held = cursorHold.removeValue(forKey: laneId)
        if let button {
            let at = quartzCursorLocation() ?? .zero
            if button == "right" {
                if let up = CGEvent(
                    mouseEventSource: hidSource,
                    mouseType: .rightMouseUp,
                    mouseCursorPosition: at,
                    mouseButton: .right
                ) {
                    postMouse(up)
                }
            } else {
                releaseButton(at: at)
            }
            log("released a held \(button) button on lane \(laneId)")
        }
        // The viewer's own reading wins: it is measured on the machine the
        // person is actually looking at. The saved hold is the fallback for a
        // caller that cannot report one, such as a closing socket.
        if let destination = home ?? held {
            warpCursorBack(to: destination)
        }
    }

    /// The gate. Called first by every method below, and by nothing else.
    @discardableResult
    func authorize(laneId: String, holderId: String?, now: Date = Date()) throws -> InputLease {
        do {
            return try leases.authorize(laneId: laneId, holderId: holderId, now: now)
        } catch let error as InputLeaseError {
            log("refused real input on lane \(laneId): \(error.driverError.message)")
            throw error.driverError
        }
    }

    /// The gate for a release, which forgives a lapsed lease. See
    /// `InputLeaseStore.authorizeRelease`.
    @discardableResult
    func authorizeRelease(laneId: String, holderId: String?) throws -> InputLease {
        do {
            return try leases.authorizeRelease(laneId: laneId, holderId: holderId)
        } catch let error as InputLeaseError {
            log("refused a release on lane \(laneId): \(error.driverError.message)")
            throw error.driverError
        }
    }

    func move(
        laneId: String,
        holderId: String?,
        to point: CGPoint,
        restoreCursor: Bool = false
    ) throws {
        try authorize(laneId: laneId, holderId: holderId)
        try posting(restore: restoreCursor) {
            guard let event = CGEvent(
                mouseEventSource: hidSource,
                mouseType: .mouseMoved,
                mouseCursorPosition: point,
                mouseButton: .left
            ) else {
                throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a pointer event.")
            }
            postMouse(event)
        }
    }

    func click(
        laneId: String,
        holderId: String?,
        at point: CGPoint,
        button: String,
        count: Int,
        restoreCursor: Bool = false
    ) throws {
        try authorize(laneId: laneId, holderId: holderId)
        try posting(restore: restoreCursor) {
            let isRight = button.lowercased() == "right"
            let downType: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
            let upType: CGEventType = isRight ? .rightMouseUp : .leftMouseUp
            let mouseButton: CGMouseButton = isRight ? .right : .left
            for click in 1...max(1, min(3, count)) {
                guard let down = CGEvent(
                    mouseEventSource: hidSource,
                    mouseType: downType,
                    mouseCursorPosition: point,
                    mouseButton: mouseButton
                ),
                let up = CGEvent(
                    mouseEventSource: hidSource,
                    mouseType: upType,
                    mouseCursorPosition: point,
                    mouseButton: mouseButton
                ) else {
                    throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a click event.")
                }
                down.setIntegerValueField(.mouseEventClickState, value: Int64(click))
                up.setIntegerValueField(.mouseEventClickState, value: Int64(click))
                postMouse(down)
                postMouse(up)
            }
        }
    }

    /// A drag, which is the only call here that spans time.
    ///
    /// Between the `mouseDown` and the `mouseUp` the window server believes a
    /// button is held. The loop pumps the run loop between steps rather than
    /// sleeping, so other lanes keep being served — which also means the world
    /// can change underneath the gesture. Two things are therefore re-checked on
    /// every step rather than once at the top: the lease (it can lapse, or be
    /// handed to somebody else, mid-drag) and `verify`, which the caller uses to
    /// assert the lane still owns a display and the point is still on it.
    ///
    /// A failed check does not just throw. Throwing with the button still down
    /// would leave the whole machine in a held-button state that nothing later
    /// clears, so the mouse comes up at the last point reached first, and the
    /// error is raised after.
    ///
    /// Authorize and `verify` run *before* posting, so a bounds refusal never
    /// warps the pointer. Restore, when asked, wraps the whole gesture so the
    /// system cursor comes back even if a mid-drag check throws.
    func drag(
        laneId: String,
        holderId: String?,
        from: CGPoint,
        to: CGPoint,
        durationMs: Int,
        restoreCursor: Bool = false,
        verify: (CGPoint) -> DriverError? = { _ in nil }
    ) throws {
        try authorize(laneId: laneId, holderId: holderId)
        // Checked before the button goes down, so the common "that point is not
        // on this lane's display" mistake never starts a gesture at all.
        if let error = verify(from) { throw error }
        if let error = verify(to) { throw error }
        try posting(restore: restoreCursor) {
            let steps = max(2, min(60, durationMs / 16))
            guard let down = CGEvent(
                mouseEventSource: hidSource,
                mouseType: .leftMouseDown,
                mouseCursorPosition: from,
                mouseButton: .left
            ) else {
                throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a drag event.")
            }
            postMouse(down)
            var reached = from
            for step in 1...steps {
                let progress = CGFloat(step) / CGFloat(steps)
                let point = CGPoint(
                    x: from.x + (to.x - from.x) * progress,
                    y: from.y + (to.y - from.y) * progress
                )
                do {
                    try authorize(laneId: laneId, holderId: holderId)
                } catch {
                    releaseButton(at: reached)
                    log("drag on lane \(laneId) lost its lease mid-gesture; released the button")
                    throw error
                }
                if let error = verify(point) {
                    releaseButton(at: reached)
                    log("drag on lane \(laneId) left its display mid-gesture; released the button")
                    throw error
                }
                if let moved = CGEvent(
                    mouseEventSource: hidSource,
                    mouseType: .leftMouseDragged,
                    mouseCursorPosition: point,
                    mouseButton: .left
                ) {
                    postMouse(moved)
                    reached = point
                }
                // Pumped rather than slept: a 5-second drag on one lane must not
                // hold the health ping and every other lane's request behind it.
                // Every request in this driver is handled on this thread.
                RunLoopPump.wait(
                    until: { false },
                    timeout: Double(max(1, durationMs)) / 1000.0 / Double(steps)
                )
            }
            releaseButton(at: to)
        }
    }

    /// The button must come up even when the drag is being abandoned.
    private func releaseButton(at point: CGPoint) {
        guard let up = CGEvent(
            mouseEventSource: hidSource,
            mouseType: .leftMouseUp,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else { return }
        postMouse(up)
    }

    /// A scroll wheel at a point.
    ///
    /// The one real-input command this driver was missing. `scroll` existed
    /// only on the accessibility path, which walks the AX tree and scrolls an
    /// element; a person turning a wheel over the live view is not naming an
    /// element, so their every wheel turn was refused outright. Posted as a
    /// line-unit wheel event through the same tap a click takes, so it lands
    /// on whatever is under the point, exactly like a real wheel.
    ///
    /// `amount` is in lines and `direction` names the way the CONTENT moves,
    /// matching the accessibility path's vocabulary: "down" scrolls a page
    /// down, which on macOS is a negative wheel delta.
    func scroll(
        laneId: String,
        holderId: String?,
        at point: CGPoint,
        direction: String,
        amount: Int,
        restoreCursor: Bool = false
    ) throws {
        try authorize(laneId: laneId, holderId: holderId)
        let lines = Int32(max(1, min(50, amount)))
        let vertical: Int32
        let horizontal: Int32
        switch direction.lowercased() {
        case "up": (vertical, horizontal) = (lines, 0)
        case "down": (vertical, horizontal) = (-lines, 0)
        case "left": (vertical, horizontal) = (0, lines)
        case "right": (vertical, horizontal) = (0, -lines)
        default:
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\"\(direction)\" is not a scroll direction; use up, down, left or right."
            )
        }
        try posting(restore: restoreCursor) {
            // The wheel event carries no position of its own: it goes where the
            // pointer is. So the pointer is moved to the point first, and
            // `posting` puts the user's own cursor back afterwards.
            if let moved = CGEvent(
                mouseEventSource: hidSource,
                mouseType: .mouseMoved,
                mouseCursorPosition: point,
                mouseButton: .left
            ) {
                postMouse(moved)
            }
            guard let wheel = CGEvent(
                scrollWheelEvent2Source: hidSource,
                units: .line,
                wheelCount: 2,
                wheel1: vertical,
                wheel2: horizontal,
                wheel3: 0
            ) else {
                throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a scroll event.")
            }
            postMouse(wheel)
        }
    }

    /// A key press, posted to the session rather than to a process.
    ///
    /// Deliberately not pid-targeted, which is what the accessibility path in
    /// `AccessibilityDriver.press` does. A person driving the lane display has
    /// already decided what they are typing into by clicking on it: the first
    /// real click on a parked window makes that window key on the virtual
    /// display, exactly as a click does on any other screen, and every key that
    /// follows belongs to whatever is key right then — including a window the
    /// user raised with ⌘` or a sheet that opened over the one they clicked.
    /// Routing keys to the pid of the last resolved element instead would send
    /// them to the window the AX tree happened to name, which is the one thing
    /// the person at the keyboard did not ask for.
    func key(
        laneId: String,
        holderId: String?,
        key: String,
        modifiers: [String],
        targetPid: pid_t? = nil
    ) throws {
        try authorize(laneId: laneId, holderId: holderId)
        guard let keyCode = KeyCodes.code(for: key) else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\"\(key)\" is not a key this driver knows."
            )
        }
        let flags = KeyCodes.flags(for: modifiers)
        guard let down = CGEvent(keyboardEventSource: hidSource, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: hidSource, virtualKey: keyCode, keyDown: false)
        else {
            throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a key event.")
        }
        down.flags = flags
        up.flags = flags
        // To the lane's frontmost window's process when it has one: the HID
        // tap would hand the keystroke to whatever is frontmost on the user's
        // own screen, mid-sentence.
        postKey(down, to: targetPid)
        postKey(up, to: targetPid)
    }

    /// Text, posted to the session for the same reason `key` is: it goes to
    /// whatever is key on the lane's display, not to a pid this file guessed.
    func text(laneId: String, holderId: String?, text: String, targetPid: pid_t? = nil) throws {
        try authorize(laneId: laneId, holderId: holderId)
        for character in text {
            var utf16 = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: hidSource, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: hidSource, virtualKey: 0, keyDown: false)
            else { continue }
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            postKey(down, to: targetPid)
            postKey(up, to: targetPid)
        }
    }

    /// Posts the events, then puts the system cursor back where it was.
    ///
    /// A `CGEvent` with `mouseCursorPosition` teleports the ONE system pointer
    /// to that point. For a human driving the live view, that point is on the
    /// virtual display — so after the post the pointer is no longer over ADE
    /// and Electron stops seeing events. Saving the Quartz location first and
    /// warping back after is what keeps their mouse on the pane. The clicked
    /// window becoming key will try to pull the cursor onto that display a
    /// beat later, so the restore is repeated on the next turns of the main
    /// queue. Agent real-input leaves this off so the pointer stays where the
    /// action put it.
    private func posting(restore: Bool, _ body: () throws -> Void) rethrows {
        let saved = restore ? quartzCursorLocation() : nil
        defer {
            if let saved { warpCursorBack(to: saved) }
        }
        try body()
    }

    private func quartzCursorLocation() -> CGPoint? {
        let cocoa = NSEvent.mouseLocation
        let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens.first
        guard let height = primary?.frame.height, height > 0 else { return nil }
        return Geometry.quartzPoint(fromCocoa: cocoa, primaryHeight: height)
    }

    private func warpCursorBack(to point: CGPoint) {
        restoreGeneration += 1
        let generation = restoreGeneration
        let apply: () -> Void = { [weak self] in
            guard let self, self.restoreGeneration == generation else { return }
            CGWarpMouseCursorPosition(point)
            _ = CGAssociateMouseAndMouseCursorPosition(boolean_t(1))
        }
        apply()
        DispatchQueue.main.async(execute: apply)
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(32), execute: apply)
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(80), execute: apply)
    }
}
