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

  struct LogEntry {
    var envelope: AgentChatEventEnvelope
    var raw: Data
    /// Envelope `sequence` (nil for unsequenced live rows).
    var sequence: Int?
  }

  enum InsertOutcome {
    case appended
    case duplicate
    /// Anything that is not a pure tail append: a middle insert, a replaced
    /// row, a folded row that swallowed earlier deltas.
    case rewritten
  }

  var sequenced: [LogEntry] = []
  var unsequenced: [LogEntry] = []
  var unsequencedKeys: Set<String> = []

  var generation: Int?
  var hostSnapshotReceived = false
  var hasDiskRows = false
  var hasHostRows = false
  var sessionDeleted = false
  var hasOlderHistory = false
  /// Byte cursor for hosts without `chatLogV2`.
  var olderByteCursor: Int?
  /// Oldest sequence the disk cache holds (from meta), used to page from disk
  /// before asking the host.
  var diskOldestSequence: Int?
  var hostSupportsChatLogV2 = false
  var olderState: ChatThreadOlderHistoryState = .idle
  var hostTurnActiveHint: Bool?
  var awaitingBoundaryPage = false
  var boundaryPageRequested = false
  var loadFailure: String?
  var pendingHistoryReset = false

  // MARK: Fold state

  enum TranscriptWork {
    case none
    case appended([AgentChatEventEnvelope])
    case full
  }

  enum TimelineWork: Int, Comparable {
    case none = 0
    /// Frame inputs moved (summary, session status, paging window, optimistic
    /// steers or answers); the snapshot did not.
    case presentationOnly = 1
    /// The snapshot must be refolded: `timelineFold` resumes from its
    /// checkpoint, so this costs the envelopes after it plus the assembly.
    case rebuild = 2

    static func < (lhs: TimelineWork, rhs: TimelineWork) -> Bool { lhs.rawValue < rhs.rawValue }
  }

  enum GoalState {
    case untouched
    case set(AgentChatClaudeGoal)
    case cleared
  }

  var subagentFilter = WorkSubagentTranscriptFilter()
  var transcript: [WorkChatEnvelope] = []
  var transcriptRevision = 0
  var goalState: GoalState = .untouched
  var snapshot = WorkChatTimelineSnapshot.empty
  /// Resumable timeline fold: a rebuild re-folds only the envelopes after its
  /// checkpoint. Told about every transcript change below.
  var timelineFold = ChatThreadTimelineFold()
  /// Merge-key lookup for `transcript`, kept across appends.
  var transcriptKeyIndex: WorkChatTranscriptKeyIndex?
  var toolActivity = WorkTurnToolActivityIndex(
    completedByTurnId: [:],
    completedFilesByTurnId: [:],
    claimedInlineGroupIds: [],
    active: nil
  )
  var presentation = WorkTimelinePresentation.empty
  let assistantPreviewCache = WorkAssistantPreviewCache()
  var visibleTimelineCount = workTimelinePageSize
  var overlays = ChatThreadOverlays()
  var activityPresentationCache: (revision: Int, value: WorkActivityIndicator.Presentation?)?

  var pendingTranscript: TranscriptWork = .none
  var pendingTimeline: TimelineWork = .none
  var pendingUrgent = false
  var foldScheduled = false
  var frameRevision = 0
  var lastFrame: ChatThreadFrame?

  // MARK: Output + persistence

  var sink: (@Sendable (ChatThreadEngineSignal) -> Void)?
  let store: ChatLogStore?

  enum PersistOp: @unchecked Sendable {
    case touch
    case append([ChatLogStoredEvent], generation: Int?)
    case replaceRange(from: Int, events: [ChatLogStoredEvent], generation: Int?, hasOlder: Bool, olderCursor: Int?)
    case dropBelow(Int)
    case updateMeta(generation: Int?, hasOlder: Bool, olderCursor: Int?)
    case drop
    case barrier(CheckedContinuation<Void, Never>)
  }

  let persistContinuation: AsyncStream<PersistOp>.Continuation
  let persistTask: Task<Void, Never>

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

  // MARK: - Fold

  func scheduleFold() {
    guard !foldScheduled else { return }
    guard case .none = pendingTranscript, pendingTimeline == .none else {
      foldScheduled = true
      Task { [weak self] in await self?.runScheduledFold() }
      return
    }
  }

  func runScheduledFold() {
    foldScheduled = false
    flushNow()
  }

  @discardableResult
  func flushNow() -> ChatThreadFrame? {
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
  var diskHoldsOlderRows: Bool {
    guard let diskOldest = diskOldestSequence, let memoryOldest = sequenced.first?.sequence else { return false }
    return diskOldest < memoryOldest
  }

  func rebuildTranscript() {
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

  func advanceGoalState(with envelope: WorkChatEnvelope) {
    switch envelope.event {
    case .claudeGoalUpdated(let goal, _):
      goalState = .set(goal)
    case .claudeGoalCleared:
      goalState = .cleared
    default:
      break
    }
  }

  func rebuildTimeline() {
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

  func buildFrame() -> ChatThreadFrame {
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
      toolActivity: toolActivity,
      isStreaming: isStreaming
    )
    var next = makeWorkTimelinePresentation(
      timeline: presented,
      visibleCount: visibleTimelineCount,
      assistantPreviewCache: assistantPreviewCache,
      streamingAssistantMessageId: streamingAssistantMessageId,
      expandedTurnIds: overlays.expandedTurnIds,
      toolActivity: toolActivity
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
        assistantPreviewCache: assistantPreviewCache,
        streamingAssistantMessageId: streamingAssistantMessageId,
        expandedTurnIds: overlays.expandedTurnIds,
        toolActivity: toolActivity
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
    case .table, .code, .rule, .proofCitation, .proofCompare:
      // Proof blocks draw their own artifact views; there is no markdown text
      // here to pre-render.
      continue
    }
  }
}
