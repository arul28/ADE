import UIKit
import WebKit

// What every web view that runs code ADE did not write has in common: a scene
// (`WorkSceneView.swift`) and an MCP App (`WorkMcpAppView.swift`). One place for
// the settings that keep such a page in its box, so the two cannot drift.

/// Builds, and takes down, a web view for a page ADE did not write.
@MainActor
enum WorkSandboxedWebView {
  /// On screen this long, with the reader not scrolling, before a web view is
  /// made: a flick past a row makes nothing. Desktop: 120 ms + 150 ms quiet.
  static let activateDelay: TimeInterval = 0.15
  /// Off screen this long before the web view goes. Desktop: 4 s.
  static let lingerDelay: TimeInterval = 4
  /// How long after a tap on the web view the page may open a link, draft a
  /// reply, or have a call sent as "the reader just tapped".
  static let tapWindow: TimeInterval = 1

  /// A configuration that keeps nothing and opens nothing. The caller adds its
  /// own message handler, bridge script and scheme handler.
  static func configuration() -> WKWebViewConfiguration {
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
    return configuration
  }

  /// A web view with every way out closed: UI requests go to
  /// `WorkSandboxedWebViewRefusals`, and the page neither scrolls, zooms,
  /// previews links nor navigates by gesture. The caller decides navigations.
  static func make(
    frame: CGRect,
    configuration: WKWebViewConfiguration,
    navigationDelegate: any WKNavigationDelegate
  ) -> WKWebView {
    let webView = WKWebView(frame: frame, configuration: configuration)
    webView.navigationDelegate = navigationDelegate
    webView.uiDelegate = WorkSandboxedWebViewRefusals.shared
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.underPageBackgroundColor = .clear
    webView.allowsLinkPreview = false
    webView.allowsBackForwardNavigationGestures = false
    let scrollView = webView.scrollView
    scrollView.backgroundColor = .clear
    scrollView.contentInsetAdjustmentBehavior = .never
    scrollView.isScrollEnabled = false
    scrollView.bounces = false
    scrollView.alwaysBounceVertical = false
    scrollView.alwaysBounceHorizontal = false
    scrollView.showsHorizontalScrollIndicator = false
    scrollView.pinchGestureRecognizer?.isEnabled = false
    return webView
  }

  /// Stop the page and cut every tie between it and the host.
  static func tearDown(_ webView: WKWebView, handlerName: String, world: WKContentWorld) {
    webView.stopLoading()
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
    webView.configuration.userContentController.removeAllUserScripts()
    webView.configuration.userContentController.removeScriptMessageHandler(
      forName: handlerName,
      contentWorld: world
    )
  }
}

/// Says no to everything a page can ask the app's UI for: a new window, an
/// alert, a confirm, a prompt, the camera or microphone, motion data, a
/// context menu. It holds no state, so one instance serves every web view.
@MainActor
final class WorkSandboxedWebViewRefusals: NSObject, WKUIDelegate {
  static let shared = WorkSandboxedWebViewRefusals()

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
