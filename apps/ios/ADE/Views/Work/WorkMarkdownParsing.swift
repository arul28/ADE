import SwiftUI
import UIKit
import AVKit

/// Box-drawing and block glyphs that mark fixed-column layout art. Both raw
/// question previews and Markdown-aware assistant previews share this set.
let workWireframeGlyphs: Set<Character> = [
  "│", "┌", "┐", "└", "┘", "├", "┤", "┼", "─",
  "╭", "╮", "╰", "╯", "║", "═", "╔", "╗", "╚", "╝", "╠", "╣", "╬",
  "▌", "▐", "█", "▓", "▒", "░", "▢", "▣", "□", "■",
]

/// True when a line has an interior run of 3+ spaces/tabs between two
/// non-whitespace characters — the fixed-column layout signal.
func workLineHasAlignedColumnGap<S: StringProtocol>(_ line: S) -> Bool {
  var sawNonWhitespace = false
  var whitespaceRun = 0
  for character in line {
    if character == " " || character == "\t" {
      if sawNonWhitespace { whitespaceRun += 1 }
    } else {
      if whitespaceRun >= 3 { return true }
      sawNonWhitespace = true
      whitespaceRun = 0
    }
  }
  return false
}

/// Whether an assistant answer should render as one fixed-column block rather
/// than parsed Markdown. Fenced code and Markdown table rows are deliberately
/// ignored: their dedicated block renderers already preserve alignment.
/// Incremental state for the fixed-column classifier used by a live assistant
/// response. A cached `false` classification is not safe by itself: a later
/// delta can complete a second aligned row, or add a wireframe glyph outside a
/// fence. Keeping the line scanner's state on the message makes both cases
/// cheap and exact without rescanning the growing response.
struct WorkStreamingMonospacedClassifierState: Equatable {
  private(set) var insideFence = false
  /// The opening marker for the currently unclosed fence, when the streamed
  /// text ends inside one. Tail previews can reuse this bounded piece of
  /// metadata instead of rescanning the entire response to reconstruct it.
  private(set) var openFenceMarker: String? = nil
  private(set) var proseLineCount = 0
  private(set) var alignedColumnLineCount = 0
  private(set) var hasWireframeGlyph = false
  // Keep only the facts needed to classify the unfinished line. Retaining the
  // whole line here made `usesMonospacedRendering` copy and rescan an ever
  // growing one-line response on every token batch — exactly the O(n) loop the
  // streaming path is meant to remove.
  private var pendingHasNonWhitespace = false
  private var pendingWhitespaceRun = 0
  private var pendingHasAlignedColumnGap = false
  private var pendingHasWireframeGlyph = false
  private var pendingHasPipe = false
  private var pendingFencePrefixLength = 0
  private var pendingFenceCandidate = true
  private var pendingFenceMarker = ""

  init(text: String = "") {
    append(text)
  }

  mutating func append(_ text: String) {
    guard !text.isEmpty else { return }

    for character in text {
      if character == "\n" {
        processCompleteLine()
      } else {
        processCharacter(character)
      }
    }
  }

  var usesMonospacedRendering: Bool {
    guard !insideFence, pendingHasNonWhitespace else {
      return hasWireframeGlyph
    }
    let pendingIsFence = pendingFenceCandidate && pendingFencePrefixLength >= 3
    guard !pendingIsFence else { return hasWireframeGlyph }

    let pendingProseLineCount = proseLineCount + 1
    let pendingAlignedColumnLineCount = alignedColumnLineCount
      + (!pendingHasPipe && pendingHasAlignedColumnGap ? 1 : 0)
    return hasWireframeGlyph
      || pendingHasWireframeGlyph
      || (pendingAlignedColumnLineCount >= 2
        && pendingAlignedColumnLineCount * 2 >= pendingProseLineCount)
  }

  private mutating func processCharacter(_ character: Character) {
    let isHorizontalWhitespace = character == " " || character == "\t"
    let isWhitespace = character.isWhitespace

    if !pendingHasNonWhitespace {
      guard !isWhitespace else { return }
      pendingHasNonWhitespace = true
      if character == "`" {
        pendingFencePrefixLength = 1
        pendingFenceMarker = "`"
      } else {
        pendingFenceCandidate = false
      }
    } else if pendingFenceCandidate {
      if pendingFencePrefixLength < 3 {
        if character == "`" {
          pendingFencePrefixLength += 1
          pendingFenceMarker.append(character)
        } else {
          pendingFenceCandidate = false
          pendingFenceMarker = ""
        }
      } else {
        // The parser treats any trimmed line beginning with three backticks as
        // a fence, so retain the (usually tiny) language suffix as well.
        pendingFenceMarker.append(character)
      }
    }

    if character == "|" {
      pendingHasPipe = true
    }
    if workWireframeGlyphs.contains(character) {
      pendingHasWireframeGlyph = true
    }

    if isHorizontalWhitespace {
      pendingWhitespaceRun += 1
    } else {
      if pendingWhitespaceRun >= 3 {
        pendingHasAlignedColumnGap = true
      }
      pendingWhitespaceRun = 0
    }
  }

  private mutating func processCompleteLine() {
    let isFence = pendingFenceCandidate && pendingFencePrefixLength >= 3
    if isFence {
      if insideFence {
        insideFence = false
        openFenceMarker = nil
      } else {
        insideFence = true
        openFenceMarker = pendingFenceMarker.trimmingCharacters(in: .whitespaces)
      }
      resetPendingLine()
      return
    }
    guard !insideFence, pendingHasNonWhitespace else {
      resetPendingLine()
      return
    }

    if pendingHasWireframeGlyph {
      hasWireframeGlyph = true
    }
    proseLineCount += 1
    if !pendingHasPipe, pendingHasAlignedColumnGap {
      alignedColumnLineCount += 1
    }
    resetPendingLine()
  }

  private mutating func resetPendingLine() {
    pendingHasNonWhitespace = false
    pendingWhitespaceRun = 0
    pendingHasAlignedColumnGap = false
    pendingHasWireframeGlyph = false
    pendingHasPipe = false
    pendingFencePrefixLength = 0
    pendingFenceCandidate = true
    pendingFenceMarker = ""
  }
}

func workAssistantMessageUsesMonospacedPreview(_ text: String) -> Bool {
  WorkStreamingMonospacedClassifierState(text: text).usesMonospacedRendering
}

func workMarkdownTrailingBacktickRun(_ text: String) -> Int {
  var count = 0
  for character in text.reversed() {
    guard character == "`" else { break }
    count += 1
  }
  return count
}

/// The marker column a list row reserves, shared by every sibling of one list
/// level so item text starts at one x. Ordered columns are sized to the widest
/// number of that sibling group (in monospaced digits); bullet columns are a
/// fixed one-glyph slot whose glyph varies by depth.
enum WorkMarkdownListMarkerColumn: Equatable {
  case bullet(depth: Int)
  case ordered(digits: Int)

  var cacheKey: String {
    switch self {
    case .bullet(let depth): return "b\(depth)"
    case .ordered(let digits): return "o\(digits)"
    }
  }
}

/// One rendered row of a (possibly nested) Markdown list.
///
/// Lists are stored flat, in reading order, rather than as a tree: a long list
/// must still split into bounded render blocks (`workMarkdownListItemsPerRenderBlock`),
/// and a flat row carries everything it needs to draw itself — the marker
/// columns of its ancestors (for indentation that lines up exactly under each
/// parent's text) and its own column — no matter which chunk it lands in.
struct WorkMarkdownListItem: Equatable {
  enum Marker: Equatable {
    case bullet
    case ordered(Int)
    /// A continuation paragraph of the item above it at the same level: drawn
    /// aligned with that item's text, with no marker of its own.
    case continuation
  }

  let marker: Marker
  /// This row's own marker column (for a continuation, its owning item's).
  let column: WorkMarkdownListMarkerColumn
  /// Marker columns of the enclosing items, outermost first.
  let ancestors: [WorkMarkdownListMarkerColumn]
  let text: String

  var depth: Int { ancestors.count }

  /// The visible marker, or nil for a continuation row.
  var markerLabel: String? {
    switch marker {
    case .bullet: return workMarkdownBulletGlyph(depth: depth)
    case .ordered(let number): return "\(number)."
    case .continuation: return nil
    }
  }

  var cacheKey: String {
    let markerKey: String
    switch marker {
    case .bullet: markerKey = "-"
    case .ordered(let number): markerKey = "\(number)."
    case .continuation: markerKey = "+"
    }
    let path = (ancestors + [column]).map(\.cacheKey).joined(separator: ",")
    return "\(path)\u{001D}\(markerKey)\u{001D}\(text)"
  }
}

/// Bullet glyph for a nesting depth: filled and hollow discs, alternating.
/// (The small square U+25AA has no glyph in the system text font on iOS and
/// rendered as a missing-glyph box.)
func workMarkdownBulletGlyph(depth: Int) -> String {
  depth.isMultiple(of: 2) ? "\u{2022}" : "\u{25E6}"
}

/// Invisible text that sizes a marker column: the widest marker the column
/// can hold, so every sibling's text starts at the same x under Dynamic Type.
func workMarkdownListMarkerPlaceholder(_ column: WorkMarkdownListMarkerColumn) -> String {
  switch column {
  case .bullet: return "0"
  case .ordered(let digits): return String(repeating: "0", count: max(1, digits)) + "."
  }
}

enum WorkMarkdownBlockKind: Equatable {
  case paragraph(String)
  case heading(Int, String)
  /// A list run (ordered, unordered, or mixed when nested), flattened into
  /// rows. See `WorkMarkdownListItem`.
  case list([WorkMarkdownListItem])
  case blockquote([String])
  case table(headers: [String], rows: [[String]])
  case code(language: String?, code: String)
  case rule

  var cacheKey: String {
    switch self {
    case .paragraph(let text):
      return "paragraph|\(text)"
    case .heading(let level, let text):
      return "heading|\(level)|\(text)"
    case .list(let items):
      return "list|\(items.map(\.cacheKey).joined(separator: "\u{001F}"))"
    case .blockquote(let lines):
      return "blockquote|\(lines.joined(separator: "\u{001F}"))"
    case .table(let headers, let rows):
      let rowDigest = rows.map { $0.joined(separator: "\u{001F}") }.joined(separator: "\u{001E}")
      return "table|\(headers.joined(separator: "\u{001F}"))|\(rowDigest)"
    case .code(let language, let code):
      return "code|\(language ?? "")|\(code)"
    case .rule:
      return "rule"
    }
  }
}

struct WorkMarkdownBlock: Identifiable, Equatable {
  /// Position-stable within its message: `markdown-block-<index>`.
  ///
  /// Deliberately NOT content-derived. The id used to carry a digest of the
  /// block's text, so every streaming delta and every "Show more" step handed
  /// the `LazyVStack` a brand-new identity for a row that was still the same
  /// row — destroying reuse and re-creating the whole subtree instead of
  /// updating it. Content changes are detected through `digest` / `kind`.
  let id: String
  let kind: WorkMarkdownBlockKind
  /// Digest of `kind.cacheKey`, computed once at parse time. Change detection
  /// (Equatable, presentation signatures) reads this instead of rebuilding and
  /// re-hashing the block's full text on every refresh.
  let digest: String

  init(id: String, kind: WorkMarkdownBlockKind, digest: String? = nil) {
    self.id = id
    self.kind = kind
    self.digest = digest ?? workStableDigest(kind.cacheKey)
  }
}

func parseMarkdownBlocks(_ markdown: String) -> [WorkMarkdownBlock] {
  let key = workStableDigest(markdown) as NSString
  if let cached = workMarkdownBlocksCache.object(forKey: key) {
    return cached.value
  }

  let parsed = parseMarkdownBlocksInternal(markdown)
  workMarkdownBlocksCache.setObject(WorkMarkdownBlocksCacheBox(parsed), forKey: key)
  return parsed
}

/// Block parsing for the actively-streaming assistant preview.
///
/// The caller deliberately supplies only the bounded head/tail slice that can
/// be rendered in the transcript. Re-scanning that slice is predictable and
/// safe; attempting to find a stable boundary in the growing authoritative
/// response added a second full-text scan and copied a prefix on every delta,
/// while tail slices can change their boundary as the response grows. Keep a
/// tiny per-message cache for repeated SwiftUI evaluations, and let the normal
/// parser remain the single source of truth for block identities.
func parseMarkdownBlocksForStreaming(_ markdown: String, cacheKey: String) -> [WorkMarkdownBlock] {
  parseMarkdownBlocksForStreaming(markdown, cacheKey: cacheKey, appendOnly: true)
}

/// Append-only variant used by the live assistant tail. The cache records the
/// UTF-16 boundary where the next delta starts, so the successful path touches
/// only the new suffix. The prefix guard is required because transport
/// de-duplication can rewrite a message under the same cache key; such a
/// rewrite must fall back to the authoritative parser instead of being treated
/// as an append.
func parseMarkdownBlocksForStreaming(
  _ markdown: String,
  cacheKey: String,
  appendOnly: Bool
) -> [WorkMarkdownBlock] {
  let key = cacheKey as NSString
  let cached = workStreamingMarkdownCache.object(forKey: key)
  if let cached {
    if appendOnly {
      if cached.appendBoundaryUTF16Count == markdown.utf16.count,
         cached.fullText == markdown
      {
        return cached.blocks
      }
    } else if cached.fullText == markdown {
      return cached.blocks
    }
  }

  if let cached,
     cached.isPlainProse,
     appendOnly,
     markdown.hasPrefix(cached.fullText),
     let appended = workStreamingAppendText(from: markdown, after: cached)
  {
    let blocks = workAppendPlainProse(
      cached.blocks,
      replacingTrailingWhitespace: cached.trailingWhitespace,
      appendedText: cached.trailingWhitespace + appended
    )
    workStreamingMarkdownCache.setObject(
      WorkStreamingMarkdownCacheBox(
        fullText: markdown,
        blocks: blocks,
        isPlainProse: true,
        trailingWhitespace: workTrailingWhitespace(in: markdown)
      ),
      forKey: key
    )
    return blocks
  }

  let blocks = parseMarkdownBlocksInternal(markdown)
  workStreamingMarkdownCache.setObject(
    WorkStreamingMarkdownCacheBox(
      fullText: markdown,
      blocks: blocks,
      isPlainProse: workIsPlainProse(markdown, blocks: blocks),
      trailingWhitespace: workTrailingWhitespace(in: markdown)
    ),
    forKey: key
  )
  return blocks
}

/// The append-only fast path is deliberately narrower than Markdown parsing:
/// one paragraph, no line breaks, and no punctuation that can change block or
/// inline interpretation. A cache hit is therefore safe to update by replacing
/// only the last bounded prose row; headings, lists, links, tables, and fences
/// all use `parseMarkdownBlocksInternal` instead.
private let workPlainProseMarkdownPunctuation: Set<Character> = [
  "#", "*", "_", "`", "[", "]", "|", ">", "~", "\\", "<",
]

private func workIsPlainProse(_ text: String, blocks: [WorkMarkdownBlock]) -> Bool {
  guard !text.isEmpty,
        !text.contains(where: { $0 == "\n" || $0 == "\r" }),
        !blocks.isEmpty,
        blocks.allSatisfy({
          if case .paragraph = $0.kind { return true }
          return false
        })
  else { return false }

  return workHasPlainProseCharacters(text)
}

private func workHasPlainProseCharacters(_ text: String) -> Bool {
  let markerText = text.drop { $0.isWhitespace }
  if markerText.hasPrefix("#") || markerText.hasPrefix(">") || markerText.hasPrefix("-") || markerText.hasPrefix("+") {
    return false
  }
  if markerText.first?.isNumber == true {
    var index = markerText.startIndex
    while index < markerText.endIndex, markerText[index].isNumber {
      index = markerText.index(after: index)
    }
    // A streaming delta can leave an ordered-list marker split across
    // updates: `"1"` then `". item"`, or `"1."` then `" item"`. Do not
    // cache either partial marker as settled prose, otherwise the append
    // fast path cannot recover the ordered-list block that the full parser
    // would produce.
    if index == markerText.endIndex {
      return false
    }
    if index < markerText.endIndex, markerText[index] == "." {
      let afterDot = markerText.index(after: index)
      if afterDot == markerText.endIndex || markerText[afterDot].isWhitespace {
        return false
      }
    }
  }

  // These characters are enough to enter a Markdown construct in the parser
  // or in AttributedString's inline parser. Being conservative is important:
  // a false negative only takes the existing safe path, while a false positive
  // could change a block's kind or text.
  return !text.contains(where: { workPlainProseMarkdownPunctuation.contains($0) })
}

private func workTrailingWhitespace(in text: String) -> String {
  var start = text.endIndex
  while start > text.startIndex {
    let previous = text.index(before: start)
    guard text[previous].isWhitespace else { break }
    start = previous
  }
  return String(text[start...])
}

private func workStreamingAppendText(
  from markdown: String,
  after cached: WorkStreamingMarkdownCacheBox
) -> String? {
  guard markdown.utf16.count > cached.appendBoundaryUTF16Count else { return nil }
  let start = String.Index(utf16Offset: cached.appendBoundaryUTF16Count, in: markdown)
  let appended = String(markdown[start...])
  guard workHasPlainProseCharacters(appended),
        !appended.contains(where: { $0 == "\n" || $0 == "\r" }) else { return nil }
  return appended
}

private func workAppendPlainProse(
  _ blocks: [WorkMarkdownBlock],
  replacingTrailingWhitespace: String,
  appendedText: String
) -> [WorkMarkdownBlock] {
  guard !appendedText.isEmpty,
        let last = blocks.last,
        case .paragraph(let lastText) = last.kind
  else { return blocks }

  let baseCount = blocks.count - 1
  let settledLastText: String
  if !replacingTrailingWhitespace.isEmpty,
     lastText.hasSuffix(replacingTrailingWhitespace) {
    settledLastText = String(lastText.dropLast(replacingTrailingWhitespace.count))
  } else {
    settledLastText = lastText
  }
  // The canonical parser trims paragraph-edge whitespace. Keep source
  // whitespace in the cache as the next token's append boundary, but do not
  // render it while it is still trailing. Interior spaces remain lossless.
  let candidate = settledLastText + appendedText
  let trailingWhitespace = workTrailingWhitespace(in: candidate)
  let renderedCandidate = trailingWhitespace.isEmpty
    ? candidate
    : String(candidate.dropLast(trailingWhitespace.count))
  let replacement = workBoundedProseChunks(renderedCandidate)
  var result = Array(blocks.dropLast())
  result.reserveCapacity(baseCount + replacement.count)
  for (offset, chunk) in replacement.enumerated() {
    result.append(WorkMarkdownBlock(
      id: "markdown-block-\(baseCount + offset)",
      kind: .paragraph(chunk)
    ))
  }
  return result
}

/// Most characters a single rendered prose row may carry.
///
/// This is a layout budget, not a reading one. The transcript is a `LazyVStack`,
/// which estimates the height of every row it has not realized from the ones it
/// has. A row that is many screens tall poisons that estimate: placing the
/// stack with it realizes a different set of rows, the new set has a different
/// average height, the new average moves the estimate, and the moved estimate
/// changes the placement again. With one ordinary-sized row among giants the
/// two never agree, so the view graph re-runs on every run-loop pass forever —
/// the main thread pinned at 100%, the transcript frozen mid-turn, and no way
/// out except leaving the chat.
///
/// An agent that formats its prose normally never reaches this: blank lines
/// already end a paragraph. It is the unbroken wall of text — a long numbered
/// answer written as one paragraph — that produces the outlier, and that is
/// exactly the shape a streaming turn grows into.
///
/// 1,600 characters is roughly a screenful of prose on an iPhone, so a split
/// reads as the paragraph break the text was missing. The budget is counted in
/// characters, not bytes, because row height follows glyphs.
let workMarkdownProseRowCharacterLimit = 1_600

/// Maximum list items in one rendered markdown block.
///
/// A list is itself a SwiftUI `VStack` inside the transcript's lazy stack. A
/// long numbered answer can therefore bypass the prose-row character budget
/// and create one multi-screen child row, bringing back the lazy-placement
/// feedback loop that the prose splitter prevents. Keeping the block to a
/// small, predictable number of items preserves the list's reading order while
/// giving the outer transcript several normal-sized rows to estimate.
let workMarkdownListItemsPerRenderBlock = 16

/// Splits a list into bounded render blocks without dropping or reordering
/// rows. Every row carries its own marker and indentation, so a chunk may
/// begin anywhere — even among the children of an item in the previous chunk.
func workBoundedListItemChunks<Item>(
  _ items: [Item],
  limit: Int = workMarkdownListItemsPerRenderBlock
) -> [[Item]] {
  guard !items.isEmpty else { return [] }
  guard limit > 0, items.count > limit else { return [items] }

  var chunks: [[Item]] = []
  chunks.reserveCapacity((items.count + limit - 1) / limit)
  var offset = 0
  while offset < items.count {
    let end = min(offset + limit, items.count)
    chunks.append(Array(items[offset..<end]))
    offset = end
  }
  return chunks
}

/// Splits one oversized paragraph into rows of comparable height.
///
/// Every cut is decided from the front, out of text that is already present, so
/// a paragraph that is still streaming keeps every chunk but its last
/// byte-identical from delta to delta: same text, same digest, same
/// `markdown-block-<n>` id, and a hit in `markdownAttributedString`'s cache
/// instead of a fresh `AttributedString(markdown:)` per row per delta. Only the
/// last chunk changes, and the number of chunks only ever grows.
///
/// A cut never lands inside an inline span, because a row that renders a stray
/// `**` is worse than a row that is too tall. That rule is applied to each cut
/// on its own rather than to the split as a whole — an unclosed `` ` `` in the
/// tail the agent is still typing must not retract cuts already made ahead of
/// it. Retracting them collapses the paragraph back to a single block and
/// restores it a few tokens later, renumbering every block in the message
/// twice, which is the churn this split exists to remove.
func workBoundedProseChunks(
  _ text: String,
  limit: Int = workMarkdownProseRowCharacterLimit
) -> [String] {
  // A string's UTF-8 count is never below its character count, so this lets
  // through everything that could exceed the budget and nothing that cannot,
  // without paying for grapheme breaking on the short paragraphs that are the
  // overwhelming majority.
  guard limit > 1, text.utf8.count > limit else { return [text] }

  var chunks: [String] = []
  var start = text.startIndex
  while let ceiling = text.index(start, offsetBy: limit, limitedBy: text.endIndex) {
    // Never cut in the first half of the budget: a paragraph made of one
    // enormous unbroken token would otherwise be shredded into slivers.
    let floor = text.index(start, offsetBy: limit / 2, limitedBy: ceiling) ?? ceiling
    guard let cut = workProseChunkCut(in: text, from: start, floor: floor, ceiling: ceiling) else {
      break
    }
    // Keep the delimiter in the chunk that owns it. `appendParagraph` has
    // already trimmed the paragraph's outer whitespace; trimming each piece
    // here would silently drop the separator between two rendered rows and
    // would make this helper impossible to reason about as a lossless split.
    let chunk = String(text[start..<cut])
    if !chunk.isEmpty { chunks.append(chunk) }
    start = cut
  }

  guard !chunks.isEmpty else { return [text] }
  let remainder = String(text[start...])
  if !remainder.isEmpty { chunks.append(remainder) }
  return chunks.count > 1 ? chunks : [text]
}

/// Where the chunk beginning at `start` ends, or nil when the rest of the text
/// has to stay in one piece.
///
/// One forward pass carries the inline-markup state, so asking whether a
/// candidate boundary is balanced costs nothing per candidate. Preference
/// inside the budget window matches a reader's: end of a line, then end of a
/// sentence, then any word gap — the last one that fits, so rows stay full.
///
/// Failing all three, the cut goes at the budget's own edge. Prose with no word
/// gap in an entire 800-character window is either a script that does not
/// separate words — Japanese, Chinese, Thai — or a pasted blob, and both break
/// between characters anyway. Without this the budget would apply to English
/// and to nothing else.
///
/// The edge is only usable while the markup there is balanced. When it is not,
/// the text is inside a span that has not closed yet, so the scan keeps going
/// past the budget and takes the FIRST balanced boundary after it: appends can
/// only add boundaries later than that one, so the cut settles the moment it is
/// chosen. An incomplete link destination is the exception: if input ends
/// while that destination is still open, the hard edge bounds the malformed
/// row rather than allowing it to grow without limit. A valid long destination
/// still waits for its closing boundary.
private func workProseChunkCut(
  in text: String,
  from start: String.Index,
  floor: String.Index,
  ceiling: String.Index
) -> String.Index? {
  var markup = WorkInlineMarkupBalance()
  var sentenceEnd: String.Index?
  var wordGap: String.Index?
  var budgetEdge: String.Index?
  var overflow: String.Index?
  var hardLinkDestinationEdge: String.Index?

  var index = start
  var previous: Character?
  while index < text.endIndex {
    let character = text[index]
    let boundary = text.index(after: index)
    let next = boundary < text.endIndex ? text[boundary] : nil
    markup.consume(character, previous: previous, next: next)

    if boundary <= ceiling {
      if boundary == ceiling, markup.isBalanced {
        budgetEdge = boundary
      }
      if boundary == ceiling, markup.hasOpenLinkDestination {
        hardLinkDestinationEdge = boundary
      }
      if character == " " || character == "\n", markup.isBalanced, boundary >= floor {
        wordGap = boundary
        if character == "\n" || previous == "." || previous == "!" || previous == "?" {
          sentenceEnd = boundary
        }
      }
    } else {
      if markup.hasOpenLinkDestination, hardLinkDestinationEdge == nil {
        // The link destination may begin just after the frozen budget edge
        // (for example, `[` is inside the window but `](` is not). Remember
        // the edge as soon as that malformed destination becomes observable;
        // otherwise an unfinished link can grow without a bounded row.
        hardLinkDestinationEdge = ceiling
      }
      // Everything past the budget is a last resort, and reading any of it
      // would tie this cut to text that has not finished arriving. Stop as soon
      // as the frozen window has answered.
      if sentenceEnd != nil || wordGap != nil || budgetEdge != nil { break }
      if character == " " || character == "\n", markup.isBalanced {
        overflow = boundary
        break
      }
    }

    previous = character
    index = boundary
  }
  let hardCut = markup.hasOpenLinkDestination ? hardLinkDestinationEdge : nil
  return sentenceEnd ?? wordGap ?? budgetEdge ?? overflow ?? hardCut
}

/// Running parity of the inline delimiters a cut must not land between.
///
/// Deliberately counting rather than parsing: the only question is "could this
/// position be inside a span", and an odd number of open delimiter runs answers
/// yes. Runs, not characters — `**bold**` is two delimiters, not four, and a
/// chunk carrying only the opening `**` has to read as odd.
///
/// Underscores are left out: they sit inside ordinary identifiers far more
/// often than they open emphasis, and counting them would refuse nearly every
/// cut.
private struct WorkInlineMarkupBalance {
  private var backtickRuns = 0
  private var emphasisRuns = 0
  private var brackets = 0
  private var linkDestinationDepth = 0
  private var linkDestinationPending = false
  private var linkDestinationAngleDelimited = false
  private var linkDestinationFirstCharacter = false
  private var linkDestinationEscapePending = false
  private var beforeEmphasisRun: Character?

  var isBalanced: Bool {
    backtickRuns.isMultiple(of: 2)
      && emphasisRuns.isMultiple(of: 2)
      && brackets == 0
      && linkDestinationDepth == 0
      && !linkDestinationPending
  }

  var hasOpenLinkDestination: Bool {
    linkDestinationDepth > 0
  }

  mutating func consume(_ character: Character, previous: Character?, next: Character?) {
    if linkDestinationDepth > 0 {
      if linkDestinationEscapePending {
        linkDestinationEscapePending = false
        return
      }
      if character == "\\" {
        linkDestinationEscapePending = true
        return
      }
      if linkDestinationFirstCharacter {
        linkDestinationFirstCharacter = false
        if character == "<" {
          linkDestinationAngleDelimited = true
          return
        }
      }
      if linkDestinationAngleDelimited {
        if character == ">" {
          linkDestinationDepth = 0
          linkDestinationAngleDelimited = false
        }
        return
      }
      if character == "(" {
        linkDestinationDepth += 1
      } else if character == ")" {
        linkDestinationDepth = max(0, linkDestinationDepth - 1)
      }
      return
    }
    if linkDestinationPending {
      if character == "(" {
        linkDestinationDepth = 1
        linkDestinationPending = false
        linkDestinationAngleDelimited = false
        linkDestinationFirstCharacter = true
        return
      }
      linkDestinationPending = false
    }

    switch character {
    case "`":
      if previous != "`" { backtickRuns += 1 }
    case "*":
      if previous != "*" { beforeEmphasisRun = previous }
      guard next != "*" else { break }
      // CommonMark's flanking rule, reduced to the part that matters here: a
      // run padded by whitespace on both sides opens nothing — "2 * 3" is
      // arithmetic. Counting it would leave the parity wrong for the entire
      // rest of the paragraph, and one stray asterisk would cost every later
      // cut, handing the transcript back the giant row.
      let opens = !(next?.isWhitespace ?? true)
      let closes = !(beforeEmphasisRun?.isWhitespace ?? true)
      if opens || closes { emphasisRuns += 1 }
    case "[":
      brackets += 1
    case "]":
      // A close with no open is malformed text, not a span. Clamping stops one
      // stray "]" from making every later boundary read as unbalanced.
      if brackets > 0 {
        brackets -= 1
        if brackets == 0 {
          // A link destination starts only when the next character is `(`;
          // keep this pending so nested parentheses in the URL cannot become
          // an accidental prose cut.
          linkDestinationPending = true
        }
      }
    default:
      break
    }
  }
}

private func parseMarkdownBlocksInternal(_ markdown: String) -> [WorkMarkdownBlock] {
  let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  var index = 0
  var blocks: [WorkMarkdownBlock] = []

  func appendBlock(_ kind: WorkMarkdownBlockKind) {
    blocks.append(WorkMarkdownBlock(id: "markdown-block-\(blocks.count)", kind: kind))
  }

  func appendParagraph(_ lines: [String]) {
    let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
      // One paragraph can still become several rows: see
      // `workBoundedProseChunks` for why a single multi-screen row is not
      // something the transcript's `LazyVStack` can survive.
      for chunk in workBoundedProseChunks(text) {
        appendBlock(.paragraph(chunk))
      }
    }
  }

  func appendListBlocks(_ items: [WorkMarkdownListItem]) {
    for chunk in workBoundedListItemChunks(items) {
      appendBlock(.list(chunk))
    }
  }

  while index < lines.count {
    let line = lines[index]
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    if trimmed.isEmpty {
      index += 1
      continue
    }

    if trimmed.hasPrefix("```") {
      let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
      index += 1
      var codeLines: [String] = []
      while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
        codeLines.append(lines[index])
        index += 1
      }
      if index < lines.count { index += 1 }
      appendBlock(.code(language: language.isEmpty ? nil : language, code: codeLines.joined(separator: "\n")))
      continue
    }

    if let heading = trimmed.firstIndex(where: { $0 != "#" }), heading > trimmed.startIndex, trimmed[..<heading].allSatisfy({ $0 == "#" }) {
      let level = trimmed[..<heading].count
      let text = trimmed[heading...].trimmingCharacters(in: .whitespaces)
      appendBlock(.heading(level, text))
      index += 1
      continue
    }

    if ["---", "***", "___"].contains(trimmed) {
      appendBlock(.rule)
      index += 1
      continue
    }

    if trimmed.hasPrefix(">") {
      var quoteLines: [String] = []
      while index < lines.count {
        let value = lines[index].trimmingCharacters(in: .whitespaces)
        guard value.hasPrefix(">") else { break }
        quoteLines.append(String(value.dropFirst()).trimmingCharacters(in: .whitespaces))
        index += 1
      }
      appendBlock(.blockquote(quoteLines))
      continue
    }

    if isMarkdownTableHeader(lines: lines, index: index) {
      let headers = splitMarkdownTableRow(lines[index])
      index += 2
      var rows: [[String]] = []
      while index < lines.count, lines[index].contains("|") {
        rows.append(splitMarkdownTableRow(lines[index]))
        index += 1
      }
      appendBlock(.table(headers: headers, rows: rows))
      continue
    }

    if let list = parseMarkdownListRun(startingAt: index, in: lines) {
      if list.items.count == 1,
         case .ordered = list.items[0].marker,
         workLooksLikeInlineNumberedProse(trimmed) {
        // A model sometimes emits a numbered narrative on one physical line:
        // `1. First sentence. 2. Second sentence.` Markdown sees that as one
        // ordered-list item, but rendering it as one item recreates the giant
        // LazyVStack row this parser bounds for prose. Preserve the source
        // markers and let the prose splitter turn it into stable rows.
        appendParagraph([trimmed])
      } else {
        appendListBlocks(list.items)
      }
      index = list.nextIndex
      continue
    }

    var paragraphLines: [String] = []
    while index < lines.count {
      let value = lines[index].trimmingCharacters(in: .whitespaces)
      if value.isEmpty || value.hasPrefix("```") || value.hasPrefix(">") || isMarkdownTableHeader(lines: lines, index: index) || isMarkdownListItem(value, ordered: false) || isMarkdownListItem(value, ordered: true) || ["---", "***", "___"].contains(value) {
        break
      }
      // Only break for REAL headings (hashes followed by text). A line of
      // only '#' characters is not matched by the heading branch above, so
      // breaking on it here would leave `index` unadvanced and spin this
      // parser forever — streaming snapshots routinely end mid-heading
      // (e.g. the text so far is exactly "#").
      if value.hasPrefix("#"), value.contains(where: { $0 != "#" }) { break }
      paragraphLines.append(lines[index])
      index += 1
    }
    appendParagraph(paragraphLines)
  }

  return blocks
}

/// Detects the common malformed-but-readable form of a numbered narrative.
/// Markdown's line-oriented list grammar treats the whole line as one item;
/// the extra number markers show that the author meant sentence numbers, not a
/// single list item containing an unbounded wall of text.
func workLooksLikeInlineNumberedProse(_ line: String) -> Bool {
  guard line.count > workMarkdownProseRowCharacterLimit else { return false }

  func marker(at start: String.Index) -> (number: Int, next: String.Index)? {
    var cursor = start
    guard cursor < line.endIndex, line[cursor].isNumber else { return nil }
    while cursor < line.endIndex, line[cursor].isNumber {
      cursor = line.index(after: cursor)
    }
    guard cursor < line.endIndex, line[cursor] == "." else { return nil }
    guard let number = Int(line[start..<cursor]) else { return nil }
    cursor = line.index(after: cursor)
    guard cursor < line.endIndex, line[cursor].isWhitespace else { return nil }
    return (number, line.index(after: cursor))
  }

  guard let first = marker(at: line.startIndex) else { return false }
  let expectedNextNumber = first.number.addingReportingOverflow(1)
  guard !expectedNextNumber.overflow else { return false }

  var index = first.next
  while index < line.endIndex {
    if line[index].isWhitespace {
      let candidate = line.index(after: index)
      if let next = marker(at: candidate), next.number == expectedNextNumber.partialValue {
        return true
      }
    }
    index = line.index(after: index)
  }
  return false
}

/// Leading indentation of a source line in columns (a tab counts as four).
func workMarkdownLineIndent(_ line: String) -> Int {
  var width = 0
  for character in line {
    if character == " " {
      width += 1
    } else if character == "\t" {
      width += 4
    } else {
      break
    }
  }
  return width
}

/// A list-item line, already trimmed: its kind, source number, and text.
private func workMarkdownListLineItem(_ trimmed: String) -> (ordered: Bool, number: Int?, text: String)? {
  if let regex = workMarkdownListRegex(ordered: false),
     let text = markdownListItemText(trimmed, regex: regex) {
    return (false, nil, text)
  }
  if let regex = workMarkdownListRegex(ordered: true),
     let text = markdownListItemText(trimmed, regex: regex) {
    return (true, markdownOrderedListItemNumber(trimmed), text)
  }
  return nil
}

/// A bare marker with no text yet (`-`, `*`, `12`, `12.`). Streaming snapshots
/// routinely end on one while the next sub-item is being typed; treating it as
/// continuation text would flash a stray "-" line under the parent item.
private func workMarkdownIsBareListMarker(_ trimmed: String) -> Bool {
  if trimmed == "-" || trimmed == "*" || trimmed == "+" { return true }
  let digits = trimmed.hasSuffix(".") ? trimmed.dropLast() : Substring(trimmed)
  return !digits.isEmpty && digits.count <= 9 && digits.allSatisfy(\.isNumber)
}

/// Parses one list run starting at `index`: the top-level items of one kind,
/// plus everything nested under them — sub-lists of either kind to any depth,
/// indented continuation lines (joined to their item), and indented
/// continuation paragraphs after a blank line (their own `.continuation` rows).
///
/// Indentation is read leniently because models are not consistent: a line is
/// a child of the item above when it is indented at least two columns past
/// that item's marker, and a sibling within one column of it. A blank line
/// followed by an unindented item ends the run, so loose top-level items stay
/// separate blocks as before; a blank line followed by an indented line keeps
/// the run going, so a blank-separated sub-list still nests under its parent.
func parseMarkdownListRun(startingAt index: Int, in lines: [String]) -> (items: [WorkMarkdownListItem], nextIndex: Int)? {
  guard index < lines.count,
        workMarkdownListLineItem(lines[index].trimmingCharacters(in: .whitespaces)) != nil
  else { return nil }

  struct Group {
    let ordered: Bool
    let depth: Int
    var nextNumber: Int
    var maxDigits: Int
  }
  struct Level {
    var group: Int
    var markerIndent: Int
    /// Group ids from the outermost level down to this one.
    var path: [Int]
  }
  struct RawRow {
    let path: [Int]
    let marker: WorkMarkdownListItem.Marker
    var text: String
  }

  let baseIndent = workMarkdownLineIndent(lines[index])
  var groups: [Group] = []
  var stack: [Level] = []
  var rows: [RawRow] = []
  var sawBlank = false
  var cursor = index

  func openGroup(ordered: Bool, number: Int?, depth: Int) -> Int {
    groups.append(Group(ordered: ordered, depth: depth, nextNumber: number ?? 1, maxDigits: 0))
    return groups.count - 1
  }

  func appendItem(ordered: Bool, text: String, level: Level) {
    let marker: WorkMarkdownListItem.Marker
    if ordered {
      let number = groups[level.group].nextNumber
      groups[level.group].nextNumber = number + 1
      groups[level.group].maxDigits = max(groups[level.group].maxDigits, String(number).count)
      marker = .ordered(number)
    } else {
      marker = .bullet
    }
    rows.append(RawRow(path: level.path, marker: marker, text: text))
  }

  while cursor < lines.count {
    let line = lines[cursor]
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    if trimmed.isEmpty {
      var next = cursor + 1
      while next < lines.count, lines[next].trimmingCharacters(in: .whitespaces).isEmpty {
        next += 1
      }
      guard next < lines.count,
            workMarkdownLineIndent(lines[next]) >= baseIndent + 2,
            !lines[next].trimmingCharacters(in: .whitespaces).hasPrefix("```")
      else { break }
      sawBlank = true
      cursor = next
      continue
    }

    let indent = workMarkdownLineIndent(line)
    if let item = workMarkdownListLineItem(trimmed) {
      if stack.isEmpty {
        let group = openGroup(ordered: item.ordered, number: item.number, depth: 0)
        stack.append(Level(group: group, markerIndent: indent, path: [group]))
      } else if indent >= stack[stack.count - 1].markerIndent + 2, !rows.isEmpty {
        let parent = stack[stack.count - 1]
        let group = openGroup(ordered: item.ordered, number: item.number, depth: stack.count)
        stack.append(Level(group: group, markerIndent: indent, path: parent.path + [group]))
      } else {
        while stack.count > 1, indent < stack[stack.count - 1].markerIndent - 1 {
          stack.removeLast()
        }
        let top = stack.count - 1
        if groups[stack[top].group].ordered != item.ordered {
          // A different marker kind at the top level is a new list, exactly as
          // before nesting existed; nested, it is a new sibling list under the
          // same parent.
          guard top > 0 else { break }
          let group = openGroup(ordered: item.ordered, number: item.number, depth: top)
          stack[top].group = group
          stack[top].path = stack[top - 1].path + [group]
        }
        stack[top].markerIndent = indent
      }
      appendItem(ordered: item.ordered, text: item.text, level: stack[stack.count - 1])
      sawBlank = false
      cursor += 1
      continue
    }

    // Unindented prose, or a fence at any indent, ends the list (a fenced
    // block keeps its own renderer).
    guard indent > baseIndent, !trimmed.hasPrefix("```") else { break }
    if cursor == lines.count - 1, workMarkdownIsBareListMarker(trimmed) {
      cursor += 1
      break
    }
    var popped = false
    while stack.count > 1, indent <= stack[stack.count - 1].markerIndent {
      stack.removeLast()
      popped = true
    }
    let level = stack[stack.count - 1]
    if !sawBlank, !popped, !rows.isEmpty {
      rows[rows.count - 1].text += "\n" + trimmed
    } else {
      rows.append(RawRow(path: level.path, marker: .continuation, text: trimmed))
    }
    sawBlank = false
    cursor += 1
  }

  guard !rows.isEmpty else { return nil }

  func column(_ group: Int) -> WorkMarkdownListMarkerColumn {
    let value = groups[group]
    return value.ordered ? .ordered(digits: max(1, value.maxDigits)) : .bullet(depth: value.depth)
  }
  let items = rows.map { row in
    WorkMarkdownListItem(
      marker: row.marker,
      column: column(row.path[row.path.count - 1]),
      ancestors: row.path.dropLast().map(column),
      text: row.text
    )
  }
  return (items, cursor)
}

func isMarkdownListItem(_ line: String, ordered: Bool) -> Bool {
  guard let regex = workMarkdownListRegex(ordered: ordered) else { return false }
  return markdownListItemText(line, regex: regex) != nil
}

func isMarkdownTableHeader(lines: [String], index: Int) -> Bool {
  guard index + 1 < lines.count else { return false }
  let header = lines[index]
  let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)
  return header.contains("|") && separator.contains("|") && separator.replacingOccurrences(of: "|", with: "").allSatisfy { $0 == "-" || $0 == ":" || $0 == " " }
}

func markdownListItemText(_ line: String, regex: NSRegularExpression) -> String? {
  let range = NSRange(location: 0, length: (line as NSString).length)
  guard let match = regex.firstMatch(in: line, options: [], range: range) else { return nil }
  var text = (line as NSString).substring(from: match.range.length)
  // GFM task lists: render the checkbox marker as a glyph instead of leaking
  // literal "[ ]" / "[x]" into the prose (desktop's remark-gfm renders real
  // checkboxes for these).
  if text.hasPrefix("[ ] ") {
    text = "☐ " + text.dropFirst(4)
  } else if text.hasPrefix("[x] ") || text.hasPrefix("[X] ") {
    text = "☑ " + text.dropFirst(4)
  }
  return text
}

func markdownOrderedListItemNumber(_ line: String) -> Int? {
  guard let regex = ADECodeRenderingCache.shared.regex(for: #"^(\d+)\.\s+"#) else { return nil }
  let range = NSRange(location: 0, length: (line as NSString).length)
  guard let match = regex.firstMatch(in: line, options: [], range: range),
        match.numberOfRanges > 1,
        let numberRange = Range(match.range(at: 1), in: line)
  else { return nil }
  return Int(String(line[numberRange]))
}

func workMarkdownListRegex(ordered: Bool) -> NSRegularExpression? {
  let pattern = ordered ? #"^\d+\.\s+"# : #"^[-*+]\s+"#
  return ADECodeRenderingCache.shared.regex(for: pattern)
}

func splitMarkdownTableRow(_ row: String) -> [String] {
  var cells = row
    .split(separator: "|", omittingEmptySubsequences: false)
    .map { $0.trimmingCharacters(in: .whitespaces) }
  if cells.first == "" {
    cells.removeFirst()
  }
  if cells.last == "" {
    cells.removeLast()
  }
  return cells
}

/// LRU cache for parsed markdown. Chat messages re-render on every transcript
/// change, and `AttributedString(markdown:)` is not cheap — caching saves us
/// from reparsing the same paragraph every frame during a streaming turn.
private final class WorkMarkdownCacheBox {
  let value: AttributedString
  init(_ value: AttributedString) { self.value = value }
}

private final class WorkMarkdownBlocksCacheBox: NSObject {
  let value: [WorkMarkdownBlock]

  init(_ value: [WorkMarkdownBlock]) {
    self.value = value
  }
}

private let workMarkdownCache: NSCache<NSString, WorkMarkdownCacheBox> = {
  let cache = NSCache<NSString, WorkMarkdownCacheBox>()
  cache.countLimit = 256
  return cache
}()

private let workMarkdownBlocksCache: NSCache<NSString, WorkMarkdownBlocksCacheBox> = {
  let cache = NSCache<NSString, WorkMarkdownBlocksCacheBox>()
  cache.countLimit = 128
  return cache
}()

/// Holds only the currently-streaming tail revisions, so they never evict
/// completed messages from `workMarkdownCache`. A handful of entries covers the
/// tail block plus the repeat body evaluations SwiftUI makes for the same text.
private let workStreamingInlineMarkdownCache: NSCache<NSString, WorkMarkdownCacheBox> = {
  let cache = NSCache<NSString, WorkMarkdownCacheBox>()
  cache.countLimit = 8
  return cache
}()

/// Per-message state for `parseMarkdownBlocksForStreaming`, keyed by message
/// id. Immutable snapshot box (replaced wholesale on each delta) so concurrent
/// readers never observe a half-updated entry. Only one message streams at a
/// time per session, so the limit stays tiny.
private final class WorkStreamingMarkdownCacheBox: NSObject {
  let fullText: String
  let blocks: [WorkMarkdownBlock]
  let isPlainProse: Bool
  let trailingWhitespace: String
  let appendBoundaryUTF16Count: Int

  init(
    fullText: String,
    blocks: [WorkMarkdownBlock],
    isPlainProse: Bool = false,
    trailingWhitespace: String = ""
  ) {
    self.fullText = fullText
    self.blocks = blocks
    self.isPlainProse = isPlainProse
    self.trailingWhitespace = trailingWhitespace
    self.appendBoundaryUTF16Count = fullText.utf16.count
  }
}

private let workStreamingMarkdownCache: NSCache<NSString, WorkStreamingMarkdownCacheBox> = {
  let cache = NSCache<NSString, WorkStreamingMarkdownCacheBox>()
  cache.countLimit = 8
  return cache
}()

/// Cheap content identity for in-memory render caches (markdown block digests,
/// preview identities). FNV-1a, not a cryptographic hash: it runs on every
/// block of every visible message on every presentation refresh, so cost
/// dominates and a collision only costs a redundant re-render.
///
/// Its counterpart is `workStableFileToken` (WorkComposerAttachmentStaging.swift),
/// which is SHA-256 because it names files and directories on disk from
/// attacker-influenceable keys. Keep the two separate: cheapening the disk
/// token, or making this one cryptographic, breaks the side that matters.
func workStableDigest(_ string: String) -> String {
  var hash: UInt64 = 0xcbf29ce484222325
  for byte in string.utf8 {
    hash ^= UInt64(byte)
    hash &*= 0x100000001b3
  }
  return String(hash, radix: 16, uppercase: false)
}

/// Renders inline Markdown, with a separate lane for the revision that is still
/// growing.
///
/// `intermediate` marks the tail block of a streaming message: it is re-rendered
/// several times a second with text that will never be looked up again. Those
/// revisions used to land in the shared 256-entry cache, so one long turn could
/// insert hundreds of throwaway entries and evict every completed message —
/// scrolling back after a turn then re-parsed the whole transcript on the main
/// thread. Intermediate revisions now live in their own tiny cache and never
/// displace finished work; when the turn ends the same text comes back through
/// the normal path and is promoted into the shared cache.
func markdownAttributedString(_ text: String, intermediate: Bool = false) -> AttributedString {
  let key = workStableDigest(text) as NSString
  if let cached = workMarkdownCache.object(forKey: key) {
    return cached.value
  }
  if intermediate, let cached = workStreamingInlineMarkdownCache.object(forKey: key) {
    return cached.value
  }

  func store(_ value: AttributedString) {
    if intermediate {
      workStreamingInlineMarkdownCache.setObject(WorkMarkdownCacheBox(value), forKey: key)
    } else {
      workMarkdownCache.setObject(WorkMarkdownCacheBox(value), forKey: key)
    }
  }

  // Preserve line breaks so multi-line paragraphs render correctly — the
  // default `AttributedString(markdown:)` initializer collapses them.
  let options = AttributedString.MarkdownParsingOptions(
    interpretedSyntax: .inlineOnlyPreservingWhitespace
  )
  guard var attributed = try? AttributedString(markdown: text, options: options) else {
    let fallback = AttributedString(text)
    store(fallback)
    return fallback
  }

  // Inline code stays quiet: monospaced one text style below the body (mono
  // glyphs run wide, so this keeps the same visual weight and never grows the
  // line height), regular weight, body color, and a faint neutral wash. No
  // padding or pill shape — a long path must wrap exactly like prose.
  // Strikethrough intent is mapped explicitly — SwiftUI does not reliably
  // draw it from the presentation intent alone, which left ~~text~~ looking
  // like plain prose on mobile while desktop (remark-gfm) struck it through.
  for run in attributed.runs {
    let intent = run.inlinePresentationIntent ?? []
    let range = run.range
    if intent.contains(.strikethrough) {
      attributed[range].strikethroughStyle = .single
    }
    guard intent.contains(.code) else { continue }
    attributed[range].backgroundColor = WorkChatTypography.inlineCodeBackground
    attributed[range].font = WorkChatTypography.inlineCode
  }

  // GFM autolinks: desktop linkifies bare URLs via remark-gfm; Apple's
  // markdown parser only links explicit [text](url) syntax. Linkify bare
  // URLs when the parser produced none (results are LRU-cached, so the
  // detector does not run per frame during streaming).
  if text.contains("http"), attributed.runs.allSatisfy({ $0.link == nil }) {
    let plain = String(attributed.characters)
    if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
      let matches = detector.matches(in: plain, options: [], range: NSRange(plain.startIndex..., in: plain))
      for match in matches {
        guard let url = match.url,
              let stringRange = Range(match.range, in: plain),
              let lower = AttributedString.Index(stringRange.lowerBound, within: attributed),
              let upper = AttributedString.Index(stringRange.upperBound, within: attributed)
        else { continue }
        attributed[lower..<upper].link = url
        attributed[lower..<upper].foregroundColor = ADEColor.accent
        attributed[lower..<upper].underlineStyle = .single
      }
    }
  }

  store(attributed)
  return attributed
}

/// Whether the shared inline-markdown cache is currently holding a render for
/// `text`. Exists so the "streaming tail must not evict finished messages"
/// behaviour is directly assertable.
func workMarkdownSharedCacheHolds(_ text: String) -> Bool {
  workMarkdownCache.object(forKey: workStableDigest(text) as NSString) != nil
}

/// Drops every derived-render cache. Called on `didReceiveMemoryWarning`: these
/// hold parsed copies of the transcript, all of which can be rebuilt on demand.
func workPurgeMarkdownRenderCaches() {
  workMarkdownCache.removeAllObjects()
  workMarkdownBlocksCache.removeAllObjects()
  workStreamingMarkdownCache.removeAllObjects()
  workStreamingInlineMarkdownCache.removeAllObjects()
}

// MARK: - Scene fences

/// The fence language desktop reserves for agent-authored generated UI.
/// Mirrors `SCENE_FENCE_LANGUAGE` in `apps/desktop/src/shared/chatScene.ts`.
let workSceneFenceLanguage = "scene"

/// Longest title a scene marker may contribute. Mirrors desktop
/// `SCENE_LIMITS.maxTitleLength`.
private let workSceneTitleLimit = 120

/// True when a code fence's language marks it as a scene.
///
/// The FIRST whitespace-delimited token, not the whole info string. A fence
/// opened ```` ```scene generated ```` is a scene everywhere else — desktop
/// reads the language out of rehype's `language-scene` class, which is the
/// first word, and the TUI splits on whitespace — so comparing the whole
/// string made the phone the one surface that dumped the raw HTML into the
/// transcript.
func workIsSceneFenceLanguage(_ language: String?) -> Bool {
  guard let language else { return false }
  let token = language
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .split(maxSplits: 1, omittingEmptySubsequences: true, whereSeparator: { $0.isWhitespace })
    .first
  guard let token else { return false }
  return token.lowercased() == workSceneFenceLanguage
}

/// The title a scene declares in its leading `<!-- @scene title="…" -->` marker.
///
/// Mirrors the marker half of desktop `parseSceneFence`: blank lines are
/// skipped, only the FIRST non-blank line may be the marker, and the title is
/// capped at `workSceneTitleLimit`. A scene without a marker has no title, and
/// the placeholder falls back to the generic label.
func workSceneFenceTitle(_ source: String) -> String? {
  for rawLine in source.split(separator: "\n", omittingEmptySubsequences: false) {
    let line = rawLine.trimmingCharacters(in: .whitespaces)
    if line.isEmpty { continue }
    guard line.lowercased().hasPrefix("<!--"), line.hasSuffix("-->") else { return nil }
    let inner = String(line.dropFirst(4).dropLast(3)).trimmingCharacters(in: .whitespaces)
    guard inner.lowercased().hasPrefix("@scene") else { return nil }
    let rest = String(inner.dropFirst("@scene".count))
    // `@scene` must be a whole word, matching the desktop marker's `\b`.
    if let next = rest.first, next.isLetter || next.isNumber || next == "_" { return nil }
    guard let range = rest.range(of: "title=\"", options: .caseInsensitive),
          let close = rest[range.upperBound...].firstIndex(of: "\"")
    else { return nil }
    let title = rest[range.upperBound..<close].trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return nil }
    return String(title.prefix(workSceneTitleLimit))
  }
  return nil
}

/// One line standing in for a scene on a surface that cannot run one. Mirrors
/// desktop `summarizeSceneFence` so the TUI, the CLI and the phone all collapse
/// a scene the same way.
func workSummarizeSceneFence(_ source: String) -> String {
  "[scene: \(workSceneFenceTitle(source) ?? "generated view")]"
}
