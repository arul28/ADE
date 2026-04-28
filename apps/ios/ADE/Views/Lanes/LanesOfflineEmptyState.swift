import SwiftUI

struct LanesOfflineEmptyState: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    VStack(spacing: 20) {
      Spacer()

      Image(systemName: "square.stack.3d.up")
        .font(.system(size: 64, weight: .light))
        .foregroundStyle(ADEColor.accent.opacity(0.55))
        .frame(width: 96, height: 96)
        .background(ADEColor.accent.opacity(0.08), in: Circle())
        .glassEffect(in: .circle)

      VStack(spacing: 8) {
        Text("Not connected")
          .font(.title3.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Connect to a host to see your lanes")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
      }

      Button {
        syncService.settingsPresented = true
      } label: {
        Text("Connect to host")
          .font(.subheadline.weight(.semibold))
          .padding(.horizontal, 18)
          .padding(.vertical, 10)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)

      Spacer()
      Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(.horizontal, 32)
    .adeScreenBackground()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Not connected. Tap Connect to host to open settings.")
  }
}
