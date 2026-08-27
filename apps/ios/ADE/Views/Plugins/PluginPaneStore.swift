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
  /// No such row. Usually a plugin uninstalled on the machine while its pane
  /// was open, or a panel the owning machine has not published yet.
  case missing
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
    "text",
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

  /// The value of every state key the panel's `segmented` controls declared.
  ///
  /// Per-panel, per-viewer, and gone when the pane closes. It is what a
  /// binding's `where` reads and what rides on an action invoke under `state`;
  /// it never reaches sqlite and never syncs. Published so a control redraws
  /// itself the moment it is tapped.
  @Published private(set) var panelState: PluginVocabPanelState = [:]

  /// The controls the current schema declares, in reading order.
  private(set) var stateDeclarations: [PluginVocabStateDeclaration] = []
  /// Identity of those controls — see ``PluginVocabState/signature(_:)``.
  private var stateSignature = ""

  /// What this pane was opened with. Read by a node bound to `$context` and
  /// attached to every action dispatched from here, so a button knows what the
  /// reader was looking at when they pressed it.
  private(set) var context: [String: RemoteJSONValue]

  private let sync: PluginPaneSyncing
  private var presenceCatalog = PluginPresenceCatalog()
  /// How the `{openUrl}` verb reaches the system browser.
  ///
  /// Injected so a test can assert what a plugin asked to open without Safari
  /// coming to the front. Every real caller takes the default.
  private let openExternalURL: (URL) -> Void

  init(
    pluginId: String,
    panelId: String? = nil,
    context: [String: RemoteJSONValue] = [:],
    sync: PluginPaneSyncing,
    openExternalURL: @escaping (URL) -> Void = { UIApplication.shared.open($0) }
  ) {
    self.pluginId = pluginId
    self.selectedPanelId = panelId
    self.context = context
    self.sync = sync
    self.openExternalURL = openExternalURL
  }

  var canInvoke: Bool { sync.canInvokePluginActions }

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

  /// Reload everything from the local mirror. Cheap and synchronous under the
  /// hood, so it is safe to call on every `pluginsProjectionRevision` bump.
  func load() {
    presenceCatalog = sync.pluginPresenceCatalog()
    panels = sync.pluginPanels(pluginId: pluginId)
    if selectedPanelId == nil || !panels.contains(where: { $0.panelId == selectedPanelId }) {
      selectedPanelId = panels.first?.panelId
    }
    presentation = resolvePresentation()
    phase = .loaded
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

  /// Run the declared refresh action, then re-read the mirror.
  ///
  /// Awaited rather than fired, so SwiftUI's `.refreshable` holds its spinner
  /// until the plugin has actually answered and the new rows are on screen.
  /// `load()` runs either way: a refresh that failed still owes the reader
  /// whatever the mirror holds now, and the failure says so in the banner.
  func refresh() async {
    if let actionId = refreshAction, canInvoke {
      await runAction(PluginVocabAction(action: actionId), extraArgs: [:])
    }
    load()
  }

  func selectPanel(_ panelId: String) {
    guard panelId != selectedPanelId else { return }
    selectedPanelId = panelId
    clearPanelState()
    presentation = resolvePresentation()
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
    clearPanelState()
    presentation = resolvePresentation()
  }

  private func resolvePresentation() -> PluginPanelPresentation {
    guard let record = selectedPanel else { return .missing }
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
    let declarations = PluginVocabState.declarations(in: body)
    let signature = PluginVocabState.signature(declarations)
    stateDeclarations = declarations
    guard signature != stateSignature else { return }
    panelState = stateSignature.isEmpty
      ? PluginVocabState.initialState(declarations)
      : PluginVocabState.normalize(panelState, declarations: declarations)
    stateSignature = signature
  }

  /// Forget the reader's selections because they are leaving this panel.
  ///
  /// A different panel is a different set of controls. Cleared outright rather
  /// than left to the signature check, so arriving at a panel that happens to
  /// declare the same controls reads as a fresh open rather than as a
  /// continuation of one the reader has moved on from.
  private func clearPanelState() {
    panelState = [:]
    stateDeclarations = []
    stateSignature = ""
  }

  /// Choose one option of a `segmented` control.
  ///
  /// The write is local and immediate — that is the whole point of the control —
  /// and re-resolving the presentation re-filters every bound node from rows the
  /// mirror already holds. `onChange` is dispatched afterwards, never instead:
  /// a plugin that wants to know which filter the reader picked gets told, and a
  /// plugin that does not declare it still gets a working filter.
  func select(_ option: PluginVocabStateOption, in segmented: PluginVocabSegmented) {
    // The store's declaration wins where there is one; a control past the
    // `maxStateKeys` ceiling declares nothing and falls back to its own node, so
    // it still works as a control even though no `where` can read it.
    let declaration = stateDeclarations.first { $0.stateKey == segmented.stateKey } ?? segmented.declaration
    let next = PluginVocabState.apply(panelState, declaration: declaration, value: option.value)
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

  /// The option a control is currently showing as chosen.
  func selectedValue(in segmented: PluginVocabSegmented) -> String {
    panelState[segmented.stateKey] ?? segmented.initial
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

    case var .list(list):
      guard let bind = list.bind else { return node }
      let rows = entries(for: bind, limit: PluginVocabLimits.maxListItems)
      list.items = (list.items ?? []) + rows.compactMap {
        PluginPanelParser.parseBoundListItem($0.value, allowActions: bind.allowActions)
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
      ?? sync.pluginCollectionEntries(binding: fetch, pluginId: pluginId, limit: limit)
    guard filtered else { return rows }
    let kept = PluginVocabState.filter(binding.whereClauses, rows, state: panelState) { $0.value }
    // Filter first, cap second — the order every client shares.
    guard let cap = binding.limit, kept.count > cap else { return kept }
    return Array(kept.prefix(cap))
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
  func perform(_ action: PluginVocabAction, extraArgs: [String: Any] = [:]) {
    if let confirm = action.confirm {
      pendingConfirmation = PluginPendingConfirmation(action: action, extraArgs: extraArgs, message: confirm)
      return
    }
    dispatch(action, extraArgs: extraArgs)
  }

  func confirmPending() {
    guard let pending = pendingConfirmation else { return }
    pendingConfirmation = nil
    dispatch(pending.action, extraArgs: pending.extraArgs)
  }

  private func dispatch(_ action: PluginVocabAction, extraArgs: [String: Any]) {
    Task { [weak self] in
      await self?.runAction(action, extraArgs: extraArgs)
    }
  }

  /// One dispatch, awaited.
  ///
  /// Split out of ``dispatch(_:extraArgs:)`` so a refresh gesture can hold its
  /// spinner until the plugin has answered. A control that fires and forgets
  /// still goes through here, so there is exactly one definition of what
  /// running an action does to the pane.
  private func runAction(_ action: PluginVocabAction, extraArgs: [String: Any]) async {
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
        presentation = resolvePresentation()
      }
      if let navigation = result.navigate {
        navigate(to: navigation)
      }
    } catch {
      actionMessage = PluginActionMessage(
        text: (error as NSError).localizedDescription,
        isFailure: true
      )
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

  static func == (lhs: PluginPendingConfirmation, rhs: PluginPendingConfirmation) -> Bool {
    lhs.id == rhs.id
  }
}
