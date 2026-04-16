import SwiftUI
import UIKit
import AVKit

extension WorkChatSessionView {
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

  func toggleToolCard(_ id: String) {
    if expandedToolCardIds.contains(id) {
      expandedToolCardIds.remove(id)
    } else {
      expandedToolCardIds.insert(id)
    }
  }

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
