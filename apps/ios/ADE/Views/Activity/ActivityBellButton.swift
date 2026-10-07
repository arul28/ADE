import SwiftUI
import UIKit

/// Bell affordance for the Activity drawer on the hub's top bar.
///
/// Tapping flips `SyncService.attentionDrawerPresented` to `true`, which
/// surfaces `ActivityDrawerSheet` (mounted once on the root `ContentView`).
///
/// Drawn exactly like its neighbours on the top bar (a quiet circle with a
/// neutral glyph). Colour is for meaning only, so the glyph stays neutral and
/// the one signal is a small flat count badge for needs-you rows.
struct ActivityBellButton: View {
    @EnvironmentObject private var syncService: SyncService
    @EnvironmentObject private var drawer: ActivityDrawerModel

    private var hasUnread: Bool { drawer.unreadCount > 0 }

    var body: some View {
        Button(action: openDrawer) {
            Image(systemName: "bell")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(hasUnread ? ADEColor.textPrimary : ADEColor.textSecondary)
                .frame(width: 38, height: 38)
                .background(ADEColor.cardBackground.opacity(0.72), in: Circle())
                .overlay(Circle().stroke(ADEColor.border.opacity(0.8), lineWidth: 1))
                .overlay(alignment: .topTrailing) {
                    if let label = drawer.badgeLabel {
                        Text(label)
                            .font(.system(size: 10, weight: .bold).monospacedDigit())
                            .foregroundStyle(ADEColor.pageBackground)
                            .padding(.horizontal, 4)
                            .frame(minWidth: 15, minHeight: 15)
                            .background(ADEColor.warning, in: Capsule())
                            .offset(x: 3, y: -3)
                            .transition(.scale.combined(with: .opacity))
                            .accessibilityHidden(true)
                    }
                }
                .contentShape(Circle())
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
