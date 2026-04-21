import SwiftUI

/// Single-row settings entry that opens the full Notifications Center.
///
/// Mirrors the visual style of `SettingsPairActionRow` but renders inside a
/// `NavigationLink` so the parent settings screen can push
/// `NotificationsCenterView` onto its existing `NavigationStack`.
struct SettingsNotificationsSection: View {
  var onPreferencesChanged: (NotificationPreferences) -> Void
  var onSendTestPush: () -> Void

  @State private var prefs = NotificationPreferences()

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      SettingsSectionHeader(
        label: "NOTIFICATIONS",
        hint: "Alerts from chat, CTO, PRs, and system"
      )

      NavigationLink {
        NotificationsCenterView(
          initialPreferences: prefs,
          onPreferencesChanged: { updated in
            prefs = updated
            onPreferencesChanged(updated)
          },
          onSendTestPush: onSendTestPush
        )
      } label: {
        rowContent
      }
      .buttonStyle(ADEScaleButtonStyle())
      .accessibilityLabel(accessibilityLabel)
      .accessibilityHint("Open the Notifications Center to configure alerts")
    }
    .task {
      await refreshPreferencesAfterFirstPaint()
    }
  }

  private func refreshPreferencesAfterFirstPaint() async {
    await Task.yield()
    let loaded = NotificationPreferences.load(from: ADESharedContainer.defaults)
    guard loaded != prefs else { return }
    prefs = loaded
  }

  private var rowContent: some View {
    HStack(spacing: 14) {
      Image(systemName: "bell.badge")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(ADEColor.purpleAccent)
        .frame(width: 38, height: 38)
        .background(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(
              LinearGradient(
                colors: [
                  ADEColor.purpleAccent.opacity(0.30),
                  ADEColor.purpleAccent.opacity(0.10),
                ],
                startPoint: .top,
                endPoint: .bottom
              )
            )
        )
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(ADEColor.purpleAccent.opacity(0.35), lineWidth: 0.6)
        )

      VStack(alignment: .leading, spacing: 2) {
        Text("Notifications")
          .font(.body.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
        Text(subtitle)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }

      Spacer(minLength: 8)

      Image(systemName: "chevron.right")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.purpleAccent.opacity(0.55))
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(
          LinearGradient(
            colors: [
              ADEColor.purpleAccent.opacity(0.06),
              Color.clear,
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
    )
    .glassEffect(in: .rect(cornerRadius: 16))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .strokeBorder(
          LinearGradient(
            colors: [
              ADEColor.purpleAccent.opacity(0.32),
              ADEColor.border.opacity(0.10),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          ),
          lineWidth: 0.75
        )
    )
  }

  private var subtitle: String {
    let enabled = prefs.enabledCategoryCount
    let total = NotificationPreferences.totalCategoryCount
    return "\(enabled) of \(total) categories enabled"
  }

  private var accessibilityLabel: String {
    "Notifications. \(subtitle)."
  }
}
