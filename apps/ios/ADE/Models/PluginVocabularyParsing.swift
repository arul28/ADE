import Foundation

/// The tolerant half of the vocabulary contract: turning `schema_json` from a
/// `plugin_panels` row into a ``PluginPanelSchema``.
///
/// Mirrors `parsePluginPanel` in `apps/desktop/src/shared/plugins/vocabulary.ts`,
/// including which damage is panel-fatal and which is node-local. The split is
/// the whole point of the degradation ladder: a bad `v`, a missing `fallback` or
/// an oversized schema kills the panel and shows the fallback card, while a
/// malformed node or an unrecognized component name only replaces that node.
enum PluginPanelParser {
  /// Parse a panel schema as stored in `plugin_panels.schema_json`.
  static func parse(_ json: String?) -> PluginPanelParseResult {
    guard let json, !json.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let data = json.data(using: .utf8) else {
      return .failed(.notJSON, fallback: nil)
    }
    if data.count > PluginVocabLimits.maxSchemaBytes {
      // Measured on the stored bytes rather than re-serialized: the budget in
      // `dbMaintenanceApi.ts` is enforced against exactly these bytes.
      return .failed(.schemaTooLarge, fallback: readFallback(data))
    }
    guard let root = try? JSONSerialization.jsonObject(with: data) else {
      return .failed(.notJSON, fallback: nil)
    }
    guard let object = root as? [String: Any] else {
      return .failed(.notObject, fallback: nil)
    }
    return parse(object: object)
  }

  static func parse(object: [String: Any]) -> PluginPanelParseResult {
    let fallback = readFallback(object)
    let declaredVersion = intValue(object["v"]) ?? -1
    guard declaredVersion == PluginVocabulary.version else {
      return .failed(.versionUnsupported(declared: declaredVersion), fallback: fallback)
    }
    guard let fallback else {
      return .failed(.fallbackMissing, fallback: nil)
    }
    guard let rawBody = object["body"] as? [Any] else {
      return .failed(.bodyMissing, fallback: fallback)
    }

    var context = ParseContext()
    var body: [PluginVocabNode] = []
    for (index, raw) in rawBody.enumerated() {
      guard let node = parseNode(raw, path: "body[\(index)]", depth: 1, context: &context) else { break }
      body.append(node)
    }
    if context.overflowed {
      return .failed(
        context.nodeCount >= PluginVocabLimits.maxNodes ? .tooManyNodes : .tooDeep,
        fallback: fallback
      )
    }

    let schema = PluginPanelSchema(
      title: cleanString(object["title"], max: PluginVocabLimits.maxLabelChars),
      fallback: fallback,
      body: body
    )
    return .ok(schema, warnings: context.warnings)
  }

  /// Dig the fallback out of an arbitrary value without validating anything
  /// else. Used on the failure path, where the panel is unrenderable but its
  /// own sentence usually survives.
  static func readFallback(_ raw: Any?) -> PluginPanelFallback? {
    var source = raw
    if let data = raw as? Data {
      source = try? JSONSerialization.jsonObject(with: data)
    } else if let text = raw as? String, let data = text.data(using: .utf8) {
      source = try? JSONSerialization.jsonObject(with: data)
    }
    guard let object = source as? [String: Any],
          let fallback = object["fallback"] as? [String: Any],
          let title = cleanString(fallback["title"], max: PluginVocabLimits.maxLabelChars),
          let text = cleanString(fallback["text"], max: PluginVocabLimits.maxTextChars) else {
      return nil
    }
    return PluginPanelFallback(
      title: title,
      text: text,
      deeplink: cleanString(fallback["deeplink"], max: PluginVocabLimits.maxValueChars)
    )
  }

  // MARK: - Node parsing

  /// Internal rather than private: the per-component parse arms live in
  /// `PluginVocabularyNodeParsing.swift` and thread this through.
  struct ParseContext {
    var warnings: [PluginVocabWarning] = []
    /// Counted across the whole tree so a wide panel is capped like a deep one.
    var nodeCount = 0
    var overflowed = false
  }

  static func parseNode(
    _ raw: Any?,
    path: String,
    depth: Int,
    context: inout ParseContext
  ) -> PluginVocabNode? {
    if context.nodeCount >= PluginVocabLimits.maxNodes || depth > PluginVocabLimits.maxDepth {
      context.overflowed = true
      return nil
    }
    guard let object = raw as? [String: Any] else {
      context.nodeCount += 1
      return invalid("node", "not an object", path: path, context: &context)
    }
    let name = (object["component"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !name.isEmpty else {
      context.nodeCount += 1
      return invalid("node", "missing `component`", path: path, context: &context)
    }
    context.nodeCount += 1

    switch name {
    case "stack": return parseStack(object, path: path, depth: depth, context: &context)
    case "text": return parseText(object, path: path, context: &context)
    case "badge": return parseBadge(object, path: path, context: &context)
    case "button": return parseButton(object, path: path, context: &context)
    case "list": return parseList(object, path: path, context: &context)
    case "table": return parseTable(object, path: path, context: &context)
    case "form": return parseForm(object, path: path, context: &context)
    case "chart": return parseChart(object, path: path, context: &context)
    case "video": return parseVideo(object, path: path, context: &context)
    case "image": return parseImage(object, path: path, context: &context)
    case "divider":
      return .divider(label: cleanString(object["label"], max: PluginVocabLimits.maxLabelChars))
    case "keyValue": return parseKeyValue(object, path: path, context: &context)
    case "emptyState": return parseEmptyState(object, path: path, context: &context)
    default:
      // The forward-compat path, and a warning rather than an error: a name
      // added to the vocabulary after this build shipped lands here.
      context.warnings.append(PluginVocabWarning(
        code: .unknownComponent,
        path: path,
        message: "`\(name)` is not part of vocabulary v\(PluginVocabulary.version)."
      ))
      return .unknown(name: name)
    }
  }

  // MARK: - Shared pieces

  static func parseAction(_ raw: Any?) -> PluginVocabAction? {
    guard let object = raw as? [String: Any],
          let action = cleanString(object["action"], max: PluginVocabLimits.maxIdChars) else {
      return nil
    }
    var args: [String: PluginVocabScalar] = [:]
    if let rawArgs = object["args"] as? [String: Any] {
      // Sorted so the truncation point is stable across runs rather than
      // following dictionary order.
      for key in rawArgs.keys.sorted().prefix(PluginVocabLimits.maxActionArgs) {
        let value = rawArgs[key]
        if let text = value as? String {
          args[key] = .text(String(text.prefix(PluginVocabLimits.maxValueChars)))
        } else if let flag = boolValue(value) {
          args[key] = .flag(flag)
        } else if let number = numberValue(value) {
          args[key] = .number(number)
        }
      }
    }
    return PluginVocabAction(
      action: action,
      args: args,
      confirm: cleanString(object["confirm"], max: PluginVocabLimits.maxTextChars)
    )
  }

  static func parseBinding(
    _ raw: Any?,
    path: String,
    context: inout ParseContext
  ) -> PluginVocabBinding? {
    guard raw != nil else { return nil }
    guard let object = raw as? [String: Any],
          let collection = cleanString(object["collection"], max: PluginVocabLimits.maxIdChars) else {
      context.warnings.append(PluginVocabWarning(
        code: .invalidBinding,
        path: path,
        message: "A binding needs a `collection` name."
      ))
      return nil
    }
    let limit = intValue(object["limit"])
    return PluginVocabBinding(
      collection: collection,
      keyPrefix: cleanString(object["keyPrefix"], max: PluginVocabLimits.maxIdChars),
      limit: (limit ?? 0) > 0 ? limit : nil,
      allowActions: parseAllowActions(object["allowActions"])
    )
  }

  /// The action ids a binding's rows may name.
  ///
  /// Deduplicated so a repeated id does not spend the ceiling twice, and `nil`
  /// when empty, because an empty allowlist and an absent one mean the same
  /// thing: no bound row acts.
  static func parseAllowActions(_ raw: Any?) -> [String]? {
    guard let entries = raw as? [Any] else { return nil }
    var seen: [String] = []
    for entry in entries {
      guard let id = cleanString(entry, max: PluginVocabLimits.maxIdChars) else { continue }
      if seen.contains(id) { continue }
      seen.append(id)
      if seen.count >= PluginVocabLimits.maxBindingAllowActions { break }
    }
    return seen.isEmpty ? nil : seen
  }

  static func invalid(
    _ name: String,
    _ reason: String,
    path: String,
    context: inout ParseContext
  ) -> PluginVocabNode {
    context.warnings.append(PluginVocabWarning(code: .invalidNode, path: path, message: "\(name): \(reason)"))
    return .invalid(name: name, reason: reason)
  }

  static func cleanString(_ raw: Any?, max: Int) -> String? {
    guard let text = raw as? String else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    return trimmed.count > max ? "\(trimmed.prefix(max))…" : trimmed
  }

  /// `JSONSerialization` gives back `NSNumber` for both numbers and booleans,
  /// so a plain `as? Double` reads `true` as `1` and invents a data point.
  ///
  /// The obvious guard — `!(raw is Bool)` — is worse than useless: Swift's
  /// dynamic cast bridges ANY `NSNumber` holding 0 or 1 to `Bool`, so it
  /// rejects the literal numbers `0` and `1` along with the booleans. Comparing
  /// the CoreFoundation type id is the only test that separates the two, because
  /// JSON booleans arrive as `CFBoolean` while JSON numbers never do.
  /// A JSON boolean, and only a boolean. `as? Bool` alone bridges any
  /// `NSNumber` holding 0 or 1, which would forward the number `1` to a plugin
  /// as `true` — a different type than the schema author wrote.
  static func boolValue(_ raw: Any?) -> Bool? {
    guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }

  static func numberValue(_ raw: Any?) -> Double? {
    guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    return value.isFinite ? value : nil
  }

  /// A JSON number narrowed to `Int`, dropping anything `Int` cannot hold. See
  /// ``pluginVocabInt`` for why the range check is not optional.
  static func intValue(_ raw: Any?) -> Int? {
    numberValue(raw).flatMap(pluginVocabInt)
  }

  /// A JSON number narrowed to a sort key. See ``pluginVocabSaturatingInt`` for
  /// why a position saturates where a quantity drops out.
  static func orderValue(_ raw: Any?) -> Int? {
    numberValue(raw).flatMap(pluginVocabSaturatingInt)
  }

  static func formatNumber(_ value: Double) -> String {
    value == value.rounded() && abs(value) < 1e15
      ? String(Int(value))
      : String(format: "%g", value)
  }
}
