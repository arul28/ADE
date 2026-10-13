import Combine
import SwiftUI
import UIKit
import WebKit

// Scenes on the phone.
//
// A scene is code an agent wrote, so it never runs in the app. It runs in a
// `WKWebView` of its own: a separate process, a data store that keeps nothing,
// an opaque origin (`loadHTMLString` with no base URL), and a document whose
// first `<head>` element is desktop's scene policy — no network at all. The
// page is handed the app's colors and nothing else.
//
// Its only ways out are the messages `workParseSceneInboundMessage` accepts,
// and the two that do anything (open a link, put text in the prompt box) are
// acted on only right after a real tap on the web view, which the host sees
// for itself. Everything else it could try is refused: every navigation after
// the first load, new windows, downloads, capture prompts, link previews.
//
// A web view is another process, so a scene has one only while its row is on
// screen and the reader has stopped scrolling. A picture taken when the scene
// settles stands in for it the rest of the time.

// MARK: - Chat bridge

/// A text a scene put in a chat's prompt box. Posted here, picked up by that
/// chat's composer; nothing is sent to the agent.
struct WorkSceneReplyRequest {
  let sessionId: String
  let text: String
}

enum WorkSceneReplyCenter {
  static let replies = PassthroughSubject<WorkSceneReplyRequest, Never>()
}

/// What a chat gives the scenes in its transcript: the transcript itself, to
/// see whether the reader has answered, and its prompt box. A plain reference,
/// not an observable: no row re-renders because of it.
@MainActor
final class WorkSceneChatBridge {
  var sessionId = ""
  /// False while the chat has no prompt box to write in.
  var canReply = false
  /// The chat's current timeline, read when a scene asks.
  var timeline: () -> [WorkTimelineEntry] = { [] }

  private let scenes = NSHashTable<WorkSceneController>.weakObjects()

  fileprivate func add(_ scene: WorkSceneController) { scenes.add(scene) }
  fileprivate func remove(_ scene: WorkSceneController) { scenes.remove(scene) }

  /// The transcript changed: a scene on screen may now be answered.
  func timelineChanged() {
    for scene in scenes.allObjects { scene.refreshAnswered() }
  }

  /// The reader's message that follows the scene's message, when there is one.
  /// As desktop derives it (`sceneAnswers`): messages ADE wrote for the user (a
  /// board move, a PR watch wake) are cards here, not user messages.
  func answeredText(afterMessageId messageId: String) -> String? {
    let entries = timeline()
    guard let index = entries.firstIndex(where: { entry in
      if case .message(let message) = entry.payload { return message.id == messageId }
      return false
    }) else { return nil }
    for entry in entries[entries.index(after: index)...] {
      if case .message(let message) = entry.payload,
         message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" {
        return message.markdown.trimmingCharacters(in: .whitespacesAndNewlines)
      }
    }
    return nil
  }

  /// Put `text` in this chat's prompt box as a draft. A scene and an MCP App
  /// both end here; neither sends anything.
  func reply(_ text: String) {
    WorkSceneReplyCenter.replies.send(WorkSceneReplyRequest(sessionId: sessionId, text: text))
  }
}

private struct WorkSceneBridgeKey: EnvironmentKey {
  static let defaultValue: WorkSceneChatBridge? = nil
}

private struct WorkSceneMessageIdKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

extension EnvironmentValues {
  /// The chat a scene belongs to. Nil outside a chat transcript (a plan
  /// preview, a file): the scene runs there and cannot reply.
  var workSceneBridge: WorkSceneChatBridge? {
    get { self[WorkSceneBridgeKey.self] }
    set { self[WorkSceneBridgeKey.self] = newValue }
  }

  /// The message a markdown block was drawn from.
  var workSceneMessageId: String? {
    get { self[WorkSceneMessageIdKey.self] }
    set { self[WorkSceneMessageIdKey.self] = newValue }
  }
}

// MARK: - Memory

/// What a scene leaves behind between two web views: its height, so the feed
/// does not jump when it comes back; its picture; and that it already played,
/// so its entrance does not replay. In memory only, and bounded.
@MainActor
final class WorkSceneMemory {
  static let shared = WorkSceneMemory()

  private var heights: [String: CGFloat] = [:]
  private var played = Set<String>()
  private let stills: NSCache<NSString, UIImage> = {
    let cache = NSCache<NSString, UIImage>()
    cache.countLimit = 24
    cache.totalCostLimit = 48 * 1024 * 1024
    return cache
  }()
  private var memoryWarning: NSObjectProtocol?

  private init() {
    memoryWarning = NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.stills.removeAllObjects() }
    }
  }

  func height(for scopeKey: String) -> CGFloat? { heights[scopeKey] }

  func remember(height: CGFloat, for scopeKey: String) {
    if heights.count > 512 { heights.removeAll(keepingCapacity: true) }
    heights[scopeKey] = height
  }

  func hasPlayed(_ scopeKey: String) -> Bool { played.contains(scopeKey) }

  func markPlayed(_ scopeKey: String) {
    if played.count > 512 { played.removeAll(keepingCapacity: true) }
    played.insert(scopeKey)
  }

  private func stillKey(_ scopeKey: String, _ theme: WorkSceneTheme, _ width: CGFloat) -> NSString {
    "\(scopeKey)|\(theme.signature)|\(Int(width.rounded()))" as NSString
  }

  func still(for scopeKey: String, theme: WorkSceneTheme, width: CGFloat) -> UIImage? {
    stills.object(forKey: stillKey(scopeKey, theme, width))
  }

  func remember(still: UIImage, for scopeKey: String, theme: WorkSceneTheme, width: CGFloat) {
    let pixels = still.size.width * still.scale * still.size.height * still.scale
    stills.setObject(still, forKey: stillKey(scopeKey, theme, width), cost: Int(pixels * 4))
  }
}

// MARK: - Controller

/// One scene: its web view while it is on screen, and what the page asks for.
@MainActor
final class WorkSceneController: NSObject, ObservableObject {
  /// The row's height. Changes make the transcript cell re-measure.
  @Published private(set) var height: CGFloat
  /// The scene threw before it was up: a blank or half-drawn view.
  @Published private(set) var drawFailed = false
  /// The last thing the page or the host refused, for the line under the scene.
  @Published private(set) var notice: String?

  let scopeKey: String
  private var parsed: WorkParsedScene?
  private var messageId: String?
  private weak var bridge: WorkSceneChatBridge?
  private weak var container: WorkSceneContainerView?

  private var webView: WKWebView?
  private var nonce: String?
  /// The theme the document in the web view has: built in, or last posted.
  private var frameTheme: WorkSceneTheme?
  private var ready = false
  private var settled = false
  private var answeredSent: String?
  private var crashCount = 0

  private var resolvedTheme: WorkSceneTheme?
  private var evaluateScheduled = false
  private var activateTimer: Timer?
  private var lingerTimer: Timer?
  private var readyTimer: Timer?

  private var lastTapAt: CFTimeInterval = 0
  private var lastOpenAt: CFTimeInterval = 0
  private var lastReplyAt: CFTimeInterval = 0

  /// On screen this long, with the reader not scrolling, before a web view is
  /// made: a flick past a scene makes nothing. Desktop: 120 ms + 150 ms quiet.
  private static let activateDelay: TimeInterval = 0.15
  /// Off screen this long before the web view goes. Desktop: 4 s.
  private static let lingerDelay: TimeInterval = 4
  /// How long after a tap on the web view the page may open a link or reply.
  private static let tapWindow: TimeInterval = 1
  private static let bridgeWorld = WKContentWorld.world(name: "adeSceneBridge")
  private static let handlerName = "adeScene"

  /// Runs in its own content world, so the page cannot see the handler. It
  /// passes on only what the SDK stamps, as bounded JSON text; the host
  /// validates every field again.
  private static let bridgeScript = """
  (function () {
    var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName);
    if (!handler) return;
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || data.__adeScene !== 1) return;
      var text;
      try { text = JSON.stringify(data); } catch (e) { return; }
      if (typeof text !== "string" || text.length > \(WorkSceneLimits.inboundMaxLength)) return;
      handler.postMessage(text);
    }, true);
  })();
  """

  init(scopeKey: String) {
    self.scopeKey = scopeKey
    self.height = WorkSceneMemory.shared.height(for: scopeKey) ?? WorkSceneLimits.defaultHeight
    super.init()
  }

  // MARK: Wiring

  func update(parsed: WorkParsedScene, messageId: String?, bridge: WorkSceneChatBridge?) {
    self.parsed = parsed
    self.messageId = messageId
    self.bridge = bridge
  }

  fileprivate func attach(_ container: WorkSceneContainerView) {
    self.container = container
    scheduleEvaluate()
  }

  fileprivate func detach(_ container: WorkSceneContainerView) {
    guard self.container === container else { return }
    unmount()
    self.container = nil
  }

  fileprivate func noteTap() {
    lastTapAt = CACurrentMediaTime()
  }

  // MARK: On screen

  /// Coalesced, and never inside the layout or scroll callback that asked: a
  /// mount publishes, and a publish inside a view update is dropped.
  fileprivate func scheduleEvaluate() {
    guard !evaluateScheduled else { return }
    evaluateScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.evaluateScheduled = false
      self.evaluate()
    }
  }

  private func evaluate() {
    guard let container else { return }
    if container.isOnScreen {
      lingerTimer?.invalidate()
      lingerTimer = nil
      // Past the reveal the picture is under the web view; nothing to look up.
      if webView == nil || !ready {
        container.showStill(currentStill(in: container), covering: true)
      }
      guard webView == nil, !drawFailed, activateTimer == nil else { return }
      activateTimer = timer(after: Self.activateDelay) { $0.activate() }
    } else {
      activateTimer?.invalidate()
      activateTimer = nil
      guard webView != nil, lingerTimer == nil else { return }
      lingerTimer = timer(after: Self.lingerDelay) { controller in
        controller.lingerTimer = nil
        if controller.container?.isOnScreen != true { controller.unmount() }
      }
    }
  }

  private func activate() {
    activateTimer = nil
    guard let container, container.isOnScreen, webView == nil, !drawFailed else { return }
    if container.isReaderScrolling {
      activateTimer = timer(after: Self.activateDelay) { $0.activate() }
      return
    }
    mount(in: container)
  }

  private func timer(after delay: TimeInterval, _ fire: @escaping @MainActor @Sendable (WorkSceneController) -> Void) -> Timer {
    let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        fire(self)
      }
    }
    // Common modes: a linger must run out while the reader scrolls.
    RunLoop.main.add(timer, forMode: .common)
    return timer
  }

  /// The app's palette for this row, resolved once per appearance: `evaluate`
  /// runs on every scroll frame.
  private func theme(in container: WorkSceneContainerView) -> WorkSceneTheme {
    if let resolvedTheme { return resolvedTheme }
    let theme = WorkSceneTheme.resolved(for: container.traitCollection)
    resolvedTheme = theme
    return theme
  }

  private func currentStill(in container: WorkSceneContainerView) -> UIImage? {
    WorkSceneMemory.shared.still(for: scopeKey, theme: theme(in: container), width: container.bounds.width)
  }

  // MARK: Web view

  private func mount(in container: WorkSceneContainerView) {
    guard webView == nil, let parsed else { return }
    guard let shell = WorkSceneShell.bundled else {
      fail("This build cannot draw scenes.")
      return
    }
    let theme = theme(in: container)
    let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    let document = shell.document(
      html: parsed.html,
      theme: theme,
      nonce: nonce,
      restored: WorkSceneMemory.shared.hasPlayed(scopeKey)
    )

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.preferences.isElementFullscreenEnabled = false
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.dataDetectorTypes = []
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = .all
    configuration.allowsAirPlayForMediaPlayback = false
    configuration.allowsPictureInPictureMediaPlayback = false
    // Exactly one handler, in the bridge's own world.
    configuration.userContentController.add(
      WorkSceneMessageProxy(self),
      contentWorld: Self.bridgeWorld,
      name: Self.handlerName
    )
    configuration.userContentController.addUserScript(WKUserScript(
      source: Self.bridgeScript,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true,
      in: Self.bridgeWorld
    ))

    let webView = WKWebView(frame: container.bounds, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.underPageBackgroundColor = .clear
    webView.allowsLinkPreview = false
    webView.allowsBackForwardNavigationGestures = false
    let scrollView = webView.scrollView
    scrollView.backgroundColor = .clear
    scrollView.contentInsetAdjustmentBehavior = .never
    // A scene is as tall as its content, so the page itself never scrolls and
    // every vertical swipe belongs to the feed. Past the height clamp the page
    // scrolls, without a bounce: at its top or bottom the swipe goes to the feed.
    scrollView.isScrollEnabled = false
    scrollView.bounces = false
    scrollView.alwaysBounceVertical = false
    scrollView.alwaysBounceHorizontal = false
    scrollView.showsHorizontalScrollIndicator = false
    scrollView.pinchGestureRecognizer?.isEnabled = false

    self.webView = webView
    self.nonce = nonce
    frameTheme = theme
    ready = false
    settled = false
    answeredSent = nil
    initialLoadStarted = false
    bridge?.add(self)
    // Under its picture until it has drawn; with none, its entrance is the point.
    let still = currentStill(in: container)
    container.showStill(still, covering: true)
    container.install(webView, hidden: still != nil)
    webView.loadHTMLString(document, baseURL: nil)

    readyTimer?.invalidate()
    // A scene that never says it is up is not necessarily broken.
    readyTimer = timer(after: WorkSceneLimits.readyTimeout) { $0.becomeReady() }
  }

  private func unmount() {
    activateTimer?.invalidate()
    activateTimer = nil
    lingerTimer?.invalidate()
    lingerTimer = nil
    readyTimer?.invalidate()
    readyTimer = nil
    bridge?.remove(self)
    guard let webView else { return }
    self.webView = nil
    nonce = nil
    ready = false
    settled = false
    webView.stopLoading()
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
    webView.configuration.userContentController.removeAllUserScripts()
    webView.configuration.userContentController.removeScriptMessageHandler(
      forName: Self.handlerName,
      contentWorld: Self.bridgeWorld
    )
    if let container {
      container.remove(webView)
      container.showStill(currentStill(in: container), covering: true)
    }
  }

  private func fail(_ message: String) {
    unmount()
    notice = message
    drawFailed = true
  }

  /// Retry from the failure line: a fresh web view and a fresh document.
  func retry() {
    notice = nil
    drawFailed = false
    crashCount = 0
    scheduleEvaluate()
  }

  private func post(_ message: WorkSceneOutboundMessage) {
    guard let webView, let script = message.script else { return }
    webView.evaluateJavaScript(script, completionHandler: nil)
  }

  // MARK: What the page says

  fileprivate func receive(_ body: Any) {
    guard let envelope = workParseSceneInboundMessage(body),
          let nonce, envelope.nonce == nonce else { return }
    switch envelope.message {
    case .error(let message, let policy):
      // Thrown before the page said it was up: the view did not draw. A policy
      // block (a remote font or image) is reported, not treated as a failure.
      if !policy, !ready {
        fail(message)
      } else {
        notice = message
      }
    case .emit:
      break
    case .open(let url):
      open(url)
    case .reply(let id, let text):
      reply(id: id, text: text)
    case .ready(let reported):
      apply(height: reported)
      becomeReady()
    case .resize(let reported):
      apply(height: reported)
    case .settled(let reported):
      apply(height: reported)
      // A document that has settled has loaded, whether or not its ready came first.
      becomeReady()
      settled = true
      WorkSceneMemory.shared.markPlayed(scopeKey)
      captureStillIfNeeded()
    }
  }

  private func apply(height reported: Double?) {
    guard let reported, reported > 0 else { return }
    webView?.scrollView.isScrollEnabled = CGFloat(reported) > WorkSceneLimits.maxHeight
    let next = workSceneClampedHeight(reported)
    WorkSceneMemory.shared.remember(height: next, for: scopeKey)
    if abs(next - height) > 0.5 { height = next }
  }

  private func becomeReady() {
    readyTimer?.invalidate()
    readyTimer = nil
    guard webView != nil, !ready else { return }
    ready = true
    // The appearance changed while the document loaded.
    themeChanged()
    refreshAnswered()
    // Two turns of the run loop for the first paint, then the picture goes.
    DispatchQueue.main.async { [weak self] in
      DispatchQueue.main.async {
        guard let self, self.ready else { return }
        self.container?.revealWebView()
      }
    }
  }

  /// The row's appearance or text size changed.
  fileprivate func themeChanged() {
    guard let container else { return }
    resolvedTheme = nil
    let theme = theme(in: container)
    if webView == nil || !ready {
      // A picture from another theme is never shown.
      container.showStill(currentStill(in: container), covering: true)
      return
    }
    guard frameTheme?.signature != theme.signature else { return }
    frameTheme = theme
    post(.theme(theme))
    // The scene is settled; take its picture again in the new palette.
    if settled {
      _ = timer(after: 0.7) { $0.captureStillIfNeeded() }
    }
  }

  /// A message of the reader's follows this scene: it stops asking.
  fileprivate func refreshAnswered() {
    guard ready, answeredSent == nil, let text = answeredText else { return }
    answeredSent = text
    post(.answered(text: text))
    retakeStillSoon()
  }

  private func retakeStillSoon() {
    _ = timer(after: 0.7) { $0.captureStillIfNeeded(replacing: true) }
  }

  private var answeredText: String? {
    guard let bridge, let messageId else { return nil }
    return bridge.answeredText(afterMessageId: messageId)
  }

  /// Take the scene's picture, for the next time its row comes on screen. One
  /// per scene and palette, unless `replacing`: the page just changed what it
  /// shows (the reader picked or answered), and the old picture would be wrong.
  private func captureStillIfNeeded(replacing: Bool = false) {
    guard let webView, let container, settled, container.isOnScreen,
          let theme = frameTheme, container.bounds.width > 0 else { return }
    let width = container.bounds.width
    guard replacing || WorkSceneMemory.shared.still(for: scopeKey, theme: theme, width: width) == nil else {
      return
    }
    let capturedNonce = nonce
    webView.takeSnapshot(with: nil) { [weak self] image, _ in
      MainActor.assumeIsolated {
        guard let self, let image, self.nonce == capturedNonce,
              self.frameTheme?.signature == theme.signature else { return }
        WorkSceneMemory.shared.remember(still: image, for: self.scopeKey, theme: theme, width: width)
      }
    }
  }

  /// The reader tapped the web view a moment ago. The host sees the tap for
  /// itself; nothing the page says counts.
  private var tappedJustNow: Bool {
    CACurrentMediaTime() - lastTapAt < Self.tapWindow
  }

  private func open(_ raw: String) {
    let now = CACurrentMediaTime()
    guard tappedJustNow, now - lastOpenAt >= WorkSceneLimits.openMinInterval else { return }
    guard let target = workSceneOpenTarget(raw) else {
      notice = "A scene can open ADE links (ade://) and web pages only."
      return
    }
    lastOpenAt = now
    // One link for one tap.
    lastTapAt = 0
    switch target {
    case .deeplink(let url):
      if url.scheme?.lowercased() == "ade" {
        _ = workOpenChipURL(url)
      } else {
        DeepLinkRouter.shared.handle(url)
      }
    case .web(let url):
      UIApplication.shared.open(url)
    }
  }

  /// A scene's reply goes into the prompt box as a draft, under the rule links
  /// follow. Nothing is sent to the agent; the reader sends the draft.
  private func reply(id: String, text: String) {
    func refuse(_ error: String) { post(.picked(id: id, ok: false, error: error)) }
    guard let bridge, bridge.canReply else {
      refuse("This view has no prompt box to reply in.")
      return
    }
    guard answeredSent == nil, answeredText == nil else {
      refuse("The reader already answered this scene.")
      return
    }
    let now = CACurrentMediaTime()
    guard tappedJustNow, now - lastReplyAt >= WorkSceneLimits.replyMinInterval else {
      refuse("A scene replies only in answer to a tap.")
      return
    }
    lastReplyAt = now
    bridge.reply(text)
    post(.picked(id: id, ok: true, error: nil))
    retakeStillSoon()
  }

  /// The one load this web view is allowed: the document it was made for.
  private var initialLoadStarted = false
}

// MARK: Navigation and UI refusals

extension WorkSceneController: WKNavigationDelegate, WKUIDelegate {
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    let url = navigationAction.request.url
    let isBlank = url?.scheme?.lowercased() == "about" && url?.absoluteString.hasPrefix("about:blank") == true
    guard navigationAction.targetFrame?.isMainFrame == true, isBlank else {
      decisionHandler(.cancel)
      return
    }
    if !initialLoadStarted, url?.fragment == nil {
      initialLoadStarted = true
      decisionHandler(.allow)
      return
    }
    // After the first load only a jump inside the page (`#section`) may pass.
    decisionHandler(initialLoadStarted && url?.fragment?.isEmpty == false ? .allow : .cancel)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
  ) {
    decisionHandler(navigationResponse.isForMainFrame ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    guard webView === self.webView, !ready else { return }
    fail("The scene did not load.")
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    // A cancelled navigation the page tried lands here too; only the first
    // load failing is a scene that did not draw.
    guard webView === self.webView, !ready, (error as NSError).code != NSURLErrorCancelled,
          (error as NSError).code != 102 else { return }
    fail("The scene did not load.")
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    guard webView === self.webView else { return }
    crashCount += 1
    if crashCount >= 2 {
      fail("The scene stopped.")
    } else {
      unmount()
      scheduleEvaluate()
    }
  }

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    nil
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable () -> Void
  ) {
    completionHandler()
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
  ) {
    completionHandler(false)
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable (String?) -> Void
  ) {
    completionHandler(nil)
  }

  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
  ) {
    decisionHandler(.deny)
  }

  func webView(
    _ webView: WKWebView,
    requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
  ) {
    decisionHandler(.deny)
  }

  func webView(
    _ webView: WKWebView,
    contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
    completionHandler: @escaping @MainActor @Sendable (UIContextMenuConfiguration?) -> Void
  ) {
    completionHandler(nil)
  }
}

/// The content controller keeps its handler alive; this keeps the handler from
/// keeping the scene alive.
private final class WorkSceneMessageProxy: NSObject, WKScriptMessageHandler {
  private weak var controller: WorkSceneController?

  init(_ controller: WorkSceneController) {
    self.controller = controller
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame else { return }
    let body = message.body
    MainActor.assumeIsolated {
      controller?.receive(body)
    }
  }
}

// MARK: - Container

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

extension WorkSceneController: WorkSceneContainerOwner {
  func containerNoteTap() { noteTap() }
  func containerScheduleEvaluate() { scheduleEvaluate() }
  func containerThemeChanged() { themeChanged() }
  func containerDetach(_ container: WorkSceneContainerView) { detach(container) }
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

private struct WorkSceneContainer: UIViewRepresentable {
  let controller: WorkSceneController
  let parsed: WorkParsedScene
  let messageId: String?
  let bridge: WorkSceneChatBridge?

  func makeUIView(context: Context) -> WorkSceneContainerView {
    controller.update(parsed: parsed, messageId: messageId, bridge: bridge)
    let view = WorkSceneContainerView(controller: controller)
    controller.attach(view)
    return view
  }

  func updateUIView(_ view: WorkSceneContainerView, context: Context) {
    controller.update(parsed: parsed, messageId: messageId, bridge: bridge)
  }

  static func dismantleUIView(_ view: WorkSceneContainerView, coordinator: ()) {
    view.detachFromController()
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

// MARK: - Views

/// A ```scene fence in a message.
///
/// Runs for real. A fence that is still arriving holds a quiet placeholder, and
/// one that does not parse, or is over the size limit, shows as its code — as
/// on desktop.
struct WorkSceneView: View {
  let source: String
  /// The fence is the last block of a message that is still arriving.
  var isStreaming = false

  @Environment(\.workChatSessionId) private var sessionId
  @Environment(\.workSceneMessageId) private var messageId

  var body: some View {
    switch workCachedParsedScene(source) {
    case .failure(let failure):
      VStack(alignment: .leading, spacing: 6) {
        Label("Scene could not be rendered — \(failure.detail)", systemImage: "exclamationmark.circle")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
        WorkCodeBlockView(language: "html", code: source)
      }
    case .success(let parsed):
      let scopeKey = workSceneScopeKey(sessionId: sessionId, messageId: messageId, source: source)
      if isStreaming {
        WorkSceneDrawingPlaceholder(title: parsed.title, scopeKey: scopeKey)
      } else {
        WorkSceneLiveView(source: source, parsed: parsed, scopeKey: scopeKey, messageId: messageId)
          // A reused cell must not hand one scene's web view to another.
          .id(scopeKey)
      }
    }
  }
}

/// Parsing strips document tags with four regular expressions over up to
/// 96 KB; a row's body runs more than once.
private let workParsedSceneCache: NSCache<NSString, WorkParsedSceneBox> = {
  let cache = NSCache<NSString, WorkParsedSceneBox>()
  cache.countLimit = 32
  return cache
}()

private final class WorkParsedSceneBox {
  let value: Result<WorkParsedScene, WorkSceneParseFailure>
  init(_ value: Result<WorkParsedScene, WorkSceneParseFailure>) { self.value = value }
}

private func workCachedParsedScene(_ source: String) -> Result<WorkParsedScene, WorkSceneParseFailure> {
  let key = workStableDigest(source) as NSString
  if let cached = workParsedSceneCache.object(forKey: key) { return cached.value }
  let parsed = workParseSceneFence(source)
  workParsedSceneCache.setObject(WorkParsedSceneBox(parsed), forKey: key)
  return parsed
}

/// A fence that is two lines in is not a broken scene; it is one being drawn.
private struct WorkSceneDrawingPlaceholder: View {
  let title: String?
  let scopeKey: String

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "sparkle")
        .font(.caption2)
        .foregroundStyle(ADEColor.accent)
      Text("\(title ?? "Generated view") · drawing")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .frame(
      maxWidth: .infinity,
      minHeight: WorkSceneMemory.shared.height(for: scopeKey) ?? WorkSceneLimits.minHeight,
      alignment: .bottomLeading
    )
    .background(ADEColor.recessedBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

private struct WorkSceneLiveView: View {
  let source: String
  let parsed: WorkParsedScene
  let scopeKey: String
  let messageId: String?

  @Environment(\.workSceneBridge) private var bridge
  @StateObject private var controller: WorkSceneController
  @State private var showCode = false

  init(source: String, parsed: WorkParsedScene, scopeKey: String, messageId: String?) {
    self.source = source
    self.parsed = parsed
    self.scopeKey = scopeKey
    self.messageId = messageId
    _controller = StateObject(wrappedValue: WorkSceneController(scopeKey: scopeKey))
  }

  private var title: String { parsed.title ?? "Generated view" }

  var body: some View {
    if controller.drawFailed {
      failure
    } else {
      VStack(alignment: .leading, spacing: 4) {
        WorkSceneContainer(controller: controller, parsed: parsed, messageId: messageId, bridge: bridge)
          .frame(maxWidth: .infinity)
          .frame(height: controller.height)
        if let notice = controller.notice {
          Label(notice, systemImage: "exclamationmark.triangle")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(2)
        }
      }
    }
  }

  private var failure: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("\(title) did not draw", systemImage: "exclamationmark.triangle")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      if let notice = controller.notice {
        Text(notice)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(3)
      }
      HStack(spacing: 16) {
        Button("Retry") { controller.retry() }
        Button(showCode ? "Hide code" : "Show code") { showCode.toggle() }
      }
      .font(.caption.weight(.semibold))
      .tint(ADEColor.accent)
      if showCode {
        WorkCodeBlockView(language: "html", code: source)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
}
