import Foundation

/// Swift mirror of the plugin vocabulary contract.
///
/// Source of truth: `apps/desktop/src/shared/plugins/vocabulary.ts` — the
/// version constant, the limits, the open component union and the degradation
/// ladder all come from there. One plugin ships a single panel schema to
/// desktop, web, iOS and the TUI, so a schema that parses on one surface must
/// parse the same way here; when that file changes, this one changes with it.
///
/// Three rules from the TS module carry over verbatim and matter most:
///
/// 1. **The component union is OPEN.** A name this build does not know becomes
///    ``PluginVocabNode/unknown(name:)`` and renders as a small marker. It is
///    never a parse failure and never silently drops the rest of the panel.
/// 2. **`fallback` is required.** A panel too damaged to render still shows the
///    plugin's own title and sentence — a panel is never blank.
/// 3. **Data, never code.** Nothing here evaluates: an action names an id the
///    host dispatches, a binding names a collection the plugin already wrote.
///
/// Parsing walks `[String: Any]` from `JSONSerialization` rather than going
/// through `Codable`. The union is recursive and deliberately tolerant, which
/// `Codable`'s all-or-nothing container decoding fights; this is the same
/// decode-never-fails posture as `AgentChatAdeCardPayload` in `RemoteModels.swift`.
enum PluginVocabulary {
  /// Bumped only for a change older clients cannot safely interpret. A panel
  /// declaring a higher version gets the "Update ADE" fallback, not a guess.
  static let version = 1

  /// The reserved pseudo-collection a panel binds to read the context it was
  /// opened with (`VOCAB_CONTEXT_COLLECTION`). It is ADE's, not the plugin's:
  /// the leading `$` is illegal in a collection name, so no real collection can
  /// shadow it and a bound node never has to guess which one it meant.
  static let contextCollection = "$context"
}

/// Narrow a schema-supplied `Double` to an `Int`, or nothing.
///
/// `Int(_:)` traps — not throws — on a value outside `Int`'s range, and every
/// number reaching this file arrived as JSON written by another machine. A
/// panel declaring `"v": 1e300` would crash the app on the first schema read,
/// before the version check that exists to reject it. `9.2e18` sits just inside
/// `Int64.max` (≈9.223e18) with room for the double's own imprecision; anything
/// past it reads as absent, which every caller already handles.
func pluginVocabInt(_ value: Double) -> Int? {
  guard value.isFinite, value >= -9.2e18, value <= 9.2e18 else { return nil }
  return Int(value)
}

/// The same narrowing for a number that means a *position* rather than a
/// quantity.
///
/// Reading an out-of-range value as absent is right for a height or a count —
/// the caller falls back to its own default. It is wrong for a sort key,
/// because absent means "unordered" and sorts to the back: a plugin asking for
/// the front with `-1e300` would land last, and desktop, which sorts the raw
/// JSON number (`sockets.ts:295`), would put it first. Saturating at the bound
/// is the closest `Int` comes to the number the author wrote, and it keeps the
/// two clients showing one row's badges in the same order.
func pluginVocabSaturatingInt(_ value: Double) -> Int? {
  guard !value.isNaN else { return nil }
  if value >= 9.2e18 { return .max }
  if value <= -9.2e18 { return .min }
  return Int(value)
}

enum PluginVocabLimits {
  static let maxNodes = 200
  static let maxDepth = 8
  static let maxSchemaBytes = 65_536
  static let maxSelectOptions = 40
  static let maxTableRows = 100
  static let maxTableColumns = 8
  static let maxListItems = 100
  static let maxKeyValueRows = 60
  static let maxChartSeries = 3
  static let maxChartPoints = 200
  static let maxFormFields = 24
  static let maxTextChars = 4_000
  static let maxLabelChars = 200
  static let maxValueChars = 1_000
  static let maxIdChars = 120
  static let maxActionArgs = 16
  static let maxBindingAllowActions = 16
  /// Trailing buttons on one list row. Three, and the rest go to `overflow`.
  static let maxListItemActions = 3
  /// Actions behind a row's overflow control.
  static let maxListItemOverflow = 6
}

/// Semantic tone. No red: a failure is amber, the house rule stated at the top
/// of `apps/desktop/src/shared/adeCard.ts`. Any red-ish value a plugin author
/// invents folds into `warning` here so a payload cannot bypass it.
enum PluginVocabTone: String, Equatable {
  case neutral
  case accent
  case success
  case warning

  static func normalize(_ raw: Any?) -> PluginVocabTone {
    guard let text = raw as? String else { return .neutral }
    switch text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "accent", "info": return .accent
    case "success", "ok", "pass", "passed": return .success
    case "warning", "warn", "danger", "error", "fail", "failed", "red": return .warning
    default: return .neutral
    }
  }
}

// MARK: - Actions and bindings

/// A flat scalar argument. Nesting is where "data, never code" would start to
/// leak, so anything richer than these three is dropped at parse.
enum PluginVocabScalar: Equatable {
  case text(String)
  case number(Double)
  case flag(Bool)

  var jsonValue: Any {
    switch self {
    case let .text(value): return value
    case let .number(value):
      // Whole numbers go back out as integers so a plugin sees `3`, not `3.0` —
      // but only when they fit, since `Int(_:)` traps rather than saturating.
      guard value == value.rounded(), let whole = pluginVocabInt(value) else { return value }
      return whole
    case let .flag(value): return value
    }
  }
}

/// A reference to an action on the owning plugin. Dispatched through the single
/// `plugins.invoke` command as `{pluginId, actionId, payload}` (design D1/D14).
struct PluginVocabAction: Equatable {
  var action: String
  var args: [String: PluginVocabScalar] = [:]
  /// When set, the client confirms with this sentence before dispatching.
  var confirm: String?

  var argsJSON: [String: Any] {
    args.mapValues { $0.jsonValue }
  }
}

/// A reference into the plugin's own `plugin_collections` rows. The rows are
/// already in render shape — the client does no reshaping.
struct PluginVocabBinding: Equatable {
  var collection: String
  var keyPrefix: String?
  var limit: Int?
  /// The action ids a row from this collection may name. A row naming anything
  /// else carries no action, and a binding with no allowlist yields no action
  /// at all. Mirrors `VocabBinding.allowActions` in `vocabularyNodes.ts`.
  var allowActions: [String]?
}

// MARK: - Nodes

struct PluginVocabStack: Equatable {
  enum Direction: String { case vertical, horizontal }
  enum Gap: String { case none, sm, md, lg }
  enum Align: String { case start, center, end, stretch }

  var direction: Direction = .vertical
  var gap: Gap = .md
  var align: Align = .stretch
  var wrap = false
  var children: [PluginVocabNode] = []
}

struct PluginVocabText: Equatable {
  /// `code` is the only monospace affordance in the vocabulary.
  enum Variant: String { case title, subtitle, body, caption, code }

  var text: String
  var variant: Variant = .body
  var tone: PluginVocabTone = .neutral
}

struct PluginVocabBadge: Equatable {
  var text: String
  var tone: PluginVocabTone = .neutral
  var icon: String?
}

struct PluginVocabButton: Equatable {
  enum Kind: String { case primary, `default`, quiet }

  var label: String
  var onPress: PluginVocabAction
  var kind: Kind = .default
  var icon: String?
  var disabled = false
}

/// A trailing or overflow button on a list row: an action plus how to draw it.
/// Mirrors `VocabListItemAction` in `vocabularyNodes.ts`.
struct PluginVocabListItemAction: Equatable, Identifiable {
  var id: String { "\(action.action)|\(label)" }
  var action: PluginVocabAction
  var label: String
  var kind: PluginVocabButton.Kind = .default
  var icon: String?
}

/// One row of a `list`, and the row shape a `list` binding must materialize.
///
/// Richer than the nodes it would take to build one by hand, on purpose: a row
/// drawn out of `stack`, `badge`, `text` and `button` nodes spent about seven
/// nodes, which capped a panel at roughly 27 rows against `maxNodes`. As one
/// item the whole list is one node's worth of budget, so `maxListItems` becomes
/// the real ceiling. Mirrors `VocabListItem` in `vocabularyNodes.ts`.
struct PluginVocabListItem: Equatable, Identifiable {
  var id: String { "\(title)|\(subtitle ?? "")|\(meta ?? "")|\(mono ?? "")" }
  var title: String
  var subtitle: String?
  var meta: String?
  var tone: PluginVocabTone = .neutral
  var icon: String?
  var onPress: PluginVocabAction?
  /// A chip beside the title.
  var badge: PluginVocabBadge?
  /// Monospace, under `subtitle`. An id, a branch, a short sha — a thing to compare.
  var mono: String?
  /// Trailing buttons, up to `PluginVocabLimits.maxListItemActions`.
  var actions: [PluginVocabListItemAction] = []
  /// Behind the row's overflow menu, up to `PluginVocabLimits.maxListItemOverflow`.
  var overflow: [PluginVocabListItemAction] = []
}

struct PluginVocabList: Equatable {
  var items: [PluginVocabListItem]?
  var bind: PluginVocabBinding?
  var emptyText: String?
}

struct PluginVocabTableColumn: Equatable, Identifiable {
  var id: String { key }
  var key: String
  var label: String
  var alignsTrailing = false
}

struct PluginVocabTable: Equatable {
  var columns: [PluginVocabTableColumn]
  var rows: [[String: String]]?
  var bind: PluginVocabBinding?
  var emptyText: String?
}

struct PluginVocabSelectOption: Equatable, Identifiable {
  var id: String { value }
  var value: String
  var label: String?
}

struct PluginVocabField: Equatable, Identifiable {
  enum Kind: String { case text, secret, select, toggle, number }

  var id: String
  var kind: Kind
  var label: String
  var help: String?
  var placeholder: String?
  var options: [PluginVocabSelectOption] = []
  var min: Double?
  var max: Double?
  var step: Double?
  var initialText: String?
  var initialNumber: Double?
  var initialFlag: Bool?
}

struct PluginVocabForm: Equatable {
  var fields: [PluginVocabField]
  var submitLabel: String
  var submit: PluginVocabAction
}

struct PluginVocabChartPoint: Equatable {
  var x: String
  var y: Double
}

struct PluginVocabChartSeries: Equatable, Identifiable {
  var id: String
  var label: String?
  var tone: PluginVocabTone = .neutral
  var points: [PluginVocabChartPoint]
}

struct PluginVocabChart: Equatable {
  enum Kind: String { case line, bar }

  var kind: Kind
  var series: [PluginVocabChartSeries]
  var title: String?
  var emptyText: String?
}

struct PluginVocabVideo: Equatable {
  var src: String
  var poster: String?
  var title: String?
}

struct PluginVocabImage: Equatable {
  var src: String
  var alt: String
  var maxHeight: Double?
}

struct PluginVocabKeyValueRow: Equatable, Identifiable {
  var id: String { key }
  var key: String
  var value: String
  var tone: PluginVocabTone = .neutral
}

struct PluginVocabKeyValue: Equatable {
  var rows: [PluginVocabKeyValueRow]?
  var bind: PluginVocabBinding?
  var emptyText: String?
}

struct PluginVocabEmptyState: Equatable {
  var title: String
  var description: String?
  var icon: String?
  var actionLabel: String?
  var action: PluginVocabAction?
}

/// One node of a panel body.
///
/// `unknown` and `invalid` are the two degradation members and are the reason
/// this union can be extended by a later desktop release without breaking a
/// phone that shipped today: a name this build has never heard of arrives as
/// `unknown` carrying that name, and a known component with a broken payload
/// arrives as `invalid` carrying why. Both render as a marker; neither can take
/// the panel down with it.
indirect enum PluginVocabNode: Equatable {
  case stack(PluginVocabStack)
  case text(PluginVocabText)
  case badge(PluginVocabBadge)
  case button(PluginVocabButton)
  case list(PluginVocabList)
  case table(PluginVocabTable)
  case form(PluginVocabForm)
  case chart(PluginVocabChart)
  case video(PluginVocabVideo)
  case image(PluginVocabImage)
  case divider(label: String?)
  case keyValue(PluginVocabKeyValue)
  case emptyState(PluginVocabEmptyState)
  case unknown(name: String)
  case invalid(name: String, reason: String)

  /// The schema's own name for this node, used in fallback copy so a user can
  /// tell a plugin author which component did not render.
  var componentName: String {
    switch self {
    case .stack: return "stack"
    case .text: return "text"
    case .badge: return "badge"
    case .button: return "button"
    case .list: return "list"
    case .table: return "table"
    case .form: return "form"
    case .chart: return "chart"
    case .video: return "video"
    case .image: return "image"
    case .divider: return "divider"
    case .keyValue: return "keyValue"
    case .emptyState: return "emptyState"
    case let .unknown(name): return name
    case let .invalid(name, _): return name
    }
  }
}

// MARK: - Panel

struct PluginPanelFallback: Equatable {
  var title: String
  var text: String
  /// `ade://` URL to the fullest version of this content.
  var deeplink: String?
}

struct PluginPanelSchema: Equatable {
  var title: String?
  var fallback: PluginPanelFallback
  var body: [PluginVocabNode]
}

/// Why a whole panel could not be rendered. Distinct from a node-local problem:
/// these produce the fallback card, node problems produce a marker in place.
enum PluginPanelFailure: Equatable {
  case notJSON
  case notObject
  /// The panel needs a newer build. The only failure that earns "Update ADE"
  /// copy — every other one is the plugin's bug, not the app's age.
  case versionUnsupported(declared: Int)
  case schemaTooLarge
  case fallbackMissing
  case bodyMissing
  case tooManyNodes
  case tooDeep
}

struct PluginVocabWarning: Equatable {
  enum Code: String { case unknownComponent, invalidNode, invalidBinding }

  var code: Code
  /// JSON-ish path to the offending value, e.g. `body[2].children[0]`.
  var path: String
  var message: String
}

enum PluginPanelParseResult: Equatable {
  case ok(PluginPanelSchema, warnings: [PluginVocabWarning])
  /// Carries whatever fallback could be dug out of the raw value: a damaged
  /// panel usually still has a readable one, and the plugin's own sentence
  /// beats ours.
  case failed(PluginPanelFailure, fallback: PluginPanelFallback?)
}
