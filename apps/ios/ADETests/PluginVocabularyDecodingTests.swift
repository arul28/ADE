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
    // Nothing said means the panel shows here, which is what every row written
    // before the flag existed says.
    XCTAssertTrue(current.mobile)
  }

  func testMobileFlagDefaultsToShownAndOnlyABooleanTakesItAway() {
    XCTAssertFalse(PluginPanelRecord.mobileFlag(inSchemaJSON: #"{ "v": 1, "mobile": false }"#))
    XCTAssertTrue(PluginPanelRecord.mobileFlag(inSchemaJSON: #"{ "v": 1, "mobile": true }"#))
    XCTAssertTrue(PluginPanelRecord.mobileFlag(inSchemaJSON: #"{ "v": 1 }"#))
    // A host writing something other than a boolean, or a panel too damaged to
    // parse, must not silently remove itself from the phone.
    XCTAssertTrue(PluginPanelRecord.mobileFlag(inSchemaJSON: #"{ "mobile": "false" }"#))
    XCTAssertTrue(PluginPanelRecord.mobileFlag(inSchemaJSON: #"{ "mobile": 0 }"#))
    XCTAssertTrue(PluginPanelRecord.mobileFlag(inSchemaJSON: #"{ "mobile": fal"#))
    XCTAssertTrue(PluginPanelRecord.mobileFlag(inSchemaJSON: ""))
    // Nested is not the root: only the key the host stamps at the top decides.
    XCTAssertTrue(PluginPanelRecord.mobileFlag(
      inSchemaJSON: #"{ "v": 1, "body": [{ "component": "text", "text": "mobile", "mobile": false }] }"#
    ))
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

  // MARK: - Bound rows may act

  func testBindingAllowlistIsDeduplicatedAndCapped() throws {
    let extra = (0..<40).map { "\"a\($0)\"" }.joined(separator: ", ")
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "list",
        "bind": {
          "collection": "fleet",
          "allowActions": ["open", "open", "  stop  ", 7, "", \#(extra)]
        }
      }]
    }
    """#))
    guard case let .list(list) = schema.body[0] else { return XCTFail("expected a list") }
    XCTAssertEqual(Array(list.bind?.allowActions?.prefix(3) ?? []), ["open", "stop", "a0"])
    XCTAssertEqual(list.bind?.allowActions?.count, PluginVocabLimits.maxBindingAllowActions)
  }

  func testAnEmptyOrAbsentAllowlistIsNotStored() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [
        { "component": "list", "bind": { "collection": "a", "allowActions": [] } },
        { "component": "list", "bind": { "collection": "b" } },
        { "component": "list", "bind": { "collection": "c", "allowActions": "open" } }
      ]
    }
    """#))
    for node in schema.body {
      guard case let .list(list) = node else { return XCTFail("expected a list") }
      XCTAssertNil(list.bind?.allowActions)
    }
  }

  /// The phone used to accept any action a collection row named while desktop,
  /// web and the TUI accepted none. Both halves of the allowlist are asserted
  /// here so the divergence cannot come back from either side.
  func testABoundRowActsOnlyForAnActionItsBindingAllowed() {
    let allowed = PluginPanelParser.parseBoundListItem(
      ["title": "bc-1", "onPress": ["action": "open-agent", "confirm": "Open it?"]],
      allowActions: ["open-agent", "stop-agent"]
    )
    XCTAssertEqual(allowed?.onPress?.action, "open-agent")
    XCTAssertEqual(allowed?.onPress?.confirm, "Open it?", "A confirmation still gates the press.")

    let refused = PluginPanelParser.parseBoundListItem(
      ["title": "bc-1", "onPress": ["action": "delete-everything"]],
      allowActions: ["open-agent"]
    )
    XCTAssertNotNil(refused, "A refused action must not drop the row.")
    XCTAssertNil(refused?.onPress)

    let noAllowlist = PluginPanelParser.parseBoundListItem(
      ["title": "bc-1", "onPress": ["action": "open-agent"]],
      allowActions: nil
    )
    XCTAssertNil(noAllowlist?.onPress, "No allowlist keeps the old answer: a bound row names nothing.")

    // A row without a title is not a row, allowlist or not.
    XCTAssertNil(PluginPanelParser.parseBoundListItem(["subtitle": "no title"], allowActions: ["open-agent"]))
  }

  // MARK: - Rich list rows

  func testARowCarriesABadgeAMonoLineActionsAndOverflow() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "list",
        "items": [{
          "title": "bc-1",
          "subtitle": "Fix the login redirect",
          "mono": "origin/fix-login-redirect",
          "badge": { "text": "Running", "tone": "accent", "icon": "play" },
          "actions": [
            { "action": "open", "label": "Open", "kind": "primary", "icon": "arrow.right" },
            { "action": "stop", "label": "Stop", "confirm": "Stop this agent?" }
          ],
          "overflow": [{ "action": "archive", "label": "Archive" }]
        }]
      }]
    }
    """#))
    guard case let .list(list) = schema.body[0], let item = list.items?.first else {
      return XCTFail("expected a list item")
    }
    XCTAssertEqual(item.mono, "origin/fix-login-redirect")
    XCTAssertEqual(item.badge?.text, "Running")
    XCTAssertEqual(item.badge?.tone, .accent)
    XCTAssertEqual(item.actions.map(\.label), ["Open", "Stop"])
    XCTAssertEqual(item.actions.first?.kind, .primary)
    XCTAssertEqual(item.actions.last?.action.confirm, "Stop this agent?")
    XCTAssertEqual(item.overflow.map(\.action.action), ["archive"])
  }

  func testARowActionNeedsBothAnIdAndALabel() {
    let item = PluginPanelParser.parseListItem([
      "title": "bc-1",
      "badge": ["tone": "accent"],
      "actions": [
        ["label": "No action id"],
        ["action": "no-label"],
        "not an object",
        ["action": "ok", "label": "Fine"]
      ]
    ])
    // A refused entry does not spend a slot the valid one needed, and a badge
    // with no text is dropped whole rather than drawn empty.
    XCTAssertNil(item?.badge)
    XCTAssertEqual(item?.actions.map(\.label), ["Fine"])
  }

  func testARowsActionsAndOverflowAreCappedByWhatSurvived() {
    let many = { (count: Int, prefix: String) -> [[String: Any]] in
      (0..<count).map { ["action": "\(prefix)\($0)", "label": "\(prefix)\($0)"] }
    }
    var actions: [Any] = [["action": "x"], "nope"]
    actions.append(contentsOf: many(6, "a"))
    let item = PluginPanelParser.parseListItem([
      "title": "bc-1",
      "actions": actions,
      "overflow": many(12, "o")
    ])
    XCTAssertEqual(item?.actions.map(\.action.action), ["a0", "a1", "a2"])
    XCTAssertEqual(item?.actions.count, PluginVocabLimits.maxListItemActions)
    XCTAssertEqual(item?.overflow.count, PluginVocabLimits.maxListItemOverflow)
  }

  func testEveryActionOnABoundRowGoesThroughTheAllowlist() {
    // Not just `onPress`: a collection that could reach an undeclared action
    // through a trailing button would have made `onPress` the only guarded door.
    let row: [String: Any] = [
      "title": "bc-1",
      "mono": "origin/fix-login",
      "onPress": ["action": "open"],
      "actions": [
        ["action": "open", "label": "Open"],
        ["action": "delete-everything", "label": "Delete"]
      ],
      "overflow": [
        ["action": "delete-everything", "label": "Delete"],
        ["action": "stop", "label": "Stop"]
      ]
    ]

    let gated = PluginPanelParser.parseBoundListItem(row, allowActions: ["open", "stop"])
    XCTAssertEqual(gated?.onPress?.action, "open")
    XCTAssertEqual(gated?.actions.map(\.action.action), ["open"])
    XCTAssertEqual(gated?.overflow.map(\.action.action), ["stop"])
    XCTAssertEqual(gated?.mono, "origin/fix-login")

    // No allowlist keeps the old answer for the whole row, not only its press.
    let bare = PluginPanelParser.parseBoundListItem(row, allowActions: nil)
    XCTAssertNil(bare?.onPress)
    XCTAssertTrue(bare?.actions.isEmpty == true)
    XCTAssertTrue(bare?.overflow.isEmpty == true)
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

  // MARK: - Media and fallback deeplinks

  func testMediaLoadsOnlyFromSchemesAPanelIsAllowedToPointAt() {
    // The same pair the desktop renderer allows (`vocabularyComponents.tsx`):
    // the network case and the self-contained one, and nothing that would turn
    // a `src` from another machine into a disk read, a cleartext fetch or an
    // app launch.
    XCTAssertNotNil(PluginMediaURL.resolve("https://cdn.example.com/a.png"))
    XCTAssertNotNil(PluginMediaURL.resolve("data:image/png;base64,AAAA"))
    XCTAssertNotNil(PluginMediaURL.resolve("HTTPS://cdn.example.com/a.png"), "Scheme match is case-insensitive.")

    for refused in ["file:///etc/passwd", "http://cdn.example.com/a.png", "HTTP://x/a.png",
                    "javascript:alert(1)", "someapp://open", "/relative.png"] {
      XCTAssertNil(PluginMediaURL.resolve(refused), "\(refused) must not load")
    }
  }

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

  // MARK: - Socket payloads

  private func contribution(
    socket: String,
    payloadJSON: String,
    entityKind: String = "surface",
    entityId: String = "lanes"
  ) -> PluginContribution? {
    PluginContributionParser.parse(
      entityKind: entityKind,
      entityId: entityId,
      pluginId: "coverage",
      socket: socket,
      payloadJSON: payloadJSON,
      updatedAt: "2026-08-13T00:00:00Z"
    )
  }

  /// The forward-compatibility rule that matters most for sockets: the host is
  /// free to add payload fields, and a row carrying one this build has never
  /// heard of must still draw. The alternative is a contribution that vanishes
  /// from the phone the day the desktop grows a field.
  func testUnknownPayloadKeysDoNotCostTheContribution() throws {
    let toolbar = try XCTUnwrap(contribution(
      socket: "toolbar-action",
      payloadJSON: #"""
      {
        "label": "Scan",
        "actionId": "coverage.scan",
        "variant": "ghost",
        "shortcut": { "key": "s", "modifiers": ["cmd"] },
        "analytics": [1, 2, 3]
      }
      """#
    ))
    XCTAssertEqual(toolbar.toolbarAction?.label, "Scan")
    XCTAssertEqual(toolbar.toolbarAction?.actionId, "coverage.scan")
    XCTAssertFalse(toolbar.toolbarAction?.disabled ?? true)

    let chip = try XCTUnwrap(contribution(
      socket: "filter-chip",
      payloadJSON: #"{ "label": "Risky", "filterKey": "risky", "tone": "warning", "pinned": true }"#
    ))
    XCTAssertEqual(chip.filterChip?.filterKey, "risky")
  }

  /// Every kind the wire defines decodes here now. A kind that did NOT would
  /// drop its row silently, which is the failure this exists to catch when the
  /// taxonomy grows a ninth entry.
  func testEveryWireSocketKindDecodes() {
    let payloads: [(String, String)] = [
      ("toolbar-action", #"{ "label": "Scan", "actionId": "a" }"#),
      ("row-badge", #"{ "text": "82%" }"#),
      ("row-menu-item", #"{ "label": "Rebuild", "actionId": "a" }"#),
      ("detail-section", #"{ "panelId": "summary" }"#),
      ("empty-state", #"{ "title": "Nothing yet" }"#),
      ("filter-chip", #"{ "label": "Risky", "filterKey": "risky" }"#),
      ("file-viewer", #"{ "panelId": "parquet", "extensions": [".parquet"] }"#),
      ("composer-action", #"{ "label": "Expand", "actionId": "a" }"#),
    ]
    for (socket, payloadJSON) in payloads {
      XCTAssertNotNil(
        contribution(socket: socket, payloadJSON: payloadJSON),
        "\(socket) must decode — a kind that does not is a contribution that vanishes."
      )
    }
    XCTAssertNil(
      contribution(socket: "timeline-card", payloadJSON: #"{ "label": "x" }"#),
      "A kind this build has never heard of drops its row rather than half-drawing it."
    )
  }

  func testSocketPayloadsMissingTheirRequiredFieldAreDropped() {
    XCTAssertNil(contribution(socket: "toolbar-action", payloadJSON: #"{ "label": "Scan" }"#))
    XCTAssertNil(contribution(socket: "composer-action", payloadJSON: #"{ "actionId": "a" }"#))
    XCTAssertNil(contribution(socket: "detail-section", payloadJSON: #"{ "title": "Coverage" }"#))
    XCTAssertNil(contribution(socket: "empty-state", payloadJSON: #"{ "body": "no title" }"#))
    XCTAssertNil(contribution(socket: "filter-chip", payloadJSON: #"{ "label": "Risky" }"#))
    XCTAssertNil(contribution(socket: "file-viewer", payloadJSON: #"{ "panelId": "p" }"#))
    // Extensions that are not extensions leave the registration with nothing to
    // match on, which is the same as having none.
    XCTAssertNil(contribution(
      socket: "file-viewer",
      payloadJSON: #"{ "panelId": "p", "extensions": ["parquet", "", 7] }"#
    ))
  }

  func testFileViewerExtensionsAreLowercasedTheWayTheHostNormalizesThem() throws {
    let viewer = try XCTUnwrap(contribution(
      socket: "file-viewer",
      payloadJSON: #"{ "panelId": "parquet", "extensions": [".PARQUET", ".Avro"] }"#
    ))
    XCTAssertEqual(viewer.fileViewer?.extensions, [".parquet", ".avro"])
  }

  /// `Int(Double)` traps rather than saturating, and this number was written by
  /// another machine — a chip count of `1e300` must read as absent, not crash.
  func testFilterChipCountOutsideIntRangeReadsAsAbsent() throws {
    let huge = try XCTUnwrap(contribution(
      socket: "filter-chip",
      payloadJSON: #"{ "label": "Risky", "filterKey": "risky", "count": 1e300 }"#
    ))
    XCTAssertNil(huge.filterChip?.count)

    let negative = try XCTUnwrap(contribution(
      socket: "filter-chip",
      payloadJSON: #"{ "label": "Risky", "filterKey": "risky", "count": -4 }"#
    ))
    XCTAssertNil(negative.filterChip?.count, "A negative count is not a count.")

    let real = try XCTUnwrap(contribution(
      socket: "filter-chip",
      payloadJSON: #"{ "label": "Risky", "filterKey": "risky", "count": 12 }"#
    ))
    XCTAssertEqual(real.filterChip?.count, 12)
  }

  /// A `disabled` of `1` is the number one, not the boolean true — the same
  /// `CFBoolean` distinction the vocabulary decoder makes. Getting this wrong
  /// would render a live button dead.
  func testNumericOneDoesNotDisableAnActionButton() throws {
    let numeric = try XCTUnwrap(contribution(
      socket: "toolbar-action",
      payloadJSON: #"{ "label": "Scan", "actionId": "a", "disabled": 1 }"#
    ))
    XCTAssertFalse(numeric.toolbarAction?.disabled ?? true)

    let real = try XCTUnwrap(contribution(
      socket: "toolbar-action",
      payloadJSON: #"{ "label": "Scan", "actionId": "a", "disabled": true }"#
    ))
    XCTAssertTrue(real.toolbarAction?.disabled ?? false)
  }

  /// An empty-state action label with no action is a button that cannot fire.
  func testEmptyStateActionLabelWithoutAnActionIsDropped() throws {
    let labelOnly = try XCTUnwrap(contribution(
      socket: "empty-state",
      payloadJSON: #"{ "title": "Nothing yet", "actionLabel": "Do it" }"#
    ))
    XCTAssertNil(labelOnly.emptyState?.actionId)
    XCTAssertNil(labelOnly.emptyState?.actionLabel)
  }

  // MARK: - Surface placement and filtering

  func testSurfaceScopedContributionsAreAddressedByTheirSurfaceId() throws {
    let index = PluginContributionIndex(contributions: [
      try XCTUnwrap(contribution(
        socket: "toolbar-action",
        payloadJSON: #"{ "label": "Scan", "actionId": "a" }"#,
        entityId: "lanes"
      )),
      try XCTUnwrap(contribution(
        socket: "toolbar-action",
        payloadJSON: #"{ "label": "Audit", "actionId": "b" }"#,
        entityId: "prs"
      )),
    ])
    XCTAssertEqual(index.toolbarActions(.lanes).count, 1)
    XCTAssertEqual(index.toolbarActions(.lanes).first?.toolbarAction?.label, "Scan")
    XCTAssertEqual(index.toolbarActions(.prs).first?.toolbarAction?.label, "Audit")
    XCTAssertTrue(index.toolbarActions(.files).isEmpty)
  }

  /// A chip filters because the entities it selects carry its key — on rows of
  /// ANY kind, since a chip is published against the surface and the rows it
  /// filters are published against entities.
  func testFilterKeysAreReadOffEveryRowNotJustChips() throws {
    let index = PluginContributionIndex(contributions: [
      try XCTUnwrap(contribution(
        socket: "row-badge",
        payloadJSON: #"{ "text": "risk", "filterKey": "risky" }"#,
        entityKind: "lane",
        entityId: "lane-1"
      )),
      try XCTUnwrap(contribution(
        socket: "row-badge",
        payloadJSON: #"{ "text": "ok" }"#,
        entityKind: "lane",
        entityId: "lane-2"
      )),
    ])
    XCTAssertTrue(index.matchesFilterKeys(.lane, "lane-1", selected: ["risky"]))
    XCTAssertFalse(index.matchesFilterKeys(.lane, "lane-2", selected: ["risky"]))
    // No selection never filters: a chip nobody pressed must not hide rows.
    XCTAssertTrue(index.matchesFilterKeys(.lane, "lane-2", selected: []))
    XCTAssertTrue(index.matchesFilterKeys(.lane, "unknown-lane", selected: []))
  }

  /// Contribution rows replicate across the whole account and outlive an
  /// uninstall elsewhere. Once presence has answered they are scoped to it;
  /// before it answers they all show, because blanking every badge for the
  /// length of a round trip would make a cold launch look like an uninstall.
  func testContributionsAreScopedToInstalledPluginsOncePresenceHasAnswered() throws {
    let row = try XCTUnwrap(contribution(
      socket: "row-badge",
      payloadJSON: #"{ "text": "82%" }"#,
      entityKind: "pr",
      entityId: "42"
    ))
    XCTAssertFalse(PluginContributionIndex(contributions: [row]).badges(.pr, "42").isEmpty)
    XCTAssertFalse(
      PluginContributionIndex(contributions: [row], installedPluginIds: ["coverage"]).badges(.pr, "42").isEmpty
    )
    XCTAssertTrue(
      PluginContributionIndex(contributions: [row], installedPluginIds: ["something-else"]).badges(.pr, "42").isEmpty,
      "A badge from a plugin this machine does not have is a ghost."
    )
  }

  func testFileViewerMatchesByExtensionAndPrefersARowPublishedForTheFileItself() throws {
    let surfaceIndex = PluginContributionIndex(contributions: [
      try XCTUnwrap(contribution(
        socket: "file-viewer",
        payloadJSON: #"{ "panelId": "parquet", "extensions": [".parquet"] }"#,
        entityId: "files"
      )),
    ])
    XCTAssertEqual(
      surfaceIndex.fileViewer(relativePath: "data/Part.PARQUET", fullPath: "/r/data/Part.PARQUET")?
        .fileViewer?.panelId,
      "parquet"
    )
    XCTAssertNil(surfaceIndex.fileViewer(relativePath: "src/main.ts", fullPath: "/r/src/main.ts"))

    let fileIndex = PluginContributionIndex(contributions: [
      try XCTUnwrap(contribution(
        socket: "file-viewer",
        payloadJSON: #"{ "panelId": "one-off", "extensions": [".ts"] }"#,
        entityKind: "file",
        entityId: "src/main.ts"
      )),
    ])
    XCTAssertEqual(
      fileIndex.fileViewer(relativePath: "src/main.ts", fullPath: "/r/src/main.ts")?.fileViewer?.panelId,
      "one-off"
    )
  }

  func testFileExtensionMatchesTheHostsOwnDerivation() {
    XCTAssertEqual(pluginFileExtension("a/b/Report.PARQUET"), ".parquet")
    XCTAssertEqual(pluginFileExtension("archive.tar.gz"), ".gz")
    // A dotfile has no extension, and neither does a trailing dot.
    XCTAssertNil(pluginFileExtension(".gitignore"))
    XCTAssertNil(pluginFileExtension("src/.env"))
    XCTAssertNil(pluginFileExtension("weird."))
    XCTAssertNil(pluginFileExtension("Makefile"))
  }

  // MARK: - Composer response verb

  private func invokeResult(_ json: String) throws -> PluginInvokeResult {
    try JSONDecoder().decode(PluginInvokeResult.self, from: XCTUnwrap(json.data(using: .utf8)))
  }

  /// The verb lives one level down, inside `result` — `plugins.invoke` answers
  /// `{ok, message?, result}` where `result` is the plugin handler's own return.
  /// Reading it beside `ok` would find an envelope field no plugin writes.
  func testComposerEditIsReadFromTheHandlerResultNotTheEnvelope() throws {
    let inserted = try invokeResult(#"{ "ok": true, "result": { "composer": { "insertText": "Hello" } } }"#)
    XCTAssertEqual(inserted.composer, .insert("Hello"))

    let envelopeLevel = try invokeResult(#"{ "ok": true, "composer": { "insertText": "Hello" } }"#)
    XCTAssertNil(envelopeLevel.composer)
  }

  func testReplaceWinsOverInsertAndEmptyReplaceClearsTheDraft() throws {
    let both = try invokeResult(
      #"{ "result": { "composer": { "insertText": "a", "replaceText": "b" } } }"#
    )
    XCTAssertEqual(both.composer, .replace("b"))

    let cleared = try invokeResult(#"{ "result": { "composer": { "replaceText": "" } } }"#)
    XCTAssertEqual(cleared.composer, .replace(""), "An empty replace is how a plugin clears the draft.")

    let emptyInsert = try invokeResult(#"{ "result": { "composer": { "insertText": "" } } }"#)
    XCTAssertNil(emptyInsert.composer, "An empty insert is a no-op, not an edit.")
  }

  func testOversizeComposerTextIsDroppedRatherThanTruncated() throws {
    let huge = String(repeating: "x", count: PluginInvokeComposerEdit.maxBytes + 1)
    let result = try invokeResult(#"{ "result": { "composer": { "replaceText": "\#(huge)" } } }"#)
    XCTAssertNil(
      result.composer,
      "A prompt cut off mid-sentence and then sent is worse than one that never arrived."
    )
  }

  /// The outcome and the sentence are what the user is owed either way, so a
  /// malformed or absent composer verb must not cost them the result.
  func testAMalformedComposerVerbLeavesTheRestOfTheResultIntact() throws {
    let result = try invokeResult(
      #"{ "ok": false, "error": "Nope", "result": { "composer": { "insertText": 7 } } }"#
    )
    XCTAssertFalse(result.ok)
    XCTAssertEqual(result.message, "Nope")
    XCTAssertNil(result.composer)
  }

  // MARK: - chat-card and activity-entry payloads

  func testChatCardAndActivityEntryDecodeAndTolerateUnknownKeys() throws {
    let card = try XCTUnwrap(contribution(
      socket: "chat-card",
      payloadJSON: #"{ "panelId": "coverage", "title": "Coverage", "icon": "chart.bar", "layout": "wide", "v": 3 }"#,
      entityKind: "session",
      entityId: "session-1"
    ))
    XCTAssertEqual(card.chatCard?.panelId, "coverage")
    XCTAssertEqual(card.chatCard?.title, "Coverage")

    let entry = try XCTUnwrap(contribution(
      socket: "activity-entry",
      payloadJSON: #"{ "title": "Budget exceeded", "body": "3 runs over cap", "tone": "warning", "actionId": "cost.open", "actionLabel": "Review", "priority": 9 }"#,
      entityId: "app"
    ))
    XCTAssertEqual(entry.activityEntry?.title, "Budget exceeded")
    XCTAssertEqual(entry.activityEntry?.tone, .warning)
    XCTAssertEqual(entry.activityEntry?.actionLabel, "Review")
  }

  func testChatCardWithoutAPanelIdIsDropped() {
    XCTAssertNil(contribution(
      socket: "chat-card",
      payloadJSON: #"{ "title": "Coverage" }"#,
      entityKind: "session",
      entityId: "session-1"
    ), "A card declaration naming no panel permits nothing.")
  }

  /// `PluginBadgeTone` has no red, deliberately, so a plugin cannot make its
  /// row the loudest thing in a list it does not own.
  func testActivityEntryToneFoldsRedOntoWarning() throws {
    for spelling in ["error", "danger", "failed", "red"] {
      let entry = try XCTUnwrap(contribution(
        socket: "activity-entry",
        payloadJSON: #"{ "title": "T", "tone": "\#(spelling)" }"#,
        entityId: "app"
      ))
      XCTAssertEqual(entry.activityEntry?.tone, .warning, "\(spelling) must fold to warning")
    }
  }

  func testActivityEntryNeedsATitleAndDropsALabelWithNoAction() throws {
    XCTAssertNil(contribution(
      socket: "activity-entry",
      payloadJSON: #"{ "body": "no title" }"#,
      entityId: "app"
    ))

    let labelOnly = try XCTUnwrap(contribution(
      socket: "activity-entry",
      payloadJSON: #"{ "title": "T", "actionLabel": "Do it" }"#,
      entityId: "app"
    ))
    XCTAssertNil(labelOnly.activityEntry?.actionId)
    XCTAssertNil(labelOnly.activityEntry?.actionLabel)
  }

  /// `socketId` is what the PLUGIN calls the contribution, and it is what an
  /// activity row's action carries as `entryId` — the only thing the handler
  /// cannot work out for itself when several rows share one action.
  func testSocketIdPrefersThePayloadsOwnIdAndFallsBackToTheSocketKind() throws {
    let named = try XCTUnwrap(contribution(
      socket: "activity-entry",
      payloadJSON: #"{ "id": "budget-lane-7", "title": "T" }"#,
      entityId: "app"
    ))
    XCTAssertEqual(named.socketId, "budget-lane-7")

    let anonymous = try XCTUnwrap(contribution(
      socket: "activity-entry",
      payloadJSON: #"{ "title": "T" }"#,
      entityId: "app"
    ))
    XCTAssertEqual(anonymous.socketId, "activity-entry")
  }

  func testActivityEntriesAreAddressedAtTheAppSurface() throws {
    let index = PluginContributionIndex(contributions: [
      try XCTUnwrap(contribution(
        socket: "activity-entry",
        payloadJSON: #"{ "title": "Budget exceeded" }"#,
        entityId: "app"
      )),
      try XCTUnwrap(contribution(
        socket: "empty-state",
        payloadJSON: #"{ "title": "Nothing here" }"#,
        entityId: "lanes"
      )),
    ])
    XCTAssertEqual(index.activityEntries().count, 1)
    XCTAssertEqual(index.activityEntries().first?.activityEntry?.title, "Budget exceeded")
  }

  // MARK: - chat-card permission

  /// The card carries the placement and the contribution carries the
  /// permission. Neither alone draws a panel.
  func testAChatCardPanelDrawsOnlyForTheDeclaringPluginPanelAndSession() throws {
    let index = PluginContributionIndex(contributions: [
      try XCTUnwrap(contribution(
        socket: "chat-card",
        payloadJSON: #"{ "panelId": "coverage" }"#,
        entityKind: "session",
        entityId: "session-1"
      )),
    ])
    XCTAssertTrue(index.declaresChatCard(pluginId: "coverage", panelId: "coverage", sessionId: "session-1"))
    XCTAssertFalse(
      index.declaresChatCard(pluginId: "coverage", panelId: "secrets", sessionId: "session-1"),
      "A declaration permits the panel it named and no other."
    )
    XCTAssertFalse(
      index.declaresChatCard(pluginId: "other-plugin", panelId: "coverage", sessionId: "session-1"),
      "A panel belongs to the plugin that declared it."
    )
    XCTAssertFalse(
      index.declaresChatCard(pluginId: "coverage", panelId: "coverage", sessionId: "session-2"),
      "A per-session declaration does not carry to another conversation."
    )
  }

  // MARK: - ade_card attribution and panel

  private func adeCard(_ json: String) throws -> WorkAdeCardModel {
    let payload = try JSONDecoder().decode(
      AgentChatAdeCardPayload.self,
      from: XCTUnwrap(json.data(using: .utf8))
    )
    return makeWorkAdeCardModel(from: payload)
  }

  func testAdeCardCarriesItsPluginAuthorAndPanel() throws {
    let card = try adeCard(#"""
    {
      "cardId": "c1", "variant": "pr_ci", "title": "Coverage",
      "fallbackText": "82% covered",
      "authoredBy": { "pluginId": "coverage", "displayName": "Coverage" },
      "panel": { "panelId": "summary", "context": { "prNumber": 42 } }
    }
    """#)
    XCTAssertEqual(card.author?.pluginId, "coverage")
    XCTAssertEqual(card.author?.label, "Coverage")
    XCTAssertEqual(card.panel?.panelId, "summary")
    XCTAssertEqual(card.panel?.context["prNumber"], .number(42))
  }

  /// An attribution with a blank id is a label claiming provenance it cannot
  /// support, and a panel with a blank id sends the reader nowhere. Both drop,
  /// and the card renders as an ordinary card — which is all a card ADE emitted
  /// for itself ever was.
  func testBlankAuthorOrPanelIdsDropWithoutCostingTheCard() throws {
    let card = try adeCard(#"""
    {
      "cardId": "c1", "variant": "pr_ci", "title": "Checks", "fallbackText": "Checks passed",
      "authoredBy": { "pluginId": "   " },
      "panel": { "panelId": "" }
    }
    """#)
    XCTAssertNil(card.author)
    XCTAssertNil(card.panel)
    XCTAssertEqual(card.title, "Checks")
    XCTAssertEqual(card.fallbackText, "Checks passed")
  }

  func testACardWithNoPluginFieldsIsUnchanged() throws {
    let card = try adeCard(#"{ "cardId": "c1", "variant": "pr_ci", "title": "Checks", "fallbackText": "Checks passed" }"#)
    XCTAssertNil(card.author)
    XCTAssertNil(card.panel)
  }

  /// A terse progress ping must not strip a card of whose it is or of the panel
  /// already on screen — the same later-wins-if-present rule the rest of the
  /// merge follows.
  func testAProgressEmitDoesNotStripAuthorOrPanel() throws {
    let first = try adeCard(#"""
    {
      "cardId": "c1", "variant": "pr_ci", "title": "Coverage", "fallbackText": "running",
      "authoredBy": { "pluginId": "coverage" },
      "panel": { "panelId": "summary" }
    }
    """#)
    let update = try adeCard(#"""
    { "cardId": "c1", "variant": "pr_ci", "state": "terminal", "title": "Coverage", "fallbackText": "done" }
    """#)
    let merged = first.merging(update)
    XCTAssertEqual(merged.author?.pluginId, "coverage")
    XCTAssertEqual(merged.panel?.panelId, "summary")
    XCTAssertTrue(merged.isTerminal)
  }

  /// The byline is what keeps a plugin's row out of ADE's own voice, so it must
  /// never come out blank: a card whose author carries no display name is
  /// attributed by its id instead.
  func testTheBylineFallsBackToThePluginIdWhenThereIsNoDisplayName() throws {
    let noName = try adeCard(#"""
    {
      "cardId": "c1", "variant": "pr_ci", "title": "Lint", "fallbackText": "clean",
      "authoredBy": { "pluginId": "ade-lint" }
    }
    """#)
    XCTAssertEqual(noName.author?.label, "ade-lint")

    let blankName = try adeCard(#"""
    {
      "cardId": "c1", "variant": "pr_ci", "title": "Lint", "fallbackText": "clean",
      "authoredBy": { "pluginId": "ade-lint", "displayName": "   " }
    }
    """#)
    XCTAssertEqual(blankName.author?.label, "ade-lint", "Whitespace is not a name.")
  }

  /// The replay path is the one that silently loses fields: a transcript
  /// rebuilt from storage on every cold launch would otherwise drop the byline
  /// and leave the plugin's card reading as ADE's own.
  func testTheReplayPathCarriesTheBylineAndPanelToo() {
    let card = workAdeCardModel(
      from: [
        "cardId": "c1",
        "variant": "pr_ci",
        "title": "Coverage",
        "fallbackText": "82% covered",
        "authoredBy": ["pluginId": "coverage", "displayName": "Coverage"],
        "panel": ["panelId": "summary", "context": ["prNumber": 42]],
      ],
      sessionId: "session-1",
      timestamp: "2026-08-13T00:00:00Z",
      sequence: 1,
      turnId: nil
    )
    XCTAssertEqual(card.author?.label, "Coverage")
    XCTAssertEqual(card.panel?.panelId, "summary")
    XCTAssertEqual(card.panel?.context["prNumber"], .number(42))
  }

  func testTheReplayPathLeavesAnOrdinaryCardUnattributed() {
    let card = workAdeCardModel(
      from: ["cardId": "c1", "variant": "pr_ci", "title": "Checks", "fallbackText": "passed"],
      sessionId: "session-1",
      timestamp: "2026-08-13T00:00:00Z",
      sequence: 1,
      turnId: nil
    )
    XCTAssertNil(card.author, "A card ADE emitted for itself carries no byline.")
    XCTAssertNil(card.panel)
  }

  // MARK: - Manifest socket declarations

  private func installRecord(
    pluginId: String = "coverage",
    enabled: Bool = true,
    sockets: [PluginManifestSocketWire],
    disabled: [String] = []
  ) -> PluginInstallRecordEntry {
    PluginInstallRecordEntry(
      pluginId: pluginId,
      enabled: enabled,
      sockets: sockets,
      disabledContributions: disabled
    )
  }

  /// The whole point of the field: a contribution a plugin only DECLARED used
  /// to be invisible on the phone and visible on desktop.
  func testASurfaceScopedDeclarationRendersWithoutAnyPublishedRow() {
    let index = PluginContributionIndex(
      contributions: [],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(
            socket: "toolbar-action", surface: "lanes", id: "scan",
            label: "Scan", actionId: "coverage.scan"
          ),
        ]),
      ])
    )
    let actions = index.toolbarActions(.lanes)
    XCTAssertEqual(actions.count, 1)
    XCTAssertEqual(actions.first?.toolbarAction?.label, "Scan")
    XCTAssertTrue(actions.first?.isDeclaration == true)
    XCTAssertTrue(index.toolbarActions(.prs).isEmpty, "A declaration renders on the surface it named.")
  }

  /// A manifest badge says "I badge lanes", not "I badge lane 7", so it applies
  /// to every lane until a published row fills it in.
  func testAPerEntityDeclarationAppliesToEveryEntityOfItsSurfacesKind() {
    let index = PluginContributionIndex(
      contributions: [],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Risk"),
        ]),
      ])
    )
    for laneId in ["lane-1", "lane-2", "lane-3"] {
      let badges = index.badges(.lane, laneId)
      XCTAssertEqual(badges.visible.count, 1, "every lane carries the declaration")
      XCTAssertEqual(badges.visible.first?.badge?.text, "Risk")
      // A manifest badge has no value of its own yet, so it is neutral.
      XCTAssertEqual(badges.visible.first?.badge?.tone, .neutral)
    }
    XCTAssertTrue(index.badges(.pr, "42").isEmpty, "Lanes declarations do not reach PR rows.")
  }

  /// Published wins: rendering both would show a placeholder next to the real
  /// thing and burn one of the two visible badge slots doing it.
  func testAPublishedRowReplacesTheDeclarationItFillsForThatEntityOnly() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "id": "risk", "text": "82%", "tone": "success" }"#,
      updatedAt: "2026-08-13T00:00:00Z"
    ))
    let index = PluginContributionIndex(
      contributions: [published],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Risk"),
        ]),
      ])
    )
    let filled = index.badges(.lane, "lane-1")
    XCTAssertEqual(filled.visible.count, 1, "The row replaces the declaration rather than joining it.")
    XCTAssertEqual(filled.visible.first?.badge?.text, "82%")
    XCTAssertFalse(filled.visible.first?.isDeclaration == true)

    let untouched = index.badges(.lane, "lane-2")
    XCTAssertEqual(untouched.visible.first?.badge?.text, "Risk", "Another lane still shows the declaration.")
  }

  /// Matching on the plugin alone would delete the declarations a plugin had
  /// not filled in yet.
  func testAPublishedRowDoesNotReplaceTheSamePluginsOtherDeclarations() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "id": "risk", "text": "82%" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(
      contributions: [published],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Risk"),
          PluginManifestSocketWire(socket: "row-menu-item", surface: "lanes", id: "rebuild",
                                   label: "Rebuild", actionId: "coverage.rebuild"),
        ]),
      ])
    )
    XCTAssertEqual(index.badges(.lane, "lane-1").visible.first?.badge?.text, "82%")
    XCTAssertEqual(
      index.menuItems(.lane, "lane-1").first?.menuItem?.label,
      "Rebuild",
      "A row filling one declaration must not delete another."
    )
  }

  /// An id-less row against TWO declarations of its kind has no non-arbitrary
  /// answer, so it is left unmatched and drops — the same answer the host gives,
  /// and the case `sdk.contributions.publish`'s doc tells authors to
  /// disambiguate with `payload.id`. Guessing is what produced the bug the host
  /// fixed against this client.
  func testAnIdLessRowAgainstTwoDeclarationsOfItsKindIsAmbiguousAndDrops() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "text": "82%" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(
      contributions: [published],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Risk"),
          PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "age", label: "Age"),
        ]),
      ])
    )
    let badges = index.badges(.lane, "lane-1")
    XCTAssertEqual(badges.visible.count, 2, "Both declarations stand; the unresolvable row does not.")
    XCTAssertEqual(Set(badges.visible.compactMap { $0.badge?.text }), ["Risk", "Age"])
  }

  /// Ambiguity is per SURFACE, as the host computes it.
  ///
  /// `listContributions` builds its join inside a per-surface loop, so a plugin
  /// with one `row-badge` on Lanes and one on PRs has declared each exactly
  /// once. Keyed without the surface term the phone read that as "declared
  /// twice", and every id-less badge — which is every badge an older host or an
  /// `id`-less payload can produce — dropped on the phone while drawing on
  /// desktop.
  func testOneDeclarationPerSurfaceIsNotAmbiguousAcrossSurfaces() throws {
    let laneRow = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "text": "82%" }"#, updatedAt: ""
    ))
    let prRow = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "pr", entityId: "916", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "text": "91%" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(
      contributions: [laneRow, prRow],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Risk"),
          PluginManifestSocketWire(socket: "row-badge", surface: "prs", id: "coverage", label: "Coverage"),
        ]),
      ])
    )

    XCTAssertEqual(index.badges(.lane, "lane-1").visible.first?.badge?.text, "82%")
    XCTAssertEqual(index.badges(.pr, "916").visible.first?.badge?.text, "91%")
  }

  /// Two declarations on ONE surface are still ambiguous — the surface term
  /// narrows the join, it does not remove it.
  func testTwoDeclarationsOnTheSameSurfaceStayAmbiguous() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "pr", entityId: "916", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "text": "91%" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(
      contributions: [published],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "row-badge", surface: "prs", id: "risk", label: "Risk"),
          PluginManifestSocketWire(socket: "row-badge", surface: "prs", id: "age", label: "Age"),
        ]),
      ])
    )

    XCTAssertEqual(
      Set(index.badges(.pr, "916").visible.compactMap { $0.badge?.text }),
      ["Risk", "Age"],
      "The unresolvable row drops; both declarations stand."
    )
  }

  /// A row addressed by socket id joins its own surface's declaration, so two
  /// surfaces reusing one id do not answer for each other.
  func testAnAddressedRowResolvesAgainstItsOwnSurface() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "pr", entityId: "916", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "id": "risk", "text": "91%" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(
      contributions: [published],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Lane risk"),
          PluginManifestSocketWire(socket: "row-badge", surface: "prs", id: "risk", label: "PR risk"),
        ]),
      ])
    )

    XCTAssertEqual(index.badges(.pr, "916").visible.first?.badge?.text, "91%")
  }

  /// The same row against ONE declaration of its kind is unambiguous, so it
  /// resolves to it and fills it in.
  func testAnIdLessRowAgainstASingleDeclarationResolvesToIt() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "text": "82%" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(
      contributions: [published],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Risk"),
        ]),
      ])
    )
    let badges = index.badges(.lane, "lane-1")
    XCTAssertEqual(badges.visible.count, 1, "It fills the declaration rather than joining it.")
    XCTAssertEqual(badges.visible.first?.badge?.text, "82%")
  }

  /// Rows left behind by a plugin that never declared the socket, or has
  /// stopped declaring it, drop. The host has always done this before a row
  /// left the machine; the phone could not until it had the declarations.
  func testRowsNoDeclarationClaimsAreDropped() throws {
    let undeclaredKind = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "text": "82%" }"#, updatedAt: ""
    ))
    let staleId = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-menu-item",
      payloadJSON: #"{ "id": "retired", "label": "Old", "actionId": "a" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(
      contributions: [undeclaredKind, staleId],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "row-menu-item", surface: "lanes", id: "rebuild",
                                   label: "Rebuild", actionId: "a"),
        ]),
      ])
    )
    XCTAssertTrue(index.badges(.lane, "lane-1").isEmpty, "The plugin declares no badge at all.")
    XCTAssertEqual(
      index.menuItems(.lane, "lane-1").map { $0.menuItem?.label },
      ["Rebuild"],
      "A row naming a socket id the plugin no longer declares is stale and drops."
    )
  }

  /// A plugin declaring nothing is a DIFFERENT claim from a host that cannot
  /// read manifests, and only the first may drop rows. Collapsing the two would
  /// hide every contribution on the phone against any host too old to send the
  /// field.
  func testAHostThatCannotReadManifestsLeavesEveryPublishedRowAlone() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "text": "82%" }"#, updatedAt: ""
    ))
    // `sockets` absent: an older host, or one with no plugin host bound.
    let older = PluginContributionIndex(
      contributions: [published],
      declarations: PluginSocketDeclarations(records: [
        PluginInstallRecordEntry(pluginId: "coverage", enabled: true, sockets: nil),
      ])
    )
    XCTAssertEqual(older.badges(.lane, "lane-1").visible.count, 1)

    // `sockets: []`: the manifest WAS read and declares none.
    let declaresNone = PluginContributionIndex(
      contributions: [published],
      declarations: PluginSocketDeclarations(records: [
        PluginInstallRecordEntry(pluginId: "coverage", enabled: true, sockets: []),
      ])
    )
    XCTAssertTrue(declaresNone.badges(.lane, "lane-1").isEmpty)
  }

  func testDisabledPluginsAndSwitchedOffSocketsDeclareNothing() {
    let switchedOff = PluginContributionIndex(
      declarations: PluginSocketDeclarations(records: [
        installRecord(
          sockets: [
            PluginManifestSocketWire(socket: "toolbar-action", surface: "lanes", id: "scan",
                                     label: "Scan", actionId: "a"),
          ],
          disabled: ["scan"]
        ),
      ])
    )
    XCTAssertTrue(
      switchedOff.toolbarActions(.lanes).isEmpty,
      "A switch that visibly does nothing is worse than no switch."
    )

    let disabledPlugin = PluginContributionIndex(
      declarations: PluginSocketDeclarations(records: [
        installRecord(enabled: false, sockets: [
          PluginManifestSocketWire(socket: "toolbar-action", surface: "lanes", id: "scan",
                                   label: "Scan", actionId: "a"),
        ]),
      ])
    )
    XCTAssertTrue(disabledPlugin.toolbarActions(.lanes).isEmpty)
  }

  /// A manifest that parsed but implies a payload with no label is still a
  /// contribution that must not render.
  func testADeclarationWhoseImpliedPayloadIsUnusableIsDropped() {
    let index = PluginContributionIndex(
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          // No label, so no button text.
          PluginManifestSocketWire(socket: "toolbar-action", surface: "lanes", id: "a", actionId: "x"),
          // No actionId, so nothing to invoke.
          PluginManifestSocketWire(socket: "toolbar-action", surface: "lanes", id: "b", label: "Go"),
          // No panelId, so nothing to draw.
          PluginManifestSocketWire(socket: "detail-section", surface: "lanes", id: "c", label: "Bits"),
        ]),
      ])
    )
    XCTAssertTrue(index.toolbarActions(.lanes).isEmpty)
    XCTAssertTrue(index.detailSections(.lane, "lane-1").isEmpty)
  }

  /// A kind the phone has no host for never becomes a contribution, so the two
  /// paths agree about what this client renders.
  func testDeclarationsForKindsThePhoneCannotDrawAreDropped() {
    let declarations = PluginSocketDeclarations(records: [
      installRecord(sockets: [
        PluginManifestSocketWire(socket: "command-palette-action", surface: "app", id: "p",
                                 label: "Palette", actionId: "a"),
        PluginManifestSocketWire(socket: "work-rail-pane", surface: "work", id: "r",
                                 label: "Rail", panelId: "panel"),
        PluginManifestSocketWire(socket: "timeline-card", surface: "prs", id: "t", label: "Future"),
      ]),
    ])
    XCTAssertTrue(declarations.isEmpty, "Nothing the phone cannot host becomes a contribution.")
  }

  func testAFilterChipDeclarationFallsBackToItsSocketIdForTheFilterKey() {
    let index = PluginContributionIndex(
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "filter-chip", surface: "lanes", id: "risky", label: "Risky"),
          PluginManifestSocketWire(socket: "filter-chip", surface: "lanes", id: "slow",
                                   label: "Slow", filterKey: "is-slow"),
        ]),
      ])
    )
    let chips = index.filterChips(.lanes)
    XCTAssertEqual(chips.count, 2)
    XCTAssertEqual(chips.first { $0.filterChip?.label == "Risky" }?.filterChip?.filterKey, "risky")
    XCTAssertEqual(chips.first { $0.filterChip?.label == "Slow" }?.filterChip?.filterKey, "is-slow")
  }

  /// The `chat-card` gap the manifest feed closes: desktop drew a declared
  /// card's panel and the phone did not.
  func testADeclaredChatCardPermitsItsPanelInEveryChat() {
    let index = PluginContributionIndex(
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "chat-card", surface: "work", id: "summary",
                                   label: "Coverage", panelId: "summary"),
        ]),
      ])
    )
    XCTAssertTrue(index.declaresChatCard(pluginId: "coverage", panelId: "summary", sessionId: "any-chat"))
    XCTAssertFalse(index.declaresChatCard(pluginId: "coverage", panelId: "other", sessionId: "any-chat"))
  }

  /// Two declarations of one kind from one plugin differ only by manifest id,
  /// so identity has to include it or they collapse into one row.
  func testTwoDeclarationsOfOneKindKeepSeparateIdentities() {
    let index = PluginContributionIndex(
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "toolbar-action", surface: "lanes", id: "scan",
                                   order: 1, label: "Scan", actionId: "a"),
          PluginManifestSocketWire(socket: "toolbar-action", surface: "lanes", id: "audit",
                                   order: 2, label: "Audit", actionId: "b"),
        ]),
      ])
    )
    let actions = index.toolbarActions(.lanes)
    XCTAssertEqual(actions.count, 2)
    XCTAssertEqual(Set(actions.map(\.id)).count, 2, "Colliding ids would drop one row from a ForEach.")
    XCTAssertEqual(actions.map { $0.toolbarAction?.label }, ["Scan", "Audit"], "Declared order is honoured.")
  }

  /// An absent `sockets` field is an older host that cannot see the manifest.
  /// It must read as "nothing to add", leaving published rows as the whole
  /// story — never as an error and never as "declares none".
  func testAnOlderHostWithNoSocketsFieldChangesNothing() throws {
    let reply = try JSONDecoder().decode(
      PluginInstallListResult.self,
      from: XCTUnwrap(#"{ "plugins": [{ "pluginId": "coverage", "enabled": true }] }"#.data(using: .utf8))
    )
    XCTAssertEqual(reply.plugins.count, 1)
    // Absent is nil, NOT an empty list: nil means "this host could not report a
    // manifest", and collapsing it to [] is the exact blackout this test guards.
    XCTAssertNil(reply.plugins[0].sockets)
    XCTAssertTrue(PluginSocketDeclarations(records: reply.plugins).isEmpty)
  }

  /// The wire shape is a mirror of the manifest entry, so a field this build
  /// has never heard of must not cost the declaration.
  func testInstallRecordDecodingToleratesUnknownFields() throws {
    let reply = try JSONDecoder().decode(
      PluginInstallListResult.self,
      from: XCTUnwrap(#"""
      { "plugins": [{
        "pluginId": "coverage", "version": "1.2.0", "enabled": true,
        "displayName": "Coverage", "icon": "", "accent": "#7C6FF0",
        "source": "registry", "installedAt": "2026-08-13T00:00:00Z",
        "status": "running", "tabs": [], "theme": null,
        "sockets": [{
          "socket": "toolbar-action", "surface": "lanes", "id": "scan",
          "label": "Scan", "actionId": "coverage.scan", "order": 3,
          "tooltip": "a field iOS has never heard of"
        }],
        "disabledContributions": []
      }] }
      """#.data(using: .utf8))
    )
    let socket = try XCTUnwrap(reply.plugins.first?.sockets?.first)
    XCTAssertEqual(socket.socket, "toolbar-action")
    XCTAssertEqual(socket.order, 3)
    XCTAssertEqual(socket.actionId, "coverage.scan")
  }

  /// `order` is a sort key written by another machine, and `Int(_:)` traps
  /// rather than saturating. Out of range saturates so the phone and desktop
  /// still agree which contribution comes first.
  func testAnOutOfRangeDeclarationOrderSaturatesRatherThanTrapping() throws {
    let reply = try JSONDecoder().decode(
      PluginInstallListResult.self,
      from: XCTUnwrap(#"""
      { "plugins": [{ "pluginId": "p", "enabled": true, "sockets": [
        { "socket": "toolbar-action", "surface": "lanes", "id": "a", "label": "A", "actionId": "x", "order": -1e300 },
        { "socket": "toolbar-action", "surface": "lanes", "id": "b", "label": "B", "actionId": "y", "order": 1e300 }
      ] }] }
      """#.data(using: .utf8))
    )
    let sockets = try XCTUnwrap(reply.plugins.first?.sockets)
    XCTAssertEqual(sockets[0].order, Int.min)
    XCTAssertEqual(sockets[1].order, Int.max)

    let index = PluginContributionIndex(declarations: PluginSocketDeclarations(records: reply.plugins))
    XCTAssertEqual(
      index.toolbarActions(.lanes).map { $0.toolbarAction?.label },
      ["A", "B"],
      "A plugin asking for the front with a huge negative lands first, as it does on desktop."
    )
  }

  /// Switching a contribution off has to take the PUBLISHED row with it, not
  /// just the declaration. Hiding only the declaration leaves the plugin's
  /// badge on the row and makes the switch look broken.
  func testSwitchingASocketOffAlsoHidesTheRowItPublished() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "id": "risk", "text": "82%" }"#, updatedAt: ""
    ))
    let declarations = PluginSocketDeclarations(records: [
      installRecord(
        sockets: [
          PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Risk"),
        ],
        disabled: ["risk"]
      ),
    ])
    let index = PluginContributionIndex(contributions: [published], declarations: declarations)
    XCTAssertTrue(index.badges(.lane, "lane-1").isEmpty, "The switch governs both halves.")
  }

  /// An id-less row resolves through its kind's sole declaration, so switching
  /// that declaration off takes the row with it.
  ///
  /// This replaces an earlier assertion that the row survived. That was the
  /// identity ladder's answer, not the host's: the host resolves a row before it
  /// ever leaves the machine, so a switched-off socket publishes nothing at all.
  func testAnIdLessRowIsTakenBySwitchingItsSoleDeclarationOff() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "text": "82%" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(
      contributions: [published],
      declarations: PluginSocketDeclarations(records: [
        installRecord(
          sockets: [
            PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Risk"),
          ],
          disabled: ["risk"]
        ),
      ])
    )
    XCTAssertTrue(index.badges(.lane, "lane-1").isEmpty)
  }

  /// A switch on one contribution must not reach another the same plugin
  /// published.
  func testSwitchingOneSocketOffLeavesThePluginsOtherRows() throws {
    let risk = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "id": "risk", "text": "82%" }"#, updatedAt: ""
    ))
    let menu = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-menu-item",
      payloadJSON: #"{ "id": "rebuild", "label": "Rebuild", "actionId": "a" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(
      contributions: [risk, menu],
      declarations: PluginSocketDeclarations(records: [
        installRecord(
          sockets: [
            PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Risk"),
            PluginManifestSocketWire(socket: "row-menu-item", surface: "lanes", id: "rebuild",
                                     label: "Rebuild", actionId: "a"),
          ],
          disabled: ["risk"]
        ),
      ])
    )
    XCTAssertTrue(index.badges(.lane, "lane-1").isEmpty)
    XCTAssertEqual(index.menuItems(.lane, "lane-1").count, 1)
  }

  /// An older host sends no declarations at all, so there are no toggles to
  /// apply and every published row stands — the pre-manifest-feed behaviour,
  /// unchanged.
  func testWithNoDeclarationsEveryPublishedRowStands() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "coverage", socket: "row-badge",
      payloadJSON: #"{ "id": "risk", "text": "82%" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(contributions: [published], declarations: .none)
    XCTAssertEqual(index.badges(.lane, "lane-1").visible.count, 1)
  }

  /// Every kind this client claims in `PLUGIN_SOCKET_CLIENT_SUPPORT` resolves a
  /// minimal declaration into something renderable.
  ///
  /// This binds the shared parity table to the code. A `ios: true` cell is a
  /// promise that a plugin declaring that kind sees it on the phone, and the
  /// arm that keeps the promise is one `return nil` away from breaking it
  /// silently — a contribution that "parses clean and contributes nothing",
  /// which is the failure the requirement table exists to prevent.
  ///
  /// The other half of the guard is structural and cannot live in a test:
  /// `PluginSocketDeclarations.payload(for:wire:)` switches exhaustively over
  /// ``PluginSocketKind`` with NO `default:`, so adding an eleventh kind fails
  /// to compile until someone writes its arm. **If this test ever starts
  /// passing with a kind missing, check that nobody added a `default:` to that
  /// switch** — that converts the build error this relies on into a silent drop.
  func testEveryKindIOSClaimsInTheParityTableResolvesADeclaration() {
    // Minimal declarations: exactly the fields each kind's payload requires,
    // on a surface that hosts it. Nothing optional, so an arm that quietly
    // started depending on an extra field fails here rather than in the field.
    let minimal: [(kind: String, surface: String, wire: PluginManifestSocketWire)] = [
      ("toolbar-action", "lanes", PluginManifestSocketWire(
        socket: "toolbar-action", surface: "lanes", id: "a", label: "A", actionId: "x")),
      ("row-badge", "lanes", PluginManifestSocketWire(
        socket: "row-badge", surface: "lanes", id: "b", label: "B")),
      ("row-menu-item", "lanes", PluginManifestSocketWire(
        socket: "row-menu-item", surface: "lanes", id: "c", label: "C", actionId: "x")),
      ("detail-section", "lanes", PluginManifestSocketWire(
        socket: "detail-section", surface: "lanes", id: "d", panelId: "p")),
      ("empty-state", "lanes", PluginManifestSocketWire(
        socket: "empty-state", surface: "lanes", id: "e", label: "E")),
      ("filter-chip", "lanes", PluginManifestSocketWire(
        socket: "filter-chip", surface: "lanes", id: "f", label: "F")),
      ("file-viewer", "files", PluginManifestSocketWire(
        socket: "file-viewer", surface: "files", id: "g", panelId: "p", extensions: [".parquet"])),
      ("composer-action", "work", PluginManifestSocketWire(
        socket: "composer-action", surface: "work", id: "h", label: "H", actionId: "x")),
      ("chat-card", "work", PluginManifestSocketWire(
        socket: "chat-card", surface: "work", id: "i", panelId: "p")),
      ("activity-entry", "app", PluginManifestSocketWire(
        socket: "activity-entry", surface: "app", id: "j", label: "J")),
    ]

    for entry in minimal {
      let declarations = PluginSocketDeclarations(records: [
        installRecord(sockets: [entry.wire]),
      ])
      let resolved = declarations.surfaceScoped.count
        + declarations.wildcardByEntityKind.values.reduce(0) { $0 + $1.count }
      XCTAssertEqual(
        resolved,
        1,
        """
        `\(entry.kind)` is ios: true in PLUGIN_SOCKET_CLIENT_SUPPORT but resolved \
        no contribution from a minimal declaration. Either its arm in \
        PluginSocketDeclarations.payload(for:wire:) regressed, or the parity \
        table now claims a kind this client does not render.
        """
      )
    }

    XCTAssertEqual(minimal.count, 10, "iOS claims ten of the taxonomy's sixteen kinds.")
  }

  /// The counterpart: a kind the table marks `ios: false` must NOT resolve, or
  /// the phone is quietly rendering something the table says it does not and
  /// the other clients are not expecting.
  func testKindsTheParityTableMarksUnsupportedResolveNothing() {
    for socket in ["slash-command", "command-palette-action", "settings-section",
                   "work-rail-pane", "drawer-tab", "dialog-section"] {
      let declarations = PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(
            socket: socket, surface: "work", id: "x",
            label: "L", panelId: "p", actionId: "a"
          ),
        ]),
      ])
      XCTAssertTrue(
        declarations.isEmpty,
        "`\(socket)` is ios: false in PLUGIN_SOCKET_CLIENT_SUPPORT but resolved a contribution."
      )
    }
  }

  // MARK: - Tolerant list decoding

  /// One unreadable element must cost one element.
  ///
  /// These lists cross from a machine that may be running a newer ADE. Decoded
  /// all-or-nothing, a single entry in a shape this build cannot read emptied
  /// the whole list — and an empty install list is not "one plugin I could not
  /// read", it is "no plugins", which drops every contribution on the phone.
  func testOneUnreadableInstallRecordDoesNotEmptyTheList() throws {
    let json = """
    { "plugins": [
        { "pluginId": "coverage", "enabled": true },
        "not-an-object",
        { "pluginId": "lint", "enabled": true }
    ] }
    """
    let result = try JSONDecoder().decode(
      PluginInstallListResult.self,
      from: Data(json.utf8)
    )

    XCTAssertEqual(result.plugins.map(\.pluginId), ["coverage", "lint"])
  }

  func testOneUnreadablePresenceEntryDoesNotEmptyTheList() throws {
    let json = """
    { "plugins": [ 42, { "pluginId": "coverage", "enabled": true } ] }
    """
    let result = try JSONDecoder().decode(
      PluginPresenceListResult.self,
      from: Data(json.utf8)
    )

    XCTAssertEqual(result.plugins.map(\.pluginId), ["coverage"])
  }

  /// The distinction the join depends on: ABSENT `sockets` means "this host
  /// cannot see manifests" and leaves every published row alone, while an empty
  /// array is the stronger claim that the manifest declares nothing. A lossy
  /// decode must never turn the first into the second.
  func testAbsentSocketsStayNilWhileALossyOneDropsAlone() throws {
    let absent = try JSONDecoder().decode(
      PluginInstallRecordEntry.self,
      from: Data(#"{ "pluginId": "coverage", "enabled": true }"#.utf8)
    )
    XCTAssertNil(absent.sockets, "Absent must not collapse to an empty declaration set.")

    let nulled = try JSONDecoder().decode(
      PluginInstallRecordEntry.self,
      from: Data(#"{ "pluginId": "coverage", "enabled": true, "sockets": null }"#.utf8)
    )
    XCTAssertNil(nulled.sockets)

    let lossy = try JSONDecoder().decode(
      PluginInstallRecordEntry.self,
      from: Data("""
      { "pluginId": "coverage", "enabled": true, "sockets": [
          { "socket": "row-badge", "surface": "lanes", "id": "risk", "label": "Risk" },
          "not-an-object"
      ] }
      """.utf8)
    )
    XCTAssertEqual(lossy.sockets?.count, 1, "The readable socket survives its unreadable sibling.")
    XCTAssertEqual(lossy.sockets?.first?.id, "risk")

    let empty = try JSONDecoder().decode(
      PluginInstallRecordEntry.self,
      from: Data(#"{ "pluginId": "coverage", "enabled": true, "sockets": [] }"#.utf8)
    )
    XCTAssertEqual(empty.sockets?.isEmpty, true, "Empty stays empty — the stronger claim.")
  }

  // MARK: - Icon tokens

  /// Every icon token desktop offers a manifest author.
  ///
  /// Copied from `PLUGIN_ICONS` in
  /// `apps/desktop/src/renderer/components/plugins/pluginIcons.tsx`, which is
  /// the list an author is shown and the authoring skill documents. Held here
  /// literally, and on purpose: the two tests below walk it in BOTH directions,
  /// so neither client can add a token the other cannot draw. One direction
  /// alone is what let `beer` exist on the phone and nowhere else for an
  /// afternoon.
  private static let desktopIconTokens = [
    "beer",
    "bell", "bookmark", "brain", "bug", "calendar", "chart", "chart-bar", "chat",
    "clock", "clock-counter-clockwise", "cloud", "code", "compass", "cube",
    "currency", "database", "desktop", "device-mobile", "envelope", "eye", "file",
    "flag", "folder", "gear", "git-branch", "git-commit", "git-pull-request",
    "globe", "graph", "heart", "image", "kanban", "key", "lightning", "link",
    "list", "list-checks", "lock", "magic", "microphone", "music", "note",
    "package", "palette", "play", "plug", "puzzle", "robot", "rocket", "rows",
    "shield", "sparkle", "star", "storefront", "table", "tag", "terminal",
    "timer", "toolbox", "trend", "users", "video", "wrench",
  ]

  func testEveryDesktopIconTokenDrawsSomethingOnThePhone() {
    for token in Self.desktopIconTokens {
      XCTAssertNotNil(
        PluginSymbol.symbol(token),
        "`\(token)` is offered to manifest authors on desktop but falls back to the puzzle piece here."
      )
    }
  }

  /// The other direction, and the one that was missing.
  ///
  /// A token the phone draws and desktop does not is the same defect as the
  /// reverse — one manifest, two pictures — just harder to notice, because the
  /// person testing on a phone sees it working. `beer` was exactly that for an
  /// afternoon: added here to fix the retrospective's bug, absent from desktop's
  /// map, so the identical token drew a mug on iOS and a puzzle piece on the
  /// desktop beside it.
  func testThePhoneDrawsNoTokenDesktopHasNeverHeardOf() {
    let desktop = Set(Self.desktopIconTokens)
    for token in PluginSymbol.tokenNames {
      XCTAssertTrue(
        desktop.contains(token),
        "`\(token)` draws on the phone and is not in desktop's map — one manifest, two pictures."
      )
    }
    // Same count both ways, so neither list can drift by an entry the loops
    // above happen not to reach.
    XCTAssertEqual(PluginSymbol.tokenNames.count, Self.desktopIconTokens.count)
  }

  /// Every symbol the map names has to exist in THIS build's SF Symbols
  /// catalogue. A typo or a symbol added in a later OS resolves to nil at
  /// runtime and draws an empty box beside a label, which looks like the
  /// plugin's fault.
  func testEveryMappedSymbolResolvesOnThisOS() {
    for token in PluginSymbol.tokenNames {
      let symbol = PluginSymbol.symbol(token)
      XCTAssertNotNil(symbol, "`\(token)` maps to nothing.")
      if let symbol {
        XCTAssertTrue(
          PluginSymbol.exists(symbol),
          "`\(token)` maps to `\(symbol)`, which this OS does not have."
        )
      }
    }
  }

  /// The bug the retrospective named, pinned so it cannot come back.
  ///
  /// A drink plugin's `beer` drew as `cup.and.saucer.fill` — tea — while
  /// desktop drew a stein. The assertion is deliberately about the FAMILY
  /// rather than one exact symbol: which mug SF ships may change, but a beer
  /// token must never again resolve to a teacup.
  func testBeerReadsAsADrinkAndNeverAsATeacup() throws {
    let symbol = try XCTUnwrap(PluginSymbol.symbol("beer"), "A beer token must draw something.")
    XCTAssertFalse(
      symbol.contains("cup.and.saucer"),
      "`beer` resolved to \(symbol), which reads as tea or coffee."
    )
    XCTAssertTrue(
      symbol.hasPrefix("mug") || symbol.hasPrefix("wineglass") || symbol.hasPrefix("waterbottle"),
      "`beer` resolved to \(symbol), which is not in the drinking-vessel family."
    )
  }

  /// A token wins over a same-spelled SF Symbol, so one name cannot mean two
  /// things depending on which catalogue the reader had in mind.
  func testTokensWinOverSameSpelledSystemSymbols() {
    XCTAssertEqual(PluginSymbol.symbol("chart"), "chart.line.uptrend.xyaxis")
    XCTAssertEqual(PluginSymbol.symbol("list"), "checklist")
    // Case and stray whitespace are the author's, not a different icon.
    XCTAssertEqual(PluginSymbol.symbol("  Git-Branch "), "arrow.triangle.branch")
  }

  /// The token list is the whole namespace: a raw SF Symbol name is NOT an icon.
  ///
  /// It resolved here once, as an apparent kindness to an author who reached
  /// past the token list. It was not one — desktop cannot resolve SF Symbol
  /// names at all, so such an icon rendered on exactly one client and puzzled on
  /// the other. Refusing it makes the failure symmetric and visible: the author
  /// sees the same puzzle piece everywhere, and the fix is to name a token.
  func testARawSystemSymbolNameIsNotAnIcon() {
    XCTAssertNil(
      PluginSymbol.symbol("bolt.horizontal.circle"),
      "A real SF Symbol that is not a token must not resolve — desktop cannot draw it."
    )
    XCTAssertEqual(
      PluginSymbol.resolve("bolt.horizontal.circle", fallback: "puzzlepiece.extension"),
      "puzzlepiece.extension"
    )
    XCTAssertNil(PluginSymbol.symbol("not.a.real.symbol.at.all"))
    XCTAssertNil(PluginSymbol.symbol(nil))
    XCTAssertNil(PluginSymbol.symbol("   "))
    XCTAssertEqual(PluginSymbol.resolve("not.a.real.symbol.at.all", fallback: "puzzlepiece.extension"), "puzzlepiece.extension")
  }

  func testOneUnreadableDisabledContributionIdDoesNotDropTheRest() throws {
    let record = try JSONDecoder().decode(
      PluginInstallRecordEntry.self,
      from: Data("""
      { "pluginId": "coverage", "enabled": true, "disabledContributions": ["risk", 7, "age"] }
      """.utf8)
    )

    XCTAssertEqual(record.disabledContributions, ["risk", "age"])
  }
}

/// The response verbs and the panel refresh contract, on the phone.
///
/// Split from the decoder tests above because the subject is different: not
/// what a panel schema means, but what a plugin's ANSWER means and what a
/// panel row says the pane may do. Both are places where a client silently
/// dropping something the other three honour is the whole failure mode.
/// Client-evaluated panel state: the `segmented` control and the `where` clause.
///
/// The cases mirror the ones the shared TypeScript module is held to
/// (`apps/desktop/src/shared/plugins/vocabularyState.ts`), because the whole
/// point of the contract is that one schema and one set of rows produce the same
/// visible list on the phone, the desktop, the web client and the terminal. A
/// divergence here is a filter that keeps a row on one surface and drops it on
/// another, which is worse than no filter at all.
final class PluginVocabPanelStateTests: XCTestCase {
  private func parse(_ json: String) -> PluginPanelParseResult {
    PluginPanelParser.parse(json)
  }

  private func panel(_ result: PluginPanelParseResult) throws -> PluginPanelSchema {
    guard case let .ok(schema, _) = result else {
      throw XCTSkip("Expected a parsed panel, got \(result)")
    }
    return schema
  }

  /// A `where`, parsed the way `parseBinding` parses one, plus its warnings.
  private func predicates(_ json: String) -> ([PluginVocabPredicate]?, [PluginVocabWarning]) {
    let raw = try? JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed])
    var context = PluginPanelParser.ParseContext()
    let parsed = PluginPanelParser.parseWhere(raw, path: "body[0].bind.where", context: &context)
    return (parsed, context.warnings)
  }

  private let fleet: [[String: Any]] = [
    ["title": "bc-1f4a", "statusGroup": "active", "archivedGroup": "live"],
    ["title": "bc-90de", "statusGroup": "active", "archivedGroup": "live"],
    ["title": "bc-77b2", "statusGroup": "failed", "archivedGroup": "live"],
    ["title": "bc-3ac1", "statusGroup": "finished", "archivedGroup": "live"],
    ["title": "bc-0092", "statusGroup": "finished", "archivedGroup": "archived"],
  ]

  private func kept(_ json: String, state: PluginVocabPanelState = [:]) -> [String] {
    let (parsed, _) = predicates(json)
    return PluginVocabState.filter(parsed, fleet, state: state) { $0 }
      .compactMap { $0["title"] as? String }
  }

  // MARK: - The control

  func testASegmentedNodeParsesItsOptionsDefaultAndStateKey() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "Fleet", "text": "Open ADE to see the fleet." },
      "body": [
        {
          "component": "segmented",
          "stateKey": "statusFilter",
          "label": "Status",
          "default": "active",
          "options": [
            { "value": "", "label": "All", "badge": 5 },
            { "value": "active", "label": "Active" },
            { "value": "active", "label": "A duplicate nobody can reach" },
            { "value": "failed" }
          ]
        }
      ]
    }
    """#))

    guard case let .segmented(control) = schema.body[0] else { return XCTFail("expected a segmented node") }
    XCTAssertEqual(control.stateKey, "statusFilter")
    XCTAssertEqual(control.label, "Status")
    XCTAssertEqual(control.initial, "active")
    // A duplicate value collapses, and an option with no label falls back to its
    // own value. A numeric badge reads as its digits rather than dropping.
    XCTAssertEqual(control.options.map(\.value), ["", "active", "failed"])
    XCTAssertEqual(control.options.map(\.label), ["All", "Active", "failed"])
    XCTAssertEqual(control.options.first?.badge, "5")
    XCTAssertTrue(PluginRenderSupport.isRenderable(schema.body[0]))
  }

  func testAControlWithNothingToChooseIsInvalidRatherThanStuck() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "F", "text": "f" },
      "body": [
        { "component": "segmented", "stateKey": "only", "options": [{ "value": "a", "label": "A" }] },
        { "component": "segmented", "stateKey": "$context", "options": [
          { "value": "a", "label": "A" }, { "value": "b", "label": "B" }
        ] },
        { "component": "text", "text": "still here" }
      ]
    }
    """#))

    // One option is not a choice, and `$` is ADE's. Both are node-local
    // failures: the panel keeps everything else.
    XCTAssertEqual(schema.body[0].componentName, "segmented")
    if case .invalid = schema.body[0] {} else { XCTFail("one option must not parse") }
    if case .invalid = schema.body[1] {} else { XCTFail("a `$` state key must not parse") }
    XCTAssertEqual(schema.body[2], .text(PluginVocabText(text: "still here")))
  }

  func testAToggleWithMoreThanTwoOptionsFallsBackToSegmented() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "F", "text": "f" },
      "body": [
        { "component": "segmented", "stateKey": "k", "style": "toggle", "options": [
          { "value": "a", "label": "A" }, { "value": "b", "label": "B" }, { "value": "c", "label": "C" }
        ] },
        { "component": "segmented", "stateKey": "j", "style": "toggle", "options": [
          { "value": "a", "label": "A" }, { "value": "b", "label": "B" }
        ] }
      ]
    }
    """#))

    // Drawing three options as a switch would hide one, so the declaration loses.
    guard case let .segmented(three) = schema.body[0], case let .segmented(two) = schema.body[1] else {
      return XCTFail("expected two segmented nodes")
    }
    XCTAssertEqual(three.style, .segmented)
    XCTAssertEqual(two.style, .toggle)
  }

  // MARK: - The predicate

  func testEqualityFoldsIntoMembershipAndAStateReferenceIsItsOwnOperand() {
    let (parsed, warnings) = predicates(#"""
    [
      { "field": "statusGroup", "equals": "active" },
      { "field": "statusGroup", "notEquals": ["failed", "failed"] },
      { "field": "statusGroup", "equals": { "$state": "statusFilter" } }
    ]
    """#)

    XCTAssertEqual(warnings, [])
    XCTAssertEqual(parsed?.count, 3)
    XCTAssertEqual(parsed?[0], .compare(op: .membership, field: "statusGroup", values: ["active"], stateKey: nil))
    // `notEquals` folds the same way, and a repeated literal is one literal.
    XCTAssertEqual(parsed?[1], .compare(op: .exclusion, field: "statusGroup", values: ["failed"], stateKey: nil))
    XCTAssertEqual(parsed?[2], .compare(op: .membership, field: "statusGroup", values: nil, stateKey: "statusFilter"))
  }

  func testAClauseWithNoOperatorOrTwoOfThemIsDroppedWithAWarning() {
    let (none, noneWarnings) = predicates(#"[{ "field": "statusGroup" }]"#)
    XCTAssertNil(none)
    XCTAssertEqual(noneWarnings.map(\.code), [.invalidBinding])

    let (both, bothWarnings) = predicates(#"[{ "field": "statusGroup", "equals": "a", "in": ["b"] }]"#)
    XCTAssertNil(both)
    XCTAssertEqual(bothWarnings.map(\.code), [.invalidBinding])

    // A `where` that parsed to nothing is an UNFILTERED binding, not an empty
    // one: a filter that fails shows too much, never too little.
    XCTAssertEqual(kept(#"[{ "field": "statusGroup" }]"#).count, 5)
  }

  func testALiteralFilterKeepsTheRowsItNames() {
    XCTAssertEqual(kept(#"[{ "field": "statusGroup", "in": ["failed", "finished"] }]"#),
                   ["bc-77b2", "bc-3ac1", "bc-0092"])
    XCTAssertEqual(kept(#"[{ "field": "archivedGroup", "notIn": ["archived"] }]"#),
                   ["bc-1f4a", "bc-90de", "bc-77b2", "bc-3ac1"])
    // Two top-level clauses are ANDed.
    XCTAssertEqual(kept(#"""
    [
      { "field": "statusGroup", "equals": "finished" },
      { "field": "archivedGroup", "equals": "live" }
    ]
    """#), ["bc-3ac1"])
  }

  func testAStateDrivenFilterFollowsTheReadersSelection() {
    let clause = #"[{ "field": "statusGroup", "equals": { "$state": "statusFilter" } }]"#
    XCTAssertEqual(kept(clause, state: ["statusFilter": "active"]), ["bc-1f4a", "bc-90de"])
    XCTAssertEqual(kept(clause, state: ["statusFilter": "failed"]), ["bc-77b2"])
  }

  func testAnUnsetOrUndeclaredStateKeyIsInactiveRatherThanFalse() {
    let clause = #"[{ "field": "statusGroup", "equals": { "$state": "statusFilter" } }]"#
    // "All" is the empty value. Inactive, so every row survives — this is what
    // lets one option list express "turn this filter off".
    XCTAssertEqual(kept(clause, state: ["statusFilter": ""]).count, 5)
    // A key no control declared reads the same way: a typo must not hide the
    // whole list.
    XCTAssertEqual(kept(clause, state: [:]).count, 5)
    // And an inactive clause is not a vote inside a composer either.
    XCTAssertEqual(kept(#"""
    [
      {
        "and": [
          { "field": "statusGroup", "equals": { "$state": "statusFilter" } },
          { "field": "archivedGroup", "equals": "archived" }
        ]
      }
    ]
    """#, state: [:]), ["bc-0092"])
  }

  func testComposedClausesEvaluateAsTheyRead() {
    XCTAssertEqual(kept(#"""
    [
      {
        "or": [
          { "field": "statusGroup", "in": ["failed"] },
          {
            "and": [
              { "field": "statusGroup", "equals": "finished" },
              { "field": "archivedGroup", "notEquals": "archived" }
            ]
          }
        ]
      }
    ]
    """#), ["bc-77b2", "bc-3ac1"])

    XCTAssertEqual(kept(#"[{ "not": { "field": "statusGroup", "equals": "active" } }]"#),
                   ["bc-77b2", "bc-3ac1", "bc-0092"])
    // A `not` of an inactive clause is itself inactive, not `true` — negating
    // "this filter is off" must not start filtering.
    XCTAssertEqual(kept(#"[{ "not": { "field": "statusGroup", "equals": { "$state": "unset" } } }]"#).count, 5)
  }

  func testAClauseNestedPastTheDepthLimitIsRefused() {
    let (parsed, warnings) = predicates(#"""
    [{ "and": [{ "or": [{ "not": { "field": "statusGroup", "equals": "active" } }] }] }]
    """#)

    XCTAssertNil(parsed, "A clause at depth four must not parse.")
    XCTAssertTrue(warnings.contains { $0.message.contains("nest at most") })
    // Depth three is the ceiling and still parses.
    let (deep, deepWarnings) = predicates(#"""
    [{ "and": [{ "not": { "field": "statusGroup", "equals": "active" } }] }]
    """#)
    XCTAssertNotNil(deep)
    XCTAssertEqual(deepWarnings, [])
  }

  func testATypedFieldComparesAsItsJSONWordsAndAnObjectMatchesNothing() {
    let rows: [[String: Any]] = [
      ["id": "a", "archived": false, "count": 3],
      ["id": "b", "archived": true, "count": 4],
      ["id": "c", "nested": ["deep": 1]],
    ]
    func keep(_ json: String) -> [String] {
      let raw = try? JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed])
      var context = PluginPanelParser.ParseContext()
      let parsed = PluginPanelParser.parseWhere(raw, path: "p", context: &context)
      return PluginVocabState.filter(parsed, rows, state: [:]) { $0 }.compactMap { $0["id"] as? String }
    }

    // A plugin writing `archived: false` and filtering on `"false"` must match:
    // this is the predicate coercion, not the display one that says "No".
    XCTAssertEqual(keep(#"[{ "field": "archived", "equals": false }]"#), ["a"])
    XCTAssertEqual(keep(#"[{ "field": "archived", "equals": "true" }]"#), ["b"])
    XCTAssertEqual(keep(#"[{ "field": "count", "equals": 3 }]"#), ["a"])
    // An object has no text form a plugin could have meant.
    XCTAssertEqual(keep(#"[{ "field": "nested", "equals": "deep" }]"#), [])
  }

  // MARK: - Lifecycle

  private func controls(_ body: String) throws -> [PluginVocabStateDeclaration] {
    let schema = try panel(parse(#"{ "v": 1, "fallback": { "title": "F", "text": "f" }, "body": \#(body) }"#))
    return PluginVocabState.declarations(in: schema.body)
  }

  func testDeclarationsAreCollectedThroughStacksFirstOneWinningAndCapped() throws {
    let found = try controls(#"""
    [
      { "component": "stack", "children": [
        { "component": "segmented", "stateKey": "a", "options": [
          { "value": "", "label": "All" }, { "value": "x", "label": "X" }] }
      ] },
      { "component": "segmented", "stateKey": "a", "default": "y", "options": [
        { "value": "", "label": "All" }, { "value": "y", "label": "Y" }] },
      { "component": "segmented", "stateKey": "b", "options": [
        { "value": "", "label": "All" }, { "value": "x", "label": "X" }] },
      { "component": "segmented", "stateKey": "c", "options": [
        { "value": "", "label": "All" }, { "value": "x", "label": "X" }] },
      { "component": "segmented", "stateKey": "d", "options": [
        { "value": "", "label": "All" }, { "value": "x", "label": "X" }] },
      { "component": "segmented", "stateKey": "e", "options": [
        { "value": "", "label": "All" }, { "value": "x", "label": "X" }] }
    ]
    """#)

    // First declaration wins — it is the control highest on the page, and its
    // default is the one a reader assumes is in force. Four is the ceiling.
    XCTAssertEqual(found.map(\.stateKey), ["a", "b", "c", "d"])
    XCTAssertEqual(found.first?.options.map(\.value), ["", "x"])
    XCTAssertEqual(PluginVocabState.initialState(found), ["a": "", "b": "", "c": "", "d": ""])
  }

  func testTheSignatureFollowsTheControlsAndNotTheData() throws {
    let one = try controls(#"""
    [{ "component": "segmented", "stateKey": "a", "options": [
      { "value": "", "label": "All", "badge": 4 }, { "value": "x", "label": "X" }] }]
    """#)
    // Same keys, same option values, different badges and labels: the panel
    // republished its counts, and the reader's selection must survive that.
    let counted = try controls(#"""
    [{ "component": "segmented", "stateKey": "a", "options": [
      { "value": "", "label": "Everything", "badge": 9 }, { "value": "x", "label": "X" }] }]
    """#)
    let narrowed = try controls(#"""
    [{ "component": "segmented", "stateKey": "a", "options": [
      { "value": "", "label": "All" }] }]
    """#)

    XCTAssertEqual(PluginVocabState.signature(one), PluginVocabState.signature(counted))
    XCTAssertNotEqual(PluginVocabState.signature(one), PluginVocabState.signature(narrowed))
  }

  func testNormalizingDropsUnknownKeysAndValuesTheControlNoLongerOffers() throws {
    let found = try controls(#"""
    [{ "component": "segmented", "stateKey": "a", "options": [
      { "value": "", "label": "All" }, { "value": "x", "label": "X" }] }]
    """#)

    XCTAssertEqual(PluginVocabState.normalize(["a": "x", "gone": "y"], declarations: found), ["a": "x"])
    XCTAssertEqual(PluginVocabState.normalize(["a": "vanished"], declarations: found), ["a": ""])
  }

  func testApplyingAChangeRefusesAValueTheReaderWasNeverOffered() throws {
    let found = try controls(#"""
    [{ "component": "segmented", "stateKey": "a", "options": [
      { "value": "", "label": "All" }, { "value": "x", "label": "X" }] }]
    """#)
    guard let declaration = found.first else { return XCTFail("expected one control") }

    XCTAssertEqual(PluginVocabState.apply(["a": ""], declaration: declaration, value: "x"), ["a": "x"])
    XCTAssertEqual(PluginVocabState.apply(["a": ""], declaration: declaration, value: "invented"), ["a": ""])
  }

  func testTheStateReadsBackAsRowsCarryingTheChosenOptionsLabel() throws {
    let found = try controls(#"""
    [{ "component": "segmented", "stateKey": "a", "label": "Status", "options": [
      { "value": "", "label": "All" }, { "value": "x", "label": "Running" }] }]
    """#)

    // The option's LABEL, not the raw value: a reader wants "Status: Running",
    // and "Status: x" is the machine's half of the same fact.
    XCTAssertEqual(PluginVocabState.rows(found, state: ["a": "x"]).map(\.value), ["Running"])
    XCTAssertEqual(PluginVocabState.rows(found, state: ["a": "x"]).map(\.key), ["Status"])
    XCTAssertEqual(PluginVocabState.rows(found, state: [:]).map(\.value), ["All"])
  }

  func testAnActionCanPutTheReaderBackOnADefaultFilter() throws {
    let found = try controls(#"""
    [
      { "component": "segmented", "stateKey": "a", "options": [
        { "value": "", "label": "All" }, { "value": "x", "label": "X" }] },
      { "component": "segmented", "stateKey": "b", "options": [
        { "value": "", "label": "All" }, { "value": "y", "label": "Y" }] }
    ]
    """#)
    let chosen: PluginVocabPanelState = ["a": "x", "b": "y"]

    XCTAssertEqual(PluginVocabState.reset(chosen, declarations: found, reset: .all), ["a": "", "b": ""])
    XCTAssertEqual(
      PluginVocabState.reset(chosen, declarations: found, reset: PluginInvokeStateReset(keys: ["a"])!),
      ["a": "", "b": "y"]
    )
    // A key nothing declares changes nothing.
    XCTAssertEqual(
      PluginVocabState.reset(chosen, declarations: found, reset: PluginInvokeStateReset(keys: ["zzz"])!),
      chosen
    )
    XCTAssertNil(PluginInvokeStateReset(keys: []))
  }

  func testResetStateIsReadOffTheHandlerResultInBothShapes() throws {
    func result(_ json: String) throws -> PluginInvokeResult {
      try JSONDecoder().decode(PluginInvokeResult.self, from: Data(json.utf8))
    }

    XCTAssertEqual(try result(#"{ "ok": true, "result": { "resetState": true } }"#).resetState, .all)
    XCTAssertEqual(
      try result(#"{ "ok": true, "result": { "resetState": ["a", "a", "b"] } }"#).resetState,
      .keys(["a", "b"])
    )
    // `false`, an empty list, and nothing at all all mean "the action said
    // nothing about state".
    XCTAssertNil(try result(#"{ "ok": true, "result": { "resetState": false } }"#).resetState)
    XCTAssertNil(try result(#"{ "ok": true, "result": { "resetState": [] } }"#).resetState)
    XCTAssertNil(try result(#"{ "ok": true, "result": { "message": "done" } }"#).resetState)
  }

  func testThePayloadIsOmittedForAPanelWithNoControls() {
    XCTAssertNil(PluginVocabState.payload([:]))
    XCTAssertEqual(PluginVocabState.payload(["a": "x"]), ["a": "x"])
  }

  func testABindingCarriesItsWhereAndAFilterCapsAfterItFilters() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "F", "text": "f" },
      "body": [
        {
          "component": "list",
          "bind": {
            "collection": "agents",
            "limit": 2,
            "where": [{ "field": "statusGroup", "equals": { "$state": "statusFilter" } }]
          }
        }
      ]
    }
    """#))

    guard case let .list(list) = schema.body[0], let binding = list.bind else {
      return XCTFail("expected a bound list")
    }
    XCTAssertEqual(binding.whereClauses?.count, 1)
    XCTAssertEqual(binding.limit, 2)
    // The two finished agents sit fourth and fifth: capping before filtering
    // would have searched the first two rows and found nothing.
    let matching = PluginVocabState.filter(
      binding.whereClauses, fleet, state: ["statusFilter": "finished"]
    ) { $0 }
    XCTAssertEqual(matching.prefix(2).compactMap { $0["title"] as? String }, ["bc-3ac1", "bc-0092"])
  }
}

final class PluginActionResponseTests: XCTestCase {
  private func result(_ json: String) throws -> PluginInvokeResult {
    let data = Data(json.utf8)
    return try JSONDecoder().decode(PluginInvokeResult.self, from: data)
  }

  func testOpenURLReadsBothShapesAPluginMightWrite() throws {
    let object = try result(#"{"ok":true,"result":{"openUrl":{"url":"https://cursor.com/agents"}}}"#)
    XCTAssertEqual(object.openURL?.absoluteString, "https://cursor.com/agents")

    let bare = try result(#"{"ok":true,"result":{"openUrl":"  https://cursor.com/agents  "}}"#)
    XCTAssertEqual(bare.openURL?.absoluteString, "https://cursor.com/agents")
  }

  /// The whole point of the verb having a reader: a link is the one thing a
  /// plugin returns that leaves ADE, and two of these schemes turn a link into
  /// a local-file read or a script.
  func testOpenURLOpensHTTPSAndRefusesEveryOtherScheme() {
    for refused in [
      "http://cursor.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "ade://lane/abc",
      "//cursor.com/agents",
      "cursor.com/agents",
      "",
      "   ",
    ] {
      XCTAssertNil(PluginInvokeResult.parseOpenURL(refused), "\(refused) was allowed")
    }
    XCTAssertEqual(
      PluginInvokeResult.parseOpenURL("HTTPS://cursor.com/agents")?.scheme?.lowercased(),
      "https",
      "Case is not a way in."
    )
    XCTAssertNil(PluginInvokeResult.parseOpenURL("JavaScript:alert(1)"))
  }

  func testOpenURLDropsAPayloadWearingAURL() {
    let long = "https://cursor.com/?q=" + String(repeating: "x", count: PluginInvokeResult.maxOpenURLChars)
    XCTAssertNil(PluginInvokeResult.parseOpenURL(long))
  }

  func testAResultWithNoLinkCarriesNone() throws {
    XCTAssertNil(try result(#"{"ok":true,"result":{"navigate":{"panelId":"main"}}}"#).openURL)
    XCTAssertNil(try result(#"{"ok":true,"result":{"openUrl":7}}"#).openURL)
    XCTAssertNil(try result(#"{"ok":true,"result":null}"#).openURL)
  }

  /// The refresh action rides inside `schema_json` because `plugin_panels` is a
  /// CRR with a frozen SQL shape. A row written before the key existed answers
  /// `nil`, which is the pane it always had.
  func testRefreshActionIsReadOffTheStoredSchema() {
    XCTAssertEqual(
      PluginPanelRecord.refreshAction(inSchemaJSON: #"{"v":1,"body":[],"refreshAction":"refresh-fleet"}"#),
      "refresh-fleet"
    )
    XCTAssertNil(PluginPanelRecord.refreshAction(inSchemaJSON: #"{"v":1,"body":[]}"#))
    XCTAssertNil(PluginPanelRecord.refreshAction(inSchemaJSON: #"{"v":1,"refreshAction":""}"#))
    XCTAssertNil(PluginPanelRecord.refreshAction(inSchemaJSON: #"{"v":1,"refreshAction":7}"#))
    XCTAssertNil(PluginPanelRecord.refreshAction(inSchemaJSON: "not json"))
    XCTAssertNil(PluginPanelRecord.refreshAction(inSchemaJSON: "[1,2]"))
  }
}
