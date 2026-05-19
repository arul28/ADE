import SwiftUI
import UIKit

struct WorkTerminalViewport: Equatable {
  let cols: Int
  let rows: Int
}

struct WorkTerminalEmulatorView: UIViewRepresentable {
  let rawText: String
  let revision: Int
  let onViewportChange: (WorkTerminalViewport) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(onViewportChange: onViewportChange)
  }

  func makeUIView(context: Context) -> ADETerminalTextView {
    let view = ADETerminalTextView()
    view.onViewportChange = { [weak view, weak coordinator = context.coordinator] viewport in
      guard let view, let coordinator else { return }
      coordinator.updateViewport(viewport, rawText: rawText, revision: revision, view: view)
    }
    return view
  }

  func updateUIView(_ view: ADETerminalTextView, context: Context) {
    view.onViewportChange = { [weak view, weak coordinator = context.coordinator] viewport in
      guard let view, let coordinator else { return }
      coordinator.onViewportChange = onViewportChange
      coordinator.updateViewport(viewport, rawText: rawText, revision: revision, view: view)
    }
    context.coordinator.onViewportChange = onViewportChange
    context.coordinator.render(rawText: rawText, revision: revision, in: view)
  }

  final class Coordinator {
    var onViewportChange: (WorkTerminalViewport) -> Void
    private var screen = WorkTerminalScreen()
    private var lastRawText = ""
    private var lastRevision = -1
    private var lastViewport: WorkTerminalViewport?

    init(onViewportChange: @escaping (WorkTerminalViewport) -> Void) {
      self.onViewportChange = onViewportChange
    }

    @discardableResult
    func updateViewport(_ viewport: WorkTerminalViewport, rawText: String, revision: Int, view: ADETerminalTextView) -> Bool {
      guard viewport != lastViewport else { return false }
      lastViewport = viewport
      let columnsChanged = screen.resize(cols: viewport.cols)
      var didRender = false
      if columnsChanged || rawText != lastRawText {
        screen.reset()
        screen.write(rawText)
        lastRawText = rawText
        view.render(screen.attributedString(font: view.terminalFont))
        didRender = true
      }
      lastRevision = revision
      onViewportChange(viewport)
      return didRender
    }

    @discardableResult
    func render(rawText: String, revision: Int, in view: ADETerminalTextView) -> Bool {
      guard rawText != lastRawText else {
        lastRevision = revision
        return false
      }
      defer {
        lastRevision = revision
        lastRawText = rawText
      }

      if rawText.hasPrefix(lastRawText) {
        let delta = String(rawText.dropFirst(lastRawText.count))
        screen.write(delta)
      } else {
        screen.reset()
        screen.write(rawText)
      }
      view.render(screen.attributedString(font: view.terminalFont))
      return true
    }
  }
}

final class ADETerminalTextView: UIView {
  let terminalFont = UIFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
  var onViewportChange: ((WorkTerminalViewport) -> Void)?

  private let textView = UITextView()
  private var lastViewport: WorkTerminalViewport?
  private var hasRenderedContent = false
  private var pendingScrollToBottom = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    textView.translatesAutoresizingMaskIntoConstraints = false
    textView.backgroundColor = .black
    textView.textColor = .white
    textView.tintColor = .white
    textView.font = terminalFont
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = true
    textView.alwaysBounceVertical = true
    textView.showsVerticalScrollIndicator = true
    textView.showsHorizontalScrollIndicator = false
    textView.textContainerInset = UIEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
    textView.textContainer.lineFragmentPadding = 0
    textView.textContainer.widthTracksTextView = true
    textView.autocorrectionType = .no
    textView.autocapitalizationType = .none
    addSubview(textView)
    NSLayoutConstraint.activate([
      textView.leadingAnchor.constraint(equalTo: leadingAnchor),
      textView.trailingAnchor.constraint(equalTo: trailingAnchor),
      textView.topAnchor.constraint(equalTo: topAnchor),
      textView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    return nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if pendingScrollToBottom {
      scrollToBottom()
    }
    publishViewportIfNeeded()
  }

  func render(_ attributed: NSAttributedString) {
    let nearBottom = textView.contentOffset.y + textView.bounds.height >= textView.contentSize.height - 80
    let shouldStickToBottom = !hasRenderedContent || pendingScrollToBottom || nearBottom
    textView.attributedText = attributed
    hasRenderedContent = true
    if shouldStickToBottom {
      scrollToBottom()
    }
    publishViewportIfNeeded()
  }

  private func scrollToBottom() {
    guard textView.bounds.height > 1 else {
      pendingScrollToBottom = true
      return
    }
    textView.layoutIfNeeded()
    let bottomY = max(
      -textView.adjustedContentInset.top,
      textView.contentSize.height - textView.bounds.height + textView.adjustedContentInset.bottom
    )
    textView.setContentOffset(CGPoint(x: 0, y: bottomY), animated: false)
    pendingScrollToBottom = false
  }

  private func publishViewportIfNeeded() {
    guard bounds.width > 1, bounds.height > 1 else { return }
    let charSize = ("W" as NSString).size(withAttributes: [.font: terminalFont])
    let usableWidth = max(1, bounds.width - textView.textContainerInset.left - textView.textContainerInset.right)
    let usableHeight = max(1, bounds.height - textView.textContainerInset.top - textView.textContainerInset.bottom)
    let fittedCols = Int(floor(usableWidth / max(1, charSize.width))) - 2
    let viewport = WorkTerminalViewport(
      cols: max(20, min(240, fittedCols)),
      rows: max(4, min(120, Int(floor(usableHeight / max(1, terminalFont.lineHeight)))))
    )
    guard viewport != lastViewport else { return }
    lastViewport = viewport
    onViewportChange?(viewport)
  }
}

private struct WorkTerminalCell {
  var scalar: UnicodeScalar
  var foreground: UIColor?
  var bold: Bool
}

private final class WorkTerminalScreen {
  private var lines: [[WorkTerminalCell]] = [[]]
  private var row = 0
  private var column = 0
  private var cols = 88
  private var foreground: UIColor?
  private var bold = false
  private var scrollTop = 0
  private var scrollBottom: Int?
  private let maxLines = 4_000

  func resize(cols: Int) -> Bool {
    let nextCols = max(20, min(240, cols))
    guard nextCols != self.cols else { return false }
    self.cols = nextCols
    column = min(column, self.cols - 1)
    return true
  }

  func reset() {
    lines = [[]]
    row = 0
    column = 0
    foreground = nil
    bold = false
    scrollTop = 0
    scrollBottom = nil
  }

  func write(_ input: String) {
    let scalars = Array(input.unicodeScalars)
    var index = scalars.startIndex
    while index < scalars.endIndex {
      let scalar = scalars[index]
      index = scalars.index(after: index)

      if scalar == "\u{001B}" {
        consumeEscape(in: scalars, index: &index)
        continue
      }

      switch scalar {
      case "\n":
        newline()
      case "\r":
        column = 0
      case "\t":
        let spaces = max(1, 4 - (column % 4))
        for _ in 0..<spaces { put(" ") }
      case "\u{0008}":
        column = max(0, column - 1)
      default:
        if scalar.value >= 0x20 && scalar.value != 0x7F {
          put(scalar)
        }
      }
    }
    trimLinesIfNeeded()
  }

  func attributedString(font: UIFont) -> NSAttributedString {
    let result = NSMutableAttributedString(string: "")
    let baseParagraph = NSMutableParagraphStyle()
    baseParagraph.lineBreakMode = .byClipping
    baseParagraph.lineSpacing = 0
    let baseAttrs: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: UIColor(white: 0.92, alpha: 1),
      .paragraphStyle: baseParagraph,
    ]
    let boldFont = UIFont.monospacedSystemFont(ofSize: font.pointSize, weight: .semibold)

    for lineIndex in lines.indices {
      if lineIndex > lines.startIndex {
        result.append(NSAttributedString(string: "\n", attributes: baseAttrs))
      }
      let line = lines[lineIndex]
      guard !line.isEmpty else { continue }
      var run = ""
      var runColor: UIColor?
      var runBold = false
      func flush() {
        guard !run.isEmpty else { return }
        var attrs = baseAttrs
        attrs[.foregroundColor] = runColor ?? UIColor(white: 0.92, alpha: 1)
        attrs[.font] = runBold ? boldFont : font
        result.append(NSAttributedString(string: run, attributes: attrs))
        run = ""
      }

      for cell in line {
        if !terminalColorsEqual(cell.foreground, runColor) || cell.bold != runBold {
          flush()
          runColor = cell.foreground
          runBold = cell.bold
        }
        run.append(String(cell.scalar))
      }
      flush()
    }
    if result.length == 0 {
      result.append(NSAttributedString(string: " ", attributes: baseAttrs))
    }
    return result
  }

  private func put(_ scalar: UnicodeScalar) {
    ensureCursor()
    if column >= cols {
      newline()
    }
    while lines[row].count < column {
      lines[row].append(WorkTerminalCell(scalar: " ", foreground: foreground, bold: bold))
    }
    let cell = WorkTerminalCell(scalar: scalar, foreground: foreground, bold: bold)
    if column < lines[row].count {
      lines[row][column] = cell
    } else {
      lines[row].append(cell)
    }
    column += 1
  }

  private func newline() {
    row += 1
    column = 0
    ensureCursor()
  }

  private func ensureCursor() {
    while lines.count <= row {
      lines.append([])
    }
  }

  private func trimLinesIfNeeded() {
    guard lines.count > maxLines else { return }
    let overflow = lines.count - maxLines
    lines.removeFirst(overflow)
    row = max(0, row - overflow)
  }

  private func consumeEscape(in scalars: [UnicodeScalar], index: inout Int) {
    guard index < scalars.endIndex else { return }
    let kind = scalars[index]
    index = scalars.index(after: index)
    switch kind {
    case "[":
      consumeCSI(in: scalars, index: &index)
    case "]":
      consumeOSC(in: scalars, index: &index)
    case "c":
      reset()
    case "(", ")", "*", "+":
      if index < scalars.endIndex { index = scalars.index(after: index) }
    default:
      break
    }
  }

  private func consumeOSC(in scalars: [UnicodeScalar], index: inout Int) {
    while index < scalars.endIndex {
      let current = scalars[index]
      index = scalars.index(after: index)
      if current == "\u{0007}" { break }
      if current == "\u{001B}", index < scalars.endIndex, scalars[index] == "\\" {
        index = scalars.index(after: index)
        break
      }
    }
  }

  private func consumeCSI(in scalars: [UnicodeScalar], index: inout Int) {
    var body = String.UnicodeScalarView()
    while index < scalars.endIndex {
      let scalar = scalars[index]
      index = scalars.index(after: index)
      if scalar.value >= 0x40 && scalar.value <= 0x7E {
        applyCSI(command: Character(scalar), body: String(body))
        break
      }
      body.append(scalar)
    }
  }

  private func applyCSI(command: Character, body: String) {
    let cleaned = body.trimmingCharacters(in: CharacterSet(charactersIn: "?"))
    let params = cleaned
      .split(separator: ";", omittingEmptySubsequences: false)
      .map { Int(String($0).trimmingCharacters(in: CharacterSet(charactersIn: "?"))) ?? 0 }
    let first = params.first ?? 0

    if (command == "h" || command == "l") && (body.contains("1049") || body.contains("47") || body.contains("1047")) {
      reset()
      return
    }

    switch command {
    case "A":
      row = max(0, row - max(1, first))
    case "B":
      row += max(1, first)
      ensureCursor()
    case "C":
      column = min(cols - 1, column + max(1, first))
    case "D":
      column = max(0, column - max(1, first))
    case "G":
      column = max(0, min(cols - 1, max(1, first) - 1))
    case "H", "f":
      row = max(0, max(1, first) - 1)
      column = max(0, min(cols - 1, max(1, params.dropFirst().first ?? 1) - 1))
      ensureCursor()
    case "J":
      ensureCursor()
      if first == 2 || first == 3 {
        reset()
      } else if first == 1 {
        let space = WorkTerminalCell(scalar: " ", foreground: foreground, bold: bold)
        for lineIndex in 0...row {
          guard lines.indices.contains(lineIndex) else { continue }
          if lineIndex == row {
            let endIndex = min(column + 1, lines[lineIndex].count)
            for cellIndex in 0..<endIndex {
              lines[lineIndex][cellIndex] = space
            }
          } else {
            for cellIndex in lines[lineIndex].indices {
              lines[lineIndex][cellIndex] = space
            }
          }
        }
      } else {
        if column < lines[row].count {
          lines[row].removeSubrange(column..<lines[row].count)
        }
        if row + 1 < lines.count {
          lines.removeSubrange((row + 1)..<lines.count)
        }
      }
    case "K":
      ensureCursor()
      if first == 1 {
        for i in 0..<min(column + 1, lines[row].count) {
          lines[row][i] = WorkTerminalCell(scalar: " ", foreground: foreground, bold: bold)
        }
      } else if first == 2 {
        lines[row] = []
        column = 0
      } else if column < lines[row].count {
        lines[row].removeSubrange(column..<lines[row].count)
      }
    case "L":
      insertBlankLines(count: max(1, first))
    case "M":
      deleteLines(count: max(1, first))
    case "P":
      deleteCharacters(count: max(1, first))
    case "r":
      setScrollRegion(params)
    case "m":
      applySGR(params.isEmpty ? [0] : params)
    default:
      break
    }
  }

  private func insertBlankLines(count: Int) {
    ensureCursor()
    let start = min(max(row, scrollTop), lines.count)
    let bottom = activeScrollBottom()
    while lines.count <= bottom {
      lines.append([])
    }
    lines.insert(contentsOf: Array(repeating: [WorkTerminalCell](), count: count), at: start)
    if let scrollBottom {
      let removalStart = min(scrollBottom + 1, lines.count)
      let removalEnd = min(removalStart + count, lines.count)
      if removalStart < removalEnd {
        lines.removeSubrange(removalStart..<removalEnd)
      }
    }
    row = min(row, max(0, lines.count - 1))
    trimLinesIfNeeded()
  }

  private func deleteLines(count: Int) {
    ensureCursor()
    let start = min(max(row, scrollTop), max(0, lines.count - 1))
    let bottom = activeScrollBottom()
    while lines.count <= bottom {
      lines.append([])
    }
    let removalEnd = min(start + count, bottom + 1, lines.count)
    guard start < removalEnd else { return }
    let removed = removalEnd - start
    lines.removeSubrange(start..<removalEnd)
    if scrollBottom != nil {
      let insertIndex = min(max(start, bottom - removed + 1), lines.count)
      lines.insert(contentsOf: Array(repeating: [WorkTerminalCell](), count: removed), at: insertIndex)
    }
    if lines.isEmpty {
      lines = [[]]
    }
    row = min(row, max(0, lines.count - 1))
  }

  private func deleteCharacters(count: Int) {
    ensureCursor()
    guard column < lines[row].count else { return }
    let end = min(column + count, lines[row].count)
    lines[row].removeSubrange(column..<end)
  }

  private func setScrollRegion(_ params: [Int]) {
    scrollTop = max(0, max(1, params.first ?? 1) - 1)
    if let bottom = params.dropFirst().first, bottom > 0 {
      scrollBottom = max(scrollTop, bottom - 1)
    } else {
      scrollBottom = nil
    }
    row = 0
    column = 0
    ensureCursor()
  }

  private func activeScrollBottom() -> Int {
    max(scrollTop, scrollBottom ?? max(lines.count - 1, row))
  }

  private func applySGR(_ rawParams: [Int]) {
    let params = rawParams.isEmpty ? [0] : rawParams
    var index = params.startIndex
    while index < params.endIndex {
      let param = params[index]
      switch param {
      case 0:
        foreground = nil
        bold = false
      case 1:
        bold = true
      case 22:
        bold = false
      case 30...37:
        foreground = ansiColor(index: param - 30, bright: false)
      case 90...97:
        foreground = ansiColor(index: param - 90, bright: true)
      case 38:
        if index + 2 < params.endIndex, params[index + 1] == 5 {
          if let color = ansi256Color(params[index + 2]) {
            foreground = color
          }
          index += 2
        } else if index + 4 < params.endIndex, params[index + 1] == 2 {
          foreground = rgbColor(red: params[index + 2], green: params[index + 3], blue: params[index + 4])
          index += 4
        }
      case 39:
        foreground = nil
      default:
        break
      }
      index += 1
    }
  }

  private func ansiColor(index: Int, bright: Bool) -> UIColor {
    let normal: [UIColor] = [
      .init(white: 0.15, alpha: 1), .systemRed, .systemGreen, .systemYellow,
      .systemBlue, .systemPurple, .systemTeal, .init(white: 0.86, alpha: 1),
    ]
    let brightColors: [UIColor] = [
      .init(white: 0.45, alpha: 1), .systemRed, .systemGreen, .systemYellow,
      .systemBlue, .systemPink, .cyan, .white,
    ]
    let palette = bright ? brightColors : normal
    return palette[max(0, min(index, palette.count - 1))]
  }

  private func ansi256Color(_ code: Int) -> UIColor? {
    switch code {
    case 0...7:
      return ansiColor(index: code, bright: false)
    case 8...15:
      return ansiColor(index: code - 8, bright: true)
    case 16...231:
      let value = code - 16
      let levels: [CGFloat] = [0, 95, 135, 175, 215, 255]
      return UIColor(
        red: levels[value / 36] / 255,
        green: levels[(value / 6) % 6] / 255,
        blue: levels[value % 6] / 255,
        alpha: 1
      )
    case 232...255:
      let level = CGFloat(8 + (code - 232) * 10) / 255
      return UIColor(white: level, alpha: 1)
    default:
      return nil
    }
  }

  private func rgbColor(red: Int, green: Int, blue: Int) -> UIColor {
    func channel(_ value: Int) -> CGFloat {
      CGFloat(max(0, min(255, value))) / 255
    }
    return UIColor(red: channel(red), green: channel(green), blue: channel(blue), alpha: 1)
  }
}

private func terminalColorsEqual(_ lhs: UIColor?, _ rhs: UIColor?) -> Bool {
  switch (lhs, rhs) {
  case (.none, .none):
    return true
  case (.some(let left), .some(let right)):
    return left.isEqual(right)
  default:
    return false
  }
}
