import SwiftUI
import UIKit
import AVKit

/// Renders one vocabulary node with native controls.
///
/// The interpreter half of the contract in
/// `apps/desktop/src/shared/plugins/vocabulary.ts`: desktop draws the same JSON
/// with React primitives, this draws it with the iOS design system. Nothing
/// here evaluates anything — a button carries an action id the host dispatches,
/// a list carries rows the plugin already materialized.
///
/// The one invariant worth stating: **every branch draws something.** A node
/// this build cannot render becomes a marker naming the component, not an empty
/// `EmptyView`, because a silent gap is indistinguishable from a plugin bug and
/// sends the user hunting.
struct PluginVocabularyNodeView: View {
  let node: PluginVocabNode
  @ObservedObject var store: PluginPaneStore

  var body: some View {
    if PluginRenderSupport.isRenderable(node) {
      renderedNode
    } else {
      PluginUnsupportedNodeMarker(node: node)
    }
  }

  @ViewBuilder
  private var renderedNode: some View {
    switch node {
    case let .stack(stack):
      PluginVocabStackView(stack: stack, store: store)
    case let .text(text):
      PluginVocabTextView(text: text)
    case let .badge(badge):
      PluginVocabBadgeView(badge: badge)
    case let .button(button):
      PluginVocabButtonView(button: button, store: store)
    case let .list(list):
      PluginVocabListView(list: list, store: store)
    case let .table(table):
      PluginVocabTableView(table: table)
    case let .form(form):
      PluginVocabFormView(form: form, store: store)
    case let .video(video):
      PluginVocabVideoView(video: video)
    case let .image(image):
      PluginVocabImageView(image: image)
    case let .divider(label):
      PluginVocabDividerView(label: label)
    case let .keyValue(keyValue):
      PluginVocabKeyValueView(keyValue: keyValue)
    case let .emptyState(emptyState):
      PluginVocabEmptyStateView(emptyState: emptyState, store: store)
    default:
      // Unreachable: `isRenderable` gated every case above. Kept so a component
      // added to the renderable set without a branch here shows a marker rather
      // than collapsing to nothing.
      PluginUnsupportedNodeMarker(node: node)
    }
  }
}

// MARK: - Tone

extension PluginVocabTone {
  /// House rule, inherited from `adeCard.ts`: there is no red. A failure is
  /// amber, so a plugin cannot paint an alarm into a surface it does not own.
  var color: Color {
    switch self {
    case .neutral: return ADEColor.textSecondary
    case .accent: return ADEColor.accent
    case .success: return ADEColor.success
    case .warning: return ADEColor.warning
    }
  }

  var textColor: Color {
    self == .neutral ? ADEColor.textPrimary : color
  }
}

// MARK: - Layout

private struct PluginVocabStackView: View {
  let stack: PluginVocabStack
  @ObservedObject var store: PluginPaneStore

  private var spacing: CGFloat {
    switch stack.gap {
    case .none: return 0
    case .sm: return 6
    case .md: return 12
    case .lg: return 20
    }
  }

  var body: some View {
    if stack.direction == .horizontal {
      HStack(alignment: verticalAlignment, spacing: spacing) {
        children
      }
    } else {
      VStack(alignment: horizontalAlignment, spacing: spacing) {
        children
      }
      .frame(maxWidth: .infinity, alignment: frameAlignment)
    }
  }

  @ViewBuilder
  private var children: some View {
    ForEach(Array(stack.children.enumerated()), id: \.offset) { _, child in
      PluginVocabularyNodeView(node: child, store: store)
    }
  }

  private var horizontalAlignment: HorizontalAlignment {
    switch stack.align {
    case .start, .stretch: return .leading
    case .center: return .center
    case .end: return .trailing
    }
  }

  private var verticalAlignment: VerticalAlignment {
    switch stack.align {
    case .start, .stretch: return .top
    case .center: return .center
    case .end: return .bottom
    }
  }

  private var frameAlignment: Alignment {
    switch stack.align {
    case .start, .stretch: return .leading
    case .center: return .center
    case .end: return .trailing
    }
  }
}

private struct PluginVocabDividerView: View {
  let label: String?

  var body: some View {
    if let label {
      HStack(spacing: 8) {
        Text(label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
        Rectangle()
          .fill(ADEColor.border.opacity(0.6))
          .frame(height: 0.5)
      }
      .padding(.vertical, 2)
    } else {
      Divider().overlay(ADEColor.border.opacity(0.6))
    }
  }
}

// MARK: - Content

private struct PluginVocabTextView: View {
  let text: PluginVocabText

  var body: some View {
    Text(text.text)
      .font(font)
      .foregroundStyle(text.tone.textColor)
      .frame(maxWidth: .infinity, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
  }

  private var font: Font {
    switch text.variant {
    case .title: return .title3.weight(.semibold)
    case .subtitle: return .subheadline.weight(.semibold)
    case .body: return .subheadline
    case .caption: return .caption
    case .code: return .system(.caption, design: .monospaced)
    }
  }
}

private struct PluginVocabBadgeView: View {
  let badge: PluginVocabBadge

  var body: some View {
    if let icon = PluginSymbol.symbol(badge.icon) {
      ADEGlassChip(icon: icon, text: badge.text, tint: badge.tone.color)
    } else {
      ADEGlassStatusBadge(text: badge.text, tint: badge.tone.color)
    }
  }
}

private struct PluginVocabKeyValueView: View {
  let keyValue: PluginVocabKeyValue

  var body: some View {
    let rows = keyValue.rows ?? []
    if rows.isEmpty {
      PluginInlineEmptyText(text: keyValue.emptyText ?? "Nothing here yet.")
    } else {
      VStack(spacing: 8) {
        ForEach(rows) { row in
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(row.key)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
            Spacer(minLength: 8)
            Text(row.value)
              .font(.caption.weight(.medium))
              .foregroundStyle(row.tone.textColor)
              .multilineTextAlignment(.trailing)
          }
        }
      }
    }
  }
}

private struct PluginVocabListView: View {
  let list: PluginVocabList
  @ObservedObject var store: PluginPaneStore

  var body: some View {
    let items = list.items ?? []
    if items.isEmpty {
      PluginInlineEmptyText(text: list.emptyText ?? "Nothing here yet.")
    } else {
      VStack(spacing: 0) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          if index > 0 {
            Divider().overlay(ADEColor.border.opacity(0.4))
          }
          PluginVocabListRow(item: item, store: store)
        }
      }
    }
  }
}

/// One list row.
///
/// A row can carry a press of its own AND trailing buttons, so the press is a
/// button around the reading area only and the actions are its siblings. A
/// button inside a button would swallow the taps meant for the inner one.
private struct PluginVocabListRow: View {
  let item: PluginVocabListItem
  @ObservedObject var store: PluginPaneStore

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let action = item.onPress {
        Button {
          ADEHaptics.light()
          store.perform(action)
        } label: {
          content
        }
        .buttonStyle(.plain)
        .disabled(!store.canInvoke || store.isInFlight(action))
      } else {
        content
      }
      if !item.actions.isEmpty || !item.overflow.isEmpty {
        HStack(spacing: 8) {
          ForEach(item.actions) { entry in
            PluginVocabRowActionButton(entry: entry, store: store)
          }
          if !item.overflow.isEmpty {
            PluginVocabRowOverflowMenu(actions: item.overflow, store: store)
          }
          Spacer(minLength: 0)
        }
        .padding(.bottom, 9)
      }
    }
  }

  private var content: some View {
    HStack(spacing: 10) {
      if let icon = PluginSymbol.symbol(item.icon) {
        Image(systemName: icon)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(item.tone.color)
          .frame(width: 18)
      }
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(item.title)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
          if let badge = item.badge {
            PluginVocabBadgeView(badge: badge)
          }
        }
        if let subtitle = item.subtitle {
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
        }
        // Monospace, under the subtitle: the one place a row can put a value
        // meant to be COMPARED against the row above it — an id, a branch, a
        // short sha. One line, because a wrapped id is not comparable.
        if let mono = item.mono {
          Text(mono)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 8)
      if let meta = item.meta {
        Text(meta)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }
      if item.onPress != nil {
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.vertical, 9)
    .contentShape(Rectangle())
  }
}

/// A trailing button on a list row.
///
/// Smaller and quieter than a `button` node: up to three sit beside a row, and
/// at the weight of a real button the row would read as a toolbar with a label
/// attached. `primary` still tints, for the one action a row is about.
private struct PluginVocabRowActionButton: View {
  let entry: PluginVocabListItemAction
  @ObservedObject var store: PluginPaneStore

  private var isBusy: Bool { store.isInFlight(entry.action) }
  private var isDisabled: Bool { isBusy || !store.canInvoke }

  var body: some View {
    Button {
      ADEHaptics.light()
      store.perform(entry.action)
    } label: {
      HStack(spacing: 5) {
        if isBusy {
          ProgressView().controlSize(.mini)
        } else if let icon = PluginSymbol.symbol(entry.icon) {
          Image(systemName: icon)
            .font(.system(size: 10, weight: .semibold))
        }
        Text(entry.label)
          .font(.caption2.weight(.semibold))
      }
      .foregroundStyle(foreground)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background(background, in: Capsule())
      .overlay(Capsule().stroke(ADEColor.border.opacity(entry.kind == .quiet ? 0 : 0.18), lineWidth: 0.5))
    }
    .buttonStyle(ADEScaleButtonStyle())
    .disabled(isDisabled)
    .opacity(isDisabled && !isBusy ? 0.5 : 1)
  }

  private var foreground: Color {
    switch entry.kind {
    case .primary: return ADEColor.accent
    case .default: return ADEColor.textPrimary
    case .quiet: return ADEColor.textSecondary
    }
  }

  private var background: Color {
    switch entry.kind {
    case .primary: return ADEColor.accent.opacity(0.14)
    case .default: return ADEColor.surfaceBackground.opacity(0.5)
    case .quiet: return .clear
    }
  }
}

/// The rest of a row's actions, behind the system menu.
///
/// A `Menu` rather than more capsules: six controls on a phone row is not a
/// row. Each item still goes through ``PluginPaneStore/perform(_:extraArgs:)``,
/// so an overflow action confirms exactly as a visible one does.
private struct PluginVocabRowOverflowMenu: View {
  let actions: [PluginVocabListItemAction]
  @ObservedObject var store: PluginPaneStore

  var body: some View {
    Menu {
      ForEach(actions) { entry in
        Button {
          ADEHaptics.light()
          store.perform(entry.action)
        } label: {
          if let icon = PluginSymbol.symbol(entry.icon) {
            Label(entry.label, systemImage: icon)
          } else {
            Text(entry.label)
          }
        }
        .disabled(!store.canInvoke || store.isInFlight(entry.action))
      }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(ADEColor.surfaceBackground.opacity(0.5), in: Capsule())
        .overlay(Capsule().stroke(ADEColor.border.opacity(0.18), lineWidth: 0.5))
    }
    .accessibilityLabel("More actions")
    .disabled(!store.canInvoke)
  }
}

/// Tables render as scrolling text rows rather than a real grid — the
/// `WorkMarkdownTable` approach. A phone-width column grid is unreadable past
/// three columns, and the vocabulary allows eight.
private struct PluginVocabTableView: View {
  let table: PluginVocabTable

  var body: some View {
    let rows = table.rows ?? []
    if rows.isEmpty {
      PluginInlineEmptyText(text: table.emptyText ?? "No rows.")
    } else {
      ScrollView(.horizontal, showsIndicators: false) {
        VStack(spacing: 0) {
          header
          ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
            Divider().overlay(ADEColor.border.opacity(0.4))
            HStack(spacing: 0) {
              ForEach(table.columns) { column in
                cell(row[column.key] ?? "", column: column)
                  .font(.caption)
                  .foregroundStyle(ADEColor.textPrimary)
              }
            }
          }
        }
        .background(
          ADEColor.surfaceBackground.opacity(0.45),
          in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
      }
    }
  }

  private var header: some View {
    HStack(spacing: 0) {
      ForEach(table.columns) { column in
        cell(column.label, column: column)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .background(ADEColor.surfaceBackground.opacity(0.7))
      }
    }
  }

  private func cell(_ text: String, column: PluginVocabTableColumn) -> some View {
    Text(text)
      .lineLimit(2)
      .padding(10)
      .frame(minWidth: 110, alignment: column.alignsTrailing ? .trailing : .leading)
  }
}
