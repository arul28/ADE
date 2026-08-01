import SwiftUI
import UIKit

/// Bell affordance for the Activity drawer, mounted on every root's toolbar and
/// (since this pass) on the hub's top bar too.
///
/// Tapping flips `SyncService.attentionDrawerPresented` to `true`, which
/// surfaces `ActivityDrawerSheet` (mounted once on the root `ContentView`).
///
/// Visual spec is unchanged: liquid-glass disc with an amber tint + glow when
/// something needs the user, and a 16pt badge capped at `9+`. What changed is
/// what the number counts — needs-you rows only, never ambient work in flight.
struct ActivityBellButton: View {
    @EnvironmentObject private var syncService: SyncService
    @EnvironmentObject private var drawer: ActivityDrawerModel

    private var hasUnread: Bool { drawer.unreadCount > 0 }

    private var tint: Color {
        hasUnread ? ADESharedTheme.warningAmber : PrsGlass.textSecondary
    }

    var body: some View {
        Button(action: openDrawer) {
            Label {
                Text("Activity")
            } icon: {
                ZStack {
                    PrsGlassDisc(tint: tint, isAlive: hasUnread) {
                        Image(systemName: "bell.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(tint)
                    }

                    if let label = drawer.badgeLabel {
                        badge(label: label)
                            .offset(x: 12, y: -12)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
            }
            .labelStyle(.iconOnly)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
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

    private func badge(label: String) -> some View {
        Text(label)
            .font(.system(size: 9, weight: .bold, design: .rounded).monospacedDigit())
            .foregroundStyle(Color.white)
            .padding(.horizontal, label.count > 1 ? 4 : 0)
            .frame(minWidth: 16, minHeight: 16)
            .background(
                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [PrsGlass.closedTop, PrsGlass.closedBottom],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
            )
            .overlay(
                Capsule(style: .continuous)
                    .stroke(Color.white.opacity(0.45), lineWidth: 0.75)
            )
            .shadow(color: PrsGlass.closedBottom.opacity(0.55), radius: 6, x: 0, y: 2)
            .accessibilityHidden(true)
    }
}
