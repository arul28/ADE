import Foundation

/// Row models for the synced plugin tables, and the socket taxonomy the phone
/// renders them through.
///
/// Contracts mirrored here:
/// - `apps/desktop/src/shared/plugins/sockets.ts` — socket kinds, entity kinds,
///   payload shapes, the 2-visible badge cap and the placement comparator.
/// - `apps/ios/ADE/Resources/DatabaseBootstrap.sql` — the `plugin_presence`,
///   `plugin_panels`, `plugin_collections` and `plugin_contributions` DDL,
///   itself a mirror of `kvDb.ts`.
///
/// Everything decodes the way `AgentChatAdeCardPayload` does: optional fields,
/// `try?` containers, unknown values dropped rather than failing the row. A
/// plugin table is written by a machine that may be running a newer ADE than
/// this phone, so tolerance here is the difference between "one contribution
/// does not draw" and "the row vanishes".

// MARK: - Presence

/// One plugin installed on one machine. Rows for other machines exist in the
/// table (presence is fan-out-plus-cache, keyed by `machine_key`), so anything
/// that decides what this phone can *do* must scope to the attached machine —
/// see ``PluginPresenceCatalog``.
struct PluginPresenceRecord: Equatable, Identifiable {
  var id: String { "\(machineKey)|\(pluginId)" }
  var machineKey: String
  var pluginId: String
  var version: String
  var enabled: Bool
  var displayName: String
  var icon: String
  /// Hex accent from the plugin manifest, e.g. `#7C6FF0`. Empty when unset.
  var accent: String
  var updatedAt: String

  /// Display name with a fallback that is never blank: an entry with no label
  /// is worse than one labelled by its id.
  var label: String {
    displayName.isEmpty ? pluginId : displayName
  }
}

/// Presence metadata folded across machines, for display only.
///
/// The fold is deliberate and its limit is worth stating: it answers "what is
/// this plugin called and what colour is it", which is manifest-derived and the
/// same on every machine that has the plugin. It does NOT answer "is this
/// plugin available here" — that question is machine-scoped and belongs to the
/// attached machine's own `plugins.presenceList` reply, because the phone can
/// only ever invoke actions on the machine it is attached to.
struct PluginPresenceCatalog: Equatable {
  private var byPluginId: [String: PluginPresenceRecord] = [:]

  init(records: [PluginPresenceRecord] = []) {
    for record in records {
      guard let existing = byPluginId[record.pluginId] else {
        byPluginId[record.pluginId] = record
        continue
      }
      // Most recently written row wins, so a freshly upgraded machine's label
      // and accent are what the phone shows.
      if record.updatedAt > existing.updatedAt {
        byPluginId[record.pluginId] = record
      }
    }
  }

  func record(for pluginId: String) -> PluginPresenceRecord? {
    byPluginId[pluginId]
  }

  func label(for pluginId: String) -> String {
    byPluginId[pluginId]?.label ?? pluginId
  }

  func accentHex(for pluginId: String) -> String? {
    guard let accent = byPluginId[pluginId]?.accent, !accent.isEmpty else { return nil }
    return accent
  }
}

// MARK: - Panels

/// One row of `plugin_panels`. `schemaJSON` stays a string here on purpose: it
/// is parsed lazily by the pane that shows it, so listing panels never pays for
/// a schema walk, and a panel this build cannot parse still appears in the list
/// with its title.
struct PluginPanelRecord: Equatable, Identifiable {
  var id: String { "\(pluginId)|\(panelId)" }
  var pluginId: String
  var panelId: String
  var title: String
  var icon: String
  /// Which surface the plugin declared this panel for. Free-form: an unknown
  /// value is shown in the plugin's own pane rather than dropped.
  var surface: String
  var schemaJSON: String
  /// Vocabulary version declared by the WRITER. The version inside the schema
  /// is authoritative for parsing; this column exists so a client can tell it
  /// is too old without parsing at all.
  var vocabVersion: Int
  var updatedAt: String
  /// Whether the declaring machine marked this panel as one the phone shows.
  ///
  /// Defaults to true, and that default is the back-compat contract: rows
  /// written before the flag existed carry no answer, and a plugin platform that
  /// hid panels it was unsure about would make an ADE upgrade on the desktop
  /// look like plugins disappearing from the phone.
  var mobile = true
  /// The plugin action this panel's refresh gesture dispatches, when the
  /// manifest declared one. `nil` means the pane has no pull-to-refresh —
  /// a panel whose rows come from the plugin's own collections is already live
  /// and needs no gesture. Mirrors `PluginManifestPanel.refreshAction`.
  var refreshAction: String?
  /// The plugin action this pane dispatches when it is on screen, when the
  /// manifest declared one. `nil` means the host does not tell the plugin the
  /// reader is looking. Mirrors `PluginManifestPanel.viewAction`.
  var viewAction: String? = nil

  var displayTitle: String {
    title.isEmpty ? panelId : title
  }

  /// Whether this build's parser can be expected to render the panel. A newer
  /// version earns the "Update ADE" fallback rather than an attempt.
  var isRenderableVersion: Bool {
    vocabVersion <= PluginVocabulary.version
  }

  /// Read the mobile flag the host stamped into `schema_json`.
  ///
  /// It rides inside the schema because `plugin_panels` is a CRR with a frozen
  /// SQL shape — every version the platform has needed has been carried in the
  /// JSON payload, and an old client simply ignores a root key it does not know.
  ///
  /// The substring guard is not the check, it is the fast path: the roster
  /// decodes every panel row and deliberately leaves `schema_json` unparsed, so
  /// paying for a full parse per row to answer a question almost no row raises
  /// would undo that. Correctness comes from the root lookup below, which runs
  /// only on rows that could possibly carry the key.
  static func mobileFlag(inSchemaJSON schemaJSON: String) -> Bool {
    guard schemaJSON.contains("\"mobile\"") else { return true }
    guard let data = schemaJSON.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let flag = PluginPanelParser.boolValue(object["mobile"]) else {
      return true
    }
    return flag
  }

  /// Read the refresh action the host stamped into `schema_json`.
  ///
  /// Same shape and same fast path as ``mobileFlag(inSchemaJSON:)``, and for
  /// the same reason: the roster leaves `schema_json` unparsed, and almost no
  /// row carries this key. A row written before the key existed answers `nil`,
  /// which is the pane it always had.
  static func refreshAction(inSchemaJSON schemaJSON: String) -> String? {
    guard schemaJSON.contains("\"refreshAction\"") else { return nil }
    guard let data = schemaJSON.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return nil
    }
    return PluginPanelParser.cleanString(object["refreshAction"], max: PluginVocabLimits.maxIdChars)
  }

  /// Read the view action the host stamped into `schema_json`.
  ///
  /// Same shape and same fast path as ``refreshAction(inSchemaJSON:)``. A row
  /// written before the key existed answers `nil`, which is the pane it always
  /// had: the plugin is not told when the reader is looking.
  static func viewAction(inSchemaJSON schemaJSON: String) -> String? {
    guard schemaJSON.contains("\"viewAction\"") else { return nil }
    guard let data = schemaJSON.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return nil
    }
    return PluginPanelParser.cleanString(object["viewAction"], max: PluginVocabLimits.maxIdChars)
  }

  /// Read the host's seeded stamp out of `schema_json`.
  ///
  /// Same shape and same fast path as ``refreshAction(inSchemaJSON:)``, and it
  /// answers the one question the pane needs on open: is this row still the
  /// manifest's SHIPPED default? The host stamps it only where it materializes
  /// a declared schema, and the plugin's own `panels.update` clears it — so
  /// `true` means nobody has published real content here yet, which is the
  /// "Loading…" card a reader would otherwise sit on until they pulled.
  ///
  /// A row written before the key existed answers `false`, which is the pane
  /// this build has always drawn: no first refresh, exactly as before.
  static func seeded(inSchemaJSON schemaJSON: String) -> Bool {
    guard schemaJSON.contains("\"seeded\"") else { return false }
    guard let data = schemaJSON.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let flag = PluginPanelParser.boolValue(object["seeded"]) else {
      return false
    }
    return flag
  }

  /// Whether this row is still the seeded one — see ``seeded(inSchemaJSON:)``.
  ///
  /// Computed rather than stored beside ``mobile`` and ``refreshAction`` on
  /// purpose: every construction site already carries `schemaJSON`, so there is
  /// no path — the SQL mirror, a live `plugin.getPanel`, a test fixture — that
  /// can be built without it or forget to fill it in. It costs a parse, and the
  /// pane asks once when it opens rather than once per row of the roster.
  var isSeeded: Bool { PluginPanelRecord.seeded(inSchemaJSON: schemaJSON) }
}

extension PluginPanelRecord {
  /// Read one `plugin.getPanel` reply.
  ///
  /// Wire shape, taken from the host's own reader rather than guessed:
  /// `apps/desktop/src/main/services/plugins/pluginDataStore.ts:292-319`
  /// (`readPanel`) returns `{pluginId, panelId, title: string|null,
  /// schema: unknown, vocabVersion: number, updatedAt: string|null}`, typed as
  /// `PluginPanelRecord` in `apps/desktop/src/shared/plugins/sdk.ts:2544-2551`
  /// and handed straight back by `pluginHostService.ts:1693-1697`. `null` for
  /// the whole reply means the machine has no such panel — the caller, not this
  /// reader, turns that into copy.
  ///
  /// Two columns the SQL mirror has are NOT on this wire: `icon` and `surface`.
  /// Neither is read by anything that draws a panel — the pane titles itself
  /// from `title` and the sheet is the surface — so they stay empty rather than
  /// being invented.
  ///
  /// `mobile`, `refreshAction` and `viewAction` are read out of the schema exactly as the
  /// mirror path reads them (`Database.fetchPluginPanels`), which is what keeps
  /// a fetched panel and a replicated one the same panel: the host stamps both
  /// into `schema_json`, and an absent `mobile` means shown.
  static func remote(payload: Any?, pluginId: String, panelId: String) -> PluginPanelRecord? {
    guard let object = payload as? [String: Any] else { return nil }
    let schema = object["schema"]
    // A schema the host could not parse comes back as null (its own comment
    // says the record is still returned so the client can draw the declared
    // fallback). An empty string here parses as `damaged`, which is that same
    // outcome on the phone.
    let schemaJSON: String = {
      guard let schema, !(schema is NSNull) else { return "" }
      guard let data = try? adeJSONData(withJSONObject: schema) else { return "" }
      return String(data: data, encoding: .utf8) ?? ""
    }()
    let resolvedPluginId = (object["pluginId"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? pluginId
    let resolvedPanelId = (object["panelId"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? panelId
    guard !resolvedPluginId.isEmpty, !resolvedPanelId.isEmpty else { return nil }
    return PluginPanelRecord(
      pluginId: resolvedPluginId,
      panelId: resolvedPanelId,
      title: (object["title"] as? String) ?? "",
      icon: "",
      surface: "",
      schemaJSON: schemaJSON,
      // Absent reads as this build's own version, which is the tolerant answer:
      // the schema carries its own version and the parser is the thing that
      // decides skew. The column only exists so a client can refuse without
      // parsing, and a host that did not send it has not refused.
      vocabVersion: (object["vocabVersion"] as? NSNumber)?.intValue ?? PluginVocabulary.version,
      updatedAt: (object["updatedAt"] as? String) ?? "",
      mobile: PluginPanelRecord.mobileFlag(inSchemaJSON: schemaJSON),
      refreshAction: PluginPanelRecord.refreshAction(inSchemaJSON: schemaJSON),
      viewAction: PluginPanelRecord.viewAction(inSchemaJSON: schemaJSON)
    )
  }
}

/// One row of `plugin_collections`: render-ready data the plugin materialized on
/// its own machine. `valueJSON` is opaque until a bound component reads it.
struct PluginCollectionEntry: Equatable, Identifiable {
  var id: String { "\(pluginId)|\(collection)|\(key)" }
  var pluginId: String
  var collection: String
  var key: String
  var valueJSON: String
  var updatedAt: String

  var value: Any? {
    guard let data = valueJSON.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
  }

  /// Read one row of a `plugin.getCollection` reply.
  ///
  /// Wire shape from `PluginCollectionRow` in
  /// `apps/desktop/src/shared/plugins/sdk.ts:337-342` — `{collection, key,
  /// value: unknown, updatedAt}` — produced by
  /// `pluginDataStore.ts:212-242` (`listCollection`) and returned unchanged by
  /// `pluginHostService.ts:1699-1706`. `value` arrives DECODED, where the
  /// mirror stores it as text, so it is re-serialized here: every bound
  /// component downstream reads `valueJSON`.
  ///
  /// `pluginId` is the caller's, because the row does not carry one — the read
  /// was already scoped to one plugin.
  static func remote(payload: Any?, pluginId: String) -> PluginCollectionEntry? {
    guard let object = payload as? [String: Any],
          let key = object["key"] as? String, !key.isEmpty,
          let collection = object["collection"] as? String, !collection.isEmpty,
          !pluginId.isEmpty else {
      return nil
    }
    let valueJSON: String = {
      guard let value = object["value"], !(value is NSNull) else { return "null" }
      guard let data = try? adeJSONData(withJSONObject: value) else { return "null" }
      return String(data: data, encoding: .utf8) ?? "null"
    }()
    return PluginCollectionEntry(
      pluginId: pluginId,
      collection: collection,
      key: key,
      valueJSON: valueJSON,
      updatedAt: (object["updatedAt"] as? String) ?? ""
    )
  }
}

// MARK: - Sockets

/// The core surfaces a contribution can be placed on. Mirrors
/// `PLUGIN_SURFACE_IDS` in `sockets.ts`.
///
/// The phone draws five of the eight. `automations`, `cto` and `settings` are
/// listed because the list is closed and shared — a surface id here that iOS has
/// no screen for simply never gets asked for its contributions.
///
/// `app` is the window itself rather than a tab: the palette and the activity
/// pane belong to no list, so a contribution for one is keyed by `surface` and
/// nothing narrower. On the phone that means the Activity drawer.
enum PluginSurfaceId: String, CaseIterable, Equatable {
  case work
  case lanes
  case files
  case prs
  case automations
  case cto
  case app
  case settings
}

/// Where a plugin is allowed to appear on a core surface.
///
/// Eleven of the wire's kinds decode here — every kind the phone has an
/// honest host for. The rest map to ``unsupported``, which drops the row rather
/// than failing the read, and that is what lets a kind ship on desktop first.
///
/// **What the phone can see is narrower than what desktop can see, and the
/// reason is the data path, not the taxonomy.** Desktop reads two sources — a
/// plugin's MANIFEST (its static declarations) and the `plugin_contributions`
/// rows it publishes per entity. iOS has only the second: manifests never
/// replicate, and no `plugins.*` command hands one to a phone. So a
/// contribution reaches this app exactly when the plugin *published* it, and a
/// manifest-only declaration is invisible here by construction.
///
/// That has one consequence worth stating in the type: the surface-scoped kinds
/// (`toolbar-action`, `empty-state`, `filter-chip`, `activity-entry`) and
/// `file-viewer` reach iOS through rows keyed to ``PluginEntityKind/surface``,
/// with the entity id being the surface's own id — see
/// ``PluginContributionIndex``.
enum PluginSocketKind: Equatable {
  case toolbarAction
  case rowBadge
  case rowMenuItem
  case detailSection
  case emptyState
  case filterChip
  case fileViewer
  case composerAction
  /// An entry in the chat header's own overflow menu — the phone's answer to
  /// "can a plugin put something in the three-dot menu at the top right".
  ///
  /// It is a MENU entry rather than a second button beside the ellipsis, and
  /// that is the whole placement difference from desktop, which has room for a
  /// split button in the header row itself: a phone's nav bar is a title and
  /// about two controls wide, so a plugin joins the overflow list under an
  /// attributed heading instead of taking a slot beside it.
  ///
  /// Per-entity and keyed on the session, matching desktop — see
  /// ``PluginContributionIndex/chatHeaderActions(sessionId:)``.
  case chatHeaderAction
  case chatCard
  case activityEntry
  /// A kind the wire defines and this build does not draw — slash commands,
  /// palette actions, settings sections, rail panes, drawer tabs, dialog
  /// sections and graph nodes, none of which the phone has a host for. Their
  /// rows decode to nothing rather than half a control.
  ///
  /// `graph-node` is the one whose absence is a fact about a whole TAB rather
  /// than a missing renderer arm: the phone ships no Graph canvas at all
  /// (`PLUGIN_BUILTIN_SURFACE_MOBILE.graph` is `false`), so there is no place
  /// for such a node to be drawn until that tab is ported. Growing an arm here
  /// without the tab would be the half-drawn state this enum exists to prevent.
  case unsupported(String)

  init(rawValue: String) {
    switch rawValue {
    case "toolbar-action": self = .toolbarAction
    case "row-badge": self = .rowBadge
    case "row-menu-item": self = .rowMenuItem
    case "detail-section": self = .detailSection
    case "empty-state": self = .emptyState
    case "filter-chip": self = .filterChip
    case "file-viewer": self = .fileViewer
    case "composer-action": self = .composerAction
    case "chat-header-action": self = .chatHeaderAction
    case "chat-card": self = .chatCard
    case "activity-entry": self = .activityEntry
    default: self = .unsupported(rawValue)
    }
  }
}

/// The entity a dynamic contribution attaches to. Mirrors `PLUGIN_ENTITY_KINDS`.
enum PluginEntityKind: String, Equatable {
  case lane
  case pr
  case session
  case file
  case automation
  case surface
}

struct PluginRowBadgePayload: Equatable {
  var text: String
  var tone: PluginVocabTone
  var icon: String?
  var tooltip: String?
}

struct PluginRowMenuItemPayload: Equatable {
  var label: String
  var icon: String?
  var danger: Bool
  var actionId: String
}

/// One extra action hanging off a split button's menu.
///
/// Deliberately not a `PluginActionButtonPayload`: an entry has no menu of its
/// own, and a type that could carry one would invite a plugin to nest menus
/// inside menus on a phone, where the second level is already a long-press away.
struct PluginActionMenuEntry: Equatable, Identifiable, Decodable {
  var id: String { actionId }
  var label: String
  var actionId: String
  /// A token from the same 64-name list the button's own `icon` takes, resolved
  /// through ``PluginSymbol``.
  ///
  /// Nil means the puzzle piece, which is what every entry drew before this
  /// field existed — a two-entry menu showed the same generic mark twice and
  /// neither row said what it did. An unknown token degrades to that same
  /// puzzle piece rather than being refused, matching the button above it and
  /// the desktop's own rule.
  var icon: String?
  /// Styles the entry destructive, the same meaning `danger` has on a row menu
  /// item. It changes how the entry READS, never where it sits.
  var danger: Bool

  init(label: String, actionId: String, icon: String? = nil, danger: Bool) {
    self.label = label
    self.actionId = actionId
    self.icon = icon
    self.danger = danger
  }

  private enum CodingKeys: String, CodingKey {
    case label, actionId, icon, danger
  }

  /// Decoded off the manifest feed, where entries arrive as part of a
  /// ``PluginManifestSocketWire``. Tolerant per field like every other wire type
  /// here — an entry that arrives without a label decodes to an empty one and is
  /// dropped by ``PluginContributionParser`` a moment later, which is where the
  /// single set of rules lives.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    label = ((try? container.decodeIfPresent(String.self, forKey: .label)) ?? nil) ?? ""
    actionId = ((try? container.decodeIfPresent(String.self, forKey: .actionId)) ?? nil) ?? ""
    icon = (try? container.decodeIfPresent(String.self, forKey: .icon)) ?? nil
    danger = ((try? container.decodeIfPresent(Bool.self, forKey: .danger)) ?? nil) ?? false
  }
}

/// A button on a surface's toolbar, in the chat composer's accessory row, or in
/// the chat header's overflow menu.
///
/// One struct for three socket kinds, matching the shared arm in
/// `parsePluginContributionPayload` — the payloads are identical and only the
/// CONTEXT differs (a surface or a row, versus the live composer and its unsent
/// draft). Splitting the payload would mean three identical parsers free to
/// drift.
struct PluginActionButtonPayload: Equatable {
  var label: String
  var icon: String?
  var actionId: String
  var disabled: Bool
  /// Extra actions the button carries, which is what makes it a SPLIT button:
  /// pressing it runs `actionId`, and the menu holds the rest.
  ///
  /// Empty is the ordinary case and the only one older payloads can express, so
  /// every renderer treats empty as "plain button" rather than "menu with
  /// nothing in it". The alpha test wanted exactly this shape — a drink button
  /// whose arrow reveals sober-up — and had to reach a slash command instead.
  var menu: [PluginActionMenuEntry] = []
  /// A hex tint for THIS button, already proven legible in both themes.
  ///
  /// Nil is the ordinary case and means the platform's own colour. The value is
  /// only ever written by ``PluginContributionParser/sanitizeActionColor(_:)``,
  /// which applies the same contrast rule as `sanitizePluginActionColor` on the
  /// desktop — so a colour refused there is refused here, and a plugin does not
  /// get a legible button on one client and an invisible one on the other.
  var color: String?
  /// This button claims the composer's Send.
  ///
  /// `composer-action` only in meaning, and parsed on all three action-button
  /// kinds — one arm builds them — so the field cannot drift between the
  /// clients. Only the composer row honours it: a tap ARMS the button instead
  /// of invoking, and Send then runs this action with `args.send == true` and
  /// the live draft. The button's own menu still invokes: a split button's
  /// extra entries are Advanced, never the Send claim.
  ///
  /// Strictly the JSON boolean `true`, matching `parsePluginContributionPayload`
  /// in `shared/plugins/sockets.ts`. A payload saying `"ownsSend": 1` leaves
  /// Send with ADE.
  var ownsSend: Bool = false
}

/// A plugin's vocabulary panel, rendered inside a detail screen after the
/// product's own sections.
struct PluginDetailSectionPayload: Equatable {
  var panelId: String
  var title: String?
}

/// What a plugin adds UNDER a surface's own empty state — never instead of it.
/// An empty Lanes tab still means "you have no lanes".
struct PluginEmptyStatePayload: Equatable {
  var title: String
  var body: String?
  var actionId: String?
  var actionLabel: String?
}

/// A filter chip on a list.
///
/// `filterKey` is what makes the chip filter rather than merely select: the
/// plugin tags the entities that belong to the chip by putting the same key on
/// the contributions it publishes for them, and the list keeps a row when any
/// selected key matches. A chip whose key no row carries selects nothing, which
/// is the honest outcome of a plugin that declared a chip and published no tags.
struct PluginFilterChipPayload: Equatable {
  var label: String
  var filterKey: String
  var count: Int?
}

/// A plugin panel offered as the viewer for a file.
///
/// `extensions` are lowercased and dot-prefixed, matching the host's
/// normalization, so a registration for `[".parquet"]` and a file named
/// `Part.PARQUET` meet in the middle.
struct PluginFileViewerPayload: Equatable {
  var panelId: String
  var extensions: [String]
}

/// A plugin's panel, drawn inside a transcript card.
///
/// This payload is a DECLARATION, not a placement. The card itself arrives as
/// an ordinary `ade_card` transcript event carrying the plugin's attribution
/// and the panel it wants drawn; this contribution is what permits the panel to
/// be drawn at all. The split is what makes the user's per-contribution toggle
/// govern the panel, and what stops an emit from painting an arbitrary panel
/// into a conversation.
///
/// So the card supplies chronology (a transcript row has a position in a
/// conversation; a contribution row does not) and the socket supplies
/// permission. A card whose declaration is missing still renders — title, rows
/// and metrics are real — just without the panel.
struct PluginChatCardPayload: Equatable {
  var panelId: String
  var title: String?
  var icon: String?
}

/// A row in the activity pane: the one place a plugin can say "this needs you"
/// without inventing a notification.
///
/// Rows are ordinary `plugin_contributions`, which is what makes them ephemeral
/// in the right way — a plugin publishes one when something needs attention and
/// deletes it when it stops, and an uninstall takes its rows with it. There is
/// deliberately no per-row dismiss: dismissing ADE's own activity acknowledges
/// a fact the host owns, while a plugin's row is the plugin's own state, and a
/// dismiss the next publish undid would read as the button not working.
struct PluginActivityEntryPayload: Equatable {
  var title: String
  var body: String?
  var tone: PluginVocabTone
  var actionId: String?
  var actionLabel: String?
}

enum PluginContributionPayload: Equatable {
  case toolbarAction(PluginActionButtonPayload)
  case rowBadge(PluginRowBadgePayload)
  case rowMenuItem(PluginRowMenuItemPayload)
  case detailSection(PluginDetailSectionPayload)
  case emptyState(PluginEmptyStatePayload)
  case filterChip(PluginFilterChipPayload)
  case fileViewer(PluginFileViewerPayload)
  case composerAction(PluginActionButtonPayload)
  case chatHeaderAction(PluginActionButtonPayload)
  case chatCard(PluginChatCardPayload)
  case activityEntry(PluginActivityEntryPayload)
}

/// A materialized contribution from `plugin_contributions`, already validated
/// against its socket kind. A row whose payload does not match its kind never
/// becomes one of these — surfaces skip it rather than draw half a control.
struct PluginContribution: Equatable, Identifiable {
  /// Identity for dedupe, ordering and `ForEach`.
  ///
  /// `socketId` is part of it and has to be: for a published row the first four
  /// components are the storage key and are already unique, but a plugin may
  /// DECLARE two contributions of one kind on one surface — two badges, two
  /// toolbar buttons — and those differ only by the manifest id. Without it
  /// they collide into one row.
  var id: String { "\(entityKind.rawValue)|\(entityId)|\(pluginId)|\(socketRaw)|\(socketId)" }
  var entityKind: PluginEntityKind
  var entityId: String
  var pluginId: String
  var socketRaw: String
  var order: Int?
  var payload: PluginContributionPayload
  var updatedAt: String
  /// The plugin's own id for this contribution, which is a different thing from
  /// ``id``: that one is the row's storage key (entity + plugin + socket) and
  /// this one is what the PLUGIN calls the contribution.
  ///
  /// It is the `entryId` an activity row's action carries — an activity list is
  /// the one surface where a plugin routinely publishes several rows that share
  /// an action, and "which row" is the only thing the handler cannot work out
  /// for itself. Identity in the same order of authority desktop uses: an id
  /// the payload carries, then the socket kind.
  var socketId: String
  /// The `id` the payload actually carried, or nil when it carried none.
  ///
  /// Distinct from ``socketId``, which folds in the socket-kind fallback and so
  /// cannot answer "did the author address this row at a declaration". The join
  /// needs that question: an addressed row resolves to one declaration or to
  /// nothing, while an id-less one resolves only when its kind was declared
  /// exactly once.
  var payloadId: String?
  /// Whether this came from a plugin's MANIFEST rather than from a row it
  /// published.
  ///
  /// Load-bearing rather than cosmetic: a published row replaces the
  /// declaration it fills, so the merge has to be able to tell them apart. It
  /// is not derivable from the data — a declaration and a row can carry
  /// identical payloads, which is the whole point of one filling in the other.
  var isDeclaration = false
  /// The filter chip this row's entity belongs to, read off the RAW payload of
  /// every kind rather than only off a chip.
  ///
  /// That is how a contributed chip actually filters: the chip declares a key,
  /// and the plugin tags the entities that match by putting the same key on the
  /// badge or menu item it publishes for them. Reading it only from chip
  /// payloads would make every chip select nothing, since a chip is published
  /// against the surface and the rows it filters are published against entities.
  var filterKey: String?
  /// Ids the SURFACE knew and the stored row cannot carry.
  ///
  /// `plugin_contributions` keys a PR row on its GitHub number, because that is
  /// all `pluginContributionKeyForContext` writes. A plugin that starts an ADE
  /// review needs ADE's own pull-request id and the lane the PR is checked out
  /// in — `launch.js` in `ade-review` validates on both, and neither is
  /// derivable from a number. The screen that drew the row has them, so it
  /// stamps them here on the way to ``SyncService/invokeRowContribution(_:)``.
  ///
  /// Empty is the ordinary case, and it must stay honest: an unstamped
  /// contribution sends nulls, which is what it sent before, rather than a
  /// guessed id a plugin could act on.
  var rowIdentity = PluginRowIdentity()

  /// A copy carrying the ids the drawing surface knows.
  func stamping(_ identity: PluginRowIdentity) -> PluginContribution {
    var copy = self
    copy.rowIdentity = identity
    return copy
  }

  var badge: PluginRowBadgePayload? {
    if case let .rowBadge(payload) = payload { return payload }
    return nil
  }

  var menuItem: PluginRowMenuItemPayload? {
    if case let .rowMenuItem(payload) = payload { return payload }
    return nil
  }

  var toolbarAction: PluginActionButtonPayload? {
    if case let .toolbarAction(payload) = payload { return payload }
    return nil
  }

  var detailSection: PluginDetailSectionPayload? {
    if case let .detailSection(payload) = payload { return payload }
    return nil
  }

  var emptyState: PluginEmptyStatePayload? {
    if case let .emptyState(payload) = payload { return payload }
    return nil
  }

  var filterChip: PluginFilterChipPayload? {
    if case let .filterChip(payload) = payload { return payload }
    return nil
  }

  var fileViewer: PluginFileViewerPayload? {
    if case let .fileViewer(payload) = payload { return payload }
    return nil
  }

  var composerAction: PluginActionButtonPayload? {
    if case let .composerAction(payload) = payload { return payload }
    return nil
  }

  var chatHeaderAction: PluginActionButtonPayload? {
    if case let .chatHeaderAction(payload) = payload { return payload }
    return nil
  }

  var chatCard: PluginChatCardPayload? {
    if case let .chatCard(payload) = payload { return payload }
    return nil
  }

  var activityEntry: PluginActivityEntryPayload? {
    if case let .activityEntry(payload) = payload { return payload }
    return nil
  }
}

enum PluginContributionParser {
  /// Build a contribution from a `plugin_contributions` row.
  ///
  /// Returns nil for anything this build cannot place: an unknown entity kind,
  /// an unsupported socket, or a payload that fails its kind's shape check.
  static func parse(
    entityKind: String,
    entityId: String,
    pluginId: String,
    socket: String,
    payloadJSON: String,
    updatedAt: String
  ) -> PluginContribution? {
    guard let kind = PluginEntityKind(rawValue: entityKind),
          !entityId.isEmpty,
          !pluginId.isEmpty else {
      return nil
    }
    guard let data = payloadJSON.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return nil
    }
    return parse(
      entityKind: kind,
      entityId: entityId,
      pluginId: pluginId,
      socket: socket,
      payloadObject: object,
      updatedAt: updatedAt
    )
  }

  /// The same validation against an already-decoded payload.
  ///
  /// Split out so a manifest DECLARATION reaches the identical arms a published
  /// row does. The alternative — building the payload dictionary and
  /// re-serializing it to JSON just to parse it back — would be the second
  /// place the caps and the required-field rules live, and the two would drift.
  static func parse(
    entityKind kind: PluginEntityKind,
    entityId: String,
    pluginId: String,
    socket: String,
    payloadObject object: [String: Any],
    updatedAt: String
  ) -> PluginContribution? {
    guard !entityId.isEmpty, !pluginId.isEmpty else { return nil }

    let payload: PluginContributionPayload
    switch PluginSocketKind(rawValue: socket) {
    case .rowBadge:
      guard let badge = parseBadge(object) else { return nil }
      payload = .rowBadge(badge)
    case .rowMenuItem:
      guard let item = parseMenuItem(object) else { return nil }
      payload = .rowMenuItem(item)
    case .toolbarAction:
      guard let button = parseActionButton(object) else { return nil }
      payload = .toolbarAction(button)
    case .composerAction:
      guard let button = parseActionButton(object) else { return nil }
      payload = .composerAction(button)
    case .chatHeaderAction:
      guard let button = parseActionButton(object) else { return nil }
      payload = .chatHeaderAction(button)
    case .detailSection:
      guard let section = parseDetailSection(object) else { return nil }
      payload = .detailSection(section)
    case .emptyState:
      guard let empty = parseEmptyState(object) else { return nil }
      payload = .emptyState(empty)
    case .filterChip:
      guard let chip = parseFilterChip(object) else { return nil }
      payload = .filterChip(chip)
    case .fileViewer:
      guard let viewer = parseFileViewer(object) else { return nil }
      payload = .fileViewer(viewer)
    case .chatCard:
      guard let card = parseChatCard(object) else { return nil }
      payload = .chatCard(card)
    case .activityEntry:
      guard let entry = parseActivityEntry(object) else { return nil }
      payload = .activityEntry(entry)
    case .unsupported:
      return nil
    }

    return PluginContribution(
      entityKind: kind,
      entityId: entityId,
      pluginId: pluginId,
      socketRaw: socket,
      order: PluginPanelParser.orderValue(object["order"]),
      payload: payload,
      updatedAt: updatedAt,
      socketId: PluginPanelParser.cleanString(object["id"], max: 64) ?? socket,
      payloadId: PluginPanelParser.cleanString(object["id"], max: 64),
      filterKey: PluginPanelParser.cleanString(object["filterKey"], max: 64)
    )
  }

  private static func parseBadge(_ object: [String: Any]) -> PluginRowBadgePayload? {
    guard let text = PluginPanelParser.cleanString(object["text"], max: 32) else { return nil }
    return PluginRowBadgePayload(
      text: text,
      tone: PluginVocabTone.normalize(object["tone"]),
      icon: PluginPanelParser.cleanString(object["icon"], max: 40),
      tooltip: PluginPanelParser.cleanString(object["tooltip"], max: 200)
    )
  }

  private static func parseMenuItem(_ object: [String: Any]) -> PluginRowMenuItemPayload? {
    guard let label = PluginPanelParser.cleanString(object["label"], max: 60),
          let actionId = PluginPanelParser.cleanString(object["actionId"], max: 64) else {
      return nil
    }
    return PluginRowMenuItemPayload(
      label: label,
      icon: PluginPanelParser.cleanString(object["icon"], max: 40),
      danger: PluginPanelParser.boolValue(object["danger"]) ?? false,
      actionId: actionId
    )
  }

  /// Shared by `toolbar-action`, `composer-action` and `chat-header-action`,
  /// which carry the same payload and differ only in what context the press
  /// sends.
  private static func parseActionButton(_ object: [String: Any]) -> PluginActionButtonPayload? {
    guard let label = PluginPanelParser.cleanString(object["label"], max: 40),
          let actionId = PluginPanelParser.cleanString(object["actionId"], max: 64) else {
      return nil
    }
    return PluginActionButtonPayload(
      label: label,
      icon: PluginPanelParser.cleanString(object["icon"], max: 40),
      actionId: actionId,
      // Strictly `true`, never a truthy number: `boolValue` refuses anything
      // that is not a JSON boolean, so a payload saying `"disabled": 1` leaves
      // the button live rather than silently dead.
      disabled: PluginPanelParser.boolValue(object["disabled"]) ?? false,
      menu: parseActionMenu(object["menu"]),
      color: sanitizeActionColor(object["color"]),
      // Strictly `true` for the same reason `disabled` is.
      ownsSend: PluginPanelParser.boolValue(object["ownsSend"]) == true
    )
  }

  /// Narrow an untrusted button tint, or nil for "use the platform's own".
  ///
  /// A transcription of `sanitizePluginActionColor` in `shared/plugins/sockets.ts`,
  /// and it has to stay one: the payload carries ONE colour while the user picks
  /// the theme, so a colour that reads on dark and vanishes on light is a button
  /// that is invisible for half the installs. Judging it here rather than
  /// trusting the producer is the same rule the rest of this parser follows — a
  /// row may have been published by an older or newer host than the one reading
  /// it.
  ///
  /// Refused rather than nudged into range, for the desktop's reason: a host
  /// that silently darkened a plugin's brand colour would paint something the
  /// author never chose and never tell them.
  static func sanitizeActionColor(_ raw: Any?) -> String? {
    guard let value = PluginPanelParser.cleanString(raw, max: 7),
          let (red, green, blue) = parseHexTriple(value) else { return nil }
    let luminance = relativeLuminance(red: red, green: green, blue: blue)
    // `--color-bg` for `dark` and `light` in the desktop's `index.css`, as WCAG
    // relative luminance. Restated as numbers on both clients because neither
    // has the other's stylesheet to ask.
    for backdrop in [0.0035, 0.898] where contrastRatio(luminance, backdrop) < 3 {
      return nil
    }
    return String(format: "#%02x%02x%02x", red, green, blue)
  }

  /// `#rgb` or `#rrggbb` to three 0-255 channels. Nil for anything else.
  private static func parseHexTriple(_ value: String) -> (Int, Int, Int)? {
    guard value.hasPrefix("#") else { return nil }
    let digits = String(value.dropFirst())
    guard digits.count == 3 || digits.count == 6,
          digits.allSatisfy({ $0.isHexDigit }) else { return nil }
    let expanded = digits.count == 3
      ? digits.map { "\($0)\($0)" }.joined()
      : digits
    let scanned = Array(expanded)
    func channel(_ start: Int) -> Int? {
      Int(String(scanned[start ..< start + 2]), radix: 16)
    }
    guard let red = channel(0), let green = channel(2), let blue = channel(4) else { return nil }
    return (red, green, blue)
  }

  /// WCAG relative luminance of an sRGB triple.
  private static func relativeLuminance(red: Int, green: Int, blue: Int) -> Double {
    func linearize(_ value: Int) -> Double {
      let channel = Double(value) / 255
      return channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue)
  }

  /// WCAG contrast ratio between two relative luminances.
  private static func contrastRatio(_ a: Double, _ b: Double) -> Double {
    (max(a, b) + 0.05) / (min(a, b) + 0.05)
  }

  /// The extra actions a split button carries.
  ///
  /// Absent, null, or not an array all mean "plain button" — a `menu` key this
  /// build cannot read must never cost the plugin its primary action, which is
  /// the part the user can see and press.
  ///
  /// Unreadable ENTRIES drop individually for the same reason: a menu of four
  /// where one lost its `actionId` still opens with the other three, rather than
  /// the whole control degrading over one bad row.
  ///
  /// Label ceiling, field set and cap all mirror `parsePluginActionButtonMenu`.
  /// The field set is the part worth naming: an entry is a label, an action, an
  /// icon token and `danger`, and nothing else. `disabled` is deliberately still
  /// absent — reading one here would dim rows on the phone that the same payload
  /// leaves live on the desktop next to it, a parity gap invented by the client
  /// that was trying to be generous. `icon` is read because the desktop reads
  /// it, which is the same rule pointing the other way.
  private static func parseActionMenu(_ raw: Any?) -> [PluginActionMenuEntry] {
    guard let items = raw as? [Any] else { return [] }
    var entries: [PluginActionMenuEntry] = []
    for item in items {
      if entries.count >= pluginActionMenuEntryLimit { break }
      guard let object = item as? [String: Any],
            let label = PluginPanelParser.cleanString(object["label"], max: 40),
            let actionId = PluginPanelParser.cleanString(object["actionId"], max: 64) else {
        continue
      }
      entries.append(PluginActionMenuEntry(
        label: label,
        actionId: actionId,
        // An over-long token costs the entry its glyph, never the entry: the
        // row still has a label and an action, which is the part the user
        // asked for.
        icon: PluginPanelParser.cleanString(object["icon"], max: 40),
        danger: PluginPanelParser.boolValue(object["danger"]) ?? false
      ))
    }
    return entries
  }

  private static func parseDetailSection(_ object: [String: Any]) -> PluginDetailSectionPayload? {
    guard let panelId = PluginPanelParser.cleanString(object["panelId"], max: 64) else { return nil }
    return PluginDetailSectionPayload(
      panelId: panelId,
      title: PluginPanelParser.cleanString(object["title"], max: 60)
    )
  }

  private static func parseEmptyState(_ object: [String: Any]) -> PluginEmptyStatePayload? {
    guard let title = PluginPanelParser.cleanString(object["title"], max: 80) else { return nil }
    let actionId = PluginPanelParser.cleanString(object["actionId"], max: 64)
    return PluginEmptyStatePayload(
      title: title,
      body: PluginPanelParser.cleanString(object["body"], max: 240),
      actionId: actionId,
      // A label with no action is a button that cannot fire, so it is dropped
      // with the action rather than drawn. The reverse is fine: an action with
      // no label falls back to the title, matching desktop.
      actionLabel: actionId == nil ? nil : PluginPanelParser.cleanString(object["actionLabel"], max: 40)
    )
  }

  private static func parseFilterChip(_ object: [String: Any]) -> PluginFilterChipPayload? {
    guard let label = PluginPanelParser.cleanString(object["label"], max: 40),
          let filterKey = PluginPanelParser.cleanString(object["filterKey"], max: 64) else {
      return nil
    }
    // `intValue` narrows through `pluginVocabInt`, which refuses anything `Int`
    // cannot hold — `Int(Double)` traps rather than saturating, and this number
    // was written by another machine.
    let count = PluginPanelParser.intValue(object["count"])
    return PluginFilterChipPayload(
      label: label,
      filterKey: filterKey,
      count: (count ?? -1) >= 0 ? count : nil
    )
  }

  private static func parseChatCard(_ object: [String: Any]) -> PluginChatCardPayload? {
    guard let panelId = PluginPanelParser.cleanString(object["panelId"], max: 64) else { return nil }
    return PluginChatCardPayload(
      panelId: panelId,
      title: PluginPanelParser.cleanString(object["title"], max: 60),
      icon: PluginPanelParser.cleanString(object["icon"], max: 40)
    )
  }

  private static func parseActivityEntry(_ object: [String: Any]) -> PluginActivityEntryPayload? {
    guard let title = PluginPanelParser.cleanString(object["title"], max: 80) else { return nil }
    let actionId = PluginPanelParser.cleanString(object["actionId"], max: 64)
    return PluginActivityEntryPayload(
      title: title,
      body: PluginPanelParser.cleanString(object["body"], max: 240),
      // `destructive` is the red a failed check earns. Authors write `danger`
      // and the normalizer folds it; a payload cannot invent a sixth colour.
      tone: PluginVocabTone.normalize(object["tone"]),
      actionId: actionId,
      // A label with no action is a button that cannot fire, so it goes with it.
      actionLabel: actionId == nil ? nil : PluginPanelParser.cleanString(object["actionLabel"], max: 40)
    )
  }

  private static func parseFileViewer(_ object: [String: Any]) -> PluginFileViewerPayload? {
    guard let panelId = PluginPanelParser.cleanString(object["panelId"], max: 64) else { return nil }
    let extensions = (object["extensions"] as? [Any] ?? [])
      .compactMap { PluginPanelParser.cleanString($0, max: 16)?.lowercased() }
      .filter { $0.hasPrefix(".") }
    guard !extensions.isEmpty else { return nil }
    return PluginFileViewerPayload(panelId: panelId, extensions: extensions)
  }
}

// MARK: - Placement

/// Visible badges per row before the rest collapse into a "+N" marker. Two is
/// what a dense Lanes/PRs row carries without pushing core metadata off; the
/// constant matches `PLUGIN_ROW_BADGE_VISIBLE_LIMIT` in `sockets.ts`.
let pluginRowBadgeVisibleLimit = 2

/// Extra actions one split button's menu holds before the rest are truncated.
///
/// Matches `PLUGIN_ACTION_MENU_ITEM_LIMIT` in `sockets.ts`, and matching is the
/// whole requirement: the cap is applied at PARSE time on both clients, so a
/// plugin publishing seven entries must not show six on a desktop and seven on
/// the phone beside it.
let pluginActionMenuEntryLimit = 6

/// Host-controlled placement: declared order, then plugin id, then socket.
/// Deterministic across machines so a phone and a desktop showing the same row
/// show the same badges in the same order.
func pluginContributionPrecedes(_ left: PluginContribution, _ right: PluginContribution) -> Bool {
  let leftOrder = left.order ?? Int.max
  let rightOrder = right.order ?? Int.max
  if leftOrder != rightOrder { return leftOrder < rightOrder }
  if left.pluginId != right.pluginId { return left.pluginId < right.pluginId }
  if left.socketRaw != right.socketRaw { return left.socketRaw < right.socketRaw }
  // Two declarations of one kind from one plugin tie on everything above, so
  // the manifest id is what keeps their order stable across reads.
  return left.socketId < right.socketId
}

/// What one row draws in its trailing cluster: the badges that fit, and a count
/// for the ones that did not.
///
/// A value type with an empty default so a row that knows nothing about plugins
/// still compiles and draws nothing — which is how every surface that has not
/// been wired yet behaves.
struct PluginRowBadges: Equatable {
  var visible: [PluginContribution] = []
  var overflow = 0

  static let none = PluginRowBadges()

  var isEmpty: Bool { visible.isEmpty }
}

/// Contributions for one surface, indexed for row lookup.
///
/// Built once per projection revision and passed down by value: a row asking
/// "do I have badges" must not subscribe to the sync service, which republishes
/// constantly for reasons that have nothing to do with plugins.
struct PluginContributionIndex: Equatable {
  private var byEntity: [String: [PluginContribution]] = [:]
  /// Filter keys each entity carries, so a selected chip can keep or drop a row
  /// without re-scanning its contributions.
  private var filterKeysByEntity: [String: Set<String>] = [:]
  /// Manifest declarations. The surface-scoped half is already folded into
  /// `byEntity`; this keeps the per-entity half, which has no entity to be
  /// filed under until a lookup names one.
  private var declarations: PluginSocketDeclarations = .none

  /// - Parameter installedPluginIds: plugins the attached machine reports as
  ///   installed and enabled, or `nil` for "not answered yet".
  ///
  ///   Contribution rows replicate across the account and outlive an uninstall
  ///   elsewhere, so a badge from a plugin this machine no longer has is a
  ///   ghost — desktop drops those rows and so does this. `nil` keeps
  ///   everything on purpose: the presence answer is a round trip, and blanking
  ///   every badge until it lands would make a cold launch look like a mass
  ///   uninstall. Ghost rows survive a few hundred milliseconds; a flicker on
  ///   every launch would be permanent.
  ///
  /// - Parameter declarations: what plugins DECLARED in their manifests, which
  ///   the phone learns from `plugins.list`. Folded in beside the published
  ///   rows so nothing downstream has to know there were two sources.
  init(
    contributions: [PluginContribution] = [],
    declarations: PluginSocketDeclarations = .none,
    installedPluginIds: Set<String>? = nil
  ) {
    self.declarations = declarations
    for contribution in contributions {
      if let installedPluginIds, !installedPluginIds.contains(contribution.pluginId) { continue }
      // The same join the host performs before a row ever leaves it: a switched
      // -off socket, a socket the plugin never declared, and one it has stopped
      // declaring all drop here. Doing it client-side is what the manifest feed
      // made possible — before it, the phone had no declarations to join
      // against and could only render whatever the mirror held.
      var resolved = contribution
      switch declarations.resolve(
        pluginId: contribution.pluginId,
        socket: contribution.socketRaw,
        payloadId: contribution.payloadId,
        surface: PluginSocketDeclarations.surfaceRaw(
          entityKind: contribution.entityKind,
          entityId: contribution.entityId
        )
      ) {
      case .unmatched:
        continue
      case let .matched(match):
        guard match.enabled else { continue }
        // Stamped from the declaration rather than derived from the payload, so
        // an id-less row filling a plugin's only declaration of its kind gets
        // that declaration's real id — which is what lets it REPLACE the
        // declaration instead of sitting beside it.
        resolved.socketId = match.socketId
      case .unknown:
        break
      }
      let key = Self.key(resolved.entityKind, resolved.entityId)
      byEntity[key, default: []].append(resolved)
      if let filterKey = resolved.filterKey {
        filterKeysByEntity[key, default: []].insert(filterKey)
      }
    }
    // Surface-scoped declarations are already entity-shaped, so they join the
    // published rows in the same bucket and every accessor reads one list.
    //
    // Not filtered by `installedPluginIds`, unlike the rows above, and the
    // asymmetry is the point: contribution ROWS replicate across the account
    // and outlive an uninstall elsewhere, which is what makes a ghost possible.
    // Declarations are read from the attached machine's own install list, so
    // every one of them is installed there by construction — filtering would be
    // a no-op that implied the two sources carried the same risk.
    for declaration in declarations.surfaceScoped {
      byEntity[Self.key(declaration.entityKind, declaration.entityId), default: []].append(declaration)
    }
    for key in byEntity.keys {
      byEntity[key] = Self.merge(byEntity[key] ?? [])
    }
  }

  /// Order the contributions for one entity and drop declarations a published
  /// row has already filled in.
  ///
  /// A published row REPLACES the declaration it fills, matched on
  /// `pluginId + socketId`. Rendering both would show a placeholder next to the
  /// real thing and burn one of the two visible badge slots doing it. Matching
  /// on the plugin alone would be worse in the other direction: a plugin
  /// declaring two badges and publishing one would lose the other's
  /// declaration.
  ///
  /// A row whose `socketId` fell back to the socket KIND — which is all an
  /// older host, or a payload with no `id`, can express — keeps the coarser
  /// rule and replaces everything that plugin declared for that kind. That host
  /// can only express one contribution per plugin per socket anyway, and the
  /// alternative is drawing its published badge beside the placeholder the
  /// badge exists to fill in.
  private static func merge(_ all: [PluginContribution]) -> [PluginContribution] {
    let published = all.filter { !$0.isDeclaration }
    guard !published.isEmpty else { return all.sorted(by: pluginContributionPrecedes) }
    var overriddenIds = Set<String>()
    var overriddenKinds = Set<String>()
    for row in published {
      if row.socketId == row.socketRaw {
        overriddenKinds.insert("\(row.pluginId)\u{0}\(row.socketRaw)")
      } else {
        overriddenIds.insert("\(row.pluginId)\u{0}\(row.socketId)")
      }
    }
    let kept = all.filter { entry in
      guard entry.isDeclaration else { return true }
      if overriddenKinds.contains("\(entry.pluginId)\u{0}\(entry.socketRaw)") { return false }
      return !overriddenIds.contains("\(entry.pluginId)\u{0}\(entry.socketId)")
    }
    return kept.sorted(by: pluginContributionPrecedes)
  }

  /// True when nothing would draw for any entity. Declarations count: an index
  /// holding only a manifest badge is not empty, it just has no entity filed
  /// under it yet.
  var isEmpty: Bool { byEntity.isEmpty && declarations.isEmpty }

  private static func key(_ kind: PluginEntityKind, _ id: String) -> String {
    "\(kind.rawValue)|\(id)"
  }

  /// Everything one entity draws: the rows published for it, plus every
  /// declaration for its kind that no published row has filled in.
  ///
  /// The wildcard is stamped with the entity at read time rather than at build
  /// time — a manifest badge applies to every lane, and materializing one copy
  /// per lane would make the index cost scale with the list it describes.
  func contributions(_ kind: PluginEntityKind, _ entityId: String) -> [PluginContribution] {
    let published = byEntity[Self.key(kind, entityId)] ?? []
    let wildcards = declarations.wildcardByEntityKind[kind] ?? []
    guard !wildcards.isEmpty else { return published }
    let stamped = wildcards.map { declaration -> PluginContribution in
      var copy = declaration
      copy.entityId = entityId
      return copy
    }
    return Self.merge(published + stamped)
  }

  /// Contributions a plugin published against a whole surface rather than
  /// against one of its rows — toolbars, empty states and chips.
  ///
  /// Stored as ordinary rows under ``PluginEntityKind/surface`` with the
  /// surface's own id as the entity id, which is the only address a plugin can
  /// name for a surface through `sdk.contributions.publish`.
  func surfaceContributions(_ surface: PluginSurfaceId) -> [PluginContribution] {
    contributions(.surface, surface.rawValue)
  }

  /// The one `row-badge` a plugin published for its own tab, or nil.
  ///
  /// Addressed at `<pluginId>/<surfaceId>` under ``PluginEntityKind/surface``.
  /// Only that plugin's own rows count: another plugin publishing against the
  /// same address does not appear on this glyph.
  func tabBadge(pluginId: String, surfaceId: String) -> PluginContribution? {
    contributions(.surface, "\(pluginId)/\(surfaceId)")
      .first { $0.pluginId == pluginId && $0.badge != nil && !$0.isDeclaration }
  }

  /// The badges a row shows, already capped, plus how many did not fit.
  func badges(_ kind: PluginEntityKind, _ entityId: String) -> PluginRowBadges {
    let all = contributions(kind, entityId).filter { $0.badge != nil }
    let visible = Array(all.prefix(pluginRowBadgeVisibleLimit))
    return PluginRowBadges(visible: visible, overflow: max(0, all.count - visible.count))
  }

  /// Menu items a row appends to its context menu, in placement order.
  func menuItems(_ kind: PluginEntityKind, _ entityId: String) -> [PluginContribution] {
    contributions(kind, entityId).filter { $0.menuItem != nil }
  }

  /// The same list for a PR row, carrying the ids only that row knows.
  ///
  /// Separate accessor rather than an optional argument on the one above, so a
  /// PR surface cannot reach the unstamped version by accident and send a
  /// plugin `id: null` for a pull request ADE has a row for.
  func menuItems(
    forPrNumber number: Int,
    prId: String?,
    laneId: String?
  ) -> [PluginContribution] {
    let identity = PluginRowIdentity(prId: prId, laneId: laneId)
    return menuItems(.pr, String(number)).map { $0.stamping(identity) }
  }

  /// Sections a detail screen appends after its own, in placement order.
  func detailSections(_ kind: PluginEntityKind, _ entityId: String) -> [PluginContribution] {
    contributions(kind, entityId).filter { $0.detailSection != nil }
  }

  /// Buttons the composer's accessory row draws for one chat.
  func composerActions(sessionId: String) -> [PluginContribution] {
    contributions(.session, sessionId).filter { $0.composerAction != nil }
  }

  /// Entries a plugin adds to the chat header's overflow menu, in placement
  /// order.
  ///
  /// Keyed on the SESSION, exactly like a composer action, and the reason is
  /// worth writing down because the desktop call site reads the other way at a
  /// glance: `PluginChatHeaderActions` calls
  /// `useSurfaceContributions("work", "chat-header-action", { context: session })`,
  /// but that hook only LOADS the surface's whole set — `selectContributions`
  /// then narrows it with `pluginContributionKeyForContext(context)`
  /// (`contributionModel.ts:439`), which maps a session context to
  /// `{entityKind: "session", entityId: id}`. So a published row is addressed at
  /// one chat, and a manifest declaration is a wildcard that materializes over
  /// every chat — the same two halves `composer-action` has.
  func chatHeaderActions(sessionId: String) -> [PluginContribution] {
    contributions(.session, sessionId).filter { $0.chatHeaderAction != nil }
  }

  /// `chat-card` declarations for one chat, in placement order.
  ///
  /// A DECLARATION list, not a list of cards to draw: the cards themselves
  /// arrive as transcript events, and this answers "may that card's panel be
  /// drawn". See ``PluginChatCardPayload``.
  func chatCards(sessionId: String) -> [PluginContribution] {
    contributions(.session, sessionId).filter { $0.chatCard != nil }
  }

  /// Whether `pluginId` declared a chat card naming `panelId` for this chat.
  func declaresChatCard(pluginId: String, panelId: String, sessionId: String) -> Bool {
    chatCards(sessionId: sessionId).contains { contribution in
      contribution.pluginId == pluginId && contribution.chatCard?.panelId == panelId
    }
  }

  /// Rows for the activity pane, in placement order.
  func activityEntries() -> [PluginContribution] {
    surfaceContributions(.app).filter { $0.activityEntry != nil }
  }

  func toolbarActions(_ surface: PluginSurfaceId) -> [PluginContribution] {
    surfaceContributions(surface).filter { $0.toolbarAction != nil }
  }

  func emptyStates(_ surface: PluginSurfaceId) -> [PluginContribution] {
    surfaceContributions(surface).filter { $0.emptyState != nil }
  }

  func filterChips(_ surface: PluginSurfaceId) -> [PluginContribution] {
    surfaceContributions(surface).filter { $0.filterChip != nil }
  }

  /// Whether an entity survives the chips the reader has selected.
  ///
  /// An empty selection never filters — every list calls this unconditionally,
  /// and a chip nobody pressed must not hide rows.
  func matchesFilterKeys(
    _ kind: PluginEntityKind,
    _ entityId: String,
    selected: Set<String>
  ) -> Bool {
    guard !selected.isEmpty else { return true }
    guard let keys = filterKeysByEntity[Self.key(kind, entityId)] else { return false }
    return !keys.isDisjoint(with: selected)
  }

  /// The plugin panel offering to view `path`, if one claims it.
  ///
  /// Two addresses answer, in order of specificity: a row published against the
  /// file itself wins over a registration published against the Files surface,
  /// which matches by extension. The per-file row is how a plugin says "this
  /// one file", and it should not be outvoted by its own blanket claim.
  ///
  /// A per-file row may be addressed by either the workspace-relative path or
  /// the absolute one, because a plugin sees whichever its own action was
  /// handed and the two are the same file.
  func fileViewer(relativePath: String, fullPath: String) -> PluginContribution? {
    let exact = contributions(.file, relativePath).first { $0.fileViewer != nil }
      ?? contributions(.file, fullPath).first { $0.fileViewer != nil }
    if let exact { return exact }
    guard let ext = pluginFileExtension(relativePath) else { return nil }
    return surfaceContributions(.files).first { contribution in
      contribution.fileViewer?.extensions.contains(ext) == true
    }
  }
}

/// Lowercase extension including the dot, or nil. Mirrors `pluginFileExtension`
/// in `apps/desktop/src/shared/plugins/context.ts` — including its refusal of a
/// leading-dot name (`.gitignore` has no extension) and of a trailing dot.
func pluginFileExtension(_ filePath: String) -> String? {
  guard let base = filePath.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last else { return nil }
  guard let dot = base.lastIndex(of: ".") else { return nil }
  guard dot != base.startIndex, base.index(after: dot) != base.endIndex else { return nil }
  return String(base[dot...]).lowercased()
}

// MARK: - Declarations

/// Which entity kind a surface's per-entity contributions attach to. Mirrors
/// `SURFACE_ENTITY_KIND` in `contributionModel.ts`.
///
/// The three subject-less surfaces answer `surface`: the CTO thread, the window
/// chrome and a settings page all contribute against the surface itself.
func pluginSurfaceEntityKind(_ surface: PluginSurfaceId) -> PluginEntityKind {
  switch surface {
  case .work: return .session
  case .lanes: return .lane
  case .files: return .file
  case .prs: return .pr
  case .automations: return .automation
  case .cto, .app, .settings: return .surface
  }
}

/// The socket kinds whose contribution belongs to a SURFACE rather than to one
/// of its rows.
///
/// Not derivable from the surface — Lanes hosts both a per-lane badge and a
/// whole-tab toolbar — so it is a property of the kind, and this is the one
/// place that says which is which.
func pluginSocketIsSurfaceScoped(_ kind: PluginSocketKind) -> Bool {
  switch kind {
  case .toolbarAction, .emptyState, .filterChip, .fileViewer, .activityEntry:
    return true
  case .rowBadge, .rowMenuItem, .detailSection, .chatCard, .composerAction, .chatHeaderAction:
    return false
  case .unsupported:
    return false
  }
}

/// A plugin's manifest socket declarations, resolved into contributions.
///
/// This is the half of the socket taxonomy the phone could not see until
/// `plugins.list` grew a `sockets` field: declarations live in the manifest on
/// disk, which no phone has. Before it, iOS rendered only what a plugin had
/// PUBLISHED, so a contribution a plugin merely declared drew on desktop and
/// was absent here.
///
/// A declaration is turned into an ordinary ``PluginContribution`` as early as
/// possible, so every surface, accessor and renderer downstream stays unaware
/// that two sources exist. The one thing a declaration cannot have is an
/// entity: a manifest badge says "I badge lanes", not "I badge lane 7". So the
/// two halves land in different places — a surface-scoped declaration is filed
/// at its surface's own address and is indistinguishable from a published row
/// there, while a per-entity declaration is held as a WILDCARD and merged into
/// every entity of its surface's kind at lookup.
struct PluginSocketDeclarations: Equatable {
  /// Declarations addressed at a surface, already entity-shaped.
  private(set) var surfaceScoped: [PluginContribution] = []
  /// Declarations that apply to every entity of a kind, keyed by that kind.
  private(set) var wildcardByEntityKind: [PluginEntityKind: [PluginContribution]] = [:]
  /// One resolved declaration, as a published row's join answers it.
  struct Match: Equatable {
    var socketId: String
    var enabled: Bool
  }

  /// Declarations keyed `pluginId + socket kind + socket id`.
  ///
  /// The triple is what makes two declarations of one kind independent. Keyed
  /// on plugin and kind alone, a plugin declaring two badges on Lanes collapses
  /// to whichever it declared last, and every published row is then stamped
  /// with that arbitrary winner's id and its `enabled` flag — so the toggle for
  /// one badge hides the other's rows. The host had exactly that bug and fixed
  /// it against this client's per-declaration resolution; this is the other
  /// half of the same agreement.
  private(set) var declaredByTriple: [String: Match] = [:]
  /// The unambiguous case, kept apart: a row naming no socket id can only be
  /// resolved when its kind was declared exactly ONCE.
  private(set) var soleByKind: [String: Match] = [:]
  /// Kinds a plugin declared more than once, where an id-less row has no
  /// non-arbitrary answer and is left unmatched rather than guessed at.
  private(set) var ambiguousKinds: Set<String> = []
  /// Plugins whose declarations this host could actually report.
  ///
  /// The join only governs a plugin listed here. A host too old to send
  /// `sockets` reports nothing for anyone, so every plugin is absent and every
  /// published row stands — the pre-manifest-feed behaviour. A host that DID
  /// read the manifest and found no sockets lists the plugin with nothing
  /// declared, which is the stronger claim, and its rows drop.
  private(set) var knownPlugins: Set<String> = []
  /// The rail tab surface id per plugin, by the ONE rule every client shares.
  ///
  /// Built here because this is the only place the phone already holds the
  /// manifest as the machine read it. Absent for a plugin whose record carried
  /// no `tabs` — an older host — and the caller then falls back to guessing
  /// from the panel rows.
  private(set) var railTabSurfaceByPlugin: [String: String] = [:]

  /// Which surface this plugin's tab, badge and default panel mean, or nil when
  /// this host could not say. See ``pluginRailTabSurface(_:)``.
  func railTabSurfaceId(for pluginId: String) -> String? {
    railTabSurfaceByPlugin[pluginId]
  }

  /// Declaration key: plugin, SURFACE, socket kind.
  ///
  /// The surface term mirrors the host, whose `listContributions` builds this
  /// join inside a per-surface loop and therefore never compares a Lanes badge
  /// with a PRs one. Without it, a plugin declaring `row-badge` on both
  /// surfaces reads as "declared twice" here and every id-less row of that kind
  /// drops as ambiguous — a plugin that works on desktop and shows nothing on
  /// the phone, for a manifest that did nothing wrong.
  private static func kindKey(_ pluginId: String, _ surface: String, _ socket: String) -> String {
    "\(pluginId)\u{0}\(surface)\u{0}\(socket)"
  }

  /// Which surface a published row belongs to, so it joins against that
  /// surface's declarations and no other.
  ///
  /// Every entity kind but `.surface` is reached from exactly one surface, so
  /// the mapping inverts cleanly; a `.surface` row carries the surface's own id
  /// as its entity id, which is the address a plugin publishes it under.
  /// Returns nil for a surface this build has no case for — such a row could
  /// not be drawn anyway, and guessing a surface for it would put it in
  /// another's join.
  static func surfaceRaw(entityKind: PluginEntityKind, entityId: String) -> String? {
    if entityKind == .surface {
      if let surface = PluginSurfaceId(rawValue: entityId) {
        return surface.rawValue
      }
      // A plugin-tab badge is published against `<pluginId>/<tabSurfaceId>`
      // and declared on `app`. ADE surface ids have no slash, so this cannot
      // steal a toolbar row addressed to Work or Lanes.
      //
      // EXACTLY one slash, with something on each side. A transcription of
      // `parsePluginTabContributionEntityId` in `shared/plugins/context.ts`,
      // and it has to stay one: `contains("/")` accepted `a/b/c` and a
      // trailing `a/`, so a row the desktop drops as unaddressable used to be
      // filed under `app` here and drawn on a tab that does not own it.
      if parsePluginTabEntityId(entityId) != nil {
        return PluginSurfaceId.app.rawValue
      }
      return nil
    }
    return PluginSurfaceId.allCases.first { pluginSurfaceEntityKind($0) == entityKind }?.rawValue
  }

  /// Split `<pluginId>/<tabSurfaceId>`, or nil when the id is not that shape.
  ///
  /// Mirrors `parsePluginTabContributionEntityId`: one slash, not the first
  /// character, not the last, and no second slash anywhere.
  static func parsePluginTabEntityId(_ entityId: String) -> (pluginId: String, surfaceId: String)? {
    guard let slash = entityId.firstIndex(of: "/"),
          slash != entityId.startIndex,
          entityId.index(after: slash) != entityId.endIndex,
          entityId.lastIndex(of: "/") == slash else {
      return nil
    }
    return (String(entityId[..<slash]), String(entityId[entityId.index(after: slash)...]))
  }

  static let none = PluginSocketDeclarations()

  var isEmpty: Bool { surfaceScoped.isEmpty && wildcardByEntityKind.isEmpty }

  /// Resolve a published row against the declarations, exactly as the host's
  /// `listContributions` does.
  ///
  /// - `.unknown` when this host could not report the plugin's declarations, so
  ///   there is nothing to join against and the row stands.
  /// - `.matched` when a declaration claims it, carrying that declaration's own
  ///   id and toggle.
  /// - `.unmatched` when the plugin's declarations are known and none claims
  ///   it: a socket the plugin never declared, one it has stopped declaring, or
  ///   an id-less row for a kind declared more than once. All three drop.
  ///
  /// The last case is the one worth stating: an id-less row against two
  /// declarations has no non-arbitrary answer, and guessing is what produced
  /// the bug the host just fixed. It is left unmatched so the two clients agree
  /// about a case neither can resolve, and the author is the one who can — by
  /// putting `id` in the payload.
  enum Resolution: Equatable {
    case unknown
    case matched(Match)
    case unmatched
  }

  func resolve(pluginId: String, socket: String, payloadId: String?, surface: String?) -> Resolution {
    guard knownPlugins.contains(pluginId) else { return .unknown }
    // A row whose surface this build cannot name has no declaration set to be
    // judged against, so it is left alone rather than dropped on a guess.
    guard let surface else { return .unknown }
    let kind = Self.kindKey(pluginId, surface, socket)
    if let payloadId, !payloadId.isEmpty {
      // Addressed: it resolves to that declaration or to nothing. A row naming
      // a socket id the plugin no longer declares is stale, and adopting a
      // different one would move it to a slot its author never chose.
      guard let match = declaredByTriple["\(kind)\u{0}\(payloadId)"] else { return .unmatched }
      return .matched(match)
    }
    if ambiguousKinds.contains(kind) { return .unmatched }
    guard let sole = soleByKind[kind] else { return .unmatched }
    return .matched(sole)
  }

  init() {}

  /// Resolve the declarations of every installed, enabled plugin.
  ///
  /// Three things drop here rather than downstream, matching
  /// `contributionsFromSource`: a disabled plugin's declarations, a socket the
  /// user switched off, and a declaration whose implied payload fails its
  /// kind's shape check. That last one is why this goes back through
  /// ``PluginContributionParser`` rather than trusting itself — a manifest that
  /// parsed but implies a payload with no label is still a contribution that
  /// must not render.
  init(records: [PluginInstallRecordEntry]) {
    for record in records {
      guard record.enabled, !record.pluginId.isEmpty else { continue }
      // A plugin whose record carries no `sockets` at all is one this host
      // could not read a manifest for. It stays out of `knownPlugins`, so its
      // published rows are never joined against declarations it never reported.
      // The rail tab is read off `tabs`, which is present independently of
      // `sockets`: a plugin can declare a tab and no sockets at all.
      if let rail = pluginRailTabSurface(record.tabs), !rail.id.isEmpty {
        railTabSurfaceByPlugin[record.pluginId] = rail.id
      }
      guard let wires = record.sockets else { continue }
      knownPlugins.insert(record.pluginId)
      let disabled = Set(record.disabledContributions)
      for wire in wires {
        let match = Match(socketId: wire.id.isEmpty ? wire.socket : wire.id, enabled: !disabled.contains(wire.id))
        let kind = Self.kindKey(record.pluginId, wire.surface, wire.socket)
        declaredByTriple["\(kind)\u{0}\(match.socketId)"] = match
        if soleByKind[kind] != nil || ambiguousKinds.contains(kind) {
          soleByKind[kind] = nil
          ambiguousKinds.insert(kind)
        } else {
          soleByKind[kind] = match
        }
      }
      for wire in wires {
        guard !disabled.contains(wire.id) else { continue }
        guard let surface = PluginSurfaceId(rawValue: wire.surface) else { continue }
        let kind = PluginSocketKind(rawValue: wire.socket)
        guard let payload = Self.payload(for: kind, wire: wire) else { continue }
        let entityKind = pluginSocketIsSurfaceScoped(kind)
          ? PluginEntityKind.surface
          : pluginSurfaceEntityKind(surface)
        // Addressed at the surface itself when it is surface-scoped, and ALSO
        // when its surface is one of the subject-less three (cto, app,
        // settings): "every entity of kind `surface`" is just that surface, and
        // holding it as a wildcard would leak a CTO declaration into the Lanes
        // surface lookup, which reads the same entity kind.
        let isAddressed = pluginSocketIsSurfaceScoped(kind) || entityKind == .surface
        guard let contribution = PluginContributionParser.parse(
          entityKind: entityKind,
          entityId: isAddressed ? surface.rawValue : "*",
          pluginId: record.pluginId,
          socket: wire.socket,
          payloadObject: payload,
          updatedAt: ""
        ) else {
          continue
        }
        var resolved = contribution
        resolved.isDeclaration = true
        resolved.order = wire.order
        // The manifest socket id is the declaration's identity — what a
        // published row names when it fills this declaration in.
        resolved.socketId = wire.id.isEmpty ? wire.socket : wire.id
        if isAddressed {
          surfaceScoped.append(resolved)
        } else {
          wildcardByEntityKind[entityKind, default: []].append(resolved)
        }
      }
    }
    surfaceScoped.sort(by: pluginContributionPrecedes)
    for key in wildcardByEntityKind.keys {
      wildcardByEntityKind[key]?.sort(by: pluginContributionPrecedes)
    }
  }

  /// The payload a manifest socket implies. Mirrors `payloadFromManifestSocket`.
  ///
  /// Only the kinds iOS draws are built. A kind the phone has no host for
  /// returns nil and its declaration never becomes a contribution — the same
  /// outcome as a published row for that kind, which keeps the two paths
  /// agreeing about what this client renders.
  ///
  /// `row-badge` also returns nil, and for a different reason: a declared badge
  /// draws nothing on any client. See that arm.
  private static func payload(for kind: PluginSocketKind, wire: PluginManifestSocketWire) -> [String: Any]? {
    var object: [String: Any] = [:]
    func put(_ key: String, _ value: String?) {
      guard let value, !value.isEmpty else { return }
      object[key] = value
    }
    switch kind {
    case .toolbarAction, .composerAction, .chatHeaderAction:
      put("label", wire.label)
      put("icon", wire.icon)
      put("actionId", wire.actionId)
      // A declared split button keeps its menu. Handed back as loose JSON so it
      // goes through `parseActionMenu` like a published row does — the cap, the
      // label ceiling and the drop-one-bad-entry rule then live in exactly one
      // place, which is the same discipline desktop's `payloadFromManifestSocket`
      // follows when it passes `menu` through to be re-validated.
      if !wire.menu.isEmpty {
        object["menu"] = wire.menu.map { entry -> [String: Any] in
          var item: [String: Any] = [
            "label": entry.label,
            "actionId": entry.actionId,
            "danger": entry.danger,
          ]
          if let icon = entry.icon { item["icon"] = icon }
          return item
        }
      }
      // Loose like `menu`, and re-judged for the same reason: the contrast rule
      // then lives in one place rather than being re-applied at every hop.
      put("color", wire.color)
      // A Send claim is a MANIFEST fact, so it has to survive the declaration
      // path: the Cursor Cloud launch button is declared and never published,
      // and without this the phone drew it as an ordinary button that invoked
      // on tap while the desktop armed Send.
      if wire.ownsSend { object["ownsSend"] = true }
    case .rowMenuItem:
      put("label", wire.label)
      put("icon", wire.icon)
      put("actionId", wire.actionId)
    case .rowBadge:
      // A manifest badge RESERVES THE SLOT AND DRAWS NOTHING. Only a published
      // per-entity row puts a chip on a row.
      //
      // It used to draw its manifest `label` as a placeholder on every row of
      // its surface, which is bug B4 in the dogfood ledger: the journal plugin
      // declared `label: "0"` and every lane in the list wore a `0` chip
      // forever, because there is no label that reads acceptably as "nothing to
      // say about this row yet". A badge is a value ABOUT one entity, and a
      // manifest cannot know one — unlike a button, whose label is the same
      // verb on every row it appears on, which is why no other kind changes
      // here.
      //
      // The declaration itself still matters and is still built: the loop above
      // files it in `declaredByTriple`, which is what an install disclosure
      // describes and what a published row is matched against. Only the drawing
      // stops.
      return nil
    case .detailSection:
      put("panelId", wire.panelId)
      put("title", wire.label)
    case .emptyState:
      put("title", wire.label)
      put("actionId", wire.actionId)
      put("actionLabel", wire.label)
    case .filterChip:
      put("label", wire.label)
      // The socket id is the fallback key, so a manifest need not carry one.
      put("filterKey", (wire.filterKey?.isEmpty == false) ? wire.filterKey : wire.id)
    case .fileViewer:
      put("panelId", wire.panelId)
      object["extensions"] = wire.extensions
    case .chatCard:
      // The card is the thing with chronology, so its own title wins; what the
      // declaration is FOR is naming which panel may be drawn in a transcript.
      put("panelId", wire.panelId)
      put("title", wire.label)
      put("icon", wire.icon)
    case .activityEntry:
      // Neutral, like a badge: a static entry cannot know whether the thing it
      // describes currently needs anyone. `actionLabel` is left off rather than
      // defaulted to the label, which would print the title twice.
      put("title", wire.label)
      object["tone"] = "neutral"
      put("actionId", wire.actionId)
    case .unsupported:
      return nil
    }
    return object
  }
}

/// Ids a contribution's own storage key cannot hold, supplied by the surface
/// that draws the row. See ``PluginContribution/rowIdentity``.
struct PluginRowIdentity: Equatable {
  /// ADE's own pull-request row id, when this PR is linked in ADE.
  var prId: String?
  /// The lane the PR is checked out in, when there is one.
  var laneId: String?
}
