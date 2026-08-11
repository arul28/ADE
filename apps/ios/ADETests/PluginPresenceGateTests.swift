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

  // MARK: - Surface ids

  func testBuiltinSurfaceIdsMatchTheSharedManifestList() {
    // Mirrors `PLUGIN_BUILTIN_SURFACE_IDS` in
    // `apps/desktop/src/shared/plugins/manifest.ts`. A drift here gates the
    // wrong screen — or nothing at all, silently.
    XCTAssertEqual(
      PluginBuiltinSurface.allCases.map(\.rawValue),
      ["graph", "review", "history", "linear", "ios", "app-control"]
    )
    XCTAssertEqual(
      PluginBuiltinSurface.allCases.map(\.ownerPluginId),
      ["ade-graph", "ade-review", "ade-history", "ade-linear", "ade-ios-sim", "ade-app-control"]
    )
  }
}
