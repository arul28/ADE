import Foundation

/// The thread engine's timeline fold. `snapshot(...)` returns exactly what
/// `buildWorkChatTimelineSnapshot(transcript:fallbackEntries: [], ...)` returns
/// for the same transcript, without re-folding the whole transcript for every
/// appended event.
///
/// How:
/// - The dense per-envelope builders are left folds: messages
///   (`WorkChatMessageFold`), tool cards (`WorkToolCardFold`), turn-end markers
///   (`WorkTurnEndMarkerFold`), the signature (`WorkTimelineSignatureFold`) and
///   the latest timestamp. The fold keeps their state after a transcript
///   prefix (the checkpoint) and resumes over only the envelopes after it.
/// - Every other builder reads only non-dense event kinds, so it runs over
///   the "sparse" subsequence: every envelope except assistant text, tool
///   calls/results, commands, file changes and web searches. The checkpoint
///   keeps the sparse prefix too. The subagent/scheduled builders, the
///   costliest of these, are reused while their input is unchanged.
/// - Pending inputs and the activity indicator read dense kinds and stay whole-
///   transcript passes (cheap single scans).
/// - Ranks, sort, id dedupe and the collapse passes run through the same
///   `assembleWorkTimeline` the full build uses.
///
/// Fallbacks (enumerated; each has a synthetic test):
/// - Full fold from index 0 — the checkpoint is gone: the transcript changed
///   at or below it (`transcriptChanged(from:)`: a merge into an earlier
///   envelope, e.g. a late delta for an older message; a re-sort after an
///   out-of-order envelope or a merge that moved its ordering key), shrank
///   below it, or was replaced (`invalidate()`: snapshot, resume with
///   rewrites, older page, steer graduation, subagent refilter, retraction of
///   the log, generation change).
/// - One component refolded from index 0, the rest resumed — a whole-
///   transcript input it reads while folding changed: the pending-input ids
///   that suppress tool calls (tool cards), or the usage-limit turn id (turn-
///   end markers). Per-turn model metadata and steer resolutions are applied
///   by the message fold at finish, so they never force a refold.
/// - Delegated to `buildWorkChatTimelineSnapshot` — the transcript is not
///   time-sorted (the turn-end fold relies on that order).
/// Everything a later envelope can reach in an earlier one without touching
/// the transcript below the checkpoint (a tool result for an earlier call, a
/// `pending_input_resolved`, subagent rows, retractions, resolutions, turn
/// ends) is either keyed state inside a resumed fold or read by a builder that
/// runs over the whole (sparse) transcript every time.
struct ChatThreadTimelineFold {
  private struct Checkpoint {
    var count: Int
    var messages: WorkChatMessageFold
    var tools: WorkToolCardFold
    var turnEnds: WorkTurnEndMarkerFold
    var signature: WorkTimelineSignatureFold
    var latestTimestamp: String?
    /// Sparse envelopes of `transcript[..<count]`, with their indices.
    var sparse: [WorkChatEnvelope]
    var sparseIndices: [Int]
  }

  private struct SubagentOutputs {
    var input: [WorkChatEnvelope]
    var snapshots: [WorkSubagentSnapshot]
    var rows: [WorkSubagentTimelineRow]
    var scheduled: [WorkScheduledWorkSnapshot]
  }

  /// How the last snapshot was produced (tests and signposts).
  enum Pass: Equatable {
    /// Resumed from a checkpoint at this transcript index; `refolded` names
    /// the components that refolded the prefix because their input changed.
    case resumed(from: Int, refolded: [String])
    /// Folded from index 0 (no usable checkpoint).
    case full(reason: String)
    /// Delegated to `buildWorkChatTimelineSnapshot`.
    case delegated(reason: String)
  }

  /// Keep the latest assistant text envelope out of the checkpoint when it is
  /// this close to the end: streaming deltas merge into it, and a merge below
  /// the checkpoint would drop it.
  static let openAssistantWindow = 64

  private var checkpoint: Checkpoint?
  private var stampCache: [String: (raw: WorkChatMessage, stamped: WorkChatMessage)] = [:]
  private var subagentOutputs: SubagentOutputs?
  private var pendingDropReason: String?
  private(set) var lastPass: Pass = .full(reason: "initial")

  /// Forget the checkpoint: the transcript was replaced wholesale.
  mutating func invalidate(reason: String = "invalidated") {
    if checkpoint != nil { pendingDropReason = reason }
    checkpoint = nil
  }

  /// The transcript changed at `index` or later (a merge into an existing
  /// envelope, an insert, a re-sort from there on).
  mutating func transcriptChanged(from index: Int) {
    guard let checkpoint, index < checkpoint.count else { return }
    pendingDropReason = "transcript changed at \(index) below checkpoint \(checkpoint.count)"
    self.checkpoint = nil
  }

  mutating func snapshot(
    transcript: [WorkChatEnvelope],
    artifacts: [ComputerUseArtifactSummary],
    localEchoMessages: [WorkLocalEchoMessage],
    usageLimitTurnId: String?
  ) -> WorkChatTimelineSnapshot {
    let count = transcript.count
    var resume = checkpoint
    var dropReason = pendingDropReason
    pendingDropReason = nil
    if let checkpoint = resume, checkpoint.count > count {
      resume = nil
      dropReason = "transcript shrank below checkpoint"
    }

    // The resumed folds assume the order the full builders sort into. The
    // prefix was checked when it was folded; check the rest and the seam.
    let orderCheckStart = max(resume?.count ?? 0, 1)
    if orderCheckStart < count,
       !chatThreadTranscriptIsTimeSorted(transcript, from: orderCheckStart) {
      checkpoint = nil
      stampCache.removeAll()
      subagentOutputs = nil
      lastPass = .delegated(reason: "transcript not time-sorted")
      return buildWorkChatTimelineSnapshot(
        transcript: transcript,
        fallbackEntries: [],
        artifacts: artifacts,
        localEchoMessages: localEchoMessages,
        usageLimitTurnId: usageLimitTurnId
      )
    }

    // Sparse subsequence of the whole transcript.
    var sparse = resume?.sparse ?? []
    var sparseIndices = resume?.sparseIndices ?? []
    for index in (resume?.count ?? 0)..<count where chatThreadEnvelopeIsSparse(transcript[index]) {
      sparse.append(transcript[index])
      sparseIndices.append(index)
    }

    // Whole-transcript inputs.
    let pendingInputQueue = deriveWorkPendingInputQueue(from: transcript)
    let suppressedItemIds = Set(pendingInputQueue.liveItems.map(\.itemId))

    let start = resume?.count ?? 0
    var componentRefolds: [String] = []
    defer {
      lastPass = resume == nil
        ? .full(reason: dropReason ?? "no checkpoint")
        : .resumed(from: start, refolded: componentRefolds)
    }
    var messages = resume?.messages ?? WorkChatMessageFold()
    var tools = resume?.tools ?? WorkToolCardFold(suppressedPendingItemIds: suppressedItemIds)
    var turnEnds = resume?.turnEnds ?? WorkTurnEndMarkerFold(usageLimitTurnId: usageLimitTurnId)
    // A component whose whole-transcript input changed refolds the prefix on
    // its own; the others keep their checkpointed state.
    if tools.suppressedPendingItemIds != suppressedItemIds {
      tools = WorkToolCardFold(suppressedPendingItemIds: suppressedItemIds)
      for index in 0..<start { tools.consume(transcript[index]) }
      componentRefolds.append("tools")
    }
    if turnEnds.usageLimitTurnId != usageLimitTurnId {
      turnEnds = WorkTurnEndMarkerFold(usageLimitTurnId: usageLimitTurnId)
      for index in 0..<start { turnEnds.consume(transcript[index]) }
      componentRefolds.append("turnEnds")
    }
    var signature = resume?.signature ?? WorkTimelineSignatureFold()
    var latestTimestamp = resume?.latestTimestamp

    // Where the next checkpoint goes: before the latest assistant text when it
    // is near the end (it may still be streaming), else at the end.
    var nextCheckpointAt = count
    var probe = count - 1
    while probe >= max(start, count - Self.openAssistantWindow) {
      if case .assistantText = transcript[probe].event {
        nextCheckpointAt = probe
        break
      }
      probe -= 1
    }

    var nextCheckpoint: Checkpoint?
    func makeCheckpoint(at index: Int) -> Checkpoint {
      let sparseCount = sparseIndices.partitioningIndex { $0 >= index }
      return Checkpoint(
        count: index,
        messages: messages,
        tools: tools,
        turnEnds: turnEnds,
        signature: signature,
        latestTimestamp: latestTimestamp,
        sparse: Array(sparse.prefix(sparseCount)),
        sparseIndices: Array(sparseIndices.prefix(sparseCount))
      )
    }
    for index in start..<count {
      if index == nextCheckpointAt { nextCheckpoint = makeCheckpoint(at: index) }
      let envelope = transcript[index]
      messages.consume(envelope)
      tools.consume(envelope)
      turnEnds.consume(envelope)
      signature.combine(envelope)
      latestTimestamp = workLatestTranscriptTimestamp(latestTimestamp, envelope.timestamp)
    }
    if nextCheckpointAt == count { nextCheckpoint = makeCheckpoint(at: count) }
    checkpoint = nextCheckpoint

    // Messages: resolutions are whole-transcript (sparse) input to the finish.
    let rawMessages = messages.finished(
      metadataByTurn: workTurnModelMetadataByTurn(from: sparse),
      resolutionBySteerId: workUserMessageResolutionsBySteerId(from: sparse)
    )
    let stampedMessages = stamped(rawMessages)

    let toolCards = tools.cards.filter(workMobileShowsToolCardInTimeline)
    let eventCards = buildWorkEventCards(from: sparse, suppressedItemIds: suppressedItemIds)
      .filter { $0.kind != "toolUseSummary" }
    let pendingSteers = derivePendingWorkSteers(from: sparse)
    let subagent = subagentOutputs(sparse: sparse)
    let timeline = assembleWorkTimeline(
      stampedMessages: stampedMessages,
      pendingSteers: pendingSteers,
      toolCards: toolCards,
      commandCards: [],
      fileChangeCards: [],
      subagentRows: subagent.rows,
      eventCards: eventCards,
      adeCards: buildWorkAdeCards(from: sparse),
      turnEndMarkers: turnEnds.markers,
      doneEnvelopes: sparse,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
    )

    return makeWorkChatTimelineSnapshot(
      signature: signature.finalize(
        fallbackEntries: [],
        artifacts: artifacts,
        localEchoMessages: localEchoMessages,
        usageLimitTurnId: usageLimitTurnId
      ),
      pendingInputQueue: pendingInputQueue,
      pendingSteers: pendingSteers,
      toolCards: toolCards,
      eventCards: eventCards,
      subagentSnapshots: subagent.snapshots,
      scheduledWorkSnapshots: subagent.scheduled,
      transcriptIndicatesActiveTurn: workTranscriptIndicatesActiveTurn(sparse),
      transcriptLatestTurnEnded: workTranscriptLatestTurnEnded(sparse),
      transcriptHasInterruptibleActivity: WorkActivityIndicator.derivePresentation(from: transcript) != nil,
      latestTranscriptTimestamp: latestTimestamp,
      timeline: timeline
    )
  }

  /// `workTimelineStampedMessage` per message, reusing the stamped copy while
  /// the folded message is unchanged (stamping digests the whole markdown).
  private mutating func stamped(_ messages: [WorkChatMessage]) -> [WorkChatMessage] {
    var nextCache: [String: (raw: WorkChatMessage, stamped: WorkChatMessage)] = [:]
    nextCache.reserveCapacity(messages.count)
    let result = messages.map { message -> WorkChatMessage in
      if let cached = stampCache[message.id], cached.raw == message {
        nextCache[message.id] = cached
        return cached.stamped
      }
      let stamped = workTimelineStampedMessage(message)
      nextCache[message.id] = (message, stamped)
      return stamped
    }
    stampCache = nextCache
    return result
  }

  /// Subagent snapshots, their timeline rows and scheduled work read only
  /// `subagent_*` and `scheduled_work_update` rows; rebuilt only when those
  /// rows change.
  private mutating func subagentOutputs(sparse: [WorkChatEnvelope]) -> SubagentOutputs {
    let input = sparse.filter(chatThreadEnvelopeFeedsSubagentBuilders)
    if let cached = subagentOutputs, cached.input == input { return cached }
    let snapshots = buildWorkSubagentSnapshots(from: input)
    let outputs = SubagentOutputs(
      input: input,
      snapshots: snapshots,
      rows: buildWorkSubagentTimelineRows(from: input, snapshots: snapshots),
      scheduled: buildWorkScheduledWorkSnapshots(from: input)
    )
    subagentOutputs = outputs
    return outputs
  }
}

/// Envelopes the sparse builders read: everything except the six dense kinds
/// (assistant text, tool calls and results, commands, file changes, web
/// searches). Every builder the fold runs over the sparse subsequence ignores
/// those kinds entirely: metadata/usage (`done`), resolutions, pending steers
/// (user messages, notices, command lifecycle rows), event cards (no card for
/// any dense kind), ade cards, subagent/scheduled builders and the turn flags.
func chatThreadEnvelopeIsSparse(_ envelope: WorkChatEnvelope) -> Bool {
  switch envelope.event {
  case .assistantText, .toolCall, .toolResult, .command, .fileChange, .webSearch:
    return false
  default:
    return true
  }
}

func chatThreadEnvelopeFeedsSubagentBuilders(_ envelope: WorkChatEnvelope) -> Bool {
  switch envelope.event {
  case .subagentStarted, .subagentProgress, .subagentResult, .scheduledWorkUpdate:
    return true
  default:
    return false
  }
}

/// Same order test `sortedWorkChatEnvelopes` uses to decide a transcript is
/// already sorted, over pairs `(i - 1, i)` for `i >= from`.
func chatThreadTranscriptIsTimeSorted(_ transcript: [WorkChatEnvelope], from: Int) -> Bool {
  guard transcript.count > 1 else { return true }
  var index = max(from, 1)
  while index < transcript.count {
    let lhs = transcript[index - 1]
    let rhs = transcript[index]
    if lhs.timestamp == rhs.timestamp {
      if (lhs.sequence ?? 0) > (rhs.sequence ?? 0) { return false }
    } else if lhs.timestamp > rhs.timestamp {
      return false
    }
    index += 1
  }
  return true
}

private extension Array where Element == Int {
  /// First index whose element satisfies `predicate` (elements ascending).
  func partitioningIndex(where predicate: (Int) -> Bool) -> Int {
    var low = 0
    var high = count
    while low < high {
      let mid = (low + high) / 2
      if predicate(self[mid]) { high = mid } else { low = mid + 1 }
    }
    return low
  }
}
