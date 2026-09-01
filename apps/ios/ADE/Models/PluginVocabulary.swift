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
  /// Rows one `list` may hold, and the ceiling this phone reads a bound
  /// collection up to. Mirrors `maxListItems`.
  ///
  /// 1000 rather than 250, because 250 was still a reduced issue browser: the
  /// compiled desktop list pages to 500 and the phone to ~1000 on scroll. The
  /// byte budget does not object for BOUND rows — they live in
  /// `plugin_collections` and never touch ``maxSchemaBytes``, so 1000 of them
  /// cost the schema one node. An INLINE list is the only one that spends
  /// bytes, and there ``maxSchemaBytes`` remains the real ceiling: a fully
  /// dressed row measures ~580 bytes, so ~112 of them fill 64 KiB long before
  /// 1000.
  ///
  /// A panel does not draw all 1000 at once — see ``listPageSize``.
  static let maxListItems = 1000
  /// How many rows a `list` draws before the reader asks for more, and how many
  /// one scroll-to-load (or "Show more") adds. Mirrors `listPageSize`.
  ///
  /// Client-local, per list, and never panel state: how far down a list a
  /// reader has walked is a statement about their screen, not about which rows
  /// the panel is showing — the same terms a folded `group` is held on.
  static let listPageSize = 100
  static let maxKeyValueRows = 60
  static let maxChartSeries = 3
  static let maxChartPoints = 200
  static let maxFormFields = 24
  static let maxTextChars = 4_000
  /// A `markdown` node's source. The same ceiling as `maxTextChars`, because
  /// markdown is prose and that is already the prose ceiling — a paragraph does
  /// not earn more room for being formatted. Mirrors `maxMarkdownChars`.
  static let maxMarkdownChars = PluginVocabMarkdownLimits.maxChars
  static let maxLabelChars = 200
  static let maxValueChars = 1_000
  static let maxIdChars = 120
  /// A media `src` or `poster`, with its own reader — see
  /// ``PluginPanelParser/mediaSrc(_:)``.
  ///
  /// Larger than ``maxValueChars`` because a `data:` URI is a legitimate source
  /// and an inline thumbnail does not fit in a thousand characters; well under
  /// ``maxSchemaBytes`` because a panel that spends its whole budget on one
  /// image has nothing left to say about it. Mirrors `maxSrcChars`.
  static let maxSrcChars = 8_192
  static let maxActionArgs = 16
  static let maxBindingAllowActions = 16
  /// Trailing buttons on one list row. Three, and the rest go to `overflow`.
  static let maxListItemActions = 3
  /// Actions behind a row's overflow control.
  static let maxListItemOverflow = 6
  /// Buttons in a panel's nav bar (`chrome.navActions`). Mirrors `maxChromeNavActions`.
  static let maxChromeNavActions = 4
  /// Root nodes in `chrome.footer`. Mirrors `maxChromeFooterNodes`.
  static let maxChromeFooterNodes = 4
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
  /// Keep only the rows this predicate admits, evaluated ON THE CLIENT against
  /// the panel's own `segmented` state.
  ///
  /// This is what makes a filter cost zero round trips: the plugin materializes
  /// every row once with `status`, `laneId` and `archived` already computed on
  /// its machine, and changing the control re-runs nothing but a string compare.
  /// Absent means unfiltered, and so does a `where` whose every clause was
  /// unusable: a filter that fails shows too much, never too little. Mirrors
  /// `VocabBinding.where`, spelled out here because `where` is a Swift keyword.
  var whereClauses: [PluginVocabPredicate]?
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

/// A titled section the reader can collapse.
///
/// A `stack` with a disclosure triangle, and deliberately nothing more. Seven
/// state groups in a fixed rank order — the shape every issue browser has — used
/// to cost seven `segmented` controls whose only job was to hide one section
/// each, which is seven state keys against a ceiling of eight and a filter strip
/// nobody would want to look at.
///
/// **Open/closed is CLIENT-LOCAL and is not panel state.** It never enters
/// ``PluginVocabStateDeclaration``, never signs, never reaches a `where`, and
/// never rides on an action — collapsing a section is a statement about the
/// reader's screen, not about which rows the panel is showing, and a `where`
/// that could read it would make the two indistinguishable. That is also what
/// keeps a group free: a panel may hold as many as its node budget allows
/// without spending a state key on any of them.
///
/// Mirrors `VocabGroupNode` in `vocabularyNodes.ts`.
struct PluginVocabGroup: Equatable {
  var title: String
  /// Stable identity for the open/closed memory. Falls back to ``title``.
  var groupKey: String?
  /// A count beside the title, e.g. `12`. Text only, like an option's badge.
  var badge: String?
  /// A named glyph beside the title — the same token a badge or a button uses.
  var icon: String?
  /// Open on first render. Absent means open — a section nobody has touched
  /// shows its contents.
  var defaultOpen = true
  var children: [PluginVocabNode] = []

  /// What a client remembers this group's open/closed state under.
  ///
  /// The declared ``groupKey`` when there is one, the title otherwise — and
  /// never the node's position, which is what a client keying off `body[2]`
  /// would use. Position is the wrong identity for the case this has to
  /// survive: a plugin republishing its panel with one more group above yours
  /// has not opened the section you closed, but a positional key says it has.
  /// Mirrors `vocabGroupKey`.
  var key: String { groupKey ?? title }
}

struct PluginVocabText: Equatable {
  /// `code` is the only monospace affordance in the vocabulary.
  enum Variant: String { case title, subtitle, body, caption, code }

  var text: String
  var variant: Variant = .body
  var tone: PluginVocabTone = .neutral
}

/// Formatted prose: an issue body, a comment, a release note.
///
/// The subset is `PluginVocabularyMarkdown.swift`, mirrored from
/// `vocabularyMarkdown.ts` — headings, emphasis, code, links, lists, quotes and
/// inert task checkboxes, with no raw HTML anywhere in it and `https:`-only
/// links. One field, on purpose: there is no `maxHeight` twin of
/// ``PluginVocabImage`` here, because prose has a length the ceiling already
/// bounds and a height in points is not a thing a terminal can honour.
///
/// Mirrors `VocabMarkdownNode` in `vocabularyNodes.ts`.
struct PluginVocabMarkdown: Equatable {
  /// Source, already clamped to `PluginVocabLimits.maxMarkdownChars`.
  var text: String
  /// Set by the parser when the source was over the ceiling and was cut.
  ///
  /// A clamped document renders as PLAIN TEXT with a marker rather than as
  /// markdown, on every client: the cut lands wherever the ceiling falls, which
  /// is regularly inside a fence or a link, so the markdown of a truncated
  /// document is not the document's markdown.
  var truncated = false
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
  var id: String { "\(key ?? "")|\(title)|\(subtitle ?? "")|\(meta ?? "")|\(mono ?? "")" }
  var title: String
  /// The row's identity, and the only thing a selection ever holds.
  ///
  /// A declared row writes it; a bound row inherits its collection row's own
  /// primary key, so a plugin that already writes `{title, subtitle}` rows gets
  /// selection for free. A row with no key cannot be ticked — it draws no
  /// checkbox at all rather than one that would put an empty string in a batch,
  /// because a title is not an identity and two issues can share one.
  var key: String?
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
  /// Hover-card payload on desktop/web. This phone shows it as a context-menu
  /// preview; there is no hover.
  var preview: PluginVocabListItemPreview?
}

/// What a list row shows when the pointer rests on it. Mirrors
/// `VocabListItemPreview` in `vocabularyNodes.ts`.
struct PluginVocabListItemPreview: Equatable {
  var title: String?
  var text: String?
}

/// What a `list` needs to carry a multi-row selection.
///
/// The vocabulary had no concept of one: a panel could press a row, and a
/// reader who wanted eleven lanes pressed eleven rows. This is the smallest
/// thing that fixes that — a state key to hold the ticks, and the verbs to offer
/// once there are any.
///
/// `actions` reuses ``PluginVocabListItemAction`` exactly, so a bulk verb and a
/// row verb are the same shape parsed by the same reader. `confirm` therefore
/// works on a batch the way it works on a row, which matters more here — a
/// mistake costs eleven lanes.
///
/// The selection reaches the plugin as `args.selection`, an array of row keys,
/// injected by the HOST at dispatch and last, so a schema cannot name an
/// argument that would replace it. It is the one array in an args object that is
/// otherwise flat scalars, and it is not a hole in rule 3: the client did not
/// compute it, the reader ticked it, and every key in it is one the plugin
/// itself wrote. Mirrors `VocabSelectable` in `vocabularyNodes.ts`.
struct PluginVocabSelectable: Equatable {
  /// Panel-local key holding this list's ticks. Same shape as a `segmented` key.
  var stateKey: String
  /// The bar's buttons, up to ``PluginVocabLimits/maxBulkActions``.
  var actions: [PluginVocabListItemAction]
  /// Most rows ticked at once, already clamped to
  /// ``PluginVocabLimits/maxSelectedRows``.
  var max: Int
}

struct PluginVocabList: Equatable {
  var items: [PluginVocabListItem]?
  var bind: PluginVocabBinding?
  var emptyText: String?
  /// Ticks on every keyed row, and a bulk bar once any of them is ticked.
  var selectable: PluginVocabSelectable?

  /// What a client remembers this list's page count under.
  ///
  /// Content-derived, never positional, for the reason ``PluginVocabGroup/key``
  /// is: a plugin republishing its panel with one more node above the list has
  /// not put the reader back on page one. A bound list is identified by what it
  /// reads, a selectable one by the key its ticks live under, and a literal one
  /// by its first row — the most identity a hand-written list has. Mirrors
  /// `vocabListKey`.
  var pageKey: String {
    if let bind {
      // The same NUL join `bindingKey` uses, so a key minted here reads the
      // same as one minted on any other client.
      return "bind:\(bind.collection)\u{0}\(bind.keyPrefix ?? "")"
    }
    if let selectable { return "sel:\(selectable.stateKey)" }
    let first = items?.first
    return "items:\(first?.key ?? first?.title ?? "")"
  }
}

/// How many rows a list draws right now, and what it must say about that.
///
/// Mirrors `VocabListPage` in `vocabularyPaging.ts`. The reduction it closes is
/// M9 in the parity map: a plugin list stopped dead at 100 rows while the
/// built-in it replaced paged to 500, and it stopped SILENTLY — the reader saw
/// a complete-looking list that was not one.
struct PluginVocabListPage: Equatable {
  /// Rows to draw, filters already applied.
  var drawn: Int
  /// Rows this phone is holding, filters already applied.
  var total: Int
  /// More rows are held than are drawn: the reader may ask for another page.
  var hasMore: Bool
  /// ``total`` is a floor rather than a count.
  ///
  /// True when this phone holds as many rows as it is allowed to hold, which
  /// means the collection may have more and this phone cannot know. There is no
  /// count read in the host's data store, so the honest move is to stop
  /// claiming a total rather than to invent one.
  var totalIsFloor: Bool
}

/// The paging arithmetic and the one sentence that describes it.
///
/// Mirrors `vocabularyPaging.ts` line for line, because four clients each
/// inventing their own wording for "there are more rows" is exactly the drift
/// the shared contract exists to stop.
enum PluginVocabPaging {
  /// Resolve one list's page. `pages` is the reader's own count and starts at 1;
  /// a value below 1 draws the first page rather than nothing.
  static func page(total: Int, pages: Int) -> PluginVocabListPage {
    let held = max(0, total)
    let step = max(1, pages)
    // What the list may EVER draw, which is not the same as what it holds: a
    // node that combines literal `items` with a `bind` can hold more rows than
    // the ceiling allows. Without this, the last page would offer a "Show more"
    // that drew nothing.
    let drawable = min(held, PluginVocabLimits.maxListItems)
    let drawn = min(drawable, step * PluginVocabLimits.listPageSize)
    return PluginVocabListPage(
      drawn: drawn,
      total: held,
      hasMore: drawn < drawable,
      totalIsFloor: held >= PluginVocabLimits.maxListItems
    )
  }

  /// The next page count, clamped so a press past the end is inert.
  static func nextPage(total: Int, pages: Int) -> Int {
    page(total: total, pages: pages).hasMore ? max(1, pages) + 1 : max(1, pages)
  }

  /// The one sentence above the control, or `nil` when a list is drawing
  /// everything it holds and has nothing to explain.
  ///
  /// - `Showing 100 of 143` — 143 rows are held and that is the true total.
  /// - `Showing 100` — as many rows are held as may be, so a total would be a
  ///   guess dressed as a fact.
  /// - `Showing the first 1000` — everything held is drawn and the ceiling is
  ///   why there is no more. Silence here is what made a truncated list look
  ///   complete.
  static func label(_ page: PluginVocabListPage) -> String? {
    if page.hasMore {
      return page.totalIsFloor ? "Showing \(page.drawn)" : "Showing \(page.drawn) of \(page.total)"
    }
    return page.totalIsFloor ? "Showing the first \(page.drawn)" : nil
  }

  /// The words on the control itself. Mirrors `VOCAB_LIST_SHOW_MORE_LABEL`.
  static let showMoreLabel = "Show more"

  /// How many page-steps it takes to draw ``PluginVocabLimits/maxListItems``.
  static var pagesToCeiling: Int {
    (PluginVocabLimits.maxListItems + PluginVocabLimits.listPageSize - 1)
      / PluginVocabLimits.listPageSize
  }
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

/// A form: labelled fields, and how their values reach the plugin.
///
/// Two ways, and a form needs at least one of them. `submit` draws a button and
/// sends the whole values map on one press. `applyOnChange` dispatches on every
/// committed edit with the same map and no button at all — the settings shape,
/// which was not expressible before it existed. Both together is legal.
///
/// Mirrors `VocabFormNode` in
/// `apps/desktop/src/shared/plugins/vocabularyNodes.ts`.
struct PluginVocabForm: Equatable {
  var fields: [PluginVocabField]
  /// The Apply button. Nil only when ``applyOnChange`` is set.
  var submitLabel: String?
  var submit: PluginVocabAction?
  /// Dispatched on every committed field change, with the full values map.
  var applyOnChange: PluginVocabAction?
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
  case group(PluginVocabGroup)
  case text(PluginVocabText)
  case markdown(PluginVocabMarkdown)
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
  case segmented(PluginVocabSegmented)
  case unknown(name: String)
  case invalid(name: String, reason: String)

  /// The schema's own name for this node, used in fallback copy so a user can
  /// tell a plugin author which component did not render.
  var componentName: String {
    switch self {
    case .stack: return "stack"
    case .group: return "group"
    case .text: return "text"
    case .markdown: return "markdown"
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
    case .segmented: return "segmented"
    case let .unknown(name): return name
    case let .invalid(name, _): return name
    }
  }

  /// The children of a node that has any, and `[]` for one that does not.
  ///
  /// Every walk over a panel body goes through here — resolving bindings,
  /// collecting state and selection declarations, rendering. Before `group`
  /// there was one container and each of those walks tested for it by hand,
  /// which made adding a second container several separate chances to forget
  /// one: a `segmented` inside an unwalked container would declare no state
  /// key, and a `list` inside one would bind a collection nobody fetched. Now a
  /// container is added here, once. Mirrors `vocabChildNodes`.
  var childNodes: [PluginVocabNode] {
    switch self {
    case let .stack(stack): return stack.children
    case let .group(group): return group.children
    default: return []
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
  var chrome: PluginVocabPanelChrome?

  /// Body plus footer, in reading order — what a host walks for bindings and selection.
  var contentNodes: [PluginVocabNode] {
    body + (chrome?.footer ?? [])
  }
}

/// The panel's own chrome: a nav-bar search, trailing nav verbs, and a sticky
/// footer. None of these are body nodes — the body scrolls under them.
/// Mirrors `VocabPanelChrome`.
struct PluginVocabPanelChrome: Equatable {
  var search: PluginVocabChromeSearch?
  var navActions: [PluginVocabChromeNavAction] = []
  var footer: [PluginVocabNode] = []
}

struct PluginVocabChromeSearch: Equatable {
  var stateKey: String
  var placeholder: String?
  var onChange: PluginVocabAction?
}

struct PluginVocabChromeNavAction: Equatable {
  var action: PluginVocabAction
  var label: String
  var icon: String?
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
