import Foundation
import CoreGraphics
import OSLog

/// What an engine tells its owner. Delivered from the engine's executor; the
/// registry hops to the main actor.
enum ChatThreadEngineSignal: @unchecked Sendable {
  case frame(ChatThreadFrame)
  /// The engine dropped its history (historyInvalidated, generation change on
  /// a page) and needs a fresh full snapshot.
  case needsSnapshot(reason: String)
  /// Older host, snapshot starts mid-turn: fetch one older page before the
  /// first host frame is shown.
  case needsBoundaryPage
}

/// One warm chat: owns the event-log window, folds it off the main actor into
/// the render-ready timeline, and persists sequenced events to `ChatLogStore`.
///
/// Log rules (contract "Engine internals"):
/// - Sequenced events are keyed and ordered by the durable envelope
///   `sequence`; a redelivery with an equal envelope is a no-op.
/// - Unsequenced live events live in a separate tail, deduped by
///   timestamp + type + id, dropped by the next snapshot, never persisted.
/// - A full snapshot is authoritative for `[first, last]` of its sequences;
///   `gap:true` (or a hole between the cache and the snapshot) drops every
///   cached row below it so nothing is ever shown out of order.
/// - A folded replay row (`sequenceStart`) replaces the deltas it covers.
actor ChatThreadEngine {
  let key: ChatThreadKey

  // MARK: Log

  private struct LogEntry {
    var envelope: AgentChatEventEnvelope
    var raw: Data
    /// Envelope `sequence` (nil for unsequenced live rows).
    var sequence: Int?
  }

  private enum InsertOutcome {
    case appended
    case duplicate
    /// Anything that is not a pure tail append: a middle insert, a replaced
    /// row, a folded row that swallowed earlier deltas.
    case rewritten
  }

  private var sequenced: [LogEntry] = []
  private var unsequenced: [LogEntry] = []
  private var unsequencedKeys: Set<String> = []

  private var generation: Int?
  private var hostSnapshotReceived = false
  private var hasDiskRows = false
  private var hasHostRows = false
  private var sessionDeleted = false
  private var hasOlderHistory = false
  /// Byte cursor for hosts without `chatLogV2`.
  private var olderByteCursor: Int?
  /// Oldest sequence the disk cache holds (from meta), used to page from disk
  /// before asking the host.
  private var diskOldestSequence: Int?
  private var hostSupportsChatLogV2 = false
  private var olderState: ChatThreadOlderHistoryState = .idle
  private var hostTurnActiveHint: Bool?
  private var awaitingBoundaryPage = false
  private var boundaryPageRequested = false
  private var loadFailure: String?
  private var pendingHistoryReset = false

  // MARK: Fold state

  private enum TranscriptWork {
    case none
    case appended([AgentChatEventEnvelope])
    case full
  }

  private enum TimelineWork: Int, Comparable {
    case none = 0
    /// Frame inputs moved (summary, session status, paging window, optimistic
    /// steers or answers); the snapshot did not.
    case presentationOnly = 1
    /// The snapshot must be refolded: `timelineFold` resumes from its
    /// checkpoint, so this costs the envelopes after it plus the assembly.
    case rebuild = 2

    static func < (lhs: TimelineWork, rhs: TimelineWork) -> Bool { lhs.rawValue < rhs.rawValue }
  }

  private enum GoalState {
    case untouched
    case set(AgentChatClaudeGoal)
    case cleared
  }

  private var subagentFilter = WorkSubagentTranscriptFilter()
  private var transcript: [WorkChatEnvelope] = []
  private var transcriptRevision = 0
  private var goalState: GoalState = .untouched
  private var snapshot = WorkChatTimelineSnapshot.empty
  /// Resumable timeline fold: a rebuild re-folds only the envelopes after its
  /// checkpoint. Told about every transcript change below.
  private var timelineFold = ChatThreadTimelineFold()
  /// Merge-key lookup for `transcript`, kept across appends.
  private var transcriptKeyIndex: WorkChatTranscriptKeyIndex?
  private var toolActivity = WorkTurnToolActivityIndex(
    completedByTurnId: [:],
    completedFilesByTurnId: [:],
    claimedInlineGroupIds: [],
    active: nil
  )
  private var presentation = WorkTimelinePresentation.empty
  private let assistantPreviewCache = WorkAssistantPreviewCache()
  private var visibleTimelineCount = workTimelinePageSize
  private var overlays = ChatThreadOverlays()
  private var activityPresentationCache: (revision: Int, value: WorkActivityIndicator.Presentation?)?

  private var pendingTranscript: TranscriptWork = .none
  private var pendingTimeline: TimelineWork = .none
  private var pendingUrgent = false
  private var foldScheduled = false
  private var frameRevision = 0
  private var lastFrame: ChatThreadFrame?

  // MARK: Output + persistence

  private var sink: (@Sendable (ChatThreadEngineSignal) -> Void)?
  private let store: ChatLogStore?

  private enum PersistOp: @unchecked Sendable {
    case touch
    case append([ChatLogStoredEvent], generation: Int?)
    case replaceRange(from: Int, events: [ChatLogStoredEvent], generation: Int?, hasOlder: Bool, olderCursor: Int?)
    case dropBelow(Int)
    case updateMeta(generation: Int?, hasOlder: Bool, olderCursor: Int?)
    case drop
    case barrier(CheckedContinuation<Void, Never>)
  }

  private let persistContinuation: AsyncStream<PersistOp>.Continuation
  private let persistTask: Task<Void, Never>

  init(
    key: ChatThreadKey,
    store: ChatLogStore?,
    sink: (@Sendable (ChatThreadEngineSignal) -> Void)? = nil
  ) {
    self.key = key
    self.store = store
    self.sink = sink
    let (stream, continuation) = AsyncStream.makeStream(of: PersistOp.self)
    self.persistContinuation = continuation
    let logKey = key.logKey
    // One consumer, so store writes land in the order the engine issued them.
    self.persistTask = Task.detached(priority: .utility) {
      for await op in stream {
        switch op {
        case .barrier(let continuation):
          if let store { await store.flush() }
          continuation.resume()
        case .touch:
          await store?.touch(logKey)
        case .append(let events, let generation):
          await store?.append(logKey, events: events, generation: generation)
        case .replaceRange(let from, let events, let generation, let hasOlder, let olderCursor):
          await store?.replaceRange(
            logKey,
            fromSequence: from,
            with: events,
            generation: generation,
            hasOlder: hasOlder,
            olderCursor: olderCursor
          )
        case .dropBelow(let sequence):
          await store?.dropBelow(logKey, sequence: sequence)
        case .updateMeta(let generation, let hasOlder, let olderCursor):
          await store?.updateMeta(logKey) { meta in
            if let generation { meta.generation = generation }
            meta.hasOlder = hasOlder
            meta.olderCursor = olderCursor
          }
        case .drop:
          await store?.drop(logKey)
        }
      }
    }
  }

  deinit {
    persistContinuation.finish()
  }

  func setSink(_ sink: (@Sendable (ChatThreadEngineSignal) -> Void)?) {
    self.sink = sink
  }

  // MARK: - Public API

  /// Load the disk tail: a small first slice for the first paint, then the
  /// rest of what the store holds.
  func loadCache(firstSliceEvents: Int = 200, fullEvents: Int = 5_000) async {
    guard let store else { return }
    enqueuePersist(.touch)
    let logKey = key.logKey
    let first = await store.loadTail(logKey, maxEvents: firstSliceEvents, maxBytes: 512 * 1024)
    ingest(.cached(meta: first.meta, events: first.events))
    flushNow()
    // The first slice is capped by count and bytes; read the rest only when
    // the store holds more than it returned.
    guard (first.meta?.eventCount ?? 0) > first.events.count else { return }
    let full = await store.loadTail(logKey, maxEvents: fullEvents, maxBytes: 2_000_000)
    ingest(.cached(meta: full.meta, events: full.events))
  }

  func ingest(_ input: ChatThreadIngest) {
    switch input {
    case .cached(let meta, let events):
      applyCached(meta: meta, events: events)
    case .snapshot(let snapshotInput):
      applySnapshot(snapshotInput)
    case .live(let events):
      applyLive(events)
    case .olderPage(let page):
      applyOlderPage(page)
    case .invalidate(let reason):
      invalidate(reason: reason, notify: false)
    }
    scheduleFold()
  }

  /// Apply overlay changes. A local echo, an optimistic steer or an answered
  /// input folds right away, so it is in the frame returned to the tap
  /// handler. Anything else is coalesced: folded with whatever else is pending
  /// on the next scheduled fold (and, before the first frame, by the first
  /// fold that has data), delivered through the sink. Changes no frame reader
  /// renders from (viewport width, card expansion) fold nothing at all; the
  /// next frame carries them.
  @discardableResult
  func setOverlays(_ next: ChatThreadOverlays) -> ChatThreadFrame? {
    let previous = overlays
    guard next != previous else { return lastFrame }
    overlays = next

    var work: TimelineWork = .none
    var urgent = false
    if next.localEchoMessages != previous.localEchoMessages {
      work = .rebuild
      urgent = true
    }
    if next.artifacts != previous.artifacts
      || next.summary.usageLimitTurnId != previous.summary.usageLimitTurnId {
      work = .rebuild
    }
    if next.optimisticPendingSteers != previous.optimisticPendingSteers
      || next.optimisticallyAnsweredInputIds != previous.optimisticallyAnsweredInputIds {
      work = max(work, .presentationOnly)
      urgent = true
    }
    if next.visibleTimelineCount != previous.visibleTimelineCount {
      visibleTimelineCount = max(0, next.visibleTimelineCount)
      work = max(work, .presentationOnly)
    }
    if next.summary != previous.summary
      || next.expandedTurnIds != previous.expandedTurnIds
      || next.sessionStatus != previous.sessionStatus
      || next.turnActiveHint != previous.turnActiveHint {
      work = max(work, .presentationOnly)
    }
    guard work != .none else { return lastFrame }
    pendingTimeline = max(pendingTimeline, work)
    if urgent {
      pendingUrgent = true
      return flushNow()
    }
    // Before the first frame there is nothing on screen to update: the fold
    // that first has data (disk slice or snapshot) picks these up.
    if lastFrame != nil { scheduleFold() }
    return nil
  }

  /// Fold anything pending now and return the newest frame.
  @discardableResult
  func flush() -> ChatThreadFrame? {
    flushNow()
  }

  /// Wait until every store write issued so far has reached the store and the
  /// store has flushed it (tests, background transition).
  func flushPersistence() async {
    guard store != nil else { return }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      persistContinuation.yield(.barrier(continuation))
    }
  }

  var currentFrame: ChatThreadFrame? { lastFrame }

  /// How the timeline fold produced its last snapshot (tests, diagnostics).
  var lastTimelinePass: ChatThreadTimelineFold.Pass { timelineFold.lastPass }

  /// `sinceSequence`/`generation` for the next `chat_subscribe`.
  var resumePoint: ChatThreadResumePoint? {
    guard let maxSequence = sequenced.last?.sequence else { return nil }
    return ChatThreadResumePoint(sinceSequence: maxSequence, generation: generation)
  }

  var hasLiveTurn: Bool {
    lastFrame.map { $0.isStreamingTurn || $0.transcriptIndicatesActiveTurn } ?? false
  }

  /// A snapshot request went unanswered past every resend.
  func markLoadFailed(_ message: String?) {
    loadFailure = workChatTranscriptFailureMessage(message ?? "")
    pendingTimeline = max(pendingTimeline, .presentationOnly)
    pendingUrgent = true
    scheduleFold()
  }

  /// Page older history from disk first. Returns the number of events added.
  func loadOlderFromDisk(maxEvents: Int = 200) async -> Int {
    guard let store else { return 0 }
    guard let oldest = sequenced.first?.sequence else { return 0 }
    if let diskOldest = diskOldestSequence, diskOldest >= oldest { return 0 }
    let events = await store.loadBefore(key.logKey, beforeSequence: oldest, maxEvents: maxEvents)
    guard !events.isEmpty else {
      diskOldestSequence = oldest
      return 0
    }
    let before = sequenced.count
    applyCached(meta: nil, events: events)
    scheduleFold()
    return sequenced.count - before
  }

  /// Reserve the next host page. Nil when nothing older exists or a page is
  /// already in flight.
  func beginOlderHostRequest() -> ChatThreadOlderRequest? {
    guard olderState != .loading, hasOlderHistory else { return nil }
    let request: ChatThreadOlderRequest?
    if hostSupportsChatLogV2, let oldest = sequenced.first?.sequence ?? diskOldestSequence {
      request = .beforeSequence(oldest)
    } else if let cursor = olderByteCursor, cursor > 0 {
      request = .beforeOffset(cursor)
    } else {
      request = nil
    }
    guard let request else { return nil }
    olderState = .loading
    pendingTimeline = max(pendingTimeline, .presentationOnly)
    scheduleFold()
    return request
  }

  // MARK: - Log application

  private func applyCached(meta: ChatLogSessionMeta?, events: [ChatLogStoredEvent]) {
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

  private func applySnapshot(_ input: ChatThreadSnapshotInput) {
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

  private func applyLive(_ events: [ChatThreadLiveEvent]) {
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

  private func applyOlderPage(_ page: ChatThreadOlderPageInput) {
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

  private func invalidate(reason: String, notify: Bool) {
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

  private func clearLog() {
    sequenced.removeAll()
    unsequenced.removeAll()
    unsequencedKeys.removeAll()
    pendingTranscript = .full
    pendingTimeline = .rebuild
  }

  /// Insert one host event (live, resume, snapshot row). Returns whether the
  /// event changed the log.
  @discardableResult
  private func insertLive(
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
  private func appendUnsequenced(
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

  private func insertSequenced(_ entry: LogEntry, sequenceStart: Int?, replaceExisting: Bool) -> InsertOutcome {
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

  private func lowerBound(_ sequence: Int) -> Int {
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

  private func noteLogChange(outcomes: [InsertOutcome], appended: [AgentChatEventEnvelope]) {
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

  private func storedEvent(_ event: ChatThreadLiveEvent) -> ChatLogStoredEvent? {
    guard let sequence = event.envelope.sequence else { return nil }
    return ChatLogStoredEvent(sequence: sequence, timestamp: event.envelope.timestamp, payload: event.raw)
  }

  private func storedEvent(_ entry: LogEntry) -> ChatLogStoredEvent? {
    guard let sequence = entry.sequence else { return nil }
    return ChatLogStoredEvent(sequence: sequence, timestamp: entry.envelope.timestamp, payload: entry.raw)
  }

  private func resolvedHasOlder(_ input: ChatThreadSnapshotInput, dropBelow: Bool) -> Bool {
    if let hasOlder = input.hasOlderHistory { return hasOlder }
    return (input.tailStartOffset ?? 0) > 0
  }

  private func snapshotByteCursor(_ input: ChatThreadSnapshotInput) -> Int? {
    syncChatSubscribeHistoryCursor(
      hasOlderHistory: input.hasOlderHistory,
      tailStartOffset: input.tailStartOffset,
      cursorKind: input.cursorKind
    )
  }

  private func enqueuePersist(_ op: PersistOp) {
    guard store != nil else { return }
    persistContinuation.yield(op)
  }

  // MARK: - Fold

  private func scheduleFold() {
    guard !foldScheduled else { return }
    guard case .none = pendingTranscript, pendingTimeline == .none else {
      foldScheduled = true
      Task { [weak self] in await self?.runScheduledFold() }
      return
    }
  }

  private func runScheduledFold() {
    foldScheduled = false
    flushNow()
  }

  @discardableResult
  private func flushNow() -> ChatThreadFrame? {
    let hasTranscriptWork: Bool = {
      if case .none = pendingTranscript { return false }
      return true
    }()
    guard hasTranscriptWork || pendingTimeline != .none else { return lastFrame }
    let state = chatThreadSignposter.beginInterval("thread.fold", id: chatThreadSignposter.makeSignpostID())
    defer { chatThreadSignposter.endInterval("thread.fold", state) }

    let transcriptWork = pendingTranscript
    var timelineWork = pendingTimeline
    pendingTranscript = .none
    pendingTimeline = .none

    // 1. Transcript.
    switch transcriptWork {
    case .none:
      break
    case .full:
      rebuildTranscript()
      timelineWork = .rebuild
    case .appended(let envelopes):
      if let admitted = subagentFilter.admit(envelopes) {
        let mapped = admitted.map(makeWorkChatEnvelope(from:)).sorted(by: workChatEnvelopeOrderedBefore)
        if mapped.contains(where: chatThreadEnvelopeGraduatesSteer) {
          // A delivered steer retires its queued twin; the prune only runs on
          // the full path, same as the legacy merge.
          rebuildTranscript()
          timelineWork = .rebuild
        } else if !mapped.isEmpty {
          let appended = appendWorkChatTranscriptsTracked(base: transcript, live: mapped, keyIndex: &transcriptKeyIndex)
          transcript = appended.transcript
          timelineFold.transcriptChanged(from: appended.firstChangedIndex)
          transcriptRevision &+= 1
          for envelope in mapped { advanceGoalState(with: envelope) }
          timelineWork = .rebuild
        }
      } else {
        rebuildTranscript()
        timelineWork = .rebuild
      }
    }

    // 2. Timeline snapshot: the resumed fold equals a full
    // `buildWorkChatTimelineSnapshot`, so every change takes it.
    if timelineWork == .rebuild {
      rebuildTimeline()
      toolActivity = workTurnToolActivityIndex(from: snapshot.timeline)
    }

    // 3. Presentation + frame.
    let frame = buildFrame()
    lastFrame = frame
    pendingUrgent = false
    // Older host, snapshot starts mid-turn: hold host frames until the
    // boundary page lands (or fails). A `.disk` frame may already be shown.
    if !awaitingBoundaryPage {
      chatThreadSignposter.emitEvent("thread.frame.emit", "rev=\(frame.revision) rows=\(frame.presentation.renderEntries.count)")
      sink?(.frame(frame))
    }
    return frame
  }

  /// The disk cache holds rows older than the in-memory window.
  private var diskHoldsOlderRows: Bool {
    guard let diskOldest = diskOldestSequence, let memoryOldest = sequenced.first?.sequence else { return false }
    return diskOldest < memoryOldest
  }

  private func rebuildTranscript() {
    subagentFilter.reset()
    let entries = sequenced.map(\.envelope) + unsequenced.map(\.envelope)
    let admitted = subagentFilter.admit(entries) ?? []
    let mapped = admitted.map(makeWorkChatEnvelope(from:)).sorted(by: workChatEnvelopeOrderedBefore)
    transcript = pruneResolvedQueuedSteerEnvelopes(mergeWorkChatTranscripts(base: [], live: mapped))
    transcriptKeyIndex = nil
    timelineFold.invalidate(reason: "transcript rebuilt")
    transcriptRevision &+= 1
    goalState = .untouched
    for envelope in transcript { advanceGoalState(with: envelope) }
  }

  private func advanceGoalState(with envelope: WorkChatEnvelope) {
    switch envelope.event {
    case .claudeGoalUpdated(let goal, _):
      goalState = .set(goal)
    case .claudeGoalCleared:
      goalState = .cleared
    default:
      break
    }
  }

  private func rebuildTimeline() {
    if transcript.isEmpty && overlays.localEchoMessages.isEmpty && overlays.artifacts.isEmpty {
      snapshot = .empty
    } else {
      snapshot = timelineFold.snapshot(
        transcript: transcript,
        artifacts: overlays.artifacts,
        localEchoMessages: overlays.localEchoMessages,
        usageLimitTurnId: overlays.summary.usageLimitTurnId
      )
    }
  }

  private func buildFrame() -> ChatThreadFrame {
    let summary = overlays.summary
    let sessionStatus = overlays.sessionStatus ?? ""
    let effectiveHint = hostTurnActiveHint ?? overlays.turnActiveHint
    let rowEnded = chatThreadRowEndedAfterLatestTranscript(
      sessionStatus: sessionStatus,
      rowEndedAtCandidates: summary.rowEndedAtCandidates,
      latestTranscriptAt: snapshot.latestTranscriptTimestamp
    )
    let isStreaming = workChatIsStreaming(
      sessionStatus: sessionStatus,
      isLive: summary.isLive,
      transcriptIndicatesActiveTurn: snapshot.transcriptIndicatesActiveTurn,
      liveTurnActiveHint: effectiveHint,
      transcriptLatestTurnEnded: snapshot.transcriptLatestTurnEnded,
      rowEndedAfterLatestTranscript: rowEnded
    )
    let streamingAssistantMessageId = (isStreaming && snapshot.transcriptHasInterruptibleActivity)
      ? snapshot.latestMessageAssistantId
      : nil

    let presented = workPresentedTimelineEntries(
      snapshot.timeline,
      provider: summary.effectiveProvider,
      toolActivity: toolActivity
    )
    var next = makeWorkTimelinePresentation(
      timeline: presented,
      visibleCount: visibleTimelineCount,
      provider: summary.provider,
      model: summary.model,
      modelId: summary.modelId,
      transcript: transcript,
      assistantPreviewCache: assistantPreviewCache,
      streamingAssistantMessageId: streamingAssistantMessageId,
      expandedTurnIds: overlays.expandedTurnIds
    )
    // Older history landed above the window: grow the window by what was
    // prepended so the rows on screen stay the rows on screen.
    let timelineDelta = next.timelineCount - presentation.timelineCount
    var prependedCount = 0
    if timelineDelta > 0,
       presentation.timelineFirstId != nil,
       presentation.timelineLastId != nil,
       presentation.timelineLastId == next.timelineLastId,
       presentation.timelineFirstId != next.timelineFirstId {
      prependedCount = timelineDelta
      visibleTimelineCount = workTimelineVisibleCountAfterHistoryPrepend(
        currentVisibleCount: visibleTimelineCount,
        prependedCount: timelineDelta
      )
      next = makeWorkTimelinePresentation(
        timeline: presented,
        visibleCount: visibleTimelineCount,
        provider: summary.provider,
        model: summary.model,
        modelId: summary.modelId,
        transcript: transcript,
        assistantPreviewCache: assistantPreviewCache,
        streamingAssistantMessageId: streamingAssistantMessageId,
        expandedTurnIds: overlays.expandedTurnIds
      )
    }
    presentation = next

    var rowRevisions: [String: Int] = [:]
    rowRevisions.reserveCapacity(next.renderEntries.count)
    var changed = Set<String>()
    let previousRevisions = lastFrame?.rowRevisions ?? [:]
    for entry in next.renderEntries {
      let revision = workChatTranscriptRowRevision(entry)
      rowRevisions[entry.id] = revision
      if previousRevisions[entry.id] != revision { changed.insert(entry.id) }
    }
    chatThreadWarmMarkdownCaches(next.renderEntries.suffix(48))

    let canonicalPending = snapshot.pendingInputQueue.resolved(hostPendingInputItemId: summary.pendingInputItemId)
    let pending = overlays.optimisticallyAnsweredInputIds.isEmpty
      ? canonicalPending
      : canonicalPending.filter { !overlays.optimisticallyAnsweredInputIds.contains($0.itemId) }
    let steers = mergeWorkPendingSteers(
      optimistic: overlays.optimisticPendingSteers,
      canonical: snapshot.pendingSteers
    )

    let activity: WorkActivityIndicator.Presentation?
    if isStreaming {
      if let cached = activityPresentationCache, cached.revision == transcriptRevision {
        activity = cached.value
      } else {
        activity = chatThreadActivityPresentation(transcript)
        activityPresentationCache = (transcriptRevision, activity)
      }
    } else {
      activity = nil
    }

    let goal: AgentChatClaudeGoal?
    switch goalState {
    case .untouched: goal = summary.claudeGoal
    case .set(let value): goal = value
    case .cleared: goal = nil
    }
    let latestReasoningCardId = snapshot.eventCards.last(where: { $0.kind == "reasoning" })?.id

    let loadState: WorkChatTranscriptLoadState
    if let loadFailure, snapshot.timeline.isEmpty {
      loadState = .failed(loadFailure)
    } else if sequenced.isEmpty && unsequenced.isEmpty && !hostSnapshotReceived && overlays.localEchoMessages.isEmpty {
      loadState = .loading
    } else {
      loadState = .idle
    }

    let origin: ChatThreadFrameOrigin
    switch (hasDiskRows, hasHostRows || hostSnapshotReceived) {
    case (true, true): origin = .mixed
    case (true, false): origin = .disk
    case (false, true): origin = .host
    case (false, false): origin = .none
    }

    let previous = lastFrame
    let pendingIdsChanged = previous.map { $0.pendingInputs.map(\.itemId) != pending.map(\.itemId) } ?? true
    let urgent = pendingUrgent
      || pendingIdsChanged
      || previous?.isStreamingTurn != isStreaming
      || previous?.transcriptIndicatesActiveTurn != snapshot.transcriptIndicatesActiveTurn
      || previous == nil

    frameRevision &+= 1
    let didReset = pendingHistoryReset
    pendingHistoryReset = false
    return ChatThreadFrame(
      revision: frameRevision,
      snapshot: snapshot,
      presentation: next,
      turnToolActivity: toolActivity,
      rowRevisions: rowRevisions,
      changedRowIds: changed,
      canonicalPendingInputs: canonicalPending,
      pendingInputs: pending,
      pendingSteers: steers,
      isStreamingTurn: isStreaming,
      streamingAssistantMessageId: streamingAssistantMessageId,
      activityPresentation: activity,
      claudeGoal: goal,
      latestReasoningCardId: latestReasoningCardId,
      isReasoningLive: isStreaming && latestReasoningCardId != nil,
      transcriptIndicatesActiveTurn: snapshot.transcriptIndicatesActiveTurn,
      hostTurnActiveHint: hostTurnActiveHint,
      hasOlderHistory: hasOlderHistory || diskHoldsOlderRows,
      olderHistoryState: olderState,
      loadState: loadState,
      cacheOrigin: origin,
      sessionDeleted: sessionDeleted,
      visibleTimelineCount: visibleTimelineCount,
      prependedTimelineCount: prependedCount,
      didResetHistory: didReset,
      isUrgent: urgent,
      resumePoint: resumePoint,
      cardExpansionSignature: overlays.cardExpansionSignature,
      viewportWidth: overlays.viewportWidth,
      transcript: transcript
    )
  }
}

// MARK: - Pure helpers

/// A row that starts a turn: a user message or a turn `status: started`.
func chatThreadEnvelopeIsTurnBoundary(_ envelope: AgentChatEventEnvelope) -> Bool {
  switch envelope.event {
  case .userMessage:
    return true
  case .status(let turnStatus, _, _):
    return turnStatus == .started
  default:
    return false
  }
}

/// A delivered user message carrying a steer id: it graduates a queued twin.
func chatThreadEnvelopeGraduatesSteer(_ envelope: WorkChatEnvelope) -> Bool {
  guard case .userMessage(_, _, _, let steerId, let deliveryState, _) = envelope.event,
        let steerId, !steerId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  else { return false }
  return deliveryState != "queued"
}

/// `WorkChatSessionView.sessionRowEndedAfterLatestTranscript`, as a function
/// of its inputs.
func chatThreadRowEndedAfterLatestTranscript(
  sessionStatus: String,
  rowEndedAtCandidates: [String],
  latestTranscriptAt: String?
) -> Bool {
  guard sessionStatus == "idle" || sessionStatus == "ended" else { return false }
  guard let rowEndedAt = rowEndedAtCandidates.filter({ !$0.isEmpty }).max() else { return false }
  guard let latestTranscriptAt else { return false }
  if rowEndedAt >= latestTranscriptAt { return true }
  guard let rowEndedDate = workParsedDate(rowEndedAt),
        let latestTranscriptDate = workParsedDate(latestTranscriptAt)
  else { return false }
  return rowEndedDate >= latestTranscriptDate.addingTimeInterval(-0.25)
}

/// Nonisolated wrapper, same call shape `buildWorkChatTimelineSnapshot` uses.
func chatThreadActivityPresentation(_ transcript: [WorkChatEnvelope]) -> WorkActivityIndicator.Presentation? {
  WorkActivityIndicator.derivePresentation(from: transcript)
}

/// Pre-render inline markdown for the rows about to be shown, so
/// `cellForItem` only hits the caches. The caches are `NSCache` (thread-safe).
func chatThreadWarmMarkdownCaches<S: Sequence>(_ entries: S) where S.Element == WorkTimelineRenderEntry {
  for entry in entries {
    guard case .assistantMarkdownBlock(let model) = entry.payload else { continue }
    let intermediate = model.isStreamingTail
    switch model.block.kind {
    case .paragraph(let text), .heading(_, let text):
      _ = markdownAttributedString(text, intermediate: intermediate)
    case .list(let items):
      for item in items { _ = markdownAttributedString(item.text, intermediate: intermediate) }
    case .blockquote(let lines):
      for line in lines { _ = markdownAttributedString(line, intermediate: intermediate) }
    case .table, .code, .rule:
      continue
    }
  }
}
