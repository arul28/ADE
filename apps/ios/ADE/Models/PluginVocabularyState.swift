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
  static let maxStateKeys = 4
  /// Options on one `segmented` control.
  static let maxStateOptions = 8
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

/// What a `segmented` node contributes to the panel's state, lifted out of the
/// node tree so the store can build the initial state without walking it twice.
struct PluginVocabStateDeclaration: Equatable, Identifiable {
  var id: String { stateKey }
  var stateKey: String
  var label: String?
  var options: [PluginVocabStateOption]
  /// The option selected when the panel first renders. Always a declared value.
  var initial: String
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
  /// Selected on first render, already resolved from the schema's `default`.
  var initial: String
  var style: Style = .segmented
  /// Also dispatch this action on change, for a plugin that wants to know.
  var onChange: PluginVocabAction?

  /// The node as the state key it declares.
  ///
  /// The node is what renders and the declaration is what the store holds, and
  /// they are deliberately different shapes: the store needs the key, the
  /// options and the initial value with nothing optional left to resolve.
  var declaration: PluginVocabStateDeclaration {
    PluginVocabStateDeclaration(stateKey: stateKey, label: label, options: options, initial: initial)
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

  case compare(op: Op, field: String, values: [String]?, stateKey: String?)
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

  /// One clause against one row. `nil` is INACTIVE — see the file comment.
  ///
  /// Total by construction: there is no input that throws and no input that
  /// loops. A clause reads exactly two things, the row field it names and the
  /// state key it names, and both are already strings by the time they get here.
  static func evaluate(
    _ clause: PluginVocabPredicate,
    row: [String: Any],
    state: PluginVocabPanelState
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

    case let .all(clauses):
      var result: Bool?
      for child in clauses {
        guard let value = evaluate(child, row: row, state: state) else { continue }
        if !value { return false }
        result = true
      }
      return result

    case let .any(clauses):
      var result: Bool?
      for child in clauses {
        guard let value = evaluate(child, row: row, state: state) else { continue }
        if value { return true }
        result = false
      }
      return result

    case let .negated(clause):
      guard let value = evaluate(clause, row: row, state: state) else { return nil }
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
    state: PluginVocabPanelState
  ) -> Bool {
    guard let predicates, !predicates.isEmpty else { return true }
    let object = row as? [String: Any]
    for clause in predicates {
      guard let value = evaluate(clause, row: object ?? [:], state: state) else {
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
    value: (Row) -> Any?
  ) -> [Row] {
    guard let predicates, !predicates.isEmpty else { return rows }
    return rows.filter { evaluate(predicates, row: value($0), state: state) }
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
  static func declarations(in body: [PluginVocabNode]) -> [PluginVocabStateDeclaration] {
    var found: [PluginVocabStateDeclaration] = []
    var seen = Set<String>()

    func walk(_ nodes: [PluginVocabNode]) {
      for node in nodes {
        switch node {
        case let .stack(stack):
          walk(stack.children)
        case let .segmented(segmented):
          guard !seen.contains(segmented.stateKey), found.count < PluginVocabLimits.maxStateKeys else { continue }
          seen.insert(segmented.stateKey)
          found.append(segmented.declaration)
        default:
          continue
        }
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

  /// Identity of a panel's CONTROLS, not of its data.
  ///
  /// State is session-scoped and must survive a re-publish: a plugin that
  /// refreshes its fleet rows republishes the whole panel every few seconds, and
  /// resetting the filter on each one would make the control unusable. It must
  /// NOT survive a change to the controls themselves, because an option that no
  /// longer exists cannot stay selected. The signature is exactly the controls —
  /// keys, option values, and their order.
  static func signature(_ declarations: [PluginVocabStateDeclaration]) -> String {
    let shape: [[Any]] = declarations.map { [$0.stateKey, $0.initial, $0.options.map(\.value)] }
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

  static func parseSegmented(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let stateKey = parseStateKey(object["stateKey"]) else {
      return invalid("segmented", "`stateKey` is required and may not start with `$`", path: path, context: &context)
    }
    let options = parseStateOptions(object["options"])
    // One option is not a choice, and a control the reader cannot change is a
    // filter permanently stuck wherever the author left it. Two is the floor.
    guard options.count >= 2 else {
      return invalid("segmented", "`options` needs at least two distinct values", path: path, context: &context)
    }
    var node = PluginVocabSegmented(
      stateKey: stateKey,
      label: cleanString(object["label"], max: PluginVocabLimits.maxLabelChars),
      options: options,
      initial: stateInitial(options, declared: object["default"])
    )
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
    let present = ["equals", "notEquals", "in", "notIn"].filter { object[$0] != nil }
    guard present.count == 1, let key = present.first else {
      // Two operators on one clause is not a clause the author meant either way,
      // and picking one for them would filter rows nobody asked to hide.
      warn(present.isEmpty
        ? "A `where` comparison needs one of `equals`, `notEquals`, `in` or `notIn`."
        : "A `where` comparison may declare only one operator.")
      return nil
    }
    let op: PluginVocabPredicate.Op = (key == "equals" || key == "in") ? .membership : .exclusion
    let operand = object[key]

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
