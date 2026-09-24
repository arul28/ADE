/// The rules that keep one request from undoing another while a wait pumps
/// the run loop.
///
/// The driver handles every request on its main thread, and several waits
/// (a window becoming ready, an app launching or quitting, a capture
/// starting) pump the run loop so other lanes keep being answered. A second
/// request can run to completion inside that pump: a `display.destroy` can
/// finish while a `window.park` for the same lane waits, and when the park
/// resumes, the lane it was parking onto no longer exists. Every rule here is
/// a decision the resumed request makes before it acts, or a marker a stop
/// leaves so a request that starts during it is refused. No AppKit, so each
/// one is testable without a window server.

import Foundation

// ---------------------------------------------------------------------------
// Lanes being stopped
// ---------------------------------------------------------------------------

/// The lanes whose display is being torn down right now.
///
/// A stop quits the lane's apps and waits for them, so it pumps the run loop
/// for seconds. A `launch` that ran inside that wait started an app after
/// the stop had already collected the lane's apps to quit, and nothing ever
/// quit it. While a lane is here, `launch`, `park`, `stream.start` and
/// `record.start` for it are refused.
///
/// Counted rather than a set: a `display.destroy` can run inside a
/// `display.reconcile` that is stopping the same lane, and the inner stop
/// ending must not clear the outer one.
public final class LaneStopGate: @unchecked Sendable {
    private let lock = NSLock()
    private var stopping: [String: Int] = [:]

    public init() {}

    public func begin(_ laneId: String) {
        lock.lock()
        defer { lock.unlock() }
        stopping[laneId, default: 0] += 1
    }

    public func end(_ laneId: String) {
        lock.lock()
        defer { lock.unlock() }
        guard let count = stopping[laneId] else { return }
        if count <= 1 {
            stopping.removeValue(forKey: laneId)
        } else {
            stopping[laneId] = count - 1
        }
    }

    public func isStopping(_ laneId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopping[laneId] != nil
    }

    /// The refusal for starting `action` on a lane that is stopping, or nil.
    public func refusal(laneId: String, action: String) -> DriverError? {
        guard isStopping(laneId) else { return nil }
        return DriverError(
            code: DriverErrorCode.laneStopping,
            message: "Lane \(laneId) is stopping, so it cannot \(action). Start it again once the stop finishes."
        )
    }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/// Which requests a driver that is shutting down still runs.
///
/// Shutdown quits the lanes' apps and finalises recordings, and both pump the
/// run loop. A request that ran inside that pump could open an app or start a
/// capture that nothing would ever stop, so only `ping` is answered.
public enum RequestAdmission {
    public static func refusal(op: DriverOp?, isShuttingDown: Bool) -> DriverError? {
        guard isShuttingDown, op != .health else { return nil }
        return DriverError(
            code: DriverErrorCode.driverUnavailable,
            message: "The desktop driver is shutting down and takes no new requests."
        )
    }
}

// ---------------------------------------------------------------------------
// A park that waited
// ---------------------------------------------------------------------------

/// One lane's display as a park sees it.
///
/// `generation` is new every time the lane's display is set after being
/// cleared, so a display destroyed and made again (at the same place and size,
/// even with the same id) is not mistaken for the one a park started against.
public struct LanePlacement: Equatable, Sendable {
    public let placement: DisplayPlacement
    public let displayId: UInt32
    public let generation: UInt64

    public init(placement: DisplayPlacement, displayId: UInt32, generation: UInt64) {
        self.placement = placement
        self.displayId = displayId
        self.generation = generation
    }
}

/// What a park re-checks after waiting for its window to become ready.
///
/// The lane took the window before the wait. Inside the wait the lane can
/// stop (its display and its hold on the window both go), the window can be
/// released, the lane can start stopping, or its display can be replaced by
/// a new one. Moving the window and watching its app after any of those put a
/// window on a display that is gone, sized it for a display that is not the
/// lane's any more, or re-watched an app for a lane that no longer exists.
public enum ParkRecheck {
    public enum Outcome: Equatable, Sendable {
        /// Everything still holds: move the window onto this display (the
        /// lane's current one, which is the one the park started against).
        case proceed(LanePlacement)
        /// Refuse. `dropHold` is true when the lane still holds the window
        /// and nothing else will drop that hold (its display is gone);
        /// a stopping lane's own stop releases what it holds.
        case refuse(DriverError, dropHold: Bool)
    }

    public static func decide(
        laneId: String,
        windowId: Int,
        ownerNow: String?,
        placementAtStart: LanePlacement,
        placementNow: LanePlacement?,
        isStopping: Bool
    ) -> Outcome {
        if isStopping {
            return .refuse(
                DriverError(
                    code: DriverErrorCode.laneStopping,
                    message: "Lane \(laneId) started stopping while window \(windowId) was being parked; it was left where it was."
                ),
                dropHold: false
            )
        }
        guard ownerNow == laneId else {
            if let other = ownerNow {
                return .refuse(OwnershipError.windowOwnedByOtherLane(windowId: windowId, holderLaneId: other).driverError, dropHold: false)
            }
            return .refuse(
                DriverError(
                    code: DriverErrorCode.windowNotFound,
                    message: "Window \(windowId) was released from lane \(laneId) while it was being parked."
                ),
                dropHold: false
            )
        }
        guard let placementNow else {
            return .refuse(
                DriverError(
                    code: DriverErrorCode.noDisplay,
                    message: "Lane \(laneId) lost its display while window \(windowId) was being parked."
                ),
                dropHold: true
            )
        }
        guard placementNow == placementAtStart else {
            // The display went and a new one came inside the wait. Going away
            // released the lane's windows, so a hold the lane has now is a
            // later take's, and that take is not this park's to undo.
            return .refuse(
                DriverError(
                    code: DriverErrorCode.noDisplay,
                    message: "Lane \(laneId)'s display changed while window \(windowId) was being parked; it was left where it was."
                ),
                dropHold: false
            )
        }
        return .proceed(placementNow)
    }

    /// Whether a sweep that got this refusal should stop working on the lane
    /// quietly: the lane is going or gone, which is not news about the window.
    public static func isLaneGone(code: String?) -> Bool {
        code == DriverErrorCode.laneStopping || code == DriverErrorCode.noDisplay
    }
}

// ---------------------------------------------------------------------------
// Capture starts
// ---------------------------------------------------------------------------

/// The lanes whose stream (or recording) is starting.
///
/// A capture start waits seconds for ScreenCaptureKit with the run loop
/// pumping. Before this marker, a `stream.stop` inside that wait found nothing
/// to stop and the start then installed a stream for a stopped lane, and a
/// second start for the same lane ran its own capture and was overwritten by
/// the first, leaking its server and its capture session.
///
/// A second start for a lane that is already starting is refused rather than
/// made to wait: it runs nested inside the first start's pump, so the first
/// cannot finish until the second returns, and a wait would only ever time out.
public final class CaptureStartReservations: @unchecked Sendable {
    public final class Token: @unchecked Sendable {
        public let laneId: String
        fileprivate var cancelled = false

        fileprivate init(laneId: String) {
            self.laneId = laneId
        }
    }

    private let lock = NSLock()
    private var starting: [String: Token] = [:]

    public init() {}

    /// Marks the lane as starting. Nil when a start is already in flight.
    public func reserve(_ laneId: String) -> Token? {
        lock.lock()
        defer { lock.unlock() }
        guard starting[laneId] == nil else { return nil }
        let token = Token(laneId: laneId)
        starting[laneId] = token
        return token
    }

    public func isStarting(_ laneId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return starting[laneId] != nil
    }

    /// A stop arrived while the lane was starting. The start sees this when it
    /// resumes and tears down what it built. True when there was a start.
    @discardableResult
    public func cancel(_ laneId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let token = starting.removeValue(forKey: laneId) else { return false }
        token.cancelled = true
        return true
    }

    /// Cancels every start in flight, for a driver that is shutting down.
    public func cancelAll() {
        lock.lock()
        defer { lock.unlock() }
        for token in starting.values { token.cancelled = true }
        starting.removeAll()
    }

    public func isCancelled(_ token: Token) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return token.cancelled
    }

    /// Ends the start. True when it may install what it built: nobody
    /// cancelled it. Removes the marker either way.
    @discardableResult
    public func finish(_ token: Token) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if starting[token.laneId] === token {
            starting.removeValue(forKey: token.laneId)
        }
        return !token.cancelled
    }

    public static func alreadyStarting(laneId: String, what: String) -> DriverError {
        DriverError(
            code: DriverErrorCode.captureStarting,
            message: "Lane \(laneId)'s \(what) is already starting. Try again once that start answers."
        )
    }
}
