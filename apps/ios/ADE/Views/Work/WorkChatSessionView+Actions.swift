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
    workChatScrollLog.notice(
      "snapshot_rebuild_scheduled session=\(session.id, privacy: .public) generation=\(generation, privacy: .public) transcript=\(transcriptSnapshot.count, privacy: .public) fallback=\(fallbackSnapshot.count, privacy: .public) artifacts=\(artifactSnapshot.count, privacy: .public) localEcho=\(echoSnapshot.count, privacy: .public) currentTimeline=\(timelineSnapshot.timeline.count, privacy: .public) currentTail=\(timelineSnapshot.timeline.last?.id ?? "none", privacy: .public)"
    )

    // .userInitiated, not .utility: this rebuild feeds the visible streaming
    // transcript, and utility-priority tasks get starved while SwiftUI is
    // busy — which showed up as multi-second delta-to-screen latency.
    //
    // One-frame debounce: fold the multiple onChange triggers from a single
    // refresh, but don't let the transcript visibly outrun the bottom lock.
    timelineRebuildTask = Task.detached(priority: .userInitiated) {
      try? await Task.sleep(for: .milliseconds(16))
      guard !Task.isCancelled else { return }
      let nextSnapshot = buildWorkChatTimelineSnapshot(
        transcript: transcriptSnapshot,
        fallbackEntries: fallbackSnapshot,
        artifacts: artifactSnapshot,
        localEchoMessages: echoSnapshot
      )
      await MainActor.run {
        guard generation == timelineRebuildGeneration, !Task.isCancelled else { return }
        let previousTimelineCount = timelineSnapshot.timeline.count
        let previousTailId = timelineSnapshot.timeline.last?.id
        let snapshotChanged = nextSnapshot != timelineSnapshot
        workChatScrollLog.notice(
          "snapshot_rebuild_applied session=\(session.id, privacy: .public) generation=\(generation, privacy: .public) changed=\(snapshotChanged, privacy: .public) oldTimeline=\(previousTimelineCount, privacy: .public) newTimeline=\(nextSnapshot.timeline.count, privacy: .public) oldTail=\(previousTailId ?? "none", privacy: .public) newTail=\(nextSnapshot.timeline.last?.id ?? "none", privacy: .public) transcript=\(transcriptSnapshot.count, privacy: .public) fallback=\(fallbackSnapshot.count, privacy: .public)"
        )
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
    if timelineRebuildTask != nil {
      workChatScrollLog.notice(
        "snapshot_rebuild_cancelled session=\(session.id, privacy: .public) generation=\(timelineRebuildGeneration, privacy: .public) timeline=\(timelineSnapshot.timeline.count, privacy: .public) tail=\(timelineSnapshot.timeline.last?.id ?? "none", privacy: .public)"
      )
    }
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
    guard nextSnapshot != timelineSnapshot else {
      workChatScrollLog.notice(
        "snapshot_rebuild_sync_unchanged session=\(session.id, privacy: .public) timeline=\(timelineSnapshot.timeline.count, privacy: .public) tail=\(timelineSnapshot.timeline.last?.id ?? "none", privacy: .public)"
      )
      return
    }
    workChatScrollLog.notice(
      "snapshot_rebuild_sync_applied session=\(session.id, privacy: .public) oldTimeline=\(timelineSnapshot.timeline.count, privacy: .public) newTimeline=\(nextSnapshot.timeline.count, privacy: .public) oldTail=\(timelineSnapshot.timeline.last?.id ?? "none", privacy: .public) newTail=\(nextSnapshot.timeline.last?.id ?? "none", privacy: .public)"
    )
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
    workChatScrollLog.notice(
      "load_earlier_tapped session=\(session.id, privacy: .public) beforeLimit=\(visibleTimelineCount, privacy: .public) hidden=\(hiddenTimelineCount, privacy: .public) hasOlderHost=\(hasOlderTranscriptHistory, privacy: .public) timeline=\(timeline.count, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public)"
    )
    withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
      visibleTimelineCount += workTimelinePageSize
      refreshTimelinePresentation()
    }
    workChatScrollLog.notice(
      "load_earlier_applied session=\(session.id, privacy: .public) afterLimit=\(visibleTimelineCount, privacy: .public) hidden=\(hiddenTimelineCount, privacy: .public) visible=\(visibleTimeline.count, privacy: .public) firstVisible=\(visibleTimeline.first?.id ?? "none", privacy: .public) lastVisible=\(visibleTimeline.last?.id ?? "none", privacy: .public)"
    )
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
  func updateBottomStickiness(distanceFromBottom rawDistance: CGFloat, proxy: ScrollViewProxy) {
    let distance = max(0, rawDistance)
    let previousDistance = lastScrollDistanceFromBottom
    lastScrollDistanceFromBottom = distance

    let nextIsNearBottom = isNearBottom
      ? !timelineDragActive
      : (!timelineDragActive && distance <= workChatStickResumeThreshold)

    if nextIsNearBottom != isNearBottom {
      workChatScrollLog.notice(
        "bottom_lock_changed session=\(session.id, privacy: .public) locked=\(nextIsNearBottom, privacy: .public) distance=\(distance, privacy: .public) previousDistance=\(previousDistance, privacy: .public) dragActive=\(timelineDragActive, privacy: .public) unread=\(unreadBelowCount, privacy: .public)"
      )
      isNearBottom = nextIsNearBottom
    }

    guard nextIsNearBottom else { return }

    if unreadBelowCount > 0 {
      withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
        unreadBelowCount = 0
      }
    }

    // Desktop follows content-size changes, not just new row counts. The
    // bottom geometry distance changes when a streaming row grows, so keep
    // pinned users at the true bottom even when the timeline tail id is stable.
    if distance > 1 {
      workChatScrollLog.notice(
        "bottom_lock_autoscroll session=\(session.id, privacy: .public) distance=\(distance, privacy: .public) previousDistance=\(previousDistance, privacy: .public) timeline=\(timeline.count, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public)"
      )
      pinToLatestAfterLayout(proxy, reason: "bottom-geometry")
    }
  }

  @MainActor
  func releaseBottomStickinessForUserScroll(reason: String) {
    guard isNearBottom else { return }
    workChatScrollLog.notice(
      "bottom_lock_released session=\(session.id, privacy: .public) reason=\(reason, privacy: .public) distance=\(lastScrollDistanceFromBottom, privacy: .public) timeline=\(timeline.count, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public)"
    )
    isNearBottom = false
  }

  @MainActor
  func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool) {
    let targetId = "chat-end"
    workChatScrollLog.notice(
      "scroll_to_latest session=\(session.id, privacy: .public) target=\(targetId, privacy: .public) animated=\(animated, privacy: .public) timeline=\(timeline.count, privacy: .public) visible=\(visibleTimeline.count, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public) nearBottom=\(isNearBottom, privacy: .public) unread=\(unreadBelowCount, privacy: .public)"
    )
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
    workChatScrollLog.notice(
      "pin_latest_after_layout session=\(session.id, privacy: .public) reason=\(reason, privacy: .public) timeline=\(timeline.count, privacy: .public) visible=\(visibleTimeline.count, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public) distance=\(lastScrollDistanceFromBottom, privacy: .public)"
    )
    scrollToLatest(proxy, animated: false)
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(16))
      guard isNearBottom, !timelineDragActive else { return }
      scrollToLatest(proxy, animated: false)
    }
  }

  @MainActor
  func runSessionAction(_ action: @escaping @MainActor () async -> Void) async {
    actionInFlight = true
    defer { actionInFlight = false }
    await action()
  }
}
