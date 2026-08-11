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
/// - **The attached machine** (`plugins.presenceList`) answers *availability*.
///   It has to: `plugin_presence` carries rows for every machine on the account,
///   and the phone can only open a pane for the one machine it is talking to.
/// - **The local mirror** (`plugin_panels`, `plugin_presence`) answers *what to
///   draw* — labels, icons, panel counts — with no round trip.
///
/// A host too old to know `plugins.presenceList` never advertises it, the call
/// is skipped, and the entry point simply is not there. That is the product
/// rule for a missing plugin: hide silently, never a broken button.
@MainActor
final class PluginEntryListModel: ObservableObject {
  @Published private(set) var entries: [PluginEntry] = []

  private let sync: PluginEntryListSyncing
  private var isRefreshing = false

  init(sync: PluginEntryListSyncing) {
    self.sync = sync
  }

  func refresh() async {
    guard !isRefreshing else { return }
    isRefreshing = true
    defer { isRefreshing = false }

    guard sync.supportsPluginPresenceList else {
      entries = []
      return
    }
    // A failed call clears the list rather than leaving stale entries: an entry
    // that opens a pane the machine can no longer serve is worse than no entry.
    guard let available = try? await sync.fetchAttachedMachinePlugins() else {
      entries = []
      return
    }

    let catalog = sync.pluginPresenceCatalog()
    let panelCounts = Dictionary(grouping: sync.pluginPanels(pluginId: nil), by: \.pluginId)
      .mapValues(\.count)

    entries = available.plugins
      .filter { $0.enabled && !$0.pluginId.isEmpty }
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

@MainActor
protocol PluginEntryListSyncing: AnyObject {
  var supportsPluginPresenceList: Bool { get }
  func fetchAttachedMachinePlugins() async throws -> PluginPresenceListResult
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
    _model = StateObject(wrappedValue: PluginEntryListModel(sync: syncService))
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
            Label(entry.label, systemImage: PluginSymbol.resolve(entry.icon, fallback: "puzzlepiece.extension"))
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

  private func label(for entry: PluginEntry) -> some View {
    Image(systemName: PluginSymbol.resolve(entry.icon, fallback: "puzzlepiece.extension"))
      .font(.system(size: 15, weight: .semibold))
      .foregroundStyle(ADEColor.textSecondary)
      .frame(width: 38, height: 34)
      .contentShape(Rectangle())
  }

  private func open(_ entry: PluginEntry) {
    syncService.presentedPluginPane = PluginPaneRequest(pluginId: entry.pluginId, title: entry.label)
  }

  /// Cheap identity for the refresh trigger: which machine, and how many times
  /// plugin rows have changed.
  private var refreshKey: String {
    "\(syncService.activeProjectHostIdentity ?? "-")|\(syncService.pluginsProjectionRevision)"
  }
}
