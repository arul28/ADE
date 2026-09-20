import SwiftUI
import UIKit

// MARK: - Row model

/// What a transcript row is, for the parts of the pipeline that do not care
/// what it draws: a stable identity, and a revision that changes whenever its
/// rendered content does.
struct WorkChatTranscriptRow: Identifiable, Hashable {
  enum Kind: Hashable {
    case overview
    case olderHistory
    case emptyState
    /// Index into the presentation's `renderEntries`.
    case entry(index: Int)
    case streamingStatus
    /// The bottom gutter that reserves room for the floating badge chips.
    case tail
  }

  let id: String
  let kind: Kind
  /// Bumped whenever this row's own content changes. Deliberately *not* part
  /// of `Hashable`'s identity contribution for the data source — a content
  /// change must reconfigure the row, never delete and re-insert it, or the
  /// measured height and the reader's anchor go with it.
  let revision: Int

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.id == rhs.id && lhs.kind == rhs.kind && lhs.revision == rhs.revision
  }

  func hash(into hasher: inout Hasher) {
    hasher.combine(id)
  }
}

/// Scroll geometry the transcript's *product* behaviour needs: paging older
/// history in, and knowing whether the whole thread fits on screen. Nothing
/// here decides a scroll write.
struct WorkChatTranscriptGeometry: Equatable {
  let distanceFromTop: CGFloat
  let distanceFromBottom: CGFloat
  let contentFitsViewport: Bool
}

// MARK: - Height cache

struct WorkChatTranscriptHeightKey: Hashable {
  let rowId: String
  let width: CGFloat
  let revision: Int
}

/// Measured row heights, keyed by row id + width + content revision.
///
/// The cache is what keeps a re-measurement off the screen. A row that scrolls
/// back into view at the same width and revision is restored to the height the
/// layout already believes it has, so the pass produces no content-size change
/// and nothing under the reader moves.
final class WorkChatTranscriptHeightCache {
  private var heights: [WorkChatTranscriptHeightKey: CGFloat] = [:]
  func height(for key: WorkChatTranscriptHeightKey) -> CGFloat? {
    heights[key]
  }

  func store(_ height: CGFloat, for key: WorkChatTranscriptHeightKey) {
    guard height > 0 else { return }
    heights[key] = height
  }

  func removeAll() {
    heights.removeAll(keepingCapacity: true)
  }

  func prune(keeping rowIds: Set<String>) {
    guard heights.count > 4096 else { return }
    heights = heights.filter { rowIds.contains($0.key.rowId) }
  }
}

// MARK: - Cell

final class WorkChatTranscriptCell: UICollectionViewCell {
  var cacheKey: WorkChatTranscriptHeightKey?
  weak var heightCache: WorkChatTranscriptHeightCache?

  override func preferredLayoutAttributesFitting(
    _ layoutAttributes: UICollectionViewLayoutAttributes
  ) -> UICollectionViewLayoutAttributes {
    if let cacheKey,
       cacheKey.width == layoutAttributes.frame.width,
       let cached = heightCache?.height(for: cacheKey) {
      let attributes = layoutAttributes
      attributes.frame.size.height = cached
      return attributes
    }
    let measured = super.preferredLayoutAttributesFitting(layoutAttributes)
    if let cacheKey, cacheKey.width == measured.frame.width {
      heightCache?.store(measured.frame.height, for: cacheKey)
    }
    return measured
  }
}

/// A collection view that says when it has finished laying out.
///
/// `UIViewController.viewDidLayoutSubviews` does not cover this: a cell
/// self-sizing away from its estimate re-lays the collection view without ever
/// changing the controller's view bounds, and that pass is exactly the one
/// that can move a row above the reader.
final class WorkChatTranscriptCollectionViewBody: UICollectionView {
  var onDidLayout: (() -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    onDidLayout?()
  }
}

// MARK: - Scroller handle

/// The SwiftUI side's handle on the transcript.
///
/// Replaces `ScrollViewProxy`, which had to be threaded through every row
/// builder just so one card could bring itself above the keyboard.
@MainActor
final class WorkChatTranscriptScroller {
  fileprivate weak var controller: WorkChatTranscriptController?

  /// Where the reader is right now, for the product decisions that need it
  /// outside a scroll frame (continuing an automatic history pull that landed
  /// no rows, and therefore produced no layout pass to observe).
  var currentGeometry: WorkChatTranscriptGeometry? { controller?.currentGeometry }

  func scrollToLatest(animated: Bool, reason: String) {
    controller?.jumpToLatest(animated: animated, reason: reason)
  }

  func scrollRowIntoView(id: String, reason: String) {
    controller?.scrollRowIntoView(id: id, reason: reason)
  }

  /// A new session (or the same one re-seeded): open following, at the tail.
  func resetForNewSession() {
    controller?.resetForNewSession()
  }

  /// A card finished expanding or collapsing.
  func noteDisclosureSettled() {
    controller?.noteDisclosureSettled()
  }
}

// MARK: - Representable

/// The Work chat transcript.
///
/// A `UICollectionView` rather than `ScrollView` + `LazyVStack` for one
/// reason: UIKit compensates its own content offset when a cell self-sizes to
/// something other than its estimate, so a row re-measuring above the viewport
/// does not move the row the reader is looking at. A `LazyVStack` has no such
/// writer, which is where 88% of this transcript's measured displacement came
/// from.
struct WorkChatTranscriptCollectionView: UIViewControllerRepresentable {
  let rows: [WorkChatTranscriptRow]
  /// Bumped when anything shared by every row changes (card expansion, live
  /// state, bubble width). Part of every row's height-cache key.
  let contentRevision: Int
  let topInset: CGFloat
  let bottomInset: CGFloat
  let scroller: WorkChatTranscriptScroller
  let rowContent: (WorkChatTranscriptRow) -> AnyView
  let onFollowChange: (Bool) -> Void
  let onGeometryChange: (WorkChatTranscriptGeometry) -> Void
  let onViewportChange: (CGSize) -> Void

  func makeUIViewController(context: Context) -> WorkChatTranscriptController {
    let controller = WorkChatTranscriptController()
    controller.rowContent = rowContent
    controller.onFollowChange = onFollowChange
    controller.onGeometryChange = onGeometryChange
    controller.onViewportChange = onViewportChange
    scroller.controller = controller
    return controller
  }

  func updateUIViewController(_ controller: WorkChatTranscriptController, context: Context) {
    scroller.controller = controller
    controller.rowContent = rowContent
    controller.onFollowChange = onFollowChange
    controller.onGeometryChange = onGeometryChange
    controller.onViewportChange = onViewportChange
    controller.setContentInsets(top: topInset, bottom: bottomInset)
    controller.apply(rows: rows, contentRevision: contentRevision)
  }

  static func dismantleUIViewController(
    _ controller: WorkChatTranscriptController,
    coordinator: ()
  ) {
    controller.teardown()
  }
}

// MARK: - Controller

@MainActor
final class WorkChatTranscriptController: UIViewController, UICollectionViewDelegate {
  private enum Section: Hashable { case main }

  private(set) var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Section, String>!
  private let heightCache = WorkChatTranscriptHeightCache()

  private(set) var follow = WorkChatFollowState.initial

  var rowContent: ((WorkChatTranscriptRow) -> AnyView)?
  var onFollowChange: ((Bool) -> Void)?
  var onGeometryChange: ((WorkChatTranscriptGeometry) -> Void)?
  var onViewportChange: ((CGSize) -> Void)?

  private var rowsById: [String: WorkChatTranscriptRow] = [:]
  private var orderedRowIds: [String] = []
  private var contentRevision = 0
  private var hasAppliedFirstNonEmptySnapshot = false

  /// Set whenever the content changed while following; consumed by the next
  /// layout pass. Not a retry ladder — it is armed by a content change and
  /// cleared by the pass that acts on it.
  private var followPinNeeded = false
  /// Suppresses the follow pin while a user-initiated jump animation runs, so
  /// the animation is not cancelled by the pin it is heading towards.
  private var animatingToLatest = false
  private var lastBoundsSize: CGSize = .zero
  private var lastContentHeight: CGFloat = 0
  /// The offset to put back across a viewport resize while not following.
  private var stableOffsetY: CGFloat = 0
  /// The row the reader is on, and where it sits, sampled continuously while
  /// not following. A cell re-measuring is not always inside a snapshot apply
  /// — a reconfigured cell measures on a later pass — so the anchor has to be
  /// something the next layout pass can restore to, not something captured
  /// once per update.
  private var liveAnchor: Anchor?
  private var settleWorkItem: DispatchWorkItem?
  /// A scroll write inside a layout pass can re-enter the pass.
  private var isHandlingLayoutPass = false

  /// Gap between rows, matching the transcript's former `LazyVStack` spacing.
  private let rowSpacing: CGFloat = 14

  override func viewDidLoad() {
    super.viewDidLoad()
    var configuration = UICollectionLayoutListConfiguration(appearance: .plain)
    configuration.showsSeparators = false
    configuration.backgroundColor = .clear
    let layout = UICollectionViewCompositionalLayout.list(using: configuration)

    let collectionView = WorkChatTranscriptCollectionViewBody(
      frame: .zero,
      collectionViewLayout: layout
    )
    collectionView.backgroundColor = .clear
    collectionView.showsVerticalScrollIndicator = false
    collectionView.showsHorizontalScrollIndicator = false
    collectionView.alwaysBounceVertical = true
    collectionView.keyboardDismissMode = .interactive
    collectionView.contentInsetAdjustmentBehavior = .never
    collectionView.delegate = self
    collectionView.onDidLayout = { [weak self] in self?.handleLayoutPass() }
    collectionView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(collectionView)
    NSLayoutConstraint.activate([
      collectionView.topAnchor.constraint(equalTo: view.topAnchor),
      collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    self.collectionView = collectionView

    let registration = UICollectionView.CellRegistration<WorkChatTranscriptCell, String> {
      [weak self] cell, _, rowId in
      guard let self, let row = self.rowsById[rowId] else { return }
      // The list layout gives every item the full container width, so the
      // collection view's own width is the measurement width — the cell's is
      // still zero the first time it is configured.
      let width = self.collectionView.bounds.width
      cell.heightCache = self.heightCache
      cell.cacheKey = WorkChatTranscriptHeightKey(
        rowId: rowId,
        width: width,
        revision: row.revision &+ self.contentRevision
      )
      cell.backgroundConfiguration = .clear()
      let content = self.rowContent?(row) ?? AnyView(EmptyView())
      cell.contentConfiguration = UIHostingConfiguration { content }
        .margins(.horizontal, 16)
        .margins(.vertical, self.rowSpacing / 2)
    }

    dataSource = UICollectionViewDiffableDataSource<Section, String>(
      collectionView: collectionView
    ) { collectionView, indexPath, rowId in
      collectionView.dequeueConfiguredReusableCell(
        using: registration,
        for: indexPath,
        item: rowId
      )
    }
  }

  func teardown() {
    settleWorkItem?.cancel()
    settleWorkItem = nil
    heightCache.removeAll()
  }

  func setContentInsets(top: CGFloat, bottom: CGFloat) {
    guard isViewLoaded else { return }
    let insets = UIEdgeInsets(top: top, left: 0, bottom: bottom, right: 0)
    guard collectionView.contentInset != insets else { return }
    let wasFollowing = follow.following
    collectionView.contentInset = insets
    collectionView.verticalScrollIndicatorInsets = insets
    if wasFollowing {
      followPinNeeded = true
    }
  }

  // MARK: Snapshot

  func apply(rows: [WorkChatTranscriptRow], contentRevision revision: Int) {
    guard isViewLoaded else { return }
    let nextIds = rows.map(\.id)
    let revisionChanged = revision != contentRevision
    let changedRowIds: [String] = rows.compactMap { row in
      guard let previous = rowsById[row.id] else { return nil }
      return previous.revision == row.revision ? nil : row.id
    }
    let orderChanged = nextIds != orderedRowIds
    guard orderChanged || revisionChanged || !changedRowIds.isEmpty else { return }

    // Against the row order that is still on screen: the anchor is a row the
    // reader can see, and resolving it after the list is replaced would map
    // its index onto whatever the insert put there.
    let anchor = captureAnchor()
    let previousContentHeight = collectionView.contentSize.height

    contentRevision = revision
    rowsById = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    orderedRowIds = nextIds
    heightCache.prune(keeping: Set(nextIds))

    var snapshot = NSDiffableDataSourceSnapshot<Section, String>()
    snapshot.appendSections([.main])
    snapshot.appendItems(nextIds, toSection: .main)
    let reconfigure = revisionChanged ? nextIds : changedRowIds
    if !reconfigure.isEmpty {
      snapshot.reconfigureItems(reconfigure)
    }
    dataSource.apply(snapshot, animatingDifferences: false)
    collectionView.layoutIfNeeded()

    let isFirstContent = !hasAppliedFirstNonEmptySnapshot && !nextIds.isEmpty
    if isFirstContent {
      hasAppliedFirstNonEmptySnapshot = true
    }

    WorkChatScrollTrace.contentSize(
      previousContent: previousContentHeight,
      nextContent: collectionView.contentSize.height,
      previousContainer: lastBoundsSize.height,
      nextContainer: collectionView.bounds.height,
      offsetY: collectionView.contentOffset.y,
      following: follow.following
    )

    if follow.following {
      // Appends while following land at the tail. Everything else the pass
      // moved is below the reader by construction.
      followPinNeeded = true
      if !animatingToLatest, !follow.inUserSession {
        performScrollWrite(
          .pinToBottom(animated: false),
          reason: isFirstContent ? "initial-content" : "content-append"
        )
      }
    } else if let anchor {
      // Content inserted or resized above the reader. Put the anchored row
      // back where it was; UIKit already compensated whatever it measured
      // itself, and this covers the rest.
      restoreAnchor(anchor)
      liveAnchor = captureAnchor()
    }
    lastContentHeight = collectionView.contentSize.height
  }

  // MARK: Anchoring

  struct Anchor {
    let rowId: String
    /// Where the row's top sat relative to the viewport's top edge.
    let offsetFromViewportTop: CGFloat
  }

  private func captureAnchor() -> Anchor? {
    let visible = collectionView.indexPathsForVisibleItems.sorted()
    guard let indexPath = visible.first,
          let attributes = collectionView.layoutAttributesForItem(at: indexPath),
          indexPath.item < orderedRowIds.count
    else { return nil }
    return Anchor(
      rowId: orderedRowIds[indexPath.item],
      offsetFromViewportTop: attributes.frame.minY - collectionView.contentOffset.y
    )
  }

  @discardableResult
  private func restoreAnchor(_ anchor: Anchor, reason: String = "anchor-restore") -> Bool {
    guard let index = orderedRowIds.firstIndex(of: anchor.rowId),
          let attributes = collectionView.layoutAttributesForItem(
            at: IndexPath(item: index, section: 0)
          )
    else { return false }
    let target = attributes.frame.minY - anchor.offsetFromViewportTop
    performScrollWrite(.setOffset(target), reason: reason)
    return true
  }

  // MARK: The single scroll writer

  private enum ScrollWrite {
    case pinToBottom(animated: Bool)
    case setOffset(CGFloat)
    case revealRow(String)
  }

  /// The only function in the transcript that moves the viewport.
  private func performScrollWrite(_ write: ScrollWrite, reason: String) {
    let before = collectionView.contentOffset.y
    let minOffset = -collectionView.contentInset.top
    let maxOffset = max(
      minOffset,
      collectionView.contentSize.height - collectionView.bounds.height
        + collectionView.contentInset.bottom
    )

    let target: CGFloat
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
    collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: animated)
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
    if animated, !collectionView.isDragging, collectionView.contentOffset.y >= 0 {
      // `setContentOffset(animated:)` does not always raise
      // `scrollViewDidEndScrollingAnimation` when the target was already
      // reached; clear the suppression on the next runloop turn in that case.
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
    heightCache.removeAll()
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

  private var isAtEnd: Bool {
    distanceFromBottom <= workChatFollowEndTolerance
  }

  private var distanceFromBottom: CGFloat {
    let maxOffset = collectionView.contentSize.height - collectionView.bounds.height
      + collectionView.contentInset.bottom
    return max(0, maxOffset - collectionView.contentOffset.y)
  }

  private var distanceFromTop: CGFloat {
    max(0, collectionView.contentOffset.y + collectionView.contentInset.top)
  }

  private func applyFollowEvent(_ event: WorkChatFollowEvent, reason: String) {
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
  private func emit(_ block: @escaping () -> Void) {
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

  private func publishGeometry() {
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
  private func handleLayoutPass() {
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
      }
      let size = bounds
      emit { [weak self] in self?.onViewportChange?(size) }
      if previous.height > 0 {
        // The keyboard, the composer growing, or a card collapsing. Following
        // stays glued to the tail; everyone else keeps their row.
        if follow.following {
          followPinNeeded = true
        } else if let liveAnchor, restoreAnchor(liveAnchor, reason: "viewport-resize") {
          // Anchored on the row, which survives a re-measure the saved offset
          // would not.
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
      // all, when rows above the reader redistribute. The restore is absolute
      // rather than incremental, so when UIKit has already compensated
      // correctly this writes nothing.
      restoreAnchor(liveAnchor, reason: "anchor-relayout")
    }
    traceViewportAnchor()
    publishGeometry()
  }

  // MARK: UIScrollViewDelegate

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    WorkChatScrollTrace.phase(userDriven: true, raw: "willBeginDragging")
    settleWorkItem?.cancel()
    settleWorkItem = nil
    animatingToLatest = false
    applyFollowEvent(.userScrollBegin, reason: "drag-begin")
  }

  /// Where the reader's row actually sits on screen, once the pass that could
  /// have moved it is over.
  ///
  /// `contentOffset` is the wrong thing to measure a jump with once UIKit is
  /// compensating its own self-sizing: a cell above the viewport re-measuring
  /// moves the offset by exactly the amount needed to leave the screen still.
  /// This is the ground truth the bench reduces to "did anything move".
  private func traceViewportAnchor() {
    let visible = collectionView.indexPathsForVisibleItems.sorted()
    guard let indexPath = visible.first,
          indexPath.item < orderedRowIds.count,
          let attributes = collectionView.layoutAttributesForItem(at: indexPath)
    else { return }
    WorkChatScrollTrace.viewport(
      rowId: orderedRowIds[indexPath.item],
      offsetInViewport: attributes.frame.minY - collectionView.contentOffset.y,
      userDriven: follow.inUserSession,
      following: follow.following
    )
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
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

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    guard !decelerate else { return }
    scheduleUserScrollSettle()
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
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
  private func scheduleUserScrollSettle() {
    settleWorkItem?.cancel()
    let work = DispatchWorkItem { [weak self] in
      self?.endUserScrollSession(reason: "settle")
    }
    settleWorkItem = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: work)
  }

  private func endUserScrollSession(reason: String) {
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
  }
}
