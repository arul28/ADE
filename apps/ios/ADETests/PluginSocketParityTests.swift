import XCTest
@testable import ADE

/// Contract fields the phone used to drop, and the narrowing rules it used to
/// apply more loosely than the desktop does.
///
/// Every case is a transcription check: the Swift answer against the TypeScript
/// in `apps/desktop/src/shared/plugins/`.
final class PluginSocketParityTests: XCTestCase {

  // MARK: - ownsSend

  private func composerButton(_ payloadJSON: String) -> PluginActionButtonPayload? {
    PluginContributionParser.parse(
      entityKind: "session",
      entityId: "chat-1",
      pluginId: "cloud",
      socket: "composer-action",
      payloadJSON: payloadJSON,
      updatedAt: ""
    )?.composerAction
  }

  /// The field existed on the wire and on the desktop and was parsed nowhere on
  /// the phone, so the Cursor Cloud launch button armed Send on one client and
  /// invoked on tap on the other.
  func testOwnsSendIsReadOffAPublishedComposerAction() throws {
    let armed = try XCTUnwrap(composerButton(
      #"{ "label": "Cloud", "actionId": "launch", "ownsSend": true }"#
    ))
    XCTAssertTrue(armed.ownsSend)

    let plain = try XCTUnwrap(composerButton(#"{ "label": "Cloud", "actionId": "launch" }"#))
    XCTAssertFalse(plain.ownsSend, "absent is not a claim")
  }

  /// Strictly the JSON boolean, matching `parsePluginContributionPayload`. A
  /// truthy number must not hand a plugin the composer's Send.
  func testOwnsSendRefusesAnythingButTheBooleanTrue() throws {
    for raw in ["1", "\"true\"", "false", "null"] {
      let button = try XCTUnwrap(composerButton(
        #"{ "label": "Cloud", "actionId": "launch", "ownsSend": \#(raw) }"#
      ))
      XCTAssertFalse(button.ownsSend, "ownsSend: \(raw) must not claim Send")
    }
  }

  /// The Cursor Cloud button is DECLARED and never published, so the claim has
  /// to survive the manifest path too.
  func testOwnsSendSurvivesTheDeclarationPath() throws {
    let index = PluginContributionIndex(
      contributions: [],
      declarations: PluginSocketDeclarations(records: [
        PluginInstallRecordEntry(
          pluginId: "cloud",
          enabled: true,
          sockets: [
            PluginManifestSocketWire(
              socket: "composer-action", surface: "work", id: "launch",
              label: "Cloud", actionId: "launch", ownsSend: true
            ),
          ],
          disabledContributions: []
        ),
      ])
    )
    let actions = index.composerActions(sessionId: "chat-1")
    XCTAssertEqual(actions.count, 1)
    XCTAssertTrue(actions.first?.composerAction?.ownsSend == true)
  }

  /// Decoded off the wire the host actually sends, and strictly.
  func testOwnsSendDecodesFromTheInstallRecordWire() throws {
    func wire(_ json: String) throws -> PluginManifestSocketWire {
      try JSONDecoder().decode(PluginManifestSocketWire.self, from: Data(json.utf8))
    }
    XCTAssertTrue(try wire(
      #"{"socket":"composer-action","surface":"work","id":"launch","ownsSend":true}"#
    ).ownsSend)
    XCTAssertFalse(try wire(
      #"{"socket":"composer-action","surface":"work","id":"launch"}"#
    ).ownsSend, "an older host sends no field and keeps Send with ADE")
    XCTAssertFalse(try wire(
      #"{"socket":"composer-action","surface":"work","id":"launch","ownsSend":1}"#
    ).ownsSend)
  }

  // MARK: - openSettings

  /// The closed list from `PLUGIN_OPEN_SETTINGS_ENTRY_IDS`, in both the string
  /// and the object form, with everything else refused.
  func testOpenSettingsHonoursTheClosedListInBothForms() {
    XCTAssertEqual(PluginInvokeResult.parseOpenSettings("agents.provider.cursor"), "agents.provider.cursor")
    XCTAssertEqual(PluginInvokeResult.parseOpenSettings(["entryId": "secrets.secrets"]), "secrets.secrets")
    XCTAssertEqual(PluginInvokeResult.parseOpenSettings("  secrets.secrets  "), "secrets.secrets")
    XCTAssertNil(PluginInvokeResult.parseOpenSettings("billing.plans"))
    XCTAssertNil(PluginInvokeResult.parseOpenSettings(["entryId": "agents.providers"]))
    XCTAssertNil(PluginInvokeResult.parseOpenSettings(7))
    XCTAssertNil(PluginInvokeResult.parseOpenSettings(nil))
  }

  /// A socket press can now name a settings page, and the notice says which
  /// machine holds it — the phone has no such page of its own.
  func testTheSettingsNoticeNamesThePageAndTheMachine() {
    let notice = PluginSettingsNotice(entryId: "agents.provider.cursor", pluginLabel: "Cursor Cloud")
    XCTAssertTrue(notice.message.contains("Cursor"))
    XCTAssertTrue(notice.message.contains("Mac"))
    XCTAssertTrue(
      PluginSettingsNotice(entryId: "secrets.secrets", pluginLabel: "Cursor Cloud").message.contains("Secrets")
    )
  }

  // MARK: - openUrl

  /// `readPluginActionOpenUrl` in `sdk.ts`: `https:` only, both the string and
  /// the object form, and never past `PLUGIN_URL_MAX_CHARS`. The socket path
  /// dropped the verb entirely, so a row menu item's "Open PR" worked on the
  /// desktop and did nothing on the phone.
  func testOpenUrlHonoursTheHttpsOnlyRuleAndTheCeiling() {
    XCTAssertEqual(
      PluginInvokeResult.parseOpenURL("https://github.com/anthropics/ade/pull/42")?.absoluteString,
      "https://github.com/anthropics/ade/pull/42"
    )
    XCTAssertEqual(
      PluginInvokeResult.parseOpenURL(["url": "https://cursor.com/agents"])?.absoluteString,
      "https://cursor.com/agents"
    )
    XCTAssertNotNil(PluginInvokeResult.parseOpenURL("  https://cursor.com/agents  "))
    for refused in [
      "http://cursor.com", "file:///etc/passwd", "javascript:alert(1)",
      "data:text/html,x", "ade://lane/1", "https://", "", "cursor.com",
    ] {
      XCTAssertNil(PluginInvokeResult.parseOpenURL(refused), "\(refused) must be refused")
    }
    XCTAssertNil(PluginInvokeResult.parseOpenURL(7))
    XCTAssertNil(PluginInvokeResult.parseOpenURL(nil))
    let overLong = "https://cursor.com/" + String(repeating: "a", count: PluginInvokeResult.maxOpenURLChars)
    XCTAssertNil(PluginInvokeResult.parseOpenURL(overLong), "the ceiling is PLUGIN_URL_MAX_CHARS")
  }

  // MARK: - The PR row's own ids

  /// `plugin_contributions` keys a PR row on its GitHub number, and the ADE
  /// review plugin validates on ADE's own pull-request id and the lane. The row
  /// carries them when the surface that drew it knew them.
  func testAPrRowMenuCarriesTheIdsTheSurfaceKnows() throws {
    let published = try XCTUnwrap(PluginContributionParser.parse(
      entityKind: "pr",
      entityId: "42",
      pluginId: "review",
      socket: "row-menu-item",
      payloadJSON: #"{ "label": "ADE review", "actionId": "review.start" }"#,
      updatedAt: ""
    ))
    XCTAssertNil(published.rowIdentity.prId, "an unstamped row still says nothing")

    let index = PluginContributionIndex(contributions: [published])
    let stamped = try XCTUnwrap(
      index.menuItems(forPrNumber: 42, prId: "pr-abc", laneId: "lane-9").first
    )
    XCTAssertEqual(stamped.rowIdentity.prId, "pr-abc")
    XCTAssertEqual(stamped.rowIdentity.laneId, "lane-9")
    XCTAssertEqual(stamped.menuItem?.actionId, "review.start", "stamping changes nothing else")
  }

  // MARK: - The rail tab surface

  /// `pluginRailTabSurface` in `manifest.ts`: the FIRST surface in manifest
  /// order whose kind is a rail kind. A webview-first manifest is the case that
  /// used to diverge — the desktop kept manifest order, the TUI took the first
  /// `kind == "tab"`, and this app took the first PANEL ROW with a surface,
  /// which is database order. A tab badge is addressed by
  /// `"<pluginId>/<surfaceId>"`, so those were two addresses for one pill.
  func testRailTabSurfaceIsTheFirstRailKindInManifestOrder() throws {
    let record = try JSONDecoder().decode(PluginInstallRecordEntry.self, from: Data(#"""
    {
      "pluginId": "cloud",
      "enabled": true,
      "sockets": [],
      "tabs": [
        { "id": "canvas", "title": "Canvas", "panelId": "canvas", "kind": "webview" },
        { "id": "fleet", "title": "Fleet", "panelId": "fleet", "kind": "tab" }
      ]
    }
    """#.utf8))
    XCTAssertEqual(record.tabs?.count, 2)
    XCTAssertEqual(pluginRailTabSurface(record.tabs)?.id, "canvas", "a webview first IS the rail tab")

    // Today's wire is already filtered and sends no `kind`, so the first entry
    // wins there too.
    XCTAssertEqual(
      pluginRailTabSurface([
        PluginManifestTabWire(id: "canvas"),
        PluginManifestTabWire(id: "fleet"),
      ])?.id,
      "canvas"
    )
    // A non-rail kind is skipped, not taken.
    XCTAssertEqual(
      pluginRailTabSurface([
        PluginManifestTabWire(id: "pane", kind: "pane"),
        PluginManifestTabWire(id: "fleet", kind: "tab"),
      ])?.id,
      "fleet"
    )
    XCTAssertNil(pluginRailTabSurface([PluginManifestTabWire(id: "pane", kind: "pane")]))
    XCTAssertNil(pluginRailTabSurface(nil), "an older host sends no tabs at all")

    // And the declarations carry the answer through for the entry list.
    let resolved = PluginSocketDeclarations(records: [record])
    XCTAssertEqual(resolved.railTabSurfaceId(for: "cloud"), "canvas")
    XCTAssertNil(
      PluginSocketDeclarations(records: [
        PluginInstallRecordEntry(pluginId: "old", enabled: true, sockets: []),
      ]).railTabSurfaceId(for: "old"),
      "no tabs on the wire means the caller keeps its panel-row fallback"
    )
  }

  /// `pluginRailTabSurface` in `manifest.ts` again, for the OPT-OUT.
  ///
  /// `ade-ios-sim` and `ade-app-control` declare a webview only so their Work
  /// pane has a page to draw; neither wants a rail entry, and both say so with
  /// `railTab: false`. The wire drops `kind`, so on this client that field is
  /// the ONLY thing left that can answer "is this a tab" — a phone that ignored
  /// it would list two entries the desktop and the terminal both hide.
  func testRailTabSurfaceHonoursTheOptOut() throws {
    let record = try JSONDecoder().decode(PluginInstallRecordEntry.self, from: Data(#"""
    {
      "pluginId": "ade-ios-sim",
      "enabled": true,
      "sockets": [],
      "tabs": [
        { "id": "sim", "title": "iOS Sim Control", "panelId": "main", "railTab": false }
      ]
    }
    """#.utf8))
    XCTAssertEqual(record.tabs?.count, 1, "the surface stays on the wire; only the rail skips it")
    XCTAssertEqual(record.tabs?.first?.railTab, false)
    XCTAssertNil(pluginRailTabSurface(record.tabs), "an opted-out page claims no rail tab")
    XCTAssertNil(PluginSocketDeclarations(records: [record]).railTabSurfaceId(for: "ade-ios-sim"))

    // Skipped rather than ending the search: a later surface still rails.
    XCTAssertEqual(
      pluginRailTabSurface([
        PluginManifestTabWire(id: "sim", railTab: false),
        PluginManifestTabWire(id: "fleet"),
      ])?.id,
      "fleet"
    )
    // Read BEFORE the kind, because the wire carries no kind at all.
    XCTAssertEqual(
      pluginRailTabSurface([
        PluginManifestTabWire(id: "sim", kind: "webview", railTab: false),
        PluginManifestTabWire(id: "fleet", kind: "tab"),
      ])?.id,
      "fleet"
    )
    // Absent means "claims a tab", which is what a host too old to send the
    // field was already drawing.
    XCTAssertEqual(pluginRailTabSurface([PluginManifestTabWire(id: "sim")])?.id, "sim")
    XCTAssertEqual(
      pluginRailTabSurface([PluginManifestTabWire(id: "sim", railTab: true)])?.id,
      "sim"
    )
  }

  /// `PluginManifestSurface.mobile` on a `webview`, which is an OPT-IN.
  ///
  /// The phone draws plugin pages now, so a webview surface can be a phone
  /// screen — but only when its author said so. Two conditions gate it here and
  /// both matter: `kind == "webview"` says there is a page at all, and
  /// `mobile == true` says it was meant for a phone. Promoting every webview on
  /// the first condition alone would redraw every installed plugin's desktop
  /// layout here at the next launch.
  func testPhonePageIsDrawnOnlyForAWebviewOptedIntoMobile() throws {
    func declarations(_ tabsJSON: String) throws -> PluginSocketDeclarations {
      let record = try JSONDecoder().decode(PluginInstallRecordEntry.self, from: Data("""
      { "pluginId": "cloud", "enabled": true, "sockets": [], "tabs": \(tabsJSON) }
      """.utf8))
      return PluginSocketDeclarations(records: [record])
    }

    // Opted in: the entry menu opens the plugin's own page.
    let optedIn = try declarations(#"""
    [{ "id": "fleet", "title": "Fleet", "panelId": "main", "kind": "webview", "mobile": true }]
    """#)
    XCTAssertEqual(optedIn.railWebviewSurfaceId(for: "cloud"), "fleet")
    XCTAssertEqual(optedIn.railTabSurfaceId(for: "cloud"), "fleet", "the badge address is unchanged")

    // The default: a page, but not one meant for this phone. The panel behind
    // it is what the entry menu opens, exactly as before.
    let notOptedIn = try declarations(#"""
    [{ "id": "fleet", "title": "Fleet", "panelId": "main", "kind": "webview" }]
    """#)
    XCTAssertNil(notOptedIn.railWebviewSurfaceId(for: "cloud"))
    XCTAssertEqual(notOptedIn.railTabSurfaceId(for: "cloud"), "fleet")

    // A `tab` is a panel on every client. `mobile` is true by default there and
    // must never turn it into a page.
    let panelTab = try declarations(#"""
    [{ "id": "fleet", "title": "Fleet", "panelId": "main", "kind": "tab", "mobile": true }]
    """#)
    XCTAssertNil(panelTab.railWebviewSurfaceId(for: "cloud"))

    // A host too old to send `kind` sends no `mobile` either, and its readers
    // were already drawing the panel. That must not change under it.
    let olderHost = try declarations(#"""
    [{ "id": "fleet", "title": "Fleet", "panelId": "main" }]
    """#)
    XCTAssertNil(olderHost.railWebviewSurfaceId(for: "cloud"))
    XCTAssertEqual(olderHost.railTabSurfaceId(for: "cloud"), "fleet")
  }

  // MARK: - Brand glyph viewBox

  /// `VIEWBOX_PATTERN` in `vocabularyBrandIcons.ts`. `Double(_:)` used to
  /// accept `nan` and `inf`, and a NaN width made every transform in the glyph
  /// NaN — the mark vanished on the phone while the desktop refused the icon.
  func testBrandGlyphViewBoxRefusesWhatTheDesktopRefuses() {
    func glyph(_ viewBox: String) -> PluginBrandGlyph? {
      PluginBrandGlyph.parse([
        "viewBox": viewBox,
        "paths": [["d": "M0 0 L1 1"]],
      ])
    }
    XCTAssertNotNil(glyph("0 0 24 24"))
    XCTAssertNotNil(glyph("-4 -4 24.5 24.5"))
    for refused in [
      "0 0 nan 24", "0 0 inf 24", "0 0 -inf 24", "0 0 1e3 24",
      "0 0 0x18 24", "0 0 +24 24", "0 0 24", "0 0 24 24 24", "0 0 24. 24",
      "0 0 .5 24", "a b c d",
    ] {
      XCTAssertNil(glyph(refused), "viewBox \"\(refused)\" must be refused")
    }
  }

  // MARK: - Markdown clamp

  /// The TypeScript counts UTF-16 code units. Counting graphemes cut the same
  /// document at a different place on the phone than on the desktop.
  func testMarkdownClampCountsUTF16CodeUnitsLikeTheHostDoes() {
    // Each emoji is two UTF-16 units and one Character. Ten of them is a
    // 20-unit document, which is over a 10-unit cap and under it by graphemes.
    let emoji = String(repeating: "😀", count: 10)
    let clamped = PluginVocabMarkdownParser.clamp(emoji, maxChars: 10)
    XCTAssertTrue(clamped.truncated, "twenty UTF-16 units is over a ten-unit cap")
    XCTAssertEqual(clamped.text.utf16.count, 10)

    // And it does not cut inside a surrogate pair: a Swift string cannot hold
    // the lone surrogate the TypeScript slice would produce, so an odd cap
    // rounds down to a whole character.
    let odd = PluginVocabMarkdownParser.clamp(emoji, maxChars: 9)
    XCTAssertEqual(odd.text.utf16.count, 8)
    XCTAssertTrue(odd.truncated)
  }

  /// The line rule still holds, and still measures the newline in UTF-16.
  func testMarkdownClampStillCutsAtTheLastCompleteLine() {
    let source = "line one\nline two\nline three"
    let clamped = PluginVocabMarkdownParser.clamp(source, maxChars: 20)
    XCTAssertEqual(clamped.text, "line one\nline two")
    XCTAssertTrue(clamped.truncated)

    // No newline in the second half of the window: the hard slice is honest.
    let prose = String(repeating: "a", count: 40)
    XCTAssertEqual(PluginVocabMarkdownParser.clamp(prose, maxChars: 10).text.count, 10)

    // Under the cap is untouched, ASCII or not.
    XCTAssertFalse(PluginVocabMarkdownParser.clamp("short", maxChars: 10).truncated)
    XCTAssertFalse(PluginVocabMarkdownParser.clamp("😀😀", maxChars: 10).truncated)
  }
}
