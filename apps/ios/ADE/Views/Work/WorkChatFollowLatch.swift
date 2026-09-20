import Foundation

/// How close to the end counts as "at the end" when the latch is asked to
/// decide whether the reader is still parked on the live tail.
///
/// Not a deadband on movement — the latch has none. It is the tolerance for a
/// fling that stops a few points short of the last row, which a reader cannot
/// tell apart from the bottom and would be surprised to see stop following.
let workChatFollowEndTolerance: CGFloat = 24

/// Everything that can change whether the transcript follows the live tail.
///
/// The set is deliberately small, and programmatic scrolling is deliberately
/// absent: a pin, a jump-to-latest animation, and the layout compensation that
/// keeps a row in place across an insert are all things the app does *because*
/// of the latch, so letting them feed back into it is how a single re-measure
/// turned into a follow flip in the old machinery.
enum WorkChatFollowEvent: Equatable {
  /// A new session, or the same session re-seeded. Opens following.
  case reset
  /// The reader's finger went down on the transcript.
  case userScrollBegin
  /// The interaction the reader started has come fully to rest — the end of
  /// momentum, or the settle window after a drag that reported none.
  case userScrollEnd(isAtEnd: Bool)
  /// A scroll frame. Only meaningful inside a user session.
  case scroll(isAtEnd: Bool)
  /// A card finished expanding or collapsing and the content settled.
  case disclosureSettled(isAtEnd: Bool)
  /// The reader sent a message, which is a request to watch the answer.
  case sendMessage
  /// The reader tapped the jump-to-latest pill.
  case jumpToLatest
}

/// The whole of the transcript's scroll authority.
///
/// `following` is the only thing that may authorize an automatic scroll write.
/// `inUserSession` spans finger-down through the end of the fling, which is the
/// window — and the only window — in which a scroll frame is allowed to mean
/// "the reader moved".
struct WorkChatFollowState: Equatable {
  var following: Bool
  var inUserSession: Bool

  init(following: Bool = true, inUserSession: Bool = false) {
    self.following = following
    self.inUserSession = inUserSession
  }

  static let initial = WorkChatFollowState()
}

/// The follow latch: one pure function, no clock, no geometry of its own.
///
/// Every rule the transcript has about "should the viewport move on its own"
/// is in here, so a jump can be explained by naming the event that produced it
/// rather than by reconstructing which of six observers won a race.
func workChatFollowLatch(
  _ state: WorkChatFollowState,
  _ event: WorkChatFollowEvent
) -> WorkChatFollowState {
  var next = state
  switch event {
  case .reset:
    next.following = true
    next.inUserSession = false
  case .userScrollBegin:
    // Touching the transcript stops the follow immediately, before the first
    // scroll frame: the reader is about to move it, and a pin racing that
    // first frame is exactly the fight that reads as a snap-back.
    next.inUserSession = true
    next.following = false
  case .userScrollEnd(let isAtEnd):
    next.following = state.inUserSession && isAtEnd
    next.inUserSession = false
  case .scroll(let isAtEnd):
    // Outside a user session a scroll frame is the app's own doing — a pin, a
    // jump animation, or UIKit compensating a cell that re-measured. None of
    // those are the reader.
    guard state.inUserSession else { return state }
    next.following = isAtEnd
  case .disclosureSettled(let isAtEnd):
    guard !state.inUserSession else { return state }
    if isAtEnd {
      next.following = true
    }
  case .sendMessage:
    next.following = true
  case .jumpToLatest:
    next.following = true
    next.inUserSession = false
  }
  return next
}

/// How far the reader's anchored row has to have actually moved before the
/// transcript puts it back.
///
/// Not a deadband on the correction — the correction is exact. It is the
/// threshold below which "restore" stops being a correction and becomes a
/// fight: a write of a point or two re-enters layout, which re-reads the same
/// stale sample, which writes again.
let workChatAnchorRestoreTolerance: CGFloat = 2

/// Whether the transcript may put the reader's anchored row back right now.
///
/// Three refusals, each of which was a live loop before it was written down:
///
/// - The reader owns the offset for the whole interaction. Writing under a
///   live finger or a running fling is the same rule the follow pin already
///   obeys; the anchor is re-sampled when the interaction ends.
/// - Overscroll is UIKit's to settle. Restoring into the bounce pins the
///   rubber band at the anchor's offset instead of letting it return to the
///   edge, and every settle frame re-triggers the restore that caused it.
/// - A row that has not moved needs no restore. The restore is absolute, so
///   applying it to a sample that is merely stale — rather than to a row that
///   actually shifted — writes a displacement that was never there.
func workChatShouldRestoreAnchor(
  anchorRowMinY: CGFloat,
  currentRowMinY: CGFloat,
  isDragging: Bool,
  isDecelerating: Bool,
  contentOffsetY: CGFloat,
  minContentOffsetY: CGFloat,
  maxContentOffsetY: CGFloat
) -> Bool {
  guard !isDragging, !isDecelerating else { return false }
  guard contentOffsetY >= minContentOffsetY - 0.5,
        contentOffsetY <= maxContentOffsetY + 0.5
  else { return false }
  return abs(currentRowMinY - anchorRowMinY) > workChatAnchorRestoreTolerance
}
