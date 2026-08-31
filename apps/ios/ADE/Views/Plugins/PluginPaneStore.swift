import SwiftUI

/// The narrow slice of `SyncService` a plugin pane needs, so the pane can be
/// driven by a stub in tests and cannot reach anything else. Same shape as
/// `LinearPaneSyncing`.
@MainActor
protocol PluginPaneSyncing: AnyObject {
  var canInvokePluginActions: Bool { get }
  func pluginPresenceCatalog() -> PluginPresenceCatalog
  func pluginPanels(pluginId: String?) -> [PluginPanelRecord]
  func pluginCollectionEntries(binding: PluginVocabBinding, pluginId: String, limit: Int) -> [PluginCollectionEntry]
  func invokePluginAction(pluginId: String, actionId: String, payload: [String: Any]) async throws -> PluginInvokeResult

  // MARK: Live reads, for what the mirror is missing

  /// Whether the attached machine advertises the panel read at all.
  var canFetchPluginPanelsRemotely: Bool { get }
  /// Which machine's project the fetched rows would belong to.
  var pluginFallbackScope: String { get }
  /// One panel, read live. `nil` means the machine says there is no such panel.
  func fetchPluginPanel(pluginId: String, panelId: String) async throws -> PluginPanelRecord?
  /// Rows of one collection, read live.
  func fetchPluginCollectionEntries(
    pluginId: String,
    collection: String,
    keyPrefix: String?,
    limit: Int
  ) async throws -> [PluginCollectionEntry]

  // MARK: Sign-in, brokered by the machine

  /// Whether the attached machine can take a sign-in callback back. Read before
  /// the browser opens, so a phone that could not deliver the answer says so
  /// instead of walking the reader through a sign-in that goes nowhere.
  var supportsPluginAuthSessions: Bool { get }
  /// Hand back exactly what the provider returned. The machine routes it by the
  /// `state` it minted; the phone names no plugin and no session.
  func completePluginAuthSession(params: [String: String]) async throws
}

extension SyncService: PluginPaneSyncing {}

/// What the pane should draw for a panel.
///
/// The three failure members exist separately because they earn different copy.
/// `updateRequired` is the only one that is the app's fault and the only one
/// that should ever tell a user to update; the others are the plugin's problem
/// and say so without implying the phone is behind.
enum PluginPanelPresentation: Equatable {
  case panel(PluginPanelSchema)
  /// The panel declares a vocabulary version this build cannot interpret.
  case updateRequired(PluginPanelFallback?)
  /// Structurally unusable — bad JSON, no `fallback`, over the node ceiling.
  case damaged(PluginPanelFallback?)
  /// The MACHINE says there is no such panel: it answered the live read with
  /// nothing, or the panel it has is one it marked desktop-only. This is the
  /// only state that may tell a user the plugin published nothing.
  case missing
  /// The phone has no copy of the panel and cannot say the plugin is at fault.
  ///
  /// Its own state because the copy has to be different. A missing mirror row
  /// used to render as ``missing``, which told users a plugin that HAD
  /// published was empty — the P0 this state exists to stop.
  case notReceived(PluginPanelFetchGap)
}

/// Why a panel is not on screen when the plugin is not the reason.
enum PluginPanelFetchGap: Equatable {
  /// The live read is running right now.
  case fetching
  /// The machine could not be asked, or the ask failed: offline, a dropped
  /// socket, or a host too old to advertise the read. All one state because
  /// they are one sentence to a user and one gesture to fix — try again.
  case unavailable
}

/// Panels and collection rows read live because the mirror was missing them.
///
/// Process-lifetime and MainActor-isolated, because the sheet's store is
/// recreated on every present: without a shared cache, closing and reopening a
/// pane would pay for the round trip again, which is exactly the "instant on
/// second open" this is for.
///
/// It is deliberately NOT the sqlite mirror. `plugin_panels` and
/// `plugin_collections` are cr-sqlite CRR tables: a row this phone inserted
/// would be exported back to the machine on the next changeset and fight the
/// host's own writer column by column under last-writer-wins, so a phone
/// caching a read would end up authoring the machine's plugin data. The mirror
/// stays write-only-by-the-host; this cache is read-through and forgettable.
@MainActor
final class PluginPanelFallbackCache {
  static let shared = PluginPanelFallbackCache()

  /// Which machine's project the entries belong to. Attaching elsewhere drops
  /// everything rather than serving another machine's panels.
  private var scope = ""
  private var panels: [String: PluginPanelRecord] = [:]
  /// Panels the machine itself answered "no such panel" for. Cached because it
  /// is a real answer; a FAILED read is never cached, so Retry can work.
  private var absent: Set<String> = []
  private var collections: [String: [PluginCollectionEntry]] = [:]

  init() {}

  private func align(to scope: String) {
    guard scope != self.scope else { return }
    self.scope = scope
    panels.removeAll()
    absent.removeAll()
    collections.removeAll()
  }

  static func panelKey(pluginId: String, panelId: String) -> String { "\(pluginId)|\(panelId)" }

  static func collectionKey(pluginId: String, collection: String, keyPrefix: String?) -> String {
    "\(pluginId)|\(collection)|\(keyPrefix ?? "")"
  }

  func panel(scope: String, key: String) -> PluginPanelRecord? {
    align(to: scope)
    return panels[key]
  }

  func isAbsentOnHost(scope: String, key: String) -> Bool {
    align(to: scope)
    return absent.contains(key)
  }

  func store(scope: String, key: String, panel: PluginPanelRecord?) {
    align(to: scope)
    if let panel {
      panels[key] = panel
      absent.remove(key)
    } else {
      panels[key] = nil
      absent.insert(key)
    }
  }

  func entries(scope: String, key: String) -> [PluginCollectionEntry]? {
    align(to: scope)
    return collections[key]
  }

  func store(scope: String, key: String, entries: [PluginCollectionEntry]) {
    align(to: scope)
    collections[key] = entries
  }
}

/// Which components this build draws richly.
///
/// The skew split from `ade_card`, applied to the vocabulary: the PARSER accepts
/// every component the shared contract defines, because tolerating them at
/// decode is what keeps a schema forward-compatible; this set is where the
/// phone decides what it can actually put on screen. A component outside it
/// renders as a compact marker in place, never as a gap.
///
/// `chart` is the one v1 component deliberately absent: a sparse line/bar chart
/// is the least useful thing to squeeze onto a phone-width panel and the most
/// expensive to draw well, so it degrades to a marker until it earns a real
/// implementation.
enum PluginRenderSupport {
  static let renderableComponents: Set<String> = [
    "stack",
    "group",
    "text",
    "markdown",
    "badge",
    "button",
    "list",
    "table",
    "form",
    "video",
    "image",
    "divider",
    "keyValue",
    "emptyState",
    "segmented",
  ]

  static func isRenderable(_ node: PluginVocabNode) -> Bool {
    switch node {
    case .unknown, .invalid:
      return false
    default:
      return renderableComponents.contains(node.componentName)
    }
  }
}

/// Backing store for one plugin pane: resolves the panel list, parses the
/// schema, materializes every data binding, and dispatches actions.
///
/// Bindings resolve HERE rather than in the view. After ``load()`` the schema
/// carries no unresolved `bind`, so rendering touches no database and a redraw
/// costs nothing — the same discipline the Work list follows by projecting rows
/// once per revision instead of querying per cell.
@MainActor
final class PluginPaneStore: ObservableObject {
  enum Phase: Equatable { case idle, loading, loaded }

  let pluginId: String

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var panels: [PluginPanelRecord] = []
  @Published private(set) var selectedPanelId: String?
  @Published private(set) var presentation: PluginPanelPresentation = .missing
  /// Action ids currently in flight, so each control shows its own spinner
  /// rather than the pane locking as a whole.
  @Published private(set) var inFlightActionIds: Set<String> = []
  /// Last action outcome, shown as a transient line under the panel.
  @Published var actionMessage: PluginActionMessage?
  /// An action waiting on the confirmation sentence its schema declared.
  @Published var pendingConfirmation: PluginPendingConfirmation?
  /// An action waiting on the one line of text its `{prompt}` asked for.
  ///
  /// Set by ``runAction(_:extraArgs:label:allowsPrompt:)`` and cleared by
  /// whoever presents it. The pane sheet, a detail section and a chat card all
  /// draw the same alert from it, because all three run actions through this
  /// store and a question asked on one of them must not be dropped on another.
  @Published var pendingPrompt: PluginPanePendingPrompt?

  /// The value of every state key the panel's `segmented` controls declared.
  ///
  /// Per-panel, per-viewer, and gone when the pane closes. It is what a
  /// binding's `where` reads and what rides on an action invoke under `state`;
  /// it never reaches sqlite and never syncs. Published so a control redraws
  /// itself the moment it is tapped.
  @Published private(set) var panelState: PluginVocabPanelState = [:]

  /// The rows a reader has ticked, per `selectable` list.
  ///
  /// The second half of panel state and held on exactly the same terms:
  /// per-panel, per-viewer, gone when the pane closes, never in sqlite and never
  /// synced. A separate map because a set of row keys is a different shape from
  /// one string against a closed option list — see ``PluginVocabPanelSelection``.
  @Published private(set) var panelSelection: PluginVocabPanelSelection = [:]

  /// Which groups the reader has flipped away from their declared `defaultOpen`.
  ///
  /// A set of OVERRIDES, not a set of open groups, so an untouched section still
  /// obeys the schema's `defaultOpen` — a plugin that publishes a section closed
  /// gets it closed on first draw, and one the reader opened stays open across
  /// the republishes that follow. Client-local, and deliberately unreachable
  /// from a `where`, a signature or an action payload: collapsing a section is a
  /// statement about this screen, not about which rows the panel is showing.
  @Published private var groupOverrides: Set<String> = []

  /// The controls the current schema declares, in reading order.
  private(set) var stateDeclarations: [PluginVocabStateDeclaration] = []
  /// Identity of those controls — see ``PluginVocabState/signature(_:)``.
  private var stateSignature = ""
  /// The selectable lists the current schema declares, in reading order.
  private(set) var selectionDeclarations: [PluginVocabSelectionDeclaration] = []
  /// Identity of those lists — see ``PluginVocabState/selectionSignature(_:)``.
  private var selectionSignature = ""

  /// What this pane was opened with. Read by a node bound to `$context` and
  /// attached to every action dispatched from here, so a button knows what the
  /// reader was looking at when they pressed it.
  private(set) var context: [String: RemoteJSONValue]

  private let sync: PluginPaneSyncing
  private var presenceCatalog = PluginPresenceCatalog()

  /// Whether this pane may ask the machine for rows the mirror is missing.
  ///
  /// On for the full pane sheet, which is a screen the user asked for and the
  /// one place an empty result is the whole answer. Off for a plugin's guest
  /// surfaces — a detail section, a chat card — which draw nothing when their
  /// panel row is absent and would otherwise spend a round trip each just to
  /// keep drawing nothing.
  private let fetchesMissingRows: Bool
  private let fallbackCache: PluginPanelFallbackCache
  /// The panel this pane was ASKED for, as opposed to the one it settled on.
  ///
  /// Kept apart from ``selectedPanelId`` because the mirror can be missing the
  /// requested row: without it, a pane opened on `stories` would fall to
  /// whatever panel the mirror did have, and there would be nothing left to ask
  /// the machine about.
  private var requestedPanelId: String?
  private var panelFetchTask: Task<Void, Never>?
  /// A live read that failed. Not cached, and not retried on its own: the pane
  /// says so and offers the gesture.
  private var panelFetchFailed = false
  /// A live COLLECTION read that failed on a pane allowed to make one.
  ///
  /// The list on screen is still drawn — the mirror's rows are real rows — but
  /// this pane could not check them against the machine, so it must not present
  /// them as current. A plausible, well-formed, silently out-of-date list is
  /// worse than a blank one, because nothing about it looks wrong.
  @Published private(set) var collectionsMayBeStale = false
  /// Collection reads to run after this pass, keyed the way the cache is.
  private var pendingCollectionFetches: [String: (collection: String, keyPrefix: String?, limit: Int)] = [:]
  private var attemptedCollectionKeys: Set<String> = []
  private var collectionFetchTask: Task<Void, Never>?
  /// Read every bound collection again on this pass, cache or no cache.
  ///
  /// Set by the two gestures that invalidate a cached answer: an explicit
  /// refresh, and an action that just ran on the machine. Without it the pane
  /// answers a refresh from the copy it fetched the first time, which is the
  /// same staleness the mirror had.
  private var refetchesCollections = false
  /// How the `{openUrl}` verb reaches the system browser.
  ///
  /// Injected so a test can assert what a plugin asked to open without Safari
  /// coming to the front. Every real caller takes the default.
  private let openExternalURL: (URL) -> Void
  /// How the `{authSession}` verb reaches `ASWebAuthenticationSession`.
  ///
  /// Injected for the same reason ``openExternalURL`` is, and it matters more
  /// here: the default fronts a real system sign-in sheet, so a test that could
  /// not replace it could not exercise this verb at all.
  ///
  /// Main-actor by declaration: everything it touches — the runner, the auth
  /// sheet's presentation anchor, the `sync` it hands the callback to — already
  /// is, so spelling the isolation here is what keeps the existential from
  /// having to cross an actor boundary it has no business crossing.
  private let runAuthSession: @MainActor (URL, String, PluginPaneSyncing) async -> PluginAuthSessionOutcome

  init(
    pluginId: String,
    panelId: String? = nil,
    context: [String: RemoteJSONValue] = [:],
    sync: PluginPaneSyncing,
    fetchesMissingRows: Bool = false,
    // Resolved in the body, not as a default expression: a default argument is
    // evaluated in a NONISOLATED context, and `shared` is main-actor state, so
    // spelling it here warns today and is an error in the Swift 6 language mode.
    fallbackCache: PluginPanelFallbackCache? = nil,
    openExternalURL: @escaping (URL) -> Void = { UIApplication.shared.open($0) },
    // Nil-defaulted and built in the body, like `fallbackCache` and for the same
    // isolation reason.
    runAuthSession: (@MainActor (URL, String, PluginPaneSyncing) async -> PluginAuthSessionOutcome)? = nil
  ) {
    self.pluginId = pluginId
    self.selectedPanelId = panelId
    self.requestedPanelId = panelId
    self.context = context
    self.sync = sync
    self.fetchesMissingRows = fetchesMissingRows
    self.fallbackCache = fallbackCache ?? .shared
    self.openExternalURL = openExternalURL
    // One runner per pane, captured rather than made per call: its `isRunning`
    // flag is what stops a second tap on Connect from stacking a second sign-in
    // sheet, and a fresh runner each time would have nothing to guard.
    let runner = PluginAuthSessionRunner()
    self.runAuthSession = runAuthSession ?? { url, scheme, sync in
      await runner.run(url: url, callbackScheme: scheme, using: sync)
    }
  }

  var canInvoke: Bool { sync.canInvokePluginActions }

  /// Send the reader out to the system browser.
  ///
  /// The one door out of a plugin panel, whatever opened it: an action's
  /// `{openUrl}` result and a `markdown` node's link both come through here, so
  /// there is a single injectable seam a test can watch and a single place to
  /// change if the destination ever stops being Safari. The caller has already
  /// passed ``PluginInvokeResult/parseOpenURL(_:)`` — this opens, it does not
  /// decide.
  func openExternal(_ url: URL) {
    openExternalURL(url)
  }

  var displayName: String { presenceCatalog.label(for: pluginId) }

  /// Manifest accent, parsed from presence. Tints the pane only — the app's own
  /// palette is compile-time (`ADEColor`) and a plugin does not get to restyle
  /// the surfaces around it (design D15).
  var accent: Color {
    presenceCatalog.accentHex(for: pluginId).flatMap(ADEColor.pluginAccent(hex:)) ?? ADEColor.accent
  }

  var selectedPanel: PluginPanelRecord? {
    guard let selectedPanelId else { return panels.first }
    return panels.first { $0.panelId == selectedPanelId }
  }

  /// Reload everything from the local mirror, then close the gaps.
  ///
  /// The mirror is read FIRST and wins outright, every time: a replicated row
  /// that has since arrived replaces whatever a live read cached, so sync
  /// catching up quietly takes the pane back over. Only what the mirror does
  /// not have is asked of the machine, and only on a pane allowed to ask.
  ///
  /// Still cheap and synchronous, so it is safe on every
  /// `pluginsProjectionRevision` bump. The live reads it may start are detached
  /// — nothing here waits on a socket, and the sheet presents at once.
  func load() {
    presenceCatalog = sync.pluginPresenceCatalog()
    panels = mergedPanels(sync.pluginPanels(pluginId: pluginId))
    selectedPanelId = resolveSelection()
    if selectedPanel == nil, fetchesMissingRows {
      beginPanelFetch()
    }
    presentation = resolvePresentation()
    phase = .loaded
  }

  /// Ask again for everything this pane could not get. The gesture behind the
  /// "Try again" button, and the only thing that clears a failed read.
  func retryFetch() {
    panelFetchFailed = false
    collectionsMayBeStale = false
    attemptedCollectionKeys.removeAll()
    refetchesCollections = true
    load()
  }

  /// The mirror's rows, plus a live-read panel the mirror does not have.
  ///
  /// Appended rather than merged in place, and only for the panel this pane was
  /// actually asked for: the cache answers "the machine has this one", never
  /// "here is the plugin's panel list", which stays the mirror's to say.
  private func mergedPanels(_ local: [PluginPanelRecord]) -> [PluginPanelRecord] {
    guard fetchesMissingRows else { return local }
    let scope = sync.pluginFallbackScope
    var merged = local
    for panelId in [requestedPanelId, selectedPanelId].compactMap({ $0 }) {
      guard !panelId.isEmpty, !merged.contains(where: { $0.panelId == panelId }) else { continue }
      let key = PluginPanelFallbackCache.panelKey(pluginId: pluginId, panelId: panelId)
      // The mobile filter is the mirror path's, applied here for the same
      // reason: a panel the machine marked desktop-only is not one this phone
      // draws, however it arrived.
      guard let fetched = fallbackCache.panel(scope: scope, key: key), fetched.mobile else { continue }
      merged.append(fetched)
    }
    return merged
  }

  private func resolveSelection() -> String? {
    // An explicit request is never redirected on a pane that can go and get it.
    // Falling through to `panels.first` is what made a missing mirror row look
    // like a working navigation into someone else's panel.
    if fetchesMissingRows, let requestedPanelId, !requestedPanelId.isEmpty {
      return requestedPanelId
    }
    if let selectedPanelId, panels.contains(where: { $0.panelId == selectedPanelId }) {
      return selectedPanelId
    }
    return panels.first?.panelId
  }

  private func beginPanelFetch() {
    guard let panelId = selectedPanelId, !panelId.isEmpty else { return }
    guard !panelFetchFailed, panelFetchTask == nil else { return }
    let scope = sync.pluginFallbackScope
    let key = PluginPanelFallbackCache.panelKey(pluginId: pluginId, panelId: panelId)
    // The machine has already answered — with nothing, or with a panel this
    // phone does not draw. Either way there is no second question to ask.
    guard fallbackCache.panel(scope: scope, key: key) == nil,
          !fallbackCache.isAbsentOnHost(scope: scope, key: key) else { return }
    guard sync.canFetchPluginPanelsRemotely else {
      panelFetchFailed = true
      return
    }
    panelFetchTask = Task { [weak self] in
      guard let self else { return }
      do {
        let record = try await self.sync.fetchPluginPanel(pluginId: self.pluginId, panelId: panelId)
        // `nil` is the machine's own answer that no such panel exists, and it
        // is the only thing that earns "this plugin published nothing".
        self.fallbackCache.store(scope: scope, key: key, panel: record)
      } catch {
        // Never cached: the panel may well be there and the socket blinked.
        self.panelFetchFailed = true
      }
      self.panelFetchTask = nil
      self.load()
    }
  }

  /// Run the collection reads this pass queued, then redraw if anything landed.
  private func scheduleCollectionFetches() {
    guard fetchesMissingRows, collectionFetchTask == nil, !pendingCollectionFetches.isEmpty else { return }
    let scope = sync.pluginFallbackScope
    let requests = pendingCollectionFetches
    pendingCollectionFetches = [:]
    // Consumed here, so the forced pass runs exactly once and the redraw it
    // causes does not queue the same reads again.
    refetchesCollections = false
    // Marked attempted before the reads run, so a collection that is genuinely
    // empty on the machine costs one round trip per pane rather than one per
    // redraw.
    attemptedCollectionKeys.formUnion(requests.keys)
    collectionFetchTask = Task { [weak self] in
      guard let self else { return }
      var answered = false
      var failed = false
      for (key, request) in requests {
        do {
          let rows = try await self.sync.fetchPluginCollectionEntries(
            pluginId: self.pluginId,
            collection: request.collection,
            keyPrefix: request.keyPrefix,
            limit: request.limit
          )
          self.fallbackCache.store(scope: scope, key: key, entries: rows)
          answered = true
        } catch {
          // Never cached: the rows may well be there and the socket blinked.
          // The list keeps drawing the mirror and says it could not be checked.
          failed = true
        }
      }
      self.collectionsMayBeStale = failed
      self.collectionFetchTask = nil
      // Any answer can change the list now that the two are reconciled — an
      // updated row wins on `updatedAt` without adding a row — so the redraw
      // follows a successful read rather than a non-empty one.
      if answered { self.load() }
    }
  }

  /// The action a refresh gesture on the selected panel dispatches, when the
  /// plugin's manifest declared one. `nil` hides the gesture: a panel backed by
  /// the plugin's own collections is already live, so offering a pull that does
  /// nothing would be a promise the pane cannot keep.
  /// Deliberately independent of ``canInvoke``: whether the gesture EXISTS is
  /// the manifest's answer and whether it can run right now is the socket's.
  /// Folding the two would make the pane's shape change when a connection
  /// drops, which resets the reader's scroll position for no reason.
  var refreshAction: String? { selectedPanel?.refreshAction }

  /// Whether a pull gesture has anything to do.
  ///
  /// Two ways it does: the panel declared a refresh action, or this pane may ask
  /// the machine for rows — in which case the pull re-reads a mirror that is
  /// behind instead of redrawing the same list. A pane with neither shows no
  /// spinner, because a refresh that changes nothing is a promise not kept.
  var canRefresh: Bool { refreshAction != nil || fetchesMissingRows }

  /// Run the declared refresh action, then re-read the mirror.
  ///
  /// Awaited rather than fired, so SwiftUI's `.refreshable` holds its spinner
  /// until the plugin has actually answered and the new rows are on screen.
  /// `load()` runs either way: a refresh that failed still owes the reader
  /// whatever the mirror holds now, and the failure says so in the banner.
  func refresh() async {
    if let actionId = refreshAction, canInvoke {
      // The action already invalidated what this pane had fetched, so the load
      // here is only what a FAILED action still owes the reader: the mirror as
      // it stands now.
      await runAction(PluginVocabAction(action: actionId), extraArgs: [:], label: nil)
      load()
      return
    }
    // A refresh that answered from the copy fetched on first open would be the
    // same stale answer the mirror gave. The gesture means "ask again".
    invalidateFetchedCollections()
    load()
  }

  /// Drop what this pane believes about the machine's rows, so the next pass
  /// asks again. The mirror is untouched — it is a replica, not a cache.
  private func invalidateFetchedCollections() {
    guard fetchesMissingRows else { return }
    attemptedCollectionKeys.removeAll()
    refetchesCollections = true
  }

  func selectPanel(_ panelId: String) {
    guard panelId != selectedPanelId else { return }
    selectedPanelId = panelId
    requestedPanelId = panelId
    clearPanelState()
    // A new panel gets its own read: the last one's failure is not this one's.
    panelFetchFailed = false
    load()
  }

  /// Follow the `navigate` an action returned.
  ///
  /// In place, not as a second sheet: the navigation names a panel of THIS
  /// plugin, and stacking a sheet on the pane the reader is already in would
  /// bury the way back. A navigation carrying no context clears the one the
  /// pane had, which is what replacing the address does on desktop — the
  /// destination is not still about what the previous panel was about.
  func navigate(to navigation: PluginInvokeNavigation) {
    context = navigation.context ?? [:]
    selectedPanelId = navigation.panelId
    requestedPanelId = navigation.panelId
    clearPanelState()
    panelFetchFailed = false
    // Re-reads the mirror and, on a pane allowed to ask, goes and gets the
    // destination panel when the mirror has no row for it. The navigation
    // itself never waits on that — it lands here and the pane fills in.
    load()
  }

  private func resolvePresentation() -> PluginPanelPresentation {
    pendingCollectionFetches = [:]
    defer { scheduleCollectionFetches() }
    guard let record = selectedPanel else { return unresolvedPresentation() }
    // The column check comes first and without parsing: a panel written by a
    // newer vocabulary should say "update" rather than "damaged", and the
    // writer's declared version answers that before the schema is touched.
    guard record.isRenderableVersion else {
      return .updateRequired(PluginPanelParser.readFallback(record.schemaJSON))
    }
    switch PluginPanelParser.parse(record.schemaJSON) {
    case let .ok(schema, _):
      adoptStateControls(from: schema.body)
      return .panel(resolveBindings(in: schema))
    case let .failed(failure, fallback):
      if case .versionUnsupported = failure {
        return .updateRequired(fallback)
      }
      return .damaged(fallback)
    }
  }

  /// What to say when there is no panel to draw.
  ///
  /// The whole point of the split. "This plugin has not published anything" is
  /// a claim about the PLUGIN, and only the machine can make it — a phone whose
  /// replica is behind has no idea. So the copy follows who answered: the
  /// machine saying no earns ``PluginPanelPresentation/missing``, and every
  /// other reason for an empty pane says the panel has not reached the phone.
  private func unresolvedPresentation() -> PluginPanelPresentation {
    // A guest surface draws nothing either way and never asks, so it keeps the
    // state it always had.
    guard fetchesMissingRows, let panelId = selectedPanelId, !panelId.isEmpty else { return .missing }
    let scope = sync.pluginFallbackScope
    let key = PluginPanelFallbackCache.panelKey(pluginId: pluginId, panelId: panelId)
    // The machine answered: no such panel, or one it marked desktop-only.
    // Both mean there is nothing for this phone to show, on the machine's own
    // authority rather than on a guess.
    if fallbackCache.isAbsentOnHost(scope: scope, key: key) { return .missing }
    if fallbackCache.panel(scope: scope, key: key) != nil { return .missing }
    return .notReceived(panelFetchTask == nil ? .unavailable : .fetching)
  }

  // MARK: - Panel state

  /// Reconcile the reader's selections against the controls now on screen.
  ///
  /// Both halves matter, and they catch different things. The SIGNATURE catches
  /// a control that vanished or changed its options: a plugin refreshing its
  /// fleet rows republishes the whole panel every few seconds, and a filter that
  /// reset on each of those would be unusable, so an unchanged signature keeps
  /// the selections untouched. ``PluginVocabState/normalize(_:declarations:)``
  /// catches a value inside a control that did not vanish — an option the new
  /// schema no longer offers cannot stay selected.
  private func adoptStateControls(from body: [PluginVocabNode]) {
    // A control's `optionsFrom` is a fetch like any other, resolved from the
    // rows this pane already reads — so a bound control draws the reader's
    // projects rather than nothing but its "All". The signature deliberately
    // does NOT move when those rows do: see ``PluginVocabState/signature(_:)``.
    let declarations = PluginVocabState.declarations(in: body) { binding in
      self.stateOptions(for: binding)
    }
    let signature = PluginVocabState.signature(declarations)
    stateDeclarations = declarations
    if signature != stateSignature {
      panelState = stateSignature.isEmpty
        ? PluginVocabState.initialState(declarations)
        : PluginVocabState.normalize(panelState, declarations: declarations)
      stateSignature = signature
    }
    adoptSelectionControls(from: body)
  }

  /// The selection half of ``adoptStateControls(from:)``, on the same terms.
  ///
  /// Same signature/normalize pair and the same reason for each: the signature
  /// catches a list that vanished, changed its cap or changed its verbs, and
  /// ``PluginVocabState/normalizeSelection(_:declarations:)`` re-applies the cap
  /// to ticks a republish may have made too many.
  private func adoptSelectionControls(from body: [PluginVocabNode]) {
    let declarations = PluginVocabState.selectionDeclarations(in: body)
    let signature = PluginVocabState.selectionSignature(declarations)
    selectionDeclarations = declarations
    guard signature != selectionSignature else { return }
    panelSelection = selectionSignature.isEmpty
      ? PluginVocabState.initialSelection(declarations)
      : PluginVocabState.normalizeSelection(panelSelection, declarations: declarations)
    selectionSignature = signature
  }

  /// The options a control's `optionsFrom` resolves to right now.
  ///
  /// Read through the same path a node binding takes, so a bound control shares
  /// the pane's one fetch of that collection instead of asking for its own — and
  /// so a collection the mirror is missing is queued for the live read exactly
  /// as a bound list's would be.
  private func stateOptions(for binding: PluginVocabStateOptionsBinding) -> [PluginVocabStateOption] {
    let rows = entries(
      for: PluginVocabBinding(collection: binding.collection, keyPrefix: binding.keyPrefix),
      limit: PluginVocabLimits.maxBoundStateOptions
    )
    return PluginVocabState.resolveStateOptions(binding, rows: rows.map(\.value))
  }

  /// Forget the reader's selections because they are leaving this panel.
  ///
  /// A different panel is a different set of controls. Cleared outright rather
  /// than left to the signature check, so arriving at a panel that happens to
  /// declare the same controls reads as a fresh open rather than as a
  /// continuation of one the reader has moved on from. The ticks and the group
  /// overrides go with it for the same reason: a batch assembled on one panel is
  /// not a batch on the next, and a section closed there is not this one's.
  private func clearPanelState() {
    panelState = [:]
    stateDeclarations = []
    stateSignature = ""
    panelSelection = [:]
    selectionDeclarations = []
    selectionSignature = ""
    groupOverrides = []
  }

  // MARK: - Groups

  /// Whether a collapsible section is showing its contents.
  ///
  /// The schema's `defaultOpen` decides until the reader says otherwise; after
  /// that this pane remembers the flip under the group's own key, so a plugin
  /// republishing its rows every few seconds cannot re-open a section the reader
  /// just closed. Nothing about it reaches the plugin.
  func groupIsOpen(_ group: PluginVocabGroup) -> Bool {
    groupOverrides.contains(group.key) ? !group.defaultOpen : group.defaultOpen
  }

  func toggleGroup(_ group: PluginVocabGroup) {
    if groupOverrides.contains(group.key) {
      groupOverrides.remove(group.key)
    } else {
      groupOverrides.insert(group.key)
    }
  }

  // MARK: - Selection

  /// The declaration a list's ticks are held under.
  ///
  /// A list past ``PluginVocabLimits/maxSelectionKeys`` declares nothing, and
  /// gets no ticks and no bar — the honest failure for a panel that asked for
  /// three selections. `nil` is what the views read to draw no affordance.
  func selectionDeclaration(for selectable: PluginVocabSelectable) -> PluginVocabSelectionDeclaration? {
    selectionDeclarations.first { $0.stateKey == selectable.stateKey }
  }

  func isSelected(rowKey: String, in selectable: PluginVocabSelectable) -> Bool {
    (panelSelection[selectable.stateKey] ?? []).contains(rowKey)
  }

  /// Tick or untick one row. At the cap a new tick is refused rather than
  /// evicting an older one — see ``PluginVocabState/toggleRow(_:declaration:rowKey:)``.
  func toggle(rowKey: String, in selectable: PluginVocabSelectable) {
    guard let declaration = selectionDeclaration(for: selectable) else { return }
    let next = PluginVocabState.toggleRow(panelSelection, declaration: declaration, rowKey: rowKey)
    guard next != panelSelection else { return }
    panelSelection = next
  }

  func clearSelection(in selectable: PluginVocabSelectable) {
    guard let declaration = selectionDeclaration(for: selectable) else { return }
    let next = PluginVocabState.clearSelection(panelSelection, declaration: declaration)
    guard next != panelSelection else { return }
    panelSelection = next
  }

  /// The ticked rows that are actually on screen, in the order they are drawn.
  ///
  /// What the bar counts AND what a bulk action is handed — one helper for both,
  /// because a bar reading "3 selected" that dispatched four keys would be
  /// acting on a row nobody can see.
  func selectedKeys(in selectable: PluginVocabSelectable, visibleRowKeys: [String]) -> [String] {
    PluginVocabState.selectedRowKeys(
      panelSelection,
      stateKey: selectable.stateKey,
      rowKeys: visibleRowKeys
    )
  }

  /// Run one bulk verb over the visible selection.
  ///
  /// The keys ride as `args.selection`, injected HERE and last: `extraArgs`
  /// overrides the schema's own `args` in ``runAction(_:extraArgs:label:allowsPrompt:)``,
  /// so a panel cannot declare an argument that would quietly replace the batch.
  /// Routed through ``perform(_:extraArgs:label:)`` like every other control, so
  /// a bulk verb's `confirm` asks first exactly as a row's does — which matters
  /// more here, where a mistake costs eleven lanes.
  func performBulk(
    _ entry: PluginVocabListItemAction,
    in selectable: PluginVocabSelectable,
    visibleRowKeys: [String]
  ) {
    let keys = selectedKeys(in: selectable, visibleRowKeys: visibleRowKeys)
    guard !keys.isEmpty else { return }
    perform(entry.action, extraArgs: ["selection": keys], label: entry.label)
  }

  /// Choose one option of a `segmented` control.
  ///
  /// The write is local and immediate — that is the whole point of the control —
  /// and re-resolving the presentation re-filters every bound node from rows the
  /// mirror already holds. `onChange` is dispatched afterwards, never instead:
  /// a plugin that wants to know which filter the reader picked gets told, and a
  /// plugin that does not declare it still gets a working filter.
  func select(_ option: PluginVocabStateOption, in segmented: PluginVocabSegmented) {
    let next = PluginVocabState.apply(
      panelState,
      declaration: declaration(for: segmented),
      value: option.value
    )
    if next != panelState {
      panelState = next
      presentation = resolvePresentation()
    }
    // Dispatched even when the value did not change, because tapping the option
    // already selected is a legitimate "do that again" — the same reading a
    // refresh button gets.
    if let onChange = segmented.onChange {
      perform(onChange, extraArgs: [segmented.stateKey: option.value])
    }
  }

  /// The control as the store holds it: literal options plus whatever the
  /// node's `optionsFrom` resolved to, and the initial value already reconciled
  /// against that list.
  ///
  /// The store's declaration wins where there is one; a control past the
  /// `maxStateKeys` ceiling declares nothing and falls back to its own node, so
  /// it still works as a control even though no `where` can read it — and a
  /// bound one past the ceiling honestly draws only its literal options, since
  /// nothing resolved them.
  func declaration(for segmented: PluginVocabSegmented) -> PluginVocabStateDeclaration {
    stateDeclarations.first { $0.stateKey == segmented.stateKey } ?? segmented.declaration()
  }

  /// The option a control is currently showing as chosen.
  func selectedValue(in segmented: PluginVocabSegmented) -> String {
    panelState[segmented.stateKey] ?? declaration(for: segmented).initial
  }

  // MARK: - Binding resolution

  private func resolveBindings(in schema: PluginPanelSchema) -> PluginPanelSchema {
    var resolved = schema
    resolved.body = schema.body.map(resolveBindings(in:))
    return resolved
  }

  private func resolveBindings(in node: PluginVocabNode) -> PluginVocabNode {
    switch node {
    case var .stack(stack):
      stack.children = stack.children.map(resolveBindings(in:))
      return .stack(stack)

    // A container is a container: a `list` inside a `group` binds the same
    // collection a `list` inside a `stack` does, and forgetting this arm would
    // leave its rows unresolved and its node drawing an empty state.
    case var .group(group):
      group.children = group.children.map(resolveBindings(in:))
      return .group(group)

    case var .list(list):
      guard let bind = list.bind else { return node }
      let rows = entries(for: bind, limit: PluginVocabLimits.maxListItems)
      list.items = (list.items ?? []) + rows.compactMap { entry in
        // The collection row's own primary key becomes the row's identity when
        // the stored value declares none, so a plugin that already writes
        // `{title, subtitle}` rows gets selection for free — the same rule the
        // `keyValue` arm below has always followed.
        PluginPanelParser.parseBoundListItem(
          entry.value,
          allowActions: bind.allowActions,
          rowKey: entry.key
        )
      }
      list.bind = nil
      return .list(list)

    case var .keyValue(keyValue):
      guard let bind = keyValue.bind else { return node }
      let rows = entries(for: bind, limit: PluginVocabLimits.maxKeyValueRows)
      keyValue.rows = (keyValue.rows ?? []) + rows.compactMap { entry in
        // A collection row already carries a key in its primary key, so a value
        // that is a bare string still makes a usable row.
        if let object = entry.value as? [String: Any] {
          var merged = object
          if merged["key"] == nil { merged["key"] = entry.key }
          return PluginPanelParser.parseKeyValueRow(merged)
        }
        guard let text = entry.value as? String else { return nil }
        return PluginVocabKeyValueRow(key: entry.key, value: text)
      }
      keyValue.bind = nil
      return .keyValue(keyValue)

    case var .table(table):
      guard let bind = table.bind else { return node }
      let rows = entries(for: bind, limit: PluginVocabLimits.maxTableRows)
      table.rows = (table.rows ?? []) + rows.compactMap { entry in
        guard let object = entry.value as? [String: Any] else { return nil }
        return PluginPanelParser.coerceTableRow(object, columns: table.columns)
      }
      table.bind = nil
      return .table(table)

    default:
      return node
    }
  }

  private func entries(for binding: PluginVocabBinding, limit: Int) -> [PluginCollectionEntry] {
    let filtered = binding.whereClauses != nil
    // A `where` is evaluated on the CLIENT, so the fetch must not carry the
    // binding's own `limit`. That limit caps what the node DISPLAYS: applying it
    // first would filter a truncated window, and a fleet of 300 fetched at 100
    // would report "4 failed" when there are eleven. Same rule as
    // `distinctBindings` on desktop, which drops the limit for a filtered fetch.
    var fetch = binding
    if filtered { fetch.limit = nil }
    let rows = reservedEntries(for: binding, limit: filtered ? limit : min(limit, binding.limit ?? limit))
      ?? mirrorOrFetchedEntries(binding: fetch, limit: limit)
    guard filtered else { return rows }
    let kept = PluginVocabState.filter(binding.whereClauses, rows, state: panelState) { $0.value }
    // Filter first, cap second — the order every client shares.
    guard let cap = binding.limit, kept.count > cap else { return kept }
    return Array(kept.prefix(cap))
  }

  /// The mirror's rows and the machine's, reconciled — not one or the other.
  ///
  /// This used to live-read only when the mirror was ENTIRELY empty, and that
  /// one word was the whole bug: a single replicated row made the mirror
  /// authoritative for ever, so a collection mid-replication drew as a complete
  /// list, and the panel's own refresh was powerless against it. It is sharpest
  /// on a write-then-read from the same phone — the confirmation card appears in
  /// the transcript at once (a different path) while the list still does not
  /// carry the row, which reads as the plugin losing the write.
  ///
  /// So both sources are consulted on a pane allowed to ask, and merged by key
  /// with the newer `updatedAt` winning. Mirror order is kept and rows only the
  /// machine has are appended, the way a fetched panel is appended to the
  /// mirror's panel list.
  ///
  /// DISPLAY ONLY. Nothing fetched is written back: `plugin_collections` is a
  /// cr-sqlite CRR, so a row this phone inserted would be exported to the
  /// machine on the next changeset and fight the host's own writer under
  /// last-writer-wins. The live copy lives in the forgettable fallback cache and
  /// nowhere else.
  private func mirrorOrFetchedEntries(binding: PluginVocabBinding, limit: Int) -> [PluginCollectionEntry] {
    let local = sync.pluginCollectionEntries(binding: binding, pluginId: pluginId, limit: limit)
    guard fetchesMissingRows else { return local }
    let key = PluginPanelFallbackCache.collectionKey(
      pluginId: pluginId,
      collection: binding.collection,
      keyPrefix: binding.keyPrefix
    )
    if refetchesCollections || !attemptedCollectionKeys.contains(key) {
      pendingCollectionFetches[key] = (collection: binding.collection, keyPrefix: binding.keyPrefix, limit: limit)
    }
    guard let fetched = fallbackCache.entries(scope: sync.pluginFallbackScope, key: key) else { return local }
    return Self.reconcile(mirror: local, live: fetched, limit: limit)
  }

  /// Merge two views of one collection by key, newest write winning.
  ///
  /// A key the machine did not answer for keeps its mirror row rather than
  /// disappearing: the live read is capped and may be filtered, so its silence
  /// about a key is not a claim that the key is gone. A genuine delete reaches
  /// the phone as a cr-sqlite delete on the mirror, which is where a row leaving
  /// belongs.
  ///
  /// `updatedAt` is an ISO-8601 UTC string from one writer on the machine, so
  /// string order is time order, and an equal or missing timestamp keeps the
  /// mirror's row — the CRR copy is the one that converges.
  static func reconcile(
    mirror: [PluginCollectionEntry],
    live: [PluginCollectionEntry],
    limit: Int
  ) -> [PluginCollectionEntry] {
    var liveByKey: [String: PluginCollectionEntry] = [:]
    for entry in live { liveByKey[entry.key] = entry }
    var merged: [PluginCollectionEntry] = []
    merged.reserveCapacity(mirror.count + live.count)
    var seen: Set<String> = []
    for entry in mirror {
      seen.insert(entry.key)
      if let candidate = liveByKey[entry.key], candidate.updatedAt > entry.updatedAt {
        merged.append(candidate)
      } else {
        merged.append(entry)
      }
    }
    for entry in live where !seen.contains(entry.key) {
      merged.append(entry)
    }
    guard merged.count > limit else { return merged }
    return Array(merged.prefix(limit))
  }

  /// Rows for a binding ADE answers itself, or `nil` when the plugin owns it.
  ///
  /// Two reserved collections and neither exists in the database, so a pane that
  /// forgot one would send the plugin's store a guaranteed miss and draw an
  /// empty node with no error. Resolving both in one place is also what keeps
  /// what a panel READS the same value its actions CARRY.
  private func reservedEntries(for binding: PluginVocabBinding, limit: Int) -> [PluginCollectionEntry]? {
    if binding.collection == PluginVocabulary.contextCollection {
      return contextEntries(limit: limit)
    }
    if binding.collection == PluginVocabulary.stateCollection {
      return stateEntries(limit: limit)
    }
    return nil
  }

  /// The panel's own selections as bindable rows.
  ///
  /// Built at draw time from the live state, never fetched: this is the one
  /// collection whose content changes without any data changing, and tying it to
  /// a read would put a round trip back into the gesture the whole feature
  /// exists to make free. A `keyValue` bound to `$state` renders "Status:
  /// Active" and updates on the same tap that re-filters the list beside it.
  private func stateEntries(limit: Int) -> [PluginCollectionEntry] {
    PluginVocabState.rows(stateDeclarations, state: panelState).prefix(limit).compactMap { row in
      guard let data = try? adeJSONData(withJSONObject: ["key": row.key, "value": row.value]),
            let valueJSON = String(data: data, encoding: .utf8) else { return nil }
      return PluginCollectionEntry(
        pluginId: pluginId,
        collection: PluginVocabulary.stateCollection,
        key: row.key,
        valueJSON: valueJSON,
        updatedAt: ""
      )
    }
  }

  /// The context as bindable rows, one per top-level key.
  ///
  /// Sorted by key, where desktop keeps declaration order: Foundation's JSON
  /// reader hands back a dictionary, so the order the plugin wrote is already
  /// gone by the time anything here can see it. A stable order beats an
  /// arbitrary one that reshuffles between reads.
  ///
  /// Scalars become their display text so a `keyValue` row renders — a bound
  /// row reads its value as a string, and a context value is a fact to show,
  /// not an argument to pass on. Actions carry ``context`` itself, untouched,
  /// so the plugin still receives the number it wrote.
  private func contextEntries(limit: Int) -> [PluginCollectionEntry] {
    context.keys.sorted().prefix(limit).compactMap { key in
      guard let value = context[key], let valueJSON = contextValueJSON(value) else { return nil }
      return PluginCollectionEntry(
        pluginId: pluginId,
        collection: PluginVocabulary.contextCollection,
        key: key,
        valueJSON: valueJSON,
        updatedAt: ""
      )
    }
  }

  private func contextValueJSON(_ value: RemoteJSONValue) -> String? {
    let displayable: Any
    switch value {
    case let .string(text):
      displayable = text
    case let .number(number):
      displayable = PluginPanelParser.formatNumber(number)
    case let .bool(flag):
      displayable = flag ? "Yes" : "No"
    case .object, .array:
      displayable = foundationObject(from: value)
    case .null:
      return nil
    }
    guard let data = try? adeJSONData(withJSONObject: displayable) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  // MARK: - Actions

  func isInFlight(_ action: PluginVocabAction) -> Bool {
    inFlightActionIds.contains(action.action)
  }

  /// Run an action, routing through its confirmation sentence when it declares
  /// one. Callers do not branch on `confirm` — this is the only entry point, so
  /// a confirmation can never be skipped by a caller that forgot about it.
  ///
  /// - Parameter label: the control's own words, carried only so a `{prompt}`
  ///   that named no `title` can be titled with the button the reader pressed.
  func perform(_ action: PluginVocabAction, extraArgs: [String: Any] = [:], label: String? = nil) {
    if let confirm = action.confirm {
      pendingConfirmation = PluginPendingConfirmation(
        action: action,
        extraArgs: extraArgs,
        message: confirm,
        label: label
      )
      return
    }
    dispatch(action, extraArgs: extraArgs, label: label)
  }

  func confirmPending() {
    guard let pending = pendingConfirmation else { return }
    pendingConfirmation = nil
    dispatch(pending.action, extraArgs: pending.extraArgs, label: pending.label)
  }

  /// Re-invoke the action that asked a question, carrying the reader's answer.
  ///
  /// The SAME action with the SAME arguments plus `args.prompt`, which is the
  /// whole contract — a plugin's handler reads its own arguments back and then
  /// finds the line it asked for. `allowsPrompt: false` is the one-hop rule: a
  /// re-invocation's own `{prompt}` is ignored, so a plugin cannot keep the
  /// alert on screen.
  ///
  /// An answer past the ceiling never gets here — the alert's confirm button is
  /// disabled while it is — and is refused rather than truncated if it does.
  func submitPrompt(_ pending: PluginPanePendingPrompt, text: String) {
    pendingPrompt = nil
    guard let answer = pending.pending.prompt.answerPayload(text: text) else {
      actionMessage = PluginActionMessage(text: "That answer is too long to send.", isFailure: true)
      return
    }
    var args = pending.extraArgs
    // Last, so a schema's own `args` cannot name `prompt` and quietly replace
    // the answer — the same rule `context` and `state` are added under.
    args["prompt"] = answer
    dispatch(pending.action, extraArgs: args, label: pending.pending.fallbackTitle, allowsPrompt: false)
  }

  /// Cancelling invokes nothing at all. The action already ran once and said
  /// what it wanted; the reader declining to answer is a complete outcome.
  func cancelPrompt() {
    pendingPrompt = nil
  }

  private func dispatch(
    _ action: PluginVocabAction,
    extraArgs: [String: Any],
    label: String?,
    allowsPrompt: Bool = true
  ) {
    Task { [weak self] in
      await self?.runAction(action, extraArgs: extraArgs, label: label, allowsPrompt: allowsPrompt)
    }
  }

  /// One dispatch, awaited.
  ///
  /// Split out of ``dispatch(_:extraArgs:)`` so a refresh gesture can hold its
  /// spinner until the plugin has answered. A control that fires and forgets
  /// still goes through here, so there is exactly one definition of what
  /// running an action does to the pane.
  private func runAction(
    _ action: PluginVocabAction,
    extraArgs: [String: Any],
    label: String?,
    allowsPrompt: Bool = true
  ) async {
    guard !inFlightActionIds.contains(action.action) else { return }
    inFlightActionIds.insert(action.action)
    // The defer clears the in-flight flag on every exit — success, throw, or
    // cancellation — which is what keeps a control from stranding in its
    // spinner when the socket drops mid-call (the `runSessionAction` rule).
    defer { inFlightActionIds.remove(action.action) }
    do {
      var payload = action.argsJSON.merging(extraArgs) { _, override in override }
      if !context.isEmpty {
        // Under `context`, the same field `PluginPanelHost.tsx` sends and the
        // same place a socket's surface context rides. Last so a schema
        // cannot name an argument that would quietly replace it.
        payload["context"] = PluginPanelContext.payload(context)
      }
      if let state = PluginVocabState.payload(panelState) {
        // The reader's filter selections, beside `context` and for the same
        // reason: a "Refresh" that did not know them would refetch a whole fleet
        // for a reader looking at four rows of it, and a plugin paging an API
        // could not page the filtered set at all.
        payload["state"] = state
      }
      let result = try await sync.invokePluginAction(
        pluginId: pluginId,
        actionId: action.action,
        payload: payload
      )
      actionMessage = PluginActionMessage(
        text: result.message ?? "Done",
        isFailure: !result.ok
      )
      // An action that reached the machine may have written there. The mirror
      // will carry that write when replication catches up; until then only a
      // live read can show it, and answering from the copy fetched before the
      // action is what made a logged decision look lost on the phone that
      // logged it.
      invalidateFetchedCollections()
      // Before the navigation, the way desktop orders the two verbs: an
      // action that opens a link and then moves the pane should do both.
      // `https:` only — `PluginInvokeResult` refuses every other scheme, so
      // nothing else can reach here.
      if let url = result.openURL {
        openExternalURL(url)
      }
      // Before the navigation as well: a reset belongs to the panel the action
      // ran on, and a navigation replaces that panel's controls anyway.
      if let reset = result.resetState {
        panelState = PluginVocabState.reset(panelState, declarations: stateDeclarations, reset: reset)
        // One verb, both maps. A plugin answering a bulk action with
        // `{resetState}` has almost always just acted on every ticked row, and
        // leaving them ticked would offer to do it again to rows that moved on.
        panelSelection = PluginVocabState.resetSelection(
          panelSelection,
          declarations: selectionDeclarations,
          reset: reset
        )
        presentation = resolvePresentation()
      }
      if let navigation = result.navigate {
        navigate(to: navigation)
      }
      // Last, and only on the first hop. A question the reader has to answer is
      // the continuation of what they started, so it goes up after the pane has
      // finished moving; and a re-invocation's own `{prompt}` is ignored so a
      // plugin cannot keep the alert on screen.
      if allowsPrompt, let prompt = result.prompt {
        pendingPrompt = PluginPanePendingPrompt(
          action: action,
          extraArgs: extraArgs,
          pending: PluginPendingPrompt(prompt: prompt, fallbackTitle: label ?? displayName)
        )
      } else if allowsPrompt, result.askedForPrompt {
        // Refused for a bad `id`. Said out loud rather than dropped: the button
        // did something, and silence would read as it being broken.
        actionMessage = PluginActionMessage(
          text: "\(displayName) asked a question ADE could not read.",
          isFailure: true
        )
      }
      // Re-read the pane so the invalidation above turns into an actual ask. A
      // navigation already loaded, and a second load costs one mirror read —
      // the same thing a projection bump does.
      load()
      // After the load, and awaited, unlike every verb above it: a sign-in is
      // the only one that blocks for as long as a person takes to read a consent
      // screen. Running it before the pane refreshed would leave the panel
      // frozen on pre-action state for that whole time, and running it
      // unawaited would drop the in-flight flag — the Connect button would stop
      // spinning while its sign-in was still on screen.
      if let authSession = result.authSession {
        await presentAuthSession(authSession)
      }
    } catch {
      actionMessage = PluginActionMessage(
        text: (error as NSError).localizedDescription,
        isFailure: true
      )
    }
  }

  /// Present a sign-in the machine stamped, and hand the answer back to it.
  ///
  /// `loopback` is a DESKTOP flow and this phone cannot finish it: the machine
  /// that began it has an HTTP listener open on its OWN `127.0.0.1`, and a
  /// redirect there from a phone lands on the phone's loopback, where nothing is
  /// listening. Opening a browser anyway would walk the reader through a real
  /// sign-in and then strand them on an unreachable page with a live
  /// authorization code in the address bar — the exact failure this whole seam
  /// exists to prevent — so the pane says where the flow does finish instead.
  private func presentAuthSession(_ session: PluginInvokeAuthSession) async {
    guard session.transport == .app else {
      actionMessage = PluginActionMessage(
        text: "Connect \(displayName) on the machine — this sign-in can only finish there.",
        isFailure: true
      )
      return
    }
    // Asked before the browser opens, never after it closes: a reader who signed
    // in and then learned the answer had nowhere to go has given a provider a
    // grant for nothing.
    guard sync.supportsPluginAuthSessions else {
      actionMessage = PluginActionMessage(
        text: "This machine's ADE is too old to finish a sign-in from your phone. Update it, or connect \(displayName) there.",
        isFailure: true
      )
      return
    }
    // The host stamps this for every `app` flow. Without it there is no scheme
    // to watch for, and the session would sit open until the reader gave up.
    guard let callbackScheme = session.callbackScheme else {
      actionMessage = PluginActionMessage(
        text: "\(displayName) asked for a sign-in ADE could not open.",
        isFailure: true
      )
      return
    }
    switch await runAuthSession(session.url, callbackScheme, sync) {
    case .delivered:
      // The plugin has just been handed its callback ON THE MACHINE, and acting
      // on it is the point — a connected account, a stored token, rows it can
      // finally read. None of that is in the copy this pane fetched before the
      // sign-in started.
      invalidateFetchedCollections()
      load()
    case .canceled:
      // Deliberately silent. A reader who closed the sheet knows what they did,
      // and an error toast would tell them something went wrong when nothing
      // did.
      break
    case .failed(let message):
      actionMessage = PluginActionMessage(text: message, isFailure: true)
    }
  }
}

struct PluginActionMessage: Equatable, Identifiable {
  let id = UUID()
  var text: String
  var isFailure: Bool
}

struct PluginPendingConfirmation: Equatable, Identifiable {
  let id = UUID()
  var action: PluginVocabAction
  var extraArgs: [String: Any]
  var message: String
  /// The control's own words, carried through the confirmation so a `{prompt}`
  /// the action answers with can still be titled with the button that ran it.
  var label: String?

  static func == (lhs: PluginPendingConfirmation, rhs: PluginPendingConfirmation) -> Bool {
    lhs.id == rhs.id
  }
}

/// A panel action's question, with everything needed to re-invoke it.
///
/// The arguments are held VERBATIM rather than rebuilt: the contract is that
/// the re-invocation carries the same arguments the first one did, and a second
/// derivation of them would be a second place for the two to differ.
struct PluginPanePendingPrompt: Equatable, Identifiable {
  var id: UUID { pending.id }
  var action: PluginVocabAction
  var extraArgs: [String: Any]
  var pending: PluginPendingPrompt

  static func == (lhs: PluginPanePendingPrompt, rhs: PluginPanePendingPrompt) -> Bool {
    lhs.id == rhs.id
  }
}
