import SwiftUI

/// What a socket invocation tells the plugin about where it was pressed.
///
/// Two shapes ride in the payload, on purpose:
///
/// - `entityKind` / `entityId` at the top level, which is what this app has
///   always sent for a row menu item, and what a plugin written against the
///   phone reads.
/// - `context`, the typed object desktop sends
///   (`apps/desktop/src/shared/plugins/context.ts`), so a plugin written once
///   against the documented contract branches on `context.kind` and works on
///   both clients.
///
/// The phone builds the SHAPE of a desktop context but not always its every
/// field: a lane row here knows its id, not its dirty flag. Absent-tolerant by
/// construction is the contract for these objects, so a thinner context is a
/// smaller projection rather than a wrong one — the alternative, inventing
/// `dirty: false`, would be a lie a plugin could act on.
enum PluginSocketContext: Equatable {
  case surface(PluginSurfaceId)
  case lane(id: String)
  case pr(number: Int)
  case session(id: String)
  case file(path: String)
  case automation(id: String)
  /// The live composer, with the draft read at PRESS time — never at render
  /// time. The button acts on the words on screen at the moment it is tapped.
  case composer(sessionId: String?, draft: String)
  /// The activity pane. `entryId` is the plugin's own id for the row that was
  /// pressed — an activity list is the one surface where a plugin routinely
  /// publishes several rows sharing one action, and "which row" is the only
  /// thing the handler cannot work out for itself.
  case activity(entryId: String, projectKey: String?)

  /// The row address a dynamic contribution for this context is filed under.
  /// Nil for a composer with no chat yet: there is no entity to key on, which
  /// is also why a fresh composer shows no contributed buttons.
  var entity: (kind: PluginEntityKind, id: String)? {
    switch self {
    case let .surface(surface): return (.surface, surface.rawValue)
    case let .lane(id): return (.lane, id)
    case let .pr(number): return (.pr, String(number))
    case let .session(id): return (.session, id)
    case let .file(path): return (.file, path)
    case let .automation(id): return (.automation, id)
    case let .composer(sessionId, _): return sessionId.map { (.session, $0) }
    // An activity row is published against the `app` surface, not against the
    // row: the entry IS the contribution, so there is no narrower entity to key
    // a second contribution on.
    case .activity: return (.surface, PluginSurfaceId.app.rawValue)
    }
  }

  private var contextObject: [String: Any] {
    switch self {
    case let .surface(surface):
      return ["kind": "surface", "surface": surface.rawValue]
    case let .lane(id):
      return ["kind": "lane", "id": id]
    case let .pr(number):
      return ["kind": "pr", "number": number]
    case let .session(id):
      return ["kind": "session", "id": id]
    case let .file(path):
      var object: [String: Any] = ["kind": "file", "path": path]
      if let ext = pluginFileExtension(path) { object["extension"] = ext }
      return object
    case let .automation(id):
      return ["kind": "automation", "id": id]
    case let .composer(sessionId, draft):
      // `cursor` is null rather than absent, and truthfully so: this composer
      // publishes no caret offset, and desktop's own contract says a null
      // cursor means "insert by appending". Sending a made-up 0 would tell a
      // plugin to insert at the START of the user's sentence.
      return [
        "kind": "composer",
        "sessionId": sessionId as Any? ?? NSNull(),
        "draft": draft,
        "cursor": NSNull(),
      ]
    case let .activity(entryId, projectKey):
      // `laneId` is null and truthfully so: the phone's Activity drawer is
      // account-wide — every agent on every signed-in machine — so there is no
      // lane in view to name. Sending the last lane the user happened to open
      // would tell a plugin its row was about work it has nothing to do with.
      return [
        "kind": "activity",
        "entryId": entryId,
        "projectKey": projectKey as Any? ?? NSNull(),
        "laneId": NSNull(),
      ]
    }
  }

  var invokePayload: [String: Any] {
    var payload: [String: Any] = ["context": contextObject]
    if let entity {
      payload["entityKind"] = entity.kind.rawValue
      payload["entityId"] = entity.id
    }
    return payload
  }
}

/// Visible plugin buttons in one cluster before the rest fold into an overflow
/// menu. Two is what a phone toolbar or composer row carries without pushing
/// the surface's own controls off — the same restraint, and the same number, as
/// `PLUGIN_ROW_BADGE_VISIBLE_LIMIT`.
let pluginActionVisibleLimit = 2

/// How wide a contributed button's label may grow before it truncates.
///
/// A cap rather than a wrap: these sit in single-line rows beside the product's
/// own controls, and a plugin that named a forty-character label must not be
/// able to push the send button off the screen. The tail ellipsis is the honest
/// end of that — the alpha test saw a label cut with no ellipsis at all, which
/// reads as a broken string rather than a long one.
let pluginActionLabelMaxWidth: CGFloat = 132

/// The row-badge socket: plugin badges appended to a row's existing trailing
/// cluster.
///
/// Placement is host-controlled and always AFTER the product's own signals —
/// a contribution never reorders or replaces core metadata, it only follows it.
/// Two badges show and the rest collapse into a count, which is what a dense
/// Lanes or PRs row can carry without pushing the branch pair off screen.
struct PluginRowBadgeCluster: View {
  let badges: PluginRowBadges

  init(_ badges: PluginRowBadges) {
    self.badges = badges
  }

  var body: some View {
    if !badges.isEmpty {
      HStack(spacing: 5) {
        ForEach(badges.visible) { contribution in
          if let badge = contribution.badge {
            badgeView(badge)
              .accessibilityLabel(badge.tooltip ?? badge.text)
          }
        }
        if badges.overflow > 0 {
          ADEGlassStatusBadge(text: "+\(badges.overflow)", tint: ADEColor.textMuted)
            .accessibilityLabel("\(badges.overflow) more plugin badges")
        }
      }
      .fixedSize(horizontal: true, vertical: false)
    }
  }

  @ViewBuilder
  private func badgeView(_ badge: PluginRowBadgePayload) -> some View {
    if let icon = PluginSymbol.symbol(badge.icon) {
      ADEGlassChip(icon: icon, text: badge.text, tint: badge.tone.color)
    } else {
      ADEGlassStatusBadge(text: badge.text, tint: badge.tone.color)
    }
  }
}

/// The row-menu-item socket: plugin entries appended to a row's context menu.
///
/// Placed after the row's own "go to" entries and before its destructive
/// section, which is deliberate — the deletes are fenced behind a divider
/// precisely so a mis-tap right after the menu opens cannot land on one, and a
/// plugin must not be able to push them back up under a moving finger.
///
/// `danger` styles the entry — SwiftUI paints a `.destructive` menu button in
/// the system's destructive colour, the same answer desktop gives it. It does
/// not move the entry into the fenced section below: the role changes how the
/// item reads, never where it sits, and where it sits stays the host's call.
///
/// The renderer owns gestures here, not the schema: menu entries only. A swipe
/// action would need a `List` (`.swipeActions` works nowhere else) and would
/// race the row's own long-press recognizer.
///
/// The section is drawn whole here — filter, empty guard and leading divider —
/// so a surface only has to say where the group goes. Left to the call sites,
/// Lanes and Work disagreed about the divider and about which contributions
/// count as menu items.
struct PluginRowMenuItems: View {
  let contributions: [PluginContribution]
  let isEnabled: Bool
  let onInvoke: (PluginContribution) -> Void

  var body: some View {
    let items = contributions.filter { $0.menuItem != nil }
    if !items.isEmpty {
      Divider()
      ForEach(items) { contribution in
        if let item = contribution.menuItem {
          Button(role: Self.role(for: item)) {
            onInvoke(contribution)
          } label: {
            if let icon = PluginSymbol.symbol(item.icon) {
              Label(item.label, systemImage: icon)
            } else {
              Text(item.label)
            }
          }
          .disabled(!isEnabled)
        }
      }
    }
  }

  /// A `danger` item asks for the product's destructive styling, which on a
  /// menu button is the role rather than a foreground colour — a `Menu` draws
  /// its own labels and ignores one.
  static func role(for item: PluginRowMenuItemPayload) -> ButtonRole? {
    item.danger ? .destructive : nil
  }
}

extension SyncService {
  /// Dispatch a row's plugin menu item. Fire-and-forget for its OUTCOME: a
  /// context menu has already dismissed by the time the call resolves, so there
  /// is nowhere to show a spinner and a success line would land on a surface the
  /// user has left.
  ///
  /// A `navigate` is the exception, and the only one. It is not a report on what
  /// happened — it is the rest of the interaction the user started, so it opens
  /// the pane on the panel the plugin sent them to.
  func invokeRowContribution(_ contribution: PluginContribution) {
    guard let item = contribution.menuItem else { return }
    // The row already knows which entity it is: `plugin_contributions` keys on
    // it, so the context is rebuilt from the row rather than threaded down from
    // whichever surface drew the menu.
    let context: PluginSocketContext = switch contribution.entityKind {
    case .lane: .lane(id: contribution.entityId)
    // A PR row's entity id IS its number — that is what
    // `pluginContributionKeyForContext` writes and what the host stores. A row
    // that is not numeric came from something that did not follow the contract,
    // and the untouched `entityId` still rides in the payload beside this.
    case .pr: .pr(number: Int(contribution.entityId) ?? 0)
    case .session: .session(id: contribution.entityId)
    case .file: .file(path: contribution.entityId)
    case .automation: .automation(id: contribution.entityId)
    case .surface: .surface(PluginSurfaceId(rawValue: contribution.entityId) ?? .work)
    }
    ADEHaptics.light()
    Task { [weak self] in
      guard let self else { return }
      await self.invokeSocketContribution(
        contribution,
        actionId: item.actionId,
        context: context
      )
    }
  }

  /// Dispatch one socket contribution and honour the response verbs this client
  /// can honour.
  ///
  /// `navigate` opens the plugin's pane, because it is not a report on what
  /// happened — it is the rest of the interaction the user started. The result
  /// comes back so a caller that HAS a composer can apply a `composer` edit;
  /// callers without one drop it, which is the same degradation a client with
  /// no pane gives `navigate`.
  ///
  /// Never throws. A socket press has nowhere to show a failure on a phone —
  /// the menu has dismissed, the toolbar button has no error slot — so a
  /// failure resolves to nil and the surface stays as it was.
  @discardableResult
  func invokeSocketContribution(
    _ contribution: PluginContribution,
    actionId: String,
    context: PluginSocketContext
  ) async -> PluginInvokeResult? {
    let result = try? await invokePluginAction(
      pluginId: contribution.pluginId,
      actionId: actionId,
      payload: context.invokePayload
    )
    if let navigation = result?.navigate {
      presentedPluginPane = PluginPaneRequest(
        pluginId: contribution.pluginId,
        panelId: navigation.panelId,
        title: pluginPresenceCatalog().label(for: contribution.pluginId),
        context: navigation.context ?? [:]
      )
    }
    return result
  }
}

// MARK: - Loading contributions into a surface

/// Keeps a surface's contribution index current without making any row fetch.
///
/// Two things move the answer and both are folded into one trigger: the plugin
/// tables changing (`pluginsProjectionRevision`) and the phone attaching to a
/// different machine (`pluginPresenceTrigger`).
///
/// Both remote reads resolve BEFORE the index is built, and each for its own
/// reason. Presence, because the index filters on it — building first and
/// filtering later would show every machine's contributions for one frame. And
/// the manifest declarations, because they are half of what the index contains:
/// a surface built from published rows alone would draw, then visibly grow the
/// plugin's declared buttons a moment later.
///
/// Both collapse across surfaces revealing together, so this costs one pair of
/// round trips per scope rather than one pair per tab.
private struct PluginContributionLoader: ViewModifier {
  let entityKind: PluginEntityKind
  let active: Bool
  @Binding var index: PluginContributionIndex

  @EnvironmentObject private var syncService: SyncService

  func body(content: Content) -> some View {
    content.task(id: reloadKey) {
      guard active else { return }
      await syncService.pluginPresenceGate.ensureAnswer()
      guard !Task.isCancelled else { return }
      let declarations = await syncService.pluginSocketDeclarations()
      guard !Task.isCancelled else { return }
      index = syncService.pluginContributionIndex(
        entityKind: entityKind,
        declarations: declarations
      )
    }
  }

  private var reloadKey: String? {
    guard active else { return nil }
    return "\(syncService.pluginsProjectionRevision)|\(syncService.pluginPresenceTrigger)"
  }
}

extension View {
  /// Load and keep fresh the plugin contributions for one entity kind.
  ///
  /// Named for the verb rather than the noun so it cannot be confused with the
  /// `pluginContributions` state each surface holds — the two would read
  /// identically at the call site and mean opposite things.
  func loadPluginContributions(
    _ entityKind: PluginEntityKind,
    into index: Binding<PluginContributionIndex>,
    active: Bool = true
  ) -> some View {
    modifier(PluginContributionLoader(entityKind: entityKind, active: active, index: index))
  }
}

// MARK: - toolbar-action

/// Contributed buttons on a surface's top bar, grouped after the surface's own.
///
/// Two visible and the rest in an overflow menu, matching desktop. A toolbar is
/// the surface's primary verbs; a plugin joins that row rather than taking it
/// over, and on a phone the row is about four controls wide before the title
/// starts truncating.
struct PluginToolbarActions: View {
  let contributions: [PluginContribution]
  let surface: PluginSurfaceId

  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    if !contributions.isEmpty {
      let visible = contributions.prefix(pluginActionVisibleLimit)
      let hidden = contributions.dropFirst(pluginActionVisibleLimit)
      HStack(spacing: 4) {
        ForEach(Array(visible)) { contribution in
          if let action = contribution.toolbarAction {
            if action.menu.isEmpty {
              Button {
                invoke(contribution, actionId: action.actionId)
              } label: {
                toolbarGlyph(action)
              }
              .buttonStyle(.plain)
              .disabled(action.disabled || !syncService.canInvokePluginActions)
              .accessibilityLabel(attributedLabel(action.label, contribution))
            } else {
              // Tap runs the action, press-and-hold reveals the rest — the
              // system's own split-button gesture for a bar button, and the
              // only one available where the glyph is 38 points wide and there
              // is nowhere to put a chevron beside it.
              Menu {
                ForEach(action.menu) { entry in
                  Button(role: entry.danger ? .destructive : nil) {
                    invoke(contribution, actionId: entry.actionId)
                  } label: {
                    Text(entry.label)
                  }
                  .disabled(!syncService.canInvokePluginActions)
                }
              } label: {
                toolbarGlyph(action)
              } primaryAction: {
                invoke(contribution, actionId: action.actionId)
              }
              .disabled(action.disabled || !syncService.canInvokePluginActions)
              .accessibilityLabel(attributedLabel(action.label, contribution))
              .accessibilityHint("Press and hold for \(action.menu.count) more actions")
            }
          }
        }
        if !hidden.isEmpty {
          Menu {
            ForEach(Array(hidden)) { contribution in
              if let action = contribution.toolbarAction {
                Button {
                  invoke(contribution, actionId: action.actionId)
                } label: {
                  Label(action.label, systemImage: PluginSymbol.resolve(action.icon, fallback: "puzzlepiece.extension"))
                }
                .disabled(action.disabled || !syncService.canInvokePluginActions)
                ForEach(action.menu) { entry in
                  Button(role: entry.danger ? .destructive : nil) {
                    invoke(contribution, actionId: entry.actionId)
                  } label: {
                    Text(entry.label)
                  }
                  .disabled(!syncService.canInvokePluginActions)
                }
              }
            }
          } label: {
            Image(systemName: "ellipsis")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .frame(width: 30, height: 34)
              .contentShape(Rectangle())
          }
          .accessibilityLabel("\(hidden.count) more plugin actions")
        }
      }
    }
  }

  /// The button shows an icon only — the top bar has no room for a label — so
  /// the plugin's name has to travel in the accessibility label, which is the
  /// one place attribution is guaranteed to survive.
  private func attributedLabel(_ label: String, _ contribution: PluginContribution) -> String {
    "\(label), \(syncService.pluginPresenceCatalog().label(for: contribution.pluginId))"
  }

  private func toolbarGlyph(_ action: PluginActionButtonPayload) -> some View {
    Image(systemName: PluginSymbol.resolve(action.icon, fallback: "puzzlepiece.extension"))
      .font(.system(size: 15, weight: .semibold))
      .foregroundStyle(ADEColor.textSecondary)
      .frame(width: 38, height: 34)
      .contentShape(Rectangle())
  }

  private func invoke(_ contribution: PluginContribution, actionId: String) {
    ADEHaptics.light()
    Task { @MainActor in
      await syncService.invokeSocketContribution(
        contribution,
        actionId: actionId,
        context: .surface(surface)
      )
    }
  }
}

// MARK: - empty-state

/// What plugins add to an empty surface, UNDER the product's own explanation of
/// why it is empty — never instead of it. An empty Lanes tab still means "you
/// have no lanes"; a plugin may offer a way to get some.
///
/// Written to sit inside ``ADEEmptyStateView``'s `actions` slot, which is why it
/// carries its own spacing and no card of its own.
struct PluginEmptyStateExtras: View {
  let contributions: [PluginContribution]
  let surface: PluginSurfaceId

  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    if !contributions.isEmpty {
      VStack(spacing: 10) {
        ForEach(contributions) { contribution in
          if let empty = contribution.emptyState {
            VStack(spacing: 6) {
              Text(empty.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .multilineTextAlignment(.center)
              if let body = empty.body {
                Text(body)
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
                  .multilineTextAlignment(.center)
                  .fixedSize(horizontal: false, vertical: true)
              }
              if let actionId = empty.actionId {
                ADEGlassActionButton(
                  title: empty.actionLabel ?? empty.title,
                  symbol: "puzzlepiece.extension",
                  tint: ADEColor.accent
                ) {
                  ADEHaptics.light()
                  Task { @MainActor in
                    await syncService.invokeSocketContribution(
                      contribution,
                      actionId: actionId,
                      context: .surface(surface)
                    )
                  }
                }
                .disabled(!syncService.canInvokePluginActions)
              }
              PluginAttributionLine(pluginId: contribution.pluginId)
            }
            .frame(maxWidth: .infinity)
            .padding(12)
            .background(
              ADEColor.surfaceBackground.opacity(0.5),
              in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
          }
        }
      }
      .padding(.top, 4)
    }
  }
}

/// Who contributed the thing above this line.
///
/// Drawn wherever a contribution occupies enough of the screen to be mistaken
/// for the product's own content — an empty-state card, a detail section, the
/// file-viewer offer. A badge or a toolbar icon carries no attribution because
/// there is nowhere to put one; those get it in the accessibility label.
struct PluginAttributionLine: View {
  let pluginId: String

  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    let name = syncService.pluginPresenceCatalog().label(for: pluginId)
    HStack(spacing: 4) {
      Image(systemName: "puzzlepiece.extension")
        .font(.system(size: 9, weight: .semibold))
      Text(name)
        .font(.caption2)
    }
    .foregroundStyle(ADEColor.textMuted)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Contributed by \(name)")
  }
}

// MARK: - filter-chip

/// Contributed filter chips, appended after a list's own filter controls.
///
/// Multi-select, matching the desktop rule: a row survives when it carries ANY
/// selected key, and an empty selection filters nothing at all. The selection
/// lives with the LIST rather than here — it is list state, it has to outlive
/// this view's redraws, and the list is what applies it.
struct PluginFilterChips: View {
  let contributions: [PluginContribution]
  @Binding var selectedKeys: Set<String>

  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    if !contributions.isEmpty {
      ForEach(contributions) { contribution in
        if let chip = contribution.filterChip {
          let isSelected = selectedKeys.contains(chip.filterKey)
          Button {
            ADEHaptics.light()
            if isSelected {
              selectedKeys.remove(chip.filterKey)
            } else {
              selectedKeys.insert(chip.filterKey)
            }
          } label: {
            HStack(spacing: 5) {
              Image(systemName: "puzzlepiece.extension")
                .font(.system(size: 9, weight: .semibold))
              Text(chip.label)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
              if let count = chip.count {
                Text("\(count)")
                  .font(.caption2.weight(.semibold))
                  .foregroundStyle(ADEColor.textMuted)
              }
            }
            .foregroundStyle(isSelected ? ADEColor.accent : ADEColor.textSecondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
              isSelected ? ADEColor.accent.opacity(0.14) : ADEColor.surfaceBackground.opacity(0.5),
              in: Capsule(style: .continuous)
            )
            .overlay(
              Capsule(style: .continuous)
                .stroke(isSelected ? ADEColor.accent.opacity(0.4) : ADEColor.border.opacity(0.22), lineWidth: 0.5)
            )
            .glassEffect()
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(chip.label), \(syncService.pluginPresenceCatalog().label(for: contribution.pluginId))")
          .accessibilityValue(isSelected ? "Selected" : "Not selected")
        }
      }
    }
  }
}

// MARK: - detail-section

/// Contributed sections in a detail screen, after the product's own.
///
/// Each is the plugin's vocabulary panel rendered in place — the same renderer
/// the full pane uses, which is what makes a detail section portable: a plugin
/// writes one panel and it draws on desktop, on the phone, and in the pane.
struct PluginDetailSections: View {
  let contributions: [PluginContribution]
  let context: PluginSocketContext
  /// Passed rather than read from the environment because each section builds a
  /// ``PluginPaneStore`` in its `init`, where `@EnvironmentObject` is not yet
  /// populated. Same reason, and the same shape, as ``PluginPaneSheet``.
  let syncService: SyncService

  var body: some View {
    if !contributions.isEmpty {
      VStack(alignment: .leading, spacing: 16) {
        ForEach(contributions) { contribution in
          if let section = contribution.detailSection {
            PluginDetailSection(
              contribution: contribution,
              section: section,
              context: context,
              syncService: syncService
            )
          }
        }
      }
    }
  }
}

/// One contributed section.
///
/// A view of its own because it owns a ``PluginPaneStore``: the store resolves
/// the panel's data bindings once and the render then touches no database, the
/// same discipline the pane sheet follows. A `@StateObject` cannot live inside
/// a `ForEach` body without a view to hold it.
private struct PluginDetailSection: View {
  let contribution: PluginContribution
  let section: PluginDetailSectionPayload

  @EnvironmentObject private var syncService: SyncService
  @StateObject private var store: PluginPaneStore

  init(
    contribution: PluginContribution,
    section: PluginDetailSectionPayload,
    context: PluginSocketContext,
    syncService: SyncService
  ) {
    self.contribution = contribution
    self.section = section
    // The section's panel is fixed by the contribution, so the store is created
    // pointing at it. Its render context is the entity the detail screen is
    // about, which is what a `$context` binding inside the panel reads and what
    // rides on every action the panel dispatches.
    _store = StateObject(wrappedValue: PluginPaneStore(
      pluginId: contribution.pluginId,
      panelId: section.panelId,
      context: PluginSocketContextValues.remoteJSON(context),
      sync: syncService
    ))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let title = section.title {
        Text(title.uppercased())
          .font(.caption2.weight(.bold))
          .kerning(0.6)
          .foregroundStyle(ADEColor.textMuted)
      }
      sectionBody
      PluginAttributionLine(pluginId: contribution.pluginId)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .task(id: syncService.pluginsProjectionRevision) {
      store.load()
    }
  }

  /// The degradation ladder, trimmed for a section rather than a page.
  ///
  /// A section is a guest on someone else's screen, so a panel that cannot be
  /// read says so in one line instead of taking over with a full empty state —
  /// and a section with no panel row at all draws NOTHING. On the pane, "no
  /// panels yet" is the answer to a question the user asked; inside a PR detail
  /// it would be a mystery card about a plugin they were not thinking about.
  @ViewBuilder
  private var sectionBody: some View {
    switch store.presentation {
    case let .panel(schema):
      VStack(alignment: .leading, spacing: 12) {
        ForEach(Array(schema.body.enumerated()), id: \.offset) { _, node in
          PluginVocabularyNodeView(node: node, store: store)
        }
      }
    case let .updateRequired(fallback):
      PluginSectionNotice(
        symbol: "arrow.up.circle",
        text: fallback?.text ?? "This section needs a newer version of ADE."
      )
    case let .damaged(fallback):
      PluginSectionNotice(
        symbol: "exclamationmark.triangle",
        text: fallback?.text ?? "\(store.displayName) sent a section ADE could not read."
      )
    case .missing:
      EmptyView()
    }
  }
}

private struct PluginSectionNotice: View {
  let symbol: String
  let text: String

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: symbol)
        .font(.system(size: 11, weight: .semibold))
      Text(text)
        .font(.caption)
        .fixedSize(horizontal: false, vertical: true)
    }
    .foregroundStyle(ADEColor.textSecondary)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(10)
    .background(ADEColor.surfaceBackground.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

/// A socket context as the `[String: RemoteJSONValue]` a pane renders with.
///
/// A detail section's panel is opened with the entity it sits on, so the same
/// values a socket press sends have to be readable by a `$context` binding
/// inside the panel. Only scalars cross: the pane's context type is the app's
/// loose-JSON value, and a panel binding renders a fact rather than walking a
/// tree.
enum PluginSocketContextValues {
  static func remoteJSON(_ context: PluginSocketContext) -> [String: RemoteJSONValue] {
    switch context {
    case let .surface(surface):
      return ["kind": .string("surface"), "surface": .string(surface.rawValue)]
    case let .lane(id):
      return ["kind": .string("lane"), "id": .string(id)]
    case let .pr(number):
      return ["kind": .string("pr"), "number": .number(Double(number))]
    case let .session(id):
      return ["kind": .string("session"), "id": .string(id)]
    case let .file(path):
      var values: [String: RemoteJSONValue] = ["kind": .string("file"), "path": .string(path)]
      if let ext = pluginFileExtension(path) { values["extension"] = .string(ext) }
      return values
    case let .automation(id):
      return ["kind": .string("automation"), "id": .string(id)]
    case let .composer(sessionId, draft):
      var values: [String: RemoteJSONValue] = ["kind": .string("composer"), "draft": .string(draft)]
      if let sessionId { values["sessionId"] = .string(sessionId) }
      return values
    case let .activity(entryId, projectKey):
      var values: [String: RemoteJSONValue] = ["kind": .string("activity"), "entryId": .string(entryId)]
      if let projectKey { values["projectKey"] = .string(projectKey) }
      return values
    }
  }
}

// MARK: - composer-action

/// Contributed buttons in the chat composer's accessory row.
///
/// The one socket whose press carries the user's own unsent words, and the one
/// whose response can write them back. Both directions are the point: a button
/// that rewrites, translates or expands a prompt cannot do its job from a
/// session id, and one that could read the draft but not answer with a better
/// one would be a dead end.
///
/// The busy state is why this socket gets minutes where a row button gets
/// seconds (`PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS`): it stays visibly
/// active, refuses a second press, and sits under a caret the user is watching.
/// The phone shows the same spinner for the same reason — its canonical uses
/// (record until I stop, transcribe this, draft that) are open-ended by nature.
struct PluginComposerActions: View {
  let contributions: [PluginContribution]
  let sessionId: String?
  /// Read at press time, never captured at render time.
  let draft: () -> String
  let onEdit: (PluginInvokeComposerEdit) -> Void
  var enabled = true
  /// The single-line composer — one text field, a mic and send, on one row.
  ///
  /// It used to draw NO plugin controls at all, which is what made a plugin
  /// with a composer button visible on desktop and absent on the phone for the
  /// same chat. It draws them now, more tightly: one action inline, several
  /// behind a single plugins menu, because the row genuinely cannot hold a
  /// second labeled control beside a text field the user is typing into.
  var compact = false

  @EnvironmentObject private var syncService: SyncService
  @State private var inFlight: Set<String> = []

  /// One inline control in the compact row, two in the full one.
  private var visibleLimit: Int {
    compact ? 1 : pluginActionVisibleLimit
  }

  var body: some View {
    if !contributions.isEmpty {
      let visible = contributions.prefix(visibleLimit)
      let hidden = contributions.dropFirst(visibleLimit)
      ForEach(Array(visible)) { contribution in
        if let action = contribution.composerAction {
          button(contribution, action)
        }
      }
      if !hidden.isEmpty {
        Menu {
          ForEach(Array(hidden)) { contribution in
            if let action = contribution.composerAction {
              menuEntries(contribution, action)
            }
          }
        } label: {
          // Anonymous in the full row, where it follows two visible plugin
          // buttons and plainly means "more of those". Named in the compact
          // one, where it is the ONLY plugin affordance on screen and an
          // ellipsis would be a menu the reader has no reason to open.
          Image(systemName: compact ? "puzzlepiece.extension" : "ellipsis")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 28, height: 28)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("\(hidden.count) more plugin actions")
      }
    }
  }

  /// One contributed control: a labeled pill, and a chevron beside it when the
  /// action carries a menu.
  ///
  /// Labeled rather than icon-only, which is the correction the alpha test
  /// earned twice over. A composer button's whole job is to say what it will do
  /// to the words the reader has already typed, and a manifest icon token is
  /// drawn from a small shared set that cannot express "sober up" — the icon
  /// identifies the plugin, the label is the verb.
  @ViewBuilder
  private func button(_ contribution: PluginContribution, _ action: PluginActionButtonPayload) -> some View {
    let busy = inFlight.contains(contribution.id)
    HStack(spacing: 0) {
      Button {
        invoke(contribution, actionId: action.actionId)
      } label: {
        HStack(spacing: 5) {
          if busy {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: PluginSymbol.resolve(action.icon, fallback: "puzzlepiece.extension"))
              .font(.system(size: 11, weight: .semibold))
          }
          Text(action.label)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .truncationMode(.tail)
        }
        .foregroundStyle(ADEColor.textSecondary)
        .padding(.leading, 9)
        .padding(.trailing, action.menu.isEmpty ? 9 : 6)
        .frame(height: 28)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(isDisabled(contribution, disabled: action.disabled))
      .accessibilityLabel("\(action.label), \(syncService.pluginPresenceCatalog().label(for: contribution.pluginId))")
      .accessibilityValue(busy ? "Working" : "")

      if !action.menu.isEmpty {
        // A separate hit target rather than a long-press, matching the send
        // control a few points to its right: the extra actions have to be
        // reachable by a reader who has never held anything down in this app.
        Menu {
          ForEach(action.menu) { entry in
            Button(role: entry.danger ? .destructive : nil) {
              invoke(contribution, actionId: entry.actionId)
            } label: {
              Text(entry.label)
            }
            .disabled(isDisabled(contribution, disabled: false))
          }
        } label: {
          Image(systemName: "chevron.down")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 20, height: 28)
            .contentShape(Rectangle())
        }
        .disabled(isDisabled(contribution, disabled: false))
        .accessibilityLabel("More \(action.label) actions")
      }
    }
    // The cap and the ellipsis together: a long label ends in "…" instead of
    // being cut mid-word, and the pill keeps its intrinsic width against the
    // text field beside it rather than being squeezed to its icon.
    .frame(maxWidth: pluginActionLabelMaxWidth)
    .fixedSize(horizontal: false, vertical: true)
    .layoutPriority(1)
    .background(ADEColor.surfaceBackground.opacity(0.38), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(ADEColor.border.opacity(0.24), lineWidth: 0.5)
    )
  }

  /// An overflowed action as menu rows: the action itself, then whatever its
  /// own menu carried, indented one level so a split button that folded into
  /// the overflow does not lose half of itself.
  @ViewBuilder
  private func menuEntries(
    _ contribution: PluginContribution,
    _ action: PluginActionButtonPayload
  ) -> some View {
    if action.menu.isEmpty {
      Button {
        invoke(contribution, actionId: action.actionId)
      } label: {
        Label(action.label, systemImage: PluginSymbol.resolve(action.icon, fallback: "puzzlepiece.extension"))
      }
      .disabled(isDisabled(contribution, disabled: action.disabled))
    } else {
      Menu {
        Button {
          invoke(contribution, actionId: action.actionId)
        } label: {
          Label(action.label, systemImage: PluginSymbol.resolve(action.icon, fallback: "puzzlepiece.extension"))
        }
        .disabled(isDisabled(contribution, disabled: action.disabled))
        ForEach(action.menu) { entry in
          Button(role: entry.danger ? .destructive : nil) {
            invoke(contribution, actionId: entry.actionId)
          } label: {
            Text(entry.label)
          }
          .disabled(isDisabled(contribution, disabled: false))
        }
      } label: {
        Label(action.label, systemImage: PluginSymbol.resolve(action.icon, fallback: "puzzlepiece.extension"))
      }
    }
  }

  private func isDisabled(_ contribution: PluginContribution, disabled: Bool) -> Bool {
    disabled || !enabled || !syncService.canInvokePluginActions || inFlight.contains(contribution.id)
  }

  private func invoke(_ contribution: PluginContribution, actionId: String) {
    guard !inFlight.contains(contribution.id) else { return }
    inFlight.insert(contribution.id)
    ADEHaptics.light()
    let context = PluginSocketContext.composer(sessionId: sessionId, draft: draft())
    Task { @MainActor in
      // The flag clears on every exit — success, failure, cancellation — or a
      // dropped socket mid-call would strand the button in its spinner with no
      // way back short of leaving the chat.
      defer { inFlight.remove(contribution.id) }
      let result = await syncService.invokeSocketContribution(
        contribution,
        actionId: actionId,
        context: context
      )
      if let edit = result?.composer { onEdit(edit) }
    }
  }
}

// MARK: - chat-header-action

/// What a plugin adds to the chat header's own overflow menu — the three-dot
/// control at the top right of a conversation.
///
/// The retrospective's explicit ask, and the one placement the phone had no
/// socket for: a plugin could badge a row, sit in the composer, or take a
/// toolbar slot, and none of those is where a reader looks for "things I can do
/// to this chat".
///
/// Entries are grouped into a section per plugin, titled with the plugin's
/// name. That is the iOS convention for a menu that mixes owners, and it is the
/// only attribution a menu row can carry — there is no room for a subtitle, and
/// an unattributed "Sober up" sitting under "Rename" and "Delete chat" would
/// read as one of ADE's own verbs.
///
/// Drawn AFTER the product's own entries wherever it is placed, and never
/// before the destructive ones: the delete is fenced behind a divider precisely
/// so a mis-tap cannot land on it, and a plugin must not be able to push it
/// under a moving finger.
struct PluginChatHeaderMenuItems: View {
  let contributions: [PluginContribution]
  /// Plugin id → display name, resolved by the caller. Passed rather than read
  /// from the environment because the header menu is `Equatable`-gated and an
  /// observed object inside it would defeat that gate — an open menu rebuilt
  /// mid-stream dismisses whatever submenu the reader had opened.
  let pluginNames: [String: String]
  let isEnabled: Bool
  let onInvoke: (PluginContribution, String) -> Void

  var body: some View {
    let entries = contributions.filter { $0.chatHeaderAction != nil }
    ForEach(groupedByPlugin(entries), id: \.pluginId) { group in
      Section(pluginNames[group.pluginId] ?? group.pluginId) {
        ForEach(group.contributions) { contribution in
          if let action = contribution.chatHeaderAction {
            row(contribution, action)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func row(
    _ contribution: PluginContribution,
    _ action: PluginActionButtonPayload
  ) -> some View {
    if action.menu.isEmpty {
      Button {
        onInvoke(contribution, action.actionId)
      } label: {
        Label(action.label, systemImage: PluginSymbol.resolve(action.icon, fallback: "puzzlepiece.extension"))
      }
      .disabled(action.disabled || !isEnabled)
    } else {
      // A submenu, with the primary action as its first row. Inside a menu
      // there is no press-versus-long-press to split, so the button's own
      // action has to be listed or it becomes unreachable from here.
      Menu {
        Button {
          onInvoke(contribution, action.actionId)
        } label: {
          Label(action.label, systemImage: PluginSymbol.resolve(action.icon, fallback: "puzzlepiece.extension"))
        }
        .disabled(action.disabled || !isEnabled)
        ForEach(action.menu) { entry in
          Button(role: entry.danger ? .destructive : nil) {
            onInvoke(contribution, entry.actionId)
          } label: {
            Text(entry.label)
          }
          .disabled(!isEnabled)
        }
      } label: {
        Label(action.label, systemImage: PluginSymbol.resolve(action.icon, fallback: "puzzlepiece.extension"))
      }
    }
  }

  /// Contributions bucketed by plugin, keeping the placement order the index
  /// already sorted them into. First appearance decides a plugin's position, so
  /// the sections are as stable across reads as the rows inside them.
  private func groupedByPlugin(
    _ entries: [PluginContribution]
  ) -> [(pluginId: String, contributions: [PluginContribution])] {
    var order: [String] = []
    var byPlugin: [String: [PluginContribution]] = [:]
    for entry in entries {
      if byPlugin[entry.pluginId] == nil { order.append(entry.pluginId) }
      byPlugin[entry.pluginId, default: []].append(entry)
    }
    return order.map { (pluginId: $0, contributions: byPlugin[$0] ?? []) }
  }
}

// MARK: - file-viewer

/// A plugin offering to open the file on screen in one of its own panels.
///
/// Desktop slots a plugin viewer into its viewer registry, between the built-in
/// viewers and the binary fallback, so the file simply opens in it. The phone
/// does not have that seam — `FilesEditorMode` is a compiled two-case enum and
/// a plugin cannot join it — so the offer is explicit: the file still opens the
/// way it always did, and the plugin's view is one tap away above it. That is
/// the honest shape for a viewer that may not be able to render the file at
/// all, and it never takes a file hostage behind a plugin that is misbehaving.
struct PluginFileViewerOffer: View {
  let contribution: PluginContribution
  let relativePath: String

  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    if let viewer = contribution.fileViewer {
      Button {
        ADEHaptics.light()
        syncService.presentedPluginPane = PluginPaneRequest(
          pluginId: contribution.pluginId,
          panelId: viewer.panelId,
          title: syncService.pluginPresenceCatalog().label(for: contribution.pluginId),
          context: PluginSocketContextValues.remoteJSON(.file(path: relativePath))
        )
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "puzzlepiece.extension")
            .font(.system(size: 10, weight: .semibold))
          Text("Open in \(syncService.pluginPresenceCatalog().label(for: contribution.pluginId))")
            .font(.caption.weight(.semibold))
            .lineLimit(1)
          Image(systemName: "chevron.right")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
        }
        .foregroundStyle(ADEColor.accent)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(ADEColor.accent.opacity(0.1), in: Capsule(style: .continuous))
        .glassEffect()
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
    }
  }
}

// MARK: - chat-card

/// A plugin's panel, drawn inside a transcript card's frame.
///
/// The card is an ordinary `ade_card` and stays one: this view is only the
/// panel that hangs under it. The split is the whole design — the card supplies
/// chronology, which a `plugin_contributions` row has no way to express, and
/// the contribution supplies permission, which an emitted card has no way to
/// earn. A card whose plugin never declared the panel renders without this
/// view and loses nothing else it carried.
///
/// A view of its own for the same reason ``PluginDetailSection`` is: it owns a
/// ``PluginPaneStore``, and a `@StateObject` needs a view to live in.
struct PluginChatCardPanel: View {
  @EnvironmentObject private var syncService: SyncService
  @StateObject private var store: PluginPaneStore

  /// - Parameter context: the card's own `$context`, merged over the chat it
  ///   sits in.
  init(
    pluginId: String,
    panelId: String,
    context: [String: RemoteJSONValue],
    sessionId: String,
    syncService: SyncService
  ) {
    // Desktop hands the panel host two contexts — the card's `$context` binding
    // and the session the card sits in — and this store holds one. Merging with
    // the card's own keys winning is the closest single value: the panel can
    // read both, actions carry both, and a plugin that named a key of its own
    // is not overruled by the session's.
    var merged = PluginSocketContextValues.remoteJSON(.session(id: sessionId))
    for (key, value) in context { merged[key] = value }
    _store = StateObject(wrappedValue: PluginPaneStore(
      pluginId: pluginId,
      panelId: panelId,
      context: merged,
      sync: syncService
    ))
  }

  var body: some View {
    Group {
      switch store.presentation {
      case let .panel(schema):
        VStack(alignment: .leading, spacing: 10) {
          ForEach(Array(schema.body.enumerated()), id: \.offset) { _, node in
            PluginVocabularyNodeView(node: node, store: store)
          }
        }
      case let .updateRequired(fallback):
        PluginSectionNotice(
          symbol: "arrow.up.circle",
          text: fallback?.text ?? "This card needs a newer version of ADE."
        )
      case let .damaged(fallback):
        PluginSectionNotice(
          symbol: "exclamationmark.triangle",
          text: fallback?.text ?? "\(store.displayName) sent a card ADE could not read."
        )
      // The card above already said what happened; a missing panel row adds an
      // empty frame and no information.
      case .missing:
        EmptyView()
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    // Live updates come from re-reading the panel and its bound collections
    // whenever plugin data changes — exactly as a panel behaves in a pane or a
    // detail section. Nothing is re-fetched by re-emitting the card.
    .task(id: syncService.pluginsProjectionRevision) {
      store.load()
    }
  }
}

// MARK: - activity-entry

/// Contributed rows in the Activity drawer, after the pane's own.
///
/// The one place a plugin can say "this needs you" without inventing a
/// notification: a cost guard that has tripped, a linter with findings, a
/// deploy waiting on approval. Before this the only routes were badging a row
/// the user might never scroll to, or borrowing `session.requestSessionAttention`
/// to push an unattributed message to every paired device.
///
/// Deliberately no per-row dismiss. Dismissing ADE's own activity acknowledges
/// a fact the host owns; a plugin's row is the plugin's own state, and a
/// dismiss that its next publish undid would read as the button not working.
/// A plugin retracts its row by deleting the contribution.
struct PluginActivityEntries: View {
  let contributions: [PluginContribution]
  /// The open project, for the context a press carries. Null on a projectless
  /// phone, which is a real state rather than a missing value.
  let projectKey: String?

  @EnvironmentObject private var syncService: SyncService
  @State private var inFlight: Set<String> = []

  /// Emitted as sibling `List` rows rather than one nested column: the drawer
  /// is a `List`, and the row chrome has to land on each row individually or a
  /// section of plugin entries draws as one undivided slab.
  var body: some View {
    ForEach(contributions) { contribution in
      if let entry = contribution.activityEntry {
        row(contribution, entry)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 6, trailing: 16))
      }
    }
  }

  @ViewBuilder
  private func row(_ contribution: PluginContribution, _ entry: PluginActivityEntryPayload) -> some View {
    let name = syncService.pluginPresenceCatalog().label(for: contribution.pluginId)
    let busy = inFlight.contains(contribution.id)
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 9) {
        Image(systemName: "puzzlepiece.extension")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(entry.tone.color)
          .frame(width: 18, height: 18)
          .padding(.top, 1)
        VStack(alignment: .leading, spacing: 2) {
          Text(entry.title)
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          // The plugin's name is always on the row. These sit among rows about
          // the user's own agents and pull requests, and one that did not say
          // whose it was would read as ADE's own claim about their work.
          Text(entry.body.map { "\($0) · \(name)" } ?? name)
            .font(.system(.caption, design: .rounded))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }
      if let actionId = entry.actionId {
        HStack(spacing: 8) {
          Spacer(minLength: 0)
          Button {
            invoke(contribution, actionId: actionId)
          } label: {
            HStack(spacing: 5) {
              if busy { ProgressView().controlSize(.mini) }
              Text(entry.actionLabel ?? "Open")
                .font(.system(.caption, design: .rounded).weight(.semibold))
            }
            .foregroundStyle(ADEColor.accent)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(ADEColor.accent.opacity(0.1), in: Capsule(style: .continuous))
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(busy || !syncService.canInvokePluginActions)
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(entry.title). \(entry.body ?? "") Contributed by \(name)")
  }

  private func invoke(_ contribution: PluginContribution, actionId: String) {
    guard !inFlight.contains(contribution.id) else { return }
    inFlight.insert(contribution.id)
    ADEHaptics.light()
    Task { @MainActor in
      // Clears on every exit — success, failure, cancellation — so a dropped
      // socket mid-call cannot strand the row in its spinner.
      defer { inFlight.remove(contribution.id) }
      await syncService.invokeSocketContribution(
        contribution,
        actionId: actionId,
        context: .activity(entryId: contribution.socketId, projectKey: projectKey)
      )
    }
  }
}
