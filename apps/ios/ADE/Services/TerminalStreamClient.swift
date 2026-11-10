// The terminal stream state that the focused sync service and a machine's
// light link share: subscriptions, byte offsets, handlers and queued input.

import Foundation

/// Delivery events for the full-screen terminal. The active screen attaches a
/// handler per session id and receives hydration snapshots, ordered live
/// chunks, and process exit without polling `terminalBuffers`.
enum TerminalStreamEvent {
  /// Snapshot payload from `terminal_subscribe`. `replacing == false` means a
  /// delta resume (bytes from the requested `sinceOffset` to the end) that
  /// must be appended, not re-rendered from scratch. `paintFromScreen` means
  /// `text` is SerializeAddon CSI, not the transcript window — do not page
  /// history through it.
  case hydrate(text: String, replacing: Bool, startOffset: Int?, endOffset: Int?, paintFromScreen: Bool)
  case chunk(text: String, endOffset: Int?)
  case exit(code: Int?)
  case inputFailure(message: String)
  /// A resubscribe the phone started by itself (after a reconnect or a gap)
  /// failed. No stream backs the screen until the person retries.
  case subscribeFailure(message: String)
}

/// Every attached handler for each session, in attach order. Events go to
/// the last one only. A detach removes its own entry, and the handler
/// before it receives events again.
struct TerminalStreamHandlerStack {
  private var entries: [String: [(token: UUID, handler: (TerminalStreamEvent) -> Void)]] = [:]

  subscript(sessionId: String) -> ((TerminalStreamEvent) -> Void)? {
    entries[sessionId]?.last?.handler
  }

  mutating func attach(sessionId: String, handler: @escaping (TerminalStreamEvent) -> Void) -> UUID {
    let token = UUID()
    entries[sessionId, default: []].append((token: token, handler: handler))
    return token
  }

  mutating func detach(sessionId: String, token: UUID) {
    guard var list = entries[sessionId] else { return }
    list.removeAll { $0.token == token }
    entries[sessionId] = list.isEmpty ? nil : list
  }
}

/// What the full-screen terminal needs from a connection. `SyncService`
/// serves the focused machine; a `MachineConnection` serves a terminal of
/// another machine over its light link, without a focus switch.
@MainActor
protocol TerminalStreamTransport: AnyObject {
  func attachTerminalStream(sessionId: String, handler: @escaping (TerminalStreamEvent) -> Void) -> UUID?
  func detachTerminalStream(sessionId: String, token: UUID?)
  func hasTerminalStream(sessionId: String) -> Bool
  func subscribeTerminalStream(sessionId: String, sinceOffset: Int?) async throws
  func refreshTerminalSnapshot(sessionId: String, maxBytes: Int, sinceOffset: Int?) async throws
  func unsubscribeTerminal(sessionId: String) async throws
  func resumeCliSession(sessionId: String, cols: Int?, rows: Int?) async throws -> StartCliSessionResult
  func fetchTerminalHistory(sessionId: String, beforeOffset: Int, maxBytes: Int) async throws -> TerminalHistorySlice
  func canAcceptTerminalInput(sessionId: String) -> Bool
  func sendTerminalInput(sessionId: String, data: String) -> SyncTerminalInputSubmission
  func sendTerminalResize(sessionId: String, cols: Int, rows: Int)
}

/// What one transport lends the shared terminal client. Every closure runs on
/// the main actor.
struct TerminalStreamClientHooks {
  /// Whether the socket can carry frames now.
  let isLive: @MainActor () -> Bool
  /// Names the current socket for input acks. It changes when a socket closes.
  let generation: @MainActor () -> UInt64
  /// Sends one terminal envelope. The payload already holds the session id.
  let sendEnvelope: @MainActor (_ type: String, _ sessionId: String, _ payload: [String: Any]) -> Void
  /// Subscribes again from `sinceOffset`. Used after a gap and after an ack asks for it.
  let resubscribe: @MainActor (_ sessionId: String, _ sinceOffset: Int?) async throws -> Void
}

/// The terminal stream state and logic that both transports share. It owns the
/// subscription sets, the offsets, the handler stack and the queued input.
/// A transport keeps its own subscribe request, its scope and its transcript
/// buffer. It passes the socket checks and the sends in as hooks.
@MainActor
final class TerminalStreamClient {
  private let hooks: TerminalStreamClientHooks
  var handlers = TerminalStreamHandlerStack()
  /// Terminals the screen wants streamed. A new socket subscribes them again.
  var desired: Set<String> = []
  /// Terminals the current socket has a snapshot for.
  var subscribed: Set<String> = [] {
    didSet { onSubscribedChange?(subscribed) }
  }
  /// Runs after every change to `subscribed`. The focused sync service
  /// uses it to publish the set.
  var onSubscribedChange: ((Set<String>) -> Void)?
  /// Terminals with an accepted snapshot (input may queue). A new socket
  /// keeps the set, so input waits for the resubscribe; a refusal, an
  /// unsubscribe or `forgetAllSessions` removes the session.
  var hydrated: Set<String> = []
  var endOffsets: [String: Int] = [:]
  var requestTokens: [String: UUID] = [:]
  var gapRecovery: Set<String> = []
  var lastSize: [String: (cols: Int, rows: Int)] = [:]
  var inputQueues: [String: SyncTerminalInputQueue] = [:]
  var inputTimeouts: [String: Task<Void, Never>] = [:]
  /// Whether the host confirms input with `terminal_input_ack`.
  var acknowledgementsEnabled = false
  var retryWindowMilliseconds: TimeInterval = 0
  var maximumOutstanding = SyncTerminalInputQueue.defaultMaximumItemCount
  /// Sends the last known size again after each accepted snapshot. The light
  /// link sets it: a new socket gets its terminals' sizes back this way.
  let resendsSizeOnSubscribe: Bool

  init(hooks: TerminalStreamClientHooks, resendsSizeOnSubscribe: Bool = false) {
    self.hooks = hooks
    self.resendsSizeOnSubscribe = resendsSizeOnSubscribe
  }

  // MARK: Snapshot

  /// Applies the snapshot that answers the current request for `sessionId`.
  /// A newer subscribe or an unsubscribe owns the session, so a stale answer
  /// is ignored. Returns false when the answer was ignored.
  @discardableResult
  func acceptSnapshot(
    _ snapshot: TerminalSnapshot,
    sessionId: String,
    requestToken: UUID,
    isCurrent: () -> Bool = { true },
    beforeApply: () -> Void = {},
    bufferUpdate: (TerminalSnapshot) -> Void = { _ in }
  ) -> Bool {
    guard requestTokens[sessionId] == requestToken, desired.contains(sessionId), isCurrent() else {
      return false
    }
    requestTokens.removeValue(forKey: sessionId)
    beforeApply()
    applySnapshot(snapshot, sessionId: sessionId, bufferUpdate: bufferUpdate)
    subscribed.insert(sessionId)
    hydrated.insert(sessionId)
    if resendsSizeOnSubscribe, let size = lastSize[sessionId] {
      hooks.sendEnvelope("terminal_resize", sessionId, [
        "sessionId": sessionId,
        "cols": size.cols,
        "rows": size.rows,
      ])
    }
    flushInput(sessionId: sessionId)
    return true
  }

  /// A refused subscribe ends the subscription on this phone. A newer
  /// request for the session keeps its own state.
  func refuseSnapshot(sessionId: String, requestToken: UUID) {
    guard requestTokens[sessionId] == requestToken else { return }
    subscribed.remove(sessionId)
    hydrated.remove(sessionId)
  }

  private func applySnapshot(
    _ snapshot: TerminalSnapshot,
    sessionId: String,
    bufferUpdate: (TerminalSnapshot) -> Void
  ) {
    if let endOffset = snapshot.endOffset {
      endOffsets[sessionId] = endOffset
    }
    let handler = handlers[sessionId]
    bufferUpdate(snapshot)
    if snapshot.delta == true {
      // A delta covers exactly [sinceOffset, end): append it.
      if !snapshot.transcript.isEmpty {
        handler?(.hydrate(
          text: snapshot.transcript,
          replacing: false,
          startOffset: snapshot.startOffset,
          endOffset: snapshot.endOffset,
          paintFromScreen: false
        ))
      }
    } else {
      handler?(.hydrate(
        text: snapshot.replacingHydrateText,
        replacing: true,
        startOffset: snapshot.startOffset,
        endOffset: snapshot.endOffset,
        paintFromScreen: snapshot.hasScreenPaint
      ))
    }
    if snapshot.live == false {
      // No PTY behind the session: show the ended state, not a prompt.
      handler?(.exit(code: nil))
    }
  }

  // MARK: Live chunks

  /// Orders a live chunk against the bytes already applied. Returns the text
  /// to deliver, or nil when a snapshot already covered the bytes or a gap
  /// starts a resubscribe.
  func orderedChunk(sessionId: String, chunk: String, endOffset: Int?) -> String? {
    guard let endOffset else { return chunk }
    guard let lastEnd = endOffsets[sessionId] else {
      endOffsets[sessionId] = endOffset
      return chunk
    }
    let chunkStart = endOffset - chunk.utf8.count
    if endOffset <= lastEnd {
      // Bytes a snapshot already covered.
      return nil
    }
    if chunkStart > lastEnd {
      // Bytes are missing: drop the chunk and resume after the last byte.
      recoverGap(sessionId: sessionId, sinceOffset: lastEnd)
      return nil
    }
    var deliverable = chunk
    if chunkStart < lastEnd {
      // Partial overlap: trim the applied UTF-8 prefix.
      let bytes = Array(chunk.utf8)
      var overlap = min(max(0, lastEnd - chunkStart), bytes.count)
      while overlap < bytes.count, bytes[overlap] & 0xC0 == 0x80 {
        overlap += 1
      }
      deliverable = String(decoding: bytes.dropFirst(overlap), as: UTF8.self)
    }
    endOffsets[sessionId] = endOffset
    return deliverable
  }

  private func recoverGap(sessionId: String, sinceOffset: Int) {
    guard !gapRecovery.contains(sessionId) else { return }
    gapRecovery.insert(sessionId)
    Task { @MainActor [weak self] in
      guard let self else { return }
      defer { self.gapRecovery.remove(sessionId) }
      do {
        try await self.hooks.resubscribe(sessionId, sinceOffset)
      } catch {
        self.reportSubscribeFailure(sessionId: sessionId, error: error)
      }
    }
  }

  /// Tells the screen that a resubscribe it did not ask for failed, so it
  /// shows the error and Retry instead of a frozen terminal.
  func reportSubscribeFailure(sessionId: String, error: Error) {
    guard desired.contains(sessionId) else { return }
    handlers[sessionId]?(.subscribeFailure(message: error.localizedDescription))
  }

  // MARK: Input

  /// Takes input from the screen. `accepting` is the transport's rule for
  /// whether the session can take input yet.
  func submitInput(sessionId: String, data: String, accepting: Bool) -> SyncTerminalInputSubmission {
    guard !sessionId.isEmpty, !data.isEmpty else {
      return .rejected(message: "Terminal input is empty.")
    }
    guard accepting else {
      return rejectInput(sessionId: sessionId, message: "Terminal input is waiting for the terminal snapshot.")
    }
    return enqueueInput(sessionId: sessionId, data: data)
  }

  /// Queues input for a session that accepts input.
  private func enqueueInput(sessionId: String, data: String) -> SyncTerminalInputSubmission {
    do {
      var queue = inputQueues[sessionId] ?? SyncTerminalInputQueue(maximumItemCount: maximumOutstanding)
      let item = try queue.enqueue(data: Data(data.utf8))
      inputQueues[sessionId] = queue
      let ready = hooks.isLive() && subscribed.contains(sessionId)
      if ready {
        flushInput(sessionId: sessionId)
      }
      if acknowledgementsEnabled {
        return ready
          ? .awaitingAcknowledgement(inputId: item.inputId)
          : .queuedUntilReady(inputId: item.inputId)
      }
      return ready ? .sentToLegacyHost : .queuedUntilReady(inputId: item.inputId)
    } catch {
      return rejectInput(sessionId: sessionId, message: error.localizedDescription)
    }
  }

  /// Refuses input and tells the screen why.
  private func rejectInput(sessionId: String, message: String) -> SyncTerminalInputSubmission {
    handlers[sessionId]?(.inputFailure(message: message))
    return .rejected(message: message)
  }

  /// Sends the next queued input for a session when the socket and the subscription allow it.
  private func flushInput(sessionId: String) {
    guard hooks.isLive(), subscribed.contains(sessionId),
          var queue = inputQueues[sessionId],
          let item = queue.nextSendableItem(reliableAcknowledgements: acknowledgementsEnabled) else { return }
    guard let data = String(data: item.data, encoding: .utf8) else {
      _ = queue.acknowledge(inputId: item.inputId)
      inputQueues[sessionId] = queue
      handlers[sessionId]?(.inputFailure(message: "Terminal input could not be encoded."))
      flushInput(sessionId: sessionId)
      return
    }
    var payload: [String: Any] = ["sessionId": sessionId, "data": data]
    if acknowledgementsEnabled {
      payload["inputId"] = item.inputId
      queue.markSent(
        inputId: item.inputId,
        generation: hooks.generation(),
        sentUptime: ProcessInfo.processInfo.systemUptime
      )
      inputQueues[sessionId] = queue
      scheduleAcknowledgementTimeout(sessionId: sessionId)
    } else {
      _ = queue.removeLegacyDelivery(inputId: item.inputId)
      inputQueues[sessionId] = queue
    }
    hooks.sendEnvelope("terminal_input", sessionId, payload)
    if !acknowledgementsEnabled {
      flushInput(sessionId: sessionId)
    }
  }

  /// Starts the acknowledgement timer for the in-flight input of a session.
  /// On a timeout, the input resends inside the retry window or the queue drops it.
  func scheduleAcknowledgementTimeout(sessionId: String) {
    inputTimeouts[sessionId]?.cancel()
    let generation = hooks.generation()
    inputTimeouts[sessionId] = Task { @MainActor [weak self] in
      try? await Task.sleep(
        nanoseconds: UInt64((SyncTerminalInputQueue.defaultAcknowledgementTimeout * 1_000_000_000).rounded())
      )
      guard let self, !Task.isCancelled,
            var queue = self.inputQueues[sessionId],
            let inputId = queue.timedOutInputId(
              nowUptime: ProcessInfo.processInfo.systemUptime,
              generation: generation
            ),
            let item = queue.item(inputId: inputId) else { return }
      switch syncTerminalInputRetryDecision(
        item: item,
        nowUptime: ProcessInfo.processInfo.systemUptime,
        retryWindowMilliseconds: self.retryWindowMilliseconds
      ) {
      case .retry(let afterNanoseconds):
        try? await Task.sleep(nanoseconds: afterNanoseconds)
        guard !Task.isCancelled,
              self.hooks.generation() == generation,
              self.subscribed.contains(sessionId) else { return }
        self.inputTimeouts[sessionId] = nil
        self.resendInput(sessionId: sessionId, inputId: inputId)
      case .attemptsExhausted, .retryWindowExpired:
        _ = queue.acknowledge(inputId: inputId)
        self.inputQueues[sessionId] = queue
        self.inputTimeouts[sessionId] = nil
        self.handlers[sessionId]?(.inputFailure(
          message: "The computer did not confirm whether that terminal input was applied. It was not retried again."
        ))
        self.flushInput(sessionId: sessionId)
      }
    }
  }

  private func resendInput(sessionId: String, inputId: String) {
    guard hooks.isLive(), subscribed.contains(sessionId),
          var queue = inputQueues[sessionId],
          let item = queue.item(inputId: inputId),
          let data = String(data: item.data, encoding: .utf8) else { return }
    queue.markSent(
      inputId: inputId,
      generation: hooks.generation(),
      sentUptime: ProcessInfo.processInfo.systemUptime
    )
    inputQueues[sessionId] = queue
    hooks.sendEnvelope("terminal_input", sessionId, [
      "sessionId": sessionId,
      "data": data,
      "inputId": inputId,
    ])
    scheduleAcknowledgementTimeout(sessionId: sessionId)
  }

  /// Applies a `terminal_input_ack` frame from the host.
  func handleAcknowledgement(_ payload: [String: Any]) {
    guard let acknowledgement = syncTerminalInputAcknowledgement(from: payload) else { return }
    switch acknowledgement {
    case .success(let sessionId, let inputId, _):
      guard var queue = inputQueues[sessionId],
            queue.inFlightItem(inputId: inputId, generation: hooks.generation()) != nil else { return }
      inputTimeouts.removeValue(forKey: sessionId)?.cancel()
      _ = queue.acknowledge(inputId: inputId)
      inputQueues[sessionId] = queue
      flushInput(sessionId: sessionId)
    case .failure(let sessionId, let inputId, _, let message, let retryableSubscription):
      guard let sessionId, let inputId,
            var queue = inputQueues[sessionId],
            queue.inFlightItem(inputId: inputId, generation: hooks.generation()) != nil else { return }
      inputTimeouts.removeValue(forKey: sessionId)?.cancel()
      if retryableSubscription {
        // The host lost the subscription: subscribe again, then resend.
        queue.prepareForReconnect()
        inputQueues[sessionId] = queue
        subscribed.remove(sessionId)
        Task { @MainActor [weak self] in
          guard let self, self.desired.contains(sessionId) else { return }
          do {
            try await self.hooks.resubscribe(sessionId, self.endOffsets[sessionId])
          } catch {
            self.handlers[sessionId]?(.inputFailure(message: message))
          }
        }
        return
      }
      _ = queue.acknowledge(inputId: inputId)
      inputQueues[sessionId] = queue
      handlers[sessionId]?(.inputFailure(message: message))
      flushInput(sessionId: sessionId)
    }
  }

  // MARK: Session lifecycle

  /// Ends a subscription on this phone. It tells the host when the socket is
  /// live. The end offsets stay; the transport decides whether to drop them.
  func unsubscribe(sessionId: String) {
    guard desired.contains(sessionId) else { return }
    if hooks.isLive() {
      hooks.sendEnvelope("terminal_unsubscribe", sessionId, ["sessionId": sessionId])
    }
    desired.remove(sessionId)
    subscribed.remove(sessionId)
    hydrated.remove(sessionId)
    requestTokens.removeValue(forKey: sessionId)
    lastSize.removeValue(forKey: sessionId)
    inputTimeouts.removeValue(forKey: sessionId)?.cancel()
    inputQueues.removeValue(forKey: sessionId)
  }

  /// Clears what belongs to one socket: subscriptions, requests and pending
  /// acks. Queued input survives, and the next subscribe resends it.
  func resetForNewSocket() {
    subscribed.removeAll()
    requestTokens.removeAll()
    for task in inputTimeouts.values {
      task.cancel()
    }
    inputTimeouts.removeAll()
    for sessionId in Array(inputQueues.keys) {
      inputQueues[sessionId]?.prepareForReconnect()
    }
  }

  /// Applies the host's `terminalInputAck` feature from hello_ok. With no
  /// config, the retry window is `retryWindowWithoutConfig`.
  func applyInputAckFeature(enabled: Bool, config: [String: Any]?, retryWindowWithoutConfig: Double) {
    acknowledgementsEnabled = enabled
    if enabled, let config {
      retryWindowMilliseconds = max(1_000, (config["retryWindowMs"] as? NSNumber)?.doubleValue ?? 60_000)
      maximumOutstanding = min(
        SyncTerminalInputQueue.defaultMaximumItemCount,
        max(1, (config["maxOutstanding"] as? NSNumber)?.intValue ?? 64)
      )
    } else {
      retryWindowMilliseconds = retryWindowWithoutConfig
      maximumOutstanding = SyncTerminalInputQueue.defaultMaximumItemCount
    }
  }

  /// Forgets every session: the focused sync service does this when it
  /// leaves a project. Handlers stay attached.
  func forgetAllSessions() {
    requestTokens.removeAll()
    desired.removeAll()
    subscribed.removeAll()
    hydrated.removeAll()
    for task in inputTimeouts.values { task.cancel() }
    inputTimeouts.removeAll()
    inputQueues.removeAll()
    endOffsets.removeAll()
    gapRecovery.removeAll()
  }

  /// Remembers the size and sends it when the socket is live.
  func sendResize(sessionId: String, cols: Int, rows: Int) {
    guard !sessionId.isEmpty, cols > 0, rows > 0 else { return }
    lastSize[sessionId] = (cols, rows)
    guard hooks.isLive() else { return }
    hooks.sendEnvelope("terminal_resize", sessionId, [
      "sessionId": sessionId,
      "cols": cols,
      "rows": rows,
    ])
  }
}
