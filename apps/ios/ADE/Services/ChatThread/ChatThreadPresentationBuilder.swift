import SwiftUI
import UIKit

// Timeline presentation builders (visible window, turn separators, assistant
// previews, render-entry split, row revisions).
//
// Moved verbatim out of `WorkChatSessionView.swift` so `ChatThreadEngine` can
// build the presentation off the main actor with the same code the legacy view
// path uses. `makeWorkTimelinePresentation` was widened from `private` and
// gained a provider/model overload that does not need the view's summary
// context.

struct WorkTimelinePresentation: Equatable {
  let visibleEntries: [WorkTimelineEntry]
  let renderEntries: [WorkTimelineRenderEntry]
  let timelineCount: Int
  let timelineFirstId: String?
  let timelineLastId: String?
  let hiddenCount: Int
  let signature: Int

  static let empty = WorkTimelinePresentation(
    visibleEntries: [],
    renderEntries: [],
    timelineCount: 0,
    timelineFirstId: nil,
    timelineLastId: nil,
    hiddenCount: 0,
    signature: 0
  )

  static func == (lhs: WorkTimelinePresentation, rhs: WorkTimelinePresentation) -> Bool {
    lhs.signature == rhs.signature
  }
}

func makeWorkTimelinePresentation(
  timeline: [WorkTimelineEntry],
  visibleCount: Int,
  chatSummary: WorkChatSummaryRenderContext,
  transcript: [WorkChatEnvelope],
  assistantPreviewCache: WorkAssistantPreviewCache,
  streamingAssistantMessageId: String?
) -> WorkTimelinePresentation {
  makeWorkTimelinePresentation(
    timeline: timeline,
    visibleCount: visibleCount,
    provider: chatSummary.provider,
    model: chatSummary.model,
    modelId: chatSummary.modelId,
    transcript: transcript,
    assistantPreviewCache: assistantPreviewCache,
    streamingAssistantMessageId: streamingAssistantMessageId
  )
}

/// Summary-context-free form used by `ChatThreadEngine`. Only the provider and
/// model fields ever reached the builder, so the engine passes those directly.
func makeWorkTimelinePresentation(
  timeline: [WorkTimelineEntry],
  visibleCount: Int,
  provider: String,
  model: String,
  modelId: String?,
  transcript: [WorkChatEnvelope],
  assistantPreviewCache: WorkAssistantPreviewCache,
  streamingAssistantMessageId: String?
) -> WorkTimelinePresentation {
  let rawVisibleEntries = visibleWorkTimelineEntries(from: timeline, visibleCount: visibleCount)
  let visibleEntriesWithSeparators = injectWorkTurnSeparators(
    into: rawVisibleEntries,
    provider: provider,
    model: model,
    modelId: modelId,
    transcript: transcript
  )
  let visibleEntries = workTimelineEntriesWithAssistantPreviews(
    visibleEntriesWithSeparators,
    cache: assistantPreviewCache
  )
  let renderEntries = workTimelineRenderEntries(
    from: visibleEntries,
    streamingAssistantMessageId: streamingAssistantMessageId,
    splitAssistantMessageId: workLatestAssistantMessageId(in: timeline)
  )
  let hiddenCount = max(timeline.count - rawVisibleEntries.count, 0)
  return WorkTimelinePresentation(
    visibleEntries: visibleEntries,
    renderEntries: renderEntries,
    timelineCount: timeline.count,
    timelineFirstId: timeline.first?.id,
    timelineLastId: timeline.last?.id,
    hiddenCount: hiddenCount,
    signature: workTimelinePresentationSignature(
      timelineCount: timeline.count,
      timelineFirstId: timeline.first?.id,
      timelineLastId: timeline.last?.id,
      visibleEntries: visibleEntries,
      renderEntries: renderEntries,
      hiddenCount: hiddenCount
    )
  )
}

func workTimelineVisibleCountAfterHistoryPrepend(
  currentVisibleCount: Int,
  prependedCount: Int
) -> Int {
  max(0, currentVisibleCount) + min(max(0, prependedCount), workTimelinePageSize)
}

private func workTimelinePresentationSignature(
  timelineCount: Int,
  timelineFirstId: String?,
  timelineLastId: String?,
  visibleEntries: [WorkTimelineEntry],
  renderEntries: [WorkTimelineRenderEntry],
  hiddenCount: Int
) -> Int {
  var hasher = Hasher()
  hasher.combine(hiddenCount)
  hasher.combine(timelineCount)
  hasher.combine(timelineFirstId)
  hasher.combine(timelineLastId)
  hasher.combine(visibleEntries.count)
  hasher.combine(visibleEntries.first?.id)
  hasher.combine(visibleEntries.last?.id)
  hasher.combine(renderEntries.count)
  for entry in renderEntries {
    hasher.combine(workChatTranscriptRowRevision(entry))
  }
  return hasher.finalize()
}

/// Everything about one render row that can change what it draws.
///
/// Shared by the presentation signature (which asks "did the list change") and
/// by the transcript's per-row revision (which asks "does this cell have to be
/// reconfigured, and is its measured height still valid"). One function so the
/// two answers cannot drift apart — a row whose height changed but whose
/// revision did not would be restored from the height cache at the wrong size.
func workChatTranscriptRowRevision(_ entry: WorkTimelineRenderEntry) -> Int {
  var hasher = Hasher()
  hasher.combine(entry.id)
  hasher.combine(entry.sourceEntryId)
  hasher.combine(entry.timestamp)
  switch entry.payload {
  case .entry(let timelineEntry):
    hasher.combine(timelineEntry.id)
    hasher.combine(timelineEntry.timestamp)
    hasher.combine(timelineEntry.rank)
    // Messages take the digest-based fast path below; every other card kind
    // hashes its whole model, so an in-place update (a tool card gaining its
    // result, a subagent card gaining a summary, a pending-input card gaining
    // a resolution) reconfigures the cell and re-measures its height instead
    // of leaving a stale card on screen.
    guard case .message(let message) = timelineEntry.payload else {
      hasher.combine(timelineEntry.payload)
      return hasher.finalize()
    }
    hasher.combine(message.id)
    hasher.combine(message.role)
    hasher.combine(message.steerId)
    hasher.combine(message.deliveryState)
    hasher.combine(message.processed)
    hasher.combine(message.unprocessedResolution?.action)
    hasher.combine(message.unprocessedResolution?.state)
    hasher.combine(message.unprocessedResolution?.resolvedAt)
    workTimelineCombineMessageTextSignature(message, into: &hasher)
    if let preview = message.assistantPreview {
      // A preview is a pure function of the message text, and the text is
      // already in this hash. Its shape is enough to separate two previews of
      // the same message — no need to hash the rendered text, which is
      // O(message) on every refresh.
      hasher.combine(preview.totalLineCount)
      hasher.combine(preview.usesMonospacedRendering)
    }
  case .assistantMarkdownBlock(let model):
    hasher.combine(model.id)
    hasher.combine(model.messageId)
    hasher.combine(model.block.id)
    // The block's own precomputed digest, not a rebuilt `kind.cacheKey`:
    // building that key allocates a full copy of the block's text, once per
    // block, on every presentation refresh.
    hasher.combine(model.block.digest)
    hasher.combine(model.isStreamingTail)
  case .assistantMonospaced(let model):
    hasher.combine(model.id)
    hasher.combine(model.messageId)
    // Digest of the source message plus the size of the slice taken from it:
    // together these change whenever the rendered text does, without hashing
    // the (potentially very long) slice itself.
    hasher.combine(model.sourceDigest)
    hasher.combine(model.text.utf8.count)
    hasher.combine(model.accessibilityLabel)
  }
  return hasher.finalize()
}

/// Prefers the digest the snapshot fold stamped on the message; only messages
/// built outside the fold pay to hash their text here.
private func workTimelineCombineMessageTextSignature(_ message: WorkChatMessage, into hasher: inout Hasher) {
  hasher.combine(message.markdownRevision)

  // Live assistant deltas already carry a monotonic revision and exact
  // character metadata. Do not count or hash the growing response here: this
  // helper runs as part of the presentation signature on every streaming
  // refresh. The revision is the authoritative invalidation token; the count
  // only keeps the signature useful when a caller inspects it while a message
  // is being assembled.
  if message.markdownRevision > 0 {
    hasher.combine(message.markdownCharacterCount)
    return
  }

  if let digest = message.markdownDigest {
    hasher.combine(digest)
    hasher.combine(message.markdownCharacterCount)
    hasher.combine(message.markdownLineCount)
  } else {
    hasher.combine(message.markdown.utf8.count)
    hasher.combine(message.markdown.hashValue)
  }
}

/// Attach each visible assistant message's preview.
///
/// Assistant answers render whole, so a preview is a pure function of the
/// message: there is no budget to resolve, no anchor to pick, and no floor to
/// carry.
private func workTimelineEntriesWithAssistantPreviews(
  _ entries: [WorkTimelineEntry],
  cache: WorkAssistantPreviewCache
) -> [WorkTimelineEntry] {
  var visibleAssistantMessageIds = Set<String>()
  let hydratedEntries = entries.map { entry -> WorkTimelineEntry in
    guard case .message(var message) = entry.payload,
          message.role == "assistant"
    else { return entry }

    visibleAssistantMessageIds.insert(message.id)
    message.assistantPreview = cache.preview(for: message)
    return WorkTimelineEntry(
      id: entry.id,
      timestamp: entry.timestamp,
      rank: entry.rank,
      payload: .message(message)
    )
  }
  cache.prune(keeping: visibleAssistantMessageIds)
  return hydratedEntries
}

private func workLatestAssistantMessageId(in timeline: [WorkTimelineEntry]) -> String? {
  for entry in timeline.reversed() {
    guard case .message(let message) = entry.payload,
          message.role == "assistant"
    else { continue }
    return message.id
  }
  return nil
}

func workTimelineRenderEntries(
  from entries: [WorkTimelineEntry],
  streamingAssistantMessageId: String?,
  splitAssistantMessageId: String? = nil
) -> [WorkTimelineRenderEntry] {
  var rendered: [WorkTimelineRenderEntry] = []
  rendered.reserveCapacity(entries.count)

  for entry in entries {
    guard case .message(let message) = entry.payload,
          message.role == "assistant"
    else {
      rendered.append(WorkTimelineRenderEntry(
        id: entry.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .entry(entry)
      ))
      continue
    }

    let preview = message.assistantPreview ?? workAssistantMessagePreview(message.markdown)
    let shouldSplitAssistantMessage = (
      message.id == streamingAssistantMessageId
      || message.id == splitAssistantMessageId
    )
    guard shouldSplitAssistantMessage else {
      rendered.append(WorkTimelineRenderEntry(
        id: entry.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .entry(entry)
      ))
      continue
    }

    let accessibilityLabel = workAssistantMessageAccessibilityLabel(preview)

    // A truncated tail can start inside a fenced tree and omit the opening
    // fence. Classify the authoritative full message so markdown prose never
    // flips into the tiny whole-message monospace renderer while paginating.
    if preview.usesMonospacedRendering {
      let model = WorkAssistantMonospacedRenderModel(
        // Keep the first rendered row anchored to the source timeline entry so
        // Show More can restore it after the preview changes anchor.
        id: entry.id,
        messageId: message.id,
        turnId: message.turnId,
        itemId: message.itemId,
        text: preview.text,
        accessibilityLabel: accessibilityLabel,
        sourceDigest: "\(message.markdownDigest ?? ""):\(message.markdownRevision)",
      )
      rendered.append(WorkTimelineRenderEntry(
        id: model.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .assistantMonospaced(model)
      ))
    } else {
      let blocks = message.id == streamingAssistantMessageId
        ? parseMarkdownBlocksForStreaming(
          preview.text,
          cacheKey: "\(message.id):preview",
          appendOnly: true
        )
        : parseMarkdownBlocks(preview.text)
      rendered.reserveCapacity(rendered.count + blocks.count)
      let streamingTailBlockId = message.id == streamingAssistantMessageId ? blocks.last?.id : nil
      for block in blocks {
        let model = WorkAssistantMarkdownBlockRenderModel(
          id: block.id == blocks.first?.id ? entry.id : "\(entry.id)-\(block.id)",
          messageId: message.id,
          turnId: message.turnId,
          itemId: message.itemId,
          block: block,
          isStreamingTail: block.id == streamingTailBlockId
        )
        rendered.append(WorkTimelineRenderEntry(
          id: model.id,
          sourceEntryId: entry.id,
          timestamp: entry.timestamp,
          payload: .assistantMarkdownBlock(model)
        ))
      }
    }
  }

  return rendered
}
