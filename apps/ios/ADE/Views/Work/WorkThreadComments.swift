import SwiftUI

// MARK: - Wire formats
//
// Twins of `apps/desktop/src/shared/threadComments.ts` (the `<ade-review>`
// block a send carries) and `apps/desktop/src/shared/chatOutputContext.ts`
// (the `<ade-chat-context>` quote the desktop "Add to chat" sends). Keep the
// tags, preambles and the comment layout in step with those files.

let workThreadReviewOpenTag = "<ade-review>"
let workThreadReviewCloseTag = "</ade-review>"
let workChatContextOpenTag = "<ade-chat-context>"
let workChatContextCloseTag = "</ade-chat-context>"
/// Current preamble first, then the ones older messages were sent with.
let workChatContextPreambles = [
  "The user quoted this from your earlier output. The text that follows this block, up to the next quote, is their reply to it:",
  "The user highlighted the following text from your previous output and added it as context:",
]

func workThreadCommentsHaveSendable(_ comments: [ChatThreadComment]) -> Bool {
  comments.contains { $0.includeInNextSend }
}

/// "3 comments · 2 go with your next message".
func workThreadCommentsHeaderText(_ comments: [ChatThreadComment]) -> String {
  let total = comments.count
  let included = comments.filter(\.includeInNextSend).count
  let countText = workThreadCommentCountLabel(total)
  if included == 0 { return "\(countText) · none go with your next message" }
  if included == total {
    return total == 1
      ? "\(countText) · goes with your next message"
      : "\(countText) · all go with your next message"
  }
  return "\(countText) · \(included) go\(included == 1 ? "es" : "") with your next message"
}

struct WorkThreadReviewComment: Equatable {
  let n: Int
  let source: String
  let quote: String
  let note: String
}

struct WorkParsedThreadReview: Equatable {
  let comments: [WorkThreadReviewComment]
  /// The block itself, open tag through close tag.
  let block: String
  /// The message text after the block, leading whitespace removed.
  let rest: String
}

private let workThreadReviewCommentRegex = try! NSRegularExpression(
  pattern: #"<comment n="(\d+)" source="([^"]*)">\n<quote>([\s\S]*?)</quote>\n<note>([\s\S]*?)</note>\n</comment>"#
)

/// Undoes the host's guard (U+200B after a block tag name) for display.
private let workThreadReviewNeutralizedRegex = try! NSRegularExpression(
  pattern: "<(/?)(ade-review|comment|quote|note)\u{200B}",
  options: [.caseInsensitive]
)

private func workRestoreThreadReviewText(_ value: String) -> String {
  guard value.contains("\u{200B}") else { return value }
  let range = NSRange(value.startIndex..., in: value)
  return workThreadReviewNeutralizedRegex.stringByReplacingMatches(
    in: value,
    range: range,
    withTemplate: "<$1$2"
  )
}

/// "1 comment", "3 comments" — the same label the desktop uses.
func workThreadCommentCountLabel(_ count: Int) -> String {
  "\(count) comment\(count == 1 ? "" : "s")"
}

/// Cheap test, safe on every transcript row: the block must lead the text.
func workTextStartsWithThreadReview(_ text: String) -> Bool {
  text.drop(while: { $0.isWhitespace }).hasPrefix(workThreadReviewOpenTag)
}

/// Reads a leading review block back for display; nil when the text has none
/// or the block holds no comment in the expected layout.
func workParseThreadReviewBlock(_ text: String) -> WorkParsedThreadReview? {
  guard workTextStartsWithThreadReview(text),
        let open = text.range(of: workThreadReviewOpenTag),
        let close = text.range(of: workThreadReviewCloseTag, range: open.upperBound..<text.endIndex)
  else { return nil }
  let inner = String(text[open.upperBound..<close.lowerBound])
  let nsInner = inner as NSString
  let matches = workThreadReviewCommentRegex.matches(
    in: inner,
    range: NSRange(location: 0, length: nsInner.length)
  )
  let comments: [WorkThreadReviewComment] = matches.compactMap { match in
    guard match.numberOfRanges == 5 else { return nil }
    func group(_ index: Int) -> String {
      let range = match.range(at: index)
      return range.location == NSNotFound ? "" : nsInner.substring(with: range)
    }
    return WorkThreadReviewComment(
      n: Int(group(1)) ?? 0,
      source: group(2),
      quote: workRestoreThreadReviewText(group(3)),
      note: workRestoreThreadReviewText(group(4))
    )
  }
  guard !comments.isEmpty else { return nil }
  let rest = String(text[close.upperBound...].drop(while: { $0.isWhitespace }))
  return WorkParsedThreadReview(
    comments: comments,
    block: String(text[open.lowerBound..<close.upperBound]),
    rest: rest
  )
}

/// The typed words of a message whose text may lead with a review block.
func workTextWithoutLeadingThreadReview(_ text: String) -> String {
  workParseThreadReviewBlock(text)?.rest ?? text
}

/// What a `user_message` row shows. The host sets `displayText` to what the
/// user typed and `text` to what the agent got; for a send that carried
/// thread comments, `text` leads with the review block. Keeping that block
/// ahead of the typed words lets the bubble draw the comment card, and the
/// echo key (`normalizedWorkLocalEchoText`) strips it again.
func workUserMessageShownText(text: String, displayText: String?) -> String {
  guard let typed = displayText, !typed.isEmpty else { return text }
  guard !workTextStartsWithThreadReview(typed),
        let review = workParseThreadReviewBlock(text)
  else { return typed }
  return review.block + "\n\n" + typed
}

enum WorkUserMessagePart: Equatable {
  case text(String)
  /// A desktop "Add to chat" quote.
  case quote(String)
  /// The comments a send carried.
  case review([WorkThreadReviewComment])
}

func workUserMessageHasStructuredBlocks(_ text: String) -> Bool {
  workTextStartsWithThreadReview(text) || text.contains(workChatContextOpenTag)
}

private func workChatContextQuote(fromInner rawInner: String) -> String {
  var inner = Substring(rawInner)
  if inner.hasPrefix("\n") { inner = inner.dropFirst() }
  if inner.hasSuffix("\n") { inner = inner.dropLast() }
  for preamble in workChatContextPreambles where inner.hasPrefix(preamble) {
    inner = inner.dropFirst(preamble.count).drop(while: { $0 == "\n" })
    break
  }
  return String(inner)
    .replacingOccurrences(of: "ade-chat-context\u{200B}", with: "ade-chat-context")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Splits a user message into its comment card, quotes and typed text, in
/// order. Nil when it has neither a review block nor a quote, so ordinary
/// messages keep their usual rendering.
/// What VoiceOver reads for a user message: comment cards and quotes as
/// words, never their raw tags; nil for a message with neither.
func workUserMessageAccessibilityText(_ text: String) -> String? {
  guard let parts = workUserMessageParts(text) else { return nil }
  return parts.map { part -> String in
    switch part {
    case .text(let value):
      return value
    case .quote(let quote):
      return "Quote: \(quote)."
    case .review(let comments):
      let items = comments.map { "On \"\($0.quote)\": \($0.note)" }
      return "\(workThreadCommentCountLabel(comments.count)). " + items.joined(separator: ". ") + "."
    }
  }
  .joined(separator: " ")
}

func workUserMessageParts(_ text: String) -> [WorkUserMessagePart]? {
  guard workUserMessageHasStructuredBlocks(text) else { return nil }
  var parts: [WorkUserMessagePart] = []
  var remaining = text
  if let review = workParseThreadReviewBlock(text) {
    parts.append(.review(review.comments))
    remaining = review.rest
  }
  var cursor = remaining.startIndex
  func appendText(_ value: Substring) {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty { parts.append(.text(trimmed)) }
  }
  while let open = remaining.range(of: workChatContextOpenTag, range: cursor..<remaining.endIndex),
        let close = remaining.range(of: workChatContextCloseTag, range: open.upperBound..<remaining.endIndex) {
    appendText(remaining[cursor..<open.lowerBound])
    let quote = workChatContextQuote(fromInner: String(remaining[open.upperBound..<close.lowerBound]))
    if !quote.isEmpty { parts.append(.quote(quote)) }
    cursor = close.upperBound
  }
  appendText(remaining[cursor...])
  guard parts.contains(where: { if case .text = $0 { return false } else { return true } }) else {
    return nil
  }
  return parts
}

// MARK: - Composer chip

/// Speech bubble + count above the composer. The count is the comments that go
/// with the next send; when every comment is held it shows the total, muted.
struct WorkThreadCommentsChip: View {
  let comments: [ChatThreadComment]
  let onOpen: () -> Void

  private var includedCount: Int { comments.filter(\.includeInNextSend).count }
  private var allHeld: Bool { includedCount == 0 }

  private var accessibilityText: String {
    let total = comments.count
    let base = workThreadCommentCountLabel(total)
    if allHeld { return "\(base), all held. Tap to review." }
    return "\(base), \(includedCount) go\(includedCount == 1 ? "es" : "") with your next message. Tap to review."
  }

  var body: some View {
    WorkComposerBadgeCapsule(
      tint: allHeld ? ADEColor.textMuted : ADEColor.accent,
      spacing: 6,
      strokeOpacity: allHeld ? 0.22 : 0.55,
      accessibilityLabel: accessibilityText,
      onOpen: onOpen
    ) {
      Image(systemName: "text.bubble.fill")
        .font(.system(size: 13, weight: .semibold))
      Text("\(allHeld ? comments.count : includedCount)")
        .font(.caption2.weight(.bold).monospacedDigit())
        .foregroundStyle(allHeld ? ADEColor.textMuted : ADEColor.accent)
    }
    .adeInspectable(
      "Work.Chat.Composer.ThreadCommentsChip",
      metadata: [
        "total": "\(comments.count)",
        "included": "\(includedCount)"
      ]
    )
  }
}

// MARK: - Comment sheet

struct WorkThreadCommentsSheet: View {
  let comments: [ChatThreadComment]
  let onUpdate: (@MainActor (String, String?, Bool?) async throws -> Void)?
  let onDelete: (@MainActor (String) async throws -> Void)?

  @Environment(\.dismiss) private var dismiss
  @State private var editingId: String?
  @State private var editDraft = ""
  @State private var busyIds: Set<String> = []
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      Group {
        if comments.isEmpty {
          ContentUnavailableView(
            "No comments",
            systemImage: "text.bubble",
            description: Text("Comments you leave on the agent’s replies show up here until you send them.")
          )
        } else {
          List {
            Section {
              ForEach(comments) { comment in
                row(comment)
                  .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) {
                      Task { await delete(comment) }
                    } label: {
                      Label("Delete", systemImage: "trash")
                    }
                  }
              }
            } header: {
              Text(workThreadCommentsHeaderText(comments))
            }
          }
        }
      }
      .navigationTitle("Comments")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
      }
      .safeAreaInset(edge: .bottom) {
        if let errorMessage {
          Text(errorMessage)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
            .padding()
        }
      }
    }
    .presentationDetents([.medium, .large])
    .onChange(of: comments.map(\.id)) { _, ids in
      // A comment that went away (sent, or deleted on the computer) cannot
      // stay in edit mode.
      if let editingId, !ids.contains(editingId) {
        self.editingId = nil
      }
    }
  }

  @ViewBuilder
  private func row(_ comment: ChatThreadComment) -> some View {
    let busy = busyIds.contains(comment.id)
    let quote = comment.anchor.quoteText.trimmingCharacters(in: .whitespacesAndNewlines)
    VStack(alignment: .leading, spacing: 10) {
      if !quote.isEmpty {
        HStack(alignment: .top, spacing: 8) {
          RoundedRectangle(cornerRadius: 1, style: .continuous)
            .fill(ADEColor.accent.opacity(0.6))
            .frame(width: 2)
          Text(quote)
            .font(.subheadline)
            .italic()
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
        .fixedSize(horizontal: false, vertical: true)
      }

      if editingId == comment.id {
        TextEditor(text: $editDraft)
          .font(.body)
          .frame(minHeight: 88)
          .scrollContentBackground(.hidden)
          .padding(6)
          .background(
            ADEColor.textMuted.opacity(0.10),
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
          )
        HStack {
          Button("Cancel") {
            editingId = nil
          }
          Spacer()
          Button("Save") {
            Task { await saveEdit(comment) }
          }
          .fontWeight(.semibold)
          .disabled(busy || editDraft == comment.body)
        }
        .buttonStyle(.borderless)
      } else {
        let note = comment.body.trimmingCharacters(in: .whitespacesAndNewlines)
        Text(note.isEmpty ? "No note" : note)
          .font(.body)
          .foregroundStyle(note.isEmpty ? ADEColor.textMuted : ADEColor.textPrimary)
      }

      Toggle(
        "Send with next message",
        isOn: Binding(
          get: { comment.includeInNextSend },
          set: { value in Task { await setIncluded(comment, value) } }
        )
      )
      .font(.subheadline)
      .tint(ADEColor.accent)
      .disabled(busy)

      if editingId != comment.id {
        HStack {
          Button {
            editDraft = comment.body
            editingId = comment.id
          } label: {
            Label("Edit", systemImage: "pencil")
          }
          Spacer()
          Button(role: .destructive) {
            Task { await delete(comment) }
          } label: {
            Label("Delete", systemImage: "trash")
          }
        }
        .font(.subheadline)
        .buttonStyle(.borderless)
        .disabled(busy)
      }
    }
    .padding(.vertical, 4)
  }

  @MainActor
  private func setIncluded(_ comment: ChatThreadComment, _ value: Bool) async {
    guard let onUpdate, value != comment.includeInNextSend else { return }
    await run(comment.id) { try await onUpdate(comment.id, nil, value) }
  }

  @MainActor
  private func saveEdit(_ comment: ChatThreadComment) async {
    guard let onUpdate else { return }
    let draft = editDraft
    let saved = await run(comment.id) { try await onUpdate(comment.id, draft, nil) }
    // Typing that went on while the save ran keeps the editor open.
    if saved, editingId == comment.id, editDraft == draft { editingId = nil }
  }

  @MainActor
  private func delete(_ comment: ChatThreadComment) async {
    guard let onDelete else { return }
    if editingId == comment.id { editingId = nil }
    await run(comment.id) { try await onDelete(comment.id) }
  }

  @MainActor
  @discardableResult
  private func run(_ id: String, _ work: @MainActor () async throws -> Void) async -> Bool {
    busyIds.insert(id)
    defer { busyIds.remove(id) }
    do {
      try await work()
      errorMessage = nil
      return true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      return false
    }
  }
}

// MARK: - Sent message rendering

/// A user bubble whose text carries a comment card and/or quotes. Drawn on the
/// bubble's accent fill, so everything is white at varying strength.
struct WorkUserMessageStructuredBody: View {
  let parts: [WorkUserMessagePart]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
        switch part {
        case .review(let comments):
          WorkSentThreadReviewCard(comments: comments)
        case .quote(let quote):
          WorkSentQuoteView(quote: quote, lineLimit: 6)
        case .text(let text):
          if workUserTextLooksLikeMarkdown(text) {
            WorkMarkdownRenderer(markdown: text)
              .environment(\.workMarkdownForeground, .white)
              .foregroundStyle(.white)
          } else {
            WorkChipMessageText(text: text)
          }
        }
      }
    }
  }
}

private struct WorkSentQuoteView: View {
  let quote: String
  let lineLimit: Int

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      RoundedRectangle(cornerRadius: 1, style: .continuous)
        .fill(Color.white.opacity(0.55))
        .frame(width: 2)
      Text(quote)
        .font(.subheadline)
        .italic()
        .foregroundStyle(Color.white.opacity(0.78))
        .lineLimit(lineLimit)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .fixedSize(horizontal: false, vertical: true)
  }
}

private struct WorkSentThreadReviewCard: View {
  let comments: [WorkThreadReviewComment]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(
        workThreadCommentCountLabel(comments.count),
        systemImage: "text.bubble.fill"
      )
      .font(.caption.weight(.semibold))
      .foregroundStyle(Color.white.opacity(0.9))
      ForEach(Array(comments.enumerated()), id: \.offset) { _, comment in
        VStack(alignment: .leading, spacing: 4) {
          let quote = comment.quote.trimmingCharacters(in: .whitespacesAndNewlines)
          if !quote.isEmpty {
            WorkSentQuoteView(quote: quote, lineLimit: 3)
          }
          let note = comment.note.trimmingCharacters(in: .whitespacesAndNewlines)
          if !note.isEmpty {
            Text(note)
              .font(.subheadline)
              .foregroundStyle(.white)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
    }
    .padding(10)
    .background(
      Color.white.opacity(0.10),
      in: RoundedRectangle(cornerRadius: 10, style: .continuous)
    )
    .accessibilityElement(children: .combine)
  }
}
