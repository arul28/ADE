import SwiftUI

/// Derives whether a given chat message is the "live" assistant bubble in a
/// streaming turn. Used by the timeline renderer to decide which bubble
/// should show the streaming shimmer + accent glow treatment.
///
/// A message is live when:
/// - the session is actively streaming (`isLive && sessionStatus == "active"`),
/// - the message is an assistant message,
/// - and it is the most recent assistant message in the current timeline.
extension WorkChatSessionView {
  func isLatestAssistantMessageLive(_ message: WorkChatMessage) -> Bool {
    guard isLive, sessionStatus == "active" else { return false }
    guard message.role == "assistant" else { return false }

    // Scan visibleTimeline back-to-front for the most recent assistant message
    // id. Visible (not full) timeline is the right surface because the shimmer
    // is a rendering decision, and we don't want to flag a message that has
    // been paged-out of view as live.
    for entry in visibleTimeline.reversed() {
      if case .message(let candidate) = entry.payload, candidate.role == "assistant" {
        return candidate.id == message.id
      }
    }

    return false
  }
}
