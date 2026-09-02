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
    var hasNegotiatedRemoteCommandCatalog = true
    /// The machine-and-install-set half of the trigger. The capability half is
    /// appended below, as `SyncService.pluginPresenceTrigger` does it, so a
    /// test that flips the catalog flag moves the trigger the same way a hello
    /// moves it in the app. The markers are the service's own constants, and
    /// `testTheRealTriggerCarriesTheCatalogComponent` pins that the service
    /// still builds its trigger from them.
    var triggerScope = "machine-a|0"
    var pluginPresenceTrigger: String {
      let catalog = hasNegotiatedRemoteCommandCatalog
        ? SyncService.pluginPresenceCatalogReadyMarker
        : SyncService.pluginPresenceCatalogPendingMarker
      return "\(triggerScope)|\(catalog)"
    }
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
    PluginPresenceListEntry(
      pluginId: pluginId,
      version: "1.0.0",
      enabled: enabled,
      displayName: pluginId
    )
  }

  /// Every surface a plugin REPLACES rather than enables, read off the table
  /// itself so a surface added with that polarity is covered the day it is
  /// added rather than the day someone remembers to write six more tests.
  ///
  /// The emptiness check is not decoration: each state below is a loop, and a
  /// loop over an empty list passes without asserting anything.
  private func supersededSurfaces(
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> [PluginBuiltinSurface] {
    let surfaces = PluginBuiltinSurface.allCases.filter { $0.presence == .supersedes }
    XCTAssertFalse(
      surfaces.isEmpty,
      "No `.supersedes` surface left; these loops would pass vacuously.",
      file: file,
      line: line
    )
    return surfaces
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
    sync.triggerScope = "machine-b|0"
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
    sync.duringFetch = { sync.triggerScope = "machine-b|0" }
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

  // Every state below runs over every `.supersedes` surface, because the
  // polarity belongs to the table rather than to Linear or to Cursor Cloud.
  // Each ships a pane this app has drawn in compiled SwiftUI since before the
  // plugin platform, so installing the plugin must REMOVE the built-in rather
  // than add a second way in, and every unknown must leave it up: a machine
  // that never heard of the plugin is the overwhelmingly common case, and
  // deleting a shipped feature because a round trip is late would do it at
  // every cold launch. `testSurfacePolarityMatchesTheSharedPresenceTable` pins
  // which surfaces these are; Linear is one of them, and is the one that
  // changed polarity, having started out as `.enables`.

  /// Both facts asserted together because they are one fact read from two
  /// directions: the plugin is owned, and precisely therefore the built-in is
  /// not drawn.
  func testInstallingASupersedingPluginTakesTheBuiltinAway() async {
    for surface in supersededSurfaces() {
      let sync = FakePresenceSync()
      sync.reply = PluginPresenceListResult(plugins: [entry(surface.ownerPluginId)])
      let gate = PluginPresenceGate(sync: sync)

      await gate.refresh()

      XCTAssertTrue(gate.owns(surface), "\(surface.rawValue)")
      XCTAssertFalse(
        gate.drawsBuiltin(surface),
        "\(surface.rawValue): the plugin draws its own entry; the built-in must be gone."
      )
    }
  }

  func testTheBuiltinIsDrawnBeforeAnyAnswerHasLanded() {
    for surface in supersededSurfaces() {
      let sync = FakePresenceSync()
      sync.reply = PluginPresenceListResult(plugins: [entry(surface.ownerPluginId)])
      let gate = PluginPresenceGate(sync: sync)

      // A cold launch renders here. The machine may well have the plugin — the
      // point is that nothing has said so yet, and a late reply must not be the
      // reason the built-in is missing.
      XCTAssertTrue(gate.drawsBuiltin(surface), "\(surface.rawValue)")
      XCTAssertEqual(sync.fetchCount, 0, "Rendering must not fire a round trip of its own.")
    }
  }

  func testTheBuiltinIsDrawnOnAMachineWithoutThePlugin() async {
    for surface in supersededSurfaces() {
      let sync = FakePresenceSync()
      // Another machine's plugin, positively answered. A reply that does not
      // name this owner is as good as an empty one for this surface.
      sync.reply = PluginPresenceListResult(plugins: [entry("ade-graph")])
      let gate = PluginPresenceGate(sync: sync)

      await gate.refresh()

      XCTAssertTrue(gate.drawsBuiltin(surface), "\(surface.rawValue)")
    }
  }

  func testDisablingTheSupersedingPluginHandsTheBuiltinBack() async {
    for surface in supersededSurfaces() {
      let sync = FakePresenceSync()
      sync.reply = PluginPresenceListResult(
        plugins: [entry(surface.ownerPluginId, enabled: false)]
      )
      let gate = PluginPresenceGate(sync: sync)

      await gate.refresh()

      // Disabling is the reversible half of uninstalling and has to restore
      // exactly as much: with the plugin off there is no plugin pane to open,
      // so hiding the built-in too would leave the feature nowhere on the phone.
      XCTAssertFalse(gate.owns(surface), "\(surface.rawValue)")
      XCTAssertTrue(gate.drawsBuiltin(surface), "\(surface.rawValue)")
    }
  }

  func testAFailedAnswerLeavesTheBuiltinUp() async {
    for surface in supersededSurfaces() {
      let sync = FakePresenceSync()
      sync.reply = PluginPresenceListResult(plugins: [entry(surface.ownerPluginId)])
      let gate = PluginPresenceGate(sync: sync)
      await gate.refresh()
      XCTAssertFalse(gate.drawsBuiltin(surface), "\(surface.rawValue)")

      // A dropped socket is not an answer, and deleting a shipped feature every
      // time the socket blinks is worse than showing a pane the plugin replaced.
      sync.failure = FetchFailure.unreachable
      await gate.refresh()

      XCTAssertTrue(gate.drawsBuiltin(surface), "\(surface.rawValue)")
    }
  }

  func testAHostTooOldToBeAskedKeepsTheBuiltin() async {
    for surface in supersededSurfaces() {
      let sync = FakePresenceSync()
      sync.supportsPluginPresenceList = false
      let gate = PluginPresenceGate(sync: sync)

      await gate.refresh()

      // Every host that predates the plugin platform still has the compiled
      // pane and no way to install a plugin that replaces it.
      XCTAssertTrue(gate.drawsBuiltin(surface), "\(surface.rawValue)")
      XCTAssertEqual(sync.fetchCount, 0)
    }
  }

  func testAttachingToAMachineWithoutThePluginBringsTheBuiltinBack() async {
    for surface in supersededSurfaces() {
      let sync = FakePresenceSync()
      sync.reply = PluginPresenceListResult(plugins: [entry(surface.ownerPluginId)])
      let gate = PluginPresenceGate(sync: sync)
      await gate.refresh()
      XCTAssertFalse(gate.drawsBuiltin(surface), "\(surface.rawValue)")

      // Plugins are installed per machine. The phone attaching elsewhere retires
      // the previous machine's list immediately, and the built-in is what the
      // new machine gets until it says otherwise.
      sync.triggerScope = "machine-b|0"
      sync.reply = PluginPresenceListResult(plugins: [])
      await gate.refresh()

      XCTAssertTrue(gate.drawsBuiltin(surface), "\(surface.rawValue)")
    }
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
    sync.triggerScope = "machine-a|1"
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

  // MARK: - Before the host's command catalog has arrived

  /// The window this whole section is about: the app has launched, the socket
  /// has not said hello, and the catalog restored from the last run says
  /// nothing about `plugins.presenceList`. An empty roster read there is not an
  /// answer, and recording one froze it — `ensureAnswer` never asks twice once
  /// `hasAnswer` is set.
  func testAnEmptyCatalogIsNotRecordedAsAnAnswer() async {
    let sync = FakePresenceSync()
    sync.hasNegotiatedRemoteCommandCatalog = false
    sync.supportsPluginPresenceList = false
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    XCTAssertFalse(gate.hasAnswer, "Nothing has asked the host; that is not an answer about it.")
    XCTAssertEqual(sync.fetchCount, 0, "There is no catalog yet to say the action exists.")
  }

  /// A host that predates the plugin platform still answers definitively, and
  /// must keep latching — the distinction this fix turns on.
  func testAHostThatNegotiatedACatalogWithoutTheActionAnswersDefinitively() async {
    let sync = FakePresenceSync()
    sync.hasNegotiatedRemoteCommandCatalog = true
    sync.supportsPluginPresenceList = false
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    XCTAssertTrue(gate.hasAnswer, "The catalog arrived and the action is not in it.")
    XCTAssertEqual(sync.fetchCount, 0)
  }

  /// The bug end to end. A cold-launch `ade://linear-issue/…` on a machine that
  /// HAS `ade-linear` used to open ADE's compiled pane, because the pre-hello
  /// empty roster read as "no plugin" and never refreshed. The hello now moves
  /// the trigger, so the next consult re-asks and answers correctly.
  func testTheAwaitedTwinReAnswersOnceTheCatalogArrives() async {
    let sync = FakePresenceSync()
    sync.hasNegotiatedRemoteCommandCatalog = false
    sync.supportsPluginPresenceList = false
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    // A link consumed in the pre-hello window still reads the `.supersedes`
    // default. That much is unchanged, and is the right default for a machine
    // nothing has heard from.
    let beforeHello = await gate.awaitDrawsBuiltin(.linear)
    XCTAssertTrue(beforeHello)
    XCTAssertEqual(sync.fetchCount, 0)

    // The hello lands: the catalog is negotiated, the action is in it, and the
    // trigger has moved.
    sync.hasNegotiatedRemoteCommandCatalog = true
    sync.supportsPluginPresenceList = true

    let afterHello = await gate.awaitDrawsBuiltin(.linear)
    XCTAssertFalse(afterHello, "The machine has the plugin; the link belongs to its panels.")
    XCTAssertEqual(sync.fetchCount, 1, "The arrival of the catalog is what re-ran the consult.")
  }

  /// The half the fake cannot prove about itself: that the real service builds
  /// its trigger from the readiness flag at all. Without this component the
  /// hello never retires a pre-hello answer, whatever the gate does.
  func testTheRealTriggerCarriesTheCatalogComponent() {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    let service = SyncService(database: database)
    defer { service.disconnect(clearCredentials: false) }

    XCTAssertNotEqual(
      SyncService.pluginPresenceCatalogPendingMarker,
      SyncService.pluginPresenceCatalogReadyMarker,
      "Identical markers would leave the trigger unmoved when the hello lands."
    )
    XCTAssertFalse(
      service.hasNegotiatedRemoteCommandCatalog,
      "A service that has not connected has negotiated nothing."
    )
    XCTAssertTrue(
      service.pluginPresenceTrigger.hasSuffix("|\(SyncService.pluginPresenceCatalogPendingMarker)"),
      "The trigger must carry the readiness marker: \(service.pluginPresenceTrigger)"
    )
  }

  private func makeTemporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("plugin-presence-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  // MARK: - A lane's issue ref, which is only sometimes Linear's

  private func ref(provider: String) -> IssueRef {
    IssueRef(
      pluginId: provider == IssueRef.providerLinear ? IssueRef.corePluginId : "ade-\(provider)",
      provider: provider,
      issueId: "1",
      key: "ABC-1",
      title: "A ref"
    )
  }

  /// A lane row carries whatever tracker wrote it, so the Linear polarity may
  /// not be the question at all. `ade-linear` supersedes a Linear ref's badge
  /// and menu row; a Jira ref is the Jira plugin's, and hiding it when
  /// `ade-linear` arrives would delete another plugin's affordance.
  func testOnlyALinearRefAnswersToTheLinearPlugin() async {
    let sync = FakePresenceSync()
    sync.reply = PluginPresenceListResult(plugins: [entry("ade-linear")])
    let gate = PluginPresenceGate(sync: sync)

    await gate.refresh()

    XCTAssertFalse(gate.drawsBuiltinAffordance(for: ref(provider: IssueRef.providerLinear)))
    XCTAssertTrue(gate.drawsBuiltinAffordance(for: ref(provider: "jira")))
  }

  /// The same unknowns as every other Linear affordance: the badge stays up.
  func testALinearRefKeepsItsAffordanceUntilThePluginIsPositivelyThere() async {
    let sync = FakePresenceSync()
    let gate = PluginPresenceGate(sync: sync)
    let linear = ref(provider: IssueRef.providerLinear)

    // Before any answer.
    XCTAssertTrue(gate.drawsBuiltinAffordance(for: linear))

    // A machine that does not have the plugin.
    sync.reply = PluginPresenceListResult(plugins: [])
    await gate.refresh()
    XCTAssertTrue(gate.drawsBuiltinAffordance(for: linear))

    // A dropped socket.
    sync.failure = FetchFailure.unreachable
    await gate.refresh()
    XCTAssertTrue(gate.drawsBuiltinAffordance(for: linear))
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
    // Weaker than the check above it, and knowingly so. `rawValue` has a
    // desktop mirror to disagree with; the surface-to-owner map has none, so
    // this array is a hand-written copy of the switch it checks and it catches
    // an accidental edit rather than a wrong id. The checkable source of truth
    // is the directory names under `plugins/`, and reading those from a Swift
    // test needs a cross-language check this branch does not have. Do not read
    // a passing run as proof that these seven plugins exist.
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
      [.enables, .supersedes, .supersedes, .supersedes, .enables, .enables, .supersedes]
    )
  }
}
