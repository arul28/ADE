/// The bookkeeping behind the driver's first invariant: one request line in,
/// exactly one reply line out.
///
/// The dispatcher is synchronous, so in the ordinary case the invariant holds
/// by construction — `handle` returns or throws and either way a reply is
/// written. It stops holding the moment a request's work reaches a framework
/// that answers with a callback: ScreenCaptureKit, AVFoundation, `NSWorkspace`.
/// A completion handler that is never invoked, or a call that traps inside a
/// framework thread, leaves the caller's promise unsettled forever, which is
/// the one failure mode nobody can diagnose from the outside.
///
/// This type turns that into a bounded failure. Every dispatched request is
/// registered here; a watchdog asks for the overdue ones on a timer and answers
/// them with `internal_error`. Both the watchdog and the handler go through
/// `claim`, which hands the right to write the reply to whoever asks first, so
/// a handler that finishes late is silent rather than duplicating a reply and
/// desynchronising the client's id map.
///
/// Nothing here imports AppKit or knows what a display is: the timer, the clock
/// and the writer are all the caller's, which is what makes the rule testable
/// without a window server.

import Foundation

/// A request that has been dispatched but has not produced a reply.
public struct OverdueRequest: Equatable, Sendable {
    public let id: String
    public let op: String
    /// How long it had been running when the watchdog gave up on it.
    public let elapsed: TimeInterval

    public init(id: String, op: String, elapsed: TimeInterval) {
        self.id = id
        self.op = op
        self.elapsed = elapsed
    }

    /// The reply the watchdog writes. Phrased as what the driver observed
    /// rather than as a guess about why, because the cause lives inside a
    /// framework this process cannot see into.
    public var driverError: DriverError {
        DriverError(
            code: DriverErrorCode.internalError,
            message: "\(op) did not complete within \(Int(elapsed.rounded()))s. "
                + "The driver gave up waiting and answered on its behalf; the operation may still be running."
        )
    }
}

public final class PendingRequestTracker: @unchecked Sendable {
    private struct Entry {
        let op: String
        let startedAt: Date
        /// This request's own deadline. Per-request rather than global because
        /// the driver has one op that is legitimately slow: `input` with a
        /// `wait` command polls for up to two minutes by contract, and a
        /// watchdog that answered it at fifteen seconds would be inventing a
        /// failure rather than reporting one.
        let budget: TimeInterval
    }

    private let lock = NSLock()
    private var pending: [String: Entry] = [:]
    /// Ids whose single reply has already been handed out. Bounded: an id only
    /// lands here while it is also in `pending`, and `finish` clears both.
    private var claimed: Set<String> = []

    /// How long a handler may run before the watchdog answers for it.
    public let timeout: TimeInterval

    public init(timeout: TimeInterval = 15) {
        self.timeout = timeout
    }

    /// Registers a request as in flight.
    ///
    /// `budget` overrides the tracker's default deadline for this one request.
    public func begin(id: String, op: String, budget: TimeInterval? = nil, at now: Date = Date()) {
        lock.lock()
        defer { lock.unlock() }
        pending[id] = Entry(op: op, startedAt: now, budget: max(timeout, budget ?? timeout))
        claimed.remove(id)
    }

    /// The right to write this request's one reply.
    ///
    /// True exactly once for a registered request. An id that was never
    /// registered always claims true: a reply written off the dispatch path —
    /// a malformed line, a rejected gesture — is not something the watchdog can
    /// ever race, and refusing it would lose a reply rather than dedupe one.
    public func claim(id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard pending[id] != nil else { return true }
        guard !claimed.contains(id) else { return false }
        claimed.insert(id)
        return true
    }

    /// Drops the request's bookkeeping. Called once the handler has returned,
    /// whether or not it was the side that got to reply.
    public func finish(id: String) {
        lock.lock()
        defer { lock.unlock() }
        pending.removeValue(forKey: id)
        claimed.remove(id)
    }

    /// The in-flight requests that have outlived the timeout and have not been
    /// replied to yet, claiming each one on the way out so the handler behind
    /// it stays silent when it eventually returns.
    ///
    /// Claiming rather than removing is deliberate: the entry stays in
    /// `pending` until its handler calls `finish`, so a request cannot be
    /// reported overdue twice, and `isPending` still tells the truth about work
    /// that is genuinely still running.
    public func takeOverdue(at now: Date = Date()) -> [OverdueRequest] {
        lock.lock()
        defer { lock.unlock() }
        var overdue: [OverdueRequest] = []
        for (id, entry) in pending {
            guard !claimed.contains(id) else { continue }
            let elapsed = now.timeIntervalSince(entry.startedAt)
            guard elapsed >= entry.budget else { continue }
            claimed.insert(id)
            overdue.append(OverdueRequest(id: id, op: entry.op, elapsed: elapsed))
        }
        // Stable order so a burst of overdue replies is reproducible in a log.
        return overdue.sorted { $0.id < $1.id }
    }

    public func isPending(id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return pending[id] != nil
    }

    public var inFlightCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return pending.count
    }
}
