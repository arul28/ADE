import Foundation
import UIKit

// Scenes: the parts with no view in them.
//
// A scene is a ```scene fence of HTML, CSS and JS an agent wrote. Desktop owns
// the format and the document it runs in (`apps/desktop/src/shared/chatScene.ts`
// and `chatSceneDocument.ts`). This file mirrors the fence parser and the
// message protocol, and fills the document shell that desktop's own builder
// produced (`Resources/SceneShell.html`). It writes no markup of its own.
//
// Regenerate the shell after a change to the desktop sources:
//
//   node apps/desktop/scripts/generate-ios-scene-shell.mjs

// MARK: - Limits

/// Mirrors `SCENE_LIMITS`, `SCENE_REPLY_MAX_CHARS` and `SceneFrame`'s height
/// clamp on desktop.
enum WorkSceneLimits {
  static let maxSourceBytes = 96_000
  static let maxTitleLength = 120
  static let readyTimeout: TimeInterval = 8
  static let replyMaxCharacters = 4_000
  static let openURLMaxLength = 2_048
  static let errorMaxLength = 500
  static let nonceMaxLength = 120
  /// Longest message the bridge passes from the page, as JSON text.
  static let inboundMaxLength = 65_536
  static let reportedHeightMax: Double = 4_000
  static let minHeight: CGFloat = 120
  static let maxHeight: CGFloat = 960
  /// The height a scene holds before it has reported one.
  static let defaultHeight: CGFloat = 220
  /// The least time between two links a scene may open, and two replies.
  static let openMinInterval: TimeInterval = 0.8
  static let replyMinInterval: TimeInterval = 0.15
}

/// Clamp a reported content height the way desktop's `SceneFrame` does.
func workSceneClampedHeight(_ reported: Double) -> CGFloat {
  max(WorkSceneLimits.minHeight, min(WorkSceneLimits.maxHeight, CGFloat(reported)))
}

// MARK: - Fence parsing

/// The live ADE sources a scene may name on its marker line. Mirrors
/// `SCENE_DATA_SOURCES`. iOS reads them and sends none yet: such a scene gets
/// `ade.data = null` and draws its own empty state.
let workSceneDataSources = ["lanes", "sessions", "prs"]

struct WorkParsedScene: Equatable {
  let title: String?
  /// The agent's markup, unwrapped from any document tags it supplied.
  let html: String
  let data: [String]
}

enum WorkSceneParseFailure: Equatable {
  case empty
  case tooLarge

  var detail: String {
    switch self {
    case .empty: return "Scene has no markup."
    case .tooLarge: return "Scene exceeds \(WorkSceneLimits.maxSourceBytes) bytes."
    }
  }
}

private func workSceneRegex(_ pattern: String) -> NSRegularExpression {
  // Every pattern here is a literal; a failure is a programming error.
  // swiftlint:disable:next force_try
  try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
}

private let workSceneMarkerRegex = workSceneRegex("^\\s*<!--\\s*@scene\\b([^>]*?)-->\\s*$")
private let workSceneAttributeRegex = workSceneRegex("(\\w+)\\s*=\\s*\"([^\"]*)\"")
private let workSceneDocumentWrapperRegex = workSceneRegex([
  "<!doctype[^>]*>",
  "</?(?:html|head|body)(?:\\s[^>]*)?>",
  "<base(?:\\s[^>]*)?>",
  "<meta[^>]+http-equiv\\s*=\\s*[\"']?content-security-policy[\"']?[^>]*>",
].joined(separator: "|"))
private let workSceneVerbatimRegionRegex = workSceneRegex(
  "<script\\b[\\s\\S]*?</script\\s*>|<style\\b[\\s\\S]*?</style\\s*>|<!--[\\s\\S]*?-->"
)

struct WorkSceneMarker: Equatable {
  var title: String?
  var data: [String] = []
  /// Index of the first line of markup, after blank lines and the marker.
  var bodyStartLine = 0
}

/// Read the leading `<!-- @scene title="…" data="…" -->` line.
///
/// Mirrors the marker half of desktop `parseSceneFence`: blank lines are
/// skipped, and only the FIRST non-blank line may be the marker.
func workSceneMarker(lines: [Substring]) -> WorkSceneMarker {
  var marker = WorkSceneMarker()
  for (index, rawLine) in lines.enumerated() {
    if rawLine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      marker.bodyStartLine = index + 1
      continue
    }
    let line = String(rawLine) as NSString
    let whole = NSRange(location: 0, length: line.length)
    if let match = workSceneMarkerRegex.firstMatch(in: line as String, range: whole) {
      let rest = line.substring(with: match.range(at: 1)) as NSString
      var attributes: [String: String] = [:]
      for attribute in workSceneAttributeRegex.matches(
        in: rest as String,
        range: NSRange(location: 0, length: rest.length)
      ) {
        attributes[rest.substring(with: attribute.range(at: 1)).lowercased()] =
          rest.substring(with: attribute.range(at: 2))
      }
      let title = (attributes["title"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if !title.isEmpty {
        marker.title = String(title.prefix(WorkSceneLimits.maxTitleLength))
      }
      if let raw = attributes["data"] {
        let asked = Set(
          raw.lowercased()
            .split(whereSeparator: { $0 == "," || $0.isWhitespace })
            .map(String.init)
        )
        marker.data = workSceneDataSources.filter(asked.contains)
      }
      marker.bodyStartLine = index + 1
    }
    break
  }
  return marker
}

/// Models write anything from a bare `<div>` to a full document. Drop the
/// document furniture (doctype, html/head/body tags, `<base>`, a policy meta)
/// so the host shell owns `<head>` and the policy in it. The strip runs only
/// OUTSIDE script, style and comment bodies, as on desktop.
private func workSceneUnwrapDocument(_ source: String) -> String {
  let text = source as NSString
  var out = ""
  var cursor = 0
  func stripped(_ range: NSRange) -> String {
    let slice = text.substring(with: range)
    return workSceneDocumentWrapperRegex.stringByReplacingMatches(
      in: slice,
      range: NSRange(location: 0, length: (slice as NSString).length),
      withTemplate: ""
    )
  }
  for region in workSceneVerbatimRegionRegex.matches(
    in: source,
    range: NSRange(location: 0, length: text.length)
  ) {
    out += stripped(NSRange(location: cursor, length: region.range.location - cursor))
    out += text.substring(with: region.range)
    cursor = region.range.location + region.range.length
  }
  out += stripped(NSRange(location: cursor, length: text.length - cursor))
  return out.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Mirrors desktop `parseSceneFence`.
func workParseSceneFence(_ source: String) -> Result<WorkParsedScene, WorkSceneParseFailure> {
  if source.utf8.count > WorkSceneLimits.maxSourceBytes {
    return .failure(.tooLarge)
  }
  let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
  let marker = workSceneMarker(lines: lines)
  let html = workSceneUnwrapDocument(lines.dropFirst(marker.bodyStartLine).joined(separator: "\n"))
  if html.isEmpty { return .failure(.empty) }
  return .success(WorkParsedScene(title: marker.title, html: html, data: marker.data))
}

extension WorkSceneParseFailure: Error {}

// MARK: - Theme

/// The palette a scene is handed. Mirrors `SceneTheme`. Every value is written
/// both into a CSS declaration and into a JSON string in the shell, so each is
/// held to characters that are inert in both (see `workSceneSafeThemeValue`).
struct WorkSceneTheme: Equatable {
  var bg: String
  var surface: String
  var border: String
  var fg: String
  var fgMuted: String
  var accent: String
  var success: String
  var warning: String
  var danger: String
  var fontSans: String
  var fontMono: String
  /// `dark` or `light`.
  var scheme: String
  var fontSize: Double

  /// The CSS custom properties a theme becomes. Mirrors `sceneThemeVariables`.
  var variables: [[String]] {
    [
      ["--bg", bg],
      ["--surface", surface],
      ["--border", border],
      ["--fg", fg],
      ["--fg-muted", fgMuted],
      ["--accent", accent],
      ["--success", success],
      ["--warning", warning],
      ["--danger", danger],
      ["--font-sans", fontSans],
      ["--font-mono", fontMono],
      ["--font-size", "\(fontSizeText)px"],
    ]
  }

  var fontSizeText: String {
    let rounded = (fontSize * 10).rounded() / 10
    return rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
  }

  /// Equal exactly when two themes would draw a scene identically.
  var signature: String {
    (variables.map { $0[1] } + [scheme]).joined(separator: "|")
  }

  /// `ade.theme` inside the page.
  var jsonObject: [String: Any] {
    [
      "bg": bg, "surface": surface, "border": border, "fg": fg, "fgMuted": fgMuted,
      "accent": accent, "success": success, "warning": warning, "danger": danger,
      "fontSans": fontSans, "fontMono": fontMono, "scheme": scheme,
      "fontSize": (fontSize * 10).rounded() / 10,
    ]
  }

  /// The app's colors, resolved for one appearance and text size.
  static func resolved(for traits: UITraitCollection) -> WorkSceneTheme {
    func css(_ color: UIColor, alpha override: CGFloat? = nil) -> String {
      var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
      color.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
      func channel(_ value: CGFloat) -> Int { Int((max(0, min(1, value)) * 255).rounded()) }
      let opacity = max(0, min(1, override ?? alpha))
      return String(
        format: "rgba(%d, %d, %d, %.3f)",
        channel(red), channel(green), channel(blue), Double(opacity)
      )
    }
    let fg = UIColor(ADEColor.textPrimary)
    // Desktop: the transcript's prose size, times 13/14.
    let prose = UIFont.preferredFont(forTextStyle: .callout, compatibleWith: traits).pointSize
    return WorkSceneTheme(
      bg: css(UIColor(workChatCanvasBackground)),
      // Desktop: the foreground at 4%, a raised fill that works on any canvas.
      surface: css(fg, alpha: 0.04),
      border: css(UIColor(ADEColor.border)),
      fg: css(fg),
      fgMuted: css(UIColor(ADEColor.textMuted)),
      accent: css(UIColor(ADEColor.accent)),
      success: css(UIColor(ADEColor.success)),
      warning: css(UIColor(ADEColor.warning)),
      danger: css(UIColor(ADEColor.danger)),
      fontSans: "-apple-system, system-ui, sans-serif",
      fontMono: "ui-monospace, Menlo, monospace",
      scheme: traits.userInterfaceStyle == .dark ? "dark" : "light",
      fontSize: (Double(prose) * 13 / 14 * 10).rounded() / 10
    )
  }
}

/// Keep a theme value to characters that cannot end a CSS declaration, a JSON
/// string or a `<script>`: letters, digits, space and `# ( ) , . % -`.
func workSceneSafeThemeValue(_ value: String) -> String {
  String(value.unicodeScalars.filter { scalar in
    switch scalar {
    case "a"..."z", "A"..."Z", "0"..."9", " ", "#", "(", ")", ",", ".", "%", "-":
      return true
    default:
      return false
    }
  })
}

// MARK: - Document shell

/// The document `buildSceneDocument` produced, cut at the tokens Swift fills.
struct WorkSceneShell {
  enum Piece: Equatable {
    case literal(String)
    case token(String)
  }

  let pieces: [Piece]

  /// Every token the generator writes (`generate-ios-scene-shell.mjs`).
  static let knownTokens: Set<String> = [
    "BODY", "NONCE", "RESTORED", "SCHEME", "FONT_SIZE", "BG", "SURFACE", "BORDER", "FG",
    "FG_MUTED", "ACCENT", "SUCCESS", "WARNING", "DANGER", "FONT_SANS", "FONT_MONO",
  ]

  /// Nil when the text holds a token this build does not know, or lacks one it
  /// needs: a stale shell must fail closed, never load half-filled.
  init?(text: String) {
    // swiftlint:disable:next force_try
    let regex = try! NSRegularExpression(pattern: "@@ADE_IOS:([A-Z_]+)@@")
    let source = text as NSString
    var pieces: [Piece] = []
    var seen = Set<String>()
    var cursor = 0
    for match in regex.matches(in: text, range: NSRange(location: 0, length: source.length)) {
      let name = source.substring(with: match.range(at: 1))
      guard Self.knownTokens.contains(name) else { return nil }
      seen.insert(name)
      pieces.append(.literal(source.substring(
        with: NSRange(location: cursor, length: match.range.location - cursor)
      )))
      pieces.append(.token(name))
      cursor = match.range.location + match.range.length
    }
    pieces.append(.literal(source.substring(from: cursor)))
    guard seen == Self.knownTokens else { return nil }
    self.pieces = pieces
  }

  /// The shell in the app bundle, read once.
  static let bundled: WorkSceneShell? = {
    guard let url = Bundle.main.url(forResource: "SceneShell", withExtension: "html"),
          let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    return WorkSceneShell(text: text)
  }()

  /// The document for one scene.
  ///
  /// `html` is the agent's markup and goes in exactly as desktop places it:
  /// after `<body>`, inside a document whose first `<head>` element is the
  /// policy. Each token is filled once, from the shell's own text, so markup
  /// that happens to spell a token is never filled in turn.
  func document(html: String, theme: WorkSceneTheme, nonce: String, restored: Bool) -> String {
    let values: [String: String] = [
      "BODY": html,
      "NONCE": String(nonce.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }),
      "RESTORED": restored ? "true" : "false",
      "SCHEME": theme.scheme == "light" ? "light" : "dark",
      "FONT_SIZE": theme.fontSizeText,
      "BG": workSceneSafeThemeValue(theme.bg),
      "SURFACE": workSceneSafeThemeValue(theme.surface),
      "BORDER": workSceneSafeThemeValue(theme.border),
      "FG": workSceneSafeThemeValue(theme.fg),
      "FG_MUTED": workSceneSafeThemeValue(theme.fgMuted),
      "ACCENT": workSceneSafeThemeValue(theme.accent),
      "SUCCESS": workSceneSafeThemeValue(theme.success),
      "WARNING": workSceneSafeThemeValue(theme.warning),
      "DANGER": workSceneSafeThemeValue(theme.danger),
      "FONT_SANS": workSceneSafeThemeValue(theme.fontSans),
      "FONT_MONO": workSceneSafeThemeValue(theme.fontMono),
    ]
    var out = ""
    out.reserveCapacity(48_000 + html.utf8.count)
    for piece in pieces {
      switch piece {
      case .literal(let text): out += text
      case .token(let name): out += values[name] ?? ""
      }
    }
    return out
  }
}

// MARK: - Messages from the page

/// A message the page may send. Mirrors `SceneHostMessage`; anything else is
/// dropped by `workParseSceneInboundMessage`.
enum WorkSceneInboundMessage: Equatable {
  case ready(height: Double?)
  case resize(height: Double?)
  case settled(height: Double?)
  case emit(name: String)
  case error(message: String, policy: Bool)
  case open(url: String)
  case reply(id: String, text: String)
}

struct WorkSceneInboundEnvelope: Equatable {
  /// The sending document's id; nil when it sent none.
  let nonce: String?
  let message: WorkSceneInboundMessage
}

/// Validate one message from the page. Mirrors `parseSceneHostMessage`: the
/// page is untrusted, so every field is shape-checked and every string bounded.
///
/// `body` is what the bridge script posted: the message as JSON text.
func workParseSceneInboundMessage(_ body: Any) -> WorkSceneInboundEnvelope? {
  guard let text = body as? String,
        text.utf16.count <= WorkSceneLimits.inboundMaxLength,
        let data = text.data(using: .utf8),
        let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  else { return nil }
  // `1`, and not `true`: JSON booleans arrive as NSNumber too.
  guard let marker = record["__adeScene"] as? NSNumber,
        CFGetTypeID(marker) != CFBooleanGetTypeID(),
        marker.doubleValue == 1,
        let type = record["type"] as? String
  else { return nil }
  let payload = record["payload"] as? [String: Any] ?? [:]
  let rawNonce = (record["nonce"] as? String).map { String($0.prefix(WorkSceneLimits.nonceMaxLength)) } ?? ""
  let nonce = rawNonce.isEmpty ? nil : rawNonce

  func envelope(_ message: WorkSceneInboundMessage) -> WorkSceneInboundEnvelope {
    WorkSceneInboundEnvelope(nonce: nonce, message: message)
  }
  var height: Double? {
    guard let number = payload["height"] as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite else { return nil }
    return max(0, min(WorkSceneLimits.reportedHeightMax, number.doubleValue.rounded()))
  }

  switch type {
  case "ready": return envelope(.ready(height: height))
  case "resize": return envelope(.resize(height: height))
  case "settled": return envelope(.settled(height: height))
  case "emit":
    let name = String((payload["name"] as? String ?? "").prefix(120))
    return name.isEmpty ? nil : envelope(.emit(name: name))
  case "error":
    let message = (payload["message"] as? String).map { String($0.prefix(WorkSceneLimits.errorMaxLength)) }
      ?? "scene error"
    let policy = (payload["policy"] as? NSNumber).map {
      CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue
    } ?? false
    return envelope(.error(message: message, policy: policy))
  case "open":
    let url = (payload["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !url.isEmpty, url.utf16.count <= WorkSceneLimits.openURLMaxLength else { return nil }
    return envelope(.open(url: url))
  case "reply":
    let id = String((payload["id"] as? String ?? "").prefix(40))
    let text = (payload["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !id.isEmpty, !text.isEmpty, text.utf16.count <= WorkSceneLimits.replyMaxCharacters else {
      return nil
    }
    return envelope(.reply(id: id, text: text))
  default:
    return nil
  }
}

// MARK: - Messages to the page

/// A message the host sends. Mirrors `SceneFrameInbound`, minus `data`: iOS
/// sends a scene no live ADE data.
enum WorkSceneOutboundMessage {
  case theme(WorkSceneTheme)
  case picked(id: String, ok: Bool, error: String?)
  case answered(text: String)

  var jsonObject: [String: Any] {
    switch self {
    case .theme(let theme):
      return ["type": "theme", "payload": ["theme": theme.jsonObject, "variables": theme.variables]]
    case .picked(let id, let ok, let error):
      var payload: [String: Any] = ["id": id, "ok": ok]
      if let error { payload["error"] = error }
      return ["type": "picked", "payload": payload]
    case .answered(let text):
      return ["type": "answered", "payload": ["text": text]]
    }
  }

  /// The script that delivers this message. The page is the top-level
  /// document, so its `window.parent` is itself, and the SDK accepts a message
  /// whose source is that window.
  var script: String? {
    var envelope = jsonObject
    envelope["__adeSceneHost"] = 1
    guard let data = try? JSONSerialization.data(withJSONObject: envelope),
          let json = String(data: data, encoding: .utf8) else { return nil }
    // Legal in JSON, line terminators in older JS source.
    let safe = json
      .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
      .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    return "window.postMessage(\(safe), \"*\");"
  }
}

// MARK: - Links

/// Where a scene's `open` may go.
enum WorkSceneOpenTarget: Equatable {
  /// An ADE link, for the app's own router.
  case deeplink(URL)
  /// A web page, for the system browser.
  case web(URL)
}

/// Sort a URL a scene asked to open. Nil for anything that is not an ADE link
/// or a web page, and for a pairing link: a scene shows and asks, and pairing
/// this phone with a machine is neither.
func workSceneOpenTarget(_ raw: String) -> WorkSceneOpenTarget? {
  guard let url = URL(string: raw),
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
        let scheme = components.scheme?.lowercased() else { return nil }
  if scheme == "ade" {
    return url.host?.lowercased() == "pair" ? nil : .deeplink(url)
  }
  guard scheme == "https" || scheme == "http", components.host?.isEmpty == false else { return nil }
  if scheme == "https", ADEDeepLinkURLParsing.isADEWebHost(components.host) {
    if components.path == "/pair" || components.path.hasSuffix("/pair") { return nil }
    if components.path == "/open" { return .deeplink(url) }
  }
  return .web(url)
}

// MARK: - Identity

/// What one scene's remembered height, picture and "already played" mark are
/// filed under: the chat, the message, and the scene's own source, so two
/// scenes in one message never share them.
func workSceneScopeKey(sessionId: String?, messageId: String?, source: String) -> String {
  "\(sessionId ?? "")|\(messageId ?? "")|\(workStableDigest(source))"
}
