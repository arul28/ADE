/// Readiness polling for a native service shared by capture and input setup.
public actor SharedReadiness {
    public enum Failure: Error, Equatable { case timedOut }

    private let timeout: Duration
    private let pollInterval: Duration
    private var task: Task<Void, Error>?

    public init(timeout: Duration = .seconds(5), pollInterval: Duration = .milliseconds(50)) {
        precondition(timeout > .zero && pollInterval > .zero)
        self.timeout = timeout
        self.pollInterval = pollInterval
    }

    public func waitUntilReady(_ isReady: @escaping @Sendable () async -> Bool) async throws {
        try Task.checkCancellation()
        if task == nil {
            task = Task {
                do {
                    let clock = ContinuousClock()
                    let deadline = clock.now.advanced(by: timeout)
                    while !(await isReady()) {
                        let now = clock.now
                        guard now < deadline else { throw Failure.timedOut }
                        try await clock.sleep(until: min(deadline, now.advanced(by: pollInterval)))
                    }
                } catch {
                    // Only this task clears its failure. An older waiter must
                    // not clear a retry started while it was resuming.
                    task = nil
                    throw error
                }
            }
        }
        // Caller cancellation must not cancel initialization for other callers.
        let result = await task!.result
        try Task.checkCancellation()
        try result.get()
    }
}
