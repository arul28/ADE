/// Element handles, and how long one stays meaningful.
///
/// An observation numbers the elements it found and hands back
/// `obs-<observationId>:e:<index>`. The index is only meaningful inside that one
/// observation — the next walk of the same app can produce a different tree, so
/// a handle from two screens ago naming index 12 would act on whatever happens
/// to be twelfth now. That is the class of bug this file exists to prevent:
/// a stale handle must be *refused*, not silently resolved against fresh
/// numbering.
///
/// Retention is bounded because an agent turn can observe hundreds of times and
/// nothing ever tells the driver a handle will not be used again.

import Foundation

public struct ResolvedHandle: Equatable, Sendable {
    public let observationId: String
    public let index: Int

    public init(observationId: String, index: Int) {
        self.observationId = observationId
        self.index = index
    }
}

public enum HandleError: Error, Equatable {
    case malformed(String)
    case expired(String)
    case outOfRange(String)

    public var driverError: DriverError {
        switch self {
        case .malformed(let handle):
            return DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\"\(handle)\" is not an element handle. Handles look like obs-<id>:e:<n>."
            )
        case .expired(let handle):
            return DriverError(
                code: DriverErrorCode.handleExpired,
                message: "Handle \"\(handle)\" belongs to an older observation. Observe again and use a fresh handle."
            )
        case .outOfRange(let handle):
            return DriverError(
                code: DriverErrorCode.handleExpired,
                message: "Handle \"\(handle)\" names an element its observation does not have."
            )
        }
    }
}

/// Live observations, newest last.
public final class HandleRegistry: @unchecked Sendable {
    /// How many observations stay resolvable.
    ///
    /// Small on purpose: an agent acts on the screen it just looked at. Keeping
    /// a deep history would make a genuinely stale handle resolve, which is
    /// worse than making the caller observe again.
    public static let defaultRetention = 8

    private struct Entry {
        let observationId: String
        let elementCount: Int
    }

    private let retention: Int
    private var entries: [Entry] = []
    private let lock = NSLock()

    public init(retention: Int = HandleRegistry.defaultRetention) {
        self.retention = max(1, retention)
    }

    public static func handle(observationId: String, index: Int) -> String {
        "obs-\(observationId):e:\(index)"
    }

    public func makeHandle(observationId: String, index: Int) -> String {
        Self.handle(observationId: observationId, index: index)
    }

    /// Registers an observation and returns the ids retention dropped.
    @discardableResult
    public func record(observationId: String, elementCount: Int) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll { $0.observationId == observationId }
        entries.append(Entry(observationId: observationId, elementCount: max(0, elementCount)))
        var dropped: [String] = []
        while entries.count > retention {
            dropped.append(entries.removeFirst().observationId)
        }
        return dropped
    }

    public var activeObservationIds: [String] {
        lock.lock()
        defer { lock.unlock() }
        return entries.map(\.observationId)
    }

    public var newestObservationId: String? {
        lock.lock()
        defer { lock.unlock() }
        return entries.last?.observationId
    }

    public func forget(observationId: String) {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll { $0.observationId == observationId }
    }

    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll()
    }

    /// Splits a handle without consulting the registry. Used by callers that
    /// only need the shape, and by `resolve` before it looks anything up.
    public static func parse(_ handle: String) -> ResolvedHandle? {
        guard handle.hasPrefix("obs-") else { return nil }
        guard let separator = handle.range(of: ":e:") else { return nil }
        let observationId = String(handle[handle.index(handle.startIndex, offsetBy: 4)..<separator.lowerBound])
        let indexText = String(handle[separator.upperBound...])
        guard !observationId.isEmpty,
              observationId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }),
              !indexText.isEmpty,
              indexText.allSatisfy(\.isNumber),
              let index = Int(indexText)
        else { return nil }
        return ResolvedHandle(observationId: observationId, index: index)
    }

    public func resolve(_ handle: String) throws -> ResolvedHandle {
        guard let parsed = Self.parse(handle) else {
            throw HandleError.malformed(handle)
        }
        lock.lock()
        defer { lock.unlock() }
        guard let entry = entries.first(where: { $0.observationId == parsed.observationId }) else {
            throw HandleError.expired(handle)
        }
        guard parsed.index >= 0, parsed.index < entry.elementCount else {
            throw HandleError.outOfRange(handle)
        }
        return parsed
    }
}
