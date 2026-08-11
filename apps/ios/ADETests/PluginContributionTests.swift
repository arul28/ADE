import XCTest
@testable import ADE

/// How a `plugin_contributions` row becomes something a row on screen draws.
///
/// The rules under test are the ones four clients have to agree on: which
/// payloads are usable, which order badges appear in, and where the cap falls.
/// A phone and a desktop showing the same PR must show the same two badges.
final class PluginContributionTests: XCTestCase {
  private func badge(
    plugin: String,
    text: String,
    entityId: String = "42",
    kind: String = "pr",
    order: Int? = nil,
    tone: String = "neutral",
    updatedAt: String = "2026-08-10T00:00:00Z"
  ) -> PluginContribution? {
    let orderField = order.map { "\"order\": \($0)," } ?? ""
    return PluginContributionParser.parse(
      entityKind: kind,
      entityId: entityId,
      pluginId: plugin,
      socket: "row-badge",
      payloadJSON: #"{ \#(orderField) "text": "\#(text)", "tone": "\#(tone)" }"#,
      updatedAt: updatedAt
    )
  }

  // MARK: - Payload validation

  func testBadgePayloadParsesAndNormalizesTone() throws {
    let contribution = try XCTUnwrap(badge(plugin: "coverage", text: "82%", tone: "error"))
    XCTAssertEqual(contribution.entityKind, .pr)
    XCTAssertEqual(contribution.entityId, "42")
    // No red anywhere in the product: an "error" tone folds to warning.
    XCTAssertEqual(contribution.badge?.tone, .warning)
    XCTAssertEqual(contribution.badge?.text, "82%")
  }

  func testBadgeWithoutTextIsDroppedRatherThanDrawnEmpty() {
    XCTAssertNil(PluginContributionParser.parse(
      entityKind: "pr", entityId: "42", pluginId: "coverage",
      socket: "row-badge", payloadJSON: #"{ "tone": "success" }"#, updatedAt: ""
    ))
  }

  func testMenuItemNeedsBothALabelAndAnActionId() {
    XCTAssertNil(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "graph",
      socket: "row-menu-item", payloadJSON: #"{ "label": "Rebuild" }"#, updatedAt: ""
    ), "A menu item with no action would render as a button that does nothing.")

    XCTAssertNotNil(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "graph",
      socket: "row-menu-item",
      payloadJSON: #"{ "label": "Rebuild", "actionId": "graph.rebuild", "danger": true }"#,
      updatedAt: ""
    ))
  }

  func testSocketsThisBuildDoesNotDrawAreSkipped() {
    // The taxonomy has seven kinds and this build renders two. The other five
    // must decode to nothing rather than to a half-built control.
    for socket in ["toolbar-action", "detail-section", "empty-state", "filter-chip", "file-viewer", "row-halo"] {
      XCTAssertNil(PluginContributionParser.parse(
        entityKind: "pr", entityId: "42", pluginId: "p",
        socket: socket, payloadJSON: #"{ "label": "x", "actionId": "y", "panelId": "z" }"#, updatedAt: ""
      ), "\(socket) should not decode in this build")
    }
  }

  func testUnknownEntityKindIsSkipped() {
    XCTAssertNil(badge(plugin: "p", text: "x", kind: "spaceship"))
  }

  func testMalformedPayloadJSONIsSkipped() {
    XCTAssertNil(PluginContributionParser.parse(
      entityKind: "pr", entityId: "42", pluginId: "p",
      socket: "row-badge", payloadJSON: "{ nope", updatedAt: ""
    ))
  }

  // MARK: - Placement

  func testBadgesCapAtTwoVisibleAndReportTheOverflow() throws {
    let index = PluginContributionIndex(contributions: [
      try XCTUnwrap(badge(plugin: "c", text: "third", order: 3)),
      try XCTUnwrap(badge(plugin: "a", text: "first", order: 1)),
      try XCTUnwrap(badge(plugin: "b", text: "second", order: 2)),
      try XCTUnwrap(badge(plugin: "d", text: "fourth", order: 4)),
    ])

    let badges = index.badges(.pr, "42")
    XCTAssertEqual(badges.visible.compactMap { $0.badge?.text }, ["first", "second"])
    XCTAssertEqual(badges.overflow, 2)
  }

  func testOrderlessBadgesFallBackToPluginIdSoTwoDevicesAgree() throws {
    let index = PluginContributionIndex(contributions: [
      try XCTUnwrap(badge(plugin: "zeta", text: "z")),
      try XCTUnwrap(badge(plugin: "alpha", text: "a")),
    ])
    XCTAssertEqual(index.badges(.pr, "42").visible.map(\.pluginId), ["alpha", "zeta"])
  }

  func testDeclaredOrderBeatsPluginId() throws {
    let index = PluginContributionIndex(contributions: [
      try XCTUnwrap(badge(plugin: "alpha", text: "a", order: 9)),
      try XCTUnwrap(badge(plugin: "zeta", text: "z", order: 1)),
    ])
    XCTAssertEqual(index.badges(.pr, "42").visible.map(\.pluginId), ["zeta", "alpha"])
  }

  func testIndexScopesByEntityAndKind() throws {
    let index = PluginContributionIndex(contributions: [
      try XCTUnwrap(badge(plugin: "p", text: "pr row", entityId: "42", kind: "pr")),
      try XCTUnwrap(badge(plugin: "p", text: "lane row", entityId: "42", kind: "lane")),
    ])
    XCTAssertEqual(index.badges(.pr, "42").visible.compactMap { $0.badge?.text }, ["pr row"])
    XCTAssertEqual(index.badges(.lane, "42").visible.compactMap { $0.badge?.text }, ["lane row"])
    XCTAssertTrue(index.badges(.session, "42").isEmpty)
  }

  func testMenuItemsAndBadgesDoNotLeakIntoEachOther() throws {
    let menuItem = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "graph", socket: "row-menu-item",
      payloadJSON: #"{ "label": "Rebuild", "actionId": "graph.rebuild" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(contributions: [
      menuItem,
      try XCTUnwrap(badge(plugin: "graph", text: "3 cycles", entityId: "lane-1", kind: "lane")),
    ])
    XCTAssertEqual(index.badges(.lane, "lane-1").visible.count, 1)
    XCTAssertEqual(index.menuItems(.lane, "lane-1").compactMap { $0.menuItem?.label }, ["Rebuild"])
  }

  // MARK: - Presence

  func testPresenceCatalogPrefersTheMostRecentlyWrittenRowForLabelAndAccent() {
    let catalog = PluginPresenceCatalog(records: [
      PluginPresenceRecord(
        machineKey: "machine:old", pluginId: "graph", version: "1.0.0", enabled: true,
        displayName: "Graph", icon: "", accent: "#111111", updatedAt: "2026-08-01T00:00:00Z"
      ),
      PluginPresenceRecord(
        machineKey: "machine:new", pluginId: "graph", version: "1.2.0", enabled: true,
        displayName: "Graph Pro", icon: "", accent: "#7C6FF0", updatedAt: "2026-08-09T00:00:00Z"
      ),
    ])
    XCTAssertEqual(catalog.label(for: "graph"), "Graph Pro")
    XCTAssertEqual(catalog.accentHex(for: "graph"), "#7C6FF0")
  }

  func testPresenceLabelFallsBackToThePluginId() {
    let catalog = PluginPresenceCatalog(records: [
      PluginPresenceRecord(
        machineKey: "m", pluginId: "graph", version: "", enabled: true,
        displayName: "", icon: "", accent: "", updatedAt: ""
      ),
    ])
    XCTAssertEqual(catalog.label(for: "graph"), "graph")
    XCTAssertNil(catalog.accentHex(for: "graph"))
    XCTAssertEqual(catalog.label(for: "never-installed"), "never-installed")
  }

  func testPresenceListReplyToleratesUnknownFieldsAndMissingOnes() throws {
    let data = Data(#"""
    { "plugins": [
        { "pluginId": "graph", "enabled": true, "displayName": "Graph", "futureField": 7 },
        { "version": "1.0.0" }
      ],
      "somethingNew": true
    }
    """#.utf8)
    let result = try JSONDecoder().decode(PluginPresenceListResult.self, from: data)
    XCTAssertEqual(result.plugins.count, 2)
    XCTAssertEqual(result.plugins[0].pluginId, "graph")
    XCTAssertTrue(result.plugins[0].enabled)
    // The second entry has no id, so nothing can be opened from it — but it
    // must not have cost us the first.
    XCTAssertEqual(result.plugins[1].pluginId, "")
  }

  func testInvokeResultNeverFailsToDecode() throws {
    let decoder = JSONDecoder()
    XCTAssertEqual(try decoder.decode(PluginInvokeResult.self, from: Data("{}".utf8)).ok, true)
    XCTAssertEqual(
      try decoder.decode(PluginInvokeResult.self, from: Data(#"{"message":"Rebuilt 14 nodes"}"#.utf8)).message,
      "Rebuilt 14 nodes"
    )
    let failure = try decoder.decode(PluginInvokeResult.self, from: Data(#"{"error":"no such action"}"#.utf8))
    XCTAssertFalse(failure.ok)
    XCTAssertEqual(failure.message, "no such action")
  }
}
