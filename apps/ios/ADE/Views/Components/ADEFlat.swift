import SwiftUI

/// The flat content layer: rows on the page background with hairlines between
/// them, like the desktop. Controls that float over content (bars, segmented
/// controls, menus, sheets, toasts) stay Liquid Glass; content never gets a
/// card fill. Cards use the kit (`ADEKit.swift`); `adeGlassCard` is left only
/// for the Work composer and chat cards.
enum ADEFlat {
  static let rowInsets = EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16)
  static let hairline = ADEColor.border.opacity(0.55)
}

extension Font {
  /// Mono for numbers, branches, diff stats and counts.
  static func adeMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .monospaced)
  }
}

extension View {
  /// A plain `List` on the page background: flat rows, hairline separators.
  func adeFlatList() -> some View {
    listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .environment(\.defaultMinListRowHeight, 44)
  }

  /// One flat row in an `adeFlatList()`.
  func adeFlatRow(insets: EdgeInsets = ADEFlat.rowInsets, separator: Visibility = .automatic) -> some View {
    listRowBackground(Color.clear)
      .listRowInsets(insets)
      .listRowSeparatorTint(ADEFlat.hairline)
      .listRowSeparator(separator)
      // Hairlines only between rows, never above or below a section.
      .listSectionSeparator(.hidden)
  }
}

/// A small uppercase section label with an optional detail and trailing view.
struct ADEFlatSectionHeader<Trailing: View>: View {
  let title: String
  var detail: String?
  @ViewBuilder var trailing: () -> Trailing

  init(_ title: String, detail: String? = nil, @ViewBuilder trailing: @escaping () -> Trailing) {
    self.title = title
    self.detail = detail
    self.trailing = trailing
  }

  var body: some View {
    HStack(spacing: 8) {
      Text(title.uppercased())
        .font(.caption2.weight(.semibold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)
      if let detail {
        Text(detail)
          .font(.adeMono(10.5))
          .foregroundStyle(ADEColor.textMuted)
      }
      Spacer(minLength: 8)
      trailing()
    }
    .textCase(nil)
    .frame(minHeight: 22)
  }
}

extension ADEFlatSectionHeader where Trailing == EmptyView {
  init(_ title: String, detail: String? = nil) {
    self.init(title, detail: detail) { EmptyView() }
  }
}

/// A screen-level problem as one slim row: icon, message, optional Retry.
struct ADEFlatInlineNotice: View {
  let message: String
  var tint: Color = ADEColor.warning
  var retry: (() -> Void)?

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(tint)
      Text(message)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(2)
      Spacer(minLength: 8)
      if let retry {
        Button("Retry", action: retry)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
          .buttonStyle(.plain)
      }
    }
    .frame(minHeight: 32)
    .accessibilityElement(children: .combine)
  }
}

/// A short action result ("Branch deleted") shown as a glass toast.
struct ADEToastMessage: Equatable, Identifiable {
  enum Kind { case success, failure, info }
  let id = UUID()
  let text: String
  var kind: Kind = .success

  var symbol: String {
    switch kind {
    case .success: return "checkmark.circle.fill"
    case .failure: return "exclamationmark.circle.fill"
    case .info: return "info.circle.fill"
    }
  }

  var tint: Color {
    switch kind {
    case .success: return ADEColor.success
    case .failure: return ADEColor.danger
    case .info: return ADEColor.accent
    }
  }
}

private struct ADEToastModifier: ViewModifier {
  @Binding var message: ADEToastMessage?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content.overlay(alignment: .bottom) {
      if let message {
        HStack(spacing: 8) {
          Image(systemName: message.symbol)
            .foregroundStyle(message.tint)
          Text(message.text)
            .font(.footnote.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassEffect(in: Capsule(style: .continuous))
        .padding(.bottom, 12)
        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        .id(message.id)
        .task(id: message.id) {
          try? await Task.sleep(for: .seconds(3))
          guard !Task.isCancelled, self.message?.id == message.id else { return }
          self.message = nil
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
      }
    }
    .animation(ADEMotion.emphasis(reduceMotion: reduceMotion), value: message)
  }
}

extension View {
  /// Shows `message` as a glass toast for 3 s.
  func adeToast(_ message: Binding<ADEToastMessage?>) -> some View {
    modifier(ADEToastModifier(message: message))
  }
}
