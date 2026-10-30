import SwiftUI
import UIKit

// MARK: - Smart links

func workSmartLinkPathParts(_ components: URLComponents) -> [String] {
  components.path.split(separator: "/").map(String.init)
}

private func workSmartLinkLinearIdentifier(_ components: URLComponents) -> String? {
  let parts = workSmartLinkPathParts(components)
  guard let issueIndex = parts.firstIndex(where: { $0.caseInsensitiveCompare("issue") == .orderedSame }),
        parts.indices.contains(issueIndex + 1)
  else { return nil }
  let identifier = parts[issueIndex + 1].uppercased()
  guard identifier.range(of: "^[A-Z][A-Z0-9]+-[0-9]+$", options: .regularExpression) != nil else {
    return nil
  }
  return identifier
}

private func workSmartLinkIsAsciiNumber(_ value: String) -> Bool {
  !value.isEmpty && value.unicodeScalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
}

struct WorkSmartLink: Equatable {
  enum Provider: Equatable {
    case github
    case linear
    case ade
    case web
  }

  let url: String
  let range: NSRange
  let provider: Provider

  var compactLabel: String {
    guard let components = URLComponents(string: url) else { return url }
    let parts = workSmartLinkPathParts(components)
    switch provider {
    case .github:
      guard parts.count >= 2 else { return url }
      let repo = parts[1].lowercased().hasSuffix(".git") ? String(parts[1].dropLast(4)) : parts[1]
      let repoLabel = "\(parts[0])/\(repo)"
      let section = parts.indices.contains(2) ? parts[2].lowercased() : ""
      if parts.count >= 4,
         (section == "pull" || section == "issues"),
         workSmartLinkIsAsciiNumber(parts[3]) {
        return "\(repoLabel)#\(parts[3])"
      }
      if parts.count >= 4, section == "commit" { return "\(repoLabel)@\(parts[3].prefix(7))" }
      if parts.count >= 5, section == "actions", parts[3].lowercased() == "runs" {
        return "\(repoLabel) · run \(parts[4])"
      }
      return repoLabel
    case .linear:
      return workSmartLinkLinearIdentifier(components) ?? url
    case .ade:
      // A recognised shape gets its typed label; anything else keeps the
      // original descriptive form, because "ADE · lane/25f280a4/session/abc"
      // tells the reader far more than a bare "ADE link".
      if let typed = WorkSmartLink.adeDeeplinkLabel(
        host: components.host,
        parts: parts,
        lineQueryValue: WorkSmartLink.lineQueryValue(in: components)
      ) {
        return typed
      }
      let target = ([components.host].compactMap { $0 } + parts).joined(separator: "/")
      return target.isEmpty ? "ADE link" : "ADE · \(target)"
    case .web:
      return url
    }
  }

  /// What this link points at, mirroring the desktop's shared chip model
  /// (`apps/desktop/src/shared/chips.ts`). A pull request is one kind whether it
  /// arrived as a github.com URL or an `ade://pr/...` deeplink, so both draw the
  /// same pill on every surface.
  enum Kind: Equatable {
    case pullRequest
    case issue
    case repository
    case commit
    case branch
    case actionsRun
    case linearIssue
    case lane
    case chat
    case terminal
    case file
    /// A directory. A distinct kind on purpose, exactly as on the desktop: the
    /// glyph and what a tap means both differ from a file's.
    case folder
    case artifact
    case webPage
    /// A model with a thinking level and a permission mode (`@model:<id>?…`).
    case model
    /// A provider permission mode an agent named, e.g. `bypassPermissions`.
    case permission
    /// A slash command or skill this chat can run, e.g. `/quality`.
    case skill
    /// A browser tab attached to a chat message.
    case browserTab
    /// An `ade://` URL this build cannot parse — a newer ADE minted it.
    case adeLink
    /// An `@mac:<machineKey>` mention: one of the account's machines.
    case machine
    /// A server in the ADE MCP registry.
    case mcp
    /// An `[Image #k]` attachment token: the k-th image the message carries.
    case image
    /// One card in the desktop's Settings (`ade://settings/<id>`).
    case setting
    /// A desktop page from the open list (`ade://open/<place>`).
    case place

    /// Single-cell glyphs, matching `CHIP_GLYPH` on the desktop.
    var glyph: String {
      switch self {
      case .pullRequest: return "⇄"
      case .issue: return "◉"
      case .repository: return "▣"
      case .commit: return "◆"
      case .branch: return "⑂"
      case .actionsRun: return "⚙"
      case .linearIssue: return "L"
      case .lane: return "◫"
      case .chat: return "💬"
      case .terminal: return "▶"
      case .file: return "📄"
      case .folder: return "📁"
      case .artifact: return "◈"
      case .webPage: return "↗"
      case .model: return "✦"
      case .permission: return "⛨"
      case .skill: return "/"
      case .browserTab: return "🌐"
      case .adeLink: return "A"
      case .machine: return "▢"
      case .mcp: return "⚙"
      case .image: return "🖼"
      case .setting: return "⚙"
      case .place: return "↪"
      }
    }

    /// The SF Symbol a composer pill or an @-menu row draws for this kind. The
    /// glyph above stays the text form (copy, accessibility, sent bubbles).
    var symbolName: String {
      switch self {
      case .pullRequest: return "arrow.triangle.pull"
      case .issue: return "smallcircle.filled.circle"
      case .repository: return "book.closed"
      case .commit: return "smallcircle.circle"
      case .branch: return "arrow.triangle.branch"
      case .actionsRun: return "gearshape"
      case .linearIssue: return "circle.dashed"
      case .lane: return "square.stack.3d.up"
      case .chat: return "bubble.left.and.bubble.right"
      case .terminal: return "terminal"
      case .file: return "doc.text"
      case .folder: return "folder"
      case .artifact: return "shippingbox"
      case .webPage: return "globe"
      case .model: return "sparkles"
      case .permission: return "lock.shield"
      case .skill: return "slash.circle"
      case .browserTab: return "safari"
      case .adeLink: return "link"
      case .machine: return "desktopcomputer"
      case .mcp: return "point.3.connected.trianglepath.dotted"
      case .image: return "photo"
      case .setting: return "gearshape"
      case .place: return "arrow.right.circle"
      }
    }
  }

  /// Short, favicon-less label for a composer pill: a web page reads as its
  /// host, every typed link keeps its compact label.
  var pillLabel: String {
    guard kind == .webPage else { return compactLabel }
    guard let host = URLComponents(string: url)?.host, !host.isEmpty else { return url }
    let lowered = host.lowercased()
    return lowered.hasPrefix("www.") ? String(lowered.dropFirst(4)) : lowered
  }

  var kind: Kind {
    guard let components = URLComponents(string: url) else { return .webPage }
    let parts = workSmartLinkPathParts(components)
    switch provider {
    case .github:
      let section = parts.indices.contains(2) ? parts[2].lowercased() : ""
      if parts.count >= 4, section == "pull", workSmartLinkIsAsciiNumber(parts[3]) { return .pullRequest }
      if parts.count >= 4, section == "issues", workSmartLinkIsAsciiNumber(parts[3]) { return .issue }
      if parts.count >= 4, section == "commit" { return .commit }
      if parts.count >= 5, section == "actions", parts[3].lowercased() == "runs" { return .actionsRun }
      return .repository
    case .linear:
      return .linearIssue
    case .ade:
      return WorkSmartLink.adeDeeplinkKind(
        host: components.host,
        parts: parts,
        lineQueryValue: WorkSmartLink.lineQueryValue(in: components)
      ) ?? .adeLink
    case .web:
      return .webPage
    }
  }

  /// `ade://` links carry a precise target. Rendering every one of them as
  /// "ADE · pr/owner/repo/1237" threw that away, so an ADE link to a pull
  /// request looked nothing like the github.com link to the same pull request.
  private static func adeSegments(host: String?, parts: [String]) -> [String] {
    ([host].compactMap { $0 } + parts).filter { !$0.isEmpty }
  }

  /// Shape validation mirroring `parseDeeplink` on the desktop
  /// (`apps/desktop/src/shared/deeplinks.ts`). Matching on the leading segment
  /// alone was too loose: `ade://lane/<not-a-uuid>/session/abc` would report
  /// itself as a plain lane link and drop the rest of the path, while the
  /// desktop rejects that same URL outright. Both surfaces must agree, or one
  /// chip means two things.
  private static func isUuid(_ value: String) -> Bool {
    UUID(uuidString: value) != nil
  }

  private static func isCommitSha(_ value: String) -> Bool {
    let hex = CharacterSet(charactersIn: "0123456789abcdefABCDEF")
    return (7...40).contains(value.count)
      && value.unicodeScalars.allSatisfy { hex.contains($0) }
  }

  private static func isLinearIdentifier(_ value: String) -> Bool {
    let parts = value.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return false }
    let key = parts[0]
    guard key.count <= 10, key.first?.isLetter == true,
          key.allSatisfy({ $0.isLetter || $0.isNumber }) else { return false }
    return workSmartLinkIsAsciiNumber(String(parts[1]))
  }

  /// The raw `line` query value, distinguishing "absent" from "present but
  /// empty". A valueless `?line` flattens to nil in `URLQueryItem`, which would
  /// read as absent — while the desktop's `searchParams.get("line")` returns ""
  /// and rejects the whole link. Present-without-a-value therefore maps to "".
  static func lineQueryValue(in components: URLComponents) -> String? {
    guard let item = components.queryItems?.first(where: { $0.name == "line" }) else { return nil }
    return item.value ?? ""
  }

  /// 1-15 ASCII digits, value >= 1, returned as the parsed number — the exact
  /// rule `parseNonNegativeIntParam` applies before `buildFileTarget` accepts a
  /// `?line=`. Returns nil when the desktop would reject the whole link.
  static func parsedFileLine(_ raw: String?) -> Int? {
    guard let raw, (1...15).contains(raw.count), workSmartLinkIsAsciiNumber(raw) else { return nil }
    guard let value = Int(raw), value >= 1 else { return nil }
    return value
  }

  static func adeDeeplinkKind(host: String?, parts: [String], lineQueryValue: String? = nil) -> Kind? {
    let segments = adeSegments(host: host, parts: parts)
    guard let head = segments.first?.lowercased() else { return nil }
    switch head {
    // ade://pr/<owner>/<repo>/<number>. The number-only form is deliberately
    // NOT accepted: parseDeeplink rejects it as malformed, and a chip that
    // resolves on one surface and not the other is the bug this mirrors away.
    case "pr":
      return segments.count == 4 && workSmartLinkIsAsciiNumber(segments[3]) ? .pullRequest : nil
    case "lane":
      return segments.count == 2 && isUuid(segments[1]) ? .lane : nil
    case "session":
      return segments.count == 2 && !segments[1].isEmpty ? .chat : nil
    // A repo-relative path legitimately contains slashes, so this one is
    // open-ended — but a PRESENT-and-invalid `?line=` makes the desktop reject
    // the whole link, so it cannot stay a typed file chip here either.
    case "file":
      guard segments.count >= 2 else { return nil }
      if let raw = lineQueryValue, parsedFileLine(raw) == nil { return nil }
      return .file
    case "commit":
      return segments.count == 2 && isCommitSha(segments[1]) ? .commit : nil
    case "artifact":
      return segments.count == 2 && !segments[1].isEmpty ? .artifact : nil
    // ade://repo/<owner>/<repo>/branch/<branch>. The branch may contain slashes —
    // ADE's own lane branches look like `ade/t3gap-…` — so everything after the
    // `branch` segment is the name, exactly as the desktop parser joins it.
    case "repo":
      return segments.count >= 5 && segments[3].lowercased() == "branch" ? .branch : nil
    case "linear-issue":
      return segments.count == 2 && isLinearIdentifier(segments[1]) ? .linearIssue : nil
    // Only ids this build's catalog knows: an unknown one stays a generic ADE
    // link, exactly as on the desktop.
    case "settings":
      return segments.count == 2 && WorkSettingsCatalog.settings[segments[1].lowercased()] != nil ? .setting : nil
    case "open":
      return segments.count == 2 && WorkSettingsCatalog.places[segments[1].lowercased()] != nil ? .place : nil
    default:
      return nil
    }
  }

  /// Only labels a URL whose shape `adeDeeplinkKind` already accepted, so a
  /// malformed link never gets a confident-looking label.
  static func adeDeeplinkLabel(host: String?, parts: [String], lineQueryValue: String? = nil) -> String? {
    let segments = adeSegments(host: host, parts: parts)
    guard let kind = adeDeeplinkKind(host: host, parts: parts, lineQueryValue: lineQueryValue) else { return nil }
    func shortId(_ value: String) -> String { String(value.prefix(8)) }
    switch kind {
    case .pullRequest: return "#\(segments[3])"
    case .lane: return "Lane \(shortId(segments[1]))"
    case .chat: return "Chat \(shortId(segments[1]))"
    case .file:
      let path = segments.dropFirst().joined(separator: "/")
      let name = path.split(separator: "/").last.map(String.init) ?? path
      // `?line=` is part of the label on the desktop (`name:42`); dropping it
      // here made the same link read differently on the two surfaces.
      // Mirrors parseNonNegativeIntParam + buildFileTarget exactly: 1-15 ASCII
      // digits, value >= 1, and the LABEL uses the parsed number so `007`
      // renders as `:7`. An invalid line makes the desktop reject the whole
      // link, so this must not label one the desktop refuses to type at all —
      // the kind check consults `parsedFileLine` too.
      if let line = WorkSmartLink.parsedFileLine(lineQueryValue) {
        return "\(name):\(line)"
      }
      return name
    case .commit: return String(segments[1].prefix(7))
    case .artifact: return "Artifact \(shortId(segments[1]))"
    case .branch: return segments[4...].joined(separator: "/")
    case .linearIssue: return segments[1].uppercased()
    case .setting: return WorkSettingsCatalog.settings[segments[1].lowercased()]?.path
    case .place: return WorkSettingsCatalog.places[segments[1].lowercased()]
    default:
      return nil
    }
  }
}

enum WorkSmartLinkDetector {
  private static let regex = try! NSRegularExpression(
    pattern: "(?:https?://|ade://)[^\\s<>\\\"'`]+",
    options: [.caseInsensitive]
  )
  private static let trailingPunctuation = CharacterSet(charactersIn: ".,;:!?")
  private static let balancedTrailingCharacters: [Character: Character] = [")": "(", "]": "[", "}": "{"]

  private static func trimmedRange(_ initialRange: NSRange, in text: NSString) -> NSRange {
    var range = initialRange
    while range.length > 0 {
      let final = text.substring(with: NSRange(location: NSMaxRange(range) - 1, length: 1))
      if final.unicodeScalars.allSatisfy({ trailingPunctuation.contains($0) }) {
        range.length -= 1
        continue
      }
      guard let close = final.first,
            let open = balancedTrailingCharacters[close]
      else { break }
      let candidate = text.substring(with: range)
      let opens = candidate.filter { $0 == open }.count
      let closes = candidate.filter { $0 == close }.count
      guard closes > opens else { break }
      range.length -= 1
    }
    return range
  }

  static func links(in text: NSString) -> [WorkSmartLink] {
    let fullRange = NSRange(location: 0, length: text.length)
    return regex.matches(in: text as String, range: fullRange).compactMap { match in
      let range = trimmedRange(match.range, in: text)
      guard range.length > 0 else { return nil }
      let url = text.substring(with: range)
      guard let components = URLComponents(string: url),
            let scheme = components.scheme?.lowercased(),
            scheme == "ade" || ((scheme == "http" || scheme == "https") && components.host?.isEmpty == false)
      else { return nil }
      let host = components.host?.lowercased()
      let provider: WorkSmartLink.Provider
      if scheme == "ade" {
        provider = .ade
      } else if host == "github.com" {
        provider = .github
      } else if host == "linear.app", workSmartLinkLinearIdentifier(components) != nil {
        provider = .linear
      } else {
        provider = .web
      }
      return WorkSmartLink(url: url, range: range, provider: provider)
    }
  }

  static func atomicDeletionRange(in text: NSString, range: NSRange, replacementText: String) -> NSRange? {
    guard replacementText.isEmpty, range.length > 0 else { return nil }
    let intersected = links(in: text).filter { NSIntersectionRange($0.range, range).length > 0 }
    guard !intersected.isEmpty else { return nil }
    if range.length == 1, let link = intersected.first { return link.range }
    let start = intersected.reduce(range.location) { min($0, $1.range.location) }
    let end = intersected.reduce(NSMaxRange(range)) { max($0, NSMaxRange($1.range)) }
    return NSRange(location: start, length: end - start)
  }
}

// MARK: - Chat mentions

/// Swift twin of the `@chat:` / `@lane:` / `@term:` / `@pr:` / `@mac:` grammar
/// in `apps/desktop/src/shared/chatMentions.ts`.
///
/// A mention is a POINTER, never an attachment: the token is the canonical text
/// and the label is display only, so the same draft round-trips through the
/// desktop composer and this app without changing meaning.
struct WorkChatMention: Equatable {
  enum Kind: Equatable, CaseIterable {
    case chat
    case lane
    case terminal
    /// An ADE pull request, by its internal id (not the GitHub number).
    case pullRequest
    /// One of the account's machines, by machine key. Read-only by contract:
    /// the expansion tells the agent it may only read from it.
    case machine
    case mcp

    /// Token prefix per kind. `term` and `mac` are deliberately short for
    /// typing, matching `CHAT_MENTION_TOKEN_PREFIX` on the desktop.
    var tokenPrefix: String {
      switch self {
      case .chat: return "chat"
      case .lane: return "lane"
      case .terminal: return "term"
      case .pullRequest: return "pr"
      case .machine: return "mac"
      case .mcp: return "mcp"
      }
    }

    static func from(tokenPrefix: String) -> Kind? {
      switch tokenPrefix {
      case "chat": return .chat
      case "lane": return .lane
      case "term": return .terminal
      case "pr": return .pullRequest
      case "mac": return .machine
      case "mcp": return .mcp
      default: return nil
      }
    }

    /// The `kind` string `chat.listMentionSuggestions` reports for this kind.
    static func from(suggestionKind: String) -> Kind? {
      switch suggestionKind.lowercased() {
      case "chat": return .chat
      case "lane": return .lane
      case "terminal": return .terminal
      case "pr": return .pullRequest
      case "machine": return .machine
      case "mcp": return .mcp
      default: return nil
      }
    }

    /// The shared chip kind this mention produces. `@lane:<id>` and
    /// `ade://lane/<id>` are the same pill; only the token differs.
    var chipKind: WorkSmartLink.Kind {
      switch self {
      case .chat: return .chat
      case .lane: return .lane
      case .terminal: return .terminal
      case .pullRequest: return .pullRequest
      case .machine: return .machine
      case .mcp: return .mcp
      }
    }
  }

  let kind: Kind
  let id: String
  /// The matched token text, e.g. `@chat:abc123`.
  let token: String
  let range: NSRange

  /// `defaultMentionLabel` in `chips.ts`: the first 8 characters of the id, so
  /// a mention is legible with no network access and no host lookup.
  var defaultLabel: String {
    let short = String(id.prefix(8))
    switch kind {
    case .chat: return "Chat \(short)"
    case .lane: return "Lane \(short)"
    case .terminal: return "Terminal \(short)"
    case .pullRequest: return "PR \(short)"
    case .machine: return "Machine \(short)"
    case .mcp: return "MCP \(id)"
    }
  }
}

enum WorkChatMentionDetector {
  /// Serialize one mention into its chip/draft token form.
  static func formatToken(kind: WorkChatMention.Kind, id: String) -> String {
    "@\(kind.tokenPrefix):\(id)"
  }

  // Character-for-character the desktop's `MENTION_TOKEN_SOURCE`. Ids are
  // opaque (uuids, slugs); `:` is excluded so the prefix split is unambiguous,
  // and the token must sit at a word boundary so emails and `foo@chat:bar`
  // substrings never match.
  private static let regex = try! NSRegularExpression(
    pattern: "(?:^|[\\s(\\[{,])@(chat|lane|term|pr|mac|mcp):([A-Za-z0-9._-]+)",
    options: []
  )

  /// Every mention token in `text`, in document order.
  static func mentions(in text: NSString) -> [WorkChatMention] {
    guard text.length > 0, text.range(of: "@").location != NSNotFound else { return [] }
    let full = NSRange(location: 0, length: text.length)
    return regex.matches(in: text as String, range: full).compactMap { match in
      guard match.numberOfRanges == 3 else { return nil }
      let prefix = text.substring(with: match.range(at: 1))
      guard let kind = WorkChatMention.Kind.from(tokenPrefix: prefix) else { return nil }
      let id = text.substring(with: match.range(at: 2))
      let token = "@\(prefix):\(id)"
      // match[0] may include one leading boundary char; anchor on the `@`.
      let start = NSMaxRange(match.range) - (token as NSString).length
      return WorkChatMention(
        kind: kind,
        id: id,
        token: token,
        range: NSRange(location: start, length: (token as NSString).length)
      )
    }
  }
}

// MARK: - Model mentions

/// Swift twin of the `@model:` grammar in
/// `apps/desktop/src/shared/modelMentions.ts`.
///
/// A model chip names a model, a thinking level, and a permission mode in one
/// token: `@model:<registry-id>?effort=<level>&perm=<mode>`. `effort` and
/// `perm` are optional. The token is the canonical text; the label is display
/// only, and the brain expands the token into exact CLI flags at send time.
struct WorkModelMention: Equatable {
  let modelId: String
  let effort: String?
  let permission: String?
  /// The matched token text.
  let token: String
  let range: NSRange

  /// `modelMentionChipLabel`: `DeepSeek V4.1 Flash · High · Full auto`.
  func chipLabel(displayName: String) -> String {
    var parts = [displayName]
    if let effort, !effort.isEmpty { parts.append(WorkModelMentionDetector.effortLabel(effort)) }
    let provider = WorkModelMentionDirectory.shared.entry(for: modelId)?.provider
    parts.append(WorkModelMentionDetector.permissionLabel(permission, provider: provider))
    return parts.joined(separator: " · ")
  }

  /// The catalog name when this device has seen the model, else the last
  /// segment of the id, like `chipFromModelMention` on the desktop.
  var displayName: String {
    WorkModelMentionDirectory.shared.entry(for: modelId)?.title
      ?? modelId.split(separator: "/").last.map(String.init)
      ?? modelId
  }
}

enum WorkModelMentionDetector {
  /// `MODEL_MENTION_PERMISSION_MODES`, in menu order. Kept for callers that
  /// have no provider; new UI uses `permissionOptions(provider:)`.
  static let permissionModes = ["default", "auto", "plan", "edit", "full-auto"]
  static let defaultPermission = "default"

  /// A provider's own permission modes, mirroring `shared/modelPermissions.ts`
  /// and the desktop footer's option lists.
  struct PermissionOption: Equatable {
    let value: String
    let label: String
  }

  static func permissionOptions(provider: String?) -> [PermissionOption] {
    switch (provider ?? "").lowercased() {
    case "claude":
      return [
        PermissionOption(value: "default", label: "Manual"),
        PermissionOption(value: "auto", label: "Auto"),
        PermissionOption(value: "acceptEdits", label: "Accept edits"),
        PermissionOption(value: "plan", label: "Plan mode"),
        PermissionOption(value: "bypassPermissions", label: "Bypass"),
      ]
    case "codex":
      return [
        PermissionOption(value: "default", label: "Default"),
        PermissionOption(value: "edit", label: "Edit"),
        PermissionOption(value: "plan", label: "Plan"),
        PermissionOption(value: "full-auto", label: "Full auto"),
        PermissionOption(value: "config-toml", label: "Config"),
      ]
    case "cursor":
      return [
        PermissionOption(value: "agent", label: "Agent"),
        PermissionOption(value: "ask", label: "Ask"),
        PermissionOption(value: "plan", label: "Plan"),
        PermissionOption(value: "full-auto", label: "Full auto"),
      ]
    case "droid", "factory":
      return [
        PermissionOption(value: "read-only", label: "Read-only"),
        PermissionOption(value: "auto-low", label: "Auto low"),
        PermissionOption(value: "auto-medium", label: "Auto medium"),
        PermissionOption(value: "auto-high", label: "Auto high"),
        PermissionOption(value: "agi", label: "AGI (orchestrator)"),
      ]
    // Muse's own approval modes, as shared/modelPermissions.ts lists them.
    case "muse":
      return [
        PermissionOption(value: "denyUnmatched", label: "Read-only"),
        PermissionOption(value: "promptUnmatched", label: "Ask"),
        PermissionOption(value: "onRequest", label: "Auto"),
        PermissionOption(value: "allowAll", label: "Full access"),
      ]
    default:
      return [
        PermissionOption(value: "plan", label: "Plan"),
        PermissionOption(value: "edit", label: "Edit"),
        PermissionOption(value: "full-auto", label: "Full auto"),
        PermissionOption(value: "config-toml", label: "Config"),
      ]
    }
  }

  /// The mode a fresh chip starts on, matching the desktop per provider.
  static func defaultPermission(provider: String?) -> String {
    switch (provider ?? "").lowercased() {
    case "claude", "codex": return "default"
    case "cursor": return "agent"
    case "droid", "factory": return "auto-low"
    case "muse": return "onRequest"
    default: return "edit"
    }
  }

  /// The label for a stored mode in a provider's vocabulary. Falls back to the
  /// legacy generic labels when the provider is unknown.
  static func permissionLabel(_ mode: String?, provider: String?) -> String {
    guard let mode, !mode.isEmpty else { return defaultPermission(provider: provider) }
    if let option = permissionOptions(provider: provider).first(where: { $0.value == mode }) {
      return option.label
    }
    return permissionLabels[mode] ?? mode
  }

  private static let permissionLabels: [String: String] = [
    "default": "Default",
    "auto": "Auto",
    "plan": "Plan",
    "edit": "Edit",
    "full-auto": "Full access",
  ]

  private static let effortLabels: [String: String] = [
    "none": "None",
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
    "max": "Max",
    "ultra": "Ultra",
    "ultracode": "Ultracode",
  ]

  static func permissionLabel(_ mode: String?) -> String {
    guard let mode, !mode.isEmpty else { return "Default" }
    return permissionLabels[mode] ?? mode
  }

  static func effortLabel(_ effort: String?) -> String {
    guard let effort, !effort.isEmpty else { return "Default" }
    return effortLabels[effort] ?? effort
  }

  /// Serialize one model mention into its chip/draft token form.
  static func formatToken(modelId: String, effort: String?, permission: String?) -> String {
    var params: [String] = []
    if let effort, !effort.isEmpty { params.append("effort=\(effort)") }
    if let permission, !permission.isEmpty { params.append("perm=\(permission)") }
    return "@model:\(modelId)\(params.isEmpty ? "" : "?" + params.joined(separator: "&"))"
  }

  // Character-for-character the desktop's `MODEL_TOKEN_SOURCE`: registry ids
  // take letters, digits, `.`, `_`, `/`, `:`, `%` and `-` (an OpenCode id
  // encodes its provider model id, e.g. `anthropic%2Fclaude-opus-4.7`); the
  // query only simple `key=value` pairs. The word boundary keeps emails and URLs
  // out.
  private static let regex = try! NSRegularExpression(
    pattern: "(?:^|[\\s(\\[{,])@model:([A-Za-z0-9._/:%+-]+)(?:\\?([A-Za-z0-9=&._-]+))?",
    options: []
  )
  /// A sentence can end right after a chip; trailing dots, colons and dashes
  /// belong to the prose (`TRAILING_PROSE_RE`).
  private static let trailingProse = try! NSRegularExpression(pattern: "[.:-]+$", options: [])

  private static func trimProse(_ value: String) -> String {
    let ns = value as NSString
    guard let match = trailingProse.firstMatch(in: value, range: NSRange(location: 0, length: ns.length)) else {
      return value
    }
    return ns.substring(to: match.range.location)
  }

  /// Every model token in `text`, in document order.
  static func mentions(in text: NSString) -> [WorkModelMention] {
    guard text.length > 0, text.range(of: "@model:").location != NSNotFound else { return [] }
    let full = NSRange(location: 0, length: text.length)
    return regex.matches(in: text as String, range: full).compactMap { match in
      guard match.numberOfRanges == 3 else { return nil }
      var modelId = text.substring(with: match.range(at: 1))
      let queryRange = match.range(at: 2)
      var query: String? = queryRange.location == NSNotFound ? nil : text.substring(with: queryRange)
      if let rawQuery = query {
        query = trimProse(rawQuery)
      } else {
        modelId = trimProse(modelId)
        guard !modelId.isEmpty else { return nil }
      }
      var effort: String?
      var permission: String?
      for pair in (query ?? "").split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2, !parts[1].isEmpty else { continue }
        if parts[0] == "effort" { effort = parts[1] } else if parts[0] == "perm" { permission = parts[1] }
      }
      let token = "@model:\(modelId)\(query.map { $0.isEmpty ? "" : "?\($0)" } ?? "")"
      let atLocation = text.range(of: "@model:", options: [], range: match.range).location
      guard atLocation != NSNotFound else { return nil }
      return WorkModelMention(
        modelId: modelId,
        effort: effort,
        permission: permission,
        token: token,
        range: NSRange(location: atLocation, length: (token as NSString).length)
      )
    }
  }

  /// `selectSupportedReasoningEffort` without a preference: the advertised
  /// default when the model accepts it, else medium, else the first level.
  static func defaultEffort(tiers: [String], advertised: String?) -> String? {
    guard !tiers.isEmpty else { return nil }
    if let advertised, tiers.contains(advertised) { return advertised }
    return tiers.contains("medium") ? "medium" : tiers.first
  }

  private static let harnessLabels: [String: String] = [
    "claude": "Claude Code",
    "codex": "Codex",
    "opencode": "OpenCode",
    "cursor": "Cursor",
    "droid": "Droid",
    "pi": "Pi",
    "muse": "Muse Code",
    "qwen": "Qwen Code",
    "kimi": "Kimi",
    "grok": "Grok",
    "copilot": "Copilot",
    "devin": "Devin",
  ]

  /// "Harness · route", e.g. "OpenCode · OpenCode Go" (`modelMentionSubtitle`).
  static func subtitle(groupKey: String, route: String?) -> String {
    let harness = harnessLabels[groupKey] ?? groupKey
    let trimmed = route?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty || trimmed == harness ? harness : "\(harness) · \(trimmed)"
  }

  private static func score(_ haystack: String, _ query: String, allowTrailingProse: Bool) -> (score: Int, prefix: Int)? {
    let target = haystack.lowercased()
    if target == query { return (0, 0) }
    if allowTrailingProse, query.hasPrefix(target + " ") { return (1, target.count) }
    if target.hasPrefix(query) { return (1, 0) }
    if target.contains(query) { return (2, 0) }
    var index = target.startIndex
    for character in query {
      guard let found = target[index...].firstIndex(of: character) else { return nil }
      index = target.index(after: found)
    }
    return (3, 0)
  }

  /// `scoreChatMentionCandidate`: a subtitle hit is weaker than any title hit.
  private static func score(title: String, subtitle: String?, query: String) -> (score: Int, prefix: Int)? {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if trimmed.isEmpty { return (0, 0) }
    if let hit = score(title, trimmed, allowTrailingProse: true) { return hit }
    guard let subtitle, let hit = score(subtitle, trimmed, allowTrailingProse: false) else { return nil }
    return (hit.score + 4, 0)
  }

  private static let modelKeyword = try! NSRegularExpression(pattern: "^models?(?:[:\\s]+|$)", options: [.caseInsensitive])
  private static let minQueryLength = 2
  private static let maxMatchScore = 2
  static let maxResults = 6

  /// `rankComposerModelSuggestions`: a model shows only when the query names
  /// it (word-prefix, prefix, or substring of the name, 2+ characters). A
  /// query starting with "model" lists every model and filters by the rest.
  /// Among equally good matches, models in `recentModelIds` (the picker's
  /// synced recents, newest first) lead; a better match still wins.
  static func rank(
    _ models: [WorkModelMentionDirectory.Entry],
    query rawQuery: String,
    recentModelIds: [String] = []
  ) -> (rows: [WorkModelMentionDirectory.Entry], bestScore: Int?) {
    let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    let ns = query as NSString
    let keyword = modelKeyword.firstMatch(in: query, range: NSRange(location: 0, length: ns.length))
    let effective = keyword.map {
      ns.substring(from: NSMaxRange($0.range)).trimmingCharacters(in: .whitespacesAndNewlines)
    } ?? query
    if keyword == nil && effective.count < minQueryLength { return ([], nil) }
    let lowered = effective.lowercased()
    var scored: [(entry: WorkModelMentionDirectory.Entry, score: Int, prefix: Int)] = []
    for model in models {
      // "opus" names "Claude Opus 5" as surely as "claude" does.
      let wordPrefix = !lowered.isEmpty && model.title.lowercased()
        .split(whereSeparator: { " /._-".contains($0) || $0.isWhitespace })
        .contains { $0.hasPrefix(lowered) }
      let match: (score: Int, prefix: Int)?
      if wordPrefix {
        match = (score: 1, prefix: 0)
      } else {
        match = score(title: model.title, subtitle: model.subtitle, query: effective)
          ?? score(title: model.modelId, subtitle: nil, query: effective)
      }
      guard let match else { continue }
      if keyword == nil && match.score > maxMatchScore { continue }
      scored.append((model, match.score, match.prefix))
    }
    var recentRank: [String: Int] = [:]
    for (index, id) in recentModelIds.enumerated() where recentRank[id] == nil { recentRank[id] = index }
    scored.sort { lhs, rhs in
      if lhs.score != rhs.score { return lhs.score < rhs.score }
      let lhsRecent = recentRank[lhs.entry.modelId] ?? recentRank.count
      let rhsRecent = recentRank[rhs.entry.modelId] ?? recentRank.count
      if lhsRecent != rhsRecent { return lhsRecent < rhsRecent }
      if lhs.prefix != rhs.prefix { return lhs.prefix > rhs.prefix }
      return lhs.entry.modelId < rhs.entry.modelId
    }
    return (scored.prefix(maxResults).map { $0.entry }, scored.first?.score)
  }
}

/// The models this device has seen in the host's catalog (`chat.modelCatalog`,
/// the list the model picker shows). The `@` menu lists them, and chips read
/// their names from here. Filled whenever the catalog is fetched; a chip for a
/// model it has not seen falls back to the id's last segment.
final class WorkModelMentionDirectory: @unchecked Sendable {
  struct Entry: Equatable {
    let modelId: String
    let title: String
    /// Harness and route, e.g. "OpenCode · OpenCode Go".
    let subtitle: String
    /// Chat runtime provider (harness group key), so the chip's permission menu
    /// offers this provider's own modes.
    let provider: String
    /// The upstream maker's key for the row/chip mark — "deepseek" for
    /// `opencode/opencode-go/deepseek-v4.1-flash`, where `provider` alone is the
    /// gateway.
    let brandKey: String
    let reasoningTiers: [String]
    let defaultEffort: String?
    let isAvailable: Bool
  }

  static let shared = WorkModelMentionDirectory()

  private let lock = NSLock()
  private var entries: [Entry] = []
  private var byId: [String: Entry] = [:]
  private var recents: [String] = []
  /// Bumped by every local pick, so a host answer requested before that pick
  /// cannot replace the newer order when it lands late.
  private var recentsRevision = 0

  var recentsRevisionSnapshot: Int {
    lock.lock()
    defer { lock.unlock() }
    return recentsRevision
  }

  /// The picker's synced recents (desktop and iOS share them), newest
  /// first. The `@` menu ranks recent models first among equal matches.
  var recentModelIds: [String] {
    lock.lock()
    defer { lock.unlock() }
    return recents
  }

  /// Records the host's recents unless a local pick happened after
  /// `revision` was read (pass nil to record unconditionally).
  func record(recents next: [String], ifRevision revision: Int? = nil) {
    lock.lock()
    defer { lock.unlock() }
    if let revision, revision != recentsRevision { return }
    recents = next
  }

  /// A model picked from the `@` menu becomes the newest recent, as on desktop.
  func noteRecent(_ modelId: String) {
    lock.lock()
    recents = [modelId] + recents.filter { $0 != modelId }
    if recents.count > 10 { recents = Array(recents.prefix(10)) }
    recentsRevision += 1
    lock.unlock()
  }

  func entry(for modelId: String) -> Entry? {
    lock.lock()
    defer { lock.unlock() }
    return byId[modelId]
  }

  /// Models a chip can start, once each, in catalog order.
  var availableEntries: [Entry] {
    lock.lock()
    defer { lock.unlock() }
    return entries.filter(\.isAvailable)
  }

  func record(catalog: AgentChatModelCatalog) {
    var next: [Entry] = []
    var seen: [String: Entry] = [:]
    for group in catalog.groups {
      // The desktop names the route only where one harness fronts many services.
      let routed = group.key == "opencode" || group.key == "pi"
      for provider in group.providers {
        for subsection in provider.subsections {
          for model in subsection.models {
            let existing = seen[model.id]
            // A model can appear once per key; an available row wins.
            if let existing, existing.isAvailable || !model.isAvailable { continue }
            let tiers = (model.reasoningEfforts ?? []).map(\.effort)
            let name = model.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            let entry = Entry(
              modelId: model.id,
              title: name.isEmpty ? model.id : name,
              subtitle: WorkModelMentionDetector.subtitle(
                groupKey: group.key,
                route: routed ? provider.displayName : nil
              ),
              provider: group.key,
              // The mark the chip should wear. Only the OpenCode gateway fronts
              // many makers; every direct harness keeps its own mark.
              brandKey: group.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "opencode"
                ? workModelBrandKey(
                  topLevelProvider: group.key,
                  providerKey: provider.key,
                  family: model.family,
                  modelId: model.id
                )
                : group.key,
              reasoningTiers: tiers,
              defaultEffort: WorkModelMentionDetector.defaultEffort(
                tiers: tiers,
                advertised: model.defaultReasoningEffort
              ),
              isAvailable: model.isAvailable
            )
            if existing != nil {
              next.removeAll { $0.modelId == model.id }
            }
            seen[model.id] = entry
            next.append(entry)
          }
        }
      }
    }
    guard !next.isEmpty else { return }
    lock.lock()
    entries = next
    byId = seen
    lock.unlock()
  }
}

// MARK: - `@`-prefixed repo paths

/// One `@`-prefixed file or folder path in a message body — the token the
/// composer inserts for a quick-open pick (`@src/shared/chips.ts`,
/// `@src/shared/`). The Swift twin of `chipFromPath` in
/// `apps/desktop/src/shared/chips.ts`.
struct WorkChipPath: Equatable {
  /// The path with no leading `@` and no folder trailing slash.
  let path: String
  let isDirectory: Bool
  /// Covers the `@` AND the path text, so a renderer replaces both.
  let range: NSRange

  /// Canonical serialized form, matching `chipFromPath().token`: a folder keeps
  /// its trailing slash, because that slash is what marks it a folder.
  var token: String { isDirectory ? "\(path)/" : path }

  var chipKind: WorkSmartLink.Kind { isDirectory ? .folder : .file }

  /// Basename, with a folder's slash kept. Matches the desktop chip's `label`.
  var defaultLabel: String {
    let normalized = path.hasSuffix("/") ? String(path.dropLast()) : path
    let name = (normalized as NSString).lastPathComponent
    let base = name.isEmpty ? normalized : name
    return isDirectory ? "\(base)/" : base
  }
}

enum WorkChipPathDetector {
  // Character-for-character the desktop's `PATH_MENTION_RE`. Two deliberate
  // restrictions, and both have to hold on BOTH surfaces or the fixture parity
  // test is the only thing left standing between them:
  //
  //   - The token MUST contain a `/`. A bare `@name.ext` is indistinguishable
  //     from a domain or a handle (`@example.com`), and a file pill that
  //     navigates nowhere is worse than leaving a root-level file as text.
  //   - NO `:` anywhere in the token. That is what keeps `@chat:abc` and
  //     `@bogus:123` out of this matcher and leaves them to the entity grammar.
  //
  // The leading boundary mirrors `WorkChatMentionDetector`, so an email or a
  // mid-word `arul@chat/nope` is not a path mention either.
  private static let regex = try! NSRegularExpression(
    pattern: "(?:^|[ \\t\\r\\n(\\[{,])@([^\\s:]*(?:/[^\\s:]*|\\.\\w{1,8}))",
    options: []
  )
  /// Suffixes that mean "web address", never "source file". Kept minimal on
  /// purpose: TLDs and source extensions collide badly — `.md` is Moldova,
  /// `.py` Paraguay, `.sh` St Helena, `.pl` Poland, `.rs` Serbia — so a
  /// "complete" TLD blocklist would refuse a README, which is the very case
  /// the extension arm exists for. Mirrors `WEB_ONLY_SUFFIXES` in chips.ts.
  private static let webOnlySuffixes: Set<String> = [
    "com", "org", "net", "edu", "gov", "info", "xyz", "online", "site",
  ]
  /// A short file extension, which is what lets a ROOT-level `@README.md`
  /// chip: it has no `/` to qualify it. Capped at 1-8 word characters so prose
  /// cannot pass.
  private static let extensionSuffix = try! NSRegularExpression(
    pattern: "\\.\\w{1,8}$",
    options: []
  )
  /// Trailing sentence punctuation belongs to the prose, not the path.
  private static let trailingPunctuation = try! NSRegularExpression(
    pattern: "[.,;!?)\\]}]+$",
    options: []
  )

  /// Every `@`-path token in `text`, in document order.
  static func paths(in text: NSString) -> [WorkChipPath] {
    guard text.length > 0, text.range(of: "@").location != NSNotFound else { return [] }
    let full = NSRange(location: 0, length: text.length)
    return regex.matches(in: text as String, range: full).compactMap { match in
      guard match.numberOfRanges == 2 else { return nil }
      let captured = match.range(at: 1)
      guard captured.location != NSNotFound, captured.location > 0 else { return nil }
      var raw = text.substring(with: captured) as NSString
      if let strip = trailingPunctuation.firstMatch(
        in: raw as String,
        range: NSRange(location: 0, length: raw.length)
      ) {
        raw = raw.substring(to: strip.range.location) as NSString
      }
      // A folder's own trailing slash survives the strip above. Both arms are
      // re-checked AFTER the strip, because it can eat the very `/` or
      // extension that qualified the token: `@foo.` must not become a chip.
      if raw.range(of: "/").location == NSNotFound {
        // Slash-less: it qualifies only on a code-ish extension. A web-only
        // suffix stays prose, so `@example.com` is not a file pill while
        // `@README.md` is. A token WITH a slash is a path regardless.
        guard let match = extensionSuffix.firstMatch(
          in: raw as String,
          range: NSRange(location: 0, length: raw.length)
        ) else { return nil }
        let suffix = (raw.substring(with: match.range) as String)
          .dropFirst()
          .lowercased()
        guard !WorkChipPathDetector.webOnlySuffixes.contains(suffix) else { return nil }
      }
      let isDirectory = raw.hasSuffix("/")
      let path = isDirectory ? raw.substring(to: raw.length - 1) : (raw as String)
      return WorkChipPath(
        path: path,
        isDirectory: isDirectory,
        // `@` sits immediately before the capture, and the chip covers both.
        range: NSRange(location: captured.location - 1, length: raw.length + 1)
      )
    }
  }
}

// MARK: - Attachment tokens

/// One `[Image #k]` / `[File #k: name]` token — the Swift twin of
/// `apps/desktop/src/shared/attachmentLabels.ts`.
///
/// Numbering is positional: the k-th IMAGE attachment (counting only images,
/// `image-url` included) is `[Image #k]`, and the k-th non-image attachment is
/// `[File #k: <basename>]`. The token never stores a path or an id, so drafts
/// and sent messages stay plain text, and a token whose ordinal has no
/// attachment is not a chip — it stays text.
struct WorkAttachmentToken: Equatable {
  enum Kind: Equatable {
    case image
    case file
  }

  let kind: Kind
  /// 1-based position among attachments of the same kind.
  let ordinal: Int
  /// The name a file token carries. Informational only; resolution is by ordinal.
  let name: String?
  let token: String
  let range: NSRange
}

enum WorkAttachmentTokenGrammar {
  // Character-for-character the desktop's `ATTACHMENT_TOKEN_RE`.
  private static let regex = try! NSRegularExpression(
    pattern: "\\[(?:Image #(\\d{1,4})|File #(\\d{1,4}): ([^\\]\\[\\r\\n]{1,240}))\\]",
    options: []
  )

  /// Mirrors `sanitizeTokenName`: a name that contains a bracket or a newline
  /// would end the token early, so those characters become `_`.
  static func sanitizedName(_ name: String) -> String {
    let cleaned = name
      .map { "[]\r\n".contains($0) ? "_" : String($0) }
      .joined()
      .trimmingCharacters(in: .whitespaces)
    return cleaned.isEmpty ? "file" : cleaned
  }

  static func token(kind: WorkAttachmentToken.Kind, ordinal: Int, name: String? = nil) -> String {
    switch kind {
    case .image: return "[Image #\(ordinal)]"
    case .file: return "[File #\(ordinal): \(sanitizedName(name ?? ""))]"
    }
  }

  /// Every token in `text`, in document order.
  static func tokens(in text: NSString) -> [WorkAttachmentToken] {
    guard text.length > 0, text.range(of: "[").location != NSNotFound else { return [] }
    let full = NSRange(location: 0, length: text.length)
    return regex.matches(in: text as String, range: full).compactMap { match in
      let imageRange = match.range(at: 1)
      let fileRange = match.range(at: 2)
      if imageRange.location != NSNotFound,
         let ordinal = Int(text.substring(with: imageRange)), ordinal >= 1 {
        return WorkAttachmentToken(
          kind: .image,
          ordinal: ordinal,
          name: nil,
          token: text.substring(with: match.range),
          range: match.range
        )
      }
      if fileRange.location != NSNotFound,
         let ordinal = Int(text.substring(with: fileRange)), ordinal >= 1 {
        let nameRange = match.range(at: 3)
        return WorkAttachmentToken(
          kind: .file,
          ordinal: ordinal,
          name: nameRange.location == NSNotFound ? nil : text.substring(with: nameRange),
          token: text.substring(with: match.range),
          range: match.range
        )
      }
      return nil
    }
  }

  /// Index of the attachment the token points at, or nil when the ordinal has
  /// none. `isImage` classifies each element the same way the host does.
  static func resolve<T>(
    _ token: WorkAttachmentToken,
    in attachments: [T],
    isImage: (T) -> Bool
  ) -> Int? {
    var seen = 0
    for (index, attachment) in attachments.enumerated() {
      guard isImage(attachment) == (token.kind == .image) else { continue }
      seen += 1
      if seen == token.ordinal { return index }
    }
    return nil
  }
}

// MARK: - Unified chips

/// One pill, whichever grammar produced it — the Swift twin of the `Chip` type
/// in `apps/desktop/src/shared/chips.ts`.
///
/// `token` is the canonical plain text (copy, drafts, and the plain-text
/// clipboard flavour all write it). `label` is display only.
struct WorkChip: Equatable {
  enum Origin: Equatable {
    case mention(WorkChatMention)
    case link(WorkSmartLink)
    case path(WorkChipPath)
    /// A resolved `[Image #k]` / `[File #k: …]` token and the ref it names.
    case attachment(WorkAttachmentToken, AgentChatFileRef)
    case model(WorkModelMention)
    /// A permission mode an agent named in its reply (`bypassPermissions`).
    case permission(provider: String, value: String)
    /// A slash command or skill this chat can run (`/quality`).
    case skill(name: String)
    case browserTab(WorkBrowserTabMention)
  }

  let kind: WorkSmartLink.Kind
  let token: String
  let label: String
  let range: NSRange
  let origin: Origin

  var glyph: String { kind.glyph }

  init(mention: WorkChatMention) {
    kind = mention.kind.chipKind
    token = mention.token
    label = mention.defaultLabel
    range = mention.range
    origin = .mention(mention)
  }

  init(link: WorkSmartLink) {
    kind = link.kind
    token = link.url
    label = link.compactLabel
    range = link.range
    origin = .link(link)
  }

  init(path: WorkChipPath) {
    kind = path.chipKind
    token = path.token
    label = path.defaultLabel
    range = path.range
    origin = .path(path)
  }

  init(attachment: WorkAttachmentToken, ref: AgentChatFileRef) {
    kind = attachment.kind == .image ? .image : .file
    token = attachment.token
    label = attachment.kind == .image
      ? "Image \(attachment.ordinal)"
      : workChatAttachmentDisplayName(ref)
    range = attachment.range
    origin = .attachment(attachment, ref)
  }

  init(model: WorkModelMention) {
    kind = .model
    token = model.token
    label = model.chipLabel(displayName: model.displayName)
    range = model.range
    origin = .model(model)
  }

  init(browserTab: WorkBrowserTabMention) {
    kind = .browserTab
    token = browserTab.token
    label = browserTab.label
    range = browserTab.range
    origin = .browserTab(browserTab)
  }

  /// A chip whose kind and label were decided by the thread-entity rules
  /// rather than read off a token's own grammar (`#123` is a PR, a lane id
  /// shows the lane's name).
  init(kind: WorkSmartLink.Kind, token: String, label: String, range: NSRange, origin: Origin) {
    self.kind = kind
    self.token = token
    self.label = label
    self.range = range
    self.origin = origin
  }

  /// The plain text this chip serializes back to. Mention and link tokens are
  /// already the literal source text; a path token deliberately is NOT — it
  /// omits the `@` the grammar needs, exactly as `chipFromPath().token` does on
  /// the desktop — so the sigil is restored here rather than silently dropped.
  var canonicalText: String {
    if case .path = origin { return "@\(token)" }
    return token
  }
}

/// A message body split into plain runs and chips — what a renderer wants, so
/// it walks the parts in order and never computes offsets itself.
enum WorkChipTextPart: Equatable {
  case text(String)
  case chip(WorkChip)
}

/// One scan over the text, every grammar, in document order, no overlaps.
/// Mirrors `parseChips` / `splitTextIntoChipParts`.
///
/// A BARE path is still not a chip — that is ambiguous with ordinary prose — but
/// an `@`-prefixed one is, because that is the token the composer inserts for a
/// quick-open pick and it is by far the most common chip in a real message.
enum WorkChipDetector {
  static let defaultLimit = 24
  /// Serialization is not a render, so it is not bounded by what fits on a
  /// screen — but it is still bounded, so a pathological paste cannot fan out.
  static let canonicalTextChipLimit = 512

  /// `attachments` is the message's attachment list. Attachment tokens are only
  /// chips when they resolve against it, so passing nil (a composer draft that
  /// resolves its own tokens, a surface with no attachments) leaves every
  /// `[Image #k]` as text.
  static func chips(
    in text: NSString,
    limit: Int = defaultLimit,
    attachments: [AgentChatFileRef]? = nil
  ) -> [WorkChip] {
    guard text.length > 0, limit > 0 else { return [] }

    var candidates: [WorkChip] = WorkBrowserTabMentionDetector.mentions(in: text).map(WorkChip.init(browserTab:))
    candidates.append(contentsOf: WorkChatMentionDetector.mentions(in: text).map(WorkChip.init(mention:)))
    // Model tokens follow chat mentions, the desktop's `parseChips` push order.
    candidates.append(contentsOf: WorkModelMentionDetector.mentions(in: text).map(WorkChip.init(model:)))
    if let attachments, !attachments.isEmpty {
      for token in WorkAttachmentTokenGrammar.tokens(in: text) {
        guard let index = WorkAttachmentTokenGrammar.resolve(
          token,
          in: attachments,
          isImage: workChatAttachmentIsImage
        ) else { continue }
        candidates.append(WorkChip(attachment: token, ref: attachments[index]))
      }
    }
    candidates.append(contentsOf: WorkSmartLinkDetector.links(in: text).prefix(limit).map(WorkChip.init(link:)))
    // Last, like the desktop: the sort below puts them in document order and
    // the `consumedTo` loop drops any that overlap a link, so a path that lives
    // inside a URL cannot double-match.
    candidates.append(contentsOf: WorkChipPathDetector.paths(in: text).map(WorkChip.init(path:)))

    // Sort by start offset, tie-broken by discovery order so the sort is stable
    // the way the desktop's `Array.prototype.sort` is. That order is what makes
    // the entity grammar win a tie with the path grammar, which is the same
    // precedence the desktop's push order gives it.
    let ordered = candidates.enumerated()
      .sorted { lhs, rhs in
        lhs.element.range.location == rhs.element.range.location
          ? lhs.offset < rhs.offset
          : lhs.element.range.location < rhs.element.range.location
      }
      .map(\.element)

    var out: [WorkChip] = []
    var consumedTo = -1
    for chip in ordered {
      if chip.range.location < consumedTo { continue }
      out.append(chip)
      consumedTo = NSMaxRange(chip.range)
      if out.count >= limit { break }
    }
    return out
  }

  static func parts(
    in text: String,
    limit: Int = defaultLimit,
    attachments: [AgentChatFileRef]? = nil
  ) -> [WorkChipTextPart] {
    let ns = text as NSString
    let matches = chips(in: ns, limit: limit, attachments: attachments)
    guard !matches.isEmpty else { return text.isEmpty ? [] : [.text(text)] }

    var parts: [WorkChipTextPart] = []
    var cursor = 0
    for chip in matches {
      if chip.range.location > cursor {
        parts.append(.text(ns.substring(with: NSRange(location: cursor, length: chip.range.location - cursor))))
      }
      parts.append(.chip(chip))
      cursor = NSMaxRange(chip.range)
    }
    if cursor < ns.length {
      parts.append(.text(ns.substring(from: cursor)))
    }
    return parts
  }

  /// The canonical plain-text form of a selection: labels never leak into the
  /// clipboard, so a chip pasted into a terminal, a commit message, or another
  /// ADE surface is still a meaningful, re-parseable pointer. Mirrors the
  /// `text/plain` flavour of `apps/desktop/src/shared/composerClipboard.ts`.
  ///
  /// Today this is the identity on iOS — the composer and the transcript both
  /// store raw text and render chips from it, so there is no label-bearing DOM
  /// to lose. It exists as the one named place that guarantees that, and as the
  /// hook for any future surface that stores labels instead.
  static func canonicalPlainText(_ text: String) -> String {
    let ns = text as NSString
    let matches = chips(in: ns, limit: canonicalTextChipLimit)
    guard !matches.isEmpty else { return text }
    var out = ""
    var cursor = 0
    for chip in matches {
      if chip.range.location > cursor {
        out += ns.substring(with: NSRange(location: cursor, length: chip.range.location - cursor))
      }
      out += chip.canonicalText
      cursor = NSMaxRange(chip.range)
    }
    if cursor < ns.length { out += ns.substring(from: cursor) }
    return out
  }
}

// MARK: - Browser tab mentions

/// Swift twin of `apps/desktop/src/shared/browserTabMention.ts`. The attached
/// block is deliberately one line: titles and URLs are display data, while the
/// tab id is the stable pointer an agent can claim.
struct WorkBrowserTabMention: Equatable {
  let tabId: String
  let title: String?
  let url: String?
  let token: String
  let range: NSRange

  var label: String {
    if let title, !title.isEmpty { return title }
    if let url, let host = URL(string: url)?.host, !host.isEmpty { return host }
    return url ?? "Browser tab"
  }
}

enum WorkBrowserTabMentionDetector {
  private static let regex = try! NSRegularExpression(
    pattern: #"<ade-browser-tab id="([^"\n]*)" title="([^"\n]*)" url="([^"\n]*)">[^\n]*?</ade-browser-tab>"#,
    options: []
  )

  private static func unescape(_ value: String) -> String {
    value
      .replacingOccurrences(of: "&quot;", with: "\"")
      .replacingOccurrences(of: "&lt;", with: "<")
      .replacingOccurrences(of: "&gt;", with: ">")
      .replacingOccurrences(of: "&amp;", with: "&")
  }

  static func mentions(in text: NSString) -> [WorkBrowserTabMention] {
    guard text.length > 0 else { return [] }
    let full = NSRange(location: 0, length: text.length)
    return regex.matches(in: text as String, range: full).compactMap { match in
      guard match.numberOfRanges == 4 else { return nil }
      let tabId = unescape(text.substring(with: match.range(at: 1)))
      guard !tabId.isEmpty else { return nil }
      let title = unescape(text.substring(with: match.range(at: 2)))
      let url = unescape(text.substring(with: match.range(at: 3)))
      return WorkBrowserTabMention(
        tabId: tabId,
        title: title.isEmpty ? nil : title,
        url: url.isEmpty ? nil : url,
        token: text.substring(with: match.range),
        range: match.range
      )
    }
  }
}

// MARK: - Trigger detection

/// The typed triggers the composer recognizes, matching the shared desktop
/// semantics: `/` opens the slash-command list, `@` opens file quick-open, and
/// `#` opens the pull-request menu. Detection runs on the text *before* the
/// cursor so a trigger can live anywhere in the draft ("fix @src/foo.ts then
/// run /test").
enum WorkComposerTriggerKind: Equatable {
  case slash
  case at
  case hash
}

/// A live trigger resolved from the draft: which kind, the query typed after the
/// trigger char, and the UTF-16 range (trigger char through cursor) that a
/// committed suggestion replaces.
struct WorkComposerTriggerMatch: Equatable {
  let kind: WorkComposerTriggerKind
  let query: String
  /// Range of the trigger span in the full text, in UTF-16 units so it lines up
  /// with `UITextView.selectedRange`.
  let range: NSRange
}

/// Pure, cursor-relative trigger detection shared by the composer text view.
/// Applied to the substring before the cursor. When both match (rare), the one
/// whose trigger char sits closest to the cursor wins.
/// Mirrors the desktop regexes exactly:
///   slash — `(?:^|\s)/([^\s/]*)$`
///   at    — `(?:^|[ \t\r\n])@([^@\r\n]*)$`
///   hash  — `(?:^|[ \t\r\n])#([^\s#]*)$`
/// The `@` query may contain spaces for multi-word entity names, but it stops
/// at a newline or another `@`. The `#` query takes no whitespace at all, so a
/// markdown heading (`# Title`) closes the token on its very next character
/// and `owner/repo#12` never triggers — that text is already a chip.
enum WorkComposerTriggerDetector {
  private static let slashRegex = try! NSRegularExpression(pattern: "(?:^|\\s)/([^\\s/]*)$")
  private static let atRegex = try! NSRegularExpression(pattern: "(?:^|[ \\t\\r\\n])@([^@\\r\\n]*)$")
  private static let hashRegex = try! NSRegularExpression(pattern: "(?:^|[ \\t\\r\\n])#([^\\s#]*)$")
  private static let fileQueryRegex = try! NSRegularExpression(
    pattern: "^(.+?\\.[A-Za-z0-9_-]+)(?:[ \\t]+.*)?$"
  )

  static func detect(in text: NSString, cursor: Int) -> WorkComposerTriggerMatch? {
    guard cursor >= 0, cursor <= text.length else { return nil }
    let prefix = text.substring(to: cursor) as NSString
    let searchRange = NSRange(location: 0, length: prefix.length)

    func consider(_ regex: NSRegularExpression, _ kind: WorkComposerTriggerKind) -> WorkComposerTriggerMatch? {
      guard let match = regex.firstMatch(in: prefix as String, range: searchRange) else { return nil }
      let group = match.range(at: 1)
      guard group.location != NSNotFound else { return nil }
      // The trigger char (`/` or `@`) sits immediately before the capture group.
      let triggerCharLocation = group.location - 1
      guard triggerCharLocation >= 0 else { return nil }
      let query = prefix.substring(with: group)
      let span = NSRange(location: triggerCharLocation, length: cursor - triggerCharLocation)
      return WorkComposerTriggerMatch(kind: kind, query: query, range: span)
    }

    // The trigger typed closest to the cursor wins, so the menu always answers
    // the token the user is still typing. Ties break the same way the desktop
    // orders its comparisons: hash, then at, then slash.
    let candidates = [
      consider(hashRegex, .hash),
      consider(atRegex, .at),
      consider(slashRegex, .slash),
    ].compactMap { $0 }
    return candidates.max(by: { $0.range.location < $1.range.location })
  }

  /// Keep path-like file labels searchable when the user continues ordinary
  /// prose, while leaving multiword chat-name queries untouched.
  static func fileSearchQuery(for query: String) -> String {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "" }
    let nsQuery = trimmed as NSString
    let range = NSRange(location: 0, length: nsQuery.length)
    guard let match = fileQueryRegex.firstMatch(in: trimmed, range: range) else { return trimmed }
    let labelRange = match.range(at: 1)
    guard labelRange.location != NSNotFound else { return trimmed }
    return nsQuery.substring(with: labelRange)
  }

  /// Keep extensionless path prefixes separate from prose when the selected
  /// file's canonical path continues past the words typed before that prose.
  static func pathPrefixForSelection(query: String, selectedLabel: String) -> String {
    let words = query.split(whereSeparator: { $0 == " " || $0 == "\t" })
    guard words.count > 1 else { return "" }
    let pathComponents = selectedLabel
      .split(whereSeparator: { $0 == "/" || $0 == "\\" })
      .map(String.init)

    for wordCount in stride(from: words.count - 1, through: 1, by: -1) {
      let prefix = words.prefix(wordCount).joined(separator: " ")
      let matchesPath: Bool
      if prefix.contains("/") || prefix.contains("\\") {
        matchesPath = selectedLabel.lowercased().contains(prefix.lowercased())
      } else {
        matchesPath = pathComponents.contains { $0.lowercased().contains(prefix.lowercased()) }
      }
      if matchesPath { return prefix }
    }
    return ""
  }

  /// A committed @ chip is complete once the following character is whitespace.
  /// The live detector still accepts spaces for multiword queries, so the chip
  /// range must explicitly terminate that otherwise ambiguous trigger.
  static func hasConfirmedChipPrefix(
    _ match: WorkComposerTriggerMatch,
    in text: NSString,
    chipRanges: [NSRange]
  ) -> Bool {
    guard match.kind == .at else { return false }
    let matchEnd = NSMaxRange(match.range)
    for chipRange in chipRanges {
      guard chipRange.location == match.range.location,
            chipRange.location >= 0,
            NSMaxRange(chipRange) <= matchEnd,
            NSMaxRange(chipRange) < text.length,
            text.character(at: chipRange.location) == 0x40 else { continue }
      let following = text.character(at: NSMaxRange(chipRange))
      if following == 0x20 || following == 0x09 || following == 0x0A || following == 0x0D {
        return true
      }
    }
    return false
  }

  /// Keep prose typed after a selected @ item outside the replacement range.
  /// The trigger detector intentionally accepts spaces for multi-word names;
  /// this second pass uses the selected row's label to distinguish that name
  /// from a trailing sentence.
  static func matchForSelection(
    _ match: WorkComposerTriggerMatch,
    suggestion: WorkComposerSuggestion
  ) -> WorkComposerTriggerMatch {
    guard match.kind == .at else { return match }
    // A model row's token is not what the user typed; its name is.
    let rawLabel = suggestion.modelId == nil && suggestion.insertText.hasPrefix("@")
      ? String(suggestion.insertText.dropFirst())
      : suggestion.title
    let label = rawLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !label.isEmpty else { return match }

    var candidateLabels = [label]
    if let basename = label.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last {
      let basenameString = String(basename)
      if !candidateLabels.contains(where: { $0.lowercased() == basenameString.lowercased() }) {
        candidateLabels.append(basenameString)
      }
    }
    let searchableQuery = fileSearchQuery(for: match.query)
    if searchableQuery != match.query,
       label.lowercased().hasSuffix(searchableQuery.lowercased()),
       !candidateLabels.contains(where: { $0.lowercased() == searchableQuery.lowercased() }) {
      candidateLabels.append(searchableQuery)
    }
    let pathPrefix = pathPrefixForSelection(query: match.query, selectedLabel: label)
    if !pathPrefix.isEmpty,
       !candidateLabels.contains(where: { $0.lowercased() == pathPrefix.lowercased() }) {
      candidateLabels.append(pathPrefix)
    }

    let query = match.query as NSString
    for candidateLabel in candidateLabels {
      let labelLength = (candidateLabel as NSString).length
      guard query.length >= labelLength else { continue }
      let prefix = query.substring(to: labelLength)
      guard prefix.lowercased() == candidateLabel.lowercased() else { continue }

      let remainder = query.substring(from: labelLength) as NSString
      guard remainder.length == 0 || remainder.character(at: 0) == 0x20 || remainder.character(at: 0) == 0x09 else {
        continue
      }
      var separatorLength = 0
      while separatorLength < remainder.length {
        let character = remainder.character(at: separatorLength)
        guard character == 0x20 || character == 0x09 else { break }
        separatorLength += 1
      }
      let consumedQuery = query.substring(to: labelLength + separatorLength)
      return WorkComposerTriggerMatch(
        kind: match.kind,
        query: consumedQuery,
        range: NSRange(location: match.range.location, length: 1 + (consumedQuery as NSString).length)
      )
    }
    return match
  }
}

// MARK: - Suggestion model

/// One row in the inline suggestion strip. `insertText` is the canonical token
/// *without* the trailing space (the space is appended on commit).
struct WorkComposerSuggestion: Identifiable, Equatable {
  let id: String
  let kind: WorkComposerTriggerKind
  let title: String
  let subtitle: String?
  let insertText: String
  /// Only meaningful for `@` file rows. Changes the row's glyph; it never
  /// changes what commit does, because an iOS `@` commit splices text and
  /// stages nothing.
  var isDirectory: Bool = false
  /// Set on `@` entity rows (`chat.listMentionSuggestions`). Nil for files.
  var mentionKind: WorkChatMention.Kind? = nil
  /// Set on `@` model rows: the registry id the inserted `@model:` token names.
  var modelId: String? = nil

  /// Which group of the `@` menu this row belongs to.
  var section: WorkComposerSuggestionSection {
    switch kind {
    case .slash: return .commands
    case .hash: return .pullRequests
    case .at:
      switch mentionKind {
      case .chat: return .chats
      case .lane: return .lanes
      case .terminal: return .terminals
      case .pullRequest: return .pullRequests
      case .machine: return .machines
      case .mcp: return .mcpServers
      case nil: return .files
      }
    }
  }

  /// Chip kind of the pill a commit inserts.
  var pillKind: WorkSmartLink.Kind {
    switch kind {
    case .slash: return .adeLink
    case .hash: return .pullRequest
    case .at:
      if let mentionKind { return mentionKind.chipKind }
      if modelId != nil { return .model }
      return isDirectory ? .folder : .file
    }
  }

  /// SF Symbol for the row and for the pill it becomes.
  var symbolName: String {
    kind == .slash ? "command" : pillKind.symbolName
  }
}

/// Groups of the `@` menu, in display order. A typed prefix (`@pr`, `@mac`,
/// `@chat`, `@lane`, `@term`, `@file`) narrows the menu to one group.
enum WorkComposerSuggestionSection: String, CaseIterable, Equatable {
  case chats
  case lanes
  case terminals
  case pullRequests
  case machines
  case mcpServers
  case files
  case commands

  static let atMenuOrder: [WorkComposerSuggestionSection] = [
    .chats, .lanes, .terminals, .pullRequests, .machines, .mcpServers, .files,
  ]

  var title: String {
    switch self {
    case .chats: return "Chats"
    case .lanes: return "Lanes"
    case .terminals: return "Terminals"
    case .pullRequests: return "Pull requests"
    case .machines: return "Machines"
    case .mcpServers: return "MCP servers"
    case .files: return "Files"
    case .commands: return "Commands"
    }
  }

  var symbolName: String {
    switch self {
    case .chats: return WorkSmartLink.Kind.chat.symbolName
    case .lanes: return WorkSmartLink.Kind.lane.symbolName
    case .terminals: return WorkSmartLink.Kind.terminal.symbolName
    case .pullRequests: return WorkSmartLink.Kind.pullRequest.symbolName
    case .machines: return WorkSmartLink.Kind.machine.symbolName
    case .mcpServers: return WorkSmartLink.Kind.mcp.symbolName
    case .files: return "doc.text"
    case .commands: return "command"
    }
  }

  /// `@pr`, `@pr:`, `@pr fix…` → (.pullRequests, "fix…"). Anything else is an
  /// unfiltered query, so `@prompt.ts` still searches every group.
  static func parseAtQuery(_ query: String) -> (filter: WorkComposerSuggestionSection?, rest: String) {
    // The host's own kind words (`chat.listMentionSuggestions` narrows on the
    // same list), plus `file`, which only this menu has.
    let prefixes: [(String, WorkComposerSuggestionSection)] = [
      ("chat", .chats), ("chats", .chats),
      ("lane", .lanes), ("lanes", .lanes),
      ("term", .terminals), ("terminal", .terminals), ("terminals", .terminals),
      ("pr", .pullRequests), ("prs", .pullRequests),
      ("mac", .machines), ("machine", .machines), ("machines", .machines),
      ("mcp", .mcpServers), ("server", .mcpServers), ("servers", .mcpServers),
      ("file", .files), ("files", .files),
    ]
    let lowered = query.lowercased()
    for (prefix, section) in prefixes.sorted(by: { $0.0.count > $1.0.count }) {
      guard lowered.hasPrefix(prefix) else { continue }
      let remainder = query.dropFirst(prefix.count)
      if remainder.isEmpty { return (section, "") }
      guard let next = remainder.first, next == ":" || next == " " else { continue }
      return (section, String(remainder.dropFirst()).trimmingCharacters(in: .whitespaces))
    }
    return (nil, query)
  }
}

/// Titles the @ menu showed for each committed mention token, so a pill that is
/// re-hydrated from text (a draft restore, a failed-send restore) reads as the
/// chat or PR it points at rather than as `Chat 1a2b3c4d`. Display only.
@MainActor
enum WorkComposerMentionTitleCache {
  private static var titles: [String: String] = [:]
  private static var order: [String] = []
  private static let limit = 256

  static func remember(token: String, title: String) {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    if titles[token] == nil { order.append(token) }
    titles[token] = trimmed
    while order.count > limit {
      titles.removeValue(forKey: order.removeFirst())
    }
  }

  static func title(for token: String) -> String? { titles[token] }
}

/// Minimal static fallback for the `/` trigger, ported from the retired
/// `WorkSlashCommandsSheet`. The host's discovered registry
/// (`chat.getSlashCommands`, rendered through `WorkComposerSlashRegistry`) is
/// the real source; this set only covers an older host that omits the command,
/// or the moment before the fetch lands.
enum WorkComposerSlashCatalog {
  static func commands(provider: String) -> [(command: String, description: String)] {
    switch provider.lowercased() {
    case "claude":
      return [
        ("/clear", "Drop prior context and start fresh."),
        ("/compact", "Summarize the visible conversation to free tokens."),
        ("/plan", "Ask the assistant to draft a plan."),
        ("/review", "Review the current diff."),
      ]
    case "codex":
      return [
        ("/compact", "Summarize the visible conversation to free tokens."),
        ("/explain", "Explain a file or change."),
        ("/refactor", "Propose a refactor."),
        ("/tests", "Write or run tests."),
        ("/review", "Review code or a diff."),
      ]
    case "opencode":
      return [
        ("/plan", "Ask the model for a plan before acting."),
        ("/explain", "Explain a file or change."),
        ("/review", "Review the current diff."),
      ]
    case "pi":
      return [
        ("/compact", "Summarize the visible conversation to free tokens."),
        ("/explain", "Explain a file or change."),
        ("/review", "Review the current diff."),
      ]
    case "copilot":
      return [
        ("/compact", "Summarize conversation history to reduce context use."),
        ("/context", "Show context window token usage."),
        ("/usage", "Show session usage and AI credits."),
        ("/review", "Run the code review agent on your changes."),
        ("/plan", "Create an implementation plan before coding."),
      ]
    case "muse":
      return [
        ("/compact", "Summarize the visible conversation to free tokens."),
        ("/goal", "Set, clear, or inspect the chat goal."),
        ("/review", "Review the current diff."),
      ]
    default:
      return [
        ("/help", "Show available commands."),
        ("/explain", "Explain a file or change."),
      ]
    }
  }

  static func suggestions(provider: String, query: String) -> [WorkComposerSuggestion] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return commands(provider: provider)
      .filter { trimmed.isEmpty || $0.command.dropFirst().lowercased().hasPrefix(trimmed) }
      .map {
        WorkComposerSuggestion(
          id: "slash:\($0.command)",
          kind: .slash,
          title: $0.command,
          subtitle: $0.description,
          insertText: $0.command
        )
      }
  }
}

/// The host's discovered slash-command registry, mapped to suggestion rows.
///
/// The desktop brain discovers each provider's real commands
/// (`claudeSlashCommandDiscovery`, `codexSlashCommandDiscovery`,
/// `cursorSlashCommandDiscovery`) and answers `chat.getSlashCommands`. iOS
/// renders that list instead of the hand-maintained `WorkComposerSlashCatalog`,
/// which drifts. When the host does not advertise the command (an older brain)
/// or the fetch has not landed yet, the minimal static catalog is the fallback,
/// so the typed `/` trigger always has something to show.
enum WorkComposerSlashRegistry {
  /// Upper bound on rows rendered from the host registry. A pathological host
  /// listing must not push an unbounded strip at the composer.
  static let maxCommands = 200

  /// Map a host command to a row, or nil when its name is unusable.
  static func suggestion(for command: HostSlashCommand) -> WorkComposerSuggestion? {
    let token = normalizedName(command.name)
    guard !token.isEmpty else { return nil }
    return WorkComposerSuggestion(
      id: "slash:\(token)",
      kind: .slash,
      title: token,
      subtitle: subtitle(for: command),
      insertText: token
    )
  }

  /// Filter and rank rows with the same tiers as `@` and the desktop:
  /// exact > prefix > word-prefix > substring > scattered letters, and scattered
  /// letters only when nothing better matched. This is what makes `/test` rank
  /// `test` first instead of drowning in long names that merely contain those
  /// letters.
  static func suggestions(from commands: [HostSlashCommand], query: String) -> [WorkComposerSuggestion] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty else {
      return commands.prefix(maxCommands).compactMap { suggestion(for: $0) }
    }
    var scored: [(suggestion: WorkComposerSuggestion, score: Int)] = []
    for command in commands {
      guard let suggestion = suggestion(for: command) else { continue }
      guard let score = slashScore(suggestion.title, trimmed) else { continue }
      scored.append((suggestion, score))
    }
    let best = scored.map(\.score).min()
    let keepScattered = (best ?? 0) >= 3
    let kept = scored.filter { keepScattered || $0.score < 3 }
      .sorted { lhs, rhs in
        if lhs.score != rhs.score { return lhs.score < rhs.score }
        return lhs.suggestion.title < rhs.suggestion.title
      }
    return kept.prefix(maxCommands).map(\.suggestion)
  }

  /// Tier score for one `/` token against a lowercased query, or nil for no match.
  private static func slashScore(_ name: String, _ query: String) -> Int? {
    let base = name.hasPrefix("/") ? String(name.dropFirst()) : name
    let target = base.lowercased()
    if target == query { return 0 }
    if target.hasPrefix(query) { return 1 }
    if wordPrefixHit(target, query) { return 1 }
    if target.contains(query) { return 2 }
    return subsequenceHit(target, query) ? 3 : nil
  }

  private static func wordPrefixHit(_ target: String, _ query: String) -> Bool {
    guard !query.isEmpty else { return false }
    return target
      .split(whereSeparator: { "-:/_ ".contains($0) })
      .contains { $0.hasPrefix(query) }
  }

  private static func subsequenceHit(_ target: String, _ query: String) -> Bool {
    var cursor = target.startIndex
    for character in query {
      guard let index = target[cursor...].firstIndex(of: character) else { return false }
      cursor = target.index(after: index)
    }
    return true
  }

  /// The host list when it has anything usable, else the minimal static set.
  static func suggestions(
    host: [HostSlashCommand]?,
    provider: String,
    query: String
  ) -> [WorkComposerSuggestion] {
    guard let host, !host.isEmpty else {
      return WorkComposerSlashCatalog.suggestions(provider: provider, query: query)
    }
    return suggestions(from: host, query: query)
  }

  /// A slash command token always starts with `/`; the host may omit it.
  static func normalizedName(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "" }
    return trimmed.hasPrefix("/") ? trimmed : "/\(trimmed)"
  }

  /// Name + description + whether it takes arguments, in one line. The
  /// argument hint is the host's own cue that the command accepts input.
  static func subtitle(for command: HostSlashCommand) -> String? {
    let description = command.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let hint = command.argumentHint?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    switch (description.isEmpty, hint.isEmpty) {
    case (false, false): return "\(description) · \(hint)"
    case (false, true): return description
    case (true, false): return hint
    case (true, true): return nil
    }
  }
}

/// Drives the inline suggestion strip: consumes trigger matches from the text
/// view, resolves suggestions (curated slash list locally, file quick-open over
/// sync), and hands committed selections back to the text view for splicing.
///
/// Visibility is derived purely from `activeMatch` — never from focus — so it
/// avoids the repo's "expansion state from @FocusState" bug class.
@MainActor
final class WorkComposerSuggestionController: ObservableObject {
  @Published private(set) var activeMatch: WorkComposerTriggerMatch?
  @Published private(set) var suggestions: [WorkComposerSuggestion] = []
  @Published private(set) var isLoading = false

  var provider: String = "" {
    didSet {
      guard oldValue != provider else { return }
      // A different provider advertises a completely different command set.
      resetSlashRegistry()
    }
  }
  var laneId: String? {
    didSet {
      // The cached workspace belongs to the previous lane; a stale entry
      // would make @ quick-open search the wrong worktree. The generation
      // bump plus cancel also invalidates the in-flight fetch, whose
      // post-await writes could otherwise restore the old lane's workspace
      // id, re-populate the cache, and publish old-lane rows.
      if oldValue != laneId {
        laneGeneration += 1
        fetchTask?.cancel()
        fetchTask = nil
        cachedWorkspaceId = nil
        fileCache.removeAll()
        fileCacheOrder.removeAll()
        // Slash commands are discovered per lane worktree, so a lane change
        // drops the previous lane's registry rather than showing its commands.
        resetSlashRegistry()
        if let match = activeMatch, match.kind == .at {
          // An @ trigger typed against the previous lane re-fetches against
          // the new one instead of keeping the superseded results.
          scheduleAtFetch(query: match.query)
        } else if isLoading {
          isLoading = false
        }
      }
    }
  }
  weak var syncService: SyncService?
  /// ADE's own `/side` command leads the `/` menu when this chat can open a
  /// side chat. It is not a provider command, so no host registry lists it.
  var offersSideChat = false
  /// The chat this composer belongs to, so the @ menu never offers the chat to
  /// itself. Nil on surfaces with no session yet.
  var sessionId: String?

  /// `@` rows arrive from two sources at different speeds: files from the
  /// lane's quick-open, entities from `chat.listMentionSuggestions`. Each lands
  /// in its own list and the menu is recombined, so a slow host never holds
  /// back the file rows.
  private var atFiles: [WorkComposerSuggestion] = []
  private var atMentions: [WorkComposerSuggestion] = []
  private var atFilter: WorkComposerSuggestionSection?
  private var atFilesPending = false
  private var atMentionsPending = false
  private var mentionTask: Task<Void, Never>?
  /// Bumped per `@` query; a mention response for an older query is dropped.
  private var atGeneration = 0
  static let mentionSuggestionAction = "chat.listMentionSuggestions"

  /// Wired by the text view: performs the splice on the live UITextView so
  /// first-responder state and selection survive the insertion.
  var onCommit: ((WorkComposerSuggestion, NSRange) -> Void)?

  /// The model chip the caret sits on (or just after, as right after it was
  /// inserted). Drives the thinking/permission menu above the field.
  @Published private(set) var editingModelChip: WorkModelMention?
  /// Wired by the text view: replaces one model token in the live draft.
  var onRewriteModelChip: ((NSRange, String) -> Void)?
  /// The last file rows, so model rows can be re-merged when the catalog lands.
  private var lastFileRows: [WorkComposerSuggestion] = []
  private var modelCatalogRequested = false
  private var modelCatalogTask: Task<Void, Never>?

  private var fetchTask: Task<Void, Never>?
  private var cachedWorkspaceId: String?
  /// Bumped on every lane change; every post-await write in a fetch compares
  /// its captured value so a superseded task cannot touch the new lane's state.
  private var laneGeneration = 0

  /// The host-discovered slash registry for the current provider, or nil until
  /// it lands. Nil (and an unsupported host) renders the minimal static
  /// fallback, so the `/` trigger is never empty.
  private var hostSlashCommands: [HostSlashCommand]?
  private var slashFetchTask: Task<Void, Never>?
  /// True once the registry cannot be fetched for this provider/lane — an older
  /// host that does not advertise it, or a failed/offline attempt. One attempt
  /// per provider/lane keeps an offline composer from re-asking on every
  /// keystroke; the static fallback covers the gap.
  private var slashRegistryUnavailable = false

  /// Per-lane quick-open results keyed by lowercased query (`""` is the browse
  /// list). Backspacing through a path is the common case on mobile and every
  /// prefix has already been fetched, so this turns a sync round-trip per
  /// keystroke into one per *new* query. Entries expire so a long-lived
  /// composer can't pin a stale listing after files change on the host.
  private var fileCache: [String: (items: [WorkComposerSuggestion], at: Date)] = [:]
  private var fileCacheOrder: [String] = []
  private static let fileCacheTTL: TimeInterval = 30
  private static let fileCacheMaxEntries = 32

  private func cachedFiles(_ key: String) -> [WorkComposerSuggestion]? {
    guard let entry = fileCache[key] else { return nil }
    guard Date().timeIntervalSince(entry.at) < Self.fileCacheTTL else {
      fileCache.removeValue(forKey: key)
      fileCacheOrder.removeAll { $0 == key }
      return nil
    }
    return entry.items
  }

  private func rememberFiles(_ key: String, _ items: [WorkComposerSuggestion]) {
    if fileCache[key] == nil { fileCacheOrder.append(key) }
    fileCache[key] = (items, Date())
    while fileCacheOrder.count > Self.fileCacheMaxEntries {
      let oldest = fileCacheOrder.removeFirst()
      fileCache.removeValue(forKey: oldest)
    }
  }

  /// Rows for the active `/` trigger: the host registry once fetched, else the
  /// minimal static catalog. Also kicks off the one-shot host fetch.
  private func refreshSlashSuggestions(query: String) {
    suggestions = workSideChatSlashSuggestions(offered: offersSideChat, query: query)
      + WorkComposerSlashRegistry.suggestions(
        host: hostSlashCommands,
        provider: provider,
        query: query
      )
    fetchSlashRegistryIfNeeded()
  }

  /// Drop the cached registry and any in-flight fetch. Called when the provider
  /// or the lane changes, because the host discovers commands per worktree.
  private func resetSlashRegistry() {
    hostSlashCommands = nil
    slashFetchTask?.cancel()
    slashFetchTask = nil
    slashRegistryUnavailable = false
    // The previous chat's commands must not chip as runnable in this one.
    WorkThreadEntityDirectory.shared.record(skillNames: [])
  }

  /// Fetch `chat.getSlashCommands` once per provider/lane. A host that does not
  /// advertise the command, or a fetch that fails (offline), leaves the static
  /// fallback in place and does not retry until the provider or lane changes.
  private func fetchSlashRegistryIfNeeded() {
    guard hostSlashCommands == nil, slashFetchTask == nil, !slashRegistryUnavailable else { return }
    guard let syncService, syncService.supportsSlashCommandRegistry else {
      slashRegistryUnavailable = true
      return
    }
    let provider = provider
    let laneId = laneId
    let generation = laneGeneration
    slashFetchTask = Task { [weak self] in
      defer { self?.slashFetchTask = nil }
      do {
        // `/side` is the phone's own row (`workSideChatSlashSuggestions`); a
        // host that also lists it must not draw it twice.
        let commands = try await syncService.getSlashCommands(provider: provider, laneId: laneId)
          .filter { WorkComposerSlashRegistry.normalizedName($0.name).lowercased() != "/side" }
        guard let self, !Task.isCancelled else { return }
        guard self.laneGeneration == generation, self.provider == provider else { return }
        self.hostSlashCommands = commands
        // The transcript chips `/name` only for commands this chat can run.
        WorkThreadEntityDirectory.shared.record(skillNames: commands.map(\.name))
        if let match = self.activeMatch, match.kind == .slash {
          self.suggestions = workSideChatSlashSuggestions(offered: self.offersSideChat, query: match.query)
            + WorkComposerSlashRegistry.suggestions(
              host: commands,
              provider: provider,
              query: match.query
            )
        }
      } catch {
        guard let self, !Task.isCancelled else { return }
        self.slashRegistryUnavailable = true
      }
    }
  }

  var isVisible: Bool {
    activeMatch != nil && (isLoading || !suggestions.isEmpty)
  }

  func update(match: WorkComposerTriggerMatch?) {
    guard let match else {
      clear()
      return
    }
    // Ignore a no-op re-detection of the same span+query to avoid re-fetching
    // on cursor-only movements that don't change the trigger.
    if let current = activeMatch, current == match { return }
    activeMatch = match

    switch match.kind {
    case .slash:
      fetchTask?.cancel()
      mentionTask?.cancel()
      isLoading = false
      refreshSlashSuggestions(query: match.query)
    case .at:
      // Load the model catalog alongside the files/entities, so the menu can
      // offer models before the picker was ever opened.
      fetchModelCatalogIfNeeded()
      scheduleAtFetch(query: match.query)
    case .hash:
      mentionTask?.cancel()
      schedulePrFetch(query: match.query)
    }
  }

  func setEditingModelChip(_ chip: WorkModelMention?) {
    if editingModelChip != chip { editingModelChip = chip }
  }

  /// Rewrite the chip being edited with a new thinking level or permission mode.
  func rewriteEditingModelChip(effort: String?, permission: String?) {
    guard let chip = editingModelChip else { return }
    let token = WorkModelMentionDetector.formatToken(modelId: chip.modelId, effort: effort, permission: permission)
    guard token != chip.token else { return }
    onRewriteModelChip?(chip.range, token)
  }

  /// `@` rows for models the query names, from the catalog the model picker
  /// uses. Pure over the directory so the ranking stays the shared one.
  static func modelSuggestions(query: String) -> (rows: [WorkComposerSuggestion], bestScore: Int?) {
    let directory = WorkModelMentionDirectory.shared
    let ranked = WorkModelMentionDetector.rank(
      directory.availableEntries,
      query: query,
      recentModelIds: directory.recentModelIds
    )
    let rows = ranked.rows.map { entry in
      WorkComposerSuggestion(
        id: "model:\(entry.modelId)",
        kind: .at,
        title: entry.title,
        subtitle: entry.subtitle,
        insertText: WorkModelMentionDetector.formatToken(
          modelId: entry.modelId,
          effort: entry.defaultEffort,
          permission: WorkModelMentionDetector.defaultPermission(provider: entry.provider)
        ),
        modelId: entry.modelId
      )
    }
    return (rows, ranked.bestScore)
  }

  /// File rows plus model rows. A name hit on a model (exact or prefix) leads,
  /// so `@deep` offers the model first; weaker model hits follow the files.
  private func mergedAtRows(files: [WorkComposerSuggestion]) -> [WorkComposerSuggestion] {
    guard let query = activeMatch?.query else { return files }
    let models = Self.modelSuggestions(query: query)
    guard !models.rows.isEmpty else { return files }
    return (models.bestScore ?? 99) <= 1 ? models.rows + files : files + models.rows
  }

  /// Load the host model catalog once, the same call the model picker makes,
  /// so the `@` menu can offer models before the picker was ever opened.
  private func fetchModelCatalogIfNeeded() {
    guard !modelCatalogRequested, let syncService else { return }
    modelCatalogRequested = true
    // The `@` menu can open before the picker ever loaded recents.
    let revision = WorkModelMentionDirectory.shared.recentsRevisionSnapshot
    Task {
      if let recents = try? await syncService.getModelRecents() {
        WorkModelMentionDirectory.shared.record(recents: recents, ifRevision: revision)
      }
    }
    if let cached = syncService.cachedChatModelCatalog() {
      WorkModelMentionDirectory.shared.record(catalog: cached)
      return
    }
    modelCatalogTask = Task { [weak self] in
      let catalog = try? await syncService.getChatModelCatalog()
      guard let self, !Task.isCancelled else { return }
      // A failed fetch must not latch the guard: the next `@` trigger retries.
      guard catalog != nil else {
        self.modelCatalogRequested = false
        return
      }
      guard self.activeMatch?.kind == .at, !self.isLoading else { return }
      // Route through the sectioned rebuild so the model rows land in the
      // Files section next to the file rows rather than flattening the menu.
      self.recombineAt()
    }
  }

  func commit(_ suggestion: WorkComposerSuggestion) {
    guard let match = activeMatch else { return }
    if let modelId = suggestion.modelId {
      // Shared with the picker's Recents, so the next `@` leads with it.
      WorkModelMentionDirectory.shared.noteRecent(modelId)
      let revision = WorkModelMentionDirectory.shared.recentsRevisionSnapshot
      if let syncService {
        Task {
          if let recents = try? await syncService.pushModelRecent(modelId) {
            WorkModelMentionDirectory.shared.record(recents: recents, ifRevision: revision)
          }
        }
      }
    }
    let commitMatch = WorkComposerTriggerDetector.matchForSelection(match, suggestion: suggestion)
    if suggestion.mentionKind != nil || suggestion.kind == .hash {
      WorkComposerMentionTitleCache.remember(token: suggestion.insertText, title: suggestion.title)
    }
    onCommit?(suggestion, commitMatch.range)
    clear()
  }

  func clear() {
    fetchTask?.cancel()
    fetchTask = nil
    mentionTask?.cancel()
    mentionTask = nil
    atGeneration += 1
    atFiles = []
    atMentions = []
    atFilter = nil
    atFilesPending = false
    atMentionsPending = false
    if activeMatch != nil { activeMatch = nil }
    if !suggestions.isEmpty { suggestions = [] }
    if isLoading { isLoading = false }
  }

  /// Whether the connected host can answer `@` entity suggestions. An older
  /// brain simply omits the action, and the menu stays files-only.
  private var mentionsAvailable: Bool {
    syncService?.supportsViewerRemoteAction(Self.mentionSuggestionAction) == true
  }

  /// One `@` query: files and entities in parallel, merged by section.
  private func scheduleAtFetch(query: String) {
    let parsed = WorkComposerSuggestionSection.parseAtQuery(query)
    atFilter = parsed.filter
    atGeneration += 1
    let generation = atGeneration

    if parsed.filter == nil || parsed.filter == .files {
      scheduleFileFetch(query: WorkComposerTriggerDetector.fileSearchQuery(for: parsed.rest))
    } else {
      fetchTask?.cancel()
      fetchTask = nil
      atFiles = []
      atFilesPending = false
    }

    mentionTask?.cancel()
    mentionTask = nil
    if parsed.filter != .files, mentionsAvailable, let sync = syncService {
      atMentionsPending = true
      // A section filter is re-sent as the host's own kind word, so the host
      // narrows server-side and returns that kind's full list rather than a
      // mixed best-match list the client then thins out.
      let mentionQuery: String
      switch parsed.filter {
      case .chats: mentionQuery = "chat \(parsed.rest)"
      case .lanes: mentionQuery = "lane \(parsed.rest)"
      case .terminals: mentionQuery = "terminal \(parsed.rest)"
      case .pullRequests: mentionQuery = "pr \(parsed.rest)"
      case .machines: mentionQuery = "machine \(parsed.rest)"
      case .mcpServers: mentionQuery = "mcp \(parsed.rest)"
      case .files, .commands, nil: mentionQuery = parsed.rest
      }
      let excludeSessionId = sessionId
      mentionTask = Task { [weak self] in
        // Debounced harder than files: this is a host round-trip per query.
        try? await Task.sleep(nanoseconds: 120_000_000)
        guard !Task.isCancelled else { return }
        let rows = (try? await sync.listChatMentionSuggestions(
          query: mentionQuery.trimmingCharacters(in: .whitespaces),
          excludeSessionId: excludeSessionId
        )) ?? []
        guard !Task.isCancelled else { return }
        await MainActor.run {
          guard let self, self.atGeneration == generation else { return }
          self.atMentions = Self.mentionSuggestions(from: rows)
          self.atMentionsPending = false
          self.recombineAt()
        }
      }
    } else {
      atMentions = []
      atMentionsPending = false
    }
    recombineAt()
  }

  /// Pure — and deliberately `nonisolated` — so the token form is testable
  /// without a sync service or a main-actor hop.
  nonisolated static func mentionSuggestions(from rows: [ChatMentionSuggestionRow]) -> [WorkComposerSuggestion] {
    rows.compactMap { row -> WorkComposerSuggestion? in
      guard let kind = WorkChatMention.Kind.from(suggestionKind: row.kind) else { return nil }
      let id = row.id.trimmingCharacters(in: .whitespacesAndNewlines)
      // The token grammar only admits this charset; an id outside it would
      // serialize into a token no surface can parse back.
      guard !id.isEmpty,
            id.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
      else { return nil }
      let title = row.title.trimmingCharacters(in: .whitespacesAndNewlines)
      return WorkComposerSuggestion(
        id: "mention:\(kind.tokenPrefix):\(id)",
        kind: .at,
        title: title.isEmpty ? id : title,
        subtitle: row.subtitle,
        insertText: WorkChatMentionDetector.formatToken(kind: kind, id: id),
        mentionKind: kind
      )
    }
  }

  /// Rebuilds the visible `@` list from the two sources. Unfiltered, each
  /// section shows a few recent rows; a prefix filter shows one section deep.
  private func recombineAt() {
    guard activeMatch?.kind == .at else { return }
    let sections = atFilter.map { [$0] } ?? WorkComposerSuggestionSection.atMenuOrder
    // Five per section unfiltered, matching the desktop menu.
    let mentionCap = atFilter == nil ? 5 : 20
    let fileCap = atFilter == nil ? 8 : 20
    var rows: [WorkComposerSuggestion] = []
    for section in sections {
      if section == .files {
        // Model rows the query names lead or follow the file rows, exactly as
        // the desktop's flat `@` list orders them.
        rows.append(contentsOf: mergedAtRows(files: Array(atFiles.prefix(fileCap))))
      } else {
        rows.append(contentsOf: atMentions.filter { $0.section == section }.prefix(mentionCap))
      }
    }
    isLoading = atFilesPending || atMentionsPending
    suggestions = rows
  }

  private func scheduleFileFetch(query: String) {
    fetchTask?.cancel()
    let cacheKey = query.lowercased()
    if let cached = cachedFiles(cacheKey) {
      fetchTask = nil
      atFilesPending = false
      finishFiles(cached)
      return
    }
    atFilesPending = true
    isLoading = true
    let laneId = laneId
    let sync = syncService
    let generation = laneGeneration
    fetchTask = Task { [weak self] in
      // Small debounce so rapid typing doesn't spawn a fetch per keystroke.
      try? await Task.sleep(nanoseconds: 40_000_000)
      guard !Task.isCancelled else { return }
      guard let self, let sync, let laneId, !laneId.isEmpty else {
        await MainActor.run { self?.finishFiles([]) }
        return
      }
      do {
        let workspaceId = try await self.resolveWorkspaceId(
          laneId: laneId,
          sync: sync,
          generation: generation
        )
        guard !Task.isCancelled, self.laneGeneration == generation, let workspaceId else {
          await MainActor.run {
            guard self.laneGeneration == generation else { return }
            self.finishFiles([])
          }
          return
        }
        // Attaching a file is not searching for one: a user who types `@.env`
        // or `@build/out.log` means it, so composer suggestions keep reaching
        // into ignored trees even though Files search now defaults to skipping
        // them.
        // Folders are suggestable too: "work on @src/main" is an ordinary
        // instruction, and an @ selection on iOS only ever splices a pointer
        // into the draft — it never stages an attachment — so a directory,
        // which has no bytes to upload, is safe to offer here.
        let items = try await sync.quickOpen(
          workspaceId: workspaceId,
          query: query,
          limit: 20,
          includeIgnored: true,
          allowComposerPrefixFallback: true,
          includeDirectories: true
        )
        guard !Task.isCancelled, self.laneGeneration == generation else { return }
        let mapped = items.map { item -> WorkComposerSuggestion in
          let name = (item.path as NSString).lastPathComponent
          let dir = (item.path as NSString).deletingLastPathComponent
          let isDirectory = item.isDirectory == true
          return WorkComposerSuggestion(
            id: "file:\(item.path)",
            kind: .at,
            title: name.isEmpty ? item.path : name,
            subtitle: dir.isEmpty ? (isDirectory ? "Folder" : nil) : dir,
            insertText: "@\(item.path)",
            isDirectory: isDirectory
          )
        }
        await MainActor.run {
          guard self.laneGeneration == generation else { return }
          // Only successful fetches are cached — caching the `[]` from a failed
          // round-trip would pin an empty list for the whole TTL.
          self.rememberFiles(cacheKey, mapped)
          self.finishFiles(mapped)
        }
      } catch {
        guard !Task.isCancelled else { return }
        await MainActor.run {
          guard self.laneGeneration == generation else { return }
          self.finishFiles([])
        }
      }
    }
  }

  private func finishFiles(_ items: [WorkComposerSuggestion]) {
    // Only apply while an `@` trigger is still active — a later slash/no trigger
    // may have superseded this fetch.
    guard activeMatch?.kind == .at else { return }
    // Record the file rows (a late model-catalog fetch re-merges through
    // `recombineAt`), then rebuild the sectioned list.
    lastFileRows = items
    atFiles = items
    atFilesPending = false
    recombineAt()
  }

  /// `#` rows come from the pull requests this project has ALREADY synced, so
  /// the menu answers from the local database rather than a host round-trip.
  /// Mirrors the desktop's `searchPullRequests`: detached rows are history and
  /// never offered, a numeric query prefix-matches the PR number, and anything
  /// else matches the title or the number.
  private func schedulePrFetch(query: String) {
    fetchTask?.cancel()
    isLoading = true
    let sync = syncService
    let generation = laneGeneration
    fetchTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 40_000_000)
      guard !Task.isCancelled else { return }
      guard let self, let sync else {
        await MainActor.run { self?.finishPrs([]) }
        return
      }
      let items = (try? await sync.fetchPullRequestListItems()) ?? []
      guard !Task.isCancelled, self.laneGeneration == generation else { return }
      let mapped = Self.prSuggestions(from: items, query: query)
      await MainActor.run {
        guard self.laneGeneration == generation else { return }
        self.finishPrs(mapped)
      }
    }
  }

  /// Pure — and deliberately `nonisolated` — so the ranking and the token are
  /// testable without a sync service or a main-actor hop.
  nonisolated static func prSuggestions(
    from items: [PullRequestListItem],
    query: String,
    limit: Int = 20
  ) -> [WorkComposerSuggestion] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let isNumeric = !trimmed.isEmpty && trimmed.allSatisfy { $0.isASCII && $0.isNumber }
    return items
      .filter { item in
        guard item.detached == nil else { return false }
        guard !trimmed.isEmpty else { return true }
        let number = String(item.githubPrNumber)
        if isNumeric { return number.hasPrefix(trimmed) }
        return item.title.lowercased().contains(trimmed) || number.hasPrefix(trimmed)
      }
      .prefix(limit)
      .compactMap { item -> WorkComposerSuggestion? in
        // The token is the PR's github url, exactly as the desktop inserts it,
        // so the sent message draws the same PR pill on every surface.
        let repo = item.repoOwner.isEmpty || item.repoName.isEmpty
          ? nil
          : "\(item.repoOwner)/\(item.repoName)"
        // Synthesize a url ONLY from a complete repo. With an empty owner or
        // name this used to build a github.com url with empty path segments
        // where the owner and repo belong, which no chip parser recognises —
        // the row looked insertable and produced a dead link. A row we cannot
        // address is better left out of the menu entirely.
        let url: String
        if !item.githubUrl.isEmpty {
          url = item.githubUrl
        } else if let repo {
          url = "https://github.com/\(repo)/pull/\(item.githubPrNumber)"
        } else {
          return nil
        }
        let label = repo.map { "\($0)#\(item.githubPrNumber)" } ?? "#\(item.githubPrNumber)"
        return WorkComposerSuggestion(
          id: "pr:\(item.id)",
          kind: .hash,
          title: label,
          subtitle: item.title.isEmpty ? nil : item.title,
          insertText: url
        )
      }
  }

  private func finishPrs(_ items: [WorkComposerSuggestion]) {
    guard activeMatch?.kind == .hash else { return }
    isLoading = false
    suggestions = items
  }

  private func resolveWorkspaceId(
    laneId: String,
    sync: SyncService,
    generation: Int
  ) async throws -> String? {
    if let cachedWorkspaceId { return cachedWorkspaceId }
    let workspaces = try await sync.listWorkspaces()
    let resolved = workFilesWorkspace(for: laneId, in: workspaces)?.id
    // A lane change during the await means this id belongs to the old lane:
    // return it un-cached so the new lane's fetch resolves its own workspace.
    if let resolved, laneGeneration == generation { cachedWorkspaceId = resolved }
    return resolved
  }
}

// MARK: - Composer pills

extension NSAttributedString.Key {
  /// The raw grammar token a composer pill stands for (`@chat:abc`, a URL,
  /// `@src/foo.ts`, or `attachment:<uuid>` for an attachment pill, whose
  /// `[Image #k]` number is only decided at serialization time). Inspection
  /// aid; serialization reads the pill's own source.
  static let workComposerPillToken = NSAttributedString.Key("workComposerPillToken")
}

/// What a pill draws: an icon (or a 14pt thumbnail) and a short label.
struct WorkComposerPillSpec {
  var symbolName: String
  var label: String
  var monospaced = false
  var thumbnail: UIImage? = nil
  var isWarning = false
  var isPending = false

  func drawsSame(as other: WorkComposerPillSpec) -> Bool {
    symbolName == other.symbolName
      && label == other.label
      && monospaced == other.monospaced
      && thumbnail === other.thumbnail
      && isWarning == other.isWarning
      && isPending == other.isPending
  }
}

/// One pill in the composer's text storage: a single U+FFFC character whose
/// attachment carries what it serializes back to.
///
/// The storage is NOT the draft. The draft (`draftState.text`, the persisted
/// draft, what `chat.send` carries) is the grammar text that
/// `WorkComposerPillEngine.serialize` rebuilds from these pills, so every
/// surface that reads plain text keeps reading the same tokens.
final class WorkComposerPillAttachment: NSTextAttachment {
  enum Source: Equatable {
    /// A fixed token: a mention, a link, an `@path`, a slash command.
    case token(String)
    /// A staged attachment. Its `[Image #k]` / `[File #k: name]` token follows
    /// the attachment's position, so removing an earlier one renumbers it.
    case attachment(UUID)
  }

  let source: Source
  let spec: WorkComposerPillSpec

  init(source: Source, spec: WorkComposerPillSpec) {
    self.source = source
    self.spec = spec
    super.init(data: nil, ofType: nil)
    // Read by VoiceOver in place of the object-replacement character.
    accessibilityLabel = spec.label
  }

  required init?(coder: NSCoder) {
    return nil
  }
}

/// The over-limit notice is a failed tray row, not an attachment: it has no
/// number and no pill.
func workChatInputAttachmentIsLimitNotice(_ attachment: WorkChatInputAttachment) -> Bool {
  attachment.filename == "attachment-limit" && attachment.errorMessage != nil
}

/// Where an attachment sits in the shared numbering.
struct WorkComposerAttachmentNumber: Equatable {
  let kind: WorkAttachmentToken.Kind
  let ordinal: Int
  let token: String
}

enum WorkComposerPillRenderer {
  static let maxLabelWidth: CGFloat = 180
  static let iconSide: CGFloat = 14

  /// Rasterizes one pill. Colors are resolved against `traits`, so a light /
  /// dark switch re-renders (see `WorkComposerPastingTextView.onTraitsChange`).
  static func render(
    _ spec: WorkComposerPillSpec,
    tint: UIColor,
    font: UIFont,
    traits: UITraitCollection
  ) -> (image: UIImage, bounds: CGRect) {
    let labelSize = max(11, font.pointSize - 2)
    let labelFont: UIFont = spec.monospaced
      ? .monospacedSystemFont(ofSize: labelSize - 1, weight: .semibold)
      : .systemFont(ofSize: labelSize, weight: .semibold)
    let isDark = traits.userInterfaceStyle == .dark
    let resolvedTint = (spec.isWarning ? UIColor(ADEColor.warning) : tint).resolvedColor(with: traits)
    let textColor = UIColor(ADEColor.textPrimary).resolvedColor(with: traits)

    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    let attributes: [NSAttributedString.Key: Any] = [
      .font: labelFont,
      .foregroundColor: textColor,
      .paragraphStyle: paragraph,
    ]
    let label = spec.label as NSString
    let labelWidth = min(ceil(label.size(withAttributes: attributes).width), maxLabelWidth)
    let horizontalPadding: CGFloat = 6
    let gap: CGFloat = 4
    let margin: CGFloat = 1.5
    let height = ceil(labelFont.lineHeight) + 5
    let pillWidth = horizontalPadding + iconSide + gap + labelWidth + horizontalPadding + 1
    let size = CGSize(width: pillWidth + margin * 2, height: height)

    let format = UIGraphicsImageRendererFormat(for: traits)
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      if spec.isPending { context.cgContext.setAlpha(0.55) }
      let pillRect = CGRect(x: margin, y: 0.5, width: pillWidth, height: height - 1)
      let shape = UIBezierPath(roundedRect: pillRect, cornerRadius: min(8, pillRect.height / 2))
      resolvedTint.withAlphaComponent(isDark ? 0.22 : 0.12).setFill()
      shape.fill()
      resolvedTint.withAlphaComponent(isDark ? 0.42 : 0.30).setStroke()
      shape.lineWidth = 0.75
      shape.stroke()

      let iconRect = CGRect(
        x: margin + horizontalPadding,
        y: (height - iconSide) / 2,
        width: iconSide,
        height: iconSide
      )
      if let thumbnail = spec.thumbnail {
        context.cgContext.saveGState()
        UIBezierPath(roundedRect: iconRect, cornerRadius: 3.5).addClip()
        drawAspectFill(thumbnail, in: iconRect)
        context.cgContext.restoreGState()
        resolvedTint.withAlphaComponent(0.35).setStroke()
        let ring = UIBezierPath(roundedRect: iconRect, cornerRadius: 3.5)
        ring.lineWidth = 0.5
        ring.stroke()
      } else {
        let configuration = UIImage.SymbolConfiguration(pointSize: labelSize - 3, weight: .semibold)
        if let symbol = UIImage(systemName: spec.symbolName, withConfiguration: configuration)?
          .withTintColor(resolvedTint, renderingMode: .alwaysOriginal) {
          let symbolSize = symbol.size
          symbol.draw(in: CGRect(
            x: iconRect.midX - symbolSize.width / 2,
            y: iconRect.midY - symbolSize.height / 2,
            width: symbolSize.width,
            height: symbolSize.height
          ))
        }
      }

      let labelRect = CGRect(
        x: iconRect.maxX + gap,
        y: (height - labelFont.lineHeight) / 2,
        width: labelWidth,
        height: ceil(labelFont.lineHeight)
      )
      label.draw(
        with: labelRect,
        options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
        attributes: attributes,
        context: nil
      )
    }
    // Centre the pill on the cap height so it sits on the text line rather
    // than hanging from the baseline.
    let center = font.capHeight / 2
    let bounds = CGRect(x: 0, y: (center - size.height / 2).rounded(), width: size.width, height: size.height)
    return (image, bounds)
  }

  /// A small square thumbnail for an image pill, so a 2400px upload render is
  /// not redrawn into a 14pt box on every re-render.
  static func thumbnail(_ image: UIImage, side: CGFloat = 42) -> UIImage {
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = false
    let rect = CGRect(x: 0, y: 0, width: side, height: side)
    return UIGraphicsImageRenderer(size: rect.size, format: format).image { _ in
      drawAspectFill(image, in: rect)
    }
  }

  private static func drawAspectFill(_ image: UIImage, in rect: CGRect) {
    let size = image.size
    guard size.width > 0, size.height > 0 else { return }
    let scale = max(rect.width / size.width, rect.height / size.height)
    let drawn = CGSize(width: size.width * scale, height: size.height * scale)
    image.draw(in: CGRect(
      x: rect.midX - drawn.width / 2,
      y: rect.midY - drawn.height / 2,
      width: drawn.width,
      height: drawn.height
    ))
  }
}

// MARK: - Big paste → file

/// A text paste over 40 lines or 3,000 characters becomes a temp text file
/// attachment instead of flooding the prompt. Shared rule with the desktop
/// composer; keep the thresholds and the extension sniffing in step.
enum WorkComposerBigPaste {
  static let lineThreshold = 40
  static let characterThreshold = 3000

  /// Lines in the paste, with CRLF / CR treated as LF and one trailing newline
  /// not counting as an extra empty line.
  static func lineCount(_ text: String) -> Int {
    var normalized = text
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
    if normalized.hasSuffix("\n") { normalized.removeLast() }
    guard !normalized.isEmpty else { return 0 }
    return normalized.split(separator: "\n", omittingEmptySubsequences: false).count
  }

  /// Strictly more than the thresholds; the character count is UTF-16 units,
  /// the same unit the desktop's `string.length` counts.
  static func qualifies(_ text: String) -> Bool {
    lineCount(text) > lineThreshold || (text as NSString).length > characterThreshold
  }

  private static let logLineRegex = try! NSRegularExpression(
    pattern: "^\\s*\\[?(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}|\\d{2}:\\d{2}:\\d{2}|(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\\b)",
    options: [.caseInsensitive]
  )

  /// `.diff` for a git diff, `.json` for a JSON object or array, `.log` when
  /// most lines open with a timestamp or a level, `.txt` otherwise.
  static func fileExtension(for text: String) -> String {
    let lines = text
      .replacingOccurrences(of: "\r\n", with: "\n")
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map(String.init)
    if lines.contains(where: { $0.hasPrefix("diff --git ") })
      || (lines.contains(where: { $0.hasPrefix("--- ") })
        && lines.contains(where: { $0.hasPrefix("+++ ") })
        && lines.contains(where: { $0.hasPrefix("@@") })) {
      return "diff"
    }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if let first = trimmed.first, first == "{" || first == "[",
       let parsed = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)),
       parsed is [Any] || parsed is [String: Any] {
      return "json"
    }
    let nonEmpty = lines.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    if nonEmpty.count >= 3 {
      let matching = nonEmpty.filter { line in
        logLineRegex.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) != nil
      }.count
      if Double(matching) / Double(nonEmpty.count) >= 0.6 { return "log" }
    }
    return "txt"
  }

  static func filename(for text: String, at date: Date) -> String {
    "pasted-\(Int64(date.timeIntervalSince1970 * 1000)).\(fileExtension(for: text))"
  }

  /// The staged file. It rides the same chunked file upload as a picked
  /// document (`workChatStageAttachmentOnHost`, kind `.file`).
  static func attachment(for text: String, at date: Date = Date()) -> WorkChatInputAttachment {
    let filename = filename(for: text, at: date)
    let mimeType: String
    switch (filename as NSString).pathExtension {
    case "json": mimeType = "application/json"
    case "diff": mimeType = "text/x-diff"
    default: mimeType = "text/plain"
    }
    return WorkChatInputAttachment(
      uploadData: Data(text.utf8),
      filename: filename,
      mimeType: mimeType,
      kind: .file,
      state: .ready
    )
  }
}

private let workComposerPastedFilenameRegex = try! NSRegularExpression(
  pattern: "^pasted-\\d+\\.(txt|log|json|diff)$",
  options: []
)

func workComposerIsPastedTextFilename(_ name: String) -> Bool {
  workComposerPastedFilenameRegex.firstMatch(
    in: name,
    range: NSRange(location: 0, length: (name as NSString).length)
  ) != nil
}

// MARK: - Pill engine

/// Owns the composer's pills: turning grammar text into pills (hydrate), pills
/// back into grammar text (serialize), and keeping attachment pills and the
/// staged attachment list in lockstep in both directions.
///
/// Shared by the chat composer and the start-chat composer, so the two cannot
/// drift on what a pill means.
@MainActor
final class WorkComposerPillEngine {
  weak var textView: UITextView?

  /// The draft as SwiftUI holds it, and how to write it back.
  var readDraft: () -> String = { "" }
  var writeDraft: (String) -> Void = { _ in }
  /// Staged attachments. Nil on surfaces that stage none.
  var attachmentsBinding: () -> Binding<[WorkChatInputAttachment]>? = { nil }
  /// Whether a big text paste may become a file attachment here.
  var acceptsPastedFiles: () -> Bool = { false }
  var tint: () -> UIColor = { UIColor(ADEColor.accent) }

  /// The draft text this engine last agreed with SwiftUI on. A draft that no
  /// longer matches it was changed from outside (send-clear, a restore,
  /// dictation, a stash) and is hydrated again.
  private(set) var syncedText = ""
  /// A serialization queued for SwiftUI from inside a view update. While it is
  /// pending, the stale draft must not be read back as an outside change.
  private var pendingPublish: String?
  private var lastAttachmentSignature = ""
  private var knownAttachmentPillIds: Set<UUID> = []
  private var chipifyAfterPaste = false
  private var thumbnails: [UUID: UIImage] = [:]
  private var pastedLineCounts: [UUID: Int] = [:]

  var font: UIFont { UIFont.preferredFont(forTextStyle: .body) }

  var baseAttributes: [NSAttributedString.Key: Any] {
    [
      .font: font,
      .foregroundColor: UIColor(ADEColor.textPrimary),
    ]
  }

  // MARK: Attachments + numbering

  var attachments: [WorkChatInputAttachment] {
    attachmentsBinding()?.wrappedValue ?? []
  }

  /// Attachments that carry a number, in tray order.
  var numberedAttachments: [WorkChatInputAttachment] {
    attachments.filter { !workChatInputAttachmentIsLimitNotice($0) }
  }

  /// Positional numbering, the same rule the host labels attachments with:
  /// images count among images, everything else among files.
  static func attachmentNumbers(_ list: [WorkChatInputAttachment]) -> [UUID: WorkComposerAttachmentNumber] {
    var images = 0
    var files = 0
    var out: [UUID: WorkComposerAttachmentNumber] = [:]
    for attachment in list {
      if attachment.kind == .image {
        images += 1
        out[attachment.id] = WorkComposerAttachmentNumber(
          kind: .image,
          ordinal: images,
          token: WorkAttachmentTokenGrammar.token(kind: .image, ordinal: images)
        )
      } else {
        files += 1
        out[attachment.id] = WorkComposerAttachmentNumber(
          kind: .file,
          ordinal: files,
          token: WorkAttachmentTokenGrammar.token(kind: .file, ordinal: files, name: attachment.filename)
        )
      }
    }
    return out
  }

  private var attachmentSignature: String {
    attachments.map { attachment in
      let state: String
      switch attachment.state {
      case .loading: state = "l"
      case .ready: state = "r"
      case .failed: state = "f"
      }
      return "\(attachment.id.uuidString):\(state):\(attachment.image == nil ? 0 : 1):\(attachment.filename)"
    }.joined(separator: ",")
  }

  // MARK: Serialize

  /// The grammar text for `range` (default: everything). A pill becomes its
  /// token; an attachment pill whose attachment is gone becomes nothing.
  func serialize(range: NSRange? = nil) -> String {
    guard let storage = textView?.textStorage else { return "" }
    let full = range ?? NSRange(location: 0, length: storage.length)
    guard full.length > 0, NSMaxRange(full) <= storage.length else { return "" }
    let ns = storage.string as NSString
    let numbers = Self.attachmentNumbers(numberedAttachments)
    var out = ""
    var cursor = full.location
    storage.enumerateAttribute(.attachment, in: full, options: []) { value, run, _ in
      guard let pill = value as? WorkComposerPillAttachment else { return }
      if run.location > cursor {
        out += ns.substring(with: NSRange(location: cursor, length: run.location - cursor))
      }
      let token: String
      switch pill.source {
      case .token(let raw): token = raw
      case .attachment(let id): token = numbers[id]?.token ?? ""
      }
      out += String(repeating: token, count: run.length)
      cursor = NSMaxRange(run)
    }
    if cursor < NSMaxRange(full) {
      out += ns.substring(with: NSRange(location: cursor, length: NSMaxRange(full) - cursor))
    }
    return out.replacingOccurrences(of: "\u{FFFC}", with: "")
  }

  /// The storage text with every pill read as a space. Same UTF-16 length, so
  /// offsets line up with the storage, and a pill bounds a token the way
  /// whitespace would.
  func scanningString() -> NSString {
    guard let storage = textView?.textStorage else { return "" }
    return storage.string.replacingOccurrences(of: "\u{FFFC}", with: " ") as NSString
  }

  // MARK: Pills

  func pillString(source: WorkComposerPillAttachment.Source, spec: WorkComposerPillSpec) -> NSAttributedString {
    let attachment = WorkComposerPillAttachment(source: source, spec: spec)
    render(attachment)
    var attributes = baseAttributes
    attributes[.attachment] = attachment
    switch source {
    case .token(let raw): attributes[.workComposerPillToken] = raw
    case .attachment(let id): attributes[.workComposerPillToken] = "attachment:\(id.uuidString)"
    }
    return NSAttributedString(string: "\u{FFFC}", attributes: attributes)
  }

  private func render(_ attachment: WorkComposerPillAttachment) {
    let traits = textView?.traitCollection ?? UITraitCollection.current
    let rendered = WorkComposerPillRenderer.render(attachment.spec, tint: tint(), font: font, traits: traits)
    attachment.image = rendered.image
    attachment.bounds = rendered.bounds
  }

  func pillString(for chip: WorkChip) -> NSAttributedString {
    let label: String
    switch chip.origin {
    case .mention:
      label = WorkComposerMentionTitleCache.title(for: chip.canonicalText) ?? chip.label
    case .link(let link):
      label = WorkComposerMentionTitleCache.title(for: link.url) ?? link.pillLabel
    case .path, .attachment, .model, .permission, .skill, .browserTab:
      label = chip.label
    }
    return pillString(
      source: .token(chip.canonicalText),
      spec: WorkComposerPillSpec(symbolName: chip.kind.symbolName, label: label)
    )
  }

  func pillString(for suggestion: WorkComposerSuggestion) -> NSAttributedString {
    let label: String
    switch suggestion.kind {
    case .slash: label = suggestion.insertText
    case .hash, .at: label = suggestion.title
    }
    return pillString(
      source: .token(suggestion.insertText),
      spec: WorkComposerPillSpec(
        symbolName: suggestion.symbolName,
        label: label,
        monospaced: suggestion.kind == .slash
      )
    )
  }

  func pillString(forAttachment id: UUID) -> NSAttributedString? {
    let list = numberedAttachments
    guard let attachment = list.first(where: { $0.id == id }),
          let number = Self.attachmentNumbers(list)[id] else { return nil }
    return pillString(source: .attachment(id), spec: spec(for: attachment, number: number))
  }

  private func spec(for attachment: WorkChatInputAttachment, number: WorkComposerAttachmentNumber) -> WorkComposerPillSpec {
    var spec: WorkComposerPillSpec
    if attachment.kind == .image {
      spec = WorkComposerPillSpec(symbolName: "photo", label: "Image \(number.ordinal)")
      spec.thumbnail = thumbnail(for: attachment)
    } else {
      spec = WorkComposerPillSpec(
        symbolName: attachment.kind == .video ? "film" : "doc.text",
        label: fileLabel(for: attachment)
      )
    }
    if attachment.errorMessage != nil {
      spec.symbolName = "exclamationmark.triangle.fill"
      spec.thumbnail = nil
      spec.isWarning = true
    }
    spec.isPending = attachment.isLoading
    return spec
  }

  private func fileLabel(for attachment: WorkChatInputAttachment) -> String {
    if let lines = pastedLineCount(for: attachment) {
      return "Pasted · \(lines) \(lines == 1 ? "line" : "lines")"
    }
    return attachment.filename
  }

  private func pastedLineCount(for attachment: WorkChatInputAttachment) -> Int? {
    guard workComposerIsPastedTextFilename(attachment.filename) else { return nil }
    if let cached = pastedLineCounts[attachment.id] { return cached }
    guard let data = attachment.uploadData,
          let text = String(data: data, encoding: .utf8) else { return nil }
    let count = WorkComposerBigPaste.lineCount(text)
    pastedLineCounts[attachment.id] = count
    return count
  }

  private func thumbnail(for attachment: WorkChatInputAttachment) -> UIImage? {
    if let cached = thumbnails[attachment.id] { return cached }
    guard let image = attachment.image else { return nil }
    let thumbnail = WorkComposerPillRenderer.thumbnail(image)
    thumbnails[attachment.id] = thumbnail
    return thumbnail
  }

  /// Attachment ids that have a pill, in document order.
  func attachmentPillIds() -> [UUID] {
    guard let storage = textView?.textStorage, storage.length > 0 else { return [] }
    var ids: [UUID] = []
    storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, _, _ in
      guard let pill = value as? WorkComposerPillAttachment,
            case .attachment(let id) = pill.source else { return }
      ids.append(id)
    }
    return ids
  }

  /// The pill under a point in the text view's own coordinates.
  func pill(at point: CGPoint) -> (pill: WorkComposerPillAttachment, range: NSRange)? {
    guard let textView else { return nil }
    let storage = textView.textStorage
    let layoutManager = textView.layoutManager
    let adjusted = CGPoint(
      x: point.x - textView.textContainerInset.left,
      y: point.y - textView.textContainerInset.top
    )
    let glyph = layoutManager.glyphIndex(for: adjusted, in: textView.textContainer)
    guard glyph < layoutManager.numberOfGlyphs else { return nil }
    let hitRect = layoutManager
      .boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textView.textContainer)
      .insetBy(dx: -4, dy: -4)
    guard hitRect.contains(adjusted) else { return nil }
    let character = layoutManager.characterIndexForGlyph(at: glyph)
    guard character < storage.length,
          let pill = storage.attribute(.attachment, at: character, effectiveRange: nil) as? WorkComposerPillAttachment
    else { return nil }
    return (pill, NSRange(location: character, length: 1))
  }

  // MARK: Hydrate

  /// Grammar text → pills. Mentions, links and `@paths` always become pills;
  /// `[Image #k]` / `[File #k: …]` only when attachment k exists, and each
  /// attachment at most once, so a stray duplicate token stays text.
  func hydrate(_ text: String, includeAttachments: Bool = true) -> NSAttributedString {
    let ns = text.replacingOccurrences(of: "\u{FFFC}", with: "") as NSString
    var candidates: [(range: NSRange, pill: NSAttributedString)] = []
    if includeAttachments {
      let list = numberedAttachments
      var used = Set<UUID>()
      for token in WorkAttachmentTokenGrammar.tokens(in: ns) {
        guard let index = WorkAttachmentTokenGrammar.resolve(token, in: list, isImage: { $0.kind == .image })
        else { continue }
        let id = list[index].id
        guard used.insert(id).inserted, let pill = pillString(forAttachment: id) else { continue }
        candidates.append((token.range, pill))
      }
    }
    for chip in WorkChipDetector.chips(in: ns, limit: WorkChipDetector.canonicalTextChipLimit) {
      candidates.append((chip.range, pillString(for: chip)))
    }
    let ordered = candidates.enumerated()
      .sorted { lhs, rhs in
        lhs.element.range.location == rhs.element.range.location
          ? lhs.offset < rhs.offset
          : lhs.element.range.location < rhs.element.range.location
      }
      .map(\.element)

    let out = NSMutableAttributedString()
    var cursor = 0
    for candidate in ordered where candidate.range.location >= cursor {
      if candidate.range.location > cursor {
        out.append(NSAttributedString(
          string: ns.substring(with: NSRange(location: cursor, length: candidate.range.location - cursor)),
          attributes: baseAttributes
        ))
      }
      out.append(candidate.pill)
      cursor = NSMaxRange(candidate.range)
    }
    if cursor < ns.length {
      out.append(NSAttributedString(string: ns.substring(from: cursor), attributes: baseAttributes))
    }
    return out
  }

  // MARK: Edits

  /// Replaces a storage range and keeps the caret where the user expects it.
  /// Programmatic storage edits do not reach `textViewDidChange`; callers
  /// publish afterwards.
  func replace(_ range: NSRange, with string: NSAttributedString) {
    guard let textView else { return }
    let storage = textView.textStorage
    guard NSMaxRange(range) <= storage.length else { return }
    let selection = textView.selectedRange
    storage.replaceCharacters(in: range, with: string)
    let delta = string.length - range.length
    var location = selection.location
    if location >= NSMaxRange(range) {
      location += delta
    } else if location > range.location {
      location = range.location + string.length
    }
    textView.selectedRange = NSRange(location: min(max(0, location), storage.length), length: 0)
    textView.typingAttributes = baseAttributes
  }

  private func plain(_ text: String) -> NSAttributedString {
    NSAttributedString(string: text, attributes: baseAttributes)
  }

  private func isWhitespace(_ character: unichar) -> Bool {
    character == 0x20 || character == 0x09 || character == 0x0A || character == 0x0D
  }

  /// Inserts attachment pills at `range` (the caret, for a paste), padded with
  /// a space on each side so they never fuse with a neighbouring word.
  func insertAttachmentPills(_ ids: [UUID], at range: NSRange) {
    guard let textView, !ids.isEmpty else { return }
    let storage = textView.textStorage
    let safe = NSMaxRange(range) <= storage.length ? range : NSRange(location: storage.length, length: 0)
    let scan = scanningString()
    let insertion = NSMutableAttributedString()
    if safe.location > 0, !isWhitespace(scan.character(at: safe.location - 1)) {
      insertion.append(plain(" "))
    }
    for (index, id) in ids.enumerated() {
      guard let pill = pillString(forAttachment: id) else { continue }
      if index > 0 { insertion.append(plain(" ")) }
      insertion.append(pill)
    }
    let end = NSMaxRange(safe)
    if end >= scan.length || !isWhitespace(scan.character(at: end)) {
      insertion.append(plain(" "))
    }
    storage.replaceCharacters(in: safe, with: insertion)
    textView.selectedRange = NSRange(location: safe.location + insertion.length, length: 0)
    textView.typingAttributes = baseAttributes
    knownAttachmentPillIds = Set(attachmentPillIds())
    lastAttachmentSignature = attachmentSignature
  }

  /// Removes a pill (and one neighbouring space, so no double space is left).
  /// An attachment pill takes its attachment with it.
  func removePill(at range: NSRange) {
    guard let textView, NSMaxRange(range) <= textView.textStorage.length else { return }
    let scan = scanningString()
    var removal = range
    let end = NSMaxRange(range)
    if end < scan.length, scan.character(at: end) == 0x20,
       range.location == 0 || isWhitespace(scan.character(at: range.location - 1)) {
      removal.length += 1
    }
    replace(removal, with: NSAttributedString())
    syncRemovedAttachmentPills()
    publishNow()
  }

  /// Turns finished plain tokens into pills. While typing, a token is
  /// finished once whitespace follows it, so a URL or a mention being typed
  /// is left alone; after a paste everything pasted is finished.
  @discardableResult
  func chipifyCompletedTokens(requireTrailingDelimiter: Bool) -> Bool {
    guard let textView else { return false }
    let scan = scanningString()
    guard scan.length > 0 else { return false }
    let caret = textView.selectedRange.location
    let chips = WorkChipDetector.chips(in: scan, limit: WorkChipDetector.canonicalTextChipLimit)
    var changed = false
    for chip in chips.reversed() {
      let end = NSMaxRange(chip.range)
      if requireTrailingDelimiter {
        // Only the token the user just closed: the whitespace at `end` is the
        // character they typed. Anything else is either already a pill or text
        // the caret is not finishing — typing `https://` straight in front of
        // a word would otherwise read `https://word` as a finished link.
        guard end < scan.length,
              end == caret - 1,
              isWhitespace(scan.character(at: end)) else { continue }
      }
      replace(chip.range, with: pillString(for: chip))
      changed = true
    }
    return changed
  }

  /// First Backspace on an attachment pill selects it; the second deletes it
  /// (and its attachment). Deleting an attachment is destructive, so it takes
  /// a deliberate second press.
  func interceptsDeletion(range: NSRange, replacement: String) -> Bool {
    guard let textView,
          replacement.isEmpty,
          range.length == 1,
          textView.selectedRange.length == 0,
          range.location < textView.textStorage.length,
          let pill = textView.textStorage.attribute(.attachment, at: range.location, effectiveRange: nil)
            as? WorkComposerPillAttachment,
          case .attachment = pill.source
    else { return false }
    textView.selectedRange = range
    return true
  }

  /// An attachment pill the user deleted takes its attachment with it.
  /// Returns whether any attachment was removed.
  @discardableResult
  func syncRemovedAttachmentPills() -> Bool {
    let current = Set(attachmentPillIds())
    let removed = knownAttachmentPillIds.subtracting(current)
    knownAttachmentPillIds = current
    guard !removed.isEmpty, let binding = attachmentsBinding() else { return false }
    let before = binding.wrappedValue.count
    binding.wrappedValue.removeAll { removed.contains($0.id) }
    guard binding.wrappedValue.count != before else { return false }
    lastAttachmentSignature = attachmentSignature
    rerenderPills(attachmentsOnly: true)
    return true
  }

  /// Brings attachment pills in line with the staged list:
  /// a removed attachment's pill goes, a `[Image #k]` typed or restored as
  /// text becomes a pill once attachment k exists, and an attachment with no
  /// pill (a picker add, a restore whose text has no token) gets one at the end.
  func reconcileAttachments() {
    guard let textView else { return }
    let storage = textView.textStorage
    let list = numberedAttachments
    let liveIds = Set(list.map(\.id))

    var stale: [NSRange] = []
    if storage.length > 0 {
      storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
        guard let pill = value as? WorkComposerPillAttachment,
              case .attachment(let id) = pill.source,
              !liveIds.contains(id) else { return }
        stale.append(range)
      }
    }
    for range in stale.reversed() {
      let scan = scanningString()
      var removal = range
      let end = NSMaxRange(range)
      if end < scan.length, scan.character(at: end) == 0x20,
         range.location == 0 || isWhitespace(scan.character(at: range.location - 1)) {
        removal.length += 1
      }
      replace(removal, with: NSAttributedString())
    }

    var present = Set(attachmentPillIds())
    var planned: [(range: NSRange, id: UUID)] = []
    for token in WorkAttachmentTokenGrammar.tokens(in: scanningString()) {
      guard let index = WorkAttachmentTokenGrammar.resolve(token, in: list, isImage: { $0.kind == .image })
      else { continue }
      let id = list[index].id
      guard !present.contains(id) else { continue }
      present.insert(id)
      planned.append((token.range, id))
    }
    for entry in planned.reversed() {
      guard let pill = pillString(forAttachment: entry.id) else { continue }
      replace(entry.range, with: pill)
    }

    let missing = list.filter { !present.contains($0.id) }
    if !missing.isEmpty {
      let caretAtEnd = textView.selectedRange.location >= storage.length
      let scan = scanningString()
      let appended = NSMutableAttributedString()
      if scan.length > 0, !isWhitespace(scan.character(at: scan.length - 1)) {
        appended.append(plain(" "))
      }
      for attachment in missing {
        guard let pill = pillString(forAttachment: attachment.id) else { continue }
        appended.append(pill)
        appended.append(plain(" "))
      }
      storage.append(appended)
      if caretAtEnd {
        textView.selectedRange = NSRange(location: storage.length, length: 0)
      }
      textView.typingAttributes = baseAttributes
    }

    // Prune per-attachment caches for attachments that are gone.
    thumbnails = thumbnails.filter { liveIds.contains($0.key) }
    pastedLineCounts = pastedLineCounts.filter { liveIds.contains($0.key) }

    rerenderPills(attachmentsOnly: true)
    knownAttachmentPillIds = Set(attachmentPillIds())
    lastAttachmentSignature = attachmentSignature
  }

  /// Re-renders pills whose drawing changed: attachment pills after a
  /// renumber or a load, every pill after a light/dark or text-size change.
  func rerenderPills(attachmentsOnly: Bool) {
    guard let storage = textView?.textStorage, storage.length > 0 else { return }
    let list = numberedAttachments
    let numbers = Self.attachmentNumbers(list)
    var updates: [(range: NSRange, attachment: WorkComposerPillAttachment)] = []
    storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
      guard let pill = value as? WorkComposerPillAttachment else { return }
      switch pill.source {
      case .attachment(let id):
        guard let attachment = list.first(where: { $0.id == id }), let number = numbers[id] else { return }
        let next = spec(for: attachment, number: number)
        guard !attachmentsOnly || !next.drawsSame(as: pill.spec) else { return }
        updates.append((range, WorkComposerPillAttachment(source: pill.source, spec: next)))
      case .token:
        guard !attachmentsOnly else { return }
        updates.append((range, WorkComposerPillAttachment(source: pill.source, spec: pill.spec)))
      }
    }
    guard !updates.isEmpty else { return }
    storage.beginEditing()
    for update in updates {
      render(update.attachment)
      storage.addAttribute(.attachment, value: update.attachment, range: update.range)
    }
    storage.endEditing()
  }

  // MARK: SwiftUI sync

  /// Called from `updateUIView`. Applies an outside draft change, then any
  /// attachment change, and queues the resulting serialization for SwiftUI.
  /// Returns whether the storage was rebuilt.
  @discardableResult
  func syncFromSwiftUI() -> Bool {
    guard let textView else { return false }
    var changed = false
    let draft = readDraft()
    if pendingPublish == nil, draft != syncedText {
      textView.textStorage.setAttributedString(hydrate(draft))
      textView.selectedRange = NSRange(location: textView.textStorage.length, length: 0)
      textView.typingAttributes = baseAttributes
      knownAttachmentPillIds = Set(attachmentPillIds())
      syncedText = draft
      changed = true
    }
    if changed || attachmentSignature != lastAttachmentSignature {
      reconcileAttachments()
      changed = true
    }
    if changed { publishDeferred() }
    return changed
  }

  /// Seeds the storage on mount without publishing anything back.
  func load(_ text: String) {
    guard let textView else { return }
    syncedText = text
    textView.textStorage.setAttributedString(hydrate(text))
    textView.selectedRange = NSRange(location: textView.textStorage.length, length: 0)
    textView.typingAttributes = baseAttributes
    reconcileAttachments()
    publishDeferred()
  }

  /// From a UIKit callback: write the draft now.
  func publishNow() {
    pendingPublish = nil
    let serialized = serialize()
    syncedText = serialized
    if readDraft() != serialized { writeDraft(serialized) }
  }

  /// From a SwiftUI update: writing a published value there is a re-entrant
  /// view update, so the write hops one turn.
  private func publishDeferred() {
    let serialized = serialize()
    guard serialized != syncedText else { return }
    syncedText = serialized
    pendingPublish = serialized
    DispatchQueue.main.async { [weak self] in
      guard let self, self.pendingPublish == serialized else { return }
      self.pendingPublish = nil
      if self.readDraft() != serialized { self.writeDraft(serialized) }
    }
  }

  /// After a user edit, outside marked text.
  func userDidEdit() {
    let afterPaste = chipifyAfterPaste
    chipifyAfterPaste = false
    chipifyCompletedTokens(requireTrailingDelimiter: !afterPaste)
    syncRemovedAttachmentPills()
  }

  // MARK: Paste

  /// Pasted images join the tray and land as pills at the caret.
  func pasteImages(_ images: [UIImage], via stage: ([UIImage]) -> Void) {
    guard let textView else {
      stage(images)
      return
    }
    let before = Set(attachments.map(\.id))
    let caret = textView.selectedRange
    stage(images)
    let added = numberedAttachments.filter { !before.contains($0.id) }.map(\.id)
    guard !added.isEmpty else { return }
    insertAttachmentPills(added, at: caret)
    publishNow()
  }

  /// A big text paste becomes a file attachment with a pill at the caret.
  /// Returns false to let the ordinary paste run, which then pills its links
  /// and mentions.
  func pasteText(_ text: String) -> Bool {
    guard let textView,
          acceptsPastedFiles(),
          let binding = attachmentsBinding(),
          WorkComposerBigPaste.qualifies(text),
          binding.wrappedValue.filter({ !workChatInputAttachmentIsLimitNotice($0) }).count < workChatInputAttachmentLimit
    else {
      chipifyAfterPaste = true
      return false
    }
    let caret = textView.selectedRange
    let attachment = WorkComposerBigPaste.attachment(for: text)
    binding.wrappedValue.append(attachment)
    if numberedAttachments.contains(where: { $0.id == attachment.id }) {
      insertAttachmentPills([attachment.id], at: caret)
    }
    publishNow()
    return true
  }
}

// MARK: - Composer text view

final class WorkComposerPastingTextView: UITextView {
  var onPasteImages: (([UIImage]) -> Bool)?
  /// Text paste hook. Returns true when the paste was consumed (a big paste
  /// that became a file).
  var onPasteText: ((String) -> Bool)?
  /// Serializes a selection back to grammar text, so copy and cut put tokens
  /// — never U+FFFC — on the clipboard.
  var serializeRange: ((NSRange) -> String)?
  /// Pills are rasterized with resolved colors; a light/dark or text-size
  /// change re-renders them.
  var onTraitsChange: (() -> Void)?
  private var traitRegistration: (any UITraitChangeRegistration)?

  private var pastedImages: [UIImage] {
    let images = UIPasteboard.general.images ?? []
    if !images.isEmpty { return Array(images.prefix(workChatInputAttachmentLimit + 1)) }
    if let image = UIPasteboard.general.image { return [image] }
    return []
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, traitRegistration == nil else { return }
    traitRegistration = registerForTraitChanges(
      [UITraitUserInterfaceStyle.self, UITraitPreferredContentSizeCategory.self]
    ) { (textView: WorkComposerPastingTextView, _: UITraitCollection) in
      textView.onTraitsChange?()
    }
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)),
       onPasteImages != nil,
       UIPasteboard.general.hasImages {
      return true
    }
    return super.canPerformAction(action, withSender: sender)
  }

  override func paste(_ sender: Any?) {
    let images = pastedImages
    if !images.isEmpty,
       onPasteImages?(images) == true {
      return
    }
    if let onPasteText,
       UIPasteboard.general.hasStrings,
       let string = UIPasteboard.general.string,
       onPasteText(string) {
      return
    }
    super.paste(sender)
  }

  override func copy(_ sender: Any?) {
    guard let serializeRange, selectedRange.length > 0 else {
      super.copy(sender)
      return
    }
    UIPasteboard.general.string = serializeRange(selectedRange)
  }

  override func cut(_ sender: Any?) {
    guard let serializeRange, selectedRange.length > 0, isEditable else {
      super.cut(sender)
      return
    }
    UIPasteboard.general.string = serializeRange(selectedRange)
    // Through the normal input path, so the delegate sees the deletion and an
    // attachment pill takes its attachment with it.
    deleteBackward()
  }
}

/// Long-press menu and tap handling for pills.
@MainActor
private final class WorkComposerPillInteractionController: NSObject, UIContextMenuInteractionDelegate, UIGestureRecognizerDelegate {
  weak var textView: UITextView?
  weak var engine: WorkComposerPillEngine?
  var onOpenAttachment: ((UUID) -> Void)?

  init(textView: UITextView, engine: WorkComposerPillEngine) {
    self.textView = textView
    self.engine = engine
    super.init()
    textView.addInteraction(UIContextMenuInteraction(delegate: self))
    let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
    tap.cancelsTouchesInView = false
    tap.delegate = self
    textView.addGestureRecognizer(tap)
  }

  @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
    guard gesture.state == .ended,
          let textView,
          let onOpenAttachment,
          let hit = engine?.pill(at: gesture.location(in: textView)),
          case .attachment(let id) = hit.pill.source
    else { return }
    onOpenAttachment(id)
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    true
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let engine, let hit = engine.pill(at: location) else { return nil }
    let token = engine.serialize(range: hit.range)
    let range = hit.range
    let isLink = token.contains("://")
    var attachmentId: UUID?
    if case .attachment(let id) = hit.pill.source { attachmentId = id }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      var children: [UIMenuElement] = []
      if let attachmentId, let open = self?.onOpenAttachment {
        children.append(UIAction(title: "Open", image: UIImage(systemName: "eye")) { _ in
          open(attachmentId)
        })
      } else {
        children.append(UIAction(
          title: isLink ? "Copy link" : "Copy",
          image: UIImage(systemName: "doc.on.doc")
        ) { _ in
          UIPasteboard.general.string = token
        })
      }
      children.append(UIAction(
        title: attachmentId == nil ? "Remove" : "Remove attachment",
        image: UIImage(systemName: "trash"),
        attributes: .destructive
      ) { _ in
        self?.engine?.removePill(at: range)
      })
      return UIMenu(children: children)
    }
  }
}

/// UIKit responder changes can synchronously re-enter SwiftUI's view graph.
/// Always apply the latest focus request after the current representable update
/// has yielded so send-time draft mutations cannot create an AttributeGraph
/// dependency cycle.
@MainActor
private final class WorkComposerFocusScheduler {
  private var lastRequest: Bool?
  private var pendingTask: Task<Void, Never>?

  @discardableResult
  func apply(_ isFocused: Bool, to textView: UITextView) -> Task<Void, Never>? {
    // SwiftUI may update the representable more than once for the same state.
    // Keep the queued transition instead of canceling it without a replacement.
    if lastRequest == isFocused, pendingTask != nil { return pendingTask }

    let previousRequest = lastRequest
    lastRequest = isFocused
    pendingTask?.cancel()
    pendingTask = nil

    // Preserve the existing initial-false behavior: creating a composer with
    // an unfocused binding must not dismiss a responder owned by another view.
    guard isFocused || previousRequest == true else { return nil }

    // When UIKit already matches the latest binding and no transition remains
    // queued, there is nothing to defer. This keeps routine SwiftUI updates
    // from creating main-actor tasks after focus has settled.
    guard textView.isFirstResponder != isFocused else { return nil }

    pendingTask = Task { @MainActor [weak self, weak textView] in
      await Task.yield()
      guard !Task.isCancelled,
            let self,
            let textView,
            self.lastRequest == isFocused
      else { return }

      self.pendingTask = nil
      if isFocused {
        if !textView.isFirstResponder {
          textView.becomeFirstResponder()
        }
      } else if textView.isFirstResponder {
        textView.resignFirstResponder()
      }
    }
    return pendingTask
  }
}

/// Builds the explicit TextKit 1 stack both composers use, so attachment pills
/// render through `NSTextAttachment.image`.
@MainActor
private func workComposerMakeTextKit1TextView() -> (WorkComposerPastingTextView, NSTextStorage, NSLayoutManager) {
  let textStorage = NSTextStorage()
  let layoutManager = NSLayoutManager()
  textStorage.addLayoutManager(layoutManager)
  let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
  container.widthTracksTextView = true
  container.lineFragmentPadding = 0
  layoutManager.addTextContainer(container)
  let textView = WorkComposerPastingTextView(frame: .zero, textContainer: container)
  return (textView, textStorage, layoutManager)
}

/// Start-chat composer (new chat, hub, personal chats). No typed-trigger menu,
/// but the same pills as the chat composer: links and mentions in the text,
/// and — where an attachment list is passed — image and file pills.
struct WorkPlainComposerTextView: UIViewRepresentable {
  @Binding var text: String
  @Binding var isFocused: Bool
  @Binding var measuredHeight: CGFloat
  let placeholder: String
  var acceptsPastedImages = true
  var onPasteImages: (([UIImage]) -> Void)? = nil
  /// Staged attachments, when this surface has a tray.
  var attachments: Binding<[WorkChatInputAttachment]>? = nil
  /// Whether a big text paste may become a file attachment.
  var acceptsPastedFiles = false
  var onOpenAttachment: ((UUID) -> Void)? = nil

  private var maxHeight: CGFloat {
    ceil(UIFont.preferredFont(forTextStyle: .body).lineHeight * 6) + 8
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }

  func makeUIView(context: Context) -> UITextView {
    let (textView, textStorage, layoutManager) = workComposerMakeTextKit1TextView()
    context.coordinator.textStorage = textStorage
    context.coordinator.layoutManager = layoutManager
    textView.delegate = context.coordinator
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.isScrollEnabled = false
    textView.font = UIFont.preferredFont(forTextStyle: .body)
    textView.adjustsFontForContentSizeCategory = true
    textView.textColor = UIColor(ADEColor.textPrimary)
    textView.tintColor = UIColor(ADEColor.accent)
    textView.autocorrectionType = .yes
    textView.autocapitalizationType = .sentences
    textView.spellCheckingType = .yes
    textView.smartQuotesType = .no
    textView.smartDashesType = .no
    textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    textView.setContentHuggingPriority(.defaultLow, for: .horizontal)
    textView.accessibilityIdentifier = "Work.StartChat.Composer.TextView"
    textView.accessibilityHint = "Long press a chip for copy and remove actions."

    context.coordinator.textView = textView
    context.coordinator.attach(to: textView)
    context.coordinator.applyHooks(to: textView)
    context.coordinator.applyPlaceholder(placeholder)
    context.coordinator.engine.load(text)
    context.coordinator.updatePlaceholderVisibility()
    context.coordinator.updateHeight()
    return textView
  }

  func updateUIView(_ textView: UITextView, context: Context) {
    context.coordinator.parent = self
    context.coordinator.applyHooks(to: textView)
    if context.coordinator.engine.syncFromSwiftUI() {
      context.coordinator.updatePlaceholderVisibility()
    }
    context.coordinator.applyPlaceholder(placeholder)
    context.coordinator.applyFocusRequest(isFocused, to: textView)
    context.coordinator.updateHeight()
  }

  @MainActor
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: WorkPlainComposerTextView
    weak var textView: UITextView?
    var textStorage: NSTextStorage?
    var layoutManager: NSLayoutManager?
    let engine = WorkComposerPillEngine()
    private var interactions: WorkComposerPillInteractionController?
    private var placeholderLabel: UILabel?
    private let focusScheduler = WorkComposerFocusScheduler()

    init(_ parent: WorkPlainComposerTextView) {
      self.parent = parent
      super.init()
      engine.readDraft = { [weak self] in self?.parent.text ?? "" }
      engine.writeDraft = { [weak self] value in self?.parent.text = value }
      engine.attachmentsBinding = { [weak self] in self?.parent.attachments }
      engine.acceptsPastedFiles = { [weak self] in self?.parent.acceptsPastedFiles ?? false }
    }

    func attach(to textView: WorkComposerPastingTextView) {
      engine.textView = textView
      interactions = WorkComposerPillInteractionController(textView: textView, engine: engine)
      textView.serializeRange = { [weak engine] range in engine?.serialize(range: range) ?? "" }
      textView.onPasteText = { [weak engine] text in engine?.pasteText(text) ?? false }
      textView.onTraitsChange = { [weak engine] in engine?.rerenderPills(attachmentsOnly: false) }
    }

    func applyHooks(to textView: UITextView) {
      interactions?.onOpenAttachment = parent.onOpenAttachment
      guard let textView = textView as? WorkComposerPastingTextView else { return }
      textView.onPasteImages = parent.acceptsPastedImages
        ? { [weak self] images in self?.handlePasteImages(images) ?? false }
        : nil
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      if !parent.isFocused { parent.isFocused = true }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      if parent.isFocused { parent.isFocused = false }
    }

    func textViewDidChange(_ textView: UITextView) {
      if textView.markedTextRange == nil { engine.userDidEdit() }
      engine.publishNow()
      updatePlaceholderVisibility()
      updateHeight()
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
      textView.typingAttributes = engine.baseAttributes
    }

    func textView(
      _ textView: UITextView,
      shouldChangeTextIn range: NSRange,
      replacementText text: String
    ) -> Bool {
      textView.typingAttributes = engine.baseAttributes
      return !engine.interceptsDeletion(range: range, replacement: text)
    }

    @discardableResult
    func applyFocusRequest(_ isFocused: Bool, to textView: UITextView) -> Task<Void, Never>? {
      focusScheduler.apply(isFocused, to: textView)
    }

    func handlePasteImages(_ images: [UIImage]) -> Bool {
      guard parent.acceptsPastedImages,
            let onPasteImages = parent.onPasteImages,
            !images.isEmpty
      else { return false }
      engine.pasteImages(images, via: onPasteImages)
      updatePlaceholderVisibility()
      updateHeight()
      return true
    }

    func applyPlaceholder(_ text: String) {
      guard let textView else { return }
      if placeholderLabel == nil {
        let label = UILabel()
        label.numberOfLines = 0
        label.font = UIFont.preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = UIColor(ADEColor.textMuted)
        label.translatesAutoresizingMaskIntoConstraints = false
        textView.addSubview(label)
        NSLayoutConstraint.activate([
          label.leadingAnchor.constraint(equalTo: textView.leadingAnchor),
          label.trailingAnchor.constraint(lessThanOrEqualTo: textView.trailingAnchor),
          label.topAnchor.constraint(equalTo: textView.topAnchor),
        ])
        placeholderLabel = label
      }
      placeholderLabel?.text = text
      updatePlaceholderVisibility()
    }

    func updatePlaceholderVisibility() {
      placeholderLabel?.isHidden = (textView?.textStorage.length ?? 0) > 0
    }

    func updateHeight() {
      guard let textView else { return }
      let width = textView.bounds.width
      guard width > 0 else { return }
      let fitting = textView.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height
      let clamped = min(max(fitting, parent.minHeight), parent.maxHeight)
      textView.isScrollEnabled = fitting > parent.maxHeight
      if abs(parent.measuredHeight - clamped) > 0.5 {
        DispatchQueue.main.async { [weak self] in
          self?.parent.measuredHeight = clamped
        }
      }
    }
  }

  var minHeight: CGFloat { 28 }
}

/// UITextView-backed composer input. SwiftUI's `TextField` exposes neither the
/// cursor position (needed for cursor-relative trigger detection) nor inline
/// attachments (needed for pills), so the composer drops to UIKit here.
///
/// `draftState.text` stays the plain-text source of truth that gets sent and
/// persisted: it is the GRAMMAR form (`@chat:abc`, `[Image #1]`, URLs), which
/// `WorkComposerPillEngine` rebuilds from the pills on every edit.
struct WorkComposerTextView: UIViewRepresentable {
  @ObservedObject var draftState: WorkChatComposerDraftState
  @ObservedObject var controller: WorkComposerSuggestionController
  let canCompose: Bool
  let placeholder: String
  @Binding var measuredHeight: CGFloat
  var acceptsPastedImages = true
  var onPasteImages: (([UIImage]) -> Void)? = nil
  /// Staged attachments. Every attachment is a pill in the draft; deleting
  /// either one removes the other.
  var attachments: Binding<[WorkChatInputAttachment]>? = nil
  /// Whether a big text paste may become a file attachment.
  var acceptsPastedFiles = false
  /// Tapping an image or file pill opens the attachment preview.
  var onOpenAttachment: ((UUID) -> Void)? = nil
  var maxLines = 6
  /// Folded composer. The field keeps its measured height and is clipped to one
  /// line by the SwiftUI frame above it; here it only means "pin the draft to
  /// its first line", so the clip never lands mid-scroll.
  var collapsed = false
  /// Called when the field's own scroll pan is a fold swipe. Observing the text
  /// view's recognizer rather than adding one is what keeps the fold from
  /// fighting the draft's internal scroll: a scrollable `UITextView` never lets
  /// a foreign recognizer run simultaneously, so the card's SwiftUI drag is
  /// only reachable while the draft still fits.
  var onFoldSwipeDown: (() -> Void)? = nil

  private var maxHeight: CGFloat {
    ceil(UIFont.preferredFont(forTextStyle: .body).lineHeight * CGFloat(max(1, maxLines))) + 8
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }

  func makeUIView(context: Context) -> UITextView {
    // Explicit TextKit 1 stack so pills render through NSTextAttachment.image.
    let (textView, textStorage, layoutManager) = workComposerMakeTextKit1TextView()
    // UITextView retains only the text container of a manually-built TextKit 1
    // stack; keep the storage + layout manager alive on the coordinator or the
    // stack deallocates out from under the view.
    context.coordinator.textStorage = textStorage
    context.coordinator.layoutManager = layoutManager
    textView.delegate = context.coordinator
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.isScrollEnabled = false
    // A downward drag inside a draft long enough to scroll takes the keyboard
    // with it, matching the composer card's fold swipe.
    textView.keyboardDismissMode = .interactive
    // Keep natural-language prompt traits aligned with `adePromptInputTraits()`.
    textView.autocorrectionType = .yes
    textView.autocapitalizationType = .sentences
    textView.spellCheckingType = .yes
    textView.smartQuotesType = .no
    textView.smartDashesType = .no
    textView.tintColor = UIColor(ADEColor.accent)
    textView.adjustsFontForContentSizeCategory = true
    textView.typingAttributes = context.coordinator.engine.baseAttributes
    textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    textView.setContentHuggingPriority(.defaultLow, for: .horizontal)
    textView.accessibilityIdentifier = "Work.Chat.Composer.TextView"
    textView.accessibilityHint = "Long press a chip for copy and remove actions."

    context.coordinator.textView = textView
    context.coordinator.attach(to: textView)
    context.coordinator.applyHooks(to: textView)
    context.coordinator.observeFoldPan(on: textView)
    // Route committed suggestions straight to the live text view.
    controller.onCommit = { [weak coordinator = context.coordinator] suggestion, range in
      coordinator?.commit(suggestion, replacing: range)
    }
    controller.onRewriteModelChip = { [weak coordinator = context.coordinator] range, token in
      coordinator?.rewriteModelChip(range: range, with: token)
    }

    context.coordinator.engine.load(draftState.text)
    context.coordinator.applyPlaceholder(placeholder)
    context.coordinator.applyFocusRequest(draftState.isFocused, to: textView)
    context.coordinator.updateHeight()
    return textView
  }

  func updateUIView(_ textView: UITextView, context: Context) {
    context.coordinator.parent = self
    context.coordinator.applyEditable(canCompose, to: textView)
    context.coordinator.applyHooks(to: textView)
    context.coordinator.applyPlaceholder(placeholder)

    // Reflect outside changes to the source of truth (dictation insert,
    // send-clear, restore-unsent, a stash) and to the staged attachments.
    if context.coordinator.engine.syncFromSwiftUI() {
      context.coordinator.updatePlaceholderVisibility()
      context.coordinator.detectTrigger()
    }
    context.coordinator.applyFocusRequest(draftState.isFocused, to: textView)
    context.coordinator.updateHeight()
    context.coordinator.pinFoldedOffset(on: textView)
  }

  @MainActor
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: WorkComposerTextView
    weak var textView: UITextView?
    // Strong owners of the manual TextKit 1 stack (see makeUIView).
    var textStorage: NSTextStorage?
    var layoutManager: NSLayoutManager?
    let engine = WorkComposerPillEngine()
    private var interactions: WorkComposerPillInteractionController?
    private var placeholderLabel: UILabel?
    private var triggerInputTraitsActive = false
    private let focusScheduler = WorkComposerFocusScheduler()
    /// Whether the pan that is running started with the draft scrolled to its
    /// top. Dragging down inside a draft the reader has scrolled into is that
    /// draft scrolling, not a fold.
    private var foldPanBeganAtTop = false

    init(_ parent: WorkComposerTextView) {
      self.parent = parent
      super.init()
      engine.readDraft = { [weak self] in self?.parent.draftState.text ?? "" }
      engine.writeDraft = { [weak self] value in self?.parent.draftState.text = value }
      engine.attachmentsBinding = { [weak self] in self?.parent.attachments }
      engine.acceptsPastedFiles = { [weak self] in self?.parent.acceptsPastedFiles ?? false }
      engine.tint = { [weak self] in
        UIColor(ADEColor.providerChatAccent(for: self?.parent.controller.provider))
      }
    }

    func attach(to textView: WorkComposerPastingTextView) {
      engine.textView = textView
      interactions = WorkComposerPillInteractionController(textView: textView, engine: engine)
      textView.serializeRange = { [weak engine] range in engine?.serialize(range: range) ?? "" }
      textView.onPasteText = { [weak self] text in
        guard let self else { return false }
        let consumed = self.engine.pasteText(text)
        if consumed {
          self.parent.controller.clear()
          self.updatePlaceholderVisibility()
          self.updateHeight()
        }
        return consumed
      }
      textView.onTraitsChange = { [weak engine] in engine?.rerenderPills(attachmentsOnly: false) }
    }

    func applyHooks(to textView: UITextView) {
      interactions?.onOpenAttachment = parent.onOpenAttachment
      guard let textView = textView as? WorkComposerPastingTextView else { return }
      textView.onPasteImages = parent.acceptsPastedImages
        ? { [weak self] images in self?.handlePasteImages(images) ?? false }
        : nil
    }

    /// Rides the text view's own pan recognizer. `keyboardDismissMode` already
    /// takes the keyboard down with the finger; this is what takes the card's
    /// height with it.
    func observeFoldPan(on textView: UITextView) {
      textView.panGestureRecognizer.addTarget(self, action: #selector(handleFoldPan(_:)))
    }

    @objc private func handleFoldPan(_ gesture: UIPanGestureRecognizer) {
      guard let textView else { return }
      switch gesture.state {
      case .began:
        foldPanBeganAtTop = textView.contentOffset.y <= 0.5
      case .ended:
        guard foldPanBeganAtTop else { return }
        let translation = gesture.translation(in: textView)
        let swipe = workComposerFoldGesture(
          translation: CGSize(width: translation.x, height: translation.y),
          collapsed: false
        )
        if swipe == .collapse { parent.onFoldSwipeDown?() }
      default:
        break
      }
    }

    /// Folded means "the start of the draft". A draft typed past the bottom of
    /// the field is scrolled when the fold lands, and a clip window over a
    /// scrolled field shows a sliced line.
    func pinFoldedOffset(on textView: UITextView) {
      guard let y = workComposerFoldedContentOffsetY(
        collapsed: parent.collapsed,
        current: textView.contentOffset.y
      ) else { return }
      textView.setContentOffset(CGPoint(x: 0, y: y), animated: false)
    }

    /// Holds the pin for the life of the fold: resigning the responder and the
    /// height change both re-scroll the text view after `updateUIView` ran.
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
      guard let y = workComposerFoldedContentOffsetY(
        collapsed: parent.collapsed,
        current: scrollView.contentOffset.y
      ) else { return }
      scrollView.contentOffset = CGPoint(x: 0, y: y)
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      if !parent.draftState.isFocused { parent.draftState.isFocused = true }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      if parent.draftState.isFocused { parent.draftState.isFocused = false }
    }

    @discardableResult
    func applyFocusRequest(_ isFocused: Bool, to textView: UITextView) -> Task<Void, Never>? {
      focusScheduler.apply(isFocused, to: textView)
    }

    /// Turning editing off on a focused text view makes UIKit resign it, and
    /// resigning from inside a SwiftUI update re-enters the view graph: an
    /// AttributeGraph cycle that blocked the main thread until the watchdog
    /// killed the app. Off-while-focused waits for the update to finish.
    /// Writing the same value is skipped too: it is not free.
    private var editableUpdateScheduled = false

    func applyEditable(_ editable: Bool, to textView: UITextView) {
      guard textView.isEditable != editable else { return }
      guard !editable, textView.isFirstResponder else {
        textView.isEditable = editable
        return
      }
      guard !editableUpdateScheduled else { return }
      editableUpdateScheduled = true
      DispatchQueue.main.async { [weak self, weak textView] in
        guard let self else { return }
        self.editableUpdateScheduled = false
        guard let textView else { return }
        let wanted = self.parent.canCompose
        if textView.isEditable != wanted {
          textView.isEditable = wanted
        }
      }
    }

    private func applyPromptInputTraits(protectingTrigger: Bool) {
      guard let textView else { return }
      guard triggerInputTraitsActive != protectingTrigger else { return }
      triggerInputTraitsActive = protectingTrigger

      textView.autocorrectionType = protectingTrigger ? .no : .yes
      textView.autocapitalizationType = protectingTrigger ? .none : .sentences
      textView.spellCheckingType = protectingTrigger ? .no : .yes
      if textView.isFirstResponder {
        textView.reloadInputViews()
      }
    }

    // MARK: Delegate

    func textView(
      _ textView: UITextView,
      shouldChangeTextIn range: NSRange,
      replacementText text: String
    ) -> Bool {
      // Typing right after a pill must not inherit its attachment attribute.
      textView.typingAttributes = engine.baseAttributes
      return !engine.interceptsDeletion(range: range, replacement: text)
    }

    func textViewDidChange(_ textView: UITextView) {
      // Skip pilling AND trigger detection while marked text (IME/multistage
      // input) is active: uncommitted composition can transiently contain
      // `/`/`@` and must not pop the suggestion strip. Detection re-runs on
      // the post-commit didChange/didChangeSelection callbacks.
      if textView.markedTextRange == nil {
        engine.userDidEdit()
      }
      engine.publishNow()
      updatePlaceholderVisibility()
      updateHeight()
      if textView.markedTextRange == nil {
        detectTrigger()
      }
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
      textView.typingAttributes = engine.baseAttributes
      if textView.markedTextRange == nil {
        detectTrigger()
      }
    }

    func handlePasteImages(_ images: [UIImage]) -> Bool {
      guard parent.acceptsPastedImages,
            let onPasteImages = parent.onPasteImages,
            !images.isEmpty else { return false }
      engine.pasteImages(images, via: onPasteImages)
      parent.controller.clear()
      updatePlaceholderVisibility()
      updateHeight()
      return true
    }

    // MARK: Detection + commit

    func detectTrigger() {
      guard let textView else { return }
      defer { updateModelChipEditing() }
      guard textView.isFirstResponder else {
        applyPromptInputTraits(protectingTrigger: false)
        parent.controller.clear()
        return
      }
      let selection = textView.selectedRange
      // Only detect against a collapsed caret; a ranged selection isn't a trigger.
      guard selection.length == 0 else {
        applyPromptInputTraits(protectingTrigger: false)
        parent.controller.clear()
        return
      }
      // Pills read as spaces, so a committed pill closes any trigger before it
      // and a trigger typed right after a pill still opens.
      let match = WorkComposerTriggerDetector.detect(
        in: engine.scanningString(),
        cursor: selection.location
      )
      // Pills read as spaces, so a committed chip already closes the trigger;
      // there is no text-chip span left to confirm.
      applyPromptInputTraits(protectingTrigger: match != nil)
      parent.controller.update(match: match)
    }

    func commit(_ suggestion: WorkComposerSuggestion, replacing range: NSRange) {
      guard let textView else { return }
      guard NSMaxRange(range) <= textView.textStorage.length else { return }
      let insertion = NSMutableAttributedString(attributedString: engine.pillString(for: suggestion))
      insertion.append(NSAttributedString(string: " ", attributes: engine.baseAttributes))
      engine.replace(range, with: insertion)
      textView.selectedRange = NSRange(location: range.location + insertion.length, length: 0)
      engine.publishNow()
      updatePlaceholderVisibility()
      updateHeight()
      updateModelChipEditing()
    }

    // MARK: Model chips

    /// The model chip the caret is on, or just past (one space after it, where
    /// the caret lands right after a model row is picked). Typing on moves the
    /// caret away and the menu goes with it.
    ///
    /// A model token is a pill — one storage character — so the mention's range
    /// is re-anchored onto that character before it reaches the editor menu.
    private func updateModelChipEditing() {
      guard let textView, textView.selectedRange.length == 0, textView.markedTextRange == nil else {
        parent.controller.setEditingModelChip(nil)
        return
      }
      let storage = textView.textStorage
      let ns = storage.string as NSString
      let caret = textView.selectedRange.location
      func modelMention(at index: Int) -> WorkModelMention? {
        guard index >= 0, index < storage.length,
              let token = storage.attribute(
                .workComposerPillToken,
                at: index,
                effectiveRange: nil
              ) as? String,
              token.hasPrefix("@model:"),
              let mention = WorkModelMentionDetector.mentions(in: token as NSString).first
        else { return nil }
        return WorkModelMention(
          modelId: mention.modelId,
          effort: mention.effort,
          permission: mention.permission,
          token: mention.token,
          range: NSRange(location: index, length: 1)
        )
      }
      var hit: WorkModelMention?
      if let onPill = modelMention(at: caret) {
        hit = onPill
      } else if caret > 0, let justAfter = modelMention(at: caret - 1) {
        hit = justAfter
      } else if caret >= 2,
                ns.character(at: caret - 1) == 0x20,
                let afterSpace = modelMention(at: caret - 2) {
        hit = afterSpace
      }
      parent.controller.setEditingModelChip(hit)
    }

    /// Replace one model token (new thinking level or permission mode). The
    /// pill is rebuilt through the engine, so every other pill and attachment
    /// in the draft is left alone and the caret stays put.
    func rewriteModelChip(range: NSRange, with token: String) {
      guard let textView,
            NSMaxRange(range) <= textView.textStorage.length,
            let existing = textView.textStorage.attribute(
              .workComposerPillToken,
              at: range.location,
              effectiveRange: nil
            ) as? String,
            existing.hasPrefix("@model:") else { return }
      engine.replace(range, with: engine.hydrate(token))
      engine.publishNow()
      updatePlaceholderVisibility()
      updateHeight()
      updateModelChipEditing()
    }

    // MARK: Placeholder + height

    func applyPlaceholder(_ text: String) {
      guard let textView else { return }
      if placeholderLabel == nil {
        let label = UILabel()
        label.numberOfLines = 0
        label.font = UIFont.preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = UIColor(ADEColor.textMuted)
        label.translatesAutoresizingMaskIntoConstraints = false
        textView.addSubview(label)
        NSLayoutConstraint.activate([
          label.leadingAnchor.constraint(equalTo: textView.leadingAnchor),
          label.trailingAnchor.constraint(lessThanOrEqualTo: textView.trailingAnchor),
          label.topAnchor.constraint(equalTo: textView.topAnchor),
        ])
        placeholderLabel = label
      }
      placeholderLabel?.text = text
      updatePlaceholderVisibility()
    }

    func updatePlaceholderVisibility() {
      placeholderLabel?.isHidden = (textView?.textStorage.length ?? 0) > 0
    }

    func updateHeight() {
      guard let textView else { return }
      let width = textView.bounds.width
      guard width > 0 else { return }
      let fitting = textView.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height
      let clamped = min(max(fitting, parent.minHeight), parent.maxHeight)
      textView.isScrollEnabled = fitting > parent.maxHeight
      if abs(parent.measuredHeight - clamped) > 0.5 {
        DispatchQueue.main.async { [weak self] in
          self?.parent.measuredHeight = clamped
        }
      }
    }
  }

  var minHeight: CGFloat { 24 }
}

// MARK: - Inline suggestion strip

/// Compact suggestion strip pinned directly above the composer text field. Rows
/// are filtered by the live query; tapping one splices a styled chip into the
/// draft. Visibility follows the controller's trigger state, not focus.
struct WorkComposerSuggestionStrip: View {
  @ObservedObject var controller: WorkComposerSuggestionController

  /// Rows grouped by section, in the order the controller produced them. The
  /// `@` menu has several groups; `/` and `#` have one.
  private var groups: [(section: WorkComposerSuggestionSection, rows: [WorkComposerSuggestion])] {
    var out: [(section: WorkComposerSuggestionSection, rows: [WorkComposerSuggestion])] = []
    for suggestion in controller.suggestions {
      if let last = out.last, last.section == suggestion.section {
        out[out.count - 1].rows.append(suggestion)
      } else {
        out.append((suggestion.section, [suggestion]))
      }
    }
    return out
  }

  var body: some View {
    if controller.isVisible {
      VStack(alignment: .leading, spacing: 0) {
        if controller.suggestions.isEmpty {
          header(title: fallbackTitle, symbol: fallbackSymbol, showsProgress: true)
          loadingRow
        } else {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
              ForEach(Array(groups.enumerated()), id: \.element.section) { index, group in
                Section {
                  ForEach(group.rows) { suggestion in
                    Button {
                      controller.commit(suggestion)
                    } label: {
                      row(suggestion)
                    }
                    .buttonStyle(.plain)
                  }
                } header: {
                  header(
                    title: group.section.title,
                    symbol: group.section.symbolName,
                    showsProgress: index == 0 && controller.isLoading
                  )
                }
              }
            }
          }
          .frame(maxHeight: 248)
        }
      }
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(ADEColor.glassBackground)
      )
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.75)
      )
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .shadow(color: Color.black.opacity(0.10), radius: 12, y: 4)
      .transition(.opacity.combined(with: .move(edge: .bottom)))
      .accessibilityIdentifier("Work.Chat.Composer.SuggestionStrip")
    } else if let chip = controller.editingModelChip {
      WorkModelChipEditorBar(controller: controller, chip: chip)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
  }

  private var fallbackSymbol: String {
    switch controller.activeMatch?.kind {
    case .at: return "at"
    case .hash: return WorkComposerSuggestionSection.pullRequests.symbolName
    default: return WorkComposerSuggestionSection.commands.symbolName
    }
  }

  private var fallbackTitle: String {
    switch controller.activeMatch?.kind {
    case .at:
      return controller.suggestions.contains { $0.modelId != nil }
        ? "Files & models"
        : WorkComposerSuggestionSection.files.title
    case .hash: return WorkComposerSuggestionSection.pullRequests.title
    default: return WorkComposerSuggestionSection.commands.title
    }
  }

  private func header(title: String, symbol: String, showsProgress: Bool) -> some View {
    HStack(spacing: 6) {
      Image(systemName: symbol)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(title.uppercased())
        .font(.caption2.weight(.bold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
      if showsProgress {
        ProgressView().controlSize(.mini)
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 8)
    .padding(.bottom, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.ultraThinMaterial)
    .accessibilityAddTraits(.isHeader)
  }

  private var loadingRow: some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.mini)
      Text(loadingCopy)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 10)
  }

  private var loadingCopy: String {
    switch controller.activeMatch?.kind {
    case .hash: return "Searching pull requests…"
    case .at: return "Searching…"
    default: return "Loading commands…"
    }
  }

  private func row(_ suggestion: WorkComposerSuggestion) -> some View {
    HStack(spacing: 10) {
      Image(systemName: suggestion.symbolName)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(ADEColor.providerChatAccent(for: controller.provider))
        .frame(width: 26, height: 26)
        .background(
          ADEColor.providerChatAccent(for: controller.provider).opacity(0.12),
          in: RoundedRectangle(cornerRadius: 7, style: .continuous)
        )
        // Decorative: the title and subtitle already say what the row is, and
        // VoiceOver reading "arrow triangle pull" before every PR is noise.
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(suggestion.title)
          .font(suggestion.kind == .slash
            ? .footnote.weight(.semibold).monospaced()
            : .footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(suggestion.section == .files ? .middle : .tail)
        if let subtitle = suggestion.subtitle, !subtitle.isEmpty {
          Text(subtitle)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    // A row with no subtitle (a slash command, a root-level file) is otherwise
    // barely 33pt tall. The tap target is the whole row, so it holds the 44pt
    // floor rather than the text's intrinsic height.
    .frame(minHeight: 44)
    .contentShape(Rectangle())
    .accessibilityLabel(rowAccessibilityLabel(suggestion))
  }

  private func rowAccessibilityLabel(_ suggestion: WorkComposerSuggestion) -> String {
    let kind: String
    switch suggestion.section {
    case .chats: kind = "Chat"
    case .lanes: kind = "Lane"
    case .terminals: kind = "Terminal"
    case .pullRequests: kind = "Pull request"
    case .machines: kind = "Machine"
    case .mcpServers: kind = "MCP server"
    case .files: kind = suggestion.isDirectory ? "Folder" : "File"
    case .commands: kind = "Command"
    }
    let subtitle = suggestion.subtitle.map { ", \($0)" } ?? ""
    return "\(kind): \(suggestion.title)\(subtitle)"
  }
}

/// The menu for the model chip the caret is on: its thinking level and its
/// permission mode, the two parts a desktop chip edits in place. Picking one
/// rewrites the chip's token in the draft.
struct WorkModelChipEditorBar: View {
  @ObservedObject var controller: WorkComposerSuggestionController
  let chip: WorkModelMention

  private var tiers: [String] {
    WorkModelMentionDirectory.shared.entry(for: chip.modelId)?.reasoningTiers ?? []
  }

  private var provider: String {
    WorkModelMentionDirectory.shared.entry(for: chip.modelId)?.provider ?? ""
  }

  private var permissionOptions: [WorkModelMentionDetector.PermissionOption] {
    WorkModelMentionDetector.permissionOptions(provider: provider)
  }

  private var currentPermission: String {
    chip.permission ?? WorkModelMentionDetector.defaultPermission(provider: provider)
  }

  private var summary: String {
    var parts: [String] = []
    if let effort = chip.effort, !effort.isEmpty { parts.append(WorkModelMentionDetector.effortLabel(effort)) }
    parts.append(WorkModelMentionDetector.permissionLabel(chip.permission, provider: provider))
    return parts.joined(separator: " · ")
  }

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "sparkles")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(ADEColor.warning)
        .accessibilityHidden(true)
      Text(chip.displayName)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 4)
      Menu {
        if !tiers.isEmpty {
          Section("Thinking") {
            ForEach(tiers, id: \.self) { tier in
              Button {
                controller.rewriteEditingModelChip(effort: tier, permission: chip.permission)
              } label: {
                if tier == chip.effort {
                  Label(WorkModelMentionDetector.effortLabel(tier), systemImage: "checkmark")
                } else {
                  Text(WorkModelMentionDetector.effortLabel(tier))
                }
              }
            }
          }
        }
        Section("Permissions") {
          ForEach(permissionOptions, id: \.value) { option in
            Button {
              controller.rewriteEditingModelChip(effort: chip.effort, permission: option.value)
            } label: {
              if option.value == currentPermission {
                Label(option.label, systemImage: "checkmark")
              } else {
                Text(option.label)
              }
            }
          }
        }
      } label: {
        HStack(spacing: 4) {
          Text(summary)
            .font(.footnote.weight(.semibold))
            .lineLimit(1)
          Image(systemName: "chevron.up.chevron.down")
            .font(.caption2.weight(.semibold))
            .accessibilityHidden(true)
        }
        .foregroundStyle(ADEColor.warning)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(ADEColor.warning.opacity(0.12), in: Capsule(style: .continuous))
      }
      .accessibilityLabel("Model chip settings: \(summary)")
      .accessibilityIdentifier("Work.Chat.Composer.ModelChipMenu")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .frame(minHeight: 44)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(.ultraThinMaterial)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.75)
    )
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}
