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

  var displayTitle: String {
    title.isEmpty ? panelId : title
  }

  /// Whether this build's parser can be expected to render the panel. A newer
  /// version earns the "Update ADE" fallback rather than an attempt.
  var isRenderableVersion: Bool {
    vocabVersion <= PluginVocabulary.version
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
}

// MARK: - Sockets

/// Where a plugin is allowed to appear on a core surface.
///
/// The taxonomy is closed on the wire (seven kinds), but this build renders two
/// of them. The rest decode to ``unsupported`` rather than being dropped, so a
/// later iOS release adds a rendering arm without any change to what the host
/// writes.
enum PluginSocketKind: Equatable {
  case rowBadge
  case rowMenuItem
  /// A kind the wire defines and this build does not draw — toolbar actions,
  /// detail sections, empty states, filter chips, file viewers.
  case unsupported(String)

  init(rawValue: String) {
    switch rawValue {
    case "row-badge": self = .rowBadge
    case "row-menu-item": self = .rowMenuItem
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

enum PluginContributionPayload: Equatable {
  case rowBadge(PluginRowBadgePayload)
  case rowMenuItem(PluginRowMenuItemPayload)
}

/// A materialized contribution from `plugin_contributions`, already validated
/// against its socket kind. A row whose payload does not match its kind never
/// becomes one of these — surfaces skip it rather than draw half a control.
struct PluginContribution: Equatable, Identifiable {
  var id: String { "\(entityKind.rawValue)|\(entityId)|\(pluginId)|\(socketRaw)" }
  var entityKind: PluginEntityKind
  var entityId: String
  var pluginId: String
  var socketRaw: String
  var order: Int?
  var payload: PluginContributionPayload
  var updatedAt: String

  var badge: PluginRowBadgePayload? {
    if case let .rowBadge(payload) = payload { return payload }
    return nil
  }

  var menuItem: PluginRowMenuItemPayload? {
    if case let .rowMenuItem(payload) = payload { return payload }
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

    let payload: PluginContributionPayload
    switch PluginSocketKind(rawValue: socket) {
    case .rowBadge:
      guard let badge = parseBadge(object) else { return nil }
      payload = .rowBadge(badge)
    case .rowMenuItem:
      guard let item = parseMenuItem(object) else { return nil }
      payload = .rowMenuItem(item)
    case .unsupported:
      return nil
    }

    return PluginContribution(
      entityKind: kind,
      entityId: entityId,
      pluginId: pluginId,
      socketRaw: socket,
      order: PluginPanelParser.intValue(object["order"]),
      payload: payload,
      updatedAt: updatedAt
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
}

// MARK: - Placement

/// Visible badges per row before the rest collapse into a "+N" marker. Two is
/// what a dense Lanes/PRs row carries without pushing core metadata off; the
/// constant matches `PLUGIN_ROW_BADGE_VISIBLE_LIMIT` in `sockets.ts`.
let pluginRowBadgeVisibleLimit = 2

/// Host-controlled placement: declared order, then plugin id, then socket.
/// Deterministic across machines so a phone and a desktop showing the same row
/// show the same badges in the same order.
func pluginContributionPrecedes(_ left: PluginContribution, _ right: PluginContribution) -> Bool {
  let leftOrder = left.order ?? Int.max
  let rightOrder = right.order ?? Int.max
  if leftOrder != rightOrder { return leftOrder < rightOrder }
  if left.pluginId != right.pluginId { return left.pluginId < right.pluginId }
  return left.socketRaw < right.socketRaw
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

  init(contributions: [PluginContribution] = []) {
    for contribution in contributions {
      byEntity[Self.key(contribution.entityKind, contribution.entityId), default: []].append(contribution)
    }
    for key in byEntity.keys {
      byEntity[key]?.sort(by: pluginContributionPrecedes)
    }
  }

  var isEmpty: Bool { byEntity.isEmpty }

  private static func key(_ kind: PluginEntityKind, _ id: String) -> String {
    "\(kind.rawValue)|\(id)"
  }

  func contributions(_ kind: PluginEntityKind, _ entityId: String) -> [PluginContribution] {
    byEntity[Self.key(kind, entityId)] ?? []
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
}
