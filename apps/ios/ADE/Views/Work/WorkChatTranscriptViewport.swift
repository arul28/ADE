import SwiftUI
import UIKit

/// Anchoring, the single scroll writer, follow, and the scroll delegate.
/// Called synchronously on the main thread from the controller layout pass.
/// Anchor restore still runs inside handleLayoutPass before the frame is composited.
extension WorkChatTranscriptController: UICollectionViewDelegate {
  // MARK: Anchoring

  struct Anchor {
    let rowId: String
    /// The row's top in content coordinates, as of the sample — or of the last
    /// restore. Comparing against it is what separates "this row moved" from
    /// "this sample is old", which an absolute restore cannot tell apart.
    let rowMinY: CGFloat
    /// Where the row's top sat relative to the viewport's top edge.
    let offsetFromViewportTop: CGFloat
  }

  /// The first row whose top edge the reader can actually see.
  ///
  /// The transcript runs under the floating header, so "first visible item"
  /// is usually a row behind the glass, and often one straddling the top edge.
  /// That is a bad anchor twice over: it is not the reader's place, and a row
  /// crossing the top edge is exactly the one UIKit compensates itself when it
  /// re-measures — anchoring on it made the restore fight that compensation.
  /// Falls back to the first visible row when none starts below the chrome
  /// (one row taller than the viewport).
  func readerAnchorIndexPath() -> (IndexPath, UICollectionViewLayoutAttributes)? {
    // Reading layout attributes can resolve a pending self-sizing pass, and
    // UIKit's compensation for it lands here as a `didScroll`.
    layoutWorkDepth += 1
    defer { layoutWorkDepth -= 1 }
    let visibleTop = collectionView.contentOffset.y + collectionView.contentInset.top
    var fallback: (IndexPath, UICollectionViewLayoutAttributes)?
    for indexPath in collectionView.indexPathsForVisibleItems.sorted() {
      guard indexPath.item < orderedRowIds.count,
            let attributes = collectionView.layoutAttributesForItem(at: indexPath)
      else { continue }
      if fallback == nil { fallback = (indexPath, attributes) }
      if attributes.frame.minY >= visibleTop - 0.5 {
        return (indexPath, attributes)
      }
    }
    return fallback
  }

  func captureAnchor() -> Anchor? {
    guard let (indexPath, attributes) = readerAnchorIndexPath() else { return nil }
    return Anchor(
      rowId: orderedRowIds[indexPath.item],
      rowMinY: attributes.frame.minY,
      offsetFromViewportTop: attributes.frame.minY - collectionView.contentOffset.y
    )
  }

  /// Put the reader's row back, if it moved and if the offset is ours to write.
  ///
  /// On success the anchor advances to the row's new content position, so the
  /// next pass compares against what this restore settled on rather than
  /// re-deciding from a sample the restore already answered.
  @discardableResult
  func restoreAnchorIfMoved(
    _ anchor: Anchor,
    reason: String,
    shiftDuringUserScroll: Bool = false
  ) -> Bool {
    guard !isRestoringAnchor else { return false }
    guard let index = orderedRowIds.firstIndex(of: anchor.rowId),
          let attributes = collectionView.layoutAttributesForItem(
            at: IndexPath(item: index, section: 0)
          )
    else { return false }
    let currentRowMinY = attributes.frame.minY
    if shiftDuringUserScroll, collectionView.isDragging || collectionView.isDecelerating {
      // On-screen displacement, not the row's content move: UIKit already
      // compensated the part of that move its own self-sizing caused.
      let screenDelta = currentRowMinY - collectionView.contentOffset.y - anchor.offsetFromViewportTop
      return shiftOffsetUnderReader(by: screenDelta, anchor: anchor, rowMinY: currentRowMinY)
    }
    guard workChatShouldRestoreAnchor(
      anchorRowMinY: anchor.rowMinY,
      currentRowMinY: currentRowMinY,
      isDragging: collectionView.isDragging,
      isDecelerating: collectionView.isDecelerating,
      contentOffsetY: collectionView.contentOffset.y,
      minContentOffsetY: minContentOffsetY,
      maxContentOffsetY: maxContentOffsetY
    ) else { return false }

    isRestoringAnchor = true
    defer { isRestoringAnchor = false }
    performScrollWrite(
      .setOffset(currentRowMinY - anchor.offsetFromViewportTop),
      reason: reason
    )
    liveAnchor = Anchor(
      rowId: anchor.rowId,
      rowMinY: currentRowMinY,
      offsetFromViewportTop: anchor.offsetFromViewportTop
    )
    return true
  }

  /// Rows went in or changed height above the reader in a snapshot apply
  /// while a finger or a fling owns the offset (older history paged in as the
  /// reader nears the top, a card above re-measuring). UIKit compensates its
  /// own self-sizing but not a snapshot's inserts, so without this the whole
  /// page under the reader jumped by the inserted height — the multi-thousand
  /// point jumps in the field data.
  ///
  /// A relative shift of the live offset, not a `setContentOffset` to an
  /// absolute target: the pan keeps tracking the finger from the shifted
  /// offset and a running fling keeps its velocity, so the reader's gesture is
  /// not cancelled. Not clamped to the scroll range: a reader in the top
  /// rubber band stays exactly where they are relative to the content.
  func shiftOffsetUnderReader(by rawDelta: CGFloat, anchor: Anchor, rowMinY: CGFloat) -> Bool {
    let scale = max(1, collectionView.traitCollection.displayScale)
    let delta = (rawDelta * scale).rounded() / scale
    guard abs(delta) > 0.5 / scale else { return false }
    let before = collectionView.contentOffset.y
    WorkChatScrollTrace.write(
      reason: "anchor-shift-user-scroll",
      target: "dy=\(delta)",
      site: "WorkChatTranscriptCollectionView.swift:shiftOffsetUnderReader",
      offsetBefore: before,
      contentHeight: collectionView.contentSize.height,
      containerHeight: collectionView.bounds.height,
      scrollableHeight: max(0, maxContentOffsetY - minContentOffsetY),
      following: follow.following,
      userDrivenPhase: follow.inUserSession
    )
    layoutWorkDepth += 1
    collectionView.contentOffset.y = before + delta
    layoutWorkDepth -= 1
    liveAnchor = Anchor(
      rowId: anchor.rowId,
      rowMinY: rowMinY,
      offsetFromViewportTop: anchor.offsetFromViewportTop
    )
    return true
  }

  // MARK: The single scroll writer

  enum ScrollWrite {
    case pinToBottom(animated: Bool)
    case setOffset(CGFloat)
    case revealRow(String)
  }

  /// The only function in the transcript that moves the viewport.
  var minContentOffsetY: CGFloat {
    -collectionView.contentInset.top
  }

  var maxContentOffsetY: CGFloat {
    max(
      minContentOffsetY,
      collectionView.contentSize.height - collectionView.bounds.height
        + collectionView.contentInset.bottom
    )
  }

  func performScrollWrite(_ write: ScrollWrite, reason: String) {
    let before = collectionView.contentOffset.y
    let minOffset = minContentOffsetY
    let maxOffset = maxContentOffsetY

    var target: CGFloat
    var animated = false
    switch write {
    case .pinToBottom(let isAnimated):
      target = maxOffset
      animated = isAnimated
    case .setOffset(let y):
      target = min(max(minOffset, y), maxOffset)
    case .revealRow(let rowId):
      guard let index = orderedRowIds.firstIndex(of: rowId),
            let attributes = collectionView.layoutAttributesForItem(
              at: IndexPath(item: index, section: 0)
            )
      else { return }
      let bottomAligned = attributes.frame.maxY - collectionView.bounds.height
        + collectionView.contentInset.bottom
      target = min(max(minOffset, bottomAligned), maxOffset)
      animated = true
    }

    // On a device pixel. A fractional offset (an anchor restore lands on
    // `rowMinY - offsetFromViewportTop`, both fractional) puts every glyph
    // between pixels, and the next write rounding the other way makes text
    // shimmer by a pixel as rows re-measure.
    let scale = max(1, collectionView.traitCollection.displayScale)
    let rounded = (target * scale).rounded() / scale
    if rounded > maxOffset {
      target = (maxOffset * scale).rounded(.down) / scale
    } else if rounded < minOffset {
      target = (minOffset * scale).rounded(.up) / scale
    } else {
      target = rounded
    }
    guard animated || abs(target - before) > 0.5 else { return }

    WorkChatScrollTrace.write(
      reason: reason,
      target: animated ? "y=\(target)(animated)" : "y=\(target)",
      site: "WorkChatTranscriptCollectionView.swift:performScrollWrite",
      offsetBefore: before,
      contentHeight: collectionView.contentSize.height,
      containerHeight: collectionView.bounds.height,
      scrollableHeight: max(0, maxOffset - minOffset),
      following: follow.following,
      userDrivenPhase: follow.inUserSession
    )
    layoutWorkDepth += 1
    collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: animated)
    layoutWorkDepth -= 1
    if !animated {
      stableOffsetY = target
    }
  }

  // MARK: Commands from SwiftUI

  func jumpToLatest(animated: Bool, reason: String) {
    guard isViewLoaded else { return }
    applyFollowEvent(animated ? .jumpToLatest : .sendMessage, reason: reason)
    followPinNeeded = true
    if animated {
      animatingToLatest = true
    }
    performScrollWrite(.pinToBottom(animated: animated), reason: reason)
    if animated, !collectionView.isDragging {
      // `setContentOffset(animated:)` does not always raise
      // `scrollViewDidEndScrollingAnimation` when the target was already
      // reached; clear the suppression on the next runloop turn in that case.
      // Not gated on a non-negative offset: a transcript that fits rests at
      // `-contentInset.top`, and skipping the fallback there leaves
      // `animatingToLatest` set, which suppresses follow pinning indefinitely.
      let work = DispatchWorkItem { [weak self] in self?.animatingToLatest = false }
      settleWorkItem?.cancel()
      settleWorkItem = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }
  }

  func scrollRowIntoView(id: String, reason: String) {
    guard isViewLoaded else { return }
    performScrollWrite(.revealRow(id), reason: reason)
  }

  func resetForNewSession() {
    guard isViewLoaded else { return }
    // The height cache survives: its keys are row ids + content revisions, so
    // another session's rows can never hit, and a re-seed of this one (same
    // rows, same revisions) should not pay to measure every row again.
    hasAppliedFirstNonEmptySnapshot = false
    animatingToLatest = false
    settleWorkItem?.cancel()
    settleWorkItem = nil
    applyFollowEvent(.reset, reason: "session-reset")
    liveAnchor = nil
    followPinNeeded = true
  }

  func noteDisclosureSettled() {
    guard isViewLoaded else { return }
    applyFollowEvent(.disclosureSettled(isAtEnd: isAtEnd), reason: "disclosure-settled")
  }

  // MARK: Latch plumbing

  var isAtEnd: Bool {
    distanceFromBottom <= workChatFollowEndTolerance
  }

  var distanceFromBottom: CGFloat {
    let maxOffset = collectionView.contentSize.height - collectionView.bounds.height
      + collectionView.contentInset.bottom
    return max(0, maxOffset - collectionView.contentOffset.y)
  }

  var distanceFromTop: CGFloat {
    max(0, collectionView.contentOffset.y + collectionView.contentInset.top)
  }

  func applyFollowEvent(_ event: WorkChatFollowEvent, reason: String) {
    let next = workChatFollowLatch(follow, event)
    guard next != follow else { return }
    let followingChanged = next.following != follow.following
    follow = next
    guard followingChanged else { return }
    WorkChatScrollTrace.follow(next.following, reason: reason)
    emit { [weak self] in
      guard let self else { return }
      self.onFollowChange?(self.follow.following)
    }
  }

  /// Callbacks always cross a runloop turn. Every site that raises one — a
  /// snapshot apply, a layout pass, a scroll frame — can be inside SwiftUI's
  /// own update, and writing observed state there is undefined.
  func emit(_ block: @escaping () -> Void) {
    DispatchQueue.main.async(execute: block)
  }

  var currentGeometry: WorkChatTranscriptGeometry {
    let maxOffset = collectionView.contentSize.height - collectionView.bounds.height
      + collectionView.contentInset.bottom
    return WorkChatTranscriptGeometry(
      distanceFromTop: distanceFromTop,
      distanceFromBottom: distanceFromBottom,
      // A transcript that has not been measured yet does not "fit" — it is
      // unknown. Reporting the empty first pass as fitting is what let the
      // short-transcript history pull run before anything was on screen.
      contentFitsViewport: collectionView.contentSize.height > 0
        && maxOffset <= -collectionView.contentInset.top + 0.5
    )
  }

  func publishGeometry() {
    let geometry = currentGeometry
    emit { [weak self] in self?.onGeometryChange?(geometry) }
  }

  // MARK: Layout

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    handleLayoutPass()
  }

  /// One place that reacts to "the transcript just laid out", whichever of the
  /// controller's view or the collection view's own cells caused it.
  func handleLayoutPass() {
    guard isViewLoaded, !isHandlingLayoutPass else { return }
    isHandlingLayoutPass = true
    defer { isHandlingLayoutPass = false }
    let bounds = collectionView.bounds.size
    let boundsChanged = abs(bounds.height - lastBoundsSize.height) > 0.5
      || abs(bounds.width - lastBoundsSize.width) > 0.5
    if boundsChanged {
      let previous = lastBoundsSize
      lastBoundsSize = bounds
      if abs(bounds.width - previous.width) > 0.5 {
        // Every cached height was measured at the old width.
        heightCache.removeAll()
        schedulePremeasure()
      }
      let size = bounds
      emit { [weak self] in self?.onViewportChange?(size) }
      if previous.height > 0 {
        // The keyboard, the composer growing, or a card collapsing. Following
        // stays glued to the tail; everyone else keeps their row.
        if follow.following {
          followPinNeeded = true
        } else if let liveAnchor {
          // Anchored on the row, which survives a re-measure the saved offset
          // would not. A resize that did not move the row needs no write: the
          // offset it already has is the reader's place.
          restoreAnchorIfMoved(liveAnchor, reason: "viewport-resize")
        } else {
          performScrollWrite(.setOffset(stableOffsetY), reason: "viewport-resize")
        }
      }
    }

    let contentHeight = collectionView.contentSize.height
    let contentChanged = abs(contentHeight - lastContentHeight) > 0.5
    lastContentHeight = contentHeight

    // A pin is the app moving the viewport, so it waits out the reader's whole
    // interaction even when the latch says they are still on the tail —
    // writing an offset under a live finger is what killed flings.
    if follow.following, !follow.inUserSession, !animatingToLatest,
       followPinNeeded || contentChanged || boundsChanged {
      followPinNeeded = false
      performScrollWrite(.pinToBottom(animated: false), reason: "follow-pin")
    } else if !follow.following || follow.inUserSession, let liveAnchor {
      // A cell measured itself away from its estimate after the update that
      // asked for it — sometimes without changing the total content height at
      // all, when rows above the reader redistribute. Gated on the anchored
      // row having actually moved, so a pass where UIKit already compensated
      // correctly writes nothing at all.
      restoreAnchorIfMoved(liveAnchor, reason: "anchor-relayout")
    }
    if !isApplyingSnapshot { checkJumpProbe() }
    traceViewportAnchor()
    publishGeometry()
  }

  // MARK: Visible-jump probe (diagnostics only)

  /// The reader's row and where it sat on screen at the end of the last
  /// layout pass — a state that was composited.
  struct JumpProbe {
    let rowId: String
    let screenY: CGFloat
  }

  /// Between two composited states the reader's row may move on screen by
  /// exactly what the reader scrolled, and nothing else. Anything more is a
  /// jump the reader did not make.
  ///
  /// The former probe compared cell frames at the *start* of a pass with the
  /// layout at its end. When UIKit had already compensated a self-sizing row
  /// above the reader (moving the offset) but not yet repositioned the cells,
  /// that start state was never on screen, and each compensation was
  /// reported as a jump of its own height — 18 of the 19 jumps one bench run
  /// logged.
  func checkJumpProbe() {
    guard ScrollDiagnostics.shared.isRunning else { return }
    defer {
      userScrollSinceProbe = 0
      momentumEstimatedSinceProbe = false
      if let (indexPath, attributes) = readerAnchorIndexPath() {
        jumpProbe = JumpProbe(
          rowId: orderedRowIds[indexPath.item],
          screenY: attributes.frame.minY - collectionView.contentOffset.y
        )
      } else {
        jumpProbe = nil
      }
    }
    guard let probe = jumpProbe,
          !follow.following || follow.inUserSession,
          let index = orderedRowIds.firstIndex(of: probe.rowId),
          let attributes = collectionView.layoutAttributesForItem(
            at: IndexPath(item: index, section: 0)
          )
    else { return }
    let screenY = attributes.frame.minY - collectionView.contentOffset.y
    let delta = screenY - (probe.screenY - userScrollSinceProbe)
    let pixel = 1 / max(1, collectionView.traitCollection.displayScale)
    // A momentum frame whose share was estimated (see `noteObservedOffset`)
    // carries a few points of estimate error; anything a reader would call a
    // jump is far larger.
    let threshold = momentumEstimatedSinceProbe ? 3 : pixel + 0.01
    if abs(delta) > threshold {
      ScrollDiagnostics.shared.noteVisibleJump(points: delta)
      WorkChatScrollTrace.note("visible-jump row=\(probe.rowId) delta=\(delta)")
    }
  }

  /// How far the reader moved the content since the last probe, from what the
  /// reader actually did rather than from `contentOffset`: UIKit folds its
  /// compensation for a self-sizing row into the same `didScroll` a pan or a
  /// momentum frame raises, so an offset delta cannot tell the two apart.
  ///
  /// - Finger down: the content follows the finger, so the finger's window position
  ///   is the reader's movement (except in the rubber band, where the offset
  ///   is).
  /// - Momentum: the whole delta is the reader's unless a cell re-sized since
  ///   the last frame (the only thing UIKit compensates). Then the fling's
  ///   running velocity times the frame time is, and a delta far off that is
  ///   not the reader.
  /// - Otherwise the reader is not moving anything.
  func noteObservedOffset(_ scrollView: UIScrollView) {
    let offsetY = scrollView.contentOffset.y
    defer { lastObservedOffsetY = offsetY }
    guard ScrollDiagnostics.shared.isRunning, !lastObservedOffsetY.isNaN, layoutWorkDepth == 0 else { return }
    let offsetDelta = offsetY - lastObservedOffsetY
    let now = CACurrentMediaTime()
    defer {
      lastObservedAt = now
      lastSeenResizeCount = WorkChatTranscriptCell.resizeCount
    }
    let inRubberBand = offsetY < minContentOffsetY - 0.5 || offsetY > maxContentOffsetY + 0.5
    if scrollView.isTracking {
      let fingerY = scrollView.panGestureRecognizer.location(in: nil).y
      let fingerDelta = lastFingerY.map { fingerY - $0 } ?? -offsetDelta
      lastFingerY = fingerY
      userScrollSinceProbe += inRubberBand ? offsetDelta : -fingerDelta
    } else if scrollView.isDecelerating {
      lastFingerY = nil
      let elapsedMs = max(0.5, (now - lastObservedAt) * 1000)
      let predicted = momentumVelocity * elapsedMs
      let resized = WorkChatTranscriptCell.resizeCount != lastSeenResizeCount
      let userDelta: CGFloat
      momentumEstimatedSinceProbe = momentumEstimatedSinceProbe || resized
      if !resized || inRubberBand || abs(offsetDelta - predicted) <= 2 + abs(predicted) * 0.35 {
        userDelta = offsetDelta
        momentumVelocity = offsetDelta / elapsedMs
      } else {
        userDelta = predicted
      }
      userScrollSinceProbe += userDelta
    } else {
      lastFingerY = nil
    }
  }

  // MARK: UIScrollViewDelegate

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    ScrollDiagnostics.shared.scrollBegan(diagnosticsScrollKey)
    WorkChatScrollTrace.phase(userDriven: true, raw: "willBeginDragging")
    settleWorkItem?.cancel()
    settleWorkItem = nil
    animatingToLatest = false
    lastFingerY = nil
    applyFollowEvent(.userScrollBegin, reason: "drag-begin")
  }

  /// Where the reader's row actually sits on screen, once the pass that could
  /// have moved it is over.
  ///
  /// `contentOffset` is the wrong thing to measure a jump with once UIKit is
  /// compensating its own self-sizing: a cell above the viewport re-measuring
  /// moves the offset by exactly the amount needed to leave the screen still.
  /// This is the ground truth the bench reduces to "did anything move".
  func traceViewportAnchor() {
    guard let (indexPath, attributes) = readerAnchorIndexPath() else { return }
    WorkChatScrollTrace.viewport(
      rowId: orderedRowIds[indexPath.item],
      offsetInViewport: attributes.frame.minY - collectionView.contentOffset.y,
      userDriven: follow.inUserSession,
      following: follow.following
    )
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    noteObservedOffset(scrollView)
    if !follow.inUserSession, !scrollView.isDragging, !scrollView.isDecelerating {
      stableOffsetY = scrollView.contentOffset.y
    }
    WorkChatScrollTrace.sample(
      offsetY: scrollView.contentOffset.y,
      contentHeight: scrollView.contentSize.height,
      containerHeight: scrollView.bounds.height,
      scrollableHeight: max(0, scrollView.contentSize.height - scrollView.bounds.height),
      distanceFromBottom: distanceFromBottom,
      userDrivenPhase: follow.inUserSession,
      following: follow.following
    )
    applyFollowEvent(.scroll(isAtEnd: isAtEnd), reason: "scroll")
    // Only the reader may move the anchor. A scroll frame produced by UIKit
    // compensating a cell that re-measured is the very thing the anchor exists
    // to undo, so re-sampling on it would adopt the displaced position as the
    // new truth and the correction would never run.
    if !follow.following, follow.inUserSession || scrollView.isDragging || scrollView.isDecelerating {
      liveAnchor = captureAnchor()
    }
    // The viewport reading belongs to the layout pass, not to this callback:
    // UIKit raises `didScroll` from inside `layoutSubviews` while it is
    // compensating a cell that re-measured, which is a state no frame is ever
    // composited from.
    publishGeometry()
  }

  func scrollViewWillEndDragging(
    _ scrollView: UIScrollView,
    withVelocity velocity: CGPoint,
    targetContentOffset: UnsafeMutablePointer<CGPoint>
  ) {
    // Points per millisecond, in offset direction.
    momentumVelocity = velocity.y
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate { ScrollDiagnostics.shared.scrollEnded(diagnosticsScrollKey) }
    guard !decelerate else { return }
    scheduleUserScrollSettle()
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    ScrollDiagnostics.shared.scrollEnded(diagnosticsScrollKey)
    endUserScrollSession(reason: "momentum-end")
  }

  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    animatingToLatest = false
    if follow.following {
      followPinNeeded = true
      view.setNeedsLayout()
    }
  }

  /// A drag that reported no momentum still has a moment of UIKit settling
  /// after finger-up. Ending the session on that frame would read the offset
  /// mid-settle and drop follow for a reader who let go at the tail.
  func scheduleUserScrollSettle() {
    settleWorkItem?.cancel()
    let work = DispatchWorkItem { [weak self] in
      self?.endUserScrollSession(reason: "settle")
    }
    settleWorkItem = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: work)
  }

  func endUserScrollSession(reason: String) {
    settleWorkItem?.cancel()
    settleWorkItem = nil
    WorkChatScrollTrace.phase(userDriven: false, raw: reason)
    stableOffsetY = collectionView.contentOffset.y
    applyFollowEvent(.userScrollEnd(isAtEnd: isAtEnd), reason: reason)
    liveAnchor = follow.following ? nil : captureAnchor()
    if follow.following {
      followPinNeeded = true
      view.setNeedsLayout()
    }
    schedulePremeasure()
  }

}
