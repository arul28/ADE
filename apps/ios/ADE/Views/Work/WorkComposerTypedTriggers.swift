import SwiftUI
import UIKit

// MARK: - Smart links

private func workSmartLinkPathParts(_ components: URLComponents) -> [String] {
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
    /// An `ade://` URL this build cannot parse — a newer ADE minted it.
    case adeLink

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
      case .adeLink: return "A"
      }
    }
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

/// Swift twin of the `@chat:` / `@lane:` / `@term:` grammar in
/// `apps/desktop/src/shared/chatMentions.ts`.
///
/// A mention is a POINTER, never an attachment: the token is the canonical text
/// and the label is display only, so the same draft round-trips through the
/// desktop composer, the `ade code` TUI, and this app without changing meaning.
struct WorkChatMention: Equatable {
  enum Kind: Equatable {
    case chat
    case lane
    case terminal

    /// Token prefix per kind. `term` is deliberately short for typing, matching
    /// `CHAT_MENTION_TOKEN_PREFIX` on the desktop.
    var tokenPrefix: String {
      switch self {
      case .chat: return "chat"
      case .lane: return "lane"
      case .terminal: return "term"
      }
    }

    static func from(tokenPrefix: String) -> Kind? {
      switch tokenPrefix {
      case "chat": return .chat
      case "lane": return .lane
      case "term": return .terminal
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
    pattern: "(?:^|[\\s(\\[{,])@(chat|lane|term):([A-Za-z0-9._-]+)",
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

  static func chips(in text: NSString, limit: Int = defaultLimit) -> [WorkChip] {
    guard text.length > 0, limit > 0 else { return [] }

    var candidates: [WorkChip] = WorkChatMentionDetector.mentions(in: text).map(WorkChip.init(mention:))
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

  static func parts(in text: String, limit: Int = defaultLimit) -> [WorkChipTextPart] {
    let ns = text as NSString
    let matches = chips(in: ns, limit: limit)
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

// MARK: - Trigger detection

/// The typed triggers the composer recognizes, matching the shared desktop/TUI
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
/// Mirrors the desktop/TUI regexes exactly:
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
    let rawLabel = suggestion.insertText.hasPrefix("@")
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

  /// Filter to rows whose token prefixes the typed query.
  static func suggestions(from commands: [HostSlashCommand], query: String) -> [WorkComposerSuggestion] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return commands.prefix(maxCommands).compactMap { command in
      guard let suggestion = suggestion(for: command) else { return nil }
      guard trimmed.isEmpty || suggestion.title.dropFirst().lowercased().hasPrefix(trimmed) else {
        return nil
      }
      return suggestion
    }
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
          scheduleFileFetch(query: WorkComposerTriggerDetector.fileSearchQuery(for: match.query))
        } else if isLoading {
          isLoading = false
        }
      }
    }
  }
  weak var syncService: SyncService?

  /// Wired by the text view: performs the splice on the live UITextView so
  /// first-responder state and selection survive the insertion.
  var onCommit: ((WorkComposerSuggestion, NSRange) -> Void)?

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
    suggestions = WorkComposerSlashRegistry.suggestions(
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
        let commands = try await syncService.getSlashCommands(provider: provider, laneId: laneId)
        guard let self, !Task.isCancelled else { return }
        guard self.laneGeneration == generation, self.provider == provider else { return }
        self.hostSlashCommands = commands
        if let match = self.activeMatch, match.kind == .slash {
          self.suggestions = WorkComposerSlashRegistry.suggestions(
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
      isLoading = false
      refreshSlashSuggestions(query: match.query)
    case .at:
      scheduleFileFetch(query: WorkComposerTriggerDetector.fileSearchQuery(for: match.query))
    case .hash:
      schedulePrFetch(query: match.query)
    }
  }

  func commit(_ suggestion: WorkComposerSuggestion) {
    guard let match = activeMatch else { return }
    let commitMatch = WorkComposerTriggerDetector.matchForSelection(match, suggestion: suggestion)
    onCommit?(suggestion, commitMatch.range)
    clear()
  }

  func clear() {
    fetchTask?.cancel()
    fetchTask = nil
    if activeMatch != nil { activeMatch = nil }
    if !suggestions.isEmpty { suggestions = [] }
    if isLoading { isLoading = false }
  }

  private func scheduleFileFetch(query: String) {
    fetchTask?.cancel()
    let cacheKey = query.lowercased()
    if let cached = cachedFiles(cacheKey) {
      fetchTask = nil
      isLoading = false
      finishFiles(cached)
      return
    }
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
    isLoading = false
    suggestions = items
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

// MARK: - Chip styling

extension NSAttributedString.Key {
  /// Marks a run as a committed chip token; carries the pill tint the layout
  /// manager draws behind it.
  static let workComposerChipTint = NSAttributedString.Key("workComposerChipTint")
}

/// Draws a rounded, tinted pill behind any run bearing `.workComposerChipTint`,
/// giving `/command` and `@path` tokens a distinct chip treatment inline with
/// the editable text.
final class WorkComposerChipLayoutManager: NSLayoutManager {
  override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
    super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    guard let textStorage else { return }
    let charRange = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
    textStorage.enumerateAttribute(.workComposerChipTint, in: charRange, options: []) { value, range, _ in
      guard let color = value as? UIColor else { return }
      let glyphRange = self.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
      guard let container = textContainer(forGlyphAt: glyphRange.location, effectiveRange: nil) else { return }
      enumerateEnclosingRects(
        forGlyphRange: glyphRange,
        withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
        in: container
      ) { rect, _ in
        let pill = rect.insetBy(dx: -4, dy: -1).offsetBy(dx: origin.x, dy: origin.y)
        let path = UIBezierPath(roundedRect: pill, cornerRadius: 6)
        color.withAlphaComponent(0.16).setFill()
        path.fill()
      }
    }
  }
}

// MARK: - Composer text view

final class WorkComposerPastingTextView: UITextView {
  var onPasteImages: (([UIImage]) -> Bool)?

  private var pastedImages: [UIImage] {
    let images = UIPasteboard.general.images ?? []
    if !images.isEmpty { return Array(images.prefix(workChatInputAttachmentLimit + 1)) }
    if let image = UIPasteboard.general.image { return [image] }
    return []
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
    super.paste(sender)
  }
}

@MainActor
private final class WorkSmartLinkContextMenuController: NSObject, UIContextMenuInteractionDelegate {
  weak var textView: UITextView?
  var onRemove: ((WorkSmartLink) -> Void)?

  init(textView: UITextView, onRemove: @escaping (WorkSmartLink) -> Void) {
    self.textView = textView
    self.onRemove = onRemove
    super.init()
    textView.addInteraction(UIContextMenuInteraction(delegate: self))
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let textView,
          let link = link(at: location, in: textView)
    else { return nil }
    return UIContextMenuConfiguration(identifier: link.url as NSString, previewProvider: nil) { [weak self] _ in
      let copy = UIAction(title: "Copy link", image: UIImage(systemName: "doc.on.doc")) { _ in
        UIPasteboard.general.string = link.url
      }
      let remove = UIAction(title: "Remove link", image: UIImage(systemName: "trash"), attributes: .destructive) { _ in
        self?.onRemove?(link)
      }
      return UIMenu(children: [copy, remove])
    }
  }

  private func link(at point: CGPoint, in textView: UITextView) -> WorkSmartLink? {
    let adjusted = CGPoint(
      x: point.x + textView.contentOffset.x - textView.textContainerInset.left,
      y: point.y + textView.contentOffset.y - textView.textContainerInset.top
    )
    let glyph = textView.layoutManager.glyphIndex(for: adjusted, in: textView.textContainer)
    guard glyph < textView.layoutManager.numberOfGlyphs else { return nil }
    let hitRect = textView.layoutManager
      .boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textView.textContainer)
      .insetBy(dx: -6, dy: -6)
    guard hitRect.contains(adjusted) else { return nil }
    let character = textView.layoutManager.characterIndexForGlyph(at: glyph)
    return WorkSmartLinkDetector.links(in: textView.text as NSString).first { NSLocationInRange(character, $0.range) }
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

/// Plain UITextView composer for start-chat surfaces that do not need typed
/// trigger chips but still need multiline sizing and image-paste interception.
struct WorkPlainComposerTextView: UIViewRepresentable {
  @Binding var text: String
  @Binding var isFocused: Bool
  @Binding var measuredHeight: CGFloat
  let placeholder: String
  var acceptsPastedImages = true
  var onPasteImages: (([UIImage]) -> Void)? = nil

  private var maxHeight: CGFloat {
    ceil(UIFont.preferredFont(forTextStyle: .body).lineHeight * 6) + 8
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }

  func makeUIView(context: Context) -> UITextView {
    let textStorage = NSTextStorage()
    let layoutManager = WorkComposerChipLayoutManager()
    textStorage.addLayoutManager(layoutManager)
    let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    container.widthTracksTextView = true
    container.lineFragmentPadding = 0
    layoutManager.addTextContainer(container)
    let textView = WorkComposerPastingTextView(frame: .zero, textContainer: container)
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
    textView.accessibilityHint = "Long press a link for copy and remove actions."
    textView.onPasteImages = acceptsPastedImages
      ? { [weak coordinator = context.coordinator] images in
          coordinator?.handlePasteImages(images) ?? false
        }
      : nil

    context.coordinator.textView = textView
    context.coordinator.installSmartLinkMenu(on: textView)
    context.coordinator.applyPlaceholder(placeholder)
    if !text.isEmpty { textView.text = text }
    context.coordinator.restyleSmartLinks()
    context.coordinator.updatePlaceholderVisibility()
    context.coordinator.updateHeight()
    return textView
  }

  func updateUIView(_ textView: UITextView, context: Context) {
    context.coordinator.parent = self
    if let textView = textView as? WorkComposerPastingTextView {
      textView.onPasteImages = acceptsPastedImages
        ? { [weak coordinator = context.coordinator] images in
            coordinator?.handlePasteImages(images) ?? false
          }
        : nil
    }
    if textView.text != text {
      textView.text = text
      context.coordinator.restyleSmartLinks()
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
    var layoutManager: WorkComposerChipLayoutManager?
    private var smartLinkMenu: WorkSmartLinkContextMenuController?
    private var placeholderLabel: UILabel?
    private let focusScheduler = WorkComposerFocusScheduler()

    init(_ parent: WorkPlainComposerTextView) {
      self.parent = parent
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      if !parent.isFocused { parent.isFocused = true }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      if parent.isFocused { parent.isFocused = false }
    }

    func textViewDidChange(_ textView: UITextView) {
      if parent.text != textView.text {
        parent.text = textView.text
      }
      if textView.markedTextRange == nil { restyleSmartLinks() }
      updatePlaceholderVisibility()
      updateHeight()
    }

    func textView(
      _ textView: UITextView,
      shouldChangeTextIn range: NSRange,
      replacementText text: String
    ) -> Bool {
      guard let deletionRange = WorkSmartLinkDetector.atomicDeletionRange(
        in: textView.text as NSString,
        range: range,
        replacementText: text
      ) else { return true }
      remove(range: deletionRange)
      return false
    }

    func textView(
      _ textView: UITextView,
      shouldInteractWith URL: URL,
      in characterRange: NSRange,
      interaction: UITextItemInteraction
    ) -> Bool {
      false
    }

    func installSmartLinkMenu(on textView: UITextView) {
      smartLinkMenu = WorkSmartLinkContextMenuController(textView: textView) { [weak self] link in
        self?.remove(range: link.range)
      }
    }

    func restyleSmartLinks() {
      guard let textView else { return }
      let storage = textView.textStorage
      let fullRange = NSRange(location: 0, length: storage.length)
      let baseAttributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.preferredFont(forTextStyle: .body),
        .foregroundColor: UIColor(ADEColor.textPrimary),
      ]
      textView.typingAttributes = baseAttributes
      guard fullRange.length > 0 else { return }
      let tint = UIColor(ADEColor.accent)
      storage.beginEditing()
      storage.setAttributes(baseAttributes, range: fullRange)
      for link in WorkSmartLinkDetector.links(in: storage.string as NSString) {
        storage.addAttributes([
          .font: UIFont.preferredFont(forTextStyle: .body).withWeight(.semibold),
          .foregroundColor: tint,
          .workComposerChipTint: tint,
          .link: link.url,
        ], range: link.range)
      }
      storage.endEditing()
    }

    private func remove(range: NSRange) {
      guard let textView, NSMaxRange(range) <= (textView.text as NSString).length else { return }
      textView.textStorage.replaceCharacters(in: range, with: "")
      textView.selectedRange = NSRange(location: min(range.location, textView.textStorage.length), length: 0)
      if parent.text != textView.text { parent.text = textView.text }
      restyleSmartLinks()
      updatePlaceholderVisibility()
      updateHeight()
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
      onPasteImages(images)
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
      placeholderLabel?.isHidden = !(textView?.text.isEmpty ?? true)
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
/// styled runs (needed for chips), so the composer drops to UIKit here while
/// keeping `draftState.text` as the plain-text source of truth that gets sent.
struct WorkComposerTextView: UIViewRepresentable {
  @ObservedObject var draftState: WorkChatComposerDraftState
  @ObservedObject var controller: WorkComposerSuggestionController
  let canCompose: Bool
  let placeholder: String
  @Binding var measuredHeight: CGFloat
  var acceptsPastedImages = true
  var onPasteImages: (([UIImage]) -> Void)? = nil
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
    // Explicit TextKit 1 stack so our custom layout manager (chip backgrounds)
    // is guaranteed to be the one in use.
    let textStorage = NSTextStorage()
    let layoutManager = WorkComposerChipLayoutManager()
    textStorage.addLayoutManager(layoutManager)
    let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    container.widthTracksTextView = true
    container.lineFragmentPadding = 0
    layoutManager.addTextContainer(container)

    let textView = WorkComposerPastingTextView(frame: .zero, textContainer: container)
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
    textView.typingAttributes = context.coordinator.baseAttributes
    textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    textView.setContentHuggingPriority(.defaultLow, for: .horizontal)
    textView.accessibilityIdentifier = "Work.Chat.Composer.TextView"
    textView.accessibilityHint = "Long press a link for copy and remove actions."
    textView.onPasteImages = acceptsPastedImages
      ? { [weak coordinator = context.coordinator] images in
          coordinator?.handlePasteImages(images) ?? false
        }
      : nil

    context.coordinator.textView = textView
    context.coordinator.installSmartLinkMenu(on: textView)
    context.coordinator.observeFoldPan(on: textView)
    // Route committed suggestions straight to the live text view.
    controller.onCommit = { [weak coordinator = context.coordinator] suggestion, range in
      coordinator?.commit(suggestion, replacing: range)
    }

    if !draftState.text.isEmpty {
      context.coordinator.setText(draftState.text, resetChips: true)
    }
    context.coordinator.applyPlaceholder(placeholder)
    context.coordinator.applyFocusRequest(draftState.isFocused, to: textView)
    context.coordinator.updateHeight()
    return textView
  }

  func updateUIView(_ textView: UITextView, context: Context) {
    context.coordinator.parent = self
    textView.isEditable = canCompose
    if let textView = textView as? WorkComposerPastingTextView {
      textView.onPasteImages = acceptsPastedImages
        ? { [weak coordinator = context.coordinator] images in
            coordinator?.handlePasteImages(images) ?? false
          }
        : nil
    }
    context.coordinator.applyPlaceholder(placeholder)

    // Reflect external mutations to the source of truth (dictation insert,
    // send-clear, restore-unsent) that didn't originate from this text view.
    if draftState.text != textView.text {
      context.coordinator.setText(draftState.text, resetChips: false)
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
    var layoutManager: WorkComposerChipLayoutManager?
    /// Committed chip spans, kept in sync with edits so we know which runs to
    /// keep styled and which to de-chip when they're edited into.
    private var chips: [(range: NSRange, text: String)] = []
    private var placeholderLabel: UILabel?
    private var triggerInputTraitsActive = false
    private let focusScheduler = WorkComposerFocusScheduler()
    private var smartLinkMenu: WorkSmartLinkContextMenuController?
    /// Whether the pan that is running started with the draft scrolled to its
    /// top. Dragging down inside a draft the reader has scrolled into is that
    /// draft scrolling, not a fold.
    private var foldPanBeganAtTop = false

    init(_ parent: WorkComposerTextView) {
      self.parent = parent
    }

    var baseAttributes: [NSAttributedString.Key: Any] {
      [
        .font: UIFont.preferredFont(forTextStyle: .body),
        .foregroundColor: UIColor(ADEColor.textPrimary),
      ]
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

    private func chipAttributes(kind: WorkComposerTriggerKind) -> [NSAttributedString.Key: Any] {
      let tint = UIColor(ADEColor.providerChatAccent(for: parent.controller.provider))
      let font: UIFont
      switch kind {
      case .slash:
        let body = UIFont.preferredFont(forTextStyle: .body)
        font = UIFont.monospacedSystemFont(ofSize: body.pointSize - 1, weight: .semibold)
      case .at, .hash:
        font = UIFont.preferredFont(forTextStyle: .body).withWeight(.semibold)
      }
      return [
        .font: font,
        .foregroundColor: tint,
        .workComposerChipTint: tint,
      ]
    }

    private var smartLinkAttributes: [NSAttributedString.Key: Any] {
      let tint = UIColor(ADEColor.accent)
      return [
        .font: UIFont.preferredFont(forTextStyle: .body).withWeight(.semibold),
        .foregroundColor: tint,
        .workComposerChipTint: tint,
      ]
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

    // MARK: Text sync

    func setText(_ text: String, resetChips: Bool) {
      guard let textView else { return }
      if resetChips {
        chips = []
      } else {
        chips = revalidatedChips(against: text as NSString)
      }
      let selection = textView.selectedRange
      textView.text = text
      restyle()
      let clamped = min(selection.location, (text as NSString).length)
      textView.selectedRange = NSRange(location: clamped, length: 0)
      textView.typingAttributes = baseAttributes
      updatePlaceholderVisibility()
      detectTrigger()
    }

    /// Keep only chips whose exact substring still lives at the same offset —
    /// enough to preserve chips through appends (dictation) while dropping any
    /// invalidated by a clear/prepend.
    private func revalidatedChips(against text: NSString) -> [(range: NSRange, text: String)] {
      chips.filter { chip in
        chip.range.location + chip.range.length <= text.length
          && text.substring(with: chip.range) == chip.text
      }
    }

    // MARK: Delegate

    func textView(
      _ textView: UITextView,
      shouldChangeTextIn range: NSRange,
      replacementText text: String
    ) -> Bool {
      if let deletionRange = WorkSmartLinkDetector.atomicDeletionRange(
        in: textView.text as NSString,
        range: range,
        replacementText: text
      ) {
        remove(range: deletionRange)
        return false
      }
      let delta = (text as NSString).length - range.length
      let editStart = range.location
      let editEnd = range.location + range.length
      var next: [(range: NSRange, text: String)] = []
      for chip in chips {
        let cStart = chip.range.location
        let cEnd = chip.range.location + chip.range.length
        if range.length > 0, NSIntersectionRange(chip.range, range).length > 0 {
          continue  // deletion/replacement touches the chip -> de-chip it
        }
        if range.length == 0, editStart > cStart, editStart < cEnd {
          continue  // insertion inside the chip -> de-chip it
        }
        if editEnd <= cStart {
          next.append((NSRange(location: cStart + delta, length: chip.range.length), chip.text))
        } else if editStart >= cEnd {
          next.append(chip)
        } else if range.length == 0, editStart == cStart {
          next.append((NSRange(location: cStart + delta, length: chip.range.length), chip.text))
        } else {
          next.append(chip)
        }
      }
      chips = next
      return true
    }

    func installSmartLinkMenu(on textView: UITextView) {
      smartLinkMenu = WorkSmartLinkContextMenuController(textView: textView) { [weak self] link in
        self?.remove(range: link.range)
      }
    }

    func textView(
      _ textView: UITextView,
      shouldInteractWith URL: URL,
      in characterRange: NSRange,
      interaction: UITextItemInteraction
    ) -> Bool {
      false
    }

    func textViewDidChange(_ textView: UITextView) {
      if parent.draftState.text != textView.text {
        parent.draftState.text = textView.text
      }
      // Skip restyle AND trigger detection while marked text (IME/multistage
      // input) is active: uncommitted composition can transiently contain
      // `/`/`@` and must not pop the suggestion strip. Detection re-runs on
      // the post-commit didChange/didChangeSelection callbacks.
      if textView.markedTextRange == nil {
        restyle()
      }
      updatePlaceholderVisibility()
      updateHeight()
      if textView.markedTextRange == nil {
        detectTrigger()
      }
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
      if textView.markedTextRange == nil {
        detectTrigger()
      }
    }

    func handlePasteImages(_ images: [UIImage]) -> Bool {
      guard parent.acceptsPastedImages,
            let onPasteImages = parent.onPasteImages,
            !images.isEmpty else { return false }
      onPasteImages(images)
      parent.controller.clear()
      return true
    }

    // MARK: Detection + commit

    private func detectTrigger() {
      guard let textView else { return }
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
      let match = WorkComposerTriggerDetector.detect(
        in: textView.text as NSString,
        cursor: selection.location
      )
      let resolvedMatch = match.flatMap { candidate in
        WorkComposerTriggerDetector.hasConfirmedChipPrefix(
          candidate,
          in: textView.text as NSString,
          chipRanges: chips.map { $0.range }
        ) ? nil : candidate
      }
      applyPromptInputTraits(protectingTrigger: resolvedMatch != nil)
      parent.controller.update(match: resolvedMatch)
    }

    func commit(_ suggestion: WorkComposerSuggestion, replacing range: NSRange) {
      guard let textView else { return }
      let full = textView.text as NSString
      guard range.location + range.length <= full.length else { return }
      let chipText = suggestion.insertText
      let insertion = chipText + " "

      // Shift any chips after the replaced span by the length delta, and drop
      // any that overlapped the trigger span.
      let delta = (insertion as NSString).length - range.length
      let editEnd = range.location + range.length
      var next: [(range: NSRange, text: String)] = []
      for chip in chips {
        if NSIntersectionRange(chip.range, range).length > 0 { continue }
        if chip.range.location >= editEnd {
          next.append((NSRange(location: chip.range.location + delta, length: chip.range.length), chip.text))
        } else {
          next.append(chip)
        }
      }
      // A `#` selection inserts a pull-request URL. `restyle()` already draws
      // every smart link and `atomicDeletionRange` already deletes one whole,
      // so registering a composer chip over the same range would double-own it.
      if suggestion.kind != .hash {
        let chipRange = NSRange(location: range.location, length: (chipText as NSString).length)
        next.append((chipRange, chipText))
      }
      chips = next

      let storage = textView.textStorage
      storage.replaceCharacters(in: range, with: insertion)
      restyle()

      let caret = range.location + (insertion as NSString).length
      textView.selectedRange = NSRange(location: caret, length: 0)
      textView.typingAttributes = baseAttributes

      if parent.draftState.text != textView.text {
        parent.draftState.text = textView.text
      }
      updatePlaceholderVisibility()
      updateHeight()
    }

    // MARK: Styling

    private func restyle() {
      guard let textView else { return }
      let storage = textView.textStorage
      let fullRange = NSRange(location: 0, length: storage.length)
      guard fullRange.length > 0 else { return }
      storage.beginEditing()
      storage.setAttributes(baseAttributes, range: fullRange)
      for chip in chips where chip.range.location + chip.range.length <= storage.length {
        // Resolve each chip's kind from its leading trigger char so slash and
        // file chips can style differently.
        let kind: WorkComposerTriggerKind = chip.text.hasPrefix("/") ? .slash : .at
        storage.addAttributes(chipAttributes(kind: kind), range: chip.range)
      }
      for link in WorkSmartLinkDetector.links(in: storage.string as NSString) {
        var attributes = smartLinkAttributes
        attributes[.link] = link.url
        storage.addAttributes(attributes, range: link.range)
      }
      storage.endEditing()
    }

    private func remove(range: NSRange) {
      guard let textView, NSMaxRange(range) <= (textView.text as NSString).length else { return }
      chips = chips.compactMap { chip in
        if NSIntersectionRange(chip.range, range).length > 0 { return nil }
        if chip.range.location >= NSMaxRange(range) {
          return (NSRange(location: chip.range.location - range.length, length: chip.range.length), chip.text)
        }
        return chip
      }
      textView.textStorage.replaceCharacters(in: range, with: "")
      textView.selectedRange = NSRange(location: min(range.location, textView.textStorage.length), length: 0)
      textView.typingAttributes = baseAttributes
      if parent.draftState.text != textView.text { parent.draftState.text = textView.text }
      restyle()
      updatePlaceholderVisibility()
      updateHeight()
      detectTrigger()
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

    private func updatePlaceholderVisibility() {
      placeholderLabel?.isHidden = !(textView?.text.isEmpty ?? true)
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

private extension UIFont {
  func withWeight(_ weight: UIFont.Weight) -> UIFont {
    let descriptor = fontDescriptor.addingAttributes([
      .traits: [UIFontDescriptor.TraitKey.weight: weight]
    ])
    return UIFont(descriptor: descriptor, size: pointSize)
  }
}

// MARK: - Inline suggestion strip

/// Compact suggestion strip pinned directly above the composer text field. Rows
/// are filtered by the live query; tapping one splices a styled chip into the
/// draft. Visibility follows the controller's trigger state, not focus.
struct WorkComposerSuggestionStrip: View {
  @ObservedObject var controller: WorkComposerSuggestionController

  var body: some View {
    if controller.isVisible {
      VStack(alignment: .leading, spacing: 0) {
        header
        if controller.isLoading && controller.suggestions.isEmpty {
          loadingRow
        } else {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(controller.suggestions) { suggestion in
                Button {
                  controller.commit(suggestion)
                } label: {
                  row(suggestion)
                }
                .buttonStyle(.plain)
              }
            }
          }
          .frame(maxHeight: 176)
        }
      }
      .background(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(.ultraThinMaterial)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.75)
      )
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .transition(.opacity.combined(with: .move(edge: .bottom)))
      .accessibilityIdentifier("Work.Chat.Composer.SuggestionStrip")
    }
  }

  private var headerIcon: String {
    switch controller.activeMatch?.kind {
    case .at: return "doc.text"
    case .hash: return "arrow.triangle.pull"
    default: return "command"
    }
  }

  private var headerTitle: String {
    switch controller.activeMatch?.kind {
    case .at: return "Files"
    case .hash: return "Pull requests"
    default: return "Commands"
    }
  }

  private var header: some View {
    HStack(spacing: 6) {
      Image(systemName: headerIcon)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(headerTitle)
        .font(.caption2.weight(.bold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
      if controller.isLoading {
        ProgressView().controlSize(.mini)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  private var loadingRow: some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.mini)
      Text(controller.activeMatch?.kind == .hash ? "Searching pull requests…" : "Searching files…")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 10)
  }

  private func rowIcon(for suggestion: WorkComposerSuggestion) -> String {
    switch suggestion.kind {
    case .at: return suggestion.isDirectory ? "folder" : "doc"
    case .hash: return "arrow.triangle.pull"
    case .slash: return "chevron.right.circle"
    }
  }

  private func row(_ suggestion: WorkComposerSuggestion) -> some View {
    HStack(spacing: 10) {
      Image(systemName: rowIcon(for: suggestion))
        .font(.footnote.weight(.semibold))
        .foregroundStyle(ADEColor.providerChatAccent(for: controller.provider))
        .frame(width: 18)
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
          .truncationMode(suggestion.kind == .at ? .middle : .tail)
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
    .padding(.vertical, 8)
    // A row with no subtitle (a slash command, a root-level file) is otherwise
    // barely 33pt tall. The tap target is the whole row, so it holds the 44pt
    // floor rather than the text's intrinsic height.
    .frame(minHeight: 44)
    .contentShape(Rectangle())
  }
}
