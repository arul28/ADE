import Foundation

enum SyncTerminalInputQueueError: Error, Equatable, LocalizedError {
  case chunkTooLarge(maximumBytes: Int)
  case overflow(maximumItems: Int, maximumBytes: Int)

  var errorDescription: String? {
    switch self {
    case .chunkTooLarge(let maximumBytes):
      return "That terminal input is too large to send (maximum \(maximumBytes) bytes)."
    case .overflow(let maximumItems, let maximumBytes):
      return "Terminal input is paused because \(maximumItems) queued chunks or \(maximumBytes) bytes are waiting for the Mac."
    }
  }
}

enum SyncTerminalInputSubmission: Equatable {
  case awaitingAcknowledgement(inputId: String)
  case queuedUntilReady(inputId: String)
  case sentToLegacyHost
  case rejected(message: String)
}

enum SyncTerminalInputAcknowledgement: Equatable {
  case success(sessionId: String, inputId: String, duplicate: Bool)
  case failure(
    sessionId: String?,
    inputId: String?,
    code: String,
    message: String,
    retryableSubscription: Bool
  )
}

func syncTerminalInputAcknowledgement(
  from payload: [String: Any]
) -> SyncTerminalInputAcknowledgement? {
  guard let ok = payload["ok"] as? Bool else { return nil }
  let sessionId = payload["sessionId"] as? String
  let inputId = payload["inputId"] as? String
  if ok {
    guard let sessionId, let inputId,
          let duplicate = payload["duplicate"] as? Bool else { return nil }
    return .success(sessionId: sessionId, inputId: inputId, duplicate: duplicate)
  }
  guard let error = payload["error"] as? [String: Any],
        let code = error["code"] as? String,
        let message = error["message"] as? String else { return nil }
  let retryableSubscription = code == "not_subscribed" && (error["retryable"] as? Bool) == true
  return .failure(
    sessionId: sessionId,
    inputId: inputId,
    code: code,
    message: message,
    retryableSubscription: retryableSubscription
  )
}

struct SyncTerminalInputQueue: Equatable {
  enum Delivery: Equatable {
    case unsent
    case inFlight(generation: UInt64)
  }

  struct Item: Equatable {
    var inputId: String
    var data: Data
    var delivery: Delivery
    var firstSentUptime: TimeInterval?
    var lastSentUptime: TimeInterval?
    var attemptCount: Int
  }

  static let defaultMaximumItemCount = 128
  static let defaultMaximumByteCount = 128 * 1_024
  static let defaultMaximumChunkByteCount = 32 * 1_024
  static let defaultAcknowledgementTimeout: TimeInterval = 8

  let maximumItemCount: Int
  let maximumByteCount: Int
  let maximumChunkByteCount: Int
  let acknowledgementTimeout: TimeInterval
  private(set) var items: [Item] = []
  private(set) var byteCount = 0

  init(
    maximumItemCount: Int = defaultMaximumItemCount,
    maximumByteCount: Int = defaultMaximumByteCount,
    maximumChunkByteCount: Int = defaultMaximumChunkByteCount,
    acknowledgementTimeout: TimeInterval = defaultAcknowledgementTimeout
  ) {
    self.maximumItemCount = maximumItemCount
    self.maximumByteCount = maximumByteCount
    self.maximumChunkByteCount = maximumChunkByteCount
    self.acknowledgementTimeout = acknowledgementTimeout
  }

  mutating func enqueue(data: Data, inputId: String = UUID().uuidString) throws -> Item {
    guard data.count <= maximumChunkByteCount else {
      throw SyncTerminalInputQueueError.chunkTooLarge(maximumBytes: maximumChunkByteCount)
    }
    guard items.count < maximumItemCount, byteCount + data.count <= maximumByteCount else {
      throw SyncTerminalInputQueueError.overflow(
        maximumItems: maximumItemCount,
        maximumBytes: maximumByteCount
      )
    }
    let item = Item(
      inputId: inputId,
      data: data,
      delivery: .unsent,
      firstSentUptime: nil,
      lastSentUptime: nil,
      attemptCount: 0
    )
    items.append(item)
    byteCount += data.count
    return item
  }

  func nextSendableItem(reliableAcknowledgements: Bool) -> Item? {
    if reliableAcknowledgements,
       items.contains(where: { if case .inFlight = $0.delivery { return true }; return false }) {
      return nil
    }
    return items.first(where: { $0.delivery == .unsent })
  }

  mutating func markSent(inputId: String, generation: UInt64, sentUptime: TimeInterval) {
    guard let index = items.firstIndex(where: { $0.inputId == inputId }) else { return }
    items[index].delivery = .inFlight(generation: generation)
    items[index].firstSentUptime = items[index].firstSentUptime ?? sentUptime
    items[index].lastSentUptime = sentUptime
    items[index].attemptCount += 1
  }

  @discardableResult
  mutating func acknowledge(inputId: String) -> Item? {
    remove(inputId: inputId)
  }

  @discardableResult
  mutating func removeLegacyDelivery(inputId: String) -> Item? {
    remove(inputId: inputId)
  }

  mutating func prepareForReconnect() {
    items = items.map { item in
      var restored = item
      restored.delivery = .unsent
      return restored
    }
  }

  func timedOutInputId(nowUptime: TimeInterval, generation: UInt64) -> String? {
    items.first(where: { item in
      guard case .inFlight(let sentGeneration) = item.delivery,
            let lastSentUptime = item.lastSentUptime else { return false }
      return sentGeneration == generation
        && syncTerminalMonotonicElapsedSeconds(since: lastSentUptime, nowUptime: nowUptime) >= acknowledgementTimeout
    })?.inputId
  }

  func item(inputId: String) -> Item? {
    items.first(where: { $0.inputId == inputId })
  }

  func inFlightItem(inputId: String, generation: UInt64) -> Item? {
    guard let item = item(inputId: inputId),
          item.delivery == .inFlight(generation: generation) else { return nil }
    return item
  }

  private mutating func remove(inputId: String) -> Item? {
    guard let index = items.firstIndex(where: { $0.inputId == inputId }) else { return nil }
    let removed = items.remove(at: index)
    byteCount -= removed.data.count
    return removed
  }
}

enum SyncTerminalInputRetryDecision: Equatable {
  case retry(afterNanoseconds: UInt64)
  case attemptsExhausted
  case retryWindowExpired
}

func syncTerminalMonotonicElapsedSeconds(
  since startUptime: TimeInterval,
  nowUptime: TimeInterval
) -> TimeInterval {
  max(0, nowUptime - startUptime)
}

func syncTerminalInputRetryDecision(
  item: SyncTerminalInputQueue.Item,
  nowUptime: TimeInterval,
  retryWindowMilliseconds: TimeInterval,
  maximumAttempts: Int = 4,
  retryBackoffSeconds: [TimeInterval] = [0.5, 1, 2]
) -> SyncTerminalInputRetryDecision {
  guard item.attemptCount < maximumAttempts else { return .attemptsExhausted }
  guard let firstSentUptime = item.firstSentUptime else { return .attemptsExhausted }
  let backoffIndex = max(0, item.attemptCount - 1)
  guard retryBackoffSeconds.indices.contains(backoffIndex) else { return .attemptsExhausted }
  let backoff = retryBackoffSeconds[backoffIndex]
  let retryWindowSeconds = retryWindowMilliseconds / 1_000
  guard syncTerminalMonotonicElapsedSeconds(
    since: firstSentUptime,
    nowUptime: nowUptime + backoff
  ) <= retryWindowSeconds else {
    return .retryWindowExpired
  }
  return .retry(afterNanoseconds: UInt64((backoff * 1_000_000_000).rounded()))
}
