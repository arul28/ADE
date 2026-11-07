import SwiftUI

// The settings pieces of ADEKit: the page, sections, rows and links every
// Settings page is built from, after the desktop's `SettingsModern.tsx` and
// `SettingsRows.tsx`, so the phone's pages read like the desktop's.

// MARK: - Settings page (desktop ModernPage / ModernSection / ModernRows / ModernRow)

/// One calm scrolling column of sections on the page background, under the
/// page's large title and its one-line description, as the desktop's settings
/// pages open ("Chat" / "How the chat transcript reads…").
struct ADESettingsPage<Content: View>: View {
  let title: String
  var subtitle: String?
  @ViewBuilder var content: () -> Content

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: ADEKit.sectionGap) {
        if let subtitle, !subtitle.isEmpty {
          ADESettingsPageIntro(text: subtitle)
        }
        content()
      }
      .padding(.horizontal, 16)
      .padding(.top, subtitle == nil ? 12 : 0)
      .padding(.bottom, 36)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .adeSettingsPageTitle(title)
  }
}

/// The page's one-line description, in the page under its large title. Not
/// the bar's subtitle: the bar cut it to "…" once the title collapsed.
struct ADESettingsPageIntro: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.system(size: 15))
      .foregroundStyle(ADEColor.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      // Sits under the title, so closer to it than to the first section.
      .padding(.bottom, -6)
  }
}

extension ADESettingsPage {
  /// One of Settings' pages, under its sidebar title and description.
  init(route: SettingsRoute, @ViewBuilder content: @escaping () -> Content) {
    self.init(title: route.title, subtitle: route.subtitle, content: content)
  }
}

extension View {
  /// The settings page title bar: the large title, the glass bar, and Close
  /// where the stack has one. For a page that draws its own scroll view
  /// instead of `ADESettingsPage`, with `ADESettingsPageIntro` first in it.
  func adeSettingsPageTitle(_ title: String) -> some View {
    adeNavigationGlass()
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.large)
      .settingsPageClose()
  }
}

/// The desktop settings tones (`SETTINGS_TONES` in `SettingsRows.tsx`): one
/// hue per kind of thing, mixed down to a soft tile behind its glyph, so a long
/// page scans by shape and colour the same way on both.
enum ADESettingsTint: Equatable {
  case accent, blue, green, amber, red, violet, pink, teal, orange, slate

  var color: Color {
    switch self {
    case .accent: return ADEColor.accent
    case .blue: return Color(red: 0x5B / 255, green: 0x8C / 255, blue: 1)
    case .green: return Color(red: 0x34 / 255, green: 0xC7 / 255, blue: 0x7B / 255)
    case .amber: return Color(red: 0xF5 / 255, green: 0xA5 / 255, blue: 0x24 / 255)
    case .red: return Color(red: 0xF0 / 255, green: 0x61 / 255, blue: 0x6D / 255)
    case .violet: return Color(red: 0xA7 / 255, green: 0x8B / 255, blue: 0xFA / 255)
    case .pink: return Color(red: 0xEC / 255, green: 0x6F / 255, blue: 0xB0 / 255)
    case .teal: return Color(red: 0x2B / 255, green: 0xC2 / 255, blue: 0xB2 / 255)
    case .orange: return Color(red: 0xF2 / 255, green: 0x84 / 255, blue: 0x4B / 255)
    case .slate: return Color(red: 0x8C / 255, green: 0x93 / 255, blue: 0xA8 / 255)
    }
  }
}

/// A glyph on a tile of its tone. Soft (desktop `SettingsRowIcon`): 15% of
/// the tone behind it, a 22% edge. Solid: a white glyph on the tone's
/// gradient, as a settings list's rows carry them, so each page is found by
/// colour and shape before its name.
struct ADESettingsIconTile: View {
  let symbol: String
  var tint: ADESettingsTint = .accent
  var size: CGFloat = 30
  var solid = false

  var body: some View {
    if solid {
      let shape = RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
      Image(systemName: symbol)
        .symbolVariant(.fill)
        .font(.system(size: size * 0.5, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: size, height: size)
        .background(
          LinearGradient(colors: [tint.color, tint.color.mix(with: .black, by: 0.22)], startPoint: .top, endPoint: .bottom),
          in: shape
        )
        .overlay(shape.strokeBorder(Color.white.opacity(0.14), lineWidth: 0.75))
        .accessibilityHidden(true)
    } else {
      let shape = RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
      Image(systemName: symbol)
        .font(.system(size: size * 0.5, weight: .medium))
        .foregroundStyle(tint.color)
        .frame(width: size, height: size)
        .background(tint.color.opacity(0.15), in: shape)
        .overlay(shape.strokeBorder(tint.color.opacity(0.22), lineWidth: 1))
        .accessibilityHidden(true)
    }
  }
}

/// A section: title, at most one hint line, an optional trailing control, then
/// its content (usually `ADESettingsRows`).
struct ADESettingsSection<Content: View, Trailing: View>: View {
  var title: String?
  var hint: String?
  /// A tinted tile before the heading (desktop `ModernSection` `icon`).
  var symbol: String?
  var tint: ADESettingsTint = .accent
  @ViewBuilder var trailing: () -> Trailing
  @ViewBuilder var content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if title != nil || hint != nil {
        ADESettingsHeader(title: title, hint: hint, symbol: symbol, tint: tint, trailing: trailing)
      }
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

extension ADESettingsSection where Trailing == EmptyView {
  init(_ title: String? = nil, hint: String? = nil, symbol: String? = nil, tint: ADESettingsTint = .accent, @ViewBuilder content: @escaping () -> Content) {
    self.init(title: title, hint: hint, symbol: symbol, tint: tint, trailing: { EmptyView() }, content: content)
  }
}

extension ADESettingsSection {
  init(_ title: String?, hint: String? = nil, symbol: String? = nil, tint: ADESettingsTint = .accent, @ViewBuilder trailing: @escaping () -> Trailing, @ViewBuilder content: @escaping () -> Content) {
    self.init(title: title, hint: hint, symbol: symbol, tint: tint, trailing: trailing, content: content)
  }
}

/// Groups rows in one panel with hairline dividers between them. Each direct
/// child (including each `ForEach` element) is one row.
struct ADESettingsRows<Content: View>: View {
  @ViewBuilder var content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Group(subviews: content()) { subviews in
        ForEach(Array(subviews.enumerated()), id: \.element.id) { index, subview in
          if index > 0 { ADESettingsHairline() }
          subview
        }
      }
    }
    .adeKitCard(padding: nil)
  }
}

/// The rule between two rows of one card, inset to the rows' text.
struct ADESettingsHairline: View {
  var body: some View {
    Rectangle()
      .fill(ADEKit.rule)
      .frame(height: 0.75)
      .padding(.leading, ADEKit.inset)
  }
}

/// One settings row: optional icon, title, optional hint, then the control.
struct ADESettingsRow<Control: View>: View {
  let title: String
  var hint: String?
  var symbol: String?
  var titleColor: Color = ADEColor.textPrimary
  /// The tone of the symbol's tile (desktop `ModernRow` `tone`).
  var tint: ADESettingsTint = .slate
  /// The control gets its full width before the text, so a long hint cannot
  /// squeeze a menu's label to "…". Off for a long value, which should give
  /// way to the title instead.
  var sizesControlFirst = true
  @ViewBuilder var control: () -> Control

  var body: some View {
    HStack(spacing: 12) {
      if let symbol {
        ADESettingsIconTile(symbol: symbol, tint: tint, size: 28)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 15))
          .foregroundStyle(titleColor)
          .lineLimit(2)
        if let hint, !hint.isEmpty {
          Text(hint)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      // The text takes the row's room before the spacer does; otherwise a
      // hint wrapped at half the row with empty space beside it.
      .layoutPriority(1)
      Spacer(minLength: 8)
      control()
        .layoutPriority(sizesControlFirst ? 2 : 0)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
  }
}

extension ADESettingsRow where Control == EmptyView {
  init(_ title: String, hint: String? = nil, symbol: String? = nil, titleColor: Color = ADEColor.textPrimary, tint: ADESettingsTint = .slate) {
    self.init(title: title, hint: hint, symbol: symbol, titleColor: titleColor, tint: tint, control: { EmptyView() })
  }
}

/// A read-only fact: label on the left, value on the right (mono for ids).
struct ADESettingsValueRow: View {
  let title: String
  let value: String
  var symbol: String?
  var mono = false
  var tone: ADEKitTone?
  var tint: ADESettingsTint = .slate

  var body: some View {
    ADESettingsRow(title: title, symbol: symbol, tint: tint, sizesControlFirst: false) {
      Text(value)
        .font(mono ? .adeMono(12) : .system(size: 14))
        .foregroundStyle(tone?.color ?? ADEColor.textSecondary)
        .lineLimit(2)
        .multilineTextAlignment(.trailing)
        .truncationMode(.middle)
    }
    .accessibilityElement(children: .combine)
  }
}

/// A row with a switch. The whole row reads as the switch to VoiceOver.
struct ADESettingsToggleRow: View {
  let title: String
  var hint: String?
  @Binding var isOn: Bool
  var tint: Color = ADEColor.accent
  var disabled = false

  var body: some View {
    ADESettingsRow(title: title, hint: hint) {
      Toggle("", isOn: $isOn)
        .labelsHidden()
        .tint(tint)
        .disabled(disabled)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(title)
  }
}

/// The row a section shows while its values load.
struct ADESettingsLoadingRow: View {
  var title = "Loading…"

  var body: some View {
    ADESettingsRow(title: title) { ProgressView() }
  }
}

/// A menu's current choice, then the up-down chevrons that say it opens.
struct ADESettingsMenuLabel: View {
  let text: String

  var body: some View {
    HStack(spacing: 5) {
      Text(text)
        .font(.system(size: 14))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
      Image(systemName: "chevron.up.chevron.down")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .contentShape(Rectangle())
  }
}

/// Opens a Settings page: pushes it, or on the Duo's list column shows it in
/// the page column beside the list (`duoSettingsShow`), which builds the page
/// for `title` itself so it stays live. There the row whose page is showing
/// draws the selection, as Apple Settings' sidebar does.
struct ADESettingsPageLink<Destination: View, Label: View>: View {
  let title: String
  var shape: ADEKitRowButtonStyle.Shape = .row
  @ViewBuilder var destination: () -> Destination
  /// The row, given whether it is the picked one and whether it pushes (and
  /// so carries a chevron).
  @ViewBuilder var label: (_ selected: Bool, _ pushes: Bool) -> Label
  @Environment(\.duoSettingsSelection) private var splitSelection
  @Environment(\.duoSettingsShow) private var splitShow

  var body: some View {
    Group {
      if let splitShow {
        Button { splitShow(title) } label: { label(isSelected, false) }
      } else {
        NavigationLink { destination() } label: { label(isSelected, true) }
      }
    }
    .buttonStyle(ADEKitRowButtonStyle(shape: shape))
    .background {
      if isSelected {
        switch shape {
        case .sidebar: RoundedRectangle(cornerRadius: 9, style: .continuous).fill(ADEColor.accent.opacity(0.16))
        case .row: ADEColor.accent.opacity(0.14)
        }
      }
    }
    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
  }

  private var isSelected: Bool { splitSelection?.wrappedValue == title }
}

/// A row that pushes a page: icon, title, optional value, chevron.
struct ADESettingsLink<Destination: View>: View {
  let title: String
  var hint: String?
  var symbol: String?
  var value: String?
  var tint: ADESettingsTint = .slate
  @ViewBuilder var destination: () -> Destination

  var body: some View {
    ADESettingsPageLink(title: title, destination: destination) { _, _ in
      ADESettingsRow(title: title, hint: hint, symbol: symbol, tint: tint) {
        HStack(spacing: 6) {
          if let value {
            Text(value)
              .font(.system(size: 14))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
          ADESettingsChevron()
        }
      }
    }
  }
}

/// A row of the settings sidebar that opens its page: flat on the page, an
/// outline glyph, the picked row on a rounded accent plane.
struct ADESettingsSidebarLink<Destination: View>: View {
  let title: String
  var symbol: String?
  var tint: ADESettingsTint?
  var value: String?
  @ViewBuilder var destination: () -> Destination

  var body: some View {
    ADESettingsPageLink(title: title, shape: .sidebar, destination: destination) { selected, pushes in
      ADESettingsSidebarRow(title: title, symbol: symbol, tint: tint, value: value, selected: selected, showsChevron: pushes)
    }
  }
}

/// One row of the settings sidebar (desktop `SettingsSidebar`): outline glyph,
/// title, an optional quiet value. The picked row turns the accent colour.
struct ADESettingsSidebarRow: View {
  let title: String
  var symbol: String?
  /// Draws the symbol on a solid tile of this colour instead of as an outline.
  var tint: ADESettingsTint?
  var value: String?
  var selected = false
  /// A one-column stack pushes, so the row says so; the two-column window
  /// shows the page beside it instead.
  var showsChevron = true

  var body: some View {
    HStack(spacing: 12) {
      if let symbol, let tint {
        ADESettingsIconTile(symbol: symbol, tint: tint, solid: true)
      } else if let symbol {
        Image(systemName: symbol)
          .font(.system(size: 16, weight: .regular))
          .foregroundStyle(selected ? ADEColor.accent : ADEColor.textSecondary)
          .frame(width: 24)
      }
      Text(title)
        .font(.system(size: 16, weight: selected ? .semibold : .regular))
        .foregroundStyle(selected ? ADEColor.accent : ADEColor.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 8)
      if let value {
        Text(value)
          .font(.system(size: 13.5))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      if showsChevron {
        ADESettingsChevron()
      }
    }
    .padding(.horizontal, 12)
    .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
    .contentShape(Rectangle())
  }
}

/// A heading over a run of sidebar rows ("You", "App", "Project: ADE").
struct ADESettingsSidebarGroupLabel: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.system(size: 13, weight: .medium))
      .foregroundStyle(ADEColor.textMuted)
      .lineLimit(1)
      .padding(.horizontal, 12)
      .padding(.top, 14)
      .padding(.bottom, 2)
      .accessibilityAddTraits(.isHeader)
  }
}

/// The trailing chevron of a row that opens something.
struct ADESettingsChevron: View {
  var body: some View {
    Image(systemName: "chevron.right")
      .font(.system(size: 12, weight: .semibold))
      .foregroundStyle(ADEColor.textMuted.opacity(0.7))
      .accessibilityHidden(true)
  }
}

/// A tappable row that runs an action: accent text, or red for a destructive one.
struct ADESettingsActionRow: View {
  let title: String
  var symbol: String?
  var destructive = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        if let symbol {
          Image(systemName: symbol)
            .font(.system(size: 14, weight: .medium))
            .frame(width: 22)
        }
        Text(title).font(.system(size: 15))
        Spacer(minLength: 0)
      }
      .foregroundStyle(destructive ? ADEColor.danger : ADEColor.accent)
      .padding(.horizontal, ADEKit.inset)
      .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
    }
    .buttonStyle(ADEKitRowButtonStyle())
    .disabled(disabled)
  }
}

/// A one-line notice inside a section: a tone icon and a short message.
struct ADESettingsNotice: View {
  let message: String
  var tone: ADEKitTone = .warn
  var actionTitle: String?
  var action: (() -> Void)?
  /// An × that puts the notice away.
  var dismiss: (() -> Void)?

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: Self.symbol(for: tone))
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(tone.color)
      VStack(alignment: .leading, spacing: 6) {
        Text(message)
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        if let actionTitle, let action {
          Button(actionTitle, action: action)
            .buttonStyle(ADEKitButtonStyle())
        }
      }
      Spacer(minLength: 0)
      if let dismiss {
        Button(action: dismiss) {
          Image(systemName: "xmark")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 28, height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss")
      }
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(tone.color.opacity(0.07), in: RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous))
    .accessibilityElement(children: .combine)
  }

  /// A neutral notice is information, not a warning, so it gets no triangle.
  private static func symbol(for tone: ADEKitTone) -> String {
    switch tone {
    case .crit: return "exclamationmark.octagon.fill"
    case .neutral: return "info.circle.fill"
    default: return "exclamationmark.triangle.fill"
    }
  }
}

// MARK: - Settings as a List

// For settings pages that need List-only behaviour (swipe actions, pull to
// refresh on a long list): the same panels, drawn by an inset-grouped List.

extension View {
  /// An inset-grouped `List` that reads like `ADESettingsPage` + `ADESettingsRows`.
  func adeSettingsList() -> some View {
    listStyle(.insetGrouped)
      // The same 16pt sides as `ADESettingsPage`: a regular-width window
      // widened the system's inset, so List pages ended further in than the
      // pages beside them. Plus the trailing safe area, so the rows still
      // stop at the Duo's edge bar.
      .duoInsetGroupedMargins(16)
      .scrollContentBackground(.hidden)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .listSectionSpacing(22)
      .environment(\.defaultMinListRowHeight, 48)
  }

  /// One row of an `adeSettingsList()`: kit surface, kit rule between rows.
  func adeSettingsListRow(insets: EdgeInsets = EdgeInsets(top: 11, leading: ADEKit.inset, bottom: 11, trailing: ADEKit.inset)) -> some View {
    listRowBackground(ADEKit.surface)
      .listRowInsets(insets)
      .listRowSeparatorTint(ADEKit.rule)
  }
}

/// A settings section header: title, at most one hint line, optional trailing
/// control. Drawn above `ADESettingsRows`, or (`inList`) as a List section header.
struct ADESettingsHeader<Trailing: View>: View {
  var title: String?
  var hint: String?
  var symbol: String? = nil
  var tint: ADESettingsTint = .accent
  var inList = false
  @ViewBuilder var trailing: () -> Trailing

  var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      HStack(alignment: .top, spacing: 12) {
        if let symbol {
          ADESettingsIconTile(symbol: symbol, tint: tint, size: 32)
        }
        headingText
      }
      Spacer(minLength: 8)
      trailing()
    }
    .textCase(nil)
    .padding(.leading, inList ? -6 : 4)
    .padding(.trailing, inList ? 0 : 4)
    .padding(.bottom, inList ? 2 : 0)
    .accessibilityElement(children: .contain)
  }

  private var headingText: some View {
    VStack(alignment: .leading, spacing: 2) {
      if let title {
        Text(title)
          .font(.system(size: symbol == nil ? 15 : 17, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
      }
      if let hint {
        Text(hint)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

extension ADESettingsHeader where Trailing == EmptyView {
  /// A List section header (`adeSettingsList()`).
  init(_ title: String, hint: String? = nil) {
    self.init(title: title, hint: hint, inList: true, trailing: { EmptyView() })
  }
}

// MARK: - Brand tiles (desktop `providerBrand.tsx`, `integrationBrand.tsx`)

/// A maker's colours and logo, as the desktop's provider and integration
/// pages wear them: the banner's gradient behind the logo in the banner's
/// ink, so Claude reads as Claude before its name is read.
struct ADEBrand: Equatable {
  /// The banner gradient, top leading to bottom trailing.
  let colors: [Color]
  /// The logo. Nil draws `monogram` instead.
  let asset: String?
  /// The logo's ink. Nil keeps the logo's own colours (a full-colour mark).
  let ink: Color?
  var monogram: String? = nil
  /// The logo's share of the tile.
  var scale: CGFloat = 0.54

  private static func rgb(_ hex: UInt32) -> Color {
    Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
  }

  private static func make(_ colors: [UInt32], _ asset: String?, ink: UInt32?, monogram: String? = nil, scale: CGFloat = 0.54) -> ADEBrand {
    ADEBrand(colors: colors.map(rgb), asset: asset, ink: ink.map(rgb), monogram: monogram, scale: scale)
  }

  /// A coding agent, by any of its provider slugs ("claude", "claude-chat",
  /// "openai-codex", …), folded to the desktop's provider id first.
  static func provider(_ slug: String) -> ADEBrand {
    let id = ADESharedTheme.providerFamilyKey(for: slug)
    switch id {
    case "claude": return make([0xC9653F, 0xD97757, 0xE0896A], "ProviderClaude", ink: 0xFFF4EA)
    // Codex's mark is a gradient cloud: it keeps its colours on a light tile.
    case "codex": return make([0xFFFFFF, 0xE6E9FF], "ProviderCodex", ink: nil, scale: 0.62)
    case "cursor": return make([0x26262B, 0x0B0B0D], "ProviderCursor", ink: 0xF4F4F5)
    case "droid": return make([0x1C1C1C, 0x000000], "ProviderDroid", ink: nil, scale: 0.66)
    case "copilot": return make([0x7448FF, 0x2A00B8], "ProviderGitHub", ink: 0xFFFFFF)
    case "muse": return make([0xFFFFFF, 0xE9EEF5], "ProviderMuse", ink: nil, scale: 0.62)
    case "pi": return make([0x2C2C2C, 0x050505], "ProviderPi", ink: 0xFFFFFF, scale: 0.6)
    case "opencode": return make([0x2A2626, 0x131010], "ProviderOpenCode", ink: 0xF1ECEC)
    case "qwen": return make([0x7A4FE8, 0x615CED, 0x3F38D6], "ProviderQwen", ink: 0xFFFFFF)
    case "kimi": return make([0x1D4F94, 0x111214, 0x050506], "ProviderKimi", ink: 0xFFFFFF)
    case "grok": return make([0x3A3A3E, 0x0A0A0A, 0x000000], "ProviderXAI", ink: 0xFFFFFF)
    case "devin": return make([0x2A2A2C, 0x050505], "ProviderDevin", ink: 0xF2F2F2, scale: 0.66)
    case "antigravity": return make([0x4285F4, 0x9B72CB], nil, ink: 0xFFFFFF, monogram: "A")
    case "anthropic": return make([0xC9653F, 0xD97757, 0xE0896A], "ProviderAnthropic", ink: 0xFFF4EA)
    case "openai": return make([0x2A2A2F, 0x0B0B0D], "ProviderOpenAI", ink: 0xFFFFFF)
    default:
      return make([0x2A2A2F, 0x111114], nil, ink: 0xF2F2F3, monogram: id.first.map { String($0).uppercased() } ?? "?")
    }
  }

  static let github = make([0xEFFCFF, 0xD8F8FF], "ProviderGitHub", ink: 0x24292F)
  static let linear = make([0x303C9A, 0x252D7C], "LinearLogo", ink: 0xFFFFFF, scale: 0.5)
  static let jira = make([0xEAFBFF, 0xDFF9FF], "BrandJira", ink: 0x2684FF, scale: 0.5)
  static let agent37 = make([0x262626, 0x0A0A0A], "BrandAgent37", ink: 0xFFFFFF, scale: 0.62)
}

/// A maker's tile: its banner gradient with its logo on it (desktop
/// `.ade-ix-mark`). `dimmed` greys it for a provider that is not set up.
struct ADEBrandTile: View {
  let brand: ADEBrand
  var size: CGFloat = 32
  var dimmed = false

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
    ZStack {
      LinearGradient(colors: brand.colors, startPoint: .topLeading, endPoint: .bottomTrailing)
      // A soft top light, as the desktop's banners have.
      LinearGradient(colors: [.white.opacity(0.16), .clear], startPoint: .top, endPoint: .center)
      logo
    }
    .frame(width: size, height: size)
    .clipShape(shape)
    .overlay(shape.strokeBorder(Color.white.opacity(0.12), lineWidth: 0.75))
    .saturation(dimmed ? 0 : 1)
    .opacity(dimmed ? 0.55 : 1)
    .accessibilityHidden(true)
  }

  @ViewBuilder
  private var logo: some View {
    let side = size * brand.scale
    if let asset = brand.asset {
      if let ink = brand.ink {
        Image(asset).renderingMode(.template).resizable().scaledToFit()
          .foregroundStyle(ink)
          .frame(width: side, height: side)
      } else {
        Image(asset).renderingMode(.original).resizable().scaledToFit()
          .frame(width: side, height: side)
      }
    } else {
      Text(brand.monogram ?? "?")
        .font(.system(size: size * 0.46, weight: .bold, design: .rounded))
        .foregroundStyle(brand.ink ?? .white)
    }
  }
}

/// A few makers' tiles overlapping, as an avatar stack: "these are ready".
struct ADEBrandTileStack: View {
  let brands: [ADEBrand]
  var size: CGFloat = 26
  var limit = 5

  var body: some View {
    HStack(spacing: -size * 0.3) {
      ForEach(Array(brands.prefix(limit).enumerated()), id: \.offset) { _, brand in
        ADEBrandTile(brand: brand, size: size)
          .overlay(
            RoundedRectangle(cornerRadius: size * 0.27 + 1.5, style: .continuous)
              .strokeBorder(ADEKit.surface, lineWidth: 1.5)
              .padding(-1.5)
          )
      }
      if brands.count > limit {
        Text("+\(brands.count - limit)")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: size, height: size)
          .background(ADEKit.track, in: RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
          .padding(.leading, size * 0.3 + 4)
      }
    }
    .accessibilityHidden(true)
  }
}

/// A status in sentence case after a dot (or a spinner while it is being
/// checked). Calm for a good state; the tone's colour for one that wants a tap.
struct ADESettingsStatus: View {
  let text: String
  var tone: ADEKitTone = .neutral
  var checking = false
  /// A row's trailing status keeps its full width. A status under a title
  /// (an integration card's) may be long, so it shortens in the middle.
  var truncates = false

  var body: some View {
    HStack(spacing: 6) {
      if checking {
        ProgressView().controlSize(.mini)
      } else {
        Circle().fill(tone.color).frame(width: 6, height: 6)
      }
      Text(text)
        .font(.system(size: 13.5, weight: tone == .warn || tone == .crit ? .medium : .regular))
        .foregroundStyle(textColor)
        .lineLimit(1)
        .truncationMode(.middle)
    }
    .fixedSize(horizontal: !truncates, vertical: false)
  }

  private var textColor: Color {
    switch tone {
    case .warn, .crit: return tone.color
    case .neutral: return ADEColor.textMuted
    default: return ADEColor.textSecondary
    }
  }
}

/// A page-level call to act: a tone tile, what is wrong in a few words, why
/// it matters, and the one button that fixes it, side by side.
struct ADESettingsCallout: View {
  let symbol: String
  var tone: ADEKitTone = .warn
  let title: String
  var detail: String?
  var actionTitle: String?
  var action: (() -> Void)?

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous)
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: symbol)
        .symbolVariant(.fill)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(tone.color)
        .frame(width: 36, height: 36)
        .background(tone.color.opacity(0.16), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if let detail {
          Text(detail)
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .layoutPriority(1)
      Spacer(minLength: 8)
      if let actionTitle, let action {
        Button(actionTitle, action: action)
          .buttonStyle(ADEKitButtonStyle(prominent: true, brand: tone == .neutral ? nil : tone.color))
          .fixedSize()
      }
    }
    .padding(ADEKit.inset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(tone.color.opacity(0.08), in: shape)
    .overlay(shape.strokeBorder(tone.color.opacity(0.28), lineWidth: 0.75))
    .accessibilityElement(children: .combine)
  }
}
