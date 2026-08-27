import XCTest
@testable import ADE

/// The decision table behind "does this surface exist on this phone".
///
/// Everything the gate answers is a hide-or-show, and every ambiguous case has
/// to fall on the same side: an entry point that opens a screen the attached
/// machine cannot serve reads as a broken app, while a missing one reads as an
/// uninstalled plugin. These tests pin that asymmetry — no answer yet, a failed
/// call, a disabled install and a host too old to be asked all resolve to
/// hidden, and only an installed-and-enabled reply resolves to shown.
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

  // MARK: - One-shot consults (deep links)

  func testDeepLinkWaitsForTheFirstAnswerInsteadOfReadingTheDefault() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    // A link tapped at cold launch: nothing has refreshed yet. Answering from
    // the pre-answer default would make the same URL open or not by timing.
    let allowed = await gate.awaitOwner(of: .linear)

    XCTAssertTrue(allowed)
    XCTAssertEqual(sync.fetchCount, 1)
  }

  func testDeepLinkReusesAnAnswerAlreadyResolvedForThisMachine() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)
    await gate.refresh()

    let allowed = await gate.awaitOwner(of: .linear)
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
    let allowed = await gate.awaitOwner(of: .linear)
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

  /// Linear's behaviour is unchanged by the polarity split, in every state the
  /// table above enumerates.
  ///
  /// `drawsBuiltin` is the predicate the entry points call now, so for an
  /// `.enables` surface it has to agree with `owns` everywhere — including in
  /// the unknowns, which is where the two polarities disagree and where a
  /// mistake would silently invert Linear.
  func testEnablesSurfacesDrawExactlyWhenTheyAreOwned() async {
    let sync = FakePresenceSync()
    let gate = PluginPresenceGate(sync: sync)

    // Before any answer.
    XCTAssertFalse(gate.owns(.linear))
    XCTAssertFalse(gate.drawsBuiltin(.linear))

    // Installed and enabled.
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    await gate.refresh()
    XCTAssertTrue(gate.owns(.linear))
    XCTAssertTrue(gate.drawsBuiltin(.linear))

    // Installed but disabled.
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear", enabled: false)])
    sync.pluginPresenceTrigger = "machine-a|1"
    await gate.refresh()
    XCTAssertFalse(gate.owns(.linear))
    XCTAssertFalse(gate.drawsBuiltin(.linear))

    // Unreachable.
    sync.failure = FetchFailure.unreachable
    await gate.refresh()
    XCTAssertFalse(gate.drawsBuiltin(.linear))

    // Host too old to be asked.
    sync.failure = nil
    sync.supportsPluginPresenceList = false
    await gate.refresh()
    XCTAssertFalse(gate.drawsBuiltin(.linear))
  }

  /// A machine with BOTH plugins moves each surface its own way at once, which
  /// is the case a single shared boolean would get wrong.
  func testOneAnswerMovesTheTwoPolaritiesInOppositeDirections() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [
      entry("ade-linear"),
      entry("ade-cursor-cloud"),
    ])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    XCTAssertTrue(gate.drawsBuiltin(.linear))
    XCTAssertFalse(gate.drawsBuiltin(.cursorCloud))
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
      [.enables, .enables, .enables, .enables, .enables, .enables, .supersedes]
    )
  }
}
