import SwiftUI
import UIKit

// Text selection on an agent reply: copy the whole reply, copy the part that
// was long-pressed, or open the reply in a sheet where any range can be
// selected, copied, or commented on. A comment made here is the same thread
// comment the desktop makes from its selection toolbar
// (`apps/desktop/src/renderer/components/chat/threadCommentAnchors.ts`): the
// anchor is the selected visible text, whitespace-collapsed, plus up to
// `workThreadCommentContextChars` of context on each side.

/// `THREAD_COMMENT_CONTEXT_CHARS` in `apps/desktop/src/shared/threadComments.ts`.
let workThreadCommentContextChars = 32
/// `MAX_THREAD_COMMENT_EXCERPT_CHARS`.
let workThreadCommentExcerptChars = 120
/// `MAX_THREAD_COMMENT_QUOTE_CHARS`. The host caps a longer quote; the sheet
/// says so before the comment is sent rather than after.
let workThreadCommentQuoteChars = 2_000

/// The key desktop hangs a comment off: `sceneRowIdentity` in
/// `apps/desktop/src/shared/chatScene.ts`. Nil when the event names neither a
/// message nor a turn item, where desktop falls back to a render key the phone
/// cannot know, so the phone offers no comment there.
func workThreadCommentMessageKey(messageId: String?, turnId: String?, itemId: String?) -> String? {
  if let messageId = nonEmptyTrimmed(messageId) { return "message:\(messageId)" }
  if let turnId = nonEmptyTrimmed(turnId), let itemId = nonEmptyTrimmed(itemId) {
    return "item:\(turnId):\(itemId)"
  }
  return nil
}

// MARK: - The selectable document

/// Characters drawn for reading but not part of the reply's text: list
/// markers. Desktop draws them with CSS, so they are not in its text either,
/// and a quote that held one would not be found there.
private let workSelectionIgnoredAttribute = NSAttributedString.Key("ade.threadCommentIgnore")

/// One reply laid out as plain, selectable text, with each markdown block's
/// range so the long-pressed block can be selected on open.
struct WorkSelectableMessageDocument {
  let attributed: NSAttributedString
  /// Block id (`WorkMarkdownBlock.id`) to its range in `attributed`.
  let blockRanges: [String: NSRange]

  var string: String { attributed.string }

  func text(in range: NSRange) -> String {
    let ns = attributed.string as NSString
    let clamped = NSIntersectionRange(range, NSRange(location: 0, length: ns.length))
    return ns.substring(with: clamped)
  }
}

private enum WorkSelectionFont {
  static var body: UIFont { UIFont.preferredFont(forTextStyle: .body) }
  static var mono: UIFont {
    UIFontMetrics(forTextStyle: .callout).scaledFont(
      for: .monospacedSystemFont(ofSize: 15, weight: .regular)
    )
  }

  static func heading(_ level: Int) -> UIFont {
    let style: UIFont.TextStyle = level <= 1 ? .title2 : level == 2 ? .title3 : .headline
    let base = UIFont.preferredFont(forTextStyle: style)
    return UIFont(descriptor: base.fontDescriptor.withSymbolicTraits(.traitBold) ?? base.fontDescriptor, size: 0)
  }

  static func with(_ font: UIFont, traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
    guard let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(traits)) else {
      return font
    }
    return UIFont(descriptor: descriptor, size: 0)
  }
}

/// Lays a reply out for the selection sheet. `monospaced` is the transcript's
/// whole-message monospace rendering (a file tree, raw output).
func workSelectableMessageDocument(markdown: String, monospaced: Bool = false) -> WorkSelectableMessageDocument {
  let output = NSMutableAttributedString()
  let paragraph = NSMutableParagraphStyle()
  paragraph.paragraphSpacing = 12
  paragraph.lineSpacing = 2
  // Table cells are tab-separated; fixed stops keep the columns aligned.
  paragraph.tabStops = (1...8).map { NSTextTab(textAlignment: .left, location: CGFloat($0) * 104) }
  paragraph.defaultTabInterval = 104
  let baseAttributes: [NSAttributedString.Key: Any] = [
    .font: WorkSelectionFont.body,
    .foregroundColor: UIColor.label,
    .paragraphStyle: paragraph,
  ]
  if monospaced {
    output.append(NSAttributedString(string: markdown, attributes: baseAttributes.merging([.font: WorkSelectionFont.mono]) { $1 }))
    return WorkSelectableMessageDocument(attributed: output, blockRanges: [:])
  }

  func appendInline(_ text: String, font: UIFont = WorkSelectionFont.body, to target: NSMutableAttributedString) {
    let parsed = markdownAttributedString(text)
    for run in parsed.runs {
      let piece = String(parsed[run.range].characters)
      var attributes = baseAttributes
      let intent = run.inlinePresentationIntent ?? []
      var runFont = font
      if intent.contains(.code) {
        runFont = WorkSelectionFont.mono
        attributes[.backgroundColor] = UIColor.secondarySystemFill
      }
      if intent.contains(.stronglyEmphasized) { runFont = WorkSelectionFont.with(runFont, traits: .traitBold) }
      if intent.contains(.emphasized) { runFont = WorkSelectionFont.with(runFont, traits: .traitItalic) }
      if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      if let link = run.link { attributes[.link] = link }
      attributes[.font] = runFont
      target.append(NSAttributedString(string: piece, attributes: attributes))
    }
  }

  func appendPlain(_ text: String, font: UIFont = WorkSelectionFont.body, ignored: Bool = false) {
    var attributes = baseAttributes
    attributes[.font] = font
    if ignored {
      attributes[workSelectionIgnoredAttribute] = true
      attributes[.foregroundColor] = UIColor.secondaryLabel
    }
    output.append(NSAttributedString(string: text, attributes: attributes))
  }

  var blockRanges: [String: NSRange] = [:]
  let blocks = parseMarkdownBlocks(markdown)
  for (index, block) in blocks.enumerated() {
    // One line break: the paragraph spacing is the gap between blocks.
    if index > 0 { appendPlain("\n") }
    let start = output.length
    switch block.kind {
    case .paragraph(let text):
      appendInline(text, to: output)
    case .heading(let level, let text):
      appendInline(text, font: WorkSelectionFont.heading(level), to: output)
    case .list(let items):
      for (itemIndex, item) in items.enumerated() {
        if itemIndex > 0 { appendPlain("\n") }
        let indent = String(repeating: "    ", count: item.depth)
        if !indent.isEmpty { appendPlain(indent, ignored: true) }
        appendPlain("\(item.markerLabel ?? "  ") ", ignored: true)
        appendInline(item.text, to: output)
      }
    case .blockquote(let lines):
      for (lineIndex, line) in lines.enumerated() {
        if lineIndex > 0 { appendPlain("\n") }
        appendPlain("\u{258E} ", ignored: true)
        appendInline(line, font: WorkSelectionFont.with(WorkSelectionFont.body, traits: .traitItalic), to: output)
      }
    case .table(let headers, let rows):
      // Cells are tab-separated: a tab collapses to the same single space
      // desktop's text walk puts between two cells.
      for (rowIndex, row) in ([headers] + rows).enumerated() where !row.isEmpty {
        if output.length > start { appendPlain("\n") }
        for (cellIndex, cell) in row.enumerated() {
          if cellIndex > 0 { appendPlain("\t") }
          appendInline(cell, font: rowIndex == 0 ? WorkSelectionFont.with(WorkSelectionFont.body, traits: .traitBold) : WorkSelectionFont.body, to: output)
        }
      }
    case .code(_, let code):
      appendPlain(code, font: WorkSelectionFont.mono)
    case .rule:
      appendPlain("\u{2014}\u{2014}\u{2014}", ignored: true)
    case .proofCitation(_, let caption):
      appendPlain(caption.isEmpty ? "[proof]" : caption, ignored: caption.isEmpty)
    case .proofCompare(let compare):
      appendPlain(compare.caption.isEmpty ? "[\(compare.before.label) \u{2192} \(compare.after.label)]" : compare.caption)
    }
    blockRanges[block.id] = NSRange(location: start, length: output.length - start)
  }
  return WorkSelectableMessageDocument(attributed: output, blockRanges: blockRanges)
}

/// The plain text of one transcript block, for "Copy this part". Markers and
/// table layout stay, since this is what a person pastes.
func workSelectableBlockText(_ block: WorkMarkdownBlock) -> String {
  switch block.kind {
  case .paragraph(let text), .heading(_, let text):
    return String(markdownAttributedString(text).characters)
  case .list(let items):
    return items.map { item in
      String(repeating: "    ", count: item.depth)
        + "\(item.markerLabel ?? " ") "
        + String(markdownAttributedString(item.text).characters)
    }
    .joined(separator: "\n")
  case .blockquote(let lines):
    return lines.map { "> " + String(markdownAttributedString($0).characters) }.joined(separator: "\n")
  case .table(let headers, let rows):
    return ([headers] + rows).filter { !$0.isEmpty }.map { $0.joined(separator: "\t") }.joined(separator: "\n")
  case .code(_, let code):
    return code
  case .rule:
    return ""
  case .proofCitation(_, let caption):
    return caption
  case .proofCompare(let compare):
    return compare.caption
  }
}

// MARK: - The anchor

struct WorkThreadCommentTextAnchor: Equatable {
  let quote: String
  let prefix: String
  let suffix: String
}

/// The reply's text with whitespace runs collapsed to one space and the
/// ignored characters left out, as desktop's `collapsedTextOf` reads the DOM.
/// `offsets[i]` is the UTF-16 offset in the document of collapsed char `i`.
private func workCollapsedSelectionText(_ document: WorkSelectableMessageDocument) -> (text: [Character], offsets: [Int]) {
  let attributed = document.attributed
  var ignored = IndexSet()
  attributed.enumerateAttribute(
    workSelectionIgnoredAttribute,
    in: NSRange(location: 0, length: attributed.length)
  ) { value, range, _ in
    if value != nil { ignored.insert(integersIn: range.location..<(range.location + range.length)) }
  }
  var text: [Character] = []
  var offsets: [Int] = []
  var lastWasSpace = true
  var offset = 0
  for character in attributed.string {
    let width = character.utf16.count
    defer { offset += width }
    if ignored.contains(offset) { continue }
    if character.isWhitespace {
      if lastWasSpace { continue }
      text.append(" ")
      lastWasSpace = true
    } else {
      text.append(character)
      lastWasSpace = false
    }
    offsets.append(offset)
  }
  return (text, offsets)
}

/// The first 120 collapsed characters, so the agent knows which reply.
func workThreadCommentExcerpt(_ document: WorkSelectableMessageDocument) -> String {
  let collapsed = workCollapsedSelectionText(document).text
  return String(collapsed.prefix(workThreadCommentExcerptChars)).trimmingCharacters(in: .whitespaces)
}

/// The anchor for a selected range of the document, or nil when the range
/// holds no reply text (only markers or space).
func workThreadCommentAnchor(
  in document: WorkSelectableMessageDocument,
  range: NSRange
) -> WorkThreadCommentTextAnchor? {
  guard range.length > 0 else { return nil }
  let collapsed = workCollapsedSelectionText(document)
  func index(atOrAfter utf16Offset: Int) -> Int {
    // Offsets are increasing, so the first one at or past the point is a
    // binary search away.
    var low = 0
    var high = collapsed.offsets.count
    while low < high {
      let mid = (low + high) / 2
      if collapsed.offsets[mid] < utf16Offset { low = mid + 1 } else { high = mid }
    }
    return low
  }
  var start = index(atOrAfter: range.location)
  var end = index(atOrAfter: range.location + range.length)
  while start < end, collapsed.text[start] == " " { start += 1 }
  while end > start, collapsed.text[end - 1] == " " { end -= 1 }
  guard end > start else { return nil }
  let context = workThreadCommentContextChars
  return WorkThreadCommentTextAnchor(
    quote: String(collapsed.text[start..<end]),
    prefix: String(collapsed.text[max(0, start - context)..<start]),
    suffix: String(collapsed.text[end..<min(collapsed.text.count, end + context)])
  )
}

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
    if let block {
      let text = workSelectableBlockText(block)
      if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Button {
          UIPasteboard.general.string = text
          ADEHaptics.light()
        } label: {
          Label("Copy this part", systemImage: "text.badge.checkmark")
        }
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
          selection.open(messageId: messageId, blockId: block?.id, startComment: block != nil)
        } label: {
          Label(block == nil ? "Comment…" : "Comment on this part", systemImage: "text.bubble")
        }
      }
    }
  }
}

// MARK: - The sheet

struct WorkThreadCommentDraft {
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
  /// Why commenting is off, shown under the text when the person asks.
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
    if view.attributedText != attributed {
      view.attributedText = attributed
    }
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: WorkSelectableTextView

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
