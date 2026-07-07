import SwiftUI

/// The real-Linear-logo button in the Work top bar, immediately left of the
/// bell. Shown whenever a project is open — it lives in the Work tab, which only
/// renders for an active project. Tapping opens the global Linear pane, which
/// resolves connection state itself (issues when connected, a "connect Linear on
/// your machine" prompt otherwise), so the button needs no pre-check.
struct LinearPaneToolbarButton: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    if syncService.activeProjectId != nil {
      Button {
        ADEHaptics.light()
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
