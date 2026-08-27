import SwiftUI

/// One openable plugin: installed and enabled on the attached machine, and with
/// at least one panel to show.
struct PluginEntry: Identifiable, Equatable {
  var id: String { pluginId }
  var pluginId: String
  var label: String
  var icon: String?
}

/// Resolves which plugins this phone can open right now.
///
/// Two sources, and which answers what is the whole design:
///
/// - **The attached machine** answers *availability*, via the shared
///   ``PluginPresenceGate``. It has to: `plugin_presence` carries rows for every
///   machine on the account, and the phone can only open a pane for the one
///   machine it is talking to. The gate owns the round trip and the
///   hidden-by-default rules so this list and the gated built-in surfaces
///   (the Linear pane) cannot drift into two different definitions of
///   "installed".
/// - **The local mirror** (`plugin_panels`, `plugin_presence`) answers *what to
///   draw* — labels, icons, panel counts — with no round trip.
///
/// A host too old to know `plugins.presenceList` never advertises it, the call
/// is skipped, and the entry point simply is not there. That is the product
/// rule for a missing plugin: hide silently, never a broken button.
@MainActor
final class PluginEntryListModel: ObservableObject {
  @Published private(set) var entries: [PluginEntry] = []

  private let gate: PluginPresenceGate
  private let sync: PluginEntryListSyncing

  init(gate: PluginPresenceGate, sync: PluginEntryListSyncing) {
    self.gate = gate
    self.sync = sync
  }

  func refresh() async {
    await gate.refresh()

    let catalog = sync.pluginPresenceCatalog()
    let panelCounts = Dictionary(grouping: sync.pluginPanels(pluginId: nil), by: \.pluginId)
      .mapValues(\.count)

    entries = gate.installedPlugins
      .compactMap { plugin in
        let panelCount = panelCounts[plugin.pluginId] ?? 0
        guard panelCount > 0 else { return nil }
        let record = catalog.record(for: plugin.pluginId)
        let icon = plugin.icon.isEmpty ? record?.icon : plugin.icon
        return PluginEntry(
          pluginId: plugin.pluginId,
          label: plugin.label,
          icon: icon.flatMap { $0.isEmpty ? nil : $0 }
        )
      }
      .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
  }
}

/// Only the *drawing* half. Availability lives on ``PluginPresenceGateSyncing``,
/// which the gate owns — one fetch, one set of failure rules, one answer.
@MainActor
protocol PluginEntryListSyncing: AnyObject {
  func pluginPresenceCatalog() -> PluginPresenceCatalog
  func pluginPanels(pluginId: String?) -> [PluginPanelRecord]
}

extension SyncService: PluginEntryListSyncing {}

/// The plugin entry in a root tab's top bar: a puzzle-piece button that opens
/// the pane directly when one plugin is installed, and a menu when several are.
///
/// Absent entirely when nothing is installed. The top bar's action slot is
/// about 38pt wide per control and already carries Linear and the bell, so a
/// per-plugin button was never an option — one slot, however many plugins.
struct PluginEntryMenuButton: View {
  @EnvironmentObject private var syncService: SyncService
  @StateObject private var model: PluginEntryListModel

  init(syncService: SyncService) {
    _model = StateObject(wrappedValue: PluginEntryListModel(
      gate: syncService.pluginPresenceGate,
      sync: syncService
    ))
  }

  var body: some View {
    content
      // Re-resolves when plugin rows change (install, uninstall, a new panel)
      // and when the phone attaches to a different machine, which is the case
      // that actually changes the answer.
      .task(id: refreshKey) {
        await model.refresh()
      }
  }

  @ViewBuilder
  private var content: some View {
    if model.entries.count == 1, let entry = model.entries.first {
      Button {
        ADEHaptics.light()
        open(entry)
      } label: {
        label(for: entry)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(entry.label)
    } else if !model.entries.isEmpty {
      Menu {
        ForEach(model.entries) { entry in
          Button {
            open(entry)
          } label: {
            // Two-closure `Label` rather than `systemImage:`, because a plugin
            // that carries a real brand names a `brand:` token and that resolves
            // to a bundled logo, not to a symbol name. Ordinary tokens still end
            // up as `Image(systemName:)` — see `PluginSymbol.image(_:fallback:)`.
            Label {
              Text(entry.label)
            } icon: {
              PluginSymbol.image(entry.icon, fallback: "puzzlepiece.extension")
            }
          }
        }
      } label: {
        Image(systemName: "puzzlepiece.extension")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 38, height: 34)
          .contentShape(Rectangle())
      }
      .accessibilityLabel("Plugins")
    }
  }

  /// The single-plugin form of the slot: the plugin's own mark, not a puzzle
  /// piece, because with one plugin installed the button IS that plugin.
  ///
  /// `foregroundStyle` still applies to a symbol token and is inert on a brand
  /// asset, which is the intent — a vendor's logo is not the app's to tint.
  private func label(for entry: PluginEntry) -> some View {
    PluginSymbol.glyph(entry.icon, fallback: "puzzlepiece.extension", pointSize: 15)
      .foregroundStyle(ADEColor.textSecondary)
      .frame(width: 38, height: 34)
      .contentShape(Rectangle())
  }

  private func open(_ entry: PluginEntry) {
    syncService.presentedPluginPane = PluginPaneRequest(pluginId: entry.pluginId, title: entry.label)
  }

  /// Cheap identity for the refresh trigger: which machine, and how many times
  /// plugin rows have changed. Shared with every other gated surface via
  /// `SyncService.pluginPresenceTrigger` so they refresh on the same events.
  private var refreshKey: String {
    syncService.pluginPresenceTrigger
  }
}
