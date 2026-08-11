import XCTest
@testable import ADE

/// Forward-compatibility tests for the plugin vocabulary decoder.
///
/// The thing under test is not "does valid JSON parse" — it is the degradation
/// ladder. A plugin panel is written by a machine that may be running a newer
/// ADE than the phone, so every one of these asserts what happens when the
/// schema says something this build does not understand. Modelled on
/// `ActivityContractDecodingTests`.
final class PluginVocabularyDecodingTests: XCTestCase {
  private func parse(_ json: String) -> PluginPanelParseResult {
    PluginPanelParser.parse(json)
  }

  private func panel(_ result: PluginPanelParseResult) throws -> PluginPanelSchema {
    guard case let .ok(schema, _) = result else {
      throw XCTSkip("Expected a parsed panel, got \(result)")
    }
    return schema
  }

  // MARK: - Unknown components

  func testUnknownComponentBecomesAMarkerAndKeepsTheRestOfThePanel() throws {
    let result = parse(#"""
    {
      "v": 1,
      "title": "Coverage",
      "fallback": { "title": "Coverage", "text": "82% of lines covered." },
      "body": [
        { "component": "text", "text": "Before" },
        { "component": "sunburst", "series": [1, 2, 3] },
        { "component": "text", "text": "After" }
      ]
    }
    """#)

    let schema = try panel(result)
    XCTAssertEqual(schema.body.count, 3, "An unknown component must not drop its siblings.")
    XCTAssertEqual(schema.body[1], .unknown(name: "sunburst"))
    guard case let .ok(_, warnings) = result else { return XCTFail("expected ok") }
    XCTAssertEqual(warnings.map(\.code), [.unknownComponent])
    XCTAssertEqual(warnings.first?.path, "body[1]")
  }

  func testUnknownComponentIsNotRenderableButKnownOnesAre() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [
        { "component": "text", "text": "hello" },
        { "component": "chart", "kind": "line", "series": [{ "id": "a", "points": [{ "x": 1, "y": 2 }] }] },
        { "component": "constellation" }
      ]
    }
    """#))

    XCTAssertTrue(PluginRenderSupport.isRenderable(schema.body[0]))
    // `chart` parses — the contract defines it — but this build does not draw
    // it, which is the parse-vs-render split the skew design depends on.
    XCTAssertEqual(schema.body[1].componentName, "chart")
    XCTAssertFalse(PluginRenderSupport.isRenderable(schema.body[1]))
    XCTAssertFalse(PluginRenderSupport.isRenderable(schema.body[2]))
  }

  func testUnknownTopLevelAndNodeFieldsAreIgnored() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t", "futureField": 9 },
      "experimentalLayout": { "columns": 3 },
      "body": [
        { "component": "badge", "text": "Ready", "tone": "success", "haloIntensity": 0.4 }
      ]
    }
    """#))

    XCTAssertEqual(schema.body, [.badge(PluginVocabBadge(text: "Ready", tone: .success))])
  }

  // MARK: - Version skew

  func testNewerVocabularyVersionFailsThePanelAndKeepsTheAuthorsFallback() {
    let result = parse(#"""
    {
      "v": 2,
      "fallback": { "title": "Graph", "text": "14 nodes, 3 cycles.", "deeplink": "ade://lane/abc" },
      "body": [{ "component": "hypergraph" }]
    }
    """#)

    guard case let .failed(failure, fallback) = result else {
      return XCTFail("A newer vocabulary version must fail the panel, not render half of it.")
    }
    XCTAssertEqual(failure, .versionUnsupported(declared: 2))
    XCTAssertEqual(fallback?.title, "Graph")
    XCTAssertEqual(fallback?.text, "14 nodes, 3 cycles.")
    XCTAssertEqual(fallback?.deeplink, "ade://lane/abc")
  }

  func testMissingVersionIsTreatedAsUnsupportedRatherThanAssumedCurrent() {
    let result = parse(#"""
    { "fallback": { "title": "T", "text": "t" }, "body": [] }
    """#)
    guard case let .failed(failure, _) = result else { return XCTFail("expected failure") }
    XCTAssertEqual(failure, .versionUnsupported(declared: -1))
  }

  func testPanelRecordVersionColumnDecidesSkewWithoutParsing() {
    let current = PluginPanelRecord(
      pluginId: "graph", panelId: "main", title: "", icon: "", surface: "",
      schemaJSON: "{}", vocabVersion: PluginVocabulary.version, updatedAt: ""
    )
    let newer = PluginPanelRecord(
      pluginId: "graph", panelId: "main", title: "", icon: "", surface: "",
      schemaJSON: "{}", vocabVersion: PluginVocabulary.version + 1, updatedAt: ""
    )
    XCTAssertTrue(current.isRenderableVersion)
    XCTAssertFalse(newer.isRenderableVersion)
    // Title falls back to the panel id so an entry is never blank.
    XCTAssertEqual(current.displayTitle, "main")
  }

  // MARK: - Panel-fatal damage

  func testMissingFallbackFailsThePanel() {
    let result = parse(#"{ "v": 1, "body": [{ "component": "text", "text": "hi" }] }"#)
    guard case let .failed(failure, fallback) = result else { return XCTFail("expected failure") }
    XCTAssertEqual(failure, .fallbackMissing)
    XCTAssertNil(fallback)
  }

  func testMalformedJSONFailsThePanelRatherThanThrowing() {
    guard case let .failed(failure, _) = parse("{ not json") else { return XCTFail("expected failure") }
    XCTAssertEqual(failure, .notJSON)
  }

  func testEmptySchemaFailsThePanel() {
    guard case let .failed(failure, _) = parse("") else { return XCTFail("expected failure") }
    XCTAssertEqual(failure, .notJSON)
  }

  func testNodeCeilingFailsThePanelInsteadOfRenderingATruncatedOne() {
    let nodes = (0..<(PluginVocabLimits.maxNodes + 5))
      .map { #"{ "component": "text", "text": "row \#($0)" }"# }
      .joined(separator: ",")
    let result = parse(#"""
    { "v": 1, "fallback": { "title": "T", "text": "t" }, "body": [\#(nodes)] }
    """#)
    guard case let .failed(failure, fallback) = result else { return XCTFail("expected failure") }
    XCTAssertEqual(failure, .tooManyNodes)
    XCTAssertEqual(fallback?.title, "T")
  }

  // MARK: - Node-local damage

  func testMalformedKnownComponentBecomesAnInvalidNodeAndSparesItsSiblings() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [
        { "component": "button", "label": "Run" },
        { "component": "text", "text": "still here" }
      ]
    }
    """#))

    XCTAssertEqual(schema.body.count, 2)
    guard case let .invalid(name, _) = schema.body[0] else {
      return XCTFail("A button with no action must degrade, not render as a dead control.")
    }
    XCTAssertEqual(name, "button")
    XCTAssertEqual(schema.body[1], .text(PluginVocabText(text: "still here")))
  }

  func testRedTonesFoldToWarningSoAPayloadCannotPaintAnAlarm() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{ "component": "badge", "text": "Broken", "tone": "danger" }]
    }
    """#))
    XCTAssertEqual(schema.body, [.badge(PluginVocabBadge(text: "Broken", tone: .warning))])
  }

  func testActionArgsKeepScalarsAndDropNestedValues() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "button",
        "label": "Run",
        "onPress": {
          "action": "graph.rebuild",
          "confirm": "Rebuild the graph?",
          "args": { "depth": 3, "force": true, "label": "full", "nested": { "no": 1 }, "list": [1] }
        }
      }]
    }
    """#))

    guard case let .button(button) = schema.body[0] else { return XCTFail("expected a button") }
    XCTAssertEqual(button.onPress.action, "graph.rebuild")
    XCTAssertEqual(button.onPress.confirm, "Rebuild the graph?")
    XCTAssertEqual(button.onPress.args["depth"], .number(3))
    XCTAssertEqual(button.onPress.args["force"], .flag(true))
    XCTAssertEqual(button.onPress.args["label"], .text("full"))
    XCTAssertNil(button.onPress.args["nested"], "Nesting is the seam where data would become code.")
    XCTAssertNil(button.onPress.args["list"])
  }

  func testZeroAndOneStayNumbersRatherThanBecomingBooleans() throws {
    // Regression. `NSNumber` bridges to `Bool` for any 0 or 1, so reading args
    // with `as? Bool` first turned `{"depth": 1}` into `true` — and a plugin
    // branching on the argument's type would take the wrong branch. The same
    // bridge, read the other way round, silently dropped every literal 0 and 1
    // in the schema, including `"v": 1` itself.
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "button", "label": "Run",
        "onPress": { "action": "a", "args": { "depth": 1, "offset": 0, "force": true } }
      }]
    }
    """#))
    guard case let .button(button) = schema.body[0] else { return XCTFail("expected a button") }
    XCTAssertEqual(button.onPress.args["depth"], .number(1))
    XCTAssertEqual(button.onPress.args["offset"], .number(0))
    XCTAssertEqual(button.onPress.args["force"], .flag(true))
  }

  func testBooleansAreNotReadAsNumbers() throws {
    // `JSONSerialization` bridges Bool to NSNumber, so a naive `as? Double`
    // reads `true` as a y-value of 1 and silently invents a data point.
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "chart", "kind": "bar",
        "series": [{ "id": "a", "points": [{ "x": "mon", "y": true }, { "x": "tue", "y": 4 }] }]
      }]
    }
    """#))
    guard case let .chart(chart) = schema.body[0] else { return XCTFail("expected a chart") }
    XCTAssertEqual(chart.series[0].points, [PluginVocabChartPoint(x: "tue", y: 4)])
  }

  // MARK: - Nesting

  func testStackChildrenParseAndDepthIsBounded() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "stack", "direction": "horizontal", "gap": "sm",
        "children": [
          { "component": "badge", "text": "A" },
          { "component": "badge", "text": "B" }
        ]
      }]
    }
    """#))
    guard case let .stack(stack) = schema.body[0] else { return XCTFail("expected a stack") }
    XCTAssertEqual(stack.direction, .horizontal)
    XCTAssertEqual(stack.gap, .sm)
    XCTAssertEqual(stack.children.count, 2)
  }

  // MARK: - Numbers too large for `Int`

  func testAstronomicalVersionIsRejectedRatherThanTrapping() {
    // Regression. `Int(_:)` traps on anything outside `Int`'s range, and `v` is
    // read before any validation, on the main thread, from a schema another
    // machine wrote — so `1e300` here used to crash the app at the first read
    // of the very field that exists to reject it.
    for declared in ["1e300", "9.3e18", "-9.3e18"] {
      let result = parse(#"""
      { "v": \#(declared), "fallback": { "title": "T", "text": "t" }, "body": [] }
      """#)
      guard case let .failed(failure, fallback) = result else {
        return XCTFail("\(declared) must fail the panel")
      }
      XCTAssertEqual(failure, .versionUnsupported(declared: -1), "\(declared) reads as no version at all")
      XCTAssertEqual(fallback?.title, "T", "The author's own sentence still survives.")
    }
  }

  func testAstronomicalBindingLimitReadsAsNoLimit() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{ "component": "list", "bind": { "collection": "rows", "limit": 1e300 } }]
    }
    """#))
    guard case let .list(list) = schema.body[0] else { return XCTFail("expected a list") }
    XCTAssertNil(list.bind?.limit)
    XCTAssertEqual(list.bind?.collection, "rows")
  }

  func testAstronomicalActionArgStaysADoubleWhenSentBack() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "button", "label": "Run",
        "onPress": { "action": "a", "args": { "big": 1e300, "small": 3 } }
      }]
    }
    """#))
    guard case let .button(button) = schema.body[0] else { return XCTFail("expected a button") }
    // Whole numbers go out as integers; one too large to be an `Int` goes out
    // as the double it already was, rather than trapping on the way.
    XCTAssertEqual(button.onPress.argsJSON["small"] as? Int, 3)
    XCTAssertEqual(button.onPress.argsJSON["big"] as? Double, 1e300)
  }

  // MARK: - Booleans that are not booleans

  func testNumericCellsRenderAsNumbersRatherThanYesNo() throws {
    // `as? Bool` bridges any `NSNumber` holding 0 or 1, so a table cell whose
    // value was the number 1 drew as "Yes".
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "table",
        "columns": [
          { "key": "count", "label": "Count" },
          { "key": "zero", "label": "Zero" },
          { "key": "flag", "label": "Flag" }
        ],
        "rows": [{ "count": 1, "zero": 0, "flag": true }]
      }]
    }
    """#))
    guard case let .table(table) = schema.body[0], let row = table.rows?.first else {
      return XCTFail("expected a table row")
    }
    XCTAssertEqual(row["count"], "1")
    XCTAssertEqual(row["zero"], "0")
    XCTAssertEqual(row["flag"], "Yes", "A real boolean still reads as Yes/No.")
  }

  func testNumericOneDoesNotSetBooleanNodeFields() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [
        { "component": "stack", "wrap": 1, "children": [] },
        { "component": "stack", "wrap": true, "children": [] },
        { "component": "button", "label": "A", "disabled": 1, "onPress": { "action": "a" } },
        { "component": "button", "label": "B", "disabled": true, "onPress": { "action": "a" } }
      ]
    }
    """#))
    guard case let .stack(numeric) = schema.body[0], case let .stack(real) = schema.body[1] else {
      return XCTFail("expected two stacks")
    }
    XCTAssertFalse(numeric.wrap, "The number 1 is not the boolean true.")
    XCTAssertTrue(real.wrap)
    guard case let .button(numericButton) = schema.body[2], case let .button(realButton) = schema.body[3] else {
      return XCTFail("expected two buttons")
    }
    XCTAssertFalse(numericButton.disabled)
    XCTAssertTrue(realButton.disabled)
  }

  func testNumericOneDoesNotPreArmAToggleField() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "form",
        "fields": [
          { "kind": "toggle", "id": "numeric", "label": "Numeric", "value": 1 },
          { "kind": "toggle", "id": "real", "label": "Real", "value": true }
        ],
        "submit": { "label": "Save", "onPress": { "action": "save" } }
      }]
    }
    """#))
    guard case let .form(form) = schema.body[0] else { return XCTFail("expected a form") }
    XCTAssertNil(form.fields[0].initialFlag)
    XCTAssertEqual(form.fields[1].initialFlag, true)
  }

  // MARK: - Fallback deeplinks

  func testOnlyAdeAndHttpsDeeplinksResolve() {
    XCTAssertNotNil(PluginDeeplinkURL.resolve("ade://lane/abc"))
    XCTAssertNotNil(PluginDeeplinkURL.resolve("https://example.com/report"))
    // A plugin's fallback card is the one link it can put under the user's
    // thumb; every other scheme is a way to make the phone act for it.
    XCTAssertNil(PluginDeeplinkURL.resolve("javascript:alert(1)"))
    XCTAssertNil(PluginDeeplinkURL.resolve("file:///etc/passwd"))
    XCTAssertNil(PluginDeeplinkURL.resolve("someapp://pay"))
    XCTAssertNil(PluginDeeplinkURL.resolve("/lane/abc"))
    XCTAssertNil(PluginDeeplinkURL.resolve(nil))
  }

  func testOverDeepNestingFailsThePanel() {
    var json = #"{ "component": "text", "text": "bottom" }"#
    for _ in 0...(PluginVocabLimits.maxDepth + 1) {
      json = #"{ "component": "stack", "children": [\#(json)] }"#
    }
    let result = parse(#"{ "v": 1, "fallback": { "title": "T", "text": "t" }, "body": [\#(json)] }"#)
    guard case let .failed(failure, _) = result else { return XCTFail("expected failure") }
    XCTAssertEqual(failure, .tooDeep)
  }
}
