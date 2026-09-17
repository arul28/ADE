/// The one capability that can disturb the person sitting at the Mac.
///
/// Accessibility actions are process-scoped: `AXUIElementPerformAction` acts on
/// one element inside one application and moves nothing the user owns. A
/// `CGEvent` post is not — it goes to the window server and lands wherever the
/// key window happens to be. So real pointer and keyboard input is gated, and
/// the gate lives *here*, in the driver, rather than only in the Node service
/// that usually calls it.
///
/// That duplication is deliberate. The service is the policy engine and will
/// keep the authoritative lease; the driver is the thing holding the loaded
/// weapon. A bug in the service, a replayed request line, or somebody pointing
/// a debugger at the helper's stdin must not be enough to move the user's
/// pointer. The driver refuses a lease-less post on its own authority.
///
/// The lease is a *deadline*, not a flag. A remote viewer that drops its socket
/// mid-takeover, or a machine that sleeps, leaves nothing behind to clear a
/// flag; an expiry needs nobody to notice.
///
/// No AppKit and no CoreGraphics here on purpose: the refusal is the part that
/// has to be right, and it is only testable if it can run without a window
/// server.

import Foundation

/// One lease as Node stated it.
///
/// `expiresAt` is milliseconds since the epoch rather than an ISO string: the
/// only thing the driver does with it is compare it to now, and a parse that
/// can fail would turn a malformed date into an accidental grant.
public struct InputLease: Equatable, Sendable {
    public let laneId: String
    public let holderId: String
    public let expiresAtMs: Double

    public init(laneId: String, holderId: String, expiresAtMs: Double) {
        self.laneId = laneId
        self.holderId = holderId
        self.expiresAtMs = expiresAtMs
    }

    public func isValid(now: Date) -> Bool {
        expiresAtMs > now.timeIntervalSince1970 * 1000
    }
}

public enum InputLeaseError: Error, Equatable {
    case missing(laneId: String)
    case expired(laneId: String)
    case heldByOther(laneId: String, holderId: String)

    public var driverError: DriverError {
        switch self {
        case .missing(let laneId):
            return DriverError(
                code: DriverErrorCode.inputLeaseRequired,
                message: "Real pointer and keyboard input on lane \(laneId) needs an input lease. Ask for one first."
            )
        case .expired(let laneId):
            return DriverError(
                code: DriverErrorCode.inputLeaseRequired,
                message: "The input lease on lane \(laneId) has lapsed. Renew it before posting real input."
            )
        case .heldByOther(let laneId, let holderId):
            return DriverError(
                code: DriverErrorCode.inputLeaseRequired,
                message: "The input lease on lane \(laneId) is held by \(holderId)."
            )
        }
    }
}

/// The driver's own copy of who may post real events.
///
/// Written by `lease.set` / `lease.clear`, read by every `RealInput` call.
public final class InputLeaseStore: @unchecked Sendable {
    private var byLane: [String: InputLease] = [:]
    private let lock = NSLock()

    public init() {}

    public func set(_ lease: InputLease) {
        lock.lock()
        defer { lock.unlock() }
        byLane[lease.laneId] = lease
    }

    @discardableResult
    public func clear(laneId: String) -> InputLease? {
        lock.lock()
        defer { lock.unlock() }
        return byLane.removeValue(forKey: laneId)
    }

    public func lease(forLane laneId: String) -> InputLease? {
        lock.lock()
        defer { lock.unlock() }
        return byLane[laneId]
    }

    /// The whole gate.
    ///
    /// `holderId` is checked when the caller states one: a request that names a
    /// holder is claiming to be that holder, and a stale chat replaying its own
    /// old request line after the lease moved on must not be let through.
    public func authorize(
        laneId: String,
        holderId: String?,
        now: Date = Date()
    ) throws -> InputLease {
        guard let lease = lease(forLane: laneId) else {
            throw InputLeaseError.missing(laneId: laneId)
        }
        guard lease.isValid(now: now) else {
            throw InputLeaseError.expired(laneId: laneId)
        }
        if let holderId, !holderId.isEmpty, holderId != lease.holderId {
            throw InputLeaseError.heldByOther(laneId: laneId, holderId: lease.holderId)
        }
        return lease
    }

    /// Reads a `lease: {holderId, expiresAt}` object off a request.
    ///
    /// `expiresAt` is accepted as epoch milliseconds or as an ISO-8601 string,
    /// because the Node side stringifies dates everywhere else in this contract
    /// and a helper that only accepted one of the two would fail closed in the
    /// most confusing possible way.
    public static func parse(laneId: String, from request: DriverRequest) -> InputLease? {
        guard let object = request.object("lease") else { return nil }
        guard let holderId = object["holderId"]?.stringValue, !holderId.isEmpty else { return nil }
        guard let expiresAtMs = expiryMilliseconds(object["expiresAt"]) else { return nil }
        return InputLease(laneId: laneId, holderId: holderId, expiresAtMs: expiresAtMs)
    }

    public static func expiryMilliseconds(_ value: JSONValue?) -> Double? {
        guard let value else { return nil }
        if let number = value.doubleValue { return number }
        guard let text = value.stringValue else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) {
            return date.timeIntervalSince1970 * 1000
        }
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: text) {
            return date.timeIntervalSince1970 * 1000
        }
        return nil
    }
}
