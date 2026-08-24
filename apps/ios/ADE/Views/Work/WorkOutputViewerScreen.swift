import SwiftUI
import UIKit

/// One request to read a box's whole contents on its own screen.
///
/// The transcript shows boxed output — tool results, command output, fenced
/// code, diffs, monospace reports — at a fixed height with no inner scroller,
/// so anything past that height is unreachable in place. This is how a box
/// hands the full, authoritative text over to the reader.
struct WorkOutputViewerRequest: Identifiable {
  enum Kind {
    case text
    case code
    case diff
  }

  /// Fresh per request: presenting the same content twice must re-present.
  let id = UUID()
  let title: String
  var subtitle: String? = nil
  let text: String
  var kind: Kind = .text
  /// Language hint for `.code`, e.g. "swift".
  var languageId: String? = nil
}

/// Owner of the full-screen viewer for one chat surface.
///
/// Boxes ask for the viewer through the environment instead of each carrying
/// its own `fullScreenCover`: a presentation host per transcript row would cost
/// the `LazyVStack` a modifier that almost never fires. The surface holds one
/// of these and presents from it.
final class WorkOutputViewerModel: ObservableObject {
  @Published var request: WorkOutputViewerRequest?

  func present(_ request: WorkOutputViewerRequest) {
    self.request = request
  }
}

private struct WorkOutputViewerEnvironmentKey: EnvironmentKey {
  static let defaultValue: WorkOutputViewerModel? = nil
}

extension EnvironmentValues {
  /// Nil on surfaces that render boxes without a viewer (previews, the PR
  /// wizard). Affordances that need it hide themselves rather than dead-end.
  var workOutputViewer: WorkOutputViewerModel? {
    get { self[WorkOutputViewerEnvironmentKey.self] }
    set { self[WorkOutputViewerEnvironmentKey.self] = newValue }
  }
}

// MARK: - Clipping

/// A `WorkStructuredOutputBlock` clips at 180pt. Caption monospaced lines lay
/// out at ~15pt, and a phone-width box fits ~46 of those characters per line.
let workStructuredOutputBoxLineCapacity = 11
let workStructuredOutputBoxColumnCapacity = 46
/// `WorkDiffOutputBlock` clips at 220pt, with 4pt of padding per diff line.
let workDiffOutputBoxLineCapacity = 11
/// `WorkInlineDiffPreview` clips at 320pt with no per-line padding.
let workInlineDiffPreviewLineCapacity = 19

/// Whether `text` overflows a box that clips at a fixed height.
///
/// Phase 1 de-nested the transcript's inner scrollers, so these boxes clip
/// instead of scrolling. This is what decides whether the reader is looking at
/// a partial view and should be offered the full-screen viewer.
///
/// - Parameters:
///   - lineCapacity: laid-out lines the box shows before it clips.
///   - columnCapacity: characters per line before wrapping, or nil for a box
///     that scrolls horizontally instead of wrapping (the diffs).
func workOutputBoxOverflows(_ text: String, lineCapacity: Int, columnCapacity: Int?) -> Bool {
  guard lineCapacity > 0 else { return !text.isEmpty }

  guard let columnCapacity, columnCapacity > 0 else {
    // Non-wrapping box: only hard line breaks push content down, and the scan
    // stops at the first line past the cap, so a huge diff pays for ~12 lines.
    var renderedLines = 1
    for byte in text.utf8 where byte == 0x0A {
      renderedLines += 1
      if renderedLines > lineCapacity { return true }
    }
    return false
  }

  // O(1) upper bound: text that cannot fill the box even packed as one dense
  // run of bytes cannot overflow it, so a long result never pays for a scan.
  if text.utf8.count > lineCapacity * columnCapacity { return true }

  var renderedLines = 1
  var column = 0
  for character in text {
    if character == "\n" {
      renderedLines += 1
      column = 0
    } else {
      column += 1
      if column > columnCapacity {
        renderedLines += 1
        column = 1
      }
    }
    if renderedLines > lineCapacity { return true }
  }
  return false
}

// MARK: - Hybrid expand ladder

/// The one affordance a bounded box offers next.
enum WorkTruncatedOutputAffordance: Equatable {
  case none
  case showMore
  case openFullOutput
}

/// The hybrid expand ladder, as one decision.
///
/// The first tap expands downward in place. Anything still bounded after that
/// step goes to the full-screen viewer instead of stepping again — a box that
/// clips at a fixed height cannot show what another step would add, and a
/// reader paginating a 2000-line answer four lines at a time is not being
/// helped.
func workTruncatedOutputAffordance(
  isTruncated: Bool,
  hasExpandedInPlace: Bool,
  isClipped: Bool
) -> WorkTruncatedOutputAffordance {
  if isTruncated {
    return hasExpandedInPlace ? .openFullOutput : .showMore
  }
  return isClipped ? .openFullOutput : .none
}

// MARK: - Affordances

/// Shared "read this box full screen" control.
struct WorkOpenFullOutputButton: View {
  let title: String
  var subtitle: String? = nil
  /// What the box is displaying. Also the fallback text when `codeSource`
  /// cannot resolve.
  let text: String
  var kind: WorkOutputViewerRequest.Kind = .text
  var languageId: String? = nil
  /// Set when `text` is a slice of a larger message; the whole block is
  /// resolved at tap time rather than on every render pass.
  var codeSource: WorkCodeBlockSource? = nil
  /// Box headers use the compact "Open"; the transcript's ladder spells it out.
  var label: String = "Open"
  var prominent = false

  @Environment(\.workOutputViewer) private var viewer

  var body: some View {
    if let viewer {
      Button {
        viewer.present(
          WorkOutputViewerRequest(
            title: title,
            subtitle: subtitle,
            text: codeSource?.resolvedCode(fallback: text) ?? text,
            kind: kind,
            languageId: languageId
          )
        )
      } label: {
        Label(label, systemImage: "arrow.up.left.and.arrow.down.right")
          .labelStyle(.titleAndIcon)
          .font(.caption2.weight(.semibold))
          .frame(minHeight: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(prominent ? ADEColor.accent : ADEColor.textSecondary)
      .accessibilityLabel("Open \(title.lowercased()) full screen")
    }
  }
}

/// Makes a clipping box's content open the viewer when tapped, so the reader
/// does not have to find the header control to reach what is cut off.
struct WorkOpenFullOutputTapModifier: ViewModifier {
  let title: String
  var subtitle: String? = nil
  let text: String
  var kind: WorkOutputViewerRequest.Kind = .text
  var languageId: String? = nil

  @Environment(\.workOutputViewer) private var viewer

  private func present() {
    viewer?.present(
      WorkOutputViewerRequest(
        title: title,
        subtitle: subtitle,
        text: text,
        kind: kind,
        languageId: languageId
      )
    )
  }

  func body(content: Content) -> some View {
    content
      .contentShape(Rectangle())
      .onTapGesture { present() }
      .accessibilityAction(named: "Open full output") { present() }
  }
}

extension View {
  /// Applied to the clipped region of a box. A no-op when nothing is cut off.
  @ViewBuilder
  func workOpensFullOutput(
    _ isClipped: Bool,
    title: String,
    subtitle: String? = nil,
    text: String,
    kind: WorkOutputViewerRequest.Kind = .text,
    languageId: String? = nil
  ) -> some View {
    if isClipped {
      modifier(
        WorkOpenFullOutputTapModifier(
          title: title,
          subtitle: subtitle,
          text: text,
          kind: kind,
          languageId: languageId
        )
      )
    } else {
      self
    }
  }
}

// MARK: - Search

/// Line index of every case-insensitive occurrence of `query`. A line with
/// three hits contributes three entries, so "3 of 12" counts matches and not
/// lines, and stepping walks hits in reading order.
func workOutputViewerMatchLines(_ lines: [String], query: String) -> [Int] {
  let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !needle.isEmpty else { return [] }
  var result: [Int] = []
  for (index, line) in lines.enumerated() {
    var cursor = line.startIndex
    while cursor < line.endIndex,
          let found = line.range(of: needle, options: [.caseInsensitive], range: cursor..<line.endIndex) {
      result.append(index)
      cursor = found.upperBound > found.lowerBound
        ? found.upperBound
        : line.index(after: found.lowerBound)
    }
  }
  return result
}

/// Wraps around at both ends: the reader stepping past the last hit expects the
/// first one, not a dead button.
func workOutputViewerSteppedMatchIndex(current: Int, delta: Int, count: Int) -> Int {
  guard count > 0 else { return 0 }
  let stepped = (current + delta) % count
  return stepped < 0 ? stepped + count : stepped
}

// MARK: - Screen

/// Full-screen reader for any boxed output in a chat.
///
/// Line-based and lazy on purpose: the text can be a 100k-character tool
/// result, and one `Text` that long with a line-number gutter would lay the
/// whole thing out before drawing a single row.
struct WorkOutputViewerScreen: View {
  let request: WorkOutputViewerRequest

  /// Split once, at init. Recomputing this in `body` would rescan the whole
  /// text on every keystroke in the search field.
  private let lines: [String]

  @Environment(\.dismiss) private var dismiss
  @State private var wrapsLines = false
  @State private var searchVisible = false
  @State private var query = ""
  @State private var matches: [Int] = []
  /// Same hits as `matches`, as a set. Rows ask "am I a match?" once each, so
  /// this is built with the results rather than rebuilt per row.
  @State private var matchedLines: Set<Int> = []
  @State private var matchIndex = 0
  /// Bumped whenever the current match moves, including when a fresh search
  /// lands back on index 0 — watching `matchIndex` alone would not scroll to
  /// the first hit of the reader's second query.
  @State private var matchScrollToken = 0
  @State private var copied = false
  @FocusState private var searchFocused: Bool

  init(request: WorkOutputViewerRequest) {
    self.request = request
    let split = splitPreservingEmptyLines(request.text)
    self.lines = split.isEmpty ? [""] : split
  }

  private var trimmedQuery: String {
    query.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var currentMatchLine: Int? {
    matches.indices.contains(matchIndex) ? matches[matchIndex] : nil
  }

  private var lineNumberWidth: CGFloat {
    min(max(CGFloat(String(lines.count).count) * 8 + 10, 26), 58)
  }

  private var language: FilesLanguage {
    FilesLanguage.detect(
      languageId: request.languageId,
      filePath: "snippet.\(request.languageId ?? "txt")"
    )
  }

  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        contentScroll
          .onChange(of: matchScrollToken) { _, _ in
            guard let line = currentMatchLine else { return }
            withAnimation(.easeOut(duration: 0.18)) {
              proxy.scrollTo(line, anchor: .center)
            }
          }
      }
      .adeScreenBackground()
      .navigationTitle(request.title)
      .navigationBarTitleDisplayMode(.inline)
      .adeNavigationGlass()
      .toolbar { toolbarContent }
      .safeAreaInset(edge: .top, spacing: 0) { topStrip }
      .task(id: query) { await refreshMatches() }
    }
  }

  @ViewBuilder
  private var contentScroll: some View {
    if wrapsLines {
      ScrollView(.vertical) { rows }
    } else {
      ScrollView([.horizontal, .vertical]) { rows }
    }
  }

  private var rows: some View {
    LazyVStack(alignment: .leading, spacing: 0) {
      ForEach(lines.indices, id: \.self) { index in
        row(index: index, line: lines[index])
      }
    }
    .padding(.vertical, 10)
    .frame(maxWidth: wrapsLines ? .infinity : nil, alignment: .leading)
  }

  private func row(index: Int, line: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Text("\(index + 1)")
        .font(.caption2.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: lineNumberWidth, alignment: .trailing)
      Text(rowText(index: index, line: line))
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(foreground(for: line))
        .lineLimit(nil)
        .fixedSize(horizontal: !wrapsLines, vertical: wrapsLines)
        .frame(maxWidth: wrapsLines ? .infinity : nil, alignment: .leading)
        .textSelection(.enabled)
    }
    .frame(maxWidth: wrapsLines ? .infinity : nil, alignment: .leading)
    .padding(.horizontal, 12)
    .padding(.vertical, 1)
    .background(background(index: index, line: line))
    .id(index)
  }

  /// Search highlighting wins over syntax highlighting on a matched line: two
  /// competing sets of colours on one line reads as noise, and the reason the
  /// line is on screen is the match.
  private func rowText(index: Int, line: String) -> AttributedString {
    let rendered = line.isEmpty ? " " : line
    if matchedLines.contains(index) {
      return searchHighlighted(rendered)
    }
    guard request.kind == .code else {
      return AttributedString(rendered)
    }
    return SyntaxHighlighter.highlightedAttributedString(rendered, as: language)
  }

  private func searchHighlighted(_ line: String) -> AttributedString {
    var attributed = AttributedString(line)
    let needle = trimmedQuery
    guard !needle.isEmpty else { return attributed }
    var cursor = line.startIndex
    while cursor < line.endIndex,
          let found = line.range(of: needle, options: [.caseInsensitive], range: cursor..<line.endIndex) {
      if let lower = AttributedString.Index(found.lowerBound, within: attributed),
         let upper = AttributedString.Index(found.upperBound, within: attributed) {
        attributed[lower..<upper].backgroundColor = ADEColor.accent.opacity(0.32)
        attributed[lower..<upper].foregroundColor = ADEColor.textPrimary
      }
      cursor = found.upperBound > found.lowerBound
        ? found.upperBound
        : line.index(after: found.lowerBound)
    }
    return attributed
  }

  private func foreground(for line: String) -> Color {
    request.kind == .diff ? diffLineColor(for: line) : ADEColor.textPrimary
  }

  @ViewBuilder
  private func background(index: Int, line: String) -> some View {
    if index == currentMatchLine {
      ADEColor.accent.opacity(0.14)
    } else if request.kind == .diff {
      diffLineBackground(for: line)
    } else {
      Color.clear
    }
  }

  @ToolbarContentBuilder
  private var toolbarContent: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      Button("Done") { dismiss() }
        .fontWeight(.semibold)
    }
    ToolbarItemGroup(placement: .topBarTrailing) {
      Button {
        searchVisible.toggle()
        searchFocused = searchVisible
        if !searchVisible { query = "" }
      } label: {
        Image(systemName: searchVisible ? "magnifyingglass.circle.fill" : "magnifyingglass")
      }
      .accessibilityLabel(searchVisible ? "Hide search" : "Search output")

      Menu {
        Toggle("Wrap lines", isOn: $wrapsLines)
        Button {
          UIPasteboard.general.string = request.text
          copied = true
          Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            copied = false
          }
        } label: {
          Label(copied ? "Copied" : "Copy all", systemImage: copied ? "checkmark" : "doc.on.doc")
        }
        ShareLink(item: request.text) {
          Label("Share", systemImage: "square.and.arrow.up")
        }
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .accessibilityLabel("Output actions")
    }
  }

  private var topStrip: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        if let subtitle = request.subtitle, !subtitle.isEmpty {
          Text(subtitle)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Spacer(minLength: 0)
        Text("\(lines.count) line\(lines.count == 1 ? "" : "s")")
          .font(.caption2.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 6)

      if searchVisible {
        searchBar
      }

      Divider().opacity(0.4)
    }
    .background(.ultraThinMaterial)
  }

  private var searchBar: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
      TextField("Find in output", text: $query)
        .font(.caption)
        .focused($searchFocused)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .submitLabel(.search)

      if !trimmedQuery.isEmpty {
        Text(matches.isEmpty ? "No matches" : "\(matchIndex + 1) of \(matches.count)")
          .font(.caption2.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
      }

      Button {
        matchIndex = workOutputViewerSteppedMatchIndex(current: matchIndex, delta: -1, count: matches.count)
        matchScrollToken += 1
      } label: {
        Image(systemName: "chevron.up")
          .font(.caption.weight(.semibold))
          .frame(width: 44, height: 34)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(matches.isEmpty)
      .accessibilityLabel("Previous match")

      Button {
        matchIndex = workOutputViewerSteppedMatchIndex(current: matchIndex, delta: 1, count: matches.count)
        matchScrollToken += 1
      } label: {
        Image(systemName: "chevron.down")
          .font(.caption.weight(.semibold))
          .frame(width: 44, height: 34)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(matches.isEmpty)
      .accessibilityLabel("Next match")
    }
    .foregroundStyle(ADEColor.textSecondary)
    .padding(.horizontal, 16)
    .padding(.bottom, 6)
  }

  /// Debounced: scanning 100k characters per keystroke would land the work on
  /// the main thread between every two letters the reader types.
  private func refreshMatches() async {
    let needle = trimmedQuery
    guard !needle.isEmpty else {
      matches = []
      matchedLines = []
      matchIndex = 0
      return
    }
    try? await Task.sleep(nanoseconds: 180_000_000)
    guard !Task.isCancelled else { return }
    let found = workOutputViewerMatchLines(lines, query: needle)
    matches = found
    matchedLines = Set(found)
    matchIndex = 0
    matchScrollToken += 1
  }
}
