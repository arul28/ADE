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

  func testAvatarParsesAndFallsABlankName() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [
        { "component": "avatar", "name": "Jane Doe", "src": "https://example.test/j.png", "size": "lg" },
        { "component": "avatar" },
        { "component": "list", "items": [{ "title": "ENG-1", "avatar": { "name": "Linear" } }] }
      ]
    }
    """#))
    guard case let .avatar(avatar) = schema.body[0] else { return XCTFail("expected an avatar node") }
    XCTAssertEqual(avatar.name, "Jane Doe")
    XCTAssertEqual(avatar.src, "https://example.test/j.png")
    XCTAssertEqual(avatar.size, .lg)
    XCTAssertTrue(PluginRenderSupport.isRenderable(schema.body[0]))
    if case .invalid = schema.body[1] {} else { XCTFail("an avatar with no name must not parse") }
    guard case let .list(list) = schema.body[2] else { return XCTFail("expected a list") }
    XCTAssertEqual(list.items?.first?.avatar?.name, "Linear")
    XCTAssertEqual(PluginVocabAvatar.initials("Jane Doe"), "JD")
    XCTAssertEqual(PluginVocabAvatar.initials("Linear"), "L")
    XCTAssertEqual(PluginVocabAvatar.initials("   "), "?")
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

  func testRedTonesFoldToDestructive() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{ "component": "badge", "text": "Broken", "tone": "danger" }]
    }
    """#))
    XCTAssertEqual(schema.body, [.badge(PluginVocabBadge(text: "Broken", tone: .destructive))])
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

  func testARowPreviewIsRowDataNotABodyNode() {
    let item = PluginPanelParser.parseListItem([
      "title": "ISS-1",
      "preview": ["title": "Login fails", "text": "Assigned to you"]
    ])
    XCTAssertEqual(item?.preview?.title, "Login fails")
    XCTAssertEqual(item?.preview?.text, "Assigned to you")
    XCTAssertNil(PluginPanelParser.parseListItem(["title": "ISS-1", "preview": "nope"])?.preview)
  }

  func testARowMarkdownIsRowDataNotABodyNode() {
    let item = PluginPanelParser.parseListItem([
      "title": "kai",
      "markdown": "The fix is in `sessionRedirect.ts`."
    ])
    XCTAssertEqual(item?.markdown, "The fix is in `sessionRedirect.ts`.")
    XCTAssertFalse(item?.markdownTruncated ?? true)
    XCTAssertNil(PluginPanelParser.parseListItem(["title": "kai", "markdown": "   "])?.markdown)
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

  /// "No restart and no Apply button" was not expressible with `form` while
  /// `submit` was required, so a settings panel had to be rebuilt out of
  /// `segmented` controls and lost the labels, help text and validation a form
  /// gives for free. Mirrors the desktop cases in `vocabulary.test.ts`.
  func testFormAppliesOnChangeWithNoSubmitAtAll() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "form",
        "fields": [{ "kind": "toggle", "id": "digest", "label": "Weekly digest" }],
        "applyOnChange": { "action": "applySettings" }
      }]
    }
    """#))
    guard case let .form(form) = schema.body[0] else { return XCTFail("expected a form") }
    XCTAssertEqual(form.applyOnChange?.action, "applySettings")
    XCTAssertNil(form.submit, "a form that applies on change draws no button")
    XCTAssertNil(form.submitLabel)
  }

  func testFormKeepsBothASubmitAndAnApplyOnChange() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "form",
        "fields": [{ "kind": "text", "id": "note", "label": "Note" }],
        "submit": { "label": "Save", "onPress": { "action": "save" } },
        "applyOnChange": { "action": "applySettings" }
      }]
    }
    """#))
    guard case let .form(form) = schema.body[0] else { return XCTFail("expected a form") }
    XCTAssertEqual(form.submit?.action, "save")
    XCTAssertEqual(form.submitLabel, "Save")
    XCTAssertEqual(form.applyOnChange?.action, "applySettings")
  }

  func testFormWithNeitherSubmitNorApplyOnChangeIsInvalid() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "form",
        "fields": [{ "kind": "text", "id": "note", "label": "Note" }]
      }]
    }
    """#))
    guard case let .invalid(name, _) = schema.body[0] else {
      return XCTFail("expected an invalid node")
    }
    XCTAssertEqual(name, "form")
  }

  func testFormWithAMalformedSubmitIsInvalidEvenWhenApplyOnChangeCouldCarryIt() throws {
    // The author asked for a button. Dropping it silently would ship a form
    // missing a control they declared.
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "T", "text": "t" },
      "body": [{
        "component": "form",
        "fields": [{ "kind": "text", "id": "note", "label": "Note" }],
        "submit": { "label": "Save" },
        "applyOnChange": { "action": "applySettings" }
      }]
    }
    """#))
    guard case let .invalid(name, _) = schema.body[0] else {
      return XCTFail("expected an invalid node")
    }
    XCTAssertEqual(name, "form")
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

  func testAnInlineThumbnailSurvivesTheSchemaAndAnOverLongSourceIsRefused() throws {
    // The drift this closes: `src` and `poster` were read at `maxValueChars`
    // (1,000) and TRUNCATED, while the contract is `maxSrcChars` (8,192) and
    // REFUSES. A `data:` thumbnail between the two drew on desktop and broke
    // here — cut at 1,000 it still begins `data:image/png`, so it passes the
    // scheme check and then decodes to nothing.
    let payload = String(repeating: "A", count: 2_000)
    let thumbnail = "data:image/png;base64,\(payload)"
    XCTAssertGreaterThan(thumbnail.count, PluginVocabLimits.maxValueChars)
    XCTAssertLessThan(thumbnail.count, PluginVocabLimits.maxSrcChars)

    let parsed = try panel(parse("""
    {"v":1,"fallback":{"title":"T","text":"B"},"body":[
      {"component":"image","src":"\(thumbnail)","alt":"Screenshot"},
      {"component":"video","src":"https://cdn.example.com/clip.mp4","poster":"\(thumbnail)"}
    ]}
    """))
    guard case let .image(image) = parsed.body[0], case let .video(video) = parsed.body[1] else {
      return XCTFail("expected an image and a video")
    }
    // Whole, and with no ellipsis: an ellipsized base64 is a broken image with
    // no error, from a payload that was fine.
    XCTAssertEqual(image.src, thumbnail)
    XCTAssertEqual(video.poster, thumbnail)

    // Over the ceiling the source is unusable rather than long, so the node
    // becomes an honest marker instead of a silent blank.
    let tooLong = "data:image/png;base64,"
      + String(repeating: "A", count: PluginVocabLimits.maxSrcChars)
    let refused = try panel(parse("""
    {"v":1,"fallback":{"title":"T","text":"B"},"body":[
      {"component":"image","src":"\(tooLong)","alt":"Screenshot"},
      {"component":"video","src":"https://cdn.example.com/clip.mp4","poster":"\(tooLong)"}
    ]}
    """))
    guard case let .invalid(name, _) = refused.body[0] else {
      return XCTFail("expected an invalid image node")
    }
    XCTAssertEqual(name, "image")
    // A refused POSTER costs the poster, never the video it belongs to.
    guard case let .video(stillPlays) = refused.body[1] else {
      return XCTFail("expected the video to survive its poster")
    }
    XCTAssertNil(stillPlays.poster)
    XCTAssertEqual(stillPlays.src, "https://cdn.example.com/clip.mp4")
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

  // MARK: - Prompt response verb

  /// The whole shape, read from the handler result rather than the envelope —
  /// the same one level down every other verb lives at.
  func testPromptDecodesWholeAndOnlyFromTheHandlerResult() throws {
    let result = try invokeResult(#"""
    { "ok": true, "result": { "prompt": {
        "id": "note", "title": "What are you working on?",
        "placeholder": "One line", "submitLabel": "Log",
        "context": { "laneId": "lane-7", "kind": "note" }
    } } }
    """#)
    let prompt = try XCTUnwrap(result.prompt)
    XCTAssertEqual(prompt.id, "note")
    XCTAssertEqual(prompt.title, "What are you working on?")
    XCTAssertEqual(prompt.placeholder, "One line")
    XCTAssertEqual(prompt.submitLabel, "Log")
    XCTAssertEqual(prompt.context?["laneId"], .string("lane-7"))
    XCTAssertTrue(result.askedForPrompt)
    XCTAssertTrue(prompt.options.isEmpty)

    let envelopeLevel = try invokeResult(#"{ "ok": true, "prompt": { "id": "note" } }"#)
    XCTAssertNil(envelopeLevel.prompt, "`prompt` beside `ok` is an envelope field no plugin writes.")
    XCTAssertFalse(envelopeLevel.askedForPrompt)
  }

  /// Closed choices turn the question into a picker. Junk is skipped, duplicate
  /// values keep the first, and extras past the select ceiling drop — the same
  /// rules a form `select` is held to, so a "link to a lane" list and a launch
  /// model's list cannot disagree about how long a flat menu may be.
  func testPromptOptionsDecodeAsAPickerSkippingJunkAndCappingTheList() throws {
    let result = try invokeResult(#"""
    { "result": { "prompt": {
        "id": "lane",
        "options": [
          { "value": "a", "label": "First" },
          { "value": "a", "label": "Dup" },
          { "value": "" },
          7,
          { "value": "b" }
        ]
    } } }
    """#)
    let prompt = try XCTUnwrap(result.prompt)
    XCTAssertEqual(prompt.options.map(\.value), ["a", "b"])
    XCTAssertEqual(prompt.options.first?.label, "First")
    XCTAssertEqual(prompt.options.last?.label, "b", "A missing label falls back to the value.")

    let empty = try invokeResult(#"{ "result": { "prompt": { "id": "lane", "options": [] } } }"#)
    XCTAssertEqual(try XCTUnwrap(empty.prompt).options, [])

    let tooMany = (0...PluginVocabLimits.maxSelectOptions).map { "{ \"value\": \"lane-\($0)\" }" }.joined(separator: ",")
    let capped = try invokeResult(#"{ "result": { "prompt": { "id": "lane", "options": [\#(tooMany)] } } }"#)
    XCTAssertEqual(try XCTUnwrap(capped.prompt).options.count, PluginVocabLimits.maxSelectOptions)
  }

  /// Title, placeholder and submit label are the tolerant half: a value that is
  /// blank, not a string, or past its ceiling DROPS and the question is still
  /// asked, because the client has the control's own label to fall back on.
  func testUnusablePromptLabelsDropWhileTheQuestionSurvives() throws {
    let longTitle = String(repeating: "t", count: PluginActionPrompt.maxTitleChars + 1)
    let longSubmit = String(repeating: "s", count: PluginActionPrompt.maxSubmitLabelChars + 1)
    let result = try invokeResult(#"""
    { "result": { "prompt": {
        "id": "note", "title": "\#(longTitle)", "placeholder": "   ",
        "submitLabel": "\#(longSubmit)"
    } } }
    """#)
    let prompt = try XCTUnwrap(result.prompt, "A bad label must never cost the plugin its question.")
    XCTAssertNil(prompt.title)
    XCTAssertNil(prompt.placeholder, "Blank after trimming is not a placeholder.")
    XCTAssertNil(prompt.submitLabel)

    // Exactly at the ceiling is kept — the refusal is past it, not at it — and
    // a non-string is simply absent rather than an error.
    let atCeiling = String(repeating: "t", count: PluginActionPrompt.maxTitleChars)
    let kept = try invokeResult(#"""
    { "result": { "prompt": { "id": "note", "title": "\#(atCeiling)", "placeholder": 7 } } }
    """#)
    XCTAssertEqual(kept.prompt?.title, atCeiling)
    XCTAssertNil(kept.prompt?.placeholder)
  }

  /// `id` is the one field the question cannot be asked without: the answer
  /// would come back unattributable, and a handler that asks two things across
  /// its branches could not tell which was answered.
  ///
  /// `askedForPrompt` stays true throughout, which is the point of keeping it —
  /// a refused question is a line the client can say out loud rather than a
  /// button that silently does nothing.
  func testAPromptWithNoUsableIdIsRefusedOutright() throws {
    let overLong = String(repeating: "n", count: 65)
    for request in [
      #"{}"#,
      #"{ "id": "" }"#,
      #"{ "id": "  " }"#,
      #"{ "id": "two words" }"#,
      #"{ "id": "-leading-dash" }"#,
      #"{ "id": "note/slash" }"#,
      #"{ "id": 7 }"#,
      #"{ "id": null }"#,
      #"{ "id": "\#(overLong)" }"#,
    ] {
      let result = try invokeResult(#"{ "result": { "prompt": \#(request) } }"#)
      XCTAssertNil(result.prompt, "\(request) is not a question ADE can attribute an answer to.")
      XCTAssertTrue(result.askedForPrompt, "\(request) still asked something, however malformed.")
    }
  }

  /// The pointer is bounded like a navigation's context and drops the same way:
  /// over the ceiling the plugin loses the pointer, never the question.
  func testAnOverCeilingPromptContextDropsThePointerNotTheQuestion() throws {
    let huge = String(repeating: "x", count: PluginPanelContext.maxBytes)
    let result = try invokeResult(#"""
    { "result": { "prompt": { "id": "note", "context": { "blob": "\#(huge)" } } } }
    """#)
    let prompt = try XCTUnwrap(result.prompt)
    XCTAssertNil(prompt.context)
    XCTAssertNil(prompt.answerPayload(text: "hi")?["context"], "A dropped pointer is not handed back.")
  }

  /// The answer is refused, never truncated, and measured in BYTES: a line of
  /// emoji is four times its own character count on this wire.
  func testThePromptAnswerIsRefusedByBytesRatherThanTruncated() throws {
    let prompt = PluginActionPrompt(id: "note", context: ["laneId": .string("lane-7")])

    let atCeiling = String(repeating: "x", count: PluginActionPrompt.maxTextBytes)
    let answer = try XCTUnwrap(prompt.answerPayload(text: atCeiling))
    XCTAssertEqual(answer["id"] as? String, "note")
    XCTAssertEqual(answer["text"] as? String, atCeiling)
    XCTAssertEqual(
      (answer["context"] as? [String: Any])?["laneId"] as? String,
      "lane-7",
      "The prompt's own context rides back verbatim."
    )

    XCTAssertNil(prompt.answerPayload(text: atCeiling + "x"))
    XCTAssertFalse(PluginActionPrompt.acceptsAnswer(atCeiling + "x"))

    // 1024 four-byte scalars are 4096 bytes and 1024 characters: a character
    // ceiling would accept four times too much.
    let emoji = String(repeating: "🙂", count: PluginActionPrompt.maxTextBytes / 4)
    XCTAssertTrue(PluginActionPrompt.acceptsAnswer(emoji))
    XCTAssertFalse(PluginActionPrompt.acceptsAnswer(emoji + "🙂"))
    XCTAssertNil(prompt.answerPayload(text: emoji + "🙂"))

    // An empty answer is a real answer — the reader submitted nothing on
    // purpose — and a prompt with no context sends none.
    let contextless = PluginActionPrompt(id: "note")
    let empty = try XCTUnwrap(contextless.answerPayload(text: ""))
    XCTAssertEqual(empty["text"] as? String, "")
    XCTAssertNil(empty["context"])
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

  /// `error` / `danger` / `failed` / `red` fold onto `destructive`, the same
  /// house rule every other surface uses. `warning` stays amber.
  func testActivityEntryToneFoldsRedOntoDestructive() throws {
    for spelling in ["error", "danger", "failed", "red"] {
      let entry = try XCTUnwrap(contribution(
        socket: "activity-entry",
        payloadJSON: #"{ "title": "T", "tone": "\#(spelling)" }"#,
        entityId: "app"
      ))
      XCTAssertEqual(entry.activityEntry?.tone, .destructive, "\(spelling) must fold to destructive")
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

  /// A manifest badge RESERVES THE SLOT AND DRAWS NOTHING, which is bug B4 in
  /// the dogfood ledger: a badge is a value ABOUT one entity, and a manifest
  /// cannot know one. The journal plugin declared `label: "0"` and every lane in
  /// the list wore a `0` chip forever, because there is no label that reads
  /// acceptably as "nothing to say about this row yet".
  ///
  /// The declaration is still built and still matched against — that is what
  /// ``testAPublishedRowReplacesTheDeclarationItFillsForThatEntityOnly`` covers.
  /// Only the drawing stops.
  func testAPerEntityDeclarationDrawsNothingUntilAPublishedRowFillsIt() {
    let index = PluginContributionIndex(
      contributions: [],
      declarations: PluginSocketDeclarations(records: [
        installRecord(sockets: [
          PluginManifestSocketWire(socket: "row-badge", surface: "lanes", id: "risk", label: "Risk"),
        ]),
      ])
    )
    for laneId in ["lane-1", "lane-2", "lane-3"] {
      XCTAssertTrue(
        index.badges(.lane, laneId).isEmpty,
        "no lane wears a chip the manifest invented"
      )
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

    // B4: the declaration reserves lane-2's slot but draws nothing in it, so the
    // lane the plugin has said nothing about yet stays bare rather than wearing
    // the manifest's placeholder label.
    XCTAssertTrue(
      index.badges(.lane, "lane-2").isEmpty,
      "Another lane shows nothing until its own row is published."
    )
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
    // The row drops because it cannot be matched, and the two declarations draw
    // nothing of their own under B4 — so the lane ends up bare. What this test
    // holds is that the ambiguous row is NOT guessed onto one of the two.
    XCTAssertTrue(
      index.badges(.lane, "lane-1").isEmpty,
      "The unresolvable row drops rather than being guessed onto a declaration."
    )
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

    XCTAssertTrue(
      index.badges(.pr, "916").isEmpty,
      "The unresolvable row drops; the two declarations draw nothing of their own."
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
      // `row-badge` is the ONE deliberate `return nil` this guard must tolerate,
      // and it is written down here so it cannot be confused with the silent
      // drop the test exists to catch. Dogfood bug B4: a badge is a value ABOUT
      // one entity and a manifest cannot know one, so a manifest badge reserves
      // the slot and draws nothing. Its declaration is still built and still
      // matched against a published row — only the drawing stops. Every other
      // `ios: true` kind must still resolve exactly one contribution.
      let expected = entry.kind == "row-badge" ? 0 : 1
      XCTAssertEqual(
        resolved,
        expected,
        """
        `\(entry.kind)` is ios: true in PLUGIN_SOCKET_CLIENT_SUPPORT but resolved \
        \(resolved) contributions from a minimal declaration, not \(expected). \
        Either its arm in PluginSocketDeclarations.payload(for:wire:) regressed, \
        or the parity table now claims a kind this client does not render.
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

  /// The BRAND half of the same shared list, held separately because it is a
  /// different kind of token: these resolve to a bundled vendor logo, not to a
  /// glyph, so every assertion about "this names a real SF Symbol" is false of
  /// them while they are perfectly correct.
  ///
  /// Kept just as literal as the list above, and for the same reason. Closed-set
  /// brand tokens only belong here when BOTH clients already ship that vendor's
  /// mark. A plugin that needs Linear's mark ships a sanitized SVG through
  /// `brandIcons` rather than waiting for a new ADE release.
  private static let desktopBrandTokens = [
    "brand:claude",
    "brand:codex",
    "brand:cursor",
    "brand:github",
    "brand:openai",
  ]

  /// Linear-style priority histogram. Custom SwiftUI on the phone, custom SVG
  /// on desktop — neither is an SF Symbol, so they are not in
  /// ``desktopIconTokens``.
  private static let desktopPriorityTokens = [
    "priority-urgent",
    "priority-high",
    "priority-medium",
    "priority-low",
    "priority-none",
  ]

  func testEveryDesktopIconTokenDrawsSomethingOnThePhone() {
    for token in Self.desktopIconTokens {
      XCTAssertNotNil(
        PluginSymbol.symbol(token),
        "`\(token)` is offered to manifest authors on desktop but falls back to the puzzle piece here."
      )
    }
  }

  func testEveryDesktopPriorityTokenDrawsSomethingOnThePhone() {
    for token in Self.desktopPriorityTokens {
      XCTAssertTrue(
        PluginSymbol.drawsIcon(token),
        "`\(token)` is offered to manifest authors on desktop but draws nothing here."
      )
      XCTAssertNil(
        PluginSymbol.symbol(token),
        "`\(token)` must stay a custom mark, not an SF Symbol that cannot tell High from Low."
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
      .union(Self.desktopBrandTokens)
      .union(Self.desktopPriorityTokens)
    for token in PluginSymbol.tokenNames {
      XCTAssertTrue(
        desktop.contains(token),
        "`\(token)` draws on the phone and is not in desktop's map — one manifest, two pictures."
      )
    }
    // Same count both ways, so neither list can drift by an entry the loops
    // above happen not to reach. `tokenNames` spans every kind, so the desktop
    // side is counted the same way.
    XCTAssertEqual(
      PluginSymbol.tokenNames.count,
      Self.desktopIconTokens.count + Self.desktopBrandTokens.count + Self.desktopPriorityTokens.count
    )
  }

  /// The brand half of the parity walk, in the desktop → phone direction.
  func testEveryDesktopBrandTokenDrawsSomethingOnThePhone() {
    for token in Self.desktopBrandTokens {
      XCTAssertNotNil(
        PluginSymbol.brandAsset(token),
        "`\(token)` is offered to manifest authors on desktop but falls back to the puzzle piece here."
      )
    }
    XCTAssertEqual(PluginSymbol.brandTokenNames, Self.desktopBrandTokens.sorted())
  }

  /// Every symbol the map names has to exist in THIS build's SF Symbols
  /// catalogue. A typo or a symbol added in a later OS resolves to nil at
  /// runtime and draws an empty box beside a label, which looks like the
  /// plugin's fault.
  func testEveryMappedSymbolResolvesOnThisOS() {
    // Walked over the SYMBOL half only. Not a weakening: a brand token has no SF
    // Symbol by construction, so asking `exists` about it would assert something
    // false about a correct entry. The brand half gets the equivalent check
    // against the asset catalogue in the test below, and
    // `testThePhoneDrawsNoTokenDesktopHasNeverHeardOf` proves the two halves
    // together account for every token this build maps — so no token can slip
    // between them unchecked.
    for token in PluginSymbol.symbolTokenNames {
      let symbol = PluginSymbol.symbol(token)
      XCTAssertNotNil(symbol, "`\(token)` maps to nothing.")
      if let symbol {
        XCTAssertTrue(
          PluginSymbol.exists(symbol),
          "`\(token)` maps to `\(symbol)`, which this OS does not have."
        )
      }
    }
    XCTAssertEqual(
      Set(PluginSymbol.symbolTokenNames)
        .union(PluginSymbol.brandTokenNames)
        .union(PluginSymbol.priorityTokenNames),
      Set(PluginSymbol.tokenNames),
      "Every token must be covered by exactly one of the kind-specific walks."
    )
  }

  /// The brand half's equivalent, and the failure it catches is the same one:
  /// a map entry naming an imageset nobody added draws an empty box beside a
  /// label, which reads as the plugin's fault rather than the app's.
  func testEveryBrandTokenNamesAnAssetThisBundleShips() {
    for token in PluginSymbol.brandTokenNames {
      let asset = PluginSymbol.brandAsset(token)
      XCTAssertNotNil(asset, "`\(token)` maps to nothing.")
      if let asset {
        XCTAssertTrue(
          PluginSymbol.assetExists(asset),
          "`\(token)` maps to `\(asset)`, which is not in this bundle's asset catalogue."
        )
      }
    }
  }

  /// The five brand tokens and the mark each one draws, pinned by name.
  ///
  /// Pinned rather than merely counted because the mapping is the whole product
  /// claim: `brand:cursor` on `ade-cursor-cloud` is what puts the real Cursor
  /// mark in the entry menu, the pane header and the chat header instead of the
  /// generic cloud the token list could otherwise offer.
  func testBrandTokensResolveToTheProviderMarksTheAppAlreadyShips() {
    XCTAssertEqual(PluginSymbol.brandAsset("brand:cursor"), "ProviderCursor")
    XCTAssertEqual(PluginSymbol.brandAsset("brand:claude"), "ProviderClaude")
    XCTAssertEqual(PluginSymbol.brandAsset("brand:codex"), "ProviderCodex")
    XCTAssertEqual(PluginSymbol.brandAsset("brand:openai"), "ProviderOpenAI")
    XCTAssertEqual(PluginSymbol.brandAsset("brand:github"), "ProviderGitHub")

    // Case and stray whitespace are the author's, not a different icon — the
    // same normalisation the symbol half applies.
    XCTAssertEqual(PluginSymbol.brandAsset("  Brand:Cursor "), "ProviderCursor")

    // A brand token is an image, so the symbol lookup must keep saying no: a
    // caller that reaches for `systemImage:` gets the honest puzzle piece rather
    // than an asset name handed to `UIImage(systemName:)`, which draws nothing.
    XCTAssertNil(PluginSymbol.symbol("brand:cursor"))
    XCTAssertEqual(
      PluginSymbol.resolve("brand:cursor", fallback: "puzzlepiece.extension"),
      "puzzlepiece.extension"
    )
    XCTAssertTrue(PluginSymbol.drawsIcon("brand:cursor"))
  }

  /// An unknown brand token is exactly as unknown as any other unknown token.
  ///
  /// The `brand:` prefix buys no leniency and there is no "strip the prefix and
  /// try the asset catalogue" branch. Such a branch would let a manifest name
  /// any imageset this app happens to bundle — rendering here, puzzling on
  /// desktop — which is precisely the asymmetry the removed
  /// `UIImage(systemName:)` passthrough created.
  func testAnUnknownBrandTokenDegradesToThePuzzlePieceLikeAnyOther() {
    XCTAssertNil(PluginSymbol.brandAsset("brand:nope"))
    XCTAssertNil(PluginSymbol.symbol("brand:nope"))
    XCTAssertFalse(PluginSymbol.drawsIcon("brand:nope"))
    XCTAssertEqual(
      PluginSymbol.resolve("brand:nope", fallback: "puzzlepiece.extension"),
      "puzzlepiece.extension"
    )

    // A plugin-shipped glyph is what makes `brand:linear` draw. Without one it
    // is still an unknown token, the same as `brand:nope`.
    XCTAssertNil(PluginSymbol.brandAsset("brand:linear"))
    XCTAssertFalse(PluginSymbol.drawsIcon("brand:linear"))
    let linear = PluginBrandGlyph.parse([
      "viewBox": "0 0 24 24",
      "paths": [["d": "M0 0 L24 24", "evenodd": true]],
    ])
    XCTAssertNotNil(linear)
    XCTAssertTrue(PluginSymbol.drawsIcon("brand:linear", shipped: ["linear": linear!]))

    // A raw asset name is not an icon, prefixed or not — the asset-catalogue
    // twin of `testARawSystemSymbolNameIsNotAnIcon`.
    XCTAssertNil(PluginSymbol.brandAsset("ProviderCursor"))
    XCTAssertNil(PluginSymbol.brandAsset("brand:ProviderDroid"))
    XCTAssertFalse(PluginSymbol.drawsIcon("ProviderCursor"))

    // And the bare vendor name without the namespace stays an ordinary unknown
    // token, so `brand:` remains the only way to ask for a logo.
    XCTAssertNil(PluginSymbol.symbol("cursor"))
    XCTAssertNil(PluginSymbol.brandAsset("cursor"))
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

  func testContainsIsItsOwnClauseAndMatchesCaseInsensitively() {
    let (parsed, warnings) = predicates(#"""
    [
      { "field": "title", "contains": "bc-" },
      { "field": "title", "contains": { "$state": "q" } }
    ]
    """#)
    XCTAssertEqual(warnings, [])
    XCTAssertEqual(parsed?.count, 2)
    if case let .contains(field, needle, stateKey)? = parsed?[0] {
      XCTAssertEqual(field, "title")
      XCTAssertEqual(needle, "bc-")
      XCTAssertNil(stateKey)
    } else {
      XCTFail("expected a literal contains clause")
    }
    if case let .contains(field, needle, stateKey)? = parsed?[1] {
      XCTAssertEqual(field, "title")
      XCTAssertNil(needle)
      XCTAssertEqual(stateKey, "q")
    } else {
      XCTFail("expected a $state contains clause")
    }

    let (empty, _) = predicates(#"[{ "field": "title", "contains": "" }]"#)
    XCTAssertNil(empty)
    let (both, bothWarnings) = predicates(#"[{ "field": "title", "contains": "a", "equals": "b" }]"#)
    XCTAssertNil(both)
    XCTAssertEqual(bothWarnings.map(\.code), [.invalidBinding])

    XCTAssertEqual(kept(#"[{ "field": "title", "contains": "BC-77" }]"#), ["bc-77b2"])
    XCTAssertEqual(kept(#"[{ "field": "title", "contains": { "$state": "q" } }]"#, state: ["q": "1f4A"]), ["bc-1f4a"])
    XCTAssertEqual(kept(#"[{ "field": "title", "contains": { "$state": "q" } }]"#, state: ["q": ""]).count, 5)
    XCTAssertEqual(kept(#"[{ "field": "title", "contains": { "$state": "q" } }]"#, state: ["q": "   "]).count, 5)
    XCTAssertEqual(kept(#"[{ "field": "title", "contains": { "$state": "q" } }]"#, state: [:]).count, 5)
    XCTAssertEqual(kept(#"[{ "field": "title", "contains": "" }]"#).count, 5)
    XCTAssertEqual(kept(#"[{ "field": "missing", "contains": "bc" }]"#), [])
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
        { "value": "", "label": "All" }, { "value": "x", "label": "X" }] },
      { "component": "segmented", "stateKey": "f", "options": [
        { "value": "", "label": "All" }, { "value": "x", "label": "X" }] },
      { "component": "segmented", "stateKey": "g", "options": [
        { "value": "", "label": "All" }, { "value": "x", "label": "X" }] },
      { "component": "segmented", "stateKey": "h", "options": [
        { "value": "", "label": "All" }, { "value": "x", "label": "X" }] },
      { "component": "segmented", "stateKey": "i", "options": [
        { "value": "", "label": "All" }, { "value": "x", "label": "X" }] }
    ]
    """#)

    // First declaration wins — it is the control highest on the page, and its
    // default is the one a reader assumes is in force. Eight is the ceiling,
    // and the ninth key declares nothing.
    XCTAssertEqual(found.map(\.stateKey), ["a", "b", "c", "d", "e", "f", "g", "h"])
    XCTAssertEqual(found.first?.options.map(\.value), ["", "x"])
    XCTAssertEqual(
      PluginVocabState.initialState(found),
      ["a": "", "b": "", "c": "", "d": "", "e": "", "f": "", "g": "", "h": ""]
    )
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

  // MARK: - Time

  /// The clock is a PARAMETER, never a `Date()` buried in the loop, so every case
  /// below pins the instant instead of sleeping. `now` is noon UTC on a Friday;
  /// the rows sit at readable distances from it. These mirror the TypeScript
  /// cases in `vocabularyState.test.ts` name for name, so a reader can diff the
  /// two lists and see a gap on either side.
  private var now: Double { 1_787_918_400_000 }  // 2026-08-28T12:00:00.000Z

  private var notes: [[String: Any]] {
    [
      ["id": "now", "ts": "2026-08-28T12:00:00.000Z"],
      ["id": "hour", "ts": "2026-08-28T11:00:00.000Z"],
      ["id": "epoch", "ts": 1_787_911_200_000],  // 2026-08-28T10:00:00.000Z
      ["id": "yesterday", "ts": "2026-08-27T09:00:00.000Z"],
      ["id": "week", "ts": "2026-08-23T09:00:00.000Z"],
      ["id": "unreadable", "ts": "yesterday"],
      ["id": "absent"],
    ]
  }

  private func keptAt(_ json: String, _ instant: Double, state: PluginVocabPanelState = [:]) -> [String] {
    let (parsed, _) = predicates(json)
    return PluginVocabState.filter(parsed, notes, state: state, now: instant) { $0 }
      .compactMap { $0["id"] as? String }
  }

  func testTheFixtureClockMatchesTheOneTheTypeScriptSuiteUses() {
    // The literal above is only readable if it really is that instant.
    XCTAssertEqual(PluginVocabState.timeValue("2026-08-28T12:00:00.000Z"), now)
    XCTAssertEqual(PluginVocabState.timeValue("2026-08-28T10:00:00.000Z"), 1_787_911_200_000)
  }

  func testReadsAnISO8601OperandEpochMillisecondsAndARelOffset() {
    let (parsed, warnings) = predicates(#"""
    [
      { "field": "ts", "since": "2026-08-28T00:00:00.000Z" },
      { "field": "ts", "before": 1756000000000 },
      { "field": "ts", "since": { "$rel": "-24h" } },
      { "field": "ts", "before": { "$rel": "+1h" } }
    ]
    """#)
    XCTAssertEqual(warnings, [])
    XCTAssertEqual(parsed?.count, 4)
    XCTAssertEqual(
      parsed?[0],
      .time(op: .since, field: "ts", at: PluginVocabState.timeValue("2026-08-28T00:00:00.000Z"), relMs: nil, stateKey: nil)
    )
    XCTAssertEqual(parsed?[1], .time(op: .before, field: "ts", at: 1_756_000_000_000, relMs: nil, stateKey: nil))
    // A `$rel` is stored as an OFFSET, resolved at evaluation against the clock.
    XCTAssertEqual(parsed?[2], .time(op: .since, field: "ts", at: nil, relMs: -86_400_000, stateKey: nil))
    // A positive offset is legal: "before +1h" is a real "due soon" filter.
    XCTAssertEqual(parsed?[3], .time(op: .before, field: "ts", at: nil, relMs: 3_600_000, stateKey: nil))

    // A bare date reads as UTC midnight on every client, which is the whole
    // reason the reader is narrower than a permissive date parser.
    let (dateOnly, _) = predicates(#"[{ "field": "ts", "since": "2026-08-28" }]"#)
    XCTAssertEqual(
      dateOnly?[0],
      .time(op: .since, field: "ts", at: PluginVocabState.timeValue("2026-08-28T00:00:00.000Z"), relMs: nil, stateKey: nil)
    )
  }

  func testResolvesARelOperandAgainstTheClockItIsHanded() {
    XCTAssertEqual(keptAt(#"[{ "field": "ts", "since": { "$rel": "-24h" } }]"#, now), ["now", "hour", "epoch"])
    XCTAssertEqual(keptAt(#"[{ "field": "ts", "since": { "$rel": "-30m" } }]"#, now), ["now"])
    XCTAssertEqual(
      keptAt(#"[{ "field": "ts", "since": { "$rel": "-7d" } }]"#, now),
      ["now", "hour", "epoch", "yesterday", "week"]
    )

    // The same clause a day later. Nothing about the rows changed; the answer
    // did — which is exactly what the plugin could not express before, and why a
    // panel left open across midnight must be re-rendered to catch up.
    let tomorrow = #"[{ "field": "ts", "since": { "$rel": "-24h" } }]"#
    // Inclusive at the boundary, so the newest note survives its own edge...
    XCTAssertEqual(keptAt(tomorrow, now + 86_400_000), ["now"])
    // ...and one millisecond later the whole day has aged out.
    XCTAssertEqual(keptAt(tomorrow, now + 86_400_001), [])
  }

  func testSamplesTheWallClockOnceWhenNoClockIsGiven() {
    let rows: [[String: Any]] = [
      ["id": "fresh", "ts": ISO8601DateFormatter().string(from: Date())],
      ["id": "stale", "ts": "2001-01-01"],
    ]
    let (parsed, _) = predicates(#"[{ "field": "ts", "since": { "$rel": "-1h" } }]"#)
    let kept = PluginVocabState.filter(parsed, rows, state: [:]) { $0 }
    XCTAssertEqual(kept.compactMap { $0["id"] as? String }, ["fresh"])
  }

  func testDropsAMalformedRelWithAWarningAndKeepsTheRestOfTheBinding() {
    let (parsed, warnings) = predicates(#"""
    [
      { "field": "ts", "since": { "$rel": "24h" } },
      { "field": "ts", "since": { "$rel": "-1w" } },
      { "field": "ts", "since": { "$rel": "-24H" } },
      { "field": "ts", "since": "28/08/2026" }
    ]
    """#)
    // No sign: "24h" is as likely to mean the last day as the next one, and
    // guessing would point the filter at the wrong half of the timeline.
    XCTAssertNil(parsed)
    XCTAssertEqual(warnings.count, 4)
    XCTAssertTrue(warnings[0].message.contains("$rel"))
    XCTAssertTrue(warnings[3].message.contains("since"))

    // A broken clause is clause-local: the binding keeps the clauses that
    // parsed, because a reader can see a filter that did nothing and cannot see
    // rows a broken filter silently removed.
    let (mixed, mixedWarnings) = predicates(#"""
    [{ "field": "ts", "since": { "$rel": "nonsense" } }, { "field": "id", "equals": "week" }]
    """#)
    XCTAssertEqual(mixed?.count, 1)
    XCTAssertEqual(mixedWarnings.count, 1)
  }

  func testDropsARowWhoseFieldIsMissingOrUnreadableAsATime() {
    // The one asymmetry worth naming: an unset `$state` is INACTIVE, but a row
    // that cannot answer the comparison is FALSE — the same thing a row with no
    // `statusGroup` has always done against an `equals`.
    XCTAssertEqual(
      keptAt(#"[{ "field": "ts", "since": "2000-01-01" }]"#, now),
      ["now", "hour", "epoch", "yesterday", "week"]
    )
    XCTAssertEqual(
      keptAt(#"[{ "field": "ts", "before": "2099-01-01" }]"#, now),
      ["now", "hour", "epoch", "yesterday", "week"]
    )
    // A zoneless date-time is unreadable on purpose: local-vs-UTC is exactly the
    // disagreement between clients this grammar exists to prevent.
    XCTAssertNil(predicates(#"[{ "field": "ts", "since": "2026-08-28T12:00:00" }]"#).0)
  }

  func testReadsSinceAsAtOrAfterAndBeforeAsStrictlyEarlier() {
    // The two partition the timeline at the same instant: every row is in
    // exactly one of them, so a pair of controls cannot double-count or lose a row.
    XCTAssertEqual(keptAt(#"[{ "field": "ts", "since": "2026-08-28T11:00:00.000Z" }]"#, now), ["now", "hour"])
    XCTAssertEqual(
      keptAt(#"[{ "field": "ts", "before": "2026-08-28T11:00:00.000Z" }]"#, now),
      ["epoch", "yesterday", "week"]
    )
  }

  func testNestsInsideAndOrAndNotLikeAnyOtherClause() {
    XCTAssertEqual(keptAt(#"""
    [{ "or": [
      { "field": "ts", "before": "2026-08-25" },
      { "and": [{ "field": "ts", "since": { "$rel": "-24h" } }, { "field": "id", "notEquals": "epoch" }] }
    ] }]
    """#, now), ["now", "hour", "week"])

    // `not` inverts an active time clause and stays inactive over an inactive one.
    XCTAssertEqual(
      keptAt(#"[{ "not": { "field": "ts", "since": { "$rel": "-24h" } } }]"#, now),
      ["yesterday", "week", "unreadable", "absent"]
    )
    XCTAssertEqual(
      keptAt(#"[{ "not": { "field": "ts", "since": { "$state": "range" } } }]"#, now, state: ["range": ""]).count,
      notes.count
    )

    // Depth is unchanged: a clause four levels down is refused like any other.
    let (deep, deepWarnings) = predicates(#"""
    [{ "and": [{ "or": [{ "and": [{ "field": "ts", "since": "2000-01-01" }] }] }] }]
    """#)
    XCTAssertNil(deep)
    XCTAssertTrue(deepWarnings.first?.message.contains("nest at most") == true)
  }

  func testFollowsASegmentedControlThatOffersRelativeRanges() {
    // The point of the whole clause: "All / Today / This week" as three option
    // values, with no field the plugin has to rewrite at midnight.
    let clause = #"[{ "field": "ts", "since": { "$state": "range" } }]"#
    XCTAssertEqual(keptAt(clause, now, state: ["range": "-24h"]), ["now", "hour", "epoch"])
    XCTAssertEqual(
      keptAt(clause, now, state: ["range": "-7d"]),
      ["now", "hour", "epoch", "yesterday", "week"]
    )
    // An absolute instant is equally legal as an option value.
    XCTAssertEqual(keptAt(clause, now, state: ["range": "2026-08-28"]), ["now", "hour", "epoch"])
    // "All", an undeclared key, and a value that reads as no time at all are
    // inactive rather than false — the house rule, unchanged.
    XCTAssertEqual(keptAt(clause, now, state: ["range": ""]).count, notes.count)
    XCTAssertEqual(keptAt(clause, now, state: [:]).count, notes.count)
    XCTAssertEqual(keptAt(clause, now, state: ["range": "sometime"]).count, notes.count)
  }

  func testSpendsTheSameBudgetAsAnyOtherComparison() {
    func children(_ clause: String) -> Int {
      let list = Array(repeating: clause, count: PluginVocabLimits.maxWhereNodes).joined(separator: ",")
      let (parsed, _) = predicates("[{ \"and\": [\(list)] }]")
      guard case let .all(clauses)? = parsed?.first else { return -1 }
      return clauses.count
    }
    // The composer is node 1, so the last child is the one over the ceiling.
    let timed = children(#"{ "field": "ts", "since": { "$rel": "-1h" } }"#)
    XCTAssertEqual(timed, PluginVocabLimits.maxWhereNodes - 1)
    XCTAssertEqual(timed, children(#"{ "field": "id", "equals": "now" }"#))

    // Two operators on one clause is still refused, and `since` is now one of them.
    let (both, bothWarnings) = predicates(#"[{ "field": "ts", "since": "2026-08-28", "equals": "x" }]"#)
    XCTAssertNil(both)
    XCTAssertTrue(bothWarnings.first?.message.contains("only one operator") == true)
  }

  func testDeclaresNoStateKeyUnlessTheOperandNamesOne() {
    // The phone has no `vocabWhereStateKeys` walker, so the same fact is pinned
    // on the parsed shape: a literal or a `$rel` carries no key at all.
    let (literal, _) = predicates(#"""
    [{ "field": "ts", "since": { "$rel": "-24h" } }, { "field": "ts", "before": "2026-08-28" }]
    """#)
    XCTAssertEqual(literal?[0], .time(op: .since, field: "ts", at: nil, relMs: -86_400_000, stateKey: nil))
    XCTAssertEqual(
      literal?[1],
      .time(op: .before, field: "ts", at: PluginVocabState.timeValue("2026-08-28"), relMs: nil, stateKey: nil)
    )

    let (stateful, _) = predicates(#"[{ "field": "ts", "since": { "$state": "range" } }]"#)
    XCTAssertEqual(stateful?[0], .time(op: .since, field: "ts", at: nil, relMs: nil, stateKey: "range"))
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

  func testOpenSettingsReadsBothShapesAndRefusesUnknownIds() throws {
    let object = try result(#"{"ok":true,"result":{"openSettings":{"entryId":"agents.provider.cursor"}}}"#)
    XCTAssertEqual(object.openSettings, "agents.provider.cursor")

    let bare = try result(#"{"ok":true,"result":{"openSettings":"agents.provider.cursor"}}"#)
    XCTAssertEqual(bare.openSettings, "agents.provider.cursor")

    XCTAssertNil(try result(#"{"ok":true,"result":{"openSettings":"billing.plans"}}"#).openSettings)
    XCTAssertNil(PluginInvokeResult.parseOpenSettings("agents.providers"))
    XCTAssertEqual(PluginInvokeResult.parseOpenSettings("secrets.secrets"), "secrets.secrets")
  }

  /// A `navigate` carrying a placement this client has no places for.
  ///
  /// `target` is desktop's field: it chooses between the plugin's tab and the
  /// Work tools rail, and the phone has neither of those two things to choose
  /// between — it presents the plugin pane sheet whatever the answer says. So
  /// the contract is that the key is IGNORED and the navigation still lands.
  ///
  /// That holds by construction here — the decoder reads a keyed container over
  /// `panelId` and `context` only — and this pins it, because the failure mode
  /// if it ever stopped holding is a phone that silently drops every navigation
  /// from a plugin written for the desktop.
  func testNavigateIgnoresAPlacementThePhoneHasNoPlacesFor() throws {
    for target in [#""tools-pane""#, #""tab""#, #""a-place-invented-later""#, "7", "null"] {
      let parsed = try result(
        #"{"ok":true,"result":{"navigate":{"panelId":"stories","target":\#(target)}}}"#
      )
      XCTAssertEqual(parsed.navigate?.panelId, "stories", "target \(target) took the navigation with it")
    }
    let withContext = try result(
      #"{"ok":true,"result":{"navigate":{"panelId":"stories","target":"tools-pane","context":{"feed":"ask"}}}}"#
    )
    XCTAssertEqual(withContext.navigate?.panelId, "stories")
    XCTAssertEqual(withContext.navigate?.context?["feed"], .string("ask"))
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

/// The pane's answer when the mirror does not have the panel.
///
/// The bug these pin: on a live pairing the phone could invoke a plugin over
/// the socket and then draw "<plugin> has not published anything to show here"
/// for a panel the machine had published, because `plugin_panels` never
/// replicated. Two halves are under test — that the pane goes and ASKS, and
/// that it only blames the plugin when the machine itself said so.
@MainActor
final class PluginPaneFallbackTests: XCTestCase {
  private enum FetchFailure: Error { case unreachable }

  /// Stands in for `SyncService`. Counts round trips, so a cached answer is
  /// distinguishable from a fresh one.
  @MainActor
  private final class FakePaneSync: PluginPaneSyncing {
    var canInvokePluginActions = true
    var canFetchPluginPanelsRemotely = true
    var pluginFallbackScope = "machine-a"

    var localPanels: [PluginPanelRecord] = []
    var localEntries: [PluginCollectionEntry] = []
    /// `nil` inside the success case models the machine answering "no such
    /// panel"; a thrown error models a machine that could not be reached.
    var panelReply: Result<PluginPanelRecord?, Error> = .success(nil)
    var collectionReply: Result<[PluginCollectionEntry], Error> = .success([])

    var panelFetchCount = 0
    var collectionFetchCount = 0

    func pluginPresenceCatalog() -> PluginPresenceCatalog { PluginPresenceCatalog() }

    func pluginPanels(pluginId: String?) -> [PluginPanelRecord] {
      guard let pluginId else { return localPanels }
      return localPanels.filter { $0.pluginId == pluginId }
    }

    func pluginCollectionEntries(
      binding: PluginVocabBinding,
      pluginId: String,
      limit: Int
    ) -> [PluginCollectionEntry] {
      localEntries.filter { $0.pluginId == pluginId && $0.collection == binding.collection }
    }

    /// Scripted answers, oldest first. An empty queue answers with a bare
    /// success, which is what every test that does not care about the reply
    /// wants.
    var invokeReplies: [PluginInvokeResult] = []
    /// Every payload the store sent, so a re-invocation can be checked against
    /// the first press rather than against a description of it.
    private(set) var invokedPayloads: [[String: Any]] = []

    func invokePluginAction(
      pluginId: String,
      actionId: String,
      payload: [String: Any]
    ) async throws -> PluginInvokeResult {
      invokedPayloads.append(payload)
      return invokeReplies.isEmpty ? PluginInvokeResult() : invokeReplies.removeFirst()
    }

    func fetchPluginPanel(pluginId: String, panelId: String) async throws -> PluginPanelRecord? {
      panelFetchCount += 1
      return try panelReply.get()
    }

    func fetchPluginCollectionEntries(
      pluginId: String,
      collection: String,
      keyPrefix: String?,
      limit: Int
    ) async throws -> [PluginCollectionEntry] {
      collectionFetchCount += 1
      return try collectionReply.get()
    }

    var supportsPluginAuthSessions = true
    /// Every set of callback parameters the store handed back, so a test can
    /// check that the phone forwarded the provider's fields untouched and named
    /// no session of its own.
    private(set) var completedAuthParams: [[String: String]] = []
    var completeAuthSessionError: Error?

    func completePluginAuthSession(params: [String: String]) async throws {
      completedAuthParams.append(params)
      if let completeAuthSessionError { throw completeAuthSessionError }
    }
  }

  private static let listSchema = #"""
  {
    "v": 1,
    "title": "Top stories",
    "fallback": { "title": "Top stories", "text": "Hacker News." },
    "body": [{ "component": "list", "bind": { "collection": "stories" } }]
  }
  """#

  private func record(
    panelId: String = "stories",
    schemaJSON: String = PluginPaneFallbackTests.listSchema
  ) -> PluginPanelRecord {
    PluginPanelRecord(
      pluginId: "hn",
      panelId: panelId,
      title: "Top stories",
      icon: "",
      surface: "work",
      schemaJSON: schemaJSON,
      vocabVersion: 1,
      updatedAt: "2026-08-28T19:26:00Z",
      mobile: PluginPanelRecord.mobileFlag(inSchemaJSON: schemaJSON),
      refreshAction: nil
    )
  }

  private func store(
    _ sync: FakePaneSync,
    cache: PluginPanelFallbackCache,
    panelId: String? = "stories"
  ) -> PluginPaneStore {
    PluginPaneStore(
      pluginId: "hn",
      panelId: panelId,
      sync: sync,
      fetchesMissingRows: true,
      fallbackCache: cache,
      openExternalURL: { _ in }
    )
  }

  /// The live read is deliberately detached so presenting never waits on a
  /// socket, so a test has to let it land. Bounded rather than slept on.
  private func settle(_ store: PluginPaneStore) async {
    for _ in 0..<200 {
      guard case .notReceived(.fetching) = store.presentation else { return }
      await Task.yield()
    }
  }

  // MARK: - The `{prompt}` verb, end to end

  /// Let a dispatched action land. `perform` fires a detached task, so a test
  /// has to give it a turn rather than sleep on it.
  private func settle(until reached: () -> Bool) async {
    for _ in 0..<200 {
      if reached() { return }
      await Task.yield()
    }
  }

  /// A `{prompt}` asks once, re-invokes the SAME action with the SAME arguments
  /// plus the answer, and is not re-askable by its own reply.
  ///
  /// The one-hop rule is the security-shaped half: without it a plugin could
  /// answer every re-invocation with another question and hold the reader in an
  /// alert they cannot dismiss.
  func testAPromptReInvokesTheSameActionOnceAndOnlyOnce() async {
    let sync = FakePaneSync()
    sync.invokeReplies = [
      PluginInvokeResult(prompt: PluginActionPrompt(
        id: "note",
        title: "What are you working on?",
        submitLabel: "Log",
        context: ["laneId": .string("lane-7")]
      )),
      // The re-invocation asks again. Every client ignores it.
      PluginInvokeResult(message: "Logged", prompt: PluginActionPrompt(id: "note")),
    ]
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.perform(PluginVocabAction(action: "journal.log"), extraArgs: ["kind": "note"], label: "Log it")
    await settle(until: { pane.pendingPrompt != nil })

    guard let pending = pane.pendingPrompt else { return XCTFail("The question must reach the pane.") }
    XCTAssertEqual(pending.pending.title, "What are you working on?")
    XCTAssertEqual(pending.pending.submitLabel, "Log")
    XCTAssertEqual(sync.invokedPayloads.count, 1, "Asking must not invoke anything on its own.")
    XCTAssertNil(sync.invokedPayloads.first?["prompt"], "The first press carries no answer.")

    pane.submitPrompt(pending, text: "Shipping the prompt verb")
    await settle(until: { sync.invokedPayloads.count == 2 })

    XCTAssertEqual(sync.invokedPayloads.count, 2)
    let second = sync.invokedPayloads[1]
    XCTAssertEqual(second["kind"] as? String, "note", "The same arguments ride the re-invocation.")
    let answer = second["prompt"] as? [String: Any]
    XCTAssertEqual(answer?["id"] as? String, "note")
    XCTAssertEqual(answer?["text"] as? String, "Shipping the prompt verb")
    XCTAssertEqual(
      (answer?["context"] as? [String: Any])?["laneId"] as? String,
      "lane-7",
      "The prompt's own pointer comes back untouched."
    )

    // One hop: the re-invocation's own question is ignored, and the reply's
    // sentence is what the reader is left with.
    XCTAssertNil(pane.pendingPrompt, "A plugin must not be able to keep the alert on screen.")
    XCTAssertEqual(pane.actionMessage?.text, "Logged")
  }

  /// Cancelling invokes nothing at all — the action already ran once and said
  /// what it wanted.
  func testCancellingAPromptInvokesNothing() async {
    let sync = FakePaneSync()
    sync.invokeReplies = [PluginInvokeResult(prompt: PluginActionPrompt(id: "note"))]
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.perform(PluginVocabAction(action: "journal.log"), label: "Log it")
    await settle(until: { pane.pendingPrompt != nil })
    XCTAssertEqual(pane.pendingPrompt?.pending.title, "Log it", "No title falls back to the control's label.")

    pane.cancelPrompt()
    await settle(until: { sync.invokedPayloads.count > 1 })
    XCTAssertEqual(sync.invokedPayloads.count, 1)
    XCTAssertNil(pane.pendingPrompt)
  }

  // MARK: - The mirror stays the primary source

  func testALocalRowRendersAndNothingIsAskedOfTheMachine() async {
    let sync = FakePaneSync()
    sync.localPanels = [record()]
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    await settle(pane)

    guard case .panel = pane.presentation else {
      return XCTFail("A replicated row must render on its own, got \(pane.presentation)")
    }
    XCTAssertEqual(sync.panelFetchCount, 0, "The mirror answered; the socket must not be touched.")
  }

  /// The CRR row is the writer's, the cache is a read-through copy. When sync
  /// finally delivers the row, it has to take the pane back over.
  func testAReplicatedRowArrivingLaterWinsOverTheCachedFetch() async {
    let sync = FakePaneSync()
    let cache = PluginPanelFallbackCache()
    sync.panelReply = .success(record(schemaJSON: #"{"v":1,"fallback":{"title":"T","text":"t"},"body":[{"component":"text","text":"fetched"}]}"#))
    let pane = store(sync, cache: cache)
    pane.load()
    await settle(pane)
    XCTAssertEqual(sync.panelFetchCount, 1)

    sync.localPanels = [record(schemaJSON: #"{"v":1,"fallback":{"title":"T","text":"t"},"body":[{"component":"text","text":"replicated"}]}"#)]
    pane.load()
    await settle(pane)

    guard case let .panel(schema) = pane.presentation,
          let node = schema.body.first,
          case let .text(text) = node else {
      return XCTFail("expected a panel, got \(pane.presentation)")
    }
    XCTAssertEqual(text.text, "replicated", "The CRR row is the writer's; the cache is only a read-through copy.")
  }

  // MARK: - The fallback

  func testAMissingRowIsFetchedAndTheNextOpenIsFree() async {
    let sync = FakePaneSync()
    let cache = PluginPanelFallbackCache()
    sync.panelReply = .success(record())

    let first = store(sync, cache: cache)
    first.load()
    await settle(first)

    guard case .panel = first.presentation else {
      return XCTFail("A panel the machine has must render, got \(first.presentation)")
    }
    XCTAssertEqual(first.panels.map(\.panelId), ["stories"])
    XCTAssertEqual(sync.panelFetchCount, 1)

    // A second present builds a new store; the cache is what makes it instant,
    // and it is in memory rather than in the CRR tables on purpose.
    let second = store(sync, cache: cache)
    second.load()
    await settle(second)

    guard case .panel = second.presentation else {
      return XCTFail("expected the cached panel, got \(second.presentation)")
    }
    XCTAssertEqual(sync.panelFetchCount, 1, "The second open must not repeat the round trip.")
  }

  /// The whole point of the split: a phone that could not ask has no business
  /// telling a user the plugin published nothing.
  func testAFailedReadSaysTheReplicaIsBehindRatherThanBlamingThePlugin() async {
    let sync = FakePaneSync()
    sync.panelReply = .failure(FetchFailure.unreachable)
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    await settle(pane)

    XCTAssertEqual(pane.presentation, .notReceived(.unavailable))
    XCTAssertNotEqual(pane.presentation, .missing, "A dropped socket is not a claim about the plugin.")
    XCTAssertEqual(sync.panelFetchCount, 1)
  }

  func testAHostThatCannotBeAskedLandsInTheSameStateWithoutAsking() async {
    let sync = FakePaneSync()
    sync.canFetchPluginPanelsRemotely = false
    sync.panelReply = .success(record())
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    await settle(pane)

    XCTAssertEqual(pane.presentation, .notReceived(.unavailable))
    XCTAssertEqual(sync.panelFetchCount, 0, "An unadvertised action must not be attempted.")
  }

  /// A failure is never cached, so the gesture the empty state offers can
  /// actually change the answer.
  func testTryAgainRepeatsTheReadAndCanSucceed() async {
    let sync = FakePaneSync()
    sync.panelReply = .failure(FetchFailure.unreachable)
    let pane = store(sync, cache: PluginPanelFallbackCache())
    pane.load()
    await settle(pane)
    XCTAssertEqual(pane.presentation, .notReceived(.unavailable))

    sync.panelReply = .success(record())
    pane.retryFetch()
    await settle(pane)

    guard case .panel = pane.presentation else {
      return XCTFail("expected the retried read to render, got \(pane.presentation)")
    }
    XCTAssertEqual(sync.panelFetchCount, 2)
  }

  func testOnlyTheMachineSayingNoSuchPanelEarnsThePublishedNothingCopy() async {
    let sync = FakePaneSync()
    sync.panelReply = .success(nil)
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    await settle(pane)

    XCTAssertEqual(pane.presentation, .missing)
    XCTAssertEqual(sync.panelFetchCount, 1)
    // And the answer is not asked for twice: it is a real answer, so it caches.
    pane.load()
    await settle(pane)
    XCTAssertEqual(sync.panelFetchCount, 1)
  }

  // MARK: - The mobile flag, on the fetched path

  /// Back-compat contract, and it has to hold identically however the row
  /// arrived: a schema with no `mobile` key is a panel the phone shows.
  func testAFetchedPanelWithNoMobileKeyIsShown() async {
    let sync = FakePaneSync()
    let schema: [String: Any] = [
      "v": 1,
      "fallback": ["title": "T", "text": "t"] as [String: Any],
      "body": [["component": "text", "text": "hi"] as [String: Any]],
    ]
    let payload: [String: Any] = [
      "pluginId": "hn",
      "panelId": "stories",
      "title": "Top stories",
      "schema": schema,
      "vocabVersion": 1,
      "updatedAt": "2026-08-28T19:26:00Z",
    ]
    let fetched = PluginPanelRecord.remote(payload: payload, pluginId: "hn", panelId: "stories")
    XCTAssertEqual(fetched?.mobile, true)
    sync.panelReply = .success(fetched)
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    await settle(pane)

    guard case .panel = pane.presentation else {
      return XCTFail("A panel with no mobile key is a panel the phone shows, got \(pane.presentation)")
    }
  }

  /// The mirror path filters `mobile == false` out before the pane ever sees
  /// it. The fetched path has to do the same, or a desktop-only panel would
  /// appear on the phone only when sync was broken.
  func testAFetchedDesktopOnlyPanelIsTreatedTheWayTheMirrorTreatsOne() async {
    let sync = FakePaneSync()
    let schema = #"{"v":1,"mobile":false,"fallback":{"title":"T","text":"t"},"body":[{"component":"text","text":"hi"}]}"#
    sync.panelReply = .success(record(schemaJSON: schema))
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    await settle(pane)

    XCTAssertEqual(pane.presentation, .missing, "Desktop-only is the machine's own answer about this phone.")
    XCTAssertTrue(pane.panels.isEmpty)
    // Asked once and never again: the machine already answered.
    pane.load()
    await settle(pane)
    XCTAssertEqual(sync.panelFetchCount, 1)
  }

  // MARK: - Bound collections

  /// The sync bug drops `plugin_panels` and `plugin_collections` together, so a
  /// fetched panel whose list stayed empty would still be a blank pane.
  func testABoundListWithNoMirrorRowsIsFilledFromTheMachine() async {
    let sync = FakePaneSync()
    sync.localPanels = [record()]
    sync.collectionReply = .success([
      PluginCollectionEntry(
        pluginId: "hn",
        collection: "stories",
        key: "1",
        valueJSON: #"{"title":"Show HN: a thing"}"#,
        updatedAt: ""
      ),
    ])
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    // The read is detached and the rows land on a later pass, so wait for the
    // redraw rather than for the call.
    for _ in 0..<200 {
      if boundItems(of: pane)?.isEmpty == false { break }
      await Task.yield()
    }

    XCTAssertEqual(boundItems(of: pane)?.count, 1)
    XCTAssertEqual(boundItems(of: pane)?.first?.title, "Show HN: a thing")
    XCTAssertEqual(sync.collectionFetchCount, 1)
  }

  /// The rows of the pane's first node, when it is a list that resolved.
  private func boundItems(of pane: PluginPaneStore) -> [PluginVocabListItem]? {
    guard case let .panel(schema) = pane.presentation,
          let node = schema.body.first,
          case let .list(list) = node else {
      return nil
    }
    return list.items
  }

  /// The mirror draws first and the machine is still asked.
  ///
  /// The pane used to live-read ONLY when the mirror was entirely empty, so one
  /// replicated row made the mirror authoritative for ever and a collection
  /// mid-replication rendered as a complete list. The mirror is still what the
  /// reader sees immediately; it is no longer the last word.
  func testMirrorRowsDrawImmediatelyAndTheMachineIsStillAsked() async {
    let sync = FakePaneSync()
    sync.localPanels = [record()]
    sync.localEntries = [
      PluginCollectionEntry(
        pluginId: "hn",
        collection: "stories",
        key: "1",
        valueJSON: #"{"title":"From the mirror"}"#,
        updatedAt: "2026-08-30T10:00:00Z"
      ),
    ]
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    XCTAssertEqual(
      boundItems(of: pane)?.first?.title,
      "From the mirror",
      "Nothing waits on a socket: the replicated rows are on screen at once."
    )
    await settle(until: { sync.collectionFetchCount == 1 })
    XCTAssertEqual(sync.collectionFetchCount, 1, "A mirror that has rows can still be behind.")
  }

  /// The write-then-read the dogfood hit: a row changed on the machine, the
  /// phone already had the OLD copy mirrored, and the pane went on drawing it.
  func testANewerRowFromTheMachineReplacesTheMirrorsCopy() async {
    let sync = FakePaneSync()
    sync.localPanels = [record()]
    sync.localEntries = [
      PluginCollectionEntry(
        pluginId: "hn",
        collection: "stories",
        key: "1",
        valueJSON: #"{"title":"Open"}"#,
        updatedAt: "2026-08-30T10:00:00Z"
      ),
    ]
    sync.collectionReply = .success([
      PluginCollectionEntry(
        pluginId: "hn",
        collection: "stories",
        key: "1",
        valueJSON: #"{"title":"Reversed"}"#,
        updatedAt: "2026-08-30T11:00:00Z"
      ),
      PluginCollectionEntry(
        pluginId: "hn",
        collection: "stories",
        key: "2",
        valueJSON: #"{"title":"Only on the machine"}"#,
        updatedAt: "2026-08-30T11:05:00Z"
      ),
    ])
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    await settle(until: { (boundItems(of: pane)?.count ?? 0) == 2 })

    XCTAssertEqual(boundItems(of: pane)?.count, 2)
    XCTAssertEqual(
      boundItems(of: pane)?.first?.title,
      "Reversed",
      "The newer updatedAt wins for display; the mirror's position is kept."
    )
    XCTAssertEqual(boundItems(of: pane)?.last?.title, "Only on the machine")
    XCTAssertFalse(pane.collectionsMayBeStale, "A read that answered is not a stale list.")
  }

  /// A read that failed keeps the rows and admits it could not check them. A
  /// plausible, well-formed, silently out-of-date list is the worse failure.
  func testAFailedCollectionReadKeepsTheMirrorRowsAndMarksThemStale() async {
    let sync = FakePaneSync()
    sync.localPanels = [record()]
    sync.localEntries = [
      PluginCollectionEntry(
        pluginId: "hn",
        collection: "stories",
        key: "1",
        valueJSON: #"{"title":"From the mirror"}"#,
        updatedAt: "2026-08-30T10:00:00Z"
      ),
    ]
    sync.collectionReply = .failure(URLError(.notConnectedToInternet))
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    await settle(until: { pane.collectionsMayBeStale })

    XCTAssertTrue(pane.collectionsMayBeStale)
    XCTAssertEqual(boundItems(of: pane)?.first?.title, "From the mirror", "The rows are real; only their currency is not.")
  }

  /// An action that reached the machine may have written there, and the mirror
  /// will not carry that write until replication catches up. The pane asks
  /// again rather than answering from the copy it fetched before the action.
  func testAnActionMakesThePaneReadTheCollectionAgain() async {
    let sync = FakePaneSync()
    sync.localPanels = [record()]
    sync.collectionReply = .success([
      PluginCollectionEntry(
        pluginId: "hn",
        collection: "stories",
        key: "1",
        valueJSON: #"{"title":"Logged"}"#,
        updatedAt: "2026-08-30T10:00:00Z"
      ),
    ])
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    await settle(until: { sync.collectionFetchCount == 1 })

    pane.perform(PluginVocabAction(action: "journal.log"), label: "Log it")
    await settle(until: { sync.collectionFetchCount == 2 })
    XCTAssertEqual(sync.collectionFetchCount, 2, "A write on the machine invalidates what this pane fetched.")
  }

  /// The gesture the ledger called powerless. It re-asks now, on any pane that
  /// may ask at all — a panel with no declared refresh action included.
  func testPullToRefreshReReadsTheCollection() async {
    let sync = FakePaneSync()
    sync.localPanels = [record()]
    let pane = store(sync, cache: PluginPanelFallbackCache())

    pane.load()
    await settle(until: { sync.collectionFetchCount == 1 })
    XCTAssertTrue(pane.canRefresh, "A pane that can ask the machine has something to refresh.")

    await pane.refresh()
    await settle(until: { sync.collectionFetchCount == 2 })
    XCTAssertEqual(sync.collectionFetchCount, 2)
  }

  // MARK: - Wire shape

  /// Shape taken from the host's own reader — `readPanel` in
  /// `pluginDataStore.ts` — rather than guessed: `schema` arrives DECODED and
  /// there is no `icon` or `surface` on this wire.
  func testThePanelReplyIsReadTheWayTheHostWritesIt() throws {
    let schema: [String: Any] = [
      "v": 1,
      "mobile": true,
      "refreshAction": "openStories",
      "body": [] as [Any],
    ]
    let payload: [String: Any] = [
      "pluginId": "hn",
      "panelId": "stories",
      "title": "Top stories",
      "schema": schema,
      "vocabVersion": 1,
      "updatedAt": "2026-08-28T19:26:00Z",
    ]
    let parsed = try XCTUnwrap(PluginPanelRecord.remote(payload: payload, pluginId: "hn", panelId: "stories"))
    XCTAssertEqual(parsed.pluginId, "hn")
    XCTAssertEqual(parsed.panelId, "stories")
    XCTAssertEqual(parsed.title, "Top stories")
    XCTAssertEqual(parsed.vocabVersion, 1)
    XCTAssertEqual(parsed.updatedAt, "2026-08-28T19:26:00Z")
    XCTAssertEqual(parsed.mobile, true)
    XCTAssertEqual(parsed.refreshAction, "openStories")
    XCTAssertTrue(parsed.icon.isEmpty, "The wire carries no icon; inventing one would be a guess.")
    XCTAssertTrue(parsed.surface.isEmpty)

    // `null` for the whole reply is the machine saying it has no such panel.
    XCTAssertNil(PluginPanelRecord.remote(payload: NSNull(), pluginId: "hn", panelId: "stories"))
    XCTAssertNil(PluginPanelRecord.remote(payload: nil, pluginId: "hn", panelId: "stories"))

    // A row the host could not parse comes back with a null schema. It is still
    // a record, and an unreadable schema is what the fallback card is for.
    let corruptPayload: [String: Any] = [
      "pluginId": "hn", "panelId": "stories", "schema": NSNull(), "vocabVersion": 1,
    ]
    let corrupt = try XCTUnwrap(PluginPanelRecord.remote(payload: corruptPayload, pluginId: "hn", panelId: "stories"))
    XCTAssertEqual(corrupt.schemaJSON, "")
  }

  func testTheCollectionReplyIsReadTheWayTheHostWritesIt() throws {
    let rowPayload: [String: Any] = [
      "collection": "stories",
      "key": "1",
      "value": ["title": "A"] as [String: Any],
      "updatedAt": "2026-08-28T19:26:00Z",
    ]
    let row = try XCTUnwrap(PluginCollectionEntry.remote(payload: rowPayload, pluginId: "hn"))
    XCTAssertEqual(row.pluginId, "hn")
    XCTAssertEqual(row.collection, "stories")
    XCTAssertEqual(row.key, "1")
    XCTAssertEqual((row.value as? [String: Any])?["title"] as? String, "A")

    // A scalar value is legal — `value` is `unknown` on the wire.
    let scalarPayload: [String: Any] = ["collection": "read", "key": "1", "value": true]
    let scalar = try XCTUnwrap(PluginCollectionEntry.remote(payload: scalarPayload, pluginId: "hn"))
    XCTAssertEqual(scalar.valueJSON, "true")

    let noCollection: [String: Any] = ["key": "1"]
    let noKey: [String: Any] = ["collection": "stories"]
    let complete: [String: Any] = ["collection": "stories", "key": "1"]
    XCTAssertNil(PluginCollectionEntry.remote(payload: noCollection, pluginId: "hn"))
    XCTAssertNil(PluginCollectionEntry.remote(payload: noKey, pluginId: "hn"))
    XCTAssertNil(PluginCollectionEntry.remote(payload: complete, pluginId: ""))
  }
}

/// Groups, collection-bound options, and the row selection lifecycle.
///
/// The three capabilities the shared vocabulary gained together, held to the
/// same rule as every case above it: one schema and one set of rows must
/// produce the same visible panel on the phone, the desktop, the web client and
/// the terminal. The names follow the TypeScript suites for
/// `vocabularyNodes.ts` and `vocabularyState.ts` so the two read side by side.
final class PluginVocabGroupSelectionTests: XCTestCase {
  private func parse(_ json: String) -> PluginPanelParseResult {
    PluginPanelParser.parse(json)
  }

  private func panel(_ result: PluginPanelParseResult) throws -> PluginPanelSchema {
    guard case let .ok(schema, _) = result else {
      throw XCTSkip("Expected a parsed panel, got \(result)")
    }
    return schema
  }

  private func body(_ json: String) throws -> [PluginVocabNode] {
    try panel(parse(#"{ "v": 1, "fallback": { "title": "F", "text": "f" }, "body": \#(json) }"#)).body
  }

  // MARK: - The group node

  func testAGroupParsesAndItsChildrenCountAgainstTheNodeBudget() throws {
    let nodes = try body(#"""
    [
      {
        "component": "group",
        "title": "In progress",
        "groupKey": "state:started",
        "badge": 12,
        "defaultOpen": false,
        "children": [
          { "component": "text", "text": "one" },
          { "component": "text", "text": "two" }
        ]
      },
      { "component": "group", "children": [] }
    ]
    """#)

    guard case let .group(group) = nodes[0] else { return XCTFail("expected a group node") }
    XCTAssertEqual(group.title, "In progress")
    XCTAssertEqual(group.groupKey, "state:started")
    // A numeric badge reads as its digits, exactly as an option's does.
    XCTAssertEqual(group.badge, "12")
    XCTAssertNil(group.icon)
    XCTAssertFalse(group.defaultOpen)
    XCTAssertEqual(group.children.count, 2)
    XCTAssertEqual(group.key, "state:started")
    XCTAssertTrue(PluginRenderSupport.isRenderable(nodes[0]))
    // A disclosure with no word on it is a triangle the reader has to open to
    // find out what they opened, so the title is the one required field — and
    // node-local, so the panel keeps everything else.
    if case .invalid = nodes[1] {} else { XCTFail("a group with no title must not parse") }

    // Children are nodes and spend the panel's node budget like any other.
    let children = (0..<PluginVocabLimits.maxNodes)
      .map { _ in #"{ "component": "text", "text": "x" }"# }
      .joined(separator: ",")
    let overflowed = parse(#"""
    { "v": 1, "fallback": { "title": "F", "text": "f" },
      "body": [{ "component": "group", "title": "Big", "children": [\#(children)] }] }
    """#)
    guard case let .failed(failure, _) = overflowed else { return XCTFail("expected a panel failure") }
    XCTAssertEqual(failure, .tooManyNodes)
  }

  func testAGroupsOpenStateIsNeverPanelState() throws {
    let nodes = try body(#"""
    [
      { "component": "group", "title": "One", "defaultOpen": false, "children": [
        { "component": "text", "text": "a" }] },
      { "component": "group", "title": "Two", "children": [
        { "component": "text", "text": "b" }] }
    ]
    """#)

    // Seven collapsible sections used to cost seven `segmented` controls. A
    // group spends no state key at all, which is what leaves the whole filter
    // budget for filters — and what keeps a `where` from reading a section the
    // reader merely closed.
    XCTAssertTrue(PluginVocabState.declarations(in: nodes).isEmpty)
    XCTAssertTrue(PluginVocabState.selectionDeclarations(in: nodes).isEmpty)
    // Identity for the open/closed memory falls back to the title, never to the
    // node's position: a plugin republishing with one more group above yours has
    // not opened the section you closed.
    guard case let .group(second) = nodes[1] else { return XCTFail("expected a group node") }
    XCTAssertEqual(second.key, "Two")
    XCTAssertTrue(second.defaultOpen)
  }

  func testASegmentedInsideAGroupStillDeclaresItsStateKey() throws {
    let nodes = try body(#"""
    [
      { "component": "group", "title": "Filters", "children": [
        { "component": "stack", "children": [
          { "component": "segmented", "stateKey": "statusFilter", "options": [
            { "value": "", "label": "All" }, { "value": "active", "label": "Active" }] }
        ] },
        { "component": "list", "bind": { "collection": "issues" }, "selectable": {
          "stateKey": "batch",
          "actions": [{ "action": "issues.close", "label": "Close" }]
        } }
      ] }
    ]
    """#)

    // Every walk goes through one child accessor, so a second container cannot
    // silently swallow a control: a `segmented` in an unwalked group would
    // declare no key and a `list` in one would bind a collection nobody fetched.
    XCTAssertEqual(PluginVocabState.declarations(in: nodes).map(\.stateKey), ["statusFilter"])
    XCTAssertEqual(PluginVocabState.selectionDeclarations(in: nodes).map(\.stateKey), ["batch"])
  }

  // MARK: - Selectable rows

  func testABoundListsRowsInheritTheirCollectionKey() throws {
    // A collection row HAS a key. Making a plugin repeat it inside the value
    // just to make its rows selectable would be a second identity that can
    // disagree with the first.
    let inherited = try XCTUnwrap(PluginPanelParser.parseBoundListItem(
      ["title": "Fix the crash"],
      allowActions: nil,
      rowKey: "ADE-142"
    ))
    XCTAssertEqual(inherited.key, "ADE-142")

    // A value that names its own `key` keeps it.
    let declared = try XCTUnwrap(PluginPanelParser.parseBoundListItem(
      ["title": "Fix the crash", "key": "own"],
      allowActions: nil,
      rowKey: "ADE-142"
    ))
    XCTAssertEqual(declared.key, "own")

    // A row that inherited nothing draws no tick rather than one that would put
    // an empty string into a batch.
    let keyless = try XCTUnwrap(PluginPanelParser.parseBoundListItem(
      ["title": "Fix the crash"],
      allowActions: nil
    ))
    XCTAssertNil(keyless.key)
  }

  func testAnOverLongItemKeyIsRefusedRatherThanTruncated() throws {
    let long = String(repeating: "k", count: PluginVocabLimits.maxIdChars + 1)
    let nodes = try body(#"""
    [{ "component": "list", "items": [
      { "title": "Long", "key": "\#(long)" },
      { "title": "Fine", "key": "ok" }
    ] }]
    """#)

    guard case let .list(list) = nodes[0], let items = list.items else {
      return XCTFail("expected a list node")
    }
    // `cleanString` would append an ellipsis, which is right for a title and
    // wrong for an identity: the shortened key names no row and no plugin
    // record, and it would ride into a batch pointing at nothing. So the row
    // keeps its title and loses only its tick.
    XCTAssertEqual(items[0].title, "Long")
    XCTAssertNil(items[0].key)
    XCTAssertEqual(items[1].key, "ok")

    // The same refusal on the bound path, where the over-long identity is the
    // collection row's own key.
    let bound = try XCTUnwrap(PluginPanelParser.parseBoundListItem(
      ["title": "Long"],
      allowActions: nil,
      rowKey: long
    ))
    XCTAssertNil(bound.key)
  }

  func testASelectableWithNoUsableActionIsDropped() throws {
    let nodes = try body(#"""
    [
      { "component": "list", "items": [{ "title": "a", "key": "a" }], "selectable": {
        "stateKey": "batch", "actions": [{ "label": "No action id" }] } },
      { "component": "list", "items": [{ "title": "a", "key": "a" }], "selectable": {
        "stateKey": "batch" } },
      { "component": "list", "items": [{ "title": "a", "key": "a" }], "selectable": {
        "stateKey": "$state", "actions": [{ "action": "x", "label": "X" }] } },
      { "component": "list", "items": [{ "title": "a", "key": "a" }], "selectable": {
        "stateKey": "batch",
        "max": 4,
        "actions": [
          { "action": "a", "label": "A" }, { "action": "b", "label": "B" },
          { "action": "c", "label": "C" }, { "action": "d", "label": "D" },
          { "action": "e", "label": "E" }
        ] } }
    ]
    """#)

    func selectable(_ index: Int) -> PluginVocabSelectable? {
      guard case let .list(list) = nodes[index] else { return nil }
      return list.selectable
    }

    // A selection with no verb is a set of ticks the reader cannot spend, so it
    // is dropped whole rather than drawing checkboxes over an empty bar. The
    // list itself still renders — the `selectable` is node-local damage.
    XCTAssertNil(selectable(0))
    XCTAssertNil(selectable(1))
    XCTAssertNil(selectable(2))
    let usable = try XCTUnwrap(selectable(3))
    XCTAssertEqual(usable.stateKey, "batch")
    XCTAssertEqual(usable.max, 4)
    // A fifth verb over a selection is a menu, and the vocabulary has no menu.
    XCTAssertEqual(usable.actions.map(\.label), ["A", "B", "C", "D"])
    XCTAssertEqual(
      PluginVocabState.selectionDeclarations(in: nodes).map(\.stateKey),
      ["batch"]
    )
  }

  func testOnlyTwoListsInOnePanelMayClaimTheBar() throws {
    let nodes = try body(#"""
    [
      { "component": "list", "items": [{ "title": "a", "key": "a" }], "selectable": {
        "stateKey": "one", "actions": [{ "action": "x", "label": "X" }] } },
      { "component": "list", "items": [{ "title": "b", "key": "b" }], "selectable": {
        "stateKey": "two", "actions": [{ "action": "x", "label": "X" }] } },
      { "component": "list", "items": [{ "title": "c", "key": "c" }], "selectable": {
        "stateKey": "three", "actions": [{ "action": "x", "label": "X" }] } }
    ]
    """#)

    // The third list still draws its rows; it simply draws no ticks and no bar.
    XCTAssertEqual(PluginVocabState.selectionDeclarations(in: nodes).map(\.stateKey), ["one", "two"])
  }

  func testGroupedListsSharingASelectionKeyUnionTheirVisibleRows() {
    let selectable = PluginVocabSelectable(
      stateKey: "batch",
      actions: [PluginVocabListItemAction(action: PluginVocabAction(action: "go"), label: "Go")],
      max: 100
    )
    let started = PluginVocabBulkReport(selectable: selectable, visibleRowKeys: ["a"])
    let todo = PluginVocabBulkReport(selectable: selectable, visibleRowKeys: ["b"])
    let other = PluginVocabBulkReport(
      selectable: PluginVocabSelectable(
        stateKey: "prs",
        actions: [PluginVocabListItemAction(action: PluginVocabAction(action: "merge"), label: "Merge")],
        max: 100
      ),
      visibleRowKeys: ["pr-1"]
    )

    let unioned = PluginVocabBulk.unioned([started, todo, other])
    XCTAssertEqual(unioned.map(\.selectable.stateKey), ["batch", "prs"])
    XCTAssertEqual(unioned.first?.visibleRowKeys, ["a", "b"])
    XCTAssertEqual(unioned.last?.visibleRowKeys, ["pr-1"])
  }

  // MARK: - The selection lifecycle

  private let batch = PluginVocabSelectionDeclaration(
    stateKey: "batch",
    max: 2,
    actionIds: ["issues.close"]
  )

  func testTheCapRefusesATickRatherThanEvictingTheOldest() {
    var selection = PluginVocabState.initialSelection([batch])
    XCTAssertEqual(selection, ["batch": []])

    selection = PluginVocabState.toggleRow(selection, declaration: batch, rowKey: "a")
    selection = PluginVocabState.toggleRow(selection, declaration: batch, rowKey: "b")
    let full = selection
    // A silent eviction would take a row out of a batch the reader believes
    // they assembled, and the count on the bar is the only thing that could
    // have told them.
    selection = PluginVocabState.toggleRow(selection, declaration: batch, rowKey: "c")
    XCTAssertEqual(selection, full)
    XCTAssertEqual(selection["batch"], ["a", "b"])

    // Unticking always works, cap or no cap — and then the refused row fits.
    selection = PluginVocabState.toggleRow(selection, declaration: batch, rowKey: "a")
    XCTAssertEqual(selection["batch"], ["b"])
    selection = PluginVocabState.toggleRow(selection, declaration: batch, rowKey: "c")
    XCTAssertEqual(selection["batch"], ["b", "c"])

    // An empty key is not an identity.
    XCTAssertEqual(PluginVocabState.toggleRow(selection, declaration: batch, rowKey: ""), selection)
    XCTAssertEqual(PluginVocabState.clearSelection(selection, declaration: batch)["batch"], [])
  }

  func testTheRangeIsAUnionAndFillsToTheCap() {
    let wide = PluginVocabSelectionDeclaration(stateKey: "batch", max: 3, actionIds: ["x"])
    let rows = ["a", "b", "c", "d"]

    // "Between" has two answers when the reader drags upwards, so the slice is
    // always in draw order.
    XCTAssertEqual(PluginVocabState.rowRange(rows, anchor: "c", target: "a"), ["a", "b", "c"])
    XCTAssertEqual(PluginVocabState.rowRange(rows, anchor: "a", target: "c"), ["a", "b", "c"])
    // An anchor that is no longer on screen extends nothing: the honest reading
    // is the plain click.
    XCTAssertEqual(PluginVocabState.rowRange(rows, anchor: "gone", target: "b"), ["b"])
    XCTAssertEqual(PluginVocabState.rowRange(rows, anchor: nil, target: "b"), ["b"])
    XCTAssertEqual(PluginVocabState.rowRange(rows, anchor: "a", target: "gone"), [])

    // A union, not a replacement: a reader assembling a batch out of two
    // clusters must not lose the first one.
    var selection: PluginVocabPanelSelection = ["batch": ["d"]]
    selection = PluginVocabState.selectRange(selection, declaration: wide, rowKeys: ["a", "b"])
    XCTAssertEqual(selection["batch"], ["d", "a", "b"])
    // Full. The rows it could not take are the tail of the range the reader can
    // see, not rows it silently swapped out.
    let full = selection
    XCTAssertEqual(PluginVocabState.selectRange(selection, declaration: wide, rowKeys: ["c"]), full)
  }

  func testSelectedRowKeysReturnsOnlyTheVisibleKeysInDrawOrder() {
    let selection: PluginVocabPanelSelection = ["batch": ["c", "a", "hidden"]]

    // Acting on a row nobody can see is the one outcome a selection must never
    // produce, so a filter that hid two rows narrows the batch to what is on
    // screen — in draw order, not tick order.
    XCTAssertEqual(
      PluginVocabState.selectedRowKeys(selection, stateKey: "batch", rowKeys: ["a", "b", "c"]),
      ["a", "c"]
    )
    // The hidden key is KEPT in the stored set: moving the filter back brings it
    // and its tick with it, which a prune at filter time would not.
    XCTAssertEqual(selection["batch"], ["c", "a", "hidden"])
    XCTAssertEqual(
      PluginVocabState.selectedRowKeys(selection, stateKey: "other", rowKeys: ["a"]),
      []
    )
  }

  func testTheSelectionSignatureIgnoresRowsAndMovesOnAChangedCapOrActionList() throws {
    func lists(_ json: String) throws -> [PluginVocabSelectionDeclaration] {
      PluginVocabState.selectionDeclarations(in: try body(json))
    }

    let one = try lists(#"""
    [{ "component": "list", "items": [{ "title": "a", "key": "a" }], "selectable": {
      "stateKey": "batch", "max": 10, "actions": [{ "action": "close", "label": "Close" }] } }]
    """#)
    // Same control, entirely different rows: a plugin republishing its rows
    // every few seconds would otherwise empty a batch mid-assembly.
    let republished = try lists(#"""
    [{ "component": "list", "items": [
      { "title": "z", "key": "z" }, { "title": "y", "key": "y" }], "selectable": {
      "stateKey": "batch", "max": 10, "actions": [{ "action": "close", "label": "Close" }] } }]
    """#)
    let lowered = try lists(#"""
    [{ "component": "list", "items": [{ "title": "a", "key": "a" }], "selectable": {
      "stateKey": "batch", "max": 2, "actions": [{ "action": "close", "label": "Close" }] } }]
    """#)
    let reverbed = try lists(#"""
    [{ "component": "list", "items": [{ "title": "a", "key": "a" }], "selectable": {
      "stateKey": "batch", "max": 10, "actions": [{ "action": "archive", "label": "Close" }] } }]
    """#)

    XCTAssertEqual(
      PluginVocabState.selectionSignature(one),
      PluginVocabState.selectionSignature(republished)
    )
    XCTAssertNotEqual(
      PluginVocabState.selectionSignature(one),
      PluginVocabState.selectionSignature(lowered)
    )
    XCTAssertNotEqual(
      PluginVocabState.selectionSignature(one),
      PluginVocabState.selectionSignature(reverbed)
    )

    // Normalizing re-applies the cap a republish lowered, and drops a key the
    // new schema does not declare.
    let carried = PluginVocabState.normalizeSelection(
      ["batch": ["a", "b", "b", "c", ""], "gone": ["x"]],
      declarations: lowered
    )
    XCTAssertEqual(carried, ["batch": ["a", "b"]])
  }

  func testAnActionCanPutTheReaderBackOnAnEmptySelection() {
    let other = PluginVocabSelectionDeclaration(stateKey: "other", max: 5, actionIds: ["y"])
    let ticked: PluginVocabPanelSelection = ["batch": ["a"], "other": ["b"]]

    // One verb for both maps: a plugin answering a bulk action with
    // `{resetState}` has almost always just acted on every ticked row.
    XCTAssertEqual(
      PluginVocabState.resetSelection(ticked, declarations: [batch, other], reset: .all),
      ["batch": [], "other": []]
    )
    XCTAssertEqual(
      PluginVocabState.resetSelection(
        ticked,
        declarations: [batch, other],
        reset: PluginInvokeStateReset(keys: ["batch"])!
      ),
      ["batch": [], "other": ["b"]]
    )
    // A key nothing declares changes nothing.
    XCTAssertEqual(
      PluginVocabState.resetSelection(
        ticked,
        declarations: [batch, other],
        reset: PluginInvokeStateReset(keys: ["zzz"])!
      ),
      ticked
    )
  }

  // MARK: - Collection-bound options

  func testABoundControlIsExemptFromTheTwoOptionFloor() throws {
    let nodes = try body(#"""
    [
      {
        "component": "segmented",
        "stateKey": "project",
        "label": "Project",
        "default": "eng",
        "options": [{ "value": "", "label": "All projects" }],
        "optionsFrom": {
          "collection": "projects",
          "keyPrefix": "p:",
          "valueField": "id",
          "labelField": "name"
        }
      },
      { "component": "segmented", "stateKey": "solo", "options": [{ "value": "a", "label": "A" }] },
      {
        "component": "segmented",
        "stateKey": "broken",
        "options": [{ "value": "a", "label": "A" }],
        "optionsFrom": { "collection": "projects" }
      }
    ]
    """#)

    // A bound control's second option is a row that has not arrived yet, not an
    // author's mistake, so the floor does not apply to it.
    guard case let .segmented(bound) = nodes[0] else { return XCTFail("expected a segmented node") }
    XCTAssertEqual(bound.optionsFrom?.collection, "projects")
    XCTAssertEqual(bound.optionsFrom?.keyPrefix, "p:")
    XCTAssertEqual(bound.optionsFrom?.valueField, "id")
    XCTAssertEqual(bound.optionsFrom?.labelField, "name")
    // The author's `default` is kept VERBATIM: resolving it against the literal
    // options here would throw away a default naming a row nobody has fetched.
    XCTAssertEqual(bound.initial, "eng")

    // A control with one literal option and no binding is still a filter stuck
    // wherever the author left it.
    if case .invalid = nodes[1] {} else { XCTFail("one literal option must not parse") }
    // A binding with no `valueField` would resolve every row to the same empty
    // value, so it degrades to "this control has only its literal options" —
    // and then the floor bites.
    if case .invalid = nodes[2] {} else { XCTFail("a binding with no `valueField` is not one") }
  }

  func testBoundOptionsResolveFromTheCollectionAndDrawAfterTheLiteralOnes() throws {
    let nodes = try body(#"""
    [{
      "component": "segmented",
      "stateKey": "project",
      "default": "eng",
      "options": [{ "value": "", "label": "All projects" }],
      "optionsFrom": { "collection": "projects", "valueField": "id", "labelField": "name" }
    }]
    """#)
    guard case let .segmented(control) = nodes[0], let binding = control.optionsFrom else {
      return XCTFail("expected a bound segmented node")
    }

    let rows: [Any?] = [
      ["id": "eng", "name": "Engineering", "badge": 12],
      // A row with no readable value is dropped rather than minting a second
      // "All" sentinel, and a duplicate collapses with the first row winning.
      ["id": "", "name": "Nameless"],
      ["id": "eng", "name": "Engineering again"],
      ["id": "des"],
      "not an object",
    ]
    let resolved = PluginVocabState.resolveStateOptions(binding, rows: rows)
    XCTAssertEqual(resolved.map(\.value), ["eng", "des"])
    // A label falls back to the value; a numeric badge reads as its digits.
    XCTAssertEqual(resolved.map(\.label), ["Engineering", "des"])
    XCTAssertEqual(resolved.first?.badge, "12")

    // Literals first — that is where the "All" sentinel is written, and a reader
    // looks for it at the top.
    let declaration = control.declaration(resolved: resolved)
    XCTAssertEqual(declaration.options.map(\.value), ["", "eng", "des"])
    // The declared default is among the resolved options, so the control opens
    // on it.
    XCTAssertEqual(declaration.initial, "eng")

    // With nothing fetched yet the control is still usable, sitting on its
    // unset "All" rather than on whichever project the collection yielded first.
    let unresolved = PluginVocabState.declarations(in: nodes)
    XCTAssertEqual(unresolved.first?.options.map(\.value), [""])
    XCTAssertEqual(unresolved.first?.initial, "")
  }

  func testABoundControlsSignatureDoesNotMoveWhenItsResolvedOptionsChange() throws {
    let nodes = try body(#"""
    [{
      "component": "segmented",
      "stateKey": "project",
      "options": [{ "value": "", "label": "All projects" }],
      "optionsFrom": { "collection": "projects", "valueField": "id" }
    }]
    """#)

    let empty = PluginVocabState.declarations(in: nodes)
    let landed = PluginVocabState.declarations(in: nodes) { _ in
      [PluginVocabStateOption(value: "eng", label: "Engineering", badge: nil)]
    }
    let more = PluginVocabState.declarations(in: nodes) { _ in
      [
        PluginVocabStateOption(value: "eng", label: "Engineering", badge: nil),
        PluginVocabStateOption(value: "des", label: "Design", badge: nil),
      ]
    }

    // The options are DATA: a project created in another window, or the second
    // page of a fetch landing, would otherwise change the signature and drop the
    // reader's filter — for a change they did not make and cannot see.
    XCTAssertEqual(PluginVocabState.signature(empty), PluginVocabState.signature(landed))
    XCTAssertEqual(PluginVocabState.signature(landed), PluginVocabState.signature(more))

    // The BINDING is the schema, so it still moves when the author changes it.
    let rebound = try body(#"""
    [{
      "component": "segmented",
      "stateKey": "project",
      "options": [{ "value": "", "label": "All projects" }],
      "optionsFrom": { "collection": "labels", "valueField": "id" }
    }]
    """#)
    XCTAssertNotEqual(
      PluginVocabState.signature(empty),
      PluginVocabState.signature(PluginVocabState.declarations(in: rebound))
    )

    // And the fine reconciliation still runs: a value that is no longer an
    // option falls back to the control's initial.
    XCTAssertEqual(
      PluginVocabState.normalize(["project": "gone"], declarations: landed),
      ["project": ""]
    )
    XCTAssertEqual(
      PluginVocabState.normalize(["project": "eng"], declarations: landed),
      ["project": "eng"]
    )
  }

  func testAControlPastTheStripCeilingDrawsAsAMenu() throws {
    let nodes = try body(#"""
    [{
      "component": "segmented",
      "stateKey": "project",
      "options": [{ "value": "", "label": "All" }],
      "optionsFrom": { "collection": "projects", "valueField": "id" }
    }]
    """#)
    func resolved(_ count: Int) -> [PluginVocabStateOption] {
      (0..<count).map { PluginVocabStateOption(value: "p\($0)", label: "P\($0)", badge: nil) }
    }

    // A strip of pills is the right picture for three states and the wrong one
    // for thirty projects, and the author cannot know which they will get.
    let strip = PluginVocabState.declarations(in: nodes) { _ in resolved(4) }
    let menu = PluginVocabState.declarations(in: nodes) { _ in resolved(40) }
    XCTAssertEqual(PluginVocabState.controlStyle(try XCTUnwrap(strip.first)), .segmented)
    XCTAssertEqual(PluginVocabState.controlStyle(try XCTUnwrap(menu.first)), .menu)
    // Fifty is where a flat menu stops being findable, and the cap is applied to
    // the merged list rather than to the resolved half of it.
    let capped = PluginVocabState.declarations(in: nodes) { _ in resolved(80) }
    XCTAssertEqual(
      try XCTUnwrap(capped.first).options.count,
      PluginVocabLimits.maxBoundStateOptions
    )

    // A two-option toggle is still a toggle.
    let toggle = try body(#"""
    [{ "component": "segmented", "stateKey": "k", "style": "toggle", "options": [
      { "value": "a", "label": "A" }, { "value": "b", "label": "B" }] }]
    """#)
    XCTAssertEqual(
      PluginVocabState.controlStyle(try XCTUnwrap(PluginVocabState.declarations(in: toggle).first)),
      .toggle
    )
  }

  // MARK: - Capacity

  func testAPanelMayDeclareEightStateKeys() {
    // Four was one filter axis short of the panels people actually write: an
    // issue browser wants state, project, assignee, priority, sort and a search.
    XCTAssertEqual(PluginVocabLimits.maxStateKeys, 8)
    XCTAssertEqual(PluginVocabLimits.maxBoundStateOptions, 50)
    XCTAssertEqual(PluginVocabLimits.maxSelectionKeys, 2)
    XCTAssertEqual(PluginVocabLimits.maxSelectedRows, 100)
    XCTAssertEqual(PluginVocabLimits.maxBulkActions, 4)
  }
}

/// The panel back stack and list paging — the two reductions B2 and B3 close.
///
/// Both are CLIENT-LOCAL state, which is what makes them testable without a
/// socket and what makes them worth pinning: nothing here reaches the plugin,
/// so the only thing that can prove the contract is a test that walks the same
/// gestures a reader would.
@MainActor
final class PluginPaneNavigationTests: XCTestCase {
  /// A list panel with a filter over it, so a test can leave real state behind
  /// before it navigates away.
  private static let listSchema = #"""
  {
    "v": 1,
    "title": "Stories",
    "fallback": { "title": "Stories", "text": "Open on the machine." },
    "body": [
      { "component": "segmented", "stateKey": "status", "options": [
        { "value": "all", "label": "All" }, { "value": "open", "label": "Open" }] },
      { "component": "list", "bind": { "collection": "stories" },
        "selectable": { "stateKey": "picked", "actions": [
          { "label": "Archive", "action": "archive" }] } }
    ]
  }
  """#

  private static let detailSchema = #"""
  {
    "v": 1,
    "title": "Story",
    "fallback": { "title": "Story", "text": "Open on the machine." },
    "body": [{ "component": "text", "text": "One story." }]
  }
  """#

  private final class FakeSync: PluginPaneSyncing {
    var canInvokePluginActions = true
    var canFetchPluginPanelsRemotely = false
    var pluginFallbackScope = "machine-a"
    var supportsPluginAuthSessions = false

    var localPanels: [PluginPanelRecord] = []
    var localEntries: [PluginCollectionEntry] = []

    func pluginPresenceCatalog() -> PluginPresenceCatalog { PluginPresenceCatalog() }

    func pluginPanels(pluginId: String?) -> [PluginPanelRecord] { localPanels }

    func pluginCollectionEntries(
      binding: PluginVocabBinding,
      pluginId: String,
      limit: Int
    ) -> [PluginCollectionEntry] {
      Array(localEntries.filter { $0.collection == binding.collection }.prefix(limit))
    }

    /// Scripted answers, oldest first. An empty queue answers with a bare
    /// success, which is what every test that does not care about the reply
    /// wants.
    var invokeReplies: [PluginInvokeResult] = []

    func invokePluginAction(
      pluginId: String,
      actionId: String,
      payload: [String: Any]
    ) async throws -> PluginInvokeResult {
      invokeReplies.isEmpty ? PluginInvokeResult() : invokeReplies.removeFirst()
    }

    func fetchPluginPanel(pluginId: String, panelId: String) async throws -> PluginPanelRecord? { nil }

    func fetchPluginCollectionEntries(
      pluginId: String,
      collection: String,
      keyPrefix: String?,
      limit: Int
    ) async throws -> [PluginCollectionEntry] { [] }

    func completePluginAuthSession(params: [String: String]) async throws {}
  }

  private func record(panelId: String, title: String, schemaJSON: String) -> PluginPanelRecord {
    PluginPanelRecord(
      pluginId: "hn",
      panelId: panelId,
      title: title,
      icon: "",
      surface: "work",
      schemaJSON: schemaJSON,
      vocabVersion: 1,
      updatedAt: "2026-08-31T10:00:00Z",
      mobile: PluginPanelRecord.mobileFlag(inSchemaJSON: schemaJSON),
      refreshAction: nil
    )
  }

  private func entries(_ count: Int) -> [PluginCollectionEntry] {
    (0..<count).map { index in
      PluginCollectionEntry(
        pluginId: "hn",
        collection: "stories",
        key: String(format: "%04d", index),
        valueJSON: #"{"title":"Story \#(index)","key":"\#(String(format: "%04d", index))"}"#,
        updatedAt: "2026-08-31T10:00:00Z"
      )
    }
  }

  private func makeStore(_ sync: FakeSync) -> PluginPaneStore {
    PluginPaneStore(
      pluginId: "hn",
      panelId: "stories",
      sync: sync,
      fetchesMissingRows: false,
      fallbackCache: PluginPanelFallbackCache(),
      openExternalURL: { _ in }
    )
  }

  /// The first node of the pane, when it is the segmented control.
  private func list(of store: PluginPaneStore) -> PluginVocabList? {
    guard case let .panel(schema) = store.presentation else { return nil }
    for node in schema.body {
      if case let .list(list) = node { return list }
    }
    return nil
  }

  private func segmented(of store: PluginPaneStore) -> PluginVocabSegmented? {
    guard case let .panel(schema) = store.presentation else { return nil }
    for node in schema.body {
      if case let .segmented(control) = node { return control }
    }
    return nil
  }

  // MARK: - B2: the back stack

  /// A `navigate` PUSHES, and a return hands back everything the reader left.
  ///
  /// This is the whole of M1. Before the stack, `navigate` replaced the pane and
  /// called `clearPanelState`, so the filter, the ticks and the scroll were gone
  /// the moment a plugin opened a detail screen — and there was no way back to
  /// notice.
  func testNavigatePushesAndBackRestoresWhatTheReaderLeft() {
    let sync = FakeSync()
    sync.localPanels = [
      record(panelId: "stories", title: "Stories", schemaJSON: Self.listSchema),
      record(panelId: "story", title: "Story", schemaJSON: Self.detailSchema),
    ]
    sync.localEntries = entries(3)
    let store = makeStore(sync)
    store.load()

    let control = try? XCTUnwrap(segmented(of: store))
    if let control {
      store.select(PluginVocabStateOption(value: "open", label: "Open"), in: control)
    }
    let listNode = try? XCTUnwrap(list(of: store))
    if let listNode, let selectable = listNode.selectable {
      store.toggle(rowKey: "0001", in: selectable)
    }
    store.scrollOffset = 420

    XCTAssertEqual(store.panelState["status"], "open")
    XCTAssertEqual(store.panelSelection["picked"], ["0001"])
    XCTAssertFalse(store.canGoBack)

    store.navigate(to: PluginInvokeNavigation(panelId: "story", context: ["id": .string("1")]))

    XCTAssertTrue(store.canGoBack)
    XCTAssertEqual(store.backTitle, "Stories")
    XCTAssertEqual(store.selectedPanelId, "story")
    // The destination is a fresh panel: the previous one's filter and ticks
    // belong to the panel they were made on, not to this one.
    XCTAssertTrue(store.panelState.isEmpty)
    XCTAssertTrue(store.panelSelection.isEmpty)

    store.goBack()

    XCTAssertFalse(store.canGoBack)
    XCTAssertEqual(store.selectedPanelId, "stories")
    XCTAssertEqual(store.panelState["status"], "open")
    XCTAssertEqual(store.panelSelection["picked"], ["0001"])
    XCTAssertEqual(store.pendingScrollOffset, 420)
  }

  /// A `navigate` to the panel already on top REPLACES it rather than pushing a
  /// second copy. A plugin re-addressing the screen the reader is on — usually
  /// with a new context — must not leave a back chevron that goes nowhere.
  func testNavigateToThePanelOnTopReplacesRatherThanPushes() {
    let sync = FakeSync()
    sync.localPanels = [record(panelId: "stories", title: "Stories", schemaJSON: Self.listSchema)]
    let store = makeStore(sync)
    store.load()

    store.navigate(to: PluginInvokeNavigation(panelId: "stories", context: ["id": .string("2")]))

    XCTAssertFalse(store.canGoBack)
    XCTAssertEqual(store.selectedPanelId, "stories")
    XCTAssertEqual(store.context["id"], .string("2"))
  }

  /// The stack is capped and drops the OLDEST. A plugin that navigates in a loop
  /// cannot grow it without bound, and the reader keeps the eight screens they
  /// could plausibly remember walking through.
  func testTheStackIsCappedAndDropsTheOldestEntry() {
    let sync = FakeSync()
    // Every destination is in the mirror. `makeStore` builds a pane with
    // `fetchesMissingRows: false`, and such a pane redirects a request it has no
    // row for back to `panels.first` — so navigating to panels the mirror never
    // heard of would leave the reader on `stories` and push `stories` twenty
    // times, which measures the redirect rather than the cap.
    sync.localPanels = [record(panelId: "stories", title: "Stories", schemaJSON: Self.listSchema)]
      + (0..<20).map {
        record(panelId: "panel-\($0)", title: "Panel \($0)", schemaJSON: Self.listSchema)
      }
    let store = makeStore(sync)
    store.load()

    for index in 0..<20 {
      store.navigate(to: PluginInvokeNavigation(panelId: "panel-\(index)"))
    }

    XCTAssertEqual(store.backStack.count, PluginPaneStore.maxBackStackDepth)
    // The oldest entry left is the one eight hops back, never the root.
    XCTAssertEqual(store.backStack.first?.panelId, "panel-11")
    XCTAssertEqual(store.backStack.last?.panelId, "panel-18")
  }

  /// The panel picker is a LATERAL move, so it empties the stack. A back chevron
  /// offering a detail screen the reader reached from a different tab would be a
  /// promise about somewhere they did not come from.
  func testSelectingAPanelFromThePickerEmptiesTheStack() {
    let sync = FakeSync()
    sync.localPanels = [
      record(panelId: "stories", title: "Stories", schemaJSON: Self.listSchema),
      record(panelId: "story", title: "Story", schemaJSON: Self.detailSchema),
    ]
    let store = makeStore(sync)
    store.load()
    store.navigate(to: PluginInvokeNavigation(panelId: "story"))
    XCTAssertTrue(store.canGoBack)

    store.selectPanel("stories")

    XCTAssertFalse(store.canGoBack)
  }

  /// `resetState` clears the CURRENT panel and never a stacked one.
  ///
  /// A plugin that put the reader back on "All" after archiving has said nothing
  /// about the filter they left on a panel two screens up. Before the stack
  /// there was nothing else a reset COULD have reached; now there is, and this
  /// is what keeps the verb's scope where the vocabulary says it is.
  func testResetStateClearsTheCurrentPanelAndNeverAStackedOne() async {
    let sync = FakeSync()
    sync.localPanels = [
      record(panelId: "stories", title: "Stories", schemaJSON: Self.listSchema),
      record(panelId: "detail", title: "Detail", schemaJSON: Self.listSchema),
    ]
    sync.localEntries = entries(3)
    let store = makeStore(sync)
    store.load()
    guard let control = segmented(of: store) else { return XCTFail("expected a filter") }
    store.select(PluginVocabStateOption(value: "open", label: "Open"), in: control)
    XCTAssertEqual(store.panelState["status"], "open")

    // The second panel declares the same controls, so a reset here would be
    // indistinguishable from one that walked the stack if the two shared a map.
    store.navigate(to: PluginInvokeNavigation(panelId: "detail"))
    guard let destination = segmented(of: store) else { return XCTFail("expected a filter") }
    store.select(PluginVocabStateOption(value: "open", label: "Open"), in: destination)
    XCTAssertEqual(store.panelState["status"], "open")

    sync.invokeReplies = [PluginInvokeResult(resetState: .all)]
    store.perform(PluginVocabAction(action: "archive"))
    await settle(until: { store.panelState["status"] != "open" })

    XCTAssertEqual(store.panelState["status"], "all", "the panel the action ran on resets")
    XCTAssertEqual(
      store.backStack.last?.panelState["status"],
      "open",
      "the panel underneath is not the one the action ran on"
    )

    store.goBack()
    XCTAssertEqual(store.panelState["status"], "open")
  }

  /// Let a dispatched action land. `perform` fires a detached task, so a test
  /// has to give it a turn rather than sleep on it.
  private func settle(until reached: () -> Bool) async {
    for _ in 0..<200 {
      if reached() { return }
      await Task.yield()
    }
  }

  // MARK: - B3: paging

  /// A bound list draws one page and says how many of how many. The count is the
  /// half a bigger ceiling alone would not have fixed: a list that stopped at 100
  /// and said nothing looked exactly like a complete one.
  func testAListDrawsOnePageAndSaysHowManyOfHowMany() {
    let page = PluginVocabPaging.page(total: 143, pages: 1)
    XCTAssertEqual(page.drawn, PluginVocabLimits.listPageSize)
    XCTAssertTrue(page.hasMore)
    XCTAssertFalse(page.totalIsFloor)
    XCTAssertEqual(PluginVocabPaging.label(page), "Showing 100 of 143")

    let second = PluginVocabPaging.page(total: 143, pages: 2)
    XCTAssertEqual(second.drawn, 143)
    XCTAssertFalse(second.hasMore)
    XCTAssertNil(PluginVocabPaging.label(second), "a list drawing everything it holds explains nothing")
  }

  /// A saturated read stops claiming a total, and a list at the ceiling says so
  /// rather than stopping in silence.
  func testASaturatedReadStopsClaimingATotal() {
    let first = PluginVocabPaging.page(total: PluginVocabLimits.maxListItems, pages: 1)
    XCTAssertTrue(first.totalIsFloor)
    XCTAssertEqual(PluginVocabPaging.label(first), "Showing 100")

    let last = PluginVocabPaging.page(total: PluginVocabLimits.maxListItems, pages: PluginVocabPaging.pagesToCeiling)
    XCTAssertEqual(last.drawn, PluginVocabLimits.maxListItems)
    XCTAssertFalse(last.hasMore)
    XCTAssertEqual(PluginVocabPaging.label(last), "Showing the first \(PluginVocabLimits.maxListItems)")
  }

  /// A node combining literal `items` with a `bind` holds more rows than the
  /// ceiling allows — the store appends the bound rows to the declared ones.
  /// Offering a "Show more" there would be a control that does nothing.
  func testTheCeilingStopsTheOfferHoweverManyRowsAreHeld() {
    let pages = PluginVocabPaging.pagesToCeiling
    let held = PluginVocabLimits.maxListItems * 2
    let page = PluginVocabPaging.page(total: held, pages: pages)
    XCTAssertEqual(page.drawn, PluginVocabLimits.maxListItems)
    XCTAssertFalse(page.hasMore)
    XCTAssertEqual(PluginVocabPaging.label(page), "Showing the first \(PluginVocabLimits.maxListItems)")
    XCTAssertEqual(PluginVocabPaging.nextPage(total: held, pages: pages), pages)
  }

  /// "Show more" extends by one page and is inert at the end.
  func testShowMoreExtendsByOnePageAndIsInertAtTheEnd() {
    let sync = FakeSync()
    sync.localPanels = [record(panelId: "stories", title: "Stories", schemaJSON: Self.listSchema)]
    sync.localEntries = entries(143)
    let store = makeStore(sync)
    store.load()

    let listNode = try? XCTUnwrap(list(of: store))
    guard let listNode else { return XCTFail("expected a bound list") }
    XCTAssertEqual(listNode.items?.count, 143, "the store holds every fetched row; the view pages them")
    XCTAssertEqual(store.listPage(for: listNode), 1)

    store.showMoreRows(in: listNode)
    XCTAssertEqual(store.listPage(for: listNode), 2)
    // Nothing left to draw, so the press changes nothing rather than growing a
    // number the list can never spend.
    store.showMoreRows(in: listNode)
    XCTAssertEqual(store.listPage(for: listNode), 2)
  }

  /// The page count is per LIST and survives a republish, exactly as a folded
  /// section does — a plugin refreshing its rows every ten seconds must not put
  /// the reader back on the first hundred.
  func testThePageCountSurvivesARepublishAndResetsOnAPanelChange() {
    let sync = FakeSync()
    sync.localPanels = [
      record(panelId: "stories", title: "Stories", schemaJSON: Self.listSchema),
      record(panelId: "story", title: "Story", schemaJSON: Self.detailSchema),
    ]
    sync.localEntries = entries(143)
    let store = makeStore(sync)
    store.load()
    guard let listNode = list(of: store) else { return XCTFail("expected a bound list") }
    store.showMoreRows(in: listNode)
    XCTAssertEqual(store.listPage(for: listNode), 2)

    store.load()
    XCTAssertEqual(store.listPage(for: listNode), 2, "a republish is not a reason to start over")

    store.selectPanel("story")
    store.selectPanel("stories")
    XCTAssertEqual(store.listPage(for: listNode), 1, "a different panel's list is a different list")
  }

  /// Filter first, page second. Paging extends the CAP; it never reaches back
  /// past the binding's `where` for rows the filter rejected.
  func testFilterRunsBeforeThePage() {
    let schema = #"""
    {
      "v": 1,
      "fallback": { "title": "Stories", "text": "Open on the machine." },
      "body": [
        { "component": "segmented", "stateKey": "status", "default": "open", "options": [
          { "value": "all", "label": "All" }, { "value": "open", "label": "Open" }] },
        { "component": "list", "bind": { "collection": "stories",
          "where": [{ "field": "status", "equals": { "$state": "status" } }] } }
      ]
    }
    """#
    let sync = FakeSync()
    sync.localPanels = [record(panelId: "stories", title: "Stories", schemaJSON: schema)]
    sync.localEntries = (0..<200).map { index in
      PluginCollectionEntry(
        pluginId: "hn",
        collection: "stories",
        key: String(format: "%04d", index),
        valueJSON: #"{"title":"Story \#(index)","status":"\#(index < 30 ? "open" : "closed")"}"#,
        updatedAt: "2026-08-31T10:00:00Z"
      )
    }
    let store = makeStore(sync)
    store.load()

    guard let listNode = list(of: store) else { return XCTFail("expected a bound list") }
    // 30 rows survived the filter, so the page is over 30 and not over 200.
    XCTAssertEqual(listNode.items?.count, 30)
    let page = PluginVocabPaging.page(
      total: listNode.items?.count ?? 0,
      pages: store.listPage(for: listNode)
    )
    XCTAssertEqual(page.drawn, 30)
    XCTAssertFalse(page.hasMore)
    XCTAssertNil(PluginVocabPaging.label(page))
  }

  /// The ceiling itself, and the page step under it.
  func testTheListCeilingAndItsPageStep() {
    XCTAssertEqual(PluginVocabLimits.maxListItems, 1000)
    XCTAssertEqual(PluginVocabLimits.listPageSize, 100)
    XCTAssertEqual(PluginVocabPaging.pagesToCeiling, 10)
  }
}

// MARK: - Panel chrome

final class PluginVocabChromeTests: XCTestCase {
  private func parse(_ json: String) -> PluginPanelParseResult {
    PluginPanelParser.parse(json)
  }

  private func panel(_ result: PluginPanelParseResult) throws -> PluginPanelSchema {
    guard case let .ok(schema, _) = result else {
      throw XCTSkip("Expected a parsed panel, got \(result)")
    }
    return schema
  }

  func testParsesSearchNavActionsFooterAndAGroupIcon() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "F", "text": "f" },
      "body": [
        { "component": "group", "title": "Started", "icon": "circle", "children": [] },
        { "component": "list", "bind": {
          "collection": "issues",
          "where": [{ "field": "title", "contains": { "$state": "q" } }]
        } }
      ],
      "chrome": {
        "search": { "stateKey": "q", "placeholder": "Filter issues", "onChange": { "action": "search" } },
        "navActions": [{ "action": "openLinear", "label": "Open in Linear", "icon": "arrow-square-out" }],
        "footer": [{ "component": "button", "label": "New issue", "onPress": { "action": "create" } }]
      }
    }
    """#))

    XCTAssertEqual(schema.chrome?.search?.stateKey, "q")
    XCTAssertEqual(schema.chrome?.search?.placeholder, "Filter issues")
    XCTAssertEqual(schema.chrome?.search?.onChange?.action, "search")
    XCTAssertEqual(schema.chrome?.navActions.count, 1)
    XCTAssertEqual(schema.chrome?.navActions.first?.label, "Open in Linear")
    XCTAssertEqual(schema.chrome?.navActions.first?.icon, "arrow-square-out")
    XCTAssertEqual(schema.chrome?.navActions.first?.action.action, "openLinear")
    XCTAssertEqual(schema.chrome?.footer.count, 1)
    if case let .button(button)? = schema.chrome?.footer.first {
      XCTAssertEqual(button.label, "New issue")
    } else {
      XCTFail("expected a footer button")
    }
    guard case let .group(group) = schema.body[0] else { return XCTFail("expected a group") }
    XCTAssertEqual(group.icon, "circle")
  }

  func testDeclaresSearchFirstAndWalksTheFooterForBindings() throws {
    let schema = try panel(parse(#"""
    {
      "v": 1,
      "fallback": { "title": "F", "text": "f" },
      "body": [{
        "component": "segmented",
        "stateKey": "status",
        "options": [{ "value": "", "label": "All" }, { "value": "active", "label": "Active" }]
      }],
      "chrome": {
        "search": { "stateKey": "q" },
        "footer": [{ "component": "list", "bind": { "collection": "drafts" } }]
      }
    }
    """#))

    let declarations = PluginVocabState.declarations(in: schema.contentNodes, chrome: schema.chrome)
    XCTAssertEqual(declarations.map(\.stateKey), ["q", "status"])
    XCTAssertTrue(declarations[0].isSearch)
    XCTAssertEqual(PluginVocabState.controlStyle(declarations[0]), .search)
    XCTAssertEqual(schema.contentNodes.count, 2)
  }

  func testOmitsMalformedChromePiecesWithoutFailingThePanel() throws {
    let result = parse(#"""
    {
      "v": 1,
      "fallback": { "title": "F", "text": "f" },
      "body": [],
      "chrome": {
        "search": { "placeholder": "no key" },
        "navActions": [
          { "action": "a", "label": "One" },
          { "action": "b", "label": "Two" },
          { "action": "c", "label": "Three" },
          { "action": "d", "label": "Four" },
          { "action": "e", "label": "Five" },
          { "label": "no action" }
        ],
        "footer": "not-an-array"
      }
    }
    """#)
    let schema = try panel(result)
    XCTAssertNil(schema.chrome?.search)
    XCTAssertEqual(schema.chrome?.navActions.count, PluginVocabLimits.maxChromeNavActions)
    XCTAssertEqual(schema.chrome?.footer ?? [], [])
    guard case let .ok(_, warnings) = result else { return XCTFail("expected ok") }
    XCTAssertFalse(warnings.isEmpty)
  }

  func testSearchSignsTheControlNotTheTypedQueryAndKeepsTypedText() {
    let declaration = PluginVocabStateDeclaration(
      stateKey: "q",
      kind: .search,
      placeholder: "Filter issues",
      options: [],
      initial: ""
    )
    let otherPlaceholder = PluginVocabStateDeclaration(
      stateKey: "q",
      kind: .search,
      placeholder: "Other",
      options: [],
      initial: ""
    )
    XCTAssertEqual(
      PluginVocabState.signature([declaration]),
      PluginVocabState.signature([
        PluginVocabStateDeclaration(stateKey: "q", kind: .search, placeholder: "Filter issues", options: [], initial: "ISS")
      ])
    )
    XCTAssertNotEqual(PluginVocabState.signature([declaration]), PluginVocabState.signature([otherPlaceholder]))
    XCTAssertEqual(PluginVocabState.controlStyle(declaration), .search)

    let typed = PluginVocabState.apply([:], declaration: declaration, value: "  Issue  ")
    XCTAssertEqual(typed, ["q": "  Issue  "])
    XCTAssertEqual(PluginVocabState.normalize(typed, declarations: [declaration]), ["q": "  Issue  "])
    let tooLong = String(repeating: "x", count: PluginVocabLimits.maxSearchChars + 40)
    XCTAssertEqual(
      PluginVocabState.apply([:], declaration: declaration, value: tooLong)["q"]?.count,
      PluginVocabLimits.maxSearchChars
    )
    XCTAssertEqual(
      PluginVocabState.normalize(["q": tooLong], declarations: [declaration])["q"]?.count,
      PluginVocabLimits.maxSearchChars
    )
    XCTAssertEqual(
      PluginVocabState.rows([declaration], state: ["q": "ISS-1"]),
      [PluginVocabKeyValueRow(key: "q", value: "ISS-1")]
    )
  }
}
