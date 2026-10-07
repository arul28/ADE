import SwiftUI

// ADEKit: the iOS surface kit. The SwiftUI counterpart of desktop's
// `surfaceKit.css` (card, card head, eyebrow, stat, row, meter, dot, tag,
// segmented, legend) and `SettingsModern.tsx` (page, section, rows, row).
// One vocabulary for boxes: a new surface reuses these, and anything missing is
// added here rather than written as a one-off panel. See
// docs/design/visual-language.md ("iOS").
//
// Everything is flat: no materials, glows, gradients or shadows, so the kit is
// cheap inside scrolling lists. Colour only for meaning, via `ADEKitTone`.

// MARK: - Tokens

enum ADEKit {
  /// Card and grouped-rows panel corner radius.
  static let radius: CGFloat = 14
  /// Padding inside a settings row or a card body.
  static let inset: CGFloat = 14
  /// Gap between settings sections (desktop `ModernPage` spaces them 44px).
  static let sectionGap: CGFloat = 30

  /// The card / panel plane.
  static var surface: Color { ADEColor.cardBackground }
  /// Hairline edge around a card or panel (`--kit-card-edge`).
  static var edge: Color { ADEColor.textPrimary.opacity(0.09) }
  /// Divider between rows (`--kit-rule`).
  static var rule: Color { ADEColor.textPrimary.opacity(0.07) }
  /// Meter and segmented-control track (`--kit-track`).
  static var track: Color { ADEColor.textPrimary.opacity(0.07) }
  /// Neutral meter fill (`--kit-fill`).
  static var fill: Color { ADEColor.textPrimary.opacity(0.42) }
  /// Pressed / hovered row (`--kit-hover`).
  static var pressed: Color { ADEColor.textPrimary.opacity(0.055) }
}

/// The only colours the kit adds: status and the accent on the selected thing.
enum ADEKitTone: Equatable {
  case neutral, ok, warn, crit, accent

  var color: Color {
    switch self {
    case .neutral: return ADEColor.textMuted
    case .ok: return ADEColor.success
    case .warn: return ADEColor.warning
    case .crit: return ADEColor.danger
    case .accent: return ADEColor.accent
    }
  }
}

// MARK: - Card

/// The box (`.kit-card`): calm surface, hairline edge, rounded corners.
struct ADEKitCardModifier: ViewModifier {
  var padding: CGFloat?

  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous)
    content
      .padding(padding ?? 0)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEKit.surface, in: shape)
      .overlay(shape.strokeBorder(ADEKit.edge, lineWidth: 0.75))
      .clipShape(shape)
  }
}

extension View {
  /// Wraps the view in the kit card. `padding: nil` keeps content flush.
  func adeKitCard(padding: CGFloat? = ADEKit.inset) -> some View {
    modifier(ADEKitCardModifier(padding: padding))
  }
}

/// A card with a 40pt head (`.kit-card` + `.kit-card-head`) and a padded body.
struct ADEKitCard<Content: View, Action: View>: View {
  let title: String
  var symbol: String?
  var count: String?
  var flush = false
  @ViewBuilder var action: () -> Action
  @ViewBuilder var content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ADEKitCardHead(title: title, symbol: symbol, count: count, action: action)
      content()
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, flush ? 0 : ADEKit.inset)
        .padding(.bottom, flush ? 0 : ADEKit.inset)
    }
    .adeKitCard(padding: nil)
  }
}

extension ADEKitCard where Action == EmptyView {
  init(title: String, symbol: String? = nil, count: String? = nil, flush: Bool = false, @ViewBuilder content: @escaping () -> Content) {
    self.init(title: title, symbol: symbol, count: count, flush: flush, action: { EmptyView() }, content: content)
  }
}

/// Card header: icon, label, count, then an optional trailing action. 40pt tall.
struct ADEKitCardHead<Action: View>: View {
  let title: String
  var symbol: String?
  var count: String?
  @ViewBuilder var action: () -> Action

  var body: some View {
    HStack(spacing: 7) {
      if let symbol {
        Image(systemName: symbol)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(ADEColor.textMuted)
      }
      Text(title)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      if let count {
        Text(count)
          .font(.adeMono(11))
          .foregroundStyle(ADEColor.textMuted)
      }
      Spacer(minLength: 8)
      action()
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(ADEColor.textSecondary)
    }
    .padding(.horizontal, ADEKit.inset)
    .frame(height: 40)
    .accessibilityElement(children: .contain)
  }
}

// MARK: - Text pieces

/// 10pt mono uppercase label with wide tracking (`.kit-eyebrow`).
struct ADEEyebrow: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text.uppercased())
      .font(.system(size: 10, weight: .medium, design: .monospaced))
      .tracking(1.4)
      .foregroundStyle(ADEColor.textMuted)
      .lineLimit(1)
  }
}

/// One big tabular figure with its eyebrow (`.kit-stat`).
struct ADEKitStat: View {
  let label: String
  let value: String
  var detail: String?
  var size: CGFloat = 24

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ADEEyebrow(label)
      Text(value)
        .font(.system(size: size, weight: .medium, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .minimumScaleFactor(0.6)
      if let detail {
        Text(detail)
          .font(.system(size: 11.5))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Status

/// A 6pt status dot (`.kit-dot`).
struct ADEKitDot: View {
  var tone: ADEKitTone = .ok
  var size: CGFloat = 6

  var body: some View {
    Circle()
      .fill(tone == .neutral ? ADEColor.textMuted.opacity(0.55) : tone.color)
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

/// A small tinted pill (`.kit-tag`): mono caps, 18pt tall.
struct ADEKitTag: View {
  let text: String
  var tone: ADEKitTone = .neutral

  var body: some View {
    Text(text.uppercased())
      .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
      .tracking(0.5)
      .foregroundStyle(tone == .neutral ? ADEColor.textSecondary : tone.color)
      .padding(.horizontal, 6)
      .frame(height: 18)
      .background(
        (tone == .neutral ? ADEColor.textPrimary.opacity(0.07) : tone.color.opacity(0.14)),
        in: RoundedRectangle(cornerRadius: 4, style: .continuous)
      )
      .lineLimit(1)
      .fixedSize()
  }
}

/// A thin bar (`.kit-meter`). `fraction` is 0...1 of the bar that is filled.
struct ADEKitMeter: View {
  let fraction: Double
  var color: Color = ADEKit.fill
  var height: CGFloat = 4

  var body: some View {
    Capsule()
      .fill(ADEKit.track)
      .frame(height: height)
      .overlay(alignment: .leading) {
        GeometryReader { proxy in
          Capsule()
            .fill(color)
            .frame(width: proxy.size.width * min(1, max(0, fraction)))
        }
      }
      .clipShape(Capsule())
      .accessibilityHidden(true)
  }
}

/// A chart legend item (`.kit-legend`): swatch, label, tabular value.
struct ADEKitLegendItem: View {
  let color: Color
  let label: String
  var value: String?
  var assetName: String?

  var body: some View {
    HStack(spacing: 5) {
      if let assetName {
        Image(assetName).resizable().scaledToFit().frame(width: 12, height: 12)
      } else {
        RoundedRectangle(cornerRadius: 2, style: .continuous).fill(color).frame(width: 8, height: 8)
      }
      Text(label)
        .foregroundStyle(ADEColor.textSecondary)
      if let value {
        Text(value)
          .font(.adeMono(11, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
      }
    }
    .font(.system(size: 11.5))
    .lineLimit(1)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Controls

/// A segmented control (`.kit-seg`): a quiet track, the selected option raised.
struct ADEKitSegmented<Value: Hashable>: View {
  @Binding var selection: Value
  let options: [(value: Value, title: String)]

  var body: some View {
    HStack(spacing: 2) {
      ForEach(options, id: \.value) { option in
        let selected = option.value == selection
        Button {
          selection = option.value
        } label: {
          Text(option.title)
            .font(.system(size: 12.5, weight: selected ? .semibold : .medium))
            .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 30)
            .background {
              if selected {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                  .fill(ADEKit.surface)
                  .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(ADEKit.edge, lineWidth: 0.75))
              }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
      }
    }
    .padding(2)
    .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
  }
}

/// The label of a menu-button control: current value plus an up/down chevron.
struct ADEKitMenuLabel: View {
  let title: String
  var symbol: String?

  var body: some View {
    HStack(spacing: 5) {
      if let symbol {
        Image(systemName: symbol).font(.system(size: 11, weight: .medium))
      }
      Text(title)
        .font(.system(size: 13, weight: .medium))
        .lineLimit(1)
      Image(systemName: "chevron.up.chevron.down")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .foregroundStyle(ADEColor.textPrimary)
    .padding(.horizontal, 10)
    .frame(height: 30)
    .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .contentShape(Rectangle())
  }
}

/// A capsule button. `prominent` fills it with the accent for the one primary
/// action; otherwise it is a neutral pill. `wide` makes it a full-width,
/// 44pt sheet footer button.
struct ADEKitButtonStyle: ButtonStyle {
  var prominent = false
  var tone: ADEKitTone = .neutral
  var wide = false

  func makeBody(configuration: Configuration) -> some View {
    let tint = tone == .neutral ? ADEColor.textPrimary : tone.color
    configuration.label
      .font(.system(size: wide ? 15 : 13, weight: .semibold))
      .lineLimit(1)
      .foregroundStyle(prominent ? Color.white : tint)
      .padding(.horizontal, 12)
      .frame(maxWidth: wide ? .infinity : nil, minHeight: wide ? 46 : 30)
      .background(
        prominent ? ADEColor.accent : (tone == .neutral ? ADEKit.track : tone.color.opacity(0.12)),
        in: Capsule(style: .continuous)
      )
      .opacity(configuration.isPressed ? 0.7 : 1)
      .contentShape(Capsule(style: .continuous))
  }
}

/// A full-width row that highlights while pressed (`.kit-row`).
struct ADEKitRowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .contentShape(Rectangle())
      .background(configuration.isPressed ? ADEKit.pressed : Color.clear)
  }
}

// MARK: - Settings page (desktop ModernPage / ModernSection / ModernRows / ModernRow)

/// One calm scrolling column of sections on the page background.
struct ADESettingsPage<Content: View>: View {
  let title: String
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
    .adeNavigationGlass()
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// A section: title, at most one hint line, an optional trailing control, then
/// its content (usually `ADESettingsRows`).
struct ADESettingsSection<Content: View, Trailing: View>: View {
  var title: String?
  var hint: String?
  @ViewBuilder var trailing: () -> Trailing
  @ViewBuilder var content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if title != nil || hint != nil {
        HStack(alignment: .bottom, spacing: 8) {
          VStack(alignment: .leading, spacing: 2) {
            if let title {
              Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
            }
            if let hint {
              Text(hint)
                .font(.system(size: 12.5))
                .foregroundStyle(ADEColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          Spacer(minLength: 8)
          trailing()
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .contain)
      }
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

extension ADESettingsSection where Trailing == EmptyView {
  init(_ title: String? = nil, hint: String? = nil, @ViewBuilder content: @escaping () -> Content) {
    self.init(title: title, hint: hint, trailing: { EmptyView() }, content: content)
  }
}

extension ADESettingsSection {
  init(_ title: String?, hint: String? = nil, @ViewBuilder trailing: @escaping () -> Trailing, @ViewBuilder content: @escaping () -> Content) {
    self.init(title: title, hint: hint, trailing: trailing, content: content)
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
  @ViewBuilder var control: () -> Control

  var body: some View {
    HStack(spacing: 12) {
      if let symbol {
        Image(systemName: symbol)
          .font(.system(size: 15, weight: .regular))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 22)
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
      Spacer(minLength: 8)
      control()
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
  }
}

extension ADESettingsRow where Control == EmptyView {
  init(_ title: String, hint: String? = nil, symbol: String? = nil, titleColor: Color = ADEColor.textPrimary) {
    self.init(title: title, hint: hint, symbol: symbol, titleColor: titleColor, control: { EmptyView() })
  }
}

/// A read-only fact: label on the left, value on the right (mono for ids).
struct ADESettingsValueRow: View {
  let title: String
  let value: String
  var symbol: String?
  var mono = false
  var tone: ADEKitTone?

  var body: some View {
    ADESettingsRow(title: title, symbol: symbol) {
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

/// A row that pushes a page: icon, title, optional value, chevron.
struct ADESettingsLink<Destination: View>: View {
  let title: String
  var hint: String?
  var symbol: String?
  var value: String?
  @ViewBuilder var destination: () -> Destination

  var body: some View {
    NavigationLink(destination: destination) {
      ADESettingsRow(title: title, hint: hint, symbol: symbol) {
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
    .buttonStyle(ADEKitRowButtonStyle())
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
    .opacity(disabled ? 0.45 : 1)
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

/// A section header for `adeSettingsList()`: title, one hint, trailing control.
struct ADESettingsListHeader<Trailing: View>: View {
  let title: String
  var hint: String?
  @ViewBuilder var trailing: () -> Trailing

  var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if let hint {
          Text(hint)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      Spacer(minLength: 8)
      trailing()
    }
    .textCase(nil)
    .padding(.leading, -6)
    .padding(.bottom, 2)
  }
}

extension ADESettingsListHeader where Trailing == EmptyView {
  init(_ title: String, hint: String? = nil) {
    self.init(title: title, hint: hint, trailing: { EmptyView() })
  }
}
