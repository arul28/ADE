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
