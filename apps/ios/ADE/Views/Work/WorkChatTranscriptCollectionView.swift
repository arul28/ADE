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
final class WorkChatTranscriptController: UIViewController, UICollectionViewDelegate {
  private enum Section: Hashable { case main }

  private(set) var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Section, String>!
  private let heightCache = WorkChatTranscriptHeightCache()

  private(set) var follow = WorkChatFollowState.initial

  var rowContent: ((WorkChatTranscriptRow) -> AnyView?)?
  /// Rows whose cell was configured while the row was unresolvable; the next
  /// apply reconfigures them even if nothing else changed.
  private var unresolvedRowIds = Set<String>()
  var onFollowChange: ((Bool) -> Void)?
  var onGeometryChange: ((WorkChatTranscriptGeometry) -> Void)?
  var onViewportChange: ((CGSize) -> Void)?
  var onRowsApplied: ((Int) -> Void)?

  private var rowsById: [String: WorkChatTranscriptRow] = [:]
  private var orderedRowIds: [String] = []
  private var contentRevision = 0
  private var interactionRevision = 0
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
  /// A restore is a scroll write, and a scroll write lays out.
  private var isRestoringAnchor = false

  /// Gap between rows, matching the transcript's former `LazyVStack` spacing.
  private let rowSpacing: CGFloat = 14

  private var diagnosticsScrollKey: String { "thread-\(ObjectIdentifier(self).hashValue)" }

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
  private func configure(_ cell: WorkChatTranscriptCell, rowId: String) -> Bool? {
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
  private var sizingCell: WorkChatTranscriptCell?
  private var premeasureScheduled = false
  /// Rows whose content did not resolve for the sizing cell; retried after the
  /// next apply.
  private var premeasureSkipped = Set<String>()
  /// Keys already measured off screen, whatever the result: a row the cache
  /// declines to store (zero height) must not be measured again every turn.
  private var premeasureAttempted = Set<WorkChatTranscriptHeightKey>()
  /// Rows the last apply changed. Below the viewport these are the live turn's
  /// rows, which change again on the next event: measuring them off screen
  /// would be thrown away 15 times a second.
  private var lastChangedRowIds = Set<String>()
  /// Rows above the viewport to have measured (history the reader scrolls
  /// up into), and below it.
  private let premeasureRadiusAbove = 150
  private let premeasureRadiusBelow = 40
  /// Tests compare a pre-measured transcript against one that measures only
  /// on screen.
  var premeasureEnabled = true

  private var isReaderScrolling: Bool {
    collectionView.isTracking || collectionView.isDragging || collectionView.isDecelerating
  }

  private func schedulePremeasure() {
    guard premeasureEnabled, !premeasureScheduled else { return }
    premeasureScheduled = true
    DispatchQueue.main.async { [weak self] in self?.premeasureStep() }
  }

  private func premeasureStep() {
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

  private func makeSizingCell() -> WorkChatTranscriptCell {
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
  private func nextRowToPremeasure(width: CGFloat) -> String? {
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

  private var topEdgeBandHeight: NSLayoutConstraint?
  private var bottomEdgeBandHeight: NSLayoutConstraint?
  private var topEdgeFade: WorkChatEdgeFadeView?
  private var bottomEdgeFade: WorkChatEdgeFadeView?

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
  private func installEdgeFades() {
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
  private func readerAnchorIndexPath() -> (IndexPath, UICollectionViewLayoutAttributes)? {
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

  private func captureAnchor() -> Anchor? {
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
  private func restoreAnchorIfMoved(
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
  private func shiftOffsetUnderReader(by rawDelta: CGFloat, anchor: Anchor, rowMinY: CGFloat) -> Bool {
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

  private enum ScrollWrite {
    case pinToBottom(animated: Bool)
    case setOffset(CGFloat)
    case revealRow(String)
  }

  /// The only function in the transcript that moves the viewport.
  private var minContentOffsetY: CGFloat {
    -collectionView.contentInset.top
  }

  private var maxContentOffsetY: CGFloat {
    max(
      minContentOffsetY,
      collectionView.contentSize.height - collectionView.bounds.height
        + collectionView.contentInset.bottom
    )
  }

  private func performScrollWrite(_ write: ScrollWrite, reason: String) {
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
  private struct JumpProbe {
    let rowId: String
    let screenY: CGFloat
  }

  private var jumpProbe: JumpProbe?
  /// Offset the reader moved since `jumpProbe` was taken (see
  /// `noteObservedOffset`).
  private var userScrollSinceProbe: CGFloat = 0
  private var lastObservedOffsetY: CGFloat = .nan
  /// > 0 while the transcript itself is laying out, applying, or writing the
  /// offset: a `didScroll` raised in there is UIKit compensating a self-sizing
  /// row or one of our writes, never the reader.
  private var layoutWorkDepth = 0
  private var isApplyingSnapshot = false

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
  private func checkJumpProbe() {
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

  private var lastFingerY: CGFloat?
  /// Offset points per millisecond of the running fling, seeded by UIKit's
  /// release velocity and followed frame by frame.
  private var momentumVelocity: CGFloat = 0
  private var lastObservedAt: CFTimeInterval = 0
  private var lastSeenResizeCount = 0
  private var momentumEstimatedSinceProbe = false

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
  private func noteObservedOffset(_ scrollView: UIScrollView) {
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
  private func traceViewportAnchor() {
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
    schedulePremeasure()
  }
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
