import SwiftUI

/// The phone's renderer for the `markdown` node.
///
/// ## What it reuses
///
/// **Apple's markdown parser, for the one job it is right for.** Every inline
/// run reaches SwiftUI through `AttributedString`, built the same way the chat
/// transcript's ``markdownAttributedString`` builds one — including the inline
/// code pill, which is lifted from there so a snippet in an issue body looks
/// like a snippet in a message. What it does NOT do is hand Apple's parser the
/// document: `AttributedString(markdown:)` draws no fenced block, no checklist
/// and no quote rail, and the transcript's `inlineOnlyPreservingWhitespace`
/// option deliberately flattens block structure. Using it for the whole node
/// would have shown an issue body as one grey paragraph on the phone while the
/// desktop showed headings and a checklist.
///
/// So the BLOCKS come from ``PluginVocabMarkdownParser`` — the mirror of the
/// shared TS parser, which is what makes the four clients agree — and the SPANS
/// are drawn with the app's own text styling. This view holds no parsing of its
/// own.
///
/// **The external-open path is the store's**, the same one the `{openUrl}`
/// action verb goes out through, so a link in prose cannot reach the system
/// browser by a route a link on a button does not.
struct PluginVocabMarkdownView: View {
  let markdown: PluginVocabMarkdown
  @ObservedObject var store: PluginPaneStore

  var body: some View {
    if markdown.truncated {
      // Clamped at the node ceiling: the cut lands wherever it lands, regularly
      // inside a fence or a link, so the markdown of this string is not the
      // document's markdown. The source, plainly, plus a line saying why.
      VStack(alignment: .leading, spacing: 6) {
        Text(markdown.text)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .textSelection(.enabled)
        PluginVocabMarkdownNote(text: "This text was too long to format, so it is shown as written.")
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
    } else {
      let document = PluginVocabMarkdownParser.parse(markdown.text)
      VStack(alignment: .leading, spacing: 8) {
        PluginVocabMarkdownBlocks(blocks: document.blocks, store: store)
        if document.truncated {
          PluginVocabMarkdownNote(text: "The rest of this text is not shown.")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

/// The dim line that says a document did not fit. Never a silent stop.
private struct PluginVocabMarkdownNote: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.caption2)
      .foregroundStyle(ADEColor.textMuted)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct PluginVocabMarkdownBlocks: View {
  let blocks: [PluginVocabMarkdownBlock]
  @ObservedObject var store: PluginPaneStore

  var body: some View {
    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
      PluginVocabMarkdownBlockView(block: block, store: store)
    }
  }
}

private struct PluginVocabMarkdownBlockView: View {
  let block: PluginVocabMarkdownBlock
  @ObservedObject var store: PluginPaneStore

  var body: some View {
    switch block {
    case let .heading(level, spans):
      PluginVocabMarkdownText(spans: spans, font: headingFont(level), store: store)
    case let .paragraph(spans):
      PluginVocabMarkdownText(spans: spans, font: .subheadline, store: store)
    case let .code(_, text):
      // Horizontally scrollable rather than wrapped: a fenced block is the one
      // kind of content whose line breaks ARE the content, so re-flowing it to
      // phone width would be rewriting it.
      ScrollView(.horizontal, showsIndicators: false) {
        Text(text)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .textSelection(.enabled)
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
      }
      .background(ADEColor.surfaceBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
      .overlay(
        RoundedRectangle(cornerRadius: 8).stroke(ADEColor.border.opacity(0.4), lineWidth: 0.5)
      )
      .frame(maxWidth: .infinity, alignment: .leading)
    case let .quote(blocks):
      HStack(alignment: .top, spacing: 8) {
        RoundedRectangle(cornerRadius: 1)
          .fill(ADEColor.border.opacity(0.8))
          .frame(width: 2)
        VStack(alignment: .leading, spacing: 6) {
          PluginVocabMarkdownBlocks(blocks: blocks, store: store)
        }
      }
      .fixedSize(horizontal: false, vertical: true)
    case let .list(ordered, start, items):
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            PluginVocabMarkdownMarker(
              task: item.task,
              label: ordered ? "\(start + index)." : "•"
            )
            VStack(alignment: .leading, spacing: 4) {
              PluginVocabMarkdownBlocks(blocks: item.blocks, store: store)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    case .rule:
      Divider().overlay(ADEColor.border.opacity(0.6))
    }
  }

  private func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: return .title3.weight(.semibold)
    case 2: return .headline
    case 3: return .subheadline.weight(.semibold)
    default: return .footnote.weight(.semibold)
    }
  }
}

/// A list row's marker: a bullet, a number, or an INERT task box.
///
/// The box is a symbol, never a `Toggle` and never a `Button`. The plugin
/// declared no action for a checkbox, so a reader who could tap it would change
/// nothing and be told nothing; this is a picture of what the source document
/// says. `accessibilityHidden` keeps it out of VoiceOver's control list for the
/// same reason.
private struct PluginVocabMarkdownMarker: View {
  let task: PluginVocabMarkdownItem.Task?
  let label: String

  var body: some View {
    Group {
      switch task {
      case .checked:
        Image(systemName: "checkmark.square.fill").foregroundStyle(ADEColor.accent)
      case .unchecked:
        Image(systemName: "square").foregroundStyle(ADEColor.textMuted)
      case nil:
        Text(label).foregroundStyle(ADEColor.textMuted)
      }
    }
    .font(.subheadline)
    .accessibilityHidden(true)
  }
}

/// One block's inline runs, as one `AttributedString`.
///
/// One string rather than a row of `Text` views so the paragraph wraps as a
/// paragraph — an `HStack` of runs would break between them and leave ragged
/// lines. Links are `.link` attributes, and `openURL` is overridden below so a
/// tap goes out through the plugin's own path instead of straight to Safari.
private struct PluginVocabMarkdownText: View {
  let spans: [PluginVocabMarkdownSpan]
  let font: Font
  @ObservedObject var store: PluginPaneStore

  var body: some View {
    Text(attributed)
      .font(font)
      .foregroundStyle(ADEColor.textSecondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
      .environment(\.openURL, OpenURLAction { url in
        // Never `.systemAction`: every open a plugin causes goes through the
        // store, which is where the `{openUrl}` verb goes and where a test can
        // see it. The parser already refused everything but `https:`.
        store.openExternal(url)
        return .handled
      })
  }

  private var attributed: AttributedString {
    var result = AttributedString()
    for span in spans {
      var run = AttributedString(span.text)
      if span.code {
        // The transcript's inline-code pill, so a snippet reads the same in a
        // panel as it does in a message.
        run.font = .system(.caption, design: .monospaced).weight(.semibold)
        run.backgroundColor = ADEColor.accent.opacity(0.14)
        run.foregroundColor = ADEColor.accent
      } else {
        var traits: InlinePresentationIntent = []
        if span.bold { traits.insert(.stronglyEmphasized) }
        if span.italic { traits.insert(.emphasized) }
        if !traits.isEmpty { run.inlinePresentationIntent = traits }
        if span.bold { run.foregroundColor = ADEColor.textPrimary }
      }
      // Set explicitly rather than through the presentation intent: SwiftUI does
      // not reliably draw a strikethrough from the intent alone, which is the
      // same fix `markdownAttributedString` carries.
      if span.strike { run.strikethroughStyle = .single }
      if let href = span.href {
        run.link = href
        run.foregroundColor = ADEColor.accent
        run.underlineStyle = .single
      }
      result.append(run)
    }
    return result
  }
}
