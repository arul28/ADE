import XCTest
@testable import ADE

/// The decision table behind "does this surface exist on this phone".
///
/// The gate answers one thing — is this plugin installed and enabled on the
/// attached machine — and every ambiguous case falls the same way: no answer
/// yet, a failed call, a disabled install and a host too old to be asked all
/// read as "not installed", because an entry point that opens a screen the
/// machine cannot serve reads as a broken app while a missing one reads as an
/// uninstalled plugin. These tests pin that asymmetry through ``owns(_:)``.
///
/// What that answer does to PIXELS is a second question, and the two polarities
/// answer it in opposite directions from the same reply. An `.enables` surface
/// draws only on a positive answer. A `.supersedes` surface — Linear and Cursor
/// Cloud, the two panes this app compiles — draws on every unknown and hides
/// only on a positive answer, because the compiled pane is what the product did
/// before the plugin existed and a slow socket must not delete a feature. These
/// tests pin that split through ``drawsBuiltin(_:)`` and its awaited twin.
@MainActor
final class PluginPresenceGateTests: XCTestCase {
  private enum FetchFailure: Error { case unreachable }

  /// Stands in for `SyncService`. Counts round trips so the tests can tell a
  /// cached answer from a fresh one.
  @MainActor
  private final class FakePresenceSync: PluginPresenceGateSyncing {
    var supportsPluginPresenceList = true
    var pluginPresenceTrigger = "machine-a|0"
    var reply = PluginPresenceListResult()
    var failure: Error?
    var fetchCount = 0
    /// Runs inside the fetch, before it returns — lets a test model the phone
    /// attaching to a different machine while a round trip is in flight.
    var duringFetch: (@MainActor () -> Void)?

    func fetchAttachedMachinePlugins() async throws -> PluginPresenceListResult {
      fetchCount += 1
      duringFetch?()
      if let failure = failure { throw failure }
      return reply
    }
  }

  private func entry(_ pluginId: String, enabled: Bool = true) -> PluginPresenceListEntry {
    PluginPresenceListEntry(pluginId: pluginId, version: "1.0.0", enabled: enabled, displayName: "Linear")
  }

  // MARK: - Decision table

  func testNothingIsShownBeforeTheFirstAnswer() {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    // No refresh has run. The machine may well have Linear installed — the
    // point is that nothing has said so yet, and the pre-answer default is the
    // one a cold launch renders with.
    XCTAssertFalse(gate.owns(.linear))
    XCTAssertEqual(sync.fetchCount, 0, "Rendering must not fire a round trip of its own.")
  }

  func testInstalledAndEnabledPluginIsShown() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    XCTAssertTrue(gate.owns(.linear))
    XCTAssertTrue(gate.isInstalled("ade-linear"))
  }

  func testInstalledButDisabledPluginIsHidden() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear", enabled: false)])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    // Disabling is the reversible half of uninstalling and has to hide exactly
    // as much: the pane's host command refuses a disabled plugin, so an entry
    // point left behind would open a sheet that cannot load.
    XCTAssertFalse(gate.owns(.linear))
  }

  func testFailedCallHidesRatherThanKeepingTheLastAnswer() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()
    XCTAssertTrue(gate.owns(.linear))

    // `plugins.presenceList` also throws when the machine has no plugin host
    // bound at all, so a throw can mean "this machine cannot serve the pane"
    // just as easily as "the socket blinked". Clear, do not keep.
    sync.failure = FetchFailure.unreachable
    await gate.refresh()

    XCTAssertFalse(gate.owns(.linear))
  }

  func testHostThatCannotAnswerPresenceHidesWithoutAsking() async {
    let sync = FakePresenceSync()
    sync.supportsPluginPresenceList = false
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    // Every host that predates the plugin platform. The action is not in its
    // advertised set, so asking would fail the outbound allowlist — the surface
    // simply is not there.
    XCTAssertFalse(gate.owns(.linear))
    XCTAssertEqual(sync.fetchCount, 0)
  }

  func testEntryWithoutAPluginIdCannotShowAnything() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [
      PluginPresenceListEntry(pluginId: "", enabled: true, displayName: "Linear"),
    ])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    XCTAssertFalse(gate.owns(.linear))
    XCTAssertFalse(gate.isInstalled(""))
  }

  // MARK: - Which machine the answer belongs to

  func testAttachingToADifferentMachineHidesUntilThatMachineAnswers() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()
    XCTAssertTrue(gate.owns(.linear))

    // The phone attaches elsewhere. Until the new machine has answered, the
    // previous machine's install list says nothing about this one.
    sync.pluginPresenceTrigger = "machine-b|0"
    sync.reply = PluginPresenceListResult(plugins: [])
    await gate.refresh()

    XCTAssertFalse(gate.owns(.linear))
    XCTAssertEqual(sync.fetchCount, 2)
  }

  func testReplyForAMachineTheUserLeftIsDropped() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    // The machine changes while the round trip is out: the reply describes a
    // machine this phone is no longer talking to, and applying it would show
    // Linear on a machine that may not have it.
    sync.duringFetch = { sync.pluginPresenceTrigger = "machine-b|0" }
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    XCTAssertFalse(gate.owns(.linear))
  }

  // MARK: - One-shot consults, at the plugin level

  /// `awaitInstalled` is the plugin-id form, which an `ade://plugin/...` link
  /// uses to decide whether the plugin's OWN panel can open. It is not the form
  /// a compiled screen asks — see the `awaitDrawsBuiltin` tests below.
  func testDeepLinkWaitsForTheFirstAnswerInsteadOfReadingTheDefault() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    // A link tapped at cold launch: nothing has refreshed yet. Answering from
    // the pre-answer default would make the same URL open or not by timing.
    let allowed = await gate.awaitInstalled("ade-linear")

    XCTAssertTrue(allowed)
    XCTAssertEqual(sync.fetchCount, 1)
  }

  func testDeepLinkReusesAnAnswerAlreadyResolvedForThisMachine() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()

    let allowed = await gate.awaitInstalled("ade-linear")
    XCTAssertTrue(allowed)
    XCTAssertEqual(sync.fetchCount, 1, "A resolved machine must not be re-asked per link.")
  }

  func testDeepLinkRetriesAfterAFailedCallRatherThanTreatingItAsUninstalled() async {
    let sync = FakePresenceSync()
    sync.failure = FetchFailure.unreachable
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()
    XCTAssertFalse(gate.owns(.linear))

    // A dropped socket is not an answer. The next link asks again — and a link
    // that arrives while the machine is unreachable still resolves to hidden.
    sync.failure = nil
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let allowed = await gate.awaitInstalled("ade-linear")
    XCTAssertTrue(allowed)
    XCTAssertEqual(sync.fetchCount, 2)
  }

  // MARK: - Superseding plugins (the opposite polarity)

  /// The whole point of `.supersedes`, stated once.
  ///
  /// `ade-cursor-cloud` ships the pane this app has drawn in compiled SwiftUI
  /// since before the plugin existed, so installing it must REMOVE the built-in
  /// rather than add a second way in. Both facts are asserted together because
  /// they are the same fact read from two directions: the plugin is owned, and
  /// precisely therefore the built-in is not drawn.
  func testInstallingTheSupersedingPluginTakesTheBuiltinAway() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-cursor-cloud")])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    XCTAssertTrue(gate.owns(.cursorCloud))
    XCTAssertFalse(
      gate.drawsBuiltin(.cursorCloud),
      "The plugin draws its own Cursor Cloud entry; the built-in one must be gone."
    )
  }

  /// Every unknown, and they all fall the other way from `.enables`.
  ///
  /// A machine that has never heard of the plugin is the overwhelmingly common
  /// case, and on it the phone must behave exactly as it did before the plugin
  /// shipped. So does a phone that has not had an answer yet, a host too old to
  /// be asked, and a socket that dropped — hiding a shipped feature because a
  /// round trip is late would delete Cursor Cloud from the product at every cold
  /// launch.
  func testTheBuiltinIsDrawnBeforeAnyAnswerHasLanded() {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-cursor-cloud")])
    let gate = PluginPresenceGate(sync: sync)

    XCTAssertTrue(gate.drawsBuiltin(.cursorCloud))
    XCTAssertEqual(sync.fetchCount, 0, "Rendering must not fire a round trip of its own.")
  }

  func testTheBuiltinIsDrawnOnAMachineWithoutThePlugin() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    XCTAssertTrue(gate.drawsBuiltin(.cursorCloud))
  }

  func testDisablingTheSupersedingPluginHandsTheBuiltinBack() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-cursor-cloud", enabled: false)])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    // Disabling is the reversible half of uninstalling and has to restore
    // exactly as much: with the plugin off there is no plugin pane to open, so
    // hiding the built-in too would leave no Cursor Cloud anywhere on the phone.
    XCTAssertFalse(gate.owns(.cursorCloud))
    XCTAssertTrue(gate.drawsBuiltin(.cursorCloud))
  }

  func testAFailedAnswerLeavesTheBuiltinUp() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-cursor-cloud")])
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()
    XCTAssertFalse(gate.drawsBuiltin(.cursorCloud))

    sync.failure = FetchFailure.unreachable
    await gate.refresh()

    XCTAssertTrue(gate.drawsBuiltin(.cursorCloud))
  }

  func testAHostTooOldToBeAskedKeepsTheBuiltin() async {
    let sync = FakePresenceSync()
    sync.supportsPluginPresenceList = false
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    // Every host that predates the plugin platform still has the compiled
    // Cursor Cloud pane and no way to install a plugin that replaces it.
    XCTAssertTrue(gate.drawsBuiltin(.cursorCloud))
    XCTAssertEqual(sync.fetchCount, 0)
  }

  func testAttachingToAMachineWithoutThePluginBringsTheBuiltinBack() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-cursor-cloud")])
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()
    XCTAssertFalse(gate.drawsBuiltin(.cursorCloud))

    // Plugins are installed per machine. The phone attaching elsewhere retires
    // the previous machine's list immediately, and the built-in is what the new
    // machine gets until it says otherwise.
    sync.pluginPresenceTrigger = "machine-b|0"
    sync.reply = PluginPresenceListResult(plugins: [])
    await gate.refresh()

    XCTAssertTrue(gate.drawsBuiltin(.cursorCloud))
  }

  // MARK: - The `.enables` surfaces keep their polarity

  /// An `.enables` surface reads `drawsBuiltin` and `owns` the same way in every
  /// state the table above enumerates.
  ///
  /// `.graph` stands for the whole `.enables` half: the phone has no compiled
  /// Graph screen, so the plugin is the only thing that could put one there, and
  /// every unknown must hide. `drawsBuiltin` is the predicate the entry points
  /// call, so it has to agree with `owns` here — including in the unknowns,
  /// which is exactly where the two polarities disagree and where a mistake
  /// would silently invert a surface.
  func testEnablesSurfacesDrawExactlyWhenTheyAreOwned() async {
    let sync = FakePresenceSync()
    let gate = PluginPresenceGate(sync: sync)

    // Before any answer.
    XCTAssertFalse(gate.owns(.graph))
    XCTAssertFalse(gate.drawsBuiltin(.graph))

    // Installed and enabled.
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-graph")])
    await gate.refresh()
    XCTAssertTrue(gate.owns(.graph))
    XCTAssertTrue(gate.drawsBuiltin(.graph))

    // Installed but disabled.
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-graph", enabled: false)])
    sync.pluginPresenceTrigger = "machine-a|1"
    await gate.refresh()
    XCTAssertFalse(gate.owns(.graph))
    XCTAssertFalse(gate.drawsBuiltin(.graph))

    // Unreachable.
    sync.failure = FetchFailure.unreachable
    await gate.refresh()
    XCTAssertFalse(gate.drawsBuiltin(.graph))

    // Host too old to be asked.
    sync.failure = nil
    sync.supportsPluginPresenceList = false
    await gate.refresh()
    XCTAssertFalse(gate.drawsBuiltin(.graph))
  }

  /// A machine with BOTH plugins moves each surface its own way at once, which
  /// is the case a single shared boolean would get wrong.
  ///
  /// `ade-graph` enables a screen the phone does not compile, and `ade-linear`
  /// replaces one it does. One reply, two surfaces, opposite results.
  func testOneAnswerMovesTheTwoPolaritiesInOppositeDirections() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [
      entry("ade-graph"),
      entry("ade-linear"),
    ])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    XCTAssertTrue(gate.owns(.graph))
    XCTAssertTrue(gate.owns(.linear))
    XCTAssertTrue(gate.drawsBuiltin(.graph))
    XCTAssertFalse(
      gate.drawsBuiltin(.linear),
      "One reply must move an enabled surface up and a superseded one down."
    )
  }

  // MARK: - Linear, the surface that changed polarity

  /// Linear used to be an `.enables` surface and is now `.supersedes`, so these
  /// six states are the ones a mistake would invert. ADE compiles a Linear pane
  /// and has shipped it since before the plugin platform, so the pane is the
  /// default and `ade-linear` is what takes it away.

  func testTheCompiledLinearPaneIsDrawnBeforeAnyAnswerHasLanded() {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    // A cold launch renders here. The machine may well have the plugin — the
    // point is that nothing has said so yet, and a late reply must not be the
    // reason the Linear button is missing from the top bar.
    XCTAssertTrue(gate.drawsBuiltin(.linear))
    XCTAssertEqual(sync.fetchCount, 0, "Rendering must not fire a round trip of its own.")
  }

  func testInstallingTheLinearPluginTakesTheCompiledPaneAway() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    // Both directions of the same fact: the plugin is owned, and precisely
    // therefore the compiled pane is not drawn. `ade-linear` brings its own
    // panels and its own Linear connection, so a second Linear entry point and
    // a second connect card would be the confusion the gate exists to prevent.
    XCTAssertTrue(gate.owns(.linear))
    XCTAssertFalse(gate.drawsBuiltin(.linear))
  }

  func testDisablingTheLinearPluginHandsTheCompiledPaneBack() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear", enabled: false)])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    // Disabling is the reversible half of uninstalling and restores exactly as
    // much: with the plugin off there are no plugin panels to open, so hiding
    // the compiled pane too would leave no Linear anywhere on the phone.
    XCTAssertFalse(gate.owns(.linear))
    XCTAssertTrue(gate.drawsBuiltin(.linear))
  }

  func testAFailedAnswerLeavesTheCompiledLinearPaneUp() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()
    XCTAssertFalse(gate.drawsBuiltin(.linear))

    // A dropped socket is not an answer, and deleting a shipped feature every
    // time the socket blinks is worse than showing a pane the plugin replaced.
    sync.failure = FetchFailure.unreachable
    await gate.refresh()

    XCTAssertTrue(gate.drawsBuiltin(.linear))
  }

  func testAHostTooOldToBeAskedKeepsTheCompiledLinearPane() async {
    let sync = FakePresenceSync()
    sync.supportsPluginPresenceList = false
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    // Every host that predates the plugin platform still has the compiled
    // Linear pane and no way to install a plugin that replaces it.
    XCTAssertTrue(gate.drawsBuiltin(.linear))
    XCTAssertEqual(sync.fetchCount, 0)
  }

  func testAttachingToAMachineWithoutTheLinearPluginBringsTheCompiledPaneBack() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()
    XCTAssertFalse(gate.drawsBuiltin(.linear))

    // Plugins are installed per machine. The phone attaching elsewhere retires
    // the previous machine's list immediately, and the compiled pane is what the
    // new machine gets until it says otherwise.
    sync.pluginPresenceTrigger = "machine-b|0"
    sync.reply = PluginPresenceListResult(plugins: [])
    await gate.refresh()

    XCTAssertTrue(gate.drawsBuiltin(.linear))
  }

  // MARK: - The awaited, polarity-aware twin

  /// `awaitDrawsBuiltin` is what a decision with no second chance calls. The
  /// `ade://linear-issue` deep link is consumed once, so reading the pre-answer
  /// default would open the compiled pane on a machine that has `ade-linear`,
  /// purely because the socket had not replied yet.

  func testAwaitedGateWaitsForTheFirstAnswerBeforeRefusingTheCompiledPane() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    // A link tapped at cold launch: nothing has refreshed yet, and the render
    // default here says "draw the compiled pane". The awaited form must ask.
    let drawsBuiltin = await gate.awaitDrawsBuiltin(.linear)

    XCTAssertFalse(drawsBuiltin, "The machine has the plugin, so the link belongs to its panels.")
    XCTAssertEqual(sync.fetchCount, 1)
  }

  func testAwaitedGateOpensTheCompiledPaneOnAMachineWithoutThePlugin() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [])
    let gate = PluginPresenceGate(sync: sync)

    let drawsBuiltin = await gate.awaitDrawsBuiltin(.linear)

    // The overwhelmingly common machine, and the one the app shipped for. The
    // link opens exactly the pane it always has.
    XCTAssertTrue(drawsBuiltin)
    XCTAssertEqual(sync.fetchCount, 1)
  }

  func testAwaitedGateReusesAnAnswerAlreadyResolvedForThisMachine() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()

    let drawsBuiltin = await gate.awaitDrawsBuiltin(.linear)

    XCTAssertFalse(drawsBuiltin)
    XCTAssertEqual(sync.fetchCount, 1, "A resolved machine must not be re-asked per link.")
  }

  func testAwaitedGateRetriesAfterAFailedCallRatherThanTrustingIt() async {
    let sync = FakePresenceSync()
    sync.failure = FetchFailure.unreachable
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()
    XCTAssertTrue(gate.drawsBuiltin(.linear))

    // A failed call is left unanswered on purpose, so the next link asks again
    // instead of treating a dropped socket as "no plugin, forever".
    sync.failure = nil
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let drawsBuiltin = await gate.awaitDrawsBuiltin(.linear)

    XCTAssertFalse(drawsBuiltin)
    XCTAssertEqual(sync.fetchCount, 2)
  }

  /// The twin reads the same table `drawsBuiltin` does, so it must invert for an
  /// `.enables` surface too. A polarity-blind awaited form is the trap this
  /// replaces, and it would answer both of these the same way.
  func testAwaitedGateKeepsTheEnablesPolarityToo() async {
    let installed = FakePresenceSync()
    installed.reply = PluginPresenceListResult(plugins: [entry("ade-graph")])
    let withPlugin = PluginPresenceGate(sync: installed)
    let graphWithPlugin = await withPlugin.awaitDrawsBuiltin(.graph)
    XCTAssertTrue(graphWithPlugin, "An `.enables` surface exists only while its plugin does.")

    let bare = FakePresenceSync()
    bare.reply = PluginPresenceListResult(plugins: [])
    let withoutPlugin = PluginPresenceGate(sync: bare)
    let graphWithoutPlugin = await withoutPlugin.awaitDrawsBuiltin(.graph)
    let linearWithoutPlugin = await withoutPlugin.awaitDrawsBuiltin(.linear)
    XCTAssertFalse(graphWithoutPlugin)
    XCTAssertTrue(linearWithoutPlugin, "The same empty reply moves the two surfaces apart.")
  }

  // MARK: - Surface ids

  func testBuiltinSurfaceIdsMatchTheSharedManifestList() {
    // Mirrors `PLUGIN_BUILTIN_SURFACE_IDS` in
    // `apps/desktop/src/shared/plugins/manifest.ts`. A drift here gates the
    // wrong screen — or nothing at all, silently.
    XCTAssertEqual(
      PluginBuiltinSurface.allCases.map(\.rawValue),
      ["graph", "review", "history", "linear", "ios", "app-control", "cursor-cloud"]
    )
    XCTAssertEqual(
      PluginBuiltinSurface.allCases.map(\.ownerPluginId),
      [
        "ade-graph", "ade-review", "ade-history", "ade-linear", "ade-ios-sim",
        "ade-app-control", "ade-cursor-cloud",
      ]
    )
  }

  /// Mirrors `PLUGIN_BUILTIN_SURFACE_PRESENCE` in
  /// `apps/desktop/src/shared/plugins/manifest.ts`.
  ///
  /// Asserted as a whole table rather than one case, because the failure this
  /// catches is a NEW surface silently defaulting to the wrong polarity: an
  /// `.enables` surface written as `.supersedes` ships a screen on every machine
  /// that never had the plugin, and the reverse deletes one.
  func testSurfacePolarityMatchesTheSharedPresenceTable() {
    XCTAssertEqual(
      PluginBuiltinSurface.allCases.map(\.presence),
      [.enables, .enables, .enables, .supersedes, .enables, .enables, .supersedes]
    )
  }
}
