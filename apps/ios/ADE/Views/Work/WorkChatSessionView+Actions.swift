import SwiftUI
import UIKit
import AVKit

struct WorkTimelineIncrementalCache {
  fileprivate var transcriptCount = 0
  fileprivate var transcriptHeadKey: String?
  fileprivate var transcriptTailKey: String?
  fileprivate var fallbackSignature = 0
  fileprivate var artifactSignature = 0
  fileprivate var localEchoSignature = 0
  fileprivate var localEchoCount = 0
  fileprivate var localEchoTailId: String?

  mutating func reset() {
    transcriptCount = 0
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
    localEchoMessages: [WorkLocalEchoMessage]
  ) {
    transcriptCount = transcript.count
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
  fallbackEntries: [AgentChatTranscriptEntry],
  artifacts: [ComputerUseArtifactSummary],
  localEchoMessages: [WorkLocalEchoMessage]
) -> WorkChatTimelineSnapshot? {
  guard !snapshot.timeline.isEmpty,
        cache.transcriptCount > 0,
        !transcript.isEmpty,
        cache.transcriptHeadKey == transcript.first.map(workIncrementalEnvelopeKey),
        cache.fallbackSignature == workIncrementalFallbackSignature(fallbackEntries, transcriptIsEmpty: transcript.isEmpty),
        cache.artifactSignature == workIncrementalArtifactSignature(artifacts),
        cache.localEchoSignature == workIncrementalLocalEchoSignature(localEchoMessages)
  else { return nil }

  let candidateEnvelopes: ArraySlice<WorkChatEnvelope>
  if transcript.count == cache.transcriptCount {
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
  for envelope in candidateEnvelopes {
    guard workIncrementalApplyEnvelope(envelope, to: &timeline) else {
      return nil
    }
  }
  timeline = workIncrementalSortTimeline(timeline)

  var nextSnapshot = snapshot
  nextSnapshot.timeline = timeline
  nextSnapshot.latestTranscriptTimestamp = workIncrementalLatestTimestamp(
    existing: snapshot.latestTranscriptTimestamp,
    envelopes: candidateEnvelopes
  )
  nextSnapshot.latestMessageAssistantId = workIncrementalLatestAssistantId(timeline)
  nextSnapshot.transcriptIndicatesActiveTurn = true
  nextSnapshot.transcriptLatestTurnEnded = false
  // Keep interruptibility consistent with the full-rebuild path (which derives
  // it from the transcript). Otherwise the Stop control can stay hidden while a
  // newly-streaming assistant response begins over a previously-idle snapshot.
  nextSnapshot.transcriptHasInterruptibleActivity =
    WorkActivityIndicator.derivePresentation(from: transcript) != nil
  nextSnapshot.signature = workIncrementalSnapshotSignature(
    base: snapshot.signature,
    transcript: transcript,
    timeline: timeline
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
  localEchoMessages: [WorkLocalEchoMessage]
) -> WorkChatTimelineSnapshot? {
  guard !snapshot.timeline.isEmpty,
        cache.transcriptCount == transcript.count,
        cache.transcriptHeadKey == transcript.first.map(workIncrementalEnvelopeKey),
        cache.transcriptTailKey == transcript.last.map(workIncrementalEnvelopeKey),
        cache.fallbackSignature == workIncrementalFallbackSignature(fallbackEntries, transcriptIsEmpty: transcript.isEmpty),
        cache.artifactSignature == workIncrementalArtifactSignature(artifacts),
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
  nextSnapshot.signature = workIncrementalSnapshotSignature(
    base: snapshot.signature,
    transcript: transcript,
    timeline: timeline
  )
  return nextSnapshot
}

private func workIncrementalApplyEnvelope(
  _ envelope: WorkChatEnvelope,
  to timeline: inout [WorkTimelineEntry]
) -> Bool {
  if workIncrementalEnvelopeIsLiveMetadata(envelope) {
    return true
  }
  if case .userMessage(let text, let attachments, let turnId, let steerId, let deliveryState, let processed) = envelope.event {
    guard deliveryState != "queued" || steerId == nil else { return false }
    workIncrementalRemoveDuplicateEchoes(matching: text, from: &timeline)
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
    timeline.append(WorkTimelineEntry(
      id: "message-\(message.id)",
      timestamp: envelope.timestamp,
      rank: workIncrementalNextMessageRank(in: timeline),
      payload: .message(message)
    ))
    return true
  }

  guard case .assistantText(let text, let turnId, let itemId) = envelope.event else {
    return false
  }

  if let targetIndex = workIncrementalAssistantTargetIndex(
    in: timeline,
    turnId: turnId,
    itemId: itemId,
    envelopeId: envelope.id
  ) {
    guard case .message(var message) = timeline[targetIndex].payload else { return false }
    message.markdown = mergeWorkStreamingText(message.markdown, text)
    message.assistantPreview = nil
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
  timeline.append(WorkTimelineEntry(
    id: "message-\(message.id)",
    timestamp: envelope.timestamp,
    rank: workIncrementalNextMessageRank(in: timeline),
    payload: .message(message)
  ))
  return true
}

private func workIncrementalAssistantTargetIndex(
  in timeline: [WorkTimelineEntry],
  turnId: String?,
  itemId: String?,
  envelopeId: String
) -> Int? {
  let entryId = "message-\(envelopeId)"
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

private func workIncrementalSortTimeline(_ timeline: [WorkTimelineEntry]) -> [WorkTimelineEntry] {
  timeline.sorted { lhs, rhs in
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

private func workIncrementalLatestAssistantId(_ timeline: [WorkTimelineEntry]) -> String? {
  for entry in timeline.reversed() {
    guard case .message(let message) = entry.payload else { continue }
    if message.role == "assistant" {
      return message.id
    }
  }
  return nil
}

private func workIncrementalEnvelopeKey(_ envelope: WorkChatEnvelope) -> String {
  workChatEnvelopeMergeKey(envelope)
}

private func workIncrementalSnapshotSignature(
  base: Int,
  transcript: [WorkChatEnvelope],
  timeline: [WorkTimelineEntry]
) -> Int {
  var hasher = Hasher()
  hasher.combine("assistant-tail")
  hasher.combine(base)
  hasher.combine(transcript.count)
  if let tail = transcript.last {
    hasher.combine(workIncrementalEnvelopeKey(tail))
    hasher.combine(tail.timestamp)
    hasher.combine(tail.sequence)
    if case .assistantText(let text, let turnId, let itemId) = tail.event {
      hasher.combine(text.utf8.count)
      hasher.combine(text.hashValue)
      hasher.combine(turnId)
      hasher.combine(itemId)
    }
  }
  if let latestAssistantId = workIncrementalLatestAssistantId(timeline) {
    hasher.combine(latestAssistantId)
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
    bottomStickinessReleasedByUser = false
    olderHistoryLoadTask?.cancel()
    olderHistoryLoadTask = nil
    olderHistoryLoadInFlight = false
    olderHistoryLoadError = nil
    olderHistoryTriggerArmed = true
    olderHistoryAutomaticContinuationPending = false
    pendingInitialBottomPinSessionId = session.id
    cancelLatestPinTask()
    timelineIncrementalCache.reset()
  }

  @MainActor
  func resolvePendingInitialBottomPinAfterLayout(_ proxy: ScrollViewProxy, reason: String) {
    guard pendingInitialBottomPinSessionId == session.id else { return }
    guard let tailId = timeline.last?.id, !tailId.isEmpty else { return }
    guard visibleTimeline.contains(where: { $0.id == tailId }) else {
      return
    }

    pendingInitialBottomPinSessionId = nil
    forcePinToLatestAfterLayout(proxy, reason: "initial-\(reason)")
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
      localEchoMessages: localEchoMessages
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
      localEchoMessages: localEchoMessages
    )
    refreshTimelinePresentation(sourceTimeline: nextSnapshot.timeline)
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
        let buildScope = timelineBuildScopeKey

        if applyIncrementalTimelineSnapshotIfPossible(
          transcript: transcriptSnapshot,
          fallbackEntries: fallbackSnapshot,
          artifacts: artifactSnapshot,
          localEchoMessages: echoSnapshot
        ) {
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
          localEchoMessages: echoSnapshot
        )
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
    localEchoMessages: [WorkLocalEchoMessage]
  ) -> Bool {
    let nextSnapshot = workSnapshotByApplyingLocalEchoTail(
      to: timelineSnapshot,
      cache: timelineIncrementalCache,
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
    ) ?? workSnapshotByApplyingAssistantTextTail(
      to: timelineSnapshot,
      cache: timelineIncrementalCache,
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
    )
    guard let nextSnapshot else {
      return false
    }

    timelineSnapshot = nextSnapshot
    timelineIncrementalCache.record(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
    )
    refreshTimelinePresentation(sourceTimeline: nextSnapshot.timeline)
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
    guard nextSnapshot != timelineSnapshot || (timelineSnapshot.timeline.isEmpty && !nextSnapshot.timeline.isEmpty) else { return }
    timelineSnapshot = nextSnapshot
    timelineIncrementalCache.record(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
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
    bottomStickinessReleasedByUser = false
    olderHistoryLoadTask?.cancel()
    olderHistoryLoadTask = nil
    olderHistoryLoadInFlight = false
    olderHistoryLoadError = nil
    olderHistoryTriggerArmed = true
    olderHistoryAutomaticContinuationPending = false
    pendingInitialBottomPinSessionId = session.id
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
      localEchoMessages: localEchoMessages
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

  @MainActor
  func toggleToolCard(_ id: String) {
    if expandedToolCardIds.contains(id) {
      expandedToolCardIds.remove(id)
    } else {
      expandedToolCardIds.insert(id)
    }
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
          olderHistoryLoadError == nil
    else { return }
    guard workChatShouldContinueAutomaticOlderHistory(
      distanceFromBottom: scrollMetrics.distanceFromBottom,
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

  @MainActor
  func releaseBottomStickinessForUserScroll(reason: String) {
    if pendingInitialBottomPinSessionId == session.id {
      pendingInitialBottomPinSessionId = nil
    }
    guard isNearBottom else { return }
    bottomStickinessReleasedByUser = true
    isNearBottom = false
  }

  @MainActor
  func allowBottomStickinessResumeFromUserScroll(reason: String) {
    guard bottomStickinessReleasedByUser else { return }
    bottomStickinessReleasedByUser = false
  }

  @MainActor
  func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool) {
    bottomStickinessReleasedByUser = false
    let targetId = latestScrollTargetId
    if animated {
      withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
        proxy.scrollTo(targetId, anchor: .bottom)
      }
      return
    }

    var transaction = Transaction()
    transaction.animation = nil
    withTransaction(transaction) {
      proxy.scrollTo(targetId, anchor: .bottom)
    }
  }

  @MainActor
  func pinToLatestAfterLayout(_ proxy: ScrollViewProxy, reason: String) {
    guard isNearBottom, !timelineDragActive else { return }
    latestPinGeneration &+= 1
    let generation = latestPinGeneration
    latestPinTask?.cancel()
    latestPinTask = Task { @MainActor in
      guard generation == latestPinGeneration, isNearBottom, !timelineDragActive else { return }
      scrollToLatest(proxy, animated: false)
      try? await Task.sleep(for: .milliseconds(16))
      guard !Task.isCancelled,
            generation == latestPinGeneration,
            isNearBottom,
            !timelineDragActive else { return }
      scrollToLatest(proxy, animated: false)
      if generation == latestPinGeneration {
        latestPinTask = nil
      }
    }
  }

  @MainActor
  func forcePinToLatestAfterLayout(_ proxy: ScrollViewProxy, reason: String) {
    isNearBottom = true
    if unreadBelowCount > 0 {
      unreadBelowCount = 0
    }
    latestPinGeneration &+= 1
    let generation = latestPinGeneration
    latestPinTask?.cancel()
    latestPinTask = Task { @MainActor in
      guard generation == latestPinGeneration, isNearBottom, !timelineDragActive else { return }
      scrollToLatest(proxy, animated: false)
      for delay in [16, 80, 180, 320] {
        try? await Task.sleep(for: .milliseconds(delay))
        guard !Task.isCancelled,
              generation == latestPinGeneration,
              isNearBottom,
              !timelineDragActive else { return }
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
