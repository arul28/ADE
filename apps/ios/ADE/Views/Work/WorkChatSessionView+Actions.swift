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

    timelineRebuildTask = Task.detached(priority: .utility) {
      try? await Task.sleep(nanoseconds: 80_000_000)
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
    }
  }

  @MainActor
  func runSessionAction(_ action: @escaping @MainActor () async -> Void) async {
    actionInFlight = true
    defer { actionInFlight = false }
    await action()
  }
}
