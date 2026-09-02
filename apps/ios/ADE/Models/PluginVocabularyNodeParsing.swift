import Foundation

/// Per-component parse arms for the plugin vocabulary.
///
/// Split out of `PluginVocabularyParsing.swift` only for length; this is the
/// same parser and the same contract — `parseNode` there dispatches into every
/// function here. The rule each arm follows is identical: a malformed payload
/// returns an `invalid` node carrying why, so one broken component costs its own
/// slot and nothing more.
extension PluginPanelParser {
  static func parseStack(
    _ object: [String: Any],
    path: String,
    depth: Int,
    context: inout ParseContext
  ) -> PluginVocabNode {
    var stack = PluginVocabStack()
    if let raw = object["direction"] as? String, let value = PluginVocabStack.Direction(rawValue: raw) {
      stack.direction = value
    }
    if let raw = object["gap"] as? String, let value = PluginVocabStack.Gap(rawValue: raw) {
      stack.gap = value
    }
    if let raw = object["align"] as? String, let value = PluginVocabStack.Align(rawValue: raw) {
      stack.align = value
    }
    stack.wrap = boolValue(object["wrap"]) ?? false
    for (index, child) in (object["children"] as? [Any] ?? []).enumerated() {
      guard let node = parseNode(child, path: "\(path).children[\(index)]", depth: depth + 1, context: &context) else {
        break
      }
      stack.children.append(node)
    }
    return .stack(stack)
  }

  /// A string REFUSED when it is too long, rather than shortened.
  ///
  /// ``cleanString`` appends an ellipsis when it truncates, which is right for a
  /// title and wrong for an identity: a row key cut at the ceiling — with or
  /// without the ellipsis — names no row and no plugin record, and it would ride
  /// into a batch pointing at nothing. So an over-long key is refused, which
  /// leaves the row unselectable and visibly so. Mirrors `bounded` in
  /// `parse.ts`, the reader `readListItem` uses for exactly this field.
  static func boundedString(_ raw: Any?, max: Int) -> String? {
    guard let text = raw as? String else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= max else { return nil }
    return trimmed
  }

  /// A media source, refused when it is too long rather than shortened.
  ///
  /// The one field where ``cleanString`` was actively harmful, and the phone had
  /// it wrong in both directions: it read a `src` at ``PluginVocabLimits/maxValueChars``
  /// (1,000) where the contract says 8,192, and it TRUNCATED where the contract
  /// refuses. A `data:` thumbnail between those two numbers therefore drew on
  /// desktop and silently broke here — cut at 1,000 it still begins
  /// `data:image/png`, so it passes the renderer's scheme check and then decodes
  /// to nothing, and the appended ellipsis corrupts the base64 even where the
  /// cut happened to land on a byte boundary.
  ///
  /// So this draws the opposite conclusion from the same fact: a source over the
  /// ceiling is not a long source, it is an unusable one, and the node parsers
  /// turn `nil` here into their own honest empty state. Mirrors `vocabMediaSrc`
  /// in `vocabularyNodes.ts`.
  static func mediaSrc(_ raw: Any?) -> String? {
    boundedString(raw, max: PluginVocabLimits.maxSrcChars)
  }

  /// A titled section the reader can collapse.
  ///
  /// A `stack` with a disclosure and a title, and the title is the one required
  /// field: a disclosure with no word on it is a triangle the reader has to open
  /// to find out what they opened. Its children are parsed exactly as a stack's
  /// are and count against the same node budget, because they are nodes.
  ///
  /// Nothing here touches panel state — see ``PluginVocabGroup`` for why
  /// open/closed is client-local. Mirrors the `group` arm of `NODE_PARSERS`.
  static func parseGroup(
    _ object: [String: Any],
    path: String,
    depth: Int,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let title = cleanString(object["title"], max: PluginVocabLimits.maxLabelChars) else {
      return invalid("group", "`title` is required", path: path, context: &context)
    }
    var group = PluginVocabGroup(title: title)
    group.groupKey = cleanString(object["groupKey"], max: PluginVocabLimits.maxIdChars)
    group.badge = parseStateBadge(object["badge"])
    group.icon = cleanString(object["icon"], max: PluginVocabLimits.maxIdChars)
    group.defaultOpen = boolValue(object["defaultOpen"]) ?? true
    for (index, child) in (object["children"] as? [Any] ?? []).enumerated() {
      guard let node = parseNode(child, path: "\(path).children[\(index)]", depth: depth + 1, context: &context) else {
        break
      }
      group.children.append(node)
    }
    return .group(group)
  }

  static func parseText(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let text = cleanString(object["text"], max: PluginVocabLimits.maxTextChars) else {
      return invalid("text", "`text` is required", path: path, context: &context)
    }
    var node = PluginVocabText(text: text)
    if let raw = object["variant"] as? String, let variant = PluginVocabText.Variant(rawValue: raw) {
      node.variant = variant
    }
    node.tone = PluginVocabTone.normalize(object["tone"])
    return .text(node)
  }

  /// Mirrors the `markdown` arm of `NODE_PARSERS`.
  ///
  /// NOT ``cleanString``: its ellipsis would be appended INSIDE the document.
  /// Over the ceiling the node keeps every complete line it can (see
  /// ``PluginVocabMarkdownParser/clamp(_:maxChars:)``) and says so in a field.
  /// The view still formats that window as markdown.
  static func parseMarkdown(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let raw = object["text"] as? String else {
      return invalid("markdown", "`text` is required", path: path, context: &context)
    }
    let source = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !source.isEmpty else {
      return invalid("markdown", "`text` is required", path: path, context: &context)
    }
    let clamped = PluginVocabMarkdownParser.clamp(source)
    return .markdown(PluginVocabMarkdown(
      text: clamped.text,
      truncated: clamped.truncated
    ))
  }

  static func parseBadge(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let text = cleanString(object["text"], max: PluginVocabLimits.maxLabelChars) else {
      return invalid("badge", "`text` is required", path: path, context: &context)
    }
    return .badge(PluginVocabBadge(
      text: text,
      tone: PluginVocabTone.normalize(object["tone"]),
      icon: cleanString(object["icon"], max: PluginVocabLimits.maxIdChars)
    ))
  }

  static func parseButton(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let label = cleanString(object["label"], max: PluginVocabLimits.maxLabelChars) else {
      return invalid("button", "`label` is required", path: path, context: &context)
    }
    guard let action = parseAction(object["onPress"]) else {
      return invalid("button", "`onPress` needs an `action` id", path: path, context: &context)
    }
    var node = PluginVocabButton(label: label, onPress: action)
    if let raw = object["kind"] as? String, let kind = PluginVocabButton.Kind(rawValue: raw) {
      node.kind = kind
    }
    node.icon = cleanString(object["icon"], max: PluginVocabLimits.maxIdChars)
    node.disabled = boolValue(object["disabled"]) ?? false
    return .button(node)
  }

  static func parseList(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    let bind = parseBinding(object["bind"], path: "\(path).bind", context: &context)
    var items: [PluginVocabListItem]?
    if let raw = object["items"] as? [Any] {
      items = raw.prefix(PluginVocabLimits.maxListItems).compactMap(parseListItem)
    }
    guard items != nil || bind != nil else {
      return invalid("list", "needs `items` or a `bind`", path: path, context: &context)
    }
    return .list(PluginVocabList(
      items: items,
      bind: bind,
      emptyText: cleanString(object["emptyText"], max: PluginVocabLimits.maxValueChars),
      selectable: parseSelectable(object["selectable"])
    ))
  }

  /// A `list` node's `selectable`, or `nil`.
  ///
  /// A selection with no verb is a set of ticks the reader cannot spend, so a
  /// `selectable` declaring no usable action is dropped whole rather than
  /// drawing checkboxes over an empty bar. The bulk buttons go through the SAME
  /// reader a row's trailing buttons do — ``parseAction``, not
  /// ``boundRowAction`` — because they are the panel author's own words: a bulk
  /// verb is declared on the node, never supplied by a collection row, which is
  /// exactly what keeps stored data from minting an action over a hundred rows
  /// at once. Mirrors `parseSelectable` in `vocabularyNodes.ts`.
  static func parseSelectable(_ raw: Any?) -> PluginVocabSelectable? {
    guard let object = raw as? [String: Any],
          let stateKey = parseStateKey(object["stateKey"]) else {
      return nil
    }
    let actions = parseListItemActions(
      object["actions"],
      max: PluginVocabLimits.maxBulkActions,
      gate: { parseAction($0) }
    )
    guard !actions.isEmpty else { return nil }
    let declared = numberValue(object["max"]).flatMap(pluginVocabInt)
    let max = (declared ?? 0) >= 1
      ? Swift.min(declared ?? 0, PluginVocabLimits.maxSelectedRows)
      : PluginVocabLimits.maxSelectedRows
    return PluginVocabSelectable(stateKey: stateKey, actions: actions, max: max)
  }

  /// How a list row's actions are admitted.
  ///
  /// The one difference between a row a panel declared and a row a collection
  /// supplied. A declared row's actions are the panel author's own words, so
  /// they pass through ``parseAction``; a bound row's are stored data, so they
  /// pass through ``boundRowAction`` and survive only when the binding allowed
  /// the id. Everything else about reading a row is shared, so the two kinds of
  /// row cannot drift into different shapes. Mirrors `VocabActionGate` in
  /// `vocabularyNodes.ts`.
  typealias ActionGate = (Any?) -> PluginVocabAction?

  /// A row's status chip. Dropped whole when it has no text to show.
  static func parseListItemBadge(_ raw: Any?) -> PluginVocabBadge? {
    guard let object = raw as? [String: Any],
          let text = cleanString(object["text"], max: PluginVocabLimits.maxLabelChars) else {
      return nil
    }
    return PluginVocabBadge(
      text: text,
      tone: PluginVocabTone.normalize(object["tone"]),
      icon: cleanString(object["icon"], max: PluginVocabLimits.maxIdChars)
    )
  }

  /// One trailing or overflow button. Needs both an admitted action and a label.
  static func parseListItemAction(_ raw: Any?, gate: ActionGate) -> PluginVocabListItemAction? {
    guard let object = raw as? [String: Any],
          let action = gate(object),
          let label = cleanString(object["label"], max: PluginVocabLimits.maxLabelChars) else {
      return nil
    }
    let kind = cleanString(object["kind"], max: PluginVocabLimits.maxIdChars)
      .flatMap(PluginVocabButton.Kind.init(rawValue:)) ?? .default
    return PluginVocabListItemAction(
      action: action,
      label: label,
      kind: kind,
      icon: cleanString(object["icon"], max: PluginVocabLimits.maxIdChars)
    )
  }

  /// A row's `actions` or `overflow`, capped at `max`.
  ///
  /// The cap counts what SURVIVED rather than what was offered, so a refused
  /// entry does not spend a slot a later valid one needed. Every client counts
  /// the same way.
  static func parseListItemActions(_ raw: Any?, max: Int, gate: ActionGate) -> [PluginVocabListItemAction] {
    guard let entries = raw as? [Any] else { return [] }
    var parsed: [PluginVocabListItemAction] = []
    for entry in entries {
      guard let action = parseListItemAction(entry, gate: gate) else { continue }
      parsed.append(action)
      if parsed.count >= max { break }
    }
    return parsed
  }

  /// One list row, however it arrived. Shared by ``parseListItem`` and
  /// ``parseBoundListItem`` so a declared row and a bound row read every field
  /// the same way and differ only in `gate`.
  ///
  /// - Parameter fallbackKey: the collection row's own primary key, used as the
  ///   row's identity when the stored value declares no `key` of its own. The
  ///   same rule ``parseKeyValueRow`` and the store's binding resolution already
  ///   apply for the same reason: a collection row HAS a key, and making a
  ///   plugin repeat it inside the value just to make its rows selectable would
  ///   be a second identity that can disagree with the first.
  static func readListItem(_ raw: Any?, gate: ActionGate, fallbackKey: String? = nil) -> PluginVocabListItem? {
    guard let object = raw as? [String: Any],
          let title = cleanString(object["title"], max: PluginVocabLimits.maxLabelChars) else {
      return nil
    }
    let markdown = parseListItemMarkdown(object["markdown"])
    return PluginVocabListItem(
      title: title,
      // `boundedString`, never `cleanString`: an over-long key is REFUSED, not
      // ellipsized — see ``boundedString(_:max:)``.
      key: boundedString(object["key"], max: PluginVocabLimits.maxIdChars)
        ?? boundedString(fallbackKey, max: PluginVocabLimits.maxIdChars),
      subtitle: cleanString(object["subtitle"], max: PluginVocabLimits.maxValueChars),
      meta: cleanString(object["meta"], max: PluginVocabLimits.maxLabelChars),
      tone: PluginVocabTone.normalize(object["tone"]),
      icon: cleanString(object["icon"], max: PluginVocabLimits.maxIdChars),
      onPress: gate(object["onPress"]),
      badge: parseListItemBadge(object["badge"]),
      mono: cleanString(object["mono"], max: PluginVocabLimits.maxValueChars),
      actions: parseListItemActions(
        object["actions"],
        max: PluginVocabLimits.maxListItemActions,
        gate: gate
      ),
      overflow: parseListItemActions(
        object["overflow"],
        max: PluginVocabLimits.maxListItemOverflow,
        gate: gate
      ),
      preview: parseListItemPreview(object["preview"]),
      markdown: markdown?.text,
      markdownTruncated: markdown?.truncated ?? false,
      avatar: parseAvatarValue(object["avatar"])
    )
  }

  /// A row's formatted body. Dropped when empty. Clamped with the same complete-
  /// line cut a `markdown` node uses, at the tighter per-row ceiling.
  static func parseListItemMarkdown(_ raw: Any?) -> (text: String, truncated: Bool)? {
    guard let raw = raw as? String else { return nil }
    let source = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !source.isEmpty else { return nil }
    return PluginVocabMarkdownParser.clamp(source, maxChars: PluginVocabLimits.maxListItemMarkdownChars)
  }

  /// Hover-card payload. Dropped whole when it has neither a title nor text.
  static func parseListItemPreview(_ raw: Any?) -> PluginVocabListItemPreview? {
    guard let object = raw as? [String: Any] else { return nil }
    let title = cleanString(object["title"], max: PluginVocabLimits.maxLabelChars)
    let text = cleanString(object["text"], max: PluginVocabLimits.maxTextChars)
    guard title != nil || text != nil else { return nil }
    return PluginVocabListItemPreview(title: title, text: text)
  }

  static func parseListItem(_ raw: Any?) -> PluginVocabListItem? {
    readListItem(raw, gate: { parseAction($0) })
  }

  /// The action a bound row may carry, or `nil`.
  ///
  /// A collection row that could mint an action freely would let stored data
  /// introduce a button the panel never showed the reader, so a row's action
  /// survives only when the binding's `allowActions` names its id. A binding
  /// with no allowlist yields no action at all. Mirrors `boundRowAction` in
  /// `vocabularyNodes.ts`; the phone used to accept any action here while the
  /// other three clients accepted none.
  static func boundRowAction(_ raw: Any?, allowActions: [String]?) -> PluginVocabAction? {
    guard let allowActions, !allowActions.isEmpty else { return nil }
    guard let action = parseAction(raw) else { return nil }
    return allowActions.contains(action.action) ? action : nil
  }

  /// A bound collection row as a list item.
  ///
  /// Every action on the row — `onPress`, `actions` and `overflow` alike —
  /// passes through ``boundRowAction``, so a row can press exactly the ids the
  /// panel's binding allowed and nothing else.
  static func parseBoundListItem(
    _ raw: Any?,
    allowActions: [String]?,
    rowKey: String? = nil
  ) -> PluginVocabListItem? {
    readListItem(raw, gate: { boundRowAction($0, allowActions: allowActions) }, fallbackKey: rowKey)
  }

  static func parseTable(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let rawColumns = object["columns"] as? [Any], !rawColumns.isEmpty else {
      return invalid("table", "`columns` is required", path: path, context: &context)
    }
    var columns: [PluginVocabTableColumn] = []
    for entry in rawColumns.prefix(PluginVocabLimits.maxTableColumns) {
      guard let column = entry as? [String: Any],
            let key = cleanString(column["key"], max: PluginVocabLimits.maxIdChars),
            let label = cleanString(column["label"], max: PluginVocabLimits.maxLabelChars) else {
        continue
      }
      columns.append(PluginVocabTableColumn(
        key: key,
        label: label,
        alignsTrailing: (column["align"] as? String) == "right"
      ))
    }
    guard !columns.isEmpty else {
      return invalid("table", "no usable columns", path: path, context: &context)
    }
    let bind = parseBinding(object["bind"], path: "\(path).bind", context: &context)
    var rows: [[String: String]]?
    if let rawRows = object["rows"] as? [Any] {
      rows = rawRows
        .prefix(PluginVocabLimits.maxTableRows)
        .compactMap { $0 as? [String: Any] }
        .map { coerceTableRow($0, columns: columns) }
    }
    guard rows != nil || bind != nil else {
      return invalid("table", "needs `rows` or a `bind`", path: path, context: &context)
    }
    return .table(PluginVocabTable(
      columns: columns,
      rows: rows,
      bind: bind,
      emptyText: cleanString(object["emptyText"], max: PluginVocabLimits.maxValueChars)
    ))
  }

  /// Flatten a row to display strings against the declared columns. A missing
  /// cell becomes empty rather than shifting the row's other values left.
  static func coerceTableRow(_ row: [String: Any], columns: [PluginVocabTableColumn]) -> [String: String] {
    var out: [String: String] = [:]
    for column in columns {
      let value = row[column.key]
      if let text = value as? String {
        out[column.key] = String(text.prefix(PluginVocabLimits.maxValueChars))
      } else if let number = numberValue(value) {
        // Numbers are read before booleans, and through the CoreFoundation
        // type check rather than `as? Bool`: that cast bridges any `NSNumber`
        // holding 0 or 1, so a cell whose value is the number 1 used to render
        // as "Yes".
        out[column.key] = formatNumber(number)
      } else if let flag = boolValue(value) {
        out[column.key] = flag ? "Yes" : "No"
      } else {
        out[column.key] = ""
      }
    }
    return out
  }

  static func parseForm(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let rawFields = object["fields"] as? [Any], !rawFields.isEmpty else {
      return invalid("form", "`fields` is required", path: path, context: &context)
    }
    var fields: [PluginVocabField] = []
    var ids = Set<String>()
    for entry in rawFields.prefix(PluginVocabLimits.maxFormFields) {
      guard let field = parseField(entry), !ids.contains(field.id) else { continue }
      ids.insert(field.id)
      fields.append(field)
    }
    guard !fields.isEmpty else {
      return invalid("form", "no usable fields", path: path, context: &context)
    }
    let submit = object["submit"] as? [String: Any]
    let submitLabel = submit.flatMap { cleanString($0["label"], max: PluginVocabLimits.maxLabelChars) }
    let submitAction = submit.flatMap { parseAction($0["onPress"]) }
    let applyOnChange = parseAction(object["applyOnChange"])
    // A `submit` that was WRITTEN and is malformed stays an error even when
    // `applyOnChange` would carry the form: the author asked for a button, and
    // silently dropping it would ship a form missing the control they declared.
    if submit != nil, submitLabel == nil || submitAction == nil {
      return invalid("form", "`submit` needs a `label` and an `onPress` action", path: path, context: &context)
    }
    if submitAction == nil, applyOnChange == nil {
      return invalid("form", "needs a `submit`, or an `applyOnChange` action", path: path, context: &context)
    }
    return .form(PluginVocabForm(
      fields: fields,
      submitLabel: submitLabel,
      submit: submitAction,
      applyOnChange: applyOnChange
    ))
  }

  static func parseField(_ raw: Any?) -> PluginVocabField? {
    guard let object = raw as? [String: Any],
          let kindRaw = object["kind"] as? String,
          let kind = PluginVocabField.Kind(rawValue: kindRaw),
          let id = cleanString(object["id"], max: PluginVocabLimits.maxIdChars),
          let label = cleanString(object["label"], max: PluginVocabLimits.maxLabelChars) else {
      return nil
    }
    var field = PluginVocabField(id: id, kind: kind, label: label)
    field.help = cleanString(object["help"], max: PluginVocabLimits.maxValueChars)
    field.placeholder = cleanString(object["placeholder"], max: PluginVocabLimits.maxLabelChars)

    switch kind {
    case .select:
      guard let rawOptions = object["options"] as? [Any],
            !rawOptions.isEmpty,
            rawOptions.count <= PluginVocabLimits.maxSelectOptions else {
        return nil
      }
      var seen = Set<String>()
      for entry in rawOptions {
        guard let option = entry as? [String: Any],
              let value = cleanString(option["value"], max: PluginVocabLimits.maxValueChars),
              !seen.contains(value) else {
          return nil
        }
        seen.insert(value)
        field.options.append(PluginVocabSelectOption(
          value: value,
          label: cleanString(option["label"], max: PluginVocabLimits.maxLabelChars)
        ))
      }
      if let value = cleanString(object["value"], max: PluginVocabLimits.maxValueChars), seen.contains(value) {
        field.initialText = value
      }
    case .number:
      let min = numberValue(object["min"])
      let max = numberValue(object["max"])
      let step = numberValue(object["step"])
      if let min, let max, min >= max { return nil }
      if let step, step <= 0 { return nil }
      field.min = min
      field.max = max
      field.step = step
      field.initialNumber = numberValue(object["value"])
    case .toggle:
      field.initialFlag = boolValue(object["value"])
    case .text:
      field.initialText = cleanString(object["value"], max: PluginVocabLimits.maxValueChars)
    case .secret:
      // A secret value is never echoed back into a schema — the host redacts
      // it — so any supplied `value` is deliberately ignored.
      break
    }
    return field
  }

  static func parseChart(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let kindRaw = object["kind"] as? String, let kind = PluginVocabChart.Kind(rawValue: kindRaw) else {
      return invalid("chart", "`kind` must be `line` or `bar`", path: path, context: &context)
    }
    guard let rawSeries = object["series"] as? [Any] else {
      return invalid("chart", "`series` is required", path: path, context: &context)
    }
    var series: [PluginVocabChartSeries] = []
    for entry in rawSeries.prefix(PluginVocabLimits.maxChartSeries) {
      guard let object = entry as? [String: Any],
            let id = cleanString(object["id"], max: PluginVocabLimits.maxIdChars),
            let rawPoints = object["points"] as? [Any] else {
        continue
      }
      var points: [PluginVocabChartPoint] = []
      for rawPoint in rawPoints.prefix(PluginVocabLimits.maxChartPoints) {
        guard let point = rawPoint as? [String: Any], let y = numberValue(point["y"]) else { continue }
        let x: String?
        if let label = point["x"] as? String {
          x = String(label.prefix(PluginVocabLimits.maxLabelChars))
        } else if let number = numberValue(point["x"]) {
          x = formatNumber(number)
        } else {
          x = nil
        }
        guard let x else { continue }
        points.append(PluginVocabChartPoint(x: x, y: y))
      }
      series.append(PluginVocabChartSeries(
        id: id,
        label: cleanString(object["label"], max: PluginVocabLimits.maxLabelChars),
        tone: PluginVocabTone.normalize(object["tone"]),
        points: points
      ))
    }
    guard !series.isEmpty else {
      return invalid("chart", "no usable series", path: path, context: &context)
    }
    return .chart(PluginVocabChart(
      kind: kind,
      series: series,
      title: cleanString(object["title"], max: PluginVocabLimits.maxLabelChars),
      emptyText: cleanString(object["emptyText"], max: PluginVocabLimits.maxValueChars)
    ))
  }

  static func parseVideo(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let src = mediaSrc(object["src"]) else {
      return invalid("video", "`src` is required", path: path, context: &context)
    }
    return .video(PluginVocabVideo(
      src: src,
      poster: mediaSrc(object["poster"]),
      title: cleanString(object["title"], max: PluginVocabLimits.maxLabelChars)
    ))
  }

  static func parseImage(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let src = mediaSrc(object["src"]) else {
      return invalid("image", "`src` is required", path: path, context: &context)
    }
    guard let alt = cleanString(object["alt"], max: PluginVocabLimits.maxLabelChars) else {
      return invalid("image", "`alt` is required", path: path, context: &context)
    }
    let maxHeight = numberValue(object["maxHeight"])
    return .image(PluginVocabImage(
      src: src,
      alt: alt,
      maxHeight: (maxHeight ?? 0) > 0 ? maxHeight : nil
    ))
  }

  static func parseAvatar(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let name = cleanString(object["name"], max: PluginVocabLimits.maxLabelChars) else {
      return invalid("avatar", "`name` is required", path: path, context: &context)
    }
    let sizeRaw = (object["size"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let size = PluginVocabAvatar.Size(rawValue: sizeRaw ?? "")
    return .avatar(PluginVocabAvatar(
      name: name,
      src: mediaSrc(object["src"]),
      size: size
    ))
  }

  static func parseAvatarValue(_ raw: Any?) -> PluginVocabAvatar? {
    guard let object = raw as? [String: Any],
          let name = cleanString(object["name"], max: PluginVocabLimits.maxLabelChars) else {
      return nil
    }
    return PluginVocabAvatar(name: name, src: mediaSrc(object["src"]), size: nil)
  }

  static func parseKeyValue(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    let bind = parseBinding(object["bind"], path: "\(path).bind", context: &context)
    var rows: [PluginVocabKeyValueRow]?
    if let rawRows = object["rows"] as? [Any] {
      rows = rawRows.prefix(PluginVocabLimits.maxKeyValueRows).compactMap(parseKeyValueRow)
    }
    guard rows != nil || bind != nil else {
      return invalid("keyValue", "needs `rows` or a `bind`", path: path, context: &context)
    }
    return .keyValue(PluginVocabKeyValue(
      rows: rows,
      bind: bind,
      emptyText: cleanString(object["emptyText"], max: PluginVocabLimits.maxValueChars)
    ))
  }

  static func parseKeyValueRow(_ raw: Any?) -> PluginVocabKeyValueRow? {
    guard let object = raw as? [String: Any],
          let key = cleanString(object["key"], max: PluginVocabLimits.maxLabelChars) else {
      return nil
    }
    return PluginVocabKeyValueRow(
      key: key,
      value: cleanString(object["value"], max: PluginVocabLimits.maxValueChars) ?? "",
      tone: PluginVocabTone.normalize(object["tone"])
    )
  }

  static func parseEmptyState(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let title = cleanString(object["title"], max: PluginVocabLimits.maxLabelChars) else {
      return invalid("emptyState", "`title` is required", path: path, context: &context)
    }
    var node = PluginVocabEmptyState(title: title)
    node.description = cleanString(object["description"], max: PluginVocabLimits.maxTextChars)
    node.icon = cleanString(object["icon"], max: PluginVocabLimits.maxIdChars)
    if let action = object["action"] as? [String: Any],
       let label = cleanString(action["label"], max: PluginVocabLimits.maxLabelChars),
       let press = parseAction(action["onPress"]) {
      node.actionLabel = label
      node.action = press
    }
    return .emptyState(node)
  }
}
