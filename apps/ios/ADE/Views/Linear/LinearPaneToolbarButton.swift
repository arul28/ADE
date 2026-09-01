import SwiftUI

/// The real-Linear-logo button in the Work top bar, immediately left of the
/// bell. Shown when a project is open — it lives in the Work tab, which only
/// renders for an active project. Tapping opens ADE's compiled Linear pane,
/// which resolves *connection* state itself (issues when connected, a "connect
/// Linear on your machine" prompt otherwise), so the button pre-checks nothing
/// about the account.
///
/// It hides once the attached machine has `ade-linear` installed and enabled:
/// that plugin ships its own Linear panels, reached through the puzzle-piece
/// entry menu, and two Linear entry points side by side in a 38pt toolbar slot
/// is the confusion this gate exists to prevent. The check is repeated here
/// rather than left to the caller because a hidden button is not access control
/// — the same rule the comments in `PluginPresenceGate.swift` state, and the
/// reason the sheet host in `ContentView` checks a third time.
///
/// Note the polarity: this is `drawsBuiltin`, not `owns`. See `PluginPresenceGate.swift`.
///
/// The plugin check is not a connection check and the two must not be confused.
/// The `ade linear` CLI keeps using the account connection headlessly whichever
/// way this gate falls. Connecting Linear moves with the browsing surface
/// though: with the plugin installed, `ade-linear` declares
/// `credentialHandoff: ["linear"]` and draws its own connection panel, so ADE's
/// compiled connect card in CTO settings hides alongside this button.
struct LinearPaneToolbarButton: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var pluginGate: PluginPresenceGate

  var body: some View {
    if syncService.activeProjectId != nil, pluginGate.drawsBuiltin(.linear) {
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
