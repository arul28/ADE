import Foundation

/// A one-way "it happened", readable from another thread.
///
/// `RunLoopPump.wait` runs the main run loop while a callback on some other
/// queue decides the wait is over, so the predicate has to read a variable that
/// a second thread writes. The alternative at each site is a captured `var`
/// plus a captured `NSLock`, which reads like a bug even when it is correct.
///
/// Deliberately one-way and un-resettable: a flag that can go back to false is
/// a state machine, and a state machine shared across threads wants a type with
/// more opinions than this one.
final class SettledFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    init() {}

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set() {
        lock.lock()
        value = true
        lock.unlock()
    }
}
