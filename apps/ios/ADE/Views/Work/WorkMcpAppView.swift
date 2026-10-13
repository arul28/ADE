import SwiftUI
import UIKit
import WebKit

// MCP Apps on the phone.
//
// An MCP App is a page an MCP server ships with one of its tools: third-party
// code, written by neither ADE nor the agent. It gets what a scene gets and
// one layer more. A `WKWebView` of its own (a separate process, a data store
// that keeps nothing) loads ADE's own one-frame shell, and the app's page runs
// inside that frame: `sandbox="allow-scripts"` with no `allow-same-origin`,
// served with the Content-Security-Policy the Mac built for it. The phone
// builds no policy for the page.
//
// The page talks JSON-RPC to its parent frame. A script in a content world of
// its own passes those messages to this file and nothing else; the page cannot
// see the handler. What the page can get done with them:
//
//   - learn the tool call it belongs to, the app's colors and its own width;
//   - report its height;
//   - ask to open a web page, or to put text in the prompt box: both only
//     right after a real tap on the web view, which the host sees for itself,
//     and the text is a draft the reader sends;
//   - ask for a tool call or a resource read. The request names no server. It
//     goes to the Mac with the chat and the tool call the app came from, and
//     with whether the reader just tapped; the Mac decides everything else
//     (same server only, live session only, and the approval card, which the
//     chat already shows on this phone).
//
// Everything else is refused, as for a scene: every navigation after the two
// loads the host made, new windows, downloads, capture prompts, link previews.

// MARK: - Where apps come from

/// How the row reaches the Mac. A struct of closures so the fixture screen can
/// hand it a file instead of a machine.
struct WorkMcpAppBackend {
  var isAvailable: @MainActor (_ sessionId: String) -> Bool
  var fetch: @MainActor (_ sessionId: String, _ itemId: String) async -> WorkMcpAppFetch
  /// Resolves the JSON-RPC `result`, or throws the refusal to show the page.
  var request: @MainActor (
    _ sessionId: String, _ itemId: String, _ method: String, _ params: [String: Any], _ userActivated: Bool
  ) async -> Result<Any, WorkMcpAppRefusal>

  @MainActor static var live: WorkMcpAppBackend {
    #if DEBUG
    if let fixture = WorkMcpAppBackend.fixture { return fixture }
    #endif
    return WorkMcpAppBackend(
      isAvailable: { sessionId in
        SyncService.shared?.supportsMcpApps(sessionId: sessionId) == true
      },
      fetch: { sessionId, itemId in
        guard let sync = SyncService.shared else { return .unavailable("This phone is not connected to a machine.") }
        do {
          return try await sync.fetchMcpApp(sessionId: sessionId, itemId: itemId)
        } catch {
          return .unavailable(error.localizedDescription)
        }
      },
      request: { sessionId, itemId, method, params, userActivated in
        guard let sync = SyncService.shared else {
          return .failure(WorkMcpAppRefusal(message: "This phone is not connected to a machine."))
        }
        return await sync.sendMcpAppRequest(
          sessionId: sessionId, itemId: itemId, method: method, params: params, userActivated: userActivated
        )
      }
    )
  }

  #if DEBUG
  /// `-adeBenchMcpApp <path>`: a saved `chat.getMcpApp` answer, for the
  /// fixture screens, which have no machine. Calls answer as a chat with no
  /// running session does.
  @MainActor static let fixture: WorkMcpAppBackend? = {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "-adeBenchMcpApp"),
          arguments.index(after: index) < arguments.endIndex else { return nil }
    let path = arguments[arguments.index(after: index)]
    return WorkMcpAppBackend(
      isAvailable: { _ in true },
      fetch: { _, _ in
        guard let data = FileManager.default.contents(atPath: path) else {
          return .unavailable("No app document at the fixture path.")
        }
        return workParseMcpAppFetch(try? JSONSerialization.jsonObject(with: data))
      },
      request: { _, _, _, _, _ in
        .failure(WorkMcpAppRefusal(message: WorkMcpAppLimits.sessionNotRunning))
      }
    )
  }()
  #endif
}

struct WorkMcpAppRefusal: Error {
  var code: Int = WorkMcpAppLimits.refusedCode
  let message: String
}

/// Apps this phone already has, by chat and tool call: a row comes back every
/// time it scrolls on screen, and a page is up to a megabyte. In memory only.
@MainActor
private enum WorkMcpAppCache {
  private final class Box { let app: WorkMcpApp; init(_ app: WorkMcpApp) { self.app = app } }
  private static let apps: NSCache<NSString, Box> = {
    let cache = NSCache<NSString, Box>()
    cache.countLimit = 4
    return cache
  }()
  private static var heights: [String: CGFloat] = [:]

  static func app(_ key: String) -> WorkMcpApp? { apps.object(forKey: key as NSString)?.app }
  static func remember(_ app: WorkMcpApp, for key: String) { apps.setObject(Box(app), forKey: key as NSString) }
  static func forget(_ key: String) { apps.removeObject(forKey: key as NSString) }
  static func height(_ key: String) -> CGFloat? { heights[key] }
  static func remember(height: CGFloat, for key: String) {
    if heights.count > 256 { heights.removeAll(keepingCapacity: true) }
    heights[key] = height
  }
}

// MARK: - Controller

/// One app: its web view while its row is on screen, and what the page asks for.
@MainActor
final class WorkMcpAppController: NSObject, ObservableObject {
  enum Phase: Equatable {
    case waiting
    case loading
    case ready
    case unavailable(String)
  }

  @Published private(set) var phase: Phase = .waiting
  @Published private(set) var height: CGFloat
  /// The last thing the host has to say about the page, for the line under it.
  @Published private(set) var notice: String?
  /// The origins the page may reach, once it is loaded.
  @Published private(set) var reachableOrigins: [String] = []

  let sessionId: String
  let itemId: String
  private let key: String
  private let backend: WorkMcpAppBackend
  private weak var bridge: WorkSceneChatBridge?
  private weak var container: WorkSceneContainerView?

  private var app: WorkMcpApp?
  private var webView: WKWebView?
  private var schemeHandler: WorkMcpAppSchemeHandler?
  private var token: String?
  private var shellLoadStarted = false
  private var appLoadStarted = false
  private var initialized = false
  /// Bumped per web view, so an answer for the last page never reaches the next.
  private var generation = 0
  private var forwarded = 0
  private var sentThemeSignature: String?
  private var sentWidth: CGFloat = 0
  private var crashCount = 0

  private var evaluateScheduled = false
  private var activateTimer: Timer?
  private var lingerTimer: Timer?
  private var initializeTimer: Timer?
  private var fetchTask: Task<Void, Never>?

  private var lastTapAt: CFTimeInterval = 0
  private var lastOpenAt: CFTimeInterval = 0
  private var lastMessageAt: CFTimeInterval = 0

  /// The scene rules: on screen and still before a web view is made, and four
  /// seconds off screen before it goes.
  private static let activateDelay: TimeInterval = 0.15
  private static let lingerDelay: TimeInterval = 4
  /// How long after a tap on the web view the page may open a link, draft a
  /// message, or have a call sent as "the reader just tapped".
  private static let tapWindow: TimeInterval = 1
  private static let bridgeWorld = WKContentWorld.world(name: "adeMcpAppBridge")
  private static let handlerName = "adeMcpApp"

  /// Runs in the shell page, in its own content world: the app's page is in
  /// another frame and another origin and cannot see any of it. It passes on
  /// only what the app's own frame posted, as bounded JSON text, and the host
  /// validates every field again.
  private static let bridgeScript = """
  (function () {
    var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName);
    if (!handler) return;
    function frame() { return document.getElementById("app"); }
    window.addEventListener("message", function (event) {
      var app = frame();
      if (!app || event.source !== app.contentWindow) return;
      var text;
      try { text = JSON.stringify(event.data); } catch (e) { return; }
      if (typeof text !== "string" || text.length > \(WorkMcpAppLimits.inboundMaxLength)) return;
      handler.postMessage(text);
    }, true);
    window.__adeMcpAppPost = function (text) {
      var app = frame();
      if (!app || !app.contentWindow) return false;
      try { app.contentWindow.postMessage(JSON.parse(text), "*"); } catch (e) { return false; }
      return true;
    };
  })();
  """

  init(sessionId: String, itemId: String, backend: WorkMcpAppBackend) {
    self.sessionId = sessionId
    self.itemId = itemId
    self.key = "\(sessionId)|\(itemId)"
    self.backend = backend
    self.height = WorkMcpAppCache.height("\(sessionId)|\(itemId)") ?? WorkMcpAppLimits.defaultHeight
    super.init()
  }

  func update(bridge: WorkSceneChatBridge?) {
    self.bridge = bridge
  }

  // MARK: On screen

  fileprivate func attach(_ container: WorkSceneContainerView) {
    self.container = container
    scheduleEvaluate()
  }

  private func scheduleEvaluate() {
    guard !evaluateScheduled else { return }
    evaluateScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.evaluateScheduled = false
      self.evaluate()
    }
  }

  private var isUnavailable: Bool {
    if case .unavailable = phase { return true }
    return false
  }

  private func evaluate() {
    guard let container, !isUnavailable else { return }
    if container.isOnScreen {
      lingerTimer?.invalidate()
      lingerTimer = nil
      guard webView == nil, activateTimer == nil else { return }
      activateTimer = timer(after: Self.activateDelay) { $0.activate() }
    } else {
      activateTimer?.invalidate()
      activateTimer = nil
      guard webView != nil, lingerTimer == nil else { return }
      lingerTimer = timer(after: Self.lingerDelay) { controller in
        controller.lingerTimer = nil
        // An approval can take a minute: the answer needs a page to come back to.
        if controller.container?.isOnScreen != true, controller.forwarded == 0 { controller.unmount() }
      }
    }
  }

  private func activate() {
    activateTimer = nil
    guard let container, container.isOnScreen, webView == nil, !isUnavailable else { return }
    if container.isReaderScrolling {
      activateTimer = timer(after: Self.activateDelay) { $0.activate() }
      return
    }
    if let app = app ?? WorkMcpAppCache.app(key) {
      self.app = app
      mount(app, in: container)
      return
    }
    guard fetchTask == nil else { return }
    phase = .loading
    fetchTask = Task { [weak self] in
      guard let self else { return }
      let fetched = await self.backend.fetch(self.sessionId, self.itemId)
      self.fetchTask = nil
      switch fetched {
      case .unavailable(let reason):
        self.phase = .unavailable(reason)
      case .ready(let app):
        WorkMcpAppCache.remember(app, for: self.key)
        self.app = app
        self.reachableOrigins = app.reachableOrigins
        self.scheduleEvaluate()
      }
    }
  }

  private func timer(after delay: TimeInterval, _ fire: @escaping @MainActor @Sendable (WorkMcpAppController) -> Void) -> Timer {
    let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        fire(self)
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    return timer
  }

  // MARK: Web view

  private func mount(_ app: WorkMcpApp, in container: WorkSceneContainerView) {
    guard webView == nil, let page = app.html.data(using: .utf8) else { return }
    let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let handler = WorkMcpAppSchemeHandler(
      shellURL: WorkMcpAppPages.shellURL(token: token),
      shell: Data(WorkMcpAppPages.shellDocument(token: token).utf8),
      appURL: WorkMcpAppPages.appURL(token: token),
      page: page,
      // The Mac's string, as it came.
      pagePolicy: app.contentSecurityPolicy
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
    configuration.setURLSchemeHandler(handler, forURLScheme: WorkMcpAppPages.scheme)
    // Exactly one handler, in the bridge's own world, and only in the shell.
    configuration.userContentController.add(
      WorkMcpAppMessageProxy(self),
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
    // The row is as tall as the page says it is, so the shell never scrolls
    // and every vertical swipe belongs to the feed.
    scrollView.isScrollEnabled = false
    scrollView.bounces = false
    scrollView.alwaysBounceVertical = false
    scrollView.alwaysBounceHorizontal = false
    scrollView.showsHorizontalScrollIndicator = false
    scrollView.pinchGestureRecognizer?.isEnabled = false

    generation += 1
    self.webView = webView
    self.schemeHandler = handler
    self.token = token
    shellLoadStarted = false
    appLoadStarted = false
    initialized = false
    forwarded = 0
    sentThemeSignature = nil
    sentWidth = 0
    notice = nil
    phase = .ready
    reachableOrigins = app.reachableOrigins
    container.showStill(nil, covering: false)
    container.install(webView, hidden: false)
    webView.load(URLRequest(url: WorkMcpAppPages.shellURL(token: token)))

    initializeTimer?.invalidate()
    initializeTimer = timer(after: WorkMcpAppLimits.initializeTimeout) { controller in
      controller.initializeTimer = nil
      if !controller.initialized { controller.notice = "This app has not started." }
    }
  }

  private func unmount() {
    activateTimer?.invalidate()
    activateTimer = nil
    lingerTimer?.invalidate()
    lingerTimer = nil
    initializeTimer?.invalidate()
    initializeTimer = nil
    guard let webView else { return }
    if initialized {
      post(["id": "ade-teardown-\(generation)", "method": "ui/resource-teardown", "params": ["reason": "The app scrolled out of view."]])
    }
    self.webView = nil
    schemeHandler = nil
    token = nil
    initialized = false
    forwarded = 0
    generation += 1
    webView.stopLoading()
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
    webView.configuration.userContentController.removeAllUserScripts()
    webView.configuration.userContentController.removeScriptMessageHandler(
      forName: Self.handlerName,
      contentWorld: Self.bridgeWorld
    )
    container?.remove(webView)
  }

  private func fail(_ message: String) {
    unmount()
    phase = .unavailable(message)
  }

  /// Start over from the line under the row: a fresh fetch and a fresh web view.
  func retry() {
    unmount()
    WorkMcpAppCache.forget(key)
    app = nil
    notice = nil
    crashCount = 0
    phase = .waiting
    scheduleEvaluate()
  }

  /// Send one JSON-RPC message to the app's frame, through the shell's bridge.
  private func post(_ message: [String: Any]) {
    var message = message
    message["jsonrpc"] = "2.0"
    guard let webView, let text = workMcpAppJSONText(message),
          let literal = workMcpAppJavaScriptString(text) else { return }
    webView.evaluateJavaScript(
      "window.__adeMcpAppPost && window.__adeMcpAppPost(\(literal));",
      in: nil,
      in: Self.bridgeWorld,
      completionHandler: nil
    )
  }

  private func refuse(_ id: Any, _ message: String, code: Int = WorkMcpAppLimits.refusedCode) {
    post(["id": id, "error": ["code": code, "message": message]])
  }

  // MARK: What the page says

  /// The reader tapped the web view a moment ago. The host sees the tap for
  /// itself; nothing the page says counts.
  private var tappedJustNow: Bool {
    CACurrentMediaTime() - lastTapAt < Self.tapWindow
  }

  private var hostContext: [String: Any] {
    guard let app, let container else { return [:] }
    let theme = WorkSceneTheme.resolved(for: container.traitCollection)
    sentThemeSignature = theme.signature
    sentWidth = container.bounds.width
    var tool: [String: Any] = ["name": app.tool, "inputSchema": app.toolInputSchema]
    if let title = app.toolTitle { tool["title"] = title }
    if let description = app.toolDescription { tool["description"] = description }
    var context = theme.mcpAppContext
    context["toolInfo"] = ["id": app.itemId, "tool": tool]
    context["displayMode"] = "inline"
    context["availableDisplayModes"] = ["inline"]
    context["containerDimensions"] = [
      "width": Int(container.bounds.width.rounded()),
      "maxHeight": Int(WorkMcpAppLimits.maxHeight),
    ]
    context["locale"] = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
    context["timeZone"] = TimeZone.current.identifier
    context["userAgent"] = "ADE"
    context["platform"] = "mobile"
    context["deviceCapabilities"] = ["touch": true, "hover": false]
    return context
  }

  fileprivate func receive(_ body: Any) {
    guard webView != nil, let app, let inbound = workParseMcpAppInbound(body) else { return }
    switch inbound {
    case .notification(let method, let params):
      if method == "ui/notifications/initialized" {
        guard !initialized else { return }
        initialized = true
        initializeTimer?.invalidate()
        initializeTimer = nil
        notice = nil
        // The spec's order: the input, then the result.
        post(["method": "ui/notifications/tool-input", "params": ["arguments": app.toolInput]])
        if let result = app.toolResult {
          post(["method": "ui/notifications/tool-result", "params": result])
        }
      } else if method == "ui/notifications/size-changed", let next = workMcpAppClampedHeight(params) {
        WorkMcpAppCache.remember(height: next, for: key)
        if abs(next - height) > 0.5 { height = next }
      }
      // Log lines and anything else an app announces are dropped.
    case .request(let id, let method, let params):
      switch method {
      case "ui/initialize":
        post(["id": id, "result": [
          "protocolVersion": WorkMcpAppLimits.protocolVersion,
          "hostInfo": ["name": "ADE", "version": "1"],
          "hostCapabilities": [
            "openLinks": [String: Any](),
            "serverTools": [String: Any](),
            "serverResources": [String: Any](),
            "logging": [String: Any](),
          ],
          "hostContext": hostContext,
        ] as [String: Any]])
      case "ping":
        post(["id": id, "result": [String: Any]()])
      case "ui/open-link":
        openLink(id: id, params: params)
      case "ui/message":
        draftMessage(id: id, params: params)
      case "ui/request-display-mode":
        post(["id": id, "result": ["mode": "inline"]])
      case "tools/call", "resources/read":
        forward(id: id, method: method, params: params)
      default:
        refuse(id, "ADE does not support this request from an app.", code: WorkMcpAppLimits.methodNotFoundCode)
      }
    }
  }

  private func openLink(id: Any, params: [String: Any]) {
    guard let url = workMcpAppOpenURL(params) else {
      refuse(id, "An app can open web pages (http or https) only.")
      return
    }
    let now = CACurrentMediaTime()
    guard tappedJustNow, now - lastOpenAt >= WorkMcpAppLimits.openMinInterval else {
      refuse(id, "An app opens a link only in answer to a tap.")
      return
    }
    lastOpenAt = now
    // One link for one tap.
    lastTapAt = 0
    UIApplication.shared.open(url)
    post(["id": id, "result": [String: Any]()])
  }

  /// A draft in the prompt box, under the rule links follow. Nothing is sent
  /// to the agent; the reader sends the draft.
  private func draftMessage(id: Any, params: [String: Any]) {
    guard let text = workMcpAppMessageText(params) else {
      refuse(id, "A message needs text, as the user.")
      return
    }
    guard let bridge, bridge.canReply else {
      refuse(id, "This view has no prompt box to put a message in.")
      return
    }
    let now = CACurrentMediaTime()
    guard tappedJustNow, now - lastMessageAt >= WorkMcpAppLimits.messageMinInterval else {
      refuse(id, "An app adds a message only in answer to a tap.")
      return
    }
    lastMessageAt = now
    bridge.reply(text)
    post(["id": id, "result": [String: Any]()])
  }

  private func forward(id: Any, method: String, params: [String: Any]) {
    guard forwarded < WorkMcpAppLimits.maxForwardedRequests else {
      refuse(id, "This app has too many requests running.")
      return
    }
    // Read NOW, as the request arrives: the Mac runs a tool that may change
    // data only when this is true. Only a tool call can use it.
    let userActivated = method == "tools/call" && tappedJustNow
    let sentGeneration = generation
    forwarded += 1
    Task { [weak self] in
      guard let self else { return }
      let outcome = await self.backend.request(self.sessionId, self.itemId, method, params, userActivated)
      // A different page is in the web view now; the answer is nobody's.
      guard sentGeneration == self.generation else { return }
      self.forwarded = max(0, self.forwarded - 1)
      switch outcome {
      case .success(let result):
        let empty: [String: Any] = [:]
        let safe: Any = JSONSerialization.isValidJSONObject(["r": result]) ? result : empty
        self.post(["id": id, "result": safe])
      case .failure(let refusal):
        self.refuse(id, refusal.message, code: refusal.code)
      }
      self.scheduleEvaluate()
    }
  }

  /// The row's appearance or text size changed while the app is up.
  private func themeChanged() {
    guard initialized, let container else { return }
    let theme = WorkSceneTheme.resolved(for: container.traitCollection)
    guard theme.signature != sentThemeSignature else { return }
    sentThemeSignature = theme.signature
    post(["method": "ui/notifications/host-context-changed", "params": theme.mcpAppContext])
  }
}

extension WorkMcpAppController: WorkSceneContainerOwner {
  func containerNoteTap() { lastTapAt = CACurrentMediaTime() }

  func containerScheduleEvaluate() {
    scheduleEvaluate()
    // Runs on every scroll frame: a width compare, and nothing else, here.
    if initialized, let width = container?.bounds.width, width > 0, abs(width - sentWidth) >= 1 {
      sentWidth = width
      post(["method": "ui/notifications/host-context-changed", "params": [
        "containerDimensions": ["width": Int(width.rounded()), "maxHeight": Int(WorkMcpAppLimits.maxHeight)],
      ]])
    }
  }

  func containerThemeChanged() { themeChanged() }

  func containerDetach(_ container: WorkSceneContainerView) {
    guard self.container === container else { return }
    fetchTask?.cancel()
    fetchTask = nil
    unmount()
    self.container = nil
  }
}

// MARK: Navigation and UI refusals

extension WorkMcpAppController: WKNavigationDelegate, WKUIDelegate {
  /// Two loads, both the host's own: the shell in the main frame, and the
  /// app's page in the shell's one frame. Nothing else, ever: not a reload, not
  /// a link, not the app's frame sending itself somewhere.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    guard webView === self.webView, let token, let url = navigationAction.request.url,
          let target = navigationAction.targetFrame else {
      decisionHandler(.cancel)
      return
    }
    if target.isMainFrame, !shellLoadStarted, url == WorkMcpAppPages.shellURL(token: token) {
      shellLoadStarted = true
      decisionHandler(.allow)
      return
    }
    if !target.isMainFrame, shellLoadStarted, !appLoadStarted, url == WorkMcpAppPages.appURL(token: token) {
      appLoadStarted = true
      decisionHandler(.allow)
      return
    }
    decisionHandler(.cancel)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
  ) {
    // Only the two documents the scheme handler serves are ever shown.
    decisionHandler(navigationResponse.response.url?.scheme == WorkMcpAppPages.scheme ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    guard webView === self.webView, !initialized else { return }
    fail("This app did not load.")
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    // A navigation the page tried and the host cancelled lands here too.
    guard webView === self.webView, !initialized, (error as NSError).code != NSURLErrorCancelled,
          (error as NSError).code != 102 else { return }
    fail("This app did not load.")
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    guard webView === self.webView else { return }
    crashCount += 1
    if crashCount >= 2 {
      fail("This app stopped.")
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

/// Serves the web view's two documents from memory, each with its own policy
/// as a real response header: the shell with ADE's, the app's page with the
/// Mac's. Any other URL on the scheme fails.
private final class WorkMcpAppSchemeHandler: NSObject, WKURLSchemeHandler {
  private let shellURL: URL
  private let shell: Data
  private let appURL: URL
  private let page: Data
  private let pagePolicy: String

  init(shellURL: URL, shell: Data, appURL: URL, page: Data, pagePolicy: String) {
    self.shellURL = shellURL
    self.shell = shell
    self.appURL = appURL
    self.page = page
    self.pagePolicy = pagePolicy
  }

  func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
    guard let url = urlSchemeTask.request.url else {
      urlSchemeTask.didFailWithError(URLError(.badURL))
      return
    }
    let body: Data
    let policy: String
    if url == shellURL {
      body = shell
      policy = WorkMcpAppPages.shellPolicy
    } else if url == appURL {
      body = page
      policy = pagePolicy
    } else {
      urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
      return
    }
    guard let response = HTTPURLResponse(
      url: url,
      statusCode: 200,
      httpVersion: "HTTP/1.1",
      headerFields: [
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(body.count),
        "Content-Security-Policy": policy,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      ]
    ) else {
      urlSchemeTask.didFailWithError(URLError(.cannotParseResponse))
      return
    }
    urlSchemeTask.didReceive(response)
    urlSchemeTask.didReceive(body)
    urlSchemeTask.didFinish()
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}

/// The content controller keeps its handler alive; this keeps the handler from
/// keeping the app alive.
private final class WorkMcpAppMessageProxy: NSObject, WKScriptMessageHandler {
  private weak var controller: WorkMcpAppController?

  init(_ controller: WorkMcpAppController) {
    self.controller = controller
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    // The bridge script runs in the shell only: the main frame.
    guard message.frameInfo.isMainFrame else { return }
    let body = message.body
    MainActor.assumeIsolated {
      controller?.receive(body)
    }
  }
}

// MARK: - Views

private struct WorkMcpAppContainer: UIViewRepresentable {
  let controller: WorkMcpAppController
  let bridge: WorkSceneChatBridge?

  func makeUIView(context: Context) -> WorkSceneContainerView {
    controller.update(bridge: bridge)
    let view = WorkSceneContainerView(controller: controller)
    controller.attach(view)
    return view
  }

  func updateUIView(_ view: WorkSceneContainerView, context: Context) {
    controller.update(bridge: bridge)
  }

  static func dismantleUIView(_ view: WorkSceneContainerView, coordinator: ()) {
    view.detachFromController()
  }
}

/// An `mcp_app` card in a chat's transcript.
///
/// Runs the app where this phone can reach it. Where it cannot (a machine
/// whose ADE does not serve apps to phones, a personal chat), the card's own
/// fallback text stands, as for any card this build does not know.
struct WorkMcpAppCardView: View {
  let card: WorkAdeCardModel

  @Environment(\.workChatSessionId) private var sessionId

  var body: some View {
    let backend = WorkMcpAppBackend.live
    if let sessionId, let itemId = workMcpAppItemId(cardId: card.id), backend.isAvailable(sessionId) {
      WorkMcpAppLiveView(card: card, sessionId: sessionId, itemId: itemId, backend: backend)
        // A reused cell must not hand one app's web view to another.
        .id("\(sessionId)|\(itemId)")
    } else {
      VStack(alignment: .leading, spacing: 4) {
        WorkMcpAppLabel(title: card.title, server: card.subtitle, reachable: [])
        Text(card.fallbackText)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}

/// Always shown, and outside the web view: what this is and whose page it is.
/// A page can draw anything, including something that looks like ADE.
private struct WorkMcpAppLabel: View {
  let title: String
  let server: String?
  let reachable: [String]

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: "macwindow")
        .font(.caption2)
        .foregroundStyle(ADEColor.accent)
      Text("\(title) · app from \(server ?? "an MCP server")")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
      if let first = reachable.first {
        Label(
          reachable.count > 1 ? "can reach \(first) +\(reachable.count - 1)" : "can reach \(first)",
          systemImage: "globe"
        )
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted.opacity(0.75))
        .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}

private struct WorkMcpAppLiveView: View {
  let card: WorkAdeCardModel

  @Environment(\.workSceneBridge) private var bridge
  @StateObject private var controller: WorkMcpAppController

  init(card: WorkAdeCardModel, sessionId: String, itemId: String, backend: WorkMcpAppBackend) {
    self.card = card
    _controller = StateObject(wrappedValue: WorkMcpAppController(sessionId: sessionId, itemId: itemId, backend: backend))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      WorkMcpAppLabel(title: card.title, server: card.subtitle, reachable: controller.reachableOrigins)
      if case .unavailable(let reason) = controller.phase {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Label(reason, systemImage: "exclamationmark.triangle")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(3)
          Button("Retry") { controller.retry() }
            .font(.caption.weight(.semibold))
            .tint(ADEColor.accent)
        }
      } else {
        WorkMcpAppContainer(controller: controller, bridge: bridge)
          .frame(maxWidth: .infinity)
          .frame(height: controller.height)
          .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .strokeBorder(ADEColor.border, lineWidth: 1)
          )
        if let notice = controller.notice {
          HStack(spacing: 10) {
            Label(notice, systemImage: "exclamationmark.triangle")
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(2)
            Button("Reload") { controller.retry() }
              .font(.caption2.weight(.semibold))
              .tint(ADEColor.accent)
          }
        }
      }
    }
  }
}
