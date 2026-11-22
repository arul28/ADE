import SwiftUI

/// The flat content layer: rows on the page background with hairlines between
/// them, like the desktop. Controls that float over content (bars, segmented
/// controls, menus, sheets) stay Liquid Glass; toasts are solid pills so they
/// stay readable over busy content; content never gets a
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
    // The rows' own 16pt, also where a narrow list (a split pane) would
    // otherwise drop the header's margin to zero.
    .listRowInsets(EdgeInsets(top: 0, leading: ADEFlat.rowInsets.leading, bottom: 0, trailing: ADEFlat.rowInsets.trailing))
  }
}

extension ADEFlatSectionHeader where Trailing == EmptyView {
  init(_ title: String, detail: String? = nil) {
    self.init(title, detail: detail) { EmptyView() }
  }
}

/// A screen-level problem as one slim row: icon, message, optional Retry.
/// With `technicalDetail`, the design system's technical-details fold (raw
/// text and Copy) sits under the row, folded by default.
struct ADEFlatInlineNotice: View {
  let message: String
  var tint: Color = ADEColor.warning
  var technicalDetail: String? = nil
  var retry: (() -> Void)?

  var body: some View {
    let detail = technicalDetail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(tint)
          .accessibilityHidden(true)
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
            .fixedSize()
        }
      }
      if !detail.isEmpty {
        ADETechnicalDetailsFold(text: detail)
          .padding(.leading, 19)
      }
    }
    .frame(minHeight: 32)
    // The fold's own controls sit beside Retry, so they need their own elements.
    .accessibilityElement(children: detail.isEmpty ? .combine : .contain)
  }
}

/// A short action result ("Branch deleted") shown as a floating pill.
struct ADEToastMessage: Equatable, Identifiable {
  enum Kind { case success, failure, info }
  let id = UUID()
  /// The headline, short: "Couldn’t open ADE", "Branch deleted".
  let text: String
  var kind: Kind = .success
  /// One button on the toast ("Undo", "Retry"). A toast with an action stays 6 s.
  var action: ADEToastAction? = nil
  /// Why, in one plain line under the headline. Keep the headline short and
  /// put the reason here rather than joining both with a colon.
  var detail: String? = nil

  static func == (lhs: ADEToastMessage, rhs: ADEToastMessage) -> Bool {
    lhs.id == rhs.id
  }

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

  /// A failure stays long enough to read its reason.
  var duration: Duration {
    if action != nil { return .seconds(6) }
    return kind == .failure ? .seconds(5) : .seconds(3)
  }
}

/// The button on a toast, such as Undo.
struct ADEToastAction {
  let title: String
  let perform: () -> Void
}

/// The pill itself. Solid (not glass), so it stays readable over busy cards;
/// the tone shows only on the icon and a faint edge, never as a fill.
private struct ADEToastPill: View {
  let message: ADEToastMessage
  let onAction: () -> Void

  private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 20, style: .continuous) }

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: message.symbol)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(message.tint)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(message.text)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(message.detail == nil ? 2 : 1)
        if let detail = message.detail, !detail.isEmpty {
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }
      .fixedSize(horizontal: false, vertical: true)
      if let action = message.action {
        Button(action: onAction) {
          Text(action.title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
            .padding(.horizontal, 12)
            .frame(minHeight: 32)
            .background(ADEColor.accent.opacity(0.14), in: Capsule(style: .continuous))
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.leading, 14)
    .padding(.trailing, message.action == nil ? 16 : 7)
    .padding(.vertical, message.detail == nil ? 10 : 8)
    .background(ADEColor.surfaceBackground, in: shape)
    .overlay(shape.strokeBorder(message.tint.opacity(0.28), lineWidth: 0.8))
    .shadow(color: Color.black.opacity(0.28), radius: 14, x: 0, y: 6)
  }
}

private struct ADEToastModifier: ViewModifier {
  @Binding var message: ADEToastMessage?
  /// Extra space below the toast, for a screen with its own bar at the bottom.
  var bottomInset: CGFloat = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content.overlay(alignment: .bottom) {
      if let message {
        ADEToastPill(message: message) {
          message.action?.perform()
          self.message = nil
        }
        // Hugs its words, up to a readable width.
        .frame(maxWidth: 440)
        .padding(.horizontal, 16)
        .padding(.bottom, 12 + bottomInset)
        // Tap or swipe down to put it away.
        .onTapGesture { self.message = nil }
        .gesture(
          DragGesture(minimumDistance: 12).onEnded { value in
            if value.translation.height > 12 { self.message = nil }
          }
        )
        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        .id(message.id)
        .task(id: message.id) {
          try? await Task.sleep(for: message.duration)
          guard !Task.isCancelled, self.message?.id == message.id else { return }
          self.message = nil
        }
        .accessibilityElement(children: message.action == nil ? .combine : .contain)
        .accessibilityAddTraits(.isStaticText)
      }
    }
    .animation(ADEMotion.emphasis(reduceMotion: reduceMotion), value: message)
  }
}

extension View {
  /// Shows `message` as a floating pill for 3 s (5 s for a failure, 6 s
  /// with an action). `bottomInset` lifts it
  /// above a bar the screen keeps at the bottom.
  func adeToast(_ message: Binding<ADEToastMessage?>, bottomInset: CGFloat = 0) -> some View {
    modifier(ADEToastModifier(message: message, bottomInset: bottomInset))
  }
}

#if DEBUG
/// Every kind of toast pill over busy content (`-adePreviewScreen toasts`).
struct ADEToastPreviewHost: View {
  var body: some View {
    ZStack(alignment: .bottom) {
      ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
          ForEach(0..<12, id: \.self) { index in
            RoundedRectangle(cornerRadius: 18, style: .continuous)
              .fill(ADEColor.cardBackground)
              .frame(height: 150)
              .overlay(alignment: .topLeading) {
                Text("Project \(index + 1)")
                  .font(.headline)
                  .foregroundStyle(ADEColor.textPrimary)
                  .padding(14)
              }
          }
        }
        .padding(16)
      }
      VStack(spacing: 12) {
        ADEToastPill(message: ADEToastMessage(text: "Changed the icon for ADE.", kind: .info), onAction: {})
        ADEToastPill(message: ADEToastMessage(text: "Branch deleted", action: ADEToastAction(title: "Undo") {}), onAction: {})
        ADEToastPill(
          message: ADEToastMessage(text: "Couldn't change Fast mode", kind: .failure, detail: "This machine's project connection isn't ready yet."),
          onAction: {}
        )
        ADEToastPill(
          message: ADEToastMessage(
            text: "Couldn’t open ADE",
            kind: .failure,
            action: ADEToastAction(title: "Retry") {},
            detail: "The computer took too long to answer."
          ),
          onAction: {}
        )
      }
      .frame(maxWidth: 440)
      .padding(.horizontal, 16)
      .padding(.bottom, 24)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
  }
}

#Preview("Toasts") {
  ADEToastPreviewHost()
}
#endif
