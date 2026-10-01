import SwiftUI
import UIKit

// MARK: - Thread entities

/// One lane the thread-entity rules can name, with the live facts its chip
/// draws (the lane's own name and colour).
struct WorkThreadEntityLane: Equatable {
  let id: String
  let name: String
  let colorHex: String?
}

/// One chat the rules can name, with its title and live state for the dot.
struct WorkThreadEntitySession: Equatable {
  enum Live: Equatable {
    case running
    case waiting
  }

  let id: String
  let title: String?
  let live: Live?
}

/// What a chip's lane or chat really is right now. The parse only knows an
/// id; the name, colour and state come from here.
struct WorkThreadEntityFacts: Equatable {
  let label: String?
  let colorHex: String?
  let live: WorkThreadEntitySession.Live?
}

/// The precomputed lookup `apps/desktop/src/shared/threadEntities.ts` builds
/// in `buildThreadEntityLookup`. Build once per index change, not per message.
struct WorkThreadEntityLookup {
  let laneById: [String: WorkThreadEntityLane]
  let laneByName: [String: WorkThreadEntityLane]
  let sessionById: [String: WorkThreadEntitySession]
  /// All lane and session ids (lowercased), for 8+ character prefix matching.
  let idPrefixes: [(id: String, isLane: Bool)]
  let linearTeamKeys: Set<String>
  let skillNames: Set<String>

  static let empty = WorkThreadEntityLookup(lanes: [], sessions: [])

  // Lane names that also mean a git branch or a role. `main` in backticks is
  // far more often the branch than the primary lane, so these never chip by name.
  private static let ambiguousLaneNames: Set<String> = ["main", "master", "primary", "default", "head", "origin"]

  init(
    lanes: [WorkThreadEntityLane],
    sessions: [WorkThreadEntitySession],
    linearTeamKeys: [String] = [],
    skillNames: [String] = []
  ) {
    var byId: [String: WorkThreadEntityLane] = [:]
    var nameCounts: [String: Int] = [:]
    for lane in lanes {
      byId[lane.id.lowercased()] = lane
      let name = lane.name.trimmingCharacters(in: .whitespacesAndNewlines)
      if !name.isEmpty { nameCounts[name, default: 0] += 1 }
    }
    var byName: [String: WorkThreadEntityLane] = [:]
    for lane in lanes {
      let name = lane.name.trimmingCharacters(in: .whitespacesAndNewlines)
      // Two lanes with one name is no identity; neither chips by name.
      guard (name as NSString).length >= 3, nameCounts[name] == 1 else { continue }
      guard !Self.ambiguousLaneNames.contains(name.lowercased()) else { continue }
      byName[name] = lane
    }
    var sessionsById: [String: WorkThreadEntitySession] = [:]
    for session in sessions { sessionsById[session.id.lowercased()] = session }
    laneById = byId
    laneByName = byName
    sessionById = sessionsById
    idPrefixes = lanes.map { (id: $0.id.lowercased(), isLane: true) }
      + sessions.map { (id: $0.id.lowercased(), isLane: false) }
    self.linearTeamKeys = Set(linearTeamKeys.map { $0.uppercased() })
    self.skillNames = Set(skillNames.map { $0.lowercased() })
  }

  /// The live facts for a lane or chat chip, from a mention or an `ade://`
  /// link. Nil for every other chip, and for an id this device does not know.
  func facts(for chip: WorkChip) -> WorkThreadEntityFacts? {
    var laneId: String?
    var sessionId: String?
    switch chip.origin {
    case .mention(let mention):
      if mention.kind == .lane { laneId = mention.id }
      if mention.kind == .chat { sessionId = mention.id }
    case .link(let link):
      guard link.provider == .ade, let components = URLComponents(string: link.url) else { return nil }
      let id = components.path.split(separator: "/").first.map(String.init)?.removingPercentEncoding
      if chip.kind == .lane { laneId = id }
      if chip.kind == .chat { sessionId = id }
    default:
      return nil
    }
    if let laneId, let lane = laneById[laneId.lowercased()] {
      return WorkThreadEntityFacts(label: lane.name, colorHex: lane.colorHex, live: nil)
    }
    if let sessionId, let session = sessionById[sessionId.lowercased()] {
      return WorkThreadEntityFacts(label: session.title, colorHex: nil, live: session.live)
    }
    return nil
  }
}

/// What a span of agent text names: a chip, or a zoned timestamp the reader
/// sees in local time. `file_line` from the desktop is not ported — see
/// `WorkThreadEntityRules`.
enum WorkThreadEntity: Equatable {
  case chip(WorkChip)
  /// A zoned timestamp, or a same-day range (`2026-10-01T01:52Z–02:24Z`)
  /// when `end` is set.
  case time(date: Date, end: Date?, raw: String)

  /// Stable identity for "these two chips point at the same thing", like the
  /// desktop's `threadEntityKey`. Only mentions carry one.
  var key: String? {
    guard case .chip(let chip) = self, case .mention(let mention) = chip.origin else { return nil }
    return "\(mention.kind.tokenPrefix):\(mention.id.lowercased())"
  }
}

struct WorkThreadEntityMatch: Equatable {
  let range: NSRange
  let entity: WorkThreadEntity
}

/// Swift port of `apps/desktop/src/shared/threadEntities.ts`. The same rules,
/// in the same order: only real things chip (unknown ids stay code), inline
/// code is the strong signal, and prose matching is limited to shapes that
/// cannot be ordinary words.
///
/// Not ported: the bare `3461-3468` line follow-up (`file_line`). The iOS
/// markdown renderer does not link file-path code spans at all, so a line
/// range that opened a file while the path beside it did not would be odd.
/// A bare line ref still returns nil here, exactly as the desktop does when
/// it has no file in context.
enum WorkThreadEntityRules {
  /// Permission values distinctive enough to chip on sight, with their provider.
  static let permissionTokens: [String: String] = [
    "bypassPermissions": "claude",
    "acceptEdits": "claude",
    "full-auto": "opencode",
    "config-toml": "codex",
  ]

  private static let uuidSource = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
  // Date, time with optional seconds, then Z or an offset. A bare `21:51:57`
  // has no zone, so it cannot be converted and is left alone.
  private static let isoSource =
    "(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,9}))?)?(Z|[+-]\\d{2}:?\\d{2})"
  // JS `\w` is ASCII; ICU's is Unicode. Spelled out so both surfaces agree.
  private static let word = "A-Za-z0-9_"

  private static let uuidRegex = try! NSRegularExpression(pattern: "^\(uuidSource)$")
  private static let idPrefixRegex = try! NSRegularExpression(pattern: "^[0-9a-f]{8}(?:-[0-9a-f]{1,4}){0,3}$", options: [.caseInsensitive])
  private static let shaRegex = try! NSRegularExpression(pattern: "^[0-9a-f]{7,40}$")
  private static let prNumberRegex = try! NSRegularExpression(pattern: "^#(\\d{1,6})$")
  private static let linearIdRegex = try! NSRegularExpression(pattern: "^([A-Za-z][A-Za-z0-9]{0,9})-(\\d{1,9})$")
  private static let skillRegex = try! NSRegularExpression(pattern: "^/([a-z][a-z0-9_-]*(?::[a-z0-9_-]+)?)$", options: [.caseInsensitive])
  private static let lineRefRegex = try! NSRegularExpression(pattern: "^:?(\\d{1,7})(?:\\s*[-–]\\s*(\\d{1,7}))?$")
  private static let isoRegex = try! NSRegularExpression(pattern: "^\(isoSource)$")
  /// Non-capturing ISO, for the range shapes that capture start and end.
  private static let isoPlainSource =
    "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:?\\d{2})"
  /// An optional end time (`–02:24Z`), with its own zone, on the start's date.
  private static let isoRangeEndSource = "(?:\\s*[–-]\\s*(\\d{2}:\\d{2}(?::\\d{2})?(?:Z|[+-]\\d{2}:?\\d{2})))?"
  private static let timeRegex = try! NSRegularExpression(pattern: "^(\(isoPlainSource))\(isoRangeEndSource)$")

  // Prose shapes. Each is anchored on both sides so it never matches inside a
  // longer word, path or URL.
  private static let proseUuidRegex = try! NSRegularExpression(pattern: "(?<![\(word)/.-])\(uuidSource)(?![\(word)/-])")
  private static let proseIsoRegex = try! NSRegularExpression(
    pattern: "(?<![\(word)-])\(isoPlainSource)\(isoRangeEndSource)(?![\(word):])"
  )
  private static let prosePrRegex = try! NSRegularExpression(
    pattern: "(?<![\(word)])(?:PR|pull request)\\s+(#\\d{1,6})(?![\(word)])",
    options: [.caseInsensitive]
  )
  private static let proseLinearRegex = try! NSRegularExpression(
    pattern: "(?<![\(word)/#-])([A-Za-z][A-Za-z0-9]{0,9}-\\d{1,9})(?![\(word)-])"
  )

  private static func wholeMatch(_ regex: NSRegularExpression, _ value: String) -> NSTextCheckingResult? {
    regex.firstMatch(in: value, range: NSRange(location: 0, length: (value as NSString).length))
  }

  private static func group(_ match: NSTextCheckingResult, _ index: Int, in value: String) -> String? {
    let range = match.range(at: index)
    guard range.location != NSNotFound else { return nil }
    return (value as NSString).substring(with: range)
  }

  // MARK: Chip builders

  private static func laneChip(_ lane: WorkThreadEntityLane, token: String, range: NSRange) -> WorkChip {
    WorkChip(
      kind: .lane,
      token: token,
      label: lane.name,
      range: range,
      origin: .mention(WorkChatMention(kind: .lane, id: lane.id, token: token, range: range))
    )
  }

  private static func chatChip(id: String, token: String, range: NSRange) -> WorkChip {
    WorkChip(mention: WorkChatMention(kind: .chat, id: id, token: token, range: range))
  }

  private static func deeplinkChip(kind: WorkSmartLink.Kind, url: String, label: String, token: String, range: NSRange) -> WorkChip {
    WorkChip(
      kind: kind,
      token: token,
      label: label,
      range: range,
      origin: .link(WorkSmartLink(url: url, range: range, provider: .ade))
    )
  }

  /// A lane or chat id, whole or as a unique 8+ character prefix.
  private static func resolveId(_ raw: String, lookup: WorkThreadEntityLookup, range: NSRange) -> WorkChip? {
    let value = raw.lowercased()
    if wholeMatch(uuidRegex, value) != nil {
      if let lane = lookup.laneById[value] { return laneChip(lane, token: raw, range: range) }
      if lookup.sessionById[value] != nil { return chatChip(id: value, token: raw, range: range) }
      return nil
    }
    guard wholeMatch(idPrefixRegex, value) != nil else { return nil }
    // A prefix names an entity only when exactly one lane or chat starts with it.
    var found: (id: String, isLane: Bool)?
    for candidate in lookup.idPrefixes where candidate.id.hasPrefix(value) {
      if let found, found.id != candidate.id { return nil }
      found = candidate
    }
    guard let found else { return nil }
    if found.isLane {
      return lookup.laneById[found.id].map { laneChip($0, token: raw, range: range) }
    }
    return chatChip(id: found.id, token: raw, range: range)
  }

  /// A model named by id: `claude-opus-5-5`, `anthropic/claude-opus-5-5`. A
  /// bare alias like `opus` is as likely a word as a model, so the code must
  /// carry a `-` or `/`. Only a model this device knows by name chips.
  private static func modelChip(_ raw: String, range: NSRange) -> WorkChip? {
    guard raw.contains("-") || raw.contains("/"),
          raw.rangeOfCharacter(from: .letters) != nil,
          raw.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
    else { return nil }
    let entry = WorkModelMentionDirectory.shared.entry(for: raw)
    guard let name = entry?.title ?? workKnownModelDisplayName(raw) else { return nil }
    let mention = WorkModelMention(modelId: entry?.modelId ?? raw, effort: nil, permission: nil, token: raw, range: range)
    // An agent naming a model says nothing about thinking or permission, so
    // the label is the model's name alone.
    return WorkChip(kind: .model, token: raw, label: name, range: range, origin: .model(mention))
  }

  private static func permissionChip(_ raw: String, range: NSRange) -> WorkChip? {
    guard let provider = permissionTokens[raw] else { return nil }
    return WorkChip(
      kind: .permission,
      token: raw,
      label: WorkModelMentionDetector.permissionLabel(raw, provider: provider),
      range: range,
      origin: .permission(provider: provider, value: raw)
    )
  }

  private static func skillChip(_ raw: String, lookup: WorkThreadEntityLookup, range: NSRange) -> WorkChip? {
    guard let match = wholeMatch(skillRegex, raw), let name = group(match, 1, in: raw) else { return nil }
    guard lookup.skillNames.contains(name.lowercased()) else { return nil }
    return WorkChip(kind: .skill, token: raw, label: "/\(name)", range: range, origin: .skill(name: name.lowercased()))
  }

  private static func linearChip(_ raw: String, lookup: WorkThreadEntityLookup, range: NSRange) -> WorkChip? {
    guard let match = wholeMatch(linearIdRegex, raw),
          let key = group(match, 1, in: raw),
          lookup.linearTeamKeys.contains(key.uppercased())
    else { return nil }
    let identifier = raw.uppercased()
    return deeplinkChip(kind: .linearIssue, url: "ade://linear-issue/\(identifier)", label: identifier, token: raw, range: range)
  }

  private static func prChip(number: Int, token: String, range: NSRange) -> WorkChip {
    deeplinkChip(kind: .pullRequest, url: "ade://pr/\(number)", label: "#\(number)", token: token, range: range)
  }

  /// A zoned ISO timestamp, parsed by hand: `ISO8601DateFormatter` refuses a
  /// missing seconds field and a 9-digit fraction, both of which `Date.parse`
  /// on the desktop accepts.
  /// A timestamp or a same-day range. The end shares the start's calendar
  /// date in ITS zone; a range that crosses midnight (`23:50Z–00:10Z`) ends
  /// the next day. Mirrors `timeEntity` on the desktop.
  static func timeEntity(_ raw: String) -> WorkThreadEntity? {
    guard let match = wholeMatch(timeRegex, raw),
          let startText = group(match, 1, in: raw),
          let start = parseZonedTimestamp(startText)
    else { return nil }
    var end: Date?
    if let endText = group(match, 2, in: raw),
       let parsed = parseZonedTimestamp("\(startText.prefix(10))T\(endText)") {
      end = parsed < start ? parsed.addingTimeInterval(86_400) : parsed
    }
    return .time(date: start, end: end, raw: raw)
  }

  static func parseZonedTimestamp(_ raw: String) -> Date? {
    guard let match = wholeMatch(isoRegex, raw) else { return nil }
    func int(_ index: Int) -> Int? { group(match, index, in: raw).flatMap { Int($0) } }
    guard let year = int(1), let month = int(2), let day = int(3), let hour = int(4), let minute = int(5),
          let zone = group(match, 8, in: raw)
    else { return nil }
    let second = int(6) ?? 0
    guard (1...12).contains(month), (1...31).contains(day), (0...23).contains(hour),
          (0...59).contains(minute), (0...59).contains(second)
    else { return nil }
    var offsetSeconds = 0
    if zone != "Z" {
      let digits = zone.dropFirst().replacingOccurrences(of: ":", with: "")
      guard digits.count == 4, let hours = Int(digits.prefix(2)), let minutes = Int(digits.suffix(2)),
            hours <= 23, minutes <= 59
      else { return nil }
      offsetSeconds = (hours * 3600 + minutes * 60) * (zone.hasPrefix("-") ? -1 : 1)
    }
    guard let timeZone = TimeZone(secondsFromGMT: offsetSeconds) else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let components = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: second)
    guard let date = calendar.date(from: components),
          calendar.component(.day, from: date) == day,
          calendar.component(.month, from: date) == month
    else { return nil }
    var fraction = 0.0
    if let digits = group(match, 7, in: raw) { fraction = Double("0.\(digits)") ?? 0 }
    return date.addingTimeInterval(fraction)
  }

  /// `ade://` link targets this build understands, drawn as the same pill the
  /// composer draws. A shape this build cannot parse stays a plain link.
  static func adeLinkChip(_ url: URL) -> WorkChip? {
    guard url.scheme?.lowercased() == "ade",
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          WorkSmartLink.adeDeeplinkKind(
            host: components.host,
            parts: workSmartLinkPathParts(components),
            lineQueryValue: WorkSmartLink.lineQueryValue(in: components)
          ) != nil
    else { return nil }
    let text = url.absoluteString
    return WorkChip(link: WorkSmartLink(url: text, range: NSRange(location: 0, length: (text as NSString).length), provider: .ade))
  }

  // MARK: Matching

  /// What one inline code span names, or nil when it is just code. Mirrors
  /// `matchInlineCodeEntity`, check for check.
  static func matchInlineCode(_ code: String, lookup: WorkThreadEntityLookup) -> WorkThreadEntity? {
    let raw = code.trimmingCharacters(in: .whitespacesAndNewlines)
    let length = (raw as NSString).length
    guard length > 0, length <= 200, !raw.contains("\n") else { return nil }
    let range = NSRange(location: 0, length: length)

    // An explicit token (`@lane:…`, `@model:…`, an `ade://` link) wins outright,
    // but only when it is the whole span.
    let tokens = WorkChipDetector.chips(in: raw as NSString, limit: 2)
    if tokens.count == 1, tokens[0].range == range { return .chip(tokens[0]) }

    if let chip = resolveId(raw, lookup: lookup, range: range) { return .chip(chip) }
    if let lane = lookup.laneByName[raw] { return .chip(laneChip(lane, token: raw, range: range)) }
    if let chip = permissionChip(raw, range: range) { return .chip(chip) }
    if let match = wholeMatch(prNumberRegex, raw), let number = group(match, 1, in: raw).flatMap({ Int($0) }) {
      return .chip(prChip(number: number, token: raw, range: range))
    }
    if let chip = skillChip(raw, lookup: lookup, range: range) { return .chip(chip) }
    if let chip = linearChip(raw, lookup: lookup, range: range) { return .chip(chip) }
    if let time = timeEntity(raw) { return time }
    // A bare line ref (`3461`, `:201-208`) only means something after a file in the same block,
    // which this port does not track (see the type doc). It is never a SHA or
    // a model either way.
    if wholeMatch(lineRefRegex, raw) != nil { return nil }
    // A commit needs a letter AND a digit: all-digit spans are numbers, and
    // all-letter spans (`deadbeef`, `cafe`) are words far more often than SHAs.
    // Exactly 8 hex characters is the short form of a lane or chat id; an
    // unresolved one stays code rather than becoming a commit.
    if wholeMatch(shaRegex, raw) != nil,
       length != 8,
       raw.rangeOfCharacter(from: .decimalDigits) != nil,
       raw.rangeOfCharacter(from: CharacterSet(charactersIn: "abcdef")) != nil {
      return .chip(deeplinkChip(kind: .commit, url: "ade://commit/\(raw)", label: String(raw.prefix(7)), token: raw, range: range))
    }
    if let chip = modelChip(raw, range: range) { return .chip(chip) }
    return nil
  }

  /// Entities in plain prose (text outside code), in document order, with no
  /// overlaps. Mirrors `findProseEntities`.
  static func findProse(_ text: String, lookup: WorkThreadEntityLookup) -> [WorkThreadEntityMatch] {
    let ns = text as NSString
    guard ns.length > 0 else { return [] }
    let full = NSRange(location: 0, length: ns.length)
    var matches: [WorkThreadEntityMatch] = []

    // Explicit tokens. Path mentions are left to the code path: in agent prose
    // an `@` before a word is a handle far more often than a file pick. Web
    // addresses are the markdown renderer's links, not chips.
    for chip in WorkChipDetector.chips(in: ns, limit: WorkChipDetector.canonicalTextChipLimit) {
      switch chip.origin {
      case .path: continue
      case .link(let link) where link.provider != .ade: continue
      default: matches.append(WorkThreadEntityMatch(range: chip.range, entity: .chip(chip)))
      }
    }

    for match in proseUuidRegex.matches(in: text, range: full) {
      let raw = ns.substring(with: match.range)
      if let chip = resolveId(raw, lookup: lookup, range: match.range) {
        matches.append(WorkThreadEntityMatch(range: match.range, entity: .chip(chip)))
      }
    }

    for match in proseIsoRegex.matches(in: text, range: full) {
      let raw = ns.substring(with: match.range)
      if let time = timeEntity(raw) {
        matches.append(WorkThreadEntityMatch(range: match.range, entity: time))
      }
    }

    // Only the `#123` chips, not the "PR" before it.
    for match in prosePrRegex.matches(in: text, range: full) {
      let numberRange = match.range(at: 1)
      let token = ns.substring(with: numberRange)
      guard let number = Int(token.dropFirst()) else { continue }
      matches.append(WorkThreadEntityMatch(range: numberRange, entity: .chip(prChip(number: number, token: token, range: numberRange))))
    }

    if !lookup.linearTeamKeys.isEmpty {
      for match in proseLinearRegex.matches(in: text, range: full) {
        let idRange = match.range(at: 1)
        if let chip = linearChip(ns.substring(with: idRange), lookup: lookup, range: idRange) {
          matches.append(WorkThreadEntityMatch(range: idRange, entity: .chip(chip)))
        }
      }
    }

    // Stable sort by start, then drop overlaps — the desktop's `consumedTo` loop.
    let ordered = matches.enumerated()
      .sorted { lhs, rhs in
        lhs.element.range.location == rhs.element.range.location
          ? lhs.offset < rhs.offset
          : lhs.element.range.location < rhs.element.range.location
      }
      .map(\.element)
    var out: [WorkThreadEntityMatch] = []
    var consumedTo = -1
    for match in ordered {
      if match.range.location < consumedTo { continue }
      out.append(match)
      consumedTo = NSMaxRange(match.range)
    }
    return out
  }
}

/// The lanes, chats, Linear team keys and slash commands this device knows, as
/// one lookup the transcript renderer reads. Work fills it as its lists load
/// (`WorkRootScreen`), and the composer adds the chat's slash registry once it
/// has fetched it. Publishes only when something a chip draws changes, so a
/// status tick on an unrelated row does not re-render the transcript.
@MainActor
final class WorkThreadEntityDirectory: ObservableObject {
  static let shared = WorkThreadEntityDirectory()

  @Published private(set) var revision = 0
  private(set) var lookup = WorkThreadEntityLookup.empty

  private var lanes: [WorkThreadEntityLane] = []
  private var sessions: [WorkThreadEntitySession] = []
  private var linearTeamKeys: [String] = []
  private var skillNames: [String] = []
  private var signature = ""

  private static let linearKeyRegex = try! NSRegularExpression(pattern: "^([A-Za-z][A-Za-z0-9]{0,9})-\\d+$")

  func record(lanes summaries: [LaneSummary], sessions terminalSessions: [TerminalSessionSummary]) {
    lanes = summaries.map {
      WorkThreadEntityLane(id: $0.id, name: $0.name, colorHex: $0.color?.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    var keys = Set<String>()
    for lane in summaries {
      var identifiers = (lane.linearIssueLinks ?? []).map(\.issue.identifier)
      if let identifier = lane.linearIssue?.identifier { identifiers.append(identifier) }
      for identifier in identifiers {
        let ns = identifier as NSString
        if let match = Self.linearKeyRegex.firstMatch(in: identifier, range: NSRange(location: 0, length: ns.length)) {
          keys.insert(ns.substring(with: match.range(at: 1)).uppercased())
        }
      }
    }
    linearTeamKeys = keys.sorted()
    sessions = terminalSessions.map { session in
      let live: WorkThreadEntitySession.Live?
      if session.runtimeState == "waiting-input" || session.attentionRequestedAt != nil {
        live = .waiting
      } else if session.status == "running" && session.runtimeState == "running" {
        live = .running
      } else {
        live = nil
      }
      let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
      let goal = session.goal?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      return WorkThreadEntitySession(id: session.id, title: title.isEmpty ? (goal.isEmpty ? nil : goal) : title, live: live)
    }
    rebuildIfChanged()
  }

  /// The chat's slash commands and skills, from the host registry.
  func record(skillNames names: [String]) {
    skillNames = names
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .map { $0.hasPrefix("/") ? String($0.dropFirst()) : $0 }
      .filter { !$0.isEmpty }
      .sorted()
    rebuildIfChanged()
  }

  private func rebuildIfChanged() {
    let laneParts = lanes.map { "\($0.id)\u{1}\($0.name)\u{1}\($0.colorHex ?? "")" }.joined(separator: "\u{2}")
    let sessionParts = sessions.map { "\($0.id)\u{1}\($0.title ?? "")\u{1}\(String(describing: $0.live))" }.joined(separator: "\u{2}")
    let next = [laneParts, sessionParts, linearTeamKeys.joined(separator: ","), skillNames.joined(separator: ",")]
      .joined(separator: "\u{3}")
    guard next != signature else { return }
    signature = next
    lookup = WorkThreadEntityLookup(lanes: lanes, sessions: sessions, linearTeamKeys: linearTeamKeys, skillNames: skillNames)
    revision &+= 1
  }
}

