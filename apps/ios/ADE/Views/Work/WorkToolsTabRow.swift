import SwiftUI
import UIKit

/// One tab in the Browser sheet's list: title, address, badges, and the
/// close × with its undo window.
struct WorkToolsTabRow: View {
  let tab: WorkToolsBrowserTab
  /// The × was tapped and the close is waiting out its undo window.
  var isClosing = false
  /// This tab is the one in the live picture.
  var isWatched = false
  /// Nil when there is nothing to pick (no live view, or only one tab).
  var onSelect: (() -> Void)?
  /// Nil when this machine does not let the phone close tabs.
  var onClose: (() -> Void)?
  var onUndo: () -> Void = {}

  var body: some View {
    if isClosing {
      closingRow
    } else {
      HStack(alignment: .center, spacing: 10) {
        if let onSelect {
          Button(action: onSelect) { details }
            .buttonStyle(.plain)
            .accessibilityHint(isWatched ? "Shown in the live picture" : "Shows this tab in the live picture")
        } else {
          details
        }
        if let onClose {
          Button(action: onClose) {
            Image(systemName: "xmark")
              .font(.system(size: 11, weight: .bold))
              .foregroundStyle(ADEColor.textSecondary)
              .frame(width: 28, height: 28)
              .background(ADEKit.track, in: Circle())
              // A full-size target around the small circle.
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Close tab \(displayTitle)")
        }
      }
      .contentShape(Rectangle())
      .contextMenu {
        if let onClose {
          Button(role: .destructive, action: onClose) {
            Label("Close tab", systemImage: "xmark")
          }
        }
        if let url = tab.url, !url.isEmpty {
          Button {
            UIPasteboard.general.string = url
          } label: {
            Label("Copy link", systemImage: "link")
          }
        }
      }
    }
  }

  /// "Closing “Docs”… Undo", in place of the row, until the close is sent.
  private var closingRow: some View {
    HStack(spacing: 10) {
      Text("Closing “\(displayTitle)”…")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 0)
      Button("Undo", action: onUndo)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.accent)
        .buttonStyle(.plain)
        .accessibilityLabel("Undo closing \(displayTitle)")
    }
    .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
    .transition(.opacity)
  }

  private var details: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Text(displayTitle)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if isWatched {
          Image(systemName: "eye.fill")
            .font(.caption2)
            .foregroundStyle(ADEColor.accent)
            .accessibilityLabel("Watching")
        }
        if tab.active {
          ADEKitTag(text: "Active", color: ADEColor.accent)
        }
        if tab.recording {
          ADEKitTag(text: "Recording", color: ADEColor.danger)
        }
        Spacer(minLength: 0)
      }
      if let url = tab.url, !url.isEmpty {
        Text(url)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      if tab.ownerChatSessionId?.isEmpty == false {
        Text("Claimed by a chat in this lane")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }

  private var displayTitle: String {
    if let title = tab.title, !title.isEmpty { return title }
    return "Untitled tab"
  }
}
