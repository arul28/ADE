import Foundation

/// Log window for one warm chat. These methods run on ChatThreadEngine's
/// executor. Persistence stays ordered behind enqueuePersist, and a log
/// change only marks transcript work. scheduleFold still lives on the actor.
extension ChatThreadEngine {
  func applyCached(meta: ChatLogSessionMeta?, events: [ChatLogStoredEvent]) {
    guard !sessionDeleted else { return }
    if let cachedGeneration = meta?.generation, let generation, cachedGeneration != generation {
      // The host already told us a newer generation; this disk read is stale.
      return
    }
    if generation == nil { generation = meta?.generation }
    if let meta {
      if let oldest = meta.oldestSequence {
        diskOldestSequence = min(diskOldestSequence ?? oldest, oldest)
      }
      if !hostSnapshotReceived {
        hasOlderHistory = meta.hasOlder
        olderByteCursor = meta.olderCursor
      }
    }
    var outcomes: [InsertOutcome] = []
    var appended: [AgentChatEventEnvelope] = []
    let decoder = JSONDecoder()
    for stored in events {
      guard let envelope = try? decoder.decode(AgentChatEventEnvelope.self, from: stored.payload) else { continue }
      let entry = LogEntry(envelope: envelope, raw: stored.payload, sequence: stored.sequence)
      // Disk never overrides what the host already delivered.
      let outcome = insertSequenced(entry, sequenceStart: nil, replaceExisting: false)
      outcomes.append(outcome)
      if case .appended = outcome { appended.append(envelope) }
    }
    if !events.isEmpty { hasDiskRows = true }
    noteLogChange(outcomes: outcomes, appended: appended)
  }

  func applySnapshot(_ input: ChatThreadSnapshotInput) {
    hostSupportsChatLogV2 = input.hostSupportsChatLogV2
    loadFailure = nil
    if input.sessionFound == false {
      clearLog()
      sessionDeleted = true
      hostSnapshotReceived = true
      enqueuePersist(.drop)
      pendingTranscript = .full
      pendingTimeline = .rebuild
      pendingUrgent = true
      return
    }
    sessionDeleted = false
    if let incoming = input.historyGeneration {
      if let generation, generation != incoming {
        clearLog()
        pendingHistoryReset = true
        // The store drops its rows itself when it sees a new generation.
      }
      generation = incoming
    }

    if let turnActive = input.turnActive {
      hostTurnActiveHint = turnActive
    } else if !input.resumed {
      hostTurnActiveHint = nil
    }

    var outcomes: [InsertOutcome] = []
    var appended: [AgentChatEventEnvelope] = []
    var persisted: [ChatLogStoredEvent] = []

    if input.resumed {
      for event in input.events {
        let outcome = insertLive(event, outcomes: &outcomes, appended: &appended)
        if outcome, let stored = storedEvent(event) { persisted.append(stored) }
      }
      if !persisted.isEmpty {
        enqueuePersist(.append(persisted, generation: generation))
      }
    } else {
      let sequencedEvents = input.events.filter { $0.envelope.sequence != nil }
      let firstSequence = sequencedEvents.compactMap { $0.sequenceStart ?? $0.envelope.sequence }.min()
      let lastSequence = sequencedEvents.compactMap(\.envelope.sequence).max()
      if let firstSequence, let lastSequence {
        let cachedBelow = sequenced.last(where: { ($0.sequence ?? 0) < firstSequence })?.sequence
        // A hole between the newest cached row below the snapshot and the
        // snapshot itself means rows are missing in the middle: treat it as
        // a gap so the older rows are never shown out of order.
        let hole = cachedBelow.map { $0 < firstSequence - 1 } ?? false
        let dropBelow = input.gap || hole
        let before = sequenced.count
        sequenced.removeAll { entry in
          guard let sequence = entry.sequence else { return false }
          if sequence >= firstSequence && sequence <= lastSequence { return true }
          return dropBelow && sequence < firstSequence
        }
        if sequenced.count != before { outcomes.append(.rewritten) }
        for event in sequencedEvents {
          _ = insertLive(event, outcomes: &outcomes, appended: &appended)
          if let stored = storedEvent(event) { persisted.append(stored) }
        }
        // Rows newer than the snapshot survive in memory; the store's
        // replaceRange is authoritative for everything >= first, so re-add
        // them after it.
        let newer = sequenced.filter { ($0.sequence ?? 0) > lastSequence }.compactMap(storedEvent)
        if dropBelow {
          enqueuePersist(.dropBelow(firstSequence))
        }
        enqueuePersist(.replaceRange(
          from: firstSequence,
          events: persisted + newer,
          generation: generation,
          hasOlder: resolvedHasOlder(input, dropBelow: dropBelow),
          olderCursor: input.hostSupportsChatLogV2 ? nil : snapshotByteCursor(input)
        ))
      } else if input.gap {
        if !sequenced.isEmpty { outcomes.append(.rewritten) }
        sequenced.removeAll()
        enqueuePersist(.drop)
      }
      // The snapshot's own unsequenced rows replace the live tail.
      unsequenced.removeAll()
      unsequencedKeys.removeAll()
      for event in input.events where event.envelope.sequence == nil {
        appendUnsequenced(event.envelope, raw: event.raw, outcomes: &outcomes, appended: &appended)
      }
      outcomes.append(.rewritten)

      hasOlderHistory = resolvedHasOlder(input, dropBelow: false)
      olderByteCursor = snapshotByteCursor(input)
      if olderState == .exhausted || olderState == .idle {
        olderState = hasOlderHistory ? .idle : .exhausted
      }
    }

    if !input.pinnedEvents.isEmpty {
      var pinnedStored: [ChatLogStoredEvent] = []
      for event in input.pinnedEvents {
        if insertLive(event, outcomes: &outcomes, appended: &appended),
           let stored = storedEvent(event) {
          pinnedStored.append(stored)
        }
      }
      if !pinnedStored.isEmpty {
        enqueuePersist(.append(pinnedStored, generation: generation))
      }
    }

    if !input.events.isEmpty || !input.pinnedEvents.isEmpty { hasHostRows = true }
    let firstHostSnapshot = !hostSnapshotReceived
    hostSnapshotReceived = true

    // Older host: a byte-capped tail can start mid-turn. Pull one older page
    // before the first host frame so the turn is not shown headless.
    if !input.hostSupportsChatLogV2,
       !input.resumed,
       firstHostSnapshot,
       !boundaryPageRequested,
       hasOlderHistory,
       let first = input.events.first,
       !chatThreadEnvelopeIsTurnBoundary(first.envelope) {
      awaitingBoundaryPage = true
      boundaryPageRequested = true
      sink?(.needsBoundaryPage)
    }

    noteLogChange(outcomes: outcomes, appended: appended)
    pendingUrgent = true
  }

  func applyLive(_ events: [ChatThreadLiveEvent]) {
    guard !sessionDeleted else { return }
    var outcomes: [InsertOutcome] = []
    var appended: [AgentChatEventEnvelope] = []
    var persisted: [ChatLogStoredEvent] = []
    for event in events {
      if event.historyInvalidated {
        noteLogChange(outcomes: outcomes, appended: appended)
        if !persisted.isEmpty { enqueuePersist(.append(persisted, generation: generation)) }
        invalidate(reason: "historyInvalidated", notify: true)
        return
      }
      let before = hostTurnActiveHint
      switch event.envelope.event {
      case .status(let turnStatus, _, _):
        hostTurnActiveHint = turnStatus == .started
      case .done:
        hostTurnActiveHint = false
      default:
        break
      }
      if before != hostTurnActiveHint { pendingUrgent = true }
      if insertLive(event, outcomes: &outcomes, appended: &appended),
         let stored = storedEvent(event) {
        persisted.append(stored)
      }
    }
    if !persisted.isEmpty {
      hasHostRows = true
      enqueuePersist(.append(persisted, generation: generation))
    }
    noteLogChange(outcomes: outcomes, appended: appended)
  }

  func applyOlderPage(_ page: ChatThreadOlderPageInput) {
    let wasAwaitingBoundary = awaitingBoundaryPage
    awaitingBoundaryPage = false
    if let failure = page.failureMessage {
      olderState = .failed(failure)
      pendingTimeline = max(pendingTimeline, .presentationOnly)
      pendingUrgent = wasAwaitingBoundary
      return
    }
    if page.unavailable {
      olderState = .failed("Could not load earlier messages from this machine.")
      pendingTimeline = max(pendingTimeline, .presentationOnly)
      return
    }
    guard page.sessionFound else {
      hasOlderHistory = false
      olderState = .exhausted
      pendingTimeline = max(pendingTimeline, .presentationOnly)
      return
    }
    if let pageGeneration = page.historyGeneration, let generation, pageGeneration != generation {
      invalidate(reason: "generation changed while paging", notify: true)
      return
    }
    var outcomes: [InsertOutcome] = []
    var appended: [AgentChatEventEnvelope] = []
    var persisted: [ChatLogStoredEvent] = []
    let decoderFreeEvents = page.events.filter { $0.envelope.sequence != nil }
    for event in decoderFreeEvents {
      guard let sequence = event.envelope.sequence else { continue }
      let outcome = insertSequenced(
        LogEntry(envelope: event.envelope, raw: event.raw, sequence: sequence),
        sequenceStart: event.sequenceStart,
        replaceExisting: false
      )
      outcomes.append(outcome)
      if case .appended = outcome { appended.append(event.envelope) }
      if case .duplicate = outcome { continue }
      if let stored = storedEvent(event) { persisted.append(stored) }
    }
    // Unsequenced rows on a page (very old hosts) have no key; they are only
    // kept when the log has nothing sequenced to order them against.
    if sequenced.isEmpty {
      for event in page.events where event.envelope.sequence == nil {
        appendUnsequenced(event.envelope, raw: event.raw, outcomes: &outcomes, appended: &appended)
      }
    }
    hasOlderHistory = page.hasMore
    if !hostSupportsChatLogV2 {
      olderByteCursor = page.hasMore ? page.startOffset : 0
    }
    olderState = page.hasMore ? .idle : .exhausted
    if !persisted.isEmpty {
      enqueuePersist(.append(persisted, generation: generation))
    }
    enqueuePersist(.updateMeta(
      generation: generation,
      hasOlder: hasOlderHistory,
      olderCursor: hostSupportsChatLogV2 ? nil : olderByteCursor
    ))
    // A page only ever adds rows above the window: never a tail append.
    if !outcomes.isEmpty { outcomes.append(.rewritten) }
    noteLogChange(outcomes: outcomes, appended: appended)
    pendingTimeline = max(pendingTimeline, .presentationOnly)
    if wasAwaitingBoundary { pendingUrgent = true }
  }

  func invalidate(reason: String, notify: Bool) {
    chatThreadLog.notice("thread invalidate key=\(self.key.description, privacy: .public) reason=\(reason, privacy: .public)")
    clearLog()
    generation = nil
    hostSnapshotReceived = false
    hasHostRows = false
    hasDiskRows = false
    hasOlderHistory = false
    olderByteCursor = nil
    diskOldestSequence = nil
    olderState = .idle
    pendingHistoryReset = true
    enqueuePersist(.drop)
    pendingTranscript = .full
    pendingTimeline = .rebuild
    pendingUrgent = true
    if notify { sink?(.needsSnapshot(reason: reason)) }
  }

  func clearLog() {
    sequenced.removeAll()
    unsequenced.removeAll()
    unsequencedKeys.removeAll()
    pendingTranscript = .full
    pendingTimeline = .rebuild
  }

  /// Insert one host event (live, resume, snapshot row). Returns whether the
  /// event changed the log.
  @discardableResult
  func insertLive(
    _ event: ChatThreadLiveEvent,
    outcomes: inout [InsertOutcome],
    appended: inout [AgentChatEventEnvelope]
  ) -> Bool {
    guard let sequence = event.envelope.sequence else {
      return appendUnsequenced(event.envelope, raw: event.raw, outcomes: &outcomes, appended: &appended)
    }
    let outcome = insertSequenced(
      LogEntry(envelope: event.envelope, raw: event.raw, sequence: sequence),
      sequenceStart: event.sequenceStart,
      replaceExisting: true
    )
    outcomes.append(outcome)
    switch outcome {
    case .appended:
      appended.append(event.envelope)
      return true
    case .rewritten:
      return true
    case .duplicate:
      return false
    }
  }

  @discardableResult
  func appendUnsequenced(
    _ envelope: AgentChatEventEnvelope,
    raw: Data,
    outcomes: inout [InsertOutcome],
    appended: inout [AgentChatEventEnvelope]
  ) -> Bool {
    let dedupeKey = "\(envelope.timestamp)|\(envelope.event.typeName)|\(envelope.id)"
    guard unsequencedKeys.insert(dedupeKey).inserted else {
      outcomes.append(.duplicate)
      return false
    }
    unsequenced.append(LogEntry(envelope: envelope, raw: raw, sequence: nil))
    outcomes.append(.appended)
    appended.append(envelope)
    return true
  }

  func insertSequenced(_ entry: LogEntry, sequenceStart: Int?, replaceExisting: Bool) -> InsertOutcome {
    guard let sequence = entry.sequence else { return .duplicate }
    var rewrote = false
    // A folded replay row covers [sequenceStart, sequence]: drop the deltas
    // it replaces so their text is not merged in twice.
    if let sequenceStart, sequenceStart < sequence, replaceExisting {
      let lower = lowerBound(sequenceStart)
      let upper = lowerBound(sequence)
      if lower < upper {
        sequenced.removeSubrange(lower..<upper)
        rewrote = true
      }
    }
    let index = lowerBound(sequence)
    if index < sequenced.count, sequenced[index].sequence == sequence {
      if sequenced[index].envelope == entry.envelope { return rewrote ? .rewritten : .duplicate }
      guard replaceExisting else { return rewrote ? .rewritten : .duplicate }
      sequenced[index] = entry
      return .rewritten
    }
    let isTail = index == sequenced.count
    sequenced.insert(entry, at: index)
    // Unsequenced live rows are ordered after every sequenced row; a new
    // sequenced row arriving behind them is still a tail append for the
    // transcript merge, which orders by timestamp.
    return (isTail && !rewrote) ? .appended : .rewritten
  }

  func lowerBound(_ sequence: Int) -> Int {
    var low = 0
    var high = sequenced.count
    while low < high {
      let mid = (low + high) / 2
      if (sequenced[mid].sequence ?? Int.min) < sequence {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return low
  }

  func noteLogChange(outcomes: [InsertOutcome], appended: [AgentChatEventEnvelope]) {
    guard !outcomes.isEmpty else { return }
    let rewritten = outcomes.contains { if case .rewritten = $0 { return true } else { return false } }
    if rewritten {
      pendingTranscript = .full
    } else if !appended.isEmpty {
      switch pendingTranscript {
      case .none:
        pendingTranscript = .appended(appended)
      case .appended(let existing):
        pendingTranscript = .appended(existing + appended)
      case .full:
        break
      }
    }
  }

  func storedEvent(_ event: ChatThreadLiveEvent) -> ChatLogStoredEvent? {
    guard let sequence = event.envelope.sequence else { return nil }
    return ChatLogStoredEvent(sequence: sequence, timestamp: event.envelope.timestamp, payload: event.raw)
  }

  func storedEvent(_ entry: LogEntry) -> ChatLogStoredEvent? {
    guard let sequence = entry.sequence else { return nil }
    return ChatLogStoredEvent(sequence: sequence, timestamp: entry.envelope.timestamp, payload: entry.raw)
  }

  func resolvedHasOlder(_ input: ChatThreadSnapshotInput, dropBelow: Bool) -> Bool {
    if let hasOlder = input.hasOlderHistory { return hasOlder }
    return (input.tailStartOffset ?? 0) > 0
  }

  func snapshotByteCursor(_ input: ChatThreadSnapshotInput) -> Int? {
    syncChatSubscribeHistoryCursor(
      hasOlderHistory: input.hasOlderHistory,
      tailStartOffset: input.tailStartOffset,
      cursorKind: input.cursorKind
    )
  }

  func enqueuePersist(_ op: PersistOp) {
    guard store != nil else { return }
    persistContinuation.yield(op)
  }
}
