import XCTest
@testable import ADE

private actor ActivityPollSleepHarness {
  private var requests: [(UInt64, CheckedContinuation<Void, Error>)] = []

  func sleep(nanoseconds: UInt64) async throws {
    try await withCheckedThrowingContinuation { continuation in
      requests.append((nanoseconds, continuation))
    }
  }

  var requestCount: Int { requests.count }
  var intervals: [UInt64] { requests.map(\.0) }

  func resumeFirst() {
    guard !requests.isEmpty else { return }
    let request = requests.removeFirst()
    request.1.resume()
  }
}

@MainActor
final class ActivityPollingTests: XCTestCase {
  func testStartIsIdempotentAndGenerationStopsOldLoop() async {
    let sleeper = ActivityPollSleepHarness()
    var pollingEnabled = true
    var refreshCount = 0
    let service = AccountService(
      attentionPollSleep: { nanoseconds in
        try await sleeper.sleep(nanoseconds: nanoseconds)
      },
      attentionPollSignedIn: { pollingEnabled },
      attentionPollRefresh: {
        refreshCount += 1
        pollingEnabled = false
      }
    )

    service.startAttentionPolling()
    await waitForRequestCount(1, sleeper: sleeper)
    let firstGeneration = service.currentAttentionPollGeneration

    service.startAttentionPolling()
    XCTAssertEqual(service.currentAttentionPollGeneration, firstGeneration)
    let idempotentRequestCount = await sleeper.requestCount
    XCTAssertEqual(idempotentRequestCount, 1)

    service.stopAttentionPolling()
    service.startAttentionPolling()
    await waitForRequestCount(2, sleeper: sleeper)
    XCTAssertGreaterThan(service.currentAttentionPollGeneration, firstGeneration)
    let intervals = await sleeper.intervals
    XCTAssertEqual(
      intervals,
      [ActivityPollInterval, ActivityPollInterval]
    )

    // The injected sleeper intentionally ignores task cancellation. Resuming
    // the old generation must still not refresh or clear the newer task.
    await sleeper.resumeFirst()
    await Task.yield()
    XCTAssertEqual(refreshCount, 0)
    XCTAssertTrue(service.isAttentionPolling)

    await sleeper.resumeFirst()
    await waitForRefreshCount(1) { refreshCount }
    await waitForPollingStop(service)
    XCTAssertEqual(refreshCount, 1)
    XCTAssertFalse(service.isAttentionPolling)
  }

  func testSleepingPollLoopDoesNotRetainAccountService() async {
    let sleeper = ActivityPollSleepHarness()
    weak var weakService: AccountService?

    do {
      let service = AccountService(
        attentionPollSleep: { nanoseconds in
          try await sleeper.sleep(nanoseconds: nanoseconds)
        },
        attentionPollSignedIn: { true },
        attentionPollRefresh: {}
      )
      weakService = service
      service.startAttentionPolling()
      await waitForRequestCount(1, sleeper: sleeper)
    }

    for _ in 0..<1_000 where weakService != nil {
      await Task.yield()
    }
    XCTAssertNil(weakService)
    await sleeper.resumeFirst()
  }

  private func waitForRequestCount(
    _ expected: Int,
    sleeper: ActivityPollSleepHarness
  ) async {
    for _ in 0..<1_000 {
      if await sleeper.requestCount >= expected { return }
      await Task.yield()
    }
    XCTFail("Timed out waiting for \(expected) poll sleeps")
  }

  private func waitForRefreshCount(
    _ expected: Int,
    current: () -> Int
  ) async {
    for _ in 0..<1_000 {
      if current() >= expected { return }
      await Task.yield()
    }
    XCTFail("Timed out waiting for \(expected) poll refreshes")
  }

  private func waitForPollingStop(_ service: AccountService) async {
    for _ in 0..<1_000 {
      if !service.isAttentionPolling { return }
      await Task.yield()
    }
    XCTFail("Timed out waiting for polling to stop")
  }
}
