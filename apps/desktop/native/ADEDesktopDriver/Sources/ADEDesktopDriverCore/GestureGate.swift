/// The one place a request can be told "not while the mouse button is down".
///
/// A real drag is the only operation in this driver that spans time *and* holds
/// global state: between `leftMouseDown` and `leftMouseUp` the window server
/// believes a button is held, and whatever window is under the pointer is being
/// dragged. The drag loop pumps the main run loop between steps (it must — every
/// request runs on that thread, and a 5-second drag that blocked it would hold
/// the health ping and every other lane behind it), and `perform(onThread:)`
/// delivers queued request lines in exactly the modes that pump runs. So without
/// a gate, a second lane's `input {mode:"real"}` posts a `mouseDown` on top of a
/// held button, a `display.destroy` yanks the display out from under the
/// gesture, and a `present` drags the same window somewhere else — all *inside*
/// the drag.
///
/// The gate is not a lock. Nothing is blocked and nothing spins: the hazardous
/// requests are parked in order and replayed the moment the button comes up, so
/// the caller sees a slightly later reply rather than a corrupted desktop.
/// Everything harmless — `ping`, `observe`, `window.list`, capture — keeps
/// answering, which is what makes the gate safe to hold for the length of a
/// human-scale gesture.
///
/// Pure on purpose: no AppKit, no CoreGraphics, no window server. The ordering
/// rules are the part that has to be right, so they are the part that is
/// testable without a screen.

import Foundation

public enum GestureGateDecision: Equatable, Sendable {
    /// Handle it now.
    case proceed
    /// Park it; it runs when the gesture ends.
    case deferred
    /// The parking lot is full. The caller is still owed a reply, so this
    /// carries the error to send rather than a silent drop.
    case rejected(DriverError)
}

/// The per-process "a real gesture is in flight" flag, plus the queue of
/// requests that had to wait for it.
public final class GestureGate: @unchecked Sendable {
    /// How many requests may pile up behind one gesture.
    ///
    /// A gesture is bounded (`drag` caps at 60 steps), so a healthy client puts
    /// a handful of lines here at most. A cap turns a client that is looping on
    /// `input` into a wave of refusals — which it can see — instead of unbounded
    /// memory and a drain that takes longer than the gesture did.
    public static let maxDeferred = 64

    private let lock = NSLock()
    private var activeLane: String?
    private var queue: [DriverRequest] = []

    public init() {}

    public var activeLaneId: String? {
        lock.lock()
        defer { lock.unlock() }
        return activeLane
    }

    public var isActive: Bool { activeLaneId != nil }

    public var deferredCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return queue.count
    }

    /// Marks a gesture as started. Throws rather than nesting: two overlapping
    /// gestures are exactly the corruption this type exists to prevent, and the
    /// dispatcher's own deferral should have made it unreachable.
    public func begin(laneId: String) throws {
        lock.lock()
        defer { lock.unlock() }
        if let activeLane {
            throw DriverError(
                code: DriverErrorCode.internalError,
                message: "A real gesture is already in flight on lane \(activeLane)."
            )
        }
        activeLane = laneId
    }

    /// Marks the gesture as finished. Idempotent, because it is called from the
    /// success path and from the failure path of the same `defer`.
    public func end() {
        lock.lock()
        defer { lock.unlock() }
        activeLane = nil
    }

    /// The whole rule.
    public func decide(_ request: DriverRequest) -> GestureGateDecision {
        lock.lock()
        let active = activeLane
        let queued = queue.count
        lock.unlock()
        guard let active else { return .proceed }
        guard Self.isHazardous(request, duringGestureOn: active) else { return .proceed }
        guard queued < Self.maxDeferred else {
            return .rejected(
                DriverError(
                    code: DriverErrorCode.internalError,
                    message: "Too many requests are waiting behind the real gesture on lane \(active)."
                )
            )
        }
        return .deferred
    }

    /// Which ops can disturb a gesture that is already holding the button.
    public static func isHazardous(_ request: DriverRequest, duringGestureOn laneId: String) -> Bool {
        switch request.knownOp {
        case .input:
            // Every `input`, not just the real ones, and not just this lane's:
            // an accessibility click on another lane can raise and focus a
            // window under the moving pointer just as effectively.
            return true
        case .destroyDisplay, .present:
            return request.string("laneId") == laneId
        case .unparkWindow:
            // `window.unpark` names a window, never a lane, so it cannot be
            // narrowed to the gesturing lane without a registry lookup this
            // type deliberately does not have. Deferring all of them for the
            // length of one gesture is the cheaper half of that trade.
            return true
        case .reconcileDisplays:
            // Harmless unless it is the sweep that would tear down the very
            // display the gesture is happening on.
            guard let live = request.stringArray("liveLaneIds") else { return false }
            return !live.contains(laneId)
        default:
            return false
        }
    }

    public func enqueue(_ request: DriverRequest) {
        lock.lock()
        defer { lock.unlock() }
        queue.append(request)
    }

    /// One at a time, in arrival order.
    ///
    /// Deliberately not "hand back the whole array": a parked request may itself
    /// be a drag, and replaying a batch would run the rest of it inside that new
    /// gesture — the exact thing the gate exists to stop. The drain loop checks
    /// `isActive` between every item.
    public func dequeue() -> DriverRequest? {
        lock.lock()
        defer { lock.unlock() }
        return queue.isEmpty ? nil : queue.removeFirst()
    }
}
