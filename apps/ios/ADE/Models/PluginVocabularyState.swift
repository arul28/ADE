import Foundation

/// Client-evaluated panel state: the `segmented` control's state keys, and the
/// `where` predicate a binding filters its rows with.
///
/// Swift mirror of `apps/desktop/src/shared/plugins/vocabularyState.ts`, which is
/// the source of truth. Desktop, the web client and the TUI all evaluate through
/// that one module; the phone cannot import it, so this file exists to say the
/// same thing in Swift — and the tests in `PluginVocabularyDecodingTests` pin the
/// same cases the TypeScript ones do, because a filter that keeps a row on one
/// surface and drops it on another is worse than no filter at all.
///
/// ## What it buys
///
/// A panel that wanted a status filter could only express it as a `form`, a
/// submit button, a `panels.update()` from the plugin and a refetch: three taps
/// and a round trip for every filter change. So the vocabulary gained one
/// primitive and one clause — a `segmented` node that owns a named piece of
/// CLIENT state, and a `where` on a binding that keeps the rows whose fields
/// match, read either against a literal or against that state.
///
/// ## Rule 3 is intact
///
/// "Data, never code" forbids expressions, formatting strings, conditionals and
/// host callbacks. A predicate here is none of those: a fixed grammar of four
/// comparisons over three composers, with no functions, no regular expressions,
/// no arithmetic, no field-to-field comparison, and no reach beyond the row it
/// was handed and the state the panel declared. The plugin still computes on its
/// own machine — it materializes `status`, `laneId` and `archived` onto each row
/// — and the client still only compares strings.
///
/// ## The one thing the client computes
///
/// `since` / `before` compare a row field to an instant, and a `{"$rel": "-24h"}`
/// operand resolves that instant from the CLIENT CLOCK at evaluation time — the
/// single exception to "the client only compares strings". It exists because the
/// alternative was worse: a plugin materializing `today: "today"` onto every row
/// has written a fact that is false by morning, and there is no cheap "the day
/// changed" trigger to rewrite it with.
///
/// It resolves on RE-RENDER, never on a timer. A panel left open across midnight
/// still shows yesterday's answer until its rows change or the reader pulls the
/// declared `refreshAction`. The clock is a PARAMETER — ``filter(_:_:state:now:value:)``
/// samples it once per pass — so every row of one render sees the same instant
/// and a test can pin it instead of sleeping.
///
/// ## Three-valued evaluation
///
/// A comparison whose state key is unset — the "All" option, or a key no
/// `segmented` declared — is **inactive**, not false. An inactive clause is
/// removed from its enclosing `and`/`or`; a `not` of one is itself inactive; a
/// `where` with nothing active keeps every row. That single rule is what lets a
/// segmented control express "All" as an option with an empty `value` instead of
/// needing a second primitive for "turn this filter off".

extension PluginVocabulary {
  /// The reserved pseudo-collection a panel binds to READ its own state.
  ///
  /// Rule 3 forbids interpolation, so a panel had no way to say "Showing:
  /// Active" beside a filtered list — the words are in the option list and
  /// nothing could reach them. `$state` reads like any other collection, and the
  /// leading `$` is illegal in a real collection name, so nothing can shadow it,
  /// exactly as with ``contextCollection``.
  static let stateCollection = "$state"
}

/// The ceilings that belong to panel state, spread into the same table every
/// other vocabulary limit lives in so a schema author reads one list.
///
/// The numbers are small on purpose. A predicate language with a generous budget
/// is a query language, and a query language is the thing rule 3 exists to keep
/// out of a panel schema.
extension PluginVocabLimits {
  /// Distinct `segmented` state keys in one panel.
  ///
  /// Eight rather than four, because four was one filter axis short of the
  /// panels people actually write: an issue browser wants state, project,
  /// assignee, priority, sort and a text search, and the `group` node
  /// deliberately does NOT spend a key, so a panel with seven collapsible
  /// groups still has its whole filter budget. Eight is still small enough that
  /// every key fits in one `$state` `keyValue` node without scrolling.
  static let maxStateKeys = 8
  /// Literal options written into one `segmented` control's `options`.
  static let maxStateOptions = 8
  /// Options one control may hold once `optionsFrom` has resolved.
  ///
  /// Higher than ``maxStateOptions`` because the two are different objects. A
  /// literal list is read at a glance and drawn as a strip of pills, so eight is
  /// where a strip stops fitting; a collection-bound list is a workspace's
  /// projects or labels, drawn as a menu, and a real workspace has thirty. Fifty
  /// is where a flat menu stops being findable and the honest answer becomes the
  /// panel's nav-bar search field (`chrome.search`) — and it sits under
  /// ``maxKeyValueRows`` (60), so no client draws a longer list than one it
  /// already draws.
  static let maxBoundStateOptions = 50
  /// `list` nodes in one panel that may declare `selectable`.
  ///
  /// Two, not eight. A selection owns a bar across the panel and one word —
  /// "3 selected" — and two lists both claiming that bar is already a panel that
  /// needs splitting. Two covers the one shape that is not a mistake: a detail
  /// panel offering a batch over its issues and a batch over its pull requests.
  static let maxSelectionKeys = 2
  /// Rows selectable at once in one list.
  ///
  /// The same number as ``maxListItems``, on purpose: the ceiling on a selection
  /// is the ceiling on what a list can draw, so "select everything on screen" is
  /// always expressible and never silently drops the tail.
  static let maxSelectedRows = 100
  /// Buttons on one list's bulk-action bar.
  ///
  /// Four, where a row's own trailing actions stop at three: a row shares its
  /// width with its title, subtitle and chip, while the bar has the whole panel
  /// and draws the count and Clear itself. A fifth verb over a selection is a
  /// menu, and the vocabulary has no menu.
  static let maxBulkActions = 4
  /// Characters a `chrome.search` query may hold. Mirrors `maxSearchChars`.
  static let maxSearchChars = 200
  /// Top-level clauses on one binding's `where`. They are ANDed.
  static let maxWhereClauses = 4
  /// Nesting depth of `and`/`or`/`not`. A top-level clause is depth 1.
  static let maxWhereDepth = 3
  /// Total clauses in one binding's `where`, counted through the whole tree.
  static let maxWhereNodes = 24
  /// Literal values in one `in` / `notIn` list.
  static let maxWhereValues = 20
  /// A state key, an option value, or a predicate field name.
  static let maxStateIdChars = 120
}

// MARK: - Panel state

/// The live value of every state key a panel declared: one string each.
///
/// Per-panel, per-viewer, session-scoped. It never reaches sqlite, never syncs,
/// and never leaves the phone unless the panel declared `onChange` or the plugin
/// asked for it — see ``PluginVocabState/payload(_:)``.
typealias PluginVocabPanelState = [String: String]

/// One option of a `segmented` control.
///
/// An **empty `value` means unset**, which is how a panel writes "All". Every
/// clause reading that key goes inactive and keeps every row, so the option list
/// stays a plain list of strings and the filter needs no second concept.
struct PluginVocabStateOption: Equatable, Identifiable {
  var id: String { value }
  var value: String
  var label: String
  /// A small count or chip beside the label, e.g. `12`. Text only.
  var badge: String?
}

/// Where a control's options come from, when they are not written in the schema.
///
/// A literal option list caps at ``PluginVocabLimits/maxStateOptions``, which is
/// right for "All / Active / Failed" and useless for "project", because a real
/// workspace has thirty of those and the plugin cannot know their names when it
/// writes the schema. The plugin already materializes them — it is writing them
/// into a collection for the list beside the control — so this points the
/// control at that collection instead of asking the author to inline a list they
/// do not have.
///
/// It is a ``PluginVocabBinding`` minus the parts that would make it a second
/// query language: no `limit` (the ceiling is the ceiling), no `where` (a filter
/// over a filter's own options is a puzzle), no `allowActions` (an option
/// presses nothing). The plugin decides which rows are options by which rows it
/// writes. Mirrors `VocabStateOptionsBinding`.
struct PluginVocabStateOptionsBinding: Equatable {
  var collection: String
  /// Restricts to keys with this prefix, exactly as a node binding's does.
  var keyPrefix: String?
  /// Top-level field of the row holding the option's value.
  var valueField: String
  /// Top-level field holding the label. Falls back to the value.
  var labelField: String?
}

/// What a `segmented` node contributes to the panel's state, lifted out of the
/// node tree so the store can build the initial state without walking it twice.
struct PluginVocabStateDeclaration: Equatable, Identifiable {
  enum Kind: String, Equatable {
    case segmented
    case search
  }

  var id: String { stateKey }
  var stateKey: String
  /// `search` is the nav-bar field (`chrome.search`). Absent/`segmented` is a
  /// closed option list, so every declaration written before this kind existed
  /// still means a segmented control.
  var kind: Kind = .segmented
  var label: String?
  /// Placeholder shown while a `search` field is empty.
  var placeholder: String?
  /// Every option the control offers: the literal ones first, then whatever
  /// ``optionsFrom`` resolved to. Literals first because that is where the "All"
  /// sentinel is written, and a reader looks for it at the top.
  ///
  /// Empty for a `search` declaration — the value is free text, not a choice.
  var options: [PluginVocabStateOption]
  /// The option selected when the panel first renders. Always a declared value.
  var initial: String
  /// How the author asked for it to be drawn. See
  /// ``PluginVocabState/controlStyle(_:)``.
  var style: PluginVocabSegmented.Style?
  /// Set when the options came from a collection rather than from the schema.
  var optionsFrom: PluginVocabStateOptionsBinding?

  var isSearch: Bool { kind == .search }
}

/// What a `list` node's `selectable` contributes, in the shape the store holds.
///
/// The bulk actions are named by id only. The buttons themselves are node data;
/// the ids are all the lifecycle needs, because they are what decides whether a
/// re-published panel is offering the same control. Mirrors
/// `VocabSelectionDeclaration`.
struct PluginVocabSelectionDeclaration: Equatable, Identifiable {
  var id: String { stateKey }
  var stateKey: String
  /// Most rows selectable at once, already clamped to the ceiling.
  var max: Int
  /// The bulk action ids, in the order they are drawn.
  var actionIds: [String]
}

/// The rows a reader has ticked, per `selectable` list.
///
/// A second map beside ``PluginVocabPanelState`` rather than a value inside it,
/// because the two hold different shapes — one string against a closed option
/// list, versus an open set of row keys — and folding a set into a delimited
/// string would put a parser between the reader's tick and the panel's redraw,
/// and would leak into `$state` and into the `state` payload, neither of which
/// wants a hundred issue ids in it.
///
/// Everything else about the two is deliberately identical: same per-panel,
/// per-viewer, session-only lifetime; same signature/normalize pair; same reset
/// verb. Mirrors `VocabPanelSelection`.
typealias PluginVocabPanelSelection = [String: [String]]

/// What a client actually draws for a state control, including the one form an
/// author cannot ask for.
///
/// `menu` is computed, never declared. A strip of pills is the right picture for
/// three states and the wrong one for thirty projects, and the author of a
/// collection-bound control cannot know which they will get — the row count is
/// the reader's workspace, not the schema. So the decision is made from the
/// resolved list, once, and every surface reads it: over
/// ``PluginVocabLimits/maxStateOptions`` the control is a menu that names the
/// current choice, under it the strip it has always been. Mirrors
/// `VocabStateControlStyle`.
enum PluginVocabStateControlStyle: String, Equatable {
  case segmented
  case toggle
  case menu
  case search
}

/// A closed set of options with one selected, owning a named piece of CLIENT
/// state.
///
/// The only node in the vocabulary that holds state, and deliberately the
/// smallest thing that could: an option list, a default, and a key other nodes
/// name. It dispatches nothing by itself — a change re-renders the panel from
/// rows already in memory, which is the entire point. `onChange` exists for the
/// plugin that also wants to know, and is not needed for the filter to work.
///
/// A `toggle` is this node with two options rather than a second component,
/// because a switch and a two-option segmented control are the same choice drawn
/// differently, and two components would be two parsers and two chances for a
/// client to disagree.
struct PluginVocabSegmented: Equatable {
  enum Style: String { case segmented, toggle }

  /// Panel-local state key. Same shape as a collection name; no leading `$`.
  var stateKey: String
  /// Shown beside the control, and used as the `$state` row's key.
  var label: String?
  var options: [PluginVocabStateOption]
  /// Selected on first render.
  ///
  /// For a literal control this is already resolved from the schema's `default`
  /// against the option list. For a BOUND control it is the author's `default`
  /// VERBATIM: resolving it against the literal options — which is right for a
  /// literal control, where that list is the whole control — would throw away a
  /// default naming a row nobody has fetched yet, every time. The resolution
  /// moves to ``declaration(resolved:)``, which runs where the rows are.
  var initial: String
  var style: Style = .segmented
  /// Take the rest of the options from a collection the plugin already writes.
  ///
  /// For the option list an author cannot inline because they do not know it: a
  /// workspace's projects, its labels, its assignees. The literal ``options``
  /// are still drawn, first, which is where the "All" sentinel goes — so a bound
  /// control declaring `[{value: "", label: "All projects"}]` reads the same as
  /// a literal one and needs no second concept for "no filter".
  var optionsFrom: PluginVocabStateOptionsBinding?
  /// Also dispatch this action on change, for a plugin that wants to know.
  var onChange: PluginVocabAction?

  /// The node as the state key it declares.
  ///
  /// The node is what renders and the declaration is what the store holds, and
  /// they are deliberately different shapes: the store needs the key, the
  /// options and the initial value with nothing optional left to resolve, so
  /// that ``PluginVocabState/initialState(_:)`` and
  /// ``PluginVocabState/signature(_:)`` never have to repeat the `default`
  /// fallback and never disagree about it. Mirrors `vocabSegmentedDeclaration`.
  ///
  /// - Parameter resolved: the options ``optionsFrom`` resolved to, when the
  ///   caller has the rows. A store that has not fetched them yet passes
  ///   nothing and gets the literal options, which is a working control on its
  ///   "All" — never a control with no options at all.
  func declaration(resolved: [PluginVocabStateOption]? = nil) -> PluginVocabStateDeclaration {
    let merged: [PluginVocabStateOption]
    if optionsFrom != nil, let resolved {
      merged = PluginVocabState.mergeStateOptions(options, resolved)
    } else {
      merged = options
    }
    // A bound control opens on the unset "All" unless its declared default is
    // already among the resolved options. Falling back to the first option the
    // way a literal control does would open it on whichever project the
    // collection happened to yield first, which is a filter the reader did not
    // ask for and a different one on every machine.
    let start: String
    if optionsFrom != nil {
      start = merged.contains { $0.value == initial } ? initial : ""
    } else {
      start = initial
    }
    return PluginVocabStateDeclaration(
      stateKey: stateKey,
      label: label,
      options: merged,
      initial: start,
      style: style,
      optionsFrom: optionsFrom
    )
  }
}

// MARK: - Predicates

/// A parsed `where` clause.
///
/// `equals` folds into `in` with a single value and `notEquals` into `notIn`,
/// because they evaluate identically and one code path cannot drift from itself.
/// A comparison reads EITHER `values` (a literal list) or `stateKey` (the current
/// value of a declared state key), never both.
indirect enum PluginVocabPredicate: Equatable {
  enum Op: String, Equatable { case membership, exclusion }
  /// The two operators that read a field as a TIME rather than as text.
  enum TimeOp: String, Equatable { case since, before }

  case compare(op: Op, field: String, values: [String]?, stateKey: String?)
  /// Case-insensitive substring. Empty needle is inactive. Mirrors `contains`.
  case contains(field: String, needle: String?, stateKey: String?)
  /// `since` / `before`, holding EITHER an absolute instant in epoch
  /// milliseconds, an offset from the render clock, or a state key whose
  /// selected value is read as one of those two.
  case time(op: TimeOp, field: String, at: Double?, relMs: Double?, stateKey: String?)
  case all([PluginVocabPredicate])
  case any([PluginVocabPredicate])
  case negated(PluginVocabPredicate)
}

// MARK: - Evaluation

/// The evaluator and the panel-state lifecycle, in one namespace so every caller
/// reads the same rules.
enum PluginVocabState {
  /// A row field as the text a predicate compares against.
  ///
  /// Deliberately NOT the DISPLAY coercion, which turns `true` into `"Yes"` —
  /// the right cell and the wrong operand. A plugin writing `archived: false`
  /// and filtering on `"false"` must match, so booleans read as their JSON
  /// words here. An object or an array has no text form a plugin could have
  /// meant, so it compares as empty and matches only an operand that is itself
  /// empty — which is inactive, so in practice it never matches.
  static func fieldText(_ value: Any?) -> String {
    if let text = value as? String {
      return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if let flag = PluginPanelParser.boolValue(value) {
      return flag ? "true" : "false"
    }
    if let number = PluginPanelParser.numberValue(value) {
      return PluginPanelParser.formatNumber(number)
    }
    return ""
  }

  // MARK: Times

  /// The one calendar shape a `since` / `before` operand or row field may take.
  ///
  /// Deliberately narrow. Four clients evaluate this predicate and a filter that
  /// keeps a row on one surface and drops it on another is worse than no filter,
  /// so the accepted set is a bare `YYYY-MM-DD` (read as UTC midnight) or a
  /// date-time carrying an EXPLICIT zone. A zoneless date-time is a different
  /// instant on every device that reads it, so it is not a time at all here.
  private static let isoPattern = try? NSRegularExpression(
    pattern: #"^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:?\d{2}))?$"#
  )

  /// `-24h`, `+90m`, `-7d`. The sign is required — see ``relOffset(_:)``.
  private static let relPattern = try? NSRegularExpression(pattern: #"^([+-])(\d{1,6})([mhd])$"#)

  private static let isoReader: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private static func capture(_ match: NSTextCheckingResult, _ index: Int, in text: String) -> String? {
    let range = match.range(at: index)
    guard range.location != NSNotFound, let bounds = Range(range, in: text) else { return nil }
    return String(text[bounds])
  }

  /// `{"$rel": "-24h"}` as an offset in milliseconds, or `nil`.
  ///
  /// The sign is required. A bare `"24h"` is exactly as likely to mean "the last
  /// day" as "the next one", and guessing would silently point a filter at the
  /// wrong half of the timeline — the one failure this grammar cannot show the
  /// reader. Units are lower-case `m`/`h`/`d`: `M` is minutes in one convention
  /// and months in another, and nothing here is worth that ambiguity.
  static func relOffset(_ raw: Any?) -> Double? {
    guard let text = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          let pattern = relPattern,
          let match = pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let sign = capture(match, 1, in: text),
          let digits = capture(match, 2, in: text),
          let unit = capture(match, 3, in: text),
          let magnitude = Double(digits) else { return nil }
    let scale: Double = unit == "m" ? 60_000 : (unit == "h" ? 3_600_000 : 86_400_000)
    return sign == "-" ? -(magnitude * scale) : magnitude * scale
  }

  /// A row field or a literal operand as an instant in epoch MILLISECONDS.
  ///
  /// One reader for both sides, so an operand and the field it is compared
  /// against can never be understood differently.
  static func timeValue(_ raw: Any?) -> Double? {
    if let text = raw as? String {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard let pattern = isoPattern,
            let match = pattern.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
            let date = capture(match, 1, in: trimmed) else { return nil }
      let clock = capture(match, 2, in: trimmed)
      let seconds = capture(match, 3, in: trimmed) ?? "00"
      // Rebuilt into the one spelling every client agrees on before it is
      // parsed, so a nanosecond fraction from a Go API and a millisecond one
      // from a browser land on the same instant, and `+0200` and `+02:00` are
      // the same zone.
      let millis = capture(match, 4, in: trimmed).map { String(($0 + "000").prefix(3)) } ?? "000"
      var offset = "Z"
      if let zone = capture(match, 5, in: trimmed), zone != "Z", zone != "z" {
        offset = zone.count == 5 ? String(zone.prefix(3)) + ":" + String(zone.suffix(2)) : zone
      }
      let normalized = clock.map { "\(date)T\($0):\(seconds).\(millis)\(offset)" }
        ?? "\(date)T00:00:00.000Z"
      guard let parsed = isoReader.date(from: normalized) else { return nil }
      return parsed.timeIntervalSince1970 * 1000
    }
    // A JSON number is epoch milliseconds. `numberValue` refuses a boolean and
    // never reads a numeric STRING, which matters: `"2026"` is a year an author
    // wrote, not an instant three seconds after 1970.
    return PluginPanelParser.numberValue(raw)
  }

  /// The instant a `since` / `before` clause compares against, or `nil` when the
  /// clause is INACTIVE.
  ///
  /// A `{"$state": …}` operand goes inactive exactly where a text comparison
  /// does — unset, or a value the reader's control cannot express as a time — so
  /// a segmented control can offer `""` / `-24h` / `-7d` as "All / Today / This
  /// week" with no second concept for turning the filter off.
  static func timeOperand(
    at: Double?,
    relMs: Double?,
    stateKey: String?,
    state: PluginVocabPanelState,
    now: Double
  ) -> Double? {
    if let stateKey {
      guard let selected = state[stateKey], !selected.isEmpty else { return nil }
      if let offset = relOffset(selected) { return now + offset }
      return timeValue(selected)
    }
    if let relMs { return now + relMs }
    return at
  }

  /// The lowercase needle a `contains` clause compares against, or `nil` when
  /// the clause is INACTIVE.
  static func containsNeedle(
    needle: String?,
    stateKey: String?,
    state: PluginVocabPanelState
  ) -> String? {
    if let stateKey {
      guard let selected = state[stateKey] else { return nil }
      let trimmed = selected.trimmingCharacters(in: .whitespacesAndNewlines)
      let folded = String(trimmed.prefix(PluginVocabLimits.maxSearchChars)).lowercased()
      return folded.isEmpty ? nil : folded
    }
    let literal = (needle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let folded = String(literal.prefix(PluginVocabLimits.maxSearchChars)).lowercased()
    return folded.isEmpty ? nil : folded
  }

  /// The wall clock in epoch milliseconds. The default every caller that has no
  /// opinion uses, and the seam a test replaces instead of sleeping.
  static func nowMilliseconds() -> Double { Date().timeIntervalSince1970 * 1000 }

  // MARK: Evaluation

  /// One clause against one row. `nil` is INACTIVE — see the file comment.
  ///
  /// Total by construction: there is no input that throws and no input that
  /// loops. A clause reads exactly two things, the row field it names and the
  /// state key it names, and both are already strings by the time they get here.
  static func evaluate(
    _ clause: PluginVocabPredicate,
    row: [String: Any],
    state: PluginVocabPanelState,
    now: Double = PluginVocabState.nowMilliseconds()
  ) -> Bool? {
    switch clause {
    case let .compare(op, field, values, stateKey):
      var operands = values
      if let stateKey {
        // Unset, or a key no `segmented` declared. Inactive rather than false:
        // an "All" option and a typo both mean "this filter is not filtering",
        // and hiding every row would be the worst reading of either.
        guard let selected = state[stateKey], !selected.isEmpty else { return nil }
        operands = [selected]
      }
      guard let operands, !operands.isEmpty else { return nil }
      return operands.contains(fieldText(row[field])) == (op == .membership)

    case let .contains(field, needle, stateKey):
      guard let folded = containsNeedle(needle: needle, stateKey: stateKey, state: state) else {
        return nil
      }
      let haystack = fieldText(row[field])
      if haystack.isEmpty { return false }
      return haystack.lowercased().contains(folded)

    case let .time(op, field, at, relMs, stateKey):
      guard let instant = timeOperand(at: at, relMs: relMs, stateKey: stateKey, state: state, now: now) else {
        return nil
      }
      // A row with no readable time cannot answer the question, so it fails the
      // comparison — exactly as a row with no `statusGroup` already fails an
      // `equals`. INACTIVE belongs to the operand side of the grammar (an unset
      // `$state`, an author's typo); a missing field has always been the row's
      // problem and has always dropped it.
      guard let value = timeValue(row[field]) else { return false }
      return op == .since ? value >= instant : value < instant

    case let .all(clauses):
      var result: Bool?
      for child in clauses {
        guard let value = evaluate(child, row: row, state: state, now: now) else { continue }
        if !value { return false }
        result = true
      }
      return result

    case let .any(clauses):
      var result: Bool?
      for child in clauses {
        guard let value = evaluate(child, row: row, state: state, now: now) else { continue }
        if value { return true }
        result = false
      }
      return result

    case let .negated(clause):
      guard let value = evaluate(clause, row: row, state: state, now: now) else { return nil }
      return !value
    }
  }

  /// Does this row survive the binding's `where`?
  ///
  /// A row that is not an object cannot answer a field comparison, so an ACTIVE
  /// predicate drops it. With no active clause every row is kept, including that
  /// one — which is what an unfiltered binding has always done.
  static func evaluate(
    _ predicates: [PluginVocabPredicate]?,
    row: Any?,
    state: PluginVocabPanelState,
    now: Double = PluginVocabState.nowMilliseconds()
  ) -> Bool {
    guard let predicates, !predicates.isEmpty else { return true }
    let object = row as? [String: Any]
    for clause in predicates {
      guard let value = evaluate(clause, row: object ?? [:], state: state, now: now) else {
        // Inactive clauses are not votes. Only a clause that actually compared
        // something can drop a row.
        continue
      }
      if !value || object == nil { return false }
    }
    return true
  }

  /// Keep the rows a binding's `where` admits, in order.
  ///
  /// Generic over the row wrapper so the store can filter `PluginCollectionEntry`
  /// values without unpacking them into a second array first.
  static func filter<Row>(
    _ predicates: [PluginVocabPredicate]?,
    _ rows: [Row],
    state: PluginVocabPanelState,
    now: Double = PluginVocabState.nowMilliseconds(),
    value: (Row) -> Any?
  ) -> [Row] {
    guard let predicates, !predicates.isEmpty else { return rows }
    // Read once for the whole pass. A `{"$rel": …}` clock sampled per row would
    // let two rows a microsecond apart land on different sides of the same
    // boundary, which is a filter that disagrees with itself.
    return rows.filter { evaluate(predicates, row: value($0), state: state, now: now) }
  }

  // MARK: - Declarations and lifecycle

  /// Every state key a parsed panel declares, in reading order, first
  /// declaration winning.
  ///
  /// First rather than last because the first one is the control the reader sees
  /// highest on the page, and its default is the one they will assume is in
  /// force. Over ``PluginVocabLimits/maxStateKeys`` the extras are dropped: their
  /// controls still render and still set state, they simply share nothing with a
  /// `where`, which is the honest failure for a panel that declared too many.
  /// - Parameter resolveOptions: the options a control's `optionsFrom` resolves
  ///   to, from rows the store has already fetched. A caller with no rows yet
  ///   omits it and gets each control's literal options, which is a working
  ///   control on its "All" rather than an empty one — and the signature does
  ///   not move when the rows do land, so the reader's selection survives that
  ///   transition. See ``signature(_:)``.
  static func declarations(
    in body: [PluginVocabNode],
    chrome: PluginVocabPanelChrome? = nil,
    resolveOptions: (PluginVocabStateOptionsBinding) -> [PluginVocabStateOption] = { _ in [] }
  ) -> [PluginVocabStateDeclaration] {
    var found: [PluginVocabStateDeclaration] = []
    var seen = Set<String>()

    if let search = chrome?.search, found.count < PluginVocabLimits.maxStateKeys {
      found.append(PluginVocabStateDeclaration(
        stateKey: search.stateKey,
        kind: .search,
        placeholder: search.placeholder,
        options: [],
        initial: ""
      ))
      seen.insert(search.stateKey)
    }

    func walk(_ nodes: [PluginVocabNode]) {
      for node in nodes {
        guard case let .segmented(segmented) = node else {
          // Every container, through the one accessor — a `segmented` inside a
          // `group` declares its key exactly as one inside a `stack` does.
          walk(node.childNodes)
          continue
        }
        guard !seen.contains(segmented.stateKey), found.count < PluginVocabLimits.maxStateKeys else { continue }
        seen.insert(segmented.stateKey)
        // A caller with no rows leaves the default resolver in place and gets
        // the empty list, which merges to exactly the literal options — the
        // same answer TypeScript gives for an absent resolver.
        let resolved = segmented.optionsFrom.map { resolveOptions($0) }
        found.append(segmented.declaration(resolved: resolved))
      }
    }

    walk(body)
    return found
  }

  /// The state a freshly opened panel starts in.
  static func initialState(_ declarations: [PluginVocabStateDeclaration]) -> PluginVocabPanelState {
    var state: PluginVocabPanelState = [:]
    for declaration in declarations { state[declaration.stateKey] = declaration.initial }
    return state
  }

  // MARK: Collection-bound options

  /// A collection's rows as a control's options.
  ///
  /// Reads exactly two top-level fields of each row and coerces them the way a
  /// predicate reads a field, not the way a cell is displayed — an option's
  /// value is compared against a row's field by `where`, and `true` must compare
  /// as `"true"` on both sides rather than as `"Yes"` on one of them.
  ///
  /// A row with no readable value is dropped rather than becoming a blank
  /// option: the empty value is the "All" sentinel and a collection cannot be
  /// allowed to mint a second one. Duplicates collapse, first row winning,
  /// exactly as a literal list's do. Mirrors `vocabResolveStateOptions`.
  ///
  /// - Parameter rows: the stored VALUE of each collection row, in the order the
  ///   store read them.
  static func resolveStateOptions(
    _ binding: PluginVocabStateOptionsBinding,
    rows: [Any?]
  ) -> [PluginVocabStateOption] {
    var options: [PluginVocabStateOption] = []
    var seen = Set<String>()
    for row in rows {
      guard let object = row as? [String: Any] else { continue }
      let value = String(fieldText(object[binding.valueField]).prefix(PluginVocabLimits.maxStateIdChars))
      if value.isEmpty || seen.contains(value) { continue }
      let label = binding.labelField.flatMap { PluginPanelParser.stateText(object[$0]) } ?? value
      seen.insert(value)
      options.append(PluginVocabStateOption(
        value: value,
        label: label,
        badge: PluginPanelParser.parseStateBadge(object["badge"])
      ))
      if options.count >= PluginVocabLimits.maxBoundStateOptions { break }
    }
    return options
  }

  /// The literal options and the resolved ones as one list, capped.
  ///
  /// Literals first because that is where the "All" sentinel lives and a reader
  /// looks for it at the top; a resolved value that repeats a literal one loses,
  /// because the literal is the option the author wrote a label for. Mirrors
  /// `vocabMergeStateOptions`.
  static func mergeStateOptions(
    _ literal: [PluginVocabStateOption],
    _ resolved: [PluginVocabStateOption]
  ) -> [PluginVocabStateOption] {
    var options = literal
    var seen = Set(literal.map(\.value))
    for option in resolved {
      if seen.contains(option.value) { continue }
      seen.insert(option.value)
      options.append(option)
      if options.count >= PluginVocabLimits.maxBoundStateOptions { break }
    }
    return options
  }

  /// How this control is actually drawn. See ``PluginVocabStateControlStyle``:
  /// `menu` is computed from the resolved option count and is the one form an
  /// author cannot ask for. Mirrors `vocabStateControlStyle`.
  static func controlStyle(_ declaration: PluginVocabStateDeclaration) -> PluginVocabStateControlStyle {
    if declaration.isSearch { return .search }
    if declaration.options.count > PluginVocabLimits.maxStateOptions { return .menu }
    switch declaration.style ?? .segmented {
    case .segmented: return .segmented
    case .toggle: return .toggle
    }
  }

  /// Identity of a panel's CONTROLS, not of its data.
  ///
  /// State is session-scoped and must survive a re-publish: a plugin that
  /// refreshes its fleet rows republishes the whole panel every few seconds, and
  /// resetting the filter on each one would make the control unusable. It must
  /// NOT survive a change to the controls themselves, because an option that no
  /// longer exists cannot stay selected. The signature is exactly the controls —
  /// keys, option values, and their order.
  ///
  /// A control whose options came from a collection signs its BINDING instead of
  /// its resolved values, and that difference is the whole reason `optionsFrom`
  /// is usable. Its options are data: a project created in another window, or
  /// the second page of a fetch landing, would otherwise change the signature
  /// and drop the reader's filter — an unusable control, for a change they did
  /// not make and cannot see. The binding is what the author declared, so it
  /// moves only when the schema does. The fine reconciliation still applies: a
  /// value that is no longer an option falls back through
  /// ``normalize(_:declarations:)``.
  ///
  /// The two signatures never travel between clients — this one is compared only
  /// against itself, one panel and one process at a time — so what matters is
  /// that the same schema change moves it here and in TypeScript alike, not that
  /// the two spell the same string.
  static func signature(_ declarations: [PluginVocabStateDeclaration]) -> String {
    let shape: [[Any]] = declarations.map { declaration -> [Any] in
      if declaration.isSearch {
        return [declaration.stateKey, ["$search", declaration.placeholder ?? ""]]
      }
      guard let binding = declaration.optionsFrom else {
        return [declaration.stateKey, declaration.initial, declaration.options.map(\.value)]
      }
      return [
        declaration.stateKey,
        ["$from", binding.collection, binding.keyPrefix ?? "", binding.valueField, binding.labelField ?? ""],
      ]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: shape),
          let text = String(data: data, encoding: .utf8) else {
      // Unreachable for arrays of strings, and a distinct value rather than "" so
      // a failure reads as "these controls changed" instead of "fresh panel".
      return declarations.map(\.stateKey).joined(separator: "\u{1}")
    }
    return text
  }

  /// Carry a reader's selections onto a newly parsed panel.
  ///
  /// Keys the new schema does not declare are dropped, and a value that is no
  /// longer an option falls back to that control's initial. Callers that also
  /// compare ``signature(_:)`` get the coarse reset; this is the fine one, and
  /// both are needed — the signature catches a control that vanished, this
  /// catches a value inside one that did not.
  static func normalize(
    _ state: PluginVocabPanelState,
    declarations: [PluginVocabStateDeclaration]
  ) -> PluginVocabPanelState {
    var next: PluginVocabPanelState = [:]
    for declaration in declarations {
      let current = state[declaration.stateKey]
      if declaration.isSearch {
        if let current {
          next[declaration.stateKey] = String(current.prefix(PluginVocabLimits.maxSearchChars))
        } else {
          next[declaration.stateKey] = declaration.initial
        }
        continue
      }
      next[declaration.stateKey] = declaration.options.contains { $0.value == current }
        ? (current ?? declaration.initial)
        : declaration.initial
    }
    return next
  }

  /// Set one key, refusing a value the control never offered.
  static func apply(
    _ state: PluginVocabPanelState,
    declaration: PluginVocabStateDeclaration,
    value: String
  ) -> PluginVocabPanelState {
    if declaration.isSearch {
      let nextValue = String(value.prefix(PluginVocabLimits.maxSearchChars))
      guard state[declaration.stateKey] != nextValue else { return state }
      var next = state
      next[declaration.stateKey] = nextValue
      return next
    }
    guard declaration.options.contains(where: { $0.value == value }) else { return state }
    guard state[declaration.stateKey] != value else { return state }
    var next = state
    next[declaration.stateKey] = value
    return next
  }

  /// The state as bindable rows, one per declared key, in declaration order.
  ///
  /// The row's key is the control's label and its value is the SELECTED OPTION'S
  /// label, not the raw value — a reader wants "Showing: Active", and "Showing:
  /// FINISHED_WITH_ERROR" is the machine's half of the same fact.
  static func rows(
    _ declarations: [PluginVocabStateDeclaration],
    state: PluginVocabPanelState
  ) -> [PluginVocabKeyValueRow] {
    declarations.map { declaration in
      let current = state[declaration.stateKey] ?? declaration.initial
      if declaration.isSearch {
        return PluginVocabKeyValueRow(
          key: declaration.label ?? declaration.stateKey,
          value: current
        )
      }
      let option = declaration.options.first { $0.value == current }
      return PluginVocabKeyValueRow(
        key: declaration.label ?? declaration.stateKey,
        value: option?.label ?? current
      )
    }
  }

  /// What rides on an action invoke under `state`, or `nil` when the panel has
  /// none.
  ///
  /// Reported so a "Refresh" button can respect the filter the reader is looking
  /// at: without it the plugin refetches the whole fleet and the client
  /// re-filters, which is correct but wasteful, and a plugin paginating an API
  /// cannot page the filtered set at all.
  static func payload(_ state: PluginVocabPanelState) -> [String: String]? {
    state.isEmpty ? nil : state
  }

  /// Apply a `{resetState}` to the current state. Unknown keys are ignored.
  static func reset(
    _ state: PluginVocabPanelState,
    declarations: [PluginVocabStateDeclaration],
    reset: PluginInvokeStateReset
  ) -> PluginVocabPanelState {
    switch reset {
    case .all:
      return initialState(declarations)
    case let .keys(keys):
      var next = state
      for key in keys {
        guard let declaration = declarations.first(where: { $0.stateKey == key }) else { continue }
        next[key] = declaration.initial
      }
      return next
    }
  }

  // MARK: - Selection lifecycle

  /// Every selectable list a parsed panel declares, in reading order, first
  /// declaration winning.
  ///
  /// The same rule and the same reason as ``declarations(in:resolveOptions:)``:
  /// the first one is the list the reader sees highest on the page, and a list
  /// past ``PluginVocabLimits/maxSelectionKeys`` still draws its rows — it
  /// simply draws no ticks and no bar, which is the honest failure for a panel
  /// that asked for three selections. Mirrors
  /// `collectVocabSelectionDeclarations`.
  static func selectionDeclarations(in body: [PluginVocabNode]) -> [PluginVocabSelectionDeclaration] {
    var found: [PluginVocabSelectionDeclaration] = []
    var seen = Set<String>()

    func walk(_ nodes: [PluginVocabNode]) {
      for node in nodes {
        if case let .list(list) = node, let selectable = list.selectable {
          if !seen.contains(selectable.stateKey), found.count < PluginVocabLimits.maxSelectionKeys {
            seen.insert(selectable.stateKey)
            found.append(PluginVocabSelectionDeclaration(
              stateKey: selectable.stateKey,
              max: selectable.max,
              actionIds: selectable.actions.map(\.action.action)
            ))
          }
        }
        walk(node.childNodes)
      }
    }

    walk(body)
    return found
  }

  /// The selection a freshly opened panel starts in: every list, nothing ticked.
  static func initialSelection(
    _ declarations: [PluginVocabSelectionDeclaration]
  ) -> PluginVocabPanelSelection {
    var selection: PluginVocabPanelSelection = [:]
    for declaration in declarations { selection[declaration.stateKey] = [] }
    return selection
  }

  /// Identity of a panel's selectable LISTS, not of their rows.
  ///
  /// Row keys are deliberately absent. A plugin republishing its rows every few
  /// seconds changes which rows exist constantly, and a selection that emptied
  /// on each of those would make a batch impossible to assemble — the same
  /// argument that keeps ``signature(_:)`` off the data. What resets a selection
  /// is the CONTROL changing: a different state key, a different cap, or a
  /// different set of bulk actions, all of which mean the panel is offering
  /// something other than what the reader ticked rows for. Mirrors
  /// `vocabSelectionSignature`.
  static func selectionSignature(_ declarations: [PluginVocabSelectionDeclaration]) -> String {
    let shape: [[Any]] = declarations.map { [$0.stateKey, $0.max, $0.actionIds] }
    guard let data = try? JSONSerialization.data(withJSONObject: shape),
          let text = String(data: data, encoding: .utf8) else {
      // Unreachable for strings and ints, and a distinct value rather than ""
      // so a failure reads as "these lists changed", not "fresh panel".
      return declarations.map(\.stateKey).joined(separator: "\u{1}")
    }
    return text
  }

  /// Carry a reader's ticks onto a newly parsed panel.
  ///
  /// Keys the new schema does not declare are dropped and the cap is re-applied,
  /// so a republish that lowered `max` cannot leave more rows ticked than the
  /// control now allows. Row keys the panel no longer holds are NOT pruned here
  /// — see ``selectedRowKeys(_:stateKey:rowKeys:)``, which is where a selection
  /// meets the rows that actually rendered. Mirrors
  /// `vocabNormalizePanelSelection`.
  static func normalizeSelection(
    _ selection: PluginVocabPanelSelection,
    declarations: [PluginVocabSelectionDeclaration]
  ) -> PluginVocabPanelSelection {
    var next: PluginVocabPanelSelection = [:]
    for declaration in declarations {
      var kept: [String] = []
      for key in selection[declaration.stateKey] ?? [] {
        if key.isEmpty || kept.contains(key) { continue }
        kept.append(key)
        if kept.count >= declaration.max { break }
      }
      next[declaration.stateKey] = kept
    }
    return next
  }

  /// Tick or untick one row.
  ///
  /// At the cap, ticking a new row is REFUSED rather than evicting the oldest
  /// one. A silent eviction would take a row out of a batch the reader believes
  /// they assembled, and the count on the bar is the only thing that could have
  /// told them — untick is a gesture they have, a row vanishing from under them
  /// is not. Unticking always works, cap or no cap. Mirrors
  /// `vocabToggleRowSelection`.
  static func toggleRow(
    _ selection: PluginVocabPanelSelection,
    declaration: PluginVocabSelectionDeclaration,
    rowKey: String
  ) -> PluginVocabPanelSelection {
    guard !rowKey.isEmpty else { return selection }
    var next = selection
    var current = selection[declaration.stateKey] ?? []
    if let index = current.firstIndex(of: rowKey) {
      current.remove(at: index)
      next[declaration.stateKey] = current
      return next
    }
    guard current.count < declaration.max else { return selection }
    current.append(rowKey)
    next[declaration.stateKey] = current
    return next
  }

  /// Tick every row of a range, keeping what was already ticked.
  ///
  /// A union rather than a replacement: extending a second range must not throw
  /// away the first one, which is what a reader assembling a batch out of two
  /// clusters is doing. Fills to the cap and stops there, for the same reason
  /// ``toggleRow(_:declaration:rowKey:)`` refuses — the rows it could not take
  /// are the tail of the range the reader can see, not rows it silently swapped
  /// out. Mirrors `vocabSelectRowRange`.
  static func selectRange(
    _ selection: PluginVocabPanelSelection,
    declaration: PluginVocabSelectionDeclaration,
    rowKeys: [String]
  ) -> PluginVocabPanelSelection {
    let current = selection[declaration.stateKey] ?? []
    var next = current
    for key in rowKeys {
      if key.isEmpty || next.contains(key) { continue }
      if next.count >= declaration.max { break }
      next.append(key)
    }
    guard next.count != current.count else { return selection }
    var updated = selection
    updated[declaration.stateKey] = next
    return updated
  }

  /// Untick everything in one list. What the bar's own Clear does.
  static func clearSelection(
    _ selection: PluginVocabPanelSelection,
    declaration: PluginVocabSelectionDeclaration
  ) -> PluginVocabPanelSelection {
    guard !(selection[declaration.stateKey] ?? []).isEmpty else { return selection }
    var next = selection
    next[declaration.stateKey] = []
    return next
  }

  /// The inclusive slice between two rows, in the order they are drawn.
  ///
  /// The range-anchor half of shift-click, shared rather than left to each
  /// client, because "between" has two answers when the reader drags upwards and
  /// a client that picked the other one would tick a different set from the same
  /// gesture. An anchor or a target that is not on screen yields just the
  /// target, which is what a plain click does — the honest reading of "extend
  /// from a row that is no longer there".
  ///
  /// iOS declares no gesture that produces one (see ``PluginVocabListView``);
  /// it is mirrored here anyway so the rule has one definition and a phone that
  /// grows a keyboard-modifier gesture inherits the desktop answer rather than
  /// inventing a second one. Mirrors `vocabRowRange`.
  static func rowRange(_ rowKeys: [String], anchor: String?, target: String) -> [String] {
    guard let targetIndex = rowKeys.firstIndex(of: target) else { return [] }
    guard let anchor, let anchorIndex = rowKeys.firstIndex(of: anchor) else { return [target] }
    let from = min(anchorIndex, targetIndex)
    let to = max(anchorIndex, targetIndex)
    return Array(rowKeys[from...to])
  }

  /// The ticked rows that are actually on screen, in the order they are drawn.
  ///
  /// What the bar counts and what a bulk action is handed, and the reason the
  /// stored set is allowed to keep a key whose row is gone. A reader ticks four
  /// rows, moves a filter that hides two of them, and presses "Create lanes":
  /// the two they can see are the batch, because acting on a row nobody can see
  /// is the one outcome a selection must never produce. Moving the filter back
  /// brings the other two — and their ticks — with it, which a prune at filter
  /// time would not. Mirrors `vocabSelectedRowKeys`.
  static func selectedRowKeys(
    _ selection: PluginVocabPanelSelection,
    stateKey: String,
    rowKeys: [String]
  ) -> [String] {
    let ticked = selection[stateKey] ?? []
    guard !ticked.isEmpty else { return [] }
    let wanted = Set(ticked)
    return rowKeys.filter { wanted.contains($0) }
  }

  /// Apply a `{resetState}` to the selection.
  ///
  /// One verb for both maps. A plugin answering a bulk action with
  /// `{resetState: true}` has almost always just acted on every ticked row, and
  /// leaving them ticked would offer to do it again to rows that have moved on.
  /// A named list resets only that key, exactly as a named state key does.
  /// Mirrors `vocabResetPanelSelection`.
  static func resetSelection(
    _ selection: PluginVocabPanelSelection,
    declarations: [PluginVocabSelectionDeclaration],
    reset: PluginInvokeStateReset
  ) -> PluginVocabPanelSelection {
    switch reset {
    case .all:
      return initialSelection(declarations)
    case let .keys(keys):
      var next = selection
      for key in keys where declarations.contains(where: { $0.stateKey == key }) {
        next[key] = []
      }
      return next
    }
  }
}

// MARK: - Parsing

extension PluginPanelParser {
  /// A state key, an option value or a predicate field: trimmed, non-empty and
  /// CUT rather than ellipsized.
  ///
  /// `cleanString` appends an ellipsis when it truncates, which is right for a
  /// label and wrong for an operand — an over-long value would then compare
  /// against a string no row can hold. Mirrors the plain `slice` the TypeScript
  /// reader uses for exactly these fields.
  static func stateText(_ raw: Any?, max: Int = PluginVocabLimits.maxStateIdChars) -> String? {
    guard let text = raw as? String else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    return String(trimmed.prefix(max))
  }

  /// A state key. Same shape as a collection name, minus the `$` ADE reserves.
  static func parseStateKey(_ raw: Any?) -> String? {
    guard let key = stateText(raw), !key.hasPrefix("$") else { return nil }
    return key
  }

  /// An option's badge as text.
  ///
  /// A badge is almost always a COUNT, and a plugin that writes `badge: 12`
  /// means `"12"`. Reading only strings there would silently drop the one thing
  /// the field exists for.
  static func parseStateBadge(_ raw: Any?) -> String? {
    if let text = stateText(raw) { return text }
    guard let number = numberValue(raw) else { return nil }
    return formatNumber(number)
  }

  /// A `segmented` node's option list.
  ///
  /// Duplicate values collapse — two options that set the same state are one
  /// option with two labels, and the second would be unreachable. An option with
  /// no `label` falls back to its own value, because a control whose choices
  /// have no words is not a control; an option whose value is empty ("All")
  /// keeps its label, which is the whole point of it.
  static func parseStateOptions(_ raw: Any?) -> [PluginVocabStateOption] {
    guard let entries = raw as? [Any] else { return [] }
    var options: [PluginVocabStateOption] = []
    var seen = Set<String>()
    for entry in entries.prefix(PluginVocabLimits.maxStateOptions) {
      guard let object = entry as? [String: Any], let rawValue = object["value"] as? String else { continue }
      let value = String(
        rawValue.trimmingCharacters(in: .whitespacesAndNewlines).prefix(PluginVocabLimits.maxStateIdChars)
      )
      if seen.contains(value) { continue }
      guard let label = stateText(object["label"]) ?? (value.isEmpty ? nil : value) else { continue }
      seen.insert(value)
      options.append(PluginVocabStateOption(value: value, label: label, badge: parseStateBadge(object["badge"])))
    }
    return options
  }

  /// The initial value for one control: its `default` when that names a real
  /// option, else the first option's value.
  ///
  /// Never absent, so no client has to invent "nothing selected" — a closed
  /// option list always has something selected, even when that something is the
  /// empty "All".
  static func stateInitial(_ options: [PluginVocabStateOption], declared raw: Any?) -> String {
    if let text = raw as? String {
      // Trimmed but NOT rejected when empty: `""` is the "All" option's value,
      // and a panel is entitled to open on it.
      let declared = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if options.contains(where: { $0.value == declared }) { return declared }
    }
    return options.first?.value ?? ""
  }

  /// A control's `optionsFrom`, or `nil` when it is not a usable binding.
  ///
  /// `collection` and `valueField` are both required: without the first there is
  /// nothing to read and without the second every row would resolve to the same
  /// empty value, which is one option, not thirty. A malformed binding degrades
  /// to "this control has only its literal options", which is a control that
  /// still works — the same direction a broken `where` degrades in. Mirrors
  /// `parseVocabStateOptionsBinding`.
  static func parseStateOptionsBinding(_ raw: Any?) -> PluginVocabStateOptionsBinding? {
    guard let object = raw as? [String: Any],
          let collection = stateText(object["collection"]),
          let valueField = stateText(object["valueField"]) else {
      return nil
    }
    return PluginVocabStateOptionsBinding(
      collection: collection,
      keyPrefix: stateText(object["keyPrefix"]),
      valueField: valueField,
      labelField: stateText(object["labelField"])
    )
  }

  static func parseSegmented(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let stateKey = parseStateKey(object["stateKey"]) else {
      return invalid("segmented", "`stateKey` is required and may not start with `$`", path: path, context: &context)
    }
    let options = parseStateOptions(object["options"])
    let optionsFrom = parseStateOptionsBinding(object["optionsFrom"])
    // One option is not a choice, and a control the reader cannot change is a
    // filter permanently stuck wherever the author left it. Two is the floor —
    // but only for a control whose options are all in the schema. A bound
    // control's second option is a row that has not arrived yet, and failing it
    // at parse would make "the collection is empty right now" a broken node.
    guard optionsFrom != nil || options.count >= 2 else {
      return invalid("segmented", "`options` needs at least two distinct values", path: path, context: &context)
    }
    // A bound control keeps the author's `default` VERBATIM; a literal one
    // resolves it against the option list here. See
    // ``PluginVocabSegmented/declaration(resolved:)`` for why the two differ.
    let initial = optionsFrom == nil
      ? stateInitial(options, declared: object["default"])
      : stateText(object["default"], max: PluginVocabLimits.maxStateIdChars) ?? ""
    var node = PluginVocabSegmented(
      stateKey: stateKey,
      label: cleanString(object["label"], max: PluginVocabLimits.maxLabelChars),
      options: options,
      initial: initial
    )
    node.optionsFrom = optionsFrom
    // A "toggle" with three options is a segmented control the author
    // mislabelled. Drawing it as a switch would hide an option, so the
    // declaration loses.
    if let raw = object["style"] as? String,
       let style = PluginVocabSegmented.Style(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines)) {
      node.style = style == .toggle && options.count != 2 ? .segmented : style
    }
    node.onChange = parseAction(object["onChange"])
    return .segmented(node)
  }

  /// A binding's `where`: an array of clauses, ANDed.
  ///
  /// `nil` — not `[]` — when nothing usable was declared, so a binding that
  /// declared no filter and a binding whose filter was all garbage are the same
  /// thing to every caller: an unfiltered binding. A filter that fails shows too
  /// much, never too little, because a reader can see that a filter did nothing
  /// but cannot see rows a broken filter silently removed.
  static func parseWhere(
    _ raw: Any?,
    path: String,
    context: inout ParseContext
  ) -> [PluginVocabPredicate]? {
    guard raw != nil else { return nil }
    let entries = (raw as? [Any]) ?? [raw as Any]
    var nodes = 0
    var clauses: [PluginVocabPredicate] = []
    for entry in entries.prefix(PluginVocabLimits.maxWhereClauses) {
      guard let clause = parseWhereClause(entry, depth: 1, path: path, nodes: &nodes, context: &context) else {
        continue
      }
      clauses.append(clause)
    }
    return clauses.isEmpty ? nil : clauses
  }

  /// One clause, or `nil` when it is unusable.
  ///
  /// Every rejection is clause-local: the clause disappears with a warning and
  /// the binding keeps the clauses that parsed.
  static func parseWhereClause(
    _ raw: Any?,
    depth: Int,
    path: String,
    nodes: inout Int,
    context: inout ParseContext
  ) -> PluginVocabPredicate? {
    func warn(_ message: String) {
      context.warnings.append(PluginVocabWarning(code: .invalidBinding, path: path, message: message))
    }

    guard let object = raw as? [String: Any] else {
      warn("A `where` clause must be an object.")
      return nil
    }
    guard depth <= PluginVocabLimits.maxWhereDepth else {
      warn("A `where` clause may nest at most \(PluginVocabLimits.maxWhereDepth) levels.")
      return nil
    }
    nodes += 1
    guard nodes <= PluginVocabLimits.maxWhereNodes else {
      warn("A `where` may contain at most \(PluginVocabLimits.maxWhereNodes) clauses.")
      return nil
    }

    if let negated = object["not"] {
      guard let clause = parseWhereClause(negated, depth: depth + 1, path: path, nodes: &nodes, context: &context) else {
        return nil
      }
      return .negated(clause)
    }

    for composer in ["and", "or"] {
      guard let raw = object[composer] else { continue }
      guard let entries = raw as? [Any] else {
        warn("`\(composer)` must be an array of clauses.")
        return nil
      }
      var clauses: [PluginVocabPredicate] = []
      for entry in entries {
        guard let clause = parseWhereClause(entry, depth: depth + 1, path: path, nodes: &nodes, context: &context) else {
          continue
        }
        clauses.append(clause)
      }
      if clauses.isEmpty { return nil }
      return composer == "and" ? .all(clauses) : .any(clauses)
    }

    guard let field = stateText(object["field"]) else {
      warn("A `where` comparison needs a `field`.")
      return nil
    }
    let present = ["equals", "notEquals", "in", "notIn", "contains", "since", "before"].filter { object[$0] != nil }
    guard present.count == 1, let key = present.first else {
      // Two operators on one clause is not a clause the author meant either way,
      // and picking one for them would filter rows nobody asked to hide.
      warn(present.isEmpty
        ? "A `where` comparison needs one of `equals`, `notEquals`, `in`, `notIn`, `contains`, `since` or `before`."
        : "A `where` comparison may declare only one operator.")
      return nil
    }
    let operand = object[key]

    if let timeOp = PluginVocabPredicate.TimeOp(rawValue: key) {
      return parseTimeClause(timeOp, operand: operand, field: field, warn: warn)
    }

    if key == "contains" {
      if let reference = operand as? [String: Any], let stateKey = stateText(reference["$state"]) {
        return .contains(field: field, needle: nil, stateKey: stateKey)
      }
      guard let needle = literalText(operand) else {
        warn(#"`contains` needs a literal string or a `{"$state": …}` reference."#)
        return nil
      }
      return .contains(
        field: field,
        needle: String(needle.prefix(PluginVocabLimits.maxSearchChars)),
        stateKey: nil
      )
    }

    let op: PluginVocabPredicate.Op = (key == "equals" || key == "in") ? .membership : .exclusion

    // `{"$state":"statusFilter"}` — the one object form an operand may take.
    if let reference = operand as? [String: Any], let stateKey = stateText(reference["$state"]) {
      return .compare(op: op, field: field, values: nil, stateKey: stateKey)
    }

    // A scalar under `in`, or an array under `equals`, is read as the list it
    // obviously means rather than dropped: `op` has already folded the two
    // operators into one operation, so there is nothing left for the shape of
    // the operand to disambiguate.
    let rawValues = (operand as? [Any]) ?? [operand as Any]
    var values: [String] = []
    for entry in rawValues.prefix(PluginVocabLimits.maxWhereValues) {
      guard let text = literalText(entry), !values.contains(text) else { continue }
      values.append(text)
    }
    guard !values.isEmpty else {
      warn("`\(key)` needs at least one literal value or a `{\"$state\": …}` reference.")
      return nil
    }
    return .compare(op: op, field: field, values: values, stateKey: nil)
  }

  /// One `since` / `before` clause.
  ///
  /// Kept apart from the text comparison because the two read their operand
  /// differently and nothing else about them differs: same budget, same
  /// one-clause rejection, same place in the tree.
  static func parseTimeClause(
    _ op: PluginVocabPredicate.TimeOp,
    operand: Any?,
    field: String,
    warn: (String) -> Void
  ) -> PluginVocabPredicate? {
    // `{"$rel": "-24h"}` before `{"$state": …}`, because both are objects and
    // only one of them names a key.
    if let reference = operand as? [String: Any], reference["$rel"] != nil {
      guard let relMs = PluginVocabState.relOffset(reference["$rel"]) else {
        warn(#"`$rel` must read `-<n><m|h|d>` or `+<n><m|h|d>`, e.g. `{"$rel": "-24h"}`."#)
        return nil
      }
      return .time(op: op, field: field, at: nil, relMs: relMs, stateKey: nil)
    }
    if let reference = operand as? [String: Any], let stateKey = stateText(reference["$state"]) {
      return .time(op: op, field: field, at: nil, relMs: nil, stateKey: stateKey)
    }
    guard let at = PluginVocabState.timeValue(operand) else {
      warn("`\(op.rawValue)` needs an ISO-8601 time, epoch milliseconds, "
        + #"a `{"$rel": …}` offset or a `{"$state": …}` reference."#)
      return nil
    }
    return .time(op: op, field: field, at: at, relMs: nil, stateKey: nil)
  }

  /// A literal operand as text. The same coercion ``PluginVocabState/fieldText(_:)``
  /// applies to a row field, applied at parse instead of at read.
  static func literalText(_ raw: Any?) -> String? {
    if let text = raw as? String {
      return stateText(text)
    }
    if PluginPanelParser.boolValue(raw) != nil || numberValue(raw) != nil {
      return PluginVocabState.fieldText(raw)
    }
    return nil
  }
}
