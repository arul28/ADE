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
    // The taxonomy has sixteen kinds and this build renders ten. The six that
    // have no honest surface on a phone (window chrome, rails, drawers,
    // dialogs, a flat Settings) must decode to nothing rather than to a
    // half-built control — plus any kind this build has never heard of.
    for socket in [
      "command-palette-action", "settings-section", "work-rail-pane",
      "drawer-tab", "dialog-section", "slash-command", "row-halo",
    ] {
      XCTAssertNil(PluginContributionParser.parse(
        entityKind: "pr", entityId: "42", pluginId: "p",
        socket: socket, payloadJSON: #"{ "label": "x", "actionId": "y", "panelId": "z", "command": "x", "dialog": "create-pr" }"#, updatedAt: ""
      ), "\(socket) should not decode in this build")
    }
  }

  func testAstronomicalOrderSaturatesRatherThanTrapping() throws {
    // Regression, twice over. `Int(_:)` traps outside `Int`'s range, and `order`
    // comes off a synced row written by another machine. Desktop keeps the raw
    // double and sorts it last, so this build saturates instead of dropping to
    // nil — the two surfaces must agree on where an extreme order sorts.
    let huge = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "pr", entityId: "42", pluginId: "a", socket: "row-badge",
      payloadJSON: #"{ "order": 1e300, "text": "huge" }"#, updatedAt: ""
    ))
    XCTAssertEqual(huge.order, Int.max, "An order this build cannot hold saturates, not a crash and not unordered.")

    // And it still sorts last, matching desktop's raw-double ordering.
    let index = PluginContributionIndex(contributions: [
      huge,
      try XCTUnwrap(badge(plugin: "b", text: "first", order: 1)),
    ])
    XCTAssertEqual(index.badges(.pr, "42").visible.compactMap { $0.badge?.text }, ["first", "huge"])
  }

  func testNumericOneIsNotADangerousMenuItem() throws {
    // `as? Bool` bridges any `NSNumber` holding 0 or 1, so `"danger": 1` used
    // to style an entry as destructive without the payload ever saying so.
    let numeric = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "graph", socket: "row-menu-item",
      payloadJSON: #"{ "label": "Rebuild", "actionId": "a", "danger": 1 }"#, updatedAt: ""
    ))
    XCTAssertEqual(numeric.menuItem?.danger, false)

    let real = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "lane", entityId: "lane-1", pluginId: "graph", socket: "row-menu-item",
      payloadJSON: #"{ "label": "Rebuild", "actionId": "a", "danger": true }"#, updatedAt: ""
    ))
    XCTAssertEqual(real.menuItem?.danger, true)
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

  // MARK: - chat-header-action and split-button menus

  /// The kind the retrospective asked for: an entry in the chat header's
  /// three-dot menu.
  ///
  /// It shares the action-button payload with the toolbar and composer sockets,
  /// so what is really under test is WHERE the phone files it — per CHAT, like
  /// a composer action. The desktop call site reads the other way at a glance
  /// (`useSurfaceContributions("work", …, { context: session })`) but that hook
  /// only loads the surface's set; `selectContributions` then narrows it with
  /// `pluginContributionKeyForContext(context)`, which maps a session context to
  /// `{entityKind: "session", entityId: id}`.
  func testChatHeaderActionIsKeyedPerChatLikeDesktop() throws {
    XCTAssertFalse(pluginSocketIsSurfaceScoped(PluginSocketKind(rawValue: "chat-header-action")))

    let contribution = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "session", entityId: "sess-1", pluginId: "ade-tipsy",
      socket: "chat-header-action",
      payloadJSON: #"{ "label": "Take a drink", "icon": "beer", "actionId": "tipsy.drink" }"#,
      updatedAt: ""
    ))
    XCTAssertEqual(contribution.entityKind, .session)
    XCTAssertEqual(contribution.chatHeaderAction?.label, "Take a drink")
    XCTAssertEqual(contribution.chatHeaderAction?.actionId, "tipsy.drink")
    XCTAssertEqual(contribution.chatHeaderAction?.icon, "beer")
    XCTAssertTrue(contribution.chatHeaderAction?.menu.isEmpty == true)
    // Not a composer action wearing another name: the two sockets send
    // different contexts, so a surface must be able to tell them apart.
    XCTAssertNil(contribution.composerAction)
  }

  func testChatHeaderActionNeedsBothALabelAndAnActionId() {
    XCTAssertNil(PluginContributionParser.parse(
      entityKind: "session", entityId: "sess-1", pluginId: "ade-tipsy",
      socket: "chat-header-action", payloadJSON: #"{ "label": "Take a drink" }"#, updatedAt: ""
    ), "A header entry with no action would sit in the menu doing nothing.")
  }

  func testHeaderActionsAndComposerActionsDoNotLeakIntoEachOther() throws {
    let mine = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "session", entityId: "sess-1", pluginId: "ade-tipsy",
      socket: "chat-header-action",
      payloadJSON: #"{ "label": "Take a drink", "actionId": "tipsy.drink" }"#, updatedAt: ""
    ))
    let theirs = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "session", entityId: "sess-2", pluginId: "ade-tipsy",
      socket: "chat-header-action",
      payloadJSON: #"{ "label": "Take a drink", "actionId": "tipsy.drink" }"#, updatedAt: ""
    ))
    let composer = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "session", entityId: "sess-1", pluginId: "ade-tipsy",
      socket: "composer-action",
      payloadJSON: #"{ "label": "Take a drink", "actionId": "tipsy.drink" }"#, updatedAt: ""
    ))
    let index = PluginContributionIndex(contributions: [mine, theirs, composer])

    XCTAssertEqual(index.chatHeaderActions(sessionId: "sess-1").count, 1)
    XCTAssertEqual(index.chatHeaderActions(sessionId: "sess-2").count, 1)
    XCTAssertTrue(index.chatHeaderActions(sessionId: "sess-3").isEmpty)
    // The composer row sits on the same chat and must not be mistaken for a
    // header entry, nor the header row for a composer button.
    XCTAssertEqual(index.composerActions(sessionId: "sess-1").count, 1)
  }

  /// placement-desktop's executable pin, mirrored one-for-one.
  ///
  /// Their `contributionModel.test.ts` block "chat-header-action is filed per
  /// session, not per surface" builds one set holding a manifest declaration, a
  /// row published against `session/chat-1`, and a row the same plugin published
  /// against `surface/work`. It then asserts three things, which are the three
  /// asserted here against the same fixture — same plugin, same ids, same
  /// labels — so the two clients are pinned to one contract rather than to two
  /// readings of a call site.
  ///
  /// The tab row names the DECLARED socket id `drink`, and that detail is the
  /// whole strength of assertion three. An undeclared id — the fixture's first
  /// shape — is dropped by the declaration join in ``PluginContributionIndex``
  /// before any lookup runs, which means a surface-scoped implementation would
  /// have passed the assertion too: it could not fail for the reason it claims.
  /// With a declared id the row survives the join and is filed under the Work
  /// surface, so the ONLY thing keeping it out of a chat header is the
  /// per-session filing rule. Get that rule wrong and this test goes red.
  func testChatHeaderFilingMatchesDesktopsExecutablePin() throws {
    let record = try JSONDecoder().decode(
      PluginInstallRecordEntry.self,
      from: Data(#"""
      { "pluginId": "tipsy", "enabled": true, "sockets": [
          { "socket": "chat-header-action", "surface": "work", "id": "drink",
            "label": "Drink", "actionId": "takeDrink" }
      ] }
      """#.utf8)
    )
    let publishedForChat = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "session", entityId: "chat-1", pluginId: "tipsy",
      socket: "chat-header-action",
      payloadJSON: #"{ "id": "drink", "label": "Drink (3)", "actionId": "takeDrink" }"#,
      updatedAt: "2026-08-15T00:00:00.000Z"
    ))
    let publishedForTab = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "surface", entityId: "work", pluginId: "tipsy",
      socket: "chat-header-action",
      payloadJSON: #"{ "id": "drink", "label": "Tab wide", "actionId": "tabWide" }"#,
      updatedAt: "2026-08-15T00:00:00.000Z"
    ))
    let index = PluginContributionIndex(
      contributions: [publishedForChat, publishedForTab],
      declarations: PluginSocketDeclarations(records: [record])
    )

    // 1. The chat the row was published for gets the published row, and the
    //    declaration it fills does not draw beside it.
    XCTAssertEqual(
      index.chatHeaderActions(sessionId: "chat-1").map { $0.chatHeaderAction?.label },
      ["Drink (3)"]
    )

    // 2. Every other chat gets the manifest declaration — a declared header
    //    action is for every conversation until a published row refines it.
    XCTAssertEqual(
      index.chatHeaderActions(sessionId: "chat-2").map { $0.chatHeaderAction?.label },
      ["Drink"]
    )

    // 3. The row published against the TAB is never drawn in a chat header.
    //
    // Guarded first: the row has to actually BE in the index, or this asserts
    // nothing. It survives the declaration join because it names a declared
    // socket id, so its absence below is the filing rule at work and not the
    // join quietly having discarded it.
    XCTAssertTrue(
      index.surfaceContributions(.work).contains { $0.chatHeaderAction?.label == "Tab wide" },
      "The tab row must survive into the index, or assertion 3 proves nothing."
    )
    for sessionId in ["chat-1", "chat-2"] {
      XCTAssertFalse(
        index.chatHeaderActions(sessionId: sessionId).contains { $0.chatHeaderAction?.label == "Tab wide" },
        "A row addressed to the Work tab must not appear in \(sessionId)'s header."
      )
    }
  }

  /// A manifest DECLARATION carries its split button whole.
  ///
  /// The declaration path is a second parser entry point, so the menu has to be
  /// threaded onto the payload the wire implies or a plugin that declared a
  /// split button — rather than publishing one per chat — silently loses half
  /// of it on the phone.
  func testDeclaredSplitButtonKeepsItsMenu() throws {
    let record = try JSONDecoder().decode(
      PluginInstallRecordEntry.self,
      from: Data(#"""
      { "pluginId": "ade-tipsy", "enabled": true, "sockets": [
          { "socket": "chat-header-action", "surface": "work", "id": "drink",
            "label": "Take a drink", "icon": "beer", "actionId": "tipsy.drink",
            "menu": [{ "label": "Sober up", "actionId": "tipsy.sober" }] }
      ] }
      """#.utf8)
    )
    let declarations = PluginSocketDeclarations(records: [record])
    // A per-entity declaration is a wildcard until a chat is named.
    let index = PluginContributionIndex(declarations: declarations)
    let entries = index.chatHeaderActions(sessionId: "sess-1")
    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(entries.first?.chatHeaderAction?.menu.map(\.actionId), ["tipsy.sober"])
    XCTAssertTrue(entries.first?.isDeclaration == true)
  }

  /// The split button: `menu[]` is what makes "sober up" reachable from the
  /// drink button instead of only from a slash command.
  func testActionMenuEntriesParseWithTheirRoles() throws {
    let contribution = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "session", entityId: "sess-1", pluginId: "ade-tipsy",
      socket: "chat-header-action",
      payloadJSON: #"""
      { "label": "3 drinks in!", "actionId": "tipsy.drink", "menu": [
          { "label": "Sober up", "actionId": "tipsy.sober", "icon": "sparkle" },
          { "label": "Forget tonight", "actionId": "tipsy.reset", "danger": true }
      ] }
      """#,
      updatedAt: ""
    ))
    let menu = try XCTUnwrap(contribution.chatHeaderAction?.menu)
    XCTAssertEqual(menu.count, 2)
    XCTAssertEqual(menu[0].label, "Sober up")
    XCTAssertEqual(menu[0].actionId, "tipsy.sober")
    XCTAssertFalse(menu[0].danger)
    XCTAssertTrue(menu[1].danger)
    XCTAssertEqual(menu[1].label, "Forget tonight")
    // `icon` now rides an entry, because desktop's `parsePluginActionButtonMenu`
    // keeps it: an entry could not carry a glyph at all, so every row in every
    // plugin's dropdown drew the same puzzle piece. The two clients read the
    // same field set — label, actionId, icon, danger — and a phone that ignored
    // one of them would invent a difference from a payload that did nothing
    // wrong.
    XCTAssertEqual(menu[0].icon, "sparkle")
    XCTAssertNil(menu[1].icon, "An entry that named no icon must not acquire one.")
  }

  /// A button's own tint, and the reason it is judged rather than trusted.
  ///
  /// The payload carries ONE colour while the user picks the theme, so a colour
  /// that reads on dark and vanishes on light is a button that is invisible for
  /// half the installs. The rule is transcribed from `sanitizePluginActionColor`
  /// and has to stay identical: a colour refused on the desktop must be refused
  /// here, or a plugin gets a legible button on one client and a blank one on
  /// the other.
  func testButtonColourIsTakenOnlyWhenItReadsInBothThemes() throws {
    func colour(_ raw: String) throws -> String? {
      try XCTUnwrap(PluginContributionParser.parse(
        entityKind: "session", entityId: "sess-1", pluginId: "ade-tipsy",
        socket: "chat-header-action",
        payloadJSON: #"{ "label": "Take a drink", "actionId": "tipsy.drink", "color": \#(raw) }"#,
        updatedAt: ""
      ), "colour \(raw) must never cost the plugin its button").chatHeaderAction?.color
    }

    /// The JSON literal for a string value, quotes included.
    func quoted(_ value: String) -> String { "\"\(value)\"" }

    // ADE's own accent, and a mid grey: both clear 3:1 against dark AND light.
    XCTAssertEqual(try colour(quoted("#7C6FF0")), "#7c6ff0")
    XCTAssertEqual(try colour(quoted("#888")), "#888888", "The 3-digit form expands.")

    // Legal hex, unreadable on one of the two backgrounds.
    for illegible in ["#ffffff", "#ffff00", "#000000", "#0000ff"] {
      XCTAssertNil(try colour(quoted(illegible)), "\(illegible) is invisible on one theme")
    }

    // Not plainly a colour at all — refused before contrast is considered.
    for junk in [quoted("red"), quoted("rgb(1,2,3)"), quoted("#12345"), quoted("7C6FF0"), "7", "null"] {
      XCTAssertNil(try colour(junk))
    }
  }

  /// A declared colour rides the same path a published one does, and a refused
  /// one costs the plugin the tint, never the button.
  func testDeclaredButtonColourIsJudgedTheSameWay() throws {
    func declared(_ colour: String) throws -> PluginContribution? {
      let record = try JSONDecoder().decode(
        PluginInstallRecordEntry.self,
        from: Data(#"""
        { "pluginId": "ade-tipsy", "enabled": true, "sockets": [
            { "socket": "chat-header-action", "surface": "work", "id": "drink",
              "label": "Take a drink", "actionId": "tipsy.drink", "color": "\#(colour)" }
        ] }
        """#.utf8)
      )
      let index = PluginContributionIndex(declarations: PluginSocketDeclarations(records: [record]))
      return index.chatHeaderActions(sessionId: "sess-1").first
    }

    XCTAssertEqual(try declared("#7C6FF0")?.chatHeaderAction?.color, "#7c6ff0")
    let refused = try XCTUnwrap(try declared("#ffffff"))
    XCTAssertEqual(refused.chatHeaderAction?.label, "Take a drink")
    XCTAssertNil(refused.chatHeaderAction?.color)
  }

  /// A `menu` this build cannot read must never cost the plugin its PRIMARY
  /// action — that is the part the reader can see and press.
  func testUnreadableMenuDegradesToAPlainButton() throws {
    for raw in ["null", #""sober-up""#, "7", #"{ "label": "Sober up" }"#] {
      let contribution = try XCTUnwrap(PluginContributionParser.parse(
        entityKind: "session", entityId: "sess-1", pluginId: "ade-tipsy",
        socket: "chat-header-action",
        payloadJSON: #"{ "label": "Take a drink", "actionId": "tipsy.drink", "menu": \#(raw) }"#,
        updatedAt: ""
      ), "menu: \(raw) should degrade, not drop the contribution")
      XCTAssertEqual(contribution.chatHeaderAction?.actionId, "tipsy.drink")
      XCTAssertTrue(contribution.chatHeaderAction?.menu.isEmpty == true)
    }
  }

  /// One bad entry drops on its own. A menu of three where one lost its
  /// `actionId` still opens with the other two.
  func testOneUnreadableMenuEntryDoesNotDropTheRest() throws {
    let contribution = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "session", entityId: "sess-1", pluginId: "ade-tipsy",
      socket: "composer-action",
      payloadJSON: #"""
      { "label": "Take a drink", "actionId": "tipsy.drink", "menu": [
          { "label": "Sober up", "actionId": "tipsy.sober" },
          { "label": "No action here" },
          "not-an-object",
          { "actionId": "tipsy.nolabel" },
          { "label": "Water", "actionId": "tipsy.water" }
      ] }
      """#,
      updatedAt: ""
    ))
    XCTAssertEqual(contribution.composerAction?.menu.map(\.actionId), ["tipsy.sober", "tipsy.water"])
  }

  func testActionMenuIsCappedAtParseTimeSoEverySurfaceAgrees() throws {
    let entries = (0..<20)
      .map { #"{ "label": "Action \#($0)", "actionId": "a.\#($0)" }"# }
      .joined(separator: ",")
    let contribution = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "surface", entityId: "work", pluginId: "graph",
      socket: "toolbar-action",
      payloadJSON: #"{ "label": "Rebuild", "actionId": "graph.rebuild", "menu": [\#(entries)] }"#,
      updatedAt: ""
    ))
    XCTAssertEqual(contribution.toolbarAction?.menu.count, pluginActionMenuEntryLimit)
  }

  /// A kind this build has no host for still drops rather than half-drawing,
  /// which is what lets a new socket ship on desktop first.
  func testAnUnknownSocketKindStillDropsItsRow() {
    XCTAssertNil(PluginContributionParser.parse(
      entityKind: "session", entityId: "sess-1", pluginId: "ade-tipsy",
      socket: "chat-background-fill",
      payloadJSON: #"{ "label": "Fill with beer", "actionId": "tipsy.fill" }"#,
      updatedAt: ""
    ))
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
