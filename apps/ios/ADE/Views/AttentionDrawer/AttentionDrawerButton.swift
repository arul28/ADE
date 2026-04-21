import SwiftUI

/// Bell affordance rendered next to `ADEConnectionDot` on every root screen.
///
/// Tapping flips `SyncService.attentionDrawerPresented` to `true`, which
/// surfaces `AttentionDrawerSheet` (mounted once on the root `ContentView`).
///
/// Visual spec mirrors the existing `ADEConnectionDot` circle: 30pt tinted
/// disc + 1pt stroke + shadow. A red 16pt badge overlays the top-right
/// corner when `unreadCount > 0` (count-capped at `9+`).
@available(iOS 17.0, *)
struct AttentionDrawerButton: View {
    @EnvironmentObject private var syncService: SyncService
    @EnvironmentObject private var drawer: AttentionDrawerModel

    private var tint: Color {
        drawer.unreadCount > 0 ? ADESharedTheme.warningAmber : ADEColor.textSecondary
    }

    private var hasUnread: Bool { drawer.unreadCount > 0 }

    var body: some View {
        ZStack {
            Circle()
                .fill(tint.opacity(0.14))
                .frame(width: 30, height: 30)
                .overlay(
                    Circle()
                        .stroke(tint.opacity(0.55), lineWidth: 1)
                )
                .shadow(
                    color: tint.opacity(hasUnread ? 0.24 : 0.12),
                    radius: hasUnread ? 2 : 1
                )

            Image(systemName: "bell.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)

            if let label = drawer.badgeLabel {
                badge(label: label)
                    .offset(x: 11, y: -11)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .onTapGesture {
            syncService.attentionDrawerPresented = true
        }
        .animation(.snappy(duration: 0.2), value: drawer.unreadCount)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Attention items: \(drawer.unreadCount)")
        .accessibilityHint("Opens the attention drawer.")
        .accessibilityAction {
            syncService.attentionDrawerPresented = true
        }
        .accessibilityShowsLargeContentViewer()
    }

    private func badge(label: String) -> some View {
        Text(label)
            .font(.system(size: 9, weight: .bold, design: .rounded).monospacedDigit())
            .foregroundStyle(Color.white)
            .padding(.horizontal, label.count > 1 ? 4 : 0)
            .frame(minWidth: 16, minHeight: 16)
            .background(
                Capsule(style: .continuous)
                    .fill(ADESharedTheme.statusFailed)
            )
            .overlay(
                Capsule(style: .continuous)
                    .stroke(Color.black.opacity(0.55), lineWidth: 1)
            )
            .accessibilityHidden(true)
    }
}
