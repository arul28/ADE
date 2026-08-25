import SwiftUI
import UIKit
import AVKit

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

private actor WorkTimelineSnapshotBuildCoordinator {
  static let shared = WorkTimelineSnapshotBuildCoordinator()

  private var latestRequestIdsByScope: [String: Int] = [:]

  func reserve(scope: String) -> Int {
    let nextRequestId = (latestRequestIdsByScope[scope] ?? 0) + 1
    latestRequestIdsByScope[scope] = nextRequestId
    return nextRequestId
  }

  func build(
    scope: String,
    requestId: Int,
    transcript: [WorkChatEnvelope],
    fallbackEntries: [AgentChatTranscriptEntry],
    artifacts: [ComputerUseArtifactSummary],
    localEchoMessages: [WorkLocalEchoMessage]
  ) -> WorkChatTimelineSnapshot? {
    guard latestRequestIdsByScope[scope] == requestId, !Task.isCancelled else { return nil }
    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
    )
    guard latestRequestIdsByScope[scope] == requestId, !Task.isCancelled else { return nil }
    return snapshot
  }
}

private func workSnapshotByApplyingAssistantTextTail(
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

private func workSnapshotByApplyingLocalEchoTail(
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
      payload: .message(message)
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
      payload: .message(message)
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
    payload: .message(message)
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
      payload: .eventCard(mergedCard)
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
      payload: .eventCard(cardToRender)
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

extension WorkChatSessionView {
  @MainActor
  func prepareScrollStateForCurrentSessionIfNeeded(reason: String) {
    guard scrollStateSessionId != session.id else { return }
    resetScrollStateForCurrentSession(reason: reason)
  }

  @MainActor
  func resetScrollStateForCurrentSession(reason: String) {
    scrollStateSessionId = session.id
    visibleTimelineCount = workTimelinePageSize
    isNearBottom = true
    unreadBelowCount = 0
    lastTimelineTailId = nil
    scrollMetrics = WorkChatScrollMetrics()
    timelineDragActive = false
    timelineScrollPhaseUserDriven = false
    transcriptContentFitsViewport = true
    bottomStickinessReleasedByUser = false
    olderHistoryLoadTask?.cancel()
    olderHistoryLoadTask = nil
    olderHistoryLoadInFlight = false
    olderHistoryLoadError = nil
    olderHistoryTriggerArmed = true
    olderHistoryAutomaticContinuationPending = false
    pendingInitialBottomPinSessionId = session.id
    initialBottomPinQuiescenceGeneration &+= 1
    cancelLatestPinTask()
    timelineIncrementalCache.reset()
  }

  /// Re-applies the opening pin for as long as the content is still growing.
  ///
  /// Called on content-size changes only — never per scroll frame — because it
  /// scans the visible timeline for the tail entry.
  ///
  /// The pin used to fire once and disarm, so any hydration that landed after
  /// the retry ladder (0/16/80/180/320ms) grew the content under a scroll offset
  /// nobody re-pinned, which is what opened chats "at a random spot". It now
  /// stays armed until either the reader takes over
  /// (`cancelPendingInitialBottomPinForUserScroll`) or the content height has
  /// been quiet for `workChatInitialPinQuiescence` — the wall-clock reading of
  /// "stable across consecutive layout passes", since a change-driven observer
  /// by construction never reports the passes where nothing changed.
  @MainActor
  func resolvePendingInitialBottomPinAfterLayout(_ proxy: ScrollViewProxy, reason: String) {
    guard pendingInitialBottomPinSessionId == session.id else { return }
    // A brand-new chat has nothing to pin: its single bubble is top-anchored
    // (desktop parity), and forcing it to the bottom of an empty screen is the
    // exact layout that rule exists to remove.
    guard timeline.count > 1 else {
      pendingInitialBottomPinSessionId = nil
      return
    }
    guard let tailId = timeline.last?.id, !tailId.isEmpty else { return }
    guard visibleTimeline.contains(where: { $0.id == tailId }) else {
      return
    }
    guard workChatMayWriteScrollOffset(
      dragActive: timelineDragActive,
      scrollPhaseUserDriven: timelineScrollPhaseUserDriven
    ) else { return }

    forcePinToLatestAfterLayout(proxy, reason: "initial-\(reason)")
    armInitialBottomPinQuiescence()
  }

  /// Disarms the opening pin once the content stops changing size.
  @MainActor
  private func armInitialBottomPinQuiescence() {
    initialBottomPinQuiescenceGeneration &+= 1
    let generation = initialBottomPinQuiescenceGeneration
    let pinnedSessionId = session.id
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(workChatInitialPinQuiescenceMilliseconds))
      guard !Task.isCancelled,
            generation == initialBottomPinQuiescenceGeneration,
            pendingInitialBottomPinSessionId == pinnedSessionId
      else { return }
      pendingInitialBottomPinSessionId = nil
    }
  }

  /// Paints the user's own bubble on the tap frame.
  ///
  /// Everything else that changes the timeline goes through the 90 ms coalescing
  /// worker in `scheduleTimelineSnapshotRebuild`, which is right for host deltas
  /// arriving 6-7×/s but is dead air when the change is the local echo the user
  /// just produced. Appending one echo to an already-built snapshot is O(1), so
  /// it runs synchronously; anything the incremental path can't express falls
  /// back to the debounced rebuild.
  @MainActor
  func applyLocalEchoTailImmediatelyIfPossible() -> Bool {
    guard !localEchoMessages.isEmpty else { return false }
    guard timelineSourceKey == (selectedSubagentTaskId ?? "main") else { return false }

    // A brand-new chat has no snapshot to append to; the fold is trivially
    // cheap there, so build it inline rather than wait out the debounce.
    if timelineSnapshot.timeline.isEmpty {
      cancelScheduledTimelineSnapshotRebuild()
      rebuildTimelineSnapshot()
      return !timelineSnapshot.timeline.isEmpty
    }

    guard let nextSnapshot = workSnapshotByApplyingLocalEchoTail(
      to: timelineSnapshot,
      cache: timelineIncrementalCache,
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages,
      transcriptRevision: transcriptRenderSignature
    ) else { return false }

    // A coalesced rebuild may already be inside the fold with inputs captured
    // before this echo existed. Retire that generation so its result is dropped
    // instead of overwriting the bubble we are about to paint.
    timelineRebuildGeneration += 1

    timelineSnapshot = nextSnapshot
    timelineIncrementalCache.record(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages,
      transcriptRevision: transcriptRenderSignature
    )
    refreshTimelinePresentation(
      sourceTimeline: nextSnapshot.timeline,
      rebuildToolActivityIndex: false
    )
    if isNearBottom, !timelineDragActive {
      timelineLayoutPinToken &+= 1
    }
    return true
  }

  @MainActor
  func scheduleTimelineSnapshotRebuild() {
    resetTimelineSourceIfNeeded()
    guard !clearTimelineSnapshotForEmptyInputsIfNeeded() else { return }

    timelineRebuildGeneration += 1
    timelineRebuildPending = true
    guard timelineRebuildTask == nil else { return }

    // .userInitiated, not .utility: this rebuild feeds the visible streaming
    // transcript, and utility-priority tasks get starved while SwiftUI is
    // busy — which showed up as multi-second delta-to-screen latency.
    //
    // Coalesced worker: cancelling a detached task does not stop it once it is
    // already inside the expensive transcript fold. Keep at most one fold
    // running and loop only when a newer delta arrived while it was building.
    timelineRebuildTask = Task { @MainActor in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(90))
        guard !Task.isCancelled else { break }

        timelineRebuildPending = false
        let generation = timelineRebuildGeneration
        let transcriptSnapshot = transcript
        let fallbackSnapshot = fallbackEntries
        let artifactSnapshot = artifacts
        let echoSnapshot = localEchoMessages
        let transcriptRevisionSnapshot = transcriptRenderSignature
        let allowsIncrementalTranscriptUpdate = self.allowsIncrementalTranscriptUpdate
        let transcriptIncrementalDeltaSnapshot = transcriptIncrementalDelta
        let buildScope = timelineBuildScopeKey

        if applyIncrementalTimelineSnapshotIfPossible(
          transcript: transcriptSnapshot,
          fallbackEntries: fallbackSnapshot,
          artifacts: artifactSnapshot,
          localEchoMessages: echoSnapshot,
          transcriptRevision: transcriptRevisionSnapshot,
          allowsIncrementalTranscriptUpdate: allowsIncrementalTranscriptUpdate,
          incrementalTranscriptDelta: transcriptIncrementalDeltaSnapshot
        ) {
          transcriptIncrementalDelta = []
          if timelineRebuildPending {
            continue
          }
          timelineRebuildTask = nil
          break
        }

        let requestId = await WorkTimelineSnapshotBuildCoordinator.shared.reserve(scope: buildScope)
        guard let nextSnapshot = await WorkTimelineSnapshotBuildCoordinator.shared.build(
          scope: buildScope,
          requestId: requestId,
          transcript: transcriptSnapshot,
          fallbackEntries: fallbackSnapshot,
          artifacts: artifactSnapshot,
          localEchoMessages: echoSnapshot
        ) else { continue }

        guard !Task.isCancelled else { break }
        guard generation == timelineRebuildGeneration else { continue }
        if nextSnapshot != timelineSnapshot || (timelineSnapshot.timeline.isEmpty && !nextSnapshot.timeline.isEmpty) {
          timelineSnapshot = nextSnapshot
        }
        timelineIncrementalCache.record(
          transcript: transcriptSnapshot,
          fallbackEntries: fallbackSnapshot,
          artifacts: artifactSnapshot,
          localEchoMessages: echoSnapshot,
          transcriptRevision: transcriptRevisionSnapshot,
        )
        transcriptIncrementalDelta = []
        refreshTimelinePresentation(sourceTimeline: nextSnapshot.timeline)
        if isNearBottom, !timelineDragActive {
          timelineLayoutPinToken &+= 1
        }

        if timelineRebuildPending {
          continue
        }
        timelineRebuildTask = nil
        break
      }
    }
  }

  var timelineBuildScopeKey: String {
    [
      timelineBuildScopeId,
      session.id,
      selectedSubagentTaskId ?? "main"
    ].joined(separator: "|")
  }

  var timelineInputRecoveryKey: String {
    [
      session.id,
      selectedSubagentTaskId ?? "main",
      String(transcriptRenderSignature),
      String(fallbackEntriesRenderSignature),
      String(artifactsRenderSignature),
      String(localEchoMessagesRenderSignature)
    ].joined(separator: "|")
  }

  @MainActor
  func recoverEmptyTimelineSnapshotIfNeeded() {
    guard timelineSnapshot.timeline.isEmpty else { return }
    guard !transcript.isEmpty || !fallbackEntries.isEmpty || !localEchoMessages.isEmpty || !artifacts.isEmpty else {
      return
    }

    cancelScheduledTimelineSnapshotRebuild()
    rebuildTimelineSnapshot()
  }

  @MainActor
  func cancelScheduledTimelineSnapshotRebuild() {
    timelineRebuildTask?.cancel()
    timelineRebuildTask = nil
    timelineRebuildPending = false
    cancelLatestPinTask()
  }

  @MainActor
  func applyIncrementalTimelineSnapshotIfPossible(
    transcript: [WorkChatEnvelope],
    fallbackEntries: [AgentChatTranscriptEntry],
    artifacts: [ComputerUseArtifactSummary],
    localEchoMessages: [WorkLocalEchoMessage],
    transcriptRevision: Int,
    allowsIncrementalTranscriptUpdate: Bool,
    incrementalTranscriptDelta: [WorkChatEnvelope]
  ) -> Bool {
    let nextSnapshot = workSnapshotByApplyingLocalEchoTail(
      to: timelineSnapshot,
      cache: timelineIncrementalCache,
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages,
      transcriptRevision: transcriptRevision
    ) ?? workSnapshotByApplyingAssistantTextTail(
      to: timelineSnapshot,
      cache: timelineIncrementalCache,
      transcript: transcript,
      incrementalTranscriptDelta: incrementalTranscriptDelta,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages,
      transcriptRevision: transcriptRevision,
      allowsIncrementalTranscriptUpdate: allowsIncrementalTranscriptUpdate
    )
    guard let nextSnapshot else {
      return false
    }

    timelineSnapshot = nextSnapshot
    transcriptIncrementalDelta = []
    timelineIncrementalCache.record(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages,
      transcriptRevision: transcriptRevision
    )
    let onlyTailMetadataChanged = incrementalTranscriptDelta.allSatisfy {
      switch $0.event {
      case .assistantText, .activity, .tokens, .toolUseSummary, .reasoning, .status:
        return true
      default:
        return false
      }
    }
    refreshTimelinePresentation(
      sourceTimeline: nextSnapshot.timeline,
      rebuildToolActivityIndex: !onlyTailMetadataChanged
    )
    if isNearBottom, !timelineDragActive {
      timelineLayoutPinToken &+= 1
    }
    return true
  }

  @MainActor
  func rebuildTimelineSnapshot() {
    resetTimelineSourceIfNeeded()
    guard !clearTimelineSnapshotForEmptyInputsIfNeeded() else { return }

    let nextSnapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
    )
    transcriptIncrementalDelta = []
    guard nextSnapshot != timelineSnapshot || (timelineSnapshot.timeline.isEmpty && !nextSnapshot.timeline.isEmpty) else { return }
    timelineSnapshot = nextSnapshot
    timelineIncrementalCache.record(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages,
      transcriptRevision: transcriptRenderSignature
    )
    refreshTimelinePresentation(sourceTimeline: nextSnapshot.timeline)
    if isNearBottom, !timelineDragActive {
      timelineLayoutPinToken &+= 1
    }
  }

  @MainActor
  func resetTimelineSourceIfNeeded() {
    let nextSourceKey = selectedSubagentTaskId ?? "main"
    guard timelineSourceKey != nextSourceKey else { return }

    timelineSourceKey = nextSourceKey
    visibleTimelineCount = workTimelinePageSize
    isNearBottom = true
    unreadBelowCount = 0
    lastTimelineTailId = nil
    scrollMetrics = WorkChatScrollMetrics()
    timelineDragActive = false
    timelineScrollPhaseUserDriven = false
    transcriptContentFitsViewport = true
    bottomStickinessReleasedByUser = false
    olderHistoryLoadTask?.cancel()
    olderHistoryLoadTask = nil
    olderHistoryLoadInFlight = false
    olderHistoryLoadError = nil
    olderHistoryTriggerArmed = true
    olderHistoryAutomaticContinuationPending = false
    pendingInitialBottomPinSessionId = session.id
    initialBottomPinQuiescenceGeneration &+= 1
    cancelLatestPinTask()
    timelineRebuildTask?.cancel()
    timelineRebuildTask = nil
    timelineRebuildPending = false
    timelineIncrementalCache.reset()
    timelineSnapshot = .empty
    timelinePresentation = .empty
    turnToolActivity = WorkTurnToolActivityIndex(completedByTurnId: [:], active: nil)
    toolActivitySheet = nil
  }

  @MainActor
  func clearTimelineSnapshotForEmptyInputsIfNeeded() -> Bool {
    guard transcript.isEmpty,
          fallbackEntries.isEmpty,
          localEchoMessages.isEmpty,
          artifacts.isEmpty
    else {
      return false
    }

    timelineRebuildTask?.cancel()
    timelineRebuildTask = nil
    timelineRebuildPending = false
    timelineIncrementalCache.record(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages,
      transcriptRevision: transcriptRenderSignature,
    )

    let alreadyEmpty = timelineSnapshot == .empty && timelinePresentation == .empty
    turnToolActivity = WorkTurnToolActivityIndex(completedByTurnId: [:], active: nil)
    toolActivitySheet = nil
    if !alreadyEmpty {
      timelineSnapshot = .empty
      timelinePresentation = .empty
      timelineLayoutPinToken &+= 1
    }
    return true
  }

  /// True while this timeline row belongs to the turn that is streaming right
  /// now. Every other row — including everything in a freshly opened chat — is
  /// history, and history renders collapsed.
  func isLiveTurnEntry(_ entryId: String) -> Bool {
    isStreamingTurn && timelineSnapshot.liveTurnEntryIds.contains(entryId)
  }

  /// `keepsOpenWhileLive` is the card's own behavior during its turn: plans and
  /// `ade_card`s render in full while they are being written, everything else
  /// opens only on a tap.
  func cardIsExpanded(_ id: String, entryId: String, keepsOpenWhileLive: Bool = false) -> Bool {
    cardExpansion.isExpanded(
      id: id,
      defaultsOpen: keepsOpenWhileLive && isLiveTurnEntry(entryId)
    )
  }

  @MainActor
  func toggleCard(_ id: String, entryId: String, keepsOpenWhileLive: Bool = false) {
    cardExpansion.toggle(
      id: id,
      defaultsOpen: keepsOpenWhileLive && isLiveTurnEntry(entryId)
    )
  }

  /// Nested rows (a file inside the changed-files panel, a call inside a tool
  /// cluster) share the central set so they survive recycling and get swept at
  /// turn end with their parent. They never auto-open.
  @MainActor
  func toggleNestedCard(_ id: String) {
    cardExpansion.toggle(id: id, defaultsOpen: false)
  }

  @MainActor
  func requestEarlierTimelineEntries(automatically: Bool = false) {
    guard !olderHistoryLoadInFlight else { return }
    olderHistoryAutomaticContinuationPending = false
    olderHistoryLoadError = nil
    let revealedBufferedEntries = hiddenTimelineCount > 0
    if hiddenTimelineCount > 0 {
      // Deliberately not animated: these rows land *above* the viewport and are
      // immediately offset-corrected, so animating them only produces a visible
      // flash of the content sliding down and back.
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) {
        visibleTimelineCount += workTimelinePageSize
        refreshTimelinePresentation()
      }
    }
    // Once the locally-buffered timeline is nearly exhausted, pull the next
    // older transcript page from the host so scroll-back continues through
    // the full history instead of stopping at the initial tail fetch.
    if canRequestOlderTranscriptHistory,
       hiddenTimelineCount <= workTimelinePageSize * 2,
       let onLoadOlderTranscript {
      olderHistoryLoadInFlight = true
      let requestedSessionId = session.id
      olderHistoryLoadTask = Task {
        let result = await onLoadOlderTranscript()
        guard !Task.isCancelled, session.id == requestedSessionId else { return }
        olderHistoryLoadTask = nil
        olderHistoryLoadInFlight = false
        if !result.succeeded {
          olderHistoryAutomaticContinuationPending = automatically
          olderHistoryLoadError = "The connected machine did not return this history page. Your cursor was preserved."
          return
        }
        guard automatically,
              hiddenTimelineCount > 0 || result.hasMoreHistory
        else { return }
        olderHistoryAutomaticContinuationPending = true
        if !revealedBufferedEntries, !result.addedTimelineEntries {
          continueAutomaticOlderHistoryIfNeeded()
        }
      }
    } else if automatically, hiddenTimelineCount > 0 {
      olderHistoryAutomaticContinuationPending = true
    }
  }

  @MainActor
  func continueAutomaticOlderHistoryIfNeeded() {
    guard olderHistoryAutomaticContinuationPending,
          !olderHistoryLoadInFlight,
          olderHistoryLoadError == nil || hiddenTimelineCount > 0
    else { return }
    guard workChatShouldContinueAutomaticOlderHistory(
      distanceFromBottom: scrollMetrics.distanceFromBottom,
      contentFitsViewport: scrollMetrics.scrollableHeight <= 0.5,
      loading: olderHistoryLoadInFlight,
      hasError: olderHistoryLoadError != nil,
      hasBufferedEntries: hiddenTimelineCount > 0,
      hasHostHistory: canRequestOlderTranscriptHistory
    ) else {
      olderHistoryAutomaticContinuationPending = false
      return
    }
    olderHistoryAutomaticContinuationPending = false
    olderHistoryTriggerArmed = false
    requestEarlierTimelineEntries(automatically: true)
  }

  @MainActor
  func updateBottomStickiness(distanceFromBottom rawDistance: CGFloat, proxy _: ScrollViewProxy) {
    let distance = max(0, rawDistance)
    scrollMetrics.distanceFromBottom = distance

    if bottomStickinessReleasedByUser {
      guard distance <= workChatStickResumeThreshold, !timelineDragActive else { return }
      bottomStickinessReleasedByUser = false
      if !isNearBottom {
        isNearBottom = true
      }
      if unreadBelowCount > 0 {
        withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
          unreadBelowCount = 0
        }
      }
      return
    }

    let nextIsNearBottom = isNearBottom
      ? !timelineDragActive
      : (!timelineDragActive && distance <= workChatStickResumeThreshold)

    if nextIsNearBottom != isNearBottom {
      isNearBottom = nextIsNearBottom
    }

    guard nextIsNearBottom else { return }

    if unreadBelowCount > 0 {
      withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
        unreadBelowCount = 0
      }
    }
  }

  /// The reader took the transcript over, so the initial bottom pin stands down.
  ///
  /// A user-driven scroll phase is enough to stand down the opening pin. This
  /// runs on the native scroll phase transition, so a small tap cannot strand a
  /// freshly-opened chat while a real drag still cancels the pin immediately.
  @MainActor
  func cancelPendingInitialBottomPinForUserScroll() {
    guard pendingInitialBottomPinSessionId == session.id else { return }
    pendingInitialBottomPinSessionId = nil
    initialBottomPinQuiescenceGeneration &+= 1
  }

  @MainActor
  func releaseBottomStickinessForUserScroll(reason: String) {
    guard isNearBottom else { return }
    bottomStickinessReleasedByUser = true
    isNearBottom = false
  }

  @MainActor
  func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool) {
    bottomStickinessReleasedByUser = false
    if animated {
      withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
        // Keep the ScrollPosition channel and the id-based reader in agreement.
        // The reader is useful for older OS/layout paths, while the bound
        // position is the authoritative tail jump when a LazyVStack has not
        // materialized the sentinel in the current pass.
        let targetId = latestScrollTargetId
        proxy.scrollTo(targetId, anchor: .bottom)
        scrollPosition.scrollTo(edge: .bottom)
      }
      return
    }

    var transaction = Transaction()
    transaction.animation = nil
    withTransaction(transaction) {
      let targetId = latestScrollTargetId
      proxy.scrollTo(targetId, anchor: .bottom)
      scrollPosition.scrollTo(edge: .bottom)
    }
  }

  /// Whether an automatic pin may run right now. A pin is a scroll write, so it
  /// defers to the reader for the whole interaction — finger-down through the
  /// end of the fling — not just while the drag gesture is live.
  var canWriteAutomaticScrollOffset: Bool {
    workChatMayWriteScrollOffset(
      dragActive: timelineDragActive,
      scrollPhaseUserDriven: timelineScrollPhaseUserDriven
    )
  }

  @MainActor
  func pinToLatestAfterLayout(_ proxy: ScrollViewProxy, reason: String) {
    guard isNearBottom, canWriteAutomaticScrollOffset else { return }
    latestPinGeneration &+= 1
    let generation = latestPinGeneration
    latestPinTask?.cancel()
    latestPinTask = Task { @MainActor in
      guard generation == latestPinGeneration, isNearBottom, canWriteAutomaticScrollOffset else { return }
      scrollToLatest(proxy, animated: false)
      try? await Task.sleep(for: .milliseconds(16))
      guard !Task.isCancelled,
            generation == latestPinGeneration,
            isNearBottom,
            canWriteAutomaticScrollOffset else { return }
      scrollToLatest(proxy, animated: false)
      if generation == latestPinGeneration {
        latestPinTask = nil
      }
    }
  }

  @MainActor
  func forcePinToLatestAfterLayout(_ proxy: ScrollViewProxy, reason: String) {
    guard canWriteAutomaticScrollOffset else { return }
    isNearBottom = true
    if unreadBelowCount > 0 {
      unreadBelowCount = 0
    }
    latestPinGeneration &+= 1
    let generation = latestPinGeneration
    latestPinTask?.cancel()
    latestPinTask = Task { @MainActor in
      guard generation == latestPinGeneration, isNearBottom, canWriteAutomaticScrollOffset else { return }
      scrollToLatest(proxy, animated: false)
      for delay in [16, 80, 180, 320] {
        try? await Task.sleep(for: .milliseconds(delay))
        guard !Task.isCancelled,
              generation == latestPinGeneration,
              isNearBottom,
              canWriteAutomaticScrollOffset else { return }
        scrollToLatest(proxy, animated: false)
      }
      if generation == latestPinGeneration {
        latestPinTask = nil
      }
    }
  }

  @MainActor
  func cancelLatestPinTask() {
    latestPinGeneration &+= 1
    latestPinTask?.cancel()
    latestPinTask = nil
  }

  @MainActor
  @discardableResult
  func runSessionAction<T>(_ action: @escaping @MainActor () async -> T) async -> T {
    actionInFlight = true
    defer { actionInFlight = false }
    return await action()
  }

  // MARK: - Consolidated pending-input answering

  /// Optimistically hide a pending input the moment its decision is dispatched
  /// (so the consolidated strip advances to the next request without waiting for
  /// the host), run the action, then reconcile: if the command errored, roll the
  /// hide back so the card re-shows. Successful resolutions are cleared later by
  /// `reconcileOptimisticallyAnsweredInputs` once the item leaves the derived
  /// queue.
  ///
  /// Returns whether THIS answer succeeded so callers (the accept-all sweep) can
  /// gate follow-up work on the real per-action result instead of the shared
  /// `errorMessage` binding.
  @MainActor
  @discardableResult
  func dispatchPendingInputAnswer(
    itemId: String,
    _ op: @escaping @MainActor () async -> Void
  ) async -> Bool {
    optimisticallyAnsweredInputIds.insert(itemId)
    // Capture this action's outcome the instant its handler returns. Every
    // answer handler (`approveRequest`, `respondToPermission`,
    // `submitQuestionAnswers`, `respondToQuestion`, `declineQuestion`) writes
    // `errorMessage` as its final synchronous step — nil on success, a message
    // on failure — and there is no suspension point between that write and this
    // read, so the value reflects THIS command rather than an unrelated
    // concurrent action. Both the rollback below and the sweep gate key off the
    // captured local result, never a later read of the shared binding.
    let succeeded = await runSessionAction { () async -> Bool in
      await op()
      return errorMessage == nil
    }
    if !succeeded {
      optimisticallyAnsweredInputIds.remove(itemId)
    }
    return succeeded
  }

  /// Drop optimistically-answered ids that are no longer in the canonical queue
  /// (confirmed resolved by the host). Keeps the set from masking a future
  /// request that reuses an id and bounds its growth. Invoked whenever the
  /// canonical pending queue changes.
  @MainActor
  func reconcileOptimisticallyAnsweredInputs() {
    guard !optimisticallyAnsweredInputIds.isEmpty else { return }
    let canonical = Set(timelineSnapshot.pendingInputs.map(\.itemId))
    optimisticallyAnsweredInputIds.formIntersection(canonical)
  }

  /// "Accept all": flip session auto-approve for the current approval/permission
  /// gate (`acceptForSession`), then accept every remaining approval/permission
  /// request SEQUENTIALLY (never parallel). Question / plan-approval /
  /// model-selection kinds are never swept. Stale itemIds no-op on the host, so
  /// re-sends after `acceptForSession` auto-resolves the rest are safe.
  @MainActor
  func acceptAllPendingInputs() async {
    guard let primary = primaryPendingInput else { return }
    // Snapshot the sweep set before mutating optimistic-hide state.
    let sweepable = acceptAllSweepableInputs
    guard sweepable.contains(where: { $0.itemId == primary.itemId }) else { return }

    // 1. Current item first with acceptForSession. If the session-scoped grant
    //    fails, stop: do NOT fire `.accept` for the rest. The remaining items
    //    stay pending and the primary's optimistic mark was already rolled back
    //    by `dispatchPendingInputAnswer`.
    guard await sendPendingInputDecision(primary, decision: .acceptForSession) else { return }

    // 2. Remaining approval/permission items, one await at a time.
    for item in sweepable where item.itemId != primary.itemId {
      guard !optimisticallyAnsweredInputIds.contains(item.itemId) else { continue }
      await sendPendingInputDecision(item, decision: .accept)
    }
  }

  /// Route a single approval/permission decision through the optimistic path,
  /// returning whether the decision was dispatched successfully. No-ops (and
  /// reports failure) for kinds that must not be auto-answered.
  @MainActor
  @discardableResult
  private func sendPendingInputDecision(
    _ item: WorkPendingInputItem,
    decision: AgentChatApprovalDecision
  ) async -> Bool {
    switch item {
    case .approval(let model):
      return await dispatchPendingInputAnswer(itemId: model.id) {
        await onApproveRequest(model.id, decision, nil)
      }
    case .permission(let model):
      return await dispatchPendingInputAnswer(itemId: model.id) {
        await onRespondToPermission(model.id, decision)
      }
    case .question, .planApproval, .modelSelection:
      return false
    }
  }
}
