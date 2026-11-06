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
        content()
      }
      .padding(.horizontal, 16)
      .padding(.top, 12)
      .padding(.bottom, 36)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .adeSettingsPageTitle(title, subtitle: subtitle)
  }
}

extension ADESettingsPage {
  /// One of Settings' pages, under its sidebar title and description.
  init(route: SettingsRoute, @ViewBuilder content: @escaping () -> Content) {
    self.init(title: route.title, subtitle: route.subtitle, content: content)
  }
}

extension View {
  /// The settings page title bar: the large title and description, the glass
  /// bar, and Close where the stack has one. For a page that draws its own
  /// scroll view instead of `ADESettingsPage`.
  @ViewBuilder
  func adeSettingsPageTitle(_ title: String, subtitle: String? = nil) -> some View {
    let titled = adeNavigationGlass()
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.large)
      .settingsPageClose()
    if let subtitle, !subtitle.isEmpty {
      titled.navigationSubtitle(subtitle)
    } else {
      titled
    }
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

/// A glyph on a soft tinted tile (desktop `SettingsRowIcon`): 15% of the tone
/// behind it, a 22% edge.
struct ADESettingsIconTile: View {
  let symbol: String
  var tint: ADESettingsTint = .accent
  var size: CGFloat = 30

  var body: some View {
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
          if index > 0 {
            Rectangle()
              .fill(ADEKit.rule)
              .frame(height: 0.75)
              .padding(.leading, ADEKit.inset)
          }
          subview
        }
      }
    }
    .adeKitCard(padding: nil)
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
  var value: String?
  @ViewBuilder var destination: () -> Destination

  var body: some View {
    ADESettingsPageLink(title: title, shape: .sidebar, destination: destination) { selected, pushes in
      ADESettingsSidebarRow(title: title, symbol: symbol, value: value, selected: selected, showsChevron: pushes)
    }
  }
}

/// One row of the settings sidebar (desktop `SettingsSidebar`): outline glyph,
/// title, an optional quiet value. The picked row turns the accent colour.
struct ADESettingsSidebarRow: View {
  let title: String
  var symbol: String?
  var value: String?
  var selected = false
  /// A one-column stack pushes, so the row says so; the two-column window
  /// shows the page beside it instead.
  var showsChevron = true

  var body: some View {
    HStack(spacing: 12) {
      if let symbol {
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

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: tone == .crit ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
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
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(tone.color.opacity(0.07), in: RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous))
    .accessibilityElement(children: .combine)
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
