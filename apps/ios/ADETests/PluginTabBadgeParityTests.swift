import XCTest
@testable import ADE

/// The phone's half of the plugin-tab badge contract, and the parity fixes that
/// shipped with it.
///
/// Every case here failed on the code these tests arrived with. They are
/// written against behaviour rather than against structure, so a future rewrite
/// of the store or the parser still has to keep the promise.
final class PluginTabBadgeParityTests: XCTestCase {

  // MARK: - The viewer refcount

  /// Stands in for `SyncService`, recording every ack the pane sent.
  @MainActor
  private final class FakeViewSync: PluginPaneSyncing {
    var canInvokePluginActions = true
    var canFetchPluginPanelsRemotely = false
    var pluginFallbackScope = "machine-a"
    var supportsPluginAuthSessions = false

    var localPanels: [PluginPanelRecord] = []

    /// `(actionId, panelId, viewed)` in the order the store sent them. The
    /// ORDER is half the contract: a panel swap has to release the old pair
    /// before it acquires the new one.
    private(set) var acks: [(action: String, panelId: String, viewed: Bool)] = []

    func pluginPresenceCatalog() -> PluginPresenceCatalog { PluginPresenceCatalog() }

    func pluginPanels(pluginId: String?) -> [PluginPanelRecord] { localPanels }

    func pluginCollectionEntries(
      binding: PluginVocabBinding,
      pluginId: String,
      limit: Int
    ) -> [PluginCollectionEntry] { [] }

    func invokePluginAction(
      pluginId: String,
      actionId: String,
      payload: [String: Any]
    ) async throws -> PluginInvokeResult {
      acks.append((
        action: actionId,
        panelId: payload["panelId"] as? String ?? "",
        viewed: payload["viewed"] as? Bool ?? false
      ))
      return PluginInvokeResult()
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

  private static let schema = #"""
  {
    "v": 1,
    "title": "Fleet",
    "fallback": { "title": "Fleet", "text": "Open on the machine." },
    "body": [{ "component": "text", "text": "Rows." }]
  }
  """#

  @MainActor
  private func panel(_ panelId: String, viewAction: String?) -> PluginPanelRecord {
    PluginPanelRecord(
      pluginId: "cloud",
      panelId: panelId,
      title: panelId,
      icon: "",
      surface: "work",
      schemaJSON: Self.schema,
      vocabVersion: 1,
      updatedAt: "2026-09-02T10:00:00Z",
      mobile: true,
      refreshAction: nil,
      viewAction: viewAction
    )
  }

  @MainActor
  private func store(_ sync: FakeViewSync, panelId: String) -> PluginPaneStore {
    PluginPaneStore(
      pluginId: "cloud",
      panelId: panelId,
      sync: sync,
      fetchesMissingRows: false,
      fallbackCache: PluginPanelFallbackCache(),
      openExternalURL: { _ in }
    )
  }

  /// Every ack the store started is a detached task. Bounded, never slept on.
  private func settle() async {
    for _ in 0..<50 { await Task.yield() }
  }

  /// The leak this whole change exists for.
  ///
  /// Open the fleet panel (which declares `viewAction`), let the plugin
  /// navigate the pane to an agent panel that declares none, then close the
  /// sheet. The release has to name the FLEET panel and its action — the pane's
  /// current selection has neither.
  @MainActor
  func testReleaseNamesThePairThatWasAcquiredAfterANavigation() async {
    let sync = FakeViewSync()
    sync.localPanels = [
      panel("fleet", viewAction: "ackTabBadge"),
      panel("agent", viewAction: nil),
    ]
    let pane = store(sync, panelId: "fleet")
    pane.load()
    pane.acquireView()
    await settle()

    pane.navigate(to: PluginInvokeNavigation(panelId: "agent"))
    await settle()

    pane.releaseView()
    await settle()

    XCTAssertEqual(sync.acks.count, 2, "one acquire and one release, no more")
    XCTAssertEqual(sync.acks[0].action, "ackTabBadge")
    XCTAssertEqual(sync.acks[0].panelId, "fleet")
    XCTAssertTrue(sync.acks[0].viewed)
    // The bug: this used to be sent with the AGENT panel's id, or not at all,
    // and the plugin's viewer count never returned to zero.
    XCTAssertEqual(sync.acks[1].action, "ackTabBadge")
    XCTAssertEqual(sync.acks[1].panelId, "fleet")
    XCTAssertFalse(sync.acks[1].viewed)
  }

  /// A navigation BETWEEN two panels that both declare a view action releases
  /// the first before acquiring the second, so the plugin's count never rests
  /// at two for one reader.
  @MainActor
  func testPanelSwapReleasesBeforeItAcquires() async {
    let sync = FakeViewSync()
    sync.localPanels = [
      panel("fleet", viewAction: "ackFleet"),
      panel("runs", viewAction: "ackRuns"),
    ]
    let pane = store(sync, panelId: "fleet")
    pane.load()
    pane.acquireView()
    await settle()

    pane.selectPanel("runs")
    await settle()

    XCTAssertEqual(sync.acks.count, 3)
    XCTAssertEqual(sync.acks[1].action, "ackFleet")
    XCTAssertFalse(sync.acks[1].viewed, "the old pair is released first")
    XCTAssertEqual(sync.acks[2].action, "ackRuns")
    XCTAssertTrue(sync.acks[2].viewed)
  }

  /// A socket that drops between appear and disappear must not strand the
  /// badge. The acquire is gated on the socket; the release is not.
  @MainActor
  func testReleaseIsSentEvenWhenTheSocketHasSinceDropped() async {
    let sync = FakeViewSync()
    sync.localPanels = [panel("fleet", viewAction: "ackTabBadge")]
    let pane = store(sync, panelId: "fleet")
    pane.load()
    pane.acquireView()
    await settle()

    sync.canInvokePluginActions = false
    pane.releaseView()
    await settle()

    XCTAssertEqual(sync.acks.count, 2)
    XCTAssertFalse(sync.acks[1].viewed)
  }

  /// Appearing twice without an intervening disappear counts once. The store is
  /// re-created per present, but `onAppear` can fire more than once for one.
  @MainActor
  func testASecondAppearDoesNotDoubleCount() async {
    let sync = FakeViewSync()
    sync.localPanels = [panel("fleet", viewAction: "ackTabBadge")]
    let pane = store(sync, panelId: "fleet")
    pane.load()
    pane.acquireView()
    pane.acquireView()
    pane.load()
    await settle()

    XCTAssertEqual(sync.acks.count, 1)
  }

  /// A panel that declares no `viewAction` — every plugin but one — sends
  /// nothing at all.
  @MainActor
  func testAPanelWithNoViewActionSendsNothing() async {
    let sync = FakeViewSync()
    sync.localPanels = [panel("fleet", viewAction: nil)]
    let pane = store(sync, panelId: "fleet")
    pane.load()
    pane.acquireView()
    pane.releaseView()
    await settle()

    XCTAssertTrue(sync.acks.isEmpty)
  }

  // MARK: - Tab-badge entity ids

  /// `parsePluginTabContributionEntityId` in `shared/plugins/context.ts`:
  /// exactly one slash, with something on each side.
  func testTabBadgeEntityIdWantsExactlyOneSlash() {
    let app = PluginSurfaceId.app.rawValue
    XCTAssertEqual(PluginSocketDeclarations.surfaceRaw(entityKind: .surface, entityId: "cloud/fleet"), app)
    // All four used to be filed under `app` by a `contains("/")` check, and all
    // four are rows the desktop drops as unaddressable.
    XCTAssertNil(PluginSocketDeclarations.surfaceRaw(entityKind: .surface, entityId: "a/b/c"))
    XCTAssertNil(PluginSocketDeclarations.surfaceRaw(entityKind: .surface, entityId: "cloud/"))
    XCTAssertNil(PluginSocketDeclarations.surfaceRaw(entityKind: .surface, entityId: "/fleet"))
    XCTAssertNil(PluginSocketDeclarations.surfaceRaw(entityKind: .surface, entityId: "/"))
    // An ADE surface id still resolves to itself.
    XCTAssertEqual(
      PluginSocketDeclarations.surfaceRaw(entityKind: .surface, entityId: "work"),
      PluginSurfaceId.work.rawValue
    )
  }
}
