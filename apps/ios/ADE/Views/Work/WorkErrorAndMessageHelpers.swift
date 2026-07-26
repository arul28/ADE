import SwiftUI
import UIKit
import AVKit
import OSLog

private let workChatTranscriptLog = Logger(subsystem: "com.ade.ios", category: "WorkChatTranscript")
private let workStreamingMergeMinimumReplayAnchorLength = 24
private let workStreamingMergeMaxScanCharacters = 512
private let workStreamingMergeReplaySearchWindowCharacters = 12_000
private let workStreamingMergeReplayAnchorLengths = [512, 256, 128, 64, 32, workStreamingMergeMinimumReplayAnchorLength]
private let workStreamingMergeMinimumRepeatedTailLength = 24
private let workStreamingMergeRepeatedTailWindowCharacters = 4_096

struct WorkErrorPresentation {
  let title: String
  let icon: String
  let tint: ColorToken
}

func errorPresentation(for category: String) -> WorkErrorPresentation {
  switch category {
  case "auth":
    return WorkErrorPresentation(title: "Authentication issue", icon: "lock.trianglebadge.exclamationmark", tint: .danger)
  case "rate_limit":
    return WorkErrorPresentation(title: "Rate limited", icon: "hourglass", tint: .warning)
  case "network":
    return WorkErrorPresentation(title: "Connection issue", icon: "wifi.exclamationmark", tint: .warning)
  case "permission":
    return WorkErrorPresentation(title: "Permission issue", icon: "hand.raised.fill", tint: .warning)
  default:
    return WorkErrorPresentation(title: "Error", icon: "exclamationmark.triangle.fill", tint: .danger)
  }
}

func buildWorkChatMessages(from transcript: [WorkChatEnvelope]) -> [WorkChatMessage] {
  var messages: [WorkChatMessage] = []
  let metadataByTurn = workTurnModelMetadataByTurn(from: transcript)
  var resolutionBySteerId: [String: WorkUserMessageResolution] = [:]
  var resolutionOrderBySteerId: [String: (timestamp: String, sequence: Int)] = [:]
  for envelope in transcript {
    guard case .userMessageResolution(
      let steerId,
      let action,
      let state,
      let resolvedAt,
      let replacementMessageId,
      _
    ) = envelope.event else {
      continue
    }
    let normalizedSteerId = steerId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedSteerId.isEmpty else { continue }
    let sequence = envelope.sequence ?? 0
    if let existing = resolutionOrderBySteerId[normalizedSteerId],
       envelope.timestamp < existing.timestamp
        || (envelope.timestamp == existing.timestamp && sequence <= existing.sequence) {
      continue
    }
    resolutionBySteerId[normalizedSteerId] = WorkUserMessageResolution(
      action: action,
      state: state,
      resolvedAt: resolvedAt,
      replacementMessageId: replacementMessageId
    )
    resolutionOrderBySteerId[normalizedSteerId] = (envelope.timestamp, sequence)
  }
  // Tracks whether the previous envelope was assistantText so nil-itemId
  // streaming fragments can merge into it. MUST be reset to false on every
  // non-assistantText branch below — otherwise a subsequent nil-itemId
  // fragment could wrongly merge across an intervening tool call or user
  // message. Any new `WorkChatEvent` case added here must preserve that reset.
  var previousEnvelopeWasAssistantText = false

  for envelope in transcript {
    switch envelope.event {
    case .userMessage(let text, let attachments, let turnId, let steerId, let deliveryState, let processed):
      previousEnvelopeWasAssistantText = false
      // Queued steers render as inline cards above the composer, not in the message stream.
      if deliveryState == "queued", steerId != nil {
        continue
      }
      if let lastIndex = messages.indices.last,
         messages[lastIndex].role == "user",
         messages[lastIndex].turnId == turnId,
         messages[lastIndex].steerId == steerId,
         messages[lastIndex].timestamp == envelope.timestamp {
        messages[lastIndex].markdown += text
        mergeWorkUserMessageMetadata(
          into: &messages[lastIndex],
          attachments: attachments,
          deliveryState: deliveryState,
          processed: processed
        )
      } else if let duplicateIndex = duplicateUserMessageVariantIndex(
        in: messages,
        text: text,
        turnId: turnId,
        steerId: steerId,
        deliveryState: deliveryState
      ) {
        mergeWorkUserMessageMetadata(
          into: &messages[duplicateIndex],
          attachments: attachments,
          deliveryState: deliveryState,
          processed: processed
        )
      } else {
        messages.append(WorkChatMessage(
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
        ))
      }
    case .assistantText(let text, let turnId, let itemId):
      let text = workStreamingTextByCollapsingRepeatedTailReplay(text)
      let metadata = turnId
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .flatMap { metadataByTurn[$0] }
      let isLiveFragment = envelope.sequence != nil
      let canMergeWithPreviousAssistant = itemId != nil || (previousEnvelopeWasAssistantText && isLiveFragment)
      if let itemIndex = assistantFragmentIndexByItemId(
        in: messages,
        turnId: turnId,
        itemId: itemId
      ) {
        messages[itemIndex].markdown = mergeWorkStreamingText(messages[itemIndex].markdown, text)
        messages[itemIndex].assistantPreview = nil
        if messages[itemIndex].turnProvider == nil {
          messages[itemIndex].turnProvider = metadata?.provider
        }
        if messages[itemIndex].turnModelId == nil {
          messages[itemIndex].turnModelId = metadata?.modelId
        }
      } else if let lastIndex = messages.indices.last,
         messages[lastIndex].role == "assistant",
         messages[lastIndex].turnId == turnId,
         messages[lastIndex].itemId == itemId,
         canMergeWithPreviousAssistant {
        messages[lastIndex].markdown = mergeWorkStreamingText(messages[lastIndex].markdown, text)
        messages[lastIndex].assistantPreview = nil
      } else if let duplicateIndex = duplicateAssistantFragmentIndex(
        in: messages,
        turnId: turnId,
        incoming: text
      ), let merged = mergedDuplicateAssistantText(
        existing: messages[duplicateIndex].markdown,
        incoming: text
      ) {
        messages[duplicateIndex].markdown = merged
      } else {
        messages.append(WorkChatMessage(
          id: envelope.id,
          role: "assistant",
          markdown: text,
          timestamp: envelope.timestamp,
          turnId: turnId,
          itemId: itemId,
          turnProvider: metadata?.provider,
          turnModelId: metadata?.modelId
        ))
      }
      previousEnvelopeWasAssistantText = true
    case .userMessageResolution:
      previousEnvelopeWasAssistantText = false
      continue
    case .transcriptRetraction(let messageIds, _, _, _):
      previousEnvelopeWasAssistantText = false
      let retractedIds = Set(
        messageIds
          .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
          .filter { !$0.isEmpty }
      )
      guard !retractedIds.isEmpty else { continue }
      messages.removeAll { message in
        guard message.role == "assistant" else { return false }
        if retractedIds.contains(message.id) { return true }
        guard let itemId = message.itemId?.trimmingCharacters(in: .whitespacesAndNewlines), !itemId.isEmpty else {
          return false
        }
        return retractedIds.contains(itemId)
      }
    default:
      previousEnvelopeWasAssistantText = false
      continue
    }
  }

  for index in messages.indices {
    guard let steerId = messages[index].steerId?.trimmingCharacters(in: .whitespacesAndNewlines),
          !steerId.isEmpty,
          let resolution = resolutionBySteerId[steerId] else {
      continue
    }
    messages[index].unprocessedResolution = resolution
  }

  return messages
}

private func assistantFragmentIndexByItemId(
  in messages: [WorkChatMessage],
  turnId: String?,
  itemId: String?
) -> Int? {
  let normalizedItemId = normalizedAssistantItemId(itemId)
  guard !normalizedItemId.isEmpty else { return nil }
  return messages.indices.reversed().first { index in
    let message = messages[index]
    guard message.role == "assistant",
          normalizedAssistantItemId(message.itemId) == normalizedItemId
    else { return false }
    return assistantTurnIdsAllowStableItemMerge(message.turnId, turnId)
  }
}

private func normalizedAssistantItemId(_ itemId: String?) -> String {
  itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

private func assistantTurnIdsAllowStableItemMerge(_ lhs: String?, _ rhs: String?) -> Bool {
  let left = lhs?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let right = rhs?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return left.isEmpty || right.isEmpty || left == right
}

private func duplicateUserMessageVariantIndex(
  in messages: [WorkChatMessage],
  text: String,
  turnId: String?,
  steerId: String?,
  deliveryState: String?
) -> Int? {
  guard deliveryState != "queued" else { return nil }
  let normalizedText = normalizedWorkLocalEchoText(text)
  guard !normalizedText.isEmpty else { return nil }
  let normalizedTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines)
  let normalizedSteerId = steerId?.trimmingCharacters(in: .whitespacesAndNewlines)
  guard normalizedTurnId?.isEmpty == false || normalizedSteerId?.isEmpty == false else { return nil }
  return messages.lastIndex { message in
    guard message.role == "user" else { return false }
    guard !(message.deliveryState == "queued" && message.steerId != nil) else { return false }
    let sameTurn = normalizedTurnId?.isEmpty == false && message.turnId == turnId
    let sameSteer = normalizedSteerId?.isEmpty == false && message.steerId == steerId
    guard sameTurn || sameSteer else { return false }
    return normalizedWorkLocalEchoText(message.markdown) == normalizedText
  }
}

private func mergeWorkUserMessageMetadata(
  into message: inout WorkChatMessage,
  attachments: [AgentChatFileRef]?,
  deliveryState: String?,
  processed: Bool?
) {
  if let attachments, !attachments.isEmpty {
    let existing = message.attachments ?? []
    let existingKeys = Set(existing.map { "\($0.type)|\($0.path)|\($0.url ?? "")" })
    let mergedAttachments = existing + attachments.filter { !existingKeys.contains("\($0.type)|\($0.path)|\($0.url ?? "")") }
    message.attachments = mergedAttachments
  }
  if let deliveryState {
    message.deliveryState = deliveryState
  }
  if let processed {
    message.processed = processed
  }
}

private func duplicateAssistantFragmentIndex(
  in messages: [WorkChatMessage],
  turnId: String?,
  incoming: String
) -> Int? {
  messages.indices.reversed().first { index in
    let message = messages[index]
    guard message.role == "assistant" else { return false }
    guard assistantTurnIdsAreCompatible(message.turnId, turnId) else { return false }
    return mergedDuplicateAssistantText(existing: message.markdown, incoming: incoming) != nil
  }
}

private func assistantTurnIdsAreCompatible(_ lhs: String?, _ rhs: String?) -> Bool {
  let left = lhs?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let right = rhs?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return !left.isEmpty && left == right
}

private func mergedDuplicateAssistantText(existing: String, incoming: String) -> String? {
  let normalizedExisting = existing.trimmingCharacters(in: .whitespacesAndNewlines)
  let normalizedIncoming = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !normalizedExisting.isEmpty, !normalizedIncoming.isEmpty else { return nil }
  if normalizedExisting == normalizedIncoming || normalizedExisting.hasSuffix(normalizedIncoming) {
    return existing
  }
  if normalizedIncoming.hasPrefix(normalizedExisting) {
    return incoming
  }

  let merged = mergeWorkStreamingText(existing, incoming)
  return merged == existing + incoming ? nil : merged
}

func mergeWorkStreamingText(_ existing: String, _ incoming: String) -> String {
  if existing.isEmpty { return incoming }
  if incoming.isEmpty { return existing }
  if existing == incoming { return existing }
  if incoming.hasPrefix(existing) { return incoming }
  if existing.hasPrefix(incoming),
     workStreamingExistingOnlyAddsRepeatedIncomingTail(existing: existing, incoming: incoming) {
    return incoming
  }
  if existing.hasPrefix(incoming) { return existing }
  let normalizedExisting = existing.trimmingCharacters(in: .whitespacesAndNewlines)
  let normalizedIncoming = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
  if !normalizedIncoming.isEmpty,
     normalizedExisting.hasSuffix(normalizedIncoming) {
    return existing
  }
  if !normalizedExisting.isEmpty,
     normalizedIncoming.hasPrefix(normalizedExisting) {
    return incoming
  }
  if workStreamingTextHasMultiwordReplayShape(incoming),
     existing.hasSuffix(incoming) {
    return existing
  }
  if let mergedReplay = mergeWorkStreamingReplayText(existing: existing, incoming: incoming) {
    return workStreamingTextByCollapsingRepeatedTail(mergedReplay)
  }

  let maxOverlap = min(min(existing.count, incoming.count), workStreamingMergeMaxScanCharacters)
  guard maxOverlap > 0 else {
    return existing + incoming
  }

  // The hasPrefix checks above handle the common streaming-duplication cases, so this
  // overlap scan is capped to keep long transcript rebuilds bounded.
  for length in stride(from: maxOverlap, through: 1, by: -1) {
    let existingSuffix = existing.suffix(length)
    let incomingPrefix = incoming.prefix(length)
    if existingSuffix == incomingPrefix {
      return existing + incoming.dropFirst(length)
    }
  }

  return existing + incoming
}

private func workStreamingExistingOnlyAddsRepeatedIncomingTail(existing: String, incoming: String) -> Bool {
  guard existing.count > incoming.count else { return false }
  let extraStart = existing.index(existing.startIndex, offsetBy: incoming.count)
  let extra = String(existing[extraStart...])
  let extraWords = workStreamingNormalizedWords(extra)
  guard !extraWords.isEmpty, extraWords.count <= 24 else { return false }

  let incomingWords = workStreamingNormalizedWords(incoming)
  guard !incomingWords.isEmpty else { return false }

  let maxPhraseLength = min(extraWords.count, incomingWords.count, 12)
  guard maxPhraseLength > 0 else { return false }

  for phraseLength in 1...maxPhraseLength where extraWords.count % phraseLength == 0 {
    let phrase = Array(extraWords.prefix(phraseLength))
    guard phrase.count >= 2 || phrase.first?.count ?? 0 >= 4 else { continue }
    guard Array(incomingWords.suffix(phraseLength)) == phrase else { continue }

    var index = phraseLength
    var repeatsIncomingTail = true
    while index < extraWords.count {
      let end = index + phraseLength
      guard Array(extraWords[index..<end]) == phrase else {
        repeatsIncomingTail = false
        break
      }
      index = end
    }
    if repeatsIncomingTail { return true }
  }

  return false
}

private func workStreamingNormalizedWords(_ text: String) -> [String] {
  text
    .lowercased()
    .split { scalar in
      !scalar.isLetter && !scalar.isNumber
    }
    .map(String.init)
}

private func mergeWorkStreamingReplayText(existing: String, incoming: String) -> String? {
  let existingCount = existing.count
  let incomingCount = incoming.count
  guard existingCount >= workStreamingMergeMinimumReplayAnchorLength,
        incomingCount >= workStreamingMergeMinimumReplayAnchorLength else {
    return nil
  }

  let searchWindowLength = min(existingCount, workStreamingMergeReplaySearchWindowCharacters)
  let searchStart = existing.index(existing.endIndex, offsetBy: -searchWindowLength)
  let searchableExisting = existing[searchStart...]
  let maxAnchorLength = min(
    min(incomingCount, searchableExisting.count),
    workStreamingMergeMaxScanCharacters
  )
  guard maxAnchorLength >= workStreamingMergeMinimumReplayAnchorLength else { return nil }

  var anchorLengths = [maxAnchorLength]
  anchorLengths.append(contentsOf: workStreamingMergeReplayAnchorLengths.filter {
    $0 < maxAnchorLength && $0 >= workStreamingMergeMinimumReplayAnchorLength
  })

  for length in anchorLengths {
    let incomingAnchor = incoming.prefix(length)
    guard let anchorRange = searchableExisting.range(of: incomingAnchor, options: [.backwards]) else {
      continue
    }

    let existingReplayTail = searchableExisting[anchorRange.lowerBound...]
    if incoming.hasPrefix(existingReplayTail) {
      return String(existing[..<anchorRange.lowerBound]) + incoming
    }
    if existingReplayTail.hasPrefix(incoming) {
      return existing
    }
  }

  return nil
}

private func workStreamingTextHasMultiwordReplayShape(_ text: String) -> Bool {
  guard text.count >= workStreamingMergeMinimumRepeatedTailLength else { return false }
  return text.range(of: #"\S\s+\S"#, options: .regularExpression) != nil
}

private func workStreamingTextByCollapsingRepeatedTail(_ text: String) -> String {
  guard text.count >= workStreamingMergeMinimumRepeatedTailLength * 2 else { return text }

  let tailWindow = String(text.suffix(workStreamingMergeRepeatedTailWindowCharacters))
  let collapsedTail = workStreamingTextTailRemovingAdjacentRepeats(tailWindow)
  guard collapsedTail.count < tailWindow.count else { return text }

  let prefix = text.dropLast(tailWindow.count)
  return String(prefix) + collapsedTail
}

private func workStreamingTextByCollapsingRepeatedTailReplay(_ text: String) -> String {
  var result = workStreamingTextByCollapsingRepeatedTail(text)
  var changed = true

  while changed {
    changed = false
    let words = workStreamingWordsWithRanges(result)
    let maxPhraseLength = min(12, words.count / 2)
    guard maxPhraseLength >= 2 else { break }

    for phraseLength in 2...maxPhraseLength {
      let tailStart = words.count - phraseLength
      let previousStart = tailStart - phraseLength
      let tailWords = words[tailStart..<words.count].map(\.word)
      let previousWords = words[previousStart..<tailStart].map(\.word)
      guard tailWords == previousWords else { continue }

      let tailRange = words[tailStart].range.lowerBound..<words[words.count - 1].range.upperBound
      let tailText = String(result[tailRange])
      guard tailText.count >= 12 else { continue }

      var removalStart = tailRange.lowerBound
      while removalStart > result.startIndex {
        let previous = result.index(before: removalStart)
        guard result[previous].isWhitespace else { break }
        removalStart = previous
      }
      result.removeSubrange(removalStart..<result.endIndex)
      changed = true
      break
    }
  }

  return result
}

private func workStreamingWordsWithRanges(_ text: String) -> [(word: String, range: Range<String.Index>)] {
  var words: [(word: String, range: Range<String.Index>)] = []
  var cursor = text.startIndex

  while cursor < text.endIndex {
    while cursor < text.endIndex, !text[cursor].isLetter, !text[cursor].isNumber {
      cursor = text.index(after: cursor)
    }
    guard cursor < text.endIndex else { break }

    let start = cursor
    while cursor < text.endIndex, text[cursor].isLetter || text[cursor].isNumber {
      cursor = text.index(after: cursor)
    }
    let range = start..<cursor
    words.append((word: text[range].lowercased(), range: range))
  }

  return words
}

private func workStreamingTextTailRemovingAdjacentRepeats(_ text: String) -> String {
  var result = text
  var changed = true

  while changed {
    changed = false
    let count = result.count
    let maxLength = min(count / 2, workStreamingMergeMaxScanCharacters)
    guard maxLength >= workStreamingMergeMinimumRepeatedTailLength else { break }

    for length in stride(from: maxLength, through: workStreamingMergeMinimumRepeatedTailLength, by: -1) {
      let suffixStart = result.index(result.endIndex, offsetBy: -length)
      guard let previousStart = result.index(suffixStart, offsetBy: -length, limitedBy: result.startIndex) else {
        continue
      }
      let previous = result[previousStart..<suffixStart]
      let suffix = result[suffixStart..<result.endIndex]
      guard previous == suffix,
            workStreamingTextHasMultiwordReplayShape(String(suffix))
      else { continue }

      result.removeSubrange(suffixStart..<result.endIndex)
      changed = true
      break
    }
  }

  return result
}

func makeWorkChatTranscript(from entries: [AgentChatTranscriptEntry], sessionId: String) -> [WorkChatEnvelope] {
  entries.map { entry in
    return WorkChatEnvelope(
      sessionId: sessionId,
      timestamp: entry.timestamp,
      sequence: nil,
      event: entry.role == "assistant"
        ? .assistantText(
          text: entry.text,
          turnId: entry.turnId,
          itemId: workAssistantMessageStableId(messageId: entry.messageId, itemId: entry.itemId)
        )
        : .userMessage(text: entry.text, attachments: nil, turnId: entry.turnId, steerId: nil, deliveryState: nil, processed: nil)
    )
  }
}

func workChatEnvelopeOrderedBefore(_ lhs: WorkChatEnvelope, _ rhs: WorkChatEnvelope) -> Bool {
  if let lhsSequence = lhs.sequence,
     let rhsSequence = rhs.sequence,
     lhsSequence != rhsSequence {
    return lhsSequence < rhsSequence
  }
  if lhs.timestamp != rhs.timestamp {
    return lhs.timestamp < rhs.timestamp
  }
  return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
}

func makeWorkChatTranscript(from entries: [AgentChatEventEnvelope]) -> [WorkChatEnvelope] {
  let parentItemIds = workSubagentParentItemIds(from: entries)
  let childItemIds = workSubagentChildItemIds(from: entries, parentItemIds: parentItemIds)
  return entries.compactMap { entry in
    guard !isSubagentTranscriptEnvelope(entry) else { return nil }
    guard !isSubagentChildWorkEvent(entry.event, parentItemIds: parentItemIds, childItemIds: childItemIds) else {
      return nil
    }
    return WorkChatEnvelope(
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      sequence: entry.sequence,
      event: makeWorkChatEvent(from: entry.event),
      subagentTaskType: entry.subagentTaskType,
      subagentCommand: entry.subagentCommand
    )
  }
  .sorted(by: workChatEnvelopeOrderedBefore)
}

private func isSubagentTranscriptEnvelope(_ entry: AgentChatEventEnvelope) -> Bool {
  let target = entry.provenance?.targetKind?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return target == "codex_subagent" || target == "subagent"
}

private func normalizedWorkEventId(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

private func workSubagentParentItemId(_ event: AgentChatEvent) -> String? {
  switch event {
  case .subagentStarted(_, _, _, let parentAgentId, let parentToolUseId, _, _, _, _, _, _),
       .subagentProgress(_, _, _, let parentAgentId, let parentToolUseId, _, _, _, _, _, _, _, _),
       .subagentResult(_, _, _, let parentAgentId, let parentToolUseId, _, _, _, _, _, _, _):
    return normalizedWorkEventId(parentToolUseId) ?? normalizedWorkEventId(parentAgentId)
  default:
    return nil
  }
}

private func workSubagentParentItemIds(from entries: [AgentChatEventEnvelope]) -> Set<String> {
  Set(entries.compactMap { entry in
    guard !isSubagentTranscriptEnvelope(entry) else { return nil }
    return workSubagentParentItemId(entry.event)
  })
}

private func workEventItemAndParentIds(_ event: AgentChatEvent) -> (itemId: String?, parentItemId: String?) {
  switch event {
  case .toolCall(_, _, let itemId, _, let parentItemId, _),
       .toolResult(_, _, let itemId, _, let parentItemId, _, _):
    return (normalizedWorkEventId(itemId), normalizedWorkEventId(parentItemId))
  case .command(_, _, _, let itemId, _, _, _, _, _),
       .fileChange(_, _, _, let itemId, _, _, _),
       .webSearch(_, _, _, _, _, let itemId, _, _, _):
    return (normalizedWorkEventId(itemId), nil)
  case .approvalRequest(let itemId, let logicalItemId, _, _, _, _):
    return (normalizedWorkEventId(itemId) ?? normalizedWorkEventId(logicalItemId), nil)
  case .structuredQuestion(_, _, let itemId, _),
       .pendingInputResolved(let itemId, _, _):
    return (normalizedWorkEventId(itemId), nil)
  default:
    return (nil, nil)
  }
}

private func workSubagentChildItemIds(
  from entries: [AgentChatEventEnvelope],
  parentItemIds: Set<String>
) -> Set<String> {
  guard !parentItemIds.isEmpty else { return [] }
  var childIds = Set<String>()
  for entry in entries where !isSubagentTranscriptEnvelope(entry) {
    let ids = workEventItemAndParentIds(entry.event)
    if let parentItemId = ids.parentItemId,
       let itemId = ids.itemId,
       parentItemIds.contains(parentItemId) {
      childIds.insert(itemId)
    }
  }
  return childIds
}

private func isSubagentChildWorkEvent(
  _ event: AgentChatEvent,
  parentItemIds: Set<String>,
  childItemIds: Set<String>
) -> Bool {
  let ids = workEventItemAndParentIds(event)
  if let parentItemId = ids.parentItemId, parentItemIds.contains(parentItemId) {
    return true
  }
  if let itemId = ids.itemId, childItemIds.contains(itemId) {
    return true
  }
  return false
}

func isFallbackOnlyWorkTranscript(_ transcript: [WorkChatEnvelope]) -> Bool {
  guard !transcript.isEmpty else { return false }
  return transcript.allSatisfy { envelope in
    guard envelope.sequence == nil else { return false }
    switch envelope.event {
    case .userMessage:
      return true
    case .assistantText(_, _, let itemId):
      return itemId == nil
    default:
      return false
    }
  }
}

func preferredWorkTranscript(
  current: [WorkChatEnvelope],
  fallback: [WorkChatEnvelope],
  eventTranscript: [WorkChatEnvelope]
) -> [WorkChatEnvelope] {
  if !eventTranscript.isEmpty {
    let base = isFallbackOnlyWorkTranscript(current) ? [] : current
    let merged = mergeWorkChatTranscripts(base: base, live: eventTranscript)
    // The live event stream may be missing tail envelopes after a disconnect
    // or when the host didn't replay the full snapshot on re-subscribe. The
    // `chat.getTranscript` fallback always contains the canonical user /
    // assistant text history, so splice in any text envelopes that didn't
    // make it into the live stream (compared by role+turnId+text). Without
    // this, the final assistant reply after e.g. a plan rejection vanishes
    // from mobile while it still shows on desktop.
    let backfilled = backfillMissingTextEnvelopes(into: merged, fallback: fallback)
    let pruned = pruneResolvedQueuedSteerEnvelopes(backfilled)
    logPreferredWorkTranscriptResult(
      currentCount: current.count,
      fallbackCount: fallback.count,
      eventCount: eventTranscript.count,
      mergedCount: merged.count,
      backfilledCount: backfilled.count,
      prunedCount: pruned.count,
      usedEventStream: true,
      result: pruned
    )
    return pruned
  }
  if !fallback.isEmpty {
    let pruned = pruneResolvedQueuedSteerEnvelopes(fallback)
    logPreferredWorkTranscriptResult(
      currentCount: current.count,
      fallbackCount: fallback.count,
      eventCount: eventTranscript.count,
      mergedCount: fallback.count,
      backfilledCount: fallback.count,
      prunedCount: pruned.count,
      usedEventStream: false,
      result: pruned
    )
    return pruned
  }
  let pruned = pruneResolvedQueuedSteerEnvelopes(current)
  logPreferredWorkTranscriptResult(
    currentCount: current.count,
    fallbackCount: fallback.count,
    eventCount: eventTranscript.count,
    mergedCount: current.count,
    backfilledCount: current.count,
    prunedCount: pruned.count,
    usedEventStream: false,
    result: pruned
  )
  return pruned
}

/// When an idle session prefers the canonical text transcript, keep tool /
/// notice / queued-steer envelopes from the live event stream but drop the
/// plain user/assistant/status rows the fallback already owns.
func workChatEventIncludedInIdleCanonicalEventTranscript(_ event: WorkChatEvent) -> Bool {
  switch event {
  case .userMessage(_, _, _, let steerId, let deliveryState, _):
    return deliveryState == "queued" && steerId != nil
  case .assistantText, .status:
    return false
  default:
    return true
  }
}

private func backfillMissingTextEnvelopes(
  into transcript: [WorkChatEnvelope],
  fallback: [WorkChatEnvelope]
) -> [WorkChatEnvelope] {
  guard !fallback.isEmpty else { return transcript }
  var merged = transcript
  var seen: Set<String> = []
  for envelope in merged {
    for key in workTextBackfillDedupeKeys(for: envelope) {
      seen.insert(key)
    }
  }
  var didReplace = false
  var missing: [WorkChatEnvelope] = []
  for envelope in fallback {
    if replaceTruncatedTextEnvelope(in: &merged, with: envelope) {
      didReplace = true
      workTextBackfillDedupeKeys(for: envelope).forEach { seen.insert($0) }
      continue
    }
    if shouldSkipBackfillPlainUserMessage(fallback: envelope, merged: merged) {
      continue
    }
    if textEnvelopeAlreadyPresentForBackfill(fallback: envelope, merged: merged) {
      continue
    }
    let keys = workTextBackfillDedupeKeys(for: envelope)
    guard !keys.isEmpty, keys.allSatisfy({ !seen.contains($0) }) else { continue }
    keys.forEach { seen.insert($0) }
    missing.append(envelope)
  }
  guard didReplace || !missing.isEmpty else { return transcript }
  workChatTranscriptLog.notice(
    "text_backfill_changed session=\(workTranscriptSessionId(transcript, fallback: fallback), privacy: .public) replaced=\(didReplace, privacy: .public) missing=\(missing.count, privacy: .public) before=\(transcript.count, privacy: .public) after=\(merged.count + missing.count, privacy: .public) fallback=\(fallback.count, privacy: .public)"
  )
  merged.append(contentsOf: missing)
  return merged.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

private func replaceTruncatedTextEnvelope(
  in transcript: inout [WorkChatEnvelope],
  with fallback: WorkChatEnvelope
) -> Bool {
  guard let fallbackIdentity = workTextRoleTurnKey(for: fallback),
        let fallbackText = workTextEnvelopeText(fallback),
        !fallbackText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  else { return false }

  if textEnvelopeAlreadyPresentForBackfill(fallback: fallback, merged: transcript) {
    let beforeCount = transcript.count
    transcript.removeAll { candidate in
      guard workTextRoleTurnKey(for: candidate) == fallbackIdentity,
            let candidateText = workTextEnvelopeText(candidate)
      else { return false }
      return workTextShouldReplaceWithCanonicalFallback(candidateText: candidateText, fallbackText: fallbackText)
    }
    let removedStaleCandidate = transcript.count != beforeCount
    if removedStaleCandidate {
      transcript.append(fallback)
    }
    return removedStaleCandidate
  }

  guard let index = transcript.firstIndex(where: { candidate in
    guard workTextRoleTurnKey(for: candidate) == fallbackIdentity,
          let candidateText = workTextEnvelopeText(candidate)
    else { return false }
    return workTextShouldReplaceWithCanonicalFallback(candidateText: candidateText, fallbackText: fallbackText)
  }) else { return false }

  transcript[index] = fallback
  return true
}

private func workTextShouldReplaceWithCanonicalFallback(candidateText: String, fallbackText: String) -> Bool {
  let normalizedCandidate = candidateText.trimmingCharacters(in: .whitespacesAndNewlines)
  let normalizedFallback = fallbackText.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !normalizedCandidate.isEmpty,
        !normalizedFallback.isEmpty,
        normalizedCandidate != normalizedFallback
  else { return false }

  if workTextIsTruncatedVersion(normalizedCandidate, of: normalizedFallback) {
    return true
  }

  return workStreamingExistingOnlyAddsRepeatedIncomingTail(
    existing: normalizedCandidate,
    incoming: normalizedFallback
  )
}

private func workTextIsTruncatedVersion(_ candidateText: String, of fallbackText: String) -> Bool {
  let normalizedCandidate = candidateText.trimmingCharacters(in: .whitespacesAndNewlines)
  let normalizedFallback = fallbackText.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !normalizedCandidate.isEmpty, normalizedFallback.count > normalizedCandidate.count else {
    return false
  }
  return normalizedFallback.contains(normalizedCandidate)
    || normalizedFallback.hasSuffix(normalizedCandidate)
    || normalizedFallback.hasPrefix(normalizedCandidate)
}

/// Identity key for a user/assistant text envelope used for backfill dedup.
/// Fallback entries set `itemId: nil`, live envelopes carry an SDK-assigned
/// id — so plain equality on merge keys would treat "same message, different
/// source" as two rows. Keying on role + turnId + normalized text collapses
/// those correctly; missing turn IDs fall back to timestamp so repeated short
/// messages in separate turns do not collapse together.
private func workTextContentKey(for envelope: WorkChatEnvelope) -> String? {
  switch envelope.event {
  case .userMessage(let text, _, let turnId, let steerId, _, _):
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let turnKey = workTextDedupeTurnKey(turnId, timestamp: envelope.timestamp)
    return "user|\(turnKey)|\(steerId ?? "")|\(normalized)"
  case .assistantText(let text, let turnId, _):
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let turnKey = workTextDedupeTurnKey(turnId, timestamp: envelope.timestamp)
    return "assistant|\(turnKey)|\(normalized)"
  default:
    return nil
  }
}

private func workTextBackfillDedupeKeys(for envelope: WorkChatEnvelope) -> [String] {
  guard let key = workTextContentKey(for: envelope) else { return [] }
  switch envelope.event {
  case .userMessage(let text, _, let turnId, _, _, _):
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let turnKey = workTextDedupeTurnKey(turnId, timestamp: envelope.timestamp)
    return [key, "user|\(turnKey)|\(normalized)"]
  default:
    return [key]
  }
}

private func workTextRoleTurnKey(for envelope: WorkChatEnvelope) -> String? {
  switch envelope.event {
  case .userMessage(_, _, let turnId, let steerId, _, _):
    let turnKey = workTextDedupeTurnKey(turnId, timestamp: envelope.timestamp)
    return "user|\(turnKey)|\(steerId ?? "")"
  case .assistantText(_, let turnId, _):
    let turnKey = workTextDedupeTurnKey(turnId, timestamp: envelope.timestamp)
    return "assistant|\(turnKey)"
  default:
    return nil
  }
}

private func workTextDedupeTurnKey(_ turnId: String?, timestamp: String) -> String {
  let normalizedTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return normalizedTurnId.isEmpty ? "timestamp:\(timestamp)" : "turn:\(normalizedTurnId)"
}

private func workTextEnvelopeText(_ envelope: WorkChatEnvelope) -> String? {
  switch envelope.event {
  case .userMessage(let text, _, _, _, _, _):
    return text
  case .assistantText(let text, _, _):
    return text
  default:
    return nil
  }
}

/// The host text transcript omits steer metadata, so backfilling a plain user
/// row while a queued steer envelope is already present would render the same
/// prompt twice — once in the staged strip and again as a sent bubble.
private func shouldSkipBackfillPlainUserMessage(
  fallback: WorkChatEnvelope,
  merged: [WorkChatEnvelope]
) -> Bool {
  guard case .userMessage(let text, _, let turnId, let steerId, let deliveryState, _) = fallback.event else {
    return false
  }
  guard steerId == nil, deliveryState != "queued" else { return false }
  let normalizedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
  let normalizedTurnId = turnId ?? ""
  for envelope in merged {
    guard case .userMessage(let liveText, _, let liveTurnId, let liveSteerId, let liveDelivery, _) = envelope.event else {
      continue
    }
    guard liveDelivery == "queued", liveSteerId != nil else { continue }
    if (liveTurnId ?? "") == normalizedTurnId { return true }
    if liveText.trimmingCharacters(in: .whitespacesAndNewlines) == normalizedText { return true }
  }
  return false
}

private func textEnvelopeAlreadyPresentForBackfill(
  fallback: WorkChatEnvelope,
  merged: [WorkChatEnvelope]
) -> Bool {
  guard let fallbackText = workTextEnvelopeText(fallback)?.trimmingCharacters(in: .whitespacesAndNewlines),
        !fallbackText.isEmpty
  else { return false }
  let fallbackTurnId = workTextTurnId(for: fallback)
  let fallbackRole = workTextRole(for: fallback)
  for candidate in merged {
    guard workTextRole(for: candidate) == fallbackRole,
          let candidateText = workTextEnvelopeText(candidate)?.trimmingCharacters(in: .whitespacesAndNewlines)
    else { continue }
    let candidateTurnId = workTextTurnId(for: candidate)
    if !fallbackTurnId.isEmpty, !candidateTurnId.isEmpty {
      guard fallbackTurnId == candidateTurnId else { continue }
    } else {
      guard candidate.timestamp == fallback.timestamp else { continue }
    }
    if candidateText == fallbackText ||
       workTextContainsBackfillFragment(candidateText: candidateText, fallbackText: fallbackText) {
      return true
    }
  }
  return false
}

private func workTextContainsBackfillFragment(candidateText: String, fallbackText: String) -> Bool {
  guard candidateText.count >= fallbackText.count,
        fallbackText.count >= workStreamingMergeMinimumRepeatedTailLength
  else { return false }
  return candidateText.contains(fallbackText)
    || candidateText.hasSuffix(fallbackText)
    || candidateText.hasPrefix(fallbackText)
}

private func workTextRole(for envelope: WorkChatEnvelope) -> String? {
  switch envelope.event {
  case .userMessage:
    return "user"
  case .assistantText:
    return "assistant"
  default:
    return nil
  }
}

private func workTextTurnId(for envelope: WorkChatEnvelope) -> String {
  let raw: String?
  switch envelope.event {
  case .userMessage(_, _, let turnId, _, _, _):
    raw = turnId
  case .assistantText(_, let turnId, _):
    raw = turnId
  default:
    raw = nil
  }
  return raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

private func workTranscriptSessionId(_ transcript: [WorkChatEnvelope], fallback: [WorkChatEnvelope]) -> String {
  transcript.first?.sessionId ?? fallback.first?.sessionId ?? "unknown"
}

private func logPreferredWorkTranscriptResult(
  currentCount: Int,
  fallbackCount: Int,
  eventCount: Int,
  mergedCount: Int,
  backfilledCount: Int,
  prunedCount: Int,
  usedEventStream: Bool,
  result: [WorkChatEnvelope]
) {
  let duplicateTextCount = duplicateWorkTextEnvelopeCount(result)
  workChatTranscriptLog.notice(
    "preferred_transcript session=\(result.first?.sessionId ?? "unknown", privacy: .public) current=\(currentCount, privacy: .public) fallback=\(fallbackCount, privacy: .public) event=\(eventCount, privacy: .public) merged=\(mergedCount, privacy: .public) backfilled=\(backfilledCount, privacy: .public) pruned=\(prunedCount, privacy: .public) usedEvents=\(usedEventStream, privacy: .public) duplicateText=\(duplicateTextCount, privacy: .public) tail=\(result.last?.id ?? "none", privacy: .public)"
  )
}

private func duplicateWorkTextEnvelopeCount(_ transcript: [WorkChatEnvelope]) -> Int {
  var seen = Set<String>()
  var duplicateCount = 0
  for envelope in transcript {
    guard let role = workTextRole(for: envelope),
          let text = workTextEnvelopeText(envelope)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !text.isEmpty
    else { continue }
    let key = "\(role)|\(workTextTurnId(for: envelope))|\(text)"
    if !seen.insert(key).inserted {
      duplicateCount += 1
    }
  }
  return duplicateCount
}

/// Drop stale queued `user_message` rows once the same steerId has graduated
/// to delivered/inline/failed or been resolved by a steer system notice.
func pruneResolvedQueuedSteerEnvelopes(_ transcript: [WorkChatEnvelope]) -> [WorkChatEnvelope] {
  guard !transcript.isEmpty else { return transcript }
  var resolvedSteerIds = Set<String>()
  var queuedSteerIdsByText: [String: Set<String>] = [:]
  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .userMessage(let text, _, _, let steerId, let deliveryState, _):
      if let steerId, deliveryState == "queued" {
        let normalizedText = normalizedQueuedSteerText(text)
        if !normalizedText.isEmpty {
          queuedSteerIdsByText[normalizedText, default: []].insert(steerId)
        }
      } else {
        // A delivered/inline/failed row graduates at most ONE queued steer.
        // Prefer the exact steerId match; only fall back to text (consuming a
        // single queued id) so duplicate prompts don't clear multiple pending
        // steers at once.
        let normalizedText = normalizedQueuedSteerText(text)
        if let steerId {
          resolvedSteerIds.insert(steerId)
          if !normalizedText.isEmpty {
            if queuedSteerIdsByText[normalizedText]?.contains(steerId) == true {
              queuedSteerIdsByText[normalizedText]?.remove(steerId)
            } else if let consumed = queuedSteerIdsByText[normalizedText]?.first {
              resolvedSteerIds.insert(consumed)
              queuedSteerIdsByText[normalizedText]?.remove(consumed)
            }
          }
        } else if !normalizedText.isEmpty, let consumed = queuedSteerIdsByText[normalizedText]?.first {
          resolvedSteerIds.insert(consumed)
          queuedSteerIdsByText[normalizedText]?.remove(consumed)
        }
      }
    case .systemNotice(_, let message, _, _, let steerId):
      if let steerId, workSystemNoticeResolvesQueuedSteer(message) {
        resolvedSteerIds.insert(steerId)
      }
    default:
      continue
    }
  }
  guard !resolvedSteerIds.isEmpty else { return transcript }
  return transcript.filter { envelope in
    guard case .userMessage(_, _, _, let steerId, let deliveryState, _) = envelope.event,
          let steerId,
          deliveryState == "queued",
          resolvedSteerIds.contains(steerId)
    else { return true }
    return false
  }
}

func mergeWorkChatTranscripts(base: [WorkChatEnvelope], live: [WorkChatEnvelope]) -> [WorkChatEnvelope] {
  guard !live.isEmpty else { return base }

  var merged: [WorkChatEnvelope] = []
  merged.reserveCapacity(base.count + live.count)
  var indexByKey: [String: Int] = [:]

  for envelope in base + live {
    let key = workChatEnvelopeMergeKey(envelope)
    if let existing = indexByKey[key] {
      merged[existing] = mergedWorkChatEnvelope(existing: merged[existing], incoming: envelope)
    } else {
      indexByKey[key] = merged.count
      merged.append(envelope)
    }
  }

  return merged.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

func appendWorkChatTranscripts(base: [WorkChatEnvelope], live: [WorkChatEnvelope]) -> [WorkChatEnvelope] {
  guard !live.isEmpty else { return base }

  var merged = base
  merged.reserveCapacity(base.count + live.count)
  var indexByKey: [String: Int] = [:]
  indexByKey.reserveCapacity(base.count + live.count)
  for (index, envelope) in merged.enumerated() {
    indexByKey[workChatEnvelopeMergeKey(envelope)] = index
  }

  var needsSort = false
  for envelope in live {
    let key = workChatEnvelopeMergeKey(envelope)
    if let existing = indexByKey[key] {
      let previous = merged[existing]
      merged[existing] = mergedWorkChatEnvelope(existing: previous, incoming: envelope)
      if previous.timestamp != envelope.timestamp || previous.sequence != envelope.sequence {
        needsSort = true
      }
      continue
    }

    if let last = merged.last, !workChatEnvelopeSortPrecedesOrMatches(last, envelope) {
      needsSort = true
    }
    indexByKey[key] = merged.count
    merged.append(envelope)
  }

  guard needsSort else { return merged }
  return merged.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

private func workChatEnvelopeSortPrecedesOrMatches(_ lhs: WorkChatEnvelope, _ rhs: WorkChatEnvelope) -> Bool {
  if lhs.timestamp == rhs.timestamp {
    return (lhs.sequence ?? 0) <= (rhs.sequence ?? 0)
  }
  return lhs.timestamp <= rhs.timestamp
}

private func mergedWorkChatEnvelope(existing: WorkChatEnvelope, incoming: WorkChatEnvelope) -> WorkChatEnvelope {
  switch (existing.event, incoming.event) {
  case (
    .assistantText(let existingText, let existingTurnId, let existingItemId),
    .assistantText(let incomingText, let incomingTurnId, let incomingItemId)
  ):
    // Keep the earlier envelope's ordering key so a stable-key assistant message
    // doesn't jump to the latest fragment position when the transcript is sorted,
    // which would reorder the visible timeline around tool/status events.
    let keepExistingOrder = workChatEnvelopeSortPrecedesOrMatches(existing, incoming)
    return WorkChatEnvelope(
      sessionId: incoming.sessionId,
      timestamp: keepExistingOrder ? existing.timestamp : incoming.timestamp,
      sequence: keepExistingOrder ? existing.sequence : incoming.sequence,
      event: .assistantText(
        text: mergeWorkStreamingText(existingText, incomingText),
        turnId: incomingTurnId ?? existingTurnId,
        itemId: incomingItemId ?? existingItemId
      )
    )
  default:
    return incoming
  }
}

enum WorkPendingInputItem: Identifiable, Equatable {
  case approval(WorkPendingApprovalModel)
  case question(WorkPendingQuestionModel)
  case permission(WorkPendingPermissionModel)
  /// Plan-approval gate — agent finished planning and is waiting for
  /// Approve & Implement or Reject & Revise before acting.
  case planApproval(WorkPendingPlanApprovalModel)
  case modelSelection(WorkPendingModelSelectionModel)

  var id: String {
    switch self {
    case .approval(let model): return "approval:\(model.id)"
    case .question(let model): return "question:\(model.id)"
    case .permission(let model): return "permission:\(model.id)"
    case .planApproval(let model): return "plan-approval:\(model.id)"
    case .modelSelection(let model): return "model-selection:\(model.id)"
    }
  }

  var itemId: String {
    switch self {
    case .approval(let model): return model.id
    case .question(let model): return model.id
    case .permission(let model): return model.id
    case .planApproval(let model): return model.id
    case .modelSelection(let model): return model.id
    }
  }
}

struct WorkPendingSteerModel: Identifiable, Equatable {
  let id: String
  var text: String
  var attachments: [AgentChatFileRef]? = nil
  let turnId: String?
  let timestamp: String
}

func workJSONObject(from text: String?) -> [String: Any]? {
  guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines),
        !text.isEmpty,
        let data = text.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else {
    return nil
  }
  return object
}

func workBoolValue(_ value: Any?) -> Bool? {
  if let bool = value as? Bool {
    return bool
  }
  if let number = value as? NSNumber {
    return number.boolValue
  }
  if let string = value as? String {
    switch string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "true", "1", "yes": return true
    case "false", "0", "no": return false
    default: return nil
    }
  }
  return nil
}

func workPendingQuestionOption(from value: Any?) -> WorkPendingQuestionOption? {
  guard let object = value as? [String: Any] else { return nil }
  let label = optionalString(object["label"]) ?? optionalString(object["value"]) ?? ""
  let rawValue: String
  if object.keys.contains("value") {
    let text = stringValue(object["value"])
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    rawValue = text
  } else {
    rawValue = label
  }
  guard !label.isEmpty else { return nil }
  return WorkPendingQuestionOption(
    label: label,
    value: rawValue,
    description: optionalString(object["description"]),
    recommended: workBoolValue(object["recommended"]) ?? false,
    preview: optionalString(object["preview"]),
    previewFormat: optionalString(object["previewFormat"])
  )
}

func workStringArrayValue(_ value: Any?) -> [String]? {
  guard let array = value as? [Any] else { return nil }
  let strings = array.compactMap { optionalString($0) }
  return strings.isEmpty ? nil : strings
}

/// Map a single question dictionary (one entry in the request's `questions` array,
/// or a flat ask_user tool-call args blob) into the structured question model.
/// Falls back onto outer scope (`request` / args root) for flags/metadata so the
/// parent card retains legacy single-question behavior.
func workPendingQuestionEntry(
  from object: [String: Any],
  fallback: [String: Any],
  index: Int,
  fallbackQuestionText: String? = nil
) -> WorkPendingQuestion {
  let questionId = optionalString(object["id"])
    ?? optionalString(fallback["id"])
    ?? (index == 0 ? "response" : "response-\(index)")
  let questionText = optionalString(object["question"])
    ?? optionalString(fallback["description"])
    ?? optionalString(fallback["title"])
    ?? fallbackQuestionText
    ?? ""
  let header = optionalString(object["header"]) ?? optionalString(object["label"])
  let rawOptions = (object["options"] as? [Any]) ?? (fallback["options"] as? [Any]) ?? []
  let options = rawOptions.compactMap { workPendingQuestionOption(from: $0) }
  let allowsFreeform = workBoolValue(object["allowsFreeform"])
    ?? workBoolValue(fallback["allowsFreeform"])
    ?? options.isEmpty
  let multiSelect = workBoolValue(object["multiSelect"])
    ?? workBoolValue(fallback["multiSelect"])
    ?? false
  let isSecret = workBoolValue(object["isSecret"])
    ?? workBoolValue(fallback["isSecret"])
    ?? false
  let defaultAssumption = optionalString(object["defaultAssumption"])
    ?? optionalString(fallback["defaultAssumption"])
  let impact = optionalString(object["impact"]) ?? optionalString(fallback["impact"])
  return WorkPendingQuestion(
    questionId: questionId,
    question: questionText,
    options: options,
    allowsFreeform: allowsFreeform,
    header: header,
    defaultAssumption: defaultAssumption,
    impact: impact,
    multiSelect: multiSelect,
    isSecret: isSecret
  )
}

func pendingWorkQuestionFromApproval(
  description: String,
  detail: String?,
  itemId: String
) -> WorkPendingQuestionModel? {
  guard let detailObject = workJSONObject(from: detail) else { return nil }
  if let request = detailObject["request"] as? [String: Any] {
    let kind = optionalString(request["kind"])?.lowercased() ?? ""
    let rawQuestions = request["questions"] as? [[String: Any]] ?? []
    guard kind == "question" || kind == "structured_question" || !rawQuestions.isEmpty else {
      return nil
    }
    let source: [[String: Any]] = rawQuestions.isEmpty ? [[:]] : rawQuestions
    let questions = source.enumerated().map { index, raw in
      workPendingQuestionEntry(
        from: raw,
        fallback: request,
        index: index,
        fallbackQuestionText: description
      )
    }
    return WorkPendingQuestionModel(
      id: itemId,
      questions: questions,
      title: optionalString(request["title"]),
      body: optionalString(request["body"]) ?? optionalString(request["description"]),
      source: optionalString(request["source"]) ?? optionalString(detailObject["source"])
    )
  }

  let request = detailObject["request"] as? [String: Any] ?? [:]
  let tool = optionalString(detailObject["tool"])
    ?? optionalString(request["tool"])
    ?? optionalString(request["toolName"])
    ?? ""
  let questionText = optionalString(detailObject["question"]) ?? description
  guard isQuestionInputToolName(tool), !questionText.isEmpty else {
    return nil
  }
  let options = (detailObject["options"] as? [Any] ?? [])
    .compactMap { workPendingQuestionOption(from: $0) }
  let single = WorkPendingQuestion(
    questionId: "response",
    question: questionText,
    options: options,
    allowsFreeform: true,
    defaultAssumption: optionalString(detailObject["defaultAssumption"]),
    impact: optionalString(detailObject["impact"]),
    multiSelect: workBoolValue(detailObject["multiSelect"]) ?? false,
    isSecret: workBoolValue(detailObject["isSecret"]) ?? false
  )
  return WorkPendingQuestionModel(
    id: itemId,
    questions: [single],
    title: optionalString(detailObject["title"]),
    body: optionalString(detailObject["body"]) ?? optionalString(detailObject["description"]),
    source: optionalString(request["source"])
      ?? optionalString(detailObject["source"])
  )
}

/// Fallback parser for ask_user invocations that arrive as raw `tool_call` envelopes
/// without a wrapping `approval_request`. Returns nil unless the call is still pending
/// (no matching tool_result yet).
func pendingWorkQuestionFromAskUserToolCall(
  argsText: String,
  itemId: String
) -> WorkPendingQuestionModel? {
  guard let object = workJSONObject(from: argsText) else { return nil }
  // Modern protocol payloads can wrap ask input under a `request` object
  // (same shape as desktop approval detail), so read both legacy flat shape
  // and the nested shape used by current request handlers.
  let request = object["request"] as? [String: Any] ?? [:]
  let sourceObject = !request.isEmpty ? request : object
  let rawQuestions = sourceObject["questions"] as? [[String: Any]] ?? []
  let source: [[String: Any]] = rawQuestions.isEmpty ? [sourceObject] : rawQuestions
  let fallbackQuestionText =
    optionalString(sourceObject["question"])
    ?? optionalString(object["question"])
    ?? optionalString(object["title"])
    ?? optionalString(request["description"])
  // The raw-args legacy shape needs a question string to be valid at all.
  if rawQuestions.isEmpty, fallbackQuestionText == nil { return nil }
  let questions = source.enumerated().map { index, raw in
    workPendingQuestionEntry(
      from: raw,
      fallback: request.isEmpty ? object : sourceObject,
      index: index,
      fallbackQuestionText: fallbackQuestionText
    )
  }
  guard questions.contains(where: { !$0.question.isEmpty }) else { return nil }
  return WorkPendingQuestionModel(
    id: itemId,
    questions: questions,
    title: optionalString(sourceObject["title"]) ?? optionalString(object["title"]),
    body: optionalString(sourceObject["body"]) ?? optionalString(request["description"]) ?? optionalString(object["body"]),
    source: optionalString(sourceObject["source"]) ?? optionalString(object["source"])
  )
}

/// When `pendingWorkQuestionFromApproval` returns nil for an approval, check whether
/// it's a generic MCP permission gate (other than auto-allowed `ask_user`) that the
/// UI should surface as an Allow / Allow-for-session / Decline card.
func pendingWorkPermissionFromApproval(
  description: String,
  detail: String?,
  itemId: String
) -> WorkPendingPermissionModel? {
  guard let detailObject = workJSONObject(from: detail) else { return nil }
  let request = detailObject["request"] as? [String: Any] ?? detailObject
  let kind = optionalString(request["kind"])?.lowercased() ?? ""
  guard kind == "permissions" || kind == "permission" else { return nil }
  let tool = optionalString(request["tool"])
    ?? optionalString(request["toolName"])
    ?? optionalString(detailObject["tool"])
    ?? ""
  // Question tools should be routed through the structured-question path. If one
  // slips through this branch, avoid double-rendering a redundant permission card.
  if isQuestionInputToolName(tool) {
    return nil
  }
  return WorkPendingPermissionModel(
    id: itemId,
    tool: tool.isEmpty ? "tool" : tool,
    description: description,
    detail: optionalString(request["description"]) ?? optionalString(detailObject["description"])
  )
}

/// Parse an `approval_request` detail blob whose `request.kind == "plan_approval"` into the
/// dedicated plan-approval model. Returns nil for anything that isn't a plan-approval gate.
func pendingWorkPlanApprovalFromApproval(
  description: String,
  detail: String?,
  itemId: String
) -> WorkPendingPlanApprovalModel? {
  // The plan text lives in one of several places depending on the provider:
  //   detail.request.kind == "plan_approval"
  //   detail.request.description or detail.request.questions[0].question (plan body)
  //   detail.planContent (raw plan text emitted by the codex path)
  guard let detailObject = workJSONObject(from: detail) else {
    return nil
  }
  let request = detailObject["request"] as? [String: Any] ?? [:]
  let kind = (optionalString(request["kind"]) ?? "").lowercased()
  guard kind == "plan_approval" else { return nil }
  let source = optionalString(request["source"])
    ?? optionalString(detailObject["tool"])?.lowercased() ?? ""
  let planText: String = {
    // Prefer the plan text from providerMetadata.planContent, then the
    // question text, then the description field, then fall back to the
    // outer approval_request description so the card always has something
    // to show.
    if let meta = request["providerMetadata"] as? [String: Any],
       let content = optionalString(meta["planContent"] ?? meta["plan"]) {
      return content
    }
    if let questions = request["questions"] as? [[String: Any]],
       let firstQuestion = questions.first,
       let q = optionalString(firstQuestion["question"]) {
      return q
    }
    if let reqDesc = optionalString(request["description"]) {
      return reqDesc
    }
    if let planContent = optionalString(detailObject["planContent"]) {
      return planContent
    }
    return description
  }()
  let title = optionalString(request["title"]) ?? "Plan Ready for Review"
  return WorkPendingPlanApprovalModel(
    id: itemId,
    source: source,
    planText: planText,
    title: title
  )
}

func workModelSelectionChoice(from value: Any?) -> WorkModelSelectionChoice? {
  guard let object = value as? [String: Any] else { return nil }
  guard let provider = optionalString(object["provider"]),
        let modelId = optionalString(object["modelId"])
  else { return nil }
  return WorkModelSelectionChoice(
    provider: provider,
    modelId: modelId,
    reasoningEffort: optionalString(object["reasoningEffort"]),
    fastMode: workBoolValue(object["fastMode"]) ?? workBoolValue(object["codexFastMode"])
  )
}

func pendingWorkModelSelectionFromApproval(
  description: String,
  detail: String?,
  itemId: String
) -> WorkPendingModelSelectionModel? {
  guard let detailObject = workJSONObject(from: detail) else { return nil }
  let request = detailObject["request"] as? [String: Any] ?? [:]
  let kind = (optionalString(request["kind"]) ?? "").lowercased()
  guard kind == "model_selection" else { return nil }
  let metadata = request["providerMetadata"] as? [String: Any] ?? [:]
  let role = optionalString(metadata["role"]) ?? "worker"
  let tag = optionalString(metadata["tag"]) ?? ""
  let workDescription = (optionalString(metadata["workDescription"])
    ?? optionalString(request["description"])
    ?? description)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  return WorkPendingModelSelectionModel(
    id: itemId,
    role: role,
    tag: tag,
    workDescription: workDescription.isEmpty ? nil : workDescription,
    filesHint: workStringArrayValue(metadata["filesHint"]) ?? [],
    dependsOn: workStringArrayValue(metadata["dependsOn"]) ?? [],
    availableModelIds: workStringArrayValue(metadata["availableModels"])
  )
}

/// Ordered list of still-open pending inputs (approvals + structured questions + permission
/// gates) in the order they were requested. Mirrors the desktop `derivePendingInputRequests`
/// helper — resolved items are filtered out using the same predicate as `pendingWorkInputItemIds`.
func derivePendingWorkInputs(from transcript: [WorkChatEnvelope]) -> [WorkPendingInputItem] {
  let openIds = pendingWorkInputItemIds(from: transcript)
  var seen = Set<String>()
  var results: [WorkPendingInputItem] = []
  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .approvalRequest(let description, let detail, let itemId, _):
      guard openIds.contains(itemId), !seen.contains(itemId) else { continue }
      seen.insert(itemId)
      if let modelSelection = pendingWorkModelSelectionFromApproval(description: description, detail: detail, itemId: itemId) {
        results.append(.modelSelection(modelSelection))
      } else if let planApproval = pendingWorkPlanApprovalFromApproval(description: description, detail: detail, itemId: itemId) {
        results.append(.planApproval(planApproval))
      } else if let question = pendingWorkQuestionFromApproval(description: description, detail: detail, itemId: itemId) {
        results.append(.question(question))
      } else if let permission = pendingWorkPermissionFromApproval(description: description, detail: detail, itemId: itemId) {
        results.append(.permission(permission))
      } else {
        results.append(.approval(WorkPendingApprovalModel(id: itemId, description: description, detail: detail)))
      }
    case .structuredQuestion(let question, let options, let itemId, _):
      guard openIds.contains(itemId), !seen.contains(itemId) else { continue }
      seen.insert(itemId)
      let entry = WorkPendingQuestion(
        questionId: "response",
        question: question,
        options: options,
        allowsFreeform: true
      )
      results.append(.question(WorkPendingQuestionModel(id: itemId, questions: [entry])))
    case .toolCall(let tool, let argsText, let itemId, _, _):
      guard openIds.contains(itemId), !seen.contains(itemId) else { continue }
      guard isQuestionInputToolName(tool) else { continue }
      guard let question = pendingWorkQuestionFromAskUserToolCall(argsText: argsText, itemId: itemId) else { continue }
      seen.insert(itemId)
      results.append(.question(question))
    default:
      continue
    }
  }
  return results
}

func isAskUserToolName(_ tool: String) -> Bool {
  let normalized = normalizedWorkToolIdentity(tool)
  return normalized == "ask_user" || normalized == "askuser" || normalized == "mcp_ade_ask_user"
}

func isRequestUserInputToolName(_ tool: String) -> Bool {
  let normalized = normalizedWorkToolIdentity(tool)
  return normalized == "request_user_input"
    || normalized == "requestuserinput"
    || normalized == "mcp_ade_request_user_input"
}

func isQuestionInputToolName(_ tool: String) -> Bool {
  isAskUserToolName(tool) || isRequestUserInputToolName(tool)
}

private func normalizedWorkToolIdentity(_ tool: String) -> String {
  let unqualified = tool.split(separator: ":", omittingEmptySubsequences: true).last.map(String.init) ?? tool
  return unqualified
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .replacingOccurrences(of: "-", with: "_")
    .replacingOccurrences(of: #"_+"#, with: "_", options: .regularExpression)
}

/// Ordered list of queued steer messages (user messages with `deliveryState == "queued"` and a
/// `steerId`). Removed once a `system_notice` referencing the same steerId arrives (desktop emits
/// one for both "cancelled" and "delivering") or once the event graduates out of the queued state.
func derivePendingWorkSteers(from transcript: [WorkChatEnvelope]) -> [WorkPendingSteerModel] {
  var queue: [String: WorkPendingSteerModel] = [:]
  var order: [String] = []
  var resolved = Set<String>()
  var queuedSteerIdsByText: [String: Set<String>] = [:]
  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .userMessage(let text, let attachments, let turnId, let steerId, let deliveryState, _):
      if let steerId, deliveryState == "queued", !resolved.contains(steerId) {
        if queue[steerId] == nil { order.append(steerId) }
        queue[steerId] = WorkPendingSteerModel(
          id: steerId,
          text: text,
          attachments: attachments,
          turnId: turnId,
          timestamp: envelope.timestamp
        )
        let normalizedText = normalizedQueuedSteerText(text)
        if !normalizedText.isEmpty {
          queuedSteerIdsByText[normalizedText, default: []].insert(steerId)
        }
      } else {
        // Graduate at most ONE queued steer per delivered row: prefer the exact
        // steerId, then fall back to consuming a single text-matched queued id so
        // a duplicate prompt doesn't clear multiple pending steers at once.
        let normalizedText = normalizedQueuedSteerText(text)
        if let steerId, deliveryState == "delivered" || deliveryState == "inline" || deliveryState == "failed" {
          queue.removeValue(forKey: steerId)
          resolved.insert(steerId)
          if !normalizedText.isEmpty {
            if queuedSteerIdsByText[normalizedText]?.contains(steerId) == true {
              queuedSteerIdsByText[normalizedText]?.remove(steerId)
            } else if let consumed = queuedSteerIdsByText[normalizedText]?.first {
              queue.removeValue(forKey: consumed)
              resolved.insert(consumed)
              queuedSteerIdsByText[normalizedText]?.remove(consumed)
            }
          }
        } else if !normalizedText.isEmpty, let consumed = queuedSteerIdsByText[normalizedText]?.first {
          queue.removeValue(forKey: consumed)
          resolved.insert(consumed)
          queuedSteerIdsByText[normalizedText]?.remove(consumed)
        }
      }
    case .systemNotice(_, let message, _, _, let steerId):
      if let steerId, workSystemNoticeResolvesQueuedSteer(message) {
        queue.removeValue(forKey: steerId)
        resolved.insert(steerId)
      }
    default:
      continue
    }
  }
  return order.compactMap { queue[$0] }
}

func normalizedQueuedSteerText(_ text: String) -> String {
  text
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    .lowercased()
}

func workSystemNoticeResolvesQueuedSteer(_ message: String) -> Bool {
  let normalized = message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return normalized.contains("cancelled")
    || normalized.contains("canceled")
    || normalized.contains("delivering")
}

func pendingWorkInputItemIds(from transcript: [WorkChatEnvelope]) -> Set<String> {
  var approvals: [String: String?] = [:]
  var questions: [String: String?] = [:]

  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .approvalRequest(let description, let detail, let itemId, let turnId):
      if pendingWorkQuestionFromApproval(description: description, detail: detail, itemId: itemId) != nil {
        questions.updateValue(turnId, forKey: itemId)
      } else {
        approvals.updateValue(turnId, forKey: itemId)
      }
    case .structuredQuestion(_, _, let itemId, let turnId):
      questions.updateValue(turnId, forKey: itemId)
    case .toolCall(let tool, let argsText, let itemId, _, let turnId):
      if isQuestionInputToolName(tool),
         pendingWorkQuestionFromAskUserToolCall(argsText: argsText, itemId: itemId) != nil {
        questions.updateValue(turnId, forKey: itemId)
      }
    case .pendingInputResolved(let itemId, _, _):
      approvals.removeValue(forKey: itemId)
      questions.removeValue(forKey: itemId)
    case .toolResult(_, _, let itemId, _, _, _),
         .command(_, _, _, _, let itemId, _, _, _),
         .fileChange(_, _, _, _, let itemId, _):
      approvals.removeValue(forKey: itemId)
      questions.removeValue(forKey: itemId)
    case .done(let status, _, _, let turnId, _, _, _):
      if status == "completed" {
        approvals = approvals.filter { $0.value != turnId }
      } else {
        approvals.removeAll()
        questions.removeAll()
      }
    default:
      continue
    }
  }

  return Set(approvals.keys).union(questions.keys)
}

func sortedWorkChatEnvelopes(_ transcript: [WorkChatEnvelope]) -> [WorkChatEnvelope] {
  transcript.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

func workChatEnvelopeMergeKey(_ envelope: WorkChatEnvelope) -> String {
  if let stableKey = workChatEnvelopeStableUpdateKey(envelope) {
    return stableKey
  }
  return "\(envelope.sessionId)|\(envelope.timestamp)|\(workChatEventMergeKey(envelope.event))"
}

private func workChatEnvelopeStableUpdateKey(_ envelope: WorkChatEnvelope) -> String? {
  switch envelope.event {
  case .assistantText(_, let turnId, let itemId):
    let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !normalizedItemId.isEmpty else { return nil }
    return [
      envelope.sessionId,
      "assistant_text",
      turnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
      normalizedItemId,
    ].joined(separator: "|")
  default:
    return nil
  }
}

func workChatEventMergeKey(_ event: WorkChatEvent) -> String {
  switch event {
  case .userMessage(let text, let attachments, let turnId, let steerId, let deliveryState, let processed):
    // Queued steers are uniquely identified by steerId so that editSteer replaces the existing
    // entry in place instead of spawning a duplicate row whose only difference is the edited text.
    if let steerId, deliveryState == "queued" {
      return ["user_message", turnId ?? "", steerId, "queued"].joined(separator: "|")
    }
    let attachmentDigest = (attachments ?? []).map { "\($0.type):\($0.path)" }.joined(separator: ",")
    return ["user_message", turnId ?? "", steerId ?? "", deliveryState ?? "", processed.map { $0 ? "1" : "0" } ?? "", attachmentDigest, text].joined(separator: "|")
  case .userMessageResolution(let steerId, let action, let state, let resolvedAt, let replacementMessageId, let turnId):
    return [
      "user_message_resolution",
      turnId ?? "",
      steerId,
      action,
      state,
      resolvedAt,
      replacementMessageId ?? "",
    ].joined(separator: "|")
  case .assistantText(let text, let turnId, let itemId):
    let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !normalizedItemId.isEmpty {
      return ["text", turnId ?? "", normalizedItemId].joined(separator: "|")
    }
    return ["text", turnId ?? "", text].joined(separator: "|")
  case .toolCall(let tool, let argsText, let itemId, let parentItemId, let turnId):
    return ["tool_call", turnId ?? "", itemId, parentItemId ?? "", tool, argsText].joined(separator: "|")
  case .toolResult(let tool, let resultText, let itemId, let parentItemId, let turnId, let status):
    return ["tool_result", turnId ?? "", itemId, parentItemId ?? "", tool, status.rawValue, resultText].joined(separator: "|")
  case .activity(let kind, let detail, let turnId):
    return ["activity", turnId ?? "", kind, detail ?? ""].joined(separator: "|")
  case .plan(let steps, let explanation, let turnId):
    let stepDigest = steps.map { "\($0.status):\($0.text)" }.joined(separator: "\n")
    return ["plan", turnId ?? "", explanation ?? "", stepDigest].joined(separator: "|")
  case .subagentStarted(let taskId, let agentId, let agentType, let parentToolUseId, let description, let background, let label, let model, let reasoningEffort, let turnId):
    return ["subagent_started", turnId ?? "", taskId, agentId ?? "", agentType ?? "", parentToolUseId ?? "", description, background ? "1" : "0", label ?? "", model ?? "", reasoningEffort ?? ""].joined(separator: "|")
  case .subagentProgress(let taskId, let agentId, let agentType, let parentToolUseId, let description, let summary, let toolName, let label, let model, let reasoningEffort, let turnId):
    return ["subagent_progress", turnId ?? "", taskId, agentId ?? "", agentType ?? "", parentToolUseId ?? "", description ?? "", summary, toolName ?? "", label ?? "", model ?? "", reasoningEffort ?? ""].joined(separator: "|")
  case .subagentResult(let taskId, let agentId, let agentType, let parentToolUseId, let status, let summary, let label, let model, let reasoningEffort, let turnId):
    return ["subagent_result", turnId ?? "", taskId, agentId ?? "", agentType ?? "", parentToolUseId ?? "", status, summary, label ?? "", model ?? "", reasoningEffort ?? ""].joined(separator: "|")
  case .scheduledWorkUpdate(let id, let kind, let status, let origin, let title, let summary, let prompt, let reason, let cron, let nextRunAt, let lastRunAt, let firedAt, let late, let recurring, let durable, let sourceToolUseId, let sourceTaskId, let turnId, let error):
    var parts = ["scheduled_work_update", id, turnId ?? "", kind, status]
    parts.append(origin ?? "")
    parts.append(title ?? "")
    parts.append(summary ?? "")
    parts.append(prompt ?? "")
    parts.append(reason ?? "")
    parts.append(cron ?? "")
    parts.append(nextRunAt ?? "")
    parts.append(lastRunAt ?? "")
    parts.append(firedAt ?? "")
    parts.append(late.map { $0 ? "1" : "0" } ?? "")
    parts.append(recurring.map { $0 ? "1" : "0" } ?? "")
    parts.append(durable.map { $0 ? "1" : "0" } ?? "")
    parts.append(sourceToolUseId ?? "")
    parts.append(sourceTaskId ?? "")
    parts.append(error ?? "")
    return parts.joined(separator: "|")
  case .transcriptRetraction(let messageIds, let reason, let replacementMessageId, let turnId):
    return ["transcript_retraction", turnId ?? "", replacementMessageId ?? "", reason ?? "", messageIds.joined(separator: ",")].joined(separator: "|")
  case .structuredQuestion(let question, let options, let itemId, let turnId):
    let digest = options.map { "\($0.label)\t\($0.value)\t\($0.description ?? "")\t\($0.recommended ? "1" : "0")" }.joined(separator: "\n")
    return ["structured_question", turnId ?? "", itemId, question, digest].joined(separator: "|")
  case .approvalRequest(let description, let detail, let itemId, let turnId):
    return ["approval_request", turnId ?? "", itemId, description, detail ?? ""].joined(separator: "|")
  case .pendingInputResolved(let itemId, let resolution, let turnId):
    return ["pending_input_resolved", turnId ?? "", itemId, resolution].joined(separator: "|")
  case .todoUpdate(let items, let turnId):
    return ["todo_update", turnId ?? "", items.joined(separator: "\n")].joined(separator: "|")
  case .systemNotice(let kind, let message, let detail, let turnId, let steerId):
    return ["system_notice", turnId ?? "", steerId ?? "", kind, message, detail ?? ""].joined(separator: "|")
  case .error(let message, let detail, let category, let turnId):
    return ["error", turnId ?? "", category, message, detail ?? ""].joined(separator: "|")
  case .done(let status, let summary, let usage, let turnId, let model, let modelId, let terminalReason):
    return ["done", turnId, status, model ?? "", modelId ?? "", terminalReason ?? "", summary, workUsageSummaryMergeKey(usage)].joined(separator: "|")
  case .claudeGoalUpdated(let goal, let turnId):
    return [
      "claude_goal_updated",
      turnId ?? "",
      goal.condition,
      String(goal.iterations),
      String(goal.updatedAt),
    ].joined(separator: "|")
  case .claudeGoalCleared(let turnId):
    return ["claude_goal_cleared", turnId ?? ""].joined(separator: "|")
  case .tokens(let usage, let turnId, let itemId):
    return ["tokens", turnId, itemId ?? "", workUsageSummaryMergeKey(usage)].joined(separator: "|")
  case .promptSuggestion(let text, let turnId):
    return ["prompt_suggestion", turnId ?? "", text].joined(separator: "|")
  case .contextCompact(let summary, let isInProgress, let postTokens, let turnId, let compactionId):
    return ["context_compact", compactionId ?? turnId ?? "", isInProgress ? "started" : "completed", postTokens.map(String.init) ?? "", summary].joined(separator: "|")
  case .autoApprovalReview(let summary, let turnId):
    return ["auto_approval_review", turnId ?? "", summary].joined(separator: "|")
  case .webSearch(let query, let action, let actions, _, let status, let itemId, let turnId):
    let actionKey = actions?.compactMap { $0.url ?? $0.title ?? $0.query ?? $0.queries?.first }.joined(separator: ",") ?? action ?? ""
    return ["web_search", turnId ?? "", itemId, query, actionKey, status.rawValue].joined(separator: "|")
  case .codexState(let title, let message, _, let turnId):
    return ["codex_state", turnId ?? "", title, message].joined(separator: "|")
  case .turnDiagnostics(_, _, let turnId):
    return ["turn_diagnostics", turnId ?? ""].joined(separator: "|")
  case .codexTurnStalled(let message, _, let turnId, let sourceSessionId, let context):
    return [
      "codex_turn_stalled",
      context.providerNeutral ? "provider_neutral" : "legacy",
      sourceSessionId ?? "",
      turnId ?? "",
      message,
    ].joined(separator: "|")
  case .codexTurnRecovery(_, let receipt, let turnId):
    return [
      "codex_turn_recovery",
      receipt.providerNeutral ? "provider_neutral" : "legacy",
      turnId ?? "",
    ].joined(separator: "|")
  case .planText(let text, let turnId):
    return ["plan_text", turnId ?? "", text].joined(separator: "|")
  case .toolUseSummary(let text, let turnId):
    return ["tool_use_summary", turnId ?? "", text].joined(separator: "|")
  case .status(let turnStatus, let message, let turnId):
    return ["status", turnId ?? "", turnStatus, message ?? ""].joined(separator: "|")
  case .reasoning(let text, let turnId, let itemId, let summaryIndex):
    return ["reasoning", turnId ?? "", itemId ?? "", summaryIndex.map(String.init) ?? "", text].joined(separator: "|")
  case .completionReport(let summary, let status, let artifacts, let blockerDescription, let turnId):
    return ["completion_report", turnId ?? "", status, summary, blockerDescription ?? "", workCompletionArtifactsMergeKey(artifacts)].joined(separator: "|")
  case .command(let command, let cwd, let output, let status, let itemId, let exitCode, let durationMs, let turnId):
    return [
      "command",
      turnId ?? "",
      itemId,
      command,
      cwd,
      output,
      status.rawValue,
      exitCode.map { String($0) } ?? "",
      durationMs.map { String($0) } ?? "",
    ].joined(separator: "|")
  case .fileChange(let path, let diff, let kind, let status, let itemId, let turnId):
    return ["file_change", turnId ?? "", itemId, path, kind, status.rawValue, diff].joined(separator: "|")
  case .unknown(let type):
    return ["unknown", type].joined(separator: "|")
  }
}

func workUsageSummaryMergeKey(_ usage: WorkUsageSummary?) -> String {
  guard let usage else { return "" }
  return [
    String(usage.turnCount),
    String(usage.inputTokens),
    String(usage.outputTokens),
    String(usage.cacheReadTokens),
    String(usage.cacheCreationTokens),
    String(usage.reasoningTokens),
    String(usage.totalTokens),
    usage.contextWindow.map(String.init) ?? "",
    String(usage.costUsd),
    String(usage.isContextSnapshot),
  ].joined(separator: "|")
}

func workCompletionArtifactsMergeKey(_ artifacts: [WorkCompletionArtifactModel]) -> String {
  artifacts.map { artifact in
    [artifact.type, artifact.description, artifact.reference ?? ""].joined(separator: "~")
  }.joined(separator: "\n")
}
