import SwiftUI

struct SettingsAnalyticsSection: View {
  @AppStorage(ProductAnalytics.enabledDefaultsKey) private var analyticsEnabled = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      SettingsSectionHeader(
        label: "PRODUCT ANALYTICS",
        hint: "Bounded, content-free usage events"
      )

      VStack(alignment: .leading, spacing: 10) {
        Toggle(isOn: $analyticsEnabled) {
          Label {
            VStack(alignment: .leading, spacing: 3) {
              Text("Share product usage")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              Text("Helps improve ADE's screens and native features")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          } icon: {
            Image(systemName: "chart.bar.xaxis")
              .foregroundStyle(ADEColor.purpleAccent)
          }
        }
        .tint(ADEColor.purpleAccent)

        Text("ADE uses a random anonymous analytics ID. Host-recorded mobile usage may also include installation-salted opaque project/session IDs. ADE never sends raw IDs, project or file names or paths, prompts, transcripts, terminal content, or screen recordings. Usage events are capped on this device each day.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary.opacity(0.82))
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(ADEColor.surfaceBackground.opacity(0.06))
      )
      .glassEffect(in: .rect(cornerRadius: 14))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.6)
      )
    }
    .onChange(of: analyticsEnabled) { _, enabled in
      ProductAnalytics.shared.setEnabled(enabled)
    }
  }
}
