import Foundation
import UIKit

// MARK: - Composer handoff

/// What the chat composer answered to one handoff.
enum LiveInspectHandoffResult: Equatable {
  /// An insert or a picture replacement landed in the draft.
  case attached
  /// An undo ran. Whatever the add inserted and is still there verbatim is
  /// gone; text the person has since edited is left alone.
  case removed
  /// No composer for this chat answered within `replyWindow`.
  case noComposer
  /// The draft already holds `workChatInputAttachmentLimit` attachments.
  case attachmentLimit
  /// This chat takes no attachments, or the picture couldn't be encoded.
  case attachmentsUnavailable

  /// The sentence the stage shows for a failed handoff; nil on success.
  var failureMessage: String? {
    switch self {
    case .attached, .removed:
      return nil
    case .noComposer:
      return "Couldn't reach this chat's composer"
    case .attachmentLimit:
      return "The message already has \(workChatInputAttachmentLimit) attachments. Remove one and try again."
    case .attachmentsUnavailable:
      return "This chat can't take pictures"
    }
  }
}

/// One request from Inspect to a chat composer, posted on
/// `.liveInspectComposerHandoff` with this object.
///
/// Every request is answered once: the composer that takes it calls `reply`,
/// and the sender treats silence past `replyWindow` as `.noComposer`. An
/// insert is all-or-nothing, so a failure leaves the draft as it was. The
/// composer keeps no bookkeeping of its own: undo carries the exact text block
/// the insert added (removed only while it is still in the draft verbatim) and
/// the attachment id the sender chose, so it works across a remount.
///
/// A handoff names its chat (`sessionId`), or only its lane for a viewer opened
/// outside a chat; then the lane's chat on screen takes it. The first composer
/// to `claim()` it is the only one that acts, so a chat mounted twice (a split)
/// does not insert twice.
@MainActor
final class LiveInspectComposerHandoff: NSObject {
  enum Request {
    /// Append `text` to the draft as its own block and, with an image, attach
    /// it under `attachmentId`.
    case insert(text: String, image: UIImage?, attachmentId: UUID?)
    /// Remove a block an insert added, and its attachment.
    case remove(text: String?, attachmentId: UUID?)
    /// Swap the attachment `replacing` for `image` under `attachmentId` (the
    /// picture with the markup finished after the first add). A missing old
    /// attachment just means the new one is appended.
    case replaceImage(replacing: UUID, image: UIImage, attachmentId: UUID)
  }

  /// How long a sender waits for a composer before calling it unreachable.
  /// Composers answer synchronously from the notification, so this only runs
  /// out when none is mounted for the chat.
  static var replyWindow: Duration = .milliseconds(1500)

  let id = UUID()
  let sessionId: String?
  let laneId: String
  let request: Request
  private var claimed = false
  private var onReply: ((LiveInspectHandoffResult) -> Void)?

  init(
    sessionId: String?,
    laneId: String,
    request: Request,
    onReply: @escaping (LiveInspectHandoffResult) -> Void
  ) {
    self.sessionId = sessionId
    self.laneId = laneId
    self.request = request
    self.onReply = onReply
  }

  /// True for the first composer that asks; it then owns the reply.
  func claim() -> Bool {
    guard !claimed else { return false }
    claimed = true
    return true
  }

  func reply(_ result: LiveInspectHandoffResult) {
    let callback = onReply
    onReply = nil
    callback?(result)
  }

  /// Posts a request and waits for its answer, or `.noComposer` once
  /// `replyWindow` passes with none.
  static func deliver(
    _ request: Request,
    sessionId: String?,
    laneId: String
  ) async -> LiveInspectHandoffResult {
    await withCheckedContinuation { (continuation: CheckedContinuation<LiveInspectHandoffResult, Never>) in
      let once = LiveInspectReplyOnce(continuation)
      let handoff = LiveInspectComposerHandoff(
        sessionId: sessionId,
        laneId: laneId,
        request: request,
        onReply: { once.finish($0) }
      )
      let window = replyWindow
      Task { @MainActor in
        try? await Task.sleep(for: window)
        once.finish(.noComposer)
      }
      NotificationCenter.default.post(name: .liveInspectComposerHandoff, object: handoff)
    }
  }
}

/// Resumes a handoff's continuation once: the reply or the timeout, whichever
/// comes first.
@MainActor
private final class LiveInspectReplyOnce {
  private var continuation: CheckedContinuation<LiveInspectHandoffResult, Never>?

  init(_ continuation: CheckedContinuation<LiveInspectHandoffResult, Never>) {
    self.continuation = continuation
  }

  func finish(_ result: LiveInspectHandoffResult) {
    continuation?.resume(returning: result)
    continuation = nil
  }
}

/// `text` without one block an insert added, and the blank line that joined
/// it to its neighbour. The latest copy wins (an element added, undone, and
/// added again). Text with no verbatim copy is returned unchanged: an edited
/// block is the person's now.
func liveInspectTextRemovingBlock(_ block: String, from text: String) -> String {
  guard !block.isEmpty, let range = text.range(of: block, options: .backwards) else { return text }
  var lower = range.lowerBound
  var upper = range.upperBound
  if text[..<lower].hasSuffix("\n\n") {
    lower = text.index(lower, offsetBy: -2)
  } else if text[upper...].hasPrefix("\n\n") {
    upper = text.index(upper, offsetBy: 2)
  }
  var result = text
  result.removeSubrange(lower..<upper)
  return result
}

extension Notification.Name {
  /// Carries a `LiveInspectComposerHandoff` in `object`.
  static let liveInspectComposerHandoff = Notification.Name("com.ade.ios.liveInspectComposerHandoff")
}
