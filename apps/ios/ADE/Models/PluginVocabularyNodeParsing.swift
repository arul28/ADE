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
    stack.wrap = object["wrap"] as? Bool ?? false
    for (index, child) in (object["children"] as? [Any] ?? []).enumerated() {
      guard let node = parseNode(child, path: "\(path).children[\(index)]", depth: depth + 1, context: &context) else {
        break
      }
      stack.children.append(node)
    }
    return .stack(stack)
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
    node.disabled = object["disabled"] as? Bool ?? false
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
      emptyText: cleanString(object["emptyText"], max: PluginVocabLimits.maxValueChars)
    ))
  }

  static func parseListItem(_ raw: Any?) -> PluginVocabListItem? {
    guard let object = raw as? [String: Any],
          let title = cleanString(object["title"], max: PluginVocabLimits.maxLabelChars) else {
      return nil
    }
    return PluginVocabListItem(
      title: title,
      subtitle: cleanString(object["subtitle"], max: PluginVocabLimits.maxValueChars),
      meta: cleanString(object["meta"], max: PluginVocabLimits.maxLabelChars),
      tone: PluginVocabTone.normalize(object["tone"]),
      icon: cleanString(object["icon"], max: PluginVocabLimits.maxIdChars),
      onPress: parseAction(object["onPress"])
    )
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
      } else if let flag = value as? Bool {
        out[column.key] = flag ? "Yes" : "No"
      } else if let number = numberValue(value) {
        out[column.key] = formatNumber(number)
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
    guard let submit = object["submit"] as? [String: Any],
          let label = cleanString(submit["label"], max: PluginVocabLimits.maxLabelChars),
          let action = parseAction(submit["onPress"]) else {
      return invalid("form", "`submit` needs a `label` and an `onPress` action", path: path, context: &context)
    }
    return .form(PluginVocabForm(fields: fields, submitLabel: label, submit: action))
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
      field.initialFlag = object["value"] as? Bool
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
    guard let src = cleanString(object["src"], max: PluginVocabLimits.maxValueChars) else {
      return invalid("video", "`src` is required", path: path, context: &context)
    }
    return .video(PluginVocabVideo(
      src: src,
      poster: cleanString(object["poster"], max: PluginVocabLimits.maxValueChars),
      title: cleanString(object["title"], max: PluginVocabLimits.maxLabelChars)
    ))
  }

  static func parseImage(
    _ object: [String: Any],
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    guard let src = cleanString(object["src"], max: PluginVocabLimits.maxValueChars) else {
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
