import SwiftUI
import UIKit

// The app's one prompt box.
//
// Every surface that takes a prompt — a chat thread, the CTO, New Chat, the
// Hub, a new personal chat — draws this card. Folded, it is one glass capsule:
// [⋯ menu] [one-line field] [send / stop]. Focusing the field (or swiping up)
// unfolds it to the full composer: the field grows to its lines and the
// controls row (model, access, …) appears under it with the menu and send
// button. Losing focus folds it back. Each surface still owns what its
// buttons DO; only the chrome and the fold live here, so the surfaces cannot
// drift apart again.

/// Layout + fold + glass. Callers supply the pieces; `collapsed` is theirs
/// because some (the chat thread) drive it from their own draft state.
struct ADEGlassComposerCard<Accessory: View, Field: View, Menu: View, Controls: View, Trailing: View>: View {
  let collapsed: Bool
  /// Dictation takes over the row: the field and the controls step aside so
  /// the live waveform (inside `trailing`) can use the width.
  var isDictating = false
  /// One quiet line between the field and the controls row, expanded only.
  var hint: String? = nil
  let onFold: (WorkComposerFoldIntent) -> Void
  @ViewBuilder let accessory: () -> Accessory
  @ViewBuilder let field: () -> Field
  @ViewBuilder let menu: () -> Menu
  @ViewBuilder let controls: () -> Controls
  @ViewBuilder let trailing: () -> Trailing

  private var shape: RoundedRectangle {
    RoundedRectangle(cornerRadius: 24, style: .continuous)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      accessory()

      // One row in both states so the field keeps its identity (and its
      // `UITextView`) across the fold; the menu and send controls join it only
      // while folded.
      HStack(alignment: .center, spacing: 6) {
        if collapsed, !isDictating {
          menu()
        }
        if !(collapsed && isDictating) {
          field()
        }
        if collapsed {
          trailing()
        }
      }

      if !collapsed {
        if let hint {
          Text(hint)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        HStack(alignment: .center, spacing: 8) {
          if !isDictating {
            menu()
            controls()
            Spacer(minLength: 0)
          }
          trailing()
        }
        .transition(.opacity)
      }
    }
    .padding(.leading, collapsed ? 4 : 12)
    .padding(.trailing, collapsed ? 8 : 12)
    .padding(.vertical, collapsed ? 2 : 10)
    .workChatGlass(in: shape)
    // The gesture covers the card's chrome, not just the field, so the swipe
    // works from the padding and the controls row too.
    .contentShape(shape)
    .simultaneousGesture(
      DragGesture(minimumDistance: 12, coordinateSpace: .local)
        .onEnded { value in
          switch workComposerFoldGesture(translation: value.translation, collapsed: collapsed) {
          case .collapse: onFold(.collapse)
          case .expand: onFold(.expand)
          case .ignore: break
          }
        }
    )
    .accessibilityAction(named: collapsed ? "Expand composer" : "Collapse composer") {
      onFold(collapsed ? .expand : .collapse)
    }
  }
}

/// `ADEGlassComposerCard` around a plain text field, for the start-a-chat
/// surfaces (New Chat, Hub, new personal chat). Owns the fold, the field's
/// measured height, and dictation; the caller owns the draft, focus,
/// attachments, and what send does.
struct ADEPlainGlassComposer<Menu: View, Controls: View>: View {
  @Binding var text: String
  @Binding var isFocused: Bool
  @Binding var attachments: [WorkChatInputAttachment]
  let placeholder: String
  var acceptsPastedImages = true
  let sendEnabled: Bool
  let sending: Bool
  var sendAccessibilityLabel = "Send"
  var disabledSendAccessibilityLabel: String? = "Enter a message to send"
  let dictationTargetId: String
  let onSend: () -> Void
  /// Receives "start dictation" so the ⋯ menu's Dictate row can reach the
  /// coordinator this composer owns.
  @ViewBuilder let menu: (_ startDictation: @escaping () -> Void) -> Menu
  @ViewBuilder let controls: () -> Controls

  @State private var collapsed = true
  @State private var measuredHeight: CGFloat = 24
  @State private var isDictating = false
  @StateObject private var dictationCoordinator = DictationInsertionCoordinator()

  private var foldedHeight: CGFloat {
    workComposerFoldedFieldHeight(lineHeight: UIFont.preferredFont(forTextStyle: .body).lineHeight)
  }

  var body: some View {
    ADEGlassComposerCard(
      collapsed: collapsed,
      isDictating: isDictating,
      onFold: applyFold,
      accessory: {
        if !attachments.isEmpty {
          WorkChatInputAttachmentTray(
            attachments: $attachments,
            compact: collapsed,
            onExpand: { applyFold(.expand) }
          )
          .fixedSize(horizontal: false, vertical: true)
        }
      },
      field: {
        WorkPlainComposerTextView(
          text: $text,
          isFocused: $isFocused,
          measuredHeight: $measuredHeight,
          placeholder: placeholder,
          acceptsPastedImages: acceptsPastedImages,
          onPasteImages: { images in
            workChatInputPasteImages(images, into: $attachments)
          }
        )
        // Measured height, clipped to one whole line while folded, so folding
        // a long draft animates one frame instead of re-laying the text out.
        .frame(height: measuredHeight)
        .frame(height: collapsed ? min(measuredHeight, foldedHeight) : measuredHeight, alignment: .top)
        .clipped()
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .onTapGesture { if collapsed { applyFold(.expand) } }
      },
      menu: {
        menu { dictationCoordinator.requestStart() }
      },
      controls: {
        controls()
        DictationRawUndoChip(coordinator: dictationCoordinator, draft: $text)
      },
      trailing: {
        DictationMicButton(
          draft: $text,
          coordinator: dictationCoordinator,
          targetId: dictationTargetId,
          showsIdleButton: false,
          onRecordingChange: { isDictating = $0 }
        )
        .frame(maxWidth: isDictating ? .infinity : nil)

        if !isDictating {
          ADEComposerSendButton(
            enabled: sendEnabled,
            sending: sending,
            accessibilityLabelText: sendAccessibilityLabel,
            disabledAccessibilityLabel: disabledSendAccessibilityLabel,
            action: onSend
          )
        }
      }
    )
    // Typing is the way out of the folded state; putting the keyboard away (a
    // scroll, a sheet, the swipe) folds it back.
    .onChange(of: isFocused) { _, focused in
      guard collapsed == focused else { return }
      withAnimation(workComposerFoldAnimation) { collapsed = !focused }
    }
    .onAppear { collapsed = !isFocused }
  }

  private func applyFold(_ intent: WorkComposerFoldIntent) {
    let next = workComposerFoldTransition(
      WorkComposerFoldState(collapsed: collapsed, focused: isFocused),
      intent: intent,
      canCompose: true
    )
    if next.collapsed != collapsed {
      withAnimation(workComposerFoldAnimation) { collapsed = next.collapsed }
    }
    if next.focused != isFocused { isFocused = next.focused }
  }
}
