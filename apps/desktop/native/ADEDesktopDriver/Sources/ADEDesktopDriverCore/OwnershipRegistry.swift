/// Which lane holds which window, and the one app rule that needs a registry.
///
/// Two lanes cannot both drive the same window: whoever parked it owns it until
/// it is unparked or the lane goes away. Most apps happily run twice, so most of
/// the time ownership is per window and nothing collides.
///
/// Single-instance apps are the exception worth a rule. Xcode, Simulator, Slack
/// and friends refuse to launch a second copy, so "lane B opens Xcode" silently
/// hands lane B the *same* process lane A is driving, and two agents start
/// typing into one window. That is refused here, and the refusal names the
/// holding lane, because "owned by another lane" without saying which one leaves
/// the user with nothing to do about it.
///
/// No AppKit: this is a bookkeeping rule, and it is the kind of rule that is
/// only ever right if it can be tested without a window server.

import Foundation

public struct WindowOwnership: Equatable, Sendable {
    public let windowId: Int
    public let laneId: String
    public let bundleId: String?
    public let singleInstance: Bool

    public init(windowId: Int, laneId: String, bundleId: String?, singleInstance: Bool) {
        self.windowId = windowId
        self.laneId = laneId
        self.bundleId = bundleId
        self.singleInstance = singleInstance
    }
}

public enum OwnershipError: Error, Equatable {
    /// A single-instance bundle id is already parked on another lane.
    case appOwnedByOtherLane(bundleId: String, holderLaneId: String)
    /// This exact window is parked on another lane.
    case windowOwnedByOtherLane(windowId: Int, holderLaneId: String)

    public var driverError: DriverError {
        switch self {
        case .appOwnedByOtherLane(let bundleId, let holderLaneId):
            return DriverError(
                code: DriverErrorCode.appOwnedByOtherLane,
                message: "\(bundleId) only runs once and lane \(holderLaneId) is holding it. Release it there first."
            )
        case .windowOwnedByOtherLane(let windowId, let holderLaneId):
            return DriverError(
                code: DriverErrorCode.appOwnedByOtherLane,
                message: "Window \(windowId) is parked on lane \(holderLaneId). Release it there first."
            )
        }
    }
}

public final class OwnershipRegistry: @unchecked Sendable {
    private var byWindow: [Int: WindowOwnership] = [:]
    private let lock = NSLock()

    public init() {}

    @discardableResult
    public func park(
        laneId: String,
        windowId: Int,
        bundleId: String? = nil,
        singleInstance: Bool = false
    ) throws -> WindowOwnership {
        lock.lock()
        defer { lock.unlock() }

        if let existing = byWindow[windowId], existing.laneId != laneId {
            throw OwnershipError.windowOwnedByOtherLane(windowId: windowId, holderLaneId: existing.laneId)
        }
        if singleInstance, let bundleId {
            if let holder = byWindow.values.first(where: {
                $0.singleInstance && $0.bundleId == bundleId && $0.laneId != laneId
            }) {
                throw OwnershipError.appOwnedByOtherLane(bundleId: bundleId, holderLaneId: holder.laneId)
            }
        }
        let ownership = WindowOwnership(
            windowId: windowId,
            laneId: laneId,
            bundleId: bundleId,
            singleInstance: singleInstance
        )
        byWindow[windowId] = ownership
        return ownership
    }

    @discardableResult
    public func unpark(windowId: Int) -> WindowOwnership? {
        lock.lock()
        defer { lock.unlock() }
        return byWindow.removeValue(forKey: windowId)
    }

    /// Drops every window a lane holds. Returns them so the caller can move them
    /// back to the main display before the lane's display disappears.
    @discardableResult
    public func releaseLane(_ laneId: String) -> [WindowOwnership] {
        lock.lock()
        defer { lock.unlock() }
        let released = byWindow.values.filter { $0.laneId == laneId }
        for ownership in released {
            byWindow.removeValue(forKey: ownership.windowId)
        }
        return released.sorted { $0.windowId < $1.windowId }
    }

    /// The refusal for `laneId` releasing a window, or nil when it may.
    ///
    /// A release that names no lane (older clients) and a window no lane
    /// holds are both allowed; only a window held by a different lane is
    /// refused, so one lane's Release can never hand over another lane's app.
    public func releaseRefusal(windowId: Int, laneId: String?) -> OwnershipError? {
        guard let laneId, let holder = owner(ofWindow: windowId), holder != laneId else { return nil }
        return .windowOwnedByOtherLane(windowId: windowId, holderLaneId: holder)
    }

    public func owner(ofWindow windowId: Int) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return byWindow[windowId]?.laneId
    }

    public func ownership(ofWindow windowId: Int) -> WindowOwnership? {
        lock.lock()
        defer { lock.unlock() }
        return byWindow[windowId]
    }

    public func windows(forLane laneId: String) -> [WindowOwnership] {
        lock.lock()
        defer { lock.unlock() }
        return byWindow.values.filter { $0.laneId == laneId }.sorted { $0.windowId < $1.windowId }
    }

    public func singleInstanceHolder(bundleId: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return byWindow.values.first { $0.singleInstance && $0.bundleId == bundleId }?.laneId
    }

    public var all: [WindowOwnership] {
        lock.lock()
        defer { lock.unlock() }
        return byWindow.values.sorted { $0.windowId < $1.windowId }
    }
}
