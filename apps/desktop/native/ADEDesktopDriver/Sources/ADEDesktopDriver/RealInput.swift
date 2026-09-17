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

import CoreGraphics
import Foundation
import ADEDesktopDriverCore

final class RealInput {
    private let leases: InputLeaseStore
    private let log: (String) -> Void

    init(leases: InputLeaseStore, log: @escaping (String) -> Void) {
        self.leases = leases
        self.log = log
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

    func move(laneId: String, holderId: String?, to point: CGPoint) throws {
        try authorize(laneId: laneId, holderId: holderId)
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else {
            throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a pointer event.")
        }
        event.post(tap: .cghidEventTap)
    }

    func click(
        laneId: String,
        holderId: String?,
        at point: CGPoint,
        button: String,
        count: Int
    ) throws {
        try authorize(laneId: laneId, holderId: holderId)
        let isRight = button.lowercased() == "right"
        let downType: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = isRight ? .rightMouseUp : .leftMouseUp
        let mouseButton: CGMouseButton = isRight ? .right : .left
        for click in 1...max(1, min(3, count)) {
            guard let down = CGEvent(
                mouseEventSource: nil,
                mouseType: downType,
                mouseCursorPosition: point,
                mouseButton: mouseButton
            ),
            let up = CGEvent(
                mouseEventSource: nil,
                mouseType: upType,
                mouseCursorPosition: point,
                mouseButton: mouseButton
            ) else {
                throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a click event.")
            }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
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
    func drag(
        laneId: String,
        holderId: String?,
        from: CGPoint,
        to: CGPoint,
        durationMs: Int,
        verify: (CGPoint) -> DriverError? = { _ in nil }
    ) throws {
        try authorize(laneId: laneId, holderId: holderId)
        // Checked before the button goes down, so the common "that point is not
        // on this lane's display" mistake never starts a gesture at all.
        if let error = verify(from) { throw error }
        if let error = verify(to) { throw error }
        let steps = max(2, min(60, durationMs / 16))
        guard let down = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDown,
            mouseCursorPosition: from,
            mouseButton: .left
        ) else {
            throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a drag event.")
        }
        down.post(tap: .cghidEventTap)
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
                mouseEventSource: nil,
                mouseType: .leftMouseDragged,
                mouseCursorPosition: point,
                mouseButton: .left
            ) {
                moved.post(tap: .cghidEventTap)
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

    /// The button must come up even when the drag is being abandoned.
    private func releaseButton(at point: CGPoint) {
        guard let up = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else { return }
        up.post(tap: .cghidEventTap)
    }

    func key(
        laneId: String,
        holderId: String?,
        key: String,
        modifiers: [String]
    ) throws {
        try authorize(laneId: laneId, holderId: holderId)
        guard let keyCode = KeyCodes.code(for: key) else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\"\(key)\" is not a key this driver knows."
            )
        }
        let flags = KeyCodes.flags(for: modifiers)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
        else {
            throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a key event.")
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    func text(laneId: String, holderId: String?, text: String) throws {
        try authorize(laneId: laneId, holderId: holderId)
        for character in text {
            var utf16 = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            else { continue }
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }
}
