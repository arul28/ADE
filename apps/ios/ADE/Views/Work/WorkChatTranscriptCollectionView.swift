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

// MARK: - Cell environment

/// SyncService for transcript cells, without the subscription.
///
/// `@EnvironmentObject` re-renders every view that declares it on every
/// SyncService publish (~15/s on a connected phone), and inside a
/// `UIHostingConfiguration` cell that re-render lands mid-scroll. Cells only
/// need SyncService to *do* something (fetch a full tool result, spend a reset
/// credit, open an attachment), so they hold a plain reference that never
/// invalidates them. What a cell draws arrives through its row, whose
/// revision reconfigures the cell when it changes.
struct WorkSyncServiceReference: Equatable {
  private weak var explicit: SyncService?

  init(_ service: SyncService? = nil) {
    explicit = service
  }

  /// Falls back to the process-wide instance, so a view that renders both in a
  /// cell and in an ordinary SwiftUI hierarchy (the composer's attachment
  /// tray) needs no second injection.
  @MainActor var service: SyncService? {
    explicit ?? SyncService.shared
  }

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.explicit === rhs.explicit
  }
}

private struct WorkSyncServiceReferenceKey: EnvironmentKey {
  static let defaultValue = WorkSyncServiceReference()
}

extension EnvironmentValues {
  /// Read with `@Environment(\.workSyncService)` in any view that can render
  /// inside a transcript cell, instead of `@EnvironmentObject SyncService`.
  var workSyncService: WorkSyncServiceReference {
    get { self[WorkSyncServiceReferenceKey.self] }
    set { self[WorkSyncServiceReferenceKey.self] = newValue }
  }
}

// MARK: - Height cache

/// `(rowId, revision, width)`. `revision` is the row's effective revision:
/// its own content revision combined with the transcript-wide one (card
/// expansion, bubble width, live/offline) — both move independently, so they
/// are hashed together rather than summed. Streaming state, in-flight actions
/// and the viewport height are per-row inputs already folded into the row's
/// own revision, so a keyboard show/hide re-measures only the rows that read
/// the viewport height.
struct WorkChatTranscriptHeightKey: Hashable {
  let rowId: String
  let revision: Int
  let width: CGFloat

  init(rowId: String, width: CGFloat, rowRevision: Int, contentRevision: Int) {
    self.rowId = rowId
    self.width = width
    var hasher = Hasher()
    hasher.combine(rowRevision)
    hasher.combine(contentRevision)
    self.revision = hasher.finalize()
  }
}

/// Measured row heights, keyed by row id + effective revision + width.
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

  /// Drop every entry no live row can ask for again.
  ///
  /// Filtering on the row id alone was not enough: the revision is part of the
  /// key and moves on live state, card expansion, and width changes, so a row
  /// that simply stays in the transcript kept one entry per revision it was
  /// ever measured at — the cache grew for the whole session. An entry
  /// survives only while its row is still present AND still at that revision.
  func prune(keeping live: [String: Int], contentRevision: Int) {
    guard heights.count > 4096 else { return }
    heights = heights.filter { key, _ in
      guard let rowRevision = live[key.rowId] else { return false }
      return WorkChatTranscriptHeightKey(
        rowId: key.rowId,
        width: key.width,
        rowRevision: rowRevision,
        contentRevision: contentRevision
      ).revision == key.revision
    }
  }
}

// MARK: - Cell

final class WorkChatTranscriptCell: UICollectionViewCell {
  var cacheKey: WorkChatTranscriptHeightKey?
  weak var heightCache: WorkChatTranscriptHeightCache?

  /// The hosted SwiftUI content changed size on its own — an attachment
  /// thumbnail landed, a badge appeared, the text reflowed — with no new row
  /// revision. `UIHostingConfiguration` reports that by invalidating the
  /// cell's intrinsic size, and UIKit then re-asks for the cell's height.
  /// That re-ask must measure: answering it from the cache (same key, old
  /// height) left the row drawing over its neighbour until something else
  /// re-measured it.
  private(set) var contentSizeInvalidated = false

  /// See the cell registration: a transcript row never pads for the window's
  /// safe area.
  override var safeAreaInsets: UIEdgeInsets { .zero }

  /// True from a configure until the run loop turns: the hosting view
  /// invalidates its size while it renders freshly configured content, and
  /// that content is exactly what the cache entry for this key measured. In a
  /// bench run every one of those re-measures (135 of 135) returned the cached
  /// height; tripling the measure count for nothing.
  private var settlingConfiguration = false

  override func invalidateIntrinsicContentSize() {
    if !settlingConfiguration {
      contentSizeInvalidated = true
    }
    super.invalidateIntrinsicContentSize()
  }

  /// A fresh configuration is looked up in the cache by its own key; any
  /// invalidation the configure itself raises is about that same content.
  func didConfigure() {
    contentSizeInvalidated = false
    guard !settlingConfiguration else { return }
    settlingConfiguration = true
    DispatchQueue.main.async { [weak self] in
      self?.settlingConfiguration = false
    }
  }

  override func preferredLayoutAttributesFitting(
    _ layoutAttributes: UICollectionViewLayoutAttributes
  ) -> UICollectionViewLayoutAttributes {
    if !contentSizeInvalidated,
       let cacheKey,
       cacheKey.width == layoutAttributes.frame.width,
       let cached = heightCache?.height(for: cacheKey) {
      ScrollDiagnostics.shared.count(.transcriptCellCacheHit)
      Self.noteResize(from: layoutAttributes.frame.height, to: cached)
      let attributes = layoutAttributes
      attributes.frame.size.height = cached
      return attributes
    }
    if contentSizeInvalidated { ScrollDiagnostics.shared.count(.transcriptCellRemeasure) }
    contentSizeInvalidated = false
    let measured = ScrollDiagnostics.shared.measure(.transcriptCellMeasure) {
      super.preferredLayoutAttributesFitting(layoutAttributes)
    }
    if let cacheKey, cacheKey.width == measured.frame.width {
      heightCache?.store(measured.frame.height, for: cacheKey)
    }
    Self.noteResize(from: layoutAttributes.frame.height, to: measured.frame.height)
    return measured
  }

  /// Bumped whenever a cell answers self-sizing with a height other than the
  /// one the layout had: the only event UIKit compensates in `contentOffset`.
  /// The visible-jump probe reads it to tell that compensation apart from the
  /// reader's own momentum.
  static private(set) var resizeCount = 0

  private static func noteResize(from old: CGFloat, to new: CGFloat) {
    guard abs(old - new) > 0.5 else { return }
    resizeCount &+= 1
  }
}

/// A collection view that says when it has finished laying out.
///
/// `UIViewController.viewDidLayoutSubviews` does not cover this: a cell
/// self-sizing away from its estimate re-lays the collection view without ever
/// changing the controller's view bounds, and that pass is exactly the one
/// that can move a row above the reader.
final class WorkChatTranscriptCollectionViewBody: UICollectionView {
  var onWillLayout: (() -> Void)?
  var onDidLayout: (() -> Void)?

  override func layoutSubviews() {
    onWillLayout?()
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

  #if DEBUG
  /// Scroll-bench fixture only: drives the same delegate sequence a finger
  /// drag does, so the follow latch releases exactly as it would for a reader.
  func benchSimulateUserScroll(by deltaY: CGFloat) {
    guard let controller, let collectionView = controller.collectionView else { return }
    controller.scrollViewWillBeginDragging(collectionView)
    let minOffset = -collectionView.contentInset.top
    collectionView.contentOffset.y = max(minOffset, collectionView.contentOffset.y - deltaY)
    controller.scrollViewDidScroll(collectionView)
    controller.scrollViewDidEndDragging(collectionView, willDecelerate: false)
  }
  #endif
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
  /// Bumped when live interaction state that rows draw changes (host live,
  /// host unreachable, an action in flight). Reconfigures only the visible
  /// cells and is deliberately NOT part of any height-cache key: these flip
  /// enabled/disabled states, not layout, so no row is re-measured for them.
  var interactionRevision: Int = 0
  let topInset: CGFloat
  let bottomInset: CGFloat
  let scroller: WorkChatTranscriptScroller
  /// The row's view, or nil when the row is not in the model the SwiftUI side
  /// holds right now (a layout pass can dequeue a cell between the thread
  /// publishing a new frame and the next `apply`). A nil row draws nothing and
  /// is neither measured into the height cache nor left stale: the next apply
  /// reconfigures it.
  let rowContent: (WorkChatTranscriptRow) -> AnyView?
  let onFollowChange: (Bool) -> Void
  let onGeometryChange: (WorkChatTranscriptGeometry) -> Void
  let onViewportChange: (CGSize) -> Void
  /// Called after every snapshot apply that changed something, with the row
  /// count now on screen. Feeds the `thread.open.firstPaint` and
  /// `thread.delta.onScreen` signposts.
  var onRowsApplied: ((Int) -> Void)? = nil

  func makeUIViewController(context: Context) -> WorkChatTranscriptController {
    let controller = WorkChatTranscriptController()
    controller.rowContent = rowContent
    controller.onFollowChange = onFollowChange
    controller.onGeometryChange = onGeometryChange
    controller.onViewportChange = onViewportChange
    controller.onRowsApplied = onRowsApplied
    scroller.controller = controller
    return controller
  }

  func updateUIViewController(_ controller: WorkChatTranscriptController, context: Context) {
    scroller.controller = controller
    controller.rowContent = rowContent
    controller.onFollowChange = onFollowChange
    controller.onGeometryChange = onGeometryChange
    controller.onViewportChange = onViewportChange
    controller.onRowsApplied = onRowsApplied
    controller.setContentInsets(top: topInset, bottom: bottomInset)
    Self.isApplyingRows = true
    defer { Self.isApplyingRows = false }
    controller.apply(
      rows: rows,
      contentRevision: contentRevision,
      interactionRevision: interactionRevision
    )
  }

  /// True while `updateUIViewController` applies rows. Row content read here
  /// (cells configure synchronously inside the apply) must not register
  /// observation dependencies on the representable; see
  /// `WorkChatSessionView.frame`.
  @MainActor static var isApplyingRows = false

  static func dismantleUIViewController(
    _ controller: WorkChatTranscriptController,
    coordinator: ()
  ) {
    controller.teardown()
  }
}

// MARK: - Controller

@MainActor
final class WorkChatTranscriptController: UIViewController {
  enum Section: Hashable { case main }

  private(set) var collectionView: UICollectionView!
  var dataSource: UICollectionViewDiffableDataSource<Section, String>!
  let heightCache = WorkChatTranscriptHeightCache()

  var follow = WorkChatFollowState.initial

  var rowContent: ((WorkChatTranscriptRow) -> AnyView?)?
  /// Rows whose cell was configured while the row was unresolvable; the next
  /// apply reconfigures them even if nothing else changed.
  var unresolvedRowIds = Set<String>()
  var onFollowChange: ((Bool) -> Void)?
  var onGeometryChange: ((WorkChatTranscriptGeometry) -> Void)?
  var onViewportChange: ((CGSize) -> Void)?
  var onRowsApplied: ((Int) -> Void)?

  var rowsById: [String: WorkChatTranscriptRow] = [:]
  var orderedRowIds: [String] = []
  var contentRevision = 0
  var interactionRevision = 0
  var hasAppliedFirstNonEmptySnapshot = false

  /// Set whenever the content changed while following; consumed by the next
  /// layout pass. Not a retry ladder — it is armed by a content change and
  /// cleared by the pass that acts on it.
  var followPinNeeded = false
  /// Suppresses the follow pin while a user-initiated jump animation runs, so
  /// the animation is not cancelled by the pin it is heading towards.
  var animatingToLatest = false
  var lastBoundsSize: CGSize = .zero
  var lastContentHeight: CGFloat = 0
  /// The offset to put back across a viewport resize while not following.
  var stableOffsetY: CGFloat = 0
  /// The row the reader is on, and where it sits, sampled continuously while
  /// not following. A cell re-measuring is not always inside a snapshot apply
  /// — a reconfigured cell measures on a later pass — so the anchor has to be
  /// something the next layout pass can restore to, not something captured
  /// once per update.
  var liveAnchor: Anchor?
  var settleWorkItem: DispatchWorkItem?
  /// A scroll write inside a layout pass can re-enter the pass.
  var isHandlingLayoutPass = false
  /// A restore is a scroll write, and a scroll write lays out.
  var isRestoringAnchor = false

  /// Gap between rows, matching the transcript's former `LazyVStack` spacing.
  let rowSpacing: CGFloat = 14

  var diagnosticsScrollKey: String { "thread-\(ObjectIdentifier(self).hashValue)" }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    ScrollDiagnostics.shared.enter(.thread)
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    ScrollDiagnostics.shared.scrollEnded(diagnosticsScrollKey)
    ScrollDiagnostics.shared.leave(.thread)
  }

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
    collectionView.onWillLayout = { [weak self] in self?.layoutWorkDepth += 1 }
    collectionView.onDidLayout = { [weak self] in
      guard let self else { return }
      self.handleLayoutPass()
      self.layoutWorkDepth -= 1
    }
    collectionView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(collectionView)
    NSLayoutConstraint.activate([
      collectionView.topAnchor.constraint(equalTo: view.topAnchor),
      collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    self.collectionView = collectionView
    installEdgeFades()

    let registration = UICollectionView.CellRegistration<WorkChatTranscriptCell, String> {
      [weak self] cell, _, rowId in
      guard let self else { return }
      let configureStart = CACurrentMediaTime()
      defer { ScrollDiagnostics.shared.record(.transcriptCellConfigure, since: configureStart) }
      guard let resolved = self.configure(cell, rowId: rowId) else { return }
      if resolved {
        self.unresolvedRowIds.remove(rowId)
      } else {
        self.unresolvedRowIds.insert(rowId)
      }
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

  /// Configures `cell` for `rowId`. Nil when the row is not in the model;
  /// otherwise whether its content resolved (see `rowContent`).
  @discardableResult
  func configure(_ cell: WorkChatTranscriptCell, rowId: String) -> Bool? {
    guard let row = rowsById[rowId] else { return nil }
    // The list layout gives every item the full container width, so the
    // collection view's own width is the measurement width — the cell's is
    // still zero the first time it is configured.
    let width = collectionView.bounds.width
    let resolved = rowContent?(row)
    cell.heightCache = heightCache
    // A cell drawn without its row's content must not teach the cache a
    // height for that row: the key would outlive the placeholder.
    cell.cacheKey = resolved == nil ? nil : WorkChatTranscriptHeightKey(
      rowId: rowId,
      width: width,
      rowRevision: row.revision,
      contentRevision: contentRevision
    )
    cell.backgroundConfiguration = .clear()
    let content = resolved ?? AnyView(EmptyView())
    // The transcript runs edge to edge under the status bar, the floating
    // header and the keyboard, and a hosted cell pads its content by
    // whatever part of it overlaps the window's safe area: a row measured
    // up to 62 pt taller while it passed under the Dynamic Island, so rows
    // changed height as they scrolled past the top edge (the "paragraphs
    // jitter" symptom) and a row measured there drew over its neighbour.
    // The transcript's own content insets already reserve the chrome. The
    // cell reports no safe area (see `WorkChatTranscriptCell`); ignoring it
    // here as well keeps SwiftUI's own keyboard region out of the row.
    cell.contentConfiguration = UIHostingConfiguration { content.ignoresSafeArea() }
      .margins(.horizontal, 16)
      .margins(.vertical, rowSpacing / 2)
    cell.didConfigure()
    return resolved != nil
  }

  func teardown() {
    settleWorkItem?.cancel()
    settleWorkItem = nil
    heightCache.removeAll()
    sizingCell?.removeFromSuperview()
    sizingCell = nil
  }

  // MARK: Idle pre-measurement

  /// Rows the reader has not seen yet appear at the layout's estimate and
  /// measure themselves as they scroll in: that measure (up to ~18 ms for a
  /// long markdown answer on an iPhone 16 Pro) is the largest main-thread cost
  /// inside a scroll. While the reader is idle, the rows around the viewport
  /// are measured one per run-loop turn into the same height cache the cells
  /// read, keyed by (rowId, revision, width), so they scroll in as cache hits.
  var sizingCell: WorkChatTranscriptCell?
  var premeasureScheduled = false
  /// Rows whose content did not resolve for the sizing cell; retried after the
  /// next apply.
  var premeasureSkipped = Set<String>()
  /// Keys already measured off screen, whatever the result: a row the cache
  /// declines to store (zero height) must not be measured again every turn.
  var premeasureAttempted = Set<WorkChatTranscriptHeightKey>()
  /// Rows the last apply changed. Below the viewport these are the live turn's
  /// rows, which change again on the next event: measuring them off screen
  /// would be thrown away 15 times a second.
  var lastChangedRowIds = Set<String>()
  /// Rows above the viewport to have measured (history the reader scrolls
  /// up into), and below it.
  let premeasureRadiusAbove = 150
  let premeasureRadiusBelow = 40
  /// Tests compare a pre-measured transcript against one that measures only
  /// on screen.
  var premeasureEnabled = true

  var isReaderScrolling: Bool {
    collectionView.isTracking || collectionView.isDragging || collectionView.isDecelerating
  }

  func schedulePremeasure() {
    guard premeasureEnabled, !premeasureScheduled else { return }
    premeasureScheduled = true
    DispatchQueue.main.async { [weak self] in self?.premeasureStep() }
  }

  func premeasureStep() {
    premeasureScheduled = false
    guard isViewLoaded, view.window != nil, !isReaderScrolling, !animatingToLatest else { return }
    let width = collectionView.bounds.width
    guard width > 0, let rowId = nextRowToPremeasure(width: width) else { return }
    let cell = sizingCell ?? makeSizingCell()
    if configure(cell, rowId: rowId) == true {
      cell.frame = CGRect(x: 0, y: 0, width: width, height: 44)
      // The same fit the list layout asks a cell for: width fixed at the
      // column, height free. (A bare `preferredLayoutAttributesFitting` on a
      // cell outside the layout fits the width too.)
      let size = ScrollDiagnostics.shared.measure(.transcriptPremeasure) {
        cell.systemLayoutSizeFitting(
          CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
          withHorizontalFittingPriority: .required,
          verticalFittingPriority: .fittingSizeLevel
        )
      }
      if let key = cell.cacheKey {
        heightCache.store(size.height, for: key)
      }
    } else {
      premeasureSkipped.insert(rowId)
    }
    schedulePremeasure()
  }

  func makeSizingCell() -> WorkChatTranscriptCell {
    let cell = WorkChatTranscriptCell(frame: .zero)
    // In the hierarchy (hidden) so it measures with the transcript's traits:
    // Dynamic Type, dark mode, display scale.
    cell.isHidden = true
    cell.isUserInteractionEnabled = false
    view.insertSubview(cell, at: 0)
    sizingCell = cell
    return cell
  }

  /// Nearest unmeasured row to the viewport, above first (the reader scrolls
  /// up into history far more than down).
  func nextRowToPremeasure(width: CGFloat) -> String? {
    let visible = collectionView.indexPathsForVisibleItems.map(\.item)
    guard let first = visible.min(), let last = visible.max() else { return nil }
    func needsMeasure(_ index: Int, below: Bool) -> String? {
      guard index >= 0, index < orderedRowIds.count else { return nil }
      let rowId = orderedRowIds[index]
      guard let row = rowsById[rowId], !premeasureSkipped.contains(rowId) else { return nil }
      if below, lastChangedRowIds.contains(rowId) { return nil }
      let key = WorkChatTranscriptHeightKey(
        rowId: rowId,
        width: width,
        rowRevision: row.revision,
        contentRevision: contentRevision
      )
      guard heightCache.height(for: key) == nil, premeasureAttempted.insert(key).inserted else {
        return nil
      }
      return rowId
    }
    for distance in 1...premeasureRadiusAbove {
      if let rowId = needsMeasure(first - distance, below: false) { return rowId }
      if distance <= premeasureRadiusBelow,
         let rowId = needsMeasure(last + distance, below: true) { return rowId }
    }
    return nil
  }

  // MARK: Edge fades

  var topEdgeBandHeight: NSLayoutConstraint?
  var bottomEdgeBandHeight: NSLayoutConstraint?
  var topEdgeFade: WorkChatEdgeFadeView?
  var bottomEdgeFade: WorkChatEdgeFadeView?

  /// The thread runs edge to edge under the floating header and composer.
  /// Text passing under the clock and the title capsule is softened by a
  /// progressive canvas-coloured fade over exactly the band each chrome
  /// reserves (its content inset) — still visible, never a solid band.
  ///
  /// Not the native `UIScrollEdgeElementContainerInteraction`: the chrome is
  /// SwiftUI floating above this representable, and stand-in containers
  /// registered for it produced no visible effect. A gradient layer is also
  /// cheaper than a mask: it blends once and adds no offscreen pass while
  /// the transcript scrolls under it.
  func installEdgeFades() {
    let top = WorkChatEdgeFadeView(edge: .top)
    let bottom = WorkChatEdgeFadeView(edge: .bottom)
    view.addSubview(top)
    view.addSubview(bottom)
    let topHeight = top.heightAnchor.constraint(equalToConstant: collectionView.contentInset.top)
    let bottomHeight = bottom.heightAnchor.constraint(equalToConstant: collectionView.contentInset.bottom)
    NSLayoutConstraint.activate([
      top.topAnchor.constraint(equalTo: view.topAnchor),
      top.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      top.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      topHeight,
      bottom.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      bottom.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      bottom.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      bottomHeight,
    ])
    topEdgeBandHeight = topHeight
    bottomEdgeBandHeight = bottomHeight
    topEdgeFade = top
    bottomEdgeFade = bottom
  }

  func setContentInsets(top: CGFloat, bottom: CGFloat) {
    guard isViewLoaded else { return }
    let insets = UIEdgeInsets(top: top, left: 0, bottom: bottom, right: 0)
    guard collectionView.contentInset != insets else { return }
    let wasFollowing = follow.following
    collectionView.contentInset = insets
    collectionView.verticalScrollIndicatorInsets = insets
    topEdgeBandHeight?.constant = top
    bottomEdgeBandHeight?.constant = bottom
    if wasFollowing {
      followPinNeeded = true
    }
  }

  // MARK: Snapshot

  func apply(
    rows incoming: [WorkChatTranscriptRow],
    contentRevision revision: Int,
    interactionRevision nextInteractionRevision: Int = 0
  ) {
    guard isViewLoaded else { return }
    let diagnosticsStart = CACurrentMediaTime()
    defer { ScrollDiagnostics.shared.record(.transcriptApply, since: diagnosticsStart) }
    // Both `Dictionary(uniqueKeysWithValues:)` below and the diffable snapshot
    // trap on a repeated id, and one split assistant message mints row ids by
    // string concatenation (`<entryId>-<blockId>`), so uniqueness is a property
    // of the producer rather than a guarantee. A duplicate is a rendering bug
    // worth fixing at the source; it is never worth crashing the transcript.
    var seenRowIds = Set<String>()
    seenRowIds.reserveCapacity(incoming.count)
    let rows = incoming.filter { seenRowIds.insert($0.id).inserted }
    let nextIds = rows.map(\.id)
    let revisionChanged = revision != contentRevision
    let changedRowIds: [String] = rows.compactMap { row in
      guard let previous = rowsById[row.id] else { return nil }
      return previous.revision == row.revision ? nil : row.id
    }
    let orderChanged = nextIds != orderedRowIds
    let unresolved = unresolvedRowIds.intersection(nextIds)
    let interactionChanged = nextInteractionRevision != interactionRevision
    guard orderChanged || revisionChanged || interactionChanged
      || !changedRowIds.isEmpty || !unresolved.isEmpty else {
      return
    }
    layoutWorkDepth += 1
    isApplyingSnapshot = true
    defer {
      isApplyingSnapshot = false
      layoutWorkDepth -= 1
    }

    // Against the row order that is still on screen: the anchor is a row the
    // reader can see, and resolving it after the list is replaced would map
    // its index onto whatever the insert put there.
    let anchor = captureAnchor()
    let previousContentHeight = collectionView.contentSize.height

    contentRevision = revision
    interactionRevision = nextInteractionRevision
    rowsById = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    orderedRowIds = nextIds
    heightCache.prune(
      keeping: Dictionary(rows.map { ($0.id, $0.revision) }, uniquingKeysWith: { first, _ in first }),
      contentRevision: revision
    )

    var snapshot = NSDiffableDataSourceSnapshot<Section, String>()
    snapshot.appendSections([.main])
    snapshot.appendItems(nextIds, toSection: .main)
    var reconfigure = revisionChanged ? nextIds : changedRowIds
    if !revisionChanged, !unresolved.isEmpty {
      reconfigure.append(contentsOf: unresolved.subtracting(changedRowIds))
    }
    if !revisionChanged, interactionChanged {
      // Visible cells only: an off-screen cell configures fresh when it scrolls
      // in, and its height key is unchanged, so its cached height still holds.
      let alreadyReconfigured = Set(reconfigure)
      let liveIds = Set(nextIds)
      let visibleIds = collectionView.indexPathsForVisibleItems.compactMap { indexPath in
        dataSource.itemIdentifier(for: indexPath)
      }
      reconfigure.append(contentsOf: visibleIds.filter {
        liveIds.contains($0) && !alreadyReconfigured.contains($0)
      })
    }
    unresolvedRowIds.removeAll()
    if !reconfigure.isEmpty {
      snapshot.reconfigureItems(reconfigure)
      if ScrollDiagnostics.shared.isRunning {
        for _ in reconfigure { ScrollDiagnostics.shared.count(.transcriptReconfigure) }
      }
    }
    ScrollDiagnostics.shared.measure(.transcriptSnapshotApply) {
      dataSource.apply(snapshot, animatingDifferences: false)
    }
    ScrollDiagnostics.shared.measure(.transcriptApplyLayout) {
      collectionView.layoutIfNeeded()
    }

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
      if !restoreAnchorIfMoved(anchor, reason: "anchor-restore", shiftDuringUserScroll: true) {
        liveAnchor = captureAnchor()
      }
    }
    lastContentHeight = collectionView.contentSize.height
    // Judged once the apply's own restore has run: the layout pass inside it
    // is an intermediate state, never composited.
    checkJumpProbe()
    premeasureSkipped.removeAll()
    if premeasureAttempted.count > 4096 { premeasureAttempted.removeAll() }
    lastChangedRowIds = Set(changedRowIds)
    schedulePremeasure()
    onRowsApplied?(nextIds.count)
  }

  var jumpProbe: JumpProbe?
  /// Offset the reader moved since `jumpProbe` was taken (see
  /// `noteObservedOffset`).
  var userScrollSinceProbe: CGFloat = 0
  var lastObservedOffsetY: CGFloat = .nan
  /// > 0 while the transcript itself is laying out, applying, or writing the
  /// offset: a `didScroll` raised in there is UIKit compensating a self-sizing
  /// row or one of our writes, never the reader.
  var layoutWorkDepth = 0
  var isApplyingSnapshot = false

  var lastFingerY: CGFloat?
  /// Offset points per millisecond of the running fling, seeded by UIKit's
  /// release velocity and followed frame by frame.
  var momentumVelocity: CGFloat = 0
  var lastObservedAt: CFTimeInterval = 0
  var lastSeenResizeCount = 0
  var momentumEstimatedSinceProbe = false

}

// MARK: - Edge fade

/// A touch-transparent gradient of the transcript canvas colour, strongest at
/// the screen edge and clear where the chrome's band ends. Reduce
/// Transparency makes it close to opaque, so controls sit on a calm surface.
final class WorkChatEdgeFadeView: UIView {
  private let edge: UIRectEdge
  private let gradient = CAGradientLayer()

  init(edge: UIRectEdge) {
    self.edge = edge
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    translatesAutoresizingMaskIntoConstraints = false
    layer.addSublayer(gradient)
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(refreshColors),
      name: UIAccessibility.reduceTransparencyStatusDidChangeNotification,
      object: nil
    )
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: WorkChatEdgeFadeView, _) in
      view.refreshColors()
    }
    refreshColors()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.frame = bounds
    CATransaction.commit()
  }

  @objc private func refreshColors() {
    let canvas = UIColor(workChatCanvasBackground).resolvedColor(with: traitCollection)
    let strong: CGFloat = UIAccessibility.isReduceTransparencyEnabled ? 0.97 : 0.86
    let middle: CGFloat = UIAccessibility.isReduceTransparencyEnabled ? 0.9 : 0.55
    // Listed from the screen edge inward.
    let stops: [(CGFloat, CGFloat)] = [(0, strong), (0.45, middle), (1, 0)]
    let ordered = edge == .top ? stops : stops.reversed().map { (1 - $0.0, $0.1) }
    gradient.colors = ordered.map { canvas.withAlphaComponent($0.1).cgColor }
    gradient.locations = ordered.map { NSNumber(value: Double($0.0)) }
    gradient.startPoint = CGPoint(x: 0.5, y: 0)
    gradient.endPoint = CGPoint(x: 0.5, y: 1)
  }
}
