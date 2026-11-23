import CoreGraphics

/// The real measurements one transcript cell made in the current run-loop
/// turn, at one width, and the height the last one returned.
///
/// UIKit re-asks a cell for its size every time its content invalidates,
/// inside the same layout pass, and asserts once those passes nest too deep
/// (`_UICollectionViewFeedbackLoopDebugger`: "stuck in a recursive layout
/// loop", ADE-IOS-30, right after a rotation re-measured every row). A hosted
/// row whose measured height moves with its position (text on a fractional
/// origin, a reflow at the new width) can answer a slightly different height
/// on each re-ask, and every answer moves the rows under it, which re-asks
/// again. Within one turn a cell measures at most `maxPerTurn` times; after
/// that, and for a sub-point difference, it repeats its last answer, which is
/// a measurement of the same content taken moments earlier.
///
/// A held re-ask may still have been a real change (a thumbnail landing in
/// the same turn), so the turn's end reports it and the cell asks once more,
/// outside the nested passes. Once that has happened, a held re-ask asks
/// again only after a turn that measured without hitting the cap (the row
/// settled), so a row that never settles cannot keep asking every turn.
struct WorkChatTranscriptCellTurnMeasures {
  private static let maxPerTurn = 3

  private var count = 0
  private var width: CGFloat = 0
  private var height: CGFloat?
  private var heldThisTurn = false
  private var remeasuredSinceConfigure = false

  /// A fresh configuration: its first measures are not re-asks.
  mutating func configured() {
    count = 0
    height = nil
    heldThisTurn = false
    remeasuredSinceConfigure = false
  }

  /// The height to answer without measuring, when this turn's measures are spent.
  mutating func heldHeight(width: CGFloat) -> CGFloat? {
    if self.width != width {
      count = 0
      height = nil
    }
    guard let height, count >= Self.maxPerTurn else { return nil }
    heldThisTurn = true
    return height
  }

  /// Records a real measure at `width` and returns the height to answer.
  mutating func record(_ measured: CGFloat, width: CGFloat) -> CGFloat {
    let answer = height.map { abs(measured - $0) < 1 ? $0 : measured } ?? measured
    count += 1
    self.width = width
    height = answer
    return answer
  }

  /// Ends the turn. True when a re-ask was held and the cell should ask once more.
  mutating func endTurn() -> Bool {
    let measured = count > 0
    count = 0
    height = nil
    defer { heldThisTurn = false }
    guard heldThisTurn else {
      // A turn that measured within the cap settled: a later change may ask again.
      if measured { remeasuredSinceConfigure = false }
      return false
    }
    guard !remeasuredSinceConfigure else { return false }
    remeasuredSinceConfigure = true
    return true
  }
}
