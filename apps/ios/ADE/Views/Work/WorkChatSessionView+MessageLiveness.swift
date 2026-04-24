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
    guard message.role.lowercased() == "assistant" else { return false }

    // Cached with the visible timeline presentation so each message row does
    // not scan the transcript during focus/layout churn.
    return timelinePresentation.latestVisibleAssistantMessageId == message.id
  }
}
