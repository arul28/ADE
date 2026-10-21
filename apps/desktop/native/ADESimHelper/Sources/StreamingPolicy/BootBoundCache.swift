/// Caches values that belong to one simulator boot, grouped by device.
///
/// `reset(scope:)` drops that device's values and invalidates its lookups that
/// started before the reset, so a lookup that resumes after a reboot cannot
/// store a handle from the previous boot. Other devices keep their values and
/// their in-flight lookups.
public struct BootBoundCache<Scope: Hashable, Key: Hashable, Value> {
    public struct Lookup: Equatable {
        fileprivate let scope: Scope
        fileprivate let generation: UInt64
    }

    private var values: [Key: (scope: Scope, value: Value)] = [:]
    private var generations: [Scope: UInt64] = [:]

    public init() {}

    public subscript(key: Key) -> Value? { values[key]?.value }

    public func beginLookup(scope: Scope) -> Lookup {
        Lookup(scope: scope, generation: generations[scope, default: 0])
    }

    public func isCurrent(_ lookup: Lookup) -> Bool {
        lookup.generation == generations[lookup.scope, default: 0]
    }

    /// Stores `value` only if its scope was not reset since `lookup` began.
    @discardableResult
    public mutating func store(_ value: Value, for key: Key, from lookup: Lookup) -> Bool {
        guard isCurrent(lookup) else { return false }
        values[key] = (lookup.scope, value)
        return true
    }

    public mutating func removeValue(forKey key: Key) {
        values.removeValue(forKey: key)
    }

    public mutating func reset(scope: Scope) {
        generations[scope, default: 0] &+= 1
        values = values.filter { $0.value.scope != scope }
    }
}
