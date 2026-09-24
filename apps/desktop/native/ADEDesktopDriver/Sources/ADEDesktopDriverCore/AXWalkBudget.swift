/// The time budget behind every accessibility walk the driver makes.
///
/// Why this exists, measured on the owner's MacBook: every `AXUIElementCopy…`
/// call is a synchronous round trip into the target app, and the API's default
/// messaging timeout is about six seconds *per call*. Describing one element
/// takes a dozen calls. A healthy app answers each in well under a millisecond,
/// so nobody noticed — until TextEdit's first-launch Open panel, which is an
/// out-of-process remote view (`openAndSavePanelService`). Calls into TextEdit
/// that touch that panel stall, a direct AppleScript window query stalled the
/// same way, and one walk became minutes of the main thread blocked inside the
/// Accessibility API: the watchdog answered `observe` on the walk's behalf,
/// the next request was never even dispatched, and `ping` went unanswered.
///
/// Three rules bound that, and all three are arithmetic, so they live here:
///
/// * a short per-call messaging timeout (`AXTimeouts.walkRead`) on every
///   element the walk reads;
/// * a stall breaker: the first call into an app that times out ends the walk
///   of that app, and later walks skip it for a cooldown
///   (`AXStallRegistry`), because a second call into a stalled app costs the
///   same second again;
/// * a deadline for the whole walk, after which it returns what it has, with
///   the reason, instead of failing.
///
/// Nothing here imports ApplicationServices: error codes arrive as raw
/// `AXError` values, and the clock is the caller's.

import Foundation

public enum AXTimeouts {
    /// The messaging timeout on every element an observation walk reads.
    ///
    /// One second: a responsive app answers an attribute read in well under
    /// ten milliseconds even while it is busy, so a second is two orders of
    /// magnitude of headroom before an app is called stalled. It is also a
    /// sixth of the default, and with the stall breaker a stalled app costs one
    /// such timeout per walk rather than one per attribute, so two stalled apps
    /// still fit inside a walk budget with time left for the healthy ones.
    public static let walkRead: Float = 1.0

    /// The process-wide timeout, set once on the system-wide element.
    ///
    /// It covers every call outside a walk — the window watcher, parking, and
    /// actions. Longer than `walkRead` because an action's reply waits for the
    /// app's handler to run, and shorter than the service's 5-second health
    /// timeout so that one stuck call can never by itself make `ping` late.
    public static let global: Float = 2.0

    /// The whole element walk of one `observe`.
    ///
    /// The driver's watchdog answers at 15 seconds and the service gives up at
    /// 20. `observe` also takes a screenshot and may draw an element map, so
    /// the walk gets 5 seconds and the rest keeps a wide margin under both.
    public static let observeWalk: TimeInterval = 5

    /// The walk of one `wait` poll. A wait polls several times a second, and
    /// the run loop is pumped between polls, so each poll is kept short.
    public static let waitPollWalk: TimeInterval = 2

    /// How long an app that timed out is left alone by later walks, the window
    /// list, and the watcher. Long enough that a wait polling four times a
    /// second does not pay a timeout per poll; short enough that an app that
    /// recovers is walked again within a few seconds.
    public static let stallCooldown: TimeInterval = 5
}

/// What one Accessibility call's `AXError` means to a walk.
public enum AXCallResult: Equatable, Sendable {
    case ok
    /// `kAXErrorCannotComplete`: the app did not answer inside the messaging
    /// timeout (or is gone). The request may still have been delivered.
    case timedOut
    /// Any other failure: the attribute does not exist, the element is
    /// invalid, the call is not supported. Normal on almost every element.
    case failed

    /// `kAXErrorSuccess`.
    public static let successCode: Int32 = 0
    /// `kAXErrorCannotComplete`.
    public static let cannotCompleteCode: Int32 = -25204

    public static func classify(rawError: Int32) -> AXCallResult {
        switch rawError {
        case successCode: return .ok
        case cannotCompleteCode: return .timedOut
        default: return .failed
        }
    }

    /// Whether an *action* reached the app.
    ///
    /// A press whose handler opens a modal, or a value set whose handler is
    /// slow, times out while the app is still doing what it was asked. Reading
    /// that as "refused" and trying the next action — `AXConfirm` after
    /// `AXPress`, or typing the text again as key events after `AXValue` was
    /// set — acts twice. Only a real refusal may fall through to another way.
    public static func wasDelivered(rawError: Int32) -> Bool {
        classify(rawError: rawError) != .failed
    }
}

/// Why a walk returned fewer elements than the tree holds.
///
/// Wire spelling is the raw value; `truncatedReason` on an observation.
/// Ordered by how much it matters to the caller: a timeout or a stall means
/// part of the screen was never looked at, a node cap means a huge tree was
/// cut, and a limit means the caller asked for fewer.
public enum WalkStop: String, Equatable, Sendable {
    case timeout
    case stalled
    case nodeCap = "node_cap"
    case limit
}

/// The per-walk bookkeeping: the deadline, the node cap, and which apps
/// stopped answering during this walk.
public struct AXWalkBudget: Equatable, Sendable {
    public let startedAt: Date
    public let deadline: Date
    public let maxNodes: Int
    /// Nodes a single remote-view process may contribute to one walk.
    ///
    /// A remote view (an element whose pid is not the window owner's) is a
    /// different process answering through the host app. It gets its own stall
    /// breaker like any app, and this cap so a huge remote tree cannot take the
    /// whole node budget from the window that hosts it.
    public let maxForeignNodes: Int

    public private(set) var visited = 0
    public private(set) var timedOut = false
    public private(set) var hitNodeCap = false
    /// pid → app name, in the order the stalls happened.
    public private(set) var stalled: [StalledApp] = []
    /// Foreign pids that ran into `maxForeignNodes`.
    public private(set) var cappedForeignPids: Set<Int32> = []
    private var foreignVisited: [Int32: Int] = [:]

    public struct StalledApp: Equatable, Sendable {
        public let pid: Int32
        public let appName: String

        public init(pid: Int32, appName: String) {
            self.pid = pid
            self.appName = appName
        }
    }

    public init(
        startedAt: Date,
        timeBudget: TimeInterval,
        maxNodes: Int,
        maxForeignNodes: Int
    ) {
        self.startedAt = startedAt
        self.deadline = startedAt.addingTimeInterval(max(0, timeBudget))
        self.maxNodes = max(0, maxNodes)
        self.maxForeignNodes = max(0, maxForeignNodes)
    }

    /// Whether the walk may read one more node. False ends the whole walk, and
    /// records why.
    public mutating func admitNode(now: Date) -> Bool {
        if timedOut || hitNodeCap { return false }
        if now >= deadline {
            timedOut = true
            return false
        }
        if visited >= maxNodes {
            hitNodeCap = true
            return false
        }
        visited += 1
        return true
    }

    /// Whether a child owned by `pid`, found inside a window owned by
    /// `windowPid`, should be queued at all.
    public mutating func admitChild(pid: Int32, windowPid: Int32) -> Bool {
        if isStalled(pid: pid) { return false }
        guard pid != windowPid else { return true }
        let count = (foreignVisited[pid] ?? 0) + 1
        guard count <= maxForeignNodes else {
            cappedForeignPids.insert(pid)
            return false
        }
        foreignVisited[pid] = count
        return true
    }

    /// Ends the walk as out of time. For a read that ran into the deadline
    /// between two `admitNode` checks: one slow element must not be allowed to
    /// carry the walk past its budget.
    public mutating func expire() {
        timedOut = true
    }

    /// The messaging timeout for the next element: `AXTimeouts.walkRead`, or
    /// what is left of the budget when that is less, so one call cannot run
    /// far past the deadline. `isFull` is false when it was shortened, and a
    /// read that times out on a shortened timeout says nothing about whether
    /// the app is stalled.
    public func readTimeout(now: Date) -> (seconds: Float, isFull: Bool) {
        let remaining = self.remaining(now: now)
        guard remaining < Double(AXTimeouts.walkRead) else { return (AXTimeouts.walkRead, true) }
        return (Float(max(0.05, remaining)), false)
    }

    public func isStalled(pid: Int32) -> Bool {
        stalled.contains { $0.pid == pid }
    }

    /// Records that an app stopped answering. Idempotent per pid.
    public mutating func noteStall(pid: Int32, appName: String) {
        guard !isStalled(pid: pid) else { return }
        stalled.append(StalledApp(pid: pid, appName: appName))
    }

    /// Seconds left before the deadline, never negative.
    public func remaining(now: Date) -> TimeInterval {
        max(0, deadline.timeIntervalSince(now))
    }

    /// Milliseconds since the walk started.
    public func elapsedMs(now: Date) -> Int {
        Int((now.timeIntervalSince(startedAt) * 1000).rounded())
    }

    /// The one reason the reply carries, or nil for a complete walk.
    ///
    /// `limitHit` is the caller's: whether more elements were found than it
    /// was allowed to return. A foreign cap reads as a node cap, because to
    /// the caller both mean "a big tree was cut, narrow the window".
    public func stopReason(limitHit: Bool) -> WalkStop? {
        if timedOut { return .timeout }
        if !stalled.isEmpty { return .stalled }
        if hitNodeCap || !cappedForeignPids.isEmpty { return .nodeCap }
        if limitHit { return .limit }
        return nil
    }

    /// The per-poll walk budget for a `wait`: the poll budget, but never past
    /// the wait's own deadline, and never so small that a poll cannot read the
    /// first few elements.
    public static func waitPollBudget(now: Date, waitDeadline: Date) -> TimeInterval {
        let remaining = waitDeadline.timeIntervalSince(now)
        return min(AXTimeouts.waitPollWalk, max(0.25, remaining))
    }
}

/// Apps that timed out recently, shared by every walk and by the watcher.
///
/// Per-walk memory is not enough: a `wait` polls four times a second and the
/// window watcher sweeps every second, so without this each of them would pay
/// a full messaging timeout against the same stalled app on every tick, and
/// the main thread would spend its life inside the Accessibility API.
public final class AXStallRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var stalledUntil: [Int32: Date] = [:]

    public let cooldown: TimeInterval

    public init(cooldown: TimeInterval = AXTimeouts.stallCooldown) {
        self.cooldown = cooldown
    }

    /// Marks `pid` stalled from `now` until the cooldown has passed. Returns
    /// true when this is a new stall rather than a repeat inside the cooldown,
    /// so a caller logs a stall once rather than on every poll.
    @discardableResult
    public func noteStall(pid: Int32, at now: Date = Date()) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let wasStalled = (stalledUntil[pid].map { $0 > now }) ?? false
        stalledUntil[pid] = now.addingTimeInterval(cooldown)
        return !wasStalled
    }

    public func isStalled(pid: Int32, at now: Date = Date()) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let until = stalledUntil[pid] else { return false }
        if until > now { return true }
        stalledUntil.removeValue(forKey: pid)
        return false
    }

    /// Forgets a pid, for an app that answered again or exited.
    public func clear(pid: Int32) {
        lock.lock()
        defer { lock.unlock() }
        stalledUntil.removeValue(forKey: pid)
    }
}
