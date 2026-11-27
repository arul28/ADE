import SwiftUI
import UIKit

// Text selection on an agent reply: copy the whole reply, copy the part that
// was long-pressed, or open the reply in a sheet where any range can be
// selected, copied, or commented on. The text and the comment anchor are
// built in `WorkMessageSelectableDocument.swift`.

// MARK: - Presenting

/// What a long-press asked for. The session view turns it into a sheet,
/// reading the reply's text at that moment.
struct WorkMessageTextSelectionIntent: Identifiable, Equatable {
  let id = UUID()
  let messageId: String
  /// The long-pressed block of a split reply: selected when the sheet opens.
  let blockId: String?
  /// Open straight into the comment composer on `blockId`'s text.
  let startComment: Bool
}

/// One presenter per chat, held by the session view, so no transcript row
/// carries a sheet of its own (the same shape as `WorkOutputViewerModel`).
final class WorkMessageTextSelectionModel: ObservableObject {
  @Published var intent: WorkMessageTextSelectionIntent?
  /// Whether this chat's host can take a new comment. Rows read it when the
  /// long-press menu is drawn; the sheet checks it again.
  var canComment = false

  @MainActor
  func open(messageId: String, blockId: String? = nil, startComment: Bool = false) {
    intent = WorkMessageTextSelectionIntent(messageId: messageId, blockId: blockId, startComment: startComment)
  }
}

private struct WorkMessageTextSelectionKey: EnvironmentKey {
  static let defaultValue: WorkMessageTextSelectionModel? = nil
}

extension EnvironmentValues {
  /// Nil on surfaces with no chat behind them (launch previews, cloud
  /// placeholders); the menu then offers copy only.
  var workMessageTextSelection: WorkMessageTextSelectionModel? {
    get { self[WorkMessageTextSelectionKey.self] }
    set { self[WorkMessageTextSelectionKey.self] = newValue }
  }
}

/// The long-press menu's text items for an agent reply.
struct WorkMessageTextMenuItems: View {
  let messageId: String
  /// The long-pressed block of a split reply, nil for a whole-reply row.
  let block: WorkMarkdownBlock?
  let onCopyMessage: () -> Void
  @Environment(\.workMessageTextSelection) private var selection

  var body: some View {
    Button(action: onCopyMessage) {
      Label("Copy message", systemImage: "doc.on.doc")
    }
    if let block, block.kind != .rule {
      Button {
        // The sheet's own layout of this block, built on tap rather than
        // with every transcript row.
        UIPasteboard.general.string = workSelectableMessageDocument(blocks: [block]).string
        ADEHaptics.light()
      } label: {
        Label("Copy this part", systemImage: "text.badge.checkmark")
      }
    }
    if let selection {
      Button {
        selection.open(messageId: messageId, blockId: block?.id)
      } label: {
        Label("Select text", systemImage: "selection.pin.in.out")
      }
      if selection.canComment {
        Button {
          selection.open(messageId: messageId, blockId: block?.id, startComment: true)
        } label: {
          Label(block == nil ? "Comment…" : "Comment on this part", systemImage: "text.bubble")
        }
      }
    }
  }
}

// MARK: - The sheet

struct WorkThreadCommentDraft {
  /// Made once per comment the person is writing: a retry after a lost
  /// answer repeats it, and the host returns the comment it already made.
  let clientId: String
  let messageKey: String
  let messageExcerpt: String
  let anchor: WorkThreadCommentTextAnchor
  let body: String
}

struct WorkMessageTextSelectionSheet: View {
  let intent: WorkMessageTextSelectionIntent
  let markdown: String
  let monospaced: Bool
  /// Nil when this reply cannot take a comment: the host predates comments,
  /// the reply is still streaming, or the reply has no key desktop shares.
  let commentKey: String?
  /// Why commenting is off, shown when the person asked to comment.
  let commentUnavailableReason: String?
  let onCreateComment: (@MainActor (WorkThreadCommentDraft) async throws -> Void)?
  let onCommentAdded: @MainActor () -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var document: WorkSelectableMessageDocument?
  @State private var selection = NSRange(location: 0, length: 0)
  @State private var initialSelection: NSRange?
  @State private var commentAnchor: WorkThreadCommentTextAnchor?
  @State private var note = ""
  @State private var saving = false
  @State private var errorMessage: String?
  @State private var copiedFeedback = false
  @State private var draftClientId = workThreadCommentClientId()
  @FocusState private var noteFocused: Bool

  private var canComment: Bool { commentKey != nil && onCreateComment != nil }

  var body: some View {
    NavigationStack {
      Group {
        if let document {
          WorkSelectableTextView(
            attributed: document.attributed,
            initialSelection: initialSelection,
            canComment: canComment,
            selection: $selection,
            onComment: { range in beginComment(range: range) }
          )
          .ignoresSafeArea(.container, edges: .bottom)
        } else {
          ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .background(ADEColor.pageBackground)
      .navigationTitle(commentAnchor == nil ? "Select text" : "Comment")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
        ToolbarItem(placement: .primaryAction) {
          Button {
            UIPasteboard.general.string = markdown
            flashCopied()
          } label: {
            Label("Copy all", systemImage: copiedFeedback ? "checkmark" : "doc.on.doc")
          }
          .accessibilityLabel("Copy the whole message")
        }
      }
      // Floats over the text instead of taking a bar of its own; the text
      // view leaves room under its last line for it.
      .overlay(alignment: .bottom) {
        floatingControls
          .frame(maxWidth: 560)
          .padding(.horizontal, 16)
          .padding(.bottom, 12)
      }
    }
    .onAppear(perform: prepare)
    .adeInspectable("Work.Chat.TextSelectionSheet", metadata: ["messageId": intent.messageId])
  }

  private func prepare() {
    guard document == nil else { return }
    let built = workSelectableMessageDocument(markdown: markdown, monospaced: monospaced)
    document = built
    if let blockId = intent.blockId, let range = built.blockRanges[blockId], range.length > 0 {
      initialSelection = range
      selection = range
      if intent.startComment { beginComment(range: range, in: built) }
    }
  }

  // MARK: Floating controls

  @ViewBuilder
  private var floatingControls: some View {
    VStack(spacing: 8) {
      if let commentNotice {
        Text(commentNotice)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .glassEffect(in: Capsule(style: .continuous))
      }
      selectionControls
    }
  }

  /// Why "Comment" did nothing: the person asked for it on a reply that cannot
  /// take one (still streaming, or no key desktop shares).
  private var commentNotice: String? {
    guard intent.startComment, !canComment else { return nil }
    return commentUnavailableReason ?? "This reply can't take comments."
  }

  @ViewBuilder
  private var selectionControls: some View {
    Group {
      if let commentAnchor {
        composer(commentAnchor)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      } else if selection.length > 0 {
        selectionPill
          .transition(.scale(scale: 0.9).combined(with: .opacity))
      } else {
        Text(hintText)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .glassEffect(in: Capsule(style: .continuous))
          .transition(.opacity)
      }
    }
    .animation(.snappy(duration: 0.22), value: selection.length > 0)
    .animation(.snappy(duration: 0.22), value: commentAnchor)
  }

  /// Copy and Comment for the current selection: one small glass capsule,
  /// the shape the PR diff stepper uses.
  private var selectionPill: some View {
    HStack(spacing: 0) {
      Button {
        copySelection()
      } label: {
        Label(copiedFeedback ? "Copied" : "Copy", systemImage: copiedFeedback ? "checkmark" : "doc.on.doc")
          .padding(.horizontal, 16)
          .frame(height: 44)
      }
      if canComment {
        Rectangle()
          .fill(ADEColor.border)
          .frame(width: 1, height: 20)
        Button {
          beginComment(range: selection)
        } label: {
          Label("Comment", systemImage: "text.bubble")
            .padding(.horizontal, 16)
            .frame(height: 44)
        }
      }
    }
    .buttonStyle(.plain)
    .font(.system(size: 15, weight: .semibold))
    .foregroundStyle(ADEColor.textPrimary)
    .glassEffect(in: Capsule(style: .continuous))
  }

  private var hintText: String {
    if let errorMessage { return errorMessage }
    if copiedFeedback { return "Copied the whole message" }
    if canComment { return "Press and drag to select, then copy or comment" }
    return "Press and drag to select text"
  }

  private func composer(_ anchor: WorkThreadCommentTextAnchor) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 8) {
        RoundedRectangle(cornerRadius: 1.5)
          .fill(ADEColor.accent)
          .frame(width: 3)
        Text(anchor.quote)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .fixedSize(horizontal: false, vertical: true)
      if anchor.quote.count > workThreadCommentQuoteChars {
        Text("Only the first \(workThreadCommentQuoteChars) characters of the selection are kept.")
          .font(.caption)
          .foregroundStyle(ADEColor.warning)
      }
      TextField("Note for the agent", text: $note, axis: .vertical)
        .font(.system(size: 15))
        .lineLimit(1...5)
        .textFieldStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(ADEColor.recessedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .focused($noteFocused)
        .disabled(saving)
        .accessibilityIdentifier("Work.Chat.TextSelectionSheet.Note")
      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
      }
      HStack(spacing: 8) {
        Text("Sent with your next message")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
        Spacer(minLength: 4)
        Button("Cancel") {
          commentAnchor = nil
          note = ""
          errorMessage = nil
        }
        .buttonStyle(ADEKitButtonStyle())
        .disabled(saving)
        Button {
          Task { await save(anchor) }
        } label: {
          if saving {
            ProgressView().controlSize(.small)
          } else {
            Text("Add")
          }
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true))
        .disabled(saving || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityLabel("Add comment")
      }
    }
    .padding(14)
    .glassEffect(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
  }

  // MARK: Actions

  private func copySelection() {
    guard let document, selection.length > 0 else { return }
    UIPasteboard.general.string = document.text(in: selection)
    flashCopied()
  }

  private func flashCopied() {
    ADEHaptics.light()
    copiedFeedback = true
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(1.4))
      copiedFeedback = false
    }
  }

  private func beginComment(range: NSRange, in built: WorkSelectableMessageDocument? = nil) {
    guard canComment, let document = built ?? document else { return }
    guard let anchor = workThreadCommentAnchor(in: document, range: range) else {
      errorMessage = "Select some words of the reply to comment on."
      return
    }
    errorMessage = nil
    if anchor != commentAnchor { draftClientId = workThreadCommentClientId() }
    commentAnchor = anchor
    // Focus after the card has animated in; focusing in the same pass as
    // the sheet's own presentation is dropped.
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(350))
      noteFocused = true
    }
  }

  private func save(_ anchor: WorkThreadCommentTextAnchor) async {
    guard let commentKey, let onCreateComment, let document else { return }
    let body = note.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !body.isEmpty else { return }
    saving = true
    errorMessage = nil
    defer { saving = false }
    do {
      try await onCreateComment(WorkThreadCommentDraft(
        clientId: draftClientId,
        messageKey: commentKey,
        messageExcerpt: workThreadCommentExcerpt(document),
        anchor: WorkThreadCommentTextAnchor(
          quote: String(anchor.quote.prefix(workThreadCommentQuoteChars)),
          prefix: anchor.prefix,
          suffix: anchor.suffix
        ),
        body: body
      ))
      ADEHaptics.success()
      onCommentAdded()
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }
}

// MARK: - UITextView

/// Keeps lines at a readable length on a wide screen (an unfolded Duo, an
/// iPad) by centring the text column, and leaves room under the last line so
/// the floating controls never cover it.
private final class WorkReadableTextView: UITextView {
  static let maxColumnWidth: CGFloat = 680

  override func layoutSubviews() {
    let side = max(16, (bounds.width - Self.maxColumnWidth) / 2)
    let insets = UIEdgeInsets(top: 12, left: side, bottom: 160, right: side)
    if textContainerInset != insets { textContainerInset = insets }
    super.layoutSubviews()
  }
}

/// A read-only `UITextView`: SwiftUI `Text` on iOS selects a whole view at a
/// time, never a range, which is why the transcript itself cannot do this.
private struct WorkSelectableTextView: UIViewRepresentable {
  let attributed: NSAttributedString
  let initialSelection: NSRange?
  let canComment: Bool
  @Binding var selection: NSRange
  let onComment: (NSRange) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> UITextView {
    let view = WorkReadableTextView()
    view.isEditable = false
    view.isSelectable = true
    view.isScrollEnabled = true
    view.alwaysBounceVertical = true
    view.backgroundColor = .clear
    view.adjustsFontForContentSizeCategory = true
    view.dataDetectorTypes = []
    view.attributedText = attributed
    context.coordinator.shownText = attributed
    view.delegate = context.coordinator
    view.accessibilityIdentifier = "Work.Chat.TextSelectionSheet.Text"
    if let initialSelection {
      // Selection handles show only on a first responder, and only once the
      // view is in a window.
      DispatchQueue.main.async {
        view.becomeFirstResponder()
        view.selectedRange = initialSelection
        view.scrollRangeToVisible(initialSelection)
      }
    }
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    context.coordinator.parent = self
    // By identity: text storage adds attributes (fallback fonts for emoji),
    // so the text read back never equals the source, and reassigning it on
    // every update would drop the selection.
    if context.coordinator.shownText !== attributed {
      context.coordinator.shownText = attributed
      view.attributedText = attributed
    }
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: WorkSelectableTextView
    /// The text last handed to the view.
    var shownText: NSAttributedString?

    init(_ parent: WorkSelectableTextView) {
      self.parent = parent
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
      let range = textView.selectedRange
      // Never write SwiftUI state inside its own update pass.
      DispatchQueue.main.async { [weak self] in
        guard let self, self.parent.selection != range else { return }
        self.parent.selection = range
      }
    }

    func textView(
      _ textView: UITextView,
      editMenuForTextIn range: NSRange,
      suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
      guard parent.canComment, range.length > 0 else { return UIMenu(children: suggestedActions) }
      let comment = UIAction(title: "Comment", image: UIImage(systemName: "text.bubble")) { [weak self] _ in
        self?.parent.onComment(range)
      }
      return UIMenu(children: [comment] + suggestedActions)
    }
  }
}

/// A client id for a new thread comment (`normalizeThreadCommentClientId`'s
/// alphabet).
func workThreadCommentClientId() -> String {
  "ios-\(UUID().uuidString.lowercased())"
}
