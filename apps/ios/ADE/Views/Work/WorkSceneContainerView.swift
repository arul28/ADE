import UIKit
import WebKit

// The place in a transcript row where a sandboxed web view sits: a scene's
// (`WorkSceneView.swift`) or an MCP App's (`WorkMcpAppView.swift`). It sees the
// reader's taps for the host and decides when the row is on screen.

/// Sees a tap without taking it: the web view's own recognizers and the feed's
/// pan all still run. A touch that moves is a scroll, not a tap.
private final class WorkSceneTapObserver: UIGestureRecognizer {
  var onTap: (() -> Void)?
  private var start: CGPoint?
  private var moved = false

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    guard start == nil, let touch = touches.first else { return }
    start = touch.location(in: nil)
    moved = false
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let start, let touch = touches.first else { return }
    let point = touch.location(in: nil)
    if hypot(point.x - start.x, point.y - start.y) > 12 { moved = true }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    if start != nil, !moved { onTap?() }
    state = .failed
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    state = .failed
  }

  override func reset() {
    start = nil
    moved = false
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}

/// What a container reports to: a scene's controller here, or an MCP App's
/// (`WorkMcpAppView.swift`). Both get the same tap observer and the same
/// "on screen" rule, because both hold code ADE did not write.
@MainActor
protocol WorkSceneContainerOwner: AnyObject {
  /// The reader tapped inside the container. The host saw it; the page did not say it.
  func containerNoteTap()
  func containerScheduleEvaluate()
  func containerThemeChanged()
  func containerDetach(_ container: WorkSceneContainerView)
}

/// The scene's place in the row: the picture, and the web view over it while
/// the row is on screen. It decides "on screen" itself, from the feed it sits
/// in, because a transcript cell is also built off screen to be measured.
final class WorkSceneContainerView: UIView {
  private weak var controller: (any WorkSceneContainerOwner)?
  private let stillView = UIImageView()
  private weak var webView: WKWebView?
  private weak var observedScrollView: UIScrollView?
  private var offsetObservation: NSKeyValueObservation?

  init(controller: any WorkSceneContainerOwner) {
    self.controller = controller
    super.init(frame: .zero)
    clipsToBounds = true
    backgroundColor = .clear
    stillView.contentMode = .topLeft
    stillView.clipsToBounds = true
    stillView.isHidden = true
    stillView.isUserInteractionEnabled = false
    addSubview(stillView)

    let taps = WorkSceneTapObserver()
    taps.cancelsTouchesInView = false
    taps.delaysTouchesBegan = false
    taps.delaysTouchesEnded = false
    taps.onTap = { [weak self] in self?.controller?.containerNoteTap() }
    addGestureRecognizer(taps)

    registerForTraitChanges(
      [UITraitUserInterfaceStyle.self, UITraitPreferredContentSizeCategory.self]
    ) { (view: WorkSceneContainerView, _) in
      view.controller?.containerThemeChanged()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  /// In a window, not hidden by any ancestor (a cell built to be measured, or
  /// one waiting for reuse, is), and inside the feed's visible part.
  var isOnScreen: Bool {
    guard let window, bounds.width > 0, bounds.height > 0 else { return false }
    var ancestor: UIView? = self
    while let view = ancestor {
      if view.isHidden || view.alpha < 0.01 { return false }
      ancestor = view.superview
    }
    if let scrollView = observedScrollView {
      return convert(bounds, to: scrollView).intersects(scrollView.bounds)
    }
    return convert(bounds, to: window).intersects(window.bounds)
  }

  /// The reader's finger or its momentum is moving the feed. A pin the
  /// transcript writes while a turn streams is not the reader.
  var isReaderScrolling: Bool {
    guard let scrollView = observedScrollView else { return false }
    return scrollView.isDragging || scrollView.isDecelerating
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    observeEnclosingScrollView()
    controller?.containerScheduleEvaluate()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    webView?.frame = bounds
    stillView.frame = bounds
    controller?.containerScheduleEvaluate()
  }

  private func observeEnclosingScrollView() {
    var found: UIScrollView?
    var ancestor = superview
    while let view = ancestor {
      if let scrollView = view as? UIScrollView {
        found = scrollView
        break
      }
      ancestor = view.superview
    }
    guard found !== observedScrollView || window == nil else { return }
    offsetObservation = nil
    observedScrollView = window == nil ? nil : found
    offsetObservation = observedScrollView?.observe(\.contentOffset) { [weak self] _, _ in
      MainActor.assumeIsolated {
        self?.controller?.containerScheduleEvaluate()
      }
    }
  }

  func showStill(_ image: UIImage?, covering: Bool) {
    if stillView.image !== image { stillView.image = image }
    stillView.isHidden = image == nil || !covering
  }

  func install(_ webView: WKWebView, hidden: Bool) {
    self.webView?.removeFromSuperview()
    self.webView = webView
    webView.frame = bounds
    webView.alpha = hidden ? 0 : 1
    addSubview(webView)
  }

  func revealWebView() {
    webView?.alpha = 1
    stillView.isHidden = true
  }

  func remove(_ webView: WKWebView) {
    webView.removeFromSuperview()
    if self.webView === webView { self.webView = nil }
  }
}

extension WorkSceneContainerView {
  func detachFromController() {
    offsetObservation = nil
    observedScrollView = nil
    controller?.containerDetach(self)
    // Whatever became of the controller, no web view outlives its row.
    webView?.removeFromSuperview()
    webView = nil
  }
}
