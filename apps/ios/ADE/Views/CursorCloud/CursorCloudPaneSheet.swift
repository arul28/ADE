import SwiftUI

/// The global Cursor Cloud pane: a full-screen sheet hosting a `NavigationStack`
/// with the grouped fleet list, mirroring the Linear pane's presentation.
struct CursorCloudPaneSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @StateObject private var store: CursorCloudPaneStore
  @State private var path: [CursorCloudRoute] = []

  init(syncService: SyncService) {
    _store = StateObject(wrappedValue: CursorCloudPaneStore(syncService: syncService))
  }

  var body: some View {
    NavigationStack(path: $path) {
      CursorCloudAgentListScreen(
        store: store,
        onClose: { dismiss() }
      )
      .navigationDestination(for: CursorCloudRoute.self) { route in
        switch route {
        case .agent(let entry):
          CursorCloudAgentDetailScreen(entry: entry)
        }
      }
    }
  }
}

/// Real-Cursor-mark button in the Work top bar next to the Linear one. The
/// fleet actions are optional remote commands, so the button hides on brains
/// that do not advertise them (the pane resolves connection state itself — a
/// missing key renders an honest connect prompt — but no advertisement means
/// every command would fail).
struct CursorCloudPaneToolbarButton: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    if syncService.activeProjectId != nil,
       syncService.supportsRemoteAction("ai.cursorCloudFleet") {
      Button {
        ADEHaptics.light()
        syncService.cursorCloudPanePresented = true
      } label: {
        CursorCloudMark(size: 16)
          .frame(width: 38, height: 34)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Cursor Cloud agents")
    }
  }
}

/// Minimal isometric-cursor mark in the feature violet. Drawn locally because
/// the desktop's lobehub avatar is not available to the iOS target.
struct CursorCloudMark: View {
  var size: CGFloat = 16

  var body: some View {
    CursorCubeShape()
      .fill(CursorCloudBrand.primaryBright)
      .frame(width: size, height: size)
  }
}

struct CursorCubeShape: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    let w = rect.width
    let h = rect.height
    let midX = w / 2
    // Top vertex → right vertex → bottom vertex → left vertex diamond.
    path.move(to: CGPoint(x: midX, y: 0))
    path.addLine(to: CGPoint(x: w * 0.96, y: h * 0.28))
    path.addLine(to: CGPoint(x: w * 0.62, y: h * 0.52))
    path.addLine(to: CGPoint(x: w * 0.96, y: h * 0.76))
    path.addLine(to: CGPoint(x: midX, y: h))
    path.addLine(to: CGPoint(x: w * 0.04, y: h * 0.76))
    path.addLine(to: CGPoint(x: w * 0.38, y: h * 0.52))
    path.addLine(to: CGPoint(x: w * 0.04, y: h * 0.28))
    path.closeSubpath()
    return path
  }
}
