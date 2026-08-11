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
    if let icon = badge.icon, PluginSymbol.exists(icon) {
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

private struct PluginVocabListRow: View {
  let item: PluginVocabListItem
  @ObservedObject var store: PluginPaneStore

  var body: some View {
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
  }

  private var content: some View {
    HStack(spacing: 10) {
      if let icon = item.icon, PluginSymbol.exists(icon) {
        Image(systemName: icon)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(item.tone.color)
          .frame(width: 18)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(item.title)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .multilineTextAlignment(.leading)
        if let subtitle = item.subtitle {
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
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
