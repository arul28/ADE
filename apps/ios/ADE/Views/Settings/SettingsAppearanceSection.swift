import SwiftUI

/// Settings > Appearance: the three modes side by side, each a small phone
/// showing ADE in that mode, with a check under the one in use, as iOS's own
/// Display settings lay it out. Appearance is per device and never syncs.
struct SettingsAppearanceSection: View {
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  private var choice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    ADESettingsSection("Mode", hint: "System follows iOS, light by day and dark by night.") {
      HStack(alignment: .top, spacing: 12) {
        ForEach(ADEColorSchemeChoice.allCases) { option in
          SettingsThemeChoice(
            option: option,
            isSelected: choice == option,
            onTap: {
              withAnimation(.snappy(duration: 0.2)) { colorSchemeRaw = option.rawValue }
            }
          )
        }
      }
      .padding(.horizontal, 14)
      .padding(.top, 18)
      .padding(.bottom, 14)
      .adeKitCard(padding: nil)
    }
  }
}

/// One mode: a small phone showing ADE in it, its name, and a check.
private struct SettingsThemeChoice: View {
  let option: ADEColorSchemeChoice
  let isSelected: Bool
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      VStack(spacing: 10) {
        SettingsThemePhone(option: option)
          .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
              .strokeBorder(isSelected ? ADEColor.accent : ADEKit.edge, lineWidth: isSelected ? 2.5 : 0.75)
              .padding(isSelected ? -4 : 0)
          )
        Text(option.label)
          .font(.system(size: 14, weight: isSelected ? .semibold : .regular))
          .foregroundStyle(ADEColor.textPrimary)
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
          .font(.system(size: 21, weight: .regular))
          .foregroundStyle(isSelected ? ADEColor.accent : ADEColor.textMuted.opacity(0.7))
          .contentTransition(.symbolEffect(.replace))
      }
      .frame(maxWidth: .infinity)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(option.label) appearance")
    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
  }
}

/// A small phone in one mode; System is split down the middle, light and dark.
private struct SettingsThemePhone: View {
  let option: ADEColorSchemeChoice

  var body: some View {
    Group {
      switch option {
      case .light: SettingsThemeMiniPage(dark: false)
      case .dark: SettingsThemeMiniPage(dark: true)
      case .system:
        SettingsThemeMiniPage(dark: false)
          .overlay {
            SettingsThemeMiniPage(dark: true)
              .mask(alignment: .trailing) {
                GeometryReader { proxy in
                  Rectangle().frame(width: proxy.size.width / 2).frame(maxWidth: .infinity, alignment: .trailing)
                }
              }
          }
      }
    }
    .aspectRatio(0.56, contentMode: .fit)
    .frame(maxWidth: 96)
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .accessibilityHidden(true)
  }
}

/// A fixed-colour sketch of ADE's Hub: the app mark and a status chip, two
/// chat cards with the accent, and the prompt box at the bottom.
private struct SettingsThemeMiniPage: View {
  let dark: Bool

  var body: some View {
    let page = dark ? Color(red: 0.05, green: 0.04, blue: 0.07) : Color(red: 0.96, green: 0.95, blue: 0.97)
    let card = dark ? Color(red: 0.11, green: 0.10, blue: 0.20) : Color.white
    let ink = dark ? Color.white.opacity(0.55) : Color.black.opacity(0.28)
    let faint = dark ? Color.white.opacity(0.22) : Color.black.opacity(0.12)
    let accent = Color(red: 0.65, green: 0.55, blue: 0.98)
    ZStack {
      page
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 4) {
          // The app's mark, as its icon draws it: the wordmark on deep violet.
          Image("BrandMark")
            .resizable()
            .scaledToFit()
            .padding(2.5)
            .frame(width: 18, height: 18)
            .background(
              LinearGradient(colors: [Color(red: 0.30, green: 0.18, blue: 0.55), Color(red: 0.10, green: 0.06, blue: 0.20)], startPoint: .top, endPoint: .bottom),
              in: RoundedRectangle(cornerRadius: 5, style: .continuous)
            )
          Spacer(minLength: 0)
          Capsule().fill(faint).frame(width: 18, height: 7)
          Circle().fill(Color(red: 0.20, green: 0.78, blue: 0.48)).frame(width: 5, height: 5)
        }
        miniCard(card: card, ink: ink, faint: faint, tag: accent)
        miniCard(card: card, ink: ink, faint: faint, tag: Color(red: 0.85, green: 0.47, blue: 0.34))
        Spacer(minLength: 0)
        Capsule()
          .fill(card)
          .frame(height: 12)
          .overlay(alignment: .trailing) {
            Circle().fill(accent).frame(width: 7, height: 7).padding(.trailing, 3)
          }
      }
      .padding(7)
    }
  }

  private func miniCard(card: Color, ink: Color, faint: Color, tag: Color) -> some View {
    HStack(spacing: 5) {
      RoundedRectangle(cornerRadius: 3, style: .continuous).fill(tag).frame(width: 10, height: 10)
      VStack(alignment: .leading, spacing: 3) {
        Capsule().fill(ink).frame(width: 28, height: 3)
        Capsule().fill(faint).frame(width: 18, height: 3)
      }
      Spacer(minLength: 0)
    }
    .padding(5)
    .background(card, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
  }
}
