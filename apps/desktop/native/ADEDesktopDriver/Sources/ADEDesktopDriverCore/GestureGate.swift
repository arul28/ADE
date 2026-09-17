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
/// human-scale gesture. A parked request is still on somebody's 20-second
/// clock, so the queue is time-bounded too: anything that waited longer than
/// `deferredTTL` is answered with `deferred_expired` rather than executed into
/// a desktop that has moved on.
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

/// What the drain should do with one item it pulled off the parking lot.
public enum GestureGateDrainItem: Equatable, Sendable {
    /// Still fresh: run it.
    case run(DriverRequest)
    /// It sat behind the gesture longer than the client was willing to wait.
    /// The request is carried along so the caller can be answered on its `id`
    /// instead of being left to time out, and it is *not* executed: posting
    /// clicks at coordinates that were decided half a minute ago is worse than
    /// an explicit failure.
    case expired(DriverRequest, DriverError)
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

    /// How long a parked request stays worth running.
    ///
    /// Comfortably inside the Node client's 20-second request timeout: past
    /// this point the caller has either given up or is about to, and the world
    /// the request was aimed at (pointer position, window frames, element
    /// indices) is stale anyway.
    public static let deferredTTL: TimeInterval = 15

    private struct Parked {
        let request: DriverRequest
        let enqueuedAt: Date
    }

    private let lock = NSLock()
    private let now: @Sendable () -> Date
    private var activeLane: String?
    private var queue: [Parked] = []

    /// `now` is injectable so the expiry rule can be tested without sleeping.
    public init(now: @escaping @Sendable () -> Date = { Date() }) {
        self.now = now
    }

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
    ///
    /// Every `DriverOp` is named and there is no `default`, so adding an op is
    /// a compile error here rather than a silent promotion to "harmless" — the
    /// failure mode that let `window.park` (which ends in a `setFrame`) slip
    /// through while `window.unpark` was already deferred.
    public static func isHazardous(_ request: DriverRequest, duringGestureOn laneId: String) -> Bool {
        // Node is newer than this helper. The op will be answered with
        // `unknown_op` in a moment; holding it behind a gesture would only
        // delay that.
        guard let op = request.knownOp else { return false }
        switch op {
        case .input:
            // Every `input`, not just the real ones, and not just this lane's:
            // an accessibility click on another lane can raise and focus a
            // window under the moving pointer just as effectively.
            //
            // `wait` is the one exception, and it is not an exception because
            // it is harmless. Deferring it would park a request that blocks for
            // up to 120 s, holding every other parked request behind it long
            // past the client's timeout — so it is let through the gate and
            // refused outright at its own call site with `gesture_in_flight`
            // (see `waitRefusal`), because running it would pump the run loop
            // for its whole timeout while the button is still down.
            return request.string("command") != "wait"
        case .destroyDisplay, .present:
            return request.string("laneId") == laneId
        case .parkWindow, .unparkWindow:
            // Both end in a `setFrame` on a window this type cannot map back to
            // a lane without a registry lookup it deliberately does not have.
            // Deferring all of them for the length of one gesture is the
            // cheaper half of that trade.
            return true
        case .launch:
            // Launching or re-activating an app raises a window, which can land
            // under the moving pointer mid-drag. Any lane, same rationale as
            // park/unpark.
            return true
        case .reconcileDisplays:
            // Harmless unless it is the sweep that would tear down the very
            // display the gesture is happening on.
            guard let live = request.stringArray("liveLaneIds") else { return false }
            return !live.contains(laneId)
        case .health,
             .createDisplay,
             .listWindows,
             .observe,
             .setLease,
             .clearLease,
             .screenshot,
             .startStream,
             .setStreamRate,
             .stopStream,
             .startRecording,
             .stopRecording:
            // Read-only, or scoped to plumbing the window server does not route
            // through the pointer. These keep answering so a gesture never
            // looks like a hung driver.
            return false
        }
    }

    /// The answer a `wait` gets when it arrives mid-gesture, or `nil` when it
    /// is free to poll.
    ///
    /// `wait` is not deferred (parking a 120-second poll would strand the whole
    /// queue behind it), but it cannot run either: requests are dispatched on
    /// the main thread from inside the drag's own run-loop pump, so a wait that
    /// polls holds the pressed button for as long as it polls. Refusing is the
    /// only option that leaves the desktop and the queue intact, and the error
    /// is specific so the Node client can retry against its own deadline
    /// instead of surfacing a spurious "did not match".
    public func waitRefusal() -> DriverError? {
        guard let active = activeLaneId else { return nil }
        return DriverError(
            code: DriverErrorCode.gestureInFlight,
            message: "A real gesture is in flight on lane \(active); wait would hold the pressed button for its whole timeout."
        )
    }

    public func enqueue(_ request: DriverRequest) {
        lock.lock()
        defer { lock.unlock() }
        queue.append(Parked(request: request, enqueuedAt: now()))
    }

    /// One at a time, in arrival order.
    ///
    /// Deliberately not "hand back the whole array": a parked request may itself
    /// be a drag, and replaying a batch would run the rest of it inside that new
    /// gesture — the exact thing the gate exists to stop. The drain loop checks
    /// `isActive` between every item.
    public func dequeue() -> GestureGateDrainItem? {
        lock.lock()
        let parked = queue.isEmpty ? nil : queue.removeFirst()
        let stamp = now()
        lock.unlock()
        guard let parked else { return nil }
        let waited = stamp.timeIntervalSince(parked.enqueuedAt)
        guard waited <= Self.deferredTTL else {
            return .expired(
                parked.request,
                DriverError(
                    code: DriverErrorCode.deferredExpired,
                    message: "Request \(parked.request.id) waited \(Int(waited.rounded()))s behind a real gesture and was dropped instead of run."
                )
            )
        }
        return .run(parked.request)
    }
}
