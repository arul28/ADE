import Foundation

final class DeviceStateDelivery: @unchecked Sendable {
    private let lock = NSLock()
    private var active = true
    private var pending: DeviceStateSnapshot?
    private var task: Task<Void, Never>?
    private let deliver: @Sendable (DeviceStateSnapshot, DeviceStateDelivery) async -> Void

    init(deliver: @escaping @Sendable (DeviceStateSnapshot, DeviceStateDelivery) async -> Void) {
        self.deliver = deliver
    }

    var isActive: Bool { lock.withLock { active } }

    func submit(_ snapshot: DeviceStateSnapshot) {
        lock.withLock {
            guard active else { return }
            pending = snapshot
            if task == nil { task = Task { await self.drain() } }
        }
    }

    func cancel() -> Task<Void, Never>? {
        let running = lock.withLock {
            active = false
            pending = nil
            return task
        }
        running?.cancel()
        return running
    }

    private func takeNext() -> DeviceStateSnapshot? {
        lock.withLock {
            guard active, let snapshot = pending else { task = nil; return nil }
            pending = nil
            return snapshot
        }
    }

    private func drain() async {
        while let snapshot = takeNext() { await deliver(snapshot, self) }
    }
}
