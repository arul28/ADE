import SwiftUI

struct SettingsAppearanceSection: View {
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  private var choice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      SettingsSectionHeader(
        label: "APPEARANCE",
        hint: "Matches iOS by default"
      )

      GlassEffectContainer(spacing: 8) {
        HStack(spacing: 8) {
          ForEach(ADEColorSchemeChoice.allCases) { option in
            SettingsThemeTile(
              option: option,
              isSelected: choice == option,
              onTap: { colorSchemeRaw = option.rawValue }
            )
          }
        }
      }
    }
  }
}

private struct SettingsThemeTile: View {
  let option: ADEColorSchemeChoice
  let isSelected: Bool
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      VStack(spacing: 10) {
        Image(systemName: option.symbol)
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(isSelected ? ADEColor.purpleAccent : ADEColor.textSecondary)
          .frame(height: 28)
        Text(option.label)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 16)
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(ADEColor.surfaceBackground.opacity(0.5))
      )
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(
            isSelected ? ADEColor.purpleAccent.opacity(0.6) : ADEColor.border.opacity(0.18),
            lineWidth: isSelected ? 1.4 : 0.75
          )
      )
      .shadow(color: isSelected ? ADEColor.purpleAccent.opacity(0.18) : .clear, radius: 10, y: 2)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(option.label) appearance")
    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
  }
}
