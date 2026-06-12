import SwiftUI
import UIKit
import AVKit

extension WorkChatSessionView {
  @MainActor
  func scheduleTimelineSnapshotRebuild() {
    timelineRebuildTask?.cancel()
    timelineRebuildGeneration += 1
    let generation = timelineRebuildGeneration
    let transcriptSnapshot = transcript
    let fallbackSnapshot = fallbackEntries
    let artifactSnapshot = artifacts
    let echoSnapshot = localEchoMessages

    // .userInitiated, not .utility: this rebuild feeds the visible streaming
    // transcript, and utility-priority tasks get starved while SwiftUI is
    // busy — which showed up as multi-second delta-to-screen latency.
    //
    // 100 ms debounce: chat-event notifications arrive at most every ~150 ms
    // (SyncService coalescer), so this timer always completes between bursts
    // while still folding the multiple onChange triggers (transcript,
    // fallbackEntries, artifacts) from a single refresh into one rebuild.
    timelineRebuildTask = Task.detached(priority: .userInitiated) {
      try? await Task.sleep(for: .milliseconds(100))
      guard !Task.isCancelled else { return }
      let nextSnapshot = buildWorkChatTimelineSnapshot(
        transcript: transcriptSnapshot,
        fallbackEntries: fallbackSnapshot,
        artifacts: artifactSnapshot,
        localEchoMessages: echoSnapshot
      )
      await MainActor.run {
        guard generation == timelineRebuildGeneration, !Task.isCancelled else { return }
        if nextSnapshot != timelineSnapshot {
          timelineSnapshot = nextSnapshot
        }
        refreshTimelinePresentation(sourceTimeline: nextSnapshot.timeline)
        timelineRebuildTask = nil
      }
    }
  }

  @MainActor
  func cancelScheduledTimelineSnapshotRebuild() {
    timelineRebuildTask?.cancel()
    timelineRebuildTask = nil
  }

  @MainActor
  func rebuildTimelineSnapshot() {
    let nextSnapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
    )
    guard nextSnapshot != timelineSnapshot else { return }
    timelineSnapshot = nextSnapshot
    refreshTimelinePresentation(sourceTimeline: nextSnapshot.timeline)
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
  func loadEarlierTimelineEntries() {
    withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
      visibleTimelineCount += workTimelinePageSize
      refreshTimelinePresentation()
    }
    // Once the locally-buffered timeline is nearly exhausted, pull the next
    // older transcript page from the host so scroll-back continues through
    // the full history instead of stopping at the initial tail fetch.
    if hasOlderTranscriptHistory,
       hiddenTimelineCount <= workTimelinePageSize * 2,
       let onLoadOlderTranscript {
      Task { await onLoadOlderTranscript() }
    }
  }

  @MainActor
  func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool) {
    let targetId = visibleTimeline.last?.id ?? "chat-end"
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
  func runSessionAction(_ action: @escaping @MainActor () async -> Void) async {
    actionInFlight = true
    defer { actionInFlight = false }
    await action()
  }
}
