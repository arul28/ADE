import SwiftUI

/// Settings > Appearance: three mode cards with a small live preview, like the
/// desktop Appearance page. Appearance is per device and never syncs.
struct SettingsAppearanceSection: View {
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  private var choice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    ADESettingsSection("Mode", hint: "System follows iOS.") {
      HStack(spacing: 10) {
        ForEach(ADEColorSchemeChoice.allCases) { option in
          SettingsThemeChoice(
            option: option,
            isSelected: choice == option,
            onTap: { colorSchemeRaw = option.rawValue }
          )
        }
      }
    }
  }
}

/// One mode card: a miniature page in that mode, then its name.
private struct SettingsThemeChoice: View {
  let option: ADEColorSchemeChoice
  let isSelected: Bool
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      VStack(spacing: 8) {
        preview
          .frame(height: 64)
          .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ADEKit.edge, lineWidth: 0.75))
        HStack(spacing: 5) {
          Image(systemName: option.symbol)
            .font(.system(size: 11, weight: .medium))
          Text(option.label)
            .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
        }
        .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
      }
      .padding(8)
      .frame(maxWidth: .infinity)
      .background(ADEKit.surface, in: RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous)
          .strokeBorder(isSelected ? ADEColor.accent : ADEKit.edge, lineWidth: isSelected ? 1.5 : 0.75)
      )
      .contentShape(RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(option.label) appearance")
    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
  }

  @ViewBuilder
  private var preview: some View {
    switch option {
    case .light: SettingsThemeMiniPage(dark: false)
    case .dark: SettingsThemeMiniPage(dark: true)
    case .system:
      HStack(spacing: 0) {
        SettingsThemeMiniPage(dark: false)
        SettingsThemeMiniPage(dark: true)
      }
    }
  }
}

/// A fixed-colour sketch of a page: background, a card, two text lines.
private struct SettingsThemeMiniPage: View {
  let dark: Bool

  var body: some View {
    let page = dark ? Color(red: 0.05, green: 0.04, blue: 0.06) : Color(red: 0.96, green: 0.95, blue: 0.94)
    let card = dark ? Color(red: 0.10, green: 0.09, blue: 0.19) : Color.white
    let ink = dark ? Color.white.opacity(0.55) : Color.black.opacity(0.35)
    ZStack(alignment: .topLeading) {
      page
      VStack(alignment: .leading, spacing: 5) {
        Capsule().fill(ink).frame(width: 26, height: 4)
        RoundedRectangle(cornerRadius: 4, style: .continuous)
          .fill(card)
          .overlay(alignment: .topLeading) {
            VStack(alignment: .leading, spacing: 4) {
              Capsule().fill(ink.opacity(0.8)).frame(width: 30, height: 3)
              Capsule().fill(ink.opacity(0.5)).frame(width: 20, height: 3)
            }
            .padding(6)
          }
      }
      .padding(8)
    }
    .frame(maxWidth: .infinity)
  }
}
