import SwiftUI
import UIKit

/// Bell affordance for the Activity drawer on the hub's top bar.
///
/// Tapping flips `SyncService.attentionDrawerPresented` to `true`, which
/// surfaces `ActivityDrawerSheet` (mounted once on the root `ContentView`).
///
/// Drawn exactly like its neighbours on the top bar (`ADEKitCircleIcon`: a
/// quiet circle with a neutral glyph). Colour is for meaning only, so the glyph
/// stays neutral and the one signal is a small flat count badge for needs-you
/// rows.
struct ActivityBellButton: View {
    @EnvironmentObject private var syncService: SyncService
    @EnvironmentObject private var drawer: ActivityDrawerModel

    private var hasUnread: Bool { drawer.unreadCount > 0 }

    var body: some View {
        Button(action: openDrawer) {
            ADEKitCircleIcon(systemImage: "bell", emphasized: hasUnread, badge: drawer.badgeLabel)
        }
        .buttonStyle(.plain)
        .animation(.snappy(duration: 0.2), value: drawer.unreadCount)
        .accessibilityLabel(
            hasUnread
                ? "Activity, \(drawer.unreadCount) \(drawer.unreadCount == 1 ? "item needs" : "items need") you"
                : "Activity"
        )
        .accessibilityHint("Opens the Activity drawer.")
        .accessibilityShowsLargeContentViewer()
    }

    private func openDrawer() {
        syncService.attentionDrawerPresented = true
    }
}
