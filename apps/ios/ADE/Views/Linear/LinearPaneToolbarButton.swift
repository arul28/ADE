import SwiftUI

/// The real-Linear-logo button in the Work top bar, immediately left of the
/// bell. Shown when a project is open — it lives in the Work tab, which only
/// renders for an active project — AND the attached machine has the Linear
/// plugin installed and enabled. Tapping opens the global Linear pane, which
/// resolves *connection* state itself (issues when connected, a "connect Linear
/// on your machine" prompt otherwise), so the button pre-checks nothing about
/// the account.
///
/// The plugin check is not a connection check and the two must not be confused:
/// the `ade linear` CLI keeps using the account connection headlessly with the
/// plugin uninstalled, so connecting Linear stays available in Settings while
/// this browsing surface disappears.
struct LinearPaneToolbarButton: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var pluginGate: PluginPresenceGate

  var body: some View {
    if syncService.activeProjectId != nil, pluginGate.owns(.linear) {
      Button {
        ADEHaptics.light()
        syncService.linearPaneAttachSessionId = nil
        syncService.linearPanePresented = true
      } label: {
        LinearMark(size: 16)
          .foregroundStyle(LinearBrand.primaryBright)
          .frame(width: 38, height: 34)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Linear issues")
    }
  }
}
