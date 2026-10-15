import Foundation
import UIKit

// MCP Apps on the phone: the parts with no web view in them.
//
// An MCP App is a page an MCP server ships with one of its tools. The Mac's
// brain read it, keeps it with the chat, and hands it to the phone through
// `chat.getMcpApp`, already bounded, together with the Content-Security-Policy
// the page must be served with. The phone builds no policy for the page: it
// serves it with exactly the string it was given, or it does not serve it.
//
// Mirrors `apps/desktop/src/shared/mcpApp.ts`. Change both.

enum WorkMcpAppLimits {
  /// The `ade_card` variant an app's transcript row carries.
  static let cardVariant = "mcp_app"
  static let cardIdPrefix = "mcp-app:"
  static let protocolVersion = "2026-01-26"
  /// Characters of one JSON-RPC message the page may post out.
  static let inboundMaxLength = 300_000
  static let messageMaxCharacters = 4_000
  static let openURLMaxLength = 2_048
  static let minHeight: CGFloat = 80
  static let maxHeight: CGFloat = 800
  static let defaultHeight: CGFloat = 220
  static let openMinInterval: TimeInterval = 0.8
  static let messageMinInterval: TimeInterval = 0.15
  /// Requests one page may have with the brain at once; the brain has its own cap.
  static let maxForwardedRequests = 8
  /// A page that has not said `ui/initialize` by now is not going to.
  static let initializeTimeout: TimeInterval = 10
  /// An approval on the Mac side waits three minutes; the phone waits a little longer.
  static let requestTimeoutNanoseconds: UInt64 = 200 * 1_000_000_000
  static let refusedCode = -32000
  static let methodNotFoundCode = -32601
  static let sessionNotRunning = "The chat that created this app is not running."
}

/// The tool call id inside an app card's id (`mcp-app:<tool call id>`).
func workMcpAppItemId(cardId: String) -> String? {
  guard cardId.hasPrefix(WorkMcpAppLimits.cardIdPrefix) else { return nil }
  let itemId = String(cardId.dropFirst(WorkMcpAppLimits.cardIdPrefix.count))
  return itemId.isEmpty ? nil : itemId
}

/// One app, as the brain sent it.
struct WorkMcpApp {
  let sessionId: String
  let itemId: String
  let server: String
  let tool: String
  let toolTitle: String?
  let toolDescription: String?
  /// JSON, passed back to the page as the brain sent it.
  let toolInputSchema: Any
  let html: String
  /// The page's whole policy, built by the brain. Never edited here.
  let contentSecurityPolicy: String
  /// The origins the page may reach, for the row's label only.
  let reachableOrigins: [String]
  let toolInput: [String: Any]
  let toolResult: [String: Any]?
}

enum WorkMcpAppFetch {
  case ready(WorkMcpApp)
  case unavailable(String)
}

/// Read a `chat.getMcpApp` answer. Anything that is not a whole app with a
/// policy is "unavailable": a page with no policy is never shown.
func workParseMcpAppFetch(_ value: Any?) -> WorkMcpAppFetch {
  let fallback = "This app could not be loaded."
  guard let root = value as? [String: Any] else { return .unavailable(fallback) }
  guard (root["status"] as? String) == "ready", let app = root["app"] as? [String: Any] else {
    let reason = (root["reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return .unavailable(reason.isEmpty ? fallback : reason)
  }
  func text(_ key: String) -> String? {
    let value = (app[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return value.isEmpty ? nil : value
  }
  guard let sessionId = text("sessionId"), let itemId = text("itemId"),
        let server = text("server"), let tool = text("tool"),
        let html = app["html"] as? String, !html.isEmpty else {
    return .unavailable(fallback)
  }
  // The policy has to come from the Mac and has to take the page's origin
  // away. Without both, the page does not run on this phone.
  guard let policy = text("contentSecurityPolicy"), workMcpAppPolicyIsUsable(policy) else {
    return .unavailable("This machine's ADE is too old to show apps on the phone.")
  }
  let csp = app["csp"] as? [String: Any] ?? [:]
  let origins = ((csp["connectDomains"] as? [String]) ?? []) + ((csp["resourceDomains"] as? [String]) ?? [])
  var seen = Set<String>()
  let reachable = origins
    .map { $0.replacingOccurrences(of: "^[a-z]+://", with: "", options: .regularExpression) }
    .filter { !$0.isEmpty && seen.insert($0).inserted }
  return .ready(WorkMcpApp(
    sessionId: sessionId,
    itemId: itemId,
    server: server,
    tool: tool,
    toolTitle: text("toolTitle"),
    toolDescription: text("toolDescription"),
    toolInputSchema: app["toolInputSchema"] as? [String: Any] ?? ["type": "object"],
    html: html,
    contentSecurityPolicy: policy,
    reachableOrigins: reachable,
    toolInput: app["toolInput"] as? [String: Any] ?? [:],
    toolResult: app["toolResult"] as? [String: Any]
  ))
}

/// A policy this phone will serve a page with: one header line, closed by
/// default, with the sandbox that makes the page's origin opaque. The phone
/// checks; it does not repair or widen.
func workMcpAppPolicyIsUsable(_ policy: String) -> Bool {
  guard policy.count < 8_000, !policy.contains("\n"), !policy.contains("\r") else { return false }
  let directives = policy
    .split(separator: ";")
    .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
  return directives.contains("default-src 'none'")
    && directives.contains("sandbox allow-scripts")
    && !policy.lowercased().contains("allow-same-origin")
}

// MARK: - Messages from the page

enum WorkMcpAppInbound {
  case request(id: Any, method: String, params: [String: Any])
  case notification(method: String, params: [String: Any])
}

/// Shape-check one message the page posted. The page is untrusted: anything
/// that is not a JSON-RPC 2.0 request or notification is dropped.
func workParseMcpAppInbound(_ body: Any) -> WorkMcpAppInbound? {
  guard let text = body as? String, text.count <= WorkMcpAppLimits.inboundMaxLength,
        let data = text.data(using: .utf8),
        let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        (record["jsonrpc"] as? String) == "2.0",
        let method = record["method"] as? String, !method.isEmpty, method.count <= 120 else {
    return nil
  }
  let params = record["params"] as? [String: Any] ?? [:]
  // A JSON boolean is an NSNumber too; an id is a string or a real number.
  var id: Any?
  if let string = record["id"] as? String, string.count <= 120 {
    id = string
  } else if let number = record["id"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
    id = number
  }
  if let id { return .request(id: id, method: method, params: params) }
  return .notification(method: method, params: params)
}

/// The text of a `ui/message`. The spec draws `content` as one block and the
/// official SDK sends an array of blocks; both are read, and only text counts.
func workMcpAppMessageText(_ params: [String: Any]) -> String? {
  if let role = params["role"] as? String, role != "user" { return nil }
  let blocks: [Any] = (params["content"] as? [Any]) ?? (params["content"].map { [$0] } ?? [])
  let text = blocks
    .compactMap { block -> String? in
      guard let record = block as? [String: Any], (record["type"] as? String) == "text" else { return nil }
      return record["text"] as? String
    }
    .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    .joined(separator: "\n")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !text.isEmpty, text.count <= WorkMcpAppLimits.messageMaxCharacters else { return nil }
  return text
}

/// A web page an app may ask to open: http(s) only, never an ADE link and
/// never a pairing link.
func workMcpAppOpenURL(_ params: [String: Any]) -> URL? {
  guard let raw = (params["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
        !raw.isEmpty, raw.count <= WorkMcpAppLimits.openURLMaxLength,
        case .web(let url)? = workSceneOpenTarget(raw) else { return nil }
  return url
}

func workMcpAppClampedHeight(_ params: [String: Any]) -> CGFloat? {
  guard let number = params["height"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
  let reported = number.doubleValue
  guard reported.isFinite, reported > 0 else { return nil }
  return max(WorkMcpAppLimits.minHeight, min(WorkMcpAppLimits.maxHeight, CGFloat(reported.rounded())))
}

// MARK: - Theme

extension WorkSceneTheme {
  /// The app's colors as the MCP Apps spec's standard CSS variables. Mirrors
  /// `mcpAppStyleVariables` on desktop.
  var mcpAppVariables: [String: String] {
    func tint(_ color: String) -> String { "color-mix(in srgb, \(color) 14%, \(bg))" }
    func px(_ value: Double) -> String {
      let rounded = (value * 10).rounded() / 10
      return rounded == rounded.rounded() ? "\(Int(rounded))px" : String(format: "%.1fpx", rounded)
    }
    let size = fontSize
    return [
      "--color-background-primary": bg,
      "--color-background-secondary": surface,
      "--color-background-tertiary": "color-mix(in srgb, \(fg) 8%, transparent)",
      "--color-background-inverse": fg,
      "--color-background-ghost": "transparent",
      "--color-background-info": tint(accent),
      "--color-background-danger": tint(danger),
      "--color-background-success": tint(success),
      "--color-background-warning": tint(warning),
      "--color-background-disabled": surface,
      "--color-text-primary": fg,
      "--color-text-secondary": fgMuted,
      "--color-text-tertiary": fgMuted,
      "--color-text-inverse": bg,
      "--color-text-info": accent,
      "--color-text-danger": danger,
      "--color-text-success": success,
      "--color-text-warning": warning,
      "--color-text-disabled": fgMuted,
      "--color-text-ghost": fgMuted,
      "--color-border-primary": border,
      "--color-border-secondary": border,
      "--color-border-tertiary": border,
      "--color-border-inverse": fg,
      "--color-border-ghost": "transparent",
      "--color-border-info": accent,
      "--color-border-danger": danger,
      "--color-border-success": success,
      "--color-border-warning": warning,
      "--color-border-disabled": border,
      "--color-ring-primary": accent,
      "--color-ring-secondary": border,
      "--color-ring-inverse": fg,
      "--color-ring-info": accent,
      "--color-ring-danger": danger,
      "--color-ring-success": success,
      "--color-ring-warning": warning,
      "--font-sans": fontSans,
      "--font-mono": fontMono,
      "--font-weight-normal": "400",
      "--font-weight-medium": "500",
      "--font-weight-semibold": "600",
      "--font-weight-bold": "700",
      "--font-text-xs-size": px(size - 2),
      "--font-text-sm-size": px(size - 1),
      "--font-text-md-size": px(size),
      "--font-text-lg-size": px(size + 2),
      "--font-heading-xs-size": px(size),
      "--font-heading-sm-size": px(size + 1),
      "--font-heading-md-size": px(size + 3),
      "--font-heading-lg-size": px(size + 5),
      "--font-heading-xl-size": px(size + 8),
      "--font-heading-2xl-size": px(size + 12),
      "--font-heading-3xl-size": px(size + 17),
      "--font-text-xs-line-height": "1.4",
      "--font-text-sm-line-height": "1.45",
      "--font-text-md-line-height": "1.5",
      "--font-text-lg-line-height": "1.5",
      "--font-heading-xs-line-height": "1.35",
      "--font-heading-sm-line-height": "1.35",
      "--font-heading-md-line-height": "1.3",
      "--font-heading-lg-line-height": "1.25",
      "--font-heading-xl-line-height": "1.2",
      "--font-heading-2xl-line-height": "1.15",
      "--font-heading-3xl-line-height": "1.1",
      "--border-radius-xs": "2px",
      "--border-radius-sm": "4px",
      "--border-radius-md": "6px",
      "--border-radius-lg": "8px",
      "--border-radius-xl": "12px",
      "--border-radius-full": "9999px",
      "--border-width-regular": "1px",
      "--shadow-hairline": "0 0 0 1px \(border)",
      "--shadow-sm": "0 1px 2px rgba(0,0,0,0.12)",
      "--shadow-md": "0 4px 12px rgba(0,0,0,0.16)",
      "--shadow-lg": "0 12px 32px rgba(0,0,0,0.22)",
    ]
  }

  /// The part of the host context that follows the app's appearance.
  var mcpAppContext: [String: Any] {
    ["theme": scheme == "dark" ? "dark" : "light", "styles": ["variables": mcpAppVariables]]
  }
}

// MARK: - The two documents the web view loads

enum WorkMcpAppPages {
  /// The scheme both documents are served on. Private to the app's web views;
  /// no other code in ADE answers it.
  static let scheme = "ade-mcp-app"

  static func shellURL(token: String) -> URL { URL(string: "\(scheme)://shell/\(token)")! }
  static func appURL(token: String) -> URL { URL(string: "\(scheme)://app/\(token)")! }

  /// ADE's own page around the app: one sandboxed frame and nothing else. No
  /// script of its own, and a policy that lets it load that frame only. This
  /// is the phone's policy for the phone's page; the app's page gets the Mac's.
  static let shellPolicy = "default-src 'none'; style-src 'unsafe-inline'; frame-src \(scheme):"

  /// `sandbox="allow-scripts"` with no `allow-same-origin`, as on desktop: the
  /// app's page has an origin of its own and cannot reach this one.
  static func shellDocument(token: String) -> String {
    """
    <!doctype html><html><head><meta charset="utf-8">\
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">\
    <style>html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden}\
    iframe{display:block;border:0;width:100%;height:100%;background:transparent}</style></head>\
    <body><iframe id="app" sandbox="allow-scripts" referrerpolicy="no-referrer" \
    src="\(appURL(token: token).absoluteString)"></iframe></body></html>
    """
  }
}

/// JSON text for a message to the page, or nil when it cannot be encoded.
func workMcpAppJSONText(_ object: [String: Any]) -> String? {
  guard JSONSerialization.isValidJSONObject(object),
        let data = try? JSONSerialization.data(withJSONObject: object),
        let text = String(data: data, encoding: .utf8) else { return nil }
  return text
}

/// A string as a JavaScript string literal.
func workMcpAppJavaScriptString(_ text: String) -> String? {
  guard let data = try? JSONSerialization.data(withJSONObject: [text]),
        let array = String(data: data, encoding: .utf8) else { return nil }
  // `["…"]` without its brackets; U+2028/2029 would end a script line.
  return String(array.dropFirst().dropLast())
    .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
    .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
}
