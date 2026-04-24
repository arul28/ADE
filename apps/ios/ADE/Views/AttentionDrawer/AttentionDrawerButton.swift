import SwiftUI
import UIKit

/// Bell affordance rendered next to the root toolbar connection and project controls.
///
/// Tapping flips `SyncService.attentionDrawerPresented` to `true`, which
/// surfaces `AttentionDrawerSheet` (mounted once on the root `ContentView`).
///
/// Visual spec: liquid-glass disc with an amber tint + glow when there are
/// unread attention items; a red 16pt badge overlays the top-right corner
/// when `unreadCount > 0` (count-capped at `9+`).
@available(iOS 17.0, *)
struct AttentionDrawerButton: View {
    @EnvironmentObject private var syncService: SyncService
    @EnvironmentObject private var drawer: AttentionDrawerModel

    private var hasUnread: Bool { drawer.unreadCount > 0 }

    private var tint: Color {
        hasUnread ? ADESharedTheme.warningAmber : PrsGlass.textSecondary
    }

    var body: some View {
        Button(action: openDrawer) {
            Label {
                Text("Attention")
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
        .accessibilityLabel("Attention items: \(drawer.unreadCount)")
        .accessibilityHint("Opens the attention drawer.")
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
