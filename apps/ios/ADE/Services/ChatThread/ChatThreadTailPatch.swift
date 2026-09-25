import SwiftUI
import UIKit

// Streaming tail-patch fast paths for `WorkChatTimelineSnapshot`.
//
// Moved verbatim out of `WorkChatSessionView+Actions.swift` so the thread
// engine (`ChatThreadEngine`, off the main actor) and the legacy view pipeline
// share one implementation. Behavior is unchanged; only the two entry points
// were widened from `private` to internal.

struct WorkTimelineIncrementalCache {
  fileprivate var transcriptCount = 0
  fileprivate var transcriptRevision = 0
  fileprivate var transcriptHeadKey: String?
  fileprivate var transcriptTailKey: String?
  fileprivate var fallbackSignature = 0
  fileprivate var artifactSignature = 0
  fileprivate var localEchoSignature = 0
  fileprivate var localEchoCount = 0
  fileprivate var localEchoTailId: String?

  mutating func reset() {
    transcriptCount = 0
    transcriptRevision = 0
    transcriptHeadKey = nil
    transcriptTailKey = nil
    fallbackSignature = 0
    artifactSignature = 0
    localEchoSignature = 0
    localEchoCount = 0
    localEchoTailId = nil
  }

  mutating func record(
    transcript: [WorkChatEnvelope],
    fallbackEntries: [AgentChatTranscriptEntry],
    artifacts: [ComputerUseArtifactSummary],
    localEchoMessages: [WorkLocalEchoMessage],
    transcriptRevision: Int
  ) {
    transcriptCount = transcript.count
    self.transcriptRevision = transcriptRevision
    transcriptHeadKey = transcript.first.map(workIncrementalEnvelopeKey)
    transcriptTailKey = transcript.last.map(workIncrementalEnvelopeKey)
    fallbackSignature = workIncrementalFallbackSignature(fallbackEntries, transcriptIsEmpty: transcript.isEmpty)
    artifactSignature = workIncrementalArtifactSignature(artifacts)
    localEchoSignature = workIncrementalLocalEchoSignature(localEchoMessages)
    localEchoCount = localEchoMessages.count
    localEchoTailId = localEchoMessages.last?.id
  }
}

func workSnapshotByApplyingAssistantTextTail(
  to snapshot: WorkChatTimelineSnapshot,
  cache: WorkTimelineIncrementalCache,
  transcript: [WorkChatEnvelope],
  incrementalTranscriptDelta: [WorkChatEnvelope],
  fallbackEntries: [AgentChatTranscriptEntry],
  artifacts: [ComputerUseArtifactSummary],
  localEchoMessages: [WorkLocalEchoMessage],
  transcriptRevision: Int,
  allowsIncrementalTranscriptUpdate: Bool
) -> WorkChatTimelineSnapshot? {
  let hasExplicitIncrementalDelta = allowsIncrementalTranscriptUpdate && !incrementalTranscriptDelta.isEmpty
  guard !snapshot.timeline.isEmpty,
        cache.transcriptCount > 0,
        !transcript.isEmpty,
        cache.transcriptHeadKey == transcript.first.map(workIncrementalEnvelopeKey),
        cache.fallbackSignature == workIncrementalFallbackSignature(fallbackEntries, transcriptIsEmpty: transcript.isEmpty),
        cache.artifactSignature == workIncrementalArtifactSignature(artifacts),
        cache.localEchoSignature == workIncrementalLocalEchoSignature(localEchoMessages),
        hasExplicitIncrementalDelta || cache.transcriptRevision == transcriptRevision
  else { return nil }

  // The delta is one-shot. Once this exact transcript revision has been folded
  // into the snapshot, a later state-only refresh must not append the same
  // fragment again. The parent clears the binding after a successful fold; this
  // guard also protects the small window before that binding update is painted.
  if hasExplicitIncrementalDelta {
    guard cache.transcriptRevision != transcriptRevision else { return nil }
  }

  let candidateEnvelopes: ArraySlice<WorkChatEnvelope>
  if hasExplicitIncrementalDelta {
    guard transcript.count >= cache.transcriptCount,
          incrementalTranscriptDelta.allSatisfy(workIncrementalEnvelopeCanApplyWithoutFullRebuild)
    else { return nil }
    if transcript.count == cache.transcriptCount {
      guard cache.transcriptTailKey == transcript.last.map(workIncrementalEnvelopeKey) else { return nil }
    } else {
      let previousTailIndex = cache.transcriptCount - 1
      guard transcript.indices.contains(previousTailIndex),
            workIncrementalEnvelopeKey(transcript[previousTailIndex]) == cache.transcriptTailKey,
            workIncrementalEnvelopeOrderIsAppendOnly(
              previous: transcript[previousTailIndex],
              suffix: incrementalTranscriptDelta[...]
            )
      else { return nil }
    }
    candidateEnvelopes = incrementalTranscriptDelta[...]
  } else if transcript.count == cache.transcriptCount {
    guard cache.transcriptTailKey == transcript.last.map(workIncrementalEnvelopeKey),
          let last = transcript.last,
          workIncrementalEnvelopeCanApplyWithoutFullRebuild(last)
    else { return nil }
    candidateEnvelopes = transcript[(transcript.count - 1)..<transcript.count]
  } else if transcript.count > cache.transcriptCount {
    let previousTailIndex = cache.transcriptCount - 1
    guard transcript.indices.contains(previousTailIndex),
          workIncrementalEnvelopeKey(transcript[previousTailIndex]) == cache.transcriptTailKey
    else { return nil }
    candidateEnvelopes = transcript[cache.transcriptCount..<transcript.count]
    guard !candidateEnvelopes.isEmpty,
          candidateEnvelopes.allSatisfy(workIncrementalEnvelopeCanApplyWithoutFullRebuild),
          workIncrementalEnvelopeOrderIsAppendOnly(previous: transcript[previousTailIndex], suffix: candidateEnvelopes)
    else { return nil }
  } else {
    return nil
  }

  var timeline = snapshot.timeline
  var eventCards = snapshot.eventCards
  var newTimelineEntryIDs = Set<String>()
  // Keep the active assistant bubble's index across the accepted suffix. The
  // timeline is only sorted after the suffix has been folded, so appending
  // metadata or updating that bubble cannot invalidate this cursor. Without
  // it, every token delta would reverse-scan the entire transcript to find
  // the same message again.
  var assistantTargetIndex: Int?
  for envelope in candidateEnvelopes {
    guard workIncrementalApplyEnvelope(
      envelope,
      to: &timeline,
      eventCards: &eventCards,
      assistantTargetIndex: &assistantTargetIndex,
      newTimelineEntryIDs: &newTimelineEntryIDs
    ) else {
      return nil
    }
  }
  timeline = workIncrementalSortTimeline(timeline)

  var nextSnapshot = snapshot
  nextSnapshot.timeline = timeline
  nextSnapshot.eventCards = eventCards
  nextSnapshot.latestTranscriptTimestamp = workIncrementalLatestTimestamp(
    existing: snapshot.latestTranscriptTimestamp,
    envelopes: candidateEnvelopes
  )
  let timelineTail = workIncrementalUpdatedTailSummary(
    previous: snapshot,
    timeline: timeline,
    previousTimelineCount: snapshot.timeline.count,
    candidateEnvelopes: candidateEnvelopes,
    newTimelineEntryIDs: newTimelineEntryIDs
  )
  nextSnapshot.latestMessageAssistantId = timelineTail.latestAssistantMessageId
  nextSnapshot.latestMessageAssistantItemId = timelineTail.latestAssistantMessageItemId
  nextSnapshot.latestTurnEndTurnId = snapshot.latestTurnEndTurnId
  nextSnapshot.liveTurnEntryIds = timelineTail.liveTurnEntryIds
  nextSnapshot.transcriptIndicatesActiveTurn = true
  nextSnapshot.transcriptLatestTurnEnded = false
  // Terminal events are intentionally outside this append-only path. Once a
  // live assistant/user/activity envelope arrives, the turn is interruptible;
  // carrying the previous true value also keeps a running turn alive while a
  // token-only metadata delta is folded. The full rebuild remains responsible
  // for clearing this flag at done/terminal boundaries.
  nextSnapshot.transcriptHasInterruptibleActivity =
    snapshot.transcriptHasInterruptibleActivity
      || workIncrementalEnvelopeSliceHasInterruptibleActivity(candidateEnvelopes)
  nextSnapshot.signature = workIncrementalSnapshotSignature(
    base: snapshot.signature,
    transcript: transcript,
    transcriptRevision: transcriptRevision,
    latestAssistantMessage: nil
  )
  return nextSnapshot
}

/// Whether every newly-appended echo would survive the suppression the full
/// rebuild applies (`buildWorkTimeline`). If any would be hidden there, the fast
/// path must decline so the two paths cannot disagree.
private func workAppendedEchoesRemainVisible(
  _ localEchoMessages: [WorkLocalEchoMessage],
  appendedFrom index: Int,
  transcript: [WorkChatEnvelope]
) -> Bool {
  let visibleIds = Set(
    workUnrepresentedLocalEchoMessages(
      localEchoMessages,
      representedKeyCounts: workRepresentedEchoKeyCounts(from: transcript)
    ).map(\.id)
  )
  return localEchoMessages[index...].allSatisfy { visibleIds.contains($0.id) }
}

func workSnapshotByApplyingLocalEchoTail(
  to snapshot: WorkChatTimelineSnapshot,
  cache: WorkTimelineIncrementalCache,
  transcript: [WorkChatEnvelope],
  fallbackEntries: [AgentChatTranscriptEntry],
  artifacts: [ComputerUseArtifactSummary],
  localEchoMessages: [WorkLocalEchoMessage],
  transcriptRevision: Int
) -> WorkChatTimelineSnapshot? {
  guard !snapshot.timeline.isEmpty,
        cache.transcriptCount == transcript.count,
        cache.transcriptHeadKey == transcript.first.map(workIncrementalEnvelopeKey),
        cache.transcriptTailKey == transcript.last.map(workIncrementalEnvelopeKey),
        cache.fallbackSignature == workIncrementalFallbackSignature(fallbackEntries, transcriptIsEmpty: transcript.isEmpty),
        cache.artifactSignature == workIncrementalArtifactSignature(artifacts),
        cache.transcriptRevision == transcriptRevision,
        localEchoMessages.count > cache.localEchoCount
  else { return nil }

  if cache.localEchoCount > 0 {
    let previousEchoIndex = cache.localEchoCount - 1
    guard localEchoMessages.indices.contains(previousEchoIndex),
          localEchoMessages[previousEchoIndex].id == cache.localEchoTailId
    else { return nil }
  }

  let appendedEchoes = localEchoMessages[cache.localEchoCount..<localEchoMessages.count]
  // The full rebuild hides echoes the transcript already represents
  // (`visibleLocalEchoMessages` in `buildWorkTimeline`). Fall back rather than
  // append a duplicate bubble the next rebuild would silently remove.
  guard workAppendedEchoesRemainVisible(
    localEchoMessages,
    appendedFrom: cache.localEchoCount,
    transcript: transcript
  ) else { return nil }

  var timeline = snapshot.timeline
  for echo in appendedEchoes {
    let message = WorkChatMessage(
      id: echo.id,
      role: "user",
      markdown: echo.text,
      timestamp: echo.timestamp,
      turnId: nil,
      itemId: nil,
      deliveryState: echo.deliveryState,
      attachments: echo.attachments
    )
    timeline.append(WorkTimelineEntry(
      id: "echo-\(echo.id)",
      timestamp: echo.timestamp,
      rank: 3_000 + workIncrementalEchoCount(in: timeline),
      payload: .message(message)
    ))
  }
  timeline = workIncrementalSortTimeline(timeline)

  var nextSnapshot = snapshot
  nextSnapshot.timeline = timeline
  nextSnapshot.latestTranscriptTimestamp = workIncrementalLatestTimestamp(
    existing: snapshot.latestTranscriptTimestamp,
    localEchoMessages: localEchoMessages[cache.localEchoCount..<localEchoMessages.count]
  )
  let timelineTail = workIncrementalUpdatedTailSummary(
    previous: snapshot,
    timeline: timeline,
    previousTimelineCount: snapshot.timeline.count
  )
  nextSnapshot.latestMessageAssistantId = timelineTail.latestAssistantMessageId
  nextSnapshot.latestMessageAssistantItemId = timelineTail.latestAssistantMessageItemId
  nextSnapshot.latestTurnEndTurnId = snapshot.latestTurnEndTurnId
  nextSnapshot.liveTurnEntryIds = timelineTail.liveTurnEntryIds
  nextSnapshot.signature = workIncrementalSnapshotSignature(
    base: snapshot.signature,
    transcript: transcript,
    transcriptRevision: transcriptRevision,
    latestAssistantMessage: nil
  )
  return nextSnapshot
}

private func workIncrementalApplyEnvelope(
  _ envelope: WorkChatEnvelope,
  to timeline: inout [WorkTimelineEntry],
  eventCards: inout [WorkEventCardModel],
  assistantTargetIndex: inout Int?,
  newTimelineEntryIDs: inout Set<String>
) -> Bool {
  if workIncrementalEnvelopeIsLiveMetadata(envelope) {
    return workIncrementalApplyLiveMetadataInternal(
      envelope,
      to: &timeline,
      eventCards: &eventCards,
      newTimelineEntryIDs: &newTimelineEntryIDs
    )
  }
  if case .userMessage(let text, let attachments, let turnId, let steerId, let deliveryState, let processed) = envelope.event {
    guard deliveryState != "queued" || steerId == nil else { return false }
    workIncrementalRemoveDuplicateEchoes(matching: text, from: &timeline)
    // A canonical user message is a hard assistant-tail boundary. Any cached
    // index may also have shifted when a matching local echo was removed.
    assistantTargetIndex = nil
    let message = WorkChatMessage(
      id: envelope.id,
      role: "user",
      markdown: text,
      timestamp: envelope.timestamp,
      turnId: turnId,
      itemId: nil,
      steerId: steerId,
      deliveryState: deliveryState,
      processed: processed,
      attachments: attachments
    )
    let entry = WorkTimelineEntry(
      id: "message-\(message.id)",
      timestamp: envelope.timestamp,
      rank: workIncrementalNextMessageRank(in: timeline),
      payload: .message(message),
      turnId: message.turnId
    )
    timeline.append(entry)
    newTimelineEntryIDs.insert(entry.id)
    return true
  }

  guard case .assistantText(let text, let turnId, let itemId) = envelope.event else {
    return false
  }

  if let targetIndex = workIncrementalAssistantTargetIndex(
    in: timeline,
    turnId: turnId,
    itemId: itemId,
    envelopeId: envelope.id,
    cachedIndex: assistantTargetIndex
  ) {
    assistantTargetIndex = targetIndex
    guard case .message(var message) = timeline[targetIndex].payload else { return false }
    workApplyStreamingAssistantText(text, to: &message)
    timeline[targetIndex] = WorkTimelineEntry(
      id: timeline[targetIndex].id,
      timestamp: timeline[targetIndex].timestamp,
      rank: timeline[targetIndex].rank,
      payload: .message(message),
      turnId: timeline[targetIndex].turnId ?? message.turnId
    )
    return true
  }

  let message = WorkChatMessage(
    id: envelope.id,
    role: "assistant",
    markdown: text,
    timestamp: envelope.timestamp,
    turnId: turnId,
    itemId: itemId
  )
  let entry = WorkTimelineEntry(
    id: "message-\(message.id)",
    timestamp: envelope.timestamp,
    rank: workIncrementalNextMessageRank(in: timeline),
    payload: .message(message),
    turnId: message.turnId
  )
  timeline.append(entry)
  newTimelineEntryIDs.insert(entry.id)
  assistantTargetIndex = timeline.count - 1
  return true
}

private func workIncrementalApplyEnvelope(
  _ envelope: WorkChatEnvelope,
  to timeline: inout [WorkTimelineEntry]
) -> Bool {
  var eventCards: [WorkEventCardModel] = []
  var newTimelineEntryIDs = Set<String>()
  var assistantTargetIndex: Int?
  return workIncrementalApplyEnvelope(
    envelope,
    to: &timeline,
    eventCards: &eventCards,
    assistantTargetIndex: &assistantTargetIndex,
    newTimelineEntryIDs: &newTimelineEntryIDs
  )
}

/// Applies the metadata envelopes that the append-only path is allowed to
/// accept without a full snapshot rebuild. Reasoning owns a visible card and
/// therefore has to merge into that card; the remaining accepted metadata
/// envelopes intentionally have no mobile timeline payload.
func workIncrementalApplyLiveMetadata(
  _ envelope: WorkChatEnvelope,
  to timeline: inout [WorkTimelineEntry]
) -> Bool {
  var eventCards: [WorkEventCardModel] = []
  var newTimelineEntryIDs = Set<String>()
  return workIncrementalApplyLiveMetadataInternal(
    envelope,
    to: &timeline,
    eventCards: &eventCards,
    newTimelineEntryIDs: &newTimelineEntryIDs
  )
}

func workIncrementalApplyLiveMetadata(
  _ envelope: WorkChatEnvelope,
  to timeline: inout [WorkTimelineEntry],
  eventCards: inout [WorkEventCardModel]
) -> Bool {
  var newTimelineEntryIDs = Set<String>()
  return workIncrementalApplyLiveMetadataInternal(
    envelope,
    to: &timeline,
    eventCards: &eventCards,
    newTimelineEntryIDs: &newTimelineEntryIDs
  )
}

private func workIncrementalApplyLiveMetadataInternal(
  _ envelope: WorkChatEnvelope,
  to timeline: inout [WorkTimelineEntry],
  eventCards: inout [WorkEventCardModel],
  newTimelineEntryIDs: inout Set<String>
) -> Bool {
  guard let incomingCard = workIncrementalEventCard(for: envelope), incomingCard.kind == "reasoning" else {
    return true
  }

  let incomingEntryId = "event-\(incomingCard.id)"
  // Only the active tail phase can conflict with an incoming reasoning row.
  // Historical reasoning cards are already separated from the current turn by
  // a later timeline entry; scanning the entire transcript here would put the
  // full rebuild back on every reasoning delta in a long chat.
  if let lastEntry = timeline.last {
    if lastEntry.id == incomingEntryId {
      // This is an update to the existing live card and can merge in place.
    } else if lastEntry.id.hasPrefix("activity-phase-reasoning:") {
      return false
    } else if case .eventCard(let lastCard) = lastEntry.payload,
              lastCard.kind == "reasoning" {
      return false
    }
  }

  let entryId = incomingEntryId
  let existingEventCardIndex: Int? = {
    if eventCards.last?.id == incomingCard.id { return eventCards.count - 1 }
    return eventCards.lastIndex { $0.id == incomingCard.id }
  }()
  let existingTimelineCardIndex: Int? = {
    if timeline.last?.id == entryId { return timeline.count - 1 }
    return timeline.lastIndex(where: { $0.id == entryId })
  }()
  // A historical reasoning card can live only in the collapsed phase row. If
  // the same item is replayed later, appending a raw event card would render a
  // duplicate beside that phase. Decline once and let the canonical rebuild
  // reconcile the historical representation.
  if existingEventCardIndex != nil, existingTimelineCardIndex == nil {
    return false
  }
  if let existingIndex = existingTimelineCardIndex {
    guard case .eventCard(let existingCard) = timeline[existingIndex].payload,
          let mergedCard = workIncrementalMergedEventCard(existingCard, with: incomingCard)
    else { return false }
    timeline[existingIndex] = WorkTimelineEntry(
      id: entryId,
      timestamp: mergedCard.timestamp,
      rank: timeline[existingIndex].rank,
      payload: .eventCard(mergedCard),
      turnId: timeline[existingIndex].turnId ?? mergedCard.turnId
    )
    if let existingEventCardIndex,
       let mergedEventCard = workIncrementalMergedEventCard(
         eventCards[existingEventCardIndex],
         with: incomingCard
       ) {
      eventCards[existingEventCardIndex] = mergedEventCard
    } else if existingEventCardIndex == nil {
      eventCards.append(mergedCard)
    }
  } else {
    let cardToRender: WorkEventCardModel
    if let existingEventCardIndex,
       let mergedEventCard = workIncrementalMergedEventCard(
         eventCards[existingEventCardIndex],
         with: incomingCard
       ) {
      cardToRender = mergedEventCard
      eventCards[existingEventCardIndex] = mergedEventCard
    } else {
      cardToRender = incomingCard
      eventCards.append(incomingCard)
    }
    let eventRank = 1_500 + eventCards.count - 1
    let entry = WorkTimelineEntry(
      id: entryId,
      timestamp: cardToRender.timestamp,
      rank: eventRank,
      payload: .eventCard(cardToRender),
      turnId: cardToRender.turnId
    )
    timeline.append(entry)
    newTimelineEntryIDs.insert(entry.id)
  }
  return true
}

private func workIncrementalAssistantTargetIndex(
  in timeline: [WorkTimelineEntry],
  turnId: String?,
  itemId: String?,
  envelopeId: String,
  cachedIndex: Int?
) -> Int? {
  let entryId = "message-\(envelopeId)"

  if let cachedIndex,
     timeline.indices.contains(cachedIndex),
     case .message(let cachedMessage) = timeline[cachedIndex].payload,
     cachedMessage.role == "assistant" {
    if timeline[cachedIndex].id == entryId {
      return cachedIndex
    }
    let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let cachedItemId = cachedMessage.itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !normalizedItemId.isEmpty,
       cachedItemId == normalizedItemId,
       workIncrementalStableItemTurnIdsMatch(cachedMessage.turnId, turnId) {
      return cachedIndex
    }
    if normalizedItemId.isEmpty,
       workIncrementalTurnIdsMatch(cachedMessage.turnId, turnId) {
      return cachedIndex
    }
  }

  if let exactIndex = timeline.indices.last(where: { timeline[$0].id == entryId }) {
    return exactIndex
  }

  let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !normalizedItemId.isEmpty,
     let itemIndex = timeline.indices.reversed().first(where: { index in
       guard case .message(let message) = timeline[index].payload,
             message.role == "assistant",
             (message.itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") == normalizedItemId
       else { return false }
       return workIncrementalStableItemTurnIdsMatch(message.turnId, turnId)
     }) {
    return itemIndex
  }

  guard normalizedItemId.isEmpty,
        let lastMessageIndex = timeline.indices.reversed().first(where: { index in
          if case .message = timeline[index].payload { return true }
          return false
        }),
        case .message(let message) = timeline[lastMessageIndex].payload,
        message.role == "assistant",
        workIncrementalTurnIdsMatch(message.turnId, turnId)
  else { return nil }
  return lastMessageIndex
}

private func workIncrementalTurnIdsMatch(_ lhs: String?, _ rhs: String?) -> Bool {
  let left = lhs?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let right = rhs?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return left == right
}

private func workIncrementalStableItemTurnIdsMatch(_ lhs: String?, _ rhs: String?) -> Bool {
  let left = lhs?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let right = rhs?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return left.isEmpty || right.isEmpty || left == right
}

private func workIncrementalEnvelopeIsAssistantText(_ envelope: WorkChatEnvelope) -> Bool {
  if case .assistantText = envelope.event { return true }
  return false
}

private func workIncrementalEnvelopeCanApplyWithoutFullRebuild(_ envelope: WorkChatEnvelope) -> Bool {
  if workIncrementalEnvelopeIsAssistantText(envelope) { return true }
  if workIncrementalEnvelopeIsLiveMetadata(envelope) { return true }
  if case .userMessage(_, _, _, let steerId, let deliveryState, _) = envelope.event {
    return deliveryState != "queued" || steerId == nil
  }
  return false
}

private func workIncrementalEnvelopeIsLiveMetadata(_ envelope: WorkChatEnvelope) -> Bool {
  switch envelope.event {
  case .activity, .tokens, .toolUseSummary:
    return true
  case .reasoning:
    // Reasoning cards can be materialized by the terminal rebuild. Updating
    // them for every live token is the same pathological full-scan shape as
    // assistant text, but with less user value while the answer is still moving.
    return true
  case .status(let turnStatus, let message, _):
    let normalizedStatus = turnStatus.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let normalizedMessage = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard normalizedMessage.isEmpty || normalizedMessage == normalizedStatus else {
      return false
    }
    switch normalizedStatus {
    case "started", "active", "running", "inprogress", "in_progress", "in-progress":
      return true
    default:
      return false
    }
  default:
    return false
  }
}

private func workIncrementalEnvelopeOrderIsAppendOnly(
  previous: WorkChatEnvelope,
  suffix: ArraySlice<WorkChatEnvelope>
) -> Bool {
  var last = previous
  for envelope in suffix {
    if envelope.timestamp < last.timestamp { return false }
    if envelope.timestamp == last.timestamp,
       (envelope.sequence ?? 0) < (last.sequence ?? 0) {
      return false
    }
    last = envelope
  }
  return true
}

func workIncrementalTimelineNeedsSort(_ timeline: [WorkTimelineEntry]) -> Bool {
  guard timeline.count > 1,
        let previous = timeline.dropLast().last,
        let last = timeline.last
  else {
    return false
  }
  return previous.timestamp > last.timestamp
    || (previous.timestamp == last.timestamp && previous.rank > last.rank)
}

private func workIncrementalSortTimeline(_ timeline: [WorkTimelineEntry]) -> [WorkTimelineEntry] {
  guard workIncrementalTimelineNeedsSort(timeline) else {
    // The accepted incremental envelopes are append-ordered. Existing tail
    // updates do not move a row, so the common streaming path is already
    // sorted and avoids allocating a second full timeline.
    return timeline
  }
  return timeline.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return lhs.rank < rhs.rank
    }
    return lhs.timestamp < rhs.timestamp
  }
}

private func workIncrementalNextMessageRank(in timeline: [WorkTimelineEntry]) -> Int {
  let messageCount = timeline.reduce(0) { count, entry in
    if case .message = entry.payload { return count + 1 }
    return count
  }
  return messageCount
}

private func workIncrementalEchoCount(in timeline: [WorkTimelineEntry]) -> Int {
  timeline.reduce(0) { count, entry in
    entry.id.hasPrefix("echo-") ? count + 1 : count
  }
}

private func workIncrementalRemoveDuplicateEchoes(matching text: String, from timeline: inout [WorkTimelineEntry]) {
  let normalized = normalizedWorkLocalEchoText(text)
  guard !normalized.isEmpty else { return }
  // Remove only ONE matching echo: if the user sent the same text twice before
  // canonical sync caught up, confirming the first must not drop the second echo.
  if let duplicateIndex = timeline.firstIndex(where: { entry in
    guard entry.id.hasPrefix("echo-"),
          case .message(let message) = entry.payload,
          message.role == "user"
    else { return false }
    return normalizedWorkLocalEchoText(message.markdown) == normalized
  }) {
    timeline.remove(at: duplicateIndex)
  }
}

private func workIncrementalLatestTimestamp(
  existing: String?,
  envelopes: ArraySlice<WorkChatEnvelope>
) -> String? {
  var latest = existing
  for envelope in envelopes where !envelope.timestamp.isEmpty {
    if latest.map({ envelope.timestamp > $0 }) ?? true {
      latest = envelope.timestamp
    }
  }
  return latest
}

private func workIncrementalLatestTimestamp(
  existing: String?,
  localEchoMessages: ArraySlice<WorkLocalEchoMessage>
) -> String? {
  var latest = existing
  for echo in localEchoMessages where !echo.timestamp.isEmpty {
    if latest.map({ echo.timestamp > $0 }) ?? true {
      latest = echo.timestamp
    }
  }
  return latest
}

struct WorkIncrementalUpdatedTailSummary {
  let latestAssistantMessageId: String?
  let latestAssistantMessageItemId: String?
  let liveTurnEntryIds: Set<String>
}

func workIncrementalUpdatedTailSummary(
  previous: WorkChatTimelineSnapshot,
  timeline: [WorkTimelineEntry],
  previousTimelineCount: Int,
  candidateEnvelopes: ArraySlice<WorkChatEnvelope>? = nil,
  newTimelineEntryIDs: Set<String> = []
) -> WorkIncrementalUpdatedTailSummary {
  var liveTurnEntryIds = previous.liveTurnEntryIds
  guard timeline.count >= previousTimelineCount else {
    // A duplicate-echo removal is not a streaming-tail update; keep the safe
    // canonical path for that uncommon shape.
    return WorkIncrementalUpdatedTailSummary(
      latestAssistantMessageId: previous.latestMessageAssistantId,
      latestAssistantMessageItemId: previous.latestMessageAssistantItemId,
      liveTurnEntryIds: liveTurnEntryIds
    )
  }

  var latestAssistantMessageId = previous.latestMessageAssistantId
  var latestAssistantMessageItemId = previous.latestMessageAssistantItemId
  if let candidateEnvelopes {
    // Sorting can move a newly-created row before an existing future-dated
    // echo or card. Track actual insertions from the fold and resolve the
    // assistant tail against the sorted timeline instead of treating the
    // array suffix as the delta.
    for entryID in newTimelineEntryIDs {
      liveTurnEntryIds.insert(entryID)
    }
    // A canonical user envelope can replace a local echo in place, so the
    // timeline count may stay unchanged. Derive the message tail from the
    // accepted delta and the actual sorted timeline in either case.
    let assistantTail = workIncrementalLatestAssistantTail(
      previous: latestAssistantMessageId,
      previousItemId: latestAssistantMessageItemId,
      timeline: timeline,
      candidateEnvelopes: candidateEnvelopes
    )
    latestAssistantMessageId = assistantTail.messageId
    latestAssistantMessageItemId = assistantTail.itemId
  } else {
    let appendedEntries = timeline[previousTimelineCount...]
    for entry in appendedEntries {
      liveTurnEntryIds.insert(entry.id)
    }
    for entry in appendedEntries.reversed() {
      guard case .message(let message) = entry.payload else { continue }
      latestAssistantMessageId = message.role == "assistant" ? message.id : nil
      latestAssistantMessageItemId = message.role == "assistant" ? message.itemId : nil
      break
    }
  }
  return WorkIncrementalUpdatedTailSummary(
    latestAssistantMessageId: latestAssistantMessageId,
    latestAssistantMessageItemId: latestAssistantMessageItemId,
    liveTurnEntryIds: liveTurnEntryIds
  )
}

/// Updates the streaming-message hint from only the accepted transcript delta.
/// Most assistant deltas keep the existing hint and therefore avoid a timeline
/// scan. A user message, or the first assistant message after one, is a tail
/// boundary; only that uncommon transition needs the canonical reverse lookup.
func workIncrementalLatestAssistantMessageId(
  previous: String?,
  previousItemId: String? = nil,
  timeline: [WorkTimelineEntry],
  candidateEnvelopes: ArraySlice<WorkChatEnvelope>
) -> String? {
  workIncrementalLatestAssistantTail(
    previous: previous,
    previousItemId: previousItemId,
    timeline: timeline,
    candidateEnvelopes: candidateEnvelopes
  ).messageId
}

private struct WorkIncrementalAssistantTail {
  let messageId: String?
  let itemId: String?
}

private func workIncrementalLatestAssistantTail(
  previous: String?,
  previousItemId: String?,
  timeline: [WorkTimelineEntry],
  candidateEnvelopes: ArraySlice<WorkChatEnvelope>
) -> WorkIncrementalAssistantTail {
  var latest = previous
  var latestItemId = previousItemId
  var needsTailLookup = false

  for envelope in candidateEnvelopes {
    switch envelope.event {
    case .userMessage:
      latest = nil
      latestItemId = nil
    case .assistantText(_, _, let itemId):
      let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if !normalizedItemId.isEmpty {
        if normalizedItemId != latestItemId {
          latestItemId = normalizedItemId
          needsTailLookup = true
        }
      } else if latest == nil {
        needsTailLookup = true
      }
    default:
      continue
    }
  }

  guard needsTailLookup else {
    return WorkIncrementalAssistantTail(messageId: latest, itemId: latestItemId)
  }
  for entry in timeline.reversed() {
    guard case .message(let message) = entry.payload else { continue }
    return WorkIncrementalAssistantTail(
      messageId: message.role == "assistant" ? message.id : nil,
      itemId: message.role == "assistant" ? message.itemId : nil
    )
  }
  return WorkIncrementalAssistantTail(messageId: nil, itemId: nil)
}

private func workIncrementalEnvelopeSliceHasInterruptibleActivity(
  _ envelopes: ArraySlice<WorkChatEnvelope>
) -> Bool {
  for envelope in envelopes.reversed() {
    switch envelope.event {
    case .userMessage, .assistantText, .reasoning, .activity:
      return true
    case .status(let status, _, _):
      switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
      case "started", "active", "running", "inprogress", "in_progress", "in-progress":
        return true
      default:
        continue
      }
    case .tokens, .toolUseSummary:
      continue
    default:
      continue
    }
  }
  return false
}

private func workIncrementalEnvelopeKey(_ envelope: WorkChatEnvelope) -> String {
  workChatEnvelopeMergeKey(envelope)
}

private func workIncrementalSnapshotSignature(
  base: Int,
  transcript: [WorkChatEnvelope],
  transcriptRevision: Int,
  latestAssistantMessage: WorkChatMessage?
) -> Int {
  var hasher = Hasher()
  hasher.combine("assistant-tail")
  hasher.combine(base)
  hasher.combine(transcriptRevision)
  hasher.combine(transcript.count)
  if let tail = transcript.last {
    hasher.combine(workIncrementalEnvelopeKey(tail))
    hasher.combine(tail.timestamp)
    hasher.combine(tail.sequence)
    if case .assistantText(_, let turnId, let itemId) = tail.event {
      hasher.combine(turnId)
      hasher.combine(itemId)
      if let message = latestAssistantMessage {
        // The live message owns an exact monotonic revision. It distinguishes
        // same-length middle replacements without hashing the growing answer
        // on the main actor for every token batch.
        hasher.combine(message.markdownRevision)
        hasher.combine(message.markdownCharacterCount)
        hasher.combine(message.markdownLineCount)
        hasher.combine(message.markdownTrailingBacktickRun)
      }
    }
  }
  if let latestAssistantMessage {
    hasher.combine(latestAssistantMessage.id)
  }
  return hasher.finalize()
}

private func workIncrementalFallbackSignature(_ fallbackEntries: [AgentChatTranscriptEntry], transcriptIsEmpty: Bool) -> Int {
  guard transcriptIsEmpty else { return 0 }
  var hasher = Hasher()
  hasher.combine(fallbackEntries.count)
  for entry in fallbackEntries {
    hasher.combine(entry.id)
    hasher.combine(entry.role)
    hasher.combine(entry.timestamp)
    hasher.combine(entry.text.utf8.count)
    hasher.combine(entry.text.hashValue)
    hasher.combine(entry.turnId)
    hasher.combine(entry.messageId)
    hasher.combine(entry.itemId)
  }
  return hasher.finalize()
}

private func workIncrementalArtifactSignature(_ artifacts: [ComputerUseArtifactSummary]) -> Int {
  var hasher = Hasher()
  hasher.combine(artifacts.count)
  for artifact in artifacts {
    hasher.combine(artifact.id)
    hasher.combine(artifact.artifactKind)
    hasher.combine(artifact.title)
    hasher.combine(artifact.uri)
    hasher.combine(artifact.createdAt)
    hasher.combine(artifact.reviewState)
    hasher.combine(artifact.workflowState)
  }
  return hasher.finalize()
}

private func workIncrementalLocalEchoSignature(_ localEchoMessages: [WorkLocalEchoMessage]) -> Int {
  var hasher = Hasher()
  hasher.combine(localEchoMessages.count)
  for echo in localEchoMessages {
    hasher.combine(echo.id)
    hasher.combine(echo.text.utf8.count)
    hasher.combine(echo.text.hashValue)
    hasher.combine(echo.timestamp)
    hasher.combine(echo.deliveryState)
    // Attachment refs change without touching count, text, timestamp, or
    // delivery state when a pending upload is swapped for its host path. Leaving
    // them out let the assistant-tail fast path treat the echo as unchanged and
    // keep rendering the uploading chip.
    hasher.combine(echo.attachments?.count ?? 0)
    for attachment in echo.attachments ?? [] {
      hasher.combine(attachment.path)
      hasher.combine(attachment.type)
      hasher.combine(attachment.url)
    }
  }
  return hasher.finalize()
}
